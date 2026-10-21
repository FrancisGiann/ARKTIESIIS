'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '43317';
process.env.DB_NAME = 'arktiesiis';
process.env.DB_SOCKET_PATH = '';
const {
  APPROVED_MANIFEST_SHA256,
  MaintenanceError,
  assertExpectedDatabase,
  assertRehearsalConfiguration,
  parseArguments,
  queryFreshManifest,
  transactionFailureMessage
} = require('../scripts/hostinger-demo-finance-restatement');

test('restatement CLI accepts the documented numeric manifest digest option', () => {
  const args = parseArguments([
    '--mode=preflight',
    '--expected-db=arktiesiis',
    '--manifest=/private/fixed-manifest.json',
    `--manifest-sha256=${APPROVED_MANIFEST_SHA256}`,
    '--preflight-sql=/private/fixed-query.sql'
  ]);

  assert.equal(args['manifest-sha256'], APPROVED_MANIFEST_SHA256);
  assert.equal(args.mode, 'preflight');
});

test('restatement CLI rejects the system database endpoint and socket transports', () => {
  for (const config of [
    { host: 'localhost', port: 43317, database: 'arktiesiis', socketPath: '' },
    { host: '127.0.0.1', port: 3306, database: 'arktiesiis', socketPath: '' },
    { host: '127.0.0.1', port: 43317, database: 'arktiesiis', socketPath: '/tmp/other.sock' }
  ]) {
    assert.throws(() => assertRehearsalConfiguration(config), MaintenanceError);
  }
});

test('restatement CLI verifies runtime database port and datadir', async () => {
  const expectedDatadir = path.resolve(os.homedir(), '.codex/arktiesiis-qa/2026-10-21/finance-restatement-distinct-e74/data');
  await assertExpectedDatabase({
    async query() { return [[{ selected_database: 'arktiesiis', server_port: 43317, server_data_directory: `${expectedDatadir}/` }]]; }
  });
  for (const identity of [
    { selected_database: 'arktiesiis', server_port: 3306, server_data_directory: expectedDatadir },
    { selected_database: 'arktiesiis', server_port: 43317, server_data_directory: '/var/lib/mysql/' },
    { selected_database: 'other', server_port: 43317, server_data_directory: expectedDatadir }
  ]) {
    await assert.rejects(() => assertExpectedDatabase({ async query() { return [[identity]]; } }), MaintenanceError);
  }
});

test('manifest query accepts only plain JSON objects from MariaDB JSON_OBJECT', async () => {
  const pinnedSql = [
    'SET SESSION max_statement_time = 5;',
    'START TRANSACTION READ ONLY;',
    '',
    'WITH expected_annuals AS (SELECT 1)',
    'SELECT manifest_row FROM manifest_rows',
    'ORDER BY sort_group, ordinal, row_id;',
    '',
    'ROLLBACK;',
    ''
  ].join('\n');
  const manifestRow = { row_type: 'synthetic', row_id: 1 };
  const rows = await queryFreshManifest({ async query() { return [[{ manifest_row: manifestRow }]]; } }, pinnedSql);
  assert.deepEqual(rows, [manifestRow]);
  await assert.rejects(
    () => queryFreshManifest({ async query() { return [[{ manifest_row: [manifestRow] }]]; } }, pinnedSql),
    MaintenanceError
  );
});

test('restatement outcome reporting distinguishes confirmed rollback from uncertain commit', () => {
  assert.match(transactionFailureMessage({ commitAttempted: false, commitConfirmed: false, rollbackConfirmed: true }), /was rolled back/);
  assert.match(transactionFailureMessage({ commitAttempted: false, commitConfirmed: false, rollbackConfirmed: false }), /outcome is unconfirmed/);
  assert.match(transactionFailureMessage({ commitAttempted: true, commitConfirmed: false, rollbackConfirmed: true }), /commit outcome is unconfirmed/);
  assert.match(transactionFailureMessage({ commitAttempted: true, commitConfirmed: false, rollbackConfirmed: false }), /commit outcome is unconfirmed/);
  assert.match(transactionFailureMessage({ commitAttempted: true, commitConfirmed: true, rollbackConfirmed: false }), /committed, but completion could not be reported/);
});
