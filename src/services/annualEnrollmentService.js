const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');
const { validateStudent, StudentRecordsError, normalizeRecordId, applyAddressInput } = require('./studentRecordsService');
const { ADDRESS_DEFINITIONS } = require('../utils/studentAddress');
const { allocateStudentNumber, StudentNumberAllocationError } = require('./studentNumberAllocator');
const { normalizeIntakeChecklistUpdates } = require('./physicalChecklistService');
const { createFinanceDebtRevisionService } = require('./financeDebtRevisionService');
const { runSerializableTransaction } = require('./transactionRetry');
const { REVIEWABLE_PROFILE_FIELDS, PROFILE_REVIEW_GROUPS, profileReviewFingerprint } = require('../utils/studentProfileReview');

const BCRYPT_ROUNDS = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = new Map([
  ['cancelled', 'term_cancelled']
]);

class AnnualEnrollmentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AnnualEnrollmentError';
    this.status = status;
  }
}

function printable(value, label, maxLength, { required = false } = {}) {
  if (typeof value !== 'string') throw new AnnualEnrollmentError(`${label} must be ${maxLength} printable characters or fewer.`);
  const normalized = value.trim();
  if (required && !normalized) throw new AnnualEnrollmentError(`${label} is required.`);
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AnnualEnrollmentError(`${label} must be ${maxLength} printable characters or fewer.`);
  }
  return normalized || null;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email && email.length <= 255 && !/[\u0000-\u001f\u007f]/.test(email) && EMAIL_PATTERN.test(email) ? email : null;
}

function normalizeId(value, label) {
  const id = normalizeRecordId(value, label);
  if (!id) throw new AnnualEnrollmentError(`Choose a valid ${label}.`);
  return id;
}

function normalizeUuid(value, label = 'submission') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AnnualEnrollmentError(`The ${label} token is invalid. Reload the form and try again.`);
  }
  return value;
}

function normalizeDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AnnualEnrollmentError(`${label} must be a valid calendar date.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AnnualEnrollmentError(`${label} must be a valid calendar date.`);
  }
  return value;
}

const ANNUAL_ADMIN_STATUS_FIELDS = {
  eformStatus: new Set(['not_recorded', 'pending', 'submitted', 'complete', 'not_applicable']),
  lisStatus: new Set(['not_recorded', 'pending', 'submitted', 'complete', 'not_applicable']),
  vmsStatus: new Set(['not_recorded', 'pending', 'submitted', 'complete', 'not_applicable']),
  acquaintanceWaiverStatus: new Set(['not_recorded', 'complete', 'not_applicable']),
  educationalTourStatus: new Set(['not_recorded', 'participating', 'not_participating'])
};

const ANNUAL_ADMIN_REVISION_FIELDS = [
  ['esc_id', 'escId', 'text', 80], ['eform_status', 'eformStatus', 'text', 20], ['eform_remarks', 'eformRemarks', 'text', 500],
  ['lis_status', 'lisStatus', 'text', 20], ['lis_remarks', 'lisRemarks', 'text', 500],
  ['vms_status', 'vmsStatus', 'text', 20], ['vms_remarks', 'vmsRemarks', 'text', 500],
  ['acquaintance_waiver_status', 'acquaintanceWaiverStatus', 'text', 20],
  ['acquaintance_party', 'acquaintanceParty', 'text', 120], ['educational_tour_status', 'educationalTourStatus', 'text', 24],
  ['internal_agreement_remarks', 'internalAgreementRemarks', 'text', 1000],
  ['modules_claimed_date', 'modulesClaimedDate', 'date'], ['student_id_claimed_date', 'studentIdClaimedDate', 'date'],
  ['uniform_claimed_date', 'uniformClaimedDate', 'date'], ['pe_uniform_claimed_date', 'peUniformClaimedDate', 'date']
];

function normalizeAnnualAdministrationDetails(input = {}) {
  const normalized = {};
  for (const [key, choices] of Object.entries(ANNUAL_ADMIN_STATUS_FIELDS)) {
    if (!choices.has(input[key])) throw new AnnualEnrollmentError(`Choose a valid ${key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}.`);
    normalized[key] = input[key];
  }
  for (const [key, maxLength] of [
    ['escId', 80], ['eformRemarks', 500], ['lisRemarks', 500], ['vmsRemarks', 500],
    ['acquaintanceParty', 120], ['internalAgreementRemarks', 1000]
  ]) normalized[key] = printable(input[key] ?? '', key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`), maxLength);
  for (const [key, label] of [
    ['modulesClaimedDate', 'Modules claimed date'], ['studentIdClaimedDate', 'Student ID claimed date'],
    ['uniformClaimedDate', 'Uniform claimed date'], ['peUniformClaimedDate', 'PE uniform claimed date']
  ]) {
    normalized[key] = input[key] === '' || input[key] == null ? null : normalizeDate(input[key], label);
  }
  return normalized;
}

function profileFieldValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function normalizeAnnualInput(input = {}, { preEnrollmentSource = false } = {}) {
  const studentNo = printable(input.studentNo || '', 'Student number', 50);
  const isReturning = Boolean(studentNo);
  const email = isReturning ? null : normalizeEmail(input.email);
  if (!isReturning && !email && !preEnrollmentSource) throw new AnnualEnrollmentError('Enter a valid contact email address.');
  const schoolYear = printable(input.schoolYear || '', 'School year', 20, { required: true });
  const gradeLevel = printable(input.gradeLevel || '', 'Grade level', 50, { required: true });
  if (!['Grade 11', 'Grade 12'].includes(gradeLevel)) throw new AnnualEnrollmentError('Choose Grade 11 or Grade 12.');
  const voucherCode = input.voucherCode;
  if (!['PUB', 'ESC', 'NV'].includes(voucherCode)) throw new AnnualEnrollmentError('Choose a voucher type: PUB, ESC, or NV.');
  const entryTermNumber = Number(input.entryTermNumber);
  if (!Number.isInteger(entryTermNumber) || entryTermNumber < 1 || entryTermNumber > 3) {
    throw new AnnualEnrollmentError('Choose the entry term from the configured school-year term order.');
  }
  const sectionIds = [1, 2, 3].map((termNumber) => {
    const raw = input[`section${termNumber}Id`];
    return raw === '' || raw == null ? null : normalizeId(raw, `term ${termNumber} section`);
  });
  const sectionMode = input.sectionMode == null || input.sectionMode === ''
    ? 'per_term'
    : input.sectionMode;
  if (!['same', 'per_term'].includes(sectionMode)) throw new AnnualEnrollmentError('Choose how term sections should be assigned.');
  const annualSectionId = input.annualSectionId == null || input.annualSectionId === ''
    ? null : normalizeId(input.annualSectionId, 'annual section');
  if (sectionMode === 'same' && annualSectionId) {
    const explicitEntrySection = sectionIds[entryTermNumber - 1];
    if (explicitEntrySection && explicitEntrySection !== annualSectionId) {
      throw new AnnualEnrollmentError('The annual section and entry-term section do not match. Choose one section.');
    }
    sectionIds[entryTermNumber - 1] = annualSectionId;
  }
  const sectionOverrides = [1, 2, 3].map((termNumber) => {
    const raw = input[`section${termNumber}Override`];
    if (raw == null || raw === '') return false;
    if (raw !== '1') throw new AnnualEnrollmentError(`Term ${termNumber} section choice is invalid.`);
    return true;
  });
  if (sectionIds.some((sectionId, index) => index + 1 < entryTermNumber && sectionId !== null)) {
    throw new AnnualEnrollmentError('A term before the learner’s entry term cannot have a section assignment.');
  }
  if (!sectionIds[entryTermNumber - 1]) throw new AnnualEnrollmentError('Choose a section for the entry term before saving intake.');
  const enrollmentStartDate = normalizeDate(input.enrollmentStartDate || '', 'Enrollment start date');
  const intakeKind = input.intakeKind === 'transferee' ? 'transferee' : isReturning ? 'returning' : 'new';
  // Keep the legacy null key position for new fingerprints; existing category fingerprints use the locked stored value on replay.
  return { isReturning, intakeKind, studentNo, email, schoolYear, gradeLevel, voucherCode, voucherCategory: null,
    entryTermNumber, enrollmentStartDate, sectionIds, sectionMode, annualSectionId, sectionOverrides,
    idempotencyKey: normalizeUuid(input.idempotencyKey) };
}

function applySameSectionDefaults({ entryTermNumber, sectionIds, sectionOverrides = [], candidatesByTerm = {} }) {
  const resolved = [...sectionIds];
  for (let termNumber = entryTermNumber + 1; termNumber <= 3; termNumber += 1) {
    if (resolved[termNumber - 1] || sectionOverrides[termNumber - 1]) continue;
    const candidates = candidatesByTerm[termNumber] || [];
    if (candidates.length === 1) resolved[termNumber - 1] = candidates[0].id;
  }
  return resolved;
}

