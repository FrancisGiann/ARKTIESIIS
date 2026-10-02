const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStudentDocumentRequestService, StudentDocumentRequestError } = require('../src/services/studentDocumentRequestService');
const { CURRENT_ECR_PERIODS, formatStatus, RegistrarGradeOverviewError } = require('../src/services/registrarGradeOverviewService');

const uuid = '71111111-1111-4111-8111-111111111111';

test('document request input validation rejects malformed names, dates, reasons, and idempotency before database access', async () => {
  let connectionAttempts = 0;
  const service = createStudentDocumentRequestService({
    getPool: async () => { connectionAttempts += 1; throw new Error('unexpected database access'); }
  });
  const valid = { documentType: 'Transcript of Records', documentName: 'Grade 11 Transcript', requestedOn: '2026-09-30', idempotencyKey: uuid };
  await assert.rejects(service.createRequest('7', '12', { ...valid, documentName: 'bad\nname' }), StudentDocumentRequestError);
  await assert.rejects(service.createRequest('7', '12', { ...valid, requestedOn: '2026-02-30' }), /valid request date/);
  await assert.rejects(service.createRequest('7', '12', { ...valid, idempotencyKey: 'bad' }), /valid idempotency key/);
  await assert.rejects(service.transitionRequest('7', '12', uuid, { status: 'unknown', idempotencyKey: uuid }), /supported request status/);
  await assert.rejects(service.transitionRequest('7', '12', uuid, {
    status: 'cancelled', reason: 'no', idempotencyKey: uuid
  }), /between 5 and 500/);
  await assert.rejects(service.correctRequest('7', '12', uuid, {
    documentType: 'Transcript', documentName: 'Transcript', requestedOn: '2026-09-30', reason: 'wrong details', idempotencyKey: 'bad'
  }), StudentDocumentRequestError);
  assert.equal(connectionAttempts, 0);
});

test('pre-011 release and correction idempotency fingerprints still replay without a handover reference', async () => {
  const requestId = '71111111-1111-4111-8111-111111111112';
  const releasedOn = '2026-10-01';
  const recipient = 'Jamie Lee';
  const fingerprint = (payload) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const oldTransitionFingerprint = fingerprint({
    operation: 'transition', studentId: 12, requestId, status: 'released', releasedOn, recipient, reason: null
  });
  const oldCorrectionFingerprint = fingerprint({
    operation: 'correct', studentId: 12, requestId, documentType: 'Transcript', documentName: 'Corrected transcript',
    requestedOn: '2026-09-30', reference: null, reason: 'Corrected old details', releasedOn, recipient
  });

  function replayService(expectedFingerprint) {
    const log = { queries: [], committed: false };
    const service = createStudentDocumentRequestService({
      getPool: async () => ({}),
      sql: {
        Int: 'Int', BigInt: 'BigInt', Bit: 'Bit', UniqueIdentifier: 'UniqueIdentifier', Date: 'Date', MAX: 'MAX',
        Char: (length) => `Char(${length})`, NVarChar: (length) => `NVarChar(${length})`,
        ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }
      },
      transactionFactory: () => ({
        async begin() {},
        request() {
          const values = {};
          return {
            input(name, _type, value) { values[name] = value; return this; },
            async query(statement) {
              log.queries.push(statement);
              if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
              if (statement.includes('FROM students WHERE id = @studentId FOR UPDATE')) {
                return { recordset: [{ id: 12, status: 'active', debt_increase_revision: '0' }] };
              }
              if (statement.includes('SELECT id, student_id, status, document_type')
                || statement.includes('SELECT id, status, document_type')) return { recordset: [{
                id: requestId, student_id: 12, status: 'released', document_type: 'Transcript',
                document_name: 'Official transcript', requested_on: '2026-09-30', reference_text: null,
                released_on: releasedOn, recipient, handover_reference: null, current_claim_slip_id: null
              }] };
              if (statement.includes('SELECT request_fingerprint FROM student_document_request_events')) {
                return { recordset: [{ request_fingerprint: expectedFingerprint }] };
              }
              throw new Error(`Unexpected replay query: ${statement}`);
            }
          };
        },
        async commit() { log.committed = true; },
        async rollback() {}
      })
    });
    return { service, log };
  }

  const transition = replayService(oldTransitionFingerprint);
  const releaseReplay = await transition.service.transitionRequest('7', '12', requestId, {
    status: 'released', releasedOn, recipient, idempotencyKey: '71111111-1111-4111-8111-111111111113'
  });
  assert.equal(releaseReplay.replayed, true);
  assert.equal(transition.log.committed, true);
  assert.equal(transition.log.queries.some((statement) => statement.includes('UPDATE student_document_requests')), false);

  const correction = replayService(oldCorrectionFingerprint);
  const correctionReplay = await correction.service.correctRequest('7', '12', requestId, {
    documentType: 'Transcript', documentName: 'Corrected transcript', requestedOn: '2026-09-30',
    reason: 'Corrected old details', releasedOn, recipient,
    idempotencyKey: '71111111-1111-4111-8111-111111111114'
  });
  assert.equal(correctionReplay.replayed, true);
  assert.equal(correction.log.committed, true);
  assert.equal(correction.log.queries.some((statement) => statement.includes('UPDATE student_document_requests')), false);
});

test('grade overview distinguishes published zero, published blank, cached workbook, and submission states', () => {
  assert.deepEqual(CURRENT_ECR_PERIODS, ['Term 1', 'Term 2', 'Term 3', 'Final Grade']);
  assert.equal(formatStatus({ grade_id: 4, grade_value: 0, submission_status: 'pending' }), 'published');
  assert.equal(formatStatus({ grade_id: 4, grade_value: null, submission_status: 'pending' }), 'published_blank');
  assert.equal(formatStatus({ grade_id: null, submission_status: 'pending', has_cached_grade: 1 }), 'pending_review');
  assert.equal(formatStatus({ grade_id: null, submission_status: 'correction_requested' }), 'correction_requested');
  assert.equal(formatStatus({ grade_id: null, submission_status: 'rejected' }), 'rejected');
  assert.equal(formatStatus({ grade_id: null, submission_status: 'approved' }), 'approved_unpublished');
  assert.equal(formatStatus({ grade_id: null, submission_status: null }), 'no_submission');
  assert.ok(RegistrarGradeOverviewError);
});
