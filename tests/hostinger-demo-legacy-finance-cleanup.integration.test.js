'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const mysql = require('mysql2/promise');
const os = require('node:os');
const path = require('node:path');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const {
  CLEANUP_ACTION, CLEANUP_MARKER, HOSTINGER_SEED_MARKER, EXPANSION_MARKER,
  LegacyFinanceCleanupError, parseOptions, readModernSnapshot, runCleanup
} = require('../scripts/cleanup-hostinger-demo-legacy-finance');

const socketPath = process.env.LEGACY_FINANCE_CLEANUP_TEST_SOCKET;
const databaseUser = process.env.LEGACY_FINANCE_CLEANUP_TEST_USER || 'root';
const tmpRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
const repoRoot = path.resolve(__dirname, '..');

function dbName() {
  return `arktiesiis_legacy_cleanup_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
}

async function runStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function createFixtureDatabase(adminPool) {
  const database = dbName();
  await adminPool.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = mysql.createPool({
    socketPath, user: databaseUser, password: '', database,
    waitForConnections: true, connectionLimit: 4, queueLimit: 0,
    supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
    dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false
  });
  const connection = await pool.getConnection();
  try {
    await runStatements(connection, readSqlFile(path.join(repoRoot, 'database/mariadb/schema.sql')));
    for (const migration of readForwardMigrations()) {
      if (migration.version > 'v2.015') break;
      await runStatements(connection, migration.statements);
      await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
    }
    const [fixtureVersions] = await connection.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(fixtureVersions.map(({ version }) => version), [
      'v2.001', ...Array.from({ length: 14 }, (_, index) => `v2.${String(index + 2).padStart(3, '0')}`)
    ], 'the legacy cleanup rehearsal fixture must match the helper’s exact supported v2.015 schema');

    const [actorResult] = await connection.execute(
      "INSERT INTO users (email, password_hash, role, is_active) VALUES (?, 'integration-fixture', 'database_admin', 1)",
      [`legacy-cleanup-${crypto.randomUUID()}@example.test`]
    );
    const actorId = Number(actorResult.insertId);
    await connection.execute(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id) VALUES
       (?, 'admin.demo_seeded', 'school_demo_seed', ?),
       (?, 'database_admin.demo_data_expanded', 'school_demo_expansion', ?)`,
      [actorId, HOSTINGER_SEED_MARKER, actorId, EXPANSION_MARKER]
    );

    const studentIds = [];
    for (let index = 0; index < 100; index += 1) {
      const serial = index + 1;
      const [studentResult] = await connection.execute(
        `INSERT INTO students (student_no, lrn, first_name, last_name)
         VALUES (?, ?, 'Demo', 'Cleanup Fixture')`,
        [`DEMO-HOSTINGER-${String(serial).padStart(4, '0')}`, String(880000000000 + serial)]
      );
      studentIds.push(Number(studentResult.insertId));
    }

    const targetStudentId = studentIds[0];
    const [accountResult] = await connection.execute(
      'INSERT INTO financial_accounts (student_id, balance) VALUES (?, 5500.00)', [targetStudentId]
    );
    const accountId = Number(accountResult.insertId);
    for (const amount of ['5000.00', '500.00']) {
      await connection.execute(
        `INSERT INTO financial_transactions
          (financial_account_id, transaction_type, amount, description, recorded_by, is_legacy_unattributed)
         VALUES (?, 'charge', ?, 'Fictional pre-ledger test charge', ?, 1)`,
        [accountId, amount, actorId]
      );
    }

    // Include modern annual assessment, charge, payment, and allocation rows to prove
    // the guarded cleanup leaves the current ledger intact.
    const modernStudentId = studentIds[1];
    const [termResult] = await connection.execute(
      "INSERT INTO academic_terms (school_year, term) VALUES ('2027-2028', 'Term 1')"
    );
    const [annualResult] = await connection.execute(
      `INSERT INTO annual_enrollments (student_id, school_year, grade_level, voucher_code, intake_status, created_by)
       VALUES (?, '2027-2028', 'Grade 11', 'PUB', 'enrolled', ?)`, [modernStudentId, actorId]
    );
    const annualId = Number(annualResult.insertId);
    const [enrollmentResult] = await connection.execute(
      `INSERT INTO enrollments (student_id, academic_term_id, enrollment_status, annual_enrollment_id,
        annual_term_number, term_scope_status)
       VALUES (?, ?, 'enrolled', ?, 1, 'applicable')`, [modernStudentId, Number(termResult.insertId), annualId]
    );
    const [scheduleResult] = await connection.execute(
      `INSERT INTO finance_schedules (school_year, grade_level, voucher_code, version_no, idempotency_key,
        request_fingerprint, created_by)
       VALUES ('2027-2028', 'Grade 11', 'PUB', 1, ?, ?, ?)`,
      [crypto.randomUUID(), 'a'.repeat(64), actorId]
    );
    const [lineResult] = await connection.execute(
      `INSERT INTO finance_schedule_lines (schedule_id, term_number, fee_category, line_name, installment, amount)
       VALUES (?, 1, 'tuition', 'Tuition', 'Term 1', 100.00)`, [Number(scheduleResult.insertId)]
    );
    const [assessmentResult] = await connection.execute(
      `INSERT INTO annual_assessments (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot,
        assessed_by, selection_json, idempotency_key, request_fingerprint)
       VALUES (?, ?, 1, 'PUB', ?, '{}', ?, ?)`,
      [annualId, Number(scheduleResult.insertId), actorId, crypto.randomUUID(), 'b'.repeat(64)]
    );
    const [chargeResult] = await connection.execute(
      `INSERT INTO assessed_charges (assessment_id, annual_enrollment_id, enrollment_id, schedule_line_id,
        fee_category, line_name, installment, amount, gross_amount, waived_amount)
       VALUES (?, ?, ?, ?, 'tuition', 'Tuition', 'Term 1', 100.00, 100.00, 0.00)`,
      [Number(assessmentResult.insertId), annualId, Number(enrollmentResult.insertId), Number(lineResult.insertId)]
    );
    const [paymentResult] = await connection.execute(
      `INSERT INTO finance_payments (student_id, amount, payment_date, idempotency_key, request_fingerprint, recorded_by)
       VALUES (?, 100.00, '2026-09-01', ?, ?, ?)`,
      [modernStudentId, crypto.randomUUID(), 'c'.repeat(64), actorId]
    );
    const [batchResult] = await connection.execute(
      `INSERT INTO finance_allocation_batches (payment_id, student_id, idempotency_key, request_fingerprint, allocated_by)
       VALUES (?, ?, ?, ?, ?)`,
      [Number(paymentResult.insertId), modernStudentId, crypto.randomUUID(), 'd'.repeat(64), actorId]
    );
    await connection.execute(
      `INSERT INTO finance_payment_allocations (payment_id, charge_id, amount, allocation_batch_id, allocated_by)
       VALUES (?, ?, 100.00, ?, ?)`,
      [Number(paymentResult.insertId), Number(chargeResult.insertId), Number(batchResult.insertId), actorId]
    );

    const requestId = crypto.randomUUID();
    await connection.execute(
      `INSERT INTO student_document_requests (id, student_id, document_type, document_name, requested_on,
        requested_by, create_idempotency_key, create_request_fingerprint)
       VALUES (?, ?, 'certificate', 'Demo clearance fixture', '2026-09-01', ?, ?, ?)`,
      [requestId, targetStudentId, actorId, crypto.randomUUID(), 'e'.repeat(64)]
    );
    await connection.execute(
      `INSERT INTO student_document_clearance_events (request_id, actor_id, event_type, clearance_status,
        debt_increase_revision, outstanding_snapshot, reason, payment_arrangement, ledger_review_confirmed,
        idempotency_key, request_fingerprint)
       VALUES (?, ?, 'approved', 'approved', 0, 5500.00, 'Fictional clearance review',
        'Fictional payment plan', 1, ?, ?)`,
      [requestId, actorId, crypto.randomUUID(), 'f'.repeat(64)]
    );

    const [legacyTransactionRows] = await connection.execute(
      'SELECT id FROM financial_transactions WHERE financial_account_id = ? ORDER BY id', [accountId]
    );
    const [revisionRows] = await connection.execute(
      'SELECT CAST(debt_increase_revision AS CHAR(40)) AS revision FROM students WHERE id = ?', [targetStudentId]
    );
    return {
      database, pool, actorId, targetStudentId, accountId,
      transactionIds: legacyTransactionRows.map(({ id }) => Number(id)),
      initialRevision: String(revisionRows[0].revision)
    };
  } catch (error) {
    await pool.end();
    throw error;
  } finally {
    connection.release();
  }
}

