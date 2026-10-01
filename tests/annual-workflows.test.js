const test = require('node:test');
const assert = require('node:assert/strict');

const { AnnualEnrollmentError, normalizeAnnualInput, normalizeAnnualAdministrationDetails, applySameSectionDefaults } = require('../src/services/annualEnrollmentService');
const {
  AnnualFinanceError, normalizeLineRows, normalizeAllocations, parsePaymentDate, applyExemptionPreview, canonicalAssessmentSnapshot,
  tuitionInstallmentBreakdown
} = require('../src/services/annualFinanceService');
const { PhysicalChecklistError, createPhysicalChecklistService } = require('../src/services/physicalChecklistService');

const uuid = '41111111-1111-4111-8111-111111111111';

test('annual intake accepts explicit midyear entry with an optional future placement', () => {
  const valid = normalizeAnnualInput({
    studentNo: 'STU-2026-1', schoolYear: '2026-2027', gradeLevel: 'Grade 12', voucherCode: 'ESC',
    intakeKind: 'transferee', enrollmentStartDate: '2026-10-01', entryTermNumber: '2',
    voucherCategory: 'D', section2Id: '12', idempotencyKey: uuid
  });
  assert.equal(valid.isReturning, true);
  assert.equal(valid.intakeKind, 'transferee');
  assert.equal(valid.entryTermNumber, 2);
  assert.deepEqual(valid.sectionIds, [null, 12, null]);
  assert.throws(() => normalizeAnnualInput({
    studentNo: 'STU-2026-1', schoolYear: '2026-2027', gradeLevel: 'Grade 10', voucherCode: 'PUB',
    entryTermNumber: '2', enrollmentStartDate: '2026-10-01', section2Id: '12', idempotencyKey: uuid
  }), AnnualEnrollmentError);
  assert.throws(() => normalizeAnnualInput({
    studentNo: 'STU-2026-1', schoolYear: '2026-2027', gradeLevel: 'Grade 12', voucherCode: 'PUB',
    entryTermNumber: '2', enrollmentStartDate: '2026-10-01', section1Id: '11', section2Id: '12', idempotencyKey: uuid
  }), /entry term/);
  assert.throws(() => normalizeAnnualInput({
    studentNo: 'STU-2026-1', schoolYear: '2026-2027', gradeLevel: 'Grade 12', voucherCode: 'PUB',
    entryTermNumber: '2', enrollmentStartDate: '2026-02-30', section2Id: '12', idempotencyKey: uuid
  }), /valid calendar date/);
});

test('annual section defaults map only unique exact term matches and preserve explicit term choices', () => {
  assert.deepEqual(applySameSectionDefaults({
    entryTermNumber: 1,
    sectionIds: [11, null, null],
    candidatesByTerm: { 2: [{ id: 22 }], 3: [] }
  }), [11, 22, null]);
  assert.deepEqual(applySameSectionDefaults({
    entryTermNumber: 1,
    sectionIds: [11, null, null],
    candidatesByTerm: { 2: [{ id: 22 }, { id: 23 }], 3: [{ id: 33 }] }
  }), [11, null, 33]);
  assert.deepEqual(applySameSectionDefaults({
    entryTermNumber: 2,
    sectionIds: [null, 12, null],
    candidatesByTerm: { 3: [{ id: 13 }] }
  }), [null, 12, 13]);
  assert.deepEqual(applySameSectionDefaults({
    entryTermNumber: 2,
    sectionIds: [null, 12, null],
    sectionOverrides: [false, false, true],
    candidatesByTerm: { 3: [{ id: 13 }] }
  }), [null, 12, null]);
});

test('annual workbook administration fields use neutral statuses, bounded notes, and valid claim dates', () => {
  const details = {
    escId: ' ESC-001 ', eformStatus: 'submitted', eformRemarks: 'Received', lisStatus: 'pending', lisRemarks: '',
    vmsStatus: 'not_applicable', vmsRemarks: '', acquaintanceWaiverStatus: 'complete', acquaintanceParty: 'Parent',
    educationalTourStatus: 'participating', internalAgreementRemarks: 'Follow-up', modulesClaimedDate: '2026-08-31',
    studentIdClaimedDate: '', uniformClaimedDate: '2026-09-02', peUniformClaimedDate: ''
  };
  const normalized = normalizeAnnualAdministrationDetails(details);
  assert.equal(normalized.escId, 'ESC-001');
  assert.equal(normalized.modulesClaimedDate, '2026-08-31');
  assert.equal(normalized.studentIdClaimedDate, null);
  assert.throws(() => normalizeAnnualAdministrationDetails({ eformStatus: 'approved' }), /valid eform status/i);
  assert.throws(() => normalizeAnnualAdministrationDetails({ ...details, modulesClaimedDate: '2026-02-30' }), /valid calendar date/);
  assert.throws(() => normalizeAnnualAdministrationDetails({ ...details, escId: 'x'.repeat(81) }), /esc id/);
});

