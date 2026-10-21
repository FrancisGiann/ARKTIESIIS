'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const mysql = require('mysql2/promise');
const core = require('./hostinger-demo-finance-restatement');
const manifest = require('./finance-restatement-manifest');

const HOSTINGER_HOST = 'srv2102.hstgr.io';
const HOSTINGER_PORT = 3306;
const HOSTINGER_SCHEMA = 'u364362094_arkteisiis';
const HOSTINGER_USER = 'u364362094_ark';
const PREPARE_RECEIPT_VERSION = 1;
const PREPARE_TTL_MS = 10 * 60 * 1000;
const WRITE_CONFIRMATIONS = Object.freeze({
  apply: 'APPLY_FIXED_79_TUITION_RESTATEMENT',
  reverse: 'REVERSE_FIXED_79_TUITION_RESTATEMENT'
});
const APP_ROOT = path.resolve(__dirname, '..');
const INPUT_DIGEST_KEYS = Object.freeze([
  'manifestFileSha256',
  'preflightSqlFileSha256',
  'wrapperFileSha256',
  'coreFileSha256',
  'manifestHelperFileSha256',
  'migration024FileSha256'
]);

class LiveMaintenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveMaintenanceError';
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digestFile(filePath, description) {
  try { return sha256(fs.readFileSync(filePath)); }
  catch { throw new LiveMaintenanceError(`The approved ${description} file could not be fingerprinted.`); }
}

function currentInputDigests(inputs) {
  return {
    manifestFileSha256: sha256(inputs.manifestText),
    preflightSqlFileSha256: sha256(inputs.sqlText),
    wrapperFileSha256: digestFile(__filename, 'maintenance wrapper'),
    coreFileSha256: digestFile(require.resolve('./hostinger-demo-finance-restatement'), 'maintenance core'),
    manifestHelperFileSha256: digestFile(require.resolve('./finance-restatement-manifest'), 'manifest helper'),
    migration024FileSha256: digestFile(path.join(APP_ROOT, 'database/mariadb/migrations/024_finance_assessment_restatement.sql'), 'v2.024 migration')
  };
}

function hasValidInputDigests(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === INPUT_DIGEST_KEYS.length
    && INPUT_DIGEST_KEYS.every((key) => /^[a-f0-9]{64}$/.test(value[key] || '')));
}

function assertLiveConfiguration(databaseConfig) {
  if (databaseConfig?.host !== HOSTINGER_HOST
    || Number(databaseConfig?.port) !== HOSTINGER_PORT
    || databaseConfig?.database !== HOSTINGER_SCHEMA
    || databaseConfig?.user !== HOSTINGER_USER
    || !databaseConfig?.password
    || Boolean(databaseConfig?.socketPath)) {
    throw new LiveMaintenanceError('The supplied maintenance profile does not match the approved Hostinger endpoint, schema, and database user.');
  }
}

