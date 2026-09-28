const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');
const {
  FinanceServiceError,
  createFinanceService,
  parseMoneyCents,
  formatMoneyCents,
  validateTransaction
} = require('../src/services/financeService');

function fakeSql() {
  return {
    MAX: 'MAX',
    Int: 'Int',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
    NVarChar: (length) => `NVarChar(${length})`,
    Decimal: (precision, scale) => `Decimal(${precision},${scale})`
  };
}

function transactionalService(onQuery) {
  const log = { queries: [], isolation: null, committed: false, rolledBack: false };
  const transactionFactory = () => ({
    async begin(isolation) { log.isolation = isolation; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          const call = { statement, values: { ...values } };
          log.queries.push(call);
          return onQuery(call);
        }
      };
    },
    async commit() { log.committed = true; },
    async rollback() { log.rolledBack = true; }
  });
  return {
    service: createFinanceService({ getPool: async () => ({}), sql: fakeSql(), transactionFactory }),
    log
  };
}

function transactionFixture({ actorRole = 'finance', balance = '10.00', duplicate = false, failAt = null, studentExists = true, studentStatus = 'active', accountExists = false, transactionAccountExists = true, enrollmentStatus = 'pending_payment', enrollmentClearanceStatus = 'pending', enrollmentPaymentTransactionId = null, paymentAvailable = true, clearanceUpdateRows = 1 } = {}) {
  let stateBalance = balance;
  const { service, log } = transactionalService(({ statement, values }) => {
    if (statement.includes('FROM dbo.users')) return { recordset: actorRole ? [{ id: 7, role: actorRole }] : [] };
    if (statement.includes('FROM dbo.students WITH')) return { recordset: studentExists ? [{ id: 22, status: studentStatus }] : [] };
    if (statement.includes('FROM dbo.financial_accounts WITH')) return { recordset: accountExists ? [{ id: 30 }] : [] };
    if (statement.includes('FROM dbo.financial_accounts AS a')) return { recordset: transactionAccountExists ? [{ financial_account_id: 30, balance: stateBalance, status: studentStatus }] : [] };
    if (statement.includes('FROM dbo.financial_accounts AS account')) return { recordset: transactionAccountExists ? [{ financial_account_id: 30, status: studentStatus }] : [] };
    if (statement.includes('FROM dbo.enrollments AS enrollment WITH')) return { recordset: [{ id: 51, enrollment_status: enrollmentStatus, finalized_at: null, clearance_status: enrollmentClearanceStatus, payment_transaction_id: enrollmentPaymentTransactionId, created_for_intake: 1 }] };
    if (statement.includes('FROM dbo.financial_transactions AS payment')) return { recordset: paymentAvailable ? [{ id: 91 }] : [] };
    if (statement.includes('FROM dbo.financial_transactions WITH')) return { recordset: duplicate ? [{ id: 90 }] : [] };
    if (statement.includes('UPDATE dbo.enrollment_clearances')) return { rowsAffected: [clearanceUpdateRows] };
    if (statement.includes('UPDATE dbo.financial_accounts')) {
      if (failAt === 'update') throw new Error('simulated account update failure');
      stateBalance = values.balance;
      return { recordset: [] };
    }
    if (statement.includes('INSERT INTO dbo.financial_accounts')) {
      if (failAt === 'account_insert') throw new Error('simulated account insert failure');
      return { recordset: [{ id: 30 }] };
    }
    if (statement.includes('INSERT INTO dbo.financial_transactions')) {
      if (failAt === 'transaction_insert') throw new Error('simulated transaction insert failure');
      return { recordset: [{ id: 91 }] };
    }
    if (statement.includes('INSERT INTO dbo.audit_logs')) {
      if (failAt === 'audit') throw new Error('simulated audit failure');
      return { recordset: [] };
    }
    throw new Error(`Unexpected query: ${statement}`);
  });
  return { service, log, getBalance: () => stateBalance };
}

