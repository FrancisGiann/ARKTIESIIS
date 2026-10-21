'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RestatementManifestError,
  buildAllocationPlan,
  buildChargePlan,
  canonicalManifestRows,
  sha256,
  sortedJson,
  uuidV5,
  validateFixedManifest,
  validateManifestRows
} = require('./finance-restatement-manifest');

const APPROVED_MANIFEST_SHA256 = 'df260548ea5c1a467544e53538cceb61bce98e4e40a59ab1bbd7273a79cbedf2';
const APPROVED_PREFLIGHT_SQL_SHA256 = 'aeca492ca6d5b30e89da0888cbb9f0e8e7a553971f0f97a1b13f474a1a9c8f63';
// This script is currently limited to an isolated restored-copy rehearsal database.
// The Hostinger live database is u364362094_arkteisiis and is deliberately rejected.
const REHEARSAL_DB_NAME = 'arktiesiis';
const REHEARSAL_DB_HOST = '127.0.0.1';
const REHEARSAL_DB_PORT = 43317;
const REHEARSAL_DATA_DIRECTORY = path.resolve(os.homedir(), '.codex/arktiesiis-qa/2026-10-21/finance-restatement-distinct-e74/data');
const OPERATION_KIND = 'synthetic_tuition_installments';
const WRITE_CONFIRMATIONS = Object.freeze({ apply: 'APPLY_FIXED_79_TUITION_RESTATEMENT', reverse: 'REVERSE_FIXED_79_TUITION_RESTATEMENT' });
const ALLOWED_WRITE_TABLES = new Set([
  'finance_assessment_restatement_operations',
  'finance_assessment_restatement_annuals',
  'finance_assessment_restatement_events',
  'assessed_charges',
  'finance_payment_allocations',
  'finance_payment_allocation_releases'
]);
const REQUIRED_RESTATEMENT_TRIGGERS = Object.freeze([
  ['trg_finance_restatement_operations_no_update', 'UPDATE', 'finance_assessment_restatement_operations'],
  ['trg_finance_restatement_operations_no_delete', 'DELETE', 'finance_assessment_restatement_operations'],
  ['trg_finance_restatement_annuals_no_update', 'UPDATE', 'finance_assessment_restatement_annuals'],
  ['trg_finance_restatement_annuals_no_delete', 'DELETE', 'finance_assessment_restatement_annuals'],
  ['trg_finance_restatement_events_no_update', 'UPDATE', 'finance_assessment_restatement_events'],
  ['trg_finance_restatement_events_no_delete', 'DELETE', 'finance_assessment_restatement_events']
]);

class MaintenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MaintenanceError';
  }
}

function parseArguments(argv) {
  const allowed = new Set([
    'mode', 'expected-db', 'preflight-sql', 'manifest', 'manifest-sha256',
    'operation-id', 'idempotency-key', 'actor-id', 'reason', 'confirm-write'
  ]);
  const args = {};
  for (const token of argv) {
    const match = /^--([a-z0-9-]+)=(.*)$/.exec(token);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(args, match[1])) {
      throw new MaintenanceError('Use the documented finance restatement options; no database operation was started.');
    }
    args[match[1]] = match[2];
  }
  args.mode ||= 'preflight';
  if (!['preflight', 'dry-run', 'apply', 'reverse'].includes(args.mode)) throw new MaintenanceError('Choose a supported restatement mode.');
  const env = require('../src/config/environment');
  assertRehearsalConfiguration(env.database);
  if (args['expected-db'] !== REHEARSAL_DB_NAME || env.database.database !== REHEARSAL_DB_NAME) {
    throw new MaintenanceError('The explicit expected database and configured database must both match the isolated rehearsal database.');
  }
  if (args['manifest-sha256'] !== APPROVED_MANIFEST_SHA256) throw new MaintenanceError('The approved manifest digest does not match.');
  for (const key of ['preflight-sql', 'manifest']) {
    if (!args[key]) throw new MaintenanceError(`The ${key} file is required.`);
  }
  if (['dry-run', 'apply', 'reverse'].includes(args.mode)) validateUuid(args['operation-id'], 'operation');
  if (['apply', 'reverse'].includes(args.mode)) {
    validateUuid(args['idempotency-key'], 'idempotency');
    if (!/^[1-9]\d{0,9}$/.test(args['actor-id'] || '')) throw new MaintenanceError('A valid authorized actor ID is required.');
    args['actor-id'] = Number(args['actor-id']);
    args.reason = validateReason(args.reason);
    if (args['confirm-write'] !== WRITE_CONFIRMATIONS[args.mode]) {
      throw new MaintenanceError('The explicit write-mode confirmation does not match the selected operation.');
    }
  }
  return args;
}

function assertRehearsalConfiguration(databaseConfig) {
  if (databaseConfig?.host !== REHEARSAL_DB_HOST
    || Number(databaseConfig?.port) !== REHEARSAL_DB_PORT
    || databaseConfig?.database !== REHEARSAL_DB_NAME
    || Boolean(databaseConfig?.socketPath)) {
    throw new MaintenanceError('The finance restatement script only permits the approved private loopback rehearsal database.');
  }
}

function validateUuid(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new MaintenanceError(`A valid ${label} UUID is required.`);
  }
}

function validateReason(value) {
  if (typeof value !== 'string') throw new MaintenanceError('A reason is required.');
  const reason = value.trim();
  if (reason.length < 5 || reason.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
    throw new MaintenanceError('The reason must contain 5–1000 printable characters.');
  }
  return reason;
}

function readFile(filePath, label) {
  try {
    return fs.readFileSync(path.resolve(filePath), 'utf8');
  } catch {
    throw new MaintenanceError(`The approved ${label} file could not be read.`);
  }
}

function loadApprovedInputs(args) {
  let manifest;
  let manifestText;
  try {
    manifestText = readFile(args.manifest, 'fixed-cohort manifest');
    manifest = JSON.parse(manifestText);
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('The fixed-cohort manifest is not valid JSON.');
  }
  const validated = validateFixedManifest(manifest, APPROVED_MANIFEST_SHA256);
  const sqlText = readFile(args['preflight-sql'], 'fixed-cohort preflight SQL');
  if (sha256(sqlText) !== APPROVED_PREFLIGHT_SQL_SHA256) throw new MaintenanceError('The fixed-cohort preflight SQL digest does not match the approved query.');
  return { manifest, manifestText, validated, sqlText };
}

