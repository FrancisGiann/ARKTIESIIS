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
    if (statement.includes('SELECT id, email, role, is_active FROM users')) {
      return { recordset: [{ id: 11, email: 'staff@example.edu', role: 'registrar', is_active: true }] };
    }
    if (statement.includes('SELECT id FROM staff_profiles')) return { recordset: [{ id: 33 }] };
    if (statement.startsWith('UPDATE users') || statement.startsWith('UPDATE two_factor_codes')
      || statement.startsWith('UPDATE password_reset_tokens') || statement.startsWith('UPDATE pending_email_changes')
      || statement.startsWith('UPDATE students')
      || statement.startsWith('UPDATE staff_profiles') || statement.includes('INSERT INTO audit_logs')) {
      return { recordset: [] };
    }
    throw new Error(`Unexpected query: ${statement}`);
  });

  await service.updateUser(7, 11, {
    email: 'teacher@example.edu', role: 'teacher', isActive: '1',
    firstName: 'Taylor', lastName: 'Teacher', department: 'English'
  });
  assert.equal(log.committed, true);
  const userUpdate = log.queries.find(({ statement }) => statement.startsWith('UPDATE users'));
  const profileUpdate = log.queries.find(({ statement }) => statement.startsWith('UPDATE staff_profiles'));
  assert.equal(userUpdate.values.role, 'teacher');
  assert.equal(profileUpdate.values.firstName, 'Taylor');
  assert.equal(profileUpdate.values.lastName, 'Teacher');
});

test('student account directory uses separated filters, escaped search, and 25-row pagination beyond 250 accounts', async () => {
  const calls = [];
  let queryCount = 0;
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          queryCount += 1;
          return statement.includes('COUNT(*)')
            ? { recordset: [{ total_records: 1374 }] }
            : { recordset: [{ id: 1300, display_name: 'A Student', student_no: 'S-1300' }] };
        }
      };
    }
  };
  const service = createAdminService({ getPool: async () => pool, sql: fakeSql() });

  const directory = await service.listAccounts({ category: 'students', status: 'inactive', search: 'acct_%[x]~', page: '11' });
  const countQuery = calls[0];
  const accountQuery = calls[1];
  assert.equal(queryCount, 2);
  assert.equal(directory.filters.searchTerm, 'acct_%[x]~');
  assert.equal(directory.pagination.totalRecords, 1374);
  assert.deepEqual(directory.pagination, { page: 11, pageSize: 25, totalRecords: 1374, totalPages: 55, from: 251, to: 275 });
  assert.equal(accountQuery.values.searchPattern, '%acct~_~%~[x~]~~%');
  assert.equal(accountQuery.values.pageSize, 25);
  assert.equal(accountQuery.values.offset, 250);
  assert.match(countQuery.statement, /u\.role = 'student'/);
  assert.match(accountQuery.statement, /u\.is_active = 0/);
  assert.match(accountQuery.statement, /u\.email LIKE @searchPattern/);
  assert.match(accountQuery.statement, /s\.student_no LIKE @searchPattern/);
  assert.match(accountQuery.statement, /CONCAT_WS\(' ', NULLIF\(TRIM\(s\.first_name\)/);
  assert.match(accountQuery.statement, /ORDER BY u\.created_at DESC, u\.id DESC\s+LIMIT @pageSize OFFSET @offset/);
  assert.doesNotMatch(accountQuery.statement, /LIMIT 250/);
  assert.doesNotMatch(accountQuery.statement, /acct_%\[x\]/);
  await assert.rejects(service.listAccounts({ search: 'x'.repeat(101) }), /100 printable characters or fewer/);
  await assert.rejects(service.listAccounts({ search: ['one', 'two'] }), /100 printable characters or fewer/);
  for (const page of [['2'], { requested: '2' }]) {
    const invalidPage = await service.listAccounts({ category: 'students', page });
    assert.equal(invalidPage.pagination.page, 1);
    assert.equal(calls.at(-1).values.offset, 0);
  }
});

