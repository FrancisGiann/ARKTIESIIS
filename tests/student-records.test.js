const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');
const {
  StudentRecordsError,
  createStudentRecordsService,
  validateStudent,
  normalizeLrn,
  validateTerm,
  validateSection,
  validateEnrollment
} = require('../src/services/studentRecordsService');

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function fakeSql() {
  return {
    MAX: 'MAX',
    Date: 'Date',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
    Int: 'Int',
    Bit: 'Bit',
    NVarChar: (length) => `NVarChar(${length})`
  };
}

function transactionalService(onQuery) {
  const log = { queries: [], isolation: null, committed: false, rolledBack: false };
  const transactionFactory = () => ({
    async begin(isolation) { log.isolation = isolation; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          const call = { statement, values: { ...values } };
          log.queries.push(call);
          return onQuery(call);
        }
      };
    },
    async commit() { log.committed = true; },
    async rollback() { log.rolledBack = true; }
  });
  const service = createStudentRecordsService({ getPool: async () => ({}), sql: fakeSql(), transactionFactory });
  return { service, log };
}

function makeAuthPool(role) {
  const user = {
    id: 7,
    email: `${role}@example.edu`,
    password_hash: bcrypt.hashSync('Correct-Horse-Battery-12', 4),
    role,
    is_active: true,
    updated_at_fingerprint: ''
  };
  const getPool = async () => ({
    request() {
      return {
        input() { return this; },
        async query(statement) {
          if (statement.includes('WHERE email = @email')) return { recordset: [user] };
          if (statement.includes('WHERE id = @userId')) return { recordset: [{ ...user }] };
          throw new Error(`Unexpected auth query: ${statement}`);
        }
      };
    }
  });
  return getPool;
}

const environment = {
  nodeEnv: 'development',
  devPasswordOnlyLogin: true,
  sessionSecret: 'phase-five-student-records-test-session-secret'
};

function getCookie(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'expected a session cookie');
  return cookie.split(';', 1)[0];
}

function csrfFromHtml(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'expected a CSRF token');
  return match[1];
}

async function postForm(baseUrl, path, cookie, values) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values)
  });
}

async function signIn(baseUrl, role) {
  const page = await fetch(`${baseUrl}/login`);
  const cookie = getCookie(page);
  const csrfToken = csrfFromHtml(await page.text());
  const response = await postForm(baseUrl, '/login', cookie, {
    _csrf: csrfToken,
    email: `${role}@example.edu`,
    password: 'Correct-Horse-Battery-12'
  });
  assert.equal(response.status, 303);
  return getCookie(response);
}

