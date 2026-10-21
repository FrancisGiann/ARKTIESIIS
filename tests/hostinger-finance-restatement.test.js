'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../scripts/hostinger-demo-finance-restatement');
const live = require('../scripts/hostinger-finance-restatement');

const databaseConfig = Object.freeze({
  host: live.HOSTINGER_HOST,
  port: live.HOSTINGER_PORT,
  database: live.HOSTINGER_SCHEMA,
  user: live.HOSTINGER_USER,
  password: 'test-only-placeholder',
  socketPath: ''
});

function operationArgs(direction, overrides = {}) {
  return {
    mode: 'prepare',
    direction,
    'operation-id': 'b35ff673-1a38-4d05-9494-0f447fa71a1a',
    'idempotency-key': '01b8e13b-fce9-4cd2-8f01-23c956b6c7c3',
    'actor-id': 41,
    reason: 'Approved bounded correction',
    ...overrides
  };
}

function validReceiptReadiness(operationState, freshManifest = { matchesPinned: true }) {
  return {
    installedMigrations: ['v2.023', 'v2.024'],
    migrationsReady: true,
    triggerCount: 6,
    triggerSetReady: true,
    directTriggerPrivilege: true,
    actorAuthorized: true,
    operationState,
    freshManifest
  };
}

function testInputs() {
  return { manifestText: '{"fixture":"approved-shape"}', sqlText: 'SELECT fixture;', validated: { digest: core.APPROVED_MANIFEST_SHA256 } };
}

function testInputDigests() {
  return {
    manifestFileSha256: 'd'.repeat(64),
    preflightSqlFileSha256: 'e'.repeat(64),
    wrapperFileSha256: 'f'.repeat(64),
    coreFileSha256: '1'.repeat(64),
    manifestHelperFileSha256: '2'.repeat(64),
    migration024FileSha256: '3'.repeat(64)
  };
}

function readyOperationState(direction = 'reverse') {
  return direction === 'reverse'
    ? { ready: true, state: 'applied-operation-awaiting-reversal', requiresFreshManifest: false,
      currentStateSha256: 'a'.repeat(64), recordedStateSha256: 'a'.repeat(64) }
    : { ready: true, state: 'applied-current', requiresFreshManifest: false, idempotencyKeyMatches: true,
      currentStateSha256: 'a'.repeat(64), recordedStateSha256: 'a'.repeat(64) };
}

function readyPrepareReceipt(args, inputDigests, now = Date.now()) {
  return live.createPrepareReceipt({
    args,
    identity: { host: live.HOSTINGER_HOST, port: live.HOSTINGER_PORT, schema: live.HOSTINGER_SCHEMA,
      databaseUser: live.HOSTINGER_USER, peerFamily: 'IPv4', verifiedTlsIdentity: true, serverVersion: 'MariaDB test' },
    inputDigests,
    readiness: { migrationsReady: true, installedMigrations: ['v2.023', 'v2.024'], triggerSetReady: true,
      triggerCount: 6, actorAuthorized: true },
    actor: { authorized: true, role: 'finance' },
    directTriggerPrivilege: true,
    operationState: readyOperationState(args.direction),
    freshManifest: { status: 'not-required-for-existing-operation-state' },
    now
  });
}

function privateTestDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-finance-wrapper-'));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function writeReceipt(directory, name, receipt) {
  const receiptPath = path.join(directory, name);
  const digest = live.writePrepareReceipt(receiptPath, receipt);
  return { receiptPath, digest };
}

