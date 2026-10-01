'use strict';

const mysql = require('mysql2/promise');
const env = require('./environment');

const ISOLATION_LEVEL = Object.freeze({
  READ_UNCOMMITTED: 'READ UNCOMMITTED',
  READ_COMMITTED: 'READ COMMITTED',
  REPEATABLE_READ: 'REPEATABLE READ',
  SERIALIZABLE: 'SERIALIZABLE'
});

const sql = Object.freeze({
  Int: 'INT',
  BigInt: 'BIGINT',
  TinyInt: 'TINYINT',
  SmallInt: 'SMALLINT',
  Bit: 'BOOLEAN',
  Date: 'DATE',
  DateTime: 'DATETIME',
  DateTime2: 'DATETIME',
  UniqueIdentifier: 'CHAR(36)',
  Char: (length) => `CHAR(${length})`,
  NChar: (length) => `CHAR(${length})`,
  VarChar: (length) => `VARCHAR(${length})`,
  NVarChar: (length) => length === sql.MAX ? 'LONGTEXT' : `VARCHAR(${length})`,
  Decimal: (precision, scale) => `DECIMAL(${precision},${scale})`,
  MAX: 'MAX',
  ISOLATION_LEVEL,
  Transaction: function Transaction(poolFacade) { return new TransactionFacade(poolFacade); }
});

class DatabaseConfigurationError extends Error {}

function isDuplicateKeyError(error) {
  return error?.code === 'ER_DUP_ENTRY' || Number(error?.errno) === 1062;
}

function releaseConnection(connection) {
  try { connection.release(); } catch { /* Do not replace the transaction result. */ }
}

function discardConnection(connection) {
  if (typeof connection.destroy !== 'function') return;
  try { connection.destroy(); } catch { /* A failed connection must not reenter the pool. */ }
}

function createRawPool() {
  if (!env.database.password) throw new DatabaseConfigurationError('DB_PASSWORD is required.');
  if (!env.database.database) throw new DatabaseConfigurationError('DB_NAME is required.');
  return mysql.createPool({
    host: env.database.host,
    port: env.database.port,
    ...(env.database.socketPath ? { socketPath: env.database.socketPath } : {}),
    user: env.database.user,
    password: env.database.password,
    database: env.database.database,
    flags: '+FOUND_ROWS',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'],
    multipleStatements: false
  });
}

let rawPool;
let facade;
let pendingConnection;

function scanSql(source, onCode, onString) {
  let result = '';
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === 'code') {
      if (character === "'") {
        state = 'single';
        result += onString ? onString(character, index) : character;
        continue;
      }
      if (character === '"') {
        state = 'double';
        result += character;
        continue;
      }
      if (character === '`') {
        state = 'backtick';
        result += character;
        continue;
      }
      if (character === '-' && next === '-') {
        state = 'line-comment';
        result += '--';
        index += 1;
        continue;
      }
      if (character === '/' && next === '*') {
        state = 'block-comment';
        result += '/*';
        index += 1;
        continue;
      }
      const converted = onCode(character, index);
      if (converted && typeof converted === 'object') {
        result += converted.text;
        index += converted.skip || 0;
      } else {
        result += converted;
      }
      continue;
    }

    result += character;
    if (state === 'single' && character === "'") {
      if (next === "'") {
        result += next;
        index += 1;
      } else if (source[index - 1] !== '\\') {
        state = 'code';
      }
    } else if (state === 'double' && character === '"') {
      state = 'code';
    } else if (state === 'backtick' && character === '`') {
      state = 'code';
    } else if (state === 'line-comment' && (character === '\n' || character === '\r')) {
      state = 'code';
    } else if (state === 'block-comment' && character === '*' && next === '/') {
      result += '/';
      index += 1;
      state = 'code';
    }
  }
  return result;
}

function normalizeBasicSql(source) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('A SQL statement is required.');
  return source.trim().replace(/;\s*$/, '');
}

function prepareNamedParameters(source, bindings) {
  const values = [];
  const missing = new Set();
  const prepared = scanSql(source, (character, index) => {
    if (character !== '@') return character;
    if (source[index + 1] === '@') return { text: '@@', skip: 1 };
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index + 1));
    if (!match) return character;
    const name = match[0];
    if (!Object.hasOwn(bindings, name)) {
      missing.add(name);
      return character;
    }
    values.push(bindings[name]);
    return { text: '?', skip: name.length };
  });
  if (missing.size) throw new Error(`The SQL statement references unbound parameter(s): ${[...missing].join(', ')}.`);
  return { sql: prepared, values };
}

