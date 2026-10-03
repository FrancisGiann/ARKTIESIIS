const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const {
  StudentSetupError,
  normalizeBulkRows,
  createStudentSetupService
} = require('../src/services/studentSetupService');
const { createStudentBulkAccountsRouter, createStudentIntakeRouter, createAnnualStudentIntakeRouter } = require('../src/routes/studentSetup');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');
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

test('registrar intake rejects existing identifiers before any inserts', async () => {
  const fixture = setupFixture(({ statement }) => {
    if (statement.includes('SELECT id, role FROM users')) return { recordset: [registrar] };
    if (statement.includes('SELECT section.id, term.school_year')) return { recordset: [{ id: 8, school_year: '2026-2027' }] };
    if (statement.includes('INSERT INTO application_locks')) return { affectedRows: 1 };
    if (statement.includes('FROM application_locks')) return { recordset: [{ lock_name: 'student-number:2026' }] };
    if (generatedStudentNumberQuery(statement)) return { recordset: [{ sequence: '320' }] };
    if (statement.includes('student_no_exists')) return { recordset: [{ student_no_exists: 0, lrn_exists: 1, email_exists: 0, pending_email_exists: 0 }] };
    throw new Error('Unexpected query: ' + statement);
  });
  await assert.rejects(fixture.service.createEnrollmentIntake(5, {
    studentNo: 'ST-100', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee',
    email: 'new@example.edu', academicTermId: '2', sectionId: '8'
  }), /LRN is already in use/);
  assert.equal(fixture.log.rolledBack, true);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO users')), false);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO students')), false);
});

test('registrar intake creates an inactive linked login, new profile, pending enrollment, and clearance atomically', async () => {
  let nextUserId = 31;
  const fixture = setupFixture(({ statement, values }) => {
    if (statement.includes('SELECT id, role FROM users')) return { recordset: [registrar] };
    if (statement.includes('SELECT section.id, term.school_year')) {
      assert.equal(values.termId, 2);
      assert.equal(values.sectionId, 8);
      return { recordset: [{ id: 8, school_year: '2026-2027' }] };
    }
    if (statement.includes('INSERT INTO application_locks')) return { affectedRows: 1 };
    if (statement.includes('FROM application_locks')) return { recordset: [{ lock_name: 'student-number:2026' }] };
    if (generatedStudentNumberQuery(statement)) return { recordset: [{ sequence: '320' }] };
    if (statement.includes('student_no_exists')) return { recordset: [{
      student_no_exists: 0, lrn_exists: 0, email_exists: 0, pending_email_exists: 0
    }] };
    if (statement.includes('FROM sections AS section')) return { recordset: [{ id: values.sectionId }] };
    if (statement.includes('INSERT INTO users')) {
      assert.equal(values.email, 'jamie@example.edu');
      assert.equal(values.mustChangePassword, true);
      assert.match(statement, /'student', 0, @mustChangePassword/);
      assert.notEqual(values.passwordHash, 'inaccessible-placeholder');
      return { insertId: nextUserId++ };
    }
    if (statement.includes('INSERT INTO students')) {
      assert.equal(values.userId, 31);
      assert.equal(values.studentNo, 'SHS-2026-0321');
      assert.equal(values.firstName, 'Jamie');
      return { insertId: 41 };
    }
    if (statement.includes('INSERT INTO enrollments')) {
      assert.equal(values.studentId, 41);
      assert.equal(values.termId, 2);
      assert.equal(values.sectionId, 8);
      assert.match(statement, /'pending_payment'/);
      return { insertId: 51 };
    }
    if (statement.includes('INSERT INTO enrollment_clearances')) {
      assert.equal(values.enrollmentId, 51);
      assert.equal(values.actorId, 5);
      assert.match(statement, /'pending'/);
      return { recordset: [] };
    }
    if (statement.includes('INSERT INTO audit_logs')) {
      assert.doesNotMatch(values.detailsJson, /Jamie|ST-100|jamie@example/);
      return { recordset: [] };
    }
    throw new Error('Unexpected query: ' + statement);
  }, { createPassword: () => 'inaccessible-placeholder' });
  const enrollmentId = await fixture.service.createEnrollmentIntake(5, {
    studentNo: 'FORGED-9999', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee',
    birthDate: '2008-02-29', email: 'Jamie@Example.edu', academicTermId: '2', sectionId: '8'
  });
  assert.equal(enrollmentId, 51);
  assert.equal(fixture.log.isolation, 'SERIALIZABLE');
  assert.equal(fixture.log.committed, true);
  assert.equal(fixture.log.queries.find(({ statement }) => statement.includes('INSERT INTO students')).values.studentNo, 'SHS-2026-0321');
  assert.ok(fixture.log.queries.some(({ statement, values }) => statement.includes('INSERT INTO application_locks') && values.lockName === 'student-number:2026'));
  assert.equal(fixture.log.queries.filter(({ statement }) => statement.includes('INSERT INTO audit_logs')).length, 1);
});

