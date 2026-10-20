'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LAST_PAYABLE_OPTIONS, normalizeLastPayableInstallment, classifyDepartureCharge, proposedDepartureReduction
} = require('../src/services/departureFinanceReview');

test('departure tuition classification uses the saved fee category and exact canonical installment', () => {
  assert.equal(classifyDepartureCharge({ fee_category: 'tuition', line_name: 'Tuition legacy', installment: 'DP' }), 'canonical_tuition');
  assert.equal(classifyDepartureCharge({ fee_category: 'other', line_name: 'Tuition', installment: 'DP' }), 'individual_fee');
  assert.equal(classifyDepartureCharge({ fee_category: 'tuition', line_name: 'Tuition', installment: 'whole' }), 'manual_tuition');
  assert.equal(classifyDepartureCharge({ fee_category: 'tuition', line_name: 'Tuition', installment: 'DP / Prelim' }), 'manual_tuition');
});

test('cutoff preview proposes only later canonical tuition from the supplied saved payable basis', () => {
  assert.deepEqual(LAST_PAYABLE_OPTIONS, ['none', 'dp', 'prelim', 'midterm', 'finals']);
  assert.equal(normalizeLastPayableInstallment(' MIDTERM '), 'midterm');
  assert.equal(normalizeLastPayableInstallment('whole'), '');
  const expected = { none: ['dp', 'prelim', 'midterm', 'finals'], dp: ['prelim', 'midterm', 'finals'],
    prelim: ['midterm', 'finals'], midterm: ['finals'], finals: [] };
  for (const [cutoff, reduced] of Object.entries(expected)) {
    for (const installment of ['dp', 'prelim', 'midterm', 'finals']) {
      const proposal = proposedDepartureReduction({
        charge: { fee_category: 'tuition', installment }, termNumber: 2, departureTermNumber: 2,
        lastPayableInstallment: cutoff, payableBasisCents: 7345n
      });
      assert.equal(proposal, reduced.includes(installment) ? 7345n : 0n, `${installment} after ${cutoff}`);
    }
    assert.equal(proposedDepartureReduction({
      charge: { fee_category: 'tuition', installment: 'dp' }, termNumber: 3, departureTermNumber: 2,
      lastPayableInstallment: cutoff, payableBasisCents: 7345n
    }), 7345n, `later terms use the full saved payable basis after ${cutoff}`);
  }
});

test('legacy whole-term tuition and individual fees never receive an estimated suggestion', () => {
  for (const charge of [
    { fee_category: 'tuition', installment: 'whole' },
    { fee_category: 'miscellaneous', installment: 'As incurred' },
    { fee_category: 'other', installment: 'DP' }
  ]) {
    assert.equal(proposedDepartureReduction({ charge, termNumber: 3, departureTermNumber: 1,
      lastPayableInstallment: 'none', payableBasisCents: 99900n }), 0n);
  }
});

test('nonpositive saved payable basis stays signed but cannot produce a reduction proposal', () => {
  const charge = { fee_category: 'tuition', installment: 'finals' };
  for (const payableBasisCents of [0n, -4500n]) {
    assert.equal(proposedDepartureReduction({ charge, termNumber: 2, departureTermNumber: 1,
      lastPayableInstallment: 'none', payableBasisCents }), 0n);
  }
});
