const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');
const { allocateStudentNumber, StudentNumberAllocationError } = require('./studentNumberAllocator');
const { ADDRESS_DEFINITIONS, StudentAddressError, normalizeStructuredAddress } = require('../utils/studentAddress');

const RECORDS_ROLES = new Set(['database_admin', 'registrar']);
const STUDENT_PAGE_SIZE = 25;
const PROFILE_REVISION_FIELDS = [
  ['student_no', 'studentNo'], ['lrn', 'lrn'], ['first_name', 'firstName'], ['middle_name', 'middleName'],
  ['last_name', 'lastName'], ['suffix', 'suffix'], ['birth_date', 'birthDate'], ['sex', 'sex'],
  ['address', 'address'], ['phone', 'phone'], ['birthplace', 'birthplace'], ['facebook_name', 'facebookName'],
  ['emergency_contact_person', 'emergencyContactPerson'], ['emergency_contact_relationship', 'emergencyContactRelationship'],
  ['emergency_contact_phone', 'emergencyContactPhone'], ['emergency_contact_address', 'emergencyContactAddress'],
  ['address_block_lot_street_purok', 'addressBlockLotStreetPurok'], ['address_barangay', 'addressBarangay'],
  ['address_city', 'addressCity'], ['address_province', 'addressProvince'], ['address_zip', 'addressZip'],
  ['emergency_contact_address_block_lot_street_purok', 'emergencyContactAddressBlockLotStreetPurok'],
  ['emergency_contact_address_barangay', 'emergencyContactAddressBarangay'], ['emergency_contact_address_city', 'emergencyContactAddressCity'],
  ['emergency_contact_address_province', 'emergencyContactAddressProvince'], ['emergency_contact_address_zip', 'emergencyContactAddressZip'],
  ['mother_name', 'motherName'], ['mother_phone', 'motherPhone'], ['father_name', 'fatherName'], ['father_phone', 'fatherPhone']
];

class StudentRecordsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'StudentRecordsError';
    this.status = status;
  }
}

function normalizeRecordId(value, label = 'record') {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) return null;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) return null;
  return id;
}

function printableText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function requiredText(value, label, maxLength) {
  const text = printableText(value, maxLength);
  if (!text) throw new StudentRecordsError(`${label} is required and must be ${maxLength} characters or fewer.`);
  return text;
}

const NAME_PATTERN = /^\p{L}[\p{L}\p{M}]*(?:[.\x2d'’][\p{L}\p{M}]+)*\.?(?:\s+\p{L}[\p{L}\p{M}]*(?:[.\x2d'’][\p{L}\p{M}]+)*\.?)*$/u;

function validateName(value, label, { required = false, maxLength = 100 } = {}) {
  if (value !== undefined && value !== null && value !== '' && typeof value !== 'string') {
    throw new StudentRecordsError(`${label} must contain letters; spaces, hyphens, apostrophes, and initials are allowed.`);
  }
  const text = printableText(value, maxLength);
  if (text === null) {
    throw new StudentRecordsError(required
      ? `${label} is required and must be ${maxLength} printable characters or fewer.`
      : `${label} must be ${maxLength} printable characters or fewer.`);
  }
  if (!text) {
    if (required) throw new StudentRecordsError(`${label} is required and must contain letters.`);
    return null;
  }
  if (!NAME_PATTERN.test(text)) {
    throw new StudentRecordsError(`${label} must contain letters; spaces, hyphens, apostrophes, and initials are allowed.`);
  }
  return text;
}

function currentManilaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function latestBirthDate() {
  const date = new Date(`${currentManilaDate()}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function normalizeAddress(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new StudentRecordsError('Address must be text and include at least one letter.');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length > 500) throw new StudentRecordsError('Address must be 500 characters or fewer.');
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) throw new StudentRecordsError('Address cannot contain control characters.');
  if (text && !/\p{L}/u.test(text)) throw new StudentRecordsError('Address must include at least one letter.');
  return text;
}

function normalizePhone(value, label) {
  if (value !== undefined && value !== null && value !== '' && typeof value !== 'string') {
    throw new StudentRecordsError(`${label} must contain 7 to 15 digits in a valid phone format.`);
  }
  const text = printableText(value, 50);
  if (text === null) throw new StudentRecordsError(`${label} must be 50 printable characters or fewer.`);
  if (!text) return null;
  if (!/^[+0-9() \x2d]+$/.test(text) || text.indexOf('+', 1) !== -1) {
    throw new StudentRecordsError(`${label} must use digits and may include a leading +, spaces, hyphens, or parentheses.`);
  }
  const digits = text.replace(/\D/g, '');
  const visible = text.replace(/^\+/, '').trim();
  if (digits.length < 7 || digits.length > 15 || !/^[0-9(]/.test(visible) || !/[0-9)]$/.test(visible)) {
    throw new StudentRecordsError(`${label} must contain 7 to 15 digits in a valid phone format.`);
  }
  let depth = 0;
  let parenthesisHasDigit = false;
  for (const character of text) {
    if (character === '(') {
      if (depth !== 0) throw new StudentRecordsError(`${label} must use balanced parentheses.`);
      depth = 1;
      parenthesisHasDigit = false;
    } else if (character === ')') {
      if (depth !== 1 || !parenthesisHasDigit) throw new StudentRecordsError(`${label} must use balanced parentheses.`);
      depth = 0;
    } else if (depth === 1 && /[0-9]/.test(character)) {
      parenthesisHasDigit = true;
    }
  }
  if (depth !== 0) throw new StudentRecordsError(`${label} must use balanced parentheses.`);
  return text;
}

function normalizeGender(value, { allowLegacyUnspecified = false } = {}) {
  if (value !== undefined && value !== null && value !== '' && typeof value !== 'string') {
    throw new StudentRecordsError('Choose Male, Female, or Other for gender.');
  }
  const text = printableText(value, 20);
  if (text === null) throw new StudentRecordsError('Gender must be 20 printable characters or fewer.');
  if (!text) return null;
  const canonical = new Map([['male', 'Male'], ['female', 'Female'], ['other', 'Other']]);
  const normalized = canonical.get(text.toLocaleLowerCase());
  if (normalized) return normalized;
  if (allowLegacyUnspecified && text === 'unspecified') return text;
  throw new StudentRecordsError('Choose Male, Female, or Other for gender.');
}

function normalizeOptionalId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const id = normalizeRecordId(value, label);
  if (!id) throw new StudentRecordsError(`Choose a valid ${label.toLowerCase()}.`);
  return id;
}

function normalizeSearchTerm(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new StudentRecordsError('Search must be 100 printable characters or fewer.');
  const searchTerm = value.trim();
  if (searchTerm.length > 100 || /[\u0000-\u001f\u007f]/.test(searchTerm)) {
    throw new StudentRecordsError('Search must be 100 printable characters or fewer.');
  }
  return searchTerm;
}

function escapeLikePattern(value) {
  return value.replace(/[~%_[\]]/g, (character) => `~${character}`);
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new StudentRecordsError('Enter a valid birth date.');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new StudentRecordsError('Enter a valid birth date.');
  }
  if (value >= currentManilaDate()) throw new StudentRecordsError('Birth date must be before today.');
  return value;
}

function normalizeLrn(value, { required = true } = {}) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  const lrn = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{12}$/.test(lrn)) {
    throw new StudentRecordsError('LRN must contain exactly 12 digits.');
  }
  return lrn;
}

function validateStudent(input = {}, { requireLrn = true, requireStudentNo = true, allowLegacyUnspecifiedSex = false } = {}) {
  const studentNo = requireStudentNo ? requiredText(input.studentNo, 'Student number', 50) : null;
  const firstName = validateName(input.firstName, 'First name', { required: true });
  const lastName = validateName(input.lastName, 'Last name', { required: true });
  const middleName = validateName(input.middleName, 'Middle name');
  const suffix = validateName(input.suffix, 'Suffix', { maxLength: 20 });
  const sex = normalizeGender(input.sex, { allowLegacyUnspecified: allowLegacyUnspecifiedSex });
  const address = normalizeAddress(input.address);
  const phone = normalizePhone(input.phone, 'Phone');
  const birthplace = printableText(input.birthplace, 160);
  const facebookName = printableText(input.facebookName, 120);
  const emergencyContactPerson = printableText(input.emergencyContactPerson, 160);
  const emergencyContactRelationship = printableText(input.emergencyContactRelationship, 80);
  const emergencyContactPhone = normalizePhone(input.emergencyContactPhone, 'Emergency contact phone');
  const emergencyContactAddress = normalizeAddress(input.emergencyContactAddress);
  const motherName = printableText(input.motherName, 160);
  const motherPhone = normalizePhone(input.motherPhone, 'Mother’s phone');
  const fatherName = printableText(input.fatherName, 160);
  const fatherPhone = normalizePhone(input.fatherPhone, 'Father’s phone');
  if ([address, birthplace, facebookName, emergencyContactPerson, emergencyContactRelationship,
    emergencyContactAddress, motherName, fatherName].includes(null)) {
    throw new StudentRecordsError('Check that each optional profile field is within its allowed length and contains no control characters.');
  }
  return {
    studentNo,
    lrn: normalizeLrn(input.lrn, { required: requireLrn }),
    firstName,
    middleName,
    lastName,
    suffix,
    birthDate: normalizeDate(input.birthDate),
    sex,
    address: address || null,
    phone,
    birthplace: birthplace || null,
    facebookName: facebookName || null,
    emergencyContactPerson: emergencyContactPerson || null,
    emergencyContactRelationship: emergencyContactRelationship || null,
    emergencyContactPhone,
    emergencyContactAddress: emergencyContactAddress || null,
    motherName: motherName || null,
    motherPhone,
    fatherName: fatherName || null,
    fatherPhone
  };
}

function normalizeBoolean(value, label) {
  if (value === true || value === '1' || value === 'true') return true;
  if (value === false || value === '0' || value === 'false' || value === undefined) return false;
  throw new StudentRecordsError(`Choose whether this ${label} is current.`);
}

function validateTerm(input = {}) {
  return {
    schoolYear: requiredText(input.schoolYear, 'School year', 20),
    term: requiredText(input.term, 'Term', 30),
    isCurrent: normalizeBoolean(input.isCurrent, 'term')
  };
}

function validateSection(input = {}) {
  const name = requiredText(input.name, 'Section name', 100);
  const gradeLevel = printableText(input.gradeLevel, 50);
  if (gradeLevel === null) throw new StudentRecordsError('Grade level must be 50 characters or fewer.');
  const academicTermId = normalizeOptionalId(input.academicTermId, 'academic term');
  if (!academicTermId) throw new StudentRecordsError('Choose an academic term.');
  const cluster = printableText(input.cluster, 80);
  const strand = printableText(input.strand, 80);
  const adviser = printableText(input.adviser, 160);
  const modality = printableText(input.modality, 30);
  const modularSubtype = printableText(input.modularSubtype, 80);
  if ([cluster, strand, adviser, modality, modularSubtype].includes(null)) {
    throw new StudentRecordsError('Check that each section detail is within its allowed length.');
  }
  if (modality && !['face-to-face', 'distance', 'modular', 'hybrid'].includes(modality)) {
    throw new StudentRecordsError('Choose a supported section modality.');
  }
  if (modality !== 'modular' && modularSubtype) throw new StudentRecordsError('A modular subtype can only be entered for modular sections.');
  return {
    name, gradeLevel: gradeLevel || null, academicTermId,
    cluster: cluster || null, strand: strand || null, adviser: adviser || null,
    modality: modality || null, modularSubtype: modularSubtype || null
  };
}

function validateEnrollment(input = {}) {
  const studentId = normalizeOptionalId(input.studentId, 'student');
  const academicTermId = normalizeOptionalId(input.academicTermId, 'academic term');
  const sectionId = normalizeOptionalId(input.sectionId, 'section');
  if (!studentId || !academicTermId) throw new StudentRecordsError('Choose a student and academic term.');
  return { studentId, academicTermId, sectionId };
}

function normalizeUniqueConflict(error) {
  return isDuplicateKeyError(error);
}

function applyAddressInput(student, input, prefix, current = null) {
  const modeKey = prefix === 'address' ? 'addressMode' : 'emergencyContactAddressMode';
  const mode = input[modeKey] || (current ? 'preserve' : 'replace');
  if (!['preserve', 'replace'].includes(mode)) throw new StudentRecordsError('Choose whether to keep or replace the saved address.');
  const legacyColumn = prefix === 'address' ? 'address' : 'emergency_contact_address';
  const fields = ADDRESS_DEFINITIONS[prefix];
  if (current && mode === 'preserve') {
    student[prefix] = current[legacyColumn] ?? null;
    for (const [inputName, column] of fields) student[inputName] = current[column] ?? null;
    return;
  }
  if (!current && mode === 'preserve') throw new StudentRecordsError('A new student address must be entered as components.');
  const componentNames = fields.map(([inputName]) => inputName);
  if (!current && mode === 'replace' && componentNames.every((inputName) => input[inputName] === undefined)
    && typeof input[prefix] === 'string') {
    // Preserve legacy callers' free text; never attempt to infer components from it.
    return;
  }
  try {
    const normalized = normalizeStructuredAddress(input, prefix);
    student[prefix] = normalized.formatted;
    for (const [inputName, column] of fields) student[inputName] = normalized[column];
  } catch (error) {
    if (error instanceof StudentAddressError) throw new StudentRecordsError(error.message);
    throw error;
  }
}

function createStudentRecordsService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool)
} = {}) {
  async function runTransaction(callback) {
    const pool = await getPool();
    const transaction = transactionFactory(pool);
    let started = false;
    try {
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      const result = await callback(transaction);
      await transaction.commit();
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try {
          await transaction.rollback();
        } catch {
          // Keep the original failure for the route to handle without exposing SQL details.
        }
      }
      throw error;
    }
  }

  async function requireAcademicActor(transaction, actorId) {
    const result = await transaction.request()
      .input('actorId', sql.Int, actorId)
      .input('databaseAdminRole', sql.NVarChar(30), 'database_admin')
      .input('registrarRole', sql.NVarChar(30), 'registrar')
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN (@databaseAdminRole, @registrarRole) FOR UPDATE`);
    const actor = result.recordset?.[0];
    if (!actor || !RECORDS_ROLES.has(actor.role)) {
      throw new StudentRecordsError('Your academic records access is no longer active. Sign in again.', 403);
    }
    return actor;
  }

  async function writeAudit(transaction, { actorId, actorRole, action, entityType, entityId, details = {} }) {
    await transaction.request()
      .input('actorId', sql.Int, actorId)
      .input('action', sql.NVarChar(100), `${actorRole}.${action}`)
      .input('entityType', sql.NVarChar(100), entityType)
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  function canonicalProfileValue(value) {
    if (value === undefined || value === null || value === '') return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
  }

  async function invalidatePendingCodes(transaction, userId) {
    await transaction.request()
      .input('userId', sql.Int, userId)
      .query(`UPDATE two_factor_codes
        SET consumed_at = UTC_TIMESTAMP(6)
        WHERE user_id = @userId AND consumed_at IS NULL`);
  }

  async function listTerms(pool) {
    const result = await pool.request().query(`
      SELECT id, school_year, term, is_current
      FROM academic_terms
      ORDER BY is_current DESC, id DESC LIMIT 100`);
    return result.recordset || [];
  }

  async function listSections(pool) {
    const result = await pool.request().query(`
      SELECT s.id, s.name, s.grade_level, s.academic_term_id,
        s.cluster, s.strand, s.adviser, s.modality, s.modular_subtype,
        t.school_year, t.term
      FROM sections AS s
      INNER JOIN academic_terms AS t ON t.id = s.academic_term_id
      ORDER BY t.is_current DESC, s.academic_term_id DESC, s.name, s.id LIMIT 250`);
    return result.recordset || [];
  }

  async function listWorkspace(searchInput = '', termInput = '', pageInput = 1) {
    const searchTerm = normalizeSearchTerm(searchInput);
    const academicTermId = normalizeOptionalId(termInput, 'academic term');
    const requestedPage = typeof pageInput === 'number' || typeof pageInput === 'string'
      ? Number(pageInput)
      : 1;
    const safeRequestedPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const searchPattern = searchTerm ? `%${escapeLikePattern(searchTerm)}%` : null;
    const pool = await getPool();
    const [terms, sections] = await Promise.all([listTerms(pool), listSections(pool)]);
    if (academicTermId && !terms.some((term) => term.id === academicTermId)) {
      throw new StudentRecordsError('Academic term not found.', 404);
    }
    const matchingStudents = await pool.request()
      .input('searchPattern', sql.NVarChar(204), searchPattern)
      .input('academicTermId', sql.Int, academicTermId)
      .query(`
        SELECT COUNT(*) AS total_students
        FROM students AS s
        WHERE (@academicTermId IS NULL OR EXISTS (
            SELECT 1 FROM enrollments AS filtered_enrollment
            WHERE filtered_enrollment.student_id = s.id
              AND filtered_enrollment.academic_term_id = @academicTermId
          ))
          AND (@searchPattern IS NULL
            OR s.student_no LIKE @searchPattern ESCAPE '~'
            OR s.lrn LIKE @searchPattern ESCAPE '~'
            OR s.first_name LIKE @searchPattern ESCAPE '~'
            OR s.middle_name LIKE @searchPattern ESCAPE '~'
            OR s.last_name LIKE @searchPattern ESCAPE '~'
            OR CONCAT_WS(' ', s.first_name, NULLIF(s.middle_name, ''), s.last_name) LIKE @searchPattern ESCAPE '~')`);
    const totalStudents = Number(matchingStudents.recordset?.[0]?.total_students || 0);
    const totalPages = Math.max(1, Math.ceil(totalStudents / STUDENT_PAGE_SIZE));
    const page = Math.min(safeRequestedPage, totalPages);
    const offset = (page - 1) * STUDENT_PAGE_SIZE;
    const students = await pool.request()
      .input('searchPattern', sql.NVarChar(204), searchPattern)
      .input('academicTermId', sql.Int, academicTermId)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, STUDENT_PAGE_SIZE)
      .query(`
        SELECT s.id, s.student_no, s.lrn, s.first_name, s.middle_name,
          s.last_name, s.suffix, s.birth_date, s.sex, s.phone, s.status,
          s.user_id, u.is_active AS linked_account_is_active,
          e.id AS enrollment_id, e.enrollment_status,
          t.id AS academic_term_id, t.school_year, t.term, sec.name AS section_name,
          good_moral.status AS good_moral_status, psa.status AS psa_status,
          form137.status AS form137_status
        FROM students AS s
        LEFT JOIN (
          SELECT ranked.id, ranked.student_id, ranked.academic_term_id, ranked.section_id, ranked.term_id
          FROM (
            SELECT en.id, en.student_id, en.enrollment_status, en.academic_term_id, en.section_id,
              at.school_year, at.term, at.id AS term_id,
              ROW_NUMBER() OVER (PARTITION BY en.student_id
                ORDER BY at.is_current DESC, at.id DESC, en.id DESC) AS event_rank
            FROM enrollments AS en
            INNER JOIN academic_terms AS at ON at.id = en.academic_term_id
            WHERE @academicTermId IS NULL OR en.academic_term_id = @academicTermId
          ) AS ranked
          WHERE ranked.event_rank = 1
        ) AS latest ON latest.student_id = s.id
        LEFT JOIN enrollments AS e ON e.id = latest.id
        LEFT JOIN users AS u ON u.id = s.user_id
        LEFT JOIN academic_terms AS t ON t.id = latest.term_id
        LEFT JOIN sections AS sec ON sec.id = latest.section_id AND sec.academic_term_id = latest.academic_term_id
        LEFT JOIN (
          SELECT ranked.student_id, ranked.status
          FROM (
            SELECT d.student_id, d.status,
              ROW_NUMBER() OVER (PARTITION BY d.student_id ORDER BY d.created_at DESC, d.id DESC) AS event_rank
            FROM documents AS d WHERE d.document_type = 'good_moral'
          ) AS ranked
          WHERE ranked.event_rank = 1
        ) AS good_moral ON good_moral.student_id = s.id
        LEFT JOIN (
          SELECT ranked.student_id, ranked.status
          FROM (
            SELECT d.student_id, d.status,
              ROW_NUMBER() OVER (PARTITION BY d.student_id ORDER BY d.created_at DESC, d.id DESC) AS event_rank
            FROM documents AS d WHERE d.document_type = 'psa_birth_certificate'
          ) AS ranked
          WHERE ranked.event_rank = 1
        ) AS psa ON psa.student_id = s.id
        LEFT JOIN (
          SELECT ranked.student_id, ranked.status
          FROM (
            SELECT e.student_id, e.status,
              ROW_NUMBER() OVER (PARTITION BY e.student_id ORDER BY e.created_at DESC, e.id DESC) AS event_rank
            FROM form137_status_events AS e
          ) AS ranked
          WHERE ranked.event_rank = 1
        ) AS form137 ON form137.student_id = s.id
        WHERE (@academicTermId IS NULL OR EXISTS (
            SELECT 1 FROM enrollments AS filtered_enrollment
            WHERE filtered_enrollment.student_id = s.id
              AND filtered_enrollment.academic_term_id = @academicTermId
          ))
          AND (@searchPattern IS NULL
            OR s.student_no LIKE @searchPattern ESCAPE '~'
            OR s.lrn LIKE @searchPattern ESCAPE '~'
            OR s.first_name LIKE @searchPattern ESCAPE '~'
            OR s.middle_name LIKE @searchPattern ESCAPE '~'
            OR s.last_name LIKE @searchPattern ESCAPE '~'
            OR CONCAT_WS(' ', s.first_name, NULLIF(s.middle_name, ''), s.last_name) LIKE @searchPattern ESCAPE '~')
        ORDER BY s.last_name, s.first_name, s.student_no, s.id
        LIMIT @pageSize OFFSET @offset`);
    return {
      students: students.recordset || [], terms, sections, searchTerm, academicTermId,
      totalStudents, page, pageSize: STUDENT_PAGE_SIZE, totalPages
    };
  }

  async function getStudent(studentId) {
    const id = normalizeRecordId(studentId);
    if (!id) throw new StudentRecordsError('Student record not found.', 404);
    const pool = await getPool();
    const result = await pool.request()
      .input('studentId', sql.Int, id)
      .query(`SELECT s.id, s.user_id, s.student_no, s.lrn, s.first_name, s.middle_name, s.last_name, s.suffix,
        s.birth_date, s.sex, s.address, s.phone, s.birthplace, s.facebook_name,
        s.emergency_contact_person, s.emergency_contact_relationship, s.emergency_contact_phone, s.emergency_contact_address,
        s.address_block_lot_street_purok, s.address_barangay, s.address_city, s.address_province, s.address_zip,
        s.emergency_contact_address_block_lot_street_purok, s.emergency_contact_address_barangay,
        s.emergency_contact_address_city, s.emergency_contact_address_province, s.emergency_contact_address_zip,
        s.mother_name, s.mother_phone, s.father_name, s.father_phone, s.status, s.created_at, s.updated_at,
        u.is_active AS linked_account_is_active,
        good_moral.status AS good_moral_status, good_moral.created_at AS good_moral_submitted_at,
        psa.status AS psa_status, psa.created_at AS psa_submitted_at,
        previous_report_card.status AS previous_report_card_status,
        previous_report_card.created_at AS previous_report_card_submitted_at,
        previous_report_card.latest_decision_type AS previous_report_card_latest_decision_type,
        previous_report_card_paper.status AS previous_school_report_card_physical_status,
        form137.status AS form137_status, form137.created_at AS form137_updated_at
        FROM students AS s LEFT JOIN users AS u ON u.id = s.user_id
        LEFT JOIN (
          SELECT ranked.student_id, ranked.status, ranked.created_at
          FROM (
            SELECT d.student_id, d.status, d.created_at,
              ROW_NUMBER() OVER (PARTITION BY d.student_id ORDER BY d.created_at DESC, d.id DESC) AS event_rank
            FROM documents AS d WHERE d.document_type = 'good_moral'
          ) AS ranked
          WHERE ranked.event_rank = 1
        ) AS good_moral ON good_moral.student_id = s.id
        LEFT JOIN (
          SELECT ranked.student_id, ranked.status, ranked.created_at
          FROM (
            SELECT d.student_id, d.status, d.created_at,
              ROW_NUMBER() OVER (PARTITION BY d.student_id ORDER BY d.created_at DESC, d.id DESC) AS event_rank
            FROM documents AS d WHERE d.document_type = 'psa_birth_certificate'
          ) AS ranked
          WHERE ranked.event_rank = 1
        ) AS psa ON psa.student_id = s.id
        LEFT JOIN (
          SELECT reports.student_id, reports.status, reports.created_at, decisions.decision_type AS latest_decision_type
          FROM (
            SELECT d.id, d.student_id, d.status, d.created_at,
              ROW_NUMBER() OVER (PARTITION BY d.student_id ORDER BY d.created_at DESC, d.id DESC) AS report_rank
            FROM documents AS d
            WHERE d.document_type = 'report_card' AND d.is_legacy_archive = 0 AND d.upload_source = 'student'
          ) AS reports
          LEFT JOIN (
            SELECT ranked.document_id, ranked.decision_type
            FROM (
              SELECT e.document_id, e.decision_type,
                ROW_NUMBER() OVER (PARTITION BY e.document_id ORDER BY e.created_at DESC, e.id DESC) AS event_rank
              FROM document_decision_events AS e
            ) AS ranked
            WHERE ranked.event_rank = 1
          ) AS decisions ON decisions.document_id = reports.id
          WHERE reports.report_rank = 1
        ) AS previous_report_card ON previous_report_card.student_id = s.id
        LEFT JOIN (
          SELECT ranked.student_id, ranked.status
          FROM (
            SELECT e.student_id, e.status,
              ROW_NUMBER() OVER (PARTITION BY e.student_id ORDER BY e.created_at DESC, e.id DESC) AS event_rank
            FROM previous_school_report_card_status_events AS e
          ) AS ranked
          WHERE ranked.event_rank = 1
        ) AS previous_report_card_paper ON previous_report_card_paper.student_id = s.id
        LEFT JOIN (
          SELECT ranked.student_id, ranked.status, ranked.created_at
          FROM (
            SELECT e.student_id, e.status, e.created_at,
              ROW_NUMBER() OVER (PARTITION BY e.student_id ORDER BY e.created_at DESC, e.id DESC) AS event_rank
            FROM form137_status_events AS e
          ) AS ranked
          WHERE ranked.event_rank = 1
        ) AS form137 ON form137.student_id = s.id
        WHERE s.id = @studentId`);
    const student = result.recordset?.[0];
    if (!student) return null;
    const [terms, sections, enrollments] = await Promise.all([
      listTerms(pool),
      listSections(pool),
      pool.request().input('studentId', sql.Int, id).query(`
        SELECT e.id, e.academic_term_id, e.section_id, e.enrollment_status, e.enrolled_at,
          t.school_year, t.term, s.name AS section_name, s.grade_level
        FROM enrollments AS e
        INNER JOIN academic_terms AS t ON t.id = e.academic_term_id
        LEFT JOIN sections AS s ON s.id = e.section_id AND s.academic_term_id = e.academic_term_id
        WHERE e.student_id = @studentId
        ORDER BY t.is_current DESC, t.id DESC, e.id DESC`)
    ]);
    return { student, terms, sections, enrollments: enrollments.recordset || [] };
  }

  async function getOwnStudentRecord(userId) {
    if (!Number.isSafeInteger(userId) || userId < 1) return null;
    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.Int, userId)
      .query(`SELECT id, student_no, first_name, middle_name, last_name, suffix,
        birth_date, sex, address, phone, status
        FROM students WHERE user_id = @userId`);
    const student = result.recordset?.[0];
    if (!student) return null;
    const enrollments = await pool.request()
      .input('studentId', sql.Int, student.id)
      .query(`SELECT e.id, e.enrollment_status, e.enrolled_at,
          t.school_year, t.term, t.is_current, s.name AS section_name, s.grade_level
        FROM enrollments AS e
        INNER JOIN academic_terms AS t ON t.id = e.academic_term_id
        LEFT JOIN sections AS s ON s.id = e.section_id AND s.academic_term_id = e.academic_term_id
        WHERE e.student_id = @studentId
        ORDER BY t.is_current DESC, t.id DESC, e.id DESC`);
    return { student, enrollments: enrollments.recordset || [] };
  }

  async function getStudentDashboardSummary(actorInput) {
    const actorId = normalizeRecordId(actorInput, 'user');
    if (!actorId) throw new StudentRecordsError('Student dashboard access is required.', 403);
    const pool = await getPool();
    const result = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query(`SELECT
          (SELECT COUNT(*) FROM enrollments AS e
            INNER JOIN students AS s ON s.id = e.student_id
            WHERE s.user_id = @actorId) AS enrollment_count,
          (SELECT COUNT(*) FROM grades AS g
            INNER JOIN student_subjects AS ss ON ss.id = g.student_subject_id
            INNER JOIN enrollments AS e ON e.id = ss.enrollment_id
            INNER JOIN students AS s ON s.id = e.student_id
            WHERE s.user_id = @actorId) AS grade_entry_count,
          (SELECT COUNT(*) FROM documents AS d
            INNER JOIN students AS s ON s.id = d.student_id
            WHERE s.user_id = @actorId
              AND (d.document_type IN ('good_moral', 'psa_birth_certificate')
                OR (d.document_type = 'report_card' AND d.is_legacy_archive = 0 AND d.upload_source = 'student'))) AS document_count,
          (SELECT COUNT(*) FROM documents AS d
            INNER JOIN students AS s ON s.id = d.student_id
            WHERE s.user_id = @actorId
              AND (d.document_type IN ('good_moral', 'psa_birth_certificate')
                OR (d.document_type = 'report_card' AND d.is_legacy_archive = 0 AND d.upload_source = 'student'))
              AND d.status IN ('pending', 'processing', 'needs_review', 'failed')) AS documents_in_progress_count
        WHERE EXISTS (SELECT 1 FROM users
          WHERE id = @actorId AND role = 'student' AND is_active = 1)`);
    const summary = result.recordset?.[0];
    if (!summary) throw new StudentRecordsError('Your student dashboard access is no longer active. Sign in again.', 403);
    return summary;
  }

  async function getRegistrarDashboardSummary(actorInput) {
    const actorId = normalizeRecordId(actorInput, 'user');
    if (!actorId) throw new StudentRecordsError('Registrar dashboard access is required.', 403);
    const pool = await getPool();
    const result = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query(`SELECT
          (SELECT COUNT(*) FROM students WHERE status = 'active') AS active_student_count,
          (SELECT COUNT(*) FROM students WHERE status = 'archived') AS archived_student_count,
          (SELECT COUNT(*) FROM enrollments AS e
            INNER JOIN academic_terms AS t ON t.id = e.academic_term_id
            WHERE t.is_current = 1 AND e.enrollment_status = 'enrolled') AS current_enrollment_count,
          (SELECT COUNT(*) FROM documents WHERE status IN ('needs_review', 'failed')) AS documents_awaiting_review_count,
          (SELECT COUNT(*) FROM documents WHERE status IN ('pending', 'processing')) AS documents_processing_count
        WHERE EXISTS (SELECT 1 FROM users
          WHERE id = @actorId AND role = 'registrar' AND is_active = 1)`);
    const summary = result.recordset?.[0];
    if (!summary) throw new StudentRecordsError('Your registrar dashboard access is no longer active. Sign in again.', 403);
    return summary;
  }

  async function saveStudent(actorId, studentId, input) {
    const id = studentId === null ? null : normalizeRecordId(studentId);
    if (studentId !== null && !id) throw new StudentRecordsError('Student record not found.', 404);
    const student = validateStudent(input, {
      requireLrn: id === null,
      requireStudentNo: id !== null,
      allowLegacyUnspecifiedSex: id !== null
    });
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicActor(transaction, actorId);
      if (id === null && actor.role !== 'database_admin') {
        throw new StudentRecordsError('Registrars must create new student profiles through student enrollment intake.', 403);
      }
      if (id === null) {
        const termResult = await transaction.request()
          .query(`SELECT school_year FROM academic_terms
            WHERE is_current = 1 ORDER BY id DESC LIMIT 1 FOR UPDATE`);
        const currentTerm = termResult.recordset?.[0];
        if (!currentTerm) throw new StudentRecordsError('Set a current academic term before creating a student profile.', 409);
        try {
          student.studentNo = await allocateStudentNumber(transaction, sql, currentTerm.school_year);
        } catch (error) {
          if (error instanceof StudentNumberAllocationError) throw new StudentRecordsError(error.message, error.status);
          throw error;
        }
      }
      let currentRecord = null;
      if (id !== null) {
        const current = await transaction.request().input('studentId', sql.Int, id)
          .query(`SELECT id, status, student_no, lrn, first_name, middle_name, last_name, suffix,
              birth_date, sex, address, phone, birthplace, facebook_name,
              emergency_contact_person, emergency_contact_relationship, emergency_contact_phone, emergency_contact_address,
              address_block_lot_street_purok, address_barangay, address_city, address_province, address_zip,
              emergency_contact_address_block_lot_street_purok, emergency_contact_address_barangay,
              emergency_contact_address_city, emergency_contact_address_province, emergency_contact_address_zip,
              mother_name, mother_phone, father_name, father_phone
            FROM students WHERE id = @studentId FOR UPDATE`);
        currentRecord = current.recordset?.[0];
        if (!currentRecord) throw new StudentRecordsError('Student record not found.', 404);
        if (currentRecord.status === 'archived') throw new StudentRecordsError('Archived student profiles cannot be edited.', 409);
        if (actor.role === 'registrar' && student.studentNo !== currentRecord.student_no) {
          throw new StudentRecordsError('Only database administrators can change a student number.', 403);
        }
        const currentLrn = currentRecord.lrn || null;
        if (actor.role === 'registrar' && currentLrn && student.lrn !== currentLrn) {
          throw new StudentRecordsError('Only database administrators can change a recorded LRN.', 403);
        }
        if (currentLrn && !student.lrn) throw new StudentRecordsError('A recorded LRN cannot be cleared. Enter its replacement LRN.', 400);
      }
      applyAddressInput(student, input, 'address', currentRecord);
      applyAddressInput(student, input, 'emergencyContactAddress', currentRecord);
      const request = transaction.request()
        .input('studentNo', sql.NVarChar(50), student.studentNo)
        .input('lrn', sql.NVarChar(12), student.lrn)
        .input('firstName', sql.NVarChar(100), student.firstName)
        .input('middleName', sql.NVarChar(100), student.middleName)
        .input('lastName', sql.NVarChar(100), student.lastName)
        .input('suffix', sql.NVarChar(20), student.suffix)
        .input('birthDate', sql.Date, student.birthDate)
        .input('sex', sql.NVarChar(20), student.sex)
        .input('address', sql.NVarChar(500), student.address)
        .input('phone', sql.NVarChar(50), student.phone)
        .input('birthplace', sql.NVarChar(160), student.birthplace)
        .input('facebookName', sql.NVarChar(120), student.facebookName)
        .input('emergencyContactPerson', sql.NVarChar(160), student.emergencyContactPerson)
        .input('emergencyContactRelationship', sql.NVarChar(80), student.emergencyContactRelationship)
        .input('emergencyContactPhone', sql.NVarChar(50), student.emergencyContactPhone)
        .input('emergencyContactAddress', sql.NVarChar(500), student.emergencyContactAddress)
        .input('addressBlockLotStreetPurok', sql.NVarChar(200), student.addressBlockLotStreetPurok)
        .input('addressBarangay', sql.NVarChar(100), student.addressBarangay)
        .input('addressCity', sql.NVarChar(100), student.addressCity)
        .input('addressProvince', sql.NVarChar(100), student.addressProvince)
        .input('addressZip', sql.Char(4), student.addressZip)
        .input('emergencyContactAddressBlockLotStreetPurok', sql.NVarChar(200), student.emergencyContactAddressBlockLotStreetPurok)
        .input('emergencyContactAddressBarangay', sql.NVarChar(100), student.emergencyContactAddressBarangay)
        .input('emergencyContactAddressCity', sql.NVarChar(100), student.emergencyContactAddressCity)
        .input('emergencyContactAddressProvince', sql.NVarChar(100), student.emergencyContactAddressProvince)
        .input('emergencyContactAddressZip', sql.Char(4), student.emergencyContactAddressZip)
        .input('motherName', sql.NVarChar(160), student.motherName)
        .input('motherPhone', sql.NVarChar(50), student.motherPhone)
        .input('fatherName', sql.NVarChar(160), student.fatherName)
        .input('fatherPhone', sql.NVarChar(50), student.fatherPhone);
      let savedId;
      if (id === null) {
        const result = await request.query(`INSERT INTO students
          (student_no, lrn, first_name, middle_name, last_name, suffix, birth_date, sex, address, phone,
            birthplace, facebook_name, emergency_contact_person, emergency_contact_relationship,
            emergency_contact_phone, emergency_contact_address, address_block_lot_street_purok, address_barangay,
            address_city, address_province, address_zip, emergency_contact_address_block_lot_street_purok,
            emergency_contact_address_barangay, emergency_contact_address_city, emergency_contact_address_province,
            emergency_contact_address_zip, mother_name, mother_phone, father_name, father_phone)
          VALUES (@studentNo, @lrn, @firstName, @middleName, @lastName, @suffix, @birthDate, @sex, @address, @phone,
            @birthplace, @facebookName, @emergencyContactPerson, @emergencyContactRelationship,
            @emergencyContactPhone, @emergencyContactAddress, @addressBlockLotStreetPurok, @addressBarangay,
            @addressCity, @addressProvince, @addressZip, @emergencyContactAddressBlockLotStreetPurok,
            @emergencyContactAddressBarangay, @emergencyContactAddressCity, @emergencyContactAddressProvince,
            @emergencyContactAddressZip, @motherName, @motherPhone, @fatherName, @fatherPhone)`);
        savedId = result.insertId;
        if (!Number.isSafeInteger(savedId) || savedId < 1) throw new Error('Student record insert returned no identifier.');
      } else {
        await request.input('studentId', sql.Int, id).query(`UPDATE students
          SET student_no = @studentNo, lrn = @lrn, first_name = @firstName, middle_name = @middleName,
            last_name = @lastName, suffix = @suffix, birth_date = @birthDate,
            sex = @sex, address = @address, phone = @phone, birthplace = @birthplace, facebook_name = @facebookName,
            emergency_contact_person = @emergencyContactPerson, emergency_contact_relationship = @emergencyContactRelationship,
            emergency_contact_phone = @emergencyContactPhone, emergency_contact_address = @emergencyContactAddress,
            address_block_lot_street_purok = @addressBlockLotStreetPurok, address_barangay = @addressBarangay,
            address_city = @addressCity, address_province = @addressProvince, address_zip = @addressZip,
            emergency_contact_address_block_lot_street_purok = @emergencyContactAddressBlockLotStreetPurok,
            emergency_contact_address_barangay = @emergencyContactAddressBarangay,
            emergency_contact_address_city = @emergencyContactAddressCity,
            emergency_contact_address_province = @emergencyContactAddressProvince,
            emergency_contact_address_zip = @emergencyContactAddressZip,
            mother_name = @motherName, mother_phone = @motherPhone, father_name = @fatherName, father_phone = @fatherPhone,
            updated_at = UTC_TIMESTAMP(6)
          WHERE id = @studentId`);
        savedId = id;
        const revisionGroup = crypto.randomUUID();
        for (const [fieldName, inputName] of PROFILE_REVISION_FIELDS) {
          const beforeValue = canonicalProfileValue(currentRecord[fieldName]);
          const afterValue = canonicalProfileValue(student[inputName]);
          if (beforeValue === afterValue) continue;
          await transaction.request()
            .input('revisionGroup', sql.UniqueIdentifier, revisionGroup)
            .input('studentId', sql.Int, savedId)
            .input('actorId', sql.Int, actor.id)
            .input('fieldName', sql.NVarChar(50), fieldName)
            .input('beforeValue', sql.NVarChar(sql.MAX), beforeValue)
            .input('afterValue', sql.NVarChar(sql.MAX), afterValue)
            .query(`INSERT INTO student_profile_revisions
              (revision_group, student_id, actor_id, field_name, before_value, after_value)
              VALUES (@revisionGroup, @studentId, @actorId, @fieldName, @beforeValue, @afterValue)`);
        }
      }
      await writeAudit(transaction, {
        actorId, actorRole: actor.role, action: id === null ? 'student_created' : 'student_updated',
        entityType: 'student', entityId: savedId
      });
      return savedId;
    });
  }

  async function listStudentProfileRevisions(actorInput, studentInput) {
    const actorId = normalizeRecordId(actorInput, 'user');
    const studentId = normalizeRecordId(studentInput, 'student');
    if (!actorId || !studentId) throw new StudentRecordsError('Student record not found.', 404);
    const pool = await getPool();
    const actor = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN ('database_admin', 'registrar')`);
    if (!actor.recordset?.length || !RECORDS_ROLES.has(actor.recordset[0].role)) {
      throw new StudentRecordsError('Staff-only student revision history is unavailable.', 403);
    }
    const result = await pool.request().input('studentId', sql.Int, studentId)
      .query(`SELECT revision.revision_group, revision.field_name, revision.before_value,
          revision.after_value, revision.created_at, revision.actor_id,
          staff.first_name AS actor_first_name, staff.last_name AS actor_last_name
        FROM student_profile_revisions AS revision
        LEFT JOIN staff_profiles AS staff ON staff.user_id = revision.actor_id
        WHERE revision.student_id = @studentId
        ORDER BY revision.created_at DESC, revision.id DESC`);
    return result.recordset || [];
  }

  async function deactivateStudentLogin(actorIdInput, studentInput, confirmationInput) {
    const studentId = normalizeRecordId(studentInput);
    if (!studentId) throw new StudentRecordsError('Student record not found.', 404);
    if (confirmationInput !== 'DEACTIVATE') {
      throw new StudentRecordsError('Type DEACTIVATE to confirm disabling the student login.');
    }
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicActor(transaction, actorIdInput);
      if (actor.role !== 'registrar') throw new StudentRecordsError('Only registrars can deactivate a student login.', 403);
      const studentResult = await transaction.request().input('studentId', sql.Int, studentId)
        .query('SELECT id, user_id, status FROM students WHERE id = @studentId FOR UPDATE');
      const student = studentResult.recordset?.[0];
      if (!student) throw new StudentRecordsError('Student record not found.', 404);
      if (student.status === 'archived') throw new StudentRecordsError('Archived student logins are already disabled.', 409);
      if (!student.user_id) throw new StudentRecordsError('This student has no linked login account.', 409);
      const userResult = await transaction.request().input('userId', sql.Int, student.user_id)
        .query('SELECT id, is_active FROM users WHERE id = @userId AND role = N\'student\' FOR UPDATE');
      const user = userResult.recordset?.[0];
      if (!user) throw new StudentRecordsError('The linked student login could not be found.', 409);
      if (!(user.is_active === true || user.is_active === 1)) throw new StudentRecordsError('The linked student login is already inactive.', 409);
      await transaction.request().input('userId', sql.Int, user.id)
        .query('UPDATE users SET is_active = 0, updated_at = UTC_TIMESTAMP(6) WHERE id = @userId');
      await transaction.request().input('studentId', sql.Int, studentId)
        .query(`UPDATE annual_enrollments SET account_activation_pending = 0, updated_at = UTC_TIMESTAMP(6)
          WHERE student_id = @studentId AND account_activation_pending = 1`);
      await transaction.request().input('userId', sql.Int, user.id)
        .query(`UPDATE enrollment_clearances SET account_activation_pending = 0
          WHERE created_for_intake = 1 AND account_activation_pending = 1
            AND enrollment_id IN (SELECT id FROM enrollments WHERE student_id = (SELECT id FROM students WHERE user_id = @userId))`);
      await invalidatePendingCodes(transaction, user.id);
      await writeAudit(transaction, {
        actorId: actor.id, actorRole: actor.role, action: 'student_login_deactivated',
        entityType: 'student', entityId: studentId, details: { userId: user.id }
      });
      return studentId;
    });
  }

  async function archiveStudent(actorIdInput, studentInput, confirmationInput) {
    const studentId = normalizeRecordId(studentInput);
    if (!studentId) throw new StudentRecordsError('Student record not found.', 404);
    if (typeof confirmationInput !== 'string' || confirmationInput.length > 50) {
      throw new StudentRecordsError('Type this student’s number to confirm archiving.');
    }
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicActor(transaction, actorIdInput);
      if (actor.role !== 'database_admin') throw new StudentRecordsError('Only database administrators can archive student records.', 403);
      const studentResult = await transaction.request().input('studentId', sql.Int, studentId)
        .query('SELECT id, user_id, student_no, status FROM students WHERE id = @studentId FOR UPDATE');
      const student = studentResult.recordset?.[0];
      if (!student) throw new StudentRecordsError('Student record not found.', 404);
      if (confirmationInput !== student.student_no) throw new StudentRecordsError('Type this student’s number to confirm archiving.');
      if (student.status === 'archived') throw new StudentRecordsError('This student record is already archived.', 409);

      await transaction.request().input('studentId', sql.Int, studentId)
        .query(`UPDATE students SET status = 'archived', updated_at = UTC_TIMESTAMP(6)
          WHERE id = @studentId`);
      let loginDeactivated = false;
      if (student.user_id) {
        await transaction.request().input('userId', sql.Int, student.user_id)
          .query(`UPDATE users SET is_active = 0, updated_at = UTC_TIMESTAMP(6)
            WHERE id = @userId AND role = 'student'`);
        await invalidatePendingCodes(transaction, student.user_id);
        loginDeactivated = true;
      }
      await writeAudit(transaction, {
        actorId: actor.id, actorRole: actor.role, action: 'student_archived',
        entityType: 'student', entityId: studentId, details: { studentNo: student.student_no, loginDeactivated }
      });
      return studentId;
    });
  }

  async function createTerm(actorId, input) {
    const term = validateTerm(input);
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicActor(transaction, actorId);
      if (term.isCurrent) {
        await transaction.request().query('UPDATE academic_terms SET is_current = 0 WHERE is_current = 1');
      }
      const result = await transaction.request()
        .input('schoolYear', sql.NVarChar(20), term.schoolYear)
        .input('term', sql.NVarChar(30), term.term)
        .input('isCurrent', sql.Bit, term.isCurrent)
        .query(`INSERT INTO academic_terms (school_year, term, is_current)
          VALUES (@schoolYear, @term, @isCurrent)`);
      const termId = result.insertId;
      if (!Number.isSafeInteger(termId) || termId < 1) throw new Error('Academic term insert returned no identifier.');
      await writeAudit(transaction, {
        actorId, actorRole: actor.role, action: 'academic_term_created',
        entityType: 'academic_term', entityId: termId, details: { isCurrent: term.isCurrent }
      });
      return termId;
    });
  }

  async function setCurrentTerm(actorId, termInput) {
    const termId = normalizeRecordId(termInput);
    if (!termId) throw new StudentRecordsError('Academic term not found.', 404);
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicActor(transaction, actorId);
      const term = await transaction.request().input('termId', sql.Int, termId)
        .query('SELECT id FROM academic_terms WHERE id = @termId FOR UPDATE');
      if (!term.recordset?.length) throw new StudentRecordsError('Academic term not found.', 404);
      await transaction.request().query('UPDATE academic_terms SET is_current = 0 WHERE is_current = 1');
      await transaction.request().input('termId', sql.Int, termId)
        .query('UPDATE academic_terms SET is_current = 1 WHERE id = @termId');
      await writeAudit(transaction, {
        actorId, actorRole: actor.role, action: 'academic_term_set_current',
        entityType: 'academic_term', entityId: termId
      });
    });
  }

  async function createSection(actorId, input) {
    const section = validateSection(input);
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicActor(transaction, actorId);
      const term = await transaction.request().input('termId', sql.Int, section.academicTermId)
        .query('SELECT id FROM academic_terms WHERE id = @termId FOR UPDATE');
      if (!term.recordset?.length) throw new StudentRecordsError('Academic term not found.', 404);
      const existing = await transaction.request()
        .input('termId', sql.Int, section.academicTermId)
        .input('name', sql.NVarChar(100), section.name)
        .query(`SELECT id FROM sections
          WHERE academic_term_id = @termId AND name = @name FOR UPDATE`);
      if (existing.recordset?.length) throw new StudentRecordsError('That section already exists for this academic term.', 409);
      const result = await transaction.request()
        .input('termId', sql.Int, section.academicTermId)
        .input('name', sql.NVarChar(100), section.name)
        .input('gradeLevel', sql.NVarChar(50), section.gradeLevel)
        .input('cluster', sql.NVarChar(80), section.cluster)
        .input('strand', sql.NVarChar(80), section.strand)
        .input('adviser', sql.NVarChar(160), section.adviser)
        .input('modality', sql.NVarChar(30), section.modality)
        .input('modularSubtype', sql.NVarChar(80), section.modularSubtype)
        .query(`INSERT INTO sections (name, grade_level, academic_term_id, cluster, strand, adviser, modality, modular_subtype)
          VALUES (@name, @gradeLevel, @termId, @cluster, @strand, @adviser, @modality, @modularSubtype)`);
      const sectionId = result.insertId;
      if (!Number.isSafeInteger(sectionId) || sectionId < 1) throw new Error('Section insert returned no identifier.');
      await writeAudit(transaction, {
        actorId, actorRole: actor.role, action: 'section_created',
        entityType: 'section', entityId: sectionId, details: { academicTermId: section.academicTermId }
      });
      return sectionId;
    });
  }

  async function saveEnrollment(actorId, input) {
    const enrollment = validateEnrollment(input);
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicActor(transaction, actorId);
      const student = await transaction.request().input('studentId', sql.Int, enrollment.studentId)
        .query('SELECT id, status FROM students WHERE id = @studentId FOR UPDATE');
      if (!student.recordset?.length) throw new StudentRecordsError('Student record not found.', 404);
      if (student.recordset[0].status === 'archived') throw new StudentRecordsError('Archived students cannot receive new enrollments.', 409);
      const pendingIntake = await transaction.request().input('studentId', sql.Int, enrollment.studentId)
        .query(`SELECT enrollment.id
          FROM enrollments AS enrollment
          INNER JOIN enrollment_clearances AS clearance
            ON clearance.enrollment_id = enrollment.id
          WHERE enrollment.student_id = @studentId AND enrollment.enrollment_status = 'pending_payment'
            AND enrollment.finalized_at IS NULL AND clearance.created_for_intake = 1 LIMIT 1 FOR UPDATE`);
      if (pendingIntake.recordset?.length) {
        throw new StudentRecordsError('This student has a pending new-student intake. Finance must clear that enrollment before it can be finalized.', 409);
      }
      const term = await transaction.request().input('termId', sql.Int, enrollment.academicTermId)
        .query('SELECT id, school_year FROM academic_terms WHERE id = @termId FOR UPDATE');
      if (!term.recordset?.length) throw new StudentRecordsError('Academic term not found.', 404);
      const annualWorkflow = await transaction.request()
        .input('studentId', sql.Int, enrollment.studentId)
        .input('schoolYear', sql.NVarChar(20), term.recordset[0].school_year)
        .query(`SELECT id FROM annual_enrollments
          WHERE student_id = @studentId AND school_year = @schoolYear FOR UPDATE`);
      if (annualWorkflow.recordset?.length) {
        throw new StudentRecordsError('This school year has an annual enrollment record. Its term history is managed in the annual intake workspace and cannot be changed here.', 409);
      }
      if (enrollment.sectionId !== null) {
        const section = await transaction.request()
          .input('sectionId', sql.Int, enrollment.sectionId)
          .input('termId', sql.Int, enrollment.academicTermId)
          .query('SELECT id FROM sections WHERE id = @sectionId AND academic_term_id = @termId FOR UPDATE');
        if (!section.recordset?.length) {
          throw new StudentRecordsError('Choose a section that belongs to the selected academic term.');
        }
      }
      const existing = await transaction.request()
        .input('studentId', sql.Int, enrollment.studentId)
        .input('termId', sql.Int, enrollment.academicTermId)
        .query(`SELECT id FROM enrollments
          WHERE student_id = @studentId AND academic_term_id = @termId FOR UPDATE`);
      let enrollmentId;
      let action;
      if (existing.recordset?.length) {
        enrollmentId = existing.recordset[0].id;
        action = 'enrollment_updated';
        await transaction.request()
          .input('enrollmentId', sql.Int, enrollmentId)
          .input('sectionId', sql.Int, enrollment.sectionId)
          .query('UPDATE enrollments SET section_id = @sectionId WHERE id = @enrollmentId');
      } else {
        action = 'enrollment_created';
        const result = await transaction.request()
          .input('studentId', sql.Int, enrollment.studentId)
          .input('termId', sql.Int, enrollment.academicTermId)
          .input('sectionId', sql.Int, enrollment.sectionId)
          .query(`INSERT INTO enrollments (student_id, academic_term_id, section_id)
            VALUES (@studentId, @termId, @sectionId)`);
        enrollmentId = result.insertId;
        if (!Number.isSafeInteger(enrollmentId) || enrollmentId < 1) throw new Error('Enrollment insert returned no identifier.');
      }
      await writeAudit(transaction, {
        actorId, actorRole: actor.role, action, entityType: 'enrollment', entityId: enrollmentId,
        details: { studentId: enrollment.studentId, academicTermId: enrollment.academicTermId }
      });
      return enrollmentId;
    });
  }

  return {
    listWorkspace, getStudent, getOwnStudentRecord, getStudentDashboardSummary, getRegistrarDashboardSummary,
    saveStudent, listStudentProfileRevisions, deactivateStudentLogin, archiveStudent,
    createTerm, setCurrentTerm, createSection, saveEnrollment
  };
}

module.exports = {
  StudentRecordsError,
  createStudentRecordsService,
  applyAddressInput,
  normalizeRecordId,
  normalizeSearchTerm,
  validateName,
  normalizePhone,
  validateStudent,
  normalizeLrn,
  currentManilaDate,
  latestBirthDate,
  validateTerm,
  validateSection,
  validateEnrollment,
  normalizeUniqueConflict
};
