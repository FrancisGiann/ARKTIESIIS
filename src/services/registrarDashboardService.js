const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

class RegistrarDashboardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RegistrarDashboardError';
    this.status = status;
  }
}

function normalizeActorId(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,18}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeFilter(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength ? value.trim() : '';
}

function createRegistrarDashboardService({ getPool = defaultGetPool, sql = defaultSql } = {}) {
  async function getDashboard(actorInput, filters = {}) {
    const actorId = normalizeActorId(actorInput);
    if (!actorId) throw new RegistrarDashboardError('Registrar dashboard access is required.', 403);
    const pool = await getPool();
    const authorized = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT id FROM users
        WHERE id = @actorId AND is_active = 1 AND role = 'registrar'`);
    if (!authorized.recordset?.length) {
      throw new RegistrarDashboardError('Your registrar access is no longer active. Sign in again.', 403);
    }

    const termResult = await pool.request().query(`SELECT configured.school_year, configured.term_number,
        term.id AS academic_term_id, term.term, term.is_current
      FROM school_year_term_order AS configured
      INNER JOIN academic_terms AS term ON term.id = configured.academic_term_id
        AND term.school_year = configured.school_year
      WHERE NOT EXISTS (SELECT 1 FROM school_year_term_order_reviews AS review
        WHERE review.academic_term_id = term.id AND review.resolved_at IS NULL)
      ORDER BY configured.school_year DESC, configured.term_number`);
    const configuredTerms = (termResult.recordset || []).map((row) => ({
      schoolYear: String(row.school_year),
      termNumber: Number(row.term_number),
      academicTermId: Number(row.academic_term_id),
      term: String(row.term),
      isCurrent: row.is_current === true || row.is_current === 1
    }));
    const schoolYears = [...new Set(configuredTerms.map((term) => term.schoolYear))];
    const currentTerm = configuredTerms.find((term) => term.isCurrent) || null;

    const requestedYear = normalizeFilter(filters.schoolYear, 20);
    if (requestedYear && !schoolYears.includes(requestedYear)) {
      throw new RegistrarDashboardError('Choose a configured school year.');
    }
    const selectedSchoolYear = requestedYear || currentTerm?.schoolYear || '';
    const yearTerms = configuredTerms.filter((term) => term.schoolYear === selectedSchoolYear);
    const requestedTermId = normalizeFilter(filters.termId, 18);
    if (requestedTermId && (!/^\d+$/.test(requestedTermId) || Number(requestedTermId) > 2147483647)) {
      throw new RegistrarDashboardError('Choose a configured term.');
    }
    if (requestedTermId && !configuredTerms.some((term) => term.academicTermId === Number(requestedTermId))) {
      throw new RegistrarDashboardError('Choose a configured term.');
    }
    if (requestedTermId && !yearTerms.some((term) => term.academicTermId === Number(requestedTermId))) {
      throw new RegistrarDashboardError('Choose a term configured for the selected school year.');
    }
    const selectedTerm = requestedTermId
      ? yearTerms.find((term) => term.academicTermId === Number(requestedTermId))
      : currentTerm?.schoolYear === selectedSchoolYear ? currentTerm : null;

    if (!selectedSchoolYear) {
      return {
        configuredTerms, schoolYears, schoolYearTerms: [], selectedSchoolYear: '', selectedTerm: null,
        activeEnrolledCount: null, pendingActivationCount: 0, departedCount: 0, droppedCount: 0, transferredCount: 0,
        everFinalizedCount: 0, termCounts: [], needsTermSelection: true
      };
    }

    const selectedYear = await pool.request().input('schoolYear', sql.NVarChar(20), selectedSchoolYear)
      .input('selectedTermId', sql.Int, selectedTerm?.academicTermId || null)
      .query(`SELECT
          COUNT(DISTINCT CASE WHEN term.id = @selectedTermId AND enrollment.enrollment_status = 'enrolled' AND student.status = 'active'
            THEN annual.student_id END) AS active_enrolled_count,
          COUNT(DISTINCT CASE WHEN term.id = @selectedTermId AND enrollment.enrollment_status = 'pending_payment' AND enrollment.finalized_at IS NULL
            AND student.status = 'active' THEN annual.student_id END) AS pending_activation_count,
          COUNT(DISTINCT CASE WHEN term.id = @selectedTermId AND enrollment.enrollment_status = 'dropped'
            THEN annual.student_id END) AS dropped_count,
          COUNT(DISTINCT CASE WHEN term.id = @selectedTermId AND enrollment.enrollment_status = 'transferred'
            THEN annual.student_id END) AS transferred_count,
          COUNT(DISTINCT CASE WHEN enrollment.finalized_at IS NOT NULL THEN annual.student_id END) AS ever_finalized_count
        FROM school_year_term_order AS configured
        INNER JOIN academic_terms AS term ON term.id = configured.academic_term_id
        LEFT JOIN enrollments AS enrollment ON enrollment.academic_term_id = term.id
          AND enrollment.term_scope_status = 'applicable'
        LEFT JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          AND annual.school_year = configured.school_year AND annual.intake_status <> 'legacy'
        LEFT JOIN students AS student ON student.id = annual.student_id
        WHERE configured.school_year = @schoolYear
          AND NOT EXISTS (SELECT 1 FROM school_year_term_order_reviews AS review
            WHERE review.academic_term_id = term.id AND review.resolved_at IS NULL)`);
    const termCountsResult = await pool.request().input('schoolYear', sql.NVarChar(20), selectedSchoolYear)
      .query(`SELECT configured.term_number, term.id AS academic_term_id, term.term,
          COUNT(DISTINCT CASE WHEN annual.grade_level = 'Grade 11' AND student.status = 'active'
            AND enrollment.enrollment_status = 'enrolled' THEN annual.student_id END) AS grade_11_count,
          COUNT(DISTINCT CASE WHEN annual.grade_level = 'Grade 12' AND student.status = 'active'
            AND enrollment.enrollment_status = 'enrolled' THEN annual.student_id END) AS grade_12_count
        FROM school_year_term_order AS configured
        INNER JOIN academic_terms AS term ON term.id = configured.academic_term_id
        LEFT JOIN enrollments AS enrollment ON enrollment.academic_term_id = term.id
          AND enrollment.term_scope_status = 'applicable'
        LEFT JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          AND annual.school_year = configured.school_year AND annual.intake_status <> 'legacy'
        LEFT JOIN students AS student ON student.id = annual.student_id
        WHERE configured.school_year = @schoolYear
          AND NOT EXISTS (SELECT 1 FROM school_year_term_order_reviews AS review
            WHERE review.academic_term_id = term.id AND review.resolved_at IS NULL)
        GROUP BY configured.term_number, term.id, term.term
        ORDER BY configured.term_number`);
    const summary = selectedYear.recordset?.[0] || {};
    return {
      configuredTerms,
      schoolYears,
      schoolYearTerms: yearTerms,
      selectedSchoolYear,
      selectedTerm,
      activeEnrolledCount: selectedTerm ? Number(summary.active_enrolled_count || 0) : null,
      pendingActivationCount: selectedTerm ? Number(summary.pending_activation_count || 0) : 0,
      departedCount: selectedTerm ? Number(summary.dropped_count || 0) + Number(summary.transferred_count || 0) : 0,
      droppedCount: selectedTerm ? Number(summary.dropped_count || 0) : 0,
      transferredCount: selectedTerm ? Number(summary.transferred_count || 0) : 0,
      everFinalizedCount: Number(summary.ever_finalized_count || 0),
      termCounts: (termCountsResult.recordset || []).map((row) => ({
        termNumber: Number(row.term_number), academicTermId: Number(row.academic_term_id), term: String(row.term),
        grade11: Number(row.grade_11_count || 0), grade12: Number(row.grade_12_count || 0)
      })),
      needsTermSelection: !selectedTerm
    };
  }

  return { getDashboard };
}

module.exports = { RegistrarDashboardError, createRegistrarDashboardService, normalizeActorId };
