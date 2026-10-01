const crypto = require('node:crypto');
const path = require('node:path');
const defaultEnvironment = require('../config/environment');
const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');
const readExcelFile = require('read-excel-file/node').default;

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const SCHOOL_YEAR = '2026-2027';
const GRADE_PERIODS = [
  { label: 'Term 1', key: 'term1', column: 4 },
  { label: 'Term 2', key: 'term2', column: 5 },
  { label: 'Term 3', key: 'term3', column: 6 },
  { label: 'Final Grade', key: 'final', column: 7 }
];
const REQUIRED_SHEETS = ['INSTRUCTIONS', 'INPUT DATA', 'Term 1', 'Term 2', 'Term 3', 'FINAL GRADES', 'HELPER'];

class GradeImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'GradeImportError';
    this.status = status;
  }
}

function textCell(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function normalizeContext(value) {
  return textCell(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizeGradeLevel(value) {
  return normalizeContext(textCell(value).replace(/^(?:grade|g)\s*/i, ''));
}

function normalizePersonName(value) {
  const text = textCell(value);
  if (text.includes(',')) {
    const [lastName, ...givenNames] = text.split(',');
    return normalizeContext(`${givenNames.join(' ')} ${lastName}`);
  }
  return normalizeContext(text);
}

function parseLrn(value) {
  const lrn = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : textCell(value);
  return /^\d{12}$/.test(lrn) ? lrn : null;
}

function parseCachedGrade(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' ? String(value) : textCell(value);
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(text)) {
    throw new GradeImportError(`${label} contains an invalid cached grade.`);
  }
  const grade = Number(text);
  if (!Number.isFinite(grade) || grade < 0 || grade > 100) {
    throw new GradeImportError(`${label} contains a grade outside 0–100.`);
  }
  return grade;
}

function cell(sheet, row, column) {
  return sheet[row]?.[column] ?? null;
}

function validateWorkbookContext(input, finalGrades) {
  const yearStart = textCell(cell(input, 15, 5));
  const schoolYear = textCell(cell(finalGrades, 5, 8));
  const version = textCell(cell(input, 63, 19));
  const title = textCell(cell(input, 2, 3));
  const finalTitle = textCell(cell(finalGrades, 1, 1));
  const finalSubtitle = textCell(cell(finalGrades, 2, 1));
  const normalizedYear = schoolYear.replace(/\s+/g, '');
  if (title !== 'Input Data Sheet for Electronic-Class Record (ECR)'
    || finalTitle !== 'FINAL GRADES'
    || finalSubtitle !== 'Strengthened Senior High School Class Record'
    || version !== '2026_v1.0'
    || yearStart !== '2026'
    || !/^2026[–-]2027$/.test(normalizedYear)) {
    throw new GradeImportError('Upload the corrected SSHS E-Class Record for SY 2026–2027. Recalculate and save it in Excel before upload.');
  }

  const gradeLevel = textCell(cell(finalGrades, 8, 3));
  const sectionName = textCell(cell(finalGrades, 9, 3));
  const subjectName = textCell(cell(finalGrades, 8, 6));
  if (!gradeLevel || !sectionName || !subjectName || gradeLevel === '0' || subjectName === '0') {
    throw new GradeImportError('The workbook must have a grade level, section, and subject in its FINAL GRADES context.');
  }
  if (textCell(cell(input, 9, 13)) !== 'LRN' || textCell(cell(input, 9, 17)) !== 'LRN'
    || textCell(cell(finalGrades, 14, 4)).toUpperCase().trim() !== 'FIRST TERM'
    || textCell(cell(finalGrades, 14, 5)).toUpperCase().trim() !== 'SECOND TERM'
    || textCell(cell(finalGrades, 14, 6)).toUpperCase().trim() !== 'THIRD TERM') {
    throw new GradeImportError('The workbook does not match the corrected SSHS grade-import layout.');
  }
  return { schoolYear: SCHOOL_YEAR, gradeLevel, sectionName, subjectName };
}

function parseWorkbookRows(input, finalGrades) {
  const rows = [];
  for (const group of [
    { inputLrnColumn: 13, inputNameColumn: 14, finalStart: 16 },
    { inputLrnColumn: 17, inputNameColumn: 18, finalStart: 67 }
  ]) {
    for (let offset = 0; offset < 50; offset += 1) {
      const finalRow = group.finalStart + offset;
      const inputRow = 10 + offset;
      const lrnValue = cell(input, inputRow, group.inputLrnColumn);
      const inputName = textCell(cell(input, inputRow, group.inputNameColumn));
      const cachedLrn = cell(finalGrades, finalRow, 2);
      const cachedName = textCell(cell(finalGrades, finalRow, 3));
      const issue = [];
      const grades = GRADE_PERIODS.map(({ label, column }) => {
        try {
          return { gradingPeriod: label, gradeValue: parseCachedGrade(cell(finalGrades, finalRow, column), label) };
        } catch (error) {
          issue.push(error.message);
          return { gradingPeriod: label, gradeValue: null };
        }
      });
      if (lrnValue === null && !inputName && !cachedName && !grades.some(({ gradeValue }) => gradeValue !== null)) continue;

      const lrn = parseLrn(lrnValue);
      if (!lrn) issue.push('Missing or invalid 12-digit LRN.');
      if (!inputName) issue.push('Learner name is missing.');
      if (cachedLrn !== null && parseLrn(cachedLrn) !== lrn) issue.push('Cached learner number does not match INPUT DATA. Recalculate and save the workbook.');
      if (cachedName && inputName && normalizePersonName(cachedName) !== normalizePersonName(inputName)) {
        issue.push('Cached learner name does not match INPUT DATA. Recalculate and save the workbook.');
      }
      if (grades.some(({ gradeValue }) => gradeValue === null)) issue.push('This learner is missing one or more cached Term 1–3 or Final Grade values. Recalculate and save the workbook.');
      rows.push({
        sourceRow: finalRow + 1,
        lrn,
        workbookName: inputName || cachedName || '',
        grades,
        issue: issue.join(' ')
      });
    }
  }
  if (!rows.length) throw new GradeImportError('No learner rows were found in the workbook.');
  if (!rows.some(({ grades }) => grades.some(({ gradeValue }) => gradeValue !== null))) {
    throw new GradeImportError('No cached term or final grades were found. Open the workbook in Excel, recalculate, and save it before upload.');
  }
  const lrnRows = new Map();
  for (const row of rows) {
    if (!row.lrn) continue;
    const matches = lrnRows.get(row.lrn) || [];
    matches.push(row);
    lrnRows.set(row.lrn, matches);
  }
  for (const matches of lrnRows.values()) {
    if (matches.length > 1) for (const row of matches) row.issue = [row.issue, 'LRN appears more than once in this workbook.'].filter(Boolean).join(' ');
  }
  return rows;
}

function digestLrn(secret, lrn) {
  return crypto.createHmac('sha256', secret).update(lrn).digest('hex');
}

function digestSession(secret, sessionId) {
  return crypto.createHmac('sha256', secret).update(`grade-import-session:${sessionId}`).digest('hex');
}

function numericGrade(value) {
  return value === null || value === undefined ? null : Number(value);
}

function sameGrade(left, right) {
  if (!left || !right) return left === right;
  return left.id === right.id && numericGrade(left.value) === numericGrade(right.value);
}

function gradeValuesEqual(left, right) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Number(left) === Number(right);
}

function createGradeImportService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  secret = defaultEnvironment.sessionSecret,
  now = () => Date.now()
} = {}) {
  async function requireRegistrar(request, actorId) {
    const actor = await request.input('actorId', sql.Int, actorId)
      .input('registrarRole', sql.NVarChar(30), 'registrar')
      .query('SELECT id, role FROM users WHERE id = @actorId AND is_active = 1 AND role = @registrarRole FOR UPDATE');
    if (!actor.recordset?.length) throw new GradeImportError('Registrar grade-import access is no longer active. Sign in again.', 403);
    return actor.recordset[0];
  }

  async function requireImporter(request, actorId) {
    const actor = await request.input('actorId', sql.Int, actorId)
      .query('SELECT id, role FROM users WHERE id = @actorId AND is_active = 1 AND role IN (\'registrar\', \'teacher\') FOR UPDATE');
    if (!actor.recordset?.length) throw new GradeImportError('Grade-import access is no longer active. Sign in again.', 403);
    return actor.recordset[0];
  }

  async function removeExpired(pool) {
    await pool.request().query('DELETE FROM grade_import_previews WHERE expires_at <= UTC_TIMESTAMP(3)');
  }

  async function listImportContexts(actorId) {
    const pool = await getPool();
    await removeExpired(pool);
    const actor = await requireImporter(pool.request(), actorId);
    const result = await pool.request()
      .input('schoolYear', sql.NVarChar(20), SCHOOL_YEAR)
      .input('actorId', sql.Int, actor.id)
      .input('actorRole', sql.NVarChar(30), actor.role)
      .query(`SELECT DISTINCT term.school_year, term.id AS academic_term_id, term.term,
          sec.grade_level, sec.name AS section_name,
          sub.id AS subject_id, sub.subject_code, sub.subject_name
        FROM academic_terms AS term
        INNER JOIN sections AS sec ON sec.academic_term_id = term.id
        INNER JOIN subjects AS sub ON 1 = 1
        WHERE term.school_year = @schoolYear AND (
          (@actorRole = 'registrar' AND EXISTS (
            SELECT 1 FROM enrollments AS e
            INNER JOIN students AS st ON st.id = e.student_id AND st.status = 'active'
            INNER JOIN student_subjects AS ss ON ss.enrollment_id = e.id AND ss.subject_id = sub.id
            WHERE e.academic_term_id = term.id AND e.section_id = sec.id AND e.enrollment_status = 'enrolled'))
          OR EXISTS (
            SELECT 1 FROM teacher_assignments AS ta
            WHERE ta.teacher_id = @actorId AND ta.is_active = 1 AND ta.academic_term_id = term.id
              AND ta.section_id = sec.id AND ta.subject_id = sub.id AND @actorRole = 'teacher'))
          AND EXISTS (SELECT 1 FROM users AS current_actor WHERE current_actor.id = @actorId
            AND current_actor.is_active = 1 AND current_actor.role = @actorRole)
        ORDER BY sec.grade_level, sec.name, sub.subject_code`);
    return (result.recordset || []).map((context) => ({
      ...context,
      key: crypto.createHash('sha256').update(JSON.stringify([
        context.academic_term_id ?? null, context.school_year, context.grade_level, context.section_name, context.subject_id
      ])).digest('hex')
    }));
  }

  async function createPreview({ actorId, sessionId, buffer, contextKey, originalFilename = null }) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > 5 * 1024 * 1024) {
      throw new GradeImportError('Choose an XLSX workbook no larger than 5 MB.');
    }
    let storedOriginalFilename = null;
    if (originalFilename !== null && originalFilename !== undefined) {
      if (typeof originalFilename !== 'string') throw new GradeImportError('The workbook filename is invalid.');
      storedOriginalFilename = path.basename(originalFilename.replaceAll('\\', '/'))
        .replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (!storedOriginalFilename || storedOriginalFilename.length > 255
        || path.extname(storedOriginalFilename).toLowerCase() !== '.xlsx') {
        throw new GradeImportError('The workbook filename must end in .xlsx and be 255 characters or fewer.');
      }
    }
    let workbook;
    try {
      workbook = await readExcelFile(buffer);
    } catch {
      throw new GradeImportError('The workbook could not be read. Upload a valid corrected SSHS XLSX file.');
    }
    const sheetMap = new Map(workbook.map(({ sheet, data }) => [sheet, data]));
    if (REQUIRED_SHEETS.some((name) => !sheetMap.has(name))) {
      throw new GradeImportError('The workbook is missing one or more corrected SSHS E-Class Record sheets.');
    }
    const input = sheetMap.get('INPUT DATA');
    const finalGrades = sheetMap.get('FINAL GRADES');
    const workbookContext = validateWorkbookContext(input, finalGrades);
    const rows = parseWorkbookRows(input, finalGrades);
    const pool = await getPool();
    await removeExpired(pool);
    const actor = await requireImporter(pool.request(), actorId);
    const availableContexts = await listImportContexts(actor.id);
    const selected = availableContexts.find(({ key }) => key === contextKey);
    if (!selected) throw new GradeImportError('Choose an existing school-year, section, grade-level, and subject context.');
    const subject = { id: selected.subject_id, subject_name: selected.subject_name };
    const context = {
      academicTermId: selected.academic_term_id ?? null,
      schoolYear: selected.school_year,
      gradeLevel: selected.grade_level,
      sectionName: selected.section_name,
      subjectName: selected.subject_name
    };
    const contextMismatch = normalizeGradeLevel(workbookContext.gradeLevel) !== normalizeGradeLevel(context.gradeLevel)
      || normalizeContext(workbookContext.sectionName) !== normalizeContext(context.sectionName)
      || normalizeContext(workbookContext.subjectName) !== normalizeContext(context.subjectName);
    const contextIssue = contextMismatch
      ? `Workbook context (${workbookContext.gradeLevel} · ${workbookContext.sectionName} · ${workbookContext.subjectName}) does not match the selected existing context (${context.gradeLevel} · ${context.sectionName} · ${context.subjectName}). Correct the roster or workbook and upload again.`
      : null;
    const validLrns = [...new Set(rows.filter((row) => row.lrn).map(({ lrn }) => lrn))];
    const studentRows = [];
    if (validLrns.length) {
      const request = pool.request()
        .input('subjectId', sql.Int, subject.id)
        .input('schoolYear', sql.NVarChar(20), context.schoolYear)
        .input('academicTermId', sql.Int, context.academicTermId)
        .input('teacherId', sql.Int, actor.role === 'teacher' ? actor.id : null);
      const parameters = validLrns.map((lrn, index) => {
        const name = `lrn${index}`;
        request.input(name, sql.NVarChar(12), lrn);
        return `@${name}`;
      });
      const result = await request.query(`SELECT st.id AS student_id, st.lrn, st.student_no,
          st.first_name, st.middle_name, st.last_name, st.suffix, st.status AS student_status,
          e.id AS enrollment_id, e.enrollment_status, e.school_year, e.section_name, e.grade_level,
          ss.id AS student_subject_id, g.id AS grade_id, g.grading_period, g.grade_value
        FROM students AS st
        LEFT JOIN (
          SELECT en.id, en.student_id, en.enrollment_status, term.school_year,
            sec.name AS section_name, sec.grade_level, en.academic_term_id, en.section_id
          FROM enrollments AS en
          INNER JOIN academic_terms AS term ON term.id = en.academic_term_id
          LEFT JOIN sections AS sec ON sec.id = en.section_id AND sec.academic_term_id = en.academic_term_id
          WHERE term.school_year = @schoolYear
            AND (@academicTermId IS NULL OR en.academic_term_id = @academicTermId)
        ) AS e ON e.student_id = st.id
        LEFT JOIN student_subjects AS ss ON ss.enrollment_id = e.id AND ss.subject_id = @subjectId
        LEFT JOIN grades AS g ON g.student_subject_id = ss.id
          AND g.grading_period IN ('Term 1', 'Term 2', 'Term 3', 'Final Grade')
        WHERE st.lrn IN (${parameters.join(', ')})
          AND (@teacherId IS NULL OR (
            EXISTS (SELECT 1 FROM users AS active_teacher WHERE active_teacher.id = @teacherId
              AND active_teacher.role = 'teacher' AND active_teacher.is_active = 1)
            AND EXISTS (
              SELECT 1 FROM teacher_assignments AS teacher_assignment
              WHERE teacher_assignment.teacher_id = @teacherId AND teacher_assignment.is_active = 1
                AND teacher_assignment.academic_term_id = e.academic_term_id
                AND teacher_assignment.section_id = e.section_id AND teacher_assignment.subject_id = @subjectId)))`);
      studentRows.push(...(result.recordset || []));
    }
    const recordsByLrn = new Map();
    for (const record of studentRows) {
      const list = recordsByLrn.get(record.lrn) || [];
      list.push(record);
      recordsByLrn.set(record.lrn, list);
    }
    for (const row of rows) {
      if (!row.lrn) continue;
      const sourceIssue = row.issue;
      const records = recordsByLrn.get(row.lrn) || [];
      const first = records[0];
      if (!first || first.student_status !== 'active') {
        row.issue = sourceIssue || 'No active student matched this LRN.';
        continue;
      }
      row.studentId = first.student_id;
      row.studentNo = first.student_no;
      row.studentName = [first.first_name, first.middle_name, first.last_name, first.suffix].filter(Boolean).join(' ');
      row.lrnFingerprint = digestLrn(secret, row.lrn);
      row.nameMismatch = normalizePersonName(row.workbookName) !== normalizePersonName(row.studentName);
      const candidatesByAssignment = new Map();
      for (const record of records.filter((candidate) => candidate.enrollment_id
        && candidate.enrollment_status === 'enrolled'
        && normalizeContext(candidate.section_name) === normalizeContext(context.sectionName)
        && normalizeGradeLevel(candidate.grade_level) === normalizeGradeLevel(context.gradeLevel))) {
        candidatesByAssignment.set(`${record.enrollment_id}:${record.student_subject_id || ''}`, record);
      }
      const candidates = [...candidatesByAssignment.values()];
      if (candidates.length !== 1) {
        row.issue = sourceIssue || contextIssue || (candidates.length ? 'More than one enrollment matches this school year, section, and grade level.'
          : 'No active enrollment matches this school year, section, and grade level.');
        continue;
      }
      const candidate = candidates[0];
      if (!candidate.student_subject_id) {
        row.issue = sourceIssue || contextIssue || 'The matching enrollment does not have this subject assigned.';
        continue;
      }
      row.studentSubjectId = candidate.student_subject_id;
      row.enrollmentId = candidate.enrollment_id;
      row.existingGrades = {};
      for (const record of records) {
        if (record.enrollment_id !== candidate.enrollment_id || !record.grading_period) continue;
        row.existingGrades[record.grading_period] = { id: record.grade_id, value: record.grade_value };
      }
      row.issue = sourceIssue || contextIssue || null;
    }

    const previewId = crypto.randomUUID();
    const expiresAt = new Date(now() + PREVIEW_TTL_MS);
    const fingerprint = digestSession(secret, sessionId);
    const transaction = transactionFactory(pool);
    let started = false;
    try {
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      const currentActor = await requireImporter(transaction.request(), actor.id);
      if (currentActor.role === 'teacher') {
        const assignment = await transaction.request()
          .input('teacherId', sql.Int, currentActor.id)
          .input('academicTermId', sql.Int, context.academicTermId)
          .input('schoolYear', sql.NVarChar(20), context.schoolYear)
          .input('sectionName', sql.NVarChar(100), context.sectionName)
          .input('gradeLevel', sql.NVarChar(50), context.gradeLevel)
          .input('subjectId', sql.Int, subject.id)
          .query(`SELECT a.id FROM teacher_assignments AS a
            INNER JOIN academic_terms AS term ON term.id = a.academic_term_id
            INNER JOIN sections AS sec ON sec.id = a.section_id AND sec.academic_term_id = a.academic_term_id
            INNER JOIN subjects AS sub ON sub.id = a.subject_id
            WHERE a.teacher_id = @teacherId AND a.is_active = 1
              AND a.academic_term_id = @academicTermId AND a.subject_id = @subjectId
              AND term.school_year = @schoolYear AND sec.name = @sectionName AND sec.grade_level = @gradeLevel FOR UPDATE`);
        if (!assignment.recordset?.length) {
          throw new GradeImportError('This class is no longer assigned to your account. Upload the workbook again.', 403);
        }
      }
      await transaction.request()
        .input('previewId', sql.UniqueIdentifier, previewId)
        .input('actorId', sql.Int, actor.id)
        .input('sessionFingerprint', sql.Char(64), fingerprint)
        .input('schoolYear', sql.NVarChar(20), context.schoolYear)
        .input('academicTermId', sql.Int, context.academicTermId)
        .input('gradeLevel', sql.NVarChar(50), context.gradeLevel)
        .input('sectionName', sql.NVarChar(100), context.sectionName)
        .input('subjectId', sql.Int, subject.id)
        .input('subjectName', sql.NVarChar(200), subject.subject_name)
        .input('originalFilename', sql.NVarChar(255), storedOriginalFilename)
        .input('workbookGradeLevel', sql.NVarChar(50), workbookContext.gradeLevel)
        .input('workbookSectionName', sql.NVarChar(100), workbookContext.sectionName)
        .input('workbookSubjectName', sql.NVarChar(200), workbookContext.subjectName)
        .input('contextMismatch', sql.Bit, contextMismatch)
        .input('expiresAt', sql.DateTime2, expiresAt)
        .query(`INSERT INTO grade_import_previews
          (id, uploaded_by, session_fingerprint, school_year, grade_level, section_name, subject_id, subject_name,
            academic_term_id, original_filename,
            workbook_grade_level, workbook_section_name, workbook_subject_name, context_mismatch, expires_at)
          VALUES (@previewId, @actorId, @sessionFingerprint, @schoolYear, @gradeLevel, @sectionName, @subjectId, @subjectName,
            @academicTermId, @originalFilename,
            @workbookGradeLevel, @workbookSectionName, @workbookSubjectName, @contextMismatch, @expiresAt)`);
      for (const row of rows) {
        const inserted = await transaction.request()
          .input('previewId', sql.UniqueIdentifier, previewId)
          .input('sourceRow', sql.Int, row.sourceRow)
          .input('studentId', sql.Int, row.studentId || null)
          .input('enrollmentId', sql.Int, row.enrollmentId || null)
          .input('studentSubjectId', sql.Int, row.studentSubjectId || null)
          .input('studentNo', sql.NVarChar(50), row.studentNo || null)
          .input('workbookName', sql.NVarChar(200), row.workbookName || null)
          .input('studentName', sql.NVarChar(200), row.studentName || null)
          .input('lrnFingerprint', sql.Char(64), row.lrnFingerprint || null)
          .input('nameMismatch', sql.Bit, Boolean(row.nameMismatch))
          .input('issue', sql.NVarChar(500), row.issue || null)
          .query(`INSERT INTO grade_import_preview_rows
            (preview_id, source_row, student_id, enrollment_id, student_subject_id, student_no, workbook_name, student_name, lrn_fingerprint, name_mismatch, issue)
            VALUES (@previewId, @sourceRow, @studentId, @enrollmentId, @studentSubjectId, @studentNo, @workbookName, @studentName, @lrnFingerprint, @nameMismatch, @issue)`);
        const previewRowId = inserted.insertId;
        if (!previewRowId) throw new Error('Grade preview row insert returned no identifier.');
        for (const grade of row.grades) {
          if (grade.gradeValue === null) continue;
          const existing = row.existingGrades?.[grade.gradingPeriod] || null;
          await transaction.request()
            .input('previewRowId', sql.BigInt, previewRowId)
            .input('gradingPeriod', sql.NVarChar(50), grade.gradingPeriod)
            .input('gradeValue', sql.Decimal(6, 2), grade.gradeValue)
            .input('existingGradeId', sql.Int, existing?.id || null)
            .input('existingGradeValue', sql.Decimal(6, 2), existing?.value ?? null)
            .query(`INSERT INTO grade_import_preview_grades
              (preview_row_id, grading_period, grade_value, existing_grade_id, existing_grade_value)
              VALUES (@previewRowId, @gradingPeriod, @gradeValue, @existingGradeId, @existingGradeValue)`);
        }
      }
      await transaction.commit();
      started = false;
    } catch (error) {
      if (started) await transaction.rollback().catch(() => {});
      if (error instanceof GradeImportError) throw error;
      throw error;
    }
    return getPreview({ actorId: actor.id, sessionId, previewId });
  }

  async function getPreview({ actorId, sessionId, previewId }) {
    const pool = await getPool();
    await removeExpired(pool);
    const actor = await requireImporter(pool.request(), actorId);
    const result = await pool.request()
      .input('previewId', sql.UniqueIdentifier, previewId)
      .input('actorId', sql.Int, actorId)
      .input('actorRole', sql.NVarChar(30), actor.role)
      .input('sessionFingerprint', sql.Char(64), digestSession(secret, sessionId))
      .query(`SELECT p.id, p.academic_term_id, p.original_filename, term.term, p.school_year, p.grade_level, p.section_name, p.subject_name,
          p.workbook_grade_level, p.workbook_section_name, p.workbook_subject_name, p.context_mismatch, p.expires_at,
          r.id AS preview_row_id, r.source_row, r.student_id, r.enrollment_id, r.student_subject_id, r.student_no,
          r.workbook_name, r.student_name, r.name_mismatch, r.issue,
          g.grading_period, g.grade_value, g.existing_grade_id, g.existing_grade_value
        FROM grade_import_previews AS p
        LEFT JOIN academic_terms AS term ON term.id = p.academic_term_id
        LEFT JOIN grade_import_preview_rows AS r ON r.preview_id = p.id
        LEFT JOIN grade_import_preview_grades AS g ON g.preview_row_id = r.id
        WHERE p.id = @previewId AND p.uploaded_by = @actorId
          AND p.session_fingerprint = @sessionFingerprint AND p.status = 'ready'
          AND p.expires_at > UTC_TIMESTAMP(3)
          AND EXISTS (SELECT 1 FROM users AS current_actor WHERE current_actor.id = @actorId
            AND current_actor.is_active = 1 AND current_actor.role = @actorRole)
          AND (@actorRole = 'registrar' OR EXISTS (
            SELECT 1 FROM teacher_assignments AS ta
            INNER JOIN academic_terms AS assigned_term ON assigned_term.id = ta.academic_term_id
            INNER JOIN sections AS assigned_section ON assigned_section.id = ta.section_id
              AND assigned_section.academic_term_id = ta.academic_term_id
            WHERE ta.teacher_id = @actorId AND ta.is_active = 1
              AND ta.academic_term_id = p.academic_term_id AND ta.subject_id = p.subject_id
              AND assigned_term.school_year = p.school_year AND assigned_section.grade_level = p.grade_level
              AND assigned_section.name = p.section_name))
        ORDER BY r.source_row, g.id`);
    if (!result.recordset?.length) throw new GradeImportError('This grade preview has expired or is no longer available. Upload the workbook again.', 404);
    const header = result.recordset[0];
    const rowMap = new Map();
    for (const record of result.recordset) {
      if (!record.preview_row_id) continue;
      let row = rowMap.get(record.preview_row_id);
      if (!row) {
        row = {
          id: record.preview_row_id,
          sourceRow: record.source_row,
          studentId: record.student_id,
          enrollmentId: record.enrollment_id,
          studentSubjectId: record.student_subject_id,
          studentNo: record.student_no,
          workbookName: record.workbook_name,
          studentName: record.student_name,
          nameMismatch: Boolean(record.name_mismatch),
          issue: record.issue,
          grades: []
        };
        rowMap.set(record.preview_row_id, row);
      }
      if (record.grading_period) row.grades.push({
        gradingPeriod: record.grading_period,
        gradeValue: record.grade_value,
        existingGradeId: record.existing_grade_id,
        existingGradeValue: record.existing_grade_value
      });
    }
    const rows = [...rowMap.values()].map((row) => {
      const gradesByPeriod = new Map(row.grades.map((grade) => [grade.gradingPeriod, grade]));
      return {
        ...row,
        grades: GRADE_PERIODS.map(({ label }) => gradesByPeriod.get(label) || {
          gradingPeriod: label,
          gradeValue: null,
          existingGradeId: null,
          existingGradeValue: null
        })
      };
    });
    return {
      id: header.id,
      academicTermId: header.academic_term_id,
      originalFilename: header.original_filename,
      term: header.term,
      schoolYear: header.school_year,
      gradeLevel: header.grade_level,
      sectionName: header.section_name,
      subjectName: header.subject_name,
      workbookGradeLevel: header.workbook_grade_level,
      workbookSectionName: header.workbook_section_name,
      workbookSubjectName: header.workbook_subject_name,
      contextMismatch: Boolean(header.context_mismatch),
      expiresAt: header.expires_at,
      rows,
      counts: {
        rows: rows.length,
        eligible: rows.filter((row) => !row.issue && row.studentId).length,
        unresolved: rows.filter((row) => Boolean(row.issue)).length,
        conflicts: rows.reduce((count, row) => count + row.grades.filter((grade) => grade.existingGradeId
          && !gradeValuesEqual(grade.gradeValue, grade.existingGradeValue)).length, 0)
      }
    };
  }

  function validateReason(value, label) {
    const reason = typeof value === 'string' ? value.trim() : '';
    if (reason.length < 5 || reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
      throw new GradeImportError(`${label} must be 5–500 printable characters.`);
    }
    return reason;
  }

  async function confirmPreview({ actorId, sessionId, previewId, submissionId, decisions = [] }) {
    if (!Array.isArray(decisions)) throw new GradeImportError('The grade confirmation choices are invalid.');
    if (submissionId && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(submissionId)) {
      throw new GradeImportError('Grade submission not found.', 404);
    }
    const pool = await getPool();
    await removeExpired(pool);
    const transaction = transactionFactory(pool);
    let started = false;
    try {
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      const actor = await requireRegistrar(transaction.request(), actorId);
      const headerRequest = transaction.request().input('actorId', sql.Int, actor.id);
      if (submissionId) headerRequest.input('submissionId', sql.UniqueIdentifier, submissionId);
      else headerRequest.input('previewId', sql.UniqueIdentifier, previewId)
        .input('sessionFingerprint', sql.Char(64), digestSession(secret, sessionId));
      const headerResult = await headerRequest.query(submissionId
        ? `SELECT s.id, a.academic_term_id, s.school_year, s.grade_level, s.section_name, s.subject_id, s.subject_name, s.context_mismatch
          FROM teacher_grade_submissions AS s
          INNER JOIN teacher_assignments AS a ON a.id = s.assignment_id
          WHERE s.id = @submissionId AND s.status = 'pending' AND a.is_active = 1
            AND a.teacher_id = s.submitted_by
            AND EXISTS (SELECT 1 FROM users AS submitter WHERE submitter.id = s.submitted_by
              AND submitter.role = 'teacher') FOR UPDATE`
        : `SELECT id, academic_term_id, school_year, grade_level, section_name, subject_id, subject_name, context_mismatch
          FROM grade_import_previews
          WHERE id = @previewId AND uploaded_by = @actorId
            AND session_fingerprint = @sessionFingerprint AND status = 'ready'
            AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE`);
      const header = headerResult.recordset?.[0];
      if (!header) throw new GradeImportError(submissionId
        ? 'This submission has already been reviewed or its teacher assignment is no longer valid.'
        : 'This grade preview has expired or was already confirmed.', 409);
      if (header.context_mismatch) {
        throw new GradeImportError('The workbook context differs from the selected enrollment context. Correct the roster or workbook, then upload it again.', 409);
      }
      const previewRowsRequest = transaction.request();
      if (submissionId) previewRowsRequest.input('submissionId', sql.UniqueIdentifier, submissionId);
      else previewRowsRequest.input('previewId', sql.UniqueIdentifier, previewId);
      const previewRowsResult = await previewRowsRequest.query(submissionId
        ? `SELECT r.id, r.source_row, r.student_id, r.enrollment_id, r.student_subject_id, r.student_no,
            r.workbook_name, r.student_name, r.lrn_fingerprint, r.name_mismatch, r.issue,
            g.grading_period, g.grade_value, g.existing_grade_id, g.existing_grade_value
          FROM teacher_grade_submission_rows AS r
          LEFT JOIN teacher_grade_submission_grades AS g ON g.submission_row_id = r.id
          WHERE r.submission_id = @submissionId ORDER BY r.source_row, g.id FOR UPDATE`
        : `SELECT r.id, r.source_row, r.student_id, r.enrollment_id, r.student_subject_id, r.student_no,
            r.workbook_name, r.student_name, r.lrn_fingerprint, r.name_mismatch, r.issue,
            g.grading_period, g.grade_value, g.existing_grade_id, g.existing_grade_value
          FROM grade_import_preview_rows AS r
          LEFT JOIN grade_import_preview_grades AS g ON g.preview_row_id = r.id
          WHERE r.preview_id = @previewId ORDER BY r.source_row, g.id FOR UPDATE`);
      const rowMap = new Map();
      for (const record of previewRowsResult.recordset || []) {
        let row = rowMap.get(record.id);
        if (!row) {
          row = { ...record, grades: [] };
          rowMap.set(record.id, row);
        }
        if (record.grading_period) row.grades.push({
          gradingPeriod: record.grading_period,
          gradeValue: record.grade_value,
          existingGradeId: record.existing_grade_id,
          existingGradeValue: record.existing_grade_value
        });
      }
      const candidateRows = [...rowMap.values()].filter((row) => !row.issue && row.student_id && row.student_subject_id);
      const decisionsBySourceRow = new Map(decisions.map((decision) => [decision.sourceRow, decision]));
      const acceptedRows = [];
      const decisionAudit = [];
      let excludedRows = [...rowMap.values()].filter((row) => row.issue || !row.student_id || !row.student_subject_id).length;
      let skippedGrades = 0;
      let unchangedGrades = 0;
      for (const row of candidateRows) {
        const decision = decisionsBySourceRow.get(row.source_row) || {};
        if (decision.include !== true) {
          excludedRows += 1;
          continue;
        }
        const periodSet = new Set(row.grades.map(({ gradingPeriod }) => gradingPeriod));
        if (row.grades.length !== GRADE_PERIODS.length
          || GRADE_PERIODS.some(({ label }) => !periodSet.has(label))
          || row.grades.some(({ gradeValue }) => gradeValue === null || gradeValue === undefined
            || gradeValue === '' || !Number.isFinite(Number(gradeValue)) || Number(gradeValue) < 0 || Number(gradeValue) > 100)) {
          throw new GradeImportError('An included row does not contain four valid cached grades. Upload the workbook again.', 409);
        }
        if (row.name_mismatch) {
          if (!decision.allowNameMismatch) {
            excludedRows += 1;
            continue;
          }
          const reason = validateReason(decision.nameReason, 'Name-mismatch override reason');
          decisionAudit.push({ sourceRow: row.source_row, studentId: row.student_id, action: 'name_mismatch_override', reason });
        }
        const selectedGrades = [];
        for (const grade of row.grades) {
          if (!grade.existingGradeId) {
            selectedGrades.push({ ...grade, action: 'insert', reason: null });
            continue;
          }
          if (gradeValuesEqual(grade.gradeValue, grade.existingGradeValue)) {
            unchangedGrades += 1;
            selectedGrades.push({ ...grade, action: 'unchanged', reason: null });
            continue;
          }
          const gradeDecision = decision.grades?.[grade.gradingPeriod] || {};
          if (gradeDecision.action !== 'replace') {
            skippedGrades += 1;
            selectedGrades.push({ ...grade, action: 'skip', reason: null });
            continue;
          }
          const reason = validateReason(gradeDecision.reason, `${grade.gradingPeriod} replacement reason`);
          decisionAudit.push({ sourceRow: row.source_row, studentId: row.student_id, action: `${grade.gradingPeriod.toLowerCase().replaceAll(' ', '_')}_replaced`, reason });
          selectedGrades.push({ ...grade, action: 'replace', reason });
        }
        acceptedRows.push({ ...row, grades: selectedGrades });
      }

      if (submissionId && acceptedRows.length === 0) {
        throw new GradeImportError('Select at least one eligible learner row before approving this workbook.');
      }
      if (acceptedRows.length) {
        const request = transaction.request()
          .input('schoolYear', sql.NVarChar(20), header.school_year)
          .input('gradeLevel', sql.NVarChar(50), header.grade_level)
          .input('sectionName', sql.NVarChar(100), header.section_name)
          .input('academicTermId', sql.Int, header.academic_term_id ?? null)
          .input('subjectId', sql.Int, header.subject_id);
        const pairs = acceptedRows.map((row, index) => {
          request.input(`student${index}`, sql.Int, row.student_id)
            .input(`enrollment${index}`, sql.Int, row.enrollment_id)
            .input(`assignment${index}`, sql.Int, row.student_subject_id)
            .input(`lrnHash${index}`, sql.Char(64), row.lrn_fingerprint);
          return `(st.id = @student${index} AND e.id = @enrollment${index} AND ss.id = @assignment${index})`;
        });
        const currentResult = await request.query(`SELECT st.id AS student_id, st.lrn, st.student_no,
            st.first_name, st.middle_name, st.last_name, st.suffix, st.status AS student_status,
            e.id AS enrollment_id, e.enrollment_status, term.school_year, sec.name AS section_name,
            sec.grade_level, ss.id AS student_subject_id, sub.id AS subject_id, sub.subject_name,
            g.id AS grade_id, g.grading_period, g.grade_value
          FROM students AS st
          INNER JOIN enrollments AS e ON e.student_id = st.id
          INNER JOIN academic_terms AS term ON term.id = e.academic_term_id
          LEFT JOIN sections AS sec ON sec.id = e.section_id AND sec.academic_term_id = e.academic_term_id
          INNER JOIN student_subjects AS ss ON ss.enrollment_id = e.id
          INNER JOIN subjects AS sub ON sub.id = ss.subject_id
          LEFT JOIN grades AS g ON g.student_subject_id = ss.id
            AND g.grading_period IN ('Term 1', 'Term 2', 'Term 3', 'Final Grade')
          WHERE (${pairs.join(' OR ')}) AND (@academicTermId IS NULL OR e.academic_term_id = @academicTermId) FOR UPDATE`);
        const currentByAssignment = new Map();
        for (const current of currentResult.recordset || []) {
          const list = currentByAssignment.get(current.student_subject_id) || [];
          list.push(current);
          currentByAssignment.set(current.student_subject_id, list);
        }
        for (const row of acceptedRows) {
          const current = currentByAssignment.get(row.student_subject_id) || [];
          const identity = current[0];
          if (!identity || identity.student_id !== row.student_id || identity.student_status !== 'active'
            || identity.enrollment_id !== row.enrollment_id || identity.enrollment_status !== 'enrolled'
            || identity.school_year !== header.school_year || identity.subject_id !== header.subject_id
            || normalizeContext(identity.section_name) !== normalizeContext(header.section_name)
            || normalizeGradeLevel(identity.grade_level) !== normalizeGradeLevel(header.grade_level)
            || identity.student_no !== row.student_no
            || normalizePersonName([identity.first_name, identity.middle_name, identity.last_name, identity.suffix].filter(Boolean).join(' ')) !== normalizePersonName(row.student_name)
            || normalizeContext(identity.subject_name) !== normalizeContext(header.subject_name)
            || digestLrn(secret, parseLrn(identity.lrn) || '') !== row.lrn_fingerprint) {
            throw new GradeImportError('The learner or enrollment details changed after preview. Upload the workbook again.', 409);
          }
          const currentGrades = new Map();
          for (const record of current) if (record.grading_period) currentGrades.set(record.grading_period, { id: record.grade_id, value: record.grade_value });
          for (const grade of row.grades) {
            if (!sameGrade(currentGrades.get(grade.gradingPeriod) || null,
              grade.existingGradeId ? { id: grade.existingGradeId, value: grade.existingGradeValue } : null)) {
              throw new GradeImportError('A grade changed after preview. Upload the workbook again.', 409);
            }
          }
        }
      }

      let inserted = 0;
      let replaced = 0;
      for (const row of acceptedRows) {
        for (const grade of row.grades) {
          if (grade.action === 'skip' || grade.action === 'unchanged') continue;
          if (grade.action === 'replace') {
            await transaction.request()
              .input('gradeId', sql.Int, grade.existingGradeId)
              .input('gradeValue', sql.Decimal(6, 2), grade.gradeValue)
              .input('actorId', sql.Int, actor.id)
              .query(`UPDATE grades SET grade_value = @gradeValue, recorded_by = @actorId,
                recorded_at = UTC_TIMESTAMP(3) WHERE id = @gradeId`);
            replaced += 1;
          } else {
            await transaction.request()
              .input('studentSubjectId', sql.Int, row.student_subject_id)
              .input('gradingPeriod', sql.NVarChar(50), grade.gradingPeriod)
              .input('gradeValue', sql.Decimal(6, 2), grade.gradeValue)
              .input('actorId', sql.Int, actor.id)
              .query(`INSERT INTO grades (student_subject_id, grading_period, grade_value, recorded_by)
                VALUES (@studentSubjectId, @gradingPeriod, @gradeValue, @actorId)`);
            inserted += 1;
          }
        }
      }
      const sourceId = submissionId || previewId;
      const auditDetails = {
        schoolYear: header.school_year,
        gradeLevel: header.grade_level,
        sectionName: header.section_name,
        subjectName: header.subject_name,
        rowsProcessed: acceptedRows.length,
        rowsExcluded: excludedRows,
        gradesInserted: inserted,
        gradesReplaced: replaced,
        gradesUnchanged: unchangedGrades,
        gradeConflictsSkipped: skippedGrades
      };
      if (submissionId) {
        auditDetails.nameMismatchOverrides = decisionAudit.filter(({ action }) => action === 'name_mismatch_override').length;
        auditDetails.gradeReplacementReasons = decisionAudit.filter(({ action }) => action !== 'name_mismatch_override').length;
      } else {
        auditDetails.decisions = decisionAudit;
      }
      await transaction.request()
        .input('actorId', sql.Int, actor.id)
        .input('action', sql.NVarChar(100), 'registrar.grade_import_completed')
        .input('entityId', sql.NVarChar(100), String(sourceId))
        .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(auditDetails))
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@actorId, @action, 'grade_import', @entityId, @detailsJson)`);
      if (submissionId) {
        await transaction.request()
          .input('submissionId', sql.UniqueIdentifier, submissionId).input('actorId', sql.Int, actor.id)
          .query(`UPDATE teacher_grade_submissions SET status = 'approved', decided_by = @actorId,
            decided_at = UTC_TIMESTAMP(3), decision_reason = NULL WHERE id = @submissionId AND status = 'pending'`);
        await transaction.request()
          .input('submissionId', sql.UniqueIdentifier, submissionId).input('actorId', sql.Int, actor.id)
          .query(`INSERT INTO teacher_grade_submission_events (submission_id, actor_id, event_type)
            VALUES (@submissionId, @actorId, 'approved')`);
        await transaction.request()
          .input('actorId', sql.Int, actor.id)
          .input('action', sql.NVarChar(100), 'registrar.grade_workbook_approved')
          .input('entityId', sql.NVarChar(100), submissionId)
          .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify({
            rowsProcessed: acceptedRows.length, rowsExcluded: excludedRows, gradesInserted: inserted,
            gradesReplaced: replaced, gradesUnchanged: unchangedGrades, gradeConflictsSkipped: skippedGrades
          }))
          .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
            VALUES (@actorId, @action, 'teacher_grade_submission', @entityId, @detailsJson)`);
      } else {
        await transaction.request()
          .input('previewId', sql.UniqueIdentifier, previewId)
          .query('DELETE FROM grade_import_previews WHERE id = @previewId');
      }
      await transaction.commit();
      started = false;
      return { inserted, replaced, skipped: skippedGrades, excluded: excludedRows, rowsProcessed: acceptedRows.length };
    } catch (error) {
      if (started) await transaction.rollback().catch(() => {});
      if (error instanceof GradeImportError) throw error;
      if (isDuplicateKeyError(error)) {
        throw new GradeImportError('A grade changed during confirmation. Upload the workbook again.', 409);
      }
      throw error;
    }
  }

  return { listImportContexts, createPreview, getPreview, confirmPreview };
}

module.exports = {
  GRADE_PERIODS,
  PREVIEW_TTL_MS,
  SCHOOL_YEAR,
  GradeImportError,
  createGradeImportService,
  parseWorkbookRows,
  validateWorkbookContext,
  normalizeContext,
  normalizeGradeLevel,
  normalizePersonName,
  parseLrn,
  parseCachedGrade
};
