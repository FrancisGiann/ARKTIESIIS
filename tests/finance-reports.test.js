const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnnualFinanceReportsService, FinanceReportsError } = require('../src/services/annualFinanceReportsService');
const { safeErrorDiagnostics } = require('../src/utils/safeErrorDiagnostics');

function makeReportsService({ observed = [], events = [], failWhen = null } = {}) {
  const sql = {
    Int: 'INT', Date: 'DATE', DateTime: 'DATETIME',
    ISOLATION_LEVEL: { REPEATABLE_READ: 'REPEATABLE READ' }
  };
  const getPool = async () => ({});
  const transactionFactory = () => ({
    async begin(isolation) { events.push({ action: 'begin', isolation }); },
    async commit() { events.push({ action: 'commit' }); },
    async rollback() { events.push({ action: 'rollback' }); },
    request() { return makeRequest(observed, failWhen); }
  });
  return createAnnualFinanceReportsService({ getPool, sql, transactionFactory });
}

function makeRequest(observed, failWhen) {
  const inputs = {};
  return {
    input(name, type, value) { inputs[name] = { type, value }; return this; },
    async query(statement) {
      observed.push({ statement, inputs: { ...inputs } });
      if (failWhen?.(statement)) {
        const error = new Error('private report SQL and sensitive data');
        error.code = 'ER_INVALID_GROUP_FUNC_USE';
        error.errno = 1111;
        error.sqlState = 'HY000';
        throw error;
      }
      if (statement.includes('FROM users WHERE')) return { recordset: [{ id: 7 }] };
      if (statement.includes('AS total_records')) return { recordset: [{ total_records: 0 }] };
      if (statement.includes('AS applicable_enrollments')) return { recordset: [
        {
          school_year: '2026-2027', grade_level: 'Grade 11', academic_term_id: 3, term: 'Term 1',
          annual_term_number: 1, section_id: 9, section_name: 'Blue', strand: 'STEM', voucher_code: 'PUB',
          applicable_enrollments: 2, enrolled_students: 1, paid_or_waived_students: 1,
          waived_students: 1, outstanding_amount: '25.00', waived_amount: '25.00'
        }
      ] };
      return { recordset: [] };
    }
  };
}

test('reports execute only the selected view query set inside a lock-free repeatable-read snapshot', async () => {
  const cases = [
    { view: 'collections', count: 2, fragments: ['DATE_FORMAT(payment.payment_date', 'AS valid_collection_amount'] },
    { view: 'allocations', count: 3, fragments: ['v_finance_net_payment_allocations', 'AS allocated_amount'] },
    { view: 'corrections', count: 2, fragments: ['DATE_ADD(reversal.created_at', 'AS corrected_record_amount'] },
    { view: 'term-balances', count: 1, fragments: [
      'v_finance_assessed_charge_due AS due', 'AS applicable_enrollments', 'section.id, section.name'
    ] }
  ];
  for (const { view, count, fragments } of cases) {
    const observed = [];
    const events = [];
    const reports = makeReportsService({ observed, events });
    const result = await reports.reports(7, { view, fromDate: '2026-10-04', toDate: '2026-10-04' });
    const reportQueries = observed.filter(({ statement }) => !statement.includes('FROM users WHERE'));
    assert.equal(reportQueries.length, count, `${view} runs only its selected report statements`);
    for (const fragment of fragments) assert.ok(reportQueries.some(({ statement }) => statement.includes(fragment)), `${view} contains ${fragment}`);
    assert.equal(result.fromDate, '2026-10-04');
    assert.equal(result.toDate, '2026-10-04');
    assert.ok(Array.isArray(result.dailyCollections));
    assert.ok(Array.isArray(result.reversals));
    assert.ok(Array.isArray(result.allocationContexts));
    assert.ok(Array.isArray(result.termProgress));
    if (view === 'term-balances') {
      assert.equal(result.termProgress.length, 1);
      assert.equal(result.termProgress[0].applicable_enrollments, 2, 'applicable counts distinct enrolled and pending students');
      assert.equal(result.termProgress[0].enrolled_students, 1);
      assert.equal(result.termProgress[0].paid_or_waived_students, 1);
      assert.equal(result.termProgress[0].waived_students, 1);
      assert.equal(result.termProgress[0].outstanding_amount, '25.00');
      assert.equal(result.termProgress[0].waived_amount, '25.00', 'waived totals include applicable placements regardless of status');
      assert.match(reportQueries[0].statement, /GROUP BY[\s\S]*section\.id, section\.name/,
        'term progress groups every selected section dimension under ONLY_FULL_GROUP_BY');
    }
    assert.match(observed[0].statement, /role IN \('finance', 'database_admin'\)/);
    assert.doesNotMatch(observed[0].statement, /FOR UPDATE/i);
    assert.deepEqual(events, [
      { action: 'begin', isolation: 'REPEATABLE READ' },
      { action: 'commit' }
    ]);
  }
});

test('reports without a view retain the legacy all-views result and invalid actor/view inputs are rejected', async () => {
  const observed = [];
  const reports = makeReportsService({ observed });
  const result = await reports.reports('7', { fromDate: '2026-10-04', toDate: '2026-10-04' });
  assert.equal(observed.filter(({ statement }) => !statement.includes('FROM users WHERE')).length, 8);
  assert.ok(Array.isArray(result.dailyCollections));
  assert.ok(Array.isArray(result.reversals));
  assert.ok(Array.isArray(result.allocationContexts));
  assert.ok(Array.isArray(result.termProgress));
  await assert.rejects(reports.reports(0, { view: 'collections', fromDate: '2026-10-04', toDate: '2026-10-04' }),
    (error) => error instanceof FinanceReportsError && error.status === 403);
  await assert.rejects(reports.reports(7, { view: 'unexpected', fromDate: '2026-10-04', toDate: '2026-10-04' }),
    (error) => error instanceof FinanceReportsError && error.status === 400);
});

