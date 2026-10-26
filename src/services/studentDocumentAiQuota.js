const { extractionContractFingerprint } = require('./geminiFieldExtractionService');
const { boundedFields } = require('./studentEarlyEvidence');

const WINDOW_SECONDS = 3600;
const ATTEMPT_RETENTION_HOURS = 24;

function requirementKey(type, assignmentId) {
  return `${type}:${assignmentId || 0}`;
}

async function findReusableEvidence(pool, sql, { actorId, studentId, type, assignmentId, sourceDocumentId,
  digest, mimeType, fileSizeBytes, model }) {
  const fingerprint = extractionContractFingerprint(type);
  if (!fingerprint || !model) return null;
  const result = await pool.request()
    .input('actorId', sql.Int, actorId).input('studentId', sql.Int, studentId)
    .input('type', sql.NVarChar(60), type).input('assignmentId', sql.Int, assignmentId)
    .input('sourceDocumentId', sql.Int, sourceDocumentId).input('digest', sql.Char(64), digest)
    .input('mimeType', sql.NVarChar(100), mimeType).input('fileSizeBytes', sql.BigInt, fileSizeBytes)
    .input('model', sql.NVarChar(100), model).input('fingerprint', sql.Char(64), fingerprint)
    .query(`SELECT id, fields_json FROM student_document_early_evidence
      WHERE actor_id = @actorId AND student_id = @studentId AND document_type = @type
        AND requirement_assignment_id <=> @assignmentId AND source_document_id <=> @sourceDocumentId
        AND file_sha256 = @digest AND mime_type = @mimeType AND file_size_bytes = @fileSizeBytes
        AND provider = 'google_gemini' AND model = @model AND schema_fingerprint = @fingerprint
        AND consumed_document_id IS NULL AND expires_at > UTC_TIMESTAMP(3)
      ORDER BY created_at DESC LIMIT 1`);
  const row = result.recordset?.[0];
  if (!row) return null;
  try {
    const fields = boundedFields(type, JSON.parse(row.fields_json));
    return fields ? { id: row.id, fields } : null;
  } catch { return null; }
}

async function reserveAiCheckOnce(pool, sql, { actorId, type, assignmentId, sourceDocumentId, digest,
  correctionRequested = false, maxChecksPerHour = 3, cooldownSeconds = 30,
  transactionFactory = (database) => new sql.Transaction(database) }) {
  const key = requirementKey(type, assignmentId);
  const transaction = transactionFactory(pool);
  let started = false;
  try {
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    started = true;
    await transaction.request().input('actorId', sql.Int, actorId).input('key', sql.NVarChar(100), key)
      .query('INSERT IGNORE INTO student_document_ai_rate_scopes (actor_id, requirement_key) VALUES (@actorId, @key)');
    await transaction.request().input('actorId', sql.Int, actorId).input('key', sql.NVarChar(100), key)
      .query('SELECT actor_id FROM student_document_ai_rate_scopes WHERE actor_id = @actorId AND requirement_key = @key FOR UPDATE');
    const history = await transaction.request().input('actorId', sql.Int, actorId).input('key', sql.NVarChar(100), key)
      .query(`SELECT correction_bonus, file_sha256, finished_at,
          TIMESTAMPDIFF(SECOND, started_at, UTC_TIMESTAMP(3)) AS age_seconds
        FROM student_document_ai_attempts WHERE actor_id = @actorId AND requirement_key = @key
          AND started_at > TIMESTAMPADD(SECOND, -3600, UTC_TIMESTAMP(3)) ORDER BY started_at DESC`);
    const rows = history.recordset || [];
    const pendingDuplicate = rows.find((row) => row.file_sha256 === digest && row.finished_at == null
      && Number(row.age_seconds) < 120);
    if (pendingDuplicate) {
      await transaction.commit(); started = false;
      return { allowed: false, retryAfterSeconds: Math.max(1, 120 - Number(pendingDuplicate.age_seconds)),
        reason: 'in_progress' };
    }
    const latestAge = Number(rows[0]?.age_seconds);
    if (rows.length && latestAge < cooldownSeconds) {
      await transaction.commit(); started = false;
      return { allowed: false, retryAfterSeconds: Math.max(1, cooldownSeconds - latestAge), reason: 'cooldown' };
    }
    const base = rows.filter((row) => Number(row.correction_bonus) === 0);
    let correctionBonus = false;
    if (base.length >= maxChecksPerHour) {
      if (correctionRequested && sourceDocumentId) {
        const used = await transaction.request().input('actorId', sql.Int, actorId)
          .input('sourceDocumentId', sql.Int, sourceDocumentId)
          .query(`SELECT actor_id FROM student_document_ai_correction_uses
            WHERE actor_id = @actorId AND source_document_id = @sourceDocumentId LIMIT 1`);
        correctionBonus = !used.recordset?.length;
      }
      if (!correctionBonus) {
        const oldestAge = Math.max(...base.map((row) => Number(row.age_seconds)));
        await transaction.commit(); started = false;
        return { allowed: false, retryAfterSeconds: Math.max(1, WINDOW_SECONDS - oldestAge), reason: 'hourly_limit' };
      }
      await transaction.request().input('actorId', sql.Int, actorId)
        .input('sourceDocumentId', sql.Int, sourceDocumentId)
        .query(`INSERT INTO student_document_ai_correction_uses (actor_id, source_document_id)
          VALUES (@actorId, @sourceDocumentId)`);
    }
    const inserted = await transaction.request().input('actorId', sql.Int, actorId).input('key', sql.NVarChar(100), key)
      .input('sourceDocumentId', sql.Int, sourceDocumentId).input('digest', sql.Char(64), digest)
      .input('bonus', sql.Bit, correctionBonus ? 1 : 0)
      .query(`INSERT INTO student_document_ai_attempts
        (actor_id, requirement_key, source_document_id, file_sha256, correction_bonus)
        VALUES (@actorId, @key, @sourceDocumentId, @digest, @bonus)`);
    await transaction.commit(); started = false;
    return { allowed: true, correctionBonus, attemptId: inserted.insertId };
  } catch (error) {
    if (started) await transaction.rollback().catch(() => {});
    throw error;
  }
}

async function reserveAiCheck(pool, sql, options) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await reserveAiCheckOnce(pool, sql, options); }
    catch (error) {
      if (error?.code !== 'ER_LOCK_DEADLOCK' || attempt === 2) throw error;
      // A deadlocked transaction was rolled back, so no quota row or provider call was committed.
    }
  }
  throw new Error('Could not reserve an AI check.');
}

async function finishAiCheck(pool, sql, attemptId) {
  await pool.request().input('attemptId', sql.BigInt, attemptId)
    .query(`UPDATE student_document_ai_attempts SET finished_at = UTC_TIMESTAMP(3)
      WHERE id = @attemptId AND finished_at IS NULL`);
}

async function cleanupOldAiAttempts(pool) {
  await pool.request().query(`DELETE FROM student_document_ai_attempts
    WHERE started_at < TIMESTAMPADD(HOUR, -${ATTEMPT_RETENTION_HOURS}, UTC_TIMESTAMP(3)) LIMIT 100`);
}

module.exports = { findReusableEvidence, reserveAiCheck, finishAiCheck, cleanupOldAiAttempts, requirementKey };
