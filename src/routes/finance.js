const express = require('express');
const crypto = require('node:crypto');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { FinanceServiceError, createFinanceService, normalizeId, normalizeSearchTerm } = require('../services/financeService');
const { AnnualFinanceError, createAnnualFinanceService } = require('../services/annualFinanceService');
const { FinanceCasesError, createAnnualFinanceCasesService } = require('../services/annualFinanceCasesService');
const { FinanceReportsError, createAnnualFinanceReportsService } = require('../services/annualFinanceReportsService');
const { FinanceDashboardError, createFinanceDashboardService } = require('../services/financeDashboardService');
const {
  StudentDocumentFinanceClearanceError,
  createStudentDocumentFinanceClearanceService
} = require('../services/studentDocumentFinanceClearanceService');
const { isDuplicateKeyError } = require('../config/database');

const notices = {
  accountCreated: 'Financial account created.',
  transactionRecorded: 'Financial transaction recorded.',
  existingPaymentCleared: 'The selected recorded payment was assigned to the enrollment clearance.'
};

function formValues(input = {}) {
  const value = (key, maxLength) => typeof input?.[key] === 'string' ? input[key].slice(0, maxLength) : '';
  return {
    transactionType: value('transactionType', 30),
    amount: value('amount', 32),
    description: value('description', 500),
    referenceNo: value('referenceNo', 100),
    clearEnrollmentId: value('clearEnrollmentId', 10),
    confirmEnrollmentClearance: value('confirmEnrollmentClearance', 1)
  };
}

function searchTermFromQuery(req) {
  try {
    return normalizeSearchTerm(req.query.search);
  } catch {
    return '';
  }
}

function detailUrl(req, studentId, notice) {
  const query = new URLSearchParams();
  const searchTerm = searchTermFromQuery(req);
  if (searchTerm) query.set('search', searchTerm);
  if (notice) query.set('notice', notice);
  const suffix = query.toString();
  return `/finance/students/${studentId}${suffix ? `?${suffix}` : ''}`;
}

