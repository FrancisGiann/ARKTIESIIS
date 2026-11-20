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
const { createFinanceReviewActionService } = require('../src/services/financeReviewActionService');
const { runSerializableTransaction } = require('../src/services/transactionRetry');

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
    const [alternateEntrySection] = await pool.execute(`INSERT INTO sections
      (name, grade_level, academic_term_id, cluster, strand) VALUES (?, 'Grade 11', ?, 'Academic', 'STEM')`,
    [`Alternate Entry ${process.pid}-${crypto.randomBytes(3).toString('hex')}`, termIds[1]]);
    const alternateEntrySectionId = Number(alternateEntrySection.insertId);

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
        return { ready: true, fingerprint: CLEARANCE_FINGERPRINT };
      },
      async revalidateAnnualEntryHandoffInTransaction(_transaction, input) {
        if (input.expectedFingerprint !== CLEARANCE_FINGERPRINT) {
          const error = new Error('Academic prerequisites changed after handoff.');
          error.status = 409;
          throw error;
        }
        return { ready: true, fingerprint: CLEARANCE_FINGERPRINT };
      },
      async assertTermPrerequisitesInTransaction(_transaction, input) {
        if (input.expectedFingerprint !== CLEARANCE_FINGERPRINT) {
          const error = new Error('The term prerequisites changed.');
          error.status = 409;
          throw error;
        }
        return { ready: true, fingerprint: CLEARANCE_FINGERPRINT };
      }
    };
    const annualEnrollment = createAnnualEnrollmentService({ getPool: async () => appPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool), hashPassword: async (value) => `integration:${value}`,
      createPassword: () => 'integration-only-password', annualFinanceService: annualFinance, termClearanceService });

    async function registrarHandoffInput(annualId, idempotencyKey = uuid()) {
      const review = await annualEnrollment.getRegistrarHandoffStatus(registrarId, annualId, CLEARANCE_FINGERPRINT);
      return { clearanceFingerprint: CLEARANCE_FINGERPRINT,
        prerequisiteFingerprint: review.currentPrerequisiteFingerprint, idempotencyKey };
    }

    async function commitReviewedFinanceDraft(draft, commitContext = {}, replayResult = null) {
      const financeReviewActions = createFinanceReviewActionService({
        getPool: async () => appPool, sql, annualEnrollmentService: annualEnrollment,
        draftService: {
          async commitReviewedDraft({ previewInTransaction, applyInTransaction, commitContext: savedContext }) {
            if (replayResult) return { committed: true, replayed: true, result: structuredClone(replayResult) };
            const result = await runSerializableTransaction({ getPool: async () => appPool, sql,
              transactionFactory: (currentPool) => new Transaction(currentPool) }, async (transaction) => {
              await previewInTransaction(transaction, draft);
              return applyInTransaction(transaction, draft, { id: financeId, role: 'finance' }, savedContext);
            });
            return { committed: true, replayed: false, result };
          },
          async getDraft() { return draft; }
        }
      });
      return financeReviewActions.commit(financeId, 'd'.repeat(64), draft.id, draft.revision || 1,
        'e'.repeat(64), commitContext);
    }

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
      amount: '100.00', paymentDate: '2026-10-15', referenceNo: 'HANDOFF-CREDIT-100', idempotencyKey: uuid(), allocations: []
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
      amount: '100.00', paymentDate: '2026-10-15', referenceNo: 'HANDOFF-REVERSAL-100', idempotencyKey: uuid(),
      allocations: [{ chargeId: Number(dpCharge.id), amount: '100.00' }]
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'ready_for_registrar');
    await annualFinance.reversePayment(financeId, studentId, reversalPayment.paymentId, {
      reason: 'Test reversed payment before confirmation.', idempotencyKey: uuid()
    });
    await assertReadyState(annualFinance, registrarId, annualId, 'awaiting_down_payment',
      'reversed payments no longer settle DP');

    const settledPayment = await annualFinance.recordPayment(financeId, studentId, {
      amount: '100.00', paymentDate: '2026-10-15', referenceNo: 'HANDOFF-SETTLED-100', idempotencyKey: uuid(),
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
      amount: '1.00', paymentDate: '2026-10-15', referenceNo: 'HANDOFF-TOPUP-1', idempotencyKey: uuid(),
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
    const zeroEnrollmentIds = [];
    for (let index = 0; index < termIds.length; index += 1) {
      const termNumber = index + 1;
      const applicable = termNumber >= 2;
      const [placement] = await pool.execute(`INSERT INTO enrollments
        (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [Number(zeroStudent.insertId), termIds[index], sectionIds[index],
        applicable ? 'pending_payment' : 'not_applicable', zeroAnnualId, termNumber,
        applicable ? 'applicable' : 'not_applicable']);
      zeroEnrollmentIds.push(Number(placement.insertId));
    }
    const zeroHandoffKey = uuid();
    const zeroHandoffInput = await registrarHandoffInput(zeroAnnualId, zeroHandoffKey);
    await pool.execute('UPDATE enrollments SET section_id = ? WHERE id = ?', [alternateEntrySectionId, zeroEnrollmentIds[1]]);
    await assert.rejects(annualEnrollment.submitRegistrarHandoff(registrarId, zeroAnnualId,
      { ...zeroHandoffInput, idempotencyKey: uuid() }), { status: 409 },
    'a section edit after the Registrar review page was rendered invalidates its composite handoff fingerprint');
    await pool.execute('UPDATE enrollments SET section_id = ? WHERE id = ?', [sectionIds[1], zeroEnrollmentIds[1]]);
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_registrar_handoff_events WHERE annual_enrollment_id = ?',
      [zeroAnnualId]))[0][0].count), 0, 'stale rendered review creates no handoff event');
    const queuedHandoff = await annualEnrollment.submitRegistrarHandoff(registrarId, zeroAnnualId, zeroHandoffInput);
    assert.equal(queuedHandoff.status, 'awaiting_finance', 'Registrar handoff is saved before Finance evidence is ready');
    const repeatedQueuedHandoff = await annualEnrollment.submitRegistrarHandoff(registrarId, zeroAnnualId, zeroHandoffInput);
    assert.equal(repeatedQueuedHandoff.handoffId, queuedHandoff.handoffId);
    assert.equal(repeatedQueuedHandoff.alreadyHandedOff, true);
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
    const financeDraft = {
      id: uuid(), actionType: 'annual_assessment', idempotencyKey: uuid(),
      entityContext: { annualId: zeroAnnualId, studentId: Number(zeroStudent.insertId) },
      input: { scheduleId: String(zeroPreview.scheduleId), scheduleVersion: String(zeroPreview.scheduleVersion),
        voucherCode: zeroPreview.voucherCode, optionalLineId: [] }
    };
    const financeCommit = await commitReviewedFinanceDraft(financeDraft,
      { financeAssessmentAttestation: true, zeroDpApproval: true });
    const approvedZero = financeCommit.result;
    assert.ok(approvedZero.assessmentId > 0);
    const zeroActivation = approvedZero.enrollmentActivation[0];
    assert.equal(zeroActivation.status, 'activated',
      'the reviewed Finance commit automatically activates an already-handed-off zero-DP intake');
    const zeroReadiness = await assertReadyState(annualFinance, registrarId, zeroAnnualId, 'ready_for_registrar');
    assert.equal(zeroReadiness.zeroDownPaymentApproved, true);
    const confirmationEvidence = (await pool.execute(`SELECT id, confirmed_by, entry_dp_state_at_confirmation,
      registrar_handoff_event_id, finance_review_id, assessment_id
      FROM annual_registrar_confirmations WHERE annual_enrollment_id = ?`, [zeroAnnualId]))[0][0];
    assert.equal(confirmationEvidence.entry_dp_state_at_confirmation, 'zero_due');
    assert.equal(Number(confirmationEvidence.confirmed_by), registrarId,
      'the compatibility confirmation preserves the Registrar handoff actor');
    assert.equal(Number(confirmationEvidence.registrar_handoff_event_id), queuedHandoff.handoffId);
    assert.equal(Number(confirmationEvidence.finance_review_id), Number(zeroActivation.financeReviewId));
    assert.equal(Number(confirmationEvidence.assessment_id), Number(approvedZero.assessmentId));
    const activationEvidence = (await pool.execute(`SELECT id, activation_trigger, activated_by, activated_by_role,
      registrar_handoff_id, finance_review_id, assessment_id FROM annual_entry_activations
      WHERE annual_enrollment_id = ?`, [zeroAnnualId]))[0][0];
    assert.equal(activationEvidence.activation_trigger, 'finance_commit');
    assert.equal(activationEvidence.activated_by_role, 'finance');
    assert.equal(Number(activationEvidence.activated_by), financeId);
    assert.equal(Number(activationEvidence.registrar_handoff_id), queuedHandoff.handoffId);
    assert.equal(Number(activationEvidence.finance_review_id), Number(zeroActivation.financeReviewId));
    assert.equal(Number(activationEvidence.assessment_id), Number(approvedZero.assessmentId));
    assert.equal((await pool.execute('SELECT intake_status, account_activation_pending FROM annual_enrollments WHERE id = ?',
      [zeroAnnualId]))[0][0].intake_status, 'enrolled');
    assert.equal(Number((await pool.execute('SELECT account_activation_pending FROM annual_enrollments WHERE id = ?',
      [zeroAnnualId]))[0][0].account_activation_pending), 1,
    'automatic enrollment keeps first-login activation pending for Registrar');
    assert.equal((await pool.execute('SELECT enrollment_status FROM enrollments WHERE id = ?',
      [zeroEnrollmentIds[1]]))[0][0].enrollment_status, 'enrolled');
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_registrar_confirmations WHERE annual_enrollment_id = ?',
      [zeroAnnualId]))[0][0].count), 1);
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_entry_activations WHERE annual_enrollment_id = ?',
      [zeroAnnualId]))[0][0].count), 1, 'the activation row enforces exact-once enrollment');
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM finance_payments WHERE student_id = ?',
      [Number(zeroStudent.insertId)]))[0][0].count), 0, 'zero DP creates no artificial payment or receipt');
    assert.equal(Number((await pool.execute('SELECT is_active FROM users WHERE id = ?', [zeroStudentUserId]))[0][0].is_active), 0,
      'Finance enrollment activation does not issue a student password');
    const laterTerm = await annualEnrollment.finalizeAnnualTerm(registrarId, zeroEnrollmentIds[2], {
      clearanceSnapshotFingerprint: CLEARANCE_FINGERPRINT, idempotencyKey: uuid()
    });
    assert.equal(laterTerm.temporaryPassword, null,
      'later-term activation cannot create the legacy surname/date password on a new-flow record');
    assert.equal(Number((await pool.execute('SELECT is_active FROM users WHERE id = ?', [zeroStudentUserId]))[0][0].is_active), 0);
    const credential = await annualEnrollment.issueFirstLoginPasswordForFinance(financeId, zeroAnnualId, Number(zeroStudent.insertId));
    assert.equal(credential.temporaryPassword, 'integration-only-password');
    await assert.rejects(annualEnrollment.issueFirstLoginPasswordForFinance(financeId, zeroAnnualId, Number(zeroStudent.insertId)), { status: 409 },
      'Finance cannot issue a second first-login password for the same enrollment');
    await assert.rejects(annualEnrollment.issueFirstLoginPassword(registrarId, zeroAnnualId), { status: 409 },
      'the retained Registrar compatibility action cannot issue a second password after Finance has issued it');
    assert.equal(Number((await pool.execute('SELECT is_active FROM users WHERE id = ?', [zeroStudentUserId]))[0][0].is_active), 1);
    assert.equal(Number((await pool.execute('SELECT must_change_password FROM users WHERE id = ?', [zeroStudentUserId]))[0][0].must_change_password), 1);
    const printSheet = await annualFinance.getEntryEnrollmentPrintSheet(financeId, Number(zeroStudent.insertId), zeroAnnualId);
    assert.equal(printSheet.annual_enrollment_id, zeroAnnualId);
    assert.equal(printSheet.student_no, zeroStudentNumber);
    assert.ok(printSheet.assessment.lines.length > 0, 'the private Finance sheet loads the verified immutable assessment snapshot');
    assert.equal(printSheet.assessment.grossTotal, '70.00');
    assert.equal(printSheet.assessment.coverageTotal, '0.00');
    assert.equal(printSheet.email, credential.email, 'the printed credentials and enrollment sheet use the linked account email');
    assert.equal(Number((await pool.execute('SELECT account_activation_pending FROM annual_enrollments WHERE id = ?', [zeroAnnualId]))[0][0].account_activation_pending), 0);
    const printableSheets = await annualFinance.listEntryEnrollmentPrintSheets(financeId, Number(zeroStudent.insertId));
    assert.ok(printableSheets.some((sheet) => Number(sheet.annual_enrollment_id) === zeroAnnualId));
    await assert.rejects(annualFinance.getEntryEnrollmentPrintSheet(financeId, studentId, zeroAnnualId), { status: 404 },
      'the print service binds the exact student and annual enrollment pair');
    await assert.rejects(annualFinance.getEntryEnrollmentPrintSheet(registrarId, Number(zeroStudent.insertId), zeroAnnualId), { status: 403 },
      'only Finance can open the private enrollment sheet');

    const positiveLines = zeroLines.map((line) => ({ ...line,
      amount: line.termNumber === 2 && line.installment === 'DP' ? '100.00' : line.amount }));
    const positiveSchedule = await annualFinance.createSchedule(financeId, { schoolYear: '2026-2027', gradeLevel: 'Grade 11',
      voucherCode: 'PUB', lines: positiveLines, idempotencyKey: uuid() });
    const positiveUserId = await insertUser(pool, 'student', { active: false });
    const positiveLrn = String(300000000000 + Math.floor(Math.random() * 69999999999));
    const [positiveStudent] = await pool.execute(`INSERT INTO students
      (user_id, student_no, lrn, first_name, last_name, birth_date, status)
      VALUES (?, ?, ?, 'Pia', 'Paid', '2008-08-16', 'active')`,
    [positiveUserId, `HANDOFF-PAID-${process.pid}-${crypto.randomBytes(3).toString('hex')}`, positiveLrn]);
    const positiveStudentId = Number(positiveStudent.insertId);
    const positivePreEnrollmentId = uuid();
    await pool.execute(`INSERT INTO pre_enrollments
      (id, idempotency_key, request_fingerprint, school_year, first_name, middle_name, last_name, lrn,
        target_grade_level, email, status, created_by, updated_by, created_by_role, applicant_kind)
      VALUES (?, ?, ?, '2026-2027', 'Pia', 'May', 'Paid', ?, 'Grade 11', ?, 'enrollment_started', ?, ?, 'front_desk', 'new')`,
    [positivePreEnrollmentId, uuid(), 'f'.repeat(64), positiveLrn, `paid-${uuid()}@integration.invalid`, frontDeskId, frontDeskId]);
    const [positiveAnnual] = await pool.execute(`INSERT INTO annual_enrollments
      (student_id, school_year, grade_level, voucher_code, intake_status, created_by, intake_kind,
        entry_term_number, account_activation_pending, pre_enrollment_id)
      VALUES (?, '2026-2027', 'Grade 11', 'PUB', 'pending', ?, 'new', 2, 1, ?)`,
    [positiveStudentId, registrarId, positivePreEnrollmentId]);
    const positiveAnnualId = Number(positiveAnnual.insertId);
    const positiveEnrollmentIds = [];
    for (let index = 0; index < termIds.length; index += 1) {
      const termNumber = index + 1;
      const applicable = termNumber >= 2;
      const [placement] = await pool.execute(`INSERT INTO enrollments
        (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [positiveStudentId, termIds[index], sectionIds[index],
        applicable ? 'pending_payment' : 'not_applicable', positiveAnnualId, termNumber,
        applicable ? 'applicable' : 'not_applicable']);
      positiveEnrollmentIds.push(Number(placement.insertId));
    }
    const positiveHandoff = await annualEnrollment.submitRegistrarHandoff(registrarId, positiveAnnualId,
      await registrarHandoffInput(positiveAnnualId));
    assert.equal(positiveHandoff.status, 'awaiting_finance');
    await pool.execute('UPDATE enrollments SET section_id = ? WHERE id = ?', [alternateEntrySectionId, positiveEnrollmentIds[1]]);
    const positivePreview = await annualFinance.annualAssessmentPreview(financeId, positiveAnnualId);
    const assessmentDraft = {
      id: uuid(), actionType: 'annual_assessment', idempotencyKey: uuid(),
      entityContext: { annualId: positiveAnnualId, studentId: positiveStudentId },
      input: { scheduleId: String(positivePreview.scheduleId), scheduleVersion: String(positivePreview.scheduleVersion),
        voucherCode: positivePreview.voucherCode, optionalLineId: [] }
    };
    const assessedResult = await commitReviewedFinanceDraft(assessmentDraft, { financeAssessmentAttestation: true });
    assert.equal(assessedResult.result.enrollmentActivation[0].status, 'academic_review_required',
      'Finance assessment commits while a changed entry section requires a fresh Registrar handoff');
    await pool.execute('UPDATE enrollments SET section_id = ? WHERE id = ?', [sectionIds[1], positiveEnrollmentIds[1]]);
    const restoredRetry = await annualEnrollment.retryFinanceHandoffs(financeId, { annualEnrollmentId: positiveAnnualId });
    assert.equal(restoredRetry[0].status, 'academic_review_required',
      'restoring the old section fingerprint cannot unblock a handoff already marked for Registrar review');
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_entry_activations WHERE annual_enrollment_id = ?',
      [positiveAnnualId]))[0][0].count), 0);
    const refreshedPositiveHandoff = await annualEnrollment.submitRegistrarHandoff(registrarId, positiveAnnualId,
      await registrarHandoffInput(positiveAnnualId));
    assert.equal(refreshedPositiveHandoff.status, 'awaiting_finance',
      'a fresh Registrar handoff supersedes a saved academic-review blocker');
    const positiveAssessmentId = Number(assessedResult.result.assessmentId);
    const dpCharges = (await pool.execute(`SELECT enrollment.annual_term_number, charge.id, CAST(charge.amount AS CHAR(40)) AS amount
      FROM assessed_charges AS charge INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
      WHERE charge.assessment_id = ? AND charge.fee_category = 'tuition' AND charge.installment = 'DP'
        AND enrollment.annual_term_number IN (2, 3) ORDER BY enrollment.annual_term_number`, [positiveAssessmentId]))[0];
    const entryDpCharge = dpCharges.find((charge) => Number(charge.annual_term_number) === 2);
    const wrongTermDpCharge = dpCharges.find((charge) => Number(charge.annual_term_number) === 3);
    assert.ok(entryDpCharge && wrongTermDpCharge);
    const paymentDraft = (amount, allocation, reference) => ({
      id: uuid(), actionType: 'annual_payment', idempotencyKey: uuid(),
      entityContext: { studentId: positiveStudentId },
      input: { amount, paymentDate: '2026-11-18', referenceNo: reference, receiptIssued: '0',
        allocations: allocation ? [{ chargeId: String(allocation.chargeId), openingLiabilityId: null, amount: allocation.amount }] : [] }
    });
    const wrongTermDraft = paymentDraft('10.00', { chargeId: wrongTermDpCharge.id, amount: '10.00' }, 'WRONG-TERM-DP');
    const wrongTermCommit = await commitReviewedFinanceDraft(wrongTermDraft);
    assert.equal(wrongTermCommit.result.enrollmentActivation[0].status, 'awaiting_finance',
      'a payment allocated to another term does not satisfy the entry-term DP');
    assert.equal((await pool.execute('SELECT intake_status FROM annual_enrollments WHERE id = ?', [positiveAnnualId]))[0][0].intake_status,
      'pending');
    const paymentsBeforeReplay = Number((await pool.execute('SELECT COUNT(*) AS count FROM finance_payments WHERE student_id = ?',
      [positiveStudentId]))[0][0].count);
    const wrongTermReplay = await commitReviewedFinanceDraft(wrongTermDraft, {}, wrongTermCommit.result);
    assert.equal(wrongTermReplay.result.paymentId, wrongTermCommit.result.paymentId);
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM finance_payments WHERE student_id = ?',
      [positiveStudentId]))[0][0].count), paymentsBeforeReplay,
    'replaying a committed Finance payment rechecks activation without posting the payment again');
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_entry_activations WHERE annual_enrollment_id = ?',
      [positiveAnnualId]))[0][0].count), 0);
    const partialDraft = paymentDraft('50.00', { chargeId: entryDpCharge.id, amount: '50.00' }, 'PARTIAL-ENTRY-DP');
    const partialCommit = await commitReviewedFinanceDraft(partialDraft);
    assert.equal(partialCommit.result.enrollmentActivation[0].status, 'awaiting_finance',
      'a partial entry-term DP cannot activate enrollment');
    const creditDraft = paymentDraft('50.00', null, 'UNALLOCATED-DP-CREDIT');
    const creditCommit = await commitReviewedFinanceDraft(creditDraft);
    assert.equal(creditCommit.result.enrollmentActivation[0].status, 'awaiting_finance',
      'unallocated credit does not satisfy the exact entry-term DP');
    const finalEntryPaymentDraft = paymentDraft('50.00', { chargeId: entryDpCharge.id, amount: '50.00' }, 'FINAL-ENTRY-TERM-DP');
    const finalEntryPayment = await commitReviewedFinanceDraft(finalEntryPaymentDraft);
    const positiveActivation = finalEntryPayment.result.enrollmentActivation.find((activation) => activation.status === 'activated');
    assert.ok(positiveActivation,
      'a real reviewed payment commit automatically activates when it settles the remaining exact entry-term DP');
    assert.equal(positiveActivation.financeReviewId > 0, true);
    const directPaymentCount = Number((await pool.execute('SELECT COUNT(*) AS count FROM finance_payments WHERE student_id = ?',
      [positiveStudentId]))[0][0].count);
    const concurrentReplays = await Promise.all([
      commitReviewedFinanceDraft(finalEntryPaymentDraft, {}, finalEntryPayment.result),
      commitReviewedFinanceDraft(finalEntryPaymentDraft, {}, finalEntryPayment.result)
    ]);
    assert.ok(concurrentReplays.every((result) => result.committed && result.replayed));
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM finance_payments WHERE student_id = ?',
      [positiveStudentId]))[0][0].count), directPaymentCount,
    'replayed concurrent Finance commits never record the payment twice');
    assert.equal((await pool.execute('SELECT intake_status FROM annual_enrollments WHERE id = ?',
      [positiveAnnualId]))[0][0].intake_status, 'enrolled');
    assert.equal(Number((await pool.execute('SELECT account_activation_pending FROM annual_enrollments WHERE id = ?',
      [positiveAnnualId]))[0][0].account_activation_pending), 1);
    assert.equal((await pool.execute('SELECT enrollment_status FROM enrollments WHERE id = ?',
      [positiveEnrollmentIds[1]]))[0][0].enrollment_status, 'enrolled');
    const positiveActivationEvidence = (await pool.execute(`SELECT activation_trigger, activated_by_role,
      entry_dp_state, finance_review_id FROM annual_entry_activations WHERE annual_enrollment_id = ?`,
    [positiveAnnualId]))[0][0];
    assert.equal(positiveActivationEvidence.activation_trigger, 'finance_commit');
    assert.equal(positiveActivationEvidence.activated_by_role, 'finance');
    assert.equal(positiveActivationEvidence.entry_dp_state, 'settled');
    assert.equal(Number(positiveActivationEvidence.finance_review_id), Number(positiveActivation.financeReviewId));
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM finance_payments WHERE student_id = ?',
      [positiveStudentId]))[0][0].count), 4, 'wrong-term, partial, unallocated, and final entry-term payments are each recorded once');
    assert.equal(Number((await pool.execute('SELECT COUNT(*) AS count FROM annual_entry_activations WHERE annual_enrollment_id = ?',
      [positiveAnnualId]))[0][0].count), 1);
    const positiveAllocations = (await pool.execute(`SELECT enrollment.annual_term_number,
      CAST(SUM(net.net_amount) AS CHAR(40)) AS allocated_amount
      FROM v_finance_net_payment_allocations AS net
      INNER JOIN assessed_charges AS charge ON charge.id = net.charge_id
      INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
      WHERE charge.assessment_id = ? GROUP BY enrollment.annual_term_number ORDER BY enrollment.annual_term_number`,
    [positiveAssessmentId]))[0];
    assert.deepEqual(positiveAllocations.map((row) => [Number(row.annual_term_number), row.allocated_amount]),
      [[2, '100.00'], [3, '10.00']], 'only exact entry DP is required; another term allocation stays separate');
    const positiveSheet = await annualFinance.getEntryEnrollmentPrintSheet(financeId, positiveStudentId, positiveAnnualId);
    assert.equal(positiveSheet.school_year, '2026-2027');
    assert.equal(positiveSheet.entry_term_number, 2);
  } finally {
    if (pool) await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteDatabase(databaseName)}`).catch(() => {});
    await adminPool.end();
  }
});
