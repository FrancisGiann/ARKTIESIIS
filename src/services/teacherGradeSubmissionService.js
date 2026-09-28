const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const defaultEnvironment = require('../config/environment');

const ID_PATTERN = /^\d{1,10}$/;
const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024;
const STAGING_TTL_MS = 30 * 60 * 1000;

class TeacherGradeSubmissionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TeacherGradeSubmissionError';
    this.status = status;
  }
}

function normalizeId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

function normalizeUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function cleanFilename(value) {
  if (typeof value !== 'string') return 'teacher-grade-record.xlsx';
  const filename = path.basename(value.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!filename || filename.length > 255 || path.extname(filename).toLowerCase() !== '.xlsx') {
    throw new TeacherGradeSubmissionError('The workbook filename must end in .xlsx and be 255 characters or fewer.');
  }
  return filename;
}

function validateWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > MAX_WORKBOOK_BYTES
    || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new TeacherGradeSubmissionError('Choose one valid XLSX workbook no larger than 5 MB.');
  }
}

function printableReason(value, label, required) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!required && !reason) return null;
  if (reason.length < 5 || reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
    throw new TeacherGradeSubmissionError(`${label} must be 5–500 printable characters.`);
  }
  return reason;
}

function createTeacherGradeSubmissionService({
  getPool = defaultGetPool,
  sql = defaultSql,
  storageDirectory = path.resolve(__dirname, '../../storage/uploads'),
  secret = defaultEnvironment.sessionSecret,
  transactionFactory = (pool) => new sql.Transaction(pool)
} = {}) {
  const stagingDirectory = path.join(storageDirectory, 'teacher-grade-staging');
  const submissionDirectory = path.join(storageDirectory, 'teacher-grade-submissions');

  async function ensurePrivateDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  }

  async function runTransaction(callback) {
    const pool = await getPool();
    const transaction = transactionFactory(pool);
    let started = false;
    try {
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      const value = await callback(transaction);
      await transaction.commit();
      started = false;
      return value;
    } catch (error) {
      if (started) await transaction.rollback().catch(() => {});
      throw error;
    }
  }

  async function requireActor(request, actorId, roles) {
    const actor = await request.input('actorId', sql.Int, actorId)
      .query('SELECT id, role FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE id = @actorId AND is_active = 1');
    if (!actor.recordset?.length || !roles.includes(actor.recordset[0].role)) {
      throw new TeacherGradeSubmissionError('Your grade-submission access is no longer active. Sign in again.', 403);
    }
    return actor.recordset[0];
  }

  async function writeAudit(transaction, { actorId, action, entityId, details }) {
    await transaction.request()
      .input('actorId', sql.Int, actorId)
      .input('action', sql.NVarChar(100), action)
      .input('entityType', sql.NVarChar(100), 'teacher_grade_submission')
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  function sessionFingerprint(sessionId) {
    return crypto.createHmac('sha256', secret).update(`grade-import-session:${sessionId}`).digest('hex');
  }

  async function requireOwnedPreview(request, actorId, previewId, sessionId) {
    const result = await request
      .input('previewId', sql.UniqueIdentifier, previewId)
      .input('actorId', sql.Int, actorId)
      .input('sessionFingerprint', sql.Char(64), sessionFingerprint(sessionId))
      .query(`SELECT id FROM dbo.grade_import_previews WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @previewId AND uploaded_by = @actorId AND session_fingerprint = @sessionFingerprint
          AND status = N'ready' AND expires_at > SYSUTCDATETIME()`);
    if (!result.recordset?.length) throw new TeacherGradeSubmissionError('This workbook preview expired. Upload the workbook again.', 404);
  }

  async function requireAssignedPreview(request, actorId, assignmentId, previewId, sessionId) {
    const result = await request
      .input('assignmentId', sql.Int, assignmentId)
      .input('previewId', sql.UniqueIdentifier, previewId)
      .input('actorId', sql.Int, actorId)
      .input('sessionFingerprint', sql.Char(64), sessionFingerprint(sessionId))
      .query(`SELECT p.id FROM dbo.grade_import_previews AS p WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN dbo.teacher_assignments AS a WITH (UPDLOCK, HOLDLOCK)
          ON a.teacher_id = p.uploaded_by AND a.academic_term_id = p.academic_term_id AND a.subject_id = p.subject_id
        INNER JOIN dbo.academic_terms AS term ON term.id = a.academic_term_id
        INNER JOIN dbo.sections AS sec ON sec.id = a.section_id AND sec.academic_term_id = a.academic_term_id
        INNER JOIN dbo.subjects AS sub ON sub.id = a.subject_id
        WHERE p.id = @previewId AND p.uploaded_by = @actorId AND p.session_fingerprint = @sessionFingerprint
          AND p.status = N'ready' AND p.expires_at > SYSUTCDATETIME()
          AND a.id = @assignmentId AND a.is_active = 1
          AND EXISTS (SELECT 1 FROM dbo.users AS teacher WHERE teacher.id = @actorId
            AND teacher.role = N'teacher' AND teacher.is_active = 1)
          AND p.school_year = term.school_year AND p.grade_level = sec.grade_level
          AND p.section_name = sec.name AND p.subject_name = sub.subject_name`);
    if (!result.recordset?.length) throw new TeacherGradeSubmissionError('This workbook preview or class assignment is no longer available.', 404);
  }

  async function pruneStagingDirectory() {
    const currentTime = Date.now();
    let filenames = [];
    try { filenames = await fs.readdir(stagingDirectory); } catch { return; }
    await Promise.all(filenames.filter((filename) => /^[\da-f-]{36}\.xlsx$/i.test(filename)).map(async (filename) => {
      const filePath = path.join(stagingDirectory, filename);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile() && currentTime - stat.mtimeMs > STAGING_TTL_MS) await fs.unlink(filePath);
      } catch { /* Ignore files already removed by a concurrent request. */ }
    }));
  }

  async function listAssignmentOptions(actorId, filterInput = {}) {
    const pool = await getPool();
    await requireActor(pool.request(), actorId, ['database_admin', 'registrar']);
    const filters = typeof filterInput === 'string' ? { termId: filterInput } : filterInput || {};
    const termInput = filters.termId ?? '';
    const sectionInput = filters.sectionId ?? '';
    const requestedTermId = termInput === '' ? null : normalizeId(termInput);
    const requestedSectionId = sectionInput === '' ? null : normalizeId(sectionInput);
    if ((termInput !== '' && !requestedTermId) || (sectionInput !== '' && !requestedSectionId)) {
      throw new TeacherGradeSubmissionError('Choose a valid term and section filter.');
    }
    const termsResult = await pool.request().query(`SELECT id, school_year, term, is_current
      FROM dbo.academic_terms ORDER BY is_current DESC, id DESC`);
    const terms = termsResult.recordset || [];
    if (requestedTermId && !terms.some((term) => Number(term.id) === requestedTermId)) {
      throw new TeacherGradeSubmissionError('Choose a valid academic term.');
    }
    const selectedTermId = requestedTermId
      || terms.find((term) => term.is_current === true || term.is_current === 1)?.id
      || terms[0]?.id
      || null;
    const [sectionResult, subjects, teachers] = await Promise.all([
      selectedTermId
        ? pool.request().input('termId', sql.Int, selectedTermId).query(`SELECT sec.id, sec.academic_term_id,
            sec.name, sec.grade_level, term.school_year, term.term
          FROM dbo.sections AS sec INNER JOIN dbo.academic_terms AS term ON term.id = sec.academic_term_id
          WHERE sec.academic_term_id = @termId ORDER BY sec.grade_level, sec.name`)
        : Promise.resolve({ recordset: [] }),
      pool.request().query('SELECT id, subject_code, subject_name FROM dbo.subjects ORDER BY subject_code'),
      pool.request().query(`SELECT u.id, u.email, sp.first_name, sp.last_name
        FROM dbo.users AS u INNER JOIN dbo.staff_profiles AS sp ON sp.user_id = u.id
        WHERE u.role = N'teacher' AND u.is_active = 1 ORDER BY sp.last_name, sp.first_name`)
    ]);
    const sections = sectionResult.recordset || [];
    const selectedSection = requestedSectionId
      ? sections.find((section) => Number(section.id) === requestedSectionId)
      : null;
    const selectedSectionId = selectedSection?.id || null;
    const sectionFilterNotice = requestedSectionId && !selectedSection
      ? 'That section belongs to a different term. Choose a section from the selected term.'
      : null;
    const assignmentsResult = await pool.request()
      .input('termId', sql.Int, selectedTermId)
      .input('sectionId', sql.Int, selectedSectionId)
      .query(`SELECT a.id, a.teacher_id, a.academic_term_id, a.section_id, a.subject_id,
          a.is_active, a.created_at, a.revoked_at, t.school_year, t.term, sec.name AS section_name,
          sec.grade_level, sub.subject_code, sub.subject_name, sp.first_name, sp.last_name,
          (SELECT COUNT_BIG(*) FROM dbo.enrollments AS e
            INNER JOIN dbo.students AS st ON st.id = e.student_id AND st.status = N'active'
            INNER JOIN dbo.student_subjects AS ss ON ss.enrollment_id = e.id AND ss.subject_id = a.subject_id
            WHERE e.academic_term_id = a.academic_term_id AND e.section_id = a.section_id
              AND e.enrollment_status = N'enrolled') AS roster_count,
          (SELECT TOP (1) s.status FROM dbo.teacher_grade_submissions AS s
            WHERE s.assignment_id = a.id ORDER BY s.revision_number DESC) AS latest_submission_status
        FROM dbo.teacher_assignments AS a
        INNER JOIN dbo.academic_terms AS t ON t.id = a.academic_term_id
        INNER JOIN dbo.sections AS sec ON sec.id = a.section_id AND sec.academic_term_id = a.academic_term_id
        INNER JOIN dbo.subjects AS sub ON sub.id = a.subject_id
        INNER JOIN dbo.staff_profiles AS sp ON sp.user_id = a.teacher_id
        WHERE a.academic_term_id = @termId AND (@sectionId IS NULL OR a.section_id = @sectionId)
        ORDER BY a.is_active DESC, t.school_year DESC, t.term, sec.grade_level, sec.name, sub.subject_code`);
    return {
      terms, sections, subjects: subjects.recordset || [], teachers: teachers.recordset || [],
      assignments: assignmentsResult.recordset || [], selectedTermId, selectedSectionId, sectionFilterNotice
    };
  }

  async function createAssignment(actorId, input = {}) {
    const teacherId = normalizeId(input.teacherId);
    const termId = normalizeId(input.academicTermId);
    const sectionId = normalizeId(input.sectionId);
    const subjectId = normalizeId(input.subjectId);
    if (!teacherId || !termId || !sectionId || !subjectId) {
      throw new TeacherGradeSubmissionError('Choose an active teacher, term, section, and subject.');
    }
    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorId, ['database_admin', 'registrar']);
      const teacher = await transaction.request().input('teacherId', sql.Int, teacherId)
        .query(`SELECT id FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
          WHERE id = @teacherId AND role = N'teacher' AND is_active = 1`);
      if (!teacher.recordset?.length) throw new TeacherGradeSubmissionError('Choose an active teacher account.', 409);
      const context = await transaction.request()
        .input('termId', sql.Int, termId).input('sectionId', sql.Int, sectionId).input('subjectId', sql.Int, subjectId)
        .query(`SELECT term.school_year, term.term, sec.name, sec.grade_level, sub.subject_name
          FROM dbo.academic_terms AS term WITH (UPDLOCK, HOLDLOCK)
          INNER JOIN dbo.sections AS sec WITH (UPDLOCK, HOLDLOCK)
            ON sec.academic_term_id = term.id AND sec.id = @sectionId
          INNER JOIN dbo.subjects AS sub WITH (UPDLOCK, HOLDLOCK) ON sub.id = @subjectId
          WHERE term.id = @termId`);
      if (!context.recordset?.length) throw new TeacherGradeSubmissionError('The selected term, section, or subject is unavailable.', 404);
      const approved = await transaction.request()
        .input('termId', sql.Int, termId).input('sectionId', sql.Int, sectionId).input('subjectId', sql.Int, subjectId)
        .query(`SELECT TOP (1) s.id
          FROM dbo.teacher_grade_submissions AS s WITH (UPDLOCK, HOLDLOCK)
          INNER JOIN dbo.teacher_assignments AS a ON a.id = s.assignment_id
          WHERE a.academic_term_id = @termId AND a.section_id = @sectionId AND a.subject_id = @subjectId
            AND s.status = N'approved'`);
      if (approved.recordset?.length) {
        throw new TeacherGradeSubmissionError('This term, section, and subject already has an approved workbook.', 409);
      }
      const active = await transaction.request()
        .input('termId', sql.Int, termId).input('sectionId', sql.Int, sectionId).input('subjectId', sql.Int, subjectId)
        .query(`SELECT id FROM dbo.teacher_assignments WITH (UPDLOCK, HOLDLOCK)
          WHERE academic_term_id = @termId AND section_id = @sectionId AND subject_id = @subjectId AND is_active = 1`);
      if (active.recordset?.length) throw new TeacherGradeSubmissionError('This class context already has an active teacher assignment. Revoke it before reassigning.', 409);
      const inserted = await transaction.request()
        .input('teacherId', sql.Int, teacherId).input('termId', sql.Int, termId)
        .input('sectionId', sql.Int, sectionId).input('subjectId', sql.Int, subjectId).input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO dbo.teacher_assignments
          (teacher_id, academic_term_id, section_id, subject_id, assigned_by)
          OUTPUT INSERTED.id AS id VALUES (@teacherId, @termId, @sectionId, @subjectId, @actorId)`);
      const assignmentId = inserted.recordset?.[0]?.id;
      if (!assignmentId) throw new Error('Teacher assignment insert returned no identifier.');
      await writeAudit(transaction, {
        actorId: actor.id, action: `${actor.role}.teacher_assignment_created`, entityId: assignmentId,
        details: { schoolYear: context.recordset[0].school_year, term: context.recordset[0].term, sectionId, subjectId, teacherId }
      });
      return assignmentId;
    });
  }

  async function revokeAssignment(actorId, assignmentIdValue) {
    const assignmentId = normalizeId(assignmentIdValue);
    if (!assignmentId) throw new TeacherGradeSubmissionError('Teacher assignment not found.', 404);
    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorId, ['database_admin', 'registrar']);
      const assignmentResult = await transaction.request().input('assignmentId', sql.Int, assignmentId)
        .query(`SELECT id, teacher_id, academic_term_id, section_id, subject_id
          FROM dbo.teacher_assignments WITH (UPDLOCK, HOLDLOCK) WHERE id = @assignmentId AND is_active = 1`);
      const assignment = assignmentResult.recordset?.[0];
      if (!assignment) throw new TeacherGradeSubmissionError('Active teacher assignment not found.', 404);
      const pending = await transaction.request().input('assignmentId', sql.Int, assignmentId)
        .query(`SELECT id FROM dbo.teacher_grade_submissions WITH (UPDLOCK, HOLDLOCK)
          WHERE assignment_id = @assignmentId AND status IN (N'pending', N'correction_requested')`);
      if (pending.recordset?.length) throw new TeacherGradeSubmissionError('Resolve the pending workbook or correction request before revoking this assignment.', 409);
      await transaction.request().input('assignmentId', sql.Int, assignmentId)
        .query('UPDATE dbo.teacher_assignments SET is_active = 0, revoked_at = SYSUTCDATETIME() WHERE id = @assignmentId AND is_active = 1');
      await writeAudit(transaction, {
        actorId: actor.id, action: `${actor.role}.teacher_assignment_revoked`, entityId: assignmentId,
        details: { teacherId: assignment.teacher_id, schoolYearTermId: assignment.academic_term_id, sectionId: assignment.section_id, subjectId: assignment.subject_id }
      });
      return assignmentId;
    });
  }

  async function listTeacherAssignments(actorId) {
    const pool = await getPool();
    await requireActor(pool.request(), actorId, ['teacher']);
    const result = await pool.request().input('teacherId', sql.Int, actorId)
      .query(`SELECT a.id AS assignment_id, a.academic_term_id, a.section_id, a.subject_id,
          term.school_year, term.term, sec.name AS section_name, sec.grade_level,
          sub.subject_code, sub.subject_name,
          (SELECT COUNT_BIG(*) FROM dbo.enrollments AS e
            INNER JOIN dbo.students AS st ON st.id = e.student_id AND st.status = N'active'
            INNER JOIN dbo.student_subjects AS ss ON ss.enrollment_id = e.id AND ss.subject_id = a.subject_id
            WHERE e.academic_term_id = a.academic_term_id AND e.section_id = a.section_id
              AND e.enrollment_status = N'enrolled') AS roster_count,
          (SELECT TOP (1) s.id FROM dbo.teacher_grade_submissions AS s
            WHERE s.assignment_id = a.id ORDER BY s.revision_number DESC) AS latest_submission_id,
          (SELECT TOP (1) s.status FROM dbo.teacher_grade_submissions AS s
            WHERE s.assignment_id = a.id ORDER BY s.revision_number DESC) AS latest_submission_status
        FROM dbo.teacher_assignments AS a
        INNER JOIN dbo.academic_terms AS term ON term.id = a.academic_term_id
        INNER JOIN dbo.sections AS sec ON sec.id = a.section_id AND sec.academic_term_id = a.academic_term_id
        INNER JOIN dbo.subjects AS sub ON sub.id = a.subject_id
        WHERE a.teacher_id = @teacherId AND a.is_active = 1
          AND EXISTS (SELECT 1 FROM dbo.users AS teacher WHERE teacher.id = @teacherId
            AND teacher.role = N'teacher' AND teacher.is_active = 1)
        ORDER BY term.school_year DESC, term.term, sec.grade_level, sec.name, sub.subject_code`);
    return result.recordset || [];
  }

  async function getTeacherAssignment(actorId, assignmentIdValue) {
    const assignmentId = normalizeId(assignmentIdValue);
    if (!assignmentId) throw new TeacherGradeSubmissionError('Assigned class not found.', 404);
    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorId, ['teacher']);
      const result = await transaction.request().input('teacherId', sql.Int, actor.id).input('assignmentId', sql.Int, assignmentId)
        .query(`SELECT a.id AS assignment_id, a.academic_term_id, a.section_id, a.subject_id,
          term.school_year, term.term, sec.name AS section_name, sec.grade_level,
          sub.subject_code, sub.subject_name,
          (SELECT TOP (1) s.id FROM dbo.teacher_grade_submissions AS s
            WHERE s.assignment_id = a.id ORDER BY s.revision_number DESC) AS latest_submission_id,
          (SELECT TOP (1) s.status FROM dbo.teacher_grade_submissions AS s
            WHERE s.assignment_id = a.id ORDER BY s.revision_number DESC) AS latest_submission_status,
          (SELECT TOP (1) s.decision_reason FROM dbo.teacher_grade_submissions AS s
            WHERE s.assignment_id = a.id ORDER BY s.revision_number DESC) AS latest_decision_reason,
          (SELECT TOP (1) s.revision_number FROM dbo.teacher_grade_submissions AS s
            WHERE s.assignment_id = a.id ORDER BY s.revision_number DESC) AS latest_revision_number
        FROM dbo.teacher_assignments AS a
        INNER JOIN dbo.academic_terms AS term ON term.id = a.academic_term_id
        INNER JOIN dbo.sections AS sec ON sec.id = a.section_id AND sec.academic_term_id = a.academic_term_id
        INNER JOIN dbo.subjects AS sub ON sub.id = a.subject_id
        WHERE a.id = @assignmentId AND a.teacher_id = @teacherId AND a.is_active = 1`);
      const assignment = result.recordset?.[0];
      if (!assignment) throw new TeacherGradeSubmissionError('Assigned class not found.', 404);
      const roster = await transaction.request().input('termId', sql.Int, assignment.academic_term_id)
        .input('sectionId', sql.Int, assignment.section_id).input('subjectId', sql.Int, assignment.subject_id)
        .query(`SELECT st.student_no, st.first_name, st.middle_name, st.last_name, st.suffix
        FROM dbo.enrollments AS e
        INNER JOIN dbo.students AS st ON st.id = e.student_id AND st.status = N'active'
        INNER JOIN dbo.student_subjects AS ss ON ss.enrollment_id = e.id AND ss.subject_id = @subjectId
        WHERE e.academic_term_id = @termId AND e.section_id = @sectionId AND e.enrollment_status = N'enrolled'
        ORDER BY st.last_name, st.first_name, st.student_no`);
      return { ...assignment, roster: roster.recordset || [] };
    });
  }

  async function stageWorkbook(actorId, assignmentIdValue, previewIdValue, sessionId, buffer) {
    const assignmentId = normalizeId(assignmentIdValue);
    const previewId = normalizeUuid(previewIdValue);
    if (!assignmentId || !previewId) throw new TeacherGradeSubmissionError('Grade preview not found.', 404);
    validateWorkbook(buffer);
    const stagingPath = path.join(stagingDirectory, `${previewId}.xlsx`);
    try {
      await runTransaction(async (transaction) => {
        const actor = await requireActor(transaction.request(), actorId, ['teacher']);
        await requireAssignedPreview(transaction.request(), actor.id, assignmentId, previewId, sessionId);
        await ensurePrivateDirectory(stagingDirectory);
        await pruneStagingDirectory();
        await fs.writeFile(stagingPath, buffer, { flag: 'wx', mode: 0o600 });
      });
    } catch (error) {
      await fs.unlink(stagingPath).catch(() => {});
      throw error;
    }
    return stagingPath;
  }

  async function submitPreview({ actorId, assignmentId: assignmentIdValue, previousSubmissionId: previousValue,
    preview, sessionId, buffer }) {
    const assignmentId = normalizeId(assignmentIdValue);
    const previousSubmissionId = previousValue ? normalizeUuid(previousValue) : null;
    if (!assignmentId || (previousValue && !previousSubmissionId)) throw new TeacherGradeSubmissionError('Choose a valid assigned class and revision.');
    validateWorkbook(buffer);
    if (!preview || !Array.isArray(preview.rows) || !normalizeUuid(preview.id)) throw new TeacherGradeSubmissionError('Grade preview not found.', 404);
    const filename = cleanFilename(preview.originalFilename);

    const submissionId = crypto.randomUUID();
    const storageKey = crypto.randomUUID();
    await ensurePrivateDirectory(submissionDirectory);
    const finalPath = path.join(submissionDirectory, `${storageKey}.xlsx`);
    await fs.writeFile(finalPath, buffer, { flag: 'wx', mode: 0o600 });
    try {
      return await runTransaction(async (transaction) => {
        const actor = await requireActor(transaction.request(), actorId, ['teacher']);
        await requireOwnedPreview(transaction.request(), actor.id, preview.id, sessionId);
        const assignmentResult = await transaction.request()
          .input('teacherId', sql.Int, actor.id).input('assignmentId', sql.Int, assignmentId)
          .query(`SELECT a.id, a.academic_term_id, a.section_id, a.subject_id,
              term.school_year, sec.grade_level, sec.name AS section_name, sub.subject_name
            FROM dbo.teacher_assignments AS a WITH (UPDLOCK, HOLDLOCK)
            INNER JOIN dbo.academic_terms AS term ON term.id = a.academic_term_id
            INNER JOIN dbo.sections AS sec ON sec.id = a.section_id AND sec.academic_term_id = a.academic_term_id
            INNER JOIN dbo.subjects AS sub ON sub.id = a.subject_id
            WHERE a.id = @assignmentId AND a.teacher_id = @teacherId AND a.is_active = 1`);
        const assignment = assignmentResult.recordset?.[0];
        if (!assignment) throw new TeacherGradeSubmissionError('This class is no longer assigned to your account.', 403);
        if (Number(assignment.academic_term_id) !== Number(preview.academicTermId)
          || assignment.school_year !== preview.schoolYear || assignment.section_name !== preview.sectionName
          || assignment.grade_level !== preview.gradeLevel || assignment.subject_name !== preview.subjectName) {
          throw new TeacherGradeSubmissionError('The class assignment changed after preview. Upload the workbook again.', 409);
        }
        const priorResult = await transaction.request().input('assignmentId', sql.Int, assignmentId)
          .query(`SELECT id, revision_number, status, submitted_by
            FROM dbo.teacher_grade_submissions WITH (UPDLOCK, HOLDLOCK)
            WHERE assignment_id = @assignmentId ORDER BY revision_number DESC`);
        const previous = priorResult.recordset?.[0] || null;
        let revisionNumber = 1;
        let eventType = 'submitted';
        if (previous) {
          if (!previousSubmissionId || previous.id.toLowerCase() !== previousSubmissionId.toLowerCase()
            || previous.status !== 'correction_requested' || previous.submitted_by !== actor.id) {
            throw new TeacherGradeSubmissionError('This class already has a grade workbook. A new upload is allowed only after the registrar requests a correction.', 409);
          }
          revisionNumber = previous.revision_number + 1;
          eventType = 'revision_submitted';
        } else if (previousSubmissionId) {
          throw new TeacherGradeSubmissionError('The selected correction request is no longer available.', 409);
        }
        const storedRowsResult = await transaction.request()
          .input('previewId', sql.UniqueIdentifier, preview.id)
          .query(`SELECT source_row, lrn_fingerprint
            FROM dbo.grade_import_preview_rows WITH (UPDLOCK, HOLDLOCK)
            WHERE preview_id = @previewId`);
        const fingerprintBySourceRow = new Map((storedRowsResult.recordset || [])
          .map((row) => [row.source_row, row.lrn_fingerprint]));
        if (fingerprintBySourceRow.size !== preview.rows.length
          || preview.rows.some((row) => row.studentId && !fingerprintBySourceRow.get(row.sourceRow))) {
          throw new TeacherGradeSubmissionError('This workbook preview is incomplete. Upload the workbook again.', 409);
        }
        const workbookContext = {
          gradeLevel: preview.workbookGradeLevel,
          sectionName: preview.workbookSectionName,
          subjectName: preview.workbookSubjectName
        };
        const contextMismatch = Boolean(preview.contextMismatch);
        const insert = await transaction.request()
          .input('submissionId', sql.UniqueIdentifier, submissionId)
          .input('assignmentId', sql.Int, assignmentId)
          .input('previousSubmissionId', sql.UniqueIdentifier, previous?.id || null)
          .input('revisionNumber', sql.Int, revisionNumber)
          .input('actorId', sql.Int, actor.id)
          .input('schoolYear', sql.NVarChar(20), assignment.school_year)
          .input('gradeLevel', sql.NVarChar(50), assignment.grade_level)
          .input('sectionName', sql.NVarChar(100), assignment.section_name)
          .input('subjectId', sql.Int, assignment.subject_id)
          .input('subjectName', sql.NVarChar(200), assignment.subject_name)
          .input('workbookGradeLevel', sql.NVarChar(50), workbookContext.gradeLevel)
          .input('workbookSectionName', sql.NVarChar(100), workbookContext.sectionName)
          .input('workbookSubjectName', sql.NVarChar(200), workbookContext.subjectName)
          .input('contextMismatch', sql.Bit, contextMismatch)
          .input('filename', sql.NVarChar(255), filename)
          .input('storageKey', sql.UniqueIdentifier, storageKey)
          .input('fileSize', sql.BigInt, buffer.length)
          .query(`INSERT INTO dbo.teacher_grade_submissions
            (id, assignment_id, previous_submission_id, revision_number, submitted_by, school_year, grade_level,
              section_name, subject_id, subject_name, workbook_grade_level, workbook_section_name,
              workbook_subject_name, context_mismatch, original_filename, storage_key, file_size_bytes)
            VALUES (@submissionId, @assignmentId, @previousSubmissionId, @revisionNumber, @actorId, @schoolYear,
              @gradeLevel, @sectionName, @subjectId, @subjectName, @workbookGradeLevel, @workbookSectionName,
              @workbookSubjectName, @contextMismatch, @filename, @storageKey, @fileSize)`);
        void insert;
        for (const row of preview.rows) {
          const insertedRow = await transaction.request()
            .input('submissionId', sql.UniqueIdentifier, submissionId)
            .input('sourceRow', sql.Int, row.sourceRow)
            .input('studentId', sql.Int, row.studentId || null)
            .input('enrollmentId', sql.Int, row.enrollmentId || null)
            .input('studentSubjectId', sql.Int, row.studentSubjectId || null)
            .input('studentNo', sql.NVarChar(50), row.studentNo || null)
            .input('workbookName', sql.NVarChar(200), row.workbookName || null)
            .input('studentName', sql.NVarChar(200), row.studentName || null)
            .input('lrnFingerprint', sql.Char(64), fingerprintBySourceRow.get(row.sourceRow) || null)
            .input('nameMismatch', sql.Bit, Boolean(row.nameMismatch))
            .input('issue', sql.NVarChar(500), row.issue || null)
            .query(`INSERT INTO dbo.teacher_grade_submission_rows
              (submission_id, source_row, student_id, enrollment_id, student_subject_id, student_no,
                workbook_name, student_name, lrn_fingerprint, name_mismatch, issue)
              OUTPUT INSERTED.id AS id
              VALUES (@submissionId, @sourceRow, @studentId, @enrollmentId, @studentSubjectId, @studentNo,
                @workbookName, @studentName, @lrnFingerprint, @nameMismatch, @issue)`);
          const rowId = insertedRow.recordset?.[0]?.id;
          if (!rowId) throw new Error('Teacher grade submission row insert returned no identifier.');
          for (const grade of row.grades) {
            if (grade.gradeValue === null || grade.gradeValue === undefined) continue;
            await transaction.request()
              .input('rowId', sql.BigInt, rowId)
              .input('gradingPeriod', sql.NVarChar(50), grade.gradingPeriod)
              .input('gradeValue', sql.Decimal(6, 2), grade.gradeValue)
              .input('existingGradeId', sql.Int, grade.existingGradeId || null)
              .input('existingGradeValue', sql.Decimal(6, 2), grade.existingGradeValue ?? null)
              .query(`INSERT INTO dbo.teacher_grade_submission_grades
                (submission_row_id, grading_period, grade_value, existing_grade_id, existing_grade_value)
                VALUES (@rowId, @gradingPeriod, @gradeValue, @existingGradeId, @existingGradeValue)`);
          }
        }
        await transaction.request()
          .input('submissionId', sql.UniqueIdentifier, submissionId).input('actorId', sql.Int, actor.id)
          .input('eventType', sql.NVarChar(40), eventType)
          .query(`INSERT INTO dbo.teacher_grade_submission_events (submission_id, actor_id, event_type)
            VALUES (@submissionId, @actorId, @eventType)`);
        await writeAudit(transaction, {
          actorId: actor.id, action: `teacher.grade_workbook_${eventType}`, entityId: submissionId,
          details: { assignmentId, revisionNumber, schoolYear: assignment.school_year, sectionId: assignment.section_id, subjectId: assignment.subject_id, rows: preview.rows.length }
        });
        return submissionId;
      });
    } catch (error) {
      await fs.unlink(finalPath).catch(() => {});
      throw error;
    }
  }

  async function listReviewQueue(actorId) {
    const pool = await getPool();
    await requireActor(pool.request(), actorId, ['registrar']);
    const result = await pool.request().input('actorId', sql.Int, actorId).query(`SELECT s.id, s.revision_number, s.status, s.original_filename,
        s.submitted_at, s.school_year, s.grade_level, s.section_name, s.subject_name,
        sp.first_name, sp.last_name, sec.term
      FROM dbo.teacher_grade_submissions AS s
      INNER JOIN dbo.teacher_assignments AS a ON a.id = s.assignment_id
      INNER JOIN dbo.academic_terms AS sec ON sec.id = a.academic_term_id
      INNER JOIN dbo.users AS u ON u.id = s.submitted_by
      LEFT JOIN dbo.staff_profiles AS sp ON sp.user_id = u.id
      WHERE s.status = N'pending' AND EXISTS (
        SELECT 1 FROM dbo.users AS reviewer WHERE reviewer.id = @actorId
          AND reviewer.role = N'registrar' AND reviewer.is_active = 1)
      ORDER BY s.submitted_at, s.id`);
    return result.recordset || [];
  }

  async function readSubmission(actorId, submissionIdValue, access = 'registrar') {
    const submissionId = normalizeUuid(submissionIdValue);
    if (!submissionId) throw new TeacherGradeSubmissionError('Grade submission not found.', 404);
    const pool = await getPool();
    const roles = access === 'teacher' ? ['teacher'] : ['registrar'];
    await requireActor(pool.request(), actorId, roles);
    const condition = access === 'teacher'
      ? `s.submitted_by = @actorId AND a.teacher_id = @actorId AND a.is_active = 1
        AND EXISTS (SELECT 1 FROM dbo.users AS owner WHERE owner.id = @actorId
          AND owner.role = N'teacher' AND owner.is_active = 1)`
      : `EXISTS (SELECT 1 FROM dbo.users AS reviewer WHERE reviewer.id = @actorId
          AND reviewer.role = N'registrar' AND reviewer.is_active = 1)`;
    const result = await pool.request().input('submissionId', sql.UniqueIdentifier, submissionId)
      .input('actorId', sql.Int, actorId)
      .query(`SELECT s.id, s.assignment_id, s.previous_submission_id, s.revision_number, s.submitted_by,
          s.school_year, s.grade_level, s.section_name, s.subject_id, s.subject_name,
          s.workbook_grade_level, s.workbook_section_name, s.workbook_subject_name, s.context_mismatch,
          s.original_filename, s.storage_key, s.file_size_bytes, s.status, s.submitted_at,
          s.decision_reason, s.decided_at, term.term,
          teacher.first_name AS teacher_first_name, teacher.last_name AS teacher_last_name
        FROM dbo.teacher_grade_submissions AS s
        INNER JOIN dbo.teacher_assignments AS a ON a.id = s.assignment_id
        INNER JOIN dbo.academic_terms AS term ON term.id = a.academic_term_id
        LEFT JOIN dbo.staff_profiles AS teacher ON teacher.user_id = s.submitted_by
        WHERE s.id = @submissionId AND ${condition}`);
    const header = result.recordset?.[0];
    if (!header) throw new TeacherGradeSubmissionError('Grade submission not found.', 404);
    const rowsResult = await pool.request().input('submissionId', sql.UniqueIdentifier, submissionId)
      .query(`SELECT r.id AS row_id, r.source_row, r.student_id, r.enrollment_id, r.student_subject_id,
          r.student_no, r.workbook_name, r.student_name, r.name_mismatch, r.issue,
          g.grading_period, g.grade_value, g.existing_grade_id, g.existing_grade_value
        FROM dbo.teacher_grade_submission_rows AS r
        LEFT JOIN dbo.teacher_grade_submission_grades AS g ON g.submission_row_id = r.id
        WHERE r.submission_id = @submissionId ORDER BY r.source_row, g.id`);
    const rowMap = new Map();
    for (const row of rowsResult.recordset || []) {
      let mapped = rowMap.get(row.row_id);
      if (!mapped) {
        mapped = {
          id: row.row_id, sourceRow: row.source_row, studentId: row.student_id,
          enrollmentId: row.enrollment_id, studentSubjectId: row.student_subject_id,
          studentNo: row.student_no, workbookName: row.workbook_name, studentName: row.student_name,
          nameMismatch: Boolean(row.name_mismatch), issue: row.issue, grades: []
        };
        rowMap.set(row.row_id, mapped);
      }
      if (row.grading_period) mapped.grades.push({
        gradingPeriod: row.grading_period, gradeValue: row.grade_value,
        existingGradeId: row.existing_grade_id, existingGradeValue: row.existing_grade_value
      });
    }
    const rows = [...rowMap.values()].map((row) => {
      const byPeriod = new Map(row.grades.map((grade) => [grade.gradingPeriod, grade]));
      return { ...row, grades: ['Term 1', 'Term 2', 'Term 3', 'Final Grade'].map((label) => byPeriod.get(label) || {
        gradingPeriod: label, gradeValue: null, existingGradeId: null, existingGradeValue: null
      }) };
    });
    const historyResult = await pool.request().input('submissionId', sql.UniqueIdentifier, submissionId)
      .query(`SELECT e.event_type, e.reason, e.created_at, sp.first_name, sp.last_name
        FROM dbo.teacher_grade_submission_events AS e
        LEFT JOIN dbo.staff_profiles AS sp ON sp.user_id = e.actor_id
        WHERE e.submission_id = @submissionId ORDER BY e.created_at, e.id`);
    return {
      ...header,
      id: header.id.toLowerCase(),
      contextMismatch: Boolean(header.context_mismatch),
      rows,
      history: historyResult.recordset || [],
      counts: {
        rows: rows.length,
        eligible: rows.filter((row) => !row.issue && row.studentId && row.studentSubjectId).length,
        unresolved: rows.filter((row) => Boolean(row.issue)).length,
        conflicts: rows.reduce((count, row) => count + row.grades.filter((grade) => grade.existingGradeId
          && Number(grade.existingGradeValue) !== Number(grade.gradeValue)).length, 0)
      }
    };
  }

  async function getWorkbook(actorId, submissionIdValue, access = 'registrar') {
    const submission = await readSubmission(actorId, submissionIdValue, access);
    const key = normalizeUuid(submission.storage_key);
    if (!key) throw new TeacherGradeSubmissionError('The private workbook is unavailable.', 404);
    const filePath = path.join(submissionDirectory, `${key}.xlsx`);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size !== Number(submission.file_size_bytes)) throw new Error('Stored workbook size mismatch.');
    } catch {
      throw new TeacherGradeSubmissionError('The private workbook is unavailable.', 404);
    }
    return { filePath, filename: submission.original_filename, mimeType: XLSX_MIME };
  }

  async function decideSubmission(actorId, submissionIdValue, decision, reasonValue) {
    const submissionId = normalizeUuid(submissionIdValue);
    if (!submissionId) throw new TeacherGradeSubmissionError('Grade submission not found.', 404);
    if (!['correction_requested', 'rejected'].includes(decision)) throw new TeacherGradeSubmissionError('Choose a valid review decision.');
    const reason = printableReason(reasonValue, decision === 'rejected' ? 'Rejection reason' : 'Correction instructions', true);
    return runTransaction(async (transaction) => {
      const actor = await requireActor(transaction.request(), actorId, ['registrar']);
      const submissionResult = await transaction.request().input('submissionId', sql.UniqueIdentifier, submissionId)
        .query(`SELECT id, assignment_id, status, revision_number FROM dbo.teacher_grade_submissions WITH (UPDLOCK, HOLDLOCK)
          WHERE id = @submissionId`);
      const submission = submissionResult.recordset?.[0];
      if (!submission) throw new TeacherGradeSubmissionError('Grade submission not found.', 404);
      if (submission.status !== 'pending') throw new TeacherGradeSubmissionError('This submission has already been reviewed.', 409);
      await transaction.request()
        .input('submissionId', sql.UniqueIdentifier, submissionId)
        .input('actorId', sql.Int, actor.id).input('decision', sql.NVarChar(30), decision)
        .input('reason', sql.NVarChar(500), reason)
        .query(`UPDATE dbo.teacher_grade_submissions SET status = @decision, decided_by = @actorId,
            decided_at = SYSUTCDATETIME(), decision_reason = @reason WHERE id = @submissionId AND status = N'pending'`);
      await transaction.request()
        .input('submissionId', sql.UniqueIdentifier, submissionId).input('actorId', sql.Int, actor.id)
        .input('eventType', sql.NVarChar(40), decision).input('reason', sql.NVarChar(500), reason)
        .query(`INSERT INTO dbo.teacher_grade_submission_events (submission_id, actor_id, event_type, reason)
          VALUES (@submissionId, @actorId, @eventType, @reason)`);
      await writeAudit(transaction, {
        actorId: actor.id, action: `registrar.grade_workbook_${decision}`, entityId: submissionId,
        details: { assignmentId: submission.assignment_id, revisionNumber: submission.revision_number }
      });
      return decision;
    });
  }

  async function getStagedWorkbook(actorId, assignmentIdValue, previewIdValue, sessionId) {
    const assignmentId = normalizeId(assignmentIdValue);
    const previewId = normalizeUuid(previewIdValue);
    if (!assignmentId || !previewId) throw new TeacherGradeSubmissionError('Grade preview not found.', 404);
    const pool = await getPool();
    const actor = await requireActor(pool.request(), actorId, ['teacher']);
    await requireAssignedPreview(pool.request(), actor.id, assignmentId, previewId, sessionId);
    const filePath = path.join(stagingDirectory, `${previewId}.xlsx`);
    let buffer;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size < 4 || stat.size > MAX_WORKBOOK_BYTES) throw new Error('Invalid staged workbook.');
      buffer = await fs.readFile(filePath);
    } catch {
      throw new TeacherGradeSubmissionError('This workbook preview expired. Upload the workbook again.', 404);
    }
    validateWorkbook(buffer);
    return buffer;
  }

  async function clearStagedWorkbook(previewIdValue) {
    const previewId = normalizeUuid(previewIdValue);
    if (!previewId) return;
    await fs.unlink(path.join(stagingDirectory, `${previewId}.xlsx`)).catch(() => {});
  }

  return {
    listAssignmentOptions,
    createAssignment,
    revokeAssignment,
    listTeacherAssignments,
    getTeacherAssignment,
    stageWorkbook,
    getStagedWorkbook,
    clearStagedWorkbook,
    submitPreview,
    listReviewQueue,
    readSubmission,
    getWorkbook,
    decideSubmission
  };
}

module.exports = {
  MAX_WORKBOOK_BYTES,
  TeacherGradeSubmissionError,
  createTeacherGradeSubmissionService,
  normalizeId,
  normalizeUuid,
  cleanFilename,
  validateWorkbook
};