test('money parsing and financial transaction fields enforce DECIMAL(12,2) limits and signs', () => {
  assert.equal(parseMoneyCents('9999999999.99'), 999999999999n);
  assert.equal(parseMoneyCents('-0.01', { allowNegative: true }), -1n);
  assert.equal(formatMoneyCents(-1n), '-0.01');
  assert.deepEqual(validateTransaction({ transactionType: 'charge', amount: '12.3' }), {
    transactionType: 'charge', amountCents: 1230n, amount: '12.30', description: null, referenceNo: null,
    clearEnrollmentId: null, confirmEnrollmentClearance: false
  });
  assert.deepEqual(validateTransaction({ transactionType: 'adjustment', amount: '-2.50', description: 'Correction' }), {
    transactionType: 'adjustment', amountCents: -250n, amount: '-2.50', description: 'Correction', referenceNo: null,
    clearEnrollmentId: null, confirmEnrollmentClearance: false
  });
  assert.throws(() => validateTransaction({ transactionType: 'charge', amount: '-1' }), FinanceServiceError);
  assert.throws(() => validateTransaction({ transactionType: 'payment', amount: '0' }), /must not be zero/);
  assert.throws(() => validateTransaction({ transactionType: 'adjustment', amount: '0.00', description: 'Correction' }), /must not be zero/);
  assert.throws(() => validateTransaction({ transactionType: 'adjustment', amount: '1.00' }), /reason for the balance adjustment/);
  assert.throws(() => validateTransaction({ transactionType: 'adjustment', amount: '1.00', description: 'x'.repeat(501) }), /Description must be/);
  assert.throws(() => validateTransaction({ transactionType: 'charge', amount: '10000000000.00' }), /10 whole digits/);
  assert.throws(() => validateTransaction({ transactionType: 'charge', amount: '1.001' }), /10 whole digits/);
  assert.throws(() => validateTransaction({ transactionType: 'unknown', amount: '1.00' }), /Choose a charge/);
  assert.throws(() => validateTransaction({ transactionType: 'charge', amount: '1.00', referenceNo: 'x'.repeat(101) }), /Reference number must be/);
});

test('student ledger lookup is linked to the authenticated student and hides other accounts', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('FROM dbo.users AS user_account')) {
            return { recordset: [{ student_id: 22, student_no: 'SHS-2026-0001', first_name: 'Alyssa', last_name: 'Reyes', financial_account_id: 31, balance: '240.00' }] };
          }
          if (statement.includes('FROM dbo.financial_transactions AS transaction_record')) {
            return { recordset: [{ id: 90, transaction_type: 'payment', amount: '60.00', description: 'Tuition payment' }] };
          }
          throw new Error(`Unexpected student ledger query: ${statement}`);
        }
      };
    }
  };
  const service = createFinanceService({ getPool: async () => pool, sql: fakeSql() });
  const result = await service.getOwnStudentAccount('7');

  assert.equal(result.student.id, 22);
  assert.deepEqual(result.account, { id: 31, balance: '240.00' });
  assert.equal(result.transactions[0].id, 90);
  assert.equal(calls[0].values.userId, 7);
  assert.match(calls[0].statement, /student\.user_id = user_account\.id/);
  assert.match(calls[0].statement, /user_account\.role = N'student'/);
  assert.deepEqual({ accountId: calls[1].values.accountId, studentId: calls[1].values.studentId }, { accountId: 31, studentId: 22 });
  assert.match(calls[1].statement, /account\.student_id = @studentId/);
  assert.doesNotMatch(calls[0].statement, /@studentId/);
});

test('student ledger lookup rejects an inactive or non-student account before reading transactions', async () => {
  const calls = [];
  const pool = {
    request() {
      return {
        input() { return this; },
        async query(statement) { calls.push(statement); return { recordset: [] }; }
      };
    }
  };
  const service = createFinanceService({ getPool: async () => pool, sql: fakeSql() });
  await assert.rejects(service.getOwnStudentAccount(7), (error) => error instanceof FinanceServiceError && error.status === 403);
  assert.equal(calls.length, 1);
});

