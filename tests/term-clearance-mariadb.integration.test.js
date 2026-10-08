'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { PoolFacade, Transaction, sql } = require('../src/config/database');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { createTermClearanceService, TermClearanceError, completeFromCounts } = require('../src/services/termClearanceService');
const { createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');

const socketPath = process.env.TERM_CLEARANCE_MARIADB_TEST_SOCKET;
const ROOT = path.resolve(__dirname, '..');

function uuid() { return crypto.randomUUID(); }
function databaseQuote(name) { return `\`${name.replaceAll('`', '``')}\``; }
function socketAllowed(socket) {
  if (!path.isAbsolute(socket)) return false;
  const localSocket = path.resolve(os.homedir(), '.local/share/arktiesiis/local-mariadb/mariadb.sock');
  return path.resolve(socket) === localSocket || path.resolve(socket).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`);
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function createSchema(connection, name, through = 'v2.017') {
  await connection.query(`CREATE DATABASE ${databaseQuote(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.query(`USE ${databaseQuote(name)}`);
  await applyStatements(connection, readSqlFile(path.resolve(ROOT, 'database/mariadb/schema.sql')));
  for (const migration of readForwardMigrations()) {
    if (migration.version > through) break;
    await applyStatements(connection, migration.statements);
    await connection.query('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
  }
}

async function insertUser(pool, role, firstName = role, lastName = 'User') {
  const email = `${role}-${uuid()}@integration.invalid`;
  const [created] = await pool.execute('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
    [email, 'integration-only-not-a-login-hash', role]);
  const id = Number(created.insertId);
  if (role !== 'student') await pool.execute('INSERT INTO staff_profiles (user_id, first_name, last_name) VALUES (?, ?, ?)',
    [id, firstName, lastName]);
  return id;
}

async function insertStudent(pool, registrarId, studentUserId, { studentNo, lrn, firstName = 'Ari' }) {
  const [created] = await pool.execute(`INSERT INTO students
    (user_id, student_no, lrn, first_name, middle_name, last_name, status)
    VALUES (?, ?, ?, ?, 'Mae', 'Santos', 'active')`, [studentUserId, studentNo, lrn, firstName]);
  return Number(created.insertId);
}

async function createYear(pool, registrarId, schoolYear, { currentTerm = null, gradeLevel = 'Grade 11' } = {}) {
  const terms = [];
  for (let number = 1; number <= 3; number += 1) {
    const label = ['First Term', 'Second Term', 'Third Term'][number - 1];
    const [termInsert] = await pool.execute('INSERT INTO academic_terms (school_year, term, is_current) VALUES (?, ?, ?)',
      [schoolYear, label, number === currentTerm ? 1 : 0]);
    const termId = Number(termInsert.insertId);
    const [sectionInsert] = await pool.execute(`INSERT INTO sections
      (name, grade_level, academic_term_id, cluster, strand) VALUES (?, ?, ?, 'ASSH', 'Humanities')`,
    [`${gradeLevel} Section ${number}`, gradeLevel, termId]);
    const sectionId = Number(sectionInsert.insertId);
    await pool.execute(`INSERT INTO school_year_term_order
      (school_year, term_number, academic_term_id, configured_by, configuration_source)
      VALUES (?, ?, ?, ?, 'staff')`, [schoolYear, number, termId, registrarId]);
    terms.push({ number, label, id: termId, sectionId });
  }
  return terms;
}

async function createAnnual(pool, { studentId, registrarId, schoolYear, gradeLevel, intakeKind, status = 'enrolled', entryTermNumber = 1 }) {
  const [annualInsert] = await pool.execute(`INSERT INTO annual_enrollments
    (student_id, school_year, grade_level, voucher_code, intake_status, created_by, intake_kind, entry_term_number)
    VALUES (?, ?, ?, 'PUB', ?, ?, ?, ?)`, [studentId, schoolYear, gradeLevel, status, registrarId, intakeKind, entryTermNumber]);
  return Number(annualInsert.insertId);
}

async function createPlacements(pool, { studentId, annualId, terms, statuses = [], gradeLevel = 'Grade 11' }) {
  const rows = [];
  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index];
    const [inserted] = await pool.execute(`INSERT INTO enrollments
      (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status)
      VALUES (?, ?, ?, ?, ?, ?, 'applicable')`,
    [studentId, term.id, term.sectionId, statuses[index] || 'enrolled', annualId, term.number]);
    rows.push({ id: Number(inserted.insertId), ...term, gradeLevel });
  }
  return rows;
}

async function setCurrentTerm(pool, termId) {
  await pool.execute('UPDATE academic_terms SET is_current = 0 WHERE is_current = 1');
  await pool.execute('UPDATE academic_terms SET is_current = 1 WHERE id = ?', [termId]);
}

function templateInput(idempotencyKey, version = 1) {
  return { idempotencyKey, gradeLevel: 'Grade 11', trackLabel: 'Academic Track',
    officeConfirmations: ['registrar', 'guidance', 'finance'], laboratoryLabels: [`Laboratory line v${version}`],
    teacherRosterConfirmed: '1', laboratoryRowsConfirmed: '1' };
}

function reconciliation(paperTeacherRows = []) {
  return { rosterReviewed: '1', paperTeacherRows,
    rosterReconciliationReason: paperTeacherRows.length ? 'Compared with the signed historical paper roster.' : '' };
}

function completionInput(term, items, { token = uuid(), version = 1, correctionReason = '', attest = true,
  action = attest ? 'complete' : 'reopen', inspectedOn = '2026-10-05', signerChange = null } = {}) {
  const updates = items.map((item) => {
    const isTeacher = item.category === 'teacher';
    const isLab = item.category === 'laboratory';
    return { itemId: String(item.id), applicabilityStatus: isLab ? 'not_applicable' : 'required',
      applicabilityReason: isLab ? (item.applicability_reason || 'No laboratory signature applies to this recorded term.') : '',
      signaturePresent: isLab ? '' : '1',
      signerName: isLab ? '' : signerChange && isTeacher ? signerChange : item.signer_name || (isTeacher ? 'Paper teacher signer' : `${item.category} signer`),
      paperSignedOn: isTeacher ? item.paper_signed_on || '2026-10-01' : '',
      signerContextReason: isTeacher && item.teacher_context_status !== 'assigned'
        ? item.signer_context_reason || 'Name matches the historical paper form.' : '' };
  });
  return { idempotencyKey: token, expectedVersion: String(version), clearanceAction: action, scopeStatus: 'attended',
    items: updates, correctionReason, inspectedOn, attestPaperInspected: action === 'complete' ? '1' : '',
    paperInspected: action === 'complete' ? '1' : '' };
}

async function inTransaction(pool, callback) {
  const transaction = new Transaction(new PoolFacade(pool));
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await callback(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

test('v2.017 migration rehearsal and paper-clearance SQL, roles, snapshots, review gates, and replay', {
  skip: !socketPath && 'Set TERM_CLEARANCE_MARIADB_TEST_SOCKET to a disposable local MariaDB socket.',
  timeout: 180000
}, async () => {
  assert.equal(socketAllowed(socketPath), true, 'integration must use the user-private local MariaDB socket or a disposable socket under /tmp');
  const admin = await mysql.createConnection({ socketPath, user: os.userInfo().username, multipleStatements: false });
  const suffix = crypto.randomBytes(6).toString('hex');
  const freshName = `arktiesiis_clearance_fresh_${suffix}`;
  const upgradeName = `arktiesiis_clearance_upgrade_${suffix}`;
  let pool;
  try {
    await createSchema(admin, freshName, 'v2.017');
    await createSchema(admin, upgradeName, 'v2.016');
    await admin.query(`USE ${databaseQuote(upgradeName)}`);
    const migration017 = readForwardMigrations().find(({ version }) => version === 'v2.017');
    assert.ok(migration017, 'the forward-only v2.017 migration exists');
    await applyStatements(admin, migration017.statements);
    await admin.execute('INSERT INTO schema_migrations (version) VALUES (?)', ['v2.017']);
    const [upgradeVersion] = await admin.execute('SELECT version FROM schema_migrations WHERE version = ?', ['v2.017']);
    assert.equal(upgradeVersion.length, 1, 'an existing v2.016 schema upgrades through v2.017');
    const [upgradeEvidence] = await admin.execute(`SELECT
      (SELECT COUNT(*) FROM term_clearance_templates) AS templates,
      (SELECT COUNT(*) FROM student_term_clearances) AS clearances,
      (SELECT COUNT(*) FROM annual_term_finalizations) AS finalizations,
      (SELECT continuity_source_annual_enrollment_id FROM annual_enrollments LIMIT 1) AS unused`);
    assert.equal(Number(upgradeEvidence[0].templates), 0, 'v2.017 does not invent historical paper templates');
    assert.equal(Number(upgradeEvidence[0].clearances), 0, 'v2.017 does not mark historical paper terms complete');
    assert.equal(Number(upgradeEvidence[0].finalizations), 0);

    await admin.query(`USE ${databaseQuote(freshName)}`);
    pool = mysql.createPool({ socketPath, user: os.userInfo().username, database: freshName,
      waitForConnections: true, connectionLimit: 8, queueLimit: 0, supportBigNumbers: true, bigNumberStrings: true,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false });
    const appPool = new PoolFacade(pool);
    const registrarId = await insertUser(pool, 'registrar', 'Regina', 'Registrar');
    const financeId = await insertUser(pool, 'finance', 'Faye', 'Finance');
    const frontDeskId = await insertUser(pool, 'front_desk', 'Frank', 'Frontdesk');
    const adminId = await insertUser(pool, 'database_admin', 'Dana', 'Admin');
    const teacherId = await insertUser(pool, 'teacher', 'Terry', 'Teacher');
    const studentUserId = await insertUser(pool, 'student');
    const studentId = await insertStudent(pool, registrarId, studentUserId, { studentNo: 'STU-CL-1', lrn: '000000000101' });
    const sourceTerms = await createYear(pool, registrarId, '2026-2027', { currentTerm: 1, gradeLevel: 'Grade 11' });
    const targetTerms = await createYear(pool, registrarId, '2027-2028', { gradeLevel: 'Grade 12' });
    const sourceAnnualId = await createAnnual(pool, { studentId, registrarId, schoolYear: '2026-2027', gradeLevel: 'Grade 11', intakeKind: 'continuing' });
    const sourcePlacements = await createPlacements(pool, { studentId, annualId: sourceAnnualId, terms: sourceTerms,
      statuses: ['enrolled', 'cancelled', 'pending_payment'] });
    const [subjectInsert] = await pool.execute('INSERT INTO subjects (subject_code, subject_name, units) VALUES (?, ?, ?)',
      ['ENG11', 'English for Academic Purposes', '3.00']);
    const subjectId = Number(subjectInsert.insertId);
    await pool.execute('INSERT INTO student_subjects (enrollment_id, subject_id) VALUES (?, ?)', [sourcePlacements[0].id, subjectId]);
    await pool.execute(`INSERT INTO teacher_assignments
      (teacher_id, academic_term_id, section_id, subject_id, assigned_by, is_active, revoked_at)
      VALUES (?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(3))`, [teacherId, sourceTerms[0].id, sourceTerms[0].sectionId, subjectId, registrarId]);

    const continuingAnnualId = await createAnnual(pool, { studentId, registrarId, schoolYear: '2027-2028', gradeLevel: 'Grade 12', intakeKind: 'continuing', status: 'pending' });
    const continuingPlacements = await createPlacements(pool, { studentId, annualId: continuingAnnualId, terms: targetTerms,
      statuses: ['pending_payment', 'pending_payment', 'pending_payment'], gradeLevel: 'Grade 12' });
    const clearance = createTermClearanceService({ getPool: async () => appPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool) });
    const annualFinance = createAnnualFinanceService({ getPool: async () => appPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool) });
    const annualEnrollment = createAnnualEnrollmentService({ getPool: async () => appPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), hashPassword: async (value) => `integration:${value}`,
      createPassword: () => 'integration-only-password', annualFinanceService: annualFinance, termClearanceService: clearance });
    await pool.execute('UPDATE academic_terms SET is_current = 0');
    const noCurrentDashboard = await clearance.getClearanceDashboard(registrarId);
    assert.equal(noCurrentDashboard.currentTerm, null);
    assert.equal(noCurrentDashboard.needsTermSelection, true);
    assert.equal(noCurrentDashboard.filters.termId, '', 'without a current term the dashboard opens in All terms');
    assert.equal(noCurrentDashboard.counts.totalRecords, 6);
    const [unmappedCurrent] = await pool.execute(`INSERT INTO academic_terms (school_year, term, is_current)
      VALUES ('2098-2099', 'Unmapped current term', 0)`);
    await pool.execute('UPDATE academic_terms SET is_current = 1 WHERE id = ?', [unmappedCurrent.insertId]);
    const unmappedDashboard = await clearance.getClearanceDashboard(registrarId);
    assert.equal(unmappedDashboard.currentTerm, null, 'a current term without an order mapping does not become the default');
    assert.equal(unmappedDashboard.needsTermSelection, true);
    await pool.execute('UPDATE academic_terms SET is_current = 0 WHERE id = ?', [unmappedCurrent.insertId]);
    await setCurrentTerm(pool, sourceTerms[0].id);
    const initialDashboard = await clearance.getClearanceDashboard(registrarId);
    assert.equal(initialDashboard.currentTerm.id, sourceTerms[0].id);
    assert.equal(initialDashboard.filters.termId, String(sourceTerms[0].id), 'an unfiltered dashboard defaults to the uniquely configured current term');
    assert.equal(initialDashboard.counts.notReviewed, 1, 'a placement without a clearance row is still counted as not reviewed');
    assert.equal(initialDashboard.rows[0].clearance_state, 'not_reviewed');
    const initialOverview = await clearance.getStudentClearanceOverview(registrarId, studentId);
    assert.deepEqual(initialOverview, { totalRecords: 6, completed: 0, pending: 1, incomplete: 0, notReviewed: 1,
      notAttended: 0, notApplicable: 5 }, 'the compact student summary uses the same term-record status rules');
    await assert.rejects(clearance.getClearanceDashboard(frontDeskId), { status: 403 });
    await assert.rejects(clearance.getClearanceDashboard(teacherId), { status: 403 });
    await assert.rejects(clearance.getClearanceDashboard(financeId), { status: 403 });
    await assert.rejects(clearance.getClearanceDashboard(studentUserId), { status: 403 });
    const adminDashboard = await clearance.getClearanceDashboard(adminId);
    assert.equal(adminDashboard.counts.totalRecords, 1, 'database administrators can read the scoped dashboard');

    for (let index = 1; index <= 26; index += 1) {
      const dashboardStudentUser = await insertUser(pool, 'student');
      const dashboardStudent = await insertStudent(pool, registrarId, dashboardStudentUser, {
        studentNo: `STU-CL-DASH-${String(index).padStart(2, '0')}`,
        lrn: String(900000000000 + index).slice(-12), firstName: `Dashboard${String(index).padStart(2, '0')}`
      });
      const dashboardAnnual = await createAnnual(pool, { studentId: dashboardStudent, registrarId,
        schoolYear: '2026-2027', gradeLevel: 'Grade 11', intakeKind: 'new', entryTermNumber: index === 1 ? 2 : 1 });
      await createPlacements(pool, { studentId: dashboardStudent, annualId: dashboardAnnual, terms: [sourceTerms[0]] });
    }
    const pagedDashboard = await clearance.getClearanceDashboard(registrarId,
      { search: '', schoolYear: '', termId: '', status: 'all', page: '2' });
    assert.equal(pagedDashboard.filters.termId, '', 'an explicit blank term survives pagination instead of resetting to current');
    assert.equal(pagedDashboard.filters.schoolYear, '');
    assert.equal(pagedDashboard.pagination.page, 2);
    assert.equal(pagedDashboard.pagination.totalRecords, 32);
    assert.equal(pagedDashboard.pagination.matchedRecords, 32);
    assert.equal(pagedDashboard.rows.length, 7, 'all-term results are paginated after the first 25 rows');
    assert.deepEqual({ notReviewed: pagedDashboard.counts.notReviewed, notApplicable: pagedDashboard.counts.notApplicable },
      { notReviewed: 26, notApplicable: 6 }, 'a pre-entry term and future terms are excluded without a clearance row');
    const yearDashboard = await clearance.getClearanceDashboard(registrarId,
      { search: '', schoolYear: '2026-2027', termId: '', status: 'all' });
    assert.equal(yearDashboard.pagination.matchedRecords, 29, 'year filtering applies to term-record counts');
    assert.equal(yearDashboard.counts.notApplicable, 3, 'future source terms remain excluded inside the selected year');
    const reviewedFilter = await clearance.getClearanceDashboard(registrarId,
      { search: '', schoolYear: '', termId: '', status: 'not_reviewed' });
    assert.equal(reviewedFilter.pagination.totalRecords, 26);
    assert.equal(reviewedFilter.counts.totalRecords, 32, 'status filtering changes the list but not the cross-status counts');
    assert.equal(reviewedFilter.countsIgnoreStatusFilter, true);
    const searchedDashboard = await clearance.getClearanceDashboard(registrarId,
      { search: 'STU-CL-DASH-05', schoolYear: '', termId: '', status: 'all' });
    assert.equal(searchedDashboard.pagination.matchedRecords, 1, 'search filters both rows and aggregate counts');
    assert.equal(searchedDashboard.counts.notReviewed, 1);
    const scheduleLines = [1, 2, 3].flatMap((termNumber) => ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment, index) => ({
      termNumber, feeCategory: 'tuition', lineName: 'Tuition', installment,
      amount: index === 0 ? '1.00' : '0.00', isOptional: false
    })));
    const schedule = await annualFinance.createSchedule(financeId, { schoolYear: '2027-2028', gradeLevel: 'Grade 12',
      voucherCode: 'PUB', lines: scheduleLines, idempotencyKey: uuid() });
    const frontDeskPaperSourceId = uuid();
    await pool.execute(`INSERT INTO pre_enrollments
      (id, idempotency_key, request_fingerprint, school_year, first_name, middle_name, last_name, lrn,
        target_grade_level, email, status, created_by, updated_by, created_by_role, applicant_kind)
      VALUES (?, ?, ?, '2027-2028', 'Ari', 'Mae', 'Santos', '000000000101', 'Grade 12',
        'ari-clearance@integration.invalid', 'enrollment_started', ?, ?, 'front_desk', 'continuing')`,
    [frontDeskPaperSourceId, uuid(), 'b'.repeat(64), frontDeskId, frontDeskId]);
    await pool.execute('UPDATE annual_enrollments SET pre_enrollment_id = ? WHERE id = ?', [frontDeskPaperSourceId, continuingAnnualId]);

    const sourceOptions = await clearance.getContinuitySourceOptions(registrarId, continuingAnnualId);
    assert.equal(sourceOptions.candidates.length, 1, 'only the exact preceding school year is offered for source review');
    assert.equal(sourceOptions.candidates[0].schoolYear, '2026-2027');
    const unboundReview = await clearance.getAnnualPrerequisiteReview(registrarId, continuingAnnualId);
    assert.equal(unboundReview.ready, false, 'an upgraded unbound continuing intake fails closed until the registrar reviews its source');
    await clearance.bindContinuitySource(registrarId, continuingAnnualId, sourceAnnualId,
      { reason: 'Matched the registrar annual history.', idempotencyKey: uuid() });
    assert.equal((await clearance.getContinuitySourceOptions(registrarId, continuingAnnualId)).sourceLocked, true,
      'a bound preceding-year source cannot be silently replaced');
    let review = await clearance.getAnnualPrerequisiteReview(registrarId, continuingAnnualId);
    assert.equal(review.kind, 'continuing_source');
    assert.equal(review.terms.find((term) => term.termNumber === 1).state, 'missing');
    assert.equal(review.terms.find((term) => term.termNumber === 2).state, 'not_applicable',
      'a configured future term is excluded by current academic period, even when its enrollment status is cancelled');
    assert.equal(review.terms.find((term) => term.termNumber === 3).state, 'not_applicable');
    await assert.rejects(inTransaction(pool, (transaction) => clearance.assertAnnualEntryPrerequisitesInTransaction(transaction,
      { actorId: registrarId, annualId: continuingAnnualId, expectedFingerprint: review.fingerprint })), { status: 409 });

    const firstTemplate = await clearance.createTemplateVersion(registrarId, templateInput(uuid(), 1));
    const firstTerm = sourcePlacements[0];
    const createFirst = { idempotencyKey: uuid(), scopeStatus: 'attended', templateId: String(firstTemplate.templateId),
      ...reconciliation() };
    const firstClearance = await clearance.createTermClearance(registrarId, firstTerm.id, createFirst, studentId);
    assert.equal(firstClearance.version, 1);
    assert.equal((await clearance.createTermClearance(registrarId, firstTerm.id, createFirst, studentId)).alreadyRecorded, true,
      'an exact repeated applicability request replays the original event');
    const paperBeforePayment = await pool.execute('SELECT version, attested_by, attested_at, inspected_on FROM student_term_clearances WHERE id = ?',
      [firstClearance.clearanceId]);
    const payment = await annualFinance.recordPayment(financeId, studentId, {
      amount: '5.00', paymentDate: '2026-10-01', idempotencyKey: uuid(), allocations: []
    });
    assert.ok(payment.paymentId, 'finance may independently record a payment while paper signatures remain incomplete');
    const paperAfterPayment = await pool.execute('SELECT version, attested_by, attested_at, inspected_on FROM student_term_clearances WHERE id = ?',
      [firstClearance.clearanceId]);
    assert.deepEqual(paperAfterPayment[0], paperBeforePayment[0], 'a finance payment does not sign or revise paper clearance');
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM student_term_clearance_events WHERE clearance_id = ?',
      [firstClearance.clearanceId]))[0][0].count), 1, 'finance payment does not add a paper signature or inspection event');

    const blockedReview = await clearance.getAnnualPrerequisiteReview(registrarId, continuingAnnualId);
    const blockedPreview = await annualFinance.annualAssessmentPreviewForRegistrar(registrarId, continuingAnnualId);
    const blockedConfirmation = { scheduleId: String(blockedPreview.scheduleId), scheduleVersion: String(blockedPreview.scheduleVersion),
      voucherCode: blockedPreview.voucherCode, assessmentId: '', optionalLineIds: [], snapshotFingerprint: blockedPreview.snapshotFingerprint,
      clearanceSnapshotFingerprint: blockedReview.fingerprint, idempotencyKey: uuid() };
    await assert.rejects(annualEnrollment.confirmAnnualEnrollment(registrarId, continuingAnnualId, blockedConfirmation), { status: 409 },
      'a real annual confirmation rejects an incomplete prior-term checklist');
    for (const table of ['annual_assessments', 'annual_registrar_confirmations', 'assessed_charges']) {
      assert.equal(Number((await pool.execute(`SELECT COUNT(*) AS count FROM ${table} WHERE annual_enrollment_id = ?`, [continuingAnnualId]))[0][0].count), 0,
        `failed prerequisite gate leaves ${table} untouched`);
    }
    assert.equal(Number((await pool.execute('SELECT is_active FROM users WHERE id = ?', [studentUserId]))[0][0].is_active), 1,
      'failed prerequisite gate does not change student login state');

    const secondTemplate = await clearance.createTemplateVersion(registrarId, templateInput(uuid(), 2));
    let studentClearance = await clearance.getStudentClearance(registrarId, studentId);
    const savedFirst = studentClearance.terms.find((term) => Number(term.enrollment_id) === firstTerm.id);
    assert.equal(Number(savedFirst.template_id), firstTemplate.templateId, 'later template versions do not replace a saved paper checklist');
    assert.equal(savedFirst.clearanceItems.find((item) => item.category === 'registrar').label_snapshot, 'Registrar');
    assert.equal(savedFirst.clearanceItems.find((item) => item.category === 'laboratory').label_snapshot, 'Laboratory line v1',
      'the saved paper-form snapshot retains its laboratory wording after newer template versions');
    assert.equal(savedFirst.state, 'incomplete');
    const unchangedItems = savedFirst.clearanceItems.map((item) => ({ itemId: String(item.id),
      applicabilityStatus: item.applicability_status, applicabilityReason: item.applicability_reason || '',
      signaturePresent: '', signerName: '', paperSignedOn: '', signerContextReason: '' }));
    const inspectionOnly = { idempotencyKey: uuid(), expectedVersion: '1', clearanceAction: 'prepare', scopeStatus: 'attended',
      items: unchangedItems, inspectedOn: '2026-10-03' };
    await assert.rejects(clearance.updateTermClearance(registrarId, firstClearance.clearanceId, inspectionOnly, studentId),
      /inspection date is recorded only when you record the completed paper form/i,
      'metadata-only preparation cannot save inspection evidence');
    const partialSignature = completionInput(firstTerm, savedFirst.clearanceItems,
      { version: 1, attest: false, action: 'prepare', signerChange: 'Unconfirmed signer' });
    await assert.rejects(clearance.updateTermClearance(registrarId, firstClearance.clearanceId, partialSignature, studentId),
      /paper signatures and line decisions are recorded only when you record the completed paper form/i,
      'direct service calls cannot save partial signature evidence under prepare');
    const malformedAction = { ...inspectionOnly, idempotencyKey: uuid(), clearanceAction: 'progress', inspectedOn: '' };
    await assert.rejects(clearance.updateTermClearance(registrarId, firstClearance.clearanceId, malformedAction, studentId),
      /choose whether to save paper-form setup/i, 'forged legacy partial-save actions are rejected server-side');
    const afterRejectedPreparation = await clearance.getStudentClearance(registrarId, studentId);
    const unchangedFirst = afterRejectedPreparation.terms.find((term) => Number(term.enrollment_id) === firstTerm.id);
    assert.equal(unchangedFirst.version, 1, 'rejected partial evidence writes create no revision');
    assert.equal(unchangedFirst.inspected_on, null, 'rejected setup does not save an inspection date');
    assert.equal(unchangedFirst.clearanceItems.some((item) => item.signature_present || item.signer_name), false);
    const incompleteDashboard = await clearance.getClearanceDashboard(registrarId,
      { search: '', schoolYear: '', termId: '', status: 'pending' });
    const incompleteRow = incompleteDashboard.rows.find((row) => Number(row.enrollment_id) === firstTerm.id);
    assert.ok(incompleteRow, 'unconfirmed paper records are grouped under the Not completed filter');
    assert.equal(Number(incompleteRow.clearance_complete), 0);
    assert.equal(completeFromCounts(incompleteRow), false);
    const inspectionReview = await clearance.getAnnualPrerequisiteReview(registrarId, continuingAnnualId);
    assert.equal(inspectionReview.terms.find((term) => term.termNumber === 1).awaitingConfirmation, false,
      'partial signatures have not been saved before the complete paper record is confirmed');
    const studentInspectionProgress = await clearance.getOwnStudentProgress(studentUserId);
    assert.equal(studentInspectionProgress.terms.find((term) => term.schoolYear === '2026-2027' && term.termNumber === 1).status, 'pending',
      'students see one safe Not completed status and no signature collection progress');
    const firstCompleteInput = completionInput(firstTerm, savedFirst.clearanceItems, { version: 1, inspectedOn: '2026-10-03' });
    const completed = await clearance.updateTermClearance(registrarId, firstClearance.clearanceId, firstCompleteInput, studentId);
    assert.equal(completed.attested, true);
    assert.equal(completed.version, 2);
    assert.equal((await clearance.getStudentClearance(registrarId, studentId)).terms.find((term) => Number(term.enrollment_id) === firstTerm.id).state,
      'complete', 'the staff record reader uses the full attestation and office/teacher predicate');
    const completedDashboard = await clearance.getClearanceDashboard(registrarId,
      { search: '', schoolYear: '', termId: '', status: 'complete' });
    const completedRow = completedDashboard.rows.find((row) => Number(row.enrollment_id) === firstTerm.id);
    assert.ok(completedRow);
    assert.equal(Number(completedRow.clearance_complete), 1);
    assert.equal(completeFromCounts(completedRow), true, 'the SQL projection and JavaScript evidence predicate agree');

    const changedSignature = completionInput(firstTerm, savedFirst.clearanceItems,
      { version: 2, attest: false, signerChange: 'Corrected paper teacher' });
    await assert.rejects(clearance.updateTermClearance(registrarId, firstClearance.clearanceId, changedSignature, studentId), /reason when changing|correction reason/i);
    const reopenInput = { ...changedSignature, idempotencyKey: uuid(), correctionReason: 'Corrected a transcription from the paper form.' };
    const concurrent = await Promise.all([
      clearance.updateTermClearance(registrarId, firstClearance.clearanceId, reopenInput, studentId),
      clearance.getAnnualPrerequisiteReview(registrarId, continuingAnnualId)
    ]);
    assert.equal(concurrent[0].reopened, true, 'same-registrar correction and gate review serialize with actor-first student locking');
    assert.equal(concurrent[0].attested, false, 'a correction to a completed checklist reopens it for a separate inspection and attestation');
    const reopenedReview = await clearance.getAnnualPrerequisiteReview(registrarId, continuingAnnualId);
    assert.equal(reopenedReview.ready, false, 'reopening a completed prerequisite blocks the next annual confirmation');
    assert.equal((await clearance.updateTermClearance(registrarId, firstClearance.clearanceId, reopenInput, studentId)).alreadyRecorded, true,
      'an exact changed-detail retry returns the stored result before checking its old revision');
    await assert.rejects(clearance.updateTermClearance(registrarId, firstClearance.clearanceId,
      { ...reopenInput, items: reopenInput.items.map((item) => item.itemId === String(savedFirst.clearanceItems.find((row) => row.category === 'teacher').id)
        ? { ...item, signerName: 'Altered replay' } : item) }, studentId),
    { status: 409 }, 'reusing an event key with changed details conflicts');
    await assert.rejects(clearance.updateTermClearance(registrarId, firstClearance.clearanceId,
      { ...reopenInput, idempotencyKey: uuid(), expectedVersion: '2' }, studentId), { status: 409 }, 'stale revisions conflict');
    const reopenedData = await clearance.getStudentClearance(registrarId, studentId);
    const reopenTerm = reopenedData.terms.find((term) => Number(term.enrollment_id) === firstTerm.id);
    assert.equal(String(reopenTerm.inspected_on).slice(0, 10), '2026-10-05', 'reopening retains the last inspection date as history');
    const reattest = completionInput(firstTerm, reopenTerm.clearanceItems, { version: 3, inspectedOn: '2026-10-05' });
    await clearance.updateTermClearance(registrarId, firstClearance.clearanceId, reattest, studentId);
    const dateCorrection = completionInput(firstTerm, reopenTerm.clearanceItems, { version: 4, attest: false, inspectedOn: '2026-10-06' });
    await assert.rejects(clearance.updateTermClearance(registrarId, firstClearance.clearanceId, dateCorrection, studentId), /reason when changing|correction reason/i,
      'changing an attested inspection date is an auditable correction');
    const dateCorrectionWithReason = { ...dateCorrection, correctionReason: 'Corrected the recorded inspection date.' };
    const reopenedDate = await clearance.updateTermClearance(registrarId, firstClearance.clearanceId,
      { ...dateCorrectionWithReason, clearanceAction: 'reopen' }, studentId);
    assert.equal(reopenedDate.reopened, true, 'date corrections reopen completed paper before a new confirmation');
    const dateCorrected = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === firstTerm.id);
    assert.equal(dateCorrected.state, 'incomplete');
    assert.equal(String(dateCorrected.inspected_on).slice(0, 10), '2026-10-06');
    await clearance.updateTermClearance(registrarId, firstClearance.clearanceId,
      completionInput(firstTerm, dateCorrected.clearanceItems, { version: 5, inspectedOn: '2026-10-06' }), studentId);

    await setCurrentTerm(pool, sourceTerms[2].id);
    let historicalVersionError;
    try {
      await clearance.createTermClearance(registrarId, sourcePlacements[1].id, { idempotencyKey: uuid(), scopeStatus: 'attended',
        templateId: String(firstTemplate.templateId), ...reconciliation([{ subjectCode: 'HIST', subjectName: 'Historical subject' }]) }, studentId);
    } catch (error) { historicalVersionError = error; }
    assert.ok(historicalVersionError instanceof TermClearanceError, historicalVersionError?.message);
    assert.match(historicalVersionError.message, /older paper form version/i);
    const secondTerm = sourcePlacements[1];
    const secondClearance = await clearance.createTermClearance(registrarId, secondTerm.id, { idempotencyKey: uuid(),
      scopeStatus: 'attended', templateId: String(firstTemplate.templateId),
      templateSelectionReason: 'This version matches the signed historical paper form.',
      ...reconciliation([{ subjectCode: 'HIST', subjectName: 'Historical subject' }]) }, studentId);
    studentClearance = await clearance.getStudentClearance(registrarId, studentId);
    const savedSecond = studentClearance.terms.find((term) => Number(term.enrollment_id) === secondTerm.id);
    assert.equal(savedSecond.clearanceItems.filter((item) => item.category === 'teacher').length, 1);
    await clearance.updateTermClearance(registrarId, secondClearance.clearanceId,
      completionInput(secondTerm, savedSecond.clearanceItems), studentId);
    const secondHistory = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === secondTerm.id).history;
    assert.ok(secondHistory[0].after_json, 'authorized history can inspect the saved paper change record');
    assert.ok(secondHistory[0].changeSummary.some((line) => line.includes('Historical subject')));

    const thirdTerm = sourcePlacements[2];
    const notAttended = await clearance.createTermClearance(registrarId, thirdTerm.id,
      { idempotencyKey: uuid(), scopeStatus: 'not_attended', scopeReason: 'Registrar records show no attendance.' }, studentId);
    const notAttendedDashboard = await clearance.getClearanceDashboard(registrarId,
      { search: '', schoolYear: '', termId: '', status: 'not_attended' });
    assert.ok(notAttendedDashboard.rows.some((row) => Number(row.enrollment_id) === thirdTerm.id),
      'an explicit did-not-attend decision has its own status');
    const convertInput = { idempotencyKey: uuid(), expectedVersion: '1', clearanceAction: 'prepare', scopeStatus: 'attended',
      scopeReason: '', templateId: String(secondTemplate.templateId), correctionReason: 'Paper record confirms attendance.',
      ...reconciliation([{ subjectCode: 'HIST3', subjectName: 'Third term paper subject' }]) };
    const converted = await clearance.updateTermClearance(registrarId, notAttended.clearanceId, convertInput, studentId);
    assert.equal(converted.version, 2, 'not-attended to attended correction creates the approved template and teacher/office checklist rows');
    studentClearance = await clearance.getStudentClearance(registrarId, studentId);
    const savedThird = studentClearance.terms.find((term) => Number(term.enrollment_id) === thirdTerm.id);
    assert.equal(savedThird.clearanceItems.filter((item) => item.category === 'teacher').length, 1);
    await clearance.updateTermClearance(registrarId, notAttended.clearanceId,
      completionInput(thirdTerm, savedThird.clearanceItems, { version: 2 }), studentId);
    const completedThird = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === thirdTerm.id);
    assert.equal(completedThird.state, 'complete');
    const markNotAttended = { ...completionInput(thirdTerm, completedThird.clearanceItems,
      { version: 3, attest: false, action: 'reopen', inspectedOn: '2026-10-05' }),
    scopeStatus: 'not_attended', scopeReason: 'Registrar records confirm no attendance this term.',
    correctionReason: 'Corrected applicability from the school attendance register.' };
    const excludedThird = await clearance.updateTermClearance(registrarId, notAttended.clearanceId, markNotAttended, studentId);
    assert.equal(excludedThird.version, 4, 'marking an inspected term not attended records the reasoned next revision');
    assert.equal(excludedThird.attested, false);
    const excludedThirdRecord = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === thirdTerm.id);
    assert.equal(excludedThirdRecord.state, 'not_attended');
    assert.equal(excludedThirdRecord.inspected_on, null, 'the active inspection date is cleared even when the edit form posts its prior date');
    assert.equal(excludedThirdRecord.attested_at, null);
    const exclusionEvent = excludedThirdRecord.history[0];
    const eventBefore = typeof exclusionEvent.before_json === 'string' ? JSON.parse(exclusionEvent.before_json) : exclusionEvent.before_json;
    const eventAfter = typeof exclusionEvent.after_json === 'string' ? JSON.parse(exclusionEvent.after_json) : exclusionEvent.after_json;
    assert.equal(String(eventBefore.inspectedOn).slice(0, 10), '2026-10-05', 'the prior inspection date remains in the append-only before snapshot');
    assert.equal(eventBefore.attestedBy, registrarId);
    assert.ok(eventBefore.items.some((item) => item.category === 'teacher' && item.signaturePresent && item.signerName),
      'prior paper signer details remain in the append-only before snapshot');
    assert.equal(eventAfter.inspectedOn, null);
    assert.equal(eventAfter.attested, false);
    assert.ok(exclusionEvent.changeSummary.some((line) => /inspection date cleared because.*not attended/i.test(line)));
    assert.equal((await clearance.updateTermClearance(registrarId, notAttended.clearanceId, markNotAttended, studentId)).alreadyRecorded, true,
      'an exact scope-correction retry returns the recorded event despite its now-stale version');
    const afterScopeRetry = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === thirdTerm.id);
    assert.equal(Number(afterScopeRetry.version), 4, 'an exact scope-correction retry does not create another revision');

    review = await clearance.getAnnualPrerequisiteReview(registrarId, continuingAnnualId);
    assert.equal(review.ready, true, 'all three source terms are required once the current year reaches term three');
    await inTransaction(pool, (transaction) => clearance.assertAnnualEntryPrerequisitesInTransaction(transaction,
      { actorId: registrarId, annualId: continuingAnnualId, expectedFingerprint: review.fingerprint }));
    await assert.rejects(inTransaction(pool, (transaction) => clearance.assertAnnualEntryPrerequisitesInTransaction(transaction,
      { actorId: registrarId, annualId: continuingAnnualId, expectedFingerprint: 'a'.repeat(64) })), { status: 409 });

    await setCurrentTerm(pool, targetTerms[0].id);
    const historicalNoReview = await clearance.getClearanceDashboard(registrarId, {
      search: 'STU-CL-DASH-05', schoolYear: '2026-2027', termId: String(sourceTerms[0].id), status: 'all'
    });
    assert.equal(historicalNoReview.counts.notReviewed, 1,
      'a prior historical placement without a clearance row stays not reviewed instead of being treated as complete');
    assert.equal(historicalNoReview.rows[0].clearance_state, 'not_reviewed');
    const completedOverview = await clearance.getStudentClearanceOverview(registrarId, studentId);
    assert.deepEqual(completedOverview, { totalRecords: 6, completed: 2, pending: 1, incomplete: 0, notReviewed: 1,
      notAttended: 1, notApplicable: 2 }, 'summary counts distinguish completed, not attended, no clearance, and future records');
    review = await clearance.getAnnualPrerequisiteReview(registrarId, continuingAnnualId);
    assert.equal(review.ready, true, 'source-term applicability remains valid when the next annual term becomes current');
    let confirmationPreview = await annualFinance.annualAssessmentPreviewForRegistrar(registrarId, continuingAnnualId);
    const confirmationInputFor = (prerequisiteReview, key = uuid()) => ({
      scheduleId: String(confirmationPreview.scheduleId), scheduleVersion: String(confirmationPreview.scheduleVersion),
      voucherCode: confirmationPreview.voucherCode, assessmentId: '', optionalLineIds: [],
      snapshotFingerprint: confirmationPreview.snapshotFingerprint, clearanceSnapshotFingerprint: prerequisiteReview.fingerprint,
      idempotencyKey: key
    });
    let injectedPostAssessmentFailure = false;
    const failingAnnualFinance = Object.create(annualFinance);
    failingAnnualFinance.confirmAnnualAssessmentInTransaction = async (...args) => {
      await annualFinance.confirmAnnualAssessmentInTransaction(...args);
      injectedPostAssessmentFailure = true;
      throw new Error('integration post-assessment rollback probe');
    };
    const rollbackEnrollment = createAnnualEnrollmentService({ getPool: async () => appPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), hashPassword: async (value) => `integration:${value}`,
      createPassword: () => 'integration-only-password', annualFinanceService: failingAnnualFinance, termClearanceService: clearance });
    await assert.rejects(rollbackEnrollment.confirmAnnualEnrollment(registrarId, continuingAnnualId, confirmationInputFor(review)),
      /integration post-assessment rollback probe/);
    assert.equal(injectedPostAssessmentFailure, true, 'the real fee service wrote inside the transaction before the injected failure');
    for (const table of ['annual_assessments', 'annual_registrar_confirmations', 'assessed_charges']) {
      assert.equal(Number((await pool.execute(`SELECT COUNT(*) AS count FROM ${table} WHERE annual_enrollment_id = ?`, [continuingAnnualId]))[0][0].count), 0,
        `a downstream failure rolls back ${table} with the enrollment transaction`);
    }
    assert.equal((await pool.execute('SELECT intake_status FROM annual_enrollments WHERE id = ?', [continuingAnnualId]))[0][0].intake_status,
      'pending', 'rollback leaves the annual intake pending');
    assert.equal((await pool.execute('SELECT enrollment_status FROM enrollments WHERE id = ?', [continuingPlacements[0].id]))[0][0].enrollment_status,
      'pending_payment', 'rollback leaves the entry placement unconfirmed');
    assert.equal(Number((await pool.execute('SELECT is_active FROM users WHERE id = ?', [studentUserId]))[0][0].is_active), 1,
      'rollback does not issue or change student login access');
    const raceInput = confirmationInputFor(review);
    const firstCurrent = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === firstTerm.id);
    const raceCorrection = { ...completionInput(firstTerm, firstCurrent.clearanceItems,
      { version: Number(firstCurrent.version), attest: false, signerChange: 'Registrar race correction' }),
    correctionReason: 'Corrected the paper transcription during confirmation review.' };
    let clearanceGateDiagnostic = null;
    const originalGate = clearance.assertAnnualEntryPrerequisitesInTransaction.bind(clearance);
    clearance.assertAnnualEntryPrerequisitesInTransaction = async (...args) => {
      try { return await originalGate(...args); }
      catch (error) {
        clearanceGateDiagnostic = { name: error?.name, status: error?.status, code: error?.code,
          errno: error?.errno, sqlState: error?.sqlState };
        throw error;
      }
    };
    const raceOutcome = await Promise.allSettled([
      annualEnrollment.confirmAnnualEnrollment(registrarId, continuingAnnualId, raceInput),
      clearance.updateTermClearance(registrarId, firstClearance.clearanceId, raceCorrection, studentId)
    ]);
    assert.equal(raceOutcome[1].status, 'fulfilled', 'same-registrar correction and annual confirmation serialize without deadlock');
    let confirmedAnnual;
    let savedConfirmationInput;
    if (raceOutcome[0].status === 'fulfilled') {
      confirmedAnnual = raceOutcome[0].value;
      savedConfirmationInput = raceInput;
      assert.equal(confirmedAnnual.alreadyConfirmed, false);
      assert.equal(raceOutcome[1].value.reopened, true,
        'a confirmation that wins the shared student lock commits before the later correction reopens paper history');
    } else {
      assert.equal(raceOutcome[0].reason.status, 409,
        `when correction wins, stale confirmation is rejected with a conflict (${raceOutcome[0].reason.message}; gate=${JSON.stringify(clearanceGateDiagnostic)})`);
      assert.equal(raceOutcome[1].value.reopened, true);
      assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_assessments WHERE annual_enrollment_id = ?',
        [continuingAnnualId]))[0][0].count), 0, 'a correction that wins the student lock leaves no assessment behind');
      const reopenedSource = (await clearance.getStudentClearance(registrarId, studentId)).terms
        .find((term) => Number(term.enrollment_id) === firstTerm.id);
      await clearance.updateTermClearance(registrarId, firstClearance.clearanceId,
        completionInput(firstTerm, reopenedSource.clearanceItems,
          { version: Number(reopenedSource.version), inspectedOn: String(reopenedSource.inspected_on).slice(0, 10) }), studentId);
      review = await clearance.getAnnualPrerequisiteReview(registrarId, continuingAnnualId);
      confirmationPreview = await annualFinance.annualAssessmentPreviewForRegistrar(registrarId, continuingAnnualId);
      savedConfirmationInput = confirmationInputFor(review);
      confirmedAnnual = await annualEnrollment.confirmAnnualEnrollment(registrarId, continuingAnnualId, savedConfirmationInput);
    }
    assert.ok(confirmedAnnual.assessmentId);
    assert.equal(confirmedAnnual.alreadyConfirmed, false);
    const targetEntry = continuingPlacements[0];
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_registrar_confirmations WHERE annual_enrollment_id = ?',
      [continuingAnnualId]))[0][0].count), 1, 'a valid annual confirmation and fee assessment commit together');
    assert.equal((await pool.execute('SELECT enrollment_status FROM enrollments WHERE id = ?', [targetEntry.id]))[0][0].enrollment_status,
      'enrolled', 'the first placement is activated only with the saved annual confirmation');

    const postConfirmPaper = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === firstTerm.id);
    if (postConfirmPaper.state === 'complete') {
      await clearance.updateTermClearance(registrarId, firstClearance.clearanceId,
        { ...completionInput(firstTerm, postConfirmPaper.clearanceItems,
          { version: Number(postConfirmPaper.version), attest: false, signerChange: 'Corrected after confirmation' }),
        correctionReason: 'Corrected a paper signer after confirmation.' }, studentId);
    }
    assert.equal((await clearance.getAnnualPrerequisiteReview(registrarId, continuingAnnualId)).ready, false,
      'later paper correction reopens the saved prerequisite but does not undo an already confirmed annual enrollment');
    assert.equal((await annualEnrollment.confirmAnnualEnrollment(registrarId, continuingAnnualId, savedConfirmationInput)).alreadyConfirmed, true,
      'an exact completed annual-confirmation retry returns its saved result after paper clearance reopens');
    await assert.rejects(annualEnrollment.confirmAnnualEnrollment(registrarId, continuingAnnualId,
      { ...savedConfirmationInput, clearanceSnapshotFingerprint: 'a'.repeat(64) }), { status: 409 },
    'the same confirmation token conflicts when its reviewed paper prerequisite fingerprint changes');
    await assert.rejects(annualEnrollment.confirmAnnualEnrollment(registrarId, continuingAnnualId,
      { ...savedConfirmationInput, idempotencyKey: uuid(), clearanceSnapshotFingerprint: undefined }), { status: 409 },
    'a new confirmation cannot omit the paper prerequisite fingerprint');

    const legacyPayload = { annualEnrollmentId: continuingAnnualId, scheduleId: Number(savedConfirmationInput.scheduleId),
      scheduleVersion: Number(savedConfirmationInput.scheduleVersion), voucherCode: savedConfirmationInput.voucherCode,
      expectedAssessmentId: null, optionalLineIds: [], assessmentSnapshotFingerprint: savedConfirmationInput.snapshotFingerprint };
    const legacyFingerprint = crypto.createHash('sha256').update(JSON.stringify(legacyPayload)).digest('hex');
    await pool.execute(`UPDATE annual_registrar_confirmations SET input_fingerprint = NULL,
      clearance_snapshot_fingerprint = NULL, request_fingerprint = ? WHERE idempotency_key = ?`,
    [legacyFingerprint, savedConfirmationInput.idempotencyKey]);
    const legacyReplay = { ...savedConfirmationInput };
    delete legacyReplay.clearanceSnapshotFingerprint;
    assert.equal((await annualEnrollment.confirmAnnualEnrollment(registrarId, continuingAnnualId, legacyReplay)).alreadyConfirmed, true,
      'a simulated v2.016 confirmation row replays its exact old payload after paper clearance reopens');
    await assert.rejects(annualEnrollment.confirmAnnualEnrollment(registrarId, continuingAnnualId,
      { ...legacyReplay, voucherCode: 'ESC' }), { status: 409 }, 'changed legacy replay payload conflicts');

    const targetTemplate = await clearance.createTemplateVersion(registrarId, {
      ...templateInput(uuid(), 1), gradeLevel: 'Grade 12', trackLabel: 'Academic Track'
    });
    const targetFirst = await clearance.createTermClearance(registrarId, targetEntry.id, {
      idempotencyKey: uuid(), scopeStatus: 'attended', templateId: String(targetTemplate.templateId),
      ...reconciliation([{ subjectCode: 'ENG12', subjectName: 'English 12' }])
    }, studentId);
    const targetFirstData = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === targetEntry.id);
    await clearance.updateTermClearance(registrarId, targetFirst.clearanceId,
      completionInput(targetEntry, targetFirstData.clearanceItems), studentId);

    const termTwo = continuingPlacements[1];
    const termThree = continuingPlacements[2];
    const futureTwoReview = await clearance.getTermActivationReview(registrarId, termTwo.id);
    const futureThreeReview = await clearance.getTermActivationReview(registrarId, termThree.id);
    assert.equal(futureTwoReview.ready, false, 'Term 1 cannot activate Term 2 before the configured current period advances');
    assert.equal(futureThreeReview.ready, false, 'Term 1 cannot activate Term 3 just because Term 2 is out of prerequisite scope');
    assert.ok(futureThreeReview.blockers.some((line) => /cannot be activated until its term becomes current/i.test(line)));
    const futureTwoInput = { idempotencyKey: uuid(), clearanceSnapshotFingerprint: futureTwoReview.fingerprint };
    const futureThreeInput = { idempotencyKey: uuid(), clearanceSnapshotFingerprint: futureThreeReview.fingerprint };
    let transientGateCalls = 0;
    let transientTransactions = 0;
    const transientClearance = Object.create(clearance);
    transientClearance.assertTermPrerequisitesInTransaction = async (transaction, args) => {
      transientGateCalls += 1;
      if (transientGateCalls === 1) throw Object.assign(new Error('synthetic retry probe'), { code: 'ER_LOCK_DEADLOCK' });
      return clearance.assertTermPrerequisitesInTransaction(transaction, args);
    };
    const retryingActivation = createAnnualEnrollmentService({ getPool: async () => appPool, sql,
      transactionFactory: (currentPool) => { transientTransactions += 1; return new Transaction(currentPool); },
      hashPassword: async (value) => `integration:${value}`, createPassword: () => 'integration-only-password',
      annualFinanceService: annualFinance, termClearanceService: transientClearance });
    await assert.rejects(retryingActivation.finalizeAnnualTerm(registrarId, termTwo.id, futureTwoInput), (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /future|current/i);
      return true;
    });
    assert.equal(transientGateCalls, 2, 'an activation gate retries its wrapped deadlock in a fresh transaction before returning the future-term conflict');
    assert.equal(transientTransactions, 2, 'the retry creates a fresh enrollment transaction');

    let exhaustedGateCalls = 0;
    let exhaustedTransactions = 0;
    const exhaustedClearance = Object.create(clearance);
    exhaustedClearance.assertTermPrerequisitesInTransaction = async () => {
      exhaustedGateCalls += 1;
      throw Object.assign(new Error('private SQL detail must remain hidden'), { code: 'ER_LOCK_WAIT_TIMEOUT' });
    };
    const exhaustedActivation = createAnnualEnrollmentService({ getPool: async () => appPool, sql,
      transactionFactory: (currentPool) => { exhaustedTransactions += 1; return new Transaction(currentPool); },
      hashPassword: async (value) => `integration:${value}`, createPassword: () => 'integration-only-password',
      annualFinanceService: annualFinance, termClearanceService: exhaustedClearance });
    await assert.rejects(exhaustedActivation.finalizeAnnualTerm(registrarId, termThree.id, futureThreeInput), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.message, 'Paper-clearance prerequisites could not be verified. No enrollment changes were saved.');
      assert.doesNotMatch(error.message, /private SQL detail/);
      return true;
    });
    assert.equal(exhaustedGateCalls, 3, 'a retryable gate timeout is attempted only up to the bounded transaction retry limit');
    assert.equal(exhaustedTransactions, 3);
    await assert.rejects(annualEnrollment.finalizeAnnualTerm(registrarId, termTwo.id, futureTwoInput), { status: 409 });
    await assert.rejects(annualEnrollment.finalizeAnnualTerm(registrarId, termThree.id, futureThreeInput), { status: 409 });
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_term_finalizations'))[0][0].count), 0,
      'future activation attempts create no finalization record');
    assert.deepEqual((await pool.execute('SELECT enrollment_status FROM enrollments WHERE id IN (?, ?) ORDER BY id',
      [termTwo.id, termThree.id]))[0].map((row) => row.enrollment_status), ['pending_payment', 'pending_payment']);

    await setCurrentTerm(pool, targetTerms[1].id);
    const currentTwoReview = await clearance.getTermActivationReview(registrarId, termTwo.id);
    assert.equal(currentTwoReview.ready, true, 'Term 2 becomes activatable once current and prior Term 1 paper clearance is complete');
    const activationInput = { idempotencyKey: uuid(), clearanceSnapshotFingerprint: currentTwoReview.fingerprint };
    const activatedTermTwo = await annualEnrollment.finalizeAnnualTerm(registrarId, termTwo.id, activationInput);
    assert.equal(activatedTermTwo.termNumber, 2);
    assert.equal((await pool.execute('SELECT enrollment_status FROM enrollments WHERE id = ?', [termTwo.id]))[0][0].enrollment_status,
      'enrolled', 'the actual later-term service activates the reviewed current placement');
    const futureThreeAtTwo = await clearance.getTermActivationReview(registrarId, termThree.id);
    assert.equal(futureThreeAtTwo.ready, false, 'Term 2 still cannot activate a future Term 3 placement');
    await assert.rejects(annualEnrollment.finalizeAnnualTerm(registrarId, termThree.id,
      { idempotencyKey: uuid(), clearanceSnapshotFingerprint: futureThreeAtTwo.fingerprint }), { status: 409 });

    const targetFirstAfterActivation = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === targetEntry.id);
    await clearance.updateTermClearance(registrarId, targetFirst.clearanceId,
      { ...completionInput(targetEntry, targetFirstAfterActivation.clearanceItems,
        { version: Number(targetFirstAfterActivation.version), attest: false, signerChange: 'Post-activation paper correction' }),
      correctionReason: 'Corrected the paper signature after later-term activation.' }, studentId);
    const replayedActivation = await annualEnrollment.finalizeAnnualTerm(registrarId, termTwo.id, activationInput);
    assert.equal(replayedActivation.alreadyFinalized, true,
      'an exact completed term-activation retry returns the saved result after a paper prerequisite is reopened');
    await assert.rejects(annualEnrollment.finalizeAnnualTerm(registrarId, termTwo.id,
      { ...activationInput, clearanceSnapshotFingerprint: 'a'.repeat(64) }), { status: 409 },
    'the same term-activation token conflicts if the prerequisite review changes');

    const newStudentUser = await insertUser(pool, 'student');
    const newStudentId = await insertStudent(pool, registrarId, newStudentUser, { studentNo: 'STU-CL-2', lrn: '000000000102', firstName: 'Bea' });
    const newAnnualId = await createAnnual(pool, { studentId: newStudentId, registrarId, schoolYear: '2027-2028',
      gradeLevel: 'Grade 11', intakeKind: 'new', status: 'pending' });
    const newPlacements = await createPlacements(pool, { studentId: newStudentId, annualId: newAnnualId, terms: targetTerms });
    const exemption = await clearance.getAnnualPrerequisiteReview(registrarId, newAnnualId);
    assert.equal(exemption.ready, true);
    assert.equal(exemption.intakeKind, 'new');
    await assert.rejects(inTransaction(pool, (transaction) => clearance.assertTermPrerequisitesInTransaction(transaction,
      { actorId: registrarId, enrollmentId: newPlacements[1].id })), { status: 409 },
    'new-student first admission is exempt, but moving to term two still requires earlier attended term clearance');

    const readmitUser = await insertUser(pool, 'student');
    const readmitStudent = await insertStudent(pool, registrarId, readmitUser, { studentNo: 'STU-CL-3', lrn: '000000000103', firstName: 'Cam' });
    const readmitAnnualId = await createAnnual(pool, { studentId: readmitStudent, registrarId, schoolYear: '2027-2028',
      gradeLevel: 'Grade 11', intakeKind: 'readmission', status: 'pending' });
    const readmitPlacements = await createPlacements(pool, { studentId: readmitStudent, annualId: readmitAnnualId, terms: targetTerms });
    assert.equal((await clearance.getAnnualPrerequisiteReview(registrarId, readmitAnnualId)).ready, true,
      'accepted readmission classification is exempt from the first internal gate');
    assert.equal((await clearance.getTermActivationReview(registrarId, readmitPlacements[1].id)).ready, false,
      'a later readmission term is still gated on earlier clearance in that same annual enrollment');

    assert.equal((await clearance.getOwnStudentProgress(studentUserId)).terms.length, 6,
      'student progress includes each term in the linked student’s two annual records');
    const readmissionProgress = await clearance.getOwnStudentProgress(readmitUser);
    assert.equal(readmissionProgress.terms.length, 3, 'a student sees progress for their own linked record');
    assert.ok(readmissionProgress.terms.every((term) => !Object.keys(term).some((key) => /reason|history|signer|scope/i.test(key))),
      'student progress omits staff reasons, signer details, and revision history');
    assert.deepEqual(await clearance.getOwnStudentProgress(teacherId), { terms: [] },
      'an account without a linked student record receives no student progress');
    await assert.rejects(clearance.getStudentClearance(teacherId, studentId), { status: 403 });
    await assert.rejects(clearance.createTemplateVersion(adminId, templateInput(uuid())), { status: 403 });
    assert.ok((await clearance.getStudentClearance(adminId, studentId)).terms.length >= 3,
      'database administrators may inspect paper history without changing it');
    const [independentFinance] = await pool.execute('SELECT COUNT(*) AS count FROM term_clearance_events');
    const [paperChecklist] = await pool.execute('SELECT COUNT(*) AS count FROM student_physical_checklist_events');
    assert.equal(Number(independentFinance[0].count), 0, 'paper term signoffs never write finance clearance events');
    assert.equal(Number(paperChecklist[0].count), 0, 'paper term signoffs never write physical document checklist events');

    const beforeLegacyExclusion = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === firstTerm.id);
    const legacyInspectionDate = String(beforeLegacyExclusion.inspected_on).slice(0, 10);
    assert.equal(beforeLegacyExclusion.state, 'incomplete');
    assert.match(legacyInspectionDate, /^2026-10-\d{2}$/,
      'an unfinished historical record retains its earlier paper inspection date');
    const excludeLegacy = { ...completionInput(firstTerm, beforeLegacyExclusion.clearanceItems,
      { version: Number(beforeLegacyExclusion.version), attest: false, action: 'prepare',
        correctionReason: 'Attendance records show the entire term was not attended.', inspectedOn: '' }),
    scopeStatus: 'not_attended', scopeReason: 'Attendance records show no attendance for the entire term.' };
    const legacyExclusion = await clearance.updateTermClearance(registrarId, firstClearance.clearanceId, excludeLegacy, studentId);
    assert.equal(legacyExclusion.attested, false);
    const excludedLegacy = (await clearance.getStudentClearance(registrarId, studentId)).terms
      .find((term) => Number(term.enrollment_id) === firstTerm.id);
    assert.equal(excludedLegacy.state, 'not_attended', 'an unfinished record with inspection history can be excluded using a reasoned attendance decision');
    assert.equal(excludedLegacy.inspected_on, null, 'the active inspection date clears on the not-attended scope change');
    const legacyExclusionBefore = typeof excludedLegacy.history[0].before_json === 'string'
      ? JSON.parse(excludedLegacy.history[0].before_json) : excludedLegacy.history[0].before_json;
    assert.equal(String(legacyExclusionBefore.inspectedOn).slice(0, 10), legacyInspectionDate,
      'the prior inspection date remains in append-only history after the exclusion');
  } finally {
    if (pool) await pool.end();
    for (const name of [freshName, upgradeName]) {
      try { await admin.query(`DROP DATABASE IF EXISTS ${databaseQuote(name)}`); } catch { /* retain the original test failure */ }
    }
    await admin.end();
  }
});
