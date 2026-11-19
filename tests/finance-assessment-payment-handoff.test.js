'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAssessmentPaymentHandoff } = require('../src/services/financeAssessmentPaymentHandoff');
const { createFinanceReviewActionService } = require('../src/services/financeReviewActionService');

const ledger = {
  terms: [{ annual_enrollment_id: 21, student_id: 22, school_year: '2026-2027',
    intake_status: 'pending', assessment_id: 95, entry_term_number: 1 }],
  charges: [{ charge_id: 81, annual_enrollment_id: 21, annual_term_number: 1,
    fee_category: 'tuition', installment: 'DP', remaining_due: '875.00' },
  { charge_id: 82, annual_enrollment_id: 21, annual_term_number: 2,
    fee_category: 'tuition', installment: 'DP', remaining_due: '875.00' }]
};

test('saved assessment returns to the same student and intake payment context', () => {
  const actions = createFinanceReviewActionService({ getPool: async () => { throw new Error('must not query'); } });
  assert.equal(actions.afterCommitPath({ actionType: 'annual_assessment',
    entityContext: { studentId: 22, annualId: 21 }, committedResult: {} }),
  '/finance/students/22/annual?view=payments&notice=assessmentReviewed&annualId=21#assessment-payment-handoff');
  assert.equal(actions.afterCommitPath({ actionType: 'annual_assessment', entityContext: {}, committedResult: {} }),
    '/finance/assessments?notice=assessmentSaved');
});

test('handoff uses current intake and entry-term down-payment balance only', () => {
  const readiness = new Map([[21, { status: 'awaiting_down_payment', reviewed: true, entryTermNumber: 1 }]]);
  assert.deepEqual(buildAssessmentPaymentHandoff(ledger, readiness, '21'), {
    annualId: 21, schoolYear: '2026-2027', entryTermNumber: 1,
    status: 'awaiting_down_payment', reviewed: true, handoffId: null, handoffStatus: null,
    enrollmentStatus: 'awaiting_registrar_handoff', downPaymentDue: '875.00', targetChargeId: 81
  });
  const paid = structuredClone(ledger);
  paid.charges[0].remaining_due = '0.00';
  readiness.set(21, { status: 'ready_for_registrar', reviewed: true, entryTermNumber: 1 });
  assert.equal(buildAssessmentPaymentHandoff(paid, readiness, '21').targetChargeId, null);
  assert.equal(buildAssessmentPaymentHandoff(paid, readiness, '21').status, 'ready_for_registrar');
  assert.equal(buildAssessmentPaymentHandoff({ ...ledger, charges: [] }, readiness, '21').downPaymentDue, null,
    'a missing installment cannot be presented as zero due');
  assert.equal(buildAssessmentPaymentHandoff(ledger, readiness, '22'), null);
  assert.equal(buildAssessmentPaymentHandoff(ledger, readiness, '21/../../x'), null);
  const confirmed = structuredClone(ledger);
  confirmed.terms[0].intake_status = 'confirmed';
  assert.equal(buildAssessmentPaymentHandoff(confirmed, readiness, '21'), null);
});

test('Finance status keeps Registrar blockers and activation retry distinct from payment readiness', () => {
  const readiness = new Map([[21, { status: 'ready_for_registrar', reviewed: true, entryTermNumber: 1 }]]);
  const current = structuredClone(ledger);
  current.terms[0].registrar_handoff_id = 71;
  for (const [handoffStatus, expected] of [
    ['academic_review_required', 'awaiting_registrar_correction'],
    ['registrar_review_required', 'registrar_review_required'],
    ['retry_required', 'retry_required'],
    ['awaiting_finance', 'retry_required']
  ]) {
    current.terms[0].registrar_handoff_status = handoffStatus;
    const status = buildAssessmentPaymentHandoff(current, readiness, '21');
    assert.equal(status.enrollmentStatus, expected);
    assert.equal(status.handoffId, 71);
    assert.equal(status.status, 'ready_for_registrar', 'payment readiness remains an independent fact');
  }
  current.terms[0].entry_activation_id = 80;
  current.terms[0].enrollment_id = 91;
  current.terms[0].entry_activation_enrollment_id = 91;
  current.terms[0].intake_status = 'enrolled';
  assert.equal(buildAssessmentPaymentHandoff(current, new Map(), '21').enrollmentStatus, 'activated',
    'activated records remain visible after Finance changes the intake status');
});

test('replayed Finance commits retain saved activation evidence when a retry returns no candidates', async () => {
  const saved = [{ annualEnrollmentId: 21, status: 'awaiting_finance' }];
  const actions = createFinanceReviewActionService({
    draftService: {
      async commitReviewedDraft() { return { committed: true, replayed: true, result: { paymentId: 91, enrollmentActivation: saved } }; },
      async getDraft() { return { actionType: 'annual_payment', entityContext: { studentId: 22 } }; }
    },
    annualEnrollmentService: { async retryFinanceHandoffs(_actorId, selector) {
      assert.deepEqual(selector, { studentId: 22 });
      return [];
    } }
  });
  const result = await actions.commit(7, 'a'.repeat(64), 'review-id', 1, 'b'.repeat(64));
  assert.deepEqual(result.result.enrollmentActivation, saved);
  assert.equal(result.result.paymentId, 91);
});
