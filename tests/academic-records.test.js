const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');
const {
  AcademicRecordsError,
  createAcademicRecordsService,
  validateSubject,
  validateAssignment,
  validateGrade,
  normalizeGradeValue
} = require('../src/services/academicRecordsService');
const { ClassScheduleError } = require('../src/services/classScheduleService');
const { TeacherGradeSubmissionError } = require('../src/services/teacherGradeSubmissionService');

function fakeSql() {
  return {
    MAX: 'MAX',
    Int: 'Int',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
    NVarChar: (length) => `NVarChar(${length})`,
    Decimal: (precision, scale) => `Decimal(${precision},${scale})`
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
  const service = createAcademicRecordsService({ getPool: async () => ({}), sql: fakeSql(), transactionFactory });
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
  return async () => ({
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
}

const environment = {
  nodeEnv: 'development',
  devPasswordOnlyLogin: true,
  sessionSecret: 'phase-six-academic-records-test-session-secret'
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

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('subject, enrollment assignment, grading period, remarks, and provisional grade range are validated', () => {
  assert.deepEqual(validateSubject({ subjectCode: ' cs-101 ', subjectName: 'Computer Science', units: '3.00' }), {
    subjectCode: 'CS-101', subjectName: 'Computer Science', units: 3
  });
  assert.equal(validateSubject({ subjectCode: 'MATH 1', subjectName: 'Mathematics', units: '' }).units, null);
  assert.throws(() => validateSubject({ subjectCode: 'CS<1>', subjectName: 'Computer Science' }), AcademicRecordsError);
  assert.throws(() => validateSubject({ subjectCode: 'BIO-1', subjectName: 'x'.repeat(201) }), /Subject name is required/);
  assert.throws(() => validateSubject({ subjectCode: 'BIO-1', subjectName: 'Biology', units: '1000' }), /between 0.01 and 999.99/);
  assert.throws(() => validateSubject(null), /Subject code is required/);
  assert.deepEqual(validateAssignment({ studentId: '10', enrollmentId: '22', subjectId: '4' }), { studentId: 10, enrollmentId: 22, subjectId: 4 });
  assert.throws(() => validateAssignment({ studentId: '10', enrollmentId: 'bad', subjectId: '4' }), /valid enrollment/);
  assert.throws(() => validateAssignment(null), /valid student/);
  assert.equal(validateGrade({ studentId: '10', studentSubjectId: '22', gradingPeriod: 'Quarter A', gradeValue: '100', remarks: 'Complete' }).gradeValue, 100);
  assert.equal(validateGrade({ studentId: '10', studentSubjectId: '22', gradingPeriod: 'Term supplied by registrar' }).gradeValue, null);
  assert.throws(() => validateGrade({ studentId: '10', studentSubjectId: '22', gradingPeriod: 'x'.repeat(51) }), /Grading period is required/);
  assert.throws(() => validateGrade({ studentId: '10', studentSubjectId: '22', gradingPeriod: 'Quarter A', gradeValue: '100.01' }), /between 0 and 100/);
  assert.throws(() => validateGrade({ studentId: '10', studentSubjectId: '22', gradingPeriod: 'Quarter A', remarks: 'x'.repeat(101) }), /Remarks must be/);
  assert.throws(() => validateGrade(null), /valid student/);
  assert.equal(normalizeGradeValue('0'), 0);
  assert.throws(() => normalizeGradeValue('-1'), /number from 0 to 100/);
});

test('subject creation is parameterized, registrar-checked, serializable, and audited in its transaction', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM subjects')) return { recordset: [] };
    if (statement.includes('INSERT INTO subjects')) return { insertId: 31 };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  const subjectId = await service.saveSubject(7, null, { subjectCode: 'eng-101', subjectName: 'English', units: '3' });
  assert.equal(subjectId, 31);
  assert.equal(log.isolation, 'SERIALIZABLE');
  assert.equal(log.committed, true);
  const insert = log.queries.find(({ statement }) => statement.includes('INSERT INTO subjects'));
  assert.equal(insert.values.subjectCode, 'ENG-101');
  assert.equal(insert.values.subjectName, 'English');
  assert.equal(insert.values.units, 3);
  assert.doesNotMatch(insert.statement, /ENG-101/);
  const audit = log.queries.find(({ statement }) => statement.includes('INSERT INTO audit_logs'));
  assert.equal(audit.values.action, 'registrar.subject_created');
  assert.equal(audit.values.entityId, '31');
});

test('academic writes allow database administrators and reject other roles or duplicate catalog keys', async () => {
  const denied = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'finance' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(denied.service.saveSubject(7, null, { subjectCode: 'CS1', subjectName: 'Computer Science' }), /Academic record access is no longer active/);
  assert.equal(denied.log.rolledBack, true);
  assert.equal(denied.log.queries.some(({ statement }) => statement.includes('INSERT INTO subjects')), false);
  assert.equal(denied.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);

  const admin = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'database_admin' }] };
    if (statement.includes('FROM subjects')) return { recordset: [] };
    if (statement.includes('INSERT INTO subjects')) return { insertId: 12 };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  assert.equal(await admin.service.saveSubject(7, null, { subjectCode: 'CS1', subjectName: 'Computer Science' }), 12);
  assert.equal(admin.log.queries.at(-1).values.action, 'database_admin.subject_created');

  const duplicate = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM subjects')) return { recordset: [{ id: 9 }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(duplicate.service.saveSubject(7, null, { subjectCode: 'CS1', subjectName: 'Computer Science' }), /already in use/);
  assert.equal(duplicate.log.rolledBack, true);
  assert.equal(duplicate.log.queries.some(({ statement }) => statement.includes('INSERT INTO subjects')), false);
  assert.equal(duplicate.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
});

test('subject assignment verifies the student owns the enrollment and records audit atomically', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM enrollments')) return { recordset: [{ id: 22, student_id: 10 }] };
    if (statement.includes('FROM subjects')) return { recordset: [{ id: 4 }] };
    if (statement.includes('FROM student_subjects')) return { recordset: [] };
    if (statement.includes('INSERT INTO student_subjects')) return { insertId: 80 };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  const studentId = await service.assignSubject(7, { studentId: '10', enrollmentId: '22', subjectId: '4' });
  assert.equal(studentId, 10);
  const enrollmentCheck = log.queries.find(({ statement }) => statement.includes('FROM enrollments'));
  assert.match(enrollmentCheck.statement, /e\.id = @enrollmentId AND e\.student_id = @studentId/);
  assert.deepEqual(enrollmentCheck.values, { enrollmentId: 22, studentId: 10 });
  assert.equal(log.queries.at(-1).values.action, 'registrar.subject_assigned');
  assert.equal(log.committed, true);
});