function parseArguments(argv, databaseConfig) {
  const allowed = new Set([
    'mode', 'direction', 'expected-db', 'preflight-sql', 'manifest', 'manifest-sha256',
    'operation-id', 'idempotency-key', 'actor-id', 'reason', 'prepare-receipt',
    'prepare-receipt-sha256', 'confirm-write'
  ]);
  const args = {};
  for (const token of argv) {
    const match = /^--([a-z0-9-]+)=(.*)$/.exec(token);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(args, match[1])) {
      throw new LiveMaintenanceError('Use the documented Hostinger finance maintenance options; no database operation was started.');
    }
    args[match[1]] = match[2];
  }
  assertLiveConfiguration(databaseConfig);
  if (!['prepare', 'execute'].includes(args.mode)) throw new LiveMaintenanceError('Choose prepare or execute mode.');
  if (!['apply', 'reverse'].includes(args.direction)) throw new LiveMaintenanceError('Choose apply or reverse direction.');
  if (args['expected-db'] !== HOSTINGER_SCHEMA || databaseConfig.database !== HOSTINGER_SCHEMA) {
    throw new LiveMaintenanceError('The explicit target and configured database must both match the approved Hostinger schema.');
  }
  if (args['manifest-sha256'] !== core.APPROVED_MANIFEST_SHA256) throw new LiveMaintenanceError('The approved fixed-cohort manifest digest does not match.');
  for (const key of ['preflight-sql', 'manifest', 'prepare-receipt']) {
    if (!args[key]) throw new LiveMaintenanceError(`The ${key} file is required.`);
  }
  if (typeof args['operation-id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args['operation-id'])) {
    throw new LiveMaintenanceError('A valid operation UUID is required.');
  }
  if (typeof args['idempotency-key'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args['idempotency-key'])) {
    throw new LiveMaintenanceError('A valid idempotency UUID is required.');
  }
  if (!/^[1-9]\d{0,9}$/.test(args['actor-id'] || '')) throw new LiveMaintenanceError('An existing authorized staff actor ID is required.');
  args['actor-id'] = Number(args['actor-id']);
  args.reason = core.validateReason(args.reason);

  if (args.mode === 'prepare') {
    if (args['prepare-receipt-sha256'] || args['confirm-write']) {
      throw new LiveMaintenanceError('Prepare mode does not accept execution confirmation fields.');
    }
    args['prepare-receipt'] = resolvePrivateReceiptPath(args['prepare-receipt']);
  } else {
    if (!/^[a-f0-9]{64}$/.test(args['prepare-receipt-sha256'] || '')) throw new LiveMaintenanceError('The prepare receipt SHA-256 is required for execution.');
    if (args['confirm-write'] !== WRITE_CONFIRMATIONS[args.direction]) throw new LiveMaintenanceError('The explicit write-mode confirmation does not match the selected direction.');
    args['prepare-receipt'] = resolvePrivateReceiptPath(args['prepare-receipt']);
  }
  return args;
}

function isPathWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolvePrivateReceiptPath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new LiveMaintenanceError('The prepare receipt path must be an absolute private path outside the application checkout.');
  }
  let parent;
  try { parent = fs.realpathSync(path.dirname(filePath)); } catch {
    throw new LiveMaintenanceError('The prepare receipt parent directory must already exist.');
  }
  const parentStat = fs.statSync(parent);
  if (!parentStat.isDirectory() || (parentStat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && parentStat.uid !== process.getuid())) {
    throw new LiveMaintenanceError('The prepare receipt directory must be owned by the operator and private to that account.');
  }
  const resolved = path.join(parent, path.basename(filePath));
  const publicDirectory = path.join(APP_ROOT, 'public');
  if (isPathWithin(APP_ROOT, resolved) || isPathWithin(publicDirectory, resolved)
    || resolved.split(path.sep).includes('public_html')) {
    throw new LiveMaintenanceError('The prepare receipt must stay outside the application checkout and public web paths.');
  }
  return resolved;
}

function buildRemoteConnectionOptions(databaseConfig, netConnect = net.connect) {
  assertLiveConfiguration(databaseConfig);
  return {
    host: HOSTINGER_HOST,
    port: HOSTINGER_PORT,
    user: HOSTINGER_USER,
    password: databaseConfig.password,
    database: HOSTINGER_SCHEMA,
    connectTimeout: 8000,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'],
    ssl: { rejectUnauthorized: true, verifyIdentity: true },
    stream: () => {
      const socket = netConnect({ host: HOSTINGER_HOST, port: HOSTINGER_PORT, family: 4 });
      if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
      if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true, 30000);
      return socket;
    }
  };
}

function assertVerifiedTransport(connection) {
  const driver = connection?.connection;
  const tlsSocket = driver?.stream;
  if (driver?.config?.host !== HOSTINGER_HOST || driver?.config?.port !== HOSTINGER_PORT
    || driver?.config?.ssl?.rejectUnauthorized !== true || driver?.config?.ssl?.verifyIdentity !== true
    || tlsSocket?.remoteFamily !== 'IPv4' || tlsSocket?.authorized !== true) {
    throw new LiveMaintenanceError('The Hostinger connection did not establish verified IPv4 TLS for the approved hostname.');
  }
}

