'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getPool, closePool } = require('../src/config/database');
const env = require('../src/config/environment');

const BASELINE_VERSION = 'v2.001';
const BASELINE_PATH = path.resolve(__dirname, '../database/mariadb/schema.sql');
const MIGRATIONS_DIRECTORY = path.resolve(__dirname, '../database/mariadb/migrations');
const APPLICATION_LOCK = 'ARKTIESIIS MariaDB schema setup';
const KNOWN_VERSIONS = new Set(Array.from({ length: 25 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`));
const RESTATEMENT_MIGRATION = '024_finance_assessment_restatement.sql';
const RESTATEMENT_TRIGGER_SPECS = Object.freeze([
  ['trg_finance_restatement_operations_no_update', 'UPDATE', 'finance_assessment_restatement_operations'],
  ['trg_finance_restatement_operations_no_delete', 'DELETE', 'finance_assessment_restatement_operations'],
  ['trg_finance_restatement_annuals_no_update', 'UPDATE', 'finance_assessment_restatement_annuals'],
  ['trg_finance_restatement_annuals_no_delete', 'DELETE', 'finance_assessment_restatement_annuals'],
  ['trg_finance_restatement_events_no_update', 'UPDATE', 'finance_assessment_restatement_events'],
  ['trg_finance_restatement_events_no_delete', 'DELETE', 'finance_assessment_restatement_events']
]);

class SetupError extends Error {}

function splitSqlStatements(contents) {
  const statements = [];
  let current = '';
  let state = 'code';
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    const next = contents[index + 1];
    if (state === 'code') {
      if (character === "'") state = 'single';
      else if (character === '"') state = 'double';
      else if (character === '`') state = 'backtick';
      else if (character === '-' && next === '-' && /\s/.test(contents[index + 2] || '')) state = 'line-comment';
      else if (character === '/' && next === '*') state = 'block-comment';
      else if (character === ';') {
        if (current.trim()) statements.push(current.trim());
        current = '';
        continue;
      }
    } else if (state === 'single' && character === "'") {
      if (next === "'") { current += character + next; index += 1; continue; }
      if (contents[index - 1] !== '\\') state = 'code';
    } else if (state === 'double' && character === '"') {
      if (next === '"') { current += character + next; index += 1; continue; }
      state = 'code';
    } else if (state === 'backtick' && character === '`') {
      state = 'code';
    } else if (state === 'line-comment' && (character === '\n' || character === '\r')) {
      state = 'code';
    } else if (state === 'block-comment' && character === '*' && next === '/') {
      current += '*/'; index += 1; state = 'code'; continue;
    }
    current += character;
    if (state === 'line-comment' || state === 'block-comment') continue;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function sqlWordsOutsideLiterals(contents) {
  const words = [];
  let state = 'code';
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    const next = contents[index + 1];
    if (state === 'code') {
      if (character === "'") state = 'single';
      else if (character === '"') state = 'double';
      else if (character === '`') state = 'backtick';
      else if (character === '-' && next === '-') state = 'line-comment';
      else if (character === '#') state = 'line-comment';
      else if (character === '/' && next === '*') {
        const executable = contents[index + 2] === '!' || (contents[index + 2] === 'M' && contents[index + 3] === '!');
        const close = contents.indexOf('*/', index + 2);
        if (close < 0) return words;
        if (executable) {
          let bodyStart = index + (contents[index + 2] === 'M' ? 4 : 3);
          while (bodyStart < close && /\d/.test(contents[bodyStart])) bodyStart += 1;
          const embeddedWords = sqlWordsOutsideLiterals(contents.slice(bodyStart, close));
          words.push(...embeddedWords);
        }
        index = close + 1;
      } else if (/[A-Za-z_]/.test(character)) {
        let end = index + 1;
        while (end < contents.length && /[A-Za-z0-9_$]/.test(contents[end])) end += 1;
        words.push(contents.slice(index, end).toUpperCase());
        index = end - 1;
      }
    } else if (state === 'single' && character === "'") {
      if (next === "'") index += 1;
      else if (contents[index - 1] !== '\\') state = 'code';
    } else if (state === 'double' && character === '"') {
      if (next === '"') index += 1;
      else if (contents[index - 1] !== '\\') state = 'code';
    } else if (state === 'backtick' && character === '`') {
      if (next === '`') index += 1;
      else state = 'code';
    } else if (state === 'line-comment' && (character === '\n' || character === '\r')) {
      state = 'code';
    }
  }
  return words;
}

function isTriggerDdlStatement(statement) {
  const words = sqlWordsOutsideLiterals(statement);
  const verb = words[0];
  if (!['CREATE', 'ALTER', 'DROP'].includes(verb)) return false;
  return words.slice(1).includes('TRIGGER');
}

function isForbiddenHostingerDdlStatement(statement) {
  const words = sqlWordsOutsideLiterals(statement);
  const verb = words[0];
  if (!['CREATE', 'ALTER', 'DROP'].includes(verb)) return false;
  const objectTypes = new Set(['DATABASE', 'SCHEMA', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'TABLE', 'VIEW', 'INDEX', 'EVENT']);
  const objectIndex = words.findIndex((word, index) => index > 0 && objectTypes.has(word));
  const objectType = objectIndex < 0 ? null : words[objectIndex];
  if (objectType === 'DATABASE' || objectType === 'SCHEMA' || objectType === 'PROCEDURE') return true;
  if (!['CREATE', 'ALTER'].includes(verb)) return false;
  const definerIndex = words.indexOf('DEFINER');
  return definerIndex > 0 && (objectIndex < 0 || definerIndex < objectIndex);
}

function validateTriggerDdl(filePath, triggerStatements) {
  if (!triggerStatements.length) return;
  const isApprovedMigration = path.resolve(filePath) === path.join(MIGRATIONS_DIRECTORY, RESTATEMENT_MIGRATION);
  const byName = new Map(RESTATEMENT_TRIGGER_SPECS.map(([name, event, table]) => [name, { event, table }]));
  const accepted = triggerStatements.every((statement) => {
    const normalized = statement.replace(/\s+/g, ' ').trim();
    const match = /^CREATE TRIGGER ([a-z0-9_]+) BEFORE (UPDATE|DELETE) ON ([a-z0-9_]+) FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance restatement history is append-only'$/i.exec(normalized);
    if (!match) return false;
    const [, name, event, table] = match;
    const expected = byName.get(name.toLowerCase());
    return expected && expected.event === event.toUpperCase() && expected.table === table.toLowerCase();
  });
  const names = triggerStatements.map((statement) => /^CREATE TRIGGER ([a-z0-9_]+)/i.exec(statement.replace(/\s+/g, ' ').trim())?.[1]?.toLowerCase());
  if (!isApprovedMigration || !accepted || triggerStatements.length !== RESTATEMENT_TRIGGER_SPECS.length
    || new Set(names).size !== RESTATEMENT_TRIGGER_SPECS.length
    || RESTATEMENT_TRIGGER_SPECS.some(([name]) => !names.includes(name))) {
    throw new SetupError(`SQL file ${path.relative(process.cwd(), filePath)} uses DDL disallowed by the Hostinger setup path.`);
  }
}

function readSqlFile(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new SetupError(`Could not read SQL file ${path.relative(process.cwd(), filePath)}.`);
  }
  const statements = splitSqlStatements(contents);
  if (!statements.length) throw new SetupError(`SQL file ${path.relative(process.cwd(), filePath)} is empty.`);
  if (statements.some(isForbiddenHostingerDdlStatement)) {
    throw new SetupError(`SQL file ${path.relative(process.cwd(), filePath)} uses DDL disallowed by the Hostinger setup path.`);
  }
  const triggerStatements = statements.filter(isTriggerDdlStatement);
  validateTriggerDdl(filePath, triggerStatements);
  return statements;
}

