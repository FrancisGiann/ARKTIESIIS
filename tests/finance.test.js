const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');
const { ACTION_WRITERS, SAFE_ACTIONS, actionByPath, createFinanceReviewActionService, normalizeActionInput, normalizeFinanceReturnContext, financeActionContext } = require('../src/services/financeReviewActionService');
const { AnnualFinanceError, createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { FinanceReviewDraftError, createFinanceReviewDraftService, validatePositivePaymentAmount } = require('../src/services/financeReviewDraftService');
const {
  FinanceServiceError,
  createFinanceService,
  parseMoneyCents,
  formatMoneyCents,
  validateTransaction
} = require('../src/services/financeService');

function createReviewRouteProbe() {
  const registry = createFinanceReviewActionService({ getPool: async () => { throw new Error('review probe must not read the database'); } });
  const starts = [];
  return {
    starts,
    matchesMutation: registry.matchesMutation,
    isReadOnlyPost: registry.isReadOnlyPost,
    actionLabel: registry.actionLabel,
    afterCommitPath: registry.afterCommitPath,
    async startDraft(actorId, binding, pathname, input) {
      starts.push({ actorId, pathname, input });
      return { id: '41111111-1111-4111-8111-111111111111' };
    }
  };
}

function fakeSql() {
  return {
    MAX: 'MAX',
    Int: 'Int',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
    NVarChar: (length) => `NVarChar(${length})`,
    Decimal: (precision, scale) => `Decimal(${precision},${scale})`
  };
}

function transactionalService(onQuery, debtRevisionService = null) {
  const log = { queries: [], isolation: null, committed: false, rolledBack: false };
  const transactionFactory = () => ({
    async begin(isolation) { log.isolation = isolation; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          const call = { statement, values: { ...values } };
          log.queries.push(call);
          return onQuery(call);
        }
      };
    },
    async commit() { log.committed = true; },
    async rollback() { log.rolledBack = true; }
  });
  return {
    service: createFinanceService({ getPool: async () => ({}), sql: fakeSql(), transactionFactory, debtRevisionService }),
    log
  };
}

function transactionFixture({ actorRole = 'finance', balance = '10.00', duplicate = false, failAt = null, studentExists = true, studentStatus = 'active', accountExists = false, transactionAccountExists = true, enrollmentStatus = 'pending_payment', enrollmentClearanceStatus = 'pending', enrollmentPaymentTransactionId = null, paymentAvailable = true, clearanceUpdateRows = 1, openingLiabilityExists = false } = {}) {
  let stateBalance = balance;
  let debtRevision = 0;
  const debtRevisionService = {
    async lockStudent(_transaction, studentId) { return studentExists ? { id: studentId, status: studentStatus, debtIncreaseRevision: String(debtRevision) } : null; },
    async readSnapshot() { return { canonicalBalanceCents: parseMoneyCents(stateBalance, { allowNegative: true, allowZero: true }) }; },
    async recordIncreaseIfAny(_transaction, _studentId, before) {
      const after = parseMoneyCents(stateBalance, { allowNegative: true, allowZero: true });
      if (after > before) debtRevision += 1;
      return { increased: after > before, debtIncreaseRevision: String(debtRevision) };
    }
  };
  const { service, log } = transactionalService(({ statement, values }) => {
    if (statement.includes('FROM users')) return { recordset: actorRole ? [{ id: 7, role: actorRole }] : [] };
    if (statement.includes('FROM annual_enrollments')) return { recordset: [] };
    if (statement.includes('FROM students')) return { recordset: studentExists ? [{ id: 22, status: studentStatus }] : [] };
    if (statement.includes('FROM financial_accounts WHERE')) return { recordset: accountExists ? [{ id: 30 }] : [] };
    if (statement.includes('FROM financial_accounts AS a')) return { recordset: transactionAccountExists ? [{ financial_account_id: 30, balance: stateBalance, status: studentStatus }] : [] };
    if (statement.includes('FROM financial_accounts AS account')) return { recordset: transactionAccountExists ? [{ financial_account_id: 30, status: studentStatus }] : [] };
    if (statement.includes('FROM finance_legacy_opening_charges')) return { recordset: openingLiabilityExists ? [{ id: 71 }] : [] };
    if (statement.includes('INNER JOIN annual_enrollments AS annual')) return { recordset: [] };
    if (statement.includes('FROM enrollments AS enrollment')) return { recordset: [{ id: 51, enrollment_status: enrollmentStatus, finalized_at: null, clearance_status: enrollmentClearanceStatus, payment_transaction_id: enrollmentPaymentTransactionId, created_for_intake: 1 }] };
    if (statement.includes('FROM financial_transactions AS payment')) return { recordset: paymentAvailable ? [{ id: 91 }] : [] };
    if (statement.includes('FROM financial_transactions')) return { recordset: duplicate ? [{ id: 90 }] : [] };
    if (statement.includes('UPDATE enrollment_clearances')) return { rowsAffected: [clearanceUpdateRows] };
    if (statement.includes('UPDATE financial_accounts')) {
      if (failAt === 'update') throw new Error('simulated account update failure');
      stateBalance = values.balance;
      return { recordset: [] };
    }
    if (statement.includes('INSERT INTO financial_accounts')) {
      if (failAt === 'account_insert') throw new Error('simulated account insert failure');
      return { recordset: [{ id: 30 }] };
    }
    if (statement.includes('INSERT INTO financial_transactions')) {
      if (failAt === 'transaction_insert') throw new Error('simulated transaction insert failure');
      return { recordset: [{ id: 91 }] };
    }
    if (statement.includes('INSERT INTO audit_logs')) {
      if (failAt === 'audit') throw new Error('simulated audit failure');
      return { recordset: [] };
    }
    throw new Error(`Unexpected query: ${statement}`);
  }, debtRevisionService);
  return { service, log, getBalance: () => stateBalance };
}

test('all registered finance writes have one route parser and one reviewed writer mapping', async () => {
  const cases = [
    ['document_clearance_decision', '/document-clearance/41111111-1111-4111-8111-111111111111/decision', 'documentClearance', 'decideClearance'],
    ['schedule_create', '/schedules', 'annual', 'createSchedule'],
    ['annual_assessment', '/annual/12/assessment', 'annual', 'confirmAnnualAssessment'],
    ['annual_payment', '/students/22/annual/payments', 'annual', 'recordPayment'],
    ['annual_credit_allocation', '/students/22/annual/credits/103/allocate', 'annual', 'allocateExistingCredit'],
    ['annual_adjustment', '/students/22/annual/charges/104/adjustments', 'annual', 'recordChargeAdjustment'],
    ['annual_handbook_reference', '/students/22/annual/12/handbook-number', 'annual', 'updateFinanceHandbookNumber'],
    ['annual_fee_comment', '/students/22/annual/charges/104/comments', 'annual', 'addFeeComment'],
    ['annual_supplementary_charge', '/students/22/annual/terms/14/supplementary-charges', 'annual', 'addSupplementaryCharge'],
    ['annual_special_subject_charge', '/students/22/annual/special-subjects/15/bill', 'cases', 'billSpecialSubject'],
    ['annual_exemption', '/students/22/annual/12/exemptions', 'cases', 'approveExemptionCase'],
    ['departure_review', '/departure-cases/16/review', 'cases', 'reviewDepartureCase'],
    ['annual_payment_reversal', '/students/22/annual/payments/103/reverse', 'annual', 'reversePayment'],
    ['annual_adjustment_reversal', '/students/22/annual/adjustments/104/reverse', 'annual', 'reverseAdjustment'],
    ['legacy_payment_reconciliation', '/students/22/annual/legacy-payments/105/reconcile', 'annual', 'reconcileLegacyPayment'],
    ['annual_allocation_release', '/students/22/annual/allocations/106/release', 'annual', 'releasePaymentAllocation'],
    ['legacy_reconciliation_release', '/students/22/annual/legacy-reconciliations/107/release', 'annual', 'releaseLegacyReconciliation'],
    ['annual_payment_metadata', '/students/22/annual/payments/103/metadata', 'annual', 'updatePaymentMetadata'],
    ['legacy_opening_transfer', '/students/22/annual/legacy-opening/transfer', 'annual', 'transferLegacyOpeningLiability'],
    ['term_finance_approval', '/annual/terms/14/approval', 'annual', 'approveTerm'],
    ['voucher_review_resolution', '/annual/12/voucher-review-resolution', 'annual', 'resolveVoucherReview'],
    ['term_clearance', '/annual/terms/14/clearance', 'annual', 'signTermClearance']
  ];
  assert.equal(SAFE_ACTIONS.length, 22);
  assert.deepEqual(Object.keys(ACTION_WRITERS).sort(), cases.map(([type]) => type).sort(), 'every supported action has a writer callback');
  for (const pathname of ['/students/22/account', '/students/22/transactions', '/students/22/enrollment-clearance']) {
    assert.equal(actionByPath(pathname), null, `${pathname} is retired from the reviewed action registry`);
  }
  const writerCalls = [];
  const services = Object.fromEntries(['annual', 'cases', 'documentClearance'].map((serviceName) => [serviceName,
    new Proxy({}, { get(_target, method) { return async (...args) => { writerCalls.push([serviceName, method, args]); return { saved: true }; }; } })
  ]));
  for (const [type, pathname, expectedService, expectedMethod] of cases) {
    const parsed = actionByPath(pathname);
    assert.equal(parsed?.type, type, `${pathname} parses to ${type}`);
    await ACTION_WRITERS[type]({ services, actorId: 7, studentId: 22, context: { ...parsed.context, studentId: 22 }, input: {
      optionalLineId: ['41'], enrollmentId: '14', paymentTransactionId: '105', confirmEnrollmentClearance: true
    } });
    assert.equal(writerCalls.at(-1)[0], expectedService, `${type} routes to its service`);
    assert.equal(writerCalls.at(-1)[1], expectedMethod, `${type} routes to ${expectedMethod}`);
  }
});

