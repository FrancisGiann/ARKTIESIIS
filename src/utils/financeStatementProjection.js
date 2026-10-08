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

function createStatementProjection(ledger) {
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
      applied_amount: moneyText(appliedCents),
      due_amount: moneyText(dueCents)
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
  return {
    ...ledger,
    summary: {
      ...(ledger.summary || {}),
      annualFeeBalance: moneyText(annualFeeBalance),
      showPreviousAccountBalance: moneyCents(ledger.summary?.unattributedLegacyBalance) !== 0n,
      showPreviouslyConfirmedBalance: moneyCents(ledger.summary?.openingLiabilityDue) !== 0n
    },
    charges,
    chargeGroups: groupCharges(charges),
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
  return [...groups.values()].map(({ dueCents, ...group }) => ({ ...group, due: moneyText(dueCents) }));
}

module.exports = { createStatementProjection, createStudentFinanceProjection, safeStatementEvents, moneyCents, moneyText };
