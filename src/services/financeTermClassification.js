'use strict';

const FINANCE_STATUS = Object.freeze({
  UNPAID: 'unpaid',
  PARTIAL: 'partially_paid',
  FULL: 'fully_paid',
  NO_PAYMENT_REQUIRED: 'no_payment_required',
  NEEDS_REVIEW: 'needs_review'
});

const TUITION_INSTALLMENTS = Object.freeze(['DP', 'PRELIM', 'MIDTERM', 'FINALS']);
const TRACKING_MODES = Object.freeze(['whole', ...TUITION_INSTALLMENTS.map((value) => value.toLowerCase())]);

// This one projection powers both the overview counts and paginated roster filters.
const FINANCE_TERM_CLASSIFICATION_CTES = `FinanceChargeTotals AS (
    SELECT charge.annual_enrollment_id, charge.enrollment_id,
      COUNT(charge.id) AS assessed_charge_count,
      COUNT(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' THEN 1 END) AS tuition_line_count,
      COUNT(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition'
        AND LOWER(TRIM(charge.line_name)) = 'tuition'
        AND UPPER(TRIM(charge.installment)) IN ('DP', 'PRELIM', 'MIDTERM', 'FINALS') THEN 1 END) AS canonical_tuition_count,
      SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'DP' THEN 1 ELSE 0 END) AS dp_count,
      SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'PRELIM' THEN 1 ELSE 0 END) AS prelim_count,
      SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'MIDTERM' THEN 1 ELSE 0 END) AS midterm_count,
      SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'FINALS' THEN 1 ELSE 0 END) AS finals_count,
      CAST(SUM(due.amount_due + due.annual_allocated + due.legacy_allocated) AS DECIMAL(12,2)) AS required_amount,
      CAST(SUM(due.annual_allocated + due.legacy_allocated) AS DECIMAL(12,2)) AS applied_amount,
      CAST(SUM(due.amount_due) AS DECIMAL(12,2)) AS amount_due,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'DP'
        THEN due.amount_due + due.annual_allocated + due.legacy_allocated ELSE 0 END) AS DECIMAL(12,2)) AS dp_required,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'DP'
        THEN due.annual_allocated + due.legacy_allocated ELSE 0 END) AS DECIMAL(12,2)) AS dp_applied,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'DP'
        THEN due.amount_due ELSE 0 END) AS DECIMAL(12,2)) AS dp_due,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'PRELIM'
        THEN due.amount_due + due.annual_allocated + due.legacy_allocated ELSE 0 END) AS DECIMAL(12,2)) AS prelim_required,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'PRELIM'
        THEN due.annual_allocated + due.legacy_allocated ELSE 0 END) AS DECIMAL(12,2)) AS prelim_applied,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'PRELIM'
        THEN due.amount_due ELSE 0 END) AS DECIMAL(12,2)) AS prelim_due,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'MIDTERM'
        THEN due.amount_due + due.annual_allocated + due.legacy_allocated ELSE 0 END) AS DECIMAL(12,2)) AS midterm_required,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'MIDTERM'
        THEN due.annual_allocated + due.legacy_allocated ELSE 0 END) AS DECIMAL(12,2)) AS midterm_applied,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'MIDTERM'
        THEN due.amount_due ELSE 0 END) AS DECIMAL(12,2)) AS midterm_due,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'FINALS'
        THEN due.amount_due + due.annual_allocated + due.legacy_allocated ELSE 0 END) AS DECIMAL(12,2)) AS finals_required,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'FINALS'
        THEN due.annual_allocated + due.legacy_allocated ELSE 0 END) AS DECIMAL(12,2)) AS finals_applied,
      CAST(SUM(CASE WHEN LOWER(TRIM(charge.fee_category)) = 'tuition' AND UPPER(TRIM(charge.installment)) = 'FINALS'
        THEN due.amount_due ELSE 0 END) AS DECIMAL(12,2)) AS finals_due
    FROM assessed_charges AS charge
    INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
    GROUP BY charge.annual_enrollment_id, charge.enrollment_id
    LIMIT 18446744073709551615
  ), FinanceTermClassification AS (
    SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.school_year, annual.grade_level,
      annual.voucher_code, annual.intake_status, annual.entry_term_number,
      enrollment.id AS enrollment_id, enrollment.academic_term_id, enrollment.annual_term_number, enrollment.section_id,
      enrollment.enrollment_status, enrollment.term_scope_status, student.status AS student_status,
      assessment.id AS assessment_id, confirmation.id AS registrar_confirmation_id,
      COALESCE(charges.tuition_line_count, 0) AS tuition_line_count,
      COALESCE(charges.canonical_tuition_count, 0) AS canonical_tuition_count,
      COALESCE(charges.dp_count, 0) AS dp_count, COALESCE(charges.prelim_count, 0) AS prelim_count,
      COALESCE(charges.midterm_count, 0) AS midterm_count, COALESCE(charges.finals_count, 0) AS finals_count,
      COALESCE(charges.assessed_charge_count, 0) AS assessed_charge_count,
      CAST(COALESCE(charges.required_amount, 0) AS DECIMAL(12,2)) AS required_amount,
      CAST(COALESCE(charges.applied_amount, 0) AS DECIMAL(12,2)) AS applied_amount,
      CAST(COALESCE(charges.amount_due, 0) AS DECIMAL(12,2)) AS amount_due,
      CAST(COALESCE(charges.dp_required, 0) AS DECIMAL(12,2)) AS dp_required,
      CAST(COALESCE(charges.dp_applied, 0) AS DECIMAL(12,2)) AS dp_applied,
      CAST(COALESCE(charges.dp_due, 0) AS DECIMAL(12,2)) AS dp_due,
      CAST(COALESCE(charges.prelim_required, 0) AS DECIMAL(12,2)) AS prelim_required,
      CAST(COALESCE(charges.prelim_applied, 0) AS DECIMAL(12,2)) AS prelim_applied,
      CAST(COALESCE(charges.prelim_due, 0) AS DECIMAL(12,2)) AS prelim_due,
      CAST(COALESCE(charges.midterm_required, 0) AS DECIMAL(12,2)) AS midterm_required,
      CAST(COALESCE(charges.midterm_applied, 0) AS DECIMAL(12,2)) AS midterm_applied,
      CAST(COALESCE(charges.midterm_due, 0) AS DECIMAL(12,2)) AS midterm_due,
      CAST(COALESCE(charges.finals_required, 0) AS DECIMAL(12,2)) AS finals_required,
      CAST(COALESCE(charges.finals_applied, 0) AS DECIMAL(12,2)) AS finals_applied,
      CAST(COALESCE(charges.finals_due, 0) AS DECIMAL(12,2)) AS finals_due,
      CASE WHEN assessment.id IS NOT NULL AND confirmation.id IS NOT NULL
        AND COALESCE(charges.assessed_charge_count, 0) > 0 THEN 1 ELSE 0 END AS whole_tracking_available,
      CASE WHEN assessment.id IS NOT NULL AND confirmation.id IS NOT NULL
        AND COALESCE(charges.tuition_line_count, 0) = 4 AND COALESCE(charges.canonical_tuition_count, 0) = 4
        AND COALESCE(charges.dp_count, 0) = 1 AND COALESCE(charges.prelim_count, 0) = 1
        AND COALESCE(charges.midterm_count, 0) = 1 AND COALESCE(charges.finals_count, 0) = 1
        THEN 1 ELSE 0 END AS installment_tracking_available,
      CASE
        WHEN assessment.id IS NULL OR confirmation.id IS NULL
          OR COALESCE(charges.assessed_charge_count, 0) = 0
          THEN '${FINANCE_STATUS.NEEDS_REVIEW}'
        WHEN COALESCE(charges.required_amount, 0) <= 0 THEN '${FINANCE_STATUS.NO_PAYMENT_REQUIRED}'
        WHEN COALESCE(charges.applied_amount, 0) <= 0 THEN '${FINANCE_STATUS.UNPAID}'
        WHEN COALESCE(charges.amount_due, 0) > 0 THEN '${FINANCE_STATUS.PARTIAL}'
        ELSE '${FINANCE_STATUS.FULL}'
      END AS whole_status,
      CASE WHEN assessment.id IS NULL OR confirmation.id IS NULL OR COALESCE(charges.tuition_line_count, 0) <> 4
          OR COALESCE(charges.canonical_tuition_count, 0) <> 4
          OR COALESCE(charges.dp_count, 0) <> 1 OR COALESCE(charges.prelim_count, 0) <> 1
          OR COALESCE(charges.midterm_count, 0) <> 1 OR COALESCE(charges.finals_count, 0) <> 1
          THEN '${FINANCE_STATUS.NEEDS_REVIEW}'
        WHEN COALESCE(charges.dp_required, 0) <= 0 THEN '${FINANCE_STATUS.NO_PAYMENT_REQUIRED}'
        WHEN COALESCE(charges.dp_applied, 0) <= 0 THEN '${FINANCE_STATUS.UNPAID}'
        WHEN COALESCE(charges.dp_due, 0) > 0 THEN '${FINANCE_STATUS.PARTIAL}' ELSE '${FINANCE_STATUS.FULL}' END AS dp_status,
      CASE WHEN assessment.id IS NULL OR confirmation.id IS NULL OR COALESCE(charges.tuition_line_count, 0) <> 4
          OR COALESCE(charges.canonical_tuition_count, 0) <> 4
          OR COALESCE(charges.dp_count, 0) <> 1 OR COALESCE(charges.prelim_count, 0) <> 1
          OR COALESCE(charges.midterm_count, 0) <> 1 OR COALESCE(charges.finals_count, 0) <> 1
          THEN '${FINANCE_STATUS.NEEDS_REVIEW}'
        WHEN COALESCE(charges.prelim_required, 0) <= 0 THEN '${FINANCE_STATUS.NO_PAYMENT_REQUIRED}'
        WHEN COALESCE(charges.prelim_applied, 0) <= 0 THEN '${FINANCE_STATUS.UNPAID}'
        WHEN COALESCE(charges.prelim_due, 0) > 0 THEN '${FINANCE_STATUS.PARTIAL}' ELSE '${FINANCE_STATUS.FULL}' END AS prelim_status,
      CASE WHEN assessment.id IS NULL OR confirmation.id IS NULL OR COALESCE(charges.tuition_line_count, 0) <> 4
          OR COALESCE(charges.canonical_tuition_count, 0) <> 4
          OR COALESCE(charges.dp_count, 0) <> 1 OR COALESCE(charges.prelim_count, 0) <> 1
          OR COALESCE(charges.midterm_count, 0) <> 1 OR COALESCE(charges.finals_count, 0) <> 1
          THEN '${FINANCE_STATUS.NEEDS_REVIEW}'
        WHEN COALESCE(charges.midterm_required, 0) <= 0 THEN '${FINANCE_STATUS.NO_PAYMENT_REQUIRED}'
        WHEN COALESCE(charges.midterm_applied, 0) <= 0 THEN '${FINANCE_STATUS.UNPAID}'
        WHEN COALESCE(charges.midterm_due, 0) > 0 THEN '${FINANCE_STATUS.PARTIAL}' ELSE '${FINANCE_STATUS.FULL}' END AS midterm_status,
      CASE WHEN assessment.id IS NULL OR confirmation.id IS NULL OR COALESCE(charges.tuition_line_count, 0) <> 4
          OR COALESCE(charges.canonical_tuition_count, 0) <> 4
          OR COALESCE(charges.dp_count, 0) <> 1 OR COALESCE(charges.prelim_count, 0) <> 1
          OR COALESCE(charges.midterm_count, 0) <> 1 OR COALESCE(charges.finals_count, 0) <> 1
          THEN '${FINANCE_STATUS.NEEDS_REVIEW}'
        WHEN COALESCE(charges.finals_required, 0) <= 0 THEN '${FINANCE_STATUS.NO_PAYMENT_REQUIRED}'
        WHEN COALESCE(charges.finals_applied, 0) <= 0 THEN '${FINANCE_STATUS.UNPAID}'
        WHEN COALESCE(charges.finals_due, 0) > 0 THEN '${FINANCE_STATUS.PARTIAL}' ELSE '${FINANCE_STATUS.FULL}' END AS finals_status
    FROM enrollments AS enrollment
    INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
    INNER JOIN students AS student ON student.id = annual.student_id
    LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
    LEFT JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = annual.id
      AND confirmation.assessment_id = assessment.id
    LEFT JOIN FinanceChargeTotals AS charges ON charges.annual_enrollment_id = annual.id
      AND charges.enrollment_id = enrollment.id
    LIMIT 18446744073709551615
  )`;

module.exports = { FINANCE_STATUS, FINANCE_TERM_CLASSIFICATION_CTES, TRACKING_MODES, TUITION_INSTALLMENTS };