test('finance student search is parameterized, escaped, bounded, and limited to finance identifiers', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) { calls.push({ statement, values: { ...values } }); return { recordset: [{ student_id: 22, student_no: 'S-22' }] }; }
      };
    }
  };
  const service = createFinanceService({ getPool: async () => pool, sql: fakeSql() });
  assert.deepEqual(await service.searchStudents(' S_%[1]~ '), { students: [{ student_id: 22, student_no: 'S-22' }], searchTerm: 'S_%[1]~' });
  assert.equal(calls[0].values.searchPattern, '%S~_~%~[1~]~~%');
  assert.match(calls[0].statement, /SELECT TOP \(100\)/);
  assert.doesNotMatch(calls[0].statement, /enrollments|grades|birth_date|address/);
  assert.deepEqual(await service.searchStudents(''), { students: [], searchTerm: '' });
  assert.equal(calls.length, 1, 'empty search should not enumerate student accounts');
  await assert.rejects(service.searchStudents('x'.repeat(101)), /100 printable characters or fewer/);
});

test('recent finance accounts are limited, ordered, finance-authorized, and expose only account identifiers', async () => {
  const calls = [];
  let authorized = true;
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          return {
            recordsets: [
              [{ authorized: authorized ? 1 : 0 }],
              [{ student_id: 22, student_no: 'DEMO-001', balance: '850.00' }]
            ]
          };
        }
      };
    }
  };
  const service = createFinanceService({ getPool: async () => pool, sql: fakeSql() });
  assert.deepEqual(await service.listRecentAccounts(7), [{ student_id: 22, student_no: 'DEMO-001', balance: '850.00' }]);
  assert.equal(calls[0].values.actorId, 7);
  assert.match(calls[0].statement, /role IN \('finance', 'database_admin'\).*is_active = 1|is_active = 1 AND role IN \('finance', 'database_admin'\)/s);
  assert.match(calls[0].statement, /SELECT TOP \(8\)/);
  assert.match(calls[0].statement, /ORDER BY a\.updated_at DESC, a\.id DESC/);
  assert.match(calls[0].statement, /WHERE EXISTS/);
  assert.doesNotMatch(calls[0].statement, /grades|enrollments|documents|birth_date|address/);

  authorized = false;
  calls.length = 0;
  await assert.rejects(service.listRecentAccounts(7), /finance access is no longer active/i);
  assert.equal(calls.length, 1);
});

test('account and transaction history read paths return only the selected student finance record', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('FROM dbo.students')) return { recordset: [{ student_id: 22, student_no: 'S-22', first_name: 'Alex', last_name: 'Kim', status: 'archived' }] };
          if (statement.includes('FROM dbo.enrollments AS enrollment')) return { recordset: [] };
          if (statement.includes('FROM dbo.financial_accounts')) return { recordset: [{ financial_account_id: 30, balance: '-2.50' }] };
          if (statement.includes('FROM dbo.financial_transactions AS payment')) return { recordset: [{ transaction_id: 91, transaction_type: 'payment', amount: '5.00' }] };
          if (statement.includes('FROM dbo.financial_transactions')) return { recordset: [{ id: 90, transaction_type: 'adjustment', amount: '-2.50' }] };
          throw new Error(`Unexpected query: ${statement}`);
        }
      };
    }
  };
  const service = createFinanceService({ getPool: async () => pool, sql: fakeSql() });
  const record = await service.getStudentAccount('22');
  assert.equal(record.student.student_no, 'S-22');
  assert.equal(record.student.status, 'archived');
  assert.equal(record.account.balance, '-2.50');
  assert.equal(record.transactions[0].transaction_type, 'adjustment');
  assert.equal(record.availableEnrollmentPayments[0].transaction_id, 91);
  assert.deepEqual(calls.map(({ values }) => Object.values(values)), [[22], [22], [22], [30], [30]]);
  assert.match(calls[0].statement, /student_no, first_name, middle_name, last_name, suffix, status/);
  assert.match(calls.at(-1).statement, /NOT EXISTS[\s\S]*payment_transaction_id = payment\.id/);
  assert.doesNotMatch(calls.map(({ statement }) => statement).join('\n'), /grade|document|birth_date|address/);
  await assert.rejects(service.getStudentAccount('../22'), /not found/);
});

