'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HOSTINGER_SEED_MARKER,
  EXPANSION_MARKER,
  REQUIRED_OBJECTS,
  ExpansionError,
  buildExpansionPlan,
  parseOptions,
  validateProductionTarget,
  runExpansion
} = require('../scripts/expand-hostinger-demo');

const databaseName = 'u364362094_arkteisiis';
const productionConfiguration = {
  nodeEnv: 'production',
  devPasswordOnlyLogin: false,
  database: { host: 'db.hostinger.example', database: databaseName, user: 'u123456_user', password: 'not-a-real-password' }
};

function options(mode = 'apply') {
  return parseOptions([
    `--${mode}`, '--target-database', databaseName, '--confirm-database', databaseName,
    '--confirm-seed-marker', HOSTINGER_SEED_MARKER
  ], databaseName);
}

function createInitialState() {
  const roles = [
    ['database_admin', 'HDMO-ADMIN-001'], ['registrar', 'HDMO-REG-001'],
    ['teacher', 'HDMO-TEACH-001'], ['finance', 'HDMO-FIN-001'], ['student', null]
  ];
  const users = roles.map(([role], index) => ({ id: index + 1, role, is_active: 1 }));
  const staff_profiles = roles.flatMap(([, employee_no], index) => employee_no
    ? [{ id: index + 1, user_id: index + 1, employee_no }]
    : []);
  return {
    tables: {
      audit_logs: [{ id: 1, user_id: 1, entity_type: 'school_demo_seed', entity_id: HOSTINGER_SEED_MARKER }],
      financial_accounts: [{ id: 1, student_id: 1, balance: '0.00' }],
      users,
      staff_profiles,
      students: [{ id: 1, user_id: 5, student_no: 'DEMO-HOSTINGER-0001', lrn: '999000000091',
        first_name: 'Demo', last_name: 'Learner', status: 'active' }],
      academic_terms: [{ id: 1, school_year: '2026-2027', term: 'Term 1', is_current: 1 }],
      sections: [{ id: 1, name: 'Demo Hostinger Section A', grade_level: 'Grade 11', academic_term_id: 1 }],
      subjects: [{ id: 1, subject_code: 'DEMO-HOSTINGER-ENG-001', subject_name: 'Demo Communication Skills' }],
      enrollments: [{ id: 1, student_id: 1, academic_term_id: 1, section_id: 1,
        enrollment_status: 'enrolled', term_scope_status: 'applicable' }],
      student_subjects: [{ id: 1, enrollment_id: 1, subject_id: 1 }],
      grades: [
        { id: 1, student_subject_id: 1, grading_period: 'Term 1', grade_value: '88.00' },
        { id: 2, student_subject_id: 1, grading_period: 'Term 2', grade_value: '91.00' },
        { id: 3, student_subject_id: 1, grading_period: 'Term 3', grade_value: '90.00' },
        { id: 4, student_subject_id: 1, grading_period: 'Final Grade', grade_value: '90.00' }
      ],
      teacher_assignments: [{ id: 1, teacher_id: 3, academic_term_id: 1, section_id: 1, subject_id: 1 }],
      school_year_term_order: [], annual_enrollments: [], annual_enrollment_events: [], finance_schedules: [],
      finance_schedule_lines: [], annual_assessments: [], assessed_charges: [], finance_payments: [], class_schedules: [],
      finance_allocation_batches: [], finance_payment_allocations: [], annual_registrar_confirmations: []
    },
    nextIds: {}
  };
}

class FakeMariaDbConnection {
  constructor({ failTable = null, initialState = createInitialState() } = {}) {
    this.db = { state: initialState };
    this.failTable = failTable;
    this.snapshot = null;
    this.inserts = new Map();
    this.statements = [];
    this.released = false;
  }

  table(name) {
    return this.db.state.tables[name] || (this.db.state.tables[name] = []);
  }

  nextId(table) {
    if (!this.db.state.nextIds[table]) {
      this.db.state.nextIds[table] = Math.max(0, ...this.table(table).map((row) => Number(row.id || 0))) + 1;
    }
    const value = this.db.state.nextIds[table];
    this.db.state.nextIds[table] += 1;
    return value;
  }

  async query() { return [[], []]; }