test('student record, term, section, and enrollment inputs are bounded and validated', () => {
  assert.equal(validateStudent({ studentNo: ' S-1 ', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee', birthDate: '2008-02-29' }).studentNo, 'S-1');
  assert.equal(validateStudent({ lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee' }, { requireStudentNo: false }).studentNo, null);
  assert.throws(() => normalizeLrn('12345678901'), /exactly 12 digits/);
  assert.throws(() => normalizeLrn('12345678901 '), /exactly 12 digits/);
  assert.equal(validateStudent({ studentNo: 'S-OLD', firstName: 'Jamie', lastName: 'Lee' }, { requireLrn: false }).lrn, null);
  assert.throws(() => validateStudent({ studentNo: 'S-NEW', firstName: 'Jamie', lastName: 'Lee' }), /LRN must contain exactly 12 digits/);
  assert.throws(() => validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee', birthDate: '2007-02-29' }), /valid birth date/);
  assert.throws(() => validateStudent({ studentNo: 'S-1', firstName: 'Jamie\nLee', lastName: 'Lee' }), /First name is required/);
  assert.throws(() => validateTerm({ schoolYear: '2026', term: 'A'.repeat(31) }), StudentRecordsError);
  assert.throws(() => validateSection({ name: 'Grade 7', academicTermId: '3x' }), /valid academic term/);
  assert.throws(() => validateEnrollment({ studentId: '0', academicTermId: '4' }), /valid student/);
  assert.deepEqual(validateEnrollment({ studentId: '5', academicTermId: '4', sectionId: '' }), { studentId: 5, academicTermId: 4, sectionId: null });
});

test('LRN is required for new students, registrars can backfill blanks, and only administrators create profiles or change recorded LRNs', async () => {
  const input = { studentNo: 'S-13', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee' };
  const registrarEdit = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM dbo.students WITH')) return { recordset: [{ id: 12, status: 'active', student_no: 'S-12', lrn: input.lrn }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(registrarEdit.service.saveStudent(7, 12, input), (error) => {
    assert.ok(error instanceof StudentRecordsError);
    assert.equal(error.status, 403);
    assert.match(error.message, /Only database administrators can change a student number/);
    return true;
  });
  assert.equal(registrarEdit.log.rolledBack, true);
  assert.equal(registrarEdit.log.queries.some(({ statement }) => statement.includes('UPDATE dbo.students')), false);
  assert.equal(registrarEdit.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);

  const registrarCreate = transactionalService(({ statement, values }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('INSERT INTO dbo.students')) return { recordset: [{ id: 13 }] };
    if (statement.includes('INSERT INTO dbo.audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(registrarCreate.service.saveStudent(7, null, input), (error) => {
    assert.ok(error instanceof StudentRecordsError);
    assert.equal(error.status, 403);
    assert.match(error.message, /through student enrollment intake/);
    return true;
  });
  assert.equal(registrarCreate.log.rolledBack, true);
  assert.equal(registrarCreate.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.students')), false);

  const databaseAdminCreate = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM dbo.academic_terms WITH')) return { recordset: [{ school_year: '2026-2027' }] };
    if (statement.includes('sp_getapplock')) return { recordset: [{ lock_result: 0 }] };
    if (statement.includes('DECLARE @prefix')) return { recordset: [{ student_no: 'SHS-2026-0321' }] };
    if (statement.includes('INSERT INTO dbo.students')) return { recordset: [{ id: 13 }] };
    if (statement.includes('INSERT INTO dbo.audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  assert.equal(await databaseAdminCreate.service.saveStudent(7, null, { ...input, studentNo: 'FORGED-999' }), 13);
  const createInsert = databaseAdminCreate.log.queries.find(({ statement }) => statement.includes('INSERT INTO dbo.students'));
  assert.equal(createInsert.values.studentNo, 'SHS-2026-0321');
  assert.match(createInsert.statement, /OUTPUT INSERTED\.id INTO @insertedStudents/);
  assert.ok(databaseAdminCreate.log.queries.some(({ statement }) => statement.includes('sp_getapplock')));
  assert.equal(databaseAdminCreate.log.committed, true);

  const noCurrentTerm = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM dbo.academic_terms WITH')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(noCurrentTerm.service.saveStudent(7, null, input), /Set a current academic term/);
  assert.equal(noCurrentTerm.log.rolledBack, true);
  assert.equal(noCurrentTerm.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.students')), false);

  const invalidCurrentTerm = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM dbo.academic_terms WITH')) return { recordset: [{ school_year: '2026/2027' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(invalidCurrentTerm.service.saveStudent(7, null, input), /invalid school year/);
  assert.equal(invalidCurrentTerm.log.queries.some(({ statement }) => statement.includes('sp_getapplock')), false);

  const registrarBackfill = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM dbo.students WITH')) return { recordset: [{ id: 12, status: 'active', student_no: 'S-13', lrn: null }] };
    if (statement.includes('UPDATE dbo.students')) return { recordset: [] };
    if (statement.includes('INSERT INTO dbo.audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  assert.equal(await registrarBackfill.service.saveStudent(7, 12, input), 12);
  assert.equal(registrarBackfill.log.queries.find(({ statement }) => statement.includes('UPDATE dbo.students')).values.lrn, input.lrn);

  const registrarLrnChange = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM dbo.students WITH')) return { recordset: [{ id: 12, status: 'active', student_no: 'S-13', lrn: '123456789011' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(registrarLrnChange.service.saveStudent(7, 12, input), /Only database administrators can change a recorded LRN/);
  assert.equal(registrarLrnChange.log.queries.some(({ statement }) => statement.includes('UPDATE dbo.students')), false);

  const databaseAdminEdit = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM dbo.students WITH')) return { recordset: [{ id: 12, status: 'active', student_no: 'S-12', lrn: '123456789011' }] };
    if (statement.includes('UPDATE dbo.students')) return { recordset: [] };
    if (statement.includes('INSERT INTO dbo.audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  assert.equal(await databaseAdminEdit.service.saveStudent(7, 12, input), 12);
  const update = databaseAdminEdit.log.queries.find(({ statement }) => statement.includes('UPDATE dbo.students'));
  assert.equal(update.values.studentNo, 'S-13');
  assert.equal(update.values.lrn, input.lrn);
  assert.equal(databaseAdminEdit.log.queries.at(-1).values.action, 'database_admin.student_updated');
  assert.equal(databaseAdminEdit.log.committed, true);
});

test('master list search binds escaped input, applies term filter, and pages across every match', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('FROM dbo.academic_terms')) return { recordset: [{ id: 3, school_year: '2026-2027', term: 'First', is_current: true }] };
          if (statement.includes('FROM dbo.sections')) return { recordset: [] };
          if (statement.includes('COUNT_BIG(*) AS total_students')) return { recordset: [{ total_students: 57 }] };
          return { recordset: [] };
        }
      };
    }
  };
  const service = createStudentRecordsService({ getPool: async () => pool, sql: fakeSql() });
  const result = await service.listWorkspace('A_%[b]~', '3', '2');
  const studentsCall = calls.at(-1);
  const countCall = calls.find(({ statement }) => statement.includes('COUNT_BIG(*) AS total_students'));
  assert.equal(result.searchTerm, 'A_%[b]~');
  assert.equal(result.academicTermId, 3);
  assert.equal(result.totalStudents, 57);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 25);
  assert.equal(result.totalPages, 3);
  assert.equal(studentsCall.values.searchPattern, '%A~_~%~[b~]~~%');
  assert.equal(studentsCall.values.academicTermId, 3);
  assert.equal(studentsCall.values.offset, 25);
  assert.equal(studentsCall.values.pageSize, 25);
  assert.match(studentsCall.statement, /OUTER APPLY/);
  assert.match(countCall.statement, /s\.lrn LIKE @searchPattern/);
  assert.match(countCall.statement, /CONCAT_WS\(N' ', s\.first_name, NULLIF\(s\.middle_name, N''\), s\.last_name\)/);
  assert.match(studentsCall.statement, /s\.lrn LIKE @searchPattern/);
  assert.match(studentsCall.statement, /CONCAT_WS\(N' ', s\.first_name, NULLIF\(s\.middle_name, N''\), s\.last_name\)/);
  assert.match(studentsCall.statement, /AS good_moral_status/);
  assert.match(studentsCall.statement, /AS psa_status/);
  assert.match(studentsCall.statement, /AS form137_status/);
  assert.match(studentsCall.statement, /@academicTermId IS NULL OR EXISTS \([\s\S]*filtered_enrollment\.academic_term_id = @academicTermId/);
  assert.match(studentsCall.statement, /OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY/);
  assert.doesNotMatch(studentsCall.statement, /SELECT TOP \(250\)/);
  assert.doesNotMatch(studentsCall.statement, /A_%\[b\]/);
  const lastPage = await service.listWorkspace('', '', '999');
  assert.equal(lastPage.page, 3);
  assert.equal(calls.at(-1).values.offset, 50);
  await assert.rejects(service.listWorkspace('x'.repeat(101), ''), /100 printable characters or fewer/);
});

test('own student view queries only the student linked to the authenticated user id', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('FROM dbo.students WHERE user_id = @userId')) {
            return { recordset: [{ id: 21, student_no: 'S-21', first_name: 'Ari', last_name: 'Lee' }] };
          }
          return { recordset: [{ id: 91, school_year: '2026-2027', term: 'First' }] };
        }
      };
    }
  };
  const service = createStudentRecordsService({ getPool: async () => pool, sql: fakeSql() });
  const result = await service.getOwnStudentRecord(7);
  assert.equal(result.student.student_no, 'S-21');
  assert.equal(calls[0].values.userId, 7);
  assert.match(calls[0].statement, /WHERE user_id = @userId/);
  assert.equal(calls[1].values.studentId, 21);
  assert.match(calls[1].statement, /WHERE e\.student_id = @studentId/);
});

test('unified student record reads only the active student-origin report-card scan and the separate paper status', async () => {
  const statements = [];
  const pool = {
    request() {
      return {
        input() { return this; },
        async query(statement) {
          statements.push(statement);
          if (statement.includes('FROM dbo.students AS s LEFT JOIN dbo.users')) {
            return { recordset: [{ id: 44, previous_report_card_status: 'needs_review', previous_school_report_card_physical_status: 'received', form137_status: 'verified' }] };
          }
          return { recordset: [] };
        }
      };
    }
  };
  const service = createStudentRecordsService({ getPool: async () => pool, sql: fakeSql() });
  const result = await service.getStudent('44');
  assert.equal(result.student.previous_report_card_status, 'needs_review');
  assert.equal(result.student.previous_school_report_card_physical_status, 'received');
  assert.equal(result.student.form137_status, 'verified');
  const profileQuery = statements.find((statement) => statement.includes('FROM dbo.students AS s LEFT JOIN dbo.users'));
  assert.match(profileQuery, /d\.document_type = 'report_card'[\s\S]*d\.is_legacy_archive = 0 AND d\.upload_source = 'student'/);
  assert.match(profileQuery, /previous_school_report_card_status_events/);
  assert.match(profileQuery, /form137_status_events/);
});

test('a section from another academic term is rejected before enrollment writes', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM dbo.students')) return { recordset: [{ id: 12 }] };
    if (statement.includes('FROM dbo.enrollments AS enrollment')) return { recordset: [] };
    if (statement.includes('FROM dbo.academic_terms')) return { recordset: [{ id: 5 }] };
    if (statement.includes('FROM dbo.sections')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await assert.rejects(service.saveEnrollment(7, { studentId: '12', academicTermId: '5', sectionId: '9' }), /belongs to the selected academic term/);
  assert.equal(log.committed, false);
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.enrollments')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);
});

test('setting the current term clears the previous value and audits inside one transaction', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM dbo.academic_terms WITH (UPDLOCK')) return { recordset: [{ id: 4 }] };
    return { recordset: [] };
  });
  await service.setCurrentTerm(7, '4');
  assert.equal(log.committed, true);
  assert.equal(log.rolledBack, false);
  assert.equal(log.isolation, 'SERIALIZABLE');
  const clearIndex = log.queries.findIndex(({ statement }) => statement === 'UPDATE dbo.academic_terms SET is_current = 0 WHERE is_current = 1');
  const setIndex = log.queries.findIndex(({ statement }) => statement.includes('SET is_current = 1'));
  const auditIndex = log.queries.findIndex(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs'));
  assert.ok(clearIndex >= 0 && clearIndex < setIndex && setIndex < auditIndex);
  assert.equal(log.queries[auditIndex].values.entityType, 'academic_term');
});

test('enrollment update changes only the section and keeps the schema-managed enrollment status', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM dbo.students')) return { recordset: [{ id: 12 }] };
    if (statement.includes('FROM dbo.enrollments AS enrollment')) return { recordset: [] };
    if (statement.includes('FROM dbo.academic_terms')) return { recordset: [{ id: 5 }] };
    if (statement.includes('FROM dbo.sections')) return { recordset: [{ id: 9 }] };
    if (statement.includes('FROM dbo.enrollments')) return { recordset: [{ id: 44, enrollment_status: 'enrolled' }] };
    return { recordset: [] };
  });
  const enrollmentId = await service.saveEnrollment(7, { studentId: '12', academicTermId: '5', sectionId: '9' });
  const update = log.queries.find(({ statement }) => statement.includes('UPDATE dbo.enrollments'));
  assert.equal(enrollmentId, 44);
  assert.equal(update.values.sectionId, 9);
  assert.doesNotMatch(update.statement, /enrollment_status/);
  assert.equal(log.committed, true);
  assert.ok(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')));
});

