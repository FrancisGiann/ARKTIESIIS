'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const session = require('express-session');
const {
  createAccountInvitationService,
  AccountInvitationError,
  BULK_DELIVERY_RESPONSE_WAIT_MS
} = require('../src/services/accountInvitationService');
const { createAccountInvitationRouter } = require('../src/routes/accountInvitations');
const { hashActionToken } = require('../src/services/accountService');

const token = 'a'.repeat(43);
const password = 'New-Account-Password-99';

function fakeSql() {
  return {
    MAX: 'MAX', Int: 'Int', Bit: 'Bit', Char: (length) => `Char(${length})`,
    NVarChar: (length) => `NVarChar(${length})`,
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }
  };
}

function invitationFixture(onQuery, overrides = {}) {
  const log = { calls: [], begins: 0, commits: 0, rollbacks: 0 };
  async function query(statement, values, transactional) {
    const call = { statement, values: { ...values }, transactional };
    log.calls.push(call);
    return onQuery(call);
  }
  function request(transactional) {
    const values = {};
    return {
      input(name, _type, value) { values[name] = value; return this; },
      query(statement) { return query(statement, values, transactional); }
    };
  }
  const pool = { request: () => request(false) };
  const transactionFactory = () => ({
    async begin(level) { log.begins += 1; log.isolation = level; },
    request: () => request(true),
    async commit() { log.commits += 1; },
    async rollback() { log.rollbacks += 1; }
  });
  const service = createAccountInvitationService({
    getPool: async () => pool,
    sql: fakeSql(),
    appBaseUrl: 'https://school.example.edu',
    smtp: { host: 'smtp.example.edu', from: 'no-reply@example.edu' },
    createToken: () => token,
    deliverEmail: async (_smtp, message) => { log.email = message; },
    transactionFactory,
    ...overrides
  });
  return { service, log };
}

function issueQuery({ sendCount = 0, cooldown = 0, previousInvitation = false, active = true } = {}) {
  return ({ statement, values }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: active ? [{ id: 7 }] : [] };
    if (statement.includes('SELECT COUNT(*) AS send_count')) return { recordset: [{ send_count: sendCount }] };
    if (statement.includes('SELECT id, email, role, is_active, invitation_required')) {
      return { recordset: [{ id: 19, email: 'recipient@example.edu', role: 'registrar', is_active: true, invitation_required: true }] };
    }
    if (statement.includes('SELECT invitation.id FROM account_setup_tokens AS invitation')) {
      return { recordset: [{ id: values.invitationId }] };
    }
    if (statement.includes('cooldown_active')) return { recordset: cooldown || previousInvitation
      ? [{ id: 31, cooldown_active: cooldown }] : [] };
    if (statement.includes('INSERT INTO account_setup_tokens')) return { insertId: 32 };
    if (statement.includes('INSERT INTO audit_logs') || statement.startsWith('UPDATE account_setup_tokens SET revoked_at')
      || statement.includes('SET invitation.delivery_status')) return { affectedRows: 1 };
    throw new Error(`Unexpected invitation query: ${statement}`);
  };
}

test('invitation issuance stores only a token hash and returns delivery status without the token', async () => {
  const { service, log } = invitationFixture(issueQuery());
  const result = await service.issueInvitation(7, 19);
  assert.deepEqual(result, { status: 'sent', email: 'recipient@example.edu' });
  assert.equal(log.begins, 1);
  assert.equal(log.commits, 1);
  assert.equal(log.rollbacks, 0);
  assert.equal(log.isolation, 'SERIALIZABLE');
  const insert = log.calls.find(({ statement }) => statement.includes('INSERT INTO account_setup_tokens'));
  assert.equal(insert.values.tokenHash, hashActionToken(token));
  assert.equal(JSON.stringify(log.calls).includes(token), false);
  assert.match(log.email.text, /https:\/\/school\.example\.edu\/account\/setup\?/);
  assert.match(log.email.text, /30 minutes/);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.ok(log.calls.some(({ statement, values }) => statement.includes('INSERT INTO audit_logs') && values.action === 'account.invitation_issued'
    && values.detailsJson === JSON.stringify({ role: 'registrar', bulk: false })));
});