function wrapperArguments({ mode, direction, receiptPath, receiptSha256, confirmation }) {
  const values = [
    `--mode=${mode}`,
    `--direction=${direction}`,
    `--expected-db=${live.HOSTINGER_SCHEMA}`,
    `--manifest-sha256=${core.APPROVED_MANIFEST_SHA256}`,
    '--preflight-sql=/private/approved.sql',
    '--manifest=/private/approved.json',
    '--operation-id=b35ff673-1a38-4d05-9494-0f447fa71a1a',
    '--idempotency-key=01b8e13b-fce9-4cd2-8f01-23c956b6c7c3',
    '--actor-id=41',
    '--reason=Approved bounded correction',
    `--prepare-receipt=${receiptPath}`
  ];
  if (receiptSha256) values.push(`--prepare-receipt-sha256=${receiptSha256}`);
  if (confirmation) values.push(`--confirm-write=${confirmation}`);
  return values;
}

function fakeRemoteConnection(calls) {
  const triggerRows = [
    ['trg_finance_restatement_operations_no_update', 'UPDATE', 'finance_assessment_restatement_operations'],
    ['trg_finance_restatement_operations_no_delete', 'DELETE', 'finance_assessment_restatement_operations'],
    ['trg_finance_restatement_annuals_no_update', 'UPDATE', 'finance_assessment_restatement_annuals'],
    ['trg_finance_restatement_annuals_no_delete', 'DELETE', 'finance_assessment_restatement_annuals'],
    ['trg_finance_restatement_events_no_update', 'UPDATE', 'finance_assessment_restatement_events'],
    ['trg_finance_restatement_events_no_delete', 'DELETE', 'finance_assessment_restatement_events']
  ].map(([trigger_name, event_manipulation, event_object_table]) => ({
    trigger_name,
    event_manipulation,
    event_object_table,
    action_timing: 'BEFORE',
    action_statement: "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance restatement history is append-only'"
  }));
  return {
    connection: {
      config: { host: live.HOSTINGER_HOST, port: live.HOSTINGER_PORT,
        ssl: { rejectUnauthorized: true, verifyIdentity: true } },
      stream: { remoteFamily: 'IPv4', authorized: true }
    },
    async query(sql) {
      calls.push({ method: 'query', sql });
      if (/VERSION\(\)/i.test(sql)) return [[{ selected_database: live.HOSTINGER_SCHEMA, server_port: live.HOSTINGER_PORT,
        authenticated_account: "'u364362094_ark'@'localhost'", server_version: 'MariaDB test' }]];
      if (/CURRENT_USER\(\)/i.test(sql)) return [[{ authenticated_account: "'u364362094_ark'@'localhost'" }]];
      if (/DATABASE\(\) AS selected_database/i.test(sql)) return [[{ selected_database: live.HOSTINGER_SCHEMA }]];
      return [[]];
    },
    async execute(sql, values) {
      calls.push({ method: 'execute', sql, values });
      if (/FROM schema_migrations/i.test(sql)) return [[{ version: 'v2.023' }, { version: 'v2.024' }]];
      if (/FROM information_schema\.triggers/i.test(sql)) return [triggerRows];
      if (/FROM information_schema\.SCHEMA_PRIVILEGES/i.test(sql)) return [[{
        table_schema: live.HOSTINGER_SCHEMA,
        grantee: "'u364362094_ark'@'localhost'",
        privilege_type: 'TRIGGER'
      }]];
      if (/FROM users WHERE id = \?/i.test(sql)) return [[{ id: 41, role: 'finance', is_active: 1 }]];
      throw new Error('Unexpected mocked maintenance query.');
    },
    async beginTransaction() { calls.push({ method: 'beginTransaction' }); },
    async rollback() { calls.push({ method: 'rollback' }); },
    async end() { calls.push({ method: 'end' }); }
  };
}

test('live configuration is exact and rejects socket or alternate database targets', () => {
  assert.doesNotThrow(() => live.assertLiveConfiguration(databaseConfig));
  for (const override of [
    { host: '148.222.53.111' },
    { port: 3307 },
    { database: 'arktiesiis' },
    { user: 'u364362094' },
    { socketPath: '/tmp/mysql.sock' },
    { password: '' }
  ]) {
    assert.throws(() => live.assertLiveConfiguration({ ...databaseConfig, ...override }), live.LiveMaintenanceError);
  }
});

