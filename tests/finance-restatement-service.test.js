'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnnualFinanceCasesService } = require('../src/services/annualFinanceCasesService');

test('exemption approval iterates only currently effective charges while locking base rows', async () => {
  const statements = [];
  const sql = {
    Int: 'INT', TinyInt: 'TINYINT', BigInt: 'BIGINT', Bit: 'BIT', MAX: 'MAX',
    NVarChar: (length) => ({ type: 'NVARCHAR', length }),
    Decimal: (precision, scale) => ({ type: 'DECIMAL', precision, scale })
  };
  const annual = {
    id: 42, student_id: 77, school_year: '2026-2027', grade_level: 'Grade 11',
    entry_term_number: 1, intake_status: 'enrolled', student_status: 'active'
  };
  function request() {
    return {
      input() { return this; },
      async query(statement) {
        statements.push(statement);
        if (statement.includes('SELECT student_id FROM annual_enrollments')) return { recordset: [{ student_id: 77 }] };
        if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 5, role: 'finance' }] };
        if (statement.includes('SELECT annual.id, annual.student_id')) return { recordset: [annual] };
        if (statement.includes('SELECT id, annual_enrollment_id, request_fingerprint FROM finance_exemption_cases')) return { recordset: [] };
        if (statement.includes('SELECT id FROM finance_exemption_cases')) return { recordset: [] };
        if (statement.includes('SELECT charge.id AS charge_id FROM assessed_charges')) return { recordset: [] };
        if (statement.startsWith('INSERT INTO finance_exemption_cases')) return { insertId: 901 };
        return { insertId: 902, rowsAffected: [1], recordset: [] };
      }
    };
  }
  const pool = { request };
  const transaction = { request };
  const service = createAnnualFinanceCasesService({
    getPool: async () => pool,
    sql,
    transaction,
    debtRevisions: {
      async lockStudent() { return { id: 77, status: 'active' }; },
      async readSnapshot() { return { canonicalBalanceCents: 0n }; },
      async recordIncreaseIfAny() {}
    }
  });

  await service.approveExemptionCase(5, 42, {
    expectedStudentId: 77,
    reason: 'approved support',
    idempotencyKey: 'd663bcc2-7131-40e0-b0d2-a81fce12d5a8',
    rules: [{ termNumber: 1, feeCategory: 'tuition', isFullCoverage: true, approvedAmount: '0.00' }]
  });

  const chargeSelection = statements.find((statement) => statement.includes('SELECT charge.id AS charge_id FROM assessed_charges'));
  assert.ok(chargeSelection);
  assert.match(chargeSelection, /EXISTS\s*\(SELECT 1 FROM v_finance_effective_assessed_charges AS effective WHERE effective\.id = charge\.id\)/);
  assert.match(chargeSelection, /ORDER BY charge\.enrollment_id, charge\.id FOR UPDATE/);
});