function optionsFor(database, mode, backup = null) {
  const args = [mode === 'apply' ? '--apply' : '--dry-run',
    '--target-database', database, '--confirm-database', database,
    '--confirm-seed-marker', HOSTINGER_SEED_MARKER,
    '--confirm-expansion-marker', EXPANSION_MARKER];
  if (mode === 'apply') args.push('--acknowledge-demo-legacy-finance-cleanup',
    '--backup-file', backup.path, '--backup-sha256', backup.sha256);
  return parseOptions(args, database);
}

function appConfiguration(database) {
  return {
    nodeEnv: 'production', devPasswordOnlyLogin: false,
    database: { host: 'db.example.test', database, user: 'fixture_user', password: 'fixture_password' }
  };
}

async function readState(pool, targetStudentId, accountId) {
  const [accountRows] = await pool.execute(
    'SELECT CAST(balance AS CHAR(40)) AS balance FROM financial_accounts WHERE id = ?', [accountId]
  );
  const [transactionRows] = await pool.execute(
    'SELECT COUNT(*) AS row_count, CAST(COALESCE(SUM(amount), 0) AS CHAR(40)) AS amount FROM financial_transactions WHERE financial_account_id = ?', [accountId]
  );
  const [studentRows] = await pool.execute(
    'SELECT CAST(debt_increase_revision AS CHAR(40)) AS revision FROM students WHERE id = ?', [targetStudentId]
  );
  const [clearanceRows] = await pool.execute(
    `SELECT clearance_status, CAST(debt_increase_revision AS CHAR(40)) AS revision
     FROM student_document_clearance_events AS event
     INNER JOIN student_document_requests AS request ON request.id = event.request_id
     WHERE request.student_id = ?`, [targetStudentId]
  );
  return {
    balance: String(accountRows[0].balance), transactions: Number(transactionRows[0].row_count),
    transactionAmount: String(transactionRows[0].amount), revision: String(studentRows[0].revision),
    clearanceStatus: clearanceRows[0].clearance_status, clearanceRevision: String(clearanceRows[0].revision)
  };
}

