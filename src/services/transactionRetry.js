'use strict';

const RETRYABLE_TRANSACTION_CODES = new Set([
  'ER_CHECKREAD',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT'
]);

async function runSerializableTransaction({ getPool, sql, transactionFactory }, callback, maxRetries = 2) {
  const pool = await getPool();
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const transaction = transactionFactory(pool);
    let started = false;
    try {
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      const result = await callback(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      if (started) await transaction.rollback().catch(() => {});
      if (!RETRYABLE_TRANSACTION_CODES.has(error?.code) || attempt >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw new Error('The transaction retry limit was exceeded.');
}

module.exports = { RETRYABLE_TRANSACTION_CODES, runSerializableTransaction };
