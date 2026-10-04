const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatementProjection } = require('../src/utils/financeStatementProjection');

test('print projection groups exact term and installment balances and excludes private correction details', () => {
  const projected = createStatementProjection({
    summary: { unattributedLegacyBalance: '19.00', openingLiabilityDue: '4.00' },
    charges: [
      { school_year: '2026-2027', annual_term_number: 1, term: 'Term 1', installment: 'DP', amount: '100.00', waived_amount: '10.00', adjustments: '-5.00', allocated: '20.00', remaining_due: '65.00' },
      { school_year: '2026-2027', annual_term_number: 1, term: 'Term 1', installment: 'DP', amount: '50.00', waived_amount: '0.00', adjustments: '0.00', allocated: '5.00', remaining_due: '45.00' }
    ],
    events: [
      { event_type: 'payment', details: 'Payment #10 · receipt issued', reference_no: 'CURRENT-OR-EDITED', amount: '30.00' },
      { event_type: 'adjustment', details: 'Private adjustment reason', reference_no: null, amount: '-1.00' },
      { event_type: 'payment reversal', details: 'Private reversal reason', reference_no: null, amount: null },
      { event_type: 'payment private_remark_added', details: 'Secret staff note', reference_no: 'STALE-PRIVATE-REFERENCE', amount: null }
    ]
  });
  assert.deepEqual(projected.termBalances.map(({ required, applied, due }) => ({ required, applied, due })), [
    { required: '135.00', applied: '25.00', due: '110.00' }
  ]);
  assert.equal(projected.charges[0].required_amount, '85.00');
  assert.equal(projected.charges[0].applied_amount, '20.00');
  assert.equal(projected.charges[0].due_amount, '65.00');
  assert.equal(projected.summary.unattributedLegacyBalance, '19.00');
  assert.equal(projected.events[0].reference_no, 'CURRENT-OR-EDITED');
  assert.equal(projected.events[1].details, 'Fee adjustment recorded');
  assert.equal(projected.events[2].details, 'Payment correction recorded');
  assert.equal(projected.events[3].details, 'Finance account update');
  assert.equal(projected.events[3].reference_no, null);
  assert.doesNotMatch(JSON.stringify(projected.events), /Private adjustment reason|Private reversal reason|Secret staff note|STALE-PRIVATE/);
});
