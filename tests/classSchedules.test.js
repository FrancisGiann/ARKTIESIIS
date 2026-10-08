const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const ejs = require('ejs');
const { createApp } = require('../src/app');
const { ClassScheduleError, createClassScheduleService } = require('../src/services/classScheduleService');
const { createPreviewController } = require('../public/js/registrar-schedule-conflicts');
const { formatStudentPlacement } = require('../src/utils/formatStudentPlacement');

const testEnvironment = {
  nodeEnv: 'development',
  devPasswordOnlyLogin: true,
  sessionSecret: 'class-schedule-test-session-secret'
};

function makeAuthPool(role) {
  const user = {
    id: 7,
    email: `${role}@example.edu`,
    password_hash: bcrypt.hashSync('Correct-Horse-Battery-12', 4),
    role,
    is_active: true,
    updated_at_fingerprint: '',
    must_change_password: false,
    auth_session_version: ''
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

function cookieFrom(response) {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'expected a session cookie');
  return value.split(';', 1)[0];
}

function csrfFromHtml(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'expected a form CSRF token');
  return match[1];
}

async function postForm(baseUrl, path, cookie, values) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values)
  });
}

async function signIn(baseUrl, role) {
  const loginPage = await fetch(`${baseUrl}/login`);
  const cookie = cookieFrom(loginPage);
  const token = csrfFromHtml(await loginPage.text());
  const result = await postForm(baseUrl, '/login', cookie, {
    _csrf: token, email: `${role}@example.edu`, password: 'Correct-Horse-Battery-12'
  });
  assert.equal(result.status, 303);
  return cookieFrom(result);
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function scheduleViewData(overrides = {}) {
  return {
    title: 'Class schedules', csrfToken: 'test-token', notice: null, error: null, conflicts: [], conflictsTruncated: false, contextNotice: null,
    values: {}, editScheduleId: null, focusScheduleId: null, showCreate: false, terms: [{ id: 6, school_year: '2026-2027', term: 'First', is_current: true }],
    sections: [{ id: 12, name: 'STEM A', grade_level: 'Grade 11' }], academicTermId: 6,
    selectedSectionId: null, selectedAssignmentId: null,
    assignments: [
      { id: 44, grade_level: 'Grade 11', section_name: 'STEM A', subject_code: 'OCOM', teacher_name: 'Jamie Lee' },
      { id: 45, grade_level: 'Grade 11', section_name: 'STEM A', subject_code: 'STAT', teacher_name: 'Jamie Lee' }
    ],
    schedules: [
      { id: 72, assignment_id: 44, section_id: 12, day_of_week: 2, start_time: '11:00', end_time: '12:00', room: 'A12', assignment_is_active: true,
        grade_level: 'Grade 11', section_name: 'STEM A', school_year: '2026-2027', term: 'First', subject_code: 'OCOM', subject_name: 'Oral Communication', teacher_name: 'Jamie Lee' },
      { id: 73, assignment_id: 45, section_id: 12, day_of_week: 1, start_time: '10:00', end_time: '11:00', room: 'A13', assignment_is_active: true,
        grade_level: 'Grade 11', section_name: 'STEM A', school_year: '2026-2027', term: 'First', subject_code: 'STAT', subject_name: 'Statistics and Probability', teacher_name: 'Jamie Lee' },
      { id: 74, assignment_id: 44, section_id: 12, day_of_week: 1, start_time: '08:00', end_time: '09:00', room: 'A12', assignment_is_active: true,
        grade_level: 'Grade 11', section_name: 'STEM A', school_year: '2026-2027', term: 'First', subject_code: 'OCOM', subject_name: 'Oral Communication', teacher_name: 'Jamie Lee' },
      { id: 75, assignment_id: 44, section_id: 13, day_of_week: 1, start_time: '09:00', end_time: '10:00', room: null, assignment_is_active: false,
        grade_level: 'Grade 11', section_name: 'STEM B', school_year: '2026-2027', term: 'First', subject_code: 'BIO', subject_name: 'Biology', teacher_name: 'Taylor Cruz' }
    ],
    formatStudentPlacement,
    ...overrides
  };
}

function renderScheduleView(overrides = {}) {
  return ejs.renderFile(path.join(__dirname, '../views/registrar/schedules.ejs'), scheduleViewData(overrides));
}

function fakeSql() {
  return {
    MAX: 'MAX',
    Int: 'Int',
    TinyInt: 'TinyInt',
    VarChar: (length) => `VarChar(${length})`,
    NVarChar: (length) => `NVarChar(${length})`,
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }
  };
}

