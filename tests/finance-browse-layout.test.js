const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { createFinanceRouter } = require('../src/routes/finance');
const { AnnualFinanceError, createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { formatMoney } = require('../src/utils/formatMoney');

const viewsDirectory = path.join(__dirname, '../views/finance');

async function renderFinanceView(name, locals) {
  return ejs.renderFile(path.join(viewsDirectory, name + '.ejs'), {
    title: 'Finance test', formatMoney, failedAction: null, preservedValues: [], paymentValues: null,
    clearanceValues: {}, transactionValues: {}, formValues: {}, ...locals
  });
}

test('finance annual roster pages annual records and groups term placements under each summary', async () => {
  const observed = [];
  const annualRows = [
    {
      annual_enrollment_id: 10, student_id: 22, school_year: '2026-2027', grade_level: 'Grade 11',
      voucher_code: 'ESC', voucher_category: 'A', intake_status: 'active', student_no: 'S-22',
      first_name: 'Ari', middle_name: null, last_name: 'Kim', suffix: null,
      registrar_confirmation_id: 14, assessed_voucher_code: 'PUB', assessed_schedule_version: 2,
      voucher_review_required: true, voucher_review_reason: 'Assessment snapshot differs.',
      annual_balance: '12345.67', unattributed_legacy_balance: '0.00', opening_liability_due: '0.00',
      enrollment_id: 81, annual_term_number: 1, enrollment_status: 'pending_payment', term_scope_status: 'applicable',
      term_id: 1, term: 'Term 1', section_id: 3, section_name: 'Grade 11 ABM A', cluster: 'ABM',
      strand: 'ABM', modality: 'onsite', current_term_due: '2500.01', signed_clearance_status: null
    },
    {
      annual_enrollment_id: 10, student_id: 22, school_year: '2026-2027', grade_level: 'Grade 11',
      voucher_code: 'ESC', voucher_category: 'A', intake_status: 'active', student_no: 'S-22',
      first_name: 'Ari', middle_name: null, last_name: 'Kim', suffix: null,
      registrar_confirmation_id: 14, assessed_voucher_code: 'PUB', assessed_schedule_version: 2,
      voucher_review_required: true, voucher_review_reason: 'Assessment snapshot differs.',
      annual_balance: '12345.67', unattributed_legacy_balance: '0.00', opening_liability_due: '0.00',
      enrollment_id: 82, annual_term_number: 2, enrollment_status: 'enrolled', term_scope_status: 'applicable',
      term_id: 2, term: 'Term 2', section_id: 3, section_name: 'Grade 11 ABM A', cluster: 'ABM',
      strand: 'ABM', modality: 'onsite', current_term_due: '1250.00', signed_clearance_status: 'signed'
    }
  ];
  const getPool = async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          observed.push({ statement, values: { ...values } });
          if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'finance' }] };
          if (statement.includes('COUNT(DISTINCT annual.id)')) return { recordset: [{ total_records: 41 }] };
          if (statement.includes('MatchingPlacements AS')) return { recordset: annualRows };
          return { recordsets: [
            [{ school_year: '2026-2027' }],
            [{ term_id: 1, term_label: '2026-2027 · Term 1' }],
            [{ section_id: 3, section_name: 'Grade 11 ABM A', cluster: 'ABM', strand: 'ABM' }]
          ] };
        }
      };
    }
  });
  const sql = { Int: 'Int', NVarChar: (length) => 'NVarChar(' + length + ')' };
  const service = createAnnualFinanceService({ getPool, sql });
  const result = await service.listRosterPage(7, {
    search: 'Ari', schoolYear: '2026-2027', termId: '1', page: '99', status: 'pending_payment'
  });

  assert.equal(result.pagination.page, 3);
  assert.equal(result.pagination.pageSize, 20);
  assert.equal(result.pagination.totalRecords, 41);
  assert.equal(result.pagination.from, 41);
  assert.equal(result.pagination.to, 41);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].placements.length, 2);
  assert.equal(result.rows[0].annual_balance, '12345.67');
  assert.equal(result.rows[0].placements[0].current_term_due, '2500.01');
  const dataQuery = observed.find(({ statement }) => statement.includes('MatchingPlacements AS'));
  assert.match(dataQuery.statement, /LIMIT @pageSize OFFSET @offset/);
  assert.match(dataQuery.statement, /ORDER BY annual\.school_year DESC, student\.last_name, student\.first_name, annual\.id, enrollment\.annual_term_number/);
  assert.equal(dataQuery.values.offset, 40);
  assert.equal(dataQuery.values.pageSize, 20);
  assert.equal(dataQuery.values.searchPattern, '%Ari%');
  assert.equal(dataQuery.values.schoolYear, '2026-2027');
  assert.equal(dataQuery.values.termId, 1);
  assert.equal(dataQuery.values.placementStatus, 'pending_payment');

  await service.listRosterPage(7, { page: 'not-a-page' });
  assert.equal(observed.filter(({ statement }) => statement.includes('MatchingPlacements AS')).at(-1).values.offset, 0);
  await assert.rejects(service.listRosterPage(7, { voucherCode: 'INVALID' }), AnnualFinanceError);

  const html = await renderFinanceView('annual-roster', {
    rows: result.rows,
    filters: { search: 'Ari', schoolYear: '2026-2027', termId: '1' },
    schoolYears: result.options.schoolYears,
    terms: result.options.terms,
    sections: result.options.sections,
    pagination: result.pagination,
    notice: null,
    error: null
  });
  const summary = html.match(/<details class="finance-roster-record[^\"]*">\s*<summary>([\s\S]*?)<\/summary>/)?.[1] || '';
  assert.match(summary, /Annual balance[\s\S]*₱12,345\.67/);
  assert.match(summary, /Voucher review[\s\S]*Required/);
  assert.match(summary, /Voucher type ESC · 2 term placements/);
  assert.doesNotMatch(summary, /Category A|voucher category/i);
  assert.doesNotMatch(summary, /Legacy balance|Opening liability/);
  assert.match(html, /Legacy balance<\/dt><dd>₱0\.00/);
  assert.match(html, /Opening liability<\/dt><dd>₱0\.00/);
  assert.doesNotMatch(summary, /No review flag/);
  assert.match(html, /Pending activation/);
  assert.doesNotMatch(html, /Term 1 · Term 1|pending payment/);
  assert.match(html, /schoolYear=2026-2027/);
  assert.match(html, /termId=1/);

  const legacyAnnualRecord = {
    annual_enrollment_id: 10, school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'ESC',
    voucher_category: 'A', intake_status: 'active', assessment_id: null, schedule_version: 2,
    terms: [{
      annual_enrollment_id: 10, school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'ESC',
      voucher_category: 'A', intake_status: 'active', assessment_id: null, schedule_version: 2,
      term: 'Term 1', annual_term_number: 1, enrollment_id: 81, enrollment_status: 'enrolled',
      term_scope_status: 'applicable', outstanding: '0.00', signed_clearance_status: null,
      voucher_review_required: false, section_name: 'Grade 11 ABM A'
    }]
  };
  const accountHtml = await renderFinanceView('annual-student', {
    ledger: {
      student: { id: 22, first_name: 'Ari', middle_name: null, last_name: 'Kim', suffix: null, student_no: 'S-22', status: 'active' },
      summary: {
        annualBalanceSchoolYear: '2026-2027', annualBalance: '0.00', allYearsAnnualBalance: '0.00',
        annualWaivedAmount: '0.00', unattributedLegacyBalance: '0.00', openingLiabilityDue: '0.00',
        totalBalance: '0.00', currentTermOutstanding: '0.00', priorTermYearDebt: '0.00', availableCredit: '0.00'
      },
      terms: legacyAnnualRecord.terms, openingLiabilities: [], charges: [], availablePayments: [],
      legacyCredits: [], payments: [], adjustments: [], events: [], privateClearances: [],
      allocationHistory: [], legacyReconciliationHistory: [], feeComments: [], financeHandbookNumbers: [], financeHandbookHistory: []
    },
    financeCases: { exemptions: [], specialSubjects: [], departures: [] },
    accountView: 'overview',
    accountTabs: [
      { view: 'overview', label: 'Overview' }, { view: 'payments', label: 'Payments' },
      { view: 'charges', label: 'Charges & coverage' }, { view: 'clearance', label: 'Clearance & reviews' },
      { view: 'history', label: 'History' }
    ],
    backHref: '/finance?schoolYear=2026-2027&termId=1',
    schedules: [], tokens: { payment: 'test-payment-token', assessment: 'test-assessment-token' },
    csrfToken: 'test-csrf-token', notice: null, error: null, preview: null
  });
  assert.match(accountHtml, /Grade 11 · Voucher type ESC/);
  assert.doesNotMatch(accountHtml, /Category A|voucher category/i);
  const paymentDetails = accountHtml.match(/<section class="finance-payment-wizard__panel" data-payment-step="details"[\s\S]*?<\/section>/)?.[0] || '';
  const paymentAllocations = accountHtml.match(/<section class="finance-payment-wizard__panel" data-payment-step="allocations"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(accountHtml, /data-payment-step="details"[\s\S]*?<\/section>\s*<section class="finance-payment-wizard__panel" data-payment-step="allocations"/);
  assert.match(paymentDetails, /name="amount"[^>]*required/);
  assert.match(paymentAllocations, /Suggest oldest balances/);
  assert.match(paymentAllocations, /name="allocationMode" value="credit">Keep all as unallocated credit/);
  assert.doesNotMatch(paymentDetails + paymentAllocations, /\shidden(?:\s|>)/, 'both steps stay available without JavaScript');
  assert.match(accountHtml, /src="\/js\/finance-payment-wizard\.js"/);
});

