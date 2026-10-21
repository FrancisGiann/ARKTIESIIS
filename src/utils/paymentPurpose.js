const crypto = require('node:crypto');

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

function restatementEventStatus(row = {}) {
  if (row.reversed_event_id != null) return 'reversed';
  if (row.applied_event_id != null) return 'active';
  return 'incomplete';
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
    const currentReleasedCents = row.released_amount != null
      ? cents(row.released_amount)
      : (originalCents == null || savedNetCents == null ? null : originalCents - savedNetCents);
    const releasedCents = row.recorded_released_amount != null
      ? cents(row.recorded_released_amount) : currentReleasedCents;

    const restatementLabel = normalizeLabel(row.restatement_history_label);
    const basePurpose = normalizeLabel(row.original_purpose_label) || formatAllocationPurpose(row);
    return {
      purpose: `${restatementLabel ? `${restatementLabel} · ` : ''}${legacy ? `Applied later · ` : ''}${basePurpose}`,
      application_label: restatementLabel || (legacy ? 'Applied later' : 'Originally applied'),
      restatement_history_label: restatementLabel || null,
      original_amount: money(originalCents),
      current_amount: money(currentCents),
      released_amount: money(releasedCents),
      current_released_amount: money(currentReleasedCents),
      current_fee_balance: money(currentDueCents),
      is_reversed: reversed,
      is_legacy: legacy
    };
  });
}

function annotateRestatementSourceAllocations(rows = [], sourcePurposeByAllocationId = new Map()) {
  return rows.map((row) => {
    const sourcePurpose = sourcePurposeByAllocationId.get(Number(row.allocation_id));
    if (!sourcePurpose || String(row.source_restatement_operation_id || '') !== sourcePurpose.operationId) return row;
    const historyLabel = sourcePurpose.status === 'active'
      ? 'Original assessment allocation released into synthetic installment placements.'
      : sourcePurpose.status === 'reversed'
        ? 'Original assessment allocation release remains in history; its value was restored as a separate current application.'
        : 'Restatement apply evidence is incomplete; the original allocation remains in its recorded effective state.';
    return {
      ...row,
      // The retained whole-term source row is inactive while the canonical
      // installment rows are effective, so its current due is unavailable.
      ...(sourcePurpose.status === 'active' ? { current_due_amount: null, target_current_due: null } : {}),
      original_purpose_label: sourcePurpose.label,
      restatement_history_label: historyLabel
    };
  });
}

function buildRestatementSourceAllocationPurposeMap(archiveRows = []) {
  const result = new Map();
  for (const row of archiveRows) {
    const operationId = String(row.operation_id || '');
    const beforeImageJson = String(row.before_image_json || '');
    const expectedDigest = String(row.before_image_sha256 || '').toLowerCase();
    const actualDigest = crypto.createHash('sha256').update(beforeImageJson).digest('hex');
    if (!operationId || !/^[a-f0-9]{64}$/.test(expectedDigest) || expectedDigest !== actualDigest) {
      throw new Error('The saved finance restatement before-image digest is invalid.');
    }
    let beforeImage;
    try { beforeImage = JSON.parse(beforeImageJson); } catch {
      throw new Error('The saved finance restatement before-image is invalid.');
    }
    if (!Number.isSafeInteger(Number(row.annual_enrollment_id))
      || Number(beforeImage?.annual?.id) !== Number(row.annual_enrollment_id)
      || !Array.isArray(beforeImage.charges) || !Array.isArray(beforeImage.enrollments)
      || !Array.isArray(beforeImage.allocations)) {
      throw new Error('The saved finance restatement before-image is incomplete.');
    }
    const charges = new Map(beforeImage.charges.map((charge) => [Number(charge.id), charge]));
    const enrollments = new Map(beforeImage.enrollments.map((enrollment) => [Number(enrollment.id), enrollment]));
    for (const allocation of beforeImage.allocations) {
      const charge = charges.get(Number(allocation.charge_id));
      if (!charge || String(charge.fee_category || '').toLowerCase() !== 'tuition') continue;
      const enrollment = enrollments.get(Number(charge.enrollment_id));
      if (!enrollment) throw new Error('The saved finance restatement tuition purpose has no term mapping.');
      const normalizedInstallment = normalizeLabel(charge.installment).toLowerCase();
      const wholeTerm = !['dp', 'prelim', 'midterm', 'finals'].includes(normalizedInstallment);
      const purpose = formatFeePurpose({
        school_year: beforeImage.annual.school_year,
        grade_level: beforeImage.annual.grade_level,
        annual_term_number: enrollment.annual_term_number,
        fee_category: charge.fee_category,
        line_name: charge.line_name,
        installment: wholeTerm ? null : charge.installment
      });
      const label = wholeTerm
        ? `Original whole-term tuition · ${purpose}`
        : `Original tuition purpose · ${purpose}`;
      const allocationId = Number(allocation.id);
      if (!Number.isSafeInteger(allocationId) || allocationId < 1 || result.has(allocationId)) {
        throw new Error('The saved finance restatement source allocation mapping is invalid.');
      }
      result.set(allocationId, {
        operationId,
        status: restatementEventStatus(row),
        label
      });
    }
  }
  return result;
}