  async beginTransaction() {
    this.snapshot = structuredClone(this.db.state);
  }

  async commit() { this.snapshot = null; }

  async rollback() {
    if (this.snapshot) this.db.state = this.snapshot;
    this.snapshot = null;
  }

  release() { this.released = true; }

  async execute(statement, values = []) {
    this.statements.push(statement);
    if (statement.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
    if (statement.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
    if (statement === 'SELECT version FROM schema_migrations ORDER BY version') {
      return [Array.from({ length: 11 }, (_, index) => ({ version: `v2.${String(index + 1).padStart(3, '0')}` })), []];
    }
    if (statement.includes('information_schema.tables')) {
      return [REQUIRED_OBJECTS.map((table_name) => ({ table_name })), []];
    }
    if (statement.includes('FROM audit_logs AS marker')) {
      const marker = this.table('audit_logs').find((row) => row.entity_type === values[0] && row.entity_id === values[1]);
      return [marker && this.table('users').find((user) => user.id === marker.user_id && user.role === 'database_admin')
        ? [{ id: marker.id, user_id: marker.user_id }] : [], []];
    }
    if (statement.includes('FROM students AS student') && statement.includes('student_account')) {
      const student = this.table('students').find((row) => row.student_no === values[4] && row.lrn === values[5]
        && this.table('users').some((user) => user.id === row.user_id && user.role === 'student'));
      const term = this.table('academic_terms').find((row) => row.school_year === values[0] && row.term === values[1]);
      const section = term && this.table('sections').find((row) => row.academic_term_id === term.id && row.name === values[2]);
      const subject = this.table('subjects').find((row) => row.subject_code === values[3]);
      const enrollment = student && term && section && subject && this.table('enrollments').find((row) => row.student_id === student.id
        && row.academic_term_id === term.id && row.section_id === section.id);
      return [enrollment ? [{ student_id: student.id, term_id: term.id, section_id: section.id, subject_id: subject.id }] : [], []];
    }
    if (statement.includes('(SELECT COUNT(*) FROM users) AS users_count')) {
      return [[{
        users_count: this.table('users').length,
        students_count: this.table('students').length,
        financial_accounts_count: this.table('financial_accounts').length,
        academic_terms_count: this.table('academic_terms').length,
        sections_count: this.table('sections').length,
        subjects_count: this.table('subjects').length,
        enrollments_count: this.table('enrollments').length,
        student_subjects_count: this.table('student_subjects').length,
        grades_count: this.table('grades').length,
        annual_enrollments_count: this.table('annual_enrollments').length,
        annual_assessments_count: this.table('annual_assessments').length,
        class_schedules_count: this.table('class_schedules').length
      }], []];
    }
    if (statement.includes('FROM teacher_assignments WHERE teacher_id = ?')) {
      const [teacherId, termId, sectionId, subjectId] = values.map(Number);
      const rows = this.table('teacher_assignments').filter((row) => Number(row.teacher_id) === teacherId
        && Number(row.academic_term_id) === termId && Number(row.section_id) === sectionId
        && Number(row.subject_id) === subjectId && Number(row.is_active ?? 1) === 1);
      return [rows.map(({ id }) => ({ id })), []];
    }
    if (statement.includes('FROM teacher_assignments') && statement.includes('section_id IN (')
      && statement.includes('academic_term_id, section_id, subject_id')) {
      const teacherId = Number(values[0]);
      const sectionIds = new Set(values.slice(1).map(Number));
      const rows = this.table('teacher_assignments').filter((row) => Number(row.teacher_id) === teacherId
        && sectionIds.has(Number(row.section_id)) && Number(row.is_active ?? 1) === 1);
      return [rows.map(({ id, academic_term_id, section_id, subject_id }) => ({ id, academic_term_id, section_id, subject_id })), []];
    }
    if (statement.includes('FROM staff_profiles AS profile')) {
      const profiles = this.table('staff_profiles').filter((row) => values.includes(row.employee_no));
      return [profiles.map((profile) => ({ ...profile,
        role: this.table('users').find((user) => user.id === profile.user_id)?.role })), []];
    }
    if (statement.includes('FROM audit_logs WHERE entity_type = ? AND entity_id = ?')) {
      const rows = this.table('audit_logs').filter((row) => row.entity_type === values[0] && row.entity_id === values[1]);
      return [rows.map(({ id }) => ({ id })), []];
    }
    if (statement.startsWith('SELECT id FROM students WHERE student_no IN')) {
      const half = values.length / 2;
      const rows = this.table('students').filter((row) => values.slice(0, half).includes(row.student_no)
        || values.slice(half).includes(row.lrn));
      return [rows.slice(0, 1).map(({ id }) => ({ id })), []];
    }
    if (statement.includes('FROM academic_terms WHERE school_year = ? AND term IN') && statement.includes('LIMIT 1')) {
      const rows = this.table('academic_terms').filter((row) => row.school_year === values[0] && values.slice(1).includes(row.term));
      return [rows.slice(0, 1), []];
    }
    if (statement.includes('FROM school_year_term_order WHERE school_year = ?')) {
      return [this.table('school_year_term_order').filter((row) => row.school_year === values[0]).slice(0, 1), []];
    }
    if (statement.includes('FROM sections AS section') && statement.includes('section.name IN')) {
      return [this.table('sections').filter((row) => values.includes(row.name)).slice(0, 1), []];
    }
    if (statement.includes('FROM subjects WHERE subject_code IN')) {
      return [this.table('subjects').filter((row) => values.includes(row.subject_code)).slice(0, 1), []];
    }
    if (statement.includes('FROM finance_schedules WHERE school_year = ?')) {
      const rows = this.table('finance_schedules').filter((row) => row.school_year === values[0]
        && values.includes(row.grade_level) && values.includes(row.voucher_code));
      return [rows.slice(0, 1), []];
    }
    const idempotencyCollision = /^SELECT id FROM `([a-z_]+)` WHERE idempotency_key IN/.exec(statement);
    if (idempotencyCollision) {
      const rows = this.table(idempotencyCollision[1]).filter((row) => values.includes(row.idempotency_key));
      return [rows.slice(0, 1), []];
    }
    if (statement.includes('FROM finance_payments WHERE reference_no IN')) {
      return [this.table('finance_payments').filter((row) => values.includes(row.reference_no)).slice(0, 1), []];
    }
    if (statement === 'SELECT id FROM class_schedules LIMIT 1') {
      return [this.table('class_schedules').slice(0, 1).map(({ id }) => ({ id })), []];
    }
    if (statement.startsWith('SELECT id, term FROM academic_terms')) {
      return [this.table('academic_terms').filter((row) => row.school_year === values[0] && values.slice(1).includes(row.term)), []];
    }
    if (statement.startsWith('SELECT id, student_id FROM enrollments WHERE academic_term_id = ?')) {
      const [termId, ...studentIds] = values.map(Number);
      return [this.table('enrollments').filter((row) => Number(row.academic_term_id) === termId
        && studentIds.includes(Number(row.student_id))), []];
    }
    if (statement.startsWith('SELECT id, enrollment_id FROM student_subjects WHERE enrollment_id IN')) {
      const subjectId = Number(values.at(-1));
      const enrollmentIds = new Set(values.slice(0, -1).map(Number));
      return [this.table('student_subjects').filter((row) => enrollmentIds.has(Number(row.enrollment_id))
        && Number(row.subject_id) === subjectId), []];
    }
    if (statement.startsWith('SELECT id, student_id, annual_enrollment_id, academic_term_id, section_id, annual_term_number FROM enrollments')) {
      const annualIds = new Set(values.map(Number));
      return [this.table('enrollments').filter((row) => annualIds.has(Number(row.annual_enrollment_id))), []];
    }
    if (statement.startsWith('SELECT id, name, grade_level, academic_term_id, strand FROM sections')) {
      const termIds = values.slice(0, 3).map(Number);
      const names = values.slice(3);
      return [this.table('sections').filter((row) => termIds.includes(Number(row.academic_term_id)) && names.includes(row.name)), []];
    }
    if (statement.includes('FROM finance_schedule_lines WHERE schedule_id IN')) {
      return [this.table('finance_schedule_lines').filter((row) => values.map(Number).includes(Number(row.schedule_id))), []];
    }
    if (statement.includes('FROM student_subjects AS assignment')) {
      const annualIds = new Set(values.map(Number));
      const rows = this.table('student_subjects').flatMap((assignment) => {
        const enrollment = this.table('enrollments').find((row) => row.id === assignment.enrollment_id);
        const annual = enrollment && this.table('annual_enrollments').find((row) => row.id === enrollment.annual_enrollment_id);
        const subject = this.table('subjects').find((row) => row.id === assignment.subject_id);
        return annual && annualIds.has(Number(annual.id)) && subject
          ? [{ id: assignment.id, enrollment_id: enrollment.id, subject_id: assignment.subject_id,
            subject_code: subject.subject_code, student_id: enrollment.student_id,
            annual_term_number: enrollment.annual_term_number, grade_level: annual.grade_level }]
          : [];
      });
      return [rows, []];
    }
    if (statement.includes('FROM assessed_charges AS charge')) {
      const annualIds = new Set(values.map(Number));
      const rows = this.table('assessed_charges').flatMap((charge) => {
        const annual = this.table('annual_enrollments').find((row) => row.id === charge.annual_enrollment_id);
        const enrollment = this.table('enrollments').find((row) => row.id === charge.enrollment_id);
        return annual && enrollment && annualIds.has(Number(annual.id)) && enrollment.annual_term_number === 1
          && charge.fee_category === 'tuition' ? [{ id: charge.id, student_id: annual.student_id }] : [];
      });
      return [rows, []];
    }

    const genericSelect = /^SELECT (.+) FROM `([a-z_]+)` WHERE `([a-z_]+)` IN/.exec(statement);
    if (genericSelect) {
      const [, selectedColumns, tableName, keyColumn] = genericSelect;
      const keys = new Set(values.map(String));
      const columns = selectedColumns.split(',').map((column) => column.trim().replaceAll('`', ''));
      const rows = this.table(tableName).filter((row) => keys.has(String(row[keyColumn])));
      return [rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))), []];
    }
    const normalizedStatement = statement.replace(/\s+/g, ' ').trim();
    const plainInSelect = /^SELECT (.+?) FROM ([a-z_]+) WHERE ([a-z_]+) IN \(/.exec(normalizedStatement);
    if (plainInSelect) {
      const [, selectedColumns, tableName, keyColumn] = plainInSelect;
      const keys = new Set(values.map(String));
      const columns = selectedColumns.split(',').map((column) => column.trim().replaceAll('`', ''));
      const rows = this.table(tableName).filter((row) => keys.has(String(row[keyColumn])));
      return [rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))), []];
    }
    if (statement.startsWith('INSERT INTO audit_logs')) {
      const row = { id: this.nextId('audit_logs'), user_id: values[0], action: 'database_admin.demo_data_expanded',
        entity_type: 'school_demo_expansion', entity_id: values[1], details_json: values[2] };
      this.table('audit_logs').push(row);
      this.inserts.set('audit_logs', (this.inserts.get('audit_logs') || 0) + 1);
      return [{ affectedRows: 1, insertId: row.id }, []];
    }

    const insert = /^INSERT INTO `([a-z_]+)` \(([^)]+)\) VALUES /.exec(statement);
    if (insert) {
      const [, tableName, columnsText] = insert;
      if (tableName === this.failTable) throw new Error('mock private database error with host secret');
      if (tableName === 'audit_logs') {
        const row = { id: this.nextId(tableName), user_id: values[0], action: 'database_admin.demo_data_expanded',
          entity_type: 'school_demo_expansion', entity_id: values[1], details_json: values[2] };
        this.table(tableName).push(row);
        this.inserts.set(tableName, (this.inserts.get(tableName) || 0) + 1);
        return [{ affectedRows: 1, insertId: row.id }, []];
      }
      const columns = columnsText.split(',').map((column) => column.trim().replaceAll('`', ''));
      const rowCount = values.length / columns.length;
      assert.equal(Number.isInteger(rowCount), true, `valid placeholder count for ${tableName}`);
      for (let index = 0; index < rowCount; index += 1) {
        const row = Object.fromEntries(columns.map((column, columnIndex) => [column, values[(index * columns.length) + columnIndex]]));
        row.id = this.nextId(tableName);
        this.table(tableName).push(row);
      }
      this.inserts.set(tableName, (this.inserts.get(tableName) || 0) + rowCount);
      return [{ affectedRows: rowCount }, []];
    }
    throw new Error(`Unexpected mock query: ${statement}`);
  }
}

