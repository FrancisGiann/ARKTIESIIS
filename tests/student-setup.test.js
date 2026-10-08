const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const session = require('express-session');
const {
  StudentSetupError,
  normalizeBulkRows,
  createStudentSetupService
} = require('../src/services/studentSetupService');
const { createStudentBulkAccountsRouter, createStudentIntakeRouter, createAnnualStudentIntakeRouter,
  createAnnualConfirmationRouter } = require('../src/routes/studentSetup');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');
const { AnnualEnrollmentError } = require('../src/services/annualEnrollmentService');
const { latestBirthDate } = require('../src/services/studentRecordsService');
const { validateTransaction, createFinanceService } = require('../src/services/financeService');

function fakeSql() {
  return {
    MAX: 'MAX', Int: 'Int', Bit: 'Bit', Date: 'Date',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
    NVarChar: (length) => 'NVarChar(' + length + ')',
    Decimal: (precision, scale) => 'Decimal(' + precision + ',' + scale + ')'
  };
}

function generatedStudentNumberQuery(statement) {
  return statement.includes('SELECT SUBSTRING(student_no');
}

function setupFixture(onQuery, { hashPassword = async (password) => 'bcrypt:' + password, createPassword } = {}) {
  const log = { queries: [], isolation: null, committed: false, rolledBack: false };
  const execute = async (statement, values, inTransaction) => {
    const call = { statement, values: { ...values }, inTransaction };
    log.queries.push(call);
    return onQuery(call);
  };
  const getPool = async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        query(statement) { return execute(statement, values, false); }
      };
    }
  });
  const transactionFactory = () => ({
    async begin(isolation) { log.isolation = isolation; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        query(statement) { return execute(statement, values, true); }
      };
    },
    async commit() { log.committed = true; },
    async rollback() { log.rolledBack = true; }
  });
  return {
    log,
    service: createStudentSetupService({ getPool, sql: fakeSql(), transactionFactory, hashPassword, createPassword })
  };
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const admin = { id: 4, role: 'database_admin' };
const registrar = { id: 5, role: 'registrar' };
const rosterRows = [
  { rowNumber: 2, studentNo: 'ST-101', email: 'one@example.edu' },
  { rowNumber: 3, studentNo: 'ST-102', email: 'two@example.edu' }
];
const unlinkedRows = rosterRows.map((row) => ({
  row_number: row.rowNumber, student_id: row.rowNumber + 10, user_id: null,
  student_status: 'active', email_user_id: null, pending_email_id: null
}));
const fixturePreEnrollmentId = '0e0ec641-ff2a-4474-9030-aafcc0d593ad';
function readyPreEnrollmentFixture(overrides = {}) {
  return {
    id: fixturePreEnrollmentId, version: 3, status: 'ready_for_registrar', created_by_role: 'front_desk',
    applicant_kind: 'new', school_year: '2026-2027', target_grade_level: 'Grade 11',
    first_name: 'Jamie', middle_name: 'Rae', last_name: 'Lee', suffix: '', lrn: '123456789012',
    email: 'learner@example.edu', birth_date: '2008-04-21', sex: 'Female', profile_phone: '09171234567',
    address: '25 Mabini Street', emergency_contact_person: 'Morgan Lee', emergency_contact_phone: '09170000000',
    emergency_contact_address: 'Lucena, Quezon', preferred_track: 'Academic Track', preferred_cluster: 'ASSH',
    voucher_type_text: 'ESC as written', voucher_category_text: 'Category A', prior_grade_level: 'Grade 10',
    prior_school: 'Lucena High School', student_signature_present: 1, student_signed_date: '2026-10-01',
    received_by: 'Front Desk Operator', received_date: '2026-10-02', receipts: [], ...overrides
  };
}

test('bulk roster validation reports missing fields and case-insensitive duplicates', () => {
  const rows = normalizeBulkRows([
    { rowNumber: 2, studentNo: 'ST-1', email: 'same@example.edu' },
    { rowNumber: 3, studentNo: 'st-1', email: 'other@example.edu' },
    { rowNumber: 4, studentNo: 'ST-3', email: 'SAME@example.edu' },
    { rowNumber: 5, studentNo: '', email: '' }
  ]);
  assert.equal(rows.length, 3);
  assert.match(rows[1].errors.join(' '), /duplicates workbook row 2/);
  assert.match(rows[2].errors.join(' '), /Email duplicates workbook row 2/);
  assert.throws(() => normalizeBulkRows(Array.from({ length: 101 }, (_, index) => ({
    rowNumber: index + 2, studentNo: 'ST-' + index, email: 'student' + index + '@example.edu'
  }))), /1 to 100 student rows/);
});

test('bulk setup revalidates all rows and rolls back if a student became linked', async () => {
  const fixture = setupFixture(({ statement }) => {
    if (statement.includes('SELECT id, role FROM users')) return { recordset: [admin] };
    if (statement.includes('WITH input_rows AS')) {
      return { recordset: [unlinkedRows[0], { ...unlinkedRows[1], user_id: 77 }] };
    }
    throw new Error('Unexpected query: ' + statement);
  });
  await assert.rejects(fixture.service.createBulkStudentAccounts(4, rosterRows), (error) => {
    assert.ok(error instanceof StudentSetupError);
    assert.equal(error.status, 409);
    assert.match(error.details[1].errors.join(' '), /already has a linked login account/);
    return true;
  });
  assert.equal(fixture.log.rolledBack, true);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO users')), false);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('UPDATE students')), false);
});

test('bulk setup returns distinct temporary credentials while storing bcrypt hashes only', async () => {
  let nextUserId = 20;
  const fixture = setupFixture(({ statement, values }) => {
    if (statement.includes('SELECT id, role FROM users')) return { recordset: [admin] };
    if (statement.includes('WITH input_rows AS')) return { recordset: unlinkedRows };
    if (statement.includes('INSERT INTO users')) return { insertId: nextUserId++ };
    if (statement.includes('UPDATE students')) return { affectedRows: 1 };
    if (statement.includes('INSERT INTO audit_logs')) {
      assert.doesNotMatch(values.detailsJson, /one@example|two@example|temp-/);
      return { recordset: [] };
    }
    throw new Error('Unexpected query: ' + statement);
  }, {
    hashPassword: async (password, rounds) => { assert.equal(rounds, 12); return 'bcrypt:' + password; },
    createPassword: (() => { let count = 0; return () => 'temp-' + (++count); })()
  });
  const credentials = await fixture.service.createBulkStudentAccounts(4, rosterRows);
  assert.deepEqual(credentials.map(({ studentNo, email, password }) => [studentNo, email, password]), [
    ['ST-101', 'one@example.edu', 'temp-1'], ['ST-102', 'two@example.edu', 'temp-2']
  ]);
  assert.equal(fixture.log.isolation, 'SERIALIZABLE');
  assert.equal(fixture.log.committed, true);
  const writes = fixture.log.queries.filter(({ statement }) => statement.includes('INSERT INTO users'));
  assert.deepEqual(writes.map(({ values }) => values.passwordHash), ['bcrypt:temp-1', 'bcrypt:temp-2']);
  assert.ok(writes.every(({ statement }) => statement.includes('must_change_password')));
});

