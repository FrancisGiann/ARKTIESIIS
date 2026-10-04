const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { AnnualEnrollmentError, createAnnualEnrollmentService, normalizeAnnualInput, normalizeAnnualAdministrationDetails, applySameSectionDefaults } = require('../src/services/annualEnrollmentService');
const {
  AnnualFinanceError, createAnnualFinanceService, normalizeLineRows, normalizeAllocations, parsePaymentDate, applyExemptionPreview, canonicalAssessmentSnapshot,
  tuitionInstallmentBreakdown, nonTuitionTermTotals
} = require('../src/services/annualFinanceService');
const { PhysicalChecklistError, createPhysicalChecklistService, normalizeIntakeChecklistUpdates } = require('../src/services/physicalChecklistService');
const { currentManilaDate, validateStudent } = require('../src/services/studentRecordsService');

const uuid = '41111111-1111-4111-8111-111111111111';

test('registrar preview selects the shared active schedule by PUB, ESC, or NV and preserves a saved assessment', async () => {
  const annualRecords = new Map([
    [71, { id: 71, student_id: 171, school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'PUB', entry_term_number: 1 }],
    [72, { id: 72, student_id: 172, school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'ESC', entry_term_number: 1 }],
    [73, { id: 73, student_id: 173, school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'NV', entry_term_number: 1 }]
  ]);
  const activeSchedules = new Map([
    ['PUB', { id: 301, version_no: 1, amount: '80.00' }],
    ['ESC', { id: 302, version_no: 4, amount: '60.00' }],
    ['NV', { id: 303, version_no: 2, amount: '45.00' }]
  ]);
  const savedAssessments = new Map();
  const queryCalls = [];
  const sql = { Int: 'INT', NVarChar: (length) => `VARCHAR(${length})` };
  const getPool = async () => ({
    request() {
      const inputs = {};
      return {
        input(name, _type, value) { inputs[name] = value; return this; },
        async query(statement) {
          const normalized = statement.replace(/\s+/g, ' ').trim();
          queryCalls.push({ statement: normalized, inputs: { ...inputs } });
          if (normalized.includes('FROM users WHERE id = @actorId')) return { recordset: [{ id: 2, role: 'registrar' }] };
          if (normalized.includes('FROM annual_enrollments AS annual')) {
            const parent = annualRecords.get(Number(inputs.annualEnrollmentId));
            return { recordset: parent ? [{ ...parent, student_no: `S-${parent.id}`, first_name: 'Synthetic', last_name: 'Learner' }] : [] };
          }
          if (normalized.includes('FROM annual_assessments AS assessment')) {
            const assessment = savedAssessments.get(Number(inputs.annualEnrollmentId));
            return { recordset: assessment ? [assessment] : [] };
          }
          if (normalized.includes('FROM finance_schedules')) {
            const schedule = activeSchedules.get(inputs.voucherCode);
            return { recordset: schedule ? [{ id: schedule.id, version_no: schedule.version_no }] : [] };
          }
          if (normalized.includes('FROM finance_schedule_lines')) {
            const schedule = [...activeSchedules.values()].find((item) => item.id === Number(inputs.scheduleId));
            return { recordset: schedule ? [{ id: schedule.id * 10, term_number: 1, fee_category: 'tuition', line_name: 'Tuition',
              installment: 'Other', amount: schedule.amount, is_optional: 0 }] : [] };
          }
          if (normalized.includes('FROM enrollments WHERE annual_enrollment_id')) {
            const annualId = Number(inputs.annualEnrollmentId);
            return { recordset: [1, 2, 3].map((termNumber) => ({ enrollment_id: annualId * 10 + termNumber,
              annual_term_number: termNumber, enrollment_status: 'pending_payment', term_scope_status: 'applicable' })) };
          }
          if (normalized.includes('FROM finance_exemption_cases AS exemption')) return { recordset: [] };
          if (normalized.includes('FROM assessed_charges AS charge')) {
            return { recordset: [{ id: 901, enrollment_id: 711, term_number: 1, fee_category: 'tuition', line_name: 'Tuition',
              installment: 'Other', schedule_line_id: 3010, is_optional: 0, amount: '80.00', waived_amount: '0.00' }] };
          }
          throw new Error(`Unexpected annual preview query: ${normalized}`);
        }
      };
    }
  });
  const service = createAnnualFinanceService({ getPool, sql });

  for (const [voucherCode, annualId, scheduleId, expectedTotal] of [
    ['PUB', 71, 301, '80.00'], ['ESC', 72, 302, '60.00'], ['NV', 73, 303, '45.00']
  ]) {
    queryCalls.length = 0;
    const preview = await service.annualAssessmentPreviewForRegistrar(2, annualId);
    assert.equal(preview.voucherCode, voucherCode);
    assert.equal(Number(preview.scheduleId), scheduleId);
    assert.equal(preview.total, expectedTotal);
    assert.deepEqual(preview.tuitionTermTotals, [{ termNumber: 1, amount: expectedTotal }, { termNumber: 2, amount: '0.00' }, { termNumber: 3, amount: '0.00' }]);
    const scheduleLookup = queryCalls.find(({ statement }) => statement.includes('FROM finance_schedules'));
    assert.equal(scheduleLookup.inputs.voucherCode, voucherCode);
    assert.match(scheduleLookup.statement, /voucher_code = @voucherCode AND status = 'active'/);
  }

  savedAssessments.set(71, { id: 801, schedule_id: 301, schedule_version: 1, voucher_code_snapshot: 'PUB', selection_json: '{}' });
  activeSchedules.set('PUB', { id: 399, version_no: 2, amount: '999.00' });
  queryCalls.length = 0;
  const savedPreview = await service.annualAssessmentPreviewForRegistrar(2, 71);
  assert.equal(savedPreview.existingAssessment, true);
  assert.equal(Number(savedPreview.scheduleId), 301);
  assert.equal(savedPreview.scheduleVersion, 1);
  assert.equal(savedPreview.total, '80.00');
  assert.equal(savedPreview.lines[0].installment, 'Other');
  assert.deepEqual(savedPreview.tuitionTermTotals[0], { termNumber: 1, amount: '80.00' });
  assert.equal(queryCalls.some(({ statement }) => statement.includes('FROM finance_schedules')), false,
    'the saved fee snapshot remains authoritative after Finance publishes a newer schedule');

});

