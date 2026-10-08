const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { formatStudentPlacement } = require('../utils/formatStudentPlacement');

const MAX_CONFLICT_RESULTS = 10;
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

class ClassScheduleError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.name = 'ClassScheduleError';
    this.status = status;
    this.conflicts = Array.isArray(details.conflicts) ? details.conflicts : [];
    this.conflictsTruncated = details.conflictsTruncated === true;
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

function toConflictDetails(rows = []) {
  return rows.map((row) => {
    const reasons = [];
    if (row.section_conflict === true || row.section_conflict === 1) reasons.push('same section');
    if (row.teacher_conflict === true || row.teacher_conflict === 1) reasons.push('same teacher');
    if (row.room_conflict === true || row.room_conflict === 1) reasons.push('same room');
    const section = formatStudentPlacement(row.grade_level, row.section_name) || 'Section unavailable';
    const classLabel = [row.subject_code, row.subject_name].filter(Boolean).join(' · ') || 'Assigned class';
    const teacher = typeof row.teacher_name === 'string' && row.teacher_name.trim()
      ? row.teacher_name.trim() : 'Assigned teacher';
    const room = typeof row.room === 'string' && row.room.trim() ? row.room.trim() : 'To be announced';
    const dayLabel = DAY_NAMES[Number(row.day_of_week)] || 'Scheduled day';
    const reasonLabel = reasons.length ? reasons.join(', ') : 'overlapping schedule';
    const summary = `${dayLabel}, ${row.start_time}–${row.end_time}: ${classLabel} (${section}); Teacher: ${teacher}; Room: ${room}; shared: ${reasonLabel}.`;
    return {
      id: Number(row.id),
      dayOfWeek: Number(row.day_of_week),
      dayLabel,
      startTime: row.start_time,
      endTime: row.end_time,
      subjectCode: row.subject_code || '',
      subjectName: row.subject_name || '',
      sectionLabel: section,
      teacherName: teacher,
      room: typeof row.room === 'string' ? row.room : '',
      reasons,
      summary
    };
  });
}

function conflictQuery(request, values, lockRows = false) {
  const result = request
    .input('assignmentId', values.sql.Int, values.assignmentId)
    .input('scheduleId', values.sql.Int, values.scheduleId)
    .input('dayOfWeek', values.sql.TinyInt, values.dayOfWeek)
    .input('startTime', values.sql.VarChar(5), values.startTime)
    .input('endTime', values.sql.VarChar(5), values.endTime)
    .input('room', values.sql.NVarChar(80), values.room)
    .input('sectionId', values.sql.Int, values.sectionId)
    .input('teacherId', values.sql.Int, values.teacherId)
    .input('academicTermId', values.sql.Int, values.academicTermId);
  return result.query(`SELECT schedule.id, schedule.day_of_week,
      TIME_FORMAT(schedule.start_time, '%H:%i') AS start_time,
      TIME_FORMAT(schedule.end_time, '%H:%i') AS end_time, schedule.room,
      section.grade_level, section.name AS section_name,
      subject.subject_code, subject.subject_name,
      COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(staff.first_name, ' ', staff.last_name))), ''), teacher.email, 'Assigned teacher') AS teacher_name,
      CASE WHEN assigned_class.section_id = @sectionId THEN 1 ELSE 0 END AS section_conflict,
      CASE WHEN assigned_class.teacher_id = @teacherId THEN 1 ELSE 0 END AS teacher_conflict,
      CASE WHEN @room IS NOT NULL AND schedule.room = @room THEN 1 ELSE 0 END AS room_conflict
    FROM class_schedules AS schedule
    INNER JOIN teacher_assignments AS assigned_class ON assigned_class.id = schedule.assignment_id
    LEFT JOIN sections AS section ON section.id = assigned_class.section_id
      AND section.academic_term_id = assigned_class.academic_term_id
    LEFT JOIN subjects AS subject ON subject.id = assigned_class.subject_id
    LEFT JOIN users AS teacher ON teacher.id = assigned_class.teacher_id AND teacher.role = 'teacher'
    LEFT JOIN staff_profiles AS staff ON staff.user_id = assigned_class.teacher_id
    WHERE assigned_class.academic_term_id = @academicTermId AND assigned_class.is_active = 1
      AND schedule.day_of_week = @dayOfWeek AND schedule.id <> COALESCE(@scheduleId, -1)
      AND schedule.start_time < @endTime AND schedule.end_time > @startTime
      AND (assigned_class.section_id = @sectionId OR assigned_class.teacher_id = @teacherId
        OR (@room IS NOT NULL AND schedule.room = @room))
    ORDER BY schedule.start_time, schedule.id LIMIT ${MAX_CONFLICT_RESULTS + 1}${lockRows ? ' FOR UPDATE' : ''}`);
}

