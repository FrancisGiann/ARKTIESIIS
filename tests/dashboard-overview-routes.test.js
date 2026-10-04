const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');

const password = 'Correct-Horse-Battery-12';
const passwordHash = bcrypt.hashSync(password, 4);
const environment = {
  nodeEnv: 'development',
  devPasswordOnlyLogin: true,
  sessionSecret: 'dashboard-overview-route-test-session-secret'
};

function createAuthPool(role) {
  const user = {
    id: 7, email: `${role}@example.edu`, password_hash: passwordHash,
    role, is_active: true, updated_at_fingerprint: ''
  };
  return async () => ({
    request() {
      return {
        input() { return this; },
        async query(statement) {
          if (statement.includes('WHERE email = @email')) return { recordset: [user] };
          if (statement.includes('WHERE id = @userId')) return { recordset: [{ ...user }] };
          throw new Error(`Unexpected authentication query: ${statement}`);
        }
      };
    }
  });
}

function sessionCookie(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

function csrfFromHtml(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

function accessibleCountLink(html, accessibleName) {
  const links = [...html.matchAll(/<a href="([^"]+)" aria-label="([^"]+)">([^<]+)<\/a>/g)];
  const match = links.find((candidate) => candidate[2] === accessibleName);
  assert.ok(match, `expected accessible enrollment link: ${accessibleName}`);
  return { href: match[1].replace(/&amp;/g, '&'), text: match[3] };
}

async function signIn(baseUrl, role) {
  const page = await fetch(`${baseUrl}/login`);
  const cookie = sessionCookie(page);
  const csrf = csrfFromHtml(await page.text());
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, email: `${role}@example.edu`, password })
  });
  assert.equal(response.status, 303);
  return sessionCookie(response);
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

const registrarOverview = {
  configuredTerms: [
    { schoolYear: '2026-2027', termNumber: 1, academicTermId: 61, term: 'First Term', isCurrent: false },
    { schoolYear: '2026-2027', termNumber: 2, academicTermId: 62, term: 'Second Term', isCurrent: true }
  ],
  schoolYears: ['2026-2027'],
  schoolYearTerms: [
    { schoolYear: '2026-2027', termNumber: 1, academicTermId: 61, term: 'First Term' },
    { schoolYear: '2026-2027', termNumber: 2, academicTermId: 62, term: 'Second Term' }
  ],
  selectedSchoolYear: '2026-2027',
  selectedTerm: { schoolYear: '2026-2027', termNumber: 2, academicTermId: 62, term: 'Second Term' },
  activeEnrolledCount: 12, pendingActivationCount: 2, departedCount: 1, droppedCount: 1,
  transferredCount: 0, everFinalizedCount: 14,
  termCounts: [
    { termNumber: 1, academicTermId: 61, term: 'First Term', grade11: 8, grade12: 6 },
    { termNumber: 2, academicTermId: 62, term: 'Second Term', grade11: 7, grade12: 5 }
  ],
  needsTermSelection: false
};

const financeOverview = {
  schoolYears: ['2026-2027'], gradeLevels: ['Grade 11', 'Grade 12'],
  selectedSchoolYear: '2026-2027', selectedGrade: '', needsSchoolYearSelection: false,
  queueCounts: { documentClearance: 0, departureReview: 0, savedReviews: 0 },
  availableTerms: [{ academicTermId: 62, term: 'Second Term' }], selectedTermId: '62',
  selectedTerm: { term: 'Second Term' }, selectedInstallment: 'whole', selectedVoucher: '', selectedSectionId: '',
  sections: [], voucherCodes: ['PUB', 'ESC', 'NV'], totalEligible: 3, needsTermSelection: false,
  statusCounts: [
    { status: 'unpaid', label: 'Unpaid', count: 1 }, { status: 'partially_paid', label: 'Partially paid', count: 1 },
    { status: 'fully_paid', label: 'Fully paid', count: 0 }, { status: 'no_payment_required', label: 'No payment required', count: 0 },
    { status: 'needs_review', label: 'Needs review', count: 1 }
  ]
};

