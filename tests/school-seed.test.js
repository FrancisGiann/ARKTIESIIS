const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SchoolSeedError,
  parseOptions,
  assertDevelopmentTarget,
  deriveSchoolEmails,
  buildSchoolPlan,
  decimalToCents,
  centsToDecimal,
  loadOrCreateCredentials,
  seedSchoolData
} = require('../scripts/seed-school');

function fakeSql() {
  return {
    MAX: 'MAX',
    Bit: 'Bit',
    Int: 'Int',
    TinyInt: 'TinyInt',
    BigInt: 'BigInt',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
    NVarChar: (length) => `NVarChar(${length})`,
    VarChar: (length) => `VarChar(${length})`,
    Decimal: (precision, scale) => `Decimal(${precision},${scale})`
  };
}

function makeSeedDatabase({ markerExists = false, collision = false, migrationVersions = ['v2.001'] } = {}) {
  const state = { markerExists, queries: [], commits: 0, rollbacks: 0, isolation: null };
  const transactionFactory = () => ({
    async begin(isolation) { state.isolation = isolation; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          state.queries.push({ statement, values: { ...values } });
          if (statement.includes('FROM dbo.schema_migrations')) {
            return { recordset: migrationVersions.map((version) => ({ version })) };
          }
          if (statement.includes('WHERE action = @action')) return { recordset: markerExists ? [{ id: 1 }] : [] };
          if (collision && statement.includes('FROM dbo.students') && statement.includes('student_no')) return { recordset: [{ conflict: 1 }] };
          if (statement.startsWith('SELECT TOP')) return { recordset: [] };
          return { recordset: [] };
        }
      };
    },
    async commit() { state.commits += 1; },
    async rollback() { state.rollbacks += 1; }
  });
  return { state, getPool: async () => ({}), transactionFactory };
}

function makeSuccessfulSeedDatabase({ currentTermExists = false, failOnSchoolAudit = false } = {}) {
  const state = { queries: [], commits: 0, rollbacks: 0, maxParameters: 0, insertedRows: new Map(), rowsByTable: new Map() };
  let nextId = 1;
  const transactionFactory = () => ({
    async begin(isolation) { state.isolation = isolation; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          state.queries.push({ statement, values: { ...values } });
          state.maxParameters = Math.max(state.maxParameters, Object.keys(values).length);
          if (statement.includes('FROM dbo.schema_migrations')) return { recordset: ['v2.001'].map((version) => ({ version })) };
          if (statement.includes('WHERE action = @action')) return { recordset: [] };
          if (statement.includes('FROM dbo.users') && statement.includes('WHERE email = @email')) {
            return { recordset: (state.rowsByTable.get('users') || []).filter((row) => row.email === values.email && row.role === 'registrar').slice(0, 1) };
          }
          if (statement.includes('FROM dbo.students') && statement.includes('WHERE student_no = @studentNo')) {
            return { recordset: (state.rowsByTable.get('students') || []).filter((row) => row.student_no === values.studentNo).slice(0, 1) };
          }
          if (statement.includes('FROM dbo.academic_terms') && statement.includes('WHERE is_current = @isCurrent')) {
            return { recordset: currentTermExists ? [{ id: 99 }] : [] };
          }
          if (statement.startsWith('SELECT TOP')) return { recordset: [] };
          if (statement.includes('INSERT INTO dbo.academic_terms')) {
            state.insertedTermIsCurrent = values.isCurrent;
            return { recordset: [{ id: nextId++ }] };
          }
          if (statement.includes('INSERT INTO dbo.audit_logs')) {
            if (failOnSchoolAudit && values.action === 'school.demo_seeded') throw new Error('Injected seed audit failure.');
            return { recordset: [] };
          }

          const table = statement.match(/INSERT INTO dbo\.([a-z_]+)/)?.[1];
          if (!table) return { recordset: [] };
          const rowIndexes = [...new Set(Object.keys(values).map((name) => name.match(/^p(\d+)_\d+$/)?.[1]).filter((value) => value !== undefined))]
            .map(Number).sort((left, right) => left - right);
          const directRowCount = ['documents', 'document_decision_events'].includes(table) ? 1 : 0;
          state.insertedRows.set(table, (state.insertedRows.get(table) || 0) + (rowIndexes.length || directRowCount));
          if (table === 'documents') return { recordset: [{ id: nextId++ }] };
          if (table === 'document_decision_events') return { recordset: [] };
          if (!statement.includes('OUTPUT INSERTED.id,')) return { recordset: [] };
          const keyIndices = {
            users: [0], sections: [0], subjects: [0], students: [1], enrollments: [0],
            student_subjects: [0, 1], teacher_assignments: [2, 3], financial_accounts: [0]
          }[table];
          return {
            recordset: rowIndexes.map((rowIndex) => {
              const row = { id: nextId++ };
              keyIndices.forEach((paramIndex, keyIndex) => { row[`key${keyIndex}`] = values[`p${rowIndex}_${paramIndex}`]; });
              const columns = statement.match(/INSERT INTO dbo\.[a-z_]+ \(([^)]+)\)/)?.[1].split(',').map((name) => name.trim()) || [];
              columns.forEach((name, index) => { row[name] = values[`p${rowIndex}_${index}`]; });
              const currentRows = state.rowsByTable.get(table) || [];
              currentRows.push(row);
              state.rowsByTable.set(table, currentRows);
              return row;
            })
          };
        }
      };
    },
    async commit() { state.commits += 1; },
    async rollback() { state.rollbacks += 1; }
  });
  return { state, getPool: async () => ({}), transactionFactory };
}