test('archived students cannot receive subject assignments or new grade writes', async () => {
  const archivedAssignment = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM enrollments')) return { recordset: [{ id: 22, student_id: 10, status: 'archived' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(
    archivedAssignment.service.assignSubject(7, { studentId: '10', enrollmentId: '22', subjectId: '4' }),
    /Archived students cannot receive new academic records/
  );
  assert.equal(archivedAssignment.log.rolledBack, true);
  const enrollmentRead = archivedAssignment.log.queries.find(({ statement }) => statement.includes('FROM enrollments'));
  assert.match(enrollmentRead.statement, /st\.status/);
  assert.match(enrollmentRead.statement, /INNER JOIN students AS st ON st\.id = e\.student_id[\s\S]*FOR UPDATE/);
  assert.equal(archivedAssignment.log.queries.some(({ statement }) => statement.includes('INSERT INTO student_subjects')), false);
  assert.equal(archivedAssignment.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);

  const archivedGrade = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM student_subjects')) return { recordset: [{ id: 80, student_id: 10, status: 'archived' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  await assert.rejects(archivedGrade.service.saveGrade(7, {
    studentId: '10', studentSubjectId: '80', gradingPeriod: 'Quarter A', gradeValue: '92.50'
  }), /Archived students cannot receive new academic records/);
  assert.equal(archivedGrade.log.rolledBack, true);
  const enrollmentSubjectRead = archivedGrade.log.queries.find(({ statement }) => statement.includes('FROM student_subjects'));
  assert.match(enrollmentSubjectRead.statement, /st\.status/);
  assert.match(enrollmentSubjectRead.statement, /INNER JOIN students AS st ON st\.id = e\.student_id[\s\S]*FOR UPDATE/);
  assert.equal(archivedGrade.log.queries.some(({ statement }) => statement.includes('INSERT INTO grades') || statement.includes('UPDATE grades')), false);
  assert.equal(archivedGrade.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
});

