'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { PoolFacade, sql } = require('../src/config/database');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { createAccountInvitationService } = require('../src/services/accountInvitationService');
const { createAdminService } = require('../src/services/adminService');
const { hashActionToken } = require('../src/services/accountService');

const socketPath = process.env.ACCOUNT_INVITATION_MARIADB_TEST_SOCKET;
const databaseUser = process.env.ACCOUNT_INVITATION_MARIADB_TEST_USER || os.userInfo().username;
const databasePassword = process.env.ACCOUNT_INVITATION_MARIADB_TEST_PASSWORD ?? '';
const ROOT = path.resolve(__dirname, '..');

function uuid() { return crypto.randomUUID(); }
function identifier(value) { return `\`${String(value).replaceAll('`', '``')}\``; }
function testPasswordHash(value) {
  return `integration-hash-${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function createSchema(connection, databaseName) {
  await connection.query(`CREATE DATABASE ${identifier(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.query(`USE ${identifier(databaseName)}`);
  await applyStatements(connection, readSqlFile(path.join(ROOT, 'database/mariadb/schema.sql')));
  const migrations = readForwardMigrations();
  for (const migration of migrations.filter(({ version }) => version <= 'v2.022')) {
    await applyStatements(connection, migration.statements);
    await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
  }
  return migrations.find(({ version }) => version === 'v2.023');
}

function createHashGate(expectedCalls) {
  let calls = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return {
    async hash(password) {
      calls += 1;
      if (calls === expectedCalls) release();
      await ready;
      return testPasswordHash(password);
    }
  };
}

test('migration 023 preserves existing accounts and invitation acceptance serializes against competing actions', {
  skip: !socketPath && 'Set ACCOUNT_INVITATION_MARIADB_TEST_SOCKET to an isolated private MariaDB socket.',
  timeout: 180000
}, async () => {
  assert.ok(path.isAbsolute(socketPath), 'the opt-in test uses an absolute socket path');
  assert.ok(path.resolve(socketPath).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    'the opt-in socket must be a private disposable socket under /tmp');

  const adminConnection = await mysql.createConnection({ socketPath, user: databaseUser, password: databasePassword });
  const databaseName = `arktiesiis_invite_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  let appPool;
  try {
    const migration023 = await createSchema(adminConnection, databaseName);
    assert.ok(migration023, 'the forward-only v2.023 migration is present');

    const [legacyAdminInsert] = await adminConnection.execute(`INSERT INTO ${identifier(databaseName)}.users
      (email, password_hash, role, is_active, email_verified_at, auth_session_version, must_change_password)
      VALUES (?, ?, 'database_admin', 1, '2025-04-03 12:30:00', ?, 0)`,
    [`legacy-admin-${uuid()}@integration.invalid`, 'legacy-admin-hash-preserved', uuid()]);
    const legacyAdminId = Number(legacyAdminInsert.insertId);
    const legacyPasswordHash = 'legacy-student-hash-preserved-verbatim';
    const legacySessionVersion = uuid();
    const [legacyStudentInsert] = await adminConnection.execute(`INSERT INTO ${identifier(databaseName)}.users
      (email, password_hash, role, is_active, email_verified_at, auth_session_version, must_change_password)
      VALUES (?, ?, 'student', 0, NULL, ?, 1)`,
    [`legacy-student-${uuid()}@integration.invalid`, legacyPasswordHash, legacySessionVersion]);
    const legacyStudentUserId = Number(legacyStudentInsert.insertId);
    await adminConnection.execute(`INSERT INTO ${identifier(databaseName)}.students
      (user_id, student_no, lrn, first_name, last_name, status)
      VALUES (?, ?, '900000000001', 'Synthetic', 'Legacy', 'active')`,
    [legacyStudentUserId, `SYN-INV-${uuid().slice(0, 8)}`]);
    const [[legacyAdminBefore]] = await adminConnection.execute(`SELECT email, password_hash, role, is_active,
      email_verified_at, auth_session_version, must_change_password FROM ${identifier(databaseName)}.users WHERE id = ?`, [legacyAdminId]);
    const [[legacyStudentBefore]] = await adminConnection.execute(`SELECT account.email, account.password_hash, account.role,
      account.is_active, account.email_verified_at, account.auth_session_version, account.must_change_password,
      student.user_id FROM ${identifier(databaseName)}.users AS account
      INNER JOIN ${identifier(databaseName)}.students AS student ON student.user_id = account.id
      WHERE account.id = ?`, [legacyStudentUserId]);

    await adminConnection.query(`USE ${identifier(databaseName)}`);
    await applyStatements(adminConnection, migration023.statements);
    await adminConnection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration023.version]);

    const [[legacyAdminAfter]] = await adminConnection.execute(`SELECT email, password_hash, role, is_active,
      email_verified_at, auth_session_version, must_change_password, invitation_required
      FROM users WHERE id = ?`, [legacyAdminId]);
    const [[legacyStudentAfter]] = await adminConnection.execute(`SELECT account.email, account.password_hash, account.role,
      account.is_active, account.email_verified_at, account.auth_session_version, account.must_change_password,
      account.invitation_required, student.user_id FROM users AS account
      INNER JOIN students AS student ON student.user_id = account.id WHERE account.id = ?`, [legacyStudentUserId]);
    assert.deepEqual(Object.values(legacyAdminAfter).slice(0, 7), Object.values(legacyAdminBefore));
    assert.equal(Number(legacyAdminAfter.invitation_required), 0);
    for (const key of Object.keys(legacyStudentBefore)) {
      assert.equal(legacyStudentAfter[key], legacyStudentBefore[key], `existing student account field ${key} is unchanged`);
    }
    assert.equal(Number(legacyStudentAfter.invitation_required), 0);
    assert.equal(Number(legacyStudentAfter.user_id), legacyStudentUserId, 'the existing student login link is unchanged');
    assert.equal(legacyStudentAfter.password_hash, legacyPasswordHash);

    appPool = mysql.createPool({
      socketPath,
      user: databaseUser,
      password: databasePassword,
      database: databaseName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'],
      multipleStatements: false
    });
    const getPool = async () => new PoolFacade(appPool);
    const deliveries = [];
    let hashOverride = null;
    const service = createAccountInvitationService({
      getPool,
      sql,
      appBaseUrl: 'https://school.example.test',
      smtp: { host: 'smtp.synthetic.invalid', from: 'no-reply@synthetic.invalid' },
      createToken: () => crypto.randomBytes(32).toString('base64url'),
      hashPassword: async (password) => hashOverride ? hashOverride(password) : testPasswordHash(password),
      deliverEmail: async (_smtp, message) => { deliveries.push(message); }
    });
    const adminService = createAdminService({ getPool, sql, hashPassword: async () => 'unused-synthetic-admin-hash' });

    async function createAccount(email, role = 'student', { active = true, pending = true } = {}) {
      const [insert] = await appPool.execute(`INSERT INTO users
        (email, password_hash, role, is_active, invitation_required, must_change_password)
        VALUES (?, 'synthetic-current-hash', ?, ?, ?, 0)`, [email, role, active ? 1 : 0, pending ? 1 : 0]);
      return Number(insert.insertId);
    }
    function issuedAction(email) {
      const message = deliveries.findLast((item) => item.to === email);
      assert.ok(message, 'the synthetic mailer captured the invitation');
      const line = message.text.split('\n').find((part) => part.startsWith('Choose your password: '));
      assert.ok(line, 'the text message includes its action URL');
      const url = new URL(line.slice('Choose your password: '.length));
      assert.equal(url.origin, 'https://school.example.test');
      return { id: url.searchParams.get('requestId'), token: url.searchParams.get('token') };
    }

    const [[version]] = await appPool.execute('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    assert.equal(version.version, 'v2.023');
    const [columns] = await appPool.execute(`SELECT column_name, column_default, is_nullable
      FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users'
        AND column_name = 'invitation_required'`);
    assert.equal(columns.length, 1);
    assert.equal(columns[0].column_default, '0');
    assert.equal(columns[0].is_nullable, 'NO');

    const pendingEmail = `new-student-${uuid()}@integration.invalid`;
    const pendingId = await createAccount(pendingEmail);
    await service.issueInvitation(legacyAdminId, pendingId);
    const firstAction = issuedAction(pendingEmail);
    const [[storedInvitation]] = await appPool.execute(`SELECT id, token_hash, email_snapshot, delivery_status,
      consumed_at, revoked_at FROM account_setup_tokens WHERE id = ?`, [Number(firstAction.id)]);
    assert.equal(storedInvitation.token_hash, hashActionToken(firstAction.token));
    assert.equal(storedInvitation.email_snapshot, pendingEmail);
    assert.equal(storedInvitation.delivery_status, 'sent');
    assert.equal(storedInvitation.consumed_at, null);
    assert.equal(storedInvitation.revoked_at, null);
    await appPool.execute("UPDATE account_setup_tokens SET delivery_status = 'unknown' WHERE id = ?", [storedInvitation.id]);
    const [[unknownDelivery]] = await appPool.execute('SELECT delivery_status FROM account_setup_tokens WHERE id = ?', [storedInvitation.id]);
    assert.equal(unknownDelivery.delivery_status, 'unknown', 'migration 023 permits an ambiguous transport outcome');
    await appPool.execute("UPDATE account_setup_tokens SET delivery_status = 'sent' WHERE id = ?", [storedInvitation.id]);

    await assert.rejects(appPool.execute(`INSERT INTO account_setup_tokens
      (user_id, created_by, token_hash, email_snapshot, expires_at, delivery_status)
      VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 MINUTE), 'pending')`,
    [pendingId, legacyAdminId, hashActionToken(crypto.randomBytes(32).toString('base64url')), pendingEmail]),
    (error) => error?.code === 'ER_DUP_ENTRY',
    'MariaDB enforces the generated unique index for one active invitation per account');

    const twoHashGate = createHashGate(2);
    hashOverride = twoHashGate.hash;
    const simultaneousAccepts = await Promise.all([
      service.acceptInvitation(firstAction.id, firstAction.token, 'First-synthetic-password-42'),
      service.acceptInvitation(firstAction.id, firstAction.token, 'Second-synthetic-password-42')
    ]);
    hashOverride = null;
    assert.deepEqual(simultaneousAccepts.slice().sort(), ['accepted', 'invalid_token']);
    const [[acceptedAccount]] = await appPool.execute(`SELECT password_hash, role, is_active, invitation_required,
      must_change_password FROM users WHERE id = ?`, [pendingId]);
    assert.equal(acceptedAccount.role, 'student');
    assert.equal(Number(acceptedAccount.is_active), 1);
    assert.equal(Number(acceptedAccount.invitation_required), 0);
    assert.equal(Number(acceptedAccount.must_change_password), 0);
    assert.ok(['First-synthetic-password-42', 'Second-synthetic-password-42']
      .map(testPasswordHash).includes(acceptedAccount.password_hash));
    const [[acceptedToken]] = await appPool.execute('SELECT consumed_at FROM account_setup_tokens WHERE id = ?', [Number(firstAction.id)]);
    assert.ok(acceptedToken.consumed_at);
    const [acceptedAudit] = await appPool.execute(`SELECT id FROM audit_logs
      WHERE action = 'account.invitation_accepted' AND entity_id = ?`, [String(pendingId)]);
    assert.equal(acceptedAudit.length, 1);

    const updateEmail = `status-race-${uuid()}@integration.invalid`;
    const updateId = await createAccount(updateEmail, 'registrar');
    await appPool.execute(`INSERT INTO staff_profiles (user_id, first_name, last_name, department)
      VALUES (?, 'Synthetic', 'Pending', 'Records')`, [updateId]);
    await service.issueInvitation(legacyAdminId, updateId);
    const updateAction = issuedAction(updateEmail);
    let announceHash;
    const hashStarted = new Promise((resolve) => { announceHash = resolve; });
    let continueHash;
    const blockedHash = new Promise((resolve) => { continueHash = resolve; });
    hashOverride = async (password) => { announceHash(); await blockedHash; return testPasswordHash(password); };
    const blockedAccept = service.acceptInvitation(updateAction.id, updateAction.token, 'Status-race-password-42');
    await hashStarted;
    await adminService.updateUser(legacyAdminId, updateId, {
      email: updateEmail, role: 'registrar', isActive: '0',
      firstName: 'Synthetic', lastName: 'Pending', department: 'Records'
    });
    continueHash();
    assert.equal(await blockedAccept, 'invalid_token');
    hashOverride = null;
    const [[updatedAccount]] = await appPool.execute(`SELECT account.password_hash, account.role, account.is_active,
      account.invitation_required, invitation.revoked_at FROM users AS account
      INNER JOIN account_setup_tokens AS invitation ON invitation.id = ? WHERE account.id = ?`,
    [Number(updateAction.id), updateId]);
    assert.equal(updatedAccount.password_hash, 'synthetic-current-hash', 'the losing acceptance does not replace the password');
    assert.equal(updatedAccount.role, 'registrar');
    assert.equal(Number(updatedAccount.is_active), 0);
    assert.equal(Number(updatedAccount.invitation_required), 1, 'administrator deactivation does not complete setup');
    assert.ok(updatedAccount.revoked_at, 'the administrator status change revokes the pending link');

    const revokeEmail = `revoke-race-${uuid()}@integration.invalid`;
    const revokeId = await createAccount(revokeEmail);
    await service.issueInvitation(legacyAdminId, revokeId);
    const revokeAction = issuedAction(revokeEmail);
    let announceRevokeHash;
    const revokeHashStarted = new Promise((resolve) => { announceRevokeHash = resolve; });
    let continueRevokeHash;
    const blockedRevokeHash = new Promise((resolve) => { continueRevokeHash = resolve; });
    hashOverride = async (password) => { announceRevokeHash(); await blockedRevokeHash; return testPasswordHash(password); };
    const revokeRaceAccept = service.acceptInvitation(revokeAction.id, revokeAction.token, 'Revoke-race-password-42');
    await revokeHashStarted;
    assert.equal(await service.revokeInvitation(legacyAdminId, revokeId), 'revoked');
    continueRevokeHash();
    assert.equal(await revokeRaceAccept, 'invalid_token');
    hashOverride = null;
    const [[revokedAccount]] = await appPool.execute(`SELECT account.password_hash, account.is_active,
      account.invitation_required, invitation.revoked_at FROM users AS account
      INNER JOIN account_setup_tokens AS invitation ON invitation.id = ? WHERE account.id = ?`,
    [Number(revokeAction.id), revokeId]);
    assert.equal(revokedAccount.password_hash, 'synthetic-current-hash');
    assert.equal(Number(revokedAccount.is_active), 1, 'revoking an invitation does not deactivate the account');
    assert.equal(Number(revokedAccount.invitation_required), 1, 'revoking an invitation does not complete setup');
    assert.ok(revokedAccount.revoked_at);

    const resendEmail = `resend-race-${uuid()}@integration.invalid`;
    const resendId = await createAccount(resendEmail);
    await service.issueInvitation(legacyAdminId, resendId);
    const oldResendAction = issuedAction(resendEmail);
    await appPool.execute('UPDATE account_setup_tokens SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 31 SECOND) WHERE id = ?',
      [Number(oldResendAction.id)]);
    let announceResendHash;
    const resendHashStarted = new Promise((resolve) => { announceResendHash = resolve; });
    let continueResendHash;
    const blockedResendHash = new Promise((resolve) => { continueResendHash = resolve; });
    hashOverride = async (password) => { announceResendHash(); await blockedResendHash; return testPasswordHash(password); };
    const staleAccept = service.acceptInvitation(oldResendAction.id, oldResendAction.token, 'Resend-race-password-42');
    await resendHashStarted;
    const resent = await service.issueInvitation(legacyAdminId, resendId);
    assert.equal(resent.status, 'sent');
    const currentResendAction = issuedAction(resendEmail);
    assert.notEqual(currentResendAction.id, oldResendAction.id);
    continueResendHash();
    assert.equal(await staleAccept, 'invalid_token');
    hashOverride = null;
    const [[resendState]] = await appPool.execute(`SELECT account.invitation_required,
      old_token.revoked_at AS old_revoked_at, new_token.revoked_at AS new_revoked_at
      FROM users AS account
      INNER JOIN account_setup_tokens AS old_token ON old_token.id = ?
      INNER JOIN account_setup_tokens AS new_token ON new_token.id = ?
      WHERE account.id = ?`, [Number(oldResendAction.id), Number(currentResendAction.id), resendId]);
    assert.equal(Number(resendState.invitation_required), 1);
    assert.ok(resendState.old_revoked_at);
    assert.equal(resendState.new_revoked_at, null);
  } finally {
    try {
      if (appPool) await appPool.end();
    } finally {
      try { await adminConnection.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)}`); }
      finally { await adminConnection.end(); }
    }
  }
});
