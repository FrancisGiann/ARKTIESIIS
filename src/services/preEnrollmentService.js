'use strict';

const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');
const { StudentRecordsError, validateName, normalizePhone } = require('./studentRecordsService');
const { ADDRESS_DEFINITIONS, StudentAddressError, normalizeStructuredAddress } = require('../utils/studentAddress');
const { profileReviewFingerprint } = require('../utils/studentProfileReview');
const { runSerializableTransaction } = require('./transactionRetry');

const EDIT_ROLES = new Set(['front_desk', 'registrar']);
const CREATE_ROLES = new Set(['front_desk']);
const READ_ACCEPTED_EVALUATION_ROLES = new Set(['front_desk', 'registrar']);
const READ_ROLES = new Set([...EDIT_ROLES, 'database_admin']);
const PAGE_SIZE = 20;
const RECEIPT_REQUIREMENTS = Object.freeze([
  ['report_card', 'Report Card (Grade 10 / ALS-AF5)'],
  ['birth_certificate', 'Birth Certificate (PSA / NSO / OLD)'],
  ['good_moral', 'Good Moral Certificate'],
  ['junior_high_certificate', 'Junior High School Certificate'],
  ['certificate_of_rating', 'Certificate of Rating (ALS)'],
  ['esc_certificate', 'ESC Certificate (Private School)'],
  ['national_id', 'National ID (optional)'],
  ['two_by_two_photos', 'Three 2×2 pictures (name tag and white background)'],
  ['long_brown_envelopes', 'Three long brown envelopes']
]);
const FIELD_SPEC = Object.freeze([
  ['school_year', 'schoolYear', 20], ['first_name', 'firstName', 100], ['middle_name', 'middleName', 100],
  ['last_name', 'lastName', 100], ['suffix', 'suffix', 20], ['lrn', 'lrn', 12],
  ['student_contact_number', 'studentContactNumber', 50], ['voucher_type_text', 'voucherTypeText', 120],
  ['voucher_category_text', 'voucherCategoryText', 120], ['preferred_track', 'preferredTrack', 40],
  ['applicant_kind', 'applicantKind', 20], ['email', 'email', 255], ['birth_date', 'birthDate', 10], ['sex', 'sex', 20],
  ['address', 'address', 500], ['address_block_lot_street_purok', 'addressBlockLotStreetPurok', 200],
  ['address_barangay', 'addressBarangay', 100], ['address_city', 'addressCity', 100], ['address_province', 'addressProvince', 100],
  ['address_zip', 'addressZip', 4], ['profile_phone', 'profilePhone', 50], ['birthplace', 'birthplace', 160],
  ['facebook_name', 'facebookName', 120], ['emergency_contact_person', 'emergencyContactPerson', 160],
  ['emergency_contact_relationship', 'emergencyContactRelationship', 80], ['emergency_contact_phone', 'emergencyContactPhone', 50],
  ['emergency_contact_address', 'emergencyContactAddress', 500],
  ['emergency_contact_address_block_lot_street_purok', 'emergencyContactAddressBlockLotStreetPurok', 200],
  ['emergency_contact_address_barangay', 'emergencyContactAddressBarangay', 100],
  ['emergency_contact_address_city', 'emergencyContactAddressCity', 100],
  ['emergency_contact_address_province', 'emergencyContactAddressProvince', 100],
  ['emergency_contact_address_zip', 'emergencyContactAddressZip', 4],
  ['mother_name', 'motherName', 160], ['mother_phone', 'motherPhone', 50],
  ['father_name', 'fatherName', 160], ['father_phone', 'fatherPhone', 50],
  ['preferred_cluster', 'preferredCluster', 100], ['target_grade_level', 'targetGradeLevel', 20],
  ['prior_grade_level', 'priorGradeLevel', 80], ['prior_school', 'priorSchool', 200],
  ['student_signed_date', 'studentSignedDate', 10], ['received_by', 'receivedBy', 100], ['received_date', 'receivedDate', 10]
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_MAP = new Map(FIELD_SPEC.map(([column, name]) => [column, name]));

class PreEnrollmentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PreEnrollmentError';
    this.status = status;
  }
}

