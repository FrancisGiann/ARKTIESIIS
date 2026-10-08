const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
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
  queueCounts: { documentClearance: 4, departureReview: 2, savedReviews: 1 },
  availableTerms: [{ academicTermId: 62, term: 'Second Term' }], selectedTermId: '62',
  selectedTerm: { term: 'Second Term' }, selectedInstallment: 'whole', selectedVoucher: '', selectedSectionId: '',
  sections: [{ id: '11', name: 'STEM A', cluster: 'STEM', strand: 'STEM' }], voucherCodes: ['PUB', 'ESC', 'NV'], totalEligible: 3, needsTermSelection: false,
  statusCounts: [
    { status: 'unpaid', label: 'Unpaid', count: 1 }, { status: 'partially_paid', label: 'Partially paid', count: 1 },
    { status: 'fully_paid', label: 'Fully paid', count: 0 }, { status: 'no_payment_required', label: 'No payment required', count: 0 },
    { status: 'needs_review', label: 'Needs review', count: 1 }
  ]
};

function appFor(role, calls = [], intakeRows = [], intakeOptions = { schoolYears: [], terms: [], sections: [] }, intakeTotal = intakeRows.length, financeOverviewData = financeOverview, workloadServices = {}, registrarDashboardService = null) {
  return createApp({
    databasePool: createAuthPool(role), environment,
    registrarDashboardService: registrarDashboardService || {
      async getDashboard(actorId, filters) { calls.push(['registrar', actorId, filters]); return registrarOverview; }
    },
    financeDashboardService: {
      async getOverview(actorId, filters) {
        calls.push(['finance', actorId, filters]);
        return {
          ...financeOverviewData,
          selectedSchoolYear: filters.schoolYear || financeOverviewData.selectedSchoolYear,
          selectedTermId: filters.termId || financeOverviewData.selectedTermId,
          selectedTerm: String(filters.termId || financeOverviewData.selectedTermId) === '61' ? { term: 'First Term' } : financeOverviewData.selectedTerm,
          selectedInstallment: filters.installment || financeOverviewData.selectedInstallment,
          selectedGrade: filters.gradeLevel || '',
          selectedSectionId: filters.sectionId || '',
          selectedVoucher: filters.voucherCode || ''
        };
      }
    },
    annualFinanceService: {
      async listRoster() { return { rows: [], options: { schoolYears: [], terms: [], sections: [] } }; }
    },
    annualEnrollmentService: {
      async listAnnualEnrollmentsPage(actorId, filters) {
        calls.push(['intakeRows', actorId, filters]);
        const totalPages = Math.max(1, Math.ceil(intakeTotal / 20));
        const page = Math.min(Math.max(1, Number(filters.page) || 1), totalPages);
        const visibleRows = filters.termId
          ? intakeRows.filter((row) => String(row.academic_term_id) === String(filters.termId))
          : intakeRows;
        return { rows: visibleRows, pagination: {
          page, pageSize: 20, totalRecords: intakeTotal, totalPages,
          from: intakeTotal ? (page - 1) * 20 + 1 : 0,
          to: intakeTotal ? Math.min(page * 20, intakeTotal) : 0
        } };
      },
      async listAnnualEnrollmentCounts(actorId, filters) { calls.push(['intakeCounts', actorId, filters]); return []; },
      async loadIntakeOptions() { return intakeOptions; }
    },
    preEnrollmentService: workloadServices.preEnrollmentService || { async list() { return { pagination: { totalRecords: 0 } }; } },
    documentService: { async getStudentDocuments() { return null; }, ...(workloadServices.documentService || { async countAwaitingStaffReview() { return 0; } }) },
    teacherGradeSubmissionService: workloadServices.teacherGradeSubmissionService || { async listReviewQueue() { return []; } }
  });
}