test('finance disclosures keep report, schedule, and zero-charge departure details available', async () => {
  const reportHtml = await renderFinanceView('reports', {
    currentUser: null,
    error: null,
    filters: { view: 'term-balances', fromDate: '2026-10-01', toDate: '2026-10-31' },
    today: '2026-10-04', weekStart: '2026-09-28', monthStart: '2026-10-01',
    report: {
      fromDate: '2026-10-01', toDate: '2026-10-31',
      collectionSummary: { distinct_payers: 0, valid_collection_amount: '0.00', payment_count: 0 },
      dailyCollections: [], reversalSummary: { distinct_payers: 0, reversal_count: 0, corrected_record_amount: '0.00' },
      reversals: [], allocationSummary: { distinct_payers: 0, target_allocated_amount: '0.00' }, allocationContexts: [],
      termProgress: [
        { school_year: '2026-2027', annual_term_number: 1, term: 'Term 1', grade_level: 'Grade 11',
          section_name: 'ABM A', strand: 'ABM', voucher_code: 'ESC', applicable_enrollments: 4,
          enrolled_students: 4, paid_or_waived_students: 3, waived_students: 1, outstanding_amount: '0.01', waived_amount: '2500.00' },
        { school_year: '2026-2027', annual_term_number: 1, term: 'Term 1', grade_level: 'Grade 12',
          section_name: 'ABM B', strand: 'ABM', voucher_code: 'PUB', applicable_enrollments: 2,
          enrolled_students: 2, paid_or_waived_students: 1, waived_students: 0, outstanding_amount: '500.00', waived_amount: '0.00' }
      ]
    }
  });
  assert.match(reportHtml, /Current snapshot across all recorded annual placements/);
  assert.match(reportHtml, /not limited by the payment date range/);
  assert.match(reportHtml, /2026-2027 · Term 1/);
  assert.match(reportHtml, /2 grade, section, and voucher breakdowns/);
  assert.doesNotMatch(reportHtml, /Term 1 \(Term 1\)/);
  assert.match(reportHtml, /₱0\.01/);
  assert.match(reportHtml, /₱2,500\.00/);
  assert.doesNotMatch(reportHtml, /<details class="finance-term-progress-group" open/);

  const scheduleTuitionLines = [1, 2, 3].flatMap((termNumber) => ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment) => ({
    isRequiredTuition: true, termNumber: String(termNumber), feeCategory: 'tuition', lineName: 'Tuition', installment,
    amount: '0.00', isOptional: false
  })));
  const scheduleHtml = await renderFinanceView('schedules', {
    currentUser: null, csrfToken: 'csrf-token', idempotencyKey: '41111111-1111-4111-8111-111111111111',
    error: null, notice: null,
    scheduleForm: {
      schoolYear: '2026-2027', gradeLevel: 'Grade 11', voucherCode: 'ESC',
      lines: scheduleTuitionLines
    },
    scheduleContext: {
      schoolYear: '2026-2027', gradeLevel: 'Grade 11', voucherCode: 'ESC',
      voucherCodes: ['PUB', 'ESC', 'NV'], voucherCounts: { PUB: 1, ESC: 2, NV: 0 },
      schoolYears: ['2026-2027'], grades: ['Grade 11', 'Grade 12'],
      activeSchedule: { id: 2, version_no: 2, lines: [{ term_number: 2, line_name: 'Current fee', installment: 'Prelim', amount: '20.00', is_optional: 0 }] }
    },
    schedules: [
      { id: 1, school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'ESC', version_no: 1, status: 'retired', line_id: 1, term_number: 1, line_name: 'Old fee', installment: 'Finals', fee_category: 'tuition', amount: '10.00' },
      { id: 2, school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'ESC', version_no: 2, status: 'active', line_id: 2, term_number: 2, line_name: 'Current fee', installment: 'Prelim', fee_category: 'tuition', amount: '20.00' }
    ]
  });
  assert.doesNotMatch(scheduleHtml, /<details class="finance-schedule-create" open/);
  assert.match(scheduleHtml, /Current approved amounts/);
  assert.match(scheduleHtml, /Active version 2/);
  assert.match(scheduleHtml, /Previous versions · 2026-2027 · Grade 11 · ESC/);
  assert.match(scheduleHtml, /<summary[^>]*>Create or revise this schedule/);
  assert.match(scheduleHtml, /Fee lines for 2026-2027 Grade 11 ESC version 1/);
  assert.equal((scheduleHtml.match(/data-schedule-term="[123]"/g) || []).length, 3);
  assert.match(scheduleHtml, /data-schedule-term="1" open/);
  assert.match(scheduleHtml, /data-schedule-term="2"/);
  assert.match(scheduleHtml, /data-schedule-term="3"/);
  assert.doesNotMatch(scheduleHtml, /name="finance-schedule-term"/);
  assert.equal((scheduleHtml.match(/data-required-tuition-line/g) || []).length, 12);
  assert.equal((scheduleHtml.match(/name="lineAmount"/g) || []).length, 13); // 12 tuition inputs and one blank fee-row template input
  assert.match(scheduleHtml, /Term 1 tuition DP amount in PHP/);
  assert.match(scheduleHtml, /Term 3 tuition Finals amount in PHP/);
  const renderedTuitionOrder = [...scheduleHtml.matchAll(/aria-label="Term ([123]) tuition (DP|Prelim|Midterm|Finals) amount in PHP"/g)]
    .map(([, term, installment]) => `${term}:${installment}`);
  assert.deepEqual(renderedTuitionOrder, [1, 2, 3].flatMap((term) => ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment) => `${term}:${installment}`)));
  assert.match(scheduleHtml, /<details class="finance-schedule-additional"\s*>/);
  assert.match(scheduleHtml, /<summary><strong>Additional fee lines<\/strong>/);
  assert.match(scheduleHtml, /data-label="Fee name"/);
  assert.match(scheduleHtml, /data-finance-line-template[\s\S]*?data-label="Fee name"/);

  const departureHtml = await renderFinanceView('departures', {
    currentUser: null, csrfToken: 'csrf-token', error: null, notice: null,
    departures: [{
      departure_case_id: 71, student_name: 'Ari Kim', student_no: 'S-22', school_year: '2026-2027',
      grade_level: 'Grade 11', departure_type: 'dropped', effective_date: '2026-10-01',
      reason: 'Registrar record reason.', idempotencyKey: '41111111-1111-4111-8111-111111111111',
      terms: [{ enrollment_id: 82, annual_term_number: 2, academic_activity_review_required: true, charges: [] }]
    }]
  });
  const departureSummary = departureHtml.match(/<details class="finance-departure-case"\s*>\s*<summary>([\s\S]*?)<\/summary>/)?.[1] || '';
  assert.match(departureSummary, /1 affected terms · 0 charges to review/);
  assert.doesNotMatch(departureSummary, /Registrar record reason/);
  assert.match(departureHtml, /No annual charges are linked to this placement/);
  assert.match(departureHtml, /Academic activity exists; verify grade and schedule history separately/);
  assert.match(departureHtml, /name="reason"[^>]*required/);
  assert.match(departureHtml, /name="_csrf" value="csrf-token"/);
  assert.match(departureHtml, /name="idempotencyKey" value="41111111-1111-4111-8111-111111111111"/);
  assert.doesNotMatch(departureHtml, /<fieldset/);
});

