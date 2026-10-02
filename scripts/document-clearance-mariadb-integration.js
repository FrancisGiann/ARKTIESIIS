'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { PoolFacade, Transaction, sql } = require('../src/config/database');
const { createFinanceDebtRevisionService } = require('../src/services/financeDebtRevisionService');
const { createFinanceService } = require('../src/services/financeService');
const { createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { createStudentDocumentRequestService } = require('../src/services/studentDocumentRequestService');
const { createStudentDocumentFinanceClearanceService } = require('../src/services/studentDocumentFinanceClearanceService');

const DATABASE_NAME = 'document_clearance_test';
const socketPath = process.env.DOCUMENT_CLEARANCE_TEST_SOCKET;

function uuid() { return crypto.randomUUID(); }

function buildPool() {
  if (!socketPath || !path.isAbsolute(socketPath)) {
    throw new Error('Set DOCUMENT_CLEARANCE_TEST_SOCKET to a disposable local MariaDB socket under /tmp.');
  }
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!path.resolve(socketPath).startsWith(tempRoot)) {
    throw new Error('The MariaDB integration socket must be inside the system temporary directory.');
  }
  const rawPool = mysql.createPool({
    socketPath,
    user: 'root',
    password: '',
    database: DATABASE_NAME,
    waitForConnections: true,
    connectionLimit: 8,
    queueLimit: 0,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'],
    multipleStatements: false
  });
  return { rawPool, pool: new PoolFacade(rawPool) };
}

async function execute(rawPool, statement, values = []) {
  const [result] = await rawPool.execute(statement, values);
  return result;
}

async function insertStaff(rawPool, role, token) {
  const result = await execute(rawPool,
    'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
    [`document-clearance-${role}-${token}@integration.invalid`, 'integration-only-not-a-login-hash', role]);
  const userId = Number(result.insertId);
  await execute(rawPool,
    'INSERT INTO staff_profiles (user_id, first_name, last_name) VALUES (?, ?, ?)',
    [userId, role === 'finance' ? 'Fin' : 'Reg', 'Integration']);
  return userId;
}

async function insertStudent(rawPool, label, withAccountBalance = null) {
  const token = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const lrn = String(Math.floor(100000000000 + Math.random() * 899999999999));
  const result = await execute(rawPool,
    `INSERT INTO students (student_no, lrn, first_name, middle_name, last_name)
      VALUES (?, ?, ?, ?, ?)`,
    [`DC-${label}-${token}`, lrn, 'Casey', null, 'Integration']);
  const studentId = Number(result.insertId);
  if (withAccountBalance !== null) {
    await execute(rawPool, 'INSERT INTO financial_accounts (student_id, balance) VALUES (?, ?)', [studentId, withAccountBalance]);
  }
  return studentId;
}

async function insertAnnualYear(rawPool, { studentId, year, amount, actorId }) {
  const annual = await execute(rawPool,
    `INSERT INTO annual_enrollments (student_id, school_year, grade_level, intake_status, created_by)
      VALUES (?, ?, 'Grade 11', 'enrolled', ?)`, [studentId, year, actorId]);
  const annualId = Number(annual.insertId);
  const schedule = await execute(rawPool,
    `INSERT INTO finance_schedules (school_year, grade_level, voucher_code, version_no,
      idempotency_key, request_fingerprint, created_by)
      VALUES (?, 'Grade 11', 'PUB', 1, ?, ?, ?)`,
    [year, uuid(), crypto.createHash('sha256').update(`${year}:${studentId}`).digest('hex'), actorId]);
  const scheduleId = Number(schedule.insertId);
  const term = await execute(rawPool,
    'INSERT INTO academic_terms (school_year, term) VALUES (?, ?)', [year, `Clearance test ${year}`]);
  const enrollment = await execute(rawPool,
    `INSERT INTO enrollments (student_id, academic_term_id, enrollment_status)
      VALUES (?, ?, 'enrolled')`, [studentId, Number(term.insertId)]);
  const enrollmentId = Number(enrollment.insertId);
  const assessment = await execute(rawPool,
    `INSERT INTO annual_assessments (annual_enrollment_id, schedule_id, schedule_version,
      voucher_code_snapshot, assessed_by, selection_json, idempotency_key, request_fingerprint)
      VALUES (?, ?, 1, 'PUB', ?, '{}', ?, ?)`,
    [annualId, scheduleId, actorId, uuid(), crypto.createHash('sha256').update(`${year}:${studentId}:assessment`).digest('hex')]);
  const assessmentId = Number(assessment.insertId);
  const charge = await execute(rawPool,
    `INSERT INTO assessed_charges (assessment_id, annual_enrollment_id, enrollment_id,
      fee_category, line_name, installment, amount, gross_amount, waived_amount)
      VALUES (?, ?, ?, 'tuition', 'Integration annual tuition', 'Annual', ?, ?, 0)`,
    [assessmentId, annualId, enrollmentId, amount, amount]);
  return { annualEnrollmentId: annualId, enrollmentId, assessmentId, scheduleId, chargeId: Number(charge.insertId) };
}