function harness(connection) {
  return {
    connection,
    getDatabasePool: async () => ({ source: { getConnection: async () => connection } }),
    closeDatabasePool: async () => {},
    logger: { log() {} },
    configuration: productionConfiguration
  };
}

test('production expansion requires explicit mode, both exact database confirmations, and the exact seed marker', () => {
  const parsed = options();
  assert.equal(parsed.mode, 'apply');
  assert.equal(parsed.targetDatabase, databaseName);
  assert.equal(parsed.seedMarker, HOSTINGER_SEED_MARKER);
  assert.throws(() => parseOptions(['--apply', '--target-database', databaseName,
    '--confirm-database', 'another_demo_db', '--confirm-seed-marker', HOSTINGER_SEED_MARKER], databaseName), /exactly match DB_NAME/);
  assert.throws(() => parseOptions(['--apply', '--target-database', databaseName,
    '--confirm-database', databaseName, '--confirm-seed-marker', 'wrong-marker'], databaseName), /exact hostinger-demo-seed-v1/);
  assert.throws(() => parseOptions(['--target-database', databaseName,
    '--confirm-database', databaseName, '--confirm-seed-marker', HOSTINGER_SEED_MARKER], databaseName), /Provide a mode/);
  assert.throws(() => parseOptions(['--apply', '--dry-run', '--target-database', databaseName,
    '--confirm-database', databaseName, '--confirm-seed-marker', HOSTINGER_SEED_MARKER], databaseName), /exactly one mode/);
  assert.doesNotThrow(() => parseOptions(['--dry-run', '--target-database', databaseName,
    '--confirm-database', databaseName, '--confirm-seed-marker', HOSTINGER_SEED_MARKER], databaseName));
});

