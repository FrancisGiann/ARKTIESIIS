'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinanceAssessmentQueueService, parseAssessmentQueueFilters } = require('../src/services/financeAssessmentQueueService');

const sql = { Int: 'int', NVarChar: () => 'text' };

function queueFixture(rows, { schoolYears = ['2026-2027', '2025-2026'], reviewed = new Map(), denied = false } = {}) {
  const queries = [];
  const classifications = [];
  const transaction = { request() {
    const params = {};
    const request = { input(name, _type, value) { params[name] = value; return request; }, async query(statement) {
      queries.push({ statement, params: { ...params } });
      if (statement.includes('SELECT DISTINCT school_year')) {
        return { recordset: schoolYears.map((school_year) => ({ school_year })) };
      }
      const selectedRows = params.schoolYear ? rows.filter((row) => row.school_year === params.schoolYear) : rows;
      return { recordset: selectedRows.map((row) => ({ ...row })) };
    } };
    return request;
  } };
  const queue = createFinanceAssessmentQueueService({ sql, withFinanceQueueSnapshot: async (actorId, callback) => {
    if (denied) throw Object.assign(new Error('Your Finance access is no longer active. Sign in again.'), { status: 403 });
    return callback({ actor: { id: actorId, role: 'finance' }, transaction, classifyReadiness: async (inputRows) => {
      classifications.push(inputRows.map((row) => Number(row.annual_enrollment_id)));
      return new Map(inputRows.map((row) => [Number(row.annual_enrollment_id), reviewed.get(Number(row.annual_enrollment_id)) ?? true]));
    } });
  } });
  return { queue, queries, classifications };
}

function candidate(index, overrides = {}) {
  return { annual_enrollment_id: index, student_id: index + 100, school_year: '2026-2027', grade_level: 'Grade 7',
    voucher_code: 'ESC', intake_status: 'pending', student_no: `SYN-${index}`,
    student_name: `Synthetic ${String(index).padStart(4, '0')}`,
    assessment_id: index + 1000, schedule_id: 3, schedule_version: 2, assessed_voucher_code: 'ESC',
    has_finance_review: 1, voucher_review_required: 0, ...overrides };
}

test('assessment queue defaults to pending and rejects malformed scope before snapshot access', async () => {
  assert.deepEqual(parseAssessmentQueueFilters({}), { view: 'pending', schoolYear: '', page: 1 });
  for (const filters of [{ view: 'payments' }, { page: '0' }, { schoolYear: '\n' }]) {
    assert.throws(() => parseAssessmentQueueFilters(filters));
  }
  let accessed = false;
  const queue = createFinanceAssessmentQueueService({ sql,
    withFinanceQueueSnapshot: async () => { accessed = true; throw new Error('unexpected'); } });
  await assert.rejects(queue.list(7, { view: 'payments' }), /Choose Pending approval/);
  assert.equal(accessed, false);
});

test('queue classifies pending reviewed candidates in one snapshot before counts and pagination', async () => {
  const rows = Array.from({ length: 24 }, (_, index) => candidate(index + 1));
  for (let index = 0; index < 21; index += 1) {
    rows[index] = candidate(index + 1, { assessment_id: null, has_finance_review: 0 });
  }
  const fixture = queueFixture(rows);
  const result = await fixture.queue.list(7, { schoolYear: '2026-2027', page: '2' });
  assert.equal(result.filters.view, 'pending');
  assert.deepEqual(result.counts, { pending: 21, approved: 3 });
  assert.equal(result.pagination.page, 2);
  assert.equal(result.rows[0].annual_enrollment_id, 21);
  assert.equal(fixture.classifications.length, 1);
  assert.deepEqual(fixture.classifications[0], [22, 23, 24]);
  assert.equal(fixture.queries.length, 2);
  assert.equal(fixture.queries.at(-1).params.schoolYear, '2026-2027');
  assert.match(fixture.queries.at(-1).statement, /FROM AssessmentQueue/);
  assert.doesNotMatch(fixture.queries.at(-1).statement, /payment_status|finance_payments/);
});

