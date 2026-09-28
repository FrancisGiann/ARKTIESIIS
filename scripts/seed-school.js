const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { constants: fsConstants } = require('node:fs');
const bcrypt = require('bcrypt');
const { getPool, closePool, sql } = require('../src/config/database');
const environment = require('../src/config/environment');

const SEED_VERSION = 'school-2026-2027-v2';
const MARKER_ACTION = 'school.demo_seeded';
const MARKER_TYPE = 'school_demo_seed';
const CREDENTIAL_FILE = path.resolve(__dirname, '../.env.school-demo');
const PASSWORD_HASH_ROUNDS = 12;
const PARAMETER_LIMIT = 1800;
const GRADING_PERIODS = ['First Grading', 'Second Grading'];
const STRANDS = ['STEM', 'ABM', 'HUMSS', 'TVL'];
const GRADES = [11, 12];
const SECTIONS_PER_STRAND = 2;
const STUDENTS_PER_SECTION = 20;
const TEACHER_COUNT = 16;
const DOCUMENT_SAMPLE_MARKER = {
  action: 'school.demo_documents_seeded',
  entityType: 'school_demo_seed',
  entityId: 'school-2026-2027-documents-v1'
};
const PUBLIC_DIRECTORY = path.resolve(__dirname, '../public');
const SAMPLE_FIXTURES = [
  {
    studentIndex: 0,
    documentType: 'good_moral',
    originalFilename: 'SYNTHETIC-DEFENSE-ONLY-Good-Moral-NOT-OFFICIAL.pdf',
    mimeType: 'application/pdf',
    extension: '.pdf',
    status: 'needs_review',
    fixturePath: path.resolve(__dirname, '../tests/fixtures/ocr/synthetic-two-page.pdf')
  },
  {
    studentIndex: 1,
    documentType: 'psa_birth_certificate',
    originalFilename: 'SYNTHETIC-DEFENSE-ONLY-PSA-NOT-OFFICIAL.png',
    mimeType: 'image/png',
    extension: '.png',
    status: 'rejected',
    fixturePath: path.resolve(__dirname, '../tests/fixtures/ocr/synthetic-png.png')
  }
];

class SchoolSeedError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SchoolSeedError';
    this.status = status;
  }
}

function parseOptions(args, nodeEnv = process.env.NODE_ENV || 'development') {
  if (nodeEnv !== 'development') throw new SchoolSeedError('School demo data can only be seeded when NODE_ENV=development.');
  if (!Array.isArray(args) || args.length !== 1 || !['--dry-run', '--apply'].includes(args[0])) {
    throw new SchoolSeedError('Choose exactly one option: --dry-run or --apply.');
  }
  return { mode: args[0] === '--apply' ? 'apply' : 'dry-run' };
}

function assertDevelopmentTarget(configuration = environment) {
  if (configuration.nodeEnv !== 'development') throw new SchoolSeedError('School demo data can only be seeded when NODE_ENV=development.');
  const database = configuration.database || {};
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(String(database.server || '').toLowerCase())
    || database.database !== 'ARKTIESIIS_V2') {
    throw new SchoolSeedError('School demo data can only be applied to the local ARKTIESIIS_V2 database.');
  }
}

function deriveSchoolEmails(smtpUser) {
  const normalized = typeof smtpUser === 'string' ? smtpUser.trim().toLowerCase() : '';
  const match = normalized.match(/^([a-z0-9.]+)(?:\+[a-z0-9._-]+)?@(gmail\.com|googlemail\.com)$/);
  if (!match || !match[1] || match[1].length > 64) {
    throw new SchoolSeedError('Set SMTP_USER to a valid Gmail or Googlemail address before preparing school demo accounts.');
  }
  const localPart = match[1];
  const domain = match[2];
  const emailFor = (suffix) => {
    if (localPart.length + suffix.length + 1 > 64) {
      throw new SchoolSeedError('SMTP_USER is too long to form safe school demo aliases.');
    }
    return `${localPart}+${suffix}@${domain}`;
  };
  return {
    registrar: emailFor('arkt-school-demo-registrar'),
    finance: emailFor('arkt-school-demo-finance'),
    teachers: Array.from({ length: TEACHER_COUNT }, (_unused, index) => emailFor(`arkt-school-demo-teacher-${String(index + 1).padStart(2, '0')}`)),
    students: Array.from({ length: 3 }, (_unused, index) => emailFor(`arkt-school-demo-student-${index + 1}`))
  };
}

function subjectCatalog() {
  const core = [
    ['OC', 'OCOM', 'Oral Communication', '3.00'],
    ['RW', 'RW', 'Reading and Writing Skills', '3.00'],
    ['GM', 'GENMATH', 'General Mathematics', '3.00'],
    ['ELS', 'EARTHLIFE', 'Earth and Life Science', '3.00'],
    ['PEH', 'PEH', 'Physical Education and Health', '2.00']
  ].map(([legacyCode, code, name, units]) => ({ code, legacyCode: `DEMO-SCH-2627-${legacyCode}`, name, units, grade: null, strand: null }));
  const specialized = {
    '11-STEM': [['PRECALC', 'PRECALC11', 'Pre-Calculus', '3.00'], ['GENCHEM1', 'GENCHEM11', 'General Chemistry 1', '4.00']],
    '12-STEM': [['CALC', 'BASCALC12', 'Basic Calculus', '3.00'], ['PHYS2', 'GENPHYS12', 'General Physics 2', '4.00']],
    '11-ABM': [['FABM1', 'FABM11', 'Fundamentals of Accountancy, Business and Management 1', '3.00'], ['BUSMATH', 'BUSMATH11', 'Business Mathematics', '3.00']],
    '12-ABM': [['FABM2', 'FABM12', 'Fundamentals of Accountancy, Business and Management 2', '3.00'], ['BUSFIN', 'BUSFIN12', 'Business Finance', '3.00']],
    '11-HUMSS': [['DISS', 'DISS11', 'Disciplines and Ideas in the Social Sciences', '3.00'], ['CREATIVE', 'CREATIVE11', 'Creative Writing', '3.00']],
    '12-HUMSS': [['CPAR', 'CPAR12', 'Contemporary Philippine Arts from the Regions', '3.00'], ['POLGOV', 'POLGOV12', 'Politics and Governance', '3.00']],
    '11-TVL': [['ICT1', 'ICT11', 'Introduction to ICT Systems', '3.00'], ['CSS1', 'CSS11', 'Computer Systems Servicing 1', '4.00']],
    '12-TVL': [['ICT2', 'ICT12', 'ICT Project Development', '3.00'], ['CSS2', 'CSS12', 'Computer Systems Servicing 2', '4.00']]
  };
  const strandSubjects = Object.entries(specialized).flatMap(([context, rows]) => rows.map(([legacySuffix, subjectCode, name, units]) => {
    const [grade, strand] = context.split('-');
    return { code: subjectCode, legacyCode: `DEMO-SCH-2627-G${grade}-${strand}-${legacySuffix}`, name, units, grade: Number(grade), strand };
  }));
  return [...core, ...strandSubjects];
}