test('grade upsert binds the staff period and requires an enrollment subject belonging to that student', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM student_subjects')) return { recordset: [{ id: 80, student_id: 10 }] };
    if (statement.includes('FROM grades') && statement.includes('id <> @gradeId')) return { recordset: [] };
    if (statement.includes('FROM grades')) return { recordset: [{ id: 91 }] };
    if (statement.includes('UPDATE grades')) return { recordset: [] };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  const studentId = await service.saveGrade(7, {
    studentId: '10', studentSubjectId: '80', gradeId: '91', gradingPeriod: 'Quarter A', gradeValue: '92.50', remarks: 'Good progress'
  });
  assert.equal(studentId, 10);
  const associationCheck = log.queries.find(({ statement }) => statement.includes('FROM student_subjects'));
  assert.match(associationCheck.statement, /ss\.id = @studentSubjectId AND e\.student_id = @studentId/);
  assert.deepEqual(associationCheck.values, { studentSubjectId: 80, studentId: 10 });
  const periodQuery = log.queries.find(({ statement }) => statement.includes('FROM grades') && statement.includes('@gradingPeriod'));
  assert.equal(periodQuery.values.gradingPeriod, 'Quarter A');
  assert.ok(log.queries.some(({ statement }) => statement.includes('UPDATE grades')));
  assert.equal(log.queries.at(-1).values.action, 'registrar.grade_updated');
  assert.equal(log.committed, true);
});

test('grade update rejects a duplicate period key before update or audit', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
    if (statement.includes('FROM student_subjects')) return { recordset: [{ id: 80, student_id: 10 }] };
    if (statement.includes('FROM grades') && statement.includes('id <> @gradeId')) return { recordset: [{ id: 92 }] };
    if (statement.includes('FROM grades')) return { recordset: [{ id: 91 }] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await assert.rejects(service.saveGrade(7, {
    studentId: '10', studentSubjectId: '80', gradeId: '91', gradingPeriod: 'Quarter A', gradeValue: '92'
  }), /already exists/);
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.some(({ statement }) => statement.includes('UPDATE grades')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
});

test('own grades query is scoped through the authenticated account-to-student link', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          return { recordset: [{ subject_code: 'CS1', grade_value: 95 }] };
        }
      };
    }
  };
  const service = createAcademicRecordsService({ getPool: async () => pool, sql: fakeSql() });
  const grades = await service.getOwnGrades(7);
  assert.equal(grades[0].subject_code, 'CS1');
  assert.equal(calls[0].values.userId, 7);
  assert.match(calls[0].statement, /WHERE st\.user_id = @userId/);
  assert.match(calls[0].statement, /JOIN grades AS g ON g\.student_subject_id = ss\.id/);
  assert.doesNotMatch(calls[0].statement, /studentId/);
});