test('resending revokes the earlier link and records a resend audit event before delivery', async () => {
  const { service, log } = invitationFixture(issueQuery({ previousInvitation: true }));
  assert.deepEqual(await service.issueInvitation(7, 19), { status: 'sent', email: 'recipient@example.edu' });
  const revokeIndex = log.calls.findIndex(({ statement }) => statement.startsWith('UPDATE account_setup_tokens SET revoked_at'));
  const insertIndex = log.calls.findIndex(({ statement }) => statement.includes('INSERT INTO account_setup_tokens'));
  assert.ok(revokeIndex >= 0 && revokeIndex < insertIndex);
  assert.ok(log.calls.some(({ statement, values }) => statement.includes('INSERT INTO audit_logs')
    && values.action === 'account.invitation_resent'));
});

test('definitive SMTP rejection is recorded as failed without exposing provider diagnostics', async () => {
  const { service, log } = invitationFixture(issueQuery(), {
    async deliverEmail() { throw Object.assign(new Error('private SMTP response'), { responseCode: 550 }); }
  });
  assert.deepEqual(await service.issueInvitation(7, 19), { status: 'delivery_failed', email: 'recipient@example.edu' });
  const deliveryUpdate = log.calls.find(({ statement }) => statement.includes('SET invitation.delivery_status'));
  assert.equal(deliveryUpdate.values.status, 'failed');
  assert.equal(JSON.stringify(log.calls).includes('private SMTP response'), false);
});

test('ambiguous SMTP timeout is recorded as unknown and never returned with its action token', async () => {
  const { service, log } = invitationFixture(issueQuery(), {
    async deliverEmail() { throw Object.assign(new Error('private timeout detail'), { code: 'ETIMEDOUT' }); }
  });
  assert.deepEqual(await service.issueInvitation(7, 19), { status: 'delivery_status_unknown', email: 'recipient@example.edu' });
  const deliveryUpdate = log.calls.find(({ statement }) => statement.includes('SET invitation.delivery_status'));
  assert.equal(deliveryUpdate.values.status, 'unknown');
  assert.equal(JSON.stringify(log.calls).includes('private timeout detail'), false);
});

test('successful SMTP with an uncertain status write returns unknown, not sent', async () => {
  const baseQuery = issueQuery();
  const { service, log } = invitationFixture((call) => {
    if (call.statement.includes('SET invitation.delivery_status')) {
      throw new Error('private status persistence detail');
    }
    return baseQuery(call);
  });
  assert.deepEqual(await service.issueInvitation(7, 19), { status: 'delivery_status_unknown', email: 'recipient@example.edu' });
  assert.equal(JSON.stringify(log.calls).includes('private status persistence detail'), false);
});

