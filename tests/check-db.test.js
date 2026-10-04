const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const env = require('../src/config/environment');
const { REQUIRED_OBJECTS, REQUIRED_COLUMNS, EXPECTED_VERSIONS, checkDatabase } = require('../scripts/check-db');

function checkHarness({ databaseName = env.database.database, missingObject = null, failAt = null } = {}) {
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
        if (statement.includes('information_schema.table_constraints')) return { recordset: [{ constraintCount: 1 }] };
        if (statement.includes('information_schema.statistics')) return { recordset: [{ indexCount: 1 }] };
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
  assert.match(state.logs[0], /v2\.014/);
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

test('the former SQL Server baseline stays untouched and MariaDB setup avoids Hostinger-blocked DDL', () => {
  const oldBaseline = fs.readFileSync('database/v2/schema.sql', 'utf8');
  const newBaseline = fs.readFileSync('database/mariadb/schema.sql', 'utf8');
  assert.match(oldBaseline, /CREATE DATABASE ARKTIESIIS_V2/);
  assert.match(oldBaseline, /USE ARKTIESIIS_V2/);
  assert.doesNotMatch(newBaseline, /\b(?:CREATE|DROP)\s+DATABASE\b|\bCREATE\s+TRIGGER\b|\bDEFINER\s*=/i);
  assert.match(newBaseline, /application_locks/);
  assert.match(newBaseline, /VALUES \('v2\.001'\)/);
});