test('legacy registrar intake creation and activation services are retired without database writes', async () => {
  const fixture = setupFixture(() => { throw new Error('retired workflow must not query the database'); });
  await assert.rejects(fixture.service.createEnrollmentIntake(5, { lrn: '123456789012' }),
    (error) => error instanceof StudentSetupError && error.status === 409 && /front-desk paper source/.test(error.message));
  await assert.rejects(fixture.service.finalizeEnrollment(5, 51),
    (error) => error instanceof StudentSetupError && error.status === 409 && /annual enrollment workflow/.test(error.message));
  await assert.rejects(fixture.service.listLegacyActivationCandidates(5),
    (error) => error instanceof StudentSetupError && error.status === 409);
  await assert.rejects(fixture.service.confirmLegacyInitialActivation(5, 51, {}),
    (error) => error instanceof StudentSetupError && error.status === 409);
  assert.equal(fixture.log.queries.length, 0);
});

test('legacy intake URLs only redirect or reject; retained form views are not reachable workflow', async () => {
  let serviceCalls = 0;
  const app = express();
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: 'student-setup-compatibility-test-secret', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => { req.session.csrfToken = 'fixture-csrf'; next(); });
  app.use('/registrar/intake/legacy', createStudentIntakeRouter({ studentSetupService: {
    async listPendingIntakes() { serviceCalls += 1; return []; },
    async loadIntakeOptions() { serviceCalls += 1; return { terms: [], sections: [] }; },
    async listLegacyActivationCandidates() { serviceCalls += 1; return []; }
  } }));

  await withServer(app, async (baseUrl) => {
    const list = await fetch(`${baseUrl}/registrar/intake/legacy`, { redirect: 'manual' });
    assert.equal(list.status, 303);
    assert.equal(list.headers.get('location'), '/pre-enrollments');

    const create = await fetch(`${baseUrl}/registrar/intake/legacy/new`, { redirect: 'manual' });
    assert.equal(create.status, 303);
    assert.equal(create.headers.get('location'), '/registrar/intake/new');

    const activation = await fetch(`${baseUrl}/registrar/intake/legacy/activation`, { redirect: 'manual' });
    assert.equal(activation.status, 303);
    assert.equal(activation.headers.get('location'), '/registrar/intake');

    const rejectedCreate = await fetch(`${baseUrl}/registrar/intake/legacy`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'fixture-csrf' })
    });
    assert.equal(rejectedCreate.status, 409);
    assert.match(await rejectedCreate.text(), /Create new student intake through a front-desk paper source/);
    assert.equal(serviceCalls, 0);
  });
});

