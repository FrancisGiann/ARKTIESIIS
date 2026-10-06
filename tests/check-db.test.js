const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const env = require('../src/config/environment');
const { REQUIRED_OBJECTS, REQUIRED_COLUMNS, REQUIRED_CONSTRAINTS, REQUIRED_INDEXES, REQUIRED_FOREIGN_KEYS, EXPECTED_VERSIONS, checkDatabase } = require('../scripts/check-db');

function checkHarness({ databaseName = env.database.database, missingObject = null, missingConstraint = null,
  invalidRoleConstraint = false, missingIndex = null, missingForeignKey = false, failAt = null } = {}) {
  const state = { queries: [], logs: [], errors: [], closed: 0 };
  let queryCount = 0;
  const pool = { request() {
    const values = Object.create(null);
    return {
      input(name, _type, value) { values[name] = value; return this; },
      async query(statement) {
        state.queries.push(statement);
        queryCount += 1;
        if (queryCount === failAt) throw new Error('raw private SQL details');
        if (statement.includes('SELECT DATABASE()')) return { recordset: [{ databaseName }] };
        if (statement.includes('FROM schema_migrations')) return { recordset: EXPECTED_VERSIONS.map((version) => ({ version })) };
        if (statement.includes('information_schema.tables')) return { recordset: REQUIRED_OBJECTS.filter((name) => name !== missingObject).map((objectName) => ({ objectName })) };
        if (statement.includes('information_schema.columns')) return { recordset: Object.entries(REQUIRED_COLUMNS).flatMap(([tableName, columnNames]) => columnNames.map((columnName) => ({ tableName, columnName }))) };
        if (statement.includes('information_schema.table_constraints')) return { recordset: REQUIRED_CONSTRAINTS
          .filter(({ tableName, constraintName }) => `${tableName}.${constraintName}` !== missingConstraint)
          .map(({ tableName, constraintName, type, clauseIncludes }) => ({
            tableName, constraintName, constraintType: type,
            checkClause: invalidRoleConstraint && constraintName === 'CK_users_role'
              ? "role IN ('database_admin','registrar','teacher','finance','student')"
              : clauseIncludes || 'valid constraint'
          })) };
        if (statement.includes('information_schema.statistics')) return { recordset: REQUIRED_INDEXES
          .filter(({ tableName, indexName }) => `${tableName}.${indexName}` !== missingIndex)
          .map(({ tableName, indexName, columns }) => ({ tableName, indexName, nonUnique: 0, columns: columns.join(',') })) };
        if (statement.includes('information_schema.key_column_usage')) return { recordset: missingForeignKey ? [] : REQUIRED_FOREIGN_KEYS.map((foreignKey) => ({
          tableName: foreignKey.tableName, constraintName: foreignKey.constraintName,
          columnName: foreignKey.columnName, referencedTable: foreignKey.referencedTable, referencedColumn: foreignKey.referencedColumn
        })) };
        throw new Error(`Unexpected check query: ${statement}`);
      }
    };
  } };
  return { state, pool };
}

async function runCheck(options = {}) {
  const harness = checkHarness(options);
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await checkDatabase({
      getDatabasePool: async () => harness.pool,
      closeDatabasePool: async () => { harness.state.closed += 1; },
      logger: { log(value) { harness.state.logs.push(value); }, error(value) { harness.state.errors.push(value); } }
    });
    harness.state.exitCode = process.exitCode;
    return harness.state;
  } finally {
    process.exitCode = originalExitCode;
  }
}

test('MariaDB database check verifies migration versions, required tables, views, and columns', async () => {
  const state = await runCheck();
  assert.equal(state.exitCode, undefined);
  assert.equal(state.closed, 1);
  assert.match(state.logs[0], /MariaDB connectivity/);
  assert.match(state.logs[0], /v2\.017/);
  assert.ok(state.queries.some((statement) => statement.includes('information_schema.tables')));
  assert.ok(state.queries.some((statement) => statement.includes('information_schema.columns')));
  assert.ok(state.queries.every((statement) => !/\b(?:DB_NAME|OBJECT_ID|dbo\.|sys\.tables|TRIGGER)\b/i.test(statement)));
});

test('MariaDB database check reports mismatched DB_NAME without exposing connection details', async () => {
  const state = await runCheck({ databaseName: 'different_database' });
  assert.equal(state.exitCode, 1);
  assert.match(state.errors.join('\n'), /does not match DB_NAME/);
  assert.equal(state.queries.length, 1);
  assert.equal(state.closed, 1);
});

test('MariaDB database check identifies missing schema objects and masks database errors', async () => {
  const missing = await runCheck({ missingObject: 'class_schedules' });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.errors.join('\n'), /object class_schedules/);
  const failed = await runCheck({ failAt: 2 });
  assert.equal(failed.exitCode, 1);
  assert.doesNotMatch(failed.errors.join('\n'), /raw private SQL details/);
});

test('MariaDB database check verifies role, address, idempotency, LRN, and annual-source constraints', async () => {
  const wrongRole = await runCheck({ invalidRoleConstraint: true });
  assert.equal(wrongRole.exitCode, 1);
  assert.match(wrongRole.errors.join('\n'), /constraint users\.CK_users_role/);

  const missingUnique = await runCheck({ missingIndex: 'pre_enrollments.UQ_pre_enrollment_year_lrn' });
  assert.equal(missingUnique.exitCode, 1);
  assert.match(missingUnique.errors.join('\n'), /unique index pre_enrollments\.UQ_pre_enrollment_year_lrn/);

  const missingForeignKey = await runCheck({ missingForeignKey: true });
  assert.equal(missingForeignKey.exitCode, 1);
  assert.match(missingForeignKey.errors.join('\n'), /foreign key annual_enrollments\.FK_annual_enrollment_pre_enrollment/);
});

test('the former SQL Server baseline stays untouched and MariaDB setup avoids Hostinger-blocked DDL', () => {
  const oldBaseline = fs.readFileSync('database/v2/schema.sql', 'utf8');
  const newBaseline = fs.readFileSync('database/mariadb/schema.sql', 'utf8');
  assert.match(oldBaseline, /CREATE DATABASE ARKTIESIIS_V2/);
  assert.match(oldBaseline, /USE ARKTIESIIS_V2/);
  assert.doesNotMatch(newBaseline, /\b(?:CREATE|DROP)\s+DATABASE\b|\bCREATE\s+TRIGGER\b|\bDEFINER\s*=/i);
  assert.match(newBaseline, /application_locks/);
  assert.match(newBaseline, /VALUES \('v2\.001'\)/);
});