test('finance schedule and allocation input stays cent-exact and ignores blank optional allocation rows', () => {
  const tuitionLines = [1, 2, 3].flatMap((termNumber) => ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment) => ({
    termNumber: String(termNumber), feeCategory: 'tuition', lineName: 'Tuition', installment,
    amount: termNumber === 1 && installment === 'Prelim' ? '100.10' : '0.00'
  })));
  const lines = normalizeLineRows([...tuitionLines,
    { termNumber: '2', feeCategory: 'activity', lineName: 'Tour', installment: 'Once', amount: '25.25', isOptional: 'on' }
  ]);
  assert.deepEqual(lines.slice(0, 12).map((line) => line.amount), ['0.00', '100.10', ...Array(10).fill('0.00')]);
  assert.equal(lines[12].isOptional, true);
  assert.deepEqual(tuitionInstallmentBreakdown(lines)[0].installments.map(({ label, configured, amount }) => [label, configured, amount]), [
    ['DP', true, '0.00'], ['Prelim', true, '100.10'], ['Midterm', true, '0.00'], ['Finals', true, '0.00']
  ]);
  assert.throws(() => normalizeLineRows(tuitionLines.slice(0, 11)), /each tuition installment/i);
  assert.throws(() => normalizeLineRows([...tuitionLines, { ...tuitionLines[0] }]), /one non-optional tuition amount/i);
  assert.deepEqual(normalizeAllocations({ allocations: [
    { chargeId: '1', amount: '10.01' }, { chargeId: '', amount: '' }, { chargeId: '2', amount: '' }
  ] }), [{ chargeId: 1, openingLiabilityId: null, amountCents: 1001n }]);
  assert.deepEqual(normalizeAllocations({ allocations: [
    { chargeId: '', openingLiabilityId: '12', amount: '5.00' }
  ] }), [{ chargeId: null, openingLiabilityId: 12, amountCents: 500n }]);
  assert.throws(() => normalizeAllocations({ allocations: [
    { chargeId: '1', amount: '10.00' }, { chargeId: '1', amount: '1.00' }
  ] }), AnnualFinanceError);
  assert.equal(parsePaymentDate('2026-09-30'), '2026-09-30');
  assert.throws(() => parsePaymentDate('2026-02-30'), AnnualFinanceError);
});

test('one approved capped discount is consumed across matching lines and matches the snapshot total', () => {
  const lines = applyExemptionPreview([
    { scheduleLineId: 11, termNumber: 1, category: 'tuition', lineName: 'Tuition', installment: 'Prelim', amount: '80.00' },
    { scheduleLineId: 12, termNumber: 1, category: 'tuition', lineName: 'Tuition', installment: 'Finals', amount: '70.00' }
  ], [{ id: 4, term_number: 1, fee_category: 'tuition', line_name: null,
    is_full_coverage: false, approved_amount: '100.00', applied_total: '0.00' }]);
  assert.deepEqual(lines.map((line) => [line.grossAmount, line.waivedAmount, line.amount]), [
    ['80.00', '80.00', '0.00'], ['70.00', '20.00', '50.00']
  ]);
  const snapshot = canonicalAssessmentSnapshot(lines);
  assert.equal(snapshot.total, '50.00');
  assert.equal(snapshot.lines.length, 2);
  assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/);
});

test('paper checklist rejects unsupported status, missing correction note, and counts beyond poster quantities before database access', async () => {
  let connectionAttempts = 0;
  const service = createPhysicalChecklistService({ getPool: async () => { connectionAttempts += 1; throw new Error('unexpected database access'); } });
  const base = { requirementCode: 'birth_certificate', status: 'received', idempotencyKey: uuid,
    originalsReceived: '0', copiesReceived: '3', piecesReceived: '0', isApplicable: '1' };
  await assert.rejects(service.recordRequirement('1', '1', { ...base, status: 'unknown' }), PhysicalChecklistError);
  await assert.rejects(service.recordRequirement('1', '1', { ...base, status: 'correction', note: '' }), /Enter a note/);
  await assert.rejects(service.recordRequirement('1', '1', { ...base, copiesReceived: '51' }), /between 0 and 50/);
  assert.equal(connectionAttempts, 0);
});