test('staff directory applies approved role and active status and safely clamps pages', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          return statement.includes('COUNT(*)') ? { recordset: [{ total_records: 52 }] } : { recordset: [] };
        }
      };
    }
  };
  const service = createAdminService({ getPool: async () => pool, sql: fakeSql() });
  const directory = await service.listAccounts({ category: 'staff', role: 'teacher', status: 'active', page: '9999999999' });
  assert.match(calls[0].statement, /u\.role IN \('database_admin', 'registrar', 'finance', 'teacher'\)/);
  assert.match(calls[1].statement, /u\.role = @role/);
  assert.match(calls[1].statement, /u\.is_active = 1/);
  assert.equal(calls[1].values.role, 'teacher');
  assert.equal(calls[1].values.offset, 50);
  assert.equal(directory.pagination.page, 3);
  assert.equal(directory.pagination.totalPages, 3);
  assert.deepEqual(directory.pagination, { page: 3, pageSize: 25, totalRecords: 52, totalPages: 3, from: 51, to: 52 });
  assert.doesNotMatch(calls[1].statement, /s\.student_no LIKE/);
  await assert.rejects(service.listAccounts({ category: 'students', role: 'teacher' }), /valid staff role/);
  await assert.rejects(service.listAccounts({ category: 'staff', role: 'owner' }), /valid staff role/);
  await assert.rejects(service.listAccounts({ status: 'enabled' }), /valid account status/);
});

test('audit directory searches actor/action, filters known categories, omits details, and clamps pagination', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          return statement.includes('COUNT(*)') ? { recordset: [{ total_records: 51 }] } : { recordset: [{ id: 88, actor_email: 'staff@example.edu', action: 'registrar.form137_status_recorded' }] };
        }
      };
    }
  };
  const service = createAdminService({ getPool: async () => pool, sql: fakeSql() });
  const result = await service.listAuditLogs({ category: 'documents', search: 'actor_%[x]~', page: '9999' });
  assert.equal(result.pagination.page, 3);
  assert.equal(result.pagination.from, 51);
  assert.equal(calls[1].values.offset, 50);
  assert.equal(calls[1].values.pageSize, 25);
  assert.equal(calls[1].values.searchPattern, '%actor~_~%~[x~]~~%');
  assert.match(calls[1].statement, /form137_status/);
  assert.match(calls[1].statement, /previous_school_report_card_physical_status/);
  assert.match(calls[1].statement, /student_document_request/);
  assert.match(calls[1].statement, /student_physical_checklist/);
  assert.match(calls[1].statement, /actor\.email LIKE @searchPattern/);
  assert.match(calls[1].statement, /a\.action LIKE @searchPattern/);
  assert.match(calls[1].statement, /ORDER BY a\.created_at DESC, a\.id DESC/);
  assert.doesNotMatch(calls[1].statement, /details_json/);
  await service.listAuditLogs({ category: 'other' });
  assert.match(calls[3].statement, /a\.entity_type IS NULL OR a\.entity_type NOT IN/);
  await assert.rejects(service.listAuditLogs({ category: 'secret' }), /valid audit category/);
  await assert.rejects(service.listAuditLogs({ search: {} }), /100 printable characters or fewer/);
});

test('the final active database administrator cannot be demoted or deactivated', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('WHERE id = @userId')) return { recordset: [{ id: 8, email: 'admin@example.edu', role: 'database_admin', is_active: true }] };
    if (statement.includes('role = @adminRole AND is_active = 1 FOR UPDATE')) return { recordset: [{ id: 8 }] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await assert.rejects(service.updateUser(7, 8, {
    email: 'admin@example.edu', role: 'registrar', isActive: '1', firstName: 'Admin', lastName: 'Person'
  }), /At least one active database administrator/);
  assert.equal(log.committed, false);
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.some(({ statement }) => statement.startsWith('UPDATE users')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
});

