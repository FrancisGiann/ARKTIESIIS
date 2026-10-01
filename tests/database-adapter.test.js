const test = require('node:test');
const assert = require('node:assert/strict');
const { Request, Transaction, isDuplicateKeyError } = require('../src/config/database');

test('request supports typed and mssql-style two-argument input with prepared binding', async () => {
  let execution;
  const connection = {
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
  assert.equal(result.affectedRows, 1);
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
