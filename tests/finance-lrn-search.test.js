const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { formatMoney } = require('../src/utils/formatMoney');

const students = [
  { annual_enrollment_id: 10, student_id: 22, student_no: 'S-22', lrn: '001234567890', first_name: 'Alex', last_name: 'Kim' },
  { annual_enrollment_id: 11, student_id: 23, student_no: 'S-23', lrn: '009876543210', first_name: 'Alex', last_name: 'Kim' },
  { annual_enrollment_id: 12, student_id: 24, student_no: 'S-24', lrn: null, first_name: 'Alex', last_name: 'Kim' }
];

function matchingStudents(values = {}) {
  const pattern = values.searchPattern;
  if (!pattern) return students;
  const term = pattern.slice(1, -1);
  if (term.includes('~')) return [];
  return students.filter((student) => student.student_no.includes(term)
    || (student.lrn || '').includes(term)
    || `${student.first_name} ${student.last_name}`.includes(term));
}

function pageData(student) {
  return {
    annual_enrollment_id: student.annual_enrollment_id,
    student_id: student.student_id,
    school_year: '2026-2027',
    grade_level: 'Grade 11',
    voucher_code: 'PUB',
    voucher_category: 'Public',
    intake_status: 'active',
    student_no: student.student_no,
    lrn: student.lrn,
    first_name: student.first_name,
    middle_name: null,
    last_name: student.last_name,
    suffix: null,
    registrar_confirmation_id: null,
    assessed_voucher_code: null,
    assessed_schedule_version: null,
    voucher_review_required: 0,
    voucher_review_reason: null,
    enrollment_id: null
  };
}

function createRosterService() {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'finance' }] };
          const matches = matchingStudents(values);
          if (statement.includes('COUNT(DISTINCT annual.id) AS total_records')) {
            return { recordset: [{ total_records: matches.length }] };
          }
          if (statement.includes('SELECT COUNT(*) AS total_records')) {
            return { recordset: [{ total_records: matches.length }] };
          }
          if (statement.includes('SELECT DISTINCT annual.id AS annual_enrollment_id')) {
            const offset = Number(values.offset || 0);
            const pageSize = Number(values.pageSize || 20);
            return { recordset: matches.slice(offset, offset + pageSize).map((student) => ({
              annual_enrollment_id: student.annual_enrollment_id,
              school_year: '2026-2027', last_name: student.last_name, first_name: student.first_name
            })) };
          }
          if (statement.includes('SELECT classification.annual_enrollment_id, classification.school_year')) {
            return { recordset: matches.map((student) => ({ annual_enrollment_id: student.annual_enrollment_id,
              school_year: '2026-2027', last_name: student.last_name, first_name: student.first_name })) };
          }
          if (statement.includes('voucher_review_required') && statement.includes('FROM annual_enrollments AS annual')) {
            const selectedIds = new Set(Object.entries(values)
              .filter(([name]) => name.startsWith('pageAnnualId'))
              .map(([, value]) => Number(value)));
            return { recordset: matches.filter((student) => selectedIds.has(student.annual_enrollment_id)).map(pageData) };
          }
          if (statement.includes('CAST(COALESCE(annual_due.amount_due')) {
            return { recordset: matches.map(pageData) };
          }
          if (statement.includes('classification.annual_enrollment_id IN')) return { recordset: [] };
          if (statement.includes('FROM assessed_charges AS charge')) return { recordset: [] };
          if (statement.includes('FROM v_finance_legacy_account_balance')) return { recordset: [] };
          if (statement.includes('FROM v_finance_opening_liability_due')) return { recordset: [] };
          if (statement.includes('SELECT DISTINCT school_year')) return { recordset: [{ school_year: '2026-2027' }] };
          if (statement.includes('SELECT DISTINCT term.id')) return { recordset: [] };
          if (statement.includes('SELECT DISTINCT section.id')) return { recordset: [] };
          throw new Error(`Unexpected Finance search query: ${statement.slice(0, 90)}`);
        }
      };
    }
  };
  const service = createAnnualFinanceService({
    getPool: async () => pool,
    sql: { Int: 'INT', NVarChar: () => 'VARCHAR', ISOLATION_LEVEL: { REPEATABLE_READ: 'REPEATABLE READ' } },
    transactionFactory: (snapshotPool) => ({
      request: () => snapshotPool.request(),
      async begin() {}, async commit() {}, async rollback() {}
    })
  });
  return { calls, service };
}

