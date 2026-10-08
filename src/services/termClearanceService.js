'use strict';

const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { runSerializableTransaction } = require('./transactionRetry');

class TermClearanceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TermClearanceError';
    this.status = status;
  }
}

function idValue(value, label) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,10}$/.test(text)) throw new TermClearanceError(`Choose a valid ${label}.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new TermClearanceError(`Choose a valid ${label}.`);
  return number;
}

function requestKey(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TermClearanceError('This clearance form expired. Reload the page and try again.', 409);
  }
  return value.toLowerCase();
}

function field(value, label, max, { required = false, minimum = 0 } = {}) {
  if (typeof value !== 'string') throw new TermClearanceError(`${label} must be ${max} characters or fewer.`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length < minimum) throw new TermClearanceError(`${label} is required and must contain at least ${minimum || 1} characters.`);
  if (normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new TermClearanceError(`${label} must be ${max} printable characters or fewer.`);
  return normalized || null;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isChecked(value) {
  return value === true || value === 1 || value === '1' || value === 'on';
}

const CLEARANCE_DASHBOARD_PAGE_SIZE = 25;
const CLEARANCE_DASHBOARD_STATUSES = new Set(['all', 'complete', 'pending', 'incomplete', 'not_reviewed', 'not_attended', 'not_applicable']);

function clearanceCompleteSql(clearanceAlias = 'clearance', itemsAlias = 'items') {
  return `${clearanceAlias}.scope_status = 'attended' AND ${clearanceAlias}.template_id IS NOT NULL
    AND ${clearanceAlias}.attested_by IS NOT NULL AND ${clearanceAlias}.attested_at IS NOT NULL
    AND ${clearanceAlias}.inspected_on IS NOT NULL
    AND COALESCE(${itemsAlias}.teacher_count, 0) > 0 AND COALESCE(${itemsAlias}.registrar_count, 0) > 0
    AND COALESCE(${itemsAlias}.guidance_count, 0) > 0 AND COALESCE(${itemsAlias}.finance_count, 0) > 0
    AND COALESCE(${itemsAlias}.required_unsigned_count, 0) = 0 AND COALESCE(${itemsAlias}.unresolved_count, 0) = 0
    AND COALESCE(${itemsAlias}.teacher_context_missing_count, 0) = 0`;
}

function clearanceDashboardStateSql({ enrollmentAlias = 'enrollment', annualAlias = 'annual', clearanceAlias = 'clearance', itemsAlias = 'items' } = {}) {
  const automatic = `${enrollmentAlias}.annual_term_number < ${annualAlias}.entry_term_number
    OR (@currentSchoolYear IS NOT NULL AND ${annualAlias}.school_year REGEXP '^[0-9]{4}-[0-9]{4}$'
      AND CAST(SUBSTRING(${annualAlias}.school_year, 6, 4) AS UNSIGNED) = CAST(SUBSTRING(${annualAlias}.school_year, 1, 4) AS UNSIGNED) + 1
      AND (${annualAlias}.school_year > @currentSchoolYear
      OR (${annualAlias}.school_year = @currentSchoolYear AND ${enrollmentAlias}.annual_term_number > @currentTermNumber)))`;
  return `CASE WHEN (${automatic}) THEN 'not_applicable'
    WHEN ${clearanceAlias}.id IS NULL OR ${clearanceAlias}.scope_status = 'unreviewed' THEN 'not_reviewed'
    WHEN ${clearanceAlias}.scope_status = 'not_attended' THEN 'not_attended'
    WHEN (${clearanceCompleteSql(clearanceAlias, itemsAlias)}) THEN 'complete'
    ELSE 'incomplete' END`;
}

function normalizeClearanceDashboardFilters(input = {}) {
  const search = input.search === undefined ? '' : input.search;
  if (typeof search !== 'string' || search.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(search)) {
    throw new TermClearanceError('Search must be 100 printable characters or fewer.');
  }
  const normalizedSearch = search.trim();
  const rawSchoolYear = input.schoolYear === undefined ? '' : input.schoolYear;
  if (typeof rawSchoolYear !== 'string') throw new TermClearanceError('Choose a valid school year.');
  const schoolYear = rawSchoolYear.trim();
  if (schoolYear && academicYearStart(schoolYear) === null) throw new TermClearanceError('Choose a valid school year.');
  const rawTermId = input.termId === undefined || input.termId === '' ? null : idValue(input.termId, 'academic term');
  const status = input.status === undefined || input.status === '' ? 'all' : input.status;
  if (typeof status !== 'string' || !CLEARANCE_DASHBOARD_STATUSES.has(status)) {
    throw new TermClearanceError('Choose a valid clearance status.');
  }
  const rawPage = input.page === undefined || input.page === '' ? 1 : input.page;
  const page = typeof rawPage === 'number' || typeof rawPage === 'string' && /^\d{1,8}$/.test(rawPage)
    ? Number(rawPage) : NaN;
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000000) throw new TermClearanceError('Choose a valid page.');
  const scopeSpecified = ['search', 'schoolYear', 'termId', 'status'].some((key) => Object.hasOwn(input, key));
  const normalizedStatus = ['incomplete', 'not_reviewed'].includes(status) ? 'pending' : status;
  return { search: normalizedSearch, schoolYear: schoolYear || null, termId: rawTermId,
    status: normalizedStatus, page, scopeSpecified };
}

function clearanceDashboardRecordsSql({ studentScoped = false } = {}) {
  const stateSql = clearanceDashboardStateSql();
  return `SELECT enrollment.id AS enrollment_id, enrollment.student_id, enrollment.academic_term_id,
      enrollment.annual_term_number, enrollment.enrollment_status, annual.school_year, annual.grade_level,
      annual.entry_term_number, term.term AS term_label, student.student_no, student.first_name,
      student.middle_name, student.last_name, student.suffix, section.name AS section_name,
      clearance.id AS clearance_id, clearance.scope_status, clearance.template_id, clearance.attested_by,
      clearance.attested_at, clearance.inspected_on,
      COALESCE(items.item_count, 0) AS item_count, COALESCE(items.teacher_count, 0) AS teacher_count,
      COALESCE(items.registrar_count, 0) AS registrar_count, COALESCE(items.guidance_count, 0) AS guidance_count,
      COALESCE(items.finance_count, 0) AS finance_count, COALESCE(items.required_unsigned_count, 0) AS required_unsigned_count,
      COALESCE(items.unresolved_count, 0) AS unresolved_count,
      COALESCE(items.teacher_context_missing_count, 0) AS teacher_context_missing_count,
      CASE WHEN (${clearanceCompleteSql()}) THEN 1 ELSE 0 END AS clearance_complete,
      ${stateSql} AS clearance_state
    FROM enrollments AS enrollment
    INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
    INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
    INNER JOIN students AS student ON student.id = enrollment.student_id
    LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
    LEFT JOIN student_term_clearances AS clearance ON clearance.enrollment_id = enrollment.id
    LEFT JOIN (
      SELECT clearance_id, COUNT(*) AS item_count, SUM(category = 'teacher') AS teacher_count,
        SUM(category = 'registrar') AS registrar_count, SUM(category = 'guidance') AS guidance_count,
        SUM(category = 'finance') AS finance_count,
        SUM(applicability_status = 'required' AND (signature_present = 0 OR signer_name IS NULL OR TRIM(signer_name) = '')) AS required_unsigned_count,
        SUM(applicability_status = 'unreviewed') AS unresolved_count,
        SUM(category = 'teacher' AND signature_present = 1 AND teacher_context_status <> 'assigned'
          AND (signer_context_reason IS NULL OR CHAR_LENGTH(TRIM(signer_context_reason)) < 5)) AS teacher_context_missing_count
      FROM student_term_clearance_items GROUP BY clearance_id
    ) AS items ON items.clearance_id = clearance.id
    WHERE (@searchPattern IS NULL OR student.student_no LIKE @searchPattern ESCAPE '~'
        OR student.lrn LIKE @searchPattern ESCAPE '~'
        OR CONCAT_WS(' ', student.first_name, student.middle_name, student.last_name, student.suffix) LIKE @searchPattern ESCAPE '~')
      AND (@schoolYear IS NULL OR annual.school_year = @schoolYear)
      AND (@termId IS NULL OR enrollment.academic_term_id = @termId)
      ${studentScoped ? 'AND enrollment.student_id = @studentId' : ''}`;
}

function bindClearanceDashboardFilters(request, filters, currentPosition, { sqlAdapter = defaultSql, studentId = null } = {}) {
  request.input('searchPattern', sqlAdapter.NVarChar(204), filters.search ? `%${filters.search.replace(/[~%_[\]]/g, (character) => `~${character}`)}%` : null)
    .input('schoolYear', sqlAdapter.NVarChar(20), filters.schoolYear)
    .input('termId', sqlAdapter.Int, filters.termId)
    .input('currentSchoolYear', sqlAdapter.NVarChar(20), currentPosition?.school_year || null)
    .input('currentTermNumber', sqlAdapter.TinyInt, currentPosition?.term_number || null);
  if (studentId !== null) request.input('studentId', sqlAdapter.Int, studentId);
  return request;
}

function dateValue(value, label, required = false) {
  if ((value === '' || value == null) && !required) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TermClearanceError(`${label} must be a valid calendar date.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new TermClearanceError(`${label} must be a valid calendar date.`);
  return value;
}

function cleanTemplateInput(input = {}) {
  const gradeLevel = input.gradeLevel;
  if (!['Grade 11', 'Grade 12'].includes(gradeLevel)) throw new TermClearanceError('Choose Grade 11 or Grade 12.');
  const trackLabel = field(input.trackLabel, 'Track label', 80, { required: true, minimum: 2 });
  const officeConfirmations = input.officeConfirmations == null ? []
    : Array.isArray(input.officeConfirmations) ? input.officeConfirmations : [input.officeConfirmations];
  const requiredOffices = ['registrar', 'guidance', 'finance'];
  if (officeConfirmations.length !== requiredOffices.length
    || officeConfirmations.some((office) => typeof office !== 'string' || !requiredOffices.includes(office))
    || new Set(officeConfirmations).size !== requiredOffices.length) {
    throw new TermClearanceError('Confirm the Registrar, Guidance, and Finance signature lines shown on the paper form.');
  }
  const rawLabs = (input.laboratoryLabels == null ? [] : Array.isArray(input.laboratoryLabels) ? input.laboratoryLabels : [input.laboratoryLabels])
    .filter((value) => typeof value === 'string' && value.trim() !== '');
  if (rawLabs.length > 20) throw new TermClearanceError('A template can contain no more than 20 laboratory signature lines.');
  const laboratoryLabels = rawLabs.map((value, index) => field(value, `Laboratory line ${index + 1}`, 120, { required: true, minimum: 2 }));
  if (!isChecked(input.teacherRosterConfirmed) || !isChecked(input.laboratoryRowsConfirmed)) {
    throw new TermClearanceError('Confirm the subject-teacher roster rule and laboratory rows (including when none apply).');
  }
  return { gradeLevel, trackLabel, registrarLabel: 'Registrar', guidanceLabel: 'Guidance', financeLabel: 'Finance', laboratoryLabels,
    paperFormConfirmed: true, teacherRosterConfirmed: true, laboratoryRowsConfirmed: true };
}

function cleanReconciliation(input = {}) {
  const rows = input.paperTeacherRows == null ? [] : Array.isArray(input.paperTeacherRows) ? input.paperTeacherRows : [input.paperTeacherRows];
  if (rows.length > 60) throw new TermClearanceError('Record no more than 60 additional paper subject rows at once.');
  const normalized = rows.map((row, index) => ({
    subjectCode: field(row?.subjectCode || '', `Paper subject ${index + 1} code`, 50, { minimum: 0 }),
    subjectName: field(row?.subjectName, `Paper subject ${index + 1} name`, 200, { required: true, minimum: 2 })
  }));
  const keys = normalized.map((row) => `${String(row.subjectCode || '').toLocaleLowerCase()}\u0000${row.subjectName.toLocaleLowerCase()}`);
  if (new Set(keys).size !== keys.length) throw new TermClearanceError('A paper subject row was entered more than once.');
  const reason = normalized.length
    ? field(input.rosterReconciliationReason, 'Reason these paper subject lines differ from the saved list', 1000, { required: true, minimum: 5 })
    : null;
  if (normalized.length && !isChecked(input.rosterReviewed)) throw new TermClearanceError('Confirm that you compared the saved subject list with the printed form.');
  return { rows: normalized, reason, reviewed: isChecked(input.rosterReviewed) };
}

function cleanItemUpdates(input = {}) {
  const updates = input.items == null ? [] : Array.isArray(input.items) ? input.items : [input.items];
  if (updates.length > 180) throw new TermClearanceError('Update no more than 180 signature lines at once.');
  const normalized = updates.map((item) => {
    const itemId = idValue(item?.itemId, 'clearance row');
    const signaturePresent = isChecked(item?.signaturePresent);
    const applicabilityStatus = item?.applicabilityStatus;
    if (!['required', 'not_applicable', 'unreviewed'].includes(applicabilityStatus)) {
      throw new TermClearanceError('Choose a valid requirement status for each laboratory line.');
    }
    if (applicabilityStatus === 'unreviewed' && signaturePresent) {
      throw new TermClearanceError('Decide whether this laboratory line is required on the form before recording a signature.');
    }
    const signerName = signaturePresent ? field(item?.signerName, 'Name beside signature', 160, { required: true, minimum: 2 }) : null;
    const paperSignedOn = signaturePresent ? dateValue(item?.paperSignedOn, 'Paper date') : null;
    const applicabilityReason = applicabilityStatus === 'not_applicable'
      ? field(item?.applicabilityReason, 'Reason this laboratory line is not required', 1000, { required: true, minimum: 5 }) : null;
    const signerContextReason = signaturePresent
      ? field(item?.signerContextReason || '', 'Reason this teacher name applies', 1000, { minimum: 0 }) : null;
    return { itemId, signaturePresent, applicabilityStatus, signerName, paperSignedOn, applicabilityReason, signerContextReason };
  });
  if (new Set(normalized.map(({ itemId }) => itemId)).size !== normalized.length) throw new TermClearanceError('A clearance row was submitted more than once.');
  return normalized.sort((left, right) => left.itemId - right.itemId);
}