test('registrar intake opens the guided annual form and links the roster to fee confirmation and paper records', async () => {
  const app = express();
  const preEnrollmentId = 'a342bc01-2a68-4f19-a7fd-4d5bb1d83261';
  const preEnrollmentRecord = {
    id: preEnrollmentId, version: 3, status: 'ready_for_registrar', created_by_role: 'front_desk',
    school_year: '2026-2027', target_grade_level: 'Grade 11', applicant_kind: 'new',
    first_name: 'Jamie', middle_name: 'Rae', last_name: 'Lee', suffix: '', lrn: '123456789012',
    email: 'learner@example.edu', birth_date: '2008-04-21', sex: 'Female', profile_phone: '09171234567',
    address: '25 Mabini Street', emergency_contact_person: 'Morgan Lee', emergency_contact_phone: '09170000000',
    emergency_contact_address: 'Lucena, Quezon', preferred_track: 'Academic Track', preferred_cluster: 'ASSH',
    voucher_type_text: 'ESC as written', voucher_category_text: 'Category A', prior_grade_level: 'Grade 10',
    prior_school: 'Lucena High School', student_signature_present: 1, student_signed_date: '2026-10-01',
    received_by: 'Front Desk Operator', received_date: '2026-10-02', receipts: []
  };
  let confirmationCall = null;
  let hasConfirmed = false;
  const session = {};
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.formatStudentPlacement = require('../src/utils/formatStudentPlacement').formatStudentPlacement;
  app.locals.formatMoney = require('../src/utils/formatMoney').formatMoney;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { req.authUser = registrar; req.session = session; next(); });
  const annualEnrollmentService = {
    async loadIntakeOptions() {
      return {
        schoolYears: [{ school_year: '2026-2027' }],
        terms: [1, 2, 3].map((number) => ({ id: number, school_year: '2026-2027', term: `Term ${number}`, annual_term_number: number, is_current: number === 1 })),
        sections: [1, 2, 3].map((number) => ({ id: number + 7, name: 'Mabini', grade_level: 'Grade 11', academic_term_id: number, school_year: '2026-2027', term: `Term ${number}`, cluster: 'A', strand: 'STEM', adviser: 'Synthetic Adviser', modality: 'face_to_face' }))
      };
    },
    async listAnnualEnrollments() { return [{ annual_enrollment_id: 71, enrollment_id: 51, student_id: 41, student_no: 'SHS-2026-0321', first_name: 'Synthetic', last_name: 'Learner', email: 'learner@example.edu', school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'PUB', voucher_category: 'D', entry_term_number: 1, term: 'Term 1', section_id: 8, section_name: 'Mabini', term_scope_status: 'applicable', annual_term_number: 1, enrollment_status: 'pending_payment', signed_clearance_status: 'not signed' }]; },
    async listAnnualEnrollmentCounts() { return [{ school_year: '2026-2027', grade_level: 'Grade 11', term: 'Term 1', annual_term_number: 1, section_name: 'Mabini', cluster: 'A', strand: 'STEM', gender: 'Not recorded', enrollment_status: 'pending_payment', student_count: 1 }]; },
    async getAnnualManagementRecord(actorId, annualId) {
      assert.equal(actorId, registrar.id);
      assert.equal(String(annualId), '71');
      return {
        parent: { annual_enrollment_id: 71, student_id: 41, student_no: 'SHS-2026-0321', lrn: '123456789012',
          first_name: 'Synthetic', middle_name: 'Casey', last_name: 'Learner', suffix: '', birth_date: '2008-04-21',
          sex: 'Female', address: '25 Mabini Street', phone: '09171234567', student_email: 'learner@example.edu',
          school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'PUB', intake_kind: 'standard',
          entry_term_number: 1, enrollment_start_date: '2026-10-03', intake_status: 'pending',
          registrar_confirmation_id: hasConfirmed ? 101 : null,
          registrar_confirmed_at: hasConfirmed ? '2026-10-04 00:00:00' : null,
          registrar_assessment_id: hasConfirmed ? 201 : null,
          registrar_schedule_id: hasConfirmed ? 9 : null,
          registrar_schedule_version: hasConfirmed ? 2 : null,
          registrar_voucher_code_snapshot: hasConfirmed ? 'PUB' : null,
          registrar_payable_total: hasConfirmed ? '1334.50' : null }
        , terms: [1, 2, 3].map((number) => ({ annual_term_number: number, term: number === 2 ? 'Second term' : `Term ${number}`, grade_level: 'Grade 11',
          section_name: 'Mabini', cluster: 'Academic', strand: 'STEM', modality: 'face_to_face', section_id: number + 7,
          term_scope_status: 'applicable', enrollment_status: 'pending_payment' }))
      };
    },
    async confirmAnnualEnrollment(actorId, annualId, input) {
      confirmationCall = { actorId, annualId, input };
      hasConfirmed = true;
      return { annualEnrollmentId: 71, studentId: 41, studentNo: 'SHS-2026-0321', firstName: 'Synthetic', lastName: 'Learner', schoolYear: '2026-2027', gradeLevel: 'Grade 11', term: 'Term 1', sectionName: 'Mabini', total: '1334.50', temporaryPassword: 'synthetic-one-time-credential' };
    }
  };
  const feePreview = {
    parent: { first_name: 'Synthetic', last_name: 'Learner', student_no: 'SHS-2026-0321', school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'PUB' },
    scheduleId: 9, scheduleVersion: 2, voucherCode: 'PUB', assessmentId: null, existingAssessment: false,
    total: '1234.50', totalCents: 123450, optionalLineIds: [],
    optionalLines: [{ id: 90, termNumber: 1, lineName: 'Tour', installment: 'Once', amount: '100.00', selected: false }],
    termTotals: [{ termNumber: 1, amount: '1234.50' }, { termNumber: 2, amount: '0.00' }, { termNumber: 3, amount: '0.00' }],
    tuitionTermTotals: [{ termNumber: 1, amount: '1234.50' }, { termNumber: 2, amount: '0.00' }, { termNumber: 3, amount: '0.00' }],
    nonTuitionTermTotals: [{ termNumber: 1, amount: '0.00' }, { termNumber: 2, amount: '0.00' }, { termNumber: 3, amount: '0.00' }],
    tuitionBreakdownComplete: false,
    tuitionBreakdown: [1, 2, 3].map((termNumber) => ({
      termNumber, complete: false, installments: ['DP', 'Prelim', 'Midterm', 'Finals'].map((label) => ({
        label, configured: false, amount: null
      }))
    })),
    lines: [{ termNumber: 1, lineName: 'Tuition', category: 'tuition', installment: 'Prelim', grossAmount: '1234.50', waivedAmount: '0.00', amount: '1234.50', isOptional: false }],
    snapshotFingerprint: 'a'.repeat(64)
  };
  const feePreviewCalls = [];
  const checklistFixture = {
    student: { id: 41 }, summary: { completeCount: 1, requiredCount: 2 }, history: [], additionalItems: [],
    requirements: [
      { requirement_code: 'birth_certificate', requirement_name: 'Birth Certificate', is_optional: 0,
        is_applicable: 1, status: 'received', originals_required: 0, copies_required: 3, pieces_required: 0,
        originals_received: 0, copies_received: 3, pieces_received: 0, note: 'Staff checked all copies.' },
      { requirement_code: 'good_moral', requirement_name: 'Good Moral Certificate', is_optional: 0,
        is_applicable: 1, status: 'pending', originals_required: 1, copies_required: 1, pieces_required: 0,
        originals_received: 0, copies_received: 0, pieces_received: 0, note: null },
      { requirement_code: 'grade11_card', requirement_name: 'Grade 11 Card', is_optional: 0,
        is_applicable: 0, status: 'verified', originals_required: 0, copies_required: 0, pieces_required: 0,
        originals_received: 0, copies_received: 0, pieces_received: 0, note: null }
    ]
  };
  const previewFees = async (actorId, annualId, selectedInput = []) => {
    assert.equal(actorId, registrar.id);
    assert.equal(String(annualId), '71');
    const selected = (Array.isArray(selectedInput) ? selectedInput : [selectedInput]).filter(Boolean).map(Number);
    feePreviewCalls.push(selected);
    if (hasConfirmed) return {
      ...feePreview,
      scheduleId: 9, scheduleVersion: 2, assessmentId: 201, existingAssessment: true,
      optionalLineIds: [90], total: '1334.50', totalCents: 133450,
      termTotals: [{ termNumber: 1, amount: '1334.50' }, { termNumber: 2, amount: '0.00' }, { termNumber: 3, amount: '0.00' }],
      lines: [...feePreview.lines, { termNumber: 1, lineName: 'Tour', category: 'activity', installment: 'Once', grossAmount: '100.00', waivedAmount: '0.00', amount: '100.00', isOptional: true }]
    };
    const includeTour = selected.includes(90);
    return {
      ...feePreview,
      optionalLineIds: includeTour ? [90] : [],
      optionalLines: [{ ...feePreview.optionalLines[0], selected: includeTour }],
      lines: includeTour ? [...feePreview.lines, {
        termNumber: 1, lineName: 'Tour', category: 'activity', installment: 'Once', grossAmount: '100.00',
        waivedAmount: '0.00', amount: '100.00', isOptional: true
      }] : feePreview.lines,
      total: includeTour ? '1334.50' : '1234.50',
      totalCents: includeTour ? 133450 : 123450,
      nonTuitionTermTotals: [{ termNumber: 1, amount: includeTour ? '100.00' : '0.00' }, { termNumber: 2, amount: '0.00' }, { termNumber: 3, amount: '0.00' }],
      termTotals: [{ termNumber: 1, amount: includeTour ? '1334.50' : '1234.50' }, { termNumber: 2, amount: '0.00' }, { termNumber: 3, amount: '0.00' }]
    };
  };
  const paperRequirements = [
    { requirement_code: 'birth_certificate', requirement_name: 'Birth Certificate', guidance: '3 photocopies.', applicability: 'all', originals_required: 0, copies_required: 3, pieces_required: 0 },
    { requirement_code: 'good_moral', requirement_name: 'Good Moral Certificate', guidance: 'Original + 1 photocopy.', applicability: 'all', originals_required: 1, copies_required: 1, pieces_required: 0 },
    { requirement_code: 'two_by_two_photo', requirement_name: '2x2 Picture', guidance: '3 pieces.', applicability: 'all', originals_required: 0, copies_required: 0, pieces_required: 3 },
    { requirement_code: 'grade11_card', requirement_name: 'Grade 11 Card', guidance: 'Grade 11 card applies to Grade 12 learners.', applicability: 'grade12', originals_required: 0, copies_required: 0, pieces_required: 0 }
  ];
  app.use('/registrar/intake', createAnnualStudentIntakeRouter({ annualEnrollmentService,
    preEnrollmentService: {
      async openConversion(actorId, id) {
        assert.equal(actorId, registrar.id);
        assert.equal(id, preEnrollmentId);
        return { alreadyStarted: false, record: preEnrollmentRecord };
      },
      async get(actorId, id) { assert.equal(actorId, registrar.id); assert.equal(id, preEnrollmentId); return preEnrollmentRecord; }
    },
    physicalChecklistService: {
      async listIntakeRequirements() { return paperRequirements; },
      async getStudentChecklist(actorId, studentId) {
        assert.equal(actorId, registrar.id);
        assert.equal(Number(studentId), 41);
        return checklistFixture;
      }
    },
    annualFinanceService: {
      annualAssessmentPreviewForRegistrar: previewFees,
      async annualConfirmationAssessmentSnapshotForStaff(actorId, annualId) {
        assert.equal(actorId, registrar.id);
        assert.equal(String(annualId), '71');
        return previewFees(actorId, annualId);
      }
    },
    termClearanceService: {
      async getAnnualPrerequisiteReview() { return { ready: true, kind: 'new_student', terms: [], blockers: [], fingerprint: 'clearance-review-fingerprint' }; }
    }
  }));
  await withServer(app, async (baseUrl) => {
    const unsourced = await fetch(`${baseUrl}/registrar/intake/new`, { redirect: 'manual' });
    assert.equal(unsourced.status, 303);
    assert.equal(unsourced.headers.get('location'), '/pre-enrollments');
    const response = await fetch(`${baseUrl}/registrar/intake/new?preEnrollmentId=${preEnrollmentId}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Student details/);
    assert.match(html, /Enrollment details/);
    assert.match(html, /Paper document review/);
    assert.match(html, /Step 4 of 5: Fees/);
    assert.match(html, /Step 5 of 5: Review details/);
    assert.match(html, /missing papers do not block enrollment/i);
    assert.match(html, /Select a paper only after staff has received and checked it/i);
    assert.match(html, /long brown envelope; the envelope is a storage container and is not tracked/i);
    assert.match(html, /name="paper_birth_certificate_copies"/);
    assert.doesNotMatch(html, /name="paper_birth_certificate_(?:originals|pieces)"/);
    assert.match(html, /name="paper_good_moral_originals"/);
    assert.match(html, /name="paper_good_moral_copies"/);
    assert.match(html, /name="paper_two_by_two_photo_pieces"/);
    assert.doesNotMatch(html, /name="paper_two_by_two_photo_(?:originals|copies)"/);
    assert.doesNotMatch(html, /name="paper_grade11_card_(?:originals|copies|pieces)"/);
    const zeroCountCardRow = html.match(/<article class="paper-checklist-row" data-requirement-applicability="grade12">[\s\S]*?<\/article>/)?.[0];
    assert.ok(zeroCountCardRow);
    assert.doesNotMatch(zeroCountCardRow, /<details/);
    assert.doesNotMatch(html, /long_brown_envelopes|name="paper_[a-z0-9_]+_status"/);
    assert.match(html, /Front-desk paper source/);
    assert.match(html, /Review the saved front-desk profile/);
    assert.match(html, /name="preEnrollmentId" value="a342bc01-2a68-4f19-a7fd-4d5bb1d83261"/);
    assert.doesNotMatch(html, /name="(?:firstName|middleName|lastName|lrn|email|birthDate|sex|phone|address)"/);
    assert.match(html, /src="\/js\/annual-intake-form.js"/);
    assert.match(html, /name="section1Id"/);
    assert.match(html, /name="section2Id"/);
    assert.match(html, /name="section3Id"/);
    assert.match(html, /Voucher type/);
    assert.doesNotMatch(html, /name="voucherCategory"/i);
    const pending = await fetch(`${baseUrl}/registrar/intake`);
    const pendingHtml = await pending.text();
    assert.equal(pending.status, 200);
    assert.match(pendingHtml, /SHS-2026-0321/);
    assert.match(pendingHtml, /Voucher PUB/);
    assert.match(pendingHtml, /Update voucher/);
    assert.doesNotMatch(pendingHtml, /Category D|name="voucherCategory"/);
    assert.match(pendingHtml, /Enrollment confirmation/);
    assert.match(pendingHtml, /Review fees and confirm enrollment/);
    assert.match(pendingHtml, /Paper requirements checklist/);
    assert.match(pendingHtml, /Enrollment counts/);
    assert.match(pendingHtml, /data-label="Students"><strong>1/);

    const fees = await fetch(`${baseUrl}/registrar/intake/71/fees`);
    const feesHtml = await fees.text();
    assert.equal(fees.status, 200);
    assert.match(fees.headers.get('cache-control'), /no-store/);
    assert.match(feesHtml, /<title>Review enrollment fees \| ARKTIESIIS<\/title>/);
    assert.match(feesHtml, /Student payable/);
    assert.match(feesHtml, /View itemized fee breakdown/);
    assert.match(feesHtml, /Update fee total/);
    assert.match(feesHtml, /name="idempotencyKey" value="[0-9a-f-]{36}"/);
    assert.match(feesHtml, /data-fee-review/);
    assert.match(feesHtml, /<form[^>]*class="fee-optional-choice"[^>]*data-fee-review[^>]*>[\s\S]*name="optionalLineIds"[\s\S]*formaction="\/registrar\/intake\/71\/review"/);
    assert.match(feesHtml, /Review details/);
    assert.doesNotMatch(feesHtml, /name="snapshotFingerprint"|name="scheduleVersion"/);
    assert.doesNotMatch(feesHtml, /name="paymentAmount"|name="receiptNumber"|financeReviewReason/);
    const idempotencyKey = feesHtml.match(/name="idempotencyKey" value="([0-9a-f-]{36})"/)?.[1];
    assert.ok(idempotencyKey);
    const updatedFees = await fetch(`${baseUrl}/registrar/intake/71/fees?${new URLSearchParams({
      idempotencyKey, optionalLineIds: '90'
    })}`);
    const updatedFeesHtml = await updatedFees.text();
    assert.equal(updatedFees.status, 200);
    assert.match(updatedFeesHtml, /value="90" checked/);
    assert.match(updatedFeesHtml, /name="idempotencyKey" value="[^"]+"/);
    assert.match(updatedFeesHtml, /Student payable/);
    assert.match(updatedFeesHtml, /formaction="\/registrar\/intake\/71\/review"/);

    const finalReview = await fetch(`${baseUrl}/registrar/intake/71/review?${new URLSearchParams({
      idempotencyKey, optionalLineIds: '90'
    })}`);
    const reviewHtml = await finalReview.text();
    assert.equal(finalReview.status, 200);
    const csrfToken = reviewHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrfToken);
    assert.match(reviewHtml, /data-active-step="5"|aria-current="step"/);
    assert.match(reviewHtml, /Review enrollment details/);
    assert.match(reviewHtml, /voucher-based assessment/);
    assert.match(reviewHtml, /123456789012/);
    assert.match(reviewHtml, /2008-04-21/);
    assert.match(reviewHtml, /<dt>Intake type<\/dt><dd>New student<\/dd>/);
    assert.match(reviewHtml, /Edit profile or term placements/);
    assert.match(reviewHtml, /Update paper checklist/);
    assert.match(reviewHtml, /Staff checked all copies\./);
    assert.match(reviewHtml, /3 photocopies/);
    assert.match(reviewHtml, /<dt>Intake status<\/dt><dd>Pending<\/dd>/);
    assert.match(reviewHtml, /<th scope="row">Term 1<\/th>/);
    assert.match(reviewHtml, /<th scope="row">Term 2 · Second term<\/th>/);
    assert.doesNotMatch(reviewHtml, /Term 1 · Term 1/);
    assert.match(reviewHtml, /data-label="Placement">Applicable<\/td>/);
    assert.match(reviewHtml, /data-label="Status">Pending payment<\/td>/);
    assert.match(reviewHtml, /data-label="Status">Received/);
    assert.match(reviewHtml, /data-label="Status">Pending/);
    assert.match(reviewHtml, /data-label="Status">Not applicable/);
    assert.doesNotMatch(reviewHtml, /pending_payment|not_applicable/);
    assert.match(reviewHtml, /Included · ₱100\.00/);
    assert.match(reviewHtml, /₱1,334\.50/);
    assert.match(reviewHtml, /Approved tuition by term/);
    assert.match(reviewHtml, /Other payable fees/);
    assert.match(reviewHtml, /Term payable/);
    assert.match(reviewHtml, /The approved schedule does not provide one Downpayment/);
    assert.match(reviewHtml, /name="snapshotFingerprint" value="a{64}"/);
    assert.match(reviewHtml, /name="scheduleVersion" value="2"/);
    assert.match(reviewHtml, /name="optionalLineIds" value="90"/);
    assert.doesNotMatch(reviewHtml, /name="(?:firstName|middleName|lastName|studentNo|lrn|birthDate|address|phone|email)"/);
    assert.deepEqual(feePreviewCalls.at(-1), [90]);
    const confirmResponse = await fetch(`${baseUrl}/registrar/intake/71/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey,
        scheduleId: '9', scheduleVersion: '2', voucherCode: 'PUB', assessmentId: '', snapshotFingerprint: 'a'.repeat(64),
        clearanceSnapshotFingerprint: 'clearance-review-fingerprint', optionalLineIds: '90' })
    });
    const confirmedHtml = await confirmResponse.text();
    assert.equal(confirmResponse.status, 200);
    assert.match(confirmResponse.headers.get('cache-control'), /no-store/);
    assert.match(confirmedHtml, /Enrollment confirmed/);
    assert.match(confirmedHtml, /Finance records payments separately/);
    assert.match(confirmedHtml, /₱1,334\.50/);
    assert.match(confirmedHtml, /Confirmation ID <strong>101/);
    assert.match(confirmedHtml, /Itemized assessment and approved coverage/);
    assert.match(confirmedHtml, /Tour/);
    assert.match(confirmedHtml, /synthetic-one-time-credential/);
    assert.match(confirmedHtml, /Print \/ save as PDF/);
    assert.doesNotMatch(confirmedHtml, /data-print-page/);
    assert.match(confirmedHtml, /\/registrar\/intake\/71\/confirmation/);
    assert.match(confirmedHtml, /Open paper requirements checklist/);
    assert.deepEqual(confirmationCall, { actorId: registrar.id, annualId: '71', input: {
      _csrf: csrfToken, idempotencyKey, scheduleId: '9',
      scheduleVersion: '2', voucherCode: 'PUB', assessmentId: '', snapshotFingerprint: 'a'.repeat(64),
      clearanceSnapshotFingerprint: 'clearance-review-fingerprint', optionalLineIds: '90'
    } });

    const reopened = await fetch(`${baseUrl}/registrar/intake/71/confirmation`);
    const reopenedHtml = await reopened.text();
    assert.equal(reopened.status, 200);
    assert.match(reopened.headers.get('cache-control'), /no-store/);
    assert.match(reopenedHtml, /Enrollment confirmed/);
    assert.match(reopenedHtml, /Downpayment/);
    assert.match(reopenedHtml, /Approved coverage/);
    assert.match(reopenedHtml, /Confirmation ID <strong>101/);
    assert.match(reopenedHtml, /Current term placements/);
    assert.doesNotMatch(reopenedHtml, /synthetic-one-time-credential|One-time temporary password/);
    assert.match(reopenedHtml, /data-print-page/);
    assert.equal(confirmationCall?.annualId, '71');
    const confirmationCss = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');
    assert.match(confirmationCss, /\.annual-confirmation-document \.confirmation-secret \{ display: none !important; \}/);
    assert.match(confirmationCss, /\.annual-confirmation-document \.admin-table thead \{ position: static !important; display: table-header-group !important;/,
      'the shared tuition installment table is reset from the narrow-screen clipped header rules when printed');
    assert.match(confirmationCss, /\.annual-confirmation-document \.admin-table td::before \{ display: none !important;/);
    assert.match(confirmationCss, /\.fee-approved-tuition \.admin-table td:nth-child\(n\+2\) \{ text-align: right;/);
  });
});

