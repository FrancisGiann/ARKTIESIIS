const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');
const { StudentDocumentRequestError } = require('../src/services/studentDocumentRequestService');
const {
  StudentRecordsError,
  createStudentRecordsService,
  validateStudent,
  currentManilaDate,
  latestBirthDate,
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
  const workbookProfile = validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee',
    birthplace: 'Lucena City', facebookName: 'Jamie Lee', emergencyContactPerson: 'Alex Lee', emergencyContactRelationship: 'Parent',
    emergencyContactPhone: '+63 900 000 0000', emergencyContactAddress: 'Lucena', motherName: 'Morgan Lee', motherPhone: '09000000001',
    fatherName: 'Taylor Lee', fatherPhone: '09000000002' });
  assert.equal(workbookProfile.birthplace, 'Lucena City');
  assert.equal(workbookProfile.emergencyContactPerson, 'Alex Lee');
  assert.equal(workbookProfile.fatherPhone, '09000000002');
  assert.throws(() => validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee', facebookName: 'x'.repeat(121) }), /optional profile field/);
  assert.throws(() => validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee', emergencyContactPhone: '555\n1000' }), /Emergency contact phone must be 50 printable characters/);
  assert.equal(validateStudent({ lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee' }, { requireStudentNo: false }).studentNo, null);
  assert.throws(() => normalizeLrn('12345678901'), /exactly 12 digits/);
  assert.throws(() => normalizeLrn('12345678901 '), /exactly 12 digits/);
  assert.equal(validateStudent({ studentNo: 'S-OLD', firstName: 'Jamie', lastName: 'Lee' }, { requireLrn: false }).lrn, null);
  assert.throws(() => validateStudent({ studentNo: 'S-NEW', firstName: 'Jamie', lastName: 'Lee' }), /LRN must contain exactly 12 digits/);
  assert.throws(() => validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee', birthDate: '2007-02-29' }), /valid birth date/);
  assert.throws(() => validateStudent({ studentNo: 'S-1', firstName: 'Jamie\nLee', lastName: 'Lee' }), /First name is required/);
  const validNamesAndContacts = validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'José M.',
    middleName: 'Anne-Marie', lastName: 'O’Neill de la Cruz', suffix: 'Jr.', sex: 'mAlE',
    birthDate: '2008-02-29', phone: '+63 (917) 123-4567', address: '123 Main Street\nLucena City' });
  assert.equal(validNamesAndContacts.firstName, 'José M.');
  assert.equal(validNamesAndContacts.middleName, 'Anne-Marie');
  assert.equal(validNamesAndContacts.lastName, 'O’Neill de la Cruz');
  assert.equal(validNamesAndContacts.suffix, 'Jr.');
  assert.equal(validNamesAndContacts.sex, 'Male');
  assert.equal(validNamesAndContacts.phone, '+63 (917) 123-4567');
  assert.equal(validNamesAndContacts.address, '123 Main Street\nLucena City');
  assert.equal(validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'Alex', lastName: 'Lee',
    phone: '(02) 8123-4567', address: '12B, St. John Street' }).phone, '(02) 8123-4567');
  for (const [field, value, message] of [
    ['firstName', '12345', /First name must contain letters/], ['middleName', '8', /Middle name must contain letters/],
    ['lastName', '3578', /Last name must contain letters/], ['suffix', '!!!', /Suffix must contain letters/],
    ['sex', 'fish', /Choose Male, Female, or Other/], ['phone', 'call 09170000000', /Phone must use digits/],
    ['phone', '12345', /Phone must contain 7 to 15 digits/], ['phone', '+63 (917 123-4567', /balanced parentheses/],
    ['address', '123456789', /Address must include at least one letter/], ['birthDate', currentManilaDate(), /before today/]
  ]) {
    assert.throws(() => validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'Alex', lastName: 'Lee', [field]: value }), message);
  }
  assert.equal(validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'Alex', lastName: 'Lee', sex: '' }).sex, null);
  assert.equal(validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'Alex', lastName: 'Lee', sex: 'unspecified' },
    { allowLegacyUnspecifiedSex: true }).sex, 'unspecified');
  assert.throws(() => validateStudent({ studentNo: 'S-1', lrn: '123456789012', firstName: 'Alex', lastName: 'Lee', sex: 'unspecified' }), /Choose Male, Female, or Other/);
  assert.equal(latestBirthDate() < currentManilaDate(), true);
  assert.throws(() => validateTerm({ schoolYear: '2026', term: 'A'.repeat(31) }), StudentRecordsError);
  assert.throws(() => validateSection({ name: 'Grade 7', academicTermId: '3x' }), /valid academic term/);
  assert.throws(() => validateEnrollment({ studentId: '0', academicTermId: '4' }), /valid student/);
  assert.deepEqual(validateEnrollment({ studentId: '5', academicTermId: '4', sectionId: '' }), { studentId: 5, academicTermId: 4, sectionId: null });
});

