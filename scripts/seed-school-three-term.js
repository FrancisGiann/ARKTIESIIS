const crypto = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { getPool, closePool, sql } = require('../src/config/database');
const environment = require('../src/config/environment');
const { buildSchoolPlan, deriveSchoolEmails, loadOrCreateCredentials, SchoolSeedError } = require('./seed-school');
const { REHEARSAL_DATABASE } = require('./reset-school-demo');
const { canonicalAssessmentSnapshot } = require('../src/services/annualFinanceService');

const SEED_VERSION = 'school-2026-2027-three-term-v3';
const MARKER = { action: 'school.demo_seeded', entityType: 'school_demo_seed', entityId: SEED_VERSION };
const SCHOOL_YEAR = '2026-2027';
const TERM_NAMES = ['Term 1', 'Term 2', 'Term 3'];
const STUDENT_COUNT = 320;
const STAFF_ROLES = new Set(['registrar', 'finance', 'teacher']);
const MAX_SQL_PARAMETERS = 1700;
const CREDENTIAL_FILE = path.resolve(__dirname, '../.env.school-demo');
const FICTIONAL_FEE_NOTE = 'Fictional demonstration amount; not a school-approved rate.';

const FEE_AMOUNTS_CENTS = Object.freeze({
  'Grade 11': Object.freeze({ PUB: [1_200_000n, 1_200_000n, 1_050_000n], ESC: [1_800_000n, 1_800_000n, 1_575_000n], NV: [2_400_000n, 2_400_000n, 2_100_000n] }),
  'Grade 12': Object.freeze({ PUB: [1_260_000n, 1_260_000n, 1_102_500n], ESC: [1_860_000n, 1_860_000n, 1_627_500n], NV: [2_460_000n, 2_460_000n, 2_152_500n] })
});

class ThreeTermSeedError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ThreeTermSeedError';
    this.status = status;
  }
}

function parseOptions(args, nodeEnv = process.env.NODE_ENV || 'development') {
  if (nodeEnv !== 'development') throw new ThreeTermSeedError('School demo data can only be seeded when NODE_ENV=development.');
  if (!Array.isArray(args) || args.length !== 1 || !['--dry-run', '--apply'].includes(args[0])) {
    throw new ThreeTermSeedError('Choose exactly one option: --dry-run or --apply.');
  }
  return { mode: args[0] === '--apply' ? 'apply' : 'dry-run' };
}

function isLoopback(value) {
  return new Set(['localhost', '127.0.0.1', '::1']).has(String(value || '').trim().toLowerCase());
}

