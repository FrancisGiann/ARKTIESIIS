'use strict';

const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { FINANCE_STATUS, FINANCE_TERM_CLASSIFICATION_CTES, TRACKING_MODES } = require('./financeTermClassification');

class FinanceDashboardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'FinanceDashboardError';
    this.status = status;
  }
}

function normalizeActorId(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,18}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function filterString(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength ? value.trim() : '';
}

const STATUS_LABELS = Object.freeze([
  { status: FINANCE_STATUS.UNPAID, label: 'Unpaid' },
  { status: FINANCE_STATUS.PARTIAL, label: 'Partially paid' },
  { status: FINANCE_STATUS.FULL, label: 'Fully paid' },
  { status: FINANCE_STATUS.NO_PAYMENT_REQUIRED, label: 'No payment required' },
  { status: FINANCE_STATUS.NEEDS_REVIEW, label: 'Needs review' }
]);

function createFinanceDashboardService({ getPool = defaultGetPool, sql = defaultSql } = {}) {
  async function getOverview(actorInput, filters = {}) {
    const actorId = normalizeActorId(actorInput);
    if (!actorId) throw new FinanceDashboardError('Finance or database administrator access is required.', 403);
    const pool = await getPool();
    const actor = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT id FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin')`);
    if (!actor.recordset?.length) throw new FinanceDashboardError('Your finance access is no longer active. Sign in again.', 403);

    const queueResult = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT
        (SELECT COUNT(*) FROM student_document_requests AS request
          WHERE request.status IN ('requested', 'processing', 'ready')) AS document_clearance_count,
        (SELECT COUNT(*) FROM finance_departure_cases AS departure
          WHERE departure.finance_status = 'pending') AS departure_review_count,
        (SELECT COUNT(*) FROM finance_review_drafts AS draft
          WHERE draft.owner_user_id = @actorId AND draft.status = 'pending') AS saved_review_count`);
    const queueRow = queueResult.recordset?.[0] || {};
    const queueCounts = {
      documentClearance: Number(queueRow.document_clearance_count || 0),
      departureReview: Number(queueRow.departure_review_count || 0),
      savedReviews: Number(queueRow.saved_review_count || 0)
    };

    const configuredResult = await pool.request().query(`SELECT configured.school_year, configured.term_number,
        term.id AS academic_term_id, term.term, term.is_current
      FROM school_year_term_order AS configured
      INNER JOIN academic_terms AS term ON term.id = configured.academic_term_id
        AND term.school_year = configured.school_year
      WHERE NOT EXISTS (SELECT 1 FROM school_year_term_order_reviews AS review
        WHERE review.academic_term_id = term.id AND review.resolved_at IS NULL)
      ORDER BY configured.school_year DESC, configured.term_number`);
    const configuredTerms = (configuredResult.recordset || []).map((row) => ({
      schoolYear: String(row.school_year), termNumber: Number(row.term_number),
      academicTermId: Number(row.academic_term_id), term: String(row.term),
      isCurrent: row.is_current === true || row.is_current === 1
    }));
    const schoolYears = [...new Set(configuredTerms.map((term) => term.schoolYear))];
    const currentTerm = configuredTerms.find((term) => term.isCurrent) || null;
    const requestedYear = filterString(filters.schoolYear, 20);
    if (requestedYear && !schoolYears.includes(requestedYear)) throw new FinanceDashboardError('Choose a configured school year.');
    const selectedSchoolYear = requestedYear || currentTerm?.schoolYear || '';
    const availableTerms = configuredTerms.filter((term) => term.schoolYear === selectedSchoolYear);
    const requestedTermId = filterString(filters.termId, 12);
    const selectedTerm = requestedTermId
      ? availableTerms.find((term) => String(term.academicTermId) === requestedTermId)
      : availableTerms.find((term) => term.isCurrent) || availableTerms[0] || null;
    if (requestedTermId && !selectedTerm) throw new FinanceDashboardError('Choose a configured term in the selected school year.');
    const selectedGrade = filterString(filters.gradeLevel, 50);
    if (selectedGrade && !['Grade 11', 'Grade 12'].includes(selectedGrade)) throw new FinanceDashboardError('Choose Grade 11 or Grade 12.');
    const selectedVoucher = filterString(filters.voucherCode, 10);
    if (selectedVoucher && !['PUB', 'ESC', 'NV'].includes(selectedVoucher)) throw new FinanceDashboardError('Choose PUB, ESC, or NV.');
    const selectedInstallment = (filterString(filters.installment, 20) || 'whole').toLowerCase();
    if (!TRACKING_MODES.includes(selectedInstallment)) throw new FinanceDashboardError('Choose whole-term or a canonical tuition installment.');
    const statusColumn = `${selectedInstallment}_status`;

    const gradeResult = selectedSchoolYear
      ? await pool.request().input('schoolYear', sql.NVarChar(20), selectedSchoolYear)
        .query(`SELECT DISTINCT grade_level FROM annual_enrollments
          WHERE school_year = @schoolYear AND intake_status <> 'legacy' AND grade_level IN ('Grade 11', 'Grade 12') ORDER BY grade_level`)
      : { recordset: [] };
    const gradeLevels = (gradeResult.recordset || []).map((row) => String(row.grade_level));
    const sectionResult = selectedSchoolYear && selectedTerm
      ? await pool.request().input('schoolYear', sql.NVarChar(20), selectedSchoolYear)
        .input('termId', sql.Int, selectedTerm.academicTermId)
        .query(`SELECT DISTINCT section.id AS section_id, section.name AS section_name, section.cluster, section.strand
          FROM sections AS section INNER JOIN enrollments AS enrollment ON enrollment.section_id = section.id
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          WHERE annual.school_year = @schoolYear AND enrollment.academic_term_id = @termId
            AND enrollment.term_scope_status = 'applicable' AND enrollment.enrollment_status IN ('enrolled', 'pending_payment')
            AND annual.intake_status NOT IN ('legacy', 'cancelled', 'dropped', 'transferred')
          ORDER BY section.name, section.id`)
      : { recordset: [] };
    const sections = (sectionResult.recordset || []).map((row) => ({ id: String(row.section_id), name: String(row.section_name), cluster: row.cluster, strand: row.strand }));
    const requestedSection = filterString(filters.sectionId, 12);
    if (requestedSection && (!/^\d{1,10}$/.test(requestedSection) || !sections.some((section) => section.id === requestedSection))) {
      throw new FinanceDashboardError('Choose a section in the selected term.');
    }
    const selectedSectionId = requestedSection || '';
    const voucherCodes = ['PUB', 'ESC', 'NV'];
    if (!selectedSchoolYear || !selectedTerm) {
      return { configuredTerms, schoolYears, availableTerms, gradeLevels, sections, voucherCodes,
        selectedSchoolYear, selectedTermId: '', selectedTerm: null, selectedGrade, selectedVoucher, selectedSectionId, selectedInstallment,
        statusCounts: STATUS_LABELS.map((item) => ({ ...item, count: 0 })), totalEligible: 0,
        queueCounts,
        needsSchoolYearSelection: !selectedSchoolYear, needsTermSelection: Boolean(selectedSchoolYear) };
    }

    const counts = await pool.request().input('schoolYear', sql.NVarChar(20), selectedSchoolYear)
      .input('termId', sql.Int, selectedTerm.academicTermId)
      .input('gradeLevel', sql.NVarChar(50), selectedGrade || null)
      .input('voucherCode', sql.NVarChar(10), selectedVoucher || null)
      .input('sectionId', sql.Int, selectedSectionId ? Number(selectedSectionId) : null)
      .query(`SET STATEMENT optimizer_switch='derived_merge=off,condition_pushdown_for_derived=off' FOR WITH ${FINANCE_TERM_CLASSIFICATION_CTES}
        SELECT ${statusColumn} AS finance_status, COUNT(DISTINCT student_id) AS student_count
        FROM FinanceTermClassification
        WHERE school_year = @schoolYear AND academic_term_id = @termId
          AND term_scope_status = 'applicable' AND enrollment_status IN ('enrolled', 'pending_payment')
          AND intake_status NOT IN ('legacy', 'cancelled', 'dropped', 'transferred') AND student_status = 'active'
          AND (@gradeLevel IS NULL OR grade_level = @gradeLevel)
          AND (@voucherCode IS NULL OR voucher_code = @voucherCode)
          AND (@sectionId IS NULL OR section_id = @sectionId)
        GROUP BY ${statusColumn}`);
    const countByStatus = new Map((counts.recordset || []).map((row) => [String(row.finance_status), Number(row.student_count || 0)]));
    const statusCounts = STATUS_LABELS.map((item) => ({ ...item, count: countByStatus.get(item.status) || 0 }));
    return {
      configuredTerms, schoolYears, availableTerms,
      gradeLevels: gradeLevels.length ? gradeLevels : ['Grade 11', 'Grade 12'], voucherCodes,
      selectedSchoolYear, selectedTermId: String(selectedTerm.academicTermId), selectedTerm,
      selectedGrade, selectedVoucher, selectedSectionId, selectedInstallment, sections, statusCounts,
      queueCounts,
      totalEligible: statusCounts.reduce((sum, item) => sum + item.count, 0),
      needsSchoolYearSelection: false, needsTermSelection: false
    };
  }

  return { getOverview };
}

module.exports = { FinanceDashboardError, createFinanceDashboardService, normalizeActorId, STATUS_LABELS };
