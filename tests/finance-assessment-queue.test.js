'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinanceAssessmentQueueService, parseAssessmentQueueFilters } = require('../src/services/financeAssessmentQueueService');

const sql = { Int: 'int', NVarChar: () => 'text' };

test('assessment queue defaults to pending and rejects malformed scope before database access', async () => {
  assert.deepEqual(parseAssessmentQueueFilters({}), { view: 'pending', schoolYear: '', page: 1 });
  for (const filters of [{ view: 'payments' }, { page: '0' }, { schoolYear: '\n' }]) {
    assert.throws(() => parseAssessmentQueueFilters(filters));
  }
  let accessed = false;
  const queue = createFinanceAssessmentQueueService({ getPool: async () => { accessed = true; throw new Error('unexpected'); }, sql });
  await assert.rejects(queue.list(7, { view: 'payments' }), /Choose Pending approval/);
  assert.equal(accessed, false);
});

test('assessment queue is role checked, scoped, paginated and keeps review separate from payments', async () => {
  const queries = [];
  const pool = { request() {
    const params = {};
    const request = { input(name, _type, value) { params[name] = value; return request; }, async query(statement) {
      queries.push({ statement, params: { ...params } });
      if (statement.includes('FROM users')) return { recordset: [{ id: 7 }] };
      if (statement.includes('SELECT DISTINCT school_year')) return { recordset: [{ school_year: '2026-2027' }] };
      return { recordset: Array.from({ length: 24 }, (_, index) => ({ annual_enrollment_id: index + 1,
        student_id: index + 23, intake_status: 'pending', assessment_id: index < 21 ? null : 91,
        schedule_id: 4, schedule_version: 2, assessed_voucher_code: 'PUB', has_finance_review: index < 21 ? 0 : 1,
        voucher_review_required: 0 })) };
    } };
    return request;
  } };
  const queue = createFinanceAssessmentQueueService({ getPool: async () => pool, sql,
    getReadiness: async () => ({ reviewed: true }) });
  const result = await queue.list(7, { schoolYear: '2026-2027', page: '2' });
  assert.equal(result.filters.view, 'pending');
  assert.deepEqual(result.counts, { pending: 21, approved: 3 });
  assert.equal(result.pagination.page, 2);
  assert.equal(result.rows[0].annual_enrollment_id, 21);
  assert.equal(queries.at(-1).params.schoolYear, '2026-2027');
  assert.match(queries.at(-1).statement, /FROM AssessmentQueue/);
  assert.doesNotMatch(queries.at(-1).statement, /payment_status|finance_payments/);
  await assert.rejects(queue.list(7, { schoolYear: '2027-2028' }), /Choose a school year/);
  assert.equal(queries.at(-1).statement.includes('SELECT DISTINCT'), true);
});

test('stale Finance evidence moves a pending intake back to the approval queue', async () => {
  const pool = { request() {
    const request = { input() { return request; }, async query(statement) {
      if (statement.includes('FROM users')) return { recordset: [{ id: 7 }] };
      if (statement.includes('SELECT DISTINCT school_year')) return { recordset: [{ school_year: '2026-2027' }] };
      return { recordset: [{ annual_enrollment_id: 42, student_id: 23, intake_status: 'pending',
        assessment_id: 91, has_finance_review: 1, voucher_review_required: 0 }] };
    } }; return request;
  } };
  const queue = createFinanceAssessmentQueueService({ getPool: async () => pool, sql,
    getReadiness: async (_actorId, annualId) => { assert.equal(annualId, 42); return { reviewed: false }; } });
  const pending = await queue.list(7);
  assert.deepEqual(pending.counts, { pending: 1, approved: 0 });
  assert.equal(pending.rows[0].has_finance_review, 0);
});

test('inactive or unrelated actor never reaches account queue query', async () => {
  const queries = [];
  const pool = { request() {
    const request = { input() { return request; }, async query(statement) { queries.push(statement); return { recordset: [] }; } };
    return request;
  } };
  const queue = createFinanceAssessmentQueueService({ getPool: async () => pool, sql });
  await assert.rejects(queue.list(12), /Finance access is no longer active/);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /role IN \('finance', 'database_admin'\)/);
});