test('credential-free confirmation GET uses the saved assessment, entry-term scope, and role-specific read-only access', async () => {
  const app = express();
  const reads = { record: 0, registrarSnapshot: 0, confirmationWrites: 0 };
  let mismatchSnapshot = false;
  const parent = {
    annual_enrollment_id: 71, student_id: 41, student_no: 'SHS-2026-0321', lrn: '123456789012',
    first_name: 'Synthetic', middle_name: 'Casey', last_name: 'Learner', suffix: '',
    phone: '09170000000', student_email: 'learner@example.edu', school_year: '2026-2027',
    grade_level: 'Grade 11', voucher_code: 'ESC', intake_kind: 'transferee', entry_term_number: 2,
    enrollment_start_date: '2026-10-03', intake_status: 'confirmed', registrar_confirmation_id: 303,
    registrar_confirmed_at: '2026-10-04 00:00:00', registrar_assessment_id: 404,
    registrar_schedule_id: 9, registrar_schedule_version: 1, registrar_voucher_code_snapshot: 'NV',
    registrar_payable_total: '2175.00'
  };
  const record = {
    parent,
    terms: [
      { annual_term_number: 1, term: 'First term', section_name: null, term_scope_status: 'not_applicable', enrollment_status: 'not_applicable' },
      { annual_term_number: 2, term: 'Second term', section_name: 'Mabini', term_scope_status: 'applicable', enrollment_status: 'pending_payment' },
      { annual_term_number: 3, term: 'Third term', section_name: 'Rizal', term_scope_status: 'applicable', enrollment_status: 'pending_payment' }
    ]
  };
  const installmentRows = (termNumber, amounts) => ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment, index) => ({
    termNumber, lineName: 'Tuition', category: 'tuition', installment, grossAmount: amounts[index],
    waivedAmount: '0.00', amount: amounts[index], isOptional: false
  }));
  const savedPreview = {
    parent: { first_name: 'Synthetic', last_name: 'Learner', student_no: 'SHS-2026-0321', school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'NV', entry_term_number: 2 },
    scheduleId: 9, scheduleVersion: 1, assessmentId: 404, existingAssessment: true, voucherCode: 'NV',
    total: '2175.00', optionalLineIds: [901],
    tuitionBreakdownComplete: true,
    tuitionBreakdown: [
      { termNumber: 1, complete: true, installments: ['DP', 'Prelim', 'Midterm', 'Finals'].map((label) => ({ label, notApplicable: true, amount: null })) },
      { termNumber: 2, complete: true, installments: ['DP', 'Prelim', 'Midterm', 'Finals'].map((label, index) => ({ label, configured: true, amount: ['0.00', '200.00', '300.00', '400.00'][index] })) },
      { termNumber: 3, complete: true, installments: ['DP', 'Prelim', 'Midterm', 'Finals'].map((label, index) => ({ label, configured: true, amount: ['100.00', '200.00', '300.00', '400.00'][index] })) }
    ],
    tuitionTermTotals: [{ termNumber: 2, amount: '900.00' }, { termNumber: 3, amount: '1000.00' }],
    nonTuitionTermTotals: [{ termNumber: 2, amount: '75.00' }, { termNumber: 3, amount: '200.00' }],
    termTotals: [{ termNumber: 2, amount: '975.00' }, { termNumber: 3, amount: '1200.00' }],
    lines: [
      ...installmentRows(2, ['0.00', '200.00', '300.00', '400.00']),
      { termNumber: 2, lineName: 'Modules', category: 'materials', installment: 'Once', grossAmount: '100.00', waivedAmount: '50.00', amount: '50.00', isOptional: false },
      { termNumber: 2, lineName: 'Tour', category: 'activity', installment: 'Once', grossAmount: '25.00', waivedAmount: '0.00', amount: '25.00', isOptional: true },
      ...installmentRows(3, ['100.00', '200.00', '300.00', '400.00']),
      { termNumber: 3, lineName: 'Laboratory materials', category: 'materials', installment: 'Once', grossAmount: '200.00', waivedAmount: '0.00', amount: '200.00', isOptional: false }
    ]
  };
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.formatMoney = require('../src/utils/formatMoney').formatMoney;
  app.use((req, _res, next) => {
    const role = req.header('x-test-role') || 'registrar';
    req.authUser = role === 'database_admin' ? admin : role === 'registrar' ? registrar : { id: 6, role };
    next();
  });
  app.use('/registrar/intake', createAnnualConfirmationRouter({
    annualEnrollmentService: {
      async getAnnualManagementRecord(actorId, annualId) {
        reads.record += 1;
        assert.ok([registrar.id, admin.id].includes(actorId));
        assert.ok(['71', '72', '999'].includes(String(annualId)));
        if (String(annualId) === '999') return null;
        return { ...record, parent: { ...parent, registrar_confirmation_id: String(annualId) === '72' ? null : parent.registrar_confirmation_id } };
      },
      async confirmAnnualEnrollment() { reads.confirmationWrites += 1; throw new Error('GET must not confirm'); }
    },
    annualFinanceService: {
      async annualConfirmationAssessmentSnapshotForStaff(actorId, annualId) {
        reads.registrarSnapshot += 1;
        assert.ok([registrar.id, admin.id].includes(actorId));
        assert.equal(String(annualId), '71');
        return mismatchSnapshot ? { ...savedPreview, assessmentId: 999 } : savedPreview;
      }
    }
  }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/registrar/intake/71/confirmation`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(html, /Confirmation ID <strong>303/);
    assert.match(html, /Voucher<\/dt><dd>NV/);
    assert.match(html, /Intake type<\/dt><dd>Transferee/);
    assert.match(html, /Second term · Entry term/);
    assert.match(html, /₱0\.00/);
    assert.match(html, /Approved coverage/);
    assert.match(html, /₱50\.00/);
    assert.match(html, /Term payable/);
    assert.match(html, /₱2,175\.00/);
    assert.match(html, /schedule version 1/i);
    assert.match(html, /Finance records payments separately/);
    assert.doesNotMatch(html, /Voucher<\/dt><dd>ESC/);
    assert.doesNotMatch(html, /Temporary password|payment history rows|receipt number/i);
    assert.equal(reads.registrarSnapshot, 1);
    assert.equal(reads.confirmationWrites, 0);

    const repeated = await fetch(`${baseUrl}/registrar/intake/71/confirmation`);
    assert.equal(repeated.status, 200);
    assert.equal(reads.confirmationWrites, 0, 'reopening the confirmation is read-only');
    assert.equal(reads.registrarSnapshot, 2);

    const databaseAdminCopy = await fetch(`${baseUrl}/registrar/intake/71/confirmation`, { headers: { 'x-test-role': 'database_admin' } });
    assert.equal(databaseAdminCopy.status, 200);
    assert.equal(reads.registrarSnapshot, 3);

    for (const role of ['teacher', 'finance', 'student']) {
      const denied = await fetch(`${baseUrl}/registrar/intake/71/confirmation`, { headers: { 'x-test-role': role } });
      assert.equal(denied.status, 403, `${role} cannot view registrar confirmations`);
    }
    assert.equal(reads.record, 3, 'unauthorized access is rejected before student data is loaded');

    const malformed = await fetch(`${baseUrl}/registrar/intake/not-a-number/confirmation`);
    assert.equal(malformed.status, 400);
    assert.equal(reads.record, 3, 'malformed IDs do not reach student data queries');

    const unknown = await fetch(`${baseUrl}/registrar/intake/999/confirmation`);
    const unknownHtml = await unknown.text();
    assert.equal(unknown.status, 404);
    assert.doesNotMatch(unknownHtml, /Synthetic|SHS-2026|2175\.00|Modules/);
    assert.equal(reads.registrarSnapshot, 3, 'unknown enrollments do not load fee details');

    mismatchSnapshot = true;
    const mismatched = await fetch(`${baseUrl}/registrar/intake/71/confirmation`);
    const mismatchHtml = await mismatched.text();
    assert.equal(mismatched.status, 409);
    assert.doesNotMatch(mismatchHtml, /Synthetic|SHS-2026|2175\.00|Modules/);
    assert.equal(reads.confirmationWrites, 0, 'failed snapshot verification remains read-only');
    mismatchSnapshot = false;

    const unconfirmed = await fetch(`${baseUrl}/registrar/intake/72/confirmation`);
    assert.equal(unconfirmed.status, 409);
    assert.match(await unconfirmed.text(), /has not been confirmed/);
    assert.equal(reads.registrarSnapshot, 4, 'an unconfirmed intake does not load any fee schedule or assessment');
  });
  const managementTemplate = fs.readFileSync(path.join(__dirname, '..', 'views/records/annual-management.ejs'), 'utf8');
  assert.match(managementTemplate, /if \(record\.parent\.registrar_confirmation_id\)[\s\S]*?\/confirmation/,
    'staff can reopen the credential-free confirmation after leaving the initial response');
});

test('a post-confirmation summary read failure still renders confirmed status and a retry link', async () => {
  const app = express();
  let confirmed = false;
  const errors = [];
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.formatMoney = require('../src/utils/formatMoney').formatMoney;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.authUser = registrar;
    req.session = { csrfToken: 'a'.repeat(64) };
    next();
  });
  app.use('/registrar/intake', createAnnualStudentIntakeRouter({
    annualEnrollmentService: {
      async confirmAnnualEnrollment() {
        confirmed = true;
        return { annualEnrollmentId: 71, studentId: 41, studentNo: 'SHS-2026-0321', firstName: 'Synthetic',
          lastName: 'Learner', schoolYear: '2026-2027', gradeLevel: 'Grade 11', total: '500.00',
          temporaryPassword: 'synthetic-one-time-credential' };
      },
      async getAnnualManagementRecord() { throw new Error('SQL detail and private@example.test'); }
    },
    annualFinanceService: { async annualAssessmentPreviewForRegistrar() { throw new Error('must not be reached'); } },
    logger: { error(...args) { errors.push(args); } }
  }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/registrar/intake/71/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'a'.repeat(64) })
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(confirmed, true);
    assert.match(html, /Enrollment confirmed/);
    assert.match(html, /Enrollment was confirmed, but its saved detail summary could not be loaded/);
    assert.match(html, /\/registrar\/intake\/71\/confirmation/);
    assert.doesNotMatch(html, /annual enrollment was not confirmed|SQL detail|private@example\.test/);
    assert.equal(errors.length, 1);
    assert.doesNotMatch(JSON.stringify(errors), /SQL detail|private@example\.test/);
  });
});

test('final review unexpected load failures return a support reference and only safe diagnostics', async () => {
  const app = express();
  const errors = [];
  const failure = new Error('SQL text and private@example.test must not escape');
  failure.code = 'ER_PARSE_ERROR';
  failure.errno = 1064;
  failure.sqlState = '42000';
  failure.stack = [
    'Error: SQL text and private@example.test must not escape',
    '    at query (/srv/application/src/config/database.js:218:47)',
    '    at getStudentChecklist (/srv/application/src/services/physicalChecklistService.js:164:17)'
  ].join('\n');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.use((req, _res, next) => { req.authUser = registrar; req.session = {}; next(); });
  app.use('/registrar/intake', createAnnualStudentIntakeRouter({
    annualEnrollmentService: {
      async getAnnualManagementRecord() {
        return { parent: { student_id: 41, registrar_confirmation_id: null }, terms: [] };
      }
    },
    physicalChecklistService: { async getStudentChecklist() { throw failure; } },
    termClearanceService: { async getAnnualPrerequisiteReview() { return { ready: true, kind: 'new_student', terms: [], blockers: [], fingerprint: 'clearance-review-fingerprint' }; } },
    annualFinanceService: { async annualAssessmentPreviewForRegistrar() { return { lines: [], total: '0.00' }; } },
    logger: { error(...args) { errors.push(args); } }
  }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/registrar/intake/71/review`);
    const html = await response.text();
    assert.equal(response.status, 503);
    assert.match(response.headers.get('cache-control'), /private, no-store/);
    assert.match(html, /Support reference: [0-9a-f-]{36}\./);
    assert.doesNotMatch(html, /private@example\.test|SQL text|ER_PARSE_ERROR|SELECT/i);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], 'Annual final review load failed');
    const { incidentId, ...diagnostics } = errors[0][1];
    assert.deepEqual(diagnostics, {
      operation: 'registrar.annual_final_review.load',
      errorName: 'Error',
      errorCode: 'ER_PARSE_ERROR',
      errorNumber: 1064,
      sqlState: '42000',
      sourceLocation: 'src/config/database.js:218:47'
    });
    assert.match(incidentId, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(errors), /private@example\.test|SQL text|SELECT/i);
  });
});