test('LRN is required for new students, registrars can backfill blanks, and only administrators create profiles or change recorded LRNs', async () => {
  const input = { studentNo: 'S-13', lrn: '123456789012', firstName: 'Jamie', lastName: 'Lee' };
  const registrarEdit = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM students WHERE id = @studentId')) return { recordset: [{ id: 12, status: 'active', student_no: 'S-12', lrn: input.lrn }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(registrarEdit.service.saveStudent(7, 12, input), (error) => {
    assert.ok(error instanceof StudentRecordsError);
    assert.equal(error.status, 403);
    assert.match(error.message, /Only database administrators can change a student number/);
    return true;
  });
  assert.equal(registrarEdit.log.rolledBack, true);
  assert.equal(registrarEdit.log.queries.some(({ statement }) => statement.includes('UPDATE students')), false);
  assert.equal(registrarEdit.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);

  const registrarCreate = transactionalService(({ statement, values }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('INSERT INTO students')) return { recordset: [{ id: 13 }] };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(registrarCreate.service.saveStudent(7, null, input), (error) => {
    assert.ok(error instanceof StudentRecordsError);
    assert.equal(error.status, 403);
    assert.match(error.message, /through student enrollment intake/);
    return true;
  });
  assert.equal(registrarCreate.log.rolledBack, true);
  assert.equal(registrarCreate.log.queries.some(({ statement }) => statement.includes('INSERT INTO students')), false);

  const databaseAdminCreate = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM academic_terms') && statement.includes('is_current = 1')) return { recordset: [{ school_year: '2026-2027' }] };
    if (statement.includes('application_locks')) return { recordset: [] };
    if (statement.includes('FROM students') && statement.includes('student_no LIKE')) return { recordset: [{ sequence: '0320' }] };
    if (statement.includes('INSERT INTO students')) return { insertId: 13 };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  assert.equal(await databaseAdminCreate.service.saveStudent(7, null, { ...input, studentNo: 'FORGED-999' }), 13);
  const createInsert = databaseAdminCreate.log.queries.find(({ statement }) => statement.includes('INSERT INTO students'));
  assert.equal(createInsert.values.studentNo, 'SHS-2026-0321');
  assert.doesNotMatch(createInsert.statement, /OUTPUT INSERTED/i);
  assert.ok(databaseAdminCreate.log.queries.some(({ statement }) => statement.includes('application_locks')));
  assert.equal(databaseAdminCreate.log.committed, true);

  const noCurrentTerm = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM academic_terms') && statement.includes('is_current = 1')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(noCurrentTerm.service.saveStudent(7, null, input), /Set a current academic term/);
  assert.equal(noCurrentTerm.log.rolledBack, true);
  assert.equal(noCurrentTerm.log.queries.some(({ statement }) => statement.includes('INSERT INTO students')), false);

  const invalidCurrentTerm = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM academic_terms') && statement.includes('is_current = 1')) return { recordset: [{ school_year: '2026/2027' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(invalidCurrentTerm.service.saveStudent(7, null, input), /invalid school year/);
  assert.equal(invalidCurrentTerm.log.queries.some(({ statement }) => statement.includes('application_locks')), false);

  const registrarBackfill = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM students WHERE id = @studentId')) return { recordset: [{ id: 12, status: 'active', student_no: 'S-13', lrn: null, first_name: 'Jamie', middle_name: null, last_name: 'Lee', suffix: null, birth_date: null, sex: null, address: null, phone: null }] };
    if (statement.includes('UPDATE students')) return { recordset: [] };
    if (statement.includes('INSERT INTO student_profile_revisions')) return { recordset: [] };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  assert.equal(await registrarBackfill.service.saveStudent(7, 12, input), 12);
  assert.equal(registrarBackfill.log.queries.find(({ statement }) => statement.includes('UPDATE students')).values.lrn, input.lrn);
  assert.deepEqual(registrarBackfill.log.queries.filter(({ statement }) => statement.includes('INSERT INTO student_profile_revisions')).map(({ values }) => values.fieldName), ['lrn']);

  const registrarLrnChange = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM students WHERE id = @studentId')) return { recordset: [{ id: 12, status: 'active', student_no: 'S-13', lrn: '123456789011' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(registrarLrnChange.service.saveStudent(7, 12, input), /Only database administrators can change a recorded LRN/);
  assert.equal(registrarLrnChange.log.queries.some(({ statement }) => statement.includes('UPDATE students')), false);

  const databaseAdminEdit = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM students WHERE id = @studentId')) return { recordset: [{ id: 12, status: 'active', student_no: 'S-12', lrn: '123456789011', first_name: 'Jamie', middle_name: null, last_name: 'Lee', suffix: null, birth_date: null, sex: null, address: null, phone: null, birthplace: null, facebook_name: null, emergency_contact_person: null, emergency_contact_relationship: null, emergency_contact_phone: null, emergency_contact_address: null, mother_name: null, mother_phone: null, father_name: null, father_phone: null }] };
    if (statement.includes('UPDATE students')) return { recordset: [] };
    if (statement.includes('INSERT INTO student_profile_revisions')) return { recordset: [] };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  assert.equal(await databaseAdminEdit.service.saveStudent(7, 12, { ...input, birthplace: 'Lucena City', emergencyContactPerson: 'Alex Lee' }), 12);
  const update = databaseAdminEdit.log.queries.find(({ statement }) => statement.includes('UPDATE students'));
  assert.equal(update.values.studentNo, 'S-13');
  assert.equal(update.values.lrn, input.lrn);
  assert.equal(update.values.birthplace, 'Lucena City');
  assert.deepEqual(databaseAdminEdit.log.queries.filter(({ statement }) => statement.includes('INSERT INTO student_profile_revisions')).map(({ values }) => values.fieldName), ['student_no', 'lrn', 'birthplace', 'emergency_contact_person']);
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
          if (statement.includes('FROM academic_terms')) return { recordset: [{ id: 3, school_year: '2026-2027', term: 'First', is_current: true }] };
          if (statement.includes('FROM sections')) return { recordset: [] };
          if (statement.includes('COUNT(*) AS total_students')) return { recordset: [{ total_students: 57 }] };
          return { recordset: [] };
        }
      };
    }
  };
  const service = createStudentRecordsService({ getPool: async () => pool, sql: fakeSql() });
  const result = await service.listWorkspace('A_%[b]~', '3', '2');
  const studentsCall = calls.at(-1);
  const countCall = calls.find(({ statement }) => statement.includes('COUNT(*) AS total_students'));
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
  assert.match(studentsCall.statement, /ROW_NUMBER\(\) OVER/);
  assert.match(countCall.statement, /s\.lrn LIKE @searchPattern/);
  assert.match(countCall.statement, /CONCAT_WS\(' ', s\.first_name, NULLIF\(s\.middle_name, ''\), s\.last_name\)/);
  assert.match(studentsCall.statement, /s\.lrn LIKE @searchPattern/);
  assert.match(studentsCall.statement, /CONCAT_WS\(' ', s\.first_name, NULLIF\(s\.middle_name, ''\), s\.last_name\)/);
  assert.match(studentsCall.statement, /AS good_moral_status/);
  assert.match(studentsCall.statement, /AS psa_status/);
  assert.match(studentsCall.statement, /AS form137_status/);
  assert.match(studentsCall.statement, /@academicTermId IS NULL OR EXISTS \([\s\S]*filtered_enrollment\.academic_term_id = @academicTermId/);
  assert.match(studentsCall.statement, /LIMIT @pageSize OFFSET @offset/);
  assert.doesNotMatch(studentsCall.statement, /OUTER APPLY|SELECT TOP|OFFSET\s+@offset ROWS FETCH/i);
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
          if (statement.includes('FROM students WHERE user_id = @userId')) {
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
          if (statement.includes('FROM students AS s LEFT JOIN users')) {
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
  const profileQuery = statements.find((statement) => statement.includes('FROM students AS s LEFT JOIN users'));
  assert.match(profileQuery, /d\.document_type = 'report_card'[\s\S]*d\.is_legacy_archive = 0 AND d\.upload_source = 'student'/);
  assert.match(profileQuery, /previous_school_report_card_status_events/);
  assert.match(profileQuery, /form137_status_events/);
});

test('a section from another academic term is rejected before enrollment writes', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM students')) return { recordset: [{ id: 12 }] };
    if (statement.includes('FROM annual_enrollments')) return { recordset: [] };
    if (statement.includes('FROM enrollments AS enrollment')) return { recordset: [] };
    if (statement.includes('FROM academic_terms')) return { recordset: [{ id: 5 }] };
    if (statement.includes('FROM sections')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await assert.rejects(service.saveEnrollment(7, { studentId: '12', academicTermId: '5', sectionId: '9' }), /belongs to the selected academic term/);
  assert.equal(log.committed, false);
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO enrollments')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
});

test('setting the current term clears the previous value and audits inside one transaction', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM academic_terms WHERE id = @termId')) return { recordset: [{ id: 4 }] };
    return { recordset: [] };
  });
  await service.setCurrentTerm(7, '4');
  assert.equal(log.committed, true);
  assert.equal(log.rolledBack, false);
  assert.equal(log.isolation, 'SERIALIZABLE');
  const clearIndex = log.queries.findIndex(({ statement }) => statement === 'UPDATE academic_terms SET is_current = 0 WHERE is_current = 1');
  const setIndex = log.queries.findIndex(({ statement }) => statement.includes('SET is_current = 1'));
  const auditIndex = log.queries.findIndex(({ statement }) => statement.includes('INSERT INTO audit_logs'));
  assert.ok(clearIndex >= 0 && clearIndex < setIndex && setIndex < auditIndex);
  assert.equal(log.queries[auditIndex].values.entityType, 'academic_term');
});

