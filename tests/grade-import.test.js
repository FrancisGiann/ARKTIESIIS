const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const readExcelFile = require('read-excel-file/node').default;
const { createApp } = require('../src/app');
const {
  GRADE_PERIODS,
  GradeImportError,
  createGradeImportService,
  parseWorkbookRows,
  validateWorkbookContext,
  parseLrn,
  parseCachedGrade,
  normalizeGradeLevel
} = require('../src/services/gradeImportService');

const FIXTURE = path.join(__dirname, 'fixtures/grade-import/corrected-mini.xlsx');
const MISSING_CACHE_FIXTURE = path.join(__dirname, 'fixtures/grade-import/missing-cached-final.xlsx');
const LRN = '123456789012';
const SECRET = 'grade-import-test-secret';

function fakeSql() {
  return {
    MAX: 'MAX', Int: 'Int', BigInt: 'BigInt', UniqueIdentifier: 'UniqueIdentifier',
    Char: (length) => `Char(${length})`,
    NVarChar: (length) => `NVarChar(${length})`,
    Decimal: (precision, scale) => `Decimal(${precision},${scale})`,
    DateTime2: 'DateTime2', Bit: 'Bit',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }
  };
}

function requestFor(queryHandler) {
  const values = {};
  return {
    input(name, _type, value) { values[name] = value; return this; },
    query(statement) { return queryHandler(statement, { ...values }); }
  };
}

async function workbookSheets(filePath = FIXTURE) {
  return readExcelFile(fs.readFileSync(filePath));
}

test('corrected SSHS fixture parses cached formula results and validates workbook identity', async () => {
  const workbook = await workbookSheets();
  assert.deepEqual(workbook.map(({ sheet }) => sheet), [
    'INSTRUCTIONS', 'INPUT DATA', 'Term 1', 'Term 2', 'Term 3', 'FINAL GRADES', 'HELPER'
  ]);
  const input = workbook.find(({ sheet }) => sheet === 'INPUT DATA').data;
  const finalGrades = workbook.find(({ sheet }) => sheet === 'FINAL GRADES').data;
  assert.deepEqual(validateWorkbookContext(input, finalGrades), {
    schoolYear: '2026-2027', gradeLevel: '11', sectionName: 'STEM A', subjectName: 'Oral Communication'
  });
  const [row] = parseWorkbookRows(input, finalGrades);
  assert.equal(row.issue, '');
  assert.equal(row.workbookName, 'Jamie Garcia');
  assert.deepEqual(row.grades.map(({ gradeValue }) => gradeValue), [89, 90, 91, 90]);
  assert.equal(GRADE_PERIODS.length, 4);
});

test('missing formula cache excludes an incomplete learner row without recalculating it', async () => {
  const workbook = await workbookSheets(MISSING_CACHE_FIXTURE);
  const input = workbook.find(({ sheet }) => sheet === 'INPUT DATA').data;
  const finalGrades = workbook.find(({ sheet }) => sheet === 'FINAL GRADES').data;
  const [row] = parseWorkbookRows(input, finalGrades);
  assert.equal(row.grades[3].gradeValue, null);
  assert.match(row.issue, /missing one or more cached Term 1–3 or Final Grade values/);
  assert.equal(parseCachedGrade(null, 'Term 1'), null);
});

test('LRN, cached grade, and duplicate workbook learner validation fail closed', async () => {
  assert.equal(parseLrn(LRN), LRN);
  assert.equal(parseLrn('12345678901'), null);
  assert.equal(parseLrn('12345678901x'), null);
  assert.equal(parseCachedGrade('99.25', 'Term 1'), 99.25);
  assert.throws(() => parseCachedGrade(101, 'Term 1'), /outside 0–100/);

  const workbook = await workbookSheets();
  const input = workbook.find(({ sheet }) => sheet === 'INPUT DATA').data.map((row) => [...row]);
  const finalGrades = workbook.find(({ sheet }) => sheet === 'FINAL GRADES').data.map((row) => [...row]);
  input[11] = [...input[10]];
  finalGrades[17] = [...finalGrades[16]];
  const rows = parseWorkbookRows(input, finalGrades);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(({ issue }) => issue.includes('LRN appears more than once')));
});

