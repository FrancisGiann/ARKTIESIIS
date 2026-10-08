const express = require('express');
const crypto = require('node:crypto');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { normalizeId } = require('../services/financeService');
const { AnnualFinanceError, FINANCE_ROSTER_QUERY_PHASES, createAnnualFinanceService } = require('../services/annualFinanceService');
const { FinanceCasesError, createAnnualFinanceCasesService } = require('../services/annualFinanceCasesService');
const {
  FinanceReportsError, FINANCE_REPORT_QUERY_PHASES, createAnnualFinanceReportsService
} = require('../services/annualFinanceReportsService');
const { FinanceDashboardError, createFinanceDashboardService } = require('../services/financeDashboardService');
const {
  StudentDocumentFinanceClearanceError,
  createStudentDocumentFinanceClearanceService
} = require('../services/studentDocumentFinanceClearanceService');
const { FinanceReviewDraftError } = require('../services/financeReviewDraftService');
const { actionByPath, createFinanceReviewActionService, normalizeActionInput, normalizeFinanceReturnContext } = require('../services/financeReviewActionService');
const { createStatementProjection } = require('../utils/financeStatementProjection');
const { formatFinanceDateTime, manilaWeekStartDate } = require('../utils/financeDateTime');
const { safeErrorDiagnostics } = require('../utils/safeErrorDiagnostics');

const FINANCE_ROSTER_QUERY_PHASE_SET = new Set(FINANCE_ROSTER_QUERY_PHASES);
const FINANCE_REPORT_QUERY_PHASE_SET = new Set(FINANCE_REPORT_QUERY_PHASES);
const RETIRED_LEGACY_ACCOUNT_POST = /^\/students\/\d{1,10}\/(?:account|transactions|enrollment-clearance)$/;

function submittedText(input, name, maxLength) {
  return typeof input?.[name] === 'string' ? input[name].slice(0, maxLength).replace(/[\u0000-\u001f\u007f]/g, '') : '';
}

function financeBackHref(source) {
  const filters = normalizeFinanceReturnContext(source);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) params.set(key, value);
  return `/finance${params.size ? `?${params.toString()}` : ''}`;
}

function paymentRecoveryValues(input = {}) {
  const date = submittedText(input, 'paymentDate', 10);
  const targets = input.allocationTarget == null ? [] : Array.isArray(input.allocationTarget) ? input.allocationTarget : [input.allocationTarget];
  const amounts = input.allocationAmount == null ? [] : Array.isArray(input.allocationAmount) ? input.allocationAmount : [input.allocationAmount];
  return {
    amount: submittedText(input, 'amount', 14),
    paymentDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    referenceNo: submittedText(input, 'referenceNo', 100),
    transmittalReference: submittedText(input, 'transmittalReference', 100),
    receiptIssued: ['0', '1'].includes(input.receiptIssued) ? input.receiptIssued : '0',
    privateRemarks: submittedText(input, 'privateRemarks', 1000),
    allocations: Array.from({ length: Math.min(40, Math.max(targets.length, amounts.length)) }, (_, index) => ({
      target: typeof targets[index] === 'string' && /^(?:charge|opening):\d{1,18}$/.test(targets[index]) ? targets[index] : '',
      amount: typeof amounts[index] === 'string' ? amounts[index].slice(0, 14).replace(/[\u0000-\u001f\u007f]/g, '') : ''
    }))
  };
}

function recoveryFields(input = {}) {
  const blocked = new Set(['_csrf', 'csrfToken', 'idempotencyKey', 'reviewRevision', 'reviewFingerprint']);
  return Object.entries(input && typeof input === 'object' && !Array.isArray(input) ? input : {})
    .filter(([name]) => !blocked.has(name) && !/(?:id|target)$/i.test(name))
    .slice(0, 40)
    .map(([name, value]) => ({
      name: String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()),
      value: (Array.isArray(value) ? value : [value]).slice(0, 40)
        .filter((part) => typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean')
        .map((part) => String(part).slice(0, 1000)).join(', ')
    }))
    .filter((field) => field.value !== '');
}