test('remote connector pins Hostinger hostname, IPv4, TLS identity, and single statements', () => {
  let options;
  const socket = { setNoDelay() {}, setKeepAlive() {} };
  const config = live.buildRemoteConnectionOptions(databaseConfig, (value) => {
    options = value;
    return socket;
  });
  assert.equal(config.host, live.HOSTINGER_HOST);
  assert.equal(config.port, 3306);
  assert.equal(config.database, live.HOSTINGER_SCHEMA);
  assert.equal(config.multipleStatements, false);
  assert.equal(config.connectTimeout, 8000);
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, verifyIdentity: true });
  assert.equal(config.stream(), socket);
  assert.deepEqual(options, { host: live.HOSTINGER_HOST, port: 3306, family: 4 });
  assert.throws(() => live.assertVerifiedTransport({ connection: {
    config: { host: live.HOSTINGER_HOST, port: 3306, ssl: config.ssl },
    stream: { remoteFamily: 'IPv6', authorized: true }
  } }), live.LiveMaintenanceError);
  assert.doesNotThrow(() => live.assertVerifiedTransport({ connection: {
    config: { host: live.HOSTINGER_HOST, port: 3306, ssl: config.ssl },
    stream: { remoteFamily: 'IPv4', authorized: true }
  } }));
});

test('direct TRIGGER privilege matches exact schema, user, and host identities', () => {
  const account = "'u364362094_ark'@'localhost'";
  assert.equal(core.hasDirectSchemaPrivilege([
    { table_schema: live.HOSTINGER_SCHEMA, grantee: account, privilege_type: 'TRIGGER' }
  ], account, live.HOSTINGER_SCHEMA, 'TRIGGER'), true);
  assert.equal(core.hasDirectSchemaPrivilege([
    { table_schema: 'u364362094Xarkteisiis', grantee: account, privilege_type: 'TRIGGER' }
  ], account, live.HOSTINGER_SCHEMA, 'TRIGGER'), false);
  assert.equal(core.hasDirectSchemaPrivilege([
    { table_schema: live.HOSTINGER_SCHEMA, grantee: "'u364362094_ark'@'%'", privilege_type: 'TRIGGER' }
  ], account, live.HOSTINGER_SCHEMA, 'TRIGGER'), false);
  assert.equal(core.hasDirectSchemaPrivilege([
    { table_schema: live.HOSTINGER_SCHEMA, grantee: account, privilege_type: 'ALL PRIVILEGES' }
  ], account, live.HOSTINGER_SCHEMA, 'TRIGGER'), false);
});

test('trigger privilege checker binds the selected schema and asks only for TRIGGER', async () => {
  const calls = [];
  const connection = {
    async query(sql) {
      calls.push({ method: 'query', sql });
      return [[{ authenticated_account: "'u364362094_ark'@'localhost'" }]];
    },
    async execute(sql, values) {
      calls.push({ method: 'execute', sql, values });
      return [[{ table_schema: live.HOSTINGER_SCHEMA, grantee: "'u364362094_ark'@'localhost'", privilege_type: 'TRIGGER' }]];
    }
  };
  await core.assertTriggerPrivilege(connection, live.HOSTINGER_SCHEMA);
  const privilegeCall = calls.find((call) => call.method === 'execute');
  assert.deepEqual(privilegeCall.values, [live.HOSTINGER_SCHEMA, 'TRIGGER']);
  assert.match(privilegeCall.sql, /FROM information_schema\.SCHEMA_PRIVILEGES/);
  assert.doesNotMatch(calls.map((call) => call.sql).join('\n'), /SHOW\s+GRANTS/i);
});