function countSqlStatementTerminators(sqlText) {
  let count = 0;
  let quote = null;
  for (let index = 0; index < sqlText.length; index += 1) {
    const character = sqlText[index];
    const next = sqlText[index + 1];
    if (quote) {
      if (character === '\\') { index += 1; continue; }
      if (character === quote) {
        if (next === quote) { index += 1; continue; }
        quote = null;
      }
      continue;
    }
    if (character === '-' && next === '-' && /\s/.test(sqlText[index + 2] || '')) {
      index += 2;
      while (index + 1 < sqlText.length && sqlText[index + 1] !== '\n') index += 1;
      continue;
    }
    if (character === '#') {
      while (index + 1 < sqlText.length && sqlText[index + 1] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const closing = sqlText.indexOf('*/', index + 2);
      if (closing < 0) return Infinity;
      index = closing + 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if (character === ';') count += 1;
  }
  return quote ? Infinity : count;
}

function extractManifestSelect(sqlText) {
  const startMarker = 'WITH expected_annuals AS (';
  const orderMarker = 'ORDER BY sort_group, ordinal, row_id;';
  const rollbackMarker = '\n\nROLLBACK;';
  const start = sqlText.indexOf(startMarker);
  const end = sqlText.lastIndexOf(rollbackMarker);
  const wrapper = 'SET SESSION max_statement_time = 5;\nSTART TRANSACTION READ ONLY;\n\n';
  if (start < 0 || end < 0 || sqlText.indexOf(startMarker, start + startMarker.length) !== -1
    || !sqlText.slice(0, start).endsWith(wrapper)
    || !/^\n\nROLLBACK;\s*$/.test(sqlText.slice(end))) {
    throw new MaintenanceError('The approved manifest SQL wrapper is not in the expected read-only form.');
  }
  const selectWithTerminator = sqlText.slice(start, end);
  if (!selectWithTerminator.startsWith(startMarker)
    || !selectWithTerminator.endsWith(orderMarker)
    || countSqlStatementTerminators(selectWithTerminator) !== 1) {
    throw new MaintenanceError('The approved manifest body must contain exactly one bounded SELECT statement.');
  }
  const select = selectWithTerminator.slice(0, -1).trim();
  if (!/^WITH\s+expected_annuals\s+AS\s*\(/i.test(select)
    || !/\bSELECT\s+manifest_row\s+FROM\s+manifest_rows\s+ORDER\s+BY\s+sort_group,\s*ordinal,\s*row_id$/i.test(select)) {
    throw new MaintenanceError('The approved manifest body is not the expected canonical SELECT.');
  }
  return select;
}

async function assertExpectedDatabase(connection) {
  const [rows] = await connection.query('SELECT DATABASE() AS selected_database, @@port AS server_port, @@datadir AS server_data_directory');
  if (rows[0]?.selected_database !== REHEARSAL_DB_NAME
    || Number(rows[0]?.server_port) !== REHEARSAL_DB_PORT
    || path.resolve(String(rows[0]?.server_data_directory || '')) !== REHEARSAL_DATA_DIRECTORY) {
    throw new MaintenanceError('The finance restatement connection is not the approved private rehearsal instance; operation stopped.');
  }
}

async function assertSelectedSchema(connection, expectedSchema) {
  if (!/^[A-Za-z0-9_]+$/.test(String(expectedSchema || ''))) {
    throw new MaintenanceError('The selected finance restatement database schema is invalid.');
  }
  const [rows] = await connection.query('SELECT DATABASE() AS selected_database');
  if (rows[0]?.selected_database !== expectedSchema) {
    throw new MaintenanceError('The selected database does not match the expected finance restatement schema.');
  }
}

async function inspectMigrationPrerequisites(connection, expectedSchema = REHEARSAL_DB_NAME) {
  if (!/^[A-Za-z0-9_]+$/.test(String(expectedSchema || ''))) {
    throw new MaintenanceError('The selected finance restatement database schema is invalid.');
  }
  await assertSelectedSchema(connection, expectedSchema);
  const [versions] = await connection.execute(`SELECT version FROM schema_migrations WHERE version IN ('v2.023', 'v2.024') ORDER BY version`);
  const tables = [...new Set(REQUIRED_RESTATEMENT_TRIGGERS.map(([, , table]) => table))];
  const tablePlaceholders = tables.map(() => '?').join(', ');
  const [triggers] = await connection.execute(`SELECT trigger_name, event_manipulation, event_object_table, action_timing, action_statement
    FROM information_schema.triggers WHERE trigger_schema = ?
      AND event_object_table IN (${tablePlaceholders}) ORDER BY trigger_name`, [expectedSchema, ...tables]);
  const expected = new Map(REQUIRED_RESTATEMENT_TRIGGERS.map(([name, event, table]) => [name, { event, table }]));
  const triggerSetReady = triggers.length === REQUIRED_RESTATEMENT_TRIGGERS.length && !triggers.some((trigger) => {
    const spec = expected.get(trigger.trigger_name);
    const action = String(trigger.action_statement || '').replace(/\s+/g, ' ').replace(/;$/, '').trim();
    return !spec || trigger.event_manipulation !== spec.event || trigger.event_object_table !== spec.table
      || trigger.action_timing !== 'BEFORE'
      || !/^SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance restatement history is append-only'$/i.test(action);
  });
  const installedMigrations = versions.map((row) => row.version);
  const migrationsReady = installedMigrations.length === 2
    && installedMigrations[0] === 'v2.023' && installedMigrations[1] === 'v2.024';
  return {
    expectedSchema,
    installedMigrations,
    migrationsReady,
    triggerCount: triggers.length,
    triggerSetReady
  };
}

async function assertMigrationPrerequisites(connection, expectedSchema = REHEARSAL_DB_NAME) {
  const readiness = await inspectMigrationPrerequisites(connection, expectedSchema);
  if (!readiness.migrationsReady) {
    throw new MaintenanceError('The required reviewed v2.023 companion and finance v2.024 migration are not both installed.');
  }
  if (!readiness.triggerSetReady) {
    throw new MaintenanceError('The exact six immutable finance restatement triggers are not present on the approved database.');
  }
  return readiness;
}

function parseMysqlAccountIdentity(value) {
  const text = String(value || '').trim();
  const quoted = /^'((?:''|[^'])*)'@'((?:''|[^'])*)'$/.exec(text);
  if (quoted) return { user: quoted[1].replace(/''/g, "'"), host: quoted[2].replace(/''/g, "'") };
  const separator = text.lastIndexOf('@');
  if (separator < 1 || separator === text.length - 1) return null;
  return { user: text.slice(0, separator), host: text.slice(separator + 1) };
}

function hasDirectSchemaPrivilege(rows, currentUser, expectedSchema, privilegeType) {
  const current = parseMysqlAccountIdentity(currentUser);
  if (!current || !Array.isArray(rows)) return false;
  return rows.some((row) => {
    const grantee = parseMysqlAccountIdentity(row.grantee ?? row.GRANTEE);
    return String(row.table_schema ?? row.TABLE_SCHEMA ?? '') === expectedSchema
      && String(row.privilege_type ?? row.PRIVILEGE_TYPE ?? '').toUpperCase() === privilegeType.toUpperCase()
      && grantee?.user === current.user && grantee?.host === current.host;
  });
}

async function assertTriggerPrivilege(connection, expectedSchema = REHEARSAL_DB_NAME) {
  if (!/^[A-Za-z0-9_]+$/.test(String(expectedSchema || ''))) {
    throw new MaintenanceError('The configured maintenance principal lacks a confirmed direct TRIGGER privilege on the approved database. No privilege was changed.');
  }
  const [[identity]] = await connection.query('SELECT CURRENT_USER() AS authenticated_account');
  const [rows] = await connection.execute(`SELECT TABLE_SCHEMA AS table_schema, GRANTEE AS grantee, PRIVILEGE_TYPE AS privilege_type
    FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = ? AND PRIVILEGE_TYPE = ?`, [expectedSchema, 'TRIGGER']);
  const hasDirectTriggerPrivilege = hasDirectSchemaPrivilege(rows, identity?.authenticated_account, expectedSchema, 'TRIGGER');
  if (!hasDirectTriggerPrivilege) {
    throw new MaintenanceError('The configured maintenance principal lacks a confirmed direct TRIGGER privilege on the approved database. No privilege was changed.');
  }
}

async function assertAuthorizedActor(connection, actorId) {
  const [rows] = await connection.execute('SELECT id, role, is_active FROM users WHERE id = ? LIMIT 1 FOR UPDATE', [actorId]);
  if (rows.length !== 1 || Number(rows[0].is_active) !== 1 || !['finance', 'database_admin'].includes(rows[0].role)) {
    throw new MaintenanceError('The recorded actor must be an active Finance or database administrator account. No account state was changed.');
  }
}

function parseManifestResult(rows) {
  return rows.map((row) => {
    const value = row.manifest_row ?? row.MANIFEST_ROW;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { throw new MaintenanceError('The fixed-cohort preflight returned an invalid manifest row.'); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new MaintenanceError('The fixed-cohort preflight returned an unexpected result shape.');
    }
    return value;
  });
}

async function queryFreshManifest(connection, sqlText) {
  const [rows] = await connection.query(extractManifestSelect(sqlText));
  return parseManifestResult(rows);
}

function idList(rows, key) {
  return [...new Set(rows.map((row) => Number(row[key])))].sort((a, b) => a - b);
}

function placeholders(ids) {
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new MaintenanceError('A locked manifest ID list is invalid.');
  return ids.map(() => '?').join(', ');
}

async function executeAllowedWrite(connection, table, statement, values) {
  const match = /^\s*(?:INSERT\s+INTO|UPDATE)\s+([a-z_][a-z0-9_]*)\b/i.exec(statement);
  if (!ALLOWED_WRITE_TABLES.has(table) || !match || match[1].toLowerCase() !== table) {
    throw new MaintenanceError('A maintenance write target is outside the fixed allowlist.');
  }
  return connection.execute(statement, values);
}

async function assertSingleRowWrite(promise) {
  const [result] = await promise;
  if (Number(result.affectedRows) !== 1) throw new MaintenanceError('A fixed-cohort row changed while the transaction was applying; the operation stopped.');
}

async function lockIds(connection, table, column, ids) {
  if (!ALLOWED_LOCK_TABLES.has(table)) throw new MaintenanceError('An internal lock table was not approved.');
  const [rows] = await connection.execute(`SELECT ${column} AS id FROM ${table} WHERE ${column} IN (${placeholders(ids)}) ORDER BY ${column} FOR UPDATE`, ids);
  if (rows.length !== ids.length) throw new MaintenanceError(`A fixed-cohort ${table} row is missing.`);
}

const ALLOWED_LOCK_TABLES = new Set([
  'students', 'enrollments', 'annual_enrollments', 'annual_assessments', 'annual_registrar_confirmations',
  'assessed_charges', 'finance_payments', 'finance_allocation_batches',
  'finance_payment_allocations', 'finance_schedules', 'finance_schedule_lines'
]);

function assertIdSet(actualIds, expectedIds, label) {
  const normalized = (values) => [...new Set(values.map(Number))].sort((left, right) => left - right);
  if (sortedJson(normalized(actualIds)) !== sortedJson(normalized(expectedIds))) {
    throw new MaintenanceError(`The fixed-cohort ${label} set changed; the operation stopped for reconciliation.`);
  }
}

async function lockFixedManifest(connection, groups, { operationId = null } = {}) {
  const annualIds = idList(groups.get('annual-and-confirmation'), 'annualId');
  const expectedStudentRows = await connection.execute(`SELECT id, student_id FROM annual_enrollments
    WHERE id IN (${placeholders(annualIds)}) ORDER BY id`, annualIds);
  const ownerRows = expectedStudentRows[0];
  if (ownerRows.length !== annualIds.length) throw new MaintenanceError('A fixed-cohort annual enrollment is missing.');
  const ownerByAnnual = new Map(ownerRows.map((row) => [Number(row.id), Number(row.student_id)]));
  const studentIds = [...new Set(ownerRows.map((row) => Number(row.student_id)))].sort((left, right) => left - right);

  // Match finance mutation lock order: student, annual, term, assessment, account, payment, charge.
  await lockIds(connection, 'students', 'id', studentIds);
  await lockIds(connection, 'annual_enrollments', 'id', annualIds);
  const [lockedAnnuals] = await connection.execute(`SELECT id, student_id FROM annual_enrollments
    WHERE id IN (${placeholders(annualIds)}) ORDER BY id FOR UPDATE`, annualIds);
  if (lockedAnnuals.length !== ownerRows.length || lockedAnnuals.some((row) => ownerByAnnual.get(Number(row.id)) !== Number(row.student_id))) {
    throw new MaintenanceError('A fixed-cohort annual enrollment changed owners while locks were acquired.');
  }
  const expectedEnrollmentIds = idList(groups.get('expected-expansion-charge').filter((row) => row.chargeEnrollmentId != null), 'chargeEnrollmentId');
  const [enrollments] = await connection.execute(`SELECT id FROM enrollments
    WHERE annual_enrollment_id IN (${placeholders(annualIds)}) ORDER BY id FOR UPDATE`, annualIds);
  assertIdSet(enrollments.map((row) => row.id), expectedEnrollmentIds, 'term enrollment');
  const [assessments] = await connection.execute(`SELECT id FROM annual_assessments
    WHERE annual_enrollment_id IN (${placeholders(annualIds)}) ORDER BY id FOR UPDATE`, annualIds);
  assertIdSet(assessments.map((row) => row.id), idList(groups.get('annual-and-confirmation'), 'assessmentId'), 'assessment');
  const [confirmations] = await connection.execute(`SELECT id FROM annual_registrar_confirmations
    WHERE annual_enrollment_id IN (${placeholders(annualIds)}) ORDER BY id FOR UPDATE`, annualIds);
  assertIdSet(confirmations.map((row) => row.id), idList(groups.get('annual-and-confirmation'), 'confirmationId'), 'Registrar confirmation');
  await connection.execute(`SELECT id FROM financial_accounts WHERE student_id IN (${placeholders(studentIds)}) ORDER BY id FOR UPDATE`, studentIds);
  const [payments] = await connection.execute(`SELECT id FROM finance_payments
    WHERE student_id IN (${placeholders(studentIds)}) ORDER BY id FOR UPDATE`, studentIds);
  assertIdSet(payments.map((row) => row.id), idList(groups.get('cohort-student-payment'), 'paymentId'), 'student payment');
  const paymentIds = payments.map((row) => Number(row.id));

  const [charges] = await connection.execute(`SELECT id FROM assessed_charges
    WHERE annual_enrollment_id IN (${placeholders(annualIds)}) ORDER BY id FOR UPDATE`, annualIds);
  const chargeIds = charges.map((row) => Number(row.id));
  const expectedChargeIds = idList(groups.get('expected-expansion-charge'), 'chargeId');
  if (!operationId) assertIdSet(chargeIds, expectedChargeIds, 'assessed charge');
  else if (expectedChargeIds.some((id) => !chargeIds.includes(id))) throw new MaintenanceError('A source fixed-cohort charge is missing.');

  await connection.execute(`SELECT id FROM finance_charge_adjustments
    WHERE charge_id IN (${placeholders(chargeIds)}) ORDER BY id FOR UPDATE`, chargeIds);
  const [allocations] = await connection.execute(`SELECT id FROM finance_payment_allocations
    WHERE payment_id IN (${placeholders(paymentIds)}) OR charge_id IN (${placeholders(chargeIds)}) ORDER BY id FOR UPDATE`, [...paymentIds, ...chargeIds]);
  const allocationIds = allocations.map((row) => Number(row.id));
  if (!operationId) assertIdSet(allocationIds, idList(groups.get('cohort-payment-allocation'), 'allocationId'), 'payment allocation');
  await connection.execute(`SELECT id FROM finance_allocation_batches
    WHERE payment_id IN (${placeholders(paymentIds)}) ORDER BY id FOR UPDATE`, paymentIds);
  await connection.execute(`SELECT id FROM finance_payment_allocation_releases
    WHERE allocation_id IN (${placeholders(allocationIds)}) ORDER BY id FOR UPDATE`, allocationIds);
  const [legacyRows] = await connection.execute(`SELECT id FROM finance_legacy_reconciliations
    WHERE charge_id IN (${placeholders(chargeIds)}) ORDER BY id FOR UPDATE`, chargeIds);
  const reconciliationIds = legacyRows.map((row) => Number(row.id));
  if (reconciliationIds.length) await connection.execute(`SELECT id FROM finance_legacy_reconciliation_releases
    WHERE reconciliation_id IN (${placeholders(reconciliationIds)}) ORDER BY id FOR UPDATE`, reconciliationIds);
  await connection.execute(`SELECT id FROM finance_exemption_applications
    WHERE charge_id IN (${placeholders(chargeIds)}) ORDER BY id FOR UPDATE`, chargeIds);
  await connection.execute(`SELECT id FROM finance_legacy_opening_charges
    WHERE student_id IN (${placeholders(studentIds)}) ORDER BY id FOR UPDATE`, studentIds);
  await connection.execute(`SELECT reversal.id FROM finance_payment_reversals AS reversal
    INNER JOIN finance_payments AS payment ON payment.id = reversal.payment_id
    WHERE payment.student_id IN (${placeholders(studentIds)}) ORDER BY reversal.id FOR UPDATE`, studentIds);

  await lockIds(connection, 'finance_schedules', 'id', idList(groups.get('annual-and-confirmation'), 'sourceScheduleId'));
  await lockIds(connection, 'finance_schedules', 'id', idList(groups.get('configured-target-v2-line'), 'scheduleId'));
  await lockIds(connection, 'finance_schedule_lines', 'id', idList(groups.get('configured-target-v2-line'), 'scheduleLineId'));
  await lockIds(connection, 'finance_schedule_lines', 'id', idList(groups.get('expected-expansion-charge').filter((row) => row.scheduleLineId != null), 'scheduleLineId'));
}

async function rowsById(connection, table, ids, sqlText) {
  if (!ALLOWED_SOURCE_TABLES.has(table)) throw new MaintenanceError('An internal snapshot table was not approved.');
  const [rows] = await connection.execute(`${sqlText} WHERE id IN (${placeholders(ids)}) ORDER BY id`, ids);
  if (rows.length !== ids.length) throw new MaintenanceError(`The fixed-cohort ${table} snapshot is incomplete.`);
  return rows;
}

const ALLOWED_SOURCE_TABLES = new Set([
  'enrollments', 'annual_enrollments', 'annual_assessments', 'annual_registrar_confirmations',
  'assessed_charges', 'finance_payments', 'finance_allocation_batches', 'finance_payment_allocations',
  'finance_schedules', 'finance_schedule_lines'
]);

async function loadBeforeState(connection, groups) {
  const annuals = groups.get('annual-and-confirmation');
  const charges = groups.get('expected-expansion-charge');
  const payments = groups.get('cohort-student-payment');
  const allocations = groups.get('cohort-payment-allocation');
  const targetLines = groups.get('configured-target-v2-line');
  const sourceCharges = charges;
  const annualRows = await rowsById(connection, 'annual_enrollments', idList(annuals, 'annualId'),
    'SELECT id, student_id, school_year, grade_level, voucher_code, entry_term_number, intake_status, created_at, idempotency_key, request_fingerprint FROM annual_enrollments');
  const assessmentRows = await rowsById(connection, 'annual_assessments', idList(annuals, 'assessmentId'),
    'SELECT id, annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by, assessed_at, selection_json, idempotency_key, request_fingerprint FROM annual_assessments');
  const confirmationRows = await rowsById(connection, 'annual_registrar_confirmations', idList(annuals, 'confirmationId'),
    'SELECT id, annual_enrollment_id, student_id, school_year, grade_level, entry_enrollment_id, assessment_id, schedule_id, schedule_version, voucher_code_snapshot, payable_total, selection_json, assessment_snapshot_fingerprint, confirmed_by, idempotency_key, request_fingerprint, confirmed_at, finance_review_id, entry_dp_state_at_confirmation FROM annual_registrar_confirmations');
  const enrollmentRows = await rowsById(connection, 'enrollments', idList(sourceCharges.filter((row) => row.chargeEnrollmentId != null), 'chargeEnrollmentId'),
    'SELECT id, annual_enrollment_id, annual_term_number FROM enrollments');
  const chargeRows = await rowsById(connection, 'assessed_charges', idList(charges, 'chargeId'),
    'SELECT id, assessment_id, annual_enrollment_id, enrollment_id, schedule_line_id, fee_category, line_name, installment, amount, gross_amount, waived_amount, is_manual, reason, idempotency_key, request_fingerprint, created_at, special_subject_id, synthetic_restatement_operation_id, synthetic_restatement_role FROM assessed_charges');
  const paymentRows = await rowsById(connection, 'finance_payments', idList(payments, 'paymentId'),
    'SELECT id, student_id, amount, payment_date, reference_no, receipt_issued, idempotency_key, request_fingerprint, recorded_by, created_at, is_reversed, reverses_payment_id FROM finance_payments');
  const batchRows = await rowsById(connection, 'finance_allocation_batches', idList(allocations, 'allocationBatchId'),
    'SELECT id, payment_id, student_id, idempotency_key, request_fingerprint, allocated_by, created_at FROM finance_allocation_batches');
  const allocationRows = await rowsById(connection, 'finance_payment_allocations', idList(allocations, 'allocationId'),
    'SELECT id, payment_id, charge_id, legacy_opening_charge_id, amount, allocation_batch_id, allocated_by, created_at, synthetic_restatement_operation_id, synthetic_restatement_kind FROM finance_payment_allocations');
  const scheduleRows = await rowsById(connection, 'finance_schedules', idList(targetLines, 'scheduleId'),
    'SELECT id, school_year, grade_level, voucher_code, version_no, status, idempotency_key, request_fingerprint FROM finance_schedules');
  const targetLineRows = await rowsById(connection, 'finance_schedule_lines', idList(targetLines, 'scheduleLineId'),
    'SELECT id, schedule_id, term_number, fee_category, line_name, installment, amount, is_optional FROM finance_schedule_lines');
  const sourceScheduleLineIds = idList(sourceCharges.filter((row) => row.scheduleLineId != null), 'scheduleLineId');
  let sourceScheduleLineRows = [];
  if (sourceScheduleLineIds.length) {
    [sourceScheduleLineRows] = await connection.execute(`SELECT id, schedule_id, term_number, fee_category, line_name, installment, amount, is_optional
      FROM finance_schedule_lines WHERE id IN (${placeholders(sourceScheduleLineIds)}) ORDER BY id FOR UPDATE`, sourceScheduleLineIds);
    if (sourceScheduleLineRows.length !== sourceScheduleLineIds.length) throw new MaintenanceError('A source schedule line disappeared from the fixed before-image.');
  }
  const sourceScheduleRows = await rowsById(connection, 'finance_schedules', idList(annuals, 'sourceScheduleId'),
    'SELECT id, school_year, grade_level, voucher_code, version_no, status, idempotency_key, request_fingerprint FROM finance_schedules');
  const chargeIds = idList(charges, 'chargeId');
  const allocationIds = idList(allocations, 'allocationId');
  const [adjustments] = await connection.execute(`SELECT id, charge_id, amount, reason, reverses_adjustment_id, idempotency_key, request_fingerprint, exemption_application_id, recorded_by, created_at FROM finance_charge_adjustments WHERE charge_id IN (${placeholders(chargeIds)}) ORDER BY id FOR UPDATE`, chargeIds);
  const [legacy] = await connection.execute(`SELECT id, transaction_id, charge_id, amount, reason, batch_id, recorded_by, created_at FROM finance_legacy_reconciliations WHERE charge_id IN (${placeholders(chargeIds)}) ORDER BY id FOR UPDATE`, chargeIds);
  const legacyIds = legacy.map((row) => Number(row.id));
  let legacyReleases = [];
  if (legacyIds.length) [legacyReleases] = await connection.execute(`SELECT id, reconciliation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by, created_at FROM finance_legacy_reconciliation_releases WHERE reconciliation_id IN (${placeholders(legacyIds)}) ORDER BY id FOR UPDATE`, legacyIds);
  const [releaseRows] = await connection.execute(`SELECT id, allocation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by, created_at, synthetic_restatement_operation_id FROM finance_payment_allocation_releases WHERE allocation_id IN (${placeholders(allocationIds)}) ORDER BY id FOR UPDATE`, allocationIds);
  const [exemptionApplications] = await connection.execute(`SELECT id, exemption_rule_id, charge_id, amount, applied_at FROM finance_exemption_applications WHERE charge_id IN (${placeholders(chargeIds)}) ORDER BY id FOR UPDATE`, chargeIds);
  const assessmentIds = idList(annuals, 'assessmentId');
  const annualIds = idList(annuals, 'annualId');
  const [exemptionCases] = await connection.execute(`SELECT id, annual_enrollment_id, status, idempotency_key,
      request_fingerprint, created_at, reviewed_at
    FROM finance_exemption_cases WHERE annual_enrollment_id IN (${placeholders(annualIds)}) ORDER BY id FOR UPDATE`, annualIds);
  const exemptionCaseIds = exemptionCases.map((row) => Number(row.id));
  const [exemptionRules] = exemptionCaseIds.length
    ? await connection.execute(`SELECT id, exemption_case_id, term_number, fee_category, line_name,
        is_full_coverage, approved_amount, created_at
      FROM finance_exemption_rules WHERE exemption_case_id IN (${placeholders(exemptionCaseIds)}) ORDER BY id FOR UPDATE`, exemptionCaseIds)
    : [[]];
  const [reviews] = await connection.execute(`SELECT id, annual_enrollment_id, assessment_id FROM annual_finance_assessment_reviews WHERE assessment_id IN (${placeholders(assessmentIds)}) ORDER BY id`, assessmentIds);
  const [departures] = await connection.execute(`SELECT id, annual_enrollment_id FROM finance_departure_cases WHERE annual_enrollment_id IN (${placeholders(annualIds)}) ORDER BY id`, annualIds);
  if (reviews.length || departures.length) throw new MaintenanceError('A fixed-cohort row has a Finance review or departure state requiring separate reconciliation.');
  return {
    annualRows, assessmentRows, confirmationRows, enrollmentRows, chargeRows, paymentRows, batchRows,
    allocationRows, scheduleRows, sourceScheduleRows, targetLineRows, sourceScheduleLineRows,
    adjustments, legacy, legacyReleases, releaseRows, exemptionApplications, exemptionCases, exemptionRules,
    reviewCount: reviews.length, departureCount: departures.length
  };
}

function assertBeforeStateEligibility(state, groups) {
  const fixedChargeIds = new Set(groups.get('expected-expansion-charge').map((row) => Number(row.chargeId)));
  if (fixedChargeIds.size !== 474 || !Array.isArray(state.chargeRows) || state.chargeRows.length !== fixedChargeIds.size
    || state.chargeRows.some((row) => !fixedChargeIds.has(Number(row.id)))) {
    throw new MaintenanceError('The fixed-cohort source charge set is incomplete or changed.');
  }
  // The frozen read-only cohort audit recorded no adjustment, release, exemption, or legacy rows.
  // These tables are outside the manifest, so any row on the 474 source charges is drift.
  const evidenceSets = [
    state.adjustments,
    state.releaseRows,
    state.exemptionApplications,
    state.exemptionCases,
    state.exemptionRules,
    state.legacy,
    state.legacyReleases
  ];
  if (evidenceSets.some((rows) => !Array.isArray(rows) || rows.length !== 0)) {
    throw new MaintenanceError('A fixed-cohort adjustment, release, exemption, or legacy record differs from the approved zero-evidence baseline.');
  }
  const sourceTuitionIds = new Set(groups.get('expected-expansion-charge')
    .filter((row) => row.expectedCategory === 'tuition').map((row) => Number(row.chargeId)));
  for (const charge of state.chargeRows) {
    if (charge.synthetic_restatement_operation_id != null || charge.synthetic_restatement_role != null) throw new MaintenanceError('A source charge already belongs to another restatement operation.');
    if (sourceTuitionIds.has(Number(charge.id))) {
      if (Number(charge.is_manual) !== 0 || Number(charge.waived_amount) !== 0 || Number(charge.gross_amount) !== Number(charge.amount)
        || charge.special_subject_id != null) {
        throw new MaintenanceError('A source tuition charge has a waiver, manual item, or special-subject link.');
      }
    }
  }
  if (state.allocationRows.some((row) => row.synthetic_restatement_operation_id != null)) {
    throw new MaintenanceError('A fixed-cohort allocation or legacy row has unsupported release/restatement history.');
  }
  if (state.annualRows.some((row) => row.intake_status !== 'enrolled')) throw new MaintenanceError('A fixed annual is no longer in the approved enrolled state.');
  if (state.assessmentRows.some((row) => Number(row.schedule_version) !== 1)
    || state.confirmationRows.some((row) => !row.assessment_snapshot_fingerprint)) {
    throw new MaintenanceError('The original assessment or Registrar confirmation no longer matches the reviewed source state.');
  }
}

function byId(rows) { return new Map(rows.map((row) => [Number(row.id), row])); }

function buildAnnualArchives(state, groups, validated, chargePlan, allocationPlan) {
  const annuals = byId(state.annualRows);
  const assessments = byId(state.assessmentRows);
  const confirmations = byId(state.confirmationRows);
  const payments = byId(state.paymentRows);
  const batches = byId(state.batchRows);
  const targetLinesBySchedule = new Map();
  for (const line of state.targetLineRows) {
    if (!targetLinesBySchedule.has(Number(line.schedule_id))) targetLinesBySchedule.set(Number(line.schedule_id), []);
    targetLinesBySchedule.get(Number(line.schedule_id)).push(line);
  }
  return groups.get('annual-and-confirmation').map((manifestAnnual) => {
    const annualId = Number(manifestAnnual.annualId);
    const assessmentId = Number(manifestAnnual.assessmentId);
    const confirmationId = Number(manifestAnnual.confirmationId);
    const annual = annuals.get(annualId);
    const assessment = assessments.get(assessmentId);
    const confirmation = confirmations.get(confirmationId);
    const originalCharges = state.chargeRows.filter((row) => Number(row.annual_enrollment_id) === annualId);
    const originalChargeIds = new Set(originalCharges.map((row) => Number(row.id)));
    const originalAllocations = state.allocationRows.filter((row) => originalChargeIds.has(Number(row.charge_id)));
    const originalPaymentIds = new Set(originalAllocations.map((row) => Number(row.payment_id)));
    const sourceScheduleId = Number(assessment.schedule_id);
    const targetScheduleId = validated.lines.find((line) => line.grade === manifestAnnual.annualGrade
      && line.voucher === manifestAnnual.annualVoucher)?.scheduleId;
    const beforeImage = {
      annual, assessment, confirmation, charges: originalCharges,
      enrollments: state.enrollmentRows.filter((row) => originalCharges.some((charge) => Number(charge.enrollment_id) === Number(row.id))),
      sourceScheduleLines: state.sourceScheduleLineRows.filter((line) => originalCharges.some((charge) => Number(charge.schedule_line_id) === Number(line.id))),
      exemptionApplications: state.exemptionApplications.filter((application) => originalChargeIds.has(Number(application.charge_id))),
      adjustments: state.adjustments.filter((row) => originalChargeIds.has(Number(row.charge_id))),
      legacyReconciliations: state.legacy.filter((row) => originalChargeIds.has(Number(row.charge_id))),
      legacyReleases: [],
      payments: state.paymentRows.filter((row) => originalPaymentIds.has(Number(row.id))),
      allocationBatches: state.batchRows.filter((row) => originalAllocations.some((allocation) => Number(allocation.allocation_batch_id) === Number(row.id))),
      allocations: originalAllocations,
      allocationReleases: state.releaseRows.filter((row) => originalAllocations.some((allocation) => Number(allocation.id) === Number(row.allocation_id))),
      sourceSchedule: state.sourceScheduleRows.find((row) => Number(row.id) === sourceScheduleId),
      targetSchedule: state.scheduleRows.find((row) => Number(row.id) === Number(targetScheduleId)),
      targetTuitionLines: targetLinesBySchedule.get(Number(targetScheduleId)) || []
    };
    beforeImage.legacyReleases = state.legacyReleases.filter((row) => beforeImage.legacyReconciliations.some((reconciliation) => Number(reconciliation.id) === Number(row.reconciliation_id)));
    const operationChargePlan = {
      sourceTuitionChargeIds: chargePlan.sources.filter((row) => row.annualId === annualId).map((row) => row.chargeId),
      generatedTuition: chargePlan.generated.filter((row) => row.annualId === annualId)
        .map((row) => ({ sourceChargeId: row.sourceChargeId, term: row.term,
          scheduleLineId: Number(row.line.scheduleLineId), installment: row.line.installment,
          amount: String(row.line.amount), idempotencyKey: row.idempotencyKey }))
    };
    const operationAllocationPlan = allocationPlan.filter((row) => row.annualId === annualId);
    const beforeJson = sortedJson(beforeImage);
    return {
      annualId, assessmentId, confirmationId,
      sourceScheduleId, sourceScheduleVersion: Number(assessment.schedule_version),
      targetScheduleId: Number(targetScheduleId), targetScheduleVersion: 2,
      beforeImage, beforeJson, beforeSha256: sha256(beforeJson),
      operationChargePlan, operationAllocationPlan
    };
  });
}

function operationRequestFingerprint(operationId, manifestDigest, targetDigest) {
  return sha256(sortedJson({ operationId, operationKind: OPERATION_KIND, manifestDigest, targetDigest }));
}

function moneyToCents(value) {
  const text = String(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new MaintenanceError('A database amount is not a valid cent value.');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

function centsToMoney(cents) {
  const abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

async function currentMetrics(connection, groups) {
  const annualIds = idList(groups.get('annual-and-confirmation'), 'annualId');
  const paymentIds = idList(groups.get('cohort-student-payment'), 'paymentId');
  const [termRows] = await connection.execute(`SELECT due.annual_enrollment_id, enrollment.annual_term_number AS term_number,
      CAST(SUM(due.amount_due) AS CHAR(40)) AS balance
    FROM v_finance_assessed_charge_due AS due
    INNER JOIN enrollments AS enrollment ON enrollment.id = due.enrollment_id
    WHERE due.annual_enrollment_id IN (${placeholders(annualIds)})
    GROUP BY due.annual_enrollment_id, enrollment.annual_term_number
    ORDER BY due.annual_enrollment_id, enrollment.annual_term_number`, annualIds);
  const [paymentRows] = await connection.execute(`SELECT payment.id, payment.amount, payment.is_reversed,
      CAST(COALESCE(SUM(allocation.net_amount), 0) AS CHAR(40)) AS applied
    FROM finance_payments AS payment
    LEFT JOIN v_finance_net_payment_allocations AS allocation ON allocation.payment_id = payment.id
    WHERE payment.id IN (${placeholders(paymentIds)})
    GROUP BY payment.id, payment.amount, payment.is_reversed
    ORDER BY payment.id`, paymentIds);
  return {
    terms: termRows.map((row) => [Number(row.annual_enrollment_id), Number(row.term_number), String(row.balance)]),
    payments: paymentRows.map((row) => ({ id: Number(row.id), amount: String(row.amount), reversed: Number(row.is_reversed), applied: String(row.applied), credit: centsToMoney(Number(row.is_reversed) ? 0n : moneyToCents(row.amount) - moneyToCents(row.applied)) }))
  };
}

function assertMetricsEqual(before, after) {
  if (sortedJson(before) !== sortedJson(after)) throw new MaintenanceError('A term balance, payment application, or available credit changed; the transaction was rolled back.');
}

function summarize(validated, chargePlan, allocationPlan) {
  const payments = validated.groups.get('cohort-student-payment');
  const amount = allocationPlan.reduce((sum, row) => sum + moneyToCents(row.amount), 0n);
  return {
    annuals: 79, assessments: 79, confirmations: 79,
    sourceTuitionChargesRetained: chargePlan.sources.length,
    canonicalTuitionChargesCreated: chargePlan.generated.length,
    paymentsPreserved: payments.length,
    tuitionAllocationsReplaced: 28,
    placementRows: allocationPlan.length,
    tuitionAppliedPreserved: centsToMoney(amount),
    miscellaneousAllocationsUntouched: 1,
    fixedManifestSha256: validated.digest
  };
}

async function insertRow(connection, table, statement, values) {
  const [result] = await executeAllowedWrite(connection, table, statement, values);
  const id = Number(result.insertId);
  if (!Number.isSafeInteger(id) || id < 1) throw new MaintenanceError('A maintenance insert returned no valid ID.');
  return id;
}

async function insertSnapshotRows(connection, snapshots, operationId, validated, chargePlan, allocationPlan, args) {
  const targetDigest = sha256(canonicalManifestRows(validated.groups.get('configured-target-v2-line')));
  const requestFingerprint = operationRequestFingerprint(operationId, validated.digest, targetDigest);
  const [existingRows] = await connection.execute('SELECT operation_id, operation_kind, request_fingerprint, manifest_sha256, target_lines_sha256 FROM finance_assessment_restatement_operations WHERE operation_id = ? FOR UPDATE', [operationId]);
  if (existingRows.length) throw new MaintenanceError('This operation ID already exists; use its recorded idempotent event or a new reviewed operation.');
  const [matchingRequest] = await connection.execute('SELECT operation_id FROM finance_assessment_restatement_operations WHERE request_fingerprint = ? FOR UPDATE', [requestFingerprint]);
  if (matchingRequest.length) throw new MaintenanceError('This fixed manifest already has a different operation ID recorded.');
  await executeAllowedWrite(connection, 'finance_assessment_restatement_operations', `INSERT INTO finance_assessment_restatement_operations
      (operation_id, operation_kind, request_fingerprint, manifest_sha256, target_lines_sha256, actor_id, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [operationId, OPERATION_KIND, requestFingerprint, validated.digest, targetDigest, args['actor-id'], args.reason]);

  const chargeRows = new Map(snapshots.chargeRows.map((row) => [Number(row.id), row]));
  const allocationRows = new Map(snapshots.allocationRows.map((row) => [Number(row.id), row]));
  const annuals = new Map(snapshots.annualRows.map((row) => [Number(row.id), row]));
  const assessmentByAnnual = new Map(snapshots.assessmentRows.map((row) => [Number(row.annual_enrollment_id), row]));
  const targetChargeId = new Map();

  for (const row of chargePlan.sources) {
    const before = chargeRows.get(row.chargeId);
    if (!before) throw new MaintenanceError('A source tuition charge is missing from its locked before-image.');
    await assertSingleRowWrite(executeAllowedWrite(connection, 'assessed_charges', `UPDATE assessed_charges
      SET synthetic_restatement_operation_id = ?, synthetic_restatement_role = 'source'
      WHERE id = ? AND synthetic_restatement_operation_id IS NULL AND synthetic_restatement_role IS NULL`,
    [operationId, row.chargeId]));
  }

  const generatedChargeIds = new Map();
  for (const row of chargePlan.generated) {
    const source = chargeRows.get(row.sourceChargeId);
    const annual = annuals.get(row.annualId);
    const assessment = assessmentByAnnual.get(row.annualId);
    if (!source || !annual || !assessment) throw new MaintenanceError('A target annual charge context is missing.');
    const fingerprint = sha256(sortedJson({ operationId, annualId: row.annualId, term: row.term, scheduleLineId: row.line.scheduleLineId }));
    const newId = await insertRow(connection, 'assessed_charges', `INSERT INTO assessed_charges
      (assessment_id, annual_enrollment_id, enrollment_id, schedule_line_id, fee_category, line_name, installment,
       amount, gross_amount, waived_amount, is_manual, reason, idempotency_key, request_fingerprint,
       synthetic_restatement_operation_id, synthetic_restatement_role)
      VALUES (?, ?, ?, ?, 'tuition', ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, 'generated')`,
    [row.assessmentId, row.annualId, source.enrollment_id, row.line.scheduleLineId, row.line.lineName, row.line.installment,
      row.line.amount, row.line.amount, row.idempotencyKey, fingerprint, operationId]);
    generatedChargeIds.set(row.idempotencyKey, newId);
    targetChargeId.set(`${row.annualId}|${row.term}|${row.line.scheduleLineId}`, newId);
  }

  const releaseIds = new Map();
  const tuitionSourceIds = new Set(chargePlan.sources.map((row) => row.chargeId));
  for (const manifestAllocation of validated.groups.get('cohort-payment-allocation').filter((row) => row.targetCategory === 'tuition')) {
    const allocation = allocationRows.get(Number(manifestAllocation.allocationId));
    if (!allocation || !tuitionSourceIds.has(Number(allocation.charge_id))) throw new MaintenanceError('A source tuition allocation does not target a fixed source charge.');
    const releaseKey = uuidV5(args['operation-id'], `release:apply:${allocation.id}`);
    const fingerprint = sha256(sortedJson({ operationId: args['operation-id'], allocationId: Number(allocation.id), amount: String(allocation.amount), kind: 'source-release' }));
    const releaseId = await insertRow(connection, 'finance_payment_allocation_releases', `INSERT INTO finance_payment_allocation_releases
      (allocation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by, synthetic_restatement_operation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [allocation.id, allocation.amount, 'Synthetic v2 tuition installment restatement; original allocation released and replaced in the same term.', releaseKey, fingerprint, args['actor-id'], args['operation-id']]);
    releaseIds.set(Number(allocation.id), releaseId);
  }

  const placementIds = [];
  const originalAllocations = new Map(validated.groups.get('cohort-payment-allocation').map((row) => [Number(row.allocationId), allocationRows.get(Number(row.allocationId))]));
  for (const placement of allocationPlan) {
    const sourceAllocation = originalAllocations.get(placement.oldAllocationId);
    const chargeId = targetChargeId.get(`${placement.annualId}|${placement.term}|${placement.scheduleLineId}`);
    if (!sourceAllocation || !chargeId) throw new MaintenanceError('A same-payment, same-term tuition placement target is missing.');
    const id = await insertRow(connection, 'finance_payment_allocations', `INSERT INTO finance_payment_allocations
      (payment_id, charge_id, legacy_opening_charge_id, amount, allocation_batch_id, allocated_by, synthetic_restatement_operation_id, synthetic_restatement_kind)
      VALUES (?, ?, NULL, ?, ?, ?, ?, 'placement')`,
    [sourceAllocation.payment_id, chargeId, placement.amount, sourceAllocation.allocation_batch_id, args['actor-id'], args['operation-id']]);
    placementIds.push({ ...placement, allocationId: id });
  }

  const archiveRows = buildAnnualArchives(snapshots, validated.groups, validated, chargePlan, allocationPlan);
  const generatedByAnnual = new Map();
  for (const row of chargePlan.generated) {
    const id = generatedChargeIds.get(row.idempotencyKey);
    if (!generatedByAnnual.has(row.annualId)) generatedByAnnual.set(row.annualId, []);
    generatedByAnnual.get(row.annualId).push({ chargeId: id, sourceChargeId: row.sourceChargeId, term: row.term,
      scheduleLineId: Number(row.line.scheduleLineId), amount: String(row.line.amount),
      installment: row.line.installment, idempotencyKey: row.idempotencyKey });
  }
  for (const archive of archiveRows) {
    const sourceAllocations = snapshots.allocationRows.filter((row) => archive.beforeImage.charges.some((charge) => Number(charge.id) === Number(row.charge_id)));
    const appliedImage = {
      sourceTuitionChargeIds: archive.operationChargePlan.sourceTuitionChargeIds,
      syntheticTuitionCharges: generatedByAnnual.get(archive.annualId) || [],
      sourceReleaseIds: sourceAllocations.filter((row) => releaseIds.has(Number(row.id))).map((row) => releaseIds.get(Number(row.id))),
      placementAllocations: placementIds.filter((row) => row.annualId === archive.annualId),
      paymentIds: [...new Set(sourceAllocations.map((row) => Number(row.payment_id)))].sort((a, b) => a - b)
    };
    const appliedJson = sortedJson(appliedImage);
    await executeAllowedWrite(connection, 'finance_assessment_restatement_annuals', `INSERT INTO finance_assessment_restatement_annuals
      (operation_id, annual_enrollment_id, assessment_id, confirmation_id, source_schedule_id,
       source_schedule_version, target_tuition_schedule_id, target_tuition_schedule_version,
       before_image_json, before_image_sha256, applied_image_json, applied_image_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [args['operation-id'], archive.annualId, archive.assessmentId, archive.confirmationId, archive.sourceScheduleId,
      archive.sourceScheduleVersion, archive.targetScheduleId, archive.targetScheduleVersion,
      archive.beforeJson, archive.beforeSha256, appliedJson, sha256(appliedJson)]);
  }
  return { targetDigest, requestFingerprint, placementIds, releaseIds };
}

async function appendAppliedEvent(connection, args, validated, targetDigest) {
  const resultingStateSha256 = await currentStateDigest(connection, args['operation-id']);
  await executeAllowedWrite(connection, 'finance_assessment_restatement_events', `INSERT INTO finance_assessment_restatement_events
      (operation_id, event_type, idempotency_key, actor_id, reason, manifest_sha256, resulting_state_sha256)
    VALUES (?, 'applied', ?, ?, ?, ?, ?)`,
  [args['operation-id'], args['idempotency-key'], args['actor-id'], args.reason, validated.digest, resultingStateSha256]);
  return resultingStateSha256;
}

async function currentStateDigest(connection, operationId, { lockRows = true } = {}) {
  const lockClause = lockRows ? ' FOR UPDATE' : '';
  const [archiveRows] = await connection.execute(`SELECT annual_enrollment_id, before_image_json, before_image_sha256, applied_image_sha256
    FROM finance_assessment_restatement_annuals WHERE operation_id = ? ORDER BY annual_enrollment_id${lockClause}`, [operationId]);
  if (archiveRows.length !== 79) throw new MaintenanceError('The immutable fixed-cohort archive is incomplete.');
  const beforeImages = archiveRows.map((row) => {
    if (sha256(row.before_image_json) !== row.before_image_sha256) throw new MaintenanceError('An immutable before-image digest does not match.');
    try { return JSON.parse(row.before_image_json); } catch { throw new MaintenanceError('An immutable before-image is not valid JSON.'); }
  });
  const archived = (key) => [...new Map(beforeImages.flatMap((image) => image[key] || [])
    .map((row) => [Number(row.id), row])).values()].sort((left, right) => Number(left.id) - Number(right.id));
  const queryByIds = async (statement, ids) => {
    if (!ids.length) return [];
    const [rows] = await connection.execute(`${statement} WHERE id IN (${placeholders(ids)}) ORDER BY id${lockClause}`, ids);
    if (rows.length !== ids.length) throw new MaintenanceError('A fixed protected row disappeared from the operation snapshot.');
    return rows;
  };
  const snapshots = {};
  snapshots.annuals = await queryByIds('SELECT id, student_id, school_year, grade_level, voucher_code, entry_term_number, intake_status, created_at, idempotency_key, request_fingerprint FROM annual_enrollments', idList(archived('annual'), 'id'));
  snapshots.assessments = await queryByIds('SELECT id, annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by, assessed_at, selection_json, idempotency_key, request_fingerprint FROM annual_assessments', idList(archived('assessment'), 'id'));
  snapshots.confirmations = await queryByIds('SELECT id, annual_enrollment_id, student_id, school_year, grade_level, entry_enrollment_id, assessment_id, schedule_id, schedule_version, voucher_code_snapshot, payable_total, selection_json, assessment_snapshot_fingerprint, confirmed_by, idempotency_key, request_fingerprint, confirmed_at, finance_review_id, entry_dp_state_at_confirmation FROM annual_registrar_confirmations', idList(archived('confirmation'), 'id'));
  const annualIds = idList(snapshots.annuals, 'id');
  const studentIds = idList(snapshots.annuals, 'student_id');
  const archivedEnrollmentIds = idList(archived('enrollments'), 'id');
  const [enrollments] = await connection.execute(`SELECT id, annual_enrollment_id, annual_term_number
    FROM enrollments WHERE annual_enrollment_id IN (${placeholders(annualIds)}) ORDER BY id${lockClause}`, annualIds);
  if (archivedEnrollmentIds.some((id) => !enrollments.some((row) => Number(row.id) === id))) {
    throw new MaintenanceError('A fixed cohort term enrollment disappeared from the operation snapshot.');
  }
  snapshots.enrollments = enrollments;

  const [payments] = await connection.execute(`SELECT id, student_id, amount, payment_date, reference_no,
      receipt_issued, private_remarks, idempotency_key, request_fingerprint, recorded_by, created_at,
      is_reversed, reverses_payment_id
    FROM finance_payments WHERE student_id IN (${placeholders(studentIds)}) ORDER BY id${lockClause}`, studentIds);
  const archivedPaymentIds = idList(archived('payments'), 'id');
  if (archivedPaymentIds.some((id) => !payments.some((row) => Number(row.id) === id))) {
    throw new MaintenanceError('A fixed cohort payment disappeared from the operation snapshot.');
  }
  snapshots.payments = payments;
  const paymentIds = idList(payments, 'id');

  const [cohortCharges] = await connection.execute(`SELECT id, assessment_id, annual_enrollment_id, enrollment_id,
      schedule_line_id, fee_category, line_name, installment, CAST(amount AS CHAR(40)) AS amount,
      CAST(gross_amount AS CHAR(40)) AS gross_amount, CAST(waived_amount AS CHAR(40)) AS waived_amount,
      is_manual, reason, idempotency_key, request_fingerprint, created_at, special_subject_id,
      synthetic_restatement_operation_id, synthetic_restatement_role
    FROM assessed_charges WHERE annual_enrollment_id IN (${placeholders(annualIds)}) ORDER BY id${lockClause}`, annualIds);
  const cohortChargeIds = idList(cohortCharges, 'id');
  const archivedChargeIds = idList(archived('charges'), 'id');
  if (archivedChargeIds.some((id) => !cohortChargeIds.includes(id))) {
    throw new MaintenanceError('A fixed cohort assessed charge disappeared from the operation snapshot.');
  }
  snapshots.cohortCharges = cohortCharges;

  const [batches] = await connection.execute(`SELECT id, payment_id, student_id, idempotency_key,
      request_fingerprint, allocated_by, created_at FROM finance_allocation_batches
    WHERE payment_id IN (${placeholders(paymentIds)}) ORDER BY id${lockClause}`, paymentIds);
  snapshots.batches = batches;
  const [allocations] = await connection.execute(`SELECT id, payment_id, charge_id, legacy_opening_charge_id,
      amount, allocation_batch_id, allocated_by, created_at, synthetic_restatement_operation_id,
      synthetic_restatement_kind FROM finance_payment_allocations
    WHERE payment_id IN (${placeholders(paymentIds)}) OR charge_id IN (${placeholders(cohortChargeIds)})
    ORDER BY id${lockClause}`, [...paymentIds, ...cohortChargeIds]);
  const allocationIds = idList(allocations, 'id');
  const archivedAllocationIds = idList(archived('allocations'), 'id');
  if (archivedAllocationIds.some((id) => !allocationIds.includes(id))) {
    throw new MaintenanceError('A fixed cohort payment allocation disappeared from the operation snapshot.');
  }
  snapshots.allocations = allocations;
  const [allocationReleases] = await connection.execute(`SELECT id, allocation_id, amount, reason,
      idempotency_key, request_fingerprint, recorded_by, created_at, synthetic_restatement_operation_id
    FROM finance_payment_allocation_releases WHERE allocation_id IN (${placeholders(allocationIds)})
    ORDER BY id${lockClause}`, allocationIds);
  snapshots.allocationReleases = allocationReleases;

  const [adjustments] = await connection.execute(`SELECT id, charge_id, amount, reason, reverses_adjustment_id,
      idempotency_key, request_fingerprint, exemption_application_id, recorded_by, created_at
    FROM finance_charge_adjustments WHERE charge_id IN (${placeholders(cohortChargeIds)}) ORDER BY id${lockClause}`, cohortChargeIds);
  snapshots.adjustments = adjustments;
  const [legacyReconciliations] = await connection.execute(`SELECT id, transaction_id, charge_id, amount,
      reason, batch_id, recorded_by, created_at FROM finance_legacy_reconciliations
    WHERE charge_id IN (${placeholders(cohortChargeIds)}) ORDER BY id${lockClause}`, cohortChargeIds);
  snapshots.legacyReconciliations = legacyReconciliations;
  const reconciliationIds = idList(legacyReconciliations, 'id');
  snapshots.legacyReleases = reconciliationIds.length
    ? (await connection.execute(`SELECT id, reconciliation_id, amount, reason, idempotency_key,
        request_fingerprint, recorded_by, created_at FROM finance_legacy_reconciliation_releases
      WHERE reconciliation_id IN (${placeholders(reconciliationIds)}) ORDER BY id${lockClause}`, reconciliationIds))[0]
    : [];
  const [exemptionApplications] = await connection.execute(`SELECT id, exemption_rule_id, charge_id, amount, applied_at
    FROM finance_exemption_applications WHERE charge_id IN (${placeholders(cohortChargeIds)}) ORDER BY id${lockClause}`, cohortChargeIds);
  snapshots.exemptionApplications = exemptionApplications;
  snapshots.openingLiabilities = (await connection.execute(`SELECT id, student_id, financial_account_id,
      source_label, amount, reason, recorded_by, created_at FROM finance_legacy_opening_charges
    WHERE student_id IN (${placeholders(studentIds)}) ORDER BY id${lockClause}`, studentIds))[0];
  snapshots.paymentReversals = (await connection.execute(`SELECT reversal.id, reversal.payment_id, reversal.reason,
      reversal.idempotency_key, reversal.request_fingerprint, reversal.recorded_by, reversal.created_at
    FROM finance_payment_reversals AS reversal INNER JOIN finance_payments AS payment ON payment.id = reversal.payment_id
    WHERE payment.student_id IN (${placeholders(studentIds)}) ORDER BY reversal.id${lockClause}`, studentIds))[0];
  snapshots.sourceScheduleLines = await queryByIds('SELECT id, schedule_id, term_number, fee_category, line_name, installment, amount, is_optional FROM finance_schedule_lines', idList(archived('sourceScheduleLines'), 'id'));
  snapshots.targetTuitionLines = await queryByIds('SELECT id, schedule_id, term_number, fee_category, line_name, installment, amount, is_optional FROM finance_schedule_lines', idList(beforeImages.flatMap((image) => image.targetTuitionLines || []), 'id'));
  snapshots.sourceSchedules = await queryByIds('SELECT id, school_year, grade_level, voucher_code, version_no, status, idempotency_key, request_fingerprint FROM finance_schedules', idList(archived('sourceSchedule'), 'id'));
  snapshots.targetSchedules = await queryByIds('SELECT id, school_year, grade_level, voucher_code, version_no, status, idempotency_key, request_fingerprint FROM finance_schedules', idList(archived('targetSchedule'), 'id'));
  const [operationCharges] = await connection.execute(`SELECT id, assessment_id, annual_enrollment_id, enrollment_id, schedule_line_id,
      fee_category, line_name, installment, CAST(amount AS CHAR(40)) AS amount, CAST(gross_amount AS CHAR(40)) AS gross_amount,
      CAST(waived_amount AS CHAR(40)) AS waived_amount, is_manual, reason, idempotency_key, request_fingerprint,
      special_subject_id, created_at, synthetic_restatement_operation_id, synthetic_restatement_role
    FROM assessed_charges WHERE synthetic_restatement_operation_id = ? ORDER BY id${lockClause}`, [operationId]);
  const [operationAllocations] = await connection.execute(`SELECT id, payment_id, charge_id, amount, allocation_batch_id,
      legacy_opening_charge_id, allocated_by, created_at, synthetic_restatement_kind
    FROM finance_payment_allocations WHERE synthetic_restatement_operation_id = ? ORDER BY id${lockClause}`, [operationId]);
  const [operationReleases] = await connection.execute(`SELECT id, allocation_id, amount, reason, idempotency_key,
      request_fingerprint, recorded_by, created_at FROM finance_payment_allocation_releases
    WHERE synthetic_restatement_operation_id = ? ORDER BY id${lockClause}`, [operationId]);
  return sha256(sortedJson({
    archives: archiveRows.map((row) => [Number(row.annual_enrollment_id), row.before_image_sha256, row.applied_image_sha256]),
    snapshots, operationCharges, operationAllocations, operationReleases
  }));
}

async function readOperation(connection, operationId, validated) {
  const manifestDigest = validated.digest;
  const targetDigest = sha256(canonicalManifestRows(validated.groups.get('configured-target-v2-line')));
  const expectedFingerprint = operationRequestFingerprint(operationId, manifestDigest, targetDigest);
  const [operationRows] = await connection.execute(`SELECT operation_id, operation_kind, request_fingerprint, manifest_sha256,
      target_lines_sha256, actor_id, reason FROM finance_assessment_restatement_operations WHERE operation_id = ? FOR UPDATE`, [operationId]);
  const operation = operationRows[0];
  if (!operation || operation.operation_kind !== OPERATION_KIND || operation.manifest_sha256 !== manifestDigest
    || operation.target_lines_sha256 !== targetDigest || operation.request_fingerprint !== expectedFingerprint) {
    throw new MaintenanceError('The requested operation is absent or does not match the frozen manifest and configured tuition schedule.');
  }
  const [annualRows] = await connection.execute(`SELECT annual_enrollment_id, assessment_id, confirmation_id, source_schedule_id,
      source_schedule_version, target_tuition_schedule_id, target_tuition_schedule_version, before_image_json,
      before_image_sha256, applied_image_json, applied_image_sha256
    FROM finance_assessment_restatement_annuals WHERE operation_id = ? ORDER BY annual_enrollment_id FOR UPDATE`, [operationId]);
  const expectedAnnuals = new Map(validated.groups.get('annual-and-confirmation').map((row) =>
    [Number(row.annualId), {
      assessmentId: Number(row.assessmentId), confirmationId: Number(row.confirmationId),
      sourceScheduleId: Number(row.sourceScheduleId), sourceScheduleVersion: Number(row.sourceScheduleVersion),
      targetScheduleId: Number(validated.groups.get('configured-target-v2-line').find((line) =>
        line.grade === row.annualGrade && line.voucher === row.annualVoucher)?.scheduleId)
    }]));
  if (annualRows.length !== expectedAnnuals.size) throw new MaintenanceError('The operation archive is incomplete.');
  const chargePlan = buildChargePlan(validated, operationId);
  const allocationPlan = buildAllocationPlan(validated, operationId);
  const allSourceTuitionIds = new Set();
  const allGeneratedChargeIds = new Set();
  const allPlacementIds = new Set();
  const allSourceReleaseIds = new Set();
  for (const archive of annualRows) {
    const expected = expectedAnnuals.get(Number(archive.annual_enrollment_id));
    if (!expected || Number(archive.assessment_id) !== expected.assessmentId
      || Number(archive.confirmation_id) !== expected.confirmationId || Number(archive.source_schedule_id) !== expected.sourceScheduleId
      || Number(archive.source_schedule_version) !== expected.sourceScheduleVersion
      || Number(archive.target_tuition_schedule_id) !== expected.targetScheduleId
      || Number(archive.target_tuition_schedule_version) !== 2
      || sha256(archive.before_image_json) !== archive.before_image_sha256
      || sha256(archive.applied_image_json) !== archive.applied_image_sha256) {
      throw new MaintenanceError('The immutable operation archive failed its fixed-ID or content digest check.');
    }
    let beforeImage;
    let appliedImage;
    try {
      beforeImage = JSON.parse(archive.before_image_json);
      appliedImage = JSON.parse(archive.applied_image_json);
    } catch { throw new MaintenanceError('An operation archive image is not valid JSON.'); }
    if (Number(beforeImage.annual?.id) !== Number(archive.annual_enrollment_id)
      || !Array.isArray(beforeImage.charges) || !Array.isArray(appliedImage.syntheticTuitionCharges)
      || !Array.isArray(appliedImage.sourceReleaseIds) || !Array.isArray(appliedImage.placementAllocations)) {
      throw new MaintenanceError('An operation archive image does not contain its expected annual and generated-row mapping.');
    }
    const annualId = Number(archive.annual_enrollment_id);
    const expectedSources = chargePlan.sources.filter((row) => row.annualId === annualId).map((row) => Number(row.chargeId)).sort((a, b) => a - b);
    const archivedSources = beforeImage.charges.filter((row) => String(row.fee_category).toLowerCase() === 'tuition').map((row) => Number(row.id)).sort((a, b) => a - b);
    const appliedSources = appliedImage.sourceTuitionChargeIds.map(Number).sort((a, b) => a - b);
    if (expectedSources.length !== 3 || sortedJson(archivedSources) !== sortedJson(expectedSources)
      || sortedJson(appliedSources) !== sortedJson(expectedSources)) {
      throw new MaintenanceError('An annual archive does not bind the exact three fixed tuition source charges.');
    }
    const expectedGenerated = chargePlan.generated.filter((row) => row.annualId === annualId);
    const generated = appliedImage.syntheticTuitionCharges;
    const generatedIds = generated.map((row) => Number(row.chargeId));
    const generatedPlan = generated.map((row) => ({ sourceChargeId: Number(row.sourceChargeId), term: Number(row.term),
      scheduleLineId: Number(row.scheduleLineId), amount: String(row.amount), installment: row.installment, idempotencyKey: row.idempotencyKey }))
      .sort((left, right) => left.term - right.term || left.scheduleLineId - right.scheduleLineId);
    const expectedGeneratedPlan = expectedGenerated.map((row) => ({ sourceChargeId: Number(row.sourceChargeId), term: Number(row.term),
      scheduleLineId: Number(row.line.scheduleLineId), amount: String(row.line.amount), installment: row.line.installment, idempotencyKey: row.idempotencyKey }))
      .sort((left, right) => left.term - right.term || left.scheduleLineId - right.scheduleLineId);
    if (generated.length !== 12 || generatedIds.some((id) => !Number.isSafeInteger(id) || id < 1)
      || new Set(generatedIds).size !== generatedIds.length || sortedJson(generatedPlan) !== sortedJson(expectedGeneratedPlan)) {
      throw new MaintenanceError('An annual archive does not bind all four configured v2 tuition installments for each term.');
    }
    const expectedAllocations = allocationPlan.filter((row) => row.annualId === annualId);
    const actualAllocations = appliedImage.placementAllocations.map((row) => ({
      oldAllocationId: Number(row.oldAllocationId), annualId: Number(row.annualId), term: Number(row.term),
      scheduleLineId: Number(row.scheduleLineId), installment: row.installment, amount: String(row.amount),
      kind: row.kind, idempotencyKey: row.idempotencyKey
    })).sort((left, right) => left.oldAllocationId - right.oldAllocationId || left.scheduleLineId - right.scheduleLineId);
    const expectedAllocationRows = expectedAllocations.map((row) => ({
      oldAllocationId: Number(row.oldAllocationId), annualId: Number(row.annualId), term: Number(row.term),
      scheduleLineId: Number(row.scheduleLineId), installment: row.installment, amount: String(row.amount),
      kind: row.kind, idempotencyKey: row.idempotencyKey
    })).sort((left, right) => left.oldAllocationId - right.oldAllocationId || left.scheduleLineId - right.scheduleLineId);
    const expectedReleases = validated.groups.get('cohort-payment-allocation').filter((row) =>
      Number(row.annualId) === annualId && row.targetCategory === 'tuition').length;
    if (sortedJson(actualAllocations) !== sortedJson(expectedAllocationRows)
      || appliedImage.sourceReleaseIds.length !== expectedReleases) {
      throw new MaintenanceError('An annual archive does not bind the exact same-payment, same-term allocation plan.');
    }
    for (const id of [...expectedSources, ...generatedIds]) {
      if (allSourceTuitionIds.has(id) || allGeneratedChargeIds.has(id)) throw new MaintenanceError('A charge ID is repeated across operation archives.');
      if (expectedSources.includes(id)) allSourceTuitionIds.add(id);
      else allGeneratedChargeIds.add(id);
    }
    for (const id of appliedImage.sourceReleaseIds.map(Number)) {
      if (!Number.isSafeInteger(id) || id < 1 || allSourceReleaseIds.has(id)) throw new MaintenanceError('A source allocation release ID is invalid or repeated.');
      allSourceReleaseIds.add(id);
    }
    for (const placement of appliedImage.placementAllocations) {
      const id = Number(placement.allocationId);
      if (!Number.isSafeInteger(id) || id < 1 || allPlacementIds.has(id)) throw new MaintenanceError('A replacement allocation ID is invalid or repeated.');
      allPlacementIds.add(id);
    }
  }
  if (allSourceTuitionIds.size !== 237 || allGeneratedChargeIds.size !== 948
    || allSourceReleaseIds.size !== 28 || allPlacementIds.size !== allocationPlan.length) {
    throw new MaintenanceError('The operation archive totals do not match the frozen 237/948/28 allocation shape.');
  }
  const [events] = await connection.execute(`SELECT id, event_type, idempotency_key, manifest_sha256, resulting_state_sha256
    FROM finance_assessment_restatement_events WHERE operation_id = ? ORDER BY id FOR UPDATE`, [operationId]);
  const applied = events.filter((event) => event.event_type === 'applied');
  const reversed = events.filter((event) => event.event_type === 'reversed');
  if (applied.length !== 1 || reversed.length > 1 || events.length !== applied.length + reversed.length
    || events.some((event) => event.manifest_sha256 !== manifestDigest)) {
    throw new MaintenanceError('The operation event history is inconsistent.');
  }
  return { operation, annualRows, appliedEvent: applied[0], reversedEvent: reversed[0] || null };
}

async function inspectOperationState(connection, operationId, validated) {
  const [operationRows] = await connection.execute(`SELECT operation_id, operation_kind, request_fingerprint,
      manifest_sha256, target_lines_sha256 FROM finance_assessment_restatement_operations WHERE operation_id = ?`, [operationId]);
  const [events] = await connection.execute(`SELECT id, event_type, idempotency_key, manifest_sha256, resulting_state_sha256
    FROM finance_assessment_restatement_events WHERE operation_id = ? ORDER BY id`, [operationId]);
  if (operationRows.length === 0 && events.length === 0) {
    const [[counts]] = await connection.execute(`SELECT
      (SELECT COUNT(*) FROM finance_assessment_restatement_annuals WHERE operation_id = ?) AS archive_count,
      (SELECT COUNT(*) FROM assessed_charges WHERE synthetic_restatement_operation_id = ?) AS charge_count,
      (SELECT COUNT(*) FROM finance_payment_allocations WHERE synthetic_restatement_operation_id = ?) AS allocation_count,
      (SELECT COUNT(*) FROM finance_payment_allocation_releases WHERE synthetic_restatement_operation_id = ?) AS release_count`,
    [operationId, operationId, operationId, operationId]);
    const countFields = ['archive_count', 'charge_count', 'allocation_count', 'release_count'];
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)
      || Object.keys(counts).length !== countFields.length
      || countFields.some((field) => !Object.hasOwn(counts, field))) {
      return { state: 'operation-history-inconsistent' };
    }
    const parsedCounts = countFields.map((field) => {
      const value = counts?.[field];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
      if (typeof value === 'string' && /^\d+$/.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) return parsed;
      }
      return null;
    });
    if (parsedCounts.some((count) => count === null)) return { state: 'operation-history-inconsistent' };
    const unused = parsedCounts.every((count) => count === 0);
    return { state: unused ? 'unused-operation-id' : 'orphaned-operation-artifacts' };
  }
  if (operationRows.length !== 1) return { state: 'operation-history-inconsistent' };
  const operation = operationRows[0];
  const targetDigest = sha256(canonicalManifestRows(validated.groups.get('configured-target-v2-line')));
  if (operation.operation_kind !== OPERATION_KIND || operation.manifest_sha256 !== validated.digest
    || operation.target_lines_sha256 !== targetDigest
    || operation.request_fingerprint !== operationRequestFingerprint(operationId, validated.digest, targetDigest)) {
    return { state: 'operation-record-mismatch' };
  }
  const applied = events.filter((event) => event.event_type === 'applied');
  const reversed = events.filter((event) => event.event_type === 'reversed');
  if (applied.length !== 1 || reversed.length > 1 || events.length !== applied.length + reversed.length
    || events.some((event) => event.manifest_sha256 !== validated.digest)
    || (reversed.length === 1 && Number(reversed[0].id) < Number(applied[0].id))) {
    return { state: 'operation-history-inconsistent' };
  }
  const currentStateSha256 = await currentStateDigest(connection, operationId, { lockRows: false });
  const terminalEvent = reversed[0] || applied[0];
  const stateMatches = currentStateSha256 === terminalEvent.resulting_state_sha256;
  return {
    state: reversed.length ? (stateMatches ? 'reversed-current' : 'reversed-drifted')
      : (stateMatches ? 'applied-current' : 'applied-drifted'),
    appliedIdempotencyKey: applied[0].idempotency_key,
    reversedIdempotencyKey: reversed[0]?.idempotency_key || null,
    currentStateSha256,
    recordedStateSha256: terminalEvent.resulting_state_sha256
  };
}

async function applyOperation(connection, args, inputs, expectedSchema = REHEARSAL_DB_NAME) {
  const { validated, sqlText } = inputs;
  await assertAuthorizedActor(connection, args['actor-id']);
  await assertMigrationPrerequisites(connection, expectedSchema);
  const [existingOperations] = await connection.execute('SELECT operation_id FROM finance_assessment_restatement_operations WHERE operation_id = ? FOR UPDATE', [args['operation-id']]);
  if (existingOperations.length) {
    const existing = await readOperation(connection, args['operation-id'], validated);
    if (existing.reversedEvent) throw new MaintenanceError('This fixed operation has already been reversed and cannot be applied again.');
    if (existing.appliedEvent.idempotency_key !== args['idempotency-key']) {
      throw new MaintenanceError('The existing operation ID was applied with a different idempotency key.');
    }
    await lockFixedManifest(connection, validated.groups, { operationId: args['operation-id'] });
    const resultingStateSha256 = await currentStateDigest(connection, args['operation-id']);
    if (resultingStateSha256 !== existing.appliedEvent.resulting_state_sha256) {
      throw new MaintenanceError('The recorded applied operation has drifted; idempotent apply stopped without changing data.');
    }
    const chargePlan = buildChargePlan(validated, args['operation-id']);
    const allocationPlan = buildAllocationPlan(validated, args['operation-id']);
    return { alreadyApplied: true, ...summarize(validated, chargePlan, allocationPlan), resultingStateSha256 };
  }
  await assertTriggerPrivilege(connection, expectedSchema);
  const beforeRows = await queryFreshManifest(connection, sqlText);
  validateManifestRows(beforeRows, APPROVED_MANIFEST_SHA256);
  await lockFixedManifest(connection, validated.groups);
  const lockedRows = await queryFreshManifest(connection, sqlText);
  validateManifestRows(lockedRows, APPROVED_MANIFEST_SHA256);
  const snapshots = await loadBeforeState(connection, validated.groups);
  assertBeforeStateEligibility(snapshots, validated.groups);
  const chargePlan = buildChargePlan(validated, args['operation-id']);
  const allocationPlan = buildAllocationPlan(validated, args['operation-id']);
  const beforeMetrics = await currentMetrics(connection, validated.groups);
  const applied = await insertSnapshotRows(connection, snapshots, args['operation-id'], validated, chargePlan, allocationPlan, args);
  await appendAppliedEvent(connection, args, validated, applied.targetDigest);
  const afterMetrics = await currentMetrics(connection, validated.groups);
  assertMetricsEqual(beforeMetrics, afterMetrics);
  const [eventRows] = await connection.execute('SELECT id FROM finance_assessment_restatement_events WHERE operation_id = ? AND event_type = \'applied\'', [args['operation-id']]);
  if (eventRows.length !== 1) throw new MaintenanceError('The applied event was not recorded exactly once.');
  return { ...summarize(validated, chargePlan, allocationPlan), resultingStateSha256: await currentStateDigest(connection, args['operation-id']) };
}

async function reverseOperation(connection, args, inputs, expectedSchema = REHEARSAL_DB_NAME) {
  const { validated } = inputs;
  await assertAuthorizedActor(connection, args['actor-id']);
  await assertMigrationPrerequisites(connection, expectedSchema);
  await assertTriggerPrivilege(connection, expectedSchema);
  const operation = await readOperation(connection, args['operation-id'], validated);
  await lockFixedManifest(connection, validated.groups, { operationId: args['operation-id'] });
  if (operation.reversedEvent) {
    if (operation.reversedEvent.idempotency_key !== args['idempotency-key']) throw new MaintenanceError('This operation is already reversed with a different idempotency key.');
    const resultingStateSha256 = await currentStateDigest(connection, args['operation-id']);
    if (resultingStateSha256 !== operation.reversedEvent.resulting_state_sha256) throw new MaintenanceError('The reversed operation has drifted; no further changes were made.');
    return { alreadyReversed: true, annuals: operation.annualRows.length, manifestSha256: validated.digest };
  }
  const appliedStateSha256 = await currentStateDigest(connection, args['operation-id']);
  if (appliedStateSha256 !== operation.appliedEvent.resulting_state_sha256) {
    throw new MaintenanceError('The applied operation or a protected payment/confirmation row has drifted; reversal stopped without changing data.');
  }
  const beforeMetrics = await currentMetrics(connection, validated.groups);
  const [operationChargeRows] = await connection.execute(`SELECT id, assessment_id, annual_enrollment_id, enrollment_id,
      schedule_line_id, fee_category, line_name, installment, CAST(amount AS CHAR(40)) AS amount,
      CAST(gross_amount AS CHAR(40)) AS gross_amount, CAST(waived_amount AS CHAR(40)) AS waived_amount,
      is_manual, reason, idempotency_key, request_fingerprint, special_subject_id, created_at,
      synthetic_restatement_operation_id, synthetic_restatement_role
    FROM assessed_charges WHERE synthetic_restatement_operation_id = ? ORDER BY id FOR UPDATE`, [args['operation-id']]);
  const [placements] = await connection.execute(`SELECT id, payment_id, charge_id, amount, allocation_batch_id,
      allocated_by, created_at, synthetic_restatement_operation_id, synthetic_restatement_kind
    FROM finance_payment_allocations WHERE synthetic_restatement_operation_id = ? AND synthetic_restatement_kind = 'placement' ORDER BY id FOR UPDATE`, [args['operation-id']]);
  const [operationReleases] = await connection.execute(`SELECT id, allocation_id, amount, synthetic_restatement_operation_id
    FROM finance_payment_allocation_releases WHERE synthetic_restatement_operation_id = ? ORDER BY id FOR UPDATE`, [args['operation-id']]);
  const sourceRows = operationChargeRows.filter((row) => row.synthetic_restatement_role === 'source');
  const generatedRows = operationChargeRows.filter((row) => row.synthetic_restatement_role === 'generated');
  if (operationChargeRows.length !== 1185 || sourceRows.length !== 237 || generatedRows.length !== 948
    || placements.length !== 70 || operationReleases.length !== 28) {
    throw new MaintenanceError('The applied operation state has drifted from the reviewed charge/allocation shape.');
  }
  const operationChargeIds = operationChargeRows.map((row) => Number(row.id));
  const [externalAllocations] = await connection.execute(`SELECT id FROM finance_payment_allocations
    WHERE charge_id IN (${placeholders(operationChargeIds)}) AND (synthetic_restatement_operation_id IS NULL OR synthetic_restatement_kind <> 'placement')
    ORDER BY id FOR UPDATE`, operationChargeIds);
  const [syntheticAdjustments] = await connection.execute(`SELECT id FROM finance_charge_adjustments
    WHERE charge_id IN (${placeholders(operationChargeIds)}) ORDER BY id FOR UPDATE`, operationChargeIds);

  const originalSource = new Map();
  const originalTuitionAllocations = new Map();
  const placementMetadataById = new Map();
  for (const archive of operation.annualRows) {
    const before = JSON.parse(archive.before_image_json);
    const sourceTuition = before.charges.filter((row) => String(row.fee_category).toLowerCase() === 'tuition');
    if (sourceTuition.length !== 3) throw new MaintenanceError('An annual before-image has an unexpected tuition charge count.');
    for (const charge of sourceTuition) originalSource.set(Number(charge.id), charge);
    const appliedImage = JSON.parse(archive.applied_image_json);
    const tuitionSourceIds = new Set(sourceTuition.map((row) => Number(row.id)));
    for (const allocation of before.allocations.filter((row) => tuitionSourceIds.has(Number(row.charge_id)))) {
      if (originalTuitionAllocations.has(Number(allocation.id))) throw new MaintenanceError('An original tuition allocation appears in multiple annual archives.');
      originalTuitionAllocations.set(Number(allocation.id), { annualId: Number(archive.annual_enrollment_id), before, allocation });
    }
    for (const entry of appliedImage.placementAllocations) {
      const id = Number(entry.allocationId);
      if (placementMetadataById.has(id)) throw new MaintenanceError('A placement allocation appears in multiple annual archives.');
      placementMetadataById.set(id, { ...entry, annualId: Number(archive.annual_enrollment_id), before });
    }
    for (const charge of sourceTuition) {
      const current = sourceRows.find((row) => Number(row.id) === Number(charge.id));
      const fields = ['id', 'assessment_id', 'annual_enrollment_id', 'enrollment_id', 'schedule_line_id',
        'fee_category', 'line_name', 'installment', 'amount', 'gross_amount', 'waived_amount', 'is_manual',
        'reason', 'idempotency_key', 'request_fingerprint', 'created_at', 'special_subject_id'];
      const expectedFields = Object.fromEntries(fields.map((field) => [field, charge[field]]));
      const currentFields = current && Object.fromEntries(fields.map((field) => [field, current[field]]));
      if (!current || String(current.synthetic_restatement_operation_id) !== String(args['operation-id'])
        || current.synthetic_restatement_role !== 'source' || sortedJson(expectedFields) !== sortedJson(currentFields)) {
        throw new MaintenanceError('An original tuition source row changed after the operation was applied.');
      }
    }
  }
  const expectedSourceChargeIds = new Set(originalSource.keys());
  const expectedGeneratedChargeIds = new Set(operation.annualRows.flatMap((archive) =>
    JSON.parse(archive.applied_image_json).syntheticTuitionCharges.map((row) => Number(row.chargeId))));
  const actualOperationChargeIds = new Set(operationChargeIds);
  const actualSourceChargeIds = new Set(sourceRows.map((row) => Number(row.id)));
  const actualGeneratedChargeIds = new Set(generatedRows.map((row) => Number(row.id)));
  const expectedOriginalAllocationIds = [...originalTuitionAllocations.keys()].sort((a, b) => a - b);
  const actualExternalAllocationIds = externalAllocations.map((row) => Number(row.id)).sort((a, b) => a - b);
  const expectedReleaseAllocationIds = operationReleases.map((row) => Number(row.allocation_id)).sort((a, b) => a - b);
  const releaseByAllocationId = new Map();
  for (const release of operationReleases) {
    const allocationId = Number(release.allocation_id);
    if (releaseByAllocationId.has(allocationId)) throw new MaintenanceError('A source allocation has duplicate operation releases.');
    releaseByAllocationId.set(allocationId, release);
  }
  if (expectedSourceChargeIds.size !== 237 || actualSourceChargeIds.size !== 237
    || [...expectedSourceChargeIds].some((id) => !actualSourceChargeIds.has(id))
    || expectedGeneratedChargeIds.size !== 948 || actualGeneratedChargeIds.size !== 948
    || [...expectedGeneratedChargeIds].some((id) => !actualGeneratedChargeIds.has(id))
    || actualSourceChargeIds.size + actualGeneratedChargeIds.size !== actualOperationChargeIds.size
    || originalTuitionAllocations.size !== 28
    || placementMetadataById.size !== 70
    || sortedJson(expectedOriginalAllocationIds) !== sortedJson(actualExternalAllocationIds)
    || sortedJson(expectedOriginalAllocationIds) !== sortedJson(expectedReleaseAllocationIds)
    || syntheticAdjustments.length) {
    throw new MaintenanceError('New allocation or adjustment activity, missing source releases, or changed operation rows require separate review.');
  }
  for (const [allocationId, source] of originalTuitionAllocations) {
    const release = releaseByAllocationId.get(allocationId);
    if (!release || String(release.synthetic_restatement_operation_id) !== String(args['operation-id'])
      || String(release.amount) !== String(source.allocation.amount)) {
      throw new MaintenanceError('A released source allocation no longer matches the before-image amount.');
    }
  }
  for (const placement of placements) {
    const expected = placementMetadataById.get(Number(placement.id));
    if (!expected || String(placement.synthetic_restatement_operation_id) !== String(args['operation-id'])
      || placement.synthetic_restatement_kind !== 'placement'
      || Number(placement.payment_id) !== Number(expected.paymentId)
      || Number(placement.allocation_batch_id) !== Number(expected.before.allocations.find((row) => Number(row.id) === Number(expected.oldAllocationId))?.allocation_batch_id)
      || String(placement.amount) !== String(expected.amount)) {
      throw new MaintenanceError('A replacement allocation changed from its immutable same-payment, same-term mapping.');
    }
  }
  const actorId = args['actor-id'];
  for (const placement of placements) {
    const metadata = placementMetadataById.get(Number(placement.id));
    const source = originalTuitionAllocations.get(Number(metadata?.oldAllocationId));
    if (!metadata || !source || source.annualId !== Number(metadata.annualId)
      || Number(source.allocation.payment_id) !== Number(placement.payment_id)
      || Number(source.allocation.allocation_batch_id) !== Number(placement.allocation_batch_id)) {
      throw new MaintenanceError('A replacement allocation no longer maps to its original payment and batch.');
    }
    const sourceCharge = source.before.charges.find((row) => Number(row.id) === Number(source.allocation.charge_id));
    const sourceEnrollment = source.before.enrollments.find((row) => Number(row.id) === Number(sourceCharge?.enrollment_id));
    if (!sourceCharge || !sourceEnrollment || Number(sourceEnrollment.annual_term_number) !== Number(metadata.term)
      || Number(metadata.term) < 1 || Number(metadata.term) > 3) {
      throw new MaintenanceError('A replacement allocation no longer maps to the exact original term.');
    }
    const releaseIdempotency = uuidV5(args['operation-id'], `release:reverse:${placement.id}`);
    const fingerprint = sha256(sortedJson({ operationId: args['operation-id'], allocationId: Number(placement.id), amount: String(placement.amount), kind: 'placement-release' }));
    await executeAllowedWrite(connection, 'finance_payment_allocation_releases', `INSERT INTO finance_payment_allocation_releases
      (allocation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by, synthetic_restatement_operation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [placement.id, placement.amount, 'Synthetic tuition installment placement released during logical reversal.', releaseIdempotency, fingerprint, actorId, args['operation-id']]);
    const batchId = Number(placement.allocation_batch_id);
    await executeAllowedWrite(connection, 'finance_payment_allocations', `INSERT INTO finance_payment_allocations
      (payment_id, charge_id, legacy_opening_charge_id, amount, allocation_batch_id, allocated_by, synthetic_restatement_operation_id, synthetic_restatement_kind)
      VALUES (?, ?, NULL, ?, ?, ?, ?, 'restoration')`,
    [placement.payment_id, sourceCharge.id, placement.amount, batchId, actorId, args['operation-id']]);
  }
  const resultingStateSha256 = await currentStateDigest(connection, args['operation-id']);
  await executeAllowedWrite(connection, 'finance_assessment_restatement_events', `INSERT INTO finance_assessment_restatement_events
      (operation_id, event_type, idempotency_key, actor_id, reason, manifest_sha256, resulting_state_sha256)
    VALUES (?, 'reversed', ?, ?, ?, ?, ?)`,
  [args['operation-id'], args['idempotency-key'], actorId, args.reason, validated.digest, resultingStateSha256]);
  const afterMetrics = await currentMetrics(connection, validated.groups);
  assertMetricsEqual(beforeMetrics, afterMetrics);
  return { reversed: true, annuals: operation.annualRows.length, restoredSourceTuitionCharges: originalSource.size, manifestSha256: validated.digest };
}

async function executePreparedOperation(connection, args, inputs, expectedSchema) {
  if (!['apply', 'reverse'].includes(args?.mode)) throw new MaintenanceError('Choose apply or reverse for the reviewed restatement operation.');
  if (typeof expectedSchema !== 'string' || !/^[A-Za-z0-9_]+$/.test(expectedSchema)) {
    throw new MaintenanceError('The expected finance restatement schema is invalid.');
  }
  let transactionStarted = false;
  let commitAttempted = false;
  let commitConfirmed = false;
  try {
    await assertSelectedSchema(connection, expectedSchema);
    await connection.query('SET SESSION max_statement_time = 5');
    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await connection.beginTransaction();
    transactionStarted = true;
    await assertSelectedSchema(connection, expectedSchema);
    const result = args.mode === 'apply'
      ? await applyOperation(connection, args, inputs, expectedSchema)
      : await reverseOperation(connection, args, inputs, expectedSchema);
    commitAttempted = true;
    await connection.commit();
    commitConfirmed = true;
    transactionStarted = false;
    return { mode: args.mode, ...result };
  } catch (error) {
    let rollbackConfirmed = false;
    if (transactionStarted) {
      try {
        await connection.rollback();
        rollbackConfirmed = true;
      } catch {
        rollbackConfirmed = false;
      }
    }
    if (commitAttempted || (transactionStarted && !rollbackConfirmed)) {
      throw new MaintenanceError(transactionFailureMessage({ commitAttempted, commitConfirmed, rollbackConfirmed }));
    }
    if (error instanceof MaintenanceError || error instanceof RestatementManifestError) throw error;
    throw new MaintenanceError(transactionFailureMessage({ commitAttempted, commitConfirmed, rollbackConfirmed }));
  }
}

async function run() {
  const args = parseArguments(process.argv.slice(2));
  const inputs = loadApprovedInputs(args);
  const { getPool, closePool } = require('../src/config/database');
  const { validated, sqlText } = inputs;
  const chargePlan = ['dry-run', 'apply'].includes(args.mode) ? buildChargePlan(validated, args['operation-id'] || 'b35ff673-1a38-4d05-9494-0f447fa71a1a') : null;
  const allocationPlan = ['dry-run', 'apply'].includes(args.mode) ? buildAllocationPlan(validated, args['operation-id'] || 'b35ff673-1a38-4d05-9494-0f447fa71a1a') : null;
  if (args.mode === 'preflight') {
    const pool = await getPool();
    const connection = await pool.source.getConnection();
    try {
      await assertExpectedDatabase(connection);
      await connection.query('SET SESSION max_statement_time = 5');
      await connection.query('SET TRANSACTION READ ONLY');
      await connection.beginTransaction();
      let freshRows;
      try { freshRows = await queryFreshManifest(connection, sqlText); } finally { await connection.rollback(); }
      const live = validateManifestRows(freshRows, APPROVED_MANIFEST_SHA256);
      console.log(JSON.stringify({ mode: args.mode, manifestSha256: live.digest, rowCount: freshRows.length, readOnlyTransactionRolledBack: true }));
      return;
    } finally { connection.release(); await closePool(); }
  }
  if (args.mode === 'dry-run') {
    console.log(JSON.stringify({ mode: args.mode, ...summarize(validated, chargePlan, allocationPlan) }));
    return;
  }

  const pool = await getPool();
  const connection = await pool.source.getConnection();
  let transactionStarted = false;
  let commitAttempted = false;
  let commitConfirmed = false;
  try {
    await assertExpectedDatabase(connection);
    await connection.query('SET SESSION max_statement_time = 5');
    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await connection.beginTransaction();
    transactionStarted = true;
    const result = args.mode === 'apply'
      ? await applyOperation(connection, args, inputs)
      : await reverseOperation(connection, args, inputs);
    commitAttempted = true;
    await connection.commit();
    commitConfirmed = true;
    transactionStarted = false;
    console.log(JSON.stringify({ mode: args.mode, ...result }));
  } catch (error) {
    let rollbackConfirmed = false;
    if (transactionStarted) {
      try {
        await connection.rollback();
        rollbackConfirmed = true;
      } catch {
        rollbackConfirmed = false;
      }
    }
    if (commitAttempted || (transactionStarted && !rollbackConfirmed)) {
      throw new MaintenanceError(transactionFailureMessage({ commitAttempted, commitConfirmed, rollbackConfirmed }));
    }
    if (error instanceof MaintenanceError || error instanceof RestatementManifestError) throw error;
    throw new MaintenanceError(transactionFailureMessage({ commitAttempted, commitConfirmed, rollbackConfirmed }));
  } finally {
    connection.release();
    await closePool();
  }
}

function transactionFailureMessage({ commitAttempted, commitConfirmed, rollbackConfirmed }) {
  if (commitConfirmed) return 'The finance restatement committed, but completion could not be reported; inspect the existing operation and resulting state before retrying.';
  if (commitAttempted) return 'The finance restatement commit outcome is unconfirmed; inspect the existing operation and state digest before any retry.';
  if (rollbackConfirmed) return 'The finance restatement transaction failed and was rolled back; inspect the database before retrying.';
  return 'The finance restatement transaction outcome is unconfirmed; inspect the existing operation and state digest before any retry.';
}

function publicMaintenanceErrorMessage(error) {
  if (error instanceof MaintenanceError || error instanceof RestatementManifestError) return error.message;
  return 'An unexpected maintenance failure occurred. Review protected operator logs before retrying.';
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Finance restatement stopped: ${publicMaintenanceErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  APPROVED_MANIFEST_SHA256,
  APPROVED_PREFLIGHT_SQL_SHA256,
  MaintenanceError,
  assertExpectedDatabase,
  assertSelectedSchema,
  assertRehearsalConfiguration,
  assertBeforeStateEligibility,
  assertMigrationPrerequisites,
  assertTriggerPrivilege,
  executePreparedOperation,
  hasDirectSchemaPrivilege,
  countSqlStatementTerminators,
  extractManifestSelect,
  inspectMigrationPrerequisites,
  inspectOperationState,
  loadApprovedInputs,
  parseMysqlAccountIdentity,
  parseArguments,
  publicMaintenanceErrorMessage,
  transactionFailureMessage,
  validateReason,
  queryFreshManifest,
  run
};