test('retired legacy account drafts can be discarded but cannot be resumed, edited, or committed', async () => {
  const draft = {
    id: '41111111-1111-4111-8111-111111111111', actionType: 'legacy_transaction', status: 'pending',
    entityContext: { studentId: 22 }, input: { transactionType: 'payment', amount: '20.00' }
  };
  let discarded = false;
  const draftService = {
    async getDraft() { return structuredClone(draft); },
    async commitReviewedDraft({ previewInTransaction }) { return previewInTransaction({}, draft); },
    async discardDraft() { discarded = true; }
  };
  const actions = createFinanceReviewActionService({ draftService });
  const binding = 'b'.repeat(64);
  const isRetiredError = (error) => error instanceof FinanceReviewDraftError && error.status === 410;

  assert.equal(actions.matchesMutation('/students/22/transactions'), false);
  assert.equal(actions.actionLabel('legacy_transaction'), 'Retired legacy account action');
  for (const actionType of ['legacy_account_create', 'legacy_transaction', 'legacy_enrollment_clearance']) {
    draft.actionType = actionType;
    await assert.rejects(actions.freshReview(7, binding, draft.id), isRetiredError);
    await assert.rejects(actions.updateDraft(7, binding, draft.id, {}), isRetiredError);
    await assert.rejects(actions.commit(7, binding, draft.id, 1, 'a'.repeat(64)), isRetiredError);
  }
  await actions.discard(7, draft.id);
  assert.equal(discarded, true);
});

test('saved reviews expose an owner discard action for retired legacy drafts', async () => {
  const draftId = '41111111-1111-4111-8111-111111111111';
  let discarded = false;
  const reviewActions = {
    async listPending() { return [{ id: draftId, actionType: 'legacy_transaction', updatedAt: new Date() }]; },
    actionLabel: () => 'Retired legacy account action',
    isRetiredAction: (type) => type === 'legacy_transaction',
    async discard(actorId, id) { assert.equal(actorId, 7); assert.equal(id, draftId); discarded = true; }
  };
  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, financeReviewActionService: reviewActions }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const response = await fetch(`${baseUrl}/finance/review-drafts`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<h1>Unfinished reviews<\/h1>/);
    assert.match(html, /Your unfinished reviews/);
    assert.match(html, /Retired legacy account action/);
    assert.match(html, new RegExp(`action="/finance/review-drafts/${draftId}/discard"`));
    assert.match(html, /Discard retired review/);
    assert.doesNotMatch(html, /Resume review/);

    const result = await fetch(`${baseUrl}/finance/review-drafts/${draftId}/discard`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFrom(html) })
    });
    assert.equal(result.status, 303);
    assert.equal(discarded, true);
  });
});