test('schedule validation reopens the form with submitted fee lines and idempotency key', async () => {
  const calls = [];
  const annualFinanceService = {
    async listRoster() { return { rows: [], options: { schoolYears: [], terms: [], sections: [] } }; },
    async listSchedules() { return []; },
    async createSchedule(actorId, input) {
      calls.push({ actorId, input });
      throw new AnnualFinanceError('Schedule amount is invalid.');
    }
  };
  const idempotencyKey = '41111111-1111-4111-8111-111111111111';
  const tuitionInstallments = ['DP', 'Prelim', 'Midterm', 'Finals'];
  const requiredTuitionLines = [1, 2, 3].flatMap((termNumber) => tuitionInstallments.map((installment) => ({
    termNumber: String(termNumber), feeCategory: 'tuition', lineName: 'Tuition', installment,
    lineAmount: termNumber === 1 && installment === 'DP' ? '100.00' : '0.00'
  })));
  const router = createFinanceRouter({ annualFinanceService });
  const schedulePost = router.stack.find((layer) => layer.route?.path === '/schedules' && layer.route.methods.post)?.route.stack[0].handle;
  assert.equal(typeof schedulePost, 'function');
  const req = {
    authUser: { id: 7 },
    query: { schoolYear: '2026-2027', gradeLevel: 'Grade 11', voucherCode: 'ESC' },
    session: { csrfToken: 'csrf-for-schedule-test' },
    body: {
      _csrf: 'csrf-for-schedule-test', idempotencyKey,
      schoolYear: '2026-2027', gradeLevel: 'Grade 11', voucherCode: 'ESC',
      termNumber: [...requiredTuitionLines.map((line) => line.termNumber), '3'],
      feeCategory: [...requiredTuitionLines.map((line) => line.feeCategory), 'activity'],
      lineName: [...requiredTuitionLines.map((line) => line.lineName), 'Activity <fees>'],
      installment: [...requiredTuitionLines.map((line) => line.installment), 'Event'],
      lineAmount: [...requiredTuitionLines.map((line) => line.lineAmount), '30.00'], optionalIndex: ['12']
    }
  };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    render(view, locals) { this.view = view; this.locals = locals; return this; },
    redirect(code, location) { this.redirectCode = code; this.location = location; return this; }
  };
  await schedulePost(req, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.view, 'finance/schedules');
  const html = await renderFinanceView('schedules', response.locals);
  assert.match(html, /<details class="finance-schedule-create" open>/);
  assert.match(html, /name="schoolYear"[^>]*value="2026-2027"/);
  assert.match(html, /name="idempotencyKey" value="41111111-1111-4111-8111-111111111111"/);
  assert.match(html, /value="Activity &lt;fees&gt;"/);
  assert.match(html, /<details class="finance-schedule-additional" open>/);
  const submittedTuitionOrder = [...html.matchAll(/aria-label="Term ([123]) tuition (DP|Prelim|Midterm|Finals) amount in PHP"/g)]
    .map(([, term, installment]) => `${term}:${installment}`);
  assert.deepEqual(submittedTuitionOrder, [1, 2, 3].flatMap((term) => ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment) => `${term}:${installment}`)));
  assert.match(html, /name="optionalIndex" value="12" checked/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actorId, 7);
  assert.equal(calls[0].input.idempotencyKey, idempotencyKey);
  assert.equal(calls[0].input.lines.length, 13);
  assert.equal(calls[0].input.lines[12].isOptional, true);
});

