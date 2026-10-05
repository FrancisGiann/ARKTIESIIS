'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isIP } = require('node:net');
const environment = require('../src/config/environment');
const { getPool, closePool } = require('../src/config/database');
const { HOSTINGER_SEED_MARKER, EXPANSION_MARKER } = require('./expand-hostinger-demo');

const CLEANUP_MARKER = 'hostinger-demo-legacy-finance-cleanup-v1';
const CLEANUP_ACTION = 'database_admin.demo_legacy_finance_cleared';
const APPLICATION_LOCK = 'ARKTIESIIS Hostinger demo legacy-finance cleanup v1';
const EXPECTED_STUDENT_COUNT = 100;
const EXPECTED_TRANSACTION_COUNT = 2;
const EXPECTED_BALANCE_CENTS = 550000n;
const PROJECT_ROOT = path.resolve(__dirname, '..');

class LegacyFinanceCleanupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'LegacyFinanceCleanupError';
    this.status = status;
  }
}

function parseOptions(args, configuredDatabase = environment.database.database) {
  if (!Array.isArray(args)) throw new LegacyFinanceCleanupError('Cleanup arguments are invalid.');
  const options = {
    mode: null, targetDatabase: null, confirmDatabase: null,
    seedMarker: null, expansionMarker: null, acknowledged: false,
    backupFile: null, backupSha256: null
  };
  const seen = new Set();
  const values = new Map([
    ['--target-database', 'targetDatabase'], ['--confirm-database', 'confirmDatabase'],
    ['--confirm-seed-marker', 'seedMarker'], ['--confirm-expansion-marker', 'expansionMarker'],
    ['--backup-file', 'backupFile'], ['--backup-sha256', 'backupSha256']
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (options.mode) throw new LegacyFinanceCleanupError('Choose exactly one mode: --dry-run or --apply.');
      options.mode = argument.slice(2);
    } else if (values.has(argument)) {
      if (seen.has(argument) || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new LegacyFinanceCleanupError(`Provide one value for ${argument}.`);
      }
      options[values.get(argument)] = args[index + 1];
      seen.add(argument);
      index += 1;
    } else if (argument === '--acknowledge-demo-legacy-finance-cleanup') {
      if (options.acknowledged) throw new LegacyFinanceCleanupError('The cleanup acknowledgement was repeated.');
      options.acknowledged = true;
    } else {
      throw new LegacyFinanceCleanupError('Cleanup arguments are invalid.');
    }
  }

  if (!options.mode || !options.targetDatabase || !options.confirmDatabase || !options.seedMarker || !options.expansionMarker) {
    throw new LegacyFinanceCleanupError('Provide a mode, the exact database name twice, and both Hostinger demo source markers.');
  }
  if (options.targetDatabase !== options.confirmDatabase || options.targetDatabase !== configuredDatabase) {
    throw new LegacyFinanceCleanupError('Both confirmed database names must exactly match DB_NAME.');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.targetDatabase)) throw new LegacyFinanceCleanupError('The target database name is invalid.');
  if (options.seedMarker !== HOSTINGER_SEED_MARKER || options.expansionMarker !== EXPANSION_MARKER) {
    throw new LegacyFinanceCleanupError('Confirm the exact Hostinger demo seed and expansion markers.');
  }
  if (options.mode === 'apply') {
    if (!options.acknowledged) throw new LegacyFinanceCleanupError('Apply requires --acknowledge-demo-legacy-finance-cleanup.');
    if (!options.backupFile || !options.backupSha256) throw new LegacyFinanceCleanupError('Apply requires the verified private backup path and SHA-256.');
  } else if (options.acknowledged || options.backupFile || options.backupSha256) {
    throw new LegacyFinanceCleanupError('The apply acknowledgement and backup are only valid with --apply.');
  }
  return options;
}