test('all 22 reviewed writers receive action-specific normalized raw form values and exact target arguments', async () => {
  const form = (values = {}) => ({ _csrf: 'transport-only', ...values });
  const cases = [
    { type: 'document_clearance_decision', path: '/document-clearance/41111111-1111-4111-8111-111111111111/decision', service: 'documentClearance', method: 'decideClearance', body: form({ decision: 'approve', reason: 'Reviewed', arrangement: 'Pay in two parts' }) },
    { type: 'schedule_create', path: '/schedules', service: 'annual', method: 'createSchedule', body: form({ schoolYear: '2027-2028', gradeLevel: 'Grade 11', voucherCode: 'ESC', termNumber: ['1', '1'], feeCategory: ['tuition', 'other'], lineName: ['Tuition', 'Laboratory'], installment: ['DP', 'As incurred'], lineAmount: ['125.50', '20.00'], optionalIndex: ['1'] }) },
    { type: 'annual_assessment', path: '/annual/12/assessment', service: 'annual', method: 'confirmAnnualAssessment', body: form({ optionalLineId: ['41', '42'] }) },
    { type: 'annual_payment', path: '/students/22/annual/payments', service: 'annual', method: 'recordPayment', body: form({ amount: '20.00', paymentDate: '2026-10-01', referenceNo: 'R-1', allocationTarget: ['charge:41', 'opening:42'], allocationAmount: ['12.00', '8.00'] }) },
    { type: 'annual_credit_allocation', path: '/students/22/annual/credits/103/allocate', service: 'annual', method: 'allocateExistingCredit', body: form({ allocationTarget: ['charge:41'], allocationAmount: ['12.00'] }) },
    { type: 'annual_adjustment', path: '/students/22/annual/charges/104/adjustments', service: 'annual', method: 'recordChargeAdjustment', body: form({ amount: '-2.00', reason: 'Correction' }) },
    { type: 'annual_handbook_reference', path: '/students/22/annual/12/handbook-number', service: 'annual', method: 'updateFinanceHandbookNumber', body: form({ financeHandbookNumber: 'FH-2027-11' }) },
    { type: 'annual_fee_comment', path: '/students/22/annual/charges/104/comments', service: 'annual', method: 'addFeeComment', body: form({ comment: 'Staff-only comment' }) },
    { type: 'annual_supplementary_charge', path: '/students/22/annual/terms/14/supplementary-charges', service: 'annual', method: 'addSupplementaryCharge', body: form({ lineName: 'Retake', feeCategory: 'retake', amount: '30.00', installment: 'As incurred', reason: 'Approved' }) },
    { type: 'annual_special_subject_charge', path: '/students/22/annual/special-subjects/15/bill', service: 'cases', method: 'billSpecialSubject', body: form({ amount: '50.00', installment: 'As incurred', reason: 'Approved' }) },
    { type: 'annual_exemption', path: '/students/22/annual/12/exemptions', service: 'cases', method: 'approveExemptionCase', body: form({ reason: 'Approved', ruleTerm: ['1', '2'], ruleCategory: ['tuition', 'activity'], ruleLineName: ['', 'Field trip'], ruleAmount: ['', '15.00'], fullCoverageIndex: ['0'] }) },
    { type: 'departure_review', path: '/departure-cases/16/review', service: 'cases', method: 'reviewDepartureCase', body: form({ decision: 'reviewed', reason: 'Checked', departureChargeId: ['51', '', '52'], departureAdjustmentAmount: ['-10.00', '', '5.00'], departureAdjustmentReason: ['Correction A', '', 'Correction B'] }) },
    { type: 'annual_payment_reversal', path: '/students/22/annual/payments/103/reverse', service: 'annual', method: 'reversePayment', body: form({ reason: 'Duplicate entry' }) },
    { type: 'annual_adjustment_reversal', path: '/students/22/annual/adjustments/104/reverse', service: 'annual', method: 'reverseAdjustment', body: form({ reason: 'Correction' }) },
    { type: 'legacy_payment_reconciliation', path: '/students/22/annual/legacy-payments/105/reconcile', service: 'annual', method: 'reconcileLegacyPayment', body: form({ reason: 'Matched', allocationTarget: ['charge:41', 'opening:42'], allocationAmount: ['5.00', '2.00'] }) },
    { type: 'annual_allocation_release', path: '/students/22/annual/allocations/106/release', service: 'annual', method: 'releasePaymentAllocation', body: form({ amount: '2.00', reason: 'Correction' }) },
    { type: 'legacy_reconciliation_release', path: '/students/22/annual/legacy-reconciliations/107/release', service: 'annual', method: 'releaseLegacyReconciliation', body: form({ amount: '2.00', reason: 'Correction' }) },
    { type: 'annual_payment_metadata', path: '/students/22/annual/payments/103/metadata', service: 'annual', method: 'updatePaymentMetadata', body: form({ eventType: 'receipt_reference_updated', referenceNo: 'R-103' }) },
    { type: 'legacy_opening_transfer', path: '/students/22/annual/legacy-opening/transfer', service: 'annual', method: 'transferLegacyOpeningLiability', body: form({ expectedAmount: '100.00', sourceLabel: 'Reviewed statement', reason: 'Verified' }) },
    { type: 'term_finance_approval', path: '/annual/terms/14/approval', service: 'annual', method: 'approveTerm', body: form({ decision: 'approved', reason: 'Reviewed' }) },
    { type: 'voucher_review_resolution', path: '/annual/12/voucher-review-resolution', service: 'annual', method: 'resolveVoucherReview', body: form({ resolution: 'assessment_stands', reason: 'Reviewed' }) },
    { type: 'term_clearance', path: '/annual/terms/14/clearance', service: 'annual', method: 'signTermClearance', body: form({ reason: 'Reviewed', arrangement: 'Payment plan' }) }
  ];
  assert.equal(cases.length, 22);
  const calls = [];
  const services = Object.fromEntries(['annual', 'cases', 'documentClearance'].map((serviceName) => [serviceName,
    new Proxy({}, { get(_target, method) { return async (...args) => { calls.push({ service: serviceName, method, args }); return { saved: true }; }; } })
  ]));
  for (const item of cases) {
    const parsed = actionByPath(item.path);
    assert.equal(parsed?.type, item.type);
    const input = normalizeActionInput(item.type, item.body);
    assert.equal(Object.hasOwn(input, '_csrf'), false, `${item.type} excludes CSRF transport input`);
    const expectedInput = { ...item.body };
    delete expectedInput._csrf;
    if (item.type === 'schedule_create') {
      expectedInput.lines = [
        { termNumber: '1', feeCategory: 'tuition', lineName: 'Tuition', installment: 'DP', amount: '125.50', isOptional: false },
        { termNumber: '1', feeCategory: 'other', lineName: 'Laboratory', installment: 'As incurred', amount: '20.00', isOptional: true }
      ];
      for (const key of ['termNumber', 'feeCategory', 'lineName', 'installment', 'lineAmount', 'optionalIndex']) delete expectedInput[key];
    }
    if (['annual_payment', 'annual_credit_allocation', 'legacy_payment_reconciliation'].includes(item.type)) {
      const targets = item.body.allocationTarget;
      const amounts = item.body.allocationAmount;
      expectedInput.allocations = targets.map((target, index) => {
        const match = /^(charge|opening):(\d+)$/.exec(target);
        return { chargeId: match?.[1] === 'charge' ? match[2] : null,
          openingLiabilityId: match?.[1] === 'opening' ? match[2] : null, amount: amounts[index] };
      });
      for (const key of ['allocationTarget', 'allocationAmount', 'chargeId']) delete expectedInput[key];
    }
    if (item.type === 'annual_exemption') {
      expectedInput.rules = [
        { termNumber: '1', feeCategory: 'tuition', lineName: '', isFullCoverage: true, approvedAmount: '0.00' },
        { termNumber: '2', feeCategory: 'activity', lineName: 'Field trip', isFullCoverage: false, approvedAmount: '15.00' }
      ];
      for (const key of ['ruleTerm', 'ruleCategory', 'ruleLineName', 'ruleAmount', 'fullCoverageIndex']) delete expectedInput[key];
    }
    if (item.type === 'departure_review') {
      expectedInput.adjustments = [
        { chargeId: '51', amount: '-10.00', reason: 'Correction A' },
        { chargeId: '52', amount: '5.00', reason: 'Correction B' }
      ];
      for (const key of ['departureChargeId', 'departureAdjustmentAmount', 'departureAdjustmentReason']) delete expectedInput[key];
    }
    assert.deepEqual(input, expectedInput, `${item.type} normalized raw form matches its canonical reviewed values`);
    const studentId = 22;
    const context = { ...parsed.context, studentId };
    await ACTION_WRITERS[item.type]({ services, actorId: 7, studentId, context, input });
    const call = calls.at(-1);
    assert.equal(call.service, item.service, `${item.type} service`);
    assert.equal(call.method, item.method, `${item.type} writer method`);
    const inputWithExpectedOwner = {
      ...input,
      ...(item.type === 'annual_assessment' ? { studentId } : {}),
      ...(['annual_handbook_reference', 'annual_exemption'].includes(item.type) ? { expectedStudentId: studentId } : {})
    };
    const expectedArgs = {
      document_clearance_decision: [7, parsed.context.requestId, input],
      schedule_create: [7, input],
      annual_assessment: [7, parsed.context.annualId, input.optionalLineId, inputWithExpectedOwner],
      annual_payment: [7, studentId, input],
      annual_credit_allocation: [7, studentId, parsed.context.paymentId, input],
      annual_adjustment: [7, studentId, parsed.context.chargeId, input],
      annual_handbook_reference: [7, parsed.context.annualId, inputWithExpectedOwner],
      annual_fee_comment: [7, studentId, parsed.context.chargeId, input],
      annual_supplementary_charge: [7, studentId, parsed.context.enrollmentId, input],
      annual_special_subject_charge: [7, studentId, parsed.context.specialSubjectId, input],
      annual_exemption: [7, parsed.context.annualId, inputWithExpectedOwner],
      departure_review: [7, parsed.context.caseId, input],
      annual_payment_reversal: [7, studentId, parsed.context.paymentId, input],
      annual_adjustment_reversal: [7, studentId, parsed.context.adjustmentId, input],
      legacy_payment_reconciliation: [7, studentId, parsed.context.transactionId, input],
      annual_allocation_release: [7, studentId, parsed.context.allocationId, input],
      legacy_reconciliation_release: [7, studentId, parsed.context.reconciliationId, input],
      annual_payment_metadata: [7, studentId, parsed.context.paymentId, input],
      legacy_opening_transfer: [7, studentId, input],
      term_finance_approval: [7, parsed.context.enrollmentId, input],
      voucher_review_resolution: [7, parsed.context.annualId, input],
      term_clearance: [7, parsed.context.enrollmentId, input]
    }[item.type];
    assert.deepEqual(call.args, expectedArgs, `${item.type} receives complete authorized context and normalized input`);
  }
  const schedule = normalizeActionInput('schedule_create', cases.find((item) => item.type === 'schedule_create').body);
  assert.deepEqual(schedule.lines, [
    { termNumber: '1', feeCategory: 'tuition', lineName: 'Tuition', installment: 'DP', amount: '125.50', isOptional: false },
    { termNumber: '1', feeCategory: 'other', lineName: 'Laboratory', installment: 'As incurred', amount: '20.00', isOptional: true }
  ]);
  const payment = normalizeActionInput('annual_payment', cases.find((item) => item.type === 'annual_payment').body);
  assert.deepEqual(payment.allocations, [
    { chargeId: '41', openingLiabilityId: null, amount: '12.00' },
    { chargeId: null, openingLiabilityId: '42', amount: '8.00' }
  ]);
  const exemption = normalizeActionInput('annual_exemption', cases.find((item) => item.type === 'annual_exemption').body);
  assert.deepEqual(exemption.rules, [
    { termNumber: '1', feeCategory: 'tuition', lineName: '', isFullCoverage: true, approvedAmount: '0.00' },
    { termNumber: '2', feeCategory: 'activity', lineName: 'Field trip', isFullCoverage: false, approvedAmount: '15.00' }
  ]);
  const departure = normalizeActionInput('departure_review', cases.find((item) => item.type === 'departure_review').body);
  assert.deepEqual(departure.adjustments, [
    { chargeId: '51', amount: '-10.00', reason: 'Correction A' },
    { chargeId: '52', amount: '5.00', reason: 'Correction B' }
  ]);
});

test('saved reversal and allocation-release drafts return to account history', () => {
  const actions = createFinanceReviewActionService({ getPool: async () => { throw new Error('redirect mapping must not query'); } });
  for (const actionType of ['annual_payment_reversal', 'annual_adjustment_reversal', 'annual_allocation_release', 'legacy_reconciliation_release']) {
    assert.equal(actions.afterCommitPath({ actionType, entityContext: { studentId: 22 }, committedResult: {} }),
      '/finance/students/22/annual?view=history&notice=reviewSaved');
  }
  for (const actionType of ['annual_credit_allocation', 'annual_payment_metadata']) {
    assert.equal(actions.afterCommitPath({ actionType, entityContext: { studentId: 22 }, committedResult: {} }),
      '/finance/students/22/annual?view=payments&notice=reviewSaved');
  }
});

test('payment return filters stay out of financial input and use only bounded internal return links', () => {
  const actions = createFinanceReviewActionService({ getPool: async () => { throw new Error('redirect mapping must not query'); } });
  const financialFields = {
    amount: '20.00', paymentDate: '2026-10-01', referenceNo: 'OR-1', receiptIssued: '0',
    allocations: [{ target: 'charge:41', amount: '20.00' }]
  };
  const withReturnContext = normalizeActionInput('annual_payment', {
    ...financialFields,
    financeBackSearch: 'Villanueva Santos', financeBackSchoolYear: '2026-2027',
    financeBackTermId: '41', financeBackStatus: 'enrolled', financeBackPage: '2',
    financeBackReturnTo: 'https://example.invalid/', financeBackUnknown: 'ignored',
    financeBackArray: Array.from({ length: 121 }, () => 'ignored')
  });
  assert.deepEqual(withReturnContext, normalizeActionInput('annual_payment', financialFields),
    'return navigation metadata does not enter the payment action input');
  assert.deepEqual(normalizeActionInput('annual_payment', {
    ...financialFields, search: 'Villanueva Santos', schoolYear: '2026-2027',
    backSearch: 'Villanueva Santos', backSchoolYear: '2026-2027', backTermId: '41'
  }), normalizeActionInput('annual_payment', financialFields),
  'canonical and back-prefixed filter aliases cannot leak into financial review fields');
  assert.deepEqual(actionByPath('/students/22/annual/payments')?.context, { studentId: '22' });

  const returnContext = normalizeFinanceReturnContext({
    financeBackSearch: 'Villanueva Santos', financeBackSchoolYear: '2026-2027',
    financeBackTermId: '41', financeBackStatus: 'enrolled', financeBackPage: '2',
    financeBackReturnTo: 'https://example.invalid/', financeBackUnknown: 'ignored',
    financeBackSectionId: { id: 9 }, financeBackCluster: 'x'.repeat(101),
    financeBackSchoolYearExtra: '2026-2027', financeBackVoucherCode: ['ESC'], financeBackPageTooLong: '99999'
  });
  assert.deepEqual(returnContext, {
    search: 'Villanueva Santos', schoolYear: '2026-2027', termId: '41', status: 'enrolled', page: '2'
  });
  assert.deepEqual(financeActionContext({ studentId: 22, financeUiReturnContext: returnContext }), { studentId: 22 },
    'saved return filters do not change review dependency context or stale checks');
  assert.deepEqual(normalizeFinanceReturnContext({ backSearch: 'Santos', search: ['bad'], backSchoolYear: 'not-a-year',
    schoolYear: '2026-2027', backTermId: { id: 41 }, termId: '41', backPage: '12345' }),
  { schoolYear: '2026-2027', termId: '41' }, 'malformed aliases are ignored while valid filters remain bounded');
  assert.equal(actions.afterCommitPath({ actionType: 'annual_payment',
    entityContext: { studentId: 22, financeUiReturnContext: returnContext }, committedResult: { paymentId: 104 } }),
  '/finance/students/22/annual/payments/104/confirmation?backSearch=Villanueva+Santos&backSchoolYear=2026-2027&backTermId=41&backStatus=enrolled&backPage=2');
  assert.equal(actions.afterCommitPath({ actionType: 'annual_payment',
    entityContext: { studentId: 22, financeUiReturnContext: { returnTo: 'https://example.invalid/' } }, committedResult: { paymentId: 104 } }),
  '/finance/students/22/annual/payments/104/confirmation', 'unknown return destinations cannot create external redirects');
});

