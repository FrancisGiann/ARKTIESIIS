const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnnualFinanceReportsService } = require('../src/services/annualFinanceReportsService');

function makeReportsService(observed) {
  const sql = { Int: 'INT', Date: 'DATE', DateTime: 'DATETIME', ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' } };
  const getPool = async () => ({ request() { return makeRequest(observed); } });
  sql.Transaction = function Transaction() {
    return {
      async begin() {}, async commit() {}, async rollback() {},
      request() { return makeRequest(observed); }
    };
  };
  return createAnnualFinanceReportsService({ getPool, sql });
}

function makeRequest(observed) {
  const inputs = {};
  return {
    input(name, type, value) { inputs[name] = { type, value }; return this; },
    async query(statement) {
      observed.push({ statement, inputs: { ...inputs } });
      if (statement.includes('FROM users WHERE')) return { recordset: [{ id: 7 }] };
      if (statement.includes('AS total_records')) return { recordset: [{ total_records: 1 }] };
      return { recordset: [] };
    }
  };
}

test('correction reports use Manila-day bounds and display dates at UTC+8 boundaries', async () => {
  const observed = [];
  const reports = makeReportsService(observed);
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
  await reports.reports(7, { fromDate: '2026-10-04', toDate: '2026-10-04' });
  const aggregate = observed.filter(({ statement }) => statement.includes('finance_payment_reversals'));
  assert.equal(aggregate.length, 2);
  assert.match(aggregate[0].statement, /DATE_FORMAT\(DATE_ADD\(reversal\.created_at, INTERVAL 8 HOUR\), '%Y-%m-%d'\)/);
  assert.equal(aggregate[0].inputs.correctionFromUtc.value, '2026-10-03 16:00:00');
  assert.equal(aggregate[0].inputs.correctionToUtc.value, '2026-10-04 16:00:00');

  const timestamps = [
    ['2026-10-03 15:59:59', false], // Manila Oct 3, before this report day.
    ['2026-10-03 16:00:00', true],  // Manila midnight at the start of Oct 4.
    ['2026-10-04 15:59:59', true],  // Last second of Manila Oct 4.
    ['2026-10-04 16:00:00', false]  // Manila midnight at the start of Oct 5.
  ];
  for (const [utc, included] of timestamps) {
    const local = new Date(`${utc.replace(' ', 'T')}Z`);
    local.setUTCHours(local.getUTCHours() + 8);
    const day = local.toISOString().slice(0, 10);
    assert.equal(day === '2026-10-04', included, `UTC event ${utc} must be classified by Manila date`);
  }
});
