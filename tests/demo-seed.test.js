const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DemoSeedError,
  parseOptions,
  assertDevelopmentTarget,
  deriveDemoEmails,
  buildDemoPlan,
  decimalToCents,
  loadOrCreateCredentials,
  seedDemoData
} = require('../scripts/seed-demo');

function fakeSql() {
  return {
    MAX: 'MAX',
    Int: 'Int',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
    NVarChar: (length) => `NVarChar(${length})`,
    Decimal: (precision, scale) => `Decimal(${precision},${scale})`
  };
}

function makeSeedDatabase({ collideWithStudent = false, collideWithStaff = false } = {}) {
  const state = { markerExists: false, queries: [], commits: 0, rollbacks: 0, nextId: 1 };
  const transactionFactory = () => ({
    async begin(isolation) { state.isolation = isolation; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          const query = { statement, values: { ...values } };
          state.queries.push(query);
          if (statement.includes('WHERE action = @action')) return { recordset: state.markerExists ? [{ id: 1 }] : [] };
          if (statement.includes('FROM dbo.students WITH') && statement.includes('student_no IN')) {
            return { recordset: collideWithStudent ? [{ id: 9 }] : [] };
          }
          if (statement.includes('FROM dbo.staff_profiles WITH') && statement.includes('employee_no IN')) {
            return { recordset: collideWithStaff ? [{ id: 9 }] : [] };
          }
          if (statement.startsWith('SELECT TOP')) return { recordset: [] };
          if (statement.includes('INSERT INTO dbo.audit_logs')) {
            state.markerExists = true;
            return { recordset: [] };
          }
          if (statement.includes('OUTPUT INSERTED.id')) return { recordset: [{ id: state.nextId++ }] };
          return { recordset: [] };
        }
      };
    },
    async commit() { state.commits += 1; },
    async rollback() { state.rollbacks += 1; }
  });
  return { state, getPool: async () => ({}), transactionFactory };
}

const emails = deriveDemoEmails('prototype.user+smtp@gmail.com');
const legacyDevelopmentRuntime = { nodeEnv: 'development', database: { server: 'localhost', database: 'ARKTIESIIS' } };
const passwords = Object.fromEntries(['registrar', 'finance', 'student1', 'student2', 'student3']
  .map((role) => [role, `${role}-` + 'x'.repeat(32)]));
const credentials = { emails, passwords };

test('demo seed requires development mode and exactly one explicit mode', () => {
  assert.deepEqual(parseOptions(['--dry-run'], 'development'), { mode: 'dry-run' });
  assert.deepEqual(parseOptions(['--apply'], 'development'), { mode: 'apply' });
  assert.throws(() => parseOptions(['--apply'], 'production'), DemoSeedError);
  assert.throws(() => parseOptions([], 'development'), /exactly one option/);
  assert.throws(() => parseOptions(['--apply', '--dry-run'], 'development'), /exactly one option/);
  assert.throws(() => parseOptions(['--apply', '--force'], 'development'), /exactly one option/);
  const localTarget = { nodeEnv: 'development', database: { server: 'localhost', database: 'ARKTIESIIS' } };
  assert.doesNotThrow(() => assertDevelopmentTarget(localTarget));
  assert.throws(() => assertDevelopmentTarget({ ...localTarget, database: { server: 'db.example.com', database: 'ARKTIESIIS' } }), /local ARKTIESIIS database/);
  assert.throws(() => assertDevelopmentTarget({ ...localTarget, database: { server: 'localhost', database: 'Production' } }), /local ARKTIESIIS database/);
  assert.throws(() => assertDevelopmentTarget({ ...localTarget, nodeEnv: 'production' }), /NODE_ENV=development/);
});

test('demo account aliases are derived only from valid Gmail or Googlemail SMTP users', () => {
  assert.equal(emails.registrar, 'prototype.user+arkt-demo-registrar@gmail.com');
  assert.equal(emails.student3, 'prototype.user+arkt-demo-student-3@gmail.com');
  assert.equal(deriveDemoEmails('prototype@gmail.com').finance, 'prototype+arkt-demo-finance@gmail.com');
  assert.throws(() => deriveDemoEmails('operator@example.com'), /valid Gmail or Googlemail/);
  assert.throws(() => deriveDemoEmails('invalid-address'), /valid Gmail or Googlemail/);
});