const runtime = {
  nodeEnv: 'development',
  database: { server: '127.0.0.1', database: 'ARKTIESIIS_V2' },
  smtp: { user: 'prototype.school@gmail.com' }
};
const emails = deriveSchoolEmails(runtime.smtp.user);
const passwordKeys = [
  'registrar', 'finance',
  ...Array.from({ length: 16 }, (_unused, index) => `teacher${String(index + 1).padStart(2, '0')}`),
  'student1', 'student2', 'student3'
];
const passwords = Object.fromEntries(passwordKeys.map((key, index) => [key, `school-demo-${String(index).padStart(2, '0')}-` + 'x'.repeat(32)]));
const credentials = { emails, passwords };

test('school seed requires development mode, an explicit mode, and a loopback ARKTIESIIS_V2 target', () => {
  assert.deepEqual(parseOptions(['--dry-run'], 'development'), { mode: 'dry-run' });
  assert.deepEqual(parseOptions(['--apply'], 'development'), { mode: 'apply' });
  assert.throws(() => parseOptions([], 'development'), /exactly one option/);
  assert.throws(() => parseOptions(['--apply', '--dry-run'], 'development'), /exactly one option/);
  assert.throws(() => parseOptions(['--apply'], 'production'), SchoolSeedError);
  assert.doesNotThrow(() => assertDevelopmentTarget(runtime));
  assert.throws(() => assertDevelopmentTarget({ ...runtime, database: { server: 'db.example.com', database: 'ARKTIESIIS_V2' } }), /local ARKTIESIIS_V2/);
  assert.throws(() => assertDevelopmentTarget({ ...runtime, database: { server: 'localhost', database: 'ARKTIESIIS' } }), /local ARKTIESIIS_V2/);
});

