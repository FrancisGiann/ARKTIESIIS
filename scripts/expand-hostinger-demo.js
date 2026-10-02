'use strict';

const { createHash } = require('node:crypto');
const { isIP } = require('node:net');
const environment = require('../src/config/environment');
const { getPool, closePool } = require('../src/config/database');
const { REQUIRED_OBJECTS } = require('./check-db');

const HOSTINGER_SEED_MARKER = 'hostinger-demo-seed-v1';
const EXPANSION_MARKER = 'hostinger-demo-expansion-v1';
const SCHOOL_YEAR = '2026-2027';
const APPLICATION_LOCK = 'ARKTIESIIS Hostinger demo expansion v1';
const STUDENT_COUNT = 99;
const LEGACY_STYLE_STUDENT_COUNT = 20;
const REQUIRED_VERSIONS = Array.from({ length: 11 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`);

const GRADE_DEFINITIONS = [
  { gradeLevel: 'Grade 11', code: 'G11', sections: ['A', 'B'] },
  { gradeLevel: 'Grade 12', code: 'G12', sections: ['A', 'B'] }
];
const SUBJECT_DEFINITIONS = [
  { gradeCode: 'G11', code: 'ENG', name: 'Demo Grade 11 English', units: '3.00' },
  { gradeCode: 'G11', code: 'MATH', name: 'Demo Grade 11 Mathematics', units: '4.00' },
  { gradeCode: 'G12', code: 'ENG', name: 'Demo Grade 12 English', units: '3.00' },
  { gradeCode: 'G12', code: 'MATH', name: 'Demo Grade 12 Mathematics', units: '4.00' }
];
const VOUCHER_DEFINITIONS = [
  { code: 'PUB', tuition: 1200, miscellaneous: 450 },
  { code: 'ESC', tuition: 2200, miscellaneous: 550 },
  { code: 'NV', tuition: 3500, miscellaneous: 650 }
];
const IDEMPOTENCY_TABLES = Object.freeze({
  annual_enrollments: 'annual_enrollments',
  annual_enrollment_events: 'annual_enrollment_events',
  finance_schedules: 'finance_schedules',
  annual_assessments: 'annual_assessments',
  assessed_charges: 'assessed_charges',
  finance_payments: 'finance_payments',
  finance_allocation_batches: 'finance_allocation_batches'
});

class ExpansionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ExpansionError';
    this.status = status;
  }
}

function stableUuid(key) {
  const hex = createHash('sha256').update(`arktiesiis:${EXPANSION_MARKER}:${key}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function chunks(values, size = 100) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function buildExpansionPlan({ today = new Date() } = {}) {
  const now = today instanceof Date ? new Date(today.getTime()) : new Date(today);
  if (Number.isNaN(now.getTime())) throw new ExpansionError('The demo expansion date is invalid.');
  const dateAtUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const assessedAt = `${dateAtUtcMidnight.toISOString().slice(0, 10)} 09:00:00`;
  const termNames = ['Term 1', 'Term 2', 'Term 3'];
  const students = Array.from({ length: STUDENT_COUNT }, (_, index) => {
    const number = index + 2;
    return {
      ordinal: number,
      studentNo: `DEMO-HOSTINGER-${String(number).padStart(4, '0')}`,
      lrn: String(999000000091 + index + 1),
      firstName: 'Demo',
      middleName: 'Sample',
      lastName: `Learner ${String(number).padStart(3, '0')}`,
      sex: 'unspecified',
      address: `Fictional demo record ${String(number).padStart(3, '0')}`,
      gradeLevel: number <= 50 ? 'Grade 11' : 'Grade 12',
      gradeCode: number <= 50 ? 'G11' : 'G12',
      voucherCode: ['PUB', 'ESC', 'NV'][(index * 7 + 1) % 3],
      annualKey: stableUuid(`annual:${number}`),
      annualFingerprint: fingerprint({ studentNo: `DEMO-HOSTINGER-${String(number).padStart(4, '0')}`, schoolYear: SCHOOL_YEAR })
    };
  });
  const legacyStudents = students.slice(0, LEGACY_STYLE_STUDENT_COUNT);
  const annualStudents = students.slice(LEGACY_STYLE_STUDENT_COUNT);
  const sections = termNames.flatMap((termName, termIndex) => GRADE_DEFINITIONS.flatMap((grade) => grade.sections.map((suffix) => ({
    termName,
    termNumber: termIndex + 1,
    gradeLevel: grade.gradeLevel,
    gradeCode: grade.code,
    suffix,
    name: `Demo Hostinger ${grade.gradeLevel} ${suffix}`,
    cluster: 'Academic',
    strand: suffix === 'A' ? 'STEM' : 'HUMSS',
    modality: 'face-to-face'
  }))));
  const subjects = SUBJECT_DEFINITIONS.map((subject) => ({
    ...subject,
    subjectCode: `DEMO-HOSTINGER-${subject.gradeCode}-${subject.code}-001`
  }));
  const schedules = GRADE_DEFINITIONS.flatMap((grade) => VOUCHER_DEFINITIONS.map((voucher) => ({
    gradeLevel: grade.gradeLevel,
    voucherCode: voucher.code,
    idempotencyKey: stableUuid(`schedule:${grade.code}:${voucher.code}`),
    requestFingerprint: fingerprint({ schoolYear: SCHOOL_YEAR, gradeLevel: grade.gradeLevel, voucherCode: voucher.code, version: 1 })
  })));
  const scheduleLines = schedules.flatMap((schedule) => {
    const voucher = VOUCHER_DEFINITIONS.find(({ code }) => code === schedule.voucherCode);
    return [1, 2, 3].flatMap((termNumber) => [
      { schedule, termNumber, feeCategory: 'tuition', lineName: 'Tuition', installment: `Term ${termNumber}`,
        amount: (voucher.tuition + ((termNumber - 1) * 100)).toFixed(2) },
      { schedule, termNumber, feeCategory: 'miscellaneous', lineName: 'Demo miscellaneous fee', installment: `Term ${termNumber}`,
        amount: (voucher.miscellaneous + ((termNumber - 1) * 25)).toFixed(2) }
    ]);
  });
  const classScheduleContexts = [
    { isBaseline: true, termName: 'Term 1', gradeCode: 'G11', suffix: 'A', subjectCode: 'DEMO-HOSTINGER-ENG-001' },
    ...sections.flatMap((section) => subjects.filter((subject) => subject.gradeCode === section.gradeCode).map((subject) => ({
      isBaseline: false, termName: section.termName, gradeCode: section.gradeCode,
      suffix: section.suffix, subjectCode: subject.subjectCode
    })))
  ];
  const scheduleSlotsByTerm = new Map();
  const classSchedules = classScheduleContexts.map((context) => {
    const termNumber = termNames.indexOf(context.termName) + 1;
    const slot = scheduleSlotsByTerm.get(context.termName) || 0;
    scheduleSlotsByTerm.set(context.termName, slot + 1);
    const dayOfWeek = Math.floor(slot / 5) + 1;
    const startHour = 8 + ((slot % 5) * 2);
    const time = (hour) => `${String(hour).padStart(2, '0')}:00:00`;
    return {
      ...context,
      termNumber,
      dayOfWeek,
      startTime: time(startHour),
      endTime: time(startHour + 1),
      room: `Demo T${termNumber} Room ${String(slot + 1).padStart(2, '0')}`
    };
  });
  const payments = annualStudents.filter((_, index) => index % 3 === 0).map((student, index) => {
    const amount = [250, 500, 750, 1200][index % 4].toFixed(2);
    const paymentDate = new Date(dateAtUtcMidnight.getTime());
    paymentDate.setUTCDate(paymentDate.getUTCDate() - ((index * 7) % 31));
    const referenceNo = `DEMO-HOSTINGER-RCPT-${String(index + 1).padStart(4, '0')}`;
    return {
      studentOrdinal: student.ordinal,
      amount,
      paymentDate: paymentDate.toISOString().slice(0, 10),
      referenceNo,
      receiptIssued: index % 2,
      idempotencyKey: stableUuid(`payment:${student.ordinal}`),
      requestFingerprint: fingerprint({ studentNo: student.studentNo, amount, referenceNo })
    };
  });

  const rowsByIdempotencyTable = {
    annual_enrollments: annualStudents.map((row) => row.annualKey),
    annual_enrollment_events: annualStudents.map((row) => stableUuid(`annual-event:${row.ordinal}`)),
    finance_schedules: schedules.map((row) => row.idempotencyKey),
    annual_assessments: annualStudents.map((row) => stableUuid(`assessment:${row.ordinal}`)),
    assessed_charges: annualStudents.flatMap((student) => [1, 2, 3].flatMap((termNumber) => ['tuition', 'miscellaneous']
      .map((category) => stableUuid(`charge:${student.ordinal}:${termNumber}:${category}`)))),
    finance_payments: payments.map((row) => row.idempotencyKey),
    finance_allocation_batches: payments.map((row) => stableUuid(`allocation-batch:${row.studentOrdinal}`))
  };
  return {
    students, legacyStudents, annualStudents, termNames, sections, subjects, schedules, scheduleLines, classSchedules, payments,
    rowsByIdempotencyTable, assessedAt,
    expectedCounts: {
      users: 0, students: students.length, legacyStyleStudents: legacyStudents.length,
      pendingAnnualStudents: annualStudents.length,
      academicTerms: 2, schoolYearTermOrder: 3,
      sections: sections.length, subjects: subjects.length, teacherAssignments: sections.length * 2,
      pendingTermPlacements: annualStudents.length * 3,
      annualEnrollments: annualStudents.length, annualEnrollmentEvents: annualStudents.length,
      enrollments: legacyStudents.length + (annualStudents.length * 3),
      studentSubjects: legacyStudents.length + (annualStudents.length * 3 * 2),
      grades: legacyStudents.length * 4, financeSchedules: schedules.length,
      financeScheduleLines: scheduleLines.length, annualAssessments: annualStudents.length,
      assessedCharges: annualStudents.length * scheduleLines.length / schedules.length,
      financePayments: payments.length, financeAllocationBatches: payments.length,
      financePaymentAllocations: payments.length, classSchedules: classSchedules.length, registrarConfirmations: 0
    }
  };
}

function buildSyntheticGradeRows(studentSubjectId, student, teacherId, termNumber = 1, subjectIndex = 0) {
  const offset = (student.ordinal * 7 + termNumber * 3 + subjectIndex * 5) % 21;
  const first = 76 + offset;
  const second = Math.min(99, first + ((student.ordinal + subjectIndex) % 3));
  const third = Math.max(75, first - ((student.ordinal + termNumber) % 3));
  const final = Math.round((first + second + third) / 3);
  return [['Term 1', first], ['Term 2', second], ['Term 3', third], ['Final Grade', final]].map(([gradingPeriod, gradeValue]) => ({
    student_subject_id: studentSubjectId,
    grading_period: gradingPeriod,
    grade_value: `${gradeValue}.00`,
    recorded_by: teacherId
  }));
}

function parseOptions(args, configuredDatabase = environment.database.database) {
  if (!Array.isArray(args)) throw new ExpansionError('Expansion arguments are invalid.');
  const options = { mode: null, targetDatabase: null, confirmDatabase: null, seedMarker: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (options.mode) throw new ExpansionError('Choose exactly one mode: --dry-run or --apply.');
      options.mode = argument.slice(2);
    } else if (['--target-database', '--confirm-database', '--confirm-seed-marker'].includes(argument)) {
      if (seen.has(argument) || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new ExpansionError(`Provide one value for ${argument}.`);
      }
      if (argument === '--target-database') options.targetDatabase = args[index + 1];
      if (argument === '--confirm-database') options.confirmDatabase = args[index + 1];
      if (argument === '--confirm-seed-marker') options.seedMarker = args[index + 1];
      seen.add(argument);
      index += 1;
    } else {
      throw new ExpansionError('Expansion arguments are invalid.');
    }
  }
  if (!options.mode || !options.targetDatabase || !options.confirmDatabase || !options.seedMarker) {
    throw new ExpansionError('Provide a mode, the exact database name twice, and the exact Hostinger demo seed marker.');
  }
  if (options.targetDatabase !== options.confirmDatabase || options.targetDatabase !== configuredDatabase) {
    throw new ExpansionError('Both confirmed database names must exactly match DB_NAME.');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.targetDatabase)) throw new ExpansionError('The target database name is invalid.');
  if (options.seedMarker !== HOSTINGER_SEED_MARKER) {
    throw new ExpansionError('Confirm the exact hostinger-demo-seed-v1 marker.');
  }
  return options;
}

