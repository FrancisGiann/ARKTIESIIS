const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const express = require('express');
const { createApp } = require('../src/app');
const { createAccountRouter } = require('../src/routes/account');
const {
  normalizeEmail,
  validatePassword,
  createActionToken,
  hashActionToken,
  createAccountService
} = require('../src/services/accountService');

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function cookieFrom(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

function csrfFromHtml(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'expected a CSRF token');
  return match[1];
}

async function postForm(baseUrl, path, cookie, values) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values)
  });
}

function testEnvironment(overrides = {}) {
  return {
    nodeEnv: 'development', devPasswordOnlyLogin: true,
    sessionSecret: 'account-feature-test-session-secret', appBaseUrl: 'http://app.example.test',
    smtp: { host: 'smtp.test.invalid', port: 587, secure: false, user: 'test', pass: 'secret', from: 'ARKTIESIIS <test@example.edu>' },
    ...overrides
  };
}

function createAuthDatabase(users) {
  const getPool = async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          if (statement.includes('WHERE email = @email')) {
            const user = users.find((candidate) => candidate.email === values.email);
            return { recordset: user ? [{ ...user }] : [] };
          }
          if (statement.includes('WHERE id = @userId')) {
            const user = users.find((candidate) => candidate.id === values.userId);
            return { recordset: user ? [{ ...user }] : [] };
          }
          throw new Error(`Unexpected auth query: ${statement}`);
        }
      };
    }
  });
  return getPool;
}