test('account creation is finance-checked, student-owned, serializable, and audited atomically', async () => {
  const { service, log } = transactionFixture();
  const accountId = await service.createAccount(7, '22');
  assert.equal(accountId, 30);
  assert.equal(log.isolation, 'SERIALIZABLE');
  assert.equal(log.committed, true);
  const studentLock = log.queries.find(({ statement }) => statement.includes('FROM dbo.students WITH'));
  assert.match(studentLock.statement, /UPDLOCK, HOLDLOCK/);
  assert.equal(studentLock.values.studentId, 22);
  const insert = log.queries.find(({ statement }) => statement.includes('INSERT INTO dbo.financial_accounts'));
  assert.equal(insert.values.studentId, 22);
  const audit = log.queries.find(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs'));
  assert.equal(audit.values.action, 'finance.account_created');
  assert.equal(JSON.parse(audit.values.detailsJson).studentId, 22);
});

test('registrar actors cannot write finance data while database administrators can', async () => {
  const deniedAccount = transactionFixture({ actorRole: 'registrar' });
  await assert.rejects(deniedAccount.service.createAccount(7, '22'), /finance access is no longer active/i);
  assert.equal(deniedAccount.log.rolledBack, true);
  assert.equal(deniedAccount.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.financial_accounts')), false);
  assert.equal(deniedAccount.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);

  const adminTransaction = transactionFixture({ actorRole: 'database_admin' });
  await adminTransaction.service.recordTransaction(7, '22', { transactionType: 'charge', amount: '1.00' });
  assert.equal(adminTransaction.log.committed, true);
  assert.equal(adminTransaction.log.queries.at(-1).values.action, 'database_admin.finance_transaction_recorded');
});

test('account creation rejects missing students and existing accounts without writes', async () => {
  const missingStudent = transactionFixture({ studentExists: false });
  await assert.rejects(missingStudent.service.createAccount(7, '22'), /Student record not found/);
  assert.equal(missingStudent.log.rolledBack, true);
  assert.equal(missingStudent.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.financial_accounts')), false);

  const existing = transactionFixture({ accountExists: true });
  await assert.rejects(existing.service.createAccount(7, '22'), /already has a financial account/);
  assert.equal(existing.log.rolledBack, true);
  assert.equal(existing.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.financial_accounts')), false);
});

test('archived students cannot receive new finance accounts or ledger entries', async () => {
  const archivedAccount = transactionFixture({ studentStatus: 'archived' });
  await assert.rejects(archivedAccount.service.createAccount(7, '22'), /Archived students cannot receive new finance records/);
  assert.equal(archivedAccount.log.rolledBack, true);
  const studentRead = archivedAccount.log.queries.find(({ statement }) => statement.includes('FROM dbo.students WITH'));
  assert.match(studentRead.statement, /SELECT id, status/);
  assert.match(studentRead.statement, /UPDLOCK, HOLDLOCK/);
  assert.equal(archivedAccount.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.financial_accounts')), false);
  assert.equal(archivedAccount.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);

  const archivedLedger = transactionFixture({ studentStatus: 'archived' });
  await assert.rejects(archivedLedger.service.recordTransaction(7, '22', { transactionType: 'charge', amount: '1.00' }), /Archived students cannot receive new finance records/);
  assert.equal(archivedLedger.log.rolledBack, true);
  const accountRead = archivedLedger.log.queries.find(({ statement }) => statement.includes('FROM dbo.financial_accounts AS a'));
  assert.match(accountRead.statement, /s\.status/);
  assert.match(accountRead.statement, /dbo\.students AS s WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.equal(archivedLedger.log.queries.some(({ statement }) => statement.includes('UPDATE dbo.financial_accounts')), false);
  assert.equal(archivedLedger.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.financial_transactions')), false);
  assert.equal(archivedLedger.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);
});

test('charges, payments, and signed adjustments update balance in the correct direction', async () => {
  const entries = [
    [{ transactionType: 'charge', amount: '5.00' }, '15.00'],
    [{ transactionType: 'payment', amount: '7.00' }, '3.00'],
    [{ transactionType: 'adjustment', amount: '-12.50', description: 'Credit correction' }, '-2.50']
  ];
  for (const [input, expectedBalance] of entries) {
    const fixture = transactionFixture();
    const result = await fixture.service.recordTransaction(7, '22', input);
    assert.equal(result.balance, expectedBalance);
    assert.equal(fixture.getBalance(), expectedBalance);
    const accountLookup = fixture.log.queries.find(({ statement }) => statement.includes('FROM dbo.financial_accounts AS a'));
    assert.match(accountLookup.statement, /a\.student_id/);
    assert.equal(accountLookup.values.studentId, 22);
    const update = fixture.log.queries.find(({ statement }) => statement.includes('UPDATE dbo.financial_accounts'));
    assert.equal(update.values.balance, expectedBalance);
    const insert = fixture.log.queries.find(({ statement }) => statement.includes('INSERT INTO dbo.financial_transactions'));
    assert.equal(insert.values.amount, input.amount === '7.00' ? '7.00' : input.amount);
    assert.equal(fixture.log.queries.at(-1).values.action, 'finance.transaction_recorded');
    assert.equal(fixture.log.committed, true);
  }
});

test('duplicate references are rejected for the owned account before balance, transaction, or audit writes', async () => {
  const fixture = transactionFixture({ duplicate: true });
  await assert.rejects(fixture.service.recordTransaction(7, '22', {
    transactionType: 'charge', amount: '5.00', referenceNo: 'REF-7'
  }), /already used for this account/);
  const duplicate = fixture.log.queries.find(({ statement }) => statement.includes('FROM dbo.financial_transactions WITH'));
  assert.deepEqual(duplicate.values, { accountId: 30, referenceNo: 'REF-7' });
  assert.match(duplicate.statement, /financial_account_id = @accountId AND reference_no = @referenceNo/);
  assert.equal(fixture.log.rolledBack, true);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('UPDATE dbo.financial_accounts')), false);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.financial_transactions')), false);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);
});

test('transactions require an existing account and reject balance overflow before updates', async () => {
  const absent = transactionFixture({ balance: '10.00', transactionAccountExists: false });
  await assert.rejects(absent.service.recordTransaction(7, '22', { transactionType: 'payment', amount: '1.00' }), /account not found/);
  assert.equal(absent.log.rolledBack, true);

  const overflow = transactionFixture({ balance: '9999999999.99' });
  await assert.rejects(overflow.service.recordTransaction(7, '22', { transactionType: 'charge', amount: '0.01' }), /exceed the supported balance limit/);
  assert.equal(overflow.log.rolledBack, true);
  assert.equal(overflow.log.queries.some(({ statement }) => statement.includes('UPDATE dbo.financial_accounts')), false);
});

test('a transaction insert or audit failure rolls back the balance update and transaction as one unit', async () => {
  for (const failAt of ['transaction_insert', 'audit']) {
    const fixture = transactionFixture({ failAt });
    await assert.rejects(fixture.service.recordTransaction(7, '22', {
      transactionType: 'charge', amount: '2.00', referenceNo: 'REF-1'
    }), /simulated/);
    assert.equal(fixture.log.rolledBack, true);
    assert.equal(fixture.log.committed, false);
    assert.ok(fixture.log.queries.some(({ statement }) => statement.includes('UPDATE dbo.financial_accounts')));
    if (failAt === 'audit') assert.ok(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.financial_transactions')));
  }
});

test('finance can assign one unused payment from the same student account to a specific pending enrollment', async () => {
  const fixture = transactionFixture();
  const result = await fixture.service.clearEnrollmentWithExistingPayment(7, '22', '51', '91', '1');
  assert.deepEqual(result, { enrollmentId: 51, paymentTransactionId: 91 });
  assert.equal(fixture.log.isolation, 'SERIALIZABLE');
  assert.equal(fixture.log.committed, true);
  const enrollmentLock = fixture.log.queries.find(({ statement }) => statement.includes('FROM dbo.enrollments AS enrollment WITH'));
  assert.deepEqual(enrollmentLock.values, { enrollmentId: 51, studentId: 22 });
  assert.match(enrollmentLock.statement, /enrollment_status, enrollment\.finalized_at/);
  const paymentLock = fixture.log.queries.find(({ statement }) => statement.includes('FROM dbo.financial_transactions AS payment'));
  assert.deepEqual(paymentLock.values, { paymentTransactionId: 91, accountId: 30 });
  assert.match(paymentLock.statement, /transaction_type = N'payment'/);
  assert.match(paymentLock.statement, /NOT EXISTS[\s\S]*payment_transaction_id = payment\.id/);
  const update = fixture.log.queries.find(({ statement }) => statement.includes('UPDATE dbo.enrollment_clearances'));
  assert.deepEqual(update.values, { enrollmentId: 51, transactionId: 91, actorId: 7 });
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('UPDATE dbo.financial_accounts')), false);
  assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.financial_transactions')), false);
  const audit = fixture.log.queries.find(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs'));
  assert.equal(audit.values.action, 'finance.enrollment_clearance_updated');
  assert.deepEqual(JSON.parse(audit.values.detailsJson), {
    enrollmentId: 51, paymentTransactionId: 91, existingPayment: true, financeConfirmedEligibility: true
  });
});

test('existing-payment clearance requires explicit finance attestation and rejects used or stale records', async () => {
  const unattested = transactionFixture();
  await assert.rejects(unattested.service.clearEnrollmentWithExistingPayment(7, 22, 51, 91, false), /must confirm/);
  assert.equal(unattested.log.queries.length, 0);

  for (const fixture of [
    transactionFixture({ paymentAvailable: false }),
    transactionFixture({ enrollmentClearanceStatus: 'cleared', enrollmentPaymentTransactionId: 89 }),
    transactionFixture({ enrollmentStatus: 'enrolled' }),
    transactionFixture({ clearanceUpdateRows: 0 })
  ]) {
    await assert.rejects(fixture.service.clearEnrollmentWithExistingPayment(7, 22, 51, 91, true), /unused recorded payment|uncleared pending enrollment|another finance action/);
    assert.equal(fixture.log.rolledBack, true);
    assert.equal(fixture.log.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.audit_logs')), false);
  }
});

function makeAuthPool(role) {
  const user = {
    id: 7,
    email: `${role}@example.edu`,
    password_hash: bcrypt.hashSync('Correct-Horse-Battery-12', 4),
    role,
    is_active: true,
    updated_at_fingerprint: ''
  };
  return async () => ({
    request() {
      return {
        input() { return this; },
        async query(statement) {
          if (statement.includes('WHERE email = @email')) return { recordset: [user] };
          if (statement.includes('WHERE id = @userId')) return { recordset: [{ ...user }] };
          throw new Error(`Unexpected authentication query: ${statement}`);
        }
      };
    }
  });
}

const environment = {
  nodeEnv: 'development',
  devPasswordOnlyLogin: true,
  sessionSecret: 'phase-seven-finance-test-session-secret'
};

function cookieFrom(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function signIn(baseUrl, role) {
  const page = await fetch(`${baseUrl}/login`);
  const cookie = cookieFrom(page);
  const token = csrfFrom(await page.text());
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, email: `${role}@example.edu`, password: 'Correct-Horse-Battery-12' })
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

test('finance routes permit finance staff and database administrators and protect all writes with CSRF', async () => {
  const calls = [];
  const financeService = {
    async searchStudents(searchTerm) { calls.push(['search', searchTerm]); return { students: [], searchTerm }; },
    async getDashboardSummary(actorId) {
      calls.push(['summary', actorId]);
      return { account_count: 3, accounts_due_count: 1, accounts_settled_count: 1, accounts_credit_count: 1, charge_count: 4, payment_count: 3 };
    },
    async listRecentAccounts(actorId) {
      calls.push(['recent', actorId]);
      return [
        { student_id: 22, student_no: 'DEMO-001', first_name: 'Demo', last_name: 'Learner One', financial_account_id: 30, balance: '850.00' },
        { student_id: 23, student_no: 'DEMO-002', first_name: 'Demo', last_name: 'Learner Two', financial_account_id: 31, balance: '0.00' },
        { student_id: 24, student_no: 'DEMO-003', first_name: 'Demo', last_name: 'Learner Three', financial_account_id: 32, balance: '-50.00' }
      ];
    },
    async getStudentAccount(studentId) {
      calls.push(['read', studentId]);
      return { student: { student_id: studentId, student_no: 'S-22', first_name: 'Alex', last_name: 'Kim', status: 'active' }, account: null, transactions: [] };
    },
    async createAccount(actorId, studentId) { calls.push(['create', actorId, studentId]); return 30; },
    async recordTransaction(actorId, studentId, input) { calls.push(['record', actorId, studentId, input]); return {}; },
    async clearEnrollmentWithExistingPayment(actorId, studentId, enrollmentId, paymentId, confirmed) {
      calls.push(['clear', actorId, studentId, enrollmentId, paymentId, confirmed]); return {};
    }
  };
  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, financeService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const redirect = await fetch(`${baseUrl}/dashboard`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(redirect.headers.get('location'), '/finance');
    const workspace = await fetch(`${baseUrl}/finance`, { headers: { cookie } });
    assert.equal(workspace.status, 200);
    const workspaceHtml = await workspace.text();
    assert.match(workspaceHtml, /Finance workspace/);
    assert.match(workspaceHtml, /Find a student account/);
    assert.match(workspaceHtml, /DEMO-001/);
    assert.match(workspaceHtml, /Demo Learner Two/);
    assert.match(workspaceHtml, /finance-status--settled/);
    assert.match(workspaceHtml, /finance-status--credit/);
    assert.ok(calls.some(([name]) => name === 'recent'));
    assert.equal(calls.some(([name]) => name === 'summary'), false, 'the workspace does not fetch decorative account totals');
    assert.equal(calls[0][0], 'search');

    const accountPage = await fetch(`${baseUrl}/finance/students/22`, { headers: { cookie } });
    const accountHtml = await accountPage.text();
    assert.equal(accountPage.status, 200);
    assert.match(accountHtml, /Create financial account/);
    assert.match(accountHtml, /Financial account/);
    assert.doesNotMatch(accountHtml, /id="finance-search-heading"/);
    const missingCsrf = await fetch(`${baseUrl}/finance/students/22/account`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: ''
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(calls.some(([name]) => name === 'create'), false);
    const missingTransactionCsrf = await fetch(`${baseUrl}/finance/students/22/transactions`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: ''
    });
    assert.equal(missingTransactionCsrf.status, 403);
    assert.equal(calls.some(([name]) => name === 'record'), false);

    const clearance = await fetch(`${baseUrl}/finance/students/22/enrollment-clearance`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFrom(accountHtml), enrollmentId: '51', paymentTransactionId: '91', confirmEnrollmentClearance: '1' })
    });
    assert.equal(clearance.status, 303);
    assert.equal(clearance.headers.get('location'), '/finance/students/22?notice=existingPaymentCleared');
    assert.deepEqual(calls.find(([name]) => name === 'clear'), ['clear', 7, 22, '51', '91', '1']);

    const createResponse = await fetch(`${baseUrl}/finance/students/22/account`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFrom(accountHtml) })
    });
    assert.equal(createResponse.status, 303);
    assert.equal(createResponse.headers.get('location'), '/finance/students/22?notice=accountCreated');
  });

  const serviceCallsBeforeDeniedRequests = calls.length;
  for (const role of ['student', 'registrar']) {
    const app = createApp({ databasePool: makeAuthPool(role), environment, financeService });
    await withServer(app, async (baseUrl) => {
      const cookie = await signIn(baseUrl, role);
      const response = await fetch(`${baseUrl}/finance`, { headers: { cookie }, redirect: 'manual' });
      assert.equal(response.status, 403, `${role} must be denied finance access`);
      const write = await fetch(`${baseUrl}/finance/students/22/transactions`, {
        method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: ''
      });
      assert.equal(write.status, 403, `${role} must be denied finance writes`);
    });
  }
  await withServer(createApp({ databasePool: makeAuthPool('database_admin'), environment, financeService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'database_admin');
    const accountPage = await fetch(`${baseUrl}/finance/students/22`, { headers: { cookie } });
    const html = await accountPage.text();
    assert.equal(accountPage.status, 200);
    assert.match(html, /Create financial account/);
    const response = await fetch(`${baseUrl}/finance/students/22/account`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFrom(html) })
    });
    assert.equal(response.status, 303);
    assert.ok(calls.some((call) => call[0] === 'create' && call[1] === 7));
  });
  assert.ok(calls.length > serviceCallsBeforeDeniedRequests, 'database administrator finance request should reach the service');
});