function gradeValueFor(student, subjectIndex, periodIndex) {
  const score = 76 + ((Number(student.studentNo.slice(-4)) * 7 + subjectIndex * 11 + periodIndex * 5) % 25);
  const cents = (Number(student.studentNo.slice(-2)) + subjectIndex + periodIndex) % 2 ? 50 : 0;
  return score === 100 ? '100.00' : `${score}.${String(cents).padStart(2, '0')}`;
}

function buildSchoolPlan(emails) {
  const subjects = subjectCatalog();
  const commonSubjects = subjects.filter((subject) => subject.grade === null);
  const sections = [];
  for (const grade of GRADES) {
    for (const strand of STRANDS) {
      for (let sectionNumber = 1; sectionNumber <= SECTIONS_PER_STRAND; sectionNumber += 1) {
        const suffix = String.fromCharCode(64 + sectionNumber);
        const name = `Grade ${grade} ${strand} ${suffix}`;
        const specialization = subjects.filter((subject) => subject.grade === grade && subject.strand === strand);
        sections.push({
          name,
          grade,
          gradeLevel: `Grade ${grade}`,
          strand,
          sectionNumber,
          subjects: [...commonSubjects, ...specialization]
        });
      }
    }
  }

  const firstNames = ['Alyssa', 'Andrei', 'Bianca', 'Caleb', 'Camille', 'Carlos', 'Clarisse', 'Daniel', 'Elijah', 'Ella', 'Gabriel', 'Hannah', 'Isabel', 'Joaquin', 'Julia', 'Liam', 'Lucas', 'Mara', 'Miguel', 'Nina', 'Noah', 'Paolo', 'Rafael', 'Sofia', 'Thea', 'Tristan', 'Vanessa', 'Victor', 'Yasmin', 'Zachary'];
  const lastNames = ['Aguilar', 'Bautista', 'Cabrera', 'Castillo', 'Cruz', 'Dela Cruz', 'Domingo', 'Garcia', 'Gonzales', 'Hernandez', 'Lim', 'Lopez', 'Manalo', 'Mendoza', 'Navarro', 'Ocampo', 'Reyes', 'Rivera', 'Rodriguez', 'Santos', 'Soriano', 'Tan', 'Torres', 'Valdez', 'Villanueva'];
  const students = [];
  let ordinal = 0;
  for (const section of sections) {
    for (let seat = 0; seat < STUDENTS_PER_SECTION; seat += 1) {
      ordinal += 1;
      const loginIndex = ordinal <= 3 ? ordinal : null;
      students.push({
        key: `student-${String(ordinal).padStart(4, '0')}`,
        studentNo: `SHS-2026-${String(ordinal).padStart(4, '0')}`,
        lrn: `998${String(ordinal).padStart(9, '0')}`,
        firstName: firstNames[(ordinal * 7 + section.grade) % firstNames.length],
        lastName: lastNames[(ordinal * 11 + section.sectionNumber) % lastNames.length],
        grade: section.grade,
        strand: section.strand,
        sectionName: section.name,
        loginKey: loginIndex ? `student${loginIndex}` : null,
        email: loginIndex ? emails.students[loginIndex - 1] : null
      });
    }
  }

  const staff = [
    { key: 'registrar', email: emails.registrar, role: 'registrar', employeeNo: 'EMP-2026-017', firstName: 'Maricel', lastName: 'Dela Cruz', department: 'Registrar Office' },
    { key: 'finance', email: emails.finance, role: 'finance', employeeNo: 'EMP-2026-018', firstName: 'Nestor', lastName: 'Villanueva', department: 'Finance Office' },
    ...emails.teachers.map((email, index) => ({
      key: `teacher${String(index + 1).padStart(2, '0')}`,
      email,
      role: 'teacher',
      employeeNo: `EMP-2026-${String(index + 1).padStart(3, '0')}`,
      firstName: firstNames[(index * 3 + 4) % firstNames.length],
      lastName: lastNames[(index * 5 + 8) % lastNames.length],
      department: 'Senior High School Faculty'
    }))
  ];
  const teacherStaff = staff.filter((account) => account.role === 'teacher');
  const assignments = [];
  const schedules = [];
  let sectionIndex = 0;
  for (const section of sections) {
    for (const [subjectIndex, subject] of section.subjects.entries()) {
      const teacher = teacherStaff[(sectionIndex + subjectIndex) % teacherStaff.length];
      assignments.push({ sectionName: section.name, subjectCode: subject.code, teacherKey: teacher.key });
      schedules.push({
        sectionName: section.name,
        subjectCode: subject.code,
        dayOfWeek: subjectIndex === 6 ? 1 : subjectIndex + 1,
        startTime: subjectIndex === 6 ? '09:00' : '08:00',
        endTime: subjectIndex === 6 ? '10:00' : '09:00',
        room: `SHS ${section.grade} ${section.strand} ${String.fromCharCode(64 + section.sectionNumber)}`
      });
    }
    sectionIndex += 1;
  }

  const assignmentsByContext = new Map(assignments.map((assignment) => [
    `${assignment.sectionName}:${assignment.subjectCode}`, assignment
  ]));
  const sectionsByName = new Map(sections.map((section) => [section.name, section]));
  const gradingPeriods = GRADING_PERIODS.slice();
  const grades = [];
  for (const student of students) {
    const section = sectionsByName.get(student.sectionName);
    for (const [subjectIndex, subject] of section.subjects.entries()) {
      const assignment = assignmentsByContext.get(`${student.sectionName}:${subject.code}`);
      if (!assignment) throw new SchoolSeedError('Every sample subject must have a teacher assignment in its section.');
      for (const [periodIndex, gradingPeriod] of gradingPeriods.entries()) {
        grades.push({
          studentKey: student.key,
          sectionName: student.sectionName,
          subjectCode: subject.code,
          teacherKey: assignment.teacherKey,
          gradingPeriod,
          gradeValue: gradeValueFor(student, subjectIndex, periodIndex)
        });
      }
    }
  }

  const financialAccounts = students.map((student, index) => {
    const tuitionCents = (student.grade === 11 ? 2400000n : 2500000n);
    const labCents = ({ STEM: 95000n, ABM: 60000n, HUMSS: 50000n, TVL: 145000n })[student.strand];
    const totalCents = tuitionCents + labCents;
    const paymentCents = [totalCents * 4n / 5n, totalCents, totalCents + 2500n, totalCents / 2n][index % 4];
    const transactions = [
      { type: 'charge', amount: centsToDecimal(tuitionCents), description: 'Tuition assessment - AY 2026-2027', reference: `${student.studentNo}-TUITION` },
      { type: 'charge', amount: centsToDecimal(labCents), description: `${student.strand} laboratory and program fee`, reference: `${student.studentNo}-PROGRAM-FEE` },
      { type: 'payment', amount: centsToDecimal(paymentCents), description: 'Student account payment', reference: `${student.studentNo}-PAYMENT-01` }
    ];
    return { studentKey: student.key, balance: centsToDecimal(totalCents - paymentCents), transactions };
  });

  return {
    version: SEED_VERSION,
    marker: { action: MARKER_ACTION, entityType: MARKER_TYPE, entityId: SEED_VERSION },
    term: { schoolYear: '2026-2027', term: 'First Semester' },
    sections,
    students,
    staff,
    subjects,
    assignments,
    schedules,
    gradingPeriods,
    grades,
    financialAccounts,
    documentSamples: SAMPLE_FIXTURES.map(({ studentIndex, documentType, originalFilename, status }) => ({
      studentNo: students[studentIndex].studentNo, documentType, originalFilename, status
    })),
    counts: {
      students: students.length,
      linkedStudentAccounts: students.filter((student) => student.loginKey).length,
      staffAccounts: staff.length,
      teacherAccounts: teacherStaff.length,
      sections: sections.length,
      subjects: subjects.length,
      studentSubjects: assignments.reduce((count, assignment) => count + students.filter((student) => student.sectionName === assignment.sectionName).length, 0),
      teacherAssignments: assignments.length,
      classSchedules: schedules.length,
      grades: grades.length,
      financialAccounts: financialAccounts.length,
      financialTransactions: financialAccounts.reduce((count, account) => count + account.transactions.length, 0),
      syntheticDocuments: SAMPLE_FIXTURES.length
    }
  };
}

