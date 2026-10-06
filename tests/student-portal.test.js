const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { once } = require('node:events');
const { createApp } = require('../src/app');

const passwordHash = bcrypt.hashSync('Correct-Horse-Battery-12', 4);
const environment = {
  nodeEnv: 'development', devPasswordOnlyLogin: true, sessionSecret: 'student-portal-route-test-secret'
};

function authPool(role) {
  const user = { id: 7, email: `${role}@example.edu`, password_hash: passwordHash, role, is_active: true };
  return async () => ({
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
}

function cookieFrom(response) { return response.headers.get('set-cookie').split(';', 1)[0]; }
function csrfFrom(html) { return html.match(/name="_csrf" value="([^"]+)"/)?.[1]; }

async function signIn(baseUrl, role) {
  const page = await fetch(`${baseUrl}/login`);
  const cookie = cookieFrom(page);
  const token = csrfFrom(await page.text());
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, email: `${role}@example.edu`, password: 'Correct-Horse-Battery-12' })
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('student pages are separate, read-only destinations bound to the authenticated student', async () => {
  const calls = { records: [], summaries: [], schedules: [], grades: [], finance: [], annualFinance: [] };
  const financeEvents = Array.from({ length: 125 }, (_, index) => ({
    event_date: new Date(Date.UTC(2026, 6, 1 + index)),
    event_type: index === 122 ? 'charge' : index % 2 ? 'charge' : 'payment',
    details: index === 122 ? '<script>alert(1)</script>' : `Finance activity ${index}`,
    reference_no: `REF-${String(index).padStart(3, '0')}`,
    amount: index === 122 ? '4990.00' : index === 121 ? null : `${(index + 1) * 10}.00`
  }));
  let studentFinanceLedger = {
    summary: { annualBalanceSchoolYear: '2026-2027', annualBalance: '4990.00', allYearsAnnualBalance: '4990.00',
      unattributedLegacyBalance: '0.00', openingLiabilityDue: '0.00', totalBalance: '4990.00', currentTermOutstanding: '1000.00',
      priorTermYearDebt: '3990.00', availableCredit: '500.00' },
    charges: [
      { school_year: '2026-2027', annual_term_number: 2, term: 'Term 2', line_name: 'Tuition', installment: 'Term 2',
        amount: '1500.00', waived_amount: '200.00', adjustments: '-250.00', allocated: '250.00', remaining_due: '1000.00' },
      { school_year: '2026-2027', annual_term_number: 1, term: 'Term 1', line_name: 'Tuition', installment: 'Term 1',
        amount: '4500.00', waived_amount: '0.00', adjustments: '0.00', allocated: '510.00', remaining_due: '3990.00' },
      { school_year: '2026-2027', annual_term_number: 2, term: 'Term 2', line_name: 'Paid materials fee', installment: 'Term 2',
        amount: '100.00', waived_amount: '0.00', adjustments: '0.00', allocated: '100.00', remaining_due: '0.00' },
      { school_year: '2026-2027', annual_term_number: 2, term: 'Term 2', line_name: 'Covered activity fee', installment: 'Term 2',
        amount: '100.00', waived_amount: '100.00', adjustments: '-100.00', allocated: '0.00', remaining_due: '0.00' }
    ],
    terms: [
      { school_year: '2026-2027', term: 'Term 1', is_current: false, enrollment_status: 'enrolled', term_scope_status: 'applicable',
        registrar_confirmation_id: 12, signed_clearance_status: 'signed', outstanding: '0.00' },
      { school_year: '2026-2027', term: 'Term 2', is_current: true, enrollment_status: 'enrolled', term_scope_status: 'applicable',
        registrar_confirmation_id: 13, signed_clearance_status: null, outstanding: '1000.00' },
      { school_year: '2026-2027', term: 'Term 3', is_current: false, enrollment_status: 'pending_payment', term_scope_status: 'applicable',
        registrar_confirmation_id: null, signed_clearance_status: null, outstanding: '3990.00' }
    ],
    events: financeEvents
  };
  const student = {
    id: 55, student_no: 'SHS-2026-0042', first_name: 'Rae', middle_name: null, last_name: 'Student', suffix: null,
    birth_date: '2009-05-10', sex: 'female', phone: '555-0100', address: 'Lucena', status: 'active'
  };
  studentFinanceLedger.student = student;
  const ownRecords = { student, enrollments: [{ school_year: '2026-2027', term: 'First', is_current: true,
    section_name: 'STEM A', grade_level: 'Grade 11', enrollment_status: 'enrolled', enrolled_at: new Date('2026-06-01') }] };
  const services = {
    studentRecordsService: {
      async getOwnStudentRecord(userId) { calls.records.push(userId); assert.equal(userId, 7); return ownRecords; },
      async getStudentDashboardSummary(userId) { calls.summaries.push(userId); assert.equal(userId, 7); return { document_count: 2, documents_in_progress_count: 1 }; }
    },
    classScheduleService: {
      async getOwnStudentSchedule(userId) {
        calls.schedules.push(userId); assert.equal(userId, 7);
        return [{ day_of_week: 1, start_time: '08:00', end_time: '09:00', room: 'Room 2',
          section_name: 'STEM A', grade_level: 'Grade 11', subject_code: 'ENG11', subject_name: 'Oral Communication',
          teacher_name: 'Jamie Lee', school_year: '2026-2027', term: 'First' }];
      }
    },
    academicRecordsService: { async getOwnGrades(userId) {
      calls.grades.push(userId); assert.equal(userId, 7);
      return [{ school_year: '2026-2027', term: 'First', subject_code: 'ENG11', subject_name: 'Oral Communication',
        grading_period: 'Term 1', grade_value: 92 }];
    } },
    financeService: { async getOwnStudentAccount(userId) {
      calls.finance.push(userId); assert.equal(userId, 7);
      return { student: { ...student }, account: { balance: '4990.00' }, transactions: [{ transaction_type: 'charge',
        amount: '4990.00', description: 'Synthetic tuition sample', created_at: new Date('2026-09-01') }] };
    } },
    annualFinanceService: { async getStudentLedger(userId, studentId, access) {
      calls.annualFinance.push({ userId, studentId, access });
      assert.equal(userId, 7);
      assert.equal(studentId, 55);
      assert.equal(access, 'student');
      return studentFinanceLedger;
    } },
    termClearanceService: { async getOwnStudentProgress(userId) { assert.equal(userId, 7); return { terms: [] }; } }
  };

  await withServer(createApp({ databasePool: authPool('student'), environment, ...services }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const destinations = [
      ['/student?studentId=999&userId=888', /Today's classes/, /href="\/student\/schedule"/],
      ['/student/schedule?studentId=999', /<h1>My schedule<\/h1>/, /08:00–09:00/],
      ['/student/grades?studentId=999', /<h1>My grades<\/h1>/, /92/],
      ['/student/finance?studentId=999', /<h1>My finance account<\/h1>/, /₱4,990\.00/],
      ['/student/records?studentId=999', /<h1>My profile and enrollment history<\/h1>/, /2026-2027 · First/]
    ];
    for (const [path, heading, content] of destinations) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
      const html = await response.text();
      assert.equal(response.status, 200, path);
      assert.match(html, heading, path);
      assert.match(html, content, path);
      assert.doesNotMatch(html, /ANOTHER-STUDENT|SHS-2026-0999/);
      if (path.startsWith('/student/grades')) assert.match(html, /value="Term 1" selected/);
      if (path.startsWith('/student?')) {
        assert.doesNotMatch(html, /student-shortcuts|Your school pages/);
        assert.match(html, /href="\/student\/schedule">View full schedule/);
        assert.match(html, /href="\/student\/records">My profile/);
      }
    }
    const financeResponse = await fetch(`${baseUrl}/student/finance`, { headers: { cookie } });
    const financeHtml = await financeResponse.text();
    assert.equal(financeResponse.status, 200);
    assert.match(financeHtml, /Combined account balance[\s\S]*?₱4,990\.00/);
    assert.match(financeHtml, /Available payment credit[\s\S]*?₱500\.00[\s\S]*?until it is applied to a fee/);
    assert.match(financeHtml, /Latest assessed year · 2026-2027/);
    assert.match(financeHtml, /All school-year fees due[\s\S]*?₱4,990\.00/);
    assert.match(financeHtml, /Fees and payments by school year/);
    assert.match(financeHtml, /Fee amount[\s\S]*?₱1,500\.00[\s\S]*?Coverage[\s\S]*?−₱200\.00[\s\S]*?Other changes[\s\S]*?−₱50\.00[\s\S]*?Payments applied[\s\S]*?−₱250\.00[\s\S]*?Remaining due[\s\S]*?₱1,000\.00/);
    assert.match(financeHtml, /2026-2027 · Term 1[\s\S]*?Remaining due[\s\S]*?₱3,990\.00/);
    assert.match(financeHtml, /Paid materials fee[\s\S]*?Coverage<\/dt><dd>₱0\.00[\s\S]*?Payments applied<\/dt><dd>−₱100\.00/);
    assert.match(financeHtml, /Covered activity fee[\s\S]*?Coverage<\/dt><dd>−₱100\.00[\s\S]*?Payments applied<\/dt><dd>₱0\.00/);
    assert.doesNotMatch(financeHtml, /−₱0\.00/, 'zero deductions are shown as zero, without an apparent negative amount');
    assert.doesNotMatch(financeHtml, /\blegacy\b/i, 'student-facing labels use plain language');
    assert.match(financeHtml, /Current term due[\s\S]*?₱1,000\.00/);
    assert.match(financeHtml, /Current term/);
    assert.match(financeHtml, /Confirmed by registrar/);
    assert.match(financeHtml, /Signed clearance[\s\S]*?Signed/);
    assert.match(financeHtml, /does not change the outstanding amount shown here/);
    const recentActivity = financeHtml.match(/<ol class="student-finance-activity-list">([\s\S]*?)<\/ol>/)?.[1];
    assert.ok(recentActivity, 'recent activity preview is present');
    assert.ok(recentActivity.indexOf('Finance activity 124') < recentActivity.indexOf('Finance activity 123'));
    assert.ok(recentActivity.indexOf('Finance activity 123') < recentActivity.indexOf('Finance activity 121'));
    assert.doesNotMatch(recentActivity, /Finance activity 119/);
    assert.match(recentActivity, /Recorded amount/);
    assert.match(recentActivity, /Reference: REF-124/);
    assert.doesNotMatch(financeHtml, /<script>alert\(1\)<\/script>/);
    assert.match(financeHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    const completeHistory = financeHtml.match(/<details class="student-finance-history">([\s\S]*?)<\/details>/)?.[1];
    assert.ok(completeHistory, 'complete history is reachable in a native disclosure');
    assert.match(completeHistory, /View complete finance history · 125 entries/);
    assert.equal((completeHistory.match(/<tr>/g) || []).length, 126, 'all 125 history rows remain available');
    assert.match(completeHistory, /REF-000/);
    assert.match(completeHistory, /REF-124/);
    assert.ok(calls.annualFinance.some(({ userId, studentId, access }) => userId === 7 && studentId === 55 && access === 'student'));

    const statementResponse = await fetch(`${baseUrl}/student/finance/statement`, { headers: { cookie } });
    const statementHtml = await statementResponse.text();
    assert.equal(statementResponse.status, 200);
    assert.match(statementHtml, /All school-year fees due[\s\S]*?₱4,990\.00/);
    assert.match(statementHtml, /Fee breakdown[\s\S]*?Coverage[\s\S]*?₱0\.00[\s\S]*?Payments applied[\s\S]*?₱0\.00/);
    assert.doesNotMatch(statementHtml, /−₱0\.00|\blegacy\b/i, 'student statement omits zero negative-looking deductions and old account terminology');

    studentFinanceLedger = {
      summary: { annualBalanceSchoolYear: null, annualBalance: '0.00', allYearsAnnualBalance: '0.00',
        unattributedLegacyBalance: '0.00', openingLiabilityDue: '0.00', totalBalance: '0.00', currentTermOutstanding: '0.00',
        priorTermYearDebt: '0.00', availableCredit: '0.00' },
      charges: [], terms: [], events: []
    };
    const emptyFinanceResponse = await fetch(`${baseUrl}/student/finance`, { headers: { cookie } });
    const emptyFinanceHtml = await emptyFinanceResponse.text();
    assert.equal(emptyFinanceResponse.status, 200);
    assert.match(emptyFinanceHtml, /Latest assessed year · none recorded/);
    assert.match(emptyFinanceHtml, /No school-year fees have been assessed yet/);
    assert.match(emptyFinanceHtml, /No term finance activity has been posted yet/);
    assert.match(emptyFinanceHtml, /No finance entries have been recorded/);
    assert.match(emptyFinanceHtml, /View complete finance history · 0 entries/);
    assert.deepEqual(calls.records, [7, 7, 7, 7]);
    assert.deepEqual(calls.summaries, [], 'student home does not load a document summary used only by removed shortcuts');
    assert.deepEqual(calls.schedules, [7, 7]);
    assert.deepEqual(calls.grades, [7]);
    assert.deepEqual(calls.finance, [7, 7, 7, 7]);
  });
});

test('student profile and enrollment history remain available when paper-clearance progress fails', async () => {
  const student = {
    student_no: 'SHS-2026-0042', first_name: 'Rae', middle_name: null, last_name: 'Student', suffix: null,
    birth_date: '2009-05-10', sex: 'female', phone: '555-0100', address: 'Lucena', status: 'active'
  };
  const diagnostics = [];
  const app = createApp({
    databasePool: authPool('student'), environment,
    studentRecordsService: {
      async getOwnStudentRecord(userId) {
        assert.equal(userId, 7, 'the record lookup uses the authenticated account id');
        return { student, enrollments: [{ school_year: '2026-2027', term: 'First', grade_level: 'Grade 11',
          section_name: 'STEM A', enrollment_status: 'enrolled' }] };
      }
    },
    termClearanceService: {
      async getOwnStudentProgress(userId) {
        assert.equal(userId, 7, 'clearance progress also uses the authenticated account id');
        const error = new Error('private SQL text and student context');
        error.code = 'ER_NO_SUCH_TABLE';
        throw error;
      }
    }
  });
  app.set('logger', { error(message, metadata) { diagnostics.push({ message, metadata }); } });

  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const response = await fetch(`${baseUrl}/student/records?studentId=999`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Rae Student/);
    assert.match(html, /Student number <strong>SHS-2026-0042<\/strong>/);
    assert.match(html, /2026-2027 · First/);
    assert.match(html, /Paper-clearance progress is temporarily unavailable/);
    assert.doesNotMatch(html, /No paper-clearance progress has been recorded/);
    assert.doesNotMatch(html, /private SQL text|student context|signer_name/i);
  });

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, 'Student paper-clearance progress could not be loaded.');
  assert.equal(diagnostics[0].metadata.errorCode, 'ER_NO_SUCH_TABLE');
  assert.doesNotMatch(JSON.stringify(diagnostics), /private SQL text|student context/);
});