test('bulk invitations return a pending snapshot after the bounded wait while four workers continue safely', async () => {
  assert.equal(BULK_DELIVERY_RESPONSE_WAIT_MS, 20_000);
  const accounts = new Map(Array.from({ length: 6 }, (_, index) => {
    const userId = 19 + index;
    return [userId, {
      id: userId,
      email: `student-${userId}@example.edu`,
      role: 'student',
      is_active: true,
      invitation_required: true
    }];
  }));
  const tokens = Array.from({ length: 6 }, (_, index) => String.fromCharCode(97 + index).repeat(43));
  const statusAttempts = [];
  let nextInvitationId = 100;
  let nextToken = 0;
  let releaseFirstWave;
  let markFourStarted;
  let markFiveFinished;
  let markFiveStatusUpdates;
  const deliveryGate = new Promise((resolve) => { releaseFirstWave = resolve; });
  const fourStarted = new Promise((resolve) => { markFourStarted = resolve; });
  const fiveFinished = new Promise((resolve) => { markFiveFinished = resolve; });
  const fiveStatusUpdates = new Promise((resolve) => { markFiveStatusUpdates = resolve; });
  let startedCount = 0;
  let finishedCount = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const fixture = invitationFixture(({ statement, values }) => {
    if (statement.includes("role = 'database_admin'")) return { recordset: [{ id: 7 }] };
    if (statement.includes('SELECT COUNT(*) AS send_count')) return { recordset: [{ send_count: 0 }] };
    if (statement.includes('FROM users WHERE id = @userId FOR UPDATE')) {
      return { recordset: accounts.has(values.userId) ? [{ ...accounts.get(values.userId) }] : [] };
    }
    if (statement.includes('SELECT invitation.id FROM account_setup_tokens AS invitation')) {
      return { recordset: values.userId === 23 ? [] : [{ id: values.invitationId }] };
    }
    if (statement.includes('cooldown_active')) return { recordset: [] };
    if (statement.startsWith('UPDATE account_setup_tokens SET revoked_at')) return { affectedRows: 1 };
    if (statement.includes('INSERT INTO account_setup_tokens')) return { insertId: nextInvitationId++ };
    if (statement.includes('INSERT INTO audit_logs')) return { affectedRows: 1 };
    if (statement.includes('SET invitation.delivery_status')) {
      statusAttempts.push({ invitationId: values.invitationId, status: values.status });
      if (values.invitationId === 101 && values.status === 'sent') {
        throw new Error('synthetic status persistence failure');
      }
      if (statusAttempts.length === 5) markFiveStatusUpdates();
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected bulk invitation query: ${statement}`);
  }, {
    createToken: () => tokens[nextToken++],
    bulkResponseWaitMs: 20,
    async deliverEmail(_smtp, message) {
      startedCount += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (startedCount === 4) markFourStarted();
      try {
        if (Number(message.to.match(/student-(\d+)/)?.[1]) <= 22) {
          await deliveryGate;
        }
        if (message.to === 'student-19@example.edu') {
          throw Object.assign(new Error('synthetic SMTP timeout'), { code: 'ETIMEDOUT' });
        }
        if (message.to === 'student-21@example.edu') {
          throw Object.assign(new Error('synthetic SMTP rejection'), { responseCode: 550 });
        }
      } finally {
        concurrent -= 1;
        finishedCount += 1;
        if (finishedCount === 5) markFiveFinished();
      }
    }
  });

  const delivery = fixture.service.issueBulkInvitations(7, Array.from({ length: 6 }, (_, index) => {
    const userId = 19 + index;
    return {
    userId, requiredRole: 'student', rowNumber: index + 2, studentNo: `SYN-${userId}`
    };
  }));
  await fourStarted;
  assert.equal(fixture.log.commits, 1, 'account invitation records commit before SMTP delivery begins');
  assert.equal(fixture.log.rollbacks, 0);
  const results = await delivery;
  assert.deepEqual(results.map(({ userId, status }) => [userId, status]), Array.from({ length: 6 }, (_, index) => [19 + index, 'delivery_pending']));
  assert.equal(startedCount, 4, 'the request returns while the initial mail wave is still pending');
  assert.equal(maxConcurrent, 4, 'bulk delivery never exceeds four concurrent SMTP calls');
  assert.equal(statusAttempts.length, 0);
  assert.ok(tokens.every((candidate) => !JSON.stringify(results).includes(candidate)));
  assert.ok(tokens.every((candidate) => !JSON.stringify(results).includes(hashActionToken(candidate))),
    'the public snapshot does not expose the prepared token hash either');

  releaseFirstWave();
  await Promise.all([fiveFinished, fiveStatusUpdates]);
  assert.equal(maxConcurrent, 4);
  assert.equal(startedCount, 5, 'the stale queued invitation is skipped before SMTP while the final queued invitation continues');
  assert.deepEqual(statusAttempts.sort((left, right) => left.invitationId - right.invitationId), [
    { invitationId: 100, status: 'unknown' },
    { invitationId: 101, status: 'sent' },
    { invitationId: 102, status: 'failed' },
    { invitationId: 103, status: 'sent' },
    { invitationId: 105, status: 'sent' }
  ]);
  assert.equal(fixture.log.calls.filter(({ statement }) => statement.includes('INSERT INTO account_setup_tokens')).length, 6);
  assert.equal(fixture.log.calls.filter(({ statement }) => statement.includes('SELECT invitation.id FROM account_setup_tokens AS invitation')).length, 6,
    'each queued item is rechecked for current token and account state before sending');
  assert.equal(fixture.log.calls.some(({ statement }) => /INSERT INTO users|UPDATE students/.test(statement)), false,
    'invitation delivery does not create or relink student accounts');
  assert.equal(JSON.stringify(results).includes('synthetic SMTP timeout'), false);
  assert.equal(JSON.stringify(results).includes('synthetic SMTP rejection'), false);
  assert.equal(JSON.stringify(results).includes('synthetic status persistence failure'), false);
});

test('invitation revocation locks the pending account and records an audit event', async () => {
  const fixture = invitationFixture(({ statement }) => {
    if (statement.includes("role = 'database_admin'")) return { recordset: [{ id: 7 }] };
    if (statement.includes('SELECT id, is_active, invitation_required FROM users')) {
      return { recordset: [{ id: 19, is_active: true, invitation_required: true }] };
    }
    if (statement.startsWith('UPDATE account_setup_tokens SET revoked_at') || statement.includes("'account.invitation_revoked'")) {
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected revocation query: ${statement}`);
  });
  assert.equal(await fixture.service.revokeInvitation(7, 19), 'revoked');
  const userLock = fixture.log.calls.findIndex(({ statement }) => statement.includes('FROM users WHERE id = @userId FOR UPDATE'));
  const tokenRevoke = fixture.log.calls.findIndex(({ statement }) => statement.startsWith('UPDATE account_setup_tokens SET revoked_at'));
  assert.ok(userLock >= 0 && tokenRevoke > userLock);
  assert.ok(fixture.log.calls.some(({ statement }) => statement.includes("'account.invitation_revoked'")));
  assert.equal(fixture.log.commits, 1);
});

