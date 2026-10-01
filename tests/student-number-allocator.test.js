const test = require('node:test');
const assert = require('node:assert/strict');
const {
  StudentNumberAllocationError,
  schoolYearStart,
  allocateStudentNumber
} = require('../src/services/studentNumberAllocator');

const sql = { NVarChar: (length) => `NVarChar(${length})` };

function createMutex() {
  let locked = false;
  const waiters = [];
  return {
    async acquire() {
      if (!locked) {
        locked = true;
        return () => {
          const next = waiters.shift();
          if (next) next();
          else locked = false;
        };
      }
      await new Promise((resolve) => waiters.push(resolve));
      return () => {
        const next = waiters.shift();
        if (next) next();
        else locked = false;
      };
    }
  };
}

test('school year parser accepts consecutive academic years only', () => {
  assert.equal(schoolYearStart('2026-2027'), '2026');
  assert.equal(schoolYearStart(' 2026-2027 '), '2026');
  for (const value of ['2026/2027', '2026-2028', '9999-10000', '0999-1000', '', null]) {
    assert.equal(schoolYearStart(value), null);
  }
});

test('allocator reuses the highest matching existing number and ignores other years', async () => {
  const rows = ['SHS-2026-0319', 'SHS-2026-0320', 'SHS-2025-9000', 'OTHER-2026-9999', 'SHS-2026-ABCD'];
  const calls = [];
  const transaction = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values });
          if (statement.startsWith('INSERT INTO application_locks')) return { recordset: [] };
          if (statement.startsWith('SELECT lock_name FROM application_locks')) return { recordset: [{ lock_name: values.lockName }] };
          const prefix = String(values.prefix);
          return { recordset: rows.filter((value) => value.startsWith(prefix))
            .map((value) => value.slice(prefix.length)).filter((value) => /^\d+$/.test(value))
            .map((sequence) => ({ sequence })) };
        }
      };
    }
  };
  assert.equal(await allocateStudentNumber(transaction, sql, '2026-2027'), 'SHS-2026-0321');
  assert.equal(calls[0].values.lockName, 'student-number:2026');
  assert.match(calls[0].statement, /INSERT INTO application_locks/);
  assert.equal(calls[2].values.prefix, 'SHS-2026-');
  assert.match(calls[2].statement, /REGEXP '\^\[0-9\]\+\$'/);
  assert.match(calls[2].statement, /FOR UPDATE/);
});

test('transaction-owned application lock serializes simultaneous allocations for one year', async () => {
  const rows = ['SHS-2026-0009'];
  const mutex = createMutex();
  function makeTransaction() {
    let release;
    return {
      request() {
        const values = {};
        return {
          input(name, _type, value) { values[name] = value; return this; },
          async query(statement) {
            if (statement.startsWith('INSERT INTO application_locks')) {
              release = await mutex.acquire();
              return { recordset: [] };
            }
            if (statement.startsWith('SELECT lock_name FROM application_locks')) return { recordset: [{ lock_name: values.lockName }] };
            const prefix = String(values.prefix);
            return { recordset: rows.filter((value) => value.startsWith(prefix))
              .map((value) => value.slice(prefix.length)).map((sequence) => ({ sequence })) };
          }
        };
      },
      commit() { release?.(); }
    };
  }
  async function issue() {
    const transaction = makeTransaction();
    const number = await allocateStudentNumber(transaction, sql, '2026-2027');
    rows.push(number);
    transaction.commit();
    return number;
  }
  const issued = await Promise.all([issue(), issue(), issue()]);
  assert.deepEqual(issued.sort(), ['SHS-2026-0010', 'SHS-2026-0011', 'SHS-2026-0012']);
});

test('allocation rejects invalid years and reports exhausted sequences as a safe service error', async () => {
  await assert.rejects(allocateStudentNumber({ request() { throw new Error('must not query'); } }, sql, '2026/2027'),
    (error) => error instanceof StudentNumberAllocationError && /invalid school year/.test(error.message));
  const exhausted = {
    request() {
      return {
        input() { return this; },
        async query(statement) {
          if (statement.startsWith('INSERT INTO application_locks')) return { recordset: [] };
          if (statement.startsWith('SELECT lock_name FROM application_locks')) return { recordset: [{ lock_name: 'student-number:2026' }] };
          return { recordset: [{ sequence: '9'.repeat(39) }] };
        }
      };
    }
  };
  await assert.rejects(allocateStudentNumber(exhausted, sql, '2026-2027'), (error) => {
    assert.ok(error instanceof StudentNumberAllocationError);
    assert.equal(error.status, 409);
    assert.match(error.message, /sequence.*limit/i);
    assert.doesNotMatch(error.message, /database detail/);
    return true;
  });
});