test('schema prerequisite inspection binds exact schema and recognizes the six append-only triggers', async () => {
  const triggerSpecs = [
    ['trg_finance_restatement_operations_no_update', 'UPDATE', 'finance_assessment_restatement_operations'],
    ['trg_finance_restatement_operations_no_delete', 'DELETE', 'finance_assessment_restatement_operations'],
    ['trg_finance_restatement_annuals_no_update', 'UPDATE', 'finance_assessment_restatement_annuals'],
    ['trg_finance_restatement_annuals_no_delete', 'DELETE', 'finance_assessment_restatement_annuals'],
    ['trg_finance_restatement_events_no_update', 'UPDATE', 'finance_assessment_restatement_events'],
    ['trg_finance_restatement_events_no_delete', 'DELETE', 'finance_assessment_restatement_events']
  ];
  const calls = [];
  let extraTrigger = false;
  const connection = {
    async query(sql) {
      calls.push({ method: 'query', sql });
      return [[{ selected_database: live.HOSTINGER_SCHEMA }]];
    },
    async execute(sql, values) {
      calls.push({ method: 'execute', sql, values });
      if (sql.includes('FROM schema_migrations')) return [[{ version: 'v2.023' }, { version: 'v2.024' }]];
      const triggers = triggerSpecs.map(([trigger_name, event_manipulation, event_object_table]) => ({
        trigger_name,
        event_manipulation,
        event_object_table,
        action_timing: 'BEFORE',
        action_statement: "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance restatement history is append-only'"
      }));
      if (extraTrigger) triggers.push({ ...triggers[0], trigger_name: 'trg_finance_restatement_extra' });
      return [triggers];
    }
  };
  const result = await core.inspectMigrationPrerequisites(connection, live.HOSTINGER_SCHEMA);
  assert.equal(result.migrationsReady, true);
  assert.equal(result.triggerSetReady, true);
  assert.equal(result.triggerCount, 6);
  const triggerCall = calls.find((call) => call.sql.includes('information_schema.triggers'));
  assert.deepEqual(triggerCall.values, [live.HOSTINGER_SCHEMA, 'finance_assessment_restatement_operations',
    'finance_assessment_restatement_annuals', 'finance_assessment_restatement_events']);
  extraTrigger = true;
  assert.equal((await core.inspectMigrationPrerequisites(connection, live.HOSTINGER_SCHEMA)).triggerSetReady, false);
  await assert.rejects(() => core.inspectMigrationPrerequisites(connection, 'arktiesiis'), core.MaintenanceError);
});

test('operation-state inspection requires all four valid zero counts before treating a UUID as unused', async () => {
  const calls = [];
  let countResult = { archive_count: '0', charge_count: '0', allocation_count: '0', release_count: '0' };
  const connection = {
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('finance_assessment_restatement_operations')) return [[]];
      if (sql.includes('finance_assessment_restatement_events')) return [[]];
      assert.match(sql, /archive_count/);
      return [countResult === null ? [] : [countResult]];
    }
  };
  const inspect = () => core.inspectOperationState(connection, 'b35ff673-1a38-4d05-9494-0f447fa71a1a', {});
  assert.equal((await inspect()).state, 'unused-operation-id');
  countResult = null;
  assert.equal((await inspect()).state, 'operation-history-inconsistent');
  countResult = { archive_count: '0', charge_count: '0', allocation_count: '0' };
  assert.equal((await inspect()).state, 'operation-history-inconsistent');
  countResult = { archive_count: '0', charge_count: '0', allocation_count: '0', release_count: 'nope' };
  assert.equal((await inspect()).state, 'operation-history-inconsistent');
  countResult = { archive_count: '0', charge_count: '1', allocation_count: '0', release_count: '0' };
  assert.equal((await inspect()).state, 'orphaned-operation-artifacts');
  assert.equal(calls.length, 15);
  assert.ok(calls.every(({ sql }) => !/\bFOR UPDATE\b/i.test(sql)));
});

