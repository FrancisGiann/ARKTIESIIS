const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');
const {
  AdminServiceError,
  createAdminService,
  validateCreateUser,
  validateUpdateUser
} = require('../src/services/adminService');

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function getSessionCookie(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'expected a session cookie');
  return cookie.split(';', 1)[0];
}

function csrfFromHtml(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'expected a CSRF token');
  return match[1];
}

async function postForm(baseUrl, path, cookie, values) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values)
  });
}

async function signIn(baseUrl, email) {
  const page = await fetch(`${baseUrl}/login`);
  const cookie = getSessionCookie(page);
  const token = csrfFromHtml(await page.text());
  const response = await postForm(baseUrl, '/login', cookie, {
    _csrf: token,
    email,
    password: 'Correct-Horse-Battery-12'
  });
  assert.equal(response.status, 303);
  return getSessionCookie(response);
}

function createAuthPool(role) {
  const passwordHash = bcrypt.hashSync('Correct-Horse-Battery-12', 4);
  const user = { id: 7, email: `${role}@example.edu`, password_hash: passwordHash, role, is_active: true, updated_at_fingerprint: '' };
  const getPool = async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          if (statement.includes('WHERE email = @email')) return { recordset: [user] };
          if (statement.includes('WHERE id = @userId')) return { recordset: [{ ...user }] };
          throw new Error('Unexpected auth query');
        }
      };
    }
  });
  getPool.user = user;
  return getPool;
}

const testEnvironment = {
  nodeEnv: 'development',
  devPasswordOnlyLogin: true,
  sessionSecret: 'phase-four-admin-test-session-secret'
};

function fakeSql() {
  return {
    MAX: 'MAX',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
    Int: 'Int',
    Bit: 'Bit',
    NVarChar: (length) => `NVarChar(${length})`
  };
}

function transactionalService(onQuery, { hashPassword = async () => 'bcrypt-test-hash' } = {}) {
  const log = { queries: [], isolation: null, committed: false, rolledBack: false };
  const transactionFactory = () => ({
    async begin(isolation) { log.isolation = isolation; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          const call = { statement, values: { ...values } };
          log.queries.push(call);
          return onQuery(call);
        }
      };
    },
    async commit() { log.committed = true; },
    async rollback() { log.rolledBack = true; }
  });
  const service = createAdminService({
    getPool: async () => ({}),
    sql: fakeSql(),
    transactionFactory,
    hashPassword
  });
  return { service, log };
}

test('admin account input validation rejects invalid email, role, names, student link, and password length', () => {
  assert.throws(() => validateCreateUser({ email: 'bad', role: 'finance', password: 'long-enough-password', firstName: 'A', lastName: 'B' }), AdminServiceError);
  assert.throws(() => validateCreateUser({ email: 'a@example.edu', role: 'owner', password: 'long-enough-password', firstName: 'A', lastName: 'B' }), AdminServiceError);
  assert.throws(() => validateCreateUser({ email: 'a@example.edu', role: 'student', password: 'long-enough-password' }), /student number/);
  assert.throws(() => validateCreateUser({ email: 'a@example.edu', role: 'registrar', password: 'short', firstName: 'A', lastName: 'B' }), /12 to 72/);
  assert.throws(() => validateUpdateUser({ email: 'a@example.edu', role: 'finance', isActive: '1', firstName: 'bad\nname', lastName: 'B' }), /First and last names/);
});

test('teacher account creation and editing accept staff profile fields', () => {
  assert.deepEqual(validateCreateUser({
    email: 'teacher@example.edu', role: 'teacher', password: 'a-valid-teacher-password',
    firstName: 'Taylor', lastName: 'Teacher', department: 'English'
  }), {
    email: 'teacher@example.edu', role: 'teacher', password: 'a-valid-teacher-password',
    firstName: 'Taylor', lastName: 'Teacher', department: 'English'
  });
  assert.deepEqual(validateUpdateUser({
    email: 'teacher@example.edu', role: 'teacher', isActive: '1',
    firstName: 'Taylor', lastName: 'Teacher', department: 'English'
  }), {
    email: 'teacher@example.edu', role: 'teacher', isActive: true,
    firstName: 'Taylor', lastName: 'Teacher', department: 'English'
  });
});

