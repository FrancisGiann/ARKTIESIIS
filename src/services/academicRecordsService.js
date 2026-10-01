const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');

const ID_PATTERN = /^\d{1,10}$/;
const ACADEMIC_WRITER_ROLES = new Set(['database_admin', 'registrar']);

class AcademicRecordsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AcademicRecordsError';
    this.status = status;
  }
}

function normalizeId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

function printableText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function requiredText(value, label, maxLength) {
  const text = printableText(value, maxLength);
  if (!text) throw new AcademicRecordsError(`${label} is required and must be ${maxLength} characters or fewer.`);
  return text;
}

function recordInput(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

function optionalId(value, label) {
  const id = normalizeId(value);
  if (!id) throw new AcademicRecordsError(`Choose a valid ${label.toLowerCase()}.`);
  return id;
}

function normalizeUnits(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new AcademicRecordsError('Units must be a positive number with up to two decimal places.');
  }
  const units = Number(raw);
  if (!Number.isFinite(units) || units <= 0 || units > 999.99) {
    throw new AcademicRecordsError('Units must be between 0.01 and 999.99.');
  }
  return units;
}

function validateSubject(input = {}) {
  input = recordInput(input);
  const code = requiredText(input.subjectCode, 'Subject code', 50);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(code)) {
    throw new AcademicRecordsError('Subject code may contain letters, numbers, spaces, periods, underscores, slashes, and hyphens.');
  }
  const subjectName = requiredText(input.subjectName, 'Subject name', 200);
  return { subjectCode: code.toUpperCase(), subjectName, units: normalizeUnits(input.units) };
}

function validateAssignment(input = {}) {
  input = recordInput(input);
  return {
    studentId: optionalId(input.studentId, 'student'),
    enrollmentId: optionalId(input.enrollmentId, 'enrollment'),
    subjectId: optionalId(input.subjectId, 'subject')
  };
}

function normalizeGradeValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,3}(?:\.\d{1,2})?$/.test(raw)) {
    throw new AcademicRecordsError('Grade must be a number from 0 to 100 with up to two decimal places.');
  }
  const grade = Number(raw);
  if (!Number.isFinite(grade) || grade < 0 || grade > 100) {
    throw new AcademicRecordsError('Grade must be between 0 and 100.');
  }
  return grade;
}

function validateGrade(input = {}) {
  input = recordInput(input);
  const studentId = optionalId(input.studentId, 'student');
  const studentSubjectId = optionalId(input.studentSubjectId, 'enrollment subject');
  const gradeId = input.gradeId === undefined || input.gradeId === null || input.gradeId === ''
    ? null
    : optionalId(input.gradeId, 'grade');
  const gradingPeriod = requiredText(input.gradingPeriod, 'Grading period', 50);
  const remarks = input.remarks === undefined || input.remarks === null || input.remarks === ''
    ? null
    : printableText(input.remarks, 100);
  if (remarks === null && input.remarks !== undefined && input.remarks !== null && input.remarks !== '') {
    throw new AcademicRecordsError('Remarks must be 100 printable characters or fewer.');
  }
  return {
    studentId,
    studentSubjectId,
    gradeId,
    gradingPeriod,
    gradeValue: normalizeGradeValue(input.gradeValue),
    remarks
  };
}

function isUniqueConflict(error) {
  return isDuplicateKeyError(error);
}

