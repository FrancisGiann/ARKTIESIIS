'use strict';

const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');

const STAFF_ROLES = new Set(['registrar', 'database_admin']);
const CHANNELS = new Set(['paper', 'digital', 'both']);
const PAPER_STATUSES = new Set(['pending', 'received', 'verified', 'correction', 'rejected']);
const MANUAL_CHECKLIST = Object.freeze([
  { key: 'sourceInspected', label: 'Source document was physically inspected.' },
  { key: 'typeConfirmed', label: 'The document type matches the assigned requirement.' },
  { key: 'readableComplete', label: 'The submitted material is readable and complete.' }
]);

class RequirementServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RequirementServiceError';
    this.status = status;
  }
}

function normalizeId(value, label = 'record') {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) throw new RequirementServiceError(`Choose a valid ${label}.`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new RequirementServiceError(`Choose a valid ${label}.`);
  return number;
}

function cleanText(value, label, maxLength, required = false, allowNewlines = false) {
  if (typeof value !== 'string') throw new RequirementServiceError(`Enter a valid ${label}.`);
  const text = value.trim();
  const invalidControls = allowNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) : /[\u0000-\u001f\u007f]/.test(text);
  if ((required && !text) || text.length > maxLength || invalidControls) {
    throw new RequirementServiceError(`Enter a valid ${label} of ${required ? '1 to ' : '0 to '}${maxLength} characters.`);
  }
  return text;
}

function validateCustomDisplayName(value) {
  const name = cleanText(value, 'requirement name', 120, true);
  if (/\b(?:form[\s-]*137|sf[\s-]*10|school[\s-]*form[\s-]*10|137\s+(?:form|sf))\b/i.test(name)) {
    throw new RequirementServiceError('Custom requirement names cannot use restricted Form 137 or SF10 identities.');
  }
  return name;
}

function validateStudentInstructions(value) {
  const instructions = cleanText(value, 'student instruction', 1000, true, true);
  if (/\b(?:form[\s-]*137|sf[\s-]*10|school[\s-]*form[\s-]*10|137\s+(?:form|sf))\b/i.test(instructions)) {
    throw new RequirementServiceError('Student instructions cannot expose restricted Form 137 or SF10 records.');
  }
  return instructions;
}

function normalizedSchoolYear(value) {
  const year = cleanText(value, 'school year', 20, true);
  if (!/^(?:19|20|21)\d{2}-(?:19|20|21)\d{2}$/.test(year)) throw new RequirementServiceError('Choose a valid school year.');
  return year;
}

function actorId(value) {
  return normalizeId(value, 'staff account');
}

function manualChecklist(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || MANUAL_CHECKLIST.some(({ key }) => value[key] !== 'yes')) {
    throw new RequirementServiceError('Confirm each manual source-inspection checklist item before recording a verified paper copy.');
  }
  return JSON.stringify({ schemaVersion: 1, sourceInspected: true, typeConfirmed: true, readableComplete: true });
}