test('acceptance rejects an email-changed link and does not update the account password', async () => {
  const fixture = invitationFixture(({ statement }) => {
    if (statement.includes('SELECT user_id FROM account_setup_tokens WHERE id = @invitationId')) return { recordset: [{ user_id: 19 }] };
    if (statement.includes('SELECT invitation.id')) return { recordset: [{ id: 32 }] };
    if (statement.includes('SELECT id, email, is_active, invitation_required FROM users')) {
      return { recordset: [{ id: 19, email: 'edited@example.edu', is_active: true, invitation_required: true }] };
    }
    if (statement.includes('SELECT id, token_hash, email_snapshot')) {
      return { recordset: [{ id: 32, token_hash: hashActionToken(token), email_snapshot: 'recipient@example.edu', is_expired: 0 }] };
    }
    if (statement.startsWith('UPDATE account_setup_tokens SET revoked_at')) return { affectedRows: 1 };
    throw new Error(`Unexpected email-change acceptance query: ${statement}`);
  });
  assert.equal(await fixture.service.acceptInvitation('32', token, password), 'invalid_token');
  assert.equal(fixture.log.calls.some(({ statement }) => statement.startsWith('UPDATE users SET password_hash')), false);
  assert.ok(fixture.log.calls.some(({ statement }) => statement.startsWith('UPDATE account_setup_tokens SET revoked_at')));
});

test('a link that expires between lookup and its locked acceptance is revoked without changing the user', async () => {
  const fixture = invitationFixture(({ statement }) => {
    if (statement.includes('SELECT user_id FROM account_setup_tokens WHERE id = @invitationId')) return { recordset: [{ user_id: 19 }] };
    if (statement.includes('SELECT invitation.id')) return { recordset: [{ id: 32 }] };
    if (statement.includes('SELECT id, email, is_active, invitation_required FROM users')) {
      return { recordset: [{ id: 19, email: 'recipient@example.edu', is_active: true, invitation_required: true }] };
    }
    if (statement.includes('SELECT id, token_hash, email_snapshot')) {
      return { recordset: [{ id: 32, token_hash: hashActionToken(token), email_snapshot: 'recipient@example.edu', is_expired: 1 }] };
    }
    if (statement.startsWith('UPDATE account_setup_tokens SET revoked_at')) return { affectedRows: 1 };
    throw new Error(`Unexpected expired-link query: ${statement}`);
  });
  assert.equal(await fixture.service.acceptInvitation('32', token, password), 'expired');
  assert.equal(fixture.log.calls.some(({ statement }) => statement.startsWith('UPDATE users SET password_hash')), false);
  assert.ok(fixture.log.calls.some(({ statement }) => statement.startsWith('UPDATE account_setup_tokens SET revoked_at')));
});