test('operation prepare logic distinguishes initial apply, matching idempotency, reversal, and drift', async () => {
  const originalInspect = core.inspectOperationState;
  try {
    const args = operationArgs('apply');
    core.inspectOperationState = async () => ({ state: 'unused-operation-id' });
    const unused = await live.inspectOperationReadiness({}, args, { digest: core.APPROVED_MANIFEST_SHA256 });
    assert.equal(unused.ready, true);
    assert.equal(unused.requiresFreshManifest, true);

    core.inspectOperationState = async () => ({ state: 'applied-current', appliedIdempotencyKey: args['idempotency-key'],
      currentStateSha256: 'a'.repeat(64), recordedStateSha256: 'a'.repeat(64) });
    const replay = await live.inspectOperationReadiness({}, args, { digest: core.APPROVED_MANIFEST_SHA256 });
    assert.equal(replay.ready, true);
    assert.equal(replay.requiresFreshManifest, false);
    assert.equal(replay.idempotencyKeyMatches, true);

    core.inspectOperationState = async () => ({ state: 'applied-drifted',
      currentStateSha256: 'b'.repeat(64), recordedStateSha256: 'a'.repeat(64) });
    assert.equal((await live.inspectOperationReadiness({}, args, { digest: core.APPROVED_MANIFEST_SHA256 })).ready, false);

    const reverseArgs = operationArgs('reverse');
    core.inspectOperationState = async () => ({ state: 'applied-current',
      currentStateSha256: 'a'.repeat(64), recordedStateSha256: 'a'.repeat(64) });
    const reverse = await live.inspectOperationReadiness({}, reverseArgs, { digest: core.APPROVED_MANIFEST_SHA256 });
    assert.equal(reverse.ready, true);
    assert.equal(reverse.state, 'applied-operation-awaiting-reversal');
    assert.equal(reverse.requiresFreshManifest, false);

    core.inspectOperationState = async () => ({ state: 'reversed-current', reversedIdempotencyKey: reverseArgs['idempotency-key'],
      currentStateSha256: 'c'.repeat(64), recordedStateSha256: 'c'.repeat(64) });
    const reversedReplay = await live.inspectOperationReadiness({}, reverseArgs, { digest: core.APPROVED_MANIFEST_SHA256 });
    assert.equal(reversedReplay.ready, true);
    assert.equal(reversedReplay.idempotencyKeyMatches, true);
  } finally {
    core.inspectOperationState = originalInspect;
  }
});

test('prepare receipts require a current saved operation digest and preserve the initial-apply manifest gate', () => {
  const currentDigest = 'a'.repeat(64);
  assert.equal(live.readyOperationReceipt({ state: 'applied-operation-awaiting-reversal',
    currentStateSha256: currentDigest, recordedStateSha256: currentDigest }, operationArgs('reverse')), true);
  assert.equal(live.readyOperationReceipt({ state: 'applied-operation-awaiting-reversal',
    currentStateSha256: 'b'.repeat(64), recordedStateSha256: currentDigest }, operationArgs('reverse')), false);
  assert.equal(live.readyOperationReceipt({ state: 'reversed-current', idempotencyKeyMatches: true,
    currentStateSha256: currentDigest, recordedStateSha256: currentDigest }, operationArgs('reverse')), true);

  const args = operationArgs('apply');
  const receipt = live.createPrepareReceipt({
    args,
    identity: { host: live.HOSTINGER_HOST, schema: live.HOSTINGER_SCHEMA, verifiedTlsIdentity: true },
    inputDigests: testInputDigests(),
    readiness: { migrationsReady: true, installedMigrations: ['v2.023', 'v2.024'], triggerSetReady: true, triggerCount: 6 },
    actor: { authorized: true, role: 'finance' },
    directTriggerPrivilege: true,
    operationState: { ready: true, state: 'unused-operation-id', requiresFreshManifest: true },
    freshManifest: { matchesPinned: false }
  });
  assert.equal(receipt.status, 'pending');
  assert.ok(receipt.pendingReasons.includes('fresh-manifest-does-not-match-frozen-cohort'));
  assert.equal(JSON.stringify(receipt).includes(args.reason), false);
  assert.equal(Object.hasOwn(receipt, 'idempotencyKey'), false);
});

