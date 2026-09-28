const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

class ClassScheduleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ClassScheduleError';
    this.status = status;
  }
}

function positiveId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateSchedule(input = {}) {
  const assignmentId = positiveId(input.assignmentId);
  const termInput = input.termId ?? '';
  const sectionInput = input.filterSectionId ?? '';
  const contextAssignmentInput = input.filterAssignmentId ?? '';
  const contextTermId = termInput === '' ? null : positiveId(termInput);
  const contextSectionId = sectionInput === '' ? null : positiveId(sectionInput);
  const contextAssignmentId = contextAssignmentInput === '' ? null : positiveId(contextAssignmentInput);
  const dayOfWeek = typeof input.dayOfWeek === 'string' && /^\d$/.test(input.dayOfWeek)
    ? Number(input.dayOfWeek) : input.dayOfWeek;
  const startTime = typeof input.startTime === 'string' ? input.startTime.trim() : '';
  const endTime = typeof input.endTime === 'string' ? input.endTime.trim() : '';
  const room = typeof input.room === 'string' ? input.room.trim() : '';
  if (!assignmentId) throw new ClassScheduleError('Choose an assigned class.');
  if ((termInput !== '' && !contextTermId) || (sectionInput !== '' && !contextSectionId)
    || (contextAssignmentInput !== '' && !contextAssignmentId)) {
    throw new ClassScheduleError('Choose an active class from the selected term and section.');
  }
  if (contextAssignmentId && contextAssignmentId !== assignmentId) {
    throw new ClassScheduleError('The selected class does not match this schedule context.', 409);
  }
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 6) {
    throw new ClassScheduleError('Choose a day from Monday through Saturday.');
  }
  if (!validTime(startTime) || !validTime(endTime) || startTime >= endTime) {
    throw new ClassScheduleError('Enter a valid class time with the end after the start.');
  }
  if (room.length > 80 || /[\u0000-\u001f\u007f]/.test(room)) {
    throw new ClassScheduleError('Room must be 80 printable characters or fewer.');
  }
  return { assignmentId, contextTermId, contextSectionId, dayOfWeek, startTime, endTime, room: room || null };
}

