const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const {
  formatFeePurpose, buildPaymentPurposeHistory, safeStudentPaymentPurposeHistory,
  annotateRestatementSourceAllocations, buildRestatementSourceAllocationPurposeMap,
  annotateRestatementSyntheticPlacementAllocations, buildRestatementSyntheticPlacementPurposeMap
} = require('../src/utils/paymentPurpose');
const { formatMoney } = require('../src/utils/formatMoney');

test('fee purpose uses the saved annual context, category, and relevant installment only', () => {
  assert.equal(formatFeePurpose({
    school_year: '2026-2027', grade_level: 'Grade 11', annual_term_number: 2,
    line_name: 'Tuition', fee_category: 'tuition', installment: 'Prelim'
  }), '2026-2027 · Grade 11 · Term 2 · Tuition · Prelim');
  assert.equal(formatFeePurpose({
    school_year: '2025-2026', grade_level: 'Grade 12', annual_term_number: 1,
    line_name: 'Laboratory materials', fee_category: 'miscellaneous', installment: 'Whole term'
  }), '2025-2026 · Grade 12 · Term 1 · Laboratory materials · Category: Miscellaneous');
  assert.equal(formatFeePurpose({ line_name: 'Tuition' }), 'Tuition');
  assert.equal(formatFeePurpose({}), 'Fee details unavailable');
});

test('payment-purpose history groups saved allocations and preserves reversal, release, source, and unknown-balance states', () => {
  const history = buildPaymentPurposeHistory({
    payments: [
      { payment_id: 41, payment_date: '2026-10-01', amount: '5000.00', reference_no: 'REF-41', receipt_issued: 1,
        is_reversed: 0, current_available_credit: '1500.00', transmittal_reference: 'PRIVATE-TRANS', private_remarks: 'PRIVATE-NOTE' },
      { payment_id: 42, payment_date: '2026-10-02', amount: '250.00', is_reversed: 1, current_available_credit: '0.00' },
      { payment_id: 43, payment_date: '2026-10-03', amount: '20.00', is_reversed: 0 }
    ],
    allocations: [
      { allocation_id: 1, payment_id: 41, charge_id: 81, original_amount: '2500.00', remaining_amount: '2500.00', released_amount: '0.00',
        school_year: '2026-2027', grade_level: 'Grade 11', annual_term_number: 2, line_name: 'Tuition', fee_category: 'tuition', installment: 'Prelim', current_due_amount: '2500.00' },
      { allocation_id: 2, payment_id: 41, charge_id: 82, original_amount: '1500.00', remaining_amount: '1000.00', released_amount: '500.00',
        school_year: '2025-2026', grade_level: 'Grade 12', annual_term_number: 1, line_name: 'Materials fee', fee_category: 'miscellaneous', installment: 'Whole term', current_due_amount: null },
      { allocation_id: 3, payment_id: 42, legacy_opening_charge_id: 91, original_amount: '250.00', remaining_amount: '250.00', released_amount: '0.00',
        source_label: '2024 account balance', current_due_amount: '900.00' }
    ],
    legacyReconciliations: [
      { reconciliation_id: 7, transaction_id: 90, charge_id: 83, original_amount: '75.00', remaining_amount: '50.00', released_amount: '25.00',
        school_year: '2024-2025', grade_level: 'Grade 12', annual_term_number: 3, line_name: 'Tuition', fee_category: 'tuition', installment: 'Finals', current_due_amount: '100.00' }
    ],
    events: [
      { event_type: 'unattributed legacy payment', source_id: 90, event_date: '2025-04-01', amount: '75.00', details: 'PRIVATE-LEGACY-DESCRIPTION' },
      { event_type: 'unattributed legacy payment', source_id: 91, event_date: '2025-05-01', amount: '40.00', details: 'PRIVATE-LEGACY-DESCRIPTION' }
    ]
  });

  assert.equal(history.payments[0].amount, '5000.00');
  assert.equal(history.payments[0].current_available_credit, '1500.00');
  assert.deepEqual(history.payments[0].allocations.map(({ purpose, original_amount, current_amount, released_amount, current_fee_balance }) => ({
    purpose, original_amount, current_amount, released_amount, current_fee_balance
  })), [
    { purpose: '2026-2027 · Grade 11 · Term 2 · Tuition · Prelim', original_amount: '2500.00', current_amount: '2500.00', released_amount: '0.00', current_fee_balance: '2500.00' },
    { purpose: '2025-2026 · Grade 12 · Term 1 · Materials fee · Category: Miscellaneous', original_amount: '1500.00', current_amount: '1000.00', released_amount: '500.00', current_fee_balance: null }
  ]);
  assert.equal(history.payments[1].allocations[0].current_amount, '0.00', 'a reversed payment has no active allocation');
  assert.equal(history.payments[1].allocations[0].purpose, 'Confirmed previous balance · 2024 account balance');
  assert.equal(history.payments[2].current_available_credit, null, 'missing current credit stays unavailable instead of becoming zero');
  assert.deepEqual(history.earlier_payments[0].allocations.map(({ purpose, application_label, original_amount, current_amount, current_fee_balance }) => ({
    purpose, application_label, original_amount, current_amount, current_fee_balance
  })), [{ purpose: 'Applied later · 2024-2025 · Grade 12 · Term 3 · Tuition · Finals', application_label: 'Applied later',
    original_amount: '75.00', current_amount: '50.00', current_fee_balance: '100.00' }]);
  assert.deepEqual(history.earlier_payments[1].allocations, [], 'a legacy payment without a saved reconciliation has no asserted purpose');
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE-TRANS|PRIVATE-NOTE|PRIVATE-LEGACY/);
});

