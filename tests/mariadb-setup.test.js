const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { splitSqlStatements, readSqlFile, readForwardMigrations, validateAppliedVersions, validateTriggerDdl, SetupError } = require('../scripts/db-setup-v2');

 test('SQL splitter preserves semicolons inside strings, quoted identifiers, and comments', () => {
  const statements = splitSqlStatements(`-- note; still a comment\nSELECT 'a;b' AS value; SELECT \`semi;colon\` FROM t; /* x;y */ SELECT 3;`);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /'a;b'/);
  assert.match(statements[1], /\`semi;colon\`/);
});

test('MariaDB setup reads a v2.001 baseline and the numbered v2.002-v2.027 migrations', () => {
  const baseline = readSqlFile(path.resolve('database/mariadb/schema.sql'));
  assert.ok(baseline.some((statement) => /v2\.001/.test(statement)));
  const migrations = readForwardMigrations();
  assert.deepEqual(migrations.map(({ version }) => version), Array.from({ length: 26 }, (_, index) => `v2.${String(index + 2).padStart(3, '0')}`));
  assert.ok(migrations.every(({ statements }) => statements.length > 0));
  const wholePaper = migrations.find(({ version }) => version === 'v2.018');
  assert.equal(wholePaper.statements[0].match(/\bALTER\s+TABLE\s+student_term_clearances\b/gi)?.length, 1);
  assert.match(wholePaper.statements[0], /ADD recording_mode VARCHAR\(24\) NOT NULL DEFAULT 'signature_checklist'/i);
  assert.match(wholePaper.statements[0], /CK_student_term_clearance_recording_mode/i);
  assert.match(wholePaper.statements[0], /CK_student_term_clearance_attestation/i);
  assert.match(wholePaper.statements[0], /inspected_on IS NOT NULL/i);
  const financeHandoff = migrations.find(({ version }) => version === 'v2.019');
  assert.match(financeHandoff.statements[0], /CREATE TABLE annual_finance_assessment_reviews/i);
  assert.match(financeHandoff.statements[2], /finance_review_id BIGINT NULL/i);
  assert.match(financeHandoff.statements[2], /entry_dp_state_at_confirmation/i);
  const departureCutoff = migrations.find(({ version }) => version === 'v2.020');
  assert.match(departureCutoff.statements[0], /CREATE TABLE finance_departure_cutoff_reviews/i);
  assert.match(departureCutoff.statements[1], /CREATE TABLE finance_departure_charge_reviews/i);
  assert.doesNotMatch(departureCutoff.statements.join('\n'), /UPDATE\s+finance_departure_cases/i,
    'historical reviewed cases are not given inferred cutoff decisions');
  const retake = migrations.find(({ version }) => version === 'v2.021');
  assert.match(retake.statements.join('\n'), /CREATE TABLE registrar_retake_referrals/i);
  assert.match(retake.statements.join('\n'), /CREATE TABLE finance_retake_item_decisions/i);
  assert.match(retake.statements.join('\n'), /UQ_finance_retake_item_decision_charge_item/i,
    'stable retake identities can have at most one posted charge across referral corrections');
  assert.match(retake.statements.join('\n'), /current_item_key_id BIGINT AS/i,
    'no-charge decisions can be reopened by a later finalized correction without deleting the prior decision');
  const scheduledDeparture = migrations.find(({ version }) => version === 'v2.022');
  assert.match(scheduledDeparture.statements.join('\n'), /ADD application_status VARCHAR\(20\) NOT NULL DEFAULT 'legacy_applied'/i);
  assert.match(scheduledDeparture.statements.join('\n'), /CREATE TABLE finance_departure_application_events/i);
  assert.doesNotMatch(scheduledDeparture.statements.join('\n'), /UPDATE\s+enrollments|UPDATE\s+finance_departure_cases/i,
    'legacy departure application and placement history is not inferred or rewritten');
  const customRequirements = migrations.find(({ version }) => version === 'v2.025');
  assert.match(customRequirements.statements.join('\n'), /CREATE TABLE requirement_catalog/i);
  assert.match(customRequirements.statements.join('\n'), /CREATE TABLE requirement_assignments/i);
  assert.match(customRequirements.statements.join('\n'), /ADD requirement_assignment_id INT NULL/i);
  const earlyEvidence = migrations.find(({ version }) => version === 'v2.026');
  assert.match(earlyEvidence.statements.join('\n'), /CREATE TABLE student_document_early_evidence/i);
  assert.match(migrations.find(({ version }) => version === 'v2.027').statements.join('\n'),
    /CREATE TABLE student_document_ai_attempts/i);
  const restatement = migrations.find(({ version }) => version === 'v2.024');
  assert.equal(restatement.statements.filter((statement) => /^CREATE TRIGGER\b/i.test(statement)).length, 6);
  const exactTriggers = restatement.statements.filter((statement) => /^CREATE TRIGGER\b/i.test(statement));
  assert.doesNotThrow(() => validateTriggerDdl(path.resolve('database/mariadb/migrations/024_finance_assessment_restatement.sql'), exactTriggers));
  assert.throws(() => validateTriggerDdl(path.resolve('database/mariadb/migrations/024_finance_assessment_restatement.sql'), exactTriggers.slice(1)), SetupError);
  assert.throws(() => validateTriggerDdl(path.resolve('database/mariadb/migrations/024_finance_assessment_restatement.sql'), [...exactTriggers, exactTriggers[0]]), SetupError);
  assert.match(restatement.statements.join('\n'), /CREATE OR REPLACE VIEW v_finance_effective_assessed_charges/i);
  assert.match(restatement.statements.join('\n'), /CREATE OR REPLACE VIEW v_finance_assessed_charge_due[\s\S]*FROM v_finance_effective_assessed_charges/i);
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

test('setup allows only the six exact append-only triggers in finance migration 024', () => {
  const migrationPath = path.resolve('database/mariadb/migrations/024_finance_assessment_restatement.sql');
  const statements = readSqlFile(migrationPath);
  assert.equal(statements.filter((statement) => /^CREATE TRIGGER\b/i.test(statement)).length, 6);
  const spoofedPath = '/tmp/024_finance_assessment_restatement.sql';
  fs.writeFileSync(spoofedPath, statements.filter((statement) => /^CREATE TRIGGER\b/i.test(statement)).join(';\n'));
  try {
    assert.throws(() => readSqlFile(spoofedPath), SetupError);
  } finally {
    fs.unlinkSync(spoofedPath);
  }

  const variants = [
    'CREATE OR REPLACE TRIGGER x BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1;',
    'CREATE/*c*/TRIGGER x BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1;',
    '/*!50003 CREATE TRIGGER x BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1 */;',
    'CREATE /*!50003 TRIGGER */ x BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1;',
    '/*M!100100 CREATE TRIGGER x BEFORE UPDATE ON t FOR EACH ROW SET NEW.id = 1 */;',
    'DROP /*c*/ TRIGGER IF EXISTS x;',
    'ALTER /*c*/ TRIGGER x ENABLE;',
    'CREATE OR REPLACE/*c*/DATABASE arbitrary;',
    'CREATE OR REPLACE/*c*/PROCEDURE p() SELECT 1;',
    '/*!50003 CREATE OR REPLACE PROCEDURE p() SELECT 1 */;',
    'CREATE OR REPLACE ALGORITHM=UNDEFINED /*c*/ DEFINER=`operator`@`%` VIEW v AS SELECT 1;',
    'CREATE OR REPLACE /*!50003 DEFINER=`operator`@`%` */ VIEW v AS SELECT 1;'
  ];
  try {
    for (const statement of variants) {
      fs.writeFileSync(spoofedPath, statement);
      assert.throws(() => readSqlFile(spoofedPath), SetupError, statement);
    }
    fs.writeFileSync(spoofedPath, "SELECT 'CREATE OR REPLACE TRIGGER';");
    assert.doesNotThrow(() => readSqlFile(spoofedPath));
  } finally {
    fs.rmSync(spoofedPath, { force: true });
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
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 19 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 20 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 21 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.doesNotThrow(() => validateAppliedVersions(new Set(
    Array.from({ length: 25 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`)
  )));
  assert.throws(() => validateAppliedVersions(new Set([
    ...Array.from({ length: 22 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`), 'v2.024'
  ])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.017', 'v2.018'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.019'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.013'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.012'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.001', 'v2.003'])), /history is inconsistent/);
  assert.throws(() => validateAppliedVersions(new Set(['v2.002'])), /no recorded MariaDB v2.001/);
});