function buildRestatementSyntheticPlacementPurposeMap(archiveRows = []) {
  const result = new Map();
  for (const row of archiveRows) {
    const operationId = String(row.operation_id || '');
    const appliedImageJson = String(row.applied_image_json || '');
    const expectedDigest = String(row.applied_image_sha256 || '').toLowerCase();
    const actualDigest = crypto.createHash('sha256').update(appliedImageJson).digest('hex');
    if (!operationId || !/^[a-f0-9]{64}$/.test(expectedDigest) || expectedDigest !== actualDigest) {
      throw new Error('The saved finance restatement applied-image digest is invalid.');
    }
    let appliedImage;
    try { appliedImage = JSON.parse(appliedImageJson); } catch {
      throw new Error('The saved finance restatement applied image is invalid.');
    }
    if (!Number.isSafeInteger(Number(row.annual_enrollment_id))
      || !Array.isArray(appliedImage.placementAllocations)) {
      throw new Error('The saved finance restatement placement mapping is incomplete.');
    }
    for (const placement of appliedImage.placementAllocations) {
      const allocationId = Number(placement.allocationId);
      const termNumber = Number(placement.term);
      const installment = normalizeLabel(placement.installment);
      if (!Number.isSafeInteger(allocationId) || allocationId < 1 || result.has(allocationId)
        || !Number.isInteger(termNumber) || termNumber < 1 || termNumber > 3
        || !['DP', 'Prelim', 'Midterm', 'Finals'].includes(installment)) {
        throw new Error('The saved finance restatement placement purpose is invalid.');
      }
      const purpose = formatFeePurpose({
        school_year: row.school_year,
        grade_level: row.grade_level,
        annual_term_number: termNumber,
        fee_category: 'tuition',
        line_name: 'Tuition',
        installment
      });
      result.set(allocationId, {
        operationId,
        status: restatementEventStatus(row),
        label: `Synthetic tuition placement · ${purpose}`,
        historyLabel: row.reversed_event_id == null
          ? row.applied_event_id == null
            ? 'Inactive synthetic tuition placement; no applied restatement event is recorded.'
            : 'Synthetic tuition installment placement.'
          : 'Historical synthetic tuition placement; restatement reversed.'
      });
    }
  }
  return result;
}

function annotateRestatementSyntheticPlacementAllocations(rows = [], placementPurposeByAllocationId = new Map()) {
  return rows.map((row) => {
    const placementPurpose = placementPurposeByAllocationId.get(Number(row.allocation_id));
    if (!placementPurpose || String(row.synthetic_restatement_operation_id || '') !== placementPurpose.operationId
      || String(row.synthetic_restatement_kind || '') !== 'placement') return row;
    return {
      ...row,
      ...(placementPurpose.status !== 'active' ? { current_due_amount: null, target_current_due: null } : {}),
      original_purpose_label: placementPurpose.label,
      restatement_history_label: placementPurpose.historyLabel
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
    current_released_amount: allocation.current_released_amount ?? allocation.released_amount ?? null,
    current_fee_balance: allocation.current_fee_balance ?? null,
    restatement_history_label: normalizeLabel(allocation.restatement_history_label) || null,
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

module.exports = {
  formatFeePurpose, formatAllocationPurpose, annotateRestatementSourceAllocations,
  buildRestatementSourceAllocationPurposeMap, annotateRestatementSyntheticPlacementAllocations,
  buildRestatementSyntheticPlacementPurposeMap, buildPaymentPurposeHistory, safeStudentPaymentPurposeHistory
};
