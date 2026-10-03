/*
 * Destructive only to its own uniquely named temporary database. Never points at
 * the configured ARKTIESIIS_V2 database. Run with: node tests/annual-finance-sql-smoke.js
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sql = require('mssql');
const env = require('../src/config/environment');
const { splitSqlBatches, readForwardMigrations, applyPendingMigrations } = require('../scripts/db-setup-v2');
const { createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { createAnnualFinanceCasesService } = require('../src/services/annualFinanceCasesService');
const { createAnnualFinanceReportsService } = require('../src/services/annualFinanceReportsService');
const { createFinanceService } = require('../src/services/financeService');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');
const { createPhysicalChecklistService } = require('../src/services/physicalChecklistService');
const { createAdminService } = require('../src/services/adminService');
const { createStudentDocumentRequestService } = require('../src/services/studentDocumentRequestService');
const { createRegistrarGradeOverviewService } = require('../src/services/registrarGradeOverviewService');
const { createStudentRecordsService } = require('../src/services/studentRecordsService');

const DATABASE_PREFIX = 'ARKTIESIIS_RevisionSmoke_';
const databaseName = `${DATABASE_PREFIX}${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
const safeName = (value) => `[${value.replaceAll(']', ']]')}]`;
const connectionConfig = (database, max = 10) => ({
  server: env.database.server,
  port: env.database.port,
  database,
  user: env.database.user,
  password: env.database.password,
  options: { encrypt: env.database.encrypt, trustServerCertificate: env.database.trustServerCertificate },
  requestTimeout: 15000,
  connectionTimeout: 15000,
  pool: { max, min: 0, idleTimeoutMillis: 30000 }
});
const token = () => crypto.randomUUID();
const tuitionLines = (amounts) => [1, 2, 3].flatMap((termNumber) => ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment, index) => ({
  termNumber, feeCategory: 'tuition', lineName: 'Tuition', installment,
  amount: index === 0 ? amounts[termNumber - 1] : '0.00'
})));
const tests = [];
const passed = (label) => {
  tests.push(label);
  process.stdout.write(`[sql smoke] ${label}\n`);
};
let stage = 'connect';
const baseQuery = sql.Request.prototype.query;
sql.Request.prototype.query = function tracedQuery(command, callback) {
  const result = baseQuery.call(this, command, callback);
  if (result && typeof result.catch === 'function') {
    return result.catch((error) => {
      if (/Incorrect syntax near the keyword 'ORDER'/i.test(error.message || '') && typeof command === 'string') {
        const lines = command.split(/\r?\n/);
        const start = Math.max(0, Number(error.lineNumber || 1) - 4);
        const end = Math.min(lines.length, Number(error.lineNumber || 1) + 3);
        process.stderr.write(`[failed SQL lines ${start + 1}-${end}]\n${lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n')}\n`);
      }
      throw error;
    });
  }
  return result;
};
const expect409 = async (promise, pattern) => {
  await assert.rejects(promise, (error) => error.status === 409 && (!pattern || pattern.test(error.message)));
};
const expect404 = async (promise) => {
  await assert.rejects(promise, (error) => error.status === 404);
};
const expect403 = async (promise) => {
  await assert.rejects(promise, (error) => error.status === 403);
};

async function main() {
  if (databaseName === 'ARKTIESIIS_V2' || !databaseName.startsWith(DATABASE_PREFIX)) throw new Error('Unsafe temporary database name.');
  const master = new sql.ConnectionPool(connectionConfig('master', 1));
  let pool;
let financeId;
let registrarId;
let adminId;
let studentUserId;
  let legacyStudentId;
  let legacyStudentUserId;
  let legacyEnrollmentId;
  let legacyTermId;
  let legacySectionId;
  let legacyTransactionId;
  let legacyParentId;
  let terms = [];
  let sections = [];
  try {
    await master.connect();
    await master.request().query(`CREATE DATABASE ${safeName(databaseName)};`);
    pool = new sql.ConnectionPool(connectionConfig(databaseName));
    await pool.connect();

    stage = 'apply baseline';
    const baseline = splitSqlBatches(fs.readFileSync(path.resolve(__dirname, '../database/v2/schema.sql'), 'utf8'));
    for (const batch of baseline.slice(2)) await pool.request().batch(batch);
    const migrations = readForwardMigrations();
    const v005Index = migrations.findIndex((migration) => migration.version === 'v2.005');
    if (v005Index < 0) throw new Error('The required v2.005 compatibility migration is unavailable.');
    stage = 'apply forward migrations 002–004 through runner';
    await applyPendingMigrations(pool, migrations.slice(0, v005Index), { sqlDriver: sql });
    stage = 'seed legacy rows after 004 and before 005';
    await seedPre005Fixture();
    stage = 'apply forward migrations 005–009 through runner';
    await applyPendingMigrations(pool, migrations.slice(v005Index), { sqlDriver: sql });
    assert.equal(migrations.at(-1)?.version, 'v2.009');
    passed('fresh V2 baseline and forward migrations 002–009 apply with runner-owned version markers to an isolated database');

    stage = 'seed synthetic users, terms, students, and placements';
    studentUserId = await insertUser('student-b-active', 'student');
    for (const [schoolYear, current] of [['2026-2027', true]]) {
      for (let number = 1; number <= 3; number += 1) {
        const result = await pool.request().input('schoolYear', sql.NVarChar(20), schoolYear)
          .input('term', sql.NVarChar(30), `Term ${number}`)
          .input('isCurrent', sql.Bit, current && number === 1)
          .query(`INSERT INTO dbo.academic_terms (school_year, term, is_current)
            OUTPUT INSERTED.id AS id VALUES (@schoolYear, @term, @isCurrent)`);
        terms.push({ schoolYear, number, id: result.recordset[0].id });
      }
    }
    sections = [];
    for (const term of terms) {
      const result = await pool.request()
        .input('termId', sql.Int, term.id)
        .input('name', sql.NVarChar(100), `Synthetic ${term.schoolYear} T${term.number}`)
        .query(`INSERT INTO dbo.sections (name, grade_level, academic_term_id, cluster, strand, adviser, modality, modular_subtype)
          OUTPUT INSERTED.id AS id VALUES (@name, N'Grade 11', @termId, N'Cluster A', N'STEM', N'Synthetic Adviser', N'modular', N'printed')`);
      sections.push({ ...term, sectionId: result.recordset[0].id });
    }
    const enrollmentService = createAnnualEnrollmentService({ getPool: async () => pool, sql,
      hashPassword: async (password) => `synthetic-hash:${password}`,
      createPassword: () => 'synthetic-temporary-password' });
    await enrollmentService.configureSchoolYearTermOrder(registrarId, {
      schoolYear: '2026-2027', term1Id: terms[0].id, term2Id: terms[1].id, term3Id: terms[2].id
    });
    const studentA = legacyStudentId;
    const studentB = await insertStudent('SYNTH-B-002', '901000000002', studentUserId, '0.00');
    const studentC = await insertStudent('SYNTH-C-003', '901000000003', null, '0.00');
    const parentA = await insertAnnual(studentA, 'PUB');
    const parentB = await insertAnnual(studentB, 'ESC');
    const parentC = await insertAnnual(studentC, 'PUB');
    const registrarCounts = await enrollmentService.listAnnualEnrollmentCounts(registrarId, { schoolYear: '2026-2027' });
    assert.equal(registrarCounts.length, 3, 'all three configured terms have one grouped roster count');
    assert.ok(registrarCounts.every((row) => Number(row.student_count) === 3 && row.strand === 'STEM'));
    assert.ok(registrarCounts.every((row) => row.enrollment_status === 'pending_payment'));
    const voucherCounts = await enrollmentService.listAnnualEnrollmentCounts(registrarId, { schoolYear: '2026-2027', voucherCode: 'PUB' });
    assert.equal(voucherCounts.length, 3);
    assert.ok(voucherCounts.every((row) => Number(row.student_count) === 2));
    const searchCounts = await enrollmentService.listAnnualEnrollmentCounts(registrarId, { schoolYear: '2026-2027', search: 'SYNTH-B-002' });
    assert.equal(searchCounts.length, 3);
    assert.ok(searchCounts.every((row) => Number(row.student_count) === 1));
    passed('registrar counts group distinct applicable students by configured term, section, strand, gender, and status');
    legacyParentId = await scalar(`SELECT id AS value FROM dbo.annual_enrollments
      WHERE student_id = @studentId AND school_year = N'2025-2026'`, { studentId: studentA });
    const legacyParent = { id: legacyParentId };
    const legacyPreserved = await pool.request()
      .input('enrollmentId', sql.Int, legacyEnrollmentId)
      .input('parentId', sql.Int, legacyParent.id)
      .input('transactionId', sql.Int, legacyTransactionId)
      .query(`SELECT enrollment.id AS enrollment_id, term.term, enrollment.annual_enrollment_id,
          parent.intake_status, parent.account_activation_pending,
          clearance.account_activation_pending AS clearance_activation_pending,
          transaction_record.is_legacy_unattributed
        FROM dbo.enrollments AS enrollment
        INNER JOIN dbo.academic_terms AS term ON term.id = enrollment.academic_term_id
        INNER JOIN dbo.annual_enrollments AS parent ON parent.id = enrollment.annual_enrollment_id
        INNER JOIN dbo.enrollment_clearances AS clearance ON clearance.enrollment_id = enrollment.id
        INNER JOIN dbo.financial_transactions AS transaction_record ON transaction_record.id = @transactionId
        WHERE enrollment.id = @enrollmentId AND parent.id = @parentId`);
    assert.equal(legacyPreserved.recordset[0]?.enrollment_id, legacyEnrollmentId);
    assert.equal(legacyPreserved.recordset[0]?.term, 'Semester 2');
    assert.equal(legacyPreserved.recordset[0]?.intake_status, 'legacy');
    assert.equal(legacyPreserved.recordset[0]?.account_activation_pending, false);
    assert.equal(legacyPreserved.recordset[0]?.clearance_activation_pending, false);
    assert.equal(legacyPreserved.recordset[0]?.is_legacy_unattributed, true);
    assert.equal(await scalar('SELECT is_active AS value FROM dbo.users WHERE id = @userId', { userId: legacyStudentUserId }), false);
    passed('migration 005 preserves a preexisting semester row, clearance, inactive-login state, and unattributed finance transaction');
    const finance = createAnnualFinanceService({ getPool: async () => pool, sql });
    const financeCases = createAnnualFinanceCasesService({ getPool: async () => pool, sql });
    const financeReports = createAnnualFinanceReportsService({ getPool: async () => pool, sql });
    const checklist = createPhysicalChecklistService({ getPool: async () => pool, sql });
    let passwordSequence = 0;
    const activationEnrollmentService = createAnnualEnrollmentService({ getPool: async () => pool, sql,
      hashPassword: async (password) => `synthetic-hash:${password}`,
      createPassword: () => `synthetic-temporary-${++passwordSequence}`, annualFinanceService: finance,
      physicalChecklistService: checklist });
    const documentRequestService = createStudentDocumentRequestService({ getPool: async () => pool, sql });
    const gradeOverviewService = createRegistrarGradeOverviewService({ getPool: async () => pool, sql });
    const recordsService = createStudentRecordsService({ getPool: async () => pool, sql });
    const adminService = createAdminService({ getPool: async () => pool, sql, hashPassword: async (password) => `synthetic-hash:${password}` });

    stage = 'persist and review newly structured profile and annual administration fields';
    const profileBefore = (await pool.request().input('studentId', sql.Int, studentA).query(`SELECT student_no, lrn, first_name, middle_name, last_name, suffix,
        CONVERT(NVARCHAR(10), birth_date, 23) AS birth_date, sex, address, phone
      FROM dbo.students WHERE id = @studentId`)).recordset[0];
    await recordsService.saveStudent(adminId, studentA, {
      studentNo: profileBefore.student_no, lrn: profileBefore.lrn, firstName: profileBefore.first_name,
      middleName: profileBefore.middle_name || '', lastName: profileBefore.last_name, suffix: profileBefore.suffix || '',
      birthDate: profileBefore.birth_date || '', sex: profileBefore.sex || '', address: profileBefore.address || '',
      phone: profileBefore.phone || '', birthplace: 'Synthetic City', emergencyContactPerson: 'Synthetic Contact'
    });
    const profileRevisions = await recordsService.listStudentProfileRevisions(adminId, studentA);
    assert.ok(profileRevisions.some((revision) => revision.field_name === 'birthplace' && revision.after_value === 'Synthetic City'));
    assert.ok(profileRevisions.some((revision) => revision.field_name === 'emergency_contact_person' && revision.after_value === 'Synthetic Contact'));
    const annualAdministrationInput = { escId: 'SYN-ESC-001', eformStatus: 'submitted', eformRemarks: 'Synthetic submission record',
      lisStatus: 'pending', vmsStatus: 'not_applicable', acquaintanceWaiverStatus: 'complete', acquaintanceParty: 'Synthetic party',
      educationalTourStatus: 'participating', internalAgreementRemarks: 'Synthetic administrative note',
      modulesClaimedDate: '2026-08-01', studentIdClaimedDate: '2026-08-02', uniformClaimedDate: '2026-08-03', peUniformClaimedDate: '2026-08-04' };
    const annualAdministrationSave = await activationEnrollmentService.updateAnnualAdministrationDetails(registrarId, parentA.id, annualAdministrationInput);
    assert.ok(annualAdministrationSave.changedFields.includes('eform_status'));
    assert.ok(annualAdministrationSave.changedFields.includes('esc_id'));
    await expect403(activationEnrollmentService.updateAnnualAdministrationDetails(financeId, parentA.id, annualAdministrationInput));
    const annualHistory = await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.annual_enrollment_admin_revisions WHERE annual_enrollment_id = @annualId', { annualId: parentA.id });
    assert.equal(Number(annualHistory), 13);
    passed('workbook reference fields persist with registrar/database-admin access and append-only before/after history');

    stage = 'exercise returning and new annual intake activation';
    const intakeTerms = [];
    for (let number = 1; number <= 3; number += 1) {
      const term = await pool.request().input('term', sql.NVarChar(30), `Term ${number}`)
        .query(`INSERT INTO dbo.academic_terms (school_year, term, is_current)
          OUTPUT INSERTED.id AS id VALUES (N'2027-2028', @term, 0)`);
      const section = await pool.request().input('termId', sql.Int, term.recordset[0].id)
        .input('name', sql.NVarChar(100), `Synthetic new intake T${number}`)
        .query(`INSERT INTO dbo.sections (name, grade_level, academic_term_id)
          OUTPUT INSERTED.id AS id VALUES (@name, N'Grade 11', @termId)`);
      intakeTerms.push({ termId: term.recordset[0].id, sectionId: section.recordset[0].id });
    }
    await enrollmentService.configureSchoolYearTermOrder(registrarId, {
      schoolYear: '2027-2028', term1Id: intakeTerms[0].termId, term2Id: intakeTerms[1].termId, term3Id: intakeTerms[2].termId
    });
    const intakeSchedule = await finance.createSchedule(financeId, {
      schoolYear: '2027-2028', gradeLevel: 'Grade 11', voucherCode: 'PUB',
      lines: [...tuitionLines(['10.00', '10.00', '10.00']), ...[1, 2, 3].map((termNumber) => (
        { termNumber, feeCategory: 'activity', lineName: 'Optional synthetic item', installment: 'Once', amount: '10.00', isOptional: true }
      ))],
      idempotencyKey: token()
    });
    const intakeInput = ({ studentNo = '', email, lrn, idempotencyKey }) => ({
      studentNo, email, lrn, firstName: 'Synthetic', lastName: 'Intake',
      schoolYear: '2027-2028', gradeLevel: 'Grade 11', voucherCode: 'PUB',
      entryTermNumber: 1, enrollmentStartDate: '2027-08-15',
      section1Id: intakeTerms[0].sectionId, section2Id: intakeTerms[1].sectionId, section3Id: intakeTerms[2].sectionId,
      idempotencyKey
    });
    const confirmIntake = async (annualEnrollmentId, idempotencyKey = token(), expectedTotal = null) => {
      const preview = await finance.annualAssessmentPreviewForRegistrar(registrarId, annualEnrollmentId);
      assert.equal(Number(preview.scheduleId), intakeSchedule.scheduleId);
      assert.equal(preview.lines.length, (4 - Number(preview.parent.entry_term_number)) * 4);
      assert.ok(preview.lines.every((line) => !line.isOptional));
      const confirmationInput = {
        scheduleId: preview.scheduleId, scheduleVersion: preview.scheduleVersion,
        voucherCode: preview.voucherCode, assessmentId: preview.assessmentId || '',
        optionalLineIds: preview.optionalLineIds, snapshotFingerprint: preview.snapshotFingerprint, idempotencyKey
      };
      const confirmed = await activationEnrollmentService.confirmAnnualEnrollment(registrarId, annualEnrollmentId, confirmationInput);
      const expectedDefaultTotal = ((4 - Number(preview.parent.entry_term_number)) * 10).toFixed(2);
      assert.equal(confirmed.total, expectedTotal || expectedDefaultTotal);
      assert.equal(confirmed.alreadyConfirmed, false);
      assert.equal((await activationEnrollmentService.confirmAnnualEnrollment(registrarId, annualEnrollmentId, confirmationInput)).alreadyConfirmed, true);
      await expect409(activationEnrollmentService.confirmAnnualEnrollment(registrarId, annualEnrollmentId, {
        ...confirmationInput, voucherCode: 'ESC'
      }));
      assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.annual_registrar_confirmations WHERE annual_enrollment_id = @annualId', { annualId: annualEnrollmentId })), 1);
      assert.equal(await scalar('SELECT enrollment_status AS value FROM dbo.enrollments WHERE id = @enrollmentId', { enrollmentId: confirmed.enrollmentId }), 'enrolled');
      assert.equal(await scalar('SELECT status AS value FROM dbo.term_finance_approvals WHERE enrollment_id = @enrollmentId', { enrollmentId: confirmed.enrollmentId }), 'pending',
        'the historical finance approval record remains pending and does not gate registrar confirmation');
      return confirmed;
    };
    const activateLaterTerm = async (enrollmentId) => {
      return activationEnrollmentService.finalizeAnnualTerm(registrarId, enrollmentId);
    };

    stage = 'verify paper checklist updates roll back with a failed intake';
    const rollbackPaperToken = token();
    const rollbackLrn = '901000000099';
    const rollbackIntakeInput = {
      ...intakeInput({ email: 'synthetic-paper-rollback@example.test', lrn: rollbackLrn, idempotencyKey: token() }),
      paper_birth_certificate_record: '1', paper_birth_certificate_status: 'received',
      paper_birth_certificate_applicable: '1', paper_birth_certificate_originals: '0',
      paper_birth_certificate_copies: '3', paper_birth_certificate_pieces: '0',
      paper_birth_certificate_note: '', paper_birth_certificate_token: rollbackPaperToken
    };
    const failingChecklist = {
      ...checklist,
      async recordIntakeUpdatesInTransaction(...args) {
        await checklist.recordIntakeUpdatesInTransaction(...args);
        throw new Error('synthetic checklist transaction failure');
      }
    };
    const rollbackIntakeService = createAnnualEnrollmentService({ getPool: async () => pool, sql,
      hashPassword: async (password) => `synthetic-hash:${password}`,
      createPassword: () => 'synthetic-temporary-rollback', physicalChecklistService: failingChecklist });
    await assert.rejects(rollbackIntakeService.createAnnualIntake(registrarId, rollbackIntakeInput), /synthetic checklist transaction failure/);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.students WHERE lrn = @lrn', { lrn: rollbackLrn })), 0);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.users WHERE email = @email', { email: 'synthetic-paper-rollback@example.test' })), 0);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.student_physical_checklist_events WHERE idempotency_key = @idempotencyKey', { idempotencyKey: rollbackPaperToken })), 0);
    passed('new profile, annual enrollment, login, and explicitly selected paper event roll back together when checklist recording fails');

    stage = 'record scoped internal athlete and performer enrollment tags';
    for (const tagType of ['internal', 'athlete', 'performer']) {
      const tagInput = { tagType, label: `Synthetic ${tagType}`, note: 'Synthetic registrar classification only.', effectiveTermFrom: 1, effectiveTermTo: 3, idempotencyKey: token() };
      const savedTag = await activationEnrollmentService.recordAnnualTag(registrarId, parentC.id, tagInput);
      assert.ok(savedTag.tagId);
      assert.equal((await activationEnrollmentService.recordAnnualTag(registrarId, parentC.id, tagInput)).alreadyRecorded, true);
      await expect409(activationEnrollmentService.recordAnnualTag(registrarId, parentC.id, { ...tagInput, label: 'Changed after replay' }));
    }
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.annual_enrollment_tags WHERE annual_enrollment_id = @annualId', { annualId: parentC.id })), 3);
    passed('internal, athlete, and performer classifications are term-scoped, append-only finance-neutral tags with idempotent replay');

    stage = 'create a midyear transferee with prior and future placements';
    const midyearIntake = await activationEnrollmentService.createAnnualIntake(registrarId, {
      ...intakeInput({ email: 'synthetic-transferee@example.test', lrn: '901000000014', idempotencyKey: token() }),
      intakeKind: 'transferee', entryTermNumber: 2, enrollmentStartDate: '2027-11-15',
      section1Id: '', section2Id: String(intakeTerms[1].sectionId), section3Id: ''
    });
    const midyearPlacements = await rows(`SELECT annual_term_number, term_scope_status, enrollment_status, section_id
      FROM dbo.enrollments WHERE annual_enrollment_id = @annualId ORDER BY annual_term_number`, { annualId: midyearIntake.annualEnrollmentId });
    assert.deepEqual(midyearPlacements.map((placement) => [Number(placement.annual_term_number), placement.term_scope_status, placement.enrollment_status]), [
      [1, 'not_applicable', 'not_applicable'], [2, 'applicable', 'pending_payment'], [3, 'applicable', 'pending_payment']
    ]);
    assert.equal(Number(midyearPlacements[0].section_id || 0), 0);
    assert.equal(Number(midyearPlacements[1].section_id), intakeTerms[1].sectionId);
    assert.equal(midyearPlacements[2].section_id, null);
    const midyearPreview = await finance.annualAssessmentPreview(financeId, midyearIntake.annualEnrollmentId);
    assert.ok(midyearPreview.lines.every((line) => line.termNumber >= 2));
    assert.equal(midyearPreview.lines.length, 8, 'the midyear assessment includes all four tuition installments for the entry term and each later term');
    assert.deepEqual(midyearPreview.tuitionBreakdown.map((term) => [term.termNumber, term.installments.length, term.installments.every((item) => item.notApplicable === true)]), [
      [1, 4, true], [2, 4, false], [3, 4, false]
    ]);
    assert.equal(midyearPreview.total, '20.00');
    await assert.rejects(activationEnrollmentService.recordAnnualTag(registrarId, midyearIntake.annualEnrollmentId, {
      tagType: 'athlete', label: 'Invalid pre-entry scope', effectiveTermFrom: 1, effectiveTermTo: 1, idempotencyKey: token()
    }), /Enrollment tags cannot be scoped to terms before the student’s entry term/);
    passed('midyear transferee marks earlier term not applicable, assesses required entry-term-onward lines only, and permits unassigned future sections');

    const returningIntake = await activationEnrollmentService.createAnnualIntake(registrarId, intakeInput({
      studentNo: 'SYNTH-A-001', idempotencyKey: token()
    }));
    assert.equal(returningIntake.studentId, legacyStudentId);
    assert.equal(returningIntake.studentNo, 'SYNTH-A-001');
    assert.equal(await scalar('SELECT account_activation_pending AS value FROM dbo.annual_enrollments WHERE id = @annualId', { annualId: returningIntake.annualEnrollmentId }), false);
    const returningBefore = await rows('SELECT is_active, password_hash, auth_session_version FROM dbo.users WHERE id = @userId', { userId: legacyStudentUserId });
    assert.equal(returningBefore[0].is_active, false);
    const returningPreview = await finance.annualAssessmentPreviewForRegistrar(registrarId, returningIntake.annualEnrollmentId);
    await expect403(activationEnrollmentService.confirmAnnualEnrollment(financeId, returningIntake.annualEnrollmentId, {
      scheduleId: returningPreview.scheduleId, scheduleVersion: returningPreview.scheduleVersion,
      voucherCode: returningPreview.voucherCode, assessmentId: '', optionalLineIds: returningPreview.optionalLineIds,
      snapshotFingerprint: returningPreview.snapshotFingerprint, idempotencyKey: token()
    }));
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.annual_assessments WHERE annual_enrollment_id = @annualId', { annualId: returningIntake.annualEnrollmentId })), 0);
    const returningTerm1 = await confirmIntake(returningIntake.annualEnrollmentId);
    assert.equal(returningTerm1.temporaryPassword, null);
    const returningTerm2 = await activateLaterTerm(returningIntake.enrollmentIds[1]);
    assert.equal(returningTerm2.temporaryPassword, null);
    assert.deepEqual(await rows('SELECT is_active, password_hash, auth_session_version FROM dbo.users WHERE id = @userId', { userId: legacyStudentUserId }), returningBefore);
    passed('returning intake reuses its profile and later term finalization preserves an intentionally disabled login');

    const newPaperToken = token();
    const newIntakeInput = {
      ...intakeInput({ email: 'synthetic-new@example.test', lrn: '901000000005', idempotencyKey: token() }),
      paper_birth_certificate_record: '1', paper_birth_certificate_status: 'received',
      paper_birth_certificate_applicable: '1', paper_birth_certificate_originals: '0',
      paper_birth_certificate_copies: '3', paper_birth_certificate_pieces: '0',
      paper_birth_certificate_note: '', paper_birth_certificate_token: newPaperToken
    };
    const newIntake = await activationEnrollmentService.createAnnualIntake(registrarId, newIntakeInput);
    assert.equal(newIntake.isNewStudent, true);
    assert.equal((await activationEnrollmentService.createAnnualIntake(registrarId, newIntakeInput)).alreadyCreated, true);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.student_physical_checklist_events WHERE idempotency_key = @idempotencyKey', { idempotencyKey: newPaperToken })), 1);
    const newUserId = await scalar('SELECT user_id AS value FROM dbo.students WHERE id = @studentId', { studentId: newIntake.studentId });
    const newBefore = await rows('SELECT is_active, password_hash, auth_session_version FROM dbo.users WHERE id = @userId', { userId: newUserId });
    const previewBeforeDiscount = await finance.annualAssessmentPreviewForRegistrar(registrarId, newIntake.annualEnrollmentId);
    const staleConfirmation = {
      scheduleId: previewBeforeDiscount.scheduleId, scheduleVersion: previewBeforeDiscount.scheduleVersion,
      voucherCode: previewBeforeDiscount.voucherCode, assessmentId: '', optionalLineIds: previewBeforeDiscount.optionalLineIds,
      snapshotFingerprint: previewBeforeDiscount.snapshotFingerprint, idempotencyKey: token()
    };
    await financeCases.approveExemptionCase(financeId, newIntake.annualEnrollmentId, {
      expectedStudentId: newIntake.studentId, reason: 'Synthetic approved intake discount.',
      rules: [{ termNumber: 1, feeCategory: 'tuition', lineName: null, isFullCoverage: false, approvedAmount: '5.00' }],
      idempotencyKey: token()
    });
    await expect409(activationEnrollmentService.confirmAnnualEnrollment(registrarId, newIntake.annualEnrollmentId, staleConfirmation), /fee lines changed/i);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.annual_assessments WHERE annual_enrollment_id = @annualId', { annualId: newIntake.annualEnrollmentId })), 0,
      'a discount changed after preview must not post the stale composition');
    const newTerm1 = await confirmIntake(newIntake.annualEnrollmentId, token(), '25.00');
    assert.match(newTerm1.temporaryPassword, /^synthetic-temporary-/);
    const newAfterTerm1 = await rows('SELECT is_active, must_change_password, password_hash, auth_session_version FROM dbo.users WHERE id = @userId', { userId: newUserId });
    assert.equal(newAfterTerm1[0].is_active, true);
    assert.equal(newAfterTerm1[0].must_change_password, true);
    assert.notEqual(newAfterTerm1[0].password_hash, newBefore[0].password_hash);
    assert.notEqual(newAfterTerm1[0].auth_session_version, newBefore[0].auth_session_version);
    const newTerm2 = await activateLaterTerm(newIntake.enrollmentIds[1]);
    assert.equal(newTerm2.temporaryPassword, null);
    assert.deepEqual(await rows('SELECT is_active, must_change_password, password_hash, auth_session_version FROM dbo.users WHERE id = @userId', { userId: newUserId }), newAfterTerm1);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.finance_payments WHERE student_id = @studentId', { studentId: newIntake.studentId })), 0,
      'registrar confirmation and later-term activation do not require payment');
    assert.equal(Number(await scalar('SELECT amount_due AS value FROM dbo.v_finance_assessed_charge_due WHERE charge_id IN (SELECT id FROM dbo.assessed_charges WHERE enrollment_id = @enrollmentId)', { enrollmentId: newIntake.enrollmentIds[1] })), 10);
    passed('registrar confirmation posts the reviewed discounted fee snapshot and activates without payment; later terms do not rotate credentials');

    const disabledPendingIntake = await activationEnrollmentService.createAnnualIntake(registrarId, intakeInput({
      email: 'synthetic-disabled@example.test', lrn: '901000000006', idempotencyKey: token()
    }));
    const disabledUserId = await scalar('SELECT user_id AS value FROM dbo.students WHERE id = @studentId', { studentId: disabledPendingIntake.studentId });
    const disabledBefore = await rows('SELECT is_active, password_hash, auth_session_version FROM dbo.users WHERE id = @userId', { userId: disabledUserId });
    const disabledEmail = await scalar('SELECT email AS value FROM dbo.users WHERE id = @userId', { userId: disabledUserId });
    await adminService.updateUser(adminId, disabledUserId, {
      email: disabledEmail, role: 'student', isActive: false, studentNo: disabledPendingIntake.studentNo
    });
    assert.equal(await scalar('SELECT account_activation_pending AS value FROM dbo.annual_enrollments WHERE id = @annualId', { annualId: disabledPendingIntake.annualEnrollmentId }), false);
    const disabledFinalize = await confirmIntake(disabledPendingIntake.annualEnrollmentId);
    assert.equal(disabledFinalize.temporaryPassword, null);
    assert.deepEqual(await rows('SELECT is_active, password_hash, auth_session_version FROM dbo.users WHERE id = @userId', { userId: disabledUserId }), disabledBefore);
    passed('administrator deactivation revokes pending activation authorization before registrar confirmation can activate a login');

    stage = 'create schedules and post synthetic assessments';
    const pubLines = [...tuitionLines(['100.00', '200.00', '300.00']),
      { termNumber: 1, feeCategory: 'activity', lineName: 'Optional tour', installment: 'Once', amount: '50.00', isOptional: true }];
    const scheduleV1 = await finance.createSchedule(financeId, { schoolYear: '2026-2027', gradeLevel: 'Grade 11', voucherCode: 'PUB', lines: pubLines, idempotencyKey: token() });
    const previewV1 = await finance.annualAssessmentPreview(financeId, parentA.id);
    assert.equal(previewV1.lines.length, 12, 'deselected optional activity must not be assessed');
    assert.deepEqual(previewV1.tuitionBreakdown.map((term) => term.installments.map((item) => item.amount)), [
      ['100.00', '0.00', '0.00', '0.00'], ['200.00', '0.00', '0.00', '0.00'], ['300.00', '0.00', '0.00', '0.00']
    ]);
    const scheduleV2 = await finance.createSchedule(financeId, { schoolYear: '2026-2027', gradeLevel: 'Grade 11', voucherCode: 'PUB', lines: pubLines, idempotencyKey: token() });
    await expect409(finance.confirmAnnualAssessment(financeId, parentA.id, [], {
      scheduleId: scheduleV1.scheduleId, scheduleVersion: scheduleV1.versionNo, voucherCode: 'PUB', idempotencyKey: token()
    }), /changed after preview/);
    const previewA = await finance.annualAssessmentPreview(financeId, parentA.id);
    assert.equal(previewA.scheduleId, scheduleV2.scheduleId);
    const postedA = await finance.confirmAnnualAssessment(financeId, parentA.id, [], {
      scheduleId: previewA.scheduleId, scheduleVersion: previewA.scheduleVersion, voucherCode: 'PUB', idempotencyKey: token()
    });
    assert.equal(postedA.lineCount, 12);
    const chargesA = await getCharges(parentA.id);
    assert.deepEqual([...new Set(chargesA.map((charge) => Number(charge.term_number)))], [1, 2, 3]);
    const handbookInput = { expectedStudentId: studentA, financeHandbookNumber: 'SYN-HB-001', idempotencyKey: token() };
    const handbookSaved = await finance.updateFinanceHandbookNumber(financeId, parentA.id, handbookInput);
    assert.equal(handbookSaved.changed, true);
    assert.equal((await finance.updateFinanceHandbookNumber(financeId, parentA.id, handbookInput)).alreadyRecorded, true);
    await expect404(finance.updateFinanceHandbookNumber(financeId, parentA.id, { ...handbookInput, expectedStudentId: studentB, idempotencyKey: token() }));
    const feeCommentInput = { comment: 'Synthetic comment on this exact fee line.', idempotencyKey: token() };
    const feeCommentSaved = await finance.addFeeComment(financeId, studentA, chargesA[0].id, feeCommentInput);
    assert.ok(feeCommentSaved.commentEventId);
    assert.equal((await finance.addFeeComment(financeId, studentA, chargesA[0].id, feeCommentInput)).alreadyRecorded, true);
    await expect404(finance.addFeeComment(financeId, studentB, chargesA[0].id, { comment: 'Wrong account ownership.', idempotencyKey: token() }));
    const financeLedgerA = await finance.getStudentLedger(financeId, studentA, 'finance');
    assert.ok(financeLedgerA.financeHandbookNumbers.some((item) => item.annual_enrollment_id === parentA.id && item.finance_handbook_number === 'SYN-HB-001'));
    assert.ok(financeLedgerA.feeComments.some((item) => item.charge_id === chargesA[0].id && item.comment === feeCommentInput.comment));
    const studentLedgerB = await finance.getStudentLedger(studentUserId, studentB, 'student');
    assert.deepEqual(studentLedgerB.financeHandbookNumbers, []);
    assert.deepEqual(studentLedgerB.financeHandbookHistory, []);
    assert.deepEqual(studentLedgerB.feeComments, []);
    passed('assessment confirmation binds preview schedule/version/voucher and omits optional lines unless selected');

    const optionalEsc = await finance.createSchedule(financeId, {
      schoolYear: '2026-2027', gradeLevel: 'Grade 11', voucherCode: 'ESC',
      lines: [...tuitionLines(['0.00', '0.00', '0.00']), { termNumber: 1, feeCategory: 'activity', lineName: 'Optional school tour', installment: 'Once', amount: '25.00', isOptional: true }],
      idempotencyKey: token()
    });
    const previewB = await finance.annualAssessmentPreview(financeId, parentB.id);
    const postedB = await finance.confirmAnnualAssessment(financeId, parentB.id, [], {
      scheduleId: previewB.scheduleId, scheduleVersion: previewB.scheduleVersion, voucherCode: 'ESC', idempotencyKey: token()
    });
    assert.equal(postedB.lineCount, 12);
    await assert.rejects(finance.approveTerm(financeId, parentB.placements[0], { confirmEligibility: '1' }),
      (error) => error.status === 409 && /Enrollment is confirmed by the registrar; use payment and term clearance actions/.test(error.message));
    assert.equal(await scalar('SELECT status AS value FROM dbo.term_finance_approvals WHERE enrollment_id = @enrollmentId', { enrollmentId: parentB.placements[0] }), 'pending');
    assert.equal(optionalEsc.versionNo, 1);
    passed('all-optional deselection posts a zero-line assessment; finance approval endpoint is read-only for current annual enrollment');

    const previewC = await finance.annualAssessmentPreview(financeId, parentC.id);
    await finance.confirmAnnualAssessment(financeId, parentC.id, [], {
      scheduleId: previewC.scheduleId, scheduleVersion: previewC.scheduleVersion, voucherCode: 'PUB', idempotencyKey: token()
    });
    const chargesC = await getCharges(parentC.id);
    stage = 'record and allocate synthetic payments';
    const paymentAInput = {
      amount: '300.00', paymentDate: '2026-09-30', referenceNo: 'SYNTH-RECEIPT-01', receiptIssued: true,
      transmittalReference: 'SYNTH-TRANSMITTAL-01', privateRemarks: 'Synthetic initial finance note.',
      idempotencyKey: token(), allocations: [
        { chargeId: String(chargesA[0].id), amount: '100.00' },
        { chargeId: String(chargesA[1].id), amount: '200.00' }
      ]
    };
    const paymentA = await finance.recordPayment(financeId, studentA, paymentAInput);
    const replayA = await finance.recordPayment(financeId, studentA, paymentAInput);
    assert.equal(replayA.alreadyRecorded, true);
    assert.equal(replayA.paymentId, paymentA.paymentId);
    assert.equal(await scalar('SELECT transmittal_reference AS value FROM dbo.finance_payments WHERE id = @paymentId', { paymentId: paymentA.paymentId }), 'SYNTH-TRANSMITTAL-01');
    assert.equal(await scalar('SELECT private_remarks AS value FROM dbo.finance_payments WHERE id = @paymentId', { paymentId: paymentA.paymentId }), 'Synthetic initial finance note.');
    await expect409(finance.recordPayment(financeId, studentA, { ...paymentAInput, amount: '301.00' }));
    await assert.rejects(finance.approveTerm(financeId, parentA.placements[0], { confirmEligibility: '1' }),
      (error) => error.status === 409 && /Enrollment is confirmed by the registrar/.test(error.message));
    await assert.rejects(finance.approveTerm(financeId, parentA.placements[1], { confirmEligibility: '1' }),
      (error) => error.status === 409 && /Enrollment is confirmed by the registrar/.test(error.message));
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.term_finance_approvals WHERE enrollment_id IN (@term1, @term2) AND status <> N\'pending\'', {
      term1: parentA.placements[0], term2: parentA.placements[1]
    })), 0);
    passed('split payment allocation is recorded once; finance cannot approve enrollment or mutate historical approval rows');

    const beforeForged = await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.finance_payments WHERE student_id = @studentId', { studentId: studentA });
    await expect409(finance.recordPayment(financeId, studentA, {
      amount: '10.00', paymentDate: '2026-09-30', referenceNo: 'SYNTH-FORGED', idempotencyKey: token(),
      allocations: [{ chargeId: String(chargesC[0].id), amount: '10.00' }]
    }), /same student account/);
    await expect409(finance.recordPayment(financeId, studentA, {
      amount: '400.00', paymentDate: '2026-09-30', referenceNo: 'SYNTH-OVER', idempotencyKey: token(),
      allocations: [{ chargeId: String(chargesA[2].id), amount: '301.00' }]
    }), /remaining amount due/);
    const afterForged = await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.finance_payments WHERE student_id = @studentId', { studentId: studentA });
    assert.equal(afterForged, beforeForged, 'failed ownership/over-allocation must roll the inserted payment back');
    passed('cross-student and over-charge allocations are rejected, with payment insert rolled back');

    stage = 'record unallocated synthetic credit';
    await finance.recordPayment(financeId, studentA, {
      amount: '50.00', paymentDate: '2026-09-30', referenceNo: 'SYNTH-CREDIT', idempotencyKey: token()
    });
    stage = 'read student ledger before applying credit';
    const creditLedger = await finance.getStudentLedger(financeId, studentA);
    const credit = creditLedger.availablePayments.find((payment) => Number(payment.payment_id) !== paymentA.paymentId);
    assert.equal(credit.available_amount, '50.00');
    stage = 'allocate existing synthetic credit';
    await finance.allocateExistingCredit(financeId, studentA, credit.payment_id, {
      idempotencyKey: token(), allocations: [{ chargeId: String(chargesA[2].id), amount: '50.00' }]
    });
    const creditAllocation = (await rows(`SELECT id, amount FROM dbo.finance_payment_allocations
      WHERE payment_id = @paymentId AND charge_id = @chargeId`, { paymentId: credit.payment_id, chargeId: chargesA[2].id }))[0];
    const allocationReleaseInputs = [1, 2].map(() => ({ amount: '30.00', reason: 'Synthetic allocation correction.', idempotencyKey: token() }));
    const allocationReleaseRace = await Promise.allSettled(allocationReleaseInputs.map((input) =>
      finance.releasePaymentAllocation(financeId, studentA, creditAllocation.id, input)));
    assert.equal(allocationReleaseRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(allocationReleaseRace.filter((result) => result.status === 'rejected' && result.reason.status === 409).length, 1);
    const winningReleaseIndex = allocationReleaseRace.findIndex((result) => result.status === 'fulfilled');
    const winningReleaseInput = allocationReleaseInputs[winningReleaseIndex];
    assert.equal((await finance.releasePaymentAllocation(financeId, studentA, creditAllocation.id, winningReleaseInput)).alreadyReleased, true);
    await expect409(finance.releasePaymentAllocation(financeId, studentA, creditAllocation.id, { ...winningReleaseInput, amount: '29.00' }));
    await expect409(finance.releasePaymentAllocation(financeId, studentA, creditAllocation.id, {
      amount: '21.00', reason: 'Over-release must roll back.', idempotencyKey: token()
    }), /Cumulative releases cannot exceed/);
    await finance.releasePaymentAllocation(financeId, studentA, creditAllocation.id, {
      amount: '20.00', reason: 'Release remaining synthetic allocation.', idempotencyKey: token()
    });
    const creditAfterRelease = await finance.getStudentLedger(financeId, studentA);
    assert.equal(creditAfterRelease.availablePayments.find((payment) => Number(payment.payment_id) === Number(credit.payment_id)).available_amount, '50.00');
    assert.equal(Number(await scalar('SELECT SUM(net_amount) AS value FROM dbo.v_finance_net_payment_allocations WHERE allocation_id = @allocationId', { allocationId: creditAllocation.id })), 0);
    passed('payment-allocation release is append-only, idempotent, concurrent-capacity safe, and restores existing payment credit');
    passed('unallocated payment credit is visible and can be allocated later without recording cash twice');

    stage = 'exercise concurrent payment allocation';
    const raceResults = await Promise.allSettled([1, 2].map((number) => finance.recordPayment(financeId, studentC, {
      amount: '60.00', paymentDate: '2026-09-30', referenceNo: `SYNTH-RACE-${number}`, idempotencyKey: token(),
      allocations: [{ chargeId: String(chargesC[0].id), amount: '60.00' }]
    })));
    assert.equal(raceResults.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(raceResults.filter((result) => result.status === 'rejected' && result.reason.status === 409).length, 1);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.finance_payments WHERE student_id = @studentId', { studentId: studentC })), 1);
    assert.equal(Number(await scalar('SELECT SUM(amount) AS value FROM dbo.finance_payment_allocations WHERE charge_id = @chargeId', { chargeId: chargesC[0].id })), 60);
    passed('concurrent payments serialize charge ownership and cannot over-allocate a balance');

    stage = 'approve a capped exemption and release the resulting overpayment';
    const exemptionRuleC = { termNumber: 1, feeCategory: 'tuition', lineName: null, isFullCoverage: false, approvedAmount: '50.00' };
    const wrongOwnerExemptionCount = await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.finance_exemption_cases WHERE annual_enrollment_id = @annualId', { annualId: parentC.id });
    await expect404(financeCases.approveExemptionCase(financeId, parentC.id, {
      expectedStudentId: studentB, reason: 'Forged student path must fail.', rules: [exemptionRuleC], idempotencyKey: token()
    }));
    assert.equal(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.finance_exemption_cases WHERE annual_enrollment_id = @annualId', { annualId: parentC.id }), wrongOwnerExemptionCount);
    const exemptionInputC = { expectedStudentId: studentC, reason: 'Approved synthetic tuition coverage.', rules: [exemptionRuleC], idempotencyKey: token() };
    const exemptionC = await financeCases.approveExemptionCase(financeId, parentC.id, exemptionInputC);
    assert.ok(exemptionC.exemptionCaseId);
    assert.equal((await financeCases.approveExemptionCase(financeId, parentC.id, exemptionInputC)).alreadyApproved, true);
    await expect409(financeCases.approveExemptionCase(financeId, parentC.id, { ...exemptionInputC, rules: [{ ...exemptionRuleC, approvedAmount: '49.00' }] }));
    assert.equal(Number(await scalar('SELECT waived_amount AS value FROM dbo.assessed_charges WHERE id = @chargeId', { chargeId: chargesC[0].id })), 50);
    assert.equal(Number(await scalar('SELECT SUM(amount) AS value FROM dbo.finance_charge_adjustments WHERE charge_id = @chargeId AND amount < 0', { chargeId: chargesC[0].id })), -50);
    assert.equal(Number(await scalar('SELECT amount_due AS value FROM dbo.v_finance_assessed_charge_due WHERE charge_id = @chargeId', { chargeId: chargesC[0].id })), 0);
    const exemptionLedgerC = await finance.getStudentLedger(financeId, studentC);
    assert.equal(exemptionLedgerC.availablePayments[0].available_amount, '10.00', 'overpayment released from the original payment becomes credit once');
    passed('exemption approval is student-bound and idempotent, applies one capped waiver, and releases excess allocation as existing credit');

    stage = 'exercise finance review and voucher workflow';
    await pool.request().input('enrollmentId', sql.Int, parentA.placements[1]).query(`UPDATE dbo.enrollments SET enrollment_status = N'enrolled', finalized_at = SYSUTCDATETIME() WHERE id = @enrollmentId`);
    await finance.addSupplementaryCharge(financeId, studentA, parentA.placements[1], {
      feeCategory: 'retake', lineName: 'Synthetic retake', installment: 'As incurred', amount: '10.00',
      reason: 'Synthetic review trigger', idempotencyKey: token()
    });
    let approvals = await rows('SELECT enrollment_id, status, finance_review_required FROM dbo.term_finance_approvals WHERE enrollment_id IN (@term1, @term2)', {
      term1: parentA.placements[0], term2: parentA.placements[1]
    });
    assert.equal(approvals.find((row) => row.enrollment_id === parentA.placements[1]).finance_review_required, false);
    await finance.reversePayment(financeId, studentA, paymentA.paymentId, { reason: 'Synthetic correction', idempotencyKey: token() });
    approvals = await rows('SELECT enrollment_id, status, finance_review_required FROM dbo.term_finance_approvals WHERE enrollment_id IN (@term1, @term2)', {
      term1: parentA.placements[0], term2: parentA.placements[1]
    });
    assert.equal(approvals.find((row) => row.enrollment_id === parentA.placements[0]).status, 'pending');
    assert.equal(approvals.find((row) => row.enrollment_id === parentA.placements[1]).status, 'pending');
    assert.equal(approvals.find((row) => row.enrollment_id === parentA.placements[1]).finance_review_required, false);
    const reversedAllocationId = await scalar('SELECT id AS value FROM dbo.finance_payment_allocations WHERE payment_id = @paymentId AND charge_id = @chargeId', {
      paymentId: paymentA.paymentId, chargeId: chargesA[0].id
    });
    const releasesBeforeReversedAllocationAttempt = await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.finance_payment_allocation_releases WHERE allocation_id = @allocationId', { allocationId: reversedAllocationId });
    await expect409(finance.releasePaymentAllocation(financeId, studentA, reversedAllocationId, {
      amount: '1.00', reason: 'A reversed payment must not create usable credit.', idempotencyKey: token()
    }), /reversed payment cannot be released/);
    assert.equal(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.finance_payment_allocation_releases WHERE allocation_id = @allocationId', { allocationId: reversedAllocationId }), releasesBeforeReversedAllocationAttempt);
    const studentStillActive = await scalar('SELECT status AS value FROM dbo.students WHERE id = @studentId', { studentId: studentA });
    assert.equal(studentStillActive, 'active');
    passed('increased charges and payment reversals preserve historical approval rows without changing registrar enrollment history');

    const registrar = activationEnrollmentService;
    await registrar.updateVoucher(registrarId, parentA.id, 'ESC', 'Synthetic verified voucher update');
    const flaggedLedger = await finance.getStudentLedger(financeId, studentA);
    const flaggedTerms = flaggedLedger.terms.filter((term) => Number(term.annual_enrollment_id) === Number(parentA.id));
    assert.equal(flaggedTerms[0].assessed_voucher_code, 'PUB');
    assert.equal(flaggedTerms[0].voucher_review_required, true);
    const registrarRows = await registrar.listAnnualEnrollments(registrarId, { schoolYear: '2026-2027', search: 'SYNTH-A-001' });
    const filteredRegistrarRows = registrarRows.filter((row) => Number(row.annual_enrollment_id) === Number(parentA.id));
    assert.equal(filteredRegistrarRows.length, 3);
    assert.ok(filteredRegistrarRows.every((row) => row.voucher_review_required === true));
    const registrarPendingRows = await registrar.listAnnualEnrollments(registrarId, {
      schoolYear: '2026-2027', search: 'SYNTH-A-001', status: 'pending_payment'
    });
    assert.ok(registrarPendingRows.every((row) => row.enrollment_status === 'pending_payment'));
    const financeRoster = await finance.listRoster(financeId, {
      schoolYear: '2026-2027', search: 'SYNTH-A-001', termId: terms[1].id
    });
    assert.equal(financeRoster.rows.filter((row) => Number(row.annual_enrollment_id) === Number(parentA.id)).length, 1);
    const resolutionToken = token();
    const resolved = await finance.resolveVoucherReview(financeId, parentA.id, {
      resolution: 'assessment_stands', reason: 'Reviewed synthetic documents.', idempotencyKey: resolutionToken
    });
    assert.equal(resolved.studentId, studentA);
    assert.equal((await finance.resolveVoucherReview(financeId, parentA.id, {
      resolution: 'assessment_stands', reason: 'Reviewed synthetic documents.', idempotencyKey: resolutionToken
    })).alreadyResolved, true);
    const resolvedLedger = await finance.getStudentLedger(financeId, studentA);
    assert.equal(resolvedLedger.terms.find((term) => Number(term.annual_enrollment_id) === Number(parentA.id)).voucher_review_required, false);
    passed('registrar and finance live rosters filter shared identifiers and show unresolved voucher review state');
    passed('voucher changes preserve the assessed snapshot and require an idempotent reasoned finance resolution');

    stage = 'link and bill a configured special subject with prior approved exemption';
    const exemptionInputA = {
      expectedStudentId: studentA, reason: 'Approved synthetic special-subject coverage.',
      rules: [{ termNumber: 3, feeCategory: 'other', lineName: null, isFullCoverage: false, approvedAmount: '15.00' }],
      idempotencyKey: token()
    };
    await financeCases.approveExemptionCase(financeId, parentA.id, exemptionInputA);
    const subjectResult = await pool.request().input('code', sql.NVarChar(50), 'SYNTH-SPECIAL-01')
      .input('name', sql.NVarChar(200), 'Synthetic Advanced Studies')
      .query('INSERT INTO dbo.subjects (subject_code, subject_name) OUTPUT INSERTED.id AS id VALUES (@code, @name)');
    const assignmentResult = await pool.request().input('enrollmentId', sql.Int, parentA.placements[2]).input('subjectId', sql.Int, subjectResult.recordset[0].id)
      .query('INSERT INTO dbo.student_subjects (enrollment_id, subject_id) OUTPUT INSERTED.id AS id VALUES (@enrollmentId, @subjectId)');
    const specialSubject = await activationEnrollmentService.addSpecialSubject(registrarId, parentA.id, {
      studentSubjectId: String(assignmentResult.recordset[0].id), arrangementType: 'athlete', idempotencyKey: token()
    });
    const billInput = { amount: '25.00', installment: 'As incurred', reason: 'Synthetic approved special-subject payable amount.', idempotencyKey: token() };
    const billed = await financeCases.billSpecialSubject(financeId, studentA, specialSubject.specialSubjectId, billInput);
    assert.ok(billed.chargeId);
    assert.equal((await financeCases.billSpecialSubject(financeId, studentA, specialSubject.specialSubjectId, billInput)).alreadyRecorded, true);
    await expect409(financeCases.billSpecialSubject(financeId, studentA, specialSubject.specialSubjectId, { ...billInput, amount: '26.00' }));
    await expect409(financeCases.billSpecialSubject(financeId, studentC, specialSubject.specialSubjectId, { ...billInput, idempotencyKey: token() }));
    const linkedSpecialCharge = (await rows(`SELECT charge.special_subject_id, subject.subject_name AS line_name,
        charge.gross_amount, charge.waived_amount, due.amount_due
      FROM dbo.assessed_charges AS charge
      INNER JOIN dbo.annual_special_subjects AS special ON special.id = charge.special_subject_id
      INNER JOIN dbo.student_subjects AS assignment ON assignment.id = special.student_subject_id
      INNER JOIN dbo.subjects AS subject ON subject.id = assignment.subject_id
      INNER JOIN dbo.v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
      WHERE charge.id = @chargeId`, { chargeId: billed.chargeId }))[0];
    assert.equal(linkedSpecialCharge.special_subject_id, specialSubject.specialSubjectId);
    assert.equal(linkedSpecialCharge.line_name, 'Synthetic Advanced Studies');
    assert.equal(linkedSpecialCharge.gross_amount, 25);
    assert.equal(linkedSpecialCharge.waived_amount, 15);
    assert.equal(linkedSpecialCharge.amount_due, 10);
    passed('special-subject billing is linked to the assigned subject and term, idempotent, ownership-checked, and applies an approved capped rule once');

    stage = 'record and finance-review a dated departure cascade';
    const affectedTerm2 = chargesC.find((charge) => Number(charge.term_number) === 2);
    const dueBeforeDeparture = await scalar('SELECT amount_due AS value FROM dbo.v_finance_assessed_charge_due WHERE charge_id = @chargeId', { chargeId: affectedTerm2.id });
    const departurePreview = await activationEnrollmentService.previewDeparture(registrarId, parentC.id, parentC.placements[1]);
    assert.deepEqual(departurePreview.map((row) => Number(row.enrollment_id)), parentC.placements.slice(1).map(Number));
    const departureInput = { departureType: 'transferred', effectiveDate: '2026-10-01', reason: 'Synthetic learner transfer.', idempotencyKey: token() };
    const departure = await activationEnrollmentService.createDepartureCase(registrarId, parentC.id, parentC.placements[1], departureInput);
    assert.equal((await activationEnrollmentService.createDepartureCase(registrarId, parentC.id, parentC.placements[1], departureInput)).alreadyRecorded, true);
    assert.equal(await scalar('SELECT enrollment_status AS value FROM dbo.enrollments WHERE id = @enrollmentId', { enrollmentId: parentC.placements[2] }), 'transferred');
    assert.equal(await scalar('SELECT amount_due AS value FROM dbo.v_finance_assessed_charge_due WHERE charge_id = @chargeId', { chargeId: affectedTerm2.id }), dueBeforeDeparture, 'registrar departure does not cancel or alter debt');
    const reviewInput = { reason: 'Reviewed the affected transferred term charges.', idempotencyKey: token(), adjustments: [
      { chargeId: String(affectedTerm2.id), amount: '25.00', reason: 'Approved remaining-term correction.' }
    ] };
    const reviewedDeparture = await financeCases.reviewDepartureCase(financeId, departure.departureCaseId, reviewInput);
    assert.equal(reviewedDeparture.studentId, studentC);
    assert.equal((await financeCases.reviewDepartureCase(financeId, departure.departureCaseId, reviewInput)).alreadyReviewed, true);
    await expect409(financeCases.reviewDepartureCase(financeId, departure.departureCaseId, { ...reviewInput, reason: 'Changed reason.' }));
    assert.equal(Number(await scalar('SELECT SUM(amount) AS value FROM dbo.finance_charge_adjustments WHERE departure_case_id = @caseId', { caseId: departure.departureCaseId })), -25);
    assert.equal(Number(await scalar('SELECT amount_due AS value FROM dbo.v_finance_assessed_charge_due WHERE charge_id = @chargeId', { chargeId: affectedTerm2.id })), Number(dueBeforeDeparture) - 25);
    passed('dated departure preserves its charge until finance approves linked, idempotent future-term corrections');

    stage = 'reconcile prior legacy credit and build long statement history';
    const legacySchedule = await finance.createSchedule(financeId, {
      schoolYear: '2025-2026', gradeLevel: 'Grade 11', voucherCode: 'PUB',
      lines: tuitionLines(['0.00', '0.00', '90.00']),
      idempotencyKey: token()
    });
    const oldAssessment = await pool.request()
      .input('parentId', sql.Int, legacyParent.id).input('scheduleId', sql.Int, legacySchedule.scheduleId)
      .input('actorId', sql.Int, financeId).input('key', sql.UniqueIdentifier, token())
      .input('fingerprint', sql.Char(64), 'a'.repeat(64))
      .query(`INSERT INTO dbo.annual_assessments (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by, selection_json, idempotency_key, request_fingerprint)
        OUTPUT INSERTED.id AS id VALUES (@parentId, @scheduleId, 1, N'PUB', @actorId, N'{}', @key, @fingerprint)`);
    await pool.request().input('annualId', sql.Int, legacyParent.id).input('enrollmentId', sql.Int, legacyEnrollmentId)
      .input('assessmentId', sql.Int, oldAssessment.recordset[0].id)
      .query(`INSERT INTO dbo.assessed_charges (assessment_id, annual_enrollment_id, enrollment_id, fee_category, line_name, installment, amount, gross_amount)
        VALUES (@assessmentId, @annualId, @enrollmentId, N'tuition', N'Historical tuition', N'Finals', 90.00, 90.00)`);
    const accountId = await scalar('SELECT id AS value FROM dbo.financial_accounts WHERE student_id = @studentId', { studentId: studentA });
    await finance.reconcileLegacyPayment(financeId, studentA, legacyTransactionId, {
      reason: 'Synthetic legacy statement match.', idempotencyKey: token(),
      allocations: [{ chargeId: String((await getCharges(legacyParent.id))[0].id), amount: '50.00' }]
    });
    const ledger = await finance.getStudentLedger(financeId, studentA);
    assert.equal(ledger.summary.priorTermYearDebt, '40.00');
    assert.equal(ledger.summary.annualBalanceSchoolYear, '2027-2028');
    assert.equal(ledger.summary.annualBalance, '30.00', 'the selected annual balance is the confirmed returning-student year');
    assert.equal(ledger.summary.allYearsAnnualBalance, '690.00', 'all years include the prior-year annual charges, historical debt, and confirmed returning-student charges');
    assert.equal(ledger.summary.unattributedLegacyBalance, '0.00', 'reconciled legacy credit must not be counted a second time');
    assert.equal(ledger.summary.totalBalance, '690.00', 'combined balance includes annual charges and prior-year due exactly once');
    assert.equal(ledger.summary.currentTermOutstanding, '100.00');
    passed('shared statement projection separates current, future, prior-year and reconciled legacy amounts');

    const accountBId = await scalar('SELECT id AS value FROM dbo.financial_accounts WHERE student_id = @studentId', { studentId: studentB });
    await pool.request().input('accountId', sql.Int, accountBId).input('actorId', sql.Int, financeId).query(`
      INSERT INTO dbo.financial_transactions (financial_account_id, transaction_type, amount, description, recorded_by)
      SELECT TOP (101) @accountId, N'adjustment', 0.00, N'Synthetic private description', @actorId
      FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;
    `);
    await finance.signTermClearance(financeId, parentB.placements[0], {
      confirmClearance: '1', reason: 'Synthetic departure clearance',
      financeNote: 'Private synthetic note', idempotencyKey: token()
    });
    const statement = await finance.getStudentLedger(studentUserId, studentB, 'student');
    assert.ok(statement.events.length > 100, `expected complete history above 100 entries; got ${statement.events.length}`);
    assert.equal(statement.privateClearances.length, 0);
    assert.ok(statement.events.every((event) => !String(event.details).includes('Private synthetic note')));
    assert.ok(statement.events.every((event) => !String(event.details).includes('Synthetic private description')));
    await expect403(finance.getStudentLedger(studentUserId, studentA, 'student'));
    passed('student statement returns >100 history rows, hides private finance notes, and enforces ownership');

    stage = 'release prior legacy credit reconciliation without changing account debt';
    const reconciliationId = await scalar('SELECT id AS value FROM dbo.finance_legacy_reconciliations WHERE transaction_id = @transactionId', { transactionId: legacyTransactionId });
    const combinedBeforeRelease = (await finance.getStudentLedger(financeId, studentA)).summary.totalBalance;
    const legacyReleaseInputs = [1, 2].map(() => ({ amount: '30.00', reason: 'Synthetic legacy credit correction.', idempotencyKey: token() }));
    const legacyReleaseRace = await Promise.allSettled(legacyReleaseInputs.map((input) =>
      finance.releaseLegacyReconciliation(financeId, studentA, reconciliationId, input)));
    assert.equal(legacyReleaseRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(legacyReleaseRace.filter((result) => result.status === 'rejected' && result.reason.status === 409).length, 1);
    const legacyWinner = legacyReleaseInputs[legacyReleaseRace.findIndex((result) => result.status === 'fulfilled')];
    assert.equal((await finance.releaseLegacyReconciliation(financeId, studentA, reconciliationId, legacyWinner)).alreadyReleased, true);
    await expect409(finance.releaseLegacyReconciliation(financeId, studentA, reconciliationId, { ...legacyWinner, amount: '29.00' }));
    await expect409(finance.releaseLegacyReconciliation(financeId, studentA, reconciliationId, {
      amount: '21.00', reason: 'Over-release must roll back.', idempotencyKey: token()
    }), /Cumulative releases cannot exceed/);
    await finance.releaseLegacyReconciliation(financeId, studentA, reconciliationId, {
      amount: '20.00', reason: 'Release remaining synthetic reconciliation.', idempotencyKey: token()
    });
    const afterLegacyRelease = await finance.getStudentLedger(financeId, studentA);
    assert.equal(afterLegacyRelease.legacyCredits.find((row) => Number(row.transaction_id) === Number(legacyTransactionId)).available_amount, '50.00');
    assert.equal(afterLegacyRelease.summary.totalBalance, combinedBeforeRelease, 'release raises the annual charge and restores the exact source credit');
    passed('legacy reconciliation release is append-only, idempotent, concurrency-safe, and restores only its original source credit');

    stage = 'prior-year debt remains prior when its term row is created later';
    const studentD = await insertStudent('SYNTH-D-004', '901000000004', null, '0.00');
    const latePriorTerm = await pool.request().query(`INSERT INTO dbo.academic_terms (school_year, term, is_current)
      OUTPUT INSERTED.id AS id VALUES (N'2025-2026', N'Term 3', 0)`);
    const latePriorSection = await pool.request().input('termId', sql.Int, latePriorTerm.recordset[0].id)
      .query(`INSERT INTO dbo.sections (name, grade_level, academic_term_id)
        OUTPUT INSERTED.id AS id VALUES (N'Synthetic late prior section', N'Grade 11', @termId)`);
    const latePriorParent = await pool.request().input('studentId', sql.Int, studentD).input('registrarId', sql.Int, registrarId)
      .query(`INSERT INTO dbo.annual_enrollments (student_id, school_year, grade_level, voucher_code, intake_status, created_by)
        OUTPUT INSERTED.id AS id VALUES (@studentId, N'2025-2026', N'Grade 11', N'PUB', N'enrolled', @registrarId)`);
    const latePriorPlacement = await pool.request().input('studentId', sql.Int, studentD)
      .input('annualId', sql.Int, latePriorParent.recordset[0].id).input('termId', sql.Int, latePriorTerm.recordset[0].id)
      .input('sectionId', sql.Int, latePriorSection.recordset[0].id)
      .query(`INSERT INTO dbo.enrollments (student_id, academic_term_id, section_id, annual_enrollment_id, annual_term_number, enrollment_status)
        OUTPUT INSERTED.id AS id VALUES (@studentId, @termId, @sectionId, @annualId, 3, N'enrolled')`);
    const latePriorAssessment = await pool.request().input('annualId', sql.Int, latePriorParent.recordset[0].id)
      .input('scheduleId', sql.Int, legacySchedule.scheduleId).input('actorId', sql.Int, financeId)
      .input('key', sql.UniqueIdentifier, token()).input('fingerprint', sql.Char(64), 'b'.repeat(64))
      .query(`INSERT INTO dbo.annual_assessments (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by, selection_json, idempotency_key, request_fingerprint)
        OUTPUT INSERTED.id AS id VALUES (@annualId, @scheduleId, 1, N'PUB', @actorId, N'{}', @key, @fingerprint)`);
    await pool.request().input('annualId', sql.Int, latePriorParent.recordset[0].id)
      .input('enrollmentId', sql.Int, latePriorPlacement.recordset[0].id).input('assessmentId', sql.Int, latePriorAssessment.recordset[0].id)
      .query(`INSERT INTO dbo.assessed_charges (assessment_id, annual_enrollment_id, enrollment_id, fee_category, line_name, installment, amount, gross_amount)
        VALUES (@assessmentId, @annualId, @enrollmentId, N'tuition', N'Late prior-year tuition', N'Finals', 35.00, 35.00)`);
    const priorOnlyLedger = await finance.getStudentLedger(financeId, studentD);
    assert.equal(priorOnlyLedger.summary.priorTermYearDebt, '35.00', 'prior year is classified by school year even when its academic_terms row was inserted later and this student has no current-year placement');
    assert.equal(priorOnlyLedger.summary.currentTermOutstanding, '0.00');
    passed('prior-year debt uses school-year and annual-term order, not academic term IDs or the student’s placement set');

    stage = 'transfer legacy balances and protect shared account mutations';
    const openingStudentUserId = await insertUser('opening-liability-student', 'student');
    const legacyOnlyStudent = await insertStudent('SYNTH-E-005', '901000000007', openingStudentUserId, '100.00');
    const rawFinance = createFinanceService({ getPool: async () => pool, sql });
    const legacyOnlyEnrollment = await pool.request().input('studentId', sql.Int, legacyOnlyStudent)
      .input('termId', sql.Int, terms[0].id).input('sectionId', sql.Int, sections[0].sectionId)
      .query(`INSERT INTO dbo.enrollments (student_id, academic_term_id, section_id, enrollment_status)
        OUTPUT INSERTED.id AS id VALUES (@studentId, @termId, @sectionId, N'pending_payment')`);
    await pool.request().input('enrollmentId', sql.Int, legacyOnlyEnrollment.recordset[0].id).input('registrarId', sql.Int, registrarId)
      .query(`INSERT INTO dbo.enrollment_clearances (enrollment_id, clearance_status, created_by, created_for_intake)
        VALUES (@enrollmentId, N'pending', @registrarId, 1)`);
    const legacyPreview = await finance.previewLegacyOpeningLiability(financeId, legacyOnlyStudent);
    assert.equal(legacyPreview.remainingBalance, '100.00');
    assert.equal(legacyPreview.activeReconciliationCount, 0);
    const transferInput = { expectedAmount: '100.00', sourceLabel: 'Reviewed previous account', reason: 'Synthetic statement review.', idempotencyKey: token() };
    const opening = await finance.transferLegacyOpeningLiability(financeId, legacyOnlyStudent, transferInput);
    assert.ok(opening.openingLiabilityId);
    assert.equal((await finance.transferLegacyOpeningLiability(financeId, legacyOnlyStudent, transferInput)).alreadyTransferred, true);
    const transferredBuckets = await rows(`SELECT legacy.remaining_legacy_balance, opening.amount_due
      FROM dbo.v_finance_legacy_account_balance AS legacy
      CROSS APPLY (SELECT SUM(amount_due) AS amount_due FROM dbo.v_finance_opening_liability_due WHERE student_id = legacy.student_id) AS opening
      WHERE legacy.student_id = @studentId`, { studentId: legacyOnlyStudent });
    assert.equal(transferredBuckets[0].remaining_legacy_balance, 0);
    assert.equal(transferredBuckets[0].amount_due, 100);
    assert.equal(transferredBuckets[0].remaining_legacy_balance + transferredBuckets[0].amount_due, 100, 'transfer conserves total debt');
    await expect409(rawFinance.recordTransaction(financeId, legacyOnlyStudent, { transactionType: 'payment', amount: '1.00' }), /reviewed opening liability/i);
    await expect409(rawFinance.clearEnrollmentWithExistingPayment(financeId, legacyOnlyStudent, legacyOnlyEnrollment.recordset[0].id, 999999, true), /reviewed opening liability/i);

    const openingPayment = await finance.recordPayment(financeId, legacyOnlyStudent, {
      amount: '30.00', paymentDate: '2026-10-01', transmittalReference: 'SYNTH-TRANSMITTAL', privateRemarks: 'P'.repeat(980),
      idempotencyKey: token(), allocations: [{ openingLiabilityId: String(opening.openingLiabilityId), amount: '30.00' }]
    });
    await finance.updatePaymentMetadata(financeId, legacyOnlyStudent, openingPayment.paymentId, {
      eventType: 'receipt_reference_updated', referenceNo: 'SYNTH-RECEIPT-DELAYED', idempotencyKey: token()
    });
    await finance.updatePaymentMetadata(financeId, legacyOnlyStudent, openingPayment.paymentId, {
      eventType: 'receipt_marked_issued', idempotencyKey: token()
    });
    await finance.updatePaymentMetadata(financeId, legacyOnlyStudent, openingPayment.paymentId, {
      eventType: 'private_remark_added', privateRemark: 'note', idempotencyKey: token()
    });
    await expect409(finance.updatePaymentMetadata(financeId, legacyOnlyStudent, openingPayment.paymentId, {
      eventType: 'private_remark_added', privateRemark: 'Q'.repeat(20), idempotencyKey: token()
    }), /1,000 characters in total/);
    const openingLedger = await finance.getStudentLedger(financeId, legacyOnlyStudent);
    assert.equal(openingLedger.summary.unattributedLegacyBalance, '0.00');
    assert.equal(openingLedger.summary.openingLiabilityDue, '70.00');
    assert.equal(openingLedger.summary.totalBalance, '70.00');
    assert.ok(openingLedger.events.some((event) => event.event_type === 'legacy opening liability'));
    assert.ok(openingLedger.events.some((event) => event.reference_no === 'SYNTH-RECEIPT-DELAYED'));
    const openingStudentLedger = await finance.getStudentLedger(openingStudentUserId, legacyOnlyStudent, 'student');
    assert.equal(openingStudentLedger.summary.totalBalance, '70.00');
    assert.ok(openingStudentLedger.events.every((event) => !String(event.details).includes('P'.repeat(10))));
    passed('legacy opening transfer conserves debt, settles through one payment ledger, records delayed receipt metadata, and keeps raw writes blocked');

    stage = 'produce date-bounded collections and informational payment corrections';
    const reportPayment = await finance.recordPayment(financeId, studentD, {
      amount: '7.00', paymentDate: '2026-10-01', referenceNo: 'SYNTH-REVERSED-DAY-SPAN', idempotencyKey: token()
    });
    await finance.reversePayment(financeId, studentD, reportPayment.paymentId, {
      reason: 'Synthetic next-day correction.', idempotencyKey: token()
    });
    await pool.request().input('paymentId', sql.BigInt, reportPayment.paymentId).input('correctionDate', sql.DateTime2, new Date('2026-10-02T12:00:00.000Z'))
      .query(`UPDATE dbo.finance_payment_reversals SET created_at = @correctionDate WHERE payment_id = @paymentId;
        UPDATE dbo.finance_payment_reversals SET created_at = CONVERT(DATETIME2, '2026-09-30T12:00:00') WHERE payment_id <> @paymentId`);
    const reportResult = await financeReports.reports(financeId, { fromDate: '2026-10-01', toDate: '2026-10-02' });
    const expectedValidCollection = await scalar(`SELECT COALESCE(SUM(amount), 0) AS value FROM dbo.finance_payments
      WHERE is_reversed = 0 AND payment_date >= '2026-10-01' AND payment_date < '2026-10-03'`);
    const expectedPayers = await scalar(`SELECT COUNT(DISTINCT student_id) AS value FROM dbo.finance_payments
      WHERE is_reversed = 0 AND payment_date >= '2026-10-01' AND payment_date < '2026-10-03'`);
    assert.equal(reportResult.collectionSummary.valid_collection_amount, `${Number(expectedValidCollection).toFixed(2)}`);
    assert.equal(Number(reportResult.collectionSummary.distinct_payers), Number(expectedPayers));
    assert.equal(Number(reportResult.reversalSummary.reversal_count), 1);
    assert.equal(Number(reportResult.reversalSummary.corrected_record_amount), 7);
    assert.equal(reportResult.dailyCollections.reduce((sum, row) => sum + Number(row.payment_count), 0), Number(expectedValidCollection) > 0 ? 1 : 0);
    assert.equal(reportResult.allocationSummary.target_allocated_amount, '30.00', 'the opening-liability allocation is reported by payment date without recounting it as another cash collection');
    passed('date-bounded reports separate valid collections from next-day correction records, expose range-wide distinct payers, and count allocations separately from cash');

    const reconciledLegacyStudent = await insertStudent('SYNTH-G-007', '901000000009', null, '100.00');
    const reconciledParent = await insertAnnual(reconciledLegacyStudent, 'PUB');
    const reconciledPreview = await finance.annualAssessmentPreview(financeId, reconciledParent.id);
    await finance.confirmAnnualAssessment(financeId, reconciledParent.id, [], {
      scheduleId: reconciledPreview.scheduleId, scheduleVersion: reconciledPreview.scheduleVersion,
      voucherCode: reconciledPreview.parent.voucher_code, idempotencyKey: token()
    });
    const reconciledCharge = (await getCharges(reconciledParent.id))[0];
    const reconciledAccountId = await scalar('SELECT id AS value FROM dbo.financial_accounts WHERE student_id = @studentId', { studentId: reconciledLegacyStudent });
    const priorPayment = await pool.request().input('accountId', sql.Int, reconciledAccountId).input('actorId', sql.Int, financeId)
      .query(`INSERT INTO dbo.financial_transactions (financial_account_id, transaction_type, amount, description, reference_no, recorded_by, is_legacy_unattributed)
        OUTPUT INSERTED.id AS id VALUES (@accountId, N'payment', 50.00, N'Synthetic legacy source payment', N'SYNTH-G-CREDIT', @actorId, 1)`);
    const reconciliation = await finance.reconcileLegacyPayment(financeId, reconciledLegacyStudent, priorPayment.recordset[0].id, {
      reason: 'Synthetic pre-transfer reconciliation.', idempotencyKey: token(),
      allocations: [{ chargeId: String(reconciledCharge.id), amount: '50.00' }]
    });
    const blockedTransferPreview = await finance.previewLegacyOpeningLiability(financeId, reconciledLegacyStudent);
    assert.equal(blockedTransferPreview.activeReconciliationCount, 1);
    await expect409(finance.transferLegacyOpeningLiability(financeId, reconciledLegacyStudent, {
      expectedAmount: blockedTransferPreview.remainingBalance, sourceLabel: 'Reviewed prior account', reason: 'Must release first.', idempotencyKey: token()
    }), /Release all active legacy-payment reconciliations/);
    const reconRow = (await rows('SELECT id FROM dbo.finance_legacy_reconciliations WHERE transaction_id = @transactionId', { transactionId: priorPayment.recordset[0].id }))[0];
    await finance.releaseLegacyReconciliation(financeId, reconciledLegacyStudent, reconRow.id, {
      amount: '50.00', reason: 'Return credit to legacy source before transfer.', idempotencyKey: token()
    });
    const releasablePreview = await finance.previewLegacyOpeningLiability(financeId, reconciledLegacyStudent);
    assert.equal(releasablePreview.remainingBalance, '100.00');
    assert.equal(releasablePreview.activeReconciliationCount, 0);
    const transferAfterRelease = await finance.transferLegacyOpeningLiability(financeId, reconciledLegacyStudent, {
      expectedAmount: '100.00', sourceLabel: 'Reviewed prior account', reason: 'Synthetic full legacy review.', idempotencyKey: token()
    });
    assert.ok(transferAfterRelease.openingLiabilityId);
    const reconciledLedger = await finance.getStudentLedger(financeId, reconciledLegacyStudent);
    assert.equal(reconciledLedger.summary.unattributedLegacyBalance, '0.00');
    assert.equal(reconciledLedger.summary.openingLiabilityDue, '100.00');
    assert.equal(reconciledLedger.summary.allYearsAnnualBalance, '600.00');
    assert.equal(reconciledLedger.summary.totalBalance, '700.00');
    await expect409(finance.releaseLegacyReconciliation(financeId, reconciledLegacyStudent, reconRow.id, {
      amount: '1.00', reason: 'Post-transfer releases are blocked.', idempotencyKey: token()
    }), /after the account has been transferred/);
    passed('opening transfer requires append-only release of legacy allocations and blocks any later source-credit reuse');

    stage = 'race raw legacy write against opening transfer';
    const racingStudent = await insertStudent('SYNTH-F-006', '901000000008', null, '100.00');
    const racePreview = await finance.previewLegacyOpeningLiability(financeId, racingStudent);
    const raceInput = { expectedAmount: racePreview.remainingBalance, sourceLabel: 'Reviewed previous account', reason: 'Synthetic race test.', idempotencyKey: token() };
    const race = await Promise.allSettled([
      finance.transferLegacyOpeningLiability(financeId, racingStudent, raceInput),
      rawFinance.recordTransaction(financeId, racingStudent, { transactionType: 'charge', amount: '10.00', description: 'Synthetic concurrent legacy charge' })
    ]);
    assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
    const legacyChargeAdded = race[1].status === 'fulfilled';
    if (!legacyChargeAdded && !race[0].value?.openingLiabilityId) throw new Error('Transfer/raw write race had no successful operation.');
    let raceLedger = await finance.previewLegacyOpeningLiability(financeId, racingStudent);
    if (!raceLedger.alreadyTransferred) {
      await finance.transferLegacyOpeningLiability(financeId, racingStudent, {
        ...raceInput, expectedAmount: raceLedger.remainingBalance, idempotencyKey: token()
      });
    }
    const raceBalance = await rows(`SELECT legacy.remaining_legacy_balance, opening.amount_due
      FROM dbo.v_finance_legacy_account_balance AS legacy
      CROSS APPLY (SELECT SUM(amount_due) AS amount_due FROM dbo.v_finance_opening_liability_due WHERE student_id = legacy.student_id) AS opening
      WHERE legacy.student_id = @studentId`, { studentId: racingStudent });
    assert.equal(raceBalance[0].remaining_legacy_balance + raceBalance[0].amount_due, legacyChargeAdded ? 110 : 100);
    passed('account lock serializes raw legacy transactions with opening transfer without losing or duplicating balance');

    stage = 'record paper checklist history';
    await checklist.recordRequirement(registrarId, studentA, {
      requirementCode: 'birth_certificate', status: 'received', originalsReceived: '0', copiesReceived: '3', piecesReceived: '0', isApplicable: '1', note: '', idempotencyKey: token()
    });
    const custom = await checklist.recordRequirement(registrarId, studentA, {
      requirementCode: 'additional', requirementName: 'Synthetic school permission form', status: 'pending',
      originalsReceived: '0', copiesReceived: '0', piecesReceived: '0', isApplicable: '1', note: '', idempotencyKey: token()
    });
    assert.ok(custom.eventId);
    const physical = await checklist.getStudentChecklist(registrarId, studentA);
    assert.equal(physical.student.grade_level, 'Grade 11');
    assert.ok(physical.requirements.some((item) => item.requirement_code === 'national_id' && item.requirement_name === 'National ID (if you have)'));
    assert.ok(physical.additionalItems.some((item) => item.requirement_name === 'Synthetic school permission form'));
    passed('paper checklist stores original/copy/piece history and named additional requirements with poster labels');

    stage = 'record linked document request and append-only transition history';
    const requestInput = { documentType: 'Transcript', documentName: 'Grade 11 Transcript', requestedOn: '2026-09-30',
      reference: 'REQ-001', idempotencyKey: token() };
    const request = await documentRequestService.createRequest(registrarId, studentB, requestInput);
    const exactCreateReplay = await documentRequestService.createRequest(registrarId, studentB, requestInput);
    assert.equal(exactCreateReplay.requestId, request.requestId);
    assert.equal(exactCreateReplay.replayed, true);
    await expect409(documentRequestService.createRequest(registrarId, studentC, requestInput));
    await expect404(documentRequestService.transitionRequest(registrarId, studentC, request.requestId, {
      status: 'processing', idempotencyKey: token()
    }));
    await documentRequestService.transitionRequest(registrarId, studentB, request.requestId, { status: 'processing', idempotencyKey: token() });
    await documentRequestService.transitionRequest(registrarId, studentB, request.requestId, { status: 'ready', idempotencyKey: token() });
    const eventsBeforeInvalidRelease = Number(await scalar(`SELECT COUNT_BIG(*) AS value FROM dbo.student_document_request_events WHERE request_id = @requestId`, { requestId: request.requestId }));
    await assert.rejects(documentRequestService.transitionRequest(registrarId, studentB, request.requestId, {
      status: 'released', releasedOn: '2026-09-29', recipient: 'Synthetic Recipient', idempotencyKey: token()
    }), /Release date cannot be before the request date/);
    assert.equal(await scalar('SELECT status AS value FROM dbo.student_document_requests WHERE id = @requestId', { requestId: request.requestId }), 'ready');
    assert.equal(Number(await scalar(`SELECT COUNT_BIG(*) AS value FROM dbo.student_document_request_events WHERE request_id = @requestId`, { requestId: request.requestId })), eventsBeforeInvalidRelease);
    const releaseInput = { status: 'released', releasedOn: '2026-10-01', recipient: 'Synthetic Recipient', idempotencyKey: token() };
    const release = await documentRequestService.transitionRequest(registrarId, studentB, request.requestId, releaseInput);
    assert.equal(release.status, 'released');
    assert.equal((await documentRequestService.transitionRequest(registrarId, studentB, request.requestId, releaseInput)).replayed, true);
    await expect409(documentRequestService.transitionRequest(registrarId, studentB, request.requestId, { ...releaseInput, recipient: 'Changed Recipient' }));
    const terminalCorrectionInput = {
      documentType: 'Transcript', documentName: 'Grade 11 Transcript', requestedOn: '2026-09-30', reference: 'REQ-CORRECTED',
      releasedOn: '2026-10-02', recipient: 'Corrected Recipient', reason: 'Corrected release record typo.', idempotencyKey: token()
    };
    const terminalCorrection = await documentRequestService.correctRequest(registrarId, studentB, request.requestId, terminalCorrectionInput);
    assert.equal(terminalCorrection.status, 'released');
    assert.equal((await documentRequestService.correctRequest(registrarId, studentB, request.requestId, terminalCorrectionInput)).replayed, true);
    await expect409(documentRequestService.correctRequest(registrarId, studentB, request.requestId, { ...terminalCorrectionInput, recipient: 'Changed Recipient' }));
    const eventCountBeforeBadTerminalCorrection = Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.student_document_request_events WHERE request_id = @requestId', { requestId: request.requestId }));
    await assert.rejects(documentRequestService.correctRequest(registrarId, studentB, request.requestId, {
      ...terminalCorrectionInput, requestedOn: '2026-10-03', releasedOn: '2026-10-02', idempotencyKey: token()
    }), /Release date cannot be before the request date/);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.student_document_request_events WHERE request_id = @requestId', { requestId: request.requestId })), eventCountBeforeBadTerminalCorrection);
    const releasedProjection = await rows(`SELECT status, released_on, recipient, reference_text
      FROM dbo.student_document_requests WHERE id = @requestId`, { requestId: request.requestId });
    assert.equal(releasedProjection[0].status, 'released');
    assert.equal(releasedProjection[0].released_on.toISOString().slice(0, 10), '2026-10-02');
    assert.equal(releasedProjection[0].recipient, 'Corrected Recipient');
    assert.equal(releasedProjection[0].reference_text, 'REQ-CORRECTED');
    const eventCountAfterTerminalCorrection = Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.student_document_request_events WHERE request_id = @requestId', { requestId: request.requestId }));
    await assert.rejects(pool.request().input('requestId', sql.UniqueIdentifier, request.requestId)
      .query('UPDATE dbo.student_document_request_events SET reason = N\'rewritten\' WHERE request_id = @requestId'), (error) => error.number === 51007);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.student_document_request_events WHERE request_id = @requestId', { requestId: request.requestId })), eventCountAfterTerminalCorrection);
    await assert.rejects(pool.request()
      .input('requestId', sql.UniqueIdentifier, request.requestId).input('actorId', sql.Int, registrarId)
      .input('key', sql.UniqueIdentifier, token()).input('fingerprint', sql.Char(64), 'a'.repeat(64))
      .query(`INSERT INTO dbo.student_document_request_events
        (request_id, actor_id, event_type, status_from, status_to, idempotency_key, request_fingerprint)
        VALUES (@requestId, @actorId, N'processing', N'requested', N'ready', @key, @fingerprint)`), (error) => error.number === 547);

    const cancellationRequest = await documentRequestService.createRequest(registrarId, studentB, {
      ...requestInput, documentName: 'Enrollment Letter', reference: null, idempotencyKey: token()
    });
    await documentRequestService.transitionRequest(registrarId, studentB, cancellationRequest.requestId, {
      status: 'cancelled', reason: 'Student withdrew the request.', idempotencyKey: token()
    });
    const cancelledCorrection = await documentRequestService.correctRequest(registrarId, studentB, cancellationRequest.requestId, {
      documentType: 'Letter', documentName: 'Enrollment Letter', requestedOn: '2026-09-30', reference: 'REQ-CANCELLED',
      reason: 'Added the missing tracking reference.', idempotencyKey: token()
    });
    assert.equal(cancelledCorrection.status, 'cancelled');
    assert.equal(await scalar('SELECT status AS value FROM dbo.student_document_requests WHERE id = @requestId', { requestId: cancellationRequest.requestId }), 'cancelled');
    const requestHistory = await documentRequestService.getStudentRequests(registrarId, studentB);
    assert.ok(requestHistory.find((entry) => entry.id === String(request.requestId).toLowerCase()).history.some((event) => event.event_type === 'corrected'
      && event.recipient_before === 'Synthetic Recipient' && event.recipient_after === 'Corrected Recipient'));
    passed('document request ownership, CSRF-ready state actions, exact idempotency, release chronology, terminal correction, and append-only history are verified');

    stage = 'build and classify published grades and missing period states';
    const gradeStudentOne = await insertStudent('SYNTH-GRADE-001', '901000000011', null, '0.00');
    const gradeStudentTwo = await insertStudent('SYNTH-GRADE-002', '901000000012', null, '0.00');
    const gradeHistoryStudent = await insertStudent('SYNTH-GRADE-HISTORY-003', '901000000013', null, '0.00');
    const gradeSubjectResult = await pool.request().input('code', sql.NVarChar(50), 'SYNTH-ENG')
      .query(`INSERT INTO dbo.subjects (subject_code, subject_name) OUTPUT INSERTED.id AS id VALUES (@code, N'Synthetic English')`);
    const gradeSubjectId = gradeSubjectResult.recordset[0].id;
    const gradeSection = await pool.request().input('termId', sql.Int, terms[0].id)
      .input('name', sql.NVarChar(100), 'Synthetic Grade Overview Section')
      .query(`INSERT INTO dbo.sections (name, grade_level, academic_term_id)
        OUTPUT INSERTED.id AS id VALUES (@name, N'Grade 11', @termId)`);
    const gradeSectionId = gradeSection.recordset[0].id;
    const gradePlacements = [];
    for (const studentId of [gradeStudentOne, gradeStudentTwo]) {
      const placement = await pool.request().input('studentId', sql.Int, studentId).input('termId', sql.Int, terms[0].id).input('sectionId', sql.Int, gradeSectionId)
        .query(`INSERT INTO dbo.enrollments (student_id, academic_term_id, section_id, enrollment_status)
          OUTPUT INSERTED.id AS id VALUES (@studentId, @termId, @sectionId, N'enrolled')`);
      const enrollmentId = placement.recordset[0].id;
      const studentSubject = await pool.request().input('enrollmentId', sql.Int, enrollmentId).input('subjectId', sql.Int, gradeSubjectId)
        .query(`INSERT INTO dbo.student_subjects (enrollment_id, subject_id) OUTPUT INSERTED.id AS id VALUES (@enrollmentId, @subjectId)`);
      gradePlacements.push({ studentId, enrollmentId, studentSubjectId: studentSubject.recordset[0].id });
    }
    const teacherId = await insertUser('grade-overview-teacher', 'teacher');
    const assignment = await pool.request().input('teacherId', sql.Int, teacherId).input('termId', sql.Int, terms[0].id)
      .input('sectionId', sql.Int, gradeSectionId).input('subjectId', sql.Int, gradeSubjectId).input('registrarId', sql.Int, registrarId)
      .query(`INSERT INTO dbo.teacher_assignments (teacher_id, academic_term_id, section_id, subject_id, assigned_by)
        OUTPUT INSERTED.id AS id VALUES (@teacherId, @termId, @sectionId, @subjectId, @registrarId)`);
    const assignmentId = assignment.recordset[0].id;
    const submissionId = token();
    await pool.request().input('submissionId', sql.UniqueIdentifier, submissionId).input('assignmentId', sql.Int, assignmentId)
      .input('teacherId', sql.Int, teacherId).input('schoolYear', sql.NVarChar(20), terms[0].schoolYear)
      .input('subjectId', sql.Int, gradeSubjectId)
      .query(`INSERT INTO dbo.teacher_grade_submissions
        (id, assignment_id, revision_number, submitted_by, school_year, grade_level, section_name,
          subject_id, subject_name, workbook_grade_level, workbook_section_name, workbook_subject_name,
          context_mismatch, original_filename, storage_key, file_size_bytes, status)
        VALUES (@submissionId, @assignmentId, 1, @teacherId, @schoolYear, N'Grade 11', N'Synthetic Grade Overview Section',
          @subjectId, N'Synthetic English', N'Grade 11', N'Synthetic Grade Overview Section', N'Synthetic English',
          0, N'synthetic.xlsx', NEWID(), 4, N'pending')`);
    const matchedPlacement = gradePlacements[0];
    const submissionRow = await pool.request().input('submissionId', sql.UniqueIdentifier, submissionId)
      .input('studentId', sql.Int, matchedPlacement.studentId).input('enrollmentId', sql.Int, matchedPlacement.enrollmentId)
      .input('studentSubjectId', sql.Int, matchedPlacement.studentSubjectId)
      .query(`INSERT INTO dbo.teacher_grade_submission_rows
        (submission_id, source_row, student_id, enrollment_id, student_subject_id, student_no, name_mismatch)
        OUTPUT INSERTED.id AS id VALUES (@submissionId, 2, @studentId, @enrollmentId, @studentSubjectId, N'SYNTH-GRADE-001', 0)`);
    await pool.request().input('rowId', sql.BigInt, submissionRow.recordset[0].id)
      .query(`INSERT INTO dbo.teacher_grade_submission_grades (submission_row_id, grading_period, grade_value)
        VALUES (@rowId, N'Term 2', 80.00)`);
    await pool.request().input('studentSubjectId', sql.Int, matchedPlacement.studentSubjectId).input('registrarId', sql.Int, registrarId)
      .query(`INSERT INTO dbo.grades (student_subject_id, grading_period, grade_value, recorded_by)
        VALUES (@studentSubjectId, N'Term 1', 0.00, @registrarId)`);
    const gradeOverview = await gradeOverviewService.getOverview(registrarId, {
      termId: terms[0].id, sectionId: gradeSectionId, subjectId: gradeSubjectId
    });
    assert.equal(gradeOverview.totals.distinctLearners, 2);
    assert.equal(gradeOverview.totals.periodEntries, 8);
    assert.equal(gradeOverview.totals.published, 1);
    assert.equal(gradeOverview.totals.pendingReview, 3);
    assert.equal(gradeOverview.totals.noSubmission, 4);
    const zeroGrade = gradeOverview.entries.find((entry) => entry.student_id === gradeStudentOne && entry.grading_period === 'Term 1');
    assert.equal(zeroGrade.grade_value, 0);
    assert.equal(zeroGrade.status, 'published');
    assert.equal(zeroGrade.submission_status, 'pending');
    const pendingCached = gradeOverview.entries.find((entry) => entry.student_id === gradeStudentOne && entry.grading_period === 'Term 2');
    assert.equal(pendingCached.status, 'pending_review');
    assert.equal(pendingCached.hasCachedGrade, true);
    assert.equal(gradeOverview.entries.find((entry) => entry.student_id === gradeStudentTwo && entry.grading_period === 'Term 1').status, 'no_submission');

    const historicPlacement = await pool.request().input('studentId', sql.Int, gradeHistoryStudent).input('termId', sql.Int, legacyTermId).input('sectionId', sql.Int, legacySectionId)
      .query(`INSERT INTO dbo.enrollments (student_id, academic_term_id, section_id, enrollment_status)
        OUTPUT INSERTED.id AS id VALUES (@studentId, @termId, @sectionId, N'enrolled')`);
    await pool.request().input('enrollmentId', sql.Int, historicPlacement.recordset[0].id).input('subjectId', sql.Int, gradeSubjectId)
      .query('INSERT INTO dbo.student_subjects (enrollment_id, subject_id) VALUES (@enrollmentId, @subjectId)');
    const historicalOverview = await gradeOverviewService.getOverview(registrarId, {
      termId: legacyTermId, sectionId: legacySectionId, subjectId: gradeSubjectId
    });
    assert.equal(historicalOverview.totals.distinctLearners, 1);
    assert.equal(historicalOverview.totals.periodEntries, 0);
    assert.deepEqual(historicalOverview.periods, []);
    passed('grade overview counts learners separately from period entries, preserves published zero during pending revision, classifies no submission, and infers no historical periods');

    stage = 'record atomic staff-only profile field revisions';
    const profileInput = { studentNo: 'SYNTH-B-002', lrn: '901000000002', firstName: 'Synthetic Revised', lastName: 'Learner' };
    await recordsService.saveStudent(adminId, studentB, profileInput);
    const firstRevisionRows = await rows('SELECT field_name, before_value, after_value FROM dbo.student_profile_revisions WHERE student_id = @studentId ORDER BY id', { studentId: studentB });
    assert.deepEqual(firstRevisionRows.map((row) => row.field_name), ['first_name']);
    assert.equal(firstRevisionRows[0].before_value, 'Synthetic SYNTH-B-002');
    assert.equal(firstRevisionRows[0].after_value, 'Synthetic Revised');
    await recordsService.saveStudent(adminId, studentB, profileInput);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.student_profile_revisions WHERE student_id = @studentId', { studentId: studentB })), 1);
    const rollbackRecords = createStudentRecordsService({ getPool: async () => pool, sql,
      transactionFactory: (databasePool) => {
        const transaction = new sql.Transaction(databasePool);
        const nativeRequest = transaction.request.bind(transaction);
        transaction.request = () => {
          const request = nativeRequest();
          const nativeQuery = request.query.bind(request);
          request.query = (statement, ...args) => {
            if (String(statement).includes('INSERT INTO dbo.audit_logs')) throw new Error('synthetic profile audit rollback');
            return nativeQuery(statement, ...args);
          };
          return request;
        };
        return transaction;
      }
    });
    await assert.rejects(rollbackRecords.saveStudent(adminId, studentB, { ...profileInput, firstName: 'Rollback Attempt' }), /synthetic profile audit rollback/);
    assert.equal(await scalar('SELECT first_name AS value FROM dbo.students WHERE id = @studentId', { studentId: studentB }), 'Synthetic Revised');
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.student_profile_revisions WHERE student_id = @studentId', { studentId: studentB })), 1);
    await assert.rejects(pool.request().input('studentId', sql.Int, studentB)
      .query('DELETE FROM dbo.student_profile_revisions WHERE student_id = @studentId'), (error) => error.number === 51007);
    assert.equal(Number(await scalar('SELECT COUNT_BIG(*) AS value FROM dbo.student_profile_revisions WHERE student_id = @studentId', { studentId: studentB })), 1);
    passed('profile revisions are field-level, staff-attributed, no-op suppressed, transactional, and append-only');

    process.stdout.write(JSON.stringify({ database: databaseName, result: 'passed', checks: tests }, null, 2) + '\n');
  } finally {
    if (pool) await pool.close();
    const cleanup = new sql.ConnectionPool(connectionConfig('master', 1));
    try {
      await cleanup.connect();
      await cleanup.request().query(`IF DB_ID(N'${databaseName}') IS NOT NULL BEGIN ALTER DATABASE ${safeName(databaseName)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${safeName(databaseName)}; END;`);
    } finally {
      await cleanup.close();
      await master.close().catch(() => {});
    }
  }

  async function insertUser(suffix, role) {
    const result = await pool.request()
      .input('email', sql.NVarChar(255), `${suffix}@example.test`)
      .input('role', sql.NVarChar(30), role)
      .query(`INSERT INTO dbo.users (email, password_hash, role, is_active, email_verified_at)
        OUTPUT INSERTED.id AS id VALUES (@email, N'synthetic-hash', @role, 1, SYSUTCDATETIME())`);
    return result.recordset[0].id;
  }
  async function seedPre005Fixture() {
    stage = 'seed v2.004 finance actor';
    financeId = await insertUser('finance', 'finance');
    stage = 'seed v2.004 registrar actor';
    registrarId = await insertUser('registrar', 'registrar');
    stage = 'seed v2.004 database administrator actor';
    adminId = await insertUser('administrator', 'database_admin');
    stage = 'seed v2.004 disabled student login';
    legacyStudentUserId = await insertUser('legacy-student-disabled', 'student');
    await pool.request().input('userId', sql.Int, legacyStudentUserId)
      .query('UPDATE dbo.users SET is_active = 0, must_change_password = 0 WHERE id = @userId');
    stage = 'seed v2.004 student profile and legacy account';
    legacyStudentId = await insertStudent('SYNTH-A-001', '901000000001', legacyStudentUserId, '-50.00');
    stage = 'seed v2.004 academic term';
    const term = await pool.request().query(`INSERT INTO dbo.academic_terms (school_year, term, is_current)
      OUTPUT INSERTED.id AS id VALUES (N'2025-2026', N'Semester 2', 0)`);
    legacyTermId = term.recordset[0].id;
    stage = 'seed v2.004 section';
    const section = await pool.request().input('termId', sql.Int, legacyTermId)
      .query(`INSERT INTO dbo.sections (name, grade_level, academic_term_id)
        OUTPUT INSERTED.id AS id VALUES (N'Legacy Synthetic Section', N'Grade 11', @termId)`);
    legacySectionId = section.recordset[0].id;
    stage = 'seed v2.004 enrollment';
    const enrollment = await pool.request().input('studentId', sql.Int, legacyStudentId)
      .input('termId', sql.Int, legacyTermId).input('sectionId', sql.Int, legacySectionId)
      .query(`INSERT INTO dbo.enrollments (student_id, academic_term_id, section_id, enrollment_status)
        OUTPUT INSERTED.id AS id VALUES (@studentId, @termId, @sectionId, N'pending_payment')`);
    legacyEnrollmentId = enrollment.recordset[0].id;
    stage = 'seed v2.004 clearance';
    await pool.request().input('enrollmentId', sql.Int, legacyEnrollmentId).input('registrarId', sql.Int, registrarId)
      .query(`INSERT INTO dbo.enrollment_clearances (enrollment_id, clearance_status, created_by, created_for_intake)
        VALUES (@enrollmentId, N'pending', @registrarId, 1)`);
    stage = 'seed v2.004 unattributed transaction';
    const accountId = await scalar('SELECT id AS value FROM dbo.financial_accounts WHERE student_id = @studentId', { studentId: legacyStudentId });
    const payment = await pool.request().input('accountId', sql.Int, accountId).input('actorId', sql.Int, financeId)
      .query(`INSERT INTO dbo.financial_transactions (financial_account_id, transaction_type, amount, description, reference_no, recorded_by)
        OUTPUT INSERTED.id AS id VALUES (@accountId, N'payment', 50.00, N'Synthetic old credit private text', N'OLD-CREDIT', @actorId)`);
    legacyTransactionId = payment.recordset[0].id;
  }
  async function insertStudent(studentNo, lrn, userId, balance) {
    const student = await pool.request()
      .input('studentNo', sql.NVarChar(50), studentNo).input('lrn', sql.NVarChar(12), lrn)
      .input('firstName', sql.NVarChar(100), `Synthetic ${studentNo}`).input('lastName', sql.NVarChar(100), 'Learner')
      .input('userId', sql.Int, userId).query(`DECLARE @insertedStudents TABLE (id INT);
        INSERT INTO dbo.students (user_id, student_no, lrn, first_name, last_name)
        OUTPUT INSERTED.id INTO @insertedStudents(id)
        VALUES (@userId, @studentNo, @lrn, @firstName, @lastName);
        SELECT id FROM @insertedStudents`);
    const id = student.recordset[0].id;
    await pool.request().input('studentId', sql.Int, id).input('balance', sql.Decimal(12, 2), balance)
      .query('INSERT INTO dbo.financial_accounts (student_id, balance) VALUES (@studentId, @balance)');
    return id;
  }
  async function insertAnnual(studentId, voucher) {
    const parent = await pool.request().input('studentId', sql.Int, studentId).input('voucher', sql.NVarChar(10), voucher)
      .input('registrarId', sql.Int, registrarId).query(`INSERT INTO dbo.annual_enrollments (student_id, school_year, grade_level, voucher_code, intake_status, created_by)
        OUTPUT INSERTED.id AS id VALUES (@studentId, N'2026-2027', N'Grade 11', @voucher, N'pending', @registrarId)`);
    const parentId = parent.recordset[0].id;
    const placements = [];
    for (const term of terms.filter((row) => row.schoolYear === '2026-2027')) {
      const section = sections.find((row) => row.schoolYear === term.schoolYear && row.number === term.number);
      const inserted = await pool.request().input('studentId', sql.Int, studentId).input('parentId', sql.Int, parentId)
        .input('termId', sql.Int, term.id).input('sectionId', sql.Int, section.sectionId).input('number', sql.TinyInt, term.number)
        .query(`INSERT INTO dbo.enrollments (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id, annual_term_number)
          OUTPUT INSERTED.id AS id VALUES (@studentId, @termId, @sectionId, N'pending_payment', @parentId, @number)`);
      const enrollmentId = inserted.recordset[0].id;
      placements.push(enrollmentId);
      await pool.request().input('enrollmentId', sql.Int, enrollmentId).query('INSERT INTO dbo.term_finance_approvals (enrollment_id, status) VALUES (@enrollmentId, N\'pending\')');
    }
    return { id: parentId, placements };
  }
  async function getCharges(annualId) {
    return rows(`SELECT charge.id, charge.enrollment_id, enrollment.annual_term_number AS term_number
      FROM dbo.assessed_charges AS charge INNER JOIN dbo.enrollments AS enrollment ON enrollment.id = charge.enrollment_id
      WHERE charge.annual_enrollment_id = @annualId ORDER BY enrollment.annual_term_number`, { annualId });
  }
  async function rows(query, inputs = {}) {
    const request = pool.request();
    for (const [name, value] of Object.entries(inputs)) request.input(name, value);
    return (await request.query(query)).recordset || [];
  }
  async function scalar(query, inputs = {}) {
    const result = await rows(query, inputs);
    return result[0]?.value;
  }
}

main().catch((error) => {
  process.stderr.write(`[${stage}] ${error.name || 'Error'}: ${error.message || 'SQL smoke failed.'} (SQL line ${error.lineNumber ?? 'unknown'}, code ${error.number ?? 'unknown'})\n${error.stack || ''}\n`);
  process.exitCode = 1;
});