function conflictRow(overrides = {}) {
  return {
    id: 91, day_of_week: 2, start_time: '10:30', end_time: '11:30', room: 'Room 12',
    grade_level: 'Grade 11', section_name: 'STEM B', subject_code: 'BIO', subject_name: 'Biology',
    teacher_name: 'Taylor Cruz', section_conflict: 1, teacher_conflict: 1, room_conflict: 1,
    ...overrides
  };
}

function scheduleDatabase({ overlap = false, assignment = true } = {}) {
  const state = { queries: [], isolation: null, committed: false, rolledBack: false };
  const transactionFactory = () => ({
    async begin(isolation) { state.isolation = isolation; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          state.queries.push({ statement, values: { ...values } });
          if (statement.includes("role = 'registrar'")) return { recordset: [{ id: 5 }] };
          if (statement.includes('FROM teacher_assignments AS assignment')) {
            return { recordset: assignment ? [{ id: 44, section_id: 12, teacher_id: 19, academic_term_id: 6 }] : [] };
          }
          if (statement.includes('SELECT schedule.id') && statement.includes('assigned_class.academic_term_id')) return { recordset: overlap ? [conflictRow()] : [] };
          if (statement.includes('INSERT INTO class_schedules')) return { insertId: 92 };
          if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
          throw new Error(`Unexpected schedule query: ${statement}`);
        }
      };
    },
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; }
  });
  const service = createClassScheduleService({ getPool: async () => ({}), sql: fakeSql(), transactionFactory });
  return { service, state };
}

function previewDatabase({ conflicts = [], assignment = true, registrar = true, existingSchedule = true } = {}) {
  const state = { queries: [], writes: 0 };
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          state.queries.push({ statement, values: { ...values } });
          if (/^\s*INSERT|^\s*UPDATE|^\s*DELETE/i.test(statement)) state.writes += 1;
          if (statement.includes('WHERE id = @actorId')) return { recordset: registrar ? [{ id: 5 }] : [] };
          if (statement.includes('FROM class_schedules WHERE id = @scheduleId')) {
            return { recordset: existingSchedule ? [{ id: Number(values.scheduleId) }] : [] };
          }
          if (statement.includes('FROM teacher_assignments AS assignment')) {
            return { recordset: assignment ? [{ id: 44, section_id: 12, teacher_id: 19, academic_term_id: 6 }] : [] };
          }
          if (statement.includes('FROM class_schedules AS schedule')) return { recordset: conflicts };
          throw new Error(`Unexpected preview query: ${statement}`);
        }
      };
    }
  };
  const service = createClassScheduleService({ getPool: async () => pool, sql: fakeSql() });
  return { service, state };
}

