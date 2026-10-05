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
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');
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

async function createSchema(connection, databaseName, through = 'v2.015') {
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
    lrn: '012345678901', studentContactNumber: '09171234567', voucherTypeText: 'ESC', voucherCategoryText: 'CATEGORY A',
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

async function queryOne(pool, sqlText, parameters = []) {
  const [rows] = await pool.execute(sqlText, parameters);
  return rows[0] || null;
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

    // Fresh database exercises the inline column-level baseline CHECK replacement path.
    await createSchema(admin, freshName, 'v2.015');
    const [freshVersion] = await admin.execute(`SELECT version FROM ${quoteDatabase(freshName)}.schema_migrations WHERE version = 'v2.015'`);
    assert.equal(freshVersion.length, 1);
    const [freshRole] = await admin.execute(`SELECT checks.level FROM information_schema.check_constraints AS checks
      WHERE checks.constraint_schema = ? AND checks.constraint_name = 'CK_users_role'`, [freshName]);
    assert.equal(freshRole[0]?.level, 'Table', 'fresh migration replaces the inline baseline check with the named expanded table check');

    rawPool = mysql.createPool({ socketPath, user: os.userInfo().username, database: upgradeName,
      waitForConnections: true, connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: true,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false });
    const pool = new PoolFacade(rawPool);
    const users = await createUsers(rawPool);
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

    const convertInput = async (sourceId, sourceVersion, overrides = {}) => annualInput(sourceId, sourceVersion, sections[0], overrides);
    const conversionSource = receiptSource;
    const readyVersion = (await preEnrollments.get(users.registrar, conversionSource.id)).version;
    const sourceConversion = await convertInput(conversionSource.id, readyVersion);
    await assert.rejects(createAnnualEnrollmentService({ getPool: async () => pool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), hashPassword: async () => 'integration-only-hash',
      createPassword: () => 'integration-only-password' }).createAnnualIntake(users.front_desk, sourceConversion), { status: 403 },
    'front desk cannot directly invoke annual conversion, even with a valid guessed source id');
    const annualService = createAnnualEnrollmentService({ getPool: async () => pool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), hashPassword: async () => 'integration-only-hash',
      createPassword: () => 'integration-only-password' });
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
          if (/FROM pre_enrollments\s+WHERE id = @preEnrollmentId FOR UPDATE/.test(statement) && sourceLockArrivals < 2) {
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
      createPassword: () => 'integration-only-password' });
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
      { ...sourceConversion, email: 'changed@integration.invalid' }), { status: 409 }, 'changed replay details conflict');
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      { ...sourceConversion, addressBlockLotStreetPurok: 'Different street' }), { status: 409 }, 'structured address is fingerprinted on source replay');
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
    const rollbackSource = await preEnrollments.create(users.front_desk, readyPaper(uuid(), { lrn: '012345678905' }));
    const rollbackInput = await convertInput(rollbackSource.id, 1, {
      email: 'rollback@integration.invalid', lrn: '012345678905',
      paper_report_card_record: '1', paper_report_card_status: 'received', paper_report_card_applicable: '1',
      paper_report_card_token: uuid()
    });
    const failingAnnualService = createAnnualEnrollmentService({ getPool: async () => pool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), hashPassword: async () => 'integration-only-hash',
      createPassword: () => 'integration-only-password',
      physicalChecklistService: { recordIntakeUpdatesInTransaction() { throw new Error('intentional rollback probe'); } }
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
    const mismatchedReturningSource = await preEnrollments.create(users.front_desk,
      readyPaper(uuid(), { lrn: '012345678908' }));
    await assert.rejects(annualService.createAnnualIntake(users.registrar,
      await convertInput(mismatchedReturningSource.id, 1, { studentNo: 'RETURNING-TEST', email: '' })),
    { status: 409 }, 'a returning student whose stored LRN differs from the paper source is rejected');
    const returningSource = await preEnrollments.create(users.front_desk, readyPaper(uuid(), { lrn: returningLrn }));
    const returning = await annualService.createAnnualIntake(users.registrar,
      await convertInput(returningSource.id, 1, { studentNo: 'RETURNING-TEST', email: '' }));
    assert.equal(Number(returning.studentId), Number(existingStudent.insertId));
    const returnedProfile = await queryOne(rawPool, 'SELECT first_name, address FROM students WHERE id = ?', [existingStudent.insertId]);
    assert.deepEqual(returnedProfile, { first_name: 'Jordan', address: 'Saved legacy address' });

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