function createRequirementService({ getPool = defaultGetPool, sql = defaultSql, transactionFactory = (pool) => new sql.Transaction(pool) } = {}) {
  async function transaction(callback) {
    const tx = transactionFactory(await getPool());
    let started = false;
    try {
      await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      const result = await callback(tx);
      await tx.commit();
      started = false;
      return result;
    } catch (error) {
      if (started) await tx.rollback().catch(() => {});
      if (isDuplicateKeyError(error)) throw new RequirementServiceError('This requirement assignment already exists for the selected school year.', 409);
      throw error;
    }
  }

  async function requireActor(request, actorInput, roles = STAFF_ROLES, lock = false) {
    const id = actorId(actorInput);
    const result = await request.input('actorId', sql.Int, id).query(`SELECT id, role FROM users
      WHERE id = @actorId AND is_active = 1 AND role IN (${[...roles].map((role) => `'${role}'`).join(', ')})${lock ? ' FOR UPDATE' : ''}`);
    const actor = result.recordset?.[0];
    if (!actor) throw new RequirementServiceError('Your requirement access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function writeAudit(tx, actor, action, entityType, entityId, details) {
    await tx.request().input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), `${actor.role}.${action}`)
      .input('entityType', sql.NVarChar(100), entityType)
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @details)`);
  }

  async function recordAssignmentEvent(tx, actor, assignmentId, type, version, details = {}) {
    await tx.request().input('assignmentId', sql.Int, assignmentId).input('actorId', sql.Int, actor.id)
      .input('eventType', sql.NVarChar(16), type).input('version', sql.Int, version)
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO requirement_assignment_events (assignment_id, actor_id, event_type, version_no, details_json)
        VALUES (@assignmentId, @actorId, @eventType, @version, @details)`);
  }

  async function listCatalog(actorInput) {
    const pool = await getPool();
    await requireActor(pool.request(), actorInput, new Set(['database_admin']));
    const result = await pool.request().query(`SELECT id, requirement_code, display_name, student_instructions, channel,
        is_active, is_builtin, version_no, updated_at FROM requirement_catalog ORDER BY is_builtin DESC, display_name, id`);
    return result.recordset || [];
  }

  async function createCatalogItem(actorInput, input = {}) {
    const displayName = validateCustomDisplayName(input.displayName);
    const instructions = validateStudentInstructions(input.instructions);
    const channel = CHANNELS.has(input.channel) ? input.channel : null;
    if (!channel) throw new RequirementServiceError('Choose paper, digital, or both channels.');
    return transaction(async (tx) => {
      const actor = await requireActor(tx.request(), actorInput, new Set(['database_admin']), true);
      const code = `custom_${crypto.randomUUID().replaceAll('-', '')}`;
      const inserted = await tx.request().input('code', sql.NVarChar(60), code)
        .input('name', sql.NVarChar(120), displayName).input('instructions', sql.NVarChar(1000), instructions)
        .input('channel', sql.NVarChar(12), channel).input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO requirement_catalog (requirement_code, display_name, student_instructions, channel,
            is_active, is_builtin, version_no, created_by, updated_by)
          VALUES (@code, @name, @instructions, @channel, 1, 0, 1, @actorId, @actorId)`);
      const id = inserted.insertId;
      await writeAudit(tx, actor, 'requirement_catalog_created', 'requirement_catalog', id, { channel, version: 1 });
      return { id, requirementCode: code, displayName, instructions, channel, isActive: true, version: 1 };
    });
  }

  async function updateCatalogItem(actorInput, catalogInput, input = {}) {
    const id = normalizeId(catalogInput, 'catalog item');
    const version = normalizeId(input.version, 'catalog version');
    const displayName = validateCustomDisplayName(input.displayName);
    const instructions = validateStudentInstructions(input.instructions);
    const channel = CHANNELS.has(input.channel) ? input.channel : null;
    if (!channel || !['0', '1', true, false, 0, 1].includes(input.isActive)) throw new RequirementServiceError('Choose valid requirement settings.');
    const isActive = input.isActive === true || input.isActive === 1 || input.isActive === '1';
    return transaction(async (tx) => {
      const actor = await requireActor(tx.request(), actorInput, new Set(['database_admin']), true);
      const current = await tx.request().input('id', sql.Int, id).query('SELECT * FROM requirement_catalog WHERE id = @id FOR UPDATE');
      const row = current.recordset?.[0];
      if (!row || row.is_builtin === true || row.is_builtin === 1) throw new RequirementServiceError('Built-in requirement identities and policies are protected.', 409);
      if (Number(row.version_no) !== version) throw new RequirementServiceError('This catalog item changed. Reload it and try again.', 409);
      const updated = await tx.request().input('id', sql.Int, id).input('version', sql.Int, version)
        .input('name', sql.NVarChar(120), displayName).input('instructions', sql.NVarChar(1000), instructions)
        .input('channel', sql.NVarChar(12), channel).input('isActive', sql.Bit, isActive).input('actorId', sql.Int, actor.id)
        .query(`UPDATE requirement_catalog SET display_name = @name, student_instructions = @instructions,
            channel = @channel, is_active = @isActive, version_no = version_no + 1,
            updated_by = @actorId, updated_at = UTC_TIMESTAMP(3)
          WHERE id = @id AND version_no = @version AND is_builtin = 0`);
      if (!updated.affectedRows) throw new RequirementServiceError('This catalog item changed. Reload it and try again.', 409);
      await writeAudit(tx, actor, 'requirement_catalog_updated', 'requirement_catalog', id, { channel, isActive, version: version + 1 });
      return { id, version: version + 1 };
    });
  }

  async function getAssignmentWorkspace(actorInput, studentInput, yearInput = '') {
    const studentId = normalizeId(studentInput, 'student');
    const pool = await getPool();
    const actor = await requireActor(pool.request(), actorInput);
    const studentResult = await pool.request().input('studentId', sql.Int, studentId).input('actorId', sql.Int, actor.id)
      .query(`SELECT id, student_no, first_name, middle_name, last_name, status FROM students
        WHERE id = @studentId AND EXISTS (SELECT 1 FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar','database_admin'))`);
    const student = studentResult.recordset?.[0];
    if (!student) throw new RequirementServiceError('Student record not found.', 404);
    const yearsResult = await pool.request().input('studentId', sql.Int, studentId).query(`SELECT school_year FROM annual_enrollments
      WHERE student_id = @studentId UNION SELECT school_year FROM academic_terms ORDER BY school_year DESC`);
    const schoolYears = [...new Set((yearsResult.recordset || []).map((row) => String(row.school_year || '')))].filter(Boolean);
    const year = yearInput ? normalizedSchoolYear(yearInput) : schoolYears[0] || '';
    if (year && !schoolYears.includes(year)) throw new RequirementServiceError('Choose a school year recorded for this student.');
    const [catalogResult, assignmentResult] = await Promise.all([
      pool.request().query(`SELECT id, requirement_code, display_name, student_instructions, channel, version_no
        FROM requirement_catalog WHERE is_active = 1 AND is_builtin = 0 ORDER BY display_name, id`),
      pool.request().input('studentId', sql.Int, studentId).input('schoolYear', sql.NVarChar(20), year)
        .query(`SELECT assignment.id, assignment.requirement_code, assignment.display_name_snapshot AS display_name,
            assignment.student_instructions_snapshot AS student_instructions, assignment.channel_snapshot AS channel,
            assignment.catalog_version_snapshot, assignment.is_required, assignment.status, assignment.withdrawal_reason,
            assignment.version_no, assignment.created_at, assignment.updated_at,
            paper.status AS latest_paper_status, paper.created_at AS latest_paper_at,
            digital.id AS latest_document_id, digital.status AS latest_document_status,
            decision.decision_type AS latest_document_decision
          FROM requirement_assignments AS assignment
          LEFT JOIN (
            SELECT ranked.requirement_assignment_id, ranked.status, ranked.created_at FROM (
              SELECT event.requirement_assignment_id, event.status, event.created_at,
                ROW_NUMBER() OVER (PARTITION BY event.requirement_assignment_id ORDER BY event.created_at DESC, event.id DESC) AS row_rank
              FROM student_physical_checklist_events AS event WHERE event.requirement_assignment_id IS NOT NULL
            ) AS ranked WHERE ranked.row_rank = 1
          ) AS paper ON paper.requirement_assignment_id = assignment.id
          LEFT JOIN (
            SELECT ranked.id, ranked.requirement_assignment_id, ranked.status, ranked.created_at FROM (
              SELECT document.id, document.requirement_assignment_id, document.status, document.created_at,
                ROW_NUMBER() OVER (PARTITION BY document.requirement_assignment_id ORDER BY document.created_at DESC, document.id DESC) AS row_rank
              FROM documents AS document WHERE document.requirement_assignment_id IS NOT NULL
            ) AS ranked WHERE ranked.row_rank = 1
          ) AS digital ON digital.requirement_assignment_id = assignment.id
          LEFT JOIN v_document_latest_decision_event AS decision ON decision.document_id = digital.id
          WHERE assignment.student_id = @studentId AND assignment.school_year = @schoolYear
          ORDER BY assignment.created_at DESC, assignment.id DESC`)
    ]);
    return { student, schoolYears, selectedSchoolYear: year, catalog: catalogResult.recordset || [], assignments: assignmentResult.recordset || [] };
  }

  async function assign(actorInput, studentInput, input = {}) {
    const studentId = normalizeId(studentInput, 'student');
    const catalogId = normalizeId(input.catalogId, 'catalog item');
    const catalogVersion = normalizeId(input.catalogVersion, 'catalog version');
    const schoolYear = normalizedSchoolYear(input.schoolYear);
    const required = input.isRequired === '1' || input.isRequired === true || input.isRequired === 1;
    if (!['0', '1', true, false, 0, 1].includes(input.isRequired)) throw new RequirementServiceError('Choose whether the requirement is required or optional.');
    return transaction(async (tx) => {
      const actor = await requireActor(tx.request(), actorInput, STAFF_ROLES, true);
      const studentResult = await tx.request().input('studentId', sql.Int, studentId).query('SELECT id, status FROM students WHERE id = @studentId FOR UPDATE');
      if (!studentResult.recordset?.length) throw new RequirementServiceError('Student record not found.', 404);
      if (studentResult.recordset[0].status === 'archived') throw new RequirementServiceError('Archived student records are read-only.', 409);
      const catalogResult = await tx.request().input('catalogId', sql.Int, catalogId).query('SELECT * FROM requirement_catalog WHERE id = @catalogId FOR UPDATE');
      const catalog = catalogResult.recordset?.[0];
      if (!catalog || catalog.is_builtin === true || catalog.is_builtin === 1) throw new RequirementServiceError('Choose an active custom requirement.');
      if (!(catalog.is_active === true || catalog.is_active === 1)) throw new RequirementServiceError('This requirement is inactive and cannot be assigned.', 409);
      if (Number(catalog.version_no) !== catalogVersion) throw new RequirementServiceError('The requirement catalog changed. Reload and try again.', 409);
      const yearResult = await tx.request().input('studentId', sql.Int, studentId).input('schoolYear', sql.NVarChar(20), schoolYear)
        .query(`SELECT 1 AS present FROM academic_terms WHERE school_year = @schoolYear
          UNION SELECT 1 AS present FROM annual_enrollments WHERE student_id = @studentId AND school_year = @schoolYear LIMIT 1`);
      if (!yearResult.recordset?.length) throw new RequirementServiceError('Choose a school year recorded by the school for this student.');
      const inserted = await tx.request().input('catalogId', sql.Int, catalog.id).input('code', sql.NVarChar(60), catalog.requirement_code)
        .input('studentId', sql.Int, studentId).input('schoolYear', sql.NVarChar(20), schoolYear)
        .input('displayName', sql.NVarChar(120), catalog.display_name).input('instructions', sql.NVarChar(1000), catalog.student_instructions)
        .input('channel', sql.NVarChar(12), catalog.channel).input('catalogVersion', sql.Int, catalog.version_no)
        .input('required', sql.Bit, required).input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO requirement_assignments (requirement_id, requirement_code, student_id, school_year,
            display_name_snapshot, student_instructions_snapshot, channel_snapshot, catalog_version_snapshot,
            is_required, status, version_no, assigned_by, updated_by)
          VALUES (@catalogId, @code, @studentId, @schoolYear, @displayName, @instructions, @channel,
            @catalogVersion, @required, 'active', 1, @actorId, @actorId)`);
      const assignmentId = inserted.insertId;
      await recordAssignmentEvent(tx, actor, assignmentId, 'assigned', 1, { catalogVersion: Number(catalog.version_no), required });
      await writeAudit(tx, actor, 'custom_requirement_assigned', 'requirement_assignment', assignmentId,
        { studentId, schoolYear, channel: catalog.channel, required });
      return { id: assignmentId };
    });
  }

  async function withdraw(actorInput, assignmentInput, input = {}) {
    const assignmentId = normalizeId(assignmentInput, 'requirement assignment');
    const expectedStudentId = normalizeId(input.studentId, 'student');
    const version = normalizeId(input.version, 'assignment version');
    const reason = cleanText(input.reason, 'withdrawal reason', 1000, true);
    return transaction(async (tx) => {
      const actor = await requireActor(tx.request(), actorInput, STAFF_ROLES, true);
      const found = await tx.request().input('id', sql.Int, assignmentId).query(`SELECT assignment.*, student.status AS student_status
        FROM requirement_assignments AS assignment
        INNER JOIN students AS student ON student.id = assignment.student_id
        WHERE assignment.id = @id FOR UPDATE`);
      const assignment = found.recordset?.[0];
      if (!assignment) throw new RequirementServiceError('Requirement assignment not found.', 404);
      if (Number(assignment.student_id) !== expectedStudentId) throw new RequirementServiceError('Requirement assignment not found.', 404);
      if (assignment.student_status === 'archived') throw new RequirementServiceError('Archived student records are read-only.', 409);
      if (Number(assignment.version_no) !== version || assignment.status !== 'active') throw new RequirementServiceError('This assignment changed. Reload it and try again.', 409);
      await tx.request().input('id', sql.Int, assignmentId).input('version', sql.Int, version)
        .input('reason', sql.NVarChar(1000), reason).input('actorId', sql.Int, actor.id)
        .query(`UPDATE requirement_assignments SET status = 'withdrawn', withdrawal_reason = @reason,
          version_no = version_no + 1, updated_by = @actorId, updated_at = UTC_TIMESTAMP(3)
          WHERE id = @id AND version_no = @version AND status = 'active'`);
      await recordAssignmentEvent(tx, actor, assignmentId, 'withdrawn', version + 1, { reason });
      await writeAudit(tx, actor, 'custom_requirement_withdrawn', 'requirement_assignment', assignmentId,
        { studentId: Number(assignment.student_id), schoolYear: assignment.school_year });
      return { id: assignmentId, status: 'withdrawn', version: version + 1 };
    });
  }

  async function recordPaper(actorInput, assignmentInput, input = {}) {
    const assignmentId = normalizeId(assignmentInput, 'requirement assignment');
    const expectedStudentId = normalizeId(input.studentId, 'student');
    const status = PAPER_STATUSES.has(input.status) ? input.status : null;
    const note = cleanText(input.note || '', 'staff note', 1000, status === 'correction' || status === 'rejected');
    if (!status) throw new RequirementServiceError('Choose a valid paper requirement status.');
    const checklist = status === 'verified' ? manualChecklist(input.checklist) : null;
    const idempotency = typeof input.idempotencyKey === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)
      ? input.idempotencyKey : null;
    if (!idempotency) throw new RequirementServiceError('Reload the form to receive a valid update token.');
    return transaction(async (tx) => {
      const actor = await requireActor(tx.request(), actorInput, STAFF_ROLES, true);
      const assignmentResult = await tx.request().input('id', sql.Int, assignmentId).query(`SELECT assignment.id, assignment.student_id, assignment.requirement_code,
          assignment.display_name_snapshot, assignment.channel_snapshot, assignment.status, student.status AS student_status
        FROM requirement_assignments AS assignment INNER JOIN students AS student ON student.id = assignment.student_id
        WHERE assignment.id = @id FOR UPDATE`);
      const assignment = assignmentResult.recordset?.[0];
      if (!assignment || !['paper', 'both'].includes(assignment.channel_snapshot)) throw new RequirementServiceError('This assignment does not accept paper evidence.', 404);
      if (Number(assignment.student_id) !== expectedStudentId) throw new RequirementServiceError('Requirement assignment not found.', 404);
      if (assignment.student_status === 'archived') throw new RequirementServiceError('Archived student records are read-only.', 409);
      if (assignment.status !== 'active') throw new RequirementServiceError('Withdrawn requirements do not accept new paper evidence.', 409);
      const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify({ assignmentId, status, note, checklist })).digest('hex');
      const inserted = await tx.request().input('studentId', sql.Int, assignment.student_id).input('code', sql.NVarChar(60), assignment.requirement_code)
        .input('name', sql.NVarChar(120), assignment.display_name_snapshot).input('status', sql.NVarChar(30), status)
        .input('note', sql.NVarChar(1000), note).input('idempotency', sql.UniqueIdentifier, idempotency)
        .input('fingerprint', sql.Char(64), requestFingerprint).input('actorId', sql.Int, actor.id)
        .input('assignmentId', sql.Int, assignmentId).input('checklist', sql.NVarChar(sql.MAX), checklist)
        .query(`INSERT INTO student_physical_checklist_events
            (student_id, requirement_code, requirement_name, status, note, is_applicable,
              originals_received, copies_received, pieces_received, idempotency_key, request_fingerprint,
              recorded_by, requirement_assignment_id, verification_checklist_json)
          VALUES (@studentId, @code, @name, @status, @note, 1, 0, 0, 0, @idempotency, @fingerprint,
            @actorId, @assignmentId, @checklist)`);
      await writeAudit(tx, actor, 'custom_paper_requirement_recorded', 'student_physical_checklist', inserted.insertId,
        { studentId: Number(assignment.student_id), assignmentId, status });
      return { id: inserted.insertId, status };
    });
  }

  async function getStudentProgress(userInput, yearInput = '') {
    const studentUserId = normalizeId(userInput, 'student account');
    const pool = await getPool();
    const accountResult = await pool.request().input('actorId', sql.Int, studentUserId)
      .query(`SELECT id FROM users WHERE id = @actorId AND is_active = 1 AND role = 'student'`);
    if (!accountResult.recordset?.length) throw new RequirementServiceError('Student access is no longer active. Sign in again.', 403);
    const studentResult = await pool.request().input('actorId', sql.Int, studentUserId)
      .query(`SELECT id, first_name, status FROM students WHERE user_id = @actorId`);
    const student = studentResult.recordset?.[0];
    if (!student) return { student: null, schoolYears: [], selectedSchoolYear: '', enrollment: null, placements: [], paperRequirements: [], digitalRequirements: [], customRequirements: [] };
    const yearsResult = await pool.request().input('studentId', sql.Int, student.id)
      .query(`SELECT school_year FROM annual_enrollments WHERE student_id = @studentId
        UNION SELECT term.school_year FROM enrollments AS enrollment
          INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id WHERE enrollment.student_id = @studentId
        UNION SELECT school_year FROM requirement_assignments WHERE student_id = @studentId
        ORDER BY school_year DESC`);
    const schoolYears = [...new Set((yearsResult.recordset || []).map((row) => String(row.school_year || '')))].filter(Boolean);
    const currentResult = await pool.request().query('SELECT DISTINCT school_year FROM academic_terms WHERE is_current = 1');
    const currentYears = [...new Set((currentResult.recordset || []).map((row) => String(row.school_year || '')).filter(Boolean))];
    const currentYear = currentYears.length === 1 ? currentYears[0] : '';
    if (currentYear && !schoolYears.includes(currentYear)) schoolYears.unshift(currentYear);
    if (!yearInput && currentYear) yearInput = currentYear;
    const selectedYear = yearInput ? normalizedSchoolYear(yearInput) : schoolYears[0] || '';
    if (selectedYear && !schoolYears.includes(selectedYear)) throw new RequirementServiceError('Choose one of your recorded school years.');
    if (!selectedYear) return { student: { firstName: student.first_name, archived: student.status === 'archived' }, schoolYears, selectedSchoolYear: '', enrollment: null, placements: [], paperRequirements: [], digitalRequirements: [], customRequirements: [] };
    const enrollmentResult = await pool.request().input('studentId', sql.Int, student.id).input('schoolYear', sql.NVarChar(20), selectedYear)
      .query(`SELECT annual.id, annual.grade_level, annual.intake_status, annual.entry_term_number,
          EXISTS (SELECT 1 FROM annual_registrar_confirmations AS confirmation WHERE confirmation.annual_enrollment_id = annual.id) AS confirmed
        FROM annual_enrollments AS annual WHERE annual.student_id = @studentId AND annual.school_year = @schoolYear LIMIT 1`);
    const annual = enrollmentResult.recordset?.[0] || null;
    const [placementsResult, physicalResult, digitalResult, customResult, physicalHistoryResult] = await Promise.all([
      pool.request().input('studentId', sql.Int, student.id).input('schoolYear', sql.NVarChar(20), selectedYear).query(`SELECT enrollment.annual_term_number,
          enrollment.enrollment_status, section.grade_level, section.name AS section_name, section.strand, term.is_current
        FROM enrollments AS enrollment JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        WHERE enrollment.student_id = @studentId AND term.school_year = @schoolYear AND enrollment.annual_term_number BETWEEN 1 AND 3
        ORDER BY enrollment.annual_term_number, enrollment.id`),
      pool.request().input('studentId', sql.Int, student.id).query(`SELECT definition.requirement_code, definition.requirement_name,
          definition.guidance, definition.applicability, definition.is_optional, latest.status, latest.is_applicable, latest.created_at
        FROM physical_requirement_definitions AS definition
        LEFT JOIN (SELECT ranked.requirement_code, ranked.status, ranked.is_applicable, ranked.created_at FROM (
          SELECT event.requirement_code, event.status, event.is_applicable, event.created_at,
            ROW_NUMBER() OVER (PARTITION BY event.requirement_code ORDER BY event.created_at DESC, event.id DESC) AS row_rank
          FROM student_physical_checklist_events AS event WHERE event.student_id = @studentId AND event.requirement_assignment_id IS NULL
        ) AS ranked WHERE ranked.row_rank = 1) AS latest ON latest.requirement_code = definition.requirement_code
        WHERE definition.requirement_code NOT IN ('sf10_form137','long_brown_envelopes') ORDER BY definition.display_order`),
      pool.request().input('studentId', sql.Int, student.id).input('schoolYear', sql.NVarChar(20), selectedYear)
      .query(`WITH ranked AS (SELECT document.document_type, document.status, document.created_at,
            decision.decision_type,
            ROW_NUMBER() OVER (PARTITION BY document.document_type ORDER BY document.created_at DESC, document.id DESC) AS row_rank
            FROM documents AS document LEFT JOIN v_document_latest_decision_event AS decision ON decision.document_id = document.id
            WHERE document.student_id = @studentId
              AND document.document_type IN ('good_moral','psa_birth_certificate','report_card') AND document.requirement_assignment_id IS NULL
              AND (document.document_type <> 'report_card' OR (document.is_legacy_archive = 0 AND document.upload_source = 'student')))
          SELECT document_type, status, decision_type, created_at FROM ranked WHERE row_rank = 1`),
      pool.request().input('studentId', sql.Int, student.id).input('schoolYear', sql.NVarChar(20), selectedYear)
        .query(`SELECT assignment.id, assignment.display_name_snapshot AS display_name,
            assignment.student_instructions_snapshot AS student_instructions, assignment.channel_snapshot AS channel,
            assignment.is_required, assignment.status, assignment.version_no,
            paper.status AS paper_status,
            digital.id AS document_id, digital.status AS document_status, decision.decision_type AS decision_type
          FROM requirement_assignments AS assignment
          LEFT JOIN (SELECT ranked.requirement_assignment_id, ranked.status FROM (
            SELECT event.requirement_assignment_id, event.status,
              ROW_NUMBER() OVER (PARTITION BY event.requirement_assignment_id ORDER BY event.created_at DESC, event.id DESC) AS row_rank
            FROM student_physical_checklist_events AS event WHERE event.requirement_assignment_id IS NOT NULL
          ) AS ranked WHERE ranked.row_rank = 1) AS paper ON paper.requirement_assignment_id = assignment.id
          LEFT JOIN (SELECT ranked.id, ranked.requirement_assignment_id, ranked.status FROM (
            SELECT document.id, document.requirement_assignment_id, document.status,
              ROW_NUMBER() OVER (PARTITION BY document.requirement_assignment_id ORDER BY document.created_at DESC, document.id DESC) AS row_rank
            FROM documents AS document WHERE document.requirement_assignment_id IS NOT NULL
          ) AS ranked WHERE ranked.row_rank = 1) AS digital ON digital.requirement_assignment_id = assignment.id
          LEFT JOIN v_document_latest_decision_event AS decision ON decision.document_id = digital.id
          WHERE assignment.student_id = @studentId AND assignment.school_year = @schoolYear
          ORDER BY assignment.created_at, assignment.id`),
      pool.request().input('studentId', sql.Int, student.id)
        .query(`SELECT event.status, event.created_at FROM previous_school_report_card_status_events AS event
          WHERE event.student_id = @studentId ORDER BY event.created_at DESC, event.id DESC LIMIT 1`)
    ]);
    const placementGrade = (placementsResult.recordset || []).find((placement) => placement.grade_level)?.grade_level || null;
    const applicableGrade = annual?.grade_level || placementGrade;
    const paperRequirements = (physicalResult.recordset || []).filter((item) => {
      if (item.applicability === 'grade11') return applicableGrade === 'Grade 11';
      if (item.applicability === 'grade12') return applicableGrade === 'Grade 12';
      return true;
    }).map((item) => ({
      label: item.requirement_name, guidance: item.guidance, channel: 'paper',
      status: item.is_applicable === false || item.is_applicable === 0 ? 'not_applicable' : item.status || 'not_recorded',
      optional: Boolean(item.is_optional) || ['als', 'esc'].includes(item.applicability) && item.is_applicable !== true && item.is_applicable !== 1,
      applicabilityNeedsConfirmation: ['als', 'esc'].includes(item.applicability) && item.is_applicable !== true && item.is_applicable !== 1,
      lastRecordedAt: item.created_at || null
    }));
    const digitalByCode = new Map((digitalResult.recordset || []).map((item) => [item.document_type, item]));
    const safeDigitalStatus = (record) => !record ? 'not_submitted'
      : record.status === 'valid' ? 'staff_accepted'
        : record.status === 'rejected' ? 'rejected'
          : record.status === 'needs_review' && record.decision_type === 'correction_requested' ? 'correction_requested'
            : record.status === 'failed' ? 'staff_review_required'
              : record.status === 'needs_review' ? 'awaiting_staff_review' : 'awaiting_review';
    const digitalRequirements = ['good_moral', 'psa_birth_certificate', 'report_card'].map((code) => ({
      code, status: safeDigitalStatus(digitalByCode.get(code)), lastUpdatedAt: digitalByCode.get(code)?.created_at || null,
      evidenceScope: 'Latest student-level record on file; this workflow does not tag it to a school year.'
    }));
    const customRequirements = (customResult.recordset || []).map((item) => {
      const rawDocumentStatus = item.document_status || null;
      const decision = item.decision_type || null;
      const documentStatus = !rawDocumentStatus ? null : rawDocumentStatus === 'valid' ? 'staff_accepted'
        : rawDocumentStatus === 'rejected' ? 'rejected'
          : rawDocumentStatus === 'needs_review' && decision === 'correction_requested' ? 'correction_requested'
            : rawDocumentStatus === 'failed' ? 'staff_review_required'
              : 'awaiting_staff_review';
      const canCorrect = Boolean(rawDocumentStatus && ['needs_review', 'failed'].includes(rawDocumentStatus) && decision === 'correction_requested' && item.status === 'active');
      return {
        id: Number(item.id), code: item.requirement_code, displayName: item.display_name, instructions: item.student_instructions,
        channel: item.channel, required: item.is_required === true || item.is_required === 1,
        assignmentStatus: item.status, paperStatus: item.paper_status || 'not_recorded',
        digitalStatus: documentStatus || 'not_submitted', canUpload: student.status !== 'archived' && item.status === 'active'
          && ['digital', 'both'].includes(item.channel) && (!rawDocumentStatus || rawDocumentStatus === 'rejected'),
        canCorrect, documentId: item.document_id ? Number(item.document_id) : null
      };
    });
    return {
      student: { firstName: student.first_name, archived: student.status === 'archived' }, schoolYears, selectedSchoolYear: selectedYear,
      enrollment: annual ? { gradeLevel: annual.grade_level, status: annual.intake_status, confirmed: annual.confirmed === true || annual.confirmed === 1 } : null,
      placements: placementsResult.recordset || [], paperRequirements,
      paperEvidenceScope: 'Latest student-level paper checklist status on file; this ledger does not tag it to a school year.',
      reportCardPaperStatus: physicalHistoryResult.recordset?.[0]?.status || 'not_recorded',
      digitalRequirements, customRequirements
    };
  }

  return { listCatalog, createCatalogItem, updateCatalogItem, getAssignmentWorkspace, assign, withdraw, recordPaper, getStudentProgress };
}

module.exports = { RequirementServiceError, createRequirementService, MANUAL_CHECKLIST, normalizedSchoolYear };