async function inspectRemoteIdentity(connection) {
  const [rows] = await connection.query(`SELECT DATABASE() AS selected_database, @@port AS server_port,
      CURRENT_USER() AS authenticated_account, VERSION() AS server_version`);
  const row = rows[0] || {};
  const account = core.parseMysqlAccountIdentity(row.authenticated_account);
  const serverVersion = String(row.server_version || '').trim();
  if (row.selected_database !== HOSTINGER_SCHEMA || Number(row.server_port) !== HOSTINGER_PORT
    || account?.user !== HOSTINGER_USER || !serverVersion) {
    throw new LiveMaintenanceError('The remote database identity did not match the approved Hostinger database, port, and user.');
  }
  await core.assertSelectedSchema(connection, HOSTINGER_SCHEMA);
  return {
    host: HOSTINGER_HOST,
    port: Number(row.server_port),
    schema: row.selected_database,
    databaseUser: account.user,
    peerFamily: connection.connection.stream.remoteFamily,
    verifiedTlsIdentity: true,
    serverVersion
  };
}

async function hasDirectTriggerPrivilege(connection) {
  const [[identity]] = await connection.query('SELECT CURRENT_USER() AS authenticated_account');
  const [rows] = await connection.execute(`SELECT TABLE_SCHEMA AS table_schema, GRANTEE AS grantee, PRIVILEGE_TYPE AS privilege_type
    FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = ? AND PRIVILEGE_TYPE = ?`, [HOSTINGER_SCHEMA, 'TRIGGER']);
  return core.hasDirectSchemaPrivilege(rows, identity?.authenticated_account, HOSTINGER_SCHEMA, 'TRIGGER');
}

async function inspectActor(connection, actorId) {
  const [rows] = await connection.execute('SELECT id, role, is_active FROM users WHERE id = ? LIMIT 1', [actorId]);
  const actor = rows[0];
  const role = actor?.role || null;
  const active = Number(actor?.is_active) === 1;
  return { exists: Boolean(actor), actorId, role, active, authorized: active && ['finance', 'database_admin'].includes(role) };
}

async function inspectOperationReadiness(connection, args, validated) {
  const observed = await core.inspectOperationState(connection, args['operation-id'], validated);
  let state = observed.state;
  let ready = false;
  if (args.direction === 'apply') {
    if (observed.state === 'unused-operation-id') ready = true;
    else if (observed.state === 'applied-current') {
      ready = observed.appliedIdempotencyKey === args['idempotency-key'];
      if (!ready) state = 'applied-operation-idempotency-key-mismatch';
    }
  } else if (observed.state === 'applied-current') {
    ready = true;
    state = 'applied-operation-awaiting-reversal';
  } else if (observed.state === 'reversed-current') {
    ready = observed.reversedIdempotencyKey === args['idempotency-key'];
    if (!ready) state = 'reversed-operation-idempotency-key-mismatch';
  }
  return {
    ready,
    state,
    requiresFreshManifest: args.direction === 'apply' && observed.state === 'unused-operation-id',
    idempotencyKeyMatches: ready
      && ((args.direction === 'apply' && observed.state === 'applied-current')
        || (args.direction === 'reverse' && observed.state === 'reversed-current')),
    currentStateSha256: observed.currentStateSha256 || null,
    recordedStateSha256: observed.recordedStateSha256 || null
  };
}

