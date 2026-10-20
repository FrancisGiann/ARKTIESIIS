'use strict';

const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');
const { parseMoneyCents, formatMoneyCents, FinanceServiceError } = require('./financeService');
const { runSerializableTransaction } = require('./transactionRetry');

const ID = /^\d{1,10}$/;
const BIG_ID = /^\d{1,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_INTAKE_KINDS = new Set(['transferee', 'returning', 'readmission']);

class RetakeReferralError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RetakeReferralError';
    this.status = status;
  }
}

function validId(value, label, large = false) {
  const raw = typeof value === 'number' ? String(value) : value;
  const pattern = large ? BIG_ID : ID;
  if (typeof raw !== 'string' || !pattern.test(raw)) throw new RetakeReferralError(`Choose a valid ${label}.`);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || (!large && id > 2147483647)) throw new RetakeReferralError(`Choose a valid ${label}.`);
  return id;
}

function safeText(value, label, maxLength, required = true) {
  if (typeof value !== 'string') throw new RetakeReferralError(`${label} must be ${maxLength} printable characters or fewer.`);
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > maxLength || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new RetakeReferralError(`${label} is required and must be ${maxLength} printable characters or fewer.`);
  }
  return cleaned || null;
}

function safeTextArea(value, label, maxLength, required = true) {
  if (typeof value !== 'string') throw new RetakeReferralError(`${label} must be ${maxLength} characters or fewer.`);
  const cleaned = value.replace(/\r\n?/g, '\n').trim();
  if ((required && !cleaned) || cleaned.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cleaned)) {
    throw new RetakeReferralError(`${label} is required and must be ${maxLength} characters or fewer.`);
  }
  return cleaned || null;
}

