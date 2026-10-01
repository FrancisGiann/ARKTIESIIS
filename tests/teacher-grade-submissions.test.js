const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const {
  TeacherGradeSubmissionError,
  createTeacherGradeSubmissionService
} = require('../src/services/teacherGradeSubmissionService');

const SUBMISSION_ID = 'f53eb245-6ad6-4a91-8aa4-e32dbbafc4ef';
const PREVIEW_ID = 'e6226417-6c54-4f85-9671-7e7d2a33f174';

function fakeSql() {
  return {
    MAX: 'MAX', Int: 'Int', BigInt: 'BigInt', UniqueIdentifier: 'UniqueIdentifier',
    Char: (length) => `Char(${length})`, NVarChar: (length) => `NVarChar(${length})`,
    Decimal: (precision, scale) => `Decimal(${precision},${scale})`, DateTime2: 'DateTime2', Bit: 'Bit',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }
  };
}

function requestFor(handler, calls) {
  const values = {};
  return {
    input(name, _type, value) { values[name] = value; return this; },
    async query(statement) {
      const call = { statement, values: { ...values } };
      calls?.push(call);
      return handler(call);
    }
  };
}

const HTTP_SECRET = 'teacher-grade-submissions-http-test-secret';
const HTTP_PREVIEW = {
  id: PREVIEW_ID, academicTermId: 3, term: 'Term 1', schoolYear: '2026-2027', gradeLevel: 'Grade 11',
  sectionName: 'STEM A', subjectName: 'Oral Communication', originalFilename: 'grades.xlsx',
  workbookGradeLevel: 'Grade 11', workbookSectionName: 'STEM A', workbookSubjectName: 'Oral Communication',
  contextMismatch: false,
  rows: [{ sourceRow: 17, studentId: 44, studentNo: 'S-44', studentName: 'Jamie Garcia', workbookName: 'Jamie Garcia',
    issue: null, nameMismatch: false, grades: [
      { gradingPeriod: 'Term 1', gradeValue: 89 }, { gradingPeriod: 'Term 2', gradeValue: 90 },
      { gradingPeriod: 'Term 3', gradeValue: 91 }, { gradingPeriod: 'Final Grade', gradeValue: 90 }
    ] }],
  counts: { rows: 1, eligible: 1, unresolved: 0, conflicts: 0 }
};
const HTTP_SUBMISSION = {
  id: SUBMISSION_ID, assignment_id: 12, revision_number: 1, status: 'pending',
  school_year: '2026-2027', term: 'Term 1', grade_level: 'Grade 11', section_name: 'STEM A',
  subject_id: 77, subject_name: 'Oral Communication', original_filename: 'grades.xlsx',
  submitted_at: new Date(), rows: [{ sourceRow: 17, studentNo: 'S-44', studentName: 'Jamie Garcia', workbookName: 'Jamie Garcia',
    issue: null, nameMismatch: false, grades: [
      { gradingPeriod: 'Term 1', gradeValue: 89 }, { gradingPeriod: 'Term 2', gradeValue: 90 },
      { gradingPeriod: 'Term 3', gradeValue: 91 }, { gradingPeriod: 'Final Grade', gradeValue: 90 }
    ] }],
  history: [], counts: { rows: 1, eligible: 1, unresolved: 0, conflicts: 0 }
};

function authPool(users) {
  return async () => ({
    request() {
      return requestFor(({ statement, values }) => {
        if (statement.includes('WHERE email = @email')) return { recordset: users.filter((user) => user.email === values.email) };
        if (statement.includes('WHERE id = @userId')) return { recordset: users.filter((user) => user.id === values.userId) };
        throw new Error(`Unexpected auth SQL: ${statement}`);
      });
    }
  });
}

function cookieFrom(response) { return response.headers.get('set-cookie').split(';', 1)[0]; }
function csrfFrom(html) { return html.match(/name="_csrf" value="([^"]+)"/)?.[1]; }

