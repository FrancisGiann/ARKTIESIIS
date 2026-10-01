const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { ClassScheduleError, createClassScheduleService } = require('../src/services/classScheduleService');
const { formatStudentPlacement } = require('../src/utils/formatStudentPlacement');

function scheduleViewData(overrides = {}) {
  return {
    title: 'Class schedules', csrfToken: 'test-token', notice: null, error: null, contextNotice: null,
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
          if (statement.includes('SELECT schedule.id') && statement.includes('assigned_class.academic_term_id')) return { recordset: overlap ? [{ id: 91 }] : [] };
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
  }), (error) => error instanceof ClassScheduleError && error.status === 409);

  assert.equal(state.committed, false);
  assert.equal(state.rolledBack, true);
  assert.equal(state.queries.some(({ statement }) => statement.includes('INSERT INTO class_schedules')), false);
  assert.equal(state.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
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
  assert.match(html, /<form method="post" action="\/registrar\/schedules\/72">/);
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
