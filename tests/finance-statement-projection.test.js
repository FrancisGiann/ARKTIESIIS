const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { createStatementProjection, createStudentFinanceProjection } = require('../src/utils/financeStatementProjection');
const { formatMoney } = require('../src/utils/formatMoney');

test('statement prints nonzero negative earlier balances for staff and keeps student privacy flags', async () => {
  const ledger = {
    student: { id: 501, first_name: 'Mika', middle_name: '', last_name: 'Santos', suffix: '', student_no: 'SHS-2026-0501' },
    summary: {
      annualBalanceSchoolYear: '2026-2027', annualBalance: '-2.50', allYearsAnnualBalance: '-2.50',
      unattributedLegacyBalance: '-2.50', openingLiabilityDue: '0.00', totalBalance: '-2.50',
      currentTermOutstanding: '-2.50', priorTermYearDebt: '0.00', availableCredit: '0.00',
      showPreviousAccountBalance: false, showPreviouslyConfirmedBalance: false
    },
    termBalances: [], charges: [], events: []
  };
  const template = path.join(__dirname, '..', 'views', 'finance', 'statement.ejs');
  const render = (role) => ejs.renderFile(template, {
    title: 'Statement of Account', ledger, currentUser: { role },
    formatMoney, formatFinanceDateTime: () => 'October 8, 2026'
  });

  const staffStatement = await render('finance');
  const studentStatement = await render('student');
  assert.match(staffStatement, /<dt>Earlier account balance<\/dt><dd>₱-2\.50<\/dd>/);
  assert.doesNotMatch(studentStatement, /<dt>Earlier account balance<\/dt>/);
});

test('print projection groups exact term and installment balances and excludes private correction details', () => {
  const projected = createStatementProjection({
    summary: { unattributedLegacyBalance: '19.00', openingLiabilityDue: '4.00' },
    charges: [
      { school_year: '2026-2027', annual_term_number: 1, term: 'Term 1', installment: 'DP', amount: '100.00', waived_amount: '10.00', adjustments: '-5.00', allocated: '20.00', remaining_due: '65.00' },
      { school_year: '2026-2027', annual_term_number: 1, term: 'Term 1', installment: 'DP', amount: '50.00', waived_amount: '0.00', adjustments: '0.00', allocated: '5.00', remaining_due: '45.00' }
    ],
    events: [
      { event_type: 'payment', details: 'Payment #10 · receipt issued', reference_no: 'CURRENT-OR-EDITED', amount: '30.00' },
      { event_type: 'adjustment', details: 'Private adjustment reason', reference_no: null, amount: '-1.00' },
      { event_type: 'payment reversal', details: 'Private reversal reason', reference_no: null, amount: null },
      { event_type: 'payment private_remark_added', details: 'Secret staff note', reference_no: 'STALE-PRIVATE-REFERENCE', amount: null },
      { event_type: 'unattributed legacy payment', details: 'Legacy transaction retained without new-charge attribution', reference_no: null, amount: '8.00' }
    ]
  });
  assert.deepEqual(projected.termBalances.map(({ required, applied, due }) => ({ required, applied, due })), [
    { required: '135.00', applied: '25.00', due: '110.00' }
  ]);
  assert.equal(projected.charges[0].required_amount, '85.00');
  assert.equal(projected.charges[0].other_adjustments, '-5.00', 'displayed adjustments reconcile to the canonical due and applied amount');
  assert.equal(projected.charges[0].applied_amount, '20.00');
  assert.equal(projected.charges[0].due_amount, '65.00');
  assert.equal(projected.chargeGroups[0].due, '110.00');
  assert.equal(projected.summary.annualFeeBalance, '110.00');
  assert.equal(projected.summary.showPreviousAccountBalance, true);
  assert.equal(projected.summary.unattributedLegacyBalance, '19.00');
  assert.equal(projected.events[0].reference_no, 'CURRENT-OR-EDITED');
  assert.equal(projected.events[0].details, 'Payment recorded');
  assert.equal(projected.events[1].details, 'Fee adjustment recorded');
  assert.equal(projected.events[2].details, 'Payment correction recorded');
  assert.equal(projected.events[3].details, 'Finance account update');
  assert.equal(projected.events[3].reference_no, null);
  assert.equal(projected.events[4].display_label, 'Previous account payment');
  assert.equal(projected.events[4].details, 'Previous account payment remains in account history');
  assert.doesNotMatch(JSON.stringify(projected.events), /Private adjustment reason|Private reversal reason|Secret staff note|STALE-PRIVATE|Legacy transaction/);
});

test('student finance display suppresses zero prior-balance rows and preserves canonical negative due', () => {
  const projected = createStatementProjection({
    summary: { unattributedLegacyBalance: '0.00', openingLiabilityDue: '0.00', totalBalance: '-2.00' },
    charges: [
      { school_year: '2026-2027', annual_term_number: 1, term: 'Term 1', installment: 'DP', amount: '100.00', waived_amount: '10.00', adjustments: '-102.00', allocated: '0.00', remaining_due: '-2.00' }
    ], events: []
  });
  assert.equal(projected.summary.showPreviousAccountBalance, false);
  assert.equal(projected.summary.showPreviouslyConfirmedBalance, false);
  assert.equal(projected.summary.annualFeeBalance, '-2.00');
  assert.equal(projected.charges[0].required_amount, '-2.00');
  assert.equal(projected.charges[0].other_adjustments, '-92.00');
  assert.equal(projected.charges[0].due_amount, '-2.00', 'the projection never replaces the finance service due amount with a re-derived value');
});