test('demo finance balances equal the signed charge and payment ledger totals', () => {
  const plan = buildDemoPlan(emails);
  assert.equal(plan.students.length, 3);
  assert.equal(plan.subjects.length, 3);
  const expectedBalances = ['850.00', '0.00', '-50.00'];
  for (const [index, account] of plan.financialAccounts.entries()) {
    const signedLedgerCents = account.transactions.reduce((total, entry) => {
      const cents = decimalToCents(entry.amount);
      return total + (entry.type === 'charge' ? cents : -cents);
    }, 0n);
    assert.equal(account.balance, expectedBalances[index]);
    assert.equal(account.balance, `${signedLedgerCents < 0n ? '-' : ''}${(signedLedgerCents < 0n ? -signedLedgerCents : signedLedgerCents) / 100n}.${String((signedLedgerCents < 0n ? -signedLedgerCents : signedLedgerCents) % 100n).padStart(2, '0')}`);
  }
});

test('demo credential file is created once with owner-only POSIX permissions where supported and preserved on rerun', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arktiesiis-demo-'));
  const filePath = path.join(directory, '.env.demo');
  try {
    const first = loadOrCreateCredentials({ smtpUser: 'prototype.user@gmail.com', filePath, randomPassword: () => 's'.repeat(40) });
    // Node exposes POSIX owner/group/other bits on Unix; Windows uses ACLs and
    // chmod only controls the write bit, so stat().mode cannot assert privacy there.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(filePath).mode & 0o777;
      assert.equal(mode, 0o600);
    }
    assert.equal(first.passwords.registrar, 's'.repeat(40));
    const previous = fs.readFileSync(filePath, 'utf8');
    const second = loadOrCreateCredentials({ smtpUser: 'prototype.user@gmail.com', filePath, randomPassword: () => { throw new Error('must preserve existing passwords'); } });
    assert.equal(second.passwords.registrar, first.passwords.registrar);
    assert.equal(fs.readFileSync(filePath, 'utf8'), previous);
    assert.throws(() => loadOrCreateCredentials({ smtpUser: 'other@gmail.com', filePath }), /do not match SMTP_USER/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('demo seed is atomic, records expected sample rows, and a rerun adds nothing', async () => {
  const fixture = makeSeedDatabase();
  const options = {
    getDatabasePool: fixture.getPool,
    sqlTypes: fakeSql(),
    transactionFactory: fixture.transactionFactory,
    credentials,
    runtime: legacyDevelopmentRuntime,
    hashPassword: async (password) => `hash:${password}`
  };
  const first = await seedDemoData(options);
  assert.equal(first.alreadySeeded, false);
  assert.equal(fixture.state.isolation, 'SERIALIZABLE');
  assert.equal(fixture.state.commits, 1);
  const transactionRows = fixture.state.queries.filter(({ statement }) => statement.includes('INSERT INTO dbo.financial_transactions'));
  assert.equal(transactionRows.length, 7);
  const staffProfiles = fixture.state.queries.filter(({ statement }) => statement.includes('INSERT INTO dbo.staff_profiles'));
  assert.deepEqual(staffProfiles.map(({ values }) => values.employeeNo), ['DEMO-STAFF-REG-001', 'DEMO-STAFF-FIN-001']);
  const accountRows = fixture.state.queries.filter(({ statement }) => statement.includes('INSERT INTO dbo.financial_accounts'));
  assert.deepEqual(accountRows.map(({ values }) => values.balance), ['850.00', '0.00', '-50.00']);
  assert.equal(fixture.state.queries.filter(({ statement }) => statement.includes('INSERT INTO dbo.documents')).length, 0);
  assert.equal(fixture.state.queries.filter(({ statement }) => statement.includes('INSERT INTO dbo.document_validations')).length, 0);

  const second = await seedDemoData(options);
  assert.equal(second.alreadySeeded, true);
  assert.equal(fixture.state.commits, 2);
  assert.equal(fixture.state.queries.filter(({ statement }) => statement.includes('INSERT INTO dbo.financial_transactions')).length, 7);
  assert.equal(fixture.state.queries.filter(({ statement }) => statement.includes('INSERT INTO dbo.users')).length, 5);
});

test('demo student and staff key conflicts abort before inserts and roll back the serializable transaction', async () => {
  for (const collision of [{ collideWithStudent: true }, { collideWithStaff: true }]) {
    const fixture = makeSeedDatabase(collision);
    await assert.rejects(seedDemoData({
      getDatabasePool: fixture.getPool,
      sqlTypes: fakeSql(),
      transactionFactory: fixture.transactionFactory,
      credentials,
      runtime: legacyDevelopmentRuntime,
      hashPassword: async (password) => `hash:${password}`
    }), /already exists without the demo seed marker/);
    assert.equal(fixture.state.rollbacks, 1);
    assert.equal(fixture.state.commits, 0);
    assert.equal(fixture.state.queries.some(({ statement }) => statement.startsWith('INSERT INTO')), false);
  }
});