test('confirmation snapshot reader excludes later charges and waivers and verifies the original gross amount fingerprint', async () => {
  const originalLine = {
    scheduleLineId: 11, termNumber: 2, category: 'tuition', lineName: 'Tuition', installment: 'Prelim',
    grossAmount: '100.00', waivedAmount: '15.00'
  };
  const snapshot = canonicalAssessmentSnapshot([originalLine]);
  const confirmation = {
    confirmation_id: 303, annual_enrollment_id: 71, assessment_id: 404, schedule_id: 9, schedule_version: 1,
    voucher_code_snapshot: 'PUB', payable_total: '85.00', selection_json: '{"optionalLineIds":[]}',
    assessment_snapshot_fingerprint: crypto.createHash('sha256').update(JSON.stringify({
      assessmentId: 404, scheduleId: 9, scheduleVersion: 1, voucherCode: 'PUB', payableTotal: '85.00',
      optionalLineIds: [], postedComposition: snapshot.fingerprint
    })).digest('hex'),
    confirmed_at: '2026-09-01 12:00:00', student_id: 171, school_year: '2026-2027',
    grade_level: 'Grade 11', entry_term_number: 2, student_no: 'S-71', first_name: 'Synthetic', last_name: 'Learner'
  };
  const chargeRows = [
    { id: 11, created_at: '2026-08-30 10:00:00', enrollment_id: 712, annual_term_number: 2,
      fee_category: 'tuition', line_name: 'Tuition', installment: 'Prelim', schedule_line_id: 11,
      is_optional: 0, amount: '100.00', gross_amount: '900.00', current_waived_amount: '35.00' },
    { id: 12, created_at: '2026-09-01 12:00:01', enrollment_id: 712, annual_term_number: 2,
      fee_category: 'activity', line_name: 'Later activity', installment: 'Once', schedule_line_id: null,
      is_optional: 0, amount: '25.00', gross_amount: '25.00', current_waived_amount: '0.00' }
  ];
  const applications = [
    { chargeId: 11, appliedAt: '2026-08-31 08:00:00', amount: '15.00' },
    { chargeId: 11, appliedAt: '2026-09-02 08:00:00', amount: '20.00' }
  ];
  const queryCalls = [];
  let actorRole = 'registrar';
  let includeFutureWaiver = false;
  const sql = { Int: 'INT', NVarChar: (length) => `VARCHAR(${length})` };
  const getPool = async () => ({
    request() {
      const inputs = {};
      return {
        input(name, _type, value) { inputs[name] = value; return this; },
        async query(statement) {
          const normalized = statement.replace(/\s+/g, ' ').trim();
          queryCalls.push({ statement: normalized, inputs: { ...inputs } });
          if (normalized.includes('FROM users')) return { recordset: [{ id: Number(inputs.actorId), role: actorRole }] };
          if (normalized.includes('FROM annual_registrar_confirmations AS confirmation')) return { recordset: [confirmation] };
          if (normalized.includes('FROM annual_assessments')) return { recordset: [{ selection_json: '{"optionalLineIds":[]}' }] };
          if (normalized.includes('FROM assessed_charges AS charge')) {
            const cutoff = Date.parse(confirmation.confirmed_at.replace(' ', 'T') + 'Z');
            return { recordset: chargeRows.filter((row) => Date.parse(row.created_at.replace(' ', 'T') + 'Z') <= cutoff).map((row) => ({
              term_number: row.annual_term_number, fee_category: row.fee_category, line_name: row.line_name,
              installment: row.installment, schedule_line_id: row.schedule_line_id, is_optional: row.is_optional,
              original_gross_amount: row.amount,
              confirmed_waived_amount: applications.filter((application) => application.chargeId === row.id
                && (includeFutureWaiver || Date.parse(application.appliedAt.replace(' ', 'T') + 'Z') <= cutoff))
                .reduce((sum, application) => sum + Number(application.amount), 0).toFixed(2)
            })) };
          }
          throw new Error(`Unexpected confirmation snapshot query: ${normalized}`);
        }
      };
    }
  });
  const service = createAnnualFinanceService({ getPool, sql });
  const savedSnapshot = await service.annualConfirmationAssessmentSnapshotForStaff(2, 71);
  assert.equal(savedSnapshot.total, '85.00');
  assert.equal(savedSnapshot.scheduleVersion, 1);
  assert.equal(savedSnapshot.voucherCode, 'PUB');
  assert.equal(savedSnapshot.lines.length, 1, 'a supplementary charge added after confirmation is excluded');
  assert.equal(savedSnapshot.lines[0].grossAmount, '100.00', 'the confirmation fingerprint uses the original charge.amount, not a later gross_amount value');
  assert.equal(savedSnapshot.lines[0].waivedAmount, '15.00', 'post-confirmation waiver applications do not change the printed snapshot');
  assert.equal(queryCalls.some(({ statement }) => statement.includes('FROM finance_schedules')), false);
  const chargeQuery = queryCalls.find(({ statement }) => statement.includes('FROM assessed_charges AS charge'))?.statement || '';
  assert.match(chargeQuery, /charge\.created_at <= confirmation\.confirmed_at/);
  assert.match(chargeQuery, /application\.applied_at <= confirmation\.confirmed_at/);
  assert.match(chargeQuery, /CAST\(charge\.amount AS CHAR\(40\)\) AS original_gross_amount/);

  actorRole = 'database_admin';
  const administratorCopy = await service.annualConfirmationAssessmentSnapshotForStaff(3, 71);
  assert.equal(administratorCopy.total, '85.00');
  assert.ok(queryCalls.some(({ statement }) => /role IN \('registrar', 'database_admin'\)/.test(statement)));

  includeFutureWaiver = true;
  await assert.rejects(service.annualConfirmationAssessmentSnapshotForStaff(3, 71), (error) => {
    assert.ok(error instanceof AnnualFinanceError);
    assert.equal(error.status, 409);
    assert.match(error.message, /could not be verified/);
    return true;
  }, 'the stored confirmation fingerprint rejects later coverage if an unfiltered amount slips into the read');
});