function readForwardMigrations() {
  let filenames;
  try {
    filenames = fs.readdirSync(MIGRATIONS_DIRECTORY)
      .filter((filename) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(filename))
      .sort();
  } catch {
    throw new SetupError('Could not read the MariaDB forward migrations.');
  }
  const seen = new Set();
  const migrations = filenames.map((filename) => {
    const sequence = filename.slice(0, 3);
    const version = `v2.${sequence}`;
    if (sequence === '001' || !KNOWN_VERSIONS.has(version) || seen.has(version)) {
      throw new SetupError('The MariaDB migration sequence is invalid.');
    }
    seen.add(version);
    return { filename, version, statements: readSqlFile(path.join(MIGRATIONS_DIRECTORY, filename)) };
  });
  for (let index = 0; index < migrations.length; index += 1) {
    const expected = `v2.${String(index + 2).padStart(3, '0')}`;
    if (migrations[index].version !== expected) {
      throw new SetupError(`The MariaDB migration sequence is incomplete: expected ${expected} after the prior migration.`);
    }
  }
  return migrations;
}

function readBaseline() {
  const statements = readSqlFile(BASELINE_PATH);
  if (!statements.some((statement) => /^INSERT\s+INTO\s+schema_migrations\s*\(\s*version\s*\)\s*VALUES\s*\(\s*'v2\.001'\s*\)$/i.test(statement))) {
    throw new SetupError('The MariaDB baseline does not record v2.001.');
  }
  return statements;
}

