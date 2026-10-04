const test = require('node:test');
const assert = require('node:assert/strict');
const { RegistrarDashboardError, createRegistrarDashboardService } = require('../src/services/registrarDashboardService');
const { FinanceDashboardError, createFinanceDashboardService } = require('../src/services/financeDashboardService');

function fakeSql() {
  return {
    Int: 'Int',
    NVarChar: (length) => `NVarChar(${length})`
  };
}

function queryPool(respond) {
  const calls = [];
  return {
    calls,
    async getPool() {
      return {
        request() {
          const values = {};
          return {
            input(name, type, value) { values[name] = value; return this; },
            async query(statement) {
              const call = { statement, values: { ...values } };
              calls.push(call);
              return respond(call);
            }
          };
        }
      };
    }
  };
}

const terms = [
  { school_year: '2026-2027', term_number: 1, academic_term_id: 61, term: 'First Term', is_current: 0 },
  { school_year: '2026-2027', term_number: 2, academic_term_id: 62, term: 'Second Term', is_current: 1 },
  { school_year: '2026-2027', term_number: 3, academic_term_id: 63, term: 'Third Term', is_current: 0 },
  { school_year: '2025-2026', term_number: 1, academic_term_id: 51, term: 'First Term', is_current: 0 }
];

test('registrar overview defaults to the configured current term and reports distinct year and grade counts', async () => {
  const database = queryPool(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 9 }] };
    if (statement.includes('active_enrolled_count')) return { recordset: [{
      active_enrolled_count: 4, pending_activation_count: 2, dropped_count: 1,
      transferred_count: 1, ever_finalized_count: 6
    }] };
    if (statement.includes('grade_11_count')) return { recordset: [
      { term_number: 1, academic_term_id: 61, term: 'First Term', grade_11_count: 2, grade_12_count: 1 },
      { term_number: 2, academic_term_id: 62, term: 'Second Term', grade_11_count: 3, grade_12_count: 4 },
      { term_number: 3, academic_term_id: 63, term: 'Third Term', grade_11_count: 0, grade_12_count: 5 }
    ] };
    if (statement.includes('school_year_term_order AS configured')) return { recordset: terms };
    throw new Error(`Unexpected query: ${statement}`);
  });
  const service = createRegistrarDashboardService({ getPool: database.getPool, sql: fakeSql() });
  const result = await service.getDashboard('9');

  assert.equal(result.selectedSchoolYear, '2026-2027');
  assert.equal(result.selectedTerm.academicTermId, 62);
  assert.equal(result.activeEnrolledCount, 4);
  assert.equal(result.everFinalizedCount, 6);
  assert.deepEqual([result.pendingActivationCount, result.droppedCount, result.transferredCount, result.departedCount], [2, 1, 1, 2]);
  assert.deepEqual(result.termCounts.map((term) => [term.grade11, term.grade12]), [[2, 1], [3, 4], [0, 5]]);

  const summary = database.calls.find((call) => call.statement.includes('active_enrolled_count'));
  assert.equal(summary.values.selectedTermId, 62);
  assert.match(summary.statement, /COUNT\(DISTINCT CASE WHEN term\.id = @selectedTermId/);
  assert.match(summary.statement, /COUNT\(DISTINCT CASE WHEN enrollment\.finalized_at IS NOT NULL THEN annual\.student_id END\)/);
  assert.match(summary.statement, /annual\.intake_status <> 'legacy'/);
  assert.doesNotMatch(summary.statement, /finance_payments|balance|amount_due|document/);
});

test('registrar overview rejects a term that is configured for a different school year', async () => {
  const database = queryPool(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 9 }] };
    if (statement.includes('school_year_term_order AS configured')) return { recordset: terms };
    throw new Error(`Unexpected query: ${statement}`);
  });
  const service = createRegistrarDashboardService({ getPool: database.getPool, sql: fakeSql() });

  await assert.rejects(service.getDashboard(9, { schoolYear: '2026-2027', termId: '51' }),
    (error) => error instanceof RegistrarDashboardError && /configured for the selected school year/.test(error.message));
  assert.equal(database.calls.length, 2, 'invalid year/term pair is rejected before enrollment queries');
});

test('registrar dashboard data is restricted to an active registrar actor', async () => {
  const database = queryPool(() => ({ recordset: [] }));
  const service = createRegistrarDashboardService({ getPool: database.getPool, sql: fakeSql() });

  await assert.rejects(service.getDashboard(9), (error) => error instanceof RegistrarDashboardError && error.status === 403);
  assert.equal(database.calls.length, 1);
  assert.match(database.calls[0].statement, /is_active = 1 AND role = 'registrar'/);
});

