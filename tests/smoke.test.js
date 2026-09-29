const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');
const { validateRequiredText } = require('../src/services/documentValidationService');
const { bootstrapAdmin, validateBootstrapInput } = require('../scripts/bootstrap-admin');

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const developmentEnvironment = () => ({
  nodeEnv: 'development',
  devPasswordOnlyLogin: true,
  sessionSecret: 'phase-two-test-session-secret'
});

function createAuthDatabase(userRows) {
  const queries = [];
  return {
    queries,
    getPool: async () => ({
      request() {
        const values = {};
        return {
          input(name, type, value) {
            values[name] = value;
            return this;
          },
          async query(statement) {
            queries.push({ statement, values });
            if (statement.includes('WHERE email = @email')) {
              const user = userRows.find((row) => row.email === values.email);
              return { recordset: user ? [{ ...user }] : [] };
            }
            if (statement.includes('WHERE id = @userId')) {
              const user = userRows.find((row) => row.id === values.userId);
              return { recordset: user ? [{
                id: user.id,
                email: user.email,
                role: user.role,
                is_active: user.is_active,
                password_hash: user.password_hash,
                updated_at_fingerprint: user.updated_at_fingerprint || ''
              }] : [] };
            }
            throw new Error(`Unexpected SQL in auth test: ${statement}`);
          }
        };
      }
    })
  };
}

function getSessionCookie(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'expected the server to set a session cookie');
  return cookie.split(';', 1)[0];
}

function csrfFromHtml(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'expected a session CSRF token in the form');
  return match[1];
}

async function postForm(baseUrl, path, cookie, values, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(values),
    ...options
  });
}

async function loginForCookie(baseUrl, email = 'registrar@example.edu') {
  const loginPage = await fetch(`${baseUrl}/login`);
  const anonymousCookie = getSessionCookie(loginPage);
  const csrfToken = csrfFromHtml(await loginPage.text());
  const response = await postForm(baseUrl, '/login', anonymousCookie, {
    _csrf: csrfToken,
    email,
    password: 'Correct-Horse-Battery-12'
  });
  assert.equal(response.status, 303);
  return getSessionCookie(response);
}

function emailTwoFactorEnvironment(overrides = {}) {
  return {
    nodeEnv: 'test',
    devPasswordOnlyLogin: false,
    sessionSecret: 'phase-three-test-session-secret',
    smtp: { host: 'smtp.test.invalid', port: 587, secure: false, user: 'test-user', pass: 'test-pass', from: 'ARKTIESIIS <test@example.edu>' },
    ...overrides
  };
}

function createTestTwoFactorService(user, { failDelivery = false, failDeliveryAt = Infinity, denyAfter = Infinity } = {}) {
  const state = { attempts: 0, sends: 0, challenges: [], nextCode: 123456 };
  const service = {
    OTP_TTL_MINUTES: 5,
    state,
    async issueOtpChallenge() {
      if (state.sends >= denyAfter) return { allowed: false, codeId: null, code: null };
      state.sends += 1;
      const challenge = {
        id: state.sends,
        code: String(state.nextCode++).padStart(6, '0'),
        code_hash: `test-hash-${state.sends}`,
        consumed: false,
        expired: false
      };
      for (const previous of state.challenges) previous.consumed = true;
      state.challenges.push(challenge);
      return { allowed: true, codeId: challenge.id, code: challenge.code };
    },
    async sendOtpEmail(_smtp, _to, code) {
      state.deliveredCode = code;
      if (failDelivery || state.sends === failDeliveryAt) throw new Error('smtp-token=secret-value');
    },
    async invalidateOtpChallenge({ codeId }) {
      const challenge = state.challenges.find((entry) => entry.id === codeId);
      if (challenge) challenge.consumed = true;
    },
    async getActiveUser({ userId }) {
      return user.id === userId ? {
        id: user.id,
        email: user.email,
        role: user.role,
        password_hash: user.password_hash,
        is_active: user.is_active,
        updated_at_fingerprint: user.updated_at_fingerprint || ''
      } : null;
    },
    async getOtpChallenge({ userId, codeId }) {
      if (user.id !== userId) return null;
      const challenge = state.challenges.find((entry) => entry.id === codeId);
      return challenge && !challenge.consumed && !challenge.expired
        ? { id: challenge.id, code_hash: challenge.code_hash }
        : null;
    },
    async reserveOtpAttempt() {
      if (state.attempts >= 5) return false;
      state.attempts += 1;
      return true;
    },
    async compareOtp(code, codeHash) {
      const challenge = state.challenges.find((entry) => entry.code_hash === codeHash);
      return Boolean(challenge && challenge.code === code);
    },
    async consumeOtpChallenge({ userId, codeId, codeHash }) {
      const challenge = state.challenges.find((entry) => entry.id === codeId);
      if (user.id !== userId || user.is_active !== true || !challenge || challenge.consumed || challenge.expired || challenge.code_hash !== codeHash) return false;
      challenge.consumed = true;
      state.attempts = 0;
      return true;
    }
  };
  return service;
}