async function tableCount(connection) {
  const [rows] = await connection.execute(
    'SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = DATABASE()'
  );
  return Number(rows[0]?.table_count || 0);
}

async function tableExists(connection, tableName) {
  const [rows] = await connection.execute(
    'SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1',
    [tableName]
  );
  return rows.length > 0;
}

async function readAppliedVersions(connection) {
  const [rows] = await connection.execute('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(rows.map(({ version }) => String(version)));
}

function validateAppliedVersions(versions) {
  if (!versions.has(BASELINE_VERSION)) {
    throw new SetupError('The selected database has tables but no recorded MariaDB v2.001 baseline. Inspect it before setup; the baseline was not rerun.');
  }
  const unknown = [...versions].filter((version) => !KNOWN_VERSIONS.has(version));
  if (unknown.length) throw new SetupError(`Unknown migration version(s): ${unknown.sort().join(', ')}.`);
  for (let sequence = 2; sequence <= 25; sequence += 1) {
    const version = `v2.${String(sequence).padStart(3, '0')}`;
    const prior = `v2.${String(sequence - 1).padStart(3, '0')}`;
    if (versions.has(version) && !versions.has(prior)) {
      throw new SetupError(`Migration history is inconsistent: ${version} is recorded while ${prior} is missing.`);
    }
  }
}

async function executeStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function runSetup({ getDatabasePool = getPool, closeDatabasePool = closePool, logger = console } = {}) {
  if (!env.database.password) throw new SetupError('DB_PASSWORD is required. Copy .env.example and configure the existing MariaDB credentials.');
  if (!env.database.database) throw new SetupError('DB_NAME is required and must name the existing database created in hPanel.');

  const baseline = readBaseline();
  const migrations = readForwardMigrations();
  const pool = await getDatabasePool();
  const connection = await pool.source.getConnection();
  let locked = false;
  try {
    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 60) AS acquired', [APPLICATION_LOCK]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new SetupError('Could not acquire the MariaDB setup lock.');
    locked = true;

    const hasMigrations = await tableExists(connection, 'schema_migrations');
    if (!hasMigrations) {
      const count = await tableCount(connection);
      if (count !== 0) throw new SetupError('The selected database is not empty and has no schema_migrations table. The baseline was not run.');
      try {
        await executeStatements(connection, baseline);
      } catch {
        throw new SetupError('The MariaDB baseline failed. DDL may have committed partially; inspect the selected database before retrying.');
      }
      logger.log(`Created the MariaDB schema in the existing database ${env.database.database} (v2.001).`);
    }

    let applied = await readAppliedVersions(connection);
    validateAppliedVersions(applied);
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      try {
        await executeStatements(connection, migration.statements);
        await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
      } catch {
        throw new SetupError(`MariaDB migration ${migration.version} failed. DDL may have committed partially; inspect the database before retrying.`);
      }
      applied.add(migration.version);
      logger.log(`Applied ${migration.version} (${migration.filename}).`);
    }
    if (migrations.every(({ version }) => applied.has(version))) logger.log('MariaDB schema is up to date.');
    return { created: !hasMigrations, appliedVersions: [...applied].sort() };
  } finally {
    if (locked) {
      try { await connection.execute('SELECT RELEASE_LOCK(?)', [APPLICATION_LOCK]); } catch { /* connection is released below */ }
    }
    connection.release();
    await closeDatabasePool();
  }
}

if (require.main === module) {
  runSetup().catch((error) => {
    if (error instanceof SetupError) console.error(`MariaDB setup failed: ${error.message}`);
    else console.error('MariaDB setup failed. Check DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD and database reachability.');
    process.exitCode = 1;
  });
}

module.exports = { SetupError, splitSqlStatements, readSqlFile, readForwardMigrations, validateAppliedVersions, validateTriggerDdl, runSetup };