test('unexpected annual intake failures log safe diagnostics and retain the submission token in the form', async () => {
  const app = express();
  const session = {};
  const source = readyPreEnrollmentFixture();
  const errors = [];
  const failure = new Error('raw SQL details and private@example.test');
  failure.code = 'ER_BAD_FIELD_ERROR';
  failure.errno = 1054;
  failure.sqlState = '42S22';
  failure.stack = [
    'Error: raw SQL details and private@example.test',
    '    at createAnnualIntake (/srv/application/src/services/annualEnrollmentService.js:712:19)',
    '    at /srv/application/src/routes/studentSetup.js:640:27'
  ].join('\n');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.formatStudentPlacement = require('../src/utils/formatStudentPlacement').formatStudentPlacement;
  app.locals.formatMoney = require('../src/utils/formatMoney').formatMoney;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { req.authUser = registrar; req.session = session; next(); });
  app.use('/registrar/intake', createAnnualStudentIntakeRouter({
    annualEnrollmentService: {
      async loadIntakeOptions() {
        return { schoolYears: [{ school_year: '2026-2027' }], terms: [], sections: [] };
      },
      async createAnnualIntake() { throw failure; }
    },
    preEnrollmentService: {
      async openConversion(_actorId, id) { assert.equal(id, source.id); return { alreadyStarted: false, record: source }; },
      async get(_actorId, id) { assert.equal(id, source.id); return source; }
    },
    logger: { error(...args) { errors.push(args); } }
  }));

  await withServer(app, async (baseUrl) => {
    const openingResponse = await fetch(`${baseUrl}/registrar/intake/new?preEnrollmentId=${source.id}`);
    const openingHtml = await openingResponse.text();
    assert.equal(openingResponse.status, 200);
    const csrfToken = openingHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
    const idempotencyKey = openingHtml.match(/name="idempotencyKey" value="([^"]+)"/)?.[1];
    assert.ok(csrfToken);
    assert.ok(idempotencyKey);

    const response = await fetch(`${baseUrl}/registrar/intake`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: csrfToken, idempotencyKey, preEnrollmentId: source.id, preEnrollmentVersion: String(source.version),
        email: 'new.student+fixture@gmail.com', lrn: '123456789012',
        firstName: 'Casey', middleName: 'R', lastName: 'Example', suffix: '', birthDate: '2008-07-14',
        sex: 'Male', address: 'Synthetic address', phone: '09170000000', schoolYear: '2026-2027',
        gradeLevel: 'Grade 11', voucherCode: 'PUB', voucherCategory: 'A', intakeKind: 'standard',
        entryTermNumber: '1', enrollmentStartDate: '2026-10-03', sectionMode: 'same', annualSectionId: '8'
      })
    });
    const html = await response.text();
    assert.equal(response.status, 503);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(html, /data-active-step="3"/);
    assert.match(html, /learner@example\.edu/);
    assert.match(html, /123456789012/);
    assert.doesNotMatch(html, /new\.student\+fixture@gmail\.com/);
    assert.match(html, /name="idempotencyKey" value="[^"]+"/);
    assert.match(html, new RegExp(`name="idempotencyKey" value="${idempotencyKey}"`));
    assert.doesNotMatch(html, /name="voucherCategory"/);
    assert.match(html, /Support reference: [0-9a-f-]{36}\./);

    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], 'Annual intake save failed');
    const { incidentId, ...diagnostics } = errors[0][1];
    assert.deepEqual(diagnostics, {
      operation: 'registrar.annual_intake.create',
      errorName: 'Error',
      errorCode: 'ER_BAD_FIELD_ERROR',
      errorNumber: 1054,
      sqlState: '42S22',
      sourceLocation: 'src/services/annualEnrollmentService.js:712:19'
    });
    assert.match(incidentId, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(errors), /private@example\.test|raw SQL details|new\.student|123456789012|SELECT/i);
  });
});