test('allocation-context SQL failures retain a bounded phase and safe database diagnostics', async () => {
  const observed = [];
  const events = [];
  const reports = makeReportsService({
    observed, events,
    failWhen: (statement) => statement.includes('AS allocated_amount') && statement.includes('finance_legacy_opening_charges')
  });
  await assert.rejects(reports.reports(7, {
    view: 'allocations', fromDate: '2026-10-04', toDate: '2026-10-04'
  }), (error) => {
    assert.ok(error instanceof FinanceReportsError);
    assert.equal(error.status, 503);
    assert.equal(error.queryPhase, 'opening_allocation_contexts');
    assert.equal(error.cause.code, 'ER_INVALID_GROUP_FUNC_USE');
    assert.equal(error.cause.errno, 1111);
    const diagnostics = safeErrorDiagnostics(error.cause);
    assert.equal(diagnostics.errorCode, 'ER_INVALID_GROUP_FUNC_USE');
    assert.equal(diagnostics.errorNumber, 1111);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private|sensitive/i);
    return true;
  });
  assert.deepEqual(events, [
    { action: 'begin', isolation: 'REPEATABLE READ' },
    { action: 'rollback' }
  ]);
});

test('term-balance query failures identify the summary phase and roll back', async () => {
  const cases = [['AS outstanding_amount', 'term_progress_summary']];
  for (const [fragment, phase] of cases) {
    const observed = [];
    const events = [];
    const reports = makeReportsService({ observed, events, failWhen: (statement) => statement.includes(fragment) });
    await assert.rejects(reports.reports(7, {
      view: 'term-balances', fromDate: '2026-10-04', toDate: '2026-10-04'
    }), (error) => error instanceof FinanceReportsError && error.status === 503 && error.queryPhase === phase);
    assert.deepEqual(events, [
      { action: 'begin', isolation: 'REPEATABLE READ' },
      { action: 'rollback' }
    ]);
  }
});

test('correction reports use Manila-day bounds and display dates at UTC+8 boundaries', async () => {
  const observed = [];
  const reports = makeReportsService({ observed });
  const details = await reports.reportDetails(7, {
    kind: 'corrections', fromDate: '2026-10-04', toDate: '2026-10-04'
  });
  const correctionQueries = observed.filter(({ statement }) => statement.includes('finance_payment_reversals'));
  assert.equal(correctionQueries.length, 2);
  for (const query of correctionQueries) {
    assert.equal(query.inputs.correctionFromUtc.value, '2026-10-03 16:00:00');
    assert.equal(query.inputs.correctionToUtc.value, '2026-10-04 16:00:00');
    assert.match(query.statement, /reversal\.created_at >= @correctionFromUtc AND reversal\.created_at < @correctionToUtc/);
  }
  assert.match(correctionQueries[1].statement, /DATE_ADD\(reversal\.created_at, INTERVAL 8 HOUR\)/);
  assert.equal(details.correctionFromUtc, '2026-10-03 16:00:00');

  observed.length = 0;
  await reports.reports(7, { view: 'corrections', fromDate: '2026-10-04', toDate: '2026-10-04' });
  const aggregate = observed.filter(({ statement }) => statement.includes('finance_payment_reversals'));
  assert.equal(aggregate.length, 2);
  assert.match(aggregate[0].statement, /DATE_FORMAT\(DATE_ADD\(reversal\.created_at, INTERVAL 8 HOUR\), '%Y-%m-%d'\)/);
  assert.equal(aggregate[0].inputs.correctionFromUtc.value, '2026-10-03 16:00:00');
  assert.equal(aggregate[0].inputs.correctionToUtc.value, '2026-10-04 16:00:00');

  const timestamps = [
    ['2026-10-03 15:59:59', false],
    ['2026-10-03 16:00:00', true],
    ['2026-10-04 15:59:59', true],
    ['2026-10-04 16:00:00', false]
  ];
  for (const [utc, included] of timestamps) {
    const local = new Date(`${utc.replace(' ', 'T')}Z`);
    local.setUTCHours(local.getUTCHours() + 8);
    const day = local.toISOString().slice(0, 10);
    assert.equal(day === '2026-10-04', included, `UTC event ${utc} must be classified by Manila date`);
  }
});

test('detail pagination clamps zero to page one and binds a nonnegative offset', async () => {
  const observed = [];
  const reports = makeReportsService({ observed });
  const detail = await reports.reportDetails(7, {
    kind: 'allocations', fromDate: '2026-10-04', toDate: '2026-10-04', page: '0'
  });
  assert.equal(detail.pagination.page, 1);
  const dataQuery = observed.find(({ statement }) => statement.includes('target_label'));
  assert.equal(dataQuery.inputs.offset.value, 0);
  assert.equal(dataQuery.inputs.pageSize.value, 20);
});

test('detail query failures preserve the data phase and roll back the snapshot', async () => {
  const observed = [];
  const events = [];
  const reports = makeReportsService({ observed, events, failWhen: (statement) => statement.includes('target_label') });
  await assert.rejects(reports.reportDetails(7, {
    kind: 'allocations', fromDate: '2026-10-04', toDate: '2026-10-04'
  }), (error) => {
    assert.ok(error instanceof FinanceReportsError);
    assert.equal(error.status, 503);
    assert.equal(error.queryPhase, 'details_data');
    assert.equal(error.cause.code, 'ER_INVALID_GROUP_FUNC_USE');
    return true;
  });
  assert.deepEqual(events, [
    { action: 'begin', isolation: 'REPEATABLE READ' },
    { action: 'rollback' }
  ]);
});