test('finance overview applies configured-year and grade filters with reversal-aware term charge semantics', async () => {
  const database = queryPool(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 9 }] };
    if (statement.includes('FROM student_document_requests AS request')) return { recordset: [{ document_clearance_count: 2, departure_review_count: 1, saved_review_count: 3 }] };
    if (statement.includes('FROM FinanceTermClassification')) return { recordset: [
      { finance_status: 'unpaid', student_count: 3 },
      { finance_status: 'partially_paid', student_count: 1 },
      { finance_status: 'no_payment_required', student_count: 2 }
    ] };
    if (statement.includes('school_year_term_order AS configured')) return { recordset: terms };
    if (statement.includes('SELECT DISTINCT grade_level')) return { recordset: [{ grade_level: 'Grade 11' }, { grade_level: 'Grade 12' }] };
    if (statement.includes('SELECT DISTINCT section.id AS section_id')) return { recordset: [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  const service = createFinanceDashboardService({ getPool: database.getPool, sql: fakeSql() });
  const result = await service.getOverview(9, { schoolYear: '2026-2027', gradeLevel: 'Grade 11' });
  const counts = database.calls.find((call) => call.statement.includes('FROM FinanceTermClassification'));

  assert.equal(result.selectedSchoolYear, '2026-2027');
  assert.equal(result.selectedGrade, 'Grade 11');
  assert.deepEqual(result.queueCounts, { documentClearance: 2, departureReview: 1, savedReviews: 3 });
  assert.equal(counts.values.schoolYear, '2026-2027');
  assert.equal(counts.values.gradeLevel, 'Grade 11');
  assert.equal(result.totalEligible, 6);
  assert.deepEqual(result.statusCounts.map((item) => item.count), [3, 1, 0, 2, 0]);
  assert.match(counts.statement, /FROM FinanceTermClassification/);
  assert.match(counts.statement, /GROUP BY whole_status/);
  assert.match(counts.statement, /term_scope_status = 'applicable'/);
  assert.match(counts.statement, /enrollment_status IN \('enrolled', 'pending_payment'\)/);
  assert.match(counts.statement, /intake_status NOT IN \('legacy', 'cancelled', 'dropped', 'transferred'\)/);
  assert.match(counts.statement, /JOIN annual_assessments AS assessment/);
  assert.match(counts.statement, /JOIN annual_registrar_confirmations AS confirmation/);
  assert.match(counts.statement, /v_finance_assessed_charge_due/);
  assert.doesNotMatch(counts.statement, /payment_date/);
});

test('finance overview authorization excludes other active roles before loading finance records', async () => {
  const database = queryPool(() => ({ recordset: [] }));
  const service = createFinanceDashboardService({ getPool: database.getPool, sql: fakeSql() });

  await assert.rejects(service.getOverview(9), (error) => error instanceof FinanceDashboardError && error.status === 403);
  assert.equal(database.calls.length, 1);
  assert.match(database.calls[0].statement, /role IN \('finance', 'database_admin'\)/);
});

test('dashboards ask staff to choose a school year when no configured current term exists', async () => {
  const database = queryPool(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 9 }] };
    if (statement.includes('school_year_term_order AS configured')) return { recordset: terms.map((term) => ({ ...term, is_current: 0 })) };
    throw new Error(`Unexpected query: ${statement}`);
  });
  const registrar = createRegistrarDashboardService({ getPool: database.getPool, sql: fakeSql() });
  const registrarResult = await registrar.getDashboard(9);
  assert.equal(registrarResult.selectedSchoolYear, '');
  assert.equal(registrarResult.selectedTerm, null);
  assert.equal(registrarResult.needsTermSelection, true);
  assert.equal(database.calls.length, 2, 'registrar does not run year-specific counts before year selection');

  const financeDatabase = queryPool(({ statement }) => {
    if (statement.includes('FROM users')) return { recordset: [{ id: 9 }] };
    if (statement.includes('FROM student_document_requests AS request')) return { recordset: [{ document_clearance_count: 0, departure_review_count: 0, saved_review_count: 0 }] };
    if (statement.includes('school_year_term_order AS configured')) return { recordset: terms.map((term) => ({ ...term, is_current: 0 })) };
    throw new Error(`Unexpected query: ${statement}`);
  });
  const finance = createFinanceDashboardService({ getPool: financeDatabase.getPool, sql: fakeSql() });
  const financeResult = await finance.getOverview(9);
  assert.equal(financeResult.selectedSchoolYear, '');
  assert.equal(financeResult.needsSchoolYearSelection, true);
  assert.equal(financeResult.totalEligible, 0);
  assert.ok(financeResult.statusCounts.every((item) => item.count === 0));
  assert.equal(financeDatabase.calls.length, 3, 'finance loads saved-work queues but not year-specific data before selection');
});