test('enrollment update changes only the section and keeps the schema-managed enrollment status', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM students')) return { recordset: [{ id: 12 }] };
    if (statement.includes('FROM enrollments AS enrollment')) return { recordset: [] };
    if (statement.includes('FROM academic_terms')) return { recordset: [{ id: 5 }] };
    if (statement.includes('FROM sections')) return { recordset: [{ id: 9 }] };
    if (statement.includes('FROM enrollments')) return { recordset: [{ id: 44, enrollment_status: 'enrolled' }] };
    return { recordset: [] };
  });
  const enrollmentId = await service.saveEnrollment(7, { studentId: '12', academicTermId: '5', sectionId: '9' });
  const update = log.queries.find(({ statement }) => statement.includes('UPDATE enrollments'));
  assert.equal(enrollmentId, 44);
  assert.equal(update.values.sectionId, 9);
  assert.doesNotMatch(update.statement, /enrollment_status/);
  assert.equal(log.committed, true);
  assert.ok(log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')));
});

test('legacy enrollment writes cannot bypass a pending new-student intake', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM students')) return { recordset: [{ id: 12, status: 'active' }] };
    if (statement.includes('FROM enrollments AS enrollment')) return { recordset: [{ id: 45 }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(service.saveEnrollment(7, { studentId: '12', academicTermId: '5', sectionId: '9' }), (error) => {
    assert.ok(error instanceof StudentRecordsError);
    assert.equal(error.status, 409);
    assert.match(error.message, /pending new-student intake/);
    return true;
  });
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO enrollments')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('UPDATE enrollments')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
  assert.match(log.queries.find(({ statement }) => statement.includes('FROM enrollments AS enrollment')).statement,
    /enrollment_status = 'pending_payment'[\s\S]*created_for_intake = 1/);
});

test('database administrator archives a student, disables the linked account, consumes OTPs, and audits atomically', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM students WHERE id = @studentId')) return { recordset: [{ id: 12, user_id: 44, student_no: 'S-12', status: 'active' }] };
    return { recordset: [] };
  });
  assert.equal(await service.archiveStudent(7, '12', 'S-12'), 12);
  const archive = log.queries.find(({ statement }) => statement.includes("SET status = 'archived'"));
  const deactivate = log.queries.find(({ statement }) => statement.includes('UPDATE users SET is_active = 0'));
  const invalidate = log.queries.find(({ statement }) => statement.includes('UPDATE two_factor_codes'));
  const audit = log.queries.find(({ statement }) => statement.includes('INSERT INTO audit_logs'));
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
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM students WHERE id = @studentId')) return { recordset: [{ id: 12, user_id: null, student_no: 'S-12', status: 'active' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(mismatch.service.archiveStudent(7, '12', 'S-13'), /Type this student’s number/);
  assert.equal(mismatch.log.rolledBack, true);
  assert.equal(mismatch.log.queries.some(({ statement }) => statement.includes('UPDATE students')), false);
  assert.equal(mismatch.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);

  const registrar = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(registrar.service.archiveStudent(7, '12', 'S-12'), /Only database administrators/);
  assert.equal(registrar.log.rolledBack, true);
  assert.equal(registrar.log.queries.some(({ statement }) => statement.includes('FROM students')), false);
});