function validateProductionTarget(configuration = environment) {
  if (configuration.nodeEnv !== 'production') throw new ExpansionError('The Hostinger demo expansion requires NODE_ENV=production.');
  if (configuration.devPasswordOnlyLogin) throw new ExpansionError('The development password-only login must remain disabled.');
  const database = configuration.database || {};
  const host = String(database.host || '').trim().toLowerCase();
  const addressType = isIP(host);
  if (!host || host === 'localhost' || host === '::1' || (addressType === 4 && /^127\./.test(host))) {
    throw new ExpansionError('The Hostinger expansion requires the remote MariaDB host from hPanel.');
  }
  if (!database.database || !database.user || String(database.user).toLowerCase() === 'root' || !database.password) {
    throw new ExpansionError('DB_NAME, DB_USER, and DB_PASSWORD must identify the existing hPanel database.');
  }
}

async function execute(connection, statement, values = []) {
  return connection.execute(statement, values);
}

async function readRows(connection, statement, values = []) {
  const [rows] = await execute(connection, statement, values);
  return rows;
}

async function insertMany(connection, table, columns, rows) {
  if (!rows.length) return;
  const columnSql = columns.map((column) => `\`${column}\``).join(', ');
  for (const part of chunks(rows, 100)) {
    const valueSql = part.map(() => `(${placeholders(columns.length)})`).join(', ');
    const values = part.flatMap((row) => columns.map((column) => row[column]));
    await execute(connection, `INSERT INTO \`${table}\` (${columnSql}) VALUES ${valueSql}`, values);
  }
}

