const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminServiceError, createAdminService } = require('../src/services/adminService');
const { FinanceServiceError, createFinanceService } = require('../src/services/financeService');
const { StudentRecordsError, createStudentRecordsService } = require('../src/services/studentRecordsService');

function summaryServiceHarness(summary) {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          return { recordset: summary ? [summary] : [] };
        }
      };
    }
  };
  const sql = { Int: 'Int', NVarChar: (length) => `NVarChar(${length})`, MAX: 'MAX' };
  const getPool = async () => pool;
  return {
    calls,
    admin: createAdminService({ getPool, sql }),
    finance: createFinanceService({ getPool, sql }),
    studentRecords: createStudentRecordsService({ getPool, sql })
  };
}

test('student dashboard summary is parameterized and tied to the authenticated student link', async () => {
  const summary = { enrollment_count: 2, grade_entry_count: 4, document_count: 3, documents_in_progress_count: 1 };
  const harness = summaryServiceHarness(summary);

  assert.deepEqual(await harness.studentRecords.getStudentDashboardSummary(7), summary);
  const call = harness.calls[0];
  assert.equal(call.values.actorId, 7);
  assert.match(call.statement, /id = @actorId AND role = 'student' AND is_active = 1/);
  assert.match(call.statement, /s\.user_id = @actorId/);
  assert.match(call.statement, /psa_birth_certificate/);
  assert.match(call.statement, /d\.document_type IN \('good_moral', 'psa_birth_certificate'\)/);
  assert.equal((call.statement.match(/d\.document_type = 'report_card' AND d\.is_legacy_archive = 0 AND d\.upload_source = 'student'/g) || []).length, 2);
  assert.doesNotMatch(call.statement, /d\.upload_source IN/);
  assert.doesNotMatch(call.statement, /extracted_text|validation_json/);
});

test('registrar summary returns bounded counts only to an active registrar', async () => {
  const summary = { active_student_count: 12, archived_student_count: 1, current_enrollment_count: 9, documents_awaiting_review_count: 2, documents_processing_count: 3 };
  const harness = summaryServiceHarness(summary);

  assert.deepEqual(await harness.studentRecords.getRegistrarDashboardSummary(11), summary);
  const call = harness.calls[0];
  assert.equal(call.values.actorId, 11);
  assert.match(call.statement, /id = @actorId AND role = 'registrar' AND is_active = 1/);
  assert.match(call.statement, /status IN \('needs_review', 'failed'\)/);
  assert.doesNotMatch(call.statement, /student_no|original_filename|extracted_text/);
});

test('database administrator summary requires the active database administrator role', async () => {
  const summary = { active_user_count: 10, inactive_user_count: 2, active_student_count: 8, archived_student_count: 1, documents_awaiting_review_count: 4 };
  const harness = summaryServiceHarness(summary);

  assert.deepEqual(await harness.admin.getDashboardSummary('5'), summary);
  const call = harness.calls[0];
  assert.equal(call.values.actorId, 5);
  assert.match(call.statement, /id = @actorId AND role = 'database_admin' AND is_active = 1/);
  assert.doesNotMatch(call.statement, /details_json|extracted_text/);
});

test('finance summary exposes account and ledger counts only to finance-authorized roles', async () => {
  const summary = { account_count: 10, accounts_due_count: 4, accounts_settled_count: 5, accounts_credit_count: 1, charge_count: 12, payment_count: 8 };
  const harness = summaryServiceHarness(summary);

  assert.deepEqual(await harness.finance.getDashboardSummary(9), summary);
  const call = harness.calls[0];
  assert.equal(call.values.actorId, 9);
  assert.match(call.statement, /id = @actorId AND is_active = 1 AND role IN \('finance', 'database_admin'\)/);
  assert.doesNotMatch(call.statement, /student_no|document_validations|extracted_text/);
});

test('dashboard summary services reject inactive or wrong-role actors when the guarded query returns no row', async () => {
  const harness = summaryServiceHarness(null);

  await assert.rejects(harness.studentRecords.getStudentDashboardSummary(7), StudentRecordsError);
  await assert.rejects(harness.studentRecords.getRegistrarDashboardSummary(7), StudentRecordsError);
  await assert.rejects(harness.admin.getDashboardSummary(7), AdminServiceError);
  await assert.rejects(harness.finance.getDashboardSummary(7), FinanceServiceError);
});