function createAcademicRecordsService({
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
          // Preserve the original error without exposing database details to the caller.
        }
      }
      throw error;
    }
  }

  async function requireAcademicWriter(transaction, actorId) {
    const id = normalizeId(actorId);
    if (!id) throw new AcademicRecordsError('Academic record access is required.', 403);
    const result = await transaction.request()
      .input('actorId', sql.Int, id)
      .input('databaseAdminRole', sql.NVarChar(30), 'database_admin')
      .input('registrarRole', sql.NVarChar(30), 'registrar')
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN (@databaseAdminRole, @registrarRole) FOR UPDATE`);
    const actor = result.recordset?.[0];
    if (!actor || !ACADEMIC_WRITER_ROLES.has(actor.role)) {
      throw new AcademicRecordsError('Academic record access is no longer active. Sign in again.', 403);
    }
    return actor;
  }

  async function writeAudit(transaction, { actorId, actorRole, action, entityType, entityId, details }) {
    await transaction.request()
      .input('actorId', sql.Int, actorId)
      .input('action', sql.NVarChar(100), `${actorRole}.${action}`)
      .input('entityType', sql.NVarChar(100), entityType)
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details || {}))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  async function listSubjects() {
    const pool = await getPool();
    const result = await pool.request().query(`SELECT id, subject_code, subject_name, units
      FROM subjects ORDER BY subject_code, id`);
    return result.recordset || [];
  }

  async function getStudentAcademicRecord(studentInput) {
    const studentId = normalizeId(studentInput);
    if (!studentId) throw new AcademicRecordsError('Student record not found.', 404);
    const pool = await getPool();
    const studentResult = await pool.request()
      .input('studentId', sql.Int, studentId)
      .query(`SELECT id, student_no, first_name, middle_name, last_name, suffix,
        birth_date, sex, address, phone, status
        FROM students WHERE id = @studentId`);
    const student = studentResult.recordset?.[0];
    if (!student) return null;

    const [enrollmentResult, subjects, assignmentResult] = await Promise.all([
      pool.request().input('studentId', sql.Int, studentId).query(`
        SELECT e.id, e.academic_term_id, e.section_id, e.enrollment_status, e.enrolled_at,
          t.school_year, t.term, t.is_current, s.name AS section_name, s.grade_level
        FROM enrollments AS e
        INNER JOIN academic_terms AS t ON t.id = e.academic_term_id
        LEFT JOIN sections AS s ON s.id = e.section_id AND s.academic_term_id = e.academic_term_id
        WHERE e.student_id = @studentId
        ORDER BY t.is_current DESC, t.id DESC, e.id DESC`),
      listSubjects(),
      pool.request().input('studentId', sql.Int, studentId).query(`
        SELECT ss.id AS student_subject_id, ss.enrollment_id,
          sub.id AS subject_id, sub.subject_code, sub.subject_name, sub.units,
          g.id AS grade_id, g.grading_period, g.grade_value, g.remarks
        FROM student_subjects AS ss
        INNER JOIN enrollments AS e ON e.id = ss.enrollment_id
        INNER JOIN subjects AS sub ON sub.id = ss.subject_id
        LEFT JOIN grades AS g ON g.student_subject_id = ss.id
        WHERE e.student_id = @studentId
        ORDER BY ss.enrollment_id, sub.subject_code, g.grading_period`)
    ]);

    const enrollments = (enrollmentResult.recordset || []).map((enrollment) => ({ ...enrollment, subjects: [] }));
    const enrollmentById = new Map(enrollments.map((enrollment) => [enrollment.id, enrollment]));
    const assignmentById = new Map();
    for (const row of assignmentResult.recordset || []) {
      let assignment = assignmentById.get(row.student_subject_id);
      if (!assignment) {
        assignment = {
          id: row.student_subject_id,
          subjectId: row.subject_id,
          subjectCode: row.subject_code,
          subjectName: row.subject_name,
          units: row.units,
          grades: []
        };
        assignmentById.set(row.student_subject_id, assignment);
        enrollmentById.get(row.enrollment_id)?.subjects.push(assignment);
      }
      if (row.grade_id !== null && row.grade_id !== undefined) {
        assignment.grades.push({
          id: row.grade_id,
          gradingPeriod: row.grading_period,
          gradeValue: row.grade_value,
          remarks: row.remarks
        });
      }
    }
    return { student, enrollments, subjects };
  }

  async function getOwnGrades(userInput) {
    const userId = normalizeId(userInput);
    if (!userId) return [];
    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.Int, userId)
      .query(`SELECT g.id, g.grading_period, g.grade_value, g.remarks,
          sub.subject_code, sub.subject_name, sub.units,
          t.school_year, t.term, e.id AS enrollment_id
        FROM students AS st
        INNER JOIN enrollments AS e ON e.student_id = st.id
        INNER JOIN academic_terms AS t ON t.id = e.academic_term_id
        INNER JOIN student_subjects AS ss ON ss.enrollment_id = e.id
        INNER JOIN subjects AS sub ON sub.id = ss.subject_id
        INNER JOIN grades AS g ON g.student_subject_id = ss.id
        WHERE st.user_id = @userId
        ORDER BY t.id DESC, sub.subject_code, g.grading_period`);
    return result.recordset || [];
  }

  async function saveSubject(actorId, subjectInput, input) {
    const subjectId = subjectInput === null || subjectInput === undefined ? null : normalizeId(subjectInput);
    if (subjectInput !== null && subjectInput !== undefined && !subjectId) {
      throw new AcademicRecordsError('Subject not found.', 404);
    }
    const subject = validateSubject(input);
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicWriter(transaction, actorId);
      if (subjectId !== null) {
        const current = await transaction.request().input('subjectId', sql.Int, subjectId)
          .query('SELECT id FROM subjects WHERE id = @subjectId FOR UPDATE');
        if (!current.recordset?.length) throw new AcademicRecordsError('Subject not found.', 404);
      }
      const duplicate = await transaction.request()
        .input('subjectCode', sql.NVarChar(50), subject.subjectCode)
        .input('subjectId', sql.Int, subjectId)
        .query(`SELECT id FROM subjects
          WHERE subject_code = @subjectCode AND (@subjectId IS NULL OR id <> @subjectId) FOR UPDATE`);
      if (duplicate.recordset?.length) throw new AcademicRecordsError('That subject code is already in use.', 409);

      let savedId = subjectId;
      if (subjectId === null) {
        const result = await transaction.request()
          .input('subjectCode', sql.NVarChar(50), subject.subjectCode)
          .input('subjectName', sql.NVarChar(200), subject.subjectName)
          .input('units', sql.Decimal(5, 2), subject.units)
          .query(`INSERT INTO subjects (subject_code, subject_name, units)
            VALUES (@subjectCode, @subjectName, @units)`);
        savedId = result.insertId;
        if (!savedId) throw new Error('Subject insert returned no identifier.');
      } else {
        await transaction.request()
          .input('subjectId', sql.Int, subjectId)
          .input('subjectCode', sql.NVarChar(50), subject.subjectCode)
          .input('subjectName', sql.NVarChar(200), subject.subjectName)
          .input('units', sql.Decimal(5, 2), subject.units)
          .query(`UPDATE subjects SET subject_code = @subjectCode,
            subject_name = @subjectName, units = @units WHERE id = @subjectId`);
      }
      await writeAudit(transaction, {
        actorId, actorRole: actor.role, action: subjectId === null ? 'subject_created' : 'subject_updated',
        entityType: 'subject', entityId: savedId, details: { subjectCode: subject.subjectCode }
      });
      return savedId;
    });
  }

  async function assignSubject(actorId, input) {
    const assignment = validateAssignment(input);
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicWriter(transaction, actorId);
      const enrollment = await transaction.request()
        .input('enrollmentId', sql.Int, assignment.enrollmentId)
        .input('studentId', sql.Int, assignment.studentId)
        .query(`SELECT e.id, e.student_id, st.status FROM enrollments AS e
          INNER JOIN students AS st ON st.id = e.student_id
          WHERE e.id = @enrollmentId AND e.student_id = @studentId FOR UPDATE`);
      if (!enrollment.recordset?.length) throw new AcademicRecordsError('Enrollment not found for this student.', 404);
      if (enrollment.recordset[0].status === 'archived') {
        throw new AcademicRecordsError('Archived students cannot receive new academic records.', 409);
      }
      const subject = await transaction.request().input('subjectId', sql.Int, assignment.subjectId)
        .query('SELECT id FROM subjects WHERE id = @subjectId FOR UPDATE');
      if (!subject.recordset?.length) throw new AcademicRecordsError('Subject not found.', 404);
      const existing = await transaction.request()
        .input('enrollmentId', sql.Int, assignment.enrollmentId)
        .input('subjectId', sql.Int, assignment.subjectId)
        .query(`SELECT id FROM student_subjects
          WHERE enrollment_id = @enrollmentId AND subject_id = @subjectId FOR UPDATE`);
      if (existing.recordset?.length) throw new AcademicRecordsError('This subject is already assigned to the enrollment.', 409);
      const result = await transaction.request()
        .input('enrollmentId', sql.Int, assignment.enrollmentId)
        .input('subjectId', sql.Int, assignment.subjectId)
        .query(`INSERT INTO student_subjects (enrollment_id, subject_id)
          VALUES (@enrollmentId, @subjectId)`);
      const assignmentId = result.insertId;
      if (!assignmentId) throw new Error('Enrollment subject insert returned no identifier.');
      await writeAudit(transaction, {
        actorId, actorRole: actor.role, action: 'subject_assigned', entityType: 'student_subject', entityId: assignmentId,
        details: { studentId: assignment.studentId, enrollmentId: assignment.enrollmentId, subjectId: assignment.subjectId }
      });
      return assignment.studentId;
    });
  }

  async function saveGrade(actorId, input) {
    const grade = validateGrade(input);
    return runTransaction(async (transaction) => {
      const actor = await requireAcademicWriter(transaction, actorId);
      const enrollmentSubject = await transaction.request()
        .input('studentSubjectId', sql.Int, grade.studentSubjectId)
        .input('studentId', sql.Int, grade.studentId)
        .query(`SELECT ss.id, e.student_id, st.status FROM student_subjects AS ss
          INNER JOIN enrollments AS e ON e.id = ss.enrollment_id
          INNER JOIN students AS st ON st.id = e.student_id
          WHERE ss.id = @studentSubjectId AND e.student_id = @studentId FOR UPDATE`);
      if (!enrollmentSubject.recordset?.length) {
        throw new AcademicRecordsError('Enrollment subject not found for this student.', 404);
      }
      if (enrollmentSubject.recordset[0].status === 'archived') {
        throw new AcademicRecordsError('Archived students cannot receive new academic records.', 409);
      }
      let existing;
      if (grade.gradeId !== null) {
        existing = await transaction.request()
          .input('gradeId', sql.Int, grade.gradeId)
          .input('studentSubjectId', sql.Int, grade.studentSubjectId)
          .query(`SELECT id FROM grades
            WHERE id = @gradeId AND student_subject_id = @studentSubjectId FOR UPDATE`);
        if (!existing.recordset?.length) throw new AcademicRecordsError('Grade not found for this enrollment subject.', 404);
        const periodConflict = await transaction.request()
          .input('gradeId', sql.Int, grade.gradeId)
          .input('studentSubjectId', sql.Int, grade.studentSubjectId)
          .input('gradingPeriod', sql.NVarChar(50), grade.gradingPeriod)
          .query(`SELECT id FROM grades
            WHERE student_subject_id = @studentSubjectId AND grading_period = @gradingPeriod AND id <> @gradeId FOR UPDATE`);
        if (periodConflict.recordset?.length) {
          throw new AcademicRecordsError('A grade for this enrollment subject and grading period already exists.', 409);
        }
      } else {
        existing = await transaction.request()
          .input('studentSubjectId', sql.Int, grade.studentSubjectId)
          .input('gradingPeriod', sql.NVarChar(50), grade.gradingPeriod)
          .query(`SELECT id FROM grades
            WHERE student_subject_id = @studentSubjectId AND grading_period = @gradingPeriod FOR UPDATE`);
      }
      let gradeId;
      let action;
      if (existing.recordset?.length) {
        gradeId = existing.recordset[0].id;
        action = 'grade_updated';
        await transaction.request()
          .input('gradeId', sql.Int, gradeId)
          .input('gradingPeriod', sql.NVarChar(50), grade.gradingPeriod)
          .input('gradeValue', sql.Decimal(6, 2), grade.gradeValue)
          .input('remarks', sql.NVarChar(100), grade.remarks)
          .input('actorId', sql.Int, actor.id)
          .query(`UPDATE grades SET grading_period = @gradingPeriod, grade_value = @gradeValue, remarks = @remarks,
            recorded_by = @actorId, recorded_at = UTC_TIMESTAMP(6) WHERE id = @gradeId`);
      } else {
        action = 'grade_created';
        const result = await transaction.request()
          .input('studentSubjectId', sql.Int, grade.studentSubjectId)
          .input('gradingPeriod', sql.NVarChar(50), grade.gradingPeriod)
          .input('gradeValue', sql.Decimal(6, 2), grade.gradeValue)
          .input('remarks', sql.NVarChar(100), grade.remarks)
          .input('actorId', sql.Int, actor.id)
          .query(`INSERT INTO grades
            (student_subject_id, grading_period, grade_value, remarks, recorded_by)
            VALUES (@studentSubjectId, @gradingPeriod, @gradeValue, @remarks, @actorId)`);
        gradeId = result.insertId;
        if (!gradeId) throw new Error('Grade insert returned no identifier.');
      }
      await writeAudit(transaction, {
        actorId: actor.id, actorRole: actor.role, action, entityType: 'grade', entityId: gradeId,
        details: { studentId: grade.studentId, studentSubjectId: grade.studentSubjectId, gradingPeriod: grade.gradingPeriod }
      });
      return grade.studentId;
    });
  }

  return { listSubjects, getStudentAcademicRecord, getOwnGrades, saveSubject, assignSubject, saveGrade };
}

module.exports = {
  AcademicRecordsError,
  createAcademicRecordsService,
  normalizeId,
  validateSubject,
  validateAssignment,
  validateGrade,
  normalizeUnits,
  normalizeGradeValue,
  isUniqueConflict
};