function appFor(role, calls = [], intakeRows = [], intakeOptions = { schoolYears: [], terms: [], sections: [] }, intakeTotal = intakeRows.length) {
  return createApp({
    databasePool: createAuthPool(role), environment,
    registrarDashboardService: {
      async getDashboard(actorId, filters) { calls.push(['registrar', actorId, filters]); return registrarOverview; }
    },
    financeDashboardService: {
      async getOverview(actorId, filters) { calls.push(['finance', actorId, filters]); return financeOverview; }
    },
    annualFinanceService: {
      async listRoster() { return { rows: [], options: { schoolYears: [], terms: [], sections: [] } }; }
    },
    annualEnrollmentService: {
      async listAnnualEnrollmentsPage(actorId, filters) {
        calls.push(['intakeRows', actorId, filters]);
        const totalPages = Math.max(1, Math.ceil(intakeTotal / 20));
        const page = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
        return { rows: intakeRows, pagination: {
          page, pageSize: 20, totalRecords: intakeTotal, totalPages,
          from: intakeTotal ? (page - 1) * 20 + 1 : 0,
          to: intakeTotal ? Math.min(page * 20, intakeTotal) : 0
        } };
      },
      async listAnnualEnrollmentCounts(actorId, filters) { calls.push(['intakeCounts', actorId, filters]); return []; },
      async loadIntakeOptions() { return intakeOptions; }
    }
  });
}

test('registrar overview renders term counts and filtered intake links without finance amounts', async () => {
  const calls = [];
  await withServer(appFor('registrar', calls), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const response = await fetch(`${baseUrl}/registrar?schoolYear=2026-2027&termId=62`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Active enrolled students · Second Term/);
    assert.match(html, /<section class="registrar-overview__term-comparison"[\s\S]*Grade 11 and Grade 12 by term/);
    assert.match(html, /<details class="registrar-overview__details">\s*<summary>More enrollment counts and how they are counted<\/summary>/);
    assert.doesNotMatch(html, /<details class="registrar-overview__details" open>/);
    assert.match(html, /Active counts include active students with enrolled placements\. Legacy archive rows are excluded\./);
    assert.match(html, /<ol class="dashboard-comparison registrar-term-chart__rows" aria-label="Active enrollment by configured term">/);
    assert.match(html, /<span class="dashboard-chart__track" aria-hidden="true">/);
    const activeTermLink = accessibleCountLink(html, 'View 12 active enrolled students for Second Term');
    assert.equal(activeTermLink.text, '12');
    assert.deepEqual(Object.fromEntries(new URL(activeTermLink.href, baseUrl).searchParams), {
      schoolYear: '2026-2027', termId: '62', status: 'enrolled', studentStatus: 'active'
    });
    const grade11Link = accessibleCountLink(html, 'View 7 active Grade 11 enrolled students for Term 2');
    assert.equal(grade11Link.text, '7');
    assert.deepEqual(Object.fromEntries(new URL(grade11Link.href, baseUrl).searchParams), {
      schoolYear: '2026-2027', termId: '62', gradeLevel: 'Grade 11', status: 'enrolled', studentStatus: 'active'
    });
    const grade12Link = accessibleCountLink(html, 'View 5 active Grade 12 enrolled students for Term 2');
    assert.equal(grade12Link.text, '5');
    const earlierTermLink = accessibleCountLink(html, 'View 8 active Grade 11 enrolled students for Term 1');
    assert.deepEqual(Object.fromEntries(new URL(earlierTermLink.href, baseUrl).searchParams), {
      schoolYear: '2026-2027', termId: '61', gradeLevel: 'Grade 11', status: 'enrolled', studentStatus: 'active'
    });
    const pendingLink = accessibleCountLink(html, 'View 2 active pending placements for Second Term');
    assert.deepEqual(Object.fromEntries(new URL(pendingLink.href, baseUrl).searchParams), {
      schoolYear: '2026-2027', termId: '62', status: 'pending_payment', studentStatus: 'active'
    });
    assert.match(html, /Students finalized this year/);
    assert.match(html, /Grade 11 and Grade 12 by term/);
    assert.match(html, /status=pending_payment/);
    assert.match(html, /status=dropped/);
    assert.match(html, /status=transferred/);
    assert.doesNotMatch(html, /₱|amount due|payment history|finance ledger/i);
    assert.deepEqual(calls.map(([name, actorId]) => [name, actorId]), [['registrar', 7]]);
  });
});

