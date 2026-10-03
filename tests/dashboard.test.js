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
  sessionSecret: 'phase-eleven-dashboard-test-session-secret'
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

function cookieFrom(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

function csrfFromHtml(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

async function signIn(baseUrl, role) {
  const loginPage = await fetch(`${baseUrl}/login`);
  const cookie = cookieFrom(loginPage);
  const token = csrfFromHtml(await loginPage.text());
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, email: `${role}@example.edu`, password })
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
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

test('role dashboards lead with useful work and omit decorative summary strips', async () => {
  const scenarios = [
    {
      role: 'student', path: '/student', label: /Today's classes/,
      summary: { enrollment_count: 2, grade_entry_count: 4, document_count: 3, documents_in_progress_count: 1 }
    },
    {
      role: 'registrar', path: '/registrar', label: /Find a student/,
      summary: { active_student_count: 8, archived_student_count: 1, current_enrollment_count: 6, documents_awaiting_review_count: 2, documents_processing_count: 1 }
    },
    {
      role: 'finance', path: '/finance', label: /<h2 id="annual-roster-filter-title">Find annual accounts<\/h2>/,
      summary: { account_count: 10, accounts_due_count: 4, accounts_settled_count: 5, accounts_credit_count: 1, charge_count: 12, payment_count: 8 }
    },
    {
      role: 'database_admin', path: '/admin', label: /Student accounts/,
      summary: { active_user_count: 10, inactive_user_count: 2, active_student_count: 8, archived_student_count: 1, documents_awaiting_review_count: 2 }
    }
  ];

  for (const scenario of scenarios) {
    const summaryCalls = [];
    const services = {
      adminService: {
        async getDashboardSummary(actorId) { summaryCalls.push(['admin', actorId]); return scenario.summary; }
      },
      studentRecordsService: {
        async getOwnStudentRecord() { return { student: { student_no: 'S-7' }, enrollments: [] }; },
        async getStudentDashboardSummary(actorId) { summaryCalls.push(['student', actorId]); return scenario.summary; },
        async getRegistrarDashboardSummary(actorId) { summaryCalls.push(['registrar', actorId]); return scenario.summary; }
      },
      registrarDashboardService: {
        async getDashboard() {
          return {
            configuredTerms: [], schoolYears: [], schoolYearTerms: [], selectedSchoolYear: '', selectedTerm: null,
            activeEnrolledCount: null, pendingActivationCount: 0, departedCount: 0, droppedCount: 0,
            transferredCount: 0, everFinalizedCount: 0, termCounts: [], needsTermSelection: true
          };
        }
      },
      academicRecordsService: { async getOwnGrades() { return []; } },
      classScheduleService: { async getOwnStudentSchedule() { return []; } },
      financeService: {
        async searchStudents(searchTerm) { return { students: [], searchTerm }; },
        async getOwnStudentAccount(actorId) { return { account: null, transactions: [] }; },
        async getDashboardSummary(actorId) { summaryCalls.push(['finance', actorId]); return scenario.summary; }
      }
    };
    await withServer(createApp({ databasePool: createAuthPool(scenario.role), environment, ...services,
      annualFinanceService: { async listRoster() { return { rows: [], options: { schoolYears: [], terms: [], sections: [] } }; } }
    }), async (baseUrl) => {
      const cookie = await signIn(baseUrl, scenario.role);
      const response = await fetch(`${baseUrl}${scenario.path}`, { headers: { cookie } });
      assert.equal(response.status, 200, scenario.role);
      const html = await response.text();
      assert.match(html, scenario.label, scenario.role);
      assert.doesNotMatch(html, /dashboard-summary|Finance at a glance|System summary|Current enrollments/);
      assert.deepEqual(summaryCalls, [], `${scenario.role} does not fetch dashboard summaries that are not shown`);
    });
  }
});

test('student ledger currency uses grouped peso display without changing finance service amounts', async () => {
  const rawAmounts = ['19960.00', '4990.00'];
  const services = {
    studentRecordsService: {
      async getOwnStudentRecord() {
        return { student: { first_name: 'Alyssa', student_no: 'SHS-2026-0001' }, enrollments: [], grades: [] };
      },
      async getStudentDashboardSummary() {
        return { enrollment_count: 0, grade_entry_count: 0, document_count: 0, documents_in_progress_count: 0 };
      }
    },
    academicRecordsService: { async getOwnGrades() { return []; } },
    classScheduleService: { async getOwnStudentSchedule() { return []; } },
    financeService: {
      async getOwnStudentAccount() {
        return {
          student: { student_no: 'S-7', first_name: 'Alex', last_name: 'Kim' },
          account: { balance: rawAmounts[0] },
          transactions: [{ transaction_type: 'charge', amount: rawAmounts[1], created_at: new Date('2026-09-28T00:00:00Z'), description: 'Synthetic tuition sample' }]
        };
      }
    },
    annualFinanceService: {
      async getStudentLedger() {
        return {
          summary: { annualBalanceSchoolYear: '2026-2027', annualBalance: rawAmounts[0], allYearsAnnualBalance: rawAmounts[0],
            unattributedLegacyBalance: '0.00', totalBalance: rawAmounts[0], currentTermOutstanding: rawAmounts[1],
            priorTermYearDebt: '0.00', availableCredit: '0.00' },
          terms: [], events: []
        };
      }
    }
  };
  await withServer(createApp({ databasePool: createAuthPool('student'), environment, ...services }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const response = await fetch(`${baseUrl}/student/finance`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /₱19,960\.00/);
    assert.match(html, /₱4,990\.00/);
    assert.deepEqual(rawAmounts, ['19960.00', '4990.00']);
  });
});

test('student class start and end times stay together in one readable range', async () => {
  const services = {
    studentRecordsService: {
      async getOwnStudentRecord() {
        return { student: { id: 22, first_name: 'Alex', last_name: 'Kim', student_no: 'SHS-2026-0001' }, enrollments: [], grades: [] };
      },
      async getStudentDashboardSummary() {
        return { enrollment_count: 0, grade_entry_count: 0, document_count: 0, documents_in_progress_count: 0 };
      }
    },
    academicRecordsService: { async getOwnGrades() { return []; } },
    classScheduleService: {
      async getOwnStudentSchedule() {
        return [{ day_of_week: new Date().getDay(), start_time: '08:00', end_time: '09:00', room: 'Room 2', subject_name: 'Oral Communication', subject_code: 'ENG11', section_name: 'STEM A' }];
      }
    },
    financeService: { async getOwnStudentAccount() { return { account: null, transactions: [] }; } }
  };
  await withServer(createApp({ databasePool: createAuthPool('student'), environment, ...services }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    const response = await fetch(`${baseUrl}/student`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<time>08:00–09:00<\/time>/);
    assert.match(html, /Room 2/);
    assert.doesNotMatch(html, /<span>09:00<\/span>/);
  });
});
