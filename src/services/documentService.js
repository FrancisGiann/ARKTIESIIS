const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants: fsConstants } = require('node:fs');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

const ID_PATTERN = /^\d{1,10}$/;
const STAFF_ROLES = new Set(['registrar', 'database_admin']);
const STUDENT_UPLOAD_DOCUMENT_TYPES = new Set(['good_moral', 'psa_birth_certificate']);
const UPLOAD_DOCUMENT_TYPES = new Set(['good_moral', 'psa_birth_certificate']);
const FORM137_STATUSES = new Set(['pending', 'received', 'verified', 'correction', 'rejected']);
const MIME_BY_EXTENSION = new Map([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png']
]);
const STORED_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$/i;
const OCR_MESSAGES = new Map([
  ['extracted', 'OCR text was extracted. Advisory checks are available; registrar or database administrator source inspection is required.'],
  ['empty_ocr', 'No readable text was extracted. Staff review is required.'],
  ['malformed_response', 'The local OCR tools returned an unreadable result. Staff review is required.'],
  ['processor_unavailable', 'A local OCR utility is unavailable. Staff review is required.'],
  ['processor_timeout', 'OCR processing timed out. Staff review is required.'],
  ['malformed_document', 'The file could not be read by the local OCR tools. Submit an unprotected, readable file.'],
  ['page_limit', 'The PDF exceeds the configured page limit. Submit a shorter PDF.'],
  ['output_limit', 'The extracted text exceeded the supported size. Staff review is required.'],
  ['processing_recovered', 'OCR processing did not finish within the recovery window. Staff review is required.'],
  ['stored_file_unavailable', 'The stored file could not be read. Staff review is required.'],
  ['processor_error', 'The local OCR tools could not process this file. Staff review is required.']
]);
const ADVISORY_KEYS_BY_TYPE = new Map([
  ['good_moral', ['linked_student_name', 'possible_school_name']],
  ['psa_birth_certificate', ['linked_student_name']]
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
const VERIFICATION_CHECKLIST_VERSION = 1;
const VERIFICATION_CHECKLIST_ITEMS_V1 = new Map([
  ['good_moral', [LINKED_STUDENT_NAME_ITEM_V1, SCHOOL_NAME_ITEM_V1, DOCUMENT_TYPE_ITEM_V1, ALL_PAGES_ITEM_V1]],
  ['psa_birth_certificate', [LINKED_STUDENT_NAME_ITEM_V1, DOCUMENT_TYPE_ITEM_V1, ALL_PAGES_ITEM_V1]]
]);
const VERIFICATION_CHECKLIST_ITEMS_BY_VERSION = new Map([
  [VERIFICATION_CHECKLIST_VERSION, VERIFICATION_CHECKLIST_ITEMS_V1]
]);

function verificationChecklistItems(documentType) {
  return VERIFICATION_CHECKLIST_ITEMS_V1.get(documentType) || [];
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

function completeAdvisoryChecks(documentType, checks) {
  const expectedKeys = ADVISORY_KEYS_BY_TYPE.get(documentType);
  if (!expectedKeys || !Array.isArray(checks)) return false;
  const keyedChecks = new Map(checks.map((check) => [check?.key, check]));
  return expectedKeys.every((key) => {
    const check = keyedChecks.get(key);
    if (typeof check?.found !== 'boolean') return false;
    if (key === 'linked_student_name') return true;
    if (!Array.isArray(check.candidates) || check.candidates.length > 3
      || check.candidates.some((candidate) => typeof candidate !== 'string' || candidate.length > 200)) return false;
    return !check.found || check.candidates.length > 0;
  });
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
      .query('SELECT id, role FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE id = @actorId AND is_active = 1');
    const actor = result.recordset?.[0];
    if (!actor || !allowedRoles.has(actor.role)) throw new DocumentServiceError('Your document access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function requireReadActor(pool, actorInput) {
    const actorId = normalizeId(actorInput);
    if (!actorId) throw new DocumentServiceError('Document access is required.', 403);
    const result = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query('SELECT id, role FROM dbo.users WHERE id = @actorId AND is_active = 1');
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
      .query(`INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
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
    if (documentType === 'form_137' || documentType === 'report_card') return false;
    return actor.role === 'student'
      ? STUDENT_UPLOAD_DOCUMENT_TYPES.has(documentType)
      : UPLOAD_DOCUMENT_TYPES.has(documentType);
  }

  async function insertSubmission({ actor, studentId, documentType, file, metadata, supersedesDocumentId = null, onFileSaved }) {
    const storedFilename = `${crypto.randomUUID()}${metadata.extension}`;
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
      .input('supersedesDocumentId', sql.Int, supersedesDocumentId)
      .query(`INSERT INTO dbo.documents
          (student_id, document_type, original_filename, stored_filename, mime_type,
            file_size_bytes, uploaded_by, upload_source, status, supersedes_document_id)
        OUTPUT INSERTED.id AS id
        VALUES (@studentId, @documentType, @originalFilename, @storedFilename, @mimeType,
            @fileSizeBytes, @uploadedBy, @uploadSource, 'pending', @supersedesDocumentId)`);
    const documentId = insertResult.recordset?.[0]?.id;
    if (!Number.isSafeInteger(documentId) || documentId < 1) throw new Error('Document insert returned no identifier.');
    await writeAudit(actor.transaction, {
      actor,
      action: supersedesDocumentId ? 'reuploaded' : 'uploaded',
      documentId,
      studentId,
      documentType
    });
    return { id: documentId, studentId, documentType };
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
            ? 'Report cards are a historical archive. Submit new grades through the teacher workbook review workflow.'
          : actor.role === 'student'
            ? 'Students may upload Good Moral Certificates and PSA birth certificates for their own linked record. Report cards must be submitted by staff.'
            : 'Staff may upload Good Moral Certificates and PSA birth certificates.';
        throw new DocumentServiceError(message, 403);
      }

      let studentId;
      if (actor.role === 'student') {
        const studentResult = await transaction.request()
          .input('actorId', sql.Int, actor.id)
          .query('SELECT id FROM dbo.students WITH (UPDLOCK, HOLDLOCK) WHERE user_id = @actorId');
        studentId = studentResult.recordset?.[0]?.id;
        if (!studentId) throw new DocumentServiceError('No student record is linked to this account.', 403);
      } else {
        studentId = normalizeId(values.studentId);
        if (!studentId) throw new DocumentServiceError('Choose a valid student record.');
        const studentResult = await transaction.request()
          .input('studentId', sql.Int, studentId)
          .query('SELECT id FROM dbo.students WITH (UPDLOCK, HOLDLOCK) WHERE id = @studentId');
        if (!studentResult.recordset?.length) throw new DocumentServiceError('Student record not found.', 404);
      }

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
        .query(`SELECT d.id, d.student_id, d.document_type, d.upload_source, d.status, s.user_id AS student_user_id
          FROM dbo.documents AS d WITH (UPDLOCK, HOLDLOCK)
          INNER JOIN dbo.students AS s WITH (UPDLOCK, HOLDLOCK) ON s.id = d.student_id
          WHERE d.id = @documentId`);
      const previous = previousResult.recordset?.[0];
      if (!previous) throw new DocumentServiceError('Document not found.', 404);
      if (actor.role === 'student'
        && (previous.student_user_id !== actor.id
          || (previous.document_type === 'psa_birth_certificate' && previous.upload_source !== 'student')
          || !STUDENT_UPLOAD_DOCUMENT_TYPES.has(previous.document_type))) {
        throw new DocumentServiceError('Document not found.', 404);
      }
      if (previous.document_type === 'form_137') {
        throw new DocumentServiceError('Form 137 is tracked through its physical status history; files cannot be re-uploaded.', 403);
      }
      if (previous.document_type === 'report_card') {
        throw new DocumentServiceError('Historical report cards cannot be corrected or re-uploaded.', 403);
      }

      const decisionResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query(`SELECT TOP (1) decision_type AS action_type FROM dbo.document_decision_events
          WHERE document_id = @documentId ORDER BY created_at DESC, id DESC`);
      let correctionRequested = decisionResult.recordset?.[0]?.action_type === 'correction_requested';
      if (!decisionResult.recordset?.length) {
        const legacyReviewResult = await transaction.request()
          .input('documentId', sql.Int, documentId)
          .query(`SELECT TOP (1) action_type FROM dbo.document_review_events
            WHERE document_id = @documentId ORDER BY created_at DESC, id DESC`);
        correctionRequested = legacyReviewResult.recordset?.[0]?.action_type === 'correction_requested';
      }
      if (!correctionRequested) {
        throw new DocumentServiceError('A corrected upload has not been requested for this document.', 409);
      }
      const revisionResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query('SELECT TOP (1) id FROM dbo.documents WHERE supersedes_document_id = @documentId');
      if (revisionResult.recordset?.length) throw new DocumentServiceError('A corrected upload has already been submitted for this document.', 409);

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

  async function listDocuments(actorInput, searchInput = '') {
    let searchTerm = '';
    if (searchInput !== undefined && searchInput !== null && searchInput !== '') {
      if (typeof searchInput !== 'string') throw new DocumentServiceError('Search must be 100 printable characters or fewer.');
      searchTerm = searchInput.trim();
      if (searchTerm.length > 100 || /[\u0000-\u001f\u007f]/.test(searchTerm)) {
        throw new DocumentServiceError('Search must be 100 printable characters or fewer.');
      }
    }
    const pool = await getPool();
    const actor = await requireReadActor(pool, actorInput);
    const searchPattern = searchTerm ? `%${searchTerm.replace(/[~%_[\]]/g, (character) => `~${character}`)}%` : null;
    const result = await pool.request()
      .input('actorId', sql.Int, actor.id)
      .input('searchPattern', sql.NVarChar(204), searchPattern)
      .query(`SELECT TOP (200) d.id, d.student_id, d.document_type, d.original_filename,
          d.mime_type, d.file_size_bytes, d.status, d.supersedes_document_id, d.created_at,
          s.student_no, s.first_name, s.middle_name, s.last_name,
          latest.action_type AS latest_review_action,
          CASE WHEN EXISTS (SELECT 1 FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
              OR d.document_type <> 'psa_birth_certificate' OR d.upload_source = 'student'
            THEN latest.instruction ELSE NULL END AS latest_review_instruction,
          latest.created_at AS latest_review_at, latest_decision.decision_type AS latest_decision_type
        FROM dbo.documents AS d
        INNER JOIN dbo.students AS s ON s.id = d.student_id
        OUTER APPLY (
          SELECT TOP (1) e.action_type, e.instruction, e.created_at
          FROM dbo.document_review_events AS e
          WHERE e.document_id = d.id ORDER BY e.created_at DESC, e.id DESC
        ) AS latest
        OUTER APPLY (
          SELECT TOP (1) e.decision_type
          FROM dbo.document_decision_events AS e
          WHERE e.document_id = d.id ORDER BY e.created_at DESC, e.id DESC
        ) AS latest_decision
        WHERE (
          EXISTS (SELECT 1 FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
          AND (@searchPattern IS NULL OR s.student_no LIKE @searchPattern ESCAPE N'~'
            OR s.first_name LIKE @searchPattern ESCAPE N'~' OR s.middle_name LIKE @searchPattern ESCAPE N'~'
            OR s.last_name LIKE @searchPattern ESCAPE N'~'
            OR CONCAT_WS(N' ', s.first_name, NULLIF(s.middle_name, N''), s.last_name) LIKE @searchPattern ESCAPE N'~')
        ) OR (
          EXISTS (SELECT 1 FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role = 'student')
          AND s.user_id = @actorId AND (
            d.document_type IN ('good_moral', 'psa_birth_certificate')
          )
        )
        ORDER BY d.created_at DESC, d.id DESC`);
    let form137Status = null;
    if (actor.role === 'student') {
      const statusResult = await pool.request()
        .input('actorId', sql.Int, actor.id)
        .query(`SELECT TOP (1) e.status, e.instruction, e.created_at
          FROM dbo.students AS s
          INNER JOIN dbo.form137_status_events AS e ON e.student_id = s.id
          WHERE s.user_id = @actorId
          ORDER BY e.created_at DESC, e.id DESC`);
      form137Status = statusResult.recordset?.[0] || { status: 'not_recorded', instruction: null, created_at: null };
    }
    return { documents: result.recordset || [], searchTerm, isStaff: STAFF_ROLES.has(actor.role), form137Status };
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
        FROM dbo.students AS s WHERE s.id = @studentId
          AND EXISTS (SELECT 1 FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))`);
    const student = studentResult.recordset?.[0];
    if (!student) return null;
    const [documentResult, form137StatusResult] = await Promise.all([
      pool.request()
      .input('studentId', sql.Int, studentId)
      .input('actorId', sql.Int, actor.id)
      .query(`SELECT d.id, d.student_id, d.document_type, d.original_filename,
          d.mime_type, d.file_size_bytes, d.status, d.supersedes_document_id, d.created_at,
          latest.action_type AS latest_review_action, latest.instruction AS latest_review_instruction,
          latest.created_at AS latest_review_at, latest_decision.decision_type AS latest_decision_type
        FROM dbo.documents AS d
        OUTER APPLY (
          SELECT TOP (1) e.action_type, e.instruction, e.created_at
          FROM dbo.document_review_events AS e
          WHERE e.document_id = d.id ORDER BY e.created_at DESC, e.id DESC
        ) AS latest
        OUTER APPLY (
          SELECT TOP (1) e.decision_type
          FROM dbo.document_decision_events AS e
          WHERE e.document_id = d.id ORDER BY e.created_at DESC, e.id DESC
        ) AS latest_decision
        WHERE d.student_id = @studentId
          AND EXISTS (SELECT 1 FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
        ORDER BY d.created_at DESC, d.id DESC`),
      pool.request()
        .input('studentId', sql.Int, studentId)
        .input('actorId', sql.Int, actor.id)
        .query(`SELECT e.id, e.status, e.instruction, e.created_at,
            e.recorded_by, COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(p.first_name, N' ', p.last_name))), N''), CONCAT(N'Staff ', e.recorded_by)) AS recorded_by_name
          FROM dbo.form137_status_events AS e
          LEFT JOIN dbo.staff_profiles AS p ON p.user_id = e.recorded_by
          WHERE e.student_id = @studentId
            AND EXISTS (SELECT 1 FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
          ORDER BY e.created_at DESC, e.id DESC`)
    ]);
    const form137StatusHistory = form137StatusResult.recordset || [];
    return {
      student,
      documents: documentResult.recordset || [],
      form137Status: form137StatusHistory[0] || { status: 'not_recorded', instruction: null, created_at: null },
      form137StatusHistory
    };
  }

  async function getDocument(actorInput, documentInput) {
    const documentId = normalizeId(documentInput);
    if (!documentId) return null;
    const pool = await getPool();
    const actor = await requireReadActor(pool, actorInput);
    const documentResult = await pool.request()
      .input('actorId', sql.Int, actor.id)
      .input('documentId', sql.Int, documentId)
      .query(`SELECT d.id, d.student_id, d.document_type, d.original_filename, d.stored_filename,
          d.mime_type, d.file_size_bytes, d.uploaded_by, d.upload_source, d.status,
          d.supersedes_document_id, d.created_at, s.user_id AS student_user_id,
          s.student_no, s.first_name, s.middle_name, s.last_name, u.role AS uploader_role
        FROM dbo.documents AS d
        INNER JOIN dbo.students AS s ON s.id = d.student_id
        INNER JOIN dbo.users AS u ON u.id = d.uploaded_by
        WHERE d.id = @documentId
          AND (EXISTS (SELECT 1 FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
            OR (EXISTS (SELECT 1 FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role = 'student')
              AND s.user_id = @actorId AND d.document_type IN ('good_moral', 'psa_birth_certificate')))`);
    const document = documentResult.recordset?.[0];
    if (!document) return null;

    const archivedReportCard = document.document_type === 'report_card';
    const validationPromise = STAFF_ROLES.has(actor.role) && document.document_type !== 'form_137' && !archivedReportCard
      ? pool.request()
        .input('documentId', sql.Int, documentId)
        .input('actorId', sql.Int, actor.id)
        .query(`SELECT TOP (1) id, processor, extracted_text, validation_json, result_status, created_at
          FROM dbo.document_validations
          WHERE document_id = @documentId
            AND EXISTS (SELECT 1 FROM dbo.users
              WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
          ORDER BY created_at DESC, id DESC`)
      : Promise.resolve({ recordset: [] });
    const visibleReviewer = STAFF_ROLES.has(actor.role)
      ? "COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(p.first_name, N' ', p.last_name))), N''), CONCAT(N'Staff ', e.reviewer_id))"
      : 'CAST(NULL AS NVARCHAR(201))';
    const reviewHistorySql = archivedReportCard
      ? 'SELECT CAST(NULL AS INT) AS id WHERE 1 = 0'
      : STAFF_ROLES.has(actor.role)
      ? `SELECT e.id, e.action_type, e.instruction, e.created_at,
          e.reviewer_id, COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(p.first_name, N' ', p.last_name))), N''), CONCAT(N'Staff ', e.reviewer_id)) AS reviewer_name
        FROM dbo.document_review_events AS e
        LEFT JOIN dbo.staff_profiles AS p ON p.user_id = e.reviewer_id
        WHERE e.document_id = @documentId ORDER BY e.created_at DESC, e.id DESC`
      : `SELECT e.id, e.action_type, e.instruction, e.created_at,
          CAST(NULL AS INT) AS reviewer_id, CAST(NULL AS NVARCHAR(201)) AS reviewer_name
        FROM dbo.document_review_events AS e
        WHERE e.document_id = @documentId AND e.action_type = 'correction_requested'
          AND (@documentType <> 'psa_birth_certificate' OR @uploadSource = 'student')
        ORDER BY e.created_at DESC, e.id DESC`;
    const decisionHistorySql = archivedReportCard
      ? 'SELECT CAST(NULL AS INT) AS id WHERE 1 = 0'
      : STAFF_ROLES.has(actor.role)
      ? `SELECT e.id, e.decision_type, e.reason, e.verification_checklist_json, e.created_at, ${visibleReviewer} AS reviewer_name
        FROM dbo.document_decision_events AS e
        LEFT JOIN dbo.staff_profiles AS p ON p.user_id = e.reviewer_id
        WHERE e.document_id = @documentId ORDER BY e.created_at DESC, e.id DESC`
      : `SELECT e.id, e.decision_type,
          CASE WHEN e.decision_type = 'correction_requested'
              AND (@documentType <> 'psa_birth_certificate' OR @uploadSource = 'student')
            THEN e.reason ELSE NULL END AS reason,
          CAST(NULL AS NVARCHAR(500)) AS verification_checklist_json,
          e.created_at,
          CAST(NULL AS NVARCHAR(201)) AS reviewer_name
        FROM dbo.document_decision_events AS e
        WHERE e.document_id = @documentId
        ORDER BY e.created_at DESC, e.id DESC`;
    const [historyResult, eventsResult, validationResult, decisionsResult] = await Promise.all([
      pool.request()
        .input('studentId', sql.Int, document.student_id)
        .input('documentType', sql.NVarChar(50), document.document_type)
        .input('actorId', sql.Int, actor.id)
        .query(`SELECT history_document.id, history_document.original_filename,
            history_document.status, history_document.supersedes_document_id, history_document.created_at,
            latest.action_type AS latest_review_action, latest_decision.decision_type AS latest_decision_type
          FROM dbo.documents AS history_document
          OUTER APPLY (
            SELECT TOP (1) latest_review_event.action_type
            FROM dbo.document_review_events AS latest_review_event
            WHERE latest_review_event.document_id = history_document.id
            ORDER BY latest_review_event.created_at DESC, latest_review_event.id DESC
          ) AS latest
          OUTER APPLY (
            SELECT TOP (1) latest_decision_event.decision_type
            FROM dbo.document_decision_events AS latest_decision_event
            WHERE latest_decision_event.document_id = history_document.id
            ORDER BY latest_decision_event.created_at DESC, latest_decision_event.id DESC
          ) AS latest_decision
          WHERE history_document.student_id = @studentId AND history_document.document_type = @documentType
            AND (EXISTS (SELECT 1 FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin'))
              OR EXISTS (SELECT 1 FROM dbo.students AS history_student
                WHERE history_student.id = history_document.student_id AND history_student.user_id = @actorId
                  AND EXISTS (SELECT 1 FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role = 'student')))
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
      let advisory = [];
      let hasAdvisoryData = false;
      try {
        const storedSummary = JSON.parse(validationRow.validation_json);
        outcome = storedSummary?.outcome;
        advisory = activeAdvisoryChecks(document.document_type, storedSummary?.advisoryChecks);
        hasAdvisoryData = completeAdvisoryChecks(document.document_type, advisory);
      } catch {
        // Ignore malformed stored summaries and use a fixed safe fallback.
      }
      validation = {
        id: validationRow.id,
        processor: validationRow.processor,
        extracted_text: validationRow.extracted_text,
        result_status: validationRow.result_status,
        created_at: validationRow.created_at,
        advisoryChecks: advisory,
        requiresOverrideReason: document.status === 'failed' || validationRow.result_status === 'failed'
          || !hasAdvisoryData || advisory.some((check) => check?.found === false),
        message: OCR_MESSAGES.get(outcome) || 'A processing result is available for staff review.'
      };
    }
    const decisions = (decisionsResult.recordset || []).map(({ verification_checklist_json: checklistJson, ...decision }) => ({
      ...decision,
      verificationChecklist: displayVerificationChecklist(checklistJson)
    }));
    return {
      ...document,
      history: historyResult.recordset || [],
      reviewEvents: eventsResult.recordset || [],
      decisions,
      validation,
      isArchivedReportCard: archivedReportCard,
      isStaff: STAFF_ROLES.has(actor.role)
    };
  }

  async function addReviewEvent(actorInput, documentInput, actionInput, instructionInput = '') {
    const documentId = normalizeId(documentInput);
    if (!documentId) throw new DocumentServiceError('Document not found.', 404);
    const action = ['review_requested', 'correction_requested'].includes(actionInput) ? actionInput : null;
    if (!action) throw new DocumentServiceError('Choose a valid review action.');
    const instruction = typeof instructionInput === 'string' ? instructionInput.trim() : '';
    if (action === 'correction_requested' && (!instruction || instruction.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instruction))) {
      throw new DocumentServiceError('Enter a correction instruction up to 1000 characters.');
    }
    if (action === 'review_requested' && instruction) throw new DocumentServiceError('Review handoff does not accept a student instruction.');

    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction, actorInput, new Set(STAFF_ROLES));
      const documentResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query(`SELECT id, student_id, document_type FROM dbo.documents WITH (UPDLOCK, HOLDLOCK)
          WHERE id = @documentId`);
      const document = documentResult.recordset?.[0];
      if (!document) throw new DocumentServiceError('Document not found.', 404);
      if (document.document_type === 'form_137') {
        throw new DocumentServiceError('Form 137 uses the physical status workflow.', 409);
      }
      if (document.document_type === 'report_card') {
        throw new DocumentServiceError('Historical report cards are read-only archive records.', 409);
      }
      await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('reviewerId', sql.Int, actor.id)
        .input('actionType', sql.NVarChar(40), action)
        .input('instruction', sql.NVarChar(1000), action === 'correction_requested' ? instruction : null)
        .query(`INSERT INTO dbo.document_review_events (document_id, reviewer_id, action_type, instruction)
          VALUES (@documentId, @reviewerId, @actionType, @instruction)`);
      await writeAudit(transaction, {
        actor,
        action: action === 'correction_requested' ? 'correction_requested' : 'review_handoff',
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
        .query(`SELECT d.id, d.student_id, d.document_type, d.status,
            validation.result_status, validation.validation_json
          FROM dbo.documents AS d WITH (UPDLOCK, HOLDLOCK)
          OUTER APPLY (
            SELECT TOP (1) result_status, validation_json
            FROM dbo.document_validations
            WHERE document_id = d.id
            ORDER BY created_at DESC, id DESC
          ) AS validation
          WHERE d.id = @documentId`);
      const document = documentResult.recordset?.[0];
      if (!document) throw new DocumentServiceError('Document not found.', 404);
      if (document.document_type === 'form_137') {
        throw new DocumentServiceError('Form 137 uses the physical status workflow.', 409);
      }
      if (document.document_type === 'report_card') {
        throw new DocumentServiceError('Historical report cards are read-only archive records.', 409);
      }
      if (!['needs_review', 'failed'].includes(document.status)) {
        throw new DocumentServiceError('The document must finish OCR before staff review.', 409);
      }
      if (!document.result_status) {
        throw new DocumentServiceError('An OCR result must be recorded before staff review.', 409);
      }
      const checklistJson = decision === 'verified'
        ? serializeVerificationChecklist(document.document_type, checklistInput)
        : null;

      const latestDecisionResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query(`SELECT TOP (1) decision_type FROM dbo.document_decision_events
          WHERE document_id = @documentId ORDER BY created_at DESC, id DESC`);
      const previousDecision = latestDecisionResult.recordset?.[0]?.decision_type;
      if (previousDecision === 'verified' || previousDecision === 'rejected') {
        throw new DocumentServiceError('This submission already has a final staff decision.', 409);
      }

      let advisoryChecks = [];
      let hasSummary = false;
      let hasAdvisoryChecks = false;
      try {
        const summary = JSON.parse(document.validation_json);
        hasSummary = Boolean(summary && typeof summary === 'object');
        advisoryChecks = activeAdvisoryChecks(document.document_type, summary?.advisoryChecks);
        hasAdvisoryChecks = completeAdvisoryChecks(document.document_type, advisoryChecks);
      } catch {
        // A malformed advisory summary is not allowed to bypass the source inspection decision.
      }
      const hasOcrWarning = !hasSummary
        || !hasAdvisoryChecks
        || document.status === 'failed'
        || document.result_status === 'failed'
        || advisoryChecks.some((check) => check?.found === false);
      if (decision === 'verified' && hasOcrWarning && !reason) {
        throw new DocumentServiceError('Enter a reason to verify a submission with an OCR warning or failure.');
      }

      await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('reviewerId', sql.Int, actor.id)
        .input('decisionType', sql.NVarChar(40), decision)
        .input('reason', sql.NVarChar(1000), reason || null)
        .input('verificationChecklistJson', sql.NVarChar(500), checklistJson)
        .query(`INSERT INTO dbo.document_decision_events
            (document_id, reviewer_id, decision_type, reason, verification_checklist_json)
          VALUES (@documentId, @reviewerId, @decisionType, @reason, @verificationChecklistJson)`);

      const nextStatus = decision === 'verified' ? 'valid' : decision === 'rejected' ? 'rejected' : 'needs_review';
      const updateResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('nextStatus', sql.NVarChar(30), nextStatus)
        .input('currentStatus', sql.NVarChar(30), document.status)
        .query(`UPDATE dbo.documents SET status = @nextStatus, processing_started_at = NULL
          OUTPUT INSERTED.id AS id
          WHERE id = @documentId AND status = @currentStatus AND status IN ('needs_review', 'failed')`);
      if (!updateResult.recordset?.length) {
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
        .query('SELECT id FROM dbo.students WITH (UPDLOCK, HOLDLOCK) WHERE id = @studentId');
      if (!studentResult.recordset?.length) throw new DocumentServiceError('Student record not found.', 404);
      await transaction.request()
        .input('studentId', sql.Int, studentId)
        .input('recorderId', sql.Int, actor.id)
        .input('status', sql.NVarChar(30), status)
        .input('instruction', sql.NVarChar(1000), instruction || null)
        .query(`INSERT INTO dbo.form137_status_events (student_id, recorded_by, status, instruction)
          VALUES (@studentId, @recorderId, @status, @instruction)`);
      await transaction.request()
        .input('actorId', sql.Int, actor.id)
        .input('action', sql.NVarChar(100), `${actor.role}.form137_status_recorded`)
        .input('entityId', sql.NVarChar(100), String(studentId))
        .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify({ status }))
        .query(`INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@actorId, @action, 'form137_status', @entityId, @detailsJson)`);
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
    getStudentDocuments,
    getDocument,
    addReviewEvent,
    decideDocument,
    recordForm137Status,
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