test('school seed plan contains plausible school labels and reconciled finance ledgers', () => {
  const plan = buildSchoolPlan(emails);
  assert.deepEqual(plan.term, { schoolYear: '2026-2027', term: 'First Semester' });
  assert.equal(plan.sections.length, 16);
  assert.equal(plan.students.length, 320);
  assert.equal(plan.students.filter((student) => student.loginKey).length, 3);
  assert.equal(plan.staff.filter((account) => account.role === 'teacher').length, 16);
  assert.equal(plan.staff.length, 18);
  assert.equal(plan.subjects.length, 21);
  assert.equal(plan.assignments.length, 112);
  assert.equal(plan.schedules.length, 112);
  assert.equal(plan.counts.classSchedules, 112);
  assert.equal(plan.counts.studentSubjects, 2240);
  assert.equal(plan.counts.grades, 4480);
  assert.equal(plan.grades.length, 4480);
  assert.equal(plan.counts.financialAccounts, 320);
  assert.equal(plan.counts.financialTransactions, 960);
  assert.equal(plan.counts.syntheticDocuments, 2);
  assert.deepEqual(plan.documentSamples.map(({ documentType, status }) => `${documentType}:${status}`), [
    'good_moral:needs_review', 'psa_birth_certificate:rejected'
  ]);
  assert.deepEqual(new Set(plan.gradingPeriods), new Set(['First Grading', 'Second Grading']));
  assert.deepEqual(plan.sections.slice(0, 4).map((section) => section.name), [
    'Grade 11 STEM A', 'Grade 11 STEM B', 'Grade 11 ABM A', 'Grade 11 ABM B'
  ]);
  assert.equal(plan.subjects[0].code, 'OCOM');
  assert.equal(plan.subjects[0].name, 'Oral Communication');
  assert.ok(plan.students.every((student) => /^SHS-2026-\d{4}$/.test(student.studentNo)));
  assert.ok(plan.staff.every((person) => /^EMP-2026-\d{3}$/.test(person.employeeNo)));
  assert.ok(plan.subjects.every((subject) => !/demo|sample|synthetic/i.test(`${subject.code} ${subject.name}`)));
  assert.ok(plan.sections.every((section) => !/demo|sample|synthetic/i.test(section.name)));
  assert.ok(plan.staff.every((person) => !/demo|sample|synthetic/i.test(`${person.firstName} ${person.lastName} ${person.department}`)));
  assert.ok(plan.financialAccounts.every((account) => account.transactions.every((entry) =>
    !/demo|sample|synthetic/i.test(`${entry.description} ${entry.reference}`))));

  const sectionCounts = new Map();
  for (const student of plan.students) sectionCounts.set(student.sectionName, (sectionCounts.get(student.sectionName) || 0) + 1);
  assert.equal(sectionCounts.size, 16);
  assert.ok([...sectionCounts.values()].every((count) => count === 20));
  assert.ok(plan.students.every((student) => /^SHS-2026-\d{4}$/.test(student.studentNo) && /^998\d{9}$/.test(student.lrn)));
  assert.equal(new Set(plan.assignments.map((item) => `${item.sectionName}:${item.subjectCode}`)).size, plan.assignments.length);
  assert.equal(new Set(plan.assignments.map((item) => item.teacherKey)).size, 16);
  const teacherByContext = new Map(plan.assignments.map((assignment) => [
    `${assignment.sectionName}:${assignment.subjectCode}`, assignment.teacherKey
  ]));
  for (const grade of plan.grades) {
    const numericGrade = Number(grade.gradeValue);
    assert.ok(numericGrade >= 0 && numericGrade <= 100, `${grade.gradeValue} is outside 0..100`);
    assert.equal(grade.teacherKey, teacherByContext.get(`${grade.sectionName}:${grade.subjectCode}`));
    if (numericGrade === 100) assert.equal(grade.gradeValue, '100.00');
  }
  assert.equal(new Set(plan.schedules.map((item) => `${item.sectionName}:${item.dayOfWeek}:${item.startTime}`)).size, 112);
  assert.ok(plan.schedules.every((item) => item.endTime > item.startTime && item.room));
  for (const account of plan.financialAccounts) {
    const student = plan.students.find((item) => item.key === account.studentKey);
    const balanceCents = account.transactions.reduce((total, entry) => {
      const amount = decimalToCents(entry.amount);
      return total + (entry.type === 'charge' ? amount : -amount);
    }, 0n);
    assert.equal(account.balance, centsToDecimal(balanceCents), student.studentNo);
  }
});