test('registrar intake rejects missing or invalid term years before creating records', async () => {
  const validProfile = {
    lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee', email: 'new@example.edu',
    academicTermId: '2', sectionId: '8'
  };
  const missingTerm = setupFixture(({ statement }) => {
    if (statement.includes('SELECT id, role FROM users')) return { recordset: [registrar] };
    if (statement.includes('SELECT section.id, term.school_year')) return { recordset: [] };
    throw new Error('Unexpected query: ' + statement);
  });
  await assert.rejects(missingTerm.service.createEnrollmentIntake(5, validProfile), /Choose an existing academic term/);
  assert.equal(missingTerm.log.queries.some(({ statement }) => statement.includes('INSERT INTO users')), false);

  const invalidTerm = setupFixture(({ statement }) => {
    if (statement.includes('SELECT id, role FROM users')) return { recordset: [registrar] };
    if (statement.includes('SELECT section.id, term.school_year')) return { recordset: [{ id: 8, school_year: '2026/2027' }] };
    throw new Error('Unexpected query: ' + statement);
  });
  await assert.rejects(invalidTerm.service.createEnrollmentIntake(5, validProfile), /invalid school year/);
  assert.equal(invalidTerm.log.queries.some(({ statement }) => statement.includes('sp_getapplock')), false);
  assert.equal(invalidTerm.log.queries.some(({ statement }) => statement.includes('INSERT INTO students')), false);
});

