'use strict';

const crypto = require('node:crypto');
const { sql: defaultSql, getPool: defaultGetPool } = require('../config/database');
const { createFinanceService } = require('./financeService');
const { createAnnualFinanceService } = require('./annualFinanceService');
const { createAnnualFinanceCasesService } = require('./annualFinanceCasesService');
const { createStudentDocumentFinanceClearanceService } = require('./studentDocumentFinanceClearanceService');
const { createFinanceReviewDraftService } = require('./financeReviewDraftService');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ACTIONS = Object.freeze([
  { type: 'document_clearance_decision', label: 'Document clearance decision', pattern: /^\/document-clearance\/([0-9a-f-]{36})\/decision$/, ids: ['requestId'] },
  { type: 'schedule_create', label: 'Create fee schedule version', pattern: /^\/schedules$/, ids: [] },
  { type: 'annual_assessment', label: 'Post annual assessment', pattern: /^\/annual\/(\d{1,10})\/assessment$/, ids: ['annualId'] },
  { type: 'annual_payment', label: 'Record payment and allocations', pattern: /^\/students\/(\d{1,10})\/annual\/payments$/, ids: ['studentId'] },
  { type: 'annual_credit_allocation', label: 'Allocate existing payment credit', pattern: /^\/students\/(\d{1,10})\/annual\/credits\/(\d{1,18})\/allocate$/, ids: ['studentId', 'paymentId'] },
  { type: 'annual_adjustment', label: 'Adjust an assessed charge', pattern: /^\/students\/(\d{1,10})\/annual\/charges\/(\d{1,18})\/adjustments$/, ids: ['studentId', 'chargeId'] },
  { type: 'annual_handbook_reference', label: 'Update finance handbook reference', pattern: /^\/students\/(\d{1,10})\/annual\/(\d{1,10})\/handbook-number$/, ids: ['studentId', 'annualId'] },
  { type: 'annual_fee_comment', label: 'Add private fee comment', pattern: /^\/students\/(\d{1,10})\/annual\/charges\/(\d{1,18})\/comments$/, ids: ['studentId', 'chargeId'] },
  { type: 'annual_supplementary_charge', label: 'Add supplementary charge', pattern: /^\/students\/(\d{1,10})\/annual\/terms\/(\d{1,10})\/supplementary-charges$/, ids: ['studentId', 'enrollmentId'] },
  { type: 'annual_special_subject_charge', label: 'Bill special-subject charge', pattern: /^\/students\/(\d{1,10})\/annual\/special-subjects\/(\d{1,10})\/bill$/, ids: ['studentId', 'specialSubjectId'] },
  { type: 'annual_exemption', label: 'Approve finance exemption', pattern: /^\/students\/(\d{1,10})\/annual\/(\d{1,10})\/exemptions$/, ids: ['studentId', 'annualId'] },
  { type: 'departure_review', label: 'Review departure charges', pattern: /^\/departure-cases\/(\d{1,10})\/review$/, ids: ['caseId'] },
  { type: 'annual_payment_reversal', label: 'Reverse recorded payment', pattern: /^\/students\/(\d{1,10})\/annual\/payments\/(\d{1,18})\/reverse$/, ids: ['studentId', 'paymentId'] },
  { type: 'annual_adjustment_reversal', label: 'Reverse charge adjustment', pattern: /^\/students\/(\d{1,10})\/annual\/adjustments\/(\d{1,18})\/reverse$/, ids: ['studentId', 'adjustmentId'] },
  { type: 'legacy_payment_reconciliation', label: 'Reconcile legacy payment', pattern: /^\/students\/(\d{1,10})\/annual\/legacy-payments\/(\d{1,18})\/reconcile$/, ids: ['studentId', 'transactionId'] },
  { type: 'annual_allocation_release', label: 'Release payment allocation', pattern: /^\/students\/(\d{1,10})\/annual\/allocations\/(\d{1,18})\/release$/, ids: ['studentId', 'allocationId'] },
  { type: 'legacy_reconciliation_release', label: 'Release legacy reconciliation', pattern: /^\/students\/(\d{1,10})\/annual\/legacy-reconciliations\/(\d{1,18})\/release$/, ids: ['studentId', 'reconciliationId'] },
  { type: 'annual_payment_metadata', label: 'Update payment reference or receipt status', pattern: /^\/students\/(\d{1,10})\/annual\/payments\/(\d{1,18})\/metadata$/, ids: ['studentId', 'paymentId'] },
  { type: 'legacy_opening_transfer', label: 'Transfer verified legacy opening balance', pattern: /^\/students\/(\d{1,10})\/annual\/legacy-opening\/transfer$/, ids: ['studentId'] },
  { type: 'term_finance_approval', label: 'Approve term finance status', pattern: /^\/annual\/terms\/(\d{1,10})\/approval$/, ids: ['enrollmentId'] },
  { type: 'voucher_review_resolution', label: 'Resolve voucher review', pattern: /^\/annual\/(\d{1,10})\/voucher-review-resolution$/, ids: ['annualId'] },
  { type: 'term_clearance', label: 'Record signed term clearance', pattern: /^\/annual\/terms\/(\d{1,10})\/clearance$/, ids: ['enrollmentId'] },
  { type: 'legacy_account_create', label: 'Open legacy account', pattern: /^\/students\/(\d{1,10})\/account$/, ids: ['studentId'] },
  { type: 'legacy_transaction', label: 'Record legacy account transaction', pattern: /^\/students\/(\d{1,10})\/transactions$/, ids: ['studentId'] },
  { type: 'legacy_enrollment_clearance', label: 'Assign recorded payment to enrollment clearance', pattern: /^\/students\/(\d{1,10})\/enrollment-clearance$/, ids: ['studentId'] }
]);

const READ_ONLY_POSTS = Object.freeze([
  /^\/annual\/\d{1,10}\/assessment-preview$/,
  /^\/students\/\d{1,10}\/annual\/legacy-opening\/preview$/
]);

const ACTION_WRITERS = Object.freeze({
  document_clearance_decision: ({ services, actorId, context, input }) => services.documentClearance.decideClearance(actorId, context.requestId, input),
  schedule_create: ({ services, actorId, input }) => services.annual.createSchedule(actorId, input),
  annual_assessment: ({ services, actorId, context, input, studentId }) => services.annual.confirmAnnualAssessment(actorId, context.annualId, input.optionalLineId, { ...input, studentId }),
  annual_payment: ({ services, actorId, studentId, input }) => services.annual.recordPayment(actorId, studentId, input),
  annual_credit_allocation: ({ services, actorId, studentId, context, input }) => services.annual.allocateExistingCredit(actorId, studentId, context.paymentId, input),
  annual_adjustment: ({ services, actorId, studentId, context, input }) => services.annual.recordChargeAdjustment(actorId, studentId, context.chargeId, input),
  annual_handbook_reference: ({ services, actorId, studentId, context, input }) => services.annual.updateFinanceHandbookNumber(actorId, context.annualId, { ...input, expectedStudentId: studentId }),
  annual_fee_comment: ({ services, actorId, studentId, context, input }) => services.annual.addFeeComment(actorId, studentId, context.chargeId, input),
  annual_supplementary_charge: ({ services, actorId, studentId, context, input }) => services.annual.addSupplementaryCharge(actorId, studentId, context.enrollmentId, input),
  annual_special_subject_charge: ({ services, actorId, studentId, context, input }) => services.cases.billSpecialSubject(actorId, studentId, context.specialSubjectId, input),
  annual_exemption: ({ services, actorId, studentId, context, input }) => services.cases.approveExemptionCase(actorId, context.annualId, { ...input, expectedStudentId: studentId }),
  departure_review: ({ services, actorId, context, input }) => services.cases.reviewDepartureCase(actorId, context.caseId, input),
  annual_payment_reversal: ({ services, actorId, studentId, context, input }) => services.annual.reversePayment(actorId, studentId, context.paymentId, input),
  annual_adjustment_reversal: ({ services, actorId, studentId, context, input }) => services.annual.reverseAdjustment(actorId, studentId, context.adjustmentId, input),
  legacy_payment_reconciliation: ({ services, actorId, studentId, context, input }) => services.annual.reconcileLegacyPayment(actorId, studentId, context.transactionId, input),
  annual_allocation_release: ({ services, actorId, studentId, context, input }) => services.annual.releasePaymentAllocation(actorId, studentId, context.allocationId, input),
  legacy_reconciliation_release: ({ services, actorId, studentId, context, input }) => services.annual.releaseLegacyReconciliation(actorId, studentId, context.reconciliationId, input),
  annual_payment_metadata: ({ services, actorId, studentId, context, input }) => services.annual.updatePaymentMetadata(actorId, studentId, context.paymentId, input),
  legacy_opening_transfer: ({ services, actorId, studentId, input }) => services.annual.transferLegacyOpeningLiability(actorId, studentId, input),
  term_finance_approval: ({ services, actorId, context, input }) => services.annual.approveTerm(actorId, context.enrollmentId, input),
  voucher_review_resolution: ({ services, actorId, context, input }) => services.annual.resolveVoucherReview(actorId, context.annualId, input),
  term_clearance: ({ services, actorId, context, input }) => services.annual.signTermClearance(actorId, context.enrollmentId, input),
  legacy_account_create: async ({ services, actorId, studentId }) => ({ accountId: await services.finance.createAccount(actorId, studentId) }),
  legacy_transaction: ({ services, actorId, studentId, input }) => services.finance.recordTransaction(actorId, studentId, input),
  legacy_enrollment_clearance: ({ services, actorId, studentId, input }) => services.finance.clearEnrollmentWithExistingPayment(actorId, studentId, input.enrollmentId, input.paymentTransactionId, input.confirmEnrollmentClearance)
});