function printable(value, label, maxLength, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new PreEnrollmentError(`${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new PreEnrollmentError(`${label} must be ${maxLength} printable characters or fewer.`);
  const result = value.trim();
  if ((!result && required) || result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new PreEnrollmentError(`${label} must be ${maxLength} printable characters or fewer.`);
  }
  return result || null;
}

function normalizeUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new PreEnrollmentError(`Reload the form to use a valid ${label} token.`);
  return value.toLowerCase();
}

function normalizeDate(value, label, required = false) {
  const text = printable(value, label, 10, { required });
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new PreEnrollmentError(`${label} must be a valid calendar date.`);
  const date = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new PreEnrollmentError(`${label} must be a valid calendar date.`);
  }
  return text;
}

function normalizeEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new PreEnrollmentError('Email must be a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 255 || /[\u0000-\u001f\u007f]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new PreEnrollmentError('Email must be a valid email address.');
  }
  return email;
}

function normalizeProfileAddress(result, input, prefix, current) {
  const modeKey = `${prefix}Mode`;
  const mode = input[modeKey] || (current ? 'preserve' : 'replace');
  if (!['preserve', 'replace'].includes(mode)) throw new PreEnrollmentError('Choose whether to keep or replace the saved address.');
  const fields = ADDRESS_DEFINITIONS[prefix];
  if (mode === 'preserve') {
    const source = current || input;
    const legacyKey = prefix === 'address' ? 'address' : 'emergency_contact_address';
    const legacyAddress = source[legacyKey] ?? source[prefix];
    if (legacyAddress === undefined || legacyAddress === null || legacyAddress === '') result[prefix] = null;
    else if (typeof legacyAddress !== 'string' || legacyAddress.length > 500 || /[\u0000-\u001f\u007f]/.test(legacyAddress)) {
      throw new PreEnrollmentError('Address must be 500 printable characters or fewer.');
    } else result[prefix] = legacyAddress;
    for (const [inputName, column] of fields) result[inputName] = printable(source[column] ?? source[inputName], 'Address component', inputName.endsWith('Zip') ? 4 : inputName.endsWith('StreetPurok') ? 200 : 100);
    return;
  }
  try {
    const normalized = normalizeStructuredAddress(input, prefix);
    result[prefix] = normalized.formatted;
    for (const [inputName, column] of fields) result[inputName] = normalized[column];
  } catch (error) {
    if (error instanceof StudentAddressError) throw new PreEnrollmentError(error.message);
    throw error;
  }
}

function normalizeReceiptFlag(value, label) {
  if (value === true || value === '1' || value === 'true' || value === 'on') return true;
  if (value === false || value === '0' || value === 'false' || value === undefined || value === null || value === '') return false;
  throw new PreEnrollmentError(`Choose whether ${label} was received.`);
}

function normalizeSameAddressFlag(value) {
  if (value === true || value === '1' || value === 'true' || value === 'on') return true;
  if (value === false || value === '0' || value === 'false' || value === undefined || value === null || value === '') return false;
  throw new PreEnrollmentError('Choose whether the emergency contact has the same address as the student.');
}

function copyStudentAddressToEmergency(result) {
  result.emergencyContactAddress = result.address;
  const emergencyFields = new Map(ADDRESS_DEFINITIONS.emergencyContactAddress.map(([inputName, column]) => [
    column.replace(/^emergency_contact_/, ''), inputName
  ]));
  for (const [studentInputName, studentColumn] of ADDRESS_DEFINITIONS.address) {
    const emergencyInputName = emergencyFields.get(studentColumn);
    if (!emergencyInputName) throw new Error('Student and emergency address definitions do not match.');
    result[emergencyInputName] = result[studentInputName];
  }
}

function normalizePieceCount(value, present, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new PreEnrollmentError(`${label} must be a whole number from 1 to 99.`);
  const text = String(value);
  if (!/^\d{1,2}$/.test(text)) throw new PreEnrollmentError(`${label} must be a whole number from 1 to 99.`);
  const count = Number(text);
  if (count < 1 || count > 99 || !present) throw new PreEnrollmentError(`${label} can be recorded only when those papers were received.`);
  return count;
}

function manilaDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
}

function normalizeRecord(input = {}, { actorName = '', current = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PreEnrollmentError('Enter valid paper form details.');
  const sameAddress = normalizeSameAddressFlag(input.emergencyContactSameAsStudent);
  const normalizedInput = sameAddress ? {
    ...input,
    emergencyContactAddressMode: 'replace',
    emergencyContactAddress: '',
    ...Object.fromEntries(ADDRESS_DEFINITIONS.emergencyContactAddress.map(([inputName]) => [inputName, '']))
  } : input;
  const result = {};
  for (const [column, name, length] of FIELD_SPEC) {
    result[name] = column.endsWith('_date')
      ? normalizeDate(normalizedInput[name], name === 'studentSignedDate' ? 'Student signature date' : name === 'birthDate' ? 'Birth date' : 'Date received')
      : printable(normalizedInput[name], name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`), length,
        { required: column === 'school_year' });
  }
  const currentSchoolYear = result.schoolYear.match(/^(\d{4})-(\d{4})$/);
  if (!currentSchoolYear || Number(currentSchoolYear[2]) !== Number(currentSchoolYear[1]) + 1) {
    throw new PreEnrollmentError('School year must use the format YYYY-YYYY with consecutive years.');
  }
  try {
    result.firstName = validateName(input.firstName, 'First name');
    result.middleName = validateName(input.middleName, 'Middle name');
    result.lastName = validateName(input.lastName, 'Last name');
    result.suffix = validateName(input.suffix, 'Suffix', { maxLength: 20 });
    result.studentContactNumber = normalizePhone(input.studentContactNumber, 'Student contact number');
    result.profilePhone = normalizePhone(input.profilePhone, 'Phone');
    result.emergencyContactPhone = normalizePhone(input.emergencyContactPhone, 'Emergency contact phone');
    result.motherPhone = normalizePhone(input.motherPhone, 'Mother’s phone');
    result.fatherPhone = normalizePhone(input.fatherPhone, 'Father’s phone');
  } catch (error) {
    if (error instanceof StudentRecordsError) throw new PreEnrollmentError(error.message, error.status);
    throw error;
  }
  result.email = normalizeEmail(input.email);
  result.applicantKind = input.applicantKind === undefined || input.applicantKind === '' ? 'new' : input.applicantKind;
  if (!['new', 'continuing', 'readmission'].includes(result.applicantKind)) throw new PreEnrollmentError('Choose New, Continuing, or Returning after a break.');
  const sex = printable(input.sex || '', 'Gender', 20);
  result.sex = sex ? ({ male: 'Male', female: 'Female', other: 'Other' }[sex.toLowerCase()] || null) : null;
  if (sex && !result.sex) throw new PreEnrollmentError('Choose Male, Female, or Other for gender.');
  result.birthDate = normalizeDate(input.birthDate, 'Birth date');
  for (const [name, length, label] of [
    ['birthplace', 160, 'Birthplace'], ['facebookName', 120, 'Facebook name'],
    ['emergencyContactPerson', 160, 'Emergency contact person'], ['emergencyContactRelationship', 80, 'Emergency contact relationship'],
    ['motherName', 160, 'Mother name'], ['fatherName', 160, 'Father name']
  ]) result[name] = printable(input[name], label, length);
  normalizeProfileAddress(result, input, 'address', current);
  normalizeProfileAddress(result, normalizedInput, 'emergencyContactAddress', current);
  if (sameAddress) copyStudentAddressToEmergency(result);
  if (result.lrn && !/^\d{1,12}$/.test(result.lrn)) throw new PreEnrollmentError('LRN must contain digits only and be no longer than 12 digits.');
  const trackOptions = {
    'Academic Track': new Set([
      'ASSH (Arts, Social Science, and Humanities)', 'BE (Business & Entrepreneurship)',
      'BE-TECH-PRO HM (Hospitality Management)'
    ]),
    'Tech-Pro Track': new Set(['Hospitality and Tourism', 'ICT Support & Computer Programming'])
  };
  if (result.preferredTrack && !trackOptions[result.preferredTrack]) throw new PreEnrollmentError('Choose a listed preferred track.');
  if (result.preferredCluster && (!result.preferredTrack || !trackOptions[result.preferredTrack].has(result.preferredCluster))) {
    throw new PreEnrollmentError('Choose a cluster that belongs to the selected preferred track.');
  }
  if (result.targetGradeLevel && !['Grade 11', 'Grade 12'].includes(result.targetGradeLevel)) {
    throw new PreEnrollmentError('Choose Grade 11 or Grade 12.');
  }
  let evaluationId = input.readmissionEvaluationId;
  let evaluationVersion = input.readmissionEvaluationVersion;
  if (typeof input.readmissionEvaluationBinding === 'string' && input.readmissionEvaluationBinding) {
    const match = input.readmissionEvaluationBinding.match(/^([0-9a-f-]{36})@(\d{1,10})$/i);
    if (!match) throw new PreEnrollmentError('Choose a valid accepted return evaluation.');
    evaluationId = match[1];
    evaluationVersion = match[2];
  }
  result.readmissionEvaluationId = evaluationId ? normalizeUuid(evaluationId, 'readmission evaluation') : null;
  result.readmissionEvaluationVersion = evaluationVersion === '' || evaluationVersion == null ? null : Number(evaluationVersion);
  if (result.readmissionEvaluationVersion !== null && (!Number.isSafeInteger(result.readmissionEvaluationVersion) || result.readmissionEvaluationVersion < 1)) {
    throw new PreEnrollmentError('Reload the return evaluation before saving this paper record.', 409);
  }
  result.receivedBy = result.receivedBy || null;
  result.receivedDate = result.receivedDate || null;
  result.studentSignaturePresent = normalizeReceiptFlag(input.studentSignaturePresent, 'the student signature');
  result.status = input.status === undefined ? 'draft' : input.status;
  if (!['draft', 'ready_for_registrar'].includes(result.status)) {
    throw new PreEnrollmentError('Choose Draft or Ready for registrar.');
  }
  const receipts = RECEIPT_REQUIREMENTS.map(([code]) => {
    const originalReceived = normalizeReceiptFlag(input[`receipt_${code}_original`], `${code} original`);
    const photocopyReceived = normalizeReceiptFlag(input[`receipt_${code}_photocopy`], `${code} photocopy`);
    return {
      requirementCode: code,
      originalReceived,
      originalPieces: normalizePieceCount(input[`receipt_${code}_original_pieces`], originalReceived, `${code} original pieces`),
      photocopyReceived,
      photocopyPieces: normalizePieceCount(input[`receipt_${code}_photocopy_pieces`], photocopyReceived, `${code} photocopy pieces`)
    };
  });
  const missing = [];
  if (!result.firstName) missing.push('first name');
  if (!result.lastName) missing.push('last name');
  if (!/^\d{12}$/.test(result.lrn || '')) missing.push('12-digit LRN');
  if (!result.studentContactNumber) missing.push('student contact number');
  if (!result.email) missing.push('valid email address');
  if (!result.preferredTrack || !result.preferredCluster) missing.push('preferred track and cluster');
  if (!result.targetGradeLevel) missing.push('target grade level');
  if (!result.priorGradeLevel) missing.push('last grade level');
  if (!result.priorSchool) missing.push('school attended');
  if (!result.studentSignaturePresent || !result.studentSignedDate) missing.push('student signature and date');
  if (result.status === 'ready_for_registrar' && missing.length) {
    throw new PreEnrollmentError(`Complete the paper form before submitting: ${missing.join(', ')}.`);
  }
  if (result.status === 'ready_for_registrar' && result.applicantKind === 'readmission'
    && (!result.readmissionEvaluationId || !result.readmissionEvaluationVersion)) {
    throw new PreEnrollmentError('An accepted, current return evaluation is required before this record can be ready.', 409);
  }
  if (result.applicantKind !== 'readmission' && (result.readmissionEvaluationId || result.readmissionEvaluationVersion)) {
    throw new PreEnrollmentError('Only an applicant returning after a break may be linked to a return evaluation.');
  }
  if (result.applicantKind === 'readmission' && (!/^\d{12}$/.test(result.lrn || '')
    || !result.readmissionEvaluationId || !result.readmissionEvaluationVersion)) {
    throw new PreEnrollmentError('A complete LRN and accepted, current return evaluation are required for this applicant.');
  }
  result.missingRequired = missing;
  result.receipts = receipts;
  return result;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeActorId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) throw new PreEnrollmentError('Your staff access is no longer active. Sign in again.', 403);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new PreEnrollmentError('Your staff access is no longer active. Sign in again.', 403);
  return id;
}

