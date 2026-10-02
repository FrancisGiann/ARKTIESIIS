'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACTIVATION_MARKER,
  ACTIVATION_ORDINALS,
  ActivationError,
  buildActivationPlan,
  parseOptions,
  validateProductionTarget,
  runActivation
} = require('../scripts/activate-hostinger-demo-enrollments');
const { HOSTINGER_SEED_MARKER, EXPANSION_MARKER, SCHOOL_YEAR, buildExpansionPlan,
  stableUuid, fingerprint } = require('../scripts/expand-hostinger-demo');

const databaseName = 'u364362094_arkteisiis';
const productionConfiguration = {
  nodeEnv: 'production',
  devPasswordOnlyLogin: false,
  database: { host: 'db.hostinger.example', database: databaseName, user: 'u123456_user', password: 'not-a-real-password' }
};
const counts = { students: 99, legacyStyleStudents: 20, pendingAnnualStudents: 79,
  annualEnrollments: 79, pendingTermPlacements: 237, registrarConfirmations: 0 };

function options(mode = 'apply') {
  return parseOptions([
    `--${mode}`, '--target-database', databaseName, '--confirm-database', databaseName,
    '--confirm-seed-marker', HOSTINGER_SEED_MARKER, '--confirm-expansion-marker', EXPANSION_MARKER
  ], databaseName);
}

function createFixture() {
  const expansion = buildExpansionPlan();
  const plan = buildActivationPlan();
  const staff = [
    { id: 1, user_id: 1, employee_no: 'HDMO-ADMIN-001' },
    { id: 2, user_id: 2, employee_no: 'HDMO-REG-001' }
  ];
  const users = [{ id: 1, role: 'database_admin', is_active: 1 }, { id: 2, role: 'registrar', is_active: 1 }];
  const students = expansion.students.map((student, index) => ({
    id: index + 2,
    user_id: null,
    student_no: student.studentNo,
    lrn: student.lrn,
    first_name: student.firstName,
    middle_name: student.middleName,
    last_name: student.lastName,
    sex: student.sex,
    address: student.address,
    status: 'active'
  }));
  const termIds = new Map(expansion.termNames.map((term, index) => [term, index + 1]));
  const schedules = expansion.schedules.map((schedule, index) => ({
    id: index + 1,
    idempotency_key: schedule.idempotencyKey
  }));
  const annual = expansion.annualStudents.map((student, index) => {
    const schedule = expansion.schedules.find((item) => item.gradeLevel === student.gradeLevel && item.voucherCode === student.voucherCode);
    const scheduleId = schedules.find((item) => item.idempotency_key === schedule.idempotencyKey).id;
    const studentId = students.find((item) => item.student_no === student.studentNo).id;
    return {
      id: index + 1000,
      student_id: studentId,
      school_year: SCHOOL_YEAR,
      grade_level: student.gradeLevel,
      voucher_code: student.voucherCode,
      intake_status: 'pending',
      account_activation_pending: 0,
      created_by: 1,
      intake_kind: 'new',
      entry_term_number: 1,
      idempotency_key: student.annualKey,
      request_fingerprint: fingerprint({ studentNo: student.studentNo, schoolYear: SCHOOL_YEAR }),
      assessment_id: index + 2000,
      schedule_id: scheduleId,
      schedule_version: 1,
      voucher_code_snapshot: student.voucherCode,
      selection_json: '{"optionalLineIds":[]}',
      schedule_key: schedule.idempotencyKey
    };
  });
  const placements = [];
  for (const student of expansion.annualStudents) {
    const studentId = students.find((item) => item.student_no === student.studentNo).id;
    const annualId = annual.find((item) => item.idempotency_key === student.annualKey).id;
    const sectionNumber = student.ordinal <= 50 ? student.ordinal - 2 : student.ordinal - 51;
    const suffix = sectionNumber % 2 === 0 ? 'A' : 'B';
    for (let termNumber = 1; termNumber <= 3; termNumber += 1) {
      placements.push({
        id: placements.length + 3000,
        student_id: studentId,
        annual_enrollment_id: annualId,
        academic_term_id: termIds.get(`Term ${termNumber}`),
        section_id: placements.length + 4000,
        enrollment_status: 'pending_payment',
        finalized_at: null,
        annual_term_number: termNumber,
        term_scope_status: 'applicable',
        grade_level: student.gradeLevel,
        intake_status: 'pending',
        annual_student_id: studentId,
        student_no: student.studentNo,
        school_year: SCHOOL_YEAR,
        term: `Term ${termNumber}`,
        is_current: termNumber === 1 ? 1 : 0,
        section_name: `Demo Hostinger ${student.gradeLevel} ${suffix}`
      });
    }
  }
  const auditLogs = [
    { id: 1, user_id: 1, entity_type: 'school_demo_seed', entity_id: HOSTINGER_SEED_MARKER },
    { id: 2, user_id: 1, entity_type: 'school_demo_expansion', entity_id: EXPANSION_MARKER,
      details_json: JSON.stringify({ version: 1, counts }) }
  ];
  return {
    plan,
    state: { students, annual, placements, schedules, users, staff, auditLogs, confirmations: [], documents: [] },
    previewCount: 0,
    confirmationCount: 0
  };
}