function createFinanceRouter({ getPool, sql, annualFinanceService, financeCasesService, financeReportsService, financeDashboardService, documentClearanceService, financeReviewActionService, sessionSecret = '', logger = console } = {}) {
  const router = express.Router();
  const annual = annualFinanceService || createAnnualFinanceService({ getPool, sql });
  const cases = financeCasesService || createAnnualFinanceCasesService({ getPool, sql });
  const reports = financeReportsService || createAnnualFinanceReportsService({ getPool, sql });
  const dashboard = financeDashboardService || createFinanceDashboardService({ getPool, sql });
  const documentClearance = documentClearanceService || createStudentDocumentFinanceClearanceService({ getPool, sql });
  const reviewActions = financeReviewActionService || createFinanceReviewActionService({ getPool, sql });

  function sessionBinding(req) {
    if (typeof sessionSecret !== 'string' || sessionSecret.length < 32 || typeof req.sessionID !== 'string' || !req.sessionID) {
      throw new FinanceReviewDraftError('The finance review session could not be verified. Sign in again.', 403);
    }
    return crypto.createHmac('sha256', sessionSecret).update(req.sessionID).digest('hex');
  }

  function reviewFieldLabel(value) {
    const labels = {
      amount: 'Amount', paymentDate: 'Payment date', referenceNo: 'Official receipt/reference (manually entered)',
      receiptIssued: 'Receipt marked issued', privateRemarks: 'Private Finance note', remarks: 'Private Finance note',
      reason: 'Reason', description: 'Description', transactionType: 'Transaction type', allocations: 'Balances receiving payment',
      schoolYear: 'School year', gradeLevel: 'Grade level', voucherCode: 'Voucher',
      lineName: 'Fee name', feeCategory: 'Fee category', installment: 'Installment', termNumber: 'Term',
      isOptional: 'Optional line', approvedAmount: 'Approved amount', isFullCoverage: 'Full coverage',
      chargeId: 'Assessed charge', openingLiabilityId: 'Confirmed previous balance',
      enrollmentId: 'Enrollment', paymentTransactionId: 'Recorded payment', clearEnrollmentId: 'Enrollment to clear',
      expectedStudentId: 'Student account', handbookNumber: 'Finance handbook number', financeHandbookNumber: 'Finance handbook number',
      optionalLineId: 'Optional schedule line', scheduleId: 'Reviewed schedule', scheduleVersion: 'Reviewed schedule version',
      status: 'Decision', clearanceStatus: 'Clearance status', ledgerReviewConfirmed: 'Ledger reviewed',
      paymentArrangement: 'Payment arrangement', financeNote: 'Private Finance note', effectiveDate: 'Effective date',
      departureType: 'Departure type', adjustmentAmount: 'Adjustment amount', reversesAdjustmentId: 'Adjustment being reversed'
    };
    if (labels[value]) return labels[value];
    return String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
      .replace(/^./, (letter) => letter.toUpperCase());
  }

  function reviewEditor(input, draft) {
    const hidden = new Set(['idempotencyKey', 'expectedPreviousSchedule', 'allocationMode', 'studentId', 'expectedStudentId', 'annualId', 'chargeId', 'paymentId', 'transactionId', 'caseId', 'allocationId', 'reconciliationId', 'specialSubjectId', 'requestId']);
    if (draft.actionType === 'schedule_create') for (const name of ['schoolYear', 'gradeLevel', 'voucherCode']) hidden.add(name);
    const options = draft.preview?.editorOptions || {};
    function fieldOptions(name) {
      if (['enrollmentId', 'clearEnrollmentId'].includes(name)) return options.enrollments;
      if (name === 'paymentTransactionId') return options.payments;
      if (name === 'optionalLineId') return options.optionalScheduleLines;
      return null;
    }
    const fields = [];
    for (const [name, value] of Object.entries(input || {})) {
      if (hidden.has(name)) continue;
      if (Array.isArray(value)) {
        const objectRows = value.length === 0 || value.every((row) => row && typeof row === 'object' && !Array.isArray(row));
        if (objectRows) {
          const defaults = {
            allocations: ['target', 'amount'],
            lines: ['termNumber', 'feeCategory', 'lineName', 'installment', 'amount', 'isOptional'],
            rules: ['termNumber', 'feeCategory', 'lineName', 'isFullCoverage', 'approvedAmount'],
            adjustments: ['target', 'amount', 'reason']
          };
          const rows = value.map((row) => {
            if (name === 'allocations' || name === 'adjustments') {
              const target = row.chargeId ? `charge:${row.chargeId}` : row.openingLiabilityId ? `opening:${row.openingLiabilityId}` : '';
              return { target, amount: row.amount || '', ...(name === 'adjustments' ? { reason: row.reason || '' } : {}) };
            }
            return row;
          });
          if (name === 'lines') {
            fields.push({ name, label: reviewFieldLabel(name), kind: 'schedule', lines: rows.map((row, index) => ({ ...row, index })) });
            continue;
          }
          const properties = [...new Set([...rows.flatMap((row) => Object.keys(row)), ...(defaults[name] || [])])]
            .filter((key) => !/Id$/.test(key) && key !== 'target_id');
          const targetOptions = name === 'adjustments' ? options.departureCharges : name === 'allocations' ? options.allocationTargets : null;
          fields.push({ name, label: reviewFieldLabel(name), kind: 'rows', rows, properties: properties.map((key) => ({
            key, label: key === 'target' ? 'Fee or balance' : name === 'allocations' && key === 'amount' ? 'Amount to apply (PHP)' : reviewFieldLabel(key), options: key === 'target' ? targetOptions : null
          })) });
        } else {
          fields.push({ name, label: reviewFieldLabel(name), kind: 'list', values: value, options: fieldOptions(name) });
        }
      } else {
        if (value && typeof value === 'object') continue;
        const valueOptions = fieldOptions(name);
        fields.push({ name, label: reviewFieldLabel(name), kind: valueOptions ? 'select' : 'scalar', value, options: valueOptions,
          multiline: /reason|description|remark|note|arrangement|comment/i.test(name), boolean: typeof value === 'boolean' });
      }
    }
    return fields;
  }

  function reviewPreviewFields(preview) {
    const rows = Array.isArray(preview?.fields) ? preview.fields : [];
    return rows.filter((field) => !/id$/i.test(field.name) && typeof field.value !== 'object')
      .map((field) => ({ ...field, name: reviewFieldLabel(field.name) }));
  }

  function rebuildReviewInput(previous, body, actionType) {
    const input = {};
    const hidden = new Set(['idempotencyKey', 'expectedPreviousSchedule', 'allocationMode']);
    if (actionType === 'schedule_create') for (const name of ['schoolYear', 'gradeLevel', 'voucherCode']) hidden.add(name);
    for (const [name, value] of Object.entries(previous || {})) {
      if (hidden.has(name)) { input[name] = value; continue; }
      if (Array.isArray(value)) {
        const objectRows = value.length === 0 || value.every((row) => row && typeof row === 'object' && !Array.isArray(row));
        if (objectRows) {
          const defaults = {
            allocations: ['target', 'amount'],
            lines: ['termNumber', 'feeCategory', 'lineName', 'installment', 'amount', 'isOptional'],
            rules: ['termNumber', 'feeCategory', 'lineName', 'isFullCoverage', 'approvedAmount'],
            adjustments: ['target', 'amount', 'reason']
          };
          const properties = [...new Set([...value.flatMap((row) => Object.keys(row)), ...(defaults[name] || [])])];
          const rows = [];
          for (let index = 0; index <= value.length && index < 120; index += 1) {
            const row = {};
            for (const key of properties) {
              const field = body[`item_${name}_${index}_${key}`];
              row[key] = field === undefined ? (value[index]?.[key] ?? '') : field;
            }
            if ((name === 'allocations' || name === 'adjustments') && typeof row.target === 'string') {
              const match = /^(charge|opening):(\d{1,18})$/.exec(row.target);
              if (name === 'allocations') {
                row.chargeId = match?.[1] === 'charge' ? match[2] : '';
                row.openingLiabilityId = match?.[1] === 'opening' ? match[2] : '';
              } else row.chargeId = match?.[1] === 'charge' ? match[2] : '';
              delete row.target;
            }
            for (const booleanKey of ['isOptional', 'isFullCoverage']) {
              if (typeof row[booleanKey] === 'string') row[booleanKey] = row[booleanKey] === '1' || row[booleanKey].toLowerCase() === 'true';
            }
            const meaningful = name === 'lines'
              ? [row.lineName, row.amount].some((entry) => entry !== '' && entry != null)
              : name === 'rules'
                ? [row.feeCategory, row.lineName, row.approvedAmount].some((entry) => entry !== '' && entry != null)
                : name === 'allocations' ? [row.chargeId, row.openingLiabilityId, row.amount].some((entry) => entry !== '' && entry != null)
                  : Object.entries(row).some(([key, entry]) => !['termNumber', 'isOptional', 'isFullCoverage'].includes(key) && entry !== '' && entry != null);
            if (meaningful) rows.push(row);
          }
          input[name] = rows;
        } else {
          const values = [];
          for (let index = 0; index <= value.length && index < 120; index += 1) {
            const entry = body[`item_${name}_${index}`];
            if (entry !== undefined && entry !== '') values.push(entry);
          }
          input[name] = body[`field_${name}`] !== undefined
            ? (Array.isArray(body[`field_${name}`]) ? body[`field_${name}`] : [body[`field_${name}`]])
            : values;
        }
      } else if (body[`field_${name}`] !== undefined) {
        const submitted = body[`field_${name}`];
        input[name] = typeof value === 'boolean' ? submitted === '1' : submitted;
      } else input[name] = value;
    }
    return input;
  }

  function renderReview(req, res, draft, { status = 200, error = null, editorInput = draft.input, previewUnavailable = false } = {}) {
    return res.status(status).set('Cache-Control', 'private, no-store').render('finance/review-draft', {
      title: 'Review finance update', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), draft, status,
      actionLabel: reviewActions.actionLabel(draft.actionType), error, previewUnavailable, editorFields: reviewEditor(editorInput, draft),
      previewFields: reviewPreviewFields(draft.preview)
    });
  }

  function isRecoverableFinanceValidation(error) {
    return [FinanceReviewDraftError, AnnualFinanceError, FinanceCasesError, StudentDocumentFinanceClearanceError]
      .some((ErrorType) => error instanceof ErrorType) && [400, 409, 422].includes(Number(error.status));
  }

  function financeAccountViewForAction(actionType) {
    const historyActions = new Set([
      'annual_handbook_reference', 'annual_payment_reversal', 'annual_adjustment_reversal',
      'annual_allocation_release', 'legacy_reconciliation_release', 'legacy_payment_reconciliation', 'legacy_opening_transfer'
    ]);
    const paymentsActions = new Set(['annual_payment', 'annual_credit_allocation', 'annual_payment_metadata']);
    const clearanceActions = new Set(['term_clearance', 'term_finance_approval', 'voucher_review_resolution']);
    const chargesActions = new Set([
      'annual_adjustment', 'annual_fee_comment', 'annual_supplementary_charge', 'annual_special_subject_charge', 'annual_exemption'
    ]);
    if (historyActions.has(actionType)) return 'history';
    if (paymentsActions.has(actionType)) return 'payments';
    if (clearanceActions.has(actionType)) return 'clearance';
    if (chargesActions.has(actionType) || actionType === 'annual_assessment') return 'charges';
    return 'overview';
  }

  async function renderInitialReviewRecovery(req, res, error) {
    const action = actionByPath(req.path);
    const status = Number(error.status) || 400;
    let normalizedInput = {};
    if (action) {
      try { normalizedInput = normalizeActionInput(action.type, req.body || {}); } catch { /* Preserve only bounded action-specific values below. */ }
    }
    const failedAction = action ? { type: action.type, path: req.path, context: action.context, input: normalizedInput } : null;
    if (action?.type === 'schedule_create') {
      return renderScheduleWorkspace(req, res, { status, error: error.message, formValues: req.body || {} });
    }
    if (action?.type === 'document_clearance_decision') {
      return renderDocumentClearanceQueue(req, res, { status, error: error.message, filters: req.body || {}, failedAction });
    }
    if (action?.type === 'annual_payment' && action.context.studentId) {
      return renderAnnualStudent(req, res, action.context.studentId, {
        status, error: error.message, paymentValues: paymentRecoveryValues(req.body || {}), accountViewOverride: 'payments', failedAction
      });
    }
    if (action?.type === 'legacy_opening_transfer' && action.context.studentId) {
      try {
        const openingPreview = await annual.previewLegacyOpeningLiability(req.authUser.id, action.context.studentId);
        return renderAnnualStudent(req, res, action.context.studentId, {
          status, error: error.message, openingPreview, accountViewOverride: 'history', failedAction
        });
      } catch { /* Reopen the account below with the entered values. */ }
    }
    if (action?.type === 'departure_review') return renderDepartureQueue(req, res, { status, error: error.message, failedAction });
    if (action?.type === 'annual_assessment') {
      try {
        const preview = await annual.annualAssessmentPreview(req.authUser.id, action.context.annualId, normalizedInput.optionalLineId);
        return renderAnnualStudent(req, res, preview.parent.student_id, {
          status, error: error.message, preview, accountViewOverride: 'charges', failedAction
        });
      } catch { /* Try resolving the owning account below. */ }
    }
    if (action?.context.studentId) {
      return renderAnnualStudent(req, res, action.context.studentId, {
        status, error: error.message, accountViewOverride: financeAccountViewForAction(action.type),
        preservedValues: recoveryFields(req.body || {}), failedAction
      });
    }
    if (action && typeof reviewActions.resolveStudentForAction === 'function') {
      try {
        const studentId = await reviewActions.resolveStudentForAction(req.authUser.id, req.path);
        if (studentId) return renderAnnualStudent(req, res, studentId, {
          status, error: error.message,
          accountViewOverride: financeAccountViewForAction(action.type),
          failedAction, preservedValues: recoveryFields(req.body || {})
        });
      } catch { /* Keep entered values in the safe recovery view below. */ }
    }
    const returnHref = action?.type === 'departure_review' ? '/finance/departures'
      : action?.type === 'document_clearance_decision' ? '/finance/document-clearance'
        : action?.type === 'schedule_create' ? '/finance/schedules' : '/finance/overview';
    return res.status(status).set('Cache-Control', 'private, no-store').render('finance/initial-recovery', {
      title: 'Review finance details', currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
      actionLabel: action?.label || 'Finance update', error: error.message,
      preservedValues: recoveryFields(req.body || {}), returnHref
    });
  }

  router.get('/review-drafts', async (req, res) => {
    try {
      const drafts = await reviewActions.listPending(req.authUser.id);
      return res.set('Cache-Control', 'private, no-store').render('finance/review-drafts', {
        title: 'Unfinished finance reviews', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), drafts,
        actionLabel: (type) => reviewActions.actionLabel(type),
        isRetiredAction: (type) => reviewActions.isRetiredAction?.(type) === true,
        formatFinanceDateTime
      });
    } catch (error) {
      if (error instanceof FinanceReviewDraftError) return res.status(error.status).render('error', { title: 'Unfinished reviews', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Unfinished reviews could not be loaded.' });
    }
  });

  router.get('/review-drafts/:draftId', async (req, res) => {
    try {
      const binding = sessionBinding(req);
      const draft = await reviewActions.freshReview(req.authUser.id, binding, req.params.draftId);
      if (draft.status === 'committed') return res.redirect(303, reviewActions.afterCommitPath(draft));
      return renderReview(req, res, draft, { status: req.query.stale === '1' || draft.requiresReview ? 409 : 200 });
    } catch (error) {
      if (error instanceof FinanceReviewDraftError) return res.status(error.status).render('error', { title: 'Finance review', message: error.message });
      if (isRecoverableFinanceValidation(error)) {
        try {
          const draft = await reviewActions.getDraft(req.authUser.id, req.params.draftId);
          if (draft.status === 'pending') return renderReview(req, res, { ...draft, requiresReview: true }, {
            status: error.status, error: error.message, previewUnavailable: true
          });
        } catch { /* Keep ownership and database failures sanitized below. */ }
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The finance review could not be loaded.' });
    }
  });

  router.post('/review-drafts/:draftId/update', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      const existing = await reviewActions.getDraft(req.authUser.id, req.params.draftId);
      const input = rebuildReviewInput(existing.input, req.body || {}, existing.actionType);
      const draft = await reviewActions.updateDraft(req.authUser.id, sessionBinding(req), req.params.draftId, input);
      return res.redirect(303, `/finance/review-drafts/${encodeURIComponent(draft.id)}`);
    } catch (error) {
      try {
        let draft = await reviewActions.getDraft(req.authUser.id, req.params.draftId);
        const input = rebuildReviewInput(draft.input, req.body || {}, draft.actionType);
        if (isRecoverableFinanceValidation(error)) {
          if (draft.status === 'pending') {
            try { draft = await reviewActions.freshReview(req.authUser.id, sessionBinding(req), req.params.draftId); } catch { /* Keep the saved review visible for correction. */ }
            return renderReview(req, res, { ...draft, requiresReview: true }, {
              status: error.status, error: error.message, editorInput: input, previewUnavailable: true
            });
          }
        }
      } catch { /* Return a sanitized response below when ownership or service access fails. */ }
      const status = error instanceof FinanceReviewDraftError ? error.status : isRecoverableFinanceValidation(error) ? error.status : 503;
      return res.status(status).set('Cache-Control', 'private, no-store').render('error', {
        title: 'Edit finance review', message: status < 500 ? error.message : 'The saved finance details could not be updated.'
      });
    }
  });

  router.post('/review-drafts/:draftId/commit', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      const result = await reviewActions.commit(req.authUser.id, sessionBinding(req), req.params.draftId,
        req.body?.revision, req.body?.dependencyFingerprint);
      if (result.stale) return res.redirect(303, `/finance/review-drafts/${encodeURIComponent(req.params.draftId)}?stale=1`);
      const draft = await reviewActions.getDraft(req.authUser.id, req.params.draftId);
      return res.redirect(303, reviewActions.afterCommitPath(draft));
    } catch (error) {
      if (isRecoverableFinanceValidation(error)) {
        try {
          let draft = await reviewActions.getDraft(req.authUser.id, req.params.draftId);
          if (draft.status === 'pending') {
            try { draft = await reviewActions.freshReview(req.authUser.id, sessionBinding(req), req.params.draftId); } catch { /* Preserve saved values for correction. */ }
            return renderReview(req, res, { ...draft, requiresReview: true }, {
              status: error.status, error: error.message, previewUnavailable: true
            });
          }
        } catch { /* Return sanitized authorization response below. */ }
      }
      const status = error instanceof FinanceReviewDraftError ? error.status : isRecoverableFinanceValidation(error) ? error.status : 503;
      return res.status(status).set('Cache-Control', 'private, no-store').render('error', {
        title: 'Save finance update', message: status < 500 ? error.message : 'The finance update could not be saved.'
      });
    }
  });

  router.post('/review-drafts/:draftId/discard', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      await reviewActions.discard(req.authUser.id, req.params.draftId);
      return res.redirect(303, '/finance/review-drafts');
    } catch (error) {
      if (error instanceof FinanceReviewDraftError) return res.status(error.status).render('error', { title: 'Discard finance review', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The finance review could not be discarded.' });
    }
  });

  router.use(async (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (RETIRED_LEGACY_ACCOUNT_POST.test(req.path)) return res.status(410).set('Cache-Control', 'private, no-store').render('error', {
      title: 'Legacy account action retired', message: 'Legacy account creation, transactions, and enrollment clearance have been retired. Use annual Finance for current account updates.'
    });
    if (!hasValidCsrfToken(req)) return res.status(403).set('Cache-Control', 'private, no-store').render('error', {
      title: 'Forbidden', message: 'The form session expired. Reload the page and try again.'
    });
    if (reviewActions.isReadOnlyPost(req.path)) return next();
    if (!reviewActions.matchesMutation(req.path)) return res.status(404).set('Cache-Control', 'private, no-store').render('error', {
      title: 'Finance update unavailable', message: 'This finance action is not registered for reviewed saving.'
    });
    try {
      const draft = await reviewActions.startDraft(req.authUser.id, sessionBinding(req), req.path, req.body);
      if (!draft) return res.status(404).render('error', { title: 'Finance update unavailable', message: 'This finance action is not available.' });
      return res.redirect(303, `/finance/review-drafts/${encodeURIComponent(draft.id)}`);
    } catch (error) {
      if (isRecoverableFinanceValidation(error)) return renderInitialReviewRecovery(req, res, error);
      const status = 503;
      return res.status(status).set('Cache-Control', 'private, no-store').render('error', {
        title: 'Finance review', message: 'The finance action could not be prepared for review.'
      });
    }
  });

  function repeated(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
  }

  function allocationsFromForm(body = {}) {
    const targets = repeated(body.allocationTarget);
    const chargeIds = repeated(body.chargeId);
    const amounts = repeated(body.allocationAmount);
    const count = Math.max(targets.length, chargeIds.length, amounts.length);
    return Array.from({ length: count }, (_, index) => {
      const target = typeof targets[index] === 'string' ? targets[index] : '';
      const match = /^(charge|opening):(\d{1,18})$/.exec(target);
      return {
        chargeId: match?.[1] === 'charge' ? match[2] : (chargeIds[index] || ''),
        openingLiabilityId: match?.[1] === 'opening' ? match[2] : '',
        amount: amounts[index] ?? ''
      };
    }).filter((row) => row.amount !== '');
  }

  function scheduleLinesFromForm(body = {}) {
    const terms = repeated(body.termNumber);
    const categories = repeated(body.feeCategory);
    const names = repeated(body.lineName);
    const installments = repeated(body.installment);
    const amounts = repeated(body.lineAmount);
    const optionalIndexes = new Set(repeated(body.optionalIndex).map(String));
    return terms.map((termNumber, index) => ({
      termNumber, feeCategory: categories[index], lineName: names[index], installment: installments[index],
      amount: amounts[index], isOptional: optionalIndexes.has(String(index))
    })).filter((line) => [line.feeCategory, line.lineName, line.installment, line.amount].some((value) => value !== '' && value != null));
  }

  function scheduleFormState(input = null, prefillLines = [], context = {}) {
    const submitted = input !== null;
    const body = input || {};
    const formText = (value, maxLength) => typeof value === 'string'
      ? value.slice(0, maxLength).replace(/[\u0000-\u001f\u007f]/g, '')
      : '';
    const canonicalInstallments = new Set(['dp', 'prelim', 'midterm', 'finals']);
    const tuitionKey = (line) => `${Number(line.term_number)}|${String(line.installment || '').trim().toLowerCase()}`;
    const canonicalTuition = prefillLines.filter((line) => String(line.fee_category).toLowerCase() === 'tuition'
      && String(line.line_name).trim().toLowerCase() === 'tuition'
      && canonicalInstallments.has(String(line.installment || '').trim().toLowerCase()));
    const tuitionAmounts = new Map(canonicalTuition.map((line) => [tuitionKey(line), String(line.amount)]));
    const legacyWholeTermTuition = prefillLines.some((line) => String(line.fee_category).toLowerCase() === 'tuition'
      && String(line.line_name).trim().toLowerCase() === 'tuition'
      && !canonicalInstallments.has(String(line.installment || '').trim().toLowerCase()));
    const existingOtherFees = prefillLines.filter((line) => !(String(line.fee_category).toLowerCase() === 'tuition'
      && String(line.line_name).trim().toLowerCase() === 'tuition'));
    const terms = submitted ? repeated(body.termNumber) : existingOtherFees.map((line) => String(line.term_number));
    const categories = submitted ? repeated(body.feeCategory) : existingOtherFees.map((line) => String(line.fee_category));
    const names = submitted ? repeated(body.lineName) : existingOtherFees.map((line) => String(line.line_name));
    const installments = submitted ? repeated(body.installment) : existingOtherFees.map((line) => String(line.installment));
    const amounts = submitted ? repeated(body.lineAmount) : existingOtherFees.map((line) => String(line.amount));
    const count = Math.min(120, Math.max(12, terms.length, categories.length, names.length, installments.length, amounts.length));
    const optionalIndexes = new Set((submitted ? repeated(body.optionalIndex).map(Number) : existingOtherFees.map((line, index) => line.is_optional ? index + 12 : -1))
      .map(String)
      .filter((value) => typeof value === 'string' && /^\d{1,3}$/.test(value))
      .map(Number)
      .filter((index) => index < count));
    const rawIdempotencyKey = formText(body.idempotencyKey, 36);
    const idempotencyKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawIdempotencyKey)
      ? rawIdempotencyKey
      : crypto.randomUUID();
    return {
      schoolYear: formText(body.schoolYear, 20) || formText(context.schoolYear || '', 20),
      gradeLevel: formText(body.gradeLevel, 50) || formText(context.gradeLevel || '', 50),
      voucherCode: formText(body.voucherCode, 10) || formText(context.voucherCode || '', 10),
      idempotencyKey,
      legacyWholeTermTuition,
      lines: Array.from({ length: count }, (_, index) => {
        const isRequiredTuition = index < 12;
        const termNumber = Math.floor(index / 4) + 1;
        const installment = ['DP', 'Prelim', 'Midterm', 'Finals'][index % 4];
        return {
        isRequiredTuition,
        termNumber: isRequiredTuition ? String(termNumber) : (submitted ? formText(terms[index], 3) : '1'),
        feeCategory: isRequiredTuition ? 'tuition' : (submitted ? formText(categories[index], 40) : 'other'),
        lineName: isRequiredTuition ? 'Tuition' : formText(names[index], 120),
        installment: isRequiredTuition ? installment : (submitted ? formText(installments[index], 40) : ''),
        amount: formText(isRequiredTuition
          ? submitted ? amounts[index] : tuitionAmounts.get(`${termNumber}|${installment.toLowerCase()}`)
          : amounts[index], 14),
        isOptional: !isRequiredTuition && submitted && optionalIndexes.has(index)
      }; })
    };
  }

  function exemptionRulesFromForm(body = {}) {
    const terms = repeated(body.ruleTerm);
    const categories = repeated(body.ruleCategory);
    const names = repeated(body.ruleLineName);
    const amounts = repeated(body.ruleAmount);
    const fullIndexes = new Set(repeated(body.fullCoverageIndex).map(String));
    return terms.map((termNumber, index) => ({
      termNumber, feeCategory: categories[index] || '', lineName: names[index] || '',
      isFullCoverage: fullIndexes.has(String(index)), approvedAmount: amounts[index] || (fullIndexes.has(String(index)) ? '0.00' : '')
    })).filter((rule) => [rule.feeCategory, rule.lineName, rule.approvedAmount].some((value) => value !== ''));
  }

  function departureAdjustmentsFromForm(body = {}) {
    const charges = repeated(body.departureChargeId);
    const amounts = repeated(body.departureAdjustmentAmount);
    const reasons = repeated(body.departureAdjustmentReason);
    return charges.map((chargeId, index) => ({ chargeId, amount: amounts[index] || '', reason: reasons[index] || '' }))
      .filter((row) => row.chargeId && row.amount);
  }

  async function renderAnnualRoster(req, res, { status = 200, error = null } = {}) {
    try {
      const result = typeof annual.listRosterPage === 'function'
        ? await annual.listRosterPage(req.authUser.id, req.query)
        : await annual.listRoster(req.authUser.id, req.query);
      const rows = result.rows;
      return res.status(status).set('Cache-Control', 'private, no-store').render('finance/annual-roster', {
        title: 'Student accounts', currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
        rows, filters: req.query, schoolYears: result.options.schoolYears, terms: result.options.terms, sections: result.options.sections,
        pagination: result.pagination || null,
        error, notice: req.query.notice === 'saved' ? 'Finance update saved.' : null
      });
    } catch (loadError) {
      if (loadError instanceof AnnualFinanceError) return res.status(loadError.status).render('error', { title: 'Student accounts', message: loadError.message });
      const supportReference = crypto.randomUUID().slice(0, 12);
      logger.error?.('Finance roster request failed.', {
        supportReference,
        operation: 'finance.roster.load',
        queryPhase: FINANCE_ROSTER_QUERY_PHASE_SET.has(loadError?.financeRosterQueryPhase)
          ? loadError.financeRosterQueryPhase : 'unclassified',
        ...safeErrorDiagnostics(loadError)
      });
      return res.status(503).set('Cache-Control', 'private, no-store').render('error', {
        title: 'Service Unavailable', message: `Student accounts are temporarily unavailable. Support reference: ${supportReference}.`
      });
    }
  }

  async function renderScheduleWorkspace(req, res, { status = 200, error = null, formValues = null } = {}) {
    try {
      const schedules = await annual.listSchedules(req.authUser.id);
      const scheduleGroups = new Map();
      for (const row of schedules) {
        if (!scheduleGroups.has(Number(row.id))) scheduleGroups.set(Number(row.id), { ...row, lines: [] });
        if (row.line_id) scheduleGroups.get(Number(row.id)).lines.push(row);
      }
      const groups = [...scheduleGroups.values()];
      const voucherCodes = ['PUB', 'ESC', 'NV'];
      const voucherCounts = Object.fromEntries(voucherCodes.map((voucher) => [voucher, groups.filter((item) => item.voucher_code === voucher).length]));
      const submittedVoucher = formValues?.voucherCode;
      const selectedVoucher = voucherCodes.includes(req.query.voucherCode) ? req.query.voucherCode
        : voucherCodes.includes(submittedVoucher) ? submittedVoucher : 'PUB';
      const voucherSchedules = groups.filter((item) => item.voucher_code === selectedVoucher);
      const schoolYears = [...new Set(voucherSchedules.map((item) => String(item.school_year)))].sort().reverse();
      const requestedYear = typeof req.query.schoolYear === 'string' && /^\d{4}[-/]\d{4}$/.test(req.query.schoolYear) ? req.query.schoolYear
        : typeof formValues?.schoolYear === 'string' && /^\d{4}[-/]\d{4}$/.test(formValues.schoolYear) ? formValues.schoolYear : '';
      const selectedSchoolYear = requestedYear || String(voucherSchedules.find((item) => item.status === 'active')?.school_year || schoolYears[0] || '');
      const gradeSchedules = voucherSchedules.filter((item) => String(item.school_year) === selectedSchoolYear);
      const grades = [...new Set(gradeSchedules.map((item) => item.grade_level))].sort();
      const requestedGrade = ['Grade 11', 'Grade 12'].includes(req.query.gradeLevel) ? req.query.gradeLevel
        : ['Grade 11', 'Grade 12'].includes(formValues?.gradeLevel) ? formValues.gradeLevel : '';
      const selectedGrade = requestedGrade || gradeSchedules.find((item) => item.status === 'active')?.grade_level || grades[0] || '';
      const context = { schoolYear: selectedSchoolYear, gradeLevel: selectedGrade, voucherCode: selectedVoucher };
      const activeSchedule = gradeSchedules.find((item) => item.grade_level === selectedGrade && item.status === 'active') || null;
      const scheduleForm = scheduleFormState(formValues, activeSchedule?.lines || [], context);
      const savedVersion = typeof req.query.savedVersion === 'string' && /^\d{1,4}$/.test(req.query.savedVersion)
        ? Number(req.query.savedVersion) : null;
      return res.status(status).render('finance/schedules', {
        title: 'Finance schedules', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), schedules,
        scheduleForm, idempotencyKey: scheduleForm.idempotencyKey, error,
        notice: req.query.notice === 'scheduleCreated'
          ? (savedVersion ? `New active schedule version ${savedVersion} was saved.` : 'A new versioned schedule was saved.')
          : null,
        scheduleContext: { ...context, voucherCodes, voucherCounts, schoolYears, grades, activeSchedule }
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Finance schedules could not be loaded.' });
    }
  }

  async function renderAnnualStudent(req, res, studentId, { status = 200, error = null, preview = null, openingPreview = null,
    tokenOverrides = {}, paymentValues = null, accountViewOverride = null, preservedValues = [], failedAction = null } = {}) {
    let failedDependency = null;
    const load = (dependency, operation) => Promise.resolve().then(operation).catch((loadError) => {
      if (!failedDependency) failedDependency = dependency;
      throw loadError;
    });
    try {
      const [ledger, schedules, financeCases] = await Promise.all([
        load('student_ledger', () => annual.getStudentLedger(req.authUser.id, studentId, 'finance')),
        load('fee_schedules', () => annual.listSchedules(req.authUser.id)),
        load('finance_cases', () => cases.getStudentCases(req.authUser.id, studentId))
      ]);
      const accountProjection = createStatementProjection(ledger);
      const tokens = { payment: crypto.randomUUID(), assessment: crypto.randomUUID(), ...tokenOverrides };
      for (const payment of ledger.availablePayments) tokens[`allocation:${payment.payment_id}`] = crypto.randomUUID();
      for (const payment of ledger.events.filter((event) => event.event_type === 'payment')) {
        tokens[`paymentReversal:${payment.source_id}`] = crypto.randomUUID();
      }
      for (const adjustment of ledger.adjustments.filter((item) => !item.reverses_adjustment_id)) tokens[`adjustmentReversal:${adjustment.adjustment_id}`] = crypto.randomUUID();
      for (const charge of ledger.charges) tokens[`adjustment:${charge.charge_id}`] = crypto.randomUUID();
      for (const charge of ledger.charges) tokens[`feeComment:${charge.charge_id}`] = crypto.randomUUID();
      for (const term of ledger.terms) {
        tokens[`supplementary:${term.enrollment_id}`] = crypto.randomUUID();
        tokens[`clearance:${term.enrollment_id}`] = crypto.randomUUID();
      }
      for (const annualEnrollmentId of new Set(ledger.terms.map((term) => Number(term.annual_enrollment_id)))) {
        tokens[`voucherReview:${annualEnrollmentId}`] = crypto.randomUUID();
      }
      for (const legacy of ledger.legacyCredits) tokens[`reconciliation:${legacy.transaction_id}`] = crypto.randomUUID();
      for (const allocation of ledger.allocationHistory) tokens[`releaseAllocation:${allocation.allocation_id}`] = crypto.randomUUID();
      for (const reconciliation of ledger.legacyReconciliationHistory) tokens[`releaseReconciliation:${reconciliation.reconciliation_id}`] = crypto.randomUUID();
      for (const payment of ledger.payments) tokens[`paymentMetadata:${payment.payment_id}`] = crypto.randomUUID();
      for (const annualEnrollmentId of new Set(ledger.terms.map((term) => Number(term.annual_enrollment_id)))) {
        tokens[`exemption:${annualEnrollmentId}`] = crypto.randomUUID();
        tokens[`financeHandbook:${annualEnrollmentId}`] = crypto.randomUUID();
      }
      for (const subject of financeCases.specialSubjects) tokens[`specialSubject:${subject.special_subject_id}`] = crypto.randomUUID();
      tokens.openingTransfer = crypto.randomUUID();
      const accountViews = ['overview', 'payments', 'charges', 'clearance', 'history'];
      const accountView = accountViews.includes(accountViewOverride) ? accountViewOverride
        : accountViews.includes(req.query.view) ? req.query.view : 'overview';
      const backParams = new URLSearchParams();
      for (const key of ['Search', 'SchoolYear', 'TermId', 'GradeLevel', 'SectionId', 'Cluster', 'Strand', 'VoucherCode', 'Status', 'FinanceStatus', 'Installment', 'Page']) {
        if (typeof req.query[`back${key}`] === 'string' && req.query[`back${key}`]) backParams.set(key[0].toLowerCase() + key.slice(1), req.query[`back${key}`]);
      }
      const accountTabs = accountViews.map((view) => ({ view, label: ({ overview: 'Overview', payments: 'Payments', charges: 'Fees', clearance: 'Term account clearance', history: 'History' })[view] }));
      return res.status(status).set('Cache-Control', 'private, no-store').render('finance/annual-student', {
        title: 'Student account', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), ledger,
        annualFeeBalance: accountProjection.summary.annualFeeBalance,
        hasEarlierAccountBalance: accountProjection.summary.showPreviousAccountBalance,
        hasPreviouslyConfirmedBalance: accountProjection.summary.showPreviouslyConfirmedBalance,
        chargeBreakdown: accountProjection.charges, chargeGroups: accountProjection.chargeGroups, schedules,
        financeCases, preview, openingPreview, tokens, error, paymentValues, preservedValues, failedAction, notice: req.query.notice || null,
        accountView, accountTabs, backHref: `/finance${backParams.size ? `?${backParams.toString()}` : ''}`
      });
    } catch (loadError) {
      if (loadError instanceof AnnualFinanceError) return res.status(loadError.status).render('error', { title: 'Student account', message: loadError.message });
      if (loadError instanceof FinanceCasesError) return res.status(loadError.status).render('error', { title: 'Student account', message: loadError.message });
      const supportReference = crypto.randomUUID().slice(0, 12);
      logger.error?.('Annual student account load failed.', {
        supportReference, operation: 'finance.annual_student.load', dependency: failedDependency || 'account_render',
        ...safeErrorDiagnostics(loadError)
      });
      return res.status(503).set('Cache-Control', 'private, no-store').render('error', {
        title: 'Service Unavailable', message: `The student account could not be loaded. Support reference: ${supportReference}.`
      });
    }
  }

  async function performAnnualAction(req, res, studentId, callback, notice, tokenName = null, recovery = null) {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      await callback();
      return res.redirect(303, `/finance/students/${studentId}/annual?notice=${encodeURIComponent(notice)}`);
    } catch (error) {
      if (error instanceof AnnualFinanceError || error instanceof FinanceCasesError) {
        if (error.status === 403) return res.status(403).render('error', { title: 'Forbidden', message: error.message });
        const tokenOverrides = tokenName && typeof req.body?.idempotencyKey === 'string' ? { [tokenName]: req.body.idempotencyKey } : {};
        const failedAction = recovery?.failedActionPath
          ? { path: recovery.failedActionPath, input: req.body || {} } : null;
        return renderAnnualStudent(req, res, studentId, {
          status: error.status, error: error.message, tokenOverrides, failedAction,
          accountViewOverride: recovery?.accountView || null
        });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The finance update could not be saved.' });
    }
  }

  async function renderDocumentClearanceQueue(req, res, { status = 200, error = null, filters = req.query, failedAction = null } = {}) {
    try {
      const queue = await documentClearance.getFinanceQueue(req.authUser.id, filters);
      queue.rows = queue.rows.map((row) => ({ ...row, decisionKeys: {
        approve: crypto.randomUUID(), hold: crypto.randomUUID(), withdraw: crypto.randomUUID()
      } }));
      return res.status(status).set('Cache-Control', 'private, no-store').render('finance/document-clearance', {
        title: 'Document request fee review', currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req), queue, error, failedAction,
        notice: req.query.notice === 'decisionRecorded' ? 'Finance decision recorded.' : null
      });
    } catch (loadError) {
      if (loadError instanceof StudentDocumentFinanceClearanceError) {
        return res.status(loadError.status).set('Cache-Control', 'private, no-store').render('finance/document-clearance', {
          title: 'Document request fee review', currentUser: req.authUser,
          csrfToken: ensureCsrfToken(req), queue: { rows: [], filters: { search: '', status: '', page: 1 } },
          error: loadError.message, notice: null
        });
      }
      return res.status(503).set('Cache-Control', 'private, no-store').render('error', {
        title: 'Service Unavailable', message: 'The document request fee queue could not be loaded.'
      });
    }
  }

  router.get('/document-clearance', (req, res) => renderDocumentClearanceQueue(req, res));

  router.post('/document-clearance/:requestId/decision', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).set('Cache-Control', 'private, no-store').render('error', {
      title: 'Forbidden', message: 'The form session expired. Reload the page and try again.'
    });
    try {
      await documentClearance.decideClearance(req.authUser.id, req.params.requestId, req.body);
      const query = new URLSearchParams();
      for (const key of ['search', 'status', 'page']) {
        if (typeof req.body[key] === 'string' && req.body[key]) query.set(key, req.body[key]);
      }
      query.set('notice', 'decisionRecorded');
      return res.redirect(303, `/finance/document-clearance?${query.toString()}`);
    } catch (error) {
      if (error instanceof StudentDocumentFinanceClearanceError) {
        return renderDocumentClearanceQueue(req, res, { status: error.status, error: error.message, filters: req.body });
      }
      return res.status(503).set('Cache-Control', 'private, no-store').render('error', {
        title: 'Service Unavailable', message: 'The finance clearance decision could not be saved.'
      });
    }
  });

  router.get('/overview', async (req, res) => {
    try {
      const overview = await dashboard.getOverview(req.authUser.id, req.query);
      return res.status(200).set('Cache-Control', 'private, no-store').render('finance/overview', {
        title: 'Finance overview', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), overview, filters: req.query
      });
    } catch (error) {
      if (error instanceof FinanceDashboardError) {
        return res.status(error.status).render('error', { title: 'Finance overview', message: error.message });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The finance overview could not be loaded.' });
    }
  });
  router.get('/', (req, res) => renderAnnualRoster(req, res));
  router.get('/legacy', (_req, res) => res.status(410).set('Cache-Control', 'private, no-store').render('error', {
    title: 'Earlier account history retired', message: 'The earlier account history workspace has been retired. Open Student accounts to review balances and payments.'
  }));
  router.get('/schedules', (req, res) => renderScheduleWorkspace(req, res));
  router.get('/reports', async (req, res) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const view = ['collections', 'allocations', 'corrections', 'term-balances'].includes(req.query.view) ? req.query.view : 'collections';
    const filters = {
      fromDate: typeof req.query.fromDate === 'string' ? req.query.fromDate : today,
      toDate: typeof req.query.toDate === 'string' ? req.query.toDate : today,
      view
    };
    try {
      const report = await reports.reports(req.authUser.id, filters);
      return res.set('Cache-Control', 'private, no-store').render('finance/reports', {
        title: 'Finance reports', currentUser: req.authUser, report, filters, error: null,
        today, weekStart: manilaWeekStartDate(today),
        monthStart: `${today.slice(0, 8)}01`
      });
    } catch (error) {
      if (error instanceof FinanceReportsError && error.status < 500) return res.status(error.status).render('finance/reports', {
        title: 'Finance reports', currentUser: req.authUser, report: null, filters, error: error.message,
        today, weekStart: manilaWeekStartDate(today), monthStart: `${today.slice(0, 8)}01`
      });
      const supportReference = crypto.randomUUID().slice(0, 12);
      const diagnosticsError = error instanceof FinanceReportsError ? error.cause || error : error;
      const queryPhase = error instanceof FinanceReportsError && FINANCE_REPORT_QUERY_PHASE_SET.has(error.queryPhase)
        ? error.queryPhase : diagnosticsError?.financeReportQueryPhase;
      logger.error?.('Finance reports request failed.', {
        supportReference, operation: 'finance.reports.load',
        ...(FINANCE_REPORT_QUERY_PHASE_SET.has(queryPhase) ? { queryPhase } : {}),
        ...safeErrorDiagnostics(diagnosticsError)
      });
      return res.status(error instanceof FinanceReportsError ? error.status : 503).set('Cache-Control', 'private, no-store').render('finance/reports', {
        title: 'Finance reports', currentUser: req.authUser, report: null, filters,
        error: `Finance reports could not be loaded. Support reference: ${supportReference}.`,
        today, weekStart: manilaWeekStartDate(today), monthStart: `${today.slice(0, 8)}01`
      });
    }
  });
  router.get('/reports/details', async (req, res) => {
    try {
      const detail = await reports.reportDetails(req.authUser.id, req.query);
      return res.set('Cache-Control', 'private, no-store').render('finance/report-details', {
        title: 'Finance report details', currentUser: req.authUser, detail, filters: req.query
      });
    } catch (error) {
      if (error instanceof FinanceReportsError && error.status < 500) {
        return res.status(error.status).render('error', { title: 'Finance report details', message: error.message });
      }
      const supportReference = crypto.randomUUID().slice(0, 12);
      const diagnosticsError = error instanceof FinanceReportsError ? error.cause || error : error;
      const queryPhase = error instanceof FinanceReportsError && FINANCE_REPORT_QUERY_PHASE_SET.has(error.queryPhase)
        ? error.queryPhase : diagnosticsError?.financeReportQueryPhase;
      logger.error?.('Finance report details request failed.', {
        supportReference, operation: 'finance.reports.details',
        ...(FINANCE_REPORT_QUERY_PHASE_SET.has(queryPhase) ? { queryPhase } : {}),
        ...safeErrorDiagnostics(diagnosticsError)
      });
      return res.status(error instanceof FinanceReportsError ? error.status : 503).render('error', {
        title: 'Service Unavailable', message: `Finance report details could not be loaded. Support reference: ${supportReference}.`
      });
    }
  });
  async function renderDepartureQueue(req, res, { status = 200, error = null, failedAction = null } = {}) {
    try {
      const rows = await cases.listPendingDepartureCases(req.authUser.id);
      const grouped = new Map();
      for (const row of rows) {
        let departure = grouped.get(Number(row.departure_case_id));
        if (!departure) {
          departure = { ...row, terms: [] };
          grouped.set(Number(row.departure_case_id), departure);
        }
        let term = departure.terms.find((item) => Number(item.enrollment_id) === Number(row.enrollment_id));
        if (!term) {
          term = { enrollment_id: row.enrollment_id, annual_term_number: row.annual_term_number, academic_activity_review_required: row.academic_activity_review_required, charges: [] };
          departure.terms.push(term);
        }
        if (row.charge_id) term.charges.push(row);
      }
      const departures = [...grouped.values()].map((item) => ({ ...item, idempotencyKey: crypto.randomUUID() }));
      return res.status(status).set('Cache-Control', 'private, no-store').render('finance/departures', {
        title: 'Stopped or transferred finance review', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), departures,
        failedAction, error, notice: req.query.notice === 'saved' ? 'Finance review saved for a stopped or transferred student.' : null
      });
    } catch (error) {
      if (error instanceof FinanceCasesError) return res.status(error.status).render('error', { title: 'Stopped or transferred finance review', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The stopped or transferred review queue could not be loaded.' });
    }
  }

  router.get('/departures', (req, res) => renderDepartureQueue(req, res));

  router.post('/schedules', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      const lines = scheduleLinesFromForm(req.body || {});
      await annual.createSchedule(req.authUser.id, { ...req.body, lines });
      return res.redirect(303, '/finance/schedules?notice=scheduleCreated');
    } catch (error) {
      if (error instanceof AnnualFinanceError) return renderScheduleWorkspace(req, res, {
        status: error.status, error: error.message, formValues: req.body || {}
      });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The finance schedule could not be saved.' });
    }
  });

  router.get('/students/:id/annual', async (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return renderAnnualStudent(req, res, studentId);
  });

  router.get('/students/:id/statement', async (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      const ledger = createStatementProjection(await annual.getStudentLedger(req.authUser.id, studentId, 'finance'));
      return res.set('Cache-Control', 'private, no-store').render('finance/statement', {
        title: 'Statement of Account', currentUser: req.authUser, ledger, printMode: true, formatFinanceDateTime
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The statement could not be loaded.' });
    }
  });

  router.get('/students/:id/annual/payments/:paymentId/confirmation', async (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      const confirmation = await annual.getAnnualPaymentConfirmation(req.authUser.id, studentId, req.params.paymentId, 'finance');
      return res.set('Cache-Control', 'private, no-store').render('finance/payment-confirmation', {
        title: 'Payment confirmation', currentUser: req.authUser, confirmation, kind: 'annual', formatFinanceDateTime,
        backHref: financeBackHref(req.query)
      });
    } catch (error) {
      const status = error instanceof AnnualFinanceError ? error.status : 503;
      return res.status(status).set('Cache-Control', 'private, no-store').render('error', {
        title: 'Payment confirmation', message: status < 500 ? error.message : 'The payment confirmation could not be loaded.'
      });
    }
  });

  router.get('/students/:id/legacy/payments/:paymentId/confirmation', async (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      const confirmation = await annual.getLegacyPaymentConfirmation(req.authUser.id, studentId, req.params.paymentId, 'finance');
      return res.set('Cache-Control', 'private, no-store').render('finance/payment-confirmation', {
        title: 'Legacy payment confirmation', currentUser: req.authUser, confirmation, kind: 'legacy', formatFinanceDateTime
      });
    } catch (error) {
      const status = error instanceof AnnualFinanceError ? error.status : 503;
      return res.status(status).set('Cache-Control', 'private, no-store').render('error', {
        title: 'Payment confirmation', message: status < 500 ? error.message : 'The legacy payment confirmation could not be loaded.'
      });
    }
  });

  router.post('/annual/:annualId/assessment-preview', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    const annualId = normalizeId(req.params.annualId);
    if (!annualId) return res.status(404).render('error', { title: 'Not Found', message: 'Annual enrollment not found.' });
    try {
      const preview = await annual.annualAssessmentPreview(req.authUser.id, annualId, req.body?.optionalLineId);
      return renderAnnualStudent(req, res, Number(preview.parent.student_id), { preview });
    } catch (error) {
      if (error instanceof AnnualFinanceError) return res.status(error.status).render('error', { title: 'Assessment preview', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The assessment preview could not be loaded.' });
    }
  });

  router.post('/annual/:annualId/assessment', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    const annualId = normalizeId(req.params.annualId);
    if (!annualId) return res.status(404).render('error', { title: 'Not Found', message: 'Annual enrollment not found.' });
    try {
      const preview = await annual.annualAssessmentPreview(req.authUser.id, annualId, req.body?.optionalLineId);
      await annual.confirmAnnualAssessment(req.authUser.id, annualId, req.body?.optionalLineId, {
        idempotencyKey: req.body?.idempotencyKey, scheduleId: req.body?.scheduleId,
        scheduleVersion: req.body?.scheduleVersion, voucherCode: req.body?.voucherCode
      });
      return res.redirect(303, `/finance/students/${preview.parent.student_id}/annual?notice=assessmentPosted`);
    } catch (error) {
      if (error instanceof AnnualFinanceError || error instanceof FinanceCasesError) return res.status(error.status).render('error', { title: 'Annual assessment', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The annual assessment could not be posted.' });
    }
  });

  router.post('/students/:id/annual/payments', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.recordPayment(req.authUser.id, studentId, { ...req.body, allocations: allocationsFromForm(req.body) }), 'paymentRecorded', 'payment');
  });
  router.post('/students/:id/annual/credits/:paymentId/allocate', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.allocateExistingCredit(req.authUser.id, studentId, req.params.paymentId, { ...req.body, allocations: allocationsFromForm(req.body) }), 'creditAllocated', `allocation:${req.params.paymentId}`);
  });
  router.post('/students/:id/annual/charges/:chargeId/adjustments', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.recordChargeAdjustment(req.authUser.id, studentId, req.params.chargeId, req.body), 'adjustmentRecorded', `adjustment:${req.params.chargeId}`);
  });
  router.post('/students/:id/annual/:annualId/handbook-number', (req, res) => {
    const studentId = normalizeId(req.params.id);
    const annualId = normalizeId(req.params.annualId);
    if (!studentId || !annualId) return res.status(404).render('error', { title: 'Not Found', message: 'Annual enrollment was not found.' });
    return performAnnualAction(req, res, studentId, () => annual.updateFinanceHandbookNumber(req.authUser.id, annualId, {
      ...req.body, expectedStudentId: studentId
    }), 'handbookNumberUpdated', `financeHandbook:${annualId}`);
  });
  router.post('/students/:id/annual/charges/:chargeId/comments', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.addFeeComment(req.authUser.id, studentId, req.params.chargeId, req.body), 'feeCommentAdded', `feeComment:${req.params.chargeId}`);
  });
  router.post('/students/:id/annual/terms/:enrollmentId/supplementary-charges', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.addSupplementaryCharge(req.authUser.id, studentId, req.params.enrollmentId, req.body), 'supplementaryChargeAdded', `supplementary:${req.params.enrollmentId}`, {
      accountView: 'charges', failedActionPath: `/students/${studentId}/annual/terms/${req.params.enrollmentId}/supplementary-charges`
    });
  });
  router.post('/students/:id/annual/special-subjects/:specialSubjectId/bill', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => cases.billSpecialSubject(req.authUser.id, studentId, req.params.specialSubjectId, req.body), 'specialSubjectBilled', `specialSubject:${req.params.specialSubjectId}`);
  });
  router.post('/students/:id/annual/:annualId/exemptions', (req, res) => {
    const studentId = normalizeId(req.params.id);
    const annualId = normalizeId(req.params.annualId);
    if (!studentId || !annualId) return res.status(404).render('error', { title: 'Not Found', message: 'Annual enrollment was not found.' });
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    return cases.approveExemptionCase(req.authUser.id, annualId, { ...req.body, expectedStudentId: studentId, rules: exemptionRulesFromForm(req.body) })
      .then((result) => res.redirect(303, `/finance/students/${result.studentId}/annual?notice=exemptionApproved`))
      .catch((error) => error instanceof FinanceCasesError
        ? renderAnnualStudent(req, res, studentId, {
          status: error.status, error: error.message, tokenOverrides: { [`exemption:${annualId}`]: req.body?.idempotencyKey },
          accountViewOverride: 'charges', failedAction: { path: `/students/${studentId}/annual/${annualId}/exemptions`, input: req.body || {} }
        })
        : res.status(503).render('error', { title: 'Service Unavailable', message: 'The exemption could not be recorded.' }));
  });
  router.post('/departure-cases/:caseId/review', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      await cases.reviewDepartureCase(req.authUser.id, req.params.caseId, {
        ...req.body, adjustments: departureAdjustmentsFromForm(req.body)
      });
      return res.redirect(303, '/finance/departures?notice=saved');
    } catch (error) {
      if (error instanceof FinanceCasesError) return res.status(error.status).render('error', { title: 'Stopped or transferred finance review', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The Finance review could not be saved.' });
    }
  });
  router.post('/students/:id/annual/payments/:paymentId/reverse', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.reversePayment(req.authUser.id, studentId, req.params.paymentId, req.body), 'paymentReversed', `paymentReversal:${req.params.paymentId}`);
  });
  router.post('/students/:id/annual/adjustments/:adjustmentId/reverse', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.reverseAdjustment(req.authUser.id, studentId, req.params.adjustmentId, req.body), 'adjustmentReversed', `adjustmentReversal:${req.params.adjustmentId}`);
  });
  router.post('/students/:id/annual/legacy-payments/:transactionId/reconcile', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.reconcileLegacyPayment(req.authUser.id, studentId, req.params.transactionId, { ...req.body, allocations: allocationsFromForm(req.body) }), 'legacyPaymentReconciled', `reconciliation:${req.params.transactionId}`);
  });
  router.post('/students/:id/annual/allocations/:allocationId/release', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.releasePaymentAllocation(req.authUser.id, studentId, req.params.allocationId, req.body), 'allocationReleased', `releaseAllocation:${req.params.allocationId}`);
  });
  router.post('/students/:id/annual/legacy-reconciliations/:reconciliationId/release', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.releaseLegacyReconciliation(req.authUser.id, studentId, req.params.reconciliationId, req.body), 'legacyReconciliationReleased', `releaseReconciliation:${req.params.reconciliationId}`);
  });
  router.post('/students/:id/annual/payments/:paymentId/metadata', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.updatePaymentMetadata(req.authUser.id, studentId, req.params.paymentId, req.body), 'paymentMetadataUpdated', `paymentMetadata:${req.params.paymentId}`);
  });
  router.post('/students/:id/annual/legacy-opening/preview', async (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      const openingPreview = await annual.previewLegacyOpeningLiability(req.authUser.id, studentId);
      return renderAnnualStudent(req, res, studentId, { openingPreview });
    } catch (error) {
      if (error instanceof AnnualFinanceError) return renderAnnualStudent(req, res, studentId, { status: error.status, error: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The legacy opening-liability preview could not be loaded.' });
    }
  });
  router.post('/students/:id/annual/legacy-opening/transfer', (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return performAnnualAction(req, res, studentId, () => annual.transferLegacyOpeningLiability(req.authUser.id, studentId, req.body), 'legacyOpeningTransferred', 'openingTransfer');
  });
  router.post('/annual/terms/:enrollmentId/approval', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      const result = await annual.approveTerm(req.authUser.id, req.params.enrollmentId, req.body);
      return res.redirect(303, `/finance/students/${normalizeId(result.studentId)}/annual?notice=termApproved`);
    } catch (error) {
      if (error instanceof AnnualFinanceError) return res.status(error.status).render('error', { title: 'Finance approval', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The term approval could not be saved.' });
    }
  });
  router.post('/annual/:annualId/voucher-review-resolution', async (req, res) => {
    const annualEnrollmentId = normalizeId(req.params.annualId);
    if (!annualEnrollmentId) return res.status(404).render('error', { title: 'Not Found', message: 'Annual enrollment was not found.' });
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      const result = await annual.resolveVoucherReview(req.authUser.id, annualEnrollmentId, req.body);
      return res.redirect(303, `/finance/students/${normalizeId(result.studentId)}/annual?notice=voucherReviewResolved`);
    } catch (error) {
      if (error instanceof AnnualFinanceError) return res.status(error.status).render('error', { title: 'Voucher review', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The voucher review could not be saved.' });
    }
  });
  router.post('/annual/terms/:enrollmentId/clearance', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    const studentId = normalizeId(req.body?.studentId);
    if (!studentId) return res.status(400).render('error', { title: 'Clearance', message: 'Student account was not specified.' });
    return performAnnualAction(req, res, studentId, () => annual.signTermClearance(req.authUser.id, req.params.enrollmentId, req.body), 'termClearanceSigned', 'clearance', {
      accountView: 'clearance', failedActionPath: `/annual/terms/${req.params.enrollmentId}/clearance`
    });
  });

  router.get('/students/:id', async (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return res.redirect(303, `/finance/students/${studentId}/annual`);
  });

  return router;
}

module.exports = { createFinanceRouter };
