const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { checkDatabase } = require('../scripts/check-db');

function schemaRow(overrides = {}) {
  return {
    students: 1, enrollments: 1, class_schedules: 1, teacher_grade_submissions: 1,
    document_decision_events: 1, form137_status_events: 1, previous_school_report_card_status_events: 1, financial_transactions: 1, audit_logs: 1,
    previous_report_card_rejected_status_enabled: 1,
    auth_session_version: 16, must_change_password: 1, finalized_at: 8, is_legacy_archive: 1,
    teacher_role_enabled: 1, filtered_student_link_index: 1, ...overrides
  };
}

async function runCheck({ databaseName = 'ARKTIESIIS_V2', hasVersion = true, hasPhysicalStatusMigration = true, schema = schemaRow(), failAt = null } = {}) {
  const state = { queries: [], logs: [], errors: [], closed: 0 };
  const pool = { request() { return { async query(statement) {
    state.queries.push(statement);
    if (failAt === state.queries.length) throw new Error('private database details');
    if (statement.includes('DB_NAME()')) return { recordset: [{ databaseName }] };
    if (statement.includes('dbo.schema_migrations')) return { recordset: hasVersion
      ? [{ version: 'v2.001' }, { version: 'v2.002' }, ...(hasPhysicalStatusMigration ? [{ version: 'v2.003' }, { version: 'v2.004' }] : [])]
      : [] };
    return { recordset: [schema] };
  } }; } };
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await checkDatabase({
      getDatabasePool: async () => pool,
      closeDatabasePool: async () => { state.closed += 1; },
      logger: { log(value) { state.logs.push(value); }, error(value) { state.errors.push(value); } }
    });
    state.exitCode = process.exitCode;
    return state;
  } finally {
    process.exitCode = originalExitCode;
  }
}

test('database check verifies only the V2 target and consolidated baseline', async () => {
  const state = await runCheck();
  assert.equal(state.exitCode, undefined);
  assert.equal(state.closed, 1);
  assert.match(state.logs[0], /ARKTIESIIS_V2 connectivity/);
  assert.match(state.queries[1], /v2\.001/);
  assert.match(state.queries[1], /v2\.002/);
  assert.match(state.queries[1], /v2\.003/);
  assert.match(state.queries[1], /v2\.004/);
  assert.match(state.queries[2], /class_schedules/);
  assert.match(state.queries[2], /previous_school_report_card_status_events/);
  assert.match(state.queries[2], /CK_previous_school_report_card_status_status/);
});

test('database check refuses the legacy database context', async () => {
  const state = await runCheck({ databaseName: 'ARKTIESIIS' });
  assert.equal(state.exitCode, 1);
  assert.match(state.errors.join('\n'), /not connected to ARKTIESIIS_V2/);
  assert.equal(state.queries.length, 1);
});

test('database check reports a missing V2 baseline marker or required object', async () => {
  const missingVersion = await runCheck({ hasVersion: false });
  assert.equal(missingVersion.exitCode, 1);
  assert.match(missingVersion.errors.join('\n'), /schema is incomplete/);
  const missingPhysicalMigration = await runCheck({ hasPhysicalStatusMigration: false });
  assert.equal(missingPhysicalMigration.exitCode, 1);
  assert.match(missingPhysicalMigration.errors.join('\n'), /schema is incomplete/);
  const missingObject = await runCheck({ schema: schemaRow({ class_schedules: null }) });
  assert.equal(missingObject.exitCode, 1);
  assert.match(missingObject.errors.join('\n'), /dbo\.class_schedules/);
  const missingLifecycle = await runCheck({ schema: schemaRow({ is_legacy_archive: null }) });
  assert.equal(missingLifecycle.exitCode, 1);
  assert.match(missingLifecycle.errors.join('\n'), /dbo\.documents\.is_legacy_archive/);
  const missingPaperStatus = await runCheck({ schema: schemaRow({ previous_school_report_card_status_events: null }) });
  assert.equal(missingPaperStatus.exitCode, 1);
  assert.match(missingPaperStatus.errors.join('\n'), /dbo\.previous_school_report_card_status_events/);
  const missingRejectedStatus = await runCheck({ schema: schemaRow({ previous_report_card_rejected_status_enabled: 0 }) });
  assert.equal(missingRejectedStatus.exitCode, 1);
  assert.match(missingRejectedStatus.errors.join('\n'), /previous-school report-card paper status vocabulary/);
});

test('V2 baseline is consolidated, isolated, and includes the current prototype tables', () => {
  const schema = fs.readFileSync('database/v2/schema.sql', 'utf8');
  assert.match(schema, /CREATE DATABASE ARKTIESIIS_V2/);
  assert.match(schema, /USE ARKTIESIIS_V2/);
  assert.match(schema, /VALUES \('v2\.001'\)/);
  assert.match(schema, /CREATE TABLE class_schedules/);
  assert.match(schema, /CREATE TABLE teacher_grade_submissions/);
  assert.match(schema, /CREATE TABLE enrollment_clearances/);
  assert.match(schema, /Google Gemini field extraction|Gemini field extraction/);
  assert.doesNotMatch(schema, /INSERT INTO schema_migrations[^;]*VALUES\s*\('\d{3}'\)/i);
  assert.doesNotMatch(schema, /CREATE DATABASE ARKTIESIIS[\s;\n]/);
});
