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
    status: 'awaiting_down_payment', reviewed: true, downPaymentDue: '875.00', targetChargeId: 81
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