test('restatement history keeps recorded releases separate from current releases and restores original whole-term purpose', () => {
  const beforeImage = {
    annual: { id: 7, school_year: '2026-2027', grade_level: 'Grade 11' },
    charges: [{ id: 81, enrollment_id: 91, fee_category: 'tuition', line_name: 'Tuition', installment: 'Term 2' }],
    enrollments: [{ id: 91, annual_term_number: 2 }],
    allocations: [{ id: 501, charge_id: 81 }]
  };
  const beforeImageJson = JSON.stringify(beforeImage);
  const archiveRow = {
    operation_id: 'op-7', annual_enrollment_id: 7, before_image_json: beforeImageJson,
    before_image_sha256: require('node:crypto').createHash('sha256').update(beforeImageJson).digest('hex'),
    applied_event_id: 1, reversed_event_id: null
  };
  const sourcePurpose = buildRestatementSourceAllocationPurposeMap([archiveRow]);
  const sourceAllocation = {
    allocation_id: 501, payment_id: 1, charge_id: 81, source_restatement_operation_id: 'op-7',
    school_year: '2026-2027', grade_level: 'Grade 11', annual_term_number: 2,
    line_name: 'Tuition', fee_category: 'tuition', installment: 'DP',
    original_amount: '950.00', remaining_amount: '0.00', released_amount: '0.00',
    recorded_released_amount: '950.00', current_due_amount: '300.00'
  };
  const active = annotateRestatementSourceAllocations([sourceAllocation], sourcePurpose);
  const reversed = annotateRestatementSourceAllocations([sourceAllocation], buildRestatementSourceAllocationPurposeMap([{ ...archiveRow, reversed_event_id: 3 }]));
  const activeHistory = buildPaymentPurposeHistory({ payments: [{ payment_id: 1, is_reversed: 0 }], allocations: active });
  const reversedHistory = buildPaymentPurposeHistory({ payments: [{ payment_id: 1, is_reversed: 0 }], allocations: reversed });

  assert.match(activeHistory.payments[0].allocations[0].purpose, /Original whole-term tuition/);
  assert.match(activeHistory.payments[0].allocations[0].purpose, /released into synthetic installment placements/);
  assert.equal(activeHistory.payments[0].allocations[0].released_amount, '950.00');
  assert.equal(activeHistory.payments[0].allocations[0].current_released_amount, '0.00');
  assert.equal(activeHistory.payments[0].allocations[0].current_fee_balance, null,
    'the reused DP balance is not presented as the old whole-term tuition balance');
  assert.match(reversedHistory.payments[0].allocations[0].purpose, /Original whole-term tuition/);
  assert.match(reversedHistory.payments[0].allocations[0].purpose, /remains in history/);
  assert.equal(reversedHistory.payments[0].allocations[0].released_amount, '950.00');
  assert.equal(reversedHistory.payments[0].allocations[0].current_released_amount, '0.00');
  assert.equal(reversedHistory.payments[0].allocations[0].current_fee_balance, '300.00',
    'after reversal the restored whole-term source charge can provide its own current balance');

  const incomplete = annotateRestatementSourceAllocations([sourceAllocation], buildRestatementSourceAllocationPurposeMap([
    { ...archiveRow, applied_event_id: null, reversed_event_id: null }
  ]));
  const incompleteHistory = buildPaymentPurposeHistory({ payments: [{ payment_id: 1, is_reversed: 0 }], allocations: incomplete });
  assert.match(incompleteHistory.payments[0].allocations[0].purpose, /apply evidence is incomplete/);
  assert.equal(incompleteHistory.payments[0].allocations[0].current_fee_balance, '300.00',
    'missing applied evidence leaves the original source balance available');
});