function completeFromCounts(row) {
  return Boolean(row && row.scope_status === 'attended' && row.template_id && row.attested_by && row.attested_at && row.inspected_on
    && Number(row.teacher_count) > 0 && Number(row.registrar_count) > 0 && Number(row.guidance_count) > 0 && Number(row.finance_count) > 0
    && Number(row.required_unsigned_count) === 0 && Number(row.unresolved_count) === 0 && Number(row.teacher_context_missing_count) === 0);
}

function awaitingRegistrarConfirmation(row) {
  return Boolean(row && !completeFromCounts(row) && completeFromCounts({ ...row,
    attested_by: row.attested_by || 1, attested_at: row.attested_at || true }));
}

function academicYearStart(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{4})$/.exec(value.trim());
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  return Number(match[1]);
}

function resolveCurrentAcademicPosition(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0];
  const termNumber = Number(row.term_number);
  const academicTermId = Number(row.academic_term_id ?? row.id);
  if (!row.term_number || !Number.isInteger(termNumber) || termNumber < 1 || termNumber > 3
    || academicYearStart(row.school_year) === null) return null;
  return { academic_term_id: Number.isSafeInteger(academicTermId) && academicTermId > 0 ? academicTermId : null,
    school_year: row.school_year, term_number: termNumber };
}

function isFutureAcademicTerm(currentPosition, schoolYear, termNumber) {
  const targetYear = academicYearStart(schoolYear);
  const currentYear = academicYearStart(currentPosition?.school_year);
  if (!currentPosition || targetYear === null || currentYear === null) return null;
  if (targetYear !== currentYear) return targetYear > currentYear;
  return Number(termNumber) > Number(currentPosition.term_number);
}

function isPastAcademicTerm(currentPosition, schoolYear, termNumber) {
  const targetYear = academicYearStart(schoolYear);
  const currentYear = academicYearStart(currentPosition?.school_year);
  if (!currentPosition || targetYear === null || currentYear === null) return false;
  return targetYear < currentYear || targetYear === currentYear && Number(termNumber) < Number(currentPosition.term_number);
}

function safeJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function clearanceEventSummary(event) {
  const before = safeJsonObject(event.before_json);
  const after = safeJsonObject(event.after_json);
  const summaries = [];
  const attendanceLabel = (value) => ({ attended: 'Attended', not_attended: 'Term not attended', unreviewed: 'Pending' })[value] || 'Not recorded';
  const labDecisionLabel = (value) => ({ required: 'Required on this form', not_applicable: 'Not required', unreviewed: 'Not checked yet' })[value] || 'Not recorded';
  if (!event.before_json) {
    if (after.scopeStatus) summaries.push(`Attendance decision recorded: ${attendanceLabel(after.scopeStatus)}.`);
    if (after.trackLabel) summaries.push(`Paper form: ${after.trackLabel}${after.templateVersion ? `, version ${after.templateVersion}` : ''}.`);
    const teacherRows = Number(after.generatedItems?.filter?.((item) => item.category === 'teacher').length || 0);
    if (teacherRows) summaries.push(`${teacherRows} teacher/subject signature row${teacherRows === 1 ? '' : 's'} recorded.`);
  } else {
    if (before.scopeStatus !== after.scopeStatus) summaries.push(`Attendance decision changed from ${attendanceLabel(before.scopeStatus)} to ${attendanceLabel(after.scopeStatus)}.`);
    if (before.templateId !== after.templateId && after.trackLabel) summaries.push(`Paper form changed to ${after.trackLabel}.`);
    const beforeItems = new Map((Array.isArray(before.items) ? before.items : []).map((item) => [Number(item.id), item]));
    const changedItems = (Array.isArray(after.items) ? after.items : []).filter((item) => {
      const old = beforeItems.get(Number(item.id));
      return !old || ['signaturePresent', 'signerName', 'paperSignedOn', 'applicabilityStatus'].some((key) => old[key] !== item[key]);
    });
    for (const item of changedItems.slice(0, 8)) {
      const old = beforeItems.get(Number(item.id));
      const subject = [item.subjectCode, item.subjectName].filter(Boolean).join(' · ');
      const label = [item.label, subject].filter(Boolean).join(' — ');
      if (!old) summaries.push(`Added ${label}.`);
      else if (old.signaturePresent !== item.signaturePresent || old.signerName !== item.signerName) {
        summaries.push(`Paper signer for ${label}: ${old.signerName || 'not recorded'} → ${item.signerName || 'not recorded'} (${item.signaturePresent ? 'signature present' : 'signature absent'}).`);
      }
      if (old && old.paperSignedOn !== item.paperSignedOn) summaries.push(`Paper date for ${label}: ${old.paperSignedOn || 'not recorded'} → ${item.paperSignedOn || 'not recorded'}.`);
      if (old && old.applicabilityStatus !== item.applicabilityStatus) summaries.push(`${label}: ${labDecisionLabel(old.applicabilityStatus)} → ${labDecisionLabel(item.applicabilityStatus)}.`);
    }
    const added = Math.max(0, Number(after.items?.length || 0) - beforeItems.size - changedItems.filter((item) => beforeItems.has(Number(item.id))).length);
    if (added > 8) summaries.push(`${added - 8} more paper subject row${added - 8 === 1 ? '' : 's'} added.`);
    const wasAttested = Boolean(before.attestedBy || before.attestedAt);
    if (wasAttested !== Boolean(after.attested)) {
      summaries.push(after.attested ? `Registrar confirmed paper inspection for ${after.inspectedOn || 'date not recorded'}.` : 'Paper inspection confirmation removed; clearance reopened.');
    }
    if (before.inspectedOn !== after.inspectedOn) {
      if (!after.inspectedOn && after.scopeStatus === 'not_attended') {
        summaries.push('Inspection date cleared because the term was marked not attended; earlier details remain in change history.');
      } else if (after.attested) {
        summaries.push(`Paper inspection date changed to ${after.inspectedOn || 'date not recorded'}.`);
      } else {
        summaries.push(`Paper inspection date changed to ${after.inspectedOn || 'date not recorded'}; the review is not confirmed yet.`);
      }
    }
  }
  return summaries.slice(0, 10);
}