function assertDevelopmentTarget(configuration = environment) {
  if (configuration.nodeEnv !== 'development') throw new ThreeTermSeedError('School demo data can only be seeded when NODE_ENV=development.');
  const database = configuration.database || {};
  if (!isLoopback(database.server) || (database.database !== 'ARKTIESIIS_V2' && !REHEARSAL_DATABASE.test(String(database.database || '')))) {
    throw new ThreeTermSeedError('School demo data can only be seeded into local ARKTIESIIS_V2 or its isolated rehearsal database.');
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function money(cents) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function decimalToCents(value) {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new ThreeTermSeedError('A fictional schedule amount is not a valid decimal currency value.');
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0') || '0');
  return match[1] ? -cents : cents;
}

function timeValue(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!match) throw new ThreeTermSeedError('A fictional class schedule time is invalid.');
  return new Date(Date.UTC(1970, 0, 1, Number(match[1]), Number(match[2]), 0));
}

function studentEntryTerm(ordinal) {
  if (ordinal <= 300) return 1;
  if (ordinal <= 312) return 2;
  return 3;
}

function departureFor(ordinal) {
  if (ordinal >= 41 && ordinal <= 50) return { termNumber: 2, type: 'dropped' };
  if (ordinal >= 61 && ordinal <= 70) return { termNumber: 3, type: 'transferred' };
  return null;
}

function buildThreeTermPlan(emails) {
  const base = buildSchoolPlan(emails);
  if (base.students.length !== STUDENT_COUNT) throw new ThreeTermSeedError('The synthetic roster size changed; review the plan before seeding.');
  const students = base.students.map((student, index) => {
    const ordinal = index + 1;
    const entryTermNumber = studentEntryTerm(ordinal);
    const departure = departureFor(ordinal);
    const pendingActivation = ordinal >= 21 && ordinal <= 28;
    const futurePendingTermNumber = ordinal >= 101 && ordinal <= 110 ? 2 : null;
    const voucherCode = ordinal % 5 < 3 ? 'PUB' : ordinal % 5 === 3 ? 'ESC' : 'NV';
    const eligibleTerms = TERM_NAMES.map((_term, termIndex) => termIndex + 1)
      .filter((termNumber) => termNumber >= entryTermNumber && (!departure || termNumber < departure.termNumber));
    const waiverTermNumber = !pendingActivation && ordinal % 30 === 0
      ? eligibleTerms[(Math.floor(ordinal / 30) - 1) % eligibleTerms.length] : null;
    const adjustmentTermNumber = !pendingActivation && !waiverTermNumber && ordinal % 37 === 1
      ? eligibleTerms[(Math.floor(ordinal / 37) - 1) % eligibleTerms.length] : null;
    return {
      ...student,
      gradeLevel: `Grade ${student.grade}`,
      ordinal,
      annualEnrollmentKey: `annual-${String(ordinal).padStart(4, '0')}`,
      voucherCode,
      voucherCategory: voucherCode === 'ESC' ? ['A', 'B', 'C', 'D', 'E'][ordinal % 5] : null,
      intakeKind: entryTermNumber > 1 ? 'transferee' : ordinal % 2 === 0 ? 'returning' : 'new',
      entryTermNumber,
      enrollmentStartDate: ['2026-06-15', '2026-10-15', '2027-01-15'][entryTermNumber - 1],
      pendingActivation,
      futurePendingTermNumber,
      departure,
      waiverTermNumber,
      adjustmentTermNumber
    };
  });

  const terms = TERM_NAMES.map((term, index) => ({ term, termNumber: index + 1, schoolYear: SCHOOL_YEAR, isCurrent: index === 0 }));
  const termSections = terms.flatMap((term) => base.sections.map((section) => ({
    ...section,
    termNumber: term.termNumber,
    term,
    key: `${term.termNumber}:${section.name}`,
    cluster: section.strand,
    adviser: null,
    modality: 'onsite',
    modularSubtype: null
  })));
  const termAssignments = terms.flatMap((term) => base.assignments.map((assignment) => ({
    ...assignment,
    termNumber: term.termNumber,
    sectionKey: `${term.termNumber}:${assignment.sectionName}`,
    key: `${term.termNumber}:${assignment.sectionName}:${assignment.subjectCode}`
  })));
  const termSchedules = terms.flatMap((term) => base.schedules.map((schedule) => ({
    ...schedule,
    termNumber: term.termNumber,
    assignmentKey: `${term.termNumber}:${schedule.sectionName}:${schedule.subjectCode}`
  })));

  const scheduleRows = [];
  for (const gradeLevel of ['Grade 11', 'Grade 12']) {
    for (const voucherCode of ['PUB', 'ESC', 'NV']) {
      const scheduleKey = `${gradeLevel}:${voucherCode}`;
      TERM_NAMES.forEach((_term, index) => {
        const tuitionAmount = money(FEE_AMOUNTS_CENTS[gradeLevel][voucherCode][index]);
        const miscAmount = money(BigInt(125_000 + index * 25_000 + (voucherCode === 'PUB' ? 0 : voucherCode === 'ESC' ? 50_000 : 25_000)));
        ['DP', 'Prelim', 'Midterm', 'Finals'].forEach((installment, installmentIndex) => scheduleRows.push({
          scheduleKey,
          termNumber: index + 1,
          feeCategory: 'tuition',
          lineName: 'Tuition',
          installment,
          amount: installmentIndex === 0 ? tuitionAmount : '0.00'
        }));
        scheduleRows.push({
          scheduleKey,
          termNumber: index + 1,
          feeCategory: 'miscellaneous',
          lineName: 'Fictional demo misc. (not school-approved)',
          installment: `Term ${index + 1} fictional misc.`,
          amount: miscAmount
        });
      });
    }
  }

  const paymentActions = [];
  for (const student of students) {
    if (student.pendingActivation) continue;
    const scheduleKey = `${student.gradeLevel}:${student.voucherCode}`;
    const eligibleTerms = TERM_NAMES.map((_term, index) => index + 1)
      .filter((termNumber) => termNumber >= student.entryTermNumber
        && (!student.departure || termNumber < student.departure.termNumber));
    for (const termNumber of eligibleTerms) {
      if (termNumber === student.waiverTermNumber || termNumber === student.adjustmentTermNumber) continue;
      const charges = scheduleRows.filter((line) => line.scheduleKey === scheduleKey && line.termNumber === termNumber);
      if (student.futurePendingTermNumber === termNumber) continue;
      const totalCents = charges.reduce((sum, line) => sum + decimalToCents(line.amount), 0n);
      const cycle = (student.ordinal + termNumber) % 5;
      const mode = termNumber === 3 && student.ordinal % 12 === 0
        ? 'future-prepay' : ['settled', 'partial', 'credit', 'reversed', 'unpaid'][cycle];
      if (mode === 'unpaid') continue;
      const targetCents = mode === 'partial' ? totalCents / 2n : totalCents;
      let remaining = targetCents;
      const allocations = [];
      for (const line of charges) {
        const lineCents = decimalToCents(line.amount);
        const amountCents = remaining < lineCents ? remaining : lineCents;
        if (amountCents > 0n) allocations.push({ termNumber, feeCategory: line.feeCategory, amount: money(amountCents) });
        remaining -= amountCents;
        if (remaining <= 0n) break;
      }
      paymentActions.push({
        studentKey: student.key,
        ordinal: student.ordinal,
        termNumber,
        mode,
        amount: money(mode === 'credit' ? totalCents + 50_000n : targetCents),
        paymentDate: mode === 'future-prepay' ? '2026-07-10' : ['2026-07-10', '2026-10-10', '2027-01-10'][termNumber - 1],
        allocations
      });
    }
  }

  const applicablePlacements = students.reduce((sum, student) => sum + (4 - student.entryTermNumber), 0);
  const academicPlacements = students.reduce((sum, student) => {
    const lastAcademicTerm = student.departure?.termNumber || 4;
    return sum + (student.pendingActivation ? 0 : TERM_NAMES.filter((_term, index) => index + 1 >= student.entryTermNumber
      && index + 1 < lastAcademicTerm && student.futurePendingTermNumber !== index + 1).length);
  }, 0);
  const annualAssessmentCount = students.filter((student) => !student.pendingActivation).length;
  const charges = students.filter((student) => !student.pendingActivation)
    .reduce((sum, student) => sum + TERM_NAMES.filter((_term, index) => index + 1 >= student.entryTermNumber
      && index + 1 < (student.departure?.termNumber || 4)).length * 2, 0);
  const waiverCount = students.filter((student) => student.waiverTermNumber).length;
  const adjustmentTermCount = students.filter((student) => student.adjustmentTermNumber).length;
  const allocationCount = paymentActions.reduce((sum, action) => sum + action.allocations.length, 0);
  const counts = {
    students: students.length,
    studentLoginAccounts: students.filter((student) => student.loginKey).length,
    staffAccounts: base.staff.length,
    terms: terms.length,
    annualEnrollments: students.length,
    placements: students.length * terms.length,
    sections: termSections.length,
    subjects: base.subjects.length,
    teacherAssignments: termAssignments.length,
    classSchedules: termSchedules.length,
    studentSubjects: academicPlacements * 7,
    grades: academicPlacements * 7 * base.gradingPeriods.length,
    financeSchedules: 6,
    financeScheduleLines: scheduleRows.length,
    assessments: annualAssessmentCount,
    registrarConfirmations: annualAssessmentCount,
    assessedCharges: charges,
    waiverCases: waiverCount,
    paymentAdjustments: waiverCount * 2 + adjustmentTermCount * 2,
    payments: paymentActions.length,
    allocations: allocationCount,
    paymentReversals: paymentActions.filter((action) => action.mode === 'reversed').length,
    paymentReversedFlags: paymentActions.filter((action) => action.mode === 'reversed').length,
    futurePrepayments: paymentActions.filter((action) => action.mode === 'future-prepay').length,
    departureCases: students.filter((student) => student.departure).length,
    pendingActivation: students.filter((student) => student.pendingActivation).length,
    futurePendingActivations: students.filter((student) => student.futurePendingTermNumber).length,
    fictionalFeeRates: true,
    schoolApprovedRates: false
  };
  return {
    version: SEED_VERSION, marker: MARKER, schoolYear: SCHOOL_YEAR, terms, students, staff: base.staff,
    sections: termSections, subjects: base.subjects, assignments: termAssignments, schedules: termSchedules,
    gradingPeriods: base.gradingPeriods, grades: base.grades, scheduleRows, paymentActions,
    counts, applicabilityCount: applicablePlacements
  };
}

function sqlType(type, sqlDriver = sql) {
  if (typeof type === 'function') return type(sqlDriver);
  if (type === 'int') return sqlDriver.Int;
  if (type === 'bigint') return sqlDriver.BigInt;
  if (type === 'tinyint') return sqlDriver.TinyInt;
  if (type === 'bit') return sqlDriver.Bit;
  if (type === 'date') return sqlDriver.Date;
  if (type === 'datetime2') return sqlDriver.DateTime2;
  if (type === 'uniqueidentifier') return sqlDriver.UniqueIdentifier;
  if (type === 'char64') return sqlDriver.Char(64);
  if (type === 'decimal') return sqlDriver.Decimal(12, 2);
  if (type === 'time-text') return sqlDriver.Time(0);
  const nvarchar = /^nvarchar:(\d+|max)$/.exec(type);
  if (nvarchar) return sqlDriver.NVarChar(nvarchar[1] === 'max' ? sqlDriver.MAX : Number(nvarchar[1]));
  throw new ThreeTermSeedError(`Unsupported seed column type: ${type}`);
}

async function insertRows({ transaction, sqlDriver = sql, table, columns, rows, keyColumns = [], outputId = true }) {
  if (!rows.length) return [];
  const batchSize = Math.max(1, Math.floor(MAX_SQL_PARAMETERS / columns.length));
  const insertedRows = [];
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const chunk = rows.slice(offset, offset + batchSize);
    const request = transaction.request();
    const valueTuples = chunk.map((row, rowIndex) => `(${columns.map((column, columnIndex) => {
      const parameter = `r${rowIndex}_${columnIndex}`;
      request.input(parameter, sqlType(column.type, sqlDriver), row[column.name] ?? null);
      return `@${parameter}`;
    }).join(', ')})`);
    const outputKeys = keyColumns.map((column, index) => `, INSERTED.[${column}] AS [key${index}]`).join('');
    const outputIdentity = outputId ? 'INSERTED.id AS id' : `INSERTED.[${keyColumns[0]}] AS key0${keyColumns.slice(1).map((column, index) => `, INSERTED.[${column}] AS [key${index + 1}]`).join('')}`;
    const outputClause = `OUTPUT ${outputIdentity}${outputId ? outputKeys : ''}`;
    const statementParts = [`INSERT INTO dbo.[${table}] (${columns.map((column) => `[${column.name}]`).join(', ')})`,
      table === 'students' ? '' : outputClause, `VALUES ${valueTuples.join(', ')}`];
    if (table === 'students') {
      const keyColumn = keyColumns[0];
      const keyIndex = columns.findIndex((column) => column.name === keyColumn);
      if (!outputId || keyColumns.length !== 1 || keyIndex < 0) {
        throw new ThreeTermSeedError('Student inserts require one stable natural key for trigger-safe identifier lookup.');
      }
      const keyParameters = chunk.map((_, rowIndex) => `@r${rowIndex}_${keyIndex}`);
      statementParts.push(`SELECT [id] AS [id], [${keyColumn}] AS [key0] FROM dbo.[${table}]
        WHERE [${keyColumn}] IN (${keyParameters.join(', ')})`);
    }
    const statement = statementParts.filter(Boolean).join('\n');
    const result = await request.query(statement);
    insertedRows.push(...(result.recordset || []));
  }
  if (insertedRows.length !== rows.length) throw new Error(`Three-term seed insert into ${table} returned an incomplete identifier set.`);
  return insertedRows;
}

function mapInserted(rows) {
  return new Map(rows.map((row) => [row.key0, Number(row.id)]));
}

function mapSectionIds(rows, termIds) {
  const termNumberById = new Map([...termIds.entries()].map(([termName, id]) => [
    Number(id), TERM_NAMES.indexOf(termName) + 1
  ]));
  return new Map(rows.map((row) => {
    const termNumber = termNumberById.get(Number(row.key1));
    if (!termNumber || !row.key0) throw new ThreeTermSeedError('A seeded section could not be matched to its configured term.');
    return [`${termNumber}:${row.key0}`, Number(row.id)];
  }));
}

function multiKey(row, keys) {
  return keys.map((key) => String(row[key])).join(':');
}

function fingerprint(value) { return sha256(value); }

async function requireLatestSchema(transaction) {
  const result = await transaction.request().query(`SELECT version FROM dbo.schema_migrations
    WHERE version IN (N'v2.001', N'v2.005', N'v2.006', N'v2.008', N'v2.009')`);
  const versions = new Set((result.recordset || []).map((row) => row.version));
  if (['v2.001', 'v2.005', 'v2.006', 'v2.008', 'v2.009'].some((version) => !versions.has(version))) {
    throw new ThreeTermSeedError('Apply the V2 baseline and registrar/finance migrations through v2.009 before seeding the three-term demo.');
  }
}

async function assertNoOtherSessions(transaction) {
  const result = await transaction.request().query(`SELECT session_id FROM sys.dm_exec_sessions
    WHERE database_id = DB_ID() AND is_user_process = 1 AND session_id <> @@SPID`);
  if (result.recordset?.length) throw new ThreeTermSeedError('Stop the application and other V2 clients before applying the school demo seed.');
}