test('student-to-staff role changes unlink the student login and preserve the student record', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('WHERE id = @userId')) return { recordset: [{ id: 8, email: 'learner@example.edu', role: 'student', is_active: true }] };
    if (statement.includes('UPDATE users SET email')) return { recordset: [] };
    if (statement.startsWith('UPDATE two_factor_codes') || statement.startsWith('UPDATE password_reset_tokens') || statement.startsWith('UPDATE pending_email_changes')) return { recordset: [] };
    if (statement.includes('UPDATE students SET user_id = NULL')) return { recordset: [] };
    if (statement.includes('FROM staff_profiles')) return { recordset: [] };
    if (statement.includes('INSERT INTO staff_profiles')) return { recordset: [] };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await service.updateUser(7, 8, {
    email: 'staff@example.edu', role: 'registrar', isActive: '1', firstName: 'Jamie', lastName: 'Lee', department: 'Records'
  });
  assert.equal(log.committed, true);
  assert.ok(log.queries.some(({ statement }) => statement.includes('UPDATE students SET user_id = NULL, updated_at = UTC_TIMESTAMP(6) WHERE user_id = @userId')));
  assert.ok(log.queries.some(({ statement }) => statement.includes('INSERT INTO staff_profiles')));
  assert.ok(log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')));
});

test('staff-to-student role changes link an existing student and retain the staff profile', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('WHERE id = @userId')) return { recordset: [{ id: 8, email: 'staff@example.edu', role: 'registrar', is_active: true }] };
    if (statement.includes('UPDATE users SET email')) return { recordset: [] };
    if (statement.startsWith('UPDATE two_factor_codes') || statement.startsWith('UPDATE password_reset_tokens') || statement.startsWith('UPDATE pending_email_changes')) return { recordset: [] };
    if (statement.includes('FROM students WHERE student_no = @studentNo FOR UPDATE')) return { recordset: [{ id: 51, user_id: null, status: 'active' }] };
    if (statement.includes('UPDATE students SET user_id = NULL')) return { recordset: [] };
    if (statement.includes('UPDATE students SET user_id = @userId')) return { recordset: [] };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await service.updateUser(7, 8, {
    email: 'learner@example.edu', role: 'student', isActive: '1', studentNo: 'STU-0051'
  });
  assert.equal(log.committed, true);
  assert.ok(log.queries.some(({ statement }) => statement.includes('UPDATE students SET user_id = @userId, updated_at = UTC_TIMESTAMP(6) WHERE id = @studentId')));
  assert.equal(log.queries.some(({ statement }) => statement.includes('DELETE FROM staff_profiles')), false);
  assert.ok(log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')));
});

test('administrator cannot link a login to an archived student record', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('WHERE id = @userId')) return { recordset: [{ id: 8, email: 'staff@example.edu', role: 'registrar', is_active: true }] };
    if (statement.includes('UPDATE users SET email')) return { recordset: [] };
    if (statement.startsWith('UPDATE two_factor_codes') || statement.startsWith('UPDATE password_reset_tokens') || statement.startsWith('UPDATE pending_email_changes')) return { recordset: [] };
    if (statement.includes('FROM students WHERE student_no = @studentNo FOR UPDATE')) return { recordset: [{ id: 51, user_id: null, status: 'archived' }] };
    throw new Error(`Unexpected query: ${statement}`);
  });

  await assert.rejects(service.updateUser(7, 8, {
    email: 'learner@example.edu', role: 'student', isActive: '1', studentNo: 'STU-0051'
  }), /student number is unavailable/);
  assert.equal(log.rolledBack, true);
  assert.equal(log.queries.some(({ statement }) => statement.includes('UPDATE students SET user_id = @userId')), false);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
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
  assert.equal(log.queries.some(({ statement }) => statement.startsWith('UPDATE users')), false);
});

