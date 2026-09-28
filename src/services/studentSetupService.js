const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const {
  StudentRecordsError,
  normalizeRecordId,
  validateStudent
} = require('./studentRecordsService');
const { allocateStudentNumber, StudentNumberAllocationError } = require('./studentNumberAllocator');

const BCRYPT_ROUNDS = 12;
const MAX_BULK_ROWS = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class StudentSetupError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.name = 'StudentSetupError';
    this.status = status;
    this.details = details;
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 255 || /[\u0000-\u001f\u007f]/.test(email) || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

function workbookCellText(value, maxLength) {
  if (typeof value === 'string') return value.trim().slice(0, maxLength + 1);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return '';
}

function normalizeBulkRows(inputRows) {
  if (!Array.isArray(inputRows) || inputRows.length < 1 || inputRows.length > MAX_BULK_ROWS) {
    throw new StudentSetupError(`The workbook must contain 1 to ${MAX_BULK_ROWS} student rows.`);
  }
  const rows = [];
  const seenStudentNumbers = new Map();
  const seenEmails = new Map();
  for (let index = 0; index < inputRows.length; index += 1) {
    const input = inputRows[index] && typeof inputRows[index] === 'object' ? inputRows[index] : {};
    const rowNumber = Number.isSafeInteger(input.rowNumber) && input.rowNumber > 1 ? input.rowNumber : index + 2;
    const studentNo = workbookCellText(input.studentNo, 50);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!studentNo && !email) continue;
    const errors = [];
    if (!studentNo) errors.push('Student number is required.');
    else if (studentNo.length > 50 || /[\u0000-\u001f\u007f]/.test(studentNo)) errors.push('Student number must be 50 printable characters or fewer.');
    if (!email) errors.push('Email is required.');
    else if (!normalizeEmail(email)) errors.push('Enter a valid email address of 255 characters or fewer.');

    const normalizedStudentNo = studentNo.toLocaleLowerCase();
    const normalizedEmail = email.toLocaleLowerCase();
    if (studentNo && seenStudentNumbers.has(normalizedStudentNo)) {
      errors.push(`Student number duplicates workbook row ${seenStudentNumbers.get(normalizedStudentNo)}.`);
    } else if (studentNo) seenStudentNumbers.set(normalizedStudentNo, rowNumber);
    if (email && seenEmails.has(normalizedEmail)) {
      errors.push(`Email duplicates workbook row ${seenEmails.get(normalizedEmail)}.`);
    } else if (email) seenEmails.set(normalizedEmail, rowNumber);

    rows.push({ rowNumber, studentNo, email: normalizeEmail(email) || email, errors });
  }
  if (!rows.length) throw new StudentSetupError('No student rows were found in the workbook.');
  if (rows.length > MAX_BULK_ROWS) throw new StudentSetupError(`The workbook cannot contain more than ${MAX_BULK_ROWS} student rows.`);
  return rows;
}

function createTemporaryPassword() {
  return crypto.randomBytes(18).toString('hex');
}

function normalizeBulkResultRows(rows) {
  const normalized = normalizeBulkRows(rows);
  const valid = normalized.filter((row) => row.errors.length === 0);
  return { rows: normalized, valid };
}

