const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveSchoolEmails } = require('../scripts/seed-school');
const {
  FEE_AMOUNTS_CENTS,
  TERM_NAMES,
  buildThreeTermPlan,
  decimalToCents,
  timeValue,
  insertRows,
  mapSectionIds,
  assertDevelopmentTarget,
  parseOptions,
  ThreeTermSeedError
} = require('../scripts/seed-school-three-term');

function plan() {
  return buildThreeTermPlan(deriveSchoolEmails('demo@gmail.com'));
}

test('three-term seed builds a configured Grade 11/12 dataset with pending and departure cases', () => {
  const value = plan();
  assert.deepEqual(value.terms.map((term) => [term.termNumber, term.term]), [[1, 'Term 1'], [2, 'Term 2'], [3, 'Term 3']]);
  assert.equal(value.counts.students, 320);
  assert.equal(value.counts.sections, 48);
  assert.equal(value.counts.teacherAssignments, 336);
  assert.equal(value.counts.classSchedules, 336);
  assert.equal(value.counts.assessments, 312);
  assert.equal(value.counts.registrarConfirmations, 312);
  assert.equal(value.counts.pendingActivation, 8);
  assert.equal(value.counts.futurePendingActivations, 10);
  assert.equal(value.counts.departureCases, 20);
  assert.equal(value.counts.financeScheduleLines, 90);
  assert.equal(value.counts.schoolApprovedRates, false);
  assert.equal(value.counts.fictionalFeeRates, true);
  assert.deepEqual(new Set(value.students.map((student) => student.gradeLevel)), new Set(['Grade 11', 'Grade 12']));
  assert.equal(value.students.find((student) => student.ordinal === 45).departure.type, 'dropped');
  assert.equal(value.students.find((student) => student.ordinal === 65).departure.type, 'transferred');
  assert.equal(value.students.find((student) => student.ordinal === 105).futurePendingTermNumber, 2);
  for (const gradeLevel of ['Grade 11', 'Grade 12']) for (const voucherCode of ['PUB', 'ESC', 'NV']) {
    for (const termNumber of [1, 2, 3]) {
      const tuition = value.scheduleRows.filter((line) => line.scheduleKey === `${gradeLevel}:${voucherCode}`
        && line.termNumber === termNumber && line.feeCategory === 'tuition');
      assert.deepEqual(tuition.map((line) => line.installment), ['DP', 'Prelim', 'Midterm', 'Finals']);
      assert.equal(tuition[0].lineName, 'Tuition');
      assert.deepEqual(tuition.slice(1).map((line) => line.amount), ['0.00', '0.00', '0.00']);
    }
  }
});

test('fictional schedule amounts preserve PUB ≤ ESC ≤ NV and exact-cent arithmetic', () => {
  for (const grade of ['Grade 11', 'Grade 12']) {
    for (let termIndex = 0; termIndex < TERM_NAMES.length; termIndex += 1) {
      assert.ok(FEE_AMOUNTS_CENTS[grade].PUB[termIndex] <= FEE_AMOUNTS_CENTS[grade].ESC[termIndex]);
      assert.ok(FEE_AMOUNTS_CENTS[grade].ESC[termIndex] <= FEE_AMOUNTS_CENTS[grade].NV[termIndex]);
    }
  }
  assert.equal(decimalToCents('123.40'), 12340n);
  assert.equal(decimalToCents('0.5'), 50n);
  assert.equal(decimalToCents('-1.05'), -105n);
  assert.throws(() => decimalToCents('1.005'), ThreeTermSeedError);
  assert.equal(timeValue('08:15').toISOString(), '1970-01-01T08:15:00.000Z');
  assert.throws(() => timeValue('25:00'), ThreeTermSeedError);
});