test('production target rejects local, development, root-user, and password-only-login targets', () => {
  assert.doesNotThrow(() => validateProductionTarget(productionConfiguration));
  assert.throws(() => validateProductionTarget({ ...productionConfiguration, nodeEnv: 'development' }), /NODE_ENV=production/);
  assert.throws(() => validateProductionTarget({ ...productionConfiguration, devPasswordOnlyLogin: true }), /password-only login/);
  assert.throws(() => validateProductionTarget({ ...productionConfiguration,
    database: { ...productionConfiguration.database, host: '127.0.0.1' } }), /remote MariaDB/);
  assert.throws(() => validateProductionTarget({ ...productionConfiguration,
    database: { ...productionConfiguration.database, user: 'root' } }), /hPanel database/);
});

test('expansion plan contains 99 fictional unlinked student identities and connected academic/finance counts', () => {
  const plan = buildExpansionPlan({ today: '2026-10-02T00:00:00.000Z' });
  assert.equal(plan.students.length, 99);
  assert.equal(plan.students[0].studentNo, 'DEMO-HOSTINGER-0002');
  assert.equal(plan.students.at(-1).studentNo, 'DEMO-HOSTINGER-0100');
  assert.equal(plan.students[0].lrn, '999000000092');
  assert.equal(new Set(plan.students.map(({ lrn }) => lrn)).size, 99);
  assert.equal(plan.legacyStudents.length, 20);
  assert.equal(plan.annualStudents.length, 79);
  assert.equal(plan.sections.length, 12);
  assert.equal(plan.subjects.length, 4);
  assert.equal(plan.classSchedules.length, 25);
  assert.equal(plan.payments.length, 27);
  assert.deepEqual(plan.expectedCounts, {
    users: 0, students: 99, legacyStyleStudents: 20, pendingAnnualStudents: 79,
    academicTerms: 2, schoolYearTermOrder: 3, sections: 12, subjects: 4,
    teacherAssignments: 24, pendingTermPlacements: 237,
    annualEnrollments: 79, annualEnrollmentEvents: 79, enrollments: 257,
    studentSubjects: 494, grades: 80, financeSchedules: 6, financeScheduleLines: 36,
    annualAssessments: 79, assessedCharges: 474, financePayments: 27, financeAllocationBatches: 27,
    financePaymentAllocations: 27, classSchedules: 25, registrarConfirmations: 0
  });
  assert.ok(plan.scheduleLines.filter(({ feeCategory, lineName }) => feeCategory === 'tuition' && lineName === 'Tuition').length === 18);
});