test('account creation writes profile and audit event in one transaction without logging password data', async () => {
  const { service, log } = transactionalService(({ statement }) => {
    if (statement.includes('WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
    if (statement.includes('INSERT INTO users')) return { insertId: 11 };
    if (statement.includes('FROM staff_profiles')) return { recordset: [] };
    if (statement.includes('INSERT INTO staff_profiles')) return { recordset: [] };
    if (statement.includes('INSERT INTO audit_logs')) return { recordset: [] };
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
  const auditCall = log.queries.find(({ statement }) => statement.includes('INSERT INTO audit_logs'));
  assert.equal(userId, 11);
  assert.equal(log.committed, true);
  assert.equal(log.queries.some(({ statement }) => statement.includes('INSERT INTO staff_profiles')), true);
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
    async listAccounts(filters) {
      calls.push(['listAccounts', { ...filters }]);
      return { users: [], filters: { category: filters.category || 'students', role: filters.role || '', status: filters.status || 'all', searchTerm: filters.search || '' }, pagination: { page: 1, pageSize: 25, totalRecords: 0, totalPages: 1, from: 0, to: 0 } };
    },
    async listAuditLogs(filters) {
      calls.push(['listAuditLogs', { ...filters }]);
      return { events: [], filters: { category: filters.category || 'all', searchTerm: filters.search || '' }, pagination: { page: 1, pageSize: 25, totalRecords: 0, totalPages: 1, from: 0, to: 0 } };
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
    annualFinanceService: {
      async listRoster() { calls.push(['annualFinanceRoster']); return { rows: [], options: { schoolYears: [], terms: [], sections: [] } }; }
    },
    documentService,
    documentProcessingService: { schedulePendingProcessing() {} },
    form137ScanService: { async scan() { throw new Error('No scan operation is expected in this read-only matrix.'); } }
  });

  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin@example.edu');
    const cases = [
      ['/admin', 200, /Database Admin Dashboard/],
      ['/admin/users?category=staff', 200, /Staff accounts/],
      ['/admin/audit', 200, /Audit activity/],
      ['/registrar/records', 200, /Student Records/],
      ['/documents', 200, /Documents/],
      ['/finance', 200, /Annual finance roster/],
      ['/student', 403, null]
    ];

    for (const [route, expectedStatus, expectedContent] of cases) {
      const response = await fetch(`${baseUrl}${route}`, { headers: { cookie } });
      assert.equal(response.status, expectedStatus, `${route} should return HTTP ${expectedStatus}`);
      if (expectedContent) assert.match(await response.text(), expectedContent);
    }

    assert.deepEqual(calls, [
      ['listAccounts', { category: 'staff' }],
      ['listAuditLogs', {}],
      ['listWorkspace', '', ''],
      ['listDocuments', 7],
      ['annualFinanceRoster']
    ], 'only read services for database-admin workspaces run; student self-service stays denied');
  });
});

test('non-admin role receives 403 for admin routes without loading admin data', async () => {
  let dashboardReads = 0;
  const adminService = {
    async listAccounts() { dashboardReads += 1; return {}; },
    async listAuditLogs() { dashboardReads += 1; return {}; }
  };
  await withServer(createApp({ databasePool: createAuthPool('registrar'), environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar@example.edu');
    for (const route of ['/admin', '/admin/users', '/admin/audit']) {
      const response = await fetch(`${baseUrl}${route}`, { headers: { cookie } });
      assert.equal(response.status, 403);
    }
    assert.equal(dashboardReads, 0);
  });
});

test('a signed-in staff session does not gain administrator access after a role upgrade', async () => {
  let dashboardReads = 0;
  const pool = createAuthPool('registrar');
  const adminService = { async listAccounts() { dashboardReads += 1; return {}; } };
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

test('admin account creation maps a MariaDB duplicate-key error to a conflict response', async () => {
  const adminService = {
    async createUser() {
      throw Object.assign(new Error('duplicate key'), { code: 'ER_DUP_ENTRY', errno: 1062 });
    }
  };

  await withServer(createApp({ databasePool: createAuthPool('database_admin'), environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin@example.edu');
    const page = await fetch(`${baseUrl}/admin/users/new`, { headers: { cookie } });
    const html = await page.text();
    const response = await postForm(baseUrl, '/admin/users', cookie, {
      _csrf: csrfFromHtml(html),
      email: 'existing@example.edu',
      role: 'registrar',
      password: 'Valid-Password-For-Test-1',
      confirmPassword: 'Valid-Password-For-Test-1',
      firstName: 'Casey',
      lastName: 'Staff'
    });
    const responseHtml = await response.text();
    assert.equal(response.status, 409);
    assert.match(responseHtml, /An account with that email already exists/);
    assert.doesNotMatch(responseHtml, /duplicate key|ER_DUP_ENTRY/);
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
    async listAuditLogs() {
      return {
        events: [{ id: 1, user_id: 7, actor_email: 'database_admin@example.edu', action: 'admin.user_created', entity_type: 'user', entity_id: '9', created_at: '2026-10-02 00:00:03', details_json: '{"password":"must-not-render"}' }],
        filters: { category: 'all', searchTerm: '' },
        pagination: { page: 1, pageSize: 25, totalRecords: 1, totalPages: 1, from: 1, to: 1 }
      };
    }
  };
  await withServer(createApp({ databasePool: createAuthPool('database_admin'), environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin@example.edu');
    const response = await fetch(`${baseUrl}/admin/audit`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Admin · user created/);
    assert.match(html, /Date and time · Manila \(PHT\)/);
    assert.match(html, /08:00:03 AM/);
    assert.doesNotMatch(html, /must-not-render/);
  });
});

test('account directory routes to separate lists, marks Accounts current, and preserves filters in pagination', async () => {
  const requests = [];
  const adminService = {
    async listAccounts(filters) {
      requests.push(filters);
      const category = filters.category || 'students';
      const staff = category === 'staff';
      const totalRecords = 51;
      const page = Math.min(Number(filters.page) || 1, 3);
      return {
        users: [{ id: 88, display_name: staff ? 'Taylor Teacher' : 'Alex Student', email: staff ? 'teacher@example.edu' : 'student@example.edu', role: staff ? 'teacher' : 'student', is_active: true, student_no: 'S-88', department: 'English' }],
        filters: { category, role: filters.role || '', status: filters.status || 'all', searchTerm: filters.search || '' },
        pagination: { page, pageSize: 25, totalRecords, totalPages: 3, from: (page - 1) * 25 + 1, to: Math.min(page * 25, totalRecords) }
      };
    }
  };
  await withServer(createApp({ databasePool: createAuthPool('database_admin'), environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin@example.edu');
    const students = await fetch(`${baseUrl}/admin/users`, { headers: { cookie } });
    const studentsHtml = await students.text();
    assert.equal(students.status, 200);
    assert.match(studentsHtml, /href="\/admin\/users" aria-current="page"/);
    assert.match(studentsHtml, /Student accounts/);
    assert.match(studentsHtml, /Alex Student/);
    assert.doesNotMatch(studentsHtml, /Taylor Teacher/);
    assert.doesNotMatch(studentsHtml, /data-label="Role"/);

    const staff = await fetch(`${baseUrl}/admin/users?category=staff&role=teacher&status=inactive&search=teacher%40example.edu&page=2`, { headers: { cookie } });
    const staffHtml = await staff.text();
    assert.equal(staff.status, 200);
    assert.match(staffHtml, /Staff accounts/);
    assert.match(staffHtml, /data-label="Role">Teacher/);
    assert.match(staffHtml, /value="teacher" selected/);
    assert.match(staffHtml, /value="inactive" selected/);
    assert.match(staffHtml, /rel="next" href="\/admin\/users\?category=staff&amp;role=teacher&amp;status=inactive&amp;search=teacher%40example.edu&amp;page=3"/);
    assert.match(staffHtml, /rel="prev" href="\/admin\/users\?category=staff&amp;role=teacher&amp;status=inactive&amp;search=teacher%40example.edu&amp;page=1"/);
    assert.equal(requests.length, 2);
  });
});

test('invalid account filters are rejected and legacy overview search opens the student directory', async () => {
  let reads = 0;
  const adminService = { async listAccounts() { reads += 1; throw new AdminServiceError('Choose a valid account status.'); } };
  await withServer(createApp({ databasePool: createAuthPool('database_admin'), environment: testEnvironment, adminService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin@example.edu');
    const invalid = await fetch(`${baseUrl}/admin/users?category=staff&status=active&status=inactive`, { headers: { cookie } });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /Choose a valid account status\./);
    assert.equal(reads, 1);
    const legacy = await fetch(`${baseUrl}/admin?search=some%20student`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(legacy.status, 303);
    assert.equal(legacy.headers.get('location'), '/admin/users?category=students&search=some%20student');
  });
});