async function selectByValues(connection, columns, table, column, values) {
  const rows = [];
  for (const part of chunks(values, 100)) {
    if (!part.length) continue;
    rows.push(...await readRows(connection,
      `SELECT ${columns} FROM \`${table}\` WHERE \`${column}\` IN (${placeholders(part.length)})`, part));
  }
  return rows;
}

async function requireExpectedSchema(connection) {
  const versions = await readRows(connection, 'SELECT version FROM schema_migrations ORDER BY version');
  const applied = versions.map(({ version }) => String(version));
  if (applied.length !== REQUIRED_VERSIONS.length || REQUIRED_VERSIONS.some((version) => !applied.includes(version))) {
    throw new ExpansionError('The Hostinger expansion requires the complete MariaDB v2.011 schema.');
  }
  const objects = await readRows(connection,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (${placeholders(REQUIRED_OBJECTS.length)})`,
    REQUIRED_OBJECTS);
  const found = new Set(objects.map(({ table_name }) => String(table_name)));
  if (REQUIRED_OBJECTS.some((name) => !found.has(name))) {
    throw new ExpansionError('The selected database is missing expected MariaDB demo schema objects.');
  }
}

async function requireHostingerSeed(connection) {
  const markers = await readRows(connection,
    `SELECT marker.id, marker.user_id FROM audit_logs AS marker
      INNER JOIN users AS actor ON actor.id = marker.user_id AND actor.role = 'database_admin'
      WHERE marker.entity_type = ? AND marker.entity_id = ?`,
    ['school_demo_seed', HOSTINGER_SEED_MARKER]);
  if (markers.length !== 1) throw new ExpansionError('The exact Hostinger demo seed marker was not found.');
  const baseline = await readRows(connection,
    `SELECT student.id AS student_id, term.id AS term_id, section.id AS section_id, subject.id AS subject_id
      FROM students AS student
      INNER JOIN users AS student_account ON student_account.id = student.user_id
        AND student_account.role = 'student' AND student_account.is_active = 1
      INNER JOIN academic_terms AS term ON term.school_year = ? AND term.term = ? AND term.is_current = 1
      INNER JOIN sections AS section ON section.academic_term_id = term.id
        AND section.name = ? AND section.grade_level = 'Grade 11'
      INNER JOIN subjects AS subject ON subject.subject_code = ? AND subject.subject_name = 'Demo Communication Skills'
      INNER JOIN enrollments AS enrollment ON enrollment.student_id = student.id
        AND enrollment.academic_term_id = term.id AND enrollment.section_id = section.id
        AND enrollment.enrollment_status = 'enrolled' AND enrollment.term_scope_status = 'applicable'
      WHERE student.student_no = ? AND student.lrn = ? AND student.user_id IS NOT NULL
        AND student.first_name = 'Demo' AND student.last_name = 'Learner' AND student.status = 'active'`,
    [SCHOOL_YEAR, 'Term 1', 'Demo Hostinger Section A', 'DEMO-HOSTINGER-ENG-001',
      'DEMO-HOSTINGER-0001', '999000000091']);
  if (baseline.length !== 1) throw new ExpansionError('The selected database does not match the one-time Hostinger demo seed.');
  const baselineCounts = await readRows(connection,
    `SELECT
        (SELECT COUNT(*) FROM users) AS users_count,
        (SELECT COUNT(*) FROM students) AS students_count,
        (SELECT COUNT(*) FROM financial_accounts) AS financial_accounts_count,
        (SELECT COUNT(*) FROM academic_terms) AS academic_terms_count,
        (SELECT COUNT(*) FROM sections) AS sections_count,
        (SELECT COUNT(*) FROM subjects) AS subjects_count,
        (SELECT COUNT(*) FROM enrollments) AS enrollments_count,
        (SELECT COUNT(*) FROM student_subjects) AS student_subjects_count,
        (SELECT COUNT(*) FROM grades) AS grades_count,
        (SELECT COUNT(*) FROM annual_enrollments) AS annual_enrollments_count,
        (SELECT COUNT(*) FROM annual_assessments) AS annual_assessments_count,
        (SELECT COUNT(*) FROM class_schedules) AS class_schedules_count`);
  const expectedBaselineCounts = {
    users_count: 5, students_count: 1, financial_accounts_count: 1, academic_terms_count: 1,
    sections_count: 1, subjects_count: 1, enrollments_count: 1, student_subjects_count: 1,
    grades_count: 4, annual_enrollments_count: 0, annual_assessments_count: 0, class_schedules_count: 0
  };
  if (baselineCounts.length !== 1 || Object.entries(expectedBaselineCounts)
    .some(([key, count]) => Number(baselineCounts[0][key]) !== count)) {
    throw new ExpansionError('The selected database no longer matches the untouched Hostinger demo seed profile.');
  }
  const staffRows = await readRows(connection,
    `SELECT profile.employee_no, actor.id, actor.role FROM staff_profiles AS profile
      INNER JOIN users AS actor ON actor.id = profile.user_id AND actor.is_active = 1
      WHERE profile.employee_no IN (?, ?, ?, ?)`,
    ['HDMO-ADMIN-001', 'HDMO-REG-001', 'HDMO-TEACH-001', 'HDMO-FIN-001']);
  const staff = new Map(staffRows.map((row) => [String(row.employee_no), row]));
  if (staff.get('HDMO-ADMIN-001')?.role !== 'database_admin'
    || staff.get('HDMO-REG-001')?.role !== 'registrar'
    || staff.get('HDMO-TEACH-001')?.role !== 'teacher'
    || staff.get('HDMO-FIN-001')?.role !== 'finance') {
    throw new ExpansionError('The seeded administrator, teacher, and finance roles could not be verified.');
  }
  const teacherAssignments = await readRows(connection,
    `SELECT id FROM teacher_assignments WHERE teacher_id = ? AND academic_term_id = ?
      AND section_id = ? AND subject_id = ? AND is_active = 1`,
    [Number(staff.get('HDMO-TEACH-001').id), Number(baseline[0].term_id),
      Number(baseline[0].section_id), Number(baseline[0].subject_id)]);
  if (teacherAssignments.length !== 1) throw new ExpansionError('The seeded teacher assignment could not be verified.');
  return {
    adminId: Number(staff.get('HDMO-ADMIN-001').id),
    registrarId: Number(staff.get('HDMO-REG-001').id),
    teacherId: Number(staff.get('HDMO-TEACH-001').id),
    financeId: Number(staff.get('HDMO-FIN-001').id),
    legacyContext: {
      termId: Number(baseline[0].term_id), sectionId: Number(baseline[0].section_id),
      subjectId: Number(baseline[0].subject_id), assignmentId: Number(teacherAssignments[0].id)
    }
  };
}

async function requireNoReservedCollisions(connection, plan) {
  const studentNumbers = plan.students.map(({ studentNo }) => studentNo);
  const lrns = plan.students.map(({ lrn }) => lrn);
  const collision = await readRows(connection,
    `SELECT id FROM students WHERE student_no IN (${placeholders(studentNumbers.length)})
      OR lrn IN (${placeholders(lrns.length)}) LIMIT 1`, [...studentNumbers, ...lrns]);
  if (collision.length) throw new ExpansionError('A reserved demo student number or LRN is already in use.');

  const termCollision = await readRows(connection,
    `SELECT id FROM academic_terms WHERE school_year = ? AND term IN (?, ?) LIMIT 1`,
    [SCHOOL_YEAR, 'Term 2', 'Term 3']);
  if (termCollision.length) throw new ExpansionError('A reserved demo academic term already exists.');
  const orderCollision = await readRows(connection,
    'SELECT id FROM school_year_term_order WHERE school_year = ? LIMIT 1', [SCHOOL_YEAR]);
  if (orderCollision.length) throw new ExpansionError('A school-year term order already exists for the reserved demo year.');

  const sectionNames = [...new Set(plan.sections.map(({ name }) => name))];
  const sectionCollision = await readRows(connection,
    `SELECT section.id FROM sections AS section
      WHERE section.name IN (${placeholders(sectionNames.length)}) LIMIT 1`, sectionNames);
  if (sectionCollision.length) throw new ExpansionError('A reserved demo section name is already in use.');

  const subjectCodes = plan.subjects.map(({ subjectCode }) => subjectCode);
  const subjectCollision = await readRows(connection,
    `SELECT id FROM subjects WHERE subject_code IN (${placeholders(subjectCodes.length)}) LIMIT 1`, subjectCodes);
  if (subjectCollision.length) throw new ExpansionError('A reserved demo subject code is already in use.');

  const scheduleCollision = await readRows(connection,
    `SELECT id FROM finance_schedules WHERE school_year = ? AND grade_level IN (?, ?)
      AND voucher_code IN (?, ?, ?) LIMIT 1`,
    [SCHOOL_YEAR, 'Grade 11', 'Grade 12', 'PUB', 'ESC', 'NV']);
  if (scheduleCollision.length) throw new ExpansionError('A finance schedule already exists in the reserved demo scope.');

  for (const [key, table] of Object.entries(IDEMPOTENCY_TABLES)) {
    for (const part of chunks(plan.rowsByIdempotencyTable[key], 100)) {
      const rows = await readRows(connection,
        `SELECT id FROM \`${table}\` WHERE idempotency_key IN (${placeholders(part.length)}) LIMIT 1`, part);
      if (rows.length) throw new ExpansionError('A reserved demo idempotency identifier is already in use.');
    }
  }
  const receiptNumbers = plan.payments.map(({ referenceNo }) => referenceNo);
  const receiptCollision = await readRows(connection,
    `SELECT id FROM finance_payments WHERE reference_no IN (${placeholders(receiptNumbers.length)}) LIMIT 1`, receiptNumbers);
  if (receiptCollision.length) throw new ExpansionError('A reserved demo receipt reference is already in use.');
  const classScheduleCollision = await readRows(connection,
    'SELECT id FROM class_schedules LIMIT 1');
  if (classScheduleCollision.length) throw new ExpansionError('The seeded database already contains class schedules; existing schedules will not be changed.');
}