test('annual intake error fallback tells staff to check for a committed record before starting over', async () => {
  const app = express();
  const session = {};
  const source = readyPreEnrollmentFixture();
  let optionLoads = 0;
  let incident = null;
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.formatStudentPlacement = require('../src/utils/formatStudentPlacement').formatStudentPlacement;
  app.locals.formatMoney = require('../src/utils/formatMoney').formatMoney;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { req.authUser = registrar; req.session = session; next(); });
  app.use('/registrar/intake', createAnnualStudentIntakeRouter({
    annualEnrollmentService: {
      async loadIntakeOptions() {
        optionLoads += 1;
        if (optionLoads > 1) throw new Error('synthetic options lookup failure');
        return { schoolYears: [], terms: [], sections: [] };
      },
      async createAnnualIntake() { throw new Error('synthetic save failure'); }
    },
    preEnrollmentService: {
      async openConversion(_actorId, id) { assert.equal(id, source.id); return { alreadyStarted: false, record: source }; },
      async get(_actorId, id) { assert.equal(id, source.id); return source; }
    },
    logger: { error(_message, details) { incident = details; } }
  }));

  await withServer(app, async (baseUrl) => {
    const openingResponse = await fetch(`${baseUrl}/registrar/intake/new?preEnrollmentId=${source.id}`);
    const openingHtml = await openingResponse.text();
    assert.equal(openingResponse.status, 200);
    const csrfToken = openingHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
    const idempotencyKey = openingHtml.match(/name="idempotencyKey" value="([^"]+)"/)?.[1];
    const response = await fetch(`${baseUrl}/registrar/intake`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey,
        preEnrollmentId: source.id, preEnrollmentVersion: String(source.version) })
    });
    const html = await response.text();
    assert.equal(response.status, 503);
    assert.match(html, /Check the enrollments list before starting a new submission\./);
    assert.match(html, new RegExp(`Support reference: ${incident.incidentId}\\.`));
    assert.doesNotMatch(html, /name="idempotencyKey"/);
    assert.equal(optionLoads, 2);
    assert.equal(incident.operation, 'registrar.annual_intake.create');
  });
});

