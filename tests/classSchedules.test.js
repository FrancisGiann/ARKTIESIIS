const test = require('node:test');
const assert = require('node:assert/strict');
const { ClassScheduleError, createClassScheduleService } = require('../src/services/classScheduleService');

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
          if (statement.includes("role = N'registrar'")) return { recordset: [{ id: 5 }] };
          if (statement.includes('FROM dbo.teacher_assignments AS assignment')) {
            return { recordset: assignment ? [{ id: 44, section_id: 12, teacher_id: 19, academic_term_id: 6 }] : [] };
          }
          if (statement.includes('SELECT TOP (1) schedule.id')) return { recordset: overlap ? [{ id: 91 }] : [] };
          if (statement.includes('INSERT INTO dbo.class_schedules')) return { recordset: [{ id: 92 }] };
          if (statement.includes('INSERT INTO dbo.audit_logs')) return { recordset: [] };
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
          if (statement.includes('SELECT id FROM dbo.users WHERE id = @actorId')) return { recordset: [{ id: 5 }] };
          if (statement.includes('FROM dbo.academic_terms ORDER BY')) return { recordset: [currentTerm, oldTerm] };
          if (statement.includes('FROM dbo.sections AS section')) {
            return { recordset: values.academicTermId === 6
              ? [{ id: sectionId, name: 'STEM A', grade_level: 'Grade 11', academic_term_id: 6 }]
              : [{ id: 91, name: 'Old A', grade_level: 'Grade 12', academic_term_id: 19 }] };
          }
          if (statement.includes('FROM dbo.teacher_assignments AS assignment')) {
            const termId = values.academicTermId;
            const section = values.sectionId;
            const rows = termId === 6 ? [{ id: assignmentId, academic_term_id: 6, section_id: sectionId,
              section_name: 'STEM A', grade_level: 'Grade 11', subject_id: 3, subject_code: 'OCOM',
              subject_name: 'Oral Communication', teacher_id: 8, teacher_name: 'Jamie Lee' }] : [];
            return { recordset: section ? rows.filter((row) => row.section_id === section) : rows };
          }
          if (statement.includes('FROM dbo.class_schedules AS schedule')) return { recordset: [{
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
  const conflictCheck = state.queries.find(({ statement }) => statement.includes('SELECT TOP (1) schedule.id'));
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
  assert.equal(state.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.class_schedules')), false);
  assert.equal(state.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);
});

test('registrar workspace defaults to the marked current term and scopes class and schedule filters', async () => {
  const { service, calls } = workspaceService();
  const workspace = await service.listRegistrarWorkspace(5, { sectionId: '12', assignmentId: '44' });

  assert.equal(workspace.academicTermId, 6);
  assert.equal(workspace.selectedSectionId, 12);
  assert.equal(workspace.selectedAssignmentId, 44);
  assert.equal(workspace.assignments.length, 1);
  assert.equal(workspace.schedules.length, 1);
  const terms = calls.find(({ statement }) => statement.includes('FROM dbo.academic_terms ORDER BY'));
  assert.match(terms.statement, /is_current DESC/);
  const assignments = calls.find(({ statement }) => statement.includes('FROM dbo.teacher_assignments AS assignment'));
  assert.equal(assignments.values.academicTermId, 6);
  assert.equal(assignments.values.sectionId, 12);
  const schedules = calls.find(({ statement }) => statement.includes('FROM dbo.class_schedules AS schedule'));
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
  const sectionQuery = calls.find(({ statement }) => statement.includes('FROM dbo.sections AS section'));
  assert.equal(sectionQuery.values.academicTermId, 6);
  const assignmentQuery = calls.find(({ statement }) => statement.includes('FROM dbo.teacher_assignments AS assignment'));
  assert.equal(assignmentQuery.values.academicTermId, 6);
  assert.equal(assignmentQuery.values.sectionId, null);
  const scheduleQuery = calls.find(({ statement }) => statement.includes('FROM dbo.class_schedules AS schedule'));
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
  assert.equal(state.queries.some(({ statement }) => statement.includes('SELECT TOP (1) schedule.id')), false);
  assert.equal(state.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.class_schedules')), false);
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
  assert.match(calls[0].statement, /enrollment\.enrollment_status = N'enrolled'/);
  assert.match(calls[0].statement, /term\.is_current = 1/);
  assert.match(calls[0].statement, /INNER JOIN dbo\.student_subjects AS enrolled_subject/);
});
