'use strict';

const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { createFinanceDebtRevisionService, formatCents, ledgerCompletenessCondition } = require('./financeDebtRevisionService');
const { runSerializableTransaction } = require('./transactionRetry');

const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const ID = /^\d{1,10}$/;
const FINANCE_ROLES = new Set(['finance', 'database_admin']);
const REGISTRAR_ROLES = new Set(['registrar', 'database_admin']);

class StudentDocumentFinanceClearanceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'StudentDocumentFinanceClearanceError';
    this.status = status;
  }
}

function normalizeId(value, label = 'student') {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !ID.test(raw)) throw new StudentDocumentFinanceClearanceError(`Choose a valid ${label}.`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new StudentDocumentFinanceClearanceError(`Choose a valid ${label}.`);
  return number;
}

function normalizeUuid(value, label = 'submission') {
  if (typeof value !== 'string' || !UUID.test(value)) throw new StudentDocumentFinanceClearanceError(`The ${label} token is invalid. Reload the form and try again.`);
  return value.toLowerCase();
}

function cleanText(value, label, maxLength, required = false, minLength = 1) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw new StudentDocumentFinanceClearanceError(`${label} must be printable text.`);
  const text = value.trim();
  if ((!text && required) || text.length > maxLength || (text && text.length < minLength)
    || /[\u0000-\u001f\u007f]/.test(text)) {
    const range = minLength > 1 ? `between ${minLength} and ${maxLength}` : `no more than ${maxLength}`;
    throw new StudentDocumentFinanceClearanceError(`${label} must be ${range} printable characters.`);
  }
  return text || null;
}

function normalizeDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new StudentDocumentFinanceClearanceError(`Enter a valid ${label.toLowerCase()}.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new StudentDocumentFinanceClearanceError(`Enter a valid ${label.toLowerCase()}.`);
  return value;
}

function fingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function numberFlag(value) {
  return value === true || value === 1 || value === '1';
}

function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
}

function clearanceStatus(latest, revision, ledgerComplete) {
  if (!latest) return 'pending';
  if (latest.event_type === 'approved') {
    return String(latest.debt_increase_revision) === String(revision) && ledgerComplete ? 'approved' : 'reapproval_required';
  }
  return latest.clearance_status;
}

function createStudentDocumentFinanceClearanceService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  debtRevisionService = createFinanceDebtRevisionService({ getPool, sql, transactionFactory })
} = {}) {
  async function runTransaction(callback) {
    return runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
  }

  async function requireActor(request, actorInput, allowedRoles) {
    const actorId = normalizeId(actorInput, 'staff user');
    const result = await request.input('actorId', sql.Int, actorId).query(`SELECT users.id, users.role,
        profile.first_name, profile.last_name
      FROM users
      LEFT JOIN staff_profiles AS profile ON profile.user_id = users.id
      WHERE users.id = @actorId AND users.is_active = 1
        AND users.role IN (${[...allowedRoles].map((role) => `'${role}'`).join(', ')})`);
    const actor = result.recordset?.[0];
    if (!actor || !allowedRoles.has(actor.role)) throw new StudentDocumentFinanceClearanceError('Your document finance access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function writeAudit(transaction, actor, action, requestId, details) {
    await transaction.request().input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), `${actor.role}.${action}`)
      .input('requestId', sql.NVarChar(100), String(requestId))
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, 'student_document_request', @requestId, @details)`);
  }

  async function locateRequestStudent(pool, requestId) {
    const result = await pool.request().input('requestId', sql.UniqueIdentifier, requestId)
      .query('SELECT student_id FROM student_document_requests WHERE id = @requestId');
    const studentId = result.recordset?.[0]?.student_id;
    if (!studentId) throw new StudentDocumentFinanceClearanceError('Document request not found.', 404);
    return Number(studentId);
  }

  async function lockRequest(transaction, requestId, studentId) {
    const result = await transaction.request().input('requestId', sql.UniqueIdentifier, requestId)
      .input('studentId', sql.Int, studentId)
      .query(`SELECT request.id, request.student_id, request.document_type, request.document_name,
          request.requested_on, request.reference_text, request.status,
          request.expected_claim_date, request.current_claim_slip_id,
          student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix
        FROM student_document_requests AS request
        INNER JOIN students AS student ON student.id = request.student_id
        WHERE request.id = @requestId AND request.student_id = @studentId FOR UPDATE`);
    const request = result.recordset?.[0];
    if (!request) throw new StudentDocumentFinanceClearanceError('Document request not found.', 404);
    return request;
  }

  async function latestClearance(transaction, requestId) {
    const result = await transaction.request().input('requestId', sql.UniqueIdentifier, requestId)
      .query(`SELECT event.id, event.event_type, event.clearance_status,
          CAST(event.debt_increase_revision AS CHAR(40)) AS debt_increase_revision,
          CAST(event.outstanding_snapshot AS CHAR(40)) AS outstanding_snapshot,
          event.reason, event.payment_arrangement, event.finance_note, event.ledger_review_confirmed,
          event.created_at, event.actor_id, profile.first_name AS actor_first_name,
          profile.last_name AS actor_last_name
        FROM student_document_clearance_events AS event
        LEFT JOIN staff_profiles AS profile ON profile.user_id = event.actor_id
        WHERE event.request_id = @requestId ORDER BY event.id DESC LIMIT 1`);
    return result.recordset?.[0] || null;
  }

  async function latestSlip(transaction, requestId) {
    const result = await transaction.request().input('requestId', sql.UniqueIdentifier, requestId)
      .query(`SELECT slip.id, slip.finance_approval_event_id, slip.event_type,
          slip.expected_claim_date, slip.previous_claim_date, slip.reason,
          slip.created_at, slip.issued_by, profile.first_name AS issuer_first_name,
          profile.last_name AS issuer_last_name
        FROM student_document_claim_slips AS slip
        LEFT JOIN staff_profiles AS profile ON profile.user_id = slip.issued_by
        WHERE slip.request_id = @requestId ORDER BY slip.id DESC LIMIT 1`);
    return result.recordset?.[0] || null;
  }

  async function currentClearanceContext(transaction, request) {
    const student = await debtRevisionService.lockStudent(transaction, Number(request.student_id));
    if (!student || student.status === 'archived') throw new StudentDocumentFinanceClearanceError('Archived student records are read-only.', 409);
    const snapshot = await debtRevisionService.readSnapshot(transaction, Number(request.student_id));
    const latest = await latestClearance(transaction, String(request.id).toLowerCase());
    return { student, snapshot, latest, status: clearanceStatus(latest, student.debtIncreaseRevision, snapshot.ledgerComplete) };
  }

  async function getRegistrarData(actorInput, studentInput) {
    const studentId = normalizeId(studentInput);
    const pool = await getPool();
    await requireActor(pool.request(), actorInput, REGISTRAR_ROLES);
    const studentResult = await pool.request().input('studentId', sql.Int, studentId)
      .query('SELECT id FROM students WHERE id = @studentId');
    if (!studentResult.recordset?.length) throw new StudentDocumentFinanceClearanceError('Student record not found.', 404);
    const requestsResult = await pool.request().input('studentId', sql.Int, studentId)
      .query(`SELECT request.id, request.status, request.current_claim_slip_id FROM student_document_requests AS request
        WHERE request.student_id = @studentId ORDER BY request.created_at DESC, request.id`);
    const eventResult = await pool.request().input('studentId', sql.Int, studentId)
      .query(`SELECT event.request_id, event.id, event.event_type, event.clearance_status,
          CAST(event.debt_increase_revision AS CHAR(40)) AS debt_increase_revision,
          event.payment_arrangement, event.created_at, profile.first_name AS actor_first_name,
          profile.last_name AS actor_last_name
        FROM student_document_clearance_events AS event
        INNER JOIN student_document_requests AS request ON request.id = event.request_id
        LEFT JOIN staff_profiles AS profile ON profile.user_id = event.actor_id
        WHERE request.student_id = @studentId ORDER BY event.id DESC`);
    const slipResult = await pool.request().input('studentId', sql.Int, studentId)
      .query(`SELECT slip.request_id, slip.id, slip.finance_approval_event_id, slip.event_type,
          slip.expected_claim_date, slip.previous_claim_date, slip.reason, slip.created_at,
          profile.first_name AS issuer_first_name, profile.last_name AS issuer_last_name
        FROM student_document_claim_slips AS slip
        INNER JOIN student_document_requests AS request ON request.id = slip.request_id
        LEFT JOIN staff_profiles AS profile ON profile.user_id = slip.issued_by
        WHERE request.student_id = @studentId ORDER BY slip.id DESC`);
    const debt = await debtRevisionService.getStudentSnapshot(studentId);
    const clearances = new Map();
    for (const event of eventResult.recordset || []) {
      const key = String(event.request_id).toLowerCase();
      if (!clearances.has(key)) clearances.set(key, []);
      clearances.get(key).push(event);
    }
    const slips = new Map();
    for (const event of slipResult.recordset || []) {
      const key = String(event.request_id).toLowerCase();
      if (!slips.has(key)) slips.set(key, []);
      slips.get(key).push(event);
    }
    const requestSummaries = (requestsResult.recordset || []).map((request) => {
      const key = String(request.id).toLowerCase();
      const history = clearances.get(key) || [];
      const latest = history[0] || null;
      const terminal = ['released', 'cancelled'].includes(request.status);
      const status = terminal
        ? latest ? latest.clearance_status : 'historical_no_clearance'
        : clearanceStatus(latest, debt?.debtIncreaseRevision, debt?.ledgerComplete === true);
      const latestSlip = (slips.get(key) || [])[0] || null;
      return {
        requestId: key,
        requestStatus: request.status,
        status,
        hasArrangement: status === 'approved' && Boolean(latest.payment_arrangement),
        actorName: status === 'approved' ? [latest.actor_first_name, latest.actor_last_name].filter(Boolean).join(' ') || 'Finance staff' : null,
        decidedAt: status === 'approved' ? latest.created_at : null,
        history: history.map((event) => ({
          eventType: event.event_type,
          status: clearanceStatus(event, debt?.debtIncreaseRevision, debt?.ledgerComplete === true),
          hasArrangement: event.event_type === 'approved' && Boolean(event.payment_arrangement),
          actorName: [event.actor_first_name, event.actor_last_name].filter(Boolean).join(' ') || 'Finance staff',
          createdAt: event.created_at
        })),
        claimSlipHistory: slips.get(key) || [],
        claimSlipCurrent: ['processing', 'ready'].includes(request.status)
          && status === 'approved' && Boolean(request.current_claim_slip_id && latestSlip)
          && Number(request.current_claim_slip_id) === Number(latestSlip.id)
          && Number(latestSlip.finance_approval_event_id) === Number(latest?.id)
      };
    });
    const financeStatus = debt?.ledgerComplete
      ? (debt.outstanding === '0.00' ? 'No outstanding balance' : 'With balance')
      : 'Needs finance review';
    return {
      financeSummary: {
        status: financeStatus,
        outstanding: debt?.ledgerComplete ? debt.outstanding : null
      },
      requests: requestSummaries
    };
  }

  async function getFinanceQueue(actorInput, filters = {}) {
    const pool = await getPool();
    await requireActor(pool.request(), actorInput, FINANCE_ROLES);
    const search = cleanText(filters.search || '', 'Search', 100) || null;
    const status = cleanText(filters.status || '', 'Status filter', 30) || null;
    const pageRaw = filters.page == null || filters.page === '' ? '1' : String(filters.page);
    if (!/^\d{1,6}$/.test(pageRaw) || Number(pageRaw) < 1) throw new StudentDocumentFinanceClearanceError('Choose a valid queue page.');
    const page = Math.min(Number(pageRaw), 100000);
    const allowedStatuses = new Set(['requested', 'processing', 'ready', 'released', 'cancelled', 'pending', 'on_hold', 'approved', 'reapproval_required', 'withdrawn']);
    if (status && !allowedStatuses.has(status)) throw new StudentDocumentFinanceClearanceError('Choose a supported queue filter.');
    const result = await pool.request().input('search', sql.NVarChar(100), search)
      .input('needle', sql.NVarChar(102), search ? `%${search}%` : null)
      .input('status', sql.NVarChar(30), status)
      .input('limit', sql.Int, 101)
      .input('offset', sql.Int, (page - 1) * 100)
      .query(`WITH latest_clearance AS (
          SELECT event.id, event.request_id, event.event_type, event.clearance_status,
            event.debt_increase_revision, event.outstanding_snapshot, event.reason,
            event.payment_arrangement, event.finance_note, event.created_at, event.actor_id,
            ROW_NUMBER() OVER (PARTITION BY event.request_id ORDER BY event.id DESC) AS event_rank
          FROM student_document_clearance_events AS event
        ), ledger AS (
          SELECT student.id AS student_id,
            CAST(COALESCE((SELECT SUM(due.amount_due)
                FROM v_finance_assessed_charge_due AS due
                INNER JOIN annual_enrollments AS annual ON annual.id = due.annual_enrollment_id
                WHERE annual.student_id = student.id), 0)
              + COALESCE((SELECT SUM(due.amount_due) FROM v_finance_opening_liability_due AS due
                WHERE due.student_id = student.id), 0)
              + COALESCE((SELECT SUM(balance.remaining_legacy_balance) FROM v_finance_legacy_account_balance AS balance
                WHERE balance.student_id = student.id), 0) AS DECIMAL(20, 2)) AS canonical_balance,
            CAST(CASE WHEN ${ledgerCompletenessCondition('student.id')}
              THEN 1 ELSE 0 END AS UNSIGNED) AS ledger_complete,
            CAST(student.debt_increase_revision AS CHAR(40)) AS current_revision
          FROM students AS student
        ), queue_rows AS (
          SELECT request.id, request.student_id, request.document_type, request.document_name,
            request.requested_on, request.created_at, request.reference_text, request.status AS request_status,
            request.expected_claim_date, student.student_no, student.first_name, student.middle_name,
            student.last_name, student.suffix, latest.id AS clearance_event_id,
            latest.event_type, latest.clearance_status AS stored_clearance_status,
            CAST(latest.debt_increase_revision AS CHAR(40)) AS approved_revision,
            CAST(latest.outstanding_snapshot AS CHAR(40)) AS approved_outstanding,
            latest.reason, latest.payment_arrangement, latest.finance_note,
            latest.created_at AS decision_at, actor_profile.first_name AS actor_first_name,
            actor_profile.last_name AS actor_last_name, ledger.ledger_complete,
            ledger.current_revision,
            CAST(CASE WHEN ledger.canonical_balance < 0 THEN 0 ELSE ledger.canonical_balance END AS CHAR(40)) AS outstanding,
            CASE WHEN latest.id IS NULL THEN 'pending'
              WHEN latest.event_type = 'approved' AND ledger.ledger_complete = 1
                AND CAST(latest.debt_increase_revision AS CHAR(40)) = ledger.current_revision THEN 'approved'
              WHEN latest.event_type = 'approved' THEN 'reapproval_required'
              ELSE latest.clearance_status END AS effective_clearance_status
          FROM student_document_requests AS request
          INNER JOIN students AS student ON student.id = request.student_id
          LEFT JOIN latest_clearance AS latest ON latest.request_id = request.id AND latest.event_rank = 1
          LEFT JOIN staff_profiles AS actor_profile ON actor_profile.user_id = latest.actor_id
          INNER JOIN ledger ON ledger.student_id = request.student_id
          WHERE (@search IS NULL OR student.student_no LIKE @needle
            OR student.first_name LIKE @needle OR student.middle_name LIKE @needle
            OR student.last_name LIKE @needle OR request.document_type LIKE @needle
            OR request.document_name LIKE @needle OR request.reference_text LIKE @needle)
        )
        SELECT * FROM queue_rows
        WHERE ((@status IS NULL AND request_status IN ('requested', 'processing', 'ready'))
          OR (@status IN ('requested', 'processing', 'ready', 'released', 'cancelled') AND request_status = @status)
          OR (@status IN ('pending', 'on_hold', 'approved', 'reapproval_required', 'withdrawn')
            AND effective_clearance_status = @status))
        ORDER BY created_at DESC, id LIMIT @limit OFFSET @offset`);
    const fetched = result.recordset || [];
    const hasNext = fetched.length > 100;
    const rows = fetched.slice(0, 100).map((row) => ({
      ...row,
      id: String(row.id).toLowerCase(),
      clearanceStatus: row.effective_clearance_status,
      ledgerComplete: numberFlag(row.ledger_complete),
      outstanding: String(row.outstanding || '0.00'),
      currentRevision: String(row.current_revision || '0')
    }));
    return { rows, hasNext, filters: { search: search || '', status: status || '', page } };
  }

  async function decideClearance(actorInput, requestInput, input = {}) {
    const requestId = typeof requestInput === 'string' && UUID.test(requestInput) ? requestInput.toLowerCase() : null;
    if (!requestId) throw new StudentDocumentFinanceClearanceError('Document request not found.', 404);
    const decision = input.decision;
    if (!['approve', 'hold', 'withdraw'].includes(decision)) throw new StudentDocumentFinanceClearanceError('Choose approve, hold, or withdraw.');
    const idempotencyKey = normalizeUuid(input.idempotencyKey, 'clearance decision');
    const reason = cleanText(input.reason, 'Finance reason', 1000, decision !== 'approve' || Boolean(input.reason), 5);
    const arrangement = cleanText(input.paymentArrangement, 'Payment arrangement', 1000,
      decision === 'approve' && Boolean(input.outstandingPositive), 5);
    const financeNote = cleanText(input.financeNote, 'Private finance note', 1000);
    const reviewed = input.ledgerReviewConfirmed === true || input.ledgerReviewConfirmed === '1' || input.ledgerReviewConfirmed === 'on';
    const expectedRevision = input.expectedRevision == null ? null : String(input.expectedRevision);
    const expectedOutstanding = input.expectedOutstanding == null ? null : String(input.expectedOutstanding);
    if (decision === 'approve' && (!/^\d{1,20}$/.test(expectedRevision || '')
      || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(expectedOutstanding || ''))) {
      throw new StudentDocumentFinanceClearanceError('Reload the finance balance before approving clearance.');
    }
    const pool = await getPool();
    const studentId = await locateRequestStudent(pool, requestId);
    const requestFingerprint = fingerprint({ requestId, decision, reason, arrangement, financeNote, reviewed,
      ...(decision === 'approve' ? { expectedRevision, expectedOutstanding } : {}) });
    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorInput, FINANCE_ROLES);
      const student = await debtRevisionService.lockStudent(transaction, studentId);
      if (!student || student.status === 'archived') throw new StudentDocumentFinanceClearanceError('Archived student records are read-only.', 409);
      const request = await lockRequest(transaction, requestId, studentId);
      if (!['requested', 'processing', 'ready'].includes(request.status)) throw new StudentDocumentFinanceClearanceError('Finance clearance cannot be changed after release or cancellation.', 409);
      const prior = await transaction.request().input('requestId', sql.UniqueIdentifier, requestId)
        .input('key', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT id, request_fingerprint FROM student_document_clearance_events
          WHERE request_id = @requestId AND idempotency_key = @key FOR UPDATE`);
      if (prior.recordset?.[0]) {
        if (prior.recordset[0].request_fingerprint !== requestFingerprint) throw new StudentDocumentFinanceClearanceError('This submission token was used for different clearance details.', 409);
        return { eventId: Number(prior.recordset[0].id), replayed: true };
      }
      const snapshot = await debtRevisionService.readSnapshot(transaction, studentId);
      const outstandingCents = snapshot.canonicalBalanceCents > 0n ? snapshot.canonicalBalanceCents : 0n;
      if (decision === 'approve') {
        if (String(student.debtIncreaseRevision) !== expectedRevision
          || formatCents(outstandingCents) !== expectedOutstanding) {
          throw new StudentDocumentFinanceClearanceError('The balance changed after this page loaded. Review the current balance before approving.', 409);
        }
        if (!snapshot.ledgerComplete) throw new StudentDocumentFinanceClearanceError('Finance must verify that the student’s relevant ledger records are complete before approval.', 409);
        if (!reviewed) throw new StudentDocumentFinanceClearanceError('Confirm that the displayed all-years and legacy balance was reviewed.');
        if (outstandingCents > 0n && (!reason || !arrangement)) throw new StudentDocumentFinanceClearanceError('An outstanding balance approval requires a reason and payment arrangement.');
        if (outstandingCents === 0n && (reason || arrangement)) throw new StudentDocumentFinanceClearanceError('A zero-balance approval does not need a debt arrangement.');
      } else if (!reason) {
        throw new StudentDocumentFinanceClearanceError('A reason is required to hold or withdraw finance clearance.');
      }
      const eventType = decision === 'approve' ? 'approved' : decision === 'hold' ? 'held' : 'withdrawn';
      const clearanceStatus = decision === 'approve' ? 'approved' : decision === 'hold' ? 'on_hold' : 'withdrawn';
      const inserted = await transaction.request()
        .input('requestId', sql.UniqueIdentifier, requestId)
        .input('actorId', sql.Int, actor.id)
        .input('eventType', sql.NVarChar(20), eventType)
        .input('status', sql.NVarChar(24), clearanceStatus)
        .input('revision', sql.BigInt, student.debtIncreaseRevision)
        .input('outstanding', sql.Decimal(12, 2), formatCents(outstandingCents))
        .input('reason', sql.NVarChar(1000), decision === 'approve' && outstandingCents === 0n ? null : reason)
        .input('arrangement', sql.NVarChar(1000), decision === 'approve' && outstandingCents > 0n ? arrangement : null)
        .input('financeNote', sql.NVarChar(1000), financeNote)
        .input('reviewed', sql.Bit, decision === 'approve' ? 1 : 0)
        .input('key', sql.UniqueIdentifier, idempotencyKey)
        .input('fingerprint', sql.Char(64), requestFingerprint)
        .query(`INSERT INTO student_document_clearance_events
          (request_id, actor_id, event_type, clearance_status, debt_increase_revision,
            outstanding_snapshot, reason, payment_arrangement, finance_note,
            ledger_review_confirmed, idempotency_key, request_fingerprint)
          VALUES (@requestId, @actorId, @eventType, @status, @revision,
            @outstanding, @reason, @arrangement, @financeNote, @reviewed, @key, @fingerprint)`);
      const eventId = Number(inserted.insertId || inserted.recordset?.[0]?.id);
      if (!Number.isSafeInteger(eventId) || eventId < 1) throw new Error('Finance clearance event insert returned no identifier.');
      await writeAudit(transaction, actor, `document_finance_clearance_${eventType}`, requestId, {
        studentId, eventId, outstanding: formatCents(outstandingCents), revision: student.debtIncreaseRevision,
        arrangementRecorded: Boolean(arrangement), privateNoteRecorded: Boolean(financeNote)
      });
      return { eventId, status: clearanceStatus, outstanding: formatCents(outstandingCents), replayed: false };
    });
  }

  async function issueClaimSlip(actorInput, requestInput, input = {}) {
    const requestId = typeof requestInput === 'string' && UUID.test(requestInput) ? requestInput.toLowerCase() : null;
    if (!requestId) throw new StudentDocumentFinanceClearanceError('Document request not found.', 404);
    const expectedClaimDate = normalizeDate(input.expectedClaimDate, 'expected claim date');
    const reason = cleanText(input.reason, 'Reschedule reason', 500, false, 5);
    const idempotencyKey = normalizeUuid(input.idempotencyKey, 'claim slip');
    const pool = await getPool();
    const studentId = await locateRequestStudent(pool, requestId);
    if (input.studentId != null && normalizeId(input.studentId) !== studentId) throw new StudentDocumentFinanceClearanceError('Document request not found.', 404);
    const requestFingerprint = fingerprint({ requestId, expectedClaimDate, reason });
    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorInput, REGISTRAR_ROLES);
      const student = await debtRevisionService.lockStudent(transaction, studentId);
      if (!student || student.status === 'archived') throw new StudentDocumentFinanceClearanceError('Archived student records are read-only.', 409);
      const request = await lockRequest(transaction, requestId, studentId);
      if (!['processing', 'ready'].includes(request.status)) throw new StudentDocumentFinanceClearanceError('Start processing before issuing a claim slip.', 409);
      if (expectedClaimDate < dateOnly(request.requested_on)) throw new StudentDocumentFinanceClearanceError('Expected claim date cannot be before the request date.');
      const prior = await transaction.request().input('requestId', sql.UniqueIdentifier, requestId)
        .input('key', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT id, request_fingerprint FROM student_document_claim_slips
          WHERE request_id = @requestId AND idempotency_key = @key FOR UPDATE`);
      if (prior.recordset?.[0]) {
        if (prior.recordset[0].request_fingerprint !== requestFingerprint) throw new StudentDocumentFinanceClearanceError('This submission token was used for different claim-slip details.', 409);
        return { slipId: Number(prior.recordset[0].id), replayed: true };
      }
      const snapshot = await debtRevisionService.readSnapshot(transaction, studentId);
      const clearance = await latestClearance(transaction, requestId);
      if (!snapshot.ledgerComplete || !clearance || clearance.event_type !== 'approved'
        || String(clearance.debt_increase_revision) !== student.debtIncreaseRevision) {
        throw new StudentDocumentFinanceClearanceError('A current finance approval is required before the claim slip can be issued or printed.', 409);
      }
      const previous = request.current_claim_slip_id ? await latestSlip(transaction, requestId) : null;
      if (previous && !reason) throw new StudentDocumentFinanceClearanceError('Enter a reason when rescheduling or reissuing a claim slip.');
      if (!previous && reason) throw new StudentDocumentFinanceClearanceError('A reason is only used when rescheduling an existing claim slip.');
      const inserted = await transaction.request()
        .input('requestId', sql.UniqueIdentifier, requestId)
        .input('approvalEventId', sql.BigInt, clearance.id)
        .input('eventType', sql.NVarChar(20), previous ? 'rescheduled' : 'issued')
        .input('expectedDate', sql.Date, expectedClaimDate)
        .input('previousDate', sql.Date, previous ? dateOnly(previous.expected_claim_date) : null)
        .input('reason', sql.NVarChar(500), reason)
        .input('key', sql.UniqueIdentifier, idempotencyKey)
        .input('fingerprint', sql.Char(64), requestFingerprint)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO student_document_claim_slips
          (request_id, finance_approval_event_id, event_type, expected_claim_date,
            previous_claim_date, reason, idempotency_key, request_fingerprint, issued_by)
          VALUES (@requestId, @approvalEventId, @eventType, @expectedDate,
            @previousDate, @reason, @key, @fingerprint, @actorId)`);
      const slipId = Number(inserted.insertId || inserted.recordset?.[0]?.id);
      if (!Number.isSafeInteger(slipId) || slipId < 1) throw new Error('Claim-slip history insert returned no identifier.');
      await transaction.request().input('requestId', sql.UniqueIdentifier, requestId)
        .input('slipId', sql.BigInt, slipId).input('expectedDate', sql.Date, expectedClaimDate)
        .query(`UPDATE student_document_requests SET current_claim_slip_id = @slipId,
          expected_claim_date = @expectedDate, updated_at = UTC_TIMESTAMP(6)
          WHERE id = @requestId`);
      await writeAudit(transaction, actor, previous ? 'document_claim_slip_rescheduled' : 'document_claim_slip_issued', requestId, {
        slipId, approvalEventId: Number(clearance.id), expectedClaimDate
      });
      return { slipId, expectedClaimDate, replayed: false };
    });
  }

  async function getPrintableClaimSlip(actorInput, requestInput, studentInput = null) {
    const requestId = typeof requestInput === 'string' && UUID.test(requestInput) ? requestInput.toLowerCase() : null;
    if (!requestId) throw new StudentDocumentFinanceClearanceError('Document request not found.', 404);
    const pool = await getPool();
    const studentId = await locateRequestStudent(pool, requestId);
    if (studentInput != null && normalizeId(studentInput) !== studentId) throw new StudentDocumentFinanceClearanceError('Document request not found.', 404);
    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorInput, REGISTRAR_ROLES);
      const student = await debtRevisionService.lockStudent(transaction, studentId);
      if (!student || student.status === 'archived') throw new StudentDocumentFinanceClearanceError('Archived student records are read-only.', 409);
      const request = await lockRequest(transaction, requestId, studentId);
      if (!['processing', 'ready'].includes(request.status)) throw new StudentDocumentFinanceClearanceError('A claim slip is not available for this request state.', 409);
      const currentSlip = await latestSlip(transaction, requestId);
      const clearance = await latestClearance(transaction, requestId);
      const snapshot = await debtRevisionService.readSnapshot(transaction, studentId);
      if (!currentSlip || Number(currentSlip.id) !== Number(request.current_claim_slip_id)
        || !snapshot.ledgerComplete || !clearance || clearance.event_type !== 'approved'
        || String(clearance.debt_increase_revision) !== student.debtIncreaseRevision
        || Number(currentSlip.finance_approval_event_id) !== Number(clearance.id)) {
        throw new StudentDocumentFinanceClearanceError('The claim slip is stale. Finance must approve this balance and the registrar must issue a current slip.', 409);
      }
      const fullName = [request.first_name, request.middle_name, request.last_name, request.suffix].filter(Boolean).join(' ');
      return {
        schoolName: 'Ark Technological Institute Education System Incorporated - Lucena Branch',
        studentId,
        requestReference: request.reference_text || String(request.id).toUpperCase(),
        studentName: fullName,
        studentNumber: request.student_no || 'Not recorded',
        document: request.document_name,
        documentType: request.document_type,
        requestedOn: dateOnly(request.requested_on),
        expectedClaimDate: dateOnly(currentSlip.expected_claim_date),
        issuerName: [currentSlip.issuer_first_name, currentSlip.issuer_last_name].filter(Boolean).join(' ') || 'Registrar staff',
        issuedAt: currentSlip.created_at,
        slipNumber: Number(currentSlip.id)
      };
    });
  }

  return { getRegistrarData, getFinanceQueue, decideClearance, issueClaimSlip, getPrintableClaimSlip };
}

module.exports = {
  StudentDocumentFinanceClearanceError,
  createStudentDocumentFinanceClearanceService,
  clearanceStatus,
  normalizeDate
};
