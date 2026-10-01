const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

const ID_PATTERN = /^\d{1,10}$/;
const STAFF_ROLES = new Set(['registrar', 'database_admin']);
const CURRENT_ECR_PERIODS = ['Term 1', 'Term 2', 'Term 3', 'Final Grade'];

class RegistrarGradeOverviewError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RegistrarGradeOverviewError';
    this.status = status;
  }
}

function normalizeId(value, label) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw new RegistrarGradeOverviewError(`Choose a valid ${label.toLowerCase()}.`);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new RegistrarGradeOverviewError(`Choose a valid ${label.toLowerCase()}.`);
  return id;
}

function normalizeOptionalId(value, label) {
  return value === undefined || value === null || value === '' ? null : normalizeId(value, label);
}

function formatStatus(row) {
  if (row.grade_id !== null && row.grade_id !== undefined) {
    return row.grade_value === null || row.grade_value === undefined ? 'published_blank' : 'published';
  }
  switch (row.submission_status) {
    case 'pending': return 'pending_review';
    case 'correction_requested': return 'correction_requested';
    case 'rejected': return 'rejected';
    case 'approved': return 'approved_unpublished';
    default: return 'no_submission';
  }
}

function createRegistrarGradeOverviewService({ getPool = defaultGetPool, sql = defaultSql } = {}) {
  async function requireStaff(pool, actorInput) {
    const actorId = normalizeId(actorInput, 'staff account');
    const result = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin')`);
    const actor = result.recordset?.[0];
    if (!actor || !STAFF_ROLES.has(actor.role)) throw new RegistrarGradeOverviewError('Staff-only grade overview access is unavailable.', 403);
    return actor;
  }

  async function listContexts(actorInput) {
    const pool = await getPool();
    await requireStaff(pool, actorInput);
    const terms = await pool.request().query(`SELECT id, school_year, term, is_current
      FROM academic_terms ORDER BY is_current DESC, school_year DESC, id DESC`);
    const sections = await pool.request().query(`SELECT section.id, section.name, section.grade_level,
        section.academic_term_id, term.school_year, term.term
      FROM sections AS section
      INNER JOIN academic_terms AS term ON term.id = section.academic_term_id
      ORDER BY term.is_current DESC, term.school_year DESC, term.id DESC, section.grade_level, section.name`);
    const subjects = await pool.request().query(`SELECT id, subject_code, subject_name
      FROM subjects ORDER BY subject_code, id`);
    return { terms: terms.recordset || [], sections: sections.recordset || [], subjects: subjects.recordset || [] };
  }

  async function getOverview(actorInput, filterInput = {}) {
    const termId = normalizeId(filterInput.termId, 'academic term');
    const sectionId = normalizeId(filterInput.sectionId, 'section');
    const subjectId = normalizeId(filterInput.subjectId, 'subject');
    const requestedPeriod = typeof filterInput.gradingPeriod === 'string' ? filterInput.gradingPeriod.trim() : '';
    if (requestedPeriod.length > 50 || /[\u0000-\u001f\u007f]/.test(requestedPeriod)) {
      throw new RegistrarGradeOverviewError('Choose a valid grading period.');
    }
    const pool = await getPool();
    await requireStaff(pool, actorInput);
    const contextResult = await pool.request()
      .input('termId', sql.Int, termId)
      .input('sectionId', sql.Int, sectionId)
      .input('subjectId', sql.Int, subjectId)
      .query(`SELECT term.id AS term_id, term.school_year, term.term, term.is_current,
          section.id AS section_id, section.name AS section_name, section.grade_level,
          subject.id AS subject_id, subject.subject_code, subject.subject_name
        FROM academic_terms AS term
        INNER JOIN sections AS section ON section.academic_term_id = term.id AND section.id = @sectionId
        CROSS JOIN subjects AS subject
        WHERE term.id = @termId AND subject.id = @subjectId`);
    const context = contextResult.recordset?.[0];
    if (!context) throw new RegistrarGradeOverviewError('Choose a section and subject from the selected academic term.', 404);

    const rows = await pool.request()
      .input('termId', sql.Int, termId)
      .input('sectionId', sql.Int, sectionId)
      .input('subjectId', sql.Int, subjectId)
      .input('isCurrent', sql.Bit, Boolean(context.is_current))
      .input('gradingPeriod', sql.NVarChar(50), requestedPeriod || null)
      .query(`WITH enrolled_subjects AS (
          SELECT enrollment.id AS enrollment_id, enrollment.student_id, enrollment.section_id,
            enrollment.enrollment_status, enrollment.term_scope_status,
            student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix,
            student.sex, student_subject.id AS student_subject_id,
            section.name AS section_name, section.grade_level,
            term.school_year, term.term, term.is_current, subject.id AS subject_id,
            subject.subject_code, subject.subject_name
          FROM enrollments AS enrollment
          INNER JOIN students AS student ON student.id = enrollment.student_id
          INNER JOIN sections AS section ON section.id = enrollment.section_id
            AND section.academic_term_id = enrollment.academic_term_id
          INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
          INNER JOIN student_subjects AS student_subject ON student_subject.enrollment_id = enrollment.id
            AND student_subject.subject_id = @subjectId
          INNER JOIN subjects AS subject ON subject.id = student_subject.subject_id
          WHERE enrollment.academic_term_id = @termId AND enrollment.section_id = @sectionId
            AND enrollment.enrollment_status = 'enrolled'
            AND enrollment.term_scope_status = 'applicable'
            AND student.status = 'active'
        ), period_names AS (
          SELECT DISTINCT grading_period FROM (
            SELECT grade.grading_period
            FROM grades AS grade
            INNER JOIN student_subjects AS student_subject ON student_subject.id = grade.student_subject_id
            INNER JOIN enrollments AS enrollment ON enrollment.id = student_subject.enrollment_id
            WHERE enrollment.academic_term_id = @termId AND enrollment.section_id = @sectionId
              AND student_subject.subject_id = @subjectId
            UNION ALL
            SELECT cached_grade.grading_period
            FROM teacher_assignments AS assignment
            INNER JOIN teacher_grade_submissions AS submission ON submission.assignment_id = assignment.id
            INNER JOIN teacher_grade_submission_rows AS submission_row ON submission_row.submission_id = submission.id
            INNER JOIN teacher_grade_submission_grades AS cached_grade ON cached_grade.submission_row_id = submission_row.id
            WHERE assignment.academic_term_id = @termId AND assignment.section_id = @sectionId
              AND assignment.subject_id = @subjectId
          ) AS observed
          UNION
          SELECT expected.grading_period
          FROM (SELECT 'Term 1' AS grading_period UNION ALL SELECT 'Term 2'
            UNION ALL SELECT 'Term 3' UNION ALL SELECT 'Final Grade') AS expected
          WHERE @isCurrent = 1
        ), latest_submission AS (
          SELECT submission.id, submission.status, submission.submitted_at
          FROM teacher_assignments AS assignment
          INNER JOIN teacher_grade_submissions AS submission ON submission.assignment_id = assignment.id
          WHERE assignment.academic_term_id = @termId AND assignment.section_id = @sectionId
            AND assignment.subject_id = @subjectId
          ORDER BY submission.submitted_at DESC, submission.id DESC LIMIT 1
        ), ranked_submission_rows AS (
          SELECT submission_row.id, submission_row.submission_id, submission_row.student_subject_id,
            ROW_NUMBER() OVER (PARTITION BY submission_row.submission_id, submission_row.student_subject_id
              ORDER BY submission_row.id DESC) AS row_number
          FROM teacher_grade_submission_rows AS submission_row
        ), ranked_submission_grades AS (
          SELECT submission_row.submission_id, submission_row.student_subject_id,
            cached_grade.id, cached_grade.grade_value, cached_grade.grading_period,
            ROW_NUMBER() OVER (PARTITION BY submission_row.submission_id, submission_row.student_subject_id, cached_grade.grading_period
              ORDER BY cached_grade.id DESC) AS row_number
          FROM teacher_grade_submission_rows AS submission_row
          INNER JOIN teacher_grade_submission_grades AS cached_grade ON cached_grade.submission_row_id = submission_row.id
        )
        SELECT roster.enrollment_id, roster.student_id, roster.student_no,
          roster.first_name, roster.middle_name, roster.last_name, roster.suffix, roster.sex,
          roster.section_name, roster.grade_level, roster.school_year, roster.term,
          roster.subject_code, roster.subject_name, period.grading_period,
          grade.id AS grade_id, grade.grade_value, grade.remarks AS grade_remarks,
          latest_submission.id AS latest_submission_id,
          CASE WHEN latest_submission_row.id IS NULL THEN NULL ELSE latest_submission.status END AS submission_status,
          latest_submission.submitted_at,
          CASE WHEN latest_submission_row.id IS NULL THEN CAST(0 AS BIT) ELSE CAST(1 AS BIT) END AS has_submission_row,
          cached_grade.grade_value AS cached_grade_value,
          CASE WHEN cached_grade.id IS NULL THEN CAST(0 AS BIT) ELSE CAST(1 AS BIT) END AS has_cached_grade
        FROM enrolled_subjects AS roster
        CROSS JOIN period_names AS period
        LEFT JOIN grades AS grade ON grade.student_subject_id = roster.student_subject_id
          AND grade.grading_period = period.grading_period
        LEFT JOIN latest_submission ON 1 = 1
        LEFT JOIN ranked_submission_rows AS latest_submission_row
          ON latest_submission_row.submission_id = latest_submission.id
          AND latest_submission_row.student_subject_id = roster.student_subject_id
          AND latest_submission_row.row_number = 1
        LEFT JOIN ranked_submission_grades AS cached_grade
          ON cached_grade.submission_id = latest_submission.id
          AND cached_grade.student_subject_id = roster.student_subject_id
          AND cached_grade.grading_period = period.grading_period
          AND cached_grade.row_number = 1
        WHERE @gradingPeriod IS NULL OR period.grading_period = @gradingPeriod
        ORDER BY roster.last_name, roster.first_name, roster.student_no, period.grading_period`);
    const rosterCount = await pool.request()
      .input('termId', sql.Int, termId)
      .input('sectionId', sql.Int, sectionId)
      .input('subjectId', sql.Int, subjectId)
      .query(`SELECT COUNT(DISTINCT enrollment.student_id) AS distinct_learners
        FROM enrollments AS enrollment
        INNER JOIN students AS student ON student.id = enrollment.student_id
        INNER JOIN student_subjects AS student_subject ON student_subject.enrollment_id = enrollment.id
          AND student_subject.subject_id = @subjectId
        WHERE enrollment.academic_term_id = @termId AND enrollment.section_id = @sectionId
          AND enrollment.enrollment_status = 'enrolled' AND enrollment.term_scope_status = 'applicable'
          AND student.status = 'active'`);

    const entries = (rows.recordset || []).map((row) => ({
      ...row,
      status: formatStatus(row),
      hasCachedGrade: Boolean(row.has_cached_grade),
      displayName: [row.first_name, row.middle_name, row.last_name, row.suffix].filter(Boolean).join(' ')
    }));
    const periods = [...new Set(entries.map((row) => row.grading_period))];
    if (requestedPeriod && !periods.includes(requestedPeriod)) {
      throw new RegistrarGradeOverviewError('That grading period is not recorded for this academic context.', 404);
    }
    const learnerIds = new Set(entries.map((row) => row.student_id));
    return {
      context,
      periods,
      selectedPeriod: requestedPeriod,
      entries,
      totals: {
        distinctLearners: Number(rosterCount.recordset?.[0]?.distinct_learners || learnerIds.size),
        periodEntries: entries.length,
        published: entries.filter((row) => row.status === 'published').length,
        publishedBlank: entries.filter((row) => row.status === 'published_blank').length,
        noSubmission: entries.filter((row) => row.status === 'no_submission').length,
        pendingReview: entries.filter((row) => row.status === 'pending_review').length,
        correctionRequested: entries.filter((row) => row.status === 'correction_requested').length,
        rejected: entries.filter((row) => row.status === 'rejected').length,
        approvedUnpublished: entries.filter((row) => row.status === 'approved_unpublished').length
      }
    };
  }

  return { listContexts, getOverview };
}

module.exports = { RegistrarGradeOverviewError, createRegistrarGradeOverviewService, CURRENT_ECR_PERIODS, formatStatus };
