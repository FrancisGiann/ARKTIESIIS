'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const os = require('node:os');
const path = require('node:path');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { PoolFacade, Transaction, sql } = require('../src/config/database');
const { createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');

const socketPath = process.env.ANNUAL_FINANCE_HANDOFF_TEST_SOCKET;
const ROOT = path.resolve(__dirname, '..');
const CLEARANCE_FINGERPRINT = 'a'.repeat(64);

function uuid() { return crypto.randomUUID(); }
function quoteDatabase(name) { return `\`${name.replaceAll('`', '``')}\``; }
function socketIsDisposable(socket) {
  if (!path.isAbsolute(socket)) return false;
  const localSocket = path.resolve(os.homedir(), '.local/share/arktiesiis/local-mariadb/mariadb.sock');
  return path.resolve(socket) === localSocket
    || path.resolve(socket).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`);
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function createFreshSchema(connection, databaseName) {
  await connection.query(`CREATE DATABASE ${quoteDatabase(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.query(`USE ${quoteDatabase(databaseName)}`);
  await applyStatements(connection, readSqlFile(path.join(ROOT, 'database/mariadb/schema.sql')));
  for (const migration of readForwardMigrations()) {
    await applyStatements(connection, migration.statements);
    await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
  }
}

async function insertUser(pool, role, { active = true } = {}) {
  const [result] = await pool.execute(`INSERT INTO users (email, password_hash, role, is_active)
    VALUES (?, 'integration-only-not-a-login-hash', ?, ?)`, [`${role}-${uuid()}@integration.invalid`, role, active ? 1 : 0]);
  return Number(result.insertId);
}

async function assertReadyState(finance, registrarId, annualId, expected) {
  const readiness = await finance.getAnnualEntryFinanceReadinessForRegistrar(registrarId, annualId);
  assert.equal(readiness.status, expected);
  return readiness;
}

test('pending annual enrollment hands off assessment, voucher resolution, and exact entry-term DP to Finance', {
  skip: !socketPath && 'Set ANNUAL_FINANCE_HANDOFF_TEST_SOCKET to an isolated MariaDB socket under /tmp or the private local instance.'
}, async () => {
  assert.equal(socketIsDisposable(socketPath), true,
    'the integration test accepts only a disposable /tmp socket or the private local MariaDB socket');
  const databaseName = `arktiesiis_annual_handoff_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const adminPool = mysql.createPool({ socketPath, user: os.userInfo().username, password: '', connectionLimit: 2 });
  let pool;
  try {
    const setup = await adminPool.getConnection();
    try { await createFreshSchema(setup, databaseName); } finally { setup.release(); }
    pool = mysql.createPool({ socketPath, user: os.userInfo().username, password: '', database: databaseName,
      waitForConnections: true, connectionLimit: 6, queueLimit: 0, supportBigNumbers: true,
      bigNumberStrings: true, decimalNumbers: false, dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false });
    const appPool = new PoolFacade(pool);
    const registrarId = await insertUser(pool, 'registrar');
    const financeId = await insertUser(pool, 'finance');
    const frontDeskId = await insertUser(pool, 'front_desk');
    const studentUserId = await insertUser(pool, 'student', { active: false });
    await pool.execute('INSERT INTO staff_profiles (user_id, first_name, last_name) VALUES (?, ?, ?)', [registrarId, 'Rita', 'Registrar']);

    const termIds = [];
    const sectionIds = [];
    for (const [index, label] of ['First Term', 'Second Term', 'Third Term'].entries()) {
      const termNumber = index + 1;
      const [term] = await pool.execute('INSERT INTO academic_terms (school_year, term, is_current) VALUES (?, ?, ?)',
        ['2026-2027', label, termNumber === 2 ? 1 : 0]);
      const termId = Number(term.insertId);
      termIds.push(termId);
      const [section] = await pool.execute(`INSERT INTO sections (name, grade_level, academic_term_id, cluster, strand)
        VALUES (?, 'Grade 11', ?, 'Academic', 'STEM')`, [`Section ${termNumber}`, termId]);
      sectionIds.push(Number(section.insertId));
      await pool.execute(`INSERT INTO school_year_term_order (school_year, term_number, academic_term_id, configured_by)
        VALUES ('2026-2027', ?, ?, ?)`, [termNumber, termId, registrarId]);
    }

    const studentNumber = `HANDOFF-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const lrn = String(100000000000 + Math.floor(Math.random() * 89999999999));
    const [student] = await pool.execute(`INSERT INTO students
      (user_id, student_no, lrn, first_name, last_name, birth_date, status)
      VALUES (?, ?, ?, 'Ari', 'Sample', '2008-04-21', 'active')`, [studentUserId, studentNumber, lrn]);
    const studentId = Number(student.insertId);
    const preEnrollmentId = uuid();
    await pool.execute(`INSERT INTO pre_enrollments
      (id, idempotency_key, request_fingerprint, school_year, first_name, middle_name, last_name, lrn,
        target_grade_level, email, status, created_by, updated_by, created_by_role, applicant_kind)
      VALUES (?, ?, ?, '2026-2027', 'Ari', 'Mae', 'Sample', ?, 'Grade 11', ?, 'enrollment_started', ?, ?, 'front_desk', 'continuing')`,
    [preEnrollmentId, uuid(), 'b'.repeat(64), lrn, `learner-${uuid()}@integration.invalid`, frontDeskId, frontDeskId]);
    const [annual] = await pool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, intake_kind,
        entry_term_number, account_activation_pending, pre_enrollment_id)
      VALUES (?, '2026-2027', 'Grade 11', 'PUB', 'pending', ?, 'transferee', 2, 1, ?)`, [studentId, registrarId, preEnrollmentId]);
    const annualId = Number(annual.insertId);
    const enrollmentIds = [];
    for (let index = 0; index < termIds.length; index += 1) {
      const termNumber = index + 1;
      const isEntryOrLater = termNumber >= 2;
      const [placement] = await pool.execute(`INSERT INTO enrollments
        (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [studentId, termIds[index], sectionIds[index],
        isEntryOrLater ? 'pending_payment' : 'not_applicable', annualId, termNumber,
        isEntryOrLater ? 'applicable' : 'not_applicable']);
      enrollmentIds.push(Number(placement.insertId));
    }

    const annualFinance = createAnnualFinanceService({ getPool: async () => appPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool) });
    const termClearanceService = {
      async assertAnnualEntryPrerequisitesInTransaction(_transaction, input) {
        if (input.expectedFingerprint !== CLEARANCE_FINGERPRINT) {
          const error = new Error('The paper prerequisite snapshot changed.');
          error.status = 409;
          throw error;
        }
      }
    };
    const annualEnrollment = createAnnualEnrollmentService({ getPool: async () => appPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), hashPassword: async (value) => `integration:${value}`,
      createPassword: () => 'integration-only-password', annualFinanceService: annualFinance, termClearanceService });

    await assert.rejects(annualFinance.annualAssessmentPreview(financeId, annualId), { status: 409 },
      'missing active fee setup is not interpreted as a zero assessment');
    await assertReadyState(annualFinance, registrarId, annualId, 'awaiting_finance_assessment');
    await assert.rejects(annualEnrollment.confirmAnnualEnrollment(registrarId, annualId,
      { clearanceSnapshotFingerprint: CLEARANCE_FINGERPRINT, idempotencyKey: uuid() }), { status: 409 },
    'Registrar cannot create the missing annual assessment during confirmation');

    const lines = [1, 2, 3].flatMap((termNumber) => ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment) => ({
      termNumber, feeCategory: 'tuition', lineName: 'Tuition', installment,
      amount: installment === 'DP' ? '100.00' : '10.00', isOptional: false
    })));
    await annualFinance.createSchedule(financeId, { schoolYear: '2026-2027', gradeLevel: 'Grade 11',
      voucherCode: 'PUB', lines, idempotencyKey: uuid() });
    const initialPreview = await annualFinance.annualAssessmentPreview(financeId, annualId);
    const post = await annualFinance.confirmAnnualAssessment(financeId, annualId, [], {
      scheduleId: String(initialPreview.scheduleId), scheduleVersion: String(initialPreview.scheduleVersion),
      voucherCode: initialPreview.voucherCode, idempotencyKey: uuid(), financeAttestation: true
    });
    assert.equal(post.assessmentId > 0, true);
    const initialReview = (await pool.execute(`SELECT id, reviewed_by, reviewed_by_role, voucher_code_snapshot,
      current_voucher_code_snapshot FROM annual_finance_assessment_reviews WHERE annual_enrollment_id = ?`, [annualId]))[0][0];
    assert.equal(Number(initialReview.reviewed_by), financeId);
    assert.equal(initialReview.reviewed_by_role, 'finance');
    assert.equal(initialReview.voucher_code_snapshot, 'PUB');
    assert.equal(initialReview.current_voucher_code_snapshot, 'PUB');
    await assertReadyState(annualFinance, registrarId, annualId, 'awaiting_down_payment');
    await assert.rejects(annualFinance.confirmAnnualAssessment(financeId, annualId, [], {
      scheduleId: String(initialPreview.scheduleId), scheduleVersion: String(initialPreview.scheduleVersion),
      voucherCode: initialPreview.voucherCode, idempotencyKey: uuid(), financeAttestation: true,
      zeroDpAttested: true
    }), { status: 409 }, 'Finance cannot attest zero when the saved entry-term DP is positive');
    await assert.rejects(annualFinance.annualAssessmentPreview(registrarId, annualId), { status: 403 },
      'Registrar cannot open Finance fee composition through the preview service');

    const blockedConfirmation = () => annualEnrollment.confirmAnnualEnrollment(registrarId, annualId,
      { clearanceSnapshotFingerprint: CLEARANCE_FINGERPRINT, idempotencyKey: uuid() });
    await assert.rejects(blockedConfirmation(), { status: 409 }, 'positive entry-term DP blocks without a current allocation');
    const dpCharge = (await pool.execute(`SELECT charge.id FROM assessed_charges AS charge
      INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
      WHERE charge.assessment_id = ? AND enrollment.annual_term_number = 2 AND charge.fee_category = 'tuition' AND charge.installment = 'DP'`,
    [post.assessmentId]))[0][0];
    const payment = await annualFinance.recordPayment(financeId, studentId, {
      amount: '100.00', paymentDate: '2026-10-15', idempotencyKey: uuid(), allocations: []
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'awaiting_down_payment',
      'unallocated account credit does not settle the entry-term DP');
    const firstAllocation = await annualFinance.allocateExistingCredit(financeId, studentId, payment.paymentId, {
      allocations: [{ chargeId: Number(dpCharge.id), amount: '100.00' }], idempotencyKey: uuid()
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'ready_for_registrar');
    let allocation = (await pool.execute(`SELECT id FROM finance_payment_allocations
      WHERE allocation_batch_id = ? AND charge_id = ?`, [firstAllocation.allocationBatchId, dpCharge.id]))[0][0];
    await annualFinance.releasePaymentAllocation(financeId, studentId, allocation.id, {
      amount: '100.00', reason: 'Test release before confirmation.', idempotencyKey: uuid()
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'awaiting_down_payment',
      'released allocations no longer settle DP');

    const reversalPayment = await annualFinance.recordPayment(financeId, studentId, {
      amount: '100.00', paymentDate: '2026-10-15', idempotencyKey: uuid(),
      allocations: [{ chargeId: Number(dpCharge.id), amount: '100.00' }]
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'ready_for_registrar');
    await annualFinance.reversePayment(financeId, studentId, reversalPayment.paymentId, {
      reason: 'Test reversed payment before confirmation.', idempotencyKey: uuid()
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'awaiting_down_payment',
      'reversed payments no longer settle DP');

    const settledPayment = await annualFinance.recordPayment(financeId, studentId, {
      amount: '100.00', paymentDate: '2026-10-15', idempotencyKey: uuid(),
      allocations: [{ chargeId: Number(dpCharge.id), amount: '100.00' }]
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'ready_for_registrar');
    await annualFinance.recordChargeAdjustment(financeId, studentId, dpCharge.id, {
      amount: '1.00', reason: 'Test Finance correction before confirmation.', idempotencyKey: uuid()
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'finance_review_required',
      'assessment-affecting adjustments stale prior Finance review');
    const adjustedPreview = await annualFinance.annualAssessmentPreview(financeId, annualId);
    assert.equal(adjustedPreview.existingAssessment, true);
    assert.equal(adjustedPreview.assessmentId, post.assessmentId);
    await annualFinance.confirmAnnualAssessment(financeId, annualId, adjustedPreview.optionalLineIds, {
      scheduleId: String(adjustedPreview.scheduleId), scheduleVersion: String(adjustedPreview.scheduleVersion),
      voucherCode: adjustedPreview.voucherCode, idempotencyKey: uuid(), financeAttestation: true
    });
    const adjustedReviewId = Number((await pool.execute(`SELECT id FROM annual_finance_assessment_reviews
      WHERE annual_enrollment_id = ? ORDER BY id DESC LIMIT 1`, [annualId]))[0][0].id);
    assert.notEqual(adjustedReviewId, Number(initialReview.id));
    await assertReadyState(annualFinance, registrarId, annualId, 'awaiting_down_payment',
      'Finance re-review preserves charges and separately exposes the additional adjusted DP');
    const topUp = await annualFinance.recordPayment(financeId, studentId, {
      amount: '1.00', paymentDate: '2026-10-15', idempotencyKey: uuid(),
      allocations: [{ chargeId: Number(dpCharge.id), amount: '1.00' }]
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'ready_for_registrar');

    await annualEnrollment.updateVoucher(registrarId, annualId, 'ESC', 'Corrected voucher from the saved school documents.');
    await assertReadyState(annualFinance, registrarId, annualId, 'finance_review_required',
      'a voucher change invalidates the old attestation while intake is still pending');
    await pool.execute(`INSERT INTO annual_enrollment_events
      (annual_enrollment_id, actor_id, event_type, reason, request_fingerprint)
      VALUES (?, ?, 'voucher_review_resolved', ?, ?)`, [annualId, financeId,
      'Assessment remains valid: Pre-migration resolution without assessment linkage.', 'c'.repeat(64)]);
    const financeLedgerWithLegacyResolution = await annualFinance.getStudentLedger(financeId, studentId, 'finance');
    assert.ok(financeLedgerWithLegacyResolution.terms.some((term) => Number(term.annual_enrollment_id) === annualId
      && Number(term.voucher_review_required) === 1),
    'Finance account exposes a fresh resolution action for a pending assessment with an unbound legacy resolution');
    await assert.rejects(annualFinance.annualAssessmentPreview(financeId, annualId), { status: 409 },
      'an unbound legacy resolution cannot authorize a new assessment attestation');
    await assert.rejects(blockedConfirmation(), { status: 409 },
      'an unbound legacy resolution cannot satisfy Registrar confirmation');
    await annualFinance.resolveVoucherReview(financeId, annualId, {
      resolution: 'assessment_stands', reason: 'Re-reviewed the current documents; existing assessment stands.', idempotencyKey: uuid()
    });
    const resolvedPreview = await annualFinance.annualAssessmentPreview(financeId, annualId);
    assert.equal(resolvedPreview.existingAssessment, true);
    assert.equal(resolvedPreview.voucherCode, 'PUB', 'the historic assessment voucher is retained for re-review');
    await annualFinance.confirmAnnualAssessment(financeId, annualId, resolvedPreview.optionalLineIds, {
      scheduleId: String(resolvedPreview.scheduleId), scheduleVersion: String(resolvedPreview.scheduleVersion),
      voucherCode: resolvedPreview.voucherCode, idempotencyKey: uuid(), financeAttestation: true
    });
    const voucherReview = (await pool.execute(`SELECT id, voucher_code_snapshot, current_voucher_code_snapshot,
      voucher_review_event_id, reviewed_by_role FROM annual_finance_assessment_reviews
      WHERE annual_enrollment_id = ? ORDER BY id DESC LIMIT 1`, [annualId]))[0][0];
    assert.equal(voucherReview.voucher_code_snapshot, 'PUB');
    assert.equal(voucherReview.current_voucher_code_snapshot, 'ESC');
    assert.ok(Number(voucherReview.voucher_review_event_id) > 0);
    assert.equal(voucherReview.reviewed_by_role, 'finance');
    assert.equal(Number((await pool.execute(`SELECT finance_assessment_id FROM annual_enrollment_events
      WHERE id = ?`, [voucherReview.voucher_review_event_id]))[0][0].finance_assessment_id), post.assessmentId,
    'fresh Finance resolution is durably bound to the preserved assessment');
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM assessed_charges WHERE assessment_id = ?',
      [post.assessmentId]))[0][0].count), 8, 're-review did not repost or duplicate charges');

    await annualEnrollment.updateVoucher(registrarId, annualId, 'NV', 'Second correction before enrollment confirmation.');
    await assertReadyState(annualFinance, registrarId, annualId, 'finance_review_required',
      'a later voucher flag supersedes the prior Finance approval while intake remains pending');
    await assert.rejects(blockedConfirmation(), { status: 409 },
      'Registrar cannot finalize using Finance approval bound to the prior voucher transition');
    await annualFinance.resolveVoucherReview(financeId, annualId, {
      resolution: 'adjustments_recorded', reason: 'Reviewed current voucher and recorded the required adjustment.', idempotencyKey: uuid()
    });
    const finalFinancePreview = await annualFinance.annualAssessmentPreview(financeId, annualId);
    assert.equal(finalFinancePreview.existingAssessment, true);
    await annualFinance.confirmAnnualAssessment(financeId, annualId, finalFinancePreview.optionalLineIds, {
      scheduleId: String(finalFinancePreview.scheduleId), scheduleVersion: String(finalFinancePreview.scheduleVersion),
      voucherCode: finalFinancePreview.voucherCode, idempotencyKey: uuid(), financeAttestation: true
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'ready_for_registrar');

    const beforeConfirmCharges = Number((await pool.execute('SELECT COUNT(*) AS count FROM assessed_charges WHERE assessment_id = ?',
      [post.assessmentId]))[0][0].count);
    const finalKey = uuid();
    const failingActivationEnrollment = createAnnualEnrollmentService({ getPool: async () => appPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool),
      hashPassword: async () => { throw new Error('integration finalization rollback probe'); },
      createPassword: () => 'integration-only-password', annualFinanceService: annualFinance, termClearanceService });
    await assert.rejects(failingActivationEnrollment.confirmAnnualEnrollment(registrarId, annualId, {
      clearanceSnapshotFingerprint: CLEARANCE_FINGERPRINT, idempotencyKey: uuid()
    }), /integration finalization rollback probe/);
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_registrar_confirmations WHERE annual_enrollment_id = ?',
      [annualId]))[0][0].count), 0, 'a failure after confirmation insert rolls back registrar evidence');
    assert.equal((await pool.execute('SELECT intake_status FROM annual_enrollments WHERE id = ?', [annualId]))[0][0].intake_status,
      'pending', 'a failed finalization keeps the annual intake pending');
    assert.equal((await pool.execute('SELECT enrollment_status FROM enrollments WHERE id = ?', [enrollmentIds[1]]))[0][0].enrollment_status,
      'pending_payment', 'a failed finalization leaves the entry term pending');
    assert.equal(Number((await pool.execute('SELECT is_active FROM users WHERE id = ?', [studentUserId]))[0][0].is_active), 0,
      'a failed finalization does not activate the first login');
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM assessed_charges WHERE assessment_id = ?',
      [post.assessmentId]))[0][0].count), beforeConfirmCharges, 'failed finalization preserves Finance-posted charges');
    const confirmed = await annualEnrollment.confirmAnnualEnrollment(registrarId, annualId, {
      clearanceSnapshotFingerprint: CLEARANCE_FINGERPRINT, idempotencyKey: finalKey
    });
    assert.equal(confirmed.assessmentId, post.assessmentId);
    assert.equal(typeof confirmed.temporaryPassword, 'string', 'first login activates only with final confirmation');
    const confirmationRow = (await pool.execute(`SELECT finance_review_id, entry_dp_state_at_confirmation,
      assessment_id, payable_total FROM annual_registrar_confirmations WHERE annual_enrollment_id = ?`, [annualId]))[0][0];
    assert.equal(Number(confirmationRow.finance_review_id), Number(voucherReview.id) + 1,
      'final Registrar evidence links to the exact Finance review after the latest voucher resolution');
    assert.equal(confirmationRow.entry_dp_state_at_confirmation, 'settled');
    assert.equal(Number(confirmationRow.assessment_id), post.assessmentId);
    assert.equal((await pool.execute('SELECT intake_status FROM annual_enrollments WHERE id = ?', [annualId]))[0][0].intake_status, 'enrolled');
    assert.equal((await pool.execute('SELECT enrollment_status FROM enrollments WHERE id = ?', [enrollmentIds[1]]))[0][0].enrollment_status, 'enrolled');
    assert.equal(Number((await pool.execute('SELECT is_active FROM users WHERE id = ?', [studentUserId]))[0][0].is_active), 1);
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM assessed_charges WHERE assessment_id = ?',
      [post.assessmentId]))[0][0].count), beforeConfirmCharges, 'Registrar reuses Finance charges without double posting');
    assert.equal((await annualEnrollment.confirmAnnualEnrollment(registrarId, annualId, {
      clearanceSnapshotFingerprint: CLEARANCE_FINGERPRINT, idempotencyKey: finalKey
    })).alreadyConfirmed, true, 'an identical retry does not double-confirm or re-activate');
    await assert.rejects(annualEnrollment.confirmAnnualEnrollment(registrarId, annualId, {
      clearanceSnapshotFingerprint: CLEARANCE_FINGERPRINT, idempotencyKey: uuid(),
      assessmentId: String(post.assessmentId), scheduleId: String(initialPreview.scheduleId), voucherCode: 'PUB'
    }), { status: 409 }, 'forged legacy fee fields cannot bypass the Finance handoff');
    assert.ok(settledPayment.paymentId && topUp.paymentId);

    const zeroStudentNumber = `HANDOFF-ZERO-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const zeroLrn = String(200000000000 + Math.floor(Math.random() * 79999999999));
    const zeroStudentUserId = await insertUser(pool, 'student', { active: false });
    const [zeroStudent] = await pool.execute(`INSERT INTO students
      (user_id, student_no, lrn, first_name, last_name, birth_date, status)
      VALUES (?, ?, ?, 'Zoe', 'Zero', '2008-04-21', 'active')`, [zeroStudentUserId, zeroStudentNumber, zeroLrn]);
    const zeroPreEnrollmentId = uuid();
    await pool.execute(`INSERT INTO pre_enrollments
      (id, idempotency_key, request_fingerprint, school_year, first_name, middle_name, last_name, lrn,
        target_grade_level, email, status, created_by, updated_by, created_by_role, applicant_kind)
      VALUES (?, ?, ?, '2026-2027', 'Zoe', 'Mae', 'Zero', ?, 'Grade 11', ?, 'enrollment_started', ?, ?, 'front_desk', 'new')`,
    [zeroPreEnrollmentId, uuid(), 'c'.repeat(64), zeroLrn, `zero-${uuid()}@integration.invalid`, frontDeskId, frontDeskId]);
    const [zeroAnnual] = await pool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, intake_kind,
        entry_term_number, account_activation_pending, pre_enrollment_id)
      VALUES (?, '2026-2027', 'Grade 11', 'PUB', 'pending', ?, 'new', 2, 1, ?)`,
    [Number(zeroStudent.insertId), registrarId, zeroPreEnrollmentId]);
    const zeroAnnualId = Number(zeroAnnual.insertId);
    for (let index = 0; index < termIds.length; index += 1) {
      const termNumber = index + 1;
      const applicable = termNumber >= 2;
      await pool.execute(`INSERT INTO enrollments
        (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [Number(zeroStudent.insertId), termIds[index], sectionIds[index],
        applicable ? 'pending_payment' : 'not_applicable', zeroAnnualId, termNumber,
        applicable ? 'applicable' : 'not_applicable']);
    }
    const zeroLines = [1, 2, 3].flatMap((termNumber) => ['DP', 'Prelim', 'Midterm', 'Finals'].map((installment) => ({
      termNumber, feeCategory: 'tuition', lineName: 'Tuition', installment,
      amount: termNumber === 2 && installment === 'DP' ? '0.00' : '10.00', isOptional: false
    })));
    await annualFinance.createSchedule(financeId, { schoolYear: '2026-2027', gradeLevel: 'Grade 11',
      voucherCode: 'PUB', lines: zeroLines, idempotencyKey: uuid() });
    const zeroPreview = await annualFinance.annualAssessmentPreview(financeId, zeroAnnualId);
    await assert.rejects(annualFinance.confirmAnnualAssessment(financeId, zeroAnnualId, [], {
      scheduleId: String(zeroPreview.scheduleId), scheduleVersion: String(zeroPreview.scheduleVersion),
      voucherCode: zeroPreview.voucherCode, idempotencyKey: uuid(), financeAttestation: true
    }), { status: 409 }, 'zero DP assessment cannot be posted without explicit Finance zero approval');
    await assert.rejects(annualFinance.confirmAnnualAssessment(financeId, zeroAnnualId, [], {
      scheduleId: String(zeroPreview.scheduleId), scheduleVersion: String(zeroPreview.scheduleVersion),
      voucherCode: zeroPreview.voucherCode, idempotencyKey: uuid()
    }), { status: 403 }, 'pending annual assessment requires an explicit Finance attestation');
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_assessments WHERE annual_enrollment_id = ?',
      [zeroAnnualId]))[0][0].count), 0, 'missing zero approval leaves no assessment or fake payment behind');
    const approvedZero = await annualFinance.confirmAnnualAssessment(financeId, zeroAnnualId, [], {
      scheduleId: String(zeroPreview.scheduleId), scheduleVersion: String(zeroPreview.scheduleVersion),
      voucherCode: zeroPreview.voucherCode, idempotencyKey: uuid(), financeAttestation: true, zeroDpAttested: true
    });
    assert.ok(approvedZero.assessmentId > 0);
    const zeroReadiness = await assertReadyState(annualFinance, registrarId, zeroAnnualId, 'ready_for_registrar');
    assert.equal(zeroReadiness.zeroDownPaymentApproved, true);
    const zeroFinal = await annualEnrollment.confirmAnnualEnrollment(registrarId, zeroAnnualId, {
      clearanceSnapshotFingerprint: CLEARANCE_FINGERPRINT, idempotencyKey: uuid()
    });
    assert.equal(zeroFinal.assessmentId, approvedZero.assessmentId,
      'explicitly reviewed zero DP permits final confirmation without a payment');
    assert.equal((await pool.execute(`SELECT entry_dp_state_at_confirmation FROM annual_registrar_confirmations
      WHERE annual_enrollment_id = ?`, [zeroAnnualId]))[0][0].entry_dp_state_at_confirmation, 'zero_due');
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM finance_payments WHERE student_id = ?',
      [Number(zeroStudent.insertId)]))[0][0].count), 0, 'zero DP creates no artificial payment or receipt');
    assert.equal(Number((await pool.execute('SELECT is_active FROM users WHERE id = ?', [zeroStudentUserId]))[0][0].is_active), 1,
      'the zero-DP new student login activates only at final Registrar confirmation');
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteDatabase(databaseName)}`).catch(() => {});
    await adminPool.end();
  }
});
