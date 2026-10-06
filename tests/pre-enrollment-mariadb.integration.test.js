'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const express = require('express');
const { PoolFacade, Transaction, sql } = require('../src/config/database');
const { createPreEnrollmentService } = require('../src/services/preEnrollmentService');
const { createReadmissionService } = require('../src/services/readmissionService');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');
const { createTermClearanceService } = require('../src/services/termClearanceService');
const { createAcademicRecordsService } = require('../src/services/academicRecordsService');
const { RegistrarGradeOverviewError, createRegistrarGradeOverviewService } = require('../src/services/registrarGradeOverviewService');
const { createStudentRecordsRouter } = require('../src/routes/studentRecords');
const { requireRole } = require('../src/middleware/roles');
const { buildNavigation } = require('../src/middleware/navigation');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');

const socketPath = process.env.PRE_ENROLLMENT_MARIADB_TEST_SOCKET;
const ROOT = path.resolve(__dirname, '..');

function uuid() { return crypto.randomUUID(); }
function quoteDatabase(value) { return `\`${value.replaceAll('`', '``')}\``; }

function databaseSocketAllowed(socket) {
  if (!path.isAbsolute(socket)) return false;
  const localSocket = path.resolve(os.homedir(), '.local/share/arktiesiis/local-mariadb/mariadb.sock');
  return path.resolve(socket) === localSocket || path.resolve(socket).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`);
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function createSchema(connection, databaseName, through = 'v2.016') {
  await connection.query(`CREATE DATABASE ${quoteDatabase(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.query(`USE ${quoteDatabase(databaseName)}`);
  const baseline = readSqlFile(path.resolve(ROOT, 'database/mariadb/schema.sql'));
  await applyStatements(connection, baseline);
  for (const migration of readForwardMigrations()) {
    if (migration.version > through) break;
    await applyStatements(connection, migration.statements);
    // Query (not a cached prepared statement) follows the current USE target between the disposable schemas.
    await connection.query('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
  }
}

async function createUsers(pool) {
  const token = uuid();
  const users = {};
  for (const [role, first, last] of [
    ['registrar', 'Regina', 'Registrar'], ['front_desk', 'Frank', 'Frontdesk'],
    ['database_admin', 'Dana', 'Admin'], ['teacher', 'Terry', 'Teacher'],
    ['finance', 'Faye', 'Finance'], ['student', '', '']
  ]) {
    const email = `${role}-${token}@integration.invalid`;
    const [result] = await pool.execute('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
      [email, 'integration-only-not-a-login-hash', role]);
    users[role] = Number(result.insertId);
    if (role !== 'teacher' && role !== 'student') await pool.execute('INSERT INTO staff_profiles (user_id, first_name, last_name) VALUES (?, ?, ?)',
      [users[role], first, last]);
  }
  return users;
}

function readyPaper(idempotencyKey, overrides = {}) {
  return {
    idempotencyKey, schoolYear: '2027-2028', firstName: 'Ari', middleName: 'Mae', lastName: 'Santos', suffix: '',
    lrn: '012345678901', email: 'ari-santos@integration.invalid', studentContactNumber: '09171234567', voucherTypeText: 'ESC', voucherCategoryText: 'CATEGORY A',
    preferredTrack: 'Academic Track', preferredCluster: 'ASSH (Arts, Social Science, and Humanities)',
    targetGradeLevel: 'Grade 11', priorGradeLevel: 'Grade 10', priorSchool: 'Lucena High School',
    studentSignaturePresent: '1', studentSignedDate: '2026-10-01', receivedBy: 'spoofed receiver',
    receipt_report_card_photocopy: '1', receipt_report_card_photocopy_pieces: '1',
    status: 'ready_for_registrar', ...overrides
  };
}

function annualInput(sourceId, sourceVersion, sectionId, overrides = {}) {
  return {
    preEnrollmentId: sourceId, preEnrollmentVersion: sourceVersion, idempotencyKey: sourceId,
    studentNo: '', email: 'ari-santos@integration.invalid', lrn: '012345678901',
    firstName: 'Ari', middleName: 'Mae', lastName: 'Santos', suffix: '', birthDate: '2008-04-21', sex: 'Female',
    phone: '09171234567', schoolYear: '2027-2028', gradeLevel: 'Grade 11', voucherCode: 'ESC',
    entryTermNumber: '1', enrollmentStartDate: '2026-10-03', sectionMode: 'same', annualSectionId: String(sectionId),
    addressMode: 'replace', addressBlockLotStreetPurok: 'Block 2, Purok 1', addressBarangay: 'Ibabang Iyam',
    addressCity: 'Lucena', addressProvince: 'Quezon', addressZip: '0123',
    ...overrides
  };
}

function readmissionInput(applicantLrn, overrides = {}) {
  return {
    applicantLrn, firstName: 'Ari', middleName: 'Mae', lastName: 'Santos', suffix: '',
    schoolYear: '2027-2028', targetGradeLevel: 'Grade 11',
    priorProgress: 'Completed part of Grade 11 before leaving school.',
    evidenceReviewed: 'Reviewed school records and the applicant-provided report card.', form137Supporting: '1',
    curriculumComparison: 'Compared completed subjects with the current curriculum by registrar review.',
    curriculumReviewStatus: 'resolved',
    requiredSubjects: 'Complete the listed Grade 11 subjects before placement.',
    subjectAvailability: 'available', availabilityNotes: 'Required subjects are offered this school year.',
    decisionReason: 'Human review completed.', ...overrides
  };
}

async function queryOne(pool, sqlText, parameters = []) {
  const [rows] = await pool.execute(sqlText, parameters);
  return rows[0] || null;
}

async function insertHistoricalUnlinkedEvaluation(pool, actorId, input) {
  const id = uuid();
  await pool.execute(`INSERT INTO readmission_evaluations
    (id, applicant_lrn, student_id, first_name, middle_name, last_name, suffix, school_year, target_grade_level,
      prior_progress, evidence_reviewed, form137_supporting, curriculum_comparison, curriculum_review_status,
      required_subjects, subject_availability, availability_notes, decision_reason, status, version, created_by, updated_by)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'under_review', 1, ?, ?)`,
  [id, input.applicantLrn, input.firstName, input.middleName, input.lastName, input.suffix, input.schoolYear,
    input.targetGradeLevel, input.priorProgress, input.evidenceReviewed, input.form137Supporting ? 1 : 0,
    input.curriculumComparison, input.curriculumReviewStatus || 'unresolved', input.requiredSubjects,
    input.subjectAvailability || 'unresolved', input.availabilityNotes, input.decisionReason, actorId, actorId]);
  await pool.execute(`INSERT INTO readmission_evaluation_events
    (evaluation_id, evaluation_version, actor_id, event_type, from_status, to_status, details_json)
    VALUES (?, 1, ?, 'created', NULL, 'under_review', ?)`,
  [id, actorId, JSON.stringify({
    changedFields: ['applicantLrn', 'firstName', 'middleName', 'lastName', 'schoolYear', 'targetGradeLevel', 'priorProgress', 'evidenceReviewed'],
    after: { ...input, status: 'under_review', studentId: null }
  })]);
  return { id, version: 1, status: 'under_review' };
}

test('pre-enrollment migration recovery, role-gated receipts, annual conversion, and MariaDB grade overview', {
  skip: !socketPath && 'Set PRE_ENROLLMENT_MARIADB_TEST_SOCKET to a disposable local MariaDB socket.',
  timeout: 180000
}, async () => {
  assert.equal(databaseSocketAllowed(socketPath), true,
    'integration must use the user-private local MariaDB socket or a disposable socket under /tmp');
  const admin = await mysql.createConnection({ socketPath, user: os.userInfo().username, multipleStatements: false });
  const suffix = crypto.randomBytes(6).toString('hex');
  const upgradeName = `arktiesiis_pre_enroll_upgrade_${suffix}`;
  const freshName = `arktiesiis_pre_enroll_fresh_${suffix}`;
  let rawPool;
  let app;
  let server;
  try {
    // Upgrade recovery: the unexpected CHECK must fail before any address DDL, then a renamed table CHECK is migrated.
    await createSchema(admin, upgradeName, 'v2.014');
    await admin.query('ALTER TABLE users MODIFY COLUMN role VARCHAR(30) NOT NULL');
    await admin.query("ALTER TABLE users ADD CONSTRAINT CK_users_role_drift CHECK (role <> 'teacher')");
    const migration015 = readForwardMigrations().find(({ version }) => version === 'v2.015');
    await assert.rejects(applyStatements(admin, migration015.statements));
    const [partialAddressColumns] = await admin.execute(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'students' AND column_name LIKE 'address_%'`, [upgradeName]);
    assert.deepEqual(partialAddressColumns, [], 'unexpected role metadata must fail before additive address DDL');
    const versionBeforeRecovery = await queryOne(admin, 'SELECT MAX(version) AS version FROM schema_migrations WHERE version LIKE \'v2.%\'');
    assert.equal(versionBeforeRecovery.version, 'v2.014');
    await admin.query(`ALTER TABLE users DROP CONSTRAINT CK_users_role_drift,
      ADD CONSTRAINT CK_users_role_renamed CHECK (role IN ('database_admin','registrar','teacher','finance','student')),
      ADD CONSTRAINT CK_users_unrelated CHECK (CHAR_LENGTH(email) > 0)`);
    await applyStatements(admin, migration015.statements);
    await admin.query('INSERT INTO schema_migrations (version) VALUES (?)', ['v2.015']);
    const [roleCheck] = await admin.execute(`SELECT constraints.constraint_name, checks.level FROM information_schema.table_constraints AS constraints
      INNER JOIN information_schema.check_constraints AS checks ON checks.constraint_schema = constraints.constraint_schema
        AND checks.table_name = constraints.table_name AND checks.constraint_name = constraints.constraint_name
      WHERE constraints.constraint_schema = ? AND constraints.table_name = 'users' AND constraints.constraint_name = 'CK_users_role'`, [upgradeName]);
    assert.equal(roleCheck[0]?.level, 'Table');
    const [unrelated] = await admin.execute(`SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_schema = ? AND table_name = 'users' AND constraint_name = 'CK_users_unrelated'`, [upgradeName]);
    assert.equal(unrelated.length, 1, 'role CHECK replacement must preserve unrelated constraints');
    const [upgradeVersion] = await admin.execute('SELECT version FROM schema_migrations WHERE version = ?', ['v2.015']);
    assert.equal(upgradeVersion.length, 1);

    const migration016 = readForwardMigrations().find(({ version }) => version === 'v2.016');
    await applyStatements(admin, migration016.statements);
    await admin.query('INSERT INTO schema_migrations (version) VALUES (?)', ['v2.016']);
    const [upgrade016] = await admin.execute('SELECT version FROM schema_migrations WHERE version = ?', ['v2.016']);
    assert.equal(upgrade016.length, 1, 'v2.015 upgrade applies the forward-only profile/readmission migration');
    const migration017 = readForwardMigrations().find(({ version }) => version === 'v2.017');
    await applyStatements(admin, migration017.statements);
    await admin.query('INSERT INTO schema_migrations (version) VALUES (?)', ['v2.017']);
    const [upgrade017] = await admin.execute('SELECT version FROM schema_migrations WHERE version = ?', ['v2.017']);
    assert.equal(upgrade017.length, 1, 'the upgrade path applies the forward-only paper-clearance migration');

    // Fresh database exercises the inline column-level baseline CHECK replacement path.
    await createSchema(admin, freshName, 'v2.015');
    const [freshVersion] = await admin.execute(`SELECT version FROM ${quoteDatabase(freshName)}.schema_migrations WHERE version = 'v2.015'`);
    assert.equal(freshVersion.length, 1);
    const [freshRole] = await admin.execute(`SELECT checks.level FROM information_schema.check_constraints AS checks
      WHERE checks.constraint_schema = ? AND checks.constraint_name = 'CK_users_role'`, [freshName]);
    assert.equal(freshRole[0]?.level, 'Table', 'fresh migration replaces the inline baseline check with the named expanded table check');
    await admin.query(`USE ${quoteDatabase(freshName)}`);
    await applyStatements(admin, migration016.statements);
    await admin.query('INSERT INTO schema_migrations (version) VALUES (?)', ['v2.016']);
    const [fresh016] = await admin.execute('SELECT version FROM schema_migrations WHERE version = ?', ['v2.016']);
    assert.equal(fresh016.length, 1, 'fresh setup applies migration v2.016 after v2.015');
    await applyStatements(admin, migration017.statements);
    await admin.query('INSERT INTO schema_migrations (version) VALUES (?)', ['v2.017']);
    const [fresh017] = await admin.execute('SELECT version FROM schema_migrations WHERE version = ?', ['v2.017']);
    assert.equal(fresh017.length, 1, 'fresh setup applies migration v2.017 after v2.016');
    await admin.query(`USE ${quoteDatabase(upgradeName)}`);

    rawPool = mysql.createPool({ socketPath, user: os.userInfo().username, database: upgradeName,
      waitForConnections: true, connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: true,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false });
    const pool = new PoolFacade(rawPool);
    const users = await createUsers(rawPool);
    const termClearanceService = createTermClearanceService({ getPool: async () => pool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool) });
    const preEnrollments = createPreEnrollmentService({ getPool: async () => pool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool) });
    const baselineSideEffects = await queryOne(rawPool, `SELECT
      (SELECT COUNT(*) FROM students) AS students, (SELECT COUNT(*) FROM annual_enrollments) AS annuals,
      (SELECT COUNT(*) FROM enrollments) AS enrollments, (SELECT COUNT(*) FROM student_physical_checklist_events) AS physical_events`);

    // Idempotent paper receipt creation uses normalized submitted values before server defaults; admin can read only.
    const draftKey = uuid();
    const draftInput = { idempotencyKey: draftKey, schoolYear: '2027-2028', lrn: '1234', status: 'draft', actorName: 'client spoof' };
    const draft = await preEnrollments.create(users.front_desk, draftInput);
    assert.equal((await preEnrollments.create(users.front_desk, draftInput)).alreadyCreated, true);
    assert.equal((await preEnrollments.get(users.database_admin, draft.id)).received_by, 'Frank Frontdesk');
    const longStaffFirstName = 'A'.repeat(100);
    await rawPool.execute('UPDATE staff_profiles SET first_name = ?, last_name = ? WHERE user_id = ?',
      [longStaffFirstName, 'B'.repeat(100), users.front_desk]);
    const boundedReceiver = await preEnrollments.create(users.front_desk, {
      idempotencyKey: uuid(), schoolYear: '2028-2029', status: 'draft'
    });
    const boundedReceiverDetail = await preEnrollments.get(users.registrar, boundedReceiver.id);
    assert.equal(boundedReceiverDetail.received_by, longStaffFirstName,
      'authenticated default receiver is bounded to the received_by VARCHAR(100) limit');
    const secondPartial = await preEnrollments.create(users.front_desk, { ...draftInput, idempotencyKey: uuid() });
    assert.notEqual(secondPartial.id, draft.id, 'partial LRNs remain draftable without uniqueness collisions');
    await assert.rejects(preEnrollments.create(users.database_admin, { ...draftInput, idempotencyKey: uuid() }), { status: 403 });
    await assert.rejects(preEnrollments.update(users.database_admin, draft.id, 1, draftInput), { status: 403 });
    assert.equal((await preEnrollments.list(users.database_admin, { search: '1234' })).pagination.totalRecords, 2);
    const [inactiveFrontDesk] = await rawPool.execute(`INSERT INTO users (email, password_hash, role, is_active)
      VALUES ('inactive-front-desk@integration.invalid', 'integration-only-not-a-login-hash', 'front_desk', 0)`);
    const forbiddenActors = [users.teacher, users.finance, users.student, Number(inactiveFrontDesk.insertId)];
    for (const forbiddenActor of forbiddenActors) {
      await assert.rejects(preEnrollments.get(forbiddenActor, draft.id), { status: 403 });
      await assert.rejects(preEnrollments.list(forbiddenActor), { status: 403 });
      await assert.rejects(preEnrollments.create(forbiddenActor, { ...draftInput, idempotencyKey: uuid() }), { status: 403 });
      await assert.rejects(preEnrollments.update(forbiddenActor, draft.id, 1, draftInput), { status: 403 });
    }
    const receiptSource = await preEnrollments.create(users.front_desk, readyPaper(uuid()));
    const receiptDetail = await preEnrollments.get(users.registrar, receiptSource.id);
    assert.equal(receiptDetail.receipts.length, 9);
    assert.equal(receiptDetail.receipts.find((row) => row.requirement_code === 'report_card').photocopy_pieces, 1);
    assert.equal(Number((await queryOne(rawPool, 'SELECT COUNT(*) AS count FROM student_physical_checklist_events')).count), 0,
      'pre-enrollment receipt-only entries must not create physical checklist verification events');
    await assert.rejects(preEnrollments.create(users.front_desk,
      readyPaper(uuid(), { lrn: '012345678901' })), { status: 409 }, 'complete LRN and school-year duplicates are rejected');

    // Ready records support explicit correction and optimistic conflict handling before conversion.
    const stale = await preEnrollments.create(users.front_desk, readyPaper(uuid(), { lrn: '012345678902' }));
    const staleInput = readyPaper(uuid(), { lrn: '012345678902', status: 'draft' });
    const staleLatest = await preEnrollments.get(users.front_desk, stale.id);
    const demoted = await preEnrollments.update(users.front_desk, stale.id, staleLatest.version, staleInput);
    assert.equal(demoted.status, 'draft', 'ready to draft is an explicit permitted correction');
    await assert.rejects(preEnrollments.update(users.front_desk, stale.id, 1,
      readyPaper(uuid(), { lrn: '012345678902' })), { status: 409 }, 'stale versions conflict');
    await assert.rejects(preEnrollments.openConversion(users.front_desk, stale.id), { status: 403 });

    const year = '2027-2028';
    const terms = [];
    for (const [index, termName] of ['Term 1', 'Term 2', 'Term 3'].entries()) {
      const [result] = await rawPool.execute('INSERT INTO academic_terms (school_year, term, is_current) VALUES (?, ?, ?)',
        [year, termName, index === 0 ? 1 : 0]);
      terms.push(Number(result.insertId));
      await rawPool.execute('INSERT INTO school_year_term_order (school_year, term_number, academic_term_id, configured_by) VALUES (?, ?, ?, ?)',
        [year, index + 1, terms[index], users.registrar]);
    }
    const sections = [];
    for (let index = 0; index < 3; index += 1) {
      const [result] = await rawPool.execute(`INSERT INTO sections
        (name, grade_level, academic_term_id, cluster, strand, adviser, modality)
        VALUES ('Mabini', 'Grade 11', ?, 'ASSH', 'Academic', 'Synthetic Adviser', 'face-to-face')`, [terms[index]]);
      sections.push(Number(result.insertId));
    }
    const [emptySectionResult] = await rawPool.execute(`INSERT INTO sections
      (name, grade_level, academic_term_id, cluster, strand) VALUES ('Empty', 'Grade 11', ?, 'ASSH', 'Academic')`, [terms[0]]);
    const emptySection = Number(emptySectionResult.insertId);

    const convertInput = async (sourceId, sourceVersion, overrides = {}) => {
      const input = annualInput(sourceId, sourceVersion, sections[0], overrides);
      const source = await preEnrollments.getForConversion(users.registrar, sourceId);
      if (!Object.hasOwn(overrides, 'lrn')) input.lrn = source.lrn;
      if (input.studentNo) {
        input.studentReviewFingerprint = source.existingStudent?.profileReviewFingerprint || '';
      }
      return input;
    };
    const conversionSource = receiptSource;
    const readyVersion = (await preEnrollments.get(users.registrar, conversionSource.id)).version;
    const sourceConversion = await convertInput(conversionSource.id, readyVersion, { intakeKind: 'transferee' });
    await assert.rejects(createAnnualEnrollmentService({ getPool: async () => pool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), hashPassword: async () => 'integration-only-hash',
      createPassword: () => 'integration-only-password', termClearanceService }).createAnnualIntake(users.front_desk, sourceConversion), { status: 403 },
    'front desk cannot directly invoke annual conversion, even with a valid guessed source id');
    const annualService = createAnnualEnrollmentService({ getPool: async () => pool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), hashPassword: async () => 'integration-only-hash',
      createPassword: () => 'integration-only-password', termClearanceService });
    await assert.rejects(annualService.createAnnualIntake(users.database_admin, sourceConversion), { status: 403 });
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      { ...sourceConversion, preEnrollmentVersion: readyVersion + 1 }), { status: 409 }, 'a stale source version is rejected');
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      { ...sourceConversion, lrn: '012345678999' }), { status: 409 }, 'a new profile LRN cannot replace the source LRN');
    const beforeConversion = await queryOne(rawPool, `SELECT
      (SELECT COUNT(*) FROM students) AS students, (SELECT COUNT(*) FROM annual_enrollments) AS annuals,
      (SELECT COUNT(*) FROM enrollments) AS enrollments`);
    assert.deepEqual(Object.values(beforeConversion).map(Number), [Number(baselineSideEffects.students), 0, 0],
      'saving a paper receipt never allocates student or enrollment rows');
    // Use separate registrar accounts so neither transaction serializes on its actor row.
    const [secondRegistrar] = await rawPool.execute(`INSERT INTO users (email, password_hash, role)
      VALUES (?, 'integration-only-not-a-login-hash', 'registrar')`, [`registrar-second-${uuid()}@integration.invalid`]);
    const secondRegistrarId = Number(secondRegistrar.insertId);
    await rawPool.execute('INSERT INTO staff_profiles (user_id, first_name, last_name) VALUES (?, ?, ?)',
      [secondRegistrarId, 'Rita', 'Registrar']);
    let releaseSourceLockBarrier;
    let resolveBothAtSourceLock;
    let sourceLockArrivals = 0;
    const sourceLockBarrier = new Promise((resolve) => { releaseSourceLockBarrier = resolve; });
    const bothAtSourceLock = new Promise((resolve) => { resolveBothAtSourceLock = resolve; });
    const barrierTransactionFactory = (currentPool) => {
      const transaction = new Transaction(currentPool);
      const request = transaction.request.bind(transaction);
      transaction.request = () => {
        const transactionRequest = request();
        const query = transactionRequest.query.bind(transactionRequest);
        transactionRequest.query = async (statement) => {
          if (/FROM pre_enrollments(?:\s+AS source)?\s+WHERE (?:source\.)?id = @preEnrollmentId FOR UPDATE/.test(statement) && sourceLockArrivals < 2) {
            sourceLockArrivals += 1;
            if (sourceLockArrivals === 2) resolveBothAtSourceLock();
            await sourceLockBarrier;
            return query(statement);
          }
          return query(statement);
        };
        return transactionRequest;
      };
      return transaction;
    };
    const barrierAnnualService = createAnnualEnrollmentService({ getPool: async () => pool, sql,
      transactionFactory: barrierTransactionFactory, hashPassword: async () => 'integration-only-hash',
      createPassword: () => 'integration-only-password', termClearanceService });
    let conversionPromise;
    let sourceLockTimeout;
    try {
      conversionPromise = Promise.all([
        barrierAnnualService.createAnnualIntake(users.registrar, sourceConversion),
        barrierAnnualService.createAnnualIntake(secondRegistrarId, sourceConversion)
      ]);
      await Promise.race([
        bothAtSourceLock,
        new Promise((_, reject) => { sourceLockTimeout = setTimeout(() => reject(new Error('Both registrar transactions did not reach the source-row lock barrier.')), 8000); })
      ]);
      assert.equal(sourceLockArrivals, 2, 'both independent registrar transactions reached the same source-row lock');
    } finally {
      clearTimeout(sourceLockTimeout);
      releaseSourceLockBarrier();
    }
    const conversions = await conversionPromise;
    assert.equal(conversions[0].annualEnrollmentId, conversions[1].annualEnrollmentId,
      'concurrent conversion attempts return the same annual enrollment');
    const annualId = conversions[0].annualEnrollmentId;
    const replay = await annualService.createAnnualIntake(users.registrar, sourceConversion);
    assert.equal(replay.annualEnrollmentId, annualId);
    assert.equal(replay.alreadyCreated, true, 'lost-response retry returns the committed annual enrollment');
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      { ...sourceConversion, enrollmentStartDate: '2026-10-04' }), { status: 409 }, 'changed placement details conflict on replay');
    const sourceOwnedProfileReplay = await annualService.createAnnualIntake(users.registrar,
      { ...sourceConversion, addressBlockLotStreetPurok: 'Forged posted address' });
    assert.equal(sourceOwnedProfileReplay.alreadyCreated, true, 'posted profile fields cannot change the saved paper source fingerprint');
    const persistedNewKind = await queryOne(rawPool,
      'SELECT intake_kind FROM annual_enrollments WHERE id = ?', [annualId]);
    assert.equal(persistedNewKind.intake_kind, 'new', 'client-selected transferee is replaced by server-derived source classification');
    const createdAudit = await queryOne(rawPool,
      `SELECT details_json FROM audit_logs WHERE action = 'registrar.annual_enrollment_created' AND entity_id = ?`, [String(annualId)]);
    assert.equal(JSON.parse(createdAudit.details_json).intakeKind, 'new', 'audit records the same authoritative intake kind as annual enrollment');
    const persistedProfile = await queryOne(rawPool,
      'SELECT address, address_block_lot_street_purok FROM students WHERE id = ?', [conversions[0].studentId]);
    assert.deepEqual(persistedProfile, { address: null, address_block_lot_street_purok: null },
      'posted profile components cannot replace the saved front-desk profile');
    const afterConversion = await queryOne(rawPool, `SELECT
      (SELECT COUNT(*) FROM students) AS students, (SELECT COUNT(*) FROM annual_enrollments) AS annuals,
      (SELECT COUNT(*) FROM enrollments) AS enrollments`);
    assert.deepEqual(Object.values(afterConversion).map(Number), [Number(beforeConversion.students) + 1, 1, 3]);
    const sourceAfter = await preEnrollments.get(users.front_desk, conversionSource.id);
    assert.equal(sourceAfter.status, 'enrollment_started');
    assert.equal(Number(sourceAfter.version), Number(readyVersion) + 1);
    assert.equal(Number((await queryOne(rawPool, 'SELECT COUNT(*) AS count FROM student_physical_checklist_events')).count), 0,
      'paper receipt rows do not become physical verification events during conversion');
    await assert.rejects(preEnrollments.update(users.front_desk, conversionSource.id, sourceAfter.version,
      readyPaper(uuid())), { status: 409 }, 'enrollment-started records are read-only');

    // The source version remains editable while a wizard is open; an old wizard receives 409 after an edit.
    const staleSource = await preEnrollments.create(users.front_desk, readyPaper(uuid(), { lrn: '012345678904' }));
    const changed = await preEnrollments.update(users.registrar, staleSource.id, 1,
      readyPaper(uuid(), { lrn: '012345678904', priorSchool: 'Corrected High School' }));
    assert.equal(changed.version, 2);
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      await convertInput(staleSource.id, 1, { email: 'stale@integration.invalid' })), { status: 409 });

    // A deliberate downstream failure proves the complete transaction rolls back user, student, annual, and source writes.
    const rollbackSource = await preEnrollments.create(users.front_desk, readyPaper(uuid(), {
      lrn: '012345678905', email: 'rollback@integration.invalid'
    }));
    const rollbackInput = await convertInput(rollbackSource.id, 1, {
      email: 'rollback@integration.invalid', lrn: '012345678905',
      paper_report_card_record: '1', paper_report_card_status: 'received', paper_report_card_applicable: '1',
      paper_report_card_token: uuid()
    });
    const failingAnnualService = createAnnualEnrollmentService({ getPool: async () => pool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), hashPassword: async () => 'integration-only-hash',
      createPassword: () => 'integration-only-password',
      physicalChecklistService: { recordIntakeUpdatesInTransaction() { throw new Error('intentional rollback probe'); } }, termClearanceService
    });
    const rollbackBefore = await queryOne(rawPool, `SELECT
      (SELECT COUNT(*) FROM users WHERE email = 'rollback@integration.invalid') AS users,
      (SELECT COUNT(*) FROM students WHERE lrn = '012345678905') AS students,
      (SELECT COUNT(*) FROM annual_enrollments WHERE pre_enrollment_id = ?) AS annuals`, [rollbackSource.id]);
    await assert.rejects(failingAnnualService.createAnnualIntake(users.registrar, rollbackInput), /intentional rollback probe/);
    const rollbackAfter = await queryOne(rawPool, `SELECT
      (SELECT COUNT(*) FROM users WHERE email = 'rollback@integration.invalid') AS users,
      (SELECT COUNT(*) FROM students WHERE lrn = '012345678905') AS students,
      (SELECT COUNT(*) FROM annual_enrollments WHERE pre_enrollment_id = ?) AS annuals`, [rollbackSource.id]);
    assert.deepEqual(Object.values(rollbackAfter).map(Number), Object.values(rollbackBefore).map(Number));
    assert.equal((await preEnrollments.get(users.registrar, rollbackSource.id)).status, 'ready_for_registrar');

    // Returning student selection links the paper source without overwriting the existing profile.
    const returningLrn = '012345678906';
    const [existingStudent] = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name, address)
      VALUES ('RETURNING-TEST', ?, 'Jordan', 'Existing', 'Saved legacy address')`, [returningLrn]);
    await rawPool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, idempotency_key)
      VALUES (?, '2026-2027', 'Grade 11', 'PUB', 'enrolled', ?, ?)`,
    [existingStudent.insertId, users.registrar, uuid()]);
    const mismatchedReturningSource = await preEnrollments.create(users.front_desk,
      readyPaper(uuid(), { lrn: '012345678908' }));
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      await convertInput(mismatchedReturningSource.id, 1, { studentNo: 'RETURNING-TEST', email: '' })),
    { status: 409 }, 'a returning student whose stored LRN differs from the paper source is rejected');
    const returningSource = await preEnrollments.create(users.front_desk,
      readyPaper(uuid(), { lrn: returningLrn, applicantKind: 'continuing' }));
    const returning = await annualService.createAnnualIntake(users.registrar,
      await convertInput(returningSource.id, 1, { studentNo: 'RETURNING-TEST', email: '' }));
    assert.equal(Number(returning.studentId), Number(existingStudent.insertId));
    const returnedProfile = await queryOne(rawPool, 'SELECT first_name, address FROM students WHERE id = ?', [existingStudent.insertId]);
    assert.deepEqual(returnedProfile, { first_name: 'Jordan', address: 'Saved legacy address' });

    // Returning-profile corrections require explicit field approval and bind to the reviewed snapshot.
    const reviewedLrn = '012345678909';
    const reviewedEmail = 'reviewed-student@integration.invalid';
    const [reviewedUser] = await rawPool.execute(`INSERT INTO users (email, password_hash, role, is_active)
      VALUES (?, 'preserve-this-test-password-hash', 'student', 1)`, [reviewedEmail]);
    const [reviewedStudent] = await rawPool.execute(`INSERT INTO students
      (user_id, student_no, lrn, first_name, last_name, address)
      VALUES (?, 'REVIEWED-RETURNING', ?, 'Before', 'Santos', 'Saved profile address')`, [reviewedUser.insertId, reviewedLrn]);
    await rawPool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, idempotency_key)
      VALUES (?, '2026-2027', 'Grade 11', 'PUB', 'enrolled', ?, ?)`,
    [reviewedStudent.insertId, users.registrar, uuid()]);
    await rawPool.execute(`INSERT INTO two_factor_codes (user_id, code_hash, expires_at)
      VALUES (?, 'integration-only-code-hash', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))`, [reviewedUser.insertId]);
    await rawPool.execute(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
      VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))`, [reviewedUser.insertId, crypto.createHash('sha256').update(uuid()).digest('hex')]);

    const activeEmailConflict = await queryOne(rawPool, 'SELECT email FROM users WHERE id = ?', [users.teacher]);
    const pendingEmailConflict = 'reserved-pending@integration.invalid';
    await rawPool.execute(`INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
      VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))`,
    [users.finance, pendingEmailConflict, crypto.createHash('sha256').update(uuid()).digest('hex')]);
    const reviewedSource = await preEnrollments.create(users.front_desk, readyPaper(uuid(), {
      lrn: reviewedLrn, applicantKind: 'continuing', email: activeEmailConflict.email,
      addressMode: 'replace', addressBlockLotStreetPurok: 'Block 8, Review Road', addressBarangay: 'Ibabang Iyam',
      addressCity: 'Lucena', addressProvince: 'Quezon', addressZip: '0123',
      emergencyContactAddressMode: 'replace', emergencyContactAddressBlockLotStreetPurok: 'Purok 4, Review Lane',
      emergencyContactAddressBarangay: 'Gulang-gulang', emergencyContactAddressCity: 'Lucena',
      emergencyContactAddressProvince: 'Quezon', emergencyContactAddressZip: '4301'
    }));
    const staleSnapshotInput = await convertInput(reviewedSource.id, 1, {
      studentNo: 'REVIEWED-RETURNING', approvedProfileFields: ['firstName']
    });
    await rawPool.execute('UPDATE students SET last_name = \'Changed during review\' WHERE id = ?', [reviewedStudent.insertId]);
    await assert.rejects(annualService.createAnnualIntake(users.registrar, staleSnapshotInput), { status: 409 },
      'a changed master profile invalidates the registrar review snapshot');

    let reviewedSourceVersion = 1;
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      await convertInput(reviewedSource.id, reviewedSourceVersion, {
        studentNo: 'REVIEWED-RETURNING', approvedProfileFields: ['addressZip']
      })), { status: 400 }, 'address components cannot be approved separately from their compatibility address');
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      await convertInput(reviewedSource.id, reviewedSourceVersion, {
        studentNo: 'REVIEWED-RETURNING', approvedProfileFields: ['firstName', 'email']
      })), { status: 409 }, 'an active email conflict prevents the returning profile and annual transaction');
    const pendingConflictSource = readyPaper(uuid(), { lrn: reviewedLrn, applicantKind: 'continuing', email: pendingEmailConflict });
    await preEnrollments.update(users.registrar, reviewedSource.id, reviewedSourceVersion, pendingConflictSource);
    reviewedSourceVersion += 1;
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      await convertInput(reviewedSource.id, reviewedSourceVersion, {
        studentNo: 'REVIEWED-RETURNING', approvedProfileFields: ['firstName', 'email']
      })), { status: 409 }, 'a live pending email reservation also prevents conversion');
    await rawPool.execute('UPDATE pending_email_changes SET consumed_at = UTC_TIMESTAMP(3) WHERE user_id = ?', [users.finance]);

    const finalEmail = 'corrected-returning@integration.invalid';
    const finalSource = readyPaper(uuid(), { lrn: reviewedLrn, applicantKind: 'continuing', email: finalEmail });
    await preEnrollments.update(users.registrar, reviewedSource.id, reviewedSourceVersion, finalSource);
    reviewedSourceVersion += 1;
    await rawPool.execute(`INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
      VALUES (?, 'older-pending@integration.invalid', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))`,
    [reviewedUser.insertId, crypto.createHash('sha256').update(uuid()).digest('hex')]);
    const beforeReviewedUser = await queryOne(rawPool,
      'SELECT email, password_hash, auth_session_version FROM users WHERE id = ?', [reviewedUser.insertId]);
    const approvedInput = await convertInput(reviewedSource.id, reviewedSourceVersion, {
      studentNo: 'REVIEWED-RETURNING', approvedProfileFields: ['firstName', 'email', 'address', 'emergencyContactAddress']
    });
    const reviewedConversion = await annualService.createAnnualIntake(users.registrar, approvedInput);
    const afterReviewedUser = await queryOne(rawPool,
      'SELECT email, password_hash, auth_session_version FROM users WHERE id = ?', [reviewedUser.insertId]);
    const afterReviewedStudent = await queryOne(rawPool,
      `SELECT first_name, last_name, address, address_block_lot_street_purok, address_barangay,
          address_city, address_province, address_zip, emergency_contact_address,
          emergency_contact_address_block_lot_street_purok, emergency_contact_address_barangay,
          emergency_contact_address_city, emergency_contact_address_province, emergency_contact_address_zip
        FROM students WHERE id = ?`, [reviewedStudent.insertId]);
    assert.equal(afterReviewedUser.email, finalEmail);
    assert.equal(afterReviewedUser.password_hash, beforeReviewedUser.password_hash, 'contact update preserves login credential hash');
    assert.notEqual(afterReviewedUser.auth_session_version, beforeReviewedUser.auth_session_version, 'contact update invalidates existing sessions');
    assert.deepEqual(afterReviewedStudent, { first_name: 'Ari', last_name: 'Changed during review',
      address: 'Block 8, Review Road, Ibabang Iyam, Lucena, Quezon, 0123',
      address_block_lot_street_purok: 'Block 8, Review Road', address_barangay: 'Ibabang Iyam',
      address_city: 'Lucena', address_province: 'Quezon', address_zip: '0123',
      emergency_contact_address: 'Purok 4, Review Lane, Gulang-gulang, Lucena, Quezon, 4301',
      emergency_contact_address_block_lot_street_purok: 'Purok 4, Review Lane', emergency_contact_address_barangay: 'Gulang-gulang',
      emergency_contact_address_city: 'Lucena', emergency_contact_address_province: 'Quezon', emergency_contact_address_zip: '4301' },
    'approved addresses update formatted and structured compatibility fields together, while unapproved master name fields remain unchanged');
    assert.equal(Number((await queryOne(rawPool,
      'SELECT COUNT(*) AS count FROM pending_email_changes WHERE user_id = ? AND consumed_at IS NULL', [reviewedUser.insertId])).count), 0,
    'successful approved email change consumes prior pending email-change tokens');
    assert.equal(Number((await queryOne(rawPool,
      'SELECT COUNT(*) AS count FROM two_factor_codes WHERE user_id = ? AND consumed_at IS NULL', [reviewedUser.insertId])).count), 0,
    'successful approved email change consumes pending two-factor codes');
    assert.equal(Number((await queryOne(rawPool,
      'SELECT COUNT(*) AS count FROM password_reset_tokens WHERE user_id = ? AND consumed_at IS NULL', [reviewedUser.insertId])).count), 0,
    'successful approved email change consumes pending password-reset tokens');
    assert.equal(Number((await queryOne(rawPool,
      'SELECT COUNT(*) AS count FROM student_profile_revisions WHERE student_id = ?', [reviewedStudent.insertId])).count), 14,
    'each changed approved master column receives a revision record');
    const reviewAudit = await queryOne(rawPool, `SELECT entity_type, entity_id FROM audit_logs
      WHERE action = 'registrar.student_profile_reviewed' AND entity_type = 'student' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    [String(reviewedStudent.insertId)]);
    assert.deepEqual(reviewAudit, { entity_type: 'student', entity_id: String(reviewedStudent.insertId) });
    const accountAudit = await queryOne(rawPool, `SELECT entity_type, entity_id, details_json FROM audit_logs
      WHERE action = 'registrar.student_account_email_updated' AND entity_type = 'user' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    [String(reviewedUser.insertId)]);
    assert.ok(accountAudit, 'approved email updates write a user-scoped account audit event');
    assert.equal(JSON.parse(accountAudit.details_json).authSessionsInvalidated, true);
    assert.doesNotMatch(accountAudit.details_json, /corrected-returning@integration\.invalid/, 'account audit does not store the email value');
    const exactReplay = await annualService.createAnnualIntake(users.registrar, approvedInput);
    assert.equal(exactReplay.annualEnrollmentId, reviewedConversion.annualEnrollmentId);
    assert.equal(exactReplay.alreadyCreated, true);
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      { ...approvedInput, approvedProfileFields: ['firstName'] }), { status: 409 },
    'a replay with changed field approvals conflicts instead of repeating the profile mutation');

    const [preservedAddressStudent] = await rawPool.execute(`INSERT INTO students
      (student_no, lrn, first_name, last_name, address, emergency_contact_address)
      VALUES ('PRESERVE-ADDRESS', '012345678916', 'Before', 'Address', 'Saved legacy student address', 'Saved legacy emergency address')`);
    await rawPool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, idempotency_key)
      VALUES (?, '2026-2027', 'Grade 11', 'PUB', 'enrolled', ?, ?)`,
    [preservedAddressStudent.insertId, users.registrar, uuid()]);
    const preserveAddressSource = await preEnrollments.create(users.front_desk, readyPaper(uuid(), {
      lrn: '012345678916', applicantKind: 'continuing', email: 'address-review@integration.invalid',
      addressMode: 'replace', addressBlockLotStreetPurok: 'Block 9, New Road', addressBarangay: 'New Barangay',
      addressCity: 'Lucena', addressProvince: 'Quezon', addressZip: '4301',
      emergencyContactAddressMode: 'replace', emergencyContactAddressBlockLotStreetPurok: 'Purok 8, New Lane',
      emergencyContactAddressBarangay: 'New Barangay', emergencyContactAddressCity: 'Lucena',
      emergencyContactAddressProvince: 'Quezon', emergencyContactAddressZip: '4301'
    }));
    const preserveAddressConversion = await annualService.createAnnualIntake(users.registrar,
      await convertInput(preserveAddressSource.id, 1, {
        studentNo: 'PRESERVE-ADDRESS', approvedProfileFields: ['firstName']
      }));
    assert.ok(preserveAddressConversion.annualEnrollmentId);
    const unchangedLegacyAddresses = await queryOne(rawPool,
      `SELECT address, address_block_lot_street_purok, emergency_contact_address,
          emergency_contact_address_block_lot_street_purok FROM students WHERE id = ?`, [preservedAddressStudent.insertId]);
    assert.deepEqual(unchangedLegacyAddresses, {
      address: 'Saved legacy student address', address_block_lot_street_purok: null,
      emergency_contact_address: 'Saved legacy emergency address', emergency_contact_address_block_lot_street_purok: null
    }, 'an unrelated approved name correction does not replace either legacy address');

    // Return evaluation is human-reviewed and linked to an interrupted student's exact LRN/year/grade.
    const interruptedLrn = '012345678910';
    const [interruptedInsert] = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
      VALUES ('BALIK-TEST', ?, 'Ari', 'Santos')`, [interruptedLrn]);
    const interruptedStudentId = Number(interruptedInsert.insertId);
    await rawPool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, idempotency_key)
      VALUES (?, '2025-2026', 'Grade 11', 'PUB', 'transferred', ?, ?)`,
    [interruptedStudentId, users.registrar, uuid()]);
    const readmissions = createReadmissionService({ getPool: async () => pool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool) });
    const evaluationsBeforeUnlinkedAttempts = Number((await queryOne(rawPool,
      'SELECT COUNT(*) AS count FROM readmission_evaluations')).count);
    await assert.rejects(readmissions.createUnlinked(users.registrar,
      readmissionInput('012345678919', { firstName: '' })),
    (error) => error.status === 409 && error.code === 'SAVED_STUDENT_REQUIRED',
    'direct unlinked creation is retired with a consistent saved-record requirement');
    await assert.rejects(readmissions.create(users.registrar, readmissionInput('012345678919')),
      (error) => error.status === 409 && error.code === 'SAVED_STUDENT_REQUIRED',
    'generic legacy creation cannot create a review for an LRN without a saved student');
    assert.equal(Number((await queryOne(rawPool, 'SELECT COUNT(*) AS count FROM readmission_evaluations')).count),
      evaluationsBeforeUnlinkedAttempts, 'retired creation attempts do not insert evaluation or history rows');
    await assert.rejects(readmissions.createUnlinked(users.database_admin), { status: 403 },
      'database administrators remain read-only before the retired creation response');
    await assert.rejects(readmissions.getStudentReturnEligibility(users.front_desk, interruptedStudentId), { status: 403 },
      'return eligibility is visible only to registrar and database administrator');
    const recordedDepartureEligibility = await readmissions.getStudentReturnEligibility(users.registrar, interruptedStudentId);
    assert.equal(recordedDepartureEligibility.eligible, true);
    assert.equal(recordedDepartureEligibility.basis, 'recorded_departure');

    const makeEligibilityStudent = async (studentNo, lrn, schoolYear, intakeStatus) => {
      const [insertedStudent] = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
        VALUES (?, ?, 'Return', 'Applicant')`, [studentNo, lrn]);
      const [insertedAnnual] = await rawPool.execute(`INSERT INTO annual_enrollments
        (student_id, school_year, grade_level, voucher_code, intake_status, created_by, idempotency_key)
        VALUES (?, ?, 'Grade 11', 'PUB', ?, ?, ?)`,
      [insertedStudent.insertId, schoolYear, intakeStatus, users.registrar, uuid()]);
      return { studentId: Number(insertedStudent.insertId), annualId: Number(insertedAnnual.insertId) };
    };
    const continuousStudent = await makeEligibilityStudent('RETURN-CONTINUOUS', '012345678920', '2026-2027', 'enrolled');
    assert.equal((await readmissions.getStudentReturnEligibility(users.registrar, continuousStudent.studentId)).eligible, false,
      'confirmed participation in the prior configured year does not expose Evaluate return');
    const pendingStudent = await makeEligibilityStudent('RETURN-PENDING', '012345678921', '2027-2028', 'pending');
    assert.equal((await readmissions.getStudentReturnEligibility(users.registrar, pendingStudent.studentId)).eligible, false,
      'a pending annual record in the configured current year does not imply interruption');
    const gapStudent = await makeEligibilityStudent('RETURN-GAP', '012345678922', '2025-2026', 'enrolled');
    const gapEligibility = await readmissions.getStudentReturnEligibility(users.registrar, gapStudent.studentId);
    assert.equal(gapEligibility.eligible, true);
    assert.equal(gapEligibility.basis, 'school_year_gap');
    await assert.rejects(readmissions.createForStudent(users.database_admin, gapStudent.studentId,
      readmissionInput('012345678922')), { status: 403 }, 'database administrators remain read-only for linked evaluation creation');
    await assert.rejects(readmissions.createForStudent(users.registrar, continuousStudent.studentId,
      readmissionInput('012345678920', { schoolYear: '2028-2029' })), { status: 409 },
    'a forged future target school year cannot bypass current-history eligibility');

    const departureStudent = await makeEligibilityStudent('RETURN-DEPARTURE-TERM', '012345678924', '2026-2027', 'enrolled');
    const departureTerms = [];
    for (const [index, termName] of ['Term 1', 'Term 2', 'Term 3'].entries()) {
      const [termInsert] = await rawPool.execute('INSERT INTO academic_terms (school_year, term, is_current) VALUES (?, ?, 0)',
        ['2026-2027', termName]);
      const termId = Number(termInsert.insertId);
      departureTerms.push(termId);
      await rawPool.execute(`INSERT INTO school_year_term_order (school_year, term_number, academic_term_id, configured_by)
        VALUES ('2026-2027', ?, ?, ?)`, [index + 1, termId, users.registrar]);
    }
    const departureEnrollments = [];
    for (const [index, termId] of departureTerms.entries()) {
      const [enrollmentInsert] = await rawPool.execute(`INSERT INTO enrollments
        (student_id, annual_enrollment_id, academic_term_id, annual_term_number, enrollment_status)
        VALUES (?, ?, ?, ?, ?)`, [departureStudent.studentId, departureStudent.annualId, termId, index + 1,
        index === 0 ? 'enrolled' : 'transferred']);
      departureEnrollments.push(Number(enrollmentInsert.insertId));
    }
    const [departureCaseInsert] = await rawPool.execute(`INSERT INTO finance_departure_cases
      (annual_enrollment_id, effective_enrollment_id, effective_date, departure_type, reason, recorded_by,
        idempotency_key, request_fingerprint)
      VALUES (?, ?, '2027-01-10', 'transferred', 'Integration fixture', ?, ?, ?)`,
    [departureStudent.annualId, departureEnrollments[1], users.registrar, uuid(), 'a'.repeat(64)]);
    const departureCaseId = Number(departureCaseInsert.insertId);
    for (const enrollmentId of departureEnrollments.slice(1)) {
      await rawPool.execute(`INSERT INTO finance_departure_case_terms
        (departure_case_id, enrollment_id, academic_activity_review_required) VALUES (?, ?, 0)`,
      [departureCaseId, enrollmentId]);
    }
    const effectiveDeparture = await readmissions.getStudentReturnEligibility(users.registrar, departureStudent.studentId);
    assert.equal(effectiveDeparture.eligible, true,
      'a confirmed departure remains a human-review basis even though annual intake_status is still enrolled');
    assert.equal(effectiveDeparture.departure.termNumber, 2);
    assert.equal(effectiveDeparture.departure.term, 'Term 2',
      'affected future term 3 does not replace the case effective enrollment');
    assert.equal(effectiveDeparture.departure.effectiveEnrollmentId, departureEnrollments[1]);
    await rawPool.execute("UPDATE enrollments SET enrollment_status = 'enrolled' WHERE id = ?", [departureEnrollments[1]]);
    assert.equal((await readmissions.getStudentReturnEligibility(users.registrar, departureStudent.studentId)).eligible, false,
      'active participation at the effective departure term suppresses a new evaluation');

    const supersededDeparture = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
      VALUES ('RETURN-SUPERSEDED', '012345678923', 'Return', 'Applicant')`);
    const supersededStudentId = Number(supersededDeparture[0].insertId);
    for (const [schoolYear, intakeStatus] of [['2024-2025', 'transferred'], ['2026-2027', 'enrolled']]) {
      await rawPool.execute(`INSERT INTO annual_enrollments
        (student_id, school_year, grade_level, voucher_code, intake_status, created_by, idempotency_key)
        VALUES (?, ?, 'Grade 11', 'PUB', ?, ?, ?)`, [supersededStudentId, schoolYear, intakeStatus, users.registrar, uuid()]);
    }
    assert.equal((await readmissions.getStudentReturnEligibility(users.registrar, supersededStudentId)).eligible, false,
      'a later continuing record suppresses an old departure signal');

    const evaluationDraft = await readmissions.create(users.registrar, readmissionInput(interruptedLrn, { subjectAvailability: 'unresolved' }));
    const forgedLinkedEvaluation = await readmissions.createForStudent(users.registrar, interruptedStudentId,
      readmissionInput(interruptedLrn, { applicantLrn: '012345678999', firstName: 'Forged', lastName: 'Identity', schoolYear: '2028-2029' }));
    const linkedContext = await readmissions.getForStudent(users.registrar, interruptedStudentId, forgedLinkedEvaluation.id);
    assert.equal(linkedContext.student_id, interruptedStudentId);
    assert.equal(linkedContext.applicant_lrn, interruptedLrn);
    assert.equal(linkedContext.first_name, 'Ari', 'linked create derives applicant identity from the saved student record');
    const otherContextLrn = crypto.randomInt(0, 1_000_000_000_000).toString().padStart(12, '0');
    const [otherContextInsert] = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
      VALUES ('OTHER-CONTEXT', ?, 'Other', 'Student')`, [otherContextLrn]);
    const otherContextStudentId = Number(otherContextInsert.insertId);
    await assert.rejects(readmissions.getForStudent(users.registrar, otherContextStudentId, forgedLinkedEvaluation.id), { status: 404 },
      'a linked evaluation cannot be opened through another student route');
    await assert.rejects(readmissions.update(users.registrar, forgedLinkedEvaluation.id, 1,
      readmissionInput(interruptedLrn, { schoolYear: '2028-2029' }), otherContextStudentId), { status: 404 },
    'a linked evaluation cannot be edited through another student route');
    const scopedUpdate = await readmissions.update(users.registrar, forgedLinkedEvaluation.id, 1,
      readmissionInput('012345678999', { schoolYear: '2028-2029', firstName: 'Tampered', lastName: 'Identity', priorProgress: 'Updated from the linked record.' }), interruptedStudentId);
    const afterScopedUpdate = await readmissions.getForStudent(users.registrar, interruptedStudentId, scopedUpdate.id);
    assert.equal(afterScopedUpdate.applicant_lrn, interruptedLrn);
    assert.equal(afterScopedUpdate.first_name, 'Ari');
    assert.equal(afterScopedUpdate.last_name, 'Santos');
    assert.equal(afterScopedUpdate.prior_progress, 'Updated from the linked record.');
    const legacyProtectedUpdate = await readmissions.update(users.registrar, forgedLinkedEvaluation.id, scopedUpdate.version,
      readmissionInput('012345678999', { schoolYear: '2028-2029', firstName: 'Legacy Tamper', lastName: 'Identity' }));
    const afterLegacyUpdate = await readmissions.get(users.registrar, legacyProtectedUpdate.id);
    assert.equal(afterLegacyUpdate.applicant_lrn, interruptedLrn);
    assert.equal(afterLegacyUpdate.first_name, 'Ari', 'legacy writes preserve identity for a linked evaluation');
    await assert.rejects(readmissions.update(users.registrar, forgedLinkedEvaluation.id, afterLegacyUpdate.version,
      readmissionInput(interruptedLrn, { schoolYear: '2028-2029' }), null, true), { status: 409 },
    'an evaluation posted to the unlinked canonical endpoint cannot be edited after it is linked');
    await assert.rejects(readmissions.decide(users.registrar, forgedLinkedEvaluation.id, afterLegacyUpdate.version,
      'not_accepted', 'Decision on unlinked endpoint.', null, true), { status: 409 },
    'an evaluation posted to the unlinked canonical endpoint cannot be decided after it is linked');
    assert.equal((await readmissions.get(users.registrar, forgedLinkedEvaluation.id)).version, afterLegacyUpdate.version,
      'unlinked endpoint guards reject before mutation');

    await assert.rejects(readmissions.createUnlinked(users.registrar,
      readmissionInput(interruptedLrn, { schoolYear: '2028-2029' })),
    (error) => error.status === 409 && error.code === 'SAVED_STUDENT_REQUIRED',
    'the retired unlinked service rejects creation even when its posted LRN matches a saved student');
    await assert.rejects(readmissions.create(users.database_admin, readmissionInput('012345678911')), { status: 403 },
      'database administrators may review, but cannot create, evaluations');
    await assert.rejects(readmissions.update(users.database_admin, evaluationDraft.id, 1, readmissionInput(interruptedLrn)), { status: 403 });
    await assert.rejects(readmissions.decide(users.database_admin, evaluationDraft.id, 1, 'accepted', 'No write access'), { status: 403 });
    const adminEvaluation = await readmissions.get(users.database_admin, evaluationDraft.id);
    assert.equal(adminEvaluation.status, 'under_review');
    assert.ok(adminEvaluation.prior_progress, 'database administrator can review evaluation details');
    await assert.rejects(preEnrollments.listAcceptedReadmissionChoices(users.database_admin, '2027-2028'), { status: 403 },
      'front-desk identity projections are not available to database administrators');
    const preAcceptanceChoices = await preEnrollments.listAcceptedReadmissionChoices(users.front_desk, '2027-2028');
    assert.equal(preAcceptanceChoices.some((row) => row.id === evaluationDraft.id), false);
    assert.deepEqual(Object.keys(preAcceptanceChoices[0] || {}).filter((key) => /progress|evidence|comparison|subjects|reason/i.test(key)), [],
      'front desk receives no academic evaluation notes');

    const spoofNew = readyPaper(uuid(), { lrn: interruptedLrn, applicantKind: 'new' });
    const spoofContinuing = readyPaper(uuid(), { lrn: interruptedLrn, applicantKind: 'continuing' });
    await assert.rejects(preEnrollments.create(users.front_desk, spoofNew), { status: 409 },
      'known interrupted history cannot be entered as a new applicant');
    await assert.rejects(preEnrollments.create(users.front_desk, spoofContinuing), { status: 409 },
      'known interrupted history cannot be entered as a continuous Grade 11 to 12 progression');
    await assert.rejects(preEnrollments.create(users.front_desk,
      readyPaper(uuid(), { lrn: '012345678907', applicantKind: 'continuing' })), { status: 409 },
    'continuing classification requires a known student record');
    const updateSpoof = await preEnrollments.create(users.front_desk,
      readyPaper(uuid(), { lrn: '012345678907', status: 'draft', applicantKind: 'new' }));
    await assert.rejects(preEnrollments.update(users.front_desk, updateSpoof.id, 1,
      readyPaper(uuid(), { lrn: interruptedLrn, status: 'draft', applicantKind: 'continuing' })), { status: 409 },
    'an edit cannot change an interrupted applicant into continuing');

    await assert.rejects(readmissions.decide(users.registrar, evaluationDraft.id, 1, 'accepted', 'Reviewed'), { status: 409 },
      'unresolved subjects prevent acceptance');
    const curriculumPendingVersion = await readmissions.update(users.registrar, evaluationDraft.id, 1,
      readmissionInput(interruptedLrn, { subjectAvailability: 'available', curriculumReviewStatus: 'unresolved' }));
    await assert.rejects(readmissions.decide(users.registrar, evaluationDraft.id, curriculumPendingVersion.version, 'accepted', 'Comparison incomplete'), { status: 409 },
      'available subjects do not permit acceptance while curriculum review remains explicitly unresolved');
    const unavailableVersion = await readmissions.update(users.registrar, evaluationDraft.id, curriculumPendingVersion.version,
      readmissionInput(interruptedLrn, { subjectAvailability: 'unavailable' }));
    await assert.rejects(readmissions.decide(users.registrar, evaluationDraft.id, unavailableVersion.version, 'accepted', 'No seat'), { status: 409 },
      'unavailable subjects prevent acceptance');
    const reviewedVersion = await readmissions.update(users.registrar, evaluationDraft.id, unavailableVersion.version,
      readmissionInput(interruptedLrn, { subjectAvailability: 'available' }));
    const accepted = await readmissions.decide(users.registrar, evaluationDraft.id, reviewedVersion.version, 'accepted', 'Subjects can be scheduled.');
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.version, reviewedVersion.version + 1);
    const acceptedHistory = await readmissions.get(users.registrar, accepted.id);
    const acceptedEvent = acceptedHistory.events.find((event) => event.event_type === 'accepted');
    const acceptedDetails = JSON.parse(acceptedEvent.details_json);
    assert.equal(acceptedDetails.before.status, 'under_review');
    assert.equal(acceptedDetails.after.status, 'accepted');
    assert.equal(acceptedDetails.after.decisionReason, 'Subjects can be scheduled.');

    const staleBoundPaper = readyPaper(uuid(), { lrn: interruptedLrn, applicantKind: 'readmission',
      readmissionEvaluationBinding: `${accepted.id}@${accepted.version}` });
    const balikSourceCreated = await preEnrollments.create(users.front_desk, staleBoundPaper);
    const balikSourceBeforeRefresh = await preEnrollments.get(users.registrar, balikSourceCreated.id);
    const reopened = await readmissions.update(users.registrar, accepted.id, accepted.version,
      readmissionInput(interruptedLrn, {
        priorProgress: 'Completed part of Grade 11.\nLeft school after the first term.',
        curriculumComparison: 'Updated comparison after a registrar review.\nEquivalent subjects were recorded.',
        decisionReason: 'Reopened for review.\nThe family supplied another school record.'
      }));
    assert.equal(reopened.status, 'under_review', 'editing an accepted evaluation invalidates its decision');
    const reopenedEvaluation = await readmissions.get(users.registrar, reopened.id);
    const reopenedEvent = reopenedEvaluation.events.find((event) => event.event_type === 'reopened');
    const reopenedDetails = JSON.parse(reopenedEvent.details_json);
    assert.equal(reopenedDetails.before.curriculumComparison, 'Compared completed subjects with the current curriculum by registrar review.');
    assert.equal(reopenedDetails.after.curriculumComparison, 'Updated comparison after a registrar review.\nEquivalent subjects were recorded.');
    assert.equal(reopenedDetails.before.decisionReason, 'Subjects can be scheduled.');
    assert.equal(reopenedDetails.after.decisionReason, 'Reopened for review.\nThe family supplied another school record.');
    assert.equal(reopenedDetails.after.priorProgress, 'Completed part of Grade 11.\nLeft school after the first term.');
    await assert.rejects(preEnrollments.update(users.registrar, balikSourceCreated.id, balikSourceBeforeRefresh.version,
      staleBoundPaper), { status: 409 }, 'a ready paper record cannot retain a stale evaluation binding');
    const reaccepted = await readmissions.decide(users.registrar, reopened.id, reopened.version, 'accepted', 'Re-reviewed current subjects.');
    const refreshedPaper = readyPaper(uuid(), { lrn: interruptedLrn, applicantKind: 'readmission',
      readmissionEvaluationBinding: `${reaccepted.id}@${reaccepted.version}` });
    const refreshedSourceUpdate = await preEnrollments.update(users.registrar, balikSourceCreated.id,
      balikSourceBeforeRefresh.version, refreshedPaper);
    assert.equal(refreshedSourceUpdate.status, 'ready_for_registrar');
    const balikSource = await preEnrollments.getForConversion(users.registrar, balikSourceCreated.id);
    const fdChoices = await preEnrollments.listAcceptedReadmissionChoices(users.front_desk, '2027-2028');
    const fdChoice = fdChoices.find((row) => row.id === reaccepted.id);
    assert.ok(fdChoice);
    const registrarChoices = await preEnrollments.listAcceptedReadmissionChoices(users.registrar, '2027-2028');
    assert.ok(registrarChoices.some((row) => row.id === reaccepted.id), 'registrar paper correction can explicitly rebind to a current accepted evaluation');
    assert.deepEqual(Object.keys(registrarChoices[0] || {}).filter((key) => /progress|evidence|comparison|subjects|reason|availability/i.test(key)), [],
      'the shared selection projection exposes identity and binding metadata only');
    assert.equal(fdChoice.applicant_lrn, interruptedLrn);
    assert.equal(fdChoice.version, reaccepted.version);
    assert.deepEqual(Object.keys(fdChoice).filter((key) => /progress|evidence|comparison|subjects|reason/i.test(key)), [],
      'front desk can only see the identity, LRN, year, grade, and accepted revision projection');
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      await convertInput(balikSource.id, Number(balikSource.version), { studentNo: 'RETURNING-TEST' })), { status: 409 },
    'a guessed unrelated student number cannot bypass the source LRN/student binding');
    const balikInput = await convertInput(balikSource.id, Number(balikSource.version), {
      studentNo: 'BALIK-TEST', intakeKind: 'standard'
    });
    const balikConversion = await annualService.createAnnualIntake(users.registrar, balikInput);
    assert.equal(Number(balikConversion.studentId), interruptedStudentId);
    const balikAnnual = await queryOne(rawPool,
      `SELECT intake_kind, readmission_evaluation_id, readmission_evaluation_version
        FROM annual_enrollments WHERE id = ?`, [balikConversion.annualEnrollmentId]);
    assert.equal(balikAnnual.intake_kind, 'readmission', 'registrar POST selection cannot erase the source classification');
    assert.equal(balikAnnual.readmission_evaluation_id, reaccepted.id);
    assert.equal(Number(balikAnnual.readmission_evaluation_version), reaccepted.version);
    await assert.rejects(readmissions.update(users.registrar, reaccepted.id, reaccepted.version,
      readmissionInput(interruptedLrn, { decisionReason: 'Attempted post-conversion edit.' })), { status: 409 },
    'evaluation content is locked after a linked annual source starts');
    const changedEvaluationVersion = reaccepted.version + 1;
    await rawPool.execute(`UPDATE readmission_evaluations SET status = 'under_review', version = ?, decided_by = NULL,
      decided_at = NULL, updated_by = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
    [changedEvaluationVersion, users.registrar, reaccepted.id]);
    await rawPool.execute(`INSERT INTO readmission_evaluation_events
      (evaluation_id, evaluation_version, actor_id, event_type, from_status, to_status, details_json)
      VALUES (?, ?, ?, 'reopened', 'accepted', 'under_review', JSON_OBJECT('changedFields', JSON_ARRAY('status')))` ,
    [reaccepted.id, changedEvaluationVersion, users.registrar]);
    let staleEvaluationFeeCalls = 0;
    const staleConfirmationService = createAnnualEnrollmentService({ getPool: async () => pool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool),
      termClearanceService,
      annualFinanceService: { async confirmAnnualAssessmentInTransaction() { staleEvaluationFeeCalls += 1; throw new Error('fee finalization must remain behind the evaluation gate'); } } });
    await assert.rejects(staleConfirmationService.confirmAnnualEnrollment(users.registrar, balikConversion.annualEnrollmentId, {
      idempotencyKey: uuid(), scheduleId: '1', scheduleVersion: '1', voucherCode: 'PUB', clearanceSnapshotFingerprint: 'b'.repeat(64)
    }), (error) => error.status === 409 && /evaluation changed or is no longer accepted/i.test(error.message),
    'first confirmation revalidates the evaluation revision and accepted decision');
    assert.equal(staleEvaluationFeeCalls, 0, 'a stale evaluation is rejected before fees, activation, or confirmation writes');

    // Same-school-year reactivation is rejected before a paper record or evaluation can be created.
    const sameYearLrn = '012345678912';
    const [sameYearStudent] = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
      VALUES ('SAME-YEAR-TEST', ?, 'Same', 'Year')`, [sameYearLrn]);
    await rawPool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, idempotency_key)
      VALUES (?, '2027-2028', 'Grade 11', 'PUB', 'enrolled', ?, ?)`,
    [sameYearStudent.insertId, users.registrar, uuid()]);
    await assert.rejects(readmissions.create(users.registrar, readmissionInput(sameYearLrn)), { status: 409 });
    const sameYearEvaluationLrn = '012345678913';
    const [sameYearEvaluationStudent] = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
      VALUES ('SAME-YEAR-BINDING', ?, 'Same', 'Binding')`, [sameYearEvaluationLrn]);
    await rawPool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, idempotency_key)
      VALUES (?, '2025-2026', 'Grade 11', 'PUB', 'transferred', ?, ?)`,
    [sameYearEvaluationStudent.insertId, users.registrar, uuid()]);
    const sameYearEvaluation = await readmissions.create(users.registrar,
      readmissionInput(sameYearEvaluationLrn));
    const sameYearAccepted = await readmissions.decide(users.registrar, sameYearEvaluation.id, sameYearEvaluation.version,
      'accepted', 'Human evaluation accepted before annual enrollment exists.');
    await rawPool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, idempotency_key)
      VALUES (?, '2027-2028', 'Grade 11', 'PUB', 'enrolled', ?, ?)`,
    [sameYearEvaluationStudent.insertId, users.registrar, uuid()]);
    await assert.rejects(preEnrollments.create(users.front_desk, readyPaper(uuid(), { lrn: '012345678913',
      applicantKind: 'readmission', readmissionEvaluationBinding: `${sameYearAccepted.id}@${sameYearAccepted.version}` })), { status: 409 },
    'an evaluation cannot authorize same-year reactivation after a prior-year paper decision');

    const lateSameYearLrn = '012345678917';
    // Legacy row fixture: new unlinked evaluations are retired, while already-saved unlinked records remain usable.
    const lateBoundEvaluation = await insertHistoricalUnlinkedEvaluation(rawPool, users.registrar,
      readmissionInput(lateSameYearLrn));
    const [lateSameYearStudent] = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
      VALUES ('SAME-YEAR-LATE-TEST', ?, 'Late', 'Year')`, [lateSameYearLrn]);
    const lateStudentId = Number(lateSameYearStudent.insertId);
    const lateContextEvaluation = await readmissions.getForStudent(users.registrar, lateStudentId, lateBoundEvaluation.id);
    assert.equal(lateContextEvaluation.student_id, null, 'a matching unlinked review is discoverable in the student context without implicit binding');
    assert.ok((await readmissions.listForStudent(users.registrar, lateStudentId)).some((row) => row.id === lateBoundEvaluation.id));
    await assert.rejects(readmissions.getForStudent(users.registrar, otherContextStudentId, lateBoundEvaluation.id), { status: 404 },
      'an unlinked evaluation only opens in context when its stored LRN matches');
    await rawPool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, idempotency_key)
      VALUES (?, '2027-2028', 'Grade 11', 'PUB', 'enrolled', ?, ?)`,
    [lateSameYearStudent.insertId, users.registrar, uuid()]);
    await assert.rejects(readmissions.decide(users.registrar, lateBoundEvaluation.id, lateBoundEvaluation.version,
      'accepted', 'A same-year enrollment was added during review.'), { status: 409 },
    'acceptance rechecks same-year activity by LRN when an evaluation had no linked student at creation');
    assert.equal((await readmissions.get(users.registrar, lateBoundEvaluation.id)).status, 'under_review',
      'the failed acceptance leaves the evaluation unchanged');

    // A previously saved unlinked evaluation remains usable, and its student master is allocated only by annual conversion.
    const noMasterLrn = '012345678914';
    // Legacy row fixture: preserve correction, decision, search, and paper-conversion coverage for prior unlinked reviews.
    const noMasterEvaluation = await insertHistoricalUnlinkedEvaluation(rawPool, users.registrar,
      readmissionInput(noMasterLrn));
    assert.equal(noMasterEvaluation.status, 'under_review');
    const unlinkedSearch = await readmissions.searchUnlinkedMatches(users.registrar, 'Santos');
    assert.ok(unlinkedSearch.some((row) => row.id === noMasterEvaluation.id), 'unlinked applicants are searchable by saved evaluation name');
    const correctedNoMaster = await readmissions.update(users.registrar, noMasterEvaluation.id, noMasterEvaluation.version,
      readmissionInput(noMasterLrn, { firstName: 'Arianna' }));
    const correctionHistory = await readmissions.get(users.registrar, correctedNoMaster.id);
    assert.equal(correctionHistory.first_name, 'Arianna', 'an unlinked applicant name can be corrected with a revision');
    assert.equal(correctionHistory.version, 2);
    await assert.rejects(readmissions.update(users.registrar, correctedNoMaster.id, correctedNoMaster.version,
      readmissionInput(interruptedLrn)), { status: 409 }, 'unlinked corrections cannot move an evaluation onto a saved student');
    const rejectedLinkedCorrection = await readmissions.get(users.registrar, correctedNoMaster.id);
    assert.equal(rejectedLinkedCorrection.applicant_lrn, noMasterLrn);
    assert.equal(rejectedLinkedCorrection.version, correctedNoMaster.version);
    const noMasterAccepted = await readmissions.decide(users.registrar, noMasterEvaluation.id, correctedNoMaster.version,
      'accepted', 'Reviewed available history supplied by the applicant.');
    const noMasterSource = await preEnrollments.create(users.front_desk, readyPaper(uuid(), { lrn: noMasterLrn,
      email: 'no-master-readmission@integration.invalid',
      applicantKind: 'readmission', readmissionEvaluationBinding: `${noMasterAccepted.id}@${noMasterAccepted.version}` }));
    assert.equal(Number((await queryOne(rawPool, 'SELECT COUNT(*) AS count FROM students WHERE lrn = ?', [noMasterLrn])).count), 0,
      'evaluation and paper entry do not create a student master');
    const noMasterAnnual = await annualService.createAnnualIntake(users.registrar,
      await convertInput(noMasterSource.id, 1, { intakeKind: 'transferee' }));
    assert.equal((await queryOne(rawPool, 'SELECT intake_kind FROM annual_enrollments WHERE id = ?', [noMasterAnnual.annualEnrollmentId])).intake_kind,
      'readmission');
    assert.equal(Number((await queryOne(rawPool, 'SELECT COUNT(*) AS count FROM students WHERE lrn = ?', [noMasterLrn])).count), 1,
      'student master creation occurs only at the authorized annual transaction');

    // Actual MariaDB grade service coverage: four current periods, published zero/null values, pending cached values,
    // historical observed periods, and empty/invalid contexts. The authenticated route uses the same live service.
    const studentId = Number(conversions[0].studentId);
    const [subjectInsert] = await rawPool.execute("INSERT INTO subjects (subject_code, subject_name, units) VALUES ('MTH101', 'Mathematics', 1)");
    const subjectId = Number(subjectInsert.insertId);
    const firstEnrollment = await queryOne(rawPool, 'SELECT id FROM enrollments WHERE annual_enrollment_id = ? AND annual_term_number = 1', [annualId]);
    await rawPool.execute("UPDATE enrollments SET enrollment_status = 'enrolled' WHERE id = ?", [firstEnrollment.id]);
    const [studentSubjectInsert] = await rawPool.execute('INSERT INTO student_subjects (enrollment_id, subject_id) VALUES (?, ?)',
      [firstEnrollment.id, subjectId]);
    const studentSubjectId = Number(studentSubjectInsert.insertId);
    await rawPool.execute('INSERT INTO grades (student_subject_id, grading_period, grade_value, recorded_by) VALUES (?, ?, ?, ?)',
      [studentSubjectId, 'Term 1', 0, users.registrar]);
    await rawPool.execute('INSERT INTO grades (student_subject_id, grading_period, grade_value, recorded_by) VALUES (?, ?, ?, ?)',
      [studentSubjectId, 'Term 2', null, users.registrar]);

    const academicRecordService = createAcademicRecordsService({ getPool: async () => pool, sql });
    const academicRecord = await academicRecordService.getStudentAcademicRecord(studentId);
    const termOneAcademic = academicRecord.enrollments.find((row) => Number(row.id) === Number(firstEnrollment.id));
    assert.equal(Number(termOneAcademic.term_number), 1);
    assert.equal(termOneAcademic.term_scope_status, 'applicable');
    const mathRecord = termOneAcademic.subjects.find((subject) => subject.subjectCode === 'MTH101');
    assert.ok(mathRecord);
    assert.deepEqual(Object.keys(mathRecord).sort(), ['grades', 'id', 'subjectCode', 'subjectId', 'subjectName', 'units']);
    assert.deepEqual(mathRecord.grades.map((grade) => ({
      gradingPeriod: grade.gradingPeriod,
      gradeValue: grade.gradeValue === null ? null : Number(grade.gradeValue),
      remarks: grade.remarks
    })), [
      { gradingPeriod: 'Term 1', gradeValue: 0, remarks: null },
      { gradingPeriod: 'Term 2', gradeValue: null, remarks: null }
    ]);

    const [assignmentInsert] = await rawPool.execute(`INSERT INTO teacher_assignments
      (teacher_id, academic_term_id, section_id, subject_id, assigned_by) VALUES (?, ?, ?, ?, ?)`,
      [users.teacher, terms[0], sections[0], subjectId, users.registrar]);
    const submissionId = uuid();
    await rawPool.execute(`INSERT INTO teacher_grade_submissions
      (id, assignment_id, revision_number, submitted_by, school_year, grade_level, section_name, subject_id, subject_name,
        workbook_grade_level, workbook_section_name, workbook_subject_name, context_mismatch, original_filename, storage_key, file_size_bytes)
      VALUES (?, ?, 1, ?, ?, 'Grade 11', 'Mabini', ?, 'Mathematics', 'Grade 11', 'Mabini', 'Mathematics', 0, 'grades.xlsx', ?, 64)`,
      [submissionId, assignmentInsert.insertId, users.teacher, year, subjectId, uuid()]);
    const [submissionRow] = await rawPool.execute(`INSERT INTO teacher_grade_submission_rows
      (submission_id, source_row, student_id, enrollment_id, student_subject_id, student_no, workbook_name, student_name, name_mismatch)
      VALUES (?, 1, ?, ?, ?, 'ALLOCATED-TEST', 'Ari Santos', 'Ari Santos', 0)`,
      [submissionId, studentId, firstEnrollment.id, studentSubjectId]);
    await rawPool.execute('INSERT INTO teacher_grade_submission_grades (submission_row_id, grading_period, grade_value) VALUES (?, ?, ?)',
      [submissionRow.insertId, 'Term 1', 88]);
    await rawPool.execute('INSERT INTO teacher_grade_submission_grades (submission_row_id, grading_period, grade_value) VALUES (?, ?, ?)',
      [submissionRow.insertId, 'Term 2', 91]);

    const [historicalTermInsert] = await rawPool.execute("INSERT INTO academic_terms (school_year, term, is_current) VALUES ('2025-2026', 'Term 1', 0)");
    const historicalTerm = Number(historicalTermInsert.insertId);
    const [historicalSectionInsert] = await rawPool.execute(`INSERT INTO sections (name, grade_level, academic_term_id, cluster, strand)
      VALUES ('Historical', 'Grade 11', ?, 'ASSH', 'Academic')`, [historicalTerm]);
    const [historicalEnrollmentInsert] = await rawPool.execute(`INSERT INTO enrollments
      (student_id, academic_term_id, section_id, enrollment_status, term_scope_status) VALUES (?, ?, ?, 'enrolled', 'applicable')`,
      [studentId, historicalTerm, historicalSectionInsert.insertId]);
    const [historicalSubjectInsert] = await rawPool.execute('INSERT INTO student_subjects (enrollment_id, subject_id) VALUES (?, ?)',
      [historicalEnrollmentInsert.insertId, subjectId]);
    await rawPool.execute('INSERT INTO grades (student_subject_id, grading_period, grade_value, recorded_by) VALUES (?, ?, ?, ?)',
      [historicalSubjectInsert.insertId, 'Midterm', 76, users.registrar]);

    const gradeService = createRegistrarGradeOverviewService({ getPool: async () => pool, sql });
    const currentOverview = await gradeService.getOverview(users.registrar, {
      termId: String(terms[0]), sectionId: String(sections[0]), subjectId: String(subjectId)
    });
    assert.deepEqual(new Set(currentOverview.periods), new Set(['Term 1', 'Term 2', 'Term 3', 'Final Grade']));
    const termOne = currentOverview.entries.find((entry) => entry.grading_period === 'Term 1');
    const termTwo = currentOverview.entries.find((entry) => entry.grading_period === 'Term 2');
    assert.equal(termOne.status, 'published');
    assert.equal(Number(termOne.grade_value), 0, 'a published zero remains visible despite a pending workbook value');
    assert.equal(Number(termOne.cached_grade_value), 88);
    assert.equal(termTwo.status, 'published_blank');
    assert.equal(Number(termTwo.cached_grade_value), 91);
    const historicalOverview = await gradeService.getOverview(users.registrar, {
      termId: String(historicalTerm), sectionId: String(historicalSectionInsert.insertId), subjectId: String(subjectId)
    });
    assert.deepEqual(historicalOverview.periods, ['Midterm']);
    const emptyOverview = await gradeService.getOverview(users.registrar, {
      termId: String(terms[0]), sectionId: String(emptySection), subjectId: String(subjectId)
    });
    assert.deepEqual(emptyOverview.periods, ['Term 1', 'Term 2', 'Term 3', 'Final Grade']);
    assert.equal(emptyOverview.entries.length, 0);
    await assert.rejects(gradeService.getOverview(users.registrar, {
      termId: String(terms[1]), sectionId: String(sections[0]), subjectId: String(subjectId)
    }), (error) => error instanceof RegistrarGradeOverviewError && error.status === 404);
    await assert.rejects(gradeService.getOverview(users.front_desk, {
      termId: String(terms[0]), sectionId: String(sections[0]), subjectId: String(subjectId)
    }), (error) => error instanceof RegistrarGradeOverviewError && error.status === 403);

    app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.resolve(ROOT, 'views'));
    app.use((req, res, next) => {
      const role = req.headers['x-test-role'] || 'registrar';
      req.authUser = { id: users[role], role, email: `${role}@integration.invalid` };
      req.session = { csrfToken: 'integration-csrf-token' };
      const navigation = buildNavigation(role, req.path);
      res.locals.currentUser = req.authUser;
      res.locals.navigationItems = navigation.items;
      res.locals.navigationGroups = navigation.groups;
      res.locals.currentPage = navigation.currentPage;
      next();
    });
    const recordsRouter = createStudentRecordsRouter({ getPool: async () => pool, sql,
      studentRecordsService: { async listWorkspace() { return { students: [], terms: [], sections: [] }; } },
      academicRecordsService: { async getStudentAcademicRecord() { return { enrollments: [] }; } },
      documentRequestService: { async getStudentRequests() { return []; } },
      documentClearanceService: { async getRegistrarData() { return { requests: [], financeSummary: null }; } },
      gradeOverviewService: gradeService });
    app.use('/registrar/records', requireRole('registrar', 'database_admin'), recordsRouter);
    app.use((error, req, res, next) => { void error; void req; void next; res.status(500).send('route test failed'); });
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const filteredRoute = await fetch(`${origin}/registrar/records/grades/missing?termId=${terms[0]}&sectionId=${sections[0]}&subjectId=${subjectId}`);
    assert.equal(filteredRoute.status, 200);
    const rendered = await filteredRoute.text();
    assert.match(rendered, /Grade completion overview/);
    assert.match(rendered, /published grade retained/i);
    assert.match(rendered, /MTH101/);
    const frontDeskGrades = await fetch(`${origin}/registrar/records/grades/missing?termId=${terms[0]}&sectionId=${sections[0]}&subjectId=${subjectId}`,
      { headers: { 'x-test-role': 'front_desk' } });
    assert.equal(frontDeskGrades.status, 403);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (rawPool) await rawPool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabase(freshName)}`);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabase(upgradeName)}`);
    await admin.end();
  }
});
