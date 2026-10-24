'use strict';

const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

const PAGE_SIZE = 20;

class FinanceAssessmentQueueError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'FinanceAssessmentQueueError';
    this.status = status;
  }
}

function parseAssessmentQueueFilters(input = {}) {
  const view = input.view == null || input.view === '' ? 'pending' : input.view;
  if (!['pending', 'approved'].includes(view)) throw new FinanceAssessmentQueueError('Choose Pending approval or Approved.');
  const schoolYear = input.schoolYear == null ? '' : input.schoolYear;
  if (typeof schoolYear !== 'string' || schoolYear.length > 20 || /[\u0000-\u001f\u007f]/.test(schoolYear)) {
    throw new FinanceAssessmentQueueError('Choose a valid school year.');
  }
  const pageText = input.page == null || input.page === '' ? '1' : input.page;
  if (typeof pageText !== 'string' || !/^[1-9]\d{0,5}$/.test(pageText)) {
    throw new FinanceAssessmentQueueError('Choose a valid page number.');
  }
  return { view, schoolYear, page: Number(pageText) };
}

const ASSESSMENT_QUEUE_CTE = `WITH LatestAssessment AS (
    SELECT annual_enrollment_id, MAX(id) AS assessment_id FROM annual_assessments GROUP BY annual_enrollment_id
  ), LatestVoucherEvent AS (
    SELECT annual_enrollment_id, event_type,
      ROW_NUMBER() OVER (PARTITION BY annual_enrollment_id ORDER BY created_at DESC, id DESC) AS event_rank
    FROM annual_enrollment_events WHERE event_type IN ('voucher_review_flagged', 'voucher_review_resolved')
  ), AssessmentQueue AS (
    SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.school_year, annual.grade_level,
      annual.voucher_code, annual.intake_status, student.student_no,
      CONCAT_WS(' ', student.first_name, student.middle_name, student.last_name, student.suffix) AS student_name,
      assessment.id AS assessment_id, assessment.schedule_id, assessment.schedule_version,
      assessment.voucher_code_snapshot AS assessed_voucher_code,
      CASE WHEN review.id IS NULL THEN 0 ELSE 1 END AS has_finance_review,
      CASE WHEN voucher_event.event_type = 'voucher_review_flagged' THEN 1 ELSE 0 END AS voucher_review_required,
      CASE WHEN annual.intake_status = 'pending' AND (assessment.id IS NULL OR review.id IS NULL
        OR voucher_event.event_type = 'voucher_review_flagged') THEN 1 ELSE 0 END AS pending_approval,
      CASE WHEN assessment.id IS NOT NULL AND review.id IS NOT NULL
        AND (voucher_event.event_type IS NULL OR voucher_event.event_type <> 'voucher_review_flagged') THEN 1 ELSE 0 END AS approved
    FROM annual_enrollments AS annual
    INNER JOIN students AS student ON student.id = annual.student_id
    LEFT JOIN LatestAssessment AS latest_assessment ON latest_assessment.annual_enrollment_id = annual.id
    LEFT JOIN annual_assessments AS assessment ON assessment.id = latest_assessment.assessment_id
    LEFT JOIN annual_finance_assessment_reviews AS review ON review.id = (
      SELECT MAX(current_review.id) FROM annual_finance_assessment_reviews AS current_review
      WHERE current_review.annual_enrollment_id = annual.id AND current_review.assessment_id = assessment.id)
    LEFT JOIN LatestVoucherEvent AS voucher_event ON voucher_event.annual_enrollment_id = annual.id AND voucher_event.event_rank = 1
    WHERE annual.intake_status <> 'legacy'
  )`;

function createFinanceAssessmentQueueService({ getPool = defaultGetPool, sql = defaultSql, getReadiness } = {}) {
  async function list(actorId, rawFilters = {}) {
    const filters = parseAssessmentQueueFilters(rawFilters);
    if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) < 1) {
      throw new FinanceAssessmentQueueError('Finance access is required.', 403);
    }
    const pool = await getPool();
    const actor = await pool.request().input('actorId', sql.Int, Number(actorId))
      .query(`SELECT id FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin')`);
    if (!actor.recordset?.length) throw new FinanceAssessmentQueueError('Your Finance access is no longer active. Sign in again.', 403);
    const schoolYearRows = await pool.request().query(`SELECT DISTINCT school_year FROM annual_enrollments
      WHERE intake_status <> 'legacy' ORDER BY school_year DESC`);
    const schoolYears = (schoolYearRows.recordset || []).map((row) => String(row.school_year));
    if (filters.schoolYear && !schoolYears.includes(filters.schoolYear)) {
      throw new FinanceAssessmentQueueError('Choose a school year with saved enrollments.');
    }
    const candidates = await pool.request().input('schoolYear', sql.NVarChar(20), filters.schoolYear)
      .query(`${ASSESSMENT_QUEUE_CTE} SELECT annual_enrollment_id, student_id, school_year, grade_level,
        voucher_code, intake_status, student_no, student_name, assessment_id, schedule_id, schedule_version,
        assessed_voucher_code, has_finance_review, voucher_review_required
        FROM AssessmentQueue WHERE (@schoolYear = '' OR school_year = @schoolYear)
        ORDER BY school_year DESC, student_name, student_no, annual_enrollment_id`);
    if (typeof getReadiness !== 'function') throw new Error('Finance assessment readiness is unavailable.');
    const allRows = candidates.recordset || [];
    // A saved review can become stale after an adjustment, exemption, or new fee.
    // Use the same authoritative fingerprint check as Registrar before classifying
    // a pending intake as approved. Bound concurrency to avoid a query burst.
    for (let index = 0; index < allRows.length; index += 4) {
      await Promise.all(allRows.slice(index, index + 4).map(async (row) => {
        if (row.intake_status !== 'pending' || !row.assessment_id || !row.has_finance_review
          || row.voucher_review_required) return;
        const readiness = await getReadiness(Number(actorId), Number(row.annual_enrollment_id));
        row.has_finance_review = readiness.reviewed ? 1 : 0;
      }));
    }
    const pendingRows = allRows.filter((row) => row.intake_status === 'pending'
      && (!row.assessment_id || !row.has_finance_review || row.voucher_review_required));
    const approvedRows = allRows.filter((row) => row.assessment_id && row.has_finance_review
      && !row.voucher_review_required);
    const pendingCount = pendingRows.length;
    const approvedCount = approvedRows.length;
    const selectedRows = filters.view === 'pending' ? pendingRows : approvedRows;
    const total = selectedRows.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(filters.page, totalPages);
    const rows = selectedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    return { filters: { ...filters, page }, schoolYears, counts: { pending: pendingCount, approved: approvedCount },
      rows, pagination: { page, totalPages, total, from: total ? (page - 1) * PAGE_SIZE + 1 : 0,
        to: Math.min(page * PAGE_SIZE, total) } };
  }
  return { list };
}

module.exports = { FinanceAssessmentQueueError, parseAssessmentQueueFilters, createFinanceAssessmentQueueService };
