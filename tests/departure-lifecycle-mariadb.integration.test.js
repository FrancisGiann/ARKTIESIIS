'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { PoolFacade, Transaction, sql } = require('../src/config/database');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');
const { createDepartureLifecycleService } = require('../src/services/departureLifecycleService');
const { createAnnualFinanceCasesService } = require('../src/services/annualFinanceCasesService');

const socketPath = process.env.SCHEDULED_DEPARTURE_TEST_SOCKET;
const YEAR = '2026-2027';

function uuid() { return crypto.randomUUID(); }
function fingerprint() { return crypto.randomBytes(32).toString('hex'); }

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

test('scheduled departures apply atomically at Manila date, preserve Finance history, and retain legacy states', {
  skip: !socketPath && 'Set SCHEDULED_DEPARTURE_TEST_SOCKET to a disposable local MariaDB socket.'
}, async () => {
  const databaseName = `arktiesiis_scheduled_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const user = process.env.SCHEDULED_DEPARTURE_TEST_USER || 'root';
  const password = process.env.SCHEDULED_DEPARTURE_TEST_PASSWORD ?? '';
  const adminPool = mysql.createPool({ socketPath, user, password, connectionLimit: 2 });
  let rawPool;
  try {
    await adminPool.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    rawPool = mysql.createPool({ socketPath, user, password, database: databaseName, connectionLimit: 8,
      supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false });

    const setup = await rawPool.getConnection();
    try {
      await applyStatements(setup, readSqlFile(path.join(__dirname, '../database/mariadb/schema.sql')));
      const migrations = readForwardMigrations();
      const scheduledMigration = migrations.find(({ version }) => version === 'v2.022');
      assert.ok(scheduledMigration, 'migration 022 is present in the forward-only sequence');
      for (const migration of migrations.filter(({ version }) => version !== 'v2.022')) {
        await applyStatements(setup, migration.statements);
        await setup.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
      }

      const [users] = await setup.execute(`INSERT INTO users (email, password_hash, role, is_active)
        VALUES (?, 'integration-only', 'registrar', 1), (?, 'integration-only', 'finance', 1)`,
      [`registrar-${uuid()}@example.test`, `finance-${uuid()}@example.test`]);
      const registrarId = Number(users.insertId);
      const financeId = registrarId + 1;
      const [student] = await setup.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
        VALUES (?, '900000000001', 'Synthetic', 'Legacy')`, [`SYN-LEGACY-${uuid().slice(0, 8)}`]);
      const [annual] = await setup.execute(`INSERT INTO annual_enrollments
        (student_id, school_year, grade_level, voucher_code, intake_status, created_by, entry_term_number, intake_kind)
        VALUES (?, ?, 'Grade 11', 'PUB', 'enrolled', ?, 1, 'new')`, [Number(student.insertId), YEAR, registrarId]);
      const [termRows] = await setup.query(`INSERT INTO academic_terms (school_year, term)
        VALUES ('2026-2027', 'Term 1'), ('2026-2027', 'Term 2'), ('2026-2027', 'Term 3')`);
      const [terms] = await setup.execute('SELECT id, term FROM academic_terms WHERE school_year = ? ORDER BY id', [YEAR]);
      assert.equal(terms.length, 3);
      const [legacyEnrollment] = await setup.execute(`INSERT INTO enrollments
        (student_id, academic_term_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status)
        VALUES (?, ?, 'enrolled', ?, 1, 'applicable')`, [Number(student.insertId), Number(terms[0].id), Number(annual.insertId)]);
      const [legacyCase] = await setup.execute(`INSERT INTO finance_departure_cases
        (annual_enrollment_id, effective_enrollment_id, effective_date, departure_type, reason, recorded_by,
          idempotency_key, request_fingerprint)
        VALUES (?, ?, '2099-11-25', 'transferred', 'Synthetic historical case', ?, ?, ?)`,
      [Number(annual.insertId), Number(legacyEnrollment.insertId), registrarId, uuid(), fingerprint()]);
      await setup.execute(`INSERT INTO finance_departure_case_terms
        (departure_case_id, enrollment_id, academic_activity_review_required) VALUES (?, ?, 0)`,
      [Number(legacyCase.insertId), Number(legacyEnrollment.insertId)]);
      await applyStatements(setup, scheduledMigration.statements);
      await setup.execute('INSERT INTO schema_migrations (version) VALUES (?)', [scheduledMigration.version]);
    } finally { setup.release(); }

    const [legacy] = await rawPool.execute(`SELECT departure.application_status, enrollment.enrollment_status
      FROM finance_departure_cases AS departure
      INNER JOIN enrollments AS enrollment ON enrollment.id = departure.effective_enrollment_id
      WHERE departure.reason = 'Synthetic historical case'`);
    assert.deepEqual([legacy[0].application_status, legacy[0].enrollment_status], ['legacy_applied', 'enrolled'],
      'migration 022 preserves existing status and never infers or reverses a historical application');

    const [registrarRows] = await rawPool.execute("SELECT id FROM users WHERE role = 'registrar' ORDER BY id LIMIT 1");
    const [financeRows] = await rawPool.execute("SELECT id FROM users WHERE role = 'finance' ORDER BY id LIMIT 1");
    const registrarId = Number(registrarRows[0].id);
    const financeId = Number(financeRows[0].id);
    const [termRows] = await rawPool.execute('SELECT id, term FROM academic_terms WHERE school_year = ? ORDER BY id', [YEAR]);
    const termIds = termRows.map((row) => Number(row.id));
    const pool = new PoolFacade(rawPool);
    const getPool = async () => pool;
    let today = '2026-10-20';
    const annualService = createAnnualEnrollmentService({ getPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool),
      hashPassword: async () => 'integration-only', createPassword: () => 'integration-only',
      todayProvider: () => today });
    const lifecycle = createDepartureLifecycleService({ getPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool),
      todayProvider: () => today, batchSize: 1 });

    let studentSequence = 10;
    async function createAnnual(label, statuses = ['enrolled', 'pending_payment', 'pending_payment'], scopeStatuses = ['applicable', 'applicable', 'applicable'], intakeStatus = 'enrolled') {
      const sequence = String(studentSequence++).padStart(12, '0');
      const [studentResult] = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
        VALUES (?, ?, 'Synthetic', ?)`, [`SYN-${label}-${uuid().slice(0, 8)}`, sequence, label]);
      const studentId = Number(studentResult.insertId);
      const [annualResult] = await rawPool.execute(`INSERT INTO annual_enrollments
        (student_id, school_year, grade_level, voucher_code, intake_status, created_by, entry_term_number, intake_kind)
        VALUES (?, ?, 'Grade 11', 'PUB', ?, ?, 1, 'new')`, [studentId, YEAR, intakeStatus, registrarId]);
      const annualId = Number(annualResult.insertId);
      const enrollments = [];
      for (let index = 0; index < termIds.length; index += 1) {
        const [enrollment] = await rawPool.execute(`INSERT INTO enrollments
          (student_id, academic_term_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status)
          VALUES (?, ?, ?, ?, ?, ?)`, [studentId, termIds[index], statuses[index], annualId, index + 1, scopeStatuses[index]]);
        enrollments.push(Number(enrollment.insertId));
      }
      await rawPool.execute('INSERT INTO financial_accounts (student_id, balance) VALUES (?, 0.00)', [studentId]);
      return { studentId, annualId, enrollments };
    }
    async function schedule(record, effectiveTerm, effectiveDate, label) {
      return annualService.createDepartureCase(registrarId, record.annualId, record.enrollments[effectiveTerm - 1], {
        departureType: 'transferred', effectiveDate, reason: `Synthetic ${label} departure`, idempotencyKey: uuid()
      });
    }

    const inconsistent = await createAnnual('Identity');
    const [otherStudent] = await rawPool.execute(`INSERT INTO students (student_no, lrn, first_name, last_name)
      VALUES (?, '900000000099', 'Synthetic', 'Other')`, [`SYN-OTHER-${uuid().slice(0, 8)}`]);
    const corruptTarget = inconsistent.enrollments[1];
    await rawPool.execute('UPDATE enrollments SET student_id = ? WHERE id = ?', [Number(otherStudent.insertId), corruptTarget]);
    await assert.rejects(annualService.createDepartureCase(registrarId, inconsistent.annualId, corruptTarget, {
      departureType: 'transferred', effectiveDate: '2026-10-21', reason: 'Synthetic inconsistent identity', idempotencyKey: uuid()
    }), /does not match its annual student/i);
    const [identityCaseCount] = await rawPool.execute('SELECT COUNT(*) AS count FROM finance_departure_cases WHERE annual_enrollment_id = ?',
      [inconsistent.annualId]);
    const [identityPlacement] = await rawPool.execute('SELECT enrollment_status, student_id FROM enrollments WHERE id = ?', [corruptTarget]);
    assert.deepEqual([Number(identityCaseCount[0].count), identityPlacement[0].enrollment_status, Number(identityPlacement[0].student_id)],
      [0, 'pending_payment', Number(otherStudent.insertId)],
      'inconsistent student identity is rejected before case or placement writes');
    await rawPool.execute('UPDATE enrollments SET student_id = ? WHERE id = ?', [inconsistent.studentId, corruptTarget]);

    const closedAnnual = await createAnnual('Closed', ['enrolled', 'pending_payment', 'pending_payment']);
    await rawPool.execute("UPDATE annual_enrollments SET intake_status = 'cancelled' WHERE id = ?", [closedAnnual.annualId]);
    await assert.rejects(annualService.createDepartureCase(registrarId, closedAnnual.annualId, closedAnnual.enrollments[0], {
      departureType: 'transferred', effectiveDate: '2026-10-20', reason: 'Synthetic cancelled annual', idempotencyKey: uuid()
    }), /current annual enrollment/i);
    const [closedAnnualEvidence] = await rawPool.execute(`SELECT annual.intake_status, enrollment.enrollment_status,
        (SELECT COUNT(*) FROM finance_departure_cases AS departure WHERE departure.annual_enrollment_id = annual.id) AS case_count
      FROM annual_enrollments AS annual INNER JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
      WHERE annual.id = ? AND enrollment.id = ?`, [closedAnnual.annualId, closedAnnual.enrollments[0]]);
    assert.deepEqual([closedAnnualEvidence[0].intake_status, closedAnnualEvidence[0].enrollment_status, Number(closedAnnualEvidence[0].case_count)],
      ['cancelled', 'enrolled', 0], 'cancelled annuals reject departure creation before status or case writes');

    const future = await createAnnual('Future');
    await rawPool.execute('UPDATE annual_enrollments SET enrollment_start_date = ? WHERE id = ?', ['2026-08-01', future.annualId]);
    await assert.rejects(annualService.previewDeparture(registrarId, future.annualId, future.enrollments[1], {
      departureType: 'transferred', effectiveDate: '2026-07-01', reason: 'Synthetic before-start preview'
    }), /cannot precede the enrollment start date/i);
    const futurePreview = await annualService.previewDeparture(registrarId, future.annualId, future.enrollments[1], {
      departureType: 'transferred', effectiveDate: '2026-10-21', reason: 'Synthetic future preview'
    });
    assert.deepEqual(futurePreview.map((row) => Number(row.enrollment_id)), future.enrollments.slice(1),
      'the production preview validates the date and returns only the applicable selected-and-later placements');
    const futureCase = await schedule(future, 2, '2026-10-21', 'future');
    assert.equal(futureCase.applicationStatus, 'scheduled');
    await assert.rejects(rawPool.execute(`INSERT INTO finance_departure_application_events
      (departure_case_id, event_type, source, actor_id, actor_role, details_json)
      VALUES (?, 'scheduled', 'registrar', ?, NULL, '{}')`, [futureCase.departureCaseId, registrarId]),
    /CONSTRAINT|check/i, 'Registrar evidence cannot omit its recorded role');
    let [futureStatuses] = await rawPool.execute('SELECT enrollment_status FROM enrollments WHERE id IN (?, ?) ORDER BY annual_term_number',
      [future.enrollments[1], future.enrollments[2]]);
    assert.deepEqual(futureStatuses.map((row) => row.enrollment_status), ['pending_payment', 'pending_payment']);
    assert.equal((await lifecycle.processDueDepartures({ drain: true })).applied, 0,
      'a date one Manila calendar day ahead is not due');

    const preExcluded = await createAnnual('PreExcluded', undefined, ['applicable', 'applicable', 'not_applicable']);
    const preExcludedCase = await schedule(preExcluded, 2, '2026-10-21', 'pre-excluded');
    const [preExcludedTerms] = await rawPool.execute('SELECT COUNT(*) AS count FROM finance_departure_case_terms WHERE departure_case_id = ?',
      [preExcludedCase.departureCaseId]);
    assert.equal(Number(preExcludedTerms[0].count), 1,
      'a later placement already out of scope at scheduling is excluded from the captured applicable set');

    const past = await createAnnual('Past');
    const todayCase = await createAnnual('Today');
    const pastDeparture = await schedule(past, 2, '2026-10-19', 'past');
    const todayDeparture = await schedule(todayCase, 2, '2026-10-20', 'today');
    assert.deepEqual([pastDeparture.applicationStatus, todayDeparture.applicationStatus], ['applied', 'applied'],
      'past and current Manila calendar dates apply immediately');
    const [immediateStatuses] = await rawPool.execute(`SELECT enrollment_status FROM enrollments
      WHERE id IN (?, ?, ?, ?) ORDER BY id`, [past.enrollments[1], past.enrollments[2], todayCase.enrollments[1], todayCase.enrollments[2]]);
    assert.deepEqual(immediateStatuses.map((row) => row.enrollment_status), ['transferred', 'transferred', 'transferred', 'transferred']);

    const financeCases = createAnnualFinanceCasesService({ getPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool) });
    const [scheduleResult] = await rawPool.execute(`INSERT INTO finance_schedules
      (school_year, grade_level, voucher_code, version_no, idempotency_key, request_fingerprint, created_by)
      VALUES (?, 'Grade 11', 'PUB', 1, ?, ?, ?)`, [YEAR, uuid(), fingerprint(), financeId]);
    const [lineResult] = await rawPool.execute(`INSERT INTO finance_schedule_lines
      (schedule_id, term_number, fee_category, line_name, installment, amount)
      VALUES (?, 2, 'tuition', 'Tuition', 'Finals', 100.00)`, [Number(scheduleResult.insertId)]);
    const [assessmentResult] = await rawPool.execute(`INSERT INTO annual_assessments
      (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by,
        selection_json, idempotency_key, request_fingerprint)
      VALUES (?, ?, 1, 'PUB', ?, '{}', ?, ?)`,
    [future.annualId, Number(scheduleResult.insertId), financeId, uuid(), fingerprint()]);
    const [chargeResult] = await rawPool.execute(`INSERT INTO assessed_charges
      (assessment_id, annual_enrollment_id, enrollment_id, schedule_line_id, fee_category, line_name, installment,
        amount, gross_amount, waived_amount)
      VALUES (?, ?, ?, ?, 'tuition', 'Tuition', 'Finals', 100.00, 100.00, 0.00)`,
    [Number(assessmentResult.insertId), future.annualId, future.enrollments[1], Number(lineResult.insertId)]);
    const pendingCases = await financeCases.listPendingDepartureCases(financeId);
    assert.equal(pendingCases.find((row) => Number(row.departure_case_id) === Number(futureCase.departureCaseId))?.application_status,
      'scheduled', 'Finance can review a recorded future case before placement application');
    const reviewed = await financeCases.reviewDepartureCase(financeId, futureCase.departureCaseId, {
      cutoffInstallment: 'midterm', reason: 'Synthetic review while scheduled', idempotencyKey: uuid(),
      chargeReviews: [{ chargeId: String(chargeResult.insertId), decision: 'reduce', reductionAmount: '100.00', reason: 'Finals not payable' }]
    });
    assert.equal(reviewed.reviewed, true, 'the existing manual Finance review is available while placement status remains scheduled');
    [futureStatuses] = await rawPool.execute('SELECT enrollment_status FROM enrollments WHERE id IN (?, ?) ORDER BY annual_term_number',
      [future.enrollments[1], future.enrollments[2]]);
    assert.deepEqual(futureStatuses.map((row) => row.enrollment_status), ['pending_payment', 'pending_payment']);

    const [subjectResult] = await rawPool.execute('INSERT INTO subjects (subject_code, subject_name) VALUES (?, ?)',
      [`SYN-${uuid().slice(0, 8)}`, 'Synthetic later assignment']);
    const [sectionResult] = await rawPool.execute('INSERT INTO sections (name, academic_term_id) VALUES (?, ?)',
      [`SYN-${uuid().slice(0, 6)}`, termIds[2]]);
    await rawPool.execute("UPDATE enrollments SET enrollment_status = 'enrolled', section_id = ? WHERE id = ?",
      [Number(sectionResult.insertId), future.enrollments[2]]);
    await rawPool.execute('INSERT INTO student_subjects (enrollment_id, subject_id) VALUES (?, ?)',
      [future.enrollments[2], Number(subjectResult.insertId)]);
    const [financeBefore] = await rawPool.execute(`SELECT CAST(account.balance AS CHAR) AS balance,
        CAST(charge.amount AS CHAR) AS charge_amount, COUNT(DISTINCT adjustment.id) AS adjustment_count,
        COUNT(DISTINCT review.id) AS cutoff_count, departure.finance_status
      FROM financial_accounts AS account
      INNER JOIN annual_enrollments AS annual ON annual.student_id = account.student_id
      INNER JOIN finance_departure_cases AS departure ON departure.annual_enrollment_id = annual.id
      INNER JOIN assessed_charges AS charge ON charge.annual_enrollment_id = annual.id
      LEFT JOIN finance_charge_adjustments AS adjustment ON adjustment.departure_case_id = departure.id
      LEFT JOIN finance_departure_cutoff_reviews AS review ON review.departure_case_id = departure.id
      WHERE annual.id = ? GROUP BY account.id, charge.id, departure.id`, [future.annualId]);

    const [otherConflict, normalDue, archivedDue, cancelledDue, notApplicableDue] = await Promise.all([
      createAnnual('Changed', ['enrolled', 'enrolled', 'enrolled']),
      createAnnual('Concurrent', ['enrolled', 'enrolled', 'enrolled']),
      createAnnual('Archived', ['enrolled', 'enrolled', 'enrolled']),
      createAnnual('Cancelled', ['enrolled', 'enrolled', 'enrolled']),
      createAnnual('NoLongerApplicable', ['enrolled', 'enrolled', 'enrolled'])
    ]);
    const [changedCase, normalCase, archivedCase, cancelledCase, notApplicableCase] = await Promise.all([
      schedule(otherConflict, 2, '2026-10-21', 'changed'),
      schedule(normalDue, 2, '2026-10-21', 'concurrent'),
      schedule(archivedDue, 2, '2026-10-21', 'archived'),
      schedule(cancelledDue, 2, '2026-10-21', 'cancelled'),
      schedule(notApplicableDue, 2, '2026-10-21', 'no longer applicable')
    ]);
    await rawPool.execute("UPDATE students SET status = 'archived' WHERE id = ?", [archivedDue.studentId]);
    await rawPool.execute("UPDATE enrollments SET enrollment_status = 'transferred' WHERE id = ?", [otherConflict.enrollments[2]]);
    await rawPool.execute("UPDATE enrollments SET enrollment_status = 'cancelled' WHERE id = ?", [cancelledDue.enrollments[2]]);
    await rawPool.execute("UPDATE enrollments SET term_scope_status = 'not_applicable' WHERE id = ?", [notApplicableDue.enrollments[2]]);
    today = '2026-10-21';

    const lifecycleSecond = createDepartureLifecycleService({ getPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), todayProvider: () => today, batchSize: 1 });
    const [firstWorker, secondWorker] = await Promise.all([
      lifecycle.processDueDepartures({ drain: true }), lifecycleSecond.processDueDepartures({ drain: true })
    ]);
    assert.ok(firstWorker.batches + secondWorker.batches >= 1);
    const [applied] = await rawPool.execute('SELECT application_status FROM finance_departure_cases WHERE id = ?', [futureCase.departureCaseId]);
    assert.equal(applied[0].application_status, 'applied');
    const [appliedStatuses] = await rawPool.execute(`SELECT enrollment.enrollment_status, case_term.enrollment_status_at_application,
        case_term.academic_activity_review_required_at_application, case_term.applied_at
      FROM enrollments AS enrollment INNER JOIN finance_departure_case_terms AS case_term ON case_term.enrollment_id = enrollment.id
      WHERE case_term.departure_case_id = ? ORDER BY enrollment.annual_term_number`, [futureCase.departureCaseId]);
    assert.deepEqual(appliedStatuses.map((row) => [row.enrollment_status, row.enrollment_status_at_application]),
      [['transferred', 'pending_payment'], ['transferred', 'enrolled']]);
    assert.equal(Number(appliedStatuses[1].academic_activity_review_required_at_application), 1,
      'academic assignments added after scheduling are reflected in application review evidence');
    assert.ok(appliedStatuses.every((row) => row.applied_at));

    const [applicationEvents] = await rawPool.execute(`SELECT event_type, source, actor_id
      FROM finance_departure_application_events WHERE departure_case_id = ? ORDER BY id`, [futureCase.departureCaseId]);
    assert.deepEqual(applicationEvents.map((row) => [row.event_type, row.source, row.actor_id]),
      [['scheduled', 'registrar', registrarId], ['applied', 'system_scheduler', null]],
      'system application evidence is separate and does not impersonate the original Registrar');
    const [financeAfter] = await rawPool.execute(`SELECT CAST(account.balance AS CHAR) AS balance,
        CAST(charge.amount AS CHAR) AS charge_amount, COUNT(DISTINCT adjustment.id) AS adjustment_count,
        COUNT(DISTINCT review.id) AS cutoff_count, departure.finance_status
      FROM financial_accounts AS account
      INNER JOIN annual_enrollments AS annual ON annual.student_id = account.student_id
      INNER JOIN finance_departure_cases AS departure ON departure.annual_enrollment_id = annual.id
      INNER JOIN assessed_charges AS charge ON charge.annual_enrollment_id = annual.id
      LEFT JOIN finance_charge_adjustments AS adjustment ON adjustment.departure_case_id = departure.id
      LEFT JOIN finance_departure_cutoff_reviews AS review ON review.departure_case_id = departure.id
      WHERE annual.id = ? GROUP BY account.id, charge.id, departure.id`, [future.annualId]);
    assert.deepEqual(financeAfter[0], financeBefore[0], 'the scheduler makes no Finance writes');

    const [conflicted] = await rawPool.execute('SELECT id, application_status, application_review_reason FROM finance_departure_cases WHERE id IN (?, ?, ?, ?, ?) ORDER BY id',
      [changedCase.departureCaseId, normalCase.departureCaseId, archivedCase.departureCaseId, cancelledCase.departureCaseId, notApplicableCase.departureCaseId]);
    const byId = new Map(conflicted.map((row) => [Number(row.id), row]));
    assert.deepEqual([byId.get(Number(changedCase.departureCaseId)).application_status,
      byId.get(Number(changedCase.departureCaseId)).application_review_reason], ['needs_review', 'target_placement_departed']);
    assert.equal(byId.get(Number(archivedCase.departureCaseId)).application_review_reason, 'student_archived');
    assert.equal(byId.get(Number(cancelledCase.departureCaseId)).application_review_reason, 'target_placement_cancelled');
    assert.equal(byId.get(Number(notApplicableCase.departureCaseId)).application_review_reason, 'target_placement_not_applicable');
    assert.equal(byId.get(Number(normalCase.departureCaseId)).application_status, 'applied',
      'one conflict does not prevent later due cases from being processed');
    const [normalEvents] = await rawPool.execute("SELECT COUNT(*) AS count FROM finance_departure_application_events WHERE departure_case_id = ? AND event_type = 'applied'",
      [normalCase.departureCaseId]);
    assert.equal(Number(normalEvents[0].count), 1, 'concurrent workers create exactly one application event');
    const [normalStatuses] = await rawPool.execute('SELECT enrollment_status FROM enrollments WHERE id IN (?, ?) ORDER BY annual_term_number',
      [normalDue.enrollments[1], normalDue.enrollments[2]]);
    assert.deepEqual(normalStatuses.map((row) => row.enrollment_status), ['transferred', 'transferred']);
    const [notApplicableStatuses] = await rawPool.execute('SELECT id, enrollment_status FROM enrollments WHERE id IN (?, ?) ORDER BY annual_term_number',
      [notApplicableDue.enrollments[1], notApplicableDue.enrollments[2]]);
    assert.deepEqual(notApplicableStatuses.map((row) => row.enrollment_status), ['enrolled', 'enrolled'],
      'a captured placement that becomes inapplicable causes review with no status changes');
    const [preExcludedStatuses] = await rawPool.execute('SELECT id, enrollment_status FROM enrollments WHERE id IN (?, ?) ORDER BY annual_term_number',
      [preExcluded.enrollments[1], preExcluded.enrollments[2]]);
    assert.deepEqual(preExcludedStatuses.map((row) => row.enrollment_status), ['transferred', 'pending_payment'],
      'the saved applicable subset applies while the previously excluded term is preserved');
  } finally {
    if (rawPool) await rawPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await adminPool.end();
  }
});
