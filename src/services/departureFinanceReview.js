'use strict';

const TUITION_INSTALLMENTS = Object.freeze(['dp', 'prelim', 'midterm', 'finals']);
const TUITION_INSTALLMENT_RANK = Object.freeze(Object.fromEntries(
  TUITION_INSTALLMENTS.map((installment, index) => [installment, index + 1])
));
const LAST_PAYABLE_OPTIONS = Object.freeze(['none', ...TUITION_INSTALLMENTS]);

function normalizeLastPayableInstallment(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  return LAST_PAYABLE_OPTIONS.includes(normalized) ? normalized : '';
}

function classifyDepartureCharge(charge) {
  if (String(charge?.fee_category || '').trim().toLowerCase() !== 'tuition') return 'individual_fee';
  const installment = String(charge?.installment || '').trim().toLowerCase();
  return Object.hasOwn(TUITION_INSTALLMENT_RANK, installment) ? 'canonical_tuition' : 'manual_tuition';
}

function proposedDepartureReduction({ charge, termNumber, departureTermNumber, lastPayableInstallment, payableBasisCents }) {
  if (classifyDepartureCharge(charge) !== 'canonical_tuition' || !LAST_PAYABLE_OPTIONS.includes(lastPayableInstallment)) return 0n;
  const payableCents = BigInt(payableBasisCents);
  if (payableCents <= 0n) return 0n;
  const chargeTerm = Number(termNumber);
  const departureTerm = Number(departureTermNumber);
  const installment = String(charge.installment).trim().toLowerCase();
  const cutoffRank = lastPayableInstallment === 'none' ? 0 : TUITION_INSTALLMENT_RANK[lastPayableInstallment];
  const afterCutoff = chargeTerm > departureTerm
    || (chargeTerm === departureTerm
      && TUITION_INSTALLMENT_RANK[installment] > cutoffRank);
  return afterCutoff ? payableCents : 0n;
}

function suggestedDepartureDecision({ reviewCategory, proposedReductionCents }) {
  if (reviewCategory !== 'canonical_tuition') return '';
  return BigInt(proposedReductionCents) > 0n ? 'reduce' : 'retain';
}

module.exports = {
  TUITION_INSTALLMENTS,
  LAST_PAYABLE_OPTIONS,
  normalizeLastPayableInstallment,
  classifyDepartureCharge,
  proposedDepartureReduction,
  suggestedDepartureDecision
};