test('restatement source purpose mapping rejects altered archived evidence and ignores unrelated releases', () => {
  const beforeImageJson = JSON.stringify({ annual: { id: 7 }, charges: [], enrollments: [], allocations: [] });
  assert.throws(() => buildRestatementSourceAllocationPurposeMap([{
    operation_id: 'op-7', annual_enrollment_id: 7, before_image_json: beforeImageJson,
    before_image_sha256: '0'.repeat(64)
  }]), /before-image digest is invalid/);
  assert.equal(annotateRestatementSourceAllocations([{
    allocation_id: 999, source_restatement_operation_id: 'other-op'
  }], new Map()).length, 1);
});

test('synthetic placement history keeps its applied-image installment purpose after reversal', () => {
  const appliedImageJson = JSON.stringify({ placementAllocations: [
    { allocationId: 705, annualId: 7, term: 1, installment: 'DP' },
    { allocationId: 706, annualId: 7, term: 1, installment: 'Prelim' }
  ] });
  const archiveRow = {
    operation_id: 'op-7', annual_enrollment_id: 7, school_year: '2026-2027', grade_level: 'Grade 11',
    applied_image_json: appliedImageJson,
    applied_image_sha256: require('node:crypto').createHash('sha256').update(appliedImageJson).digest('hex'),
    applied_event_id: 2,
    reversed_event_id: 3
  };
  const purposeByAllocationId = buildRestatementSyntheticPlacementPurposeMap([archiveRow]);
  const [reversed] = annotateRestatementSyntheticPlacementAllocations([{
    allocation_id: 705, payment_id: 10, synthetic_restatement_operation_id: 'op-7', synthetic_restatement_kind: 'placement',
    line_name: 'Tuition', fee_category: 'tuition', installment: 'Term 1',
    original_amount: '950.00', remaining_amount: '950.00', current_due_amount: '5000.00'
  }], purposeByAllocationId);
  const [projected] = buildPaymentPurposeHistory({
    payments: [{ payment_id: 10, is_reversed: 0 }],
    allocations: [reversed]
  }).payments[0].allocations;

  assert.match(projected.purpose, /Historical synthetic tuition placement; restatement reversed/);
  assert.match(projected.purpose, /2026-2027 · Grade 11 · Term 1 · Tuition · DP/);
  assert.doesNotMatch(projected.purpose, /Term 1 · Tuition · Term 1/);
  assert.equal(projected.current_fee_balance, null,
    'the restored whole-term source charge balance does not belong to a historical DP placement');

  const [active] = annotateRestatementSyntheticPlacementAllocations([{
    allocation_id: 706, synthetic_restatement_operation_id: 'op-7', synthetic_restatement_kind: 'placement',
    line_name: 'Tuition', fee_category: 'tuition', installment: 'Term 1', current_due_amount: '2500.00'
  }], buildRestatementSyntheticPlacementPurposeMap([{ ...archiveRow, reversed_event_id: null }]));
  assert.match(active.original_purpose_label, /Term 1 · Tuition · Prelim/);
  assert.equal(active.current_due_amount, '2500.00', 'an active placement keeps its own current balance');
  const [incomplete] = annotateRestatementSyntheticPlacementAllocations([{
    allocation_id: 705, synthetic_restatement_operation_id: 'op-7', synthetic_restatement_kind: 'placement',
    line_name: 'Tuition', fee_category: 'tuition', installment: 'Term 1', current_due_amount: '2500.00'
  }], buildRestatementSyntheticPlacementPurposeMap([{ ...archiveRow, applied_event_id: null, reversed_event_id: null }]));
  assert.match(incomplete.restatement_history_label, /no applied restatement event/);
  assert.equal(incomplete.current_due_amount, null, 'without active evidence a generated placement has no current balance');
  assert.throws(() => buildRestatementSyntheticPlacementPurposeMap([{
    ...archiveRow, applied_image_sha256: '0'.repeat(64)
  }]), /applied-image digest is invalid/);
});

