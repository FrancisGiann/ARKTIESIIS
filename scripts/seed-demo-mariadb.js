'use strict';

const bcrypt = require('bcrypt');
const environment = require('../src/config/environment');
const { getPool, closePool, sql, acquireTransactionLock } = require('../src/config/database');

const PASSWORD_ROUNDS = 12;
const SEED_PASSWORD_ENV = 'DEMO_SEED_PASSWORD';
const DEMO_USERS = [
  { key: 'admin', email: 'demo.admin@example.test', role: 'database_admin', name: 'Demo Administrator', employeeNo: 'DEMO-ADMIN-001' },
  { key: 'registrar', email: 'demo.registrar@example.test', role: 'registrar', name: 'Demo Registrar', employeeNo: 'DEMO-REG-001' },
  { key: 'teacher', email: 'demo.teacher@example.test', role: 'teacher', name: 'Demo Teacher', employeeNo: 'DEMO-TEACH-001' },
  { key: 'finance', email: 'demo.finance@example.test', role: 'finance', name: 'Demo Finance', employeeNo: 'DEMO-FIN-001' },
  { key: 'student', email: 'demo.student@example.test', role: 'student' }
];
const LOCAL_DEMO_PROFILE = {
  auditKey: 'mariadb-demo-v1',
  schoolYear: '2026-2027', term: 'Term 1', sectionName: 'Demo Section A', gradeLevel: 'Grade 11',
  subjectCode: 'DEMO-ENG-001', subjectName: 'Demo Communication Skills', subjectUnits: '3.00',
  studentNo: 'DEMO-0001', lrn: '999000000001', firstName: 'Demo', lastName: 'Learner',
  birthDate: '2008-01-15', address: 'Demo address'
};

class DemoSeedError extends Error {}

function seedPassword(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 12 || Buffer.byteLength(value, 'utf8') > 72) {
    throw new DemoSeedError(`${SEED_PASSWORD_ENV} must contain 12 to 72 UTF-8 bytes.`);
  }
  return value;
}

function validateTarget(configuration = environment) {
  if (configuration.nodeEnv !== 'development') throw new DemoSeedError('Demo data can only be seeded when NODE_ENV=development.');
  if (!configuration.devPasswordOnlyLogin) throw new DemoSeedError('Set DEV_PASSWORD_ONLY_LOGIN=true in development to use the seeded demo accounts.');
  const database = configuration.database || {};
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(String(database.host || '').toLowerCase())) {
    throw new DemoSeedError('Demo data can only be seeded into a local MariaDB database.');
  }
  if (!database.database || !/(?:^|[_-])(demo|dev|test)(?:[_-]|$)/i.test(database.database)) {
    throw new DemoSeedError('Use a separate local database whose name includes demo, dev, or test.');
  }
}

function parseOptions(args, nodeEnv = process.env.NODE_ENV || 'development') {
  if (nodeEnv !== 'development') throw new DemoSeedError('Demo data can only be seeded when NODE_ENV=development.');
  if (!Array.isArray(args) || args.length !== 1 || !['--dry-run', '--apply'].includes(args[0])) {
    throw new DemoSeedError('Choose exactly one option: --dry-run or --apply.');
  }
  return { mode: args[0] === '--apply' ? 'apply' : 'dry-run' };
}

async function firstRow(queryPromise) {
  const result = await queryPromise;
  return result.recordset?.[0] || null;
}

async function getOrCreateUser(transaction, account, passwordHash) {
  const existing = await firstRow(transaction.request()
    .input('email', sql.NVarChar(255), account.email)
    .query('SELECT id, role FROM users WHERE email = @email LIMIT 1 FOR UPDATE'));
  if (existing) {
    if (existing.role !== account.role) throw new DemoSeedError(`The reserved demo email ${account.email} is already used by a different role.`);
    return Number(existing.id);
  }
  const inserted = await transaction.request()
    .input('email', sql.NVarChar(255), account.email)
    .input('passwordHash', sql.NVarChar(255), passwordHash)
    .input('role', sql.NVarChar(30), account.role)
    .query(`INSERT INTO users (email, password_hash, role, is_active, must_change_password)
      VALUES (@email, @passwordHash, @role, 1, 0)`);
  return inserted.insertId;
}

async function ensureStaffProfile(transaction, userId, account) {
  const existing = await firstRow(transaction.request()
    .input('userId', sql.Int, userId)
    .query('SELECT id, employee_no FROM staff_profiles WHERE user_id = @userId LIMIT 1 FOR UPDATE'));
  if (existing) return Number(existing.id);
  const profile = await transaction.request()
    .input('userId', sql.Int, userId)
    .input('employeeNo', sql.NVarChar(50), account.employeeNo)
    .input('firstName', sql.NVarChar(100), 'Demo')
    .input('lastName', sql.NVarChar(100), account.name.replace(/^Demo\s+/, ''))
    .input('department', sql.NVarChar(100), 'Prototype')
    .query(`INSERT INTO staff_profiles (user_id, employee_no, first_name, last_name, department)
      VALUES (@userId, @employeeNo, @firstName, @lastName, @department)`);
  return profile.insertId;
}

