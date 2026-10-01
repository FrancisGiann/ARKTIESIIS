const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

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

function createFinanceDashboardService({ getPool = defaultGetPool, sql = defaultSql } = {}) {
  async function getOverview(actorInput, filters = {}) {
    const actorId = normalizeActorId(actorInput);
    if (!actorId) throw new FinanceDashboardError('Finance or database administrator access is required.', 403);
    const pool = await getPool();
    const actor = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT id FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin')`);
    if (!actor.recordset?.length) {
      throw new FinanceDashboardError('Your finance access is no longer active. Sign in again.', 403);
    }

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
    if (requestedYear && !schoolYears.includes(requestedYear)) {
      throw new FinanceDashboardError('Choose a configured school year.');
    }
    const selectedSchoolYear = requestedYear || currentTerm?.schoolYear || '';
    const gradeLevelsResult = selectedSchoolYear
      ? await pool.request().input('schoolYear', sql.NVarChar(20), selectedSchoolYear)
        .query(`SELECT DISTINCT annual.grade_level
          FROM annual_enrollments AS annual
          WHERE annual.school_year = @schoolYear AND annual.intake_status <> 'legacy'
            AND annual.grade_level IN ('Grade 11', 'Grade 12')
          ORDER BY annual.grade_level`)
      : { recordset: [] };
    const gradeLevels = (gradeLevelsResult.recordset || []).map((row) => String(row.grade_level));
    const requestedGrade = filterString(filters.gradeLevel, 50);
    if (requestedGrade && !['Grade 11', 'Grade 12'].includes(requestedGrade)) {
      throw new FinanceDashboardError('Choose Grade 11 or Grade 12.');
    }
    const selectedGrade = requestedGrade || '';

    if (!selectedSchoolYear) {
      return {
        configuredTerms, schoolYears, gradeLevels: ['Grade 11', 'Grade 12'], selectedSchoolYear: '',
        selectedGrade, terms: [], needsSchoolYearSelection: true
      };
    }

    const counts = await pool.request().input('schoolYear', sql.NVarChar(20), selectedSchoolYear)
      .input('gradeLevel', sql.NVarChar(50), selectedGrade || null)
      .query(`WITH configured_terms AS (
          SELECT configured.school_year, configured.term_number, term.id AS academic_term_id, term.term
          FROM school_year_term_order AS configured
          INNER JOIN academic_terms AS term ON term.id = configured.academic_term_id
            AND term.school_year = configured.school_year
          WHERE configured.school_year = @schoolYear
            AND NOT EXISTS (SELECT 1 FROM school_year_term_order_reviews AS review
              WHERE review.academic_term_id = term.id AND review.resolved_at IS NULL)
        ), eligible_terms AS (
          SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.grade_level,
            enrollment.id AS enrollment_id, enrollment.annual_term_number, configured.term
          FROM configured_terms AS configured
          INNER JOIN enrollments AS enrollment ON enrollment.academic_term_id = configured.academic_term_id
            AND enrollment.annual_term_number = configured.term_number
            AND enrollment.term_scope_status = 'applicable'
            AND enrollment.enrollment_status IN ('enrolled', 'pending_payment')
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
            AND annual.school_year = configured.school_year AND annual.intake_status NOT IN ('legacy', 'cancelled', 'dropped', 'transferred')
          INNER JOIN students AS student ON student.id = annual.student_id AND student.status = 'active'
          INNER JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
          INNER JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = annual.id
            AND confirmation.assessment_id = assessment.id
          WHERE @gradeLevel IS NULL OR annual.grade_level = @gradeLevel
        ), allocations AS (
          SELECT charge.enrollment_id, charge.annual_enrollment_id,
            SUM(net.net_amount) AS net_allocated
          FROM assessed_charges AS charge
          INNER JOIN eligible_terms AS eligible ON eligible.enrollment_id = charge.enrollment_id
            AND eligible.annual_enrollment_id = charge.annual_enrollment_id
          INNER JOIN v_finance_net_payment_allocations AS net ON net.charge_id = charge.id
            AND net.net_amount > 0
          INNER JOIN finance_payments AS payment ON payment.id = net.payment_id
            AND payment.student_id = eligible.student_id AND payment.is_reversed = 0
          GROUP BY charge.enrollment_id, charge.annual_enrollment_id
        ), charge_totals AS (
          SELECT charge.enrollment_id, charge.annual_enrollment_id,
            SUM(charge.amount + COALESCE(adjustments.amount, 0)) AS amount_required,
            SUM(charge.amount + COALESCE(adjustments.amount, 0) - COALESCE(allocations.net_allocated, 0)) AS amount_due
          FROM assessed_charges AS charge
          INNER JOIN eligible_terms AS eligible ON eligible.enrollment_id = charge.enrollment_id
            AND eligible.annual_enrollment_id = charge.annual_enrollment_id
          LEFT JOIN (
            SELECT adjustment.charge_id, SUM(adjustment.amount) AS amount
            FROM finance_charge_adjustments AS adjustment GROUP BY adjustment.charge_id
          ) AS adjustments ON adjustments.charge_id = charge.id
          LEFT JOIN (
            SELECT net.charge_id, payment.student_id, SUM(net.net_amount) AS net_allocated
            FROM v_finance_net_payment_allocations AS net
            INNER JOIN finance_payments AS payment ON payment.id = net.payment_id AND payment.is_reversed = 0
            WHERE net.net_amount > 0 GROUP BY net.charge_id, payment.student_id
          ) AS allocations ON allocations.charge_id = charge.id AND allocations.student_id = eligible.student_id
          GROUP BY charge.enrollment_id, charge.annual_enrollment_id
        ), per_student_term AS (
          SELECT eligible.annual_enrollment_id, eligible.student_id, eligible.grade_level,
            eligible.annual_term_number, eligible.term,
            COALESCE(SUM(allocations.net_allocated), 0) AS net_allocated,
            COALESCE(SUM(charge_totals.amount_due), 0) AS amount_due,
            COALESCE(SUM(charge_totals.amount_required), 0) AS amount_required,
            COUNT(charge_totals.enrollment_id) AS assessed_term_count
          FROM eligible_terms AS eligible
          LEFT JOIN allocations ON allocations.enrollment_id = eligible.enrollment_id
            AND allocations.annual_enrollment_id = eligible.annual_enrollment_id
          LEFT JOIN charge_totals ON charge_totals.enrollment_id = eligible.enrollment_id
            AND charge_totals.annual_enrollment_id = eligible.annual_enrollment_id
          GROUP BY eligible.annual_enrollment_id, eligible.student_id, eligible.grade_level,
            eligible.annual_term_number, eligible.term
        )
        SELECT configured.term_number, configured.academic_term_id, configured.term,
          COUNT(DISTINCT CASE WHEN per_student_term.net_allocated > 0 THEN per_student_term.student_id END) AS students_with_allocated_payment,
          COUNT(DISTINCT CASE WHEN per_student_term.assessed_term_count > 0 AND per_student_term.amount_due <= 0
            THEN per_student_term.student_id END) AS settled_term_balance,
          COUNT(DISTINCT CASE WHEN per_student_term.assessed_term_count > 0 AND per_student_term.amount_required <= 0
            THEN per_student_term.student_id END) AS no_payment_required
        FROM configured_terms AS configured
        LEFT JOIN per_student_term ON per_student_term.annual_term_number = configured.term_number
        GROUP BY configured.term_number, configured.academic_term_id, configured.term
        ORDER BY configured.term_number`);
    return {
      configuredTerms, schoolYears, gradeLevels: gradeLevels.length ? gradeLevels : ['Grade 11', 'Grade 12'],
      selectedSchoolYear, selectedGrade,
      terms: (counts.recordset || []).map((row) => ({
        termNumber: Number(row.term_number), academicTermId: Number(row.academic_term_id), term: String(row.term),
        studentsWithAllocatedPayment: Number(row.students_with_allocated_payment || 0),
        settledTermBalance: Number(row.settled_term_balance || 0),
        noPaymentRequired: Number(row.no_payment_required || 0)
      })),
      needsSchoolYearSelection: false
    };
  }

  return { getOverview };
}

module.exports = { FinanceDashboardError, createFinanceDashboardService, normalizeActorId };