test('registrar intake opens the guided annual form and links the roster to fee confirmation and paper records', async () => {
  const app = express();
  let confirmationCall = null;
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
          entry_term_number: 1, enrollment_start_date: '2026-10-03', intake_status: 'pending', registrar_confirmation_id: null }
        , terms: [1, 2, 3].map((number) => ({ annual_term_number: number, term: number === 2 ? 'Second term' : `Term ${number}`, grade_level: 'Grade 11',
          section_name: 'Mabini', cluster: 'Academic', strand: 'STEM', modality: 'face_to_face', section_id: number + 7,
          term_scope_status: 'applicable', enrollment_status: 'pending_payment' }))
      };
    },
    async confirmAnnualEnrollment(actorId, annualId, input) {
      confirmationCall = { actorId, annualId, input };
      return { annualEnrollmentId: 71, studentId: 41, studentNo: 'SHS-2026-0321', firstName: 'Synthetic', lastName: 'Learner', schoolYear: '2026-2027', gradeLevel: 'Grade 11', term: 'Term 1', sectionName: 'Mabini', total: '1234.50', temporaryPassword: null };
    }
  };
  const feePreview = {
    parent: { first_name: 'Synthetic', last_name: 'Learner', student_no: 'SHS-2026-0321', school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'PUB' },
    scheduleId: 9, scheduleVersion: 2, voucherCode: 'PUB', assessmentId: null, existingAssessment: false,
    total: '1234.50', totalCents: 123450, optionalLineIds: [],
    optionalLines: [{ id: 90, termNumber: 1, lineName: 'Tour', installment: 'Once', amount: '100.00', selected: false }],
    termTotals: [{ termNumber: 1, amount: '1234.50' }, { termNumber: 2, amount: '0.00' }, { termNumber: 3, amount: '0.00' }],
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
      termTotals: [{ termNumber: 1, amount: includeTour ? '1334.50' : '1234.50' }, { termNumber: 2, amount: '0.00' }, { termNumber: 3, amount: '0.00' }]
    };
  };
  const paperRequirements = [
    { requirement_code: 'birth_certificate', requirement_name: 'Birth Certificate', guidance: '3 photocopies.', applicability: 'all', originals_required: 0, copies_required: 3, pieces_required: 0 },
    { requirement_code: 'good_moral', requirement_name: 'Good Moral Certificate', guidance: 'Original + 1 photocopy.', applicability: 'all', originals_required: 1, copies_required: 1, pieces_required: 0 },
    { requirement_code: 'two_by_two_photo', requirement_name: '2x2 Picture', guidance: '3 pieces.', applicability: 'all', originals_required: 0, copies_required: 0, pieces_required: 3 },
    { requirement_code: 'grade11_card', requirement_name: 'Grade 11 Card', guidance: 'Grade 11 card applies to Grade 12 learners.', applicability: 'grade12', originals_required: 0, copies_required: 0, pieces_required: 0 }
  ];
  let validationPoolCalls = 0;
  const intakeValidationService = createAnnualEnrollmentService({
    getPool: async () => { validationPoolCalls += 1; throw new Error('database should not be reached for invalid profile input'); },
    hashPassword: async () => 'synthetic-hash'
  });
  annualEnrollmentService.createAnnualIntake = (actorId, input) => intakeValidationService.createAnnualIntake(actorId, input);
  app.use('/registrar/intake', createAnnualStudentIntakeRouter({ annualEnrollmentService,
    physicalChecklistService: {
      async listIntakeRequirements() { return paperRequirements; },
      async getStudentChecklist(actorId, studentId) {
        assert.equal(actorId, registrar.id);
        assert.equal(Number(studentId), 41);
        return checklistFixture;
      }
    },
    annualFinanceService: { annualAssessmentPreviewForRegistrar: previewFees }
  }));
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/registrar/intake/new`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Student details/);
    assert.match(html, /Enrollment details/);
    assert.match(html, /Documents received/);
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
    assert.match(html, /id="annual-student-mode"/);
    assert.match(html, /name="studentNo"/);
    assert.match(html, /src="\/js\/annual-intake-form.js"/);
    assert.match(html, /name="lrn"/);
    assert.match(html, /name="section1Id"/);
    assert.match(html, /name="section2Id"/);
    assert.match(html, /name="section3Id"/);
    assert.match(html, /Voucher type/);
    assert.doesNotMatch(html, /name="voucherCategory"|voucher category/i);
    assert.match(html, /pattern="\\p\{L\}/);
    assert.match(html, /name="sex"/);
    assert.match(html, new RegExp(`max="${latestBirthDate()}"`));
    const intakeCsrfToken = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(intakeCsrfToken);
    const invalidStudent = await fetch(`${baseUrl}/registrar/intake`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: intakeCsrfToken, idempotencyKey: '41111111-1111-4111-8111-111111111111', lrn: '123456789012',
        email: 'learner@example.edu', firstName: '12345', middleName: '8', lastName: '3578', suffix: '',
        birthDate: '', sex: '', phone: '', address: '', schoolYear: '2026-2027', gradeLevel: 'Grade 11',
        voucherCode: 'PUB', entryTermNumber: '1', enrollmentStartDate: '2026-10-03',
        sectionMode: 'same', annualSectionId: '8'
      })
    });
    const invalidStudentHtml = await invalidStudent.text();
    assert.equal(invalidStudent.status, 400);
    assert.match(invalidStudentHtml, /data-active-step="1"/);
    assert.match(invalidStudentHtml, /First name must contain letters/);
    assert.match(invalidStudentHtml, /value="12345"/);
    assert.equal(validationPoolCalls, 0);
    const invalidGender = await fetch(`${baseUrl}/registrar/intake`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: intakeCsrfToken, idempotencyKey: '41111111-1111-4111-8111-111111111111', lrn: '123456789012',
        email: 'learner@example.edu', firstName: 'Alex', middleName: '', lastName: 'Learner', suffix: '',
        birthDate: '', sex: 'fish', phone: '', address: '', schoolYear: '2026-2027', gradeLevel: 'Grade 11',
        voucherCode: 'PUB', entryTermNumber: '1', enrollmentStartDate: '2026-10-03',
        sectionMode: 'same', annualSectionId: '8'
      })
    });
    const invalidGenderHtml = await invalidGender.text();
    assert.equal(invalidGender.status, 400);
    assert.match(invalidGenderHtml, /Choose Male, Female, or Other for gender/);
    assert.match(invalidGenderHtml, /<option value="fish" selected>Invalid value \(choose again\): fish<\/option>/);
    assert.equal(validationPoolCalls, 0);
    const pending = await fetch(`${baseUrl}/registrar/intake`);
    const pendingHtml = await pending.text();
    assert.equal(pending.status, 200);
    assert.match(pendingHtml, /SHS-2026-0321/);
    assert.match(pendingHtml, /Voucher type PUB/);
    assert.match(pendingHtml, /Update voucher type/);
    assert.doesNotMatch(pendingHtml, /Category D|name="voucherCategory"/);
    assert.match(pendingHtml, /Enrollment confirmation/);
    assert.match(pendingHtml, /Review fees and confirm enrollment/);
    assert.match(pendingHtml, /Record paper requirements checklist/);
    assert.match(pendingHtml, /Enrollment counts/);
    assert.match(pendingHtml, /data-label="Students"><strong>1/);

    const fees = await fetch(`${baseUrl}/registrar/intake/71/fees`);
    const feesHtml = await fees.text();
    assert.equal(fees.status, 200);
    assert.match(fees.headers.get('cache-control'), /no-store/);
    assert.match(feesHtml, /<title>Review enrollment fees \| ARKTIESIIS<\/title>/);
    assert.match(feesHtml, /Payable total/);
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
    assert.match(updatedFeesHtml, /Payable total/);
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
    assert.match(reviewHtml, /123456789012/);
    assert.match(reviewHtml, /2008-04-21/);
    assert.match(reviewHtml, /<dt>Intake type<\/dt><dd>Standard intake<\/dd>/);
    assert.doesNotMatch(reviewHtml, /<dt>Intake type<\/dt><dd>New student<\/dd>/);
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
    assert.match(reviewHtml, /name="snapshotFingerprint" value="a{64}"/);
    assert.match(reviewHtml, /name="scheduleVersion" value="2"/);
    assert.match(reviewHtml, /name="optionalLineIds" value="90"/);
    assert.doesNotMatch(reviewHtml, /name="(?:firstName|middleName|lastName|studentNo|lrn|birthDate|address|phone|email)"/);
    assert.deepEqual(feePreviewCalls.at(-1), [90]);
    const confirmResponse = await fetch(`${baseUrl}/registrar/intake/71/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey,
        scheduleId: '9', scheduleVersion: '2', voucherCode: 'PUB', assessmentId: '', snapshotFingerprint: 'a'.repeat(64), optionalLineIds: '90' })
    });
    const confirmedHtml = await confirmResponse.text();
    assert.equal(confirmResponse.status, 200);
    assert.match(confirmResponse.headers.get('cache-control'), /no-store/);
    assert.match(confirmedHtml, /Enrollment confirmed/);
    assert.match(confirmedHtml, /₱1,234\.50/);
    assert.match(confirmedHtml, /Open paper requirements checklist/);
    assert.deepEqual(confirmationCall, { actorId: registrar.id, annualId: '71', input: {
      _csrf: csrfToken, idempotencyKey, scheduleId: '9',
      scheduleVersion: '2', voucherCode: 'PUB', assessmentId: '', snapshotFingerprint: 'a'.repeat(64), optionalLineIds: '90'
    } });
  });
});