test('grade-level context treats numeric, Grade, and G labels as equivalent only for the same level', () => {
  assert.equal(normalizeGradeLevel('11'), normalizeGradeLevel('Grade 11'));
  assert.equal(normalizeGradeLevel('11'), normalizeGradeLevel('G11'));
  assert.notEqual(normalizeGradeLevel('11'), normalizeGradeLevel('Grade 12'));
});

function makePreviewHarness({ studentName = 'Jamie Garza', sectionName = 'STEM A', actorRole = 'registrar', teacherAssignmentActive = true } = {}) {
  const state = { queries: [], header: null, rows: [], grades: [], commits: 0, rollbacks: 0, nextRowId: 1 };
  const context = {
    academic_term_id: actorRole === 'teacher' ? 3 : null,
    school_year: '2026-2027', grade_level: 'Grade 11', section_name: sectionName,
    subject_id: 77, subject_code: 'ENG11', subject_name: 'Oral Communication'
  };
  const student = {
    student_id: 44, lrn: LRN, student_no: 'S-0044', first_name: 'Jamie', middle_name: null,
    last_name: studentName === 'Jamie Garza' ? 'Garza' : 'Garcia', suffix: null, student_status: 'active',
    enrollment_id: 66, enrollment_status: 'enrolled', school_year: '2026-2027', section_name: sectionName,
    grade_level: 'Grade 11', student_subject_id: 88, grade_id: null, grading_period: null, grade_value: null
  };
  function poolRequest() {
    return requestFor(async (statement, values) => {
      state.queries.push({ statement, values });
      if (statement.includes('FROM dbo.users WITH')) return { recordset: [{ id: 7, role: actorRole }] };
      if (statement.includes('SELECT DISTINCT term.school_year')) return { recordset: [context] };
      if (statement.includes('WHERE st.lrn IN')) return { recordset: [student] };
      if (statement.includes('FROM dbo.grade_import_previews AS p')) {
        const header = state.header;
        if (!header) return { recordset: [] };
        const recordRows = state.rows.flatMap((row) => {
          const grades = state.grades.filter((grade) => grade.previewRowId === row.preview_row_id);
          return (grades.length ? grades : [null]).map((grade) => ({
            id: header.id, school_year: header.schoolYear, grade_level: header.gradeLevel,
            section_name: header.sectionName, subject_name: header.subjectName,
            workbook_grade_level: header.workbookGradeLevel, workbook_section_name: header.workbookSectionName,
            workbook_subject_name: header.workbookSubjectName, context_mismatch: header.contextMismatch,
            expires_at: header.expiresAt, preview_row_id: row.preview_row_id, source_row: row.sourceRow,
            student_id: row.studentId, enrollment_id: row.enrollmentId, student_subject_id: row.studentSubjectId,
            student_no: row.studentNo, workbook_name: row.workbookName, student_name: row.studentName,
            name_mismatch: row.nameMismatch, issue: row.issue,
            grading_period: grade?.gradingPeriod || null, grade_value: grade?.gradeValue ?? null,
            existing_grade_id: grade?.existingGradeId ?? null, existing_grade_value: grade?.existingGradeValue ?? null
          }));
        });
        return { recordset: recordRows };
      }
      return { recordset: [] };
    });
  }
  const pool = { request: poolRequest };
  const transactionFactory = () => ({
    request() {
      return requestFor(async (statement, values) => {
        if (statement.includes('FROM dbo.users WITH')) return { recordset: [{ id: 7, role: actorRole }] };
        if (statement.includes('FROM dbo.teacher_assignments AS a WITH')) {
          state.assignmentChecks = (state.assignmentChecks || 0) + 1;
          return { recordset: teacherAssignmentActive ? [{ id: 12 }] : [] };
        }
        if (statement.includes('INSERT INTO dbo.grade_import_previews')) {
          state.header = {
            id: values.previewId, schoolYear: values.schoolYear, gradeLevel: values.gradeLevel,
            sectionName: values.sectionName, subjectName: values.subjectName,
            workbookGradeLevel: values.workbookGradeLevel, workbookSectionName: values.workbookSectionName,
            workbookSubjectName: values.workbookSubjectName, contextMismatch: values.contextMismatch,
            expiresAt: values.expiresAt
          };
          return { recordset: [] };
        }
        if (statement.includes('INSERT INTO dbo.grade_import_preview_rows')) {
          const id = state.nextRowId++;
          state.rows.push({
            preview_row_id: id, sourceRow: values.sourceRow, studentId: values.studentId,
            enrollmentId: values.enrollmentId, studentSubjectId: values.studentSubjectId,
            studentNo: values.studentNo, workbookName: values.workbookName, studentName: values.studentName,
            lrnFingerprint: values.lrnFingerprint, nameMismatch: values.nameMismatch, issue: values.issue
          });
          return { recordset: [{ id }] };
        }
        if (statement.includes('INSERT INTO dbo.grade_import_preview_grades')) {
          state.grades.push({
            previewRowId: values.previewRowId, gradingPeriod: values.gradingPeriod,
            gradeValue: values.gradeValue, existingGradeId: values.existingGradeId,
            existingGradeValue: values.existingGradeValue
          });
          return { recordset: [] };
        }
        return { recordset: [] };
      });
    },
    async begin() {},
    async commit() { state.commits += 1; },
    async rollback() { state.rollbacks += 1; }
  });
  const service = createGradeImportService({
    getPool: async () => pool, sql: fakeSql(), transactionFactory, secret: SECRET,
    now: () => Date.UTC(2026, 8, 1)
  });
  return { service, state, context };
}

