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
  validateAppliedVersions
} = require('../scripts/db-setup-v2');

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
    Array.from({ length: 17 }, (_, index) => `v2.${String(index + 2).padStart(3, '0')}`));
  assert.ok(migrations.every(({ statements }) => statements.length > 0));
});

test('V2 setup rejects SQL Server or Hostinger-incompatible DDL in an active MariaDB file', () => {
  const pathName = '/tmp/arktiesiis-forbidden-v2-schema-test.sql';
  fs.writeFileSync(pathName, 'CREATE TRIGGER test_trigger BEFORE INSERT ON t FOR EACH ROW SET NEW.id = 1;');
  try {
    assert.throws(() => readSqlFile(pathName), SetupError);
  } finally {
    fs.unlinkSync(pathName);
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
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.019'])), /Unknown migration/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.017', 'v2.018'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.013'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.003'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.002'])), /no recorded MariaDB v2.001/);
});