test('paginated Finance search matches LRNs consistently and distinguishes same-name students', async () => {
  const { calls, service } = createRosterService();
  const byName = await service.listRosterPage(7, { search: 'Alex Kim' });
  assert.equal(byName.pagination.totalRecords, 3);
  assert.deepEqual(byName.rows.map((row) => row.student_no), ['S-22', 'S-23', 'S-24']);
  assert.deepEqual(byName.rows.map((row) => row.lrn), ['001234567890', '009876543210', null]);
  assert.deepEqual(new Set(byName.rows.map((row) => row.annual_enrollment_id)), new Set([10, 11, 12]));

  const rendered = await ejs.renderFile(path.join(__dirname, '../views/finance/annual-roster.ejs'), {
    title: 'Student accounts', formatMoney, rows: byName.rows,
    filters: { search: 'Alex Kim' }, schoolYears: ['2026-2027'], terms: [], sections: [],
    pagination: byName.pagination, notice: null, error: null
  });
  assert.equal((rendered.match(/<strong>Alex Kim<\/strong>/g) || []).length, 3);
  assert.match(rendered, /Student number: S-22[\s\S]*LRN: 001234567890/);
  assert.match(rendered, /Student number: S-23[\s\S]*LRN: 009876543210/);
  assert.match(rendered, /Student number: S-24[\s\S]*LRN: Not recorded/);
  assert.match(rendered, /backSearch=Alex\+Kim/);

  const start = calls.length;
  const byLeadingZeroLrn = await service.listRosterPage(7, { search: '001234567890', page: '1' });
  assert.equal(byLeadingZeroLrn.searchTerm, '001234567890');
  assert.equal(byLeadingZeroLrn.pagination.totalRecords, 1);
  assert.equal(byLeadingZeroLrn.rows[0].lrn, '001234567890');
  const lrnCalls = calls.slice(start);
  const lrnCount = lrnCalls.find(({ statement }) => statement.includes('COUNT(DISTINCT annual.id) AS total_records'));
  const lrnPageIds = lrnCalls.find(({ statement }) => statement.includes('SELECT DISTINCT annual.id AS annual_enrollment_id'));
  const lrnPageData = lrnCalls.find(({ statement }) => statement.includes('voucher_review_required') && statement.includes('FROM annual_enrollments AS annual'));
  for (const query of [lrnCount, lrnPageIds, lrnPageData]) {
    assert.ok(query);
    assert.match(query.statement, /student\.lrn LIKE @searchPattern ESCAPE '~'/);
    assert.equal(query.values.searchPattern, '%001234567890%');
  }

  const statusStart = calls.length;
  await service.listRosterPage(7, { search: '001234567890', financeStatus: 'unpaid' });
  const statusCalls = calls.slice(statusStart);
  const statusCount = statusCalls.find(({ statement }) => statement.includes('SELECT COUNT(*) AS total_records'));
  const statusPage = statusCalls.find(({ statement }) => statement.includes('SELECT classification.annual_enrollment_id, classification.school_year'));
  for (const query of [statusCount, statusPage]) {
    assert.ok(query);
    assert.match(query.statement, /student\.lrn LIKE @searchPattern ESCAPE '~'/);
    assert.equal(query.values.searchPattern, '%001234567890%');
  }
});

test('both Finance roster entry points preserve student-number and escaped wildcard searches', async () => {
  const { calls, service } = createRosterService();
  const byStudentNumber = await service.listRosterPage(7, { search: 'S-23' });
  assert.equal(byStudentNumber.pagination.totalRecords, 1);
  assert.equal(byStudentNumber.rows[0].lrn, '009876543210');

  const specialSearch = 'S_%[1]~';
  const start = calls.length;
  await service.listRoster(7, { search: specialSearch });
  const oldRosterQuery = calls.slice(start).find(({ statement }) => statement.includes('CAST(COALESCE(annual_due.amount_due'));
  assert.ok(oldRosterQuery);
  assert.match(oldRosterQuery.statement, /student\.student_no LIKE @searchPattern ESCAPE '~'/);
  assert.match(oldRosterQuery.statement, /student\.lrn LIKE @searchPattern ESCAPE '~'/);
  assert.match(oldRosterQuery.statement, /CONCAT_WS\([\s\S]*LIKE @searchPattern ESCAPE '~'/);
  assert.equal(oldRosterQuery.values.searchPattern, '%S~_~%~[1~]~~%');

  const pagedStart = calls.length;
  const empty = await service.listRosterPage(7, { search: specialSearch });
  assert.equal(empty.pagination.totalRecords, 0);
  const specialCount = calls.slice(pagedStart).find(({ statement }) => statement.includes('COUNT(DISTINCT annual.id) AS total_records'));
  const specialPage = calls.slice(pagedStart).find(({ statement }) => statement.includes('SELECT DISTINCT annual.id AS annual_enrollment_id'));
  for (const query of [specialCount, specialPage]) {
    assert.ok(query);
    assert.match(query.statement, /student\.lrn LIKE @searchPattern ESCAPE '~'/);
    assert.equal(query.values.searchPattern, '%S~_~%~[1~]~~%');
  }
});