test('student payment-purpose projection allowlists only safe, current payment details', () => {
  const projected = safeStudentPaymentPurposeHistory({
    payments: [{ payment_id: 4, payment_date: '2026-10-01', amount: '50.00', reference_no: 'REF-4', receipt_issued: true,
      is_reversed: false, current_available_credit: '20.00', transmittal_reference: 'SECRET-TRANS', private_remarks: 'SECRET-NOTE',
      reference_history: ['SECRET-OLD-REF'], correction_reason: 'SECRET-CORRECTION',
      allocations: [{ purpose: '2026-2027 · Grade 11 · Term 2 · Tuition · DP', original_amount: '30.00', current_amount: '30.00',
        current_fee_balance: null, private_reason: 'SECRET-REASON' }] }],
    earlier_payments: [{ transaction_id: 5, payment_date: '2024-01-01', amount: '10.00', description: 'SECRET-DESCRIPTION', allocations: [] }]
  });
  const text = JSON.stringify(projected);
  assert.match(text, /REF-4/);
  assert.match(text, /Term 2 · Tuition · DP/);
  assert.doesNotMatch(text, /SECRET/);
  assert.equal(projected.payments[0].allocations[0].current_fee_balance, null);
});

test('printable payment confirmation renders allocation purpose and current balance without private notes', async () => {
  const template = path.join(__dirname, '..', 'views', 'finance', 'payment-confirmation.ejs');
  const html = await ejs.renderFile(template, {
    title: 'Payment confirmation', currentUser: { role: 'student' }, kind: 'annual', formatMoney,
    formatFinanceDateTime: () => 'October 1, 2026',
    confirmation: {
      payment: { payment_id: 41, payment_date: '2026-10-01', amount: '5000.00', reference_no: 'REF-41', receipt_issued: true,
        is_reversed: false, current_available_credit: '1500.00', transmittal_reference: 'SECRET-TRANS', private_remarks: 'SECRET-NOTE',
        correction_reason: 'SECRET-CORRECTION', student_id: 55, student_no: 'S-55', first_name: 'Rae', last_name: 'Student' },
      allocations: [{ target_label: '2026-2027 · Grade 11 · Term 2 · Tuition · Prelim', original_amount: '4000.00',
        current_net_amount: '3500.00', released_amount: '500.00', current_due_amount: '1250.00' }]
    }
  });
  assert.match(html, /Payment total<\/dt><dd>₱5,000\.00/);
  assert.match(html, /Unused credit currently available<\/dt><dd>₱1,500\.00/);
  assert.match(html, /2026-2027 · Grade 11 · Term 2 · Tuition · Prelim/);
  assert.match(html, /data-label="Originally applied">₱4,000\.00/);
  assert.match(html, /data-label="Currently applied">₱3,500\.00/);
  assert.match(html, /data-label="Current fee balance">₱1,250\.00/);
  assert.match(html, /₱500\.00 was released from this application and is excluded from its current applied amount/);
  assert.doesNotMatch(html, /SECRET-TRANS|SECRET-NOTE|SECRET-CORRECTION/);

  const unavailableCreditHtml = await ejs.renderFile(template, {
    title: 'Payment confirmation', currentUser: { role: 'student' }, kind: 'annual', formatMoney,
    formatFinanceDateTime: () => 'October 1, 2026',
    confirmation: { payment: { amount: '50.00', current_available_credit: null, is_reversed: false, receipt_issued: false }, allocations: [] }
  });
  assert.match(unavailableCreditHtml, /Unused credit currently available<\/dt><dd>Unavailable/);

  const reversedRestatementHtml = await ejs.renderFile(template, {
    title: 'Payment confirmation', currentUser: { role: 'student' }, kind: 'annual', formatMoney,
    formatFinanceDateTime: () => 'October 1, 2026',
    confirmation: { payment: { amount: '950.00', current_available_credit: '0.00', is_reversed: false, receipt_issued: false },
      allocations: [{ target_label: 'Original whole-term tuition · 2026-2027 · Grade 11 · Term 2 · Tuition',
        original_amount: '950.00', current_net_amount: '950.00', released_amount: '0.00', recorded_released_amount: '950.00',
        restatement_history_label: 'Original assessment allocation release remains in history; its value was restored as a separate current application.' }] }
  });
  assert.match(reversedRestatementHtml, /Original whole-term tuition/);
  assert.match(reversedRestatementHtml, /historical restatement recorded a ₱950\.00 release; that release is inactive after reversal/);
  assert.doesNotMatch(reversedRestatementHtml, /has since been removed/);
});