function decimalToCents(value) {
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new SchoolSeedError('School demo ledger amounts must be positive PHP decimals.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function centsToDecimal(cents) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function credentialRows(emails, passwords) {
  const rows = [
    ['SCHOOL_DEMO_REGISTRAR', emails.registrar, passwords.registrar],
    ['SCHOOL_DEMO_FINANCE', emails.finance, passwords.finance]
  ];
  emails.teachers.forEach((email, index) => rows.push([
    `SCHOOL_DEMO_TEACHER_${String(index + 1).padStart(2, '0')}`,
    email,
    passwords[`teacher${String(index + 1).padStart(2, '0')}`]
  ]));
  emails.students.forEach((email, index) => rows.push([`SCHOOL_DEMO_STUDENT_${index + 1}`, email, passwords[`student${index + 1}`]]));
  return rows;
}

function formatCredentials(emails, passwords) {
  return `# Local synthetic school demo credentials. Do not commit or share this file.\n${credentialRows(emails, passwords)
    .flatMap(([key, email, password]) => [`${key}_EMAIL=${email}`, `${key}_PASSWORD=${password}`])
    .join('\n')}\n`;
}

function parseCredentialFile(contents, emails) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^(SCHOOL_DEMO_[A-Z0-9_]+)=([^\r\n]*)$/);
    if (!match) continue;
    if (values.has(match[1])) throw new SchoolSeedError('The existing .env.school-demo file has duplicate keys; preserve it and resolve the duplicate before seeding.');
    values.set(match[1], match[2]);
  }
  const accounts = [
    ['SCHOOL_DEMO_REGISTRAR', emails.registrar, 'registrar'],
    ['SCHOOL_DEMO_FINANCE', emails.finance, 'finance'],
    ...emails.teachers.map((email, index) => [`SCHOOL_DEMO_TEACHER_${String(index + 1).padStart(2, '0')}`, email, `teacher${String(index + 1).padStart(2, '0')}`]),
    ...emails.students.map((email, index) => [`SCHOOL_DEMO_STUDENT_${index + 1}`, email, `student${index + 1}`])
  ];
  const passwords = {};
  for (const [prefix, email, key] of accounts) {
    const storedEmail = values.get(`${prefix}_EMAIL`);
    const password = values.get(`${prefix}_PASSWORD`);
    if (storedEmail === undefined || password === undefined) {
      throw new SchoolSeedError('The existing .env.school-demo file is incomplete; preserve it before seeding.');
    }
    if (storedEmail !== email || !/^[A-Za-z0-9_-]{32,}$/.test(password)) {
      throw new SchoolSeedError('The existing .env.school-demo aliases do not match SMTP_USER or contain an invalid password; preserve the file before seeding.');
    }
    passwords[key] = password;
  }
  if (new Set(Object.values(passwords)).size !== Object.values(passwords).length) {
    throw new SchoolSeedError('The existing .env.school-demo passwords must be unique; preserve the file before seeding.');
  }
  return { emails, passwords };
}

