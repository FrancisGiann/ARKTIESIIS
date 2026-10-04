'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ejs = require('ejs');
const express = require('express');
const mysql = require('mysql2/promise');
const os = require('node:os');
const path = require('node:path');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { PoolFacade, sql } = require('../src/config/database');
const { STUDENT_LEDGER_SUMMARY_SQL, createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { createAnnualFinanceCasesService } = require('../src/services/annualFinanceCasesService');
const { createAnnualFinanceReportsService } = require('../src/services/annualFinanceReportsService');
const { createFinanceDashboardService } = require('../src/services/financeDashboardService');
const { createFinanceReviewActionService } = require('../src/services/financeReviewActionService');
const { createFinanceRouter } = require('../src/routes/finance');
const { formatMoney } = require('../src/utils/formatMoney');

const socketPath = process.env.FINANCE_REDESIGN_TEST_SOCKET;
const databaseUser = process.env.FINANCE_REDESIGN_TEST_USER || 'root';
const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
const repoRoot = path.resolve(__dirname, '..');

function safeDatabaseName() {
  return `arktiesiis_finance_redesign_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
}

function moneyCents(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  assert.ok(match, `MariaDB monetary result is not a decimal string (type=${typeof value}, null=${value === null}, undefined=${value === undefined})`);
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  return match[1] === '-' ? -cents : cents;
}

async function executeStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

function responseCapture() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    async render(view, locals) {
      this.view = view;
      this.locals = locals;
      try {
        this.html = await ejs.renderFile(path.join(repoRoot, 'views', `${view}.ejs`), { formatMoney, ...locals });
      } catch (error) {
        this.renderError = error;
        throw error;
      }
      return this;
    }
  };
}

function directGetHandler(router, routePath) {
  const layer = router.stack.find((item) => item.route?.path === routePath && item.route.methods.get);
  assert.ok(layer, `GET ${routePath} must be registered`);
  return layer.route.stack.at(-1).handle;
}

function requestFor(query = {}, params = {}) {
  return {
    method: 'GET', query, params,
    authUser: { id: 1, role: 'finance' },
    sessionID: 'finance-redesign-integration-session',
    session: {}
  };
}

test('Finance status links open real paginated MariaDB rosters and annual account tabs', {
  skip: !socketPath && 'Set FINANCE_REDESIGN_TEST_SOCKET to an isolated MariaDB socket under /tmp.'
}, async () => {
  assert.equal(path.isAbsolute(socketPath), true, 'the test socket must be absolute');
  assert.equal(path.resolve(socketPath).startsWith(temporaryRoot), true, 'the test socket must be under /tmp');

  const databaseName = safeDatabaseName();
  assert.match(databaseName, /^arktiesiis_finance_redesign_\d+_[a-f0-9]{10}$/);
  const adminPool = mysql.createPool({ socketPath, user: databaseUser, password: '', waitForConnections: true, connectionLimit: 2, queueLimit: 0 });
  let appPool;
  let reportReadPool;
  let normalReportPool;
  try {
    await adminPool.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    appPool = mysql.createPool({
      socketPath, user: databaseUser, password: '', database: databaseName,
      waitForConnections: true, connectionLimit: 6, queueLimit: 0,
      supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false
    });
    const setupConnection = await appPool.getConnection();
    try {
      const baseline = readSqlFile(path.join(repoRoot, 'database/mariadb/schema.sql'));
      await executeStatements(setupConnection, baseline);
      const forwardMigrations = readForwardMigrations();
      for (const migration of forwardMigrations.filter(({ version }) => !['v2.013', 'v2.014'].includes(version))) {
        await executeStatements(setupConnection, migration.statements);
        await setupConnection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
      }
    } finally {
      setupConnection.release();
    }

    const [migrationRows] = await appPool.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.equal(migrationRows.at(-1)?.version, 'v2.012', 'the test database includes the new review-draft migration');

    const [actorResult] = await appPool.execute(
      "INSERT INTO users (email, password_hash, role, is_active) VALUES (?, 'integration-only', 'finance', 1)",
      [`finance-${crypto.randomUUID()}@example.test`]
    );
    const actorId = Number(actorResult.insertId);
    const [termResult] = await appPool.execute(
      "INSERT INTO academic_terms (school_year, term, is_current) VALUES ('2026-2027', 'Term 1', 1)"
    );
    const termId = Number(termResult.insertId);
    await appPool.execute(
      'INSERT INTO school_year_term_order (school_year, term_number, academic_term_id, configured_by) VALUES (?, 1, ?, ?)',
      ['2026-2027', termId, actorId]
    );
    const scheduleKey = crypto.randomUUID();
    const [scheduleResult] = await appPool.execute(
      "INSERT INTO finance_schedules (school_year, grade_level, voucher_code, version_no, status, idempotency_key, request_fingerprint, created_by) VALUES ('2026-2027', 'Grade 11', 'PUB', 1, 'active', ?, ?, ?)",
      [scheduleKey, 'a'.repeat(64), actorId]
    );
    const scheduleId = Number(scheduleResult.insertId);
    const scheduleLineIds = new Map();
    for (const installment of ['DP', 'Prelim', 'Midterm', 'Finals']) {
      const [lineResult] = await appPool.execute(
        "INSERT INTO finance_schedule_lines (schedule_id, term_number, fee_category, line_name, installment, amount, is_optional) VALUES (?, 1, 'tuition', 'Tuition', ?, 100.00, 0)",
        [scheduleId, installment]
      );
      scheduleLineIds.set(installment, Number(lineResult.insertId));
    }
    const [studentResult] = await appPool.execute(
      "INSERT INTO students (student_no, lrn, first_name, last_name, status) VALUES ('FIN-REDESIGN-01', '123456789012', 'Ari', 'Sample', 'active')"
    );
    const studentId = Number(studentResult.insertId);
    const [annualResult] = await appPool.execute(
      "INSERT INTO annual_enrollments (student_id, school_year, grade_level, voucher_code, intake_status, created_by, entry_term_number) VALUES (?, '2026-2027', 'Grade 11', 'PUB', 'enrolled', ?, 1)",
      [studentId, actorId]
    );
    const annualId = Number(annualResult.insertId);
    await appPool.execute(
      "INSERT INTO enrollments (student_id, academic_term_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status) VALUES (?, ?, 'enrolled', ?, 1, 'applicable')",
      [studentId, termId, annualId]
    );

    let lrnSequence = 123456789013;
    async function createAssessedStudent(studentNo, firstName, options = {}) {
      const [createdStudent] = await appPool.execute(
        "INSERT INTO students (student_no, lrn, first_name, last_name, status) VALUES (?, ?, ?, 'Sample', 'active')",
        [studentNo, String(lrnSequence++), firstName]
      );
      const createdStudentId = Number(createdStudent.insertId);
      const [createdAnnual] = await appPool.execute(
        "INSERT INTO annual_enrollments (student_id, school_year, grade_level, voucher_code, intake_status, created_by, entry_term_number) VALUES (?, '2026-2027', 'Grade 11', 'PUB', 'enrolled', ?, 1)",
        [createdStudentId, actorId]
      );
      const createdAnnualId = Number(createdAnnual.insertId);
      const [createdEnrollment] = await appPool.execute(
        "INSERT INTO enrollments (student_id, academic_term_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status) VALUES (?, ?, 'enrolled', ?, 1, 'applicable')",
        [createdStudentId, termId, createdAnnualId]
      );
      const enrollmentId = Number(createdEnrollment.insertId);
      const [createdAssessment] = await appPool.execute(
        'INSERT INTO annual_assessments (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by, selection_json, idempotency_key, request_fingerprint) VALUES (?, ?, 1, \'PUB\', ?, \'{\\"optionalLineIds\\":[]}\', ?, ?)',
        [createdAnnualId, scheduleId, actorId, crypto.randomUUID(), 'b'.repeat(64)]
      );
      const assessmentId = Number(createdAssessment.insertId);
      const installments = options.wholeTerm ? ['Term 1'] : ['DP', 'Prelim', 'Midterm', 'Finals'];
      const grossPerLine = options.waived ? '100.00' : '100.00';
      const payableTotal = options.waived ? '0.00' : String(installments.length * 100) + '.00';
      const [createdConfirmation] = await appPool.execute(
        `INSERT INTO annual_registrar_confirmations
          (annual_enrollment_id, student_id, school_year, grade_level, entry_enrollment_id, assessment_id, schedule_id, schedule_version,
           voucher_code_snapshot, payable_total, selection_json, assessment_snapshot_fingerprint, confirmed_by, idempotency_key, request_fingerprint)
          VALUES (?, ?, '2026-2027', 'Grade 11', ?, ?, ?, 1, 'PUB', ?, '{\\"optionalLineIds\\":[]}', ?, ?, ?, ?)`,
        [createdAnnualId, createdStudentId, enrollmentId, assessmentId, scheduleId, payableTotal, 'c'.repeat(64), actorId, crypto.randomUUID(), 'd'.repeat(64)]
      );
      assert.ok(createdConfirmation.insertId);
      const chargeIds = new Map();
      for (const installment of installments) {
        const amount = options.waived ? '0.00' : '100.00';
        const scheduleLineId = options.wholeTerm ? null : scheduleLineIds.get(installment);
        const [charge] = await appPool.execute(
          `INSERT INTO assessed_charges
            (assessment_id, annual_enrollment_id, enrollment_id, schedule_line_id, fee_category, line_name, installment,
             amount, gross_amount, waived_amount)
           VALUES (?, ?, ?, ?, 'tuition', 'Tuition', ?, ?, ?, ?)`,
          [assessmentId, createdAnnualId, enrollmentId, scheduleLineId, installment, amount, grossPerLine, options.waived ? '100.00' : '0.00']
        );
        chargeIds.set(installment, Number(charge.insertId));
      }
      if (options.adjusted) {
        await appPool.execute(
          `INSERT INTO finance_charge_adjustments (charge_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
           VALUES (?, -100.00, 'Approved full installment correction', ?, ?, ?)`,
          [chargeIds.get('DP'), crypto.randomUUID(), 'e'.repeat(64), actorId]
        );
      }
      return { studentId: createdStudentId, annualId: createdAnnualId, enrollmentId, assessmentId, chargeIds };
    }

    async function addAnnualPaymentAllocation(student, installment, amount, { reversed = false, released = false } = {}) {
      const [payment] = await appPool.execute(
        `INSERT INTO finance_payments (student_id, amount, payment_date, reference_no, receipt_issued, idempotency_key,
           request_fingerprint, recorded_by, is_reversed)
         VALUES (?, ?, '2026-10-01', ?, 0, ?, ?, ?, ?)`,
        [student.studentId, amount, `TEST-${student.studentId}`, crypto.randomUUID(), 'f'.repeat(64), actorId, reversed ? 1 : 0]
      );
      const paymentId = Number(payment.insertId);
      const [batch] = await appPool.execute(
        `INSERT INTO finance_allocation_batches (payment_id, student_id, idempotency_key, request_fingerprint, allocated_by)
         VALUES (?, ?, ?, ?, ?)`,
        [paymentId, student.studentId, crypto.randomUUID(), 'a'.repeat(64), actorId]
      );
      const [allocation] = await appPool.execute(
        `INSERT INTO finance_payment_allocations (payment_id, charge_id, amount, allocation_batch_id, allocated_by)
         VALUES (?, ?, ?, ?, ?)`,
        [paymentId, student.chargeIds.get(installment), amount, Number(batch.insertId), actorId]
      );
      if (released) {
        await appPool.execute(
          `INSERT INTO finance_payment_allocation_releases (allocation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
           VALUES (?, ?, 'Test release to account credit', ?, ?, ?)`,
          [Number(allocation.insertId), amount, crypto.randomUUID(), 'b'.repeat(64), actorId]
        );
      }
      return { paymentId, allocationId: Number(allocation.insertId) };
    }

    const assessedScenarios = {
      oldWholeTerm: await createAssessedStudent('FIN-REDESIGN-OLD', 'WholeTerm', { wholeTerm: true }),
      unpaid: await createAssessedStudent('FIN-REDESIGN-UNPAID', 'Unpaid'),
      partial: await createAssessedStudent('FIN-REDESIGN-PARTIAL', 'Partial'),
      full: await createAssessedStudent('FIN-REDESIGN-FULL', 'Full'),
      settled: await createAssessedStudent('FIN-REDESIGN-SETTLED', 'Settled'),
      waived: await createAssessedStudent('FIN-REDESIGN-WAIVED', 'Waived', { waived: true }),
      reversed: await createAssessedStudent('FIN-REDESIGN-REVERSED', 'Reversed'),
      released: await createAssessedStudent('FIN-REDESIGN-RELEASED', 'Released'),
      adjusted: await createAssessedStudent('FIN-REDESIGN-ADJUSTED', 'Adjusted', { adjusted: true }),
      legacyReconciled: await createAssessedStudent('FIN-REDESIGN-LEGACY', 'Legacy')
    };
    await addAnnualPaymentAllocation(assessedScenarios.partial, 'DP', '25.00');
    await addAnnualPaymentAllocation(assessedScenarios.full, 'DP', '100.00');
    for (const installment of ['DP', 'Prelim', 'Midterm', 'Finals']) {
      await addAnnualPaymentAllocation(assessedScenarios.settled, installment, '100.00');
    }
    const reversedPayment = await addAnnualPaymentAllocation(assessedScenarios.reversed, 'DP', '100.00', { reversed: true });
    await addAnnualPaymentAllocation(assessedScenarios.released, 'DP', '100.00', { released: true });
    const legacyScenario = assessedScenarios.legacyReconciled;
    const [legacyAccount] = await appPool.execute('INSERT INTO financial_accounts (student_id, balance) VALUES (?, 0.00)', [legacyScenario.studentId]);
    const [legacyTransaction] = await appPool.execute(
      `INSERT INTO financial_transactions (financial_account_id, transaction_type, amount, reference_no, recorded_by, is_legacy_unattributed)
       VALUES (?, 'payment', 50.00, 'LEGACY-TEST', ?, 1)`,
      [Number(legacyAccount.insertId), actorId]
    );
    const [legacyBatch] = await appPool.execute(
      'INSERT INTO finance_legacy_reconciliation_batches (transaction_id, idempotency_key, request_fingerprint, recorded_by) VALUES (?, ?, ?, ?)',
      [Number(legacyTransaction.insertId), crypto.randomUUID(), 'c'.repeat(64), actorId]
    );
    const [legacyReconciliationInsert] = await appPool.execute(
      `INSERT INTO finance_legacy_reconciliations (transaction_id, charge_id, amount, reason, batch_id, recorded_by)
       VALUES (?, ?, 50.00, 'Matched existing legacy payment', ?, ?)`,
      [Number(legacyTransaction.insertId), legacyScenario.chargeIds.get('DP'), Number(legacyBatch.insertId), actorId]
    );
    await appPool.execute(
      `INSERT INTO finance_charge_adjustments (charge_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
       VALUES (?, -25.00, 'Approved additional credit for due-view verification', ?, ?, ?)`,
      [assessedScenarios.adjusted.chargeIds.get('DP'), crypto.randomUUID(), '9'.repeat(64), actorId]
    );

    const pool = new PoolFacade(appPool);
    const getPool = async () => pool;
    const annual = createAnnualFinanceService({ getPool, sql });
    const cases = createAnnualFinanceCasesService({ getPool, sql });
    const dashboard = createFinanceDashboardService({ getPool, sql });
    reportReadPool = mysql.createPool({
      socketPath, user: databaseUser, password: '', database: databaseName,
      waitForConnections: true, connectionLimit: 1, queueLimit: 0,
      supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false
    });
    const strictReportSource = {
      async getConnection() {
        const connection = await reportReadPool.getConnection();
        await connection.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',ONLY_FULL_GROUP_BY')");
        return connection;
      }
    };
    const reportPool = new PoolFacade(strictReportSource);
    const financeReports = createAnnualFinanceReportsService({ getPool: async () => reportPool, sql });
    const strictAnnual = createAnnualFinanceService({ getPool: async () => reportPool, sql });
    normalReportPool = mysql.createPool({
      socketPath, user: databaseUser, password: '', database: databaseName,
      waitForConnections: true, connectionLimit: 1, queueLimit: 0,
      supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false
    });
    const normalFinanceReports = createAnnualFinanceReportsService({
      getPool: async () => new PoolFacade(normalReportPool), sql
    });

    const [baselineDueRows] = await appPool.execute(`SELECT charge.id AS charge_id, charge.annual_enrollment_id,
        charge.enrollment_id, CAST(due.amount_due AS CHAR(40)) AS amount_due,
        CAST(due.annual_allocated AS CHAR(40)) AS annual_allocated,
        CAST(due.legacy_allocated AS CHAR(40)) AS legacy_allocated
      FROM assessed_charges AS charge INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
      ORDER BY charge.id`);
    const negativeDue = baselineDueRows.find(({ charge_id }) => Number(charge_id) === assessedScenarios.adjusted.chargeIds.get('DP'));
    assert.equal(negativeDue?.amount_due, '-25.00', 'the authoritative view retains signed net-credit dues');
    assert.equal(negativeDue?.annual_allocated, '0.00');
    assert.equal(negativeDue?.legacy_allocated, '0.00');
    const baselineLedger = await strictAnnual.getStudentLedger(actorId, assessedScenarios.partial.studentId);
    const dueViewMigration = readForwardMigrations().find(({ version }) => version === 'v2.013');
    assert.ok(dueViewMigration, 'the forward due-view migration is available');
    const migrationConnection = await appPool.getConnection();
    try {
      await executeStatements(migrationConnection, dueViewMigration.statements);
      await migrationConnection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [dueViewMigration.version]);
    } finally {
      migrationConnection.release();
    }
    const [migratedVersions] = await appPool.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.equal(migratedVersions.at(-1)?.version, 'v2.013');
    const [migratedDueRows] = await appPool.execute(`SELECT charge.id AS charge_id, charge.annual_enrollment_id,
        charge.enrollment_id, CAST(due.amount_due AS CHAR(40)) AS amount_due,
        CAST(due.annual_allocated AS CHAR(40)) AS annual_allocated,
        CAST(due.legacy_allocated AS CHAR(40)) AS legacy_allocated
      FROM assessed_charges AS charge INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
      ORDER BY charge.id`);
    assert.deepEqual(migratedDueRows, baselineDueRows,
      'migration 013 preserves each charge, annual allocation, and legacy reconciliation balance');
    const reportRange = { fromDate: '2026-10-01', toDate: '2026-10-01' };
    const collectionsReport = await financeReports.reports(actorId, { ...reportRange, view: 'collections' });
    const [expectedCollections] = await appPool.execute(`SELECT COUNT(DISTINCT payment.student_id) AS distinct_payers,
      COUNT(*) AS payment_count, CAST(COALESCE(SUM(payment.amount), 0) AS CHAR(40)) AS amount
      FROM finance_payments AS payment WHERE payment.is_reversed = 0
        AND payment.payment_date >= ? AND payment.payment_date < DATE_ADD(?, INTERVAL 1 DAY)`, [reportRange.fromDate, reportRange.toDate]);
    assert.equal(String(collectionsReport.collectionSummary.distinct_payers), String(expectedCollections[0].distinct_payers));
    assert.equal(String(collectionsReport.collectionSummary.payment_count), String(expectedCollections[0].payment_count));
    assert.equal(collectionsReport.collectionSummary.valid_collection_amount, String(expectedCollections[0].amount));

    const allocationsReport = await financeReports.reports(actorId, { ...reportRange, view: 'allocations' });
    const [expectedAllocations] = await appPool.execute(`SELECT COUNT(DISTINCT payment.student_id) AS distinct_payers,
      CAST(COALESCE(SUM(allocation.net_amount), 0) AS CHAR(40)) AS amount
      FROM v_finance_net_payment_allocations AS allocation
      INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id AND payment.is_reversed = 0
      WHERE payment.payment_date >= ? AND payment.payment_date < DATE_ADD(?, INTERVAL 1 DAY)`, [reportRange.fromDate, reportRange.toDate]);
    assert.equal(String(allocationsReport.allocationSummary.distinct_payers), String(expectedAllocations[0].distinct_payers));
    assert.equal(allocationsReport.allocationSummary.target_allocated_amount, String(expectedAllocations[0].amount));
    const emptyOpeningContext = allocationsReport.allocationContexts.filter((row) => row.allocated_amount === null);
    assert.equal(emptyOpeningContext.length, 1, 'the ungrouped opening-liability aggregate returns one empty zero-count row');
    assert.ok(emptyOpeningContext.every((row) => row.target_type === 'opening liability' && Number(row.distinct_payers) === 0),
      'the union’s empty opening-liability aggregate represents zero context and contributes no amount');
    const assessedContexts = allocationsReport.allocationContexts.filter((row) => row.target_type === 'assessed charge');
    assert.equal(assessedContexts.length, 1);
    assert.equal(Number(assessedContexts[0].distinct_payers), 4,
      'four students with non-reversed charge allocations are counted once despite seven payment rows');
    assert.equal(moneyCents(assessedContexts[0].allocated_amount), 52500n,
      'released allocations contribute zero net amount while reversed payments stay excluded');
    const contextAllocationCents = allocationsReport.allocationContexts
      .reduce((sum, row) => sum + (row.allocated_amount === null ? 0n : moneyCents(row.allocated_amount)), 0n);
    assert.equal(contextAllocationCents, moneyCents(expectedAllocations[0].amount),
      'academic-context groups reconcile exactly to the range total without floating-point money arithmetic');

    const correctionsReport = await financeReports.reports(actorId, { ...reportRange, view: 'corrections' });
    assert.ok(Array.isArray(correctionsReport.reversals));
    const termProgressReport = await financeReports.reports(actorId, { ...reportRange, view: 'term-balances' });
    assert.ok(termProgressReport.termProgress.length > 0);
    assert.ok(termProgressReport.termProgress.every((row) => Object.hasOwn(row, 'section_id')));
    const termProgressGroup = termProgressReport.termProgress.find((row) => row.school_year === '2026-2027');
    assert.ok(termProgressGroup);
    assert.equal(Number(termProgressGroup.applicable_enrollments), 11);
    assert.equal(Number(termProgressGroup.enrolled_students), 11);
    assert.equal(Number(termProgressGroup.paid_or_waived_students), 3);
    assert.equal(Number(termProgressGroup.waived_students), 1);
    assert.equal(moneyCents(termProgressGroup.outstanding_amount), 260000n,
      'term progress retains due totals across whole-term, per-installment, reversed, released, adjusted, and reconciled charges');
    assert.equal(moneyCents(termProgressGroup.waived_amount), 40000n);
    const legacyCombinedReport = await financeReports.reports(actorId, reportRange);
    assert.equal(legacyCombinedReport.collectionSummary.valid_collection_amount, collectionsReport.collectionSummary.valid_collection_amount);
    assert.equal(legacyCombinedReport.allocationSummary.target_allocated_amount, allocationsReport.allocationSummary.target_allocated_amount);
    assert.equal(legacyCombinedReport.termProgress.length, termProgressReport.termProgress.length);
    const repeatedCombinedReport = await financeReports.reports(actorId, reportRange);
    assert.deepEqual(repeatedCombinedReport.termProgress, legacyCombinedReport.termProgress,
      'repeated mixed-view reads on the same strict pooled connection retain term totals');
    const normalCombinedReport = await normalFinanceReports.reports(actorId, reportRange);
    assert.deepEqual(normalCombinedReport.termProgress, legacyCombinedReport.termProgress,
      'normal-mode and strict-mode default-all reports retain identical term totals');
    for (const kind of ['collections', 'allocations', 'corrections']) {
      const detail = await financeReports.reportDetails(actorId, { ...reportRange, kind, page: '1' });
      assert.equal(detail.pagination.page, 1);
    }

    const [openingStudentInsert] = await appPool.execute(
      "INSERT INTO students (student_no, lrn, first_name, last_name, status) VALUES ('FIN-REDESIGN-OPENING', ?, 'Opening', 'Account', 'active')",
      [String(lrnSequence++)]
    );
    const openingStudentId = Number(openingStudentInsert.insertId);
    await appPool.execute('INSERT INTO financial_accounts (student_id, balance) VALUES (?, 30.00)', [openingStudentId]);
    const openingTransfer = await annual.transferLegacyOpeningLiability(actorId, openingStudentId, {
      expectedAmount: '30.00', sourceLabel: 'Integration fixture', reason: 'Read-only report coverage.',
      idempotencyKey: crypto.randomUUID()
    });
    const [openingPaymentInsert] = await appPool.execute(`INSERT INTO finance_payments
        (student_id, amount, payment_date, reference_no, receipt_issued, idempotency_key, request_fingerprint, recorded_by, is_reversed)
      VALUES (?, 12.00, '2026-10-01', 'OPENING-REPORT-TEST', 0, ?, ?, ?, 0)`,
    [openingStudentId, crypto.randomUUID(), '1'.repeat(64), actorId]);
    const openingPaymentId = Number(openingPaymentInsert.insertId);
    const [openingBatchInsert] = await appPool.execute(`INSERT INTO finance_allocation_batches
        (payment_id, student_id, idempotency_key, request_fingerprint, allocated_by)
      VALUES (?, ?, ?, ?, ?)`, [openingPaymentId, openingStudentId, crypto.randomUUID(), '2'.repeat(64), actorId]);
    await appPool.execute(`INSERT INTO finance_payment_allocations
        (payment_id, charge_id, legacy_opening_charge_id, amount, allocation_batch_id, allocated_by)
      VALUES (?, NULL, ?, 12.00, ?, ?)`, [openingPaymentId, openingTransfer.openingLiabilityId, Number(openingBatchInsert.insertId), actorId]);
    const [openingAllocationIdRows] = await appPool.execute(
      'SELECT id FROM finance_payment_allocations WHERE payment_id = ? AND legacy_opening_charge_id = ?',
      [openingPaymentId, openingTransfer.openingLiabilityId]
    );
    const openingAllocationId = Number(openingAllocationIdRows[0].id);
    await appPool.execute(`INSERT INTO finance_payment_allocation_releases
        (allocation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
      VALUES (?, 2.00, 'Test partial opening allocation release', ?, ?, ?)`,
    [openingAllocationId, crypto.randomUUID(), '3'.repeat(64), actorId]);
    const [reversedOpeningPaymentInsert] = await appPool.execute(`INSERT INTO finance_payments
        (student_id, amount, payment_date, reference_no, receipt_issued, idempotency_key, request_fingerprint, recorded_by, is_reversed)
      VALUES (?, 5.00, '2026-10-01', 'OPENING-REVERSED-TEST', 0, ?, ?, ?, 1)`,
    [openingStudentId, crypto.randomUUID(), '4'.repeat(64), actorId]);
    const reversedOpeningPaymentId = Number(reversedOpeningPaymentInsert.insertId);
    const [reversedOpeningBatchInsert] = await appPool.execute(`INSERT INTO finance_allocation_batches
        (payment_id, student_id, idempotency_key, request_fingerprint, allocated_by)
      VALUES (?, ?, ?, ?, ?)`, [reversedOpeningPaymentId, openingStudentId, crypto.randomUUID(), '5'.repeat(64), actorId]);
    await appPool.execute(`INSERT INTO finance_payment_allocations
        (payment_id, charge_id, legacy_opening_charge_id, amount, allocation_batch_id, allocated_by)
      VALUES (?, NULL, ?, 5.00, ?, ?)`, [reversedOpeningPaymentId, openingTransfer.openingLiabilityId, Number(reversedOpeningBatchInsert.insertId), actorId]);
    const [openingFinalPaymentInsert] = await appPool.execute(`INSERT INTO finance_payments
        (student_id, amount, payment_date, reference_no, receipt_issued, idempotency_key, request_fingerprint, recorded_by, is_reversed)
      VALUES (?, 20.00, '2026-10-01', 'OPENING-FINAL-TEST', 0, ?, ?, ?, 0)`,
    [openingStudentId, crypto.randomUUID(), '6'.repeat(64), actorId]);
    const openingFinalPaymentId = Number(openingFinalPaymentInsert.insertId);
    const [openingFinalBatchInsert] = await appPool.execute(`INSERT INTO finance_allocation_batches
        (payment_id, student_id, idempotency_key, request_fingerprint, allocated_by)
      VALUES (?, ?, ?, ?, ?)`, [openingFinalPaymentId, openingStudentId, crypto.randomUUID(), '7'.repeat(64), actorId]);
    await appPool.execute(`INSERT INTO finance_payment_allocations
        (payment_id, charge_id, legacy_opening_charge_id, amount, allocation_batch_id, allocated_by)
      VALUES (?, NULL, ?, 20.00, ?, ?)`, [openingFinalPaymentId, openingTransfer.openingLiabilityId, Number(openingFinalBatchInsert.insertId), actorId]);
    const [openingBefore014] = await appPool.execute(`SELECT CAST(amount_due AS CHAR(40)) AS amount_due,
        CAST(allocated AS CHAR(40)) AS allocated FROM v_finance_opening_liability_due WHERE opening_charge_id = ?`,
    [openingTransfer.openingLiabilityId]);
    assert.deepEqual(openingBefore014[0], { amount_due: '0.00', allocated: '30.00' },
      'opening balances net partial releases, ignore reversed payments, and preserve a zero residual');
    const populatedOpeningReport = await financeReports.reports(actorId, { ...reportRange, view: 'allocations' });
    const openingContext = populatedOpeningReport.allocationContexts.find((row) => row.target_type === 'opening liability');
    assert.equal(Number(openingContext?.distinct_payers), 1);
    assert.equal(moneyCents(openingContext?.allocated_amount), 3000n);
    assert.equal(moneyCents(populatedOpeningReport.allocationSummary.target_allocated_amount), 55500n);
    const populatedCombinedReport = await financeReports.reports(actorId, reportRange);
    assert.equal(populatedCombinedReport.allocationSummary.target_allocated_amount, populatedOpeningReport.allocationSummary.target_allocated_amount);

    const [secondLegacyTransaction] = await appPool.execute(
      `INSERT INTO financial_transactions (financial_account_id, transaction_type, amount, reference_no, recorded_by, is_legacy_unattributed)
       VALUES (?, 'payment', 30.00, 'LEGACY-TEST-SECOND', ?, 1)`,
      [Number(legacyAccount.insertId), actorId]
    );
    const [secondLegacyBatch] = await appPool.execute(
      'INSERT INTO finance_legacy_reconciliation_batches (transaction_id, idempotency_key, request_fingerprint, recorded_by) VALUES (?, ?, ?, ?)',
      [Number(secondLegacyTransaction.insertId), crypto.randomUUID(), '8'.repeat(64), actorId]
    );
    const [secondLegacyReconciliation] = await appPool.execute(
      `INSERT INTO finance_legacy_reconciliations (transaction_id, charge_id, amount, reason, batch_id, recorded_by)
       VALUES (?, ?, 30.00, 'Second legacy reconciliation regression fixture', ?, ?)`,
      [Number(secondLegacyTransaction.insertId), legacyScenario.chargeIds.get('DP'), Number(secondLegacyBatch.insertId), actorId]
    );
    await appPool.execute(
      `INSERT INTO finance_legacy_reconciliation_releases
         (reconciliation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
       VALUES (?, 10.00, 'Test partial reconciliation release', ?, ?, ?)`,
      [Number(secondLegacyReconciliation.insertId), crypto.randomUUID(), '9'.repeat(64), actorId]
    );
    await appPool.execute(
      `INSERT INTO finance_legacy_opening_charges
         (financial_account_id, student_id, amount, source_label, reason, idempotency_key, request_fingerprint, recorded_by)
       VALUES (?, ?, 80.00, 'Integration fixture', 'Signed legacy-balance regression fixture.', ?, ?, ?)`,
      [Number(legacyAccount.insertId), legacyScenario.studentId, crypto.randomUUID(), 'a'.repeat(64), actorId]
    );
    const legacyBalanceStudentId = legacyScenario.studentId;

    const legacyBalanceViewSql = `SELECT balance.financial_account_id, balance.student_id,
        CAST(balance.remaining_legacy_balance AS CHAR(40)) AS remaining_legacy_balance
      FROM v_finance_legacy_account_balance AS balance ORDER BY balance.financial_account_id`;
    const openingDueViewSql = `SELECT due.opening_charge_id, due.student_id,
        CAST(due.amount_due AS CHAR(40)) AS amount_due, CAST(due.allocated AS CHAR(40)) AS allocated
      FROM v_finance_opening_liability_due AS due ORDER BY due.opening_charge_id`;
    const [legacyBalancesBefore014] = await appPool.query(legacyBalanceViewSql);
    const [openingDuesBefore014] = await appPool.query(openingDueViewSql);
    let unchangedLedgerBefore014 = null;
    let ledgerBefore014ErrorCode = null;
    try {
      unchangedLedgerBefore014 = await strictAnnual.getStudentLedger(actorId, legacyScenario.studentId);
    } catch (error) {
      ledgerBefore014ErrorCode = String(error?.code || '');
      assert.ok(['ER_INVALID_GROUP_FUNC_USE', 'ER_MIX_OF_GROUP_FUNC_AND_FIELDS'].includes(ledgerBefore014ErrorCode),
        'a pre-migration grouped-view failure is limited to MariaDB aggregate errors 1111 or 1140');
    }
    const legacyBalanceMigration = readForwardMigrations().find(({ version }) => version === 'v2.014');
    assert.ok(legacyBalanceMigration, 'the forward legacy-balance migration is available');
    const migration014Connection = await appPool.getConnection();
    try {
      await executeStatements(migration014Connection, legacyBalanceMigration.statements);
      await migration014Connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [legacyBalanceMigration.version]);
    } finally {
      migration014Connection.release();
    }
    const [migratedVersions014] = await appPool.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.equal(migratedVersions014.at(-1)?.version, 'v2.014');
    await reportReadPool.end();
    reportReadPool = mysql.createPool({
      socketPath, user: databaseUser, password: '', database: databaseName,
      waitForConnections: true, connectionLimit: 1, queueLimit: 0,
      supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false
    });
    const [legacyBalancesAfter014] = await appPool.query(legacyBalanceViewSql);
    const [openingDuesAfter014] = await appPool.query(openingDueViewSql);
    const [balanceViewMetadata] = await appPool.execute(`SELECT table_name, algorithm FROM information_schema.views
      WHERE table_schema = DATABASE() AND table_name IN ('v_finance_legacy_account_balance', 'v_finance_opening_liability_due')
      ORDER BY table_name`);
    assert.deepEqual(balanceViewMetadata.map(({ algorithm }) => String(algorithm)), ['TEMPTABLE', 'TEMPTABLE']);
    assert.deepEqual(legacyBalancesAfter014, legacyBalancesBefore014,
      'migration 014 preserves every signed legacy-account balance after grouping reconciliations and opening charges');
    assert.deepEqual(openingDuesAfter014, openingDuesBefore014,
      'migration 014 preserves every opening-liability due and allocation total after grouping net allocations');
    assert.equal(legacyBalancesAfter014.find(({ student_id: id }) => Number(id) === legacyBalanceStudentId)?.remaining_legacy_balance, '-10.00');
    assert.equal(legacyBalancesAfter014.find(({ student_id: id }) => Number(id) === openingStudentId)?.remaining_legacy_balance, '0.00');
    const summaryComponentQueries = [
      ['legacy balance', `SELECT CAST(COALESCE(SUM(remaining_legacy_balance), 0) AS CHAR(40)) AS value
        FROM v_finance_legacy_account_balance WHERE student_id = ?`],
      ['opening liability', `SELECT SUM(amount_due) AS value FROM v_finance_opening_liability_due WHERE student_id = ?`],
      ['annual payments', `SELECT SUM(allocation.net_amount) AS value FROM v_finance_net_payment_allocations AS allocation
        INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
        WHERE payment.student_id = ? AND payment.is_reversed = 0 AND allocation.charge_id IS NOT NULL`],
      ['legacy reconciliations', `SELECT SUM(reconciliation.net_amount) AS value FROM v_finance_net_legacy_reconciliations AS reconciliation
        INNER JOIN financial_transactions AS legacy ON legacy.id = reconciliation.transaction_id
        INNER JOIN financial_accounts AS legacy_account ON legacy_account.id = legacy.financial_account_id
        WHERE legacy_account.student_id = ?`],
      ['payment credit', `SELECT SUM(available_credit) AS value FROM v_finance_payment_credit WHERE student_id = ? AND is_reversed = 0`]
    ];
    for (let repeat = 0; repeat < 3; repeat += 1) {
      for (const [componentName, componentSql] of summaryComponentQueries) {
        try {
          const [preparedRows] = await reportReadPool.execute(componentSql, [legacyBalanceStudentId]);
          const [textRows] = await reportReadPool.query(componentSql, [legacyBalanceStudentId]);
          assert.deepEqual(preparedRows, textRows, `prepared and text ${componentName} reads match`);
          if (componentName === 'legacy balance') assert.equal(preparedRows[0]?.value, '-10.00');
        } catch (error) {
          if (error?.code) assert.fail(`Post-migration ${componentName} summary read failed with ${String(error.code)}.`);
          throw error;
        }
      }
    }
    const positionalSummarySql = STUDENT_LEDGER_SUMMARY_SQL.replaceAll('@studentId', '?');
    const summaryBindingsFor = (studentId) => Array((positionalSummarySql.match(/\?/g) || []).length).fill(studentId);
    for (const studentIdForProtocol of [legacyBalanceStudentId, openingStudentId, legacyBalanceStudentId, openingStudentId,
      legacyBalanceStudentId, openingStudentId]) {
      const summaryBindings = summaryBindingsFor(studentIdForProtocol);
      const [preparedSummary] = await reportReadPool.execute(positionalSummarySql, summaryBindings);
      const [textSummary] = await reportReadPool.query(positionalSummarySql, summaryBindings);
      assert.deepEqual(preparedSummary, textSummary,
        'the exact grouped ledger-summary statement returns the same totals through prepared and text protocols');
    }
    const unchangedLedgerAfter014 = await strictAnnual.getStudentLedger(actorId, legacyScenario.studentId);
    if (unchangedLedgerBefore014) {
      assert.deepEqual(unchangedLedgerAfter014, unchangedLedgerBefore014,
        'migration 014 preserves the complete annual ledger for unchanged student and finance rows');
    }
    const migratedLedger = await strictAnnual.getStudentLedger(actorId, assessedScenarios.partial.studentId);
    assert.deepEqual(migratedLedger, baselineLedger,
      'migrations 013-014 preserve the complete annual ledger under strict grouping');
    assert.equal(migratedLedger.charges.length, 4);
    assert.equal(migratedLedger.charges[0].allocated, '25.00');
    assert.equal(migratedLedger.charges[0].remaining_due, '75.00');

    const alternatingStudentIds = [legacyBalanceStudentId, assessedScenarios.partial.studentId, openingStudentId,
      assessedScenarios.partial.studentId, legacyBalanceStudentId, assessedScenarios.partial.studentId,
      openingStudentId, assessedScenarios.partial.studentId];
    for (const studentIdForLedger of alternatingStudentIds) {
      const ledger = await strictAnnual.getStudentLedger(actorId, studentIdForLedger);
      if (studentIdForLedger === legacyBalanceStudentId) {
        assert.equal(ledger.summary.unattributedLegacyBalance, '-10.00');
        assert.equal(ledger.summary.openingLiabilityDue, '80.00');
      } else if (studentIdForLedger === assessedScenarios.partial.studentId) {
        assert.deepEqual(ledger, baselineLedger,
          'alternating prepared full-ledger reads preserve the populated annual ledger exactly');
      } else {
        assert.equal(ledger.summary.unattributedLegacyBalance, '0.00');
        assert.equal(ledger.summary.openingLiabilityDue, '0.00');
      }
    }

    const reversedConfirmation = await annual.getAnnualPaymentConfirmation(actorId, assessedScenarios.reversed.studentId, reversedPayment.paymentId);
    assert.equal(String(reversedConfirmation.allocations[0]?.original_amount), '100.00');
    assert.equal(String(reversedConfirmation.allocations[0]?.current_net_amount), '0.00', 'reversed payments retain original allocations and show zero currently applied');
    const legacyConfirmation = await annual.getLegacyPaymentConfirmation(actorId, legacyScenario.studentId, Number(legacyTransaction.insertId));
    assert.equal(Object.hasOwn(legacyConfirmation.payment, 'description'), false, 'legacy confirmation projection excludes private staff descriptions');
    const router = createFinanceRouter({
      getPool, sql, annualFinanceService: annual, financeCasesService: cases,
      financeDashboardService: dashboard, sessionSecret: 'finance-redesign-integration-secret-32-bytes'
    });

    const expectedStatuses = {
      'FIN-REDESIGN-OLD': { whole: 'unpaid', dp: 'needs_review' },
      'FIN-REDESIGN-UNPAID': { whole: 'unpaid', dp: 'unpaid' },
      'FIN-REDESIGN-PARTIAL': { whole: 'partially_paid', dp: 'partially_paid' },
      'FIN-REDESIGN-FULL': { whole: 'partially_paid', dp: 'fully_paid' },
      'FIN-REDESIGN-SETTLED': { whole: 'fully_paid', dp: 'fully_paid', prelim: 'fully_paid', midterm: 'fully_paid', finals: 'fully_paid' },
      'FIN-REDESIGN-WAIVED': { whole: 'no_payment_required', dp: 'no_payment_required', prelim: 'no_payment_required', midterm: 'no_payment_required', finals: 'no_payment_required' },
      'FIN-REDESIGN-REVERSED': { whole: 'unpaid', dp: 'unpaid' },
      'FIN-REDESIGN-RELEASED': { whole: 'unpaid', dp: 'unpaid' },
      'FIN-REDESIGN-ADJUSTED': { whole: 'unpaid', dp: 'no_payment_required' },
      'FIN-REDESIGN-LEGACY': { whole: 'partially_paid', dp: 'partially_paid' },
      'FIN-REDESIGN-01': { whole: 'needs_review', dp: 'needs_review' }
    };
    for (const installment of ['whole', 'dp', 'prelim', 'midterm', 'finals']) {
      const filters = { schoolYear: '2026-2027', termId: String(termId), installment };
      const overview = await dashboard.getOverview(actorId, filters);
      const roster = await annual.listRosterPage(actorId, filters);
      assert.equal(roster.pagination.totalRecords, overview.totalEligible,
        `${installment} dashboard and unfiltered roster use the same eligible student set`);
      for (const item of overview.statusCounts) {
        const filtered = await annual.listRosterPage(actorId, { ...filters, financeStatus: item.status });
        assert.equal(filtered.pagination.totalRecords, item.count,
          `${installment} ${item.status} dashboard count matches paginated drilldown`);
      }
      for (const [studentNo, modes] of Object.entries(expectedStatuses)) {
        const row = roster.rows.find((candidate) => candidate.student_no === studentNo);
        assert.ok(row, `${studentNo} appears in ${installment} tracking`);
        const expected = modes[installment] || (studentNo === 'FIN-REDESIGN-01' || studentNo === 'FIN-REDESIGN-OLD' ? 'needs_review' : 'unpaid');
        assert.equal(row.placements[0]?.finance_status, expected, `${studentNo} ${installment} classification`);
      }
    }

    const expectedRosterBalances = [
      ['FIN-REDESIGN-PARTIAL', '375.00', 'partially_paid'],
      ['FIN-REDESIGN-FULL', '300.00', 'partially_paid'],
      ['FIN-REDESIGN-SETTLED', '0.00', 'fully_paid'],
      ['FIN-REDESIGN-WAIVED', '0.00', 'no_payment_required'],
      ['FIN-REDESIGN-REVERSED', '400.00', 'unpaid'],
      ['FIN-REDESIGN-RELEASED', '400.00', 'unpaid'],
      ['FIN-REDESIGN-ADJUSTED', '275.00', 'unpaid'],
      ['FIN-REDESIGN-LEGACY', '330.00', 'partially_paid'],
      ['FIN-REDESIGN-01', '0.00', 'needs_review']
    ];
    for (const [studentNo, expectedBalance, expectedStatus] of expectedRosterBalances) {
      const roster = await annual.listRosterPage(actorId, { schoolYear: '2026-2027', search: studentNo });
      const row = roster.rows.find((candidate) => candidate.student_no === studentNo);
      assert.ok(row, `${studentNo} appears in the default roster page`);
      assert.equal(row.annual_balance, expectedBalance, `${studentNo} assessed charges retain authoritative due semantics`);
      assert.equal(row.placements[0]?.current_term_due, expectedBalance, `${studentNo} term due remains scoped to its only placement`);
      assert.equal(row.placements[0]?.finance_status, expectedStatus, `${studentNo} classification remains shared with the dashboard`);
    }
    const legacyRoster = await annual.listRosterPage(actorId, { schoolYear: '2026-2027', search: 'FIN-REDESIGN-LEGACY' });
    assert.equal(legacyRoster.rows[0]?.unattributed_legacy_balance, '-10.00', 'legacy account view retains signed account balance after opening-liability subtraction');
    const statusFilteredRoster = await annual.listRosterPage(actorId, {
      schoolYear: '2026-2027', search: 'FIN-REDESIGN-FULL', financeStatus: 'partially_paid'
    });
    assert.equal(statusFilteredRoster.rows[0]?.annual_balance, null, 'status-filtered rosters continue to omit financial balances');
    assert.equal(statusFilteredRoster.rows[0]?.placements[0]?.current_term_due, null);

    const defaultOverview = await dashboard.getOverview(actorId, {});
    assert.equal(defaultOverview.selectedTermId, String(termId));
    const overviewResponse = responseCapture();
    await directGetHandler(router, '/overview')(requestFor(), overviewResponse);
    assert.equal(overviewResponse.statusCode, 200, overviewResponse.renderError?.stack || overviewResponse.html);
    assert.equal(overviewResponse.view, 'finance/overview');
    assert.match(overviewResponse.html, /Ari|Needs review/);
    const reviewLink = [...overviewResponse.html.matchAll(/href="(\/finance\?[^\"]*financeStatus=needs_review[^\"]*)"/g)]
      .map((match) => match[1].replaceAll('&amp;', '&'))[0];
    assert.ok(reviewLink, 'the needs-review card links to a roster with current term filters');
    const statusQuery = Object.fromEntries(new URLSearchParams(reviewLink.split('?')[1]));
    assert.equal(statusQuery.schoolYear, '2026-2027');
    assert.equal(statusQuery.termId, String(termId));
    assert.equal(statusQuery.financeStatus, 'needs_review');

    let accountUrlForWhole = '';
    for (const installment of ['whole', 'dp', 'prelim', 'midterm', 'finals']) {
      const rosterResponse = responseCapture();
      const query = { ...statusQuery, installment };
      await directGetHandler(router, '/')(requestFor(query), rosterResponse);
      assert.equal(rosterResponse.statusCode, 200, `${installment} roster status link renders`);
      assert.equal(rosterResponse.view, 'finance/annual-roster');
      assert.match(rosterResponse.html, /Ari Sample/);
      assert.match(rosterResponse.html, /Needs registrar confirmation/);
      const accountUrl = [...rosterResponse.html.matchAll(/href="(\/finance\/students\/\d+\/annual\?[^\"]*)"/g)]
        .map((match) => match[1].replaceAll('&amp;', '&'))[0];
      assert.ok(accountUrl, `${installment} roster renders a contextual annual-account link`);
      if (installment === 'whole') accountUrlForWhole = accountUrl;
    }
    const accountResponse = responseCapture();
    const [accountPath, accountQuery] = accountUrlForWhole.split('?');
    const accountId = /\/students\/(\d+)\/annual$/.exec(accountPath)?.[1];
    assert.equal(accountId, String(studentId));
    await directGetHandler(router, '/students/:id/annual')(
      requestFor(Object.fromEntries(new URLSearchParams(accountQuery)), { id: accountId }), accountResponse
    );
    assert.equal(accountResponse.statusCode, 200, `annual account destination renders (${accountResponse.view || 'no view'}): ${String(accountResponse.html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 260)}`);
    assert.equal(accountResponse.view, 'finance/annual-student');
    assert.match(accountResponse.html, /Annual student account/);
    assert.match(accountResponse.html, /backInstallment=whole/);
    for (const view of ['overview', 'payments', 'charges', 'clearance', 'history']) {
      const tabResponse = responseCapture();
      await directGetHandler(router, '/students/:id/annual')(
        requestFor({ view }, { id: String(legacyScenario.studentId) }), tabResponse
      );
      assert.equal(tabResponse.statusCode, 200, `${view} tab reload renders from the grouped Finance views`);
      assert.equal(tabResponse.view, 'finance/annual-student');
      assert.equal(tabResponse.locals.accountView, view);
    }

    const reviewActions = createFinanceReviewActionService({ getPool, sql });
    const sessionBinding = crypto.createHash('sha256').update('finance-redesign-draft-test-session').digest('hex');
    const paymentStudentId = assessedScenarios.unpaid.studentId;
    async function startPaymentDraft(studentId, amount = '25.00') {
      const draft = await reviewActions.startDraft(actorId, sessionBinding,
        `/students/${studentId}/annual/payments`, { _csrf: 'transport-only', amount, paymentDate: '2026-10-04' });
      return reviewActions.freshReview(actorId, sessionBinding, draft.id);
    }
    async function writerCounts(studentId) {
      const [payments] = await appPool.execute('SELECT COUNT(*) AS count FROM finance_payments WHERE student_id = ?', [studentId]);
      const [allocations] = await appPool.execute(`SELECT COUNT(*) AS count FROM finance_payment_allocations AS allocation
        INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id WHERE payment.student_id = ?`, [studentId]);
      const [audits] = await appPool.execute("SELECT COUNT(*) AS count FROM audit_logs WHERE user_id = ? AND action = 'payment_recorded'", [actorId]);
      return { payments: Number(payments[0].count), allocations: Number(allocations[0].count), audits: Number(audits[0].count) };
    }
    async function withDraftCommitFailure(draftId, callback) {
      await appPool.query(`CREATE TRIGGER finance_review_rollback_test BEFORE UPDATE ON finance_review_drafts
        FOR EACH ROW BEGIN IF NEW.id = '${draftId}' AND NEW.status = 'committed' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'isolated rollback verification';
        END IF; END`);
      try { await callback(); }
      finally { await appPool.query('DROP TRIGGER finance_review_rollback_test'); }
    }

    const rollbackPaymentDraft = await startPaymentDraft(paymentStudentId, '25.00');
    const [expiryWindow] = await appPool.execute('SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), review_expires_at) AS seconds_remaining FROM finance_review_drafts WHERE id = ?', [rollbackPaymentDraft.id]);
    assert.ok(Number(expiryWindow[0].seconds_remaining) >= 1190 && Number(expiryWindow[0].seconds_remaining) <= 1200,
      'review expiry uses a database-clock twenty-minute window');
    const paymentStateBeforeRollback = await writerCounts(paymentStudentId);
    await withDraftCommitFailure(rollbackPaymentDraft.id, async () => {
      await assert.rejects(reviewActions.commit(actorId, sessionBinding, rollbackPaymentDraft.id,
        rollbackPaymentDraft.revision, rollbackPaymentDraft.dependencyFingerprint));
    });
    assert.deepEqual(await writerCounts(paymentStudentId), paymentStateBeforeRollback,
      'payment, allocations, and audit roll back with the review completion update');
    assert.equal((await reviewActions.getDraft(actorId, rollbackPaymentDraft.id)).status, 'pending');
    const savedPayment = await reviewActions.commit(actorId, sessionBinding, rollbackPaymentDraft.id,
      rollbackPaymentDraft.revision, rollbackPaymentDraft.dependencyFingerprint);
    assert.equal(savedPayment.committed, true);
    const committedPaymentState = await writerCounts(paymentStudentId);
    const replayedPayment = await Promise.all([
      reviewActions.commit(actorId, sessionBinding, rollbackPaymentDraft.id, rollbackPaymentDraft.revision, rollbackPaymentDraft.dependencyFingerprint),
      reviewActions.commit(actorId, sessionBinding, rollbackPaymentDraft.id, rollbackPaymentDraft.revision, rollbackPaymentDraft.dependencyFingerprint)
    ]);
    assert.deepEqual(replayedPayment.map((result) => result.result.paymentId), [savedPayment.result.paymentId, savedPayment.result.paymentId]);
    assert.deepEqual(await writerCounts(paymentStudentId), committedPaymentState,
      'concurrent completed-draft submissions replay one payment and allocation set');

    const simultaneousDraft = await startPaymentDraft(paymentStudentId, '5.00');
    const simultaneousBefore = await writerCounts(paymentStudentId);
    const simultaneousResults = await Promise.all([
      reviewActions.commit(actorId, sessionBinding, simultaneousDraft.id, simultaneousDraft.revision, simultaneousDraft.dependencyFingerprint),
      reviewActions.commit(actorId, sessionBinding, simultaneousDraft.id, simultaneousDraft.revision, simultaneousDraft.dependencyFingerprint)
    ]);
    assert.ok(simultaneousResults.every((result) => result.committed));
    assert.equal(simultaneousResults[0].result.paymentId, simultaneousResults[1].result.paymentId,
      'simultaneous first submissions return the same payment result');
    const simultaneousAfter = await writerCounts(paymentStudentId);
    assert.equal(simultaneousAfter.payments, simultaneousBefore.payments + 1,
      'simultaneous first submissions create exactly one payment');
    assert.equal(simultaneousAfter.allocations - simultaneousBefore.allocations, 1,
      'simultaneous first submissions create exactly one allocation');

    const stalePaymentDraft = await startPaymentDraft(assessedScenarios.partial.studentId, '10.00');
    await addAnnualPaymentAllocation(assessedScenarios.partial, 'DP', '50.00');
    const stalePayment = await reviewActions.commit(actorId, sessionBinding, stalePaymentDraft.id,
      stalePaymentDraft.revision, stalePaymentDraft.dependencyFingerprint);
    assert.equal(stalePayment.stale, true, 'a changed balance invalidates the reviewed allocation target');
    const retainedStaleDraft = await reviewActions.getDraft(actorId, stalePaymentDraft.id);
    assert.equal(retainedStaleDraft.status, 'pending');
    const editedStaleDraft = await reviewActions.updateDraft(actorId, sessionBinding, stalePaymentDraft.id,
      { amount: '15.00', paymentDate: '2026-10-04' });
    assert.equal(editedStaleDraft.input.amount, '15.00', 'stale allocation drafts remain editable with current balances');
    await reviewActions.discard(actorId, stalePaymentDraft.id);

    const retiredDraftId = crypto.randomUUID();
    const retiredIdempotencyKey = crypto.randomUUID();
    const retiredStudentId = legacyScenario.studentId;
    const legacyDraftData = {
      entityContext: JSON.stringify({ studentId: retiredStudentId }),
      input: JSON.stringify({ transactionType: 'charge', amount: '12.34', description: 'Historical pending draft' }),
      preview: JSON.stringify({ actionLabel: 'Record legacy account transaction' })
    };
    await appPool.execute(`INSERT INTO finance_review_drafts
      (id, owner_user_id, action_type, entity_context_json, input_json, preview_json,
        dependency_fingerprint, idempotency_key, session_binding_hmac, review_expires_at)
      VALUES (?, ?, 'legacy_transaction', ?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 20 MINUTE))`,
    [retiredDraftId, actorId, legacyDraftData.entityContext, legacyDraftData.input, legacyDraftData.preview,
      'a'.repeat(64), retiredIdempotencyKey, sessionBinding]);
    assert.equal(reviewActions.matchesMutation(`/students/${retiredStudentId}/transactions`), false,
      'retired transaction paths cannot prepare new reviewed drafts');
    async function legacyWriterCounts() {
      const [accounts] = await appPool.execute(`SELECT COUNT(*) AS count, CAST(COALESCE(SUM(balance), 0) AS CHAR(40)) AS balance
        FROM financial_accounts WHERE student_id = ?`, [retiredStudentId]);
      const [transactions] = await appPool.execute(`SELECT COUNT(*) AS count FROM financial_transactions AS transaction_record
        INNER JOIN financial_accounts AS account ON account.id = transaction_record.financial_account_id WHERE account.student_id = ?`, [retiredStudentId]);
      const [audits] = await appPool.execute("SELECT COUNT(*) AS count FROM audit_logs WHERE user_id = ? AND action = 'transaction_recorded'", [actorId]);
      return { accounts: Number(accounts[0].count), balance: String(accounts[0].balance), transactions: Number(transactions[0].count), audits: Number(audits[0].count) };
    }
    const legacyBeforeRetiredCommit = await legacyWriterCounts();
    await assert.rejects(reviewActions.freshReview(actorId, sessionBinding, retiredDraftId), (error) => error.status === 410);
    await assert.rejects(reviewActions.updateDraft(actorId, sessionBinding, retiredDraftId, { amount: '99.99' }),
      (error) => error.status === 410);
    await assert.rejects(reviewActions.commit(actorId, sessionBinding, retiredDraftId, 1, 'a'.repeat(64)),
      (error) => error.status === 410);
    assert.deepEqual(await legacyWriterCounts(), legacyBeforeRetiredCommit,
      'retired pending drafts cannot reach the legacy transaction writer');
    await reviewActions.discard(actorId, retiredDraftId);
    assert.equal((await reviewActions.getDraft(actorId, retiredDraftId)).status, 'discarded',
      'owners may still discard their retired pending draft');

    const ownerDraft = await startPaymentDraft(paymentStudentId, '1.00');
    const [secondActor] = await appPool.execute(
      "INSERT INTO users (email, password_hash, role, is_active) VALUES (?, 'integration-only', 'finance', 1)",
      [`finance-owner-check-${crypto.randomUUID()}@example.test`]
    );
    await assert.rejects(reviewActions.getDraft(Number(secondActor.insertId), ownerDraft.id), /not found/i);
    await assert.rejects(reviewActions.commit(Number(secondActor.insertId), sessionBinding, ownerDraft.id,
      ownerDraft.revision, ownerDraft.dependencyFingerprint), /not found/i);
    const changedSessionBinding = 'b'.repeat(64);
    const reboundDraft = await reviewActions.freshReview(actorId, changedSessionBinding, ownerDraft.id);
    assert.equal(reboundDraft.requiresReview, true, 'a new authenticated session requires a fresh review');
    assert.equal(reboundDraft.revision, ownerDraft.revision + 1);
    const oldSessionCommit = await reviewActions.commit(actorId, sessionBinding, ownerDraft.id,
      ownerDraft.revision, ownerDraft.dependencyFingerprint);
    assert.equal(oldSessionCommit.stale, true);
    const currentSessionDraft = await reviewActions.freshReview(actorId, changedSessionBinding, ownerDraft.id);
    const currentSessionSave = await reviewActions.commit(actorId, changedSessionBinding, ownerDraft.id,
      currentSessionDraft.revision, currentSessionDraft.dependencyFingerprint);
    assert.equal(currentSessionSave.committed, true);

    const expiredDraft = await startPaymentDraft(paymentStudentId, '1.00');
    await appPool.execute('UPDATE finance_review_drafts SET review_expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?', [expiredDraft.id]);
    const expiredCommit = await reviewActions.commit(actorId, sessionBinding, expiredDraft.id,
      expiredDraft.revision, expiredDraft.dependencyFingerprint);
    assert.equal(expiredCommit.stale, true, 'the database clock prevents a stale expired review from posting');
    await reviewActions.discard(actorId, expiredDraft.id);
    const [ownerCapacity] = await appPool.execute(
      "SELECT COUNT(*) AS count FROM finance_review_drafts WHERE owner_user_id = ? AND status = 'pending'", [actorId]
    );
    const pendingDrafts = [];
    while (Number(ownerCapacity[0].count) + pendingDrafts.length < 5) {
      pendingDrafts.push(await startPaymentDraft(paymentStudentId, '1.00'));
    }
    await assert.rejects(startPaymentDraft(paymentStudentId, '1.00'), /five unfinished/i);
    const revokedCandidate = pendingDrafts[0];
    const stateBeforeRevokedCommit = await writerCounts(paymentStudentId);
    await appPool.execute('UPDATE users SET is_active = 0 WHERE id = ?', [actorId]);
    await assert.rejects(reviewActions.listPending(actorId), /no longer active/i);
    await assert.rejects(reviewActions.commit(actorId, sessionBinding, revokedCandidate.id,
      revokedCandidate.revision, revokedCandidate.dependencyFingerprint), /no longer active/i);
    assert.deepEqual(await writerCounts(paymentStudentId), stateBeforeRevokedCommit,
      'revoked Finance access cannot commit saved work or create financial rows');
    const [revokedDraftRow] = await appPool.execute('SELECT status FROM finance_review_drafts WHERE id = ?', [revokedCandidate.id]);
    assert.equal(revokedDraftRow[0].status, 'pending', 'revoked access leaves its saved draft uncommitted');
    await appPool.execute('UPDATE users SET is_active = 1 WHERE id = ?', [actorId]);
    for (const draft of pendingDrafts) await reviewActions.discard(actorId, draft.id);
  } finally {
    if (normalReportPool) await normalReportPool.end();
    if (reportReadPool) await reportReadPool.end();
    if (appPool) await appPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await adminPool.end();
  }
});