test('annual intake accepts explicit midyear entry with an optional future placement', () => {
  const valid = normalizeAnnualInput({
    studentNo: 'STU-2026-1', schoolYear: '2026-2027', gradeLevel: 'Grade 12', voucherCode: 'ESC',
    intakeKind: 'transferee', enrollmentStartDate: '2026-10-01', entryTermNumber: '2',
    voucherCategory: 'forged-stale-value', section2Id: '12', idempotencyKey: uuid
  });
  assert.equal(valid.isReturning, true);
  assert.equal(valid.intakeKind, 'transferee');
  assert.equal(valid.entryTermNumber, 2);
  assert.deepEqual(valid.sectionIds, [null, 12, null]);
  assert.equal(valid.voucherCategory, null, 'legacy or forged category data is ignored for new inputs');
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

test('new annual intake rejects malformed profile fields before hashing or database access', async () => {
  let poolCalls = 0;
  let hashCalls = 0;
  const service = createAnnualEnrollmentService({
    getPool: async () => { poolCalls += 1; throw new Error('database should not be reached'); },
    hashPassword: async () => { hashCalls += 1; return 'synthetic-hash'; }
  });
  const valid = {
    studentNo: '', email: 'learner@example.edu', lrn: '123456789012', firstName: 'Alex', middleName: '',
    lastName: 'Learner', suffix: '', birthDate: '', sex: '', phone: '', address: '', schoolYear: '2026-2027',
    gradeLevel: 'Grade 11', voucherCode: 'PUB', entryTermNumber: '1',
    enrollmentStartDate: '2026-10-03', sectionMode: 'same', annualSectionId: '8', idempotencyKey: uuid
  };
  const futureBirthDate = new Date(`${currentManilaDate()}T00:00:00.000Z`);
  futureBirthDate.setUTCDate(futureBirthDate.getUTCDate() + 1);
  for (const [change, message] of [
    [{ firstName: '12345' }, /First name must contain letters/],
    [{ middleName: '8' }, /Middle name must contain letters/],
    [{ lastName: '3578' }, /Last name must contain letters/],
    [{ sex: 'fish' }, /Choose Male, Female, or Other/],
    [{ phone: 'phone letters' }, /Phone must use digits/],
    [{ address: '123456789' }, /Address must include at least one letter/],
    [{ birthDate: currentManilaDate() }, /Birth date must be before today/],
    [{ birthDate: futureBirthDate.toISOString().slice(0, 10) }, /Birth date must be before today/],
    [{ lrn: 'letters' }, /LRN must contain exactly 12 digits/],
    [{ email: 'jojojo44' }, /valid contact email/]
  ]) {
    await assert.rejects(service.createAnnualIntake(7, { ...valid, ...change }), message);
  }
  assert.equal(poolCalls, 0);
  assert.equal(hashCalls, 0);
});

test('registrar voucher type updates preserve legacy category and keep assessment review controls', async () => {
  const statements = [];
  const state = { voucherCode: 'PUB', voucherCategory: 'D' };
  let auditDetails = null;
  let committed = false;
  let rolledBack = false;
  const sql = {
    Int: 'Int', MAX: 'MAX',
    NVarChar: (length) => `NVarChar(${length})`,
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }
  };
  const transaction = {
    async begin(level) { assert.equal(level, sql.ISOLATION_LEVEL.SERIALIZABLE); },
    async commit() { committed = true; },
    async rollback() { rolledBack = true; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          statements.push({ statement, values: { ...values } });
          if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
          if (statement.includes('SELECT annual.id, annual.voucher_code')) {
            return { recordset: [{ id: 71, voucher_code: state.voucherCode, voucher_category: state.voucherCategory, student_status: 'active' }] };
          }
          if (statement.includes('UPDATE annual_enrollments SET voucher_code')) {
            state.voucherCode = values.voucherCode;
            if (/voucher_category\s*=/.test(statement)) state.voucherCategory = values.voucherCategory;
            return { rowsAffected: [1] };
          }
          if (statement.includes('SELECT id FROM annual_assessments')) return { recordset: [{ id: 81 }] };
          if (statement.includes("'voucher_review_flagged'")) return { recordset: [] };
          if (statement.includes('INSERT INTO audit_logs')) {
            auditDetails = JSON.parse(values.detailsJson);
            return { recordset: [] };
          }
          throw new Error(`Unexpected query in voucher update test: ${statement}`);
        }
      };
    }
  };
  const service = createAnnualEnrollmentService({
    getPool: async () => ({}), sql, transactionFactory: () => transaction
  });

  const result = await service.updateVoucher(7, 71, 'ESC', 'Verified voucher type change');

  const update = statements.find(({ statement }) => statement.includes('UPDATE annual_enrollments SET voucher_code'));
  assert.ok(update);
  assert.match(update.statement, /voucher_code = @voucherCode/);
  assert.doesNotMatch(update.statement, /voucher_category\s*=/i);
  assert.equal(Object.hasOwn(update.values, 'voucherCategory'), false);
  assert.equal(state.voucherCode, 'ESC');
  assert.equal(state.voucherCategory, 'D');
  assert.ok(statements.some(({ statement, values }) => statement.includes("'voucher_review_flagged'") && values.reason === 'Verified voucher type change'));
  assert.deepEqual(result, { annualEnrollmentId: 71, assessmentReviewRequired: true });
  assert.equal(auditDetails.oldVoucherCategory, 'D');
  assert.equal(Object.hasOwn(auditDetails, 'voucherCategory'), false);
  assert.equal(auditDetails.assessmentReviewRequired, true);
  assert.equal(committed, true);
  assert.equal(rolledBack, false);
});

