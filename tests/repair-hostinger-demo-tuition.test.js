'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REPAIR_MARKER,
  splitTuitionCents,
  buildTuitionRepairPlan,
  parseOptions,
  runRepair,
  TuitionRepairError
} = require('../scripts/repair-hostinger-demo-tuition');
const { HOSTINGER_SEED_MARKER, EXPANSION_MARKER, REQUIRED_VERSIONS, REQUIRED_OBJECTS } = require('../scripts/expand-hostinger-demo');

const databaseName = 'u364362094_arkteisiis';
const configuration = {
  nodeEnv: 'production',
  devPasswordOnlyLogin: false,
  database: { host: 'db.hostinger.example', database: databaseName, user: 'demo_user', password: 'not-a-real-password' }
};

function options(mode = 'dry-run') {
  return parseOptions([
    `--${mode}`, '--target-database', databaseName, '--confirm-database', databaseName,
    '--confirm-seed-marker', HOSTINGER_SEED_MARKER, '--confirm-expansion-marker', EXPANSION_MARKER,
    ...(mode === 'apply' ? ['--confirm-repair-marker', REPAIR_MARKER] : [])
  ], databaseName);
}

function lineRows(lines, scheduleId) {
  return lines.map((line, index) => ({
    schedule_id: scheduleId, term_number: line.termNumber, fee_category: line.feeCategory,
    line_name: line.lineName, installment: line.installment, amount: line.amount,
    is_optional: 0, id: index + 1
  }));
}