test('payment examples exercise partial, settled, credit, reversal, waiver, adjustment, and term-3 prepayment cases', () => {
  const value = plan();
  const modes = new Set(value.paymentActions.map((action) => action.mode));
  for (const mode of ['settled', 'partial', 'credit', 'reversed', 'future-prepay']) assert.ok(modes.has(mode));
  assert.ok(value.paymentActions.some((action) => {
    if (action.mode !== 'partial') return false;
    const student = value.students.find((row) => row.key === action.studentKey);
    const expectedTermTotal = value.scheduleRows.filter((line) => line.scheduleKey === `${student.gradeLevel}:${student.voucherCode}`
      && line.termNumber === action.termNumber).reduce((sum, line) => sum + decimalToCents(line.amount), 0n);
    return action.allocations.reduce((sum, row) => sum + decimalToCents(row.amount), 0n) < expectedTermTotal;
  }));
  assert.ok(value.paymentActions.some((action) => action.mode === 'credit'
    && action.allocations.reduce((sum, row) => sum + decimalToCents(row.amount), 0n) < decimalToCents(action.amount)));
  assert.ok(value.paymentActions.some((action) => action.mode === 'future-prepay' && action.termNumber === 3
    && action.paymentDate < '2027-01-01'));
  assert.ok(value.paymentActions.some((action) => action.mode === 'reversed'));
  assert.ok(value.students.some((student) => student.waiverTermNumber));
  assert.ok(value.students.some((student) => student.adjustmentTermNumber));
  assert.ok(value.counts.futurePrepayments > 0);
});

test('seed target guard permits only local development V2 or a named rehearsal database', () => {
  const local = { nodeEnv: 'development', database: { server: '127.0.0.1', database: 'ARKTIESIIS_V2' } };
  assert.doesNotThrow(() => assertDevelopmentTarget(local));
  assert.doesNotThrow(() => assertDevelopmentTarget({ ...local,
    database: { ...local.database, database: 'ARKTIESIIS_V2_REHEARSAL_20261001_123456_a1b2c3' } }));
  assert.throws(() => assertDevelopmentTarget({ ...local,
    database: { ...local.database, server: '10.0.0.2' } }), ThreeTermSeedError);
  assert.throws(() => assertDevelopmentTarget({ ...local,
    database: { ...local.database, database: 'ARKTIESIIS' } }), ThreeTermSeedError);
  assert.throws(() => parseOptions(['--apply'], 'production'), ThreeTermSeedError);
});

test('student inserts read back trigger-safe identifiers by parameterized student number', async () => {
  const statements = [];
  const transaction = {
    request() {
      const parameters = {};
      return {
        input(name, _type, value) { parameters[name] = value; return this; },
        async query(statement) {
          statements.push({ statement, parameters });
          return { recordset: [{ id: 7, key0: 'SHS-2026-0001' }] };
        }
      };
    }
  };
  const rows = await insertRows({ transaction, table: 'students', columns: [
    { name: 'student_no', type: 'nvarchar:50' }, { name: 'lrn', type: 'nvarchar:12' }
  ], rows: [{ student_no: 'SHS-2026-0001', lrn: '123456789012' }], keyColumns: ['student_no'] });
  assert.deepEqual(rows, [{ id: 7, key0: 'SHS-2026-0001' }]);
  assert.doesNotMatch(statements[0].statement, /OUTPUT/i);
  assert.match(statements[0].statement, /WHERE \[student_no\] IN \(@r0_0\)/);
  assert.equal(statements[0].parameters.r0_0, 'SHS-2026-0001');
});

test('section identifiers use configured term number and section name', () => {
  const ids = mapSectionIds([
    { id: 81, key0: 'Grade 11 STEM A', key1: 7 },
    { id: 82, key0: 'Grade 11 STEM A', key1: 8 }
  ], new Map([['Term 1', 7], ['Term 2', 8], ['Term 3', 9]]));
  assert.equal(ids.get('1:Grade 11 STEM A'), 81);
  assert.equal(ids.get('2:Grade 11 STEM A'), 82);
});
