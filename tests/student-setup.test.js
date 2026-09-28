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
const { createStudentBulkAccountsRouter, createStudentIntakeRouter } = require('../src/routes/studentSetup');
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
  return statement.includes('DECLARE @prefix');
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
    if (statement.includes('SELECT id, role FROM dbo.users')) return { recordset: [admin] };
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
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.users')), false);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('UPDATE dbo.students')), false);
});

test('bulk setup returns distinct temporary credentials while storing bcrypt hashes only', async () => {
  let nextUserId = 20;
  const fixture = setupFixture(({ statement, values }) => {
    if (statement.includes('SELECT id, role FROM dbo.users')) return { recordset: [admin] };
    if (statement.includes('WITH input_rows AS')) return { recordset: unlinkedRows };
    if (statement.includes('INSERT INTO dbo.users')) return { recordset: [{ user_id: nextUserId++ }] };
    if (statement.includes('UPDATE dbo.students')) return { rowsAffected: [1] };
    if (statement.includes('INSERT INTO dbo.audit_logs')) {
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
  const writes = fixture.log.queries.filter(({ statement }) => statement.includes('INSERT INTO dbo.users'));
  assert.deepEqual(writes.map(({ values }) => values.passwordHash), ['bcrypt:temp-1', 'bcrypt:temp-2']);
  assert.ok(writes.every(({ statement }) => statement.includes('must_change_password')));
});

test('registrar intake rejects existing identifiers before any inserts', async () => {
  const fixture = setupFixture(({ statement }) => {
    if (statement.includes('SELECT id, role FROM dbo.users')) return { recordset: [registrar] };
    if (statement.includes('SELECT section.id, term.school_year')) return { recordset: [{ id: 8, school_year: '2026-2027' }] };
    if (statement.includes('sp_getapplock')) return { recordset: [{ lock_result: 0 }] };
    if (generatedStudentNumberQuery(statement)) return { recordset: [{ student_no: 'SHS-2026-0321' }] };
    if (statement.includes('SELECT\n          CASE WHEN EXISTS')) return { recordset: [{ student_no_exists: 0, lrn_exists: 1, email_exists: 0, pending_email_exists: 0 }] };
    throw new Error('Unexpected query: ' + statement);
  });
  await assert.rejects(fixture.service.createEnrollmentIntake(5, {
    studentNo: 'ST-100', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee',
    email: 'new@example.edu', academicTermId: '2', sectionId: '8'
  }), /LRN is already in use/);
  assert.equal(fixture.log.rolledBack, true);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.users')), false);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.students')), false);
});