test('preview matches by LRN, displays database identity, and flags a name mismatch', async () => {
  const { service, state } = makePreviewHarness();
  const [context] = await service.listImportContexts(7);
  const preview = await service.createPreview({
    actorId: 7, sessionId: 'session-a', contextKey: context.key, buffer: fs.readFileSync(FIXTURE)
  });
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0].studentNo, 'S-0044');
  assert.equal(preview.rows[0].studentName, 'Jamie Garza');
  assert.equal(preview.rows[0].nameMismatch, true);
  assert.equal(preview.rows[0].issue, null);
  assert.deepEqual(preview.rows[0].grades.map(({ gradeValue }) => gradeValue), [89, 90, 91, 90]);
  assert.equal(new Date(preview.expiresAt).getTime() - Date.UTC(2026, 8, 1), 30 * 60 * 1000);
  assert.equal(state.rows[0].lrn, undefined, 'preview row storage contains an HMAC fingerprint, not the raw LRN');
  assert.equal(JSON.stringify(state.rows).includes(LRN), false);
  assert.equal(state.commits, 1);
});

test('teacher preview persistence rechecks the active assignment inside its serializable transaction', async () => {
  const { service, state } = makePreviewHarness({ actorRole: 'teacher', teacherAssignmentActive: false });
  const [context] = await service.listImportContexts(7);

  await assert.rejects(service.createPreview({
    actorId: 7, sessionId: 'session-a', contextKey: context.key, buffer: fs.readFileSync(FIXTURE)
  }), (error) => error instanceof GradeImportError && error.status === 403);

  assert.equal(state.assignmentChecks, 1);
  assert.equal(state.header, null, 'a revoked class cannot leave a persisted preview');
  assert.equal(state.rows.length, 0);
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
});

test('preview always supplies four table cells when a cached grade is absent', async () => {
  const records = [
    { grading_period: 'Term 1', grade_value: 89 },
    { grading_period: 'Term 2', grade_value: 90 },
    { grading_period: 'Term 3', grade_value: 91 }
  ].map((grade) => ({
    id: 'f53eb245-6ad6-4a91-8aa4-e32dbbafc4ef', school_year: '2026-2027', grade_level: 'Grade 11',
    section_name: 'STEM A', subject_name: 'Oral Communication', workbook_grade_level: 'Grade 11',
    workbook_section_name: 'STEM A', workbook_subject_name: 'Oral Communication', context_mismatch: false,
    expires_at: new Date(Date.now() + 60_000), preview_row_id: 501, source_row: 17, student_id: 44,
    enrollment_id: 66, student_subject_id: 88, student_no: 'S-0044', workbook_name: 'Jamie Garcia',
    student_name: 'Jamie Garcia', name_mismatch: false, issue: 'This learner is missing one cached grade.',
    existing_grade_id: null, existing_grade_value: null, ...grade
  }));
  const service = createGradeImportService({
    getPool: async () => ({ request: () => requestFor(async () => ({ recordset: records })) }),
    sql: fakeSql(), secret: SECRET
  });
  const preview = await service.getPreview({ actorId: 7, sessionId: 'session-a', previewId: records[0].id });
  assert.deepEqual(preview.rows[0].grades.map(({ gradingPeriod, gradeValue }) => [gradingPeriod, gradeValue]), [
    ['Term 1', 89], ['Term 2', 90], ['Term 3', 91], ['Final Grade', null]
  ]);
});