test('invitation issuance distinguishes per-recipient cooldown from the administrator send-window cap', async () => {
  const cooldown = invitationFixture(issueQuery({ cooldown: 1 }));
  await assert.rejects(cooldown.service.issueInvitation(7, 19), (error) => {
    assert.ok(error instanceof AccountInvitationError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'cooldown');
    return true;
  });
  assert.equal(cooldown.log.rollbacks, 1);
  assert.equal(cooldown.log.calls.some(({ statement }) => statement.includes('INSERT INTO account_setup_tokens')), false);

  const sendWindow = invitationFixture(issueQuery({ sendCount: 100 }));
  await assert.rejects(sendWindow.service.issueInvitation(7, 19), (error) => {
    assert.ok(error instanceof AccountInvitationError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'send_window');
    return true;
  });
  assert.equal(sendWindow.log.calls.some(({ statement }) => statement.includes('SELECT id, email, role, is_active, invitation_required')),
    false, 'the send-window cap is checked before account locks');
  assert.equal(sendWindow.log.calls.some(({ statement }) => statement.includes('INSERT INTO account_setup_tokens')), false);
});

test('inactive or pending administrator actors cannot issue invitations', async () => {
  const { service, log } = invitationFixture(issueQuery({ active: false }));
  await assert.rejects(service.issueInvitation(7, 19), (error) => error instanceof AccountInvitationError && error.status === 403);
  assert.equal(log.rollbacks, 1);
  assert.equal(log.calls.some(({ statement }) => statement.includes('INSERT INTO account_setup_tokens')), false);
});

test('unknown invitation tokens are rejected by their hash before bcrypt or any token mutation', async () => {
  let passwordHashCalls = 0;
  const unknownToken = 'b'.repeat(43);
  const fixture = invitationFixture(({ statement }) => {
    if (statement.includes('SELECT user_id FROM account_setup_tokens WHERE id = @invitationId')) return { recordset: [{ user_id: 19 }] };
    if (statement.includes('SELECT invitation.id')) return { recordset: [] };
    throw new Error(`Unexpected invitation query: ${statement}`);
  }, {
    async hashPassword() { passwordHashCalls += 1; return 'unused-hash'; }
  });
  assert.equal(await fixture.service.acceptInvitation('32', unknownToken, password), 'invalid_token');
  assert.equal(passwordHashCalls, 0);
  assert.equal(fixture.log.begins, 0);
  assert.equal(fixture.log.calls.some(({ statement }) => /UPDATE|INSERT/.test(statement)), false);
});

test('acceptance locks the pending user before its invitation, consumes tokens, and leaves role and active status intact', async () => {
  const userRow = { id: 19, email: 'recipient@example.edu', is_active: true, invitation_required: true };
  const tokenRow = { id: 32, token_hash: hashActionToken(token), email_snapshot: userRow.email, is_expired: 0, consumed_at: null, revoked_at: null };
  let passwordHashCalls = 0;
  const fixture = invitationFixture(({ statement }) => {
    if (statement.includes('SELECT user_id FROM account_setup_tokens WHERE id = @invitationId')) return { recordset: [{ user_id: 19 }] };
    if (statement.includes('SELECT invitation.id')) return { recordset: [{ id: 32 }] };
    if (statement.includes('SELECT id, email, is_active, invitation_required FROM users')) return { recordset: [{ ...userRow }] };
    if (statement.includes('SELECT id, token_hash, email_snapshot')) return { recordset: [{ ...tokenRow }] };
    if (statement.startsWith('UPDATE users SET password_hash')) return { affectedRows: 1 };
    if (statement.startsWith('UPDATE account_setup_tokens') || statement.startsWith('UPDATE two_factor_codes')
      || statement.startsWith('UPDATE password_reset_tokens') || statement.startsWith('UPDATE pending_email_changes')
      || statement.includes('INSERT INTO audit_logs')) return { affectedRows: 1 };
    throw new Error(`Unexpected invitation query: ${statement}`);
  }, {
    async hashPassword(value, rounds) {
      passwordHashCalls += 1;
      assert.equal(value, password);
      assert.equal(rounds, 12);
      return 'new-bcrypt-hash';
    }
  });

  assert.equal(await fixture.service.acceptInvitation('32', token, password), 'accepted');
  assert.equal(passwordHashCalls, 1);
  assert.equal(fixture.log.commits, 1);
  const lockedUserIndex = fixture.log.calls.findIndex(({ statement }) => statement.includes('FROM users') && statement.includes('FOR UPDATE'));
  const lockedTokenIndex = fixture.log.calls.findIndex(({ statement }) => statement.includes('FROM account_setup_tokens WHERE id = @invitationId AND user_id = @userId FOR UPDATE'));
  assert.ok(lockedUserIndex >= 0 && lockedUserIndex < lockedTokenIndex);
  const update = fixture.log.calls.find(({ statement }) => statement.startsWith('UPDATE users SET password_hash'));
  assert.equal(update.values.passwordHash, 'new-bcrypt-hash');
  assert.match(update.statement, /invitation_required = 0/);
  assert.doesNotMatch(update.statement.split('WHERE')[0], /role\s*=|is_active\s*=|student_id\s*=/i);
  assert.equal(JSON.stringify(fixture.log.calls).includes(token), false);
  assert.equal(JSON.stringify(fixture.log.calls).includes(password), false);
  assert.ok(fixture.log.calls.some(({ statement }) => statement.includes('account.invitation_accepted')));
});

