'use strict';

const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { runSerializableTransaction } = require('./transactionRetry');
const { currentManilaDate } = require('./studentRecordsService');

const DEPARTURE_RECOVERY_BATCH_SIZE = 100;
const DEPARTURE_RECOVERY_INTERVAL_MS = 30000;
const CONFLICT_MESSAGES = Object.freeze({
  student_archived: 'The student record was archived after scheduling.',
  annual_identity_changed: 'The annual enrollment identity or intake source changed after scheduling.',
  annual_not_active: 'The annual enrollment is no longer active.',
  effective_placement_changed: 'The selected effective placement changed after scheduling.',
  target_placement_missing: 'An affected term placement is no longer available.',
  target_placement_not_applicable: 'An affected term is no longer applicable.',
  target_placement_cancelled: 'An affected term was cancelled after scheduling.',
  target_placement_departed: 'An affected term was stopped or transferred outside this scheduled case.',
  target_placement_changed: 'An affected placement changed after scheduling.'
});

function safeBatchSize(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 500 ? value : DEPARTURE_RECOVERY_BATCH_SIZE;
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value == null ? '' : String(value).slice(0, 10);
}

function jsonDetails(value) {
  return JSON.stringify(value);
}

function createDepartureLifecycleService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  todayProvider = () => currentManilaDate(),
  batchSize = DEPARTURE_RECOVERY_BATCH_SIZE
} = {}) {
  const recoveryBatchSize = safeBatchSize(batchSize);

  async function runTransaction(callback) {
    return runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
  }

  async function recordReview(transaction, caseId, reason, details) {
    await transaction.request().input('caseId', sql.BigInt, caseId)
      .input('reason', sql.VarChar(40), reason)
      .query(`UPDATE finance_departure_cases
        SET application_status = 'needs_review', application_review_reason = @reason,
            application_updated_at = UTC_TIMESTAMP(3)
        WHERE id = @caseId AND application_status = 'scheduled'`);
    await transaction.request().input('caseId', sql.BigInt, caseId)
      .input('eventType', sql.VarChar(20), 'needs_review')
      .input('source', sql.VarChar(20), 'system_scheduler')
      .input('details', sql.NVarChar(sql.MAX), jsonDetails({ reason, message: CONFLICT_MESSAGES[reason], ...details }))
      .query(`INSERT INTO finance_departure_application_events
        (departure_case_id, event_type, source, details_json)
        VALUES (@caseId, @eventType, @source, @details)`);
    return { status: 'needs_review', reason };
  }

  function identityConflict(caseRecord) {
    return Number(caseRecord.student_id) !== Number(caseRecord.student_id_at_recording)
      || caseRecord.school_year !== caseRecord.school_year_at_recording
      || caseRecord.grade_level !== caseRecord.grade_level_at_recording
      || Number(caseRecord.entry_term_number) !== Number(caseRecord.entry_term_number_at_recording)
      || caseRecord.intake_kind !== caseRecord.intake_kind_at_recording
      || (caseRecord.pre_enrollment_id || null) !== (caseRecord.pre_enrollment_id_at_recording || null)
      || (caseRecord.readmission_evaluation_id || null) !== (caseRecord.readmission_evaluation_id_at_recording || null)
      || Number(caseRecord.readmission_evaluation_version || 0) !== Number(caseRecord.readmission_evaluation_version_at_recording || 0)
      || Number(caseRecord.continuity_source_annual_enrollment_id || 0) !== Number(caseRecord.continuity_source_annual_enrollment_id_at_recording || 0);
  }

  function termConflict(term) {
    if (!term.enrollment_id_current) return 'target_placement_missing';
    if (Number(term.student_id) !== Number(term.student_id_at_recording)
      || Number(term.student_id) !== Number(term.case_student_id)
      || Number(term.annual_enrollment_id) !== Number(term.annual_enrollment_id_at_recording)
      || Number(term.annual_enrollment_id) !== Number(term.case_annual_enrollment_id)
      || Number(term.term_annual_student_id) !== Number(term.case_student_id)
      || Number(term.academic_term_id) !== Number(term.academic_term_id_at_recording)
      || Number(term.annual_term_number) !== Number(term.annual_term_number_at_recording)
      || term.school_year !== term.school_year_at_recording
      || term.school_year !== term.case_school_year
      || term.school_year !== term.term_annual_school_year) return 'target_placement_changed';
    if (term.term_scope_status !== 'applicable') return 'target_placement_not_applicable';
    if (term.enrollment_status === 'cancelled') return 'target_placement_cancelled';
    if (['dropped', 'transferred'].includes(term.enrollment_status)) return 'target_placement_departed';
    const statusStillApplies = term.enrollment_status_at_recording === 'pending_payment'
      ? ['pending_payment', 'enrolled'].includes(term.enrollment_status)
      : term.enrollment_status_at_recording === 'enrolled' && term.enrollment_status === 'enrolled';
    if (!statusStillApplies) return 'target_placement_changed';
    return null;
  }

  async function applyDueDeparture(caseId, today) {
    return runTransaction(async (transaction) => {
      const caseResult = await transaction.request().input('caseId', sql.BigInt, caseId)
        .query(`SELECT departure.id, departure.annual_enrollment_id, departure.effective_enrollment_id,
            departure.effective_date, departure.departure_type, departure.application_status,
            departure.student_id_at_recording, departure.school_year_at_recording,
            departure.grade_level_at_recording, departure.entry_term_number_at_recording,
            departure.intake_kind_at_recording, departure.pre_enrollment_id_at_recording,
            departure.readmission_evaluation_id_at_recording, departure.readmission_evaluation_version_at_recording,
            departure.continuity_source_annual_enrollment_id_at_recording,
            annual.student_id, annual.school_year, annual.grade_level, annual.entry_term_number,
            annual.intake_status, annual.intake_kind, annual.pre_enrollment_id,
            annual.readmission_evaluation_id, annual.readmission_evaluation_version,
            annual.continuity_source_annual_enrollment_id, student.status AS student_status,
            effective.annual_term_number AS effective_term_number
          FROM finance_departure_cases AS departure
          INNER JOIN annual_enrollments AS annual ON annual.id = departure.annual_enrollment_id
          INNER JOIN students AS student ON student.id = annual.student_id
          LEFT JOIN enrollments AS effective ON effective.id = departure.effective_enrollment_id
          WHERE departure.id = @caseId FOR UPDATE`);
      const caseRecord = caseResult.recordset?.[0];
      if (!caseRecord || caseRecord.application_status !== 'scheduled') return { status: 'skipped' };
      if (dateOnly(caseRecord.effective_date) > today) return { status: 'not_due' };

      let conflict = null;
      if (caseRecord.student_status === 'archived') conflict = 'student_archived';
      else if (identityConflict(caseRecord)) conflict = 'annual_identity_changed';
      else if (['legacy', 'cancelled', 'dropped', 'transferred'].includes(caseRecord.intake_status)) conflict = 'annual_not_active';

      const termsResult = await transaction.request().input('caseId', sql.BigInt, caseId)
        .query(`SELECT case_term.enrollment_id, case_term.enrollment_status_at_recording,
            case_term.student_id_at_recording, case_term.annual_enrollment_id_at_recording,
            case_term.academic_term_id_at_recording, case_term.annual_term_number_at_recording,
            case_term.term_scope_status_at_recording, enrollment.id AS enrollment_id_current,
            enrollment.student_id, enrollment.annual_enrollment_id, enrollment.academic_term_id,
            enrollment.annual_term_number, enrollment.term_scope_status, enrollment.enrollment_status,
            term.school_year, case_term.school_year_at_recording,
            annual.student_id AS term_annual_student_id, annual.school_year AS term_annual_school_year,
            departure.annual_enrollment_id AS case_annual_enrollment_id,
            departure.student_id_at_recording AS case_student_id,
            departure.school_year_at_recording AS case_school_year,
            CASE WHEN EXISTS (SELECT 1 FROM student_subjects AS assignment
              WHERE assignment.enrollment_id = enrollment.id) THEN 1 ELSE 0 END AS academic_activity_at_application
          FROM finance_departure_case_terms AS case_term
          INNER JOIN finance_departure_cases AS departure ON departure.id = case_term.departure_case_id
          LEFT JOIN enrollments AS enrollment ON enrollment.id = case_term.enrollment_id
          LEFT JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
          LEFT JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          WHERE case_term.departure_case_id = @caseId ORDER BY case_term.enrollment_id FOR UPDATE`);
      const terms = termsResult.recordset || [];
      const effective = terms.find((term) => Number(term.enrollment_id) === Number(caseRecord.effective_enrollment_id));
      if (!conflict && (!effective || Number(caseRecord.effective_term_number) !== Number(effective.annual_term_number_at_recording)
        || Number(effective.academic_term_id) !== Number(effective.academic_term_id_at_recording))) {
        conflict = 'effective_placement_changed';
      }
      if (!conflict && !terms.length) conflict = 'target_placement_missing';
      if (!conflict) {
        for (const term of terms) {
          conflict = termConflict(term);
          if (conflict) break;
        }
      }

      const activePlacements = await transaction.request()
        .input('annualEnrollmentId', sql.Int, caseRecord.annual_enrollment_id)
        .input('startTermNumber', sql.TinyInt, caseRecord.effective_term_number)
        .query(`SELECT id, student_id, academic_term_id, annual_term_number, enrollment_status, term_scope_status
          FROM enrollments
          WHERE annual_enrollment_id = @annualEnrollmentId AND annual_term_number >= @startTermNumber
            AND term_scope_status = 'applicable'
          ORDER BY annual_term_number, id FOR UPDATE`);
      const capturedIds = new Set(terms.map((term) => Number(term.enrollment_id)));
      const currentIds = new Set((activePlacements.recordset || []).map((term) => Number(term.id)));
      if (!conflict && (capturedIds.size !== currentIds.size || [...capturedIds].some((id) => !currentIds.has(id)))) {
        conflict = 'target_placement_changed';
      }
      if (conflict) {
        return recordReview(transaction, caseId, conflict, {
          effectiveDate: dateOnly(caseRecord.effective_date),
          affectedEnrollmentIds: terms.map((term) => Number(term.enrollment_id))
        });
      }

      const beforeStatuses = [];
      for (const term of terms) {
        const currentStatus = term.enrollment_status;
        const update = await transaction.request().input('enrollmentId', sql.Int, term.enrollment_id)
          .input('departureType', sql.VarChar(20), caseRecord.departure_type)
          .input('currentStatus', sql.VarChar(20), currentStatus)
          .query(`UPDATE enrollments SET enrollment_status = @departureType
            WHERE id = @enrollmentId AND enrollment_status = @currentStatus AND term_scope_status = 'applicable'`);
        if (update.rowsAffected?.[0] !== 1) throw new Error('Scheduled departure target changed during application.');
        await transaction.request().input('caseId', sql.BigInt, caseId)
          .input('enrollmentId', sql.Int, term.enrollment_id)
          .input('currentStatus', sql.VarChar(20), currentStatus)
          .input('academicActivity', sql.Bit, term.academic_activity_at_application)
          .query(`UPDATE finance_departure_case_terms
            SET enrollment_status_at_application = @currentStatus,
                academic_activity_review_required_at_application = @academicActivity,
                applied_at = UTC_TIMESTAMP(3)
            WHERE departure_case_id = @caseId AND enrollment_id = @enrollmentId`);
        beforeStatuses.push({ enrollmentId: Number(term.enrollment_id), status: currentStatus });
      }
      await transaction.request().input('caseId', sql.BigInt, caseId)
        .query(`UPDATE finance_departure_cases
          SET application_status = 'applied', application_review_reason = NULL,
              application_updated_at = UTC_TIMESTAMP(3)
          WHERE id = @caseId AND application_status = 'scheduled'`);
      await transaction.request().input('caseId', sql.BigInt, caseId)
        .input('eventType', sql.VarChar(20), 'applied')
        .input('source', sql.VarChar(20), 'system_scheduler')
        .input('details', sql.NVarChar(sql.MAX), jsonDetails({
          effectiveDate: dateOnly(caseRecord.effective_date), departureType: caseRecord.departure_type, beforeStatuses
        }))
        .query(`INSERT INTO finance_departure_application_events
          (departure_case_id, event_type, source, details_json)
          VALUES (@caseId, @eventType, @source, @details)`);
      return { status: 'applied', affected: beforeStatuses.length };
    });
  }

  async function processDueDepartures({ drain = false, limit = recoveryBatchSize } = {}) {
    const size = safeBatchSize(limit);
    const today = todayProvider();
    if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('Manila date provider returned an invalid date.');
    const totals = { applied: 0, needsReview: 0, skipped: 0, batches: 0 };
    while (true) {
      const pool = await getPool();
      const dueResult = await pool.request().input('today', sql.Date, today).input('limit', sql.Int, size)
        .query(`SELECT id FROM finance_departure_cases
          WHERE application_status = 'scheduled' AND effective_date <= @today
          ORDER BY effective_date, id LIMIT @limit`);
      const dueCases = dueResult.recordset || [];
      if (!dueCases.length) break;
      totals.batches += 1;
      for (const item of dueCases) {
        const result = await applyDueDeparture(item.id, today);
        if (result.status === 'applied') totals.applied += 1;
        else if (result.status === 'needs_review') totals.needsReview += 1;
        else totals.skipped += 1;
      }
      if (!drain || dueCases.length < size) break;
    }
    return totals;
  }

  return { processDueDepartures };
}

function startDepartureRecoveryScheduler(lifecycleService, {
  intervalMs = DEPARTURE_RECOVERY_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console
} = {}) {
  const scanIntervalMs = Number.isSafeInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 300000
    ? intervalMs
    : DEPARTURE_RECOVERY_INTERVAL_MS;
  let activeRun = null;
  let stopped = false;

  function run() {
    if (stopped) return Promise.resolve(null);
    if (activeRun) return activeRun;
    activeRun = Promise.resolve()
      .then(() => lifecycleService.processDueDepartures({ drain: false }))
      .catch(() => {
        logger.error('Scheduled departure recovery failed. Due cases will be retried on the next recovery scan.');
        return null;
      })
      .finally(() => { activeRun = null; });
    return activeRun;
  }

  const timer = setIntervalFn(() => { if (!stopped) void run(); }, scanIntervalMs);
  timer.unref?.();
  return {
    run,
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    }
  };
}

module.exports = {
  CONFLICT_MESSAGES,
  DEPARTURE_RECOVERY_BATCH_SIZE,
  DEPARTURE_RECOVERY_INTERVAL_MS,
  createDepartureLifecycleService,
  startDepartureRecoveryScheduler
};