function createFinanceRouter({ getPool, sql, financeService, annualFinanceService, financeCasesService, financeReportsService, financeDashboardService, documentClearanceService } = {}) {
  const router = express.Router();
  const service = financeService || createFinanceService({ getPool, sql });
  const annual = annualFinanceService || createAnnualFinanceService({ getPool, sql });
  const cases = financeCasesService || createAnnualFinanceCasesService({ getPool, sql });
  const reports = financeReportsService || createAnnualFinanceReportsService({ getPool, sql });
  const dashboard = financeDashboardService || createFinanceDashboardService({ getPool, sql });
  const documentClearance = documentClearanceService || createStudentDocumentFinanceClearanceService({ getPool, sql });

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

  function scheduleFormState(input = null) {
    const submitted = input !== null;
    const body = input || {};
    const formText = (value, maxLength) => typeof value === 'string'
      ? value.slice(0, maxLength).replace(/[\u0000-\u001f\u007f]/g, '')
      : '';
    const terms = repeated(body.termNumber);
    const categories = repeated(body.feeCategory);
    const names = repeated(body.lineName);
    const installments = repeated(body.installment);
    const amounts = repeated(body.lineAmount);
    const count = Math.min(120, Math.max(12, terms.length, categories.length, names.length, installments.length, amounts.length));
    const optionalIndexes = new Set(repeated(body.optionalIndex)
      .filter((value) => typeof value === 'string' && /^\d{1,3}$/.test(value))
      .map(Number)
      .filter((index) => index < count));
    const rawIdempotencyKey = formText(body.idempotencyKey, 36);
    const idempotencyKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawIdempotencyKey)
      ? rawIdempotencyKey
      : crypto.randomUUID();
    return {
      schoolYear: formText(body.schoolYear, 20),
      gradeLevel: formText(body.gradeLevel, 50),
      voucherCode: formText(body.voucherCode, 10),
      idempotencyKey,
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
        amount: formText(amounts[index], 14),
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
        title: 'Annual finance roster', currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
        rows, filters: req.query, schoolYears: result.options.schoolYears, terms: result.options.terms, sections: result.options.sections,
        pagination: result.pagination || null,
        error, notice: req.query.notice === 'saved' ? 'Finance update saved.' : null
      });
    } catch (loadError) {
      if (loadError instanceof AnnualFinanceError) return res.status(loadError.status).render('error', { title: 'Finance roster', message: loadError.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The annual finance roster is temporarily unavailable.' });
    }
  }

  async function renderScheduleWorkspace(req, res, { status = 200, error = null, formValues = null } = {}) {
    try {
      const schedules = await annual.listSchedules(req.authUser.id);
      const scheduleForm = scheduleFormState(formValues);
      return res.status(status).render('finance/schedules', {
        title: 'Finance schedules', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), schedules,
        scheduleForm, idempotencyKey: scheduleForm.idempotencyKey, error,
        notice: req.query.notice === 'scheduleCreated' ? 'A new versioned schedule was saved.' : null
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Finance schedules could not be loaded.' });
    }
  }

  async function renderAnnualStudent(req, res, studentId, { status = 200, error = null, preview = null, openingPreview = null, tokenOverrides = {} } = {}) {
    try {
      const [ledger, schedules, financeCases] = await Promise.all([
        annual.getStudentLedger(req.authUser.id, studentId, 'finance'),
        annual.listSchedules(req.authUser.id),
        cases.getStudentCases(req.authUser.id, studentId)
      ]);
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
      return res.status(status).set('Cache-Control', 'private, no-store').render('finance/annual-student', {
        title: 'Annual student account', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), ledger, schedules,
        financeCases, preview, openingPreview, tokens, error, notice: req.query.notice || null
      });
    } catch (loadError) {
      if (loadError instanceof AnnualFinanceError) return res.status(loadError.status).render('error', { title: 'Annual student account', message: loadError.message });
      if (loadError instanceof FinanceCasesError) return res.status(loadError.status).render('error', { title: 'Annual student account', message: loadError.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The annual student account could not be loaded.' });
    }
  }

  async function performAnnualAction(req, res, studentId, callback, notice, tokenName = null) {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      await callback();
      return res.redirect(303, `/finance/students/${studentId}/annual?notice=${encodeURIComponent(notice)}`);
    } catch (error) {
      if (error instanceof AnnualFinanceError || error instanceof FinanceCasesError) {
        if (error.status === 403) return res.status(403).render('error', { title: 'Forbidden', message: error.message });
        const tokenOverrides = tokenName && typeof req.body?.idempotencyKey === 'string' ? { [tokenName]: req.body.idempotencyKey } : {};
        return renderAnnualStudent(req, res, studentId, { status: error.status, error: error.message, tokenOverrides });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The finance update could not be saved.' });
    }
  }

  async function renderWorkspace(req, res, { status = 200, searchTerm = req.query.search || '', searchError = null } = {}) {
    try {
      const [result, pendingEnrollments] = await Promise.all([
        service.searchStudents(searchTerm),
        service.listPendingEnrollmentClearances?.(req.authUser.id) || []
      ]);
      const recentAccounts = !result.searchTerm && service.listRecentAccounts
        ? await service.listRecentAccounts(req.authUser.id)
        : [];
      return res.status(status).set('Cache-Control', 'private, no-store').render('finance/workspace', {
        title: 'Finance Workspace',
        currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req),
        searchTerm: result.searchTerm,
        searchSuffix: result.searchTerm ? `?search=${encodeURIComponent(result.searchTerm)}` : '',
        students: result.students,
        recentAccounts,
        pendingEnrollments,
        searchError,
        student: null,
        account: null,
        transactions: [],
        error: null,
        notice: notices[req.query.notice] || null,
        transactionValues: formValues()
      });
    } catch (error) {
      if (error instanceof FinanceServiceError) {
        return res.status(error.status).render('finance/workspace', {
          title: 'Finance Workspace', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), searchTerm: '', students: [],
          searchSuffix: '',
          searchError: error.message, recentAccounts: [], student: null, account: null, transactions: [], error: null,
          notice: null, transactionValues: formValues(), pendingEnrollments: []
        });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The finance workspace is temporarily unavailable.' });
    }
  }

  async function renderStudent(req, res, studentId, { status = 200, error = null, transactionValues = {} } = {}) {
    try {
      const result = await service.getStudentAccount(studentId);
      if (!result) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
      const searchTerm = searchTermFromQuery(req);
      const searchSuffix = searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : '';
      return res.status(status).render('finance/workspace', {
        title: 'Financial Account',
        currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req),
        searchTerm,
        searchSuffix,
        students: [],
        searchError: null,
        student: result.student,
        account: result.account,
        transactions: result.transactions,
        pendingEnrollments: result.pendingEnrollments || [],
        availableEnrollmentPayments: result.availableEnrollmentPayments || [],
        error,
        notice: notices[req.query.notice] || null,
        transactionValues: formValues(transactionValues)
      });
    } catch (loadError) {
      if (loadError instanceof FinanceServiceError && loadError.status === 409) {
        return res.redirect(303, `/finance/students/${studentId}/annual`);
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The financial account could not be loaded.' });
    }
  }

  async function renderDocumentClearanceQueue(req, res, { status = 200, error = null, filters = req.query } = {}) {
    try {
      const queue = await documentClearance.getFinanceQueue(req.authUser.id, filters);
      queue.rows = queue.rows.map((row) => ({ ...row, decisionKeys: {
        approve: crypto.randomUUID(), hold: crypto.randomUUID(), withdraw: crypto.randomUUID()
      } }));
      return res.status(status).set('Cache-Control', 'private, no-store').render('finance/document-clearance', {
        title: 'Document finance clearance', currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req), queue, error, notice: req.query.notice === 'decisionRecorded' ? 'Finance decision recorded.' : null
      });
    } catch (loadError) {
      if (loadError instanceof StudentDocumentFinanceClearanceError) {
        return res.status(loadError.status).set('Cache-Control', 'private, no-store').render('finance/document-clearance', {
          title: 'Document finance clearance', currentUser: req.authUser,
          csrfToken: ensureCsrfToken(req), queue: { rows: [], filters: { search: '', status: '', page: 1 } },
          error: loadError.message, notice: null
        });
      }
      return res.status(503).set('Cache-Control', 'private, no-store').render('error', {
        title: 'Service Unavailable', message: 'The document clearance queue could not be loaded.'
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
  router.get('/legacy', (req, res) => renderWorkspace(req, res));
  router.get('/schedules', (req, res) => renderScheduleWorkspace(req, res));
  router.get('/reports', async (req, res) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const filters = {
      fromDate: typeof req.query.fromDate === 'string' ? req.query.fromDate : today,
      toDate: typeof req.query.toDate === 'string' ? req.query.toDate : today
    };
    try {
      const report = await reports.reports(req.authUser.id, filters);
      return res.set('Cache-Control', 'private, no-store').render('finance/reports', {
        title: 'Finance reports', currentUser: req.authUser, report, filters, error: null
      });
    } catch (error) {
      if (error instanceof FinanceReportsError) return res.status(error.status).render('finance/reports', {
        title: 'Finance reports', currentUser: req.authUser, report: null, filters, error: error.message
      });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Finance reports could not be loaded.' });
    }
  });
  router.get('/departures', async (req, res) => {
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
      return res.set('Cache-Control', 'private, no-store').render('finance/departures', {
        title: 'Departure finance review', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), departures,
        error: null, notice: req.query.notice === 'saved' ? 'Finance reviewed the departure case.' : null
      });
    } catch (error) {
      if (error instanceof FinanceCasesError) return res.status(error.status).render('error', { title: 'Departure finance review', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Departure cases could not be loaded.' });
    }
  });

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
      const ledger = await annual.getStudentLedger(req.authUser.id, studentId, 'finance');
      return res.set('Cache-Control', 'private, no-store').render('finance/statement', { title: 'Statement of Account', currentUser: req.authUser, ledger, printMode: true });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The statement could not be loaded.' });
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
    return performAnnualAction(req, res, studentId, () => annual.addSupplementaryCharge(req.authUser.id, studentId, req.params.enrollmentId, req.body), 'supplementaryChargeAdded', `supplementary:${req.params.enrollmentId}`);
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
        ? renderAnnualStudent(req, res, studentId, { status: error.status, error: error.message, tokenOverrides: { [`exemption:${annualId}`]: req.body?.idempotencyKey } })
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
      if (error instanceof FinanceCasesError) return res.status(error.status).render('error', { title: 'Departure finance review', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The departure review could not be saved.' });
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
    return performAnnualAction(req, res, studentId, () => annual.signTermClearance(req.authUser.id, req.params.enrollmentId, req.body), 'termClearanceSigned', 'clearance');
  });

  router.get('/students/:id', async (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      const ledger = await annual.getStudentLedger(req.authUser.id, studentId, 'finance');
      if (ledger.terms.some((term) => term.intake_status !== 'legacy')) return renderAnnualStudent(req, res, studentId);
      return renderStudent(req, res, studentId);
    } catch (error) {
      if (error instanceof AnnualFinanceError) return res.status(error.status).render('error', { title: 'Finance account', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The finance account could not be loaded.' });
    }
  });

  router.post('/students/:id/account', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await service.createAccount(req.authUser.id, studentId);
      return res.redirect(303, detailUrl(req, studentId, 'accountCreated'));
    } catch (error) {
      if (error instanceof FinanceServiceError && error.status === 403) {
        return res.status(403).render('error', { title: 'Forbidden', message: 'Finance access is no longer active. Sign in again.' });
      }
      if (error instanceof FinanceServiceError) return renderStudent(req, res, studentId, { status: error.status, error: error.message });
      if (isDuplicateKeyError(error)) {
        return renderStudent(req, res, studentId, { status: 409, error: 'This student already has a financial account.' });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The financial account could not be created.' });
    }
  });

  router.post('/students/:id/transactions', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await service.recordTransaction(req.authUser.id, studentId, req.body);
      return res.redirect(303, detailUrl(req, studentId, 'transactionRecorded'));
    } catch (error) {
      if (error instanceof FinanceServiceError) {
        if (error.status === 403) {
          return res.status(403).render('error', { title: 'Forbidden', message: 'Finance access is no longer active. Sign in again.' });
        }
        return renderStudent(req, res, studentId, { status: error.status, error: error.message, transactionValues: req.body });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The financial transaction could not be recorded.' });
    }
  });

  router.post('/students/:id/enrollment-clearance', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await service.clearEnrollmentWithExistingPayment(
        req.authUser.id, studentId, req.body?.enrollmentId, req.body?.paymentTransactionId,
        req.body?.confirmEnrollmentClearance
      );
      return res.redirect(303, detailUrl(req, studentId, 'existingPaymentCleared'));
    } catch (error) {
      if (error instanceof FinanceServiceError) {
        if (error.status === 403) {
          return res.status(403).render('error', { title: 'Forbidden', message: 'Finance access is no longer active. Sign in again.' });
        }
        return renderStudent(req, res, studentId, { status: error.status, error: error.message });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The enrollment clearance could not be updated.' });
    }
  });

  return router;
}

module.exports = { createFinanceRouter, formValues };