test('unexpected annual intake failures log safe diagnostics and retain the submission token in the form', async () => {
  const app = express();
  const session = {};
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
    logger: { error(...args) { errors.push(args); } }
  }));

  await withServer(app, async (baseUrl) => {
    const openingResponse = await fetch(`${baseUrl}/registrar/intake/new`);
    const openingHtml = await openingResponse.text();
    assert.equal(openingResponse.status, 200);
    const csrfToken = openingHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
    const idempotencyKey = openingHtml.match(/name="idempotencyKey" value="([^"]+)"/)?.[1];
    assert.ok(csrfToken);
    assert.ok(idempotencyKey);

    const response = await fetch(`${baseUrl}/registrar/intake`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: csrfToken, idempotencyKey, email: 'new.student+fixture@gmail.com', lrn: '123456789012',
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
    assert.match(html, /value="new\.student\+fixture@gmail\.com"/);
    assert.match(html, /value="123456789012"/);
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
    logger: { error(_message, details) { incident = details; } }
  }));

  await withServer(app, async (baseUrl) => {
    const openingResponse = await fetch(`${baseUrl}/registrar/intake/new`);
    const openingHtml = await openingResponse.text();
    assert.equal(openingResponse.status, 200);
    const csrfToken = openingHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
    const idempotencyKey = openingHtml.match(/name="idempotencyKey" value="([^"]+)"/)?.[1];
    const response = await fetch(`${baseUrl}/registrar/intake`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey })
    });
    const html = await response.text();
    assert.equal(response.status, 503);
    assert.match(html, /Check the annual intake list before starting a new submission\./);
    assert.match(html, new RegExp(`Support reference: ${incident.incidentId}\\.`));
    assert.doesNotMatch(html, /name="idempotencyKey"/);
    assert.equal(optionLoads, 2);
    assert.equal(incident.operation, 'registrar.annual_intake.create');
  });
});