function createClassScheduleService({
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
        try { await transaction.rollback(); } catch { /* Preserve the service error. */ }
      }
      throw error;
    }
  }

  async function requireRegistrar(transaction, actorId) {
    const result = await transaction.request().input('actorId', sql.Int, actorId)
      .query(`SELECT id FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @actorId AND is_active = 1 AND role = N'registrar'`);
    if (!result.recordset?.length) throw new ClassScheduleError('Your registrar access is no longer active. Sign in again.', 403);
    return result.recordset[0].id;
  }

  async function writeAudit(transaction, actorId, action, scheduleId, details = {}) {
    await transaction.request()
      .input('actorId', sql.Int, actorId)
      .input('action', sql.NVarChar(100), `registrar.${action}`)
      .input('entityId', sql.NVarChar(100), String(scheduleId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, N'class_schedule', @entityId, @detailsJson)`);
  }

  async function listRegistrarWorkspace(actorInput, filterInput = {}) {
    const actorId = positiveId(actorInput);
    if (!actorId) throw new ClassScheduleError('Registrar access is required.', 403);
    const filters = typeof filterInput === 'string' ? { termId: filterInput } : filterInput || {};
    const termInput = filters.termId ?? '';
    const sectionInput = filters.sectionId ?? '';
    const assignmentInput = filters.assignmentId ?? '';
    const requestedTermId = termInput === '' ? null : positiveId(termInput);
    const requestedSectionId = sectionInput === '' ? null : positiveId(sectionInput);
    const requestedAssignmentId = assignmentInput === '' ? null : positiveId(assignmentInput);
    if ((termInput !== '' && !requestedTermId) || (sectionInput !== '' && !requestedSectionId)
      || (assignmentInput !== '' && !requestedAssignmentId)) {
      throw new ClassScheduleError('Choose valid term, section, and class filters.');
    }
    const pool = await getPool();
    const actor = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT id FROM dbo.users WHERE id = @actorId AND is_active = 1 AND role = N'registrar'`);
    if (!actor.recordset?.length) throw new ClassScheduleError('Your registrar access is no longer active. Sign in again.', 403);
    const termsResult = await pool.request().query(`SELECT id, school_year, term, is_current
      FROM dbo.academic_terms ORDER BY is_current DESC, id DESC`);
    const terms = termsResult.recordset || [];
    if (requestedTermId && !terms.some((term) => Number(term.id) === requestedTermId)) {
      throw new ClassScheduleError('Choose a valid academic term.');
    }
    const selectedTermId = requestedTermId
      || terms.find((term) => term.is_current === true || term.is_current === 1)?.id
      || terms[0]?.id
      || null;
    const sectionResult = selectedTermId
      ? await pool.request().input('academicTermId', sql.Int, selectedTermId)
        .query(`SELECT section.id, section.name, section.grade_level, section.academic_term_id,
            term.school_year, term.term
          FROM dbo.sections AS section
          INNER JOIN dbo.academic_terms AS term ON term.id = section.academic_term_id
          WHERE section.academic_term_id = @academicTermId
          ORDER BY section.grade_level, section.name`)
      : { recordset: [] };
    const sections = sectionResult.recordset || [];
    let selectedSectionId = requestedSectionId;
    let contextNotice = null;
    let invalidSectionContext = false;
    if (requestedSectionId && !sections.some((section) => Number(section.id) === requestedSectionId)) {
      selectedSectionId = null;
      invalidSectionContext = true;
      contextNotice = 'That section belongs to a different term. Choose a section in the selected term.';
    }
    const assignmentResult = selectedTermId ? await pool.request()
      .input('academicTermId', sql.Int, selectedTermId)
      .input('sectionId', sql.Int, selectedSectionId)
      .query(`SELECT assignment.id, assignment.academic_term_id, assignment.section_id, section.name AS section_name,
          section.grade_level, assignment.subject_id, subject.subject_code, subject.subject_name,
          assignment.teacher_id, COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(staff.first_name, N' ', staff.last_name))), N''), teacher.email) AS teacher_name,
          term.school_year, term.term
        FROM dbo.teacher_assignments AS assignment
        INNER JOIN dbo.users AS teacher ON teacher.id = assignment.teacher_id AND teacher.role = N'teacher' AND teacher.is_active = 1
        LEFT JOIN dbo.staff_profiles AS staff ON staff.user_id = teacher.id
        INNER JOIN dbo.sections AS section ON section.id = assignment.section_id
          AND section.academic_term_id = assignment.academic_term_id
        INNER JOIN dbo.subjects AS subject ON subject.id = assignment.subject_id
        INNER JOIN dbo.academic_terms AS term ON term.id = assignment.academic_term_id
        WHERE assignment.is_active = 1 AND (@academicTermId IS NULL OR assignment.academic_term_id = @academicTermId)
          AND (@sectionId IS NULL OR assignment.section_id = @sectionId)
        ORDER BY section.grade_level, section.name, subject.subject_code`)
      : { recordset: [] };
    const assignments = assignmentResult.recordset || [];
    let selectedAssignmentId = invalidSectionContext ? null : requestedAssignmentId;
    if (selectedAssignmentId) {
      const selectedAssignment = assignments.find((assignment) => Number(assignment.id) === selectedAssignmentId);
      if (!selectedAssignment) {
        selectedAssignmentId = null;
        contextNotice = contextNotice || 'That class is not active in the selected term and section. Choose an active class.';
      } else if (!selectedSectionId) {
        selectedSectionId = Number(selectedAssignment.section_id);
      }
    }
    const schedulesRequest = pool.request()
      .input('academicTermId', sql.Int, selectedTermId)
      .input('sectionId', sql.Int, selectedSectionId)
      .input('assignmentId', sql.Int, selectedAssignmentId);
    const scheduleResult = selectedTermId ? await schedulesRequest.query(`SELECT schedule.id, schedule.assignment_id, schedule.day_of_week,
          CONVERT(char(5), schedule.start_time, 108) AS start_time,
          CONVERT(char(5), schedule.end_time, 108) AS end_time, schedule.room,
          assignment.academic_term_id, assignment.section_id, assignment.is_active AS assignment_is_active,
          section.name AS section_name, section.grade_level, subject.subject_code, subject.subject_name,
          teacher.id AS teacher_id,
          COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(staff.first_name, N' ', staff.last_name))), N''), teacher.email) AS teacher_name,
          term.school_year, term.term
        FROM dbo.class_schedules AS schedule
        INNER JOIN dbo.teacher_assignments AS assignment ON assignment.id = schedule.assignment_id
        INNER JOIN dbo.sections AS section ON section.id = assignment.section_id
          AND section.academic_term_id = assignment.academic_term_id
        INNER JOIN dbo.subjects AS subject ON subject.id = assignment.subject_id
        INNER JOIN dbo.users AS teacher ON teacher.id = assignment.teacher_id
        LEFT JOIN dbo.staff_profiles AS staff ON staff.user_id = teacher.id
        INNER JOIN dbo.academic_terms AS term ON term.id = assignment.academic_term_id
        WHERE (@academicTermId IS NULL OR assignment.academic_term_id = @academicTermId)
          AND (@sectionId IS NULL OR assignment.section_id = @sectionId)
          AND (@assignmentId IS NULL OR assignment.id = @assignmentId)
        ORDER BY schedule.day_of_week, schedule.start_time, section.name`)
      : { recordset: [] };
    return {
      terms,
      sections,
      academicTermId: selectedTermId,
      selectedSectionId,
      selectedAssignmentId,
      contextNotice,
      assignments,
      schedules: scheduleResult.recordset || []
    };
  }

  async function getOwnStudentSchedule(userInput) {
    const userId = positiveId(userInput);
    if (!userId) throw new ClassScheduleError('Student schedule access is unavailable.', 403);
    const pool = await getPool();
    const result = await pool.request().input('userId', sql.Int, userId)
      .query(`SELECT schedule.id, schedule.day_of_week,
          CONVERT(char(5), schedule.start_time, 108) AS start_time,
          CONVERT(char(5), schedule.end_time, 108) AS end_time, schedule.room,
          section.name AS section_name, section.grade_level, subject.subject_code, subject.subject_name,
          COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(staff.first_name, N' ', staff.last_name))), N''), N'To be announced') AS teacher_name,
          term.school_year, term.term
        FROM dbo.users AS user_account
        INNER JOIN dbo.students AS student ON student.user_id = user_account.id AND student.status = N'active'
        INNER JOIN dbo.enrollments AS enrollment ON enrollment.student_id = student.id
          AND enrollment.enrollment_status = N'enrolled'
        INNER JOIN dbo.academic_terms AS term ON term.id = enrollment.academic_term_id AND term.is_current = 1
        INNER JOIN dbo.teacher_assignments AS assignment ON assignment.academic_term_id = enrollment.academic_term_id
          AND assignment.section_id = enrollment.section_id AND assignment.is_active = 1
        INNER JOIN dbo.student_subjects AS enrolled_subject ON enrolled_subject.enrollment_id = enrollment.id
          AND enrolled_subject.subject_id = assignment.subject_id
        INNER JOIN dbo.class_schedules AS schedule ON schedule.assignment_id = assignment.id
        INNER JOIN dbo.sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        INNER JOIN dbo.subjects AS subject ON subject.id = assignment.subject_id
        LEFT JOIN dbo.staff_profiles AS staff ON staff.user_id = assignment.teacher_id
        WHERE user_account.id = @userId AND user_account.role = N'student' AND user_account.is_active = 1
        ORDER BY schedule.day_of_week, schedule.start_time, subject.subject_code`);
    return result.recordset || [];
  }

  async function saveSchedule(actorInput, scheduleInput, input) {
    const actorId = positiveId(actorInput);
    const scheduleId = scheduleInput === null ? null : positiveId(scheduleInput);
    if (!actorId || (scheduleInput !== null && !scheduleId)) throw new ClassScheduleError('Choose a valid class schedule.');
    const values = validateSchedule(input);
    return runTransaction(async (transaction) => {
      const registrarId = await requireRegistrar(transaction, actorId);
      let current = null;
      if (scheduleId) {
        const existing = await transaction.request().input('scheduleId', sql.Int, scheduleId)
          .query(`SELECT id, assignment_id, day_of_week, start_time, end_time, room
            FROM dbo.class_schedules WITH (UPDLOCK, HOLDLOCK) WHERE id = @scheduleId`);
        current = existing.recordset?.[0];
        if (!current) throw new ClassScheduleError('Class schedule not found.', 404);
      }

      const assignmentResult = await transaction.request().input('assignmentId', sql.Int, values.assignmentId)
        .query(`SELECT assignment.id, assignment.section_id, assignment.teacher_id, assignment.academic_term_id
          FROM dbo.teacher_assignments AS assignment WITH (UPDLOCK, HOLDLOCK)
          INNER JOIN dbo.users AS teacher WITH (UPDLOCK, HOLDLOCK)
            ON teacher.id = assignment.teacher_id AND teacher.role = N'teacher' AND teacher.is_active = 1
          WHERE assignment.id = @assignmentId AND assignment.is_active = 1`);
      const assignment = assignmentResult.recordset?.[0];
      if (!assignment) throw new ClassScheduleError('Choose an active teacher assignment.');
      if (values.contextTermId && Number(assignment.academic_term_id) !== values.contextTermId) {
        throw new ClassScheduleError('The selected class does not belong to the chosen term.', 409);
      }
      if (values.contextSectionId && Number(assignment.section_id) !== values.contextSectionId) {
        throw new ClassScheduleError('The selected class does not belong to the chosen section.', 409);
      }

      const conflictResult = await transaction.request()
        .input('assignmentId', sql.Int, values.assignmentId)
        .input('scheduleId', sql.Int, scheduleId)
        .input('dayOfWeek', sql.TinyInt, values.dayOfWeek)
        .input('startTime', sql.VarChar(5), values.startTime)
        .input('endTime', sql.VarChar(5), values.endTime)
        .input('room', sql.NVarChar(80), values.room)
        .input('sectionId', sql.Int, assignment.section_id)
        .input('teacherId', sql.Int, assignment.teacher_id)
        .input('academicTermId', sql.Int, assignment.academic_term_id)
        .query(`SELECT TOP (1) schedule.id
          FROM dbo.class_schedules AS schedule WITH (UPDLOCK, HOLDLOCK)
          INNER JOIN dbo.teacher_assignments AS assigned_class WITH (UPDLOCK, HOLDLOCK)
            ON assigned_class.id = schedule.assignment_id
          WHERE assigned_class.academic_term_id = @academicTermId AND assigned_class.is_active = 1
            AND schedule.day_of_week = @dayOfWeek AND schedule.id <> ISNULL(@scheduleId, -1)
            AND schedule.start_time < @endTime AND schedule.end_time > @startTime
            AND (assigned_class.section_id = @sectionId OR assigned_class.teacher_id = @teacherId
              OR (@room IS NOT NULL AND schedule.room = @room))`);
      if (conflictResult.recordset?.length) {
        throw new ClassScheduleError('This time conflicts with another class for the section, teacher, or room.', 409);
      }

      const request = transaction.request()
        .input('assignmentId', sql.Int, values.assignmentId)
        .input('dayOfWeek', sql.TinyInt, values.dayOfWeek)
        .input('startTime', sql.VarChar(5), values.startTime)
        .input('endTime', sql.VarChar(5), values.endTime)
        .input('room', sql.NVarChar(80), values.room)
        .input('registrarId', sql.Int, registrarId);
      let savedId = scheduleId;
      if (scheduleId) {
        await request.input('scheduleId', sql.Int, scheduleId).query(`UPDATE dbo.class_schedules
          SET assignment_id = @assignmentId, day_of_week = @dayOfWeek,
            start_time = @startTime, end_time = @endTime, room = @room,
            updated_at = SYSUTCDATETIME()
          WHERE id = @scheduleId`);
      } else {
        const inserted = await request.query(`INSERT INTO dbo.class_schedules
          (assignment_id, day_of_week, start_time, end_time, room, created_by)
          OUTPUT INSERTED.id AS id
          VALUES (@assignmentId, @dayOfWeek, @startTime, @endTime, @room, @registrarId)`);
        savedId = inserted.recordset?.[0]?.id;
        if (!savedId) throw new Error('Schedule insert returned no identifier.');
      }
      await writeAudit(transaction, registrarId, scheduleId ? 'class_schedule_updated' : 'class_schedule_created', savedId, {
        assignmentId: values.assignmentId, dayOfWeek: values.dayOfWeek,
        startTime: values.startTime, endTime: values.endTime, room: values.room
      });
      return savedId;
    });
  }

  async function deleteSchedule(actorInput, scheduleInput) {
    const actorId = positiveId(actorInput);
    const scheduleId = positiveId(scheduleInput);
    if (!actorId || !scheduleId) throw new ClassScheduleError('Choose a valid class schedule.');
    return runTransaction(async (transaction) => {
      const registrarId = await requireRegistrar(transaction, actorId);
      const existing = await transaction.request().input('scheduleId', sql.Int, scheduleId)
        .query(`SELECT schedule.id, schedule.assignment_id, schedule.day_of_week,
            CONVERT(char(5), schedule.start_time, 108) AS start_time,
            CONVERT(char(5), schedule.end_time, 108) AS end_time
          FROM dbo.class_schedules AS schedule WITH (UPDLOCK, HOLDLOCK)
          WHERE schedule.id = @scheduleId`);
      const row = existing.recordset?.[0];
      if (!row) throw new ClassScheduleError('Class schedule not found.', 404);
      await transaction.request().input('scheduleId', sql.Int, scheduleId)
        .query('DELETE FROM dbo.class_schedules WHERE id = @scheduleId');
      await writeAudit(transaction, registrarId, 'class_schedule_removed', scheduleId, {
        assignmentId: row.assignment_id, dayOfWeek: row.day_of_week,
        startTime: row.start_time, endTime: row.end_time
      });
      return scheduleId;
    });
  }

  return { listRegistrarWorkspace, getOwnStudentSchedule, saveSchedule, deleteSchedule };
}

module.exports = { ClassScheduleError, createClassScheduleService, positiveId, validateSchedule };
