const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { readHidden } = require('../scripts/bootstrap-admin');
const { verifyPassword } = require('../src/routes');
const {
  isDevelopmentPasswordLoginEnabled,
  isDemoPasswordOnlyLoginEnabled,
  isDemoPasswordOnlyEmailAllowed,
  createAuthFingerprint,
  hasMatchingAuthFingerprint,
  createRequireAuth
} = require('../src/middleware/auth');
const { parseDemoPasswordOnlyLogin, parseDemoPasswordOnlyEmails } = require('../src/config/environment');
const { getListenHost } = require('../src/config/server');
const twoFactor = require('../src/services/twoFactorService');

test('password-only authentication requires both development gate settings', () => {
  assert.equal(isDevelopmentPasswordLoginEnabled({ nodeEnv: 'development', devPasswordOnlyLogin: true }), true);
  assert.equal(isDevelopmentPasswordLoginEnabled({ nodeEnv: 'development', devPasswordOnlyLogin: false }), false);
  assert.equal(isDevelopmentPasswordLoginEnabled({ nodeEnv: 'production', devPasswordOnlyLogin: true }), false);
  assert.equal(isDevelopmentPasswordLoginEnabled({ nodeEnv: 'test', devPasswordOnlyLogin: true }), false);
});

test('production demo password mode requires an exact enabled flag and a fully valid allowlist', () => {
  const enabled = {
    nodeEnv: 'production',
    demoPasswordOnlyLogin: true,
    demoPasswordOnlyEmails: ['demo@example.edu', 'staff@example.edu']
  };
  assert.equal(isDemoPasswordOnlyLoginEnabled(enabled), true);
  assert.equal(isDemoPasswordOnlyEmailAllowed(enabled, 'DEMO@example.edu'), true);
  assert.equal(isDemoPasswordOnlyEmailAllowed(enabled, 'other@example.edu'), false);
  assert.equal(isDemoPasswordOnlyLoginEnabled({ ...enabled, nodeEnv: 'test' }), false);
  assert.equal(isDemoPasswordOnlyLoginEnabled({ ...enabled, demoPasswordOnlyLogin: false }), false);
  assert.equal(isDemoPasswordOnlyLoginEnabled({ ...enabled, demoPasswordOnlyEmails: [] }), false);
  assert.equal(isDemoPasswordOnlyLoginEnabled({ ...enabled, demoPasswordOnlyEmails: ['demo@example.edu', 'invalid'] }), false);
  assert.equal(parseDemoPasswordOnlyLogin('true'), true);
  assert.equal(parseDemoPasswordOnlyLogin('false'), false);
  assert.equal(parseDemoPasswordOnlyLogin('True'), false);
  assert.equal(parseDemoPasswordOnlyLogin(undefined), false);
  assert.deepEqual(parseDemoPasswordOnlyEmails(undefined), []);
  assert.deepEqual(parseDemoPasswordOnlyEmails(''), []);
  assert.deepEqual(parseDemoPasswordOnlyEmails('DEMO@example.edu, staff@example.edu, demo@example.edu'), [
    'demo@example.edu', 'staff@example.edu'
  ]);
  assert.deepEqual(parseDemoPasswordOnlyEmails('demo@example.edu,not-an-email'), []);
  assert.deepEqual(parseDemoPasswordOnlyEmails('demo@example.edu,'), []);
});

test('server binds password-only development mode to loopback only', () => {
  assert.equal(getListenHost({ nodeEnv: 'development', devPasswordOnlyLogin: true }), '127.0.0.1');
  assert.equal(getListenHost({ nodeEnv: 'development', devPasswordOnlyLogin: false }), undefined);
  assert.equal(getListenHost({ nodeEnv: 'production', devPasswordOnlyLogin: true }), undefined);
  assert.equal(getListenHost({ nodeEnv: 'test', devPasswordOnlyLogin: true }), undefined);
});

test('auth fingerprints change with role, password hash, or account update timestamp', () => {
  const environment = { sessionSecret: 'auth-fingerprint-test-secret' };
  const user = { role: 'registrar', password_hash: 'bcrypt-hash-a', updated_at_fingerprint: '2026-09-23T01:02:03.0000000' };
  const fingerprint = createAuthFingerprint(user, environment);

  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(hasMatchingAuthFingerprint(createAuthFingerprint({ ...user }, environment), fingerprint), true);
  assert.equal(hasMatchingAuthFingerprint(createAuthFingerprint({ ...user, role: 'database_admin' }, environment), fingerprint), false);
  assert.equal(hasMatchingAuthFingerprint(createAuthFingerprint({ ...user, password_hash: 'bcrypt-hash-b' }, environment), fingerprint), false);
  assert.equal(hasMatchingAuthFingerprint(createAuthFingerprint({ ...user, updated_at_fingerprint: '2026-09-23T01:02:04.0000000' }, environment), fingerprint), false);
  assert.equal(createAuthFingerprint({ role: 'registrar' }, environment), null);
  assert.equal(hasMatchingAuthFingerprint(null, fingerprint), false);
});

