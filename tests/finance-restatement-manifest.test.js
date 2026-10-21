'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildAllocationPlan,
  buildChargePlan,
  canonicalManifestRows,
  parseCents,
  sha256,
  uuidV5,
  validateManifestRows
} = require('../scripts/finance-restatement-manifest');
const {
  MaintenanceError,
  assertBeforeStateEligibility,
  countSqlStatementTerminators,
  publicMaintenanceErrorMessage,
  queryFreshManifest
} = require('../scripts/hostinger-demo-finance-restatement');

function syntheticFixedManifestRows() {
  const rows = [];
  const contexts = [
    ['11', 'PUB'], ['11', 'ESC'], ['11', 'NV'],
    ['12', 'PUB'], ['12', 'ESC'], ['12', 'NV']
  ];
  const installments = [['DP', 500], ['Prelim', 500], ['Midterm', 500], ['Finals', 800]];
  let lineId = 1;
  for (let contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
    const [grade, voucher] = contexts[contextIndex];
    const scheduleId = 100 + contextIndex;
    for (let term = 1; term <= 3; term += 1) {
      for (const [installment, amount] of installments) {
        const row = {
          kind: 'configured-target-v2-line', ordinal: lineId, scheduleLineId: lineId,
          scheduleId, scheduleKey: `schedule-${scheduleId}`, scheduleVersion: 2,
          schoolYear: '2026-2027', grade, voucher, scheduleStatus: 'active',
          term, category: 'tuition', lineName: `Tuition ${installment}`, installment,
          amount: `${amount}.00`, optional: 0
        };
        rows.push(row);
        lineId += 1;
      }
    }
  }

  const annuals = [];
  const tuitionChargeIdByAnnualTerm = new Map();
  let chargeId = 1;
  for (let index = 0; index < 79; index += 1) {
    const annualId = index + 1;
    const assessmentId = annualId + 1000;
    const context = contexts[index % contexts.length];
    const annual = {
      kind: 'annual-and-confirmation', ordinal: index + 22,
      annualId, assessmentId, confirmationId: annualId + 2000,
      expectedAnnualKey: `annual-${annualId}`, actualAnnualKey: `annual-${annualId}`,
      expectedAssessmentKey: `assessment-${annualId}`, actualAssessmentKey: `assessment-${annualId}`,
      confirmationKey: `confirmation-${annualId}`, confirmationSnapshotFingerprint: 'a'.repeat(64),
      sourceScheduleVersion: 1, annualGrade: context[0], annualVoucher: context[1],
      annualSchoolYear: '2026-2027', intakeStatus: 'enrolled'
    };
    annuals.push(annual);
    rows.push(annual);
    for (let term = 1; term <= 3; term += 1) {
      const tuitionId = chargeId++;
      tuitionChargeIdByAnnualTerm.set(`${annualId}|${term}`, tuitionId);
      rows.push({
        kind: 'expected-expansion-charge', ordinal: tuitionId, chargeId: tuitionId,
        annualId, assessmentId, term, expectedCategory: 'tuition', actualCategory: 'tuition',
        expectedChargeKey: `charge-${tuitionId}`, actualChargeKey: `charge-${tuitionId}`,
        chargeAnnualId: annualId, chargeAssessmentId: assessmentId,
        chargeEnrollmentId: annualId * 10 + term, amount: '2300.00', grossAmount: '2300.00',
        waivedAmount: 0, isManual: 0
      });
      const miscId = chargeId++;
      rows.push({
        kind: 'expected-expansion-charge', ordinal: miscId, chargeId: miscId,
        annualId, assessmentId, term, expectedCategory: 'miscellaneous', actualCategory: 'miscellaneous',
        expectedChargeKey: `charge-${miscId}`, actualChargeKey: `charge-${miscId}`,
        chargeAnnualId: annualId, chargeAssessmentId: assessmentId,
        chargeEnrollmentId: annualId * 10 + term, amount: '600.00', grossAmount: '600.00',
        waivedAmount: 0, isManual: 0
      });
    }
  }

  for (let paymentId = 1; paymentId <= 27; paymentId += 1) {
    rows.push({
      kind: 'cohort-student-payment', ordinal: paymentId, paymentId, annualId: paymentId + 1,
      expectedExpansionPaymentKey: `payment-${paymentId}`, actualPaymentKey: `payment-${paymentId}`,
      amount: '1200.00', paymentDate: '2026-09-01', isReversed: 0, receiptPresent: false
    });
    rows.push({
      kind: 'missing-expected-expansion-payment', ordinal: paymentId,
      expectedPaymentKey: `payment-${paymentId}`, expectedAllocationBatchKey: `batch-${paymentId}`, paymentId
    });
  }
  rows.push({
    kind: 'cohort-student-payment', ordinal: 29, paymentId: 29, annualId: 1,
    expectedExpansionPaymentKey: null, actualPaymentKey: 'later-payment-29',
    amount: '1000.00', paymentDate: '2026-10-08', isReversed: 0, receiptPresent: true
  });

  for (let allocationId = 1; allocationId <= 28; allocationId += 1) {
    const isLater = allocationId === 28;
    const annualId = isLater ? 1 : allocationId + 1;
    const paymentId = isLater ? 29 : allocationId;
    const amount = isLater ? '950.00' : allocationId <= 13 ? '600.00' : '1001.00';
    rows.push({
      kind: 'cohort-payment-allocation', ordinal: allocationId, allocationId,
      allocationBatchId: allocationId, allocationBatchKey: `batch-${paymentId}`,
      expectedAllocationBatchKey: `batch-${paymentId}`, paymentId, annualId,
      chargeId: tuitionChargeIdByAnnualTerm.get(`${annualId}|1`), targetCategory: 'tuition',
      targetChargeAnnualId: annualId, targetChargeEnrollmentId: annualId * 10 + 1,
      targetTerm: 1, targetScheduleLineId: null, targetInstallment: null,
      allocationAmount: amount, effectiveNetApplied: amount, netAmountBeforePaymentReversal: amount,
      releasedAmount: '0.00', paymentReversed: 0, legacyOpeningChargeId: null,
      receiptPresent: isLater
    });
  }
  rows.push({
    kind: 'cohort-payment-allocation', ordinal: 29, allocationId: 29,
    allocationBatchId: 28, allocationBatchKey: 'batch-29', expectedAllocationBatchKey: 'batch-29',
    paymentId: 29, annualId: 1, chargeId: 2, targetCategory: 'miscellaneous',
    targetChargeAnnualId: 1, targetChargeEnrollmentId: 11, targetTerm: 1,
    allocationAmount: '50.00', effectiveNetApplied: '50.00', netAmountBeforePaymentReversal: '50.00',
    releasedAmount: '0.00', paymentReversed: 0, legacyOpeningChargeId: null, receiptPresent: true
  });
  return rows;
}