test('registrar overview renders term counts and filtered intake links without finance amounts', async () => {
  const calls = [];
  await withServer(appFor('registrar', calls), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const response = await fetch(`${baseUrl}/registrar?schoolYear=2026-2027&termId=62`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.indexOf('registrar-overview') < html.indexOf('registrar-lookup--primary'));
    assert.ok(html.indexOf('registrar-lookup--primary') < html.indexOf('registrar-needs-review'));
    assert.match(html, /<span>Term<\/span>/);
    assert.doesNotMatch(html, /Configured term/);
    assert.match(html, /<details class="registrar-overview__comparison"><summary>Compare enrollment by term<\/summary>/);
    assert.doesNotMatch(html, /<details class="registrar-overview__comparison" open>/);
    const lookupHeading = html.match(/<div class="registrar-lookup__heading">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.doesNotMatch(lookupHeading, /Review paper forms/);
    assert.match(html, /Active enrolled students · Second Term/);
    assert.match(html, /registrar-overview__lead-label--mobile">Total enrolled/);
    assert.match(html, /aria-label="View 12 active enrolled students for Second Term"/);
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
    assert.match(html, /Needs your review/);
    assert.match(html, /href="\/pre-enrollments\?status=ready_for_registrar"/);
    assert.match(html, /href="\/registrar\/intake\?confirmationStatus=needs_confirmation"/);
    assert.match(html, /No registrar review items are waiting/);
    assert.deepEqual(calls.filter(([name]) => name === 'registrar').map(([name, actorId]) => [name, actorId]), [['registrar', 7]]);
  });
});

test('a synchronous review queue failure marks only that count unavailable and leaves the dashboard search available', async () => {
  await withServer(appFor('registrar', [], [], undefined, undefined, financeOverview, {
    preEnrollmentService: { list() { throw new Error('queue unavailable'); } }
  }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const response = await fetch(`${baseUrl}/registrar`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Find a student/);
    assert.match(html, /Paper intakes ready for registrar review[\s\S]*Unavailable/);
    assert.match(html, /Some queue counts are unavailable/);
    assert.match(html, /href="\/registrar\/intake\?confirmationStatus=needs_confirmation"/);
  });
});

test('a registrar queue authorization refusal remains a 403 rather than showing an unavailable dashboard', async () => {
  await withServer(appFor('registrar', [], [], undefined, undefined, financeOverview, {
    documentService: { async countAwaitingStaffReview() { const error = new Error('Registrar access is no longer active.'); error.status = 403; throw error; } }
  }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const response = await fetch(`${baseUrl}/registrar`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 403);
    assert.match(html, /Registrar access is no longer active/);
    assert.doesNotMatch(html, /Find a student|Needs your review/);
  });
});

test('an enrollment overview query failure leaves lookup and review queues available without showing false zero counts', async () => {
  await withServer(appFor('registrar', [], [], undefined, undefined, financeOverview, {}, {
    async getDashboard() { throw new Error('overview unavailable'); }
  }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const response = await fetch(`${baseUrl}/registrar`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Enrollment counts are temporarily unavailable/);
    assert.match(html, /Find a student/);
    assert.match(html, /Needs your review/);
    assert.match(html, /No registrar review items are waiting/);
    assert.doesNotMatch(html, /Active enrolled students[^\n]*0|Grade 11[^\n]*0|Grade 12[^\n]*0/);
  });
});

test('finance overview is the dashboard destination and leaves the searchable roster at /finance', async () => {
  const calls = [];
  await withServer(appFor('finance', calls), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const overviewResponse = await fetch(`${baseUrl}/finance/overview?schoolYear=2026-2027&termId=62&installment=prelim&gradeLevel=Grade+11&voucherCode=ESC&sectionId=11`, { headers: { cookie } });
    const overviewHtml = await overviewResponse.text();
    assert.equal(overviewResponse.status, 200);
    assert.match(overviewHtml, /Finance overview/);
    assert.match(overviewHtml, /Term payment status/);
    assert.match(overviewHtml, /Unpaid/);
    assert.match(overviewHtml, /Partially paid/);
    assert.match(overviewHtml, /Needs review/);
    assert.match(overviewHtml, /Payment period/);
    assert.match(overviewHtml, /Entire term/);
    assert.match(overviewHtml, /Down payment/);
    assert.match(overviewHtml, /Preliminary/);
    assert.match(overviewHtml, /Stopped or transferred/);
    assert.match(overviewHtml, /Document request fee review/);
    assert.match(overviewHtml, /Unfinished reviews/);
    assert.match(overviewHtml, /Other finance tasks/);
    assert.match(overviewHtml, /Counts cover enrollment records for this term\. Selecting a status changes the list, not the counts\./);
    assert.match(overviewHtml, /Earlier account balances are separate from term amounts\. Unused payment credit stays separate until applied\./);
    assert.doesNotMatch(overviewHtml, /Finance · Current work|placements match| placements<\/p>/);
    assert.doesNotMatch(overviewHtml, /Legacy account history|href="\/finance\/legacy/);
    assert.equal([...overviewHtml.matchAll(/<li><a href="\/finance\//g)].length, 3);
    assert.match(overviewHtml, /<span>Stopped or transferred<\/span><strong>2<\/strong>/);
    assert.match(overviewHtml, /<span>Document request fee review<\/span><strong>4<\/strong>/);
    assert.match(overviewHtml, /<span>Unfinished reviews<\/span><strong>1<\/strong>/);
    assert.match(overviewHtml, /href="\/finance\/overview" aria-current="page"/);
    const statusAnchors = [...overviewHtml.matchAll(/<a class="finance-payment-status finance-payment-status--([^\"]+)" href="([^\"]+)" aria-label="([^\"]+)">([\s\S]*?)<\/a>/g)];
    assert.deepEqual(statusAnchors.map(([, status]) => status), ['unpaid', 'partially_paid', 'fully_paid', 'no_payment_required', 'needs_review']);
    assert.match(overviewHtml, /<details class="finance-overview-secondary-filters" open>/);
    const zeroCountStatus = statusAnchors.find(([, status]) => status === 'fully_paid');
    assert.ok(zeroCountStatus, 'zero-count statuses remain linked');
    assert.match(zeroCountStatus[4], /<strong>0<\/strong>/);
    assert.match(zeroCountStatus[3], /Open 0 Fully paid student accounts for Second Term, 2026-2027, Preliminary/);
    assert.doesNotMatch(overviewHtml, /View matching accounts/);
    const zeroCountQuery = new URLSearchParams(zeroCountStatus[2].split('?')[1].replace(/&amp;/g, '&'));
    assert.equal(zeroCountQuery.get('financeStatus'), 'fully_paid');
    assert.equal(zeroCountQuery.get('gradeLevel'), 'Grade 11');
    for (const [, status, href] of statusAnchors) {
      const query = new URLSearchParams(href.split('?')[1].replace(/&amp;/g, '&'));
      assert.equal(query.get('schoolYear'), '2026-2027');
      assert.equal(query.get('termId'), '62');
      assert.equal(query.get('installment'), 'prelim');
      assert.equal(query.get('gradeLevel'), 'Grade 11');
      assert.equal(query.get('voucherCode'), 'ESC');
      assert.equal(query.get('sectionId'), '11');
      assert.equal(query.get('financeStatus'), status);
    }
    const appCss = readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
    assert.match(appCss, /\.finance-payment-statuses\s*\{[^}]*grid-template-columns:\s*repeat\(5,/);
    assert.match(appCss, /\.finance-payment-status:focus-visible\s*\{/);
    assert.match(appCss, /\.finance-other-tasks__list\s*\{/);
    assert.deepEqual(calls.map(([name, actorId]) => [name, actorId]), [['finance', 7]]);

    const rosterResponse = await fetch(`${baseUrl}/finance`, { headers: { cookie } });
    const rosterHtml = await rosterResponse.text();
    assert.equal(rosterResponse.status, 200);
    assert.match(rosterHtml, /<h2 id="annual-roster-filter-title">Find student accounts<\/h2>/);
    assert.match(rosterHtml, /<label for="annual-roster-installment">Payment period<\/label>/);
    assert.match(rosterHtml, /<option value="whole"[^>]*>Entire term<\/option>/);
    assert.match(rosterHtml, /<option value="dp"[^>]*>Down payment<\/option>/);
    assert.match(rosterHtml, /<option value="prelim"[^>]*>Preliminary<\/option>/);
    assert.doesNotMatch(rosterHtml, /Tuition tracking|Whole term|>DP<|>Prelim</);
    assert.match(rosterHtml, /href="\/finance" aria-current="page"/);
  });
});

test('finance overview keeps every zero-count status filter available for an empty configured term', async () => {
  const emptyOverview = {
    ...financeOverview,
    totalEligible: 0,
    statusCounts: financeOverview.statusCounts.map((item) => ({ ...item, count: 0 }))
  };
  await withServer(appFor('finance', [], [], undefined, undefined, emptyOverview), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const response = await fetch(`${baseUrl}/finance/overview`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /No active applicable enrollment records match this term/);
    const links = [...html.matchAll(/<a class="finance-payment-status finance-payment-status--([^\"]+)" href="([^\"]+)"/g)];
    assert.deepEqual(links.map(([, status]) => status), ['unpaid', 'partially_paid', 'fully_paid', 'no_payment_required', 'needs_review']);
    for (const [, status, href] of links) {
      assert.equal(new URL(href.replace(/&amp;/g, '&'), baseUrl).searchParams.get('financeStatus'), status);
    }
    assert.equal((html.match(/<strong>0<\/strong>/g) || []).length, 5);
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
    assert.match(html, /View terms <span>· 2 terms shown<\/span>/);
    assert.equal((html.match(/class="annual-record__open-link"/g) || []).length, 20);
    assert.match(html, /class="annual-record__open-link" href="\/registrar\/intake\/71\/manage">Open enrollment<\/a>/);
    assert.match(html, /Enrollment confirmation<\/span><strong>Needs confirmation<\/strong>/);
    assert.match(html, /Paper requirements checklist/);
    assert.match(html, /<dt>Term account clearance<\/dt>/);
    assert.doesNotMatch(html, /Signed clearance|matching term placements|Review term placements and secondary actions/);
    assert.doesNotMatch(html, /class="annual-record__open-link[^"]*button--primary/);
    assert.match(html, /Voucher ESC/);
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
    const filteredTerms = await fetch(`${baseUrl}/registrar/intake?search=Ari&schoolYear=2026-2027&termId=92`, { headers: { cookie } });
    const filteredTermsHtml = await filteredTerms.text();
    assert.equal(filteredTerms.status, 200);
    assert.match(filteredTermsHtml, /View terms <span>· 1 term shown<\/span>/,
      'the disclosure count reflects placements visible under the selected term filter');
    assert.doesNotMatch(filteredTermsHtml, /View terms <span>· 2 terms shown<\/span>/);
    assert.deepEqual(calls.filter(([name]) => name === 'intakeRows').map(([, actorId, filters]) => [actorId, filters.search, filters.schoolYear, filters.termId, filters.page]), [
      [7, 'Ari', '2026-2027', '', '2'],
      [7, 'Ari', '2026-2027', '92', '']
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