async function createDocumentRequest(requests, registrarId, studentId, documentName = 'PSA birth certificate') {
  const idempotencyKey = uuid();
  const payload = {
    documentType: 'PSA', documentName, requestedOn: '2026-01-15',
    reference: `REF-${uuid().slice(0, 8)}`, idempotencyKey
  };
  const first = await requests.createRequest(registrarId, studentId, payload);
  const replay = await requests.createRequest(registrarId, studentId, payload);
  assert.equal(first.requestId, replay.requestId);
  assert.equal(replay.replayed, true);
  return first.requestId;
}

async function approve(clearance, financeId, requestId, snapshot, { reason, arrangement, key = uuid() } = {}) {
  return clearance.decideClearance(financeId, requestId, {
    decision: 'approve',
    idempotencyKey: key,
    expectedRevision: snapshot.debtIncreaseRevision,
    expectedOutstanding: snapshot.outstanding,
    ledgerReviewConfirmed: 'on',
    reason,
    paymentArrangement: arrangement
  });
}

async function expectStatus409(promise, message) {
  try {
    await promise;
  } catch (error) {
    console.log(`Expected conflict check: ${message}; received ${error.status || 'no status'} (${error.message}).`);
    if (error.status === 409) return;
    throw new Error(`${message}: expected HTTP 409, got ${error.name}: ${error.message}`, { cause: error });
  }
  assert.fail(`${message}: expected HTTP 409 but the operation succeeded.`);
}