function normalizePage(value) {
  if (typeof value !== 'string' || !/^\d{1,8}$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function escapeLike(value) {
  return value.replace(/[~%_[\]]/g, (character) => `~${character}`);
}

function createPreEnrollmentService({ getPool = defaultGetPool, sql = defaultSql, transactionFactory = (pool) => new sql.Transaction(pool) } = {}) {
  async function runTransaction(callback) {
    return runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
  }

  async function requireActor(request, actorInput, roles) {
    const actorId = normalizeActorId(actorInput);
    const result = await request.input('actorId', sql.Int, actorId).query(`SELECT account.id, account.role,
        staff.first_name, staff.last_name
      FROM users AS account LEFT JOIN staff_profiles AS staff ON staff.user_id = account.id
      WHERE account.id = @actorId AND account.is_active = 1`);
    const actor = result.recordset?.[0];
    if (!actor || !roles.has(actor.role)) throw new PreEnrollmentError('You cannot access pre-enrollment records.', 403);
    actor.displayName = [actor.first_name, actor.last_name].filter(Boolean).join(' ');
    return actor;
  }

  async function writeEvent(request, { recordId, actorId, eventType, version, fromStatus, toStatus, changedFields = [] }) {
    const details = JSON.stringify({ changedFields });
    await request.input('eventRecordId', sql.Char(36), recordId)
      .input('eventActorId', sql.Int, actorId)
      .input('eventType', sql.VarChar(40), eventType)
      .input('eventVersion', sql.Int, version)
      .input('fromStatus', sql.VarChar(30), fromStatus)
      .input('toStatus', sql.VarChar(30), toStatus)
      .input('eventDetails', sql.NVarChar(sql.MAX), details)
      .query(`INSERT INTO pre_enrollment_events
        (pre_enrollment_id, actor_id, event_type, version, from_status, to_status, details_json)
        VALUES (@eventRecordId, @eventActorId, @eventType, @eventVersion, @fromStatus, @toStatus, @eventDetails)`);
  }

  async function lockReadmissionEvaluation(transaction, record) {
    if (record.applicantKind !== 'readmission') return;
    const result = await transaction.request()
      .input('evaluationId', sql.Char(36), record.readmissionEvaluationId)
      .query(`SELECT id, applicant_lrn, student_id, school_year, target_grade_level, status, version, curriculum_review_status
        FROM readmission_evaluations WHERE id = @evaluationId FOR UPDATE`);
    const evaluation = result.recordset?.[0];
    if (!evaluation || evaluation.status !== 'accepted' || evaluation.curriculum_review_status !== 'resolved'
      || Number(evaluation.version) !== record.readmissionEvaluationVersion
      || evaluation.applicant_lrn !== record.lrn || evaluation.school_year !== record.schoolYear
      || evaluation.target_grade_level !== record.targetGradeLevel) {
      throw new PreEnrollmentError('The linked return evaluation is not accepted for this LRN, school year, grade, and revision.', 409);
    }
    return evaluation;
  }

  async function validateApplicantHistory(transaction, record, evaluation) {
    if (!/^\d{12}$/.test(String(record.lrn || ''))) return;
    const matches = await transaction.request().input('lrn', sql.Char(12), record.lrn)
      .query('SELECT id FROM students WHERE lrn = @lrn FOR UPDATE');
    const students = matches.recordset || [];
    if (students.length > 1) throw new PreEnrollmentError('More than one existing student record matches this LRN. Resolve the records before continuing.', 409);
    const studentId = students.length ? Number(students[0].id) : null;
    if (!studentId) {
      if (record.applicantKind === 'continuing') throw new PreEnrollmentError('An existing student record is required for continuous progression.', 409);
      if (record.applicantKind === 'readmission' && Number(evaluation?.student_id || 0)) {
        throw new PreEnrollmentError('The accepted evaluation is linked to a different existing student record.', 409);
      }
      return;
    }

    const sameYear = await transaction.request().input('studentId', sql.Int, studentId)
      .input('schoolYear', sql.NVarChar(20), record.schoolYear)
      .query('SELECT id FROM annual_enrollments WHERE student_id = @studentId AND school_year = @schoolYear FOR UPDATE');
    if (sameYear.recordset?.length) {
      throw new PreEnrollmentError('This student already has an annual record for that school year. Same-year reactivation is not available in the paper intake workflow.', 409);
    }

    const history = await transaction.request().input('studentId', sql.Int, studentId)
      .input('schoolYear', sql.NVarChar(20), record.schoolYear)
      .query(`SELECT annual.school_year, annual.intake_status,
          EXISTS(SELECT 1 FROM finance_departure_cases AS departure
            WHERE departure.annual_enrollment_id = annual.id) AS has_departure
        FROM annual_enrollments AS annual
        WHERE annual.student_id = @studentId AND annual.school_year < @schoolYear
        ORDER BY annual.school_year DESC, annual.id DESC FOR UPDATE`);
    const year = Number(record.schoolYear.slice(0, 4));
    const latest = history.recordset?.[0] || null;
    const continuous = Boolean(latest && latest.school_year === `${year - 1}-${year}`
      && ['enrolled', 'legacy'].includes(latest.intake_status)
      && !(latest.has_departure === true || latest.has_departure === 1));
    if (continuous) {
      if (record.applicantKind !== 'continuing' || record.readmissionEvaluationId) {
        throw new PreEnrollmentError('Previous-year participation shows continuous progression. Use Continuing and remove any return evaluation.', 409);
      }
      return;
    }
    if (record.applicantKind !== 'readmission' || !evaluation || Number(evaluation.student_id || 0) !== studentId) {
      throw new PreEnrollmentError('This applicant needs an accepted return evaluation before a paper record can proceed.', 409);
    }
  }

  function bindRecordFields(request, record) {
    for (const [column, name, length] of FIELD_SPEC) {
      const type = column.endsWith('_date') ? sql.Date : sql.NVarChar(length);
      request.input(name, type, record[name]);
    }
    return request;
  }

  async function writeRevisions(transaction, recordId, actorId, before, after, beforeReceipts, afterReceipts) {
    const updates = [];
    for (const [column, name] of FIELD_SPEC) {
      const oldValue = before ? before[column] ?? null : null;
      const nextValue = after[name] ?? null;
      if (String(oldValue ?? '') !== String(nextValue ?? '')) updates.push([column, oldValue, nextValue]);
    }
    if (before && Boolean(before.student_signature_present) !== after.studentSignaturePresent) {
      updates.push(['student_signature_present', Boolean(before.student_signature_present), after.studentSignaturePresent]);
    }
    if (before && String(before.readmission_evaluation_id || '') !== String(after.readmissionEvaluationId || '')) {
      updates.push(['readmission_evaluation_id', before.readmission_evaluation_id || null, after.readmissionEvaluationId || null]);
    }
    if (before && Number(before.readmission_evaluation_version || 0) !== Number(after.readmissionEvaluationVersion || 0)) {
      updates.push(['readmission_evaluation_version', before.readmission_evaluation_version || null, after.readmissionEvaluationVersion || null]);
    }
    const priorReceiptsByCode = new Map((beforeReceipts || []).map((receipt) => [receipt.requirement_code, receipt]));
    for (let index = 0; index < after.receipts.length; index += 1) {
      const next = after.receipts[index];
      const prior = priorReceiptsByCode.get(next.requirementCode) || {};
      for (const [key, name] of [['originalReceived', 'original_received'], ['originalPieces', 'original_pieces'],
        ['photocopyReceived', 'photocopy_received'], ['photocopyPieces', 'photocopy_pieces']]) {
        const oldValue = name.endsWith('_received') && prior[name] !== undefined
          ? Boolean(prior[name]) : prior[name] ?? null;
        const nextValue = next[key] ?? null;
        if (String(oldValue ?? '') !== String(nextValue ?? '')) updates.push([`receipt_${next.requirementCode}_${name}`, oldValue, nextValue]);
      }
    }
    if (!updates.length) return [];
    const group = crypto.randomUUID();
    for (const [fieldName, beforeValue, afterValue] of updates) {
      await transaction.request().input('revisionRecordId', sql.Char(36), recordId)
        .input('revisionGroup', sql.Char(36), group).input('revisionActorId', sql.Int, actorId)
        .input('fieldName', sql.VarChar(80), fieldName)
        .input('beforeValue', sql.NVarChar(sql.MAX), beforeValue === null ? null : String(beforeValue))
        .input('afterValue', sql.NVarChar(sql.MAX), afterValue === null ? null : String(afterValue))
        .query(`INSERT INTO pre_enrollment_revisions
          (pre_enrollment_id, revision_group, actor_id, field_name, before_value, after_value)
          VALUES (@revisionRecordId, @revisionGroup, @revisionActorId, @fieldName, @beforeValue, @afterValue)`);
    }
    return updates.map(([field]) => field);
  }

  async function saveReceipts(transaction, recordId, receipts) {
    for (const receipt of receipts) {
      await transaction.request().input('receiptRecordId', sql.Char(36), recordId)
        .input('requirementCode', sql.VarChar(40), receipt.requirementCode)
        .input('originalReceived', sql.Bit, receipt.originalReceived)
        .input('originalPieces', sql.SmallInt, receipt.originalPieces)
        .input('photocopyReceived', sql.Bit, receipt.photocopyReceived)
        .input('photocopyPieces', sql.SmallInt, receipt.photocopyPieces)
        .query(`INSERT INTO pre_enrollment_receipts
          (pre_enrollment_id, requirement_code, original_received, original_pieces, photocopy_received, photocopy_pieces)
          VALUES (@receiptRecordId, @requirementCode, @originalReceived, @originalPieces, @photocopyReceived, @photocopyPieces)
          ON DUPLICATE KEY UPDATE original_received = VALUES(original_received), original_pieces = VALUES(original_pieces),
            photocopy_received = VALUES(photocopy_received), photocopy_pieces = VALUES(photocopy_pieces), updated_at = UTC_TIMESTAMP(3)`);
    }
  }

  async function create(actorInput, input = {}) {
    const record = normalizeRecord(input);
    const actorId = normalizeActorId(actorInput);
    const idempotencyKey = normalizeUuid(input.idempotencyKey, 'pre-enrollment submission');
    const recordFingerprint = fingerprint(record);
    try {
      return await runTransaction(async (transaction) => {
        const actor = await requireActor(transaction.request(), actorId, CREATE_ROLES);
        const prior = await transaction.request().input('idempotencyKey', sql.Char(36), idempotencyKey)
          .query(`SELECT id, request_fingerprint FROM pre_enrollments WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
        if (prior.recordset?.[0]) {
          if (prior.recordset[0].request_fingerprint !== recordFingerprint) throw new PreEnrollmentError('This submission token was already used for different paper details.', 409);
          return { id: prior.recordset[0].id, alreadyCreated: true };
        }
        const evaluation = await lockReadmissionEvaluation(transaction, record);
        await validateApplicantHistory(transaction, record, evaluation);
        record.receivedBy ||= actor.displayName.slice(0, 100) || null;
        record.receivedDate ||= manilaDate();
        const recordId = crypto.randomUUID();
        const columns = FIELD_SPEC.map(([column]) => column).join(', ');
        const values = FIELD_SPEC.map(([, name]) => `@${name}`).join(', ');
        const request = transaction.request().input('recordId', sql.Char(36), recordId)
          .input('idempotencyKey', sql.Char(36), idempotencyKey).input('fingerprint', sql.Char(64), recordFingerprint)
          .input('status', sql.VarChar(30), record.status).input('signaturePresent', sql.Bit, record.studentSignaturePresent)
          .input('actorId', sql.Int, actor.id).input('readmissionEvaluationId', sql.Char(36), record.readmissionEvaluationId)
          .input('readmissionEvaluationVersion', sql.Int, record.readmissionEvaluationVersion);
        bindRecordFields(request, record);
        const inserted = await request.query(`INSERT INTO pre_enrollments
          (id, idempotency_key, request_fingerprint, ${columns}, student_signature_present, readmission_evaluation_id,
            readmission_evaluation_version, status, created_by, created_by_role, updated_by)
          VALUES (@recordId, @idempotencyKey, @fingerprint, ${values}, @signaturePresent, @readmissionEvaluationId,
            @readmissionEvaluationVersion, @status, @actorId, 'front_desk', @actorId)`);
        void inserted;
        await saveReceipts(transaction, recordId, record.receipts);
        const changedFields = await writeRevisions(transaction, recordId, actor.id, null, record, null, null);
        await writeEvent(transaction.request(), {
          recordId, actorId: actor.id, eventType: record.status === 'ready_for_registrar' ? 'submitted_ready' : 'created',
          version: 1, fromStatus: null, toStatus: record.status, changedFields
        });
        await transaction.request().input('auditActor', sql.Int, actor.id).input('auditEntityId', sql.NVarChar(100), recordId)
          .input('auditAction', sql.NVarChar(100), record.status === 'ready_for_registrar' ? 'pre_enrollment.submitted_ready' : 'pre_enrollment.created')
          .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
            VALUES (@auditActor, @auditAction, 'pre_enrollment', @auditEntityId, JSON_OBJECT('version', 1))`);
        return { id: recordId, alreadyCreated: false };
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const pool = await getPool();
        const prior = await pool.request().input('idempotencyKey', sql.Char(36), idempotencyKey)
          .query('SELECT id, request_fingerprint FROM pre_enrollments WHERE idempotency_key = @idempotencyKey');
        if (prior.recordset?.[0]) {
          if (prior.recordset[0].request_fingerprint !== recordFingerprint) throw new PreEnrollmentError('This submission token was already used for different paper details.', 409);
          return { id: prior.recordset[0].id, alreadyCreated: true };
        }
        throw new PreEnrollmentError('A pre-enrollment record with this school year and complete LRN already exists.', 409);
      }
      throw error;
    }
  }

  async function getRecord(request, recordId, forUpdate = false) {
    const result = await request.input('recordId', sql.Char(36), recordId)
      .query(`SELECT entry.*, creator.first_name AS creator_first_name, creator.last_name AS creator_last_name,
          updater.first_name AS updater_first_name, updater.last_name AS updater_last_name
        FROM pre_enrollments AS entry
        LEFT JOIN staff_profiles AS creator ON creator.user_id = entry.created_by
        LEFT JOIN staff_profiles AS updater ON updater.user_id = entry.updated_by
        WHERE entry.id = @recordId${forUpdate ? ' FOR UPDATE' : ''}`);
    return result.recordset?.[0] || null;
  }

  async function loadDetail(pool, id) {
    const record = await getRecord(pool.request(), id);
    if (!record) throw new PreEnrollmentError('Pre-enrollment record not found.', 404);
    const [receiptRows, events, revisions, evaluationResult] = await Promise.all([
      pool.request().input('recordId', sql.Char(36), id).query(`SELECT requirement_code, original_received, original_pieces,
        photocopy_received, photocopy_pieces FROM pre_enrollment_receipts WHERE pre_enrollment_id = @recordId ORDER BY requirement_code`),
      pool.request().input('recordId', sql.Char(36), id).query(`SELECT event.id, event.event_type, event.version,
        event.from_status, event.to_status, event.details_json, event.created_at, event.actor_id,
        staff.first_name, staff.last_name FROM pre_enrollment_events AS event
        INNER JOIN users AS actor ON actor.id = event.actor_id
        LEFT JOIN staff_profiles AS staff ON staff.user_id = actor.id
        WHERE event.pre_enrollment_id = @recordId ORDER BY event.created_at DESC, event.id DESC`),
      pool.request().input('recordId', sql.Char(36), id).query(`SELECT revision.id, revision.revision_group, revision.field_name,
        revision.before_value, revision.after_value, revision.created_at, revision.actor_id,
        staff.first_name, staff.last_name FROM pre_enrollment_revisions AS revision
        INNER JOIN users AS actor ON actor.id = revision.actor_id
        LEFT JOIN staff_profiles AS staff ON staff.user_id = actor.id
        WHERE revision.pre_enrollment_id = @recordId ORDER BY revision.created_at DESC, revision.id DESC`),
      record.readmission_evaluation_id
        ? pool.request().input('evaluationId', sql.Char(36), record.readmission_evaluation_id).query(`SELECT student_id, status, version,
            school_year, target_grade_level, applicant_lrn
          FROM readmission_evaluations WHERE id = @evaluationId`)
        : Promise.resolve({ recordset: [] })
    ]);
    return { ...record, readmission_evaluation: evaluationResult.recordset?.[0] || null,
      receipts: receiptRows.recordset || [], events: events.recordset || [], revisions: revisions.recordset || [] };
  }

  async function get(actorInput, recordIdInput) {
    const actorId = normalizeActorId(actorInput);
    const recordId = normalizeUuid(recordIdInput, 'pre-enrollment record');
    const pool = await getPool();
    const actor = await requireActor(pool.request(), actorId, READ_ROLES);
    const record = await loadDetail(pool, recordId);
    if (READ_ROLES.has(actor.role) && record.status === 'enrollment_started') {
      const linkedResult = await pool.request().input('recordId', sql.Char(36), recordId)
        .query(`SELECT id, intake_status, school_year, grade_level
          FROM annual_enrollments WHERE pre_enrollment_id = @recordId LIMIT 2`);
      const linkedRows = linkedResult.recordset || [];
      record.linkedAnnualEnrollment = linkedRows.length === 1 ? linkedRows[0] : null;
      record.linkedAnnualEnrollmentAmbiguous = linkedRows.length > 1;
    }
    return record;
  }

  async function getActorDisplayName(actorInput) {
    const actorId = normalizeActorId(actorInput);
    const pool = await getPool();
    const actor = await requireActor(pool.request(), actorId, EDIT_ROLES);
    return actor.displayName || '';
  }

  async function list(actorInput, filters = {}) {
    const actorId = normalizeActorId(actorInput);
    const search = printable(filters.search || '', 'Search', 100) || '';
    const schoolYear = printable(filters.schoolYear || '', 'School year', 20) || '';
    const status = filters.status || '';
    if (status && !['draft', 'ready_for_registrar', 'enrollment_started'].includes(status)) throw new PreEnrollmentError('Choose a valid pre-enrollment status.');
    const page = normalizePage(filters.page);
    const pool = await getPool();
    await requireActor(pool.request(), actorId, READ_ROLES);
    const where = `WHERE (@search = '' OR CONCAT_WS(' ', entry.first_name, entry.middle_name, entry.last_name, entry.suffix) LIKE @searchPattern ESCAPE '~'
        OR entry.lrn LIKE @searchPattern ESCAPE '~') AND (@schoolYear = '' OR entry.school_year = @schoolYear)
        AND (@status = '' OR entry.status = @status)`;
    const params = (request) => request.input('search', sql.NVarChar(100), search)
      .input('searchPattern', sql.NVarChar(210), `%${escapeLike(search)}%`)
      .input('schoolYear', sql.NVarChar(20), schoolYear).input('status', sql.VarChar(30), status);
    const totalResult = await params(pool.request()).query(`SELECT COUNT(*) AS total FROM pre_enrollments AS entry ${where}`);
    const totalRecords = Number(totalResult.recordset?.[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    // The recorder_* result aliases below identify entry.updated_by: the last editor, not the original creator.
    const rows = await params(pool.request()).input('pageSize', sql.Int, PAGE_SIZE)
      .input('offset', sql.Int, (safePage - 1) * PAGE_SIZE)
      .query(`SELECT entry.id, entry.school_year, entry.first_name, entry.middle_name, entry.last_name,
          entry.suffix, entry.lrn, entry.status, entry.version, entry.updated_at,
          annual.intake_status AS linked_annual_status,
          staff.first_name AS recorder_first_name, staff.last_name AS recorder_last_name
        FROM pre_enrollments AS entry
        LEFT JOIN annual_enrollments AS annual ON annual.pre_enrollment_id = entry.id
        LEFT JOIN staff_profiles AS staff ON staff.user_id = entry.updated_by
        ${where} ORDER BY entry.updated_at DESC, entry.id DESC LIMIT @pageSize OFFSET @offset`);
    return { rows: rows.recordset || [], filters: { search, schoolYear, status }, pagination: {
      page: safePage, pageSize: PAGE_SIZE, totalRecords, totalPages,
      from: totalRecords ? ((safePage - 1) * PAGE_SIZE) + 1 : 0, to: Math.min(safePage * PAGE_SIZE, totalRecords)
    } };
  }

  async function listAcceptedReadmissionChoices(actorInput, schoolYearInput = '') {
    const actorId = normalizeActorId(actorInput);
    const schoolYear = printable(schoolYearInput || '', 'School year', 20) || '';
    const pool = await getPool();
    await requireActor(pool.request(), actorId, READ_ACCEPTED_EVALUATION_ROLES);
    const result = await pool.request().input('schoolYear', sql.NVarChar(20), schoolYear)
      .query(`SELECT id, applicant_lrn, first_name, middle_name, last_name, suffix, school_year,
          target_grade_level, version, student_id
        FROM readmission_evaluations
        WHERE status = 'accepted' AND subject_availability = 'available' AND curriculum_review_status = 'resolved'
          AND (@schoolYear = '' OR school_year = @schoolYear)
        ORDER BY school_year DESC, last_name, first_name, id`);
    return result.recordset || [];
  }

  async function update(actorInput, recordIdInput, expectedVersionInput, input = {}) {
    const actorId = normalizeActorId(actorInput);
    const recordId = normalizeUuid(recordIdInput, 'pre-enrollment record');
    const expectedVersion = Number(expectedVersionInput);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new PreEnrollmentError('Reload this pre-enrollment form before saving.', 409);
    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorId, EDIT_ROLES);
      const current = await getRecord(transaction.request(), recordId);
      if (!current) throw new PreEnrollmentError('Pre-enrollment record not found.', 404);
      if (current.status === 'enrollment_started') throw new PreEnrollmentError('This record is read-only because annual enrollment has started.', 409);
      if (Number(current.version) !== expectedVersion) throw new PreEnrollmentError('This record changed after the form was opened. Reload and review the latest version.', 409);
      const record = normalizeRecord(input, { current });
      const evaluation = await lockReadmissionEvaluation(transaction, record);
      await validateApplicantHistory(transaction, record, evaluation);
      record.receivedBy ||= current.received_by || actor.displayName.slice(0, 100) || null;
      record.receivedDate ||= current.received_date || manilaDate();
      const beforeReceiptsResult = await transaction.request().input('recordId', sql.Char(36), recordId)
        .query('SELECT * FROM pre_enrollment_receipts WHERE pre_enrollment_id = @recordId ORDER BY requirement_code');
      const beforeReceipts = beforeReceiptsResult.recordset || [];
      const nextVersion = expectedVersion + 1;
      const request = transaction.request().input('recordId', sql.Char(36), recordId)
        .input('expectedVersion', sql.Int, expectedVersion).input('nextVersion', sql.Int, nextVersion)
        .input('actorId', sql.Int, actor.id).input('status', sql.VarChar(30), record.status)
        .input('signaturePresent', sql.Bit, record.studentSignaturePresent)
        .input('readmissionEvaluationId', sql.Char(36), record.readmissionEvaluationId)
        .input('readmissionEvaluationVersion', sql.Int, record.readmissionEvaluationVersion);
      bindRecordFields(request, record);
      const changed = await request.query(`UPDATE pre_enrollments SET ${FIELD_SPEC.map(([column, name]) => `${column} = @${name}`).join(', ')},
          student_signature_present = @signaturePresent, readmission_evaluation_id = @readmissionEvaluationId,
          readmission_evaluation_version = @readmissionEvaluationVersion, status = @status, version = @nextVersion,
          updated_by = @actorId, updated_at = UTC_TIMESTAMP(3)
        WHERE id = @recordId AND version = @expectedVersion AND status <> 'enrollment_started'`);
      if (changed.rowsAffected?.[0] !== 1) throw new PreEnrollmentError('This record changed or was opened for enrollment. Reload before saving.', 409);
      await saveReceipts(transaction, recordId, record.receipts);
      const receiptChangedFields = await writeRevisions(transaction, recordId, actor.id, current, record, beforeReceipts, record.receipts);
      const changedFields = [...new Set(receiptChangedFields)];
      await writeEvent(transaction.request(), {
        recordId, actorId: actor.id, eventType: record.status === 'ready_for_registrar' && current.status !== record.status ? 'submitted_ready' : 'updated',
        version: nextVersion, fromStatus: current.status, toStatus: record.status, changedFields
      });
      await transaction.request().input('auditActor', sql.Int, actor.id).input('auditEntityId', sql.NVarChar(100), recordId)
        .input('auditAction', sql.NVarChar(100), record.status === 'ready_for_registrar' && current.status !== record.status ? 'pre_enrollment.submitted_ready' : 'pre_enrollment.updated')
        .input('auditDetails', sql.NVarChar(sql.MAX), JSON.stringify({ version: nextVersion, changedFields }))
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@auditActor, @auditAction, 'pre_enrollment', @auditEntityId, @auditDetails)`);
      return { id: recordId, version: nextVersion, status: record.status };
    });
  }

  async function openConversion(actorInput, recordIdInput) {
    const actorId = normalizeActorId(actorInput);
    const recordId = normalizeUuid(recordIdInput, 'pre-enrollment record');
    const pool = await getPool();
    await requireActor(pool.request(), actorId, new Set(['registrar']));
    const current = await getRecord(pool.request(), recordId);
    if (!current) throw new PreEnrollmentError('Pre-enrollment record not found.', 404);
    if (current.status === 'enrollment_started') {
      const annual = await pool.request().input('recordId', sql.Char(36), recordId)
        .query('SELECT id FROM annual_enrollments WHERE pre_enrollment_id = @recordId LIMIT 1');
      return { alreadyStarted: true, annualEnrollmentId: annual.recordset?.[0]?.id || null };
    }
    if (current.status !== 'ready_for_registrar') throw new PreEnrollmentError('Only a ready pre-enrollment record can start annual enrollment.', 409);
    return { alreadyStarted: false, record: await conversionRecord(pool, recordId) };
  }

  async function conversionRecord(pool, recordId) {
    const record = await loadDetail(pool, recordId);
    if (!/^\d{12}$/.test(String(record.lrn || ''))) throw new PreEnrollmentError('A complete 12-digit LRN is required before enrollment can start.', 409);
    if (!record.email) throw new PreEnrollmentError('A valid email must be saved to the front-desk record before enrollment can start.', 409);
    const matches = await pool.request().input('lrn', sql.Char(12), record.lrn)
      .query(`SELECT student.*, account.email FROM students AS student
        LEFT JOIN users AS account ON account.id = student.user_id WHERE student.lrn = @lrn`);
    if ((matches.recordset || []).length > 1) throw new PreEnrollmentError('More than one existing student record matches this LRN. Resolve the records before conversion.', 409);
    const existingStudent = matches.recordset?.[0] || null;
    return { ...record, existingStudent: existingStudent ? {
      id: Number(existingStudent.id), studentNo: existingStudent.student_no,
      profileReviewFingerprint: profileReviewFingerprint(existingStudent),
      profile: existingStudent
    } : null };
  }

  async function getForConversion(actorInput, recordIdInput) {
    const actorId = normalizeActorId(actorInput);
    const recordId = normalizeUuid(recordIdInput, 'pre-enrollment record');
    const pool = await getPool();
    const actor = await requireActor(pool.request(), actorId, new Set(['registrar']));
    const record = await conversionRecord(pool, recordId);
    if (record.status !== 'ready_for_registrar') throw new PreEnrollmentError('Only a ready pre-enrollment record can start annual enrollment.', 409);
    return record;
  }

  return { create, update, get, getActorDisplayName, list, listAcceptedReadmissionChoices, openConversion, getForConversion, RECEIPT_REQUIREMENTS };
}

module.exports = { PreEnrollmentError, RECEIPT_REQUIREMENTS, normalizeRecord, createPreEnrollmentService };