async function signIn(baseUrl, email) {
  const page = await fetch(`${baseUrl}/login`);
  const cookie = cookieFrom(page);
  const token = csrfFrom(await page.text());
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, email, password: 'Correct-Horse-Battery-12' })
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function readerHarness({ actorId = 7, role = 'teacher', active = true, ownerId = 7, assignmentActive = true,
  storageDirectory, storageKey = SUBMISSION_ID } = {}) {
  const calls = [];
  const header = {
    id: SUBMISSION_ID, assignment_id: 12, previous_submission_id: null, revision_number: 1,
    submitted_by: ownerId, school_year: '2026-2027', grade_level: 'Grade 11', section_name: 'STEM A',
    subject_id: 77, subject_name: 'Oral Communication', workbook_grade_level: 'Grade 11',
    workbook_section_name: 'STEM A', workbook_subject_name: 'Oral Communication', context_mismatch: false,
    original_filename: 'grades.xlsx', storage_key: storageKey, file_size_bytes: 4,
    status: 'pending', submitted_at: new Date(), decision_reason: null, decided_at: null, term: 'Term 1'
  };
  const pool = {
    request() {
      return requestFor(({ statement, values }) => {
        if (statement.includes('SELECT id, role FROM users WHERE id = @actorId')) {
          return { recordset: active ? [{ id: actorId, role }] : [] };
        }
        if (statement.includes('FROM teacher_grade_submissions AS s') && statement.includes('WHERE s.id = @submissionId')) {
          const canReadAsOwner = statement.includes('s.submitted_by = @actorId')
            && statement.includes('a.teacher_id = @actorId') && statement.includes('a.is_active = 1');
          const canReadAsRegistrar = statement.includes('reviewer.role = \'registrar\'');
          const authorized = canReadAsRegistrar
            || (canReadAsOwner && role === 'teacher' && active && assignmentActive && ownerId === values.actorId);
          return { recordset: authorized ? [header] : [] };
        }
        if (statement.includes('FROM teacher_grade_submission_rows AS r')) return { recordset: [] };
        if (statement.includes('FROM teacher_grade_submission_events AS e')) return { recordset: [] };
        if (statement.includes('FROM teacher_grade_submissions AS s') && statement.includes('WHERE s.status = \'pending\'')) {
          return { recordset: [] };
        }
        throw new Error(`Unexpected SQL: ${statement}`);
      }, calls);
    }
  };
  const service = createTeacherGradeSubmissionService({ getPool: async () => pool, sql: fakeSql(),
    storageDirectory, secret: 'teacher-grade-test-secret' });
  return { service, calls };
}

function assignmentOptionsHarness() {
  const calls = [];
  const pool = {
    request() {
      return requestFor(({ statement, values }) => {
        if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
        if (statement.includes('FROM academic_terms ORDER BY')) return { recordset: [
          { id: 3, school_year: '2026-2027', term: 'First', is_current: true },
          { id: 9, school_year: '2025-2026', term: 'Second', is_current: false }
        ] };
        if (statement.includes('FROM sections AS sec')) return { recordset: values.termId === 3
          ? [{ id: 22, academic_term_id: 3, name: 'STEM A', grade_level: 'Grade 11', school_year: '2026-2027', term: 'First' }]
          : [] };
        if (statement.includes('SELECT id, subject_code, subject_name FROM subjects')) return { recordset: [{ id: 4, subject_code: 'OCOM', subject_name: 'Oral Communication' }] };
        if (statement.includes('FROM users AS u INNER JOIN staff_profiles')) return { recordset: [{ id: 8, email: 'teacher@example.edu', first_name: 'Jamie', last_name: 'Lee' }] };
        if (statement.includes('FROM teacher_assignments AS a')) return { recordset: values.termId === 3
          ? [{ id: 44, academic_term_id: 3, section_id: 22, is_active: true, school_year: '2026-2027', term: 'First',
            grade_level: 'Grade 11', section_name: 'STEM A', subject_code: 'OCOM', subject_name: 'Oral Communication',
            first_name: 'Jamie', last_name: 'Lee', roster_count: 18, latest_submission_status: null }]
          : [] };
        throw new Error(`Unexpected assignment-options SQL: ${statement}`);
      }, calls);
    }
  };
  const service = createTeacherGradeSubmissionService({ getPool: async () => pool, sql: fakeSql(),
    secret: 'teacher-grade-test-secret' });
  return { service, calls };
}