test('payment review drafts require a positive amount before preview or persistence', async () => {
  const invalidAmounts = ['', '0', '0.00', '-1.00', '1.001', '10000000000.00'];
  for (const amount of invalidAmounts) {
    assert.throws(() => validatePositivePaymentAmount('annual_payment', { amount }), FinanceReviewDraftError);
  }
  assert.doesNotThrow(() => validatePositivePaymentAmount('annual_payment', { amount: '20.05' }));
  assert.doesNotThrow(() => validatePositivePaymentAmount('annual_adjustment', { amount: '-20.05' }),
    'school-policy-dependent adjustment signs remain outside payment validation');

  const binding = 'b'.repeat(64);
  const draftId = '41111111-1111-4111-8111-111111111111';
  let poolCalls = 0;
  let createCalls = 0;
  let updateCalls = 0;
  const existing = { id: draftId, actionType: 'annual_payment', status: 'pending', entityContext: { studentId: 22 }, input: { amount: '20.00' } };
  const actions = createFinanceReviewActionService({
    getPool: async () => { poolCalls += 1; throw new Error('invalid amounts must fail before database preview'); },
    draftService: {
      async createDraft() { createCalls += 1; return { id: draftId }; },
      async getDraft() { return structuredClone(existing); },
      async updateDraftInput() { updateCalls += 1; }
    }
  });
  for (const amount of invalidAmounts) {
    await assert.rejects(actions.startDraft(7, binding, '/students/22/annual/payments', { amount, paymentDate: '2026-10-01' }),
      (error) => error instanceof FinanceReviewDraftError && /positive payment amount/.test(error.message));
    await assert.rejects(actions.updateDraft(7, binding, draftId, { amount }),
      (error) => error instanceof FinanceReviewDraftError && /positive payment amount/.test(error.message));
  }
  assert.equal(poolCalls, 0);
  assert.equal(createCalls, 0, 'an invalid new payment is not inserted as a review draft');
  assert.equal(updateCalls, 0, 'an invalid edit is not saved over the existing draft');

  const statements = [];
  let rolledBack = false;
  const draftStore = createFinanceReviewDraftService({
    getPool: async () => ({}),
    sql: { Int: 'Int', MAX: 'MAX', ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }, Char: () => 'Char', VarChar: () => 'VarChar', NVarChar: () => 'NVarChar' },
    transactionFactory: () => ({
      async begin() {},
      request() {
        return { input() { return this; }, async query(statement) {
          statements.push(statement);
          if (statement.includes('SELECT id, action_type, revision, status')) {
            return { recordset: [{ id: draftId, action_type: 'annual_payment', revision: 1, status: 'pending' }] };
          }
          if (statement.includes('FROM users')) return { recordset: [{ id: 7, role: 'finance' }] };
          if (statement.includes('COUNT(*) AS pending_count')) return { recordset: [{ pending_count: 0 }] };
          return { recordset: [] };
        } };
      },
      async commit() {},
      async rollback() { rolledBack = true; }
    })
  });
  const review = { dependencyFingerprint: 'a'.repeat(64), preview: {} };
  await assert.rejects(draftStore.createDraft(7, binding, 'annual_payment', { studentId: 22 }, { amount: '-2.00' }, review),
    (error) => error instanceof FinanceReviewDraftError && /positive payment amount/.test(error.message));
  await assert.rejects(draftStore.updateDraftInput(7, draftId, binding, { amount: '0.00' }, review),
    (error) => error instanceof FinanceReviewDraftError && /positive payment amount/.test(error.message));
  assert.equal(rolledBack, true);
  assert.ok(!statements.some((statement) => /INSERT INTO finance_review_drafts|UPDATE finance_review_drafts/.test(statement)),
    'the persistence boundary never inserts or updates an invalid payment draft');
  await draftStore.createDraft(7, binding, 'annual_payment', { studentId: 22 }, { amount: '20.05' }, review);
  await draftStore.updateDraftInput(7, draftId, binding, { amount: '20.05' }, review);
  assert.ok(statements.some((statement) => /INSERT INTO finance_review_drafts/.test(statement)),
    'a valid positive payment draft can still be created');
  assert.ok(statements.some((statement) => /UPDATE finance_review_drafts/.test(statement)),
    'a valid positive payment draft can still be edited');
});

test('money parsing and financial transaction fields enforce DECIMAL(12,2) limits and signs', () => {
  assert.equal(parseMoneyCents('9999999999.99'), 999999999999n);
  assert.equal(parseMoneyCents('-0.01', { allowNegative: true }), -1n);
  assert.equal(formatMoneyCents(-1n), '-0.01');
  assert.deepEqual(validateTransaction({ transactionType: 'charge', amount: '12.3' }), {
    transactionType: 'charge', amountCents: 1230n, amount: '12.30', description: null, referenceNo: null,
    clearEnrollmentId: null, confirmEnrollmentClearance: false
  });
  assert.deepEqual(validateTransaction({ transactionType: 'adjustment', amount: '-2.50', description: 'Correction' }), {
    transactionType: 'adjustment', amountCents: -250n, amount: '-2.50', description: 'Correction', referenceNo: null,
    clearEnrollmentId: null, confirmEnrollmentClearance: false
  });
  assert.throws(() => validateTransaction({ transactionType: 'charge', amount: '-1' }), FinanceServiceError);
  assert.throws(() => validateTransaction({ transactionType: 'payment', amount: '0' }), /must not be zero/);
  assert.throws(() => validateTransaction({ transactionType: 'adjustment', amount: '0.00', description: 'Correction' }), /must not be zero/);
  assert.throws(() => validateTransaction({ transactionType: 'adjustment', amount: '1.00' }), /reason for the balance adjustment/);
  assert.throws(() => validateTransaction({ transactionType: 'adjustment', amount: '1.00', description: 'x'.repeat(501) }), /Description must be/);
  assert.throws(() => validateTransaction({ transactionType: 'charge', amount: '10000000000.00' }), /10 whole digits/);
  assert.throws(() => validateTransaction({ transactionType: 'charge', amount: '1.001' }), /10 whole digits/);
  assert.throws(() => validateTransaction({ transactionType: 'unknown', amount: '1.00' }), /Choose a charge/);
  assert.throws(() => validateTransaction({ transactionType: 'charge', amount: '1.00', referenceNo: 'x'.repeat(101) }), /Reference number must be/);
});

test('student ledger lookup is linked to the authenticated student and hides other accounts', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('FROM users AS user_account')) {
            return { recordset: [{ student_id: 22, student_no: 'SHS-2026-0001', first_name: 'Alyssa', last_name: 'Reyes', financial_account_id: 31, balance: '240.00' }] };
          }
          if (statement.includes('FROM financial_transactions AS transaction_record')) {
            return { recordset: [{ id: 90, transaction_type: 'payment', amount: '60.00', description: 'Tuition payment' }] };
          }
          throw new Error(`Unexpected student ledger query: ${statement}`);
        }
      };
    }
  };
  const service = createFinanceService({ getPool: async () => pool, sql: fakeSql() });
  const result = await service.getOwnStudentAccount('7');

  assert.equal(result.student.id, 22);
  assert.deepEqual(result.account, { id: 31, balance: '240.00' });
  assert.equal(result.transactions[0].id, 90);
  assert.equal(calls[0].values.userId, 7);
  assert.match(calls[0].statement, /student\.user_id = user_account\.id/);
  assert.match(calls[0].statement, /user_account\.role = 'student'/);
  assert.deepEqual({ accountId: calls[1].values.accountId, studentId: calls[1].values.studentId }, { accountId: 31, studentId: 22 });
  assert.match(calls[1].statement, /account\.student_id = @studentId/);
  assert.doesNotMatch(calls[0].statement, /@studentId/);
});

test('student ledger lookup rejects an inactive or non-student account before reading transactions', async () => {
  const calls = [];
  const pool = {
    request() {
      return {
        input() { return this; },
        async query(statement) { calls.push(statement); return { recordset: [] }; }
      };
    }
  };
  const service = createFinanceService({ getPool: async () => pool, sql: fakeSql() });
  await assert.rejects(service.getOwnStudentAccount(7), (error) => error instanceof FinanceServiceError && error.status === 403);
  assert.equal(calls.length, 1);
});