test('dry run verifies the seeded target and returns counts without inserting rows', async () => {
  const connection = new FakeMariaDbConnection();
  const result = await runExpansion({ ...harness(connection), options: options('dry-run'), today: '2026-10-02T00:00:00.000Z' });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.counts.students, 99);
  assert.equal(connection.inserts.size, 0);
  assert.equal(connection.released, true);
});

test('apply writes 20 enrolled grade fixtures and 79 pending annual/finance fixtures without logins', async () => {
  const connection = new FakeMariaDbConnection();
  const result = await runExpansion({ ...harness(connection), options: options(), today: '2026-10-02T00:00:00.000Z' });
  const tables = connection.db.state.tables;
  assert.equal(result.mode, 'apply');
  assert.equal(tables.users.length, 5);
  assert.equal(tables.students.length, 100);
  assert.equal(tables.students.filter(({ student_no }) => student_no.startsWith('DEMO-HOSTINGER-') && student_no !== 'DEMO-HOSTINGER-0001').length, 99);
  assert.equal(tables.students.filter(({ student_no }) => student_no !== 'DEMO-HOSTINGER-0001' && !Object.hasOwn(tables.students.find((row) => row.student_no === student_no), 'user_id')).length, 99);
  assert.equal(tables.sections.length, 13);
  assert.equal(tables.subjects.length, 5);
  assert.equal(connection.inserts.get('teacher_assignments'), 24);
  assert.equal(tables.class_schedules.length, 25);
  const assignmentById = new Map(tables.teacher_assignments.map((assignment) => [Number(assignment.id), assignment]));
  const schedulesByTerm = new Map();
  for (const schedule of tables.class_schedules) {
    const assignment = assignmentById.get(Number(schedule.assignment_id));
    const termId = Number(assignment.academic_term_id);
    const forTerm = schedulesByTerm.get(termId) || [];
    assert.ok(Number(schedule.day_of_week) >= 1 && Number(schedule.day_of_week) <= 6);
    assert.ok(schedule.start_time < schedule.end_time);
    for (const prior of forTerm) {
      if (Number(prior.day_of_week) !== Number(schedule.day_of_week)) continue;
      assert.ok(!(schedule.start_time < prior.end_time && schedule.end_time > prior.start_time));
      assert.notEqual(schedule.room, prior.room);
    }
    forTerm.push(schedule);
    schedulesByTerm.set(termId, forTerm);
  }
  assert.equal(tables.annual_enrollments.length, 79);
  assert.ok(tables.annual_enrollments.every(({ intake_status }) => intake_status === 'pending'));
  assert.equal(tables.enrollments.length, 258);
  assert.equal(tables.enrollments.filter(({ enrollment_status }) => enrollment_status === 'pending_payment').length, 237);
  assert.equal(tables.enrollments.filter(({ enrollment_status }) => enrollment_status === 'enrolled').length, 21);
  assert.equal(tables.student_subjects.length, 495);
  assert.equal(tables.grades.length, 84);
  const pendingAnnualIds = new Set(tables.annual_enrollments.map(({ id }) => Number(id)));
  const pendingStudentIds = new Set(tables.enrollments.filter(({ annual_enrollment_id }) => pendingAnnualIds.has(Number(annual_enrollment_id)))
    .map(({ student_id }) => Number(student_id)));
  const newlyAddedStudents = tables.students.filter(({ student_no }) => student_no !== 'DEMO-HOSTINGER-0001');
  const gradedNewStudentIds = new Set(tables.grades.slice(4).map((grade) => {
    const studentSubject = tables.student_subjects.find(({ id }) => Number(id) === Number(grade.student_subject_id));
    const enrollment = tables.enrollments.find(({ id }) => Number(id) === Number(studentSubject.enrollment_id));
    return Number(enrollment.student_id);
  }));
  assert.equal([...gradedNewStudentIds].length, 20);
  assert.equal([...gradedNewStudentIds].some((id) => pendingStudentIds.has(id)), false);
  assert.equal(newlyAddedStudents.filter((student) => !Object.hasOwn(student, 'user_id')).length, 99);
  assert.equal(tables.finance_schedules.length, 6);
  assert.equal(tables.finance_schedule_lines.length, 36);
  assert.equal(tables.annual_assessments.length, 79);
  assert.equal(tables.assessed_charges.length, 474);
  assert.equal(tables.finance_payments.length, 27);
  assert.equal(tables.finance_allocation_batches.length, 27);
  assert.equal(tables.finance_payment_allocations.length, 27);
  assert.equal(tables.annual_registrar_confirmations.length, 0);
  assert.equal(tables.audit_logs.filter(({ entity_id }) => entity_id === EXPANSION_MARKER).length, 1);
  assert.ok(tables.grades.slice(4).every(({ grade_value }) => Number(grade_value) >= 75 && Number(grade_value) <= 99));
  assert.ok(tables.finance_payment_allocations.every((allocation) => {
    const payment = tables.finance_payments.find(({ id }) => id === allocation.payment_id);
    return Number(allocation.amount) <= Number(payment.amount);
  }));
  assert.equal(connection.statements.filter((statement) => statement.startsWith('INSERT INTO')).every((statement) => statement.includes('?')), true);
});