test('archived finance records stay readable without write controls and retain the bounded search', async () => {
  const financeService = {
    async searchStudents(searchTerm) {
      return { searchTerm, students: [{ student_id: 22, student_no: 'S-22', first_name: 'Alex', last_name: 'Kim' }] };
    },
    async getStudentAccount(studentId) {
      return {
        student: { student_id: studentId, student_no: 'S-22', first_name: 'Alex', last_name: 'Kim', status: 'archived' },
        account: { financial_account_id: 30, balance: '15.00' },
        transactions: [{ id: 91, transaction_type: 'charge', amount: '15.00', description: 'Archived history', recorded_by_name: 'Staff' }]
      };
    }
  };

  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, financeService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const workspace = await fetch(`${baseUrl}/finance?search=Alex%20Kim`, { headers: { cookie } });
    const workspaceHtml = await workspace.text();
    assert.match(workspaceHtml, /href="\/finance\/students\/22\?search=Alex%20Kim"/);
    assert.doesNotMatch(workspaceHtml, /Recently updated accounts/);

    const account = await fetch(`${baseUrl}/finance/students/22?search=Alex%20Kim`, { headers: { cookie } });
    const accountHtml = await account.text();
    assert.match(accountHtml, /href="\/finance\?search=Alex%20Kim">Back to finance workspace/);
    assert.doesNotMatch(accountHtml, /id="finance-search-heading"/);
    assert.match(accountHtml, /Archived history/);
    assert.match(accountHtml, /new accounts and transactions are disabled/i);
    assert.doesNotMatch(accountHtml, /action="\/finance\/students\/22\/account/);
    assert.doesNotMatch(accountHtml, /action="\/finance\/students\/22\/transactions/);
  });
});

