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
  createTemporaryPassword,
  createStudentSetupService
} = require('../src/services/studentSetupService');
const { validatePassword } = require('../src/services/accountService');
const { createStudentBulkAccountsRouter, createStudentIntakeRouter, createAnnualStudentIntakeRouter,
  createAnnualConfirmationRouter } = require('../src/routes/studentSetup');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');
const { AnnualEnrollmentError } = require('../src/services/annualEnrollmentService');
const { AnnualFinanceError } = require('../src/services/annualFinanceService');
const { latestBirthDate } = require('../src/services/studentRecordsService');
const { validateTransaction, createFinanceService } = require('../src/services/financeService');
const { TermClearanceError, TermClearanceSummaryUnavailableError } = require('../src/services/termClearanceService');
const { requireRole } = require('../src/middleware/roles');

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

test('temporary passwords use 12 URL-safe ASCII characters accepted by account validation', () => {
  for (let index = 0; index < 20; index += 1) {
    const password = createTemporaryPassword();
    assert.match(password, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(Buffer.byteLength(password, 'utf8'), 12);
    assert.equal(validatePassword(password), password);
  }
});

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

test('term activation stays blocked with a clear message when clearance schema lacks recording_mode', async () => {
  const app = express();
  app.set('views', path.resolve(__dirname, '../views'));
  app.set('view engine', 'ejs');
  app.use((req, _res, next) => {
    req.authUser = { id: registrar.id, role: 'registrar' };
    req.session = {};
    next();
  });
  app.use('/registrar/intake', createAnnualStudentIntakeRouter({
    annualEnrollmentService: {},
    termClearanceService: { async getTermActivationReview() { throw new TermClearanceSummaryUnavailableError(); } }
  }));
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/registrar/intake/45/activation-review`);
    const html = await response.text();
    assert.equal(response.status, 503);
    assert.match(html, /Paper-clearance prerequisite data is unavailable in the installed schema/);
    assert.match(html, /Enrollment confirmation and term activation remain blocked/);
    assert.match(html, /This term cannot be activated/);
    assert.doesNotMatch(html, /Activate term|action="\/registrar\/intake\/45\/finalize/);
  });
});

test('scheduled departure preview and recording retain Registrar role and CSRF protection', async () => {
  const app = express();
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.authUser = { id: registrar.id, role: req.get('x-role') || 'registrar' };
    req.session = { csrfToken: 'scheduled-departure-csrf' };
    next();
  });
  const calls = [];
  const record = {
    parent: { first_name: 'Synthetic', last_name: 'Learner', student_no: 'SYN-1', school_year: '2026-2027',
      grade_level: 'Grade 11', intake_kind: 'new', entry_term_number: 2, annual_enrollment_id: 71, student_id: 41,
      enrollment_start_date: '2026-08-01', registrar_confirmation_id: 'confirmed', intake_status: 'enrolled', student_status: 'active' },
    terms: [
      { enrollment_id: 102, annual_term_number: 2, term: 'Term2', term_scope_status: 'applicable',
        enrollment_status: 'enrolled', section_name: 'Synthetic Section', section_id: 5 },
      { enrollment_id: 103, annual_term_number: 3, term: 'Second term', term_scope_status: 'applicable',
        enrollment_status: 'enrolled', section_name: 'Synthetic Section', section_id: 5 }
    ],
    administrationHistory: [], tags: [], subjects: [], departure: null
  };
  const annualEnrollmentService = {
    async previewDeparture(actorId, annualId, enrollmentId, input) {
      calls.push(['preview', actorId, annualId, enrollmentId, input.effectiveDate]);
      if (input.effectiveDate < '2026-08-01') {
        throw new AnnualEnrollmentError('The departure date cannot precede the enrollment start date.', 409);
      }
      return [{ enrollment_id: 102, annual_term_number: 2, term: 'Term2', enrollment_status: 'enrolled', section_name: 'Synthetic Section', academic_activity_review_required: false }];
    },
    async getAnnualManagementRecord() { return record; },
    async createDepartureCase(actorId, annualId, enrollmentId, input) {
      calls.push(['create', actorId, annualId, enrollmentId, input.effectiveDate]);
      if (input.reason === 'Synthetic failed departure') {
        throw new AnnualEnrollmentError('Review the departure details and try again.', 409);
      }
      record.departure = { departure_type: input.departureType, effective_date: input.effectiveDate,
        application_status: 'scheduled', finance_status: 'pending' };
      return { applicationStatus: 'scheduled' };
    },
    async updateAnnualAdministrationDetails(_actorId, _annualId, input) {
      if (input.escId === 'RETAIN-ESC') throw new AnnualEnrollmentError('Review the annual details.', 409);
    }
  };
  app.use('/registrar/intake', requireRole('registrar'), createAnnualStudentIntakeRouter({ annualEnrollmentService }));

  await withServer(app, async (baseUrl) => {
    const url = `${baseUrl}/registrar/intake/71/departure-preview`;
    const cleanManage = await fetch(`${baseUrl}/registrar/intake/71/manage`);
    const cleanManageHtml = await cleanManage.text();
    assert.equal(cleanManage.status, 200);
    assert.doesNotMatch(cleanManageHtml, /data-unsaved-initially-dirty/);

    const administrationFailure = await fetch(`${baseUrl}/registrar/intake/71/administration-details`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'scheduled-departure-csrf', escId: 'RETAIN-ESC' })
    });
    const administrationHtml = await administrationFailure.text();
    assert.equal(administrationFailure.status, 409);
    assert.match(administrationHtml, /action="\/registrar\/intake\/71\/administration-details"[^>]*data-unsaved-initially-dirty="true"/);
    assert.match(administrationHtml, /id="annual-esc-id" name="escId" maxlength="80" value="RETAIN-ESC"/);
    assert.doesNotMatch(administrationHtml, /action="\/registrar\/intake\/71\/departure-preview"[^>]*data-unsaved-initially-dirty/);
    assert.equal((administrationHtml.match(/data-unsaved-initially-dirty="true"/g) || []).length, 1);

    const withoutCsrf = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ effectiveEnrollmentId: '102' }) });
    assert.equal(withoutCsrf.status, 403);
    assert.deepEqual(calls, [], 'an invalid form token is rejected before loading the affected placements');

    const financeRequest = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-role': 'finance' },
      body: new URLSearchParams({ _csrf: 'scheduled-departure-csrf', effectiveEnrollmentId: '102' }) });
    assert.equal(financeRequest.status, 403);
    assert.deepEqual(calls, [], 'Finance cannot open the Registrar placement preview');

    const invalidPreview = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'scheduled-departure-csrf', effectiveEnrollmentId: '102', departureType: 'transferred',
        effectiveDate: '2026-07-01', reason: 'Synthetic future departure' }) });
    const invalidHtml = await invalidPreview.text();
    assert.equal(invalidPreview.status, 409);
    assert.match(invalidHtml, /The departure date cannot precede the enrollment start date/);
    assert.match(invalidHtml, /name="effectiveDate" type="date" value="2026-07-01"/);
    assert.match(invalidHtml, /<textarea[^>]*id="departure-reason"[^>]*>[\s\S]*Synthetic future departure[\s\S]*<\/textarea>/);
    assert.match(invalidHtml, /action="\/registrar\/intake\/71\/departure-preview"[^>]*data-unsaved-initially-dirty="true"/);
    assert.doesNotMatch(invalidHtml, /Placement review|Schedule future departure|Apply dated departure now/);

    const preview = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'scheduled-departure-csrf', effectiveEnrollmentId: '102', departureType: 'transferred',
        effectiveDate: '2099-10-21', reason: 'Synthetic future departure' }) });
    const previewHtml = await preview.text();
    assert.equal(preview.status, 200);
    assert.doesNotMatch(previewHtml, /data-unsaved-initially-dirty/,
      'a successful calculation preview is not recovered form data');
    assert.deepEqual(calls[0], ['preview', registrar.id, '71', '102', '2026-07-01']);
    assert.deepEqual(calls[1], ['preview', registrar.id, '71', '102', '2099-10-21']);
    assert.match(previewHtml, /update automatically on that date/);
    assert.match(previewHtml, /name="effectiveDate" type="date" value="2099-10-21"/);
    assert.match(previewHtml, /<textarea[^>]*id="departure-reason"[^>]*>[\s\S]*Synthetic future departure[\s\S]*<\/textarea>/);
    assert.match(previewHtml, /<option value="102"[^>]*>Term 2 · Synthetic Section<\/option>/,
      'the departure selector suppresses a configured label that merely repeats its term number');
    assert.doesNotMatch(previewHtml, /Term 2 · Term2/);

    const failedDeparture = await fetch(`${baseUrl}/registrar/intake/71/departure`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'scheduled-departure-csrf', effectiveEnrollmentId: '102', departureType: 'transferred',
        effectiveDate: '2099-10-21', reason: 'Synthetic failed departure' }) });
    const failedDepartureHtml = await failedDeparture.text();
    assert.equal(failedDeparture.status, 409);
    assert.match(failedDepartureHtml, /action="\/registrar\/intake\/71\/departure-preview"[^>]*data-unsaved-initially-dirty="true"/);
    assert.match(failedDepartureHtml, /<textarea[^>]*id="departure-reason"[^>]*>[\s\S]*Synthetic failed departure[\s\S]*<\/textarea>/);
    assert.equal((failedDepartureHtml.match(/data-unsaved-initially-dirty="true"/g) || []).length, 1);

    const scheduled = await fetch(`${baseUrl}/registrar/intake/71/departure`, { method: 'POST',
      redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'scheduled-departure-csrf', effectiveEnrollmentId: '102', departureType: 'transferred',
        effectiveDate: '2099-10-21', reason: 'Synthetic future departure' }) });
    assert.equal(scheduled.status, 303);
    assert.equal(scheduled.headers.get('location'), '/registrar/intake/71/manage?notice=departureScheduled');
    assert.deepEqual(calls[3], ['create', registrar.id, '71', '102', '2099-10-21']);

    const read = await fetch(`${baseUrl}${scheduled.headers.get('location')}`);
    const readHtml = await read.text();
    assert.equal(read.status, 200);
    assert.match(readHtml, /data-label="Term">Term 2<\/td>/,
      'the term history uses one standard label when configured text repeats the same term');
    assert.match(readHtml, /data-label="Term">Term 3 · Second term<\/td>/,
      'a genuinely different configured term name remains visible');
    assert.doesNotMatch(readHtml, /Term 2 · Term2/);
    assert.match(readHtml, /The departure was scheduled\. Affected placements remain unchanged until its effective date\./);
    assert.match(readHtml, /<h3>Departure scheduled<\/h3>/);
    assert.match(readHtml, /2099-10-21/);

    const administrationNotice = await fetch(`${baseUrl}/registrar/intake/71/manage?notice=administrationSaved`);
    assert.match(await administrationNotice.text(), /Annual administration details saved\./);
  });
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
    emergency_contact_address: 'Lucena, Quezon', preferred_track: 'Tech-Pro Track', preferred_cluster: 'ICT Support & Computer Programming',
    voucher_type_text: 'ESC as written', voucher_category_text: 'Category A', prior_grade_level: 'Grade 10',
    prior_school: 'Lucena High School', student_signature_present: 1, student_signed_date: '2026-10-01',
    received_by: 'Front Desk Operator', received_date: '2026-10-02', receipts: []
  };
  let confirmationCall = null;
  let confirmationCalls = 0;
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
        sections: [1, 2, 3].map((number) => ({ id: number + 7, name: 'Mabini', grade_level: 'Grade 11', academic_term_id: number, school_year: '2026-2027', term: `Term ${number}`, term_number: number, cluster: 'ASSH', strand: 'Academic', adviser: 'Synthetic Adviser', modality: 'face_to_face' }))
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
      confirmationCalls += 1;
      return { annualEnrollmentId: 71, studentId: 41, studentNo: 'SHS-2026-0321', firstName: 'Synthetic', lastName: 'Learner', schoolYear: '2026-2027', gradeLevel: 'Grade 11', term: 'Term 1', sectionName: 'Mabini', total: '1334.50',
        temporaryPassword: confirmationCalls === 1 ? 'synthetic<&"credential' : null,
        alreadyConfirmed: confirmationCalls > 1 };
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
      async getAnnualEntryFinanceReadinessForRegistrar(actorId, annualId) {
        assert.equal(actorId, registrar.id);
        assert.equal(String(annualId), '71');
        return { entryTermNumber: 1, status: 'ready_for_registrar' };
      },
      async annualConfirmationAssessmentSnapshotForStaff(actorId, annualId) {
        assert.equal(actorId, registrar.id);
        assert.equal(String(annualId), '71');
        return { ...feePreview, scheduleId: 9, scheduleVersion: 2, assessmentId: 201, existingAssessment: true,
          optionalLineIds: [90], total: '1334.50', totalCents: 133450,
          termTotals: [{ termNumber: 1, amount: '1334.50' }, { termNumber: 2, amount: '0.00' }, { termNumber: 3, amount: '0.00' }],
          lines: [...feePreview.lines, { termNumber: 1, lineName: 'Tour', category: 'activity', installment: 'Once',
            grossAmount: '100.00', waivedAmount: '0.00', amount: '100.00', isOptional: true }] };
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
    assert.match(html, /Step 4 of 5: Finance handoff/);
    assert.match(html, /Step 5 of 5: Review details/);
    assert.match(html, /missing papers do not block enrollment/i);
    assert.match(html, /Select a paper only after staff has received and checked it/i);
    assert.match(html, /long brown envelope; the separate paper receipt note is informational and does not create a physical-checklist event/i);
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
    assert.match(html, /Choose an available section for the selected school year, grade, and term\. Review the saved paper track and cluster when assigning a section\./);
    assert.match(html, /<option value="8" data-year="2026-2027" data-grade="Grade 11" data-term-number="1" data-name="Mabini" data-cluster="ASSH" data-strand="Academic"/,
      'older section labels remain available even when they differ from the paper preference');
    assert.doesNotMatch(html, /Sections are limited to the saved/);
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
    assert.match(pendingHtml, /Review and finalize enrollment/);
    assert.match(pendingHtml, /Paper requirements checklist/);
    assert.match(pendingHtml, /Enrollment counts/);
    assert.match(pendingHtml, /data-label="Students"><strong>1/);

    const legacyFees = await fetch(`${baseUrl}/registrar/intake/71/fees`, { redirect: 'manual' });
    assert.equal(legacyFees.status, 303);
    assert.equal(legacyFees.headers.get('location'), '/registrar/intake/71/review');
    const finalReview = await fetch(`${baseUrl}/registrar/intake/71/review`);
    const reviewHtml = await finalReview.text();
    assert.equal(finalReview.status, 200);
    const csrfToken = reviewHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrfToken);
    assert.match(reviewHtml, /data-active-step="5"|aria-current="step"/);
    assert.match(reviewHtml, /Review enrollment details/);
    assert.match(reviewHtml, /Finance readiness/);
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
    assert.match(reviewHtml, /Ready for Registrar/);
    assert.match(reviewHtml, /full entry-term tuition DP is settled/);
    assert.doesNotMatch(reviewHtml, /₱|optionalLineIds|scheduleVersion|snapshotFingerprint|data-fee-submit/);
    assert.doesNotMatch(reviewHtml, /name="(?:firstName|middleName|lastName|studentNo|lrn|birthDate|address|phone|email)"/);
    assert.equal(feePreviewCalls.length, 0);
    const idempotencyKey = reviewHtml.match(/name="idempotencyKey" value="([0-9a-f-]{36})"/)?.[1];
    assert.ok(idempotencyKey);
    const confirmationForm = new URLSearchParams({ _csrf: csrfToken, idempotencyKey,
      clearanceSnapshotFingerprint: 'clearance-review-fingerprint' });
    const confirmResponse = await fetch(`${baseUrl}/registrar/intake/71/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: confirmationForm
    });
    const confirmedHtml = await confirmResponse.text();
    assert.equal(confirmResponse.status, 200);
    assert.match(confirmResponse.headers.get('cache-control'), /no-store/);
    assert.match(confirmedHtml, /Enrollment confirmed/);
    assert.match(confirmedHtml, /Amounts reflect the reviewed assessment after selected optional charges and approved coverage/);
    assert.match(confirmedHtml, /₱1,334\.50/);
    assert.match(confirmedHtml, /Confirmation ID <strong>101/);
    assert.match(confirmedHtml, /Itemized assessment and approved coverage/);
    assert.match(confirmedHtml, /Tour/);
    assert.match(confirmedHtml, /synthetic&lt;&amp;&#34;credential/);
    assert.doesNotMatch(confirmedHtml, /synthetic<&"credential/);
    assert.match(confirmedHtml, /<footer class="confirmation-secret"/);
    assert.match(confirmedHtml, /initial confirmation and is not emailed/);
    assert.match(confirmedHtml, /complete email verification and change it at sign-in/);
    assert.match(confirmedHtml, /Print \/ save as PDF/);
    assert.match(confirmedHtml, /type="button" data-print-page/);
    assert.match(confirmedHtml, /\/registrar\/intake\/71\/confirmation/);
    assert.match(confirmedHtml, /Open paper requirements checklist/);
    assert.deepEqual(confirmationCall, { actorId: registrar.id, annualId: '71', input: {
      _csrf: csrfToken, idempotencyKey,
      clearanceSnapshotFingerprint: 'clearance-review-fingerprint'
    } });

    const replayResponse = await fetch(`${baseUrl}/registrar/intake/71/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: confirmationForm
    });
    const replayHtml = await replayResponse.text();
    assert.equal(replayResponse.status, 200);
    assert.match(replayResponse.headers.get('cache-control'), /no-store/);
    assert.match(replayHtml, /data-print-page/);
    assert.doesNotMatch(replayHtml, /synthetic&lt;&amp;&#34;credential|One-time temporary password/);
    assert.equal(confirmationCalls, 2);

    const reopened = await fetch(`${baseUrl}/registrar/intake/71/confirmation`);
    const reopenedHtml = await reopened.text();
    assert.equal(reopened.status, 200);
    assert.match(reopened.headers.get('cache-control'), /no-store/);
    assert.match(reopenedHtml, /Enrollment confirmed/);
    assert.match(reopenedHtml, /Downpayment/);
    assert.match(reopenedHtml, /Approved coverage/);
    assert.match(reopenedHtml, /Confirmation ID <strong>101/);
    assert.match(reopenedHtml, /Current term placements/);
    assert.doesNotMatch(reopenedHtml, /synthetic&lt;&amp;&#34;credential|One-time temporary password/);
    assert.match(reopenedHtml, /data-print-page/);
    assert.equal(confirmationCall?.annualId, '71');
    const confirmationCss = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');
    assert.match(confirmationCss, /\.annual-confirmation-document \.confirmation-secret \{\s*display: block !important;/);
    assert.match(confirmationCss, /\.annual-confirmation-document \.confirmation-secret \{[\s\S]*?break-inside: avoid;/);
    assert.match(confirmationCss, /\.annual-confirmation-document \.admin-table thead \{ position: static !important; display: table-header-group !important;/,
      'the shared tuition installment table is reset from the narrow-screen clipped header rules when printed');
    assert.match(confirmationCss, /\.annual-confirmation-document \.admin-table td::before \{ display: none !important;/);
    assert.match(confirmationCss, /\.fee-approved-tuition \.admin-table td:nth-child\(n\+2\) \{ text-align: right;/);
  });
});

test('continuity-source failures recover only the source form and reject a refreshed-away choice', async () => {
  const app = express();
  const csrfToken = 'continuity-source-csrf';
  const calls = [];
  let eligibleCandidates = [
    { id: 410, schoolYear: '2025-2026', gradeLevel: 'Grade 11', selectable: true },
    { id: 411, schoolYear: '2025-2026', gradeLevel: 'Grade 11', selectable: true }
  ];
  let boundSourceId = null;
  let forceConflict = true;
  let forceUnexpectedFailure = false;
  let prerequisiteKind = 'continuing_source';
  const record = {
    parent: { annual_enrollment_id: 71, student_id: 41, student_no: 'SYN-71', lrn: '123456789012',
      first_name: 'Synthetic', middle_name: '', last_name: 'Learner', suffix: '', birth_date: '2008-04-21',
      sex: 'Female', address: 'Synthetic address', phone: '', student_email: 'learner@example.edu',
      school_year: '2026-2027', grade_level: 'Grade 12', voucher_code: 'PUB', intake_kind: 'continuing',
      entry_term_number: 1, enrollment_start_date: '2026-08-01', intake_status: 'pending',
      registrar_confirmation_id: null },
    terms: []
  };
  const annualEnrollmentService = {
    async getAnnualManagementRecord(actorId, annualId) {
      assert.equal(actorId, registrar.id);
      assert.equal(String(annualId), '71');
      return record;
    }
  };
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.formatStudentPlacement = require('../src/utils/formatStudentPlacement').formatStudentPlacement;
  app.locals.formatMoney = require('../src/utils/formatMoney').formatMoney;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.authUser = { ...registrar, role: req.get('x-role') || 'registrar' };
    req.session = { csrfToken };
    next();
  });
  app.use('/registrar/intake', requireRole('registrar'), createAnnualStudentIntakeRouter({
    annualEnrollmentService,
    annualFinanceService: { async getAnnualEntryFinanceReadinessForRegistrar() {
      return { entryTermNumber: 1, status: 'ready_for_registrar' };
    } },
    physicalChecklistService: { async getStudentChecklist() {
      return { summary: { completeCount: 0, requiredCount: 0 }, requirements: [], additionalItems: [], history: [] };
    } },
    termClearanceService: {
      async getAnnualPrerequisiteReview() {
        if (prerequisiteKind === 'null') return null;
        return { ready: prerequisiteKind === 'already_confirmed', kind: prerequisiteKind, sourceAnnualId: boundSourceId,
          sourceSchoolYear: boundSourceId ? '2025-2026' : null, terms: [], blockers: ['Choose the preceding source.'], fingerprint: 'synthetic-fingerprint' };
      },
      async getContinuitySourceOptions(actorId, annualId) {
        assert.equal(actorId, registrar.id);
        assert.equal(String(annualId), '71');
        return { annualId: 71, schoolYear: '2026-2027', gradeLevel: 'Grade 12',
          sourceAnnualId: boundSourceId, sourceLocked: boundSourceId !== null,
          candidates: eligibleCandidates.map((candidate) => ({ ...candidate })) };
      },
      async bindContinuitySource(actorId, annualId, sourceId, input) {
        calls.push({ actorId, annualId: String(annualId), sourceId: String(sourceId), ...input });
        if (boundSourceId !== null) throw new TermClearanceError('This continuing intake already has a locked source.', 409);
        const selected = eligibleCandidates.find((candidate) => candidate.selectable && String(candidate.id) === String(sourceId));
        if (!selected) throw new TermClearanceError('The preceding-year source is no longer eligible.', 409);
        if (forceUnexpectedFailure) throw new Error('Synthetic private service diagnostic');
        if (forceConflict) throw new TermClearanceError('Synthetic source review conflict.', 409);
        boundSourceId = Number(sourceId);
        return { annualId: 71, sourceAnnualId: boundSourceId };
      }
    }
  }));

  await withServer(app, async (baseUrl) => {
    const reviewUrl = `${baseUrl}/registrar/intake/71/review`;
    const cleanResponse = await fetch(reviewUrl);
    const cleanHtml = await cleanResponse.text();
    assert.equal(cleanResponse.status, 200);
    const cleanSourceForm = cleanHtml.match(/<form[^>]*action="\/registrar\/intake\/71\/continuity-source"[\s\S]*?<\/form>/)?.[0];
    assert.ok(cleanSourceForm);
    assert.doesNotMatch(cleanSourceForm, /data-unsaved-initially-dirty|Synthetic recovered reason/);
    assert.match(cleanSourceForm, /<option value=""\s*>Choose the verified source<\/option>/);
    const sourceKey = cleanSourceForm.match(/name="idempotencyKey" value="([0-9a-f-]{36})"/)?.[1];
    assert.ok(sourceKey);

    const missingCsrf = await fetch(`${baseUrl}/registrar/intake/71/continuity-source`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sourceAnnualId: '410', reason: 'Synthetic recovered reason', idempotencyKey: sourceKey })
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(calls.length, 0, 'CSRF rejection happens before the continuity service write');

    const wrongRole = await fetch(`${baseUrl}/registrar/intake/71/continuity-source`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-role': 'finance' },
      body: new URLSearchParams({ _csrf: csrfToken, sourceAnnualId: '410', reason: 'Synthetic recovered reason', idempotencyKey: sourceKey })
    });
    assert.equal(wrongRole.status, 403);
    assert.equal(calls.length, 0, 'non-Registrar role is rejected before the continuity service write');

    const reason = 'Reviewed <script>alert("source")</script> & confirmed';
    const failed = await fetch(`${baseUrl}/registrar/intake/71/continuity-source`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, sourceAnnualId: '410', reason, idempotencyKey: sourceKey })
    });
    const failedHtml = await failed.text();
    assert.equal(failed.status, 409);
    assert.match(failedHtml, /Synthetic source review conflict\./);
    const failedSourceForm = failedHtml.match(/<form[^>]*action="\/registrar\/intake\/71\/continuity-source"[\s\S]*?<\/form>/)?.[0];
    assert.ok(failedSourceForm);
    assert.match(failedSourceForm, /data-unsaved-initially-dirty="true"/);
    assert.match(failedSourceForm, /<option value="410" selected>2025-2026 · Grade 11<\/option>/);
    assert.match(failedSourceForm, /<textarea[^>]*id="continuity-source-reason"[^>]*>[\s\S]*Reviewed &lt;script&gt;alert\(&#34;source&#34;\)&lt;\/script&gt; &amp; confirmed[\s\S]*<\/textarea>/);
    assert.doesNotMatch(failedSourceForm, /<script>alert\("source"\)<\/script>/);
    assert.equal(failedSourceForm.match(/name="idempotencyKey" value="([0-9a-f-]{36})"/)?.[1], sourceKey);
    assert.equal((failedHtml.match(/data-unsaved-initially-dirty="true"/g) || []).length, 1);
    const siblingConfirmForm = failedHtml.match(/<form[^>]*action="\/registrar\/intake\/71\/confirm"[\s\S]*?<\/form>/)?.[0];
    assert.ok(siblingConfirmForm);
    assert.doesNotMatch(siblingConfirmForm, /data-unsaved-initially-dirty|Reviewed|sourceAnnualId/);
    assert.notEqual(siblingConfirmForm.match(/name="idempotencyKey" value="([0-9a-f-]{36})"/)?.[1], sourceKey,
      'the failed source-review token remains separate from the sibling confirmation token');
    assert.equal(calls[0].actorId, registrar.id);
    assert.equal(calls[0].sourceId, '410');
    assert.equal(calls[0].reason, reason);
    assert.equal(calls[0].idempotencyKey, sourceKey);

    eligibleCandidates = [{ id: 411, schoolYear: '2025-2026', gradeLevel: 'Grade 11', selectable: true }];
    const stale = await fetch(`${baseUrl}/registrar/intake/71/continuity-source`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, sourceAnnualId: '410', reason: 'Retained after source changed', idempotencyKey: sourceKey })
    });
    const staleHtml = await stale.text();
    assert.equal(stale.status, 409);
    const staleSourceForm = staleHtml.match(/<form[^>]*action="\/registrar\/intake\/71\/continuity-source"[\s\S]*?<\/form>/)?.[0];
    assert.ok(staleSourceForm);
    assert.match(staleSourceForm, /data-unsaved-initially-dirty="true"/);
    assert.match(staleSourceForm, /<option value="" selected>Choose the verified source<\/option>/,
      'the no-longer-eligible choice does not auto-select a different valid source');
    assert.doesNotMatch(staleSourceForm, /<option value="410"/,
      'an unavailable submitted ID is not fabricated into the eligible option list');
    assert.match(staleSourceForm, /The source submitted earlier is no longer eligible/);
    assert.match(staleSourceForm, /Retained after source changed/);
    assert.equal((staleHtml.match(/data-unsaved-initially-dirty="true"/g) || []).length, 1);

    forceUnexpectedFailure = true;
    const unexpectedFailure = await fetch(`${baseUrl}/registrar/intake/71/continuity-source`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, sourceAnnualId: '411', reason: 'Retained after service failure', idempotencyKey: sourceKey })
    });
    const unexpectedHtml = await unexpectedFailure.text();
    assert.equal(unexpectedFailure.status, 503);
    assert.match(unexpectedHtml, /The save did not return confirmation\. Check the current enrollment state before retrying/);
    assert.doesNotMatch(unexpectedHtml, /source was not bound|did not save|reason \(not saved\)/i,
      'an unexpected service failure may occur after a committed write, so recovery does not claim the write failed');
    assert.doesNotMatch(unexpectedHtml, /Synthetic private service diagnostic/);
    const unexpectedSourceForm = unexpectedHtml.match(/<form[^>]*action="\/registrar\/intake\/71\/continuity-source"[\s\S]*?<\/form>/)?.[0];
    assert.ok(unexpectedSourceForm);
    assert.match(unexpectedSourceForm, /data-unsaved-initially-dirty="true"/);
    assert.match(unexpectedSourceForm, /<option value="411" selected>2025-2026 · Grade 11<\/option>/);
    assert.match(unexpectedSourceForm, /Retained after service failure/);
    assert.equal(unexpectedSourceForm.match(/name="idempotencyKey" value="([0-9a-f-]{36})"/)?.[1], sourceKey);

    forceUnexpectedFailure = false;
    forceConflict = false;
    const saved = await fetch(`${baseUrl}/registrar/intake/71/continuity-source`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, sourceAnnualId: '411', reason: 'Current verified source', idempotencyKey: sourceKey })
    });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), '/registrar/intake/71/review');
    assert.equal(calls[1].sourceId, '410');
    assert.equal(calls[2].sourceId, '411');
    assert.equal(calls[3].sourceId, '411');

    prerequisiteKind = 'already_confirmed';
    record.parent.registrar_confirmation_id = 900;
    record.parent.intake_status = 'confirmed';
    const afterSave = await fetch(reviewUrl);
    const afterSaveHtml = await afterSave.text();
    assert.equal(afterSave.status, 200);
    assert.doesNotMatch(afterSaveHtml, /data-unsaved-initially-dirty/);
    assert.doesNotMatch(afterSaveHtml, /action="\/registrar\/intake\/71\/continuity-source"/,
      'a now-locked source review does not retain an editable stale form');

    const lockedFailure = await fetch(`${baseUrl}/registrar/intake/71/continuity-source`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, sourceAnnualId: '410', reason: 'Retained after concurrent source lock', idempotencyKey: sourceKey })
    });
    const lockedHtml = await lockedFailure.text();
    assert.equal(lockedFailure.status, 409);
    assert.match(lockedHtml, /The source-review form is unavailable in the refreshed enrollment state/);
    assert.match(lockedHtml, /<strong>Submitted reason from this attempt:<\/strong> Retained after concurrent source lock/);
    assert.doesNotMatch(lockedHtml, /action="\/registrar\/intake\/71\/continuity-source"|data-unsaved-initially-dirty/,
      'read-only recovery retains the reason without reopening or dirty-marking a locked form');
    assert.equal(calls[4].sourceId, '410');

    for (const hiddenPrerequisite of ['exempt', 'null']) {
      record.parent.registrar_confirmation_id = null;
      record.parent.intake_status = 'pending';
      prerequisiteKind = hiddenPrerequisite;
      boundSourceId = null;
      forceConflict = true;
      const reason = `Retained reason while ${hiddenPrerequisite} review hid the source editor <tag>`;
      const hiddenEditorFailure = await fetch(`${baseUrl}/registrar/intake/71/continuity-source`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrfToken, sourceAnnualId: '411', reason, idempotencyKey: sourceKey })
      });
      const hiddenEditorHtml = await hiddenEditorFailure.text();
      assert.equal(hiddenEditorFailure.status, 409);
      assert.match(hiddenEditorHtml, /<strong>Submitted reason from this attempt:<\/strong>/);
      assert.match(hiddenEditorHtml, /Retained reason while .* review hid the source editor &lt;tag&gt;/);
      assert.doesNotMatch(hiddenEditorHtml, /<tag>/, 'read-only recovery escapes submitted text');
      assert.doesNotMatch(hiddenEditorHtml, /action="\/registrar\/intake\/71\/continuity-source"|data-unsaved-initially-dirty/,
        `${hiddenPrerequisite} prerequisites keep the hidden editor closed and clean`);
    }
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
        assert.ok(['71', '72', '73', '999'].includes(String(annualId)));
        if (String(annualId) === '999') return null;
        if (String(annualId) === '73') return {
          ...record,
          parent: { ...parent, annual_enrollment_id: 73, intake_status: 'pending', registrar_confirmation_id: null,
            adviser: 'Saved Adviser', modality: 'hybrid' },
          terms: record.terms.map((term) => Number(term.annual_term_number) === 2
            ? { ...term, cluster: 'Academic', strand: 'STEM', adviser: 'Saved Adviser', modality: 'hybrid' } : term),
          subjects: [
            { annual_term_number: 2, subject_code: 'ENG11', subject_name: 'Long saved subject title for print layout', schedules: [
              { day_of_week: 'Monday', schedule_start_time: '08:00', schedule_end_time: '09:00', room: 'Room 2' },
              { day_of_week: 'Wednesday', schedule_start_time: '10:00', schedule_end_time: '11:00', room: 'Room 2' }
            ] },
            { annual_term_number: 2, subject_code: 'MATH11', subject_name: 'Schedule not configured', schedules: [] }
          ]
        };
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

    const pendingFormResponse = await fetch(`${baseUrl}/registrar/intake/73/pending-form`);
    const pendingFormHtml = await pendingFormResponse.text();
    assert.equal(pendingFormResponse.status, 200);
    assert.match(pendingFormResponse.headers.get('cache-control'), /no-store/);
    assert.match(pendingFormHtml, /Registrar Copy[\s\S]*Finance Copy[\s\S]*Student Copy/);
    assert.match(pendingFormHtml, /For Finance \/ enrollment not yet confirmed/);
    assert.match(pendingFormHtml, /Long saved subject title for print layout/);
    assert.equal((pendingFormHtml.match(/Long saved subject title for print layout/g) || []).length, 6,
      'each saved schedule slot appears in every labeled copy');
    assert.match(pendingFormHtml, /Schedule not configured/);
    assert.match(pendingFormHtml, /Saved Adviser/);
    assert.match(pendingFormHtml, /hybrid/);
    assert.doesNotMatch(pendingFormHtml, /temporary password|credential|receipt number|<strong>Enrolled<\/strong>/i);
    assert.match(pendingFormHtml, /signature: __________________________________________/i);

    const finalRecordPendingForm = await fetch(`${baseUrl}/registrar/intake/71/pending-form`);
    assert.equal(finalRecordPendingForm.status, 409, 'finalized records cannot use the pending paper form');
    const financePendingForm = await fetch(`${baseUrl}/registrar/intake/73/pending-form`, { headers: { 'x-test-role': 'finance' } });
    assert.equal(financePendingForm.status, 403, 'Finance does not access the Registrar pending copy route');
  });
  const managementTemplate = fs.readFileSync(path.join(__dirname, '..', 'views/records/annual-management.ejs'), 'utf8');
  assert.match(managementTemplate, /if \(record\.parent\.registrar_confirmation_id\)[\s\S]*?\/confirmation/,
    'staff can reopen the credential-free confirmation after leaving the initial response');
});

test('later-term activation sends its one-time credential in a private printable response', async () => {
  const app = express();
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.authUser = registrar;
    req.session = { csrfToken: 'b'.repeat(64) };
    next();
  });
  app.use('/registrar/intake', createAnnualStudentIntakeRouter({
    annualEnrollmentService: {
      async finalizeAnnualTerm(actorId, enrollmentId) {
        assert.equal(actorId, registrar.id);
        assert.equal(enrollmentId, '51');
        return { enrollmentId: 51, studentNo: 'SHS-2026-0321', firstName: 'Synthetic', middleName: '',
          lastName: 'Learner', suffix: '', schoolYear: '2026-2027', term: 'Term 2', sectionName: 'Mabini',
          email: 'learner@example.edu', temporaryPassword: '<legacy&secret>' };
      }
    }
  }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/registrar/intake/51/finalize`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'b'.repeat(64) })
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(html, /<section class="enrollment-print__credential"/);
    assert.match(html, /&lt;legacy&amp;secret&gt;/);
    assert.match(html, /data-print-page/);
    assert.doesNotMatch(html, /<legacy&secret>/);
  });
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');
  assert.match(css, /\.enrollment-print__credential \{[\s\S]*?font-size: 8pt;[\s\S]*?break-inside: avoid;/);
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
    annualFinanceService: { async getAnnualEntryFinanceReadinessForRegistrar() { throw new Error('must not be reached'); } },
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
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(html, /synthetic-one-time-credential/);
    assert.match(html, /type="button" data-print-page/);
    assert.match(html, /Print \/ save as PDF/);
    assert.match(html, /\/registrar\/intake\/71\/confirmation/);
    assert.match(html, /View \/ print saved confirmation/);
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
    annualFinanceService: { async getAnnualEntryFinanceReadinessForRegistrar() { return { entryTermNumber: 1, status: 'ready_for_registrar' }; } },
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
    assert.doesNotMatch(openingHtml, /data-unsaved-initially-dirty/);
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
    assert.match(html, /action="\/registrar\/intake"[^>]*data-unsaved-initially-dirty="true"/);
    assert.equal((html.match(/data-unsaved-initially-dirty="true"/g) || []).length, 1);
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