function createPrepareReceipt({ args, identity, inputDigests, readiness, actor, directTriggerPrivilege, operationState, freshManifest, now = Date.now() }) {
  const pendingReasons = [];
  if (!readiness.migrationsReady) pendingReasons.push('required-migrations-not-ready');
  if (!readiness.triggerSetReady) pendingReasons.push('immutable-trigger-set-not-ready');
  if (!directTriggerPrivilege) pendingReasons.push('direct-schema-trigger-privilege-missing');
  if (!actor.authorized) pendingReasons.push('actor-not-an-active-authorized-staff-account');
  if (!operationState.ready) pendingReasons.push(operationState.state);
  if (operationState.requiresFreshManifest && !freshManifest?.matchesPinned) pendingReasons.push('fresh-manifest-does-not-match-frozen-cohort');
  const preparedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PREPARE_TTL_MS).toISOString();
  return {
    formatVersion: PREPARE_RECEIPT_VERSION,
    preparedAt,
    expiresAt,
    status: pendingReasons.length ? 'pending' : 'ready',
    canExecute: pendingReasons.length === 0,
    target: { host: HOSTINGER_HOST, port: HOSTINGER_PORT, schema: HOSTINGER_SCHEMA, databaseUser: HOSTINGER_USER },
    operation: args.direction,
    operationId: args['operation-id'],
    idempotencyKeySha256: sha256(args['idempotency-key']),
    actorId: args['actor-id'],
    actorRole: actor.role,
    reasonSha256: sha256(args.reason),
    manifestSha256: core.APPROVED_MANIFEST_SHA256,
    preflightSqlSha256: core.APPROVED_PREFLIGHT_SQL_SHA256,
    inputDigests,
    identity,
    readiness: {
      installedMigrations: readiness.installedMigrations,
      migrationsReady: readiness.migrationsReady,
      triggerCount: readiness.triggerCount,
      triggerSetReady: readiness.triggerSetReady,
      directTriggerPrivilege,
      actorAuthorized: actor.authorized,
      operationState: {
        state: operationState.state,
        idempotencyKeyMatches: operationState.idempotencyKeyMatches,
        currentStateSha256: operationState.currentStateSha256,
        recordedStateSha256: operationState.recordedStateSha256
      },
      freshManifest
    },
    pendingReasons,
    readOnlyTransactionRolledBack: true
  };
}