test('student records remain unavailable when the primary own-record lookup fails', async () => {
  const app = createApp({
    databasePool: authPool('student'), environment,
    studentRecordsService: { async getOwnStudentRecord(userId) {
      assert.equal(userId, 7);
      throw new Error('private primary query details');
    } },
    termClearanceService: { async getOwnStudentProgress() { return { terms: [] }; } }
  });

  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const response = await fetch(`${baseUrl}/student/records`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 503);
    assert.match(html, /Student space unavailable/);
    assert.match(html, /Your school information could not be loaded right now/);
    assert.doesNotMatch(html, /No paper-clearance progress|profile and enrollment history/);
    assert.doesNotMatch(html, /private primary query details/);
  });
});

test('non-student roles cannot open student self-service pages or invoke their data services', async () => {
  let dataCalls = 0;
  const services = {
    studentRecordsService: { async getOwnStudentRecord() { dataCalls += 1; return null; }, async getStudentDashboardSummary() { dataCalls += 1; return {}; } },
    academicRecordsService: { async getOwnGrades() { dataCalls += 1; return []; } },
    financeService: { async getOwnStudentAccount() { dataCalls += 1; return { account: null, transactions: [] }; } },
    classScheduleService: { async getOwnStudentSchedule() { dataCalls += 1; return []; } }
  };
  await withServer(createApp({ databasePool: authPool('teacher'), environment, ...services }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'teacher');
    for (const path of ['/student', '/student/schedule', '/student/grades', '/student/finance', '/student/records']) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
      assert.equal(response.status, 403, path);
    }
    assert.equal(dataCalls, 0);
  });
});