test('legacy enrollment writes cannot bypass a pending new-student intake', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM dbo.students')) return { recordset: [{ id: 12, status: 'active' }] };
    if (statement.includes('FROM dbo.enrollments AS enrollment')) return { recordset: [{ id: 45 }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(service.saveEnrollment(7, { studentId: '12', academicTermId: '5', sectionId: '9' }), (error) => {
    assert.ok(error instanceof StudentRecordsError);
    assert.equal(error.status, 409);
    assert.match(error.message, /pending new-student intake/);
    return true;
  });
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.enrollments')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('UPDATE dbo.enrollments')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);
  assert.match(log.queries.find(({ statement }) => statement.includes('FROM dbo.enrollments AS enrollment')).statement,
    /enrollment_status = N'pending_payment'[\s\S]*created_for_intake = 1/);
});

test('database administrator archives a student, disables the linked account, consumes OTPs, and audits atomically', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM dbo.students WITH')) return { recordset: [{ id: 12, user_id: 44, student_no: 'S-12', status: 'active' }] };
    return { recordset: [] };
  });
  assert.equal(await service.archiveStudent(7, '12', 'S-12'), 12);
  const archive = log.queries.find(({ statement }) => statement.includes("SET status = N'archived'"));
  const deactivate = log.queries.find(({ statement }) => statement.includes('UPDATE dbo.users SET is_active = 0'));
  const invalidate = log.queries.find(({ statement }) => statement.includes('UPDATE dbo.two_factor_codes'));
  const audit = log.queries.find(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs'));
  assert.ok(archive && deactivate && invalidate && audit);
  assert.ok(log.queries.indexOf(archive) < log.queries.indexOf(deactivate));
  assert.equal(deactivate.values.userId, 44);
  assert.equal(audit.values.action, 'database_admin.student_archived');
  assert.deepEqual(JSON.parse(audit.values.detailsJson), { studentNo: 'S-12', loginDeactivated: true });
  assert.equal(log.isolation, 'SERIALIZABLE');
  assert.equal(log.committed, true);
});

