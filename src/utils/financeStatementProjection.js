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
    'payment reversal': 'Payment correction recorded',
    'allocation release': 'Allocation correction recorded',
    allocation: 'Payment applied to a balance',
    'legacy opening liability': 'Verified prior balance transferred to annual account',
    'legacy reconciliation': 'Prior payment applied to an assessed balance',
    'signed clearance': 'Term-end clearance recorded',
    'unattributed legacy payment': 'Legacy payment remains in account history',
    'unattributed legacy charge': 'Legacy charge remains in account history',
    'unattributed legacy adjustment': 'Legacy adjustment remains in account history',
    'payment receipt_marked_issued': 'Receipt status updated',
    'payment receipt_reference_updated': 'Receipt reference updated'
  };
  return events.map((event) => {
    const type = String(event.event_type || 'account update');
    const isPayment = type === 'payment';
    return {
      ...event,
      details: type === 'charge' ? String(event.details || 'Assessed fee') : (safeLabels[type] || 'Finance account update'),
      reference_no: isPayment ? (event.reference_no || null) : null
    };
  });
}

function createStatementProjection(ledger) {
  const terms = new Map();
  const charges = (ledger.charges || []).map((charge) => {
    const required = moneyCents(charge.remaining_due ?? charge.remaining_amount) + moneyCents(charge.allocated);
    const requiredCents = required > 0n ? required : 0n;
    const appliedCents = moneyCents(charge.allocated);
    const dueCents = moneyCents(charge.remaining_due ?? charge.remaining_amount);
    const projected = {
      ...charge,
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
  return {
    ...ledger,
    charges,
    termBalances: [...terms.values()].map((row) => ({
      ...row, required: moneyText(row.required), applied: moneyText(row.applied), due: moneyText(row.due)
    })),
    events: safeStatementEvents(ledger.events || [])
  };
}

module.exports = { createStatementProjection, safeStatementEvents, moneyCents, moneyText };
