const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants: fsConstants } = require('node:fs');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { MAX_GEMINI_PRECHECK_ATTEMPTS, canRetryGeminiPrecheck } = require('./documentValidationService');

const ID_PATTERN = /^\d{1,10}$/;
const STAFF_ROLES = new Set(['registrar', 'database_admin']);
const STUDENT_UPLOAD_DOCUMENT_TYPES = new Set(['good_moral', 'psa_birth_certificate', 'report_card']);
const UPLOAD_DOCUMENT_TYPES = new Set(['good_moral', 'psa_birth_certificate']);
const GEMINI_PRECHECK_PROCESSOR = 'Gemini field extraction';
const ACTIONABLE_REGISTRAR_REVIEW_SQL = `d.status = 'needs_review'
  AND COALESCE(latest_decision.decision_type, '') <> 'correction_requested'
  AND (
    (d.document_type IN ('good_moral', 'psa_birth_certificate') AND NOT EXISTS (
      SELECT 1 FROM documents AS newer
      WHERE newer.student_id = d.student_id AND newer.document_type = d.document_type
        AND (newer.created_at > d.created_at OR (newer.created_at = d.created_at AND newer.id > d.id))
    ))
    OR (d.document_type = 'report_card' AND d.is_legacy_archive = 0 AND d.upload_source = 'student'
      AND NOT EXISTS (
        SELECT 1 FROM documents AS newer
        WHERE newer.student_id = d.student_id AND newer.document_type = 'report_card'
          AND newer.is_legacy_archive = 0 AND newer.upload_source = 'student'
          AND (newer.created_at > d.created_at OR (newer.created_at = d.created_at AND newer.id > d.id))
      ))
  )`;

function studentReportCardSourceAccessSql(documentAlias) {
  return `(${documentAlias}.document_type = 'report_card'
    AND ${documentAlias}.is_legacy_archive = 0 AND ${documentAlias}.upload_source = 'student'
    AND ${documentAlias}.status IN ('needs_review', 'failed')
    AND NOT EXISTS (SELECT 1 FROM documents AS corrected
      WHERE corrected.supersedes_document_id = ${documentAlias}.id)
    AND NOT EXISTS (SELECT 1 FROM documents AS newer_report_card
      WHERE newer_report_card.student_id = ${documentAlias}.student_id
        AND newer_report_card.document_type = 'report_card' AND newer_report_card.is_legacy_archive = 0
        AND (newer_report_card.created_at > ${documentAlias}.created_at
          OR (newer_report_card.created_at = ${documentAlias}.created_at AND newer_report_card.id > ${documentAlias}.id)))
    AND (EXISTS (SELECT 1 FROM v_document_latest_decision_event AS current_decision
        WHERE current_decision.document_id = ${documentAlias}.id
          AND current_decision.decision_type = 'correction_requested')
      OR (NOT EXISTS (SELECT 1 FROM document_decision_events AS prior_decision
          WHERE prior_decision.document_id = ${documentAlias}.id)
        AND EXISTS (SELECT 1 FROM v_document_latest_review_event AS current_review
          WHERE current_review.document_id = ${documentAlias}.id
            AND current_review.action_type = 'correction_requested'))))`;
}
const FORM137_STATUSES = new Set(['pending', 'received', 'verified', 'correction', 'rejected']);
const PREVIOUS_SCHOOL_REPORT_CARD_PHYSICAL_STATUSES = new Set(['pending', 'received', 'verified', 'correction', 'rejected']);
const MIME_BY_EXTENSION = new Map([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png']
]);
const STORED_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$/i;
const PRECHECK_MESSAGES = new Map([
  ['processor_timeout', 'Gemini field extraction timed out. Staff review is required.'],
  ['stored_file_unavailable', 'The stored file could not be read. Staff review is required.'],
  ['processor_error', 'Gemini field extraction could not be completed. Staff review is required.'],
  ['processing_recovered', 'Gemini field extraction did not finish within the recovery window. Staff review is required.'],
  ['precheck_pass', 'The configured name and file-format checks passed. A registrar or database administrator must inspect the source and make the final decision.'],
  ['precheck_attention', 'The extracted name or file-format check needs source inspection.'],
  ['gemini_unavailable', 'Gemini field extraction is unavailable. Staff source inspection is required.'],
  ['invalid_file_format', 'The stored file does not match its declared PDF, JPEG, or PNG format. Staff review is required.']
]);
const ADVISORY_KEYS_BY_TYPE = new Map([
  ['good_moral', ['linked_student_name', 'possible_school_name']],
  ['psa_birth_certificate', ['linked_student_name']],
  ['report_card', ['linked_student_name']]
]);
const LINKED_STUDENT_NAME_ITEM_V1 = {
  key: 'linkedStudentNameLegible',
  label: 'I inspected the source and confirmed the linked student name is visibly present and legible.'
};
const SCHOOL_NAME_ITEM_V1 = {
  key: 'schoolNameLegible',
  label: 'I inspected the source and confirmed school-name text is visibly present and legible.'
};
const DOCUMENT_TYPE_ITEM_V1 = {
  key: 'selectedDocumentTypeCorrect',
  label: 'I confirmed the selected document type matches the submitted file.'
};
const ALL_PAGES_ITEM_V1 = {
  key: 'allSubmittedPagesReadableComplete',
  label: 'I inspected all submitted pages and confirmed they are readable and complete.'
};
const REPORT_CARD_IDENTITY_ITEM_V1 = {
  key: 'reportCardIdentityMatches',
  label: 'I inspected the previous-school report-card scan and confirmed the learner name and student number match the linked student record.'
};
const REPORT_CARD_PERIOD_ITEM_V1 = {
  key: 'reportCardPeriodIdentified',
  label: 'I confirmed the previous-school report-card scan identifies a prior grading period or school year for the enrollment submission.'
};
const GOOD_MORAL_CONTEXT_ITEM_V2 = {
  key: 'goodMoralContextLegible',
  label: 'I inspected the source and confirmed it contains readable Good Moral certificate title or character statement with surrounding certificate content; isolated name and school lines are insufficient.'
};
const VERIFICATION_CHECKLIST_VERSION = 2;
const VERIFICATION_CHECKLIST_ITEMS_V1 = new Map([
  ['good_moral', [LINKED_STUDENT_NAME_ITEM_V1, SCHOOL_NAME_ITEM_V1, DOCUMENT_TYPE_ITEM_V1, ALL_PAGES_ITEM_V1]],
  ['psa_birth_certificate', [LINKED_STUDENT_NAME_ITEM_V1, DOCUMENT_TYPE_ITEM_V1, ALL_PAGES_ITEM_V1]]
]);
const VERIFICATION_CHECKLIST_ITEMS_V2 = new Map([
  ['good_moral', [LINKED_STUDENT_NAME_ITEM_V1, SCHOOL_NAME_ITEM_V1, GOOD_MORAL_CONTEXT_ITEM_V2, DOCUMENT_TYPE_ITEM_V1, ALL_PAGES_ITEM_V1]],
  ['psa_birth_certificate', [LINKED_STUDENT_NAME_ITEM_V1, DOCUMENT_TYPE_ITEM_V1, ALL_PAGES_ITEM_V1]],
  ['report_card', [REPORT_CARD_IDENTITY_ITEM_V1, REPORT_CARD_PERIOD_ITEM_V1, DOCUMENT_TYPE_ITEM_V1, ALL_PAGES_ITEM_V1]]
]);
const VERIFICATION_CHECKLIST_ITEMS_BY_VERSION = new Map([
  [1, VERIFICATION_CHECKLIST_ITEMS_V1],
  [VERIFICATION_CHECKLIST_VERSION, VERIFICATION_CHECKLIST_ITEMS_V2]
]);

function verificationChecklistItems(documentType) {
  return VERIFICATION_CHECKLIST_ITEMS_V2.get(documentType) || [];
}

function serializeVerificationChecklist(documentType, input) {
  const items = verificationChecklistItems(documentType);
  if (!items.length) throw new DocumentServiceError('This document type cannot be verified through the digital review workflow.', 409);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || items.some(({ key }) => input[key] !== 'yes')) {
    throw new DocumentServiceError('Confirm every applicable source-inspection checklist item before verifying this submission.');
  }
  return JSON.stringify({
    schemaVersion: VERIFICATION_CHECKLIST_VERSION,
    ...Object.fromEntries(items.map(({ key }) => [key, true]))
  });
}

function displayVerificationChecklist(value) {
  if (typeof value !== 'string') return [];
  try {
    const stored = JSON.parse(value);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
    const definitions = VERIFICATION_CHECKLIST_ITEMS_BY_VERSION.get(stored.schemaVersion);
    if (!definitions) return [];
    return [...new Set([...definitions.values()].flat())]
      .filter(({ key }) => stored[key] === true)
      .map(({ label }) => label);
  } catch {
    return [];
  }
}

function activeAdvisoryChecks(documentType, checks) {
  if (!Array.isArray(checks)) return [];
  return documentType === 'report_card'
    ? checks.filter((check) => check?.key !== 'apparent_grade_entries')
    : checks;
}

function supportedDocumentFormat(document) {
  if (typeof document?.original_filename !== 'string' || typeof document?.mime_type !== 'string') return false;
  const extension = path.extname(document.original_filename).toLowerCase();
  const expectedMimeType = MIME_BY_EXTENSION.get(extension);
  return Boolean(expectedMimeType && document.mime_type === expectedMimeType);
}

