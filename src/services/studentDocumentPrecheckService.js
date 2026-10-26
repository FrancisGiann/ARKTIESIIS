const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { DocumentServiceError, normalizeDocumentType, normalizeId, validateUpload } = require('./documentService');
const { createGeminiFieldExtractionService } = require('./geminiFieldExtractionService');
const { linkedStudentFieldNameFound, evaluateGoodMoralFields } = require('./documentValidationService');
const { insertEarlyEvidence, cleanupExpiredEvidence } = require('./studentEarlyEvidence');
const { findReusableEvidence, reserveAiCheck, finishAiCheck, cleanupOldAiAttempts } = require('./studentDocumentAiQuota');

const LIFE_MS = 5 * 60 * 1000;
const MAX_CACHED = 200;

function createStudentDocumentPrecheckService({ getPool, sql, secret, maxUploadBytes, geminiConfig = {}, enabled = false, getDocument,
  extractor, now = () => Date.now(), maxChecksPerHour = 3, cooldownSeconds = 30,
  findReusable = findReusableEvidence, reserveCheck = reserveAiCheck, finishCheck = finishAiCheck } = {}) {
  if (typeof getPool !== 'function') throw new TypeError('A database pool is required.');
  if (typeof secret !== 'string' || secret.length < 16) throw new TypeError('A signing secret is required.');
  const engine = extractor || createGeminiFieldExtractionService({
    apiKey: geminiConfig.apiKey, model: geminiConfig.model, timeoutMs: geminiConfig.timeoutMs, maxFileBytes: maxUploadBytes
  });
  const cache = new Map();
  const inFlight = new Map();
  let active = 0;
  if (enabled) {
    const cleanupTimer = setInterval(() => {
      Promise.resolve().then(getPool).then(async (pool) => {
        await cleanupExpiredEvidence(pool);
        await cleanupOldAiAttempts(pool);
      }).catch(() => {});
    }, 5 * 60 * 1000);
    cleanupTimer.unref?.();
  }

  function signature(payload) {
    return createHmac('sha256', secret).update(`student-document-precheck:v1:${payload}`).digest('base64url');
  }

  function tokenFor(actorId, type, assignmentId, documentId, digest, expires, evidenceId = null) {
    const payload = Buffer.from(JSON.stringify([actorId, type, assignmentId, documentId, digest, expires, evidenceId])).toString('base64url');
    return `${payload}.${signature(payload)}`;
  }

  function matchesToken(token, actorId, type, assignmentId, file, documentId = null) {
    if (typeof token !== 'string' || token.length > 1000 || !Buffer.isBuffer(file?.buffer)) return false;
    const [payload, mac, extra] = token.split('.');
    if (!payload || !mac || extra !== undefined) return false;
    const expected = signature(payload);
    if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
    try {
      const [boundActor, boundType, boundAssignment, boundDocument, boundDigest, expires] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return boundActor === actorId && boundType === type && boundAssignment === assignmentId && boundDocument === documentId
        && boundDigest === createHash('sha256').update(file.buffer).digest('hex')
        && Number.isSafeInteger(expires) && expires > now();
    } catch { return false; }
  }

  function evidenceIdFor(token, actorId, type, assignmentId, file, documentId = null) {
    if (!matchesToken(token, actorId, type, assignmentId, file, documentId)) return null;
    try {
      const [, , , , , , evidenceId] = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      return typeof evidenceId === 'string' && /^[a-f0-9-]{36}$/i.test(evidenceId) ? evidenceId : null;
    } catch { return null; }
  }

  function warningsFor(type, fields, student) {
    const warnings = [];
    const name = fields.studentName;
    if (!name) warnings.push('The student name was not clearly identified. Check that the image is readable and shows the correct document.');
    else if (!linkedStudentFieldNameFound(name, student)) warnings.push('The visible name may differ from your student record. Check the file before submitting.');
    if (type === 'good_moral' && !evaluateGoodMoralFields(fields).eligible) {
      warnings.push('The Good Moral certificate details were not clear enough to precheck. Check the document type and image.');
    }
    return warnings;
  }

  async function check(actorInput, typeInput, assignmentInput, file, documentInput = null) {
    const actorId = normalizeId(actorInput);
    const type = normalizeDocumentType(typeInput);
    const assignmentId = assignmentInput == null || assignmentInput === '' ? null : normalizeId(assignmentInput);
    const documentId = documentInput == null || documentInput === '' ? null : normalizeId(documentInput);
    if (!actorId || !type || type === 'form_137' || (type.startsWith('custom_') !== Boolean(assignmentId))) {
      throw new DocumentServiceError('This document cannot be checked from this account.', 403);
    }
    const metadata = validateUpload(file, maxUploadBytes);
    const pool = await getPool();
    const result = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT s.id, s.status, s.first_name, s.last_name FROM students AS s
        INNER JOIN users AS u ON u.id = s.user_id
        WHERE u.id = @actorId AND u.role = 'student' AND u.is_active = 1 LIMIT 1`);
    const student = result.recordset?.[0];
    if (!student || student.status === 'archived') throw new DocumentServiceError('Student document access is unavailable.', 403);
    if (documentInput && !documentId) throw new DocumentServiceError('Document not found.', 404);
    let correctionRequested = false;
    if (documentId) {
      const previous = typeof getDocument === 'function' ? await getDocument(actorId, documentId) : null;
      if (!previous || previous.student_user_id !== actorId || previous.upload_source !== 'student'
        || previous.document_type !== type || (previous.requirement_assignment_id || null) !== assignmentId) {
        throw new DocumentServiceError('Document not found.', 404);
      }
      correctionRequested = previous.decisions?.[0]
        ? previous.decisions[0].decision_type === 'correction_requested'
        : previous.reviewEvents?.[0]?.action_type === 'correction_requested';
      const hasNewer = previous.history?.some((version) => Number(version.supersedes_document_id) === documentId);
      if (previous.isArchivedReportCard || hasNewer || (type === 'report_card' && !correctionRequested)
        || (type.startsWith('custom_') && !correctionRequested)) {
        throw new DocumentServiceError('This submission cannot be replaced from the current version.', 409);
      }
    }
    if (assignmentId) {
      const assigned = await pool.request().input('assignmentId', sql.Int, assignmentId)
        .input('studentId', sql.Int, student.id).input('type', sql.NVarChar(60), type)
        .query(`SELECT id FROM requirement_assignments WHERE id = @assignmentId AND student_id = @studentId
          AND requirement_code = @type AND status = 'active' AND channel_snapshot IN ('digital','both') LIMIT 1`);
      if (!assigned.recordset?.length) throw new DocumentServiceError('This requirement is not assigned to your account.', 404);
    }
    const digest = createHash('sha256').update(file.buffer).digest('hex');
    const key = `${actorId}:${type}:${assignmentId || ''}:${documentId || ''}:${digest}`;
    for (const [oldKey, entry] of cache) if (entry.expires <= now()) cache.delete(oldKey);
    let entry = cache.get(key);
    if (!entry && inFlight.has(key)) {
      await inFlight.get(key);
      entry = cache.get(key);
    }
    if (!entry) {
      const needsProvider = enabled && !type.startsWith('custom_') && (Boolean(extractor) || Boolean(geminiConfig.apiKey && geminiConfig.model));
      if (needsProvider) {
        if (active >= 2) throw new DocumentServiceError('The document check is busy. You may submit for staff review.', 429);
      }
      let finishInFlight;
      if (needsProvider) inFlight.set(key, new Promise((resolve) => { finishInFlight = resolve; }));
      active += 1;
      try {
        let status = needsProvider ? 'unavailable' : 'format_checked';
        let warnings = [];
        let evidenceId = null;
        let retryAfterSeconds = null;
        if (needsProvider) {
          try {
            const reusable = geminiConfig.model ? await findReusable(pool, sql, {
              actorId, studentId: student.id, type, assignmentId, sourceDocumentId: documentId,
              digest, mimeType: metadata.mimeType, fileSizeBytes: metadata.fileSizeBytes, model: geminiConfig.model
            }) : null;
            if (reusable) {
              status = 'checked';
              evidenceId = reusable.id;
              warnings = warningsFor(type, reusable.fields, student);
            } else {
              const reservation = await reserveCheck(pool, sql, { actorId, type, assignmentId,
                sourceDocumentId: documentId, correctionRequested, digest, maxChecksPerHour, cooldownSeconds });
              if (!reservation.allowed) {
                status = 'limited';
                retryAfterSeconds = reservation.retryAfterSeconds;
              } else {
                let extracted;
                try {
                  extracted = await engine.extractDocument({ buffer: file.buffer, mimeType: metadata.mimeType, documentType: type });
                } catch { extracted = { status: 'unavailable' }; }
                if (extracted?.status === 'extracted' && extracted.fields) {
                  status = 'checked';
                  warnings = warningsFor(type, extracted.fields, student);
                }
                if (status === 'checked' && geminiConfig.model) {
                  try {
                    evidenceId = await insertEarlyEvidence(pool, sql, {
                      actorId, studentId: student.id, type, assignmentId, sourceDocumentId: documentId,
                      digest, mimeType: metadata.mimeType, fileSizeBytes: metadata.fileSizeBytes,
                      model: geminiConfig.model, fields: extracted.fields
                    });
                  } catch {
                    status = 'unavailable';
                    warnings = [];
                  }
                }
                await finishCheck(pool, sql, reservation.attemptId).catch(() => {});
              }
            }
          } catch {
            // Quota storage or reusable-evidence lookup failure must not start an unmetered provider call.
            status = 'unavailable';
            warnings = [];
          }
        }
        entry = { status, warnings, evidenceId, retryAfterSeconds,
          expires: now() + (status === 'limited' ? Math.min((retryAfterSeconds || 30) * 1000, 30000) : LIFE_MS),
          tokenExpires: now() + LIFE_MS };
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
        cache.set(key, entry);
      } finally {
        active -= 1;
        finishInFlight?.();
        inFlight.delete(key);
      }
    }
    return {
      status: entry.status,
      warnings: entry.warnings,
      message: entry.status === 'limited'
        ? `The next AI check is available in about ${Math.ceil((entry.retryAfterSeconds || 30) / 60)} minute(s). You can submit this document for manual staff review now.`
        : entry.status === 'unavailable'
        ? 'The early AI check is unavailable. You may still submit this file for staff review.'
        : entry.status === 'format_checked'
          ? 'The PDF, JPEG, or PNG format is accepted. No early AI field check ran; staff review is still required.'
        : entry.warnings.length ? 'These are suggestions, not a rejection. Staff will make the final decision.'
          : 'No issue was identified by this limited check. Staff review is still required.',
      token: tokenFor(actorId, type, assignmentId, documentId, digest, entry.tokenExpires || entry.expires, entry.evidenceId)
    };
  }

  return { check, matchesToken, evidenceIdFor };
}

module.exports = { createStudentDocumentPrecheckService };
