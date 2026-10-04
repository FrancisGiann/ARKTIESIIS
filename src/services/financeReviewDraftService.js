'use strict';

const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { runSerializableTransaction } = require('./transactionRetry');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[a-f0-9]{64}$/i;
const MAX_INPUT_BYTES = 64 * 1024;
const REVIEW_MS = 20 * 60 * 1000;
const MAX_PENDING = 5;

class FinanceReviewDraftError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'FinanceReviewDraftError';
    this.status = status;
  }
}

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FinanceReviewDraftError(`${label} is invalid.`);
  return value;
}

function jsonText(value, label, maxBytes = MAX_INPUT_BYTES) {
  const normalized = JSON.stringify(jsonObject(value, label));
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new FinanceReviewDraftError(`${label} must be ${maxBytes} bytes or fewer.`);
  return normalized;
}

function parseJson(value, label) {
  try { return jsonObject(JSON.parse(String(value)), label); } catch (error) {
    if (error instanceof FinanceReviewDraftError) throw error;
    throw new FinanceReviewDraftError(`${label} could not be loaded.`, 503);
  }
}

function normalizeUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceReviewDraftError(`The ${label} is invalid.`);
  return value.toLowerCase();
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) throw new FinanceReviewDraftError('The finance review could not be verified.', 409);
  return value.toLowerCase();
}

