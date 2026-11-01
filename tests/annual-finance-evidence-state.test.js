'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAnnualFinanceFingerprintState, normalizeAnnualOptionalLineIds,
  applyRestatementTuitionLines, isCurrentFinanceSchedule
} = require('../src/services/annualFinanceService');

const parent = Object.freeze({ id: 17, student_id: 29, school_year: '2026-2027', grade_level: 'Grade 7',
  voucher_code: 'ESC', entry_term_number: 2, assessment_id: 101, schedule_id: 11, schedule_version: 4,
  voucher_code_snapshot: 'ESC', selection_json: JSON.stringify({ optionalLineIds: [5, 3, 5] }) });

const scheduleLines = Object.freeze([
  { id: 1, termNumber: 1, category: 'tuition', lineName: 'Tuition', installment: 'DP', amount: '1000.00', isOptional: false },
  { id: 2, termNumber: 2, category: 'tuition', lineName: 'Tuition', installment: 'DP', amount: '1000.00', isOptional: false },
  { id: 3, termNumber: 2, category: 'activity', lineName: 'Laboratory', installment: 'Term fee', amount: '175.25', isOptional: true },
  { id: 4, termNumber: 3, category: 'tuition', lineName: 'Tuition', installment: 'Finals', amount: '1000.00', isOptional: false },
  { id: 5, termNumber: 3, category: 'other', lineName: 'Manual field trip', installment: 'Once', amount: '40.00', isOptional: true }
]);

const charges = Object.freeze([
  { id: 1, term_number: 1, schedule_line_id: 1, fee_category: 'tuition', line_name: 'Tuition',
    installment: 'DP', is_manual: 0, amount: '1000.00', waived_amount: '0.00' },
  { id: 2, term_number: 2, schedule_line_id: 2, fee_category: 'tuition', line_name: 'Tuition',
    installment: 'DP', is_manual: 0, amount: '1000.00', waived_amount: '100.00' },
  { id: 3, term_number: 2, schedule_line_id: 3, fee_category: 'activity', line_name: 'Laboratory',
    installment: 'Term fee', is_manual: 0, amount: '175.25', waived_amount: '0.00' },
  { id: 4, term_number: 3, schedule_line_id: 4, fee_category: 'tuition', line_name: 'Tuition',
    installment: 'Finals', is_manual: 0, amount: '1000.00', waived_amount: '0.00' },
  { id: 5, term_number: 3, schedule_line_id: 5, fee_category: 'other', line_name: 'Manual field trip',
    installment: 'Once', is_manual: 1, amount: '40.00', waived_amount: '5.00' }
]);

const adjustments = Object.freeze([
  { id: 41, chargeId: 3, reversesAdjustmentId: null, amount: '-10.00' },
  { id: 42, chargeId: 3, reversesAdjustmentId: 41, amount: '10.00' },
  { id: 43, chargeId: 5, reversesAdjustmentId: null, amount: '2.50' }
]);

function fingerprints(overrides = {}) {
  return buildAnnualFinanceFingerprintState({ parent, restatement: null, voucherReview: null,
    optionalLineIds: [3, 5], scheduleLines, charges, adjustments, ...overrides });
}

test('canonical queue evidence is stable and includes optional lines, manual fees, adjustments, and reversals', () => {
  const first = fingerprints();
  const second = fingerprints();
  assert.deepEqual(first, second);
  assert.equal(first.assessedComposition.total, '3110.25');
  assert.equal(first.assessedComposition.lines.length, 5);
  assert.notEqual(first.assessmentFingerprint, first.dependencyFingerprint);
  assert.deepEqual(normalizeAnnualOptionalLineIds(parent), [3, 5]);

  const changedAdjustment = fingerprints({ adjustments: [...adjustments,
    { id: 44, chargeId: 5, reversesAdjustmentId: 43, amount: '-2.50' }] });
  assert.equal(changedAdjustment.assessmentFingerprint, first.assessmentFingerprint);
  assert.notEqual(changedAdjustment.dependencyFingerprint, first.dependencyFingerprint,
    'adjustment reversal history remains bound even though gross charge composition is unchanged');

  const changedFee = fingerprints({ charges: charges.map((charge) => charge.id === 5
    ? { ...charge, amount: '41.00' } : charge) });
  assert.notEqual(changedFee.assessmentFingerprint, first.assessmentFingerprint);
  assert.notEqual(changedFee.dependencyFingerprint, first.dependencyFingerprint);

  const changedSchedule = fingerprints({ scheduleLines: scheduleLines.map((line) => line.id === 3
    ? { ...line, amount: '176.25' } : line) });
  assert.notEqual(changedSchedule.dependencyFingerprint, first.dependencyFingerprint);
});