test('Finance review renders a split payment with distinct saved school-year and term purposes', async () => {
  const template = path.join(__dirname, '..', 'views', 'finance', 'review-draft.ejs');
  const html = await ejs.renderFile(template, {
    title: 'Review payment', actionLabel: 'Review payment', error: null, status: 200, previewUnavailable: false, recoveredForm: null,
    previewFields: [], editorFields: [], csrfToken: 'test-token',
    draft: { id: 'draft-1', revision: 1, dependencyFingerprint: 'fingerprint', requiresReview: false, preview: {
      student: { name: 'Rae Student', studentNumber: 'S-55' }, cashAmount: '5000.00', appliedAmount: '5000.00', unallocatedCredit: '0.00',
      allocationRows: [
        { targetReference: '2026-2027 · Grade 11 · Term 2 · Tuition · Prelim', feeContext: '2026-2027 · Grade 11 · Term 2',
          dueBefore: '2500.00', amount: '2000.00', dueAfter: '500.00' },
        { targetReference: '2025-2026 · Grade 12 · Term 1 · Miscellaneous fee', feeContext: '2025-2026 · Grade 12 · Term 1',
          dueBefore: '3000.00', amount: '3000.00', dueAfter: '0.00' }
      ]
    } }
  });
  assert.match(html, /Payment amount<\/dt><dd>₱5000\.00/);
  assert.match(html, /2026-2027 · Grade 11 · Term 2 · Tuition · Prelim[\s\S]*?Current fee balance[\s\S]*?₱2500\.00[\s\S]*?₱2000\.00[\s\S]*?₱500\.00/);
  assert.match(html, /2025-2026 · Grade 12 · Term 1 · Miscellaneous fee[\s\S]*?₱3000\.00[\s\S]*?₱3000\.00[\s\S]*?₱0\.00/);
});