function safeIntegerId(value) {
  if (!/^\d{1,18}$/.test(String(value || ''))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function safeText(value, maxLength = 2048) {
  if (typeof value !== 'string') return value;
  return value.slice(0, maxLength).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function normalizeInput(value, depth = 0) {
  if (depth > 3) throw new Error('Finance review input is too deeply nested.');
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) {
    if (value.length > 120) throw new Error('Finance review input contains too many rows.');
    return value.map((item) => normalizeInput(item, depth + 1));
  }
  if (typeof value !== 'object') throw new Error('Finance review input is invalid.');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['_csrf', 'csrfToken', 'idempotencyKey', 'reviewRevision', 'reviewFingerprint'].includes(key)) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(key)) throw new Error('Finance review input contains an invalid field.');
    result[key] = normalizeInput(item, depth + 1);
  }
  return result;
}

function formRows(body, targetName, amountName) {
  const targets = Array.isArray(body[targetName]) ? body[targetName] : body[targetName] == null ? [] : [body[targetName]];
  const chargeIds = Array.isArray(body.chargeId) ? body.chargeId : body.chargeId == null ? [] : [body.chargeId];
  const amounts = Array.isArray(body[amountName]) ? body[amountName] : body[amountName] == null ? [] : [body[amountName]];
  const count = Math.max(targets.length, chargeIds.length, amounts.length);
  return Array.from({ length: count }, (_, index) => {
    const target = targets[index];
    const match = typeof target === 'string' ? /^(charge|opening):(\d{1,18})$/.exec(target) : null;
    return { chargeId: match?.[1] === 'charge' ? match[2] : (chargeIds[index] || null),
      openingLiabilityId: match?.[1] === 'opening' ? match[2] : null, amount: amounts[index] || '' };
  }).filter((row) => row.amount !== '');
}

function scheduleLines(body) {
  const fields = ['termNumber', 'feeCategory', 'lineName', 'installment', 'lineAmount'];
  const values = fields.map((key) => Array.isArray(body[key]) ? body[key] : body[key] == null ? [] : [body[key]]);
  const optional = new Set((Array.isArray(body.optionalIndex) ? body.optionalIndex : body.optionalIndex == null ? [] : [body.optionalIndex]).map(String));
  return values[0].map((termNumber, index) => ({ termNumber,
    feeCategory: values[1][index], lineName: values[2][index], installment: values[3][index], amount: values[4][index], isOptional: optional.has(String(index)) }))
    .filter((line) => [line.feeCategory, line.lineName, line.installment, line.amount].some((value) => value !== '' && value != null));
}

function exemptionRules(body) {
  const terms = Array.isArray(body.ruleTerm) ? body.ruleTerm : body.ruleTerm == null ? [] : [body.ruleTerm];
  const categories = Array.isArray(body.ruleCategory) ? body.ruleCategory : body.ruleCategory == null ? [] : [body.ruleCategory];
  const names = Array.isArray(body.ruleLineName) ? body.ruleLineName : body.ruleLineName == null ? [] : [body.ruleLineName];
  const amounts = Array.isArray(body.ruleAmount) ? body.ruleAmount : body.ruleAmount == null ? [] : [body.ruleAmount];
  const full = new Set((Array.isArray(body.fullCoverageIndex) ? body.fullCoverageIndex : body.fullCoverageIndex == null ? [] : [body.fullCoverageIndex]).map(String));
  return terms.map((termNumber, index) => ({ termNumber, feeCategory: categories[index] || '', lineName: names[index] || '',
    isFullCoverage: full.has(String(index)), approvedAmount: amounts[index] || (full.has(String(index)) ? '0.00' : '') }))
    .filter((rule) => [rule.feeCategory, rule.lineName, rule.approvedAmount].some((value) => value !== '' && value != null));
}

function departureAdjustments(body) {
  const ids = Array.isArray(body.departureChargeId) ? body.departureChargeId : body.departureChargeId == null ? [] : [body.departureChargeId];
  const amounts = Array.isArray(body.departureAdjustmentAmount) ? body.departureAdjustmentAmount : body.departureAdjustmentAmount == null ? [] : [body.departureAdjustmentAmount];
  const reasons = Array.isArray(body.departureAdjustmentReason) ? body.departureAdjustmentReason : body.departureAdjustmentReason == null ? [] : [body.departureAdjustmentReason];
  return ids.map((chargeId, index) => ({ chargeId, amount: amounts[index] || '', reason: reasons[index] || '' }))
    .filter((row) => row.chargeId && row.amount);
}

function normalizeActionInput(actionType, body) {
  const input = normalizeInput(body || {});
  if (actionType === 'schedule_create') {
    if (!Array.isArray(input.lines)) input.lines = scheduleLines(input);
    input.lines = input.lines.map((line) => ({ ...line,
      isOptional: line.isOptional === true || line.isOptional === 1 || line.isOptional === '1' || line.isOptional === 'true' }));
    for (const key of ['termNumber', 'feeCategory', 'lineName', 'installment', 'lineAmount', 'optionalIndex']) delete input[key];
    for (const key of ['schoolYear', 'gradeLevel', 'voucherCode']) input[key] = safeText(input[key] || '', 50);
  }
  if (['annual_payment', 'annual_credit_allocation', 'legacy_payment_reconciliation'].includes(actionType)) {
    if (!Array.isArray(input.allocations)) input.allocations = formRows(input, 'allocationTarget', 'allocationAmount');
    delete input.allocationTarget; delete input.allocationAmount; delete input.chargeId;
  }
  if (actionType === 'annual_exemption') {
    if (!Array.isArray(input.rules)) input.rules = exemptionRules(input);
    input.rules = input.rules.map((rule) => ({ ...rule,
      isFullCoverage: rule.isFullCoverage === true || rule.isFullCoverage === 1 || rule.isFullCoverage === '1' || rule.isFullCoverage === 'true' }));
    for (const key of ['ruleTerm', 'ruleCategory', 'ruleLineName', 'ruleAmount', 'fullCoverageIndex']) delete input[key];
  }
  if (actionType === 'departure_review') {
    if (!Array.isArray(input.adjustments)) input.adjustments = departureAdjustments(input);
    for (const key of ['departureChargeId', 'departureAdjustmentAmount', 'departureAdjustmentReason']) delete input[key];
  }
  return input;
}

function actionByPath(pathname) {
  for (const action of SAFE_ACTIONS) {
    const match = action.pattern.exec(pathname);
    if (!match) continue;
    const context = {};
    for (const [index, name] of action.ids.entries()) context[name] = match[index + 1];
    for (const key of ['studentId', 'annualId', 'enrollmentId', 'chargeId', 'paymentId', 'transactionId', 'caseId', 'allocationId', 'reconciliationId', 'specialSubjectId']) {
      if (context[key] && !safeIntegerId(context[key]) && key !== 'requestId') return null;
    }
    if (context.requestId && !UUID.test(context.requestId)) return null;
    return { ...action, context };
  }
  return null;
}

function isReadOnlyPost(pathname) { return READ_ONLY_POSTS.some((pattern) => pattern.test(pathname)); }

function jsonHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createFinanceReviewActionService({ getPool = defaultGetPool, sql = defaultSql, draftService = null } = {}) {
  const drafts = draftService || createFinanceReviewDraftService({ getPool, sql });

  async function resolveStudentId(request, context) {
    if (context.studentId) return Number(context.studentId);
    const lookups = [
      context.annualId ? ['annual_enrollments', 'id', context.annualId, 'student_id'] : null,
      context.enrollmentId ? ['enrollments', 'id', context.enrollmentId, 'student_id'] : null,
      context.caseId ? ['finance_departure_cases', 'id', context.caseId, 'student_id'] : null,
      context.requestId ? ['student_document_requests', 'id', context.requestId, 'student_id'] : null
    ].filter(Boolean);
    if (!lookups.length) return null;
    const [table, idColumn, idValue] = lookups[0];
    const query = table === 'annual_enrollments'
      ? 'SELECT student_id FROM annual_enrollments WHERE id = @entityId LIMIT 1'
      : table === 'enrollments'
        ? 'SELECT annual.student_id FROM enrollments AS entity INNER JOIN annual_enrollments AS annual ON annual.id = entity.annual_enrollment_id WHERE entity.id = @entityId LIMIT 1'
        : table === 'finance_departure_cases'
          ? 'SELECT annual.student_id FROM finance_departure_cases AS entity INNER JOIN annual_enrollments AS annual ON annual.id = entity.annual_enrollment_id WHERE entity.id = @entityId LIMIT 1'
          : 'SELECT student_id FROM student_document_requests WHERE id = @entityId LIMIT 1';
    const result = await request.input('entityId', table === 'student_document_requests' ? sql.Char(36) : sql.Int, idValue)
      .query(query);
    const studentId = safeIntegerId(result.recordset?.[0]?.student_id);
    return studentId;
  }

  async function resolveStudentForAction(actorInput, pathname) {
    const action = actionByPath(pathname);
    if (!action) throw new FinanceReviewDraftError('The finance action is no longer available.', 404);
    const actorId = safeIntegerId(actorInput);
    if (!actorId) throw new FinanceReviewDraftError('Your finance access is no longer active. Sign in again.', 403);
    const pool = await getPool();
    const actor = await pool.request().input('actorId', sql.Int, actorId)
      .query("SELECT id FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin')");
    if (!actor.recordset?.length) throw new FinanceReviewDraftError('Your finance access is no longer active. Sign in again.', 403);
    return resolveStudentId(pool.request(), action.context);
  }

  async function lockStudentRows(tx, studentId) {
    await tx.request().input('studentId', sql.Int, studentId)
      .query('SELECT id FROM students WHERE id = @studentId FOR UPDATE');
    const annualRows = await tx.request().input('studentId', sql.Int, studentId)
      .query('SELECT id FROM annual_enrollments WHERE student_id = @studentId ORDER BY id FOR UPDATE');
    const annualIds = (annualRows.recordset || []).map((row) => Number(row.id));
    if (annualIds.length) {
      await tx.request().input('studentId', sql.Int, studentId)
        .query(`SELECT id FROM enrollments WHERE annual_enrollment_id IN
          (SELECT id FROM annual_enrollments WHERE student_id = @studentId)
          ORDER BY id FOR UPDATE`);
      await tx.request().input('studentId', sql.Int, studentId)
        .query('SELECT id FROM annual_assessments WHERE annual_enrollment_id IN (SELECT id FROM annual_enrollments WHERE student_id = @studentId) ORDER BY id FOR UPDATE');
    }
    await tx.request().input('studentId', sql.Int, studentId)
      .query('SELECT id FROM financial_accounts WHERE student_id = @studentId ORDER BY id FOR UPDATE');
    await tx.request().input('studentId', sql.Int, studentId)
      .query('SELECT id FROM finance_payments WHERE student_id = @studentId ORDER BY id FOR UPDATE');
    if (annualIds.length) {
      await tx.request().input('studentId', sql.Int, studentId)
        .query('SELECT id FROM assessed_charges WHERE annual_enrollment_id IN (SELECT id FROM annual_enrollments WHERE student_id = @studentId) ORDER BY id FOR UPDATE');
      await tx.request().input('studentId', sql.Int, studentId)
        .query('SELECT id FROM finance_charge_adjustments WHERE charge_id IN (SELECT id FROM assessed_charges WHERE annual_enrollment_id IN (SELECT id FROM annual_enrollments WHERE student_id = @studentId)) ORDER BY id FOR UPDATE');
      await tx.request().input('studentId', sql.Int, studentId)
        .query('SELECT allocation.id FROM finance_payment_allocations AS allocation INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id WHERE payment.student_id = @studentId ORDER BY allocation.id FOR UPDATE');
      await tx.request().input('studentId', sql.Int, studentId)
        .query('SELECT release_record.id FROM finance_payment_allocation_releases AS release_record INNER JOIN finance_payment_allocations AS allocation ON allocation.id = release_record.allocation_id INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id WHERE payment.student_id = @studentId ORDER BY release_record.id FOR UPDATE');
      await tx.request().input('studentId', sql.Int, studentId)
        .query('SELECT reconciliation.id FROM finance_legacy_reconciliations AS reconciliation INNER JOIN financial_transactions AS transaction_record ON transaction_record.id = reconciliation.transaction_id INNER JOIN financial_accounts AS account ON account.id = transaction_record.financial_account_id WHERE account.student_id = @studentId ORDER BY reconciliation.id FOR UPDATE');
      await tx.request().input('studentId', sql.Int, studentId)
        .query('SELECT release_record.id FROM finance_legacy_reconciliation_releases AS release_record INNER JOIN finance_legacy_reconciliations AS reconciliation ON reconciliation.id = release_record.reconciliation_id INNER JOIN financial_transactions AS transaction_record ON transaction_record.id = reconciliation.transaction_id INNER JOIN financial_accounts AS account ON account.id = transaction_record.financial_account_id WHERE account.student_id = @studentId ORDER BY release_record.id FOR UPDATE');
    }
    await tx.request().input('studentId', sql.Int, studentId)
      .query('SELECT id FROM finance_legacy_opening_charges WHERE student_id = @studentId ORDER BY id FOR UPDATE');
    await tx.request().input('studentId', sql.Int, studentId)
      .query('SELECT transaction_record.id FROM financial_transactions AS transaction_record INNER JOIN financial_accounts AS account ON account.id = transaction_record.financial_account_id WHERE account.student_id = @studentId ORDER BY transaction_record.id FOR UPDATE');
  }

  async function lockActionTargets(tx, context, input) {
    if (context.requestId) {
      await tx.request().input('requestId', sql.Char(36), context.requestId)
        .query('SELECT id FROM student_document_requests WHERE id = @requestId FOR UPDATE');
      await tx.request().input('requestId', sql.Char(36), context.requestId)
        .query('SELECT id FROM student_document_clearance_events WHERE request_id = @requestId ORDER BY id FOR UPDATE');
    }
    if (context.schoolYear && context.gradeLevel && context.voucherCode) {
      await tx.request().input('scheduleYear', sql.NVarChar(20), context.schoolYear)
        .input('scheduleGrade', sql.NVarChar(50), context.gradeLevel)
        .input('scheduleVoucher', sql.NVarChar(10), context.voucherCode)
        .query(`SELECT id FROM finance_schedules WHERE school_year = @scheduleYear AND grade_level = @scheduleGrade
          AND voucher_code = @scheduleVoucher ORDER BY version_no, id FOR UPDATE`);
      await tx.request().input('scheduleYear', sql.NVarChar(20), context.schoolYear)
        .input('scheduleGrade', sql.NVarChar(50), context.gradeLevel)
        .input('scheduleVoucher', sql.NVarChar(10), context.voucherCode)
        .query(`SELECT line.id FROM finance_schedule_lines AS line INNER JOIN finance_schedules AS schedule ON schedule.id = line.schedule_id
          WHERE schedule.school_year = @scheduleYear AND schedule.grade_level = @scheduleGrade AND schedule.voucher_code = @scheduleVoucher
          ORDER BY schedule.version_no, line.id FOR UPDATE`);
    }
    if (context.annualId) {
      await tx.request().input('annualId', sql.Int, context.annualId)
        .query('SELECT id FROM finance_exemption_cases WHERE annual_enrollment_id = @annualId FOR UPDATE');
      await tx.request().input('annualId', sql.Int, context.annualId)
        .query(`SELECT rule.id FROM finance_exemption_rules AS rule INNER JOIN finance_exemption_cases AS exemption ON exemption.id = rule.exemption_case_id
          WHERE exemption.annual_enrollment_id = @annualId ORDER BY rule.id FOR UPDATE`);
      await tx.request().input('annualId', sql.Int, context.annualId)
        .query(`SELECT application.id FROM finance_exemption_applications AS application
          INNER JOIN finance_exemption_rules AS rule ON rule.id = application.exemption_rule_id
          INNER JOIN finance_exemption_cases AS exemption ON exemption.id = rule.exemption_case_id
          WHERE exemption.annual_enrollment_id = @annualId ORDER BY application.id FOR UPDATE`);
    }
    if (context.caseId) {
      await tx.request().input('caseId', sql.BigInt, context.caseId)
        .query('SELECT id FROM finance_departure_cases WHERE id = @caseId FOR UPDATE');
      await tx.request().input('caseId', sql.BigInt, context.caseId)
        .query('SELECT enrollment_id FROM finance_departure_case_terms WHERE departure_case_id = @caseId ORDER BY enrollment_id FOR UPDATE');
    }
    if (context.specialSubjectId) {
      await tx.request().input('specialSubjectId', sql.BigInt, context.specialSubjectId)
        .query('SELECT id FROM annual_special_subjects WHERE id = @specialSubjectId FOR UPDATE');
    }
    if (context.enrollmentId) {
      await tx.request().input('enrollmentId', sql.Int, context.enrollmentId)
        .query('SELECT id FROM enrollments WHERE id = @enrollmentId FOR UPDATE');
      await tx.request().input('enrollmentId', sql.Int, context.enrollmentId)
        .query('SELECT enrollment_id FROM enrollment_clearances WHERE enrollment_id = @enrollmentId FOR UPDATE');
    }
    if (context.transactionId || input.paymentTransactionId) {
      const transactionId = context.transactionId || input.paymentTransactionId;
      await tx.request().input('transactionId', sql.Int, transactionId)
        .query('SELECT id FROM financial_transactions WHERE id = @transactionId FOR UPDATE');
      await tx.request().input('transactionId', sql.Int, transactionId)
        .query('SELECT id FROM finance_legacy_reconciliation_batches WHERE transaction_id = @transactionId ORDER BY id FOR UPDATE');
      await tx.request().input('transactionId', sql.Int, transactionId)
        .query('SELECT id FROM finance_legacy_reconciliations WHERE transaction_id = @transactionId ORDER BY id FOR UPDATE');
      await tx.request().input('transactionId', sql.Int, transactionId)
        .query(`SELECT release_record.id FROM finance_legacy_reconciliation_releases AS release_record
          INNER JOIN finance_legacy_reconciliations AS reconciliation ON reconciliation.id = release_record.reconciliation_id
          WHERE reconciliation.transaction_id = @transactionId ORDER BY release_record.id FOR UPDATE`);
    }
  }

  async function dependencyRows(request, studentId, context) {
    const result = [];
    if (studentId) {
      const idParam = (name) => request.input(name, sql.Int, studentId);
      const queries = [
        `SELECT id, status, debt_increase_revision FROM students WHERE id = @studentId`,
        `SELECT id, school_year, grade_level, voucher_code, voucher_category, intake_status, entry_term_number, updated_at FROM annual_enrollments WHERE student_id = @studentId ORDER BY id`,
        `SELECT enrollment.id, enrollment.academic_term_id, enrollment.annual_term_number, enrollment.enrollment_status, enrollment.term_scope_status, enrollment.section_id FROM enrollments AS enrollment INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id WHERE annual.student_id = @studentId ORDER BY enrollment.id`,
        `SELECT assessment.id, assessment.annual_enrollment_id, assessment.schedule_id, assessment.schedule_version, assessment.voucher_code_snapshot, assessment.selection_json, assessment.idempotency_key FROM annual_assessments AS assessment INNER JOIN annual_enrollments AS annual ON annual.id = assessment.annual_enrollment_id WHERE annual.student_id = @studentId ORDER BY assessment.id`,
        `SELECT charge.id, charge.assessment_id, charge.annual_enrollment_id, charge.enrollment_id, charge.schedule_line_id, charge.fee_category, charge.line_name, charge.installment, charge.amount, charge.waived_amount, due.amount_due, due.annual_allocated, due.legacy_allocated FROM assessed_charges AS charge INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id WHERE annual.student_id = @studentId ORDER BY charge.id`,
        `SELECT adjustment.id, adjustment.charge_id, adjustment.amount, adjustment.reason, adjustment.reverses_adjustment_id, adjustment.idempotency_key FROM finance_charge_adjustments AS adjustment INNER JOIN assessed_charges AS charge ON charge.id = adjustment.charge_id INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id WHERE annual.student_id = @studentId ORDER BY adjustment.id`,
        `SELECT payment.id, payment.amount, payment.payment_date, payment.reference_no, payment.receipt_issued, payment.private_remarks, payment.is_reversed FROM finance_payments AS payment WHERE payment.student_id = @studentId ORDER BY payment.id`,
        `SELECT allocation.id, allocation.payment_id, allocation.charge_id, allocation.legacy_opening_charge_id, allocation.amount, net.net_amount FROM finance_payment_allocations AS allocation INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id INNER JOIN v_finance_net_payment_allocations AS net ON net.allocation_id = allocation.id WHERE payment.student_id = @studentId ORDER BY allocation.id`,
        `SELECT reconciliation.id, reconciliation.transaction_id, reconciliation.charge_id, reconciliation.amount, net.net_amount FROM finance_legacy_reconciliations AS reconciliation INNER JOIN financial_transactions AS transaction_record ON transaction_record.id = reconciliation.transaction_id INNER JOIN financial_accounts AS account ON account.id = transaction_record.financial_account_id INNER JOIN v_finance_net_legacy_reconciliations AS net ON net.reconciliation_id = reconciliation.id WHERE account.student_id = @studentId ORDER BY reconciliation.id`,
        `SELECT account.id, account.balance, legacy.remaining_legacy_balance FROM financial_accounts AS account LEFT JOIN v_finance_legacy_account_balance AS legacy ON legacy.financial_account_id = account.id WHERE account.student_id = @studentId ORDER BY account.id`,
        `SELECT opening.id, opening.amount, due.amount_due FROM finance_legacy_opening_charges AS opening INNER JOIN v_finance_opening_liability_due AS due ON due.opening_charge_id = opening.id WHERE opening.student_id = @studentId ORDER BY opening.id`,
        `SELECT event.id, event.annual_enrollment_id, event.event_type, event.reason, event.created_at FROM annual_enrollment_events AS event INNER JOIN annual_enrollments AS annual ON annual.id = event.annual_enrollment_id WHERE annual.student_id = @studentId ORDER BY event.id`,
        `SELECT event.id, event.enrollment_id, event.event_type, event.reason, event.arrangement, event.finance_note, event.created_at FROM term_clearance_events AS event INNER JOIN enrollments AS enrollment ON enrollment.id = event.enrollment_id INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id WHERE annual.student_id = @studentId ORDER BY event.id`,
        `SELECT event.id, event.payment_id, event.event_type, event.reference_no, event.private_remark, event.created_at FROM finance_payment_metadata_events AS event INNER JOIN finance_payments AS payment ON payment.id = event.payment_id WHERE payment.student_id = @studentId ORDER BY event.id`,
        `SELECT event.id, event.annual_enrollment_id, event.before_value, event.after_value, event.created_at FROM finance_handbook_number_events AS event INNER JOIN annual_enrollments AS annual ON annual.id = event.annual_enrollment_id WHERE annual.student_id = @studentId ORDER BY event.id`,
        `SELECT event.id, event.charge_id, event.comment, event.created_at FROM finance_fee_comment_events AS event INNER JOIN assessed_charges AS charge ON charge.id = event.charge_id INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id WHERE annual.student_id = @studentId ORDER BY event.id`
      ];
      for (const query of queries) {
        const rows = await idParam('studentId').query(query);
        result.push(rows.recordset || []);
      }
      const transactionRows = await idParam('studentId').query(`SELECT transaction_record.id, transaction_record.transaction_type,
          transaction_record.amount, transaction_record.description, transaction_record.reference_no,
          transaction_record.is_legacy_unattributed, transaction_record.created_at
        FROM financial_transactions AS transaction_record INNER JOIN financial_accounts AS account
          ON account.id = transaction_record.financial_account_id WHERE account.student_id = @studentId ORDER BY transaction_record.id`);
      result.push(transactionRows.recordset || []);
    }
    if (context.requestId) {
      const requestRows = await request.input('requestId', sql.Char(36), context.requestId)
        .query(`SELECT id, student_id, document_type, document_name, requested_on, status, released_on, recipient, updated_at
          FROM student_document_requests WHERE id = @requestId`);
      const eventRows = await request.input('requestId', sql.Char(36), context.requestId)
        .query(`SELECT id, event_type, status_from, status_to, document_type_before, document_type_after,
          document_name_before, document_name_after, requested_on_before, requested_on_after, reference_before,
          reference_after, released_on_before, released_on_after, recipient_before, recipient_after, created_at
          FROM student_document_request_events WHERE request_id = @requestId ORDER BY id`);
      const clearanceRows = await request.input('requestId', sql.Char(36), context.requestId)
        .query(`SELECT id, event_type, clearance_status, debt_increase_revision, outstanding_snapshot,
          ledger_review_confirmed, created_at FROM student_document_clearance_events WHERE request_id = @requestId ORDER BY id`);
      result.push(requestRows.recordset || [], eventRows.recordset || [], clearanceRows.recordset || []);
    }
    if (context.annualId) {
      const exemptionRows = await request.input('annualId', sql.Int, context.annualId)
        .query(`SELECT exemption.id AS case_id, exemption.status, exemption.review_reason, exemption.reviewed_at,
          rule.id AS rule_id, rule.term_number, rule.fee_category, rule.line_name, rule.is_full_coverage, rule.approved_amount,
          application.id AS application_id, application.charge_id, application.amount, application.applied_at
          FROM finance_exemption_cases AS exemption
          LEFT JOIN finance_exemption_rules AS rule ON rule.exemption_case_id = exemption.id
          LEFT JOIN finance_exemption_applications AS application ON application.exemption_rule_id = rule.id
          WHERE exemption.annual_enrollment_id = @annualId ORDER BY exemption.id, rule.id, application.id`);
      const annualContextRows = await request.input('annualId', sql.Int, context.annualId)
        .query(`SELECT annual.id, annual.student_id, annual.school_year, annual.grade_level, annual.voucher_code,
          annual.intake_status, annual.entry_term_number FROM annual_enrollments AS annual WHERE annual.id = @annualId`);
      result.push(exemptionRows.recordset || [], annualContextRows.recordset || []);
      const annual = annualContextRows.recordset?.[0];
      if (annual) {
        const scheduleRows = await request.input('scheduleYear', sql.NVarChar(20), annual.school_year)
          .input('scheduleGrade', sql.NVarChar(50), annual.grade_level)
          .input('scheduleVoucher', sql.NVarChar(10), annual.voucher_code || '')
          .query(`SELECT schedule.id, schedule.version_no, schedule.status, line.id AS line_id, line.term_number,
              line.fee_category, line.line_name, line.installment, line.amount, line.is_optional
            FROM finance_schedules AS schedule LEFT JOIN finance_schedule_lines AS line ON line.schedule_id = schedule.id
            WHERE schedule.school_year = @scheduleYear AND schedule.grade_level = @scheduleGrade
              AND schedule.voucher_code = @scheduleVoucher ORDER BY schedule.version_no, line.id`);
        result.push(scheduleRows.recordset || []);
      }
    }
    if (context.caseId) {
      const departureRows = await request.input('caseId', sql.BigInt, context.caseId)
        .query(`SELECT case_record.id, case_record.annual_enrollment_id, case_record.effective_enrollment_id,
          case_record.effective_date, case_record.departure_type, case_record.finance_status, case_record.review_reason,
          case_record.review_idempotency_key, term.enrollment_id, term.academic_activity_review_required
          FROM finance_departure_cases AS case_record LEFT JOIN finance_departure_case_terms AS term
            ON term.departure_case_id = case_record.id WHERE case_record.id = @caseId ORDER BY term.enrollment_id`);
      result.push(departureRows.recordset || []);
    }
    if (context.specialSubjectId) {
      const specialRows = await request.input('specialSubjectId', sql.BigInt, context.specialSubjectId)
        .query(`SELECT special.id, special.annual_enrollment_id, special.enrollment_id, special.student_id,
          special.student_subject_id, special.arrangement_type, special.modular_subtype, special.prepaid_arrangement_note,
          assignment.enrollment_id AS subject_enrollment_id, assignment.subject_id
          FROM annual_special_subjects AS special INNER JOIN student_subjects AS assignment
            ON assignment.id = special.student_subject_id WHERE special.id = @specialSubjectId`);
      result.push(specialRows.recordset || []);
    }
    if (context.enrollmentId) {
      const termRows = await request.input('enrollmentId', sql.Int, context.enrollmentId)
        .query(`SELECT enrollment.id, enrollment.student_id, enrollment.academic_term_id, enrollment.annual_enrollment_id,
          enrollment.annual_term_number, enrollment.enrollment_status, enrollment.term_scope_status,
          clearance.enrollment_id AS clearance_id, clearance.clearance_status, clearance.payment_transaction_id,
          clearance.cleared_by, clearance.cleared_at, approval.status AS finance_approval_status,
          approval.finance_review_required, approval.finance_review_reason FROM enrollments AS enrollment
          LEFT JOIN enrollment_clearances AS clearance ON clearance.enrollment_id = enrollment.id
          LEFT JOIN term_finance_approvals AS approval ON approval.enrollment_id = enrollment.id
          WHERE enrollment.id = @enrollmentId`);
      result.push(termRows.recordset || []);
    }
    if (context.transactionId || context.paymentTransactionId) {
      const transactionId = context.transactionId || context.paymentTransactionId;
      const legacyRows = await request.input('transactionId', sql.Int, transactionId)
        .query(`SELECT transaction_record.id, transaction_record.financial_account_id, transaction_record.transaction_type,
          transaction_record.amount, transaction_record.description, transaction_record.reference_no,
          transaction_record.is_legacy_unattributed, transaction_record.created_at, batch.id AS batch_id,
          reconciliation.id AS reconciliation_id, reconciliation.charge_id, reconciliation.amount AS reconciled_amount,
          reconciliation.reason, net.net_amount, release_record.id AS release_id, release_record.amount AS released_amount
          FROM financial_transactions AS transaction_record
          LEFT JOIN finance_legacy_reconciliation_batches AS batch ON batch.transaction_id = transaction_record.id
          LEFT JOIN finance_legacy_reconciliations AS reconciliation ON reconciliation.transaction_id = transaction_record.id
          LEFT JOIN v_finance_net_legacy_reconciliations AS net ON net.reconciliation_id = reconciliation.id
          LEFT JOIN finance_legacy_reconciliation_releases AS release_record ON release_record.reconciliation_id = reconciliation.id
          WHERE transaction_record.id = @transactionId ORDER BY batch.id, reconciliation.id, release_record.id`);
      result.push(legacyRows.recordset || []);
    }
    if (context.schoolYear && context.gradeLevel && context.voucherCode) {
      const scheduleResult = await request.input('scheduleYear', sql.NVarChar(20), context.schoolYear)
        .input('scheduleGrade', sql.NVarChar(50), context.gradeLevel)
        .input('scheduleVoucher', sql.NVarChar(10), context.voucherCode)
        .query(`SELECT schedule.id, schedule.version_no, schedule.status, line.id AS line_id,
            line.term_number, line.fee_category, line.line_name, line.installment, line.amount, line.is_optional
          FROM finance_schedules AS schedule LEFT JOIN finance_schedule_lines AS line ON line.schedule_id = schedule.id
          WHERE schedule.school_year = @scheduleYear AND schedule.grade_level = @scheduleGrade
            AND schedule.voucher_code = @scheduleVoucher ORDER BY schedule.version_no, line.id`);
      result.push(scheduleResult.recordset || []);
    }
    return result;
  }

  async function actionTargetDetails(tx, action, context) {
    const details = [];
    async function row(label, statement, bindings = []) {
      const request = tx.request();
      for (const [name, type, value] of bindings) request.input(name, type, value);
      const result = await request.query(statement);
      const target = result.recordset?.[0];
      if (target) {
        const value = Object.values(target).filter((part) => part != null && String(part) !== '').join(' · ');
        details.push({ label, value });
      } else {
        details.push({ label, value: 'No current matching record; review required' });
      }
    }
    const chargeId = context.chargeId
      || (context.adjustmentId ? null : null);
    if (chargeId) {
      await row('Assessed fee', `SELECT CONCAT(annual.school_year, ' · ', annual.grade_level, ' · Term ', enrollment.annual_term_number,
          ' · ', charge.line_name, CASE WHEN LOWER(charge.line_name) = 'tuition' THEN CONCAT(' · ', charge.installment) ELSE '' END) AS context,
          CONCAT('Required ₱', CAST(due.amount_due + due.annual_allocated + due.legacy_allocated AS CHAR(40)),
            ' · already applied ₱', CAST(due.annual_allocated + due.legacy_allocated AS CHAR(40)),
            ' · remaining due ₱', CAST(due.amount_due AS CHAR(40))) AS balance
        FROM assessed_charges AS charge INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
        INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
        INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
        WHERE charge.id = @chargeId`, [['chargeId', sql.BigInt, chargeId]]);
    }
    if (context.adjustmentId) {
      await row('Charge adjustment', `SELECT CONCAT(annual.school_year, ' · ', annual.grade_level, ' · Term ', enrollment.annual_term_number,
          ' · ', charge.line_name, CASE WHEN LOWER(charge.line_name) = 'tuition' THEN CONCAT(' · ', charge.installment) ELSE '' END) AS fee,
          CONCAT('Current fee due ₱', CAST(due.amount_due AS CHAR(40)), ' · selected correction ₱', CAST(adjustment.amount AS CHAR(40)),
            CASE WHEN EXISTS (SELECT 1 FROM finance_charge_adjustments AS reversal WHERE reversal.reverses_adjustment_id = adjustment.id)
              THEN ' · already reversed' ELSE ' · not yet reversed' END) AS state
        FROM finance_charge_adjustments AS adjustment INNER JOIN assessed_charges AS charge ON charge.id = adjustment.charge_id
        INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
        INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
        INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
        WHERE adjustment.id = @adjustmentId`, [['adjustmentId', sql.BigInt, context.adjustmentId]]);
    }
    if (context.paymentId) {
      await row('Recorded payment', `SELECT CONCAT(DATE_FORMAT(payment.payment_date, '%Y-%m-%d'), ' · original cash ₱', CAST(payment.amount AS CHAR(40)),
          ' · currently applied ₱', CAST(CASE WHEN payment.is_reversed = 1 THEN 0 ELSE COALESCE((
            SELECT SUM(net.net_amount) FROM finance_payment_allocations AS allocation
            INNER JOIN v_finance_net_payment_allocations AS net ON net.allocation_id = allocation.id
            WHERE allocation.payment_id = payment.id), 0) END AS CHAR(40)),
          ' · reference ', COALESCE(NULLIF(payment.reference_no, ''), 'not entered'),
          ' · receipt ', CASE WHEN payment.receipt_issued = 1 THEN 'marked issued' ELSE 'not marked issued' END,
          ' · ', CASE WHEN payment.is_reversed = 1 THEN 'reversed' ELSE 'active' END) AS current_state
        FROM finance_payments AS payment WHERE payment.id = @paymentId AND payment.student_id = @studentId`,
      [['paymentId', sql.BigInt, context.paymentId], ['studentId', sql.Int, context.studentId]]);
    }
    if (context.allocationId) {
      await row('Payment allocation', `SELECT CONCAT(DATE_FORMAT(payment.payment_date, '%Y-%m-%d'), ' payment · ',
          COALESCE(CONCAT(annual.school_year, ' · Term ', enrollment.annual_term_number, ' · ', charge.line_name,
            CASE WHEN LOWER(charge.line_name) = 'tuition' THEN CONCAT(' · ', charge.installment) ELSE '' END),
            CONCAT('Verified prior balance · ', opening.source_label)),
          ' · original ₱', CAST(allocation.amount AS CHAR(40)), ' · currently applied ₱', CAST(net.net_amount AS CHAR(40))) AS target
        FROM finance_payment_allocations AS allocation INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
        INNER JOIN v_finance_net_payment_allocations AS net ON net.allocation_id = allocation.id
        LEFT JOIN assessed_charges AS charge ON charge.id = allocation.charge_id
        LEFT JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
        LEFT JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
        LEFT JOIN finance_legacy_opening_charges AS opening ON opening.id = allocation.legacy_opening_charge_id
        WHERE allocation.id = @allocationId AND payment.student_id = @studentId`,
      [['allocationId', sql.BigInt, context.allocationId], ['studentId', sql.Int, context.studentId]]);
    }
    if (context.reconciliationId) {
      await row('Legacy payment reconciliation', `SELECT CONCAT(DATE_FORMAT(transaction_record.created_at, '%Y-%m-%d'), ' · original payment ₱',
          CAST(transaction_record.amount AS CHAR(40)), ' · reference ', COALESCE(NULLIF(transaction_record.reference_no, ''), 'not entered'),
          ' · ', COALESCE(CONCAT(annual.school_year, ' · Term ', enrollment.annual_term_number, ' · ', charge.line_name), 'fee unavailable'),
          ' · original match ₱', CAST(reconciliation.amount AS CHAR(40)), ' · currently matched ₱', CAST(net.net_amount AS CHAR(40))) AS target
        FROM finance_legacy_reconciliations AS reconciliation INNER JOIN financial_transactions AS transaction_record
          ON transaction_record.id = reconciliation.transaction_id
        INNER JOIN financial_accounts AS account ON account.id = transaction_record.financial_account_id
        INNER JOIN v_finance_net_legacy_reconciliations AS net ON net.reconciliation_id = reconciliation.id
        LEFT JOIN assessed_charges AS charge ON charge.id = reconciliation.charge_id
        LEFT JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
        LEFT JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
        WHERE reconciliation.id = @reconciliationId AND account.student_id = @studentId`,
      [['reconciliationId', sql.BigInt, context.reconciliationId], ['studentId', sql.Int, context.studentId]]);
    }
    if (context.requestId) {
      await row('Student document request', `SELECT CONCAT(request.document_name, ' · ', request.document_type, ' · request status ', request.status,
          ' · current Finance decision ', COALESCE((SELECT clearance.clearance_status FROM student_document_clearance_events AS clearance
            WHERE clearance.request_id = request.id ORDER BY clearance.id DESC LIMIT 1), 'not yet decided')) AS target
        FROM student_document_requests AS request WHERE request.id = @requestId`, [['requestId', sql.Char(36), context.requestId]]);
    }
    if (context.annualId) {
      await row('Annual enrollment', `SELECT CONCAT(annual.school_year, ' · ', annual.grade_level, ' · ', COALESCE(NULLIF(annual.voucher_code, ''), 'voucher unavailable'),
          ' · status ', annual.intake_status, ' · handbook reference ', COALESCE(NULLIF(annual.finance_handbook_number, ''), 'not entered'),
          ' · exemption ', COALESCE(exemption.status, 'not requested')) AS target
        FROM annual_enrollments AS annual LEFT JOIN finance_exemption_cases AS exemption
          ON exemption.annual_enrollment_id = annual.id WHERE annual.id = @annualId`, [['annualId', sql.Int, context.annualId]]);
    }
    if (context.enrollmentId) {
      await row('Term enrollment', `SELECT CONCAT(term.school_year, ' · ', term.term, ' · Term ', enrollment.annual_term_number,
          CASE WHEN section.name IS NULL THEN '' ELSE CONCAT(' · ', section.name) END,
          ' · enrollment ', enrollment.enrollment_status, ' · Finance approval ', COALESCE(approval.status, 'not recorded'),
          ' · clearance ', COALESCE(clearance.clearance_status, 'not recorded')) AS target
        FROM enrollments AS enrollment INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN term_finance_approvals AS approval ON approval.enrollment_id = enrollment.id
        LEFT JOIN enrollment_clearances AS clearance ON clearance.enrollment_id = enrollment.id
        WHERE enrollment.id = @enrollmentId AND enrollment.student_id = @studentId`,
      [['enrollmentId', sql.Int, context.enrollmentId], ['studentId', sql.Int, context.studentId]]);
    }
    if (context.specialSubjectId) {
      await row('Special-subject enrollment', `SELECT CONCAT(term.school_year, ' · ', term.term, ' · ', subject.subject_code, ' · ', subject.subject_name,
          ' · arrangement ', special.arrangement_type, CASE WHEN special.modular_subtype IS NULL THEN '' ELSE CONCAT(' · ', special.modular_subtype) END) AS target
        FROM annual_special_subjects AS special INNER JOIN student_subjects AS assignment ON assignment.id = special.student_subject_id
        INNER JOIN subjects AS subject ON subject.id = assignment.subject_id
        INNER JOIN enrollments AS enrollment ON enrollment.id = special.enrollment_id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        WHERE special.id = @specialSubjectId AND special.student_id = @studentId`,
      [['specialSubjectId', sql.BigInt, context.specialSubjectId], ['studentId', sql.Int, context.studentId]]);
    }
    if (context.caseId) {
      await row('Departure review', `SELECT CONCAT(annual.school_year, ' · ', annual.grade_level, ' · ', departure.departure_type,
          ' · effective ', DATE_FORMAT(departure.effective_date, '%Y-%m-%d'), ' · Finance status ', departure.finance_status) AS target
        FROM finance_departure_cases AS departure INNER JOIN annual_enrollments AS annual ON annual.id = departure.annual_enrollment_id
        WHERE departure.id = @caseId`, [['caseId', sql.BigInt, context.caseId]]);
    }
    const legacyTransactionId = context.transactionId || context.paymentTransactionId;
    if (legacyTransactionId) {
      await row('Legacy account payment', `SELECT CONCAT(DATE_FORMAT(transaction_record.created_at, '%Y-%m-%d'), ' · ', transaction_record.transaction_type,
          ' · original amount ₱', CAST(transaction_record.amount AS CHAR(40)), ' · reference ',
          COALESCE(NULLIF(transaction_record.reference_no, ''), 'not entered'),
          ' · currently reconciled ₱', CAST(COALESCE((SELECT SUM(net.net_amount) FROM finance_legacy_reconciliations AS reconciliation
            INNER JOIN v_finance_net_legacy_reconciliations AS net ON net.reconciliation_id = reconciliation.id
            WHERE reconciliation.transaction_id = transaction_record.id), 0) AS CHAR(40)),
          ' · ', CASE WHEN transaction_record.is_legacy_unattributed = 1 THEN 'unattributed historical balance' ELSE 'attributed account entry' END) AS target
        FROM financial_transactions AS transaction_record INNER JOIN financial_accounts AS account
          ON account.id = transaction_record.financial_account_id
        WHERE transaction_record.id = @transactionId AND account.student_id = @studentId`,
      [['transactionId', sql.Int, legacyTransactionId], ['studentId', sql.Int, context.studentId]]);
    }
    if (context.studentId && ['legacy_opening_transfer', 'legacy_account_create', 'legacy_transaction'].includes(action.type)) {
      await row('Legacy account', `SELECT CONCAT(CASE WHEN account.id IS NULL THEN 'No legacy account opened yet'
          ELSE CONCAT('Account balance ₱', CAST(account.balance AS CHAR(40)), ' · ',
            COALESCE((SELECT COUNT(*) FROM financial_transactions AS transaction_record WHERE transaction_record.financial_account_id = account.id), 0), ' recorded entries') END) AS target
        FROM students AS student LEFT JOIN financial_accounts AS account ON account.student_id = student.id
        WHERE student.id = @studentId`, [['studentId', sql.Int, context.studentId]]);
    }
    return details;
  }

  async function calculateReview(tx, action, context, rawInput, locking = false, prepareSuggestions = false) {
    const input = structuredClone(rawInput);
    const request = tx.request();
    const studentId = await resolveStudentId(request, context);
    const resolvedContext = { ...context, ...(studentId ? { studentId } : {}) };
    if (action.type === 'annual_assessment' && context.annualId) {
      const annual = await tx.request().input('annualId', sql.Int, context.annualId)
        .query('SELECT school_year, grade_level, voucher_code FROM annual_enrollments WHERE id = @annualId');
      const parent = annual.recordset?.[0];
      if (parent) Object.assign(resolvedContext, { schoolYear: parent.school_year, gradeLevel: parent.grade_level, voucherCode: parent.voucher_code });
    }
    if (action.type === 'legacy_enrollment_clearance') {
      resolvedContext.enrollmentId = safeIntegerId(input.enrollmentId);
      resolvedContext.paymentTransactionId = safeIntegerId(input.paymentTransactionId);
    }
    if (action.type === 'legacy_transaction' && input.clearEnrollmentId) {
      resolvedContext.enrollmentId = safeIntegerId(input.clearEnrollmentId);
    }
    if (locking && studentId) await lockStudentRows(tx, studentId);
    if (locking) await lockActionTargets(tx, resolvedContext, input);
    const rows = await dependencyRows(tx.request(), studentId, resolvedContext);
    const fingerprint = jsonHash({ action: action.type, context: resolvedContext, rows });
    const preview = {
      actionLabel: action.label,
      studentId: studentId || null,
      schoolYear: resolvedContext.schoolYear || null,
      gradeLevel: resolvedContext.gradeLevel || null,
      voucherCode: resolvedContext.voucherCode || null,
      fields: Object.entries(input).map(([name, value]) => ({ name, value: Array.isArray(value) ? value.map(String) : String(value ?? '') }))
    };
    preview.targetDetails = await actionTargetDetails(tx, action, resolvedContext);
    if (Array.isArray(input.lines)) {
      preview.scheduleLines = input.lines.map((line) => ({
        term: Number(line.termNumber), fee: [line.feeCategory, line.lineName].filter(Boolean).join(' · '),
        installment: line.installment || 'Whole term', amount: line.amount || '0.00', optional: Boolean(line.isOptional)
      }));
    }
    if (Array.isArray(input.rules)) {
      preview.exemptionRules = input.rules.map((rule) => ({
        term: Number(rule.termNumber), coverage: [rule.feeCategory, rule.lineName].filter(Boolean).join(' · ') || 'Matching assessed charges',
        amount: rule.isFullCoverage ? 'Full coverage' : rule.approvedAmount || '—'
      }));
    }
    if (Array.isArray(input.adjustments)) {
      preview.departureAdjustments = input.adjustments.map((adjustment) => ({
        charge: `Charge #${adjustment.chargeId || 'review required'}`, amount: adjustment.amount || '—', reason: adjustment.reason || ''
      }));
    }
    if (['annual_payment', 'annual_credit_allocation', 'legacy_payment_reconciliation'].includes(action.type) && studentId) {
      const dueRows = await tx.request().input('studentId', sql.Int, studentId)
        .query(`SELECT target.target_kind, target.target_id, target.amount_due, target.target_label
          FROM (
          SELECT 'opening' AS target_kind, opening.id AS target_id, CAST(due.amount_due AS CHAR(40)) AS amount_due,
            CONCAT('Verified prior balance · ', opening.source_label) AS target_label,
            0 AS year_order, 0 AS term_order, 0 AS installment_order, opening.created_at AS created_at
          FROM finance_legacy_opening_charges AS opening INNER JOIN v_finance_opening_liability_due AS due
            ON due.opening_charge_id = opening.id
          WHERE opening.student_id = @studentId AND due.amount_due > 0
          UNION ALL
          SELECT 'charge' AS target_kind, charge.id AS target_id, CAST(due.amount_due AS CHAR(40)) AS amount_due,
            CONCAT(annual.school_year, ' · Term ', enrollment.annual_term_number, ' · ', charge.line_name,
              CASE WHEN LOWER(charge.line_name) = 'tuition' THEN CONCAT(' · ', charge.installment) ELSE '' END) AS target_label,
            CAST(REPLACE(SUBSTRING_INDEX(annual.school_year, '-', 1), '/', '') AS UNSIGNED) AS year_order,
            enrollment.annual_term_number AS term_order,
            CASE WHEN LOWER(charge.line_name) = 'tuition' THEN FIELD(LOWER(charge.installment), 'dp', 'prelim', 'midterm', 'finals') ELSE 5 END AS installment_order,
            charge.created_at AS created_at
          FROM assessed_charges AS charge INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
          INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
          INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
          WHERE annual.student_id = @studentId AND due.amount_due > 0
          ) AS target ORDER BY target.year_order, target.term_order, target.installment_order, target.created_at, target.target_id`);
      const eligibleTargets = (dueRows.recordset || []).map((row) => ({
        value: `${row.target_kind}:${row.target_id}`, label: String(row.target_label), balance: String(row.amount_due)
      }));
      preview.editorOptions = { ...(preview.editorOptions || {}), allocationTargets: eligibleTargets };
      if (action.type === 'annual_payment' && input.amount) {
      const amount = /^\d{1,10}(?:\.\d{1,2})?$/.test(String(input.amount).trim())
        ? (() => { const [whole, fraction = ''] = String(input.amount).trim().split('.'); return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')); })()
        : 0n;
      if (amount > 0n) {
        let remaining = amount;
        const suggestions = [];
        for (const row of dueRows.recordset || []) {
          if (remaining <= 0n) break;
          const [whole, fraction = ''] = String(row.amount_due).split('.');
          const due = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
          const applied = due < remaining ? due : remaining;
          suggestions.push({ chargeId: row.target_kind === 'charge' ? String(row.target_id) : null,
            openingLiabilityId: row.target_kind === 'opening' ? String(row.target_id) : null,
            amount: `${applied / 100n}.${String(applied % 100n).padStart(2, '0')}` });
          remaining -= applied;
        }
        const supplied = Array.isArray(input.allocations) ? input.allocations.some((row) => row && row.amount) : false;
        if (!supplied && prepareSuggestions && input.allocationMode !== 'credit') {
          input.allocations = suggestions;
          input.allocationMode = 'suggested';
        }
        preview.suggestedAllocations = suggestions;
        preview.unallocatedCreditAfterSuggestion = `${remaining / 100n}.${String(remaining % 100n).padStart(2, '0')}`;
      }
      }
    }
    if (studentId) {
      const identity = await tx.request().input('studentId', sql.Int, studentId)
        .query(`SELECT student_no, first_name, middle_name, last_name, suffix
          FROM students WHERE id = @studentId`);
      const row = identity.recordset?.[0];
      preview.student = row ? {
        name: [row.first_name, row.middle_name, row.last_name, row.suffix].filter(Boolean).join(' '),
        studentNumber: row.student_no
      } : null;
    }
    if (action.type === 'schedule_create') {
      const scheduleRows = rows.at(-1) || [];
      const active = scheduleRows.find((row) => row.status === 'active');
      preview.activeSchedule = active ? { version: Number(active.version_no), scheduleId: Number(active.id) } : null;
      if (active) input.expectedPreviousSchedule = { scheduleId: Number(active.id), versionNo: Number(active.version_no) };
    }
    if (action.type === 'annual_assessment' && resolvedContext.schoolYear && resolvedContext.gradeLevel && resolvedContext.voucherCode) {
      const schedule = await tx.request().input('scheduleYear', sql.NVarChar(20), resolvedContext.schoolYear)
        .input('scheduleGrade', sql.NVarChar(50), resolvedContext.gradeLevel)
        .input('scheduleVoucher', sql.NVarChar(10), resolvedContext.voucherCode)
        .query(`SELECT schedule.id AS schedule_id, schedule.version_no, line.id AS line_id, line.term_number,
          line.fee_category, line.line_name, line.installment, line.amount, line.is_optional
          FROM finance_schedules AS schedule INNER JOIN finance_schedule_lines AS line ON line.schedule_id = schedule.id
          WHERE schedule.school_year = @scheduleYear AND schedule.grade_level = @scheduleGrade
            AND schedule.voucher_code = @scheduleVoucher AND schedule.status = 'active'
          ORDER BY schedule.version_no DESC, line.term_number, line.id LIMIT 120`);
      const rows = schedule.recordset || [];
      const optionalIds = new Set((Array.isArray(input.optionalLineId) ? input.optionalLineId : [input.optionalLineId]).map(String));
      preview.schedule = rows.length ? { version: Number(rows[0].version_no),
        lines: rows.map((line) => ({ term: Number(line.term_number), fee: `${line.fee_category} · ${line.line_name}`,
          installment: line.installment, amount: String(line.amount), selected: !line.is_optional || optionalIds.has(String(line.line_id)) })) } : null;
    }
    if (action.type === 'departure_review' && context.caseId) {
      const departureCharges = await tx.request().input('caseId', sql.BigInt, context.caseId)
        .query(`SELECT charge.id, annual.school_year, enrollment.annual_term_number, charge.line_name, charge.installment,
            CONCAT(annual.school_year, ' · Term ', enrollment.annual_term_number, ' · ', charge.line_name,
              CASE WHEN LOWER(charge.line_name) = 'tuition' THEN CONCAT(' · ', charge.installment) ELSE '' END) AS label,
            CAST(due.amount_due AS CHAR(40)) AS amount_due
          FROM finance_departure_case_terms AS case_term
          INNER JOIN assessed_charges AS charge ON charge.enrollment_id = case_term.enrollment_id
          INNER JOIN finance_departure_cases AS departure ON departure.id = case_term.departure_case_id
          INNER JOIN annual_enrollments AS annual ON annual.id = departure.annual_enrollment_id
          INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
          INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
          WHERE case_term.departure_case_id = @caseId ORDER BY enrollment.annual_term_number, charge.id`);
      const chargeOptions = (departureCharges.recordset || []).map((row) => ({
        value: `charge:${row.id}`, label: String(row.label), balance: String(row.amount_due)
      }));
      preview.editorOptions = { ...(preview.editorOptions || {}), departureCharges: chargeOptions };
      const labels = new Map(chargeOptions.map((option) => [String(option.value).slice('charge:'.length), option.label]));
      preview.departureAdjustments = (Array.isArray(input.adjustments) ? input.adjustments : []).map((adjustment) => ({
        charge: labels.get(String(adjustment.chargeId)) || 'Balance no longer available',
        amount: adjustment.amount || '—', reason: adjustment.reason || ''
      }));
    }
    if (studentId && ['legacy_transaction', 'legacy_enrollment_clearance'].includes(action.type)) {
      const enrollmentRows = await tx.request().input('studentId', sql.Int, studentId)
        .query(`SELECT enrollment.id, CONCAT(term.school_year, ' · ', term.term,
            CASE WHEN section.name IS NULL THEN '' ELSE CONCAT(' · ', section.name) END) AS label
          FROM enrollments AS enrollment INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
          LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
          LEFT JOIN enrollment_clearances AS clearance ON clearance.enrollment_id = enrollment.id
          WHERE enrollment.student_id = @studentId AND enrollment.enrollment_status = 'pending_payment'
            AND enrollment.finalized_at IS NULL AND COALESCE(clearance.clearance_status, 'pending') = 'pending'
          ORDER BY term.school_year DESC, term.id, enrollment.id`);
      const paymentRows = await tx.request().input('studentId', sql.Int, studentId)
        .query(`SELECT payment.id, DATE_FORMAT(payment.created_at, '%Y-%m-%d') AS event_date,
            CAST(payment.amount AS CHAR(40)) AS amount, payment.reference_no
          FROM financial_transactions AS payment INNER JOIN financial_accounts AS account
            ON account.id = payment.financial_account_id
          WHERE account.student_id = @studentId AND payment.transaction_type = 'payment'
            AND NOT EXISTS (SELECT 1 FROM enrollment_clearances AS clearance WHERE clearance.payment_transaction_id = payment.id)
          ORDER BY payment.created_at DESC, payment.id DESC LIMIT 100`);
      const enrollmentOptions = (enrollmentRows.recordset || []).map((row) => ({ value: String(row.id), label: String(row.label) }));
      const paymentOptions = (paymentRows.recordset || []).map((row) => ({ value: String(row.id),
        label: `${row.event_date} · ₱${row.amount}${row.reference_no ? ` · ${row.reference_no}` : ''}` }));
      preview.editorOptions = { ...(preview.editorOptions || {}), enrollments: enrollmentOptions, payments: paymentOptions };
    }
    const fieldLabels = Object.entries(input)
      .filter(([name, value]) => !['allocations', 'allocationMode', 'rules', 'lines', 'adjustments', 'expectedPreviousSchedule'].includes(name)
        && !/id$/i.test(name) && (value == null || ['string', 'number', 'boolean'].includes(typeof value)))
      .map(([name, value]) => ({ name,
        value: Array.isArray(value) ? value.filter((item) => ['string', 'number', 'boolean'].includes(typeof item)).map(String).join(', ') : String(value ?? '') }));
    const optionSets = preview.editorOptions || {};
    const appendSelectedLabel = (name, label, options, allowMany = false) => {
      const current = input[name];
      const selected = (Array.isArray(current) ? current : [current]).filter((value) => value != null && value !== '');
      if (!selected.length) return;
      const labels = selected.map((value) => options?.find((option) => String(option.value) === String(value))?.label).filter(Boolean);
      if (labels.length) fieldLabels.push({ name: label, value: allowMany ? labels.join(', ') : labels[0] });
    };
    appendSelectedLabel('enrollmentId', 'Enrollment', optionSets.enrollments);
    appendSelectedLabel('clearEnrollmentId', 'Enrollment to clear', optionSets.enrollments);
    appendSelectedLabel('paymentTransactionId', 'Recorded payment', optionSets.payments);
    preview.fields = fieldLabels;
    if (['annual_payment', 'annual_credit_allocation', 'legacy_payment_reconciliation'].includes(action.type)) {
      const allocations = Array.isArray(input.allocations) ? input.allocations : [];
      const chargeIds = allocations.map((row) => safeIntegerId(row.chargeId)).filter(Boolean);
      const openingIds = allocations.map((row) => safeIntegerId(row.openingLiabilityId)).filter(Boolean);
      const targets = new Map();
      async function readTargets(ids, tableKind) {
        if (!ids.length) return;
        const req = tx.request();
        const names = ids.map((id, index) => { const name = `${tableKind}${index}`; req.input(name, sql.BigInt, id); return `@${name}`; });
        const targetRows = tableKind === 'charge'
          ? await req.query(`SELECT charge.id, annual.school_year, annual.grade_level, enrollment.annual_term_number,
              charge.line_name, charge.installment, charge.fee_category,
              CONCAT(annual.school_year, ' · Term ', enrollment.annual_term_number, ' · ', charge.line_name,
                CASE WHEN LOWER(charge.line_name) = 'tuition' THEN CONCAT(' · ', charge.installment) ELSE '' END) AS target_label,
              CAST(due.amount_due AS CHAR(40)) AS amount_due
            FROM assessed_charges AS charge INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
            INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
            INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
            WHERE charge.id IN (${names.join(', ')})`)
          : await req.query(`SELECT opening.id, opening.source_label,
              CONCAT('Verified prior balance · ', opening.source_label) AS target_label,
              CAST(due.amount_due AS CHAR(40)) AS amount_due
            FROM finance_legacy_opening_charges AS opening INNER JOIN v_finance_opening_liability_due AS due ON due.opening_charge_id = opening.id
            WHERE opening.id IN (${names.join(', ')})`);
        for (const target of targetRows.recordset || []) targets.set(`${tableKind}:${target.id}`, target);
      }
      await readTargets(chargeIds, 'charge');
      await readTargets(openingIds, 'opening');
      const targetOptions = [...(preview.editorOptions?.allocationTargets || [])];
      for (const [key, target] of targets.entries()) {
        if (!targetOptions.some((item) => item.value === key)) {
          targetOptions.push({ value: key, label: String(target.target_label), balance: String(target.amount_due || '0.00') });
        }
      }
      preview.editorOptions = { ...(preview.editorOptions || {}), allocationTargets: targetOptions };
      let appliedCents = 0n;
      preview.allocationRows = allocations.map((allocation) => {
        const key = allocation.chargeId ? `charge:${allocation.chargeId}` : `opening:${allocation.openingLiabilityId}`;
        const target = targets.get(key);
        const [whole = '0', fraction = ''] = String(allocation.amount || '0').split('.');
        const amountCents = /^\d+$/.test(whole) && /^\d{0,2}$/.test(fraction) ? BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) : 0n;
        appliedCents += amountCents;
        const currentDue = target?.amount_due ? (() => { const [units, cents = ''] = String(target.amount_due).split('.'); return BigInt(units) * 100n + BigInt(cents.padEnd(2, '0')); })() : 0n;
        const dueAfter = currentDue > amountCents ? currentDue - amountCents : 0n;
        const feeContext = target?.line_name ? `${target.school_year} · Term ${target.annual_term_number} · ${target.line_name} · ${target.installment}`
          : target?.source_label ? `Verified legacy opening · ${target.source_label}` : 'Target requires review';
        return { targetReference: target ? String(target.target_label) : 'Balance no longer available',
          feeContext, amount: `${amountCents / 100n}.${String(amountCents % 100n).padStart(2, '0')}`,
          dueBefore: target?.amount_due || '0.00', dueAfter: `${dueAfter / 100n}.${String(dueAfter % 100n).padStart(2, '0')}` };
      });
      const cashCents = /^\d{1,10}(?:\.\d{1,2})?$/.test(String(input.amount || ''))
        ? (() => { const [units, cents = ''] = String(input.amount).split('.'); return BigInt(units) * 100n + BigInt(cents.padEnd(2, '0')); })() : 0n;
      const remainingCents = cashCents > appliedCents ? cashCents - appliedCents : 0n;
      preview.cashAmount = input.amount || '0.00';
      preview.appliedAmount = `${appliedCents / 100n}.${String(appliedCents % 100n).padStart(2, '0')}`;
      preview.unallocatedCredit = `${remainingCents / 100n}.${String(remainingCents % 100n).padStart(2, '0')}`;
    }
    return { dependencyFingerprint: fingerprint, preview, entityContext: resolvedContext, normalizedInput: input };
  }

  async function previewOutsideTransaction(action, context, input, prepareSuggestions = false) {
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.REPEATABLE_READ);
    try {
      const review = await calculateReview(tx, action, context, input, false, prepareSuggestions);
      await tx.commit();
      return review;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  }

  async function startDraft(actorId, sessionBindingHmac, pathname, body) {
    const action = actionByPath(pathname);
    if (!action) return null;
    const input = normalizeActionInput(action.type, body || {});
    const context = { ...action.context };
    if (action.type === 'schedule_create') {
      context.schoolYear = input.schoolYear;
      context.gradeLevel = input.gradeLevel;
      context.voucherCode = input.voucherCode;
    }
    const review = await previewOutsideTransaction(action, context, input, action.type === 'annual_payment');
    const draft = await drafts.createDraft(actorId, sessionBindingHmac, action.type, review.entityContext, review.normalizedInput, review);
    return draft;
  }

  async function freshReview(actorId, sessionBindingHmac, draftId) {
    const draft = await drafts.getDraft(actorId, draftId);
    if (draft.status !== 'pending') return draft;
    const action = SAFE_ACTIONS.find((item) => item.type === draft.actionType);
    if (!action) throw new Error('The saved finance action is no longer supported.');
    const review = await previewOutsideTransaction(action, draft.entityContext, draft.input);
    if (draft.sessionBindingHmac !== sessionBindingHmac || draft.dependencyFingerprint !== review.dependencyFingerprint || draft.reviewExpired) {
      draft.revision = await drafts.updateDraftInput(actorId, draft.id, sessionBindingHmac, review.normalizedInput, review);
      draft.sessionBindingHmac = sessionBindingHmac;
      draft.dependencyFingerprint = review.dependencyFingerprint;
      draft.preview = review.preview;
      draft.input = review.normalizedInput;
      draft.reviewExpired = false;
      draft.requiresReview = true;
    }
    return draft;
  }

  async function updateDraft(actorId, sessionBindingHmac, draftId, input) {
    const existing = await drafts.getDraft(actorId, draftId);
    if (existing.status !== 'pending') throw new Error('A completed finance review cannot be edited.');
    const action = SAFE_ACTIONS.find((item) => item.type === existing.actionType);
    if (!action) throw new Error('The saved finance action is no longer supported.');
    const normalized = normalizeInput(input);
    const actionInput = normalizeActionInput(action.type, normalized);
    if (action.type === 'schedule_create') {
      for (const key of ['schoolYear', 'gradeLevel', 'voucherCode']) {
        if (String(actionInput[key] || '') !== String(existing.entityContext[key] || '')) {
          throw new FinanceReviewDraftError('Schedule context cannot be changed after the draft starts. Start a new review for another year, grade, or voucher.', 409);
        }
      }
    }
    const review = await previewOutsideTransaction(action, existing.entityContext, actionInput);
    await drafts.updateDraftInput(actorId, draftId, sessionBindingHmac, review.normalizedInput, review);
    return freshReview(actorId, sessionBindingHmac, draftId);
  }

  function boundServices(tx) {
    const boundPool = { request: () => tx.request() };
    const options = { getPool: async () => boundPool, sql, transaction: tx };
    return {
      finance: createFinanceService(options),
      annual: createAnnualFinanceService(options),
      cases: createAnnualFinanceCasesService(options),
      documentClearance: createStudentDocumentFinanceClearanceService(options)
    };
  }

  async function applyReviewedAction(tx, draft, actor) {
    const services = boundServices(tx);
    const input = { ...draft.input, idempotencyKey: draft.idempotencyKey };
    const context = draft.entityContext;
    const actorId = Number(actor.id);
    const studentId = safeIntegerId(context.studentId);
    const writer = ACTION_WRITERS[draft.actionType];
    if (!writer) throw new Error('The finance action is not registered for reviewed commit.');
    const result = await writer({ services, actorId, studentId, context, input });
    return result || { saved: true };
  }

  async function commit(actorId, sessionBindingHmac, draftId, revision, fingerprint) {
    return drafts.commitReviewedDraft({
      actorId, sessionBindingHmac, draftId, revision,
      review: { dependencyFingerprint: fingerprint, preview: {} },
      previewInTransaction: async (tx, draft) => {
        const action = SAFE_ACTIONS.find((item) => item.type === draft.actionType);
        if (!action) throw new Error('The saved finance action is no longer supported.');
        return calculateReview(tx, action, draft.entityContext, draft.input, true);
      },
      applyInTransaction: applyReviewedAction
    });
  }

  return {
    matchesMutation: (pathname) => Boolean(actionByPath(pathname)),
    resolveStudentForAction,
    isReadOnlyPost,
    startDraft,
    freshReview,
    updateDraft,
    getDraft: (actorId, draftId) => drafts.getDraft(actorId, draftId),
    commit,
    discard: (actorId, draftId) => drafts.discardDraft(actorId, draftId),
    listPending: (actorId) => drafts.listPendingDrafts(actorId),
    actionLabel: (type) => SAFE_ACTIONS.find((action) => action.type === type)?.label || 'Finance update',
    afterCommitPath: (draft) => {
      const studentId = safeIntegerId(draft.entityContext?.studentId);
      const result = draft.committedResult || {};
      const accountPath = (view, notice = 'reviewSaved') => studentId
        ? `/finance/students/${studentId}/annual?view=${encodeURIComponent(view)}&notice=${encodeURIComponent(notice)}`
        : '/finance?notice=saved';
      switch (draft.actionType) {
        case 'schedule_create': {
          const params = new URLSearchParams({ notice: 'scheduleCreated' });
          for (const key of ['schoolYear', 'gradeLevel', 'voucherCode']) {
            if (typeof draft.entityContext?.[key] === 'string') params.set(key, draft.entityContext[key]);
          }
          if (Number.isSafeInteger(Number(result.versionNo)) && Number(result.versionNo) > 0) params.set('savedVersion', String(result.versionNo));
          return `/finance/schedules?${params.toString()}`;
        }
        case 'annual_payment': return studentId && Number.isSafeInteger(Number(result.paymentId))
          ? `/finance/students/${studentId}/annual/payments/${Number(result.paymentId)}/confirmation`
          : accountPath('payments', 'paymentRecorded');
        case 'legacy_transaction':
          if (studentId && draft.input?.transactionType === 'payment' && Number.isSafeInteger(Number(result.transactionId))) {
            return `/finance/students/${studentId}/legacy/payments/${Number(result.transactionId)}/confirmation`;
          }
          return studentId ? `/finance/students/${studentId}?notice=reviewSaved` : '/finance/legacy?notice=saved';
        case 'departure_review': return '/finance/departures?notice=saved';
        case 'document_clearance_decision': return '/finance/document-clearance?notice=saved';
        case 'legacy_account_create':
        case 'legacy_enrollment_clearance': return studentId ? `/finance/students/${studentId}?notice=reviewSaved` : '/finance/legacy?notice=saved';
        case 'annual_credit_allocation':
        case 'annual_payment_metadata': return accountPath('payments');
        case 'annual_adjustment':
        case 'annual_fee_comment':
        case 'annual_supplementary_charge':
        case 'annual_special_subject_charge':
        case 'annual_exemption': return accountPath('charges');
        case 'annual_payment_reversal':
        case 'annual_adjustment_reversal':
        case 'annual_allocation_release':
        case 'legacy_reconciliation_release':
        case 'annual_handbook_reference': return accountPath('history');
        case 'annual_assessment':
        case 'term_finance_approval':
        case 'term_clearance':
        case 'voucher_review_resolution': return accountPath('clearance');
        case 'legacy_payment_reconciliation':
        case 'legacy_opening_transfer': return accountPath('history');
        default: return accountPath('overview');
      }
    },
    registeredActions: SAFE_ACTIONS.map(({ type, pattern }) => ({ type, pattern: pattern.source }))
  };
}

module.exports = { createFinanceReviewActionService, SAFE_ACTIONS, ACTION_WRITERS, READ_ONLY_POSTS, actionByPath, isReadOnlyPost, normalizeInput, normalizeActionInput };
