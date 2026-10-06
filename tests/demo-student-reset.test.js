'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResetError, RESET_TABLES, PRESERVED_TABLES, STUDENT_AUTH_TABLES,
  parseOptions, resetConfirmation, connectionTarget, planDigestFor, validateTarget } = require('../scripts/reset-demo-students-mariadb');

test('student reset defaults to a database preview and accepts the explicit preview form', () => {
  assert.deepEqual(parseOptions([]), { mode: 'dry-run', databaseOnly: false });
  assert.deepEqual(parseOptions(['--dry-run', '--database-only']), { mode: 'dry-run', databaseOnly: true });
  assert.throws(() => parseOptions(['--apply', '--dry-run']), ResetError);
  assert.throws(() => parseOptions(['--apply', '--apply']), ResetError);
  assert.deepEqual(parseOptions(['--resume-files']), { mode: 'resume-files', databaseOnly: false });
  assert.deepEqual(parseOptions(['--mark-files-removed']), { mode: 'mark-files-removed', databaseOnly: false });
  assert.throws(() => parseOptions(['--resume-files', '--mark-files-removed']), ResetError);
  assert.throws(() => parseOptions(['--delete-all']), ResetError);
});

test('reset apply requires exact target, maintenance, backup, cohort and preview attestations', () => {
  const databaseName = 'ark_demo_fixture';
  const configuration = { database: { database: databaseName } };
  assert.throws(() => validateTarget({ configuration, variables: {}, mode: 'dry-run' }), /allowlisted reset target/);
  const dryRunEnv = { RESET_DEMO_ALLOWED_DATABASE: databaseName };
  assert.equal(validateTarget({ configuration, variables: dryRunEnv, mode: 'dry-run' }), databaseName);
  assert.throws(() => validateTarget({ configuration, variables: dryRunEnv, mode: 'apply' }), /exact confirmation phrase/);
  const acknowledged = {
    ...dryRunEnv,
    RESET_DEMO_CONFIRM: resetConfirmation(databaseName),
    RESET_DEMO_MAINTENANCE_CONFIRMED: 'true',
    RESET_DEMO_EXPECTED_STUDENTS: '226',
    RESET_DEMO_EXPECTED_STUDENT_USERS: '7',
    RESET_DEMO_EXPECTED_PLAN_SHA256: 'a'.repeat(64),
    RESET_DEMO_DATABASE_BACKUP_VERIFIED: 'true',
    RESET_DEMO_UPLOAD_BACKUP_VERIFIED: 'true',
    RESET_DEMO_PENDING_FILES_MANIFEST: '/private/demo-reset-manifest.json'
  };
  assert.equal(validateTarget({ configuration, variables: acknowledged, mode: 'apply' }), databaseName);
  assert.throws(() => validateTarget({ configuration: { database: { database: 'another_db' } }, variables: acknowledged, mode: 'apply' }), /allowlisted reset target/);
  assert.throws(() => validateTarget({ configuration, variables: { ...acknowledged, RESET_DEMO_EXPECTED_PLAN_SHA256: 'not-a-hash' }, mode: 'apply' }), /matching dry-run preview/);
  assert.throws(() => validateTarget({ configuration, variables: { ...acknowledged, RESET_DEMO_MAINTENANCE_CONFIRMED: 'false' }, mode: 'apply' }), /writers are paused/);
});

test('reset scope covers student operations while preserving every listed school/setup table', () => {
  assert.equal(new Set(RESET_TABLES).size, RESET_TABLES.length, 'delete order has no duplicate tables');
  assert.ok(RESET_TABLES.indexOf('annual_enrollments') < RESET_TABLES.indexOf('pre_enrollments'));
  assert.ok(RESET_TABLES.indexOf('pre_enrollments') < RESET_TABLES.indexOf('readmission_evaluations'));
  assert.ok(RESET_TABLES.indexOf('student_term_clearance_events') < RESET_TABLES.indexOf('student_term_clearances'));
  assert.ok(RESET_TABLES.indexOf('student_term_clearance_items') < RESET_TABLES.indexOf('student_term_clearances'));
  assert.ok(RESET_TABLES.indexOf('student_term_clearances') < RESET_TABLES.indexOf('enrollments'));
  assert.ok(RESET_TABLES.indexOf('annual_term_finalizations') < RESET_TABLES.indexOf('enrollments'));
  assert.ok(RESET_TABLES.indexOf('annual_continuity_source_events') < RESET_TABLES.indexOf('annual_enrollments'));
  assert.ok(RESET_TABLES.indexOf('students') === RESET_TABLES.length - 1);
  for (const table of ['audit_logs', 'documents', 'student_term_clearance_events', 'student_term_clearance_items',
    'student_term_clearances', 'annual_term_finalizations', 'annual_continuity_source_events',
    'annual_enrollments', 'pre_enrollments', 'readmission_evaluations',
    'teacher_grade_submissions', 'finance_payments', 'assessed_charges', 'financial_accounts', 'students']) {
    assert.ok(RESET_TABLES.includes(table), `${table} is included in the deliberate student reset scope`);
  }
  for (const table of ['academic_terms', 'sections', 'subjects', 'teacher_assignments', 'class_schedules',
    'finance_schedules', 'finance_schedule_lines', 'school_year_term_order', 'school_year_term_order_reviews',
    'physical_requirement_definitions', 'term_clearance_templates', 'term_clearance_template_items',
    'staff_profiles', 'application_locks', 'schema_migrations']) {
    assert.ok(PRESERVED_TABLES.includes(table), `${table} remains preserved`);
    assert.ok(!RESET_TABLES.includes(table), `${table} is never deleted`);
  }
  assert.deepEqual(STUDENT_AUTH_TABLES, ['two_factor_codes', 'two_factor_auth_limits', 'password_reset_tokens', 'pending_email_changes']);
  assert.equal(RESET_TABLES.includes('users'), false, 'only student-role users are deleted by the targeted final statement');
});

test('the approved inventory binds the same schema and rows to the configured endpoint', () => {
  const common = {
    databaseName: 'demo', schemaVersion: 'v2.017', counts: { students: 226 }, students: 226,
    studentUsers: 7, staffUsers: 9, fileReferences: [], fileSnapshot: [],
    serverIdentity: { databaseName: 'demo', hostname: 'db-a', port: 3306, serverId: 7, version: '11.8.9' }
  };
  const primary = { ...common, target: connectionTarget({ host: 'db-a.example.test', port: 3306 }) };
  const aliasOrOtherHost = { ...common, target: connectionTarget({ host: 'db-b.example.test', port: 3306 }) };
  const otherSocket = { ...common, target: connectionTarget({ socketPath: '/private/run/mariadb.sock' }) };
  assert.notEqual(planDigestFor(primary), planDigestFor(aliasOrOtherHost));
  assert.notEqual(planDigestFor(primary), planDigestFor(otherSocket));
  assert.equal(primary.target.endpoint, 'db-a.example.test:3306');
});
