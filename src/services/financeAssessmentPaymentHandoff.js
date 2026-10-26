'use strict';

function buildAssessmentPaymentHandoff(ledger, readiness, annualIdInput) {
  if (typeof annualIdInput !== 'string' || !/^[1-9]\d{0,9}$/.test(annualIdInput)) return null;
  const annualId = Number(annualIdInput);
  const term = ledger.terms.find((item) => Number(item.annual_enrollment_id) === annualId);
  if (!term || term.intake_status !== 'pending' || !term.assessment_id) return null;
  const state = readiness.get(annualId);
  if (!state) return null;
  const entryTermNumber = Number(state.entryTermNumber || term.entry_term_number || 1);
  const downPaymentCharges = ledger.charges.filter((charge) => Number(charge.annual_enrollment_id) === annualId
    && Number(charge.annual_term_number) === entryTermNumber
    && String(charge.fee_category).toLowerCase() === 'tuition'
    && /^(dp|down payment)$/i.test(String(charge.installment || '').trim()));
  const remaining = downPaymentCharges.reduce((sum, charge) => sum + Math.max(0, Math.round(Number(charge.remaining_due || 0) * 100)), 0);
  return { annualId, schoolYear: term.school_year, entryTermNumber, status: state.status,
    reviewed: state.reviewed, downPaymentDue: downPaymentCharges.length ? (remaining / 100).toFixed(2) : null,
    targetChargeId: downPaymentCharges.length === 1 && remaining > 0 ? Number(downPaymentCharges[0].charge_id) : null };
}

module.exports = { buildAssessmentPaymentHandoff };