test('legacy finance cleanup option parsing and direct-call guards reject missing confirmation', async () => {
  const baseArgs = ['--dry-run', '--target-database', 'fixture_db', '--confirm-database', 'fixture_db',
    '--confirm-seed-marker', HOSTINGER_SEED_MARKER, '--confirm-expansion-marker', EXPANSION_MARKER];
  assert.equal(parseOptions(baseArgs, 'fixture_db').mode, 'dry-run');
  assert.throws(() => parseOptions([...baseArgs, '--apply'], 'fixture_db'), LegacyFinanceCleanupError);

  const config = appConfiguration('fixture_db');
  let connected = false;
  await assert.rejects(runCleanup({
    options: { ...parseOptions(baseArgs, 'fixture_db'), acknowledged: 'yes' },
    configuration: config, getConnection: async () => { connected = true; }
  }), LegacyFinanceCleanupError);
  await assert.rejects(runCleanup({
    options: { ...parseOptions(baseArgs, 'fixture_db'), expansionMarker: 'unexpected' },
    configuration: config, getConnection: async () => { connected = true; }
  }), LegacyFinanceCleanupError);
  assert.equal(connected, false, 'direct-call validation fails before opening a database connection');
});

test('guarded demo legacy finance cleanup preserves current ledger, clearance history, and is transactional/idempotent', {
  skip: !socketPath && 'Set LEGACY_FINANCE_CLEANUP_TEST_SOCKET to a disposable local MariaDB socket under /tmp.'
}, async () => {
  assert.equal(path.isAbsolute(socketPath), true);
  assert.equal(path.resolve(socketPath).startsWith(tmpRoot), true, 'the MariaDB socket must be an isolated test socket under /tmp');
  const adminPool = mysql.createPool({ socketPath, user: databaseUser, password: '', waitForConnections: true, connectionLimit: 2 });
  let fixture;
  let backupDirectory;
  try {
    fixture = await createFixtureDatabase(adminPool);
    const config = appConfiguration(fixture.database);
    const getConnection = () => fixture.pool.getConnection();
    const quietLogger = { log() {} };
    const beforeSnapshot = await readModernSnapshot(fixture.pool);
    let state = await readState(fixture.pool, fixture.targetStudentId, fixture.accountId);
    assert.deepEqual(state, { balance: '5500.00', transactions: 2, transactionAmount: '5500.00',
      revision: fixture.initialRevision, clearanceStatus: 'approved', clearanceRevision: fixture.initialRevision });
    assert.equal(beforeSnapshot.annualPayments.rows_count, '1');
    assert.equal(beforeSnapshot.paymentAllocations.rows_count, '1');
    assert.equal(beforeSnapshot.assessedCharges.rows_count, '1');

    const dryRun = await runCleanup({ options: optionsFor(fixture.database, 'dry-run'), configuration: config,
      getConnection, logger: quietLogger });
    assert.equal(dryRun.status, 'preview');
    assert.equal(dryRun.cohortStudents, 100);
    assert.deepEqual(await readState(fixture.pool, fixture.targetStudentId, fixture.accountId), state,
      'dry run performs no updates or deletes');

    // A dependency fails closed even when all other exact source guards match.
    const openingIdempotency = crypto.randomUUID();
    await fixture.pool.execute(
      `INSERT INTO finance_legacy_opening_charges
        (financial_account_id, student_id, amount, source_label, reason, idempotency_key, request_fingerprint, recorded_by)
       VALUES (?, ?, 1.00, 'fixture dependency', 'Test dependency only', ?, ?, ?)`,
      [fixture.accountId, fixture.targetStudentId, openingIdempotency, '1'.repeat(64), fixture.actorId]
    );
    await assert.rejects(runCleanup({ options: optionsFor(fixture.database, 'dry-run'), configuration: config,
      getConnection, logger: quietLogger }), /referenced by an opening balance/);
    assert.deepEqual(await readState(fixture.pool, fixture.targetStudentId, fixture.accountId), state,
      'dependency rejection leaves all target rows untouched');
    await fixture.pool.execute('DELETE FROM finance_legacy_opening_charges WHERE idempotency_key = ?', [openingIdempotency]);

    backupDirectory = await fs.mkdtemp(path.join(tmpRoot, 'ark-legacy-cleanup-backup-'));
    const backupPath = path.join(backupDirectory, 'before-cleanup.sql');
    await fs.writeFile(backupPath, '-- disposable cleanup integration fixture\n', { mode: 0o600 });
    await fs.chmod(backupPath, 0o600);
    const backup = { path: backupPath, sha256: crypto.createHash('sha256').update(await fs.readFile(backupPath)).digest('hex') };
    const applyOptions = optionsFor(fixture.database, 'apply', backup);

    // Fail at the final audit write, after the account and legacy rows were modified,
    // to prove MariaDB rolls the complete transaction back.
    const rollbackConnection = await getConnection();
    const rollbackProxy = {
      execute(statement, values) {
        if (/^\s*INSERT INTO audit_logs/i.test(statement)) throw new Error('integration failure before commit');
        return rollbackConnection.execute(statement, values);
      },
      query: (...args) => rollbackConnection.query(...args),
      beginTransaction: (...args) => rollbackConnection.beginTransaction(...args),
      commit: (...args) => rollbackConnection.commit(...args),
      rollback: (...args) => rollbackConnection.rollback(...args),
      release: (...args) => rollbackConnection.release(...args)
    };
    await assert.rejects(runCleanup({ options: applyOptions, configuration: config,
      getConnection: async () => rollbackProxy, logger: quietLogger }), /any transaction was rolled back/);
    assert.deepEqual(await readState(fixture.pool, fixture.targetStudentId, fixture.accountId), state,
      'audit failure rolls back the account reset, transaction deletes, and debt revision bump');

    let committed = false;
    const committedLogger = { log(serialized) {
      assert.equal(committed, true, 'success is logged only after MariaDB commit');
      committedMessages.push(JSON.parse(serialized));
    } };
    const committedMessages = [];
    const trackedConnection = await getConnection();
    const trackedProxy = {
      execute: (...args) => trackedConnection.execute(...args),
      query: (...args) => trackedConnection.query(...args),
      async beginTransaction(...args) { return trackedConnection.beginTransaction(...args); },
      async commit(...args) { const result = await trackedConnection.commit(...args); committed = true; return result; },
      rollback: (...args) => trackedConnection.rollback(...args),
      release: (...args) => trackedConnection.release(...args)
    };
    const applied = await runCleanup({ options: applyOptions, configuration: config,
      getConnection: async () => trackedProxy, logger: committedLogger });
    assert.equal(applied.status, 'completed');
    assert.equal(committedMessages[0]?.status, 'completed');
    state = await readState(fixture.pool, fixture.targetStudentId, fixture.accountId);
    assert.deepEqual(state, { balance: '0.00', transactions: 0, transactionAmount: '0.00',
      revision: (BigInt(fixture.initialRevision) + 1n).toString(), clearanceStatus: 'approved', clearanceRevision: fixture.initialRevision },
    'the prior clearance remains historical evidence and is stale by revision; cleanup does not sign or rewrite it');
    assert.deepEqual(await readModernSnapshot(fixture.pool), beforeSnapshot,
      'annual charges, payments, allocations, and other modern ledger rows are unchanged');
    const [auditRows] = await fixture.pool.execute(
      'SELECT COUNT(*) AS row_count FROM audit_logs WHERE action = ? AND entity_type = ? AND entity_id = ?',
      [CLEANUP_ACTION, 'school_demo_finance_cleanup', CLEANUP_MARKER]
    );
    assert.equal(Number(auditRows[0].row_count), 1);

    committed = false;
    const retryConnection = await getConnection();
    const retryProxy = {
      execute: (...args) => retryConnection.execute(...args),
      query: (...args) => retryConnection.query(...args),
      async beginTransaction(...args) { return retryConnection.beginTransaction(...args); },
      async commit(...args) { const result = await retryConnection.commit(...args); committed = true; return result; },
      rollback: (...args) => retryConnection.rollback(...args),
      release: (...args) => retryConnection.release(...args)
    };
    const retry = await runCleanup({ options: applyOptions, configuration: config,
      getConnection: async () => retryProxy, logger: committedLogger });
    assert.equal(retry.status, 'already-applied');
    assert.equal(committedMessages[1]?.status, 'already-applied');
    assert.deepEqual(await readState(fixture.pool, fixture.targetStudentId, fixture.accountId), state,
      'retry does not increment the debt revision or repeat cleanup');
  } finally {
    if (fixture) await fixture.pool.end();
    if (fixture?.database) await adminPool.query(`DROP DATABASE IF EXISTS \`${fixture.database}\``);
    if (backupDirectory) await fs.rm(backupDirectory, { recursive: true, force: true });
    await adminPool.end();
  }
});