async function getOrCreateTerm(transaction, profile) {
  const existing = await firstRow(transaction.request()
    .input('schoolYear', sql.NVarChar(20), profile.schoolYear)
    .input('term', sql.NVarChar(30), profile.term)
    .query('SELECT id FROM academic_terms WHERE school_year = @schoolYear AND term = @term LIMIT 1 FOR UPDATE'));
  if (existing) return Number(existing.id);
  const current = await firstRow(transaction.request()
    .query('SELECT id FROM academic_terms WHERE is_current = 1 LIMIT 1 FOR UPDATE'));
  const created = await transaction.request()
    .input('schoolYear', sql.NVarChar(20), profile.schoolYear)
    .input('term', sql.NVarChar(30), profile.term)
    .input('isCurrent', sql.Bit, current ? 0 : 1)
    .query('INSERT INTO academic_terms (school_year, term, is_current) VALUES (@schoolYear, @term, @isCurrent)');
  return created.insertId;
}

async function getOrCreateSection(transaction, termId, profile) {
  const existing = await firstRow(transaction.request()
    .input('termId', sql.Int, termId)
    .input('sectionName', sql.NVarChar(100), profile.sectionName)
    .query('SELECT id FROM sections WHERE academic_term_id = @termId AND name = @sectionName LIMIT 1 FOR UPDATE'));
  if (existing) return Number(existing.id);
  const created = await transaction.request()
    .input('termId', sql.Int, termId)
    .input('sectionName', sql.NVarChar(100), profile.sectionName)
    .input('gradeLevel', sql.NVarChar(50), profile.gradeLevel)
    .query('INSERT INTO sections (name, grade_level, academic_term_id) VALUES (@sectionName, @gradeLevel, @termId)');
  return created.insertId;
}

async function getOrCreateSubject(transaction, profile) {
  const existing = await firstRow(transaction.request()
    .input('subjectCode', sql.NVarChar(50), profile.subjectCode)
    .query('SELECT id FROM subjects WHERE subject_code = @subjectCode LIMIT 1 FOR UPDATE'));
  if (existing) return Number(existing.id);
  const created = await transaction.request()
    .input('subjectCode', sql.NVarChar(50), profile.subjectCode)
    .input('subjectName', sql.NVarChar(200), profile.subjectName)
    .input('subjectUnits', sql.Decimal(5, 2), profile.subjectUnits)
    .query('INSERT INTO subjects (subject_code, subject_name, units) VALUES (@subjectCode, @subjectName, @subjectUnits)');
  return created.insertId;
}

async function getOrCreateStudent(transaction, userId, profile) {
  const byNumber = await firstRow(transaction.request()
    .input('studentNo', sql.NVarChar(50), profile.studentNo)
    .query('SELECT id, user_id, lrn FROM students WHERE student_no = @studentNo LIMIT 1 FOR UPDATE'));
  const byLrn = await firstRow(transaction.request()
    .input('lrn', sql.NVarChar(12), profile.lrn)
    .query('SELECT id, user_id, student_no FROM students WHERE lrn = @lrn LIMIT 1 FOR UPDATE'));
  if (byNumber || byLrn) {
    if (!byNumber || !byLrn || Number(byNumber.id) !== Number(byLrn.id)
      || Number(byNumber.user_id) !== userId || Number(byNumber.user_id) !== Number(byLrn.user_id)) {
      throw new DemoSeedError('A reserved demo student number or LRN is already used by another record.');
    }
    return Number(byNumber.id);
  }
  const created = await transaction.request()
    .input('userId', sql.Int, userId)
    .input('studentNo', sql.NVarChar(50), profile.studentNo)
    .input('lrn', sql.NVarChar(12), profile.lrn)
    .input('firstName', sql.NVarChar(100), profile.firstName)
    .input('lastName', sql.NVarChar(100), profile.lastName)
    .input('birthDate', sql.Date, profile.birthDate)
    .input('address', sql.NVarChar(500), profile.address)
    .query(`INSERT INTO students (user_id, student_no, lrn, first_name, last_name, birth_date, sex, address, status)
      VALUES (@userId, @studentNo, @lrn, @firstName, @lastName, @birthDate, 'unspecified', @address, 'active')`);
  return created.insertId;
}

