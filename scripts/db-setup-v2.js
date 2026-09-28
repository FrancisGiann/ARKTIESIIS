const fs = require('node:fs');
const path = require('node:path');
const sql = require('mssql');
const env = require('../src/config/environment');

const PROJECT_DATABASE = 'ARKTIESIIS_V2';
const BASELINE_VERSION = 'v2.001';
const BASELINE_PATH = path.resolve(__dirname, '../database/v2/schema.sql');
const MIGRATIONS_DIRECTORY = path.resolve(__dirname, '../database/v2/migrations');
const APPLICATION_LOCK = 'ARKTIESIIS_V2 consolidated schema setup';

class SetupError extends Error {}

function makeSqlConfig(database, maxPoolSize = 10) {
  return {
    server: env.database.server,
    port: env.database.port,
    database,
    user: env.database.user,
    password: env.database.password,
    options: {
      encrypt: env.database.encrypt,
      trustServerCertificate: env.database.trustServerCertificate
    },
    pool: { max: maxPoolSize, min: 0, idleTimeoutMillis: 30000 }
  };
}

function splitSqlBatches(contents) {
  const batches = [];
  let lines = [];
  for (const line of contents.split(/\r?\n/)) {
    if (/^\s*GO\s*(?:--.*)?$/i.test(line)) {
      const batch = lines.join('\n').trim();
      if (batch) batches.push(batch);
      lines = [];
    } else {
      lines.push(line);
    }
  }
  const lastBatch = lines.join('\n').trim();
  if (lastBatch) batches.push(lastBatch);
  return batches;
}

function readBaselineBatches() {
  let contents;
  try {
    contents = fs.readFileSync(BASELINE_PATH, 'utf8');
  } catch {
    throw new SetupError('Could not read the ARKTIESIIS V2 fresh-install schema.');
  }
  const batches = splitSqlBatches(contents);
  validateBaselinePrelude(batches);
  if (batches.length < 4) throw new SetupError('The ARKTIESIIS V2 baseline is incomplete.');
  return batches;
}

function stripLeadingSqlComments(batch) {
  return batch.replace(/^(?:\s|\/\*[\s\S]*?\*\/|--[^\r\n]*(?:\r?\n|$))*/, '').trim();
}

function validateBaselinePrelude(batches) {
  if (!Array.isArray(batches) || batches.length < 3) {
    throw new SetupError('The V2 baseline must start with CREATE DATABASE ARKTIESIIS_V2 and USE ARKTIESIIS_V2.');
  }
  const create = stripLeadingSqlComments(batches[0]);
  const use = stripLeadingSqlComments(batches[1]);
  const createsV2 = /^IF\s+DB_ID\s*\(\s*'ARKTIESIIS_V2'\s*\)\s+IS\s+NULL\b[\s\S]*\bCREATE\s+DATABASE\s+ARKTIESIIS_V2\b[\s\S]*\bEND\s*;?$/i.test(create);
  const selectsV2 = /^USE\s+\[?ARKTIESIIS_V2\]?\s*;?$/i.test(use);
  if (!createsV2 || !selectsV2) {
    throw new SetupError('The V2 baseline must create and select only ARKTIESIIS_V2.');
  }
}

function readForwardMigrations(directory = MIGRATIONS_DIRECTORY) {
  let filenames;
  try {
    filenames = fs.readdirSync(directory)
      .filter((filename) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(filename))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new SetupError('Could not read the ARKTIESIIS V2 forward migrations.');
  }

  const seenVersions = new Set();
  return filenames.map((filename) => {
    const sequence = filename.slice(0, 3);
    const version = `v2.${sequence}`;
    if (sequence === '001' || seenVersions.has(version)) {
      throw new SetupError('The V2 forward migration sequence is invalid.');
    }
    seenVersions.add(version);
    let contents;
    try {
      contents = fs.readFileSync(path.join(directory, filename), 'utf8');
    } catch {
      throw new SetupError('Could not read a V2 forward migration.');
    }
    const batches = splitSqlBatches(contents);
    if (!batches.length) throw new SetupError('A V2 forward migration is empty.');
    return { filename, version, batches };
  });
}

async function databaseExists() {
  const pool = new sql.ConnectionPool(makeSqlConfig('master', 1));
  try {
    await pool.connect();
    const result = await pool.request()
      .input('databaseName', sql.NVarChar(128), PROJECT_DATABASE)
      .query('SELECT DB_ID(@databaseName) AS databaseId;');
    return result.recordset?.[0]?.databaseId !== null;
  } finally {
    await pool.close();
  }
}

async function ensureDatabaseExists() {
  const batches = readBaselineBatches();
  const pool = new sql.ConnectionPool(makeSqlConfig('master', 1));
  try {
    await pool.connect();
    await pool.request().batch(batches[0]);
  } finally {
    await pool.close();
  }
  return batches;
}

async function acquireSetupLock(transaction, sqlDriver = sql) {
  await new sqlDriver.Request(transaction)
    .input('resource', sql.NVarChar(255), APPLICATION_LOCK)
    .query(`DECLARE @lockResult INT;
      EXEC @lockResult = sys.sp_getapplock
        @Resource = @resource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 60000;
      IF @lockResult < 0 THROW 51000, 'Could not acquire the V2 setup lock.', 1;`);
}

