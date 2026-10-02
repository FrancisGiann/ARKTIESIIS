const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { createFinanceDebtRevisionService } = require('./financeDebtRevisionService');
const { runSerializableTransaction } = require('./transactionRetry');

const ID_PATTERN = /^\d{1,10}$/;
const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const STAFF_ROLES = new Set(['registrar', 'database_admin']);
const STATUS_TRANSITIONS = {
  requested: new Set(['processing', 'cancelled']),
  processing: new Set(['ready', 'cancelled']),
  ready: new Set(['released', 'cancelled'])
};

class StudentDocumentRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'StudentDocumentRequestError';
    this.status = status;
  }
}

function normalizeId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

function requiredText(value, label, maxLength, minLength = 1) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < minLength || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    const bound = minLength > 1 ? `must be between ${minLength} and ${maxLength}` : `is required and must be no more than ${maxLength}`;
    throw new StudentDocumentRequestError(`${label} ${bound} printable characters.`);
  }
  return text;
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maxLength);
}

function normalizeDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new StudentDocumentRequestError(`Enter a valid ${label.toLowerCase()}.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new StudentDocumentRequestError(`Enter a valid ${label.toLowerCase()}.`);
  }
  return value;
}

function normalizeUuid(value, label = 'idempotency key') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new StudentDocumentRequestError(`A valid ${label} is required.`);
  }
  return value.toLowerCase();
}

function fingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function createStudentDocumentRequestService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool)
} = {}) {
  const debtRevisions = createFinanceDebtRevisionService({ getPool, sql, transactionFactory });

  async function runTransaction(callback) {
    return runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
  }

  async function requireActor(request, actorInput, { lock = false } = {}) {
    const actorId = normalizeId(actorInput);
    if (!actorId) throw new StudentDocumentRequestError('Staff access is required.', 403);
    const result = await request.input('actorId', sql.Int, actorId).query(`
      SELECT id, role FROM users
      WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin')${lock ? ' FOR UPDATE' : ''}`);
    const actor = result.recordset?.[0];
    if (!actor || !STAFF_ROLES.has(actor.role)) throw new StudentDocumentRequestError('Your document-ledger access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function requireActiveStudent(transaction, studentId) {
    const student = await debtRevisions.lockStudent(transaction, studentId);
    if (!student) throw new StudentDocumentRequestError('Student record not found.', 404);
    if (student.status === 'archived') throw new StudentDocumentRequestError('Archived student records are read-only.', 409);
    return student;
  }

  async function requireCurrentFinanceApproval(transaction, request, { claimSlipRequired = false } = {}) {
    const student = await debtRevisions.lockStudent(transaction, Number(request.student_id));
    if (!student || student.status === 'archived') throw new StudentDocumentRequestError('Archived student records are read-only.', 409);
    const snapshot = await debtRevisions.readSnapshot(transaction, Number(request.student_id));
    const clearanceResult = await transaction.request().input('requestId', sql.UniqueIdentifier, request.id)
      .query(`SELECT id, event_type, CAST(debt_increase_revision AS CHAR(40)) AS debt_increase_revision
        FROM student_document_clearance_events WHERE request_id = @requestId
        ORDER BY id DESC LIMIT 1`);
    const approval = clearanceResult.recordset?.[0];
    if (!snapshot.ledgerComplete || !approval || approval.event_type !== 'approved'
      || String(approval.debt_increase_revision) !== student.debtIncreaseRevision) {
      throw new StudentDocumentRequestError('A current finance approval is required before this request can progress or be released.', 409);
    }
    if (claimSlipRequired) {
      const slipResult = await transaction.request().input('requestId', sql.UniqueIdentifier, request.id)
        .query(`SELECT id, finance_approval_event_id FROM student_document_claim_slips
          WHERE request_id = @requestId ORDER BY id DESC LIMIT 1`);
      const slip = slipResult.recordset?.[0];
      if (!slip || Number(slip.id) !== Number(request.current_claim_slip_id)
        || Number(slip.finance_approval_event_id) !== Number(approval.id)) {
        throw new StudentDocumentRequestError('Issue a current claim slip under the active finance approval before continuing.', 409);
      }
    }
    return { student, snapshot, approval };
  }

  async function writeAudit(transaction, actor, action, requestId, details = {}) {
    await transaction.request()
      .input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), `${actor.role}.${action}`)
      .input('entityId', sql.NVarChar(100), String(requestId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, 'student_document_request', @entityId, @detailsJson)`);
  }

  async function createRequest(actorInput, studentInput, input = {}) {
    const actorId = normalizeId(actorInput);
    const studentId = normalizeId(studentInput);
    if (!actorId) throw new StudentDocumentRequestError('Staff access is required.', 403);
    if (!studentId) throw new StudentDocumentRequestError('Student record not found.', 404);
    const payload = {
      documentType: requiredText(input.documentType, 'Document type', 50),
      documentName: requiredText(input.documentName, 'Document name', 150),
      requestedOn: normalizeDate(input.requestedOn, 'request date'),
      reference: optionalText(input.reference, 'Reference', 200)
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(payload.documentType)) {
      throw new StudentDocumentRequestError('Document type may contain letters, numbers, spaces, periods, underscores, slashes, and hyphens.');
    }
    const key = normalizeUuid(input.idempotencyKey);
    const requestFingerprint = fingerprint({ operation: 'create', studentId, ...payload });

    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorId, { lock: true });
      await requireActiveStudent(transaction, studentId);
      const replay = await transaction.request().input('actorId', sql.Int, actor.id)
        .input('key', sql.UniqueIdentifier, key).query(`SELECT id, create_request_fingerprint AS request_fingerprint
          FROM student_document_requests
          WHERE requested_by = @actorId AND create_idempotency_key = @key FOR UPDATE`);
      if (replay.recordset?.length) {
        if (replay.recordset[0].request_fingerprint !== requestFingerprint) {
          throw new StudentDocumentRequestError('This submission key was already used with different request details.', 409);
        }
        return { requestId: replay.recordset[0].id, replayed: true };
      }
      const requestId = crypto.randomUUID();
      await transaction.request()
        .input('requestId', sql.UniqueIdentifier, requestId)
        .input('studentId', sql.Int, studentId)
        .input('documentType', sql.NVarChar(50), payload.documentType)
        .input('documentName', sql.NVarChar(150), payload.documentName)
        .input('requestedOn', sql.Date, payload.requestedOn)
        .input('actorId', sql.Int, actor.id)
        .input('reference', sql.NVarChar(200), payload.reference)
        .input('key', sql.UniqueIdentifier, key)
        .input('fingerprint', sql.Char(64), requestFingerprint)
        .query(`INSERT INTO student_document_requests
          (id, student_id, document_type, document_name, requested_on, requested_by, reference_text,
            create_idempotency_key, create_request_fingerprint)
          VALUES (@requestId, @studentId, @documentType, @documentName, @requestedOn, @actorId, @reference, @key, @fingerprint)`);
      await transaction.request()
        .input('requestId', sql.UniqueIdentifier, requestId)
        .input('actorId', sql.Int, actor.id)
        .input('key', sql.UniqueIdentifier, key)
        .input('fingerprint', sql.Char(64), requestFingerprint)
        .input('documentType', sql.NVarChar(50), payload.documentType)
        .input('documentName', sql.NVarChar(150), payload.documentName)
        .input('requestedOn', sql.Date, payload.requestedOn)
        .input('reference', sql.NVarChar(200), payload.reference)
        .query(`INSERT INTO student_document_request_events
          (request_id, actor_id, event_type, status_from, status_to,
            document_type_after, document_name_after, requested_on_after, reference_after,
            idempotency_key, request_fingerprint)
          VALUES (@requestId, @actorId, 'requested', NULL, 'requested',
            @documentType, @documentName, @requestedOn, @reference, @key, @fingerprint)`);
      await writeAudit(transaction, actor, 'document_request_created', requestId, { documentType: payload.documentType });
      return { requestId, replayed: false };
    });
  }

  function normalizeTransition(input = {}) {
    const status = input.status;
    if (!['processing', 'ready', 'released', 'cancelled'].includes(status)) {
      throw new StudentDocumentRequestError('Choose a supported request status.');
    }
    const payload = { status, releasedOn: null, recipient: null, handoverReference: null, reason: null };
    if (status === 'released') {
      payload.releasedOn = normalizeDate(input.releasedOn, 'release date');
      payload.recipient = requiredText(input.recipient, 'Recipient', 150);
      payload.handoverReference = optionalText(input.handoverReference, 'Handover reference', 200);
    }
    if (status === 'cancelled') payload.reason = requiredText(input.reason, 'Cancellation reason', 500, 5);
    return payload;
  }

  async function transitionRequest(actorInput, studentInput, requestInput, input = {}) {
    const actorId = normalizeId(actorInput);
    const studentId = normalizeId(studentInput);
    const requestId = typeof requestInput === 'string' && UUID_PATTERN.test(requestInput) ? requestInput.toLowerCase() : null;
    if (!actorId) throw new StudentDocumentRequestError('Staff access is required.', 403);
    if (!studentId || !requestId) throw new StudentDocumentRequestError('Document request not found.', 404);
    const payload = normalizeTransition(input);
    const key = normalizeUuid(input.idempotencyKey);
    const fingerprintPayload = { operation: 'transition', studentId, requestId, ...payload };
    if (!payload.handoverReference) delete fingerprintPayload.handoverReference;
    const requestFingerprint = fingerprint(fingerprintPayload);

    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorId, { lock: true });
      await requireActiveStudent(transaction, studentId);
      const currentResult = await transaction.request()
        .input('requestId', sql.UniqueIdentifier, requestId)
        .input('studentId', sql.Int, studentId)
        .query(`SELECT id, student_id, status, document_type, document_name, requested_on,
            reference_text, released_on, recipient, handover_reference, current_claim_slip_id
          FROM student_document_requests
          WHERE id = @requestId AND student_id = @studentId FOR UPDATE`);
      const current = currentResult.recordset?.[0];
      if (!current) throw new StudentDocumentRequestError('Document request not found.', 404);
      const priorEvent = await transaction.request()
        .input('requestId', sql.UniqueIdentifier, requestId).input('key', sql.UniqueIdentifier, key)
        .query(`SELECT request_fingerprint FROM student_document_request_events
          WHERE request_id = @requestId AND idempotency_key = @key FOR UPDATE`);
      if (priorEvent.recordset?.length) {
        if (priorEvent.recordset[0].request_fingerprint !== requestFingerprint) {
          throw new StudentDocumentRequestError('This submission key was already used with different request details.', 409);
        }
        return { requestId, status: payload.status, replayed: true };
      }
      if (!STATUS_TRANSITIONS[current.status]?.has(payload.status)) {
        throw new StudentDocumentRequestError(`A request in ${current.status} status cannot be changed to ${payload.status}.`, 409);
      }
      if (payload.status === 'released' && payload.releasedOn < dateOnly(current.requested_on)) {
        throw new StudentDocumentRequestError('Release date cannot be before the request date.');
      }
      if (payload.status !== 'cancelled') {
        await requireCurrentFinanceApproval(transaction, current, {
          claimSlipRequired: payload.status === 'ready' || payload.status === 'released'
        });
      }
      await transaction.request()
        .input('requestId', sql.UniqueIdentifier, requestId)
        .input('status', sql.NVarChar(20), payload.status)
        .input('releasedOn', sql.Date, payload.releasedOn)
        .input('recipient', sql.NVarChar(150), payload.recipient)
        .input('handoverReference', sql.NVarChar(200), payload.handoverReference)
        .query(`UPDATE student_document_requests SET status = @status,
            released_on = @releasedOn, recipient = @recipient, handover_reference = @handoverReference,
            updated_at = UTC_TIMESTAMP(6)
          WHERE id = @requestId`);
      await transaction.request()
        .input('requestId', sql.UniqueIdentifier, requestId).input('actorId', sql.Int, actor.id)
        .input('eventType', sql.NVarChar(20), payload.status)
        .input('statusFrom', sql.NVarChar(20), current.status)
        .input('statusTo', sql.NVarChar(20), payload.status)
        .input('releasedOn', sql.Date, payload.releasedOn)
        .input('recipient', sql.NVarChar(150), payload.recipient)
        .input('reason', sql.NVarChar(500), payload.reason)
        .input('key', sql.UniqueIdentifier, key).input('fingerprint', sql.Char(64), requestFingerprint)
        .input('typeBefore', sql.NVarChar(50), current.document_type).input('typeAfter', sql.NVarChar(50), current.document_type)
        .input('nameBefore', sql.NVarChar(150), current.document_name).input('nameAfter', sql.NVarChar(150), current.document_name)
        .input('requestedBefore', sql.Date, current.requested_on).input('requestedAfter', sql.Date, current.requested_on)
        .input('referenceBefore', sql.NVarChar(200), current.reference_text).input('referenceAfter', sql.NVarChar(200), current.reference_text)
        .input('handoverReferenceBefore', sql.NVarChar(200), current.handover_reference)
        .input('handoverReferenceAfter', sql.NVarChar(200), payload.handoverReference)
        .input('handoverReference', sql.NVarChar(200), payload.handoverReference)
        .query(`INSERT INTO student_document_request_events
          (request_id, actor_id, event_type, status_from, status_to,
            document_type_before, document_type_after, document_name_before, document_name_after,
            requested_on_before, requested_on_after, reference_before, reference_after,
            released_on, recipient, handover_reference_before, handover_reference_after,
            handover_reference, reason, idempotency_key, request_fingerprint)
          VALUES (@requestId, @actorId, @eventType, @statusFrom, @statusTo,
            @typeBefore, @typeAfter, @nameBefore, @nameAfter,
            @requestedBefore, @requestedAfter, @referenceBefore, @referenceAfter,
            @releasedOn, @recipient, @handoverReferenceBefore, @handoverReferenceAfter,
            @handoverReference, @reason, @key, @fingerprint)`);
      await writeAudit(transaction, actor, `document_request_${payload.status}`, requestId, { status: payload.status });
      return { requestId, status: payload.status, replayed: false };
    });
  }

  async function correctRequest(actorInput, studentInput, requestInput, input = {}) {
    const actorId = normalizeId(actorInput);
    const studentId = normalizeId(studentInput);
    const requestId = typeof requestInput === 'string' && UUID_PATTERN.test(requestInput) ? requestInput.toLowerCase() : null;
    if (!actorId) throw new StudentDocumentRequestError('Staff access is required.', 403);
    if (!studentId || !requestId) throw new StudentDocumentRequestError('Document request not found.', 404);
    const payload = {
      documentType: requiredText(input.documentType, 'Document type', 50),
      documentName: requiredText(input.documentName, 'Document name', 150),
      requestedOn: normalizeDate(input.requestedOn, 'request date'),
      reference: optionalText(input.reference, 'Reference', 200),
      reason: requiredText(input.reason, 'Correction reason', 500, 5)
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(payload.documentType)) {
      throw new StudentDocumentRequestError('Document type may contain letters, numbers, spaces, periods, underscores, slashes, and hyphens.');
    }
    const key = normalizeUuid(input.idempotencyKey);
    const requestedReleaseDate = input.releasedOn === undefined || input.releasedOn === '' ? null : normalizeDate(input.releasedOn, 'release date');
    const requestedRecipient = input.recipient === undefined || input.recipient === '' ? null : requiredText(input.recipient, 'Recipient', 150);
    const requestedHandoverReference = optionalText(input.handoverReference, 'Handover reference', 200);
    const fingerprintPayload = { operation: 'correct', studentId, requestId, ...payload,
      releasedOn: requestedReleaseDate, recipient: requestedRecipient };
    if (requestedHandoverReference) fingerprintPayload.handoverReference = requestedHandoverReference;
    const requestFingerprint = fingerprint(fingerprintPayload);

    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorId, { lock: true });
      await requireActiveStudent(transaction, studentId);
      const result = await transaction.request().input('requestId', sql.UniqueIdentifier, requestId)
        .input('studentId', sql.Int, studentId).query(`SELECT id, status, document_type, document_name, requested_on,
            reference_text, released_on, recipient, handover_reference, current_claim_slip_id
          FROM student_document_requests WHERE id = @requestId AND student_id = @studentId FOR UPDATE`);
      const current = result.recordset?.[0];
      if (!current) throw new StudentDocumentRequestError('Document request not found.', 404);
      const priorEvent = await transaction.request().input('requestId', sql.UniqueIdentifier, requestId)
        .input('key', sql.UniqueIdentifier, key).query(`SELECT request_fingerprint FROM student_document_request_events
          WHERE request_id = @requestId AND idempotency_key = @key FOR UPDATE`);
      if (priorEvent.recordset?.length) {
        if (priorEvent.recordset[0].request_fingerprint !== requestFingerprint) {
          throw new StudentDocumentRequestError('This submission key was already used with different request details.', 409);
        }
        return { requestId, status: current.status, replayed: true };
      }
      const releasedOn = current.status === 'released' ? requestedReleaseDate : null;
      const recipient = current.status === 'released' ? requestedRecipient : null;
      const handoverReference = current.status === 'released' ? requestedHandoverReference : null;
      if (current.status === 'released' && (!releasedOn || !recipient)) {
        throw new StudentDocumentRequestError('Enter the corrected release date and recipient for a released request.');
      }
      if (current.status === 'released' && releasedOn < payload.requestedOn) {
        throw new StudentDocumentRequestError('Release date cannot be before the request date.');
      }
      const currentDate = dateOnly(current.requested_on);
      const currentReleasedDate = dateOnly(current.released_on);
      if (current.document_type === payload.documentType && current.document_name === payload.documentName
        && currentDate === payload.requestedOn && (current.reference_text || null) === payload.reference
        && (current.status !== 'released' || (currentReleasedDate === releasedOn && current.recipient === recipient
          && (current.handover_reference || null) === handoverReference))) {
        throw new StudentDocumentRequestError('Change at least one request detail to record a correction.');
      }
      await transaction.request()
        .input('requestId', sql.UniqueIdentifier, requestId)
        .input('documentType', sql.NVarChar(50), payload.documentType)
        .input('documentName', sql.NVarChar(150), payload.documentName)
        .input('requestedOn', sql.Date, payload.requestedOn)
        .input('reference', sql.NVarChar(200), payload.reference)
        .input('releasedOn', sql.Date, releasedOn)
        .input('recipient', sql.NVarChar(150), recipient)
        .input('handoverReference', sql.NVarChar(200), handoverReference)
        .query(`UPDATE student_document_requests SET document_type = @documentType,
          document_name = @documentName, requested_on = @requestedOn, reference_text = @reference,
          released_on = @releasedOn, recipient = @recipient, handover_reference = @handoverReference,
          current_claim_slip_id = CASE WHEN status = 'released' THEN current_claim_slip_id ELSE NULL END,
          expected_claim_date = CASE WHEN status = 'released' THEN expected_claim_date ELSE NULL END,
          updated_at = UTC_TIMESTAMP(6) WHERE id = @requestId`);
      await transaction.request()
        .input('requestId', sql.UniqueIdentifier, requestId).input('actorId', sql.Int, actor.id)
        .input('status', sql.NVarChar(20), current.status)
        .input('typeBefore', sql.NVarChar(50), current.document_type).input('typeAfter', sql.NVarChar(50), payload.documentType)
        .input('nameBefore', sql.NVarChar(150), current.document_name).input('nameAfter', sql.NVarChar(150), payload.documentName)
        .input('requestedBefore', sql.Date, current.requested_on).input('requestedAfter', sql.Date, payload.requestedOn)
        .input('referenceBefore', sql.NVarChar(200), current.reference_text).input('referenceAfter', sql.NVarChar(200), payload.reference)
        .input('releaseBefore', sql.Date, current.released_on).input('releaseAfter', sql.Date, releasedOn)
        .input('recipientBefore', sql.NVarChar(150), current.recipient).input('recipientAfter', sql.NVarChar(150), recipient)
        .input('handoverReferenceBefore', sql.NVarChar(200), current.handover_reference)
        .input('handoverReferenceAfter', sql.NVarChar(200), handoverReference)
        .input('reason', sql.NVarChar(500), payload.reason)
        .input('key', sql.UniqueIdentifier, key).input('fingerprint', sql.Char(64), requestFingerprint)
        .query(`INSERT INTO student_document_request_events
          (request_id, actor_id, event_type, status_from, status_to,
            document_type_before, document_type_after, document_name_before, document_name_after,
            requested_on_before, requested_on_after, reference_before, reference_after,
            released_on_before, released_on_after, recipient_before, recipient_after,
            handover_reference_before, handover_reference_after,
            reason, idempotency_key, request_fingerprint)
          VALUES (@requestId, @actorId, 'corrected', @status, @status,
            @typeBefore, @typeAfter, @nameBefore, @nameAfter,
            @requestedBefore, @requestedAfter, @referenceBefore, @referenceAfter,
            @releaseBefore, @releaseAfter, @recipientBefore, @recipientAfter,
            @handoverReferenceBefore, @handoverReferenceAfter,
            @reason, @key, @fingerprint)`);
      await writeAudit(transaction, actor, 'document_request_corrected', requestId, { status: current.status });
      return { requestId, status: current.status, replayed: false };
    });
  }

  async function getStudentRequests(actorInput, studentInput) {
    const actorId = normalizeId(actorInput);
    const studentId = normalizeId(studentInput);
    if (!actorId) throw new StudentDocumentRequestError('Staff access is required.', 403);
    if (!studentId) throw new StudentDocumentRequestError('Student record not found.', 404);
    const pool = await getPool();
    await requireActor(pool.request(), actorId);
    const student = await pool.request().input('studentId', sql.Int, studentId)
      .query('SELECT id FROM students WHERE id = @studentId');
    if (!student.recordset?.length) throw new StudentDocumentRequestError('Student record not found.', 404);
    const requests = await pool.request().input('studentId', sql.Int, studentId).query(`SELECT r.id, r.document_type,
        r.document_name, r.requested_on, r.reference_text, r.status, r.released_on, r.recipient,
        r.handover_reference, r.expected_claim_date, r.current_claim_slip_id,
        r.created_at, requester.first_name AS requested_by_first_name, requester.last_name AS requested_by_last_name
      FROM student_document_requests AS r
      LEFT JOIN staff_profiles AS requester ON requester.user_id = r.requested_by
      WHERE r.student_id = @studentId ORDER BY r.created_at DESC, r.id`);
    const events = await pool.request().input('studentId', sql.Int, studentId).query(`SELECT e.request_id, e.event_type,
        e.status_from, e.status_to, e.document_type_before, e.document_type_after,
        e.document_name_before, e.document_name_after, e.requested_on_before, e.requested_on_after,
        e.reference_before, e.reference_after, e.released_on, e.recipient,
        e.handover_reference, e.handover_reference_before, e.handover_reference_after,
        e.released_on_before, e.released_on_after, e.recipient_before, e.recipient_after,
        e.reason, e.created_at,
        actor.first_name AS actor_first_name, actor.last_name AS actor_last_name
      FROM student_document_request_events AS e
      INNER JOIN student_document_requests AS r ON r.id = e.request_id
      LEFT JOIN staff_profiles AS actor ON actor.user_id = e.actor_id
      WHERE r.student_id = @studentId ORDER BY e.created_at DESC, e.id DESC`);
    const history = new Map();
    for (const event of events.recordset || []) {
      const key = String(event.request_id).toLowerCase();
      if (!history.has(key)) history.set(key, []);
      history.get(key).push(event);
    }
    return (requests.recordset || []).map((request) => ({
      ...request,
      id: String(request.id).toLowerCase(),
      history: history.get(String(request.id).toLowerCase()) || []
    }));
  }

  function dateOnly(value) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value || '').slice(0, 10);
  }

  return { createRequest, transitionRequest, correctRequest, getStudentRequests };
}

module.exports = { StudentDocumentRequestError, createStudentDocumentRequestService, normalizeDate };
