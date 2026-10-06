'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSerializableTransaction } = require('../src/services/transactionRetry');
const { safeClearanceGateError } = require('../src/services/annualEnrollmentService');

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

test('paper-clearance gate retry codes survive safe wrapping without exposing database details', async () => {
  const { stats, dependencies } = harness();
  const transactions = [];
  const protectedGate = { async verify() {
    transactions.push(stats.attempts);
    if (transactions.length === 1) {
      throw safeClearanceGateError(Object.assign(new Error('private SQL and row values'), { code: 'ER_LOCK_DEADLOCK' }));
    }
    return 'reviewed';
  } };
  const result = await runSerializableTransaction(dependencies, async (transaction) => {
    assert.ok(transaction);
    return protectedGate.verify();
  });
  assert.equal(result, 'reviewed');
  assert.deepEqual(transactions, [1, 2], 'the gate is rechecked in a fresh transaction after a retryable database conflict');
  assert.deepEqual(stats, { attempts: 2, begins: 2, commits: 1, rollbacks: 1 });
});

test('exhausted paper-clearance gate retries retain safe status and message', async () => {
  const { stats, dependencies } = harness();
  await assert.rejects(runSerializableTransaction(dependencies, async () => {
    throw safeClearanceGateError(Object.assign(new Error('private SQL and row values'), { code: 'ER_LOCK_WAIT_TIMEOUT' }));
  }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'ER_LOCK_WAIT_TIMEOUT');
    assert.equal(error.message, 'Paper-clearance prerequisites could not be verified. No enrollment changes were saved.');
    assert.doesNotMatch(error.message, /private SQL|row values/);
    return true;
  });
  assert.deepEqual(stats, { attempts: 3, begins: 3, commits: 0, rollbacks: 3 });
});