test('student archival requires matching confirmation and an active database administrator', async () => {
  const mismatch = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM dbo.students WITH')) return { recordset: [{ id: 12, user_id: null, student_no: 'S-12', status: 'active' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(mismatch.service.archiveStudent(7, '12', 'S-13'), /Type this student’s number/);
  assert.equal(mismatch.log.rolledBack, true);
  assert.equal(mismatch.log.queries.some(({ statement }) => statement.includes('UPDATE dbo.students')), false);
  assert.equal(mismatch.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);

  const registrar = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(registrar.service.archiveStudent(7, '12', 'S-12'), /Only database administrators/);
  assert.equal(registrar.log.rolledBack, true);
  assert.equal(registrar.log.queries.some(({ statement }) => statement.includes('FROM dbo.students')), false);
});

test('registrar deactivates only an active linked student login and preserves the master record', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM dbo.users') && statement.includes('actorId')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM dbo.students WITH')) return { recordset: [{ id: 12, user_id: 44, status: 'active' }] };
    if (statement.includes('FROM dbo.users WITH') && statement.includes('userId')) return { recordset: [{ id: 44, is_active: true }] };
    return { recordset: [] };
  });
  assert.equal(await service.deactivateStudentLogin(7, '12', 'DEACTIVATE'), 12);
  const deactivate = log.queries.find(({ statement }) => statement.includes('UPDATE dbo.users SET is_active = 0'));
  const audit = log.queries.find(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs'));
  assert.ok(deactivate);
  assert.equal(deactivate.values.userId, 44);
  assert.equal(log.queries.some(({ statement }) => statement.includes('UPDATE dbo.students')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('UPDATE dbo.two_factor_codes')), true);
  assert.equal(audit.values.action, 'registrar.student_login_deactivated');
  assert.equal(log.committed, true);
});

