'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const mysql = require('mysql2/promise');
const os = require('node:os');
const path = require('node:path');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { ResetError, resetConfirmation, runReset } = require('../scripts/reset-demo-students-mariadb');

const socketPath = process.env.DEMO_STUDENT_RESET_TEST_SOCKET;
const projectRoot = path.resolve(__dirname, '..');

function quoteDatabase(value) { return `\`${value.replaceAll('`', '``')}\``; }
function uuid() { return crypto.randomUUID(); }
function fingerprint() { return crypto.randomBytes(32).toString('hex'); }

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function createFixture(admin, suffix) {
  const databaseName = `ark_demo_student_reset_${process.pid}_${suffix}`;
  await admin.query(`CREATE DATABASE ${quoteDatabase(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.query(`USE ${quoteDatabase(databaseName)}`);
  await applyStatements(admin, readSqlFile(path.join(projectRoot, 'database/mariadb/schema.sql')));
  const expectedVersions = ['v2.001', ...Array.from({ length: 16 }, (_, index) => `v2.${String(index + 2).padStart(3, '0')}`)];
  for (const migration of readForwardMigrations()) {
    if (migration.version > 'v2.017') break;
    await applyStatements(admin, migration.statements);
    await admin.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
  }
  const [fixtureVersions] = await admin.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(fixtureVersions.map(({ version }) => version), expectedVersions,
    'the reset rehearsal fixture must match the helper’s exact supported v2.017 schema');
  return databaseName;
}

async function seedResetGraph(connection, storageRoot, { files = 0 } = {}) {
  const [adminResult] = await connection.execute(`INSERT INTO users (email, password_hash, role)
    VALUES (?, 'fixture-only-not-a-login-hash', 'database_admin')`, [`reset-admin-${uuid()}@integration.invalid`]);
  const adminId = Number(adminResult.insertId);
  const [studentUserResult] = await connection.execute(`INSERT INTO users (email, password_hash, role)
    VALUES (?, 'fixture-only-not-a-login-hash', 'student')`, [`reset-student-${uuid()}@integration.invalid`]);
  const studentUserId = Number(studentUserResult.insertId);
  const [studentResult] = await connection.execute(`INSERT INTO students (user_id, student_no, lrn, first_name, last_name)
    VALUES (?, ?, ?, 'Fictional', 'Reset')`, [studentUserId, `RESET-${uuid()}`, String(900000000000 + Math.floor(Math.random() * 999999999))]);
  const studentId = Number(studentResult.insertId);

  const requestId = uuid();
  await connection.execute(`INSERT INTO student_document_requests
    (id, student_id, document_type, document_name, requested_on, requested_by, create_idempotency_key, create_request_fingerprint)
    VALUES (?, ?, 'good_moral', 'Fictional request', '2026-10-01', ?, ?, ?)`,
  [requestId, studentId, adminId, uuid(), fingerprint()]);
  const [clearanceResult] = await connection.execute(`INSERT INTO student_document_clearance_events
    (request_id, actor_id, event_type, clearance_status, debt_increase_revision, outstanding_snapshot,
     ledger_review_confirmed, idempotency_key, request_fingerprint)
    VALUES (?, ?, 'approved', 'approved', 0, 0, 1, ?, ?)`, [requestId, adminId, uuid(), fingerprint()]);
  const clearanceId = Number(clearanceResult.insertId);
  const [slipResult] = await connection.execute(`INSERT INTO student_document_claim_slips
    (request_id, finance_approval_event_id, event_type, expected_claim_date, idempotency_key,
     request_fingerprint, issued_by)
    VALUES (?, ?, 'issued', '2026-10-10', ?, ?, ?)`, [requestId, clearanceId, uuid(), fingerprint(), adminId]);
  await connection.execute('UPDATE student_document_requests SET current_claim_slip_id = ?, expected_claim_date = ? WHERE id = ?',
    [Number(slipResult.insertId), '2026-10-10', requestId]);

  const [termResult] = await connection.execute(`INSERT INTO academic_terms (school_year, term)
    VALUES ('2026-2027', 'Term 1')`);
  const [annualResult] = await connection.execute(`INSERT INTO annual_enrollments
    (student_id, school_year, grade_level, voucher_code, intake_status, created_by)
    VALUES (?, '2026-2027', 'Grade 11', 'PUB', 'enrolled', ?)`, [studentId, adminId]);
  const [enrollmentResult] = await connection.execute(`INSERT INTO enrollments
    (student_id, academic_term_id, annual_enrollment_id, annual_term_number, enrollment_status)
    VALUES (?, ?, ?, 1, 'enrolled')`, [studentId, Number(termResult.insertId), Number(annualResult.insertId)]);
  const [scheduleResult] = await connection.execute(`INSERT INTO finance_schedules
    (school_year, grade_level, voucher_code, version_no, idempotency_key, request_fingerprint, created_by)
    VALUES ('2026-2027', 'Grade 11', 'PUB', 1, ?, ?, ?)`, [uuid(), fingerprint(), adminId]);
  const [assessmentResult] = await connection.execute(`INSERT INTO annual_assessments
    (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by,
     selection_json, idempotency_key, request_fingerprint)
    VALUES (?, ?, 1, 'PUB', ?, '{}', ?, ?)`,
  [Number(annualResult.insertId), Number(scheduleResult.insertId), adminId, uuid(), fingerprint()]);
  const [chargeResult] = await connection.execute(`INSERT INTO assessed_charges
    (assessment_id, annual_enrollment_id, enrollment_id, fee_category, line_name, installment, amount, gross_amount)
    VALUES (?, ?, ?, 'tuition', 'Fictional fee', 'annual', 100.00, 100.00)`,
  [Number(assessmentResult.insertId), Number(annualResult.insertId), Number(enrollmentResult.insertId)]);
  const [adjustmentA] = await connection.execute(`INSERT INTO finance_charge_adjustments
    (charge_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
    VALUES (?, -5.00, 'Fictional reversal pair', ?, ?, ?)`, [Number(chargeResult.insertId), uuid(), fingerprint(), adminId]);
  const [adjustmentB] = await connection.execute(`INSERT INTO finance_charge_adjustments
    (charge_id, amount, reason, reverses_adjustment_id, idempotency_key, request_fingerprint, recorded_by)
    VALUES (?, 5.00, 'Fictional reversal pair', ?, ?, ?, ?)`,
  [Number(chargeResult.insertId), Number(adjustmentA.insertId), uuid(), fingerprint(), adminId]);
  await connection.execute('UPDATE finance_charge_adjustments SET reverses_adjustment_id = ? WHERE id = ?',
    [Number(adjustmentB.insertId), Number(adjustmentA.insertId)]);

  const [paymentA] = await connection.execute(`INSERT INTO finance_payments
    (student_id, amount, payment_date, idempotency_key, request_fingerprint, recorded_by)
    VALUES (?, 5.00, '2026-10-01', ?, ?, ?)`, [studentId, uuid(), fingerprint(), adminId]);
  const [paymentB] = await connection.execute(`INSERT INTO finance_payments
    (student_id, amount, payment_date, idempotency_key, request_fingerprint, recorded_by)
    VALUES (?, 5.00, '2026-10-02', ?, ?, ?)`, [studentId, uuid(), fingerprint(), adminId]);
  await connection.execute('UPDATE finance_payments SET reverses_payment_id = ? WHERE id = ?',
    [Number(paymentB.insertId), Number(paymentA.insertId)]);
  await connection.execute('UPDATE finance_payments SET reverses_payment_id = ? WHERE id = ?',
    [Number(paymentA.insertId), Number(paymentB.insertId)]);

  const fileIds = [];
  for (let index = 0; index < files; index += 1) {
    const storedFilename = `${uuid()}.pdf`;
    const relativePath = storedFilename;
    await fs.writeFile(path.join(storageRoot, relativePath), `fixture upload ${index}`, { mode: 0o600 });
    await connection.execute(`INSERT INTO documents
      (student_id, document_type, original_filename, stored_filename, mime_type, file_size_bytes, uploaded_by, upload_source)
      VALUES (?, 'good_moral', ?, ?, 'application/pdf', ?, ?, 'student')`,
    [studentId, `fixture-${index}.pdf`, storedFilename, Buffer.byteLength(`fixture upload ${index}`), studentUserId]);
    fileIds.push(relativePath);
  }
  return { adminId, studentId, studentUserId, fileIds };
}

function digestFile(filePath, content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

test('MariaDB demo reset binds target, rejects stale plans, clears FK cycles, and resumes exact file cleanup', {
  skip: !socketPath && 'Set DEMO_STUDENT_RESET_TEST_SOCKET to a disposable local MariaDB socket.',
  timeout: 240000
}, async () => {
  assert.ok(path.isAbsolute(socketPath));
  assert.ok(path.resolve(socketPath) === path.resolve(path.join(os.homedir(), '.local/share/arktiesiis/local-mariadb/mariadb.sock'))
    || path.resolve(socketPath).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'reset integration must use an explicitly disposable local socket');
  const admin = await mysql.createConnection({ socketPath, user: os.userInfo().username, multipleStatements: false });
  const suffix = crypto.randomBytes(4).toString('hex');
  const databaseName = await createFixture(admin, suffix);
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ark-reset-${suffix}-`));
  await fs.chmod(privateRoot, 0o700);
  const storageRoot = path.join(privateRoot, 'uploads');
  const manifestPath = path.join(privateRoot, 'pending-files.json');
  await fs.mkdir(storageRoot, { mode: 0o700 });
  const dbBackup = path.join(privateRoot, 'db-backup.sql');
  const uploadBackup = path.join(privateRoot, 'upload-backup.tar');
  await fs.writeFile(dbBackup, 'synthetic reset rehearsal backup', { mode: 0o600 });
  await fs.writeFile(uploadBackup, 'synthetic upload rehearsal backup', { mode: 0o600 });
  const database = { database: databaseName, socketPath, user: os.userInfo().username };
  const configuration = { database };
  const connectionFactory = () => mysql.createConnection({ socketPath, user: os.userInfo().username,
    database: databaseName, multipleStatements: false });
  const fixtureConnection = await connectionFactory();
  try {
    const seeded = await seedResetGraph(fixtureConnection, storageRoot, { files: 3 });
    await fixtureConnection.execute(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id)
      VALUES (?, 'fixture.created', 'reset-test', ?)`, [seeded.adminId, databaseName]);
    const [beforeCycle] = await fixtureConnection.execute(`SELECT
      (SELECT COUNT(*) FROM student_document_requests) AS requests,
      (SELECT COUNT(*) FROM student_document_claim_slips) AS slips,
      (SELECT COUNT(*) FROM student_document_clearance_events) AS clearances,
      (SELECT COUNT(*) FROM finance_payments WHERE reverses_payment_id IS NOT NULL) AS paymentLinks,
      (SELECT COUNT(*) FROM finance_charge_adjustments WHERE reverses_adjustment_id IS NOT NULL) AS adjustmentLinks`);
    assert.deepEqual(Object.values(beforeCycle[0]).map(Number), [1, 1, 1, 2, 2]);

    const vars = {
      RESET_DEMO_ALLOWED_DATABASE: databaseName,
      RESET_DEMO_CONFIRM: resetConfirmation(databaseName),
      RESET_DEMO_MAINTENANCE_CONFIRMED: 'true',
      RESET_DEMO_EXPECTED_STUDENTS: '1', RESET_DEMO_EXPECTED_STUDENT_USERS: '1',
      RESET_DEMO_DATABASE_BACKUP_VERIFIED: 'true', RESET_DEMO_UPLOAD_BACKUP_VERIFIED: 'true',
      RESET_DEMO_DATABASE_BACKUP_PATH: dbBackup, RESET_DEMO_DATABASE_BACKUP_SHA256: digestFile(dbBackup, 'synthetic reset rehearsal backup'),
      RESET_DEMO_UPLOAD_BACKUP_PATH: uploadBackup, RESET_DEMO_UPLOAD_BACKUP_SHA256: digestFile(uploadBackup, 'synthetic upload rehearsal backup'),
      RESET_DEMO_PENDING_FILES_MANIFEST: manifestPath, RESET_DEMO_STORAGE_ROOT: storageRoot
    };
    const logger = { log() {} };
    const preview = await runReset({ args: [], configuration, variables: { RESET_DEMO_ALLOWED_DATABASE: databaseName,
      RESET_DEMO_STORAGE_ROOT: storageRoot }, connectionFactory, logger });

    // A second host alias reaches this same socket/database in the test harness. Its plan must not reuse this digest.
    const changedEndpointConfig = { database: { database: databaseName, host: 'other-host.invalid', port: 3306, user: database.user } };
    await assert.rejects(runReset({ args: ['--apply'], configuration: changedEndpointConfig,
      variables: { ...vars, RESET_DEMO_EXPECTED_PLAN_SHA256: preview.plan.planDigest }, connectionFactory, logger }), /inventory no longer matches/);

    await fixtureConnection.execute(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id)
      VALUES (?, 'fixture.changed_after_preview', 'reset-test', ?)`, [seeded.adminId, databaseName]);
    await assert.rejects(runReset({ args: ['--apply'], configuration,
      variables: { ...vars, RESET_DEMO_EXPECTED_PLAN_SHA256: preview.plan.planDigest }, connectionFactory, logger }), /inventory no longer matches/);
    const [notDeleted] = await fixtureConnection.execute('SELECT COUNT(*) AS students FROM students');
    assert.equal(Number(notDeleted[0].students), 1, 'stale plan refusal leaves student rows intact');

    const currentPreview = await runReset({ args: [], configuration, variables: {
      RESET_DEMO_ALLOWED_DATABASE: databaseName, RESET_DEMO_STORAGE_ROOT: storageRoot
    }, connectionFactory, logger });
    const orderedFiles = currentPreview.plan.fileReferences.map(({ relativePath }) => relativePath);
    const applied = await runReset({ args: ['--apply'], configuration,
      variables: { ...vars, RESET_DEMO_EXPECTED_PLAN_SHA256: currentPreview.plan.planDigest },
      connectionFactory, logger, fileDeletion: async (entries) => {
        const firstRemoved = await require('../scripts/reset-demo-students-mariadb').deleteExactFiles(entries.slice(0, 1));
        const second = entries[1];
        await fs.writeFile(second.absolute, 'changed after database commit', { mode: 0o600 });
        assert.equal(firstRemoved, 1);
        throw new Error('simulated interrupted exact file cleanup');
      } });
    assert.equal(applied.fileCleanupFailed, true);
    assert.equal(applied.manifest.status, 'pending_local_files');
    assert.equal(applied.plan.students, 1);
    assert.equal(await fs.stat(path.join(storageRoot, orderedFiles[0])).then(() => false, () => true), true);
    assert.equal(await fs.readFile(path.join(storageRoot, orderedFiles[1]), 'utf8'), 'changed after database commit');
    await assert.rejects(runReset({ args: ['--resume-files'], configuration,
      variables: { ...vars, RESET_DEMO_PENDING_FILES_MANIFEST_SHA256: applied.manifestSha256 }, connectionFactory, logger }),
    /changed after preview/);
    assert.equal(await fs.readFile(path.join(storageRoot, orderedFiles[1]), 'utf8'), 'changed after database commit',
      'changed files are never removed by resume');
    await fs.unlink(path.join(storageRoot, orderedFiles[1]));
    const resumed = await runReset({ args: ['--resume-files'], configuration,
      variables: { ...vars, RESET_DEMO_PENDING_FILES_MANIFEST_SHA256: applied.manifestSha256 }, connectionFactory, logger });
    assert.equal(resumed.manifest.status, 'completed');
    assert.equal(resumed.removedFiles, 1);
    assert.equal(await fs.stat(path.join(storageRoot, orderedFiles[2])).then(() => false, () => true), true);

    const [after] = await fixtureConnection.execute(`SELECT
      (SELECT COUNT(*) FROM students) AS students,
      (SELECT COUNT(*) FROM users WHERE role = 'student') AS studentUsers,
      (SELECT COUNT(*) FROM users WHERE role = 'database_admin') AS admins,
      (SELECT COUNT(*) FROM staff_profiles) AS staffProfiles,
      (SELECT COUNT(*) FROM student_document_requests) AS requests,
      (SELECT COUNT(*) FROM student_document_claim_slips) AS slips,
      (SELECT COUNT(*) FROM student_document_clearance_events) AS clearances,
      (SELECT COUNT(*) FROM finance_payments) AS payments,
      (SELECT COUNT(*) FROM finance_charge_adjustments) AS adjustments`);
    assert.deepEqual(Object.values(after[0]).map(Number), [0, 0, 1, 0, 0, 0, 0, 0, 0]);
    const [resetAudit] = await fixtureConnection.execute(`SELECT COUNT(*) AS count FROM audit_logs
      WHERE action = 'maintenance.demo_student_data_reset' AND entity_id = ?`, [databaseName]);
    assert.equal(Number(resetAudit[0].count), 1);
  } finally {
    await fixtureConnection.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabase(databaseName)}`);
    await admin.end();
    await fs.rm(privateRoot, { recursive: true, force: true });
  }
});

test('database-only reset leaves a verified host-file manifest for explicit completion', {
  skip: !socketPath && 'Set DEMO_STUDENT_RESET_TEST_SOCKET to a disposable local MariaDB socket.',
  timeout: 180000
}, async () => {
  assert.ok(path.isAbsolute(socketPath));
  const admin = await mysql.createConnection({ socketPath, user: os.userInfo().username, multipleStatements: false });
  const suffix = crypto.randomBytes(4).toString('hex');
  const databaseName = await createFixture(admin, `host_${suffix}`);
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ark-reset-host-${suffix}-`));
  await fs.chmod(privateRoot, 0o700);
  const manifestPath = path.join(privateRoot, 'pending-host-files.json');
  const dbBackup = path.join(privateRoot, 'db.sql');
  const uploadBackup = path.join(privateRoot, 'uploads.tar');
  await fs.writeFile(dbBackup, 'database backup', { mode: 0o600 });
  await fs.writeFile(uploadBackup, 'upload backup', { mode: 0o600 });
  const connectionFactory = () => mysql.createConnection({ socketPath, user: os.userInfo().username,
    database: databaseName, multipleStatements: false });
  const connection = await connectionFactory();
  try {
    const seeded = await seedResetGraph(connection, privateRoot, { files: 1 });
    const vars = {
      RESET_DEMO_ALLOWED_DATABASE: databaseName, RESET_DEMO_CONFIRM: resetConfirmation(databaseName),
      RESET_DEMO_MAINTENANCE_CONFIRMED: 'true', RESET_DEMO_EXPECTED_STUDENTS: '1',
      RESET_DEMO_EXPECTED_STUDENT_USERS: '1', RESET_DEMO_EXPECTED_PLAN_SHA256: '',
      RESET_DEMO_DATABASE_BACKUP_VERIFIED: 'true', RESET_DEMO_UPLOAD_BACKUP_VERIFIED: 'true',
      RESET_DEMO_FILES_BACKUP_VERIFIED: 'true', RESET_DEMO_DATABASE_BACKUP_PATH: dbBackup,
      RESET_DEMO_DATABASE_BACKUP_SHA256: digestFile(dbBackup, 'database backup'),
      RESET_DEMO_UPLOAD_BACKUP_PATH: uploadBackup, RESET_DEMO_UPLOAD_BACKUP_SHA256: digestFile(uploadBackup, 'upload backup'),
      RESET_DEMO_PENDING_FILES_MANIFEST: manifestPath
    };
    const configuration = { database: { database: databaseName, socketPath, user: os.userInfo().username } };
    const logger = { log() {} };
    const preview = await runReset({ args: ['--database-only'], configuration,
      variables: { RESET_DEMO_ALLOWED_DATABASE: databaseName },
      connectionFactory, logger });
    const applied = await runReset({ args: ['--database-only', '--apply'], configuration,
      variables: { ...vars, RESET_DEMO_EXPECTED_PLAN_SHA256: preview.plan.planDigest }, connectionFactory, logger });
    assert.equal(applied.manifest.status, 'pending_host_files');
    assert.equal(applied.manifest.files.length, 1);
    assert.equal(applied.manifest.files[0].relativePath, seeded.fileIds[0]);
    const marked = await runReset({ args: ['--mark-files-removed'], configuration,
      variables: { ...vars, RESET_DEMO_PENDING_FILES_MANIFEST_SHA256: applied.manifestSha256,
        RESET_DEMO_FILES_REMOVED_CONFIRMED: 'true' }, connectionFactory, logger });
    assert.equal(marked.manifest.status, 'completed');
    const [students] = await connection.execute('SELECT COUNT(*) AS count FROM students');
    assert.equal(Number(students[0].count), 0);
  } finally {
    await connection.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabase(databaseName)}`);
    await admin.end();
    await fs.rm(privateRoot, { recursive: true, force: true });
  }
});
