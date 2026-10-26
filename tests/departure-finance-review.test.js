'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LAST_PAYABLE_OPTIONS, normalizeLastPayableInstallment, classifyDepartureCharge, proposedDepartureReduction,
  safeDepartureDefault, wouldCancelPaidFutureTuition
} = require('../src/services/departureFinanceReview');
const { FinanceCasesError, createAnnualFinanceCasesService } = require('../src/services/annualFinanceCasesService');

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

test('ordinary tuition is automatic, other fees stay payable, and paid tuition requires review', () => {
  const row = { reviewCategory: 'canonical_tuition', payableBasisCents: 87500n };
  assert.deepEqual(safeDepartureDefault({ ...row, proposedReductionCents: 87500n, appliedCents: 0n }),
    { decision: 'reduce', reductionCents: 87500n });
  assert.deepEqual(safeDepartureDefault({ ...row, proposedReductionCents: 0n, appliedCents: 0n }),
    { decision: 'retain', reductionCents: 0n });
  assert.equal(safeDepartureDefault({ ...row, proposedReductionCents: 87500n, appliedCents: 10000n }), null);
  assert.equal(safeDepartureDefault({ ...row, proposedReductionCents: 0n, appliedCents: 10000n }), null);
  assert.equal(safeDepartureDefault({ ...row, proposedReductionCents: 87500n, appliedCents: null }), null);
  assert.deepEqual(safeDepartureDefault({ ...row, reviewCategory: 'individual_fee',
    proposedReductionCents: 87500n, appliedCents: 0n }),
  { decision: 'retain', reductionCents: 0n });
  assert.deepEqual(safeDepartureDefault({ ...row, reviewCategory: 'manual_tuition',
    proposedReductionCents: 87500n, appliedCents: 10000n }),
  { decision: 'retain', reductionCents: 0n });
});

test('a stale or manual full cancellation cannot erase paid future tuition', () => {
  const future = { reviewCategory: 'canonical_tuition', termNumber: 2, departureTermNumber: 1,
    reductionCents: 87500n, payableBasisCents: 87500n };
  assert.equal(wouldCancelPaidFutureTuition({ ...future, appliedCents: 10000n }), true);
  assert.equal(wouldCancelPaidFutureTuition({ ...future, appliedCents: 0n }), false);
  assert.equal(wouldCancelPaidFutureTuition({ ...future, reductionCents: 50000n, appliedCents: 10000n }), false);
  assert.equal(wouldCancelPaidFutureTuition({ ...future, termNumber: 1, appliedCents: 10000n }), false);
});

test('Finance departure review accepts newline and tab in its reason only', async () => {
  const databaseBoundary = new Error('synthetic database boundary');
  let databaseCalls = 0;
  const service = createAnnualFinanceCasesService({ getPool: async () => {
    databaseCalls += 1;
    throw databaseBoundary;
  } });
  const base = { reason: 'Confirmed with guardian\r\nLast payable date is unclear\tReview pending.',
    cutoffInstallment: 'none', idempotencyKey: '41111111-1111-4111-8111-111111111111' };
  await assert.rejects(service.reviewDepartureCase(7, 16, base), (error) => error === databaseBoundary,
    'valid multiline reason passes service input validation before the database boundary');
  assert.equal(databaseCalls, 1);

  await assert.rejects(service.reviewDepartureCase(7, 16, { ...base,
    chargeReviews: [{ chargeId: '21', decision: 'retain', reductionAmount: '', reason: '' }] }),
  (error) => error === databaseBoundary,
  'Keep with an omitted or blank reduction is normalized to zero before the database boundary');
  assert.equal(databaseCalls, 2);

  await assert.rejects(service.reviewDepartureCase(7, 16, { ...base,
    chargeReviews: [{ chargeId: '21', decision: 'retain', reductionAmount: 'not-money', reason: '' }] }),
  (error) => error.status === 400,
  'malformed Keep amounts fail before database access');
  await assert.rejects(service.reviewDepartureCase(7, 16, { ...base,
    chargeReviews: [{ chargeId: '21', decision: 'retain', reductionAmount: '1.00', reason: '' }] }),
  (error) => error === databaseBoundary,
  'a valid nonzero Keep amount reaches the locked case check, where it must be rejected');
  await assert.rejects(service.reviewDepartureCase(7, 16, { ...base,
    chargeReviews: [{ chargeId: '21', decision: 'reduce', reductionAmount: '', reason: '' }] }),
  (error) => error.status === 400,
  'Reduce still requires a valid amount');

  for (const control of ['\u0000', '\u000b', '\u001f', '\u007f', '\u0085', '\u009f']) {
    await assert.rejects(service.reviewDepartureCase(7, 16, { ...base, reason: `Line${control}break` }),
      (error) => error instanceof FinanceCasesError && error.status === 400);
  }
  await assert.rejects(service.reviewDepartureCase(7, 16, { ...base,
    chargeReviews: [{ chargeId: '21', decision: 'retain', reason: 'Per-fee\nreason' }] }),
  (error) => error instanceof FinanceCasesError && /Per-charge Finance reason/.test(error.message),
  'per-charge fee reasons remain single-line');
  assert.equal(databaseCalls, 3, 'blank Keep and syntactically valid amounts reach the database boundary; malformed input and per-charge newlines do not');
});