test('finance student search is parameterized, escaped, bounded, and limited to finance identifiers', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) { calls.push({ statement, values: { ...values } }); return { recordset: [{ student_id: 22, student_no: 'S-22' }] }; }
      };
    }
  };
  const service = createFinanceService({ getPool: async () => pool, sql: fakeSql() });
  assert.deepEqual(await service.searchStudents(' S_%[1]~ '), { students: [{ student_id: 22, student_no: 'S-22' }], searchTerm: 'S_%[1]~' });
  assert.equal(calls[0].values.searchPattern, '%S~_~%~[1~]~~%');
  assert.match(calls[0].statement, /LIMIT 100/);
  assert.doesNotMatch(calls[0].statement, /\bFROM enrollments|\bJOIN enrollments|grades|birth_date|address/);
  assert.deepEqual(await service.searchStudents(''), { students: [], searchTerm: '' });
  assert.equal(calls.length, 1, 'empty search should not enumerate student accounts');
  await assert.rejects(service.searchStudents('x'.repeat(101)), /100 printable characters or fewer/);
});

test('recent finance accounts are limited, ordered, finance-authorized, and expose only account identifiers', async () => {
  const calls = [];
  let authorized = true;
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('SELECT id FROM users')) {
            return { recordset: authorized ? [{ id: 7 }] : [] };
          }
          return { recordset: [{ student_id: 22, student_no: 'DEMO-001', balance: '850.00' }] };
        }
      };
    }
  };
  const service = createFinanceService({ getPool: async () => pool, sql: fakeSql() });
  assert.deepEqual(await service.listRecentAccounts(7), [{ student_id: 22, student_no: 'DEMO-001', balance: '850.00' }]);
  assert.equal(calls[0].values.actorId, 7);
  assert.match(calls[0].statement, /role IN \('finance', 'database_admin'\).*is_active = 1|is_active = 1 AND role IN \('finance', 'database_admin'\)/s);
  assert.match(calls[1].statement, /LIMIT 8/);
  assert.match(calls[1].statement, /ORDER BY a\.updated_at DESC, a\.id DESC/);
  assert.match(calls[1].statement, /WHERE EXISTS/);
  assert.doesNotMatch(calls[1].statement, /grades|\bFROM enrollments|\bJOIN enrollments|documents|birth_date|address/);
  assert.match(calls[1].statement, /NOT EXISTS \(SELECT 1 FROM annual_enrollments/);

  authorized = false;
  calls.length = 0;
  await assert.rejects(service.listRecentAccounts(7), /finance access is no longer active/i);
  assert.equal(calls.length, 1);
});

test('account and transaction history read paths return only the selected student finance record', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('FROM students')) return { recordset: [{ student_id: 22, student_no: 'S-22', first_name: 'Alex', last_name: 'Kim', status: 'archived' }] };
          if (statement.includes('FROM enrollments AS enrollment')) return { recordset: [] };
          if (statement.includes('FROM financial_accounts')) return { recordset: [{ financial_account_id: 30, balance: '-2.50' }] };
          if (statement.includes('FROM financial_transactions AS payment')) return { recordset: [{ transaction_id: 91, transaction_type: 'payment', amount: '5.00' }] };
          if (statement.includes('FROM financial_transactions')) return { recordset: [{ id: 90, transaction_type: 'adjustment', amount: '-2.50' }] };
          throw new Error(`Unexpected query: ${statement}`);
        }
      };
    }
  };
  const service = createFinanceService({ getPool: async () => pool, sql: fakeSql() });
  const record = await service.getStudentAccount('22');
  assert.equal(record.student.student_no, 'S-22');
  assert.equal(record.student.status, 'archived');
  assert.equal(record.account.balance, '-2.50');
  assert.equal(record.transactions[0].transaction_type, 'adjustment');
  assert.equal(record.availableEnrollmentPayments[0].transaction_id, 91);
  assert.deepEqual(calls.map(({ values }) => Object.values(values)), [[22], [22], [22], [30], [30]]);
  assert.match(calls[0].statement, /student_no, first_name, middle_name, last_name, suffix, status/);
  assert.match(calls.at(-1).statement, /NOT EXISTS[\s\S]*payment_transaction_id = payment\.id/);
  assert.doesNotMatch(calls.map(({ statement }) => statement).join('\n'), /grade|document|birth_date|address/);
  await assert.rejects(service.getStudentAccount('../22'), /not found/);
});

test('account creation is finance-checked, student-owned, serializable, and audited atomically', async () => {
  const { service, log } = transactionFixture();
  const accountId = await service.createAccount(7, '22');
  assert.equal(accountId, 30);
  assert.equal(log.isolation, 'SERIALIZABLE');
  assert.equal(log.committed, true);
  const studentLock = log.queries.find(({ statement }) => statement.includes('FROM students'));
  assert.match(studentLock.statement, /FOR UPDATE/);
  assert.equal(studentLock.values.studentId, 22);
  const insert = log.queries.find(({ statement }) => statement.includes('INSERT INTO financial_accounts'));
  assert.equal(insert.values.studentId, 22);
  const audit = log.queries.find(({ statement }) => statement.includes('INSERT INTO audit_logs'));
  assert.equal(audit.values.action, 'finance.account_created');
  assert.equal(JSON.parse(audit.values.detailsJson).studentId, 22);
});

test('registrar actors cannot write finance data while database administrators can', async () => {
  const deniedAccount = transactionFixture({ actorRole: 'registrar' });
  await assert.rejects(deniedAccount.service.createAccount(7, '22'), /finance access is no longer active/i);
  assert.equal(deniedAccount.log.rolledBack, true);
  assert.equal(deniedAccount.log.queries.some(({ statement }) => statement.includes('INSERT INTO financial_accounts')), false);
  assert.equal(deniedAccount.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);

  const adminTransaction = transactionFixture({ actorRole: 'database_admin' });
  await adminTransaction.service.recordTransaction(7, '22', { transactionType: 'charge', amount: '1.00' });
  assert.equal(adminTransaction.log.committed, true);
  assert.equal(adminTransaction.log.queries.at(-1).values.action, 'database_admin.finance_transaction_recorded');
});

test('account creation rejects missing students and existing accounts without writes', async () => {
  const missingStudent = transactionFixture({ studentExists: false });
  await assert.rejects(missingStudent.service.createAccount(7, '22'), /Student record not found/);
  assert.equal(missingStudent.log.rolledBack, true);
  assert.equal(missingStudent.log.queries.some(({ statement }) => statement.includes('INSERT INTO financial_accounts')), false);

  const existing = transactionFixture({ accountExists: true });
  await assert.rejects(existing.service.createAccount(7, '22'), /already has a financial account/);
  assert.equal(existing.log.rolledBack, true);
  assert.equal(existing.log.queries.some(({ statement }) => statement.includes('INSERT INTO financial_accounts')), false);
});

test('archived students cannot receive new finance accounts or ledger entries', async () => {
  const archivedAccount = transactionFixture({ studentStatus: 'archived' });
  await assert.rejects(archivedAccount.service.createAccount(7, '22'), /Archived students cannot receive new finance records/);
  assert.equal(archivedAccount.log.rolledBack, true);
  const studentRead = archivedAccount.log.queries.find(({ statement }) => statement.includes('FROM students'));
  assert.match(studentRead.statement, /SELECT id, status/);
  assert.match(studentRead.statement, /FOR UPDATE/);
  assert.equal(archivedAccount.log.queries.some(({ statement }) => statement.includes('INSERT INTO financial_accounts')), false);
  assert.equal(archivedAccount.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);

  const archivedLedger = transactionFixture({ studentStatus: 'archived' });
  await assert.rejects(archivedLedger.service.recordTransaction(7, '22', { transactionType: 'charge', amount: '1.00' }), /Archived students cannot receive new finance records/);
  assert.equal(archivedLedger.log.rolledBack, true);
  const accountRead = archivedLedger.log.queries.find(({ statement }) => statement.includes('FROM financial_accounts AS a'));
  assert.equal(accountRead, undefined, 'the student lock rejects archived records before any finance account reads');
  assert.equal(archivedLedger.log.queries.some(({ statement }) => statement.includes('UPDATE financial_accounts')), false);
  assert.equal(archivedLedger.log.queries.some(({ statement }) => statement.includes('INSERT INTO financial_transactions')), false);
  assert.equal(archivedLedger.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
});

test('legacy opening liability locks out raw legacy transactions and clearance under the account lock', async () => {
  const transaction = transactionFixture({ openingLiabilityExists: true });
  await assert.rejects(transaction.service.recordTransaction(7, 22, { transactionType: 'payment', amount: '1.00' }), /reviewed opening liability.*annual finance workspace/i);
  assert.equal(transaction.log.rolledBack, true);
  assert.equal(transaction.log.queries.some(({ statement }) => statement.includes('UPDATE financial_accounts')), false);
  assert.equal(transaction.log.queries.some(({ statement }) => statement.includes('INSERT INTO financial_transactions')), false);
  const openingLock = transaction.log.queries.find(({ statement }) => statement.includes('FROM finance_legacy_opening_charges'));
  assert.deepEqual(openingLock.values, { accountId: 30 });
  assert.match(openingLock.statement, /FOR UPDATE/);

  const clearance = transactionFixture({ openingLiabilityExists: true });
  await assert.rejects(clearance.service.clearEnrollmentWithExistingPayment(7, 22, 51, 91, true), /reviewed opening liability.*annual finance workflow/i);
  assert.equal(clearance.log.rolledBack, true);
  assert.equal(clearance.log.queries.some(({ statement }) => statement.includes('UPDATE enrollment_clearances')), false);
});

test('charges, payments, and signed adjustments update balance in the correct direction', async () => {
  const entries = [
    [{ transactionType: 'charge', amount: '5.00' }, '15.00'],
    [{ transactionType: 'payment', amount: '7.00' }, '3.00'],
    [{ transactionType: 'adjustment', amount: '-12.50', description: 'Credit correction' }, '-2.50']
  ];
  for (const [input, expectedBalance] of entries) {
    const fixture = transactionFixture();
    const result = await fixture.service.recordTransaction(7, '22', input);
    assert.equal(result.balance, expectedBalance);
    assert.equal(fixture.getBalance(), expectedBalance);
    const accountLookup = fixture.log.queries.find(({ statement }) => statement.includes('FROM financial_accounts AS a'));
    assert.match(accountLookup.statement, /a\.student_id/);
    assert.equal(accountLookup.values.studentId, 22);
    const update = fixture.log.queries.find(({ statement }) => statement.includes('UPDATE financial_accounts'));
    assert.equal(update.values.balance, expectedBalance);
    const insert = fixture.log.queries.find(({ statement }) => statement.includes('INSERT INTO financial_transactions'));
    assert.equal(insert.values.amount, input.amount === '7.00' ? '7.00' : input.amount);
    assert.equal(fixture.log.queries.at(-1).values.action, 'finance.transaction_recorded');
    assert.equal(fixture.log.committed, true);
  }
});

test('duplicate references are rejected for the owned account before balance, transaction, or audit writes', async () => {
  const fixture = transactionFixture({ duplicate: true });
  await assert.rejects(fixture.service.recordTransaction(7, '22', {
    transactionType: 'charge', amount: '5.00', referenceNo: 'REF-7'
  }), /already used for this account/);
  const duplicate = fixture.log.queries.find(({ statement }) => statement.includes('FROM financial_transactions'));
  assert.deepEqual(duplicate.values, { accountId: 30, referenceNo: 'REF-7' });
  assert.match(duplicate.statement, /financial_account_id = @accountId AND reference_no = @referenceNo/);
  assert.equal(fixture.log.rolledBack, true);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('UPDATE financial_accounts')), false);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO financial_transactions')), false);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
});