function resultFromDriver(driverResult) {
  if (Array.isArray(driverResult)) {
    return { recordset: driverResult, recordsets: [driverResult], rowsAffected: [0], output: {} };
  }
  const affectedRows = Number(driverResult.affectedRows || 0);
  return {
    recordset: [],
    recordsets: [],
    rowsAffected: [affectedRows],
    output: {},
    insertId: Number(driverResult.insertId || 0),
    affectedRows,
    changedRows: Number(driverResult.changedRows || 0)
  };
}

class Request {
  constructor(connection = null, poolSource = null) {
    this.connection = connection;
    this.poolSource = poolSource;
    this.bindings = Object.create(null);
  }

  input(name, _type, value) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError('SQL parameter names must be identifiers.');
    if (arguments.length === 2) value = _type;
    this.bindings[name] = value === undefined ? null : value;
    return this;
  }

  async query(source) {
    const rawSql = normalizeBasicSql(source);
    const { sql: preparedSql, values } = prepareNamedParameters(rawSql, this.bindings);
    const connection = this.connection || await this.poolSource.getConnection();
    try {
      const [driverResult] = await connection.execute(preparedSql, values);
      return resultFromDriver(driverResult);
    } finally {
      if (!this.connection) connection.release();
    }
  }

  async batch(source) {
    return this.query(source);
  }
}

class PoolFacade {
  constructor(source) { this.source = source; }
  request() { return new Request(null, this.source); }
  async close() { await this.source.end(); }
  async connect() { return this; }
}

class TransactionFacade {
  constructor(poolFacade) {
    this.poolFacade = poolFacade;
    this.connection = null;
    this.active = false;
  }

  async begin(isolation = ISOLATION_LEVEL.REPEATABLE_READ) {
    if (this.active) throw new Error('The transaction has already begun.');
    if (!Object.values(ISOLATION_LEVEL).includes(isolation)) throw new TypeError('Unsupported transaction isolation level.');
    this.connection = await this.poolFacade.source.getConnection();
    try {
      await this.connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
      await this.connection.beginTransaction();
      this.active = true;
    } catch (error) {
      const connection = this.connection;
      this.connection = null;
      try {
        await connection.rollback();
        releaseConnection(connection);
      } catch {
        discardConnection(connection);
      }
      throw error;
    }
  }

  request() {
    if (!this.active || !this.connection) throw new Error('The transaction has not begun or has already ended.');
    return new Request(this.connection);
  }

  async commit() {
    if (!this.active || !this.connection) throw new Error('The transaction has not begun or has already ended.');
    const connection = this.connection;
    try {
      await connection.commit();
    } catch (error) {
      this.active = false;
      this.connection = null;
      try {
        await connection.rollback();
        releaseConnection(connection);
      } catch {
        discardConnection(connection);
      }
      throw error;
    }
    this.active = false;
    this.connection = null;
    releaseConnection(connection);
  }

  async rollback() {
    if (!this.active || !this.connection) return;
    const connection = this.connection;
    try {
      await connection.rollback();
    } catch (error) {
      this.active = false;
      this.connection = null;
      discardConnection(connection);
      throw error;
    }
    this.active = false;
    this.connection = null;
    releaseConnection(connection);
  }
}

async function getPool() {
  if (!rawPool) {
    rawPool = createRawPool();
    facade = new PoolFacade(rawPool);
  }
  if (pendingConnection) return pendingConnection;
  const activePool = facade;
  const attempt = rawPool.getConnection().then((connection) => {
    connection.release();
    return activePool;
  }).catch((error) => {
    if (rawPool && facade === activePool) {
      rawPool.end().catch(() => {});
      rawPool = null;
      facade = null;
    }
    throw error;
  });
  pendingConnection = attempt;
  try {
    return await attempt;
  } finally {
    if (pendingConnection === attempt) pendingConnection = null;
  }
}

async function closePool() {
  const active = rawPool;
  rawPool = null;
  facade = null;
  if (active) await active.end();
}

async function acquireTransactionLock(transaction, lockName) {
  if (!transaction || typeof transaction.request !== 'function'
    || typeof lockName !== 'string' || !lockName || lockName.length > 255) {
    throw new TypeError('A transaction and a valid lock name are required.');
  }
  await transaction.request().input('lockName', sql.VarChar(255), lockName)
    .query(`INSERT INTO application_locks (lock_name) VALUES (@lockName)
      ON DUPLICATE KEY UPDATE lock_name = VALUES(lock_name)`);
  await transaction.request().input('lockName', sql.VarChar(255), lockName)
    .query('SELECT lock_name FROM application_locks WHERE lock_name = @lockName FOR UPDATE');
}

module.exports = {
  sql,
  getPool,
  closePool,
  acquireTransactionLock,
  isDuplicateKeyError,
  PoolFacade,
  Transaction: TransactionFacade,
  Request,
  normalizeBasicSql,
  prepareNamedParameters
};
