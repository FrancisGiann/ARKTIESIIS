const test = require('node:test');
const assert = require('node:assert/strict');
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