test('unlinked student accounts receive clear empty states on every self-service destination', async () => {
  const calls = [];
  const services = {
    studentRecordsService: {
      async getOwnStudentRecord(userId) { calls.push(['records', userId]); return null; },
      async getStudentDashboardSummary(userId) { calls.push(['summary', userId]); return { document_count: 0, documents_in_progress_count: 0 }; }
    },
    classScheduleService: { async getOwnStudentSchedule(userId) { calls.push(['schedule', userId]); return []; } },
    academicRecordsService: { async getOwnGrades(userId) { calls.push(['grades', userId]); return []; } },
    financeService: { async getOwnStudentAccount(userId) { calls.push(['finance', userId]); return { student: null, account: null, transactions: [] }; } },
    termClearanceService: { async getOwnStudentProgress(userId) { calls.push(['paper-clearance', userId]); return { terms: [] }; } }
  };
  await withServer(createApp({ databasePool: authPool('student'), environment, ...services }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    for (const path of ['/student', '/student/schedule', '/student/grades', '/student/finance', '/student/records']) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.match(html, /student profile is not linked yet/i, path);
      if (path === '/student/finance') {
        assert.match(html, /Statement of Account/);
        assert.doesNotMatch(html, /student-finance-ledger|finance-history/);
      }
    }
    assert.equal(calls.some(([name]) => name === 'grades'), false, 'grades are not requested without a linked student record');
    assert.ok(calls.every(([, userId]) => userId === 7), 'all attempted reads use the authenticated account id');
  });
});

