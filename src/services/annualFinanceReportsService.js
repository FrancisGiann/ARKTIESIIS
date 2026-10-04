const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

class FinanceReportsError extends Error {
  constructor(message, status = 400, { cause, queryPhase } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FinanceReportsError';
    this.status = status;
    if (cause) this.cause = cause;
    if (queryPhase) this.queryPhase = queryPhase;
  }
}

const FINANCE_REPORT_QUERY_PHASES = Object.freeze([
  'transaction_begin', 'authorization', 'daily_collections', 'collection_summary',
  'daily_corrections', 'correction_summary', 'allocation_summary', 'allocation_contexts', 'opening_allocation_contexts',
  'term_progress_summary',
  'details_count', 'details_data', 'transaction_commit'
]);
const FINANCE_REPORT_VIEWS = new Set(['all', 'collections', 'allocations', 'corrections', 'term-balances']);

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new FinanceReportsError(`Choose a valid ${label} date.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new FinanceReportsError(`Choose a valid ${label} date.`);
  return value;
}

function createAnnualFinanceReportsService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool)
} = {}) {
  async function authorizedReportTransaction(actorInput, failureMessage) {
    const actorId = typeof actorInput === 'number' ? actorInput
      : typeof actorInput === 'string' && /^\d{1,15}$/.test(actorInput) ? Number(actorInput) : NaN;
    if (!Number.isSafeInteger(actorId) || actorId < 1) {
      throw new FinanceReportsError('Your finance access is no longer active. Sign in again.', 403);
    }
    let transaction;
    let started = false;
    let queryPhase = 'transaction_begin';
    try {
      const pool = await getPool();
      transaction = transactionFactory(pool);
      await transaction.begin(sql.ISOLATION_LEVEL.REPEATABLE_READ);
      started = true;
      queryPhase = 'authorization';
      const actor = await transaction.request().input('actorId', sql.Int, actorId)
        .query(`SELECT id FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin')`);
      if (!actor.recordset?.length) throw new FinanceReportsError('Your finance access is no longer active. Sign in again.', 403);
      return transaction;
    } catch (error) {
      if (started) await transaction.rollback().catch(() => {});
      if (error instanceof FinanceReportsError) throw error;
      throw new FinanceReportsError(failureMessage, 503, { cause: error, queryPhase });
    }
  }

  async function runReportQuery(request, statement, phase, failureMessage) {
    try {
      return await request.query(statement);
    } catch (cause) {
      throw new FinanceReportsError(failureMessage, 503, { cause, queryPhase: phase });
    }
  }

  function dateRange(filters) {
    const fromDate = validDate(filters.fromDate, 'start');
    const toDate = validDate(filters.toDate, 'end');
    if (fromDate > toDate) throw new FinanceReportsError('The start date must be on or before the end date.');
    const span = Math.floor((new Date(`${toDate}T00:00:00.000Z`) - new Date(`${fromDate}T00:00:00.000Z`)) / 86400000);
    if (span > 366) throw new FinanceReportsError('Finance reports can cover up to 367 calendar days at a time.');
    const toExclusive = new Date(`${toDate}T00:00:00.000Z`);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
    const toExclusiveDate = toExclusive.toISOString().slice(0, 10);
    const manilaMidnightUtc = (day) => {
      const midnightUtc = new Date(`${day}T00:00:00.000Z`);
      midnightUtc.setUTCHours(midnightUtc.getUTCHours() - 8);
      return midnightUtc.toISOString().slice(0, 19).replace('T', ' ');
    };
    return {
      fromDate, toDate, toExclusive: toExclusiveDate,
      correctionFromUtc: manilaMidnightUtc(fromDate),
      correctionToUtc: manilaMidnightUtc(toExclusiveDate)
    };
  }

  async function reports(actorInput, filters = {}) {
    const { fromDate, toDate, toExclusive, correctionFromUtc, correctionToUtc } = dateRange(filters);
    const view = filters.view === undefined ? 'all' : filters.view;
    if (!FINANCE_REPORT_VIEWS.has(view)) throw new FinanceReportsError('Choose a valid finance report view.');
    const failureMessage = 'Finance reports could not be loaded.';
    const transaction = await authorizedReportTransaction(actorInput, failureMessage);
    let started = false;
    let queryPhase = 'transaction_commit';
    try {
      started = true;
      const parameters = (request) => request.input('fromDate', sql.Date, fromDate).input('toDate', sql.Date, toDate)
        .input('toExclusive', sql.Date, toExclusive);
      const correctionParameters = (request) => parameters(request)
        .input('correctionFromUtc', sql.DateTime, correctionFromUtc)
        .input('correctionToUtc', sql.DateTime, correctionToUtc);
      const report = {
        fromDate, toDate, dailyCollections: [], collectionSummary: {},
        reversals: [], reversalSummary: {}, allocationSummary: {}, allocationContexts: [], termProgress: []
      };
      if (view === 'collections' || view === 'all') {
        queryPhase = 'daily_collections';
        const daily = await runReportQuery(parameters(transaction.request()), `SELECT DATE_FORMAT(payment.payment_date, '%Y-%m-%d') AS collection_date,
          COUNT(DISTINCT payment.student_id) AS distinct_payers, COUNT(*) AS payment_count,
          CAST(SUM(payment.amount) AS CHAR(40)) AS collected_amount
          FROM finance_payments AS payment
          WHERE payment.is_reversed = 0 AND payment.payment_date >= @fromDate AND payment.payment_date < @toExclusive
          GROUP BY DATE_FORMAT(payment.payment_date, '%Y-%m-%d') ORDER BY collection_date`, queryPhase, failureMessage);
        report.dailyCollections = daily.recordset || [];
        queryPhase = 'collection_summary';
        const collectionSummary = await runReportQuery(parameters(transaction.request()), `SELECT COUNT(DISTINCT payment.student_id) AS distinct_payers,
          COUNT(*) AS payment_count, CAST(COALESCE(SUM(payment.amount), 0) AS CHAR(40)) AS valid_collection_amount
          FROM finance_payments AS payment
          WHERE payment.is_reversed = 0 AND payment.payment_date >= @fromDate AND payment.payment_date < @toExclusive`, queryPhase, failureMessage);
        report.collectionSummary = collectionSummary.recordset?.[0] || {};
      }
      if (view === 'corrections' || view === 'all') {
        queryPhase = 'daily_corrections';
        const reversals = await runReportQuery(correctionParameters(transaction.request()), `SELECT DATE_FORMAT(DATE_ADD(reversal.created_at, INTERVAL 8 HOUR), '%Y-%m-%d') AS reversal_date,
          COUNT(DISTINCT payment.student_id) AS distinct_payers, COUNT(*) AS reversal_count,
          CAST(SUM(payment.amount) AS CHAR(40)) AS reversed_amount
          FROM finance_payment_reversals AS reversal
          INNER JOIN finance_payments AS payment ON payment.id = reversal.payment_id
          WHERE reversal.created_at >= @correctionFromUtc AND reversal.created_at < @correctionToUtc
          GROUP BY DATE_FORMAT(DATE_ADD(reversal.created_at, INTERVAL 8 HOUR), '%Y-%m-%d') ORDER BY reversal_date`, queryPhase, failureMessage);
        report.reversals = reversals.recordset || [];
        queryPhase = 'correction_summary';
        const reversalSummary = await runReportQuery(correctionParameters(transaction.request()), `SELECT COUNT(DISTINCT payment.student_id) AS distinct_payers,
          COUNT(*) AS reversal_count, CAST(COALESCE(SUM(payment.amount), 0) AS CHAR(40)) AS corrected_record_amount
          FROM finance_payment_reversals AS reversal
          INNER JOIN finance_payments AS payment ON payment.id = reversal.payment_id
          WHERE reversal.created_at >= @correctionFromUtc AND reversal.created_at < @correctionToUtc`, queryPhase, failureMessage);
        report.reversalSummary = reversalSummary.recordset?.[0] || {};
      }
      if (view === 'allocations' || view === 'all') {
        queryPhase = 'allocation_summary';
        const allocationSummary = await runReportQuery(parameters(transaction.request()), `SELECT COUNT(DISTINCT payment.student_id) AS distinct_payers,
          CAST(COALESCE(SUM(allocation.net_amount), 0) AS CHAR(40)) AS target_allocated_amount
          FROM v_finance_net_payment_allocations AS allocation
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id AND payment.is_reversed = 0
          WHERE payment.payment_date >= @fromDate AND payment.payment_date < @toExclusive`, queryPhase, failureMessage);
        report.allocationSummary = allocationSummary.recordset?.[0] || {};
        queryPhase = 'allocation_contexts';
        const allocationContexts = await runReportQuery(parameters(transaction.request()), `SELECT annual.school_year, enrollment.annual_term_number, section.name AS section_name,
            section.strand, annual.voucher_code, charge.fee_category, COUNT(DISTINCT payment.student_id) AS distinct_payers,
            CAST(SUM(allocation.net_amount) AS CHAR(40)) AS allocated_amount, 'assessed charge' AS target_type
          FROM v_finance_net_payment_allocations AS allocation
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id AND payment.is_reversed = 0
          INNER JOIN assessed_charges AS charge ON charge.id = allocation.charge_id
          INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
          INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
          LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
          WHERE allocation.charge_id IS NOT NULL AND payment.payment_date >= @fromDate AND payment.payment_date < @toExclusive
          GROUP BY annual.school_year, enrollment.annual_term_number, section.name, section.strand, annual.voucher_code, charge.fee_category
          ORDER BY annual.school_year, enrollment.annual_term_number, section.name, section.strand, annual.voucher_code, charge.fee_category`,
        queryPhase, failureMessage);
        queryPhase = 'opening_allocation_contexts';
        const openingAllocation = await runReportQuery(parameters(transaction.request()), `SELECT COUNT(DISTINCT payment.student_id) AS distinct_payers,
          CAST(SUM(allocation.net_amount) AS CHAR(40)) AS allocated_amount
          FROM v_finance_net_payment_allocations AS allocation
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id AND payment.is_reversed = 0
          INNER JOIN finance_legacy_opening_charges AS opening ON opening.id = allocation.legacy_opening_charge_id
          WHERE payment.payment_date >= @fromDate AND payment.payment_date < @toExclusive`, queryPhase, failureMessage);
        report.allocationContexts = [
          ...(allocationContexts.recordset || []),
          {
            school_year: 'Legacy / unknown term', annual_term_number: null, section_name: 'Legacy account',
            strand: null, voucher_code: null, fee_category: 'opening liability',
            distinct_payers: openingAllocation.recordset?.[0]?.distinct_payers || 0,
            allocated_amount: openingAllocation.recordset?.[0]?.allocated_amount ?? null,
            target_type: 'opening liability'
          }
        ];
      }
      if (view === 'term-balances' || view === 'all') {
        queryPhase = 'term_progress_summary';
        const termProgress = await runReportQuery(transaction.request(), `SELECT annual.school_year, annual.grade_level,
            enrollment.academic_term_id, term.term, enrollment.annual_term_number, section.id AS section_id,
            section.name AS section_name, section.strand, annual.voucher_code,
            COUNT(DISTINCT CASE WHEN enrollment.enrollment_status IN ('enrolled', 'pending_payment') THEN annual.student_id END) AS applicable_enrollments,
            COUNT(DISTINCT CASE WHEN enrollment.enrollment_status = 'enrolled' THEN annual.student_id END) AS enrolled_students,
            COUNT(DISTINCT CASE WHEN enrollment.enrollment_status = 'enrolled' AND COALESCE(balance.amount_due, 0) <= 0 THEN annual.student_id END) AS paid_or_waived_students,
            COUNT(DISTINCT CASE WHEN enrollment.enrollment_status = 'enrolled' AND COALESCE(balance.amount_due, 0) <= 0
              AND COALESCE(waiver.waived_total, 0) > 0 THEN annual.student_id END) AS waived_students,
            CAST(SUM(CASE WHEN COALESCE(balance.amount_due, 0) > 0 THEN balance.amount_due ELSE 0 END) AS CHAR(40)) AS outstanding_amount,
            CAST(SUM(COALESCE(waiver.waived_total, 0)) AS CHAR(40)) AS waived_amount
          FROM enrollments AS enrollment
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id AND annual.intake_status <> 'legacy'
          INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
          LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
          LEFT JOIN (SELECT due.enrollment_id, SUM(due.amount_due) AS amount_due
            FROM v_finance_assessed_charge_due AS due GROUP BY due.enrollment_id) AS balance
            ON balance.enrollment_id = enrollment.id
          LEFT JOIN (SELECT charge.enrollment_id, SUM(charge.waived_amount) AS waived_total
            FROM assessed_charges AS charge GROUP BY charge.enrollment_id) AS waiver
            ON waiver.enrollment_id = enrollment.id
          WHERE enrollment.term_scope_status = 'applicable'
          GROUP BY annual.school_year, annual.grade_level, enrollment.academic_term_id, term.term,
            enrollment.annual_term_number, section.id, section.name, section.strand, annual.voucher_code
          ORDER BY annual.school_year DESC, enrollment.annual_term_number, annual.grade_level,
            section.name, section.strand, annual.voucher_code, enrollment.academic_term_id, term.term, section.id`,
        queryPhase, failureMessage);
        report.termProgress = termProgress.recordset || [];
      }
      queryPhase = 'transaction_commit';
      await transaction.commit();
      started = false;
      return report;
    } catch (error) {
      if (started) {
        try { await transaction.rollback(); } catch { /* preserve original */ }
      }
      if (error instanceof FinanceReportsError) throw error;
      throw new FinanceReportsError(failureMessage, 503, { cause: error, queryPhase });
    }
  }

  async function reportDetails(actorInput, filters = {}) {
    const kind = filters.kind;
    if (!['collections', 'allocations', 'corrections'].includes(kind)) throw new FinanceReportsError('Choose a report detail view.');
    const range = dateRange(filters);
    const rawPage = typeof filters.page === 'string' ? filters.page : '1';
    const requestedPage = /^\d{1,6}$/.test(rawPage) ? Math.max(1, Number(rawPage)) : 1;
    const failureMessage = 'Finance report details could not be loaded.';
    const transaction = await authorizedReportTransaction(actorInput, failureMessage);
    let queryPhase = 'details_count';
    try {
      const bind = (request) => request.input('fromDate', sql.Date, range.fromDate)
        .input('toExclusive', sql.Date, range.toExclusive);
      const bindCorrections = (request) => bind(request)
        .input('correctionFromUtc', sql.DateTime, range.correctionFromUtc)
        .input('correctionToUtc', sql.DateTime, range.correctionToUtc);
      let countStatement;
      let dataStatement;
      if (kind === 'collections') {
        countStatement = `SELECT COUNT(*) AS total_records FROM finance_payments AS payment
          WHERE payment.is_reversed = 0 AND payment.payment_date >= @fromDate AND payment.payment_date < @toExclusive`;
        dataStatement = `SELECT payment.id AS payment_id, DATE_FORMAT(payment.payment_date, '%Y-%m-%d') AS event_date,
            CAST(payment.amount AS CHAR(40)) AS amount, payment.reference_no, payment.receipt_issued,
            student.id AS student_id, student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix
          FROM finance_payments AS payment INNER JOIN students AS student ON student.id = payment.student_id
          WHERE payment.is_reversed = 0 AND payment.payment_date >= @fromDate AND payment.payment_date < @toExclusive
          ORDER BY payment.payment_date DESC, payment.id DESC LIMIT @pageSize OFFSET @offset`;
      } else if (kind === 'corrections') {
        countStatement = `SELECT COUNT(*) AS total_records FROM finance_payment_reversals AS reversal
          WHERE reversal.created_at >= @correctionFromUtc AND reversal.created_at < @correctionToUtc`;
        dataStatement = `SELECT reversal.id AS correction_id, DATE_FORMAT(DATE_ADD(reversal.created_at, INTERVAL 8 HOUR), '%Y-%m-%d') AS event_date,
            reversal.reason AS correction_reason, payment.id AS payment_id, CAST(payment.amount AS CHAR(40)) AS amount,
            student.id AS student_id, student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix
          FROM finance_payment_reversals AS reversal INNER JOIN finance_payments AS payment ON payment.id = reversal.payment_id
          INNER JOIN students AS student ON student.id = payment.student_id
          WHERE reversal.created_at >= @correctionFromUtc AND reversal.created_at < @correctionToUtc
          ORDER BY reversal.created_at DESC, reversal.id DESC LIMIT @pageSize OFFSET @offset`;
      } else {
        countStatement = `SELECT COUNT(*) AS total_records FROM v_finance_net_payment_allocations AS allocation
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id AND payment.is_reversed = 0
          WHERE payment.payment_date >= @fromDate AND payment.payment_date < @toExclusive AND allocation.net_amount > 0`;
        dataStatement = `SELECT payment.id AS payment_id, DATE_FORMAT(payment.payment_date, '%Y-%m-%d') AS event_date,
            CAST(allocation.net_amount AS CHAR(40)) AS amount, allocation.charge_id, allocation.legacy_opening_charge_id,
            COALESCE(CONCAT(annual.school_year, ' · Term ', enrollment.annual_term_number, ' · ', charge.line_name, ' · ', charge.installment),
              CONCAT('Verified legacy opening · ', opening.source_label)) AS target_label,
            student.id AS student_id, student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix
          FROM v_finance_net_payment_allocations AS allocation
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id AND payment.is_reversed = 0
          INNER JOIN students AS student ON student.id = payment.student_id
          LEFT JOIN assessed_charges AS charge ON charge.id = allocation.charge_id
          LEFT JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
          LEFT JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
          LEFT JOIN finance_legacy_opening_charges AS opening ON opening.id = allocation.legacy_opening_charge_id
          WHERE payment.payment_date >= @fromDate AND payment.payment_date < @toExclusive AND allocation.net_amount > 0
          ORDER BY payment.payment_date DESC, payment.id DESC, allocation.allocation_id DESC LIMIT @pageSize OFFSET @offset`;
      }
      const count = await runReportQuery(
        kind === 'corrections' ? bindCorrections(transaction.request()) : bind(transaction.request()),
        countStatement, queryPhase, failureMessage
      );
      const totalRecords = Number(count.recordset?.[0]?.total_records || 0);
      const pageSize = 20;
      const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
      const page = Math.min(requestedPage, totalPages);
      queryPhase = 'details_data';
      const rows = await runReportQuery(
        (kind === 'corrections' ? bindCorrections(transaction.request()) : bind(transaction.request())).input('pageSize', sql.Int, pageSize)
          .input('offset', sql.Int, (page - 1) * pageSize),
        dataStatement, queryPhase, failureMessage
      );
      queryPhase = 'transaction_commit';
      await transaction.commit();
      return { kind, ...range, rows: rows.recordset || [], pagination: {
        page, pageSize, totalPages, totalRecords,
        from: totalRecords ? (page - 1) * pageSize + 1 : 0,
        to: Math.min(page * pageSize, totalRecords)
      } };
    } catch (error) {
      await transaction.rollback().catch(() => {});
      if (error instanceof FinanceReportsError) throw error;
      throw new FinanceReportsError(failureMessage, 503, { cause: error, queryPhase });
    }
  }

  return { reports, reportDetails };
}

module.exports = { FinanceReportsError, FINANCE_REPORT_QUERY_PHASES, createAnnualFinanceReportsService };