test('receipt verification supports a current reverse and refuses a stale operation snapshot', () => {
  const currentDigest = 'f'.repeat(64);
  const args = operationArgs('reverse');
  const inputDigests = testInputDigests();
  const base = {
    args,
    identity: { host: live.HOSTINGER_HOST, port: live.HOSTINGER_PORT, schema: live.HOSTINGER_SCHEMA,
      databaseUser: live.HOSTINGER_USER, peerFamily: 'IPv4', verifiedTlsIdentity: true, serverVersion: 'MariaDB' },
    inputDigests,
    readiness: { migrationsReady: true, installedMigrations: ['v2.023', 'v2.024'],
      triggerSetReady: true, triggerCount: 6 },
    actor: { authorized: true, role: 'finance' },
    directTriggerPrivilege: true,
    freshManifest: { status: 'not-required-for-existing-operation-state' }
  };
  const readyReceipt = live.createPrepareReceipt({
    ...base,
    operationState: { ready: true, state: 'applied-operation-awaiting-reversal',
      currentStateSha256: currentDigest, recordedStateSha256: currentDigest }
  });
  assert.equal(readyReceipt.status, 'ready');
  const readyDigest = crypto.createHash('sha256').update(`${JSON.stringify(readyReceipt, null, 2)}\n`).digest('hex');
  assert.doesNotThrow(() => live.verifyPrepareReceipt(readyReceipt, args, inputDigests, readyDigest));

  const staleReceipt = live.createPrepareReceipt({
    ...base,
    operationState: { ready: true, state: 'applied-operation-awaiting-reversal',
      currentStateSha256: 'a'.repeat(64), recordedStateSha256: currentDigest }
  });
  assert.equal(staleReceipt.status, 'ready');
  const staleDigest = crypto.createHash('sha256').update(`${JSON.stringify(staleReceipt, null, 2)}\n`).digest('hex');
  assert.throws(() => live.verifyPrepareReceipt(staleReceipt, args, inputDigests, staleDigest), live.LiveMaintenanceError);
});