function validateProductionTarget(configuration = environment) {
  if (configuration.nodeEnv !== 'production') throw new LegacyFinanceCleanupError('The demo finance cleanup requires NODE_ENV=production.');
  if (configuration.devPasswordOnlyLogin) throw new LegacyFinanceCleanupError('Development password-only login must remain disabled.');
  const database = configuration.database || {};
  const host = String(database.host || '').trim().toLowerCase();
  const addressType = isIP(host);
  if (!host || host === 'localhost' || host === '::1' || (addressType === 4 && /^127\./.test(host))) {
    throw new LegacyFinanceCleanupError('The cleanup requires the remote MariaDB host from hPanel.');
  }
  if (!database.database || !database.user || String(database.user).toLowerCase() === 'root' || !database.password) {
    throw new LegacyFinanceCleanupError('DB_NAME, DB_USER, and DB_PASSWORD must identify the existing hPanel database.');
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function validateBackup(options) {
  if (!path.isAbsolute(options.backupFile)) throw new LegacyFinanceCleanupError('The backup path must be absolute.');
  if (!/^[a-f0-9]{64}$/i.test(options.backupSha256)) throw new LegacyFinanceCleanupError('The backup SHA-256 is invalid.');
  let stat;
  try { stat = await fs.lstat(options.backupFile); } catch { throw new LegacyFinanceCleanupError('The approved private backup file could not be opened.'); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new LegacyFinanceCleanupError('The backup must be a non-empty regular file with private permissions and no symlink.');
  }
  const realPath = await fs.realpath(options.backupFile);
  const relative = path.relative(PROJECT_ROOT, realPath);
  const insideRepository = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  const pathSegments = realPath.split(path.sep).map((part) => part.toLowerCase());
  if (insideRepository || pathSegments.includes('public_html')) {
    throw new LegacyFinanceCleanupError('The backup must be stored outside the application repository and Hostinger public_html.');
  }
  const actualSha256 = await sha256File(realPath);
  if (actualSha256.toLowerCase() !== options.backupSha256.toLowerCase()) {
    throw new LegacyFinanceCleanupError('The approved backup SHA-256 does not match the file.');
  }
  return { sha256: actualSha256, sizeBytes: stat.size };
}

async function queryRows(connection, statement, values = []) {
  const [rows] = await connection.execute(statement, values);
  return rows;
}

function cents(value) {
  const match = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/.exec(String(value ?? ''));
  if (!match) throw new LegacyFinanceCleanupError('A finance balance did not match the expected decimal format.');
  const result = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  return match[1] ? -result : result;
}

function money(centsValue) {
  const sign = centsValue < 0n ? '-' : '';
  const absolute = centsValue < 0n ? -centsValue : centsValue;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

async function requireCurrentSchema(connection) {
  const rows = await queryRows(connection, 'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
  if (rows[0]?.version !== 'v2.015') throw new LegacyFinanceCleanupError('The confirmed database is not at schema v2.015.');
}

async function requireSourceMarkers(connection, lockRows) {
  const suffix = lockRows ? ' FOR UPDATE' : '';
  const markers = await queryRows(connection,
    `SELECT marker.entity_type, marker.entity_id, marker.action, marker.user_id, actor.role, actor.is_active
      FROM audit_logs AS marker
      INNER JOIN users AS actor ON actor.id = marker.user_id
      WHERE (marker.entity_type = ? AND marker.entity_id = ?)
        OR (marker.entity_type = ? AND marker.entity_id = ?)
      ORDER BY marker.entity_type${suffix}`,
    ['school_demo_seed', HOSTINGER_SEED_MARKER, 'school_demo_expansion', EXPANSION_MARKER]);
  const seed = markers.filter((row) => row.entity_type === 'school_demo_seed' && row.entity_id === HOSTINGER_SEED_MARKER);
  const expansion = markers.filter((row) => row.entity_type === 'school_demo_expansion' && row.entity_id === EXPANSION_MARKER);
  if (markers.length !== 2 || seed.length !== 1 || expansion.length !== 1
    || seed[0].action !== 'admin.demo_seeded' || expansion[0].action !== 'database_admin.demo_data_expanded'
    || markers.some((row) => row.role !== 'database_admin') || Number(expansion[0].is_active) !== 1) {
    throw new LegacyFinanceCleanupError('The exact database-admin Hostinger seed and expansion markers were not found.');
  }
  return { actorId: Number(expansion[0].user_id) };
}

async function findTarget(connection, lockRows) {
  const suffix = lockRows ? ' FOR UPDATE' : '';
  const students = await queryRows(connection,
    `SELECT id, CAST(debt_increase_revision AS CHAR(40)) AS debt_increase_revision
      FROM students WHERE student_no LIKE 'DEMO-HOSTINGER-%' ORDER BY id${suffix}`);
  if (students.length !== EXPECTED_STUDENT_COUNT) {
    throw new LegacyFinanceCleanupError(`The reserved fictional demo cohort must contain exactly ${EXPECTED_STUDENT_COUNT} students.`);
  }
  const studentIds = students.map(({ id }) => Number(id));
  const placeholders = studentIds.map(() => '?').join(',');
  const accounts = await queryRows(connection,
    `SELECT id, student_id, CAST(balance AS CHAR(40)) AS balance FROM financial_accounts
      WHERE student_id IN (${placeholders}) ORDER BY id${suffix}`, studentIds);
  if (accounts.length !== 1) throw new LegacyFinanceCleanupError('The reserved demo finance scope must contain exactly one legacy account row.');
  const account = accounts[0];
  const transactions = await queryRows(connection,
    `SELECT id, transaction_type, CAST(amount AS CHAR(40)) AS amount, is_legacy_unattributed
      FROM financial_transactions WHERE financial_account_id = ? ORDER BY id${suffix}`,
    [Number(account.id)]);
  const accountStudent = students.find((student) => Number(student.id) === Number(account.student_id));
  if (!accountStudent) throw new LegacyFinanceCleanupError('The legacy finance account is not owned by the reserved demo cohort.');
  return {
    studentCount: studentIds.length, account, transactions,
    studentDebtRevision: String(accountStudent.debt_increase_revision)
  };
}

async function readOutsideCohortInventory(connection) {
  const [transactions] = await queryRows(connection,
    `SELECT COUNT(*) AS row_count, CAST(COALESCE(SUM(transaction_record.amount), 0) AS CHAR(40)) AS amount
      FROM financial_transactions AS transaction_record
      INNER JOIN financial_accounts AS account ON account.id = transaction_record.financial_account_id
      INNER JOIN students AS student ON student.id = account.student_id
      WHERE transaction_record.is_legacy_unattributed = 1 AND student.student_no NOT LIKE 'DEMO-HOSTINGER-%'`);
  const [accounts] = await queryRows(connection,
    `SELECT COUNT(*) AS row_count, CAST(COALESCE(SUM(account.balance), 0) AS CHAR(40)) AS amount
      FROM financial_accounts AS account
      INNER JOIN students AS student ON student.id = account.student_id
      WHERE account.balance <> 0 AND student.student_no NOT LIKE 'DEMO-HOSTINGER-%'`);
  return {
    flaggedLegacyTransactions: Number(transactions.row_count || 0),
    flaggedLegacyTransactionAmount: String(transactions.amount || '0.00'),
    nonzeroFinancialAccounts: Number(accounts.row_count || 0),
    nonzeroFinancialAccountBalance: String(accounts.amount || '0.00')
  };
}

async function readDependencies(connection, accountId, transactionIds) {
  const transactionFilter = transactionIds.length ? transactionIds.map(() => '?').join(',') : 'NULL';
  const checks = [
    ['openingLiabilities', `SELECT COUNT(*) AS count FROM finance_legacy_opening_charges WHERE financial_account_id = ?`, [accountId]],
    ['reconciliationBatches', `SELECT COUNT(*) AS count FROM finance_legacy_reconciliation_batches WHERE transaction_id IN (${transactionFilter})`, transactionIds],
    ['reconciliations', `SELECT COUNT(*) AS count FROM finance_legacy_reconciliations WHERE transaction_id IN (${transactionFilter})`, transactionIds],
    ['reconciliationReleases', `SELECT COUNT(*) AS count FROM finance_legacy_reconciliation_releases AS release_row
      INNER JOIN finance_legacy_reconciliations AS reconciliation ON reconciliation.id = release_row.reconciliation_id
      WHERE reconciliation.transaction_id IN (${transactionFilter})`, transactionIds],
    ['transactionReversals', `SELECT COUNT(*) AS count FROM finance_transaction_reversals WHERE transaction_id IN (${transactionFilter})`, transactionIds],
    ['enrollmentClearances', `SELECT COUNT(*) AS count FROM enrollment_clearances WHERE payment_transaction_id IN (${transactionFilter})`, transactionIds]
  ];
  const result = {};
  for (const [key, statement, values] of checks) {
    const rows = await queryRows(connection, statement, values);
    result[key] = Number(rows[0]?.count || 0);
  }
  return result;
}

async function readModernSnapshot(connection) {
  const queries = {
    annualEnrollments: `SELECT COUNT(*) AS rows_count FROM annual_enrollments AS annual
      INNER JOIN students AS student ON student.id = annual.student_id WHERE student.student_no LIKE 'DEMO-HOSTINGER-%'`,
    assessments: `SELECT COUNT(*) AS rows_count FROM annual_assessments AS assessment
      INNER JOIN annual_enrollments AS annual ON annual.id = assessment.annual_enrollment_id
      INNER JOIN students AS student ON student.id = annual.student_id WHERE student.student_no LIKE 'DEMO-HOSTINGER-%'`,
    registrarConfirmations: `SELECT COUNT(*) AS rows_count FROM annual_registrar_confirmations AS confirmation
      INNER JOIN annual_enrollments AS annual ON annual.id = confirmation.annual_enrollment_id
      INNER JOIN students AS student ON student.id = annual.student_id WHERE student.student_no LIKE 'DEMO-HOSTINGER-%'`,
    assessedCharges: `SELECT COUNT(*) AS rows_count,
        CAST(COALESCE(SUM(charge.amount), 0) AS CHAR(40)) AS net_amount,
        CAST(COALESCE(SUM(charge.gross_amount), 0) AS CHAR(40)) AS gross_amount,
        CAST(COALESCE(SUM(charge.waived_amount), 0) AS CHAR(40)) AS waived_amount
      FROM assessed_charges AS charge INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
      INNER JOIN students AS student ON student.id = annual.student_id WHERE student.student_no LIKE 'DEMO-HOSTINGER-%'`,
    chargeAdjustments: `SELECT COUNT(*) AS rows_count, CAST(COALESCE(SUM(adjustment.amount), 0) AS CHAR(40)) AS amount
      FROM finance_charge_adjustments AS adjustment INNER JOIN assessed_charges AS charge ON charge.id = adjustment.charge_id
      INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
      INNER JOIN students AS student ON student.id = annual.student_id WHERE student.student_no LIKE 'DEMO-HOSTINGER-%'`,
    annualPayments: `SELECT COUNT(*) AS rows_count, CAST(COALESCE(SUM(payment.amount), 0) AS CHAR(40)) AS amount
      FROM finance_payments AS payment INNER JOIN students AS student ON student.id = payment.student_id
      WHERE student.student_no LIKE 'DEMO-HOSTINGER-%'`,
    paymentAllocations: `SELECT COUNT(*) AS rows_count, CAST(COALESCE(SUM(allocation.amount), 0) AS CHAR(40)) AS amount
      FROM finance_payment_allocations AS allocation
      LEFT JOIN finance_payments AS payment ON payment.id = allocation.payment_id
      LEFT JOIN finance_legacy_opening_charges AS opening ON opening.id = allocation.legacy_opening_charge_id
      INNER JOIN students AS student ON student.id = COALESCE(payment.student_id, opening.student_id)
      WHERE student.student_no LIKE 'DEMO-HOSTINGER-%'`,
    allocationReleases: `SELECT COUNT(*) AS rows_count, CAST(COALESCE(SUM(release_row.amount), 0) AS CHAR(40)) AS amount
      FROM finance_payment_allocation_releases AS release_row
      INNER JOIN finance_payment_allocations AS allocation ON allocation.id = release_row.allocation_id
      LEFT JOIN finance_payments AS payment ON payment.id = allocation.payment_id
      LEFT JOIN finance_legacy_opening_charges AS opening ON opening.id = allocation.legacy_opening_charge_id
      INNER JOIN students AS student ON student.id = COALESCE(payment.student_id, opening.student_id)
      WHERE student.student_no LIKE 'DEMO-HOSTINGER-%'`,
    paymentReversals: `SELECT COUNT(*) AS rows_count FROM finance_payment_reversals AS reversal
      INNER JOIN finance_payments AS payment ON payment.id = reversal.payment_id
      INNER JOIN students AS student ON student.id = payment.student_id WHERE student.student_no LIKE 'DEMO-HOSTINGER-%'`,
    financeClearanceEvents: `SELECT COUNT(*) AS rows_count
      FROM student_document_clearance_events AS event
      INNER JOIN student_document_requests AS request ON request.id = event.request_id
      INNER JOIN students AS student ON student.id = request.student_id
      WHERE student.student_no LIKE 'DEMO-HOSTINGER-%'`
  };
  const snapshot = {};
  for (const [key, statement] of Object.entries(queries)) {
    const [row] = await queryRows(connection, statement);
    snapshot[key] = Object.fromEntries(Object.entries(row || {}).map(([field, value]) => [field, String(value ?? '0')]));
  }
  return snapshot;
}

async function findCleanupAudit(connection, lockRows) {
  const suffix = lockRows ? ' FOR UPDATE' : '';
  return queryRows(connection,
    `SELECT action, entity_type, entity_id, user_id, details_json FROM audit_logs
      WHERE action = ? AND entity_type = ? AND entity_id = ? ORDER BY id${suffix}`,
    [CLEANUP_ACTION, 'school_demo_finance_cleanup', CLEANUP_MARKER]);
}

function assertTargetRows(target) {
  const balanceCents = cents(target.account.balance);
  if (target.transactions.length !== EXPECTED_TRANSACTION_COUNT
    || target.transactions.some((row) => Number(row.is_legacy_unattributed) !== 1 || row.transaction_type !== 'charge')
    || target.transactions.reduce((sum, row) => sum + cents(row.amount), 0n) !== EXPECTED_BALANCE_CENTS
    || balanceCents !== EXPECTED_BALANCE_CENTS) {
    throw new LegacyFinanceCleanupError('The reserved demo legacy account differs from the reviewed two-charge, 5,500.00 cleanup scope.');
  }
}

async function inspect(connection, lockRows) {
  await requireCurrentSchema(connection);
  const markers = await requireSourceMarkers(connection, lockRows);
  const target = await findTarget(connection, lockRows);
  const outside = await readOutsideCohortInventory(connection);
  const auditRows = await findCleanupAudit(connection, lockRows);
  if (auditRows.length > 1) throw new LegacyFinanceCleanupError('The cleanup audit marker is duplicated.');
  const snapshot = await readModernSnapshot(connection);
  if (auditRows.length === 1) {
    let details;
    try { details = JSON.parse(auditRows[0].details_json); } catch { throw new LegacyFinanceCleanupError('The previous cleanup audit record is invalid.'); }
    const revisionBefore = /^\d+$/.test(String(details?.studentDebtRevisionBefore)) ? BigInt(details.studentDebtRevisionBefore) : null;
    const revisionAfter = /^\d+$/.test(String(details?.studentDebtRevisionAfter)) ? BigInt(details.studentDebtRevisionAfter) : null;
    if (target.transactions.length !== 0 || cents(target.account.balance) !== 0n
      || Number(details?.removedTransactions) !== EXPECTED_TRANSACTION_COUNT
      || details?.removedAmount !== money(EXPECTED_BALANCE_CENTS)
      || revisionBefore === null || revisionAfter !== revisionBefore + 1n
      || BigInt(target.studentDebtRevision) < revisionAfter) {
      throw new LegacyFinanceCleanupError('The cleanup audit exists but the reviewed legacy scope is not in its completed state.');
    }
    return { markers, target, outside, dependencies: null, snapshot, alreadyApplied: true,
      audit: auditRows[0], auditDetails: details };
  }
  if (outside.flaggedLegacyTransactions !== 0 || outside.nonzeroFinancialAccounts !== 0) {
    throw new LegacyFinanceCleanupError('Legacy finance records exist outside the reserved demo cohort; no account was changed.');
  }
  assertTargetRows(target);
  const transactionIds = target.transactions.map(({ id }) => Number(id));
  const dependencies = await readDependencies(connection, Number(target.account.id), transactionIds);
  if (Object.values(dependencies).some((count) => count !== 0)) {
    throw new LegacyFinanceCleanupError('A legacy finance row is referenced by an opening balance, reconciliation, reversal, or clearance; no account was changed.');
  }
  return { markers, target, outside, dependencies, snapshot, alreadyApplied: false };
}

function report(mode, details, status, backup) {
  const revisionBefore = details.alreadyApplied
    ? String(details.auditDetails.studentDebtRevisionBefore)
    : details.target.studentDebtRevision;
  const revisionAfter = details.alreadyApplied
    ? String(details.auditDetails.studentDebtRevisionAfter)
    : (BigInt(revisionBefore) + 1n).toString();
  return {
    mode, status,
    sourceMarkersVerified: true,
    cohortStudents: details.target.studentCount,
    legacyAccountRows: 1,
    legacyTransactionsBefore: details.alreadyApplied ? 0 : EXPECTED_TRANSACTION_COUNT,
    legacyChargeAmountBefore: details.alreadyApplied ? '0.00' : money(EXPECTED_BALANCE_CENTS),
    accountBalanceBefore: details.alreadyApplied ? '0.00' : money(EXPECTED_BALANCE_CENTS),
    accountBalanceAfter: details.alreadyApplied ? '0.00' : '0.00',
    dependencies: details.dependencies,
    outsideCohortLegacyInventory: details.outside,
    studentDebtRevisionBefore: revisionBefore,
    studentDebtRevisionAfter: revisionAfter,
    modernFinanceRowsBefore: details.snapshot,
    modernFinanceRowsAfter: details.snapshot,
    audit: details.alreadyApplied ? 'existing cleanup audit verified' : CLEANUP_ACTION,
    ...(backup ? { backupSha256: backup.sha256, backupSizeBytes: backup.sizeBytes } : {})
  };
}

async function runCleanup({ options, configuration = environment, getConnection, closeConnectionPool = async () => {}, logger = console }) {
  validateProductionTarget(configuration);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || !['dry-run', 'apply'].includes(options.mode)
    || options.targetDatabase !== configuration.database.database || options.confirmDatabase !== configuration.database.database
    || options.seedMarker !== HOSTINGER_SEED_MARKER || options.expansionMarker !== EXPANSION_MARKER
    || (options.mode === 'apply' && (options.acknowledged !== true
      || typeof options.backupFile !== 'string' || !path.isAbsolute(options.backupFile)
      || typeof options.backupSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(options.backupSha256)))
    || (options.mode === 'dry-run' && (options.acknowledged !== false || options.backupFile !== null || options.backupSha256 !== null))) {
    throw new LegacyFinanceCleanupError('Confirm the production demo database before continuing.');
  }
  const backup = options.mode === 'apply' ? await validateBackup(options) : null;
  const connection = await getConnection();
  let acquiredLock = false;
  let transactionStarted = false;
  try {
    if (options.mode === 'apply') {
      const [lock] = await queryRows(connection, 'SELECT GET_LOCK(?, 15) AS acquired', [APPLICATION_LOCK]);
      if (Number(lock?.acquired) !== 1) throw new LegacyFinanceCleanupError('Could not acquire the reserved demo finance cleanup lock.', 409);
      acquiredLock = true;
      await connection.beginTransaction();
      transactionStarted = true;
    }
    const inspected = await inspect(connection, options.mode === 'apply');
    if (inspected.alreadyApplied) {
      const result = report(options.mode, inspected, 'already-applied', backup);
      if (transactionStarted) { await connection.commit(); transactionStarted = false; }
      logger.log(JSON.stringify(result, null, 2));
      return result;
    }
    const before = inspected.snapshot;
    if (options.mode === 'dry-run') {
      const result = report('dry-run', inspected, 'preview', null);
      logger.log(JSON.stringify(result, null, 2));
      return result;
    }

    const actorId = inspected.markers.actorId;
    const accountId = Number(inspected.target.account.id);
    const studentId = Number(inspected.target.account.student_id);
    const revisionBefore = BigInt(inspected.target.studentDebtRevision);
    const maxUnsignedBigint = 18446744073709551615n;
    if (revisionBefore >= maxUnsignedBigint) throw new LegacyFinanceCleanupError('The student finance revision cannot be safely advanced.');
    const transactionIds = inspected.target.transactions.map(({ id }) => Number(id));
    const updateResult = await connection.execute(
      `UPDATE financial_accounts SET balance = 0.00
        WHERE id = ? AND student_id = ? AND balance = ?`,
      [accountId, studentId, money(EXPECTED_BALANCE_CENTS)]);
    if (Number(updateResult[0]?.affectedRows) !== 1) throw new LegacyFinanceCleanupError('The locked legacy account balance changed; cleanup was rolled back.', 409);
    const deleteResult = await connection.execute(
      `DELETE FROM financial_transactions WHERE financial_account_id = ? AND is_legacy_unattributed = 1
        AND transaction_type = 'charge' AND id IN (${transactionIds.map(() => '?').join(',')})`,
      [accountId, ...transactionIds]);
    if (Number(deleteResult[0]?.affectedRows) !== EXPECTED_TRANSACTION_COUNT) throw new LegacyFinanceCleanupError('The exact reviewed legacy charge rows changed; cleanup was rolled back.', 409);

    const revisionResult = await connection.execute(
      `UPDATE students SET debt_increase_revision = debt_increase_revision + 1
        WHERE id = ? AND debt_increase_revision = ?`,
      [studentId, revisionBefore.toString()]);
    if (Number(revisionResult[0]?.affectedRows) !== 1) throw new LegacyFinanceCleanupError('The student finance revision changed; cleanup was rolled back.', 409);

    const afterTarget = await findTarget(connection, true);
    if (afterTarget.transactions.length !== 0 || cents(afterTarget.account.balance) !== 0n) {
      throw new LegacyFinanceCleanupError('The legacy account did not reach the expected cleared state; cleanup was rolled back.');
    }
    const after = await readModernSnapshot(connection);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new LegacyFinanceCleanupError('Modern annual finance records changed during cleanup; all writes were rolled back.');
    await connection.execute(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (?, ?, ?, ?, ?)`,
      [actorId, CLEANUP_ACTION, 'school_demo_finance_cleanup', CLEANUP_MARKER, JSON.stringify({
        cohortStudents: EXPECTED_STUDENT_COUNT,
        removedTransactions: EXPECTED_TRANSACTION_COUNT,
        removedAmount: money(EXPECTED_BALANCE_CENTS),
        accountBalanceBefore: money(EXPECTED_BALANCE_CENTS),
        accountBalanceAfter: '0.00',
        studentDebtRevisionBefore: revisionBefore.toString(),
        studentDebtRevisionAfter: (revisionBefore + 1n).toString(),
        sourceSeedMarker: HOSTINGER_SEED_MARKER,
        sourceExpansionMarker: EXPANSION_MARKER,
        modernFinanceRowsBefore: before,
        modernFinanceRowsAfter: after
      })]);
    const result = report('apply', { ...inspected, snapshot: before }, 'completed', backup);
    result.modernFinanceRowsAfter = after;
    await connection.commit();
    transactionStarted = false;
    logger.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    transactionStarted = false;
    if (error instanceof LegacyFinanceCleanupError) throw error;
    throw new LegacyFinanceCleanupError('The demo legacy-finance cleanup failed and any transaction was rolled back. Verify the confirmed target and MariaDB state.');
  } finally {
    if (acquiredLock) await queryRows(connection, 'SELECT RELEASE_LOCK(?) AS released', [APPLICATION_LOCK]).catch(() => {});
    connection.release();
    await closeConnectionPool().catch(() => {});
  }
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    validateProductionTarget();
    let pool;
    await runCleanup({
      options,
      getConnection: async () => {
        pool = await getPool();
        return pool.source.getConnection();
      },
      closeConnectionPool: async () => { if (pool) await closePool(); }
    });
  } catch (error) {
    console.error(error instanceof LegacyFinanceCleanupError
      ? error.message
      : 'The Hostinger demo legacy-finance cleanup failed. No private database values were printed.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  CLEANUP_MARKER, CLEANUP_ACTION, HOSTINGER_SEED_MARKER, EXPANSION_MARKER,
  EXPECTED_STUDENT_COUNT, EXPECTED_TRANSACTION_COUNT, EXPECTED_BALANCE_CENTS,
  LegacyFinanceCleanupError, parseOptions, validateProductionTarget, validateBackup,
  money, cents, readDependencies, readModernSnapshot, runCleanup
};
