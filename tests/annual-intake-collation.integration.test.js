'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { PoolFacade, Transaction, sql } = require('../src/config/database');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');

const DATABASE_NAME = 'arktiesiis_collation_test';
const socketPath = process.env.ANNUAL_INTAKE_COLLATION_TEST_SOCKET;

function uuid() { return crypto.randomUUID(); }

test('annual intake works across mixed school-year collations and retries idempotently', {
  skip: !socketPath && 'Set ANNUAL_INTAKE_COLLATION_TEST_SOCKET to a disposable MariaDB socket under /tmp.'
}, async () => {
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(path.isAbsolute(socketPath), true, 'the test socket must be absolute');
  assert.equal(path.resolve(socketPath).startsWith(tempRoot), true, 'the test socket must be under /tmp');

  const rawPool = mysql.createPool({
    socketPath,
    user: 'root',
    password: '',
    database: DATABASE_NAME,
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'],
    multipleStatements: false
  });
  const collationStateInjected = new WeakSet();
  const facadePoolSource = {
    async getConnection() {
      const connection = await rawPool.getConnection();
      const physical = connection.connection || connection;
      if (!collationStateInjected.has(physical)) {
        await connection.query('SET CHARACTER_SET_CLIENT=utf8mb4');
        collationStateInjected.add(physical);
      }
      return connection;
    },
    async end() { return rawPool.end(); }
  };
  const pool = new PoolFacade(facadePoolSource);
  const service = createAnnualEnrollmentService({
    getPool: async () => pool,
    sql,
    transactionFactory: (currentPool) => new Transaction(currentPool),
    hashPassword: async () => 'integration-only-not-a-login-hash',
    createPassword: () => 'integration-only-not-a-login-password'
  });

  try {
    const [databaseRows] = await rawPool.query('SELECT DATABASE() AS database_name');
    assert.equal(databaseRows[0]?.database_name, DATABASE_NAME, 'refusing to run outside the exact disposable test database');
    const [migrationRows] = await rawPool.execute('SELECT version FROM schema_migrations WHERE version = ?', ['v2.011']);
    assert.equal(migrationRows.length, 1, 'apply the baseline and MariaDB migrations through v2.011 first');

    const [studentNumberColumn] = await rawPool.execute(`SELECT collation_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'students' AND column_name = 'student_no'`);
    assert.equal(studentNumberColumn[0]?.collation_name, 'utf8mb4_unicode_ci',
      'the allocator regression must use the uniform application collation');
    const allocatorSql = `SELECT SUBSTRING(student_no, CHAR_LENGTH(?) + 1) AS sequence
      FROM students
      WHERE student_no LIKE CONCAT(?, '%')
        AND CHAR_LENGTH(student_no) > CHAR_LENGTH(?)
        AND SUBSTRING(student_no, CHAR_LENGTH(?) + 1) REGEXP '^[0-9]+$'
      FOR UPDATE`;
    const allocatorPrefix = 'SHS-2090-';
    let rawConnection = await rawPool.getConnection();
    try {
      await rawConnection.query('SET CHARACTER_SET_CLIENT=utf8mb4');
      const [sessionProbe] = await rawConnection.execute('SELECT @@collation_connection AS connection_collation, COLLATION(?) AS bound_collation', [allocatorPrefix]);
      assert.equal(sessionProbe[0]?.connection_collation, 'utf8mb4_unicode_ci');
      assert.equal(sessionProbe[0]?.bound_collation, 'utf8mb4_general_ci');
      await assert.rejects(rawConnection.execute(allocatorSql,
        [allocatorPrefix, allocatorPrefix, allocatorPrefix, allocatorPrefix]),
      (error) => error.code === 'ER_CANT_AGGREGATE_2COLLATIONS' && Number(error.errno) === 1267,
      'the uninitialized MariaDB session must reproduce the student-number LIKE collation failure');
      await rawConnection.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
      const [afterSetNames] = await rawConnection.execute('SELECT COLLATION(?) AS bound_collation', [allocatorPrefix]);
      assert.equal(afterSetNames[0]?.bound_collation, 'utf8mb4_unicode_ci');
      await rawConnection.execute(allocatorSql, [allocatorPrefix, allocatorPrefix, allocatorPrefix, allocatorPrefix]);
    } finally {
      rawConnection.destroy();
      rawConnection = null;
    }

    const appSessionProbe = await pool.request()
      .input('prefix', sql.NVarChar(50), allocatorPrefix)
      .query('SELECT COLLATION(@prefix) AS bound_collation');
    assert.equal(appSessionProbe.recordset[0]?.bound_collation, 'utf8mb4_unicode_ci',
      'the facade must initialize a fresh physical MariaDB session before binding Unicode parameters');
    const appAllocatorRows = await pool.request()
      .input('prefix', sql.NVarChar(50), allocatorPrefix)
      .query(`SELECT SUBSTRING(student_no, CHAR_LENGTH(@prefix) + 1) AS sequence
        FROM students
        WHERE student_no LIKE CONCAT(@prefix, '%')
          AND CHAR_LENGTH(student_no) > CHAR_LENGTH(@prefix)
          AND SUBSTRING(student_no, CHAR_LENGTH(@prefix) + 1) REGEXP '^[0-9]+$'
        FOR UPDATE`);
    assert.deepEqual(appAllocatorRows.recordset, [], 'the adapter must initialize prepared statement parameter collation');

    // Retain coverage for the defensive school-year operand comparison if an older migration left mismatched columns.
    await rawPool.query(`ALTER TABLE academic_terms MODIFY school_year VARCHAR(20)
      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL`);
    await rawPool.query(`ALTER TABLE school_year_term_order MODIFY school_year VARCHAR(20)
      CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL`);

    let startYear = 2090 + (Date.now() % 800);
    let availableYear = false;
    for (let attempt = 0; attempt < 800; attempt += 1) {
      const candidate = `${startYear}-${startYear + 1}`;
      const [termRows] = await rawPool.execute('SELECT id FROM academic_terms WHERE school_year = ? LIMIT 1', [candidate]);
      const [studentRows] = await rawPool.execute('SELECT id FROM students WHERE student_no = ? LIMIT 1', [`EXISTING-${startYear}-0001`]);
      if (!termRows.length && !studentRows.length) { availableYear = true; break; }
      startYear = startYear >= 2889 ? 2090 : startYear + 1;
    }
    assert.equal(availableYear, true, 'the disposable test database needs an unused synthetic year');
    const schoolYear = `${startYear}-${startYear + 1}`;
    const token = uuid();
    const registrar = await rawPool.execute(
      'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
      [`registrar-${token}@integration.invalid`, 'integration-only-not-a-login-hash', 'registrar']
    );
    const actorId = Number(registrar[0].insertId);
    const termIds = [];
    for (const termName of ['Term 1', 'Term 2', 'Term 3']) {
      const [term] = await rawPool.execute(
        'INSERT INTO academic_terms (school_year, term) VALUES (?, ?)', [schoolYear, termName]
      );
      termIds.push(Number(term.insertId));
    }
    for (let index = 0; index < termIds.length; index += 1) {
      await rawPool.execute(
        'INSERT INTO school_year_term_order (school_year, term_number, academic_term_id, configured_by) VALUES (?, ?, ?, ?)',
        [schoolYear, index + 1, termIds[index], actorId]
      );
    }
    const sectionIds = [];
    for (const termId of termIds) {
      const [section] = await rawPool.execute(`INSERT INTO sections
        (name, grade_level, academic_term_id, cluster, strand, adviser, modality)
        VALUES ('Mabini', 'Grade 11', ?, 'Academic', 'STEM', 'Synthetic Adviser', 'face_to_face')`, [termId]);
      sectionIds.push(Number(section.insertId));
    }

    await assert.rejects(rawPool.execute(`SELECT configured.school_year FROM school_year_term_order AS configured
      INNER JOIN academic_terms AS term ON configured.academic_term_id = term.id
      WHERE configured.school_year = term.school_year AND configured.school_year = ?`, [schoolYear]),
    (error) => error.code === 'ER_CANT_AGGREGATE_2COLLATIONS' && Number(error.errno) === 1267,
    'the fixture must reproduce the mixed implicit-collation comparison');

    const newStudentInput = {
      studentNo: '', email: `new-${token}@integration.invalid`, lrn: String(100000000000 + Number.parseInt(token.slice(0, 8), 16) % 899999999999),
      firstName: 'Alex', middleName: 'Marie', lastName: 'Learner', suffix: '', birthDate: '2008-04-21',
      sex: 'Female', phone: '09171234567', address: '25 Mabini Street', schoolYear, gradeLevel: 'Grade 11',
      voucherCode: 'PUB', entryTermNumber: '1', enrollmentStartDate: '2026-10-03', sectionMode: 'same',
      annualSectionId: String(sectionIds[0]), idempotencyKey: uuid()
    };
    const newStudent = await service.createAnnualIntake(actorId, newStudentInput);
    const newStudentReplay = await service.createAnnualIntake(actorId, newStudentInput);
    assert.equal(newStudentReplay.annualEnrollmentId, newStudent.annualEnrollmentId);
    assert.equal(newStudentReplay.alreadyCreated, true);
    const [newPlacementRows] = await rawPool.execute(
      'SELECT section_id FROM enrollments WHERE annual_enrollment_id = ? ORDER BY annual_term_number',
      [newStudent.annualEnrollmentId]
    );
    assert.deepEqual(newPlacementRows.map((row) => Number(row.section_id)), sectionIds,
      'same-section selection must map matching later-term sections across mixed collations');

    const existingStudentNo = `EXISTING-${startYear}-0001`;
    const existingStudentLrn = String(100000000000 + (Number.parseInt(token.replaceAll('-', '').slice(8, 16), 16) % 899999999999));
    const [existingStudent] = await rawPool.execute(
      'INSERT INTO students (student_no, lrn, first_name, last_name) VALUES (?, ?, ?, ?)',
      [existingStudentNo, existingStudentLrn, 'Jordan', 'Learner']
    );
    const existingStudentInput = {
      studentNo: existingStudentNo, schoolYear, gradeLevel: 'Grade 11', voucherCode: 'ESC',
      entryTermNumber: '1', enrollmentStartDate: '2026-10-03', sectionMode: 'per_term',
      section1Id: String(sectionIds[0]), section2Id: String(sectionIds[1]), section3Id: String(sectionIds[2]),
      idempotencyKey: uuid()
    };
    const existingEnrollment = await service.createAnnualIntake(actorId, existingStudentInput);
    const existingReplay = await service.createAnnualIntake(actorId, existingStudentInput);
    assert.equal(existingReplay.annualEnrollmentId, existingEnrollment.annualEnrollmentId);
    assert.equal(existingReplay.alreadyCreated, true);
    assert.equal(Number(existingStudent.insertId) > 0, true);
    const [existingPlacementRows] = await rawPool.execute(
      'SELECT section_id FROM enrollments WHERE annual_enrollment_id = ? ORDER BY annual_term_number',
      [existingEnrollment.annualEnrollmentId]
    );
    assert.deepEqual(existingPlacementRows.map((row) => Number(row.section_id)), sectionIds,
      'explicit per-term selection must preserve selected section identities');
  } finally {
    await rawPool.end();
  }
});