function confirmationHarness({ existingGrades = [], nameMismatch = false, failAtInsert = 0, omitGradePeriod = null,
  currentRecordsOverride = null, submissionMode = false, activeAssignment = true, submitterIsTeacher = true } = {}) {
  const state = {
    commits: 0, rollbacks: 0, previewExists: true, inserts: 0, replaces: 0, audits: [],
    persistedInserts: 0, persistedReplaces: 0, transactionQueue: Promise.resolve(), queries: []
  };
  const currentRecords = (currentRecordsOverride || existingGrades.map((grade) => ({
    student_id: 44, lrn: LRN, student_no: 'S-0044', first_name: 'Jamie', middle_name: null,
    last_name: 'Garcia', suffix: null, student_status: 'active', enrollment_id: 66,
    enrollment_status: 'enrolled', school_year: '2026-2027', section_name: 'STEM A',
    grade_level: 'Grade 11', student_subject_id: 88, subject_id: 77,
    subject_name: 'Oral Communication', grade_id: grade.id, grading_period: grade.period,
    grade_value: grade.value
  }))).map((record) => ({ ...record }));
  if (currentRecordsOverride === null && !currentRecords.length) currentRecords.push({
    student_id: 44, lrn: LRN, student_no: 'S-0044', first_name: 'Jamie', middle_name: null,
    last_name: 'Garcia', suffix: null, student_status: 'active', enrollment_id: 66,
    enrollment_status: 'enrolled', school_year: '2026-2027', section_name: 'STEM A',
    grade_level: 'Grade 11', student_subject_id: 88, subject_id: 77,
    subject_name: 'Oral Communication', grade_id: null, grading_period: null, grade_value: null
  });
  const grades = [
    { period: 'Term 1', value: 89 }, { period: 'Term 2', value: 90 },
    { period: 'Term 3', value: 91 }, { period: 'Final Grade', value: 90 }
  ].map((grade) => {
    const existing = existingGrades.find(({ period }) => period === grade.period);
    return {
      grading_period: grade.period, grade_value: grade.value,
      existing_grade_id: existing?.id ?? null, existing_grade_value: existing?.value ?? null
    };
  });
  const header = {
    id: 'f53eb245-6ad6-4a91-8aa4-e32dbbafc4ef', academic_term_id: 3,
    school_year: '2026-2027', grade_level: 'Grade 11',
    section_name: 'STEM A', subject_id: 77, subject_name: 'Oral Communication', context_mismatch: false
  };
  const row = {
    id: 501, source_row: 17, student_id: 44, enrollment_id: 66, student_subject_id: 88,
    student_no: 'S-0044', workbook_name: nameMismatch ? 'Jamie Garza' : 'Jamie Garcia',
    student_name: 'Jamie Garcia', lrn_fingerprint: require('node:crypto').createHmac('sha256', SECRET).update(LRN).digest('hex'),
    name_mismatch: nameMismatch, issue: null
  };
  let lastTransaction = Promise.resolve();
  const transactionFactory = () => {
    let release;
    let localInserts = 0;
    let localReplaces = 0;
    let localAudits = [];
    let removePreview = false;
    return {
      async begin() {
        const prior = lastTransaction;
        lastTransaction = new Promise((resolve) => { release = resolve; });
        await prior;
      },
      request() {
        return requestFor(async (statement, values) => {
          state.queries.push({ statement, values });
          if (statement.includes('FROM dbo.users WITH')) return { recordset: [{ id: 7, role: 'registrar' }] };
          if (statement.includes('FROM dbo.grade_import_previews WITH')) return state.previewExists ? { recordset: [header] } : { recordset: [] };
          if (statement.includes('FROM dbo.teacher_grade_submissions AS s WITH')) {
            return submissionMode && activeAssignment && submitterIsTeacher ? { recordset: [header] } : { recordset: [] };
          }
          if (statement.includes('FROM dbo.grade_import_preview_rows AS r')
            || statement.includes('FROM dbo.teacher_grade_submission_rows AS r')) {
            return { recordset: grades.filter((grade) => grade.grading_period !== omitGradePeriod).map((grade) => ({ ...row, ...grade })) };
          }
          if (statement.includes('FROM dbo.students AS st WITH')) return { recordset: currentRecords };
          if (statement.startsWith('INSERT INTO dbo.grades')) {
            localInserts += 1;
            if (failAtInsert && localInserts === failAtInsert) throw new Error('injected grade write failure');
            return { recordset: [] };
          }
          if (statement.startsWith('UPDATE dbo.grades')) { localReplaces += 1; return { recordset: [] }; }
          if (statement.includes('INSERT INTO dbo.audit_logs')) {
            const details = JSON.parse(values.detailsJson || '{}');
            localAudits.push(details);
            return { recordset: [] };
          }
          if (statement.startsWith('DELETE FROM dbo.grade_import_previews')) { removePreview = true; return { recordset: [] }; }
          return { recordset: [] };
        });
      },
      async commit() {
        state.commits += 1;
        state.persistedInserts += localInserts;
        state.persistedReplaces += localReplaces;
        state.audits.push(...localAudits);
        if (removePreview) state.previewExists = false;
        release();
      },
      async rollback() { state.rollbacks += 1; release(); }
    };
  };
  const getPool = async () => ({ request: () => requestFor(async () => ({ recordset: [] })) });
  const service = createGradeImportService({ getPool, sql: fakeSql(), transactionFactory, secret: SECRET });
  return { service, state, header, row, grades };
}