test('finance cannot access the student master list and denied requests do not load academic data', async () => {
  let listReads = 0;
  const studentRecordsService = {
    async listWorkspace() { listReads += 1; return { students: [], terms: [], sections: [], searchTerm: '', academicTermId: null }; }
  };
  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, studentRecordsService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const response = await fetch(`${baseUrl}/registrar/records`, { headers: { cookie } });
    assert.equal(response.status, 403);
    assert.equal(listReads, 0);
  });
});

test('student overview and profile page resolve only the session-owned profile and reject staff workspace access', async () => {
  const ownUserIds = [];
  const ownGradeUserIds = [];
  const summaryUserIds = [];
  const studentRecordsService = {
    async getOwnStudentRecord(userId) {
      ownUserIds.push(userId);
      return { student: { student_no: 'S-7', first_name: 'Rae', last_name: 'Student' }, enrollments: [] };
    },
    async getStudentDashboardSummary(userId) { summaryUserIds.push(userId); return {}; },
    async listWorkspace() { throw new Error('student should not read the staff list'); }
  };
  const academicRecordsService = {
    async getOwnGrades(userId) { ownGradeUserIds.push(userId); return []; }
  };
  await withServer(createApp({
    databasePool: makeAuthPool('student'), environment, studentRecordsService, academicRecordsService,
    financeService: { async getOwnStudentAccount() { return { account: null, transactions: [] }; } },
    classScheduleService: { async getOwnStudentSchedule() { return []; } }
  }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const dashboard = await fetch(`${baseUrl}/student?studentId=999`, { headers: { cookie } });
    assert.equal(dashboard.status, 200);
    const html = await dashboard.text();
    assert.doesNotMatch(html, /student-shortcuts|Your school pages/);
    const profile = await fetch(`${baseUrl}/student/records?studentId=999`, { headers: { cookie } });
    assert.equal(profile.status, 200);
    assert.match(await profile.text(), /S-7/);
    assert.deepEqual(ownUserIds, [7, 7]);
    assert.deepEqual(summaryUserIds, [], 'student overview does not fetch an unused document summary');
    assert.deepEqual(ownGradeUserIds, [], 'the overview does not fetch detailed grades');
    const records = await fetch(`${baseUrl}/registrar/records`, { headers: { cookie } });
    assert.equal(records.status, 403);
  });
});