function writePrepareReceipt(filePath, receipt) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`); }
  finally { fs.closeSync(descriptor); }
  fs.chmodSync(filePath, 0o600);
  return sha256(fs.readFileSync(filePath));
}

function readyOperationReceipt(operationState, args) {
  if (!operationState || typeof operationState.state !== 'string') return false;
  const currentDigestMatches = /^[a-f0-9]{64}$/.test(operationState.currentStateSha256 || '')
    && operationState.currentStateSha256 === operationState.recordedStateSha256;
  if (args.direction === 'apply') {
    return operationState.state === 'unused-operation-id'
      || (operationState.state === 'applied-current' && operationState.idempotencyKeyMatches === true && currentDigestMatches);
  }
  return (operationState.state === 'applied-operation-awaiting-reversal' && currentDigestMatches)
    || (operationState.state === 'reversed-current' && operationState.idempotencyKeyMatches === true && currentDigestMatches);
}

function verifyPrepareReceipt(receipt, args, inputDigests, receiptDigest, now = Date.now()) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.formatVersion !== PREPARE_RECEIPT_VERSION || receipt.status !== 'ready' || receipt.canExecute !== true) {
    throw new LiveMaintenanceError('The prepare receipt is not ready for execution.');
  }
  const expiresAt = Date.parse(receipt.expiresAt);
  const preparedAt = Date.parse(receipt.preparedAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(preparedAt) || now > expiresAt || preparedAt > now
    || expiresAt <= preparedAt || expiresAt - preparedAt > PREPARE_TTL_MS) {
    throw new LiveMaintenanceError('The prepare receipt is expired or has an invalid timestamp. Run prepare again.');
  }
  if (!/^[a-f0-9]{64}$/.test(receiptDigest || '')
    || receipt.target?.host !== HOSTINGER_HOST || Number(receipt.target?.port) !== HOSTINGER_PORT
    || receipt.target?.schema !== HOSTINGER_SCHEMA || receipt.target?.databaseUser !== HOSTINGER_USER
    || receipt.operation !== args.direction || receipt.operationId !== args['operation-id']
    || receipt.idempotencyKeySha256 !== sha256(args['idempotency-key'])
    || Number(receipt.actorId) !== args['actor-id'] || receipt.reasonSha256 !== sha256(args.reason)
    || !['finance', 'database_admin'].includes(receipt.actorRole)
    || receipt.identity?.host !== HOSTINGER_HOST || Number(receipt.identity?.port) !== HOSTINGER_PORT
    || receipt.identity?.schema !== HOSTINGER_SCHEMA || receipt.identity?.databaseUser !== HOSTINGER_USER
    || receipt.identity?.peerFamily !== 'IPv4' || receipt.identity?.verifiedTlsIdentity !== true
    || typeof receipt.identity?.serverVersion !== 'string' || !receipt.identity.serverVersion
    || receipt.manifestSha256 !== core.APPROVED_MANIFEST_SHA256
    || receipt.preflightSqlSha256 !== core.APPROVED_PREFLIGHT_SQL_SHA256
    || receipt.readOnlyTransactionRolledBack !== true
    || receipt.readiness?.migrationsReady !== true || receipt.readiness?.triggerSetReady !== true
    || receipt.readiness?.directTriggerPrivilege !== true || receipt.readiness?.actorAuthorized !== true
    || !readyOperationReceipt(receipt.readiness?.operationState, args)
    || (args.direction === 'apply' && receipt.readiness?.operationState?.state === 'unused-operation-id'
      && receipt.readiness?.freshManifest?.matchesPinned !== true)
    || !hasValidInputDigests(receipt.inputDigests) || !hasValidInputDigests(inputDigests)
    || manifest.sortedJson(receipt.inputDigests) !== manifest.sortedJson(inputDigests)) {
    throw new LiveMaintenanceError('The prepare receipt does not match the requested operation, inputs, actor, reason, or target.');
  }
}

async function runReadOnlyPrepare(args, inputs, dependencies) {
  const config = dependencies.databaseConfig;
  if (!config) throw new LiveMaintenanceError('An explicit protected maintenance profile is required.');
  const inputDigests = dependencies.inputDigests || currentInputDigests(inputs);
  const createConnection = dependencies.createConnection || mysql.createConnection;
  const netConnect = dependencies.netConnect || net.connect;
  const connection = await createConnection(buildRemoteConnectionOptions(config, netConnect));
  try {
    assertVerifiedTransport(connection);
    const identity = await inspectRemoteIdentity(connection);
    await connection.query('SET SESSION max_statement_time = 5');
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('SET TRANSACTION READ ONLY');
    await connection.beginTransaction();
    let receipt;
    try {
      const readiness = await core.inspectMigrationPrerequisites(connection, HOSTINGER_SCHEMA);
      const directTriggerPrivilege = await hasDirectTriggerPrivilege(connection);
      const actor = await inspectActor(connection, args['actor-id']);
      const operationState = readiness.migrationsReady && readiness.triggerSetReady
        ? await inspectOperationReadiness(connection, args, inputs.validated)
        : { ready: false, state: 'operation-state-not-checked-schema-not-ready', requiresFreshManifest: false };
      let freshManifest = { status: 'not-required-for-existing-operation-state' };
      if (operationState.requiresFreshManifest) {
        const rows = await core.queryFreshManifest(connection, inputs.sqlText);
        const digest = manifest.sha256(manifest.canonicalManifestRows(rows));
        let rowsValid = false;
        try {
          manifest.validateManifestRows(rows, core.APPROVED_MANIFEST_SHA256);
          rowsValid = true;
        } catch { rowsValid = false; }
        freshManifest = { rowCount: rows.length, digest, matchesPinned: rowsValid && digest === core.APPROVED_MANIFEST_SHA256 };
      }
      receipt = createPrepareReceipt({
        args,
        identity,
        inputDigests,
        readiness,
        actor,
        directTriggerPrivilege,
        operationState,
        freshManifest
      });
    } finally {
      await connection.rollback();
    }
    const digest = writePrepareReceipt(args['prepare-receipt'], receipt);
    return { status: receipt.status, canExecute: receipt.canExecute, pendingReasons: receipt.pendingReasons,
      receipt: args['prepare-receipt'], receiptSha256: digest, identity: receipt.identity,
      readiness: receipt.readiness };
  } finally {
    await connection.end();
  }
}

function readPrepareReceipt(filePath) {
  let stat;
  let bytes;
  try {
    const resolved = resolvePrivateReceiptPath(filePath);
    stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      throw new LiveMaintenanceError('The prepare receipt must be a regular 0600 file.');
    }
    bytes = fs.readFileSync(resolved);
    const receipt = JSON.parse(bytes.toString('utf8'));
    return { receipt, digest: sha256(bytes) };
  } catch (error) {
    if (error instanceof LiveMaintenanceError) throw error;
    throw new LiveMaintenanceError('The private prepare receipt could not be read or parsed.');
  }
}

async function runExplicitExecution(args, inputs, dependencies) {
  const config = dependencies.databaseConfig;
  if (!config) throw new LiveMaintenanceError('An explicit protected maintenance profile is required.');
  const { receipt, digest } = readPrepareReceipt(args['prepare-receipt']);
  const inputDigests = dependencies.inputDigests || currentInputDigests(inputs);
  verifyPrepareReceipt(receipt, args, inputDigests, digest);
  if (digest !== args['prepare-receipt-sha256']) throw new LiveMaintenanceError('The prepare receipt digest does not match the explicitly reviewed receipt.');
  const createConnection = dependencies.createConnection || mysql.createConnection;
  const netConnect = dependencies.netConnect || net.connect;
  const connection = await createConnection(buildRemoteConnectionOptions(config, netConnect));
  try {
    assertVerifiedTransport(connection);
    const identity = await inspectRemoteIdentity(connection);
    if (manifest.sortedJson(identity) !== manifest.sortedJson(receipt.identity)) {
      throw new LiveMaintenanceError('The remote identity changed after prepare; no write was started.');
    }
    const coreArgs = {
      mode: args.direction,
      'operation-id': args['operation-id'],
      'idempotency-key': args['idempotency-key'],
      'actor-id': args['actor-id'],
      reason: args.reason
    };
    const result = await core.executePreparedOperation(connection, coreArgs, inputs, HOSTINGER_SCHEMA);
    return { status: 'completed', direction: args.direction, identity, result };
  } finally {
    await connection.end();
  }
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
  const databaseConfig = dependencies.databaseConfig;
  if (!databaseConfig) throw new LiveMaintenanceError('An explicit protected maintenance profile is required.');
  const args = parseArguments(argv, databaseConfig);
  const inputs = core.loadApprovedInputs(args);
  const inputDigests = currentInputDigests(inputs);
  if (args.mode === 'prepare') return runReadOnlyPrepare(args, inputs, { ...dependencies, databaseConfig, inputDigests });
  return runExplicitExecution(args, inputs, { ...dependencies, databaseConfig, inputDigests });
}

function publicFailure(error) {
  if (error instanceof LiveMaintenanceError || error instanceof core.MaintenanceError
    || error instanceof manifest.RestatementManifestError) return error.message;
  const code = /^[A-Z0-9_]{2,64}$/.test(String(error?.code || '')) ? error.code : 'UNEXPECTED_ERROR';
  return `Remote finance maintenance stopped (${code}); no automatic retry was attempted.`;
}

if (require.main === module) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'failed', message: publicFailure(error) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  HOSTINGER_HOST,
  HOSTINGER_PORT,
  HOSTINGER_SCHEMA,
  HOSTINGER_USER,
  PREPARE_TTL_MS,
  LiveMaintenanceError,
  assertLiveConfiguration,
  assertVerifiedTransport,
  buildRemoteConnectionOptions,
  createPrepareReceipt,
  currentInputDigests,
  hasValidInputDigests,
  hasDirectTriggerPrivilege,
  inspectOperationReadiness,
  parseArguments,
  publicFailure,
  readPrepareReceipt,
  readyOperationReceipt,
  writePrepareReceipt,
  resolvePrivateReceiptPath,
  run,
  verifyPrepareReceipt
};
