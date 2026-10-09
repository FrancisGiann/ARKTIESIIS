'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { isIP } = require('node:net');
const environment = require('../src/config/environment');
const { getPool, closePool } = require('../src/config/database');
const { validateStudent } = require('../src/services/studentRecordsService');
const { REQUIRED_OBJECTS } = require('./hostinger-demo-v2.011-schema');
const { buildWorkbook, parseWorkbook } = require('./hostinger-academic-workbooks');

const HOSTINGER_SEED_MARKER = 'hostinger-demo-seed-v1';
const EXPANSION_MARKER = 'hostinger-demo-expansion-v1';
const ACADEMIC_MARKER = 'hostinger-academic-expansion-v1';
const SCHOOL_YEAR = '2026-2027';
const CURRENT_TERM = 'Term 2';
const APPLICATION_LOCK = 'ARKTIESIIS Hostinger academic expansion v1';
const BASELINE_STUDENT_NO = 'DEMO-HOSTINGER-0001';
const BASELINE_LRN = '999000000091';
const EXPANSION_STUDENT_COUNT = 99;
const NEW_STUDENT_COUNT = 120;
const NEW_TEACHER_COUNT = 4;
const NEW_SUBJECTS = [
  { code: 'DML-11', name: 'Digital Media Literacy', gradeLevel: 'Grade 11', firstName: 'Rina', lastName: 'Abad', units: '3.00' },
  { code: 'RM-11', name: 'Research Methods', gradeLevel: 'Grade 11', firstName: 'Mauro', lastName: 'Dizon', units: '3.00' },
  { code: 'AC-12', name: 'Applied Communication', gradeLevel: 'Grade 12', firstName: 'Lia', lastName: 'Navarro', units: '3.00' },
  { code: 'QR-12', name: 'Quantitative Reasoning', gradeLevel: 'Grade 12', firstName: 'Benedict', lastName: 'Tolentino', units: '3.00' }
];
const NORMALIZED_OLD_SUBJECTS = [
  { oldCode: 'DEMO-HOSTINGER-G11-ENG-001', newCode: 'OCOM-11', oldName: 'Demo Grade 11 English', newName: 'Oral Communication' },
  { oldCode: 'DEMO-HOSTINGER-G11-MATH-001', newCode: 'GMAT-11', oldName: 'Demo Grade 11 Mathematics', newName: 'General Mathematics' },
  { oldCode: 'DEMO-HOSTINGER-G12-ENG-001', newCode: 'EAPP-12', oldName: 'Demo Grade 12 English', newName: 'English for Academic and Professional Purposes' },
  { oldCode: 'DEMO-HOSTINGER-G12-MATH-001', newCode: 'STAT-12', oldName: 'Demo Grade 12 Mathematics', newName: 'Statistics and Probability' }
];
const EXISTING_FIXTURE_FIRST_NAMES = [
  'Alyssa', 'Mateo', 'Sofia', 'Gabriel', 'Amara', 'Noah', 'Isabella', 'Andres', 'Mikaela', 'Rafael',
  'Camila', 'Ethan', 'Juliana', 'Lorenzo', 'Nina', 'Adrian', 'Bianca', 'Samuel', 'Elise', 'Daniel'
];
const NEW_STUDENT_FIRST_NAMES = [
  'Abigail', 'Benjamin', 'Clara', 'Darius', 'Elena', 'Felix', 'Gia', 'Hector', 'Iris', 'Joaquin',
  'Kiara', 'Lucas', 'Maya', 'Nicolas', 'Olivia', 'Paolo', 'Queenie', 'Rafael', 'Samantha', 'Theo',
  'Una', 'Victor', 'Wendy', 'Xavier'
];
const FIXTURE_LAST_NAMES = ['Santos', 'Reyes', 'Cruz', 'Mendoza', 'Garcia'];
const NORMALIZED_OLD_STAFF = [
  { employeeNo: 'HDMO-ADMIN-001', role: 'database_admin', firstName: 'Naomi', lastName: 'Cruz' },
  { employeeNo: 'HDMO-REG-001', role: 'registrar', firstName: 'Maria', lastName: 'Santos' },
  { employeeNo: 'HDMO-TEACH-001', role: 'teacher', firstName: 'Elena', lastName: 'Reyes' },
  { employeeNo: 'HDMO-FIN-001', role: 'finance', firstName: 'Carlo', lastName: 'Mendoza' }
];
const REQUIRED_VERSIONS = Array.from({ length: 11 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`);
const GRADE_PERIODS = ['Term 1', 'Term 2', 'Term 3', 'Final Grade'];
const MARKER_AUDIT_ACTION = 'database_admin.academic_fixtures_seeded';
const PASSWORD_ROUNDS = 12;

class AcademicExpansionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AcademicExpansionError';
    this.status = status;
  }
}

function stableUuid(key) {
  const hex = crypto.createHash('sha256').update(`arktiesiis:${ACADEMIC_MARKER}:${key}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function chunk(values, size = 100) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function sectionName(gradeLevel, suffix) {
  return `${gradeLevel} ${suffix === 'A' ? 'STEM A' : 'HUMSS B'}`;
}

function makeOwnedStudentName(ordinal) {
  const index = ordinal - 2;
  return {
    firstName: EXISTING_FIXTURE_FIRST_NAMES[index % EXISTING_FIXTURE_FIRST_NAMES.length],
    lastName: FIXTURE_LAST_NAMES[Math.floor(index / EXISTING_FIXTURE_FIRST_NAMES.length)]
  };
}

function buildPlan({ today = new Date() } = {}) {
  const now = today instanceof Date ? new Date(today.getTime()) : new Date(today);
  if (Number.isNaN(now.getTime())) throw new AcademicExpansionError('The academic fixture date is invalid.');
  const newStudents = Array.from({ length: NEW_STUDENT_COUNT }, (_, index) => {
    const gradeIndex = Math.floor(index / 60);
    const gradeLevel = gradeIndex === 0 ? 'Grade 11' : 'Grade 12';
    const sectionOrdinal = index % 60;
    const suffix = sectionOrdinal < 30 ? 'A' : 'B';
    const firstName = NEW_STUDENT_FIRST_NAMES[index % NEW_STUDENT_FIRST_NAMES.length];
    const lastName = FIXTURE_LAST_NAMES[Math.floor(index / NEW_STUDENT_FIRST_NAMES.length)];
    const birthYear = gradeLevel === 'Grade 11' ? 2008 : 2007;
    const birthMonth = String((index % 12) + 1).padStart(2, '0');
    const birthDay = String((index % 27) + 1).padStart(2, '0');
    const student = {
      ordinal: index + 1,
      studentNo: `ACADEMIC-${SCHOOL_YEAR.slice(0, 4)}-${String(index + 1).padStart(4, '0')}`,
      lrn: String(999000000500 + index),
      firstName,
      middleName: null,
      lastName,
      suffix: null,
      birthDate: `${birthYear}-${birthMonth}-${birthDay}`,
      sex: index % 2 === 0 ? 'Female' : 'Male',
      phone: `0917${String(3000000 + index).padStart(7, '0')}`,
      address: 'Lucena City, Quezon',
      gradeLevel,
      suffixSection: suffix,
      sectionName: sectionName(gradeLevel, suffix)
    };
    const validated = validateStudent(student, { requireStudentNo: true });
    if (validated.birthDate >= now.toISOString().slice(0, 10)) {
      throw new AcademicExpansionError('A generated student birth date must be in the past.');
    }
    return { ...student, ...validated };
  });
  if (new Set(newStudents.map(({ lrn }) => lrn)).size !== NEW_STUDENT_COUNT
    || new Set(newStudents.map(({ studentNo }) => studentNo)).size !== NEW_STUDENT_COUNT) {
    throw new AcademicExpansionError('Academic fixture student identifiers are not unique.');
  }
  const normalizedStudents = [
    { studentNo: BASELINE_STUDENT_NO, firstName: 'Alyssa', middleName: null, lastName: 'Santos' },
    ...Array.from({ length: EXPANSION_STUDENT_COUNT }, (_, index) => {
      const ordinal = index + 2;
      const name = makeOwnedStudentName(ordinal);
      return { studentNo: `DEMO-HOSTINGER-${String(ordinal).padStart(4, '0')}`,
        firstName: name.firstName, middleName: null, lastName: name.lastName };
    })
  ];
  const normalizedSections = [
    { termNumber: 1, gradeLevel: 'Grade 11', suffix: 'A', oldName: 'Demo Hostinger Section A', newName: 'Grade 11 Foundation A', baseline: true },
    ...[1, 2, 3].flatMap((termNumber) => [
      ...['Grade 11', 'Grade 12'].flatMap((gradeLevel) => ['A', 'B'].map((suffix) => ({
        termNumber, gradeLevel, suffix,
        oldName: `Demo Hostinger ${gradeLevel} ${suffix}`,
        newName: sectionName(gradeLevel, suffix),
        baseline: false
      })))
    ])
  ];
  const newTeachers = NEW_SUBJECTS.map(({ firstName, lastName }, index) => ({
    employeeNo: `HDMO-ACADEMIC-TEACH-${String(index + 1).padStart(3, '0')}`,
    role: 'teacher', firstName, lastName, subjectCode: NEW_SUBJECTS[index].code,
    subjectName: NEW_SUBJECTS[index].name, gradeLevel: NEW_SUBJECTS[index].gradeLevel,
    emailKey: `academic-${String(index + 1).padStart(2, '0')}`
  }));
  const counts = {
    studentsAdded: NEW_STUDENT_COUNT,
    existingStudentsRenamed: normalizedStudents.length,
    teacherAccountsAdded: NEW_TEACHER_COUNT,
    existingStaffProfilesRenamed: NORMALIZED_OLD_STAFF.length,
    subjectsAdded: NEW_SUBJECTS.length,
    sectionsReused: 12,
    assignmentsAdded: 24,
    schedulesAdded: 24,
    approvedGradeRows: NEW_STUDENT_COUNT * 2 * GRADE_PERIODS.length,
    pendingReviewSubmissions: 8,
    pendingReviewRows: 8 * 30,
    sourceFiles: 8,
    currentTermAfter: `${SCHOOL_YEAR} ${CURRENT_TERM}`
  };
  return { newStudents, normalizedStudents, normalizedSections, newTeachers, counts };
}

function parseOptions(args, configuredDatabase = environment.database.database) {
  if (!Array.isArray(args)) throw new AcademicExpansionError('Seed arguments are invalid.');
  const options = { mode: null, targetDatabase: null, confirmDatabase: null, seedMarker: null, acknowledged: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (options.mode) throw new AcademicExpansionError('Choose exactly one mode: --dry-run or --apply.');
      options.mode = argument.slice(2);
    } else if (['--target-database', '--confirm-database', '--confirm-seed-marker'].includes(argument)) {
      if (seen.has(argument) || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new AcademicExpansionError(`Provide one value for ${argument}.`);
      }
      if (argument === '--target-database') options.targetDatabase = args[index + 1];
      if (argument === '--confirm-database') options.confirmDatabase = args[index + 1];
      if (argument === '--confirm-seed-marker') options.seedMarker = args[index + 1];
      seen.add(argument);
      index += 1;
    } else if (argument === '--acknowledge-production-academic-expansion') {
      if (options.acknowledged) throw new AcademicExpansionError('The production acknowledgement was repeated.');
      options.acknowledged = true;
    } else {
      throw new AcademicExpansionError('Seed arguments are invalid.');
    }
  }
  if (!options.mode || !options.targetDatabase || !options.confirmDatabase || !options.seedMarker) {
    throw new AcademicExpansionError('Provide a mode, the exact database name twice, and the exact existing expansion marker.');
  }
  if (options.targetDatabase !== options.confirmDatabase || options.targetDatabase !== configuredDatabase) {
    throw new AcademicExpansionError('Both confirmed database names must exactly match DB_NAME.');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.targetDatabase)) throw new AcademicExpansionError('The target database name is invalid.');
  if (options.seedMarker !== EXPANSION_MARKER) throw new AcademicExpansionError('Confirm the exact hostinger-demo-expansion-v1 marker.');
  if (options.mode === 'apply' && !options.acknowledged) {
    throw new AcademicExpansionError('Apply requires --acknowledge-production-academic-expansion.');
  }
  if (options.mode === 'dry-run' && options.acknowledged) {
    throw new AcademicExpansionError('The production acknowledgement is only valid with --apply.');
  }
  return options;
}