test('catalog reads follow role rules, mutations require CSRF, and rendered catalog values are escaped', async () => {
  let listReads = 0;
  const writes = [];
  const academicRecordsService = {
    async listSubjects() {
      listReads += 1;
      return [
        { id: 4, subject_code: 'CS1', subject_name: '<script>alert(1)</script>', units: 3 },
        { id: 5, subject_code: 'BIO1', subject_name: 'Biology', units: 4 }
      ];
    },
    async saveSubject(...args) {
      if (args[2]?.subjectCode === 'BAD') throw new AcademicRecordsError('Enter a valid subject code.', 400);
      writes.push(args);
      return 4;
    }
  };
  await withServer(createApp({
    databasePool: makeAuthPool('registrar'), environment, academicRecordsService,
    studentRecordsService: { async listWorkspace() { return {}; } }
  }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/registrar/records/subjects`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /<details class="subject-create-details"\s*>/);
    assert.doesNotMatch(html, /<details class="subject-create-details" open>/);
    assert.match(html, /<details class="subject-catalog__disclosure">/);
    assert.match(html, /action="\/registrar\/records\/subjects\/4"/);
    assert.match(html, /name="subjectCode"/);
    assert.match(html, /name="subjectName"/);
    assert.match(html, /name="units"/);
    assert.match(html, /Showing 2 of 2 subjects/);
    const filteredPage = await fetch(`${baseUrl}/registrar/records/subjects?search=CS1`, { headers: { cookie } });
    const filteredHtml = await filteredPage.text();
    assert.equal(filteredPage.status, 200);
    assert.match(filteredHtml, /Showing 1 of 2 subjects/);
    assert.match(filteredHtml, /value="CS1"/);
    assert.doesNotMatch(filteredHtml, />BIO1</);
    const noMatchPage = await fetch(`${baseUrl}/registrar/records/subjects?search=missing`, { headers: { cookie } });
    const noMatchHtml = await noMatchPage.text();
    assert.match(noMatchHtml, /No subjects match “missing”/);
    assert.match(noMatchHtml, /Clear search/);
    const invalid = await postForm(baseUrl, '/registrar/records/subjects', cookie, {
      _csrf: csrfFromHtml(html), subjectCode: 'BAD', subjectName: 'Retained subject', units: '3'
    });
    assert.equal(invalid.status, 400);
    const invalidHtml = await invalid.text();
    assert.match(invalidHtml, /<details class="subject-create-details" open>/);
    assert.match(invalidHtml, /name="subjectCode"[^>]*value="BAD"/);
    assert.equal(writes.length, 0);
    const denied = await postForm(baseUrl, '/registrar/records/subjects', cookie, { subjectCode: 'X1', subjectName: 'Test' });
    assert.equal(denied.status, 403);
    assert.equal(writes.length, 0);
    const saved = await postForm(baseUrl, '/registrar/records/grades', cookie, { studentId: '10', studentSubjectId: '80', gradingPeriod: 'P1' });
    assert.equal(saved.status, 404);
    assert.equal(writes.length, 0);
  });

  await withServer(createApp({
    databasePool: makeAuthPool('finance'), environment, academicRecordsService,
    studentRecordsService: { async listWorkspace() { return {}; } }
  }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const page = await fetch(`${baseUrl}/registrar/records/subjects`, { headers: { cookie } });
    assert.equal(page.status, 403);
  });

  await withServer(createApp({
    databasePool: makeAuthPool('database_admin'), environment, academicRecordsService,
    studentRecordsService: { async listWorkspace() { return {}; } }
  }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin');
    const page = await fetch(`${baseUrl}/registrar/records/subjects`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /action="\/registrar\/records\/subjects"/);
    const saved = await postForm(baseUrl, '/registrar/records/subjects', cookie, {
      _csrf: csrfFromHtml(html), subjectCode: 'X1', subjectName: 'Test'
    });
    assert.equal(saved.status, 303);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], 7);
    const updated = await postForm(baseUrl, '/registrar/records/subjects/4', cookie, {
      _csrf: csrfFromHtml(html), subjectCode: 'CS1', subjectName: 'Computer Science', units: '3'
    });
    assert.equal(updated.status, 303);
    assert.equal(writes.length, 2);
    assert.equal(writes[1][1], 4);
  });
  assert.equal(writes.length, 2);
});

test('teacher assignment list keeps concise context and working status and revoke controls', async () => {
  const revoked = [];
  const assignmentContextCalls = [];
  const teacherGradeSubmissionService = {
    async listAssignmentOptions(actorId, filters) {
      assert.equal(Number(actorId), 7);
      assignmentContextCalls.push(filters);
      return {
        teachers: [{ id: 6, first_name: 'Ari', last_name: 'Lee', email: 'ari@example.edu' }],
        terms: [{ id: 2, school_year: '2026-2027', term: 'First', is_current: true }],
        sections: [{ id: 3, school_year: '2026-2027', term: 'First', grade_level: 'Grade 11', name: 'Section A' }],
        selectedTermId: 2, selectedSectionId: 3, sectionFilterNotice: null,
        subjects: [{ id: 4, subject_code: 'CS1', subject_name: 'Computer Science' }],
        assignments: [{
          id: 20, academic_term_id: 2, section_id: 3, school_year: '2026-2027', term: 'First', grade_level: 'Grade 11', section_name: 'Section A',
          subject_code: 'CS1', subject_name: 'Computer Science', first_name: 'Ari', last_name: 'Lee',
          roster_count: 18, is_active: true, latest_submission_status: 'pending_review'
        }, {
          id: 21, academic_term_id: 2, section_id: 3, school_year: '2026-2027', term: 'First', grade_level: 'Grade 11', section_name: 'Section A',
          subject_code: 'BIO1', subject_name: 'Biology', first_name: 'Rae', last_name: 'Kim',
          roster_count: 18, is_active: false, latest_submission_status: null
        }]
      };
    },
    async createAssignment(actorId, values) {
      assert.equal(Number(actorId), 7);
      assert.equal(values.teacherId, '6');
      assert.equal(values.subjectId, '4');
      throw new TeacherGradeSubmissionError('The selected term, section, or subject is unavailable.', 409);
    },
    async revokeAssignment(actorId, assignmentId) { revoked.push([actorId, assignmentId]); }
  };
  const academicRecordsService = { async listSubjects() { return []; } };
  await withServer(createApp({
    databasePool: makeAuthPool('registrar'), environment, academicRecordsService,
    studentRecordsService: { async listWorkspace() { return {}; } }, teacherGradeSubmissionService
  }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/registrar/records/teacher-assignments`, { headers: { cookie } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Grade 11 · Section A/);
    assert.match(html, /<details class="teacher-assignment-section" open>[\s\S]*?<strong>Grade 11 · Section A<\/strong>/);
    assert.match(html, /class="teacher-assignment-class"><strong>CS1 · Computer Science<\/strong>/);
    assert.doesNotMatch(html, /Grade Grade 11/);
    assert.match(html, /class="teacher-assignment-roster">18 students<\/span>/);
    assert.match(html, /pending review/);
    assert.match(html, /Active assignments/);
    assert.match(html, /action="\/registrar\/records\/teacher-assignments\/20\/revoke"/);
    assert.match(html, /<button class="button button--danger" type="submit">Revoke<\/button>/);
    assert.match(html, /name="termId"/);
    assert.match(html, /name="sectionId"/);
    assert.match(html, /<label for="assignment-term-context">Academic term<\/label>/);
    assert.match(html, /<h2 id="assignment-context-title">Choose term and section<\/h2>/);
    assert.match(html, /<button class="button button--secondary" type="submit">Show assignments<\/button>/);
    assert.match(html, /<label for="assignment-section-context">Section<\/label>/);
    assert.match(html, /<label for="assignment-section">Section<\/label>/);
    assert.match(html, /<label for="teacher-id">Teacher<\/label>/);
    assert.match(html, /<label for="subject-id">Subject<\/label>/);
    assert.equal((html.match(/name="termId"/g) || []).length, 1, 'assignment creation does not ask for term twice');
    assert.match(html, /Past and revoked assignments/);
    assert.match(html, /<details/);
    assert.match(html, /\/registrar\/schedules\?termId=2&amp;sectionId=3&amp;assignmentId=20&amp;showCreate=1#schedule-create-title/);
    const createResponse = await postForm(baseUrl, '/registrar/records/teacher-assignments', cookie, {
      _csrf: csrfFromHtml(html), academicTermId: '2', sectionId: '3', filterTermId: '2',
      teacherId: '6', subjectId: '4'
    });
    assert.equal(createResponse.status, 409);
    const createErrorHtml = await createResponse.text();
    assert.match(createErrorHtml, /The selected term, section, or subject is unavailable/);
    assert.match(createErrorHtml, /<details class="assignment-create-details" open>[\s\S]*?<summary id="create-teacher-assignment-title">Assign a teacher<\/summary>/);
    assert.match(createErrorHtml, /name="academicTermId" value="2"/);
    assert.match(createErrorHtml, /<option value="3" selected>Grade 11 · Section A<\/option>/);
    assert.match(createErrorHtml, /option value="6" selected/);
    assert.match(createErrorHtml, /option value="4" selected/);
    assert.deepEqual(assignmentContextCalls.at(-1), { termId: '2', sectionId: '3' });
    const response = await postForm(baseUrl, '/registrar/records/teacher-assignments/20/revoke', cookie, {
      _csrf: csrfFromHtml(html), filterTermId: '2', filterSectionId: '3'
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/registrar/records/teacher-assignments?termId=2&sectionId=3&notice=assignmentRevoked');
    assert.deepEqual(revoked, [[7, '20']]);
  });
});

test('schedule page honors a contextual assignment link and preserves selected values on conflict', async () => {
  const filtersSeen = [];
  const workspace = {
    terms: [{ id: 6, school_year: '2026-2027', term: 'First', is_current: true }],
    sections: [{ id: 12, name: 'STEM A', grade_level: 'Grade 11' }],
    academicTermId: 6,
    selectedSectionId: 12,
    selectedAssignmentId: 44,
    contextNotice: null,
    assignments: [{ id: 44, grade_level: 'Grade 11', section_name: 'STEM A', subject_code: 'OCOM', teacher_name: 'Jamie Lee' }],
    schedules: [{ id: 72, assignment_id: 44, day_of_week: 1, start_time: '08:00', end_time: '09:00', room: 'A12',
      assignment_is_active: true, grade_level: 'Grade 11', section_name: 'STEM A', school_year: '2026-2027',
      term: 'First', subject_code: 'OCOM', subject_name: 'Oral Communication', teacher_name: 'Jamie Lee' }]
  };
  const classScheduleService = {
    async listRegistrarWorkspace(actorId, filters) { assert.equal(Number(actorId), 7); filtersSeen.push(filters); return workspace; },
    async saveSchedule(actorId, scheduleId, values) {
      assert.equal(Number(actorId), 7);
      assert.equal(scheduleId, null);
      assert.equal(values.assignmentId, '44');
      throw new ClassScheduleError('This time conflicts with another class for the section, teacher, or room.', 409);
    }
  };
  await withServer(createApp({ databasePool: makeAuthPool('registrar'), environment, classScheduleService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/registrar/schedules?termId=6&sectionId=12&assignmentId=44`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.deepEqual(filtersSeen[0], { termId: '6', sectionId: '12', assignmentId: '44' });
    assert.match(html, /name="assignmentId"/);
    assert.match(html, /value="44" selected/);
    assert.match(html, /STEM A · OCOM · Jamie Lee/);
    assert.match(html, /class="schedule-section-card__heading">[\s\S]*?<h3 id="schedule-section-title-0">Grade 11 · STEM A<\/h3>/);
    assert.match(html, /Clear day, time, and room/);
    assert.match(html, /aria-label="Class times grouped by section"/);
    assert.match(html, /data-clear-section-on-term-change data-clear-assignment-on-section-change/);
    for (const [id, label] of [['schedule-term-filter', 'Academic term'], ['schedule-section-filter', 'Section'],
      ['schedule-assignment-filter', 'Assigned class'], ['schedule-day', 'Day'], ['schedule-start', 'Starts'],
      ['schedule-end', 'Ends'], ['schedule-room', 'Room']]) {
      assert.match(html, new RegExp(`<label for="${id}">${label}`));
    }

    const response = await postForm(baseUrl, '/registrar/schedules', cookie, {
      _csrf: csrfFromHtml(html), termId: '6', filterSectionId: '12', filterAssignmentId: '44',
      assignmentId: '44', dayOfWeek: '3', startTime: '10:00', endTime: '11:00', room: 'Room 204'
    });
    assert.equal(response.status, 409);
    const errorHtml = await response.text();
    assert.match(errorHtml, /This time conflicts with another class/);
    assert.match(errorHtml, /name="filterSectionId" value="12"/);
    assert.match(errorHtml, /name="filterAssignmentId" value="44"/);
    assert.match(errorHtml, /name="dayOfWeek"/);
    assert.match(errorHtml, /value="3" selected/);
    assert.match(errorHtml, /name="startTime" type="time" required value="10:00"/);
    assert.match(errorHtml, /name="endTime" type="time" required value="11:00"/);
    assert.match(errorHtml, /name="room" maxlength="80" value="Room 204"/);
  });
});

test('academic student view shows read-only grades and permits enrollment subject assignment for staff', async () => {
  const academicRecordsService = {
    async getStudentAcademicRecord() {
      return {
        student: { id: 10, student_no: 'S-10', first_name: 'Ari', last_name: 'Lee', status: 'active' },
        subjects: [{ id: 4, subject_code: 'CS1', subject_name: 'Computer Science', units: 3 }],
        enrollments: [{
          id: 22, school_year: '2026-2027', term: 'Registrar label', is_current: true,
          section_name: 'Section A', enrollment_status: 'enrolled',
          subjects: [{ id: 80, subjectId: 4, subjectCode: 'CS1', subjectName: 'Computer Science', units: 3,
            grades: [{ id: 91, gradingPeriod: 'Quarter A', gradeValue: 92.5, remarks: 'Good progress' }] }]
        }]
      };
    }
  };
  const studentRecordsService = { async listWorkspace() { return {}; } };
  await withServer(createApp({ databasePool: makeAuthPool('registrar'), environment, studentRecordsService, academicRecordsService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/registrar/records/students/10/academic`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Enrollment history/);
    assert.match(html, /CS1 · Computer Science/);
    assert.match(html, /Registrar label/);
    assert.match(html, /Quarter A/);
    assert.match(html, /92\.5/);
    assert.doesNotMatch(html, /action="\/registrar\/records\/grades"/);
    assert.match(html, /action="\/registrar\/records\/student-subjects"/);
  });

  await withServer(createApp({ databasePool: makeAuthPool('database_admin'), environment, studentRecordsService, academicRecordsService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin');
    const page = await fetch(`${baseUrl}/registrar/records/students/10/academic`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /CS1 · Computer Science/);
    assert.match(html, /Quarter A/);
    assert.doesNotMatch(html, /action="\/registrar\/records\/grades"/);
    assert.match(html, /action="\/registrar\/records\/student-subjects"/);
  });
});

test('registrar direct grade writes are unavailable; approved teacher submissions are the grade write path', async () => {
  let directWrites = 0;
  const academicRecordsService = {
    async getStudentAcademicRecord() {
      return {
        student: { id: 10, student_no: 'S-10', first_name: 'Ari', last_name: 'Lee', status: 'active' },
        subjects: [],
        enrollments: [{
          id: 22, school_year: '2026-2027', term: 'First', is_current: true,
          section_name: 'Section A', enrollment_status: 'enrolled',
          subjects: [{ id: 80, subjectId: 4, subjectCode: 'CS1', subjectName: 'Computer Science', units: 3, grades: [] }]
        }]
      };
    },
    async saveGrade() { directWrites += 1; throw new AcademicRecordsError('Enter a grade from 0 to 100.', 400); }
  };
  const studentRecordsService = { async listWorkspace() { return {}; } };
  await withServer(createApp({ databasePool: makeAuthPool('registrar'), environment, studentRecordsService, academicRecordsService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/registrar/records/students/10/academic`, { headers: { cookie } });
    const html = await page.text();
    const response = await postForm(baseUrl, '/registrar/records/grades', cookie, {
      _csrf: csrfFromHtml(html), studentId: '10', studentSubjectId: '80', gradingPeriod: 'Quarter A', gradeValue: '101'
    });
    assert.equal(response.status, 404);
    assert.equal(directWrites, 0);
  });
});

test('archived academic records retain history but hide grade and subject write forms', async () => {
  const academicRecordsService = {
    async getStudentAcademicRecord() {
      return {
        student: { id: 10, student_no: 'S-10', first_name: 'Ari', last_name: 'Lee', status: 'archived' },
        subjects: [{ id: 4, subject_code: 'CS1', subject_name: 'Computer Science', units: 3 }],
        enrollments: [{
          id: 22, school_year: '2026-2027', term: 'First', is_current: false,
          section_name: 'Section A', enrollment_status: 'enrolled',
          subjects: [{ id: 80, subjectId: 4, subjectCode: 'CS1', subjectName: 'Computer Science', units: 3,
            grades: [{ id: 91, gradingPeriod: 'Quarter A', gradeValue: 92.5, remarks: 'Good progress' }] }]
        }]
      };
    }
  };
  const studentRecordsService = { async listWorkspace() { return {}; } };
  await withServer(createApp({ databasePool: makeAuthPool('registrar'), environment, studentRecordsService, academicRecordsService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/registrar/records/students/10/academic`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Existing enrollments, subjects, and grades are available for review/);
    assert.match(html, /Quarter A/);
    assert.match(html, /Good progress/);
    assert.doesNotMatch(html, /action="\/registrar\/records\/grades"/);
    assert.doesNotMatch(html, /action="\/registrar\/records\/student-subjects"/);
  });
});

test('registrar subject create requires a valid CSRF token before invoking writes', async () => {
  const writes = [];
  const academicRecordsService = {
    async listSubjects() { return []; },
    async saveSubject(...args) { writes.push(args); return 4; }
  };
  await withServer(createApp({
    databasePool: makeAuthPool('registrar'), environment, academicRecordsService,
    studentRecordsService: { async listWorkspace() { return {}; } }
  }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/registrar/records/subjects`, { headers: { cookie } });
    const csrfToken = csrfFromHtml(await page.text());
    const response = await postForm(baseUrl, '/registrar/records/subjects', cookie, {
      _csrf: csrfToken, subjectCode: 'CS1', subjectName: 'Computer Science', units: '3'
    });
    assert.equal(response.status, 303);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], 7);
  });
});

test('student grades page requests only session-owned grades, ignoring query-supplied student ids', async () => {
  const gradeUserIds = [];
  const studentRecordsService = {
    async getOwnStudentRecord(userId) {
      assert.equal(userId, 7);
      return { student: { student_no: 'S-7', first_name: 'Rae', last_name: 'Student' }, enrollments: [] };
    },
    async getStudentDashboardSummary(userId) { assert.equal(userId, 7); return { document_count: 0, documents_in_progress_count: 0 }; }
  };
  const academicRecordsService = {
    async getOwnGrades(userId) {
      gradeUserIds.push(userId);
      return [{ subject_code: 'CS1', subject_name: 'Computer Science', grading_period: 'Quarter A', grade_value: 97 }];
    }
  };
  const financeService = { async getOwnStudentAccount(userId) { assert.equal(userId, 7); return { account: null, transactions: [] }; } };
  const classScheduleService = { async getOwnStudentSchedule(userId) { assert.equal(userId, 7); return []; } };
  await withServer(createApp({ databasePool: makeAuthPool('student'), environment, studentRecordsService, academicRecordsService, financeService, classScheduleService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const page = await fetch(`${baseUrl}/student/grades?studentId=999&userId=888`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Computer Science/);
    assert.deepEqual(gradeUserIds, [7]);
  });
});
