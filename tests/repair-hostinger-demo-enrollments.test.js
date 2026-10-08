'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExpansionPlan, stableUuid, SCHOOL_YEAR } = require('../scripts/expand-hostinger-demo');
const {
  EXTRA_DUMMY_ALLOWLIST,
  RepairError,
  assertPlanCohort,
  buildSourceRecord,
  extraDummyTarget,
  subtractMoney,
  deltaPredicateColumns,
  buildIntegrityAssertionSql
} = require('../scripts/repair-hostinger-demo-enrollments');

function exactCohort() {
  const plan = buildExpansionPlan({ today: new Date('2026-10-08T00:00:00Z') });
  const legacy = plan.annualStudents.filter(({ ordinal }) => ordinal >= 22 && ordinal <= 100).map((seed, index) => {
    const enrolled = index < 22;
    return {
      student_no: seed.studentNo,
      student_id: 1000 + seed.ordinal,
      annual_id: 2000 + seed.ordinal,
      school_year: SCHOOL_YEAR,
      grade_level: seed.gradeLevel,
      voucher_code: seed.voucherCode,
      intake_kind: 'new',
      intake_status: enrolled ? 'enrolled' : 'pending',
      annual_key: seed.annualKey,
      assessment_key: stableUuid(`assessment:${seed.ordinal}`),
      student_status: 'active',
      user_id: null,
      pre_enrollment_id: null,
      account_activation_pending: 0,
      placement_count: 3,
      charge_count: 6,
      lrn: String(900000000000 + seed.ordinal),
      confirmation_id: enrolled ? 3000 + seed.ordinal : null
    };
  });
  const extras = EXTRA_DUMMY_ALLOWLIST.map((item) => ({
    student_no: item.studentNo,
    student_id: item.studentId,
    annual_id: item.annualId,
    school_year: SCHOOL_YEAR,
    grade_level: item.gradeLevel,
    voucher_code: item.voucherCode,
    entry_term_number: item.entryTermNumber,
    intake_kind: item.priorIntakeKind,
    intake_status: 'pending',
    annual_key: item.annualKey,
    student_status: 'active',
    user_id: item.userId,
    user_role: 'student',
    user_active: 0,
    must_change_password: 1,
    pre_enrollment_id: null,
    account_activation_pending: 1,
    placement_count: 3,
    assessment_id: null,
    charge_count: 0,
    payment_count: item.paymentCount,
    payment_total: item.paymentTotal,
    unallocated_payment_count: item.unallocatedPaymentCount,
    unallocated_payment_total: item.unallocatedPaymentTotal,
    annual_history_count: 1,
    departure_case_count: 0,
    readmission_evaluation_count: 0,
    grade_count: 0,
    lrn: String(910000000000 + item.studentId),
    confirmation_id: null
  }));
  return { plan, rows: [...legacy, ...extras] };
}

test('the repair cohort accepts only the 79 seeded rows plus the three exact dummy identities', () => {
  const { plan, rows } = exactCohort();
  const summary = assertPlanCohort(rows, plan);
  assert.deepEqual([summary.count, summary.legacyCount, summary.explicitExtraCount, summary.confirmedBefore, summary.pendingBefore], [82, 79, 3, 22, 57]);
  assert.deepEqual(summary.preservedUnallocatedTargetCredits, [{ studentNo: 'SHS-2026-0002', paymentCount: 1, availableCredit: '600.00' }]);

  const changedIdentity = rows.map((row) => ({ ...row }));
  changedIdentity.at(-1).user_id += 1;
  assert.throws(() => assertPlanCohort(changedIdentity, plan), RepairError);
});