test('editing a user to teacher updates the account and staff profile in one transaction', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('SELECT id, email, role, is_active FROM dbo.users')) {
      return { recordset: [{ id: 11, email: 'staff@example.edu', role: 'registrar', is_active: true }] };
    }
    if (statement.includes('SELECT id FROM dbo.staff_profiles')) return { recordset: [{ id: 33 }] };
    if (statement.startsWith('UPDATE dbo.users') || statement.startsWith('UPDATE dbo.students')
      || statement.startsWith('UPDATE dbo.staff_profiles') || statement.includes('INSERT INTO dbo.audit_logs')) {
      return { recordset: [] };
    }
    throw new Error(`Unexpected query: ${statement}`);
  });

  await service.updateUser(7, 11, {
    email: 'teacher@example.edu', role: 'teacher', isActive: '1',
    firstName: 'Taylor', lastName: 'Teacher', department: 'English'
  });
  assert.equal(log.committed, true);
  const userUpdate = log.queries.find(({ statement }) => statement.startsWith('UPDATE dbo.users'));
  const profileUpdate = log.queries.find(({ statement }) => statement.startsWith('UPDATE dbo.staff_profiles'));
  assert.equal(userUpdate.values.role, 'teacher');
  assert.equal(profileUpdate.values.firstName, 'Taylor');
  assert.equal(profileUpdate.values.lastName, 'Teacher');
});

test('user search binds an escaped email/student-number pattern and validates its length', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) { calls.push({ statement, values: { ...values } }); return { recordset: [] }; }
      };
    }
  };
  const service = createAdminService({ getPool: async () => pool, sql: fakeSql() });

  const dashboard = await service.listDashboard('acct_%[x]~');
  const userQuery = calls[0];
  assert.equal(calls.length, 1, 'the overview query does not load audit activity');
  assert.doesNotMatch(userQuery.statement, /dbo\.audit_logs/);
  assert.equal(dashboard.searchTerm, 'acct_%[x]~');
  assert.equal(userQuery.values.searchPattern, '%acct~_~%~[x~]~~%');
  assert.match(userQuery.statement, /u\.email LIKE @searchPattern/);
  assert.match(userQuery.statement, /s\.student_no LIKE @searchPattern/);
  assert.match(userQuery.statement, /SELECT TOP \(250\)/);
  assert.doesNotMatch(userQuery.statement, /acct_%\[x\]/);
  await assert.rejects(service.listDashboard('x'.repeat(101)), /100 printable characters or fewer/);
});

test('the final active database administrator cannot be demoted or deactivated', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('WHERE id = @userId')) return { recordset: [{ id: 8, email: 'admin@example.edu', role: 'database_admin', is_active: true }] };
    if (statement.includes('COUNT_BIG(*)')) return { recordset: [{ activeCount: 1 }] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await assert.rejects(service.updateUser(7, 8, {
    email: 'admin@example.edu', role: 'registrar', isActive: '1', firstName: 'Admin', lastName: 'Person'
  }), /At least one active database administrator/);
  assert.equal(log.committed, false);
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.some(({ statement }) => statement.startsWith('UPDATE dbo.users')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);
});

test('student-to-staff role changes unlink the student login and preserve the student record', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('WHERE id = @userId')) return { recordset: [{ id: 8, email: 'learner@example.edu', role: 'student', is_active: true }] };
    if (statement.includes('UPDATE dbo.users SET email')) return { recordset: [] };
    if (statement.includes('UPDATE dbo.students SET user_id = NULL')) return { recordset: [] };
    if (statement.includes('FROM dbo.staff_profiles')) return { recordset: [] };
    if (statement.includes('INSERT INTO dbo.staff_profiles')) return { recordset: [] };
    if (statement.includes('INSERT INTO dbo.audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await service.updateUser(7, 8, {
    email: 'staff@example.edu', role: 'registrar', isActive: '1', firstName: 'Jamie', lastName: 'Lee', department: 'Records'
  });
  assert.equal(log.committed, true);
  assert.ok(log.queries.some(({ statement }) => statement.includes('UPDATE dbo.students SET user_id = NULL, updated_at = SYSUTCDATETIME() WHERE user_id = @userId')));
  assert.ok(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.staff_profiles')));
  assert.ok(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')));
});