function createTermClearanceService({ getPool = defaultGetPool, sql = defaultSql, transactionFactory = (pool) => new sql.Transaction(pool) } = {}) {
  async function runTransaction(callback) {
    return runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
  }

  async function requireStaff(request, actorInput, { write = false } = {}) {
    const actorId = idValue(actorInput, 'user');
    const roles = write ? "role = 'registrar'" : "role IN ('registrar', 'database_admin')";
    const result = await request.input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users WHERE id = @actorId AND is_active = 1 AND ${roles} FOR UPDATE`);
    const actor = result.recordset?.[0];
    if (!actor) throw new TermClearanceError(write ? 'Active registrar access is required for clearance changes.' : 'Registrar or database administrator access is required.', 403);
    return actor;
  }

  async function lockStudent(transaction, studentId) {
    const result = await transaction.request().input('studentId', sql.Int, studentId)
      .query('SELECT id, status FROM students WHERE id = @studentId FOR UPDATE');
    return result.recordset?.[0] || null;
  }

  async function currentAcademicPosition(transaction) {
    const result = await transaction.request().query(`SELECT term.id AS academic_term_id, term.school_year,
        order_row.term_number
      FROM academic_terms AS term
      LEFT JOIN school_year_term_order AS order_row ON order_row.academic_term_id = term.id
      WHERE term.is_current = 1 FOR UPDATE`);
    const rows = result.recordset || [];
    if (rows.length !== 1 || !rows[0].term_number || academicYearStart(rows[0].school_year) === null) return null;
    return { academicTermId: Number(rows[0].academic_term_id), school_year: rows[0].school_year,
      term_number: Number(rows[0].term_number) };
  }

  async function ensureTermMayBeReviewed(transaction, context) {
    const termNumber = Number(context.annual_term_number);
    const entryTermNumber = Number(context.entry_term_number);
    if (!Number.isInteger(termNumber) || termNumber < 1 || termNumber > 3
      || !Number.isInteger(entryTermNumber) || entryTermNumber < 1 || entryTermNumber > 3) {
      throw new TermClearanceError('The school-year and term order are unclear, so this placement cannot be reviewed yet.', 409);
    }
    const current = await currentAcademicPosition(transaction);
    if (!current) throw new TermClearanceError('The current school term is not set up clearly. Resolve the term order before reviewing this placement.', 409);
    if (termNumber < entryTermNumber) {
      throw new TermClearanceError('This placement is before the student’s entry term and is outside required clearance.', 409);
    }
    const future = isFutureAcademicTerm(current, context.school_year, termNumber);
    if (future === null) throw new TermClearanceError('This term cannot be compared with the current school period. Resolve the term setup before reviewing it.', 409);
    if (future) throw new TermClearanceError('This is a future term. Review it when it becomes current.', 409);
    return current;
  }

  async function writeAudit(transaction, actor, action, entityType, entityId, details = {}) {
    await transaction.request().input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), `registrar.${action}`)
      .input('entityType', sql.NVarChar(100), entityType)
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  async function eventByKey(transaction, idempotencyKey, requestFingerprint) {
    const result = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
      .query('SELECT id, clearance_id, request_fingerprint FROM student_term_clearance_events WHERE idempotency_key = @idempotencyKey FOR UPDATE');
    const event = result.recordset?.[0];
    if (!event) return null;
    if (event.request_fingerprint !== requestFingerprint) throw new TermClearanceError('This clearance submission token was already used for different details.', 409);
    return event;
  }

  async function addEvent(transaction, { clearanceId, actorId, eventType, reason = null, before = null, after, idempotencyKey, requestFingerprint }) {
    await transaction.request().input('clearanceId', sql.BigInt, clearanceId)
      .input('actorId', sql.Int, actorId).input('eventType', sql.NVarChar(32), eventType)
      .input('reason', sql.NVarChar(1000), reason)
      .input('beforeJson', sql.NVarChar(sql.MAX), before == null ? null : JSON.stringify(before))
      .input('afterJson', sql.NVarChar(sql.MAX), JSON.stringify(after))
      .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
      .input('requestFingerprint', sql.Char(64), requestFingerprint)
      .query(`INSERT INTO student_term_clearance_events
        (clearance_id, actor_id, event_type, reason, before_json, after_json, idempotency_key, request_fingerprint)
        VALUES (@clearanceId, @actorId, @eventType, @reason, @beforeJson, @afterJson, @idempotencyKey, @requestFingerprint)`);
  }

  async function createTemplateVersion(actorInput, input = {}) {
    const actorId = idValue(actorInput, 'user');
    const values = cleanTemplateInput(input);
    const idempotencyKey = requestKey(input.idempotencyKey);
    const requestFingerprint = fingerprint(values);
    return runTransaction(async (transaction) => {
      const actor = await requireStaff(transaction.request(), actorId, { write: true });
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query('SELECT id, request_fingerprint FROM term_clearance_templates WHERE idempotency_key = @idempotencyKey FOR UPDATE');
      if (prior.recordset?.[0]) {
        if (prior.recordset[0].request_fingerprint !== requestFingerprint) throw new TermClearanceError('This template token was already used for different details.', 409);
        return { templateId: Number(prior.recordset[0].id), alreadyCreated: true };
      }
      const versionResult = await transaction.request().input('gradeLevel', sql.NVarChar(50), values.gradeLevel)
        .input('trackLabel', sql.NVarChar(80), values.trackLabel)
        .query(`SELECT COALESCE(MAX(version_no), 0) AS latest_version FROM term_clearance_templates
          WHERE grade_level = @gradeLevel AND track_label = @trackLabel FOR UPDATE`);
      const versionNo = Number(versionResult.recordset?.[0]?.latest_version || 0) + 1;
      await transaction.request().input('gradeLevel', sql.NVarChar(50), values.gradeLevel)
        .input('trackLabel', sql.NVarChar(80), values.trackLabel)
        .query(`UPDATE term_clearance_templates SET status = 'superseded'
          WHERE grade_level = @gradeLevel AND track_label = @trackLabel AND status = 'approved'`);
      const inserted = await transaction.request().input('gradeLevel', sql.NVarChar(50), values.gradeLevel)
        .input('trackLabel', sql.NVarChar(80), values.trackLabel).input('versionNo', sql.Int, versionNo)
        .input('actorId', sql.Int, actor.id).input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.Char(64), requestFingerprint)
        .query(`INSERT INTO term_clearance_templates
          (grade_level, track_label, version_no, status, teacher_roster_confirmed, paper_form_confirmed,
            laboratory_rows_confirmed, created_by, idempotency_key, request_fingerprint)
          VALUES (@gradeLevel, @trackLabel, @versionNo, 'approved', 1, 1, 1, @actorId, @idempotencyKey, @requestFingerprint)`);
      const templateId = Number(inserted.insertId);
      const rows = [
        ['registrar', values.registrarLabel], ['guidance', values.guidanceLabel], ['finance', values.financeLabel],
        ...values.laboratoryLabels.map((label) => ['laboratory', label])
      ];
      for (let index = 0; index < rows.length; index += 1) {
        await transaction.request().input('templateId', sql.Int, templateId).input('category', sql.NVarChar(20), rows[index][0])
          .input('label', sql.NVarChar(120), rows[index][1]).input('sortOrder', sql.Int, index + 1)
          .query(`INSERT INTO term_clearance_template_items (template_id, category, label, sort_order)
            VALUES (@templateId, @category, @label, @sortOrder)`);
      }
      await writeAudit(transaction, actor, 'term_clearance_template_created', 'term_clearance_template', templateId,
        { gradeLevel: values.gradeLevel, trackLabel: values.trackLabel, versionNo, configuredLaboratoryRows: values.laboratoryLabels.length });
      return { templateId, versionNo, alreadyCreated: false };
    });
  }

  async function listTemplates(actorInput, { includeSuperseded = true } = {}) {
    const pool = await getPool();
    const actor = await requireStaff(pool.request(), actorInput);
    const result = await pool.request()
      .input('status', sql.NVarChar(20), includeSuperseded ? null : 'approved')
      .query(`SELECT template.id, template.grade_level, template.track_label, template.version_no, template.status,
          template.created_at, profile.first_name AS creator_first_name, profile.last_name AS creator_last_name,
          SUM(item.category = 'registrar') AS registrar_rows, SUM(item.category = 'guidance') AS guidance_rows,
          SUM(item.category = 'finance') AS finance_rows, SUM(item.category = 'laboratory') AS laboratory_rows,
          GROUP_CONCAT(CONCAT(item.category, ': ', item.label) ORDER BY item.sort_order SEPARATOR '\n') AS item_labels
        FROM term_clearance_templates AS template
        INNER JOIN term_clearance_template_items AS item ON item.template_id = template.id
        LEFT JOIN staff_profiles AS profile ON profile.user_id = template.created_by
        WHERE (@status IS NULL OR template.status = @status)
        GROUP BY template.id, template.grade_level, template.track_label, template.version_no, template.status,
          template.created_at, profile.first_name, profile.last_name
        ORDER BY template.grade_level, template.track_label, template.version_no DESC`);
    return { actor, templates: result.recordset || [] };
  }

  async function loadEnrollmentContext(transaction, enrollmentId) {
      const result = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
      .query(`SELECT enrollment.id AS enrollment_id, enrollment.student_id, enrollment.annual_enrollment_id,
          enrollment.academic_term_id, enrollment.annual_term_number, enrollment.enrollment_status,
          enrollment.term_scope_status, enrollment.section_id, annual.school_year, annual.grade_level,
          annual.entry_term_number, annual.intake_status, student.status AS student_status,
          student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix,
          term.term AS term_label, section.name AS section_name,
          section.cluster AS section_cluster, section.strand AS section_strand
        FROM enrollments AS enrollment
        INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
        INNER JOIN students AS student ON student.id = enrollment.student_id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        WHERE enrollment.id = @enrollmentId FOR UPDATE`);
    return result.recordset?.[0] || null;
  }

  async function loadTemplate(transaction, templateId, gradeLevel, { allowSuperseded = false } = {}) {
    const result = await transaction.request().input('templateId', sql.Int, templateId)
      .input('gradeLevel', sql.NVarChar(50), gradeLevel)
      .query(`SELECT id, grade_level, track_label, version_no, status, teacher_roster_confirmed,
          paper_form_confirmed, laboratory_rows_confirmed
        FROM term_clearance_templates WHERE id = @templateId AND grade_level = @gradeLevel FOR UPDATE`);
    const template = result.recordset?.[0];
    if (!template || !['approved', ...(allowSuperseded ? ['superseded'] : [])].includes(template.status) || Number(template.teacher_roster_confirmed) !== 1
      || Number(template.paper_form_confirmed) !== 1 || Number(template.laboratory_rows_confirmed) !== 1) {
      throw new TermClearanceError('Choose an approved template that matches this student’s grade and school paper form.', 409);
    }
    const items = await transaction.request().input('templateId', sql.Int, templateId)
      .query(`SELECT id, category, label, sort_order FROM term_clearance_template_items
        WHERE template_id = @templateId ORDER BY sort_order FOR UPDATE`);
    const rows = items.recordset || [];
    for (const category of ['registrar', 'guidance', 'finance']) {
      if (rows.filter((row) => row.category === category).length !== 1) {
        throw new TermClearanceError('The approved template is incomplete. Create a new complete template version before recording clearance.', 409);
      }
    }
    return { ...template, items: rows };
  }

  async function loadRosterSnapshot(transaction, context) {
    const rosterResult = await transaction.request().input('enrollmentId', sql.Int, context.enrollment_id)
      .query(`SELECT assignment.id AS student_subject_id, assignment.subject_id, subject.subject_code, subject.subject_name
        FROM student_subjects AS assignment
        INNER JOIN subjects AS subject ON subject.id = assignment.subject_id
        WHERE assignment.enrollment_id = @enrollmentId ORDER BY subject.subject_code, assignment.id FOR UPDATE`);
    const roster = [];
    for (const subject of rosterResult.recordset || []) {
      const assignmentResult = await transaction.request().input('termId', sql.Int, context.academic_term_id)
        .input('sectionId', sql.Int, context.section_id).input('subjectId', sql.Int, subject.subject_id)
        .query(`SELECT assignment.id, assignment.teacher_id, assignment.is_active,
            COALESCE(NULLIF(TRIM(CONCAT(profile.first_name, ' ', profile.last_name)), ''), account.email) AS teacher_name
          FROM teacher_assignments AS assignment
          INNER JOIN users AS account ON account.id = assignment.teacher_id
          LEFT JOIN staff_profiles AS profile ON profile.user_id = assignment.teacher_id
          WHERE assignment.academic_term_id = @termId AND assignment.section_id = @sectionId
            AND assignment.subject_id = @subjectId ORDER BY assignment.created_at, assignment.id FOR UPDATE`);
      const assigned = assignmentResult.recordset || [];
      const reliable = assigned.length === 1;
      roster.push({ ...subject,
        teacherAssignmentId: reliable ? Number(assigned[0].id) : null,
        teacherUserId: reliable ? Number(assigned[0].teacher_id) : null,
        teacherName: reliable ? assigned[0].teacher_name : null,
        teacherContextStatus: assigned.length > 1 ? 'ambiguous' : assigned.length === 0 ? 'missing' : Number(assigned[0].is_active) === 1 ? 'assigned' : 'revoked'
      });
    }
    return roster;
  }

  async function clearanceByEnrollment(transaction, enrollmentId, { lock = false } = {}) {
    const result = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
      .query(`SELECT clearance.id, clearance.enrollment_id, clearance.annual_enrollment_id, clearance.student_id,
          clearance.template_id, clearance.grade_level_snapshot, clearance.school_year_snapshot, clearance.term_label_snapshot,
          clearance.academic_term_id_snapshot, clearance.term_number_snapshot, clearance.section_id_snapshot,
          clearance.section_name_snapshot, clearance.section_cluster_snapshot, clearance.section_strand_snapshot,
          clearance.track_label_snapshot, clearance.scope_status, clearance.scope_reason, clearance.inspected_on,
          clearance.attested_by, clearance.attested_at, clearance.version
        FROM student_term_clearances AS clearance WHERE clearance.enrollment_id = @enrollmentId ${lock ? 'FOR UPDATE' : ''}`);
    return result.recordset?.[0] || null;
  }

  async function insertClearanceItems(transaction, clearanceId, context, template, roster, reconciliation) {
    const items = [];
    let sortOrder = 1;
    for (const subject of roster) items.push({
      templateItemId: null, category: 'teacher', label: 'Subject teacher signature', subjectId: subject.subject_id,
      studentSubjectId: subject.student_subject_id, subjectCode: subject.subject_code, subjectName: subject.subject_name,
      teacherAssignmentId: subject.teacherAssignmentId, teacherUserId: subject.teacherUserId,
      teacherName: subject.teacherName, teacherContextStatus: subject.teacherContextStatus,
      applicabilityStatus: 'required', sortOrder: sortOrder++
    });
    for (const subject of reconciliation.rows) items.push({
      templateItemId: null, category: 'teacher', label: 'Paper roster subject signature', subjectId: null,
      studentSubjectId: null, subjectCode: subject.subjectCode, subjectName: subject.subjectName,
      teacherAssignmentId: null, teacherUserId: null, teacherName: null, teacherContextStatus: 'missing',
      applicabilityStatus: 'required', sortOrder: sortOrder++
    });
    for (const templateItem of template?.items || []) items.push({
      templateItemId: Number(templateItem.id), category: templateItem.category, label: templateItem.label,
      subjectId: null, studentSubjectId: null, subjectCode: null, subjectName: null,
      teacherAssignmentId: null, teacherUserId: null, teacherName: null, teacherContextStatus: null,
      applicabilityStatus: templateItem.category === 'laboratory' ? 'unreviewed' : 'required', sortOrder: sortOrder++
    });
    for (const item of items) {
      await transaction.request().input('clearanceId', sql.BigInt, clearanceId)
        .input('templateItemId', sql.Int, item.templateItemId).input('category', sql.NVarChar(20), item.category)
        .input('label', sql.NVarChar(120), item.label).input('subjectId', sql.Int, item.subjectId)
        .input('studentSubjectId', sql.Int, item.studentSubjectId).input('subjectCode', sql.NVarChar(50), item.subjectCode)
        .input('subjectName', sql.NVarChar(200), item.subjectName).input('teacherAssignmentId', sql.Int, item.teacherAssignmentId)
        .input('teacherUserId', sql.Int, item.teacherUserId).input('teacherName', sql.NVarChar(240), item.teacherName)
        .input('teacherContextStatus', sql.NVarChar(20), item.teacherContextStatus)
        .input('applicabilityStatus', sql.NVarChar(20), item.applicabilityStatus).input('sortOrder', sql.Int, item.sortOrder)
        .query(`INSERT INTO student_term_clearance_items
          (clearance_id, template_item_id, category, label_snapshot, subject_id, student_subject_id, subject_code_snapshot,
            subject_name_snapshot, teacher_assignment_id, teacher_user_id, teacher_name_snapshot, teacher_context_status,
            applicability_status, sort_order)
          VALUES (@clearanceId, @templateItemId, @category, @label, @subjectId, @studentSubjectId, @subjectCode,
            @subjectName, @teacherAssignmentId, @teacherUserId, @teacherName, @teacherContextStatus,
            @applicabilityStatus, @sortOrder)`);
    }
    return items;
  }

  async function insertManualTeacherRows(transaction, clearanceId, subjects, startingOrder) {
    let sortOrder = startingOrder;
    for (const subject of subjects) {
      await transaction.request().input('clearanceId', sql.BigInt, clearanceId)
        .input('label', sql.NVarChar(120), 'Paper roster subject signature')
        .input('subjectCode', sql.NVarChar(50), subject.subjectCode).input('subjectName', sql.NVarChar(200), subject.subjectName)
        .input('sortOrder', sql.Int, sortOrder++)
        .query(`INSERT INTO student_term_clearance_items
          (clearance_id, category, label_snapshot, subject_code_snapshot, subject_name_snapshot,
            teacher_context_status, applicability_status, sort_order)
          VALUES (@clearanceId, 'teacher', @label, @subjectCode, @subjectName, 'missing', 'required', @sortOrder)`);
    }
    return sortOrder;
  }

  async function createTermClearance(actorInput, enrollmentInput, input = {}, expectedStudentInput = null) {
    const actorId = idValue(actorInput, 'user');
    const enrollmentId = idValue(enrollmentInput, 'enrollment');
    const expectedStudentId = expectedStudentInput == null ? null : idValue(expectedStudentInput, 'student');
    const idempotencyKey = requestKey(input.idempotencyKey);
    const scopeStatus = input.scopeStatus;
    if (!['attended', 'not_attended'].includes(scopeStatus)) throw new TermClearanceError('Check school records and choose whether the student attended the entire term.');
    const scopeReason = scopeStatus === 'not_attended'
      ? field(input.scopeReason, 'Reason the entire term was not attended', 1000, { required: true, minimum: 5 }) : null;
    const templateId = scopeStatus === 'attended' ? idValue(input.templateId, 'approved template') : null;
  const templateSelectionReason = field(input.templateSelectionReason || '', 'Paper form version reason', 1000, { minimum: 0 }) || '';
    const reconciliation = cleanReconciliation(input);
    const payload = { enrollmentId, scopeStatus, scopeReason, templateId, templateSelectionReason, reconciliation };
    const requestFingerprint = fingerprint(payload);
    const pool = await getPool();
    const ownerResult = await pool.request().input('enrollmentId', sql.Int, enrollmentId)
      .query('SELECT student_id FROM enrollments WHERE id = @enrollmentId');
    const owner = ownerResult.recordset?.[0];
    if (!owner) throw new TermClearanceError('Term enrollment not found.', 404);
    if (expectedStudentId && Number(owner.student_id) !== expectedStudentId) throw new TermClearanceError('Term enrollment does not belong to this student record.', 404);
    return runTransaction(async (transaction) => {
      const actor = await requireStaff(transaction.request(), actorId, { write: true });
      const student = await lockStudent(transaction, Number(owner.student_id));
      if (!student) throw new TermClearanceError('Student record not found.', 404);
      const prior = await eventByKey(transaction, idempotencyKey, requestFingerprint);
      if (prior) {
        if (Number(prior.clearance_id) !== Number((await clearanceByEnrollment(transaction, enrollmentId))?.id || 0)) {
          throw new TermClearanceError('This token belongs to a different clearance record.', 409);
        }
        return { clearanceId: Number(prior.clearance_id), alreadyRecorded: true };
      }
      const context = await loadEnrollmentContext(transaction, enrollmentId);
      if (!context || Number(context.student_id) !== Number(owner.student_id)) throw new TermClearanceError('Term enrollment changed. Reload the student record.', 409);
      const existing = await clearanceByEnrollment(transaction, enrollmentId, { lock: true });
      if (existing) throw new TermClearanceError('This term already has an attendance review. Reload its saved checklist before editing.', 409);

      let template = null;
      let roster = [];
      const currentPosition = await ensureTermMayBeReviewed(transaction, context);
      if (scopeStatus === 'attended') {
        const historical = isPastAcademicTerm(currentPosition, context.school_year, context.annual_term_number);
        template = await loadTemplate(transaction, templateId, context.grade_level, { allowSuperseded: historical });
        if (template.status === 'superseded' && templateSelectionReason.length < 5) {
          throw new TermClearanceError('Explain why this older paper form version matches the historical signed form.');
        }
        if (!context.section_id) throw new TermClearanceError('A section must be saved for this term before its paper subject roster can be reviewed.', 409);
        roster = await loadRosterSnapshot(transaction, context);
        if (!reconciliation.reviewed) throw new TermClearanceError('Compare the saved subject list with the approved paper form before saving its setup.');
        if (roster.length === 0 && reconciliation.rows.length === 0) {
          throw new TermClearanceError('No subject list exists for this term. Add the teacher and subject lines from the paper form, then explain the difference before continuing.', 409);
        }
        const rosterKeys = new Set(roster.map((row) => `${String(row.subject_code || '').toLocaleLowerCase()}\u0000${String(row.subject_name || '').toLocaleLowerCase()}`));
        if (reconciliation.rows.some((row) => rosterKeys.has(`${String(row.subjectCode || '').toLocaleLowerCase()}\u0000${row.subjectName.toLocaleLowerCase()}`))) {
          throw new TermClearanceError('A paper subject line duplicates one already in the saved subject list.');
        }
      }
      const inserted = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
        .input('annualEnrollmentId', sql.Int, context.annual_enrollment_id).input('studentId', sql.Int, context.student_id)
        .input('templateId', sql.Int, template ? template.id : null).input('gradeLevel', sql.NVarChar(50), context.grade_level)
        .input('schoolYear', sql.NVarChar(20), context.school_year).input('termLabel', sql.NVarChar(100), context.term_label)
        .input('academicTermId', sql.Int, context.academic_term_id).input('termNumber', sql.TinyInt, context.annual_term_number)
        .input('sectionId', sql.Int, context.section_id).input('sectionName', sql.NVarChar(100), context.section_name)
        .input('sectionCluster', sql.NVarChar(80), context.section_cluster).input('sectionStrand', sql.NVarChar(80), context.section_strand)
        .input('trackLabel', sql.NVarChar(80), template?.track_label || null).input('scopeStatus', sql.NVarChar(20), scopeStatus)
        .input('scopeReason', sql.NVarChar(1000), scopeReason).input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO student_term_clearances
          (enrollment_id, annual_enrollment_id, student_id, template_id, grade_level_snapshot, school_year_snapshot,
            term_label_snapshot, academic_term_id_snapshot, term_number_snapshot, section_id_snapshot, section_name_snapshot,
            section_cluster_snapshot, section_strand_snapshot, track_label_snapshot, scope_status, scope_reason, created_by)
          VALUES (@enrollmentId, @annualEnrollmentId, @studentId, @templateId, @gradeLevel, @schoolYear,
            @termLabel, @academicTermId, @termNumber, @sectionId, @sectionName, @sectionCluster, @sectionStrand,
            @trackLabel, @scopeStatus, @scopeReason, @actorId)`);
      const clearanceId = Number(inserted.insertId);
      const items = template ? await insertClearanceItems(transaction, clearanceId, context, template, roster, reconciliation) : [];
      const after = { enrollmentId, schoolYear: context.school_year, term: context.term_label,
        annualTermNumber: context.annual_term_number == null ? null : Number(context.annual_term_number),
        academicTermId: Number(context.academic_term_id), sectionId: context.section_id == null ? null : Number(context.section_id),
        sectionName: context.section_name, sectionCluster: context.section_cluster, sectionStrand: context.section_strand,
        gradeLevel: context.grade_level, trackLabel: template?.track_label || null, scopeStatus, scopeReason,
        templateId: template ? Number(template.id) : null, templateVersion: template ? Number(template.version_no) : null,
        templateSelectionReason: template?.status === 'superseded' ? templateSelectionReason : null,
        rosterSubjectRows: roster.length, reconciledTeacherRows: reconciliation.rows, rosterReconciliationReason: reconciliation.reason,
        generatedItemCount: items.length, generatedItems: items.map((item) => ({ category: item.category, label: item.label,
          subjectCode: item.subjectCode, subjectName: item.subjectName, teacherAssignmentId: item.teacherAssignmentId,
          teacherUserId: item.teacherUserId, teacherName: item.teacherName, teacherContextStatus: item.teacherContextStatus,
          applicabilityStatus: item.applicabilityStatus, sortOrder: item.sortOrder })) };
      await addEvent(transaction, { clearanceId, actorId: actor.id, eventType: 'created', reason: scopeReason || reconciliation.reason,
        after, idempotencyKey, requestFingerprint });
      await writeAudit(transaction, actor, 'term_clearance_created', 'student_term_clearance', clearanceId,
        { studentId: Number(context.student_id), annualEnrollmentId: Number(context.annual_enrollment_id), enrollmentId,
          scopeStatus, templateId: template ? Number(template.id) : null, generatedItemCount: items.length,
          rosterReconciled: reconciliation.rows.length > 0 });
      return { clearanceId, version: 1, alreadyRecorded: false };
    });
  }

  async function loadClearanceItems(transaction, clearanceId, { lock = false } = {}) {
    const result = await transaction.request().input('clearanceId', sql.BigInt, clearanceId)
      .query(`SELECT id, clearance_id, template_item_id, category, label_snapshot, subject_id, student_subject_id,
          subject_code_snapshot, subject_name_snapshot, teacher_assignment_id, teacher_user_id, teacher_name_snapshot,
          teacher_context_status, applicability_status, applicability_reason, signature_present, signer_name,
          paper_signed_on, signer_context_reason, sort_order
        FROM student_term_clearance_items WHERE clearance_id = @clearanceId ORDER BY sort_order, id ${lock ? 'FOR UPDATE' : ''}`);
    return result.recordset || [];
  }

  function publicItemSnapshot(item) {
    return { id: Number(item.id), category: item.category, label: item.label_snapshot,
      subjectCode: item.subject_code_snapshot, subjectName: item.subject_name_snapshot,
      teacherName: item.teacher_name_snapshot, teacherContextStatus: item.teacher_context_status,
      applicabilityStatus: item.applicability_status, applicabilityReason: item.applicability_reason,
      signaturePresent: Number(item.signature_present) === 1, signerName: item.signer_name,
      paperSignedOn: item.paper_signed_on, signerContextReason: item.signer_context_reason };
  }

  async function updateTermClearance(actorInput, clearanceInput, input = {}, expectedStudentInput = null) {
    const actorId = idValue(actorInput, 'user');
    const clearanceId = idValue(clearanceInput, 'clearance');
    const expectedStudentId = expectedStudentInput == null ? null : idValue(expectedStudentInput, 'student');
    const expectedVersion = idValue(input.expectedVersion, 'clearance revision');
    const idempotencyKey = requestKey(input.idempotencyKey);
    const itemUpdates = cleanItemUpdates(input);
    const scopeStatus = input.scopeStatus;
    if (!['attended', 'not_attended'].includes(scopeStatus)) throw new TermClearanceError('Check school records and choose whether the student attended the entire term.');
    const scopeReason = scopeStatus === 'not_attended'
      ? field(input.scopeReason, 'Reason the entire term was not attended', 1000, { required: true, minimum: 5 }) : null;
    const templateSelectionReason = field(input.templateSelectionReason || '', 'Paper form version reason', 1000, { minimum: 0 }) || '';
    const correctionReason = field(input.correctionReason || '', 'Correction reason', 1000, { minimum: 0 });
    const inspectionDate = dateValue(input.inspectedOn, 'Paper inspection date');
    const reconciliation = cleanReconciliation(input);
    const templateIdInput = input.templateId ? idValue(input.templateId, 'approved template') : null;
    const action = input.clearanceAction;
    if (!['prepare', 'complete', 'reopen'].includes(action)) {
      throw new TermClearanceError('Choose whether to save paper-form setup, record a completed paper form, or reopen a completed correction.');
    }
    const attest = action === 'complete';
    const paperInspected = isChecked(input.paperInspected);
    const attestRequested = isChecked(input.attestPaperInspected);
    if (attest !== paperInspected || attest !== attestRequested) {
      throw new TermClearanceError('Use Record completed paper only after inspecting the printed form.');
    }
    const payload = { clearanceId, expectedVersion, itemUpdates, scopeStatus, scopeReason, correctionReason, inspectionDate, action, attest,
      paperInspected, templateId: templateIdInput, templateSelectionReason, reconciliation };
    const requestFingerprint = fingerprint(payload);
    const pool = await getPool();
    const ownerResult = await pool.request().input('clearanceId', sql.BigInt, clearanceId)
      .query('SELECT student_id FROM student_term_clearances WHERE id = @clearanceId');
    const owner = ownerResult.recordset?.[0];
    if (!owner) throw new TermClearanceError('Clearance record not found.', 404);
    if (expectedStudentId && Number(owner.student_id) !== expectedStudentId) throw new TermClearanceError('Clearance does not belong to this student record.', 404);
    return runTransaction(async (transaction) => {
      const actor = await requireStaff(transaction.request(), actorId, { write: true });
      const student = await lockStudent(transaction, Number(owner.student_id));
      if (!student) throw new TermClearanceError('Student record not found.', 404);
      const prior = await eventByKey(transaction, idempotencyKey, requestFingerprint);
      if (prior) {
        if (Number(prior.clearance_id) !== clearanceId) throw new TermClearanceError('This token belongs to a different clearance record.', 409);
        return { clearanceId, alreadyRecorded: true };
      }
      const currentResult = await transaction.request().input('clearanceId', sql.BigInt, clearanceId)
        .query(`SELECT clearance.*, enrollment.enrollment_status, enrollment.term_scope_status, annual.intake_status,
            student.status AS student_status
          FROM student_term_clearances AS clearance
          INNER JOIN enrollments AS enrollment ON enrollment.id = clearance.enrollment_id
          INNER JOIN annual_enrollments AS annual ON annual.id = clearance.annual_enrollment_id
          INNER JOIN students AS student ON student.id = clearance.student_id
          WHERE clearance.id = @clearanceId FOR UPDATE`);
      const current = currentResult.recordset?.[0];
      if (!current) throw new TermClearanceError('Clearance record not found.', 404);
      if (Number(current.student_id) !== Number(owner.student_id)) throw new TermClearanceError('Clearance ownership changed. Reload the student record.', 409);
      if (Number(current.version) !== expectedVersion) throw new TermClearanceError('This clearance changed in another session. Reload it before saving.', 409);
      const context = await loadEnrollmentContext(transaction, Number(current.enrollment_id));
      if (!context || Number(context.student_id) !== Number(current.student_id)) throw new TermClearanceError('The saved enrollment context could not be verified.', 409);
      const currentPosition = await ensureTermMayBeReviewed(transaction, context);
      if (current.intake_status === 'legacy' && itemUpdates.length) {
        // A separate clearance snapshot may be recorded for a read-only historical enrollment; its source enrollment remains untouched.
      }
      let template = null;
      let roster = [];
      let templateId = current.template_id == null ? null : Number(current.template_id);
      if (scopeStatus === 'attended' && !templateId) {
        if (!templateIdInput) throw new TermClearanceError('Choose an approved paper form template before changing this term to attended.');
        if (!context?.section_id) throw new TermClearanceError('A section must be saved for this term before its paper subject roster can be reviewed.', 409);
        const historical = isPastAcademicTerm(currentPosition, context.school_year, context.annual_term_number);
        template = await loadTemplate(transaction, templateIdInput, context.grade_level, { allowSuperseded: historical });
        if (template.status === 'superseded' && templateSelectionReason.length < 5) {
          throw new TermClearanceError('Explain why this older paper form version matches the historical signed form.');
        }
        templateId = Number(template.id);
        roster = await loadRosterSnapshot(transaction, context);
        if (!reconciliation.reviewed) throw new TermClearanceError('Compare the saved subject list with the paper form before saving its setup.');
        if (roster.length === 0 && reconciliation.rows.length === 0) {
          throw new TermClearanceError('No subject list exists for this term. Add the teacher and subject lines from the paper form, then explain the difference before continuing.', 409);
        }
        const rosterKeys = new Set(roster.map((row) => `${String(row.subject_code || '').toLocaleLowerCase()}\u0000${String(row.subject_name || '').toLocaleLowerCase()}`));
        if (reconciliation.rows.some((row) => rosterKeys.has(`${String(row.subjectCode || '').toLocaleLowerCase()}\u0000${row.subjectName.toLocaleLowerCase()}`))) {
          throw new TermClearanceError('A paper subject line duplicates one already in the saved subject list.');
        }
      }
      const beforeItems = await loadClearanceItems(transaction, clearanceId, { lock: true });
      const initializingTemplate = Boolean(template && !current.template_id);
      if (initializingTemplate && beforeItems.length) {
        throw new TermClearanceError('This term marked not attended already has saved signature lines. Review its history before adding an attended-term form.', 409);
      }
      let itemCountAfterInitialization = beforeItems.length;
      if (initializingTemplate) {
        await insertClearanceItems(transaction, clearanceId, context, template, roster, { rows: [], reason: null, reviewed: true });
        itemCountAfterInitialization += roster.length + template.items.length;
      }
      const beforeItemMap = new Map(beforeItems.map((item) => [Number(item.id), item]));
      if (itemUpdates.some((item) => !beforeItemMap.has(item.itemId))) throw new TermClearanceError('A clearance row no longer belongs to this saved checklist. Reload it.', 409);
      const wasAttested = Boolean(current.attested_by || current.attested_at);
      if (action === 'prepare' && wasAttested) {
        throw new TermClearanceError('This paper form is already completed. Use Save correction and reopen to make a reasoned change.', 409);
      }
      if (action === 'reopen' && !wasAttested) {
        throw new TermClearanceError('Only a completed paper clearance can be reopened for correction.', 409);
      }
      if (action === 'complete' && wasAttested) {
        throw new TermClearanceError('This paper clearance is already completed. Reopen it with a reason before making a correction.', 409);
      }
      if (action === 'prepare' && itemUpdates.some((update) => {
        const item = beforeItemMap.get(update.itemId);
        const paperDate = item.paper_signed_on instanceof Date
          ? item.paper_signed_on.toISOString().slice(0, 10)
          : item.paper_signed_on ? String(item.paper_signed_on).slice(0, 10) : null;
        return update.signaturePresent !== (Number(item.signature_present) === 1)
          || update.signerName !== (item.signer_name || null)
          || update.paperSignedOn !== paperDate
          || update.applicabilityStatus !== item.applicability_status
          || update.applicabilityReason !== (item.applicability_reason || null)
          || update.signerContextReason !== (item.signer_context_reason || null);
      })) {
        throw new TermClearanceError('Paper signatures and line decisions are recorded only when you record the completed paper form.');
      }
      const before = { version: Number(current.version), scopeStatus: current.scope_status, scopeReason: current.scope_reason,
        attestedBy: current.attested_by, attestedAt: current.attested_at, inspectedOn: current.inspected_on,
        templateId: current.template_id == null ? null : Number(current.template_id),
        items: beforeItems.map(publicItemSnapshot) };
      let itemChanged = false;
      let requiresCorrectionReason = false;
      for (const update of itemUpdates) {
        const item = beforeItemMap.get(update.itemId);
        const allowedApplicability = item.category === 'laboratory' ? update.applicabilityStatus : 'required';
        if (item.category !== 'laboratory' && update.applicabilityStatus !== 'required') throw new TermClearanceError('Only a laboratory line can be marked as not required.');
        if (item.category === 'laboratory' && update.applicabilityStatus === 'required' && !update.signaturePresent
          && item.applicability_status !== 'required') {
          // Requiring the signature clears its prior exclusion and requires a paper signature before attestation.
        }
        if (update.signaturePresent && item.category === 'teacher' && item.teacher_context_status !== 'assigned'
          && !update.signerContextReason) {
          throw new TermClearanceError('Explain why this name belongs beside the signature when saved teacher details are missing, inactive, or unclear.');
        }
        const next = { applicabilityStatus: allowedApplicability,
          applicabilityReason: allowedApplicability === 'not_applicable' ? update.applicabilityReason : null,
          signaturePresent: update.signaturePresent, signerName: update.signerName,
          paperSignedOn: update.paperSignedOn, signerContextReason: update.signerContextReason };
        const old = { applicabilityStatus: item.applicability_status, applicabilityReason: item.applicability_reason,
          signaturePresent: Number(item.signature_present) === 1, signerName: item.signer_name,
          paperSignedOn: item.paper_signed_on, signerContextReason: item.signer_context_reason };
        if (JSON.stringify(next) === JSON.stringify(old)) continue;
        itemChanged = true;
        const hadSavedSignature = Number(item.signature_present) === 1 || item.signer_name != null || item.paper_signed_on != null;
        const correctedLaboratoryDecision = item.category === 'laboratory' && item.applicability_status !== 'unreviewed'
          && (next.applicabilityStatus !== item.applicability_status || next.applicabilityReason !== item.applicability_reason);
        if (wasAttested || hadSavedSignature || correctedLaboratoryDecision) requiresCorrectionReason = true;
        await transaction.request().input('itemId', sql.BigInt, update.itemId).input('clearanceId', sql.BigInt, clearanceId)
          .input('applicabilityStatus', sql.NVarChar(20), next.applicabilityStatus)
          .input('applicabilityReason', sql.NVarChar(1000), next.applicabilityReason)
          .input('signaturePresent', sql.Bit, next.signaturePresent)
          .input('signerName', sql.NVarChar(160), next.signerName).input('paperSignedOn', sql.Date, next.paperSignedOn)
          .input('signerContextReason', sql.NVarChar(1000), next.signerContextReason)
          .query(`UPDATE student_term_clearance_items SET applicability_status = @applicabilityStatus,
              applicability_reason = @applicabilityReason, signature_present = @signaturePresent,
              signer_name = @signerName, paper_signed_on = @paperSignedOn,
              signer_context_reason = @signerContextReason, updated_at = UTC_TIMESTAMP(3)
            WHERE id = @itemId AND clearance_id = @clearanceId`);
      }
      let reconciliationReason = null;
      if (reconciliation.rows.length) {
        if (!reconciliation.reviewed) throw new TermClearanceError('Confirm that you compared the saved subject list with the school paper form.');
        reconciliationReason = reconciliation.reason;
        const existingSubjectKeys = new Set(beforeItems.filter((item) => item.category === 'teacher').map((item) =>
          `${String(item.subject_code_snapshot || '').toLocaleLowerCase()}\u0000${String(item.subject_name_snapshot || '').toLocaleLowerCase()}`));
        if (reconciliation.rows.some((row) => existingSubjectKeys.has(`${row.subjectCode.toLocaleLowerCase()}\u0000${row.subjectName.toLocaleLowerCase()}`))) {
          throw new TermClearanceError('A paper subject line duplicates one already in the saved subject list.');
        }
        if (!correctionReason) throw new TermClearanceError('Enter a correction reason when adding paper subject rows.');
        await insertManualTeacherRows(transaction, clearanceId, reconciliation.rows, itemCountAfterInitialization + 1);
        itemChanged = true;
      }
      const scopeChanged = current.scope_status !== scopeStatus || String(current.scope_reason || '') !== String(scopeReason || '');
      const previousInspectionDate = current.inspected_on instanceof Date
        ? current.inspected_on.toISOString().slice(0, 10)
        : current.inspected_on ? String(current.inspected_on).slice(0, 10) : null;
      const nextInspectionDate = scopeStatus === 'attended' ? inspectionDate : null;
      const inspectionDateChanged = nextInspectionDate !== previousInspectionDate;
      if (action === 'prepare' && inspectionDateChanged
        && !(scopeStatus === 'not_attended' && scopeChanged)) {
        throw new TermClearanceError('The paper inspection date is recorded only when you record the completed paper form.');
      }
      const savedInspectionDateCorrection = previousInspectionDate !== null && inspectionDateChanged;
      const attestationChanged = wasAttested && attest
        && (inspectionDateChanged || Number(current.attested_by) !== Number(actor.id));
      if ((scopeChanged || requiresCorrectionReason || attestationChanged || savedInspectionDateCorrection || (wasAttested && !attest)) && !correctionReason) {
        throw new TermClearanceError('Enter a reason when changing the attendance decision or saved signature details.');
      }
      if (wasAttested && attest && (scopeChanged || itemChanged || inspectionDateChanged)) {
        throw new TermClearanceError('Save the correction first. Reload the paper record, inspect it again, then mark it complete in a separate review.', 409);
      }
      if (attest && wasAttested && !scopeChanged && !itemChanged && !attestationChanged) {
        throw new TermClearanceError('This clearance is already complete with the saved paper inspection date. No change was made.', 409);
      }
      const itemsAfterChanges = await loadClearanceItems(transaction, clearanceId, { lock: true });
      let newAttestedBy = null;
      let inspectedOn = nextInspectionDate;
      if (attest) {
        if (scopeStatus !== 'attended' || !(templateId || current.template_id)) throw new TermClearanceError('Only an attended term with a saved paper form can be marked complete.');
        if (!inspectionDate) throw new TermClearanceError('Enter the date you inspected the printed form.');
        const teacherRows = itemsAfterChanges.filter((item) => item.category === 'teacher');
        if (!teacherRows.length) throw new TermClearanceError('No teacher and subject lines are saved. Compare the paper form and school records before marking this complete.');
        const missingOfficeRows = ['registrar', 'guidance', 'finance'].some((category) => !itemsAfterChanges.some((item) => item.category === category));
        if (missingOfficeRows) throw new TermClearanceError('The saved template is missing a required office signature line. Create a new complete template version.');
        const unresolved = itemsAfterChanges.filter((item) => item.applicability_status === 'unreviewed');
        if (unresolved.length) throw new TermClearanceError('Choose Required or Not required for every laboratory line before marking clearance complete.');
        const required = itemsAfterChanges.filter((item) => item.applicability_status === 'required');
        const missingSignatures = required.filter((item) => Number(item.signature_present) !== 1 || !String(item.signer_name || '').trim());
        if (missingSignatures.length) throw new TermClearanceError('Record every required paper signature before recording completed paper clearance.');
        const missingTeacherContext = required.filter((item) => item.category === 'teacher'
          && item.teacher_context_status !== 'assigned' && String(item.signer_context_reason || '').trim().length < 5);
        if (missingTeacherContext.length) throw new TermClearanceError('Explain why each teacher name belongs beside the signature when saved teacher details are missing, inactive, or unclear.');
        newAttestedBy = actor.id;
        inspectedOn = inspectionDate;
      } else if (action === 'prepare' && !scopeChanged && !itemChanged && !inspectionDateChanged) {
        throw new TermClearanceError('No paper-form setup or attendance changes were submitted.');
      }
      const nextVersion = Number(current.version) + 1;
      const updated = await transaction.request().input('clearanceId', sql.BigInt, clearanceId)
        .input('scopeStatus', sql.NVarChar(20), scopeStatus).input('scopeReason', sql.NVarChar(1000), scopeReason)
        .input('templateId', sql.Int, template ? template.id : templateId)
        .input('trackLabel', sql.NVarChar(80), template ? template.track_label : current.track_label_snapshot)
        .input('attestedBy', sql.Int, newAttestedBy).input('inspectedOn', sql.Date, inspectedOn)
        .input('version', sql.Int, expectedVersion).input('nextVersion', sql.Int, nextVersion)
        .query(`UPDATE student_term_clearances SET scope_status = @scopeStatus, scope_reason = @scopeReason,
            template_id = @templateId, track_label_snapshot = @trackLabel,
            attested_by = @attestedBy, attested_at = CASE WHEN @attestedBy IS NULL THEN NULL ELSE UTC_TIMESTAMP(3) END,
            inspected_on = @inspectedOn, version = @nextVersion, updated_at = UTC_TIMESTAMP(3)
          WHERE id = @clearanceId AND version = @version`);
      if (updated.rowsAffected?.[0] !== 1) throw new TermClearanceError('This clearance changed in another session. Reload it before saving.', 409);
      const after = { version: nextVersion, scopeStatus, scopeReason, attested: Boolean(newAttestedBy), inspectedOn,
        templateId, trackLabel: template ? template.track_label : current.track_label_snapshot,
        templateSelectionReason: template?.status === 'superseded' ? templateSelectionReason : null,
        rosterReconciledSubjects: reconciliation.rows, rosterReconciliationReason: reconciliationReason,
        items: itemsAfterChanges.map(publicItemSnapshot),
        itemChanges: itemUpdates.map((item) => ({ itemId: item.itemId, signaturePresent: item.signaturePresent,
          signerName: item.signerName, paperSignedOn: item.paperSignedOn, applicabilityStatus: item.applicabilityStatus,
          applicabilityReason: item.applicabilityReason, signerContextReason: item.signerContextReason })) };
      const eventType = newAttestedBy ? 'attested' : scopeChanged ? 'scope_reviewed' : wasAttested && !attest ? 'reopened' : 'items_updated';
      await addEvent(transaction, { clearanceId, actorId: actor.id, eventType, reason: correctionReason || scopeReason,
        before, after, idempotencyKey, requestFingerprint });
      await writeAudit(transaction, actor, newAttestedBy ? 'term_clearance_attested' : 'term_clearance_updated',
        'student_term_clearance', clearanceId, { studentId: Number(current.student_id), enrollmentId: Number(current.enrollment_id),
          fromVersion: expectedVersion, toVersion: nextVersion, eventType, changedItemCount: itemChanged ? itemUpdates.length : 0 });
      return { clearanceId, version: nextVersion, attested: Boolean(newAttestedBy), reopened: Boolean(wasAttested && !newAttestedBy) };
    });
  }

  async function loadPrerequisiteRows(transaction, annual, { beforeTermNumber = null } = {}) {
    const configuredResult = await transaction.request().input('schoolYear', sql.NVarChar(20), annual.school_year)
      .query(`SELECT order_row.term_number, order_row.academic_term_id, term.term
        FROM school_year_term_order AS order_row
        INNER JOIN academic_terms AS term ON term.id = order_row.academic_term_id
        WHERE order_row.school_year = @schoolYear ORDER BY order_row.term_number FOR UPDATE`);
    const configured = configuredResult.recordset || [];
    if (configured.length !== 3 || configured.some((row, index) => Number(row.term_number) !== index + 1)) {
      return { configured, terms: [], currentPosition: null,
        setupError: 'The school-year term order is incomplete; resolve it before reviewing paper clearance.' };
    }
    const currentPosition = await currentAcademicPosition(transaction);
    if (!currentPosition) {
      return { configured, terms: [], currentPosition: null,
        setupError: 'The current academic term is not mapped to its school-year order; resolve it before reviewing paper clearance.' };
    }
    const entryTermNumber = Number(annual.entry_term_number);
    if (!Number.isInteger(entryTermNumber) || entryTermNumber < 1 || entryTermNumber > 3) {
      return { configured, terms: [], setupError: 'The annual enrollment entry term is not recorded clearly enough to review prior applicability.' };
    }
    const placements = await transaction.request().input('annualEnrollmentId', sql.Int, annual.id)
      .query(`SELECT enrollment.id AS enrollment_id, enrollment.academic_term_id, enrollment.annual_term_number,
          enrollment.enrollment_status, enrollment.term_scope_status, enrollment.section_id,
          order_row.term_number, term.term AS term_label, section.name AS section_name,
          clearance.id AS clearance_id, clearance.scope_status, clearance.scope_reason, clearance.template_id,
          clearance.attested_by, clearance.attested_at, clearance.inspected_on, clearance.version AS clearance_version,
          COALESCE(items.item_count, 0) AS item_count, COALESCE(items.teacher_count, 0) AS teacher_count,
          COALESCE(items.registrar_count, 0) AS registrar_count, COALESCE(items.guidance_count, 0) AS guidance_count,
          COALESCE(items.finance_count, 0) AS finance_count,
          COALESCE(items.required_count, 0) AS required_count, COALESCE(items.signed_count, 0) AS signed_count,
          COALESCE(items.required_unsigned_count, 0) AS required_unsigned_count,
          COALESCE(items.unresolved_count, 0) AS unresolved_count, COALESCE(items.teacher_context_missing_count, 0) AS teacher_context_missing_count
        FROM school_year_term_order AS order_row
        INNER JOIN academic_terms AS term ON term.id = order_row.academic_term_id
        LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = @annualEnrollmentId
          AND enrollment.academic_term_id = order_row.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN student_term_clearances AS clearance ON clearance.enrollment_id = enrollment.id
        LEFT JOIN (
          SELECT clearance_id, COUNT(*) AS item_count,
            SUM(category = 'teacher') AS teacher_count, SUM(category = 'registrar') AS registrar_count,
            SUM(category = 'guidance') AS guidance_count, SUM(category = 'finance') AS finance_count,
            SUM(applicability_status = 'required') AS required_count,
            SUM(applicability_status = 'required' AND signature_present = 1 AND signer_name IS NOT NULL AND TRIM(signer_name) <> '') AS signed_count,
            SUM(applicability_status = 'required' AND (signature_present = 0 OR signer_name IS NULL OR TRIM(signer_name) = '')) AS required_unsigned_count,
            SUM(applicability_status = 'unreviewed') AS unresolved_count,
            SUM(category = 'teacher' AND signature_present = 1 AND teacher_context_status <> 'assigned'
              AND (signer_context_reason IS NULL OR CHAR_LENGTH(TRIM(signer_context_reason)) < 5)) AS teacher_context_missing_count
          FROM student_term_clearance_items GROUP BY clearance_id
        ) AS items ON items.clearance_id = clearance.id
        WHERE order_row.school_year = (SELECT school_year FROM annual_enrollments WHERE id = @annualEnrollmentId)
        ORDER BY order_row.term_number FOR UPDATE`);
    let terms = (placements.recordset || []).map((row) => {
      const number = Number(row.term_number);
      const beforeEntry = number < entryTermNumber;
      const future = isFutureAcademicTerm(currentPosition, annual.school_year, number) === true;
      const counts = row.clearance_id ? row : null;
      const complete = completeFromCounts(counts);
      let state;
      if (beforeEntry || future) state = 'not_applicable';
      else if (!row.enrollment_id) state = 'missing_placement';
      else if (!row.clearance_id) state = 'missing';
      else if (row.scope_status === 'unreviewed') state = 'unreviewed';
      else if (row.scope_status === 'not_attended') state = String(row.scope_reason || '').trim().length >= 5 ? 'not_attended' : 'invalid_exclusion';
      else if (row.scope_status === 'attended') state = complete ? 'complete' : 'incomplete';
      else state = 'unreviewed';
      const awaitingConfirmation = state === 'incomplete' && awaitingRegistrarConfirmation(row);
      return { enrollmentId: row.enrollment_id == null ? null : Number(row.enrollment_id),
        academicTermId: Number(row.academic_term_id), termNumber: number, termLabel: row.term_label,
        enrollmentStatus: row.enrollment_status, termScopeStatus: row.term_scope_status,
        clearanceId: row.clearance_id == null ? null : Number(row.clearance_id), scopeStatus: row.scope_status,
        scopeReason: row.scope_reason, clearanceVersion: row.clearance_version == null ? null : Number(row.clearance_version),
        itemCount: Number(row.item_count || 0), teacherCount: Number(row.teacher_count || 0), awaitingConfirmation,
        requiredCount: Number(row.required_count || 0), signedCount: Number(row.signed_count || 0), state, beforeEntry, future,
        fingerprintData: { enrollmentId: row.enrollment_id == null ? null : Number(row.enrollment_id), academicTermId: Number(row.academic_term_id),
          termNumber: number, termLabel: row.term_label, enrollmentStatus: row.enrollment_status,
          termScopeStatus: row.term_scope_status, clearanceId: row.clearance_id == null ? null : Number(row.clearance_id),
          scopeStatus: row.scope_status, scopeReason: row.scope_reason, beforeEntry, future,
          clearanceVersion: row.clearance_version == null ? null : Number(row.clearance_version), complete,
          requiredCount: Number(row.required_count || 0), signedCount: Number(row.signed_count || 0),
          requiredUnsignedCount: Number(row.required_unsigned_count || 0), unresolvedCount: Number(row.unresolved_count || 0),
          teacherContextMissingCount: Number(row.teacher_context_missing_count || 0) } };
    });
    if (beforeTermNumber != null) terms = terms.filter((term) => term.termNumber < beforeTermNumber);
    else terms = terms.filter((term) => !term.beforeEntry);
    if (beforeTermNumber != null) {
      for (let number = entryTermNumber; number < beforeTermNumber; number += 1) {
        if (!terms.some((term) => term.termNumber === number)) terms.push({ termNumber: number, termLabel: `Term ${number}`,
          enrollmentId: null, state: 'missing_placement', fingerprintData: { termNumber: number, missingPlacement: true } });
      }
      terms.sort((left, right) => left.termNumber - right.termNumber);
    } else {
      for (let number = entryTermNumber; number <= 3; number += 1) {
        if (!terms.some((term) => term.termNumber === number)) terms.push({ termNumber: number, termLabel: `Term ${number}`,
          enrollmentId: null, state: 'missing_placement', fingerprintData: { termNumber: number, missingPlacement: true } });
      }
      terms.sort((left, right) => left.termNumber - right.termNumber);
    }
    return { configured, terms, setupError: null, entryTermNumber, currentPosition };
  }

  function summarizeTerms(terms, setupError = null) {
    const blockers = [];
    if (setupError) blockers.push(setupError);
    for (const term of terms) {
      if (term.state === 'complete' || term.state === 'not_attended' || term.state === 'not_applicable') continue;
      if (term.state === 'missing_placement') blockers.push(`${term.termLabel}: term placement is missing from the saved annual record. Ask the registrar administrator to review the history.`);
      else if (term.state === 'missing') blockers.push(`${term.termLabel}: no paper clearance applicability review is recorded. Review it in the student’s Clearance tab.`);
      else if (term.state === 'unreviewed') blockers.push(`${term.termLabel}: applicability is unresolved. Review school records and select attended or not attended with a reason.`);
      else if (term.state === 'invalid_exclusion') blockers.push(`${term.termLabel}: the not-attended exclusion has no valid reason. Correct the applicability history.`);
      else if (term.state === 'incomplete') blockers.push(`${term.termLabel}: Pending — the registrar has not confirmed a completed paper form.`);
    }
    return { ready: blockers.length === 0, blockers };
  }

  async function annualReviewInTransaction(transaction, actorId, annualInput) {
    const annualId = idValue(annualInput, 'annual enrollment');
    const ownerResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualId)
      .query('SELECT student_id FROM annual_enrollments WHERE id = @annualEnrollmentId');
    const owner = ownerResult.recordset?.[0];
    if (!owner) throw new TermClearanceError('Annual enrollment not found.', 404);
    await requireStaff(transaction.request(), actorId);
    const student = await lockStudent(transaction, Number(owner.student_id));
    if (!student) throw new TermClearanceError('Student record not found.', 404);
    const annualResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualId)
      .query(`SELECT id, student_id, school_year, grade_level, intake_kind, intake_status, entry_term_number,
          continuity_source_annual_enrollment_id
        FROM annual_enrollments WHERE id = @annualEnrollmentId FOR UPDATE`);
    const annual = annualResult.recordset?.[0];
    if (!annual || Number(annual.student_id) !== Number(owner.student_id)) throw new TermClearanceError('Annual enrollment not found.', 404);
    if (annual.intake_kind !== 'continuing') {
      const exempt = ['new', 'readmission'].includes(annual.intake_kind);
      const data = { annualId, intakeKind: annual.intake_kind, exempt };
      const review = exempt
        ? { kind: 'exempt', intakeKind: annual.intake_kind, sourceAnnualId: null, terms: [], ready: true, blockers: [], fingerprint: fingerprint(data) }
        : { kind: 'unrecognized_intake', sourceAnnualId: null, terms: [], ready: false,
          blockers: ['The saved intake classification is not recognized for paper-clearance review. Ask the registrar to verify the authoritative applicant classification.'],
          fingerprint: fingerprint({ ...data, unresolved: true }) };
      return review;
    }
    const sourceId = Number(annual.continuity_source_annual_enrollment_id || 0);
    if (!sourceId) {
      const data = { annualId, intakeKind: annual.intake_kind, missingSource: true };
      return { kind: 'continuing_source', sourceAnnualId: null, terms: [], ready: false,
        blockers: ['The continuing annual enrollment has no saved preceding-year source. Correct the enrollment record before confirmation.'], fingerprint: fingerprint(data) };
    }
    const sourceResult = await transaction.request().input('sourceId', sql.Int, sourceId).input('studentId', sql.Int, owner.student_id)
      .query(`SELECT source.id, source.student_id, source.school_year, source.grade_level, source.intake_status,
          source.entry_term_number,
          EXISTS(SELECT 1 FROM finance_departure_cases AS departure WHERE departure.annual_enrollment_id = source.id) AS has_departure
        FROM annual_enrollments AS source WHERE source.id = @sourceId AND source.student_id = @studentId FOR UPDATE`);
    const source = sourceResult.recordset?.[0];
    const targetYear = Number(String(annual.school_year).slice(0, 4));
    const expectedYear = `${targetYear - 1}-${targetYear}`;
    const gradeValid = source && (source.grade_level === annual.grade_level || (source.grade_level === 'Grade 11' && annual.grade_level === 'Grade 12'));
    const sourceValid = Boolean(source && source.school_year === expectedYear && gradeValid
      && ['enrolled', 'legacy'].includes(source.intake_status) && !(source.has_departure === true || source.has_departure === 1));
    if (!sourceValid) {
      const data = { annualId, sourceId, source: source ? { schoolYear: source.school_year, gradeLevel: source.grade_level,
        status: source.intake_status, hasDeparture: Number(source.has_departure) === 1 } : null };
      return { kind: 'continuing_source', sourceAnnualId: sourceId, terms: [], ready: false,
        blockers: ['The saved continuing source must be the same student’s exact preceding school year and a valid grade/departure record. Reopen the front-desk classification for registrar review.'], fingerprint: fingerprint(data) };
    }
    const prerequisite = await loadPrerequisiteRows(transaction, source, {});
    const summary = summarizeTerms(prerequisite.terms, prerequisite.setupError);
    const data = { kind: 'continuing_source', source: { id: sourceId, studentId: Number(source.student_id), schoolYear: source.school_year,
      gradeLevel: source.grade_level, entryTermNumber: Number(source.entry_term_number) }, terms: prerequisite.terms.map((term) => term.fingerprintData),
      setupError: prerequisite.setupError };
    return { kind: 'continuing_source', sourceAnnualId: sourceId, sourceSchoolYear: source.school_year,
      terms: prerequisite.terms.map(({ fingerprintData, ...term }) => term), ready: summary.ready, blockers: summary.blockers,
      fingerprint: fingerprint(data) };
  }

  async function getAnnualPrerequisiteReview(actorInput, annualInput) {
    return runTransaction((transaction) => annualReviewInTransaction(transaction, actorInput, annualInput));
  }

  async function assertAnnualEntryPrerequisitesInTransaction(transaction, { actorId, annualId, expectedFingerprint = null } = {}) {
    const review = await annualReviewInTransaction(transaction, actorId, annualId);
    if (expectedFingerprint && review.fingerprint !== expectedFingerprint) {
      throw new TermClearanceError('The reviewed term-clearance prerequisites changed after the annual review. Reload the final review before confirming.', 409);
    }
    if (!review.ready) throw new TermClearanceError(review.blockers[0] || 'Prior-year paper clearance must be reviewed before final confirmation.', 409);
    return review;
  }

  async function termReviewInTransaction(transaction, actorId, enrollmentInput) {
    const enrollmentId = idValue(enrollmentInput, 'enrollment');
    const ownerResult = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
      .query('SELECT student_id FROM enrollments WHERE id = @enrollmentId');
    const owner = ownerResult.recordset?.[0];
    if (!owner) throw new TermClearanceError('Term enrollment not found.', 404);
    await requireStaff(transaction.request(), actorId);
    const student = await lockStudent(transaction, Number(owner.student_id));
    if (!student) throw new TermClearanceError('Student record not found.', 404);
    const context = await loadEnrollmentContext(transaction, enrollmentId);
    if (!context || Number(context.student_id) !== Number(owner.student_id)) throw new TermClearanceError('Term enrollment not found.', 404);
    const targetTermNumber = Number(context.annual_term_number);
    if (!Number.isInteger(targetTermNumber) || targetTermNumber < 1 || targetTermNumber > 3) {
      const data = { enrollmentId, annualId: Number(context.annual_enrollment_id), missingTermNumber: true };
      return { enrollmentId, annualEnrollmentId: Number(context.annual_enrollment_id), studentId: Number(context.student_id),
        studentName: [context.first_name, context.middle_name, context.last_name, context.suffix].filter(Boolean).join(' '),
        studentNo: context.student_no, schoolYear: context.school_year, gradeLevel: context.grade_level, sectionName: context.section_name,
        targetTermNumber: null, targetTermLabel: context.term_label, terms: [], ready: false,
        blockers: ['The target annual term number is not recorded. Resolve the historical placement context before activation.'], fingerprint: fingerprint(data) };
    }
    const rows = await loadPrerequisiteRows(transaction, { id: context.annual_enrollment_id, school_year: context.school_year,
      entry_term_number: context.entry_term_number }, { beforeTermNumber: targetTermNumber });
    const summary = summarizeTerms(rows.terms, rows.setupError);
    const targetAfterCurrent = isFutureAcademicTerm(rows.currentPosition, context.school_year, targetTermNumber) === true;
    const blockers = [...summary.blockers];
    if (targetAfterCurrent) blockers.unshift(`${context.term_label} is after the configured current academic term. This placement may be prepared now, but it cannot be activated until its term becomes current.`);
    const data = { enrollmentId, annualId: Number(context.annual_enrollment_id), targetTermNumber,
      currentAcademicPeriod: rows.currentPosition ? { schoolYear: rows.currentPosition.school_year,
        termNumber: Number(rows.currentPosition.term_number), academicTermId: Number(rows.currentPosition.academicTermId) } : null,
      targetAfterCurrent, terms: rows.terms.map((term) => term.fingerprintData), setupError: rows.setupError };
    return { enrollmentId, annualEnrollmentId: Number(context.annual_enrollment_id), studentId: Number(context.student_id),
      studentName: [context.first_name, context.middle_name, context.last_name, context.suffix].filter(Boolean).join(' '),
      studentNo: context.student_no, schoolYear: context.school_year, gradeLevel: context.grade_level, sectionName: context.section_name,
      targetTermNumber, targetTermLabel: context.term_label, terms: rows.terms.map(({ fingerprintData, ...term }) => term),
      targetAfterCurrent, ready: summary.ready && !targetAfterCurrent, blockers, fingerprint: fingerprint(data) };
  }

  async function getTermActivationReview(actorInput, enrollmentInput) {
    return runTransaction(async (transaction) => {
      const review = await termReviewInTransaction(transaction, actorInput, enrollmentInput);
      const finalized = await transaction.request().input('enrollmentId', sql.Int, idValue(enrollmentInput, 'enrollment'))
        .query('SELECT finalized_at FROM annual_term_finalizations WHERE enrollment_id = @enrollmentId');
      const row = finalized.recordset?.[0];
      return { ...review, alreadyFinalized: Boolean(row), finalizedAt: row?.finalized_at || null };
    });
  }

  async function assertTermPrerequisitesInTransaction(transaction, { actorId, enrollmentId, expectedFingerprint = null } = {}) {
    const review = await termReviewInTransaction(transaction, actorId, enrollmentId);
    if (expectedFingerprint && review.fingerprint !== expectedFingerprint) {
      throw new TermClearanceError('The reviewed paper-clearance prerequisites changed after this activation form was loaded. Reload the annual enrollment list.', 409);
    }
    if (!review.ready) throw new TermClearanceError(review.blockers[0] || 'Earlier attended-term paper clearance must be complete before this term can be activated.', 409);
    return review;
  }

  async function getContinuitySourceOptions(actorInput, annualInput) {
    const actorId = idValue(actorInput, 'user');
    const annualId = idValue(annualInput, 'annual enrollment');
    return runTransaction(async (transaction) => {
      const ownerResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualId)
        .query('SELECT student_id FROM annual_enrollments WHERE id = @annualEnrollmentId');
      const owner = ownerResult.recordset?.[0];
      if (!owner) throw new TermClearanceError('Annual enrollment not found.', 404);
      await requireStaff(transaction.request(), actorId);
      const student = await lockStudent(transaction, Number(owner.student_id));
      if (!student) throw new TermClearanceError('Student record not found.', 404);
      const annualResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualId)
        .query(`SELECT id, student_id, school_year, grade_level, intake_kind, intake_status,
            continuity_source_annual_enrollment_id
          FROM annual_enrollments WHERE id = @annualEnrollmentId FOR UPDATE`);
      const annual = annualResult.recordset?.[0];
      if (!annual || Number(annual.student_id) !== Number(owner.student_id) || annual.intake_kind !== 'continuing') {
        throw new TermClearanceError('A saved continuing annual enrollment is required for source review.', 409);
      }
      if (annual.intake_status !== 'pending') throw new TermClearanceError('Only an unconfirmed continuing annual enrollment can bind its preceding-year source.', 409);
      const targetYear = academicYearStart(annual.school_year);
      if (targetYear === null) throw new TermClearanceError('The school-year value cannot be validated for source review.', 409);
      const expectedYear = `${targetYear - 1}-${targetYear}`;
      const candidatesResult = await transaction.request().input('studentId', sql.Int, annual.student_id)
        .input('schoolYear', sql.NVarChar(20), expectedYear)
        .query(`SELECT source.id, source.school_year, source.grade_level, source.intake_status,
            source.entry_term_number,
            EXISTS(SELECT 1 FROM finance_departure_cases AS departure WHERE departure.annual_enrollment_id = source.id) AS has_departure
          FROM annual_enrollments AS source
          WHERE source.student_id = @studentId AND source.school_year = @schoolYear
          ORDER BY source.id FOR UPDATE`);
      const boundId = annual.continuity_source_annual_enrollment_id == null
        ? null : Number(annual.continuity_source_annual_enrollment_id);
      const candidates = (candidatesResult.recordset || []).filter((source) => {
        const gradeValid = source.grade_level === annual.grade_level
          || source.grade_level === 'Grade 11' && annual.grade_level === 'Grade 12';
        const valid = gradeValid && ['enrolled', 'legacy'].includes(source.intake_status)
          && Number(source.has_departure || 0) === 0;
        return boundId ? Number(source.id) === boundId : valid;
      }).map((source) => ({ id: Number(source.id), schoolYear: source.school_year, gradeLevel: source.grade_level,
        intakeStatus: source.intake_status, entryTermNumber: Number(source.entry_term_number || 0),
        selectable: Number(source.has_departure || 0) === 0 }));
      return { annualId, schoolYear: annual.school_year, gradeLevel: annual.grade_level,
        sourceAnnualId: boundId, sourceLocked: boundId !== null, candidates };
    });
  }

  async function bindContinuitySource(actorInput, annualInput, sourceInput, input = {}) {
    const actorId = idValue(actorInput, 'user');
    const annualId = idValue(annualInput, 'annual enrollment');
    const sourceId = idValue(sourceInput, 'preceding-year annual enrollment');
    const reason = field(input.reason, 'Source review reason', 1000, { required: true, minimum: 5 });
    const idempotencyKey = requestKey(input.idempotencyKey);
    const requestFingerprint = fingerprint({ annualId, sourceId, reason });
    const pool = await getPool();
    const ownerResult = await pool.request().input('annualEnrollmentId', sql.Int, annualId)
      .query('SELECT student_id FROM annual_enrollments WHERE id = @annualEnrollmentId');
    const owner = ownerResult.recordset?.[0];
    if (!owner) throw new TermClearanceError('Annual enrollment not found.', 404);
    return runTransaction(async (transaction) => {
      const actor = await requireStaff(transaction.request(), actorId, { write: true });
      const student = await lockStudent(transaction, Number(owner.student_id));
      if (!student) throw new TermClearanceError('Student record not found.', 404);
      const annualResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualId)
        .query(`SELECT id, student_id, school_year, grade_level, intake_kind, intake_status,
            continuity_source_annual_enrollment_id
          FROM annual_enrollments WHERE id = @annualEnrollmentId FOR UPDATE`);
      const annual = annualResult.recordset?.[0];
      if (!annual || Number(annual.student_id) !== Number(owner.student_id)) throw new TermClearanceError('Annual enrollment not found.', 404);
      const priorResult = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT source_annual_enrollment_id, request_fingerprint
          FROM annual_continuity_source_events WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
      const prior = priorResult.recordset?.[0];
      if (prior) {
        if (Number(prior.source_annual_enrollment_id) !== sourceId || prior.request_fingerprint !== requestFingerprint) {
          throw new TermClearanceError('This source-review token was already used for different details.', 409);
        }
        return { annualId, sourceAnnualId: sourceId, alreadyBound: true };
      }
      if (annual.intake_kind !== 'continuing' || annual.intake_status !== 'pending') {
        throw new TermClearanceError('Only an unconfirmed continuing intake can bind a preceding-year source.', 409);
      }
      if (annual.continuity_source_annual_enrollment_id != null) {
        throw new TermClearanceError('This continuing intake already has a locked source. It cannot be silently replaced.', 409);
      }
      const targetYear = academicYearStart(annual.school_year);
      if (targetYear === null) throw new TermClearanceError('The school-year value cannot be validated for source review.', 409);
      const expectedYear = `${targetYear - 1}-${targetYear}`;
      const sourceResult = await transaction.request().input('sourceId', sql.Int, sourceId)
        .input('studentId', sql.Int, annual.student_id).input('expectedYear', sql.NVarChar(20), expectedYear)
        .query(`SELECT source.id, source.school_year, source.grade_level, source.intake_status,
            EXISTS(SELECT 1 FROM finance_departure_cases AS departure WHERE departure.annual_enrollment_id = source.id) AS has_departure
          FROM annual_enrollments AS source
          WHERE source.id = @sourceId AND source.student_id = @studentId AND source.school_year = @expectedYear FOR UPDATE`);
      const source = sourceResult.recordset?.[0];
      const gradeValid = source && (source.grade_level === annual.grade_level
        || source.grade_level === 'Grade 11' && annual.grade_level === 'Grade 12');
      if (!source || !gradeValid || !['enrolled', 'legacy'].includes(source.intake_status)
        || Number(source.has_departure || 0) !== 0) {
        throw new TermClearanceError('Choose the same student’s exact preceding school year with compatible grade progression and no departure record.', 409);
      }
      const updated = await transaction.request().input('annualId', sql.Int, annualId).input('sourceId', sql.Int, sourceId)
        .query(`UPDATE annual_enrollments SET continuity_source_annual_enrollment_id = @sourceId, updated_at = UTC_TIMESTAMP(6)
          WHERE id = @annualId AND continuity_source_annual_enrollment_id IS NULL AND intake_status = 'pending'`);
      if (updated.rowsAffected?.[0] !== 1) throw new TermClearanceError('The continuing source changed in another session. Reload the intake.', 409);
      await transaction.request().input('annualId', sql.Int, annualId).input('sourceId', sql.Int, sourceId)
        .input('studentId', sql.Int, annual.student_id).input('actorId', sql.Int, actor.id)
        .input('reason', sql.NVarChar(1000), reason).input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.Char(64), requestFingerprint)
        .query(`INSERT INTO annual_continuity_source_events
          (annual_enrollment_id, source_annual_enrollment_id, student_id, actor_id, reason, idempotency_key, request_fingerprint)
          VALUES (@annualId, @sourceId, @studentId, @actorId, @reason, @idempotencyKey, @requestFingerprint)`);
      await writeAudit(transaction, actor, 'continuity_source_bound', annualId,
        { sourceAnnualEnrollmentId: sourceId, sourceSchoolYear: source.school_year, reason });
      return { annualId, sourceAnnualId: sourceId, alreadyBound: false };
    });
  }

  async function getStudentClearance(actorInput, studentInput) {
    const actorId = idValue(actorInput, 'user');
    const studentId = idValue(studentInput, 'student');
    const pool = await getPool();
    await requireStaff(pool.request(), actorId);
    const studentResult = await pool.request().input('studentId', sql.Int, studentId)
      .query('SELECT id, student_no, first_name, middle_name, last_name, suffix, status FROM students WHERE id = @studentId');
    const student = studentResult.recordset?.[0];
    if (!student) throw new TermClearanceError('Student record not found.', 404);
    const termResult = await pool.request().input('studentId', sql.Int, studentId)
      .query(`SELECT enrollment.id AS enrollment_id, enrollment.annual_enrollment_id, enrollment.academic_term_id,
          enrollment.annual_term_number, enrollment.enrollment_status, enrollment.term_scope_status, enrollment.section_id,
          annual.school_year, annual.grade_level, annual.intake_kind, annual.intake_status, annual.entry_term_number,
          annual.continuity_source_annual_enrollment_id, term.term AS term_label, section.name AS section_name,
          clearance.id AS clearance_id, clearance.template_id, clearance.track_label_snapshot, clearance.scope_status,
          clearance.scope_reason, clearance.inspected_on, clearance.attested_by, clearance.attested_at, clearance.version,
          template.version_no AS template_version, template.status AS template_status,
          COALESCE(items.item_count, 0) AS item_count, COALESCE(items.teacher_count, 0) AS teacher_count,
          COALESCE(items.registrar_count, 0) AS registrar_count, COALESCE(items.guidance_count, 0) AS guidance_count,
          COALESCE(items.finance_count, 0) AS finance_count,
          COALESCE(items.required_unsigned_count, 0) AS required_unsigned_count, COALESCE(items.unresolved_count, 0) AS unresolved_count,
          COALESCE(items.teacher_context_missing_count, 0) AS teacher_context_missing_count,
          CASE WHEN (${clearanceCompleteSql()}) THEN 1 ELSE 0 END AS clearance_complete
        FROM enrollments AS enrollment
        INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN student_term_clearances AS clearance ON clearance.enrollment_id = enrollment.id
        LEFT JOIN term_clearance_templates AS template ON template.id = clearance.template_id
        LEFT JOIN (
          SELECT clearance_id, COUNT(*) AS item_count, SUM(category = 'teacher') AS teacher_count,
            SUM(category = 'registrar') AS registrar_count, SUM(category = 'guidance') AS guidance_count,
            SUM(category = 'finance') AS finance_count,
            SUM(applicability_status = 'required' AND (signature_present = 0 OR signer_name IS NULL OR TRIM(signer_name) = '')) AS required_unsigned_count,
            SUM(applicability_status = 'unreviewed') AS unresolved_count,
            SUM(category = 'teacher' AND signature_present = 1 AND teacher_context_status <> 'assigned'
              AND (signer_context_reason IS NULL OR CHAR_LENGTH(TRIM(signer_context_reason)) < 5)) AS teacher_context_missing_count
          FROM student_term_clearance_items GROUP BY clearance_id
        ) AS items ON items.clearance_id = clearance.id
        WHERE enrollment.student_id = @studentId
        ORDER BY annual.school_year DESC, annual.id DESC, enrollment.annual_term_number, term.term`);
    const currentResult = await pool.request().query(`SELECT term.school_year, order_row.term_number
      FROM academic_terms AS term
      LEFT JOIN school_year_term_order AS order_row ON order_row.academic_term_id = term.id
      WHERE term.is_current = 1`);
    const currentPosition = resolveCurrentAcademicPosition(currentResult.recordset || []);
    const terms = (termResult.recordset || []).map((row) => {
      const complete = completeFromCounts(row);
      const beforeEntry = Number(row.annual_term_number) < Number(row.entry_term_number);
      const future = isFutureAcademicTerm(currentPosition, row.school_year, row.annual_term_number) === true;
      const automatic = beforeEntry || future;
      const past = isPastAcademicTerm(currentPosition, row.school_year, row.annual_term_number);
      const state = automatic ? 'not_applicable' : !row.clearance_id ? 'not_reviewed'
        : row.scope_status === 'not_attended' ? 'not_attended' : row.scope_status === 'unreviewed' ? 'unreviewed'
          : complete ? 'complete' : 'incomplete';
      return { ...row, state, awaitingConfirmation: state === 'incomplete' && awaitingRegistrarConfirmation(row),
        version: row.version == null ? null : Number(row.version), beforeEntry, future, past,
        itemCount: Number(row.item_count || 0), teacherCount: Number(row.teacher_count || 0) };
    });
    const clearanceIds = terms.map((term) => Number(term.clearance_id)).filter((id) => Number.isSafeInteger(id) && id > 0);
    let items = [];
    let events = [];
    if (clearanceIds.length) {
      const placeholders = clearanceIds.map((_, index) => `@clearance${index}`).join(', ');
      const itemRequest = pool.request();
      const eventRequest = pool.request();
      clearanceIds.forEach((clearanceId, index) => {
        itemRequest.input(`clearance${index}`, sql.BigInt, clearanceId);
        eventRequest.input(`clearance${index}`, sql.BigInt, clearanceId);
      });
      const itemResult = await itemRequest.query(`SELECT item.*, clearance.enrollment_id
        FROM student_term_clearance_items AS item INNER JOIN student_term_clearances AS clearance ON clearance.id = item.clearance_id
        WHERE item.clearance_id IN (${placeholders}) ORDER BY item.clearance_id, item.sort_order, item.id`);
      items = itemResult.recordset || [];
      const eventResult = await eventRequest.query(`SELECT event.id, event.clearance_id, event.event_type, event.reason,
          event.before_json, event.after_json, event.created_at, profile.first_name AS actor_first_name, profile.last_name AS actor_last_name
        FROM student_term_clearance_events AS event LEFT JOIN staff_profiles AS profile ON profile.user_id = event.actor_id
        WHERE event.clearance_id IN (${placeholders}) ORDER BY event.clearance_id, event.created_at DESC, event.id DESC`);
      events = eventResult.recordset || [];
    }
    const templatesResult = await pool.request().input('grade11', sql.NVarChar(50), 'Grade 11')
      .input('grade12', sql.NVarChar(50), 'Grade 12')
      .query(`SELECT template.id, template.grade_level, template.track_label, template.version_no, template.status
        FROM term_clearance_templates AS template
        WHERE template.grade_level IN (@grade11, @grade12)
        ORDER BY template.grade_level, template.track_label, template.version_no DESC`);
    for (const term of terms) {
      term.clearanceItems = items.filter((item) => Number(item.enrollment_id) === Number(term.enrollment_id));
      term.history = events.filter((event) => Number(event.clearance_id) === Number(term.clearance_id))
        .map((event) => ({ ...event, changeSummary: clearanceEventSummary(event) }));
    }
    return { student, terms, templates: templatesResult.recordset || [] };
  }

  async function getClearanceDashboard(actorInput, filterInput = {}) {
    const actorId = idValue(actorInput, 'user');
    const pool = await getPool();
    await requireStaff(pool.request(), actorId);
    const requestedFilters = normalizeClearanceDashboardFilters(filterInput);
    const [termsResult, currentResult] = await Promise.all([
      pool.request().query(`SELECT term.id, term.school_year, term.term, term.is_current, order_row.term_number
        FROM academic_terms AS term
        LEFT JOIN school_year_term_order AS order_row ON order_row.academic_term_id = term.id
        ORDER BY term.is_current DESC, term.school_year DESC, order_row.term_number, term.id DESC LIMIT 300`),
      pool.request().query(`SELECT term.id, term.school_year, term.term, order_row.term_number
        FROM academic_terms AS term
        LEFT JOIN school_year_term_order AS order_row ON order_row.academic_term_id = term.id
        WHERE term.is_current = 1`)
    ]);
    const terms = (termsResult.recordset || []).map((term) => ({ ...term,
      id: Number(term.id), term_number: term.term_number == null ? null : Number(term.term_number),
      is_current: Number(term.is_current) === 1 }));
    const currentRows = currentResult.recordset || [];
    const currentCandidate = currentRows.length === 1 ? currentRows[0] : null;
    const currentPosition = resolveCurrentAcademicPosition(currentRows);
    const filters = { ...requestedFilters };
    const hasUserFilter = filters.scopeSpecified || filters.page !== 1;
    if (!hasUserFilter && currentPosition) filters.termId = currentPosition.academic_term_id;
    if (filters.termId && !terms.some((term) => term.id === filters.termId)) {
      throw new TermClearanceError('Choose a configured academic term.', 404);
    }
    const queryFilters = { ...filters };
    const baseSql = clearanceDashboardRecordsSql();
    const countsRequest = bindClearanceDashboardFilters(pool.request(), queryFilters, currentPosition, { sqlAdapter: sql });
    const countsResult = await countsRequest.query(`SELECT COUNT(*) AS total_records,
        COALESCE(SUM(clearance_state = 'complete'), 0) AS completed_records,
        COALESCE(SUM(clearance_state = 'incomplete'), 0) AS incomplete_records,
        COALESCE(SUM(clearance_state = 'not_reviewed'), 0) AS not_reviewed_records,
        COALESCE(SUM(clearance_state IN ('incomplete', 'not_reviewed')), 0) AS pending_records,
        COALESCE(SUM(clearance_state = 'not_attended'), 0) AS not_attended_records,
        COALESCE(SUM(clearance_state = 'not_applicable'), 0) AS not_applicable_records
      FROM (${baseSql}) AS dashboard_records`);
    const countRow = countsResult.recordset?.[0] || {};
    const totalRecords = Number(countRow.total_records || 0);
    const statusCountField = ({ complete: 'completed_records', pending: 'pending_records', not_attended: 'not_attended_records',
      not_applicable: 'not_applicable_records' })[filters.status];
    const filteredRecords = statusCountField ? Number(countRow[statusCountField] || 0) : totalRecords;
    const totalPages = Math.max(1, Math.ceil(filteredRecords / CLEARANCE_DASHBOARD_PAGE_SIZE));
    filters.page = Math.min(filters.page, totalPages);
    const offset = (filters.page - 1) * CLEARANCE_DASHBOARD_PAGE_SIZE;
    const rowsRequest = bindClearanceDashboardFilters(pool.request(), queryFilters, currentPosition, { sqlAdapter: sql })
      .input('statusFilter', sql.NVarChar(30), filters.status)
      .input('rowLimit', sql.Int, CLEARANCE_DASHBOARD_PAGE_SIZE)
      .input('rowOffset', sql.Int, offset);
    const rowsResult = await rowsRequest.query(`SELECT dashboard_records.* FROM (${baseSql}) AS dashboard_records
      WHERE @statusFilter = 'all'
        OR (@statusFilter = 'pending' AND dashboard_records.clearance_state IN ('incomplete', 'not_reviewed'))
        OR dashboard_records.clearance_state = @statusFilter
      ORDER BY dashboard_records.school_year DESC, dashboard_records.annual_term_number,
        dashboard_records.last_name, dashboard_records.first_name, dashboard_records.student_id
      LIMIT @rowLimit OFFSET @rowOffset`);
    const statusCounts = {
      totalRecords,
      completed: Number(countRow.completed_records || 0),
      pending: Number(countRow.pending_records || 0),
      incomplete: Number(countRow.incomplete_records || 0),
      notReviewed: Number(countRow.not_reviewed_records || 0),
      notAttended: Number(countRow.not_attended_records || 0),
      notApplicable: Number(countRow.not_applicable_records || 0)
    };
    return {
      rows: rowsResult.recordset || [], terms,
      schoolYears: [...new Set(terms.map((term) => term.school_year).filter((year) => academicYearStart(year) !== null))],
      currentTerm: currentPosition ? terms.find((term) => term.id === currentPosition.academic_term_id) || {
        id: currentPosition.academic_term_id, school_year: currentPosition.school_year,
        term: currentCandidate.term, term_number: currentPosition.term_number, is_current: true
      } : null,
      usesDefaultTerm: !hasUserFilter && Boolean(currentPosition),
      needsTermSelection: !currentPosition && !hasUserFilter,
      filters: { ...filters, termId: filters.termId == null ? '' : String(filters.termId), schoolYear: filters.schoolYear || '' },
      counts: statusCounts,
      countsIgnoreStatusFilter: filters.status !== 'all',
      pagination: { page: filters.page, pageSize: CLEARANCE_DASHBOARD_PAGE_SIZE, totalRecords: filteredRecords,
        matchedRecords: totalRecords, totalPages, from: filteredRecords ? offset + 1 : 0,
        to: Math.min(offset + CLEARANCE_DASHBOARD_PAGE_SIZE, filteredRecords) }
    };
  }

  async function getStudentClearanceOverview(actorInput, studentInput) {
    const actorId = idValue(actorInput, 'user');
    const studentId = idValue(studentInput, 'student');
    const pool = await getPool();
    await requireStaff(pool.request(), actorId);
    const currentResult = await pool.request().query(`SELECT term.school_year, order_row.term_number
      FROM academic_terms AS term
      LEFT JOIN school_year_term_order AS order_row ON order_row.academic_term_id = term.id
      WHERE term.is_current = 1`);
    const currentPosition = resolveCurrentAcademicPosition(currentResult.recordset || []);
    const filters = { search: '', schoolYear: null, termId: null };
    const request = bindClearanceDashboardFilters(pool.request(), filters, currentPosition, { sqlAdapter: sql, studentId });
    const aggregate = await request.query(`SELECT COUNT(*) AS total_records,
        COALESCE(SUM(clearance_state = 'complete'), 0) AS completed_records,
        COALESCE(SUM(clearance_state = 'incomplete'), 0) AS incomplete_records,
        COALESCE(SUM(clearance_state = 'not_reviewed'), 0) AS not_reviewed_records,
        COALESCE(SUM(clearance_state IN ('incomplete', 'not_reviewed')), 0) AS pending_records,
        COALESCE(SUM(clearance_state = 'not_attended'), 0) AS not_attended_records,
        COALESCE(SUM(clearance_state = 'not_applicable'), 0) AS not_applicable_records
      FROM (${clearanceDashboardRecordsSql({ studentScoped: true })}) AS student_term_records`);
    const row = aggregate.recordset?.[0] || {};
    return { totalRecords: Number(row.total_records || 0), completed: Number(row.completed_records || 0),
      pending: Number(row.pending_records || 0),
      incomplete: Number(row.incomplete_records || 0), notReviewed: Number(row.not_reviewed_records || 0),
      notAttended: Number(row.not_attended_records || 0), notApplicable: Number(row.not_applicable_records || 0) };
  }

  async function getOwnStudentProgress(userInput) {
    const userId = idValue(userInput, 'account');
    const pool = await getPool();
    const result = await pool.request().input('userId', sql.Int, userId)
      .query(`SELECT student.id AS student_id FROM students AS student
        INNER JOIN users AS account ON account.id = student.user_id AND account.role = 'student' AND account.is_active = 1
        WHERE account.id = @userId`);
    const studentId = Number(result.recordset?.[0]?.student_id || 0);
    if (!studentId) return { terms: [] };
    const records = await pool.request().input('studentId', sql.Int, studentId)
      .query(`SELECT annual.school_year, annual.grade_level, term.term AS term_label,
          enrollment.annual_term_number, enrollment.term_scope_status, annual.entry_term_number,
          clearance.scope_status, clearance.template_id, clearance.version, clearance.attested_by,
          clearance.attested_at, clearance.inspected_on,
          COALESCE(SUM(item.applicability_status = 'required'), 0) AS requirement_count,
          COALESCE(SUM(item.applicability_status = 'required' AND item.signature_present = 1
            AND item.signer_name IS NOT NULL AND TRIM(item.signer_name) <> ''), 0) AS signed_count,
          COALESCE(SUM(item.category = 'teacher'), 0) AS teacher_count,
          COALESCE(SUM(item.category = 'registrar'), 0) AS registrar_count,
          COALESCE(SUM(item.category = 'guidance'), 0) AS guidance_count,
          COALESCE(SUM(item.category = 'finance'), 0) AS finance_count,
          COALESCE(SUM(item.applicability_status = 'required'
            AND (item.signature_present = 0 OR item.signer_name IS NULL OR TRIM(item.signer_name) = '')), 0) AS required_unsigned_count,
          COALESCE(SUM(item.applicability_status = 'unreviewed'), 0) AS unresolved_count,
          COALESCE(SUM(item.category = 'teacher' AND item.signature_present = 1
            AND item.teacher_context_status <> 'assigned'
            AND (item.signer_context_reason IS NULL OR CHAR_LENGTH(TRIM(item.signer_context_reason)) < 5)), 0) AS teacher_context_missing_count
        FROM enrollments AS enrollment
        INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN student_term_clearances AS clearance ON clearance.enrollment_id = enrollment.id
        LEFT JOIN student_term_clearance_items AS item ON item.clearance_id = clearance.id
        WHERE enrollment.student_id = @studentId
        GROUP BY annual.id, annual.school_year, annual.grade_level, term.term, enrollment.annual_term_number,
          enrollment.term_scope_status, annual.entry_term_number, clearance.scope_status, clearance.template_id,
          clearance.version, clearance.attested_by, clearance.attested_at, clearance.inspected_on
        ORDER BY annual.school_year DESC, annual.id DESC, enrollment.annual_term_number`);
    const currentRows = (await pool.request().query(`SELECT term.school_year, order_row.term_number
      FROM academic_terms AS term LEFT JOIN school_year_term_order AS order_row ON order_row.academic_term_id = term.id
      WHERE term.is_current = 1`)).recordset || [];
    const currentPosition = resolveCurrentAcademicPosition(currentRows);
    return { terms: (records.recordset || []).map((row) => {
      const beforeEntry = Number(row.annual_term_number) < Number(row.entry_term_number);
      const future = isFutureAcademicTerm(currentPosition, row.school_year, row.annual_term_number) === true;
      const complete = completeFromCounts(row);
      return { schoolYear: row.school_year, gradeLevel: row.grade_level,
        term: row.term_label, termNumber: row.annual_term_number == null ? null : Number(row.annual_term_number),
        status: beforeEntry || future ? 'not_applicable'
          : row.scope_status === 'not_attended' ? 'not_attended' : complete ? 'complete'
            : 'pending' };
    }) };
  }

  return { createTemplateVersion, listTemplates, createTermClearance, updateTermClearance,
    getStudentClearance, getClearanceDashboard, getStudentClearanceOverview,
    getAnnualPrerequisiteReview, assertAnnualEntryPrerequisitesInTransaction,
    getTermActivationReview, assertTermPrerequisitesInTransaction, getContinuitySourceOptions,
    bindContinuitySource, getOwnStudentProgress };
}

module.exports = { TermClearanceError, createTermClearanceService, cleanTemplateInput, cleanReconciliation,
  cleanItemUpdates, completeFromCounts, awaitingRegistrarConfirmation, clearanceEventSummary, isPastAcademicTerm,
  normalizeClearanceDashboardFilters, resolveCurrentAcademicPosition };
