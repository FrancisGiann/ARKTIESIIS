'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ejs = require('ejs');
const fs = require('node:fs/promises');
const mysql = require('mysql2/promise');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { PoolFacade, Transaction, sql } = require('../src/config/database');
const { createRegistrarMasterlistService, RegistrarMasterlistError } = require('../src/services/registrarMasterlistService');
const { createRequirementService, RequirementServiceError } = require('../src/services/requirementService');
const { createDocumentService } = require('../src/services/documentService');
const { createDocumentProcessingService } = require('../src/services/documentProcessingService');

const socketPath = process.env.ENROLLMENT_REPORTING_TEST_SOCKET;
const projectRoot = path.resolve(__dirname, '..');
const PDF = Buffer.from('%PDF-1.7\nsynthetic-only test file');

function uuid() { return crypto.randomUUID(); }
function quoteDatabase(value) { return `\`${value.replaceAll('`', '``')}\``; }

async function executeStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function createUser(pool, role, tag) {
  const [result] = await pool.execute('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
    [`${tag}-${uuid()}@integration.invalid`, 'integration-only-not-a-password-hash', role]);
  return Number(result.insertId);
}

async function createStudent(pool, userId, index, overrides = {}) {
  const [result] = await pool.execute(`INSERT INTO students
      (user_id, student_no, lrn, first_name, middle_name, last_name, birth_date, sex, address, phone, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [userId, `SYNTH-${String(index).padStart(4, '0')}`,
    String(index).padStart(12, '0'), overrides.firstName || `Student${String(index).padStart(3, '0')}`,
    null, overrides.lastName || `Surname${String(index).padStart(3, '0')}`,
    overrides.birthDate || '2008-02-29', index % 2 ? 'Female' : 'Male', 'Synthetic address', '0012345000', overrides.status || 'active']);
  return Number(result.insertId);
}

async function createCustomAnnual(pool, studentId, registrarId, index, terms, sections, { includeTerm3 = true, termCount = null, schoolYear = '2026-2027' } = {}) {
  const [annualResult] = await pool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, entry_term_number)
    VALUES (?, ?, 'Grade 12', 'NV', 'enrolled', ?, 1)`, [studentId, schoolYear, registrarId]);
  const annualId = Number(annualResult.insertId);
  const placements = [];
  for (let termNumber = 1; termNumber <= (termCount || (includeTerm3 ? 3 : 2)); termNumber += 1) {
    const termId = terms[termNumber - 1];
    const sectionId = sections[termNumber - 1];
    const status = termNumber === 2 && index === 0 ? 'transferred'
      : termNumber === 3 && index === 0 ? 'dropped' : 'enrolled';
    const enrolledAt = termNumber === 1 && index === 0 ? '2026-06-14 17:00:00' : `2026-06-${String(termNumber + 1).padStart(2, '0')} 08:00:00`;
    const [enrollmentResult] = await pool.execute(`INSERT INTO enrollments
        (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status, enrolled_at)
      VALUES (?, ?, ?, ?, ?, ?, 'applicable', ?)`, [studentId, termId, sectionId, status, annualId, termNumber, enrolledAt]);
    placements.push(Number(enrollmentResult.insertId));
  }
  return { annualId, placements };
}

test('isolated MariaDB upgrades v2.024 history and verifies enrollment exports and custom requirements', {
  skip: !socketPath && 'Set ENROLLMENT_REPORTING_TEST_SOCKET to a disposable MariaDB socket under /tmp.',
  timeout: 240000
}, async (t) => {
  assert.ok(path.isAbsolute(socketPath));
  assert.ok(path.resolve(socketPath).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
  const databaseName = `ark_enrollment_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-enrollment-private-'));
  await fs.chmod(storageRoot, 0o700);
  const systemUser = os.userInfo().username;
  const adminPool = mysql.createPool({ socketPath, user: systemUser, password: '', waitForConnections: true, connectionLimit: 2 });
  let rawPool;
  t.after(async () => {
    if (rawPool) await rawPool.end().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteDatabase(databaseName)}`).catch(() => {});
    await adminPool.end().catch(() => {});
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  await adminPool.query(`CREATE DATABASE ${quoteDatabase(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  rawPool = mysql.createPool({ socketPath, user: systemUser, password: '', database: databaseName,
    waitForConnections: true, connectionLimit: 6, supportBigNumbers: true, bigNumberStrings: true,
    decimalNumbers: false, dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false });
  const setup = await rawPool.getConnection();
  try {
    await executeStatements(setup, readSqlFile(path.join(projectRoot, 'database/mariadb/schema.sql')));
    const migrations = readForwardMigrations();
    assert.equal(migrations.at(-1).version, 'v2.027');
    for (const migration of migrations.filter(({ version }) => version < 'v2.025')) {
      await executeStatements(setup, migration.statements);
      await setup.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
    }
  } finally {
    setup.release();
  }

  const databaseAdminId = await createUser(rawPool, 'database_admin', 'database-admin');
  const registrarId = await createUser(rawPool, 'registrar', 'registrar');
  const ownerId = await createUser(rawPool, 'student', 'owner');
  const otherStudentUserId = await createUser(rawPool, 'student', 'other');
  const ownerStudentId = await createStudent(rawPool, ownerId, 1, { firstName: '=1+2', lastName: 'Alpha' });
  const otherStudentId = await createStudent(rawPool, otherStudentUserId, 2, { lastName: 'Beta' });

  const oldIdempotency = uuid();
  await rawPool.execute(`INSERT INTO student_physical_checklist_events
      (student_id, requirement_code, requirement_name, status, is_applicable, originals_received,
       copies_received, pieces_received, idempotency_key, request_fingerprint, recorded_by)
    VALUES (?, 'birth_certificate', 'Birth Certificate', 'verified', 1, 1, 2, 0, ?, ?, ?)`,
  [ownerStudentId, oldIdempotency, 'a'.repeat(64), registrarId]);
  const legacyFilename = `${uuid()}.pdf`;
  const [legacyDocumentResult] = await rawPool.execute(`INSERT INTO documents
      (student_id, document_type, original_filename, stored_filename, mime_type, file_size_bytes,
       uploaded_by, upload_source, status, is_legacy_archive)
    VALUES (?, 'report_card', 'historical-synthetic.pdf', ?, 'application/pdf', ?, ?, 'student', 'needs_review', 0)`,
  [ownerStudentId, legacyFilename, PDF.length, ownerId]);
  const legacyDocumentId = Number(legacyDocumentResult.insertId);
  const v025 = readForwardMigrations().find(({ version }) => version === 'v2.025');
  const migrate = await rawPool.getConnection();
  try {
    await executeStatements(migrate, v025.statements);
    await migrate.execute('INSERT INTO schema_migrations (version) VALUES (?)', [v025.version]);
    const v026 = readForwardMigrations().find(({ version }) => version === 'v2.026');
    await executeStatements(migrate, v026.statements);
    await migrate.execute('INSERT INTO schema_migrations (version) VALUES (?)', [v026.version]);
    const v027 = readForwardMigrations().find(({ version }) => version === 'v2.027');
    await executeStatements(migrate, v027.statements);
    await migrate.execute('INSERT INTO schema_migrations (version) VALUES (?)', [v027.version]);
  } finally {
    migrate.release();
  }

  const [preservedPaper] = await rawPool.execute(`SELECT id, status, originals_received, copies_received, requirement_assignment_id
    FROM student_physical_checklist_events WHERE idempotency_key = ?`, [oldIdempotency]);
  assert.equal(preservedPaper.length, 1);
  assert.equal(preservedPaper[0].status, 'verified');
  assert.equal(Number(preservedPaper[0].originals_received), 1);
  assert.equal(Number(preservedPaper[0].copies_received), 2);
  assert.equal(preservedPaper[0].requirement_assignment_id, null);
  const [preservedDocument] = await rawPool.execute(`SELECT id, document_type, status, requirement_assignment_id
    FROM documents WHERE id = ?`, [legacyDocumentId]);
  assert.deepEqual(preservedDocument[0], { id: legacyDocumentId, document_type: 'report_card', status: 'needs_review', requirement_assignment_id: null });
  const [builtinTypes] = await rawPool.execute('SELECT COUNT(*) AS total FROM requirement_catalog WHERE is_builtin = 1');
  assert.equal(Number(builtinTypes[0].total), 4);

  const termIds = [];
  const sectionIds = [];
  for (let termNumber = 1; termNumber <= 3; termNumber += 1) {
    const [termResult] = await rawPool.execute('INSERT INTO academic_terms (school_year, term, is_current) VALUES (?, ?, ?)',
      ['2026-2027', `Term ${termNumber}`, termNumber === 1 ? 1 : 0]);
    termIds.push(Number(termResult.insertId));
    const [sectionResult] = await rawPool.execute(`INSERT INTO sections
        (name, grade_level, academic_term_id, strand, adviser, modality)
      VALUES (?, 'Grade 12', ?, ?, ?, 'onsite')`, [`Section ${termNumber}`, termIds.at(-1), termNumber === 1 ? 'STEM' : 'ABM', `Advisor ${termNumber}`]);
    sectionIds.push(Number(sectionResult.insertId));
  }
  const [alternateTerm2SectionResult] = await rawPool.execute(`INSERT INTO sections
      (name, grade_level, academic_term_id, strand, adviser, modality)
    VALUES ('Section 2B', 'Grade 12', ?, 'ABM', 'Advisor 2B', 'onsite')`, [termIds[1]]);
  const alternateTerm2SectionId = Number(alternateTerm2SectionResult.insertId);

  const studentIds = [ownerStudentId];
  const annualByStudent = new Map();
  const ownerAnnual = await createCustomAnnual(rawPool, ownerStudentId, registrarId, 0, termIds, sectionIds);
  annualByStudent.set(ownerStudentId, ownerAnnual);
  for (let index = 3; index <= 31; index += 1) {
    const userId = await createUser(rawPool, 'student', `cohort-${index}`);
    const status = index === 31 ? 'archived' : 'active';
    const studentId = await createStudent(rawPool, userId, index, { status });
    studentIds.push(studentId);
    const annual = await createCustomAnnual(rawPool, studentId, registrarId, index, termIds,
      [sectionIds[0], index <= 17 ? sectionIds[1] : alternateTerm2SectionId, sectionIds[2]], { includeTerm3: index !== 31 });
    annualByStudent.set(studentId, annual);
  }
  assert.equal(studentIds.length, 30);

  await rawPool.execute(`INSERT INTO finance_departure_cases
      (annual_enrollment_id, effective_enrollment_id, effective_date, departure_type, reason, recorded_by, idempotency_key, request_fingerprint)
    VALUES (?, ?, '2026-10-15', 'transferred', 'Synthetic transfer reason', ?, ?, ?)`,
  [ownerAnnual.annualId, ownerAnnual.placements[1], registrarId, uuid(), 'f'.repeat(64)]);

  const ownerAnnualId = ownerAnnual.annualId;
  const [scheduleResult] = await rawPool.execute(`INSERT INTO finance_schedules
      (school_year, grade_level, voucher_code, version_no, status, idempotency_key, request_fingerprint, created_by)
    VALUES ('2026-2027', 'Grade 12', 'NV', 1, 'active', ?, ?, ?)`, [uuid(), 'b'.repeat(64), registrarId]);
  const scheduleId = Number(scheduleResult.insertId);
  const [assessmentResult] = await rawPool.execute(`INSERT INTO annual_assessments
      (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by,
       selection_json, idempotency_key, request_fingerprint)
    VALUES (?, ?, 1, 'NV', ?, '{"optionalLineIds":[]}', ?, ?)`,
  [ownerAnnualId, scheduleId, registrarId, uuid(), 'c'.repeat(64)]);
  const ownerEntryEnrollmentId = ownerAnnual.placements[0];
  await rawPool.execute(`INSERT INTO annual_registrar_confirmations
      (annual_enrollment_id, student_id, school_year, grade_level, entry_enrollment_id, assessment_id, schedule_id,
       schedule_version, voucher_code_snapshot, payable_total, selection_json, assessment_snapshot_fingerprint,
       confirmed_by, idempotency_key, request_fingerprint)
    VALUES (?, ?, '2026-2027', 'Grade 12', ?, ?, ?, 1, 'NV', 0, '{"optionalLineIds":[]}', ?, ?, ?, ?)`,
  [ownerAnnualId, ownerStudentId, ownerEntryEnrollmentId, Number(assessmentResult.insertId), scheduleId,
    'd'.repeat(64), registrarId, uuid(), 'e'.repeat(64)]);

  await rawPool.execute(`INSERT INTO documents
      (student_id, document_type, original_filename, stored_filename, mime_type, file_size_bytes,
       uploaded_by, upload_source, status, is_legacy_archive, requirement_assignment_id)
    VALUES (?, 'good_moral', 'synthetic-good-moral.pdf', ?, 'application/pdf', ?, ?, 'student', 'valid', 0, NULL)`,
  [ownerStudentId, `${uuid()}.pdf`, PDF.length, ownerId]);

  const facade = new PoolFacade(rawPool);
  const getPool = async () => facade;
  const requirementService = createRequirementService({ getPool, sql, transactionFactory: (pool) => new Transaction(pool) });
  const documentService = createDocumentService({ getPool, sql, transactionFactory: (pool) => new Transaction(pool), storageDirectory: storageRoot });
  const masterlistService = createRegistrarMasterlistService({ getPool, sql, transactionFactory: (pool) => new Transaction(pool) });

  await rawPool.execute('UPDATE academic_terms SET is_current = 0');
  const noCurrentOptions = await masterlistService.getFilterOptions(registrarId, {});
  assert.equal(noCurrentOptions.selectedSchoolYear, '', 'no current school year requires an explicit export choice');
  assert.equal((await masterlistService.getFilterOptions(registrarId, { schoolYear: '2026-2027' })).selectedSchoolYear, '2026-2027',
    'an explicit recorded historical year remains available without a current year');
  await assert.rejects(masterlistService.generateExport(registrarId, {}), /Choose an available school year/);
  await rawPool.execute('UPDATE academic_terms SET is_current = 1 WHERE id = ?', [termIds[0]]);

  const exportResult = await masterlistService.generateExport(registrarId, { schoolYear: '2026-2027', gradeLevel: 'Grade 12' });
  try {
    assert.equal(exportResult.rowCount, 30, 'the complete annual cohort includes archived records');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(exportResult.filePath);
    assert.deepEqual(workbook.worksheets.map(({ name }) => name), ['Overall masterlist', 'Term 1 summary', 'Term 2 summary', 'Term 3 summary']);
    const overall = workbook.getWorksheet('Overall masterlist');
    assert.match(overall.getCell('A1').value, /School Year 2026-2027 · Grade 12 · Cohort: All terms/);
    assert.equal(overall.getRow(3).cellCount, 70);
    assert.equal(overall.getRow(4).getCell(12).value, '000000000001');
    assert.equal(overall.getRow(4).getCell(12).type, ExcelJS.ValueType.String);
    assert.equal(overall.getRow(4).getCell(13).value, '=1+2 Alpha');
    assert.equal(overall.getRow(4).getCell(13).type, ExcelJS.ValueType.String);
    assert.equal(overall.getRow(4).getCell(13).formula, undefined, 'formula-like text remains a literal string cell');
    assert.ok(overall.getRow(4).getCell(19).value instanceof Date, 'birth date is a typed Excel date');
    assert.equal(overall.getRow(4).getCell(19).value.toISOString().slice(0, 10), '2008-02-29', 'date-only birth dates are not timezone shifted');
    assert.equal(overall.getRow(4).getCell(19).numFmt, 'yyyy-mm-dd');
    assert.equal(overall.getRow(4).getCell(24).value.toISOString().slice(0, 10), '2026-06-15', 'UTC enrollment timestamps use the Manila calendar date');
    assert.equal(overall.getRow(4).getCell(25).value, 'Enrolled', 'term remarks use the recorded term status');
    assert.equal(overall.getRow(4).getCell(32).value, 'Transferred', 'departure and term remarks retain their saved status');
    assert.equal(overall.getRow(4).getCell(39).value, 'Dropped');
    assert.equal(overall.getRow(4).getCell(53).value,
      'Term 2 · Transferred · 2026-10-15 · Synthetic transfer reason', 'departure date and reason come from the saved departure case');
    assert.equal(overall.getRow(4).getCell(57).value, 'verified; originals: 1, copies: 2, pieces: 0', 'historic paper counts survive migration and print');
    assert.equal(overall.getRow(4).getCell(60).value, null, 'a digital Good Moral file never fills the paper-copy column');
    assert.equal(overall.views[0].xSplit, 1, 'only the first serial-number column is frozen');
    assert.equal(overall.getCell('A2').font.bold, true, 'group headings retain workbook hierarchy');
    assert.equal(overall.getCell('A2').fill.fgColor.argb, 'FF244548');
    assert.equal(overall.getCell('A3').font.bold, true, 'column headers remain visually distinct');
    assert.equal(overall.getCell('A3').fill.fgColor.argb, 'FFE4EFEC');
    assert.equal(overall.pageSetup.orientation, 'landscape');
    assert.equal(overall.pageSetup.fitToPage, false, 'the 70-column overall sheet paginates horizontally at readable scale');
    assert.equal(overall.pageSetup.scale, 100);
    assert.match(overall.autoFilter, /^A3:BR/);
    assert.match(workbook.getWorksheet('Term 1 summary').getCell('A1').value, /School Year 2026-2027/);
    const term1Totals = workbook.getWorksheet('Term 1 summary').getRows(3, workbook.getWorksheet('Term 1 summary').rowCount - 2)
      .filter((row) => row.getCell(1).value === 'TOTAL');
    assert.equal(term1Totals.reduce((sum, row) => sum + Number(row.getCell(5).value || 0), 0), 30);
    assert.equal(term1Totals.find((row) => row.getCell(4).value === 'Confirmed enrolled').getCell(5).value, 1);
    const term2Totals = workbook.getWorksheet('Term 2 summary').getRows(3, workbook.getWorksheet('Term 2 summary').rowCount - 2)
      .filter((row) => row.getCell(1).value === 'TOTAL');
    assert.equal(term2Totals.reduce((sum, row) => sum + Number(row.getCell(5).value || 0), 0), 30);
    assert.equal(term2Totals.find((row) => row.getCell(4).value === 'transferred').getCell(5).value, 1);
    const term3Totals = workbook.getWorksheet('Term 3 summary').getRows(3, workbook.getWorksheet('Term 3 summary').rowCount - 2)
      .filter((row) => row.getCell(1).value === 'TOTAL');
    assert.equal(term3Totals.reduce((sum, row) => sum + Number(row.getCell(5).value || 0), 0), 30,
      'a student without a term placement appears in a separate summary status');
    assert.equal(term3Totals.find((row) => row.getCell(4).value === 'dropped').getCell(5).value, 1,
      'later term status remains reportable even after a prior placement status changed');
    if (process.env.ENROLLMENT_REPORTING_RETAIN_WORKBOOK) {
      const retainedPath = path.resolve(process.env.ENROLLMENT_REPORTING_RETAIN_WORKBOOK);
      assert.ok(retainedPath.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), 'retained workbook must stay under /tmp');
      await fs.copyFile(exportResult.filePath, retainedPath);
      await fs.chmod(retainedPath, 0o600);
    }
  } finally {
    await exportResult.cleanup();
  }

  const sectionExport = await masterlistService.generateExport(registrarId, {
    schoolYear: '2026-2027', gradeLevel: 'Grade 12', term: '2', sectionId: String(sectionIds[1])
  });
  try {
    assert.equal(sectionExport.rowCount, 16, 'term and section filters select cohort membership');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(sectionExport.filePath);
    const overall = workbook.getWorksheet('Overall masterlist');
    assert.match(overall.getCell('A1').value, /Cohort: Term 2 · Section 2 · ABM/);
    assert.ok(overall.getRow(4).getCell(21).value, 'selected students retain their other same-year term placements');
    assert.ok(overall.getRow(4).getCell(35).value, 'the selected term placement remains populated');
  } finally {
    await sectionExport.cleanup();
  }

  const digitalCatalog = await requirementService.createCatalogItem(databaseAdminId, {
    displayName: 'School Permission Letter', instructions: 'Upload a clear copy.\nKeep all pages together.', channel: 'both'
  });
  await assert.rejects(requirementService.createCatalogItem(databaseAdminId, {
    displayName: 'SF-10 copy', instructions: 'Upload it.', channel: 'paper'
  }), /restricted Form 137 or SF10/);
  await assert.rejects(requirementService.createCatalogItem(databaseAdminId, {
    displayName: 'School letter', instructions: 'Attach Form 137.', channel: 'paper'
  }), /cannot expose restricted Form 137 or SF10/);
  await assert.rejects(requirementService.assign(registrarId, studentIds.at(-1), {
    catalogId: String(digitalCatalog.id), catalogVersion: String(digitalCatalog.version),
    schoolYear: '2026-2027', isRequired: '1'
  }), /Archived student records are read-only/);

  const assignment = await requirementService.assign(registrarId, ownerStudentId, {
    catalogId: String(digitalCatalog.id), catalogVersion: String(digitalCatalog.version),
    schoolYear: '2026-2027', isRequired: '1'
  });
  const [historicalTermResult] = await rawPool.execute('INSERT INTO academic_terms (school_year, term, is_current) VALUES (?, ?, 0)',
    ['2027-2028', 'Term 1']);
  const historicalTermId = Number(historicalTermResult.insertId);
  const [historicalSectionResult] = await rawPool.execute(`INSERT INTO sections
      (name, grade_level, academic_term_id, strand, adviser, modality)
    VALUES ('Historical Section', 'Grade 12', ?, 'STEM', 'Historical Adviser', 'onsite')`, [historicalTermId]);
  await createCustomAnnual(rawPool, ownerStudentId, registrarId, 1, [historicalTermId], [Number(historicalSectionResult.insertId)], {
    termCount: 1, schoolYear: '2027-2028'
  });
  const secondYearAssignment = await requirementService.assign(registrarId, ownerStudentId, {
    catalogId: String(digitalCatalog.id), catalogVersion: String(digitalCatalog.version),
    schoolYear: '2027-2028', isRequired: '0'
  });
  assert.ok(secondYearAssignment.id, 'the same catalog requirement can be assigned independently for another recorded year');
  await assert.rejects(requirementService.assign(registrarId, ownerStudentId, {
    catalogId: String(digitalCatalog.id), catalogVersion: String(digitalCatalog.version),
    schoolYear: '2030-2031', isRequired: '0'
  }), /school year recorded/);
  const manualChecklist = { sourceInspected: 'yes', typeConfirmed: 'yes', readableComplete: 'yes' };
  const paperEvent = await requirementService.recordPaper(registrarId, assignment.id, {
    studentId: ownerStudentId, status: 'verified', checklist: manualChecklist, idempotencyKey: uuid()
  });
  const [paperEventRow] = await rawPool.execute(`SELECT requirement_assignment_id, verification_checklist_json
    FROM student_physical_checklist_events WHERE id = ?`, [paperEvent.id]);
  assert.equal(Number(paperEventRow[0].requirement_assignment_id), assignment.id);
  assert.deepEqual(JSON.parse(paperEventRow[0].verification_checklist_json), {
    schemaVersion: 1, sourceInspected: true, typeConfirmed: true, readableComplete: true
  });

  const uploadFile = () => ({ buffer: PDF, size: PDF.length, originalname: 'synthetic-permission.pdf', mimetype: 'application/pdf' });
  const customDocument = await documentService.upload(ownerId, {
    documentType: digitalCatalog.requirementCode, requirementAssignmentId: String(assignment.id)
  }, uploadFile());
  assert.equal(customDocument.status, 'needs_review');
  await assert.rejects(documentService.upload(otherStudentUserId, {
    documentType: digitalCatalog.requirementCode, requirementAssignmentId: String(assignment.id)
  }, uploadFile()), (error) => error.status === 404 || error.status === 403);
  await assert.rejects(documentService.upload(ownerId, { documentType: digitalCatalog.requirementCode }, uploadFile()), /assigned school-year requirement/);
  const safeCorrectionInstruction = 'Please include every page and make the school year readable.';
  await documentService.decideDocument(registrarId, customDocument.id, 'correction_requested', safeCorrectionInstruction);
  const studentDetail = await documentService.getDocument(ownerId, String(customDocument.id));
  assert.equal(studentDetail.requirement_display_name, 'School Permission Letter');
  assert.equal(studentDetail.decisions[0].reason, safeCorrectionInstruction, 'the latest custom correction instruction is student-facing');
  assert.equal(studentDetail.validation, null, 'custom digital requirements never receive an AI validation row');
  const studentProgress = await requirementService.getStudentProgress(ownerId, '2026-2027');
  const customProgress = studentProgress.customRequirements.find((item) => item.id === assignment.id);
  assert.equal(customProgress.digitalStatus, 'correction_requested');
  assert.equal(customProgress.canCorrect, true);
  assert.equal(Object.hasOwn(customProgress, 'withdrawal_reason'), false);
  const correctedDocument = await documentService.reupload(ownerId, String(customDocument.id), uploadFile());
  assert.equal(correctedDocument.status, 'needs_review');
  const supersededStudentDetail = await documentService.getDocument(ownerId, String(customDocument.id));
  assert.equal(supersededStudentDetail.decisions[0].reason, null, 'superseded custom correction instructions are no longer shown');
  await assert.rejects(documentService.addReviewEvent(registrarId, customDocument.id, 'correction_requested', 'Stale instruction.'), /newer custom submission/);
  await assert.rejects(documentService.decideDocument(registrarId, customDocument.id, 'rejected', 'Stale private reason.'), /newer custom submission/);
  await documentService.addReviewEvent(registrarId, correctedDocument.id, 'correction_requested', 'Please verify the school name is visible.');
  const latestStudentDetail = await documentService.getDocument(ownerId, String(correctedDocument.id));
  assert.equal(latestStudentDetail.reviewEvents[0].instruction, 'Please verify the school name is visible.', 'latest correction-event instructions are shown to the assigned student');
  const [sameAssignmentHistory] = await rawPool.execute(`SELECT COUNT(*) AS count FROM documents
    WHERE requirement_assignment_id = ? AND document_type = ?`, [assignment.id, digitalCatalog.requirementCode]);
  assert.equal(Number(sameAssignmentHistory[0].count), 2, 'the correction stays within the year-specific assignment history');
  await documentService.decideDocument(registrarId, correctedDocument.id, 'verified', '', manualChecklist);
  const secondYearDocument = await documentService.upload(ownerId, {
    documentType: digitalCatalog.requirementCode, requirementAssignmentId: String(secondYearAssignment.id)
  }, uploadFile());
  await documentService.decideDocument(registrarId, secondYearDocument.id, 'correction_requested', 'Second-year correction instruction.');
  const secondYearCorrection = await documentService.reupload(ownerId, String(secondYearDocument.id), uploadFile());
  await documentService.decideDocument(registrarId, secondYearCorrection.id, 'verified', '', manualChecklist);
  const [yearScopedHistory] = await rawPool.execute(`SELECT requirement_assignment_id, COUNT(*) AS count FROM documents
    WHERE requirement_assignment_id IN (?, ?) GROUP BY requirement_assignment_id`, [assignment.id, secondYearAssignment.id]);
  assert.deepEqual(yearScopedHistory.map((row) => [Number(row.requirement_assignment_id), Number(row.count)]).sort((a, b) => a[0] - b[0]),
    [[assignment.id, 2], [secondYearAssignment.id, 2]], 'uploads, corrections, decisions, and history stay isolated by school-year assignment');
  const [validationCount] = await rawPool.execute('SELECT COUNT(*) AS count FROM document_validations WHERE document_id IN (?, ?)',
    [customDocument.id, correctedDocument.id]);
  assert.equal(Number(validationCount[0].count), 0, 'manual-only custom decisions do not synthesize Gemini validation rows');
  await assert.rejects(documentService.requestPrecheckRetry(registrarId, correctedDocument.id), /reviewed manually/);

  const privateReason = 'PRIVATE-STAFF-REJECTION-REASON-SYNTHETIC';
  const privateCatalog = await requirementService.createCatalogItem(databaseAdminId, {
    displayName: 'Private Decision Fixture', instructions: 'Upload the assigned document.', channel: 'digital'
  });
  const privateAssignment = await requirementService.assign(registrarId, ownerStudentId, {
    catalogId: String(privateCatalog.id), catalogVersion: String(privateCatalog.version),
    schoolYear: '2026-2027', isRequired: '0'
  });
  const privateDocument = await documentService.upload(ownerId, {
    documentType: privateCatalog.requirementCode, requirementAssignmentId: String(privateAssignment.id)
  }, uploadFile());
  await documentService.decideDocument(registrarId, privateDocument.id, 'rejected', privateReason);
  const safeProgress = await requirementService.getStudentProgress(ownerId, '2026-2027');
  const safeHtml = await ejs.renderFile(path.join(projectRoot, 'views/student/enrollment.ejs'), {
    title: 'Enrollment progress', currentUser: { role: 'student' }, navigationItems: [], navigationGroups: [],
    csrfToken: 'synthetic-csrf', error: null, notice: null, progress: safeProgress
  });
  assert.equal(safeHtml.includes(privateReason), false, 'student enrollment HTML never renders custom rejection reasons');
  assert.equal(JSON.stringify(safeProgress).includes('withdrawal_reason'), false, 'student DTO omits private assignment history');

  const processingService = createDocumentProcessingService({ getPool, sql, storageDirectory: storageRoot,
    extractor: async () => { throw new Error('custom documents must never reach the extractor'); }, autoStart: false });
  await rawPool.execute("UPDATE documents SET status = 'pending' WHERE id = ?", [correctedDocument.id]);
  const directProcessing = await processingService.processPendingDocument(correctedDocument.id);
  assert.equal(directProcessing.status, 'not_pending', 'direct worker calls cannot claim a custom document');
  const [pendingCustom] = await rawPool.execute('SELECT status FROM documents WHERE id = ?', [correctedDocument.id]);
  assert.equal(pendingCustom[0].status, 'pending');

  const secondPaperCatalog = await requirementService.createCatalogItem(databaseAdminId, {
    displayName: 'Archive Permission Card', instructions: 'Keep the original safe.', channel: 'paper'
  });
  const secondPaperAssignment = await requirementService.assign(registrarId, otherStudentId, {
    catalogId: String(secondPaperCatalog.id), catalogVersion: String(secondPaperCatalog.version),
    schoolYear: '2026-2027', isRequired: '0'
  });
  await requirementService.withdraw(registrarId, secondPaperAssignment.id, {
    studentId: otherStudentId, version: '1', reason: 'Synthetic reason kept for staff history.'
  });
  await assert.rejects(requirementService.recordPaper(registrarId, secondPaperAssignment.id, {
    studentId: otherStudentId, status: 'received', idempotencyKey: uuid()
  }), /Withdrawn requirements do not accept/);

  const withdrawnDigitalAssignment = await requirementService.assign(registrarId, otherStudentId, {
    catalogId: String(digitalCatalog.id), catalogVersion: String(digitalCatalog.version),
    schoolYear: '2026-2027', isRequired: '1'
  });
  const withdrawnDigitalDocument = await documentService.upload(otherStudentUserId, {
    documentType: digitalCatalog.requirementCode, requirementAssignmentId: String(withdrawnDigitalAssignment.id)
  }, uploadFile());
  await requirementService.withdraw(registrarId, withdrawnDigitalAssignment.id, {
    studentId: otherStudentId, version: '1', reason: 'Withdrawn before review.'
  });
  await assert.rejects(documentService.addReviewEvent(registrarId, withdrawnDigitalDocument.id,
    'correction_requested', 'This must not be recorded.'), /Withdrawn requirements are read-only/);
  await assert.rejects(documentService.decideDocument(registrarId, withdrawnDigitalDocument.id,
    'rejected', 'This must not be recorded.'), /Withdrawn requirements are read-only/);

  const archiveGateCatalog = await requirementService.createCatalogItem(databaseAdminId, {
    displayName: 'Archive Gate Digital', instructions: 'Upload the assigned file.', channel: 'digital'
  });
  const archiveGateAssignment = await requirementService.assign(registrarId, otherStudentId, {
    catalogId: String(archiveGateCatalog.id), catalogVersion: String(archiveGateCatalog.version),
    schoolYear: '2026-2027', isRequired: '1'
  });
  const archiveGateDocument = await documentService.upload(otherStudentUserId, {
    documentType: archiveGateCatalog.requirementCode, requirementAssignmentId: String(archiveGateAssignment.id)
  }, uploadFile());
  const archivedPaperCatalog = await requirementService.createCatalogItem(databaseAdminId, {
    displayName: 'Archive Gate Paper', instructions: 'Bring the paper copy.', channel: 'paper'
  });
  const archivedPaperAssignment = await requirementService.assign(registrarId, otherStudentId, {
    catalogId: String(archivedPaperCatalog.id), catalogVersion: String(archivedPaperCatalog.version),
    schoolYear: '2026-2027', isRequired: '1'
  });
  await rawPool.execute("UPDATE students SET status = 'archived' WHERE id = ?", [otherStudentId]);
  await assert.rejects(documentService.addReviewEvent(registrarId, archiveGateDocument.id,
    'correction_requested', 'Must remain unchanged.'), /Archived student records are read-only/);
  await assert.rejects(documentService.decideDocument(registrarId, archiveGateDocument.id,
    'rejected', 'Must remain unchanged.'), /Archived student records are read-only/);
  await assert.rejects(requirementService.recordPaper(registrarId, archivedPaperAssignment.id, {
    studentId: otherStudentId, status: 'received', idempotencyKey: uuid()
  }), /Archived student records are read-only/);
  const readOnlyWithdrawnDetail = await documentService.getDocument(registrarId, String(withdrawnDigitalDocument.id));
  assert.ok(readOnlyWithdrawnDetail, 'staff can still read retained withdrawn digital history');
  const [blockedDecisionCount] = await rawPool.execute(`SELECT COUNT(*) AS count FROM document_decision_events
    WHERE document_id IN (?, ?)`, [withdrawnDigitalDocument.id, archiveGateDocument.id]);
  assert.equal(Number(blockedDecisionCount[0].count), 0, 'rejected direct writes leave review and decision history untouched');

  const exportAudit = await rawPool.execute(`SELECT details_json FROM audit_logs
    WHERE action = 'registrar.enrollment_masterlist_exported' ORDER BY id DESC LIMIT 1`);
  const auditDetails = JSON.parse(exportAudit[0][0].details_json);
  assert.deepEqual(Object.keys(auditDetails).sort(), ['gradeLevel', 'schoolYear', 'sectionId', 'studentCount', 'termNumber']);
  assert.equal(auditDetails.studentCount, 16);
  assert.equal(JSON.stringify(auditDetails).includes('SYNTH'), false, 'export audits contain no student identifiers or PII');
  assert.equal(typeof databaseAdminId, 'number');
});

test('masterlist rejects cohorts above the cap before loading student details', async () => {
  const queries = [];
  const transaction = {
    active: false,
    async begin() { this.active = true; },
    async commit() { this.active = false; },
    async rollback() { this.active = false; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          queries.push(statement);
          if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
          if (statement.includes('SELECT DISTINCT school_year FROM academic_terms WHERE is_current')) return { recordset: [{ school_year: '2026-2027' }] };
          if (statement.includes('SELECT DISTINCT school_year FROM annual_enrollments')) return { recordset: [{ school_year: '2026-2027' }] };
          if (statement.includes('SELECT DISTINCT section.id')) return { recordset: [] };
          if (statement.includes('SELECT COUNT(*) AS total')) return { recordset: [{ total: 10001 }] };
          throw new Error(`Unexpected masterlist query: ${statement}`);
        }
      };
    }
  };
  const service = createRegistrarMasterlistService({ getPool: async () => ({}), sql,
    transactionFactory: () => transaction });
  await assert.rejects(service.generateExport(7, { schoolYear: '2026-2027', gradeLevel: 'Grade 12' }),
    (error) => error instanceof RegistrarMasterlistError && error.status === 413);
  assert.equal(queries.some((statement) => statement.includes('FROM students AS student')), false);
});

test('masterlist requires an explicit recorded year when current-year configuration is ambiguous', async () => {
  const transaction = {
    active: false,
    async begin() { this.active = true; },
    async commit() { this.active = false; },
    async rollback() { this.active = false; },
    request() {
      return {
        input() { return this; },
        async query(statement) {
          if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
          if (statement.includes('SELECT DISTINCT school_year FROM academic_terms WHERE is_current')) {
            return { recordset: [{ school_year: '2026-2027' }, { school_year: '2027-2028' }] };
          }
          if (statement.includes('SELECT DISTINCT school_year FROM annual_enrollments')) {
            return { recordset: [{ school_year: '2027-2028' }, { school_year: '2026-2027' }] };
          }
          if (statement.includes('SELECT DISTINCT section.id')) return { recordset: [] };
          throw new Error(`Unexpected masterlist query: ${statement}`);
        }
      };
    }
  };
  const service = createRegistrarMasterlistService({ getPool: async () => ({}), sql,
    transactionFactory: () => transaction });
  const options = await service.getFilterOptions(7, {});
  assert.equal(options.currentSchoolYear, '');
  assert.equal(options.selectedSchoolYear, '');
  assert.equal((await service.getFilterOptions(7, { schoolYear: '2026-2027' })).selectedSchoolYear, '2026-2027');
  await assert.rejects(service.generateExport(7, {}), (error) => error instanceof RegistrarMasterlistError && error.status === 409);
});