test('finance overview is the dashboard destination and leaves the searchable roster at /finance', async () => {
  const calls = [];
  await withServer(appFor('finance', calls), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const overviewResponse = await fetch(`${baseUrl}/finance/overview?schoolYear=2026-2027&gradeLevel=Grade+11`, { headers: { cookie } });
    const overviewHtml = await overviewResponse.text();
    assert.equal(overviewResponse.status, 200);
    assert.match(overviewHtml, /Finance overview/);
    assert.match(overviewHtml, /Term payment status/);
    assert.match(overviewHtml, /Unpaid/);
    assert.match(overviewHtml, /Partially paid/);
    assert.match(overviewHtml, /Needs review/);
    assert.match(overviewHtml, /Tuition tracking/);
    assert.match(overviewHtml, /Departure reviews/);
    assert.match(overviewHtml, /href="\/finance\/overview" aria-current="page"/);
    assert.deepEqual(calls.map(([name, actorId]) => [name, actorId]), [['finance', 7]]);

    const rosterResponse = await fetch(`${baseUrl}/finance`, { headers: { cookie } });
    const rosterHtml = await rosterResponse.text();
    assert.equal(rosterResponse.status, 200);
    assert.match(rosterHtml, /<h2 id="annual-roster-filter-title">Find annual accounts<\/h2>/);
    assert.match(rosterHtml, /href="\/finance" aria-current="page"/);
  });
});

test('dashboard enrollment links preserve the validated active-student filter on the intake roster', async () => {
  const calls = [];
  await withServer(appFor('registrar', calls), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const response = await fetch(`${baseUrl}/registrar/intake?schoolYear=2026-2027&termId=62&gradeLevel=Grade+11&status=enrolled&studentStatus=active`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /name="studentStatus" value="active"/);
    assert.match(html, /Showing active student records only, matching the dashboard enrollment counts/);
    assert.deepEqual(calls.filter(([name]) => name.startsWith('intake')).map(([name, actorId, filters]) => [name, actorId, filters.studentStatus, filters.status, filters.gradeLevel, filters.termId]), [
      ['intakeRows', 7, 'active', 'enrolled', 'Grade 11', '62'],
      ['intakeCounts', 7, 'active', 'enrolled', 'Grade 11', '62']
    ]);
  });
});