test('acceptance retries a MariaDB read conflict in a fresh transaction and rechecks the consumed link', async () => {
  const userRow = { id: 19, email: 'recipient@example.edu', is_active: true, invitation_required: true };
  const tokenRow = { id: 32, token_hash: hashActionToken(token), email_snapshot: userRow.email,
    is_expired: 0, consumed_at: null, revoked_at: null };
  let lockedUserReads = 0;
  const fixture = invitationFixture(({ statement }) => {
    if (statement.includes('SELECT user_id FROM account_setup_tokens WHERE id = @invitationId')) {
      return { recordset: [{ user_id: 19 }] };
    }
    if (statement.includes('SELECT invitation.id')) return { recordset: [{ id: 32 }] };
    if (statement.includes('SELECT id, email, is_active, invitation_required FROM users')) {
      lockedUserReads += 1;
      if (lockedUserReads === 1) {
        userRow.invitation_required = false;
        userRow.password_hash = 'concurrent-acceptance-hash';
        tokenRow.consumed_at = '2026-10-21 04:00:00.000';
        throw Object.assign(new Error('Record has changed since last read in table users'), {
          code: 'ER_CHECKREAD', errno: 1020
        });
      }
      return { recordset: [{ ...userRow }] };
    }
    if (statement.includes('SELECT id, token_hash, email_snapshot')) return { recordset: [{ ...tokenRow }] };
    throw new Error(`Unexpected retry acceptance query: ${statement}`);
  });

  assert.equal(await fixture.service.acceptInvitation('32', token, password), 'invalid_token');
  assert.equal(fixture.log.begins, 2, 'the retry starts a fresh transaction');
  assert.equal(fixture.log.rollbacks, 1, 'the failed transaction is rolled back before retry');
  assert.equal(fixture.log.commits, 1, 'the rechecked losing attempt commits without changing account data');
  assert.equal(lockedUserReads, 2);
  assert.equal(fixture.log.calls.some(({ statement }) => statement.startsWith('UPDATE users SET password_hash')), false,
    'the retry cannot overwrite a concurrently completed account setup');
});

test('acceptance does not retry unexpected transaction errors', async () => {
  const fixture = invitationFixture(({ statement }) => {
    if (statement.includes('SELECT user_id FROM account_setup_tokens WHERE id = @invitationId')) {
      return { recordset: [{ user_id: 19 }] };
    }
    if (statement.includes('SELECT invitation.id')) return { recordset: [{ id: 32 }] };
    if (statement.includes('SELECT id, email, is_active, invitation_required FROM users')) {
      throw Object.assign(new Error('synthetic network disconnect'), { code: 'ECONNRESET' });
    }
    throw new Error(`Unexpected network failure query: ${statement}`);
  });

  await assert.rejects(fixture.service.acceptInvitation('32', token, password), (error) => error.code === 'ECONNRESET');
  assert.equal(fixture.log.begins, 1);
  assert.equal(fixture.log.rollbacks, 1);
  assert.equal(fixture.log.commits, 0);
});