function validateProductionTarget(configuration = environment) {
  if (configuration.nodeEnv !== 'production') throw new AcademicExpansionError('The academic expansion requires NODE_ENV=production.');
  if (configuration.devPasswordOnlyLogin) throw new AcademicExpansionError('Development password-only login must remain disabled.');
  const database = configuration.database || {};
  const host = String(database.host || '').trim().toLowerCase();
  const addressType = isIP(host);
  if (!host || host === '::1' || (addressType === 4 && /^127\./.test(host))) {
    throw new AcademicExpansionError('The academic expansion requires the confirmed Hostinger MariaDB connection.');
  }
  if (!database.database || !database.user || String(database.user).toLowerCase() === 'root' || !database.password) {
    throw new AcademicExpansionError('DB_NAME, DB_USER, and DB_PASSWORD must identify the existing Hostinger database.');
  }
}

function validateHostApplyTarget(configuration = environment) {
  validateProductionTarget(configuration);
  const database = configuration.database || {};
  if (String(database.host || '').trim().toLowerCase() !== 'localhost') {
    throw new AcademicExpansionError('Apply must run on Hostinger with DB_HOST=localhost so private workbook files reach the same host as the database.');
  }
  const storageDirectory = configuration.upload?.storageDirectory;
  if (typeof storageDirectory !== 'string' || !path.isAbsolute(storageDirectory)) {
    throw new AcademicExpansionError('Apply requires an absolute DOCUMENT_STORAGE_DIR on Hostinger.');
  }
  const root = path.resolve(__dirname, '..');
  const resolved = path.resolve(storageDirectory);
  const relative = path.relative(root, resolved);
  const insideProject = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  const pathParts = resolved.split(path.sep).map((part) => part.toLowerCase());
  if (insideProject || pathParts.includes('hbuilds') || pathParts.includes('public_html')) {
    throw new AcademicExpansionError('DOCUMENT_STORAGE_DIR must be private and outside the checkout, hbuilds, and public_html.');
  }
}

async function readRows(connection, statement, values = []) {
  const [rows] = await connection.execute(statement, values);
  return rows;
}

async function insertMany(connection, table, columns, rows) {
  for (const part of chunk(rows)) {
    if (!part.length) continue;
    const columnSql = columns.map((column) => `\`${column}\``).join(', ');
    const valueSql = part.map(() => `(${placeholders(columns.length)})`).join(', ');
    const values = part.flatMap((row) => columns.map((column) => row[column]));
    await connection.execute(`INSERT INTO \`${table}\` (${columnSql}) VALUES ${valueSql}`, values);
  }
}