test('temporary-password gate checks current database state and blocks direct protected routes until password change', async () => {
  const environment = {
    nodeEnv: 'production', devPasswordOnlyLogin: false, demoPasswordOnlyLogin: true,
    demoPasswordOnlyEmails: ['student@example.edu'], sessionSecret: 'mandatory-password-change-test-secret'
  };
  const user = {
    id: 12, email: 'student@example.edu', role: 'student', is_active: true,
    password_hash: 'temporary-bcrypt-hash', must_change_password: true,
    auth_session_version: 'session-v1', updated_at_fingerprint: '2026-09-28T01:02:03.0000000'
  };
  const requireAuth = createRequireAuth({
    environment,
    sql: { Int: 'Int' },
    getPool: async () => ({
      request() {
        return {
          input() { return this; },
          async query(statement) {
            assert.match(statement, /must_change_password/);
            return { recordset: [{ ...user }] };
          }
        };
      }
    })
  });
  async function request(url, method = 'GET', authLevel = 'email_2fa') {
    const res = {
      headers: {}, locals: {},
      set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
      redirect(status, location) {
        this.statusCode = location === undefined ? 302 : status;
        this.location = location === undefined ? status : location;
        return this;
      },
      clearCookie() {}
    };
    const req = {
      originalUrl: url, method, session: {
        userId: user.id, authLevel, authFingerprint: createAuthFingerprint(user, environment),
        authSessionVersion: 'session-v1',
        destroy(callback) { callback(null); }
      }
    };
    let continued = false;
    await requireAuth(req, res, () => { continued = true; });
    return { req, res, continued };
  }

  for (const path of ['/student', '/documents/students/999', '/records/intake']) {
    const result = await request(path);
    assert.equal(result.continued, false, path + ' must not reach its protected route');
    assert.equal(result.res.statusCode, 303);
    assert.equal(result.res.location, '/account/password/required');
  }
  const requiredPage = await request('/account/password/required');
  assert.equal(requiredPage.continued, true);
  assert.equal(requiredPage.res.headers['cache-control'], 'private, no-store');
  const passwordPost = await request('/account/password', 'POST');
  assert.equal(passwordPost.continued, true);
  const logout = await request('/logout', 'POST');
  assert.equal(logout.continued, true);

  const demoRolePage = await request('/student', 'GET', 'password_only_demo');
  assert.equal(demoRolePage.continued, false);
  assert.equal(demoRolePage.res.location, '/account/password/required');
  const demoPasswordChangePage = await request('/account/password/required', 'GET', 'password_only_demo');
  assert.equal(demoPasswordChangePage.continued, true);

  const passwordOnlySession = await request('/account/password/required', 'GET', 'password_only_dev');
  assert.equal(passwordOnlySession.continued, false);
  assert.equal(passwordOnlySession.res.location, '/login');
});

test('demo password sessions are destroyed when the feature is disabled or their email leaves the allowlist', async () => {
  const environment = {
    nodeEnv: 'production', demoPasswordOnlyLogin: true,
    demoPasswordOnlyEmails: ['student@example.edu'], sessionSecret: 'demo-session-revocation-test-secret'
  };
  const user = {
    id: 25, email: 'student@example.edu', role: 'student', is_active: true,
    password_hash: 'demo-bcrypt-hash', must_change_password: false,
    auth_session_version: 'session-v1', updated_at_fingerprint: '2026-09-28T01:02:03.0000000'
  };
  const requireAuth = createRequireAuth({
    environment,
    sql: { Int: 'Int' },
    getPool: async () => ({
      request() {
        return {
          input() { return this; },
          async query() { return { recordset: [{ ...user }] }; }
        };
      }
    })
  });

  async function checkDemoSession() {
    let destroyed = false;
    const res = {
      headers: {}, locals: {},
      set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
      redirect(status, location) {
        this.statusCode = location === undefined ? 302 : status;
        this.location = location === undefined ? status : location;
        return this;
      },
      clearCookie() {},
      get destroyed() { return destroyed; }
    };
    const req = {
      originalUrl: '/student', method: 'GET', session: {
        userId: user.id, authLevel: 'password_only_demo', authFingerprint: createAuthFingerprint(user, environment),
        authSessionVersion: 'session-v1', destroy(callback) { destroyed = true; callback(null); }
      }
    };
    let continued = false;
    await requireAuth(req, res, () => { continued = true; });
    return { res, continued };
  }

  assert.equal((await checkDemoSession()).continued, true);
  environment.demoPasswordOnlyEmails = [];
  const removedAddress = await checkDemoSession();
  assert.equal(removedAddress.continued, false);
  assert.equal(removedAddress.res.location, '/login');
  assert.equal(removedAddress.res.destroyed, true);

  environment.demoPasswordOnlyEmails = ['student@example.edu'];
  assert.equal((await checkDemoSession()).continued, true);
  environment.demoPasswordOnlyLogin = false;
  const disabled = await checkDemoSession();
  assert.equal(disabled.continued, false);
  assert.equal(disabled.res.location, '/login');
  assert.equal(disabled.res.destroyed, true);
});