test('acceptance stops after its bounded retry limit and returns the final retryable error', async () => {
  let lockedUserReads = 0;
  const fixture = invitationFixture(({ statement }) => {
    if (statement.includes('SELECT user_id FROM account_setup_tokens WHERE id = @invitationId')) {
      return { recordset: [{ user_id: 19 }] };
    }
    if (statement.includes('SELECT invitation.id')) return { recordset: [{ id: 32 }] };
    if (statement.includes('SELECT id, email, is_active, invitation_required FROM users')) {
      lockedUserReads += 1;
      throw Object.assign(new Error(`serialization conflict ${lockedUserReads}`), { code: 'ER_CHECKREAD', errno: 1020 });
    }
    throw new Error(`Unexpected retry exhaustion query: ${statement}`);
  });

  await assert.rejects(fixture.service.acceptInvitation('32', token, password), (error) => {
    assert.equal(error.code, 'ER_CHECKREAD');
    assert.equal(error.message, 'serialization conflict 3');
    return true;
  });
  assert.equal(lockedUserReads, 3, 'two retries follow the initial transaction attempt');
  assert.equal(fixture.log.begins, 3);
  assert.equal(fixture.log.rollbacks, 3);
  assert.equal(fixture.log.commits, 0);
  assert.equal(fixture.log.calls.some(({ statement }) => statement.startsWith('UPDATE users SET password_hash')), false);
});

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

test('public setup links render private headers and reject invalid CSRF before accepting a password', async () => {
  const calls = { inspect: 0, accept: 0 };
  const app = express();
  app.set('views', require('node:path').resolve(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: 'account-setup-route-test-secret', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => { req.session.csrfToken = 'setup-test-csrf'; next(); });
  app.use('/account/setup', createAccountInvitationRouter({ accountInvitationService: {
    async inspectInvitation() { calls.inspect += 1; return { emailHint: 'r•••t@example.edu', expiresAt: '2026-10-21 04:00:00' }; },
    async acceptInvitation() { calls.accept += 1; return 'accepted'; }
  } }));

  await withServer(app, async (origin) => {
    const page = await fetch(`${origin}/account/setup?requestId=32&token=${token}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store, private, max-age=0');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(html, /r•••t@example\.edu/);
    assert.match(html, /type="password"/);
    assert.doesNotMatch(html, /name="password"[^>]*value=/);

    const rejected = await fetch(`${origin}/account/setup`, {
      method: 'POST',
      headers: { cookie: page.headers.get('set-cookie').split(';', 1)[0], 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'wrong', requestId: '32', token, password, confirmPassword: password })
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('cache-control'), 'no-store, private, max-age=0');
    assert.equal(calls.accept, 0);
    assert.equal(calls.inspect, 1);
  });
});

test('an accepted setup link redirects to sign-in without creating an authenticated session', async () => {
  const app = express();
  app.set('views', require('node:path').resolve(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: 'account-setup-accepted-route-test-secret', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => { req.session.csrfToken = 'setup-accepted-csrf'; next(); });
  app.use('/account/setup', createAccountInvitationRouter({ accountInvitationService: {
    async inspectInvitation() { return { emailHint: 'r•••t@example.edu', expiresAt: '2026-10-21 04:00:00' }; },
    async acceptInvitation() { return 'accepted'; }
  } }));
  await withServer(app, async (origin) => {
    const page = await fetch(`${origin}/account/setup?requestId=32&token=${token}`);
    const cookie = page.headers.get('set-cookie').split(';', 1)[0];
    const response = await fetch(`${origin}/account/setup`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'setup-accepted-csrf', requestId: '32', token, password, confirmPassword: password })
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login?notice=accountSetup');
    assert.equal(response.headers.get('cache-control'), 'no-store, private, max-age=0');
    assert.equal(response.headers.get('set-cookie'), null, 'acceptance does not create an authenticated browser session');
  });
});

test('mail helper uses a fixed app origin and accepts no external request host', () => {
  const fixture = invitationFixture(issueQuery(), { appBaseUrl: 'https://school.example.edu' });
  assert.ok(fixture.service);
  assert.throws(() => createAccountInvitationService({ appBaseUrl: 'https://evil.example/path' }), /configured application origin/);
});