async function loadStaff(transaction, plan, credentials, { hashPassword = bcrypt.hash, comparePassword = bcrypt.compare, sqlDriver = sql } = {}) {
  const roles = [...STAFF_ROLES].map((role) => `'${role}'`).join(', ');
  const result = await transaction.request().query(`SELECT user_record.id, user_record.email, user_record.password_hash AS passwordHash,
      user_record.role, user_record.is_active AS isActive, profile.employee_no AS employeeNo,
      profile.first_name AS firstName, profile.last_name AS lastName, profile.department
    FROM dbo.users AS user_record LEFT JOIN dbo.staff_profiles AS profile ON profile.user_id = user_record.id
    WHERE user_record.role IN (${roles}) ORDER BY user_record.id`);
  const rows = result.recordset || [];
  const accountsByEmail = new Map(rows.map((row) => [String(row.email).toLowerCase(), row]));
  const profileCountResult = await transaction.request().query('SELECT COUNT_BIG(*) AS total FROM dbo.staff_profiles');
  const totalProfiles = Number(profileCountResult.recordset?.[0]?.total || 0);
  if (rows.length === 0 && totalProfiles === 0) {
    const hashes = new Map();
    for (const account of plan.staff) hashes.set(account.key, await hashPassword(credentials.passwords[account.key], 12));
    const insertedUsers = await insertRows({ transaction, sqlDriver, table: 'users', columns: [
      { name: 'email', type: 'nvarchar:255' }, { name: 'password_hash', type: 'nvarchar:255' },
      { name: 'role', type: 'nvarchar:30' }, { name: 'is_active', type: 'bit' }
    ], rows: plan.staff.map((account) => ({ email: account.email, password_hash: hashes.get(account.key), role: account.role, is_active: true })), keyColumns: ['email'] });
    const ids = mapInserted(insertedUsers);
    const profiles = plan.staff.map((account) => ({ user_id: ids.get(account.email), employee_no: account.employeeNo,
      first_name: account.firstName, last_name: account.lastName, department: account.department }));
    await insertRows({ transaction, sqlDriver, table: 'staff_profiles', columns: [
      { name: 'user_id', type: 'int' }, { name: 'employee_no', type: 'nvarchar:50' },
      { name: 'first_name', type: 'nvarchar:100' }, { name: 'last_name', type: 'nvarchar:100' },
      { name: 'department', type: 'nvarchar:100' }
    ], rows: profiles });
    return { ids, created: true };
  }
  if (rows.length !== plan.staff.length || totalProfiles !== plan.staff.length) {
    throw new ThreeTermSeedError('The database has a partial or unrecognized staff set; no staff accounts or profiles were changed.', 409);
  }
  const ids = new Map();
  for (const account of plan.staff) {
    const row = accountsByEmail.get(account.email.toLowerCase());
    if (!row || row.role !== account.role || row.isActive !== true && row.isActive !== 1
      || row.employeeNo !== account.employeeNo || row.firstName !== account.firstName || row.lastName !== account.lastName
      || row.department !== account.department || typeof row.passwordHash !== 'string'
      || !await comparePassword(credentials.passwords[account.key], row.passwordHash)) {
      throw new ThreeTermSeedError('Existing staff emails, roles, profiles, or saved credentials differ from the demo manifest; no staff data was changed.', 409);
    }
    ids.set(account.email, Number(row.id));
  }
  return { ids, created: false };
}

async function assertEmptyDemoTables(transaction) {
  const result = await transaction.request().query(`SELECT
      (SELECT COUNT_BIG(*) FROM dbo.students) AS students,
      (SELECT COUNT_BIG(*) FROM dbo.academic_terms) AS academicTerms,
      (SELECT COUNT_BIG(*) FROM dbo.sections) AS sections,
      (SELECT COUNT_BIG(*) FROM dbo.subjects) AS subjects,
      (SELECT COUNT_BIG(*) FROM dbo.enrollments) AS enrollments,
      (SELECT COUNT_BIG(*) FROM dbo.annual_enrollments) AS annualEnrollments,
      (SELECT COUNT_BIG(*) FROM dbo.school_year_term_order) AS configuredTerms,
      (SELECT COUNT_BIG(*) FROM dbo.teacher_assignments) AS teacherAssignments,
      (SELECT COUNT_BIG(*) FROM dbo.class_schedules) AS classSchedules,
      (SELECT COUNT_BIG(*) FROM dbo.student_subjects) AS studentSubjects,
      (SELECT COUNT_BIG(*) FROM dbo.grades) AS grades,
      (SELECT COUNT_BIG(*) FROM dbo.documents) AS documents,
      (SELECT COUNT_BIG(*) FROM dbo.financial_accounts) AS financialAccounts,
      (SELECT COUNT_BIG(*) FROM dbo.financial_transactions) AS financialTransactions,
      (SELECT COUNT_BIG(*) FROM dbo.finance_schedules) AS financeSchedules,
      (SELECT COUNT_BIG(*) FROM dbo.finance_schedule_lines) AS financeScheduleLines,
      (SELECT COUNT_BIG(*) FROM dbo.annual_assessments) AS annualAssessments,
      (SELECT COUNT_BIG(*) FROM dbo.assessed_charges) AS assessedCharges,
      (SELECT COUNT_BIG(*) FROM dbo.annual_registrar_confirmations) AS registrarConfirmations,
      (SELECT COUNT_BIG(*) FROM dbo.annual_enrollment_events) AS annualEnrollmentEvents,
      (SELECT COUNT_BIG(*) FROM dbo.annual_workflow_events) AS annualWorkflowEvents,
      (SELECT COUNT_BIG(*) FROM dbo.finance_charge_adjustments) AS financeChargeAdjustments,
      (SELECT COUNT_BIG(*) FROM dbo.finance_exemption_cases) AS financeExemptionCases,
      (SELECT COUNT_BIG(*) FROM dbo.finance_exemption_rules) AS financeExemptionRules,
      (SELECT COUNT_BIG(*) FROM dbo.finance_exemption_applications) AS financeExemptionApplications,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payments) AS financePayments,
      (SELECT COUNT_BIG(*) FROM dbo.finance_allocation_batches) AS financeAllocationBatches,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payment_allocations) AS financePaymentAllocations,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payment_reversals) AS financePaymentReversals,
      (SELECT COUNT_BIG(*) FROM dbo.finance_departure_cases) AS financeDepartureCases,
      (SELECT COUNT_BIG(*) FROM dbo.finance_departure_case_terms) AS financeDepartureCaseTerms`);
  const counts = result.recordset?.[0] || {};
  const nonempty = Object.entries(counts).filter(([, count]) => Number(count) !== 0).map(([table]) => table);
  if (nonempty.length) throw new ThreeTermSeedError(`Seed refused because demo tables are not empty: ${nonempty.join(', ')}.`, 409);
}

function createScheduleLines(plan) {
  return plan.scheduleRows.map((line) => ({
    scheduleKey: line.scheduleKey, termNumber: line.termNumber, feeCategory: line.feeCategory,
    lineName: line.lineName, installment: line.installment, amount: line.amount,
    isOptional: false
  }));
}