test('registrar fee preview shows meaningful approved installment labels and payable tuition lines', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../views/records/annual-intake-fees.ejs'), {
    title: 'Fee preview test', formatMoney, annualId: 41, csrfToken: 'test-csrf',
    values: { idempotencyKey: '41111111-1111-4111-8111-111111111111' }, successNotice: null, error: null,
    preview: {
      parent: { first_name: 'Synthetic', last_name: 'Learner', student_no: 'S-1', school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'PUB' },
      scheduleVersion: 2, existingAssessment: false, optionalLines: [], optionalLineIds: [],
      termTotals: [{ termNumber: 1, amount: '25.00' }, { termNumber: 2, amount: '0.00' }],
      tuitionTermTotals: [{ termNumber: 1, amount: '25.00' }, { termNumber: 2, amount: '0.00' }],
      nonTuitionTermTotals: [{ termNumber: 1, amount: '0.00' }, { termNumber: 2, amount: '0.00' }],
      tuitionBreakdownComplete: true,
      tuitionBreakdown: [1, 2].map((termNumber) => ({
        termNumber, complete: true, installments: ['DP', 'Prelim', 'Midterm', 'Finals'].map((label) => ({
          label, configured: true, amount: termNumber === 1 && label === 'Prelim' ? '25.00' : '0.00'
        }))
      })),
      lines: [
        { termNumber: 1, lineName: 'Tuition', category: 'tuition', installment: 'DP', amount: '0.00', grossAmount: '0.00', waivedAmount: '0.00', isOptional: false },
        { termNumber: 1, lineName: 'Tuition', category: 'tuition', installment: 'Prelim', amount: '25.00', grossAmount: '25.00', waivedAmount: '0.00', isOptional: false }
      ],
      total: '25.00', scheduleId: 3, assessmentId: null, voucherCode: 'PUB', snapshotFingerprint: 'a'.repeat(64)
    }
  });
  assert.match(html, /Approved tuition by installment/);
  assert.match(html, /Payable by term/);
  assert.match(html, /Downpayment/);
  assert.match(html, /DP/);
  assert.match(html, /₱0\.00/);
  assert.match(html, />Prelim</);
  assert.match(html, /₱25\.00/);
  assert.doesNotMatch(html, /Not configured|Not applicable/);
  assert.match(html, /<details class="fee-breakdown">/);
  assert.doesNotMatch(html, /<details class="fee-breakdown" open>/);
  assert.equal((html.match(/data-fee-submit/g) || []).length, 1);
});