function createStudentSetupService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  hashPassword = bcrypt.hash,
  createPassword = createTemporaryPassword
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
        try { await transaction.rollback(); } catch { /* Keep the original failure. */ }
      }
      throw error;
    }
  }

  async function requireActor(request, actorInput, role) {
    const actorId = normalizeRecordId(actorInput, 'user');
    if (!actorId) throw new StudentSetupError(`${role === 'database_admin' ? 'Database administrator' : 'Registrar'} access is required.`, 403);
    const result = await request
      .input('actorId', sql.Int, actorId)
      .input('requiredRole', sql.NVarChar(30), role)
      .query(`SELECT id, role FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @actorId AND is_active = 1 AND role = @requiredRole`);
    const actor = result.recordset?.[0];
    if (!actor) throw new StudentSetupError('Your access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function writeAudit(transaction, actor, action, entityType, entityId, details = {}) {
    await transaction.request()
      .input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), `${actor.role}.${action}`)
      .input('entityType', sql.NVarChar(100), entityType)
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  function rowsJson(rows) {
    return JSON.stringify(rows.map(({ rowNumber, studentNo, email }) => ({ rowNumber, studentNo, email })));
  }

  function attachDatabaseErrors(rows, databaseRows) {
    const byRow = new Map((databaseRows || []).map((row) => [Number(row.row_number), row]));
    return rows.map((row) => {
      const errors = [...row.errors];
      if (!row.errors.length) {
        const existing = byRow.get(row.rowNumber);
        if (!existing?.student_id) errors.push('No existing student record matches this student number.');
        else if (existing.student_status === 'archived') errors.push('Archived student records cannot receive a login account.');
        else if (existing.user_id) errors.push('This student already has a linked login account.');
        if (existing?.email_user_id) errors.push('This email is already used by a login account.');
        if (existing?.pending_email_id) errors.push('This email is reserved by a pending account email change.');
      }
      return { rowNumber: row.rowNumber, studentNo: row.studentNo, email: row.email, errors };
    });
  }

  async function lookupBulkRows(request, rows) {
    return request
      .input('rowsJson', sql.NVarChar(sql.MAX), rowsJson(rows))
      .query(`WITH input_rows AS (
          SELECT row_number, student_no, email
          FROM OPENJSON(@rowsJson) WITH (
            row_number INT '$.rowNumber',
            student_no NVARCHAR(50) '$.studentNo',
            email NVARCHAR(255) '$.email'
          )
        )
        SELECT input.row_number, student.id AS student_id, student.user_id,
          student.status AS student_status, account.id AS email_user_id,
          pending.id AS pending_email_id
        FROM input_rows AS input
        LEFT JOIN dbo.students AS student WITH (UPDLOCK, HOLDLOCK)
          ON student.student_no = input.student_no
        LEFT JOIN dbo.users AS account WITH (UPDLOCK, HOLDLOCK)
          ON LOWER(account.email) = input.email
        LEFT JOIN dbo.pending_email_changes AS pending WITH (UPDLOCK, HOLDLOCK)
          ON LOWER(pending.new_email) = input.email
          AND pending.consumed_at IS NULL AND pending.expires_at > SYSUTCDATETIME()
        ORDER BY input.row_number`);
  }

  async function previewBulkStudentAccounts(actorInput, inputRows) {
    const { rows, valid } = normalizeBulkResultRows(inputRows);
    const pool = await getPool();
    await requireActor(pool.request(), actorInput, 'database_admin');
    if (!valid.length) return { rows, validRows: [], valid: false };
    const matches = await lookupBulkRows(pool.request(), valid);
    const previewRows = attachDatabaseErrors(rows, matches.recordset);
    const validRows = previewRows.filter((row) => row.errors.length === 0);
    return { rows: previewRows, validRows, valid: validRows.length === previewRows.length };
  }

  async function createBulkStudentAccounts(actorInput, inputRows) {
    const { rows, valid } = normalizeBulkResultRows(inputRows);
    if (rows.some((row) => row.errors.length)) {
      throw new StudentSetupError('The roster contains invalid rows. Upload a corrected workbook and preview it again.', 409, rows);
    }
    if (!valid.length) throw new StudentSetupError('No valid student rows are available for setup.');

    const pool = await getPool();
    await requireActor(pool.request(), actorInput, 'database_admin');
    const credentials = [];
    const usedPasswords = new Set();
    for (const row of valid) {
      let password;
      let attempts = 0;
      do {
        password = createPassword();
        attempts += 1;
        if (attempts > 10) throw new Error('A distinct temporary password could not be generated.');
      } while (usedPasswords.has(password));
      usedPasswords.add(password);
      credentials.push({ ...row, password });
    }
    let nextCredential = 0;
    const hashWorkers = Array.from({ length: Math.min(4, credentials.length) }, async () => {
      while (nextCredential < credentials.length) {
        const credential = credentials[nextCredential];
        nextCredential += 1;
        credential.passwordHash = await hashPassword(credential.password, BCRYPT_ROUNDS);
      }
    });
    await Promise.all(hashWorkers);

    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorInput, 'database_admin');
      const matches = await lookupBulkRows(transaction.request(), valid);
      const currentRows = attachDatabaseErrors(rows, matches.recordset);
      const invalidRows = currentRows.filter((row) => row.errors.length);
      if (invalidRows.length) {
        throw new StudentSetupError('The roster changed after preview. No accounts were created; review the row errors and preview again.', 409, currentRows);
      }

      for (const credential of credentials) {
        const inserted = await transaction.request()
          .input('email', sql.NVarChar(255), credential.email)
          .input('passwordHash', sql.NVarChar(255), credential.passwordHash)
          .input('mustChangePassword', sql.Bit, true)
          .query(`INSERT INTO dbo.users (email, password_hash, role, is_active, must_change_password)
            OUTPUT INSERTED.id AS user_id
            VALUES (@email, @passwordHash, N'student', 1, @mustChangePassword)`);
        const userId = inserted.recordset?.[0]?.user_id;
        if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Student account insert returned no identifier.');
        const linked = await transaction.request()
          .input('userId', sql.Int, userId)
          .input('studentNo', sql.NVarChar(50), credential.studentNo)
          .query(`UPDATE dbo.students SET user_id = @userId
            WHERE student_no = @studentNo AND user_id IS NULL AND status <> N'archived'`);
        if (linked.rowsAffected?.[0] !== 1) {
          throw new StudentSetupError('A student account changed while the roster was being confirmed. No accounts were created.', 409);
        }
      }
      await writeAudit(transaction, actor, 'student_accounts_bulk_created', 'student_account_setup', actor.id, {
        accountCount: credentials.length,
        existingStudentRecordsOnly: true
      });
      return credentials.map(({ rowNumber, studentNo, email, password }) => ({ rowNumber, studentNo, email, password }));
    });
  }

  async function loadIntakeOptions(actorInput) {
    const pool = await getPool();
    await requireActor(pool.request(), actorInput, 'registrar');
    const result = await pool.request().query(`
      SELECT id, school_year, term, is_current FROM dbo.academic_terms ORDER BY is_current DESC, id DESC;
      SELECT section.id, section.name, section.grade_level, section.academic_term_id,
        term.school_year, term.term
      FROM dbo.sections AS section
      INNER JOIN dbo.academic_terms AS term ON term.id = section.academic_term_id
      ORDER BY term.is_current DESC, term.id DESC, section.grade_level, section.name;
    `);
    return { terms: result.recordsets?.[0] || [], sections: result.recordsets?.[1] || [] };
  }

  async function listPendingIntakes(actorInput) {
    const pool = await getPool();
    await requireActor(pool.request(), actorInput, 'registrar');
    const result = await pool.request().query(`SELECT enrollment.id AS enrollment_id,
        student.id AS student_id, student.student_no, student.first_name, student.middle_name,
        student.last_name, student.suffix, account.email,
        term.school_year, term.term, section.name AS section_name,
        COALESCE(clearance.clearance_status, N'pending') AS clearance_status
      FROM dbo.enrollments AS enrollment
      INNER JOIN dbo.students AS student ON student.id = enrollment.student_id
      INNER JOIN dbo.users AS account ON account.id = student.user_id AND account.role = N'student'
      INNER JOIN dbo.academic_terms AS term ON term.id = enrollment.academic_term_id
      LEFT JOIN dbo.sections AS section ON section.id = enrollment.section_id
        AND section.academic_term_id = enrollment.academic_term_id
      INNER JOIN dbo.enrollment_clearances AS clearance ON clearance.enrollment_id = enrollment.id
      WHERE clearance.created_for_intake = 1
        AND enrollment.enrollment_status = N'pending_payment' AND enrollment.finalized_at IS NULL
      ORDER BY enrollment.id DESC`);
    return result.recordset || [];
  }

  async function createEnrollmentIntake(actorInput, input) {
    let profile;
    try { profile = validateStudent(input, { requireStudentNo: false }); }
    catch (error) {
      if (error instanceof StudentRecordsError) throw new StudentSetupError(error.message, error.status);
      throw error;
    }
    const email = normalizeEmail(input.email);
    if (!email) throw new StudentSetupError('Enter a valid contact email address.');
    const termId = normalizeRecordId(input.academicTermId, 'academic term');
    if (!termId) throw new StudentSetupError('Choose an existing academic term.');
    const sectionId = normalizeRecordId(input.sectionId, 'section');
    if (!sectionId) throw new StudentSetupError('Choose an existing section for the selected term.');

    const placeholderHash = await hashPassword(createPassword(), BCRYPT_ROUNDS);
    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorInput, 'registrar');
      const sectionResult = await transaction.request()
        .input('sectionId', sql.Int, sectionId)
        .input('termId', sql.Int, termId)
        .query(`SELECT section.id, term.school_year FROM dbo.academic_terms AS term WITH (UPDLOCK, HOLDLOCK)
          LEFT JOIN dbo.sections AS section WITH (UPDLOCK, HOLDLOCK)
            ON section.academic_term_id = term.id AND section.id = @sectionId
          WHERE term.id = @termId`);
      const selectedTerm = sectionResult.recordset?.[0];
      if (!selectedTerm) throw new StudentSetupError('Choose an existing academic term.', 404);
      if (!selectedTerm.id) throw new StudentSetupError('Choose a section that belongs to the selected term.', 409);
      let studentNo;
      try { studentNo = await allocateStudentNumber(transaction, sql, selectedTerm.school_year); }
      catch (error) {
        if (error instanceof StudentNumberAllocationError) throw new StudentSetupError(error.message, error.status);
        throw error;
      }
      const conflictResult = await transaction.request()
        .input('studentNo', sql.NVarChar(50), studentNo)
        .input('lrn', sql.NVarChar(12), profile.lrn)
        .input('email', sql.NVarChar(255), email)
        .query(`SELECT
          CASE WHEN EXISTS (SELECT 1 FROM dbo.students WITH (UPDLOCK, HOLDLOCK) WHERE student_no = @studentNo) THEN 1 ELSE 0 END AS student_no_exists,
          CASE WHEN EXISTS (SELECT 1 FROM dbo.students WITH (UPDLOCK, HOLDLOCK) WHERE lrn = @lrn) THEN 1 ELSE 0 END AS lrn_exists,
          CASE WHEN EXISTS (SELECT 1 FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE LOWER(email) = @email) THEN 1 ELSE 0 END AS email_exists,
          CASE WHEN EXISTS (SELECT 1 FROM dbo.pending_email_changes WITH (UPDLOCK, HOLDLOCK)
            WHERE LOWER(new_email) = @email AND consumed_at IS NULL AND expires_at > SYSUTCDATETIME()) THEN 1 ELSE 0 END AS pending_email_exists`);
      const conflicts = conflictResult.recordset?.[0] || {};
      if (Number(conflicts.student_no_exists)) throw new StudentSetupError('Automatic student number allocation conflicted with an existing record. Retry the intake.', 409);
      if (Number(conflicts.lrn_exists)) throw new StudentSetupError('That LRN is already in use.', 409);
      if (Number(conflicts.email_exists) || Number(conflicts.pending_email_exists)) throw new StudentSetupError('That email address is already in use or reserved.', 409);

      const userResult = await transaction.request()
        .input('email', sql.NVarChar(255), email)
        .input('passwordHash', sql.NVarChar(255), placeholderHash)
        .input('mustChangePassword', sql.Bit, true)
        .query(`INSERT INTO dbo.users (email, password_hash, role, is_active, must_change_password)
          OUTPUT INSERTED.id AS user_id
          VALUES (@email, @passwordHash, N'student', 0, @mustChangePassword)`);
      const userId = userResult.recordset?.[0]?.user_id;
      if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Student login insert returned no identifier.');

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
        .input('phone', sql.NVarChar(50), profile.phone)
        .query(`DECLARE @insertedStudents TABLE (id INT);
          INSERT INTO dbo.students
          (user_id, student_no, lrn, first_name, middle_name, last_name, suffix, birth_date, sex, address, phone)
          OUTPUT INSERTED.id INTO @insertedStudents(id)
          VALUES (@userId, @studentNo, @lrn, @firstName, @middleName, @lastName, @suffix, @birthDate, @sex, @address, @phone);
          SELECT id AS student_id FROM @insertedStudents`);
      const studentId = studentResult.recordset?.[0]?.student_id;
      if (!Number.isSafeInteger(studentId) || studentId < 1) throw new Error('Student profile insert returned no identifier.');

      const enrollmentResult = await transaction.request()
        .input('studentId', sql.Int, studentId)
        .input('termId', sql.Int, termId)
        .input('sectionId', sql.Int, sectionId)
        .query(`INSERT INTO dbo.enrollments (student_id, academic_term_id, section_id, enrollment_status)
          OUTPUT INSERTED.id AS enrollment_id
          VALUES (@studentId, @termId, @sectionId, N'pending_payment')`);
      const enrollmentId = enrollmentResult.recordset?.[0]?.enrollment_id;
      if (!Number.isSafeInteger(enrollmentId) || enrollmentId < 1) throw new Error('Enrollment insert returned no identifier.');
      await transaction.request()
        .input('enrollmentId', sql.Int, enrollmentId)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO dbo.enrollment_clearances (enrollment_id, clearance_status, created_by, created_for_intake)
          VALUES (@enrollmentId, N'pending', @actorId, 1)`);

      await writeAudit(transaction, actor, 'student_enrollment_intake_created', 'enrollment', enrollmentId, {
        clearanceStatus: 'pending',
        loginInitiallyInactive: true
      });
      return enrollmentId;
    });
  }

  async function finalizeEnrollment(actorInput, enrollmentInput) {
    const enrollmentId = normalizeRecordId(enrollmentInput, 'enrollment');
    if (!enrollmentId) throw new StudentSetupError('Enrollment not found.', 404);
    const temporaryPassword = createPassword();
    const passwordHash = await hashPassword(temporaryPassword, BCRYPT_ROUNDS);
    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorInput, 'registrar');
      const selected = await transaction.request()
        .input('enrollmentId', sql.Int, enrollmentId)
        .query(`SELECT enrollment.id AS enrollment_id, enrollment.enrollment_status,
          enrollment.finalized_at, student.id AS student_id, student.student_no, student.status AS student_status, student.user_id,
          student.first_name, student.middle_name, student.last_name, student.suffix,
          account.email, account.is_active, term.school_year, term.term, section.name AS section_name,
          clearance.clearance_status, clearance.created_for_intake
        FROM dbo.enrollments AS enrollment WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN dbo.students AS student WITH (UPDLOCK, HOLDLOCK) ON student.id = enrollment.student_id
        INNER JOIN dbo.users AS account WITH (UPDLOCK, HOLDLOCK) ON account.id = student.user_id
        INNER JOIN dbo.academic_terms AS term WITH (UPDLOCK, HOLDLOCK) ON term.id = enrollment.academic_term_id
        LEFT JOIN dbo.sections AS section WITH (UPDLOCK, HOLDLOCK) ON section.id = enrollment.section_id
          AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN dbo.enrollment_clearances AS clearance WITH (UPDLOCK, HOLDLOCK)
          ON clearance.enrollment_id = enrollment.id
        WHERE enrollment.id = @enrollmentId AND account.role = N'student'`);
      const row = selected.recordset?.[0];
      if (!row) throw new StudentSetupError('Enrollment not found.', 404);
      if (row.enrollment_status !== 'pending_payment' || row.finalized_at) {
        throw new StudentSetupError('This enrollment has already been finalized or is no longer pending.', 409);
      }
      if (!(row.created_for_intake === true || row.created_for_intake === 1)) {
        throw new StudentSetupError('This enrollment was not created through the new-student intake workflow.', 409);
      }
      if (row.clearance_status !== 'cleared') throw new StudentSetupError('Finance has not cleared this enrollment.', 409);
      if (row.student_status !== 'active') throw new StudentSetupError('Only an active student record can be finalized.', 409);
      if (row.is_active === true || row.is_active === 1) {
        throw new StudentSetupError('This student login is already active and cannot be reactivated through enrollment intake.', 409);
      }

      const activated = await transaction.request()
        .input('userId', sql.Int, row.user_id)
        .input('passwordHash', sql.NVarChar(255), passwordHash)
        .query(`UPDATE dbo.users SET is_active = 1, must_change_password = 1,
            password_hash = @passwordHash, auth_session_version = NEWID(), updated_at = SYSUTCDATETIME()
          OUTPUT INSERTED.id AS user_id
          WHERE id = @userId AND role = N'student' AND is_active = 0`);
      if (activated.recordset?.length !== 1) throw new StudentSetupError('The student login changed before finalization. No credentials were issued.', 409);
      const finalized = await transaction.request()
        .input('enrollmentId', sql.Int, enrollmentId)
        .query(`UPDATE dbo.enrollments SET enrollment_status = N'enrolled', finalized_at = SYSUTCDATETIME()
          WHERE id = @enrollmentId AND enrollment_status = N'pending_payment' AND finalized_at IS NULL`);
      if (finalized.rowsAffected?.[0] !== 1) throw new StudentSetupError('The enrollment changed before finalization. No credentials were issued.', 409);

      await writeAudit(transaction, actor, 'student_enrollment_finalized', 'enrollment', enrollmentId, {
        enrollmentStatus: 'enrolled',
        studentLoginActivated: true,
        temporaryPasswordIssued: true
      });
      return {
        enrollmentId,
        studentNo: row.student_no,
        firstName: row.first_name,
        middleName: row.middle_name,
        lastName: row.last_name,
        suffix: row.suffix,
        email: row.email,
        schoolYear: row.school_year,
        term: row.term,
        sectionName: row.section_name,
        temporaryPassword
      };
    });
  }

  return {
    previewBulkStudentAccounts,
    createBulkStudentAccounts,
    loadIntakeOptions,
    listPendingIntakes,
    createEnrollmentIntake,
    finalizeEnrollment
  };
}

module.exports = {
  MAX_BULK_ROWS,
  StudentSetupError,
  normalizeEmail,
  normalizeBulkRows,
  createTemporaryPassword,
  createStudentSetupService
};