async function insertSeedRows(transaction, plan, staffIds, credentials, { sqlDriver = sql, hashPassword = bcrypt.hash } = {}) {
  const studentAccountHashes = new Map();
  for (const student of plan.students.filter((row) => row.loginKey)) {
    studentAccountHashes.set(student.email, await hashPassword(credentials.passwords[student.loginKey], 12));
  }
  const studentUsers = await insertRows({ transaction, sqlDriver, table: 'users', columns: [
    { name: 'email', type: 'nvarchar:255' }, { name: 'password_hash', type: 'nvarchar:255' },
    { name: 'role', type: 'nvarchar:30' }, { name: 'is_active', type: 'bit' }
  ], rows: plan.students.filter((student) => student.loginKey).map((student) => ({
    email: student.email, password_hash: studentAccountHashes.get(student.email), role: 'student', is_active: true
  })), keyColumns: ['email'] });
  const studentUserIds = mapInserted(studentUsers);

  const termRows = await insertRows({ transaction, sqlDriver, table: 'academic_terms', columns: [
    { name: 'school_year', type: 'nvarchar:20' }, { name: 'term', type: 'nvarchar:30' }, { name: 'is_current', type: 'bit' }
  ], rows: plan.terms.map((term) => ({ school_year: term.schoolYear, term: term.term, is_current: term.isCurrent })), keyColumns: ['term'] });
  const termIds = mapInserted(termRows);
  const termOrderRows = plan.terms.map((term) => ({ school_year: term.schoolYear, term_number: term.termNumber,
    academic_term_id: termIds.get(term.term), configured_by: staffIds.get(plan.staff.find((staff) => staff.key === 'registrar').email),
    configuration_source: 'staff' }));
  await insertRows({ transaction, sqlDriver, table: 'school_year_term_order', columns: [
    { name: 'school_year', type: 'nvarchar:20' }, { name: 'term_number', type: 'tinyint' }, { name: 'academic_term_id', type: 'int' },
    { name: 'configured_by', type: 'int' }, { name: 'configuration_source', type: 'nvarchar:40' }
  ], rows: termOrderRows });

  const sectionsInserted = await insertRows({ transaction, sqlDriver, table: 'sections', columns: [
    { name: 'name', type: 'nvarchar:100' }, { name: 'grade_level', type: 'nvarchar:50' }, { name: 'academic_term_id', type: 'int' },
    { name: 'cluster', type: 'nvarchar:80' }, { name: 'strand', type: 'nvarchar:80' }, { name: 'adviser', type: 'nvarchar:160' },
    { name: 'modality', type: 'nvarchar:30' }, { name: 'modular_subtype', type: 'nvarchar:80' }
  ], rows: plan.sections.map((section) => ({ name: section.name, grade_level: section.gradeLevel,
    academic_term_id: termIds.get(section.term.term), cluster: section.cluster, strand: section.strand,
    adviser: section.adviser, modality: section.modality, modular_subtype: section.modularSubtype })), keyColumns: ['name', 'academic_term_id'] });
  const sectionIds = mapSectionIds(sectionsInserted, termIds);

  const subjectRows = await insertRows({ transaction, sqlDriver, table: 'subjects', columns: [
    { name: 'subject_code', type: 'nvarchar:50' }, { name: 'subject_name', type: 'nvarchar:200' }, { name: 'units', type: 'decimal' }
  ], rows: plan.subjects.map((subject) => ({ subject_code: subject.code, subject_name: subject.name, units: subject.units })), keyColumns: ['subject_code'] });
  const subjectIds = mapInserted(subjectRows);

  const insertedStudents = await insertRows({ transaction, sqlDriver, table: 'students', columns: [
    { name: 'user_id', type: 'int' }, { name: 'student_no', type: 'nvarchar:50' }, { name: 'lrn', type: 'nvarchar:12' },
    { name: 'first_name', type: 'nvarchar:100' }, { name: 'last_name', type: 'nvarchar:100' }, { name: 'status', type: 'nvarchar:30' }
  ], rows: plan.students.map((student) => ({ user_id: student.loginKey ? studentUserIds.get(student.email) : null,
    student_no: student.studentNo, lrn: student.lrn, first_name: student.firstName, last_name: student.lastName, status: 'active' })), keyColumns: ['student_no'] });
  const studentIds = mapInserted(insertedStudents);

  const annualRows = await insertRows({ transaction, sqlDriver, table: 'annual_enrollments', columns: [
    { name: 'student_id', type: 'int' }, { name: 'school_year', type: 'nvarchar:20' }, { name: 'grade_level', type: 'nvarchar:50' },
    { name: 'voucher_code', type: 'nvarchar:10' }, { name: 'voucher_category', type: 'nvarchar:1' },
    { name: 'intake_status', type: 'nvarchar:20' }, { name: 'account_activation_pending', type: 'bit' },
    { name: 'created_by', type: 'int' }, { name: 'idempotency_key', type: 'uniqueidentifier' },
    { name: 'request_fingerprint', type: 'char64' }, { name: 'intake_kind', type: 'nvarchar:20' },
    { name: 'entry_term_number', type: 'tinyint' }, { name: 'enrollment_start_date', type: 'date' }
  ], rows: plan.students.map((student) => {
    const request = { studentNo: student.studentNo, schoolYear: SCHOOL_YEAR, voucherCode: student.voucherCode,
      gradeLevel: student.gradeLevel, entryTermNumber: student.entryTermNumber };
    return { student_id: studentIds.get(student.studentNo), school_year: SCHOOL_YEAR, grade_level: student.gradeLevel,
      voucher_code: student.voucherCode, voucher_category: student.voucherCategory,
      intake_status: student.pendingActivation ? 'pending' : 'enrolled', account_activation_pending: student.pendingActivation,
      created_by: staffIds.get(plan.staff.find((staff) => staff.key === 'registrar').email), idempotency_key: crypto.randomUUID(),
      request_fingerprint: fingerprint(request), intake_kind: student.intakeKind,
      entry_term_number: student.entryTermNumber, enrollment_start_date: student.enrollmentStartDate };
  }), keyColumns: ['student_id'] });
  const annualIds = mapInserted(annualRows);
  const eventRows = plan.students.map((student) => ({ annual_enrollment_id: annualIds.get(studentIds.get(student.studentNo)),
    enrollment_id: null, actor_id: staffIds.get(plan.staff.find((staff) => staff.key === 'registrar').email),
    event_type: 'created', reason: 'Fictional three-term school demo intake.', idempotency_key: crypto.randomUUID(),
    request_fingerprint: fingerprint({ studentNo: student.studentNo, eventType: 'created' }) }));
  await insertRows({ transaction, sqlDriver, table: 'annual_enrollment_events', columns: [
    { name: 'annual_enrollment_id', type: 'int' }, { name: 'enrollment_id', type: 'int' }, { name: 'actor_id', type: 'int' },
    { name: 'event_type', type: 'nvarchar:40' }, { name: 'reason', type: 'nvarchar:1000' },
    { name: 'idempotency_key', type: 'uniqueidentifier' }, { name: 'request_fingerprint', type: 'char64' }
  ], rows: eventRows });

  const enrollmentRows = [];
  for (const student of plan.students) {
    for (const term of plan.terms) {
      const beforeEntry = term.termNumber < student.entryTermNumber;
      const applicable = !beforeEntry;
      const placementIsAfterDeparture = student.departure && term.termNumber >= student.departure.termNumber;
      const futureActivationPending = student.futurePendingTermNumber === term.termNumber;
      const status = beforeEntry ? 'not_applicable'
        : student.pendingActivation ? 'pending_payment'
          : placementIsAfterDeparture ? student.departure.type
            : futureActivationPending ? 'pending_payment' : 'enrolled';
      const finalizedAt = status === 'enrolled' ? new Date(Date.UTC(2026, 6 + (term.termNumber - 1) * 3, 1)) : null;
      const sectionKey = `${term.termNumber}:${student.sectionName}`;
      enrollmentRows.push({ student_id: studentIds.get(student.studentNo), academic_term_id: termIds.get(term.term),
        section_id: applicable ? sectionIds.get(sectionKey) : null, enrollment_status: status,
        finalized_at: finalizedAt, annual_enrollment_id: annualIds.get(studentIds.get(student.studentNo)),
        annual_term_number: term.termNumber, term_scope_status: applicable ? 'applicable' : 'not_applicable' });
    }
  }
  const enrolled = await insertRows({ transaction, sqlDriver, table: 'enrollments', columns: [
    { name: 'student_id', type: 'int' }, { name: 'academic_term_id', type: 'int' }, { name: 'section_id', type: 'int' },
    { name: 'enrollment_status', type: 'nvarchar:30' }, { name: 'finalized_at', type: 'datetime2' },
    { name: 'annual_enrollment_id', type: 'int' }, { name: 'annual_term_number', type: 'tinyint' },
    { name: 'term_scope_status', type: 'nvarchar:20' }
  ], rows: enrollmentRows, keyColumns: ['annual_enrollment_id', 'annual_term_number'] });
  const enrollmentIds = new Map(enrolled.map((row) => [`${row.key0}:${row.key1}`, Number(row.id)]));

  const departureStudents = plan.students.filter((student) => student.departure);
  const departures = await insertRows({ transaction, sqlDriver, table: 'finance_departure_cases', columns: [
    { name: 'annual_enrollment_id', type: 'int' }, { name: 'effective_enrollment_id', type: 'int' },
    { name: 'effective_date', type: 'date' }, { name: 'departure_type', type: 'nvarchar:20' },
    { name: 'reason', type: 'nvarchar:1000' }, { name: 'recorded_by', type: 'int' },
    { name: 'idempotency_key', type: 'uniqueidentifier' }, { name: 'request_fingerprint', type: 'char64' }
  ], rows: departureStudents.map((student) => {
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    const effectiveEnrollmentId = enrollmentIds.get(`${annualId}:${student.departure.termNumber}`);
    const details = { annualEnrollmentId: annualId, effectiveEnrollmentId, termNumber: student.departure.termNumber, type: student.departure.type };
    return { annual_enrollment_id: annualId, effective_enrollment_id: effectiveEnrollmentId,
      effective_date: student.departure.termNumber === 2 ? '2026-10-15' : '2027-01-15',
      departure_type: student.departure.type, reason: 'Fictional demo departure record for workflow display.',
      recorded_by: staffIds.get(plan.staff.find((staff) => staff.key === 'registrar').email),
      idempotency_key: crypto.randomUUID(), request_fingerprint: fingerprint(details) };
  }), keyColumns: ['annual_enrollment_id'] });
  const departureIds = new Map(departures.map((row) => [row.key0, Number(row.id)]));
  const departureTermRows = [];
  const departureEvents = [];
  for (const student of departureStudents) {
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    for (const term of plan.terms.filter((candidate) => candidate.termNumber >= student.departure.termNumber)) {
      const enrollmentId = enrollmentIds.get(`${annualId}:${term.termNumber}`);
      departureTermRows.push({ departure_case_id: departureIds.get(annualId), enrollment_id: enrollmentId,
        academic_activity_review_required: false });
      departureEvents.push({ annual_enrollment_id: annualId, enrollment_id: enrollmentId,
        actor_id: staffIds.get(plan.staff.find((staff) => staff.key === 'registrar').email), event_type: 'departure_recorded',
        reason: 'Fictional demo departure record for workflow display.' });
    }
  }
  await insertRows({ transaction, sqlDriver, table: 'finance_departure_case_terms', columns: [
    { name: 'departure_case_id', type: 'bigint' }, { name: 'enrollment_id', type: 'int' },
    { name: 'academic_activity_review_required', type: 'bit' }
  ], rows: departureTermRows, keyColumns: ['departure_case_id', 'enrollment_id'], outputId: false });
  await insertRows({ transaction, sqlDriver, table: 'annual_workflow_events', columns: [
    { name: 'annual_enrollment_id', type: 'int' }, { name: 'enrollment_id', type: 'int' },
    { name: 'actor_id', type: 'int' }, { name: 'event_type', type: 'nvarchar:40' }, { name: 'reason', type: 'nvarchar:1000' }
  ], rows: departureEvents });

  const assignmentRows = await insertRows({ transaction, sqlDriver, table: 'teacher_assignments', columns: [
    { name: 'teacher_id', type: 'int' }, { name: 'academic_term_id', type: 'int' }, { name: 'section_id', type: 'int' },
    { name: 'subject_id', type: 'int' }, { name: 'assigned_by', type: 'int' }
  ], rows: plan.assignments.map((assignment) => ({
    teacher_id: staffIds.get(plan.staff.find((staff) => staff.key === assignment.teacherKey).email),
    academic_term_id: termIds.get(TERM_NAMES[assignment.termNumber - 1]),
    section_id: sectionIds.get(`${assignment.termNumber}:${assignment.sectionName}`),
    subject_id: subjectIds.get(assignment.subjectCode),
    assigned_by: staffIds.get(plan.staff.find((staff) => staff.key === 'registrar').email)
  })), keyColumns: ['academic_term_id', 'section_id', 'subject_id'] });
  const assignmentIds = new Map(assignmentRows.map((row) => [`${row.key0}:${row.key1}:${row.key2}`, Number(row.id)]));
  await insertRows({ transaction, sqlDriver, table: 'class_schedules', columns: [
    { name: 'assignment_id', type: 'int' }, { name: 'day_of_week', type: 'tinyint' },
    { name: 'start_time', type: 'time-text' }, { name: 'end_time', type: 'time-text' },
    { name: 'room', type: 'nvarchar:80' }, { name: 'created_by', type: 'int' }
  ], rows: plan.schedules.map((schedule) => ({
    assignment_id: assignmentIds.get(`${termIds.get(TERM_NAMES[schedule.termNumber - 1])}:${sectionIds.get(`${schedule.termNumber}:${schedule.sectionName}`)}:${subjectIds.get(schedule.subjectCode)}`),
    day_of_week: schedule.dayOfWeek,
    start_time: timeValue(schedule.startTime), end_time: timeValue(schedule.endTime),
    room: `${schedule.room} • ${TERM_NAMES[schedule.termNumber - 1]}`,
    created_by: staffIds.get(plan.staff.find((staff) => staff.key === 'registrar').email)
  })) });

  const studentSubjectRows = [];
  for (const student of plan.students) {
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    for (const term of plan.terms) {
      if (student.pendingActivation || term.termNumber < student.entryTermNumber
        || (student.departure && term.termNumber >= student.departure.termNumber)
        || student.futurePendingTermNumber === term.termNumber) continue;
      const enrollmentId = enrollmentIds.get(`${annualId}:${term.termNumber}`);
      const section = plan.sections.find((item) => item.termNumber === term.termNumber && item.name === student.sectionName);
      for (const subject of section.subjects) {
        studentSubjectRows.push({ enrollment_id: enrollmentId, subject_id: subjectIds.get(subject.code),
          studentNo: student.studentNo, termNumber: term.termNumber, subjectCode: subject.code });
      }
    }
  }
  const studentSubjects = await insertRows({ transaction, sqlDriver, table: 'student_subjects', columns: [
    { name: 'enrollment_id', type: 'int' }, { name: 'subject_id', type: 'int' }
  ], rows: studentSubjectRows, keyColumns: ['enrollment_id', 'subject_id'] });
  const studentSubjectIds = new Map(studentSubjects.map((row) => [`${row.key0}:${row.key1}`, Number(row.id)]));
  const assignmentTeacherByContext = new Map(plan.assignments.map((assignment) => [
    `${assignment.termNumber}:${assignment.sectionName}:${assignment.subjectCode}`,
    staffIds.get(plan.staff.find((staff) => staff.key === assignment.teacherKey).email)
  ]));
  const gradeRows = [];
  for (const entry of studentSubjectRows) {
    const student = plan.students.find((row) => row.studentNo === entry.studentNo);
    const section = plan.sections.find((row) => row.termNumber === entry.termNumber && row.name === student.sectionName);
    const subjectIndex = section.subjects.findIndex((row) => row.code === entry.subjectCode);
    const studentSubjectId = studentSubjectIds.get(`${entry.enrollment_id}:${entry.subject_id}`);
    for (const [periodIndex, gradingPeriod] of plan.gradingPeriods.entries()) {
      const sourceGrade = plan.grades.find((row) => row.studentKey === student.key && row.subjectCode === entry.subjectCode && row.gradingPeriod === gradingPeriod);
      const variation = (entry.termNumber - 1) * 0.25;
      const grade = Math.min(100, Number(sourceGrade.gradeValue) + variation).toFixed(2);
      gradeRows.push({ student_subject_id: studentSubjectId, grading_period: gradingPeriod,
        grade_value: grade, recorded_by: assignmentTeacherByContext.get(`${entry.termNumber}:${student.sectionName}:${entry.subjectCode}`),
        subjectIndex, periodIndex });
    }
  }
  await insertRows({ transaction, sqlDriver, table: 'grades', columns: [
    { name: 'student_subject_id', type: 'int' }, { name: 'grading_period', type: 'nvarchar:50' },
    { name: 'grade_value', type: (driver) => driver.Decimal(6, 2) }, { name: 'recorded_by', type: 'int' }
  ], rows: gradeRows });

  const financeUserId = staffIds.get(plan.staff.find((staff) => staff.key === 'finance').email);
  const registrarUserId = staffIds.get(plan.staff.find((staff) => staff.key === 'registrar').email);
  const scheduleMetadata = [];
  for (const gradeLevel of ['Grade 11', 'Grade 12']) {
    for (const voucherCode of ['PUB', 'ESC', 'NV']) {
      scheduleMetadata.push({ key: `${gradeLevel}:${voucherCode}`, school_year: SCHOOL_YEAR, grade_level: gradeLevel,
        voucher_code: voucherCode, version_no: 1, status: 'active', idempotency_key: crypto.randomUUID(),
        request_fingerprint: fingerprint({ schoolYear: SCHOOL_YEAR, gradeLevel, voucherCode, version: 1, rates: FEE_AMOUNTS_CENTS[gradeLevel][voucherCode].map(String) }),
        created_by: financeUserId });
    }
  }
  const scheduleRows = await insertRows({ transaction, sqlDriver, table: 'finance_schedules', columns: [
    { name: 'school_year', type: 'nvarchar:20' }, { name: 'grade_level', type: 'nvarchar:50' }, { name: 'voucher_code', type: 'nvarchar:10' },
    { name: 'version_no', type: 'int' }, { name: 'status', type: 'nvarchar:20' },
    { name: 'idempotency_key', type: 'uniqueidentifier' }, { name: 'request_fingerprint', type: 'char64' }, { name: 'created_by', type: 'int' }
  ], rows: scheduleMetadata, keyColumns: ['school_year', 'grade_level', 'voucher_code'] });
  const scheduleIds = new Map(scheduleRows.map((row) => [`${row.key1}:${row.key2}`, Number(row.id)]));
  const financeScheduleLines = createScheduleLines(plan);
  const lineRows = await insertRows({ transaction, sqlDriver, table: 'finance_schedule_lines', columns: [
    { name: 'schedule_id', type: 'int' }, { name: 'term_number', type: 'tinyint' },
    { name: 'fee_category', type: 'nvarchar:40' }, { name: 'line_name', type: 'nvarchar:120' },
    { name: 'installment', type: 'nvarchar:40' }, { name: 'amount', type: 'decimal' }, { name: 'is_optional', type: 'bit' }
  ], rows: financeScheduleLines.map((line) => ({ schedule_id: scheduleIds.get(line.scheduleKey), term_number: line.termNumber,
    fee_category: line.feeCategory, line_name: line.lineName, installment: line.installment, amount: line.amount, is_optional: line.isOptional })),
  keyColumns: ['schedule_id', 'term_number', 'fee_category', 'installment'] });
  const financeLineIds = new Map(lineRows.map((row) => [`${row.key0}:${row.key1}:${row.key2}:${row.key3}`, Number(row.id)]));

  const waiverStudents = plan.students.filter((student) => student.waiverTermNumber && !student.pendingActivation);
  const exemptionCases = await insertRows({ transaction, sqlDriver, table: 'finance_exemption_cases', columns: [
    { name: 'annual_enrollment_id', type: 'int' }, { name: 'status', type: 'nvarchar:20' }, { name: 'requested_by', type: 'int' },
    { name: 'reviewed_by', type: 'int' }, { name: 'review_reason', type: 'nvarchar:1000' },
    { name: 'idempotency_key', type: 'uniqueidentifier' }, { name: 'request_fingerprint', type: 'char64' }, { name: 'reviewed_at', type: 'datetime2' }
  ], rows: waiverStudents.map((student) => {
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    const details = { annualId, termNumber: student.waiverTermNumber, demo: true };
    return { annual_enrollment_id: annualId, status: 'approved', requested_by: financeUserId, reviewed_by: registrarUserId,
      review_reason: 'Fictional demo exemption only; this is not a school policy or approved waiver.',
      idempotency_key: crypto.randomUUID(), request_fingerprint: fingerprint(details), reviewed_at: new Date('2026-06-01T00:00:00.000Z') };
  }), keyColumns: ['annual_enrollment_id'] });
  const exemptionCaseIds = mapInserted(exemptionCases);
  const ruleRows = [];
  for (const student of waiverStudents) {
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    const exemptionCaseId = exemptionCaseIds.get(annualId);
    for (const category of ['tuition', 'miscellaneous']) ruleRows.push({ exemption_case_id: exemptionCaseId,
      term_number: student.waiverTermNumber, fee_category: category, line_name: null,
      is_full_coverage: true, approved_amount: '0.00' });
  }
  const exemptionRules = await insertRows({ transaction, sqlDriver, table: 'finance_exemption_rules', columns: [
    { name: 'exemption_case_id', type: 'bigint' }, { name: 'term_number', type: 'tinyint' },
    { name: 'fee_category', type: 'nvarchar:40' }, { name: 'line_name', type: 'nvarchar:120' },
    { name: 'is_full_coverage', type: 'bit' }, { name: 'approved_amount', type: 'decimal' }
  ], rows: ruleRows, keyColumns: ['exemption_case_id', 'fee_category'] });
  const exemptionRuleIds = new Map(exemptionRules.map((row) => [`${row.key0}:${row.key1}`, Number(row.id)]));

  const confirmedStudents = plan.students.filter((student) => !student.pendingActivation);
  const assessmentRows = await insertRows({ transaction, sqlDriver, table: 'annual_assessments', columns: [
    { name: 'annual_enrollment_id', type: 'int' }, { name: 'schedule_id', type: 'int' }, { name: 'schedule_version', type: 'int' },
    { name: 'voucher_code_snapshot', type: 'nvarchar:10' }, { name: 'assessed_by', type: 'int' },
    { name: 'selection_json', type: 'nvarchar:max' }, { name: 'idempotency_key', type: 'uniqueidentifier' }, { name: 'request_fingerprint', type: 'char64' }
  ], rows: confirmedStudents.map((student) => {
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    const scheduleKey = `${student.gradeLevel}:${student.voucherCode}`;
    const scheduleId = scheduleIds.get(scheduleKey);
    const selection = { optionalLineIds: [] };
    return { annual_enrollment_id: annualId, schedule_id: scheduleId, schedule_version: 1,
      voucher_code_snapshot: student.voucherCode, assessed_by: financeUserId,
      selection_json: JSON.stringify(selection), idempotency_key: crypto.randomUUID(),
      request_fingerprint: fingerprint({ annualId, scheduleId, voucherCode: student.voucherCode, selection }) };
  }), keyColumns: ['annual_enrollment_id'] });
  const assessmentIds = mapInserted(assessmentRows);

  const assessedChargeRows = [];
  for (const student of confirmedStudents) {
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    const assessmentId = assessmentIds.get(annualId);
    const scheduleKey = `${student.gradeLevel}:${student.voucherCode}`;
    for (const line of financeScheduleLines.filter((candidate) => candidate.scheduleKey === scheduleKey
      && candidate.termNumber >= student.entryTermNumber && candidate.termNumber < (student.departure?.termNumber || 4))) {
      const scheduleId = scheduleIds.get(scheduleKey);
      const scheduleLineId = financeLineIds.get(`${scheduleId}:${line.termNumber}:${line.feeCategory}:${line.installment}`);
      const enrollmentId = enrollmentIds.get(`${annualId}:${line.termNumber}`);
      const waivedAmount = student.waiverTermNumber === line.termNumber ? line.amount : '0.00';
      assessedChargeRows.push({ assessment_id: assessmentId, annual_enrollment_id: annualId, enrollment_id: enrollmentId,
        schedule_line_id: scheduleLineId, fee_category: line.feeCategory, line_name: line.lineName,
        installment: line.installment, amount: line.amount, gross_amount: line.amount, waived_amount: waivedAmount,
        is_manual: false, reason: FICTIONAL_FEE_NOTE });
    }
  }
  const assessedRows = await insertRows({ transaction, sqlDriver, table: 'assessed_charges', columns: [
    { name: 'assessment_id', type: 'int' }, { name: 'annual_enrollment_id', type: 'int' }, { name: 'enrollment_id', type: 'int' },
    { name: 'schedule_line_id', type: 'int' }, { name: 'fee_category', type: 'nvarchar:40' },
    { name: 'line_name', type: 'nvarchar:120' }, { name: 'installment', type: 'nvarchar:40' },
    { name: 'amount', type: 'decimal' }, { name: 'gross_amount', type: 'decimal' }, { name: 'waived_amount', type: 'decimal' },
    { name: 'is_manual', type: 'bit' }, { name: 'reason', type: 'nvarchar:1000' }
  ], rows: assessedChargeRows, keyColumns: ['enrollment_id', 'schedule_line_id'] });
  const chargeIds = new Map(assessedRows.map((row) => [`${row.key0}:${row.key1}`, Number(row.id)]));

  const waiverApplications = [];
  const waiverAdjustmentRows = [];
  for (const student of waiverStudents) {
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    const scheduleKey = `${student.gradeLevel}:${student.voucherCode}`;
    const scheduleId = scheduleIds.get(scheduleKey);
    for (const category of ['tuition', 'miscellaneous']) {
      const line = financeScheduleLines.find((candidate) => candidate.scheduleKey === scheduleKey
        && candidate.termNumber === student.waiverTermNumber && candidate.feeCategory === category);
      const lineId = financeLineIds.get(`${scheduleId}:${student.waiverTermNumber}:${category}:${line.installment}`);
      const enrollmentId = enrollmentIds.get(`${annualId}:${student.waiverTermNumber}`);
      const chargeId = chargeIds.get(`${enrollmentId}:${lineId}`);
      const exemptionRuleId = exemptionRuleIds.get(`${exemptionCaseIds.get(annualId)}:${category}`);
      waiverApplications.push({ exemption_rule_id: exemptionRuleId, charge_id: chargeId, amount: line.amount });
    }
  }
  const waiverApplicationRows = await insertRows({ transaction, sqlDriver, table: 'finance_exemption_applications', columns: [
    { name: 'exemption_rule_id', type: 'bigint' }, { name: 'charge_id', type: 'bigint' }, { name: 'amount', type: 'decimal' }
  ], rows: waiverApplications, keyColumns: ['exemption_rule_id', 'charge_id'] });
  const waiverApplicationIds = new Map(waiverApplicationRows.map((row) => [`${row.key0}:${row.key1}`, Number(row.id)]));
  for (const application of waiverApplications) {
    const applicationId = waiverApplicationIds.get(`${application.exemption_rule_id}:${application.charge_id}`);
    const details = { applicationId, chargeId: application.charge_id, amount: application.amount, demo: true };
    waiverAdjustmentRows.push({ charge_id: application.charge_id, amount: `-${application.amount}`,
      reason: 'Fictional demo waiver; not a school-approved policy.', reverses_adjustment_id: null,
      idempotency_key: crypto.randomUUID(), request_fingerprint: fingerprint(details), recorded_by: financeUserId,
      exemption_application_id: applicationId });
  }
  const zeroAdjustmentRows = [];
  for (const student of confirmedStudents.filter((row) => row.adjustmentTermNumber)) {
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    const scheduleKey = `${student.gradeLevel}:${student.voucherCode}`;
    const scheduleId = scheduleIds.get(scheduleKey);
    for (const category of ['tuition', 'miscellaneous']) {
      const line = financeScheduleLines.find((candidate) => candidate.scheduleKey === scheduleKey
        && candidate.termNumber === student.adjustmentTermNumber && candidate.feeCategory === category);
      const lineId = financeLineIds.get(`${scheduleId}:${student.adjustmentTermNumber}:${category}:${line.installment}`);
      const enrollmentId = enrollmentIds.get(`${annualId}:${student.adjustmentTermNumber}`);
      const chargeId = chargeIds.get(`${enrollmentId}:${lineId}`);
      const details = { chargeId, termNumber: student.adjustmentTermNumber, reason: 'fictional zero-payable adjustment' };
      zeroAdjustmentRows.push({ charge_id: chargeId, amount: `-${line.amount}`,
        reason: 'Fictional demo adjustment bringing the term payable to zero; not a school-approved rate or policy.',
        reverses_adjustment_id: null, idempotency_key: crypto.randomUUID(), request_fingerprint: fingerprint(details),
        recorded_by: financeUserId, exemption_application_id: null });
    }
  }
  await insertRows({ transaction, sqlDriver, table: 'finance_charge_adjustments', columns: [
    { name: 'charge_id', type: 'bigint' }, { name: 'amount', type: 'decimal' }, { name: 'reason', type: 'nvarchar:1000' },
    { name: 'reverses_adjustment_id', type: 'bigint' }, { name: 'idempotency_key', type: 'uniqueidentifier' },
    { name: 'request_fingerprint', type: 'char64' }, { name: 'recorded_by', type: 'int' }, { name: 'exemption_application_id', type: 'bigint' }
  ], rows: [...waiverAdjustmentRows, ...zeroAdjustmentRows] });

  const confirmations = [];
  for (const student of confirmedStudents) {
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    const assessmentId = assessmentIds.get(annualId);
    const scheduleKey = `${student.gradeLevel}:${student.voucherCode}`;
    const scheduleId = scheduleIds.get(scheduleKey);
    const lines = assessedChargeRows.filter((charge) => charge.annual_enrollment_id === annualId).map((charge) => ({
      scheduleLineId: charge.schedule_line_id, termNumber: Number(plan.terms.find((term) => enrollmentIds.get(`${annualId}:${term.termNumber}`) === charge.enrollment_id).termNumber),
      category: charge.fee_category, lineName: charge.line_name, installment: charge.installment,
      grossAmount: charge.amount, waivedAmount: charge.waived_amount
    }));
    const snapshot = canonicalAssessmentSnapshot(lines);
    const payableTotal = snapshot.total;
    const optionalLineIds = [];
    const confirmationSnapshotFingerprint = fingerprint({ assessmentId, scheduleId, scheduleVersion: 1,
      voucherCode: student.voucherCode, payableTotal, optionalLineIds, postedComposition: snapshot.fingerprint });
    const request = { annualEnrollmentId: annualId, scheduleId, scheduleVersion: 1,
      voucherCode: student.voucherCode, expectedAssessmentId: assessmentId, optionalLineIds,
      assessmentSnapshotFingerprint: snapshot.fingerprint };
    confirmations.push({ annual_enrollment_id: annualId, student_id: studentIds.get(student.studentNo),
      school_year: SCHOOL_YEAR, grade_level: student.gradeLevel,
      entry_enrollment_id: enrollmentIds.get(`${annualId}:${student.entryTermNumber}`), assessment_id: assessmentId,
      schedule_id: scheduleId, schedule_version: 1, voucher_code_snapshot: student.voucherCode,
      payable_total: payableTotal, selection_json: JSON.stringify({ optionalLineIds }),
      assessment_snapshot_fingerprint: confirmationSnapshotFingerprint, confirmed_by: registrarUserId,
      idempotency_key: crypto.randomUUID(), request_fingerprint: fingerprint(request) });
  }
  await insertRows({ transaction, sqlDriver, table: 'annual_registrar_confirmations', columns: [
    { name: 'annual_enrollment_id', type: 'int' }, { name: 'student_id', type: 'int' }, { name: 'school_year', type: 'nvarchar:20' },
    { name: 'grade_level', type: 'nvarchar:50' }, { name: 'entry_enrollment_id', type: 'int' }, { name: 'assessment_id', type: 'int' },
    { name: 'schedule_id', type: 'int' }, { name: 'schedule_version', type: 'int' }, { name: 'voucher_code_snapshot', type: 'nvarchar:10' },
    { name: 'payable_total', type: 'decimal' }, { name: 'selection_json', type: 'nvarchar:max' },
    { name: 'assessment_snapshot_fingerprint', type: 'char64' }, { name: 'confirmed_by', type: 'int' },
    { name: 'idempotency_key', type: 'uniqueidentifier' }, { name: 'request_fingerprint', type: 'char64' }
  ], rows: confirmations });

  const paymentRows = await insertRows({ transaction, sqlDriver, table: 'finance_payments', columns: [
    { name: 'student_id', type: 'int' }, { name: 'amount', type: 'decimal' }, { name: 'payment_date', type: 'date' },
    { name: 'reference_no', type: 'nvarchar:100' }, { name: 'receipt_issued', type: 'bit' },
    { name: 'idempotency_key', type: 'uniqueidentifier' }, { name: 'request_fingerprint', type: 'char64' }, { name: 'recorded_by', type: 'int' }
  ], rows: plan.paymentActions.map((action) => {
    const student = plan.students.find((row) => row.key === action.studentKey);
    const studentId = studentIds.get(student.studentNo);
    const details = { studentId, termNumber: action.termNumber, amount: action.amount, mode: action.mode };
    return { student_id: studentId, amount: action.amount, payment_date: action.paymentDate,
      reference_no: `SYN-DEMO-${String(action.ordinal).padStart(4, '0')}-T${action.termNumber}`,
      receipt_issued: false, idempotency_key: crypto.randomUUID(), request_fingerprint: fingerprint(details), recorded_by: financeUserId };
  }), keyColumns: ['student_id', 'reference_no'] });
  const paymentIds = new Map(paymentRows.map((row) => [`${row.key0}:${row.key1}`, Number(row.id)]));
  const allocationBatchRows = await insertRows({ transaction, sqlDriver, table: 'finance_allocation_batches', columns: [
    { name: 'payment_id', type: 'bigint' }, { name: 'student_id', type: 'int' },
    { name: 'idempotency_key', type: 'uniqueidentifier' }, { name: 'request_fingerprint', type: 'char64' }, { name: 'allocated_by', type: 'int' }
  ], rows: plan.paymentActions.map((action) => {
    const student = plan.students.find((row) => row.key === action.studentKey);
    const studentId = studentIds.get(student.studentNo);
    const paymentId = paymentIds.get(`${studentId}:SYN-DEMO-${String(action.ordinal).padStart(4, '0')}-T${action.termNumber}`);
    const details = { paymentId, studentId, mode: action.mode, allocations: action.allocations };
    return { payment_id: paymentId, student_id: studentId, idempotency_key: crypto.randomUUID(),
      request_fingerprint: fingerprint(details), allocated_by: financeUserId };
  }), keyColumns: ['payment_id'] });
  const batchIds = new Map(allocationBatchRows.map((row) => [Number(row.key0), Number(row.id)]));
  const allocations = [];
  for (const action of plan.paymentActions) {
    const student = plan.students.find((row) => row.key === action.studentKey);
    const annualId = annualIds.get(studentIds.get(student.studentNo));
    const studentId = studentIds.get(student.studentNo);
    const paymentId = paymentIds.get(`${studentId}:SYN-DEMO-${String(action.ordinal).padStart(4, '0')}-T${action.termNumber}`);
    const batchId = batchIds.get(paymentId);
    const scheduleKey = `${student.gradeLevel}:${student.voucherCode}`;
    for (const allocation of action.allocations) {
      const line = financeScheduleLines.find((candidate) => candidate.scheduleKey === scheduleKey
        && candidate.termNumber === action.termNumber && candidate.feeCategory === allocation.feeCategory);
      const scheduleId = scheduleIds.get(scheduleKey);
      const lineId = financeLineIds.get(`${scheduleId}:${action.termNumber}:${allocation.feeCategory}:${line.installment}`);
      const enrollmentId = enrollmentIds.get(`${annualId}:${action.termNumber}`);
      allocations.push({ payment_id: paymentId, charge_id: chargeIds.get(`${enrollmentId}:${lineId}`), amount: allocation.amount,
        allocation_batch_id: batchId, allocated_by: financeUserId });
    }
  }
  await insertRows({ transaction, sqlDriver, table: 'finance_payment_allocations', columns: [
    { name: 'payment_id', type: 'bigint' }, { name: 'charge_id', type: 'bigint' }, { name: 'amount', type: 'decimal' },
    { name: 'allocation_batch_id', type: 'bigint' }, { name: 'allocated_by', type: 'int' }
  ], rows: allocations });
  const reversalActions = plan.paymentActions.filter((action) => action.mode === 'reversed');
  const reversalRows = reversalActions.map((action) => {
    const student = plan.students.find((row) => row.key === action.studentKey);
    const studentId = studentIds.get(student.studentNo);
    const paymentId = paymentIds.get(`${studentId}:SYN-DEMO-${String(action.ordinal).padStart(4, '0')}-T${action.termNumber}`);
    const details = { paymentId, studentId, reason: 'Fictional demo reversal; not an actual payment.' };
    return { payment_id: paymentId, reason: 'Fictional demo payment reversal for dashboard testing.',
      idempotency_key: crypto.randomUUID(), request_fingerprint: fingerprint(details), recorded_by: financeUserId };
  });
  await insertRows({ transaction, sqlDriver, table: 'finance_payment_reversals', columns: [
    { name: 'payment_id', type: 'bigint' }, { name: 'reason', type: 'nvarchar:1000' },
    { name: 'idempotency_key', type: 'uniqueidentifier' }, { name: 'request_fingerprint', type: 'char64' }, { name: 'recorded_by', type: 'int' }
  ], rows: reversalRows });
  for (const action of reversalActions) {
    const student = plan.students.find((row) => row.key === action.studentKey);
    const studentId = studentIds.get(student.studentNo);
    const paymentId = paymentIds.get(`${studentId}:SYN-DEMO-${String(action.ordinal).padStart(4, '0')}-T${action.termNumber}`);
    const updated = await transaction.request().input('paymentId', sqlDriver.BigInt, paymentId)
      .query('UPDATE dbo.finance_payments SET is_reversed = 1 WHERE id = @paymentId AND is_reversed = 0');
    if ((updated.rowsAffected || []).reduce((sum, count) => sum + Number(count), 0) !== 1) {
      throw new ThreeTermSeedError('The synthetic payment reversal flag did not match its ledger row.', 409);
    }
  }

  const detailsJson = JSON.stringify({
    synthetic: true, seedVersion: SEED_VERSION, schoolYear: SCHOOL_YEAR, terms: TERM_NAMES,
    fictionalFeeRates: true, schoolApprovedRates: false,
    financeNote: 'All sample amounts are fictional demonstrations and are not school-approved rates.', counts: plan.counts
  });
  await transaction.request().input('action', sqlDriver.NVarChar(100), MARKER.action)
    .input('entityType', sqlDriver.NVarChar(100), MARKER.entityType)
    .input('entityId', sqlDriver.NVarChar(100), MARKER.entityId)
    .input('detailsJson', sqlDriver.NVarChar(sqlDriver.MAX), detailsJson)
    .query(`INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
      VALUES (NULL, @action, @entityType, @entityId, @detailsJson)`);

  return { studentIds, annualIds, enrollmentIds, counts: plan.counts };
}