async function requireExpansionMarkerAvailable(connection) {
  const rows = await readRows(connection,
    'SELECT id FROM audit_logs WHERE entity_type = ? AND entity_id = ? LIMIT 1',
    ['school_demo_expansion', EXPANSION_MARKER]);
  if (rows.length) throw new ExpansionError('The Hostinger demo expansion was already applied to this database.');
}

async function runExpansion({
  options = parseOptions(process.argv.slice(2)), configuration = environment, getDatabasePool = getPool,
  closeDatabasePool = closePool, logger = console, today = new Date()
} = {}) {
  validateProductionTarget(configuration);
  if (!options || !['apply', 'dry-run'].includes(options.mode)
    || options.targetDatabase !== configuration.database.database
    || options.confirmDatabase !== configuration.database.database
    || options.seedMarker !== HOSTINGER_SEED_MARKER) {
    throw new ExpansionError('Confirm the production demo database and exact seed marker before continuing.');
  }
  const plan = buildExpansionPlan({ today });
  const pool = await getDatabasePool();
  let connection;
  let locked = false;
  let started = false;
  try {
    connection = await pool.source.getConnection();
    const lockRows = await readRows(connection, 'SELECT GET_LOCK(?, 15) AS acquired', [APPLICATION_LOCK]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new ExpansionError('Could not acquire the one-time demo expansion lock.');
    locked = true;
    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await connection.beginTransaction();
    started = true;

    await requireExpectedSchema(connection);
    await requireExpansionMarkerAvailable(connection);
    await requireNoReservedCollisions(connection, plan);
    const actors = await requireHostingerSeed(connection);
    if (options.mode === 'dry-run') {
      await connection.rollback();
      started = false;
      logger.log(`Dry run passed for ${plan.expectedCounts.students} additional fictional students in ${options.targetDatabase}. No rows were written.`);
      return { mode: 'dry-run', counts: plan.expectedCounts };
    }

    const staff = actors;
    const studentColumns = ['student_no', 'lrn', 'first_name', 'middle_name', 'last_name', 'sex', 'address', 'status'];
    await insertMany(connection, 'students', studentColumns, plan.students.map((student) => ({
      student_no: student.studentNo, lrn: student.lrn, first_name: student.firstName, middle_name: student.middleName,
      last_name: student.lastName, sex: student.sex, address: student.address, status: 'active'
    })));
    const studentRows = await selectByValues(connection, 'id, student_no, lrn', 'students', 'student_no', plan.students.map(({ studentNo }) => studentNo));
    const studentsByNo = new Map(studentRows.map((row) => [String(row.student_no), { ...row, id: Number(row.id) }]));
    if (studentsByNo.size !== STUDENT_COUNT) throw new ExpansionError('The demo student records could not be verified after insert.');

    const legacyEnrollmentRows = plan.legacyStudents.map((student) => ({
      student_id: studentsByNo.get(student.studentNo).id,
      academic_term_id: staff.legacyContext.termId,
      section_id: staff.legacyContext.sectionId,
      enrollment_status: 'enrolled', finalized_at: plan.assessedAt,
      annual_enrollment_id: null, annual_term_number: null, term_scope_status: 'applicable'
    }));
    await insertMany(connection, 'enrollments', ['student_id', 'academic_term_id', 'section_id', 'enrollment_status',
      'finalized_at', 'annual_enrollment_id', 'annual_term_number', 'term_scope_status'], legacyEnrollmentRows);
    const legacyStudentIds = plan.legacyStudents.map((student) => studentsByNo.get(student.studentNo).id);
    const persistedLegacyEnrollments = await readRows(connection,
      `SELECT id, student_id FROM enrollments WHERE academic_term_id = ? AND student_id IN (${placeholders(legacyStudentIds.length)})`,
      [staff.legacyContext.termId, ...legacyStudentIds]);
    if (persistedLegacyEnrollments.length !== plan.legacyStudents.length) {
      throw new ExpansionError('The demo legacy-style enrolled records could not be verified after insert.');
    }
    const legacySubjectRows = persistedLegacyEnrollments.map((enrollment) => ({
      enrollment_id: Number(enrollment.id), subject_id: staff.legacyContext.subjectId
    }));
    await insertMany(connection, 'student_subjects', ['enrollment_id', 'subject_id'], legacySubjectRows);
    const legacyEnrollmentIds = persistedLegacyEnrollments.map(({ id }) => Number(id));
    const persistedLegacySubjects = await readRows(connection,
      `SELECT id, enrollment_id FROM student_subjects WHERE enrollment_id IN (${placeholders(legacyEnrollmentIds.length)})
        AND subject_id = ?`, [...legacyEnrollmentIds, staff.legacyContext.subjectId]);
    if (persistedLegacySubjects.length !== plan.legacyStudents.length) {
      throw new ExpansionError('The demo legacy-style subject assignments could not be verified after insert.');
    }
    const legacyStudentById = new Map(plan.legacyStudents.map((student) => [
      studentsByNo.get(student.studentNo).id, student
    ]));
    const legacyGrades = persistedLegacySubjects.flatMap((assignment) => {
      const enrollment = persistedLegacyEnrollments.find((row) => Number(row.id) === Number(assignment.enrollment_id));
      const student = legacyStudentById.get(Number(enrollment.student_id));
      return buildSyntheticGradeRows(Number(assignment.id), student, staff.teacherId);
    });
    await insertMany(connection, 'grades', ['student_subject_id', 'grading_period', 'grade_value', 'recorded_by'], legacyGrades);

    await insertMany(connection, 'academic_terms', ['school_year', 'term', 'is_current'], [
      { school_year: SCHOOL_YEAR, term: 'Term 2', is_current: 0 },
      { school_year: SCHOOL_YEAR, term: 'Term 3', is_current: 0 }
    ]);
    const termRows = await readRows(connection,
      `SELECT id, term FROM academic_terms WHERE school_year = ? AND term IN (?, ?, ?)`,
      [SCHOOL_YEAR, ...plan.termNames]);
    const termIds = new Map(termRows.map((row) => [String(row.term), Number(row.id)]));
    if (termIds.size !== 3) throw new ExpansionError('The demo academic terms could not be verified after insert.');

    const sectionRowsToInsert = plan.sections.map((section) => ({
      name: section.name, grade_level: section.gradeLevel, academic_term_id: termIds.get(section.termName),
      cluster: section.cluster, strand: section.strand, adviser: null, modality: section.modality, modular_subtype: null
    }));
    await insertMany(connection, 'sections', ['name', 'grade_level', 'academic_term_id', 'cluster', 'strand', 'adviser', 'modality', 'modular_subtype'], sectionRowsToInsert);
    const sectionNames = [...new Set(plan.sections.map(({ name }) => name))];
    const persistedSections = await readRows(connection,
      `SELECT id, name, grade_level, academic_term_id, strand FROM sections
        WHERE academic_term_id IN (?, ?, ?) AND name IN (${placeholders(sectionNames.length)})`,
      [...termIds.values(), ...sectionNames]);
    const sectionKey = (termId, gradeCode, suffix) => `${termId}:${gradeCode}:${suffix}`;
    const sectionsByContext = new Map(persistedSections.map((row) => {
      const gradeCode = row.grade_level === 'Grade 11' ? 'G11' : 'G12';
      const suffix = String(row.name).endsWith(' B') ? 'B' : 'A';
      return [sectionKey(Number(row.academic_term_id), gradeCode, suffix), Number(row.id)];
    }));
    if (sectionsByContext.size !== plan.sections.length) throw new ExpansionError('The demo sections could not be verified after insert.');

    await insertMany(connection, 'subjects', ['subject_code', 'subject_name', 'units'], plan.subjects.map((subject) => ({
      subject_code: subject.subjectCode, subject_name: subject.name, units: subject.units
    })));
    const subjectRows = await selectByValues(connection, 'id, subject_code', 'subjects', 'subject_code', plan.subjects.map(({ subjectCode }) => subjectCode));
    const subjectsByCode = new Map(subjectRows.map((row) => [String(row.subject_code), Number(row.id)]));
    if (subjectsByCode.size !== plan.subjects.length) throw new ExpansionError('The demo subjects could not be verified after insert.');

    await insertMany(connection, 'school_year_term_order', ['school_year', 'term_number', 'academic_term_id', 'configured_by'],
      [...plan.termNames].map((termName, index) => ({ school_year: SCHOOL_YEAR, term_number: index + 1,
        academic_term_id: termIds.get(termName), configured_by: staff.adminId })));

    const scheduleRows = plan.schedules.map((schedule) => ({
      school_year: SCHOOL_YEAR, grade_level: schedule.gradeLevel, voucher_code: schedule.voucherCode,
      version_no: 1, status: 'active', idempotency_key: schedule.idempotencyKey,
      request_fingerprint: schedule.requestFingerprint, created_by: staff.financeId
    }));
    await insertMany(connection, 'finance_schedules', ['school_year', 'grade_level', 'voucher_code', 'version_no', 'status',
      'idempotency_key', 'request_fingerprint', 'created_by'], scheduleRows);
    const persistedSchedules = await selectByValues(connection, 'id, idempotency_key, grade_level, voucher_code',
      'finance_schedules', 'idempotency_key', plan.schedules.map(({ idempotencyKey }) => idempotencyKey));
    const schedulesByKey = new Map(persistedSchedules.map((row) => [String(row.idempotency_key), Number(row.id)]));
    if (schedulesByKey.size !== plan.schedules.length) throw new ExpansionError('The demo finance schedules could not be verified after insert.');
    const scheduleIdsByContext = new Map(plan.schedules.map((schedule) => [
      `${schedule.gradeLevel}:${schedule.voucherCode}`, schedulesByKey.get(schedule.idempotencyKey)
    ]));
    const scheduleLinesToInsert = plan.scheduleLines.map((line) => ({
      schedule_id: scheduleIdsByContext.get(`${line.schedule.gradeLevel}:${line.schedule.voucherCode}`),
      term_number: line.termNumber, fee_category: line.feeCategory, line_name: line.lineName,
      installment: line.installment, amount: line.amount, is_optional: 0
    }));
    await insertMany(connection, 'finance_schedule_lines', ['schedule_id', 'term_number', 'fee_category', 'line_name', 'installment', 'amount', 'is_optional'], scheduleLinesToInsert);
    const persistedLines = await readRows(connection,
      `SELECT id, schedule_id, term_number, fee_category, line_name, installment, amount
        FROM finance_schedule_lines WHERE schedule_id IN (${placeholders([...scheduleIdsByContext.values()].length)})`,
      [...scheduleIdsByContext.values()]);
    const scheduleLinesByContext = new Map(persistedLines.map((line) => [
      `${Number(line.schedule_id)}:${Number(line.term_number)}:${line.fee_category}`, line
    ]));
    if (scheduleLinesByContext.size !== plan.scheduleLines.length) throw new ExpansionError('The demo fee schedule lines could not be verified after insert.');

    const annualRows = plan.annualStudents.map((student) => ({
      student_id: studentsByNo.get(student.studentNo).id, school_year: SCHOOL_YEAR, grade_level: student.gradeLevel,
      voucher_code: student.voucherCode, voucher_category: null, intake_status: 'pending', account_activation_pending: 0,
      created_by: staff.adminId, idempotency_key: student.annualKey, request_fingerprint: student.annualFingerprint,
      intake_kind: 'new', entry_term_number: 1, enrollment_start_date: null
    }));
    await insertMany(connection, 'annual_enrollments', ['student_id', 'school_year', 'grade_level', 'voucher_code', 'voucher_category',
      'intake_status', 'account_activation_pending', 'created_by', 'idempotency_key', 'request_fingerprint', 'intake_kind',
      'entry_term_number', 'enrollment_start_date'], annualRows);
    const annualRowsPersisted = await readRows(connection,
      `SELECT id, student_id, idempotency_key FROM annual_enrollments WHERE idempotency_key IN (${placeholders(plan.annualStudents.length)})`,
      plan.annualStudents.map(({ annualKey }) => annualKey));
    const annualByStudentId = new Map(annualRowsPersisted.map((row) => [Number(row.student_id), Number(row.id)]));
    const studentByOrdinal = new Map(plan.annualStudents.map((student) => [student.ordinal, student]));

    const enrollmentsToInsert = [];
    for (const student of plan.annualStudents) {
      const studentId = studentsByNo.get(student.studentNo).id;
      const annualId = annualByStudentId.get(studentId);
      for (const section of plan.sections.filter((item) => item.gradeCode === student.gradeCode)) {
        const currentTermId = termIds.get(section.termName);
        const sectionNumber = student.ordinal <= 50 ? student.ordinal - 2 : student.ordinal - 51;
        const assignedSectionSuffix = sectionNumber % 2 === 0 ? 'A' : 'B';
        if (section.suffix !== assignedSectionSuffix) continue;
        enrollmentsToInsert.push({
          student_id: studentId, academic_term_id: currentTermId,
          section_id: sectionsByContext.get(sectionKey(currentTermId, student.gradeCode, section.suffix)),
          enrollment_status: 'pending_payment', finalized_at: null, annual_enrollment_id: annualId,
          annual_term_number: section.termNumber, term_scope_status: 'applicable'
        });
      }
    }
    await insertMany(connection, 'enrollments', ['student_id', 'academic_term_id', 'section_id', 'enrollment_status', 'finalized_at',
      'annual_enrollment_id', 'annual_term_number', 'term_scope_status'], enrollmentsToInsert);
    const annualIds = [...annualByStudentId.values()];
    const enrollmentRows = await readRows(connection,
      `SELECT id, student_id, annual_enrollment_id, academic_term_id, section_id, annual_term_number
        FROM enrollments WHERE annual_enrollment_id IN (${placeholders(annualIds.length)})`, annualIds);
    const enrollmentByTerm = new Map(enrollmentRows.map((row) => [`${Number(row.annual_enrollment_id)}:${Number(row.annual_term_number)}`, row]));
    if (enrollmentByTerm.size !== plan.annualStudents.length * 3) {
      throw new ExpansionError('The demo annual term placements could not be verified after insert.');
    }

    const assignmentRows = [];
    for (const section of plan.sections) {
      const termId = termIds.get(section.termName);
      const sectionId = sectionsByContext.get(sectionKey(termId, section.gradeCode, section.suffix));
      for (const subject of plan.subjects.filter(({ gradeCode }) => gradeCode === section.gradeCode)) {
        assignmentRows.push({ teacher_id: staff.teacherId, academic_term_id: termId, section_id: sectionId,
          subject_id: subjectsByCode.get(subject.subjectCode), assigned_by: staff.adminId });
      }
    }
    await insertMany(connection, 'teacher_assignments', ['teacher_id', 'academic_term_id', 'section_id', 'subject_id', 'assigned_by'], assignmentRows);
    const assignedSectionIds = [...sectionsByContext.values()];
    const persistedAssignments = await readRows(connection,
      `SELECT id, academic_term_id, section_id, subject_id FROM teacher_assignments
        WHERE teacher_id = ? AND section_id IN (${placeholders(assignedSectionIds.length)}) AND is_active = 1`,
      [staff.teacherId, ...assignedSectionIds]);
    const assignmentsByContext = new Map(persistedAssignments.map((assignment) => [
      `${Number(assignment.academic_term_id)}:${Number(assignment.section_id)}:${Number(assignment.subject_id)}`,
      Number(assignment.id)
    ]));
    if (assignmentsByContext.size !== assignmentRows.length) {
      throw new ExpansionError('The demo teacher assignments could not be verified after insert.');
    }
    const classScheduleRows = plan.classSchedules.map((schedule) => {
      const termId = termIds.get(schedule.termName);
      const sectionId = schedule.isBaseline ? staff.legacyContext.sectionId
        : sectionsByContext.get(sectionKey(termId, schedule.gradeCode, schedule.suffix));
      const subjectId = schedule.isBaseline ? staff.legacyContext.subjectId : subjectsByCode.get(schedule.subjectCode);
      const assignmentId = schedule.isBaseline ? staff.legacyContext.assignmentId
        : assignmentsByContext.get(`${termId}:${sectionId}:${subjectId}`);
      if (!assignmentId) throw new ExpansionError('An active teacher assignment for a demo class schedule was not found.');
      return {
        assignment_id: assignmentId, day_of_week: schedule.dayOfWeek,
        start_time: schedule.startTime, end_time: schedule.endTime,
        room: schedule.room, created_by: staff.registrarId
      };
    });
    await insertMany(connection, 'class_schedules', ['assignment_id', 'day_of_week', 'start_time', 'end_time', 'room', 'created_by'], classScheduleRows);

    const studentSubjectRows = [];
    for (const enrollment of enrollmentRows) {
      const student = plan.annualStudents.find((item) => studentsByNo.get(item.studentNo).id === Number(enrollment.student_id));
      for (const subject of plan.subjects.filter(({ gradeCode }) => gradeCode === student.gradeCode)) {
        studentSubjectRows.push({ enrollment_id: Number(enrollment.id), subject_id: subjectsByCode.get(subject.subjectCode) });
      }
    }
    await insertMany(connection, 'student_subjects', ['enrollment_id', 'subject_id'], studentSubjectRows);

    const eventRows = annualRowsPersisted.map((row) => {
      const student = plan.annualStudents.find((item) => studentsByNo.get(item.studentNo).id === Number(row.student_id));
      return {
        annual_enrollment_id: Number(row.id), enrollment_id: null, actor_id: staff.adminId, event_type: 'created',
        reason: 'Synthetic Hostinger demo fixture; no student login or registrar confirmation was created.',
        idempotency_key: stableUuid(`annual-event:${student.ordinal}`),
        request_fingerprint: fingerprint({ annualEnrollmentId: Number(row.id), eventType: 'created', marker: EXPANSION_MARKER })
      };
    });
    await insertMany(connection, 'annual_enrollment_events', ['annual_enrollment_id', 'enrollment_id', 'actor_id', 'event_type',
      'reason', 'idempotency_key', 'request_fingerprint'], eventRows);

    const assessmentRows = annualRowsPersisted.map((row) => {
      const student = plan.annualStudents.find((item) => studentsByNo.get(item.studentNo).id === Number(row.student_id));
      const schedule = plan.schedules.find((item) => item.gradeLevel === student.gradeLevel && item.voucherCode === student.voucherCode);
      return {
        annual_enrollment_id: Number(row.id), schedule_id: schedulesByKey.get(schedule.idempotencyKey), schedule_version: 1,
        voucher_code_snapshot: student.voucherCode, assessed_by: staff.financeId, assessed_at: plan.assessedAt,
        selection_json: '{"optionalLineIds":[]}', idempotency_key: stableUuid(`assessment:${student.ordinal}`),
        request_fingerprint: fingerprint({ annualId: Number(row.id), schedule: schedule.idempotencyKey })
      };
    });
    await insertMany(connection, 'annual_assessments', ['annual_enrollment_id', 'schedule_id', 'schedule_version', 'voucher_code_snapshot',
      'assessed_by', 'assessed_at', 'selection_json', 'idempotency_key', 'request_fingerprint'], assessmentRows);
    const assessments = await selectByValues(connection, 'id, annual_enrollment_id, idempotency_key', 'annual_assessments',
      'idempotency_key', plan.annualStudents.map((student) => stableUuid(`assessment:${student.ordinal}`)));
    const assessmentByAnnualId = new Map(assessments.map((row) => [Number(row.annual_enrollment_id), Number(row.id)]));

    const chargeRows = [];
    for (const annualRow of annualRowsPersisted) {
      const student = plan.annualStudents.find((item) => studentsByNo.get(item.studentNo).id === Number(annualRow.student_id));
      const annualId = Number(annualRow.id);
      const assessmentId = assessmentByAnnualId.get(annualId);
      for (const line of plan.scheduleLines.filter(({ schedule }) => schedule.gradeLevel === student.gradeLevel
        && schedule.voucherCode === student.voucherCode)) {
        const scheduleId = schedulesByKey.get(line.schedule.idempotencyKey);
        const savedLine = scheduleLinesByContext.get(`${scheduleId}:${line.termNumber}:${line.feeCategory}`);
        const enrollment = enrollmentByTerm.get(`${annualId}:${line.termNumber}`);
        chargeRows.push({
          assessment_id: assessmentId, annual_enrollment_id: annualId, enrollment_id: Number(enrollment.id),
          schedule_line_id: Number(savedLine.id), fee_category: line.feeCategory, line_name: line.lineName,
          installment: line.installment, amount: String(savedLine.amount), gross_amount: String(savedLine.amount),
          waived_amount: '0.00', idempotency_key: stableUuid(`charge:${student.ordinal}:${line.termNumber}:${line.feeCategory}`),
          request_fingerprint: fingerprint({ annualId, term: line.termNumber, category: line.feeCategory, amount: String(savedLine.amount) })
        });
      }
    }
    await insertMany(connection, 'assessed_charges', ['assessment_id', 'annual_enrollment_id', 'enrollment_id', 'schedule_line_id',
      'fee_category', 'line_name', 'installment', 'amount', 'gross_amount', 'waived_amount', 'idempotency_key', 'request_fingerprint'], chargeRows);
    const firstTermTuitionRows = await readRows(connection,
      `SELECT charge.id, annual.student_id FROM assessed_charges AS charge
        INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
        INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
        WHERE annual.id IN (${placeholders(annualIds.length)}) AND enrollment.annual_term_number = 1
          AND charge.fee_category = 'tuition'`, annualIds);
    const tuitionChargeByStudent = new Map(firstTermTuitionRows.map((row) => [Number(row.student_id), Number(row.id)]));

    const paymentRows = plan.payments.map((payment) => {
      const student = studentByOrdinal.get(payment.studentOrdinal);
      const studentId = studentsByNo.get(student.studentNo).id;
      return {
        student_id: studentId, amount: payment.amount, payment_date: payment.paymentDate,
        reference_no: payment.referenceNo, receipt_issued: payment.receiptIssued,
        idempotency_key: payment.idempotencyKey, request_fingerprint: payment.requestFingerprint,
        recorded_by: staff.financeId, is_reversed: 0, reverses_payment_id: null
      };
    });
    await insertMany(connection, 'finance_payments', ['student_id', 'amount', 'payment_date', 'reference_no', 'receipt_issued',
      'idempotency_key', 'request_fingerprint', 'recorded_by', 'is_reversed', 'reverses_payment_id'], paymentRows);
    const savedPayments = await selectByValues(connection, 'id, idempotency_key, student_id', 'finance_payments',
      'idempotency_key', plan.payments.map(({ idempotencyKey }) => idempotencyKey));
    const paymentByKey = new Map(savedPayments.map((row) => [String(row.idempotency_key), row]));
    const allocationBatchRows = plan.payments.map((payment) => {
      const savedPayment = paymentByKey.get(payment.idempotencyKey);
      return {
        payment_id: Number(savedPayment.id), student_id: Number(savedPayment.student_id),
        idempotency_key: stableUuid(`allocation-batch:${payment.studentOrdinal}`),
        request_fingerprint: fingerprint({ paymentId: Number(savedPayment.id), amount: payment.amount }),
        allocated_by: staff.financeId
      };
    });
    await insertMany(connection, 'finance_allocation_batches', ['payment_id', 'student_id', 'idempotency_key', 'request_fingerprint', 'allocated_by'], allocationBatchRows);
    const savedBatches = await selectByValues(connection, 'id, idempotency_key, payment_id', 'finance_allocation_batches',
      'idempotency_key', plan.payments.map(({ studentOrdinal }) => stableUuid(`allocation-batch:${studentOrdinal}`)));
    const batchByPaymentId = new Map(savedBatches.map((row) => [Number(row.payment_id), Number(row.id)]));
    const allocations = plan.payments.map((payment) => {
      const savedPayment = paymentByKey.get(payment.idempotencyKey);
      const studentId = Number(savedPayment.student_id);
      return {
        payment_id: Number(savedPayment.id), charge_id: tuitionChargeByStudent.get(studentId), amount: payment.amount,
        allocation_batch_id: batchByPaymentId.get(Number(savedPayment.id)), allocated_by: staff.financeId
      };
    });
    await insertMany(connection, 'finance_payment_allocations', ['payment_id', 'charge_id', 'amount', 'allocation_batch_id', 'allocated_by'], allocations);

    const auditDetails = {
      version: 1,
      counts: plan.expectedCounts,
      notes: [
        'All added student records are fictional and have no login accounts.',
        'Twenty students use legacy-style enrolled academic records; the other seventy-nine annual placements remain pending payment.',
        'No registrar confirmations were created; grade rows are direct synthetic fixtures and not registrar-approved workbook imports.',
        'Timetable rows are synthetic and have no overlap for the seeded teacher within a term.',
        'Finance amounts are sample values and are not approved school fee rates.'
      ]
    };
    await execute(connection,
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (?, 'database_admin.demo_data_expanded', 'school_demo_expansion', ?, ?)`,
      [staff.adminId, EXPANSION_MARKER, JSON.stringify(auditDetails)]);
    await connection.commit();
    started = false;
    logger.log(`Hostinger demo expansion applied: ${plan.expectedCounts.students} fictional students (${plan.expectedCounts.legacyStyleStudents} enrolled academic fixtures and ${plan.expectedCounts.pendingAnnualStudents} pending annual intakes), ${plan.expectedCounts.classSchedules} class schedules, ${plan.expectedCounts.grades} synthetic grade rows, ${plan.expectedCounts.assessedCharges} assessed fee lines, and ${plan.expectedCounts.financePayments} sample payments.`);
    logger.log('No login accounts or registrar confirmations were added. Finance rates and all added student data are fictional demo fixtures.');
    return { mode: 'apply', counts: plan.expectedCounts };
  } catch (error) {
    if (started) await connection.rollback().catch(() => {});
    if (error instanceof ExpansionError) throw error;
    const safeError = new ExpansionError('The Hostinger demo expansion failed and was rolled back. Verify the selected v2.011 demo database and reserved fixture identifiers.');
    safeError.cause = error;
    throw safeError;
  } finally {
    if (connection) {
      if (locked) await execute(connection, 'SELECT RELEASE_LOCK(?)', [APPLICATION_LOCK]).catch(() => {});
      connection.release();
    }
    await closeDatabasePool().catch(() => {});
  }
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    validateProductionTarget();
    await runExpansion({ options });
  } catch (error) {
    console.error(error instanceof ExpansionError ? error.message : 'Hostinger demo expansion failed. Check the approved production demo configuration and MariaDB reachability.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  HOSTINGER_SEED_MARKER,
  EXPANSION_MARKER,
  SCHOOL_YEAR,
  REQUIRED_VERSIONS,
  REQUIRED_OBJECTS,
  ExpansionError,
  stableUuid,
  fingerprint,
  buildExpansionPlan,
  parseOptions,
  validateProductionTarget,
  requireExpectedSchema,
  requireHostingerSeed,
  requireNoReservedCollisions,
  runExpansion
};