function blockedNewOriginalTypesFromDocuments(documents) {
  const latestByType = new Map();
  for (const document of documents) {
    if (document.document_type === 'report_card' && (document.is_legacy_archive === true || document.is_legacy_archive === 1)) continue;
    if (STUDENT_UPLOAD_DOCUMENT_TYPES.has(document.document_type) && !latestByType.has(document.document_type)) {
      latestByType.set(document.document_type, document);
    }
  }
  return [...latestByType]
    .filter(([, document]) => document.status !== 'rejected')
    .map(([documentType]) => documentType);
}

function safeGeminiFieldChecks(documentType, summary) {
  const gemini = summary?.gemini;
  const fields = gemini?.fields;
  const available = gemini?.status === 'extracted' && fields && typeof fields === 'object' && !Array.isArray(fields);
  const textValue = (value) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
    : '';
  const studentName = available ? textValue(fields.studentName) : '';
  const studentMatch = available && typeof gemini.studentNameMatchesLinkedRecord === 'boolean'
    ? gemini.studentNameMatchesLinkedRecord
    : null;
  const checks = [{
    key: 'student_name',
    label: 'Gemini-extracted student name',
    value: studentName,
    status: !available ? 'unavailable' : !studentName ? 'not_identified' : studentMatch ? 'matched' : 'mismatch'
  }];
  if (documentType === 'good_moral') {
    const schoolName = available ? textValue(fields.issuingSchoolName) : '';
    const contextEvidence = available ? textValue(fields.goodMoralContextEvidence) : '';
    const layoutEvidence = available ? textValue(fields.goodMoralLayoutEvidence) : '';
    checks.push(
      { key: 'issuing_school_name', label: 'Gemini-extracted issuing school', value: schoolName, status: !available ? 'unavailable' : schoolName ? 'identified' : 'not_identified' },
      { key: 'good_moral_context', label: 'Good Moral title or statement evidence', value: contextEvidence, status: !available ? 'unavailable' : contextEvidence ? 'identified' : 'not_identified' },
      { key: 'good_moral_layout', label: 'Surrounding certificate context', value: layoutEvidence, status: !available ? 'unavailable' : layoutEvidence ? 'identified' : 'not_identified' }
    );
  }
  return checks;
}

function automatedCheckOutcome(documentType, resultStatus, summary, formatCheckPassed) {
  if (!ADVISORY_KEYS_BY_TYPE.has(documentType)) return null;
  if (summary?.precheckVersion !== 2) return 'unavailable';
  if (resultStatus !== 'needs_review') return 'unavailable';
  if (!['precheck_pass', 'precheck_attention', 'gemini_unavailable', 'invalid_file_format'].includes(summary.outcome)) return 'unavailable';
  if (summary.outcome === 'gemini_unavailable') return 'unavailable';
  if (summary.outcome === 'precheck_attention') return 'attention';
  if (summary.fileFormatPassed !== true || !formatCheckPassed) return 'attention';
  if (summary.gemini?.status !== 'extracted') return 'unavailable';
  const fieldChecks = safeGeminiFieldChecks(documentType, summary);
  if (fieldChecks.some((check) => check.status === 'unavailable')) return 'unavailable';
  return fieldChecks.every((check) => ['matched', 'identified'].includes(check.status)) ? 'pass' : 'attention';
}

class DocumentServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DocumentServiceError';
    this.status = status;
  }
}

function normalizeId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

function normalizeDocumentType(value) {
  return ['form_137', 'report_card', 'good_moral', 'psa_birth_certificate'].includes(value) ? value : null;
}

function safeOriginalFilename(value) {
  if (typeof value !== 'string') throw new DocumentServiceError('Choose a PDF, JPEG, or PNG file.');
  const basename = path.basename(value.replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);
  if (!basename || basename === '.' || basename === '..') throw new DocumentServiceError('Choose a file with a valid name.');
  return basename;
}

function hasSupportedSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return false;
}