test('school aliases are safe Gmail plus-addresses derived from SMTP_USER', () => {
  assert.equal(emails.registrar, 'prototype.school+arkt-school-demo-registrar@gmail.com');
  assert.equal(emails.teachers.length, 16);
  assert.equal(new Set([...emails.teachers, ...emails.students, emails.registrar, emails.finance]).size, 21);
  assert.throws(() => deriveSchoolEmails('school@example.com'), /valid Gmail or Googlemail/);
  assert.throws(() => deriveSchoolEmails(`${'a'.repeat(60)}@gmail.com`), /too long/);
});

test('school credentials are unique, created once with private permissions, and validated on rerun', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arktiesiis-school-demo-'));
  const filePath = path.join(directory, '.env.school-demo');
  let generated = 0;
  const randomPassword = () => `random-school-password-${String(++generated).padStart(3, '0')}-` + 'x'.repeat(32);
  try {
    const first = loadOrCreateCredentials({ smtpUser: runtime.smtp.user, filePath, randomPassword });
    assert.equal(generated, 21);
    assert.equal(new Set(Object.values(first.passwords)).size, 21);
    if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    const original = fs.readFileSync(filePath, 'utf8');
    const second = loadOrCreateCredentials({ smtpUser: runtime.smtp.user, filePath, randomPassword: () => { throw new Error('existing passwords should be preserved'); } });
    assert.deepEqual(second, first);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
    assert.throws(() => loadOrCreateCredentials({ smtpUser: 'other@gmail.com', filePath }), /do not match SMTP_USER/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('school seed checks its migration gate, uses a serializable transaction, and reruns from its own audit marker', async () => {
  const fixture = makeSeedDatabase({ markerExists: true });
  const result = await seedSchoolData({
    getDatabasePool: fixture.getPool,
    sqlTypes: fakeSql(),
    transactionFactory: fixture.transactionFactory,
    credentials,
    runtime,
    hashPassword: async (password) => `hash:${password}`
  });
  assert.equal(result.alreadySeeded, true);
  assert.equal(result.counts.students, 320);
  assert.equal(result.counts.syntheticDocuments, 2);
  assert.equal(fixture.state.isolation, 'SERIALIZABLE');
  assert.equal(fixture.state.commits, 1);
  assert.equal(fixture.state.rollbacks, 0);
  assert.equal(fixture.state.queries.filter(({ statement }) => statement.includes('INSERT INTO')).length, 0);
  const markerQuery = fixture.state.queries.find(({ statement }) => statement.includes('WHERE action = @action'));
  assert.deepEqual(markerQuery.values, {
    action: 'school.demo_seeded',
    entityType: 'school_demo_seed',
    entityId: 'school-2026-2027-v2'
  });
});

test('school seed batches the full dataset atomically and sets current only when none already exists', async () => {
  for (const currentTermExists of [false, true]) {
    const fixture = makeSuccessfulSeedDatabase({ currentTermExists });
    const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-school-seed-private-'));
    let result;
    try {
      result = await seedSchoolData({
        getDatabasePool: fixture.getPool,
        sqlTypes: fakeSql(),
        transactionFactory: fixture.transactionFactory,
        credentials,
        runtime,
        storageDirectory,
        hashPassword: async (password) => `hash:${password}`
      });
      const sampleFiles = fs.readdirSync(storageDirectory);
      assert.equal(sampleFiles.length, 2);
      assert.ok(sampleFiles.every((file) => /^[0-9a-f-]+\.(pdf|png)$/.test(file)));
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(storageDirectory).mode & 0o777, 0o700);
        assert.ok(sampleFiles.every((file) => (fs.statSync(path.join(storageDirectory, file)).mode & 0o777) === 0o600));
      }
    } finally {
      fs.rmSync(storageDirectory, { recursive: true, force: true });
    }
    assert.equal(result.alreadySeeded, false);
    assert.equal(result.counts.students, 320);
    assert.equal(fixture.state.isolation, 'SERIALIZABLE');
    assert.equal(fixture.state.commits, 1);
    assert.equal(fixture.state.rollbacks, 0);
    assert.ok(fixture.state.maxParameters <= 1800);
    assert.equal(fixture.state.insertedTermIsCurrent, !currentTermExists);
    assert.equal(fixture.state.insertedRows.get('users'), 21);
    assert.equal(fixture.state.insertedRows.get('staff_profiles'), 18);
    assert.equal(fixture.state.insertedRows.get('sections'), 16);
    assert.equal(fixture.state.insertedRows.get('students'), 320);
    assert.equal(fixture.state.insertedRows.get('enrollments'), 320);
    assert.equal(fixture.state.insertedRows.get('student_subjects'), 2240);
    assert.equal(fixture.state.insertedRows.get('teacher_assignments'), 112);
    assert.equal(fixture.state.insertedRows.get('class_schedules'), 112);
    assert.equal(fixture.state.insertedRows.get('grades'), 4480);
    assert.equal(fixture.state.insertedRows.get('financial_accounts'), 320);
    assert.equal(fixture.state.insertedRows.get('financial_transactions'), 960);
    assert.equal(fixture.state.insertedRows.get('documents'), 2);
    assert.equal(fixture.state.insertedRows.get('document_decision_events'), 1);
    assert.equal(fixture.state.insertedRows.has('document_validations'), false);
    assert.equal(fixture.state.queries.some(({ statement }) => /UPDATE dbo\.academic_terms/i.test(statement)), false);
    const marker = fixture.state.queries.find(({ statement, values }) => statement.includes('INSERT INTO dbo.audit_logs') && values.action === 'school.demo_seeded');
    const markerDetails = JSON.parse(marker.values.detailsJson);
    assert.equal(marker.values.action, 'school.demo_seeded');
    assert.equal(markerDetails.documents, 2);
    assert.equal(markerDetails.documentValidations, 0);
    assert.equal(markerDetails.teacherGradeSubmissions, 0);
    assert.equal(markerDetails.classSchedules, 112);
  }
});

test('school seed cleans up private synthetic files after a rolled-back transaction', async () => {
  const fixture = makeSuccessfulSeedDatabase({ failOnSchoolAudit: true });
  const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-school-seed-rollback-'));
  try {
    await assert.rejects(seedSchoolData({
      getDatabasePool: fixture.getPool,
      sqlTypes: fakeSql(),
      transactionFactory: fixture.transactionFactory,
      credentials,
      runtime,
      storageDirectory,
      hashPassword: async (password) => `hash:${password}`
    }), /Injected seed audit failure/);
    assert.equal(fixture.state.rollbacks, 1);
    assert.deepEqual(fs.readdirSync(storageDirectory), []);
  } finally {
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});

test('school seed rolls back when an unmarked synthetic student identifier collides', async () => {
  const fixture = makeSeedDatabase({ collision: true });
  await assert.rejects(seedSchoolData({
    getDatabasePool: fixture.getPool,
    sqlTypes: fakeSql(),
    transactionFactory: fixture.transactionFactory,
    credentials,
    runtime,
    hashPassword: async (password) => `hash:${password}`
  }), /already exists without this seed marker/);
  assert.equal(fixture.state.rollbacks, 1);
  assert.equal(fixture.state.commits, 0);
  assert.equal(fixture.state.queries.some(({ statement }) => statement.includes('INSERT INTO')), false);
});

test('school seed refuses any baseline other than the consolidated V2 version', async () => {
  const fixture = makeSeedDatabase({ migrationVersions: ['001', '007', '009'] });
  await assert.rejects(seedSchoolData({
    getDatabasePool: fixture.getPool,
    sqlTypes: fakeSql(),
    transactionFactory: fixture.transactionFactory,
    credentials,
    runtime,
    hashPassword: async (password) => `hash:${password}`
  }), /Apply the ARKTIESIIS_V2 consolidated baseline/);
  assert.equal(fixture.state.rollbacks, 1);
  assert.equal(fixture.state.commits, 0);
  assert.equal(fixture.state.queries.some(({ statement }) => statement.includes('INSERT INTO')), false);
});