function loadOrCreateCredentials({
  smtpUser,
  filePath = CREDENTIAL_FILE,
  fileSystem = fs,
  randomPassword = () => crypto.randomBytes(32).toString('base64url')
}) {
  const emails = deriveSchoolEmails(smtpUser);
  const loadExisting = () => {
    const stat = fileSystem.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SchoolSeedError('.env.school-demo must be a regular local file.');
    fileSystem.chmodSync(filePath, 0o600);
    return parseCredentialFile(fileSystem.readFileSync(filePath, 'utf8'), emails);
  };
  try {
    return loadExisting();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const accountKeys = [
    'registrar', 'finance',
    ...Array.from({ length: TEACHER_COUNT }, (_unused, index) => `teacher${String(index + 1).padStart(2, '0')}`),
    'student1', 'student2', 'student3'
  ];
  const passwords = {};
  for (const key of accountKeys) {
    let password;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      password = randomPassword();
      if (typeof password === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(password) && !Object.values(passwords).includes(password)) break;
      password = undefined;
    }
    if (!password) throw new SchoolSeedError('A unique strong school demo password could not be generated.');
    passwords[key] = password;
  }
  try {
    fileSystem.writeFileSync(filePath, formatCredentials(emails, passwords), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') return loadOrCreateCredentials({ smtpUser, filePath, fileSystem, randomPassword });
    throw error;
  }
  fileSystem.chmodSync(filePath, 0o600);
  return { emails, passwords };
}

function validateCredentials(credentials, expectedEmails) {
  if (!credentials?.emails || !credentials?.passwords) throw new SchoolSeedError('School demo credentials are required before seeding.');
  const expected = [expectedEmails.registrar, expectedEmails.finance, ...expectedEmails.teachers, ...expectedEmails.students];
  const provided = [credentials.emails.registrar, credentials.emails.finance, ...(credentials.emails.teachers || []), ...(credentials.emails.students || [])];
  if (provided.length !== expected.length || provided.some((email, index) => email !== expected[index])) {
    throw new SchoolSeedError('School demo credentials do not match the configured local demo identities.');
  }
  const expectedKeys = ['registrar', 'finance', ...Array.from({ length: TEACHER_COUNT }, (_unused, index) => `teacher${String(index + 1).padStart(2, '0')}`), 'student1', 'student2', 'student3'];
  const passwords = expectedKeys.map((key) => credentials.passwords[key]);
  if (passwords.some((password) => typeof password !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(password))
    || new Set(passwords).size !== passwords.length) {
    throw new SchoolSeedError('School demo passwords must be strong, present, and unique.');
  }
}

async function hashPasswords(plan, credentials, hashPassword) {
  const accounts = [
    ...plan.staff,
    ...plan.students.filter((student) => student.loginKey).map((student) => ({ key: student.loginKey }))
  ];
  const hashes = new Map();
  for (let start = 0; start < accounts.length; start += 4) {
    const part = await Promise.all(accounts.slice(start, start + 4).map(async (account) => [
      account.key,
      await hashPassword(credentials.passwords[account.key], PASSWORD_HASH_ROUNDS)
    ]));
    for (const [key, value] of part) hashes.set(key, value);
  }
  return hashes;
}

function bindColumns(row, columns, sqlTypes, prefix) {
  const names = [];
  const expressions = [];
  for (const [index, column] of columns.entries()) {
    const paramName = `${prefix}_${index}`;
    names.push(paramName);
    expressions.push(`@${paramName}`);
    row.request.input(paramName, column.type(sqlTypes), column.value);
  }
  return { names, expressions };
}

async function insertRows({ transaction, sqlTypes, table, columns, rows, returnKeys = [] }) {
  if (!rows.length) return [];
  const resultRows = [];
  const rowsPerBatch = Math.max(1, Math.floor(PARAMETER_LIMIT / columns.length));
  for (let start = 0; start < rows.length; start += rowsPerBatch) {
    const batch = rows.slice(start, start + rowsPerBatch);
    const request = transaction.request();
    const sourceRows = batch.map((row, rowIndex) => {
      const bound = bindColumns({ request }, columns.map((column) => ({ ...column, value: row[column.name] })), sqlTypes, `p${rowIndex}`);
      return `(${bound.expressions.join(', ')})`;
    });
    const tableColumns = columns.map((column) => column.name);
    let outputSql = '';
    if (returnKeys.length) {
      const returned = returnKeys.map((_key, index) => `key${index}`).join(', ');
      const outputColumns = returnKeys.map((key) => `INSERTED.${key.name}`).join(', ');
      const declaration = returnKeys.map((key, index) => `key${index} ${key.sqlType} NOT NULL`).join(', ');
      outputSql = `DECLARE @inserted TABLE (id INT NOT NULL, ${declaration});\n`;
      outputSql += `OUTPUT INSERTED.id, ${outputColumns} INTO @inserted (id, ${returned})\n`;
      outputSql = `DECLARE @inserted TABLE (id INT NOT NULL, ${declaration});\nINSERT INTO dbo.${table} (${tableColumns.join(', ')})\n${outputSql.split('\n')[1]}\nSELECT ${tableColumns.map((column) => `source.${column}`).join(', ')} FROM (VALUES ${sourceRows.join(', ')}) AS source (${tableColumns.join(', ')});\nSELECT id, ${returned} FROM @inserted`;
    } else {
      outputSql = `INSERT INTO dbo.${table} (${tableColumns.join(', ')})\nSELECT ${tableColumns.map((column) => `source.${column}`).join(', ')} FROM (VALUES ${sourceRows.join(', ')}) AS source (${tableColumns.join(', ')})`;
    }
    const result = await request.query(`SET NOCOUNT ON;\n${outputSql}`);
    if (returnKeys.length) resultRows.push(...(result.recordset || []));
  }
  return resultRows;
}

const column = {
  int: (name, value) => ({ name, value, type: (sqlTypes) => sqlTypes.Int }),
  nvarchar: (name, length, value) => ({ name, value, type: (sqlTypes) => sqlTypes.NVarChar(length) }),
  decimal: (name, precision, scale, value) => ({ name, value, type: (sqlTypes) => sqlTypes.Decimal(precision, scale) })
};

async function hasConflict(transaction, sqlTypes, table, columnName, values) {
  for (let start = 0; start < values.length; start += PARAMETER_LIMIT) {
    const batch = values.slice(start, start + PARAMETER_LIMIT);
    const request = transaction.request();
    const parameters = batch.map((value, index) => {
      request.input(`key${index}`, sqlTypes.NVarChar(100), value);
      return `@key${index}`;
    });
    const result = await request.query(`SELECT TOP (1) 1 AS conflict FROM dbo.${table} WITH (UPDLOCK, HOLDLOCK) WHERE ${columnName} IN (${parameters.join(', ')})`);
    if (result.recordset?.length) return true;
  }
  return false;
}

async function assertNoCollisions(transaction, sqlTypes, plan) {
  const emails = [...plan.staff.map((account) => account.email), ...plan.students.filter((student) => student.email).map((student) => student.email)];
  const employeeNumbers = plan.staff.map((account) => account.employeeNo);
  const studentNumbers = plan.students.map((student) => student.studentNo);
  const lrns = plan.students.map((student) => student.lrn);
  const sectionNames = plan.sections.map((section) => section.name);
  const subjectCodes = plan.subjects.map((subject) => subject.code);
  const checks = [];
  checks.push(await hasConflict(transaction, sqlTypes, 'users', 'email', emails));
  checks.push(await hasConflict(transaction, sqlTypes, 'staff_profiles', 'employee_no', employeeNumbers));
  checks.push(await hasConflict(transaction, sqlTypes, 'students', 'student_no', studentNumbers));
  checks.push(await hasConflict(transaction, sqlTypes, 'students', 'lrn', lrns));
  checks.push(await hasConflict(transaction, sqlTypes, 'sections', 'name', sectionNames));
  checks.push(await hasConflict(transaction, sqlTypes, 'subjects', 'subject_code', subjectCodes));
  const term = await transaction.request()
    .input('schoolYear', sqlTypes.NVarChar(20), plan.term.schoolYear)
    .input('term', sqlTypes.NVarChar(30), plan.term.term)
    .query(`SELECT TOP (1) 1 AS conflict FROM dbo.academic_terms WITH (UPDLOCK, HOLDLOCK)
      WHERE school_year = @schoolYear AND term = @term`);
  if (checks.some(Boolean) || term.recordset?.length) {
    throw new SchoolSeedError('A school demo email, student number, LRN, employee number, section, subject, or term already exists without this seed marker. No records were changed.', 409);
  }
}

function requireId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`School demo ${label} insert returned no identifier.`);
  return value;
}