test('finalization requires an explicitly cleared pending enrollment and an inactive student login', async () => {
  for (const state of [
    { clearance_status: 'pending', is_active: false, message: /has not cleared/ }
  ]) {
    const fixture = setupFixture(({ statement }) => {
      if (statement.includes('SELECT id, role FROM users')) return { recordset: [registrar] };
      if (statement.includes('INNER JOIN annual_enrollments AS annual')) return { recordset: [] };
      if (statement.includes('FROM enrollments AS enrollment')) return { recordset: [{
        enrollment_id: 51, enrollment_status: 'pending_payment', finalized_at: null,
        student_id: 41, student_no: 'ST-100', student_status: 'active', user_id: 31, first_name: 'Jamie',
        last_name: 'Lee', email: 'new@example.edu', is_active: state.is_active ? 1 : 0,
        school_year: '2026-2027', term: 'Term 1', section_name: 'A',
        clearance_status: state.clearance_status, created_for_intake: 1
      }] };
      throw new Error('Unexpected query: ' + statement);
    });
    await assert.rejects(fixture.service.finalizeEnrollment(5, 51), state.message);
    assert.equal(fixture.log.rolledBack, true);
    assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('UPDATE users SET is_active = 1')), false);
  }
});

test('a deliberately active legacy student login is not reset during pending placement finalization', async () => {
  let activationWrites = 0;
  const fixture = setupFixture(({ statement }) => {
    if (statement.includes('SELECT id, role FROM users')) return { recordset: [registrar] };
    if (statement.includes('INNER JOIN annual_enrollments AS annual')) return { recordset: [] };
    if (statement.includes('FROM enrollments AS enrollment')) return { recordset: [{
      enrollment_id: 51, enrollment_status: 'pending_payment', finalized_at: null,
      student_id: 41, student_no: 'ST-100', student_status: 'active', user_id: 31,
      first_name: 'Jamie', last_name: 'Lee', email: 'jamie@example.edu', is_active: 1,
      school_year: '2026-2027', term: 'Term 1', section_name: 'A', clearance_status: 'cleared',
      created_for_intake: 1, account_activation_pending: 0
    }] };
    if (statement.includes('UPDATE enrollment_clearances SET account_activation_pending')) return { recordset: [] };
    if (statement.includes('UPDATE enrollments SET enrollment_status')) return { affectedRows: 1 };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    if (statement.includes('UPDATE users SET is_active = 1')) activationWrites += 1;
    throw new Error('Unexpected query: ' + statement);
  }, { createPassword: () => { throw new Error('Existing active login must not receive a new password.'); } });
  const result = await fixture.service.finalizeEnrollment(5, 51);
  assert.equal(result.temporaryPassword, null);
  assert.equal(activationWrites, 0);
  assert.equal(fixture.log.committed, true);
});