test('registrar assignment options default to is_current and bind sections and assignments to that term', async () => {
  const { service, calls } = assignmentOptionsHarness();
  const options = await service.listAssignmentOptions(7);

  assert.equal(options.selectedTermId, 3);
  assert.equal(options.selectedSectionId, null);
  assert.equal(options.terms.find((term) => term.is_current).id, 3);
  const sections = calls.find(({ statement }) => statement.includes('FROM sections AS sec'));
  assert.equal(sections.values.termId, 3);
  const assignments = calls.find(({ statement }) => statement.includes('FROM teacher_assignments AS a'));
  assert.equal(assignments.values.termId, 3);
  assert.equal(assignments.values.sectionId, null);
  assert.match(assignments.statement, /a\.academic_term_id = @termId/);
});

test('assignment options clear a section from another term instead of returning its rows', async () => {
  const { service, calls } = assignmentOptionsHarness();
  const options = await service.listAssignmentOptions(7, { termId: '3', sectionId: '91' });

  assert.equal(options.selectedTermId, 3);
  assert.equal(options.selectedSectionId, null);
  assert.match(options.sectionFilterNotice, /different term/);
  assert.equal(options.sections.some((section) => section.id === 91), false);
  const assignments = calls.find(({ statement }) => statement.includes('FROM teacher_assignments AS a'));
  assert.equal(assignments.values.termId, 3);
  assert.equal(assignments.values.sectionId, null);
});