function syntheticBeforeState() {
  const sourceRows = [];
  const chargeRows = [];
  let chargeId = 1;
  for (let term = 1; term <= 3; term += 1) {
    for (let ordinal = 1; ordinal <= 79; ordinal += 1) {
      for (const category of ['tuition', 'miscellaneous']) {
        sourceRows.push({ chargeId, expectedCategory: category, term, ordinal });
        chargeRows.push({ id: chargeId, fee_category: category, amount: '100.00', gross_amount: '100.00',
          waived_amount: '0.00', is_manual: 0, special_subject_id: null,
          synthetic_restatement_operation_id: null, synthetic_restatement_role: null });
        chargeId += 1;
      }
    }
  }
  return {
    groups: new Map([['expected-expansion-charge', sourceRows]]),
    state: {
      chargeRows,
      annualRows: [{ intake_status: 'enrolled' }],
      assessmentRows: [{ schedule_version: 1 }],
      confirmationRows: [{ assessment_snapshot_fingerprint: 'saved-fingerprint' }],
      adjustments: [], releaseRows: [], exemptionApplications: [], exemptionCases: [], exemptionRules: [],
      legacy: [], legacyReleases: [], allocationRows: [{ synthetic_restatement_operation_id: null }]
    }
  };
}

test('fixed manifest rejects drift and produces exact configured tuition rows and same-term allocations', () => {
  const rows = syntheticFixedManifestRows();
  const digest = sha256(canonicalManifestRows(rows));
  const validated = validateManifestRows(rows, digest);
  const operationId = 'b35ff673-1a38-4d05-9494-0f447fa71a1a';
  const charges = buildChargePlan(validated, operationId);
  const allocations = buildAllocationPlan(validated, operationId);

  assert.equal(charges.sources.length, 237);
  assert.equal(charges.generated.length, 948);
  assert.equal(new Set(charges.generated.map((row) => row.sourceChargeId)).size, 237);
  assert.deepEqual(new Set(charges.generated.map((row) => row.line.installment)), new Set(['DP', 'Prelim', 'Midterm', 'Finals']));
  assert.ok(charges.generated.every((row) => row.line.category === 'tuition'));
  assert.equal(allocations.length, 70);
  assert.ok(allocations.every((placement) => placement.term === 1));
  assert.equal(allocations.filter((placement) => placement.oldAllocationId === 28)
    .reduce((sum, placement) => sum + parseCents(placement.amount), 0n), 95000n);
  assert.equal(new Set(charges.generated.map((row) => row.idempotencyKey)).size, 948);
  assert.throws(() => validateManifestRows(rows, '0'.repeat(64)), /digest does not match/);
});