test('expansion marker, untouched seed profile, and reserved identifiers guard all writes', async () => {
  const connection = new FakeMariaDbConnection();
  await runExpansion({ ...harness(connection), options: options(), today: '2026-10-02T00:00:00.000Z' });
  const insertCount = [...connection.inserts.values()].reduce((sum, count) => sum + count, 0);
  await assert.rejects(runExpansion({ ...harness(connection), options: options() }), /already applied/);
  assert.equal([...connection.inserts.values()].reduce((sum, count) => sum + count, 0), insertCount);

  const collisionConnection = new FakeMariaDbConnection();
  collisionConnection.table('students').push({ id: 2, student_no: 'DEMO-HOSTINGER-0002', lrn: '900000000001' });
  await assert.rejects(runExpansion({ ...harness(collisionConnection), options: options() }), /reserved demo student number or LRN/);
  assert.equal(collisionConnection.table('annual_enrollments').length, 0);
  assert.equal(collisionConnection.table('audit_logs').filter(({ entity_id }) => entity_id === EXPANSION_MARKER).length, 0);

  const scheduleConnection = new FakeMariaDbConnection();
  scheduleConnection.table('class_schedules').push({ id: 2, assignment_id: 1 });
  await assert.rejects(runExpansion({ ...harness(scheduleConnection), options: options() }), /already contains class schedules/);
  assert.equal(scheduleConnection.inserts.size, 0);

  const nonDemoConnection = new FakeMariaDbConnection();
  nonDemoConnection.table('users').push({ id: 6, role: 'student', is_active: 1 });
  await assert.rejects(runExpansion({ ...harness(nonDemoConnection), options: options() }), /untouched Hostinger demo seed profile/);
  assert.equal(nonDemoConnection.inserts.size, 0);
});

