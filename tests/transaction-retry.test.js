'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSerializableTransaction } = require('../src/services/transactionRetry');

function harness() {
  const stats = { attempts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const sql = { ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' } };
  const transactionFactory = () => {
    stats.attempts += 1;
    return {
      async begin(level) { assert.equal(level, 'SERIALIZABLE'); stats.begins += 1; },
      async commit() { stats.commits += 1; },
      async rollback() { stats.rollbacks += 1; }
    };
  };
  return { stats, dependencies: { getPool: async () => ({}), sql, transactionFactory } };
}

test('retries a transient serialization error in a fresh transaction and commits once', async () => {
  const { stats, dependencies } = harness();
  let callbacks = 0;
  const result = await runSerializableTransaction(dependencies, async () => {
    callbacks += 1;
    if (callbacks === 1) {
      const error = new Error('serialization conflict');
      error.code = 'ER_CHECKREAD';
      throw error;
    }
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.equal(callbacks, 2);
  assert.deepEqual(stats, { attempts: 2, begins: 2, commits: 1, rollbacks: 1 });
});

test('does not retry a domain conflict or other non-retryable error', async () => {
  const { stats, dependencies } = harness();
  const conflict = Object.assign(new Error('finance approval is stale'), { status: 409 });
  await assert.rejects(runSerializableTransaction(dependencies, async () => { throw conflict; }), (error) => error === conflict);
  assert.deepEqual(stats, { attempts: 1, begins: 1, commits: 0, rollbacks: 1 });
});

test('returns the final transient error after the bounded retry limit', async () => {
  const { stats, dependencies } = harness();
  let callbacks = 0;
  let finalError;
  await assert.rejects(runSerializableTransaction(dependencies, async () => {
    callbacks += 1;
    finalError = Object.assign(new Error(`serialization conflict ${callbacks}`), { code: 'ER_LOCK_DEADLOCK' });
    throw finalError;
  }), (error) => error === finalError);
  assert.equal(callbacks, 3);
  assert.deepEqual(stats, { attempts: 3, begins: 3, commits: 0, rollbacks: 3 });
});
