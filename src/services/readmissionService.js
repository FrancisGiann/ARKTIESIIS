'use strict';

const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { runSerializableTransaction } = require('./transactionRetry');
const { validateName, StudentRecordsError } = require('./studentRecordsService');

const READ_ROLES = new Set(['registrar', 'database_admin']);
const WRITE_ROLES = new Set(['registrar']);

class ReadmissionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ReadmissionError';
    this.status = status;
  }
}

function text(value, label, maxLength, required = false, allowNewlines = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ReadmissionError(`${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new ReadmissionError(`${label} must be ${maxLength} printable characters or fewer.`);
  const result = value.replace(/\r\n?/g, '\n').trim();
  const invalidControl = allowNewlines ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (result.length > maxLength || invalidControl.test(result) || required && !result) {
    throw new ReadmissionError(`${label} is required and must be ${maxLength} printable characters or fewer.`);
  }
  return result || null;
}

function positiveId(value, label) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
    throw new ReadmissionError(`Choose a valid ${label}.`);
  }
  return Number(raw);
}

function evaluationInput(input = {}) {
  const lrn = text(input.applicantLrn, 'Applicant LRN', 12, true);
  if (!/^\d{12}$/.test(lrn)) throw new ReadmissionError('Applicant LRN must contain exactly 12 digits.');
  const schoolYear = text(input.schoolYear, 'School year', 20, true);
  if (!/^\d{4}-\d{4}$/.test(schoolYear) || Number(schoolYear.slice(5)) !== Number(schoolYear.slice(0, 4)) + 1) {
    throw new ReadmissionError('School year must use consecutive YYYY-YYYY values.');
  }
  const targetGradeLevel = text(input.targetGradeLevel, 'Target grade', 20, true);
  if (!['Grade 11', 'Grade 12'].includes(targetGradeLevel)) throw new ReadmissionError('Choose Grade 11 or Grade 12.');
  const subjectAvailability = input.subjectAvailability || 'unresolved';
  if (!['unresolved', 'available', 'unavailable'].includes(subjectAvailability)) throw new ReadmissionError('Choose a valid subject availability result.');
  const curriculumReviewStatus = input.curriculumReviewStatus || 'unresolved';
  if (!['unresolved', 'resolved'].includes(curriculumReviewStatus)) throw new ReadmissionError('Choose a valid curriculum review result.');
  let firstName;
  let middleName;
  let lastName;
  let suffix;
  try {
    firstName = validateName(input.firstName, 'First name');
    middleName = validateName(input.middleName, 'Middle name');
    lastName = validateName(input.lastName, 'Last name');
    suffix = validateName(input.suffix, 'Suffix', { maxLength: 20 });
  } catch (error) {
    if (error instanceof StudentRecordsError) throw new ReadmissionError(error.message);
    throw error;
  }
  return {
    applicantLrn: lrn,
    firstName, middleName, lastName, suffix,
    schoolYear,
    targetGradeLevel,
    priorProgress: text(input.priorProgress, 'Prior progress', 4000, true, true),
    evidenceReviewed: text(input.evidenceReviewed, 'Evidence reviewed', 4000, true, true),
    form137Supporting: input.form137Supporting === true || input.form137Supporting === '1' || input.form137Supporting === 'on',
    curriculumComparison: text(input.curriculumComparison, 'Curriculum comparison', 4000, true, true),
    curriculumReviewStatus,
    requiredSubjects: text(input.requiredSubjects, 'Required subjects', 4000, true, true),
    subjectAvailability,
    availabilityNotes: text(input.availabilityNotes, 'Subject availability notes', 4000, false, true),
    decisionReason: text(input.decisionReason, 'Decision reason', 4000, false, true)
  };
}

function createReadmissionService({ getPool = defaultGetPool, sql = defaultSql, transactionFactory = (pool) => new sql.Transaction(pool) } = {}) {
  async function transaction(callback) {
    return runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
  }

  async function actor(request, id, allowed) {
    const userId = positiveId(id, 'staff account');
    const result = await request.input('actorId', sql.Int, userId)
      .query('SELECT id, role FROM users WHERE id = @actorId AND is_active = 1');
    const row = result.recordset?.[0];
    if (!row || !allowed.has(row.role)) throw new ReadmissionError('You cannot access readmission evaluations.', 403);
    return row;
  }

  async function audit(transactionHandle, user, action, id, details) {
    await transactionHandle.request().input('actorId', sql.Int, user.id)
      .input('action', sql.NVarChar(100), `registrar.readmission_${action}`)
      .input('entityId', sql.NVarChar(100), id)
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, 'readmission_evaluation', @entityId, @details)`);
  }

  async function assertNewSchoolYear(transactionHandle, values, studentId) {
    if (!studentId) return;
    const schoolYear = values.schoolYear ?? values.school_year;
    const currentYear = await transactionHandle.request().input('studentId', sql.Int, studentId)
      .input('schoolYear', sql.NVarChar(20), schoolYear)
      .query('SELECT id FROM annual_enrollments WHERE student_id = @studentId AND school_year = @schoolYear FOR UPDATE');
    if (currentYear.recordset?.length) {
      throw new ReadmissionError('Same-year reactivation is not available in the balik-aral evaluation workflow.', 409);
    }
  }

  function snapshot(values, status, studentId = null) {
    return {
      studentId,
      applicantLrn: values.applicantLrn,
      firstName: values.firstName,
      middleName: values.middleName,
      lastName: values.lastName,
      suffix: values.suffix,
      schoolYear: values.schoolYear,
      targetGradeLevel: values.targetGradeLevel,
      priorProgress: values.priorProgress,
      evidenceReviewed: values.evidenceReviewed,
      form137Supporting: values.form137Supporting === true || Number(values.form137Supporting) === 1,
      curriculumComparison: values.curriculumComparison,
      curriculumReviewStatus: values.curriculumReviewStatus,
      requiredSubjects: values.requiredSubjects,
      subjectAvailability: values.subjectAvailability,
      availabilityNotes: values.availabilityNotes,
      decisionReason: values.decisionReason,
      status
    };
  }

  function valuesFromRow(row) {
    return {
      applicantLrn: row.applicant_lrn,
      firstName: row.first_name,
      middleName: row.middle_name,
      lastName: row.last_name,
      suffix: row.suffix,
      schoolYear: row.school_year,
      targetGradeLevel: row.target_grade_level,
      priorProgress: row.prior_progress,
      evidenceReviewed: row.evidence_reviewed,
      form137Supporting: row.form137_supporting,
      curriculumComparison: row.curriculum_comparison,
      curriculumReviewStatus: row.curriculum_review_status,
      requiredSubjects: row.required_subjects,
      subjectAvailability: row.subject_availability,
      availabilityNotes: row.availability_notes,
      decisionReason: row.decision_reason
    };
  }

  async function event(transactionHandle, { id, version, userId, type, from, to, changedFields = [], before = null, after = null }) {
    await transactionHandle.request().input('evaluationId', sql.Char(36), id)
      .input('version', sql.Int, version).input('actorId', sql.Int, userId)
      .input('eventType', sql.VarChar(24), type).input('fromStatus', sql.VarChar(24), from)
      .input('toStatus', sql.VarChar(24), to)
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify({ changedFields, before, after }))
      .query(`INSERT INTO readmission_evaluation_events
        (evaluation_id, evaluation_version, actor_id, event_type, from_status, to_status, details_json)
        VALUES (@evaluationId, @version, @actorId, @eventType, @fromStatus, @toStatus, @details)`);
  }

  function bindValues(request, values) {
    return request.input('applicantLrn', sql.Char(12), values.applicantLrn)
      .input('firstName', sql.NVarChar(100), values.firstName).input('middleName', sql.NVarChar(100), values.middleName)
      .input('lastName', sql.NVarChar(100), values.lastName).input('suffix', sql.NVarChar(20), values.suffix)
      .input('schoolYear', sql.NVarChar(20), values.schoolYear).input('targetGradeLevel', sql.NVarChar(20), values.targetGradeLevel)
      .input('priorProgress', sql.NVarChar(sql.MAX), values.priorProgress).input('evidenceReviewed', sql.NVarChar(sql.MAX), values.evidenceReviewed)
      .input('form137Supporting', sql.Bit, values.form137Supporting)
      .input('curriculumComparison', sql.NVarChar(sql.MAX), values.curriculumComparison)
      .input('curriculumReviewStatus', sql.VarChar(20), values.curriculumReviewStatus)
      .input('requiredSubjects', sql.NVarChar(sql.MAX), values.requiredSubjects)
      .input('subjectAvailability', sql.VarChar(20), values.subjectAvailability)
      .input('availabilityNotes', sql.NVarChar(sql.MAX), values.availabilityNotes)
      .input('decisionReason', sql.NVarChar(sql.MAX), values.decisionReason);
  }

  async function get(actorId, id) {
    const pool = await getPool();
    await actor(pool.request(), actorId, READ_ROLES);
    const result = await pool.request().input('evaluationId', sql.Char(36), id)
      .query(`SELECT evaluation.*, student.student_no,
          EXISTS(SELECT 1 FROM annual_enrollments AS annual
            WHERE annual.readmission_evaluation_id = evaluation.id AND annual.intake_status = 'enrollment_started') AS enrollment_started,
          creator.first_name AS creator_first_name, creator.last_name AS creator_last_name,
          updater.first_name AS updater_first_name, updater.last_name AS updater_last_name,
          decider.first_name AS decider_first_name, decider.last_name AS decider_last_name
        FROM readmission_evaluations AS evaluation
        LEFT JOIN students AS student ON student.id = evaluation.student_id
        LEFT JOIN staff_profiles AS creator ON creator.user_id = evaluation.created_by
        LEFT JOIN staff_profiles AS updater ON updater.user_id = evaluation.updated_by
        LEFT JOIN staff_profiles AS decider ON decider.user_id = evaluation.decided_by
        WHERE evaluation.id = @evaluationId`);
    const evaluation = result.recordset?.[0];
    if (!evaluation) throw new ReadmissionError('Readmission evaluation not found.', 404);
    const history = await pool.request().input('evaluationId', sql.Char(36), id)
      .query(`SELECT event.*, staff.first_name, staff.last_name FROM readmission_evaluation_events AS event
        LEFT JOIN staff_profiles AS staff ON staff.user_id = event.actor_id
        WHERE event.evaluation_id = @evaluationId ORDER BY event.created_at DESC, event.id DESC`);
    return { ...evaluation, events: history.recordset || [] };
  }

  async function list(actorId, filters = {}) {
    const pool = await getPool();
    await actor(pool.request(), actorId, READ_ROLES);
    const status = filters.status || '';
    if (status && !['under_review', 'accepted', 'not_accepted'].includes(status)) throw new ReadmissionError('Choose a valid evaluation status.');
    const search = text(filters.search || '', 'Search', 100) || '';
    const rows = await pool.request().input('status', sql.VarChar(24), status).input('search', sql.NVarChar(100), search)
      .query(`SELECT evaluation.id, evaluation.applicant_lrn, evaluation.first_name, evaluation.middle_name,
          evaluation.last_name, evaluation.school_year, evaluation.target_grade_level, evaluation.status, evaluation.version,
          evaluation.updated_at, staff.first_name AS updater_first_name, staff.last_name AS updater_last_name
        FROM readmission_evaluations AS evaluation
        LEFT JOIN staff_profiles AS staff ON staff.user_id = evaluation.updated_by
        WHERE (@status = '' OR evaluation.status = @status)
          AND (@search = '' OR evaluation.applicant_lrn LIKE CONCAT('%', @search, '%')
            OR CONCAT_WS(' ', evaluation.first_name, evaluation.middle_name, evaluation.last_name) LIKE CONCAT('%', @search, '%'))
        ORDER BY evaluation.updated_at DESC, evaluation.id DESC LIMIT 100`);
    return rows.recordset || [];
  }

  async function create(actorId, raw = {}) {
    const values = evaluationInput(raw);
    const id = crypto.randomUUID();
    return transaction(async (tx) => {
      const user = await actor(tx.request(), actorId, WRITE_ROLES);
      const linked = await tx.request().input('lrn', sql.Char(12), values.applicantLrn)
        .query('SELECT id FROM students WHERE lrn = @lrn FOR UPDATE');
      if (linked.recordset?.length > 1) throw new ReadmissionError('More than one existing student record matches this LRN. Resolve the records first.', 409);
      const studentId = linked.recordset?.[0]?.id || null;
      await assertNewSchoolYear(tx, values, studentId);
      const request = bindValues(tx.request(), values).input('id', sql.Char(36), id).input('studentId', sql.Int, studentId)
        .input('actorId', sql.Int, user.id).input('status', sql.VarChar(24), 'under_review');
      await request
        .query(`INSERT INTO readmission_evaluations
          (id, applicant_lrn, student_id, first_name, middle_name, last_name, suffix, school_year, target_grade_level,
            prior_progress, evidence_reviewed, form137_supporting, curriculum_comparison, curriculum_review_status, required_subjects,
            subject_availability, availability_notes, decision_reason, status, version, created_by, updated_by)
          VALUES (@id, @applicantLrn, @studentId, @firstName, @middleName, @lastName, @suffix, @schoolYear, @targetGradeLevel,
            @priorProgress, @evidenceReviewed, @form137Supporting, @curriculumComparison, @curriculumReviewStatus, @requiredSubjects,
            @subjectAvailability, @availabilityNotes, @decisionReason, @status, 1, @actorId, @actorId)`);
      await event(tx, { id, version: 1, userId: user.id, type: 'created', from: null, to: 'under_review',
        changedFields: [...Object.keys(values), 'studentId'], after: snapshot(values, 'under_review', studentId) });
      await audit(tx, user, 'created', id, { version: 1, linkedStudent: Boolean(studentId) });
      return { id, version: 1, status: 'under_review' };
    });
  }

  async function update(actorId, id, expectedVersion, raw = {}) {
    const values = evaluationInput(raw);
    const version = positiveId(expectedVersion, 'evaluation version');
    return transaction(async (tx) => {
      const user = await actor(tx.request(), actorId, WRITE_ROLES);
      const startedSource = await tx.request().input('evaluationId', sql.Char(36), id)
        .query(`SELECT id FROM pre_enrollments
          WHERE readmission_evaluation_id = @evaluationId AND status = 'enrollment_started' LIMIT 1 FOR UPDATE`);
      if (startedSource.recordset?.length) {
        throw new ReadmissionError('This evaluation is locked because its annual enrollment has started.', 409);
      }
      const currentResult = await tx.request().input('id', sql.Char(36), id)
        .query('SELECT * FROM readmission_evaluations WHERE id = @id FOR UPDATE');
      const current = currentResult.recordset?.[0];
      if (!current) throw new ReadmissionError('Readmission evaluation not found.', 404);
      if (Number(current.version) !== version) throw new ReadmissionError('This evaluation changed. Reload and review the latest version.', 409);
      const linked = await tx.request().input('lrn', sql.Char(12), values.applicantLrn)
        .query('SELECT id FROM students WHERE lrn = @lrn FOR UPDATE');
      if (linked.recordset?.length > 1) throw new ReadmissionError('More than one existing student record matches this LRN. Resolve the records first.', 409);
      const studentId = linked.recordset?.[0]?.id || null;
      await assertNewSchoolYear(tx, values, studentId);
      const request = bindValues(tx.request(), values).input('id', sql.Char(36), id).input('studentId', sql.Int, studentId)
        .input('version', sql.Int, version + 1).input('actorId', sql.Int, user.id);
      await request
        .query(`UPDATE readmission_evaluations SET applicant_lrn = @applicantLrn,
          student_id = @studentId, first_name = @firstName, middle_name = @middleName, last_name = @lastName,
          suffix = @suffix, school_year = @schoolYear, target_grade_level = @targetGradeLevel,
          prior_progress = @priorProgress, evidence_reviewed = @evidenceReviewed,
          form137_supporting = @form137Supporting, curriculum_comparison = @curriculumComparison,
          curriculum_review_status = @curriculumReviewStatus, required_subjects = @requiredSubjects,
          subject_availability = @subjectAvailability,
          availability_notes = @availabilityNotes, decision_reason = @decisionReason,
          status = 'under_review', version = @version, updated_by = @actorId, decided_by = NULL, decided_at = NULL,
          updated_at = UTC_TIMESTAMP(3) WHERE id = @id`);
      await event(tx, { id, version: version + 1, userId: user.id,
        type: current.status === 'accepted' || current.status === 'not_accepted' ? 'reopened' : 'updated',
        from: current.status, to: 'under_review', changedFields: [...Object.keys(values), 'status',
          ...(Number(current.student_id || 0) !== Number(studentId || 0) ? ['studentId'] : [])],
        before: snapshot(valuesFromRow(current), current.status, current.student_id),
        after: snapshot(values, 'under_review', studentId) });
      await audit(tx, user, 'updated', id, { version: version + 1, status: 'under_review' });
      return { id, version: version + 1, status: 'under_review' };
    });
  }

  async function decide(actorId, id, expectedVersion, decision, reason) {
    const version = positiveId(expectedVersion, 'evaluation version');
    if (!['accepted', 'not_accepted'].includes(decision)) throw new ReadmissionError('Choose Accepted or Not accepted.');
    const normalizedReason = text(reason, 'Decision reason', 4000, true, true);
    return transaction(async (tx) => {
      const user = await actor(tx.request(), actorId, WRITE_ROLES);
      const result = await tx.request().input('id', sql.Char(36), id).query('SELECT * FROM readmission_evaluations WHERE id = @id FOR UPDATE');
      const current = result.recordset?.[0];
      if (!current) throw new ReadmissionError('Readmission evaluation not found.', 404);
      if (Number(current.version) !== version) throw new ReadmissionError('This evaluation changed. Reload and review the latest version.', 409);
      if (current.status !== 'under_review') throw new ReadmissionError('Only an evaluation under review can receive a decision.', 409);
      let linkedStudentId = current.student_id == null ? null : Number(current.student_id);
      if (decision === 'accepted') {
        if (!linkedStudentId) {
          const linked = await tx.request().input('lrn', sql.Char(12), current.applicant_lrn)
            .query('SELECT id FROM students WHERE lrn = @lrn FOR UPDATE');
          if (linked.recordset?.length > 1) throw new ReadmissionError('More than one existing student record matches this LRN. Resolve the records first.', 409);
          linkedStudentId = linked.recordset?.[0]?.id || null;
        }
        await assertNewSchoolYear(tx, current, linkedStudentId);
      }
      if (decision === 'accepted' && (current.subject_availability !== 'available'
        || current.curriculum_review_status !== 'resolved'
        || !String(current.prior_progress || '').trim() || !String(current.evidence_reviewed || '').trim()
        || !String(current.curriculum_comparison || '').trim() || !String(current.required_subjects || '').trim())) {
        throw new ReadmissionError('Acceptance requires reviewed prior progress and evidence, a resolved curriculum comparison, required subjects, and confirmed subject availability.', 409);
      }
      const nextVersion = version + 1;
      await tx.request().input('id', sql.Char(36), id).input('actorId', sql.Int, user.id)
        .input('version', sql.Int, nextVersion).input('decision', sql.VarChar(24), decision)
        .input('studentId', sql.Int, linkedStudentId)
        .input('reason', sql.NVarChar(4000), normalizedReason)
        .query(`UPDATE readmission_evaluations SET student_id = @studentId,
          status = @decision, decision_reason = @reason, version = @version,
          updated_by = @actorId, decided_by = @actorId, decided_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
          WHERE id = @id`);
      const before = snapshot(valuesFromRow(current), current.status, current.student_id);
      const after = snapshot({ ...valuesFromRow(current), decisionReason: normalizedReason }, decision, linkedStudentId);
      await event(tx, { id, version: nextVersion, userId: user.id, type: decision, from: current.status, to: decision,
        before, after,
        changedFields: linkedStudentId !== (current.student_id == null ? null : Number(current.student_id))
          ? ['status', 'decisionReason', 'studentId'] : ['status', 'decisionReason'] });
      await audit(tx, user, decision, id, { version: nextVersion, linkedStudent: Boolean(linkedStudentId) });
      return { id, version: nextVersion, status: decision };
    });
  }

  return { list, get, create, update, decide };
}

module.exports = { ReadmissionError, evaluationInput, createReadmissionService };
