'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getPool, closePool } = require('../src/config/database');
const env = require('../src/config/environment');

const BASELINE_VERSION = 'v2.001';
const BASELINE_PATH = path.resolve(__dirname, '../database/mariadb/schema.sql');
const MIGRATIONS_DIRECTORY = path.resolve(__dirname, '../database/mariadb/migrations');
const APPLICATION_LOCK = 'ARKTIESIIS MariaDB schema setup';
const KNOWN_VERSIONS = new Set(Array.from({ length: 17 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`));

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
      else if (character === '-' && next === '-') state = 'line-comment';
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

function readSqlFile(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new SetupError(`Could not read SQL file ${path.relative(process.cwd(), filePath)}.`);
  }
  if (/\b(?:CREATE|DROP)\s+DATABASE\b|\bCREATE\s+(?:TRIGGER|PROCEDURE)\b|\bDEFINER\s*=/i.test(contents)) {
    throw new SetupError(`SQL file ${path.relative(process.cwd(), filePath)} uses DDL disallowed by the Hostinger setup path.`);
  }
  const statements = splitSqlStatements(contents);
  if (!statements.length) throw new SetupError(`SQL file ${path.relative(process.cwd(), filePath)} is empty.`);
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
  return filenames.map((filename) => {
    const sequence = filename.slice(0, 3);
    const version = `v2.${sequence}`;
    if (sequence === '001' || !KNOWN_VERSIONS.has(version) || seen.has(version)) {
      throw new SetupError('The MariaDB migration sequence is invalid.');
    }
    seen.add(version);
    return { filename, version, statements: readSqlFile(path.join(MIGRATIONS_DIRECTORY, filename)) };
  });
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
  for (let sequence = 2; sequence <= 17; sequence += 1) {
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

module.exports = { SetupError, splitSqlStatements, readSqlFile, readForwardMigrations, validateAppliedVersions, runSetup };