async function main() {
  const { rawPool, pool } = buildPool();
  const getPool = async () => pool;
  const transactionFactory = (currentPool) => new Transaction(currentPool);
  const debtRevisions = createFinanceDebtRevisionService({ getPool, sql, transactionFactory });
  const finance = createFinanceService({ getPool, sql, transactionFactory, debtRevisionService: debtRevisions });
  const annualFinance = createAnnualFinanceService({ getPool, sql, transactionFactory });
  const requests = createStudentDocumentRequestService({ getPool, sql, transactionFactory });
  const clearance = createStudentDocumentFinanceClearanceService({ getPool, sql, transactionFactory, debtRevisionService: debtRevisions });

  try {
    const [databaseRows] = await rawPool.query('SELECT DATABASE() AS database_name');
    assert.equal(databaseRows[0]?.database_name, DATABASE_NAME, 'refusing to run outside the named disposable test database');
    const [migrationRows] = await rawPool.execute('SELECT version FROM schema_migrations WHERE version = ?', ['v2.011']);
    assert.equal(migrationRows.length, 1, 'apply baseline and MariaDB migrations through v2.011 before running');

    const token = crypto.randomBytes(5).toString('hex');
    const financeId = await insertStaff(rawPool, 'finance', token);
    const registrarId = await insertStaff(rawPool, 'registrar', token);

    const legacyStudent = await insertStudent(rawPool, 'legacy', '100.00');
    const legacyStudentNo = (await execute(rawPool, 'SELECT student_no FROM students WHERE id = ?', [legacyStudent]))[0].student_no;
    const legacyRequestId = await createDocumentRequest(requests, registrarId, legacyStudent);
    let snapshot = await debtRevisions.getStudentSnapshot(legacyStudent);
    assert.deepEqual({ outstanding: snapshot.outstanding, revision: snapshot.debtIncreaseRevision, complete: snapshot.ledgerComplete },
      { outstanding: '100.00', revision: '0', complete: true });
    console.log('MariaDB integration: initial legacy balance and request replay verified.');
    await expectStatus409(requests.transitionRequest(registrarId, legacyStudent, legacyRequestId, {
      status: 'processing', idempotencyKey: uuid()
    }), 'an unapproved request cannot start processing');
    await expectStatus409(requests.transitionRequest(registrarId, legacyStudent, legacyRequestId, {
      status: 'ready', idempotencyKey: uuid()
    }), 'a request cannot skip directly from requested to ready');

    const approvalKey = uuid();
    const initialApproval = await approve(clearance, financeId, legacyRequestId, snapshot, {
      reason: 'Outstanding legacy account debt', arrangement: 'Family plans three monthly payments', key: approvalKey
    });
    assert.equal(initialApproval.status, 'approved');
    assert.equal((await approve(clearance, financeId, legacyRequestId, snapshot, {
      reason: 'Outstanding legacy account debt', arrangement: 'Family plans three monthly payments', key: approvalKey
    })).replayed, true);

    await requests.transitionRequest(registrarId, legacyStudent, legacyRequestId, { status: 'processing', idempotencyKey: uuid() });
    const initialSlip = await clearance.issueClaimSlip(registrarId, legacyRequestId, {
      studentId: String(legacyStudent), expectedClaimDate: '2026-10-10', idempotencyKey: uuid()
    });
    assert.equal(initialSlip.replayed, false);
    assert.equal((await clearance.getPrintableClaimSlip(registrarId, legacyRequestId, legacyStudent)).expectedClaimDate, '2026-10-10');

    await clearance.decideClearance(financeId, legacyRequestId, {
      decision: 'hold', idempotencyKey: uuid(), reason: 'Check prior ledger entry'
    });
    assert.equal((await clearance.getFinanceQueue(financeId, { status: 'on_hold', search: legacyStudentNo })).rows.length, 1);
    await expectStatus409(clearance.getPrintableClaimSlip(registrarId, legacyRequestId, legacyStudent), 'a held approval makes the slip unprintable');
    await clearance.decideClearance(financeId, legacyRequestId, {
      decision: 'withdraw', idempotencyKey: uuid(), reason: 'Previous approval withdrawn'
    });
    assert.equal((await clearance.getRegistrarData(registrarId, legacyStudent)).requests[0].status, 'withdrawn');
    snapshot = await debtRevisions.getStudentSnapshot(legacyStudent);
    await approve(clearance, financeId, legacyRequestId, snapshot, {
      reason: 'Rechecked legacy account debt', arrangement: 'Family plans three monthly payments'
    });
    await expectStatus409(clearance.getPrintableClaimSlip(registrarId, legacyRequestId, legacyStudent),
      'a new approval at the same revision still requires a new registrar slip');
    await clearance.issueClaimSlip(registrarId, legacyRequestId, {
      studentId: legacyStudent, expectedClaimDate: '2026-10-12', reason: 'Updated after reapproval', idempotencyKey: uuid()
    });

    await finance.recordTransaction(financeId, legacyStudent, {
      transactionType: 'payment', amount: '80.00', description: 'Integration balance decrease', referenceNo: `DC-${token}-PAY`
    });
    snapshot = await debtRevisions.getStudentSnapshot(legacyStudent);
    assert.deepEqual({ outstanding: snapshot.outstanding, revision: snapshot.debtIncreaseRevision }, { outstanding: '20.00', revision: '0' });
    assert.equal((await clearance.getPrintableClaimSlip(registrarId, legacyRequestId, legacyStudent)).expectedClaimDate, '2026-10-12',
      'a debt decrease leaves the existing approval and slip current');

    await finance.recordTransaction(financeId, legacyStudent, {
      transactionType: 'charge', amount: '50.00', description: 'Integration balance increase', referenceNo: `DC-${token}-CHG`
    });
    snapshot = await debtRevisions.getStudentSnapshot(legacyStudent);
    assert.deepEqual({ outstanding: snapshot.outstanding, revision: snapshot.debtIncreaseRevision }, { outstanding: '70.00', revision: '1' });
    assert.equal((await clearance.getFinanceQueue(financeId, { status: 'reapproval_required', search: legacyStudentNo })).rows.length, 1);
    await expectStatus409(requests.transitionRequest(registrarId, legacyStudent, legacyRequestId, {
      status: 'ready', idempotencyKey: uuid()
    }), 'a debt increase invalidates processing-to-ready');
    await expectStatus409(clearance.getPrintableClaimSlip(registrarId, legacyRequestId, legacyStudent), 'an increased debt makes the existing slip unprintable');

    await approve(clearance, financeId, legacyRequestId, snapshot, {
      reason: 'Reviewed current balance after new charge', arrangement: 'Family plans three monthly payments'
    });
    await clearance.issueClaimSlip(registrarId, legacyRequestId, {
      studentId: legacyStudent, expectedClaimDate: '2026-11-01', reason: 'Rescheduled after balance reapproval', idempotencyKey: uuid()
    });
    const currentSlip = await clearance.getPrintableClaimSlip(registrarId, legacyRequestId, legacyStudent);
    assert.equal(currentSlip.expectedClaimDate, '2026-11-01');
    assert.equal(currentSlip.studentName, 'Casey Integration');
    assert.doesNotMatch(JSON.stringify(currentSlip), /balance|arrangement|finance|private/i);

    // The current approval/slip allows ready. A concurrent increase races only on the student row;
    // release either commits against the current approval first or sees the new revision and returns 409.
    await requests.transitionRequest(registrarId, legacyStudent, legacyRequestId, { status: 'ready', idempotencyKey: uuid() });
    let timeout;
    const competing = await Promise.race([
      Promise.allSettled([
        finance.recordTransaction(financeId, legacyStudent, {
          transactionType: 'charge', amount: '10.00', description: 'Concurrent integration charge', referenceNo: `DC-${token}-RACE`
        }),
        requests.transitionRequest(registrarId, legacyStudent, legacyRequestId, {
          status: 'released', releasedOn: '2026-10-02', recipient: 'Integration recipient',
          handoverReference: `HAND-${token}`, idempotencyKey: uuid()
        })
      ]),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Concurrent release/finance mutation timed out.')), 15000); })
    ]);
    clearTimeout(timeout);
    const [mutationResult, releaseResult] = competing;
    assert.equal(mutationResult.status, 'fulfilled', mutationResult.reason?.message);
    let finalReleaseResult = releaseResult;
    let raceOutcome = 'release committed before the debt increase';
    if (releaseResult.status === 'rejected') {
      assert.equal(releaseResult.reason.status, 409, `unexpected concurrent release error: ${releaseResult.reason.message} (${releaseResult.reason.code || releaseResult.reason.errno || 'no database code'}); SQL: ${releaseResult.reason.sql || 'n/a'}; stack: ${releaseResult.reason.stack || 'n/a'}`);
      raceOutcome = 'debt increase committed first; stale release was rejected and required reapproval plus slip reissue';
      snapshot = await debtRevisions.getStudentSnapshot(legacyStudent);
      await approve(clearance, financeId, legacyRequestId, snapshot, {
        reason: 'Reviewed concurrent charge before handover', arrangement: 'Family plans four monthly payments'
      });
      await clearance.issueClaimSlip(registrarId, legacyRequestId, {
        studentId: legacyStudent, expectedClaimDate: '2026-11-05', reason: 'Reissued after concurrent charge', idempotencyKey: uuid()
      });
      await clearance.getPrintableClaimSlip(registrarId, legacyRequestId, legacyStudent);
      finalReleaseResult = { status: 'fulfilled', value: await requests.transitionRequest(registrarId, legacyStudent, legacyRequestId, {
        status: 'released', releasedOn: '2026-10-02', recipient: 'Integration recipient',
        handoverReference: `HAND-${token}`, idempotencyKey: uuid()
      }) };
    }
    assert.equal(finalReleaseResult.status, 'fulfilled');
    const [releaseRows] = await rawPool.execute(
      'SELECT status, released_on, recipient, handover_reference FROM student_document_requests WHERE id = ?', [legacyRequestId]);
    assert.deepEqual(releaseRows[0], {
      status: 'released', released_on: '2026-10-02', recipient: 'Integration recipient', handover_reference: `HAND-${token}`
    });

    const zeroStudent = await insertStudent(rawPool, 'zero', '0.00');
    const zeroRequestId = await createDocumentRequest(requests, registrarId, zeroStudent, 'High school record');
    const zeroSnapshot = await debtRevisions.getStudentSnapshot(zeroStudent);
    assert.equal(zeroSnapshot.ledgerComplete, true);
    assert.equal(zeroSnapshot.outstanding, '0.00');
    assert.equal((await approve(clearance, financeId, zeroRequestId, zeroSnapshot)).status, 'approved',
      'zero balance requires an explicit approval');

    const annualStudent = await insertStudent(rawPool, 'annual');
    const annualStudentNo = (await execute(rawPool, 'SELECT student_no FROM students WHERE id = ?', [annualStudent]))[0].student_no;
    const olderAnnual = await insertAnnualYear(rawPool, { studentId: annualStudent, year: `2098-${token}`, amount: '40.00', actorId: financeId });
    const currentAnnual = await insertAnnualYear(rawPool, { studentId: annualStudent, year: `2099-${token}`, amount: '60.00', actorId: financeId });
    assert.ok(olderAnnual.chargeId && olderAnnual.assessmentId);
    await execute(rawPool,
      `INSERT INTO finance_payments (student_id, amount, payment_date, idempotency_key, request_fingerprint, recorded_by)
        VALUES (?, 150.00, '2026-10-01', ?, ?, ?)`,
      [annualStudent, uuid(), crypto.createHash('sha256').update(`unallocated:${annualStudent}`).digest('hex'), financeId]);
    const annualSnapshot = await debtRevisions.getStudentSnapshot(annualStudent);
    assert.deepEqual({ outstanding: annualSnapshot.outstanding, canonical: annualSnapshot.canonicalBalance, complete: annualSnapshot.ledgerComplete },
      { outstanding: '100.00', canonical: '100.00', complete: true },
      'all assessed years are summed while unallocated annual credit is not automatically applied');
    await execute(rawPool,
      `INSERT INTO annual_enrollments (student_id, school_year, grade_level, intake_status, created_by)
        VALUES (?, ?, 'Grade 11', 'pending', ?), (?, ?, 'Grade 11', 'cancelled', ?)`,
      [annualStudent, `2096-${token}`, financeId, annualStudent, `2097-${token}`, financeId]);
    assert.equal((await debtRevisions.getStudentSnapshot(annualStudent)).ledgerComplete, true,
      'pending and cancelled unassessed intake rows do not block a verified assessed ledger');

    const annualRequestId = await createDocumentRequest(requests, registrarId, annualStudent, 'Transcript');
    await approve(clearance, financeId, annualRequestId, annualSnapshot, {
      reason: 'Reviewed all annual assessments', arrangement: 'Family plans monthly payments'
    });
    const annualPayment = await annualFinance.recordPayment(financeId, annualStudent, {
      amount: '20.00', paymentDate: '2026-10-01', referenceNo: `DC-${token}-ANNUAL-PAY`,
      idempotencyKey: uuid(), allocations: [{ chargeId: currentAnnual.chargeId, amount: '20.00' }]
    });
    let mutatedAnnual = await debtRevisions.getStudentSnapshot(annualStudent);
    assert.deepEqual({ outstanding: mutatedAnnual.outstanding, revision: mutatedAnnual.debtIncreaseRevision },
      { outstanding: '80.00', revision: '0' }, 'an actual annual payment allocation decreases due without staling approval');
    const allocationRows = await execute(rawPool,
      'SELECT id FROM finance_payment_allocations WHERE payment_id = ? ORDER BY id', [Number(annualPayment.paymentId)]);
    assert.equal(allocationRows.length, 1);
    await annualFinance.releasePaymentAllocation(financeId, annualStudent, Number(allocationRows[0].id), {
      amount: '10.00', reason: 'Corrected annual allocation', idempotencyKey: uuid()
    });
    mutatedAnnual = await debtRevisions.getStudentSnapshot(annualStudent);
    assert.deepEqual({ outstanding: mutatedAnnual.outstanding, revision: mutatedAnnual.debtIncreaseRevision },
      { outstanding: '90.00', revision: '1' }, 'releasing a real annual allocation raises due and revision');
    assert.equal((await clearance.getFinanceQueue(financeId, { status: 'reapproval_required', search: annualStudentNo })).rows.length, 1);
    await approve(clearance, financeId, annualRequestId, mutatedAnnual, {
      reason: 'Reviewed allocation release', arrangement: 'Family plans monthly payments'
    });
    const adjustment = await annualFinance.recordChargeAdjustment(financeId, annualStudent, currentAnnual.chargeId, {
      amount: '30.00', reason: 'Integration positive assessment adjustment', idempotencyKey: uuid()
    });
    mutatedAnnual = await debtRevisions.getStudentSnapshot(annualStudent);
    assert.deepEqual({ outstanding: mutatedAnnual.outstanding, revision: mutatedAnnual.debtIncreaseRevision },
      { outstanding: '120.00', revision: '2' }, 'positive annual assessment adjustment increments revision');
    await approve(clearance, financeId, annualRequestId, mutatedAnnual, {
      reason: 'Reviewed positive annual adjustment', arrangement: 'Family plans monthly payments'
    });
    await annualFinance.reverseAdjustment(financeId, annualStudent, Number(adjustment.adjustmentId), {
      reason: 'Reversed integration assessment adjustment', idempotencyKey: uuid()
    });
    mutatedAnnual = await debtRevisions.getStudentSnapshot(annualStudent);
    assert.deepEqual({ outstanding: mutatedAnnual.outstanding, revision: mutatedAnnual.debtIncreaseRevision },
      { outstanding: '90.00', revision: '2' }, 'a real annual decrease does not increment revision or stale the current approval');
    assert.equal((await clearance.getFinanceQueue(financeId, { status: 'approved', search: annualStudentNo })).rows.length, 1);

    const incompleteStudent = await insertStudent(rawPool, 'incomplete');
    const incompleteAnnual = await execute(rawPool,
      `INSERT INTO annual_enrollments (student_id, school_year, grade_level, intake_status, created_by)
        VALUES (?, ?, 'Grade 11', 'enrolled', ?)`, [incompleteStudent, `2099-${token}`, financeId]);
    const isolatedAnnualSnapshot = await debtRevisions.getStudentSnapshot(annualStudent);
    assert.equal(isolatedAnnualSnapshot.ledgerComplete, true,
      'another student’s missing assessment must not mark this student’s ledger incomplete');
    const incompleteSnapshot = await debtRevisions.getStudentSnapshot(incompleteStudent);
    assert.equal(incompleteSnapshot.ledgerComplete, false);
    assert.equal(incompleteSnapshot.outstanding, '0.00');
    assert.ok(incompleteAnnual.insertId);

    const missingStudent = await insertStudent(rawPool, 'missing');
    const missingRequestId = await createDocumentRequest(requests, registrarId, missingStudent);
    const missingSnapshot = await debtRevisions.getStudentSnapshot(missingStudent);
    assert.equal(missingSnapshot.ledgerComplete, false);
    await expectStatus409(approve(clearance, financeId, missingRequestId, missingSnapshot),
      'missing finance records cannot receive zero-balance approval');

    console.log(`MariaDB document-clearance integration passed: legacy and annual debt revisioning, allocation release, positive adjustment/reversal, stale/hold/withdraw reapproval, slips, zero, all-years annual debt, unallocated credit, incomplete-ledger isolation; race outcome: ${raceOutcome}.`);
  } finally {
    await rawPool.end();
  }
}

main().catch((error) => {
  console.error(`MariaDB document-clearance integration failed: ${error.message} (${error.code || error.errno || 'no database code'})`);
  if (process.env.DOCUMENT_CLEARANCE_TEST_DEBUG === '1') console.error(error.stack);
  if (error.cause?.sql) console.error(`Failed test SQL: ${error.cause.sql}`);
  process.exitCode = 1;
});