async function ensureEnrollment(transaction, studentId, termId, sectionId) {
  const existing = await firstRow(transaction.request()
    .input('studentId', sql.Int, studentId)
    .input('termId', sql.Int, termId)
    .query('SELECT id, section_id FROM enrollments WHERE student_id = @studentId AND academic_term_id = @termId LIMIT 1 FOR UPDATE'));
  if (existing) {
    if (Number(existing.section_id) !== sectionId) throw new DemoSeedError('The reserved demo enrollment uses a different section.');
    return Number(existing.id);
  }
  const created = await transaction.request()
    .input('studentId', sql.Int, studentId)
    .input('termId', sql.Int, termId)
    .input('sectionId', sql.Int, sectionId)
    .query(`INSERT INTO enrollments (student_id, academic_term_id, section_id, enrollment_status, finalized_at)
      VALUES (@studentId, @termId, @sectionId, 'enrolled', UTC_TIMESTAMP(6))`);
  return created.insertId;
}

async function ensureStudentSubject(transaction, enrollmentId, subjectId) {
  const existing = await firstRow(transaction.request()
    .input('enrollmentId', sql.Int, enrollmentId)
    .input('subjectId', sql.Int, subjectId)
    .query('SELECT id FROM student_subjects WHERE enrollment_id = @enrollmentId AND subject_id = @subjectId LIMIT 1 FOR UPDATE'));
  if (existing) return Number(existing.id);
  const created = await transaction.request()
    .input('enrollmentId', sql.Int, enrollmentId)
    .input('subjectId', sql.Int, subjectId)
    .query('INSERT INTO student_subjects (enrollment_id, subject_id) VALUES (@enrollmentId, @subjectId)');
  return created.insertId;
}

async function ensureAssignment(transaction, teacherId, termId, sectionId, subjectId, assignedBy) {
  const existing = await firstRow(transaction.request()
    .input('teacherId', sql.Int, teacherId)
    .input('termId', sql.Int, termId)
    .input('sectionId', sql.Int, sectionId)
    .input('subjectId', sql.Int, subjectId)
    .query(`SELECT id, teacher_id FROM teacher_assignments WHERE academic_term_id = @termId
      AND section_id = @sectionId AND subject_id = @subjectId AND is_active = 1 LIMIT 1 FOR UPDATE`));
  if (existing) {
    if (Number(existing.teacher_id) !== teacherId) throw new DemoSeedError('The reserved demo class is actively assigned to a different teacher.');
    return Number(existing.id);
  }
  const created = await transaction.request()
    .input('teacherId', sql.Int, teacherId)
    .input('termId', sql.Int, termId)
    .input('sectionId', sql.Int, sectionId)
    .input('subjectId', sql.Int, subjectId)
    .input('assignedBy', sql.Int, assignedBy)
    .query(`INSERT INTO teacher_assignments (teacher_id, academic_term_id, section_id, subject_id, assigned_by)
      VALUES (@teacherId, @termId, @sectionId, @subjectId, @assignedBy)`);
  return created.insertId;
}

async function ensureGrade(transaction, studentSubjectId, actorId) {
  for (const [period, value] of [['Term 1', '88.00'], ['Term 2', '91.00'], ['Term 3', '90.00'], ['Final Grade', '90.00']]) {
    const existing = await firstRow(transaction.request()
      .input('studentSubjectId', sql.Int, studentSubjectId)
      .input('period', sql.NVarChar(50), period)
      .query('SELECT id FROM grades WHERE student_subject_id = @studentSubjectId AND grading_period = @period LIMIT 1 FOR UPDATE'));
    if (existing) continue;
    await transaction.request()
      .input('studentSubjectId', sql.Int, studentSubjectId)
      .input('period', sql.NVarChar(50), period)
      .input('value', sql.Decimal(6, 2), value)
      .input('actorId', sql.Int, actorId)
      .query('INSERT INTO grades (student_subject_id, grading_period, grade_value, recorded_by) VALUES (@studentSubjectId, @period, @value, @actorId)');
  }
}

async function ensureFinanceAccount(transaction, studentId) {
  const existing = await firstRow(transaction.request()
    .input('studentId', sql.Int, studentId)
    .query('SELECT id FROM financial_accounts WHERE student_id = @studentId LIMIT 1 FOR UPDATE'));
  if (existing) return Number(existing.id);
  const created = await transaction.request()
    .input('studentId', sql.Int, studentId)
    .query('INSERT INTO financial_accounts (student_id, balance) VALUES (@studentId, 0.00)');
  return created.insertId;
}