test('teacher assignment creation rejects a forged term and section pairing before writing', async () => {
  const calls = [];
  let rolledBack = false;
  const transactionFactory = () => ({
    async begin() {},
    request() {
      return requestFor(({ statement }) => {
        if (statement.includes('SELECT id, role FROM users WHERE id = @actorId') && statement.includes('@actorId')) {
          return { recordset: [{ id: 7, role: 'registrar' }] };
        }
        if (statement.includes('FROM users') && statement.includes('@teacherId')) {
          return { recordset: [{ id: 8 }] };
        }
        if (statement.includes('FROM academic_terms AS term')) return { recordset: [] };
        throw new Error(`Unexpected assignment-create SQL: ${statement}`);
      }, calls);
    },
    async commit() {}, async rollback() { rolledBack = true; }
  });
  const service = createTeacherGradeSubmissionService({ getPool: async () => ({}), sql: fakeSql(), transactionFactory,
    secret: 'teacher-grade-test-secret' });

  await assert.rejects(service.createAssignment(7, {
    teacherId: '8', academicTermId: '6', sectionId: '91', subjectId: '3'
  }), (error) => error instanceof TeacherGradeSubmissionError && error.status === 404);

  const context = calls.find(({ statement }) => statement.includes('FROM academic_terms AS term'));
  assert.deepEqual(context.values, { termId: 6, sectionId: 91, subjectId: 3 });
  assert.match(context.statement, /sec\.academic_term_id = term\.id AND sec\.id = @sectionId/);
  assert.equal(calls.some(({ statement }) => statement.includes('INSERT INTO teacher_assignments')), false);
  assert.equal(calls.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
  assert.equal(rolledBack, true);
});

test('teacher can only read their own active assignment submission and workbook', async () => {
  const own = readerHarness();
  assert.equal((await own.service.readSubmission(7, SUBMISSION_ID, 'teacher')).submitted_by, 7);
  assert.match(own.calls.find(({ statement }) => statement.includes('WHERE s.id = @submissionId')).statement,
    /s\.submitted_by = @actorId AND a\.teacher_id = @actorId AND a\.is_active = 1/);

  const otherTeacher = readerHarness({ actorId: 8, ownerId: 7 });
  await assert.rejects(otherTeacher.service.readSubmission(8, SUBMISSION_ID, 'teacher'), (error) => {
    assert.ok(error instanceof TeacherGradeSubmissionError);
    assert.equal(error.status, 404);
    return true;
  });
  await assert.rejects(otherTeacher.service.getWorkbook(8, SUBMISSION_ID, 'teacher'), (error) => error.status === 404);
  assert.equal(otherTeacher.calls.filter(({ statement }) => statement.includes('teacher_grade_submission_rows')).length, 0,
    'another teacher does not receive parsed review rows');
});

test('registrar can retrieve a private workbook when a stored uppercase GUID is returned', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-teacher-download-'));
  const submissionDirectory = path.join(directory, 'teacher-grade-submissions');
  const workbook = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  await fs.mkdir(submissionDirectory, { recursive: true });
  await fs.writeFile(path.join(submissionDirectory, `${SUBMISSION_ID}.xlsx`), workbook, { mode: 0o600 });
  try {
    const { service } = readerHarness({ storageDirectory: directory, storageKey: SUBMISSION_ID.toUpperCase() });
    const result = await service.getWorkbook(7, SUBMISSION_ID, 'teacher');
    assert.equal(path.basename(result.filePath), `${SUBMISSION_ID}.xlsx`);
    assert.deepEqual(await fs.readFile(result.filePath), workbook);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('teacher access ends after assignment removal or account revocation; teachers cannot open registrar queue', async () => {
  const removedAssignment = readerHarness({ assignmentActive: false });
  await assert.rejects(removedAssignment.service.readSubmission(7, SUBMISSION_ID, 'teacher'), (error) => error.status === 404);
  await assert.rejects(removedAssignment.service.getWorkbook(7, SUBMISSION_ID, 'teacher'), (error) => error.status === 404);

  const inactiveTeacher = readerHarness({ active: false });
  await assert.rejects(inactiveTeacher.service.readSubmission(7, SUBMISSION_ID, 'teacher'), (error) => error.status === 403);

  const teacher = readerHarness();
  await assert.rejects(teacher.service.listReviewQueue(7), (error) => error.status === 403);
  assert.equal(teacher.calls.some(({ statement }) => statement.includes('WHERE s.status = \'pending\'')), false,
    'teacher access is rejected before the registrar review list is queried');
});

test('review reasons stay out of generic audit details', async () => {
  const calls = [];
  const reason = 'Correct the mismatched learner row before resubmitting.';
  const transactionFactory = () => ({
    async begin(isolation) { assert.equal(isolation, 'SERIALIZABLE'); },
    request() {
      return requestFor(({ statement, values }) => {
        if (statement.includes('SELECT id, role FROM users WHERE id = @actorId')) return { recordset: [{ id: 11, role: 'registrar' }] };
        if (statement.includes('FROM teacher_grade_submissions')) {
          return { recordset: [{ id: SUBMISSION_ID, assignment_id: 12, status: 'pending', revision_number: 1 }] };
        }
        if (statement.includes('UPDATE teacher_grade_submissions')) return { recordset: [] };
        if (statement.includes('INSERT INTO teacher_grade_submission_events')) {
          calls.push({ kind: 'event', values });
          return { recordset: [] };
        }
        if (statement.includes('INSERT INTO audit_logs')) {
          calls.push({ kind: 'audit', values });
          return { recordset: [] };
        }
        throw new Error(`Unexpected SQL: ${statement}`);
      }, calls);
    },
    async commit() {}, async rollback() {}
  });
  const service = createTeacherGradeSubmissionService({
    getPool: async () => ({}), sql: fakeSql(), transactionFactory
  });

  await service.decideSubmission(11, SUBMISSION_ID, 'correction_requested', reason);

  const submissionLock = calls.find(({ statement }) => statement.includes('FROM teacher_grade_submissions'));
  assert.match(submissionLock.statement, /FOR UPDATE$/);
  assert.equal(calls.find(({ kind }) => kind === 'event').values.reason, reason,
    'the restricted decision history retains the complete reason');
  const auditValues = calls.find(({ kind }) => kind === 'audit').values;
  assert.equal(auditValues.detailsJson, JSON.stringify({ assignmentId: 12, revisionNumber: 1 }));
  assert.equal(Object.hasOwn(auditValues, 'reason'), false);
  assert.equal(auditValues.detailsJson.includes(reason), false);
});

test('assignment and roster reads share a serializable active-assignment check', async () => {
  const calls = [];
  let transactionStarted = false;
  const transactionFactory = () => ({
    async begin(isolation) { transactionStarted = isolation === 'SERIALIZABLE'; },
    request() {
      return requestFor(({ statement }) => {
        if (statement.includes('SELECT id, role FROM users WHERE id = @actorId')) return { recordset: [{ id: 7, role: 'teacher' }] };
        if (statement.includes('FROM teacher_assignments AS a')) return { recordset: [{
          assignment_id: 12, academic_term_id: 3, section_id: 4, subject_id: 77,
          school_year: '2026-2027', term: 'Term 1', section_name: 'STEM A', grade_level: 'Grade 11',
          subject_code: 'ENG11', subject_name: 'Oral Communication'
        }] };
        if (statement.includes('FROM enrollments AS e')) return { recordset: [{ student_no: 'S-44', first_name: 'Jamie', last_name: 'Garcia' }] };
        throw new Error(`Unexpected SQL: ${statement}`);
      }, calls);
    },
    async commit() {}, async rollback() {}
  });
  const service = createTeacherGradeSubmissionService({
    getPool: async () => ({}), sql: fakeSql(), transactionFactory
  });
  const assignment = await service.getTeacherAssignment(7, '12');
  assert.equal(transactionStarted, true);
  assert.equal(assignment.roster.length, 1);
  const assignmentQuery = calls.find(({ statement }) => statement.includes('FROM teacher_assignments AS a'));
  assert.match(assignmentQuery.statement, /a\.teacher_id = @teacherId AND a\.is_active = 1/);
  const rosterQuery = calls.find(({ statement }) => statement.includes('FROM enrollments AS e'));
  assert.match(rosterQuery.statement, /e\.academic_term_id = @termId AND e\.section_id = @sectionId/);
  assert.match(rosterQuery.statement, /ss\.subject_id = @subjectId/);
});

test('staged workbook reads and writes recheck the live teacher assignment', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-teacher-stage-'));
  const calls = [];
  const queryHandler = ({ statement }) => {
    if (statement.includes('SELECT id, role FROM users WHERE id = @actorId')) return { recordset: [{ id: 7, role: 'teacher' }] };
    if (statement.includes('FROM grade_import_previews AS p')) return { recordset: [] };
    throw new Error(`Unexpected SQL: ${statement}`);
  };
  const transactionFactory = () => ({
    async begin(isolation) { assert.equal(isolation, 'SERIALIZABLE'); },
    request() { return requestFor(queryHandler, calls); },
    async commit() {}, async rollback() {}
  });
  const pool = { request() { return requestFor(queryHandler, calls); } };
  const service = createTeacherGradeSubmissionService({
    getPool: async () => pool, sql: fakeSql(), transactionFactory,
    storageDirectory: directory, secret: 'teacher-grade-test-secret'
  });
  const workbook = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const stagedPath = path.join(directory, 'teacher-grade-staging', `${PREVIEW_ID}.xlsx`);
  try {
    await assert.rejects(service.stageWorkbook(7, '12', PREVIEW_ID, 'session-a', workbook), (error) => error.status === 404);
    await assert.rejects(service.getStagedWorkbook(7, '12', PREVIEW_ID, 'session-a'), (error) => error.status === 404);
    assert.equal(calls.filter(({ statement }) => statement.includes('FROM grade_import_previews AS p')).length, 2);
    assert.match(calls.find(({ statement }) => statement.includes('FROM grade_import_previews AS p')).statement,
      /a\.teacher_id = p\.uploaded_by[\s\S]*?a\.id = @assignmentId AND a\.is_active = 1/);
    await assert.rejects(fs.stat(stagedPath), { code: 'ENOENT' }, 'revoked assignment creates no staging file');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('submission rolls back and removes its staged original if the teacher assignment was revoked', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-teacher-grades-'));
  const calls = [];
  let rolledBack = false;
  let committed = false;
  const transactionFactory = () => ({
    async begin(isolation) { assert.equal(isolation, 'SERIALIZABLE'); },
    request() {
      return requestFor(({ statement }) => {
        if (statement.includes('SELECT id, role FROM users WHERE id = @actorId')) return { recordset: [{ id: 7, role: 'teacher' }] };
        if (statement.includes('FROM grade_import_previews')) return { recordset: [{ id: PREVIEW_ID }] };
        if (statement.includes('FROM teacher_assignments AS a')) return { recordset: [] };
        throw new Error(`Unexpected SQL: ${statement}`);
      }, calls);
    },
    async commit() { committed = true; }, async rollback() { rolledBack = true; }
  });
  const service = createTeacherGradeSubmissionService({
    getPool: async () => ({}), sql: fakeSql(), transactionFactory,
    storageDirectory: directory, secret: 'teacher-grade-test-secret'
  });
  const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  try {
    await assert.rejects(service.submitPreview({
      actorId: 7, assignmentId: 12, preview: {
        id: PREVIEW_ID, academicTermId: 3, schoolYear: '2026-2027', gradeLevel: 'Grade 11',
        sectionName: 'STEM A', subjectName: 'Oral Communication', originalFilename: 'grades.xlsx', rows: []
      },
      sessionId: 'session-a', buffer
    }), (error) => error.status === 403);
    assert.equal(rolledBack, true);
    assert.equal(committed, false);
    assert.equal(calls.some(({ statement }) => statement.includes('INSERT INTO teacher_grade_submissions')), false);
    assert.deepEqual(await fs.readdir(path.join(directory, 'teacher-grade-submissions')), [],
      'the original workbook is removed when authorization changes before commit');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('teacher submission carries the server stored LRN fingerprint without returning it in the preview', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-teacher-fingerprint-'));
  const calls = [];
  const fingerprint = 'a'.repeat(64);
  let insertedRow = null;
  const transactionFactory = () => ({
    async begin(isolation) { assert.equal(isolation, 'SERIALIZABLE'); },
    request() {
      return requestFor(({ statement, values }) => {
        if (statement.includes('SELECT id, role FROM users WHERE id = @actorId')) return { recordset: [{ id: 7, role: 'teacher' }] };
        if (statement.includes('FROM grade_import_previews')) return { recordset: [{ id: PREVIEW_ID }] };
        if (statement.includes('FROM teacher_assignments AS a')) return { recordset: [{
          id: 12, academic_term_id: 3, school_year: '2026-2027', grade_level: 'Grade 11',
          section_name: 'STEM A', subject_name: 'Oral Communication'
        }] };
        if (statement.includes('SELECT id, revision_number, status, submitted_by')) return { recordset: [] };
        if (statement.includes('FROM grade_import_preview_rows')) {
          calls.push({ statement, values });
          return { recordset: [{ source_row: 17, lrn_fingerprint: fingerprint }] };
        }
        if (statement.includes('INSERT INTO teacher_grade_submission_rows')) {
          insertedRow = values;
          return { insertId: 100 };
        }
        if (statement.includes('INSERT INTO teacher_grade_submission_grades')) return { recordset: [] };
        if (statement.includes('INSERT INTO audit_logs')
          || statement.includes('INSERT INTO teacher_grade_submissions')
          || statement.includes('INSERT INTO teacher_grade_submission_events')) return { recordset: [] };
        throw new Error(`Unexpected SQL: ${statement}`);
      }, calls);
    },
    async commit() {}, async rollback() {}
  });
  const service = createTeacherGradeSubmissionService({
    getPool: async () => ({}), sql: fakeSql(), transactionFactory,
    storageDirectory: directory, secret: 'teacher-grade-test-secret'
  });
  const preview = {
    id: PREVIEW_ID, academicTermId: 3, schoolYear: '2026-2027', gradeLevel: 'Grade 11',
    sectionName: 'STEM A', subjectName: 'Oral Communication', originalFilename: 'grades.xlsx',
    workbookGradeLevel: 'Grade 11', workbookSectionName: 'STEM A', workbookSubjectName: 'Oral Communication',
    contextMismatch: false,
    rows: [{ sourceRow: 17, studentId: 44, studentNo: 'S-44', studentName: 'Jamie Garcia', workbookName: 'Jamie Garcia',
      issue: null, nameMismatch: false, grades: [
        { gradingPeriod: 'Term 1', gradeValue: 89 }, { gradingPeriod: 'Term 2', gradeValue: 90 },
        { gradingPeriod: 'Term 3', gradeValue: 91 }, { gradingPeriod: 'Final Grade', gradeValue: 90 }
      ] }]
  };
  const workbook = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  try {
    await service.submitPreview({ actorId: 7, assignmentId: 12, preview, sessionId: 'session-a', buffer: workbook });
    assert.equal(Object.hasOwn(preview.rows[0], 'lrnFingerprint'), false, 'the private fingerprint is not exposed on the preview object');
    assert.equal(insertedRow.lrnFingerprint, fingerprint, 'the submission row uses the transaction scoped preview fingerprint');
    assert.equal(calls.some(({ statement, values }) => statement.includes('FROM grade_import_preview_rows')
      && values.previewId === PREVIEW_ID), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('teacher upload, preview, durable submission, and registrar approval routes enforce CSRF and role boundaries', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const users = [
    { id: 7, email: 'teacher@example.edu', password_hash: passwordHash, role: 'teacher', is_active: true },
    { id: 11, email: 'registrar@example.edu', password_hash: passwordHash, role: 'registrar', is_active: true }
  ];
  const workbookPath = path.join(__dirname, 'fixtures/grade-import/corrected-mini.xlsx');
  const workbookBytes = await fs.readFile(workbookPath);
  const downloadedWorkbook = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-teacher-http-'));
  const privateWorkbookPath = path.join(downloadedWorkbook, 'private.xlsx');
  await fs.writeFile(privateWorkbookPath, workbookBytes, { mode: 0o600 });
  const calls = [];
  const assignment = {
    assignment_id: 12, academic_term_id: 3, section_id: 4, subject_id: 77,
    school_year: '2026-2027', term: 'Term 1', section_name: 'STEM A', grade_level: 'Grade 11',
    subject_code: 'ENG11', subject_name: 'Oral Communication', roster: [{ student_no: 'S-44', first_name: 'Jamie', last_name: 'Garcia' }],
    latest_submission_id: null, latest_submission_status: null, latest_decision_reason: null, latest_revision_number: null
  };
  const context = { key: 'term-context-key', academic_term_id: 3, school_year: '2026-2027', grade_level: 'Grade 11',
    section_name: 'STEM A', subject_id: 77, subject_code: 'ENG11', subject_name: 'Oral Communication' };
  const gradeImportService = {
    async listImportContexts(actorId) { return actorId === 7 ? [context] : []; },
    async createPreview(input) { calls.push(['preview', input.originalFilename, input.buffer.length]); return HTTP_PREVIEW; },
    async getPreview() { return HTTP_PREVIEW; },
    async confirmPreview(input) { calls.push(['approve', input.actorId, input.submissionId, input.decisions]); return { inserted: 4 }; }
  };
  const teacherGradeSubmissionService = {
    async listTeacherAssignments(actorId) { calls.push(['assignments', actorId]); return [assignment]; },
    async getTeacherAssignment(actorId, assignmentId) { calls.push(['assignment', actorId, assignmentId]); return assignment; },
    async stageWorkbook(actorId, assignmentId, previewId, _sessionId, buffer) { calls.push(['stage', actorId, assignmentId, previewId, buffer.length]); },
    async getStagedWorkbook(actorId, assignmentId, previewId, _sessionId) { calls.push(['staged', actorId, assignmentId, previewId]); return Buffer.from(workbookBytes); },
    async clearStagedWorkbook(previewId) { calls.push(['clear', previewId]); },
    async submitPreview(input) { calls.push(['submit', input.actorId, input.assignmentId, input.preview.originalFilename]); return SUBMISSION_ID; },
    async readSubmission(actorId, submissionId, access) {
      calls.push(['read', actorId, submissionId, access]);
      if (submissionId !== SUBMISSION_ID) throw new TeacherGradeSubmissionError('Grade submission not found.', 404);
      return { ...HTTP_SUBMISSION, id: SUBMISSION_ID };
    },
    async getWorkbook(actorId, submissionId, access) {
      calls.push(['download', actorId, submissionId, access]);
      return { filePath: privateWorkbookPath, filename: 'grades.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    },
    async listReviewQueue(actorId) { calls.push(['queue', actorId]); return [{ ...HTTP_SUBMISSION, first_name: 'Jamie', last_name: 'Garcia' }]; },
    async decideSubmission(actorId, submissionId, decision, reason) { calls.push(['decision', actorId, submissionId, decision, reason]); }
  };
  const app = createApp({
    databasePool: authPool(users),
    environment: { nodeEnv: 'development', devPasswordOnlyLogin: true, sessionSecret: HTTP_SECRET },
    gradeImportService, teacherGradeSubmissionService
  });
  try {
    await withServer(app, async (baseUrl) => {
      const teacherCookie = await signIn(baseUrl, 'teacher@example.edu');
      const classOverview = await fetch(`${baseUrl}/teacher`, { headers: { cookie: teacherCookie } });
      const classOverviewHtml = await classOverview.text();
      assert.equal(classOverview.status, 200, classOverviewHtml);
      assert.match(classOverviewHtml, /My classes/);
      assert.match(classOverviewHtml, /Open class/);

      const gradeSelection = await fetch(`${baseUrl}/teacher/grades`, { headers: { cookie: teacherCookie } });
      const gradeSelectionHtml = await gradeSelection.text();
      assert.equal(gradeSelection.status, 200, gradeSelectionHtml);
      assert.match(gradeSelectionHtml, /<h1>Submit grades<\/h1>/);
      assert.match(gradeSelectionHtml, /Classes ready for submission/);
      assert.match(gradeSelectionHtml, /href="\/teacher\/grades\/12"/);
      assert.match(gradeSelectionHtml, /Upload corrected workbook/);
      assert.match(gradeSelectionHtml, /href="\/teacher\/grades" aria-current="page"/);
      const uploadPage = await fetch(`${baseUrl}/teacher/grades/12`, { headers: { cookie: teacherCookie } });
      assert.equal(uploadPage.status, 200);
      const uploadHtml = await uploadPage.text();
      const token = csrfFrom(uploadHtml);
      const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const missingCsrf = new FormData();
      missingCsrf.set('workbook', new Blob([workbookBytes], { type: mime }), 'grades.xlsx');
      assert.equal((await fetch(`${baseUrl}/teacher/grades/12/preview`, {
        method: 'POST', headers: { cookie: teacherCookie }, body: missingCsrf
      })).status, 403);
      assert.equal(calls.some(([action]) => action === 'preview'), false);

      const workbookForm = new FormData();
      workbookForm.set('_csrf', token);
      workbookForm.set('workbook', new Blob([workbookBytes], { type: mime }), 'grades.xlsx');
      const previewResponse = await fetch(`${baseUrl}/teacher/grades/12/preview`, {
        method: 'POST', headers: { cookie: teacherCookie }, body: workbookForm
      });
      assert.equal(previewResponse.status, 200);
      const previewHtml = await previewResponse.text();
      assert.match(previewHtml, /No grades are written until the registrar approves it/);
      assert.match(previewHtml, /Jamie Garcia/);
      const submit = await fetch(`${baseUrl}/teacher/grades/12/submit`, {
        method: 'POST', redirect: 'manual', headers: { cookie: teacherCookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrfFrom(previewHtml), previewId: PREVIEW_ID })
      });
      assert.equal(submit.status, 303);
      assert.equal(submit.headers.get('location'), `/teacher/grades/submissions/${SUBMISSION_ID}`);
      assert.ok(calls.some(([action, actorId]) => action === 'submit' && actorId === 7));
      const ownSubmission = await fetch(`${baseUrl}/teacher/grades/submissions/${SUBMISSION_ID}`, { headers: { cookie: teacherCookie } });
      assert.equal(ownSubmission.status, 200);
      const download = await fetch(`${baseUrl}/teacher/grades/submissions/${SUBMISSION_ID}/workbook`, { headers: { cookie: teacherCookie } });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('cache-control'), 'private, no-store');

      const registrarCookie = await signIn(baseUrl, 'registrar@example.edu');
      const queue = await fetch(`${baseUrl}/registrar/grade-submissions`, { headers: { cookie: registrarCookie } });
      assert.equal(queue.status, 200);
      assert.match(await queue.text(), /grades\.xlsx/);
      const review = await fetch(`${baseUrl}/registrar/grade-submissions/${SUBMISSION_ID}`, { headers: { cookie: registrarCookie } });
      assert.equal(review.status, 200);
      const reviewHtml = await review.text();
      const approval = await fetch(`${baseUrl}/registrar/grade-submissions/${SUBMISSION_ID}/decision`, {
        method: 'POST', redirect: 'manual', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrfFrom(reviewHtml), decision: 'approve', includeRow_17: 'yes' })
      });
      assert.equal(approval.status, 303);
      const approvedCall = calls.find(([action]) => action === 'approve');
      assert.equal(approvedCall[1], 11);
      assert.equal(approvedCall[2], SUBMISSION_ID);
      assert.equal(approvedCall[3][0].include, true);

      const studentCookie = await signIn(baseUrl, 'teacher@example.edu');
      assert.equal((await fetch(`${baseUrl}/registrar/grade-submissions`, { headers: { cookie: studentCookie } })).status, 403);
    });
  } finally {
    await fs.rm(downloadedWorkbook, { recursive: true, force: true });
  }
});