test('registrar intake creates an inactive linked login, new profile, pending enrollment, and clearance atomically', async () => {
  let nextUserId = 31;
  const fixture = setupFixture(({ statement, values }) => {
    if (statement.includes('SELECT id, role FROM dbo.users')) return { recordset: [registrar] };
    if (statement.includes('SELECT section.id, term.school_year')) {
      assert.equal(values.termId, 2);
      assert.equal(values.sectionId, 8);
      return { recordset: [{ id: 8, school_year: '2026-2027' }] };
    }
    if (statement.includes('sp_getapplock')) return { recordset: [{ lock_result: 0 }] };
    if (generatedStudentNumberQuery(statement)) return { recordset: [{ student_no: 'SHS-2026-0321' }] };
    if (statement.includes('SELECT\n          CASE WHEN EXISTS')) return { recordset: [{
      student_no_exists: 0, lrn_exists: 0, email_exists: 0, pending_email_exists: 0
    }] };
    if (statement.includes('FROM dbo.sections AS section')) return { recordset: [{ id: values.sectionId }] };
    if (statement.includes('INSERT INTO dbo.users')) {
      assert.equal(values.email, 'jamie@example.edu');
      assert.equal(values.mustChangePassword, true);
      assert.match(statement, /N'student', 0, @mustChangePassword/);
      assert.notEqual(values.passwordHash, 'inaccessible-placeholder');
      return { recordset: [{ user_id: nextUserId++ }] };
    }
    if (statement.includes('INSERT INTO dbo.students')) {
      assert.equal(values.userId, 31);
      assert.equal(values.studentNo, 'SHS-2026-0321');
      assert.match(statement, /OUTPUT INSERTED\.id INTO @insertedStudents/);
      assert.equal(values.firstName, 'Jamie');
      return { recordset: [{ student_id: 41 }] };
    }
    if (statement.includes('INSERT INTO dbo.enrollments')) {
      assert.equal(values.studentId, 41);
      assert.equal(values.termId, 2);
      assert.equal(values.sectionId, 8);
      assert.match(statement, /N'pending_payment'/);
      return { recordset: [{ enrollment_id: 51 }] };
    }
    if (statement.includes('INSERT INTO dbo.enrollment_clearances')) {
      assert.equal(values.enrollmentId, 51);
      assert.equal(values.actorId, 5);
      assert.match(statement, /N'pending'/);
      return { recordset: [] };
    }
    if (statement.includes('INSERT INTO dbo.audit_logs')) {
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
  assert.equal(fixture.log.queries.find(({ statement }) => statement.includes('INSERT INTO dbo.students')).values.studentNo, 'SHS-2026-0321');
  assert.ok(fixture.log.queries.some(({ statement, values }) => statement.includes('sp_getapplock') && values.resource === 'student-number:2026'));
  assert.equal(fixture.log.queries.filter(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')).length, 1);
});

test('registrar intake rejects missing or invalid term years before creating records', async () => {
  const validProfile = {
    lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee', email: 'new@example.edu',
    academicTermId: '2', sectionId: '8'
  };
  const missingTerm = setupFixture(({ statement }) => {
    if (statement.includes('SELECT id, role FROM dbo.users')) return { recordset: [registrar] };
    if (statement.includes('SELECT section.id, term.school_year')) return { recordset: [] };
    throw new Error('Unexpected query: ' + statement);
  });
  await assert.rejects(missingTerm.service.createEnrollmentIntake(5, validProfile), /Choose an existing academic term/);
  assert.equal(missingTerm.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.users')), false);

  const invalidTerm = setupFixture(({ statement }) => {
    if (statement.includes('SELECT id, role FROM dbo.users')) return { recordset: [registrar] };
    if (statement.includes('SELECT section.id, term.school_year')) return { recordset: [{ id: 8, school_year: '2026/2027' }] };
    throw new Error('Unexpected query: ' + statement);
  });
  await assert.rejects(invalidTerm.service.createEnrollmentIntake(5, validProfile), /invalid school year/);
  assert.equal(invalidTerm.log.queries.some(({ statement }) => statement.includes('sp_getapplock')), false);
  assert.equal(invalidTerm.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.students')), false);
});

test('student intake form explains automatic numbering and does not request a student number', async () => {
  const app = express();
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.formatStudentPlacement = require('../src/utils/formatStudentPlacement').formatStudentPlacement;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { req.authUser = registrar; req.session = {}; next(); });
  app.use('/registrar/intake', createStudentIntakeRouter({ studentSetupService: {
    async loadIntakeOptions() {
      return {
        terms: [{ id: 2, school_year: '2026-2027', term: 'First', is_current: true }],
        sections: [{ id: 8, name: 'Mabini', grade_level: 'Grade 11', academic_term_id: 2, school_year: '2026-2027', term: 'First' }]
      };
    },
    async listPendingIntakes() {
      return [{ enrollment_id: 51, student_id: 41, student_no: 'SHS-2026-0321', first_name: 'Synthetic', last_name: 'Learner', email: 'learner@example.edu', school_year: '2026-2027', term: 'First', section_name: 'Mabini', clearance_status: 'pending' }];
    }
  } }));
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/registrar/intake/new`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /assigned automatically/);
    assert.match(html, /SHS-YYYY-0001/);
    assert.doesNotMatch(html, /name="studentNo"/);
    assert.match(html, /name="lrn"/);
    const pending = await fetch(`${baseUrl}/registrar/intake`);
    const pendingHtml = await pending.text();
    assert.equal(pending.status, 200);
    assert.match(pendingHtml, /SHS-2026-0321/);
  });
});

test('finalization requires an explicitly cleared pending enrollment and an inactive student login', async () => {
  for (const state of [
    { clearance_status: 'pending', is_active: false, message: /has not cleared/ },
    { clearance_status: 'cleared', is_active: true, message: /already active/ }
  ]) {
    const fixture = setupFixture(({ statement }) => {
      if (statement.includes('SELECT id, role FROM dbo.users')) return { recordset: [registrar] };
      if (statement.includes('FROM dbo.enrollments AS enrollment WITH')) return { recordset: [{
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
    assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('UPDATE dbo.users SET is_active = 1')), false);
  }
});

test('finalization activates a cleared intake once and returns the temporary password only in the response', async () => {
  const storedHashes = [];
  let finalized = false;
  const fixture = setupFixture(({ statement, values }) => {
    if (statement.includes('SELECT id, role FROM dbo.users')) return { recordset: [registrar] };
    if (statement.includes('FROM dbo.enrollments AS enrollment WITH')) return { recordset: [{
      enrollment_id: 51, enrollment_status: finalized ? 'enrolled' : 'pending_payment',
      finalized_at: finalized ? new Date('2026-09-28T00:00:00Z') : null,
      student_id: 41, student_no: 'ST-100', student_status: 'active', user_id: 31,
      first_name: 'Jamie', last_name: 'Lee', email: 'jamie@example.edu', is_active: 0,
      school_year: '2026-2027', term: 'Term 1', section_name: 'A', clearance_status: 'cleared', created_for_intake: 1
    }] };
    if (statement.includes('UPDATE dbo.users SET is_active = 1')) {
      storedHashes.push(values.passwordHash);
      assert.match(statement, /must_change_password = 1/);
      assert.equal(values.passwordHash, 'bcrypt:temporary-secret-' + storedHashes.length);
      return { recordset: [{ user_id: 31 }] };
    }
    if (statement.includes('UPDATE dbo.enrollments SET enrollment_status')) {
      finalized = true;
      return { rowsAffected: [1] };
    }
    if (statement.includes('INSERT INTO dbo.audit_logs')) {
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
          if (statement.includes('FROM dbo.users WITH')) return { recordset: [{ id: 7, role: 'finance' }] };
          if (statement.includes('FROM dbo.financial_accounts AS a')) return { recordset: [{ financial_account_id: 30, balance, status: 'active' }] };
          if (statement.includes('FROM dbo.enrollments AS enrollment WITH')) return { recordset: [{
            id: 51, enrollment_status: 'pending_payment', finalized_at: null, clearance_status: 'pending', created_for_intake: 1
          }] };
          if (statement.includes('UPDATE dbo.financial_accounts')) { balance = values.balance; return { rowsAffected: [1] }; }
          if (statement.includes('INSERT INTO dbo.financial_transactions')) return { recordset: [{ id: 91 }] };
          if (statement.includes('UPDATE dbo.enrollment_clearances')) return { rowsAffected: failClear ? [0] : [1] };
          if (statement.includes('INSERT INTO dbo.audit_logs')) return { recordset: [] };
          throw new Error('Unexpected query: ' + statement);
        }
      };
    },
    async commit() { log.committed = true; },
    async rollback() { log.rolledBack = true; }
  });
  const service = createFinanceService({ getPool: async () => ({}), sql: fakeSql(), transactionFactory });
  const input = { transactionType: 'payment', amount: '2.00', clearEnrollmentId: '51', confirmEnrollmentClearance: '1' };
  const result = await service.recordTransaction(7, 22, input);
  assert.equal(result.transactionId, 91);
  assert.equal(result.balance, '8.00');
  const clearance = log.queries.find(({ statement }) => statement.includes('UPDATE dbo.enrollment_clearances'));
  assert.equal(clearance.values.enrollmentId, 51);
  assert.equal(clearance.values.transactionId, 91);
  assert.equal(log.committed, true);

  failClear = true;
  await assert.rejects(service.recordTransaction(7, 22, input), /cleared by another finance transaction/);
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.filter(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')).length, 1);
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