test('legacy finalization cannot activate a student login through the retired service', async () => {
  const fixture = setupFixture(() => { throw new Error('retired workflow must not query the database'); });
  await assert.rejects(fixture.service.finalizeEnrollment(5, 51),
    (error) => error instanceof StudentSetupError && error.status === 409);
  assert.equal(fixture.log.queries.length, 0);
  assert.equal(fixture.log.committed, false);
});

test('finance clearance requires a payment, an exact enrollment, and explicit attestation', () => {
  assert.throws(() => validateTransaction({
    transactionType: 'charge', amount: '2.00', clearEnrollmentId: '51', confirmEnrollmentClearance: '1'
  }), /requires a payment/);
  assert.throws(() => validateTransaction({
    transactionType: 'payment', amount: '2.00', clearEnrollmentId: '51'
  }), /explicit finance confirmation/);
  assert.throws(() => validateTransaction({
    transactionType: 'payment', amount: '2.00', confirmEnrollmentClearance: '1'
  }), /Choose the specific enrollment/);
  assert.equal(validateTransaction({
    transactionType: 'payment', amount: '2.00', clearEnrollmentId: '51', confirmEnrollmentClearance: '1'
  }).clearEnrollmentId, 51);
});

test('finance records and clears only the selected pending enrollment with the payment transaction', async () => {
  const log = { queries: [], committed: false, rolledBack: false };
  let balance = '10.00';
  let failClear = false;
  const transactionFactory = () => ({
    async begin() {},
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          log.queries.push({ statement, values: { ...values } });
          if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'finance' }] };
          if (statement.includes('SELECT id, status FROM students') && statement.includes('FOR UPDATE')) return { recordset: [{ id: values.studentId, status: 'active' }] };
          if (statement.includes('FROM annual_enrollments')) return { recordset: [] };
          if (statement.includes('FROM finance_legacy_opening_charges')) return { recordset: [] };
          if (statement.includes('FROM financial_accounts AS a')) return { recordset: [{ financial_account_id: 30, balance, status: 'active' }] };
          if (statement.includes('FROM enrollments AS enrollment')) return { recordset: [{
            id: 51, enrollment_status: 'pending_payment', finalized_at: null, clearance_status: 'pending', created_for_intake: 1
          }] };
          if (statement.includes('UPDATE financial_accounts')) { balance = values.balance; return { rowsAffected: [1] }; }
          if (statement.includes('INSERT INTO financial_transactions')) return { insertId: 91 };
          if (statement.includes('UPDATE enrollment_clearances')) return { rowsAffected: failClear ? [0] : [1] };
          if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
          throw new Error('Unexpected query: ' + statement);
        }
      };
    },
    async commit() { log.committed = true; },
    async rollback() { log.rolledBack = true; }
  });
  const service = createFinanceService({ getPool: async () => ({}), sql: fakeSql(), transactionFactory,
    debtRevisionService: {
      async lockStudent(_transaction, studentId) { return { id: studentId, status: 'active', debtIncreaseRevision: '0' }; },
      async readSnapshot() { return { canonicalBalanceCents: 1000n }; },
      async recordIncreaseIfAny() { return { increased: false }; }
    }
  });
  const input = { transactionType: 'payment', amount: '2.00', clearEnrollmentId: '51', confirmEnrollmentClearance: '1' };
  const result = await service.recordTransaction(7, 22, input);
  assert.equal(result.transactionId, 91);
  assert.equal(result.balance, '8.00');
  const clearance = log.queries.find(({ statement }) => statement.includes('UPDATE enrollment_clearances'));
  assert.equal(clearance.values.enrollmentId, 51);
  assert.equal(clearance.values.transactionId, 91);
  assert.equal(log.committed, true);

  failClear = true;
  await assert.rejects(service.recordTransaction(7, 22, input), /cleared by another finance transaction/);
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.filter(({ statement }) => statement.includes('INSERT INTO audit_logs')).length, 1);
});