async function runDemoSeed({ password = process.env[SEED_PASSWORD_ENV], passwords = null, accounts = DEMO_USERS,
  profile = LOCAL_DEMO_PROFILE, oneTime = false, validate = validateTarget, beforeSeed = async () => {},
  includeEmails = true, getDatabasePool = getPool, sqlTypes = sql,
  closeDatabasePool = closePool, logger = console } = {}) {
  validate();
  const passwordHashes = new Map();
  if (passwords) {
    for (const account of accounts) {
      passwordHashes.set(account.key, await bcrypt.hash(seedPassword(passwords[account.key]), PASSWORD_ROUNDS));
    }
  } else {
    const passwordHash = await bcrypt.hash(seedPassword(password), PASSWORD_ROUNDS);
    for (const account of accounts) passwordHashes.set(account.key, passwordHash);
  }
  const pool = await getDatabasePool();
  const transaction = new sqlTypes.Transaction(pool);
  let started = false;
  try {
    await transaction.begin(sqlTypes.ISOLATION_LEVEL.SERIALIZABLE);
    started = true;
    await acquireTransactionLock(transaction, 'demo-school-minimal-v1');

    if (oneTime) {
      const priorSeed = await firstRow(transaction.request()
        .input('seedKey', sql.NVarChar(100), profile.auditKey)
        .query("SELECT id FROM audit_logs WHERE entity_type = 'school_demo_seed' AND entity_id = @seedKey LIMIT 1 FOR UPDATE"));
      if (priorSeed) throw new DemoSeedError('The one-time demo seed was already applied to this database.');
    }
    await beforeSeed(transaction);

    const userIds = {};
    for (const account of accounts) {
      userIds[account.key] = await getOrCreateUser(transaction, account, passwordHashes.get(account.key));
      if (account.employeeNo) await ensureStaffProfile(transaction, userIds[account.key], account);
    }
    const termId = await getOrCreateTerm(transaction, profile);
    const sectionId = await getOrCreateSection(transaction, termId, profile);
    const subjectId = await getOrCreateSubject(transaction, profile);
    const studentId = await getOrCreateStudent(transaction, userIds.student, profile);
    const enrollmentId = await ensureEnrollment(transaction, studentId, termId, sectionId);
    const studentSubjectId = await ensureStudentSubject(transaction, enrollmentId, subjectId);
    await ensureAssignment(transaction, userIds.teacher, termId, sectionId, subjectId, userIds.admin);
    await ensureGrade(transaction, studentSubjectId, userIds.teacher);
    const financialAccountId = await ensureFinanceAccount(transaction, studentId);

    const seedAudit = await firstRow(transaction.request()
      .input('seedKey', sql.NVarChar(100), profile.auditKey)
      .query("SELECT id FROM audit_logs WHERE entity_type = 'school_demo_seed' AND entity_id = @seedKey LIMIT 1 FOR UPDATE"));
    if (!seedAudit) {
      await transaction.request()
        .input('actorId', sql.Int, userIds.admin)
        .input('seedKey', sql.NVarChar(100), profile.auditKey)
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@actorId, 'admin.demo_seeded', 'school_demo_seed', @seedKey, '{"version":1}')`);
    }

    await transaction.commit();
    started = false;
    logger.log(`MariaDB demo seed is ready in ${environment.database.database}.`);
    logger.log(includeEmails
      ? `Demo accounts: ${accounts.map(({ key, email }) => `${key}=${email}`).join(', ')}`
      : `Demo accounts are ready for roles: ${accounts.map(({ key }) => key).join(', ')}.`);
    logger.log(passwords ? 'Each account uses its separately configured password; none are printed.' : `${SEED_PASSWORD_ENV} supplies the shared password; the seed never prints it.`);
    return { userIds, termId, sectionId, subjectId, studentId, enrollmentId, studentSubjectId, financialAccountId };
  } catch (error) {
    if (started) await transaction.rollback().catch(() => {});
    if (error instanceof DemoSeedError) throw error;
    const safeError = new DemoSeedError('The demo seed did not complete. No database details were printed; verify the selected MariaDB schema and reserved fixture identifiers.');
    safeError.code = typeof error?.code === 'string' ? error.code : null;
    safeError.cause = error;
    throw safeError;
  } finally {
    await closeDatabasePool().catch(() => {});
  }
}

async function main() {
  try {
    const { mode } = parseOptions(process.argv.slice(2));
    if (mode === 'dry-run') {
      logger.log('Demo seed dry run passed. It will add five local demo accounts, one term, one section, one subject, one student enrollment, four grades, and a zero-balance finance account.');
      return;
    }
    validateTarget();
    await runDemoSeed();
  } catch (error) {
    console.error(error instanceof DemoSeedError ? error.message : 'Demo seed failed. Check environment and MariaDB setup.');
    process.exitCode = 1;
  }
}

const logger = console;
if (require.main === module) main();

module.exports = { DemoSeedError, DEMO_USERS, parseOptions, seedPassword, validateTarget, runDemoSeed };