test('student wrapper preserves public payment details and fails closed on private or unknown event details', () => {
  const projected = createStudentFinanceProjection({
    summary: { unattributedLegacyBalance: '0.00', openingLiabilityDue: '0.00', availableCredit: '25.00' },
    charges: [],
    events: [
      { event_type: 'payment', details: 'Payment #14 · receipt issued', reference_no: 'CURRENT-14', amount: '25.00' },
      { event_type: 'adjustment', details: 'Private adjustment reason', reference_no: 'PRIVATE-REF', amount: '-1.00' },
      { event_type: 'payment private_remark_added', details: 'Secret staff note', reference_no: 'PRIVATE-NOTE', amount: null },
      { event_type: 'future_private_event', details: 'Unrecognized sensitive detail', reference_no: 'SENSITIVE-REF', amount: null }
    ]
  });

  assert.equal(projected.events.length, 3, 'private note rows are omitted even if they enter the wrapper');
  assert.equal(projected.events[0].details, 'Payment #14 · receipt issued');
  assert.equal(projected.events[0].reference_no, 'CURRENT-14');
  assert.equal(projected.events[1].details, 'Fee adjustment recorded');
  assert.equal(projected.events[1].reference_no, null);
  assert.equal(projected.events[2].details, 'Finance account update');
  assert.equal(projected.events[2].reference_no, null);
  assert.equal(projected.summary.availableCredit, '25.00', 'unapplied credit remains separately visible');
  assert.doesNotMatch(JSON.stringify(projected.events), /Private adjustment reason|Secret staff note|Unrecognized sensitive detail|PRIVATE-/);
});

test('student and Finance projections expose the same canonical balances and fee breakdown for a shared ledger', () => {
  const ledger = {
    summary: {
      annualBalanceSchoolYear: '2026-2027', annualBalance: '40.00', allYearsAnnualBalance: '60.00',
      totalBalance: '75.00', unattributedLegacyBalance: '10.00', openingLiabilityDue: '5.00',
      currentTermOutstanding: '35.00', priorTermYearDebt: '20.00', availableCredit: '12.00'
    },
    charges: [
      { school_year: '2025-2026', annual_term_number: 1, term: 'Term 1', line_name: 'Tuition', installment: 'DP', amount: '40.00', waived_amount: '5.00', adjustments: '0.00', allocated: '20.00', remaining_due: '20.00' },
      { school_year: '2025-2026', annual_term_number: 1, term: 'Term 1', line_name: 'Materials', installment: 'Whole term', amount: '20.00', waived_amount: '0.00', adjustments: '0.00', allocated: '20.00', remaining_due: '0.00' },
      { school_year: '2026-2027', annual_term_number: 1, term: 'Term 1', line_name: 'Tuition', installment: 'Prelim', amount: '50.00', waived_amount: '10.00', adjustments: '-5.00', allocated: '10.00', remaining_due: '35.00' },
      { school_year: '2026-2027', annual_term_number: 2, term: 'Term 2', line_name: 'Activity', installment: 'Whole term', amount: '10.00', waived_amount: '0.00', adjustments: '0.00', allocated: '15.00', remaining_due: '-5.00' },
      { school_year: '2026-2027', annual_term_number: 3, term: 'Term 3', line_name: 'Library', installment: 'Whole term', amount: '10.00', waived_amount: '0.00', adjustments: '0.00', allocated: '0.00', remaining_due: '10.00' }
    ],
    events: [{ event_type: 'adjustment', details: 'Staff-only adjustment reason', reference_no: 'PRIVATE-REF', amount: '5.00' }]
  };

  const financeProjection = createStatementProjection(ledger);
  const studentProjection = createStudentFinanceProjection(ledger);
  assert.deepEqual(studentProjection.summary, financeProjection.summary);
  assert.deepEqual(studentProjection.charges, financeProjection.charges);
  assert.deepEqual(studentProjection.chargeGroups, financeProjection.chargeGroups);
  assert.deepEqual(studentProjection.termBalances, financeProjection.termBalances);
  assert.equal(studentProjection.summary.totalBalance, '75.00');
  assert.equal(studentProjection.summary.annualFeeBalance, '60.00');
  assert.equal(studentProjection.summary.availableCredit, '12.00', 'unused credit stays separate from the account balance');
  assert.deepEqual(studentProjection.charges.map(({ due_amount, other_adjustments }) => ({ due_amount, other_adjustments })), [
    { due_amount: '20.00', other_adjustments: '5.00' },
    { due_amount: '0.00', other_adjustments: '0.00' },
    { due_amount: '35.00', other_adjustments: '5.00' },
    { due_amount: '-5.00', other_adjustments: '0.00' },
    { due_amount: '10.00', other_adjustments: '0.00' }
  ]);
  assert.deepEqual(studentProjection.chargeGroups.map(({ school_year, term, due }) => ({ school_year, term, due })), [
    { school_year: '2025-2026', term: 'Term 1', due: '20.00' },
    { school_year: '2026-2027', term: 'Term 1', due: '35.00' },
    { school_year: '2026-2027', term: 'Term 2', due: '-5.00' },
    { school_year: '2026-2027', term: 'Term 3', due: '10.00' }
  ]);
  assert.doesNotMatch(JSON.stringify(studentProjection), /Staff-only adjustment reason|PRIVATE-REF/);
});
