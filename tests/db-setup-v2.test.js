'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SetupError,
  splitSqlStatements,
  readSqlFile,
  readForwardMigrations,
  validateAppliedVersions,
  validateTriggerDdl
} = require('../scripts/db-setup-v2');
const dbCheck = require('../scripts/check-db');

test('V2 setup splits MariaDB statements without breaking quoted semicolons', () => {
  assert.deepEqual(splitSqlStatements("SELECT 'a;b' AS value; SELECT `semi;colon` FROM t; -- comment;\nSELECT 3;"), [
    "SELECT 'a;b' AS value",
    'SELECT `semi;colon` FROM t',
    '-- comment;\nSELECT 3'
  ]);
});

test('V2 setup targets the existing MariaDB baseline and ordered forward migrations', () => {
  const baseline = readSqlFile(path.resolve('database/mariadb/schema.sql'));
  assert.ok(baseline.some((statement) => /v2\.001/.test(statement)));
  assert.ok(baseline.every((statement) => !/\b(?:CREATE|DROP)\s+DATABASE\b/i.test(statement)));
  const migrations = readForwardMigrations();
  assert.deepEqual(migrations.map(({ version }) => version),
    Array.from({ length: 24 }, (_, index) => `v2.${String(index + 2).padStart(3, '0')}`));
  assert.deepEqual(migrations.slice(-2).map(({ version }) => version), ['v2.024', 'v2.025']);
  assert.ok(migrations.every(({ statements }) => statements.length > 0));
  const authMigration = migrations.find(({ version }) => version === 'v2.023');
  assert.ok(authMigration?.statements.some((statement) => /ALTER TABLE users[\s\S]+invitation_required/i.test(statement)));
  assert.ok(authMigration?.statements.some((statement) => /CREATE TABLE account_setup_tokens/i.test(statement)));
  assert.ok(authMigration?.statements.some((statement) => /delivery_status IN \('pending', 'sent', 'failed', 'unknown'\)/i.test(statement)));
  assert.deepEqual(dbCheck.EXPECTED_VERSIONS.slice(-2), ['v2.024', 'v2.025']);
  assert.ok(dbCheck.REQUIRED_COLUMNS.users.includes('invitation_required'));
  assert.ok(dbCheck.REQUIRED_COLUMNS.account_setup_tokens.includes('token_hash'));
  assert.ok(dbCheck.REQUIRED_INDEXES.some((item) => item.indexName === 'UX_account_setup_token_hash'));
  assert.ok(dbCheck.REQUIRED_FOREIGN_KEYS.some((item) => item.constraintName === 'FK_account_setup_user'));
});

test('V2 setup rejects SQL Server or Hostinger-incompatible DDL in an active MariaDB file', () => {
  const pathName = '/tmp/arktiesiis-forbidden-v2-schema-test.sql';
  try {
    for (const statement of [
      'CREATE TRIGGER test_trigger BEFORE INSERT ON t FOR EACH ROW SET NEW.id = 1;',
      'CREATE/*gap*/DATABASE arbitrary;',
      'CREATE OR REPLACE DATABASE arbitrary;',
      'DROP /*gap*/ DATABASE arbitrary;',
      'ALTER/*gap*/DATABASE arbitrary;',
      'CREATE OR REPLACE PROCEDURE p() SELECT 1;',
      'CREATE OR REPLACE/*gap*/PROCEDURE p() SELECT 1;',
      'CREATE/*gap*/PROCEDURE p() SELECT 1;',
      'CREATE ALGORITHM=UNDEFINED /*gap*/ DEFINER=`operator`@`%` VIEW v AS SELECT 1;',
      'CREATE OR REPLACE ALGORITHM=UNDEFINED /*!50003 DEFINER=`operator`@`%` */ VIEW v AS SELECT 1;',
      '/*!50003 CREATE OR REPLACE PROCEDURE p() SELECT 1 */;',
      'CREATE /*!50003 DATABASE */ arbitrary;'
    ]) {
      fs.writeFileSync(pathName, statement);
      assert.throws(() => readSqlFile(pathName), SetupError, statement);
    }
  } finally {
    fs.rmSync(pathName, { force: true });
  }
  fs.writeFileSync(pathName, 'CREATE TABLE finance_notes (definer VARCHAR(80));');
  try {
    assert.doesNotThrow(() => readSqlFile(pathName), 'ordinary table DDL is not blocked by a column named definer');
  } finally {
    fs.rmSync(pathName, { force: true });
  }
});

test('V2 setup permits only the exact six restatement immutability triggers', () => {
  const migrationPath = path.resolve('database/mariadb/migrations/024_finance_assessment_restatement.sql');
  const statements = readSqlFile(migrationPath);
  assert.equal(statements.filter((statement) => /^CREATE TRIGGER\b/i.test(statement)).length, 6);
  const triggers = statements.filter((statement) => /^CREATE TRIGGER\b/i.test(statement));
  assert.doesNotThrow(() => validateTriggerDdl(migrationPath, triggers));

  const missing = triggers.slice(0, -1);
  const duplicated = [...triggers.slice(0, -1), triggers[0]];
  const extra = [...triggers, triggers[0]];
  for (const candidate of [missing, duplicated, extra]) {
    assert.throws(() => validateTriggerDdl(migrationPath, candidate), SetupError);
  }
});

test('V2 setup detects alternate trigger DDL and does not scan literals as SQL', () => {
  const candidates = [
    'CREATE OR REPLACE TRIGGER any_name BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1;',
    'CREATE/* gap */TRIGGER any_name BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1;',
    'CREATE /* gap */ OR /* gap */ REPLACE /* gap */ TRIGGER any_name BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1;',
    '/*!50003 CREATE TRIGGER any_name BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1 */;',
    'CREATE /*!50003 TRIGGER */ any_name BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1;',
    '/*M!100100 CREATE TRIGGER any_name BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1 */;',
    'CREATE DEFINER = `operator`@`%` TRIGGER any_name BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1;',
    'CREATE OR REPLACE ALGORITHM=UNDEFINED /* gap */ DEFINER = `operator`@`%` VIEW v AS SELECT 1;',
    'CREATE OR REPLACE /*!50003 DEFINER = `operator`@`%` */ VIEW v AS SELECT 1;',
    'DROP /* comment */ TRIGGER IF EXISTS any_name;',
    'ALTER /* comment */ TRIGGER any_name ENABLE;',
    'CREATE TRIGGER any_name BEFORE UPDATE ON other_table FOR EACH ROW SET NEW.id = 1;'
  ];
  const pathName = '/tmp/arktiesiis-trigger-variant-test.sql';
  try {
    for (const candidate of candidates) {
      fs.writeFileSync(pathName, candidate);
      assert.throws(() => readSqlFile(pathName), SetupError, candidate);
    }
    fs.writeFileSync(pathName, "SELECT 'CREATE OR REPLACE TRIGGER is text';");
    assert.doesNotThrow(() => readSqlFile(pathName));
  } finally {
    fs.rmSync(pathName, { force: true });
  }
});

test('V2 setup refuses unknown or discontinuous migration history', () => {
  assert.doesNotThrow(() => validateAppliedVersions(new Set(['v2.001', 'v2.002', 'v2.003'])));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 13 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 17 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 18 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 19 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 20 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 22 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 25 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.throws(() => validateAppliedVersions(new Set([
    ...Array.from({ length: 22 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`),
    'v2.024'
  ])), /v2\.024 is recorded while v2\.023 is missing/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.026'])), /Unknown migration/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.017', 'v2.018'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.013'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.003'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.002'])), /no recorded MariaDB v2.001/);
});