async function applyFreshBaseline(pool, batches, { sqlDriver = sql, migrations = readForwardMigrations() } = {}) {
  const transaction = new sqlDriver.Transaction(pool);
  try {
    await transaction.begin(sqlDriver.ISOLATION_LEVEL.SERIALIZABLE);
    await acquireSetupLock(transaction, sqlDriver);

    const state = await new sql.Request(transaction).query(`
      SELECT OBJECT_ID(N'dbo.schema_migrations', N'U') AS migrationTableId,
        (SELECT COUNT_BIG(*) FROM sys.tables WHERE is_ms_shipped = 0) AS userTableCount;
    `);
    const { migrationTableId, userTableCount } = state.recordset[0];

    if (migrationTableId !== null) {
      const versions = await new sql.Request(transaction).query('SELECT [version] FROM dbo.schema_migrations;');
      const applied = new Set((versions.recordset || []).map(({ version }) => String(version)));
      const knownVersions = new Set([BASELINE_VERSION, ...migrations.map(({ version }) => version)]);
      if (applied.has(BASELINE_VERSION) && [...applied].every((version) => knownVersions.has(version))) {
        await transaction.rollback();
        return false;
      }
      throw new SetupError('ARKTIESIIS_V2 already has an unexpected schema version. The baseline was not rerun.');
    }

    if (Number(userTableCount) > 0) {
      throw new SetupError('ARKTIESIIS_V2 contains tables but no V2 baseline marker. Inspect it before setup.');
    }

    for (const batch of batches.slice(2)) {
      await new sql.Request(transaction).batch(batch);
    }
    await transaction.commit();
    return true;
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // SQL Server may already have rolled the transaction back.
    }
    if (error instanceof SetupError) throw error;
    throw new SetupError('The V2 baseline failed and was rolled back. Check SQL Server availability and permissions.');
  }
}

async function applyPendingMigrations(pool, migrations = readForwardMigrations(), {
  sqlDriver = sql,
  transactionFactory = (databasePool) => new sqlDriver.Transaction(databasePool)
} = {}) {
  const appliedNow = [];
  for (const migration of migrations) {
    if (!/^v2\.\d{3}$/.test(migration?.version) || !Array.isArray(migration.batches) || !migration.batches.length) {
      throw new SetupError('A V2 forward migration has invalid metadata.');
    }
    const transaction = transactionFactory(pool);
    let started = false;
    try {
      await transaction.begin(sqlDriver.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      await acquireSetupLock(transaction, sqlDriver);
      const existing = await new sqlDriver.Request(transaction)
        .input('version', sqlDriver.NVarChar(50), migration.version)
        .query('SELECT [version] FROM dbo.schema_migrations WITH (UPDLOCK, HOLDLOCK) WHERE [version] = @version;');
      if (existing.recordset?.length) {
        await transaction.rollback();
        started = false;
        continue;
      }

      for (const batch of migration.batches) {
        await new sqlDriver.Request(transaction).batch(batch);
      }
      await new sqlDriver.Request(transaction)
        .input('version', sqlDriver.NVarChar(50), migration.version)
        .query('INSERT INTO dbo.schema_migrations ([version]) VALUES (@version);');
      await transaction.commit();
      started = false;
      appliedNow.push(migration.version);
    } catch {
      if (started) {
        try {
          await transaction.rollback();
        } catch {
          // SQL Server may already have rolled back the transaction.
        }
      }
      throw new SetupError(`V2 migration ${migration.version} failed and was rolled back.`);
    }
  }
  return appliedNow;
}

async function setupDatabase() {
  if (!env.database.password) {
    throw new SetupError('DB_PASSWORD is required. Copy .env.example to .env and configure SQL Server credentials.');
  }

  let batches;
  const migrations = readForwardMigrations();
  const existed = await databaseExists();
  if (!existed) batches = await ensureDatabaseExists();
  else batches = readBaselineBatches();

  const pool = new sql.ConnectionPool(makeSqlConfig(PROJECT_DATABASE));
  try {
    await pool.connect();
    const created = await applyFreshBaseline(pool, batches, { migrations });
    const appliedMigrations = await applyPendingMigrations(pool, migrations);
    console.log(created
      ? `Created ${PROJECT_DATABASE} from its consolidated fresh-install baseline (${BASELINE_VERSION}).`
      : `${PROJECT_DATABASE} already has the expected baseline (${BASELINE_VERSION}); no changes were made.`);
    if (appliedMigrations.length) console.log(`Applied V2 migrations: ${appliedMigrations.join(', ')}.`);
  } finally {
    await pool.close();
  }
}

if (require.main === module) {
  setupDatabase().catch((error) => {
    if (error instanceof SetupError) console.error(`V2 database setup failed: ${error.message}`);
    else console.error('V2 database setup failed. Confirm SQL Server is running and DB_SERVER, DB_PORT, DB_USER, and DB_PASSWORD are correct.');
    process.exitCode = 1;
  });
}

module.exports = {
  SetupError,
  splitSqlBatches,
  readForwardMigrations,
  validateBaselinePrelude,
  applyPendingMigrations,
  setupDatabase
};