test('finance account detail groups identity and balance, separates clearance, and gives transaction history full width', async () => {
  const financeService = {
    async getStudentAccount(studentId) {
      return {
        student: { student_id: studentId, student_no: 'SHS-2026-0321', first_name: 'Alex', middle_name: 'Mae', last_name: 'Kim', status: 'active' },
        account: { financial_account_id: 30, balance: '12345.67' },
        pendingEnrollments: [{ enrollment_id: 51, school_year: '2026-2027', term: 'First Semester', section_name: 'Grade 11 - STEM A', clearance_status: 'pending' }],
        availableEnrollmentPayments: [{ transaction_id: 91, amount: '500.00', created_at: new Date('2026-08-01T09:00:00Z'), reference_no: 'RCPT-91' }],
        transactions: [{ id: 92, created_at: new Date('2026-08-02T09:00:00Z'), transaction_type: 'charge', amount: '12345.67', description: 'Tuition charge', reference_no: 'CHG-92', recorded_by_name: 'Finance Staff' }]
      };
    }
  };

  await withServer(createApp({ databasePool: makeAuthPool('finance'), environment, financeService }), async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const response = await fetch(`${baseUrl}/finance/students/22`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /id="finance-account-heading">Alex Mae Kim/);
    assert.match(html, /Student number<\/span><strong>SHS-2026-0321/);
    assert.match(html, /Current balance<\/dt>\s*<dd><span aria-hidden="true">₱<\/span><strong>12,345\.67/);
    assert.match(html, /finance-account-status--due">Due/);
    assert.match(html, /finance-clearance-task/);
    assert.match(html, /finance-transaction-task/);
    assert.match(html, /finance-history-panel/);
    assert.ok(html.indexOf('finance-clearance-task') < html.indexOf('finance-transaction-task'));
    assert.ok(html.indexOf('finance-transaction-task') < html.indexOf('finance-history-panel'));
    assert.match(html, /action="\/finance\/students\/22\/enrollment-clearance"/);
    assert.match(html, /name="paymentTransactionId"/);
    assert.match(html, /name="confirmEnrollmentClearance"/);
    assert.match(html, /action="\/finance\/students\/22\/transactions"/);
    for (const fieldName of ['_csrf', 'transactionType', 'amount', 'description', 'referenceNo']) {
      assert.match(html, new RegExp(`name="${fieldName}"`));
    }
    assert.match(html, /Scrollable transaction history for SHS-2026-0321/);
    assert.match(html, /Tuition charge/);
  });
});
