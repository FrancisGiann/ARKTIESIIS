'use strict';

const { FINANCE_STATUS } = require('../services/financeTermClassification');

const PAYMENT_STATUS_LABELS = Object.freeze({
  [FINANCE_STATUS.UNPAID]: 'Unpaid',
  [FINANCE_STATUS.PARTIAL]: 'Partially paid',
  [FINANCE_STATUS.FULL]: 'Fully paid',
  [FINANCE_STATUS.NO_PAYMENT_REQUIRED]: 'No payment required',
  [FINANCE_STATUS.NEEDS_REVIEW]: 'Payment status unavailable'
});

function readCount(source, field) {
  if (!Object.hasOwn(source, field)) return null;
  if (source[field] === null || source[field] === undefined || typeof source[field] === 'boolean'
      || (typeof source[field] === 'string' && source[field].trim() === '')) return null;
  const value = Number(source[field]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function hasRecordId(source, field) {
  if (!Object.hasOwn(source, field)) return null;
  const value = source[field];
  if (value === null) return false;
  if (value === undefined || value === '') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? true : null;
}

function readFlag(source, field) {
  if (!Object.hasOwn(source, field)) return null;
  const value = source[field];
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

function paymentStatusPresentation(classification = {}, installment = 'whole', surface = 'roster') {
  const mode = String(installment || 'whole').trim().toLowerCase();
  const status = String(classification.finance_status ?? classification.status ?? '');
  const label = PAYMENT_STATUS_LABELS[status] || 'Payment status unavailable';
  const fallback = () => ({
    label: 'Payment status unavailable',
    reason: null,
    guidance: surface === 'account'
      ? 'Check the fee assessment and enrollment confirmation.'
      : 'Open the account to check the fees and enrollment confirmation.'
  });

  if (classification.term_scope_status === 'not_applicable') {
    return { label: 'Not applicable before entry term', reason: null, guidance: null };
  }

  if (status !== FINANCE_STATUS.NEEDS_REVIEW) {
    return Object.hasOwn(PAYMENT_STATUS_LABELS, status)
      ? { label, reason: null, guidance: null }
      : fallback();
  }

  const hasAssessment = hasRecordId(classification, 'assessment_id');
  if (hasAssessment === false) {
    return {
      label,
      reason: 'Fees not assessed',
      guidance: 'Record an annual assessment to add this school year’s fees.'
    };
  }
  if (hasAssessment === null) return fallback();

  const confirmationField = Object.hasOwn(classification, 'matching_assessment_confirmation_id')
    ? 'matching_assessment_confirmation_id' : 'registrar_confirmation_id';
  const hasConfirmation = hasRecordId(classification, confirmationField);
  if (hasConfirmation === false) {
    return {
      label,
      reason: 'Awaiting registrar confirmation',
      guidance: 'The registrar must confirm enrollment using the current fee assessment.'
    };
  }
  if (hasConfirmation === null) return fallback();

  const assessedChargeCount = readCount(classification, 'assessed_charge_count');
  if (assessedChargeCount === 0) {
    return { label, reason: 'Fees not recorded', guidance: 'Check the fee entries for this term.' };
  }
  if (assessedChargeCount === null) return fallback();

  if (mode !== 'whole') {
    const installmentTrackingAvailable = readFlag(classification, 'installment_tracking_available');
    const tuitionLineCount = readCount(classification, 'tuition_line_count');
    const canonicalTuitionCount = readCount(classification, 'canonical_tuition_count');
    const installmentCounts = ['dp_count', 'prelim_count', 'midterm_count', 'finals_count']
      .map((field) => readCount(classification, field));
    const hasKnownIncompleteBreakdown = installmentTrackingAvailable === false
      || (tuitionLineCount !== null && canonicalTuitionCount !== null
        && installmentCounts.every((count) => count !== null)
        && (tuitionLineCount !== 4 || canonicalTuitionCount !== 4 || installmentCounts.some((count) => count !== 1)));

    if (hasKnownIncompleteBreakdown) {
      const wholeTrackingAvailable = readFlag(classification, 'whole_tracking_available');
      return {
        label,
        reason: 'Payment breakdown unavailable',
        guidance: wholeTrackingAvailable === true
          ? 'The tuition payment periods are incomplete. Select Entire term to see the available amount.'
          : 'Check the tuition amounts in the fee assessment.'
      };
    }
  }

  return fallback();
}

module.exports = { PAYMENT_STATUS_LABELS, paymentStatusPresentation };
