const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SetupError, splitSqlBatches, validateBaselinePrelude, readForwardMigrations, applyPendingMigrations } = require('../scripts/db-setup-v2');

test('V2 setup splits SQL Server batches and ignores GO in inline comments', () => {
  assert.deepEqual(splitSqlBatches('SELECT 1;\nGO\n-- GO not a batch\nSELECT 2;\nGO -- divider\n'), [
    'SELECT 1;', '-- GO not a batch\nSELECT 2;'
  ]);
});

test('V2 setup accepts only the dedicated V2 database prelude', () => {
  assert.doesNotThrow(() => validateBaselinePrelude([
    "IF DB_ID('ARKTIESIIS_V2') IS NULL BEGIN CREATE DATABASE ARKTIESIIS_V2; END;",
    'USE ARKTIESIIS_V2;',
    'CREATE TABLE dbo.sample (id INT);'
  ]));
  assert.throws(() => validateBaselinePrelude([
    "IF DB_ID('ARKTIESIIS') IS NULL BEGIN CREATE DATABASE ARKTIESIIS; END;",
    'USE ARKTIESIIS;',
    'CREATE TABLE dbo.sample (id INT);'
  ]), SetupError);
});

test('report-card lifecycle migration separates DDL and archive backfill batches', () => {
  const [migration] = readForwardMigrations();
  assert.equal(migration.version, 'v2.002');
  assert.equal(migration.batches.length, 2);
  assert.match(migration.batches[0], /ALTER TABLE dbo\.documents/);
  assert.doesNotMatch(migration.batches[0], /UPDATE dbo\.documents/);
  assert.match(migration.batches[1], /UPDATE dbo\.documents[\s\S]*document_type = 'report_card'/);
  assert.match(migration.batches[1], /COL_LENGTH/);
  const sql = fs.readFileSync('database/v2/migrations/002_report_card_lifecycle.sql', 'utf8');
  assert.match(sql, /is_legacy_archive = 1/);
});

test('previous-school report-card paper status migration stores only status history and has bounded vocabulary', () => {
  const migration = readForwardMigrations().find(({ version }) => version === 'v2.003');
  assert.ok(migration);
  assert.equal(migration.filename, '003_previous_school_report_card_physical_status.sql');
  assert.equal(migration.batches.length, 2);
  assert.match(migration.batches[0], /CREATE TABLE dbo\.previous_school_report_card_status_events/);
  assert.match(migration.batches[0], /status IN \('pending', 'received', 'verified', 'correction', 'rejected'\)/);
  assert.match(migration.batches[0], /FOREIGN KEY \(student_id\) REFERENCES dbo\.students/);
  assert.match(migration.batches[1], /student_id, created_at DESC, id DESC/);
  assert.doesNotMatch(fs.readFileSync('database/v2/schema.sql', 'utf8'), /previous_school_report_card_status_events/);
});

test('forward migration 004 extends the named paper-status constraint without changing v2.003 history schema', () => {
  const migration = readForwardMigrations().find(({ version }) => version === 'v2.004');
  assert.ok(migration);
  assert.equal(migration.filename, '004_previous_school_report_card_status_constraint.sql');
  assert.equal(migration.batches.length, 1);
  assert.match(migration.batches[0], /ALTER TABLE dbo\.previous_school_report_card_status_events DROP CONSTRAINT/);
  assert.match(migration.batches[0], /CK_previous_school_report_card_status_status/);
  assert.match(migration.batches[0], /status IN \('pending', 'received', 'verified', 'correction', 'rejected'\)/);
  assert.doesNotMatch(migration.batches[0], /CREATE TABLE|DROP TABLE|DELETE FROM/);
});

test('V2 forward migrations run once and record their marker transactionally', async () => {
  const state = { applied: new Set(), batches: [], commits: 0, rollbacks: 0 };
  class FakeTransaction {
    constructor(pool) { this.pool = pool; }
    async begin(isolation) { state.isolation = isolation; }
    async commit() { state.commits += 1; }
    async rollback() { state.rollbacks += 1; }
  }
  class FakeRequest {
    constructor(transaction) { this.transaction = transaction; this.values = {}; }
    input(name, _type, value) { this.values[name] = value; return this; }
    async query(statement) {
      if (statement.includes('sp_getapplock')) return { recordset: [] };
      if (statement.includes('SELECT [version]')) {
        const version = this.values.version;
        return { recordset: state.applied.has(version) ? [{ version }] : [] };
      }
      if (statement.includes('INSERT INTO dbo.schema_migrations')) {
        state.applied.add(this.values.version);
        return { recordset: [] };
      }
      throw new Error(`Unexpected migration query: ${statement}`);
    }
    async batch(statement) { state.batches.push(statement); return { recordset: [] }; }
  }
  const fakeSql = {
    Transaction: FakeTransaction,
    Request: FakeRequest,
    NVarChar: (length) => `NVarChar(${length})`,
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }
  };
  const migration = readForwardMigrations().find(({ version }) => version === 'v2.004');
  const first = await applyPendingMigrations({}, [migration], { sqlDriver: fakeSql });
  const second = await applyPendingMigrations({}, [migration], { sqlDriver: fakeSql });
  assert.deepEqual(first, ['v2.004']);
  assert.deepEqual(second, []);
  assert.deepEqual(state.batches, migration.batches);
  assert.deepEqual([...state.applied], ['v2.004']);
  assert.equal(state.commits, 1);
  assert.equal(state.rollbacks, 1, 'a repeated migration marker is rolled back without replaying its SQL');
  assert.equal(state.isolation, 'SERIALIZABLE');
});