test('bulk roster template provides a starter file and print control is compatible with the CSP', async () => {
  const app = express();
  app.use('/bulk', createStudentBulkAccountsRouter({ studentSetupService: {} }));
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/bulk/template.csv`);
    const template = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('content-disposition'), /student-login-accounts-template\.csv/);
    assert.match(template, /Student Number,Email\r\nREPLACE-WITH-EXISTING-STUDENT-NUMBER,student@example\.edu/);
  });
  const printPage = fs.readFileSync(path.join(__dirname, '..', 'views/records/enrollment-print.ejs'), 'utf8');
  const appScript = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
  assert.match(printPage, /data-print-page/);
  assert.match(printPage, /<script src="\/js\/app\.js" defer><\/script>/);
  assert.doesNotMatch(printPage, /onclick\s*=/i);
  assert.match(appScript, /querySelectorAll\('\[data-print-page\]'\)[\s\S]*window\.print\(\)/);
});

test('pre-enrollment source identity, version, token, and receipt labels survive annual-intake validation rerender', async () => {
  const app = express();
  const sourceId = 'a342bc01-2a68-4f19-a7fd-4d5bb1d83261';
  const csrfToken = 'd'.repeat(64);
  const baseRecord = {
    id: sourceId, version: 3, status: 'ready_for_registrar', school_year: '2027-2028',
    first_name: 'Ari', middle_name: 'Mae', last_name: 'Santos', suffix: '', lrn: '012345678901',
    address: 'Old full address value', address_block_lot_street_purok: 'Block 2, Lot 8, Mabini Street',
    address_barangay: 'Barangay 1', address_city: 'Lucena', address_province: 'Quezon', address_zip: '4301',
    emergency_contact_address: 'Old emergency address value', emergency_contact_address_block_lot_street_purok: 'Lot 3, Rizal Street',
    emergency_contact_address_barangay: 'Barangay 2', emergency_contact_address_city: 'Lucena',
    emergency_contact_address_province: 'Quezon', emergency_contact_address_zip: '4301',
    student_contact_number: '09171234567', target_grade_level: 'Grade 11',
    voucher_type_text: 'ESC as written', voucher_category_text: 'Category A as written',
    preferred_track: 'Academic Track', preferred_cluster: 'ASSH', prior_grade_level: 'Grade 10',
    prior_school: 'Lucena High School', student_signature_present: 1, student_signed_date: '2026-10-01',
    received_by: 'Front Desk Operator', received_date: '2026-10-02',
    receipts: [{ requirement_code: 'report_card', original_received: 1, original_pieces: 1,
      photocopy_received: 0, photocopy_pieces: null }]
  };
  let createCalls = 0;
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.formatStudentPlacement = require('../src/utils/formatStudentPlacement').formatStudentPlacement;
  app.locals.formatMoney = require('../src/utils/formatMoney').formatMoney;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { req.authUser = registrar; req.session = { csrfToken }; next(); });
  app.use('/registrar/intake', createAnnualStudentIntakeRouter({
    annualEnrollmentService: {
      async loadIntakeOptions() { return { schoolYears: [{ school_year: '2027-2028' }], terms: [], sections: [] }; },
      async createAnnualIntake(_actorId, input) {
        createCalls += 1;
        assert.equal(input.preEnrollmentId, sourceId);
        assert.equal(input.preEnrollmentVersion, '3');
        assert.equal(input.idempotencyKey, sourceId);
        throw new AnnualEnrollmentError('Enter a valid contact email address.');
      }
    },
    physicalChecklistService: { async listIntakeRequirements() { return []; } },
    preEnrollmentService: {
      async openConversion(_actorId, id) { assert.equal(id, sourceId); return { alreadyStarted: false, record: baseRecord }; },
      async get(_actorId, id) { assert.equal(id, sourceId); return { ...baseRecord, version: 4 }; }
    }
  }));

  await withServer(app, async (baseUrl) => {
    const opening = await fetch(`${baseUrl}/registrar/intake/new?preEnrollmentId=${sourceId}`);
    const openingHtml = await opening.text();
    assert.equal(opening.status, 200);
    assert.match(openingHtml, /Report Card \(Grade 10 \/ ALS-AF5\)/);
    assert.match(openingHtml, /Receipt counts stay separate/);
    assert.match(openingHtml, /Block and Lot, Street\/Purok: Block 2, Lot 8, Mabini Street[\s\S]*Barangay: Barangay 1[\s\S]*ZIP code: 4301/);
    assert.match(openingHtml, /Block and Lot, Street\/Purok: Lot 3, Rizal Street[\s\S]*Barangay: Barangay 2[\s\S]*ZIP code: 4301/);
    assert.doesNotMatch(openingHtml, /Old full address value|Old emergency address value/);
    const post = await fetch(`${baseUrl}/registrar/intake`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: csrfToken, preEnrollmentId: sourceId, preEnrollmentVersion: '3', idempotencyKey: sourceId,
        firstName: 'Ari', middleName: 'Mae', lastName: 'Santos', lrn: '012345678901',
        schoolYear: '2027-2028', gradeLevel: 'Grade 11', email: ''
      })
    });
    const html = await post.text();
    assert.equal(post.status, 400);
    assert.equal(createCalls, 1);
    assert.match(html, /name="preEnrollmentId" value="a342bc01-2a68-4f19-a7fd-4d5bb1d83261"/);
    assert.match(html, /name="preEnrollmentVersion" value="3"/);
    assert.match(html, new RegExp(`name="idempotencyKey" value="${sourceId}"`));
    assert.match(html, /<dt>Paper revision<\/dt><dd>4<\/dd>/);
    assert.match(html, /keeps its original revision and token/);
    assert.match(html, /Report Card \(Grade 10 \/ ALS-AF5\)/);
  });
});
