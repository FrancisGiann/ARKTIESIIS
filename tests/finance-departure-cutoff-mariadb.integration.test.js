'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { PoolFacade, sql } = require('../src/config/database');
const { createAnnualFinanceCasesService, FinanceCasesError } = require('../src/services/annualFinanceCasesService');
const { createFinanceReviewActionService } = require('../src/services/financeReviewActionService');
const { createFinanceReviewDraftService } = require('../src/services/financeReviewDraftService');

const socketPath = process.env.FINANCE_DEPARTURE_TEST_SOCKET;

function uuid() { return crypto.randomUUID(); }

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

function makeReviews(charges, { reduce = () => false, reasons = {} } = {}) {
  return charges.map((charge) => ({
    chargeId: String(charge.id),
    decision: reduce(charge) ? 'reduce' : 'retain',
    reductionAmount: reduce(charge) ? String(charge.reductionAmount || charge.amount) : '0.00',
    reason: reasons[charge.installment] || ''
  }));
}

test('Finance departure cutoff migration and reviewed writes preserve payable basis and allocation history', {
  skip: !socketPath && 'Set FINANCE_DEPARTURE_TEST_SOCKET to an isolated local MariaDB socket.'
}, async () => {
  const databaseName = `arktiesiis_departure_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const adminPool = mysql.createPool({ socketPath, user: process.env.FINANCE_DEPARTURE_TEST_USER || 'root', password: '', connectionLimit: 2 });
  let appPool;
  try {
    await adminPool.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    appPool = mysql.createPool({ socketPath, user: process.env.FINANCE_DEPARTURE_TEST_USER || 'root', password: '', database: databaseName,
      connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false });
    const setupConnection = await appPool.getConnection();
    try {
      await applyStatements(setupConnection, readSqlFile(require('node:path').join(__dirname, '../database/mariadb/schema.sql')));
      for (const migration of readForwardMigrations()) {
        await applyStatements(setupConnection, migration.statements);
        await setupConnection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
      }
    } finally { setupConnection.release(); }

    const [versions] = await appPool.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.equal(versions.at(-1)?.version, 'v2.020', 'the disposable database applies the complete forward sequence through migration 020');
    const [migrationTables] = await appPool.execute(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = ? AND table_name IN ('finance_departure_cutoff_reviews', 'finance_departure_charge_reviews') ORDER BY table_name`, [databaseName]);
    assert.deepEqual(migrationTables.map((row) => row.table_name), ['finance_departure_charge_reviews', 'finance_departure_cutoff_reviews']);
    const [historicalRows] = await appPool.execute(`SELECT COUNT(*) AS count FROM finance_departure_cutoff_reviews`);
    assert.equal(Number(historicalRows[0].count), 0, 'migration 020 adds no inferred historical cutoff evidence');

    async function createUser(role, suffix) {
      const [result] = await appPool.execute('INSERT INTO users (email, password_hash, role, is_active) VALUES (?, ?, ?, 1)',
        [`${role}-${suffix}-${uuid()}@example.test`, 'synthetic-integration-only', role]);
      return Number(result.insertId);
    }
    const financeId = await createUser('finance', 'cutoff');
    const adminId = await createUser('database_admin', 'cutoff');
    const registrarId = await createUser('registrar', 'cutoff');
    const [terms] = await appPool.execute(`INSERT INTO academic_terms (school_year, term, is_current)
      VALUES ('2026-2027', 'Term 1', 0), ('2026-2027', 'Term 2', 0), ('2026-2027', 'Term 3', 0)`);
    const [termRows] = await appPool.execute("SELECT id, term FROM academic_terms WHERE school_year = '2026-2027' ORDER BY id");
    assert.equal(termRows.length, 3);
    const termIds = termRows.map((row) => Number(row.id));
    for (let index = 0; index < termIds.length; index += 1) {
      await appPool.execute('INSERT INTO school_year_term_order (school_year, term_number, academic_term_id, configured_by) VALUES (?, ?, ?, ?)',
        ['2026-2027', index + 1, termIds[index], financeId]);
    }
    const [schedule] = await appPool.execute(`INSERT INTO finance_schedules
      (school_year, grade_level, voucher_code, version_no, status, idempotency_key, request_fingerprint, created_by)
      VALUES ('2026-2027', 'Grade 11', 'PUB', 1, 'active', ?, ?, ?)`, [uuid(), 'a'.repeat(64), financeId]);
    const scheduleId = Number(schedule.insertId);

    let lrn = 900000000001;
    async function createDeparture({ label, effectiveTerm = 2, affectedTerms = [2, 3], charges, effectiveDate = '2027-01-15', reviewed = false }) {
      const [studentResult] = await appPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name, status)
        VALUES (?, ?, 'Synthetic', 'Cutoff', 'active')`, [`CUTOFF-${label}-${uuid().slice(0, 8)}`, String(lrn++)]);
      const studentId = Number(studentResult.insertId);
      const [annualResult] = await appPool.execute(`INSERT INTO annual_enrollments
        (student_id, school_year, grade_level, voucher_code, intake_status, created_by, entry_term_number)
        VALUES (?, '2026-2027', 'Grade 11', 'PUB', 'enrolled', ?, 1)`, [studentId, registrarId]);
      const annualId = Number(annualResult.insertId);
      const enrollmentByTerm = new Map();
      for (let term = 1; term <= 3; term += 1) {
        const [enrollment] = await appPool.execute(`INSERT INTO enrollments
          (student_id, academic_term_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status)
          VALUES (?, ?, 'enrolled', ?, ?, 'applicable')`, [studentId, termIds[term - 1], annualId, term]);
        enrollmentByTerm.set(term, Number(enrollment.insertId));
      }
      const [assessmentResult] = await appPool.execute(`INSERT INTO annual_assessments
        (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by,
          selection_json, idempotency_key, request_fingerprint)
        VALUES (?, ?, 1, 'PUB', ?, '{"optionalLineIds":[]}', ?, ?)`, [annualId, scheduleId, financeId, uuid(), 'b'.repeat(64)]);
      const assessmentId = Number(assessmentResult.insertId);
      const chargeRows = [];
      for (const item of charges) {
        const [chargeResult] = await appPool.execute(`INSERT INTO assessed_charges
          (assessment_id, annual_enrollment_id, enrollment_id, schedule_line_id, fee_category, line_name,
            installment, amount, gross_amount, waived_amount)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [assessmentId, annualId, enrollmentByTerm.get(item.term), item.category || 'tuition', item.name || 'Tuition', item.installment,
          item.amount, item.amount, item.waivedAmount || '0.00']);
        const row = { ...item, id: Number(chargeResult.insertId) };
        chargeRows.push(row);
        for (const adjustment of item.adjustments || []) {
          await appPool.execute(`INSERT INTO finance_charge_adjustments
            (charge_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
            VALUES (?, ?, ?, ?, ?, ?)`, [row.id, adjustment.amount, adjustment.reason, uuid(), crypto.createHash('sha256').update(uuid()).digest('hex'), financeId]);
        }
      }
      const [accountResult] = await appPool.execute('INSERT INTO financial_accounts (student_id, balance) VALUES (?, 0.00)', [studentId]);
      const accountId = Number(accountResult.insertId);
      const [caseResult] = await appPool.execute(`INSERT INTO finance_departure_cases
        (annual_enrollment_id, effective_enrollment_id, effective_date, departure_type, reason, finance_status,
          recorded_by, review_reason, idempotency_key, request_fingerprint)
        VALUES (?, ?, ?, 'transferred', 'Synthetic Registrar transfer', ?, ?, NULL, ?, ?)`,
      [annualId, enrollmentByTerm.get(effectiveTerm), effectiveDate, reviewed ? 'reviewed' : 'pending', registrarId, uuid(), 'c'.repeat(64)]);
      const caseId = Number(caseResult.insertId);
      for (const term of affectedTerms) await appPool.execute(`INSERT INTO finance_departure_case_terms
        (departure_case_id, enrollment_id, academic_activity_review_required) VALUES (?, ?, 0)`, [caseId, enrollmentByTerm.get(term)]);
      return { studentId, annualId, caseId, caseTerms: affectedTerms, enrollmentByTerm, charges: chargeRows, accountId };
    }

    async function addAnnualAllocation(departure, chargeId, amount) {
      const [payment] = await appPool.execute(`INSERT INTO finance_payments
        (student_id, amount, payment_date, reference_no, receipt_issued, idempotency_key, request_fingerprint, recorded_by, is_reversed)
        VALUES (?, ?, '2026-10-01', ?, 0, ?, ?, ?, 0)`, [departure.studentId, amount, `SYN-${uuid().slice(0, 8)}`, uuid(), 'd'.repeat(64), financeId]);
      const paymentId = Number(payment.insertId);
      const [batch] = await appPool.execute(`INSERT INTO finance_allocation_batches
        (payment_id, student_id, idempotency_key, request_fingerprint, allocated_by) VALUES (?, ?, ?, ?, ?)`,
      [paymentId, departure.studentId, uuid(), 'e'.repeat(64), financeId]);
      const [allocation] = await appPool.execute(`INSERT INTO finance_payment_allocations
        (payment_id, charge_id, amount, allocation_batch_id, allocated_by) VALUES (?, ?, ?, ?, ?)`,
      [paymentId, chargeId, amount, Number(batch.insertId), financeId]);
      return Number(allocation.insertId);
    }

    async function addLegacyReconciliation(departure, chargeId, amount) {
      const [transaction] = await appPool.execute(`INSERT INTO financial_transactions
        (financial_account_id, transaction_type, amount, reference_no, recorded_by, is_legacy_unattributed)
        VALUES (?, 'payment', ?, ?, ?, 0)`, [departure.accountId, amount, `LEG-${uuid().slice(0, 8)}`, financeId]);
      const transactionId = Number(transaction.insertId);
      const [batch] = await appPool.execute(`INSERT INTO finance_legacy_reconciliation_batches
        (transaction_id, idempotency_key, request_fingerprint, recorded_by) VALUES (?, ?, ?, ?)`,
      [transactionId, uuid(), 'f'.repeat(64), financeId]);
      const [reconciliation] = await appPool.execute(`INSERT INTO finance_legacy_reconciliations
        (transaction_id, charge_id, amount, reason, batch_id, recorded_by) VALUES (?, ?, ?, 'Synthetic legacy payment match', ?, ?)`,
      [transactionId, chargeId, amount, Number(batch.insertId), financeId]);
      return Number(reconciliation.insertId);
    }

    const cases = createAnnualFinanceCasesService({ getPool: async () => new PoolFacade(appPool), sql });

    const noneCase = await createDeparture({ label: 'none', effectiveTerm: 1, affectedTerms: [1, 2], charges: [
      { term: 1, installment: 'DP', amount: '40.00' },
      { term: 1, installment: 'Finals', amount: '60.00' },
      { term: 2, installment: 'Prelim', amount: '70.00' },
      { term: 2, category: 'tuition', name: 'Tuition', installment: 'Whole term', amount: '30.00' }
    ] });
    const noneInput = { cutoffInstallment: 'none', reason: 'Synthetic none-payable review', idempotencyKey: uuid(),
      chargeReviews: makeReviews(noneCase.charges, { reduce: (charge) => ['DP', 'Finals', 'Prelim'].includes(charge.installment) }) };
    const noneResult = await cases.reviewDepartureCase(financeId, noneCase.caseId, noneInput);
    assert.equal(noneResult.reviewed, true);
    const [noneEvidence] = await appPool.execute(`SELECT review.last_payable_installment, detail.installment_snapshot,
        CAST(detail.proposed_reduction_amount AS CHAR) AS proposed, detail.review_category, detail.decision
      FROM finance_departure_cutoff_reviews AS review INNER JOIN finance_departure_charge_reviews AS detail
        ON detail.cutoff_review_id = review.id WHERE review.departure_case_id = ? ORDER BY detail.term_number, detail.charge_id`, [noneCase.caseId]);
    assert.ok(noneEvidence.length >= 4);
    assert.equal(noneEvidence[0].last_payable_installment, 'none');
    assert.ok(noneEvidence.filter((row) => ['DP', 'Finals', 'Prelim'].includes(row.installment_snapshot))
      .every((row) => Number(row.proposed) > 0), 'none-payable cuts off every canonical installment in the departure and later terms');
    assert.equal(noneEvidence.find((row) => row.installment_snapshot === 'Whole term')?.review_category, 'manual_tuition');
    assert.equal(noneEvidence.find((row) => row.installment_snapshot === 'Whole term')?.proposed, '0.00');

    const finalsCase = await createDeparture({ label: 'finals', effectiveTerm: 2, affectedTerms: [2, 3], charges: [
      { term: 2, installment: 'Finals', amount: '55.00' },
      { term: 3, installment: 'DP', amount: '65.00' }
    ] });
    const finalsInput = { cutoffInstallment: 'finals', reason: 'Synthetic finals cutoff', idempotencyKey: uuid(),
      chargeReviews: makeReviews(finalsCase.charges, { reduce: (charge) => charge.term === 3 }) };
    await cases.reviewDepartureCase(financeId, finalsCase.caseId, finalsInput);
    const [cutoffFinalsEvidence] = await appPool.execute(`SELECT detail.term_number, detail.installment_snapshot,
        CAST(detail.proposed_reduction_amount AS CHAR) AS proposed
      FROM finance_departure_cutoff_reviews AS review INNER JOIN finance_departure_charge_reviews AS detail
        ON detail.cutoff_review_id = review.id WHERE review.departure_case_id = ? ORDER BY detail.term_number`, [finalsCase.caseId]);
    assert.deepEqual(cutoffFinalsEvidence.map((row) => [Number(row.term_number), row.installment_snapshot, row.proposed]), [
      [2, 'Finals', '0.00'], [3, 'DP', '65.00']
    ], 'finals remains payable in the departure term while later-term tuition is proposed in full');

    const mainCase = await createDeparture({ label: 'midterm', effectiveTerm: 2, affectedTerms: [2, 3], effectiveDate: '2027-04-01', charges: [
      { term: 2, installment: 'DP', amount: '100.00' },
      { term: 2, installment: 'Prelim', amount: '100.00' },
      { term: 2, installment: 'Midterm', amount: '100.00', waivedAmount: '20.00', adjustments: [
        { amount: '-20.00', reason: 'Synthetic exemption evidence' }, { amount: '-5.00', reason: 'Synthetic prior adjustment' }
      ] },
      { term: 2, installment: 'Finals', amount: '200.00', waivedAmount: '25.00', adjustments: [
        { amount: '-25.00', reason: 'Synthetic exemption evidence' }, { amount: '-15.00', reason: 'Synthetic prior adjustment' }
      ] },
      { term: 2, installment: 'Whole term', amount: '35.00' },
      { term: 2, category: 'miscellaneous', name: 'Laboratory fee', installment: 'As incurred', amount: '50.00' },
      { term: 2, category: 'other', name: 'Named student card fee', installment: 'One-time', amount: '25.00' },
      { term: 3, installment: 'DP', amount: '80.00' },
      { term: 3, installment: 'Finals', amount: '20.00' },
      { term: 3, installment: 'Whole term', amount: '40.00' }
    ] });
    const finalsCharge = mainCase.charges.find((charge) => charge.term === 2 && charge.installment === 'Finals');
    await addAnnualAllocation(mainCase, finalsCharge.id, '80.00');
    await addAnnualAllocation(mainCase, finalsCharge.id, '20.00');
    const legacyReconciliationId = await addLegacyReconciliation(mainCase, finalsCharge.id, '60.00');
    const beforeDeparture = await appPool.execute(`SELECT CAST(due.amount_due AS CHAR) AS amount_due
      FROM v_finance_assessed_charge_due AS due WHERE due.charge_id = ?`,
    [mainCase.charges.find((charge) => charge.term === 2 && charge.installment === 'DP').id]);
    assert.equal(beforeDeparture[0][0].amount_due, '100.00', 'Registrar departure alone leaves an unrelated outstanding charge payable');

    const mainReviews = mainCase.charges.map((charge) => {
      const reduce = charge === finalsCharge
        || (charge.term === 2 && charge.installment === 'Whole term')
        || (charge.category === 'other')
        || (charge.term === 3 && ['DP', 'Finals'].includes(charge.installment));
      const amount = charge === finalsCharge ? '120.00'
        : charge.term === 2 && charge.installment === 'Whole term' ? '5.00'
          : charge.category === 'other' ? '10.00' : charge.amount;
      return { chargeId: String(charge.id), decision: reduce ? 'reduce' : 'retain', reductionAmount: reduce ? amount : '0.00', reason: '' };
    });
    const mainInput = { cutoffInstallment: 'midterm', reason: 'Approved synthetic departure review', idempotencyKey: uuid(), chargeReviews: mainReviews };
    await assert.rejects(cases.reviewDepartureCase(registrarId, mainCase.caseId, mainInput),
      (error) => error instanceof FinanceCasesError && error.status === 403,
      'Registrar cannot submit Finance cutoff decisions');

    const foreignCase = await createDeparture({ label: 'foreign', effectiveTerm: 2, affectedTerms: [2], charges: [
      { term: 2, installment: 'DP', amount: '10.00' }
    ] });
    const mixedStudentInput = { ...mainInput, idempotencyKey: uuid(),
      chargeReviews: [...mainReviews, { chargeId: String(foreignCase.charges[0].id), decision: 'reduce', reductionAmount: '10.00', reason: '' }] };
    await assert.rejects(cases.reviewDepartureCase(financeId, mainCase.caseId, mixedStudentInput),
      (error) => error instanceof FinanceCasesError && error.status === 409,
      'a charge from another student cannot be included in this case review');

    const mainResult = await cases.reviewDepartureCase(financeId, mainCase.caseId, mainInput);
    assert.equal(mainResult.reviewed, true);
    assert.equal(mainResult.studentId, mainCase.studentId);
    const [mainEvidence] = await appPool.execute(`SELECT review.effective_enrollment_id, review.effective_term_number,
        review.last_payable_installment, detail.charge_id, detail.term_number, detail.installment_snapshot,
        detail.review_category, detail.decision, CAST(detail.payable_before_amount AS CHAR) AS before_amount,
        CAST(detail.proposed_reduction_amount AS CHAR) AS proposed_amount,
        CAST(detail.reviewed_reduction_amount AS CHAR) AS reviewed_amount,
        CAST(detail.payable_after_amount AS CHAR) AS after_amount, detail.review_reason
      FROM finance_departure_cutoff_reviews AS review INNER JOIN finance_departure_charge_reviews AS detail
        ON detail.cutoff_review_id = review.id WHERE review.departure_case_id = ? ORDER BY detail.term_number, detail.charge_id`, [mainCase.caseId]);
    assert.equal(mainEvidence.length, mainCase.charges.length, 'every retained and reduced charge receives durable evidence');
    assert.ok(mainEvidence.every((row) => Number(row.effective_term_number) === 2 && row.last_payable_installment === 'midterm'));
    const finalsEvidence = mainEvidence.find((row) => Number(row.charge_id) === finalsCharge.id);
    assert.deepEqual([finalsEvidence.review_category, finalsEvidence.decision, finalsEvidence.before_amount,
      finalsEvidence.proposed_amount, finalsEvidence.reviewed_amount, finalsEvidence.after_amount],
    ['canonical_tuition', 'reduce', '160.00', '160.00', '120.00', '40.00'],
    'net basis includes exemption and prior adjustment once; Finance may choose a smaller reduction');
    const midtermEvidence = mainEvidence.find((row) => row.installment_snapshot === 'Midterm');
    assert.deepEqual([midtermEvidence.before_amount, midtermEvidence.proposed_amount, midtermEvidence.decision, midtermEvidence.after_amount],
      ['75.00', '0.00', 'retain', '75.00'], 'an exemption adjustment is already included in the payable basis');
    const legacyTuitionEvidence = mainEvidence.find((row) => row.installment_snapshot === 'Whole term' && Number(row.term_number) === 2);
    assert.deepEqual([legacyTuitionEvidence.review_category, legacyTuitionEvidence.proposed_amount,
      legacyTuitionEvidence.reviewed_amount, legacyTuitionEvidence.after_amount],
    ['manual_tuition', '0.00', '5.00', '30.00'], 'whole-term tuition requires a manual amount');
    const labEvidence = mainEvidence.find((row) => row.installment_snapshot === 'As incurred');
    assert.deepEqual([labEvidence.review_category, labEvidence.decision, labEvidence.reviewed_amount],
      ['individual_fee', 'retain', '0.00'], 'miscellaneous charges receive an individual keep decision');
    assert.equal(labEvidence.review_reason, 'Approved synthetic departure review', 'the overall reason supplies evidence for retained rows');
    const namedFeeEvidence = mainEvidence.find((row) => row.installment_snapshot === 'One-time');
    assert.deepEqual([namedFeeEvidence.review_category, namedFeeEvidence.decision, namedFeeEvidence.reviewed_amount],
      ['individual_fee', 'reduce', '10.00'], 'named other fees receive an individual manual reduction');

    const [releaseRows] = await appPool.execute(`SELECT 'annual' AS kind, allocation.id AS source_id,
        CAST(SUM(release_record.amount) AS CHAR) AS released
      FROM finance_payment_allocation_releases AS release_record
      INNER JOIN finance_payment_allocations AS allocation ON allocation.id = release_record.allocation_id
      WHERE allocation.charge_id = ? GROUP BY allocation.id
      UNION ALL
      SELECT 'legacy', reconciliation.id, CAST(SUM(release_record.amount) AS CHAR)
      FROM finance_legacy_reconciliation_releases AS release_record
      INNER JOIN finance_legacy_reconciliations AS reconciliation ON reconciliation.id = release_record.reconciliation_id
      WHERE reconciliation.id = ? GROUP BY reconciliation.id ORDER BY kind, source_id`, [finalsCharge.id, legacyReconciliationId]);
    assert.equal(releaseRows.filter((row) => row.kind === 'annual').length, 2, 'each annual allocation row is considered');
    assert.equal(releaseRows.filter((row) => row.kind === 'annual').reduce((sum, row) => sum + Number(row.released), 0), 100);
    assert.equal(releaseRows.find((row) => row.kind === 'legacy')?.released, '20.00', 'excess release continues to legacy allocation after annual allocations');
    const [remainder] = await appPool.execute(`SELECT CAST(due.amount_due AS CHAR) AS amount_due,
        CAST(due.annual_allocated AS CHAR) AS annual_allocated, CAST(due.legacy_allocated AS CHAR) AS legacy_allocated
      FROM v_finance_assessed_charge_due AS due WHERE due.charge_id = ?`, [finalsCharge.id]);
    assert.deepEqual([remainder[0].amount_due, remainder[0].annual_allocated, remainder[0].legacy_allocated],
      ['0.00', '0.00', '40.00'], 'remaining legacy payment and reduced charge reconcile');

    const exactReplay = await cases.reviewDepartureCase(financeId, mainCase.caseId, mainInput);
    assert.equal(exactReplay.alreadyReviewed, true, 'an exact duplicate is idempotent');
    await assert.rejects(cases.reviewDepartureCase(financeId, mainCase.caseId, {
      ...mainInput, reason: 'Changed reason with the same key'
    }), (error) => error instanceof FinanceCasesError && error.status === 409, 'changed duplicate content conflicts');
    await assert.rejects(cases.reviewDepartureCase(financeId, mainCase.caseId, {
      ...mainInput, idempotencyKey: uuid()
    }), (error) => error instanceof FinanceCasesError && error.status === 409, 'a new submission cannot repeat reviewed adjustments');
    const [adjustmentCounts] = await appPool.execute('SELECT COUNT(*) AS count FROM finance_charge_adjustments WHERE departure_case_id = ?', [mainCase.caseId]);
    assert.equal(Number(adjustmentCounts[0].count), mainReviews.filter((row) => row.decision === 'reduce').length);

    const historicalCase = await createDeparture({ label: 'historical', affectedTerms: [2], charges: [
      { term: 2, installment: 'DP', amount: '9.00' }
    ], reviewed: true });
    const historicalStudentCases = await cases.getStudentCases(financeId, historicalCase.studentId);
    const historical = historicalStudentCases.departures.find((row) => Number(row.departure_case_id) === historicalCase.caseId);
    assert.equal(historical?.last_payable_installment, null, 'previously reviewed cases stay historical without inferred cutoff evidence');

    const staleCase = await createDeparture({ label: 'stale', effectiveTerm: 2, affectedTerms: [2], charges: [
      { term: 2, installment: 'Finals', amount: '50.00' }
    ] });
    const draftService = createFinanceReviewDraftService({ getPool: async () => new PoolFacade(appPool), sql });
    const reviewActions = createFinanceReviewActionService({ getPool: async () => new PoolFacade(appPool), sql, draftService });
    const staleDraftIdentity = await reviewActions.startDraft(financeId, 'a'.repeat(64), `/departure-cases/${staleCase.caseId}/review`, {
      cutoffInstallment: 'midterm', reason: 'Synthetic stale-preview test',
      chargeReviews: makeReviews(staleCase.charges, { reduce: () => true })
    });
    const staleDraft = await reviewActions.getDraft(financeId, staleDraftIdentity.id);
    assert.equal(staleDraft.preview.departureReviewReady, true);
    assert.equal(staleDraft.preview.departureChargeReviews[0].reason, 'Overall Finance reason: Synthetic stale-preview test',
      'the initial overall reason becomes the evidence fallback for fees without a per-charge note');
    assert.deepEqual({ decision: staleDraft.preview.departureChargeReviews[0].decision,
      reductionAmount: staleDraft.preview.departureChargeReviews[0].reductionAmount,
      payableAfter: staleDraft.preview.departureChargeReviews[0].payableAfter,
      reviewedReductionReady: staleDraft.preview.departureChargeReviews[0].reviewedReductionReady },
    { decision: 'reduce', reductionAmount: '50.00', payableAfter: '0.00', reviewedReductionReady: true },
    'the reviewed preview reflects the saved reduction amount and after-balance');
    const retainedInput = structuredClone(staleDraft.input);
    retainedInput.chargeReviews[0] = { ...retainedInput.chargeReviews[0], decision: 'retain', reductionAmount: '0.00', reason: '' };
    await reviewActions.updateDraft(financeId, 'a'.repeat(64), staleDraft.id, retainedInput);
    const editedDraft = await reviewActions.getDraft(financeId, staleDraft.id);
    assert.equal(editedDraft.preview.departureReviewReady, true);
    assert.deepEqual({ decision: editedDraft.preview.departureChargeReviews[0].decision,
      reductionAmount: editedDraft.preview.departureChargeReviews[0].reductionAmount,
      payableAfter: editedDraft.preview.departureChargeReviews[0].payableAfter,
      reviewedReductionReady: editedDraft.preview.departureChargeReviews[0].reviewedReductionReady },
    { decision: 'retain', reductionAmount: '0.00', payableAfter: '50.00', reviewedReductionReady: true },
    'updating and reloading a draft refreshes the actual reviewed amount and after-balance');
    await addAnnualAllocation(staleCase, staleCase.charges[0].id, '50.00');
    const staleOutcome = await reviewActions.commit(financeId, 'a'.repeat(64), editedDraft.id,
      editedDraft.revision, editedDraft.dependencyFingerprint);
    assert.equal(staleOutcome.stale, true, 'a new payment allocation invalidates the review before commit');
    const [staleState] = await appPool.execute(`SELECT departure.finance_status, COUNT(cutoff.id) AS cutoff_count
      FROM finance_departure_cases AS departure LEFT JOIN finance_departure_cutoff_reviews AS cutoff
        ON cutoff.departure_case_id = departure.id WHERE departure.id = ? GROUP BY departure.id`, [staleCase.caseId]);
    assert.deepEqual([staleState[0].finance_status, Number(staleState[0].cutoff_count)], ['pending', 0]);

    const legacyDraftCase = await createDeparture({ label: 'legacy-draft', effectiveTerm: 2, affectedTerms: [2], charges: [
      { term: 2, installment: 'DP', amount: '10.00' }, { term: 2, installment: 'Finals', amount: '20.00' }
    ] });
    const legacyDraftIdentity = await reviewActions.startDraft(financeId, 'b'.repeat(64), `/departure-cases/${legacyDraftCase.caseId}/review`, {
      reason: 'Old adjustment-only request', adjustments: [{ chargeId: String(legacyDraftCase.charges[1].id), amount: '20.00', reason: 'Old request' }]
    });
    const legacyDraft = await reviewActions.getDraft(financeId, legacyDraftIdentity.id);
    assert.equal(legacyDraft.preview.departureReviewReady, false, 'old adjustment-only draft input cannot satisfy cutoff and complete per-charge evidence');
    await assert.rejects(reviewActions.commit(financeId, 'b'.repeat(64), legacyDraft.id, legacyDraft.revision, legacyDraft.dependencyFingerprint),
      (error) => error instanceof FinanceCasesError && error.status === 400,
      'the commit writer revalidates the cutoff even if a caller submits a crafted draft');

    const malformedIdentity = await reviewActions.startDraft(financeId, 'c'.repeat(64), `/departure-cases/${legacyDraftCase.caseId}/review`, {
      cutoffInstallment: 'midterm', reason: 'Malformed duplicate-decision test', chargeReviews: [
        { chargeId: String(legacyDraftCase.charges[0].id), decision: 'retain', reductionAmount: '0.00', reason: '' },
        { chargeId: String(legacyDraftCase.charges[0].id), decision: 'reduce', reductionAmount: '10.00', reason: '' },
        { chargeId: '999999999', decision: 'reduce', reductionAmount: '1.00', reason: '' }
      ]
    });
    const malformedDraft = await reviewActions.getDraft(financeId, malformedIdentity.id);
    assert.equal(malformedDraft.preview.departureReviewReady, false, 'duplicate and unknown charge IDs do not disappear into a confirmable draft');
    const refreshedMalformedDraft = await reviewActions.freshReview(financeId, 'c'.repeat(64), malformedDraft.id);
    assert.equal(refreshedMalformedDraft.preview.departureReviewReady, false, 'refreshing a malformed draft still requires explicit staff decisions');

    const concurrentCase = await createDeparture({ label: 'concurrent', effectiveTerm: 2, affectedTerms: [2], charges: [
      { term: 2, installment: 'Prelim', amount: '18.00' }
    ] });
    const concurrentInput = (key) => ({ cutoffInstallment: 'dp', reason: 'Synthetic concurrent review', idempotencyKey: key,
      chargeReviews: makeReviews(concurrentCase.charges, { reduce: () => true }) });
    const concurrent = await Promise.allSettled([
      cases.reviewDepartureCase(financeId, concurrentCase.caseId, concurrentInput(uuid())),
      cases.reviewDepartureCase(financeId, concurrentCase.caseId, concurrentInput(uuid()))
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1, 'only one racing submission can post the case');
    const rejected = concurrent.find((result) => result.status === 'rejected');
    assert.ok(rejected?.reason instanceof FinanceCasesError && rejected.reason.status === 409);
    const [concurrentEvidence] = await appPool.execute('SELECT COUNT(*) AS count FROM finance_departure_cutoff_reviews WHERE departure_case_id = ?', [concurrentCase.caseId]);
    assert.equal(Number(concurrentEvidence[0].count), 1, 'transaction locks leave one cutoff and one set of adjustments');

    const adminCase = await createDeparture({ label: 'admin', effectiveTerm: 2, affectedTerms: [2], charges: [
      { term: 2, installment: 'DP', amount: '12.00' }
    ] });
    const adminResult = await cases.reviewDepartureCase(adminId, adminCase.caseId, {
      cutoffInstallment: 'dp', reason: 'Synthetic database-admin role review', idempotencyKey: uuid(),
      chargeReviews: makeReviews(adminCase.charges)
    });
    assert.equal(adminResult.reviewed, true, 'database_admin retains authorized Finance workflow');
  } finally {
    if (appPool) await appPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await adminPool.end();
  }
});