test('staff-to-student role changes link an existing student and retain the staff profile', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('WHERE id = @userId')) return { recordset: [{ id: 8, email: 'staff@example.edu', role: 'registrar', is_active: true }] };
    if (statement.includes('UPDATE dbo.users SET email')) return { recordset: [] };
    if (statement.includes('FROM dbo.students WITH (UPDLOCK, HOLDLOCK)')) return { recordset: [{ id: 51, user_id: null, status: 'active' }] };
    if (statement.includes('UPDATE dbo.students SET user_id = NULL')) return { recordset: [] };
    if (statement.includes('UPDATE dbo.students SET user_id = @userId')) return { recordset: [] };
    if (statement.includes('INSERT INTO dbo.audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await service.updateUser(7, 8, {
    email: 'learner@example.edu', role: 'student', isActive: '1', studentNo: 'STU-0051'
  });
  assert.equal(log.committed, true);
  assert.ok(log.queries.some(({ statement }) => statement.includes('UPDATE dbo.students SET user_id = @userId, updated_at = SYSUTCDATETIME() WHERE id = @studentId')));
  assert.equal(log.queries.some(({ statement }) => statement.includes('DELETE FROM dbo.staff_profiles')), false);
  assert.ok(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')));
});

test('administrator cannot link a login to an archived student record', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('WHERE id = @userId')) return { recordset: [{ id: 8, email: 'staff@example.edu', role: 'registrar', is_active: true }] };
    if (statement.includes('UPDATE dbo.users SET email')) return { recordset: [] };
    if (statement.includes('FROM dbo.students WITH (UPDLOCK, HOLDLOCK)')) return { recordset: [{ id: 51, user_id: null, status: 'archived' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await assert.rejects(service.updateUser(7, 8, {
    email: 'learner@example.edu', role: 'student', isActive: '1', studentNo: 'STU-0051'
  }), /student number is unavailable/);
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.some(({ statement }) => statement.includes('UPDATE dbo.students SET user_id = @userId')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);
});

test('an administrator cannot demote or deactivate their own account', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('WHERE id = @userId')) return { recordset: [{ id: 7, email: 'admin@example.edu', role: 'database_admin', is_active: true }] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await assert.rejects(service.updateUser(7, 7, {
    email: 'admin@example.edu', role: 'database_admin', isActive: '0', firstName: 'Admin', lastName: 'Person'
  }), /cannot change your own role or deactivate/);
  assert.equal(log.committed, false);
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.some(({ statement }) => statement.startsWith('UPDATE dbo.users')), false);
});

test('account creation writes profile and audit event in one transaction without logging password data', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('INSERT INTO dbo.users')) return { recordset: [{ id: 11 }] };
    if (statement.includes('FROM dbo.staff_profiles')) return { recordset: [] };
    if (statement.includes('INSERT INTO dbo.staff_profiles')) return { recordset: [] };
    if (statement.includes('INSERT INTO dbo.audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  }, { hashPassword: async (password, rounds) => {
    assert.equal(password, 'new-password-is-secret');
    assert.equal(rounds, 12);
    return 'bcrypt-hash-value';
  } });

  const userId = await service.createUser(7, {
    email: 'registrar@example.edu', role: 'registrar', password: 'new-password-is-secret',
    firstName: 'Riley', lastName: 'Registrar', department: 'Records'
  });
  const auditCall = log.queries.find(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs'));
  assert.equal(userId, 11);
  assert.equal(log.committed, true);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.staff_profiles')), true);
  assert.equal(auditCall.values.detailsJson, JSON.stringify({ role: 'registrar' }));
  assert.equal(JSON.stringify(auditCall.values).includes('new-password-is-secret'), false);
  assert.equal(JSON.stringify(auditCall.values).includes('bcrypt-hash-value'), false);
});