function createAnnualEnrollmentService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  hashPassword = bcrypt.hash,
  createPassword = () => crypto.randomBytes(18).toString('hex'),
  physicalChecklistService = null,
  annualFinanceService = null
} = {}) {
  const debtRevisions = createFinanceDebtRevisionService({ getPool, sql, transactionFactory });

  async function runTransaction(callback) {
    try {
      return await runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new AnnualEnrollmentError('This student already has an annual enrollment for the selected school year.', 409);
      }
      throw error;
    }
  }

  async function requireRegistrar(request, actorInput) {
    const actorId = normalizeId(actorInput, 'user');
    const result = await request.input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role = 'registrar' FOR UPDATE`);
    const actor = result.recordset?.[0];
    if (!actor) throw new AnnualEnrollmentError('Your registrar access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function writeAudit(transaction, actor, action, entityId, details) {
    await transaction.request()
      .input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), `registrar.${action}`)
      .input('entityType', sql.NVarChar(100), 'annual_enrollment')
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  async function loadIntakeOptions(actorInput) {
    const pool = await getPool();
    await requireRegistrar(pool.request(), actorInput);
    const termsResult = await pool.request().query(`
      SELECT id, school_year, term, is_current FROM academic_terms
      ORDER BY school_year DESC, term`);
    const sectionsResult = await pool.request().query(`
      SELECT section.id, section.name, section.grade_level, section.academic_term_id,
        section.cluster, section.strand, section.adviser, section.modality, section.modular_subtype,
        term.school_year, term.term, term_order.term_number
      FROM sections AS section
      INNER JOIN academic_terms AS term ON term.id = section.academic_term_id
      LEFT JOIN school_year_term_order AS term_order ON term_order.academic_term_id = term.id
      ORDER BY term.school_year DESC, term_order.term_number, section.grade_level, section.name`);
    const schoolYearsResult = await pool.request().query(`
      SELECT school_year FROM school_year_term_order GROUP BY school_year HAVING COUNT(*) = 3 ORDER BY school_year DESC`);
    const termOrderResult = await pool.request().query(`
      SELECT school_year, term_number, academic_term_id FROM school_year_term_order ORDER BY school_year DESC, term_number`);
    return { terms: termsResult.recordset || [], sections: sectionsResult.recordset || [],
      schoolYears: schoolYearsResult.recordset || [], termOrder: termOrderResult.recordset || [] };
  }

  async function listTermOrderOptions(actorInput) {
    const pool = await getPool();
    const actorId = normalizeId(actorInput, 'user');
    const actorResult = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT role FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin')`);
    if (!actorResult.recordset?.length) throw new AnnualEnrollmentError('Your academic setup access is no longer active. Sign in again.', 403);
    const termsResult = await pool.request().query(`
      SELECT id, school_year, term, is_current FROM academic_terms ORDER BY school_year DESC, term`);
    const mappingsResult = await pool.request().query(`
      SELECT school_year, term_number, academic_term_id FROM school_year_term_order ORDER BY school_year DESC, term_number`);
    const reviewsResult = await pool.request().query(`
      SELECT school_year, academic_term_id, review_reason FROM school_year_term_order_reviews WHERE resolved_at IS NULL`);
    return { terms: termsResult.recordset || [], mappings: mappingsResult.recordset || [], reviews: reviewsResult.recordset || [] };
  }

  async function configureSchoolYearTermOrder(actorInput, input = {}) {
    const schoolYear = printable(input.schoolYear || '', 'School year', 20, { required: true });
    const termIds = [1, 2, 3].map((termNumber) => normalizeId(input[`term${termNumber}Id`], `Term ${termNumber} academic term`));
    if (new Set(termIds).size !== 3) throw new AnnualEnrollmentError('Choose three different academic terms.');
    return runTransaction(async (transaction) => {
      const actorId = normalizeId(actorInput, 'user');
      const actorResult = await transaction.request().input('actorId', sql.Int, actorId)
        .query(`SELECT id, role FROM users
          WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin') FOR UPDATE`);
      const actor = actorResult.recordset?.[0];
      if (!actor) throw new AnnualEnrollmentError('Your academic setup access is no longer active. Sign in again.', 403);
      const termResult = await transaction.request()
        .input('term1Id', sql.Int, termIds[0]).input('term2Id', sql.Int, termIds[1]).input('term3Id', sql.Int, termIds[2])
        .input('schoolYear', sql.NVarChar(20), schoolYear)
        .query(`SELECT id FROM academic_terms
          WHERE id IN (@term1Id, @term2Id, @term3Id) AND school_year = @schoolYear FOR UPDATE`);
      if (termResult.recordset?.length !== 3) throw new AnnualEnrollmentError('All three academic terms must belong to the selected school year.', 409);
      const existing = await transaction.request().input('schoolYear', sql.NVarChar(20), schoolYear)
        .query(`SELECT term_number, academic_term_id FROM school_year_term_order
          WHERE school_year = @schoolYear ORDER BY term_number FOR UPDATE`);
      const existingMap = new Map((existing.recordset || []).map((row) => [Number(row.term_number), Number(row.academic_term_id)]));
      const changing = termIds.some((termId, index) => existingMap.has(index + 1) && existingMap.get(index + 1) !== termId);
      if (changing) {
        const assessed = await transaction.request().input('schoolYear', sql.NVarChar(20), schoolYear)
          .query(`SELECT assessment.id FROM annual_assessments AS assessment
            INNER JOIN annual_enrollments AS annual ON annual.id = assessment.annual_enrollment_id
            WHERE annual.school_year = @schoolYear AND annual.intake_status <> 'legacy' LIMIT 1 FOR UPDATE`);
        const assigned = await transaction.request().input('schoolYear', sql.NVarChar(20), schoolYear)
          .query(`SELECT enrollment.id FROM enrollments AS enrollment
            INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
            INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
            WHERE term.school_year = @schoolYear AND annual.intake_status <> 'legacy' LIMIT 1 FOR UPDATE`);
        if (assessed.recordset?.length || assigned.recordset?.length) {
          throw new AnnualEnrollmentError('Term order cannot be changed after annual placements or assessments use this school year.', 409);
        }
      }
      for (let index = 0; index < termIds.length; index += 1) {
        const legacyAssignment = await transaction.request().input('termId', sql.Int, termIds[index])
          .input('termNumber', sql.TinyInt, index + 1)
          .query(`SELECT enrollment.annual_term_number FROM enrollments AS enrollment
            WHERE enrollment.academic_term_id = @termId AND enrollment.annual_term_number IS NOT NULL
              AND enrollment.annual_term_number <> @termNumber LIMIT 1 FOR UPDATE`);
        if (legacyAssignment.recordset?.length) {
          throw new AnnualEnrollmentError('This academic term has an existing annual-term association that conflicts with the selected order. Resolve its flagged review without changing posted history.', 409);
        }
      }
      await transaction.request().input('schoolYear', sql.NVarChar(20), schoolYear)
        .query('DELETE FROM school_year_term_order WHERE school_year = @schoolYear');
      for (let index = 0; index < termIds.length; index += 1) {
        await transaction.request().input('schoolYear', sql.NVarChar(20), schoolYear)
          .input('termNumber', sql.TinyInt, index + 1).input('termId', sql.Int, termIds[index]).input('actorId', sql.Int, actor.id)
          .query(`INSERT INTO school_year_term_order (school_year, term_number, academic_term_id, configured_by)
            VALUES (@schoolYear, @termNumber, @termId, @actorId)`);
      }
      for (const termId of termIds) {
        await transaction.request().input('termId', sql.Int, termId).input('actorId', sql.Int, actor.id)
          .query(`UPDATE school_year_term_order_reviews SET resolved_by = @actorId, resolved_at = UTC_TIMESTAMP(6)
            WHERE academic_term_id = @termId AND resolved_at IS NULL`);
      }
      await writeAudit(transaction, actor, 'school_year_term_order_configured', schoolYear, { schoolYear, termIds });
      return { schoolYear, termIds };
    });
  }

  async function getAnnualManagementRecord(actorInput, annualEnrollmentInput) {
    const annualEnrollmentId = normalizeId(annualEnrollmentInput, 'annual enrollment');
    const pool = await getPool();
    const actorId = normalizeId(actorInput, 'user');
    const actorResult = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT role FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin')`);
    if (!actorResult.recordset?.length) throw new AnnualEnrollmentError('Your registrar access is no longer active. Sign in again.', 403);
    const parentResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.school_year, annual.grade_level,
          annual.voucher_code, annual.voucher_category, annual.intake_status, annual.intake_kind,
          annual.entry_term_number, annual.enrollment_start_date, student.student_no, student.lrn, student.sex,
          annual.esc_id, annual.eform_status, annual.eform_remarks, annual.lis_status, annual.lis_remarks,
          annual.vms_status, annual.vms_remarks, annual.acquaintance_waiver_status, annual.acquaintance_party,
          annual.educational_tour_status, annual.internal_agreement_remarks, annual.modules_claimed_date,
          annual.student_id_claimed_date, annual.uniform_claimed_date, annual.pe_uniform_claimed_date,
          student.first_name, student.middle_name, student.last_name, student.suffix, student.birth_date,
          student.sex, student.address, student.phone, student.status AS student_status,
          student_account.email AS student_email,
          confirmation.id AS registrar_confirmation_id, confirmation.confirmed_at AS registrar_confirmed_at,
          confirmation.assessment_id AS registrar_assessment_id,
          confirmation.schedule_id AS registrar_schedule_id,
          confirmation.schedule_version AS registrar_schedule_version,
          confirmation.voucher_code_snapshot AS registrar_voucher_code_snapshot,
          confirmation.payable_total AS registrar_payable_total
        FROM annual_enrollments AS annual INNER JOIN students AS student ON student.id = annual.student_id
        LEFT JOIN users AS student_account ON student_account.id = student.user_id
        LEFT JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = annual.id
        WHERE annual.id = @annualEnrollmentId`);
    const parent = parentResult.recordset?.[0];
    if (!parent) throw new AnnualEnrollmentError('Annual enrollment not found.', 404);
    const termsResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT enrollment.id AS enrollment_id, enrollment.annual_term_number, enrollment.enrollment_status,
          enrollment.term_scope_status, enrollment.section_id, enrollment.enrolled_at, enrollment.finalized_at,
          term.id AS academic_term_id, term.term, section.name AS section_name, section.cluster, section.strand,
          section.adviser, section.modality, section.modular_subtype
        FROM enrollments AS enrollment INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        WHERE enrollment.annual_enrollment_id = @annualEnrollmentId ORDER BY enrollment.annual_term_number`);
    const tagsResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT tag.id, tag.tag_type, tag.label, tag.note, tag.effective_term_from, tag.effective_term_to,
          tag.created_at, staff.first_name AS actor_first_name, staff.last_name AS actor_last_name
        FROM annual_enrollment_tags AS tag INNER JOIN users AS account ON account.id = tag.recorded_by
        LEFT JOIN staff_profiles AS staff ON staff.user_id = account.id
        WHERE tag.annual_enrollment_id = @annualEnrollmentId ORDER BY tag.created_at, tag.id`);
    const subjectsResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT assignment.id AS student_subject_id, enrollment.id AS enrollment_id, enrollment.annual_term_number,
          term.term, subject.id AS subject_id, subject.subject_code, subject.subject_name,
          special.id AS special_subject_id, special.arrangement_type, special.modular_subtype, special.prepaid_arrangement_note,
          CASE WHEN charge.id IS NULL THEN 0 ELSE 1 END AS has_billable_charge
        FROM enrollments AS enrollment
        INNER JOIN student_subjects AS assignment ON assignment.enrollment_id = enrollment.id
        INNER JOIN subjects AS subject ON subject.id = assignment.subject_id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN annual_special_subjects AS special ON special.student_subject_id = assignment.id
        LEFT JOIN assessed_charges AS charge ON charge.special_subject_id = special.id
        WHERE enrollment.annual_enrollment_id = @annualEnrollmentId AND enrollment.term_scope_status = 'applicable'
        ORDER BY enrollment.annual_term_number, subject.subject_code`);
    const administrationHistoryResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT revision.revision_group, revision.field_name, revision.before_value, revision.after_value,
          revision.created_at, revision.actor_id, staff.first_name AS actor_first_name, staff.last_name AS actor_last_name
        FROM annual_enrollment_admin_revisions AS revision
        LEFT JOIN staff_profiles AS staff ON staff.user_id = revision.actor_id
        WHERE revision.annual_enrollment_id = @annualEnrollmentId ORDER BY revision.created_at DESC, revision.id DESC`);
    return { parent, terms: termsResult.recordset || [], tags: tagsResult.recordset || [],
      subjects: subjectsResult.recordset || [], administrationHistory: administrationHistoryResult.recordset || [] };
  }

  async function updateAnnualAdministrationDetails(actorInput, annualEnrollmentInput, input = {}) {
    const annualEnrollmentId = normalizeId(annualEnrollmentInput, 'annual enrollment');
    const normalized = normalizeAnnualAdministrationDetails(input);
    return runTransaction(async (transaction) => {
      const actorId = normalizeId(actorInput, 'user');
      const actorResult = await transaction.request().input('actorId', sql.Int, actorId)
        .query(`SELECT id, role FROM users
          WHERE id = @actorId AND is_active = 1 AND role = 'registrar' FOR UPDATE`);
      const actor = actorResult.recordset?.[0];
      if (!actor) throw new AnnualEnrollmentError('Your registrar access is no longer active. Sign in again.', 403);
      const currentResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query(`SELECT annual.id, annual.intake_status, annual.updated_at, student.status AS student_status,
            annual.esc_id, annual.eform_status, annual.eform_remarks, annual.lis_status, annual.lis_remarks,
            annual.vms_status, annual.vms_remarks, annual.acquaintance_waiver_status, annual.acquaintance_party,
            annual.educational_tour_status, annual.internal_agreement_remarks, annual.modules_claimed_date,
            annual.student_id_claimed_date, annual.uniform_claimed_date, annual.pe_uniform_claimed_date
          FROM annual_enrollments AS annual
          INNER JOIN students AS student ON student.id = annual.student_id
          WHERE annual.id = @annualEnrollmentId FOR UPDATE`);
      const current = currentResult.recordset?.[0];
      if (!current || current.intake_status === 'legacy') throw new AnnualEnrollmentError('Annual enrollment not found or is read-only.', 404);
      if (current.student_status === 'archived') throw new AnnualEnrollmentError('Archived student history is read-only.', 409);
      const changed = ANNUAL_ADMIN_REVISION_FIELDS.filter(([column, inputName]) =>
        profileFieldValue(current[column]) !== profileFieldValue(normalized[inputName]));
      if (!changed.length) return { annualEnrollmentId, changedFields: [], unchanged: true };
      const request = transaction.request();
      for (const [, inputName, type, maxLength] of ANNUAL_ADMIN_REVISION_FIELDS) {
        request.input(inputName, type === 'date' ? sql.Date : sql.NVarChar(maxLength), normalized[inputName]);
      }
      await request.input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query(`UPDATE annual_enrollments SET esc_id = @escId, eform_status = @eformStatus, eform_remarks = @eformRemarks,
          lis_status = @lisStatus, lis_remarks = @lisRemarks, vms_status = @vmsStatus, vms_remarks = @vmsRemarks,
          acquaintance_waiver_status = @acquaintanceWaiverStatus, acquaintance_party = @acquaintanceParty,
          educational_tour_status = @educationalTourStatus, internal_agreement_remarks = @internalAgreementRemarks,
          modules_claimed_date = @modulesClaimedDate, student_id_claimed_date = @studentIdClaimedDate,
          uniform_claimed_date = @uniformClaimedDate, pe_uniform_claimed_date = @peUniformClaimedDate,
          updated_at = UTC_TIMESTAMP(6) WHERE id = @annualEnrollmentId`);
      const revisionGroup = crypto.randomUUID();
      for (const [fieldName, inputName] of changed) {
        await transaction.request()
          .input('revisionGroup', sql.UniqueIdentifier, revisionGroup)
          .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
          .input('actorId', sql.Int, actor.id)
          .input('fieldName', sql.NVarChar(50), fieldName)
          .input('beforeValue', sql.NVarChar(sql.MAX), profileFieldValue(current[fieldName]))
          .input('afterValue', sql.NVarChar(sql.MAX), profileFieldValue(normalized[inputName]))
          .query(`INSERT INTO annual_enrollment_admin_revisions
            (revision_group, annual_enrollment_id, actor_id, field_name, before_value, after_value)
            VALUES (@revisionGroup, @annualEnrollmentId, @actorId, @fieldName, @beforeValue, @afterValue)`);
      }
      await transaction.request()
        .input('actorId', sql.Int, actor.id)
        .input('action', sql.NVarChar(100), `${actor.role}.annual_administration_updated`)
        .input('entityId', sql.NVarChar(100), String(annualEnrollmentId))
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify({ annualEnrollmentId, changedFields: changed.map(([field]) => field) }))
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@actorId, @action, 'annual_enrollment', @entityId, @details)`);
      return { annualEnrollmentId, changedFields: changed.map(([field]) => field), unchanged: false };
    });
  }

  async function recordAnnualTag(actorInput, annualEnrollmentInput, input = {}) {
    const annualEnrollmentId = normalizeId(annualEnrollmentInput, 'annual enrollment');
    const tagType = input.tagType;
    if (!['internal', 'athlete', 'performer', 'named_arrangement'].includes(tagType)) throw new AnnualEnrollmentError('Choose a supported enrollment tag.');
    const label = printable(input.label || '', 'Tag name', 120, { required: true });
    const note = printable(input.note || '', 'Staff note', 500);
    const effectiveTermFrom = input.effectiveTermFrom ? Number(input.effectiveTermFrom) : null;
    const effectiveTermTo = input.effectiveTermTo ? Number(input.effectiveTermTo) : null;
    if ((effectiveTermFrom === null) !== (effectiveTermTo === null)
      || effectiveTermFrom !== null && (!Number.isInteger(effectiveTermFrom) || !Number.isInteger(effectiveTermTo)
        || effectiveTermFrom < 1 || effectiveTermTo > 3 || effectiveTermFrom > effectiveTermTo)) {
      throw new AnnualEnrollmentError('Choose an effective term range from Term 1 through Term 3, or leave both blank for the full year.');
    }
    const idempotencyKey = normalizeUuid(input.idempotencyKey, 'tag submission');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ annualEnrollmentId, tagType, label, note, effectiveTermFrom, effectiveTermTo })).digest('hex');
    return runTransaction(async (transaction) => {
      const actor = await requireRegistrar(transaction.request(), actorInput);
      const parentResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query(`SELECT annual.id, annual.intake_status, annual.entry_term_number, student.status AS student_status
          FROM annual_enrollments AS annual
          INNER JOIN students AS student ON student.id = annual.student_id
          WHERE annual.id = @annualEnrollmentId FOR UPDATE`);
      const parent = parentResult.recordset?.[0];
      if (!parent || parent.intake_status === 'legacy') throw new AnnualEnrollmentError('Annual enrollment not found or is read-only.', 404);
      if (parent.student_status === 'archived') throw new AnnualEnrollmentError('Archived student history is read-only.', 409);
      if (effectiveTermFrom !== null && Number(effectiveTermFrom) < Number(parent.entry_term_number || 1)) {
        throw new AnnualEnrollmentError('Enrollment tags cannot be scoped to terms before the student’s entry term.');
      }
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query('SELECT id, request_fingerprint FROM annual_enrollment_tags WHERE idempotency_key = @idempotencyKey FOR UPDATE');
      if (prior.recordset?.[0]) {
        if (prior.recordset[0].request_fingerprint !== fingerprint) throw new AnnualEnrollmentError('This tag token was already used for different details.', 409);
        return { tagId: prior.recordset[0].id, alreadyRecorded: true };
      }
      const inserted = await transaction.request()
        .input('annualEnrollmentId', sql.Int, annualEnrollmentId).input('tagType', sql.NVarChar(30), tagType)
        .input('label', sql.NVarChar(120), label).input('note', sql.NVarChar(500), note)
        .input('termFrom', sql.TinyInt, effectiveTermFrom).input('termTo', sql.TinyInt, effectiveTermTo)
        .input('actorId', sql.Int, actor.id).input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('fingerprint', sql.Char(64), fingerprint)
        .query(`INSERT INTO annual_enrollment_tags
            (annual_enrollment_id, tag_type, label, note, effective_term_from, effective_term_to, recorded_by, idempotency_key, request_fingerprint)
          VALUES (@annualEnrollmentId, @tagType, @label, @note, @termFrom, @termTo, @actorId, @idempotencyKey, @fingerprint)`);
      const tagId = inserted.insertId;
      if (!Number.isSafeInteger(tagId) || tagId < 1) throw new Error('Annual enrollment tag insert returned no identifier.');
      await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId).input('actorId', sql.Int, actor.id)
        .input('reason', sql.NVarChar(1000), note || label).query(`INSERT INTO annual_workflow_events (annual_enrollment_id, actor_id, event_type, reason)
          VALUES (@annualEnrollmentId, @actorId, 'enrollment_tag_recorded', @reason)`);
      await writeAudit(transaction, actor, 'annual_enrollment_tag_recorded', tagId, { annualEnrollmentId, tagType, label, effectiveTermFrom, effectiveTermTo });
      return { tagId };
    });
  }

  async function addSpecialSubject(actorInput, annualEnrollmentInput, input = {}) {
    const annualEnrollmentId = normalizeId(annualEnrollmentInput, 'annual enrollment');
    const studentSubjectId = normalizeId(input.studentSubjectId, 'student subject assignment');
    const arrangementType = input.arrangementType;
    if (!['internal', 'athlete', 'performer', 'modular', 'other'].includes(arrangementType)) throw new AnnualEnrollmentError('Choose a supported special-subject arrangement.');
    const modularSubtype = printable(input.modularSubtype || '', 'Modular subtype', 80);
    const prepaidNote = printable(input.prepaidArrangementNote || '', 'Prepaid arrangement note', 500);
    if (arrangementType === 'modular' && !modularSubtype) throw new AnnualEnrollmentError('Enter the modular subtype.');
    const idempotencyKey = normalizeUuid(input.idempotencyKey, 'special-subject submission');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ annualEnrollmentId, studentSubjectId, arrangementType, modularSubtype, prepaidNote })).digest('hex');
    return runTransaction(async (transaction) => {
      const actor = await requireRegistrar(transaction.request(), actorInput);
      const assignmentResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('studentSubjectId', sql.Int, studentSubjectId)
        .query(`SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.intake_status,
            student.status AS student_status, enrollment.id AS enrollment_id, enrollment.term_scope_status,
            enrollment.enrollment_status, subject.id AS subject_id
          FROM student_subjects AS assignment
          INNER JOIN enrollments AS enrollment ON enrollment.id = assignment.enrollment_id
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          INNER JOIN students AS student ON student.id = annual.student_id
          INNER JOIN subjects AS subject ON subject.id = assignment.subject_id
          WHERE assignment.id = @studentSubjectId AND annual.id = @annualEnrollmentId FOR UPDATE`);
      const assignment = assignmentResult.recordset?.[0];
      if (!assignment || assignment.intake_status === 'legacy') throw new AnnualEnrollmentError('Choose an assigned subject for this annual enrollment.', 409);
      if (assignment.student_status === 'archived') throw new AnnualEnrollmentError('Archived student history is read-only.', 409);
      if (assignment.term_scope_status !== 'applicable' || !['pending_payment', 'enrolled'].includes(assignment.enrollment_status)) {
        throw new AnnualEnrollmentError('Only an applicable student subject can be marked as a special-subject arrangement.', 409);
      }
      const priorToken = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query('SELECT id, request_fingerprint FROM annual_special_subjects WHERE idempotency_key = @idempotencyKey FOR UPDATE');
      if (priorToken.recordset?.[0]) {
        if (priorToken.recordset[0].request_fingerprint !== fingerprint) throw new AnnualEnrollmentError('This special-subject token was already used for different details.', 409);
        return { specialSubjectId: priorToken.recordset[0].id, alreadyRecorded: true };
      }
      const existing = await transaction.request().input('studentSubjectId', sql.Int, studentSubjectId)
        .query('SELECT id FROM annual_special_subjects WHERE student_subject_id = @studentSubjectId FOR UPDATE');
      if (existing.recordset?.length) throw new AnnualEnrollmentError('This subject already has a special-subject record.', 409);
      const inserted = await transaction.request()
        .input('annualEnrollmentId', sql.Int, annualEnrollmentId).input('enrollmentId', sql.Int, assignment.enrollment_id)
        .input('studentId', sql.Int, assignment.student_id).input('studentSubjectId', sql.Int, studentSubjectId)
        .input('arrangementType', sql.NVarChar(30), arrangementType).input('modularSubtype', sql.NVarChar(80), modularSubtype)
        .input('prepaidNote', sql.NVarChar(500), prepaidNote).input('actorId', sql.Int, actor.id)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey).input('fingerprint', sql.Char(64), fingerprint)
        .query(`INSERT INTO annual_special_subjects
            (annual_enrollment_id, enrollment_id, student_id, student_subject_id, arrangement_type,
              modular_subtype, prepaid_arrangement_note, recorded_by, idempotency_key, request_fingerprint)
          VALUES (@annualEnrollmentId, @enrollmentId, @studentId, @studentSubjectId, @arrangementType,
            @modularSubtype, @prepaidNote, @actorId, @idempotencyKey, @fingerprint)`);
      const specialSubjectId = inserted.insertId;
      if (!Number.isSafeInteger(specialSubjectId) || specialSubjectId < 1) throw new Error('Special-subject insert returned no identifier.');
      await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('enrollmentId', sql.Int, assignment.enrollment_id).input('actorId', sql.Int, actor.id)
        .input('reason', sql.NVarChar(1000), arrangementType)
        .query(`INSERT INTO annual_workflow_events (annual_enrollment_id, enrollment_id, actor_id, event_type, reason)
          VALUES (@annualEnrollmentId, @enrollmentId, @actorId, 'special_subject_recorded', @reason)`);
      await writeAudit(transaction, actor, 'special_subject_recorded', specialSubjectId, {
        annualEnrollmentId, enrollmentId: assignment.enrollment_id, studentSubjectId, arrangementType
      });
      return { specialSubjectId };
    });
  }

  async function previewDeparture(actorInput, annualEnrollmentInput, enrollmentInput) {
    const annualEnrollmentId = normalizeId(annualEnrollmentInput, 'annual enrollment');
    const enrollmentId = normalizeId(enrollmentInput, 'enrollment');
    const pool = await getPool();
    await requireRegistrar(pool.request(), actorInput);
    const result = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .input('enrollmentId', sql.Int, enrollmentId)
      .query(`SELECT annual.id AS annual_enrollment_id, annual.school_year, annual.entry_term_number,
          enrollment.id AS enrollment_id, enrollment.annual_term_number, enrollment.enrollment_status,
          enrollment.term_scope_status, term.term, section.name AS section_name,
          CASE WHEN EXISTS (SELECT 1 FROM student_subjects AS assignment WHERE assignment.enrollment_id = enrollment.id)
            THEN 1 ELSE 0 END AS academic_activity_review_required
        FROM enrollments AS enrollment
        INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        WHERE annual.id = @annualEnrollmentId AND annual.id = (SELECT annual_enrollment_id FROM enrollments WHERE id = @enrollmentId)
          AND enrollment.annual_term_number >= (SELECT annual_term_number FROM enrollments WHERE id = @enrollmentId)
          AND enrollment.term_scope_status = 'applicable'
        ORDER BY enrollment.annual_term_number`);
    const rows = result.recordset || [];
    if (!rows.some((row) => Number(row.enrollment_id) === enrollmentId)) throw new AnnualEnrollmentError('Choose an applicable term placement in this annual enrollment.', 404);
    if (rows.some((row) => !['pending_payment', 'enrolled'].includes(row.enrollment_status))) {
      throw new AnnualEnrollmentError('A term in the departure range has already changed status.', 409);
    }
    return rows;
  }

  async function createDepartureCase(actorInput, annualEnrollmentInput, enrollmentInput, input = {}) {
    const annualEnrollmentId = normalizeId(annualEnrollmentInput, 'annual enrollment');
    const enrollmentId = normalizeId(enrollmentInput, 'enrollment');
    const departureType = input.departureType;
    if (!['dropped', 'transferred'].includes(departureType)) throw new AnnualEnrollmentError('Choose dropped or transferred.');
    const effectiveDate = normalizeDate(input.effectiveDate || '', 'Effective date');
    const reason = printable(input.reason || '', 'Departure reason', 1000, { required: true });
    const idempotencyKey = normalizeUuid(input.idempotencyKey, 'departure submission');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ annualEnrollmentId, enrollmentId, departureType, effectiveDate, reason })).digest('hex');
    return runTransaction(async (transaction) => {
      const actor = await requireRegistrar(transaction.request(), actorInput);
      const existingToken = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query('SELECT id, effective_enrollment_id, request_fingerprint FROM finance_departure_cases WHERE idempotency_key = @idempotencyKey FOR UPDATE');
      if (existingToken.recordset?.[0]) {
        const prior = existingToken.recordset[0];
        if (Number(prior.effective_enrollment_id) !== enrollmentId || prior.request_fingerprint !== fingerprint) {
          throw new AnnualEnrollmentError('This departure token was already used for different details.', 409);
        }
        return { departureCaseId: prior.id, alreadyRecorded: true };
      }
      const sourceResult = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
        .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query(`SELECT enrollment.id, enrollment.annual_enrollment_id, enrollment.annual_term_number,
            enrollment.term_scope_status, enrollment.enrollment_status, annual.intake_status,
            annual.enrollment_start_date, student.status AS student_status
          FROM enrollments AS enrollment
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          INNER JOIN students AS student ON student.id = enrollment.student_id
          WHERE enrollment.id = @enrollmentId AND annual.id = @annualEnrollmentId FOR UPDATE`);
      const source = sourceResult.recordset?.[0];
      if (!source || source.intake_status === 'legacy' || source.term_scope_status !== 'applicable') {
        throw new AnnualEnrollmentError('Choose an applicable placement from a current annual enrollment.', 409);
      }
      if (source.student_status === 'archived') throw new AnnualEnrollmentError('Archived student history is read-only.', 409);
      if (!['pending_payment', 'enrolled'].includes(source.enrollment_status)) throw new AnnualEnrollmentError('This placement has already changed status.', 409);
      const enrollmentStartDate = source.enrollment_start_date instanceof Date
        ? source.enrollment_start_date.toISOString().slice(0, 10)
        : source.enrollment_start_date ? String(source.enrollment_start_date).slice(0, 10) : null;
      if (enrollmentStartDate && effectiveDate < enrollmentStartDate) {
        throw new AnnualEnrollmentError('The departure date cannot precede the enrollment start date.', 409);
      }
      const priorCase = await transaction.request().input('annualEnrollmentId', sql.Int, source.annual_enrollment_id)
        .query('SELECT id FROM finance_departure_cases WHERE annual_enrollment_id = @annualEnrollmentId FOR UPDATE');
      if (priorCase.recordset?.length) throw new AnnualEnrollmentError('A departure case already exists for this annual enrollment.', 409);
      const termsResult = await transaction.request().input('annualEnrollmentId', sql.Int, source.annual_enrollment_id)
        .input('termNumber', sql.TinyInt, source.annual_term_number)
        .query(`SELECT enrollment.id, enrollment.enrollment_status,
            CASE WHEN EXISTS (SELECT 1 FROM student_subjects AS assignment
              WHERE assignment.enrollment_id = enrollment.id FOR UPDATE) THEN 1 ELSE 0 END AS has_academic_activity
          FROM enrollments AS enrollment
          WHERE enrollment.annual_enrollment_id = @annualEnrollmentId AND enrollment.term_scope_status = 'applicable'
            AND enrollment.annual_term_number >= @termNumber
          ORDER BY enrollment.annual_term_number FOR UPDATE`);
      const affected = termsResult.recordset || [];
      if (affected.some((row) => !['pending_payment', 'enrolled'].includes(row.enrollment_status))) {
        throw new AnnualEnrollmentError('A later applicable term already changed status. Review its history before recording a departure.', 409);
      }
      if (!affected.some((row) => Number(row.id) === enrollmentId)) throw new AnnualEnrollmentError('No applicable departure placements remain.', 409);
      const inserted = await transaction.request()
        .input('annualEnrollmentId', sql.Int, source.annual_enrollment_id).input('effectiveEnrollmentId', sql.Int, enrollmentId)
        .input('effectiveDate', sql.Date, effectiveDate).input('departureType', sql.NVarChar(20), departureType)
        .input('reason', sql.NVarChar(1000), reason).input('actorId', sql.Int, actor.id)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey).input('fingerprint', sql.Char(64), fingerprint)
        .query(`INSERT INTO finance_departure_cases
            (annual_enrollment_id, effective_enrollment_id, effective_date, departure_type, reason, recorded_by, idempotency_key, request_fingerprint)
          VALUES (@annualEnrollmentId, @effectiveEnrollmentId, @effectiveDate, @departureType, @reason, @actorId, @idempotencyKey, @fingerprint)`);
      const departureCaseId = inserted.insertId;
      if (!Number.isSafeInteger(departureCaseId) || departureCaseId < 1) throw new Error('Departure case insert returned no identifier.');
      for (const affectedTerm of affected) {
        await transaction.request().input('departureCaseId', sql.BigInt, departureCaseId)
          .input('enrollmentId', sql.Int, affectedTerm.id)
          .input('activityReview', sql.Bit, affectedTerm.has_academic_activity)
          .query(`INSERT INTO finance_departure_case_terms (departure_case_id, enrollment_id, academic_activity_review_required)
            VALUES (@departureCaseId, @enrollmentId, @activityReview)`);
        const changed = await transaction.request().input('enrollmentId', sql.Int, affectedTerm.id)
          .input('status', sql.NVarChar(30), departureType)
          .query(`UPDATE enrollments SET enrollment_status = @status
            WHERE id = @enrollmentId AND enrollment_status IN ('pending_payment', 'enrolled')`);
        if (changed.rowsAffected?.[0] !== 1) throw new AnnualEnrollmentError('A placement changed while departure was being recorded.', 409);
        await transaction.request().input('annualEnrollmentId', sql.Int, source.annual_enrollment_id)
          .input('enrollmentId', sql.Int, affectedTerm.id).input('actorId', sql.Int, actor.id)
          .input('reason', sql.NVarChar(1000), reason)
          .query(`INSERT INTO annual_workflow_events (annual_enrollment_id, enrollment_id, actor_id, event_type, reason)
            VALUES (@annualEnrollmentId, @enrollmentId, @actorId, 'departure_recorded', @reason)`);
      }
      await writeAudit(transaction, actor, 'annual_departure_recorded', departureCaseId, {
        annualEnrollmentId: source.annual_enrollment_id, effectiveEnrollmentId: enrollmentId,
        effectiveDate, departureType, affectedEnrollmentIds: affected.map((row) => row.id),
        academicActivityReviewEnrollmentIds: affected.filter((row) => row.has_academic_activity).map((row) => row.id)
      });
      return { departureCaseId, affectedEnrollmentIds: affected.map((row) => row.id) };
    });
  }

  async function createAnnualIntake(actorInput, input = {}) {
    const sourceId = input.preEnrollmentId ? normalizeUuid(input.preEnrollmentId, 'pre-enrollment record') : null;
    if (!sourceId) throw new AnnualEnrollmentError('Start every new annual intake from a Ready for registrar front-desk record.', 409);
    const sourceVersion = sourceId ? Number(input.preEnrollmentVersion) : null;
    if (sourceId && (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1)) {
      throw new AnnualEnrollmentError('Reload the pre-enrollment record before starting annual enrollment.', 409);
    }
    if (sourceId && normalizeUuid(input.idempotencyKey) !== sourceId) {
      throw new AnnualEnrollmentError('The enrollment submission token does not match this pre-enrollment record. Reload the form.', 409);
    }
    const entry = normalizeAnnualInput({ ...input, idempotencyKey: sourceId }, { preEnrollmentSource: true });
    const checklistUpdates = normalizeIntakeChecklistUpdates(input);
    if (checklistUpdates.length && typeof physicalChecklistService?.recordIntakeUpdatesInTransaction !== 'function') {
      throw new AnnualEnrollmentError('The paper checklist service is unavailable. Reload and try again.', 503);
    }
    const approvedProfileFields = (() => {
      const raw = input.approvedProfileFields == null ? [] : Array.isArray(input.approvedProfileFields)
        ? input.approvedProfileFields : [input.approvedProfileFields];
      if (raw.length > PROFILE_REVIEW_GROUPS.length) throw new AnnualEnrollmentError('Too many profile changes were selected.');
      const allowed = new Set(PROFILE_REVIEW_GROUPS.map(({ key }) => key));
      if (raw.some((field) => typeof field !== 'string' || !allowed.has(field)) || new Set(raw).size !== raw.length) {
        throw new AnnualEnrollmentError('Choose only the profile fields shown for approval.');
      }
      return [...raw].sort();
    })();
    const studentReviewSnapshot = input.studentReviewFingerprint || null;
    const checklistFingerprint = checklistUpdates.map(({ idempotencyKey, ...update }) => update);
    const fingerprintForEntry = (fingerprintEntry) => crypto.createHash('sha256')
      .update(JSON.stringify({ entry: fingerprintEntry, profileInput: null, checklistUpdates: checklistFingerprint })).digest('hex');
    const sourceEntryFingerprint = { ...entry, intakeKind: null, email: null, voucherCategory: null };
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ entry: sourceEntryFingerprint, checklistUpdates: checklistFingerprint,
      preEnrollmentId: sourceId, preEnrollmentVersion: sourceVersion, approvedProfileFields, studentReviewSnapshot })).digest('hex');
    const placeholderHash = entry.isReturning ? null : await hashPassword(createPassword(), BCRYPT_ROUNDS);
    return runTransaction(async (transaction) => {
      const actor = await requireRegistrar(transaction.request(), actorInput);

      const priorResult = await transaction.request()
        .input('idempotencyKey', sql.UniqueIdentifier, entry.idempotencyKey)
        .query(`SELECT id AS annual_enrollment_id, student_id, request_fingerprint, voucher_category, pre_enrollment_id FROM annual_enrollments
          WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
      if (priorResult.recordset?.[0]) {
        const prior = priorResult.recordset[0];
        if (sourceId) {
          if (String(prior.pre_enrollment_id || '').toLowerCase() !== sourceId || prior.request_fingerprint !== fingerprint) {
            throw new AnnualEnrollmentError('This pre-enrollment submission token was already used for different details.', 409);
          }
          return { annualEnrollmentId: prior.annual_enrollment_id,
            studentId: prior.student_id, alreadyCreated: true };
        }
        if (prior.pre_enrollment_id) {
          throw new AnnualEnrollmentError('This submission token belongs to a pre-enrollment conversion. Reload the registrar workspace.', 409);
        }
        const legacyFingerprint = fingerprintForEntry({ ...entry, voucherCategory: prior.voucher_category ?? null });
        if (prior.request_fingerprint !== fingerprint && prior.request_fingerprint !== legacyFingerprint) {
          throw new AnnualEnrollmentError('This submission token was already used for different annual enrollment details.', 409);
        }
        return { annualEnrollmentId: prior.annual_enrollment_id,
          studentId: prior.student_id, alreadyCreated: true };
      }

      let preEnrollment = null;
      if (sourceId) {
        const sourceResult = await transaction.request().input('preEnrollmentId', sql.Char(36), sourceId)
          .query(`SELECT source.* FROM pre_enrollments AS source WHERE source.id = @preEnrollmentId FOR UPDATE`);
        preEnrollment = sourceResult.recordset?.[0] || null;
        if (!preEnrollment) throw new AnnualEnrollmentError('The pre-enrollment record no longer exists.', 404);
        if (preEnrollment.created_by_role !== 'front_desk') throw new AnnualEnrollmentError('This paper record lacks recorded front-desk provenance and cannot start a new annual enrollment.', 409);
        if (preEnrollment.status !== 'ready_for_registrar' || Number(preEnrollment.version) !== sourceVersion) {
          throw new AnnualEnrollmentError('This pre-enrollment record changed after the enrollment form was opened. Reload and review it.', 409);
        }
        if (preEnrollment.school_year !== entry.schoolYear || preEnrollment.target_grade_level !== entry.gradeLevel) {
          throw new AnnualEnrollmentError('School year and grade must match the ready pre-enrollment record. Correct that record before starting enrollment.', 409);
        }
        if (!/^\d{12}$/.test(String(preEnrollment.lrn || ''))) {
          throw new AnnualEnrollmentError('The student LRN must match the ready pre-enrollment record. Correct that record before starting enrollment.', 409);
        }
        if (typeof input.lrn === 'string' && input.lrn.trim() && input.lrn.trim() !== preEnrollment.lrn) {
          throw new AnnualEnrollmentError('The submitted LRN does not match the saved front-desk record. Correct that record before starting enrollment.', 409);
        }
        if (!normalizeEmail(preEnrollment.email)) throw new AnnualEnrollmentError('A valid email must be saved to the front-desk record before enrollment can start.', 409);
        if (preEnrollment.applicant_kind === 'readmission') {
          const evaluation = await transaction.request().input('evaluationId', sql.Char(36), preEnrollment.readmission_evaluation_id)
            .query(`SELECT id, applicant_lrn, student_id, school_year, target_grade_level, status, version, curriculum_review_status
              FROM readmission_evaluations WHERE id = @evaluationId FOR UPDATE`);
          const bound = evaluation.recordset?.[0];
          if (!bound || bound.status !== 'accepted' || bound.curriculum_review_status !== 'resolved'
            || Number(bound.version) !== Number(preEnrollment.readmission_evaluation_version)
            || bound.applicant_lrn !== preEnrollment.lrn || bound.school_year !== preEnrollment.school_year
            || bound.target_grade_level !== preEnrollment.target_grade_level) {
            throw new AnnualEnrollmentError('The linked balik-aral evaluation is no longer accepted for this LRN, school year, grade, and revision.', 409);
          }
          preEnrollment.readmission = bound;
        } else if (preEnrollment.readmission_evaluation_id || preEnrollment.readmission_evaluation_version) {
          throw new AnnualEnrollmentError('Only a balik-aral source can carry a readmission evaluation.', 409);
        }
        entry.email = normalizeEmail(preEnrollment.email);
        if (!entry.email) throw new AnnualEnrollmentError('A valid email must be saved to the front-desk record before enrollment can start.', 409);
      }
      let profileInput = null;
      if (preEnrollment) {
        try {
          profileInput = validateStudent({
            studentNo: '', lrn: preEnrollment.lrn, firstName: preEnrollment.first_name,
            middleName: preEnrollment.middle_name, lastName: preEnrollment.last_name, suffix: preEnrollment.suffix,
            birthDate: preEnrollment.birth_date instanceof Date ? preEnrollment.birth_date.toISOString().slice(0, 10) : preEnrollment.birth_date,
            sex: preEnrollment.sex, address: preEnrollment.address, phone: preEnrollment.profile_phone,
            birthplace: preEnrollment.birthplace, facebookName: preEnrollment.facebook_name,
            emergencyContactPerson: preEnrollment.emergency_contact_person,
            emergencyContactRelationship: preEnrollment.emergency_contact_relationship,
            emergencyContactPhone: preEnrollment.emergency_contact_phone,
            emergencyContactAddress: preEnrollment.emergency_contact_address,
            motherName: preEnrollment.mother_name, motherPhone: preEnrollment.mother_phone,
            fatherName: preEnrollment.father_name, fatherPhone: preEnrollment.father_phone
          }, { requireStudentNo: false });
          for (const [, inputName, dbColumn] of [
            ['address', 'addressBlockLotStreetPurok', 'address_block_lot_street_purok'],
            ['address', 'addressBarangay', 'address_barangay'], ['address', 'addressCity', 'address_city'],
            ['address', 'addressProvince', 'address_province'], ['address', 'addressZip', 'address_zip'],
            ['emergencyContactAddress', 'emergencyContactAddressBlockLotStreetPurok', 'emergency_contact_address_block_lot_street_purok'],
            ['emergencyContactAddress', 'emergencyContactAddressBarangay', 'emergency_contact_address_barangay'],
            ['emergencyContactAddress', 'emergencyContactAddressCity', 'emergency_contact_address_city'],
            ['emergencyContactAddress', 'emergencyContactAddressProvince', 'emergency_contact_address_province'],
            ['emergencyContactAddress', 'emergencyContactAddressZip', 'emergency_contact_address_zip']
          ]) profileInput[inputName] = preEnrollment[dbColumn] || null;
          profileInput.email = entry.email;
        } catch (error) {
          if (error instanceof StudentRecordsError) throw new AnnualEnrollmentError(error.message, error.status);
          throw error;
        }
      }

      const termOrderResult = await transaction.request().input('schoolYear', sql.NVarChar(20), entry.schoolYear)
        .query(`SELECT configured.term_number, configured.academic_term_id, term.term
          FROM school_year_term_order AS configured
          INNER JOIN academic_terms AS term ON term.id = configured.academic_term_id
          WHERE configured.school_year = @schoolYear ORDER BY configured.term_number FOR UPDATE`);
      const termOrder = termOrderResult.recordset || [];
      if (termOrder.length !== 3 || termOrder.some((term, index) => Number(term.term_number) !== index + 1)) {
        throw new AnnualEnrollmentError('Configure an explicit Term 1, Term 2, and Term 3 order for this school year before intake.', 409);
      }
      const selectedSectionsResult = await transaction.request()
        .input('section1Id', sql.Int, entry.sectionIds[0])
        .input('section2Id', sql.Int, entry.sectionIds[1])
        .input('section3Id', sql.Int, entry.sectionIds[2])
        .input('schoolYear', sql.NVarChar(20), entry.schoolYear)
        .input('gradeLevel', sql.NVarChar(50), entry.gradeLevel)
        .input('entryTermNumber', sql.TinyInt, entry.entryTermNumber)
        .query(`SELECT section.id, section.grade_level, term.id AS academic_term_id,
            section.name, section.cluster, section.strand, term.school_year, term.term, configured.term_number
          FROM sections AS section
          INNER JOIN academic_terms AS term ON term.id = section.academic_term_id
          INNER JOIN school_year_term_order AS configured
            ON configured.academic_term_id = term.id AND configured.school_year = @schoolYear
          WHERE (section.id IN (@section1Id, @section2Id, @section3Id)
              AND term.school_year = @schoolYear)
            OR (term.school_year = @schoolYear AND section.grade_level = @gradeLevel
              AND configured.term_number >= @entryTermNumber) FOR UPDATE`);
      const sections = selectedSectionsResult.recordset || [];
      const selectedIds = entry.sectionIds.filter(Boolean);
      const selectedSections = new Map();
      for (const selectedId of selectedIds) {
        const matches = sections.filter((row) => Number(row.id) === selectedId);
        if (matches.length !== 1) throw new AnnualEnrollmentError('One or more selected sections are no longer available or mapped to this school year.', 409);
        selectedSections.set(selectedId, matches[0]);
      }
      for (let index = 0; index < entry.sectionIds.length; index += 1) {
        const sectionId = entry.sectionIds[index];
        if (index + 1 < entry.entryTermNumber && sectionId) {
          throw new AnnualEnrollmentError(`Term ${index + 1} is before the learner’s entry term and cannot have a section assignment.`, 409);
        }
        if (!sectionId) continue;
        const section = selectedSections.get(sectionId);
        if (!section || section.school_year !== entry.schoolYear || section.grade_level !== entry.gradeLevel
          || Number(section.term_number) !== index + 1 || Number(section.academic_term_id) !== Number(termOrder[index].academic_term_id)) {
          throw new AnnualEnrollmentError(`Choose a ${entry.gradeLevel} section mapped to Term ${index + 1} of ${entry.schoolYear}.`, 409);
        }
      }
      let resolvedSectionIds = [...entry.sectionIds];
      if (entry.sectionMode === 'same') {
        const entrySection = selectedSections.get(entry.sectionIds[entry.entryTermNumber - 1]);
        if (!entrySection) throw new AnnualEnrollmentError('Choose a section for the entry term before saving intake.');
        const candidatesByTerm = {};
        for (let termNumber = entry.entryTermNumber + 1; termNumber <= 3; termNumber += 1) {
          if (entry.sectionIds[termNumber - 1] || entry.sectionOverrides[termNumber - 1]) continue;
          const candidates = await transaction.request()
            .input('schoolYear', sql.NVarChar(20), entry.schoolYear)
            .input('gradeLevel', sql.NVarChar(50), entry.gradeLevel)
            .input('termNumber', sql.TinyInt, termNumber)
            .input('sectionName', sql.NVarChar(100), entrySection.name)
            .input('cluster', sql.NVarChar(80), entrySection.cluster)
            .input('strand', sql.NVarChar(80), entrySection.strand)
            .query(`SELECT section.id
              FROM sections AS section
              INNER JOIN academic_terms AS term ON term.id = section.academic_term_id
              INNER JOIN school_year_term_order AS configured
                ON configured.academic_term_id = term.id AND configured.school_year = @schoolYear
              WHERE term.school_year = @schoolYear AND section.grade_level = @gradeLevel
                AND configured.term_number = @termNumber AND section.name = @sectionName
                AND ((section.cluster = @cluster) OR (section.cluster IS NULL AND @cluster IS NULL))
                AND ((section.strand = @strand) OR (section.strand IS NULL AND @strand IS NULL)) FOR UPDATE`);
          candidatesByTerm[termNumber] = candidates.recordset || [];
        }
        resolvedSectionIds = applySameSectionDefaults({
          entryTermNumber: entry.entryTermNumber, sectionIds: entry.sectionIds,
          sectionOverrides: entry.sectionOverrides, candidatesByTerm
        });
      }

      let student;
      let actualIntakeKind;
      let activateOnFirstTerm = false;
      let activationSourceAnnualId = null;
      if (entry.isReturning) {
        const studentResult = await transaction.request()
          .input('studentNo', sql.NVarChar(50), entry.studentNo)
          .query(`SELECT student.*,
              account.role AS linked_account_role, account.email, account.is_active
            FROM students AS student
            LEFT JOIN users AS account ON account.id = student.user_id
            WHERE student.student_no = @studentNo FOR UPDATE`);
        student = studentResult.recordset?.[0];
        if (!student) throw new AnnualEnrollmentError('No student record matches that student number.', 404);
        if (student.status === 'archived') throw new AnnualEnrollmentError('Archived student records cannot be enrolled.', 409);
        if (preEnrollment && student.lrn !== preEnrollment.lrn) {
          throw new AnnualEnrollmentError('Choose the existing student whose LRN matches the ready pre-enrollment record.', 409);
        }
        if (student.user_id && student.linked_account_role !== 'student') throw new AnnualEnrollmentError('The linked account is not a student login.', 409);
        if (student.user_id && !(student.is_active === true || student.is_active === 1)) {
          const authorization = await transaction.request().input('studentId', sql.Int, student.id)
            .query(`SELECT annual.id
              FROM annual_enrollments AS annual
              WHERE annual.student_id = @studentId AND annual.account_activation_pending = 1
              ORDER BY annual.created_at DESC, annual.id DESC LIMIT 1 FOR UPDATE`);
          if (authorization.recordset?.[0]) {
            activateOnFirstTerm = true;
            activationSourceAnnualId = Number(authorization.recordset[0].id);
          }
        }
      } else {
        let studentNo;
        try { studentNo = await allocateStudentNumber(transaction, sql, entry.schoolYear); }
        catch (error) {
          if (error instanceof StudentNumberAllocationError) throw new AnnualEnrollmentError(error.message, error.status);
          throw error;
        }
        const studentNoConflict = await transaction.request().input('studentNo', sql.NVarChar(50), studentNo)
          .query('SELECT id FROM students WHERE student_no = @studentNo LIMIT 1 FOR UPDATE');
        if (studentNoConflict.recordset?.length) throw new AnnualEnrollmentError('Automatic student number allocation conflicted with an existing record. Retry the intake.', 409);
        const lrnConflict = await transaction.request().input('lrn', sql.NVarChar(12), profileInput.lrn)
          .query('SELECT id FROM students WHERE lrn = @lrn LIMIT 1 FOR UPDATE');
        if (lrnConflict.recordset?.length) throw new AnnualEnrollmentError('That LRN is already in use.', 409);
        const emailConflict = await transaction.request().input('email', sql.NVarChar(255), entry.email)
          .query('SELECT id FROM users WHERE LOWER(email) = @email LIMIT 1 FOR UPDATE');
        const pendingEmailConflict = await transaction.request().input('email', sql.NVarChar(255), entry.email)
          .query(`SELECT id FROM pending_email_changes
            WHERE LOWER(new_email) = @email AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6)
            LIMIT 1 FOR UPDATE`);
        if (emailConflict.recordset?.length || pendingEmailConflict.recordset?.length) {
          throw new AnnualEnrollmentError('That email address is already in use or reserved.', 409);
        }

        const userResult = await transaction.request()
          .input('email', sql.NVarChar(255), entry.email)
          .input('passwordHash', sql.NVarChar(255), placeholderHash)
          .query(`INSERT INTO users (email, password_hash, role, is_active, must_change_password)
            VALUES (@email, @passwordHash, 'student', 0, 1)`);
        const userId = userResult.insertId;
        if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Student login insert returned no identifier.');
        const profile = profileInput;
        const studentResult = await transaction.request()
          .input('userId', sql.Int, userId)
          .input('studentNo', sql.NVarChar(50), studentNo)
          .input('lrn', sql.NVarChar(12), profile.lrn)
          .input('firstName', sql.NVarChar(100), profile.firstName)
          .input('middleName', sql.NVarChar(100), profile.middleName)
          .input('lastName', sql.NVarChar(100), profile.lastName)
          .input('suffix', sql.NVarChar(20), profile.suffix)
          .input('birthDate', sql.Date, profile.birthDate)
          .input('sex', sql.NVarChar(20), profile.sex)
          .input('address', sql.NVarChar(500), profile.address)
          .input('addressBlockLotStreetPurok', sql.NVarChar(200), profile.addressBlockLotStreetPurok)
          .input('addressBarangay', sql.NVarChar(100), profile.addressBarangay)
          .input('addressCity', sql.NVarChar(100), profile.addressCity)
          .input('addressProvince', sql.NVarChar(100), profile.addressProvince)
          .input('addressZip', sql.Char(4), profile.addressZip)
          .input('phone', sql.NVarChar(50), profile.phone)
          .input('birthplace', sql.NVarChar(160), profile.birthplace)
          .input('facebookName', sql.NVarChar(120), profile.facebookName)
          .input('emergencyContactPerson', sql.NVarChar(160), profile.emergencyContactPerson)
          .input('emergencyContactRelationship', sql.NVarChar(80), profile.emergencyContactRelationship)
          .input('emergencyContactPhone', sql.NVarChar(50), profile.emergencyContactPhone)
          .input('emergencyContactAddress', sql.NVarChar(500), profile.emergencyContactAddress)
          .input('emergencyContactAddressBlockLotStreetPurok', sql.NVarChar(200), profile.emergencyContactAddressBlockLotStreetPurok)
          .input('emergencyContactAddressBarangay', sql.NVarChar(100), profile.emergencyContactAddressBarangay)
          .input('emergencyContactAddressCity', sql.NVarChar(100), profile.emergencyContactAddressCity)
          .input('emergencyContactAddressProvince', sql.NVarChar(100), profile.emergencyContactAddressProvince)
          .input('emergencyContactAddressZip', sql.Char(4), profile.emergencyContactAddressZip)
          .input('motherName', sql.NVarChar(160), profile.motherName)
          .input('motherPhone', sql.NVarChar(50), profile.motherPhone)
          .input('fatherName', sql.NVarChar(160), profile.fatherName)
          .input('fatherPhone', sql.NVarChar(50), profile.fatherPhone)
          .query(`INSERT INTO students
              (user_id, student_no, lrn, first_name, middle_name, last_name, suffix, birth_date, sex, address,
                address_block_lot_street_purok, address_barangay, address_city, address_province, address_zip, phone,
                birthplace, facebook_name,
                emergency_contact_person, emergency_contact_relationship, emergency_contact_phone, emergency_contact_address,
                emergency_contact_address_block_lot_street_purok, emergency_contact_address_barangay,
                emergency_contact_address_city, emergency_contact_address_province, emergency_contact_address_zip,
                mother_name, mother_phone, father_name, father_phone)
            VALUES (@userId, @studentNo, @lrn, @firstName, @middleName, @lastName, @suffix, @birthDate, @sex, @address,
              @addressBlockLotStreetPurok, @addressBarangay, @addressCity, @addressProvince, @addressZip, @phone, @birthplace, @facebookName,
              @emergencyContactPerson, @emergencyContactRelationship, @emergencyContactPhone, @emergencyContactAddress,
              @emergencyContactAddressBlockLotStreetPurok, @emergencyContactAddressBarangay,
              @emergencyContactAddressCity, @emergencyContactAddressProvince, @emergencyContactAddressZip,
              @motherName, @motherPhone, @fatherName, @fatherPhone)`);
        const studentId = studentResult.insertId;
        if (!Number.isSafeInteger(studentId) || studentId < 1) throw new Error('Student profile insert returned no identifier.');
        student = { id: studentId, user_id: userId, status: 'active', student_no: studentNo, email: entry.email };
        activateOnFirstTerm = true;
      }

      if (!entry.isReturning) {
        if (preEnrollment.applicant_kind === 'continuing') {
          throw new AnnualEnrollmentError('A continuing classification requires an explicit existing student selection.', 409);
        }
        if (preEnrollment.applicant_kind === 'readmission') {
          if (Number(preEnrollment.readmission?.student_id || 0) > 0) {
            throw new AnnualEnrollmentError('This accepted evaluation is linked to an existing student. Select that student instead of creating a new master record.', 409);
          }
          actualIntakeKind = 'readmission';
        } else {
          actualIntakeKind = 'new';
        }
      } else {
        const targetYear = Number(String(entry.schoolYear).slice(0, 4));
        const history = await transaction.request().input('studentId', sql.Int, student.id)
          .input('schoolYear', sql.NVarChar(20), entry.schoolYear)
          .query(`SELECT annual.school_year, annual.intake_status,
              EXISTS(SELECT 1 FROM finance_departure_cases AS departure
                WHERE departure.annual_enrollment_id = annual.id) AS has_departure
            FROM annual_enrollments AS annual
            WHERE annual.student_id = @studentId AND annual.school_year < @schoolYear
            ORDER BY annual.school_year DESC, annual.id DESC FOR UPDATE`);
        const priorRows = history.recordset || [];
        const latest = priorRows[0] || null;
        const continuous = Boolean(latest && latest.school_year === `${targetYear - 1}-${targetYear}`
          && ['enrolled', 'legacy'].includes(latest.intake_status)
          && !(latest.has_departure === true || latest.has_departure === 1));
        if (continuous) {
          if (preEnrollment.applicant_kind !== 'continuing') {
            throw new AnnualEnrollmentError('Previous-year participation shows continuous progression. Correct the front-desk applicant classification before continuing.', 409);
          }
          if (preEnrollment.readmission_evaluation_id) throw new AnnualEnrollmentError('Continuous progression does not use a balik-aral evaluation.', 409);
          actualIntakeKind = 'continuing';
        } else {
          if (preEnrollment.applicant_kind !== 'readmission' || !preEnrollment.readmission) {
            throw new AnnualEnrollmentError('This existing student has no uninterrupted previous-year participation. An accepted balik-aral evaluation is required.', 409);
          }
          if (Number(preEnrollment.readmission.student_id || 0) !== Number(student.id)) {
            throw new AnnualEnrollmentError('The accepted balik-aral evaluation is not linked to the selected existing student. Reopen and re-accept the evaluation.', 409);
          }
          actualIntakeKind = 'readmission';
        }

        if (studentReviewSnapshot !== profileReviewFingerprint(student)) {
          throw new AnnualEnrollmentError('The existing student profile changed after review. Reload the registrar workspace and review the current record.', 409);
        }
        const approved = new Set(approvedProfileFields);
        const profileFieldForColumn = new Map(REVIEWABLE_PROFILE_FIELDS.map(([key, column]) => [column, key]));
        const selectedColumns = PROFILE_REVIEW_GROUPS.filter(({ key }) => approved.has(key))
          .flatMap(({ key, columns }) => columns.map((column) => [key, column]));
        const storedValue = (column) => {
          const value = student[column];
          return value instanceof Date ? value.toISOString().slice(0, 10) : value == null ? '' : String(value);
        };
        const proposedValue = (key, column) => {
          const value = key === 'email' ? entry.email : profileInput?.[profileFieldForColumn.get(column)];
          return value == null ? '' : String(value);
        };
        const actualChanges = selectedColumns.filter(([key, column]) => storedValue(column) !== proposedValue(key, column));
        if (actualChanges.some(([key]) => key === 'email') && !student.user_id) {
          throw new AnnualEnrollmentError('A contact email can be changed only for a student with a linked student login.', 409);
        }
        const profileAssignments = actualChanges.filter(([key]) => key !== 'email');
        if (profileAssignments.length) {
          const updateRequest = transaction.request().input('studentId', sql.Int, student.id);
          const setClauses = [];
          for (const [key, column] of profileAssignments) {
            const type = column === 'birth_date' ? sql.Date : column.endsWith('_zip') ? sql.Char(4) : sql.NVarChar(sql.MAX);
            const sourceField = profileFieldForColumn.get(column);
            updateRequest.input(`profile_${column}`, type, profileInput[sourceField]);
            setClauses.push(`${column} = @profile_${column}`);
          }
          await updateRequest.query(`UPDATE students SET ${setClauses.join(', ')}, updated_at = UTC_TIMESTAMP(6) WHERE id = @studentId`);
        }
        const emailChange = actualChanges.find(([key]) => key === 'email');
        if (emailChange && student.user_id) {
          const email = entry.email;
          if (!email) throw new AnnualEnrollmentError('A valid email must be saved to the front-desk record before enrollment can start.', 409);
          const accountResult = await transaction.request().input('userId', sql.Int, student.user_id)
            .query('SELECT id, role FROM users WHERE id = @userId FOR UPDATE');
          const linkedAccount = accountResult.recordset?.[0];
          if (!linkedAccount || linkedAccount.role !== 'student') throw new AnnualEnrollmentError('The linked login is not a student account.', 409);
          const emailConflict = await transaction.request().input('email', sql.NVarChar(255), email).input('userId', sql.Int, student.user_id)
            .query('SELECT id FROM users WHERE LOWER(email) = @email AND id <> @userId LIMIT 1 FOR UPDATE');
          const pendingConflict = await transaction.request().input('email', sql.NVarChar(255), email).input('userId', sql.Int, student.user_id)
            .query(`SELECT id FROM pending_email_changes WHERE LOWER(new_email) = @email AND user_id <> @userId
              AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6) LIMIT 1 FOR UPDATE`);
          if (emailConflict.recordset?.length || pendingConflict.recordset?.length) throw new AnnualEnrollmentError('That email address is already in use or reserved.', 409);
          await transaction.request().input('userId', sql.Int, student.user_id)
            .query('UPDATE pending_email_changes SET consumed_at = UTC_TIMESTAMP(6) WHERE user_id = @userId AND consumed_at IS NULL');
          await transaction.request().input('userId', sql.Int, student.user_id)
            .query('UPDATE two_factor_codes SET consumed_at = UTC_TIMESTAMP(6) WHERE user_id = @userId AND consumed_at IS NULL');
          await transaction.request().input('userId', sql.Int, student.user_id)
            .query('UPDATE password_reset_tokens SET consumed_at = UTC_TIMESTAMP(6) WHERE user_id = @userId AND consumed_at IS NULL');
          const accountUpdated = await transaction.request().input('userId', sql.Int, student.user_id)
            .input('email', sql.NVarChar(255), email)
            .query(`UPDATE users SET email = @email, auth_session_version = UUID(), updated_at = UTC_TIMESTAMP(6)
              WHERE id = @userId AND role = 'student'`);
          if (accountUpdated.rowsAffected?.[0] !== 1) throw new AnnualEnrollmentError('The student email changed while the profile was being saved. Reload and review it.', 409);
        }
        if (actualChanges.length) {
          const revisionGroup = crypto.randomUUID();
          for (const [key, column] of actualChanges) {
            const beforeValue = student[column] ?? null;
            const afterValue = key === 'email' ? entry.email : profileInput[profileFieldForColumn.get(column)] ?? null;
            if (String(beforeValue ?? '') === String(afterValue ?? '')) continue;
            await transaction.request().input('revisionGroup', sql.UniqueIdentifier, revisionGroup)
              .input('studentId', sql.Int, student.id).input('actorId', sql.Int, actor.id)
              .input('fieldName', sql.NVarChar(60), column).input('beforeValue', sql.NVarChar(sql.MAX), beforeValue === null ? null : String(beforeValue))
              .input('afterValue', sql.NVarChar(sql.MAX), afterValue === null ? null : String(afterValue))
              .query(`INSERT INTO student_profile_revisions (revision_group, student_id, actor_id, field_name, before_value, after_value)
                VALUES (@revisionGroup, @studentId, @actorId, @fieldName, @beforeValue, @afterValue)`);
          }
          await transaction.request().input('auditActorId', sql.Int, actor.id)
            .input('studentEntityId', sql.NVarChar(100), String(student.id))
            .input('auditDetails', sql.NVarChar(sql.MAX), JSON.stringify({ annualSourceId: sourceId,
              approvedFields: approvedProfileFields, changedFields: actualChanges.map(([, column]) => column) }))
            .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
              VALUES (@auditActorId, 'registrar.student_profile_reviewed', 'student', @studentEntityId, @auditDetails)`);
          if (emailChange) {
            await transaction.request().input('auditActorId', sql.Int, actor.id)
              .input('userEntityId', sql.NVarChar(100), String(student.user_id))
              .input('auditDetails', sql.NVarChar(sql.MAX), JSON.stringify({ studentId: student.id, annualSourceId: sourceId,
                authSessionsInvalidated: true, emailChangeReason: 'registrar-approved returning-student profile correction' }))
              .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
                VALUES (@auditActorId, 'registrar.student_account_email_updated', 'user', @userEntityId, @auditDetails)`);
          }
        }
      }

      const existingAnnualResult = await transaction.request()
        .input('studentId', sql.Int, student.id)
        .input('schoolYear', sql.NVarChar(20), entry.schoolYear)
        .query(`SELECT id FROM annual_enrollments
          WHERE student_id = @studentId AND school_year = @schoolYear FOR UPDATE`);
      if (existingAnnualResult.recordset?.length) {
        throw new AnnualEnrollmentError('This student already has an annual enrollment for the selected school year.', 409);
      }

      const annualResult = await transaction.request()
        .input('studentId', sql.Int, student.id)
        .input('schoolYear', sql.NVarChar(20), entry.schoolYear)
        .input('gradeLevel', sql.NVarChar(50), entry.gradeLevel)
        .input('voucherCode', sql.NVarChar(10), entry.voucherCode)
        .input('intakeKind', sql.NVarChar(20), actualIntakeKind)
        .input('entryTermNumber', sql.TinyInt, entry.entryTermNumber)
        .input('enrollmentStartDate', sql.Date, entry.enrollmentStartDate)
        .input('activationPending', sql.Bit, activateOnFirstTerm)
        .input('actorId', sql.Int, actor.id)
        .input('preEnrollmentId', sql.Char(36), sourceId)
        .input('readmissionEvaluationId', sql.Char(36), preEnrollment.readmission_evaluation_id || null)
        .input('readmissionEvaluationVersion', sql.Int, preEnrollment.readmission_evaluation_version || null)
        .input('idempotencyKey', sql.UniqueIdentifier, entry.idempotencyKey)
        .input('requestFingerprint', sql.Char(64), fingerprint)
        .query(`INSERT INTO annual_enrollments
            (student_id, school_year, grade_level, voucher_code, voucher_category, intake_kind, entry_term_number,
              enrollment_start_date, account_activation_pending, created_by, pre_enrollment_id, readmission_evaluation_id,
              readmission_evaluation_version, idempotency_key, request_fingerprint)
          VALUES (@studentId, @schoolYear, @gradeLevel, @voucherCode, NULL, @intakeKind, @entryTermNumber,
            @enrollmentStartDate, @activationPending, @actorId, @preEnrollmentId, @readmissionEvaluationId,
            @readmissionEvaluationVersion, @idempotencyKey, @requestFingerprint)`);
      const annualEnrollmentId = annualResult.insertId;
      if (!Number.isSafeInteger(annualEnrollmentId) || annualEnrollmentId < 1) throw new Error('Annual enrollment insert returned no identifier.');
      if (activationSourceAnnualId) {
        await transaction.request().input('sourceAnnualEnrollmentId', sql.Int, activationSourceAnnualId)
          .query(`UPDATE annual_enrollments SET account_activation_pending = 0, updated_at = UTC_TIMESTAMP(6)
            WHERE id = @sourceAnnualEnrollmentId AND account_activation_pending = 1`);
        await writeAudit(transaction, actor, 'account_activation_authorization_carried', annualEnrollmentId, {
          sourceAnnualEnrollmentId: activationSourceAnnualId, targetAnnualEnrollmentId: annualEnrollmentId
        });
      }

      const enrollmentIds = [];
      for (let index = 0; index < termOrder.length; index += 1) {
        const termNumber = index + 1;
        const context = termOrder[index];
        const sectionId = resolvedSectionIds[index];
        const isApplicable = termNumber >= entry.entryTermNumber;
        const enrollmentStatus = isApplicable ? 'pending_payment' : 'not_applicable';
        const enrollmentResult = await transaction.request()
          .input('studentId', sql.Int, student.id)
          .input('termId', sql.Int, context.academic_term_id)
          .input('sectionId', sql.Int, sectionId)
          .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
          .input('termNumber', sql.TinyInt, termNumber)
          .input('enrollmentStatus', sql.NVarChar(30), enrollmentStatus)
          .input('termScopeStatus', sql.NVarChar(20), isApplicable ? 'applicable' : 'not_applicable')
          .input('enrolledAt', sql.Date, entry.enrollmentStartDate)
          .query(`INSERT INTO enrollments
              (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id, annual_term_number,
                term_scope_status, enrolled_at)
            VALUES (@studentId, @termId, @sectionId, @enrollmentStatus, @annualEnrollmentId, @termNumber,
              @termScopeStatus, @enrolledAt)`);
        const enrollmentId = enrollmentResult.insertId;
        if (!Number.isSafeInteger(enrollmentId) || enrollmentId < 1) throw new Error('Term enrollment insert returned no identifier.');
        enrollmentIds.push(enrollmentId);
        if (isApplicable) {
          await transaction.request()
            .input('enrollmentId', sql.Int, enrollmentId)
            .query(`INSERT INTO term_finance_approvals (enrollment_id, status) VALUES (@enrollmentId, 'pending')`);
        }
      }
      const physicalChecklistEventIds = checklistUpdates.length
        ? await physicalChecklistService.recordIntakeUpdatesInTransaction(transaction, actor.id, student.id, entry.gradeLevel, checklistUpdates)
        : [];
      await transaction.request()
        .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO annual_enrollment_events (annual_enrollment_id, actor_id, event_type)
          VALUES (@annualEnrollmentId, @actorId, 'created')`);
      if (preEnrollment) {
        const nextSourceVersion = sourceVersion + 1;
        const sourceUpdated = await transaction.request()
          .input('preEnrollmentId', sql.Char(36), sourceId).input('expectedVersion', sql.Int, sourceVersion)
          .input('nextVersion', sql.Int, nextSourceVersion).input('actorId', sql.Int, actor.id)
          .query(`UPDATE pre_enrollments SET status = 'enrollment_started', version = @nextVersion,
              updated_by = @actorId, updated_at = UTC_TIMESTAMP(3)
            WHERE id = @preEnrollmentId AND version = @expectedVersion AND status = 'ready_for_registrar'`);
        if (sourceUpdated.rowsAffected?.[0] !== 1) {
          throw new AnnualEnrollmentError('This pre-enrollment record changed while enrollment was being saved. Retry after reloading it.', 409);
        }
        await transaction.request().input('preEnrollmentId', sql.Char(36), sourceId).input('actorId', sql.Int, actor.id)
          .input('annualEnrollmentId', sql.Int, annualEnrollmentId).input('sourceVersion', sql.Int, nextSourceVersion)
          .query(`INSERT INTO pre_enrollment_events
            (pre_enrollment_id, actor_id, event_type, version, from_status, to_status, details_json)
            VALUES (@preEnrollmentId, @actorId, 'enrollment_started', @sourceVersion,
              'ready_for_registrar', 'enrollment_started', JSON_OBJECT('annualEnrollmentId', @annualEnrollmentId))`);
      }
      const auditDetails = {
        studentId: student.id, schoolYear: entry.schoolYear, gradeLevel: entry.gradeLevel,
        intakeKind: actualIntakeKind, entryTermNumber: entry.entryTermNumber, enrollmentStartDate: entry.enrollmentStartDate,
        voucherCode: entry.voucherCode, enrollmentIds,
        physicalChecklistEventIds
      };
      if (sourceId) auditDetails.preEnrollmentId = sourceId;
      await writeAudit(transaction, actor, 'annual_enrollment_created', annualEnrollmentId, {
        ...auditDetails
      });
      return { annualEnrollmentId, enrollmentIds, studentId: student.id, studentNo: student.student_no || null,
        isNewStudent: activateOnFirstTerm, physicalChecklistEventIds };
    });
  }

  async function listAnnualEnrollmentCounts(actorInput, filters = {}) {
    const pool = await getPool();
    const actorId = normalizeId(actorInput, 'user');
    const filterSchoolYear = filters.schoolYear ? printable(filters.schoolYear, 'School year', 20) : null;
    const filterGradeLevel = filters.gradeLevel ? printable(filters.gradeLevel, 'Grade level', 50) : null;
    const filterVoucher = filters.voucherCode ? printable(filters.voucherCode, 'Voucher', 10) : null;
    const filterTermId = filters.termId ? normalizeId(filters.termId, 'academic term') : null;
    const filterSectionId = filters.sectionId ? normalizeId(filters.sectionId, 'section') : null;
    const filterCluster = filters.cluster ? printable(filters.cluster, 'Cluster', 80) : null;
    const filterStrand = filters.strand ? printable(filters.strand, 'Strand', 80) : null;
    const filterStatus = filters.status ? printable(filters.status, 'Status', 20) : null;
    const filterStudentStatus = filters.studentStatus ? printable(filters.studentStatus, 'Student status', 20) : null;
    const searchTerm = filters.search ? printable(filters.search, 'Search', 100) : null;
    if (filterVoucher && !['PUB', 'ESC', 'NV'].includes(filterVoucher)) throw new AnnualEnrollmentError('Choose PUB, ESC, or NV.');
    if (filterStatus && !['pending_payment', 'enrolled', 'cancelled', 'dropped', 'transferred'].includes(filterStatus)) {
      throw new AnnualEnrollmentError('Choose a valid term placement status.');
    }
    if (filterStudentStatus && filterStudentStatus !== 'active') throw new AnnualEnrollmentError('Choose active student records.');
    const actorResult = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT role FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin')`);
    if (!actorResult.recordset?.length) throw new AnnualEnrollmentError('Your registrar access is no longer active. Sign in again.', 403);
    const result = await pool.request()
      .input('schoolYear', sql.NVarChar(20), filterSchoolYear)
      .input('gradeLevel', sql.NVarChar(50), filterGradeLevel)
      .input('voucherCode', sql.NVarChar(10), filterVoucher)
      .input('termId', sql.Int, filterTermId)
      .input('sectionId', sql.Int, filterSectionId)
      .input('cluster', sql.NVarChar(80), filterCluster)
      .input('strand', sql.NVarChar(80), filterStrand)
      .input('status', sql.NVarChar(20), filterStatus)
      .input('studentStatus', sql.NVarChar(20), filterStudentStatus)
      .input('searchPattern', sql.NVarChar(204), searchTerm ? `%${searchTerm.replace(/[~%_[\]]/g, (character) => `~${character}`)}%` : null)
      .query(`SELECT annual.school_year, annual.grade_level, term.id AS academic_term_id, term.term,
          enrollment.annual_term_number,
          COALESCE(section.name, 'Unassigned') AS section_name,
          COALESCE(section.cluster, 'Not recorded') AS cluster,
          COALESCE(section.strand, 'Not recorded') AS strand,
          COALESCE(student.sex, 'Not recorded') AS gender,
          enrollment.enrollment_status,
          COUNT(DISTINCT annual.student_id) AS student_count
        FROM annual_enrollments AS annual
        INNER JOIN students AS student ON student.id = annual.student_id
        INNER JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        WHERE annual.intake_status <> 'legacy' AND enrollment.term_scope_status = 'applicable'
          AND (@schoolYear IS NULL OR annual.school_year = @schoolYear)
          AND (@gradeLevel IS NULL OR annual.grade_level = @gradeLevel)
          AND (@voucherCode IS NULL OR annual.voucher_code = @voucherCode)
          AND (@termId IS NULL OR term.id = @termId)
          AND (@sectionId IS NULL OR section.id = @sectionId)
          AND (@cluster IS NULL OR section.cluster = @cluster)
          AND (@strand IS NULL OR section.strand = @strand)
          AND (@status IS NULL OR enrollment.enrollment_status = @status)
          AND (@studentStatus IS NULL OR student.status = @studentStatus)
          AND (@searchPattern IS NULL OR student.student_no LIKE @searchPattern ESCAPE '~'
            OR CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) LIKE @searchPattern ESCAPE '~')
        GROUP BY annual.school_year, annual.grade_level, term.id, term.term, enrollment.annual_term_number,
          section.name, section.cluster, section.strand, student.sex, enrollment.enrollment_status
        ORDER BY annual.school_year DESC, annual.grade_level, enrollment.annual_term_number,
          section.name, section.strand, student.sex, enrollment.enrollment_status`);
    return result.recordset || [];
  }

  async function listAnnualEnrollments(actorInput, filters = {}) {
    const pool = await getPool();
    const actorId = normalizeId(actorInput, 'user');
    const filterSchoolYear = filters.schoolYear ? printable(filters.schoolYear, 'School year', 20) : null;
    const filterGradeLevel = filters.gradeLevel ? printable(filters.gradeLevel, 'Grade level', 50) : null;
    const filterVoucher = filters.voucherCode ? printable(filters.voucherCode, 'Voucher', 10) : null;
    const filterTermId = filters.termId ? normalizeId(filters.termId, 'academic term') : null;
    const filterSectionId = filters.sectionId ? normalizeId(filters.sectionId, 'section') : null;
    const filterCluster = filters.cluster ? printable(filters.cluster, 'Cluster', 80) : null;
    const filterStrand = filters.strand ? printable(filters.strand, 'Strand', 80) : null;
    const filterStatus = filters.status ? printable(filters.status, 'Status', 20) : null;
    const filterStudentStatus = filters.studentStatus ? printable(filters.studentStatus, 'Student status', 20) : null;
    const searchTerm = filters.search ? printable(filters.search, 'Search', 100) : null;
    if (filterVoucher && !['PUB', 'ESC', 'NV'].includes(filterVoucher)) throw new AnnualEnrollmentError('Choose PUB, ESC, or NV.');
    if (filterStatus && !['pending_payment', 'enrolled', 'cancelled', 'dropped', 'transferred'].includes(filterStatus)) throw new AnnualEnrollmentError('Choose a valid term placement status.');
    if (filterStudentStatus && filterStudentStatus !== 'active') throw new AnnualEnrollmentError('Choose active student records.');
    const actorResult = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT role FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin')`);
    if (!actorResult.recordset?.length) throw new AnnualEnrollmentError('Your registrar access is no longer active. Sign in again.', 403);
    const result = await pool.request()
      .input('schoolYear', sql.NVarChar(20), filterSchoolYear)
      .input('gradeLevel', sql.NVarChar(50), filterGradeLevel)
      .input('voucherCode', sql.NVarChar(10), filterVoucher)
      .input('termId', sql.Int, filterTermId)
      .input('sectionId', sql.Int, filterSectionId)
      .input('cluster', sql.NVarChar(80), filterCluster)
      .input('strand', sql.NVarChar(80), filterStrand)
      .input('status', sql.NVarChar(20), filterStatus)
      .input('studentStatus', sql.NVarChar(20), filterStudentStatus)
      .input('searchPattern', sql.NVarChar(204), searchTerm ? `%${searchTerm.replace(/[~%_[\]]/g, (character) => `~${character}`)}%` : null)
      .query(`SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.school_year,
          annual.grade_level, annual.voucher_code, annual.voucher_category, annual.intake_status,
          annual.intake_kind, annual.entry_term_number, annual.enrollment_start_date,
          student.student_no, student.lrn, student.sex, student.first_name, student.middle_name, student.last_name, student.suffix,
          enrollment.id AS enrollment_id, enrollment.annual_term_number, enrollment.enrollment_status,
          enrollment.term_scope_status, enrollment.enrolled_at, enrollment.finalized_at,
          term.term, term.id AS academic_term_id, section.id AS section_id, section.name AS section_name,
          section.cluster, section.strand, section.adviser, section.modality, section.modular_subtype,
          assessment.voucher_code_snapshot AS assessed_voucher_code, assessment.schedule_version AS assessed_schedule_version,
          confirmation.id AS registrar_confirmation_id,
          CASE WHEN voucher_event.event_type = 'voucher_review_flagged' THEN 1 ELSE 0 END AS voucher_review_required,
          voucher_event.reason AS voucher_review_reason,
          CASE WHEN clearance.event_type IS NULL THEN NULL WHEN clearance.event_type = 'signed' THEN 'signed' ELSE 'not signed' END AS signed_clearance_status
        FROM annual_enrollments AS annual
        INNER JOIN students AS student ON student.id = annual.student_id
        LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
        LEFT JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
        LEFT JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = annual.id
        LEFT JOIN (
          SELECT latest.annual_enrollment_id, latest.event_type, latest.reason
          FROM (
            SELECT annual_event.annual_enrollment_id, annual_event.event_type, annual_event.reason,
              ROW_NUMBER() OVER (PARTITION BY annual_event.annual_enrollment_id
                ORDER BY annual_event.created_at DESC, annual_event.id DESC) AS event_rank
            FROM annual_enrollment_events AS annual_event
            WHERE annual_event.event_type IN ('voucher_review_flagged', 'voucher_review_resolved')
          ) AS latest
          WHERE latest.event_rank = 1
        ) AS voucher_event ON voucher_event.annual_enrollment_id = annual.id
        LEFT JOIN (
          SELECT latest.enrollment_id, latest.event_type
          FROM (
            SELECT clearance_event.enrollment_id, clearance_event.event_type,
              ROW_NUMBER() OVER (PARTITION BY clearance_event.enrollment_id
                ORDER BY clearance_event.created_at DESC, clearance_event.id DESC) AS event_rank
            FROM term_clearance_events AS clearance_event
          ) AS latest
          WHERE latest.event_rank = 1
        ) AS clearance ON clearance.enrollment_id = enrollment.id
        WHERE annual.intake_status <> 'legacy'
          AND (@searchPattern IS NULL OR student.student_no LIKE @searchPattern ESCAPE '~'
            OR CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) LIKE @searchPattern ESCAPE '~')
          AND (@termId IS NULL OR term.id = @termId)
          AND (@sectionId IS NULL OR section.id = @sectionId)
          AND (@cluster IS NULL OR section.cluster = @cluster)
          AND (@strand IS NULL OR section.strand = @strand)
          AND (@schoolYear IS NULL OR annual.school_year = @schoolYear)
          AND (@gradeLevel IS NULL OR annual.grade_level = @gradeLevel)
          AND (@voucherCode IS NULL OR annual.voucher_code = @voucherCode)
          AND (@status IS NULL OR enrollment.enrollment_status = @status)
          AND (@studentStatus IS NULL OR student.status = @studentStatus)
        ORDER BY annual.school_year DESC, annual.id DESC, enrollment.annual_term_number`);
    return result.recordset || [];
  }

  async function listAnnualEnrollmentsPage(actorInput, filters = {}) {
    const pool = await getPool();
    const actorId = normalizeId(actorInput, 'user');
    const filterSchoolYear = filters.schoolYear ? printable(filters.schoolYear, 'School year', 20) : null;
    const filterGradeLevel = filters.gradeLevel ? printable(filters.gradeLevel, 'Grade level', 50) : null;
    const filterVoucher = filters.voucherCode ? printable(filters.voucherCode, 'Voucher', 10) : null;
    const filterTermId = filters.termId ? normalizeId(filters.termId, 'academic term') : null;
    const filterSectionId = filters.sectionId ? normalizeId(filters.sectionId, 'section') : null;
    const filterCluster = filters.cluster ? printable(filters.cluster, 'Cluster', 80) : null;
    const filterStrand = filters.strand ? printable(filters.strand, 'Strand', 80) : null;
    const filterStatus = filters.status ? printable(filters.status, 'Status', 20) : null;
    const filterStudentStatus = filters.studentStatus ? printable(filters.studentStatus, 'Student status', 20) : null;
    const searchTerm = filters.search ? printable(filters.search, 'Search', 100) : null;
    if (filterVoucher && !['PUB', 'ESC', 'NV'].includes(filterVoucher)) throw new AnnualEnrollmentError('Choose PUB, ESC, or NV.');
    if (filterStatus && !['pending_payment', 'enrolled', 'cancelled', 'dropped', 'transferred'].includes(filterStatus)) throw new AnnualEnrollmentError('Choose a valid term placement status.');
    if (filterStudentStatus && filterStudentStatus !== 'active') throw new AnnualEnrollmentError('Choose active student records.');

    const searchPattern = searchTerm ? `%${searchTerm.replace(/[~%_[\]]/g, (character) => `~${character}`)}%` : null;
    const bindFilters = (request) => request
      .input('schoolYear', sql.NVarChar(20), filterSchoolYear)
      .input('gradeLevel', sql.NVarChar(50), filterGradeLevel)
      .input('voucherCode', sql.NVarChar(10), filterVoucher)
      .input('termId', sql.Int, filterTermId)
      .input('sectionId', sql.Int, filterSectionId)
      .input('cluster', sql.NVarChar(80), filterCluster)
      .input('strand', sql.NVarChar(80), filterStrand)
      .input('status', sql.NVarChar(20), filterStatus)
      .input('studentStatus', sql.NVarChar(20), filterStudentStatus)
      .input('searchPattern', sql.NVarChar(204), searchPattern);
    const filtersSql = `annual.intake_status <> 'legacy'
      AND (@searchPattern IS NULL OR student.student_no LIKE @searchPattern ESCAPE '~'
        OR CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) LIKE @searchPattern ESCAPE '~')
      AND (@termId IS NULL OR term.id = @termId)
      AND (@sectionId IS NULL OR section.id = @sectionId)
      AND (@cluster IS NULL OR section.cluster = @cluster)
      AND (@strand IS NULL OR section.strand = @strand)
      AND (@schoolYear IS NULL OR annual.school_year = @schoolYear)
      AND (@gradeLevel IS NULL OR annual.grade_level = @gradeLevel)
      AND (@voucherCode IS NULL OR annual.voucher_code = @voucherCode)
      AND (@status IS NULL OR enrollment.enrollment_status = @status)
      AND (@studentStatus IS NULL OR student.status = @studentStatus)`;

    const actorResult = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT role FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin')`);
    if (!actorResult.recordset?.length) throw new AnnualEnrollmentError('Your registrar access is no longer active. Sign in again.', 403);

    const countResult = await bindFilters(pool.request()).query(`SELECT COUNT(DISTINCT annual.id) AS total_records
      FROM annual_enrollments AS annual
      INNER JOIN students AS student ON student.id = annual.student_id
      LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
      LEFT JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
      LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
      WHERE ${filtersSql}`);
    const totalRecords = Math.max(0, Number(countResult.recordset?.[0]?.total_records) || 0);
    const pageSize = 20;
    const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
    const rawPage = typeof filters.page === 'string' || typeof filters.page === 'number' ? String(filters.page) : '';
    const requestedPage = /^\d{1,10}$/.test(rawPage) ? Math.max(1, Number(rawPage)) : 1;
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const result = await bindFilters(pool.request())
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize)
      .query(`WITH MatchingAnnualEnrollments AS (
          SELECT DISTINCT annual.id AS annual_enrollment_id, annual.school_year
          FROM annual_enrollments AS annual
          INNER JOIN students AS student ON student.id = annual.student_id
          LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
          LEFT JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
          LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
          WHERE ${filtersSql}
        ), PagedAnnualEnrollments AS (
          SELECT annual_enrollment_id
          FROM MatchingAnnualEnrollments
          ORDER BY school_year DESC, annual_enrollment_id DESC
          LIMIT @pageSize OFFSET @offset
        )
        SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.school_year,
          annual.grade_level, annual.voucher_code, annual.voucher_category, annual.intake_status,
          annual.intake_kind, annual.entry_term_number, annual.enrollment_start_date,
          student.student_no, student.lrn, student.sex, student.first_name, student.middle_name, student.last_name, student.suffix,
          enrollment.id AS enrollment_id, enrollment.annual_term_number, enrollment.enrollment_status,
          enrollment.term_scope_status, enrollment.enrolled_at, enrollment.finalized_at,
          term.term, term.id AS academic_term_id, section.id AS section_id, section.name AS section_name,
          section.cluster, section.strand, section.adviser, section.modality, section.modular_subtype,
          assessment.voucher_code_snapshot AS assessed_voucher_code, assessment.schedule_version AS assessed_schedule_version,
          confirmation.id AS registrar_confirmation_id,
          CASE WHEN voucher_event.event_type = 'voucher_review_flagged' THEN 1 ELSE 0 END AS voucher_review_required,
          voucher_event.reason AS voucher_review_reason,
          CASE WHEN clearance.event_type IS NULL THEN NULL WHEN clearance.event_type = 'signed' THEN 'signed' ELSE 'not signed' END AS signed_clearance_status
        FROM PagedAnnualEnrollments AS page
        INNER JOIN annual_enrollments AS annual ON annual.id = page.annual_enrollment_id
        INNER JOIN students AS student ON student.id = annual.student_id
        LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
        LEFT JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
        LEFT JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = annual.id
        LEFT JOIN (
          SELECT latest.annual_enrollment_id, latest.event_type, latest.reason
          FROM (
            SELECT annual_event.annual_enrollment_id, annual_event.event_type, annual_event.reason,
              ROW_NUMBER() OVER (PARTITION BY annual_event.annual_enrollment_id
                ORDER BY annual_event.created_at DESC, annual_event.id DESC) AS event_rank
            FROM annual_enrollment_events AS annual_event
            WHERE annual_event.event_type IN ('voucher_review_flagged', 'voucher_review_resolved')
          ) AS latest
          WHERE latest.event_rank = 1
        ) AS voucher_event ON voucher_event.annual_enrollment_id = annual.id
        LEFT JOIN (
          SELECT latest.enrollment_id, latest.event_type
          FROM (
            SELECT clearance_event.enrollment_id, clearance_event.event_type,
              ROW_NUMBER() OVER (PARTITION BY clearance_event.enrollment_id
                ORDER BY clearance_event.created_at DESC, clearance_event.id DESC) AS event_rank
            FROM term_clearance_events AS clearance_event
          ) AS latest
          WHERE latest.event_rank = 1
        ) AS clearance ON clearance.enrollment_id = enrollment.id
        WHERE ${filtersSql}
        ORDER BY annual.school_year DESC, annual.id DESC, enrollment.annual_term_number`);
    const from = totalRecords ? offset + 1 : 0;
    const to = totalRecords ? Math.min(offset + pageSize, totalRecords) : 0;
    return {
      rows: result.recordset || [],
      pagination: { page, pageSize, totalRecords, totalPages, from, to }
    };
  }

  async function finalizePlacementInTransaction(transaction, actor, enrollmentId, { requireConfirmation = true } = {}) {
    const selected = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
      .query(`SELECT enrollment.id AS enrollment_id, enrollment.enrollment_status, enrollment.finalized_at,
          enrollment.section_id, enrollment.term_scope_status, enrollment.annual_term_number,
          parent.id AS annual_enrollment_id, parent.account_activation_pending, parent.intake_status,
          student.id AS student_id, student.student_no, student.status AS student_status, student.user_id,
          student.first_name, student.middle_name, student.last_name, student.suffix,
          account.email, account.is_active, parent.grade_level, term.school_year, term.term, section.name AS section_name,
          confirmation.id AS registrar_confirmation_id
        FROM enrollments AS enrollment
        INNER JOIN annual_enrollments AS parent ON parent.id = enrollment.annual_enrollment_id
        INNER JOIN students AS student ON student.id = enrollment.student_id
        LEFT JOIN users AS account ON account.id = student.user_id AND account.role = 'student'
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = parent.id
        WHERE enrollment.id = @enrollmentId FOR UPDATE`);
    const row = selected.recordset?.[0];
    if (!row) throw new AnnualEnrollmentError('Annual term placement not found.', 404);
    if (row.intake_status === 'legacy') throw new AnnualEnrollmentError('Legacy term history is read-only. Use the explicit reviewed legacy activation workflow.', 409);
    if (requireConfirmation && !row.registrar_confirmation_id) throw new AnnualEnrollmentError('Confirm the annual enrollment and fee assessment before activating a term.', 409);
    if (row.term_scope_status !== 'applicable' || row.enrollment_status === 'not_applicable') {
      throw new AnnualEnrollmentError('This term is not applicable for the student’s entry term.', 409);
    }
    if (!row.section_id) throw new AnnualEnrollmentError('Assign a section to this term before activation.', 409);
    if (row.enrollment_status !== 'pending_payment' || row.finalized_at) throw new AnnualEnrollmentError('This term placement is no longer pending.', 409);
    if (row.student_status !== 'active') throw new AnnualEnrollmentError('Only an active student record can be finalized.', 409);

    const generatedPassword = createPassword();
    let temporaryPassword = null;
    let activated = false;
    if ((row.account_activation_pending === true || row.account_activation_pending === 1) && row.user_id
      && !(row.is_active === true || row.is_active === 1)) {
      const passwordHash = await hashPassword(generatedPassword, BCRYPT_ROUNDS);
      const activation = await transaction.request()
        .input('userId', sql.Int, row.user_id)
        .input('passwordHash', sql.NVarChar(255), passwordHash)
        .query(`UPDATE users SET is_active = 1, must_change_password = 1,
            password_hash = @passwordHash, auth_session_version = UUID(), updated_at = UTC_TIMESTAMP(6)
          WHERE id = @userId AND role = 'student' AND is_active = 0`);
      activated = activation.affectedRows === 1;
      if (!activated) throw new AnnualEnrollmentError('The new student login changed before enrollment confirmation. No credentials were issued.', 409);
      temporaryPassword = generatedPassword;
    }
    if (row.account_activation_pending === true || row.account_activation_pending === 1) {
      await transaction.request().input('annualEnrollmentId', sql.Int, row.annual_enrollment_id)
        .query(`UPDATE annual_enrollments SET account_activation_pending = 0, updated_at = UTC_TIMESTAMP(6)
          WHERE id = @annualEnrollmentId AND account_activation_pending = 1`);
    }
    const finalized = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
      .query(`UPDATE enrollments SET enrollment_status = 'enrolled', finalized_at = UTC_TIMESTAMP(6)
        WHERE id = @enrollmentId AND enrollment_status = 'pending_payment' AND finalized_at IS NULL`);
    if (finalized.rowsAffected?.[0] !== 1) throw new AnnualEnrollmentError('The term placement changed before activation.', 409);
    await transaction.request().input('annualEnrollmentId', sql.Int, row.annual_enrollment_id)
      .query(`UPDATE annual_enrollments SET intake_status = 'enrolled', updated_at = UTC_TIMESTAMP(6)
        WHERE id = @annualEnrollmentId AND intake_status = 'pending'`);
    await writeAudit(transaction, actor, 'annual_term_finalized', enrollmentId, {
      annualEnrollmentId: row.annual_enrollment_id, annualTermNumber: row.annual_term_number,
      studentLoginActivated: activated, temporaryPasswordIssued: Boolean(temporaryPassword)
    });
    return {
      enrollmentId, annualEnrollmentId: Number(row.annual_enrollment_id), studentId: Number(row.student_id),
      studentNo: row.student_no, firstName: row.first_name, middleName: row.middle_name,
      lastName: row.last_name, suffix: row.suffix, email: row.email, schoolYear: row.school_year,
      term: row.term, termNumber: Number(row.annual_term_number), gradeLevel: row.grade_level,
      sectionName: row.section_name, temporaryPassword
    };
  }

  async function finalizeAnnualTerm(actorInput, enrollmentInput) {
    const enrollmentId = normalizeId(enrollmentInput, 'enrollment');
    return runTransaction(async (transaction) => {
      const actor = await requireRegistrar(transaction.request(), actorInput);
      return finalizePlacementInTransaction(transaction, actor, enrollmentId);
    });
  }

  async function confirmAnnualEnrollment(actorInput, annualInput, input = {}) {
    if (!annualFinanceService || typeof annualFinanceService.confirmAnnualAssessmentInTransaction !== 'function') {
      throw new AnnualEnrollmentError('Fee assessment is unavailable. Reload later or contact a system administrator.', 503);
    }
    const annualEnrollmentId = normalizeId(annualInput, 'annual enrollment');
    const idempotencyKey = normalizeUuid(input.idempotencyKey, 'enrollment confirmation');
    const scheduleId = normalizeId(input.scheduleId, 'fee schedule');
    const scheduleVersion = normalizeId(input.scheduleVersion, 'fee schedule version');
    const voucherCode = input.voucherCode;
    if (!['PUB', 'ESC', 'NV'].includes(voucherCode)) throw new AnnualEnrollmentError('Reload the fee review before confirming enrollment.');
    const rawSelection = input.optionalLineIds == null ? [] : Array.isArray(input.optionalLineIds) ? input.optionalLineIds : [input.optionalLineIds];
    if (rawSelection.length > 120) throw new AnnualEnrollmentError('Too many optional fees were selected.');
    const optionalLineIds = rawSelection.map((value) => normalizeId(value, 'optional fee'));
    if (new Set(optionalLineIds).size !== optionalLineIds.length) throw new AnnualEnrollmentError('An optional fee was selected more than once.');
    optionalLineIds.sort((left, right) => left - right);
    const expectedAssessmentId = input.assessmentId ? normalizeId(input.assessmentId, 'assessment') : null;
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ annualEnrollmentId, scheduleId, scheduleVersion,
      voucherCode, expectedAssessmentId, optionalLineIds, assessmentSnapshotFingerprint: input.snapshotFingerprint || null })).digest('hex');
    const pool = await getPool();
    const ownerResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query('SELECT student_id FROM annual_enrollments WHERE id = @annualEnrollmentId');
    const owner = ownerResult.recordset?.[0];
    if (!owner) throw new AnnualEnrollmentError('Annual enrollment not found.', 404);
    const ownerStudentId = Number(owner.student_id);
    return runTransaction(async (transaction) => {
      const actor = await requireRegistrar(transaction.request(), actorInput);
      const student = await debtRevisions.lockStudent(transaction, ownerStudentId);
      if (!student) throw new AnnualEnrollmentError('Student record not found.', 404);
      if (student.status === 'archived') throw new AnnualEnrollmentError('Archived students cannot receive new enrollments.', 409);
      const priorResult = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT id, annual_enrollment_id, request_fingerprint, assessment_id, payable_total
          FROM annual_registrar_confirmations WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
      const prior = priorResult.recordset?.[0];
      if (prior) {
        if (Number(prior.annual_enrollment_id) !== annualEnrollmentId || prior.request_fingerprint !== fingerprint) {
          throw new AnnualEnrollmentError('This confirmation token was already used for different fee or enrollment choices.', 409);
        }
        const saved = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
          .input('studentId', sql.Int, ownerStudentId)
          .query(`SELECT annual.student_id, annual.school_year, annual.grade_level, annual.entry_term_number,
              student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix,
              term.term, section.name AS section_name
            FROM annual_enrollments AS annual
            INNER JOIN students AS student ON student.id = annual.student_id
            INNER JOIN enrollments AS entry ON entry.annual_enrollment_id = annual.id
              AND entry.annual_term_number = annual.entry_term_number
            INNER JOIN academic_terms AS term ON term.id = entry.academic_term_id
            LEFT JOIN sections AS section ON section.id = entry.section_id AND section.academic_term_id = entry.academic_term_id
            WHERE annual.id = @annualEnrollmentId AND annual.student_id = @studentId`);
        const row = saved.recordset?.[0];
        if (!row) throw new AnnualEnrollmentError('The saved enrollment confirmation could not be loaded.', 409);
        return { annualEnrollmentId, studentId: Number(row.student_id), studentNo: row.student_no,
          firstName: row.first_name, middleName: row.middle_name, lastName: row.last_name, suffix: row.suffix,
          schoolYear: row.school_year, gradeLevel: row.grade_level, term: row.term, termNumber: Number(row.entry_term_number),
          sectionName: row.section_name, assessmentId: Number(prior.assessment_id), total: String(prior.payable_total),
          temporaryPassword: null, alreadyConfirmed: true };
      }
      const parentResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('studentId', sql.Int, ownerStudentId)
        .query(`SELECT annual.id, annual.student_id, annual.school_year, annual.grade_level, annual.voucher_code,
            annual.pre_enrollment_id, annual.readmission_evaluation_id, annual.readmission_evaluation_version, annual.intake_kind,
            annual.entry_term_number, annual.intake_status, annual.enrollment_start_date, student.status AS student_status,
            assessment.id AS existing_assessment_id, assessment.schedule_id AS existing_schedule_id,
            assessment.schedule_version AS existing_schedule_version, assessment.voucher_code_snapshot,
            latest_voucher_event.event_type AS latest_voucher_event,
            entry.id AS entry_enrollment_id, entry.enrollment_status AS entry_status, entry.finalized_at AS entry_finalized_at,
            entry.term_scope_status, entry.section_id, section.id AS valid_section_id
          FROM annual_enrollments AS annual
          INNER JOIN students AS student ON student.id = annual.student_id
          LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
          INNER JOIN enrollments AS entry ON entry.annual_enrollment_id = annual.id
            AND entry.annual_term_number = annual.entry_term_number
          LEFT JOIN sections AS section ON section.id = entry.section_id
            AND section.academic_term_id = entry.academic_term_id
          LEFT JOIN (
            SELECT latest.annual_enrollment_id, latest.event_type
            FROM (
              SELECT event.annual_enrollment_id, event.event_type,
                ROW_NUMBER() OVER (PARTITION BY event.annual_enrollment_id
                  ORDER BY event.created_at DESC, event.id DESC) AS event_rank
              FROM annual_enrollment_events AS event
              WHERE event.event_type IN ('voucher_review_flagged', 'voucher_review_resolved')
            ) AS latest
            WHERE latest.event_rank = 1
          ) AS latest_voucher_event ON latest_voucher_event.annual_enrollment_id = annual.id
          WHERE annual.id = @annualEnrollmentId AND annual.student_id = @studentId
            AND annual.intake_status <> 'legacy' FOR UPDATE`);
      const parent = parentResult.recordset?.[0];
      if (!parent) throw new AnnualEnrollmentError('Annual enrollment not found.', 404);
      if (parent.student_status === 'archived') throw new AnnualEnrollmentError('Archived student records cannot be confirmed.', 409);
      if (parent.intake_status !== 'pending') throw new AnnualEnrollmentError('This annual enrollment has already been confirmed or closed.', 409);
      if (!parent.pre_enrollment_id) {
        throw new AnnualEnrollmentError('A new annual enrollment must retain its front-desk paper source before confirmation.', 409);
      }
      const sourceResult = await transaction.request().input('preEnrollmentId', sql.Char(36), parent.pre_enrollment_id)
        .query(`SELECT source.id, source.lrn, source.school_year, source.target_grade_level, source.applicant_kind,
            source.status, source.readmission_evaluation_id, source.readmission_evaluation_version,
            source.created_by_role
          FROM pre_enrollments AS source WHERE source.id = @preEnrollmentId FOR UPDATE`);
      const linkedSource = sourceResult.recordset?.[0];
      if (!linkedSource || linkedSource.status !== 'enrollment_started' || linkedSource.created_by_role !== 'front_desk'
        || linkedSource.school_year !== parent.school_year || linkedSource.target_grade_level !== parent.grade_level
        || !/^\d{12}$/.test(String(linkedSource.lrn || ''))) {
        throw new AnnualEnrollmentError('The front-desk paper source is no longer valid for this annual enrollment.', 409);
      }
      if (parent.intake_kind === 'readmission') {
        if (!parent.readmission_evaluation_id || String(parent.readmission_evaluation_id).toLowerCase() !== String(linkedSource.readmission_evaluation_id || '').toLowerCase()
          || Number(parent.readmission_evaluation_version) !== Number(linkedSource.readmission_evaluation_version)) {
          throw new AnnualEnrollmentError('The readmission evaluation binding changed after annual intake was opened.', 409);
        }
        const evaluationResult = await transaction.request().input('evaluationId', sql.Char(36), parent.readmission_evaluation_id)
          .query(`SELECT id, applicant_lrn, student_id, school_year, target_grade_level, status, version
            FROM readmission_evaluations WHERE id = @evaluationId FOR UPDATE`);
        const evaluation = evaluationResult.recordset?.[0];
        if (!evaluation || evaluation.status !== 'accepted' || Number(evaluation.version) !== Number(parent.readmission_evaluation_version)
          || evaluation.applicant_lrn !== linkedSource.lrn || evaluation.school_year !== parent.school_year
          || evaluation.target_grade_level !== parent.grade_level
          || (evaluation.student_id != null && Number(evaluation.student_id) !== Number(parent.student_id))) {
          throw new AnnualEnrollmentError('The balik-aral evaluation changed or is no longer accepted for this enrollment. Reopen it for registrar review.', 409);
        }
      } else if (parent.intake_kind === 'continuing'
        ? linkedSource.applicant_kind !== 'continuing' || linkedSource.readmission_evaluation_id
        : linkedSource.applicant_kind === 'readmission' || linkedSource.readmission_evaluation_id) {
        throw new AnnualEnrollmentError('The paper source classification no longer matches this enrollment.', 409);
      }
      if (parent.entry_status !== 'pending_payment' || parent.entry_finalized_at || parent.term_scope_status !== 'applicable' || !parent.valid_section_id) {
        throw new AnnualEnrollmentError('Assign a valid section to the entry term before confirming enrollment.', 409);
      }
      if (parent.latest_voucher_event === 'voucher_review_flagged') {
        throw new AnnualEnrollmentError('Finance must review the voucher change before enrollment can be confirmed.', 409);
      }
      const existingAssessmentId = parent.existing_assessment_id == null ? null : Number(parent.existing_assessment_id);
      if (existingAssessmentId !== expectedAssessmentId) throw new AnnualEnrollmentError('The fee assessment changed after review. Reload the fee summary before confirming.', 409);
      const assessed = await annualFinanceService.confirmAnnualAssessmentInTransaction(transaction, actor.id, annualEnrollmentId,
        optionalLineIds, { idempotencyKey, scheduleId, scheduleVersion, voucherCode, snapshotFingerprint: input.snapshotFingerprint, studentId: ownerStudentId });
      const assessmentId = normalizeId(String(assessed.assessmentId), 'assessment');
      const payableTotal = typeof assessed.total === 'string' && /^(?:0|[1-9]\d{0,9})\.\d{2}$/.test(assessed.total)
        ? assessed.total : null;
      if (!payableTotal || typeof assessed.snapshotFingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(assessed.snapshotFingerprint)) {
        throw new AnnualEnrollmentError('The saved assessment could not be verified. No enrollment confirmation was recorded.', 409);
      }
      const assessmentSnapshotFingerprint = crypto.createHash('sha256').update(JSON.stringify({
        assessmentId, scheduleId, scheduleVersion, voucherCode, payableTotal, optionalLineIds,
        postedComposition: assessed.snapshotFingerprint
      })).digest('hex');
      const inserted = await transaction.request()
        .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('studentId', sql.Int, parent.student_id)
        .input('schoolYear', sql.NVarChar(20), parent.school_year)
        .input('gradeLevel', sql.NVarChar(50), parent.grade_level)
        .input('entryEnrollmentId', sql.Int, parent.entry_enrollment_id)
        .input('assessmentId', sql.Int, assessmentId)
        .input('scheduleId', sql.Int, scheduleId)
        .input('scheduleVersion', sql.Int, scheduleVersion)
        .input('voucherCode', sql.NVarChar(10), voucherCode)
        .input('payableTotal', sql.Decimal(12, 2), payableTotal)
        .input('selectionJson', sql.NVarChar(sql.MAX), JSON.stringify({ optionalLineIds }))
        .input('assessmentSnapshotFingerprint', sql.Char(64), assessmentSnapshotFingerprint)
        .input('actorId', sql.Int, actor.id)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.Char(64), fingerprint)
        .query(`INSERT INTO annual_registrar_confirmations
          (annual_enrollment_id, student_id, school_year, grade_level, assessment_id, schedule_id, schedule_version, voucher_code_snapshot,
              payable_total, selection_json, assessment_snapshot_fingerprint, confirmed_by, idempotency_key, request_fingerprint, entry_enrollment_id)
          VALUES (@annualEnrollmentId, @studentId, @schoolYear, @gradeLevel, @assessmentId, @scheduleId, @scheduleVersion, @voucherCode,
            @payableTotal, @selectionJson, @assessmentSnapshotFingerprint, @actorId, @idempotencyKey, @requestFingerprint, @entryEnrollmentId)`);
      if (!Number.isSafeInteger(inserted.insertId) || inserted.insertId < 1) throw new Error('Annual confirmation insert returned no identifier.');
      const enrollment = await finalizePlacementInTransaction(transaction, actor, Number(parent.entry_enrollment_id));
      await writeAudit(transaction, actor, 'annual_enrollment_confirmed', annualEnrollmentId, {
        assessmentId, scheduleId, scheduleVersion, voucherCode, payableTotal, optionalLineIds,
        entryEnrollmentId: Number(parent.entry_enrollment_id), loginActivated: Boolean(enrollment.temporaryPassword)
      });
      return { ...enrollment, annualEnrollmentId, assessmentId, total: payableTotal, alreadyConfirmed: false };
    });
  }

  async function changeTermStatus(actorInput, enrollmentInput, statusInput, reasonInput) {
    const enrollmentId = normalizeId(enrollmentInput, 'enrollment');
    const status = typeof statusInput === 'string' ? statusInput : '';
    const eventType = STATUSES.get(status);
    if (!eventType) throw new AnnualEnrollmentError('Use a dated departure case for dropped or transferred placements. This form records cancellation only.');
    const reason = printable(reasonInput || '', 'Reason', 1000, { required: true });
    return runTransaction(async (transaction) => {
      const actor = await requireRegistrar(transaction.request(), actorInput);
      const selected = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
        .query(`SELECT enrollment.id, enrollment.annual_enrollment_id, enrollment.enrollment_status,
            annual.intake_status, student.status AS student_status
          FROM enrollments AS enrollment
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          INNER JOIN students AS student ON student.id = enrollment.student_id
          WHERE enrollment.id = @enrollmentId FOR UPDATE`);
      const row = selected.recordset?.[0];
      if (!row) throw new AnnualEnrollmentError('Annual term placement not found.', 404);
      if (row.intake_status === 'legacy') throw new AnnualEnrollmentError('Legacy term history is read-only.', 409);
      if (row.student_status === 'archived') throw new AnnualEnrollmentError('Archived student history is read-only.', 409);
      if (!['pending_payment', 'enrolled'].includes(row.enrollment_status)) throw new AnnualEnrollmentError('This term placement cannot be changed from its current status.', 409);
      const update = await transaction.request()
        .input('enrollmentId', sql.Int, enrollmentId)
        .input('status', sql.NVarChar(30), status)
        .query(`UPDATE enrollments SET enrollment_status = @status
          WHERE id = @enrollmentId AND enrollment_status IN ('pending_payment', 'enrolled')`);
      if (update.rowsAffected?.[0] !== 1) throw new AnnualEnrollmentError('This term placement changed while the request was being saved.', 409);
      await transaction.request()
        .input('annualEnrollmentId', sql.Int, row.annual_enrollment_id)
        .input('enrollmentId', sql.Int, enrollmentId)
        .input('actorId', sql.Int, actor.id)
        .input('eventType', sql.NVarChar(40), eventType)
        .input('reason', sql.NVarChar(1000), reason)
        .query(`INSERT INTO annual_enrollment_events (annual_enrollment_id, enrollment_id, actor_id, event_type, reason)
          VALUES (@annualEnrollmentId, @enrollmentId, @actorId, @eventType, @reason)`);
      await writeAudit(transaction, actor, eventType, enrollmentId, { annualEnrollmentId: row.annual_enrollment_id, reason });
      return { enrollmentId, status };
    });
  }

  async function updateVoucher(actorInput, annualEnrollmentInput, voucherInput, reasonInput) {
    const annualEnrollmentId = normalizeId(annualEnrollmentInput, 'annual enrollment');
    if (!['PUB', 'ESC', 'NV'].includes(voucherInput)) throw new AnnualEnrollmentError('Choose a voucher type: PUB, ESC, or NV.');
    const reason = printable(reasonInput || '', 'Voucher type change reason', 1000, { required: true });
    return runTransaction(async (transaction) => {
      const actor = await requireRegistrar(transaction.request(), actorInput);
      const currentResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query(`SELECT annual.id, annual.voucher_code, annual.voucher_category, student.status AS student_status
          FROM annual_enrollments AS annual
          INNER JOIN students AS student ON student.id = annual.student_id
          WHERE annual.id = @annualEnrollmentId AND annual.intake_status <> 'legacy' FOR UPDATE`);
      const current = currentResult.recordset?.[0];
      if (!current) throw new AnnualEnrollmentError('Annual enrollment not found.', 404);
      if (current.student_status === 'archived') throw new AnnualEnrollmentError('Archived student history is read-only.', 409);
      await transaction.request()
        .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('voucherCode', sql.NVarChar(10), voucherInput)
        .query(`UPDATE annual_enrollments SET voucher_code = @voucherCode,
            updated_at = UTC_TIMESTAMP(6)
          WHERE id = @annualEnrollmentId`);
      const assessmentResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query('SELECT id FROM annual_assessments WHERE annual_enrollment_id = @annualEnrollmentId');
      if (assessmentResult.recordset?.length) {
        await transaction.request()
          .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
          .input('actorId', sql.Int, actor.id)
          .input('reason', sql.NVarChar(1000), reason)
          .query(`INSERT INTO annual_enrollment_events (annual_enrollment_id, actor_id, event_type, reason)
            VALUES (@annualEnrollmentId, @actorId, 'voucher_review_flagged', @reason)`);
      }
      await writeAudit(transaction, actor, 'annual_voucher_changed', annualEnrollmentId, {
        oldVoucherCode: current.voucher_code, oldVoucherCategory: current.voucher_category,
        voucherCode: voucherInput, assessmentReviewRequired: Boolean(assessmentResult.recordset?.length), reason
      });
      return { annualEnrollmentId, assessmentReviewRequired: Boolean(assessmentResult.recordset?.length) };
    });
  }

  async function updateTermPlacement(actorInput, enrollmentInput, sectionInput, reasonInput) {
    const enrollmentId = normalizeId(enrollmentInput, 'enrollment');
    const sectionId = normalizeId(sectionInput, 'section');
    const reason = printable(reasonInput || '', 'Placement change reason', 1000, { required: true });
    return runTransaction(async (transaction) => {
      const actor = await requireRegistrar(transaction.request(), actorInput);
      const currentResult = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
        .query(`SELECT enrollment.id, enrollment.annual_enrollment_id, enrollment.academic_term_id,
            enrollment.enrollment_status, annual.grade_level, annual.school_year, annual.intake_status,
            student.status AS student_status
          FROM enrollments AS enrollment
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          INNER JOIN students AS student ON student.id = enrollment.student_id
          WHERE enrollment.id = @enrollmentId FOR UPDATE`);
      const current = currentResult.recordset?.[0];
      if (!current) throw new AnnualEnrollmentError('Annual term placement not found.', 404);
      if (current.intake_status === 'legacy') throw new AnnualEnrollmentError('Legacy term history is read-only.', 409);
      if (current.student_status === 'archived') throw new AnnualEnrollmentError('Archived student history is read-only.', 409);
      if (current.enrollment_status !== 'pending_payment') throw new AnnualEnrollmentError('Only an unfinalized term placement can be changed.', 409);
      const assigned = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
        .query(`SELECT id FROM student_subjects
          WHERE enrollment_id = @enrollmentId LIMIT 1 FOR UPDATE`);
      if (assigned.recordset?.length) throw new AnnualEnrollmentError('This term already has academic assignments. Its section cannot be changed.', 409);
      const sectionResult = await transaction.request()
        .input('sectionId', sql.Int, sectionId)
        .input('termId', sql.Int, current.academic_term_id)
        .input('gradeLevel', sql.NVarChar(50), current.grade_level)
        .input('schoolYear', sql.NVarChar(20), current.school_year)
        .query(`SELECT section.id FROM sections AS section
          INNER JOIN academic_terms AS term ON term.id = section.academic_term_id
          WHERE section.id = @sectionId AND section.academic_term_id = @termId
            AND section.grade_level = @gradeLevel AND term.school_year = @schoolYear FOR UPDATE`);
      if (!sectionResult.recordset?.length) throw new AnnualEnrollmentError('Choose a section in the same term, school year, and grade level.', 409);
      const updated = await transaction.request().input('enrollmentId', sql.Int, enrollmentId).input('sectionId', sql.Int, sectionId)
        .query(`UPDATE enrollments SET section_id = @sectionId
          WHERE id = @enrollmentId AND enrollment_status = 'pending_payment' AND finalized_at IS NULL`);
      if (updated.rowsAffected?.[0] !== 1) throw new AnnualEnrollmentError('The term placement changed before it could be saved.', 409);
      await transaction.request()
        .input('annualEnrollmentId', sql.Int, current.annual_enrollment_id)
        .input('enrollmentId', sql.Int, enrollmentId)
        .input('actorId', sql.Int, actor.id)
        .input('reason', sql.NVarChar(1000), reason)
        .query(`INSERT INTO annual_enrollment_events (annual_enrollment_id, enrollment_id, actor_id, event_type, reason)
          VALUES (@annualEnrollmentId, @enrollmentId, @actorId, 'term_placement_changed', @reason)`);
      await writeAudit(transaction, actor, 'annual_term_placement_changed', enrollmentId, {
        annualEnrollmentId: current.annual_enrollment_id, sectionId, reason
      });
      return { enrollmentId, sectionId };
    });
  }

  return {
    loadIntakeOptions, listTermOrderOptions, configureSchoolYearTermOrder,
    createAnnualIntake, listAnnualEnrollments, listAnnualEnrollmentsPage, listAnnualEnrollmentCounts,
    getAnnualManagementRecord, updateAnnualAdministrationDetails, recordAnnualTag, addSpecialSubject,
    previewDeparture, createDepartureCase, finalizeAnnualTerm, confirmAnnualEnrollment,
    changeTermStatus, updateVoucher, updateTermPlacement
  };
}

module.exports = {
  AnnualEnrollmentError,
  createAnnualEnrollmentService,
  normalizeAnnualInput,
  normalizeAnnualAdministrationDetails,
  applySameSectionDefaults,
  normalizeEmail,
  normalizeUuid
};