function validateUpload(file, maxBytes) {
  if (!file || !Buffer.isBuffer(file.buffer)) throw new DocumentServiceError('Choose a PDF, JPEG, or PNG file.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new DocumentServiceError('Document upload is temporarily unavailable.', 503);
  if (file.size === 0 || file.buffer.length === 0) throw new DocumentServiceError('The selected file is empty. Choose a different file.');
  if (file.size > maxBytes || file.buffer.length > maxBytes) throw new DocumentServiceError('The selected file exceeds the configured upload limit.');

  const originalFilename = safeOriginalFilename(file.originalname);
  const extension = path.extname(originalFilename).toLowerCase();
  const expectedMimeType = MIME_BY_EXTENSION.get(extension);
  const declaredMimeType = typeof file.mimetype === 'string' ? file.mimetype.toLowerCase() : '';
  if (!expectedMimeType || expectedMimeType !== declaredMimeType) {
    throw new DocumentServiceError('The file extension and declared file type must match a PDF, JPEG, or PNG.');
  }
  if (!hasSupportedSignature(file.buffer, expectedMimeType)) {
    throw new DocumentServiceError('The selected file content does not match its declared PDF, JPEG, or PNG type.');
  }

  return {
    originalFilename,
    extension,
    mimeType: expectedMimeType,
    fileSizeBytes: file.buffer.length
  };
}

function createDocumentService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  storageDirectory,
  maxUploadBytes = 10 * 1024 * 1024,
  fileSystem = fs,
  logger = console
} = {}) {
  const storageRoot = path.resolve(storageDirectory || path.resolve(__dirname, '../../storage/uploads'));
  const publicRoot = path.resolve(__dirname, '../../public');
  if (storageRoot === publicRoot || storageRoot.startsWith(`${publicRoot}${path.sep}`)) {
    throw new Error('DOCUMENT_STORAGE_DIR must be outside the public web directory.');
  }

  async function ensurePrivateStorageRoot() {
    const realStorageRoot = await fileSystem.realpath(storageRoot);
    const realPublicRoot = await fileSystem.realpath(publicRoot);
    if (realStorageRoot === realPublicRoot || realStorageRoot.startsWith(`${realPublicRoot}${path.sep}`)) {
      throw new DocumentServiceError('Document storage is not configured as a private location.', 503);
    }
  }

  async function runTransaction(callback) {
    const pool = await getPool();
    const transaction = transactionFactory(pool);
    let started = false;
    try {
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      const result = await callback(transaction);
      await transaction.commit();
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try {
          await transaction.rollback();
        } catch {
          // Preserve the original error without exposing database details.
        }
      }
      throw error;
    }
  }

  async function requireActor(transaction, actorInput, allowedRoles) {
    const actorId = normalizeId(actorInput);
    if (!actorId) throw new DocumentServiceError('Document access is required.', 403);
    const result = await transaction.request()
      .input('actorId', sql.Int, actorId)
      .query('SELECT id, role FROM users WHERE id = @actorId AND is_active = 1 FOR UPDATE');
    const actor = result.recordset?.[0];
    if (!actor || !allowedRoles.has(actor.role)) throw new DocumentServiceError('Your document access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function requireReadActor(pool, actorInput) {
    const actorId = normalizeId(actorInput);
    if (!actorId) throw new DocumentServiceError('Document access is required.', 403);
    const result = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query('SELECT id, role FROM users WHERE id = @actorId AND is_active = 1');
    const actor = result.recordset?.[0];
    if (!actor || !['student', ...STAFF_ROLES].includes(actor.role)) throw new DocumentServiceError('Your document access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function writeAudit(transaction, { actor, action, documentId, studentId, documentType }) {
    await transaction.request()
      .input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), `${actor.role}.document_${action}`)
      .input('entityType', sql.NVarChar(100), 'document')
      .input('entityId', sql.NVarChar(100), String(documentId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify({ studentId, documentType }))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  function resolveStoredPath(storedFilename) {
    if (typeof storedFilename !== 'string' || !STORED_NAME_PATTERN.test(storedFilename)) {
      throw new DocumentServiceError('The stored document is unavailable.', 404);
    }
    const resolved = path.resolve(storageRoot, storedFilename);
    const relative = path.relative(storageRoot, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new DocumentServiceError('The stored document is unavailable.', 404);
    }
    return resolved;
  }

  async function savePrivateFile(buffer, storedFilename) {
    await fileSystem.mkdir(storageRoot, { recursive: true, mode: 0o700 });
    await ensurePrivateStorageRoot();
    await fileSystem.chmod(storageRoot, 0o700);
    await ensurePrivateStorageRoot();
    const filePath = resolveStoredPath(storedFilename);
    let fileHandle;
    try {
      fileHandle = await fileSystem.open(filePath, 'wx', 0o600);
      await fileHandle.writeFile(buffer);
      await fileHandle.close();
      fileHandle = null;
    } catch {
      await fileHandle?.close().catch(() => {});
      if (fileHandle) {
        try {
          await fileSystem.unlink(filePath);
        } catch {
          // The write failure remains primary; no public path is returned to the caller.
        }
      }
      throw new DocumentServiceError('The document could not be stored securely.', 503);
    }
    return filePath;
  }

  async function cleanUnreferencedFile(filePath) {
    if (!filePath) return false;
    try {
      await fileSystem.unlink(filePath);
      return true;
    } catch {
      logger.error('Unreferenced document file cleanup failed.');
      return false;
    }
  }

  async function runSubmissionTransaction(callback) {
    let uncommittedFilePath = null;
    try {
      const result = await runTransaction((transaction) => callback(transaction, (filePath) => {
        uncommittedFilePath = filePath;
      }));
      uncommittedFilePath = null;
      return result;
    } catch (error) {
      if (uncommittedFilePath && !await cleanUnreferencedFile(uncommittedFilePath)) {
        throw new DocumentServiceError('The document could not be saved and its temporary file could not be removed. Contact an administrator.', 503);
      }
      throw error;
    }
  }

  function studentTypeAllowed(actor, documentType) {
    if (documentType === 'form_137') return false;
    return actor.role === 'student'
      ? STUDENT_UPLOAD_DOCUMENT_TYPES.has(documentType)
      : UPLOAD_DOCUMENT_TYPES.has(documentType);
  }

  async function insertSubmission({ actor, studentId, documentType, file, metadata, supersedesDocumentId = null, onFileSaved }) {
    const storedFilename = `${crypto.randomUUID()}${metadata.extension}`;
    const initialStatus = 'pending';
    const filePath = await savePrivateFile(file.buffer, storedFilename);
    onFileSaved(filePath);
    const insertResult = await actor.transaction.request()
      .input('studentId', sql.Int, studentId)
      .input('documentType', sql.NVarChar(50), documentType)
      .input('originalFilename', sql.NVarChar(255), metadata.originalFilename)
      .input('storedFilename', sql.NVarChar(255), storedFilename)
      .input('mimeType', sql.NVarChar(100), metadata.mimeType)
      .input('fileSizeBytes', sql.BigInt, metadata.fileSizeBytes)
      .input('uploadedBy', sql.Int, actor.id)
      .input('uploadSource', sql.NVarChar(30), actor.role)
      .input('initialStatus', sql.NVarChar(30), initialStatus)
      .input('isLegacyArchive', sql.Bit, 0)
      .input('supersedesDocumentId', sql.Int, supersedesDocumentId)
      .query(`INSERT INTO documents
          (student_id, document_type, original_filename, stored_filename, mime_type,
          file_size_bytes, uploaded_by, upload_source, status, is_legacy_archive, supersedes_document_id)
        VALUES (@studentId, @documentType, @originalFilename, @storedFilename, @mimeType,
            @fileSizeBytes, @uploadedBy, @uploadSource, @initialStatus, @isLegacyArchive, @supersedesDocumentId)`);
    const documentId = insertResult.insertId;
    if (!Number.isSafeInteger(documentId) || documentId < 1) throw new Error('Document insert returned no identifier.');
    if (supersedesDocumentId !== null && Number(supersedesDocumentId) === documentId) {
      throw new DocumentServiceError('A document cannot supersede itself.', 400);
    }
    await writeAudit(actor.transaction, {
      actor,
      action: supersedesDocumentId ? 'reuploaded' : 'uploaded',
      documentId,
      studentId,
      documentType
    });
    return { id: documentId, studentId, documentType, status: initialStatus };
  }

  async function ensureLatestSubmissionAllowsNewOriginal(transaction, studentId, documentType) {
    const existingResult = await transaction.request()
      .input('studentId', sql.Int, studentId)
      .input('documentType', sql.NVarChar(50), documentType)
      .query(`SELECT id, status FROM documents
        WHERE student_id = @studentId AND document_type = @documentType
          AND (@documentType <> 'report_card' OR is_legacy_archive = 0)
        ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`);
    const latestSubmission = existingResult.recordset?.[0];
    if (latestSubmission && latestSubmission.status !== 'rejected') {
      throw new DocumentServiceError('A submission of this type already exists. Use its correction request to upload a revised file.', 409);
    }
  }

  async function upload(actorInput, input, file) {
    const values = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const documentType = normalizeDocumentType(values.documentType);
    if (!documentType) throw new DocumentServiceError('Choose a supported document type.');
    const metadata = validateUpload(file, maxUploadBytes);
    return runSubmissionTransaction(async (transaction, onFileSaved) => {
      const actor = await requireActor(transaction, actorInput, new Set(['student', ...STAFF_ROLES]));
      if (!studentTypeAllowed(actor, documentType)) {
        const message = documentType === 'form_137'
          ? 'Form 137 is recorded as a physical document status and cannot be uploaded.'
          : documentType === 'report_card'
            ? actor.role === 'student'
              ? 'Previous-school report-card scans receive a limited student-name and file-format precheck, then staff review for enrollment. They do not change published grades.'
              : 'Only students may upload a previous-school report-card scan through their own linked account.'
          : actor.role === 'student'
            ? 'Students may upload Good Moral Certificates, PSA birth certificates, and previous-school report-card scans for their own linked record.'
            : 'Staff may upload Good Moral Certificates and PSA birth certificates.';
        throw new DocumentServiceError(message, 403);
      }

      let studentId;
      if (actor.role === 'student') {
        const studentResult = await transaction.request()
          .input('actorId', sql.Int, actor.id)
          .query('SELECT id FROM students WHERE user_id = @actorId FOR UPDATE');
        studentId = studentResult.recordset?.[0]?.id;
        if (!studentId) throw new DocumentServiceError('No student record is linked to this account.', 403);
      } else {
        studentId = normalizeId(values.studentId);
        if (!studentId) throw new DocumentServiceError('Choose a valid student record.');
        const studentResult = await transaction.request()
          .input('studentId', sql.Int, studentId)
          .query('SELECT id FROM students WHERE id = @studentId FOR UPDATE');
        if (!studentResult.recordset?.length) throw new DocumentServiceError('Student record not found.', 404);
      }

      await ensureLatestSubmissionAllowsNewOriginal(transaction, studentId, documentType);

      const scopedActor = { ...actor, transaction };
      return insertSubmission({ actor: scopedActor, studentId, documentType, file, metadata, onFileSaved });
    });
  }

  async function reupload(actorInput, documentInput, file) {
    const documentId = normalizeId(documentInput);
    if (!documentId) throw new DocumentServiceError('Document not found.', 404);
    const metadata = validateUpload(file, maxUploadBytes);
    return runSubmissionTransaction(async (transaction, onFileSaved) => {
      const actor = await requireActor(transaction, actorInput, new Set(['student', ...STAFF_ROLES]));
      const previousResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('actorId', sql.Int, actor.id)
        .query(`SELECT d.id, d.student_id, d.document_type, d.upload_source, d.status,
            d.is_legacy_archive, d.created_at, s.user_id AS student_user_id
          FROM documents AS d
          INNER JOIN students AS s ON s.id = d.student_id
          WHERE d.id = @documentId FOR UPDATE`);
      const previous = previousResult.recordset?.[0];
      if (!previous) throw new DocumentServiceError('Document not found.', 404);
      if (actor.role === 'student'
        && (previous.student_user_id !== actor.id
          || (previous.document_type === 'psa_birth_certificate' && previous.upload_source !== 'student')
          || (previous.document_type === 'report_card' && (previous.upload_source !== 'student'
            || previous.is_legacy_archive === true || previous.is_legacy_archive === 1))
          || !STUDENT_UPLOAD_DOCUMENT_TYPES.has(previous.document_type))) {
        throw new DocumentServiceError('Document not found.', 404);
      }
      if (previous.document_type === 'form_137') {
        throw new DocumentServiceError('Form 137 is tracked through its physical status history; files cannot be re-uploaded.', 403);
      }
      if (previous.document_type === 'report_card') {
        if (previous.is_legacy_archive === true || previous.is_legacy_archive === 1) {
          throw new DocumentServiceError('Historical report cards cannot be corrected or re-uploaded.', 403);
        }
        if (actor.role !== 'student' || previous.upload_source !== 'student' || previous.student_user_id !== actor.id) {
          throw new DocumentServiceError('Document not found.', 404);
        }
        if (!['needs_review', 'failed'].includes(previous.status)) {
          throw new DocumentServiceError('A corrected upload is available only while staff review remains open.', 409);
        }
      }

      const decisionResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query(`SELECT decision_type AS action_type FROM document_decision_events
          WHERE document_id = @documentId ORDER BY created_at DESC, id DESC LIMIT 1`);
      let correctionRequested = decisionResult.recordset?.[0]?.action_type === 'correction_requested';
      if (!decisionResult.recordset?.length) {
        const legacyReviewResult = await transaction.request()
          .input('documentId', sql.Int, documentId)
          .query(`SELECT action_type FROM document_review_events
            WHERE document_id = @documentId ORDER BY created_at DESC, id DESC LIMIT 1`);
        correctionRequested = legacyReviewResult.recordset?.[0]?.action_type === 'correction_requested';
      }
      if (!correctionRequested) {
        throw new DocumentServiceError('A corrected upload has not been requested for this document.', 409);
      }
      const revisionResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query('SELECT id FROM documents WHERE supersedes_document_id = @documentId LIMIT 1');
      if (revisionResult.recordset?.length) throw new DocumentServiceError('A corrected upload has already been submitted for this document.', 409);
      if (previous.document_type === 'report_card') {
        const newerSubmissionResult = await transaction.request()
          .input('studentId', sql.Int, previous.student_id)
          .input('documentId', sql.Int, documentId)
          .input('createdAt', sql.DateTime2, previous.created_at)
          .query(`SELECT id FROM documents
            WHERE student_id = @studentId AND document_type = 'report_card' AND is_legacy_archive = 0
              AND (created_at > @createdAt OR (created_at = @createdAt AND id > @documentId))
            LIMIT 1`);
        if (newerSubmissionResult.recordset?.length) {
          throw new DocumentServiceError('This correction request belongs to an older report-card submission.', 409);
        }
      }

      return insertSubmission({
        actor: { ...actor, transaction },
        studentId: previous.student_id,
        documentType: previous.document_type,
        file,
        metadata,
        supersedesDocumentId: previous.id,
        onFileSaved
      });
    });
  }

  async function listDocuments(actorInput, searchInput = '', filters = {}) {
    let searchTerm = '';
    if (searchInput !== undefined && searchInput !== null && searchInput !== '') {
      if (typeof searchInput !== 'string') throw new DocumentServiceError('Search must be 100 printable characters or fewer.');
      searchTerm = searchInput.trim();
      if (searchTerm.length > 100 || /[\u0000-\u001f\u007f]/.test(searchTerm)) {
        throw new DocumentServiceError('Search must be 100 printable characters or fewer.');
      }
    }
    const filterValue = (input, allowed, label) => {
      if (input === undefined || input === null || input === '') return 'all';
      if (typeof input !== 'string' || !allowed.includes(input)) throw new DocumentServiceError(`Choose a supported ${label}.`);
      return input;
    };
    const documentType = filterValue(filters?.documentType, ['all', 'good_moral', 'psa_birth_certificate', 'report_card'], 'document type');
    const statusFilter = filterValue(filters?.status, ['all', 'awaiting_review', 'processing', 'verified', 'rejected', 'review_required'], 'review status');
    const pool = await getPool();
    const actor = await requireReadActor(pool, actorInput);
    const searchPattern = searchTerm ? `%${searchTerm.replace(/[~%_[\]]/g, (character) => `~${character}`)}%` : null;
    const result = await pool.request()
      .input('actorId', sql.Int, actor.id)
      .input('searchPattern', sql.NVarChar(204), searchPattern)
      .input('documentType', sql.NVarChar(50), documentType === 'all' ? null : documentType)
      .input('statusFilter', sql.NVarChar(30), statusFilter === 'all' ? null : statusFilter)
      .query(`SELECT d.id, d.student_id, d.document_type, d.is_legacy_archive,
          CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
              OR d.document_type <> 'report_card' OR ${studentReportCardSourceAccessSql('d')}
            THEN d.original_filename ELSE NULL END AS original_filename,
          CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
              OR d.document_type <> 'report_card' OR ${studentReportCardSourceAccessSql('d')}
            THEN d.mime_type ELSE NULL END AS mime_type,
          CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
              OR d.document_type <> 'report_card' OR ${studentReportCardSourceAccessSql('d')}
            THEN d.file_size_bytes ELSE NULL END AS file_size_bytes,
          d.status, d.supersedes_document_id, d.created_at,
          CASE WHEN ${studentReportCardSourceAccessSql('d')} THEN 1 ELSE 0 END AS student_can_view_source,
          s.student_no, s.first_name, s.middle_name, s.last_name,
          latest.action_type AS latest_review_action,
          CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
              OR d.document_type NOT IN ('psa_birth_certificate', 'report_card')
              OR (d.document_type = 'psa_birth_certificate' AND d.upload_source = 'student')
              OR ${studentReportCardSourceAccessSql('d')}
            THEN latest.instruction ELSE NULL END AS latest_review_instruction,
          latest.created_at AS latest_review_at, latest_decision.decision_type AS latest_decision_type
        FROM documents AS d
        INNER JOIN students AS s ON s.id = d.student_id
        LEFT JOIN v_document_latest_review_event AS latest ON latest.document_id = d.id
        LEFT JOIN v_document_latest_decision_event AS latest_decision ON latest_decision.document_id = d.id
        WHERE ((
          EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
          AND (@searchPattern IS NULL OR s.student_no LIKE @searchPattern ESCAPE '~'
            OR s.first_name LIKE @searchPattern ESCAPE '~' OR s.middle_name LIKE @searchPattern ESCAPE '~'
            OR s.last_name LIKE @searchPattern ESCAPE '~'
            OR s.lrn LIKE @searchPattern ESCAPE '~'
            OR CONCAT_WS(' ', s.first_name, NULLIF(s.middle_name, ''), s.last_name) LIKE @searchPattern ESCAPE '~')
        ) OR (
          EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role = 'student')
              AND s.user_id = @actorId AND (
            (d.document_type IN ('good_moral', 'psa_birth_certificate')
              OR (d.document_type = 'report_card' AND d.is_legacy_archive = 0 AND d.upload_source = 'student'))
          )
        ))
        AND (@documentType IS NULL OR d.document_type = @documentType)
        AND (@statusFilter IS NULL
          OR (@statusFilter = 'awaiting_review' AND (${ACTIONABLE_REGISTRAR_REVIEW_SQL}))
          OR (@statusFilter = 'processing' AND d.status IN ('pending', 'processing'))
          OR (@statusFilter = 'verified' AND d.status = 'valid')
          OR (@statusFilter = 'rejected' AND d.status = 'rejected')
          OR (@statusFilter = 'review_required' AND d.status = 'failed'))
        ORDER BY d.created_at DESC, d.id DESC LIMIT 200`);
    let blockedNewOriginalTypes = [];
    let statusSummary = [];
    if (STAFF_ROLES.has(actor.role)) {
      const summaryResult = await pool.request()
        .input('actorId', sql.Int, actor.id)
        .query(`WITH latest_submissions AS (
          SELECT d.student_id, d.document_type, d.status, d.is_legacy_archive,
            ROW_NUMBER() OVER (PARTITION BY d.student_id, d.document_type ORDER BY d.created_at DESC, d.id DESC) AS submission_rank
          FROM documents AS d
          WHERE d.document_type IN ('good_moral', 'psa_birth_certificate')
        )
        SELECT required.document_type, COUNT(*) AS student_count,
          SUM(CASE WHEN latest.status IS NULL THEN 1 ELSE 0 END) AS missing_count,
          SUM(CASE WHEN latest.status = 'needs_review' THEN 1 ELSE 0 END) AS awaiting_review_count,
          SUM(CASE WHEN latest.status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS processing_count,
          SUM(CASE WHEN latest.status = 'valid' THEN 1 ELSE 0 END) AS verified_count,
          SUM(CASE WHEN latest.status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
          SUM(CASE WHEN latest.status = 'failed' THEN 1 ELSE 0 END) AS review_required_count
        FROM students AS s
        CROSS JOIN (SELECT 'good_moral' AS document_type UNION ALL SELECT 'psa_birth_certificate') AS required
        LEFT JOIN latest_submissions AS latest ON latest.student_id = s.id
          AND latest.document_type = required.document_type AND latest.submission_rank = 1
        WHERE s.status = 'active'
          AND EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
        GROUP BY required.document_type`);
      statusSummary = summaryResult.recordset || [];
      const reportCardSummaryResult = await pool.request()
        .input('actorId', sql.Int, actor.id)
        .query(`WITH ranked_report_cards AS (
          SELECT d.student_id, d.status, latest_decision.decision_type AS latest_decision_type,
            ROW_NUMBER() OVER (PARTITION BY d.student_id ORDER BY d.created_at DESC, d.id DESC) AS submission_rank
          FROM documents AS d
          LEFT JOIN v_document_latest_decision_event AS latest_decision ON latest_decision.document_id = d.id
          WHERE d.document_type = 'report_card' AND d.is_legacy_archive = 0 AND d.upload_source = 'student'
        )
        SELECT 'report_card' AS document_type, COUNT(*) AS submitted_count,
          COALESCE(SUM(CASE WHEN status = 'needs_review' AND COALESCE(latest_decision_type, '') <> 'correction_requested' THEN 1 ELSE 0 END), 0) AS awaiting_review_count,
          COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END), 0) AS processing_count,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS review_required_count,
          COALESCE(SUM(CASE WHEN latest_decision_type = 'correction_requested' THEN 1 ELSE 0 END), 0) AS correction_requested_count,
          COALESCE(SUM(CASE WHEN status = 'valid' THEN 1 ELSE 0 END), 0) AS verified_count,
          COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected_count
        FROM ranked_report_cards
        WHERE submission_rank = 1
          AND EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))`);
      statusSummary.push(reportCardSummaryResult.recordset?.[0] || {
        document_type: 'report_card', submitted_count: 0, awaiting_review_count: 0,
        processing_count: 0, review_required_count: 0, correction_requested_count: 0,
        verified_count: 0, rejected_count: 0
      });
    }
    if (actor.role === 'student') {
      const blockedResult = await pool.request()
        .input('actorId', sql.Int, actor.id)
        .query(`WITH latest_submissions AS (
          SELECT d.document_type, d.status,
            ROW_NUMBER() OVER (PARTITION BY d.document_type ORDER BY d.created_at DESC, d.id DESC) AS submission_rank
          FROM documents AS d
          INNER JOIN students AS s ON s.id = d.student_id
          WHERE s.user_id = @actorId AND (d.document_type IN ('good_moral', 'psa_birth_certificate')
            OR (d.document_type = 'report_card' AND d.is_legacy_archive = 0 AND d.upload_source = 'student'))
        )
        SELECT document_type FROM latest_submissions
        WHERE submission_rank = 1 AND status <> 'rejected'`);
      blockedNewOriginalTypes = (blockedResult.recordset || []).map(({ document_type }) => document_type);
    }
    return {
      documents: result.recordset || [], searchTerm, isStaff: STAFF_ROLES.has(actor.role),
      blockedNewOriginalTypes, statusSummary, documentType, statusFilter
    };
  }

  async function countAwaitingStaffReview(actorInput) {
    const pool = await getPool();
    const actor = await requireReadActor(pool, actorInput);
    if (actor.role !== 'registrar') throw new DocumentServiceError('Registrar document-review access is required.', 403);
    const result = await pool.request().input('actorId', sql.Int, actor.id)
      .query(`SELECT COUNT(*) AS actionable_count
        FROM documents AS d
        LEFT JOIN v_document_latest_decision_event AS latest_decision ON latest_decision.document_id = d.id
        WHERE (${ACTIONABLE_REGISTRAR_REVIEW_SQL})
          AND EXISTS (SELECT 1 FROM users AS reviewer WHERE reviewer.id = @actorId
            AND reviewer.role = 'registrar' AND reviewer.is_active = 1)`);
    return Math.max(0, Number(result.recordset?.[0]?.actionable_count) || 0);
  }

  async function listPhysicalRequirements(actorInput, searchInput = '', pageInput = 1) {
    let searchTerm = '';
    if (searchInput !== undefined && searchInput !== null && searchInput !== '') {
      if (typeof searchInput !== 'string') throw new DocumentServiceError('Search must be 100 printable characters or fewer.');
      searchTerm = searchInput.trim();
      if (searchTerm.length > 100 || /[\u0000-\u001f\u007f]/.test(searchTerm)) {
        throw new DocumentServiceError('Search must be 100 printable characters or fewer.');
      }
    }
    const requestedPage = pageInput === undefined || pageInput === null || pageInput === ''
      ? 1
      : typeof pageInput === 'number'
        ? pageInput
        : typeof pageInput === 'string' && /^\d{1,7}$/.test(pageInput)
          ? Number(pageInput)
          : NaN;
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 1_000_000) {
      throw new DocumentServiceError('Choose a valid physical-requirements page.');
    }

    const searchPattern = searchTerm ? `%${searchTerm.replace(/[~%_[\]]/g, (character) => `~${character}`)}%` : null;
    const pageSize = 25;
    const pool = await getPool();
    const actor = await requireReadActor(pool, actorInput);
    if (!STAFF_ROLES.has(actor.role)) throw new DocumentServiceError('Staff physical-requirements access is required.', 403);

    const matchingStudents = await pool.request()
      .input('actorId', sql.Int, actor.id)
      .input('searchPattern', sql.NVarChar(204), searchPattern)
      .query(`SELECT COUNT(*) AS total_students
        FROM students AS s
        WHERE s.status = 'active'
          AND EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
          AND (@searchPattern IS NULL
            OR s.student_no LIKE @searchPattern ESCAPE '~'
            OR s.lrn LIKE @searchPattern ESCAPE '~'
            OR s.first_name LIKE @searchPattern ESCAPE '~'
            OR s.middle_name LIKE @searchPattern ESCAPE '~'
            OR s.last_name LIKE @searchPattern ESCAPE '~'
          OR CONCAT_WS(' ', s.first_name, NULLIF(s.middle_name, ''), s.last_name) LIKE @searchPattern ESCAPE '~')`);
    const totalStudents = Number(matchingStudents.recordset?.[0]?.total_students || 0);
    if (!Number.isSafeInteger(totalStudents) || totalStudents < 0) {
      throw new DocumentServiceError('Physical-requirements records could not be loaded.', 503);
    }
    const totalPages = Math.max(1, Math.ceil(totalStudents / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const students = await pool.request()
      .input('actorId', sql.Int, actor.id)
      .input('searchPattern', sql.NVarChar(204), searchPattern)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize)
      .query(`SELECT s.id, s.student_no, s.lrn, s.first_name, s.middle_name, s.last_name, s.suffix,
          form137.status AS form137_status, form137.created_at AS form137_updated_at,
          report_card.status AS paper_report_card_status, report_card.created_at AS paper_report_card_updated_at
        FROM students AS s
        LEFT JOIN v_form137_latest_status_event AS form137 ON form137.student_id = s.id
        LEFT JOIN v_previous_school_report_card_latest_status_event AS report_card ON report_card.student_id = s.id
        WHERE s.status = 'active'
          AND EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
          AND (@searchPattern IS NULL
            OR s.student_no LIKE @searchPattern ESCAPE '~'
            OR s.lrn LIKE @searchPattern ESCAPE '~'
            OR s.first_name LIKE @searchPattern ESCAPE '~'
            OR s.middle_name LIKE @searchPattern ESCAPE '~'
            OR s.last_name LIKE @searchPattern ESCAPE '~'
            OR CONCAT_WS(' ', s.first_name, NULLIF(s.middle_name, ''), s.last_name) LIKE @searchPattern ESCAPE '~')
        ORDER BY s.last_name, s.first_name, s.student_no, s.id
        LIMIT @pageSize OFFSET @offset`);

    return {
      students: students.recordset || [], searchTerm, totalStudents,
      page, pageSize, totalPages
    };
  }

  async function getStudentDocuments(actorInput, studentInput) {
    const studentId = normalizeId(studentInput);
    if (!studentId) throw new DocumentServiceError('Student record not found.', 404);
    const pool = await getPool();
    const actor = await requireReadActor(pool, actorInput);
    if (!STAFF_ROLES.has(actor.role)) throw new DocumentServiceError('Staff document access is required.', 403);
    const studentResult = await pool.request()
      .input('studentId', sql.Int, studentId)
      .input('actorId', sql.Int, actor.id)
      .query(`SELECT s.id, s.student_no, s.first_name, s.middle_name, s.last_name, s.status
        FROM students AS s WHERE s.id = @studentId
          AND EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))`);
    const student = studentResult.recordset?.[0];
    if (!student) return null;
    const [documentResult, form137StatusResult, previousSchoolReportCardStatusResult] = await Promise.all([
      pool.request()
      .input('studentId', sql.Int, studentId)
      .input('actorId', sql.Int, actor.id)
      .query(`SELECT d.id, d.student_id, d.document_type, d.is_legacy_archive, d.original_filename,
          d.mime_type, d.file_size_bytes, d.status, d.supersedes_document_id, d.created_at,
          latest.action_type AS latest_review_action, latest.instruction AS latest_review_instruction,
          latest.created_at AS latest_review_at, latest_decision.decision_type AS latest_decision_type
        FROM documents AS d
        LEFT JOIN v_document_latest_review_event AS latest ON latest.document_id = d.id
        LEFT JOIN v_document_latest_decision_event AS latest_decision ON latest_decision.document_id = d.id
        WHERE d.student_id = @studentId
          AND EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
        ORDER BY d.created_at DESC, d.id DESC`),
      pool.request()
        .input('studentId', sql.Int, studentId)
        .input('actorId', sql.Int, actor.id)
        .query(`SELECT e.id, e.status, e.instruction, e.created_at,
            e.recorded_by, COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(p.first_name, ' ', p.last_name))), ''), CONCAT('Staff ', e.recorded_by)) AS recorded_by_name
          FROM form137_status_events AS e
          LEFT JOIN staff_profiles AS p ON p.user_id = e.recorded_by
          WHERE e.student_id = @studentId
            AND EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
          ORDER BY e.created_at DESC, e.id DESC`),
      pool.request()
        .input('studentId', sql.Int, studentId)
        .input('actorId', sql.Int, actor.id)
        .query(`SELECT e.id, e.status, e.instruction, e.created_at, e.recorded_by,
            COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(p.first_name, ' ', p.last_name))), ''), CONCAT('Staff ', e.recorded_by)) AS recorded_by_name
          FROM previous_school_report_card_status_events AS e
          LEFT JOIN staff_profiles AS p ON p.user_id = e.recorded_by
          WHERE e.student_id = @studentId
            AND EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
          ORDER BY e.created_at DESC, e.id DESC`)
    ]);
    const form137StatusHistory = form137StatusResult.recordset || [];
    const previousSchoolReportCardStatusHistory = previousSchoolReportCardStatusResult.recordset || [];
    const documents = documentResult.recordset || [];
    return {
      student,
      documents,
      blockedNewOriginalTypes: blockedNewOriginalTypesFromDocuments(documents),
      form137Status: form137StatusHistory[0] || { status: 'not_recorded', instruction: null, created_at: null },
      form137StatusHistory,
      previousSchoolReportCardPhysicalStatus: previousSchoolReportCardStatusHistory[0] || { status: 'not_recorded', instruction: null, created_at: null },
      previousSchoolReportCardPhysicalStatusHistory: previousSchoolReportCardStatusHistory
    };
  }

  async function getOwnPreviousSchoolReportCardPhysicalStatus(actorInput) {
    const pool = await getPool();
    const actor = await requireReadActor(pool, actorInput);
    if (actor.role !== 'student') throw new DocumentServiceError('Student document access is required.', 403);
    const result = await pool.request()
      .input('actorId', sql.Int, actor.id)
      .query(`SELECT e.status, e.created_at
        FROM previous_school_report_card_status_events AS e
        INNER JOIN students AS s ON s.id = e.student_id
        INNER JOIN users AS u ON u.id = @actorId AND u.is_active = 1 AND u.role = 'student'
        WHERE s.user_id = @actorId
        ORDER BY e.created_at DESC, e.id DESC LIMIT 1`);
    return result.recordset?.[0] || { status: 'not_recorded', created_at: null };
  }

  async function getDocument(actorInput, documentInput) {
    const documentId = normalizeId(documentInput);
    if (!documentId) return null;
    const pool = await getPool();
    const actor = await requireReadActor(pool, actorInput);
    const documentResult = await pool.request()
      .input('actorId', sql.Int, actor.id)
      .input('documentId', sql.Int, documentId)
      .query(`SELECT d.id, d.student_id, d.document_type, d.is_legacy_archive, d.original_filename, d.stored_filename,
          d.mime_type, d.file_size_bytes, d.uploaded_by, d.upload_source, d.status,
          d.supersedes_document_id, d.created_at, s.user_id AS student_user_id,
          s.student_no, s.first_name, s.middle_name, s.last_name, u.role AS uploader_role
        FROM documents AS d
        INNER JOIN students AS s ON s.id = d.student_id
        INNER JOIN users AS u ON u.id = d.uploaded_by
        WHERE d.id = @documentId
          AND (EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
            OR (EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role = 'student')
              AND s.user_id = @actorId
              AND (d.document_type IN ('good_moral', 'psa_birth_certificate')
                OR ${studentReportCardSourceAccessSql('d')})))`);
    const document = documentResult.recordset?.[0];
    if (!document) return null;

    const archivedReportCard = document.document_type === 'report_card'
      && (document.is_legacy_archive === true || document.is_legacy_archive === 1);
    const validationPromise = STAFF_ROLES.has(actor.role)
      && document.document_type !== 'form_137' && !archivedReportCard
      ? pool.request()
        .input('documentId', sql.Int, documentId)
        .input('actorId', sql.Int, actor.id)
        .input('precheckProcessor', sql.NVarChar(100), GEMINI_PRECHECK_PROCESSOR)
        .query(`SELECT validation.id, validation.processor, validation.extracted_text,
            validation.validation_json, validation.result_status, validation.created_at,
            (SELECT COUNT(*) FROM document_validations AS attempts
              WHERE attempts.document_id = @documentId AND attempts.processor = @precheckProcessor) AS precheck_attempt_count
          FROM document_validations AS validation
          WHERE validation.document_id = @documentId
            AND EXISTS (SELECT 1 FROM users
              WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
          ORDER BY validation.created_at DESC, validation.id DESC LIMIT 1`)
      : Promise.resolve({ recordset: [] });
    const visibleReviewer = STAFF_ROLES.has(actor.role)
      ? "COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(p.first_name, ' ', p.last_name))), ''), CONCAT('Staff ', e.reviewer_id))"
      : 'CAST(NULL AS CHAR(201))';
    const reviewHistorySql = archivedReportCard
      ? 'SELECT CAST(NULL AS SIGNED) AS id WHERE 1 = 0'
      : STAFF_ROLES.has(actor.role)
      ? `SELECT e.id, e.action_type, e.instruction, e.created_at,
          e.reviewer_id, COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(p.first_name, ' ', p.last_name))), ''), CONCAT('Staff ', e.reviewer_id)) AS reviewer_name
        FROM document_review_events AS e
        LEFT JOIN staff_profiles AS p ON p.user_id = e.reviewer_id
        WHERE e.document_id = @documentId ORDER BY e.created_at DESC, e.id DESC`
      : `SELECT e.id, e.action_type, e.instruction, e.created_at,
          CAST(NULL AS SIGNED) AS reviewer_id, CAST(NULL AS CHAR(201)) AS reviewer_name
        FROM document_review_events AS e
        WHERE e.document_id = @documentId AND e.action_type = 'correction_requested'
          AND (@documentType NOT IN ('psa_birth_certificate', 'report_card') OR @uploadSource = 'student')
        ORDER BY e.created_at DESC, e.id DESC`;
    const decisionHistorySql = archivedReportCard
      ? 'SELECT CAST(NULL AS SIGNED) AS id WHERE 1 = 0'
      : STAFF_ROLES.has(actor.role)
      ? `SELECT e.id, e.decision_type, e.reason, e.verification_checklist_json, e.created_at, ${visibleReviewer} AS reviewer_name
        FROM document_decision_events AS e
        LEFT JOIN staff_profiles AS p ON p.user_id = e.reviewer_id
        WHERE e.document_id = @documentId ORDER BY e.created_at DESC, e.id DESC`
      : `SELECT e.id, e.decision_type,
          CASE WHEN e.decision_type IN ('rejected', 'correction_requested')
              AND (@documentType NOT IN ('psa_birth_certificate', 'report_card') OR @uploadSource = 'student')
            THEN e.reason ELSE NULL END AS reason,
          CAST(NULL AS CHAR(500)) AS verification_checklist_json,
          e.created_at,
          CAST(NULL AS CHAR(201)) AS reviewer_name
        FROM document_decision_events AS e
        WHERE e.document_id = @documentId
        ORDER BY e.created_at DESC, e.id DESC`;
    const [historyResult, eventsResult, validationResult, decisionsResult] = await Promise.all([
      pool.request()
        .input('studentId', sql.Int, document.student_id)
        .input('documentType', sql.NVarChar(50), document.document_type)
        .input('actorId', sql.Int, actor.id)
        .query(`SELECT history_document.id,
            CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
                OR @documentType <> 'report_card' OR ${studentReportCardSourceAccessSql('history_document')}
              THEN history_document.original_filename ELSE NULL END AS original_filename,
            CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
                OR @documentType <> 'report_card' OR ${studentReportCardSourceAccessSql('history_document')}
              THEN history_document.mime_type ELSE NULL END AS mime_type,
            history_document.is_legacy_archive,
            history_document.status, history_document.supersedes_document_id, history_document.created_at,
            CASE WHEN ${studentReportCardSourceAccessSql('history_document')} THEN 1 ELSE 0 END AS student_can_view_source,
            latest.action_type AS latest_review_action, latest_decision.decision_type AS latest_decision_type
          FROM documents AS history_document
          LEFT JOIN v_document_latest_review_event AS latest ON latest.document_id = history_document.id
          LEFT JOIN v_document_latest_decision_event AS latest_decision ON latest_decision.document_id = history_document.id
          WHERE history_document.student_id = @studentId AND history_document.document_type = @documentType
            AND (history_document.document_type <> 'report_card' OR (history_document.is_legacy_archive = 0 AND history_document.upload_source = 'student'))
            AND (EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
              OR EXISTS (SELECT 1 FROM students AS history_student
                WHERE history_student.id = history_document.student_id AND history_student.user_id = @actorId
                  AND EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role = 'student')))
          ORDER BY history_document.created_at DESC, history_document.id DESC`),
      pool.request()
        .input('documentId', sql.Int, documentId)
        .input('documentType', sql.NVarChar(50), document.document_type)
        .input('uploadSource', sql.NVarChar(30), document.upload_source)
        .query(reviewHistorySql),
      validationPromise,
      pool.request()
        .input('documentId', sql.Int, documentId)
        .input('documentType', sql.NVarChar(50), document.document_type)
        .input('uploadSource', sql.NVarChar(30), document.upload_source)
        .query(decisionHistorySql)
    ]);
    const validationRow = validationResult.recordset?.[0];
    let validation = null;
    if (validationRow) {
      let outcome = null;
      let storedSummary = null;
      let advisory = [];
      try {
        storedSummary = JSON.parse(validationRow.validation_json);
        outcome = storedSummary?.outcome;
        advisory = activeAdvisoryChecks(document.document_type, storedSummary?.advisoryChecks);
      } catch {
        // Ignore malformed stored summaries and use a fixed safe fallback.
      }
      const formatCheckPassed = supportedDocumentFormat(document);
      const checkOutcome = automatedCheckOutcome(
        document.document_type,
        validationRow.result_status,
        storedSummary,
        formatCheckPassed
      );
      const legacyOcrOnly = storedSummary?.precheckVersion !== 2;
      const storedAttemptCount = Number(validationRow.precheck_attempt_count);
      const precheckAttemptCount = Number.isSafeInteger(storedAttemptCount) && storedAttemptCount >= 0
        ? storedAttemptCount
        : validationRow.processor === GEMINI_PRECHECK_PROCESSOR ? 1 : 0;
      const hasFinalDecision = (decisionsResult.recordset || []).some(({ decision_type }) => ['verified', 'rejected'].includes(decision_type));
      validation = {
        id: validationRow.id,
        processor: validationRow.processor,
        extracted_text: validationRow.extracted_text,
        result_status: validationRow.result_status,
        created_at: validationRow.created_at,
        advisoryChecks: advisory,
        fieldChecks: safeGeminiFieldChecks(document.document_type, storedSummary),
        formatCheckPassed,
        automatedCheckOutcome: checkOutcome,
        requiresOverrideReason: checkOutcome !== 'pass',
        legacyOcrOnly,
        canRetryPrecheck: canRetryGeminiPrecheck({
          documentType: document.document_type,
          isLegacyArchive: document.is_legacy_archive,
          documentStatus: document.status,
          validationSummary: storedSummary,
          precheckAttemptCount,
          hasFinalDecision
        }),
        precheckRetriesRemaining: Math.max(0, MAX_GEMINI_PRECHECK_ATTEMPTS - precheckAttemptCount),
        message: legacyOcrOnly
          ? 'Legacy OCR-only result. Gemini field extraction was not run; inspect the source and record a staff decision.'
          : PRECHECK_MESSAGES.get(outcome) || (storedSummary?.gemini?.status === 'unavailable'
            ? 'Gemini field extraction is unavailable. Staff inspection is required.'
            : 'A processing result is available for staff review.')
      };
    }
    const decisions = (decisionsResult.recordset || []).map(({ verification_checklist_json: checklistJson, ...decision }) => ({
      ...decision,
      verificationChecklist: displayVerificationChecklist(checklistJson)
    }));
    const history = historyResult.recordset || [];
    if (actor.role === 'student' && document.document_type === 'report_card') {
      for (const version of history) {
        if (!Number(version.student_can_view_source)) {
          version.original_filename = null;
          version.mime_type = null;
        }
      }
    }
    return {
      ...document,
      history,
      reviewEvents: eventsResult.recordset || [],
      decisions,
      validation,
      isArchivedReportCard: archivedReportCard,
      isStaff: STAFF_ROLES.has(actor.role)
    };
  }

  async function requestPrecheckRetry(actorInput, documentInput) {
    const documentId = normalizeId(documentInput);
    if (!documentId) throw new DocumentServiceError('Document not found.', 404);

    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction, actorInput, STAFF_ROLES);
      const documentResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('precheckProcessor', sql.NVarChar(100), GEMINI_PRECHECK_PROCESSOR)
        .query(`SELECT d.id, d.student_id, d.document_type, d.is_legacy_archive, d.status,
            latest.validation_json,
            (SELECT COUNT(*) FROM document_validations AS attempts
              WHERE attempts.document_id = d.id AND attempts.processor = @precheckProcessor) AS precheck_attempt_count
          FROM documents AS d
          LEFT JOIN v_document_latest_validation AS latest ON latest.document_id = d.id
          WHERE d.id = @documentId FOR UPDATE`);
      const document = documentResult.recordset?.[0];
      if (!document) throw new DocumentServiceError('Document not found.', 404);

      const finalDecisionResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query(`SELECT id
          FROM document_decision_events
          WHERE document_id = @documentId AND decision_type IN ('verified', 'rejected') LIMIT 1 FOR UPDATE`);
      const hasFinalDecision = Boolean(finalDecisionResult.recordset?.length);
      let validationSummary = null;
      try {
        validationSummary = JSON.parse(document.validation_json || 'null');
      } catch {
        // Malformed summaries are never eligible for another provider request.
      }

      const precheckAttemptCount = Number(document.precheck_attempt_count);
      if (!canRetryGeminiPrecheck({
        documentType: document.document_type,
        isLegacyArchive: document.is_legacy_archive,
        documentStatus: document.status,
        validationSummary,
        precheckAttemptCount,
        hasFinalDecision
      })) {
        const message = precheckAttemptCount >= MAX_GEMINI_PRECHECK_ATTEMPTS
          ? 'The automated precheck retry limit has been reached for this submission.'
          : 'This submission is not eligible for an automated precheck retry.';
        throw new DocumentServiceError(message, 409);
      }

      const updateResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('studentId', sql.Int, document.student_id)
        .input('documentType', sql.NVarChar(50), document.document_type)
        .query(`UPDATE documents
          SET status = 'pending', processing_started_at = NULL
          WHERE id = @documentId AND status = 'needs_review'
            AND ((document_type IN ('good_moral', 'psa_birth_certificate'))
              OR (document_type = 'report_card' AND is_legacy_archive = 0))`);
      if (!updateResult.affectedRows) {
        throw new DocumentServiceError('The submission state changed before the retry could be queued.', 409);
      }

      await writeAudit(transaction, {
        actor,
        action: 'precheck_retry_queued',
        documentId,
        studentId: document.student_id,
        documentType: document.document_type
      });
      return { id: documentId, status: 'pending' };
    });
  }

  async function addReviewEvent(actorInput, documentInput, actionInput, instructionInput = '') {
    const documentId = normalizeId(documentInput);
    if (!documentId) throw new DocumentServiceError('Document not found.', 404);
    const action = actionInput === 'correction_requested' ? actionInput : null;
    if (!action) throw new DocumentServiceError('Choose a valid review action.');
    const instruction = typeof instructionInput === 'string' ? instructionInput.trim() : '';
    if (action === 'correction_requested' && (!instruction || instruction.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instruction))) {
      throw new DocumentServiceError('Enter a correction instruction up to 1000 characters.');
    }

    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction, actorInput, new Set(STAFF_ROLES));
      const documentResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query(`SELECT id, student_id, document_type, is_legacy_archive FROM documents
          WHERE id = @documentId FOR UPDATE`);
      const document = documentResult.recordset?.[0];
      if (!document) throw new DocumentServiceError('Document not found.', 404);
      if (document.document_type === 'form_137') {
        throw new DocumentServiceError('Form 137 uses the physical status workflow.', 409);
      }
      if (document.document_type === 'report_card'
        && (document.is_legacy_archive === true || document.is_legacy_archive === 1)) {
        throw new DocumentServiceError('Historical report cards are read-only archive records.', 409);
      }
      await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('reviewerId', sql.Int, actor.id)
        .input('actionType', sql.NVarChar(40), action)
        .input('instruction', sql.NVarChar(1000), action === 'correction_requested' ? instruction : null)
        .query(`INSERT INTO document_review_events (document_id, reviewer_id, action_type, instruction)
          VALUES (@documentId, @reviewerId, @actionType, @instruction)`);
      await writeAudit(transaction, {
        actor,
        action: 'correction_requested',
        documentId,
        studentId: document.student_id,
        documentType: document.document_type
      });
      return documentId;
    });
  }

  async function decideDocument(actorInput, documentInput, decisionInput, reasonInput = '', checklistInput = null) {
    const documentId = normalizeId(documentInput);
    if (!documentId) throw new DocumentServiceError('Document not found.', 404);
    const decision = ['verified', 'correction_requested', 'rejected'].includes(decisionInput) ? decisionInput : null;
    if (!decision) throw new DocumentServiceError('Choose a valid document decision.');
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (reason.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
      throw new DocumentServiceError('Enter a review reason up to 1000 characters.');
    }
    if (decision !== 'verified' && !reason) {
      throw new DocumentServiceError('Enter a correction instruction or rejection reason.');
    }

    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction, actorInput, new Set(STAFF_ROLES));
      const documentResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query(`SELECT d.id, d.student_id, d.document_type, d.is_legacy_archive, d.status, d.original_filename, d.mime_type,
            validation.result_status, validation.validation_json
          FROM documents AS d
          LEFT JOIN v_document_latest_validation AS validation ON validation.document_id = d.id
          WHERE d.id = @documentId FOR UPDATE`);
      const document = documentResult.recordset?.[0];
      if (!document) throw new DocumentServiceError('Document not found.', 404);
      if (document.document_type === 'form_137') {
        throw new DocumentServiceError('Form 137 uses the physical status workflow.', 409);
      }
      const activeReportCard = document.document_type === 'report_card'
        && document.is_legacy_archive !== true && document.is_legacy_archive !== 1;
      if (document.document_type === 'report_card' && !activeReportCard) {
        throw new DocumentServiceError('Historical report cards are read-only archive records.', 409);
      }
      if (!['needs_review', 'failed'].includes(document.status)) {
        throw new DocumentServiceError(activeReportCard
          ? 'This report card is not waiting for a staff decision.'
          : 'The field precheck must finish before staff review.', 409);
      }
      if ((activeReportCard || decision === 'verified') && !document.result_status) {
        throw new DocumentServiceError('A precheck result must be recorded before staff review.', 409);
      }
      const checklistJson = decision === 'verified'
        ? serializeVerificationChecklist(document.document_type, checklistInput)
        : null;

      const latestDecisionResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query(`SELECT decision_type FROM document_decision_events
          WHERE document_id = @documentId ORDER BY created_at DESC, id DESC LIMIT 1`);
      const previousDecision = latestDecisionResult.recordset?.[0]?.decision_type;
      if (previousDecision === 'verified' || previousDecision === 'rejected') {
        throw new DocumentServiceError('This submission already has a final staff decision.', 409);
      }

      let summary = null;
      let advisoryChecks = [];
      try {
        summary = JSON.parse(document.validation_json);
        advisoryChecks = activeAdvisoryChecks(document.document_type, summary?.advisoryChecks);
      } catch {
        // A malformed advisory summary is not allowed to bypass the source inspection decision.
      }
      const checkOutcome = automatedCheckOutcome(
        document.document_type,
        document.result_status,
        summary,
        summary?.fileFormatPassed === true && supportedDocumentFormat(document)
      );
      if (decision === 'verified' && checkOutcome !== 'pass' && !reason) {
        throw new DocumentServiceError('Enter a reason to verify a submission when automated checks did not pass.');
      }

      await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('reviewerId', sql.Int, actor.id)
        .input('decisionType', sql.NVarChar(40), decision)
        .input('reason', sql.NVarChar(1000), reason || null)
        .input('verificationChecklistJson', sql.NVarChar(500), checklistJson)
        .query(`INSERT INTO document_decision_events
            (document_id, reviewer_id, decision_type, reason, verification_checklist_json)
          VALUES (@documentId, @reviewerId, @decisionType, @reason, @verificationChecklistJson)`);

      const nextStatus = decision === 'verified' ? 'valid' : decision === 'rejected' ? 'rejected' : 'needs_review';
      const updateResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('nextStatus', sql.NVarChar(30), nextStatus)
        .input('currentStatus', sql.NVarChar(30), document.status)
        .query(`UPDATE documents SET status = @nextStatus, processing_started_at = NULL
          WHERE id = @documentId AND status = @currentStatus AND status IN ('needs_review', 'failed')`);
      if (!updateResult.affectedRows) {
        throw new DocumentServiceError('The submission state changed before the staff decision could be saved.', 409);
      }
      await writeAudit(transaction, {
        actor,
        action: `review_${decision}`,
        documentId,
        studentId: document.student_id,
        documentType: document.document_type
      });
      return { id: documentId, status: nextStatus, decision };
    });
  }

  async function deleteDocument(actorInput, documentInput) {
    const documentId = normalizeId(documentInput);
    if (!documentId) throw new DocumentServiceError('Document not found.', 404);

    let sourceFilePath = null;
    let stagedFilePath = null;
    let stagedFile = false;

    try {
      const result = await runTransaction(async (transaction) => {
        const actor = await requireActor(transaction, actorInput, STAFF_ROLES);
        const documentResult = await transaction.request()
          .input('documentId', sql.Int, documentId)
          .query(`SELECT d.id, d.student_id, d.document_type, d.is_legacy_archive, d.stored_filename
            FROM documents AS d
            WHERE d.id = @documentId FOR UPDATE`);
        const document = documentResult.recordset?.[0];
        if (!document) throw new DocumentServiceError('Document not found.', 404);
        const activeReportCard = document.document_type === 'report_card'
          && document.is_legacy_archive !== true && document.is_legacy_archive !== 1;
        if (!['good_moral', 'psa_birth_certificate'].includes(document.document_type) && !activeReportCard) {
          throw new DocumentServiceError('Only active Good Moral, PSA, or report-card submissions can be permanently deleted.', 409);
        }

        const childResult = await transaction.request()
          .input('documentId', sql.Int, documentId)
          .query(`SELECT id FROM documents
            WHERE supersedes_document_id = @documentId LIMIT 1 FOR UPDATE`);
        if (childResult.recordset?.length) {
          throw new DocumentServiceError('Delete the latest corrected submission before deleting this earlier version.', 409);
        }

        await ensurePrivateStorageRoot();
        sourceFilePath = resolveStoredPath(document.stored_filename);
        stagedFilePath = path.join(storageRoot, `.deleting-${crypto.randomUUID()}`);
        try {
          await fileSystem.rename(sourceFilePath, stagedFilePath);
          stagedFile = true;
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw new DocumentServiceError('The stored file could not be safely prepared for deletion.', 503);
          }
        }

        for (const table of ['document_validations', 'document_review_events', 'document_decision_events']) {
          await transaction.request()
            .input('documentId', sql.Int, documentId)
            .query(`DELETE FROM ${table} WHERE document_id = @documentId`);
        }
        await writeAudit(transaction, {
          actor,
          action: 'deleted',
          documentId,
          studentId: document.student_id,
          documentType: document.document_type
        });
        const deleteResult = await transaction.request()
          .input('documentId', sql.Int, documentId)
          .query('DELETE FROM documents WHERE id = @documentId');
        if (!deleteResult.affectedRows) {
          throw new DocumentServiceError('The submission changed before it could be deleted.', 409);
        }
        return { id: documentId };
      });

      if (stagedFile) {
        try {
          await fileSystem.unlink(stagedFilePath);
          stagedFile = false;
        } catch {
          logger.error('Deleted document file cleanup failed.');
          return { ...result, fileDeleted: false };
        }
      }
      return { ...result, fileDeleted: true };
    } catch (error) {
      if (stagedFile) {
        try {
          await fileSystem.rename(stagedFilePath, sourceFilePath);
          stagedFile = false;
        } catch {
          logger.error('Document file restoration after failed deletion failed.');
          throw new DocumentServiceError('The submission could not be deleted safely. Contact a database administrator.', 503);
        }
      }
      throw error;
    }
  }

  async function recordForm137Status(actorInput, studentInput, statusInput, instructionInput = '') {
    const studentId = normalizeId(studentInput);
    if (!studentId) throw new DocumentServiceError('Student record not found.', 404);
    const status = FORM137_STATUSES.has(statusInput) ? statusInput : null;
    if (!status) throw new DocumentServiceError('Choose a valid Form 137 status.');
    const instruction = typeof instructionInput === 'string' ? instructionInput.trim() : '';
    if (instruction.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instruction)) {
      throw new DocumentServiceError('Enter a status instruction up to 1000 characters.');
    }
    if (status === 'correction' && !instruction) {
      throw new DocumentServiceError('Enter an instruction when requesting a Form 137 correction.');
    }

    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction, actorInput, new Set(STAFF_ROLES));
      const studentResult = await transaction.request()
        .input('studentId', sql.Int, studentId)
        .query('SELECT id FROM students WHERE id = @studentId FOR UPDATE');
      if (!studentResult.recordset?.length) throw new DocumentServiceError('Student record not found.', 404);
      await transaction.request()
        .input('studentId', sql.Int, studentId)
        .input('recorderId', sql.Int, actor.id)
        .input('status', sql.NVarChar(30), status)
        .input('instruction', sql.NVarChar(1000), instruction || null)
        .query(`INSERT INTO form137_status_events (student_id, recorded_by, status, instruction)
          VALUES (@studentId, @recorderId, @status, @instruction)`);
      await transaction.request()
        .input('actorId', sql.Int, actor.id)
        .input('action', sql.NVarChar(100), `${actor.role}.form137_status_recorded`)
        .input('entityId', sql.NVarChar(100), String(studentId))
        .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify({ status }))
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@actorId, @action, 'form137_status', @entityId, @detailsJson)`);
      return { studentId, status };
    });
  }

  async function recordPreviousSchoolReportCardPhysicalStatus(actorInput, studentInput, statusInput, instructionInput = '') {
    const studentId = normalizeId(studentInput);
    if (!studentId) throw new DocumentServiceError('Student record not found.', 404);
    const status = PREVIOUS_SCHOOL_REPORT_CARD_PHYSICAL_STATUSES.has(statusInput) ? statusInput : null;
    if (!status) throw new DocumentServiceError('Choose a valid previous-school report-card paper status.');
    const instruction = typeof instructionInput === 'string' ? instructionInput.trim() : '';
    if (instruction.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instruction)) {
      throw new DocumentServiceError('Enter a status note up to 1000 characters.');
    }
    if (status === 'correction' && !instruction) {
      throw new DocumentServiceError('Enter a note when requesting a clearer or replacement paper copy.');
    }

    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction, actorInput, STAFF_ROLES);
      const studentResult = await transaction.request()
        .input('studentId', sql.Int, studentId)
        .query('SELECT id FROM students WHERE id = @studentId FOR UPDATE');
      if (!studentResult.recordset?.length) throw new DocumentServiceError('Student record not found.', 404);
      await transaction.request()
        .input('studentId', sql.Int, studentId)
        .input('recorderId', sql.Int, actor.id)
        .input('status', sql.NVarChar(30), status)
        .input('instruction', sql.NVarChar(1000), instruction || null)
        .query(`INSERT INTO previous_school_report_card_status_events (student_id, recorded_by, status, instruction)
          VALUES (@studentId, @recorderId, @status, @instruction)`);
      await transaction.request()
        .input('actorId', sql.Int, actor.id)
        .input('action', sql.NVarChar(100), `${actor.role}.previous_school_report_card_physical_status_recorded`)
        .input('entityId', sql.NVarChar(100), String(studentId))
        .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify({ status }))
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@actorId, @action, 'previous_school_report_card_physical_status', @entityId, @detailsJson)`);
      return { studentId, status };
    });
  }

  async function openDownload(actorInput, documentInput) {
    const document = await getDocument(actorInput, documentInput);
    if (!document) throw new DocumentServiceError('Document not found.', 404);
    let fileHandle;
    try {
      await ensurePrivateStorageRoot();
      const filePath = resolveStoredPath(document.stored_filename);
      const noFollow = fsConstants.O_NOFOLLOW || 0;
      fileHandle = await fileSystem.open(filePath, fsConstants.O_RDONLY | noFollow);
      const stat = await fileHandle.stat();
      if (!stat.isFile() || stat.size !== Number(document.file_size_bytes)) throw new Error('Stored file metadata mismatch.');
      return { document, fileHandle, size: stat.size };
    } catch {
      await fileHandle?.close().catch(() => {});
      throw new DocumentServiceError('The stored document is unavailable.', 404);
    }
  }

  return {
    upload,
    reupload,
    listDocuments,
    countAwaitingStaffReview,
    listPhysicalRequirements,
    getStudentDocuments,
    getOwnPreviousSchoolReportCardPhysicalStatus,
    getDocument,
    requestPrecheckRetry,
    addReviewEvent,
    decideDocument,
    deleteDocument,
    recordForm137Status,
    recordPreviousSchoolReportCardPhysicalStatus,
    openDownload
  };
}

module.exports = {
  DocumentServiceError,
  createDocumentService,
  normalizeId,
  normalizeDocumentType,
  validateUpload,
  hasSupportedSignature,
  verificationChecklistItems
};