test('database administrator read matrix permits staff workspaces and denies student self-service in a mocked HTTP app', async () => {
  const calls = [];
  const studentRecordsService = {
    async listWorkspace(search, termId) {
      calls.push(['listWorkspace', search, termId]);
      return { students: [], terms: [], sections: [], searchTerm: '', academicTermId: null };
    },
    async getOwnStudentRecord() {
      calls.push(['getOwnStudentRecord']);
      return null;
    },
    async getStudentDashboardSummary() {
      calls.push(['getStudentDashboardSummary']);
      return null;
    }
  };
  const documentService = {
    async listDocuments(actorId) {
      calls.push(['listDocuments', actorId]);
      return { documents: [], searchTerm: '', isStaff: true, form137Status: { status: 'not_recorded', instruction: null, created_at: null } };
    }
  };
  const financeService = {
    async searchStudents(searchTerm) {
      calls.push(['searchFinanceStudents', searchTerm]);
      return { students: [], searchTerm: '' };
    },
    async getDashboardSummary(actorId) {
      calls.push(['financeSummary', actorId]);
      return {};
    }
  };
  const adminService = {
    async listDashboard(searchTerm) {
      calls.push(['listDashboard', searchTerm]);
      return { users: [], auditLogs: [], searchTerm };
    },
    async listAuditLogs() {
      calls.push(['listAuditLogs']);
      return [];
    },
    async getDashboardSummary(actorId) {
      calls.push(['getDashboardSummary', actorId]);
      return {
        active_user_count: 4,
        inactive_user_count: 1,
        active_student_count: 3,
        archived_student_count: 0,
        documents_awaiting_review_count: 2
      };
    }
  };

  const app = createApp({
    databasePool: createAuthPool('database_admin'),
    environment: testEnvironment,
    adminService,
    studentRecordsService,
    financeService,
    documentService,
    documentProcessingService: { schedulePendingProcessing() {} },
    form137ScanService: { async scan() { throw new Error('No scan operation is expected in this read-only matrix.'); } }
  });

  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin@example.edu');
    const cases = [
      ['/admin', 200, /Database Admin Dashboard/],
      ['/admin/audit', 200, /Audit activity/],
      ['/records', 200, /Student Records/],
      ['/documents', 200, /Documents/],
      ['/finance', 200, /Finance Workspace/],
      ['/dashboard/student', 403, null]
    ];

    for (const [route, expectedStatus, expectedContent] of cases) {
      const response = await fetch(`${baseUrl}${route}`, { headers: { cookie } });
      assert.equal(response.status, expectedStatus, `${route} should return HTTP ${expectedStatus}`);
      if (expectedContent) assert.match(await response.text(), expectedContent);
    }

    assert.deepEqual(calls, [
      ['listDashboard', ''],
      ['getDashboardSummary', 7],
      ['listAuditLogs'],
      ['listWorkspace', '', ''],
      ['listDocuments', 7],
      ['searchFinanceStudents', ''],
      ['financeSummary', 7]
    ], 'only read services for database-admin workspaces run; student self-service stays denied');
  });
});