async function readSeedCounts(executor) {
  const result = await executor.request().query(`SELECT
      (SELECT COUNT_BIG(*) FROM dbo.students) AS students,
      (SELECT COUNT_BIG(*) FROM dbo.users WHERE role=N'student') AS studentLoginAccounts,
      (SELECT COUNT_BIG(*) FROM dbo.users WHERE role IN (N'registrar', N'finance', N'teacher')) AS staffAccounts,
      (SELECT COUNT_BIG(*) FROM dbo.academic_terms WHERE school_year=N'2026-2027') AS terms,
      (SELECT COUNT_BIG(*) FROM dbo.school_year_term_order WHERE school_year=N'2026-2027') AS configuredTerms,
      (SELECT COUNT_BIG(*) FROM dbo.annual_enrollments WHERE school_year=N'2026-2027') AS annualEnrollments,
      (SELECT COUNT_BIG(*) FROM dbo.enrollments WHERE annual_enrollment_id IS NOT NULL) AS placements,
      (SELECT COUNT_BIG(*) FROM dbo.sections) AS sections,
      (SELECT COUNT_BIG(*) FROM dbo.subjects) AS subjects,
      (SELECT COUNT_BIG(*) FROM dbo.teacher_assignments WHERE is_active=1) AS teacherAssignments,
      (SELECT COUNT_BIG(*) FROM dbo.class_schedules) AS classSchedules,
      (SELECT COUNT_BIG(*) FROM dbo.student_subjects) AS studentSubjects,
      (SELECT COUNT_BIG(*) FROM dbo.grades) AS grades,
      (SELECT COUNT_BIG(*) FROM dbo.finance_schedules) AS financeSchedules,
      (SELECT COUNT_BIG(*) FROM dbo.finance_schedule_lines) AS financeScheduleLines,
      (SELECT COUNT_BIG(*) FROM dbo.annual_assessments) AS assessments,
      (SELECT COUNT_BIG(*) FROM dbo.annual_registrar_confirmations) AS registrarConfirmations,
      (SELECT COUNT_BIG(*) FROM dbo.assessed_charges) AS assessedCharges,
      (SELECT COUNT_BIG(*) FROM dbo.finance_exemption_cases WHERE status=N'approved') AS waiverCases,
      (SELECT COUNT_BIG(*) FROM dbo.finance_charge_adjustments) AS paymentAdjustments,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payments) AS payments,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payments WHERE is_reversed=1) AS paymentReversedFlags,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payment_allocations) AS allocations,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payment_reversals) AS paymentReversals,
      (SELECT COUNT_BIG(*) FROM dbo.finance_departure_cases) AS departureCases,
      (SELECT COUNT_BIG(*) FROM dbo.annual_enrollments WHERE account_activation_pending=1) AS pendingActivation,
      (SELECT COUNT_BIG(*) FROM dbo.enrollments WHERE enrollment_status=N'pending_payment' AND annual_enrollment_id IN
        (SELECT id FROM dbo.annual_enrollments WHERE account_activation_pending=0)) AS futurePendingActivations,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payments WHERE payment_date < '2027-01-01' AND EXISTS (
        SELECT 1 FROM dbo.finance_payment_allocations AS allocation
        INNER JOIN dbo.assessed_charges AS charge ON charge.id=allocation.charge_id
        INNER JOIN dbo.enrollments AS enrollment ON enrollment.id=charge.enrollment_id
        WHERE allocation.payment_id=finance_payments.id AND enrollment.annual_term_number=3)) AS futurePrepayments`);
  return Object.fromEntries(Object.entries(result.recordset?.[0] || {}).map(([key, value]) => [key, Number(value)]));
}