function workspaceService({ sectionId = 12, assignmentId = 44 } = {}) {
  const calls = [];
  const currentTerm = { id: 6, school_year: '2026-2027', term: 'First', is_current: true };
  const oldTerm = { id: 19, school_year: '2025-2026', term: 'Second', is_current: false };
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          const call = { statement, values: { ...values } };
          calls.push(call);
          if (statement.includes('SELECT id FROM users WHERE id = @actorId')) return { recordset: [{ id: 5 }] };
          if (statement.includes('FROM academic_terms ORDER BY')) return { recordset: [currentTerm, oldTerm] };
          if (statement.includes('FROM sections AS section')) {
            return { recordset: values.academicTermId === 6
              ? [{ id: sectionId, name: 'STEM A', grade_level: 'Grade 11', academic_term_id: 6 }]
              : [{ id: 91, name: 'Old A', grade_level: 'Grade 12', academic_term_id: 19 }] };
          }
          if (statement.includes('FROM teacher_assignments AS assignment')) {
            const termId = values.academicTermId;
            const section = values.sectionId;
            const rows = termId === 6 ? [{ id: assignmentId, academic_term_id: 6, section_id: sectionId,
              section_name: 'STEM A', grade_level: 'Grade 11', subject_id: 3, subject_code: 'OCOM',
              subject_name: 'Oral Communication', teacher_id: 8, teacher_name: 'Jamie Lee' }] : [];
            return { recordset: section ? rows.filter((row) => row.section_id === section) : rows };
          }
          if (statement.includes('FROM class_schedules AS schedule')) return { recordset: [{
            id: 72, assignment_id: assignmentId, academic_term_id: values.academicTermId,
            section_id: values.sectionId, day_of_week: 1, start_time: '08:00', end_time: '09:00',
            assignment_is_active: true
          }] };
          throw new Error(`Unexpected workspace query: ${statement}`);
        }
      };
    }
  };
  const service = createClassScheduleService({ getPool: async () => pool, sql: fakeSql() });
  return { service, calls };
}

test('schedule save is serializable and only checks active assignments in the selected term for overlap', async () => {
  const { service, state } = scheduleDatabase();
  const id = await service.saveSchedule(5, null, {
    assignmentId: '44', dayOfWeek: '2', startTime: '10:00', endTime: '11:00', room: 'Room 12'
  });

  assert.equal(id, 92);
  assert.equal(state.isolation, 'SERIALIZABLE');
  assert.equal(state.committed, true);
  assert.equal(state.rolledBack, false);
  const conflictCheck = state.queries.find(({ statement }) => statement.includes('SELECT schedule.id') && statement.includes('assigned_class.academic_term_id'));
  assert.ok(conflictCheck);
  assert.match(conflictCheck.statement, /assigned_class\.academic_term_id = @academicTermId/);
  assert.match(conflictCheck.statement, /assigned_class\.is_active = 1/);
  assert.equal(conflictCheck.values.academicTermId, 6);
  assert.equal(conflictCheck.values.assignmentId, 44);
  assert.equal(conflictCheck.values.dayOfWeek, 2);
});

