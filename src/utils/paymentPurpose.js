function normalizeLabel(value) {
  return String(value ?? '').trim();
}

function titleCase(value) {
  return normalizeLabel(value).replaceAll('_', ' ').replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function formatFeePurpose(row = {}) {
  const schoolYear = normalizeLabel(row.school_year ?? row.schoolYear);
  const gradeLevel = normalizeLabel(row.grade_level ?? row.gradeLevel);
  const termNumber = row.annual_term_number ?? row.termNumber;
  const feeName = normalizeLabel(row.line_name ?? row.lineName);
  const feeCategory = normalizeLabel(row.fee_category ?? row.feeCategory);
  const installment = normalizeLabel(row.installment);
  const parts = [];

  if (schoolYear) parts.push(schoolYear);
  if (gradeLevel) parts.push(gradeLevel);
  if (termNumber != null && String(termNumber).trim()) parts.push(`Term ${termNumber}`);
  if (feeName) parts.push(feeName);
  if (feeCategory && feeCategory.toLowerCase() !== feeName.toLowerCase()) parts.push(`Category: ${titleCase(feeCategory)}`);
  if (installment && !['whole term', 'whole'].includes(installment.toLowerCase())) parts.push(installment);

  return parts.length ? parts.join(' · ') : 'Fee details unavailable';
}

function formatAllocationPurpose(row = {}) {
  if (row.charge_id != null || row.chargeId != null || row.line_name || row.lineName) return formatFeePurpose(row);
  const sourceLabel = normalizeLabel(row.source_label ?? row.sourceLabel);
  if (row.legacy_opening_charge_id != null || row.openingLiabilityId != null || sourceLabel) {
    return sourceLabel ? `Confirmed previous balance · ${sourceLabel}` : 'Confirmed previous balance · source label unavailable';
  }
  return 'Balance details unavailable';
}

function isTrue(value) {
  return value === true || value === 1 || value === '1';
}

function cents(value) {
  if (value == null || String(value).trim() === '') return null;
  const match = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/.exec(String(value ?? '0.00'));
  if (!match) return null;
  const result = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  return match[1] ? -result : result;
}

function money(centsValue) {
  if (centsValue == null) return null;
  const sign = centsValue < 0n ? '-' : '';
  const absolute = centsValue < 0n ? -centsValue : centsValue;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function projectAllocations(rows = [], { reversed = false, legacy = false } = {}) {
  return rows.map((row) => {
    const originalCents = cents(row.original_amount);
    const savedNetCents = cents(row.remaining_amount ?? row.current_net_amount);
    const currentCents = reversed ? 0n : savedNetCents;
    const currentDueCents = cents(row.current_due_amount ?? row.target_current_due);
    const releasedCents = row.released_amount != null
      ? cents(row.released_amount)
      : (originalCents == null || savedNetCents == null ? null : originalCents - savedNetCents);

    return {
      purpose: legacy ? `Applied later · ${formatAllocationPurpose(row)}` : formatAllocationPurpose(row),
      application_label: legacy ? 'Applied later' : 'Originally applied',
      original_amount: money(originalCents),
      current_amount: money(currentCents),
      released_amount: money(releasedCents),
      current_fee_balance: money(currentDueCents),
      is_reversed: reversed,
      is_legacy: legacy
    };
  });
}

function buildPaymentPurposeHistory({ payments = [], allocations = [], legacyReconciliations = [], events = [] } = {}) {
  const allocationRowsByPayment = new Map();
  for (const allocation of allocations) {
    const key = String(allocation.payment_id);
    if (!allocationRowsByPayment.has(key)) allocationRowsByPayment.set(key, []);
    allocationRowsByPayment.get(key).push(allocation);
  }

  const paymentHistory = payments.map((payment) => {
    const paymentId = String(payment.payment_id);
    const reversed = isTrue(payment.is_reversed);
    const rows = allocationRowsByPayment.get(paymentId) || [];
    return {
      payment_id: payment.payment_id,
      payment_date: payment.payment_date,
      amount: payment.amount == null ? null : String(payment.amount),
      reference_no: payment.reference_no || null,
      receipt_issued: isTrue(payment.receipt_issued),
      is_reversed: reversed,
      current_available_credit: payment.current_available_credit == null && payment.available_amount == null
        ? null : String(payment.current_available_credit ?? payment.available_amount),
      allocations: projectAllocations(rows, { reversed })
    };
  });

  const legacyRowsByPayment = new Map();
  for (const reconciliation of legacyReconciliations) {
    const key = String(reconciliation.transaction_id);
    if (!legacyRowsByPayment.has(key)) legacyRowsByPayment.set(key, []);
    legacyRowsByPayment.get(key).push(reconciliation);
  }
  const earlierPaymentHistory = events
    .filter((event) => event.event_type === 'unattributed legacy payment')
    .map((event) => ({
      transaction_id: event.source_id,
      payment_date: event.event_date,
      amount: event.amount == null ? null : String(event.amount),
      allocations: projectAllocations(legacyRowsByPayment.get(String(event.source_id)) || [], { legacy: true })
    }));

  return { payments: paymentHistory, earlier_payments: earlierPaymentHistory };
}

function safeStudentPaymentPurposeHistory(history = {}) {
  const safeAllocation = (allocation = {}) => ({
    purpose: normalizeLabel(allocation.purpose) || 'Balance details unavailable',
    application_label: normalizeLabel(allocation.application_label) || 'Originally applied',
    original_amount: allocation.original_amount ?? null,
    current_amount: allocation.current_amount ?? null,
    released_amount: allocation.released_amount ?? null,
    current_fee_balance: allocation.current_fee_balance ?? null,
    is_reversed: isTrue(allocation.is_reversed),
    is_legacy: isTrue(allocation.is_legacy)
  });
  return {
    payments: (history.payments || []).map((payment) => ({
      payment_id: payment.payment_id,
      payment_date: payment.payment_date,
      amount: payment.amount,
      reference_no: payment.reference_no || null,
      receipt_issued: isTrue(payment.receipt_issued),
      is_reversed: isTrue(payment.is_reversed),
      current_available_credit: payment.current_available_credit ?? null,
      allocations: (payment.allocations || []).map(safeAllocation)
    })),
    earlier_payments: (history.earlier_payments || []).map((payment) => ({
      transaction_id: payment.transaction_id,
      payment_date: payment.payment_date,
      amount: payment.amount,
      allocations: (payment.allocations || []).map(safeAllocation)
    }))
  };
}

module.exports = { formatFeePurpose, formatAllocationPurpose, buildPaymentPurposeHistory, safeStudentPaymentPurposeHistory };
