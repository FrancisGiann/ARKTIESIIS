const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');

const VALID_STATUSES = new Set(['pending', 'received', 'verified', 'correction', 'rejected']);

class PhysicalChecklistError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PhysicalChecklistError';
    this.status = status;
  }
}

function id(value, label) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) throw new PhysicalChecklistError(`Choose a valid ${label}.`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new PhysicalChecklistError(`Choose a valid ${label}.`);
  return number;
}

function cleanText(value, label, limit, required = false) {
  if (typeof value !== 'string') throw new PhysicalChecklistError(`${label} must be ${limit} printable characters or fewer.`);
  const text = value.trim();
  if ((required && !text) || text.length > limit || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new PhysicalChecklistError(`${label} must be ${limit} printable characters or fewer.`);
  }
  return text || null;
}

function count(value, label, maximum) {
  const normalized = value === '' || value == null ? '0' : String(value);
  if (!/^\d{1,2}$/.test(normalized)) throw new PhysicalChecklistError(`${label} must be between 0 and ${maximum}.`);
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw new PhysicalChecklistError(`${label} must be between 0 and ${maximum}.`);
  return number;
}

function validateConfiguredCounts(update, definition) {
  const countTypes = [
    ['originals', 'originals_required', 'Originals'],
    ['copies', 'copies_required', 'Photocopies'],
    ['pieces', 'pieces_required', 'Pieces']
  ];
  for (const [updateKey, definitionKey, label] of countTypes) {
    if (definition[definitionKey] != null && Number(definition[definitionKey]) <= 0 && update[updateKey] > 0) {
      throw new PhysicalChecklistError(`${label} are not tracked for this paper requirement.`);
    }
  }
}

function normalizeIntakeChecklistUpdates(input = {}) {
  const updates = [];
  for (const key of Object.keys(input || {})) {
    if (!/^paper_[a-z0-9_]+_record$/.test(key)) continue;
    const requirementCode = key.slice('paper_'.length, -'_record'.length);
    const record = input[key];
    if (record !== '1') throw new PhysicalChecklistError('Choose a valid paper checklist update.');
    const submittedStatus = input[`paper_${requirementCode}_status`];
    const status = submittedStatus == null || submittedStatus === '' ? 'verified'
      : typeof submittedStatus === 'string' && VALID_STATUSES.has(submittedStatus) ? submittedStatus : null;
    if (!status) throw new PhysicalChecklistError('Choose a valid paper requirement status.');
    const note = cleanText(input[`paper_${requirementCode}_note`] ?? '', 'Staff note', 1000);
    if (status === 'correction' && !note) throw new PhysicalChecklistError('Enter a note when requesting a correction.');
    const isApplicableRaw = input[`paper_${requirementCode}_applicable`];
    if (!['0', '1'].includes(isApplicableRaw)) throw new PhysicalChecklistError('Choose whether the selected paper requirement applies.');
    const idempotencyKey = normalizeUuid(input[`paper_${requirementCode}_token`], 'paper checklist update');
    updates.push({
      requirementCode, status, note, isApplicable: isApplicableRaw === '1',
      originals: count(input[`paper_${requirementCode}_originals`], 'Original count', 20),
      copies: count(input[`paper_${requirementCode}_copies`], 'Photocopy count', 50),
      pieces: count(input[`paper_${requirementCode}_pieces`], 'Piece count', 50),
      idempotencyKey
    });
  }
  if (updates.length > 20) throw new PhysicalChecklistError('Record no more than 20 paper checklist items in one intake.');
  return updates;
}

function normalizeUuid(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new PhysicalChecklistError(`The ${label} token is invalid. Reload the form and try again.`);
  }
  return value;
}