async function seedSchoolData({
  getDatabasePool = getPool,
  sqlTypes = sql,
  transactionFactory = (pool) => new sqlTypes.Transaction(pool),
  credentials,
  runtime = environment,
  storageDirectory = environment.upload?.storageDirectory,
  publicDirectory = PUBLIC_DIRECTORY,
  hashPassword = bcrypt.hash
} = {}) {
  assertDevelopmentTarget(runtime);
  const expectedEmails = deriveSchoolEmails(runtime.smtp?.user);
  validateCredentials(credentials, expectedEmails);
  const plan = buildSchoolPlan(expectedEmails);
  const passwordHashes = await hashPasswords(plan, credentials, hashPassword);
  const storedSamplePaths = [];
  const pool = await getDatabasePool();
  const transaction = transactionFactory(pool);
  let started = false;
  try {
    await transaction.begin(sqlTypes.ISOLATION_LEVEL.SERIALIZABLE);
    started = true;
    const baseline = await transaction.request()
      .input('baseline', sqlTypes.NVarChar(50), 'v2.001')
      .query('SELECT version FROM dbo.schema_migrations WITH (UPDLOCK, HOLDLOCK) WHERE version = @baseline');
    if (!baseline.recordset?.some((row) => row.version === 'v2.001')) {
      throw new SchoolSeedError('Apply the ARKTIESIIS_V2 consolidated baseline before seeding the school demo.');
    }

    const marker = await transaction.request()
      .input('action', sqlTypes.NVarChar(100), plan.marker.action)
      .input('entityType', sqlTypes.NVarChar(100), plan.marker.entityType)
      .input('entityId', sqlTypes.NVarChar(100), plan.marker.entityId)
      .query(`SELECT TOP (1) id FROM dbo.audit_logs WITH (UPDLOCK, HOLDLOCK)
        WHERE action = @action AND entity_type = @entityType AND entity_id = @entityId`);
    if (marker.recordset?.length) {
      const documentSamples = await seedSyntheticDocumentSamples({
        transaction, sqlTypes, plan, emails: expectedEmails, storageDirectory, publicDirectory, storedSamplePaths
      });
      await transaction.commit();
      started = false;
      return {
        alreadySeeded: true,
        documentSamplesAlreadySeeded: documentSamples.alreadySeeded,
        counts: { ...plan.counts, syntheticDocuments: documentSamples.documentCount }
      };
    }

    await assertNoCollisions(transaction, sqlTypes, plan);

    const currentTerm = await transaction.request()
      .input('isCurrent', sqlTypes.Bit, true)
      .query(`SELECT TOP (1) id FROM dbo.academic_terms WITH (UPDLOCK, HOLDLOCK)
        WHERE is_current = @isCurrent`);
    const newTermIsCurrent = !currentTerm.recordset?.length;

    const accounts = [
      ...plan.staff,
      ...plan.students.filter((student) => student.loginKey).map((student) => ({
        key: student.loginKey,
        email: student.email,
        role: 'student'
      }))
    ];
    const userRows = accounts.map((account) => ({ email: account.email, password_hash: passwordHashes.get(account.key), role: account.role, is_active: true }));
    const insertedUsers = await insertRows({
      transaction,
      sqlTypes,
      table: 'users',
      columns: [column.nvarchar('email', 255), column.nvarchar('password_hash', 255), column.nvarchar('role', 30), { name: 'is_active', value: true, type: () => sqlTypes.Bit }],
      rows: userRows,
      returnKeys: [{ name: 'email', sqlType: 'NVARCHAR(255)' }]
    });
    if (insertedUsers.length !== accounts.length) throw new Error('School demo user insert returned an incomplete identifier set.');
    const userIds = new Map(insertedUsers.map((row) => [row.key0, requireId(row.id, 'user')]));

    await insertRows({
      transaction,
      sqlTypes,
      table: 'staff_profiles',
      columns: [column.int('user_id'), column.nvarchar('employee_no', 50), column.nvarchar('first_name', 100), column.nvarchar('last_name', 100), column.nvarchar('department', 100)],
      rows: plan.staff.map((account) => ({
        user_id: userIds.get(account.email), employee_no: account.employeeNo,
        first_name: account.firstName, last_name: account.lastName, department: account.department
      }))
    });

    const termResult = await transaction.request()
      .input('schoolYear', sqlTypes.NVarChar(20), plan.term.schoolYear)
      .input('term', sqlTypes.NVarChar(30), plan.term.term)
      .input('isCurrent', sqlTypes.Bit, newTermIsCurrent)
      .query(`INSERT INTO dbo.academic_terms (school_year, term, is_current)
        OUTPUT INSERTED.id AS id VALUES (@schoolYear, @term, @isCurrent)`);
    const termId = requireId(termResult.recordset?.[0]?.id, 'academic term');

    const insertedSections = await insertRows({
      transaction,
      sqlTypes,
      table: 'sections',
      columns: [column.nvarchar('name', 100), column.nvarchar('grade_level', 50), column.int('academic_term_id')],
      rows: plan.sections.map((section) => ({ name: section.name, grade_level: section.gradeLevel, academic_term_id: termId })),
      returnKeys: [{ name: 'name', sqlType: 'NVARCHAR(100)' }]
    });
    if (insertedSections.length !== plan.sections.length) throw new Error('School demo section insert returned an incomplete identifier set.');
    const sectionIds = new Map(insertedSections.map((row) => [row.key0, requireId(row.id, 'section')]));

    const insertedSubjects = await insertRows({
      transaction,
      sqlTypes,
      table: 'subjects',
      columns: [column.nvarchar('subject_code', 50), column.nvarchar('subject_name', 200), column.decimal('units', 5, 2)],
      rows: plan.subjects.map((subject) => ({ subject_code: subject.code, subject_name: subject.name, units: subject.units })),
      returnKeys: [{ name: 'subject_code', sqlType: 'NVARCHAR(50)' }]
    });
    if (insertedSubjects.length !== plan.subjects.length) throw new Error('School demo subject insert returned an incomplete identifier set.');
    const subjectIds = new Map(insertedSubjects.map((row) => [row.key0, requireId(row.id, 'subject')]));

    const insertedStudents = await insertRows({
      transaction,
      sqlTypes,
      table: 'students',
      columns: [column.int('user_id'), column.nvarchar('student_no', 50), column.nvarchar('lrn', 12), column.nvarchar('first_name', 100), column.nvarchar('last_name', 100)],
      rows: plan.students.map((student) => ({
        user_id: student.loginKey ? userIds.get(student.email) : null,
        student_no: student.studentNo, lrn: student.lrn, first_name: student.firstName, last_name: student.lastName
      })),
      returnKeys: [{ name: 'student_no', sqlType: 'NVARCHAR(50)' }]
    });
    if (insertedStudents.length !== plan.students.length) throw new Error('School demo student insert returned an incomplete identifier set.');
    const studentIds = new Map(insertedStudents.map((row) => [row.key0, requireId(row.id, 'student')]));

    const insertedEnrollments = await insertRows({
      transaction,
      sqlTypes,
      table: 'enrollments',
      columns: [column.int('student_id'), column.int('academic_term_id'), column.int('section_id')],
      rows: plan.students.map((student) => ({ student_id: studentIds.get(student.studentNo), academic_term_id: termId, section_id: sectionIds.get(student.sectionName) })),
      returnKeys: [{ name: 'student_id', sqlType: 'INT' }]
    });
    if (insertedEnrollments.length !== plan.students.length) throw new Error('School demo enrollment insert returned an incomplete identifier set.');
    const enrollmentIds = new Map(insertedEnrollments.map((row) => [Number(row.key0), requireId(row.id, 'enrollment')]));

    const assignmentRows = plan.assignments.map((assignment) => ({
      teacher_id: userIds.get(plan.staff.find((account) => account.key === assignment.teacherKey).email),
      academic_term_id: termId,
      section_id: sectionIds.get(assignment.sectionName),
      subject_id: subjectIds.get(assignment.subjectCode),
      assigned_by: userIds.get(plan.staff.find((account) => account.key === 'registrar').email)
    }));
    const insertedAssignments = await insertRows({
      transaction,
      sqlTypes,
      table: 'teacher_assignments',
      columns: [column.int('teacher_id'), column.int('academic_term_id'), column.int('section_id'), column.int('subject_id'), column.int('assigned_by')],
      rows: assignmentRows,
      returnKeys: [{ name: 'section_id', sqlType: 'INT' }, { name: 'subject_id', sqlType: 'INT' }]
    });
    if (insertedAssignments.length !== assignmentRows.length) throw new Error('School demo teacher-assignment insert returned an incomplete identifier set.');
    const assignmentIds = new Map(insertedAssignments.map((row) => [`${row.key0}:${row.key1}`, requireId(row.id, 'teacher assignment')]));

    const schedules = plan.schedules.map((schedule) => ({
      assignment_id: assignmentIds.get(`${sectionIds.get(schedule.sectionName)}:${subjectIds.get(schedule.subjectCode)}`),
      day_of_week: schedule.dayOfWeek,
      start_time: schedule.startTime,
      end_time: schedule.endTime,
      room: schedule.room,
      created_by: userIds.get(plan.staff.find((account) => account.key === 'registrar').email)
    }));
    if (schedules.some((schedule) => !schedule.assignment_id)) throw new Error('School demo schedule plan references an unavailable teacher assignment.');
    await insertRows({
      transaction,
      sqlTypes,
      table: 'class_schedules',
      columns: [column.int('assignment_id'), { name: 'day_of_week', type: (types) => types.TinyInt }, { name: 'start_time', type: (types) => types.VarChar(5) }, { name: 'end_time', type: (types) => types.VarChar(5) }, column.nvarchar('room', 80), column.int('created_by')],
      rows: schedules
    });

    const studentSubjectRows = [];
    for (const student of plan.students) {
      const section = plan.sections.find((item) => item.name === student.sectionName);
      const enrollmentId = enrollmentIds.get(studentIds.get(student.studentNo));
      for (const subject of section.subjects) {
        studentSubjectRows.push({ enrollment_id: enrollmentId, subject_id: subjectIds.get(subject.code) });
      }
    }
    const insertedStudentSubjects = await insertRows({
      transaction,
      sqlTypes,
      table: 'student_subjects',
      columns: [column.int('enrollment_id'), column.int('subject_id')],
      rows: studentSubjectRows,
      returnKeys: [{ name: 'enrollment_id', sqlType: 'INT' }, { name: 'subject_id', sqlType: 'INT' }]
    });
    if (insertedStudentSubjects.length !== studentSubjectRows.length) throw new Error('School demo student-subject insert returned an incomplete identifier set.');
    const studentSubjectIds = new Map(insertedStudentSubjects.map((row) => [`${row.key0}:${row.key1}`, requireId(row.id, 'student subject')]));

    const registrarUserId = userIds.get(plan.staff.find((account) => account.key === 'registrar').email);
    const studentByKey = new Map(plan.students.map((student) => [student.key, student]));
    const grades = plan.grades.map((grade) => {
      const student = studentByKey.get(grade.studentKey);
      const enrollmentId = enrollmentIds.get(studentIds.get(student.studentNo));
      const subjectId = subjectIds.get(grade.subjectCode);
      const studentSubjectId = studentSubjectIds.get(`${enrollmentId}:${subjectId}`);
      return {
        student_subject_id: requireId(studentSubjectId, 'student subject grade context'),
        grading_period: grade.gradingPeriod,
        grade_value: grade.gradeValue,
        recorded_by: registrarUserId
      };
    });
    if (grades.length !== plan.counts.grades) throw new Error('School demo grade plan count did not match the expected total.');
    await insertRows({
      transaction,
      sqlTypes,
      table: 'grades',
      columns: [column.int('student_subject_id'), column.nvarchar('grading_period', 50), column.decimal('grade_value', 6, 2), column.int('recorded_by')],
      rows: grades
    });

    const insertedAccounts = await insertRows({
      transaction,
      sqlTypes,
      table: 'financial_accounts',
      columns: [column.int('student_id'), column.decimal('balance', 12, 2)],
      rows: plan.financialAccounts.map((account) => ({ student_id: studentIds.get(plan.students.find((student) => student.key === account.studentKey).studentNo), balance: account.balance })),
      returnKeys: [{ name: 'student_id', sqlType: 'INT' }]
    });
    if (insertedAccounts.length !== plan.financialAccounts.length) throw new Error('School demo finance account insert returned an incomplete identifier set.');
    const accountIds = new Map(insertedAccounts.map((row) => [Number(row.key0), requireId(row.id, 'finance account')]));
    const financeUserId = userIds.get(plan.staff.find((account) => account.key === 'finance').email);
    const transactions = plan.financialAccounts.flatMap((account) => {
      const student = plan.students.find((item) => item.key === account.studentKey);
      const accountId = accountIds.get(studentIds.get(student.studentNo));
      return account.transactions.map((entry) => ({
        financial_account_id: accountId,
        transaction_type: entry.type,
        amount: entry.amount,
        description: entry.description,
        reference_no: entry.reference,
        recorded_by: financeUserId
      }));
    });
    await insertRows({
      transaction,
      sqlTypes,
      table: 'financial_transactions',
      columns: [column.int('financial_account_id'), column.nvarchar('transaction_type', 30), column.decimal('amount', 12, 2), column.nvarchar('description', 500), column.nvarchar('reference_no', 100), column.int('recorded_by')],
      rows: transactions
    });

    const documentSamples = await seedSyntheticDocumentSamples({
      transaction, sqlTypes, plan, emails: expectedEmails, storageDirectory, publicDirectory, storedSamplePaths
    });

    await transaction.request()
      .input('action', sqlTypes.NVarChar(100), plan.marker.action)
      .input('entityType', sqlTypes.NVarChar(100), plan.marker.entityType)
      .input('entityId', sqlTypes.NVarChar(100), plan.marker.entityId)
      .input('detailsJson', sqlTypes.NVarChar(sqlTypes.MAX), JSON.stringify({
        synthetic: true,
        seedVersion: plan.version,
        schoolYear: plan.term.schoolYear,
        term: plan.term.term,
        ...plan.counts,
        documents: documentSamples.documentCount,
        documentValidations: 0,
        teacherGradeSubmissions: 0,
        classSchedules: schedules.length
      }))
      .query(`INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (NULL, @action, @entityType, @entityId, @detailsJson)`);

    await transaction.commit();
    started = false;
    return { alreadySeeded: false, counts: { ...plan.counts, syntheticDocuments: documentSamples.documentCount } };
  } catch (error) {
    if (started) {
      try {
        await transaction.rollback();
      } catch {
        // Preserve the original failure without exposing database details.
      }
    }
    for (const storedPath of storedSamplePaths) {
      try { fs.unlinkSync(storedPath); } catch { /* Keep the seed failure as the reported error. */ }
    }
    throw error;
  }
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function ensurePrivateSampleStorage(storageDirectory, publicDirectory) {
  if (typeof storageDirectory !== 'string' || !storageDirectory.trim()) {
    throw new SchoolSeedError('Set DOCUMENT_STORAGE_DIR to a private directory before applying the school demo seed.');
  }
  const storageRoot = path.resolve(storageDirectory);
  const publicRoot = path.resolve(publicDirectory);
  if (pathIsInside(publicRoot, storageRoot)) {
    throw new SchoolSeedError('Synthetic document samples must be stored outside the public web directory.');
  }
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const realStorageRoot = fs.realpathSync(storageRoot);
  const realPublicRoot = fs.realpathSync(publicRoot);
  if (pathIsInside(realPublicRoot, realStorageRoot)) {
    throw new SchoolSeedError('Synthetic document samples must be stored outside the public web directory.');
  }
  const storageStats = fs.lstatSync(storageRoot);
  if (!storageStats.isDirectory() || storageStats.isSymbolicLink()) {
    throw new SchoolSeedError('Synthetic document storage must be a real private directory.');
  }
  fs.chmodSync(storageRoot, 0o700);
  return storageRoot;
}

async function seedSyntheticDocumentSamples({
  transaction, sqlTypes, plan, emails, storageDirectory, publicDirectory, storedSamplePaths
}) {
  const marker = await transaction.request()
    .input('action', sqlTypes.NVarChar(100), DOCUMENT_SAMPLE_MARKER.action)
    .input('entityType', sqlTypes.NVarChar(100), DOCUMENT_SAMPLE_MARKER.entityType)
    .input('entityId', sqlTypes.NVarChar(100), DOCUMENT_SAMPLE_MARKER.entityId)
    .query(`SELECT TOP (1) id FROM dbo.audit_logs WITH (UPDLOCK, HOLDLOCK)
      WHERE action = @action AND entity_type = @entityType AND entity_id = @entityId`);
  if (marker.recordset?.length) return { alreadySeeded: true, documentCount: SAMPLE_FIXTURES.length };

  const fixtureBytes = SAMPLE_FIXTURES.map(({ fixturePath }) => fs.readFileSync(fixturePath));
  if (fixtureBytes.some((bytes) => !Buffer.isBuffer(bytes) || bytes.length < 1)) {
    throw new SchoolSeedError('A synthetic document fixture is unavailable.');
  }
  const storageRoot = ensurePrivateSampleStorage(storageDirectory, publicDirectory);
  const registrar = await transaction.request()
    .input('email', sqlTypes.NVarChar(255), emails.registrar)
    .query(`SELECT TOP (1) id FROM dbo.users WITH (HOLDLOCK)
      WHERE email = @email AND role = N'registrar' AND is_active = 1`);
  const registrarId = Number(registrar.recordset?.[0]?.id);
  if (!Number.isSafeInteger(registrarId) || registrarId < 1) {
    throw new SchoolSeedError('An active seeded registrar account is required for synthetic document examples.', 409);
  }

  const sampleRows = [];
  for (const [index, sample] of SAMPLE_FIXTURES.entries()) {
    const student = plan.students[sample.studentIndex];
    const studentResult = await transaction.request()
      .input('studentNo', sqlTypes.NVarChar(50), student.studentNo)
      .query('SELECT TOP (1) id FROM dbo.students WITH (HOLDLOCK) WHERE student_no = @studentNo');
    const studentId = Number(studentResult.recordset?.[0]?.id);
    if (!Number.isSafeInteger(studentId) || studentId < 1) {
      throw new SchoolSeedError('A seeded student record is required for synthetic document examples.', 409);
    }

    const storedFilename = `${crypto.randomUUID()}${sample.extension}`;
    const storedPath = path.join(storageRoot, storedFilename);
    fs.writeFileSync(storedPath, fixtureBytes[index], { flag: 'wx', mode: 0o600 });
    storedSamplePaths.push(storedPath);
    const inserted = await transaction.request()
      .input('studentId', sqlTypes.Int, studentId)
      .input('documentType', sqlTypes.NVarChar(50), sample.documentType)
      .input('originalFilename', sqlTypes.NVarChar(255), sample.originalFilename)
      .input('storedFilename', sqlTypes.NVarChar(255), storedFilename)
      .input('mimeType', sqlTypes.NVarChar(100), sample.mimeType)
      .input('fileSizeBytes', sqlTypes.BigInt, fixtureBytes[index].length)
      .input('uploadedBy', sqlTypes.Int, registrarId)
      .input('uploadSource', sqlTypes.NVarChar(30), 'registrar')
      .input('status', sqlTypes.NVarChar(30), sample.status)
      .query(`INSERT INTO dbo.documents
          (student_id, document_type, original_filename, stored_filename, mime_type, file_size_bytes, uploaded_by, upload_source, status)
        OUTPUT INSERTED.id AS id
        VALUES (@studentId, @documentType, @originalFilename, @storedFilename, @mimeType, @fileSizeBytes, @uploadedBy, @uploadSource, @status)`);
    const documentId = Number(inserted.recordset?.[0]?.id);
    if (!Number.isSafeInteger(documentId) || documentId < 1) throw new Error('Synthetic document insert returned no identifier.');
    if (sample.status === 'rejected') {
      await transaction.request()
        .input('documentId', sqlTypes.Int, documentId)
        .input('reviewerId', sqlTypes.Int, registrarId)
        .input('decisionType', sqlTypes.NVarChar(40), 'rejected')
        .input('reason', sqlTypes.NVarChar(1000), 'Synthetic defense example only; this file is not an official school record.')
        .query(`INSERT INTO dbo.document_decision_events (document_id, reviewer_id, decision_type, reason)
          VALUES (@documentId, @reviewerId, @decisionType, @reason)`);
    }
    sampleRows.push({ documentId, status: sample.status });
  }

  await transaction.request()
    .input('action', sqlTypes.NVarChar(100), DOCUMENT_SAMPLE_MARKER.action)
    .input('entityType', sqlTypes.NVarChar(100), DOCUMENT_SAMPLE_MARKER.entityType)
    .input('entityId', sqlTypes.NVarChar(100), DOCUMENT_SAMPLE_MARKER.entityId)
    .input('detailsJson', sqlTypes.NVarChar(sqlTypes.MAX), JSON.stringify({
      synthetic: true,
      documents: sampleRows.length,
      documentValidations: 0,
      statusCounts: { needs_review: 1, rejected: 1 },
      note: 'The seed includes no Gemini result or automated authenticity claim.'
    }))
    .query(`INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
      VALUES (NULL, @action, @entityType, @entityId, @detailsJson)`);
  return { alreadySeeded: false, documentCount: sampleRows.length };
}

async function main(args = process.argv.slice(2)) {
  let shouldClosePool = false;
  try {
    const { mode } = parseOptions(args, process.env.NODE_ENV || 'development');
    assertDevelopmentTarget(environment);
    const emails = deriveSchoolEmails(environment.smtp.user);
    const plan = buildSchoolPlan(emails);
    if (mode === 'dry-run') {
      process.stdout.write(`School demo preview: ${plan.counts.students} students in ${plan.counts.sections} sections across Grade 11 and Grade 12; ${plan.counts.teacherAccounts} teachers, ${plan.counts.subjects} subjects, ${plan.counts.teacherAssignments} teacher assignments, ${plan.schedules.length} class schedules, ${plan.counts.studentSubjects} subject enrollments, ${plan.counts.grades} grades, ${plan.counts.financialAccounts} reconciled finance accounts, and ${plan.counts.syntheticDocuments} synthetic private document examples. No database changes made.\n`);
      process.stdout.write('Apply requires NODE_ENV=development, --apply, and the local ARKTIESIIS_V2 database. Random login credentials are stored in ignored .env.school-demo.\n');
      return;
    }
    const credentials = loadOrCreateCredentials({ smtpUser: environment.smtp.user });
    shouldClosePool = true;
    const result = await seedSchoolData({ credentials });
    process.stdout.write(result.alreadySeeded
      ? result.documentSamplesAlreadySeeded
        ? 'School demo seed and synthetic document samples already exist; no rows were added. Credentials remain in ignored .env.school-demo.\n'
        : 'School demo records already existed; synthetic document examples were added to the private V2 seed. Credentials remain in ignored .env.school-demo.\n'
      : 'School demo records created with synthetic private document examples. Login emails and unique random passwords are in ignored .env.school-demo (owner-only permissions).\n');
  } catch (error) {
    process.stderr.write(`${error instanceof SchoolSeedError ? error.message : 'School demo seeding failed. Check local database connectivity and schema setup.'}\n`);
    process.exitCode = 1;
  } finally {
    if (shouldClosePool) {
      try {
        await closePool();
      } catch {
        // Do not print database connection details.
      }
    }
  }
}

if (require.main === module) main();

module.exports = {
  SEED_VERSION,
  SchoolSeedError,
  parseOptions,
  assertDevelopmentTarget,
  deriveSchoolEmails,
  buildSchoolPlan,
  decimalToCents,
  centsToDecimal,
  loadOrCreateCredentials,
  seedSchoolData
};