test('transactions require an existing account and reject balance overflow before updates', async () => {
  const absent = transactionFixture({ balance: '10.00', transactionAccountExists: false });
  await assert.rejects(absent.service.recordTransaction(7, '22', { transactionType: 'payment', amount: '1.00' }), /account not found/);
  assert.equal(absent.log.rolledBack, true);

  const overflow = transactionFixture({ balance: '9999999999.99' });
  await assert.rejects(overflow.service.recordTransaction(7, '22', { transactionType: 'charge', amount: '0.01' }), /exceed the supported balance limit/);
  assert.equal(overflow.log.rolledBack, true);
  assert.equal(overflow.log.queries.some(({ statement }) => statement.includes('UPDATE financial_accounts')), false);
});

test('a transaction insert or audit failure rolls back the balance update and transaction as one unit', async () => {
  for (const failAt of ['transaction_insert', 'audit']) {
    const fixture = transactionFixture({ failAt });
    await assert.rejects(fixture.service.recordTransaction(7, '22', {
      transactionType: 'charge', amount: '2.00', referenceNo: 'REF-1'
    }), /simulated/);
    assert.equal(fixture.log.rolledBack, true);
    assert.equal(fixture.log.committed, false);
    assert.ok(fixture.log.queries.some(({ statement }) => statement.includes('UPDATE financial_accounts')));
    if (failAt === 'audit') assert.ok(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO financial_transactions')));
  }
});

test('finance can assign one unused payment from the same student account to a specific pending enrollment', async () => {
  const fixture = transactionFixture();
  const result = await fixture.service.clearEnrollmentWithExistingPayment(7, '22', '51', '91', '1');
  assert.deepEqual(result, { enrollmentId: 51, paymentTransactionId: 91 });
  assert.equal(fixture.log.isolation, 'SERIALIZABLE');
  assert.equal(fixture.log.committed, true);
  const enrollmentLock = fixture.log.queries.find(({ statement }) => statement.includes('FROM enrollments AS enrollment'));
  assert.deepEqual(enrollmentLock.values, { enrollmentId: 51, studentId: 22 });
  assert.match(enrollmentLock.statement, /enrollment_status, enrollment\.finalized_at/);
  const paymentLock = fixture.log.queries.find(({ statement }) => statement.includes('FROM financial_transactions AS payment'));
  assert.deepEqual(paymentLock.values, { paymentTransactionId: 91, accountId: 30 });
  assert.match(paymentLock.statement, /transaction_type = 'payment'/);
  assert.match(paymentLock.statement, /NOT EXISTS[\s\S]*payment_transaction_id = payment\.id/);
  const update = fixture.log.queries.find(({ statement }) => statement.includes('UPDATE enrollment_clearances'));
  assert.deepEqual(update.values, { enrollmentId: 51, transactionId: 91, actorId: 7 });
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('UPDATE financial_accounts')), false);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO financial_transactions')), false);
  const audit = fixture.log.queries.find(({ statement }) => statement.includes('INSERT INTO audit_logs'));
  assert.equal(audit.values.action, 'finance.enrollment_clearance_updated');
  assert.deepEqual(JSON.parse(audit.values.detailsJson), {
    enrollmentId: 51, paymentTransactionId: 91, existingPayment: true, financeConfirmedEligibility: true
  });
});

test('existing-payment clearance requires explicit finance attestation and rejects used or stale records', async () => {
  const unattested = transactionFixture();
  await assert.rejects(unattested.service.clearEnrollmentWithExistingPayment(7, 22, 51, 91, false), /must confirm/);
  assert.equal(unattested.log.queries.length, 0);

  for (const fixture of [
    transactionFixture({ paymentAvailable: false }),
    transactionFixture({ enrollmentClearanceStatus: 'cleared', enrollmentPaymentTransactionId: 89 }),
    transactionFixture({ enrollmentStatus: 'enrolled' }),
    transactionFixture({ clearanceUpdateRows: 0 })
  ]) {
    await assert.rejects(fixture.service.clearEnrollmentWithExistingPayment(7, 22, 51, 91, true), /unused recorded payment|uncleared pending enrollment|another finance action/);
    assert.equal(fixture.log.rolledBack, true);
    assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO audit_logs')), false);
  }
});

function makeAuthPool(role) {
  const user = {
    id: 7,
    email: `${role}@example.edu`,
    password_hash: bcrypt.hashSync('Correct-Horse-Battery-12', 4),
    role,
    is_active: true,
    updated_at_fingerprint: ''
  };
  return async () => ({
    request() {
      return {
        input() { return this; },
        async query(statement) {
          if (statement.includes('WHERE email = @email')) return { recordset: [user] };
          if (statement.includes('WHERE id = @userId')) return { recordset: [{ ...user }] };
          throw new Error(`Unexpected authentication query: ${statement}`);
        }
      };
    }
  });
}

const environment = {
  nodeEnv: 'development',
  devPasswordOnlyLogin: true,
  sessionSecret: 'phase-seven-finance-test-session-secret'
};

function cookieFrom(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function signIn(baseUrl, role) {
  const page = await fetch(`${baseUrl}/login`);
  const cookie = cookieFrom(page);
  const token = csrfFrom(await page.text());
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, email: `${role}@example.edu`, password: 'Correct-Horse-Battery-12' })
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