test('student grades select one own semester and grading period with safe defaults and query validation', async () => {
  const gradeUserIds = [];
  const studentRecordsService = {
    async getOwnStudentRecord(userId) {
      assert.equal(userId, 7);
      return { student: { student_no: 'S-7' }, enrollments: [
        { school_year: '2026-2027', term: 'First', is_current: true },
        { school_year: '2025-2026', term: 'Second', is_current: false }
      ] };
    }
  };
  const academicRecordsService = {
    async getOwnGrades(userId) {
      gradeUserIds.push(userId);
      return [
        { school_year: '2026-2027', term: 'First', subject_code: 'ENG11', subject_name: 'English', grading_period: 'First Grading', grade_value: 84 },
        { school_year: '2026-2027', term: 'First', subject_code: 'ENG11', subject_name: 'English', grading_period: 'Second Grading', grade_value: 91 },
        { school_year: '2026-2027', term: 'First', subject_code: 'ENG11', subject_name: 'English', grading_period: 'Second Grading', grade_value: 92 },
        { school_year: '2026-2027', term: 'First', subject_code: 'MATH11', subject_name: 'General Mathematics', grading_period: 'Second Grading', grade_value: 95 },
        { school_year: '2025-2026', term: 'First', subject_code: 'ENG10', subject_name: 'English 10', grading_period: 'Term 1', grade_value: 81 },
        { school_year: '2025-2026', term: 'Second', subject_code: 'ENG11', subject_name: 'English', grading_period: 'Quarter A', grade_value: 78 }
      ];
    }
  };
  const services = {
    studentRecordsService,
    academicRecordsService,
    financeService: { async getOwnStudentAccount() { return { account: null, transactions: [] }; } },
    classScheduleService: { async getOwnStudentSchedule() { return []; } }
  };

  await withServer(createApp({ databasePool: authPool('student'), environment, ...services }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const defaultPage = await fetch(`${baseUrl}/student/grades`, { headers: { cookie } });
    const defaultHtml = await defaultPage.text();
    assert.equal(defaultPage.status, 200);
    assert.match(defaultHtml, /<label for="student-grade-semester">Semester<\/label>/);
    assert.match(defaultHtml, /<label for="student-grade-period">Grading period<\/label>/);
    assert.match(defaultHtml, /value="\[&#34;2026-2027&#34;,&#34;First&#34;\]" selected/);
    assert.match(defaultHtml, /value="Second Grading" selected/);
    assert.ok(defaultHtml.indexOf('value="First Grading"') < defaultHtml.indexOf('value="Second Grading"'), 'grading periods keep logical order');
    assert.ok(defaultHtml.indexOf('2025-2026 · First') < defaultHtml.indexOf('2025-2026 · Second'), 'semester labels keep logical order');
    assert.match(defaultHtml, /<td data-label="Grade">91<\/td>/);
    assert.doesNotMatch(defaultHtml, /<td data-label="Grade">84<\/td>|<td data-label="Grade">78<\/td>/);
    assert.equal((defaultHtml.match(/data-label="Subject">English/g) || []).length, 1, 'each subject is shown once for the selected period');
    assert.match(defaultHtml, /<th scope="col">Subject<\/th><th scope="col">Grade<\/th>/);

    const requestedSemester = JSON.stringify(['2025-2026', 'Second']);
    const requested = new URLSearchParams({ semester: requestedSemester, gradingPeriod: 'Quarter A' });
    const selectedPage = await fetch(`${baseUrl}/student/grades?${requested}`, { headers: { cookie } });
    const selectedHtml = await selectedPage.text();
    assert.equal(selectedPage.status, 200);
    assert.match(selectedHtml, /value="Quarter A" selected/);
    assert.match(selectedHtml, /<td data-label="Grade">78<\/td>/);
    assert.doesNotMatch(selectedHtml, /<td data-label="Grade">91<\/td>|<td data-label="Grade">95<\/td>/);

    const invalid = new URLSearchParams({ semester: 'not-an-owned-semester', gradingPeriod: 'Not an owned period', studentId: '999' });
    const invalidPage = await fetch(`${baseUrl}/student/grades?${invalid}`, { headers: { cookie } });
    const invalidHtml = await invalidPage.text();
    assert.equal(invalidPage.status, 200);
    assert.match(invalidHtml, /value="\[&#34;2026-2027&#34;,&#34;First&#34;\]" selected/);
    assert.match(invalidHtml, /value="Second Grading" selected/);
    assert.doesNotMatch(invalidHtml, /<td data-label="Grade">78<\/td>/);
    assert.deepEqual(gradeUserIds, [7, 7, 7], 'all grades come from the authenticated user regardless of query parameters');
  });
});