function fullDecision({ include = true, overrideName = false, nameReason, grades = {} } = {}) {
  return { sourceRow: 17, include, allowNameMismatch: overrideName, nameReason, grades };
}

test('confirmation requires explicit inclusion and reasoned review/replacement while equal grades remain unchanged', async () => {
  const existing = [
    { id: 101, period: 'Term 1', value: 80 },
    { id: 102, period: 'Term 2', value: 90 },
    { id: 103, period: 'Term 3', value: 85 }
  ];
  const { service, state } = confirmationHarness({ existingGrades: existing, nameMismatch: true });
  const result = await service.confirmPreview({
    actorId: 7, sessionId: 'session-a', previewId: 'f53eb245-6ad6-4a91-8aa4-e32dbbafc4ef',
    decisions: [fullDecision({
      overrideName: true, nameReason: 'Verified against the student profile.',
      grades: { 'Term 1': { action: 'replace', reason: 'Corrected after source review.' } }
    })]
  });
  assert.deepEqual(result, { inserted: 1, replaced: 1, skipped: 1, excluded: 0, rowsProcessed: 1 });
  assert.equal(state.persistedInserts, 1);
  assert.equal(state.persistedReplaces, 1);
  assert.equal(state.previewExists, false);
  const auditJson = JSON.stringify(state.audits);
  assert.equal(auditJson.includes(LRN), false);
  assert.equal(auditJson.includes('89'), false, 'audit summary omits raw grade values');

  const noInclude = confirmationHarness();
  const excluded = await noInclude.service.confirmPreview({
    actorId: 7, sessionId: 'session-a', previewId: noInclude.header.id, decisions: []
  });
  assert.equal(excluded.rowsProcessed, 0);
  assert.equal(excluded.excluded, 1);
  assert.equal(noInclude.state.persistedInserts, 0);
});

test('confirmation rejects missing review reasons and rolls back all grade writes on a mid-transaction failure', async () => {
  const needsNameReason = confirmationHarness({ nameMismatch: true });
  await assert.rejects(needsNameReason.service.confirmPreview({
    actorId: 7, sessionId: 'session-a', previewId: needsNameReason.header.id,
    decisions: [fullDecision({ overrideName: true, nameReason: 'no' })]
  }), /must be 5–500 printable characters/);
  assert.equal(needsNameReason.state.rollbacks, 1);
  assert.equal(needsNameReason.state.persistedInserts, 0);
  assert.equal(needsNameReason.state.previewExists, true);

  const needsReplaceReason = confirmationHarness({ existingGrades: [{ id: 101, period: 'Term 1', value: 80 }] });
  await assert.rejects(needsReplaceReason.service.confirmPreview({
    actorId: 7, sessionId: 'session-a', previewId: needsReplaceReason.header.id,
    decisions: [fullDecision({ grades: { 'Term 1': { action: 'replace', reason: 'bad' } } })]
  }), /must be 5–500 printable characters/);
  assert.equal(needsReplaceReason.state.rollbacks, 1);

  const atomic = confirmationHarness({ failAtInsert: 2 });
  await assert.rejects(atomic.service.confirmPreview({
    actorId: 7, sessionId: 'session-a', previewId: atomic.header.id,
    decisions: [fullDecision()]
  }), /injected grade write failure/);
  assert.equal(atomic.state.rollbacks, 1);
  assert.equal(atomic.state.persistedInserts, 0);
  assert.equal(atomic.state.audits.length, 0);
  assert.equal(atomic.state.previewExists, true);
});