test('registrar deactivates only an active linked student login and preserves the master record', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM users') && statement.includes('actorId')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM students WHERE id = @studentId')) return { recordset: [{ id: 12, user_id: 44, status: 'active' }] };
    if (statement.includes('FROM users WHERE id = @userId')) return { recordset: [{ id: 44, is_active: true }] };
    return { recordset: [] };
  });
  assert.equal(await service.deactivateStudentLogin(7, '12', 'DEACTIVATE'), 12);
  const deactivate = log.queries.find(({ statement }) => statement.includes('UPDATE users SET is_active = 0'));
  const audit = log.queries.find(({ statement }) => statement.includes('INSERT INTO audit_logs'));
  assert.ok(deactivate);
  assert.equal(deactivate.values.userId, 44);
  assert.equal(log.queries.some(({ statement }) => statement.includes('UPDATE students')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('UPDATE two_factor_codes')), true);
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

test('student records workspace keeps create forms collapsed, opens failed forms with values, and groups sections by term', async () => {
  const currentTerm = { id: 2, school_year: '2026-2027', term: 'First term', is_current: true };
  const previousTerm = { id: 1, school_year: '2025-2026', term: 'Third term', is_current: false };
  let currentTermHasSection = true;
  const studentRecordsService = {
    async listWorkspace() {
      return {
        students: [], terms: [currentTerm, previousTerm],
        sections: [
          ...(currentTermHasSection ? [{ id: 31, academic_term_id: 2, school_year: currentTerm.school_year, term: currentTerm.term, name: 'STEM A', grade_level: 'Grade 11' }] : []),
          { id: 30, academic_term_id: 1, school_year: previousTerm.school_year, term: previousTerm.term, name: 'ABM B', grade_level: 'Grade 12' }
        ],
        searchTerm: '', academicTermId: null, totalStudents: 0, page: 1, pageSize: 25, totalPages: 1
      };
    },
    async createTerm(_userId, input) {
      if (input.schoolYear === 'bad-year') throw new StudentRecordsError('The academic term is invalid.', 400);
      return { id: 3 };
    },
    async createSection() { throw new StudentRecordsError('The section is invalid.', 400); }
  };
  await withServer(createApp({ databasePool: makeAuthPool('registrar'), environment, studentRecordsService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const response = await fetch(`${baseUrl}/registrar/records?view=setup`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<h1>Academic setup<\/h1>/);
    assert.match(html, /href="\/registrar\/records\?view=setup" aria-current="page">Academic setup<\/a>/);
    assert.match(html, /<details class="records-create-disclosure"\s*>\s*<summary>Add academic term/);
    assert.match(html, /<details class="records-create-disclosure"\s*>\s*<summary>Add section/);
    assert.match(html, /<details class="records-section-group" open>\s*<summary><strong>2026-2027 · First term/);
    assert.match(html, /<details class="records-section-group"\s*>\s*<summary><strong>2025-2026 · Third term/);

    currentTermHasSection = false;
    const emptyCurrentResponse = await fetch(`${baseUrl}/registrar/records?view=setup`, { headers: { cookie } });
    const emptyCurrentHtml = await emptyCurrentResponse.text();
    assert.equal(emptyCurrentResponse.status, 200);
    assert.match(emptyCurrentHtml, /No sections are set up for the current term/);
    assert.match(emptyCurrentHtml, /href="\/registrar\/records\?view=setup&amp;openForm=section&amp;termId=2#section-name">Add a section for this term/);
    assert.match(emptyCurrentHtml, /<details class="records-create-disclosure" open>\s*<summary>Add section/);
    assert.match(emptyCurrentHtml, /option value="2" selected>2026-2027 · First term/);
    currentTermHasSection = true;

    const token = csrfFromHtml(html);
    const termError = await postForm(baseUrl, '/registrar/records/terms', cookie, {
      _csrf: token, schoolYear: 'bad-year', term: 'Fall', isCurrent: '1'
    });
    assert.equal(termError.status, 400);
    const termErrorHtml = await termError.text();
    assert.match(termErrorHtml, /href="\/registrar\/records\?view=setup" aria-current="page">Academic setup<\/a>/);
    assert.match(termErrorHtml, /<details class="records-create-disclosure" open>\s*<summary>Add academic term/);
    assert.match(termErrorHtml, /name="schoolYear"[^>]*value="bad-year"/);
    assert.match(termErrorHtml, /name="isCurrent" value="1" type="checkbox" checked/);

    const sectionError = await postForm(baseUrl, '/registrar/records/sections', cookie, {
      _csrf: token, name: 'STEM C', academicTermId: '2', gradeLevel: 'Grade 11', modality: 'hybrid'
    });
    assert.equal(sectionError.status, 400);
    const sectionErrorHtml = await sectionError.text();
    assert.match(sectionErrorHtml, /<details class="records-create-disclosure" open>\s*<summary>Add section/);
    assert.match(sectionErrorHtml, /name="name"[^>]*value="STEM C"/);
    assert.match(sectionErrorHtml, /option value="2" selected/);
    assert.match(sectionErrorHtml, /option value="hybrid" selected/);

    const termCreated = await postForm(baseUrl, '/registrar/records/terms', cookie, {
      _csrf: token, schoolYear: '2027-2028', term: 'First'
    });
    assert.equal(termCreated.status, 303);
    assert.equal(termCreated.headers.get('location'), '/registrar/records?view=setup&notice=termCreated');
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
        return {
          student: { id: 12, student_no: 'S-12', first_name: 'Jamie', last_name: 'Lee', status: 'active' },
          subjects: [],
          enrollments: [{ id: 5, school_year: '2026-2027', term: 'First', is_current: true, grade_level: 'Grade 11', section_name: 'Mabini', enrollment_status: 'enrolled', subjects: [{ subjectCode: 'ENG1', subjectName: 'English', grades: [{ gradingPeriod: 'Quarter 1', gradeValue: 94 }] }] }]
        };
    }
  };
  const dependencies = {
    studentRecordsService,
    academicRecordsService,
    documentRequestService: { async getStudentRequests() { return []; } },
    documentClearanceService: { async getRegistrarData() { return { financeSummary: { status: 'Needs finance review', outstanding: null }, requests: [] }; } }
  };
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
    assert.match(detailHtml, /Student record overview/);
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
    assert.match(detailHtml, /href="\/documents\/students\/12"/);
    const academics = await fetch(`${baseUrl}/registrar/records/students/12/academic`, { headers: { cookie } });
    const academicsHtml = await academics.text();
    assert.equal(academics.status, 200);
    assert.match(academicsHtml, /Enrollment history/);
    assert.match(academicsHtml, /Quarter 1[\s\S]*?Grade: 94/);
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
    assert.match(masterListHtml, /Find a student record/);
    assert.match(masterListHtml, /LRN 123456789012/);
    assert.match(masterListHtml, /Good Moral <strong>Review needed/);
    assert.match(masterListHtml, /Form 137 physical record \(staff only\) <strong>received/);
    assert.match(masterListHtml, /records-context-strip--term/);
    assert.match(masterListHtml, /record-status--active">Active/);
    assert.match(masterListHtml, />Edit profile<\/a>/);
    assert.match(masterListHtml, /Open record/);
    assert.match(masterListHtml, /<details class="records-student-details">/);
    assert.doesNotMatch(masterListHtml, /<details class="records-student-details" open>/);
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

test('registrar follow-up ledgers are linked from student records and protected by staff role and CSRF', async () => {
  const documentCalls = [];
  const overviewCalls = [];
  let failCreateRequest = false;
  const student = { id: 12, student_no: 'S-12', first_name: 'Jamie', last_name: 'Lee', status: 'active' };
  const recordsService = {
    async getStudent() { return { student, terms: [], sections: [], enrollments: [] }; },
    async listStudentProfileRevisions() { return []; },
    async listWorkspace() { return { students: [], terms: [], sections: [], totalStudents: 0, page: 1, pageSize: 25, totalPages: 1 }; }
  };
  const documentRequestService = {
    async getStudentRequests() { return [
      { id: '81111111-1111-4111-8111-111111111111', document_type: 'Transcript', document_name: 'Grade 11 Transcript', requested_on: new Date('2026-09-30T00:00:00Z'), status: 'requested', history: [{ event_type: 'corrected', status_to: 'requested', document_name_before: 'Transcript', document_name_after: 'Grade 11 Transcript', document_type_before: 'Transcript', document_type_after: 'Transcript', requested_on_before: new Date('2026-09-29T00:00:00Z'), requested_on_after: new Date('2026-09-30T00:00:00Z'), reference_before: null, reference_after: 'REF-1', actor_first_name: 'Rae', actor_last_name: 'G.' }] },
      { id: '82222222-2222-4222-8222-222222222222', document_type: 'Certificate', document_name: 'Enrollment Certificate', requested_on: new Date('2026-09-01T00:00:00Z'), released_on: new Date('2026-09-10T00:00:00Z'), recipient: 'Original Recipient', status: 'released', history: [{ event_type: 'corrected', status_from: 'released', status_to: 'released', document_name_before: 'Enrollment Certificate', document_name_after: 'Enrollment Certificate', document_type_before: 'Certificate', document_type_after: 'Certificate', requested_on_before: new Date('2026-09-01T00:00:00Z'), requested_on_after: new Date('2026-09-01T00:00:00Z'), reference_before: null, reference_after: null, released_on_before: new Date('2026-09-09T00:00:00Z'), released_on_after: new Date('2026-09-10T00:00:00Z'), recipient_before: 'Mistyped Recipient', recipient_after: 'Original Recipient', actor_first_name: 'Rae', actor_last_name: 'G.' }] }
    ]; },
    async createRequest(...args) {
      documentCalls.push(['create', ...args]);
      if (failCreateRequest) throw new StudentDocumentRequestError('Document type is required.', 400);
    },
    async transitionRequest(...args) { documentCalls.push(['transition', ...args]); },
    async correctRequest(...args) { documentCalls.push(['correct', ...args]); }
  };
  const gradeOverviewService = {
    async listContexts() { return { terms: [{ id: 4, school_year: '2026-2027', term: 'Term 1', is_current: true }], sections: [], subjects: [] }; },
    async getOverview(...args) {
      overviewCalls.push(args);
      return { context: { school_year: '2026-2027', term: 'Term 1', grade_level: 'Grade 11', section_name: 'A', subject_code: 'ENG', subject_name: 'English', is_current: true },
        periods: ['Term 1'], selectedPeriod: '', entries: [], totals: { distinctLearners: 0, periodEntries: 0, published: 0, pendingReview: 0 } };
    }
  };
  const app = createApp({
    databasePool: makeAuthPool('registrar'), environment,
    studentRecordsService: recordsService,
    academicRecordsService: { async getStudentAcademicRecord() { return { student, enrollments: [] }; } },
    documentRequestService,
    documentClearanceService: {
      async getRegistrarData() {
        return {
          financeSummary: { status: 'Needs finance review', outstanding: null },
          requests: [
            { requestId: '81111111-1111-4111-8111-111111111111', status: 'pending', history: [], claimSlipHistory: [], claimSlipCurrent: false },
            { requestId: '82222222-2222-4222-8222-222222222222', status: 'historical_no_clearance', history: [], claimSlipHistory: [], claimSlipCurrent: false }
          ]
        };
      }
    },
    gradeOverviewService
  });
  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const profilePage = await fetch(`${baseUrl}/registrar/records/students/12`, { headers: { cookie } });
    assert.equal(profilePage.status, 200);
    const studentOverviewHtml = await profilePage.text();
    assert.match(studentOverviewHtml, /<h2 class="student-record-view-title">Overview<\/h2>/);
    assert.doesNotMatch(studentOverviewHtml, /Document requests and release history|Student profile revision history|Record document request/);
    const requestsPage = await fetch(`${baseUrl}/registrar/records/students/12?view=requests`, { headers: { cookie } });
    assert.equal(requestsPage.status, 200);
    const html = await requestsPage.text();
    const studentNavigation = html.match(/<nav class="student-record-navigation"[\s\S]*?<\/nav>/)?.[0];
    assert.match(studentNavigation || '', /href="\/documents\/students\/12" aria-current="page">Documents<\/a>/);
    assert.equal((studentNavigation?.match(/aria-current="page"/g) || []).length, 1);
    assert.match(html, /Document requests and release history/);
    assert.doesNotMatch(html, /Student profile revision history/);
    assert.match(studentNavigation, /href="\/registrar\/records\/students\/12\/academic"\s*>Academics<\/a>/);
    assert.match(html, /<option value="processing" >Processing<\/option><option value="cancelled" >Cancelled<\/option>/);
    assert.doesNotMatch(html, /<option value="released"/);
    assert.match(html, /data-status-only="released" hidden/);
    assert.match(html, /name="releasedOn" type="date"[^>]*data-required-status="released" disabled/);
    assert.match(html, /name="recipient" maxlength="150"[^>]*data-required-status="released" disabled/);
    assert.match(html, /Document name: Transcript → Grade 11 Transcript/);
    assert.match(html, /Request date: 2026-09-29 → 2026-09-30/);
    assert.match(html, /Reference: None → REF-1/);
    assert.match(html, /Release date: 2026-09-09 → 2026-09-10/);
    assert.match(html, /Recipient: Mistyped Recipient → Original Recipient/);
    assert.match(html, /name="releasedOn" type="date" value="2026-09-10" required/);
    const csrfToken = csrfFromHtml(html);
    const key = html.match(/name="idempotencyKey" value="([\da-f-]{36})"/)?.[1];
    assert.ok(key);
    const denied = await postForm(baseUrl, '/registrar/records/students/12/document-requests', cookie, {
      documentType: 'Transcript', documentName: 'Grade 11 Transcript', requestedOn: '2026-09-30', idempotencyKey: key
    });
    assert.equal(denied.status, 403);
    assert.equal(documentCalls.length, 0);
    failCreateRequest = true;
    const failed = await postForm(baseUrl, '/registrar/records/students/12/document-requests', cookie, {
      _csrf: csrfToken, documentType: '', documentName: 'Draft transcript', requestedOn: '2026-09-30', idempotencyKey: key
    });
    assert.equal(failed.status, 400);
    const failedHtml = await failed.text();
    assert.match(failedHtml, /Document type is required/);
    assert.match(failedHtml, /href="\/documents\/students\/12" aria-current="page">Documents<\/a>/);
    assert.match(failedHtml, /name="documentName" maxlength="150" value="Draft transcript"/);
    assert.match(failedHtml, new RegExp(`name="idempotencyKey" value="${key}"`));
    failCreateRequest = false;
    const created = await postForm(baseUrl, '/registrar/records/students/12/document-requests', cookie, {
      _csrf: csrfToken, documentType: 'Transcript', documentName: 'Grade 11 Transcript',
      requestedOn: '2026-09-30', idempotencyKey: key
    });
    assert.equal(created.status, 303);
    assert.match(created.headers.get('location'), /view=requests.*notice=documentRequestCreated/);
    assert.equal(documentCalls[0][0], 'create');
    const corrected = await postForm(baseUrl, '/registrar/records/students/12/document-requests/82222222-2222-4222-8222-222222222222/correct', cookie, {
      _csrf: csrfToken, idempotencyKey: '83333333-3333-4333-8333-333333333333', documentType: 'Certificate',
      documentName: 'Enrollment Certificate', requestedOn: '2026-09-01', releasedOn: '2026-09-10',
      recipient: 'Original Recipient', reason: 'Corrected a transcription error.'
    });
    assert.equal(corrected.status, 303);
    assert.equal(documentCalls[2][0], 'correct');

    const historyPage = await fetch(`${baseUrl}/registrar/records/students/12?view=history`, { headers: { cookie } });
    assert.equal(historyPage.status, 200);
    const historyHtml = await historyPage.text();
    assert.match(historyHtml, /Student profile revision history/);
    assert.doesNotMatch(historyHtml, /Document requests and release history|Record document request/);
    const unsupportedView = await fetch(`${baseUrl}/registrar/records/students/12?view=unexpected`, { headers: { cookie } });
    assert.match(await unsupportedView.text(), /<h2 class="student-record-view-title">Overview<\/h2>/);

    const overview = await fetch(`${baseUrl}/registrar/records/grades/missing?termId=4&sectionId=8&subjectId=9`, { headers: { cookie } });
    assert.equal(overview.status, 200);
    const overviewHtml = await overview.text();
    assert.match(overviewHtml, /Distinct enrolled learners/);
    assert.match(overviewHtml, /Current terms include the four ECR grading periods/);
    assert.match(overviewHtml, /All grading periods/);
    assert.match(overviewHtml, /registrar-records-followup\.js/);
    assert.equal(overviewCalls.length, 1);
  });

  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, studentRecordsService: recordsService,
    documentRequestService, gradeOverviewService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const response = await fetch(`${baseUrl}/registrar/records/grades/missing`, { headers: { cookie } });
    assert.equal(response.status, 403);
    assert.equal(overviewCalls.length, 1);
    assert.equal(documentCalls.length, 3);
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