test('annual intake idempotency replays accept legacy null or category fingerprints but reject changed voucher types', async () => {
  const payload = {
    studentNo: '', email: 'learner@example.edu', lrn: '123456789012', firstName: 'Alex', middleName: '',
    lastName: 'Learner', suffix: '', birthDate: '', sex: '', phone: '', address: '', schoolYear: '2026-2027',
    gradeLevel: 'Grade 11', voucherCode: 'PUB', voucherCategory: 'stale-input-value', entryTermNumber: '1',
    enrollmentStartDate: '2026-10-03', sectionMode: 'same', annualSectionId: '8', idempotencyKey: uuid
  };
  const profileInput = validateStudent(payload, { requireStudentNo: false });
  const fingerprintFor = (voucherCode, category) => {
    // This is the pre-removal normalized shape, with category in its original property position.
    const legacyEntry = {
      isReturning: false, intakeKind: 'new', studentNo: null, email: 'learner@example.edu',
      schoolYear: '2026-2027', gradeLevel: 'Grade 11', voucherCode, voucherCategory: category,
      entryTermNumber: 1, enrollmentStartDate: '2026-10-03', sectionIds: [8, null, null],
      sectionMode: 'same', annualSectionId: 8, sectionOverrides: [false, false, false], idempotencyKey: uuid
    };
    return crypto.createHash('sha256')
      .update(JSON.stringify({ entry: legacyEntry, profileInput, checklistUpdates: [] })).digest('hex');
  };
  const makeReplayService = (voucherCategory, requestFingerprint) => {
    const sql = {
      Int: 'Int', MAX: 'MAX', UniqueIdentifier: 'UniqueIdentifier',
      NVarChar: (length) => `NVarChar(${length})`,
      ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }
    };
    const transaction = {
      async begin() {}, async commit() {}, async rollback() {},
      request() {
        const values = {};
        return {
          input(name, _type, value) { values[name] = value; return this; },
          async query(statement) {
            if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
            if (statement.includes('SELECT id AS annual_enrollment_id, student_id, request_fingerprint')) {
              return { recordset: [{ annual_enrollment_id: 71, student_id: 41, voucher_category: voucherCategory, request_fingerprint: requestFingerprint }] };
            }
            throw new Error(`Unexpected query during replay: ${statement}`);
          }
        };
      }
    };
    return createAnnualEnrollmentService({
      getPool: async () => ({}), sql, transactionFactory: () => transaction,
      hashPassword: async () => 'synthetic-hash', createPassword: () => 'synthetic-password'
    });
  };

  const nullReplay = await makeReplayService(null, fingerprintFor('PUB', null)).createAnnualIntake(7, payload);
  assert.equal(nullReplay.alreadyCreated, true);

  const categoryReplay = await makeReplayService('A', fingerprintFor('PUB', 'A')).createAnnualIntake(7, payload);
  assert.equal(categoryReplay.alreadyCreated, true);

  const changedVoucherPayload = { ...payload, voucherCode: 'ESC' };
  await assert.rejects(
    makeReplayService('A', fingerprintFor('PUB', 'A')).createAnnualIntake(7, changedVoucherPayload),
    (error) => error instanceof AnnualEnrollmentError && error.status === 409
  );
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

test('tuition breakdown requires exactly four configured nonoptional installments and respects entry term', () => {
  const labels = ['DP', 'Prelim', 'Midterm', 'Finals'];
  const lines = [1, 2, 3].flatMap((termNumber) => labels.map((installment, index) => ({
    termNumber, category: 'tuition', lineName: 'Tuition', installment,
    amount: termNumber === 2 && index === 0 ? '0.01' : termNumber === 2 && index === 1 ? '0.02' : '0.00',
    isOptional: false
  })));
  lines.push({ termNumber: 2, category: 'miscellaneous', lineName: 'Demo miscellaneous fee', installment: 'Term 2', amount: '4.75' });

  const breakdown = tuitionInstallmentBreakdown(lines, 2);
  assert.equal(breakdown[0].complete, true, 'pre-entry terms are not applicable');
  assert.equal(breakdown[1].complete, true);
  assert.deepEqual(breakdown[1].installments.map(({ label, configured, amount }) => [label, configured, amount]), [
    ['DP', true, '0.01'], ['Prelim', true, '0.02'], ['Midterm', true, '0.00'], ['Finals', true, '0.00']
  ]);
  assert.deepEqual(nonTuitionTermTotals(lines, 2), [
    { termNumber: 2, amount: '4.75' }, { termNumber: 3, amount: '0.00' }
  ]);

  assert.equal(tuitionInstallmentBreakdown(lines.filter((line) => !(line.termNumber === 2 && line.installment === 'Finals')), 2)[1].complete, false,
    'a missing zero-valued installment is still incomplete');
  assert.equal(tuitionInstallmentBreakdown([...lines, { ...lines[4], amount: '1.00' }], 2)[1].complete, false,
    'duplicate canonical tuition rows are ambiguous');
  assert.equal(tuitionInstallmentBreakdown(lines.map((line) => line.termNumber === 2 && line.installment === 'Midterm'
    ? { ...line, isOptional: true } : line), 2)[1].complete, false,
  'an optional tuition line cannot stand in for the required schedule');
  assert.equal(tuitionInstallmentBreakdown(lines.map((line) => line.termNumber === 2 && line.installment === 'Prelim'
    ? { ...line, installment: 'Term 2' } : line), 2)[1].complete, false,
  'a legacy term label is not treated as an installment');
});

test('schedule version service rejects a changed predecessor inside its serializable transaction', async () => {
  const queries = [];
  let rolledBack = false;
  const sql = {
    Int: 'INT', TinyInt: 'TINYINT', UniqueIdentifier: 'UUID',
    NVarChar: (length) => `VARCHAR(${length})`,
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }
  };
  const transaction = {
    async begin(level) { assert.equal(level, sql.ISOLATION_LEVEL.SERIALIZABLE); },
    async commit() { assert.fail('stale predecessor must not commit'); },
    async rollback() { rolledBack = true; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          queries.push({ statement, values: { ...values } });
          if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 14, role: 'finance' }] };
          if (statement.includes('SELECT id, version_no, request_fingerprint')) return { recordset: [] };
          if (statement.includes('SELECT id, version_no, status FROM finance_schedules')) {
            return { recordset: [{ id: 92, version_no: 2, status: 'active' }] };
          }
          throw new Error(`Unexpected query in predecessor guard test: ${statement}`);
        }
      };
    }
  };
  const service = createAnnualFinanceService({ getPool: async () => ({}), sql, transactionFactory: () => transaction });
  const lines = [1, 2, 3].flatMap((termNumber) => ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment) => ({
    termNumber: String(termNumber), feeCategory: 'tuition', lineName: 'Tuition', installment, amount: '0.00'
  })));

  await assert.rejects(service.createSchedule(14, {
    schoolYear: '2026-2027', gradeLevel: 'Grade 11', voucherCode: 'PUB', lines,
    idempotencyKey: uuid, expectedPreviousSchedule: { scheduleId: 91, versionNo: 1 }
  }), (error) => error instanceof AnnualFinanceError && error.status === 409 && /changed while this update was prepared/i.test(error.message));

  assert.match(queries.find(({ statement }) => statement.includes('SELECT id, version_no, status FROM finance_schedules')).statement, /ORDER BY version_no DESC FOR UPDATE/);
  assert.equal(queries.some(({ statement }) => statement.includes('INSERT INTO finance_schedules')), false);
  assert.equal(rolledBack, true);
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
  const studentQuery = queries.find((query) => query.includes('SELECT student.id, student.student_no'));
  assert.match(studentQuery, /AS section_rank/);
  assert.match(studentQuery, /ranked\.section_rank = 1/);
  assert.doesNotMatch(studentQuery, /AS row_number|ranked\.row_number/);
  assert.match(queries.find((query) => query.includes('SELECT definition.requirement_code')), /NOT IN \('sf10_form137', 'long_brown_envelopes'\)/);
  const requirementQuery = queries.find((query) => query.includes('SELECT definition.requirement_code'));
  assert.match(requirementQuery, /AS event_rank/);
  assert.match(requirementQuery, /ranked\.event_rank = 1/);
  assert.doesNotMatch(requirementQuery, /AS row_number|ranked\.row_number/);
  assert.doesNotMatch(queries.find((query) => query.includes('SELECT event.id, event.requirement_code') && !query.includes('definition.requirement_code')), /long_brown_envelopes/);

  await service.listIntakeRequirements('7');
  const intakeQuery = queries.find((query) => query.includes('SELECT requirement_code, requirement_name, guidance'));
  assert.match(intakeQuery, /NOT IN \('sf10_form137', 'long_brown_envelopes'\)/);
  await service.getStudentSummaries('7', ['3']);
  const summaryQuery = queries.find((query) => query.includes('WITH latest AS'));
  assert.match(summaryQuery, /NOT IN \('sf10_form137', 'long_brown_envelopes'\)/);
  assert.match(summaryQuery, /AS section_rank/);
  assert.match(summaryQuery, /ranked\.section_rank = 1/);
  assert.doesNotMatch(summaryQuery, /AS row_number|ranked\.row_number/);
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
