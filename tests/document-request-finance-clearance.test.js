'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createStudentDocumentFinanceClearanceService,
  StudentDocumentFinanceClearanceError
} = require('../src/services/studentDocumentFinanceClearanceService');
const { ledgerCompletenessCondition } = require('../src/services/financeDebtRevisionService');

function fakeSql() {
  return {
    Int: 'Int', BigInt: 'BigInt', Bit: 'Bit', UniqueIdentifier: 'UniqueIdentifier',
    Char: (length) => `Char(${length})`,
    Date: 'Date',
    Decimal: (precision, scale) => `Decimal(${precision},${scale})`,
    NVarChar: (length) => `NVarChar(${length})`,
    MAX: 'MAX',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' }
  };
}

function fakePool(onQuery) {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          const call = { statement, values: { ...values } };
          calls.push(call);
          return onQuery(call);
        }
      };
    }
  };
  return { pool, calls };
}

const requestId = '30000000-0000-4000-8000-000000000001';

test('ledger completeness scopes both missing-record branches to the requested student', () => {
  const sql = ledgerCompletenessCondition('student.id');
  assert.match(sql, /AND NOT EXISTS \(SELECT 1 FROM annual_enrollments AS annual\s+WHERE annual\.student_id = student\.id\s+AND \(\(annual\.intake_status = 'legacy'/);
  assert.match(sql, /OR \(annual\.intake_status IN \('enrolled', 'dropped', 'transferred'\) AND NOT EXISTS/);
  assert.match(sql, /assessment\.annual_enrollment_id = annual\.id/);
  assert.match(sql, /annual\.student_id = student\.id\s+AND \(\(annual\.intake_status/);
});

test('registrar projection shows balance separately from clearance and strips private arrangement text', async () => {
  const { pool } = fakePool(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 9, role: 'registrar', first_name: 'Rae', last_name: 'Staff' }] };
    if (statement.includes('SELECT id FROM students')) return { recordset: [{ id: 41 }] };
    if (statement.includes('FROM student_document_requests AS request')) {
      return { recordset: [
        { id: requestId, status: 'requested', current_claim_slip_id: null },
        { id: '30000000-0000-4000-8000-000000000002', status: 'released', current_claim_slip_id: null }
      ] };
    }
    if (statement.includes('FROM student_document_clearance_events AS event')) {
      return { recordset: [{
        request_id: requestId, id: 8, event_type: 'approved', clearance_status: 'approved',
        debt_increase_revision: '4', payment_arrangement: 'PRIVATE ARRANGEMENT TEXT',
        created_at: new Date('2026-04-01T00:00:00.000Z'), actor_first_name: 'Fin', actor_last_name: 'Staff'
      }] };
    }
    if (statement.includes('FROM student_document_claim_slips AS slip')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  const service = createStudentDocumentFinanceClearanceService({
    getPool: async () => pool,
    sql: fakeSql(),
    debtRevisionService: { async getStudentSnapshot() {
      return { debtIncreaseRevision: '4', outstanding: '125.00', ledgerComplete: true };
    } }
  });

  const data = await service.getRegistrarData(9, 41);
  assert.deepEqual(data.financeSummary, { status: 'With balance', outstanding: '125.00' });
  assert.equal(data.requests[0].status, 'approved');
  assert.equal(data.requests[0].hasArrangement, true);
  assert.equal(data.requests[0].actorName, 'Fin Staff');
  assert.equal(data.requests[1].status, 'historical_no_clearance');
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE ARRANGEMENT TEXT|finance_note|paymentArrangement/);
});

test('missing finance records produce review status and never a zero balance', async () => {
  const { pool } = fakePool(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 9, role: 'registrar' }] };
    if (statement.includes('SELECT id FROM students')) return { recordset: [{ id: 41 }] };
    if (statement.includes('FROM student_document_requests AS request')) return { recordset: [] };
    if (statement.includes('FROM student_document_clearance_events AS event')) return { recordset: [] };
    if (statement.includes('FROM student_document_claim_slips AS slip')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  const service = createStudentDocumentFinanceClearanceService({
    getPool: async () => pool,
    sql: fakeSql(),
    debtRevisionService: { async getStudentSnapshot() {
      return { debtIncreaseRevision: '0', outstanding: '0.00', ledgerComplete: false };
    } }
  });
  assert.deepEqual(await service.getRegistrarData(9, 41), {
    financeSummary: { status: 'Needs finance review', outstanding: null },
    requests: []
  });
});

test('finance queue filters effective clearance before pagination and bounds results to 100 plus one', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    effective_clearance_status: index === 0 ? 'pending' : 'approved',
    ledger_complete: 1, outstanding: '0.00', current_revision: '2'
  }));
  let queueCall;
  const { pool } = fakePool(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 2, role: 'finance' }] };
    queueCall = statement;
    return { recordset: rows };
  });
  const service = createStudentDocumentFinanceClearanceService({
    getPool: async () => pool,
    sql: fakeSql(),
    debtRevisionService: {}
  });
  const queue = await service.getFinanceQueue(2, { status: 'pending', page: '1' });
  assert.equal(queue.rows.length, 100);
  assert.equal(queue.hasNext, true);
  assert.equal(queue.rows[0].clearanceStatus, 'pending');
  const computed = queueCall.indexOf('effective_clearance_status');
  const filtered = queueCall.indexOf('WHERE ((@status IS NULL');
  const limited = queueCall.indexOf('ORDER BY created_at DESC, id LIMIT @limit OFFSET @offset');
  assert.ok(computed >= 0 && filtered > computed && limited > filtered);
  assert.match(queueCall, /CASE WHEN latest\.id IS NULL THEN 'pending'/);
  assert.match(queueCall, /annual\.student_id = student\.id/);
  assert.match(queueCall, /annual\.intake_status = 'legacy'/);
});

test('queue role checks reject registrar users and nested printable-slip URLs enforce student ownership', async () => {
  const { pool, calls } = fakePool(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 9, role: 'registrar' }] };
    if (statement.includes('SELECT student_id FROM student_document_requests')) return { recordset: [{ student_id: 41 }] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  const service = createStudentDocumentFinanceClearanceService({
    getPool: async () => pool,
    sql: fakeSql(),
    transactionFactory() { throw new Error('ownership failure must happen before a transaction'); },
    debtRevisionService: {}
  });
  await assert.rejects(service.getFinanceQueue(9), (error) => error instanceof StudentDocumentFinanceClearanceError && error.status === 403);
  await assert.rejects(service.getPrintableClaimSlip(9, requestId, 42), (error) => error instanceof StudentDocumentFinanceClearanceError && error.status === 404);
  assert.equal(calls.filter((call) => call.statement.includes('SELECT student_id FROM student_document_requests')).length, 1);
});

test('approval submissions without the page snapshot are rejected before database access', async () => {
  let opened = false;
  const service = createStudentDocumentFinanceClearanceService({
    getPool: async () => { opened = true; throw new Error('should not reach database'); },
    sql: fakeSql(), debtRevisionService: {}
  });
  await assert.rejects(service.decideClearance(2, requestId, {
    decision: 'approve', idempotencyKey: '30000000-0000-4000-8000-000000000003',
    ledgerReviewConfirmed: 'on'
  }), /Reload the finance balance/);
  assert.equal(opened, false);
});