test('database administrators can search the master list and open a unified profile, enrollment, academic, and document-status record', async () => {
  let staffListReads = 0;
  const studentRecordsService = {
    async listWorkspace() {
      staffListReads += 1;
      return {
        students: [{ id: 12, student_no: 'S-12', lrn: '123456789012', first_name: 'Jamie', last_name: 'Lee', status: 'active', good_moral_status: 'needs_review', psa_status: null, form137_status: 'received' }],
        terms: [], sections: [], searchTerm: '', academicTermId: null, totalStudents: 1, page: 1, pageSize: 25, totalPages: 1
      };
    },
    async getStudent(id) {
      return { student: { id, student_no: 'S-12', lrn: '123456789012', first_name: 'Jamie', last_name: 'Lee', status: 'active', good_moral_status: 'needs_review', psa_status: null, previous_report_card_status: 'needs_review', previous_school_report_card_physical_status: 'received', form137_status: 'received' }, terms: [], sections: [], enrollments: [] };
    }
  };
  const academicRecordsService = {
    async getStudentAcademicRecord() {
        return { enrollments: [{ id: 5, school_year: '2026-2027', term: 'First', is_current: true, grade_level: 'Grade 11', section_name: 'Mabini', enrollment_status: 'enrolled', subjects: [{ subjectCode: 'ENG1', subjectName: 'English', grades: [{ gradingPeriod: 'Quarter 1', gradeValue: 94 }] }] }] };
    }
  };
  const dependencies = { studentRecordsService, academicRecordsService };
  await withServer(createApp({ databasePool: makeAuthPool('database_admin'), environment, ...dependencies }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin');
    const list = await fetch(`${baseUrl}/registrar/records?search=Jamie%20Lee`, { headers: { cookie } });
    const listHtml = await list.text();
    assert.equal(list.status, 200);
    assert.equal(staffListReads, 1);
    assert.match(listHtml, /LRN 123456789012/);
    assert.match(listHtml, /href="\/registrar\/records\/students\/12"/);
    assert.match(listHtml, /Good Moral <strong>Review needed/);
    assert.match(listHtml, /PSA <strong>Missing/);
    assert.match(listHtml, /Form 137 physical record \(staff only\) <strong>received/);
    const newProfile = await fetch(`${baseUrl}/registrar/records/students/new`, { headers: { cookie } });
    const newProfileHtml = await newProfile.text();
    assert.equal(newProfile.status, 200);
    assert.doesNotMatch(newProfileHtml, /name="studentNo"/);
    assert.match(newProfileHtml, /assigned automatically from the current academic year/);
    const detail = await fetch(`${baseUrl}/registrar/records/students/12`, { headers: { cookie } });
    const detailHtml = await detail.text();
    assert.equal(detail.status, 200);
    assert.match(detailHtml, /Enrollment, subjects, and grades/);
    assert.match(detailHtml, /Good Moral Certificate/);
    assert.match(detailHtml, /Needs staff review/);
    assert.match(detailHtml, /PSA birth certificate/);
    assert.match(detailHtml, /Grade 11 · Mabini/);
    assert.doesNotMatch(detailHtml, /Grade Grade 11/);
    assert.match(detailHtml, /Form 137 physical record \(staff only\)/);
    assert.match(detailHtml, /Previous-school report card · digital enrollment scan/);
    assert.match(detailHtml, /Previous-school report card · paper copy \(staff only\)/);
    assert.match(detailHtml, /href="\/documents\/students\/12#previous-school-report-card-status-title"/);
    assert.match(detailHtml, /href="\/documents\/students\/12#form137-status-title"/);
    assert.match(detailHtml, /Review digital submission/);
    assert.match(detailHtml, /Not submitted/);
    assert.match(detailHtml, /Quarter 1[\s\S]*?94/);
    assert.match(detailHtml, /href="\/documents\/students\/12"/);
  });

  let deniedReads = 0;
  await withServer(createApp({
    databasePool: makeAuthPool('finance'), environment,
    studentRecordsService: { async listWorkspace() { deniedReads += 1; return {}; } }
  }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const denied = await fetch(`${baseUrl}/registrar/records/students/12`, { headers: { cookie } });
    assert.equal(denied.status, 403);
    assert.equal(deniedReads, 0);
  });
});