test('prepare receipt files are private, exclusive, and rejected if they point into the app checkout', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-finance-receipt-'));
  try {
    fs.chmodSync(directory, 0o700);
    const receiptPath = path.join(directory, 'prepare.json');
    const receipt = { status: 'pending', canExecute: false };
    const digest = live.writePrepareReceipt(receiptPath, receipt);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
    assert.deepEqual(live.readPrepareReceipt(receiptPath).receipt, receipt);
    assert.throws(() => live.writePrepareReceipt(receiptPath, receipt), /EEXIST/);
    assert.throws(() => live.resolvePrivateReceiptPath(path.resolve(__dirname, '../private.json')), live.LiveMaintenanceError);
    const sharedDirectory = path.join(directory, 'shared');
    fs.mkdirSync(sharedDirectory, { mode: 0o755 });
    fs.chmodSync(sharedDirectory, 0o755);
    assert.throws(() => live.resolvePrivateReceiptPath(path.join(sharedDirectory, 'prepare.json')), /must be owned by the operator and private/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI parser requires separate read-only prepare and explicit execute confirmation', () => {
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-finance-cli-'));
  try {
    const receipt = path.join(files, 'prepare.json');
    const base = [
      '--direction=apply',
      `--expected-db=${live.HOSTINGER_SCHEMA}`,
      `--manifest-sha256=${core.APPROVED_MANIFEST_SHA256}`,
      '--preflight-sql=/private/approved.sql',
      '--manifest=/private/approved.json',
      '--operation-id=b35ff673-1a38-4d05-9494-0f447fa71a1a',
      '--idempotency-key=01b8e13b-fce9-4cd2-8f01-23c956b6c7c3',
      '--actor-id=41',
      '--reason=Approved bounded correction'
    ];
    const prepared = live.parseArguments(['--mode=prepare', ...base, `--prepare-receipt=${receipt}`], databaseConfig);
    assert.equal(prepared.mode, 'prepare');
    assert.throws(() => live.parseArguments(['--mode=execute', ...base, `--prepare-receipt=${receipt}`], databaseConfig), live.LiveMaintenanceError);
    const executed = live.parseArguments(['--mode=execute', ...base, `--prepare-receipt=${receipt}`,
      `--prepare-receipt-sha256=${'a'.repeat(64)}`, '--confirm-write=APPLY_FIXED_79_TUITION_RESTATEMENT'], databaseConfig);
    assert.equal(executed.mode, 'execute');
    assert.throws(() => live.parseArguments(['--mode=execute', ...base, `--prepare-receipt=${receipt}`,
      `--prepare-receipt-sha256=${'a'.repeat(64)}`, '--confirm-write=REVERSE_FIXED_79_TUITION_RESTATEMENT'], databaseConfig), live.LiveMaintenanceError);
  } finally {
    fs.rmSync(files, { recursive: true, force: true });
  }
});

test('prepare run uses a read-only transaction and rolls it back for an existing operation', async () => {
  const originalLoad = core.loadApprovedInputs;
  const originalInspect = core.inspectOperationState;
  const directory = privateTestDirectory();
  const receiptPath = path.join(directory, 'prepare.json');
  const inputs = testInputs();
  const calls = [];
  const connection = fakeRemoteConnection(calls);
  let inspectedExistingOperation = 0;
  try {
    core.loadApprovedInputs = () => inputs;
    core.inspectOperationState = async () => {
      inspectedExistingOperation += 1;
      return { state: 'applied-current', appliedIdempotencyKey: '01b8e13b-fce9-4cd2-8f01-23c956b6c7c3',
        currentStateSha256: 'a'.repeat(64), recordedStateSha256: 'a'.repeat(64) };
    };
    const result = await live.run(wrapperArguments({ mode: 'prepare', direction: 'apply', receiptPath }), {
      databaseConfig,
      netConnect: () => ({ setNoDelay() {}, setKeepAlive() {} }),
      async createConnection() { return connection; }
    });

    assert.equal(result.status, 'ready');
    assert.equal(inspectedExistingOperation, 1);
    assert.equal(calls.filter(({ method }) => method === 'beginTransaction').length, 1);
    assert.equal(calls.filter(({ method }) => method === 'rollback').length, 1);
    assert.equal(calls.filter(({ method }) => method === 'end').length, 1);
    assert.ok(calls.some(({ sql }) => sql === 'SET TRANSACTION READ ONLY'));
    const sqlCalls = calls.filter(({ sql }) => typeof sql === 'string');
    assert.ok(sqlCalls.every(({ sql }) => !/\bFOR\s+UPDATE\b/i.test(sql)));
    assert.ok(sqlCalls.every(({ sql }) => !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP)\b/i.test(sql)));
    assert.equal(sqlCalls.filter(({ sql }) => /WITH\s+expected_annuals/i.test(sql)).length, 0,
      'existing operation preparation must inspect its saved state without rechecking the initial-apply manifest');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.equal(live.hasValidInputDigests(receipt.inputDigests), true);
    assert.equal(Object.keys(receipt.inputDigests).length, 6);
  } finally {
    core.loadApprovedInputs = originalLoad;
    core.inspectOperationState = originalInspect;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('execute rejects pending and stale-source receipts before opening a connection', async () => {
  const originalLoad = core.loadApprovedInputs;
  const directory = privateTestDirectory();
  const inputs = testInputs();
  let connections = 0;
  try {
    core.loadApprovedInputs = () => inputs;
    const execute = async (name, receipt) => {
      const { receiptPath, digest } = writeReceipt(directory, name, receipt);
      return live.run(wrapperArguments({ mode: 'execute', direction: 'reverse', receiptPath, receiptSha256: digest,
        confirmation: 'REVERSE_FIXED_79_TUITION_RESTATEMENT' }), {
        databaseConfig,
        async createConnection() { connections += 1; throw new Error('must not connect for an invalid receipt'); }
      });
    };
    const digests = live.currentInputDigests(inputs);
    const args = operationArgs('reverse');
    const pending = readyPrepareReceipt(args, digests);
    pending.status = 'pending';
    pending.canExecute = false;
    await assert.rejects(() => execute('pending.json', pending), live.LiveMaintenanceError);

    const stale = readyPrepareReceipt(args, digests);
    stale.inputDigests = { ...digests, coreFileSha256: '0'.repeat(64) };
    await assert.rejects(() => execute('stale.json', stale), /does not match the requested operation/);
    assert.equal(connections, 0);
  } finally {
    core.loadApprovedInputs = originalLoad;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('execute does not retry an uncertain transaction outcome', async () => {
  const originalLoad = core.loadApprovedInputs;
  const originalExecute = core.executePreparedOperation;
  const directory = privateTestDirectory();
  const inputs = testInputs();
  const calls = [];
  const connection = fakeRemoteConnection(calls);
  let executeCount = 0;
  let connectionCount = 0;
  try {
    core.loadApprovedInputs = () => inputs;
    core.executePreparedOperation = async () => {
      executeCount += 1;
      throw new core.MaintenanceError(core.transactionFailureMessage({
        commitAttempted: true, commitConfirmed: false, rollbackConfirmed: false
      }));
    };
    const args = operationArgs('reverse');
    const { receiptPath, digest } = writeReceipt(directory, 'uncertain.json',
      readyPrepareReceipt(args, live.currentInputDigests(inputs)));
    await assert.rejects(() => live.run(wrapperArguments({ mode: 'execute', direction: 'reverse', receiptPath,
      receiptSha256: digest, confirmation: 'REVERSE_FIXED_79_TUITION_RESTATEMENT' }), {
      databaseConfig,
      netConnect: () => ({ setNoDelay() {}, setKeepAlive() {} }),
      async createConnection() { connectionCount += 1; return connection; }
    }), /commit outcome is unconfirmed/);
    assert.equal(connectionCount, 1);
    assert.equal(executeCount, 1);
    assert.equal(calls.filter(({ method }) => method === 'end').length, 1);
  } finally {
    core.loadApprovedInputs = originalLoad;
    core.executePreparedOperation = originalExecute;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('core executor rolls back one pre-commit failure and does not retry it', async () => {
  const calls = [];
  let schemaChecks = 0;
  const connection = {
    async query(sql) {
      calls.push(sql);
      if (/DATABASE\(\) AS selected_database/i.test(sql)) {
        schemaChecks += 1;
        if (schemaChecks === 2) throw new Error('mocked in-transaction read failure');
        return [[{ selected_database: 'arktiesiis' }]];
      }
      return [[]];
    },
    async beginTransaction() { calls.push('BEGIN'); },
    async rollback() { calls.push('ROLLBACK'); },
    async commit() { calls.push('COMMIT'); }
  };
  await assert.rejects(() => core.executePreparedOperation(connection, { mode: 'apply' }, {}, 'arktiesiis'),
    /transaction failed and was rolled back/);
  assert.equal(calls.filter((call) => call === 'BEGIN').length, 1);
  assert.equal(calls.filter((call) => call === 'ROLLBACK').length, 1);
  assert.equal(calls.filter((call) => call === 'COMMIT').length, 0);
  assert.equal(schemaChecks, 2);
});

test('unexpected remote failures expose only a bounded error code', () => {
  assert.equal(live.publicFailure({ code: 'ER_ACCESS_DENIED_ERROR', message: 'do-not-show-password' }),
    'Remote finance maintenance stopped (ER_ACCESS_DENIED_ERROR); no automatic retry was attempted.');
  assert.equal(live.publicFailure(new Error('private SQL and parameters')),
    'Remote finance maintenance stopped (UNEXPECTED_ERROR); no automatic retry was attempted.');
});