test('annual finance correction routes stay student-bound, CSRF-protected, and reachable from the account workflow', async () => {
  const calls = [];
  const studentId = 22;
  const annualFinanceService = {
    async listRoster() { return { rows: [], options: { schoolYears: [], terms: [], sections: [] } }; },
    async getStudentLedger() {
      return {
        student: { id: studentId, student_no: 'SYNTH-22', first_name: 'Synthetic', middle_name: null, last_name: 'Student', suffix: null, status: 'active' },
        summary: { annualBalanceSchoolYear: null, annualBalance: '0.00', allYearsAnnualBalance: '0.00', annualWaivedAmount: '0.00', unattributedLegacyBalance: '100.00', openingLiabilityDue: '0.00', totalBalance: '100.00', currentTermOutstanding: '0.00', priorTermYearDebt: '0.00', availableCredit: '0.00' },
        terms: [], events: [{ event_type: 'payment', source_id: 104, event_date: new Date('2026-10-01T05:00:00Z'), amount: '20.00', reference_no: 'RECOVER-104' }],
        charges: [], availablePayments: [], openingLiabilities: [], allocationHistory: [],
        legacyReconciliationHistory: [], payments: [], legacyCredits: [], privateClearances: [], adjustments: []
      };
    },
    async recordPayment(...args) { calls.push(['recordPayment', ...args]); return { paymentId: 104 }; },
    async listSchedules() { return []; },
    async releasePaymentAllocation(...args) { calls.push(['releaseAllocation', ...args]); return {}; },
    async releaseLegacyReconciliation(...args) { calls.push(['releaseLegacyReconciliation', ...args]); return {}; },
    async updatePaymentMetadata(...args) { calls.push(['paymentMetadata', ...args]); return {}; },
    async previewLegacyOpeningLiability(...args) { calls.push(['openingPreview', ...args]); return { financialAccountId: 30, remainingBalance: '100.00', alreadyTransferred: false, activeReconciliationCount: 0 }; },
    async transferLegacyOpeningLiability(...args) { calls.push(['openingTransfer', ...args]); return {}; }
  };
  const financeService = {
    async searchStudents() { return { students: [], searchTerm: '' }; },
    async getDashboardSummary() { return {}; },
    async listRecentAccounts() { return []; },
    async getStudentAccount(id) { return { student: { student_id: id, student_no: 'SYNTH-22', first_name: 'Synthetic', last_name: 'Student', status: 'active' }, account: null, transactions: [] }; }
  };
  const financeCasesService = {
    async getStudentCases() { return { specialSubjects: [], exemptions: [], departures: [] }; },
    async approveExemptionCase(actorId, annualId, input) {
      calls.push(['approveExemption', actorId, annualId, input]);
      assert.equal(input.expectedStudentId, studentId);
      return { studentId };
    }
  };
  const idempotencyKey = '41111111-1111-4111-8111-111111111111';
  const reviewProbe = createReviewRouteProbe();
  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, financeService, annualFinanceService, financeCasesService, financeReviewActionService: reviewProbe }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const account = await fetch(`${baseUrl}/finance/students/${studentId}/annual`, { headers: { cookie } });
    const accountHtml = await account.text();
    const csrfToken = csrfFrom(accountHtml);
    assert.match(accountHtml, /name="transmittalReference"/);
    assert.match(accountHtml, /name="privateRemarks"/);
    assert.match(accountHtml, /name="allocationTarget"/);
    const post = async (path, fields) => fetch(`${baseUrl}${path}`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, ...fields })
    });
    const reviewed = async (path, fields) => {
      const response = await post(path, fields);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/finance/review-drafts/41111111-1111-4111-8111-111111111111');
    };
    await reviewed(`/finance/students/${studentId}/annual/allocations/101/release`, { amount: '5.00', reason: 'Correction', idempotencyKey });
    await reviewed(`/finance/students/${studentId}/annual/legacy-reconciliations/102/release`, { amount: '5.00', reason: 'Correction', idempotencyKey });
    await reviewed(`/finance/students/${studentId}/annual/payments/103/metadata`, { eventType: 'receipt_reference_updated', referenceNo: 'DELAYED-103', idempotencyKey });
    await reviewed(`/finance/students/${studentId}/annual/payments`, {
      amount: '20.00', paymentDate: '2026-10-01', referenceNo: 'RECEIPT-104', transmittalReference: 'TRANSMIT-104',
      privateRemarks: 'Finance-only starting note.', receiptIssued: '0', idempotencyKey
    });
    const preview = await post(`/finance/students/${studentId}/annual/legacy-opening/preview`, {});
    assert.equal(preview.status, 200);
    const previewHtml = await preview.text();
    assert.match(previewHtml, /Confirm previous balance/);
    assert.match(previewHtml, /name="expectedAmount" value="100\.00"/);
    await reviewed(`/finance/students/${studentId}/annual/legacy-opening/transfer`, { expectedAmount: '100.00', sourceLabel: 'Reviewed account', reason: 'Reviewed statement', idempotencyKey });
    await reviewed(`/finance/students/${studentId}/annual/23/exemptions`, { reason: 'Approved', idempotencyKey, ruleTerm: '1', ruleCategory: 'tuition', ruleAmount: '50.00' });
    const csrfDenied = await fetch(`${baseUrl}/finance/students/${studentId}/annual/allocations/101/release`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'amount=5.00'
    });
    assert.equal(csrfDenied.status, 403);
  });
  assert.deepEqual(calls.map(([name]) => name), ['openingPreview'], 'only the registered read-only preview bypasses reviewed writes');
  assert.equal(reviewProbe.starts.length, 6);
  assert.ok(reviewProbe.starts.every((entry) => entry.actorId === 7));
  assert.ok(reviewProbe.starts.some((entry) => entry.pathname === `/students/${studentId}/annual/payments`));
  assert.equal(reviewProbe.starts.find((entry) => entry.pathname.endsWith('/payments')).input.transmittalReference, 'TRANSMIT-104');

  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, financeService, annualFinanceService, financeCasesService, financeReviewActionService: reviewProbe }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const account = await fetch(`${baseUrl}/finance/students/${studentId}/annual`, { headers: { cookie } });
    const accountHtml = await account.text();
    const csrfToken = csrfFrom(accountHtml);
    reviewProbe.startDraft = async () => { throw new AnnualFinanceError('Enter a valid amount before review.'); };
    const payment = await fetch(`${baseUrl}/finance/students/${studentId}/annual/payments`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, amount: '20.00', paymentDate: '2026-10-01', referenceNo: 'RECOVER-104',
        transmittalReference: 'TRANSMIT-KEEP', privateRemarks: 'Keep this staff note.', receiptIssued: '1',
        allocationTarget: 'charge:91', allocationAmount: '15.00' })
    });
    const paymentHtml = await payment.text();
    assert.equal(payment.status, 400);
    assert.match(paymentHtml, /data-account-view="payments"/);
    assert.match(paymentHtml, /<details class="finance-payment-optional-details" open>/,
      'a rejected payment opens optional details so the payment panel and recovered values stay visible');
    assert.match(paymentHtml, /name="amount"[^>]*value="20\.00"/);
    assert.match(paymentHtml, /value="RECOVER-104"/);
    assert.match(paymentHtml, /value="TRANSMIT-KEEP"/);
    assert.match(paymentHtml, /Keep this staff note\./);
    assert.match(paymentHtml, /value="15\.00"/);

    reviewProbe.startDraft = async () => { throw new FinanceReviewDraftError('Enter a positive payment amount with up to 10 whole digits and 2 decimal places.'); };
    const invalidPayment = await fetch(`${baseUrl}/finance/students/${studentId}/annual/payments`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, amount: '-12.50', paymentDate: '2026-10-01', referenceNo: 'KEEP-INVALID', receiptIssued: '0' })
    });
    const invalidPaymentHtml = await invalidPayment.text();
    assert.equal(invalidPayment.status, 400);
    assert.match(invalidPaymentHtml, /Enter a positive payment amount/);
    assert.match(invalidPaymentHtml, /name="amount"[^>]*value="-12\.50"/,
      'the recoverable payment form keeps the value for correction without saving an invalid draft');
    assert.match(invalidPaymentHtml, /value="KEEP-INVALID"/);

    reviewProbe.startDraft = async () => { throw new FinanceReviewDraftError('Five saved finance reviews are already open.', 409); };
    const scheduleFields = new URLSearchParams({ _csrf: csrfToken, schoolYear: '2027-2028', gradeLevel: 'Grade 11', voucherCode: 'ESC',
      idempotencyKey, termNumber: '1', feeCategory: 'tuition', lineName: 'Tuition', installment: 'DP', lineAmount: '125.50' });
    const schedule = await fetch(`${baseUrl}/finance/schedules`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: scheduleFields
    });
    const scheduleHtml = await schedule.text();
    assert.equal(schedule.status, 409);
    assert.match(scheduleHtml, /Five saved finance reviews are already open\./);
    assert.match(scheduleHtml, /name="schoolYear" value="2027-2028"/);
    assert.match(scheduleHtml, /name="gradeLevel" value="Grade 11"/);
    assert.match(scheduleHtml, /name="voucherCode" value="ESC"/);
    assert.match(scheduleHtml, /name="lineAmount"[^>]*value="125\.50"/);

    reviewProbe.startDraft = async () => { throw new AnnualFinanceError('Enter a reversal reason.'); };
    const reversal = await fetch(`${baseUrl}/finance/students/${studentId}/annual/payments/104/reverse`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, reason: 'Duplicate entry' })
    });
    const reversalHtml = await reversal.text();
    assert.equal(reversal.status, 400);
    assert.match(reversalHtml, /data-account-view="history"/);
    assert.match(reversalHtml, /class="physical-requirements-item" open><summary>.*Payment #104/);
    assert.match(reversalHtml, /name="reason"[^>]*>Duplicate entry<\/textarea>/);
    assert.match(reversalHtml, /action="\/finance\/students\/22\/annual\/payments\/104\/reverse"/);
  });
});

test('a pending review stays editable and discardable when current-target validation fails', async () => {
  const draftId = '41111111-1111-4111-8111-111111111111';
  const draft = {
    id: draftId, actionType: 'annual_payment', status: 'pending', revision: 3,
    dependencyFingerprint: 'a'.repeat(64), sessionBindingHmac: 'b'.repeat(64),
    entityContext: { studentId: 22 }, input: { amount: '20.00', paymentDate: '2026-10-04', allocations: [{ chargeId: '7', amount: '20.00' }] },
    preview: { student: { name: 'Synthetic Student', studentNumber: 'SYNTH-22' }, fields: [{ name: 'amount', value: '20.00' }],
      cashAmount: '20.00', appliedAmount: '20.00', unallocatedCredit: '0.00', allocationRows: [], targetDetails: [] }
  };
  const reviewActions = {
    matchesMutation: () => false, isReadOnlyPost: () => false,
    actionLabel: () => 'Record payment and allocations', afterCommitPath: () => '/finance',
    async freshReview() { throw new AnnualFinanceError('A selected balance is no longer available. Edit the allocation.', 409); },
    async getDraft(actorId, requestedDraftId) { assert.equal(actorId, 7); assert.equal(requestedDraftId, draftId); return structuredClone(draft); }
  };
  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, financeReviewActionService: reviewActions }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const response = await fetch(`${baseUrl}/finance/review-drafts/${draftId}`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 409);
    assert.match(html, /The pending draft is retained/);
    assert.match(html, /Edit saved details/);
    assert.match(html, /Discard unfinished review/);
    assert.match(html, /name="item_allocations_0_amount" value="20\.00"/);
    assert.match(html, /<button[^>]*disabled[^>]*>Review complete · Save update<\/button>/);
    assert.doesNotMatch(html, /Service Unavailable/);
  });
});

