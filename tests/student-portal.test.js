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
  const calls = { records: [], summaries: [], schedules: [], grades: [], finance: [] };
  const student = {
    id: 55, student_no: 'SHS-2026-0042', first_name: 'Rae', middle_name: null, last_name: 'Student', suffix: null,
    birth_date: '2009-05-10', sex: 'female', phone: '555-0100', address: 'Lucena', status: 'active'
  };
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
    } }
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
      if (path.startsWith('/student?')) {
        assert.doesNotMatch(html, /student-shortcuts|Your school pages/);
        assert.match(html, /href="\/student\/schedule">View full schedule/);
        assert.match(html, /href="\/student\/records">My profile/);
      }
    }
    assert.deepEqual(calls.records, [7, 7, 7, 7]);
    assert.deepEqual(calls.summaries, [], 'student home does not load a document summary used only by removed shortcuts');
    assert.deepEqual(calls.schedules, [7, 7]);
    assert.deepEqual(calls.grades, [7]);
    assert.deepEqual(calls.finance, [7]);
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
    financeService: { async getOwnStudentAccount(userId) { calls.push(['finance', userId]); return { student: null, account: null, transactions: [] }; } }
  };
  await withServer(createApp({ databasePool: authPool('student'), environment, ...services }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'student');
    for (const path of ['/student', '/student/schedule', '/student/grades', '/student/finance', '/student/records']) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /student profile is not linked yet/i, path);
    }
    assert.equal(calls.some(([name]) => name === 'grades'), false, 'grades are not requested without a linked student record');
    assert.ok(calls.every(([, userId]) => userId === 7), 'all attempted reads use the authenticated account id');
  });
});