function expectedCounts(plan) {
  const { counts } = plan;
  return Object.fromEntries(Object.entries(counts).filter(([, value]) => typeof value === 'number'));
}

async function assertSeededState(transaction, plan) {
  const counts = await readSeedCounts(transaction);
  const expected = expectedCounts(plan);
  const mismatches = Object.entries(expected).filter(([key, value]) => counts[key] !== value).map(([key]) => key);
  if (mismatches.length) throw new ThreeTermSeedError(`Three-term seed verification failed for: ${mismatches.join(', ')}.`, 409);
  const marker = await transaction.request().input('entityId', sql.NVarChar(100), MARKER.entityId)
    .query(`SELECT details_json FROM dbo.audit_logs WHERE action=N'school.demo_seeded'
      AND entity_type=N'school_demo_seed' AND entity_id=@entityId`);
  if (marker.recordset?.length !== 1) throw new ThreeTermSeedError('The three-term seed marker is missing or duplicated.', 409);
  let details;
  try { details = JSON.parse(marker.recordset[0].details_json || '{}'); } catch { details = null; }
  if (!details?.synthetic || details.seedVersion !== SEED_VERSION || details.schoolApprovedRates !== false
    || JSON.stringify(details.counts) !== JSON.stringify(plan.counts)) {
    throw new ThreeTermSeedError('The three-term seed marker does not match the fictional demo plan.', 409);
  }
  return counts;
}