function conflictsMessage(truncated) {
  return `This class time conflicts with an existing schedule.${truncated ? ' More matching class times were found.' : ''}`;
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
      .query(`SELECT id FROM users
        WHERE id = @actorId AND is_active = 1 AND role = 'registrar' FOR UPDATE`);
    if (!result.recordset?.length) throw new ClassScheduleError('Your registrar access is no longer active. Sign in again.', 403);
    return result.recordset[0].id;
  }

  async function getActiveAssignment(request, assignmentId, lockRow = false) {
    const assignmentResult = await request.input('assignmentId', sql.Int, assignmentId)
      .query(`SELECT assignment.id, assignment.section_id, assignment.teacher_id, assignment.academic_term_id
        FROM teacher_assignments AS assignment
        INNER JOIN users AS teacher
          ON teacher.id = assignment.teacher_id AND teacher.role = 'teacher' AND teacher.is_active = 1
        WHERE assignment.id = @assignmentId AND assignment.is_active = 1${lockRow ? ' FOR UPDATE' : ''}`);
    const assignment = assignmentResult.recordset?.[0];
    if (!assignment) throw new ClassScheduleError('Choose an active teacher assignment.');
    return assignment;
  }

  async function validateAssignmentContext(assignment, values) {
    if (values.contextTermId && Number(assignment.academic_term_id) !== values.contextTermId) {
      throw new ClassScheduleError('The selected class does not belong to the chosen term.', 409);
    }
    if (values.contextSectionId && Number(assignment.section_id) !== values.contextSectionId) {
      throw new ClassScheduleError('The selected class does not belong to the chosen section.', 409);
    }
  }

  async function previewScheduleConflicts(actorInput, scheduleInput, input) {
    const actorId = positiveId(actorInput);
    const scheduleId = scheduleInput === null || scheduleInput === '' ? null : positiveId(scheduleInput);
    if (!actorId || (scheduleInput !== null && scheduleInput !== '' && !scheduleId)) {
      throw new ClassScheduleError('Choose a valid class schedule.');
    }
    const values = validateSchedule(input);
    const pool = await getPool();
    const actor = await pool.request().input('actorId', sql.Int, actorId)
      .query(`SELECT id FROM users
        WHERE id = @actorId AND is_active = 1 AND role = 'registrar'`);
    if (!actor.recordset?.length) throw new ClassScheduleError('Your registrar access is no longer active. Sign in again.', 403);
    if (scheduleId) {
      const existing = await pool.request().input('scheduleId', sql.Int, scheduleId)
        .query('SELECT id FROM class_schedules WHERE id = @scheduleId');
      if (!existing.recordset?.length) throw new ClassScheduleError('Class schedule not found.', 404);
    }
    const assignment = await getActiveAssignment(pool.request(), values.assignmentId);
    await validateAssignmentContext(assignment, values);
    const result = await conflictQuery(pool.request(), {
      sql,
      ...values,
      scheduleId,
      sectionId: assignment.section_id,
      teacherId: assignment.teacher_id,
      academicTermId: assignment.academic_term_id
    });
    const rows = result.recordset || [];
    const conflictsTruncated = rows.length > MAX_CONFLICT_RESULTS;
    const conflicts = toConflictDetails(rows.slice(0, MAX_CONFLICT_RESULTS));
    return {
      conflict: conflicts.length > 0,
      conflicts,
      conflictsTruncated,
      roomChecked: Boolean(values.room),
      message: conflicts.length
        ? `${conflictsMessage(conflictsTruncated)} This check covers all sections in the selected term.${values.room ? '' : ' Room conflicts were not checked because no room was entered.'} Saving will check again.`
        : `No conflicts were found right now. This check covers all sections in the selected term.${values.room ? '' : ' Room conflicts were not checked because no room was entered.'} Saving will check again.`
    };
  }

  async function writeAudit(transaction, actorId, action, scheduleId, details = {}) {
    await transaction.request()
      .input('actorId', sql.Int, actorId)
      .input('action', sql.NVarChar(100), `registrar.${action}`)
      .input('entityId', sql.NVarChar(100), String(scheduleId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, 'class_schedule', @entityId, @detailsJson)`);
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
      .query(`SELECT id FROM users WHERE id = @actorId AND is_active = 1 AND role = 'registrar'`);
    if (!actor.recordset?.length) throw new ClassScheduleError('Your registrar access is no longer active. Sign in again.', 403);
    const termsResult = await pool.request().query(`SELECT id, school_year, term, is_current
      FROM academic_terms ORDER BY is_current DESC, id DESC`);
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
          FROM sections AS section
          INNER JOIN academic_terms AS term ON term.id = section.academic_term_id
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
          assignment.teacher_id, COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(staff.first_name, ' ', staff.last_name))), ''), teacher.email) AS teacher_name,
          term.school_year, term.term
        FROM teacher_assignments AS assignment
        INNER JOIN users AS teacher ON teacher.id = assignment.teacher_id AND teacher.role = 'teacher' AND teacher.is_active = 1
        LEFT JOIN staff_profiles AS staff ON staff.user_id = teacher.id
        INNER JOIN sections AS section ON section.id = assignment.section_id
          AND section.academic_term_id = assignment.academic_term_id
        INNER JOIN subjects AS subject ON subject.id = assignment.subject_id
        INNER JOIN academic_terms AS term ON term.id = assignment.academic_term_id
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
          TIME_FORMAT(schedule.start_time, '%H:%i') AS start_time,
          TIME_FORMAT(schedule.end_time, '%H:%i') AS end_time, schedule.room,
          assignment.academic_term_id, assignment.section_id, assignment.is_active AS assignment_is_active,
          section.name AS section_name, section.grade_level, subject.subject_code, subject.subject_name,
          teacher.id AS teacher_id,
          COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(staff.first_name, ' ', staff.last_name))), ''), teacher.email) AS teacher_name,
          term.school_year, term.term
        FROM class_schedules AS schedule
        INNER JOIN teacher_assignments AS assignment ON assignment.id = schedule.assignment_id
        INNER JOIN sections AS section ON section.id = assignment.section_id
          AND section.academic_term_id = assignment.academic_term_id
        INNER JOIN subjects AS subject ON subject.id = assignment.subject_id
        INNER JOIN users AS teacher ON teacher.id = assignment.teacher_id
        LEFT JOIN staff_profiles AS staff ON staff.user_id = teacher.id
        INNER JOIN academic_terms AS term ON term.id = assignment.academic_term_id
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
          TIME_FORMAT(schedule.start_time, '%H:%i') AS start_time,
          TIME_FORMAT(schedule.end_time, '%H:%i') AS end_time, schedule.room,
          section.name AS section_name, section.grade_level, subject.subject_code, subject.subject_name,
          COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(staff.first_name, ' ', staff.last_name))), ''), 'To be announced') AS teacher_name,
          term.school_year, term.term
        FROM users AS user_account
        INNER JOIN students AS student ON student.user_id = user_account.id AND student.status = 'active'
        INNER JOIN enrollments AS enrollment ON enrollment.student_id = student.id
          AND enrollment.enrollment_status = 'enrolled'
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id AND term.is_current = 1
        INNER JOIN teacher_assignments AS assignment ON assignment.academic_term_id = enrollment.academic_term_id
          AND assignment.section_id = enrollment.section_id AND assignment.is_active = 1
        INNER JOIN student_subjects AS enrolled_subject ON enrolled_subject.enrollment_id = enrollment.id
          AND enrolled_subject.subject_id = assignment.subject_id
        INNER JOIN class_schedules AS schedule ON schedule.assignment_id = assignment.id
        INNER JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        INNER JOIN subjects AS subject ON subject.id = assignment.subject_id
        LEFT JOIN staff_profiles AS staff ON staff.user_id = assignment.teacher_id
        WHERE user_account.id = @userId AND user_account.role = 'student' AND user_account.is_active = 1
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
            FROM class_schedules WHERE id = @scheduleId FOR UPDATE`);
        current = existing.recordset?.[0];
        if (!current) throw new ClassScheduleError('Class schedule not found.', 404);
      }

      const assignment = await getActiveAssignment(transaction.request(), values.assignmentId, true);
      await validateAssignmentContext(assignment, values);

      const conflictResult = await conflictQuery(transaction.request(), {
        sql,
        ...values,
        scheduleId,
        sectionId: assignment.section_id,
        teacherId: assignment.teacher_id,
        academicTermId: assignment.academic_term_id
      }, true);
      if (conflictResult.recordset?.length) {
        const rows = conflictResult.recordset;
        const conflictsTruncated = rows.length > MAX_CONFLICT_RESULTS;
        const conflicts = toConflictDetails(rows.slice(0, MAX_CONFLICT_RESULTS));
        const message = `${conflictsMessage(conflictsTruncated)}${values.room ? '' : ' Room conflicts were not checked because no room was entered.'}`;
        throw new ClassScheduleError(message, 409, {
          conflicts,
          conflictsTruncated
        });
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
        await request.input('scheduleId', sql.Int, scheduleId).query(`UPDATE class_schedules
          SET assignment_id = @assignmentId, day_of_week = @dayOfWeek,
            start_time = @startTime, end_time = @endTime, room = @room,
            updated_at = UTC_TIMESTAMP(6)
          WHERE id = @scheduleId`);
      } else {
        const inserted = await request.query(`INSERT INTO class_schedules
          (assignment_id, day_of_week, start_time, end_time, room, created_by)
          VALUES (@assignmentId, @dayOfWeek, @startTime, @endTime, @room, @registrarId)`);
        savedId = inserted.insertId;
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
            TIME_FORMAT(schedule.start_time, '%H:%i') AS start_time,
            TIME_FORMAT(schedule.end_time, '%H:%i') AS end_time
          FROM class_schedules AS schedule
          WHERE schedule.id = @scheduleId FOR UPDATE`);
      const row = existing.recordset?.[0];
      if (!row) throw new ClassScheduleError('Class schedule not found.', 404);
      await transaction.request().input('scheduleId', sql.Int, scheduleId)
        .query('DELETE FROM class_schedules WHERE id = @scheduleId');
      await writeAudit(transaction, registrarId, 'class_schedule_removed', scheduleId, {
        assignmentId: row.assignment_id, dayOfWeek: row.day_of_week,
        startTime: row.start_time, endTime: row.end_time
      });
      return scheduleId;
    });
  }

  return { listRegistrarWorkspace, getOwnStudentSchedule, previewScheduleConflicts, saveSchedule, deleteSchedule };
}

module.exports = { ClassScheduleError, createClassScheduleService, positiveId, validateSchedule };
