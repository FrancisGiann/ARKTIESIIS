const test = require('node:test');
const assert = require('node:assert/strict');
const { Request, Transaction, isDuplicateKeyError } = require('../src/config/database');

test('request supports typed and mssql-style two-argument input with prepared binding', async () => {
  let execution;
  const sessionStatements = [];
  const connection = {
    async query(statement) { sessionStatements.push(statement); },
    async execute(statement, values) {
      execution = { statement, values };
      return [{ affectedRows: 1 }, []];
    },
    release() {}
  };

  const result = await new Request(connection)
    .input('first', 17)
    .input('second', 'VARCHAR(20)', 'bound')
    .query('SELECT @first AS first, @second AS second');

  assert.deepEqual(execution, { statement: 'SELECT ? AS first, ? AS second', values: [17, 'bound'] });
  assert.deepEqual(sessionStatements, ['SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci']);
  assert.equal(result.affectedRows, 1);
});

test('each acquired pooled connection initializes its MariaDB charset before prepared statements', async () => {
  const state = { queries: [], executions: 0, releases: 0 };
  const connection = {
    async query(statement) { state.queries.push(statement); },
    async execute() { state.executions += 1; return [[{ ok: 1 }], []]; },
    release() { state.releases += 1; }
  };
  const source = { async getConnection() { return connection; } };
  const request = () => new Request(null, source).input('value', 'text');

  await request().query('SELECT @value');
  await request().query('SELECT @value');

  assert.deepEqual(state.queries, ['SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci']);
  assert.equal(state.executions, 2);
  assert.equal(state.releases, 2);
});

test('pooled wrappers sharing one physical session initialize it only once', async () => {
  const state = { queries: 0, executions: 0, releases: 0 };
  const physical = {
    async query() { state.queries += 1; },
    async execute() { state.executions += 1; return [[{ ok: 1 }], []]; }
  };
  const source = {
    async getConnection() {
      return {
        connection: physical,
        query: physical.query.bind(physical),
        execute: physical.execute.bind(physical),
        release() { state.releases += 1; }
      };
    }
  };

  await new Request(null, source).query('SELECT 1');
  await new Request(null, source).query('SELECT 1');

  assert.deepEqual(state, { queries: 1, executions: 2, releases: 2 });
});

test('a connection is discarded if charset initialization fails', async () => {
  const state = { releases: 0, destroys: 0 };
  const connection = {
    async query() { throw new Error('session initialization failed'); },
    async execute() { throw new Error('must not execute SQL'); },
    release() { state.releases += 1; },
    destroy() { state.destroys += 1; }
  };
  const request = new Request(null, { async getConnection() { return connection; } });

  await assert.rejects(request.query('SELECT 1'), /session initialization failed/);
  assert.deepEqual(state, { releases: 0, destroys: 1 });
});

test('MariaDB duplicate-key errors are recognized from driver code or errno', () => {
  assert.equal(isDuplicateKeyError({ code: 'ER_DUP_ENTRY', errno: 1062 }), true);
  assert.equal(isDuplicateKeyError({ errno: '1062' }), true);
  assert.equal(isDuplicateKeyError({ number: 2627 }), false);
  assert.equal(isDuplicateKeyError(new Error('unrelated')), false);
});

test('failed commit rolls back before releasing a connection to the pool', async () => {
  const state = { begin: 0, commit: 0, rollback: 0, release: 0, destroy: 0 };
  const connection = {
    async query() {},
    async beginTransaction() { state.begin += 1; },
    async commit() { state.commit += 1; throw new Error('commit failed'); },
    async rollback() { state.rollback += 1; },
    release() { state.release += 1; },
    destroy() { state.destroy += 1; }
  };
  const transaction = new Transaction({ source: { async getConnection() { return connection; } } });
  await transaction.begin();
  await assert.rejects(transaction.commit(), /commit failed/);

  assert.deepEqual(state, { begin: 1, commit: 1, rollback: 1, release: 1, destroy: 0 });
  assert.equal(transaction.active, false);
  assert.equal(transaction.connection, null);
});

test('failed rollback destroys rather than releasing a possibly open transaction', async () => {
  const state = { rollback: 0, release: 0, destroy: 0 };
  const connection = {
    async query() {},
    async beginTransaction() {},
    async rollback() { state.rollback += 1; throw new Error('rollback failed'); },
    release() { state.release += 1; },
    destroy() { state.destroy += 1; }
  };
  const transaction = new Transaction({ source: { async getConnection() { return connection; } } });
  await transaction.begin();
  await assert.rejects(transaction.rollback(), /rollback failed/);

  assert.deepEqual(state, { rollback: 1, release: 0, destroy: 1 });
  assert.equal(transaction.active, false);
  assert.equal(transaction.connection, null);
});

test('transaction initializes charset before starting and discards on initialization failure', async () => {
  const statements = [];
  const connection = {
    async query(statement) { statements.push(statement); },
    async beginTransaction() { statements.push('BEGIN'); },
    async rollback() { statements.push('ROLLBACK'); },
    release() {},
    destroy() { statements.push('DESTROY'); }
  };
  const transaction = new Transaction({ source: { async getConnection() { return connection; } } });
  await transaction.begin();
  assert.deepEqual(statements.slice(0, 3), [
    'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'BEGIN'
  ]);
  await transaction.rollback();

  const failedStatements = [];
  const failedConnection = {
    async query() { throw new Error('charset setup failed'); },
    async rollback() { failedStatements.push('ROLLBACK'); },
    release() { failedStatements.push('RELEASE'); },
    destroy() { failedStatements.push('DESTROY'); }
  };
  const failedTransaction = new Transaction({ source: { async getConnection() { return failedConnection; } } });
  await assert.rejects(failedTransaction.begin(), /charset setup failed/);
  assert.deepEqual(failedStatements, ['DESTROY']);
});