async function seedSchoolData({ getDatabasePool = getPool, sqlDriver = sql, transactionFactory = (pool) => new sqlDriver.Transaction(pool),
  credentials, runtime = environment, hashPassword = bcrypt.hash, comparePassword = bcrypt.compare, transaction: sharedTransaction = null } = {}) {
  assertDevelopmentTarget(runtime);
  const expectedEmails = deriveSchoolEmails(runtime.smtp?.user);
  if (!credentials) throw new ThreeTermSeedError('Owner-only school demo credentials are required before seeding.');
  const plan = buildThreeTermPlan(expectedEmails);
  const pool = sharedTransaction ? null : await getDatabasePool();
  const transaction = sharedTransaction || transactionFactory(pool);
  let started = false;
  try {
    if (!sharedTransaction) {
      await transaction.begin(sqlDriver.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
    }
    await requireLatestSchema(transaction);
    if (!sharedTransaction) await assertNoOtherSessions(transaction);
    const staff = await loadStaff(transaction, plan, credentials, { hashPassword, comparePassword, sqlDriver });
    const markerResult = await transaction.request().input('action', sqlDriver.NVarChar(100), MARKER.action)
      .query(`SELECT entity_id, details_json FROM dbo.audit_logs WITH (UPDLOCK, HOLDLOCK) WHERE action=@action AND entity_type=N'school_demo_seed'`);
    if (markerResult.recordset?.length) {
      if (markerResult.recordset.length !== 1 || markerResult.recordset[0].entity_id !== MARKER.entityId) {
        throw new ThreeTermSeedError('A different school demo seed marker exists; no rows were changed.', 409);
      }
      const counts = await assertSeededState(transaction, plan);
      if (started) { await transaction.commit(); started = false; }
      return { alreadySeeded: true, staffCreated: staff.created, counts };
    }
    await assertEmptyDemoTables(transaction);
    const result = await insertSeedRows(transaction, plan, staff.ids, credentials, { sqlDriver, hashPassword });
    const counts = await assertSeededState(transaction, plan);
    if (started) { await transaction.commit(); started = false; }
    return { alreadySeeded: false, staffCreated: staff.created, counts, seedCounts: result.counts };
  } catch (error) {
    if (started) {
      try { await transaction.rollback(); } catch { /* Keep the original seed error. */ }
    }
    if (error instanceof SchoolSeedError) throw new ThreeTermSeedError(error.message, error.status || 400);
    throw error;
  }
}

async function makeRuntimePool(runtime) {
  if (runtime.database.database === environment.database.database) return getPool();
  const config = { ...environment.database, database: runtime.database.database,
    options: { encrypt: environment.database.encrypt, trustServerCertificate: environment.database.trustServerCertificate },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 } };
  return new sql.ConnectionPool(config).connect();
}