async function requireExpectedSchema(connection) {
  const versions = await readRows(connection, 'SELECT version FROM schema_migrations ORDER BY version');
  const applied = versions.map(({ version }) => String(version));
  if (applied.length !== REQUIRED_VERSIONS.length || REQUIRED_VERSIONS.some((version) => !applied.includes(version))) {
    throw new AcademicExpansionError('The expansion requires the complete MariaDB baseline and migrations through v2.011.');
  }
  const objects = await readRows(connection,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()
      AND table_name IN (${placeholders(REQUIRED_OBJECTS.length)})`, REQUIRED_OBJECTS);
  const found = new Set(objects.map(({ table_name }) => String(table_name)));
  if (REQUIRED_OBJECTS.some((name) => !found.has(name))) throw new AcademicExpansionError('The selected database is missing required academic schema objects.');
}

async function requireMarkers(connection) {
  const rows = await readRows(connection,
    `SELECT marker.entity_type, marker.entity_id, actor.role FROM audit_logs AS marker
      INNER JOIN users AS actor ON actor.id = marker.user_id
      WHERE (marker.entity_type = 'school_demo_seed' AND marker.entity_id = ?)
        OR (marker.entity_type = 'school_demo_expansion' AND marker.entity_id = ?)` ,
    [HOSTINGER_SEED_MARKER, EXPANSION_MARKER]);
  const seed = rows.filter((row) => row.entity_type === 'school_demo_seed' && row.entity_id === HOSTINGER_SEED_MARKER);
  const expansion = rows.filter((row) => row.entity_type === 'school_demo_expansion' && row.entity_id === EXPANSION_MARKER);
  if (seed.length !== 1 || expansion.length !== 1 || rows.some(({ role }) => role !== 'database_admin')) {
    throw new AcademicExpansionError('Both exact Hostinger demo seed markers and their database-admin owners are required.');
  }
}

async function requireOwnedSeedRecords(connection, plan) {
  const baselineRows = await readRows(connection,
    `SELECT student.id AS student_id, student.user_id, student.student_no, student.lrn, student.first_name,
        student.middle_name, student.last_name, student.suffix, student.birth_date, student.sex, student.address,
        term.id AS term_id, section.id AS section_id, subject.id AS subject_id, assignment.id AS assignment_id,
        assignment.teacher_id AS baseline_teacher_id,
        student_account.role AS student_role, student_account.is_active AS student_account_active
      FROM students AS student
      INNER JOIN users AS student_account ON student_account.id = student.user_id AND student_account.role = 'student'
      INNER JOIN academic_terms AS term ON term.school_year = ? AND term.term = 'Term 1'
      INNER JOIN sections AS section ON section.academic_term_id = term.id AND section.name = 'Demo Hostinger Section A'
        AND section.grade_level = 'Grade 11'
      INNER JOIN subjects AS subject ON subject.subject_code = 'DEMO-HOSTINGER-ENG-001'
        AND subject.subject_name = 'Demo Communication Skills'
      INNER JOIN enrollments AS enrollment ON enrollment.student_id = student.id
        AND enrollment.academic_term_id = term.id AND enrollment.section_id = section.id
        AND enrollment.enrollment_status = 'enrolled'
      INNER JOIN teacher_assignments AS assignment ON assignment.academic_term_id = term.id
        AND assignment.section_id = section.id AND assignment.subject_id = subject.id AND assignment.is_active = 1
      WHERE student.student_no = ? AND student.lrn = ? AND student.status = 'active'`,
    [SCHOOL_YEAR, BASELINE_STUDENT_NO, BASELINE_LRN]);
  if (baselineRows.length !== 1 || baselineRows[0].student_role !== 'student'
    || Number(baselineRows[0].student_account_active) !== 1 || !baselineRows[0].user_id
    || baselineRows[0].first_name !== 'Demo' || baselineRows[0].middle_name != null
    || baselineRows[0].last_name !== 'Learner' || baselineRows[0].suffix != null
    || String(baselineRows[0].birth_date).slice(0, 10) !== '2008-01-15'
    || baselineRows[0].sex !== 'unspecified' || baselineRows[0].address !== 'Fictional demo record') {
    throw new AcademicExpansionError('The reserved one-student Hostinger seed record does not match its exact original ownership labels.');
  }
  const extensionRows = await readRows(connection,
    `SELECT id, user_id, student_no, lrn, first_name, middle_name, last_name, status FROM students
      WHERE student_no LIKE 'DEMO-HOSTINGER-%' AND student_no <> ? ORDER BY student_no`, [BASELINE_STUDENT_NO]);
  if (extensionRows.length !== EXPANSION_STUDENT_COUNT || extensionRows.some((row, index) => {
    const ordinal = index + 2;
    return row.student_no !== `DEMO-HOSTINGER-${String(ordinal).padStart(4, '0')}`
      || row.lrn !== String(999000000091 + ordinal - 1)
      || row.first_name !== 'Demo' || row.middle_name !== 'Sample'
      || row.last_name !== `Learner ${String(ordinal).padStart(3, '0')}`
      || row.user_id != null || row.status !== 'active';
  })) {
    throw new AcademicExpansionError('The 99 reserved expansion students do not match their exact original IDs and fixture labels.');
  }
  const staffRows = await readRows(connection,
    `SELECT profile.employee_no, user.id AS user_id, user.role, user.is_active,
        profile.first_name, profile.last_name
      FROM staff_profiles AS profile INNER JOIN users AS user ON user.id = profile.user_id
      WHERE profile.employee_no IN ('HDMO-ADMIN-001', 'HDMO-REG-001', 'HDMO-TEACH-001', 'HDMO-FIN-001')`);
  const staffByNo = new Map(staffRows.map((row) => [String(row.employee_no), row]));
  if (staffRows.length !== NORMALIZED_OLD_STAFF.length || NORMALIZED_OLD_STAFF.some((definition) => {
    const row = staffByNo.get(definition.employeeNo);
    const originalLastName = ({ 'HDMO-ADMIN-001': 'Administrator', 'HDMO-REG-001': 'Registrar',
      'HDMO-TEACH-001': 'Teacher', 'HDMO-FIN-001': 'Finance' })[definition.employeeNo];
    return !row || row.role !== definition.role || Number(row.is_active) !== 1 || !row.user_id
      || row.first_name !== 'Demo' || row.last_name !== originalLastName;
  })) throw new AcademicExpansionError('The four reserved staff profiles no longer match their original role ownership.');

  const terms = await readRows(connection,
    `SELECT term.id, term.term, mapping.term_number FROM academic_terms AS term
      LEFT JOIN school_year_term_order AS mapping ON mapping.academic_term_id = term.id
      WHERE term.school_year = ? ORDER BY mapping.term_number, term.id`, [SCHOOL_YEAR]);
  const termByNumber = new Map(terms.map((row) => [Number(row.term_number), row]));
  if (terms.length !== 3 || [1, 2, 3].some((number) => termByNumber.get(number)?.term !== `Term ${number}`)) {
    throw new AcademicExpansionError('The populated 2026–2027 fixture context requires its explicit three-term order.');
  }
  const termIds = new Map([...termByNumber.entries()].map(([number, row]) => [number, Number(row.id)]));
  const extensionSections = await readRows(connection,
    `SELECT section.id, section.name, section.grade_level, section.academic_term_id,
        term.term, term.school_year, section.strand
      FROM sections AS section INNER JOIN academic_terms AS term ON term.id = section.academic_term_id
      WHERE term.school_year = ? AND section.name LIKE 'Demo Hostinger Grade %' ORDER BY term.id, section.grade_level, section.name`,
    [SCHOOL_YEAR]);
  if (extensionSections.length !== 12) throw new AcademicExpansionError('The 12 reserved term sections do not match their original expansion ownership.');
  const sectionsByKey = new Map();
  for (const row of extensionSections) {
    const match = /^Demo Hostinger (Grade 11|Grade 12) ([AB])$/.exec(row.name);
    const termNumber = Number((terms.find((term) => Number(term.id) === Number(row.academic_term_id)) || {}).term_number);
    if (!match || !termIds.has(termNumber) || row.school_year !== SCHOOL_YEAR
      || row.grade_level !== match[1]) throw new AcademicExpansionError('A reserved term section no longer matches its exact original seed context.');
    const key = `${termNumber}:${match[1]}:${match[2]}`;
    if (sectionsByKey.has(key)) throw new AcademicExpansionError('A reserved term section context is ambiguous.');
    sectionsByKey.set(key, Number(row.id));
  }
  if (sectionsByKey.size !== 12) throw new AcademicExpansionError('A reserved term section is missing.');

  const subjectCodes = NORMALIZED_OLD_SUBJECTS.map(({ oldCode }) => oldCode);
  const oldSubjects = await readRows(connection,
    `SELECT id, subject_code, subject_name FROM subjects WHERE subject_code IN (${placeholders(subjectCodes.length)})`, subjectCodes);
  if (oldSubjects.length !== NORMALIZED_OLD_SUBJECTS.length || NORMALIZED_OLD_SUBJECTS.some((expected) => {
    const actual = oldSubjects.find(({ subject_code }) => subject_code === expected.oldCode);
    return !actual || actual.subject_name !== expected.oldName;
  })) throw new AcademicExpansionError('The four reserved expansion subjects no longer match their original labels.');
  const baselineSubject = await readRows(connection,
    `SELECT id, subject_code, subject_name FROM subjects WHERE subject_code = 'DEMO-HOSTINGER-ENG-001'`);
  if (baselineSubject.length !== 1 || baselineSubject[0].subject_name !== 'Demo Communication Skills'
    || Number(baselineSubject[0].id) !== Number(baselineRows[0].subject_id)) {
    throw new AcademicExpansionError('The reserved baseline subject no longer matches its exact original labels.');
  }
  const baselineSection = { termNumber: 1, gradeLevel: 'Grade 11', suffix: 'A', id: Number(baselineRows[0].section_id) };
  if (Number(baselineRows[0].term_id) !== termIds.get(1)) throw new AcademicExpansionError('The baseline section is no longer in the reserved 2026–2027 Term 1 context.');

  const oldSubjectIds = new Map(oldSubjects.map((row) => [row.subject_code, Number(row.id)]));
  const teacherId = Number(staffByNo.get('HDMO-TEACH-001').user_id);
  const assignmentRows = await readRows(connection,
    `SELECT assignment.id, assignment.academic_term_id, assignment.section_id, assignment.subject_id,
        assignment.teacher_id, assignment.is_active, section.grade_level, section.name
      FROM teacher_assignments AS assignment
      INNER JOIN sections AS section ON section.id = assignment.section_id
      WHERE assignment.teacher_id = ? AND assignment.is_active = 1
        AND assignment.section_id IN (${placeholders(extensionSections.length)})
        AND assignment.subject_id IN (${placeholders(oldSubjectIds.size)})`,
    [teacherId, ...extensionSections.map(({ id }) => Number(id)), ...oldSubjectIds.values()]);
  const subjectGradeById = new Map(NORMALIZED_OLD_SUBJECTS.map((subject) => [
    Number(oldSubjectIds.get(subject.oldCode)), subject.oldCode.startsWith('DEMO-HOSTINGER-G11-') ? 'Grade 11' : 'Grade 12'
  ]));
  const expectedAssignmentKeys = new Set();
  for (let termNumber = 1; termNumber <= 3; termNumber += 1) {
    for (const gradeLevel of ['Grade 11', 'Grade 12']) {
      for (const suffix of ['A', 'B']) {
        const sectionId = sectionsByKey.get(`${termNumber}:${gradeLevel}:${suffix}`);
        for (const subject of NORMALIZED_OLD_SUBJECTS.filter((item) => subjectGradeById.get(oldSubjectIds.get(item.oldCode)) === gradeLevel)) {
          expectedAssignmentKeys.add(`${termIds.get(termNumber)}:${sectionId}:${oldSubjectIds.get(subject.oldCode)}`);
        }
      }
    }
  }
  const actualAssignmentKeys = new Set(assignmentRows.map((row) => `${Number(row.academic_term_id)}:${Number(row.section_id)}:${Number(row.subject_id)}`));
  if (assignmentRows.length !== 24 || assignmentRows.some((row) => Number(row.teacher_id) !== teacherId
      || Number(row.is_active) !== 1 || !expectedAssignmentKeys.has(`${Number(row.academic_term_id)}:${Number(row.section_id)}:${Number(row.subject_id)}`))
    || expectedAssignmentKeys.size !== 24 || actualAssignmentKeys.size !== 24
    || [...expectedAssignmentKeys].some((key) => !actualAssignmentKeys.has(key))) {
    throw new AcademicExpansionError('The 24 reserved teacher assignments do not match the original expansion contexts.');
  }
  if (Number(baselineRows[0].baseline_teacher_id) !== teacherId) {
    throw new AcademicExpansionError('The reserved baseline assignment no longer belongs to its original teacher account.');
  }
  const submissionRows = await readRows(connection,
    `SELECT id FROM teacher_grade_submissions WHERE assignment_id IN (${placeholders(assignmentRows.length)})`,
    assignmentRows.map(({ id }) => Number(id)));
  if (submissionRows.length) throw new AcademicExpansionError('Reserved legacy assignments already have workbook submissions; their records will not be rewritten.');
  return {
    adminId: Number(staffByNo.get('HDMO-ADMIN-001').user_id),
    registrarId: Number(staffByNo.get('HDMO-REG-001').user_id),
    baselineTeacherId: teacherId,
    baselineStudentId: Number(baselineRows[0].student_id),
    baselineSectionId: Number(baselineRows[0].section_id),
    baselineSubjectId: Number(baselineRows[0].subject_id),
    terms: termIds,
    sections: sectionsByKey,
    baselineSection,
    oldSubjects: oldSubjectIds,
    staff: staffByNo,
    extensionAssignmentRows: assignmentRows
  };
}

function makeEmailAlias(baseEmail, alias) {
  const at = baseEmail.lastIndexOf('@');
  if (at < 1 || at === baseEmail.length - 1) throw new AcademicExpansionError('The seeded teacher contact email is not a valid alias base.');
  const local = baseEmail.slice(0, at).replace(/\+.*/, '');
  const email = `${local}+${alias}@${baseEmail.slice(at + 1)}`.toLowerCase();
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AcademicExpansionError('A generated teacher email alias is invalid.');
  return email;
}

async function requireNoReservedCollisions(connection, plan, owners) {
  const studentKeys = plan.newStudents.flatMap(({ studentNo, lrn }) => [studentNo, lrn]);
  const collision = await readRows(connection,
    `SELECT id FROM students WHERE student_no IN (${placeholders(plan.newStudents.length)})
      OR lrn IN (${placeholders(plan.newStudents.length)}) LIMIT 1`,
    [...plan.newStudents.map(({ studentNo }) => studentNo), ...plan.newStudents.map(({ lrn }) => lrn)]);
  if (collision.length || new Set(studentKeys).size !== studentKeys.length) throw new AcademicExpansionError('A reserved academic student number or LRN is already in use.');
  const employeeNos = plan.newTeachers.map(({ employeeNo }) => employeeNo);
  const employeeCollision = await readRows(connection,
    `SELECT user_id FROM staff_profiles WHERE employee_no IN (${placeholders(employeeNos.length)})`, employeeNos);
  if (employeeCollision.length) throw new AcademicExpansionError('A reserved academic teacher employee number is already in use.');

  const targetSections = plan.normalizedSections;
  const sectionCollision = await readRows(connection,
    `SELECT section.id FROM sections AS section INNER JOIN academic_terms AS term ON term.id = section.academic_term_id
      WHERE term.school_year = ? AND section.name IN (${placeholders(targetSections.length)})
        AND section.id NOT IN (${placeholders(targetSections.length)}) LIMIT 1`,
    [SCHOOL_YEAR, ...targetSections.map(({ newName }) => newName), owners.baselineSectionId,
      ...[...owners.sections.values()]]);
  if (sectionCollision.length) throw new AcademicExpansionError('A normal section title is already used by an unrelated section in the target year.');

  const targetCodes = [...NORMALIZED_OLD_SUBJECTS.map(({ newCode }) => newCode), 'CS-11', ...NEW_SUBJECTS.map(({ code }) => code)];
  const ownedSubjectIds = [...owners.oldSubjects.values()];
  const subjectCollision = await readRows(connection,
    `SELECT id FROM subjects WHERE subject_code IN (${placeholders(targetCodes.length)})
      AND id NOT IN (${placeholders(ownedSubjectIds.length)}) LIMIT 1`, [...targetCodes, ...ownedSubjectIds]);
  if (subjectCollision.length) throw new AcademicExpansionError('A normal subject code is already used by an unrelated subject.');

  const seededTeacher = owners.staff.get('HDMO-TEACH-001');
  const baseEmailRows = await readRows(connection, 'SELECT email FROM users WHERE id = ?', [Number(seededTeacher.user_id)]);
  const baseEmail = baseEmailRows[0]?.email;
  if (!baseEmail) throw new AcademicExpansionError('The reserved teacher account has no email alias base.');
  const emails = plan.newTeachers.map((teacher) => makeEmailAlias(baseEmail, teacher.emailKey));
  const emailCollision = await readRows(connection,
    `SELECT id FROM users WHERE email IN (${placeholders(emails.length)}) LIMIT 1`, emails);
  if (emailCollision.length || new Set(emails).size !== emails.length) throw new AcademicExpansionError('A generated teacher email alias is already in use.');
  const pendingEmailCollision = await readRows(connection,
    `SELECT id FROM pending_email_changes WHERE new_email IN (${placeholders(emails.length)})
      AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6) LIMIT 1`, emails);
  if (pendingEmailCollision.length) throw new AcademicExpansionError('A generated teacher email alias is reserved by a pending address change.');
  const selectedTerm = await readRows(connection,
    `SELECT id FROM academic_terms WHERE school_year = ? AND term = ?`, [SCHOOL_YEAR, CURRENT_TERM]);
  if (selectedTerm.length !== 1 || Number(selectedTerm[0].id) !== owners.terms.get(2)) {
    throw new AcademicExpansionError('The current academic target must be the explicitly mapped 2026–2027 Term 2.');
  }
  return { emails, baseEmail };
}

function timeMinutes(value) {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function chooseScheduleSlots(assignments, existingSchedules) {
  const occupied = existingSchedules.map((row) => ({
    day: Number(row.day_of_week), start: timeMinutes(row.start_time), end: timeMinutes(row.end_time)
  }));
  const choices = [];
  for (let day = 1; day <= 6 && choices.length < assignments.length; day += 1) {
    for (let hour = 7; hour < 19 && choices.length < assignments.length; hour += 1) {
      const start = hour * 60;
      const end = start + 60;
      if (occupied.some((row) => row.day === day && row.start !== null && row.end !== null
        && start < row.end && end > row.start)) continue;
      const slot = { day, start, end };
      occupied.push(slot);
      choices.push(slot);
    }
  }
  if (choices.length !== assignments.length) throw new AcademicExpansionError('There are not enough unused weekly schedule slots for the academic fixtures.');
  const format = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
  return assignments.map((assignment, index) => ({
    ...assignment,
    dayOfWeek: choices[index].day,
    startTime: format(choices[index].start),
    endTime: format(choices[index].end),
    room: `Learning Center Room ${String(index + 1).padStart(2, '0')}`
  }));
}

function buildAcademicAssignments(owners, newTeachers) {
  const teacherByCode = new Map(newTeachers.map((teacher) => [teacher.subjectCode, teacher]));
  const assignments = [];
  for (let termNumber = 1; termNumber <= 3; termNumber += 1) {
    for (const gradeLevel of ['Grade 11', 'Grade 12']) {
      for (const suffix of ['A', 'B']) {
        const sectionId = owners.sections.get(`${termNumber}:${gradeLevel}:${suffix}`);
        for (const subject of NEW_SUBJECTS.filter((item) => item.gradeLevel === gradeLevel)) {
          assignments.push({ termNumber, termId: owners.terms.get(termNumber), gradeLevel, suffix, sectionId,
            subjectCode: subject.code, subjectName: subject.name, teacher: teacherByCode.get(subject.code) });
        }
      }
    }
  }
  return assignments;
}

function gradeValues(ordinal, subjectIndex) {
  const offset = (ordinal * 7 + subjectIndex * 5) % 18;
  const first = 78 + offset;
  const second = Math.min(99, first + ((ordinal + subjectIndex) % 3));
  const third = Math.max(75, first - ((ordinal + subjectIndex) % 3));
  return [first, second, third, Math.round((first + second + third) / 3)];
}

function buildWorkbooks(plan) {
  const workbooks = [];
  for (const subject of NEW_SUBJECTS) {
    for (const suffix of ['A', 'B']) {
      const students = plan.newStudents.filter(({ gradeLevel, suffixSection }) => gradeLevel === subject.gradeLevel && suffixSection === suffix)
        .map((student) => ({ ...student, grades: gradeValues(student.ordinal, NEW_SUBJECTS.indexOf(subject)) }));
      const built = buildWorkbook({ gradeLevel: subject.gradeLevel, sectionName: sectionName(subject.gradeLevel, suffix),
        subjectName: subject.name, students });
      workbooks.push({ subject, suffix, students, ...built });
    }
  }
  return workbooks;
}

async function requirePrivateStorage(storageDirectory, { create = false } = {}) {
  if (typeof storageDirectory !== 'string' || !path.isAbsolute(storageDirectory)) {
    throw new AcademicExpansionError('Private academic fixtures require an absolute DOCUMENT_STORAGE_DIR.');
  }
  const configuredRoot = path.resolve(storageDirectory);
  const root = path.resolve(__dirname, '..');
  const assertPrivateLocation = (resolvedPath) => {
    const relative = path.relative(root, resolvedPath);
    const insideProject = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    const parts = resolvedPath.split(path.sep).map((part) => part.toLowerCase());
    if (insideProject || parts.includes('hbuilds') || parts.includes('public_html')) {
      throw new AcademicExpansionError('Academic fixture storage must resolve outside Hostinger public/build paths.');
    }
  };
  let existingAncestor = configuredRoot;
  let ancestorStats;
  while (true) {
    try {
      ancestorStats = await fs.lstat(existingAncestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || existingAncestor === path.dirname(existingAncestor)) throw error;
      existingAncestor = path.dirname(existingAncestor);
    }
  }
  if (!ancestorStats.isDirectory() && !ancestorStats.isSymbolicLink()) {
    throw new AcademicExpansionError('The private storage path crosses a non-directory filesystem entry.');
  }
  const realAncestor = await fs.realpath(existingAncestor);
  const missingTail = path.relative(existingAncestor, configuredRoot);
  const expectedRoot = path.resolve(realAncestor, missingTail);
  assertPrivateLocation(expectedRoot);
  if (!create && existingAncestor !== configuredRoot) {
    throw new AcademicExpansionError('The configured private storage directory must exist before an idempotency check.');
  }
  if (create && existingAncestor !== configuredRoot) {
    await fs.mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  }
  const rootStats = await fs.lstat(configuredRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new AcademicExpansionError('DOCUMENT_STORAGE_DIR must be a real private directory, not a symlink or file.');
  }
  const realRoot = await fs.realpath(configuredRoot);
  assertPrivateLocation(realRoot);
  if (realRoot !== expectedRoot) throw new AcademicExpansionError('The configured private directory resolved differently during setup.');
  if (!create && (rootStats.mode & 0o077) !== 0) {
    throw new AcademicExpansionError('The configured private storage directory must not be accessible to group or other users.');
  }
  if (create) await fs.chmod(realRoot, 0o700);
  const directory = path.join(realRoot, 'teacher-grade-submissions');
  let directoryStats;
  try { directoryStats = await fs.lstat(directory); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await fs.mkdir(directory, { mode: 0o700 });
    directoryStats = await fs.lstat(directory);
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new AcademicExpansionError('The private teacher-workbook path must be a real directory, not a symlink or file.');
  }
  if (!create && (directoryStats.mode & 0o077) !== 0) {
    throw new AcademicExpansionError('The private teacher-workbook directory must not be accessible to group or other users.');
  }
  const realDirectory = await fs.realpath(directory);
  assertPrivateLocation(realDirectory);
  if (realDirectory !== path.join(realRoot, 'teacher-grade-submissions')) {
    throw new AcademicExpansionError('The private teacher-workbook directory does not match its configured path.');
  }
  if (create) await fs.chmod(realDirectory, 0o700);
  const credentialsPath = path.join(realRoot, 'academic-fixture-teacher-credentials.json');
  try {
    const credentialsStats = await fs.lstat(credentialsPath);
    if (!credentialsStats.isFile() || credentialsStats.isSymbolicLink()) {
      throw new AcademicExpansionError('The private teacher credential artifact path must be a regular file.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { directory: realDirectory, rootDirectory: realRoot, credentialsPath };
}

async function writePrivateFile(filePath, bytes, createdFiles) {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new AcademicExpansionError('A reserved private academic fixture path is not a regular file.');
    if ((stats.mode & 0o777) !== 0o600) throw new AcademicExpansionError('Existing private academic fixture files must have mode 600.');
    const existing = await fs.readFile(filePath);
    if (!existing.equals(bytes)) throw new AcademicExpansionError('A reserved private academic fixture file already exists with different contents.');
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
  createdFiles.push(filePath);
  await fs.chmod(filePath, 0o600);
  return true;
}

async function rollbackExpansionAttempt(connection, { started, commitAttempted, createdFiles }) {
  if (!started) return { destroyConnection: false };
  try {
    await connection.rollback();
    if (!commitAttempted) await Promise.all(createdFiles.map((filePath) => fs.unlink(filePath).catch(() => {})));
    return { destroyConnection: false };
  } catch {
    return { destroyConnection: true };
  }
}

function discardUncertainConnection(connection) {
  if (typeof connection?.destroy === 'function') {
    try { connection.destroy(); } catch { /* The connection must not reenter the pool. */ }
  }
}

async function prepareTeacherCredentials(storage, teachers, emails, createdFiles) {
  let credentials;
  try {
    const stats = await fs.lstat(storage.credentialsPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new AcademicExpansionError('The private teacher credential artifact must be a regular file.');
    if ((stats.mode & 0o777) !== 0o600) throw new AcademicExpansionError('The private teacher credential artifact must have mode 600.');
    credentials = JSON.parse(await fs.readFile(storage.credentialsPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (credentials) {
    if (credentials.marker !== ACADEMIC_MARKER || !Array.isArray(credentials.accounts)
      || credentials.accounts.length !== teachers.length || teachers.some((teacher, index) => {
        const account = credentials.accounts[index];
        return account?.employeeNo !== teacher.employeeNo || account?.email !== emails[index]
          || typeof account?.password !== 'string' || account.password.length < 32;
      })) throw new AcademicExpansionError('The existing private teacher credential artifact does not match this fixture marker.');
    return Promise.all(credentials.accounts.map(async (account) => ({ ...account,
      passwordHash: await bcrypt.hash(account.password, PASSWORD_ROUNDS) })));
  }
  const accounts = teachers.map((teacher, index) => ({
    employeeNo: teacher.employeeNo, email: emails[index], password: crypto.randomBytes(32).toString('base64url')
  }));
  const artifact = Buffer.from(`${JSON.stringify({ marker: ACADEMIC_MARKER, accounts }, null, 2)}\n`, 'utf8');
  await writePrivateFile(storage.credentialsPath, artifact, createdFiles);
  return Promise.all(accounts.map(async (account) => ({ ...account,
    passwordHash: await bcrypt.hash(account.password, PASSWORD_ROUNDS) })));
}

async function prepareWorkbookFiles(storage, workbooks, createdFiles) {
  const metadata = [];
  for (const workbook of workbooks) {
    const storageKey = stableUuid(`workbook:${workbook.subject.code}:${workbook.suffix}`);
    const filePath = path.join(storage.directory, `${storageKey}.xlsx`);
    await writePrivateFile(filePath, workbook.buffer, createdFiles);
    const storedBytes = await fs.readFile(filePath);
    if (!storedBytes.equals(workbook.buffer)) throw new AcademicExpansionError('A private workbook source changed while it was being prepared.');
    const parsed = await parseWorkbook(storedBytes);
    if (parsed.rows.length !== 30 || parsed.rows.some(({ issue }) => issue)
      || parsed.context.schoolYear !== SCHOOL_YEAR
      || parsed.context.gradeLevel !== workbook.subject.gradeLevel.replace(/^Grade\s+/i, '')
      || parsed.context.sectionName !== sectionName(workbook.subject.gradeLevel, workbook.suffix)
      || parsed.context.subjectName !== workbook.subject.name) {
      throw new AcademicExpansionError('A generated source workbook does not match its teacher class roster and grade-import context.');
    }
    metadata.push({ ...workbook, storageKey, filePath, sha256: sha256(workbook.buffer), byteLength: workbook.buffer.length, parsed });
  }
  return metadata;
}

async function findExistingMarker(connection) {
  const rows = await readRows(connection,
    `SELECT id, details_json FROM audit_logs WHERE entity_type = 'academic_fixture_expansion' AND entity_id = ?`, [ACADEMIC_MARKER]);
  if (rows.length > 1) throw new AcademicExpansionError('The academic expansion marker is duplicated; no changes were made.');
  return rows[0] || null;
}

async function verifyAlreadyApplied(connection, markerRow, configuration, counts, logger) {
  let details;
  try { details = JSON.parse(markerRow.details_json); }
  catch { throw new AcademicExpansionError('The existing academic expansion marker could not be verified.'); }
  if (details.marker !== ACADEMIC_MARKER || details.schoolYear !== SCHOOL_YEAR
    || !Array.isArray(details.submissions) || details.submissions.length !== counts.pendingReviewSubmissions) {
    throw new AcademicExpansionError('The existing academic expansion marker has an unexpected ownership manifest.');
  }
  const studentCount = await readRows(connection,
    'SELECT COUNT(*) AS count FROM students WHERE student_no LIKE ?', [`ACADEMIC-${SCHOOL_YEAR.slice(0, 4)}-%`]);
  if (Number(studentCount[0]?.count) !== NEW_STUDENT_COUNT) throw new AcademicExpansionError('The marker-owned academic roster is incomplete.');
  const submissions = await readRows(connection,
    `SELECT id, storage_key, original_filename, file_size_bytes FROM teacher_grade_submissions
      WHERE id IN (${placeholders(details.submissions.length)})`, details.submissions.map(({ id }) => id));
  if (submissions.length !== details.submissions.length) throw new AcademicExpansionError('One or more marker-owned review submissions are missing.');
  const storage = await requirePrivateStorage(configuration.upload.storageDirectory);
  const manifestIds = new Set();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const detail of details.submissions) {
    if (!detail || !uuidPattern.test(String(detail.id)) || !uuidPattern.test(String(detail.storageKey))
      || typeof detail.filename !== 'string' || detail.filename !== path.basename(detail.filename)
      || !detail.filename.endsWith('.xlsx') || /[\\/]/.test(detail.filename) || /demo/i.test(detail.filename)
      || !Number.isSafeInteger(Number(detail.byteLength)) || Number(detail.byteLength) <= 0
      || !/^[a-f0-9]{64}$/i.test(String(detail.sha256)) || manifestIds.has(String(detail.id).toLowerCase())) {
      throw new AcademicExpansionError('The academic expansion source manifest contains an unsafe or invalid private-file reference.');
    }
    manifestIds.add(String(detail.id).toLowerCase());
  }
  for (const detail of details.submissions) {
    const row = submissions.find(({ id }) => String(id).toLowerCase() === String(detail.id).toLowerCase());
    if (!row || row.storage_key !== detail.storageKey || row.original_filename !== detail.filename
      || Number(row.file_size_bytes) !== Number(detail.byteLength)) throw new AcademicExpansionError('A marker-owned review submission no longer matches its private workbook.');
    const sourcePath = path.join(storage.directory, `${detail.storageKey}.xlsx`);
    const sourceStats = await fs.lstat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || (sourceStats.mode & 0o777) !== 0o600) {
      throw new AcademicExpansionError('A marker-owned private workbook is not a mode-600 regular file.');
    }
    const bytes = await fs.readFile(sourcePath);
    if (sha256(bytes) !== detail.sha256) throw new AcademicExpansionError('A marker-owned private workbook is missing or has changed.');
  }
  logger.log(JSON.stringify({ mode: 'already-applied', database: configuration.database.database, counts }));
  return { mode: 'already-applied', counts };
}

async function seedAcademicFixtures({ options = parseOptions(process.argv.slice(2)), configuration = environment,
  getDatabasePool = getPool, closeDatabasePool = closePool, logger = console, today = new Date() } = {}) {
  validateProductionTarget(configuration);
  if (!options || !['dry-run', 'apply'].includes(options.mode)
    || options.targetDatabase !== configuration.database.database
    || options.confirmDatabase !== configuration.database.database || options.seedMarker !== EXPANSION_MARKER) {
    throw new AcademicExpansionError('Confirm the exact configured Hostinger database and expansion marker before continuing.');
  }
  if (options.mode === 'apply' && !options.acknowledged) throw new AcademicExpansionError('Apply requires the explicit production acknowledgement.');
  if (options.mode === 'dry-run' && options.acknowledged) throw new AcademicExpansionError('Dry run cannot include the production acknowledgement.');
  if (options.mode === 'apply') validateHostApplyTarget(configuration);
  const plan = buildPlan({ today });
  const workbooks = buildWorkbooks(plan);
  const pool = await getDatabasePool();
  let connection;
  let locked = false;
  let started = false;
  let commitAttempted = false;
  let destroyConnection = false;
  const createdFiles = [];
  try {
    connection = await pool.source.getConnection();
    await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
    if (options.mode === 'apply') {
      const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 20) AS acquired', [APPLICATION_LOCK]);
      if (Number(lockRows[0]?.acquired) !== 1) throw new AcademicExpansionError('Could not acquire the one-time academic fixture expansion lock.');
      locked = true;
      await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await connection.beginTransaction();
      started = true;
    }

    await requireExpectedSchema(connection);
    const priorMarker = await findExistingMarker(connection);
    if (priorMarker) {
      if (started) {
        await connection.rollback();
        started = false;
      }
      if (options.mode === 'dry-run') {
        logger.log(JSON.stringify({ mode: 'already-applied', database: options.targetDatabase, counts: plan.counts }));
        return { mode: 'already-applied', counts: plan.counts };
      }
      return await verifyAlreadyApplied(connection, priorMarker, configuration, plan.counts, logger);
    }
    await requireMarkers(connection);
    const owners = await requireOwnedSeedRecords(connection, plan);
    const reserved = await requireNoReservedCollisions(connection, plan, owners);
    const assignments = buildAcademicAssignments(owners, plan.newTeachers);
    const existingSchedules = await readRows(connection,
      `SELECT schedule.day_of_week, schedule.start_time, schedule.end_time FROM class_schedules AS schedule
        INNER JOIN teacher_assignments AS assignment ON assignment.id = schedule.assignment_id`);
    const scheduleRows = chooseScheduleSlots(assignments, existingSchedules);

    if (options.mode === 'dry-run') {
      const currentTerms = await readRows(connection,
        'SELECT id, school_year, term FROM academic_terms WHERE is_current = 1 ORDER BY id');
      if (currentTerms.length !== 1) throw new AcademicExpansionError('Exactly one current academic term is required before expansion.');
      logger.log(JSON.stringify({ mode: 'dry-run', database: options.targetDatabase, counts: plan.counts,
        currentTermChange: { from: `${currentTerms[0].school_year} ${currentTerms[0].term}`,
          fromTermId: Number(currentTerms[0].id), to: plan.counts.currentTermAfter,
          toTermId: owners.terms.get(2) },
        storageFilesRequireHostApply: true }));
      return { mode: 'dry-run', counts: plan.counts };
    }

    const currentTerms = await readRows(connection,
      'SELECT id, school_year, term FROM academic_terms WHERE is_current = 1 FOR UPDATE');
    if (currentTerms.length !== 1) throw new AcademicExpansionError('Exactly one current academic term is required before expansion.');
    const previousCurrentTerm = { id: Number(currentTerms[0].id), schoolYear: currentTerms[0].school_year, term: currentTerms[0].term };

    const storage = await requirePrivateStorage(configuration.upload.storageDirectory, { create: true });
    const credentials = await prepareTeacherCredentials(storage, plan.newTeachers, reserved.emails, createdFiles);
    const workbookFiles = await prepareWorkbookFiles(storage, workbooks, createdFiles);

    const baselineAndExpansionStudents = plan.normalizedStudents;
    for (const part of chunk(baselineAndExpansionStudents)) {
      await connection.execute(`UPDATE students SET student_no = CASE student_no ${part.map(() => 'WHEN ? THEN ?').join(' ')} ELSE student_no END,
          first_name = CASE student_no ${part.map(() => 'WHEN ? THEN ?').join(' ')} ELSE first_name END,
          middle_name = CASE student_no ${part.map(() => 'WHEN ? THEN ?').join(' ')} ELSE middle_name END,
          last_name = CASE student_no ${part.map(() => 'WHEN ? THEN ?').join(' ')} ELSE last_name END
        WHERE student_no IN (${placeholders(part.length)})`, [
        ...part.flatMap((row) => [row.studentNo, row.studentNo]),
        ...part.flatMap((row) => [row.studentNo, row.firstName]),
        ...part.flatMap((row) => [row.studentNo, row.middleName]),
        ...part.flatMap((row) => [row.studentNo, row.lastName]),
        ...part.map(({ studentNo }) => studentNo)
      ]);
    }
    for (const staff of NORMALIZED_OLD_STAFF) {
      await connection.execute(`UPDATE staff_profiles AS profile
        INNER JOIN users AS user ON user.id = profile.user_id
        SET profile.first_name = ?, profile.last_name = ?
        WHERE profile.employee_no = ? AND user.role = ?`,
      [staff.firstName, staff.lastName, staff.employeeNo, staff.role]);
    }
    const sectionRenames = plan.normalizedSections;
    for (const rename of sectionRenames) {
      const sectionId = rename.baseline ? owners.baselineSectionId
        : owners.sections.get(`${rename.termNumber}:${rename.gradeLevel}:${rename.suffix}`);
      await connection.execute('UPDATE sections SET name = ? WHERE id = ? AND name = ?',
        [rename.newName, sectionId, rename.oldName]);
    }
    const baselineSubjectId = owners.baselineSubjectId;
    await connection.execute('UPDATE subjects SET subject_code = ?, subject_name = ? WHERE id = ? AND subject_code = ? AND subject_name = ?',
      ['CS-11', 'Communication Skills', baselineSubjectId, 'DEMO-HOSTINGER-ENG-001', 'Demo Communication Skills']);
    for (const subject of NORMALIZED_OLD_SUBJECTS) {
      await connection.execute('UPDATE subjects SET subject_code = ?, subject_name = ? WHERE id = ? AND subject_code = ? AND subject_name = ?',
        [subject.newCode, subject.newName, owners.oldSubjects.get(subject.oldCode), subject.oldCode, subject.oldName]);
    }

    const userRows = [];
    for (let index = 0; index < plan.newTeachers.length; index += 1) {
      const teacher = plan.newTeachers[index];
      const credential = credentials.find(({ employeeNo }) => employeeNo === teacher.employeeNo);
      if (!credential) throw new AcademicExpansionError('A generated teacher credential is missing from the private artifact.');
      userRows.push({ email: credential.email, password_hash: credential.passwordHash, role: 'teacher', is_active: 1, must_change_password: 1 });
    }
    await insertMany(connection, 'users', ['email', 'password_hash', 'role', 'is_active', 'must_change_password'], userRows);
    const userEmails = reserved.emails;
    const teacherAccountRows = await readRows(connection,
      `SELECT id, email FROM users WHERE email IN (${placeholders(userEmails.length)})`, userEmails);
    const accountByEmail = new Map(teacherAccountRows.map(({ id, email }) => [email, Number(id)]));
    if (accountByEmail.size !== NEW_TEACHER_COUNT) throw new AcademicExpansionError('The four academic teacher accounts could not be verified after insert.');
    await insertMany(connection, 'staff_profiles', ['user_id', 'employee_no', 'first_name', 'last_name', 'department'],
      plan.newTeachers.map((teacher, index) => ({ user_id: accountByEmail.get(userEmails[index]), employee_no: teacher.employeeNo,
        first_name: teacher.firstName, last_name: teacher.lastName, department: 'Academic' })));

    await insertMany(connection, 'subjects', ['subject_code', 'subject_name', 'units'],
      NEW_SUBJECTS.map((subject) => ({ subject_code: subject.code, subject_name: subject.name, units: subject.units })));
    const newSubjectRows = await readRows(connection,
      `SELECT id, subject_code, subject_name FROM subjects WHERE subject_code IN (${placeholders(NEW_SUBJECTS.length)})`,
      NEW_SUBJECTS.map(({ code }) => code));
    const newSubjectIds = new Map(newSubjectRows.map((row) => [String(row.subject_code), Number(row.id)]));
    if (newSubjectIds.size !== NEW_SUBJECTS.length) throw new AcademicExpansionError('The academic subject catalog could not be verified after insert.');

    await insertMany(connection, 'students', ['student_no', 'lrn', 'first_name', 'middle_name', 'last_name', 'birth_date', 'sex', 'address', 'phone', 'status'],
      plan.newStudents.map((student) => ({ student_no: student.studentNo, lrn: student.lrn,
        first_name: student.firstName, middle_name: student.middleName, last_name: student.lastName,
        birth_date: student.birthDate, sex: student.sex, address: student.address, phone: student.phone, status: 'active' })));
    const insertedStudents = await readRows(connection,
      `SELECT id, student_no, lrn, first_name, last_name FROM students WHERE student_no IN (${placeholders(plan.newStudents.length)})`,
      plan.newStudents.map(({ studentNo }) => studentNo));
    const studentsByNo = new Map(insertedStudents.map((row) => [String(row.student_no), { ...row, id: Number(row.id) }]));
    if (studentsByNo.size !== NEW_STUDENT_COUNT) throw new AcademicExpansionError('The 120 academic students could not be verified after insert.');

    const assignmentRowsToInsert = assignments.map((assignment) => ({
      teacher_id: accountByEmail.get(reserved.emails[plan.newTeachers.findIndex(({ employeeNo }) => employeeNo === assignment.teacher.employeeNo)]),
      academic_term_id: assignment.termId, section_id: assignment.sectionId,
      subject_id: newSubjectIds.get(assignment.subjectCode), assigned_by: owners.adminId
    }));
    await insertMany(connection, 'teacher_assignments', ['teacher_id', 'academic_term_id', 'section_id', 'subject_id', 'assigned_by'], assignmentRowsToInsert);
    const persistedAssignments = await readRows(connection,
      `SELECT id, teacher_id, academic_term_id, section_id, subject_id FROM teacher_assignments
        WHERE section_id IN (${placeholders(owners.sections.size)}) AND subject_id IN (${placeholders(NEW_SUBJECTS.length)}) AND is_active = 1`,
      [...owners.sections.values(), ...newSubjectIds.values()]);
    const assignmentByContext = new Map(persistedAssignments.map((row) =>
      [`${Number(row.academic_term_id)}:${Number(row.section_id)}:${Number(row.subject_id)}`, Number(row.id)]));
    if (assignmentByContext.size !== 24) throw new AcademicExpansionError('The 24 active academic class assignments could not be verified.');

    const enrollmentRowsToInsert = plan.newStudents.map((student) => ({
      student_id: studentsByNo.get(student.studentNo).id,
      academic_term_id: owners.terms.get(2),
      section_id: owners.sections.get(`2:${student.gradeLevel}:${student.suffixSection}`),
      enrollment_status: 'enrolled', finalized_at: null,
      annual_enrollment_id: null, annual_term_number: null, term_scope_status: 'applicable'
    }));
    await insertMany(connection, 'enrollments', ['student_id', 'academic_term_id', 'section_id', 'enrollment_status',
      'finalized_at', 'annual_enrollment_id', 'annual_term_number', 'term_scope_status'], enrollmentRowsToInsert);
    const enrollmentRows = await readRows(connection,
      `SELECT id, student_id, section_id FROM enrollments WHERE academic_term_id = ?
        AND student_id IN (${placeholders(NEW_STUDENT_COUNT)})`,
      [owners.terms.get(2), ...insertedStudents.map(({ id }) => Number(id))]);
    const enrollmentByStudent = new Map(enrollmentRows.map((row) => [Number(row.student_id), { id: Number(row.id), sectionId: Number(row.section_id) }]));
    if (enrollmentByStudent.size !== NEW_STUDENT_COUNT) throw new AcademicExpansionError('The Term 2 academic enrollments could not be verified.');

    const oldSubjectByGrade = new Map([
      ['Grade 11', ['OCOM-11', 'GMAT-11']], ['Grade 12', ['EAPP-12', 'STAT-12']]
    ]);
    const studentSubjectRows = [];
    for (const student of plan.newStudents) {
      const studentId = studentsByNo.get(student.studentNo).id;
      const enrollmentId = enrollmentByStudent.get(studentId).id;
      const gradeSubjects = [...oldSubjectByGrade.get(student.gradeLevel),
        ...NEW_SUBJECTS.filter(({ gradeLevel }) => gradeLevel === student.gradeLevel).map(({ code }) => code)];
      for (const code of gradeSubjects) studentSubjectRows.push({ enrollment_id: enrollmentId,
        subject_id: newSubjectIds.get(code) || [...owners.oldSubjects.entries()].find(([oldCode, id]) => {
          const old = NORMALIZED_OLD_SUBJECTS.find((item) => item.oldCode === oldCode);
          return old?.newCode === code && id;
        })?.[1] });
    }
    await insertMany(connection, 'student_subjects', ['enrollment_id', 'subject_id'], studentSubjectRows);
    const enrolledSubjects = await readRows(connection,
      `SELECT subjectRow.id AS student_subject_id, subjectRow.enrollment_id, subjectRow.subject_id,
          enrollment.student_id, student.student_no, student.lrn, student.first_name, student.last_name,
          student.birth_date, section.grade_level, enrollment.section_id
        FROM student_subjects AS subjectRow
        INNER JOIN enrollments AS enrollment ON enrollment.id = subjectRow.enrollment_id
        INNER JOIN students AS student ON student.id = enrollment.student_id
        INNER JOIN sections AS section ON section.id = enrollment.section_id
        WHERE enrollment.academic_term_id = ? AND student.student_no IN (${placeholders(NEW_STUDENT_COUNT)})`,
      [owners.terms.get(2), ...plan.newStudents.map(({ studentNo }) => studentNo)]);
    if (enrolledSubjects.length !== NEW_STUDENT_COUNT * 4) throw new AcademicExpansionError('The 480 student-subject enrollments could not be verified.');

    const subjectCodeById = new Map([...newSubjectIds.entries()].map(([code, id]) => [id, code]));
    for (const [oldCode, id] of owners.oldSubjects) {
      const def = NORMALIZED_OLD_SUBJECTS.find(({ oldCode: key }) => oldCode === key);
      subjectCodeById.set(id, def.newCode);
    }
    const approvedRows = [];
    for (const row of enrolledSubjects) {
      const code = subjectCodeById.get(Number(row.subject_id));
      if (!NORMALIZED_OLD_SUBJECTS.some(({ newCode }) => newCode === code)) continue;
      const gradeIndex = oldSubjectByGrade.get(row.grade_level).indexOf(code);
      const grades = gradeValues(Number(row.student_no.slice(-4)), gradeIndex);
      GRADE_PERIODS.forEach((period, index) => approvedRows.push({
        student_subject_id: Number(row.student_subject_id), grading_period: period,
        grade_value: grades[index].toFixed(2), recorded_by: owners.staff.get('HDMO-TEACH-001').user_id
      }));
    }
    if (approvedRows.length !== plan.counts.approvedGradeRows) throw new AcademicExpansionError('The direct synthetic sample-grade plan is incomplete.');
    await insertMany(connection, 'grades', ['student_subject_id', 'grading_period', 'grade_value', 'recorded_by'], approvedRows);

    for (const schedule of scheduleRows) {
      const assignmentKey = `${schedule.termId}:${schedule.sectionId}:${newSubjectIds.get(schedule.subjectCode)}`;
      const assignmentId = assignmentByContext.get(assignmentKey);
      if (!assignmentId) throw new AcademicExpansionError('A scheduled academic class does not have its expected teacher assignment.');
      schedule.assignmentId = assignmentId;
    }
    await insertMany(connection, 'class_schedules', ['assignment_id', 'day_of_week', 'start_time', 'end_time', 'room', 'created_by'],
      scheduleRows.map((schedule) => ({ assignment_id: schedule.assignmentId, day_of_week: schedule.dayOfWeek,
        start_time: schedule.startTime, end_time: schedule.endTime, room: schedule.room, created_by: owners.registrarId })));

    const insertedScheduleRows = await readRows(connection,
      `SELECT schedule.id, assignment.academic_term_id, assignment.section_id, schedule.day_of_week,
          schedule.start_time, schedule.end_time, schedule.room
        FROM class_schedules AS schedule INNER JOIN teacher_assignments AS assignment ON assignment.id = schedule.assignment_id
        WHERE assignment.id IN (${placeholders(assignmentByContext.size)})`, [...assignmentByContext.values()]);
    if (insertedScheduleRows.length !== 24) throw new AcademicExpansionError('The 24 new weekly class schedules could not be verified.');

    const submissionManifest = [];
    for (const source of workbookFiles) {
      const subjectId = newSubjectIds.get(source.subject.code);
      const sectionId = owners.sections.get(`2:${source.subject.gradeLevel}:${source.suffix}`);
      const assignmentId = assignmentByContext.get(`${owners.terms.get(2)}:${sectionId}:${subjectId}`);
      const submitterId = accountByEmail.get(reserved.emails[plan.newTeachers.findIndex(({ subjectCode }) => subjectCode === source.subject.code)]);
      const submissionId = stableUuid(`submission:${source.subject.code}:${source.suffix}`);
      if (!assignmentId || !submitterId) throw new AcademicExpansionError('A pending workbook is missing its teacher assignment or account.');
      await connection.execute(`INSERT INTO teacher_grade_submissions
        (id, assignment_id, previous_submission_id, revision_number, submitted_by, school_year, grade_level,
          section_name, subject_id, subject_name, workbook_grade_level, workbook_section_name,
          workbook_subject_name, context_mismatch, original_filename, storage_key, file_size_bytes, status)
        VALUES (?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'pending')`,
      [submissionId, assignmentId, submitterId, SCHOOL_YEAR, source.subject.gradeLevel,
        sectionName(source.subject.gradeLevel, source.suffix), subjectId, source.subject.name,
        source.subject.gradeLevel, sectionName(source.subject.gradeLevel, source.suffix), source.subject.name,
        source.filename, source.storageKey, source.byteLength]);
      const persistedByLrn = new Map(enrolledSubjects.filter((row) => Number(row.section_id) === sectionId
        && Number(row.subject_id) === subjectId).map((row) => [String(row.lrn), row]));
      const sourceRows = source.parsed.rows;
      if (sourceRows.length !== 30) throw new AcademicExpansionError('A synthetic teacher workbook did not parse to its complete section roster.');
      for (const workbookRow of sourceRows) {
        const match = persistedByLrn.get(workbookRow.lrn);
        if (!match || workbookRow.issue || workbookRow.workbookName !== `${match.first_name} ${match.last_name}`) {
          throw new AcademicExpansionError('A synthetic workbook row does not match an enrolled learner and subject.');
        }
        const fingerprint = crypto.createHmac('sha256', configuration.sessionSecret).update(workbookRow.lrn).digest('hex');
        const [insertedRow] = await connection.execute(`INSERT INTO teacher_grade_submission_rows
          (submission_id, source_row, student_id, enrollment_id, student_subject_id, student_no,
            workbook_name, student_name, lrn_fingerprint, name_mismatch, issue)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
        [submissionId, workbookRow.sourceRow, Number(match.student_id), Number(match.enrollment_id),
          Number(match.student_subject_id), match.student_no, workbookRow.workbookName,
          workbookRow.workbookName, fingerprint]);
        for (const grade of workbookRow.grades) {
          await connection.execute(`INSERT INTO teacher_grade_submission_grades
            (submission_row_id, grading_period, grade_value, existing_grade_id, existing_grade_value)
            VALUES (?, ?, ?, NULL, NULL)`,
          [Number(insertedRow.insertId), grade.gradingPeriod, grade.gradeValue.toFixed(2)]);
        }
      }
      await connection.execute(`INSERT INTO teacher_grade_submission_events (submission_id, actor_id, event_type, reason)
        VALUES (?, ?, 'submitted', ?)`,
      [submissionId, submitterId, 'Synthetic parsed workbook fixture; no registrar decision has been recorded.']);
      submissionManifest.push({ id: submissionId, storageKey: source.storageKey, filename: source.filename,
        byteLength: source.byteLength, sha256: source.sha256 });
    }
    const savedSubmissionCounts = await readRows(connection,
      `SELECT submission.status, COUNT(DISTINCT submission.id) AS submission_count, COUNT(DISTINCT row.id) AS row_count
        FROM teacher_grade_submissions AS submission
        LEFT JOIN teacher_grade_submission_rows AS row ON row.submission_id = submission.id
        WHERE submission.id IN (${placeholders(submissionManifest.length)}) GROUP BY submission.status`,
      submissionManifest.map(({ id }) => id));
    if (savedSubmissionCounts.length !== 1 || savedSubmissionCounts[0].status !== 'pending'
      || Number(savedSubmissionCounts[0].submission_count) !== 8 || Number(savedSubmissionCounts[0].row_count) !== 240) {
      throw new AcademicExpansionError('The pending grade-review queue could not be verified after insertion.');
    }

    await connection.execute('UPDATE academic_terms SET is_current = 0 WHERE id = ?', [previousCurrentTerm.id]);
    await connection.execute('UPDATE academic_terms SET is_current = 1 WHERE id = ?', [owners.terms.get(2)]);
    const selectedCurrentTerms = await readRows(connection,
      'SELECT id FROM academic_terms WHERE is_current = 1 ORDER BY id');
    if (selectedCurrentTerms.length !== 1 || Number(selectedCurrentTerms[0].id) !== owners.terms.get(2)) {
      throw new AcademicExpansionError('The requested 2026–2027 Term 2 current-term selection could not be verified.');
    }

    const auditDetails = {
      marker: ACADEMIC_MARKER,
      schoolYear: SCHOOL_YEAR,
      currentTermChange: { previous: previousCurrentTerm, selectedTermId: owners.terms.get(2),
        schoolYear: SCHOOL_YEAR, term: CURRENT_TERM },
      counts: plan.counts,
      provenance: {
        syntheticStudentProfiles: 'seeded academic fixtures; no student login accounts were created',
        approvedGradeRows: 'direct seeded synthetic sample grades; not a workbook approval or a human registrar decision',
        pendingSubmissions: 'readable corrected-format synthetic workbook sources; submitted lifecycle event only; no final grade writes',
        workbookTemplate: 'minimal fictional corrected-format parser fixture derived from the repository corrected-mini workbook'
      },
      submissions: submissionManifest
    };
    await connection.execute(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
      VALUES (?, ?, 'academic_fixture_expansion', ?, ?)`,
    [owners.adminId, MARKER_AUDIT_ACTION, ACADEMIC_MARKER, JSON.stringify(auditDetails)]);

    commitAttempted = true;
    await connection.commit();
    started = false;
    logger.log(JSON.stringify({ mode: 'applied', database: options.targetDatabase, counts: plan.counts,
      privateWorkbookDirectory: storage.directory, credentialArtifact: storage.credentialsPath,
      credentialAccounts: NEW_TEACHER_COUNT }));
    return { mode: 'applied', counts: plan.counts, storageDirectory: storage.directory,
      credentialArtifact: storage.credentialsPath };
  } catch (error) {
    const disposition = await rollbackExpansionAttempt(connection, { started, commitAttempted, createdFiles });
    destroyConnection = disposition.destroyConnection;
    if (error instanceof AcademicExpansionError) throw error;
    throw new AcademicExpansionError('Hostinger academic fixture expansion failed; verify the target schema, private storage, and collision preflight.');
  } finally {
    if (connection && destroyConnection) {
      discardUncertainConnection(connection);
    } else if (locked && connection) {
      try { await connection.execute('SELECT RELEASE_LOCK(?)', [APPLICATION_LOCK]); } catch { /* Connection may already be unavailable. */ }
    }
    if (connection && !destroyConnection) connection.release();
    await closeDatabasePool().catch(() => {});
  }
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await seedAcademicFixtures({ options });
    if (options.mode === 'dry-run') return;
    if (result.mode === 'applied') console.log(`Private credential artifact saved: ${result.credentialArtifact} (${NEW_TEACHER_COUNT} teacher accounts).`);
  } catch (error) {
    console.error(error instanceof AcademicExpansionError ? error.message : 'Academic expansion failed. No connection details or private values were included.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ACADEMIC_MARKER,
  EXPANSION_MARKER,
  HOSTINGER_SEED_MARKER,
  NEW_SUBJECTS,
  AcademicExpansionError,
  parseOptions,
  validateProductionTarget,
  validateHostApplyTarget,
  buildPlan,
  buildWorkbooks,
  chooseScheduleSlots,
  rollbackExpansionAttempt,
  discardUncertainConnection,
  requirePrivateStorage,
  seedAcademicFixtures
};
