const test = require('node:test');
const assert = require('node:assert/strict');
const { FINANCE_STATUS } = require('../src/services/financeTermClassification');
const { PAYMENT_STATUS_LABELS, paymentStatusPresentation } = require('../src/utils/financeStatusPresentation');

const reviewedAssessment = {
  finance_status: FINANCE_STATUS.NEEDS_REVIEW,
  assessment_id: 41,
  matching_assessment_confirmation_id: 52,
  assessed_charge_count: 4,
  tuition_line_count: 4,
  canonical_tuition_count: 4,
  dp_count: 1,
  prelim_count: 1,
  midterm_count: 1,
  finals_count: 1,
  whole_tracking_available: 1,
  installment_tracking_available: 1
};

test('missing assessment is shown before other unavailable-status reasons', () => {
  const result = paymentStatusPresentation({ ...reviewedAssessment, assessment_id: null, assessed_charge_count: 0 });
  assert.equal(result.label, 'Payment status unavailable');
  assert.equal(result.reason, 'Fees not assessed');
  assert.match(result.guidance, /Record an annual assessment/);
});

test('missing matching assessment confirmation covers a confirmation tied to another assessment', () => {
  const result = paymentStatusPresentation({
    ...reviewedAssessment,
    registrar_confirmation_id: 77,
    matching_assessment_confirmation_id: null
  });
  assert.equal(result.reason, 'Awaiting registrar confirmation');
  assert.equal(result.guidance, 'The registrar must confirm enrollment using the current fee assessment.');
});

test('zero assessed fees gets a distinct reason after assessment and confirmation exist', () => {
  const result = paymentStatusPresentation({ ...reviewedAssessment, assessed_charge_count: '0' });
  assert.equal(result.reason, 'Fees not recorded');
  assert.equal(result.guidance, 'Check the fee entries for this term.');
});

test('incomplete installment split points to Entire term only when that projection is available', () => {
  const olderWholeTerm = {
    ...reviewedAssessment,
    finance_status: FINANCE_STATUS.NEEDS_REVIEW,
    tuition_line_count: 1,
    canonical_tuition_count: 0,
    dp_count: 0,
    prelim_count: 0,
    midterm_count: 0,
    finals_count: 0,
    whole_tracking_available: 1,
    installment_tracking_available: 0
  };
  const result = paymentStatusPresentation(olderWholeTerm, 'dp');
  assert.equal(result.reason, 'Payment breakdown unavailable');
  assert.match(result.guidance, /Select Entire term/);

  const noWholeTermProjection = paymentStatusPresentation({ ...olderWholeTerm, whole_tracking_available: 0 }, 'dp');
  assert.doesNotMatch(noWholeTermProjection.guidance, /Entire term/);
});

test('normal payment statuses retain their existing labels without review explanations', () => {
  for (const [status, label] of Object.entries({
    [FINANCE_STATUS.UNPAID]: 'Unpaid',
    [FINANCE_STATUS.PARTIAL]: 'Partially paid',
    [FINANCE_STATUS.FULL]: 'Fully paid',
    [FINANCE_STATUS.NO_PAYMENT_REQUIRED]: 'No payment required'
  })) {
    assert.deepEqual(paymentStatusPresentation({ finance_status: status }), { label, reason: null, guidance: null });
  }
  assert.equal(PAYMENT_STATUS_LABELS[FINANCE_STATUS.NEEDS_REVIEW], 'Payment status unavailable');
});

test('missing or malformed reason evidence asks for a useful check without guessing a cause', () => {
  const absentEvidence = paymentStatusPresentation({ finance_status: FINANCE_STATUS.NEEDS_REVIEW });
  assert.equal(absentEvidence.reason, null);
  assert.equal(absentEvidence.guidance, 'Open the account to check the fees and enrollment confirmation.');

  const missingCount = paymentStatusPresentation({
    finance_status: FINANCE_STATUS.NEEDS_REVIEW,
    assessment_id: 41,
    matching_assessment_confirmation_id: 52,
    assessed_charge_count: null
  });
  assert.equal(missingCount.reason, null);

  const malformedCount = paymentStatusPresentation({
    finance_status: FINANCE_STATUS.NEEDS_REVIEW,
    assessment_id: 41,
    matching_assessment_confirmation_id: 52,
    assessed_charge_count: ''
  });
  assert.equal(malformedCount.reason, null);

  const blankCount = paymentStatusPresentation({
    finance_status: FINANCE_STATUS.NEEDS_REVIEW,
    assessment_id: 41,
    matching_assessment_confirmation_id: 52,
    assessed_charge_count: '  '
  });
  assert.equal(blankCount.reason, null);

  const booleanCount = paymentStatusPresentation({
    finance_status: FINANCE_STATUS.NEEDS_REVIEW,
    assessment_id: 41,
    matching_assessment_confirmation_id: 52,
    assessed_charge_count: false
  });
  assert.equal(booleanCount.reason, null);

  const malformedAssessment = paymentStatusPresentation({
    finance_status: FINANCE_STATUS.NEEDS_REVIEW,
    assessment_id: 'not-an-id',
    matching_assessment_confirmation_id: null,
    assessed_charge_count: 0
  });
  assert.equal(malformedAssessment.reason, null);

  const accountFallback = paymentStatusPresentation({ finance_status: FINANCE_STATUS.NEEDS_REVIEW }, 'whole', 'account');
  assert.equal(accountFallback.guidance, 'Check the fee assessment and enrollment confirmation.');
});