test('finance routes retire legacy account entry and preserve annual account access for finance staff', async () => {
  const calls = [];
  const annualFinanceService = {
    async listRoster(actorId, filters) { calls.push(['annualRoster', actorId, filters]); return { rows: [], options: { schoolYears: [], terms: [], sections: [] } }; },
    async getStudentLedger() { return { terms: [] }; }
  };
  const reviewProbe = createReviewRouteProbe();
  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, annualFinanceService, financeReviewActionService: reviewProbe }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const redirect = await fetch(`${baseUrl}/dashboard`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(redirect.headers.get('location'), '/finance/overview');
    const workspace = await fetch(`${baseUrl}/finance`, { headers: { cookie } });
    assert.equal(workspace.status, 200);
    const workspaceHtml = await workspace.text();
    assert.match(workspaceHtml, /Student accounts/);
    assert.ok(calls.some(([name]) => name === 'annualRoster'));

    const legacyWorkspace = await fetch(`${baseUrl}/finance/legacy`, { headers: { cookie }, redirect: 'manual' });
    const legacyHtml = await legacyWorkspace.text();
    assert.equal(legacyWorkspace.status, 410);
    assert.match(legacyHtml, /workspace has been retired/i);

    const oldAccount = await fetch(`${baseUrl}/finance/students/22`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(oldAccount.status, 303);
    assert.equal(oldAccount.headers.get('location'), '/finance/students/22/annual');

    for (const path of ['/finance/students/22/account', '/finance/students/22/transactions', '/finance/students/22/enrollment-clearance']) {
      const retiredPost = await fetch(`${baseUrl}${path}`, {
        method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: ''
      });
      assert.equal(retiredPost.status, 410, `${path} must be unavailable even without a valid CSRF token`);
    }
    assert.deepEqual(calls.map(([name]) => name), ['annualRoster']);
  });

  const serviceCallsBeforeDeniedRequests = calls.length;
  for (const role of ['student', 'registrar']) {
    const app = createApp({ databasePool: makeAuthPool(role), environment, annualFinanceService });
    await withServer(app, async (baseUrl) => {
      const cookie = await signIn(baseUrl, role);
      const response = await fetch(`${baseUrl}/finance`, { headers: { cookie }, redirect: 'manual' });
      assert.equal(response.status, 403, `${role} must be denied finance access`);
      const write = await fetch(`${baseUrl}/finance/students/22/transactions`, {
        method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: ''
      });
      assert.equal(write.status, 403, `${role} must be denied finance writes`);
    });
  }
  const adminReviewProbe = createReviewRouteProbe();
  await withServer(createApp({ databasePool: makeAuthPool('database_admin'), environment, annualFinanceService, financeReviewActionService: adminReviewProbe }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin');
    const accountPage = await fetch(`${baseUrl}/finance/students/22`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(accountPage.status, 303);
    assert.equal(accountPage.headers.get('location'), '/finance/students/22/annual');
    const response = await fetch(`${baseUrl}/finance/students/22/account`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: ''
    });
    assert.equal(response.status, 410);
    assert.equal(adminReviewProbe.starts.length, 0);
  });
  assert.equal(calls.length, serviceCallsBeforeDeniedRequests, 'database administrator redirects and retired paths need no legacy service call');
});

test('invalid finance roster text returns a controlled 400 instead of a service-unavailable response', async () => {
  const annualFinanceService = createAnnualFinanceService({
    getPool: async () => { throw new Error('malformed search must be rejected before database access'); },
    sql: fakeSql()
  });
  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, annualFinanceService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const response = await fetch(`${baseUrl}/finance?search=%00`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 400);
    assert.match(html, /Search must be 100 printable characters or fewer\./);
    assert.doesNotMatch(html, /Service Unavailable|malformed search must be rejected/);
  });
});

test('annual account charge links retain browse filters and supplementary validation returns to Charges with entered values', async () => {
  const studentId = 22;
  const term = {
    annual_enrollment_id: 23, intake_status: 'confirmed', assessment_id: 40,
    school_year: '2026-2027', grade_level: 'Grade 12', voucher_code: 'ESC', schedule_version: 2,
    term: 'Term 1', annual_term_number: 1, enrollment_id: 14, section_name: 'Orchid',
    enrollment_status: 'enrolled', outstanding: '10.00', term_scope_status: 'applicable',
    registrar_confirmation_id: 8, signed_clearance_status: 'not_signed',
    modality: 'modular', modular_subtype: 'Self-Paced'
  };
  const annualFinanceService = {
    async getStudentLedger() {
      return {
        student: { id: studentId, student_no: 'SYNTH-22', first_name: 'Synthetic', middle_name: null, last_name: 'Student', suffix: null, status: 'active' },
        summary: { annualBalanceSchoolYear: '2026-2027', annualBalance: '10.00', allYearsAnnualBalance: '10.00', annualWaivedAmount: '0.00', unattributedLegacyBalance: '0.00', openingLiabilityDue: '0.00', totalBalance: '10.00', currentTermOutstanding: '10.00', priorTermYearDebt: '0.00', availableCredit: '0.00' },
        terms: [term], events: [], charges: [], availablePayments: [], openingLiabilities: [], allocationHistory: [],
        legacyReconciliationHistory: [], payments: [], legacyCredits: [], privateClearances: [], adjustments: [],
        feeComments: [], financeHandbookNumbers: [], financeHandbookHistory: []
      };
    },
    async listSchedules() { return []; }
  };
  const financeCasesService = {
    async getStudentCases() { return { specialSubjects: [], exemptions: [], departures: [] }; }
  };
  const reviewProbe = createReviewRouteProbe();
  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, annualFinanceService, financeCasesService, financeReviewActionService: reviewProbe }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const browse = new URLSearchParams({ backSearch: 'Alex Kim', backTermId: '92', backStatus: 'unpaid' });
    const overview = await fetch(`${baseUrl}/finance/students/${studentId}/annual?${browse}`, { headers: { cookie } });
    const overviewHtml = await overview.text();
    assert.equal(overview.status, 200);
    assert.match(overviewHtml, /Modular · Self-Paced/);
    assert.match(overviewHtml, /href="\/finance\/students\/22\/annual\?view=clearance&amp;backSearch=Alex\+Kim&amp;backTermId=92&amp;backStatus=unpaid"/);
    assert.match(overviewHtml, /href="\/finance\/students\/22\/annual\?view=charges&amp;backSearch=Alex\+Kim&amp;backTermId=92&amp;backStatus=unpaid"/);

    const charges = await fetch(`${baseUrl}/finance/students/${studentId}/annual?view=charges`, { headers: { cookie } });
    const chargesHtml = await charges.text();
    assert.equal(charges.status, 200);
    assert.match(chargesHtml, /data-account-view="charges"/);
    assert.match(chargesHtml, /action="\/finance\/students\/22\/annual\/terms\/14\/supplementary-charges\?view=charges"/);

    reviewProbe.startDraft = async () => { throw new AnnualFinanceError('Enter a valid student-payable amount.'); };
    const csrfToken = csrfFrom(chargesHtml);
    const failed = await fetch(`${baseUrl}/finance/students/${studentId}/annual/terms/14/supplementary-charges?view=charges`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: csrfToken, idempotencyKey: '41111111-1111-4111-8111-111111111111',
        feeCategory: 'retake', lineName: 'Retake assessment', installment: 'As incurred', amount: '12.50', reason: 'Approved'
      })
    });
    const failedHtml = await failed.text();
    assert.equal(failed.status, 400);
    assert.match(failedHtml, /data-account-view="charges"/);
    assert.match(failedHtml, /<details class="finance-account-action" open><summary>Add a named supplementary charge/);
    assert.match(failedHtml, /<option value="retake" selected>retake<\/option>/);
    assert.match(failedHtml, /name="lineName"[^>]*value="Retake assessment"/);
    assert.match(failedHtml, /name="installment"[^>]*value="As incurred"/);
    assert.match(failedHtml, /name="amount"[^>]*value="12\.50"/);
    assert.match(failedHtml, /name="reason"[^>]*>Approved<\/textarea>/);
    assert.match(failedHtml, /name="_csrf" value="[^"]+"/);
  });
});

test('old Finance account links redirect to annual accounts while the retired workspace stays gone', async () => {
  const annualFinanceService = {
    async listRoster() { return { rows: [], options: { schoolYears: [], terms: [], sections: [] } }; },
    async getStudentLedger() { throw new Error('the old account link should redirect without loading a second view'); }
  };

  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, annualFinanceService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const account = await fetch(`${baseUrl}/finance/students/22?search=Alex%20Kim`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(account.status, 303);
    assert.equal(account.headers.get('location'), '/finance/students/22/annual');

    const workspace = await fetch(`${baseUrl}/finance/legacy`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(workspace.status, 410);
  });
});