async function startEmailLogin(baseUrl, email, password = 'Correct-Horse-Battery-12') {
  const loginPage = await fetch(`${baseUrl}/login`);
  const anonymousCookie = getSessionCookie(loginPage);
  const csrfToken = csrfFromHtml(await loginPage.text());
  const response = await postForm(baseUrl, '/login', anonymousCookie, { _csrf: csrfToken, email, password });
  return { anonymousCookie, response, authenticatedCookie: response.headers.get('set-cookie')?.split(';', 1)[0] };
}

async function getVerificationForm(baseUrl, cookie) {
  const response = await fetch(`${baseUrl}/login/verify`, { headers: { cookie } });
  const html = await response.text();
  return { response, html, csrfToken: csrfFromHtml(html) };
}

test('required text validator passes when all configured keywords exist', () => {
  const result = validateRequiredText('Juan Dela Cruz School Year 2026', [
    { key: 'student_name', label: 'Student Name', keywords: ['Juan Dela Cruz'] },
    { key: 'school_year', label: 'School Year', keywords: ['School Year'] }
  ]);
  assert.equal(result.complete, true);
});

test('home page renders with Helmet default content security policy', async () => {
  await withServer(createApp({ databasePool: async () => { throw new Error('Database not used'); } }), async (baseUrl) => {
    const response = await fetch(baseUrl);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /ARKTIESIIS/);
    assert.match(html, /src="\/images\/arktiesiis-campus-building-hero\.png"/);
    assert.match(html, /Street view of the Ark Technological Institute Education System Incorporated building at Lucena Branch/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    const buildingImage = await fetch(`${baseUrl}/images/arktiesiis-campus-building-hero.png`);
    assert.equal(buildingImage.status, 200);
    assert.match(buildingImage.headers.get('content-type'), /image\/png/);
  });
});

test('login page renders', async () => {
  await withServer(createApp({ environment: developmentEnvironment() }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/login`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<h1 id="login-title">Sign in<\/h1>/);
    assert.match(html, /name="_csrf"/);
    assert.match(html, /\/images\/arktiesiis-school-seal\.png/);
  });
});

test('POST form feedback announces a valid submission and leaves prevented submissions available', () => {
  function fakeElement() {
    return {
      attributes: {},
      dataset: {},
      listeners: {},
      children: [],
      hidden: false,
      textContent: '',
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      append(child) { this.children.push(child); }
    };
  }

  const validForm = fakeElement();
  validForm.dataset.submittingMessage = 'Uploading the document. Please wait.';
  validForm.querySelector = () => validForm.children[0];
  const validButton = fakeElement();
  validButton.textContent = 'Upload document';
  validButton.dataset.submittingLabel = 'Uploading…';
  validForm.querySelectorAll = () => [validButton];
  const preventedForm = fakeElement();
  preventedForm.querySelectorAll = () => [fakeElement()];
  const forms = [validForm, preventedForm];
  const document = {
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '[data-password-match-form]') return [];
      if (selector === 'form[method="post"]') return forms;
      return [];
    },
    createElement() { return fakeElement(); }
  };
  const windowListeners = {};

  runInNewContext(readFileSync('public/js/app.js', 'utf8'), {
    document,
    window: { addEventListener(name, listener) { windowListeners[name] = listener; } }
  });

  const validStatus = validForm.children[0];
  assert.equal(validStatus.hidden, true);
  validForm.listeners.submit({ defaultPrevented: false, submitter: validButton });
  assert.equal(validForm.attributes['aria-busy'], 'true');
  assert.equal(validStatus.hidden, false);
  assert.equal(validStatus.attributes.role, 'status');
  assert.equal(validStatus.attributes['aria-live'], 'polite');
  assert.equal(validStatus.textContent, 'Uploading the document. Please wait.');
  assert.equal(validButton.attributes['aria-disabled'], 'true');
  assert.equal(validButton.textContent, 'Uploading…');

  let duplicatePrevented = false;
  validForm.listeners.submit({
    defaultPrevented: false,
    submitter: validButton,
    preventDefault() { duplicatePrevented = true; }
  });
  assert.equal(duplicatePrevented, true, 'a second submission is blocked while the first request is pending');

  windowListeners.pageshow();
  assert.equal(validForm.dataset.submitting, 'false');
  assert.equal(validForm.attributes['aria-busy'], undefined);
  assert.equal(validStatus.hidden, true);
  assert.equal(validButton.attributes['aria-disabled'], undefined);
  assert.equal(validButton.textContent, 'Upload document');

  const preventedStatus = preventedForm.children[0];
  preventedForm.listeners.submit({ defaultPrevented: true, submitter: preventedForm.querySelectorAll()[0] });
  assert.equal(preventedStatus.hidden, true);
  assert.equal(preventedForm.attributes['aria-busy'], undefined);
});

test('login page remains available when the development password bypass is disabled', async () => {
  const disabledEnvironments = [
    { nodeEnv: 'development', devPasswordOnlyLogin: false },
    { nodeEnv: 'test', devPasswordOnlyLogin: true },
    { nodeEnv: 'production', devPasswordOnlyLogin: true }
  ];

  for (const [index, environment] of disabledEnvironments.entries()) {
    await withServer(createApp({
      environment: { ...environment, sessionSecret: `login-unavailable-session-secret-${index}` }
    }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/login`);
      const html = await response.text();

      assert.equal(response.status, 200);
      if (environment.nodeEnv !== 'production') assert.ok(response.headers.get('set-cookie'));
      else assert.equal(response.headers.get('set-cookie'), null);
      assert.match(html, /verification code will be sent to your school email/);
    });
  }
});