test('annual enrollment search groups filtered placements under one student record', async () => {
  const calls = [];
  const common = {
    annual_enrollment_id: 71, student_id: 601, school_year: '2026-2027', grade_level: 'Grade 11',
    voucher_code: 'ESC', voucher_category: 'A', intake_kind: 'returning', entry_term_number: 1,
    student_no: 'SHS-2026-0042', first_name: 'Ari', middle_name: null, last_name: 'Lee', suffix: null,
    lrn: '123456789012', sex: 'Female', section_id: 11, section_name: 'STEM A', cluster: 'STEM', strand: 'STEM',
    adviser: null, modality: null, modular_subtype: null, term_scope_status: 'applicable', signed_clearance_status: 'not signed'
  };
  const rows = [
    { ...common, enrollment_id: 801, academic_term_id: 91, term: 'Term 1', annual_term_number: 1,
      enrollment_status: 'pending_payment', registrar_confirmation_id: null },
    { ...common, enrollment_id: 802, academic_term_id: 92, term: 'Term 2', annual_term_number: 2,
      enrollment_status: 'enrolled', registrar_confirmation_id: 700 },
    ...Array.from({ length: 19 }, (_, index) => ({ ...common,
      annual_enrollment_id: 72 + index, student_id: 602 + index, student_no: `SHS-2026-${String(43 + index).padStart(4, '0')}`,
      first_name: `Student ${index + 1}`, enrollment_id: 803 + index, academic_term_id: 91,
      term: 'Term 1', annual_term_number: 1, enrollment_status: 'enrolled', registrar_confirmation_id: 701 + index
    }))
  ];
  const intakeOptions = {
    schoolYears: [{ school_year: '2026-2027' }],
    terms: [
      { id: 91, school_year: '2026-2027', term: 'Term 1' },
      { id: 92, school_year: '2026-2027', term: 'Term 2' }
    ],
    sections: [{ id: 11, academic_term_id: 91, school_year: '2026-2027', term: 'Term 1', grade_level: 'Grade 11', name: 'STEM A' }]
  };
  await withServer(appFor('registrar', calls, rows, intakeOptions, 42), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const response = await fetch(`${baseUrl}/registrar/intake?search=Ari&schoolYear=2026-2027&page=2`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /name="search" type="search"/);
    assert.match(html, /name="schoolYear"/);
    assert.match(html, /name="termId"/);
    assert.match(html, /<details class="annual-filter-details"/);
    assert.match(html, /<details class="annual-counts-details">/);
    assert.match(html, /Showing 21–40 of 42 annual records/);
    assert.match(html, /rel="prev" href="\/registrar\/intake\?search=Ari&amp;schoolYear=2026-2027&amp;page=1">Previous page/);
    assert.match(html, /rel="next" href="\/registrar\/intake\?search=Ari&amp;schoolYear=2026-2027&amp;page=3">Next page/);
    assert.equal((html.match(/<article class="annual-record"/g) || []).length, 20);
    assert.match(html, /<details class="annual-record-details">/);
    assert.doesNotMatch(html, /<details class="annual-record-details" open>/);
    assert.match(html, /2 matching term placements/);
    assert.match(html, /Voucher type ESC/);
    assert.doesNotMatch(html, /Category A|voucher category/i);
    assert.match(html, /Pending activation/);
    assert.match(html, /Term 1/);
    assert.match(html, /Term 2/);
    assert.doesNotMatch(html, /Term 1 · Term 1/);
    assert.equal((html.match(/action="\/registrar\/intake\/71\/voucher"/g) || []).length, 1);
    assert.match(html, /action="\/registrar\/intake\/801\/status"/);
    assert.match(html, /href="\/registrar\/intake\/71\/fees"/);
    assert.match(html, /name="_csrf" value="[^"]+"/);
    assert.doesNotMatch(html, /₱|amount due|payment history|finance ledger/i);
    assert.deepEqual(calls.filter(([name]) => name === 'intakeRows').map(([, actorId, filters]) => [actorId, filters.search, filters.schoolYear, filters.termId, filters.page]), [
      [7, 'Ari', '2026-2027', '', '2']
    ]);
  });
});

test('overview routes enforce registrar and finance role boundaries on the server', async () => {
  for (const [role, path] of [['teacher', '/finance/overview'], ['student', '/finance/overview'], ['registrar', '/finance/overview'], ['finance', '/registrar'], ['teacher', '/registrar']]) {
    const calls = [];
    await withServer(appFor(role, calls), async (baseUrl) => {
      const cookie = await signIn(baseUrl, role);
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
      assert.equal(response.status, 403, `${role} cannot open ${path}`);
      assert.deepEqual(calls, [], 'role guard runs before dashboard data is loaded');
    });
  }
});
