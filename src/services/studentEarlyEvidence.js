const { randomUUID } = require('node:crypto');
const { extractionContractFingerprint } = require('./geminiFieldExtractionService');

const EVIDENCE_LIFE_MS = 30 * 60 * 1000;
const FIELD_NAMES = Object.freeze({
  good_moral: ['studentName', 'issuingSchoolName', 'goodMoralContextEvidence', 'goodMoralLayoutEvidence'],
  psa_birth_certificate: ['studentName', 'dateOfBirthText'],
  report_card: ['studentName']
});

function boundedFields(type, fields) {
  if (!FIELD_NAMES[type] || !fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const result = {};
  for (const name of FIELD_NAMES[type]) {
    const value = fields[name];
    result[name] = typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) : '';
  }
  return result;
}

async function insertEarlyEvidence(pool, sql, { actorId, studentId, type, assignmentId, sourceDocumentId,
  digest, mimeType, fileSizeBytes, model, fields }) {
  const normalized = boundedFields(type, fields);
  const fingerprint = extractionContractFingerprint(type);
  if (!normalized || !fingerprint || !/^[a-f0-9]{64}$/.test(digest || '') || !model) return null;
  const id = randomUUID();
  await pool.request()
    .input('id', sql.Char(36), id)
    .input('actorId', sql.Int, actorId)
    .input('studentId', sql.Int, studentId)
    .input('type', sql.NVarChar(60), type)
    .input('assignmentId', sql.Int, assignmentId)
    .input('sourceDocumentId', sql.Int, sourceDocumentId)
    .input('digest', sql.Char(64), digest)
    .input('mimeType', sql.NVarChar(100), mimeType)
    .input('fileSizeBytes', sql.BigInt, fileSizeBytes)
    .input('model', sql.NVarChar(100), model)
    .input('fingerprint', sql.Char(64), fingerprint)
    .input('fieldsJson', sql.NVarChar(sql.MAX), JSON.stringify(normalized))
    .input('lifeMs', sql.Int, EVIDENCE_LIFE_MS)
    .query(`INSERT INTO student_document_early_evidence
      (id, actor_id, student_id, document_type, requirement_assignment_id, source_document_id,
       file_sha256, mime_type, file_size_bytes, provider, model, schema_fingerprint, fields_json, expires_at)
      VALUES (@id, @actorId, @studentId, @type, @assignmentId, @sourceDocumentId,
        @digest, @mimeType, @fileSizeBytes, 'google_gemini', @model, @fingerprint, @fieldsJson,
        TIMESTAMPADD(MICROSECOND, @lifeMs * 1000, UTC_TIMESTAMP(3)))`);
  return id;
}

async function bindEarlyEvidence(transaction, sql, { evidenceId, actorId, studentId, documentId, type,
  assignmentId, sourceDocumentId, digest, mimeType, fileSizeBytes, model }) {
  if (!/^[a-f0-9-]{36}$/i.test(evidenceId || '')) return false;
  const fingerprint = extractionContractFingerprint(type);
  if (!fingerprint) return false;
  const updated = await transaction.request()
    .input('evidenceId', sql.Char(36), evidenceId)
    .input('actorId', sql.Int, actorId)
    .input('studentId', sql.Int, studentId)
    .input('documentId', sql.Int, documentId)
    .input('type', sql.NVarChar(60), type)
    .input('assignmentId', sql.Int, assignmentId)
    .input('sourceDocumentId', sql.Int, sourceDocumentId)
    .input('digest', sql.Char(64), digest)
    .input('mimeType', sql.NVarChar(100), mimeType)
    .input('fileSizeBytes', sql.BigInt, fileSizeBytes)
    .input('model', sql.NVarChar(100), model)
    .input('fingerprint', sql.Char(64), fingerprint)
    .query(`UPDATE student_document_early_evidence
      SET consumed_document_id = @documentId, consumed_at = UTC_TIMESTAMP(3)
      WHERE id = @evidenceId AND actor_id = @actorId AND student_id = @studentId
        AND document_type = @type AND requirement_assignment_id <=> @assignmentId
        AND source_document_id <=> @sourceDocumentId AND file_sha256 = @digest
        AND mime_type = @mimeType AND file_size_bytes = @fileSizeBytes
        AND provider = 'google_gemini' AND model = @model AND schema_fingerprint = @fingerprint
        AND expires_at > UTC_TIMESTAMP(3) AND consumed_document_id IS NULL`);
  return updated.rowsAffected?.[0] === 1;
}

async function loadEarlyEvidence(pool, sql, { document, digest, fileSizeBytes, model }) {
  const fingerprint = extractionContractFingerprint(document.document_type);
  if (!fingerprint || !/^[a-f0-9]{64}$/.test(digest || '')) return null;
  const result = await pool.request()
    .input('documentId', sql.Int, document.id)
    .input('digest', sql.Char(64), digest)
    .input('fileSizeBytes', sql.BigInt, fileSizeBytes)
    .input('model', sql.NVarChar(100), model)
    .input('fingerprint', sql.Char(64), fingerprint)
    .query(`SELECT evidence.id, evidence.fields_json
      FROM student_document_early_evidence AS evidence
      INNER JOIN documents AS d ON d.id = evidence.consumed_document_id
      WHERE d.id = @documentId AND d.file_size_bytes = @fileSizeBytes
        AND evidence.file_sha256 = @digest AND evidence.file_size_bytes = @fileSizeBytes
        AND evidence.actor_id = d.uploaded_by AND evidence.student_id = d.student_id
        AND evidence.document_type = d.document_type AND evidence.requirement_assignment_id <=> d.requirement_assignment_id
        AND evidence.source_document_id <=> d.supersedes_document_id AND evidence.mime_type = d.mime_type
        AND evidence.provider = 'google_gemini' AND evidence.model = @model
        AND evidence.schema_fingerprint = @fingerprint AND evidence.expires_at > UTC_TIMESTAMP(3)
      LIMIT 1`);
  const row = result.recordset?.[0];
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.fields_json);
    const fields = boundedFields(document.document_type, parsed);
    return fields ? { id: row.id, fields, provider: 'google_gemini', model,
      schemaFingerprint: fingerprint } : null;
  } catch { return null; }
}

async function deleteEvidenceForDocument(transaction, sql, documentId) {
  await transaction.request().input('documentId', sql.Int, documentId)
    .query('DELETE FROM student_document_early_evidence WHERE consumed_document_id = @documentId');
}

async function cleanupExpiredEvidence(pool) {
  await pool.request().query('DELETE FROM student_document_early_evidence WHERE expires_at < UTC_TIMESTAMP(3) LIMIT 100');
}

module.exports = { EVIDENCE_LIFE_MS, boundedFields, insertEarlyEvidence, bindEarlyEvidence,
  loadEarlyEvidence, deleteEvidenceForDocument, cleanupExpiredEvidence };