function previewConnection() {
  const plan = buildTuitionRepairPlan();
  const scheduleRows = plan.map((context, index) => ({
    id: 100 + index, school_year: context.schoolYear, grade_level: context.gradeLevel,
    voucher_code: context.voucherCode, version_no: 1, status: 'active',
    idempotency_key: context.sourceScheduleKey, request_fingerprint: context.sourceFingerprint, created_by: 14
  }));
  const state = {
    scheduleRows,
    linesById: new Map(scheduleRows.map((schedule, index) => [schedule.id, lineRows(plan[index].sourceLines, schedule.id)])),
    nextScheduleId: 200,
    seedAction: 'admin.demo_seeded',
    expansionAction: 'database_admin.demo_data_expanded',
    chargeGrossAmount: '100.00'
  };
  const statements = [];
  const connection = {
    async execute(statement, values = []) {
      statements.push({ statement, values });
      assert.match(statement.trim(), /^SELECT\b/i, 'the repair database connection must use read-only queries and its scoped advisory lock');
      if (statement.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      if (statement.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
      if (statement === 'SELECT version FROM schema_migrations ORDER BY version') {
        return [REQUIRED_VERSIONS.map((version) => ({ version })), []];
      }
      if (statement.includes('information_schema.tables')) return [REQUIRED_OBJECTS.map((table_name) => ({ table_name })), []];
      if (statement.includes('FROM audit_logs AS marker')) {
        return [[
          { entity_type: 'school_demo_seed', entity_id: HOSTINGER_SEED_MARKER, action: state.seedAction, details_json: '{}', role: 'database_admin' },
          { entity_type: 'school_demo_expansion', entity_id: EXPANSION_MARKER, action: state.expansionAction,
            details_json: JSON.stringify({ counts: { financeSchedules: 6, financeScheduleLines: 36, annualAssessments: 79, registrarConfirmations: 0 } }), role: 'database_admin' }
        ], []];
      }
      if (statement.includes('FROM staff_profiles AS profile')) return [[{ id: 14 }], []];
      if (statement.includes('FROM finance_schedules')) return [state.scheduleRows, []];
      if (statement.includes('FROM finance_schedule_lines')) {
        return [[...state.linesById.values()].flat(), []];
      }
      if (statement.includes('FROM annual_assessments')) {
        return [[{
          id: 501, annual_enrollment_id: 601, schedule_id: 100, schedule_version: 1,
          voucher_code_snapshot: 'PUB', assessed_at: '2026-09-01 09:00:00', selection_json: '{"optionalLineIds":[]}',
          idempotency_key: '41111111-1111-4111-8111-111111111114', request_fingerprint: 'd'.repeat(64)
        }], []];
      }
      if (statement.includes('FROM assessed_charges AS charge')) {
        return [[{
          id: 701, assessment_id: 501, annual_enrollment_id: 601, annual_term_number: 1,
          schedule_line_id: 1, fee_category: 'tuition', line_name: 'Tuition', installment: 'Term 1',
          amount: '100.00', gross_amount: state.chargeGrossAmount, waived_amount: '0.00', is_manual: 0, reason_sha256: 'e'.repeat(64),
          idempotency_key: null, request_fingerprint: null, created_at: '2026-09-01 09:00:00'
        }], []];
      }
      if (statement.includes('FROM annual_enrollments AS annual')) {
        return [[{ annual_count: 1, unassessed_count: 0, saved_assessment_count: 1, saved_unconfirmed_count: 1,
          confirmed_count: 0, source_snapshot_count: 1, other_snapshot_count: 0 }], []];
      }
      throw new Error(`Unexpected query: ${statement}`);
    },
    release() {}
  };
  return { connection, statements, state, plan };
}

function insertRepairState(state, context) {
  const original = state.scheduleRows.find((row) => row.idempotency_key === context.sourceScheduleKey);
  original.status = 'retired';
  const schedule = {
    id: state.nextScheduleId++, school_year: context.schoolYear, grade_level: context.gradeLevel,
    voucher_code: context.voucherCode, version_no: 2, status: 'active', idempotency_key: context.repairKey,
    request_fingerprint: context.repairFingerprint, created_by: 14
  };
  state.scheduleRows.push(schedule);
  state.linesById.set(schedule.id, context.lines.map((line, index) => ({
    schedule_id: schedule.id, term_number: line.termNumber, fee_category: line.category,
    line_name: line.lineName, installment: line.installment, amount: line.amount,
    is_optional: line.isOptional ? 1 : 0, id: index + 1
  })));
}

function fakeFinance(state, { failAtCall = null, changeGrossAmountAtCall = null } = {}) {
  const calls = [];
  return {
    calls,
    service: {
      async createSchedule(actorId, input) {
        calls.push({ actorId, input });
        if (failAtCall === calls.length) throw new Error('synthetic database failure');
        if (changeGrossAmountAtCall === calls.length) state.chargeGrossAmount = '101.00';
        const context = buildTuitionRepairPlan().find((item) => item.gradeLevel === input.gradeLevel && item.voucherCode === input.voucherCode);
        assert.ok(context);
        assert.deepEqual(input.expectedPreviousSchedule, { scheduleId: Number(state.scheduleRows.find((row) => row.idempotency_key === context.sourceScheduleKey).id), versionNo: 1 });
        assert.equal(input.idempotencyKey, context.repairKey);
        const active = state.scheduleRows.find((row) => row.school_year === input.schoolYear
          && row.grade_level === input.gradeLevel && row.voucher_code === input.voucherCode && row.status === 'active');
        assert.equal(Number(active?.id), input.expectedPreviousSchedule.scheduleId, 'the predecessor guard runs before schedule replacement');
        insertRepairState(state, context);
        return { scheduleId: state.nextScheduleId - 1, versionNo: 2 };
      }
    }
  };
}

test('demo tuition repair splits cents deterministically and preserves every term total', () => {
  assert.deepEqual(splitTuitionCents(101n), [26n, 25n, 25n, 25n]);
  assert.deepEqual(splitTuitionCents(3n), [1n, 1n, 1n, 0n]);
  assert.deepEqual(splitTuitionCents(0n), [0n, 0n, 0n, 0n]);
  assert.throws(() => splitTuitionCents(-1n), TuitionRepairError);

  const plan = buildTuitionRepairPlan();
  assert.equal(plan.length, 6);
  for (const context of plan) {
    for (const termNumber of [1, 2, 3]) {
      const source = context.sourceLines.filter((line) => line.termNumber === termNumber);
      const result = context.lines.filter((line) => line.termNumber === termNumber);
      const sourceTuition = source.filter((line) => line.feeCategory === 'tuition')
        .reduce((sum, line) => sum + BigInt(Math.round(Number(line.amount) * 100)), 0n);
      const resultTuition = result.filter((line) => line.category === 'tuition');
      assert.deepEqual(resultTuition.map((line) => line.installment), ['DP', 'Prelim', 'Midterm', 'Finals']);
      assert.equal(resultTuition.reduce((sum, line) => sum + BigInt(Math.round(Number(line.amount) * 100)), 0n), sourceTuition);
      assert.deepEqual(result.filter((line) => line.category !== 'tuition').map((line) => [line.category, line.lineName, line.installment, line.amount]),
        source.filter((line) => line.feeCategory !== 'tuition').map((line) => [line.feeCategory, line.lineName, line.installment, line.amount]));
    }
  }
});

test('repair dry-run checks owned sources, previews all six contexts, and performs only SELECTs', async () => {
  const fake = previewConnection();
  const log = [];
  let serviceCalls = 0;
  const report = await runRepair({
    options: options(), configuration,
    getDatabasePool: async () => ({ source: { getConnection: async () => fake.connection } }),
    closeDatabasePool: async () => {},
    createFinance: () => ({ createSchedule: async () => { serviceCalls += 1; } }),
    logger: { log: (value) => log.push(value) }
  });

  assert.equal(serviceCalls, 0);
  assert.equal(report.contexts.length, 6);
  assert.equal(fake.statements.every(({ statement }) => /^SELECT\b/i.test(statement.trim()) && !statement.includes('GET_LOCK')), true);
  assert.equal(log.length, 1);
  const parsed = JSON.parse(log[0]);
  assert.equal(parsed.status, 'preview');
  assert.equal(parsed.contexts.length, 6);
  assert.equal(parsed.contexts[0].impact.noSavedAssessment, 0);
  assert.equal(parsed.contexts[0].impact.savedButUnconfirmed, 1);
  assert.equal(parsed.contexts[0].impact.immutableSourceVersion1Snapshots, 1);
  assert.equal(parsed.sourceVersion1SnapshotProof.before.assessmentRows, 1);
  assert.equal(parsed.sourceVersion1SnapshotProof.before.chargeRows, 1);
  assert.equal(parsed.sourceVersion1SnapshotProof.before.grossCharges, '100.00');
  assert.equal(parsed.sourceVersion1SnapshotProof.unchanged, true);
  assert.match(parsed.sourceVersion1SnapshotProof.before.assessmentSnapshotSha256, /^[a-f0-9]{64}$/);
  assert.match(parsed.sourceVersion1SnapshotProof.before.savedChargeRowsSha256, /^[a-f0-9]{64}$/);
  assert.match(parsed.sourceVersion1SnapshotProof.before.combinedSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(log[0], /Learner|student_no|Synthetic/);
  for (const context of parsed.contexts) {
    assert.deepEqual(context.termsBefore.map(({ total }) => total), context.termsAfter.map(({ total }) => total));
    assert.deepEqual(context.termsBefore.map(({ other }) => other), context.termsAfter.map(({ other }) => other));
  }
});

test('repair apply creates six audited-service versions and exact replay makes no duplicate versions', async () => {
  const fake = previewConnection();
  const finance = fakeFinance(fake.state);
  const logs = [];
  const dependencies = {
    options: options('apply'), configuration,
    getDatabasePool: async () => ({ source: { getConnection: async () => fake.connection } }),
    closeDatabasePool: async () => {}, createFinance: () => finance.service,
    logger: { log: (value) => logs.push(JSON.parse(value)) }
  };

  const applied = await runRepair(dependencies);
  assert.equal(finance.calls.length, 6);
  assert.equal(applied.changedContexts.length, 6);
  assert.equal(logs[0].status, 'completed');
  assert.equal(logs[0].sourceVersion1SnapshotProof.unchanged, true);
  assert.deepEqual(logs[0].sourceVersion1SnapshotProof.before, logs[0].sourceVersion1SnapshotProof.after);
  assert.equal(logs[0].sourceVersion1SnapshotProof.before.grossCharges, '100.00');
  assert.equal(logs[0].sourceVersion1SnapshotProof.before.payableCharges, '100.00');
  assert.ok(fake.state.scheduleRows.every((row) => Number(row.version_no) < 2 || row.status === 'active'));
  for (const context of applied.contexts) {
    assert.equal(context.activeVersion, 2);
    assert.deepEqual(context.termsBefore.map(({ total }) => total), context.termsAfter.map(({ total }) => total));
  }

  const replayLogs = [];
  const replay = await runRepair({ ...dependencies, logger: { log: (value) => replayLogs.push(JSON.parse(value)) } });
  assert.equal(finance.calls.length, 6, 'exact replay recognizes all six active repaired versions');
  assert.equal(replay.changedContexts.length, 0);
  assert.equal(replayLogs[0].status, 'already-applied');
  assert.equal(fake.state.scheduleRows.length, 12);
});

test('partial repair can be previewed and resumed without duplicate versions', async () => {
  const fake = previewConnection();
  const interruptedFinance = fakeFinance(fake.state, { failAtCall: 3 });
  const dependencies = {
    options: options('apply'), configuration,
    getDatabasePool: async () => ({ source: { getConnection: async () => fake.connection } }),
    closeDatabasePool: async () => {}, createFinance: () => interruptedFinance.service,
    logger: { log() {} }
  };
  await assert.rejects(runRepair(dependencies), /stopped after 2 of 6 new contexts were verified/i);
  assert.equal(fake.state.scheduleRows.length, 8);

  const previewLogs = [];
  const preview = await runRepair({ ...dependencies, options: options(), createFinance: () => { assert.fail('dry-run must not create schedules'); },
    logger: { log: (value) => previewLogs.push(JSON.parse(value)) } });
  assert.equal(preview.contexts.filter((context) => context.state === 'repaired').length, 2);
  assert.equal(previewLogs[0].status, 'preview');

  const resumeFinance = fakeFinance(fake.state);
  const resumed = await runRepair({ ...dependencies, createFinance: () => resumeFinance.service, logger: { log() {} } });
  assert.equal(resumed.contexts.filter((context) => context.state === 'repaired').length, 6);
  assert.equal(resumeFinance.calls.length, 4);
  assert.equal(fake.state.scheduleRows.length, 12);
});

test('repair digest detects a gross_amount-only change to a saved charge row', async () => {
  const fake = previewConnection();
  const finance = fakeFinance(fake.state, { changeGrossAmountAtCall: 1 });
  let logCount = 0;
  await assert.rejects(runRepair({
    options: options('apply'), configuration,
    getDatabasePool: async () => ({ source: { getConnection: async () => fake.connection } }),
    closeDatabasePool: async () => {}, createFinance: () => finance.service, logger: { log() { logCount += 1; } }
  }), /saved charge changed during repair after 6 of 6 schedule contexts were verified/i);
  assert.equal(logCount, 0, 'a failed snapshot digest check never reports a complete success');
  assert.equal(fake.state.chargeGrossAmount, '101.00');
});

test('repair refuses changed source markers or lines and any finance-created latest version', async () => {
  for (const conflict of ['marker-action', 'original-line', 'custom-version']) {
    const fake = previewConnection();
    if (conflict === 'marker-action') {
      fake.state.expansionAction = 'database_admin.other_action';
    } else if (conflict === 'original-line') {
      const original = fake.state.scheduleRows[0];
      fake.state.linesById.get(original.id)[0].amount = '9999.00';
    } else {
      const original = fake.state.scheduleRows[0];
      original.status = 'retired';
      fake.state.scheduleRows.push({ ...original, id: fake.state.nextScheduleId++, version_no: 2,
        status: 'active', idempotency_key: 'custom-finance-version-2' });
    }
    let serviceCalls = 0;
    await assert.rejects(runRepair({
      options: options(), configuration,
      getDatabasePool: async () => ({ source: { getConnection: async () => fake.connection } }),
      closeDatabasePool: async () => {}, createFinance: () => ({ createSchedule: async () => { serviceCalls += 1; } }), logger: { log() {} }
    }), conflict === 'marker-action' ? /seed and expansion markers/ : conflict === 'original-line' ? /ownership or line check/ : /newer or unowned/);
    assert.equal(serviceCalls, 0);
  }
});

test('repair CLI requires exact production database and marker confirmations', () => {
  assert.equal(options('apply').repairMarker, REPAIR_MARKER);
  assert.throws(() => parseOptions(['--dry-run', '--target-database', databaseName, '--confirm-database', databaseName,
    '--confirm-seed-marker', HOSTINGER_SEED_MARKER, '--confirm-expansion-marker', 'unowned-marker'], databaseName), /seed and expansion markers/);
  assert.throws(() => parseOptions(['--apply', '--target-database', databaseName, '--confirm-database', databaseName,
    '--confirm-seed-marker', HOSTINGER_SEED_MARKER, '--confirm-expansion-marker', EXPANSION_MARKER], databaseName), /acknowledgement/);
});