test('unknown routes render a 404 page', async () => {
  await withServer(createApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missing`);
    const html = await response.text();

    assert.equal(response.status, 404);
    assert.match(html, /Page not found\./);
  });
});

test('health route reports a successful database check', async () => {
  let query;
  const databasePool = async () => ({
    request: () => ({
      query: async (sql) => {
        query = sql;
        return { recordset: [{ ok: 1 }] };
      }
    })
  });

  await withServer(createApp({ databasePool }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, database: 'connected' });
    assert.equal(query, 'SELECT 1 AS ok');
  });
});

test('health route reports database failure without exposing SQL details', async () => {
  const databasePool = async () => {
    throw new Error('SQL login failed for secret-host.internal with password=secret');
  };

  await withServer(createApp({ databasePool }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.text();

    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(body), { ok: false, database: 'disconnected' });
    assert.doesNotMatch(body, /secret-host|password=secret|SQL login/);
  });
});

test('environment rejects invalid ports and a missing production session secret', () => {
  const baseEnv = { PATH: process.env.PATH, NODE_ENV: 'development' };
  const loadEnvironment = (overrides) => spawnSync(
    process.execPath,
    ['-e', "require('./src/config/environment')"],
    { cwd: process.cwd(), env: { ...baseEnv, ...overrides }, encoding: 'utf8' }
  );

  assert.notEqual(loadEnvironment({ PORT: 'not-a-port' }).status, 0);
  assert.notEqual(loadEnvironment({ DB_PORT: '65536' }).status, 0);
  assert.notEqual(loadEnvironment({ GEMINI_TIMEOUT_MS: '999' }).status, 0);
  assert.notEqual(loadEnvironment({ GEMINI_TIMEOUT_MS: '120001' }).status, 0);
  assert.notEqual(loadEnvironment({ GEMINI_TIMEOUT_MS: '1.5' }).status, 0);
  assert.equal(loadEnvironment({ GEMINI_TIMEOUT_MS: '1000' }).status, 0);
  assert.equal(loadEnvironment({ GEMINI_TIMEOUT_MS: '120000' }).status, 0);
  assert.notEqual(loadEnvironment({ DOCUMENT_PROCESSING_CONCURRENCY: '5' }).status, 0);
  assert.notEqual(loadEnvironment({ GEMINI_MODEL: 'not-a-gemini-model' }).status, 0);
  assert.notEqual(loadEnvironment({ GEMINI_API_KEY: 'invalid\nkey' }).status, 0);
  assert.notEqual(loadEnvironment({ NODE_ENV: 'production', SESSION_SECRET: '' }).status, 0);
  assert.equal(loadEnvironment({ NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(32), APP_BASE_URL: 'https://school.example.edu' }).status, 0);
});

test('development login regenerates the session and redirects to the database-backed role dashboard', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const database = createAuthDatabase([{
    id: 21,
    email: 'registrar@example.edu',
    password_hash: passwordHash,
    role: 'registrar',
    is_active: true
  }]);

  const studentRecordsService = {
    async getRegistrarDashboardSummary() {
      return {
        active_student_count: 0,
        archived_student_count: 0,
        current_enrollment_count: 0,
        documents_awaiting_review_count: 0,
        documents_processing_count: 0
      };
    }
  };

  await withServer(createApp({ databasePool: database.getPool, environment: developmentEnvironment(), studentRecordsService }), async (baseUrl) => {
    const loginPage = await fetch(`${baseUrl}/login`);
    const anonymousCookie = getSessionCookie(loginPage);
    const csrfToken = csrfFromHtml(await loginPage.text());
    const response = await postForm(baseUrl, '/login', anonymousCookie, {
      _csrf: csrfToken,
      email: 'Registrar@Example.edu',
      password: 'Correct-Horse-Battery-12'
    });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/registrar');
    const authenticatedCookie = getSessionCookie(response);
    assert.notEqual(authenticatedCookie, anonymousCookie);

    const staleSessionResponse = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: anonymousCookie }, redirect: 'manual' });
    assert.equal(staleSessionResponse.status, 302);
    assert.equal(staleSessionResponse.headers.get('location'), '/login');

    const dashboardRedirect = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: authenticatedCookie }, redirect: 'manual' });
    assert.equal(dashboardRedirect.status, 303);
    assert.equal(dashboardRedirect.headers.get('location'), '/registrar');

    const rolePage = await fetch(`${baseUrl}/registrar`, { headers: { cookie: authenticatedCookie } });
    assert.equal(rolePage.status, 200);
    assert.equal(rolePage.headers.get('cache-control'), 'private, no-store');
    assert.match(await rolePage.text(), /Find a student/);

    const deniedPage = await fetch(`${baseUrl}/dashboard/finance`, { headers: { cookie: authenticatedCookie } });
    assert.equal(deniedPage.status, 403);
    assert.ok(database.queries.some(({ statement, values }) => statement.includes('WHERE email = @email') && values.email === 'registrar@example.edu'));
    assert.ok(database.queries.filter(({ statement }) => statement.includes('WHERE id = @userId')).length >= 3);
  });
});

test('non-development login requires OTP even when the development bypass flag is set', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const user = { id: 31, email: 'staff@example.edu', password_hash: passwordHash, role: 'registrar', is_active: true };
  const twoFactorService = createTestTwoFactorService(user);
  const environment = emailTwoFactorEnvironment({ nodeEnv: 'test', devPasswordOnlyLogin: true });

  await withServer(createApp({ databasePool: createAuthDatabase([user]).getPool, environment, twoFactorService }), async (baseUrl) => {
    const { response, anonymousCookie, authenticatedCookie } = await startEmailLogin(baseUrl, user.email);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login/verify');
    assert.notEqual(authenticatedCookie, anonymousCookie);

    const dashboard = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: authenticatedCookie }, redirect: 'manual' });
    assert.equal(dashboard.status, 302);
    assert.equal(dashboard.headers.get('location'), '/login');

    const verification = await getVerificationForm(baseUrl, authenticatedCookie);
    const verified = await postForm(baseUrl, '/login/verify', authenticatedCookie, {
      _csrf: verification.csrfToken,
      code: twoFactorService.state.deliveredCode
    });
    assert.equal(verified.status, 303);
    assert.equal(verified.headers.get('location'), '/registrar');
    assert.notEqual(getSessionCookie(verified), authenticatedCookie);
    const dashboardAfterOtp = await fetch(`${baseUrl}/dashboard`, {
      headers: { cookie: getSessionCookie(verified) },
      redirect: 'manual'
    });
    assert.equal(dashboardAfterOtp.status, 303);
    assert.equal(dashboardAfterOtp.headers.get('location'), '/registrar');
  });
});

test('a pending OTP session cannot gain a newly upgraded role', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const user = { id: 39, email: 'staff@example.edu', password_hash: passwordHash, role: 'registrar', is_active: true };
  const twoFactorService = createTestTwoFactorService(user);
  const environment = emailTwoFactorEnvironment();

  await withServer(createApp({ databasePool: createAuthDatabase([user]).getPool, environment, twoFactorService }), async (baseUrl) => {
    const login = await startEmailLogin(baseUrl, user.email);
    user.role = 'database_admin';
    const response = await fetch(`${baseUrl}/login/verify`, { headers: { cookie: login.authenticatedCookie }, redirect: 'manual' });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /Invalid email or password/);
    const dashboard = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: login.authenticatedCookie }, redirect: 'manual' });
    assert.equal(dashboard.status, 302);
    assert.equal(dashboard.headers.get('location'), '/login');
  });
});

test('OTP verification rejects wrong, expired, and replayed codes and requires CSRF', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const user = { id: 32, email: 'student@example.edu', password_hash: passwordHash, role: 'student', is_active: true };
  const twoFactorService = createTestTwoFactorService(user);
  const environment = emailTwoFactorEnvironment();

  await withServer(createApp({ databasePool: createAuthDatabase([user]).getPool, environment, twoFactorService }), async (baseUrl) => {
    const firstLogin = await startEmailLogin(baseUrl, user.email);
    const firstCookie = firstLogin.authenticatedCookie;
    const firstForm = await getVerificationForm(baseUrl, firstCookie);
    assert.equal(firstForm.response.status, 200);

    const missingCsrf = await postForm(baseUrl, '/login/verify', firstCookie, { code: twoFactorService.state.deliveredCode });
    assert.equal(missingCsrf.status, 403);
    const wrongCode = await postForm(baseUrl, '/login/verify', firstCookie, { _csrf: firstForm.csrfToken, code: '000000' });
    assert.equal(wrongCode.status, 401);
    assert.match(await wrongCode.text(), /This code is invalid or has expired/);

    const secondLogin = await startEmailLogin(baseUrl, user.email);
    const secondCookie = secondLogin.authenticatedCookie;
    const secondForm = await getVerificationForm(baseUrl, secondCookie);
    const currentChallenge = twoFactorService.state.challenges.at(-1);
    currentChallenge.expired = true;
    const expiredCode = await postForm(baseUrl, '/login/verify', secondCookie, {
      _csrf: secondForm.csrfToken,
      code: currentChallenge.code
    });
    assert.equal(expiredCode.status, 401);
    assert.match(await expiredCode.text(), /invalid or has expired/);

    const thirdLogin = await startEmailLogin(baseUrl, user.email);
    const thirdCookie = thirdLogin.authenticatedCookie;
    const thirdForm = await getVerificationForm(baseUrl, thirdCookie);
    const correctCode = twoFactorService.state.deliveredCode;
    const verified = await postForm(baseUrl, '/login/verify', thirdCookie, { _csrf: thirdForm.csrfToken, code: correctCode });
    assert.equal(verified.status, 303);
    assert.equal(twoFactorService.state.challenges.at(-1).consumed, true);

    const replay = await postForm(baseUrl, '/login/verify', thirdCookie, { _csrf: thirdForm.csrfToken, code: correctCode });
    assert.equal(replay.status, 403);
    const stalePendingDashboard = await fetch(`${baseUrl}/student`, { headers: { cookie: thirdCookie }, redirect: 'manual' });
    assert.equal(stalePendingDashboard.status, 302);
    assert.equal(stalePendingDashboard.headers.get('location'), '/login');
  });
});

test('concurrent OTP submissions can redeem a code only once', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const user = { id: 37, email: 'registrar@example.edu', password_hash: passwordHash, role: 'registrar', is_active: true };
  const twoFactorService = createTestTwoFactorService(user);
  await withServer(createApp({
    databasePool: createAuthDatabase([user]).getPool,
    environment: emailTwoFactorEnvironment(),
    twoFactorService
  }), async (baseUrl) => {
    const login = await startEmailLogin(baseUrl, user.email);
    const form = await getVerificationForm(baseUrl, login.authenticatedCookie);
    const code = twoFactorService.state.deliveredCode;
    const submissions = await Promise.all([1, 2].map(() => postForm(baseUrl, '/login/verify', login.authenticatedCookie, {
      _csrf: form.csrfToken,
      code
    })));

    const statuses = submissions.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 303).length, 1);
    assert.ok(statuses.every((status) => status === 303 || status === 401 || status === 403));
    assert.equal(twoFactorService.state.challenges[0].consumed, true);
  });
});

test('OTP attempt throttling is shared across login sessions', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const user = { id: 33, email: 'finance@example.edu', password_hash: passwordHash, role: 'finance', is_active: true };
  const twoFactorService = createTestTwoFactorService(user);
  const environment = emailTwoFactorEnvironment();

  await withServer(createApp({ databasePool: createAuthDatabase([user]).getPool, environment, twoFactorService }), async (baseUrl) => {
    const firstLogin = await startEmailLogin(baseUrl, user.email);
    const firstForm = await getVerificationForm(baseUrl, firstLogin.authenticatedCookie);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await postForm(baseUrl, '/login/verify', firstLogin.authenticatedCookie, {
        _csrf: firstForm.csrfToken,
        code: '000000'
      });
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    }

    const secondLogin = await startEmailLogin(baseUrl, user.email);
    const secondForm = await getVerificationForm(baseUrl, secondLogin.authenticatedCookie);
    const fifthAttempt = await postForm(baseUrl, '/login/verify', secondLogin.authenticatedCookie, {
      _csrf: secondForm.csrfToken,
      code: '000000'
    });
    assert.equal(fifthAttempt.status, 401);
    await fifthAttempt.arrayBuffer();

    const throttled = await postForm(baseUrl, '/login/verify', secondLogin.authenticatedCookie, {
      _csrf: secondForm.csrfToken,
      code: twoFactorService.state.deliveredCode
    });
    assert.equal(throttled.status, 429);
    assert.match(await throttled.text(), /Too many code attempts/);
  });
});

test('OTP resend enforces the send limit and failed delivery cannot leave a pending challenge', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const user = { id: 34, email: 'registrar@example.edu', password_hash: passwordHash, role: 'registrar', is_active: true };
  const twoFactorService = createTestTwoFactorService(user, { denyAfter: 2 });
  const environment = emailTwoFactorEnvironment();

  await withServer(createApp({ databasePool: createAuthDatabase([user]).getPool, environment, twoFactorService }), async (baseUrl) => {
    const login = await startEmailLogin(baseUrl, user.email);
    const form = await getVerificationForm(baseUrl, login.authenticatedCookie);
    const deniedCsrf = await postForm(baseUrl, '/login/verify/resend', login.authenticatedCookie, { _csrf: 'wrong' });
    assert.equal(deniedCsrf.status, 403);

    const resent = await postForm(baseUrl, '/login/verify/resend', login.authenticatedCookie, { _csrf: form.csrfToken });
    assert.equal(resent.status, 200);
    const resendBody = await resent.text();
    assert.match(resendBody, /A new code was sent/);
    assert.equal(twoFactorService.state.challenges[0].consumed, true);
    assert.ok(csrfFromHtml(resendBody).length >= 32);
    const latestForm = await getVerificationForm(baseUrl, login.authenticatedCookie);
    const deniedResend = await postForm(baseUrl, '/login/verify/resend', login.authenticatedCookie, { _csrf: latestForm.csrfToken });
    assert.equal(deniedResend.status, 429);
    await deniedResend.arrayBuffer();
    assert.equal(twoFactorService.state.challenges.at(-1).consumed, false);
  });

  const failureUser = { ...user, id: 35, email: 'failure@example.edu' };
  const failedDelivery = createTestTwoFactorService(failureUser, { failDelivery: true });
  await withServer(createApp({
    databasePool: createAuthDatabase([failureUser]).getPool,
    environment,
    twoFactorService: failedDelivery
  }), async (baseUrl) => {
    const login = await startEmailLogin(baseUrl, failureUser.email);
    const body = await login.response.text();
    assert.equal(login.response.status, 401);
    assert.match(body, /Invalid email or password\./);
    assert.doesNotMatch(body, /smtp-token|secret-value/);
    assert.equal(failedDelivery.state.challenges[0].consumed, true);
    const staleChallenge = await fetch(`${baseUrl}/login/verify`, { headers: { cookie: login.authenticatedCookie }, redirect: 'manual' });
    assert.equal(staleChallenge.status, 302);
    assert.equal(staleChallenge.headers.get('location'), '/login');
  });

  const resendFailureUser = { ...user, id: 38, email: 'resend-failure@example.edu' };
  const failedResend = createTestTwoFactorService(resendFailureUser, { failDeliveryAt: 2 });
  await withServer(createApp({
    databasePool: createAuthDatabase([resendFailureUser]).getPool,
    environment,
    twoFactorService: failedResend
  }), async (baseUrl) => {
    const login = await startEmailLogin(baseUrl, resendFailureUser.email);
    const form = await getVerificationForm(baseUrl, login.authenticatedCookie);
    const failed = await postForm(baseUrl, '/login/verify/resend', login.authenticatedCookie, { _csrf: form.csrfToken });
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /smtp-token|secret-value/);
    assert.equal(failedResend.state.challenges[0].consumed, true);
    assert.equal(failedResend.state.challenges[1].consumed, true);
    const staleSession = await fetch(`${baseUrl}/login/verify`, { headers: { cookie: login.authenticatedCookie }, redirect: 'manual' });
    assert.equal(staleSession.status, 302);
    assert.equal(staleSession.headers.get('location'), '/login');
  });
});

test('OTP verification rechecks active status and non-development SMTP misconfiguration fails closed', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const user = { id: 36, email: 'admin@example.edu', password_hash: passwordHash, role: 'database_admin', is_active: true };
  const twoFactorService = createTestTwoFactorService(user);
  const environment = emailTwoFactorEnvironment({ nodeEnv: 'test', devPasswordOnlyLogin: true });

  await withServer(createApp({ databasePool: createAuthDatabase([user]).getPool, environment, twoFactorService }), async (baseUrl) => {
    const login = await startEmailLogin(baseUrl, user.email);
    const form = await getVerificationForm(baseUrl, login.authenticatedCookie);
    user.is_active = false;
    const response = await postForm(baseUrl, '/login/verify', login.authenticatedCookie, {
      _csrf: form.csrfToken,
      code: twoFactorService.state.deliveredCode
    });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /Invalid email or password\./);
    const dashboard = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: getSessionCookie(response) }, redirect: 'manual' });
    assert.equal(dashboard.status, 302);
    assert.equal(dashboard.headers.get('location'), '/login');
  });

  const misconfiguredUser = { ...user, is_active: true };
  const database = createAuthDatabase([misconfiguredUser]);
  await withServer(createApp({
    databasePool: database.getPool,
    environment: emailTwoFactorEnvironment({ smtp: { host: '', port: 587, secure: true, from: 'test@example.edu' } }),
    twoFactorService
  }), async (baseUrl) => {
    const page = await fetch(`${baseUrl}/login`);
    const cookie = getSessionCookie(page);
    const token = csrfFromHtml(await page.text());
    const response = await postForm(baseUrl, '/login', cookie, {
      _csrf: token,
      email: 'unknown@example.edu',
      password: 'Correct-Horse-Battery-12'
    });
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.match(body, /Sign in is temporarily unavailable/);
    assert.doesNotMatch(body, /unknown@example.edu|smtp/);
    assert.equal(database.queries.length, 0);
  });
});

test('login and logout reject missing or invalid session CSRF tokens and valid logout clears the session', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const database = createAuthDatabase([{
    id: 3,
    email: 'student@example.edu',
    password_hash: passwordHash,
    role: 'student',
    is_active: true
  }]);

  await withServer(createApp({
    databasePool: database.getPool,
    environment: developmentEnvironment(),
    studentRecordsService: {
      async getOwnStudentRecord() {
        return { student: { student_no: 'TEST-3', first_name: 'Student', last_name: 'Example' }, enrollments: [] };
      }
    },
    academicRecordsService: { async getOwnGrades() { return []; } }
  }), async (baseUrl) => {
    const page = await fetch(`${baseUrl}/login`);
    const anonymousCookie = getSessionCookie(page);
    const token = csrfFromHtml(await page.text());

    const missingLoginCsrf = await postForm(baseUrl, '/login', anonymousCookie, { email: 'student@example.edu', password: 'bad' });
    const badLoginCsrf = await postForm(baseUrl, '/login', anonymousCookie, { _csrf: 'wrong', email: 'student@example.edu', password: 'bad' });
    assert.equal(missingLoginCsrf.status, 403);
    assert.equal(badLoginCsrf.status, 403);

    const authenticatedCookie = await loginForCookie(baseUrl, 'student@example.edu');
    const dashboard = await fetch(`${baseUrl}/student`, { headers: { cookie: authenticatedCookie } });
    const logoutCsrf = csrfFromHtml(await dashboard.text());

    const missingLogoutCsrf = await postForm(baseUrl, '/logout', authenticatedCookie, {});
    const badLogoutCsrf = await postForm(baseUrl, '/logout', authenticatedCookie, { _csrf: 'wrong' });
    assert.equal(missingLogoutCsrf.status, 403);
    assert.equal(badLogoutCsrf.status, 403);

    const logout = await postForm(baseUrl, '/logout', authenticatedCookie, { _csrf: logoutCsrf });
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.get('location'), '/login');
    assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);

    const afterLogout = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: authenticatedCookie }, redirect: 'manual' });
    assert.equal(afterLogout.status, 302);
    assert.equal(afterLogout.headers.get('location'), '/login');
    assert.ok(token.length >= 32);
  });
});

test('login returns the same credential error for missing, inactive, and wrong-password accounts', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const database = createAuthDatabase([
    { id: 1, email: 'active@example.edu', password_hash: passwordHash, role: 'student', is_active: true },
    { id: 2, email: 'inactive@example.edu', password_hash: passwordHash, role: 'student', is_active: false }
  ]);

  await withServer(createApp({ databasePool: database.getPool, environment: developmentEnvironment() }), async (baseUrl) => {
    const results = [];
    for (const email of ['missing@example.edu', 'inactive@example.edu', 'active@example.edu']) {
      const page = await fetch(`${baseUrl}/login`);
      const cookie = getSessionCookie(page);
      const token = csrfFromHtml(await page.text());
      const response = await postForm(baseUrl, '/login', cookie, {
        _csrf: token,
        email,
        password: email === 'active@example.edu' ? 'wrong-password' : 'Correct-Horse-Battery-12'
      });
      results.push({ status: response.status, body: await response.text() });
    }

    assert.deepEqual(results.map((result) => result.status), [401, 401, 401]);
    assert.ok(results.every((result) => /<p class="form-alert" role="alert">Invalid email or password\.<\/p>/.test(result.body)));
  });
});

test('inactive users lose protected access after their account is deactivated', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const user = { id: 14, email: 'registrar@example.edu', password_hash: passwordHash, role: 'registrar', is_active: true };
  const database = createAuthDatabase([user]);

  await withServer(createApp({ databasePool: database.getPool, environment: developmentEnvironment() }), async (baseUrl) => {
    const cookie = await loginForCookie(baseUrl, 'registrar@example.edu');
    user.is_active = false;
    const response = await fetch(`${baseUrl}/registrar`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
    assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  });
});

test('password-only login is denied outside development and a dev session is destroyed if the environment changes', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const user = { id: 8, email: 'student@example.edu', password_hash: passwordHash, role: 'student', is_active: true };
  const database = createAuthDatabase([user]);

  const mutableEnvironment = developmentEnvironment();
  await withServer(createApp({ databasePool: database.getPool, environment: mutableEnvironment }), async (baseUrl) => {
    const page = await fetch(`${baseUrl}/login`);
    const cookie = getSessionCookie(page);
    const token = csrfFromHtml(await page.text());
    mutableEnvironment.nodeEnv = 'test';
    const deniedPost = await postForm(baseUrl, '/login', cookie, {
      _csrf: token,
      email: 'student@example.edu',
      password: 'Correct-Horse-Battery-12'
    });
    assert.equal(deniedPost.status, 503);
    assert.equal(database.queries.length, 0);

    mutableEnvironment.nodeEnv = 'development';
    const login = await postForm(baseUrl, '/login', cookie, {
      _csrf: token,
      email: 'student@example.edu',
      password: 'Correct-Horse-Battery-12'
    });
    assert.equal(login.status, 303);
    const authenticatedCookie = getSessionCookie(login);

    mutableEnvironment.nodeEnv = 'production';
    const response = await fetch(`${baseUrl}/student`, { headers: { cookie: authenticatedCookie }, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
    assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  });
});

test('development password login skips only the login limiter while retaining CSRF and credential checks', async () => {
  const database = createAuthDatabase([]);
  await withServer(createApp({ databasePool: database.getPool, environment: developmentEnvironment() }), async (baseUrl) => {
    const page = await fetch(`${baseUrl}/login`);
    const cookie = getSessionCookie(page);
    const token = csrfFromHtml(await page.text());
    const invalidCsrf = await postForm(baseUrl, '/login', cookie, {
      _csrf: 'invalid', email: 'nobody@example.edu', password: 'not-the-password'
    });
    assert.equal(invalidCsrf.status, 403);
    await invalidCsrf.arrayBuffer();
    const statuses = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await postForm(baseUrl, '/login', cookie, {
        _csrf: token,
        email: 'nobody@example.edu',
        password: 'not-the-password'
      });
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    assert.deepEqual(statuses, Array(12).fill(401));
  });
});

test('production login remains limited to ten attempts per IP even if the development bypass flag is set', async () => {
  const database = createAuthDatabase([]);
  const environment = {
    nodeEnv: 'production', devPasswordOnlyLogin: true, sessionSecret: 'production-login-limiter-test-secret',
    smtp: { host: 'smtp.test.invalid', from: 'ARKTIESIIS <test@example.edu>' }
  };
  const app = createApp({ databasePool: database.getPool, environment });
  app.set('trust proxy', 1);
  await withServer(app, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/login`, { headers: { 'x-forwarded-proto': 'https' } });
    const cookie = getSessionCookie(page);
    const token = csrfFromHtml(await page.text());
    const statuses = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await postForm(baseUrl, '/login', cookie, {
        _csrf: token,
        email: 'nobody@example.edu',
        password: 'not-the-password'
      }, { headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' } });
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
  });
});