test('missing and inactive accounts each perform one dummy bcrypt comparison', async () => {
  const comparedHashes = [];
  const comparePassword = async (password, hash) => {
    assert.equal(password, 'entered-password');
    comparedHashes.push(hash);
    return true;
  };

  assert.equal(await verifyPassword(null, 'entered-password', comparePassword), false);
  assert.equal(await verifyPassword({ is_active: false, password_hash: 'inactive-account-hash' }, 'entered-password', comparePassword), false);
  assert.equal(await verifyPassword({ is_active: true, password_hash: 'active-account-hash' }, 'entered-password', comparePassword), true);
  assert.equal(comparedHashes.length, 3);
  assert.equal(comparedHashes[0], comparedHashes[1]);
  assert.match(comparedHashes[0], /^\$2b\$12\$/);
  assert.equal(comparedHashes[2], 'active-account-hash');
});

test('OTP values are six-digit cryptographic values and use a cost-12 bcrypt hash', async () => {
  const code = twoFactor.generateOtp();
  assert.match(code, /^\d{6}$/);

  const hash = await twoFactor.hashOtp('001234');
  assert.match(hash, /^\$2b\$12\$/);
  assert.notEqual(hash, '001234');
  assert.equal(await twoFactor.compareOtp('001234', hash), true);
  assert.equal(await twoFactor.compareOtp('001235', hash), false);
});

test('OTP issuance stores only the code hash and enforces database-backed send limits', async () => {
  const calls = [];
  const sql = { Int: 'Int', NVarChar: (length) => `NVarChar(${length})`, ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' } };
  const result = await twoFactor.issueOtpChallenge({
    getPool: async () => ({
      request: () => ({
        input(name, type, value) { this.values ||= {}; this.values[name] = value; return this; },
        async query(queryText) {
          calls.push({ statement: queryText, values: { ...(this.values || {}) } });
          if (queryText.includes('SELECT send_count')) return { recordset: [{ send_count: 0, window_expired: 1, cooldown_elapsed: 1 }] };
          if (queryText.includes('INSERT INTO two_factor_codes')) return { insertId: 52 };
          return { affectedRows: 1 };
        }
      })
    }),
    sql,
    transactionFactory: (pool) => ({
      async begin() {},
      request() { return pool.request(); },
      async commit() {},
      async rollback() {}
    }),
    userId: 42,
    createCode: () => '004219',
    hash: async (code) => `hash:${code}`
  });

  assert.deepEqual(result, { allowed: true, codeId: 52, code: '004219' });
  assert.equal(calls[0].values.userId, 42);
  const inserted = calls.find(({ statement }) => statement.includes('INSERT INTO two_factor_codes'));
  assert.equal(inserted.values.userId, 42);
  assert.equal(inserted.values.codeHash, 'hash:004219');
  assert.equal(Object.hasOwn(inserted.values, 'code'), false);
  const statement = calls.find(({ statement }) => statement.includes('SELECT send_count')).statement;
  assert.match(statement, /FROM two_factor_auth_limits WHERE user_id = @userId FOR UPDATE/);
  assert.match(statement, /DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL 15 MINUTE\)/);
  assert.match(statement, /DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL 30 SECOND\)/);
});

test('hidden bootstrap password input pauses stdin and restores terminal mode', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawModeChanges = [];
  input.setRawMode = (enabled) => {
    input.isRaw = enabled;
    input.rawModeChanges.push(enabled);
  };
  let outputText = '';
  const output = new Writable({
    write(chunk, encoding, callback) {
      outputText += chunk.toString();
      callback();
    }
  });
  output.isTTY = true;

  const pendingPassword = readHidden('Password: ', { input, output });
  input.write('invalid-password\r');
  assert.equal(await pendingPassword, 'invalid-password');

  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.deepEqual(input.rawModeChanges, [true, false]);
  assert.equal(outputText, 'Password: \n');
  input.destroy();
});