test('concurrent confirmation imports a preview once and expires/repeats safely', async () => {
  const { service, state, header } = confirmationHarness();
  const args = {
    actorId: 7, sessionId: 'session-a', previewId: header.id, decisions: [fullDecision()]
  };
  const outcomes = await Promise.allSettled([service.confirmPreview(args), service.confirmPreview(args)]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = outcomes.find(({ status }) => status === 'rejected');
  assert.ok(rejected.reason instanceof GradeImportError);
  assert.equal(rejected.reason.status, 409);
  assert.equal(state.persistedInserts, 4);
  assert.equal(state.commits, 1);
  assert.equal(state.previewExists, false);
});

test('registrar confirmation writes no grades when the roster row or a grade changed after preview', async () => {
  const rosterChanged = confirmationHarness({ currentRecordsOverride: [] });
  await assert.rejects(rosterChanged.service.confirmPreview({
    actorId: 7, sessionId: 'session-a', previewId: rosterChanged.header.id,
    decisions: [fullDecision()]
  }), /learner or enrollment details changed after preview/);
  assert.equal(rosterChanged.state.rollbacks, 1);
  assert.equal(rosterChanged.state.persistedInserts, 0);
  assert.equal(rosterChanged.state.persistedReplaces, 0);
  assert.equal(rosterChanged.state.audits.length, 0);

  const gradeChanged = confirmationHarness({ currentRecordsOverride: [{
    student_id: 44, lrn: LRN, student_no: 'S-0044', first_name: 'Jamie', middle_name: null,
    last_name: 'Garcia', suffix: null, student_status: 'active', enrollment_id: 66,
    enrollment_status: 'enrolled', school_year: '2026-2027', section_name: 'STEM A',
    grade_level: 'Grade 11', student_subject_id: 88, subject_id: 77,
    subject_name: 'Oral Communication', grade_id: 501, grading_period: 'Term 1', grade_value: 85
  }] });
  await assert.rejects(gradeChanged.service.confirmPreview({
    actorId: 7, sessionId: 'session-a', previewId: gradeChanged.header.id,
    decisions: [fullDecision()]
  }), /grade changed after preview/);
  assert.equal(gradeChanged.state.rollbacks, 1);
  assert.equal(gradeChanged.state.persistedInserts, 0);
  assert.equal(gradeChanged.state.persistedReplaces, 0);
  assert.equal(gradeChanged.state.audits.length, 0);
});

test('submission approval requires an active teacher assignment, while an inactive submitter does not cancel registrar review', async () => {
  const revoked = confirmationHarness({ submissionMode: true, activeAssignment: false });
  await assert.rejects(revoked.service.confirmPreview({
    actorId: 7, submissionId: revoked.header.id, decisions: [fullDecision()]
  }), /teacher assignment is no longer valid/);
  assert.equal(revoked.state.rollbacks, 1);
  assert.equal(revoked.state.persistedInserts, 0);
  assert.equal(revoked.state.queries.some(({ statement }) => statement.includes('FROM dbo.students AS st WITH')), false);

  const reassigned = confirmationHarness({ submissionMode: true, activeAssignment: true, submitterIsTeacher: false });
  await assert.rejects(reassigned.service.confirmPreview({
    actorId: 7, submissionId: reassigned.header.id, decisions: [fullDecision()]
  }), /teacher assignment is no longer valid/);
  assert.equal(reassigned.state.rollbacks, 1);
  assert.equal(reassigned.state.persistedInserts, 0);
  assert.equal(reassigned.state.queries.some(({ statement }) => statement.includes('FROM dbo.students AS st WITH')), false);

  const deactivatedSubmitter = confirmationHarness({ submissionMode: true, activeAssignment: true });
  const result = await deactivatedSubmitter.service.confirmPreview({
    actorId: 7, submissionId: deactivatedSubmitter.header.id,
    decisions: [fullDecision({ overrideName: true, nameReason: 'verified workbook name' })]
  });
  assert.equal(result.inserted, 4, 'the active registrar can approve the saved review snapshot even if its submitter later becomes inactive');
  assert.equal(deactivatedSubmitter.state.persistedInserts, 4);
  const submissionHeader = deactivatedSubmitter.state.queries.find(({ statement }) => statement.includes('FROM dbo.teacher_grade_submissions AS s WITH'));
  assert.match(submissionHeader.statement, /s\.status = N'pending' AND a\.is_active = 1/);
  assert.match(submissionHeader.statement, /a\.teacher_id = s\.submitted_by[\s\S]*?submitter\.role = N'teacher'/);
  assert.doesNotMatch(submissionHeader.statement, /submitter\.is_active = 1/,
    'the registrar may finish review when the original teacher account is deactivated but the assignment remains active');
  const approvalAuditDetails = deactivatedSubmitter.state.queries
    .filter(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs'))
    .map(({ values }) => values.detailsJson).join(' ');
  assert.doesNotMatch(approvalAuditDetails, /studentId|verified workbook name|123456789012|"89"/);

  const rosterChanged = confirmationHarness({ submissionMode: true, currentRecordsOverride: [] });
  await assert.rejects(rosterChanged.service.confirmPreview({
    actorId: 7, submissionId: rosterChanged.header.id, decisions: [fullDecision()]
  }), /learner or enrollment details changed after preview/);
  assert.equal(rosterChanged.state.rollbacks, 1);
  assert.equal(rosterChanged.state.persistedInserts, 0);
  assert.equal(rosterChanged.state.persistedReplaces, 0);

  const gradeChanged = confirmationHarness({
    submissionMode: true,
    existingGrades: [{ id: 101, period: 'Term 1', value: 80 }],
    currentRecordsOverride: [{
      student_id: 44, lrn: LRN, student_no: 'S-0044', first_name: 'Jamie', middle_name: null,
      last_name: 'Garcia', suffix: null, student_status: 'active', enrollment_id: 66,
      enrollment_status: 'enrolled', school_year: '2026-2027', section_name: 'STEM A',
      grade_level: 'Grade 11', student_subject_id: 88, subject_id: 77,
      subject_name: 'Oral Communication', grade_id: 501, grading_period: 'Term 1', grade_value: 85
    }]
  });
  await assert.rejects(gradeChanged.service.confirmPreview({
    actorId: 7, submissionId: gradeChanged.header.id, decisions: [fullDecision()]
  }), /grade changed after preview/);
  assert.equal(gradeChanged.state.rollbacks, 1);
  assert.equal(gradeChanged.state.persistedInserts, 0);
  assert.equal(gradeChanged.state.persistedReplaces, 0);
});

test('confirm rechecks registrar access and four complete cached grades before accepting a row', async () => {
  let userQuery = 0;
  const incomplete = confirmationHarness({ omitGradePeriod: 'Final Grade' });
  await assert.rejects(incomplete.service.confirmPreview({
    actorId: 7, sessionId: 'session-a', previewId: incomplete.header.id,
    decisions: [fullDecision()]
  }), /four valid cached grades/);
  assert.equal(incomplete.state.rollbacks, 1);
  assert.equal(incomplete.state.previewExists, true);

  const unauthorizedFactory = confirmationHarness();
  const service = createGradeImportService({
    getPool: async () => ({ request: () => requestFor(async () => ({ recordset: [] })) }), sql: fakeSql(), secret: SECRET,
    transactionFactory: () => ({
      async begin() {}, request() { return requestFor(async (statement) => {
        if (statement.includes('FROM dbo.users WITH')) { userQuery += 1; return { recordset: [] }; }
        return { recordset: [] };
      }); },
      async rollback() {}, async commit() {}
    })
  });
  await assert.rejects(service.confirmPreview({ actorId: 7, sessionId: 'session-a', previewId: unauthorizedFactory.header.id }), (error) => {
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(userQuery, 1);
});

function authPool(role) {
  const user = {
    id: 7, email: `${role}@example.edu`, password_hash: bcrypt.hashSync('Correct-Horse-Battery-12', 4),
    role, is_active: true, updated_at_fingerprint: ''
  };
  return async () => ({
    request() {
      return requestFor(async (statement) => {
        if (statement.includes('WHERE email = @email')) return { recordset: [user] };
        if (statement.includes('WHERE id = @userId')) return { recordset: [user] };
        throw new Error('Unexpected authentication query.');
      });
    }
  });
}

function cookieFrom(response) { return response.headers.get('set-cookie').split(';', 1)[0]; }
function csrfFrom(html) { return html.match(/name="_csrf" value="([^"]+)"/)?.[1]; }

async function signIn(baseUrl, role) {
  const loginPage = await fetch(`${baseUrl}/login`);
  const cookie = cookieFrom(loginPage);
  const token = csrfFrom(await loginPage.text());
  const login = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, email: `${role}@example.edu`, password: 'Correct-Horse-Battery-12' })
  });
  assert.equal(login.status, 303);
  return cookieFrom(login);
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('grade-import route is registrar-only and requires CSRF before processing an upload', async () => {
  const environment = { nodeEnv: 'development', devPasswordOnlyLogin: true, sessionSecret: SECRET };
  let previews = 0;
  const gradeImportService = {
    async listImportContexts() { return [{ key: 'context-key', school_year: '2026-2027', grade_level: 'Grade 11', section_name: 'STEM A', subject_code: 'ENG11', subject_name: 'Oral Communication' }]; },
    async createPreview() { previews += 1; throw new Error('must not be called'); }
  };
  const appFor = (role) => createApp({ databasePool: authPool(role), environment, gradeImportService });
  await withServer(appFor('finance'), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const response = await fetch(`${baseUrl}/records/grade-import`, { headers: { cookie } });
    assert.equal(response.status, 403);
    assert.equal(previews, 0);
  });
  await withServer(appFor('registrar'), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const page = await fetch(`${baseUrl}/records/grade-import`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('cache-control'), /private, no-store/);
    const html = await page.text();
    assert.match(html, /Choose the existing class context/);
    const token = csrfFrom(html);
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const bytes = fs.readFileSync(FIXTURE);
    const missingCsrf = new FormData();
    missingCsrf.set('contextKey', 'context-key');
    missingCsrf.set('workbook', new Blob([bytes], { type: mime }), 'corrected-mini.xlsx');
    const denied = await fetch(`${baseUrl}/records/grade-import/preview`, { method: 'POST', headers: { cookie }, body: missingCsrf });
    assert.equal(denied.status, 403);

    const badExtension = new FormData();
    badExtension.set('_csrf', token);
    badExtension.set('contextKey', 'context-key');
    badExtension.set('workbook', new Blob([bytes], { type: mime }), 'corrected-mini.xls');
    const invalid = await fetch(`${baseUrl}/records/grade-import/preview`, { method: 'POST', headers: { cookie }, body: badExtension });
    assert.equal(invalid.status, 400);
  });
  assert.equal(previews, 0);
});