function createPhysicalChecklistService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool)
} = {}) {
  async function transaction(callback) {
    const pool = await getPool();
    const tx = transactionFactory(pool);
    let started = false;
    try {
      await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      const result = await callback(tx);
      await tx.commit();
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try { await tx.rollback(); } catch { /* Preserve the original error. */ }
      }
      if (isDuplicateKeyError(error)) throw new PhysicalChecklistError('This paper-requirement update was already recorded or conflicted with another update.', 409);
      throw error;
    }
  }

  async function requireStaff(request, actorInput, { lock = false } = {}) {
    const actorId = id(actorInput, 'staff user');
    const result = await request.input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin')${lock ? ' FOR UPDATE' : ''}`);
    const actor = result.recordset?.[0];
    if (!actor) throw new PhysicalChecklistError('Staff access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function writeAudit(tx, actor, studentId, code, eventId, status) {
    await tx.request()
      .input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), `${actor.role}.physical_checklist_recorded`)
      .input('entityId', sql.NVarChar(100), String(eventId))
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify({ studentId, requirementCode: code, status }))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, 'student_physical_checklist', @entityId, @details)`);
  }

  async function getStudentChecklist(actorInput, studentInput) {
    const studentId = id(studentInput, 'student');
    const pool = await getPool();
    const actor = await requireStaff(pool.request(), actorInput);
    const studentResult = await pool.request().input('studentId', sql.Int, studentId)
      .query(`SELECT student.id, student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix,
          latest_section.grade_level
        FROM students AS student
        LEFT JOIN (
          SELECT ranked.student_id, ranked.grade_level FROM (
            SELECT enrollment.student_id, section.grade_level,
              ROW_NUMBER() OVER (PARTITION BY enrollment.student_id
                ORDER BY term.is_current DESC, term.id DESC, enrollment.id DESC) AS row_number
            FROM enrollments AS enrollment
            INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
            LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
          ) AS ranked WHERE ranked.row_number = 1
        ) AS latest_section ON latest_section.student_id = student.id
        WHERE student.id = @studentId`);
    const student = studentResult.recordset?.[0];
    if (!student) throw new PhysicalChecklistError('Student record not found.', 404);
    const [requirementResult, historyResult] = await Promise.all([
      pool.request().input('studentId', sql.Int, studentId).query(`
        SELECT definition.requirement_code, definition.requirement_name, definition.guidance, definition.applicability,
          definition.originals_required, definition.copies_required, definition.pieces_required, definition.is_optional,
          latest.status, latest.note, latest.is_applicable, latest.originals_received, latest.copies_received,
          latest.pieces_received, latest.created_at, latest.recorded_by_name, latest.id AS latest_event_id
        FROM physical_requirement_definitions AS definition
        LEFT JOIN (
          SELECT ranked.id, ranked.requirement_code, ranked.status, ranked.note, ranked.is_applicable,
            ranked.originals_received, ranked.copies_received, ranked.pieces_received, ranked.created_at,
            COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(profile.first_name, ' ', profile.last_name))), ''), CONCAT('Staff ', ranked.recorded_by)) AS recorded_by_name
          FROM (
            SELECT event.id, event.requirement_code, event.status, event.note, event.is_applicable,
              event.originals_received, event.copies_received, event.pieces_received, event.created_at, event.recorded_by,
              ROW_NUMBER() OVER (PARTITION BY event.requirement_code ORDER BY event.created_at DESC, event.id DESC) AS row_number
            FROM student_physical_checklist_events AS event WHERE event.student_id = @studentId
          ) AS ranked
          LEFT JOIN staff_profiles AS profile ON profile.user_id = ranked.recorded_by
          WHERE ranked.row_number = 1
        ) AS latest ON latest.requirement_code = definition.requirement_code
        WHERE definition.requirement_code NOT IN ('sf10_form137', 'long_brown_envelopes')
        ORDER BY definition.display_order`)
        .then(async (result) => result),
      pool.request().input('studentId', sql.Int, studentId).query(`SELECT event.id, event.requirement_code,
          event.requirement_name, event.status, event.note, event.is_applicable, event.originals_received,
          event.copies_received, event.pieces_received, event.created_at,
          COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(profile.first_name, ' ', profile.last_name))), ''), CONCAT('Staff ', event.recorded_by)) AS recorded_by_name
        FROM student_physical_checklist_events AS event
        LEFT JOIN staff_profiles AS profile ON profile.user_id = event.recorded_by
        WHERE event.student_id = @studentId
        ORDER BY event.created_at DESC, event.id DESC`)
    ]);
    const requirements = requirementResult.recordset || [];
    const appliesByGrade = (item) => item.applicability !== 'grade11' && item.applicability !== 'grade12'
      || item.applicability === 'grade11' && student.grade_level === 'Grade 11'
      || item.applicability === 'grade12' && student.grade_level === 'Grade 12';
    const requiredItems = requirements.filter((item) => !item.is_optional && appliesByGrade(item));
    const completed = requiredItems.filter((item) => item.is_applicable === 0 || item.is_applicable === false || item.status === 'verified').length;
    const additionalItems = new Map();
    for (const event of historyResult.recordset || []) {
      if (!String(event.requirement_code).startsWith('additional:')) continue;
      if (!additionalItems.has(event.requirement_code)) additionalItems.set(event.requirement_code, event);
    }
    return {
      student: { ...student, requestedBy: actor.role },
      requirements,
      history: historyResult.recordset || [],
      additionalItems: [...additionalItems.values()],
      summary: { requiredCount: requiredItems.length, completeCount: completed }
    };
  }

  async function listIntakeRequirements(actorInput) {
    const pool = await getPool();
    await requireStaff(pool.request(), actorInput);
    const result = await pool.request().query(`SELECT requirement_code, requirement_name, guidance, applicability,
        originals_required, copies_required, pieces_required, is_optional, display_order
      FROM physical_requirement_definitions
      WHERE requirement_code NOT IN ('sf10_form137', 'long_brown_envelopes')
      ORDER BY display_order`);
    return result.recordset || [];
  }

  async function appendRequirementEvent(tx, actor, studentId, update, requirementName) {
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ studentId,
      requirementCode: update.requirementCode, requirementName: requirementName || null,
      status: update.status, note: update.note, isApplicable: update.isApplicable,
      originals: update.originals, copies: update.copies, pieces: update.pieces })).digest('hex');
    const prior = await tx.request().input('idempotencyKey', sql.UniqueIdentifier, update.idempotencyKey)
      .query(`SELECT id, student_id, requirement_code, request_fingerprint
        FROM student_physical_checklist_events WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
    if (prior.recordset?.[0]) {
      const old = prior.recordset[0];
      if (Number(old.student_id) !== studentId || old.requirement_code !== update.requirementCode || old.request_fingerprint !== fingerprint) {
        throw new PhysicalChecklistError('This submission token was already used for different paper-requirement details.', 409);
      }
      return { eventId: old.id, alreadyRecorded: true };
    }
    const inserted = await tx.request()
      .input('studentId', sql.Int, studentId)
      .input('requirementCode', sql.NVarChar(60), update.requirementCode)
      .input('requirementName', sql.NVarChar(120), requirementName)
      .input('status', sql.NVarChar(30), update.status)
      .input('note', sql.NVarChar(1000), update.note)
      .input('isApplicable', sql.Bit, update.isApplicable)
      .input('originals', sql.TinyInt, update.originals)
      .input('copies', sql.TinyInt, update.copies)
      .input('pieces', sql.TinyInt, update.pieces)
      .input('idempotencyKey', sql.UniqueIdentifier, update.idempotencyKey)
      .input('fingerprint', sql.Char(64), fingerprint)
      .input('actorId', sql.Int, actor.id)
      .query(`INSERT INTO student_physical_checklist_events
          (student_id, requirement_code, requirement_name, status, note, is_applicable, originals_received,
            copies_received, pieces_received, idempotency_key, request_fingerprint, recorded_by)
        VALUES (@studentId, @requirementCode, @requirementName, @status, @note, @isApplicable, @originals,
          @copies, @pieces, @idempotencyKey, @fingerprint, @actorId)`);
    const eventId = inserted.insertId;
    if (!eventId) throw new Error('Physical checklist event insert returned no identifier.');
    await writeAudit(tx, actor, studentId, update.requirementCode, eventId, update.status);
    return { eventId, alreadyRecorded: false };
  }

  async function recordIntakeUpdatesInTransaction(tx, actorInput, studentInput, gradeInput, updates = []) {
    if (!Array.isArray(updates) || updates.length > 20) throw new PhysicalChecklistError('The paper checklist updates are invalid.');
    if (!['Grade 11', 'Grade 12'].includes(gradeInput)) throw new PhysicalChecklistError('Choose a valid grade for the paper checklist.');
    if (!updates.length) return [];
    const actor = await requireStaff(tx.request(), actorInput, { lock: true });
    const studentId = id(studentInput, 'student');
    const studentResult = await tx.request().input('studentId', sql.Int, studentId)
      .query('SELECT id, status FROM students WHERE id = @studentId FOR UPDATE');
    if (!studentResult.recordset?.length) throw new PhysicalChecklistError('Student record not found.', 404);
    if (studentResult.recordset[0].status === 'archived') throw new PhysicalChecklistError('Archived student paper histories are read-only.', 409);
    const eventIds = [];
    for (const update of updates) {
      const definitionResult = await tx.request().input('requirementCode', sql.NVarChar(60), update.requirementCode)
        .query(`SELECT requirement_code, requirement_name, applicability, originals_required, copies_required, pieces_required FROM physical_requirement_definitions
          WHERE requirement_code = @requirementCode FOR UPDATE`);
      const definition = definitionResult.recordset?.[0];
      if (!definition || definition.requirement_code === 'sf10_form137' || definition.applicability === 'staff') {
        throw new PhysicalChecklistError('Choose a paper requirement that applies to this intake.');
      }
      if (definition.requirement_code === 'long_brown_envelopes') {
        throw new PhysicalChecklistError('Long brown envelopes are storage containers and are not tracked as paper requirements.', 409);
      }
      validateConfiguredCounts(update, definition);
      if (definition.applicability === 'grade11' && gradeInput !== 'Grade 11'
        || definition.applicability === 'grade12' && gradeInput !== 'Grade 12') {
        throw new PhysicalChecklistError('This card requirement does not apply to the selected grade.');
      }
      if (['als', 'esc', 'optional'].includes(definition.applicability) === false && !update.isApplicable) {
        throw new PhysicalChecklistError('This paper requirement cannot be marked not applicable.');
      }
      if (update.status === 'correction' && !update.note) throw new PhysicalChecklistError('Enter a note when requesting a correction.');
      const appended = await appendRequirementEvent(tx, actor, studentId, update, definition.requirement_name);
      eventIds.push(appended.eventId);
    }
    return eventIds;
  }

  async function getStudentSummaries(actorInput, studentInputs = []) {
    const studentIds = [...new Set((Array.isArray(studentInputs) ? studentInputs : []).map((value) => id(value, 'student')))];
    if (!studentIds.length) return new Map();
    const pool = await getPool();
    await requireStaff(pool.request(), actorInput);
    const parameters = pool.request();
    const placeholders = studentIds.map((studentId, index) => {
      parameters.input(`student${index}`, sql.Int, studentId);
      return `@student${index}`;
    });
    const result = await parameters.query(`
      WITH latest AS (
        SELECT event.student_id, event.requirement_code, event.status, event.is_applicable,
          ROW_NUMBER() OVER (PARTITION BY event.student_id, event.requirement_code ORDER BY event.created_at DESC, event.id DESC) AS event_rank
        FROM student_physical_checklist_events AS event
        WHERE event.student_id IN (${placeholders.join(', ')})
      )
      SELECT student.id AS student_id,
        SUM(CASE WHEN definition.is_optional = 0 AND definition.applicability NOT IN ('grade11', 'grade12') THEN 1
          WHEN definition.is_optional = 0 AND definition.applicability = 'grade11' AND current_section.grade_level = 'Grade 11' THEN 1
          WHEN definition.is_optional = 0 AND definition.applicability = 'grade12' AND current_section.grade_level = 'Grade 12' THEN 1 ELSE 0 END) AS required_count,
        SUM(CASE WHEN (definition.is_optional = 0 AND definition.applicability NOT IN ('grade11', 'grade12')
              OR definition.is_optional = 0 AND definition.applicability = 'grade11' AND current_section.grade_level = 'Grade 11'
              OR definition.is_optional = 0 AND definition.applicability = 'grade12' AND current_section.grade_level = 'Grade 12')
            AND (latest.status = 'verified' OR latest.is_applicable = 0) THEN 1 ELSE 0 END) AS completed_count
      FROM students AS student
      LEFT JOIN (
        SELECT ranked.student_id, ranked.grade_level FROM (
          SELECT enrollment.student_id, section.grade_level,
            ROW_NUMBER() OVER (PARTITION BY enrollment.student_id
              ORDER BY term.is_current DESC, term.id DESC, enrollment.id DESC) AS row_number
          FROM enrollments AS enrollment
          INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
          LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        ) AS ranked WHERE ranked.row_number = 1
      ) AS current_section ON current_section.student_id = student.id
      CROSS JOIN physical_requirement_definitions AS definition
      LEFT JOIN latest ON latest.student_id = student.id AND latest.requirement_code = definition.requirement_code AND latest.event_rank = 1
      WHERE student.id IN (${placeholders.join(', ')}) AND definition.requirement_code NOT IN ('sf10_form137', 'long_brown_envelopes')
      GROUP BY student.id`);
    return new Map((result.recordset || []).map((row) => [Number(row.student_id), row]));
  }

  async function recordRequirement(actorInput, studentInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const requestedCode = cleanText(input.requirementCode, 'Requirement', 60, true);
    const customName = requestedCode === 'additional'
      ? cleanText(input.requirementName, 'Additional requirement name', 120, true)
      : null;
    const requirementCode = customName
      ? `additional:${crypto.createHash('sha256').update(customName.toLocaleLowerCase()).digest('hex').slice(0, 24)}`
      : requestedCode;
    const status = typeof input.status === 'string' && VALID_STATUSES.has(input.status) ? input.status : null;
    if (!status) throw new PhysicalChecklistError('Choose pending, received, verified, correction, or rejected.');
    const note = cleanText(input.note ?? '', 'Staff note', 1000);
    if (status === 'correction' && !note) throw new PhysicalChecklistError('Enter a note when requesting a correction.');
    const idempotencyKey = typeof input.idempotencyKey === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)
      ? input.idempotencyKey : null;
    if (!idempotencyKey) throw new PhysicalChecklistError('The submission token is invalid. Reload the page and try again.');
    const originals = count(input.originalsReceived, 'Original count', 20);
    const copies = count(input.copiesReceived, 'Photocopy count', 50);
    const pieces = count(input.piecesReceived, 'Piece count', 50);
    const isApplicableRaw = input.isApplicable;
    if (!['0', '1', 0, 1, true, false].includes(isApplicableRaw)) throw new PhysicalChecklistError('Choose whether this requirement applies to the learner.');
    const isApplicable = isApplicableRaw === '1' || isApplicableRaw === 1 || isApplicableRaw === true;
      const update = { requirementCode, status, note, isApplicable, originals, copies, pieces, idempotencyKey };
      return transaction(async (tx) => {
        const actor = await requireStaff(tx.request(), actorInput, { lock: true });
      const studentResult = await tx.request().input('studentId', sql.Int, studentId)
        .query('SELECT id, status FROM students WHERE id = @studentId FOR UPDATE');
      if (!studentResult.recordset?.length) throw new PhysicalChecklistError('Student record not found.', 404);
      if (studentResult.recordset[0].status === 'archived') throw new PhysicalChecklistError('Archived student paper histories are read-only.', 409);
      const definitionResult = customName ? { recordset: [] } : await tx.request().input('requirementCode', sql.NVarChar(60), requirementCode)
        .query(`SELECT requirement_code, requirement_name, applicability, originals_required, copies_required, pieces_required FROM physical_requirement_definitions
          WHERE requirement_code = @requirementCode FOR UPDATE`);
      const definition = definitionResult.recordset?.[0] || (customName ? {
        requirement_code: requirementCode, requirement_name: customName, applicability: 'optional'
      } : null);
      if (!definition || definition.requirement_code === 'sf10_form137') throw new PhysicalChecklistError('Choose a named student paper requirement. SF10 / Form 137 uses its existing staff-only history.', 409);
      if (definition.requirement_code === 'long_brown_envelopes') {
        throw new PhysicalChecklistError('Long brown envelopes are storage containers and are not tracked as paper requirements.', 409);
      }
      validateConfiguredCounts(update, definition);
      if (customName || ['als', 'esc', 'optional'].includes(definition.applicability)) {
        // Applicability is entered by staff; it is not inferred from the learner’s voucher.
      } else if (!isApplicable) {
        throw new PhysicalChecklistError('Only optional or manually applicable requirements can be marked not applicable.');
      }
      return appendRequirementEvent(tx, actor, studentId, update, definition.requirement_name);
    });
  }

  return { getStudentChecklist, getStudentSummaries, listIntakeRequirements, recordIntakeUpdatesInTransaction, recordRequirement };
}

module.exports = { PhysicalChecklistError, createPhysicalChecklistService, normalizeIntakeChecklistUpdates };