test('stale review evidence moves pending rows back to the approval queue across filtered pages', async () => {
  const rows = Array.from({ length: 44 }, (_, index) => candidate(index + 1));
  const reviewed = new Map(rows.map((row) => [row.annual_enrollment_id, true]));
  reviewed.set(21, false);
  reviewed.set(22, false);
  const fixture = queueFixture(rows, { reviewed });
  const pending = await fixture.queue.list(7, { schoolYear: '2026-2027', page: '2' });
  assert.deepEqual(pending.counts, { pending: 2, approved: 42 });
  assert.equal(pending.pagination.totalPages, 1);
  assert.deepEqual(pending.rows.map((row) => row.annual_enrollment_id), [21, 22]);
  const approvedPage = await fixture.queue.list(7, { view: 'approved', schoolYear: '2026-2027', page: '2' });
  assert.deepEqual(approvedPage.counts, { pending: 2, approved: 42 });
  assert.equal(approvedPage.rows[0].annual_enrollment_id, 23);
  assert.equal(approvedPage.rows.length, 20);
  assert.equal(fixture.classifications.length, 2);
});

test('voucher-flagged candidates remain pending and are not included in readiness batch', async () => {
  const rows = [candidate(1, { voucher_review_required: 1 }), candidate(2)];
  const fixture = queueFixture(rows);
  const result = await fixture.queue.list(7);
  assert.deepEqual(result.counts, { pending: 1, approved: 1 });
  assert.deepEqual(fixture.classifications, [[2]]);
  assert.equal(result.rows[0].annual_enrollment_id, 1);
});

test('non-pending rows preserve their existing queue semantics and are not reclassified', async () => {
  const rows = [candidate(1, { intake_status: 'confirmed' }), candidate(2, { intake_status: 'pending', assessment_id: null,
    has_finance_review: 0 })];
  const fixture = queueFixture(rows);
  const result = await fixture.queue.list(7, { view: 'approved' });
  assert.deepEqual(result.counts, { pending: 1, approved: 1 });
  assert.deepEqual(fixture.classifications, [[]]);
  assert.deepEqual(result.rows.map((row) => row.annual_enrollment_id), [1]);
});

test('inactive or unrelated actor fails before the candidate query', async () => {
  const fixture = queueFixture([candidate(1)], { denied: true });
  await assert.rejects(fixture.queue.list(12), /Finance access is no longer active/);
  assert.equal(fixture.queries.length, 0);
  assert.equal(fixture.classifications.length, 0);
});

test('all-year and selected-year views preserve independent counts and pagination', async () => {
  const rows = Array.from({ length: 50 }, (_, index) => {
    const id = index + 1;
    return candidate(id, { school_year: id <= 25 ? '2026-2027' : '2025-2026' });
  });
  const reviewed = new Map(rows.map((row) => [row.annual_enrollment_id, true]));
  reviewed.set(4, false);
  reviewed.set(29, false);
  const fixture = queueFixture(rows, { reviewed });

  const allYears = await fixture.queue.list(7, { page: '1' });
  assert.deepEqual(allYears.schoolYears, ['2026-2027', '2025-2026']);
  assert.deepEqual(allYears.counts, { pending: 2, approved: 48 });
  assert.deepEqual(allYears.rows.map((row) => row.annual_enrollment_id), [4, 29]);
  assert.deepEqual(allYears.pagination, { page: 1, totalPages: 1, total: 2, from: 1, to: 2 });

  const currentYear = await fixture.queue.list(7, { schoolYear: '2026-2027', view: 'approved', page: '2' });
  assert.deepEqual(currentYear.counts, { pending: 1, approved: 24 });
  assert.deepEqual(currentYear.pagination, { page: 2, totalPages: 2, total: 24, from: 21, to: 24 });
  assert.deepEqual(currentYear.rows.map((row) => row.annual_enrollment_id), [22, 23, 24, 25]);

  const priorYear = await fixture.queue.list(7, { schoolYear: '2025-2026', view: 'approved' });
  assert.deepEqual(priorYear.counts, { pending: 1, approved: 24 });
  assert.deepEqual(priorYear.rows.map((row) => row.annual_enrollment_id).slice(0, 3), [26, 27, 28]);
  assert.equal(fixture.classifications.length, 3);
});