function createFinanceReviewDraftService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool)
} = {}) {
  function transaction(callback) {
    return runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
  }

  async function requireActor(request, actorInput) {
    const actorId = Number(actorInput);
    if (!Number.isSafeInteger(actorId) || actorId < 1) throw new FinanceReviewDraftError('Finance access is required.', 403);
    const result = await request.input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin') FOR UPDATE`);
    const actor = result.recordset?.[0];
    if (!actor) throw new FinanceReviewDraftError('Your finance access is no longer active. Sign in again.', 403);
    return actor;
  }

  function normalizeReview(review) {
    const value = jsonObject(review, 'Finance review');
    return {
      fingerprint: normalizeFingerprint(value.dependencyFingerprint),
      previewJson: jsonText(value.preview || {}, 'Finance preview', 64 * 1024)
    };
  }

  async function createDraft(actorInput, sessionBindingHmac, actionType, entityContext, input, review) {
    if (typeof actionType !== 'string' || !/^[a-z][a-z0-9_.-]{1,79}$/.test(actionType)) throw new FinanceReviewDraftError('This finance action cannot be reviewed.');
    if (typeof sessionBindingHmac !== 'string' || !FINGERPRINT.test(sessionBindingHmac)) throw new FinanceReviewDraftError('The finance review session is invalid.', 403);
    const contextJson = jsonText(entityContext || {}, 'Finance action context', 8192);
    const inputJson = jsonText(input || {}, 'Finance review details');
    const normalizedReview = normalizeReview(review);
    const draftId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    return transaction(async (tx) => {
      const actor = await requireActor(tx.request(), actorInput);
      const count = await tx.request().input('ownerId', sql.Int, actor.id)
        .query(`SELECT COUNT(*) AS pending_count FROM finance_review_drafts
          WHERE owner_user_id = @ownerId AND status = 'pending' FOR UPDATE`);
      if (Number(count.recordset?.[0]?.pending_count || 0) >= MAX_PENDING) {
        throw new FinanceReviewDraftError('You have five unfinished finance reviews. Finish or discard one before starting another.', 409);
      }
      await tx.request().input('draftId', sql.Char(36), draftId)
        .input('ownerId', sql.Int, actor.id)
        .input('actionType', sql.VarChar(80), actionType)
        .input('contextJson', sql.NVarChar(sql.MAX), contextJson)
        .input('inputJson', sql.NVarChar(sql.MAX), inputJson)
        .input('previewJson', sql.NVarChar(sql.MAX), normalizedReview.previewJson)
        .input('fingerprint', sql.Char(64), normalizedReview.fingerprint)
        .input('idempotencyKey', sql.Char(36), idempotencyKey)
        .input('sessionBinding', sql.Char(64), sessionBindingHmac)
        .query(`INSERT INTO finance_review_drafts
          (id, owner_user_id, action_type, entity_context_json, input_json, preview_json,
            dependency_fingerprint, idempotency_key, session_binding_hmac, review_expires_at)
          VALUES (@draftId, @ownerId, @actionType, @contextJson, @inputJson, @previewJson,
            @fingerprint, @idempotencyKey, @sessionBinding, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 20 MINUTE))`);
      return { id: draftId, revision: 1 };
    });
  }

  async function getDraft(actorInput, draftInput) {
    const draftId = normalizeUuid(draftInput, 'draft id');
    const actorId = Number(actorInput);
    const pool = await getPool();
    const result = await pool.request().input('draftId', sql.Char(36), draftId)
      .input('actorId', sql.Int, actorId)
      .query(`SELECT draft.id, draft.owner_user_id, draft.action_type, draft.entity_context_json, draft.input_json, draft.preview_json,
          draft.dependency_fingerprint, draft.idempotency_key, draft.session_binding_hmac, draft.revision, draft.status,
          draft.review_expires_at, draft.committed_result_json, draft.created_at, draft.updated_at,
          CASE WHEN draft.review_expires_at <= UTC_TIMESTAMP(3) THEN 1 ELSE 0 END AS review_expired
        FROM finance_review_drafts AS draft
        INNER JOIN users AS owner ON owner.id = draft.owner_user_id AND owner.is_active = 1
          AND owner.role IN ('finance', 'database_admin')
        WHERE draft.id = @draftId AND draft.owner_user_id = @actorId`);
    const row = result.recordset?.[0];
    if (!row) throw new FinanceReviewDraftError('Finance review not found.', 404);
    return {
      id: row.id,
      ownerUserId: Number(row.owner_user_id),
      actionType: row.action_type,
      entityContext: parseJson(row.entity_context_json, 'Finance action context'),
      input: parseJson(row.input_json, 'Finance review details'),
      preview: parseJson(row.preview_json, 'Finance preview'),
      dependencyFingerprint: String(row.dependency_fingerprint),
      idempotencyKey: row.idempotency_key,
      sessionBindingHmac: String(row.session_binding_hmac),
      revision: Number(row.revision),
      status: row.status,
      reviewExpiresAt: row.review_expires_at,
      reviewExpired: row.review_expired === true || row.review_expired === 1 || row.review_expired === '1',
      committedResult: row.committed_result_json ? parseJson(row.committed_result_json, 'Saved finance result') : null
    };
  }

  async function listPendingDrafts(actorInput) {
    const actorId = Number(actorInput);
    if (!Number.isSafeInteger(actorId) || actorId < 1) throw new FinanceReviewDraftError('Finance access is required.', 403);
    const pool = await getPool();
    const actor = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT id FROM users WHERE id = @actorId AND is_active = 1
        AND role IN ('finance', 'database_admin')`);
    if (!actor.recordset?.length) throw new FinanceReviewDraftError('Your finance access is no longer active. Sign in again.', 403);
    const result = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT id, action_type, entity_context_json, input_json, created_at, updated_at
        FROM finance_review_drafts WHERE owner_user_id = @actorId AND status = 'pending'
        ORDER BY updated_at DESC, id LIMIT 5`);
    const rows = result.recordset || [];
    const decoded = rows.map((row) => ({ row,
      context: parseJson(row.entity_context_json, 'Finance action context'),
      input: parseJson(row.input_json, 'Finance review details')
    }));
    const studentIds = [...new Set(decoded.map(({ context }) => Number(context.studentId)).filter((id) => Number.isSafeInteger(id) && id > 0))];
    const students = new Map();
    if (studentIds.length) {
      const request = pool.request();
      const placeholders = studentIds.map((studentId, index) => {
        request.input(`studentId${index}`, sql.Int, studentId);
        return `@studentId${index}`;
      });
      const studentRows = await request.query(`SELECT id, student_no, first_name, middle_name, last_name, suffix
        FROM students WHERE id IN (${placeholders.join(', ')})`);
      for (const student of studentRows.recordset || []) students.set(Number(student.id), student);
    }
    return decoded.map(({ row, context, input }) => {
      const student = students.get(Number(context.studentId));
      const studentName = student
        ? [student.first_name, student.middle_name, student.last_name, student.suffix].filter(Boolean).join(' ')
        : '';
      const scheduleContext = row.action_type === 'schedule_create'
        ? [context.schoolYear, context.gradeLevel, context.voucherCode].filter(Boolean).join(' · ')
        : '';
      const amount = ['annual_payment', 'annual_credit_allocation', 'legacy_payment_reconciliation'].includes(row.action_type)
        && typeof input.amount === 'string' && /^\d{1,10}(?:\.\d{1,2})?$/.test(input.amount)
        ? `₱${input.amount.includes('.') ? input.amount : `${input.amount}.00`}`
        : '';
      return {
        id: row.id, actionType: row.action_type,
        studentName, studentNumber: student?.student_no || '', scheduleContext, amount,
        createdAt: row.created_at, updatedAt: row.updated_at
      };
    });
  }

  async function updateDraftInput(actorInput, draftInput, sessionBindingHmac, input, review) {
    const draftId = normalizeUuid(draftInput, 'draft id');
    if (typeof sessionBindingHmac !== 'string' || !FINGERPRINT.test(sessionBindingHmac)) throw new FinanceReviewDraftError('The finance review session is invalid.', 403);
    const inputJson = jsonText(input || {}, 'Finance review details');
    const normalizedReview = normalizeReview(review);
    return transaction(async (tx) => {
      const rowResult = await tx.request().input('draftId', sql.Char(36), draftId)
        .input('actorId', sql.Int, Number(actorInput))
        .query(`SELECT id, revision, status FROM finance_review_drafts
          WHERE id = @draftId AND owner_user_id = @actorId FOR UPDATE`);
      const row = rowResult.recordset?.[0];
      if (!row) throw new FinanceReviewDraftError('Finance review not found.', 404);
      const actor = await requireActor(tx.request(), actorInput);
      if (row.status !== 'pending') throw new FinanceReviewDraftError('A completed finance review cannot be edited.', 409);
      const revision = Number(row.revision) + 1;
      await tx.request().input('draftId', sql.Char(36), draftId)
        .input('actorId', sql.Int, actor.id)
        .input('inputJson', sql.NVarChar(sql.MAX), inputJson)
        .input('previewJson', sql.NVarChar(sql.MAX), normalizedReview.previewJson)
        .input('fingerprint', sql.Char(64), normalizedReview.fingerprint)
        .input('sessionBinding', sql.Char(64), sessionBindingHmac)
        .input('revision', sql.Int, revision)
        .query(`UPDATE finance_review_drafts SET input_json = @inputJson, preview_json = @previewJson,
            dependency_fingerprint = @fingerprint, session_binding_hmac = @sessionBinding,
            revision = @revision, review_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 20 MINUTE), updated_at = UTC_TIMESTAMP(3)
          WHERE id = @draftId AND owner_user_id = @actorId AND status = 'pending'`);
      return revision;
    });
  }

  async function refreshReview(actorInput, draftInput, sessionBindingHmac, review) {
    const draftId = normalizeUuid(draftInput, 'draft id');
    if (typeof sessionBindingHmac !== 'string' || !FINGERPRINT.test(sessionBindingHmac)) throw new FinanceReviewDraftError('The finance review session is invalid.', 403);
    const normalizedReview = normalizeReview(review);
    return transaction(async (tx) => {
      const locked = await tx.request().input('draftId', sql.Char(36), draftId)
        .input('actorId', sql.Int, Number(actorInput))
        .query(`SELECT revision, status FROM finance_review_drafts
          WHERE id = @draftId AND owner_user_id = @actorId FOR UPDATE`);
      const row = locked.recordset?.[0];
      if (!row) throw new FinanceReviewDraftError('Finance review not found.', 404);
      const actor = await requireActor(tx.request(), actorInput);
      if (row.status !== 'pending') throw new FinanceReviewDraftError('This finance review is already complete.', 409);
      const revision = Number(row.revision) + 1;
      await tx.request().input('draftId', sql.Char(36), draftId)
        .input('actorId', sql.Int, actor.id)
        .input('previewJson', sql.NVarChar(sql.MAX), normalizedReview.previewJson)
        .input('fingerprint', sql.Char(64), normalizedReview.fingerprint)
        .input('sessionBinding', sql.Char(64), sessionBindingHmac)
        .input('revision', sql.Int, revision)
        .query(`UPDATE finance_review_drafts SET preview_json = @previewJson,
            dependency_fingerprint = @fingerprint, session_binding_hmac = @sessionBinding,
            revision = @revision, review_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 20 MINUTE), updated_at = UTC_TIMESTAMP(3)
          WHERE id = @draftId AND owner_user_id = @actorId AND status = 'pending'`);
      return revision;
    });
  }

  async function commitReviewedDraft({ actorId: actorInput, draftId: draftInput, sessionBindingHmac, revision: revisionInput, review, previewInTransaction, applyInTransaction }) {
    const draftId = normalizeUuid(draftInput, 'draft id');
    const revision = Number(revisionInput);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new FinanceReviewDraftError('The finance review changed. Review it again.', 409);
    if (typeof sessionBindingHmac !== 'string' || !FINGERPRINT.test(sessionBindingHmac)) throw new FinanceReviewDraftError('The finance review session is invalid.', 403);
    if (typeof previewInTransaction !== 'function' || typeof applyInTransaction !== 'function') throw new TypeError('Review preview and commit handlers are required.');
    const submittedReview = normalizeReview(review);
    let outcome;
    await transaction(async (tx) => {
      const locked = await tx.request().input('draftId', sql.Char(36), draftId)
        .input('actorId', sql.Int, Number(actorInput))
        .query(`SELECT *, CASE WHEN review_expires_at <= UTC_TIMESTAMP(3) THEN 1 ELSE 0 END AS review_expired
          FROM finance_review_drafts
          WHERE id = @draftId AND owner_user_id = @actorId FOR UPDATE`);
      const draftRow = locked.recordset?.[0];
      if (!draftRow) throw new FinanceReviewDraftError('Finance review not found.', 404);
      const actor = await requireActor(tx.request(), actorInput);
      if (draftRow.status === 'committed') {
        outcome = { committed: true, replayed: true, result: parseJson(draftRow.committed_result_json, 'Saved finance result') };
        return;
      }
      if (draftRow.status !== 'pending') throw new FinanceReviewDraftError('This finance review was discarded.', 409);
      const draft = {
        id: draftRow.id,
        ownerUserId: Number(draftRow.owner_user_id),
        actionType: draftRow.action_type,
        entityContext: parseJson(draftRow.entity_context_json, 'Finance action context'),
        input: parseJson(draftRow.input_json, 'Finance review details'),
        idempotencyKey: draftRow.idempotency_key,
        revision: Number(draftRow.revision),
        dependencyFingerprint: String(draftRow.dependency_fingerprint),
        sessionBindingHmac: String(draftRow.session_binding_hmac),
        reviewExpiresAt: draftRow.review_expires_at
      };
      const currentReviewSource = await previewInTransaction(tx, draft);
      const currentReview = normalizeReview(currentReviewSource);
      const stale = Number(draft.revision) !== revision
        || draft.sessionBindingHmac !== sessionBindingHmac
        || draft.dependencyFingerprint !== submittedReview.fingerprint
        || currentReview.fingerprint !== draft.dependencyFingerprint
        || currentReview.fingerprint !== submittedReview.fingerprint
        || draftRow.review_expired === true || draftRow.review_expired === 1 || draftRow.review_expired === '1';
      if (stale) {
        const nextRevision = draft.revision + 1;
        const refreshedInputJson = jsonText(currentReviewSource.normalizedInput || draft.input, 'Finance review details');
        await tx.request().input('draftId', sql.Char(36), draft.id)
          .input('ownerId', sql.Int, actor.id)
          .input('inputJson', sql.NVarChar(sql.MAX), refreshedInputJson)
          .input('previewJson', sql.NVarChar(sql.MAX), currentReview.previewJson)
          .input('fingerprint', sql.Char(64), currentReview.fingerprint)
          .input('sessionBinding', sql.Char(64), sessionBindingHmac)
          .input('revision', sql.Int, nextRevision)
          .query(`UPDATE finance_review_drafts SET input_json = @inputJson, preview_json = @previewJson,
              dependency_fingerprint = @fingerprint, session_binding_hmac = @sessionBinding,
              revision = @revision, review_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 20 MINUTE), updated_at = UTC_TIMESTAMP(3)
            WHERE id = @draftId AND owner_user_id = @ownerId AND status = 'pending'`);
        outcome = { stale: true, revision: nextRevision };
        return;
      }
      const result = await applyInTransaction(tx, draft, actor);
      const resultJson = jsonText(result || { saved: true }, 'Saved finance result', 64 * 1024);
      await tx.request().input('draftId', sql.Char(36), draft.id)
        .input('ownerId', sql.Int, actor.id)
        .input('resultJson', sql.NVarChar(sql.MAX), resultJson)
        .query(`UPDATE finance_review_drafts SET status = 'committed', committed_result_json = @resultJson,
            updated_at = UTC_TIMESTAMP(3)
          WHERE id = @draftId AND owner_user_id = @ownerId AND status = 'pending'`);
      outcome = { committed: true, replayed: false, result: JSON.parse(resultJson) };
    });
    return outcome;
  }

  async function discardDraft(actorInput, draftInput) {
    const draftId = normalizeUuid(draftInput, 'draft id');
    return transaction(async (tx) => {
      const row = await tx.request().input('draftId', sql.Char(36), draftId)
        .input('actorId', sql.Int, Number(actorInput))
        .query(`SELECT status FROM finance_review_drafts
          WHERE id = @draftId AND owner_user_id = @actorId FOR UPDATE`);
      if (!row.recordset?.length) throw new FinanceReviewDraftError('Finance review not found.', 404);
      const actor = await requireActor(tx.request(), actorInput);
      if (row.recordset[0].status !== 'pending') throw new FinanceReviewDraftError('A completed finance review cannot be discarded.', 409);
      await tx.request().input('draftId', sql.Char(36), draftId)
        .input('actorId', sql.Int, actor.id)
        .query(`UPDATE finance_review_drafts SET status = 'discarded', updated_at = UTC_TIMESTAMP(3)
          WHERE id = @draftId AND owner_user_id = @actorId AND status = 'pending'`);
    });
  }

  return { createDraft, getDraft, listPendingDrafts, updateDraftInput, refreshReview, commitReviewedDraft, discardDraft };
}

module.exports = { FinanceReviewDraftError, createFinanceReviewDraftService, MAX_INPUT_BYTES, REVIEW_MS, MAX_PENDING };
