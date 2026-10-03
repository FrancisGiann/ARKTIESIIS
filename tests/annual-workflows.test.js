const test = require('node:test');
const assert = require('node:assert/strict');

const { AnnualEnrollmentError, normalizeAnnualInput, normalizeAnnualAdministrationDetails, applySameSectionDefaults } = require('../src/services/annualEnrollmentService');
const {
  AnnualFinanceError, normalizeLineRows, normalizeAllocations, parsePaymentDate, applyExemptionPreview, canonicalAssessmentSnapshot,
  tuitionInstallmentBreakdown
} = require('../src/services/annualFinanceService');
const { PhysicalChecklistError, createPhysicalChecklistService, normalizeIntakeChecklistUpdates } = require('../src/services/physicalChecklistService');

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

test('intake checklist checkbox defaults to verified, omits unchecked rows, and enforces configured count types', async () => {
  const definitions = {
    birth_certificate: { requirement_code: 'birth_certificate', requirement_name: 'Birth Certificate', applicability: 'all', originals_required: 0, copies_required: 3, pieces_required: 0 },
    two_by_two_photo: { requirement_code: 'two_by_two_photo', requirement_name: '2x2 Picture', applicability: 'all', originals_required: 0, copies_required: 0, pieces_required: 3 },
    grade11_card: { requirement_code: 'grade11_card', requirement_name: 'Grade 11 Card', applicability: 'grade12', originals_required: 0, copies_required: 0, pieces_required: 0 },
    long_brown_envelopes: { requirement_code: 'long_brown_envelopes', requirement_name: 'Long Brown Envelopes', applicability: 'all', originals_required: 0, copies_required: 0, pieces_required: 2 }
  };
  const { tx, state } = mockChecklistTransaction(definitions);
  const service = createPhysicalChecklistService({ sql: mockChecklistSql() });
  const updates = normalizeIntakeChecklistUpdates({
    paper_birth_certificate_record: '1', paper_birth_certificate_applicable: '1', paper_birth_certificate_token: uuid,
    paper_birth_certificate_copies: '2',
    paper_two_by_two_photo_record: '1', paper_two_by_two_photo_applicable: '1', paper_two_by_two_photo_token: '51111111-1111-4111-8111-111111111111',
    paper_two_by_two_photo_pieces: '2',
    paper_grade11_card_record: '1', paper_grade11_card_applicable: '1', paper_grade11_card_token: '61111111-1111-4111-8111-111111111111'
  });
  assert.equal(updates.every((update) => update.status === 'verified'), true);
  assert.deepEqual(normalizeIntakeChecklistUpdates({}), []);
  const eventIds = await service.recordIntakeUpdatesInTransaction(tx, '7', '3', 'Grade 12', updates);
  assert.equal(eventIds.length, 3);
  assert.deepEqual(state.events.map(({ requirementCode, status, originals, copies, pieces }) => [requirementCode, status, originals, copies, pieces]), [
    ['birth_certificate', 'verified', 0, 2, 0],
    ['two_by_two_photo', 'verified', 0, 0, 2],
    ['grade11_card', 'verified', 0, 0, 0]
  ]);

  const invalidPhoto = normalizeIntakeChecklistUpdates({
    paper_two_by_two_photo_record: '1', paper_two_by_two_photo_applicable: '1', paper_two_by_two_photo_token: '71111111-1111-4111-8111-111111111111',
    paper_two_by_two_photo_originals: '1'
  });
  await assert.rejects(service.recordIntakeUpdatesInTransaction(tx, '7', '3', 'Grade 12', invalidPhoto), /Originals are not tracked/);
  const envelope = normalizeIntakeChecklistUpdates({
    paper_long_brown_envelopes_record: '1', paper_long_brown_envelopes_applicable: '1', paper_long_brown_envelopes_token: '81111111-1111-4111-8111-111111111111',
    paper_long_brown_envelopes_pieces: '2'
  });
  await assert.rejects(service.recordIntakeUpdatesInTransaction(tx, '7', '3', 'Grade 12', envelope), /storage containers/);
  assert.equal(state.events.length, 3, 'invalid count types and envelope submissions do not append events');
});

test('staff checklist rejects irrelevant counts and new envelope events, while named extra quantities remain optional', async () => {
  const definitions = {
    birth_certificate: { requirement_code: 'birth_certificate', requirement_name: 'Birth Certificate', applicability: 'all', originals_required: 0, copies_required: 3, pieces_required: 0 },
    long_brown_envelopes: { requirement_code: 'long_brown_envelopes', requirement_name: 'Long Brown Envelopes', applicability: 'all', originals_required: 0, copies_required: 0, pieces_required: 2 }
  };
  const { tx, state } = mockChecklistTransaction(definitions);
  const service = createPhysicalChecklistService({
    getPool: async () => ({}),
    sql: mockChecklistSql(),
    transactionFactory: () => tx
  });
  const base = { status: 'verified', idempotencyKey: uuid, isApplicable: '1', originalsReceived: '0', copiesReceived: '0', piecesReceived: '0' };
  await assert.rejects(service.recordRequirement('7', '3', { ...base, requirementCode: 'birth_certificate', originalsReceived: '1' }), /Originals are not tracked/);
  await assert.rejects(service.recordRequirement('7', '3', { ...base, requirementCode: 'long_brown_envelopes', piecesReceived: '2' }), /storage containers/);
  await service.recordRequirement('7', '3', { ...base, requirementCode: 'additional', requirementName: 'Custom form', piecesReceived: '2' });
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].requirementCode.startsWith('additional:'), true);
  assert.equal(state.rollbacks, 2);
  assert.equal(state.commits, 1);
});