test('records mutations reject missing CSRF tokens before calling the service', async () => {
  let createCalls = 0;
  let studentCreateCalls = 0;
  let enrollmentSaveCalls = 0;
  const listCalls = [];
  const studentRecordsService = {
    async createTerm() { createCalls += 1; },
    async saveStudent() { studentCreateCalls += 1; },
    async saveEnrollment() {
      enrollmentSaveCalls += 1;
      throw new StudentRecordsError('This student has a pending new-student intake. Finance must clear that enrollment before it can be finalized.', 409);
    },
    async listWorkspace(searchTerm = '', termId = '', page = 1) {
      listCalls.push({ searchTerm, termId, page });
      return {
      students: [{ id: 12, student_no: 'S-12', lrn: '123456789012', first_name: 'Jamie', last_name: 'Lee', status: 'active', enrollment_status: 'enrolled', school_year: '2026-2027', term: 'First', good_moral_status: 'needs_review', psa_status: null, form137_status: 'received' }],
      terms: [{ id: 2, school_year: '2026-2027', term: 'First', is_current: true }], sections: [], searchTerm, academicTermId: termId ? Number(termId) : null,
      totalStudents: 61, page: Number(page), pageSize: 25, totalPages: 3
    }; },
    async getStudent(id) {
      return {
        student: { id, student_no: 'S-12', first_name: 'Jamie', last_name: 'Lee' },
        terms: [{ id: 2, school_year: '2026-2027', term: 'First', is_current: true }],
        sections: [], enrollments: []
      };
    }
  };
  await withServer(createApp({ databasePool: makeAuthPool('registrar'), environment, studentRecordsService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const masterList = await fetch(`${baseUrl}/registrar/records`, { headers: { cookie } });
    assert.equal(masterList.status, 200);
    const masterListHtml = await masterList.text();
    assert.match(masterListHtml, /Student master list/);
    assert.match(masterListHtml, /LRN 123456789012/);
    assert.match(masterListHtml, /Good Moral <strong>Review needed/);
    assert.match(masterListHtml, /Form 137 physical record \(staff only\) <strong>received/);
    assert.match(masterListHtml, /records-context-strip--term/);
    assert.match(masterListHtml, /record-status--active">Active/);
    assert.match(masterListHtml, />Edit profile<\/a>/);
    assert.match(masterListHtml, /Open student record/);
    assert.match(masterListHtml, /Showing 1–25 of 61 students/);
    assert.match(masterListHtml, /href="\/registrar\/intake"/);
    assert.doesNotMatch(masterListHtml, /href="\/registrar\/records\/students\/new"/);
    const secondPage = await fetch(`${baseUrl}/registrar/records?search=Lee&termId=2&page=2`, { headers: { cookie } });
    assert.equal(secondPage.status, 200);
    const secondPageHtml = await secondPage.text();
    assert.match(secondPageHtml, /Showing 26–50 of 61 students/);
    assert.match(secondPageHtml, /href="\/registrar\/records\?search=Lee&amp;termId=2&amp;page=3"/);
    assert.deepEqual(listCalls.slice(0, 2), [
      { searchTerm: '', termId: '', page: 1 },
      { searchTerm: 'Lee', termId: '2', page: '2' }
    ]);
    const legacyNewStudent = await fetch(`${baseUrl}/registrar/records/students/new`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(legacyNewStudent.status, 303);
    assert.equal(legacyNewStudent.headers.get('location'), '/registrar/intake/new');
    const directCreate = await postForm(baseUrl, '/registrar/records/students', cookie, {
      _csrf: csrfFromHtml(masterListHtml), studentNo: 'ST-NEW', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee'
    });
    assert.equal(directCreate.status, 403);
    assert.match(await directCreate.text(), /through student enrollment intake/);
    assert.equal(studentCreateCalls, 0);
    const legacyEnrollment = await postForm(baseUrl, '/registrar/records/enrollments', cookie, {
      _csrf: csrfFromHtml(masterListHtml), studentId: '12', academicTermId: '2', sectionId: '9'
    });
    assert.equal(legacyEnrollment.status, 409);
    assert.match(await legacyEnrollment.text(), /pending new-student intake/);
    assert.equal(enrollmentSaveCalls, 1);
    const editStudentForm = await fetch(`${baseUrl}/registrar/records/students/12/edit`, { headers: { cookie } });
    assert.equal(editStudentForm.status, 200);
    const editStudentHtml = await editStudentForm.text();
    assert.match(editStudentHtml, /Enrollment history/);
    assert.match(editStudentHtml, /id="student-no"[^>]*readonly aria-describedby="student-number-help"/);
    assert.match(editStudentHtml, /Only a database administrator can correct a student number/);
    const response = await postForm(baseUrl, '/registrar/records/terms', cookie, { schoolYear: '2026-2027', term: 'First' });
    assert.equal(response.status, 403);
    assert.equal(createCalls, 0);
  });
});

test('student archive is database-admin-only and registrar login deactivation is separate and CSRF protected', async () => {
  const calls = [];
  const studentRecordsService = {
    async getStudent(id) {
      return {
        student: { id, user_id: 44, linked_account_is_active: true, student_no: 'S-12', first_name: 'Jamie', last_name: 'Lee', status: 'active' },
        terms: [], sections: [], enrollments: []
      };
    },
    async listWorkspace() { return { students: [], terms: [], sections: [], searchTerm: '', academicTermId: null }; },
    async archiveStudent(...args) { calls.push(['archive', ...args]); return 12; },
    async deactivateStudentLogin(...args) { calls.push(['deactivate', ...args]); return 12; }
  };

  await withServer(createApp({ databasePool: makeAuthPool('database_admin'), environment, studentRecordsService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin');
    const page = await fetch(`${baseUrl}/registrar/records/students/12/edit`, { headers: { cookie } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Type S-12 to confirm archiving/);
    assert.doesNotMatch(html, /id="student-no"[^>]*readonly/);
    assert.doesNotMatch(html, /login\/deactivate/);
    const response = await postForm(baseUrl, '/registrar/records/students/12/archive', cookie, {
      _csrf: csrfFromHtml(html), confirmation: 'S-12'
    });
    assert.equal(response.status, 303);
    assert.equal(calls[0][0], 'archive');
    assert.equal(calls[0][1], 7);
    const forbidden = await postForm(baseUrl, '/registrar/records/students/12/login/deactivate', cookie, {
      _csrf: csrfFromHtml(html), confirmation: 'DEACTIVATE'
    });
    assert.equal(forbidden.status, 403);
  });

  await withServer(createApp({ databasePool: makeAuthPool('registrar'), environment, studentRecordsService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/registrar/records/students/12/edit`, { headers: { cookie } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Type DEACTIVATE to disable this student login/);
    assert.doesNotMatch(html, /action="\/registrar\/records\/students\/12\/archive"/);
    const response = await postForm(baseUrl, '/registrar/records/students/12/login/deactivate', cookie, {
      _csrf: csrfFromHtml(html), confirmation: 'DEACTIVATE'
    });
    assert.equal(response.status, 303);
    assert.equal(calls.at(-1)[0], 'deactivate');
    assert.equal(calls.at(-1)[1], 7);
    const forbidden = await postForm(baseUrl, '/registrar/records/students/12/archive', cookie, {
      _csrf: csrfFromHtml(html), confirmation: 'S-12'
    });
    assert.equal(forbidden.status, 403);
  });
  assert.equal(calls.filter(([action]) => action === 'archive').length, 1);
  assert.equal(calls.filter(([action]) => action === 'deactivate').length, 1);
});

test('archived student profiles explain that retained academic and finance history is review-only', async () => {
  const studentRecordsService = {
    async getStudent(id) {
      return {
        student: { id, user_id: null, student_no: 'S-12', first_name: 'Jamie', last_name: 'Lee', status: 'archived' },
        terms: [], sections: [], enrollments: []
      };
    },
    async listWorkspace() { return { students: [], terms: [], sections: [], searchTerm: '', academicTermId: null }; }
  };
  await withServer(createApp({ databasePool: makeAuthPool('registrar'), environment, studentRecordsService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/registrar/records/students/12/edit`, { headers: { cookie } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Existing academic and finance history remains available for review, but cannot be changed/);
    assert.match(html, /<fieldset disabled>/);
    assert.doesNotMatch(html, /authorized staff can continue maintaining/);
    assert.doesNotMatch(html, /action="\/registrar\/records\/enrollments"/);
  });
});