test('apply preflight accepts the frozen zero-evidence source state across all 474 charges', () => {
  const { state, groups } = syntheticBeforeState();
  assert.doesNotThrow(() => assertBeforeStateEligibility(state, groups));
});

test('apply preflight rejects new financial evidence on any source charge, including miscellaneous charges', () => {
  const rejectedEvidence = [
    ['adjustments', { id: 1, charge_id: 2, amount: '25.00' }],
    ['releaseRows', { id: 1, allocation_id: 1, amount: '25.00' }],
    ['exemptionApplications', { id: 1, charge_id: 2, amount: '25.00' }],
    ['exemptionCases', { id: 1, annual_enrollment_id: 1, status: 'pending' }],
    ['exemptionRules', { id: 1, exemption_case_id: 1, term_number: 1, approved_amount: '25.00' }],
    ['legacy', { id: 1, charge_id: 2, amount: '25.00' }],
    ['legacyReleases', { id: 1, reconciliation_id: 1, amount: '25.00' }]
  ];

  for (const [field, row] of rejectedEvidence) {
    const { state, groups } = syntheticBeforeState();
    state[field] = [row];
    assert.throws(() => assertBeforeStateEligibility(state, groups), /approved zero-evidence baseline/, field);
  }
});

test('effective charge view requires matching applied operation and annual evidence', () => {
  const migration = fs.readFileSync(path.join(__dirname,
    '../database/mariadb/migrations/024_finance_assessment_restatement.sql'), 'utf8');
  const activeAnnualView = migration.match(/CREATE OR REPLACE VIEW v_finance_restatement_active_annuals AS([\s\S]*?)CREATE OR REPLACE VIEW v_finance_restatement_active_operations AS/);
  const effectiveChargeView = migration.match(/CREATE OR REPLACE VIEW v_finance_effective_assessed_charges AS([\s\S]*?)CREATE OR REPLACE VIEW v_finance_net_payment_allocations AS/);
  assert.ok(activeAnnualView, 'active annual evidence view exists');
  assert.ok(effectiveChargeView, 'effective assessed-charge view exists');
  assert.match(activeAnnualView[1], /INNER JOIN finance_assessment_restatement_events AS applied[\s\S]*?applied\.event_type = 'applied'/);
  assert.match(activeAnnualView[1], /NOT EXISTS \([\s\S]*?reversed\.event_type = 'reversed'/);

  const sql = effectiveChargeView[1];
  const generatedStart = sql.indexOf("OR (charge.synthetic_restatement_role = 'generated'");
  const sourceStart = sql.indexOf("OR (charge.synthetic_restatement_role = 'source'");
  const generatedBranch = generatedStart >= 0 && sourceStart > generatedStart
    ? sql.slice(generatedStart, sourceStart) : '';
  const sourceBranch = sourceStart >= 0 ? sql.slice(sourceStart, sql.indexOf(';', sourceStart)) : '';
  assert.ok(generatedBranch, 'generated charges have a dedicated visibility branch');
  assert.ok(sourceBranch, 'source charges have a dedicated visibility branch');
  for (const branch of [generatedBranch, sourceBranch]) {
    assert.match(branch, /active\.operation_id = charge\.synthetic_restatement_operation_id/);
    assert.match(branch, /active\.annual_enrollment_id = charge\.annual_enrollment_id/);
  }
  assert.match(generatedBranch, /EXISTS/);
  assert.match(sourceBranch, /NOT EXISTS/);
  assert.doesNotMatch(sourceBranch, /reversed_operations|event_type = 'reversed'/,
    'a source row remains visible when applied evidence is absent, including incomplete operations');
  assert.match(sql, /charge\.synthetic_restatement_operation_id IS NULL AND charge\.synthetic_restatement_role IS NULL/,
    'ordinary unmarked charges remain visible');
  assert.match(migration, /synthetic_restatement_operation_id IS NULL AND synthetic_restatement_role IS NULL/);
  assert.match(migration, /synthetic_restatement_operation_id IS NOT NULL AND synthetic_restatement_role IS NOT NULL[\s\S]*?synthetic_restatement_role IN \('source', 'generated'\)/,
    'charge role and operation markers must be set together and use a known role');
  assert.match(migration, /synthetic_restatement_operation_id IS NOT NULL AND synthetic_restatement_kind IS NOT NULL[\s\S]*?synthetic_restatement_kind IN \('placement', 'restoration'\)/,
    'allocation operation and kind markers must be set together and use a known kind');
});

test('UUIDv5 identifiers are stable for operation-scoped generated rows', () => {
  assert.equal(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com'),
    '2ed6657d-e927-568b-95e1-2665a8aea6a2');
  assert.equal(uuidV5('b35ff673-1a38-4d05-9494-0f447fa71a1a', 'charge:1:3'),
    uuidV5('b35ff673-1a38-4d05-9494-0f447fa71a1a', 'charge:1:3'));
});

test('manifest refresh executes only its canonical SELECT inside the caller transaction', async () => {
  const pinnedSql = [
    '-- reviewed read-only wrapper',
    'SET SESSION max_statement_time = 5;',
    'START TRANSACTION READ ONLY;',
    '',
    "WITH expected_annuals AS (SELECT 'embedded; separator' AS ordinal)",
    'SELECT manifest_row FROM manifest_rows',
    'ORDER BY sort_group, ordinal, row_id;',
    '',
    'ROLLBACK;',
    ''
  ].join('\n');
  let queryCount = 0;
  let transactionActive = true;
  const heldLocks = ['fixed cohort rows'];
  const connection = {
    async query(sql) {
      queryCount += 1;
      if (/\b(?:START|COMMIT|ROLLBACK)\s+TRANSACTION\b/i.test(sql)) transactionActive = false;
      assert.match(sql, /^WITH expected_annuals AS \(/);
      assert.match(sql, /SELECT manifest_row FROM manifest_rows\s+ORDER BY sort_group, ordinal, row_id$/);
      assert.equal(countSqlStatementTerminators(sql), 0);
      assert.doesNotMatch(sql, /\b(?:SET|START|COMMIT|ROLLBACK)\b/i);
      assert.equal(transactionActive, true);
      assert.deepEqual(heldLocks, ['fixed cohort rows']);
      return [[{ manifest_row: JSON.stringify({ kind: 'fixture' }) }]];
    }
  };

  const rows = await queryFreshManifest(connection, pinnedSql);
  assert.deepEqual(rows, [{ kind: 'fixture' }]);
  assert.equal(queryCount, 1);
  assert.equal(transactionActive, true);
  assert.deepEqual(heldLocks, ['fixed cohort rows']);
  await assert.rejects(() => queryFreshManifest(connection, pinnedSql.replace(
    'ORDER BY sort_group, ordinal, row_id;',
    'ORDER BY sort_group, ordinal, row_id; DELETE FROM finance_payments;'
  )), /exactly one bounded SELECT statement/);
  assert.equal(queryCount, 1);
});

test('maintenance CLI does not print unexpected database errors', () => {
  assert.equal(publicMaintenanceErrorMessage(new MaintenanceError('The approved manifest digest does not match.')),
    'The approved manifest digest does not match.');
  assert.equal(publicMaintenanceErrorMessage(new Error('SQL syntax at private row 42 with personal data')),
    'An unexpected maintenance failure occurred. Review protected operator logs before retrying.');
});