test('registrar installment matrix starts at the entry term and reconciles tuition, other fees, and term payable', async () => {
  const termTwoInstallmentAmounts = { DP: '0.00', Prelim: '433.34', Midterm: '433.33', Finals: '433.33' };
  const tuitionBreakdown = [1, 2, 3].map((termNumber) => termNumber === 1
    ? { termNumber, complete: true, installments: ['DP', 'Prelim', 'Midterm', 'Finals'].map((label) => ({
      label, configured: false, notApplicable: true, amount: null
    })) }
    : { termNumber, complete: true, installments: ['DP', 'Prelim', 'Midterm', 'Finals'].map((label) => ({
      label, configured: true, amount: termNumber === 2 ? termTwoInstallmentAmounts[label] : '350.00'
    })) });
  const termTwoLines = ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment) => ({
    termNumber: 2, lineName: 'Tuition', category: 'tuition', installment, amount: termTwoInstallmentAmounts[installment],
    grossAmount: termTwoInstallmentAmounts[installment], waivedAmount: '0.00', isOptional: false
  }));
  const termThreeLines = ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment) => ({
    termNumber: 3, lineName: 'Tuition', category: 'tuition', installment, amount: '350.00',
    grossAmount: '350.00', waivedAmount: '0.00', isOptional: false
  }));
  const html = await ejs.renderFile(path.join(__dirname, '../views/records/annual-intake-fees.ejs'), {
    title: 'Midyear fee preview test', formatMoney, annualId: 43, csrfToken: 'test-csrf',
    values: { idempotencyKey: '41111111-1111-4111-8111-111111111113' }, successNotice: null, error: null,
    preview: {
      parent: { first_name: 'Synthetic', last_name: 'Learner', student_no: 'S-3', school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'PUB', entry_term_number: 2 },
      scheduleVersion: 2, existingAssessment: false, optionalLines: [], optionalLineIds: [],
      termTotals: [{ termNumber: 2, amount: '1775.00' }, { termNumber: 3, amount: '1900.00' }],
      tuitionTermTotals: [{ termNumber: 2, amount: '1300.00' }, { termNumber: 3, amount: '1400.00' }],
      nonTuitionTermTotals: [{ termNumber: 2, amount: '475.00' }, { termNumber: 3, amount: '500.00' }],
      tuitionBreakdownComplete: true, tuitionBreakdown,
      lines: [
        ...termTwoLines,
        { termNumber: 2, lineName: 'Miscellaneous', category: 'miscellaneous', installment: 'Term 2', amount: '475.00', grossAmount: '475.00', waivedAmount: '0.00', isOptional: false },
        ...termThreeLines,
        { termNumber: 3, lineName: 'Miscellaneous', category: 'miscellaneous', installment: 'Term 3', amount: '500.00', grossAmount: '500.00', waivedAmount: '0.00', isOptional: false }
      ],
      total: '3675.00', scheduleId: 5, assessmentId: null, voucherCode: 'PUB', snapshotFingerprint: 'c'.repeat(64)
    }
  });
  const summary = html.match(/<div class="fee-approved-tuition"[\s\S]*?<\/div>\s*<div class="fee-review-actions"/)?.[0];
  assert.ok(summary);
  assert.match(summary, /Approved tuition by installment/);
  assert.match(summary, /<th scope="row">Term 2<\/th>[\s\S]*?₱0\.00[\s\S]*?₱1,300\.00[\s\S]*?₱475\.00[\s\S]*?₱1,775\.00/);
  assert.match(summary, /<th scope="row">Term 3<\/th>[\s\S]*?₱350\.00[\s\S]*?₱1,400\.00[\s\S]*?₱500\.00[\s\S]*?₱1,900\.00/);
  assert.doesNotMatch(summary, /Term 1/);
  assert.match(html, /Downpayment/);
  assert.match(html, /Schedule label/);
  assert.match(html, /Term 2<\/td>\s*<td data-label="Fee">Miscellaneous/);
  assert.match(html, /Term 3<\/td>\s*<td data-label="Fee">Miscellaneous/);
  assert.equal((html.match(/data-fee-submit/g) || []).length, 1);
});