async function main(args = process.argv.slice(2)) {
  let poolToClose = false;
  try {
    const { mode } = parseOptions(args);
    assertDevelopmentTarget(environment);
    const emails = deriveSchoolEmails(environment.smtp.user);
    const plan = buildThreeTermPlan(emails);
    if (mode === 'dry-run') {
      process.stdout.write(`Three-term school demo preview: ${plan.counts.students} students, ${plan.counts.terms} configured terms, ${plan.counts.sections} sections, ${plan.counts.teacherAssignments} teacher assignments, ${plan.counts.grades} grades, ${plan.counts.registrarConfirmations} registrar confirmations, ${plan.counts.payments} payment examples, ${plan.counts.paymentReversals} reversals, and ${plan.counts.waiverCases} fictional waivers. All sample fee amounts are fictional and not school-approved. No database changes made.\n`);
      return;
    }
    const credentials = loadOrCreateCredentials({ smtpUser: environment.smtp.user, filePath: CREDENTIAL_FILE });
    const pool = await makeRuntimePool(environment);
    poolToClose = environment.database.database !== environment.database.database;
    const result = await seedSchoolData({ getDatabasePool: async () => pool, credentials, runtime: environment });
    process.stdout.write(result.alreadySeeded
      ? 'The three-term school demo seed is already present and its counts verified; no rows were added. Student credentials remain in ignored .env.school-demo.\n'
      : `Three-term synthetic demo data seeded (${result.counts.students} students, ${result.counts.terms} terms). Fee schedule examples are fictional and not school-approved. Credentials remain in ignored .env.school-demo with owner-only permissions.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof ThreeTermSeedError || error instanceof SchoolSeedError ? error.message : 'Three-term school demo seeding failed. Check local database connectivity and schema setup.'}\n`);
    process.exitCode = 1;
  } finally {
    if (poolToClose) {
      try { await closePool(); } catch { /* Do not print database connection details. */ }
    }
  }
}

if (require.main === module) main();

module.exports = {
  SEED_VERSION, MARKER, SCHOOL_YEAR, TERM_NAMES, FEE_AMOUNTS_CENTS, FICTIONAL_FEE_NOTE,
  decimalToCents, timeValue,
  ThreeTermSeedError, parseOptions, assertDevelopmentTarget, buildThreeTermPlan, sqlType,
  insertRows, mapSectionIds, readSeedCounts, assertSeededState, seedSchoolData, makeRuntimePool
};