function validToken(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new RetakeReferralError(`The ${label} token is invalid. Reload the form and try again.`);
  return value.toLowerCase();
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function dbId(result, label) {
  const id = Number(result?.insertId || result?.recordset?.[0]?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${label} insert returned no safe identifier.`);
  return id;
}

function createRetakeReferralService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  transaction: boundTransaction = null,
  annualFinanceService = null
} = {}) {
  async function transact(callback) {
    try {
      if (boundTransaction) return await callback(boundTransaction);
      return await runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new RetakeReferralError('This retake workflow was already recorded or conflicts with a current record.', 409);
      throw error;
    }
  }

  async function requireActor(request, actorInput, roles, message) {
    const actorId = validId(actorInput, 'user');
    const result = await request.input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users WHERE id = @actorId AND is_active = 1 AND role IN (${roles.map((role, index) => `@role${index}`).join(', ')}) FOR UPDATE`);
    // Bind role values after building the parameterized role list.
    const actor = result.recordset?.[0];
    if (!actor) throw new RetakeReferralError(message, 403);
    return actor;
  }

  function bindRoles(request, roles) {
    roles.forEach((role, index) => request.input(`role${index}`, sql.NVarChar(20), role));
    return request;
  }

  async function actor(pool, actorInput, roles, message) {
    return requireActor(bindRoles(pool.request(), roles), actorInput, roles, message);
  }

  async function audit(tx, actorRow, action, entityType, entityId, details) {
    await tx.request().input('actorId', sql.Int, actorRow.id)
      .input('action', sql.NVarChar(100), action)
      .input('entityType', sql.NVarChar(100), entityType)
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @details)`);
  }

  async function referralEvent(tx, referralId, actorId, eventType, details = {}) {
    await tx.request().input('referralId', sql.BigInt, referralId)
      .input('actorId', sql.Int, actorId).input('eventType', sql.NVarChar(24), eventType)
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO registrar_retake_referral_events (referral_id, actor_id, event_type, details_json)
        VALUES (@referralId, @actorId, @eventType, @details)`);
  }

  async function readAnnual(tx, annualId, lock = true) {
    const result = await tx.request().input('annualId', sql.Int, annualId)
      .query(`SELECT annual.id, annual.student_id, annual.school_year, annual.grade_level, annual.intake_kind,
          annual.intake_status, annual.entry_term_number, annual.readmission_evaluation_id,
          annual.readmission_evaluation_version, student.status AS student_status,
          student.lrn, student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix
        FROM annual_enrollments AS annual
        INNER JOIN students AS student ON student.id = annual.student_id
        WHERE annual.id = @annualId${lock ? ' FOR UPDATE' : ''}`);
    const row = result.recordset?.[0];
    if (!row || !ALLOWED_INTAKE_KINDS.has(row.intake_kind)) throw new RetakeReferralError('Choose a current transferee or returning annual enrollment.', 404);
    if (row.student_status === 'archived' || !['pending', 'enrolled'].includes(row.intake_status)) {
      throw new RetakeReferralError('This annual enrollment is read-only for retake referrals.', 409);
    }
    return row;
  }

  async function currentReadmissionBinding(tx, annual) {
    if (!annual.readmission_evaluation_id) {
      if (annual.intake_kind === 'readmission') throw new RetakeReferralError('This return enrollment has no linked accepted return evaluation.', 409);
      return { id: null, version: null };
    }
    const evaluationResult = await tx.request().input('evaluationId', sql.Char(36), annual.readmission_evaluation_id)
      .query(`SELECT id, student_id, applicant_lrn, school_year, target_grade_level, status, version
        FROM readmission_evaluations WHERE id = @evaluationId FOR UPDATE`);
    const evaluation = evaluationResult.recordset?.[0];
    const version = Number(annual.readmission_evaluation_version);
    if (!evaluation || evaluation.status !== 'accepted' || Number(evaluation.student_id) !== Number(annual.student_id)
      || evaluation.applicant_lrn !== annual.lrn || evaluation.school_year !== annual.school_year
      || evaluation.target_grade_level !== annual.grade_level || !Number.isInteger(version) || version < 1
      || Number(evaluation.version) !== version) {
      throw new RetakeReferralError('The linked return evaluation changed or is no longer accepted. Reopen Registrar review before continuing.', 409);
    }
    return { id: evaluation.id, version };
  }

  async function validateReadmissionBinding(tx, annual, expectedId = annual.readmission_evaluation_id,
    expectedVersion = annual.readmission_evaluation_version) {
    if (!annual.readmission_evaluation_id
      && (expectedId != null || expectedVersion != null)) {
      throw new RetakeReferralError('The linked return evaluation was removed. Start a Registrar correction before Finance review.', 409);
    }
    const binding = await currentReadmissionBinding(tx, annual);
    if (binding.id !== (expectedId || null)
      || (binding.id && Number(binding.version) !== Number(expectedVersion))
      || (!binding.id && expectedVersion != null)) {
      throw new RetakeReferralError('The linked return evaluation changed or is no longer accepted. Start a Registrar correction before Finance review.', 409);
    }
    return binding;
  }

  async function requireDraft(tx, referralId, actorId) {
    const result = await tx.request().input('referralId', sql.BigInt, referralId)
      .query(`SELECT id, annual_enrollment_id, revision_no, intake_kind_snapshot, evaluation_reference,
          readmission_evaluation_id, readmission_evaluation_version, status, is_current
        FROM registrar_retake_referrals WHERE id = @referralId FOR UPDATE`);
    const referral = result.recordset?.[0];
    if (!referral) throw new RetakeReferralError('Retake referral not found.', 404);
    if (referral.status !== 'draft' || Number(referral.is_current) !== 1) throw new RetakeReferralError('This referral version is no longer editable. Start a correction from the latest version.', 409);
    const annual = await readAnnual(tx, Number(referral.annual_enrollment_id));
    const binding = await validateReadmissionBinding(tx, annual, referral.readmission_evaluation_id, referral.readmission_evaluation_version);
    if (binding.id !== (referral.readmission_evaluation_id || null)) throw new RetakeReferralError('The evaluation binding changed. Start a new referral version.', 409);
    return { referral, annual };
  }

  async function validateTargetTerm(tx, annual, termInput, { requireAssessment = false } = {}) {
    const termNumber = Number(termInput);
    if (!Number.isInteger(termNumber) || termNumber < 1 || termNumber > 3 || termNumber < Number(annual.entry_term_number || 1)) {
      throw new RetakeReferralError('Choose an applicable target term for this annual enrollment.');
    }
    const annualId = annual.id ?? annual.annual_enrollment_id;
    if (!Number.isSafeInteger(Number(annualId)) || Number(annualId) < 1) throw new RetakeReferralError('The annual enrollment binding is unavailable.', 409);
    const result = await tx.request().input('annualId', sql.Int, Number(annualId)).input('termNumber', sql.TinyInt, termNumber)
      .query(`SELECT enrollment.id, enrollment.annual_term_number, enrollment.enrollment_status, enrollment.term_scope_status,
          assessment.id AS assessment_id
        FROM enrollments AS enrollment
        LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = enrollment.annual_enrollment_id
        WHERE enrollment.annual_enrollment_id = @annualId AND enrollment.annual_term_number = @termNumber FOR UPDATE`);
    const placement = result.recordset?.[0];
    if (!placement || placement.term_scope_status !== 'applicable'
      || !['pending_payment', 'enrolled'].includes(placement.enrollment_status)) {
      throw new RetakeReferralError('The target term must have a current applicable enrollment placement.', 409);
    }
    if (requireAssessment && !placement.assessment_id) throw new RetakeReferralError('Post the annual assessment for the target enrollment before Finance can review a retake item.', 409);
    return { ...placement, termNumber };
  }

  async function listTargets(actorId) {
    const pool = await getPool();
    await actor(pool, actorId, ['registrar', 'database_admin'], 'Your Registrar access is no longer active. Sign in again.');
    const result = await pool.request().query(`SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.school_year,
        annual.grade_level, annual.intake_kind, annual.intake_status, annual.entry_term_number,
        annual.readmission_evaluation_id, annual.readmission_evaluation_version, student.student_no, student.lrn,
        CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) AS student_name,
        referral.id AS current_referral_id, referral.revision_no AS current_referral_revision,
        referral.status AS current_referral_status
      FROM annual_enrollments AS annual INNER JOIN students AS student ON student.id = annual.student_id
      LEFT JOIN registrar_retake_referrals AS referral
        ON referral.annual_enrollment_id = annual.id AND referral.current_annual_enrollment_id = annual.id
      WHERE annual.intake_kind IN ('transferee', 'returning', 'readmission')
        AND annual.intake_status IN ('pending', 'enrolled') AND student.status = 'active'
      ORDER BY annual.school_year DESC, student.last_name, student.first_name, annual.id`);
    return result.recordset || [];
  }

  async function listTargetTerms(actorId, annualInput) {
    const annualId = validId(annualInput, 'annual enrollment');
    const pool = await getPool();
    await actor(pool, actorId, ['registrar', 'database_admin'], 'Your Registrar access is no longer active. Sign in again.');
    const result = await pool.request().input('annualId', sql.Int, annualId)
      .query(`SELECT DISTINCT enrollment.annual_term_number AS term_number
        FROM enrollments AS enrollment INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
        WHERE annual.id = @annualId AND enrollment.annual_term_number BETWEEN annual.entry_term_number AND 3
          AND enrollment.term_scope_status = 'applicable' AND enrollment.enrollment_status IN ('pending_payment', 'enrolled')
        ORDER BY enrollment.annual_term_number`);
    return (result.recordset || []).map((row) => Number(row.term_number));
  }

  async function listTargetSubjects(actorId, annualInput) {
    const annualId = validId(annualInput, 'annual enrollment');
    const pool = await getPool();
    await actor(pool, actorId, ['registrar', 'database_admin'], 'Your Registrar access is no longer active. Sign in again.');
    const result = await pool.request().input('annualId', sql.Int, annualId)
      .query(`SELECT DISTINCT enrollment.annual_term_number AS term_number,
          subject.id, subject.subject_code, subject.subject_name
        FROM enrollments AS enrollment INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
        INNER JOIN student_subjects AS assignment ON assignment.enrollment_id = enrollment.id
        INNER JOIN subjects AS subject ON subject.id = assignment.subject_id
        WHERE annual.id = @annualId AND enrollment.annual_term_number BETWEEN annual.entry_term_number AND 3
          AND enrollment.term_scope_status = 'applicable' AND enrollment.enrollment_status IN ('pending_payment', 'enrolled')
        ORDER BY enrollment.annual_term_number, subject.subject_name, subject.id`);
    return result.recordset || [];
  }

  async function listReferralHistory(actorId, annualInput) {
    const annualId = validId(annualInput, 'annual enrollment');
    const pool = await getPool();
    await actor(pool, actorId, ['registrar', 'database_admin'], 'Your Registrar access is no longer active. Sign in again.');
    const result = await pool.request().input('annualId', sql.Int, annualId)
      .query(`SELECT referral.id, referral.revision_no, referral.intake_kind_snapshot, referral.evaluation_reference,
          referral.readmission_evaluation_id, referral.readmission_evaluation_version, referral.status, referral.is_current,
          referral.created_at, referral.finalized_at, referral.finalized_by,
          item.id AS item_id, item.item_key_id, item.subject_name, item.subject_id,
          linked_subject.subject_code AS linked_subject_code, linked_subject.subject_name AS linked_subject_name,
          item.target_term_number,
          item.finance_explanation, decision.decision AS finance_decision,
          CAST(decision.approved_amount AS CHAR(40)) AS approved_amount,
          decision.charge_description, decision.decision_reason, decision.charge_id,
          CAST(charge.waived_amount AS CHAR(40)) AS waived_amount, CAST(charge.gross_amount AS CHAR(40)) AS gross_amount,
          CAST(due.amount_due AS CHAR(40)) AS amount_due
        FROM registrar_retake_referrals AS referral
        LEFT JOIN registrar_retake_referral_items AS item ON item.referral_id = referral.id
        LEFT JOIN subjects AS linked_subject ON linked_subject.id = item.subject_id
        LEFT JOIN finance_retake_item_decisions AS decision ON decision.referral_item_id = item.id
        LEFT JOIN assessed_charges AS charge ON charge.id = decision.charge_id
        LEFT JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
        WHERE referral.annual_enrollment_id = @annualId
        ORDER BY referral.revision_no DESC, item.target_term_number, item.id`);
    const versions = new Map();
    for (const row of result.recordset || []) {
      let version = versions.get(Number(row.id));
      if (!version) {
        version = { ...row, items: [] };
        versions.set(Number(row.id), version);
      }
      if (row.item_id) version.items.push(row);
    }
    return [...versions.values()];
  }

  async function getReferral(actorId, referralInput) {
    const referralId = validId(referralInput, 'referral', true);
    const pool = await getPool();
    await actor(pool, actorId, ['registrar', 'database_admin'], 'Your Registrar access is no longer active. Sign in again.');
    const headerResult = await pool.request().input('referralId', sql.BigInt, referralId)
      .query(`SELECT referral.id, referral.annual_enrollment_id, referral.revision_no, referral.intake_kind_snapshot,
          referral.evaluation_reference, referral.readmission_evaluation_id, referral.readmission_evaluation_version,
          referral.status, referral.is_current, referral.created_at, referral.finalized_at,
          annual.student_id, annual.school_year, annual.grade_level, annual.intake_kind, annual.intake_status,
          annual.entry_term_number, student.student_no, student.lrn,
          CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) AS student_name,
          evaluation.status AS evaluation_status, evaluation.version AS current_evaluation_version,
          annual.readmission_evaluation_id AS annual_evaluation_id,
          annual.readmission_evaluation_version AS annual_evaluation_version
        FROM registrar_retake_referrals AS referral
        INNER JOIN annual_enrollments AS annual ON annual.id = referral.annual_enrollment_id
        INNER JOIN students AS student ON student.id = annual.student_id
        LEFT JOIN readmission_evaluations AS evaluation ON evaluation.id = referral.readmission_evaluation_id
        WHERE referral.id = @referralId`);
    const referral = headerResult.recordset?.[0];
    if (!referral) throw new RetakeReferralError('Retake referral not found.', 404);
    const [items, events] = await Promise.all([
      pool.request().input('referralId', sql.BigInt, referralId).query(`SELECT item.id, item.item_key_id, item.subject_name,
          item.subject_id, linked_subject.subject_code AS linked_subject_code,
          linked_subject.subject_name AS linked_subject_name, item.target_term_number, item.finance_explanation,
          decision.decision AS finance_decision,
          CAST(decision.approved_amount AS CHAR(40)) AS approved_amount, decision.charge_description,
          decision.decision_reason, decision.charge_id, CAST(charge.waived_amount AS CHAR(40)) AS waived_amount,
          CAST(charge.gross_amount AS CHAR(40)) AS gross_amount, CAST(due.amount_due AS CHAR(40)) AS amount_due,
          stable_charge.id AS stable_charge_id, stable_charge.charge_id AS linked_charge_id,
          stable_charge.charge_description AS linked_charge_description,
          CAST(stable_charge.approved_amount AS CHAR(40)) AS linked_charge_approved_amount,
          CAST(linked_charge.waived_amount AS CHAR(40)) AS linked_charge_waived_amount,
          CAST(linked_charge.gross_amount AS CHAR(40)) AS linked_charge_gross_amount,
          CAST(linked_due.amount_due AS CHAR(40)) AS linked_charge_amount_due
        FROM registrar_retake_referral_items AS item
        INNER JOIN registrar_retake_referrals AS referral ON referral.id = item.referral_id
        LEFT JOIN subjects AS linked_subject ON linked_subject.id = item.subject_id
        LEFT JOIN finance_retake_item_decisions AS decision ON decision.referral_item_id = item.id
        LEFT JOIN assessed_charges AS charge ON charge.id = decision.charge_id
        LEFT JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
        LEFT JOIN finance_retake_item_decisions AS stable_charge ON stable_charge.item_key_id = item.item_key_id
          AND stable_charge.decision = 'charge' AND referral.is_current = 1
        LEFT JOIN assessed_charges AS linked_charge ON linked_charge.id = stable_charge.charge_id
        LEFT JOIN v_finance_assessed_charge_due AS linked_due ON linked_due.charge_id = stable_charge.charge_id
        WHERE item.referral_id = @referralId ORDER BY item.target_term_number, item.subject_name, item.id`),
      pool.request().input('referralId', sql.BigInt, referralId).query(`SELECT id, event_type, details_json, created_at
        FROM registrar_retake_referral_events WHERE referral_id = @referralId ORDER BY id`)
    ]);
    return { ...referral, items: items.recordset || [], events: events.recordset || [] };
  }

  async function createDraft(actorInput, annualInput, input = {}) {
    const annualId = validId(annualInput, 'annual enrollment');
    const evaluationReference = safeText(input.evaluationReference, 'Evaluation reference', 160);
    const idempotencyKey = validToken(input.idempotencyKey, 'referral');
    return transact(async (tx) => {
      const actorRow = await actor({ request: () => tx.request() }, actorInput, ['registrar'], 'Only the Registrar can create retake referrals.');
      const annual = await readAnnual(tx, annualId);
      const binding = await validateReadmissionBinding(tx, annual);
      const currentResult = await tx.request().input('annualId', sql.Int, annualId)
        .query(`SELECT id, revision_no, status FROM registrar_retake_referrals
          WHERE annual_enrollment_id = @annualId AND current_annual_enrollment_id = @annualId FOR UPDATE`);
      const current = currentResult.recordset?.[0];
      if (current?.status === 'draft') throw new RetakeReferralError('Finish or correct the current draft before creating another referral.', 409);
      if (current?.status === 'finalized') throw new RetakeReferralError('Start a correction from the current finalized referral.', 409);
      const revisionNo = Number(current?.revision_no || 0) + 1;
      const inserted = await tx.request().input('annualId', sql.Int, annualId).input('revisionNo', sql.Int, revisionNo)
        .input('kind', sql.NVarChar(20), annual.intake_kind).input('reference', sql.NVarChar(160), evaluationReference)
        .input('evaluationId', sql.Char(36), binding.id).input('evaluationVersion', sql.Int, binding.version)
        .input('key', sql.Char(36), idempotencyKey).input('actorId', sql.Int, actorRow.id)
        .query(`INSERT INTO registrar_retake_referrals
          (annual_enrollment_id, revision_no, intake_kind_snapshot, evaluation_reference,
            readmission_evaluation_id, readmission_evaluation_version, idempotency_key, created_by)
          VALUES (@annualId, @revisionNo, @kind, @reference, @evaluationId, @evaluationVersion, @key, @actorId)`);
      const referralId = dbId(inserted, 'Retake referral');
      await referralEvent(tx, referralId, actorRow.id, 'created', { annualEnrollmentId: annualId, revisionNo, intakeKind: annual.intake_kind });
      await audit(tx, actorRow, 'registrar.retake_referral_created', 'registrar_retake_referral', referralId,
        { annualEnrollmentId: annualId, revisionNo, intakeKind: annual.intake_kind, evaluationReference });
      return { referralId, revisionNo };
    });
  }

  async function updateEvaluationReference(actorInput, referralInput, input = {}) {
    const referralId = validId(referralInput, 'referral', true);
    const evaluationReference = safeText(input.evaluationReference, 'Evaluation reference', 160);
    return transact(async (tx) => {
      const actorRow = await actor({ request: () => tx.request() }, actorInput, ['registrar'], 'Only the Registrar can edit retake referrals.');
      const { referral } = await requireDraft(tx, referralId, actorRow.id);
      if (referral.evaluation_reference === evaluationReference) return { referralId, unchanged: true };
      const updated = await tx.request().input('referralId', sql.BigInt, referralId)
        .input('reference', sql.NVarChar(160), evaluationReference)
        .query(`UPDATE registrar_retake_referrals SET evaluation_reference = @reference
          WHERE id = @referralId AND status = 'draft' AND is_current = 1`);
      if (updated.rowsAffected?.at(-1) !== 1) throw new RetakeReferralError('The referral changed. Reload and try again.', 409);
      const details = { previousReference: referral.evaluation_reference, evaluationReference };
      await referralEvent(tx, referralId, actorRow.id, 'reference_updated', details);
      await audit(tx, actorRow, 'registrar.retake_referral_reference_updated', 'registrar_retake_referral', referralId, details);
      return { referralId, unchanged: false };
    });
  }

  function normalizeItem(input = {}) {
    const subjectId = input.subjectId == null || input.subjectId === '' ? null : validId(input.subjectId, 'subject');
    const termNumber = Number(input.targetTerm);
    if (!Number.isInteger(termNumber) || termNumber < 1 || termNumber > 3) throw new RetakeReferralError('Choose a target term from 1 to 3.');
    return {
      subjectId,
      subjectName: safeText(input.subjectName, 'Subject or module name', 120),
      targetTerm: termNumber,
      explanation: safeTextArea(input.financeExplanation, 'Finance-safe explanation', 500)
    };
  }

  async function resolveSubject(tx, annual, termNumber, item) {
    const placement = await validateTargetTerm(tx, annual, termNumber);
    if (!item.subjectId) return { placement, subjectName: item.subjectName };
    const result = await tx.request().input('subjectId', sql.Int, item.subjectId).input('enrollmentId', sql.Int, placement.id)
      .query(`SELECT subject.id, subject.subject_name FROM student_subjects AS assignment
        INNER JOIN subjects AS subject ON subject.id = assignment.subject_id
        WHERE assignment.subject_id = @subjectId AND assignment.enrollment_id = @enrollmentId FOR UPDATE`);
    const subject = result.recordset?.[0];
    if (!subject) throw new RetakeReferralError('The selected subject must already be assigned in the target enrollment term.', 409);
    return { placement, subjectName: subject.subject_name };
  }

  async function addItem(actorInput, referralInput, input = {}) {
    const referralId = validId(referralInput, 'referral', true);
    const item = normalizeItem(input);
    const keyToken = validToken(input.itemKeyToken, 'item');
    return transact(async (tx) => {
      const actorRow = await actor({ request: () => tx.request() }, actorInput, ['registrar'], 'Only the Registrar can edit retake referrals.');
      const { referral, annual } = await requireDraft(tx, referralId, actorRow.id);
      const resolved = await resolveSubject(tx, annual, item.targetTerm, item);
      const duplicateReviewed = await tx.request().input('annualId', sql.Int, annual.id)
        .input('term', sql.TinyInt, item.targetTerm).input('subjectName', sql.NVarChar(120), resolved.subjectName)
        .input('subjectId', sql.Int, item.subjectId)
        .query(`SELECT decision.id FROM registrar_retake_referrals AS prior_referral
          INNER JOIN registrar_retake_referral_items AS prior_item ON prior_item.referral_id = prior_referral.id
          INNER JOIN finance_retake_item_decisions AS decision ON decision.item_key_id = prior_item.item_key_id
            AND decision.decision = 'charge'
          WHERE prior_referral.annual_enrollment_id = @annualId AND prior_item.target_term_number = @term
            AND prior_item.subject_name = @subjectName AND (prior_item.subject_id <=> @subjectId) LIMIT 1`);
      if (duplicateReviewed.recordset?.length) throw new RetakeReferralError('This subject and term already have a Finance decision. Keep that history and correct posted money through Finance.', 409);
      const keyResult = await tx.request().input('annualId', sql.Int, annual.id).input('key', sql.Char(36), keyToken)
        .query('INSERT INTO registrar_retake_item_keys (annual_enrollment_id, idempotency_key) VALUES (@annualId, @key)');
      const itemKeyId = dbId(keyResult, 'Retake item key');
      const inserted = await tx.request().input('referralId', sql.BigInt, referralId).input('annualId', sql.Int, annual.id)
        .input('itemKeyId', sql.BigInt, itemKeyId).input('subjectName', sql.NVarChar(120), resolved.subjectName)
        .input('subjectId', sql.Int, item.subjectId).input('term', sql.TinyInt, item.targetTerm)
        .input('explanation', sql.NVarChar(500), item.explanation)
        .query(`INSERT INTO registrar_retake_referral_items
          (referral_id, annual_enrollment_id, item_key_id, subject_name, subject_id, target_term_number, finance_explanation)
          VALUES (@referralId, @annualId, @itemKeyId, @subjectName, @subjectId, @term, @explanation)`);
      const itemId = dbId(inserted, 'Retake item');
      const details = { itemId, itemKeyId, subjectName: resolved.subjectName, subjectId: item.subjectId,
        targetTerm: item.targetTerm, financeExplanation: item.explanation };
      await referralEvent(tx, referralId, actorRow.id, 'item_added', details);
      await audit(tx, actorRow, 'registrar.retake_referral_item_added', 'registrar_retake_referral_item', itemId, details);
      return { itemId };
    });
  }

  async function editItem(actorInput, referralInput, itemInput, input = {}) {
    const referralId = validId(referralInput, 'referral', true);
    const itemId = validId(itemInput, 'item', true);
    const item = normalizeItem(input);
    return transact(async (tx) => {
      const actorRow = await actor({ request: () => tx.request() }, actorInput, ['registrar'], 'Only the Registrar can edit retake referrals.');
      const { referral, annual } = await requireDraft(tx, referralId, actorRow.id);
      const currentResult = await tx.request().input('itemId', sql.BigInt, itemId).input('referralId', sql.BigInt, referralId)
        .query(`SELECT item.id, item.item_key_id, decision.id AS decision_id FROM registrar_retake_referral_items AS item
          LEFT JOIN finance_retake_item_decisions AS decision ON decision.item_key_id = item.item_key_id
            AND decision.decision = 'charge'
          WHERE item.id = @itemId AND item.referral_id = @referralId FOR UPDATE`);
      const current = currentResult.recordset?.[0];
      if (!current) throw new RetakeReferralError('Retake item not found in this referral.', 404);
      if (current.decision_id) throw new RetakeReferralError('A Finance-reviewed item is preserved as history. Correct posted money through the reviewed adjustment or reversal workflow.', 409);
      const resolved = await resolveSubject(tx, annual, item.targetTerm, item);
      const updated = await tx.request().input('itemId', sql.BigInt, itemId)
        .input('subjectName', sql.NVarChar(120), resolved.subjectName).input('subjectId', sql.Int, item.subjectId)
        .input('term', sql.TinyInt, item.targetTerm).input('explanation', sql.NVarChar(500), item.explanation)
        .query(`UPDATE registrar_retake_referral_items SET subject_name = @subjectName, subject_id = @subjectId,
          target_term_number = @term, finance_explanation = @explanation WHERE id = @itemId`);
      if (updated.rowsAffected?.at(-1) !== 1) throw new RetakeReferralError('The retake item changed. Reload and try again.', 409);
      const details = { itemId, itemKeyId: Number(current.item_key_id), subjectName: resolved.subjectName,
        subjectId: item.subjectId, targetTerm: item.targetTerm, financeExplanation: item.explanation };
      await referralEvent(tx, referralId, actorRow.id, 'item_updated', details);
      await audit(tx, actorRow, 'registrar.retake_referral_item_updated', 'registrar_retake_referral_item', itemId, details);
      return { itemId };
    });
  }

  async function removeItem(actorInput, referralInput, itemInput) {
    const referralId = validId(referralInput, 'referral', true);
    const itemId = validId(itemInput, 'item', true);
    return transact(async (tx) => {
      const actorRow = await actor({ request: () => tx.request() }, actorInput, ['registrar'], 'Only the Registrar can edit retake referrals.');
      const { referral } = await requireDraft(tx, referralId, actorRow.id);
      const currentResult = await tx.request().input('itemId', sql.BigInt, itemId).input('referralId', sql.BigInt, referralId)
        .query(`SELECT item.id, item.item_key_id, item.subject_name, item.target_term_number,
          decision.id AS decision_id FROM registrar_retake_referral_items AS item
          LEFT JOIN finance_retake_item_decisions AS decision ON decision.item_key_id = item.item_key_id
            AND decision.decision = 'charge'
          WHERE item.id = @itemId AND item.referral_id = @referralId FOR UPDATE`);
      const current = currentResult.recordset?.[0];
      if (!current) throw new RetakeReferralError('Retake item not found in this referral.', 404);
      if (current.decision_id) throw new RetakeReferralError('A Finance-reviewed item is preserved as history and cannot be removed.', 409);
      await tx.request().input('itemId', sql.BigInt, itemId).query('DELETE FROM registrar_retake_referral_items WHERE id = @itemId');
      const details = { itemId, itemKeyId: Number(current.item_key_id), subjectName: current.subject_name, targetTerm: Number(current.target_term_number) };
      await referralEvent(tx, referralId, actorRow.id, 'item_removed', details);
      await audit(tx, actorRow, 'registrar.retake_referral_item_removed', 'registrar_retake_referral_item', itemId, details);
      return { removed: true };
    });
  }

  async function startCorrection(actorInput, referralInput, idempotencyInput) {
    const referralId = validId(referralInput, 'referral', true);
    const idempotencyKey = validToken(idempotencyInput, 'correction');
    return transact(async (tx) => {
      const actorRow = await actor({ request: () => tx.request() }, actorInput, ['registrar'], 'Only the Registrar can correct retake referrals.');
      const currentResult = await tx.request().input('referralId', sql.BigInt, referralId)
        .query(`SELECT referral.id, referral.annual_enrollment_id, referral.revision_no, referral.intake_kind_snapshot,
            referral.evaluation_reference, referral.readmission_evaluation_id, referral.readmission_evaluation_version,
            referral.status, referral.is_current, annual.intake_status
          FROM registrar_retake_referrals AS referral INNER JOIN annual_enrollments AS annual
            ON annual.id = referral.annual_enrollment_id
          WHERE referral.id = @referralId FOR UPDATE`);
      const current = currentResult.recordset?.[0];
      if (!current || current.status !== 'finalized' || Number(current.is_current) !== 1) throw new RetakeReferralError('Only the current finalized referral can be corrected.', 409);
      const annual = await readAnnual(tx, Number(current.annual_enrollment_id));
      // Starting a new version is the explicit Registrar action that rebinds a
      // referral to the annual enrollment's currently accepted evaluation.
      // The prior version and any Finance decision remain immutable history.
      const binding = await currentReadmissionBinding(tx, annual);
      const updated = await tx.request().input('referralId', sql.BigInt, referralId)
        .query('UPDATE registrar_retake_referrals SET is_current = 0 WHERE id = @referralId AND is_current = 1');
      if (updated.rowsAffected?.at(-1) !== 1) throw new RetakeReferralError('The referral changed. Reload and try again.', 409);
      const inserted = await tx.request().input('annualId', sql.Int, current.annual_enrollment_id)
        .input('revisionNo', sql.Int, Number(current.revision_no) + 1)
        .input('kind', sql.NVarChar(20), current.intake_kind_snapshot)
        .input('reference', sql.NVarChar(160), current.evaluation_reference)
        .input('evaluationId', sql.Char(36), binding.id)
        .input('evaluationVersion', sql.Int, binding.version)
        .input('key', sql.Char(36), idempotencyKey).input('actorId', sql.Int, actorRow.id)
        .query(`INSERT INTO registrar_retake_referrals
          (annual_enrollment_id, revision_no, intake_kind_snapshot, evaluation_reference,
            readmission_evaluation_id, readmission_evaluation_version, idempotency_key, created_by)
          VALUES (@annualId, @revisionNo, @kind, @reference, @evaluationId, @evaluationVersion, @key, @actorId)`);
      const newReferralId = dbId(inserted, 'Retake referral correction');
      await tx.request().input('newReferralId', sql.BigInt, newReferralId).input('annualId', sql.Int, current.annual_enrollment_id)
        .input('oldReferralId', sql.BigInt, referralId)
        .query(`INSERT INTO registrar_retake_referral_items
          (referral_id, annual_enrollment_id, item_key_id, subject_name, subject_id, target_term_number, finance_explanation)
          SELECT @newReferralId, item.annual_enrollment_id, item.item_key_id, item.subject_name,
            item.subject_id, item.target_term_number, item.finance_explanation
          FROM registrar_retake_referral_items AS item WHERE item.referral_id = @oldReferralId`);
      await referralEvent(tx, newReferralId, actorRow.id, 'correction_started', { previousReferralId: referralId,
        revisionNo: Number(current.revision_no) + 1, previousEvaluationId: current.readmission_evaluation_id || null,
        previousEvaluationVersion: current.readmission_evaluation_version == null ? null : Number(current.readmission_evaluation_version),
        evaluationId: binding.id, evaluationVersion: binding.version });
      await audit(tx, actorRow, 'registrar.retake_referral_correction_started', 'registrar_retake_referral', newReferralId,
        { previousReferralId: referralId, revisionNo: Number(current.revision_no) + 1,
          previousEvaluationId: current.readmission_evaluation_id || null,
          previousEvaluationVersion: current.readmission_evaluation_version == null ? null : Number(current.readmission_evaluation_version),
          evaluationId: binding.id, evaluationVersion: binding.version });
      return { referralId: newReferralId, revisionNo: Number(current.revision_no) + 1 };
    });
  }

  async function finalize(actorInput, referralInput) {
    const referralId = validId(referralInput, 'referral', true);
    return transact(async (tx) => {
      const actorRow = await actor({ request: () => tx.request() }, actorInput, ['registrar'], 'Only the Registrar can finalize retake referrals.');
      const { referral, annual } = await requireDraft(tx, referralId, actorRow.id);
      const items = await tx.request().input('referralId', sql.BigInt, referralId)
        .query(`SELECT id, target_term_number FROM registrar_retake_referral_items
          WHERE referral_id = @referralId ORDER BY id FOR UPDATE`);
      const rows = items.recordset || [];
      if (rows.length < 1 || rows.length > 30) throw new RetakeReferralError('Add between 1 and 30 retake items before finalizing.');
      for (const item of rows) await validateTargetTerm(tx, annual, item.target_term_number);
      await validateReadmissionBinding(tx, annual, referral.readmission_evaluation_id, referral.readmission_evaluation_version);
      const reopened = await tx.request().input('referralId', sql.BigInt, referralId)
        .query(`UPDATE finance_retake_item_decisions AS decision
          INNER JOIN registrar_retake_referral_items AS item ON item.item_key_id = decision.item_key_id
          SET decision.superseded_at = UTC_TIMESTAMP(3)
          WHERE item.referral_id = @referralId AND decision.decision = 'no_charge' AND decision.superseded_at IS NULL`);
      const updated = await tx.request().input('referralId', sql.BigInt, referralId).input('actorId', sql.Int, actorRow.id)
        .query(`UPDATE registrar_retake_referrals SET status = 'finalized', finalized_by = @actorId,
          finalized_at = UTC_TIMESTAMP(3) WHERE id = @referralId AND status = 'draft' AND is_current = 1`);
      if (updated.rowsAffected?.at(-1) !== 1) throw new RetakeReferralError('The referral changed while it was being finalized.', 409);
      await referralEvent(tx, referralId, actorRow.id, 'finalized', { itemCount: rows.length, revisionNo: Number(referral.revision_no),
        priorNoChargeDecisionsReopened: Number(reopened.rowsAffected?.at(-1) || 0) });
      await audit(tx, actorRow, 'registrar.retake_referral_finalized', 'registrar_retake_referral', referralId,
        { annualEnrollmentId: annual.id, itemCount: rows.length, revisionNo: Number(referral.revision_no),
          priorNoChargeDecisionsReopened: Number(reopened.rowsAffected?.at(-1) || 0) });
      return { referralId, itemCount: rows.length };
    });
  }

  async function readFinanceItem(tx, itemKeyInput, lock = false) {
    const itemKeyId = validId(itemKeyInput, 'retake item', true);
    const result = await tx.request().input('itemKeyId', sql.BigInt, itemKeyId)
      .query(`SELECT item_key.id AS item_key_id, item.id AS item_id, item.referral_id,
          referral.annual_enrollment_id, referral.revision_no, referral.intake_kind_snapshot,
          referral.evaluation_reference, referral.readmission_evaluation_id,
          referral.readmission_evaluation_version, annual.student_id, annual.school_year,
          annual.grade_level, annual.intake_kind, annual.intake_status, annual.entry_term_number,
          annual.readmission_evaluation_id AS annual_evaluation_id,
          annual.readmission_evaluation_version AS annual_evaluation_version,
          annual.id AS current_annual_enrollment_id,
          student.status AS student_status, student.student_no, student.lrn,
          CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) AS student_name,
          item.subject_name, item.subject_id, linked_subject.subject_code AS linked_subject_code,
          linked_subject.subject_name AS linked_subject_name, item.target_term_number, item.finance_explanation,
          enrollment.id AS enrollment_id, enrollment.enrollment_status, enrollment.term_scope_status,
          assessment.id AS assessment_id, decision.id AS decision_id, decision.decision AS finance_decision,
          decision.charge_id, CAST(decision.approved_amount AS CHAR(40)) AS approved_amount,
          decision.charge_description, decision.decision_reason
        FROM registrar_retake_item_keys AS item_key
        INNER JOIN registrar_retake_referral_items AS item ON item.item_key_id = item_key.id
        INNER JOIN registrar_retake_referrals AS referral ON referral.id = item.referral_id
          AND referral.annual_enrollment_id = item.annual_enrollment_id
        INNER JOIN annual_enrollments AS annual ON annual.id = referral.annual_enrollment_id
        INNER JOIN students AS student ON student.id = annual.student_id
        LEFT JOIN subjects AS linked_subject ON linked_subject.id = item.subject_id
        LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
          AND enrollment.annual_term_number = item.target_term_number
        LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
        LEFT JOIN finance_retake_item_decisions AS decision ON decision.item_key_id = item_key.id AND decision.superseded_at IS NULL
        WHERE item_key.id = @itemKeyId AND referral.is_current = 1 AND referral.status = 'finalized'${lock ? ' FOR UPDATE' : ''}`);
    const item = result.recordset?.[0];
    if (!item) throw new RetakeReferralError('This finalized retake item is not available to Finance.', 404);
    return item;
  }

  async function listFinanceQueue(actorInput) {
    const pool = await getPool();
    await actor(pool, actorInput, ['finance', 'database_admin'], 'Your Finance access is no longer active. Sign in again.');
    const result = await pool.request().query(`SELECT item_key.id AS item_key_id, item.id AS item_id, referral.id AS referral_id,
        referral.revision_no, annual.id AS annual_enrollment_id, annual.student_id, annual.school_year,
        annual.grade_level, annual.intake_kind, annual.intake_status, student.student_no,
        CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) AS student_name,
        item.subject_name, item.subject_id, linked_subject.subject_code AS linked_subject_code,
        linked_subject.subject_name AS linked_subject_name, item.target_term_number, item.finance_explanation,
        enrollment.id AS enrollment_id, enrollment.enrollment_status, assessment.id AS assessment_id,
        decision.decision AS finance_decision, decision.charge_id, CAST(decision.approved_amount AS CHAR(40)) AS approved_amount,
        decision.charge_description, decision.decision_reason
      FROM registrar_retake_item_keys AS item_key
      INNER JOIN registrar_retake_referral_items AS item ON item.item_key_id = item_key.id
      INNER JOIN registrar_retake_referrals AS referral ON referral.id = item.referral_id
      INNER JOIN annual_enrollments AS annual ON annual.id = referral.annual_enrollment_id
      INNER JOIN students AS student ON student.id = annual.student_id
      LEFT JOIN subjects AS linked_subject ON linked_subject.id = item.subject_id
      LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id AND enrollment.annual_term_number = item.target_term_number
      LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
      LEFT JOIN finance_retake_item_decisions AS decision ON decision.item_key_id = item_key.id AND decision.superseded_at IS NULL
      WHERE referral.status = 'finalized' AND referral.is_current = 1
      ORDER BY decision.id IS NOT NULL, annual.school_year DESC, student.last_name, student.first_name, item.target_term_number, item.id`);
    return result.recordset || [];
  }

  async function getFinanceItem(actorInput, itemKeyInput) {
    const itemKeyId = validId(itemKeyInput, 'retake item', true);
    const pool = await getPool();
    await actor(pool, actorInput, ['finance', 'database_admin'], 'Your Finance access is no longer active. Sign in again.');
    const item = await readFinanceItem({ request: () => pool.request() }, itemKeyId, false);
    return item;
  }

  async function calculateExemptionPreview(tx, item, grossAmount, chargeDescription) {
    const grossCents = parseMoneyCents(grossAmount);
    const rulesResult = await tx.request().input('annualId', sql.Int, item.annual_enrollment_id)
      .input('termNumber', sql.TinyInt, item.target_term_number)
      .input('lineName', sql.NVarChar(120), chargeDescription)
      .query(`SELECT rule.id, rule.is_full_coverage, CAST(rule.approved_amount AS CHAR(40)) AS approved_amount,
          CAST(COALESCE(applications.applied_total, 0) AS CHAR(40)) AS applied_total
        FROM finance_exemption_cases AS exemption
        INNER JOIN finance_exemption_rules AS rule ON rule.exemption_case_id = exemption.id
        LEFT JOIN (SELECT exemption_rule_id, SUM(amount) AS applied_total
          FROM finance_exemption_applications GROUP BY exemption_rule_id) AS applications
          ON applications.exemption_rule_id = rule.id
        WHERE exemption.annual_enrollment_id = @annualId AND exemption.status = 'approved'
          AND rule.term_number = @termNumber AND (rule.fee_category IS NULL OR rule.fee_category = 'retake')
          AND (rule.line_name IS NULL OR rule.line_name = @lineName)
        ORDER BY rule.id FOR UPDATE`);
    let remaining = grossCents;
    let waived = 0n;
    for (const rule of rulesResult.recordset || []) {
      if (remaining <= 0n) break;
      const cap = Number(rule.is_full_coverage) === 1 || rule.is_full_coverage === true
        ? remaining
        : parseMoneyCents(String(rule.approved_amount), { allowZero: true })
          - parseMoneyCents(String(rule.applied_total), { allowZero: true });
      if (cap <= 0n) continue;
      const amount = cap < remaining ? cap : remaining;
      waived += amount;
      remaining -= amount;
    }
    return { grossAmount: formatMoneyCents(grossCents), approvedExemption: formatMoneyCents(waived), payableAmount: formatMoneyCents(remaining) };
  }

  async function previewDecision(tx, itemKeyInput, rawInput = {}) {
    const decision = rawInput.decision;
    if (!['charge', 'no_charge'].includes(decision)) throw new RetakeReferralError('Choose whether to add a charge or record no charge.');
    const reason = safeTextArea(rawInput.reason, 'Finance decision reason', 1000);
    const item = await readFinanceItem(tx, itemKeyInput, true);
    if (item.decision_id) throw new RetakeReferralError('Finance already recorded a decision for this retake item.', 409);
    const annual = {
      id: Number(item.current_annual_enrollment_id),
      annual_enrollment_id: Number(item.annual_enrollment_id),
      student_id: Number(item.student_id), school_year: item.school_year, grade_level: item.grade_level,
      intake_kind: item.intake_kind, intake_status: item.intake_status, entry_term_number: item.entry_term_number,
      readmission_evaluation_id: item.annual_evaluation_id, readmission_evaluation_version: item.annual_evaluation_version,
      lrn: item.lrn
    };
    if (!ALLOWED_INTAKE_KINDS.has(annual.intake_kind)
      || !['pending', 'enrolled'].includes(annual.intake_status)) {
      throw new RetakeReferralError('This annual enrollment is no longer eligible for a retake Finance decision.', 409);
    }
    if (item.student_status === 'archived') throw new RetakeReferralError('Archived student records cannot receive new finance decisions.', 409);
    await validateReadmissionBinding(tx, annual, item.readmission_evaluation_id, item.readmission_evaluation_version);
    const target = await validateTargetTerm(tx, annual, item.target_term_number, { requireAssessment: true });
    if (!item.assessment_id || Number(item.assessment_id) !== Number(target.assessment_id)
      || Number(item.enrollment_id) !== Number(target.id)) throw new RetakeReferralError('The annual assessment or target enrollment changed. Reload this item before Finance review.', 409);
    if (decision === 'no_charge') return { item, decision, reason, charge: null };
    let amount;
    try { amount = formatMoneyCents(parseMoneyCents(String(rawInput.amount || ''))); }
    catch (error) {
      if (!(error instanceof FinanceServiceError)) throw error;
      throw new RetakeReferralError('Enter a positive Finance-approved amount with up to 10 whole digits and 2 decimal places.', error.status);
    }
    const chargeDescription = safeText(rawInput.chargeDescription, 'Charge description', 120);
    const charge = await calculateExemptionPreview(tx, item, amount, chargeDescription);
    return { item, decision, reason, chargeDescription, charge };
  }

  async function financeDecisionInTransaction(actorInput, itemKeyInput, input = {}) {
    return transact(async (tx) => {
      const actorRow = await actor({ request: () => tx.request() }, actorInput, ['finance', 'database_admin'], 'Your Finance access is no longer active. Sign in again.');
      const review = await previewDecision(tx, itemKeyInput, input);
      const item = review.item;
      const idempotencyKey = validToken(input.idempotencyKey || crypto.randomUUID(), 'Finance decision');
      let chargeId = null;
      let approvedAmount = null;
      let chargeDescription = null;
      if (review.decision === 'charge') {
        const annualFinance = annualFinanceService || require('./annualFinanceService').createAnnualFinanceService({
          getPool: async () => ({ request: () => tx.request() }), sql, transaction: tx
        });
        const saved = await annualFinance.addSupplementaryCharge(actorRow.id, Number(item.student_id), Number(item.enrollment_id), {
          feeCategory: 'retake', lineName: review.chargeDescription, installment: 'As incurred',
          amount: review.charge.grossAmount, reason: review.reason, idempotencyKey
        });
        chargeId = Number(saved.chargeId);
        approvedAmount = review.charge.grossAmount;
        chargeDescription = review.chargeDescription;
      }
      const requestFingerprint = fingerprint({ itemKeyId: Number(item.item_key_id), decision: review.decision,
        approvedAmount, chargeDescription, reason: review.reason, idempotencyKey });
      const inserted = await tx.request().input('itemKeyId', sql.BigInt, item.item_key_id)
        .input('itemId', sql.BigInt, item.item_id).input('decision', sql.NVarChar(16), review.decision)
        .input('amount', sql.Decimal(12, 2), approvedAmount).input('description', sql.NVarChar(120), chargeDescription)
        .input('reason', sql.NVarChar(1000), review.reason).input('chargeId', sql.BigInt, chargeId)
        .input('actorId', sql.Int, actorRow.id).input('role', sql.NVarChar(20), actorRow.role)
        .input('key', sql.Char(36), idempotencyKey).input('fingerprint', sql.NVarChar(64), requestFingerprint)
        .query(`INSERT INTO finance_retake_item_decisions
          (item_key_id, referral_item_id, decision, approved_amount, charge_description,
            decision_reason, charge_id, reviewed_by, reviewed_by_role, idempotency_key, request_fingerprint)
          VALUES (@itemKeyId, @itemId, @decision, @amount, @description, @reason, @chargeId,
            @actorId, @role, @key, @fingerprint)`);
      const decisionId = dbId(inserted, 'Finance retake decision');
      await audit(tx, actorRow, 'finance.retake_item_decided', 'finance_retake_item_decision', decisionId, {
        itemKeyId: Number(item.item_key_id), referralId: Number(item.referral_id), decision: review.decision,
        chargeId, approvedAmount, chargeDescription, reason: review.reason,
        exemptionAmount: review.charge?.approvedExemption || null, payableAmount: review.charge?.payableAmount || null
      });
      return { decisionId, chargeId, studentId: Number(item.student_id), decision: review.decision };
    });
  }

  async function previewFinanceDecision(tx, itemKeyInput, input) {
    const review = await previewDecision(tx, itemKeyInput, input);
    return {
      item: review.item,
      decision: review.decision,
      reason: review.reason,
      chargeDescription: review.chargeDescription || null,
      charge: review.charge
    };
  }

  return {
    listTargets, listTargetTerms, listTargetSubjects, listReferralHistory, getReferral, createDraft, updateEvaluationReference, addItem, editItem, removeItem,
    startCorrection, finalize, listFinanceQueue, getFinanceItem, previewFinanceDecision,
    financeDecisionInTransaction, RetakeReferralError
  };
}

module.exports = { createRetakeReferralService, RetakeReferralError, validRetakeId: validId };
