const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { splitSqlStatements, readSqlFile, readForwardMigrations, validateAppliedVersions, SetupError } = require('../scripts/db-setup-v2');

 test('SQL splitter preserves semicolons inside strings, quoted identifiers, and comments', () => {
  const statements = splitSqlStatements(`-- note; still a comment\nSELECT 'a;b' AS value; SELECT \`semi;colon\` FROM t; /* x;y */ SELECT 3;`);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /'a;b'/);
  assert.match(statements[1], /\`semi;colon\`/);
});

test('MariaDB setup reads a v2.001 baseline and the numbered v2.002-v2.018 migrations', () => {
  const baseline = readSqlFile(path.resolve('database/mariadb/schema.sql'));
  assert.ok(baseline.some((statement) => /v2\.001/.test(statement)));
  const migrations = readForwardMigrations();
  assert.deepEqual(migrations.map(({ version }) => version), Array.from({ length: 17 }, (_, index) => `v2.${String(index + 2).padStart(3, '0')}`));
  assert.ok(migrations.every(({ statements }) => statements.length > 0));
  const wholePaper = migrations.find(({ version }) => version === 'v2.018');
  assert.equal(wholePaper.statements[0].match(/\bALTER\s+TABLE\s+student_term_clearances\b/gi)?.length, 1);
  assert.match(wholePaper.statements[0], /ADD recording_mode VARCHAR\(24\) NOT NULL DEFAULT 'signature_checklist'/i);
  assert.match(wholePaper.statements[0], /CK_student_term_clearance_recording_mode/i);
  assert.match(wholePaper.statements[0], /CK_student_term_clearance_attestation/i);
  assert.match(wholePaper.statements[0], /inspected_on IS NOT NULL/i);
});

test('setup rejects Hostinger-incompatible schema DDL', () => {
  const pathName = '/tmp/arktiesiis-forbidden-schema-test.sql';
  fs.writeFileSync(pathName, 'CREATE TRIGGER test_trigger BEFORE INSERT ON t FOR EACH ROW SET NEW.id = 1;');
  try {
    assert.throws(() => readSqlFile(pathName), SetupError);
  } finally {
    fs.unlinkSync(pathName);
  }
});

test('setup refuses unknown or discontinuous migration history', () => {
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 12 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 13 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 14 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 17 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 18 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.017', 'v2.018'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.019'])), /Unknown migration/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.013'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.012'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.003'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.002'])), /no recorded MariaDB v2.001/);
});