test('legacy tuition schedules show approved term totals and hide unhelpful installment labels', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../views/records/annual-intake-fees.ejs'), {
    title: 'Legacy fee preview test', formatMoney, annualId: 42, csrfToken: 'test-csrf',
    values: { idempotencyKey: '41111111-1111-4111-8111-111111111112' }, successNotice: null, error: null,
    preview: {
      parent: { first_name: 'Synthetic', last_name: 'Learner', student_no: 'S-2', school_year: '2026-2027', grade_level: 'Grade 11', voucher_code: 'ESC' },
      scheduleVersion: 1, existingAssessment: false, optionalLines: [], optionalLineIds: [],
      termTotals: [{ termNumber: 1, amount: '25.00' }, { termNumber: 2, amount: '0.00' }],
      tuitionTermTotals: [{ termNumber: 1, amount: '25.00' }, { termNumber: 2, amount: '0.00' }],
      nonTuitionTermTotals: [{ termNumber: 1, amount: '0.00' }, { termNumber: 2, amount: '0.00' }],
      tuitionBreakdownComplete: false,
      tuitionBreakdown: [1, 2].map((termNumber) => ({
        termNumber, complete: false, installments: ['DP', 'Prelim', 'Midterm', 'Finals'].map((label) => ({
          label, configured: false, amount: null
        }))
      })),
      lines: [
        { termNumber: 1, lineName: 'Tuition', category: 'tuition', installment: 'Other', amount: '0.00', grossAmount: '0.00', waivedAmount: '0.00', isOptional: false },
        { termNumber: 1, lineName: 'Tuition', category: 'tuition', installment: 'Other', amount: '25.00', grossAmount: '25.00', waivedAmount: '0.00', isOptional: false }
      ],
      total: '25.00', scheduleId: 4, assessmentId: null, voucherCode: 'ESC', snapshotFingerprint: 'b'.repeat(64)
    }
  });
  const tuitionSummary = html.match(/<div class="fee-approved-tuition"[\s\S]*?<\/div>\s*<div class="fee-review-actions"/)?.[0];
  assert.ok(tuitionSummary);
  assert.match(tuitionSummary, /Approved tuition by term/);
  assert.match(tuitionSummary, /Term 1/);
  assert.match(tuitionSummary, /₱25\.00/);
  assert.match(tuitionSummary, /Term 2/);
  assert.match(tuitionSummary, /₱0\.00/);
  assert.match(tuitionSummary, /The approved schedule does not provide one Downpayment/);
  assert.match(tuitionSummary, /no installment split is estimated/i);
  assert.doesNotMatch(tuitionSummary, /<th[^>]*>Other<\/th>/);
  assert.match(html, /<details class="fee-breakdown">[\s\S]*?Other/);
  assert.doesNotMatch(html, /Not configured|Not applicable/);
  assert.equal((html.match(/data-fee-submit/g) || []).length, 1);

  const savedAssessmentSummary = await ejs.renderFile(path.join(__dirname, '../views/records/partials/annual-tuition-breakdown.ejs'), {
    formatMoney, headingId: 'saved-assessment-tuition-title',
    preview: {
      existingAssessment: true, tuitionBreakdownComplete: false,
      lines: [{ category: 'tuition', termNumber: 1, lineName: 'Tuition', installment: 'Other' }],
      tuitionBreakdown: [{ termNumber: 1, installments: [{ notApplicable: false }] }],
      tuitionTermTotals: [{ termNumber: 1, amount: '25.00' }],
      nonTuitionTermTotals: [{ termNumber: 1, amount: '0.00' }],
      termTotals: [{ termNumber: 1, amount: '25.00' }]
    }
  });
  assert.match(savedAssessmentSummary, /This saved assessment preserves its original fee details/);
  assert.match(savedAssessmentSummary, /original term total/);
  assert.doesNotMatch(savedAssessmentSummary, /confirmed enrollment/i);
});