test('active restatement binds target tuition and leaves shared source arrays unchanged', () => {
  const targetTuitionLines = Array.from({ length: 12 }, (_, index) => ({ id: index + 100, termNumber: Math.floor(index / 4) + 1,
    category: 'tuition', lineName: 'Synthetic restated tuition', installment: ['DP', 'Prelim', 'Midterm', 'Finals'][index % 4],
    amount: '250.00', isOptional: false }));
  const before = structuredClone(scheduleLines);
  const activeRestatement = { operationId: 'synthetic-operation', status: 'active', annualEnrollmentId: 17,
    assessmentId: 101, sourceScheduleId: 11, sourceScheduleVersion: 4, targetTuitionScheduleId: 12,
    targetTuitionScheduleVersion: 2, beforeImageSha256: 'a'.repeat(64), appliedImageSha256: 'b'.repeat(64) };
  const combined = applyRestatementTuitionLines(scheduleLines, targetTuitionLines, activeRestatement);
  assert.equal(combined.filter((line) => line.category === 'tuition').length, 12);
  assert.equal(combined.some((line) => line.lineName === 'Laboratory'), true);
  assert.notEqual(combined.find((line) => line.id === 100), targetTuitionLines[0], 'the evaluator receives a clone');
  assert.deepEqual(scheduleLines, before);
  assert.deepEqual(targetTuitionLines[0], { id: 100, termNumber: 1, category: 'tuition',
    lineName: 'Synthetic restated tuition', installment: 'DP', amount: '250.00', isOptional: false });

  const base = fingerprints();
  const restated = fingerprints({ restatement: activeRestatement, scheduleLines: combined });
  assert.equal(restated.assessmentFingerprint, base.assessmentFingerprint,
    'the posted charge composition remains the same when only its active restatement binding changes');
  assert.notEqual(restated.assessmentSnapshotFingerprint, base.assessmentSnapshotFingerprint);
  assert.notEqual(restated.dependencyFingerprint, base.dependencyFingerprint);
  const reversed = fingerprints({ restatement: { ...activeRestatement, status: 'reversed' } });
  assert.equal(reversed.assessmentFingerprint, base.assessmentFingerprint);
  assert.equal(reversed.dependencyFingerprint, base.dependencyFingerprint);
  assert.throws(() => applyRestatementTuitionLines(scheduleLines, targetTuitionLines.slice(0, 11), activeRestatement),
    /bound tuition installment schedule is incomplete/);
});

test('schedule binding and malformed selection remain fail-closed', () => {
  assert.equal(isCurrentFinanceSchedule(parent, { id: 11, school_year: '2026-2027', grade_level: 'Grade 7',
    voucher_code: 'ESC', version_no: 4 }), true);
  assert.equal(isCurrentFinanceSchedule(parent, { school_year: '2026-2027', grade_level: 'Grade 7',
    voucher_code: 'ESC', version_no: 3 }), false);
  assert.equal(isCurrentFinanceSchedule(parent, null), false,
    'a missing schedule cannot match null assessment bindings and must clear prior review state');
  assert.throws(() => normalizeAnnualOptionalLineIds({ ...parent, selection_json: '{not-json' }),
    /saved assessment selection needs Finance review/);
});