async function login(baseUrl, email) {
  const page = await fetch(`${baseUrl}/login`);
  const cookie = cookieFrom(page);
  const token = csrfFromHtml(await page.text());
  const response = await postForm(baseUrl, '/login', cookie, {
    _csrf: token, email, password: 'Correct-Horse-Battery-12'
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

test('account input validation normalizes emails and applies UTF-8 password limits', () => {
  assert.equal(normalizeEmail('  Person@Example.EDU '), 'person@example.edu');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(validatePassword('correct-horse-12'), 'correct-horse-12');
  assert.equal(validatePassword('short'), null);
  assert.equal(validatePassword('é'.repeat(37)), null);
  assert.match(createActionToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.match(hashActionToken('random-secret'), /^[a-f0-9]{64}$/);
  assert.notEqual(hashActionToken('random-secret'), 'random-secret');
});

test('all five roles share the same account page and cannot edit school profile details there', async () => {
  const roles = ['database_admin', 'registrar', 'teacher', 'finance', 'student'];
  const users = roles.map((role, index) => ({
    id: index + 1, email: `${role}@example.edu`, role,
    password_hash: bcrypt.hashSync('Correct-Horse-Battery-12', 4),
    is_active: true, auth_session_version: 'session-v1', updated_at_fingerprint: ''
  }));
  const accountService = {
    async getAccountDetails(userId) {
      const user = users.find((candidate) => candidate.id === userId);
      return { email: user.email, role: user.role, display_name: user.role === 'student' ? null : `${user.role} user`, pending_email: null };
    }
  };
  const app = createApp({
    databasePool: createAuthDatabase(users), environment: testEnvironment(), accountService
  });

  await withServer(app, async (baseUrl) => {
    for (const user of users) {
      const cookie = await login(baseUrl, user.email);
      const response = await fetch(`${baseUrl}/account`, { headers: { cookie } });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, new RegExp(user.email));
      assert.match(html, new RegExp(user.role.replaceAll('_', ' '), 'i'));
      assert.match(html, /href="\/account"[^>]*aria-current="page"/);
      assert.match(html, /action="\/account\/password"/);
      assert.match(html, /action="\/account\/email\/request"/);
      assert.match(html, /action="\/account\/sessions\/revoke-others"/);
      assert.doesNotMatch(html, /action="\/records\/students\/[^\"]+"/);
      if (user.role === 'student') assert.doesNotMatch(html, /student user/);
    }
  });
});

test('email confirmation works without an authenticated session and still requires its one-time token plus CSRF', async () => {
  const token = 't'.repeat(43);
  const confirmed = [];
  const accountService = {
    async inspectEmailChange(requestId, suppliedToken) {
      return requestId === '31' && suppliedToken === token ? { new_email: 'new@example.edu' } : null;
    },
    async confirmEmailChange(requestId, suppliedToken) {
      confirmed.push([requestId, suppliedToken]);
      return requestId === '31' && suppliedToken === token ? 'changed' : 'invalid_token';
    }
  };
  const app = createApp({
    databasePool: createAuthDatabase([]), environment: testEnvironment(), accountService
  });

  await withServer(app, async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/account/email/confirm?requestId=31&token=${'x'.repeat(43)}`, { redirect: 'manual' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(invalid.headers.get('cache-control'), 'no-store');

    const page = await fetch(`${baseUrl}/account/email/confirm?requestId=31&token=${token}`, { redirect: 'manual' });
    const html = await page.text();
    const cookie = cookieFrom(page);
    const csrf = csrfFromHtml(html);
    assert.equal(page.status, 200);
    assert.match(html, /new@example\.edu/);

    const rejected = await postForm(baseUrl, '/account/email/confirm', cookie, {
      _csrf: 'invalid-csrf', requestId: '31', token
    });
    assert.equal(rejected.status, 403);
    assert.deepEqual(confirmed, []);

    const response = await postForm(baseUrl, '/account/email/confirm', cookie, {
      _csrf: csrf, requestId: '31', token
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login?notice=emailChanged');
    assert.deepEqual(confirmed, [['31', token]]);
  });
});

test('signing out other sessions writes a security audit event with the session rotation', async () => {
  let query = '';
  let inputs = {};
  const service = createAccountService({
    sql: { Int: 'Int' },
    async getPool() {
      return {
        request() {
          inputs = {};
          return {
            input(name, _type, value) { inputs[name] = value; return this; },
            async query(statement) {
              query = statement;
              return { recordset: [{ auth_session_version: 'session-v2' }] };
            }
          };
        }
      };
    }
  });

  assert.equal(await service.rotateOtherSessions(7), 'session-v2');
  assert.equal(inputs.userId, 7);
  assert.match(query, /UPDATE dbo\.users[\s\S]*auth_session_version = NEWID\(\)/);
  assert.match(query, /N'account\.sessions_revoked'/);
  assert.match(query, /"currentSessionRetained":true/);
});

test('signing out other sessions rotates the account version and preserves the current session', async () => {
  const user = {
    id: 7, email: 'registrar@example.edu', role: 'registrar',
    password_hash: bcrypt.hashSync('Correct-Horse-Battery-12', 4),
    is_active: true, auth_session_version: 'session-v1', updated_at_fingerprint: ''
  };
  const getPool = createAuthDatabase([user]);
  const accountService = {
    async getAccountDetails() { return { email: user.email, role: user.role, display_name: null, pending_email: null }; },
    async verifyCurrentPassword() { return true; },
    async rotateOtherSessions() { user.auth_session_version = 'session-v2'; return user.auth_session_version; }
  };
  const app = createApp({ databasePool: getPool, environment: testEnvironment(), accountService });

  await withServer(app, async (baseUrl) => {
    const activeCookie = await login(baseUrl, user.email);
    const otherCookie = await login(baseUrl, user.email);
    const page = await fetch(`${baseUrl}/account`, { headers: { cookie: activeCookie } });
    const response = await postForm(baseUrl, '/account/sessions/revoke-others', activeCookie, {
      _csrf: csrfFromHtml(await page.text()), currentPassword: 'Correct-Horse-Battery-12'
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/account?notice=sessionsRevoked');

    const stillActive = await fetch(`${baseUrl}/account?notice=sessionsRevoked`, { headers: { cookie: activeCookie } });
    assert.equal(stillActive.status, 200);
    assert.match(await stillActive.text(), /Other sessions were signed out/);

    const revoked = await fetch(`${baseUrl}/account`, { headers: { cookie: otherCookie }, redirect: 'manual' });
    assert.equal(revoked.status, 302);
    assert.equal(revoked.headers.get('location'), '/login');
  });
});

test('password recovery uses the same response for found, missing, and unavailable accounts', async () => {
  let result = false;
  const accountService = { async requestPasswordReset() { if (result === 'error') throw new Error('private database detail'); return result; } };
  const app = createApp({
    databasePool: createAuthDatabase([]), environment: testEnvironment(), accountService
  });

  await withServer(app, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/password/forgot`);
    const cookie = cookieFrom(page);
    const csrf = csrfFromHtml(await page.text());
    const responses = [];
    for (const state of [false, true, 'error']) {
      result = state;
      const response = await postForm(baseUrl, '/password/forgot', cookie, { _csrf: csrf, email: 'user@example.edu' });
      responses.push({ status: response.status, body: await response.text() });
    }
    assert.deepEqual(responses.map(({ status }) => status), [200, 200, 200]);
    assert.equal(new Set(responses.map(({ body }) => body)).size, 1);
    assert.match(responses[0].body, /If the account is active, password reset instructions will be sent shortly/);
    assert.doesNotMatch(responses[2].body, /private database detail/);
  });
});

test('forced password mismatch remains on the required-password page and offers logout', async () => {
  let changeCalled = false;
  const accountService = {
    async getAccountDetails() { return { must_change_password: 1 }; },
    async changePassword() { changeCalled = true; return 'changed'; }
  };
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.authUser = { id: 12, mustChangePassword: true };
    req.session = { csrfToken: 'csrf-forced-password' };
    next();
  });
  app.use('/account', createAccountRouter({ accountService, environment: testEnvironment() }));

  await withServer(app, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/account/password/required`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.match(html, /Change your temporary password/);
    assert.match(html, /action="\/logout"/);
    const response = await postForm(baseUrl, '/account/password', 'unused-session-cookie', {
      _csrf: 'csrf-forced-password', currentPassword: 'Temporary-Password-55',
      password: 'New-Secure-Password-88', confirmPassword: 'Different-Password-99'
    });
    const body = await response.text();
    assert.equal(response.status, 400);
    assert.match(body, /Change your temporary password/);
    assert.match(body, /new passwords do not match/i);
    assert.equal(changeCalled, false);
  });
});

test('password change verifies the current password and stores only the bcrypt hash', async () => {
  const calls = [];
  const sql = { Int: 'Int', Char: (length) => `Char(${length})`, NVarChar: (length) => `NVarChar(${length})` };
  const account = { id: 19, email: 'user@example.edu', password_hash: 'old-bcrypt-hash', is_active: true };
  const getPool = async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('SELECT id, email, password_hash, is_active')) return { recordset: [{ ...account }] };
          if (statement.includes('DECLARE @changed BIT')) return { recordset: [{ changed: 1 }] };
          throw new Error('Unexpected account service query');
        }
      };
    }
  });
  const service = createAccountService({
    getPool, sql,
    async hashPassword(password, rounds) { assert.equal(password, 'New-Secure-Password-99'); assert.equal(rounds, 12); return 'new-bcrypt-hash'; },
    async comparePassword(password, hash) { return password === 'Current-Secure-Password-88' && hash === account.password_hash; }
  });

  assert.equal(await service.changePassword(19, 'wrong-password-123', 'New-Secure-Password-99'), 'invalid_current_password');
  assert.equal(calls.length, 1, 'a failed reauthentication must not update account data');
  assert.equal(await service.changePassword(19, 'Current-Secure-Password-88', 'New-Secure-Password-99'), 'changed');
  const mutation = calls[2];
  assert.equal(mutation.values.passwordHash, 'new-bcrypt-hash');
  assert.equal(mutation.values.currentHash, 'old-bcrypt-hash');
  assert.doesNotMatch(mutation.statement, /New-Secure-Password-99|Current-Secure-Password-88/);
  assert.match(mutation.statement, /WHERE id = @userId AND is_active = 1 AND password_hash = @currentHash/);
  assert.match(mutation.statement, /UPDATE dbo\.two_factor_codes/);
  assert.match(mutation.statement, /must_change_password = 0/);
  assert.match(mutation.statement, /INSERT INTO dbo\.audit_logs/);
});

test('password reset clears the forced-change flag without storing a plaintext password', async () => {
  let statement = '';
  let values = {};
  const service = createAccountService({
    sql: { Int: 'Int', Char: (length) => `Char(${length})`, NVarChar: (length) => `NVarChar(${length})` },
    async getPool() {
      return { request() {
        values = {};
        return {
          input(name, _type, value) { values[name] = value; return this; },
          async query(queryText) { statement = queryText; return { recordset: [{ status: 'reset' }] }; }
        };
      } };
    },
    async hashPassword(password, rounds) { assert.equal(password, 'Recovery-Password-77'); assert.equal(rounds, 12); return 'recovery-bcrypt-hash'; }
  });
  assert.equal(await service.resetPasswordWithToken('31', 'x'.repeat(43), 'Recovery-Password-77'), 'reset');
  assert.match(statement, /UPDATE dbo\.users SET password_hash = @passwordHash, must_change_password = 0/);
  assert.equal(values.passwordHash, 'recovery-bcrypt-hash');
  assert.doesNotMatch(statement + JSON.stringify(values), /Recovery-Password-77/);
});

test('email-change request sends both notices but updates the email only in the confirmation transaction', async () => {
  const calls = [];
  const sent = [];
  const sql = { Int: 'Int', Char: (length) => `Char(${length})`, NVarChar: (length) => `NVarChar(${length})` };
  const account = { id: 24, email: 'old@example.edu', password_hash: 'bcrypt-current', is_active: true };
  const getPool = async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('SELECT id, email, password_hash, is_active')) return { recordset: [{ ...account }] };
          if (statement.includes('DECLARE @currentEmail')) return { recordset: [{ status: 'created', request_id: 31, current_email: account.email }] };
          if (statement.includes('SELECT new_email')) return { recordset: [{ new_email: 'new@example.edu' }] };
          if (statement.includes('DECLARE @oldEmail')) return { recordset: [{ status: 'changed' }] };
          throw new Error('Unexpected account service query');
        }
      };
    }
  });
  const service = createAccountService({
    getPool, sql, smtp: { host: 'smtp.example', from: 'no-reply@example.edu' },
    appBaseUrl: 'https://school.example.edu', createToken: () => 'x'.repeat(43),
    async comparePassword(password, hash) { return password === 'Current-Secure-Password-88' && hash === account.password_hash; },
    async deliverEmail(_smtp, message) { sent.push(message); }
  });

  assert.equal(await service.requestEmailChange(24, 'Current-Secure-Password-88', 'New@Example.edu'), 'created');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, 'old@example.edu');
  assert.match(sent[0].text, /will not take effect until the new address is confirmed/);
  assert.equal(sent[1].to, 'new@example.edu');
  assert.match(sent[1].text, /https:\/\/school\.example\.edu\/account\/email\/confirm\?/);
  assert.ok(calls[1].values.tokenHash);
  assert.doesNotMatch(sent[1].text, new RegExp(calls[1].values.tokenHash));
  assert.equal(calls.some(({ statement }) => /UPDATE dbo\.users SET email/.test(statement)), false);

  assert.equal((await service.inspectEmailChange('31', 'x'.repeat(43))).new_email, 'new@example.edu');
  assert.equal(await service.confirmEmailChange('31', 'x'.repeat(43)), 'changed');
  assert.match(calls.at(-1).statement, /UPDATE dbo\.users SET email = @newEmail/);
  assert.equal(calls.at(-1).values.tokenHash.length, 64);
});