test('active checklist queries exclude envelope while student history preserves old envelope events', async () => {
  const queries = [];
  const activeRequirement = { requirement_code: 'birth_certificate', requirement_name: 'Birth Certificate', guidance: '3 photocopies.',
    applicability: 'all', originals_required: 0, copies_required: 3, pieces_required: 0, is_optional: 0 };
  const oldEnvelopeEvent = { id: 99, requirement_code: 'long_brown_envelopes', requirement_name: 'Long Brown Envelopes', status: 'verified',
    note: null, is_applicable: 1, originals_received: 0, copies_received: 0, pieces_received: 2,
    created_at: '2026-09-01T00:00:00.000Z', recorded_by_name: 'Synthetic Registrar' };
  const pool = {
    request() {
      const inputs = {};
      return {
        input(name, _type, value) { inputs[name] = value; return this; },
        async query(query) {
          queries.push(query);
          if (query.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
          if (query.includes('SELECT student.id, student.student_no')) return { recordset: [{ id: 3, student_no: 'SHS-2026-0003', first_name: 'Synthetic', middle_name: null, last_name: 'Learner', suffix: null, grade_level: 'Grade 12' }] };
          if (query.includes('SELECT definition.requirement_code')) return { recordset: [activeRequirement] };
          if (query.includes('SELECT event.id, event.requirement_code')) return { recordset: [oldEnvelopeEvent] };
          if (query.includes('SELECT requirement_code, requirement_name, guidance')) return { recordset: [activeRequirement] };
          if (query.includes('WITH latest AS')) return { recordset: [{ student_id: 3, required_count: 1, completed_count: 0 }] };
          return { recordset: [] };
        }
      };
    }
  };
  const service = createPhysicalChecklistService({ getPool: async () => pool, sql: mockChecklistSql() });
  const checklist = await service.getStudentChecklist('7', '3');
  assert.deepEqual(checklist.requirements.map((item) => item.requirement_code), ['birth_certificate']);
  assert.deepEqual(checklist.history.map((item) => item.requirement_code), ['long_brown_envelopes']);
  assert.match(queries.find((query) => query.includes('SELECT definition.requirement_code')), /NOT IN \('sf10_form137', 'long_brown_envelopes'\)/);
  assert.doesNotMatch(queries.find((query) => query.includes('SELECT event.id, event.requirement_code') && !query.includes('definition.requirement_code')), /long_brown_envelopes/);

  await service.listIntakeRequirements('7');
  const intakeQuery = queries.find((query) => query.includes('SELECT requirement_code, requirement_name, guidance'));
  assert.match(intakeQuery, /NOT IN \('sf10_form137', 'long_brown_envelopes'\)/);
  await service.getStudentSummaries('7', ['3']);
  const summaryQuery = queries.find((query) => query.includes('WITH latest AS'));
  assert.match(summaryQuery, /NOT IN \('sf10_form137', 'long_brown_envelopes'\)/);
});

function mockChecklistSql() {
  return {
    ISOLATION_LEVEL: { SERIALIZABLE: 'serializable' },
    Int: 'int', TinyInt: 'tinyint', Bit: 'bit', UniqueIdentifier: 'uuid', Char: () => 'char', NVarChar: () => 'nvarchar', MAX: 'max'
  };
}

function mockChecklistTransaction(definitions) {
  const state = { events: [], commits: 0, rollbacks: 0 };
  const request = () => {
    const inputs = {};
    return {
      input(name, _type, value) { inputs[name] = value; return this; },
      async query(query) {
        if (query.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
        if (query.includes('FROM students WHERE id = @studentId')) return { recordset: [{ id: 3, status: 'active' }] };
        if (query.includes('FROM physical_requirement_definitions')) {
          return { recordset: definitions[inputs.requirementCode] ? [definitions[inputs.requirementCode]] : [] };
        }
        if (query.includes('FROM student_physical_checklist_events WHERE idempotency_key')) return { recordset: [] };
        if (query.includes('INSERT INTO student_physical_checklist_events')) {
          state.events.push({ requirementCode: inputs.requirementCode, status: inputs.status, originals: inputs.originals, copies: inputs.copies, pieces: inputs.pieces });
          return { insertId: state.events.length };
        }
        return { recordset: [] };
      }
    };
  };
  return {
    state,
    tx: {
      request,
      async begin() {},
      async commit() { state.commits += 1; },
      async rollback() { state.rollbacks += 1; }
    }
  };
}
