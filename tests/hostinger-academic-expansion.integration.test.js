'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { PoolFacade, sql } = require('../src/config/database');
const { runDemoSeed } = require('../scripts/seed-demo-mariadb');
const { PRODUCTION_PROFILE, HOSTINGER_ROLES } = require('../scripts/seed-hostinger-demo');
const { runExpansion, HOSTINGER_SEED_MARKER, EXPANSION_MARKER } = require('../scripts/expand-hostinger-demo');
const {
  ACADEMIC_MARKER,
  NEW_SUBJECTS,
  parseOptions,
  seedAcademicFixtures
} = require('../scripts/expand-hostinger-academic');
const { createTeacherGradeSubmissionService } = require('../src/services/teacherGradeSubmissionService');
const { createGradeImportService } = require('../src/services/gradeImportService');

const socketPath = process.env.ARKTIESIIS_ACADEMIC_SEED_TEST_SOCKET;
const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;

function safeDatabaseName() {
  return `arktiesiis_academic_seed_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
}

async function executeStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function buildDisposableSchema(connection) {
  await executeStatements(connection, readSqlFile(path.join(__dirname, '../database/mariadb/schema.sql')));
  for (const migration of readForwardMigrations()) {
    await executeStatements(connection, migration.statements);
    await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
  }
}

function instrumentPool(rawPool, failures = {}) {
  const stats = { dml: 0, lockAttempts: 0, transactions: 0, connections: 0, commits: 0, committed: 0, executions: 0, lastStatement: '' };
  let preCommitFailureUsed = false;
  let ambiguousCommitUsed = false;
  const source = {
    async getConnection() {
      stats.connections += 1;
      const connection = await rawPool.getConnection();
      return new Proxy({ connection }, {
        get(target, property) {
          if (property === 'connection') return connection;
          const value = connection[property];
          if (property === 'execute') return async (statement, values) => {
            const sqlText = String(statement);
            stats.executions += 1;
            if (!/GET_LOCK|RELEASE_LOCK/i.test(sqlText)) stats.lastStatement = sqlText.replace(/\s+/g, ' ').slice(0, 180);
            if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sqlText)) stats.dml += 1;
            if (/GET_LOCK\s*\(/i.test(sqlText)) stats.lockAttempts += 1;
            if (failures.beforeCommitEvent && !preCommitFailureUsed
              && /INSERT\s+INTO\s+teacher_grade_submission_events/i.test(sqlText)) {
              preCommitFailureUsed = true;
              const error = new Error('integration failure injection');
              error.code = 'INTEGRATION_FAILURE';
              throw error;
            }
            try { return await connection.execute(statement, values); }
            catch (error) { stats.failedStatement = stats.lastStatement; throw error; }
          };
          if (property === 'query') return async (...args) => {
            const sqlText = String(args[0] || '');
            if (!/GET_LOCK|RELEASE_LOCK/i.test(sqlText)) stats.lastStatement = sqlText.replace(/\s+/g, ' ').slice(0, 180);
            try { return await connection.query(...args); }
            catch (error) { stats.failedStatement = stats.lastStatement; throw error; }
          };
          if (property === 'beginTransaction') return async (...args) => {
            stats.transactions += 1;
            return connection.beginTransaction(...args);
          };
          if (property === 'commit') return async (...args) => {
            stats.commits += 1;
            const result = await connection.commit(...args);
            stats.committed += 1;
            if (failures.afterCommit && !ambiguousCommitUsed) {
              ambiguousCommitUsed = true;
              const error = new Error('integration ambiguous commit reply');
              error.code = 'INTEGRATION_COMMIT_UNKNOWN';
              throw error;
            }
            return result;
          };
          if (property === 'release' || property === 'destroy' || property === 'rollback') {
            return (...args) => connection[property](...args);
          }
          return typeof value === 'function' ? value.bind(connection) : value;
        }
      });
    },
    async end() { return rawPool.end(); }
  };
  return { pool: new PoolFacade(source), stats };
}

async function scalar(connection, statement, values = []) {
  const [rows] = await connection.execute(statement, values);
  return Number(rows[0]?.count || 0);
}

function seedOptions(database, mode, acknowledged = false) {
  return parseOptions([
    `--${mode}`,
    '--target-database', database,
    '--confirm-database', database,
    '--confirm-seed-marker', EXPANSION_MARKER,
    ...(acknowledged ? ['--acknowledge-production-academic-expansion'] : [])
  ], database);
}

test('Hostinger academic expansion dry-runs safely, rolls back, retries idempotently, and preserves review source files', {
  skip: !socketPath && 'Set ARKTIESIIS_ACADEMIC_SEED_TEST_SOCKET to an isolated MariaDB socket under /tmp.'
}, async (t) => {
  assert.equal(path.isAbsolute(socketPath), true, 'the test socket must be absolute');
  assert.equal(path.resolve(socketPath).startsWith(temporaryRoot), true, 'the test socket must be under /tmp');

  const databaseName = safeDatabaseName();
  const admin = await mysql.createConnection({ socketPath, user: 'root', password: '' });
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arktiesiis-academic-seed-'));
  let rawPool;
  let disposableDatabaseCreated = false;
  t.after(async () => {
    if (rawPool) await rawPool.end().catch(() => {});
    if (disposableDatabaseCreated) await admin.query(`DROP DATABASE \`${databaseName}\``).catch(() => {});
    await admin.end().catch(() => {});
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  disposableDatabaseCreated = true;
  const setupConnection = await mysql.createConnection({ socketPath, user: 'root', password: '', database: databaseName });
  try {
    await buildDisposableSchema(setupConnection);
  } finally {
    await setupConnection.end();
  }

  rawPool = mysql.createPool({ socketPath, user: 'root', password: '', database: databaseName,
    waitForConnections: true, connectionLimit: 5, queueLimit: 0, supportBigNumbers: true,
    bigNumberStrings: true, dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false });
  const config = {
    nodeEnv: 'production', devPasswordOnlyLogin: false,
    database: { host: 'localhost', port: 3306, database: databaseName, user: 'integration_user', password: 'private-test-only' },
    upload: { storageDirectory: storageRoot },
    sessionSecret: crypto.randomBytes(32).toString('hex')
  };
  const baseAccounts = HOSTINGER_ROLES.map((role) => ({
    ...role,
    email: `${role.key}@academic-seed.integration.invalid`,
    name: role.name
  }));
  const seedPool = instrumentPool(rawPool).pool;
  const quietLogger = { log() {}, error() {} };
  const seedResult = await runDemoSeed({
    passwords: Object.fromEntries(baseAccounts.map(({ key }) => [key, crypto.randomBytes(20).toString('hex')])),
    accounts: baseAccounts,
    profile: PRODUCTION_PROFILE,
    oneTime: true,
    validate() {},
    getDatabasePool: async () => seedPool,
    closeDatabasePool: async () => {},
    logger: quietLogger
  });
  assert.ok(seedResult.studentId);

  await runExpansion({
    options: { mode: 'apply', targetDatabase: databaseName, confirmDatabase: databaseName, seedMarker: HOSTINGER_SEED_MARKER },
    configuration: { ...config, database: { ...config.database, host: 'db.integration.invalid' } },
    getDatabasePool: async () => seedPool,
    closeDatabasePool: async () => {},
    logger: quietLogger,
    today: new Date('2026-10-03T00:00:00.000Z')
  });

  const [reservedActors] = await rawPool.execute(`SELECT user.id, user.role, profile.employee_no
    FROM users AS user LEFT JOIN staff_profiles AS profile ON profile.user_id = user.id`);
  const actorByRole = new Map(reservedActors.map((row) => [row.role, Number(row.id)]));
  const oldTeacher = reservedActors.find((row) => row.employee_no === 'HDMO-TEACH-001');
  const [existingSubjectRows] = await rawPool.execute(`SELECT id FROM subjects WHERE subject_code = 'DEMO-HOSTINGER-G11-ENG-001'`);
  const existingSubject = existingSubjectRows[0];
  const [ownedSectionRows] = await rawPool.execute(`SELECT section.id, section.academic_term_id FROM sections AS section
    INNER JOIN academic_terms AS term ON term.id = section.academic_term_id
    WHERE term.school_year = '2026-2027' AND term.term = 'Term 1'
      AND section.grade_level = 'Grade 11' AND section.name = 'Demo Hostinger Grade 11 A'`);
  const ownedSection = ownedSectionRows[0];
  assert.ok(oldTeacher && existingSubject?.id && ownedSection?.id,
    JSON.stringify({ reservedRoles: reservedActors.map(({ role, employee_no }) => ({ role, employee_no })), existingSubject, ownedSection }));

  await rawPool.execute(`INSERT INTO subjects (subject_code, subject_name, units)
    VALUES ('USR-COM-101', 'Community Media', '3.00')`);
  const [unownedSubjectRows] = await rawPool.execute("SELECT id FROM subjects WHERE subject_code = 'USR-COM-101'");
  const unownedSubject = unownedSubjectRows[0];
  const [unownedAssignment] = await rawPool.execute(`INSERT INTO teacher_assignments
    (teacher_id, academic_term_id, section_id, subject_id, assigned_by, is_active)
    VALUES (?, ?, ?, ?, ?, 1)`, [Number(oldTeacher.id), Number(ownedSection.academic_term_id),
    Number(ownedSection.id), Number(unownedSubject.id), actorByRole.get('database_admin')]);
  await rawPool.execute('UPDATE academic_terms SET is_current = 0 WHERE is_current = 1');
  const [laterTerm] = await rawPool.execute(`INSERT INTO academic_terms (school_year, term, is_current)
    VALUES ('2027-2028', 'Term 2', 1)`);
  const [laterSection] = await rawPool.execute(`INSERT INTO sections (name, grade_level, academic_term_id)
    VALUES ('Grade 11 Robotics', 'Grade 11', ?)`, [Number(laterTerm.insertId)]);
  const initialFinance = {};
  for (const table of ['annual_enrollments', 'annual_assessments', 'assessed_charges', 'finance_payments']) {
    initialFinance[table] = await scalar(rawPool, `SELECT COUNT(*) AS count FROM \`${table}\``);
  }

  const noStorageYet = path.join(storageRoot, 'not-created-by-dry-run');
  const quietOutput = [];
  const captureLogger = { log(value) { quietOutput.push(String(value)); }, error() {} };
  const dryRunPool = instrumentPool(rawPool);
  const options = seedOptions(databaseName, 'dry-run');
  const dryRun = await seedAcademicFixtures({ options, configuration: { ...config, upload: { storageDirectory: noStorageYet } },
    getDatabasePool: async () => dryRunPool.pool, closeDatabasePool: async () => {}, logger: captureLogger,
    today: new Date('2026-10-03T00:00:00.000Z') });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.counts.studentsAdded, 120);
  assert.equal(dryRun.counts.existingStudentsRenamed, 100);
  assert.equal(dryRun.counts.teacherAccountsAdded, 4);
  assert.equal(dryRun.counts.subjectsAdded, 4);
  assert.equal(dryRun.counts.assignmentsAdded, 24);
  assert.equal(dryRun.counts.schedulesAdded, 24);
  assert.equal(dryRun.counts.approvedGradeRows, 960);
  assert.equal(dryRun.counts.pendingReviewSubmissions, 8);
  assert.equal(dryRun.counts.pendingReviewRows, 240);
  assert.equal(dryRun.counts.sourceFiles, 8);
  assert.equal(dryRunPool.stats.dml, 0);
  assert.equal(dryRunPool.stats.lockAttempts, 0);
  assert.equal(dryRunPool.stats.transactions, 0);
  await assert.rejects(fs.access(noStorageYet));
  const dryRunSummary = JSON.parse(quietOutput.at(-1));
  const [targetTermRows] = await rawPool.execute(`SELECT id FROM academic_terms WHERE school_year = '2026-2027' AND term = 'Term 2'`);
  assert.deepEqual(dryRunSummary.currentTermChange, {
    from: '2027-2028 Term 2', fromTermId: Number(laterTerm.insertId),
    to: '2026-2027 Term 2', toTermId: Number(targetTermRows[0].id)
  });

  const [collision] = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
    VALUES ('ACADEMIC-2026-0001', '901000000001', 'Collision', 'Record')`);
  await assert.rejects(seedAcademicFixtures({ options, configuration: { ...config, upload: { storageDirectory: noStorageYet } },
    getDatabasePool: async () => instrumentPool(rawPool).pool, closeDatabasePool: async () => {}, logger: quietLogger }),
  /reserved academic student number or LRN/);
  await rawPool.execute('DELETE FROM students WHERE id = ? AND student_no = ?', [Number(collision.insertId), 'ACADEMIC-2026-0001']);

  const extensionStudentNo = 'DEMO-HOSTINGER-0002';
  const [originalOwnedName] = await rawPool.execute('SELECT first_name, middle_name, last_name FROM students WHERE student_no = ?', [extensionStudentNo]);
  await rawPool.execute('UPDATE students SET first_name = \'Human\' WHERE student_no = ?', [extensionStudentNo]);
  await assert.rejects(seedAcademicFixtures({ options, configuration: { ...config, upload: { storageDirectory: noStorageYet } },
    getDatabasePool: async () => instrumentPool(rawPool).pool, closeDatabasePool: async () => {}, logger: quietLogger }),
  /99 reserved expansion students do not match/);
  await rawPool.execute('UPDATE students SET first_name = ? WHERE student_no = ?', [originalOwnedName[0].first_name, extensionStudentNo]);

  const beforeCounts = {};
  for (const table of ['students', 'subjects', 'teacher_assignments', 'class_schedules', 'grades', 'teacher_grade_submissions']) {
    beforeCounts[table] = await scalar(rawPool, `SELECT COUNT(*) AS count FROM \`${table}\``);
  }
  const failurePool = instrumentPool(rawPool, { beforeCommitEvent: true });
  await assert.rejects(seedAcademicFixtures({ options: seedOptions(databaseName, 'apply', true), configuration: config,
    getDatabasePool: async () => failurePool.pool, closeDatabasePool: async () => {}, logger: quietLogger,
    today: new Date('2026-10-03T00:00:00.000Z') }), /academic fixture expansion failed/i);
  assert.equal(failurePool.stats.transactions, 1);
  assert.equal(await scalar(rawPool, `SELECT COUNT(*) AS count FROM students WHERE student_no LIKE 'ACADEMIC-2026-%'`), 0);
  assert.equal(await scalar(rawPool, `SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'academic_fixture_expansion' AND entity_id = ?`, [ACADEMIC_MARKER]), 0);
  for (const table of Object.keys(beforeCounts)) assert.equal(await scalar(rawPool, `SELECT COUNT(*) AS count FROM \`${table}\``), beforeCounts[table]);
  assert.deepEqual(await fs.readdir(path.join(storageRoot, 'teacher-grade-submissions')), []);
  await assert.rejects(fs.access(path.join(storageRoot, 'academic-fixture-teacher-credentials.json')));
  const [currentAfterRollbackRows] = await rawPool.execute('SELECT id, school_year, term FROM academic_terms WHERE is_current = 1');
  const currentAfterRollback = currentAfterRollbackRows[0];
  assert.deepEqual(currentAfterRollback, { id: Number(laterTerm.insertId), school_year: '2027-2028', term: 'Term 2' });

  const ambiguousPool = instrumentPool(rawPool, { afterCommit: true });
  const applyOptions = seedOptions(databaseName, 'apply', true);
  await assert.rejects(seedAcademicFixtures({ options: applyOptions, configuration: config,
    getDatabasePool: async () => ambiguousPool.pool, closeDatabasePool: async () => {}, logger: quietLogger,
    today: new Date('2026-10-03T00:00:00.000Z') }), /academic fixture expansion failed/i);
  assert.equal(ambiguousPool.stats.transactions, 1);
  assert.equal(ambiguousPool.stats.committed, 1, JSON.stringify(ambiguousPool.stats));
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM students WHERE student_no LIKE ?', ['ACADEMIC-2026-%']), 120, JSON.stringify(ambiguousPool.stats));
  assert.equal(await scalar(rawPool, `SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'academic_fixture_expansion' AND entity_id = ?`, [ACADEMIC_MARKER]), 1);

  const artifactPath = path.join(storageRoot, 'academic-fixture-teacher-credentials.json');
  const artifactStat = await fs.lstat(artifactPath);
  assert.equal(artifactStat.mode & 0o777, 0o600);
  const credentialArtifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
  assert.equal(credentialArtifact.marker, ACADEMIC_MARKER);
  assert.equal(credentialArtifact.accounts.length, 4);
  const workbookDirectory = path.join(storageRoot, 'teacher-grade-submissions');
  assert.equal((await fs.stat(workbookDirectory)).mode & 0o777, 0o700);
  const workbookFiles = await fs.readdir(workbookDirectory);
  assert.equal(workbookFiles.length, 8);
  assert.ok(workbookFiles.every((filename) => filename.endsWith('.xlsx') && !/demo/i.test(filename)));
  for (const filename of workbookFiles) assert.equal((await fs.stat(path.join(workbookDirectory, filename))).mode & 0o777, 0o600);

  const applyOnce = await seedAcademicFixtures({ options: applyOptions, configuration: config,
    getDatabasePool: async () => instrumentPool(rawPool).pool, closeDatabasePool: async () => {}, logger: quietLogger,
    today: new Date('2026-10-03T00:00:00.000Z') });
  assert.equal(applyOnce.mode, 'already-applied');
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM students WHERE student_no LIKE ?', ['ACADEMIC-2026-%']), 120);

  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM students'), 220);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM students WHERE student_no LIKE ? AND user_id IS NULL', ['ACADEMIC-2026-%']), 120);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM users WHERE email LIKE ?', ['teacher+academic-%@academic-seed.integration.invalid']), 4);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM subjects WHERE subject_code IN (?, ?, ?, ?)', NEW_SUBJECTS.map(({ code }) => code)), 4);
  assert.equal(await scalar(rawPool, `SELECT COUNT(*) AS count FROM teacher_assignments WHERE subject_id IN
    (SELECT id FROM subjects WHERE subject_code IN (?, ?, ?, ?))`, NEW_SUBJECTS.map(({ code }) => code)), 24);
  assert.equal(await scalar(rawPool, `SELECT COUNT(*) AS count FROM class_schedules AS schedule
    INNER JOIN teacher_assignments AS assignment ON assignment.id = schedule.assignment_id
    WHERE assignment.subject_id IN (SELECT id FROM subjects WHERE subject_code IN (?, ?, ?, ?))`, NEW_SUBJECTS.map(({ code }) => code)), 24);
  assert.equal(await scalar(rawPool, `SELECT COUNT(*) AS count FROM grades AS grade
    INNER JOIN student_subjects AS ss ON ss.id = grade.student_subject_id
    INNER JOIN enrollments AS enrollment ON enrollment.id = ss.enrollment_id
    INNER JOIN students AS student ON student.id = enrollment.student_id
    WHERE student.student_no LIKE 'ACADEMIC-2026-%' AND ss.subject_id IN
      (SELECT id FROM subjects WHERE subject_code IN (?, ?, ?, ?))`,
  NORMALIZED_CORE_SUBJECT_CODES()), 960);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM teacher_grade_submissions WHERE status = \'pending\''), 8);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM teacher_grade_submission_rows'), 240);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM teacher_grade_submission_grades'), 960);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM grades AS grade INNER JOIN student_subjects AS ss ON ss.id = grade.student_subject_id WHERE ss.subject_id IN (SELECT id FROM subjects WHERE subject_code IN (?, ?, ?, ?))', NEW_SUBJECTS.map(({ code }) => code)), 0,
    'pending workbook suggestions must not publish grades');

  const [selectedTermRows] = await rawPool.execute(`SELECT id, school_year, term FROM academic_terms WHERE is_current = 1`);
  const selectedTerm = selectedTermRows[0];
  assert.deepEqual(selectedTerm, { id: 2, school_year: '2026-2027', term: 'Term 2' });
  const [preservedLaterTermRows] = await rawPool.execute('SELECT id, school_year, term, is_current FROM academic_terms WHERE id = ?', [Number(laterTerm.insertId)]);
  const preservedLaterTerm = preservedLaterTermRows[0];
  assert.deepEqual(preservedLaterTerm, { id: Number(laterTerm.insertId), school_year: '2027-2028', term: 'Term 2', is_current: 0 });
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM sections WHERE id = ?', [Number(laterSection.insertId)]), 1);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM teacher_assignments WHERE id = ?', [Number(unownedAssignment.insertId)]), 1);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM subjects WHERE id = ?', [Number(unownedSubject.id)]), 1);
  for (const table of Object.keys(initialFinance)) assert.equal(await scalar(rawPool, `SELECT COUNT(*) AS count FROM \`${table}\``), initialFinance[table]);

  const [academicCurrentEnrollments] = await rawPool.execute(`SELECT COUNT(*) AS count FROM enrollments AS enrollment
    INNER JOIN students AS student ON student.id = enrollment.student_id
    INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
    WHERE student.student_no LIKE 'ACADEMIC-2026-%' AND term.school_year = '2026-2027' AND term.term = 'Term 2'
      AND enrollment.enrollment_status = 'enrolled'`);
  assert.equal(Number(academicCurrentEnrollments[0].count), 120);

  const reviewService = createTeacherGradeSubmissionService({
    getPool: async () => instrumentPool(rawPool).pool,
    sql,
    storageDirectory: storageRoot,
    secret: config.sessionSecret
  });
  const queue = await reviewService.listReviewQueue(actorByRole.get('registrar'));
  assert.equal(queue.length, 8);
  const firstReview = await reviewService.readSubmission(actorByRole.get('registrar'), queue[0].id, 'registrar');
  assert.equal(firstReview.rows.length, 30);
  assert.ok(firstReview.rows.every((row) => row.studentId && row.studentSubjectId && row.grades.length === 4 && !row.issue));
  const sourceWorkbook = await reviewService.getWorkbook(actorByRole.get('registrar'), queue[0].id, 'registrar');
  assert.equal((await fs.stat(sourceWorkbook.filePath)).isFile(), true);

  const gradeImport = createGradeImportService({
    getPool: async () => instrumentPool(rawPool).pool,
    sql,
    secret: config.sessionSecret
  });
  const approval = await gradeImport.confirmPreview({
    actorId: actorByRole.get('registrar'),
    submissionId: queue[0].id,
    decisions: firstReview.rows.map(({ sourceRow }) => ({ sourceRow, include: true, allowNameMismatch: false }))
  });
  assert.equal(approval.rowsProcessed, 30);
  assert.equal(approval.inserted, 120);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM teacher_grade_submissions WHERE status = \'pending\''), 7);
  assert.equal(await scalar(rawPool, 'SELECT COUNT(*) AS count FROM teacher_grade_submissions WHERE status = \'approved\''), 1);
  assert.equal(await scalar(rawPool, `SELECT COUNT(*) AS count FROM grades AS grade
    INNER JOIN student_subjects AS ss ON ss.id = grade.student_subject_id
    INNER JOIN subjects AS subject ON subject.id = ss.subject_id
    WHERE subject.subject_code IN (?, ?, ?, ?)`, NEW_SUBJECTS.map(({ code }) => code)), 120);
});

function NORMALIZED_CORE_SUBJECT_CODES() {
  return ['OCOM-11', 'GMAT-11', 'EAPP-12', 'STAT-12'];
}