test('legacy repair sources carry distinct synthetic metadata and never mark paper receipts or clearance', () => {
  const emails = new Set();
  for (const item of EXTRA_DUMMY_ALLOWLIST) {
    const source = buildSourceRecord({
      student_no: item.studentNo,
      school_year: SCHOOL_YEAR,
      first_name: 'Synthetic',
      middle_name: null,
      last_name: 'Fixture',
      suffix: null,
      lrn: String(910000000000 + item.studentId),
      phone: null,
      sex: 'female',
      birth_date: '2009-02-03',
      grade_level: item.gradeLevel,
      section_cluster: 'Academic',
      section_strand: 'STEM',
      intake_kind: item.priorIntakeKind
    });

    assert.equal(source.record.status, 'ready_for_registrar');
    assert.equal(source.record.applicantKind, 'new');
    assert.match(source.record.email, /^demo-hostinger-fixture-shs-2026-000[124]@example\.invalid$/);
    assert.equal(emails.has(source.record.email), false);
    emails.add(source.record.email);
    assert.ok(source.record.receipts.every((receipt) => receipt.originalReceived === false
      && receipt.photocopyReceived === false));
    assert.equal(source.preferenceContext.fixtureType, 'hostinger-demo-legacy-intake-v2');
    assert.equal(source.preferenceContext.preferenceFieldsSynthetic, true);
    assert.equal(source.preferenceContext.paperInspected, false);
    assert.equal(source.preferenceContext.studentSignatureInspected, false);
    assert.equal(source.preferenceContext.paperClearanceRecorded, false);
    assert.equal(source.preferenceContext.receiptItemsMarkedReceived, false);
    assert.match(source.preferenceContext.note, /not paper transcription or evidence/);
  }
});

test('extra annual finance summaries are limited to the three explicit unassessed dummy identities', () => {
  assert.deepEqual(EXTRA_DUMMY_ALLOWLIST.map(({ studentNo }) => Boolean(extraDummyTarget(studentNo))), [true, true, true]);
  assert.equal(extraDummyTarget('DEMO-HOSTINGER-0032'), null);
  assert.equal(extraDummyTarget('SHS-2026-0003'), null);
});

test('small database assertion scripts fail closed without returning per-table result sets', () => {
  const tableNames = Array.from({ length: 44 }, (_, index) => `fixture_table_${String(index).padStart(2, '0')}`);
  const fingerprints = Object.fromEntries(tableNames.map((table) => [table, 'a'.repeat(64)]));
  const counts = Object.fromEntries(tableNames.map((table) => [table, 1]));
  const columnsByTable = Object.fromEntries(tableNames.map((table) => [table, ['id', 'payload']]));
  const sql = buildIntegrityAssertionSql({ phase: 'after', fingerprints, counts,
    autoIncrement: { fixture_table_00: 42 }, columnsByTable, maxFingerprintBytes: 1024 });
  const block = sql.split('BEGIN NOT ATOMIC\n')[1].split('\nEND$$')[0];
  const resultSelects = sql.split('\n').filter((line) => /^SELECT\s/.test(line));
  const aggregateSelect = sql.slice(sql.lastIndexOf('\nSELECT '));
  assert.match(sql, /^-- Read-only after-image assertion/m);
  assert.match(sql, /USE `u364362094_arkteisiis`;/);
  assert.match(block, /Assertion row count mismatch: fixture_table_00/);
  assert.match(block, /Assertion fingerprint mismatch: fixture_table_43/);
  assert.match(block, /Assertion AUTO_INCREMENT mismatch: fixture_table_00/);
  assert.match(block, /START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY/);
  assert.match(block, /ROLLBACK;[\s\S]*RESIGNAL;/);
  assert.match(block, /SET SESSION group_concat_max_len = originalGroupConcatLen;/);
  assert.match(block, /SET SESSION time_zone = originalTimeZone;/);
  assert.equal(resultSelects.length, 1, 'only one short aggregate query returns a result grid');
  assert.match(aggregateSelect, /active_extra_users/);
  assert.throws(() => buildIntegrityAssertionSql({ phase: 'before', fingerprints: { one: 'a'.repeat(64) },
    counts: { one: 1 }, autoIncrement: {}, columnsByTable: { one: ['id'] }, maxFingerprintBytes: 1024 }), RepairError);
});

test('the approved fee exemption reconciles gross scheduled charges to the finance-service balance', () => {
  assert.equal(subtractMoney('5325.00', '1200.00'), '4125.00');
  assert.throws(() => subtractMoney('100.00', '100.01'), RepairError);
});

test('user compare-and-swap predicates do not place password hashes in repair SQL', () => {
  assert.deepEqual(deltaPredicateColumns('users', ['id', 'email', 'is_active', 'password_hash', 'updated_at']),
    ['id', 'is_active', 'updated_at']);
  assert.deepEqual(deltaPredicateColumns('students', ['id', 'first_name', 'updated_at']), ['id', 'first_name', 'updated_at']);
  assert.throws(() => deltaPredicateColumns('users', ['id', 'password_hash']), RepairError);
});