test('admin bootstrap validates fields and creates user, staff profile, and audit event in one transaction', async () => {
  assert.throws(() => validateBootstrapInput({ email: 'bad', firstName: 'Admin', lastName: 'User', password: 'short' }));
  const statements = [];
  const transactionState = { beginLevel: null, committed: false, rolledBack: false };
  const sqlTypes = {
    MAX: -1,
    Int: 'Int',
    NVarChar: (length) => `NVarChar(${length})`,
    ISOLATION_LEVEL: { SERIALIZABLE: 'serializable' },
    Transaction: class {
      constructor() {}
      async begin(level) { transactionState.beginLevel = level; }
      request() {
        const values = {};
        return {
          input(name, type, value) { values[name] = value; return this; },
          async query(statement) {
            statements.push({ statement, values });
            if (statement.startsWith('SELECT TOP')) return { recordset: [] };
            if (statement.startsWith('INSERT INTO dbo.users')) return { recordset: [{ id: 91 }] };
            return { recordset: [] };
          }
        };
      }
      async commit() { transactionState.committed = true; }
      async rollback() { transactionState.rolledBack = true; }
    }
  };
  const result = await bootstrapAdmin({
    email: 'admin@example.edu',
    firstName: 'Ada',
    lastName: 'Lovelace',
    password: 'Correct-Horse-Battery-12'
  }, {
    getDatabasePool: async () => ({}),
    sqlTypes,
    hashPassword: async (password, rounds) => {
      assert.equal(password, 'Correct-Horse-Battery-12');
      assert.equal(rounds, 12);
      return 'bcrypt-hash-value';
    }
  });

  assert.equal(result, 91);
  assert.equal(transactionState.beginLevel, 'serializable');
  assert.equal(transactionState.committed, true);
  assert.equal(transactionState.rolledBack, false);
  assert.equal(statements.length, 4);
  assert.ok(statements.every(({ statement }) => statement.includes('@')));
  assert.ok(statements.some(({ statement, values }) => statement.includes('dbo.staff_profiles') && values.firstName === 'Ada'));
  assert.ok(statements.some(({ statement, values }) => statement.includes('dbo.audit_logs') && values.action === 'admin.bootstrap'));
});

test('admin bootstrap refuses to create a second database administrator', async () => {
  let committed = false;
  let rolledBack = false;
  let queryCount = 0;
  const sqlTypes = {
    MAX: -1,
    Int: 'Int',
    NVarChar: (length) => `NVarChar(${length})`,
    ISOLATION_LEVEL: { SERIALIZABLE: 'serializable' },
    Transaction: class {
      constructor() {}
      async begin() {}
      request() {
        return {
          input() { return this; },
          async query() { queryCount += 1; return { recordset: [{ id: 1 }] }; }
        };
      }
      async commit() { committed = true; }
      async rollback() { rolledBack = true; }
    }
  };

  await assert.rejects(bootstrapAdmin({
    email: 'admin@example.edu',
    firstName: 'Ada',
    lastName: 'Lovelace',
    password: 'Correct-Horse-Battery-12'
  }, {
    getDatabasePool: async () => ({}),
    sqlTypes,
    hashPassword: async () => 'bcrypt-hash-value'
  }), /A database administrator already exists\./);

  assert.equal(queryCount, 1);
  assert.equal(committed, false);
  assert.equal(rolledBack, true);
});