test('same-term section, teacher, or room overlap rejects the schedule and rolls the transaction back', async () => {
  const { service, state } = scheduleDatabase({ overlap: true });
  await assert.rejects(service.saveSchedule(5, null, {
    assignmentId: '44', dayOfWeek: '2', startTime: '10:30', endTime: '11:30', room: 'Room 12'
  }), (error) => {
    assert.ok(error instanceof ClassScheduleError);
    assert.equal(error.status, 409);
    assert.deepEqual(error.conflicts[0].reasons, ['same section', 'same teacher', 'same room']);
    assert.match(error.conflicts[0].summary, /Tuesday, 10:30–11:30: BIO · Biology \(Grade 11 · STEM B\); Teacher: Taylor Cruz; Room: Room 12; shared: same section, same teacher, same room/);
    return true;
  });

  assert.equal(state.committed, false);
  assert.equal(state.rolledBack, true);
  assert.equal(state.queries.some(({ statement }) => statement.includes('INSERT INTO class_schedules')), false);
  assert.equal(state.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
});

test('read-only conflict preview reports a room-only overlap in another section with the matched database dimensions', async () => {
  const { service, state } = previewDatabase({
    conflicts: [conflictRow({ section_conflict: 0, teacher_conflict: 0, room_conflict: 1 })]
  });
  const preview = await service.previewScheduleConflicts(5, null, {
    assignmentId: '44', termId: '6', filterSectionId: '12', filterAssignmentId: '44',
    dayOfWeek: '2', startTime: '10:00', endTime: '11:00', room: 'Room 12'
  });

  assert.equal(preview.conflict, true);
  assert.equal(preview.roomChecked, true);
  assert.deepEqual(preview.conflicts[0].reasons, ['same room']);
  assert.match(preview.conflicts[0].summary, /Grade 11 · STEM B/);
  assert.match(preview.conflicts[0].summary, /Room: Room 12; shared: same room/);
  const conflictQuery = state.queries.find(({ statement }) => statement.includes('FROM class_schedules AS schedule'));
  assert.ok(conflictQuery);
  assert.equal(conflictQuery.values.academicTermId, 6);
  assert.equal(conflictQuery.values.sectionId, 12);
  assert.equal(conflictQuery.values.dayOfWeek, 2);
  assert.equal(conflictQuery.values.room, 'Room 12');
  assert.match(conflictQuery.statement, /assigned_class\.academic_term_id = @academicTermId/);
  assert.match(conflictQuery.statement, /assigned_class\.is_active = 1/);
  assert.match(conflictQuery.statement, /schedule\.day_of_week = @dayOfWeek/);
  assert.match(conflictQuery.statement, /schedule\.id <> COALESCE\(@scheduleId, -1\)/);
  assert.match(conflictQuery.statement, /schedule\.start_time < @endTime AND schedule\.end_time > @startTime/);
  assert.match(conflictQuery.statement, /schedule\.room = @room/);
  assert.match(conflictQuery.statement, /LIMIT 11/);
  assert.equal(conflictQuery.statement.includes('assigned_class.section_id = @contextSectionId'), false);
  assert.equal(state.writes, 0);
});

test('preview preserves edit exclusion, strict adjacent-time boundaries, active term/day scope, and skips room matching when blank', async () => {
  const { service, state } = previewDatabase();
  const preview = await service.previewScheduleConflicts(5, '77', {
    assignmentId: '44', termId: '6', filterSectionId: '12', filterAssignmentId: '44',
    dayOfWeek: '1', startTime: '10:00', endTime: '11:00', room: ''
  });

  assert.equal(preview.conflict, false);
  assert.equal(preview.roomChecked, false);
  assert.match(preview.message, /Room conflicts were not checked because no room was entered/);
  const conflictQuery = state.queries.find(({ statement }) => statement.includes('FROM class_schedules AS schedule'));
  assert.equal(conflictQuery.values.scheduleId, 77);
  assert.equal(conflictQuery.values.dayOfWeek, 1);
  assert.equal(conflictQuery.values.academicTermId, 6);
  assert.equal(conflictQuery.values.room, null);
  assert.match(conflictQuery.statement, /schedule\.start_time < @endTime AND schedule\.end_time > @startTime/);
  assert.match(conflictQuery.statement, /assigned_class\.is_active = 1/);
  assert.match(conflictQuery.statement, /schedule\.day_of_week = @dayOfWeek/);
  assert.match(conflictQuery.statement, /@room IS NOT NULL AND schedule\.room = @room/);
  assert.match(state.queries.find(({ statement }) => statement.includes('FROM class_schedules WHERE id'))
    .statement, /SELECT id FROM class_schedules WHERE id = @scheduleId/);
});

test('preview bounds its result and reports when additional conflicts were omitted', async () => {
  const conflicts = Array.from({ length: 11 }, (_, index) => conflictRow({ id: 100 + index }));
  const { service } = previewDatabase({ conflicts });
  const preview = await service.previewScheduleConflicts(5, null, {
    assignmentId: '44', dayOfWeek: '2', startTime: '10:00', endTime: '11:00', room: 'Room 12'
  });

  assert.equal(preview.conflicts.length, 10);
  assert.equal(preview.conflictsTruncated, true);
  assert.match(preview.message, /More matching class times were found/);
});

test('preview rejects inactive assignments and malformed schedules before running conflict checks', async () => {
  const { service, state } = previewDatabase({ assignment: false });
  await assert.rejects(service.previewScheduleConflicts(5, null, {
    assignmentId: '44', dayOfWeek: '2', startTime: '10:00', endTime: '11:00'
  }), (error) => error instanceof ClassScheduleError && /Choose an active teacher assignment/.test(error.message));
  assert.equal(state.queries.some(({ statement }) => statement.includes('FROM class_schedules AS schedule')), false);
  assert.equal(state.writes, 0);

  const malformed = previewDatabase();
  await assert.rejects(malformed.service.previewScheduleConflicts(5, null, {
    assignmentId: '44', dayOfWeek: '2', startTime: '11:00', endTime: '10:00'
  }), (error) => error instanceof ClassScheduleError && /valid class time/.test(error.message));
  assert.equal(malformed.state.queries.length, 0);
});

test('preview verifies an active registrar, the edited schedule, and selected assignment context', async () => {
  const input = {
    assignmentId: '44', termId: '6', filterSectionId: '12', filterAssignmentId: '44',
    dayOfWeek: '2', startTime: '10:00', endTime: '11:00'
  };
  const inactiveRegistrar = previewDatabase({ registrar: false });
  await assert.rejects(inactiveRegistrar.service.previewScheduleConflicts(5, null, input),
    (error) => error instanceof ClassScheduleError && error.status === 403);
  assert.equal(inactiveRegistrar.state.queries.length, 1);

  const missingSchedule = previewDatabase({ existingSchedule: false });
  await assert.rejects(missingSchedule.service.previewScheduleConflicts(5, '77', input),
    (error) => error instanceof ClassScheduleError && error.status === 404);
  assert.equal(missingSchedule.state.queries.some(({ statement }) => statement.includes('FROM teacher_assignments AS assignment')), false);

  const wrongSection = previewDatabase();
  await assert.rejects(wrongSection.service.previewScheduleConflicts(5, null, { ...input, filterSectionId: '99' }),
    (error) => error instanceof ClassScheduleError && error.status === 409);
  assert.equal(wrongSection.state.queries.some(({ statement }) => statement.includes('FROM class_schedules AS schedule')), false);

  const wrongTerm = previewDatabase();
  await assert.rejects(wrongTerm.service.previewScheduleConflicts(5, null, { ...input, termId: '19', filterSectionId: '' }),
    (error) => error instanceof ClassScheduleError && error.status === 409);
  assert.equal(wrongTerm.state.queries.some(({ statement }) => statement.includes('FROM class_schedules AS schedule')), false);
});

test('changing fields while a preview is pending clears it and ignores the late response', async () => {
  let finishFetch;
  const states = [];
  const controller = createPreviewController({
    fetchImpl: () => new Promise((resolve) => { finishFetch = resolve; }),
    AbortControllerImpl: AbortController,
    onResult: (state) => states.push(state),
    timeoutMs: 1000
  });

  const pending = controller.check('/preview', { startTime: '10:00' });
  assert.equal(states.at(-1).state, 'checking');
  controller.invalidate();
  assert.equal(states.at(-1).state, 'cleared');
  finishFetch({ ok: true, async json() { return { conflict: false, conflicts: [], message: 'No conflict' }; } });
  await pending;

  assert.equal(states.some((state) => state.state === 'complete'), false);
  assert.equal(states.at(-1).state, 'cleared');
});

test('a newer conflict preview cannot be overwritten by an older response', async () => {
  const pendingFetches = [];
  const states = [];
  const controller = createPreviewController({
    fetchImpl: () => new Promise((resolve) => pendingFetches.push(resolve)),
    AbortControllerImpl: AbortController,
    onResult: (state) => states.push(state),
    timeoutMs: 1000
  });

  const older = controller.check('/preview', { startTime: '10:00' });
  const newer = controller.check('/preview', { startTime: '11:00' });
  pendingFetches[1]({ ok: true, async json() { return { conflict: false, conflicts: [], message: 'Current slot is clear' }; } });
  await newer;
  pendingFetches[0]({ ok: true, async json() { return { conflict: true, conflicts: [{ summary: 'Outdated conflict' }] }; } });
  await older;

  const results = states.filter((state) => state.state === 'complete');
  assert.equal(results.length, 1);
  assert.equal(results[0].result.message, 'Current slot is clear');
});

test('registrar workspace defaults to the marked current term and scopes class and schedule filters', async () => {
  const { service, calls } = workspaceService();
  const workspace = await service.listRegistrarWorkspace(5, { sectionId: '12', assignmentId: '44' });

  assert.equal(workspace.academicTermId, 6);
  assert.equal(workspace.selectedSectionId, 12);
  assert.equal(workspace.selectedAssignmentId, 44);
  assert.equal(workspace.assignments.length, 1);
  assert.equal(workspace.schedules.length, 1);
  const terms = calls.find(({ statement }) => statement.includes('FROM academic_terms ORDER BY'));
  assert.match(terms.statement, /is_current DESC/);
  const assignments = calls.find(({ statement }) => statement.includes('FROM teacher_assignments AS assignment'));
  assert.equal(assignments.values.academicTermId, 6);
  assert.equal(assignments.values.sectionId, 12);
  const schedules = calls.find(({ statement }) => statement.includes('FROM class_schedules AS schedule'));
  assert.equal(schedules.values.academicTermId, 6);
  assert.equal(schedules.values.sectionId, 12);
  assert.equal(schedules.values.assignmentId, 44);
  assert.match(schedules.statement, /assignment\.academic_term_id = @academicTermId/);
  assert.match(schedules.statement, /assignment\.section_id = @sectionId/);
  assert.match(schedules.statement, /assignment\.id = @assignmentId/);
});

test('query context from another term is cleared and cannot expose another term section', async () => {
  const { service, calls } = workspaceService({ sectionId: 12 });
  const workspace = await service.listRegistrarWorkspace(5, { termId: '6', sectionId: '91', assignmentId: '44' });

  assert.equal(workspace.academicTermId, 6);
  assert.equal(workspace.selectedSectionId, null);
  assert.equal(workspace.selectedAssignmentId, null);
  assert.match(workspace.contextNotice, /different term/);
  const sectionQuery = calls.find(({ statement }) => statement.includes('FROM sections AS section'));
  assert.equal(sectionQuery.values.academicTermId, 6);
  const assignmentQuery = calls.find(({ statement }) => statement.includes('FROM teacher_assignments AS assignment'));
  assert.equal(assignmentQuery.values.academicTermId, 6);
  assert.equal(assignmentQuery.values.sectionId, null);
  const scheduleQuery = calls.find(({ statement }) => statement.includes('FROM class_schedules AS schedule'));
  assert.equal(scheduleQuery.values.academicTermId, 6);
  assert.equal(scheduleQuery.values.sectionId, null);
  assert.equal(scheduleQuery.values.assignmentId, null);
});

test('schedule save rejects a class that does not match the posted section context', async () => {
  const { service, state } = scheduleDatabase();
  await assert.rejects(service.saveSchedule(5, null, {
    assignmentId: '44', termId: '6', filterSectionId: '99',
    dayOfWeek: '2', startTime: '10:00', endTime: '11:00'
  }), (error) => error instanceof ClassScheduleError && error.status === 409);

  assert.equal(state.rolledBack, true);
  assert.equal(state.queries.some(({ statement }) => statement.includes('SELECT schedule.id') && statement.includes('assigned_class.academic_term_id')), false);
  assert.equal(state.queries.some(({ statement }) => statement.includes('INSERT INTO class_schedules')), false);
});

test('preview endpoint is registrar-only, CSRF protected, private, and read-only', async () => {
  const previewCalls = [];
  const saveCalls = [];
  const conflictSummary = 'Tuesday, 10:30–11:30: BIO · Biology (Grade 11 · STEM B); Teacher: Taylor Cruz; Room: Room 12; shared: same room.';
  const classScheduleService = {
    async listRegistrarWorkspace(actorId) {
      assert.equal(Number(actorId), 7);
      return {
        terms: [{ id: 6, school_year: '2026-2027', term: 'First', is_current: true }],
        sections: [{ id: 12, name: 'STEM A', grade_level: 'Grade 11' }], academicTermId: 6,
        selectedSectionId: null, selectedAssignmentId: null, contextNotice: null,
        assignments: [{ id: 44, grade_level: 'Grade 11', section_name: 'STEM A', subject_code: 'OCOM', teacher_name: 'Jamie Lee' }],
        schedules: []
      };
    },
    async previewScheduleConflicts(...args) {
      previewCalls.push(args);
      return {
        conflict: true,
        roomChecked: true,
        message: 'This class time conflicts with an existing schedule. Saving will check again.',
        conflicts: [{ summary: conflictSummary }],
        conflictsTruncated: false
      };
    },
    async saveSchedule(...args) {
      saveCalls.push(args);
      throw new ClassScheduleError('This class time conflicts with an existing schedule.', 409, {
        conflicts: [{ summary: conflictSummary }]
      });
    }
  };
  const app = createApp({ databasePool: makeAuthPool('registrar'), environment: testEnvironment, classScheduleService });
  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/registrar/schedules`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const token = csrfFromHtml(await page.text());

    const noToken = await fetch(`${baseUrl}/registrar/schedules/conflicts/preview`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(noToken.status, 403);
    assert.equal(previewCalls.length, 0);

    const payload = {
      _csrf: token, scheduleId: '72', assignmentId: '44', termId: '6',
      filterSectionId: '12', filterAssignmentId: '44', dayOfWeek: '2',
      startTime: '10:00', endTime: '11:00', room: 'Room 12'
    };
    const response = await fetch(`${baseUrl}/registrar/schedules/conflicts/preview`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = await response.json();
    assert.equal(body.conflict, true);
    assert.match(body.conflicts[0].summary, /STEM B/);
    assert.deepEqual(previewCalls, [[7, '72', payload]]);

    const save = await postForm(baseUrl, '/registrar/schedules', cookie, {
      _csrf: token, termId: '6', filterSectionId: '', filterAssignmentId: '',
      assignmentId: '44', dayOfWeek: '2', startTime: '10:00', endTime: '11:00', room: 'Room 12'
    });
    assert.equal(save.status, 409);
    const html = await save.text();
    assert.match(html, /This class time conflicts with an existing schedule/);
    assert.match(html, new RegExp(conflictSummary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /name="startTime" type="time" required value="10:00"/);
    assert.match(html, /name="endTime" type="time" required value="11:00"/);
    assert.match(html, /name="room" maxlength="80" value="Room 12"/);
    assert.deepEqual(saveCalls[0], [7, null, {
      _csrf: token, termId: '6', filterSectionId: '', filterAssignmentId: '',
      assignmentId: '44', dayOfWeek: '2', startTime: '10:00', endTime: '11:00', room: 'Room 12'
    }]);
  });

  const protectedCalls = [];
  const studentService = {
    async previewScheduleConflicts(...args) { protectedCalls.push(args); return { conflict: false, conflicts: [] }; }
  };
  await withServer(createApp({ databasePool: makeAuthPool('student'), environment: testEnvironment, classScheduleService: studentService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const denied = await fetch(`${baseUrl}/registrar/schedules/conflicts/preview`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(denied.status, 403);
    assert.equal(protectedCalls.length, 0);
  });
});

test('registrar weekly schedule renders ordered section and weekday groups with intact edit and remove forms', async () => {
  const html = await renderScheduleView();

  assert.match(html, /<details class="schedule-create-disclosure"\s*>/);
  assert.doesNotMatch(html, /<details class="schedule-create-disclosure" open>/);
  assert.doesNotMatch(html, /<table\b/);
  assert.match(html, /class="schedule-section-grid" aria-label="Class times grouped by section"/);
  assert.equal((html.match(/class="schedule-section-card"/g) || []).length, 2);
  assert.match(html, /Grade 11 · STEM A/);
  assert.match(html, /Grade 11 · STEM B/);
  const rowIds = [...html.matchAll(/<li class="schedule-entry" id="schedule-(\d+)"/g)].map((match) => match[1]);
  assert.deepEqual(rowIds, ['74', '73', '72', '75'], 'entries sort by section, then day and start time');
  assert.match(html, /<details class="schedule-day"\s*>[\s\S]*?<summary class="schedule-day__summary"><strong>Monday<\/strong>[\s\S]*?08:00–11:00/);
  assert.match(html, /Oral Communication/);
  assert.match(html, /Teacher: Jamie Lee/);
  assert.match(html, /Room: A12/);
  assert.doesNotMatch(html, /schedule-entry__status--active|>Active<\/span>/);
  assert.equal((html.match(/schedule-entry__status--revoked/g) || []).length, 1);
  assert.match(html, /<details class="schedule-edit"\s*>\s*<summary>Edit class time<\/summary>/);
  assert.match(html, /<form method="post" action="\/registrar\/schedules\/72" data-schedule-conflict-form/);
  assert.match(html, /<form method="post" action="\/registrar\/schedules\/72\/delete" class="schedule-delete-form">/);
  assert.match(html, /name="_csrf" value="test-token"/);
  assert.match(html, /name="filterSectionId" value=""/);
  assert.match(html, /name="filterAssignmentId" value=""/);
  assert.match(html, /focusScheduleId=72#schedule-72">Cancel<\/a>/);

  const revokedRow = html.match(/<li class="schedule-entry" id="schedule-75">([\s\S]*?)<\/li>/)?.[1] || '';
  assert.ok(revokedRow);
  assert.match(revokedRow, /schedule-entry__overview--revoked/);
  assert.match(revokedRow, /schedule-entry__status--revoked">Assignment revoked/);
  assert.doesNotMatch(revokedRow, /<details|method="post"/);
  const activeRow = html.match(/<li class="schedule-entry" id="schedule-72">([\s\S]*?)<\/li>/)?.[1] || '';
  assert.ok(activeRow);
  assert.match(activeRow, /class="schedule-entry__overview"/);
  assert.doesNotMatch(activeRow, /schedule-entry__overview--revoked|schedule-entry__status/);
});

test('schedule focus opens the containing weekday so edit deep links remain visible', async () => {
  const html = await renderScheduleView({ focusScheduleId: 72 });
  const tuesday = html.match(/<details class="schedule-day" open>([\s\S]*?)<\/details>/);
  assert.ok(tuesday);
  assert.match(tuesday[1], /<summary class="schedule-day__summary"><strong>Tuesday<\/strong>/);
  assert.match(tuesday[1], /id="schedule-72"/);
  assert.match(html, /<details class="schedule-day"\s*>\s*<summary class="schedule-day__summary"><strong>Monday<\/strong>/);
});

test('class time creation disclosure opens for an intentional deep link or validation error', async () => {
  const linkedHtml = await renderScheduleView({ showCreate: true });
  assert.match(linkedHtml, /<details class="schedule-create-disclosure" open>/);
  const errorHtml = await renderScheduleView({ error: 'Choose a valid class.' });
  assert.match(errorHtml, /<details class="schedule-create-disclosure" open>/);
});

test('schedule edit remains open with posted values after validation errors and empty schedule has a clear state', async () => {
  const html = await renderScheduleView({
    editScheduleId: 72,
    values: { assignmentId: '45', dayOfWeek: '3', startTime: '11:30', endTime: '12:30', room: 'Lab 8' }
  });
  assert.match(html, /<details class="schedule-edit" open>/);
  assert.match(html, /id="assignment-72" name="assignmentId" required>[\s\S]*?<option value="45" selected>/);
  assert.match(html, /id="day-72" name="dayOfWeek" required>[\s\S]*?<option value="3" selected>Wednesday/);
  assert.match(html, /name="startTime" required value="11:30"/);
  assert.match(html, /name="endTime" required value="12:30"/);
  assert.match(html, /name="room" maxlength="80" value="Lab 8"/);

  const emptyHtml = await renderScheduleView({ schedules: [] });
  assert.match(emptyHtml, /No class times match this context yet/);
  assert.doesNotMatch(emptyHtml, /schedule-section-grid/);
});

test('student schedule binds the authenticated account and only returns currently enrolled subjects', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          return { recordset: [{ id: 8, subject_code: 'OCOM' }] };
        }
      };
    }
  };
  const service = createClassScheduleService({ getPool: async () => pool, sql: fakeSql() });
  const ownSchedule = await service.getOwnStudentSchedule('7');

  assert.deepEqual(ownSchedule, [{ id: 8, subject_code: 'OCOM' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].values.userId, 7);
  assert.match(calls[0].statement, /user_account\.id = @userId/);
  assert.match(calls[0].statement, /enrollment\.enrollment_status = 'enrolled'/);
  assert.match(calls[0].statement, /term\.is_current = 1/);
  assert.match(calls[0].statement, /INNER JOIN student_subjects AS enrolled_subject/);
});
