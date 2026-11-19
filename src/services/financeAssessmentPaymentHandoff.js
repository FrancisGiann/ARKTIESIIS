'use strict';

function buildAssessmentPaymentHandoff(ledger, readiness, annualIdInput) {
  if (typeof annualIdInput !== 'string' || !/^[1-9]\d{0,9}$/.test(annualIdInput)) return null;
  const annualId = Number(annualIdInput);
  const term = ledger.terms.find((item) => Number(item.annual_enrollment_id) === annualId);
  if (!term) return null;
  const activated = term.entry_activation_id != null
    && Number(term.enrollment_id) === Number(term.entry_activation_enrollment_id);
  if (!activated && (term.intake_status !== 'pending' || !term.assessment_id)) return null;
  const state = readiness.get(annualId) || (activated ? {
    status: 'ready_for_registrar', reviewed: true, entryTermNumber: term.entry_term_number
  } : null);
  if (!state) return null;
  const entryTermNumber = Number(state.entryTermNumber || term.entry_term_number || 1);
  const downPaymentCharges = ledger.charges.filter((charge) => Number(charge.annual_enrollment_id) === annualId
    && Number(charge.annual_term_number) === entryTermNumber
    && String(charge.fee_category).toLowerCase() === 'tuition'
    && /^(dp|down payment)$/i.test(String(charge.installment || '').trim()));
  const remaining = downPaymentCharges.reduce((sum, charge) => sum + Math.max(0, Math.round(Number(charge.remaining_due || 0) * 100)), 0);
  const handoffStatus = term.registrar_handoff_status || null;
  let enrollmentStatus = 'awaiting_registrar_handoff';
  if (activated) enrollmentStatus = 'activated';
  else if (handoffStatus === 'academic_review_required') enrollmentStatus = 'awaiting_registrar_correction';
  else if (handoffStatus === 'registrar_review_required') enrollmentStatus = 'registrar_review_required';
  else if (handoffStatus === 'retry_required') enrollmentStatus = 'retry_required';
  else if (handoffStatus === 'awaiting_finance') enrollmentStatus = state.status === 'ready_for_registrar'
    ? 'retry_required' : 'awaiting_finance';
  return { annualId, schoolYear: term.school_year, entryTermNumber, status: state.status,
    reviewed: state.reviewed, handoffId: term.registrar_handoff_id == null ? null : Number(term.registrar_handoff_id),
    handoffStatus, enrollmentStatus,
    downPaymentDue: downPaymentCharges.length ? (remaining / 100).toFixed(2) : null,
    targetChargeId: downPaymentCharges.length === 1 && remaining > 0 ? Number(downPaymentCharges[0].charge_id) : null };
}

module.exports = { buildAssessmentPaymentHandoff };