class FakeConnection {
  constructor(fixture) {
    this.fixture = fixture;
    this.snapshot = null;
    this.released = false;
    this.statements = [];
  }

  async query() { return [[], []]; }
  async beginTransaction() { this.snapshot = structuredClone(this.fixture.state); }
  async commit() { this.snapshot = null; }
  async rollback() {
    if (this.snapshot) this.fixture.state = this.snapshot;
    this.snapshot = null;
  }
  release() { this.released = true; }

  async execute(statement, values = []) {
    this.statements.push(statement);
    const state = this.fixture.state;
    if (statement.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
    if (statement.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
    if (statement === 'SELECT version FROM schema_migrations ORDER BY version') {
      return [Array.from({ length: 11 }, (_, index) => ({ version: `v2.${String(index + 1).padStart(3, '0')}` })), []];
    }
    if (statement.includes('information_schema.tables')) {
      return [[...require('../scripts/check-db').REQUIRED_OBJECTS, 'annual_registrar_confirmations']
        .map((table_name) => ({ table_name })), []];
    }
    if (statement.includes('FROM audit_logs AS marker')) {
      const rows = state.auditLogs.filter((row) => row.entity_type === values[0] && row.entity_id === values[1]
        && state.users.find((user) => user.id === row.user_id)?.role === 'database_admin');
      return [rows.map((row) => ({ id: row.id, details_json: row.details_json })), []];
    }
    if (statement.includes('FROM audit_logs WHERE entity_type = ? AND entity_id = ?')) {
      return [state.auditLogs.filter((row) => row.entity_type === values[0] && row.entity_id === values[1])
        .map(({ id }) => ({ id })), []];
    }
    if (statement.includes('FROM staff_profiles AS profile')) {
      return [state.staff.filter((row) => values.includes(row.employee_no)).map((profile) => ({
        ...profile,
        role: state.users.find((user) => user.id === profile.user_id)?.role
      })), []];
    }
    if (statement.includes('FROM students WHERE student_no BETWEEN')) {
      const [start, end] = values;
      return [state.students.filter((row) => row.student_no >= start && row.student_no <= end), []];
    }
    if (statement.includes('FROM annual_enrollments AS annual')) {
      const studentIds = new Set(values.map(Number));
      const rows = state.annual.filter((row) => studentIds.has(Number(row.student_id)));
      return [rows.map((row) => ({ ...row })), []];
    }
    if (statement.includes('FROM enrollments AS enrollment') && statement.includes('WHERE enrollment.annual_enrollment_id IN')) {
      const annualIds = new Set(values.map(Number));
      return [state.placements.filter((row) => annualIds.has(Number(row.annual_enrollment_id))).map((row) => ({ ...row })), []];
    }
    if (statement.includes('FROM annual_registrar_confirmations')) {
      const annualIds = new Set(values.map(Number));
      return [state.confirmations.filter((row) => annualIds.has(Number(row.annual_enrollment_id))).map((row) => ({ ...row })), []];
    }
    if (statement.includes('FROM documents WHERE student_id IN')) {
      const studentIds = new Set(values.map(Number));
      return [state.documents.filter((row) => studentIds.has(Number(row.student_id))).slice(0, 1), []];
    }
    if (statement.startsWith('INSERT INTO audit_logs')) {
      state.auditLogs.push({ id: state.auditLogs.length + 1, user_id: values[0], action: 'database_admin.demo_enrollments_activated',
        entity_type: 'school_demo_enrollment_activation', entity_id: values[1], details_json: values[2] });
      return [{ affectedRows: 1, insertId: state.auditLogs.length }, []];
    }
    throw new Error(`Unexpected fake MariaDB statement: ${statement}`);
  }
}

function createHarness({ failBeforeConfirmation = 0 } = {}) {
  const fixture = createFixture();
  const connection = new FakeConnection(fixture);
  let closed = false;
  const pool = { source: { getConnection: async () => connection } };
  const database = {
    getPool: async () => pool,
    closePool: async () => { closed = true; }
  };
  const services = {
    annualFinanceService: {
      async annualAssessmentPreviewForRegistrar(actorId, annualId) {
        fixture.previewCount += 1;
        assert.equal(actorId, 2);
        const annual = fixture.state.annual.find((row) => row.id === annualId);
        const optionalLineIds = JSON.parse(annual.selection_json).optionalLineIds;
        return {
          existingAssessment: true,
          assessmentId: annual.assessment_id,
          scheduleId: annual.schedule_id,
          scheduleVersion: annual.schedule_version,
          voucherCode: annual.voucher_code_snapshot,
          optionalLineIds,
          snapshotFingerprint: 'a'.repeat(64)
        };
      }
    },
    annualEnrollmentService: {
      async confirmAnnualEnrollment(actorId, annualId, input) {
        assert.equal(actorId, 2);
        const existing = fixture.state.confirmations.find((row) => row.idempotency_key === input.idempotencyKey);
        if (existing) return { alreadyConfirmed: true };
        if (failBeforeConfirmation && fixture.confirmationCount === failBeforeConfirmation) {
          failBeforeConfirmation = 0;
          throw new Error('simulated interruption');
        }
        const annual = fixture.state.annual.find((row) => row.id === annualId);
        const entry = fixture.state.placements.find((row) => row.annual_enrollment_id === annualId && row.annual_term_number === 1);
        annual.intake_status = 'enrolled';
        entry.enrollment_status = 'enrolled';
        entry.finalized_at = '2026-10-02 09:00:00';
        for (const placement of fixture.state.placements.filter((row) => row.annual_enrollment_id === annualId)) {
          placement.intake_status = 'enrolled';
        }
        fixture.state.confirmations.push({ id: fixture.state.confirmations.length + 1, annual_enrollment_id: annualId,
          entry_enrollment_id: entry.id, confirmed_by: actorId, idempotency_key: input.idempotencyKey,
          request_fingerprint: 'b'.repeat(64) });
        fixture.confirmationCount += 1;
        return { alreadyConfirmed: false };
      }
    }
  };
  return { fixture, connection, database, services, closed: () => closed };
}

test('activation requires explicit mode and exact production database and marker acknowledgements', () => {
  assert.throws(() => parseOptions([], databaseName), ActivationError);
  assert.throws(() => parseOptions(['--apply'], databaseName), /exact Hostinger seed and expansion markers/);
  assert.throws(() => parseOptions([
    '--apply', '--target-database', databaseName, '--confirm-database', 'other',
    '--confirm-seed-marker', HOSTINGER_SEED_MARKER, '--confirm-expansion-marker', EXPANSION_MARKER
  ], databaseName), /exactly match DB_NAME/);
  assert.throws(() => parseOptions([
    '--apply', '--target-database', databaseName, '--confirm-database', databaseName,
    '--confirm-seed-marker', HOSTINGER_SEED_MARKER, '--confirm-expansion-marker', 'wrong'
  ], databaseName), /exact hostinger-demo-expansion-v1 marker/);
  assert.throws(() => validateProductionTarget({ ...productionConfiguration, nodeEnv: 'development' }), /NODE_ENV=production/);
  assert.throws(() => validateProductionTarget({ ...productionConfiguration,
    database: { ...productionConfiguration.database, host: '127.0.0.1' } }), /remote MariaDB host/);
});

test('activation plan reserves ten annual fixtures per grade', () => {
  const plan = buildActivationPlan();
  assert.equal(plan.selected.length, 20);
  assert.deepEqual(plan.selected.map(({ ordinal }) => ordinal), ACTIVATION_ORDINALS);
  assert.deepEqual(plan.expectedGradeCounts, { 'Grade 11': 10, 'Grade 12': 10 });
});

test('dry-run validates the exact expansion and makes no writes', async () => {
  const harness = createHarness();
  const messages = [];
  const result = await runActivation({
    options: options('dry-run'), configuration: productionConfiguration,
    getDatabasePool: harness.database.getPool, closeDatabasePool: harness.database.closePool,
    services: harness.services,
    logger: { log: (message) => messages.push(message) }
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.selectedStudents, 20);
  assert.equal(result.completedForReplay, 0);
  assert.equal(result.readyToConfirm, 20);
  assert.equal(harness.fixture.previewCount, 20);
  assert.equal(harness.fixture.state.confirmations.length, 0);
  assert.equal(harness.fixture.state.auditLogs.some((row) => row.entity_id === ACTIVATION_MARKER), false);
  assert.equal(harness.connection.statements.some((statement) => statement.startsWith('INSERT INTO')), false);
  assert.match(messages[0], /No rows were written/);
  assert.equal(harness.closed(), true);
  assert.equal(harness.connection.released, true);
});

test('apply uses the registrar confirmation service and writes one completion marker', async () => {
  const harness = createHarness();
  const messages = [];
  const result = await runActivation({
    options: options('apply'), configuration: productionConfiguration,
    getDatabasePool: harness.database.getPool, closeDatabasePool: harness.database.closePool,
    services: harness.services, logger: { log: (message) => messages.push(message) }
  });
  assert.equal(result.mode, 'apply');
  assert.equal(harness.fixture.confirmationCount, 20);
  assert.equal(harness.fixture.previewCount, 20);
  assert.equal(harness.fixture.state.confirmations.length, 20);
  for (const student of buildExpansionPlan().annualStudents) {
    const annual = harness.fixture.state.annual.find((row) => row.idempotency_key === student.annualKey);
    assert.equal(annual.intake_status, ACTIVATION_ORDINALS.includes(student.ordinal) ? 'enrolled' : 'pending');
  }
  assert.equal(harness.fixture.state.placements.filter((row) => row.enrollment_status === 'enrolled').length, 20);
  assert.equal(harness.fixture.state.annual.some((row) => row.intake_status === 'enrolled'), true);
  assert.equal(harness.fixture.state.students.some((row) => row.user_id != null), false);
  assert.equal(harness.fixture.state.auditLogs.filter((row) => row.entity_id === ACTIVATION_MARKER).length, 1);
  assert.match(messages[0], /no logins or documents were created/);
});

test('the completion marker is withheld if a confirmation call returns without persisting', async () => {
  const harness = createHarness();
  let confirmationCalls = 0;
  const services = {
    ...harness.services,
    annualEnrollmentService: {
      async confirmAnnualEnrollment() { confirmationCalls += 1; }
    }
  };
  await assert.rejects(runActivation({
    options: options('apply'), configuration: productionConfiguration,
    getDatabasePool: harness.database.getPool, closeDatabasePool: harness.database.closePool,
    services, logger: { log() {} }
  }), /Not all 20 selected demo confirmations and finalized Term 1 placements were verified/);
  assert.equal(confirmationCalls, 20);
  assert.equal(harness.fixture.state.confirmations.length, 0);
  assert.equal(harness.fixture.state.placements.filter((row) => row.enrollment_status === 'enrolled').length, 0);
  assert.equal(harness.fixture.state.auditLogs.some((row) => row.entity_id === ACTIVATION_MARKER), false);
});

test('an interrupted apply safely replays prior confirmations by their deterministic keys', async () => {
  const harness = createHarness({ failBeforeConfirmation: 4 });
  const base = {
    options: options('apply'), configuration: productionConfiguration,
    getDatabasePool: harness.database.getPool, closeDatabasePool: harness.database.closePool,
    services: harness.services, logger: { log() {} }
  };
  await assert.rejects(runActivation(base), /rerun the exact apply command to resume/);
  assert.equal(harness.fixture.state.confirmations.length, 4);
  assert.equal(harness.fixture.state.auditLogs.some((row) => row.entity_id === ACTIVATION_MARKER), false);
  const result = await runActivation(base);
  assert.equal(result.mode, 'apply');
  assert.equal(harness.fixture.confirmationCount, 20);
  assert.equal(harness.fixture.previewCount, 20 + 16);
  assert.equal(harness.fixture.state.confirmations.length, 20);
  assert.equal(harness.fixture.state.auditLogs.filter((row) => row.entity_id === ACTIVATION_MARKER).length, 1);
});

test('saved assessment previews are all checked before the first confirmation write', async () => {
  const harness = createHarness();
  const services = {
    ...harness.services,
    annualFinanceService: {
      async annualAssessmentPreviewForRegistrar(actorId, annualId) {
        const preview = await harness.services.annualFinanceService.annualAssessmentPreviewForRegistrar(actorId, annualId);
        return { ...preview, scheduleVersion: 99 };
      }
    }
  };
  await assert.rejects(runActivation({
    options: options('apply'), configuration: productionConfiguration,
    getDatabasePool: harness.database.getPool, closeDatabasePool: harness.database.closePool,
    services, logger: { log() {} }
  }), /fee preview no longer matches/);
  assert.equal(harness.fixture.previewCount, 1);
  assert.equal(harness.fixture.confirmationCount, 0);
  assert.equal(harness.fixture.state.auditLogs.some((row) => row.entity_id === ACTIVATION_MARKER), false);
});

test('a changed expansion record or existing completion marker blocks activation', async () => {
  const changed = createHarness();
  changed.fixture.state.students[0].user_id = 50;
  await assert.rejects(runActivation({
    options: options('dry-run'), configuration: productionConfiguration,
    getDatabasePool: changed.database.getPool, closeDatabasePool: changed.database.closePool,
    services: changed.services, logger: { log() {} }
  }), /reserved records or contain linked accounts/);
  assert.equal(changed.fixture.previewCount, 0);

  const used = createHarness();
  used.fixture.state.auditLogs.push({ id: 10, user_id: 1, entity_type: 'school_demo_enrollment_activation', entity_id: ACTIVATION_MARKER });
  await assert.rejects(runActivation({
    options: options('apply'), configuration: productionConfiguration,
    getDatabasePool: used.database.getPool, closeDatabasePool: used.database.closePool,
    services: used.services, logger: { log() {} }
  }), /already completed/);
  assert.equal(used.fixture.confirmationCount, 0);
});
