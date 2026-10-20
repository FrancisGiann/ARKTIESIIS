const { safeStudentPaymentPurposeHistory } = require('./paymentPurpose');

function moneyCents(value) {
  const match = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/.exec(String(value ?? '0'));
  if (!match) return 0n;
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  return match[1] ? -cents : cents;
}

function moneyText(cents) {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function safeStatementEvents(events = []) {
  const safeLabels = {
    charge: 'Assessed fee',
    adjustment: 'Fee adjustment recorded',
    payment: 'Payment recorded',
    'payment reversal': 'Payment correction recorded',
    'allocation release': 'Allocation correction recorded',
    allocation: 'Payment applied to a balance',
    'legacy opening liability': 'Previously confirmed account balance recorded',
    'legacy reconciliation': 'Previously recorded payment applied to an assessed fee',
    'signed clearance': 'Term-end clearance recorded',
    'unattributed legacy payment': 'Previous account payment remains in account history',
    'unattributed legacy charge': 'Previous account fee remains in account history',
    'unattributed legacy adjustment': 'Previous account adjustment remains in account history',
    'payment receipt_marked_issued': 'Receipt status updated',
    'payment receipt_reference_updated': 'Receipt reference updated'
  };
  const displayLabels = {
    charge: 'Fee assessed',
    adjustment: 'Fee adjustment',
    'payment reversal': 'Payment corrected',
    'allocation release': 'Payment allocation corrected',
    allocation: 'Payment applied',
    'legacy opening liability': 'Prior balance recorded',
    'legacy reconciliation': 'Prior payment applied',
    'signed clearance': 'Clearance signed',
    'unattributed legacy payment': 'Previous account payment',
    'unattributed legacy charge': 'Previous account charge',
    'unattributed legacy adjustment': 'Previous account adjustment',
    payment: 'Payment received',
    'payment receipt_marked_issued': 'Receipt status updated',
    'payment receipt_reference_updated': 'Receipt reference updated',
    signed_clearance: 'Clearance signed',
    signed_clearance_revoked: 'Clearance revoked'
  };
  return events.map((event) => {
    const type = String(event.event_type || 'account update');
    const isPayment = type === 'payment';
    return {
      ...event,
      display_label: displayLabels[type] || 'Account update',
      details: type === 'charge' ? String(event.details || 'Assessed fee') : (safeLabels[type] || 'Finance account update'),
      reference_no: isPayment ? (event.reference_no || null) : null
    };
  });
}

function createStudentFinanceProjection(ledger) {
  const projected = createStatementProjection(ledger);
  const priorAccountEventDetails = {
    'legacy opening liability': 'Previously confirmed account balance recorded',
    'legacy reconciliation': 'Previously recorded payment applied to an assessed fee',
    'unattributed legacy payment': 'Previous account payment remains in account history',
    'unattributed legacy charge': 'Previous account fee remains in account history',
    'unattributed legacy adjustment': 'Previous account adjustment remains in account history'
  };
  return {
    ...projected,
    paymentPurposeHistory: safeStudentPaymentPurposeHistory(ledger.paymentPurposeHistory),
    payments: [],
    allocationHistory: [],
    legacyReconciliationHistory: [],
    events: (ledger.events || []).map((event, index) => ({ event, safeEvent: projected.events[index] || {} }))
      .filter(({ event }) => !String(event.event_type || '').endsWith('private_remark_added'))
      .map(({ event, safeEvent }) => {
      const type = String(event.event_type || 'account update');
      return {
        ...event,
        display_label: safeEvent.display_label || 'Account update',
        details: priorAccountEventDetails[type]
          || (type === 'charge' || type === 'payment' ? event.details : safeEvent.details)
          || 'Recorded by finance',
        reference_no: safeEvent.reference_no
      };
      })
  };
}

function createStatementProjection(ledger, { includeStaffFeeApplications = false } = {}) {
  const statementLedger = { ...ledger };
  delete statementLedger.staffFeeApplicationsByCharge;
  const terms = new Map();
  const charges = (ledger.charges || []).map((charge) => {
    const assessed = moneyCents(charge.amount);
    const coverage = moneyCents(charge.waived_amount);
    const applied = moneyCents(charge.allocated);
    const dueCents = moneyCents(charge.remaining_due ?? charge.remaining_amount);
    const requiredCents = dueCents + applied;
    const otherAdjustments = requiredCents - assessed + coverage;
    const appliedCents = applied;
    const projected = {
      ...charge,
      other_adjustments: moneyText(otherAdjustments),
      assessed_amount: moneyText(assessed),
      coverage_amount: moneyText(coverage),
      required_amount: moneyText(requiredCents),
      fee_basis_negative: requiredCents < 0n,
      applied_amount: moneyText(appliedCents),
      due_amount: moneyText(dueCents),
      payment_status: feePaymentStatus(requiredCents, appliedCents, dueCents),
      balance_kind: dueCents > 0n ? 'due' : dueCents < 0n ? 'credit' : 'settled'
    };
    const key = `${charge.school_year}|${charge.annual_term_number}|${charge.installment || 'Whole term'}`;
    const aggregate = terms.get(key) || {
      school_year: charge.school_year, annual_term_number: charge.annual_term_number,
      term: charge.term, installment: charge.installment || 'Whole term',
      required: 0n, applied: 0n, due: 0n
    };
    aggregate.required += requiredCents;
    aggregate.applied += appliedCents;
    aggregate.due += dueCents;
    terms.set(key, aggregate);
    return projected;
  });
  const annualFeeBalance = charges.reduce((sum, charge) => sum + moneyCents(charge.due_amount), 0n);
  const chargeGroups = groupCharges(charges);
  return {
    ...statementLedger,
    summary: {
      ...(ledger.summary || {}),
      annualFeeBalance: moneyText(annualFeeBalance),
      showPreviousAccountBalance: moneyCents(ledger.summary?.unattributedLegacyBalance) !== 0n,
      showPreviouslyConfirmedBalance: moneyCents(ledger.summary?.openingLiabilityDue) !== 0n
    },
    charges,
    chargeGroups,
    feeBreakdownYears: groupSchoolYears(chargeGroups),
    ...(includeStaffFeeApplications ? { staffFeeApplicationsByCharge: staffFeeApplicationsByCharge(ledger) } : {}),
    termBalances: [...terms.values()].map((row) => ({
      ...row, required: moneyText(row.required), applied: moneyText(row.applied), due: moneyText(row.due)
    })),
    events: safeStatementEvents(ledger.events || [])
  };
}

function groupCharges(charges) {
  const groups = new Map();
  for (const charge of charges) {
    const key = JSON.stringify([charge.school_year || '', charge.annual_term_number || '', charge.term || '']);
    let group = groups.get(key);
    if (!group) {
      group = {
        school_year: charge.school_year || 'School year not listed',
        annual_term_number: charge.annual_term_number,
        term: charge.term || 'Term not listed',
        charges: [], dueCents: 0n
      };
      groups.set(key, group);
    }
    group.charges.push(charge);
    group.dueCents += moneyCents(charge.due_amount);
  }
  return [...groups.values()].map((group) => {
    group.charges.sort(compareCharges);
    const tuitionCharges = group.charges.filter((charge) => String(charge.fee_category || '').toLowerCase() === 'tuition');
    const hasTuition = tuitionCharges.length > 0;
    const canonicalTuitionCounts = new Map();
    for (const charge of tuitionCharges) {
      const installment = canonicalTuitionInstallment(charge.installment);
      const isNamedTuition = String(charge.line_name || '').trim().toLowerCase() === 'tuition';
      const isOptional = charge.is_optional === true || charge.is_optional === 1 || charge.is_optional === '1';
      if (!installment || !isNamedTuition || isOptional) continue;
      canonicalTuitionCounts.set(installment, (canonicalTuitionCounts.get(installment) || 0) + 1);
    }
    const hasOptionalTuition = tuitionCharges.some((charge) => charge.is_optional === true || charge.is_optional === 1 || charge.is_optional === '1');
    const tuitionBreakdownRecorded = !hasTuition
      || (!hasOptionalTuition && tuitionCharges.length === 4 && ['dp', 'prelim', 'midterm', 'finals']
        .every((installment) => canonicalTuitionCounts.get(installment) === 1));
    const { dueCents, ...term } = group;
    const tuitionSubtotal = sumChargeAmounts(tuitionCharges);
    const miscellaneousSubtotal = sumChargeAmounts(group.charges.filter((charge) => String(charge.fee_category || '').toLowerCase() === 'miscellaneous'));
    const otherFeesSubtotal = sumChargeAmounts(group.charges.filter((charge) => !['tuition', 'miscellaneous'].includes(String(charge.fee_category || '').toLowerCase())));
    return {
      ...term,
      due: moneyText(dueCents),
      tuitionBreakdownRecorded,
      tuitionSubtotal,
      miscellaneousSubtotal,
      otherFeesSubtotal,
      termSubtotal: sumChargeAmounts(group.charges)
    };
  }).sort(compareTermGroups);
}

function feePaymentStatus(requiredCents, appliedCents, dueCents) {
  if (requiredCents < 0n) return 'Review fee basis';
  if (requiredCents === 0n) return 'No payment required';
  if (dueCents <= 0n) return 'Fully paid';
  return appliedCents > 0n ? 'Partially paid' : 'Unpaid';
}

function canonicalTuitionInstallment(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['dp', 'prelim', 'midterm', 'finals'].includes(normalized) ? normalized : null;
}

function compareCharges(left, right) {
  const categoryRank = (charge) => {
    const category = String(charge.fee_category || '').toLowerCase();
    return category === 'tuition' ? 0 : category === 'miscellaneous' ? 1 : 2;
  };
  const categoryDifference = categoryRank(left) - categoryRank(right);
  if (categoryDifference) return categoryDifference;
  const category = String(left.fee_category || '').toLowerCase();
  if (category === 'tuition') {
    const order = ['dp', 'prelim', 'midterm', 'finals'];
    const installmentDifference = (order.indexOf(canonicalTuitionInstallment(left.installment)) + 1 || 99)
      - (order.indexOf(canonicalTuitionInstallment(right.installment)) + 1 || 99);
    if (installmentDifference) return installmentDifference;
  } else if (category === 'miscellaneous') {
    const order = ['dp', 'prelim', 'midterm', 'finals'];
    const leftInstallment = canonicalTuitionInstallment(left.installment);
    const rightInstallment = canonicalTuitionInstallment(right.installment);
    const leftRank = leftInstallment ? order.indexOf(leftInstallment) : 99;
    const rightRank = rightInstallment ? order.indexOf(rightInstallment) : 99;
    const installmentDifference = leftRank - rightRank;
    if (installmentDifference) return installmentDifference;
    const installmentNameDifference = String(left.installment || '').localeCompare(String(right.installment || ''), undefined, { numeric: true, sensitivity: 'base' });
    if (installmentNameDifference) return installmentNameDifference;
  }
  const nameDifference = String(left.line_name || '').localeCompare(String(right.line_name || ''), undefined, { numeric: true, sensitivity: 'base' });
  if (nameDifference) return nameDifference;
  const categoryNameDifference = String(left.fee_category || '').localeCompare(String(right.fee_category || ''), undefined, { sensitivity: 'base' });
  if (categoryNameDifference) return categoryNameDifference;
  return Number(left.charge_id || 0) - Number(right.charge_id || 0);
}

function compareTermGroups(left, right) {
  const yearDifference = compareSchoolYears(right.school_year, left.school_year);
  if (yearDifference) return yearDifference;
  const leftTerm = Number(left.annual_term_number) || termNumber(left.term);
  const rightTerm = Number(right.annual_term_number) || termNumber(right.term);
  if (leftTerm !== rightTerm) return leftTerm - rightTerm;
  return String(left.term).localeCompare(String(right.term), undefined, { numeric: true, sensitivity: 'base' });
}

function compareSchoolYears(left, right) {
  const startYear = (value) => {
    const match = /^(\d{4})/.exec(String(value || ''));
    return match ? Number(match[1]) : null;
  };
  const leftYear = startYear(left);
  const rightYear = startYear(right);
  if (leftYear != null && rightYear != null && leftYear !== rightYear) return leftYear - rightYear;
  return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function termNumber(value) {
  const match = /(?:term|trimester)\s*([1-3])/i.exec(String(value || ''));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sumChargeAmounts(charges) {
  const total = { assessed: 0n, coverage: 0n, adjustments: 0n, applied: 0n, balance: 0n };
  for (const charge of charges) {
    total.assessed += moneyCents(charge.assessed_amount);
    total.coverage += moneyCents(charge.coverage_amount);
    total.adjustments += moneyCents(charge.other_adjustments);
    total.applied += moneyCents(charge.applied_amount);
    total.balance += moneyCents(charge.due_amount);
  }
  return {
    assessed_amount: moneyText(total.assessed),
    coverage_amount: moneyText(total.coverage),
    other_adjustments: moneyText(total.adjustments),
    applied_amount: moneyText(total.applied),
    due_amount: moneyText(total.balance)
  };
}

function groupSchoolYears(termGroups) {
  const years = new Map();
  for (const term of termGroups) {
    if (!years.has(term.school_year)) years.set(term.school_year, { school_year: term.school_year, terms: [] });
    years.get(term.school_year).terms.push(term);
  }
  return [...years.values()].map((year) => ({
    ...year,
    subtotal: sumChargeAmounts(year.terms.flatMap((term) => term.charges))
  }));
}

function staffFeeApplicationsByCharge(ledger = {}) {
  const applications = new Map();
  const add = (chargeId, row) => {
    if (chargeId == null) return;
    const key = String(chargeId);
    if (!applications.has(key)) applications.set(key, []);
    const original = moneyCents(row.original_amount);
    const current = moneyCents(row.remaining_amount);
    const released = moneyCents(row.released_amount);
    const reversed = row.is_reversed === true || row.is_reversed === 1 || row.is_reversed === '1';
    applications.get(key).push({
      ...row,
      application_kind: row.reconciliation_id == null ? 'payment' : 'earlier payment',
      still_applied_amount: moneyText(reversed ? 0n : current),
      released_display_amount: moneyText(released),
      reversed_display_amount: moneyText(reversed ? original - released : 0n)
    });
  };
  for (const row of ledger.allocationHistory || []) add(row.charge_id, row);
  for (const row of ledger.legacyReconciliationHistory || []) add(row.charge_id, row);
  for (const rows of applications.values()) rows.sort((left, right) => {
    const leftDate = left.payment_date ? new Date(left.payment_date).getTime() : null;
    const rightDate = right.payment_date ? new Date(right.payment_date).getTime() : null;
    if (leftDate != null && rightDate == null) return -1;
    if (leftDate == null && rightDate != null) return 1;
    if (leftDate != null && rightDate != null && leftDate !== rightDate) return leftDate - rightDate;
    return Number(left.allocation_id || left.reconciliation_id || 0) - Number(right.allocation_id || right.reconciliation_id || 0);
  });
  return Object.fromEntries(applications);
}

module.exports = { createStatementProjection, createStudentFinanceProjection, safeStatementEvents, moneyCents, moneyText };
