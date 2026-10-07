const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');
const { buildNavigation } = require('../src/middleware/navigation');

const passwordHash = bcrypt.hashSync('Correct-Horse-Battery-12', 4);
const environment = {
  nodeEnv: 'development',
  devPasswordOnlyLogin: true,
  sessionSecret: 'navigation-test-session-secret'
};

function createAuthPool(role) {
  const user = {
    id: 7,
    email: `${role}@example.edu`,
    password_hash: passwordHash,
    role,
    is_active: true,
    updated_at_fingerprint: ''
  };
  const getPool = async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          if (statement.includes('WHERE email = @email')) return { recordset: [user] };
          if (statement.includes('WHERE id = @userId')) return { recordset: [{ ...user }] };
          throw new Error(`Unexpected auth query: ${statement}`);
        }
      };
    }
  });
  getPool.user = user;
  return getPool;
}

function services({ ownStudentRecords = null } = {}) {
  return {
    preEnrollmentService: {
      async list() {
        return { rows: [], filters: { search: '', schoolYear: '', status: '' },
          pagination: { page: 1, pageSize: 20, totalRecords: 0, totalPages: 1, from: 0, to: 0 } };
      }
    },
    teacherGradeSubmissionService: {
      async listTeacherAssignments() { return []; }
    },
    adminService: {
      async listAccounts(filters = {}) {
        return {
          users: [],
          filters: { category: filters.category || 'students', role: filters.role || '', status: filters.status || 'all', searchTerm: filters.search || '' },
          pagination: { page: 1, pageSize: 25, totalRecords: 0, totalPages: 1, from: 0, to: 0 }
        };
      },
      async listAuditLogs(filters = {}) {
        return { events: [], filters: { category: filters.category || 'all', searchTerm: filters.search || '' }, pagination: { page: 1, pageSize: 25, totalRecords: 0, totalPages: 1, from: 0, to: 0 } };
      },
      async getDashboardSummary() {
        return {
          active_user_count: 4,
          inactive_user_count: 1,
          active_student_count: 3,
          archived_student_count: 0,
          documents_awaiting_review_count: 2
        };
      }
    },
    studentRecordsService: {
      async listWorkspace() { return { students: [], terms: [], sections: [], searchTerm: '', academicTermId: null }; },
      async getRegistrarDashboardSummary() { return null; },
      async getStudent(id) {
        return { student: { id, student_no: 'S-22', first_name: 'Alex', last_name: 'Kim', status: 'active' }, terms: [], sections: [], enrollments: [] };
      },
      async getOwnStudentRecord() { return ownStudentRecords; }
    },
    registrarDashboardService: {
      async getDashboard() {
        return {
          configuredTerms: [], schoolYears: [], schoolYearTerms: [], selectedSchoolYear: '', selectedTerm: null,
          activeEnrolledCount: null, pendingActivationCount: 0, departedCount: 0, droppedCount: 0, transferredCount: 0,
          everFinalizedCount: 0, termCounts: [], needsTermSelection: true
        };
      }
    },
    academicRecordsService: {
      async listSubjects() { return []; },
      async getStudentAcademicRecord(id) {
        return { student: { id, student_no: 'S-22', first_name: 'Alex', last_name: 'Kim', status: 'active' }, enrollments: [], subjects: [] };
      },
      async getOwnGrades() { return []; }
    },
    financeService: {
      async searchStudents(searchTerm) { return { students: [], searchTerm }; },
      async getDashboardSummary() { return { account_count: 0, accounts_due_count: 0, accounts_settled_count: 0, accounts_credit_count: 0, charge_count: 0, payment_count: 0 }; },
      async getOwnStudentAccount() { return { account: null, transactions: [] }; },
      async getStudentAccount() {
        return {
          student: { student_id: 22, student_no: 'S-22', first_name: 'Alex', last_name: 'Kim' },
          account: null,
          transactions: []
        };
      }
    },
    annualFinanceService: {
      async listRoster() { return { rows: [], options: { schoolYears: [], terms: [], sections: [] } }; },
      async getStudentLedger() { return { terms: [] }; }
    },
    classScheduleService: { async getOwnStudentSchedule() { return []; } }
  };
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function sessionCookie(response) {
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

async function signIn(baseUrl, role) {
  const loginPage = await fetch(`${baseUrl}/login`);
  const token = csrfFromHtml(await loginPage.text());
  const response = await postForm(baseUrl, '/login', sessionCookie(loginPage), {
    _csrf: token,
    email: `${role}@example.edu`,
    password: 'Correct-Horse-Battery-12'
  });
  assert.equal(response.status, 303);
  return sessionCookie(response);
}

function navigationLabels(html) {
  const nav = html.match(/<aside class="desktop-nav"[\s\S]*?<\/aside>/);
  assert.ok(nav, 'expected authenticated app navigation');
  return [...nav[0].matchAll(/class="app-nav__link[^\"]*"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((match) => match[1].replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim());
}

test('student section navigation uses real server pages with path-specific current state', () => {
  const destinations = [
    ['/student', 'home', '/student'],
    ['/student/schedule', 'schedule', '/student/schedule'],
    ['/student/grades', 'grades', '/student/grades'],
    ['/student/finance', 'finance', '/student/finance'],
    ['/student/records', 'records', '/student/records'],
    ['/documents', 'documents', '/documents']
  ];
  for (const [path, expectedId, expectedHref] of destinations) {
    const navigation = buildNavigation('student', path);
    const current = navigation.items.filter((item) => item.current);
    assert.deepEqual(current.map((item) => item.id), [expectedId], `${path} marks only its destination`);
    assert.equal(navigation.currentPage, expectedId);
    assert.equal(navigation.items.find((item) => item.id === expectedId).href, expectedHref);
  }
  const links = buildNavigation('student').items.filter((item) => item.id !== 'account');
  assert.ok(links.every((item) => !item.href.includes('#')), 'student navigation destinations are not in-page anchors');
  assert.equal(buildNavigation('registrar', '//').currentPage, null, 'malformed network-path input does not make navigation throw');
});

test('return evaluations keep Student records selected for both staff roles', () => {
  const contexts = [
    '/registrar/records/return-evaluations/new',
    '/registrar/records/return-evaluations/123e4567-e89b-12d3-a456-426614174000',
    '/registrar/records/students/22/return-evaluations/new',
    '/registrar/records/students/22/return-evaluations/123e4567-e89b-12d3-a456-426614174000'
  ];
  for (const role of ['registrar', 'database_admin']) {
    for (const path of contexts) {
      const navigation = buildNavigation(role, path);
      assert.equal(navigation.currentPage, 'students', `${role} at ${path} remains in Student records`);
      assert.deepEqual(navigation.items.filter((item) => item.id === 'students').map((item) => item.current), [true]);
      assert.ok(!navigation.items.some((item) => item.id === 'readmissions'));
    }
  }
});

test('finance navigation keeps student accounts selected for annual accounts, statements, and historic confirmations', () => {
  const contexts = [
    ['/finance/overview', 'finance-overview', '/finance/overview'],
    ['/finance', 'finance-roster', '/finance'],
    ['/finance/schedules', 'finance-schedules', '/finance/schedules'],
    ['/finance/reports', 'finance-reports', '/finance/reports'],
    ['/finance/departures', 'finance-departures', '/finance/departures'],
    ['/finance/students/22', 'finance-roster', '/finance'],
    ['/finance/students/22/annual', 'finance-roster', '/finance'],
    ['/finance/students/22/statement', 'finance-roster', '/finance'],
    ['/finance/students/22/legacy/payments/105/confirmation', 'finance-roster', '/finance']
  ];

  for (const role of ['finance', 'database_admin']) {
    for (const [path, expectedId, expectedHref] of contexts) {
      const navigation = buildNavigation(role, path);
      const current = navigation.items.filter((item) => item.current);
      assert.deepEqual(current.map((item) => item.id), [expectedId], `${role} at ${path} marks only its destination`);
      assert.equal(navigation.currentPage, expectedId);
      assert.equal(navigation.items.find((item) => item.id === expectedId).href, expectedHref);
    }
    assert.equal(buildNavigation(role, '/finance/legacy').currentPage, null);
  }
});

test('authenticated navigation only exposes destinations available to each role', async () => {
  const cases = [
    { role: 'database_admin', path: '/admin', labels: ['Overview', 'User accounts', 'Student records', 'Pre-enrollment records', 'Activity log', 'Documents', 'Overview', 'Student accounts', 'Fee schedules', 'Reports', 'Departure review', 'Saved reviews'], hrefs: ['/admin', '/admin/users', '/registrar/records', '/pre-enrollments', '/admin/audit', '/documents', '/finance/overview', '/finance', '/finance/schedules', '/finance/reports', '/finance/departures', '/finance/review-drafts'], forbidden: [] },
    { role: 'registrar', path: '/registrar', labels: ['Overview', 'Student records', 'Enrollments', 'Pre-enrollment records', 'Document review', 'Grade review', 'Class schedules', 'Subjects', 'Teacher assignments', 'Academic setup'], forbidden: ['/finance', '/admin'] },
    { role: 'front_desk', path: '/pre-enrollments', labels: ['Pre-enrollment records'], hrefs: ['/pre-enrollments'], forbidden: ['/registrar/records', '/registrar/grade-submissions', '/finance', '/documents', '/admin'] },
    { role: 'teacher', path: '/teacher', labels: ['My classes', 'Submit grades'], forbidden: ['/registrar/records', '/registrar/grade-submissions', '/finance', '/admin'] },
    { role: 'finance', path: '/finance', labels: ['Overview', 'Student accounts', 'Fee schedules', 'Reports', 'Departure review', 'Saved reviews'], hrefs: ['/finance/overview', '/finance', '/finance/schedules', '/finance/reports', '/finance/departures', '/finance/review-drafts'], forbidden: ['/registrar/records', '/documents', '/admin'] },
    { role: 'student', path: '/student', labels: ['Home', 'Class schedule', 'Grades', 'Fees &amp; payments', 'My records', 'Documents'], forbidden: ['/registrar/records', '/finance', '/admin'] }
  ];

  for (const scenario of cases) {
    const ownStudentRecords = scenario.role === 'student'
      ? { student: { id: 22, student_no: 'SHS-2026-0001', first_name: 'Alex', last_name: 'Student' }, enrollments: [] }
      : null;
    const app = createApp({ databasePool: createAuthPool(scenario.role), environment, ...services({ ownStudentRecords }) });
    await withServer(app, async (baseUrl) => {
      const cookie = await signIn(baseUrl, scenario.role);
      const response = await fetch(`${baseUrl}${scenario.path}`, { headers: { cookie } });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.deepEqual(navigationLabels(html), scenario.labels);
      const navigation = html.match(/<aside class="desktop-nav"[\s\S]*?<\/aside>/)[0];
      const desktopGroupLabels = [...navigation.matchAll(/<section class="nav-group">\s*<h2>([^<]+)<\/h2>/g)].map((match) => match[1]);
      assert.ok(desktopGroupLabels.every((label) => !scenario.labels.includes(label)), `${scenario.role} group labels do not repeat destination labels`);
      if (scenario.role === 'database_admin') assert.deepEqual(desktopGroupLabels, ['Workspace', 'People and records', 'Activity &amp; documents', 'Finance']);
      if (scenario.role === 'registrar') assert.deepEqual(desktopGroupLabels, ['Workspace', 'Records', 'Academic work', 'Setup']);
      const mobileNavigation = html.match(/<details class="mobile-nav">([\s\S]*?)<\/details>/)?.[1];
      assert.ok(mobileNavigation, 'expected the mobile role menu');
      if (scenario.role === 'registrar') {
        const mobileGroupLabels = [...mobileNavigation.matchAll(/<section class="nav-group">\s*<h2>([^<]+)<\/h2>/g)].map((match) => match[1]);
        assert.deepEqual(mobileGroupLabels, ['Workspace', 'Records', 'Academic work', 'Setup']);
      }
      if (scenario.role === 'database_admin') {
        const mobileGroupLabels = [...mobileNavigation.matchAll(/<section class="nav-group">\s*<h2>([^<]+)<\/h2>/g)].map((match) => match[1]);
        assert.deepEqual(mobileGroupLabels, ['Workspace', 'People and records', 'Activity &amp; documents', 'Finance']);
      }
      const mobileLabels = [...mobileNavigation.matchAll(/class="mobile-nav__link[^\"]*"[^>]*>([\s\S]*?)<\/a>/g)]
        .map((match) => match[1].replace(/<[^>]+>/g, '').trim());
      assert.deepEqual(mobileLabels, scenario.labels, `${scenario.role} mobile destinations match its server-filtered desktop menu`);
      const navigationLinks = [...navigation.matchAll(/<a class="app-nav__link[^\"]*"[^>]*>[\s\S]*?<\/a>/g)];
      assert.equal(navigationLinks.length, scenario.labels.length);
      if (scenario.hrefs) {
        assert.deepEqual(navigationLinks.map((match) => match[0].match(/href="([^"]+)"/)[1]), scenario.hrefs);
      }
      for (const [index, match] of navigationLinks.entries()) {
        assert.match(match[0], new RegExp(`>${scenario.labels[index]}</a>`));
      }
      const expectedHome = { database_admin: '/admin', registrar: '/registrar', front_desk: '/front-desk', teacher: '/teacher', finance: '/finance/overview', student: '/student' }[scenario.role];
      assert.match(html, new RegExp(`<a class="brand" href="${expectedHome}" aria-label="ARKTIESIIS, Ark Technological Institute Education System Inc\\., Lucena Branch">`));
      assert.match(navigation, /<a class="app-nav__link[^\"]*" href="[^\"]+" aria-current="page"/);
      assert.match(html, /<details class="mobile-nav">\s*<summary>/, 'mobile navigation uses a keyboard-operable native disclosure');
      assert.match(html, /<a class="account-shortcut[^\"]*" href="\/account"/);
      assert.match(html, /<form method="post" action="\/logout">/);
      assert.equal((html.match(/action="\/logout"/g) || []).length, 1, 'sign-out appears only in the shared header');
      assert.ok(csrfFromHtml(html).length >= 32);
      if (scenario.role === 'database_admin') {
        assert.match(html, /Student accounts/);
        assert.match(html, /Staff accounts/);
        assert.match(html, /href="\/registrar\/records"/);
        assert.doesNotMatch(html, /Recent audit activity/);
        assert.match(html, /href="\/admin\/audit"/);
        assert.doesNotMatch(html, /System summary|admin-dashboard-summary/);
      }
      if (scenario.role === 'registrar') {
        assert.match(html, /class="registrar-work-index"/);
        assert.match(html, /href="\/registrar\/records"/);
        assert.match(html, /href="\/documents"/);
        assert.match(html, /href="\/registrar\/records\/subjects"/);
        assert.match(html, /href="\/registrar\/schedules"/);
        assert.match(html, /href="\/registrar\/grade-submissions"/);
      }
      if (scenario.role === 'teacher') {
        assert.match(html, /id="assigned-classes-title"/);
        assert.match(html, /href="\/teacher\/grades"/);
      }
      if (scenario.role === 'finance') {
        assert.match(html, /class="finance-panel"/);
        assert.match(html, /id="annual-roster-filter-title"/);
        assert.match(html, /<h2 id="annual-roster-filter-title">Find student accounts<\/h2>/);
        const main = html.match(/<main class="page-shell dashboard-page finance-page(?: [^"]*)?"[\s\S]*?<\/main>/)?.[0];
        assert.ok(main, 'finance roster should render');
        assert.doesNotMatch(main, /href="\/finance\/(?:schedules|reports|departures|legacy)"/, 'finance destinations appear once in the shared navigation');
        assert.doesNotMatch(html, /finance-dashboard-summary|Finance at a glance/);
      }
      if (scenario.role === 'student') {
        const main = html.match(/<main class="page-shell student-home"[\s\S]*?<\/main>/)?.[0];
        assert.ok(main, 'student home content should render');
        assert.match(main, /Your current school day at a glance/);
        assert.match(main, /student-quick-links/);
        assert.match(main, /href="\/student\/schedule">View full schedule/);
        assert.match(main, /href="\/student\/records">My profile/);
        for (const href of ['/student/grades', '/student/finance', '/documents']) {
          assert.match(main, new RegExp(`href="${href.replaceAll('/', '\\/')}`), `${href} is available from the student home quick links`);
        }
      }
      for (const href of scenario.forbidden) assert.doesNotMatch(html, new RegExp(`href="${href.replace('/', '\\/')}`));
    });
  }
});

test('database administrator audit page has its own current navigation destination and empty state', async () => {
  const app = createApp({ databasePool: createAuthPool('database_admin'), environment, ...services() });
  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin');
    const response = await fetch(`${baseUrl}/admin/audit`, { headers: { cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<h1>Activity log<\/h1>/);
    assert.match(html, /href="\/admin\/audit" aria-current="page"/);
    assert.match(html, /No recorded actions match these filters\./);
    const navigation = html.match(/<aside class="desktop-nav"[\s\S]*?<\/aside>/)[0];
    assert.equal((navigation.match(/aria-current="page"/g) || []).length, 1);
    assert.equal((navigation.match(/href="\/admin\/audit"/g) || []).length, 1);
  });
});

test('student overview stays concise while all destinations remain in sidebar and mobile navigation', async () => {
  const ownStudentRecords = {
    student: { student_no: 'S-22', first_name: 'Alex', last_name: 'Kim', status: 'active' },
    enrollments: []
  };
  const app = createApp({ databasePool: createAuthPool('student'), environment, ...services({ ownStudentRecords }) });
  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const response = await fetch(`${baseUrl}/student`, { headers: { cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    const main = html.match(/<main class="page-shell student-home"[\s\S]*?<\/main>/)?.[0];
    assert.ok(main);
    assert.match(main, /Today's classes/);
    assert.match(main, /student-schedule/);
    assert.match(main, /href="\/student\/schedule">View full schedule/);
    assert.match(main, /href="\/student\/records">My profile/);
    assert.match(main, /Your current school day at a glance/);
    assert.doesNotMatch(main, /student-shortcuts|Your school pages/);
    assert.match(main, /class="student-quick-links"[\s\S]*href="\/student\/grades"[\s\S]*href="\/documents"[\s\S]*href="\/student\/finance"/);
    assert.doesNotMatch(main, /₱|Approved grades|Enrollment history/);

    const destinations = ['Home', 'Class schedule', 'Grades', 'Fees &amp; payments', 'My records', 'Documents'];
    assert.deepEqual(navigationLabels(html), destinations);
    const mobileNavigation = html.match(/<details class="mobile-nav">([\s\S]*?)<\/details>/)?.[1];
    assert.ok(mobileNavigation);
    const mobileLabels = [...mobileNavigation.matchAll(/class="mobile-nav__link[^\"]*"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((match) => match[1].replace(/<[^>]+>/g, '').trim());
    assert.deepEqual(mobileLabels, destinations);
    for (const href of ['/student/schedule', '/student/grades', '/student/finance', '/student/records', '/documents']) {
      assert.ok(html.includes(`href="${href}"`), `${href} remains discoverable from the role navigation`);
    }
  });
});

test('student records use the workspace rail and show a clear no-current-term state', async () => {
  const app = createApp({ databasePool: createAuthPool('registrar'), environment, ...services() });
  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const response = await fetch(`${baseUrl}/registrar/records`, { headers: { cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<main class="page-shell dashboard-page admin-page records-page"/);
    assert.match(html, /<h1>Student records<\/h1>/);
    assert.match(html, /No academic term is marked current\./);
    assert.match(html, /href="\/pre-enrollments">Review paper forms/);
    assert.match(html, /href="\/registrar\/records\?view=setup">Academic setup/);
    assert.doesNotMatch(html, /Evaluate return without a saved record/);
    assert.match(html, /Find a student record/);
    assert.doesNotMatch(html, /<h2 id="terms-title">Academic terms/);
    assert.doesNotMatch(html, /<h2 id="sections-title">Sections/);
    assert.match(html, /name="search"/);
    assert.match(html, /name="termId"/);
    assert.ok(html.indexOf('records-context-strip') < html.indexOf('records-list-panel'));
    assert.ok(html.indexOf('No student records match these filters.') > html.indexOf('name="search"'));
    assert.doesNotMatch(html, /records-management-grid/);
    const setup = await fetch(`${baseUrl}/registrar/records?view=setup`, { headers: { cookie } });
    const setupHtml = await setup.text();
    assert.equal(setup.status, 200);
    assert.match(setupHtml, /<h1>Academic setup<\/h1>/);
    assert.match(setupHtml, /href="\/registrar\/records">Back to student records/);
    assert.match(setupHtml, /href="\/registrar\/records\?view=setup" aria-current="page">Academic setup<\/a>/);
  });
});

test('nested workspace pages mark the current destination and provide fixed parent links', async () => {
  const registrarApp = createApp({ databasePool: createAuthPool('registrar'), environment, ...services() });
  await withServer(registrarApp, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const subjects = await fetch(`${baseUrl}/registrar/records/subjects`, { headers: { cookie } });
    const subjectsHtml = await subjects.text();
    assert.match(subjectsHtml, /href="\/registrar\/records\/subjects" aria-current="page"/);
    assert.match(subjectsHtml, /class="context-back" href="\/registrar\/records"/);

    const profile = await fetch(`${baseUrl}/registrar/records/students/22/edit`, { headers: { cookie } });
    const profileHtml = await profile.text();
    assert.match(profileHtml, /class="context-back" href="\/registrar\/records"/);
    assert.match(profileHtml, /href="\/registrar\/records\/students\/22\/academic"/);

    const academic = await fetch(`${baseUrl}/registrar/records/students/22/academic`, { headers: { cookie } });
    const academicHtml = await academic.text();
    assert.match(academicHtml, /class="context-back" href="\/registrar\/records\/students\/22\/edit"/);
  });

  const adminApp = createApp({ databasePool: createAuthPool('database_admin'), environment, ...services() });
  await withServer(adminApp, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin');
    const accountForm = await fetch(`${baseUrl}/admin/users/new`, { headers: { cookie } });
    const html = await accountForm.text();
    assert.match(html, /class="app-nav__link is-current" href="\/admin\/users" aria-current="page"/);
    assert.match(html, /class="context-back" href="\/admin\/users\?category=staff"/);
  });

  const financeApp = createApp({ databasePool: createAuthPool('finance'), environment, ...services() });
  await withServer(financeApp, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const account = await fetch(`${baseUrl}/finance/students/22`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(account.status, 303);
    assert.equal(account.headers.get('location'), '/finance/students/22/annual');
  });
});

test('shared sign-out rejects invalid CSRF and destroys the session with a valid token', async () => {
  const app = createApp({ databasePool: createAuthPool('student'), environment, ...services() });
  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const page = await fetch(`${baseUrl}/student`, { headers: { cookie } });
    const html = await page.text();
    const token = csrfFromHtml(html);

    const missing = await postForm(baseUrl, '/logout', cookie, {});
    const invalid = await postForm(baseUrl, '/logout', cookie, { _csrf: 'invalid' });
    assert.equal(missing.status, 403);
    assert.equal(invalid.status, 403);

    const logout = await postForm(baseUrl, '/logout', cookie, { _csrf: token });
    assert.equal(logout.status, 303);
    assert.equal(logout.headers.get('location'), '/login');
    assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  });
});

test('using another account clears the pending verification session through a CSRF-protected post', async () => {
  const getPool = createAuthPool('registrar');
  const twoFactorService = {
    OTP_TTL_MINUTES: 5,
    async issueOtpChallenge() { return { allowed: true, codeId: 9 }; },
    async sendOtpEmail() {},
    async getActiveUser() { return { ...getPool.user }; }
  };
  const twoFactorEnvironment = {
    ...environment,
    devPasswordOnlyLogin: false,
    smtp: { host: 'mail.example.edu', from: 'noreply@example.edu' }
  };
  const app = createApp({ databasePool: getPool, environment: twoFactorEnvironment, twoFactorService, ...services() });
  await withServer(app, async (baseUrl) => {
    const loginPage = await fetch(`${baseUrl}/login`);
    const token = csrfFromHtml(await loginPage.text());
    const pending = await postForm(baseUrl, '/login', sessionCookie(loginPage), {
      _csrf: token,
      email: 'registrar@example.edu',
      password: 'Correct-Horse-Battery-12'
    });
    assert.equal(pending.headers.get('location'), '/login/verify');
    const pendingCookie = sessionCookie(pending);
    const verification = await fetch(`${baseUrl}/login/verify`, { headers: { cookie: pendingCookie } });
    const verificationHtml = await verification.text();
    assert.match(verificationHtml, /Use another account/);
    const cancelToken = csrfFromHtml(verificationHtml);

    const canceled = await postForm(baseUrl, '/login/verify/cancel', pendingCookie, { _csrf: cancelToken });
    assert.equal(canceled.status, 303);
    assert.equal(canceled.headers.get('location'), '/login');
    assert.match(canceled.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);

    const staleVerification = await fetch(`${baseUrl}/login/verify`, { headers: { cookie: pendingCookie }, redirect: 'manual' });
    assert.equal(staleVerification.status, 302);
    assert.equal(staleVerification.headers.get('location'), '/login');
  });
});