test('non-admin role receives 403 for admin routes without loading admin data', async () => {
  let dashboardReads = 0;
  const adminService = {
    async listDashboard() { dashboardReads += 1; return { users: [] }; },
    async listAuditLogs() { dashboardReads += 1; return []; }
  };
  await withServer(createApp({ databasePool: createAuthPool('registrar'), environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar@example.edu');
    for (const route of ['/admin', '/admin/audit']) {
      const response = await fetch(`${baseUrl}${route}`, { headers: { cookie } });
      assert.equal(response.status, 403);
    }
    assert.equal(dashboardReads, 0);
  });
});

test('a signed-in staff session does not gain administrator access after a role upgrade', async () => {
  let dashboardReads = 0;
  const pool = createAuthPool('registrar');
  const adminService = { async listDashboard() { dashboardReads += 1; return { users: [], auditLogs: [] }; } };
  await withServer(createApp({ databasePool: pool, environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar@example.edu');
    pool.user.role = 'database_admin';
    const response = await fetch(`${baseUrl}/admin`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
    assert.equal(dashboardReads, 0);
  });
});

test('admin mutations reject missing CSRF tokens before calling the service', async () => {
  let creates = 0;
  const adminService = { async createUser() { creates += 1; return 44; } };
  await withServer(createApp({ databasePool: createAuthPool('database_admin'), environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin@example.edu');
    const response = await postForm(baseUrl, '/admin/users', cookie, { email: 'new@example.edu' });
    assert.equal(response.status, 403);
    assert.equal(creates, 0);
  });
});

test('invalid account form data is rejected before account creation', async () => {
  let serviceDatabaseReads = 0;
  const adminService = createAdminService({
    getPool: async () => { serviceDatabaseReads += 1; return {}; },
    sql: fakeSql()
  });
  await withServer(createApp({ databasePool: createAuthPool('database_admin'), environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin@example.edu');
    const page = await fetch(`${baseUrl}/admin/users/new`, { headers: { cookie } });
    const token = csrfFromHtml(await page.text());
    const response = await postForm(baseUrl, '/admin/users', cookie, {
      _csrf: token,
      email: 'invalid-email',
      role: 'registrar',
      password: 'not-a-valid-password',
      confirmPassword: 'not-a-valid-password',
      firstName: 'Casey',
      lastName: 'Staff'
    });
    const html = await response.text();
    assert.equal(response.status, 400);
    assert.match(html, /Enter a valid email address/);
    assert.equal(serviceDatabaseReads, 0);
  });
});

test('create and reset forms reject mismatched passwords without returning submitted values', async () => {
  let createCalls = 0;
  let resetCalls = 0;
  const adminService = {
    async createUser() { createCalls += 1; return 44; },
    async getUser() {
      return { id: 44, email: 'user@example.edu', role: 'registrar', is_active: true };
    },
    async resetPassword() { resetCalls += 1; }
  };

  await withServer(createApp({ databasePool: createAuthPool('database_admin'), environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin@example.edu');
    const createPage = await fetch(`${baseUrl}/admin/users/new`, { headers: { cookie } });
    const createPageHtml = await createPage.text();
    assert.match(createPageHtml, /data-password-match-form/);
    assert.match(createPageHtml, /id="confirm-password-mismatch"[^>]*data-password-mismatch-message/);

    const newPassword = 'New-Password-Is-Secret-1';
    const differentConfirmation = 'Different-Secret-Password-2';
    const createResponse = await postForm(baseUrl, '/admin/users', cookie, {
      _csrf: csrfFromHtml(createPageHtml),
      email: 'new@example.edu',
      role: 'registrar',
      firstName: 'Casey',
      lastName: 'Staff',
      password: newPassword,
      confirmPassword: differentConfirmation
    });
    const createHtml = await createResponse.text();
    assert.equal(createResponse.status, 400);
    assert.match(createHtml, /Passwords do not match\./);
    assert.equal(createHtml.includes(newPassword), false);
    assert.equal(createHtml.includes(differentConfirmation), false);
    assert.equal(createCalls, 0);

    const editPage = await fetch(`${baseUrl}/admin/users/44/edit`, { headers: { cookie } });
    const editPageHtml = await editPage.text();
    assert.match(editPageHtml, /data-password-match-form/);
    assert.match(editPageHtml, /id="new-password-mismatch"[^>]*data-password-mismatch-message/);

    const resetResponse = await postForm(baseUrl, '/admin/users/44/password', cookie, {
      _csrf: csrfFromHtml(editPageHtml),
      password: newPassword,
      confirmPassword: differentConfirmation
    });
    const resetHtml = await resetResponse.text();
    assert.equal(resetResponse.status, 400);
    assert.match(resetHtml, /Passwords do not match\./);
    assert.equal(resetHtml.includes(newPassword), false);
    assert.equal(resetHtml.includes(differentConfirmation), false);
    assert.equal(resetCalls, 0);
  });
});

test('audit viewer omits stored detail JSON', async () => {
  const adminService = {
    async listDashboard() {
      throw new Error('The audit route must not load overview data.');
    },
    async listAuditLogs() {
      return [{ id: 1, actor_email: 'database_admin@example.edu', action: 'admin.user_created', entity_type: 'user', entity_id: '9', details_json: '{"password":"must-not-render"}' }];
    }
  };
  await withServer(createApp({ databasePool: createAuthPool('database_admin'), environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin@example.edu');
    const response = await fetch(`${baseUrl}/admin/audit`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Admin · user created/);
    assert.doesNotMatch(html, /must-not-render/);
  });
});
