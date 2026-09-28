const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { allocateStudentNumber, StudentNumberAllocationError } = require('./studentNumberAllocator');

const RECORDS_ROLES = new Set(['database_admin', 'registrar']);
const STUDENT_PAGE_SIZE = 25;

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

function validateStudent(input = {}, { requireLrn = true, requireStudentNo = true } = {}) {
  const studentNo = requireStudentNo ? requiredText(input.studentNo, 'Student number', 50) : null;
  const firstName = requiredText(input.firstName, 'First name', 100);
  const lastName = requiredText(input.lastName, 'Last name', 100);
  const middleName = printableText(input.middleName, 100);
  const suffix = printableText(input.suffix, 20);
  const sex = printableText(input.sex, 20);
  const address = printableText(input.address, 500);
  const phone = printableText(input.phone, 50);
  if ([middleName, suffix, sex, address, phone].includes(null)) {
    throw new StudentRecordsError('Check that each optional profile field is within its allowed length and contains no control characters.');
  }
  return {
    studentNo,
    lrn: normalizeLrn(input.lrn, { required: requireLrn }),
    firstName,
    middleName: middleName || null,
    lastName,
    suffix: suffix || null,
    birthDate: normalizeDate(input.birthDate),
    sex: sex || null,
    address: address || null,
    phone: phone || null
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
  return { name, gradeLevel: gradeLevel || null, academicTermId };
}

function validateEnrollment(input = {}) {
  const studentId = normalizeOptionalId(input.studentId, 'student');
  const academicTermId = normalizeOptionalId(input.academicTermId, 'academic term');
  const sectionId = normalizeOptionalId(input.sectionId, 'section');
  if (!studentId || !academicTermId) throw new StudentRecordsError('Choose a student and academic term.');
  return { studentId, academicTermId, sectionId };
}

function normalizeUniqueConflict(error) {
  return error?.number === 2601 || error?.number === 2627;
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
      .query(`SELECT id, role FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @actorId AND is_active = 1 AND role IN (@databaseAdminRole, @registrarRole)`);
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
      .query(`INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  async function invalidatePendingCodes(transaction, userId) {
    await transaction.request()
      .input('userId', sql.Int, userId)
      .query(`UPDATE dbo.two_factor_codes
        SET consumed_at = SYSUTCDATETIME()
        WHERE user_id = @userId AND consumed_at IS NULL`);
  }

  async function listTerms(pool) {
    const result = await pool.request().query(`
      SELECT TOP (100) id, school_year, term, is_current
      FROM dbo.academic_terms
      ORDER BY is_current DESC, id DESC`);
    return result.recordset || [];
  }

  async function listSections(pool) {
    const result = await pool.request().query(`
      SELECT TOP (250) s.id, s.name, s.grade_level, s.academic_term_id,
        t.school_year, t.term
      FROM dbo.sections AS s
      INNER JOIN dbo.academic_terms AS t ON t.id = s.academic_term_id
      ORDER BY t.is_current DESC, s.academic_term_id DESC, s.name, s.id`);
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
        SELECT COUNT_BIG(*) AS total_students
        FROM dbo.students AS s
        WHERE (@academicTermId IS NULL OR EXISTS (
            SELECT 1 FROM dbo.enrollments AS filtered_enrollment
            WHERE filtered_enrollment.student_id = s.id
              AND filtered_enrollment.academic_term_id = @academicTermId
          ))
          AND (@searchPattern IS NULL
            OR s.student_no LIKE @searchPattern ESCAPE N'~'
            OR s.lrn LIKE @searchPattern ESCAPE N'~'
            OR s.first_name LIKE @searchPattern ESCAPE N'~'
            OR s.middle_name LIKE @searchPattern ESCAPE N'~'
            OR s.last_name LIKE @searchPattern ESCAPE N'~'
            OR CONCAT_WS(N' ', s.first_name, NULLIF(s.middle_name, N''), s.last_name) LIKE @searchPattern ESCAPE N'~')`);
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
        FROM dbo.students AS s
        OUTER APPLY (
          SELECT TOP (1) en.id, en.enrollment_status, en.academic_term_id,
            en.section_id, at.school_year, at.term, at.id AS term_id
          FROM dbo.enrollments AS en
          INNER JOIN dbo.academic_terms AS at ON at.id = en.academic_term_id
          WHERE en.student_id = s.id
            AND (@academicTermId IS NULL OR en.academic_term_id = @academicTermId)
          ORDER BY at.is_current DESC, at.id DESC, en.id DESC
        ) AS latest
        LEFT JOIN dbo.enrollments AS e ON e.id = latest.id
        LEFT JOIN dbo.users AS u ON u.id = s.user_id
        LEFT JOIN dbo.academic_terms AS t ON t.id = latest.term_id
        LEFT JOIN dbo.sections AS sec ON sec.id = latest.section_id AND sec.academic_term_id = latest.academic_term_id
        OUTER APPLY (SELECT TOP (1) d.status FROM dbo.documents AS d
          WHERE d.student_id = s.id AND d.document_type = 'good_moral' ORDER BY d.created_at DESC, d.id DESC) AS good_moral
        OUTER APPLY (SELECT TOP (1) d.status FROM dbo.documents AS d
          WHERE d.student_id = s.id AND d.document_type = 'psa_birth_certificate' ORDER BY d.created_at DESC, d.id DESC) AS psa
        OUTER APPLY (SELECT TOP (1) e.status FROM dbo.form137_status_events AS e
          WHERE e.student_id = s.id ORDER BY e.created_at DESC, e.id DESC) AS form137
        WHERE (@academicTermId IS NULL OR EXISTS (
            SELECT 1 FROM dbo.enrollments AS filtered_enrollment
            WHERE filtered_enrollment.student_id = s.id
              AND filtered_enrollment.academic_term_id = @academicTermId
          ))
          AND (@searchPattern IS NULL
            OR s.student_no LIKE @searchPattern ESCAPE N'~'
            OR s.lrn LIKE @searchPattern ESCAPE N'~'
            OR s.first_name LIKE @searchPattern ESCAPE N'~'
            OR s.middle_name LIKE @searchPattern ESCAPE N'~'
            OR s.last_name LIKE @searchPattern ESCAPE N'~'
            OR CONCAT_WS(N' ', s.first_name, NULLIF(s.middle_name, N''), s.last_name) LIKE @searchPattern ESCAPE N'~')
        ORDER BY s.last_name, s.first_name, s.student_no, s.id
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`);
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
        s.birth_date, s.sex, s.address, s.phone, s.status, s.created_at, s.updated_at,
        u.is_active AS linked_account_is_active,
        good_moral.status AS good_moral_status, good_moral.created_at AS good_moral_submitted_at,
        psa.status AS psa_status, psa.created_at AS psa_submitted_at,
        previous_report_card.status AS previous_report_card_status,
        previous_report_card.created_at AS previous_report_card_submitted_at,
        previous_report_card.latest_decision_type AS previous_report_card_latest_decision_type,
        previous_report_card_paper.status AS previous_school_report_card_physical_status,
        form137.status AS form137_status, form137.created_at AS form137_updated_at
        FROM dbo.students AS s LEFT JOIN dbo.users AS u ON u.id = s.user_id
        OUTER APPLY (SELECT TOP (1) d.status, d.created_at FROM dbo.documents AS d
          WHERE d.student_id = s.id AND d.document_type = 'good_moral' ORDER BY d.created_at DESC, d.id DESC) AS good_moral
        OUTER APPLY (SELECT TOP (1) d.status, d.created_at FROM dbo.documents AS d
          WHERE d.student_id = s.id AND d.document_type = 'psa_birth_certificate' ORDER BY d.created_at DESC, d.id DESC) AS psa
        OUTER APPLY (SELECT TOP (1) d.status, d.created_at, latest.decision_type AS latest_decision_type
          FROM dbo.documents AS d
          OUTER APPLY (SELECT TOP (1) e.decision_type FROM dbo.document_decision_events AS e
            WHERE e.document_id = d.id ORDER BY e.created_at DESC, e.id DESC) AS latest
          WHERE d.student_id = s.id AND d.document_type = 'report_card'
            AND d.is_legacy_archive = 0 AND d.upload_source = 'student'
          ORDER BY d.created_at DESC, d.id DESC) AS previous_report_card
        OUTER APPLY (SELECT TOP (1) e.status FROM dbo.previous_school_report_card_status_events AS e
          WHERE e.student_id = s.id ORDER BY e.created_at DESC, e.id DESC) AS previous_report_card_paper
        OUTER APPLY (SELECT TOP (1) e.status, e.created_at FROM dbo.form137_status_events AS e
          WHERE e.student_id = s.id ORDER BY e.created_at DESC, e.id DESC) AS form137
        WHERE s.id = @studentId`);
    const student = result.recordset?.[0];
    if (!student) return null;
    const [terms, sections, enrollments] = await Promise.all([
      listTerms(pool),
      listSections(pool),
      pool.request().input('studentId', sql.Int, id).query(`
        SELECT e.id, e.academic_term_id, e.section_id, e.enrollment_status, e.enrolled_at,
          t.school_year, t.term, s.name AS section_name, s.grade_level
        FROM dbo.enrollments AS e
        INNER JOIN dbo.academic_terms AS t ON t.id = e.academic_term_id
        LEFT JOIN dbo.sections AS s ON s.id = e.section_id AND s.academic_term_id = e.academic_term_id
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
        FROM dbo.students WHERE user_id = @userId`);
    const student = result.recordset?.[0];
    if (!student) return null;
    const enrollments = await pool.request()
      .input('studentId', sql.Int, student.id)
      .query(`SELECT e.id, e.enrollment_status, e.enrolled_at,
          t.school_year, t.term, t.is_current, s.name AS section_name, s.grade_level
        FROM dbo.enrollments AS e
        INNER JOIN dbo.academic_terms AS t ON t.id = e.academic_term_id
        LEFT JOIN dbo.sections AS s ON s.id = e.section_id AND s.academic_term_id = e.academic_term_id
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
          (SELECT COUNT_BIG(*) FROM dbo.enrollments AS e
            INNER JOIN dbo.students AS s ON s.id = e.student_id
            WHERE s.user_id = @actorId) AS enrollment_count,
          (SELECT COUNT_BIG(*) FROM dbo.grades AS g
            INNER JOIN dbo.student_subjects AS ss ON ss.id = g.student_subject_id
            INNER JOIN dbo.enrollments AS e ON e.id = ss.enrollment_id
            INNER JOIN dbo.students AS s ON s.id = e.student_id
            WHERE s.user_id = @actorId) AS grade_entry_count,
          (SELECT COUNT_BIG(*) FROM dbo.documents AS d
            INNER JOIN dbo.students AS s ON s.id = d.student_id
            WHERE s.user_id = @actorId
              AND (d.document_type IN ('good_moral', 'psa_birth_certificate')
                OR (d.document_type = 'report_card' AND d.is_legacy_archive = 0 AND d.upload_source = 'student'))) AS document_count,
          (SELECT COUNT_BIG(*) FROM dbo.documents AS d
            INNER JOIN dbo.students AS s ON s.id = d.student_id
            WHERE s.user_id = @actorId
              AND (d.document_type IN ('good_moral', 'psa_birth_certificate')
                OR (d.document_type = 'report_card' AND d.is_legacy_archive = 0 AND d.upload_source = 'student'))
              AND d.status IN ('pending', 'processing', 'needs_review', 'failed')) AS documents_in_progress_count
        WHERE EXISTS (SELECT 1 FROM dbo.users
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
          (SELECT COUNT_BIG(*) FROM dbo.students WHERE status = 'active') AS active_student_count,
          (SELECT COUNT_BIG(*) FROM dbo.students WHERE status = 'archived') AS archived_student_count,
          (SELECT COUNT_BIG(*) FROM dbo.enrollments AS e
            INNER JOIN dbo.academic_terms AS t ON t.id = e.academic_term_id
            WHERE t.is_current = 1 AND e.enrollment_status = 'enrolled') AS current_enrollment_count,
          (SELECT COUNT_BIG(*) FROM dbo.documents WHERE status IN ('needs_review', 'failed')) AS documents_awaiting_review_count,
          (SELECT COUNT_BIG(*) FROM dbo.documents WHERE status IN ('pending', 'processing')) AS documents_processing_count
        WHERE EXISTS (SELECT 1 FROM dbo.users
          WHERE id = @actorId AND role = 'registrar' AND is_active = 1)`);
    const summary = result.recordset?.[0];
    if (!summary) throw new StudentRecordsError('Your registrar dashboard access is no longer active. Sign in again.', 403);
    return summary;
  }

  async function saveStudent(actorId, studentId, input) {
    const id = studentId === null ? null : normalizeRecordId(studentId);
    if (studentId !== null && !id) throw new StudentRecordsError('Student record not found.', 404);
    const student = validateStudent(input, { requireLrn: id === null, requireStudentNo: id !== null });
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicActor(transaction, actorId);
      if (id === null && actor.role !== 'database_admin') {
        throw new StudentRecordsError('Registrars must create new student profiles through student enrollment intake.', 403);
      }
      if (id === null) {
        const termResult = await transaction.request()
          .query(`SELECT TOP (1) school_year FROM dbo.academic_terms WITH (UPDLOCK, HOLDLOCK)
            WHERE is_current = 1 ORDER BY id DESC`);
        const currentTerm = termResult.recordset?.[0];
        if (!currentTerm) throw new StudentRecordsError('Set a current academic term before creating a student profile.', 409);
        try {
          student.studentNo = await allocateStudentNumber(transaction, sql, currentTerm.school_year);
        } catch (error) {
          if (error instanceof StudentNumberAllocationError) throw new StudentRecordsError(error.message, error.status);
          throw error;
        }
      }
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
        .input('phone', sql.NVarChar(50), student.phone);
      let savedId;
      if (id === null) {
        const result = await request.query(`DECLARE @insertedStudents TABLE (id INT);
          INSERT INTO dbo.students
          (student_no, lrn, first_name, middle_name, last_name, suffix, birth_date, sex, address, phone)
          OUTPUT INSERTED.id INTO @insertedStudents(id)
          VALUES (@studentNo, @lrn, @firstName, @middleName, @lastName, @suffix, @birthDate, @sex, @address, @phone);
          SELECT id FROM @insertedStudents`);
        savedId = result.recordset?.[0]?.id;
        if (!savedId) throw new Error('Student record insert returned no identifier.');
      } else {
        const current = await transaction.request().input('studentId', sql.Int, id)
          .query('SELECT id, status, student_no, lrn FROM dbo.students WITH (UPDLOCK, HOLDLOCK) WHERE id = @studentId');
        if (!current.recordset?.length) throw new StudentRecordsError('Student record not found.', 404);
        if (current.recordset[0].status === 'archived') throw new StudentRecordsError('Archived student profiles cannot be edited.', 409);
        if (actor.role === 'registrar' && student.studentNo !== current.recordset[0].student_no) {
          throw new StudentRecordsError('Only database administrators can change a student number.', 403);
        }
        const currentLrn = current.recordset[0].lrn || null;
        if (actor.role === 'registrar' && currentLrn && student.lrn !== currentLrn) {
          throw new StudentRecordsError('Only database administrators can change a recorded LRN.', 403);
        }
        if (currentLrn && !student.lrn) {
          throw new StudentRecordsError('A recorded LRN cannot be cleared. Enter its replacement LRN.', 400);
        }
        await request.input('studentId', sql.Int, id).query(`UPDATE dbo.students
          SET student_no = @studentNo, lrn = @lrn, first_name = @firstName, middle_name = @middleName,
            last_name = @lastName, suffix = @suffix, birth_date = @birthDate,
            sex = @sex, address = @address, phone = @phone, updated_at = SYSUTCDATETIME()
          WHERE id = @studentId`);
        savedId = id;
      }
      await writeAudit(transaction, {
        actorId, actorRole: actor.role, action: id === null ? 'student_created' : 'student_updated',
        entityType: 'student', entityId: savedId
      });
      return savedId;
    });
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
        .query('SELECT id, user_id, status FROM dbo.students WITH (UPDLOCK, HOLDLOCK) WHERE id = @studentId');
      const student = studentResult.recordset?.[0];
      if (!student) throw new StudentRecordsError('Student record not found.', 404);
      if (student.status === 'archived') throw new StudentRecordsError('Archived student logins are already disabled.', 409);
      if (!student.user_id) throw new StudentRecordsError('This student has no linked login account.', 409);
      const userResult = await transaction.request().input('userId', sql.Int, student.user_id)
        .query('SELECT id, is_active FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE id = @userId AND role = N\'student\'');
      const user = userResult.recordset?.[0];
      if (!user) throw new StudentRecordsError('The linked student login could not be found.', 409);
      if (!(user.is_active === true || user.is_active === 1)) throw new StudentRecordsError('The linked student login is already inactive.', 409);
      await transaction.request().input('userId', sql.Int, user.id)
        .query('UPDATE dbo.users SET is_active = 0, updated_at = SYSUTCDATETIME() WHERE id = @userId');
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
        .query('SELECT id, user_id, student_no, status FROM dbo.students WITH (UPDLOCK, HOLDLOCK) WHERE id = @studentId');
      const student = studentResult.recordset?.[0];
      if (!student) throw new StudentRecordsError('Student record not found.', 404);
      if (confirmationInput !== student.student_no) throw new StudentRecordsError('Type this student’s number to confirm archiving.');
      if (student.status === 'archived') throw new StudentRecordsError('This student record is already archived.', 409);

      await transaction.request().input('studentId', sql.Int, studentId)
        .query(`UPDATE dbo.students SET status = N'archived', updated_at = SYSUTCDATETIME()
          WHERE id = @studentId`);
      let loginDeactivated = false;
      if (student.user_id) {
        await transaction.request().input('userId', sql.Int, student.user_id)
          .query(`UPDATE dbo.users SET is_active = 0, updated_at = SYSUTCDATETIME()
            WHERE id = @userId AND role = N'student'`);
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
        await transaction.request().query('UPDATE dbo.academic_terms SET is_current = 0 WHERE is_current = 1');
      }
      const result = await transaction.request()
        .input('schoolYear', sql.NVarChar(20), term.schoolYear)
        .input('term', sql.NVarChar(30), term.term)
        .input('isCurrent', sql.Bit, term.isCurrent)
        .query(`INSERT INTO dbo.academic_terms (school_year, term, is_current)
          OUTPUT INSERTED.id AS id
          VALUES (@schoolYear, @term, @isCurrent)`);
      const termId = result.recordset?.[0]?.id;
      if (!termId) throw new Error('Academic term insert returned no identifier.');
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
        .query('SELECT id FROM dbo.academic_terms WITH (UPDLOCK, HOLDLOCK) WHERE id = @termId');
      if (!term.recordset?.length) throw new StudentRecordsError('Academic term not found.', 404);
      await transaction.request().query('UPDATE dbo.academic_terms SET is_current = 0 WHERE is_current = 1');
      await transaction.request().input('termId', sql.Int, termId)
        .query('UPDATE dbo.academic_terms SET is_current = 1 WHERE id = @termId');
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
        .query('SELECT id FROM dbo.academic_terms WITH (UPDLOCK, HOLDLOCK) WHERE id = @termId');
      if (!term.recordset?.length) throw new StudentRecordsError('Academic term not found.', 404);
      const existing = await transaction.request()
        .input('termId', sql.Int, section.academicTermId)
        .input('name', sql.NVarChar(100), section.name)
        .query(`SELECT id FROM dbo.sections WITH (UPDLOCK, HOLDLOCK)
          WHERE academic_term_id = @termId AND name = @name`);
      if (existing.recordset?.length) throw new StudentRecordsError('That section already exists for this academic term.', 409);
      const result = await transaction.request()
        .input('termId', sql.Int, section.academicTermId)
        .input('name', sql.NVarChar(100), section.name)
        .input('gradeLevel', sql.NVarChar(50), section.gradeLevel)
        .query(`INSERT INTO dbo.sections (name, grade_level, academic_term_id)
          OUTPUT INSERTED.id AS id
          VALUES (@name, @gradeLevel, @termId)`);
      const sectionId = result.recordset?.[0]?.id;
      if (!sectionId) throw new Error('Section insert returned no identifier.');
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
        .query('SELECT id, status FROM dbo.students WITH (UPDLOCK, HOLDLOCK) WHERE id = @studentId');
      if (!student.recordset?.length) throw new StudentRecordsError('Student record not found.', 404);
      if (student.recordset[0].status === 'archived') throw new StudentRecordsError('Archived students cannot receive new enrollments.', 409);
      const pendingIntake = await transaction.request().input('studentId', sql.Int, enrollment.studentId)
        .query(`SELECT TOP (1) enrollment.id
          FROM dbo.enrollments AS enrollment WITH (UPDLOCK, HOLDLOCK)
          INNER JOIN dbo.enrollment_clearances AS clearance WITH (UPDLOCK, HOLDLOCK)
            ON clearance.enrollment_id = enrollment.id
          WHERE enrollment.student_id = @studentId AND enrollment.enrollment_status = N'pending_payment'
            AND enrollment.finalized_at IS NULL AND clearance.created_for_intake = 1`);
      if (pendingIntake.recordset?.length) {
        throw new StudentRecordsError('This student has a pending new-student intake. Finance must clear that enrollment before it can be finalized.', 409);
      }
      const term = await transaction.request().input('termId', sql.Int, enrollment.academicTermId)
        .query('SELECT id FROM dbo.academic_terms WITH (UPDLOCK, HOLDLOCK) WHERE id = @termId');
      if (!term.recordset?.length) throw new StudentRecordsError('Academic term not found.', 404);
      if (enrollment.sectionId !== null) {
        const section = await transaction.request()
          .input('sectionId', sql.Int, enrollment.sectionId)
          .input('termId', sql.Int, enrollment.academicTermId)
          .query('SELECT id FROM dbo.sections WITH (UPDLOCK, HOLDLOCK) WHERE id = @sectionId AND academic_term_id = @termId');
        if (!section.recordset?.length) {
          throw new StudentRecordsError('Choose a section that belongs to the selected academic term.');
        }
      }
      const existing = await transaction.request()
        .input('studentId', sql.Int, enrollment.studentId)
        .input('termId', sql.Int, enrollment.academicTermId)
        .query(`SELECT id FROM dbo.enrollments WITH (UPDLOCK, HOLDLOCK)
          WHERE student_id = @studentId AND academic_term_id = @termId`);
      let enrollmentId;
      let action;
      if (existing.recordset?.length) {
        enrollmentId = existing.recordset[0].id;
        action = 'enrollment_updated';
        await transaction.request()
          .input('enrollmentId', sql.Int, enrollmentId)
          .input('sectionId', sql.Int, enrollment.sectionId)
          .query('UPDATE dbo.enrollments SET section_id = @sectionId WHERE id = @enrollmentId');
      } else {
        action = 'enrollment_created';
        const result = await transaction.request()
          .input('studentId', sql.Int, enrollment.studentId)
          .input('termId', sql.Int, enrollment.academicTermId)
          .input('sectionId', sql.Int, enrollment.sectionId)
          .query(`INSERT INTO dbo.enrollments (student_id, academic_term_id, section_id)
            OUTPUT INSERTED.id AS id
            VALUES (@studentId, @termId, @sectionId)`);
        enrollmentId = result.recordset?.[0]?.id;
        if (!enrollmentId) throw new Error('Enrollment insert returned no identifier.');
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
    saveStudent, deactivateStudentLogin, archiveStudent,
    createTerm, setCurrentTerm, createSection, saveEnrollment
  };
}

module.exports = {
  StudentRecordsError,
  createStudentRecordsService,
  normalizeRecordId,
  normalizeSearchTerm,
  validateStudent,
  normalizeLrn,
  validateTerm,
  validateSection,
  validateEnrollment,
  normalizeUniqueConflict
};