test('finalization activates a cleared intake once and returns the temporary password only in the response', async () => {
  const storedHashes = [];
  let finalized = false;
  const fixture = setupFixture(({ statement, values }) => {
    if (statement.includes('SELECT id, role FROM users')) return { recordset: [registrar] };
    if (statement.includes('INNER JOIN annual_enrollments AS annual')) return { recordset: [] };
    if (statement.includes('FROM enrollments AS enrollment')) return { recordset: [{
      enrollment_id: 51, enrollment_status: finalized ? 'enrolled' : 'pending_payment',
      finalized_at: finalized ? new Date('2026-09-28T00:00:00Z') : null,
      student_id: 41, student_no: 'ST-100', student_status: 'active', user_id: 31,
      first_name: 'Jamie', last_name: 'Lee', email: 'jamie@example.edu', is_active: 0,
      school_year: '2026-2027', term: 'Term 1', section_name: 'A', clearance_status: 'cleared', created_for_intake: 1,
      account_activation_pending: 1
    }] };
    if (statement.includes('UPDATE users SET is_active = 1')) {
      storedHashes.push(values.passwordHash);
      assert.match(statement, /must_change_password = 1/);
      assert.equal(values.passwordHash, 'bcrypt:temporary-secret-' + storedHashes.length);
      return { affectedRows: 1 };
    }
    if (statement.includes('UPDATE enrollments SET enrollment_status')) {
      finalized = true;
      return { affectedRows: 1 };
    }
    if (statement.includes('UPDATE enrollment_clearances SET account_activation_pending')) return { recordset: [] };
    if (statement.includes('INSERT INTO audit_logs')) {
      assert.doesNotMatch(values.detailsJson, /Jamie|ST-100|jamie@example|temporary-secret/);
      return { recordset: [] };
    }
    throw new Error('Unexpected query: ' + statement);
  }, {
    createPassword: (() => { let count = 0; return () => 'temporary-secret-' + (++count); })(),
    hashPassword: async (password, rounds) => { assert.equal(rounds, 12); return 'bcrypt:' + password; }
  });
  const first = await fixture.service.finalizeEnrollment(5, '51');
  assert.equal(first.temporaryPassword, 'temporary-secret-1');
  assert.equal(first.email, 'jamie@example.edu');
  assert.equal(fixture.log.committed, true);
  await assert.rejects(fixture.service.finalizeEnrollment(5, '51'), /already been finalized/);
  assert.deepEqual(storedHashes, ['bcrypt:temporary-secret-1']);
  assert.equal(fixture.log.rolledBack, true);
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
    assert.match(response.headers.get('content-disposition'), /student-login-roster-template\.csv/);
    assert.match(template, /Student Number,Email\r\nREPLACE-WITH-EXISTING-STUDENT-NUMBER,student@example\.edu/);
  });
  const printPage = fs.readFileSync(path.join(__dirname, '..', 'views/records/enrollment-print.ejs'), 'utf8');
  const appScript = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
  assert.match(printPage, /data-print-page/);
  assert.match(printPage, /<script src="\/js\/app\.js" defer><\/script>/);
  assert.doesNotMatch(printPage, /onclick\s*=/i);
  assert.match(appScript, /querySelectorAll\('\[data-print-page\]'\)[\s\S]*window\.print\(\)/);
});