test('migration 007 contains LRN constraints and private preview tables', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../database/migrations/007_student_lrn.sql'), 'utf8');
  assert.match(migration, /DATALENGTH\(lrn\) = 24/);
  assert.match(migration, /CREATE UNIQUE INDEX UX_students_lrn[\s\S]+WHERE lrn IS NOT NULL/);
  assert.match(migration, /TR_students_require_lrn_on_insert/);
  assert.match(migration, /CREATE TABLE dbo\.grade_import_previews/);
  assert.match(migration, /CREATE TABLE dbo\.grade_import_preview_rows/);
  assert.match(migration, /CREATE TABLE dbo\.grade_import_preview_grades/);
});

test('migration 009 adds forward-only teacher grade submission schema without deleting legacy rows', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../database/migrations/009_teacher_grade_submissions.sql'), 'utf8');
  assert.match(migration, /'teacher'/);
  assert.match(migration, /ALTER TABLE dbo\.grade_import_previews\s+ADD academic_term_id INT NULL/);
  for (const table of [
    'teacher_assignments', 'teacher_grade_submissions', 'teacher_grade_submission_rows',
    'teacher_grade_submission_grades', 'teacher_grade_submission_events'
  ]) assert.match(migration, new RegExp(`CREATE TABLE dbo\\.${table}\\b`));
  assert.match(migration, /UX_teacher_assignment_active_context[\s\S]*?WHERE is_active = 1/);
  assert.match(migration, /UX_teacher_grade_submission_pending_assignment[\s\S]*?WHERE status = N'pending'/);
  assert.match(migration, /N'pending', N'approved', N'correction_requested', N'rejected'/);
  assert.doesNotMatch(migration, /DROP\s+TABLE|DELETE\s+FROM\s+dbo\.documents/i);
});