test('failed insert rolls back every earlier fixture row and emits no raw database error', async () => {
  const connection = new FakeMariaDbConnection({ failTable: 'grades' });
  const initialStudentCount = connection.table('students').length;
  await assert.rejects(runExpansion({ ...harness(connection), options: options() }), (error) => {
    assert.ok(error instanceof ExpansionError);
    assert.match(error.message, /failed and was rolled back/);
    assert.doesNotMatch(error.message, /private database error|host secret/);
    return true;
  });
  assert.equal(connection.table('students').length, initialStudentCount);
  assert.equal(connection.table('academic_terms').length, 1);
  assert.equal(connection.table('annual_enrollments').length, 0);
  assert.equal(connection.table('finance_schedules').length, 0);
  assert.equal(connection.table('audit_logs').filter(({ entity_id }) => entity_id === EXPANSION_MARKER).length, 0);
});

test('security validation runs before creating a database connection', async () => {
  let connectionRequested = false;
  await assert.rejects(runExpansion({ options: options(), configuration: { ...productionConfiguration, nodeEnv: 'development' },
    getDatabasePool: async () => { connectionRequested = true; throw new Error('must not connect'); }, closeDatabasePool: async () => {} }), /NODE_ENV=production/);
  assert.equal(connectionRequested, false);
});
