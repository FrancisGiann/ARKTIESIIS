'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const mysql = require('mysql2/promise');
const ejs = require('ejs');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { PoolFacade, sql } = require('../src/config/database');
const { createRetakeReferralService, RetakeReferralError } = require('../src/services/retakeReferralService');
const { createAnnualFinanceService, AnnualFinanceError } = require('../src/services/annualFinanceService');
const { createFinanceReviewActionService } = require('../src/services/financeReviewActionService');
const { FinanceReviewDraftError } = require('../src/services/financeReviewDraftService');
const { formatFinanceDateTime } = require('../src/utils/financeDateTime');

const socketPath = process.env.FINANCE_RETAKE_TEST_SOCKET;
const USER = process.env.FINANCE_RETAKE_TEST_USER || process.env.DB_USER || 'root';
const PASSWORD = process.env.FINANCE_RETAKE_TEST_PASSWORD ?? process.env.DB_PASSWORD ?? '';
const YEAR = '2026-2027';

function uuid() { return crypto.randomUUID(); }
function fingerprint() { return crypto.randomBytes(32).toString('hex'); }

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

test('retake referrals preserve revisions and decisions, validate Finance dependencies, and post one supplementary charge', {
  skip: !socketPath && 'Set FINANCE_RETAKE_TEST_SOCKET to a disposable local MariaDB socket.'
}, async () => {
  const databaseName = `arktiesiis_retake_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const adminPool = mysql.createPool({ socketPath, user: USER, password: PASSWORD, connectionLimit: 2 });
  let appPool;
  try {
    await adminPool.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    appPool = mysql.createPool({ socketPath, user: USER, password: '', database: databaseName,
      connectionLimit: 10, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false });
    const connection = await appPool.getConnection();
    try {
      await applyStatements(connection, readSqlFile(path.join(__dirname, '../database/mariadb/schema.sql')));
      for (const migration of readForwardMigrations()) {
        await applyStatements(connection, migration.statements);
        await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
      }
    } finally { connection.release(); }

    const [versions] = await appPool.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.equal(versions.at(-1)?.version, 'v2.021');

    async function createUser(role, label) {
      const [result] = await appPool.execute(`INSERT INTO users (email, password_hash, role, is_active)
        VALUES (?, 'synthetic-integration-only', ?, 1)`, [`retake-${label}-${uuid()}@example.test`, role]);
      return Number(result.insertId);
    }
    const registrarId = await createUser('registrar', 'registrar');
    const financeId = await createUser('finance', 'finance');
    const studentUserId = await createUser('student', 'student-login');
    const frontDeskId = await createUser('front_desk', 'front-desk');
    const [termResult] = await appPool.execute('INSERT INTO academic_terms (school_year, term) VALUES (?, ?)', [YEAR, 'Term 1']);
    const academicTermId = Number(termResult.insertId);
    const [scheduleResult] = await appPool.execute(`INSERT INTO finance_schedules
      (school_year, grade_level, voucher_code, version_no, idempotency_key, request_fingerprint, created_by)
      VALUES (?, 'Grade 11', 'PUB', 1, ?, ?, ?)`, [YEAR, uuid(), fingerprint(), financeId]);
    const scheduleId = Number(scheduleResult.insertId);
    const subjectResult = await appPool.execute('INSERT INTO subjects (subject_code, subject_name) VALUES (?, ?)',
      ['SYN-RETAKE', 'Synthetic Applied Systems and Extended Laboratory Module']);
    const subjectId = Number(subjectResult[0].insertId);

    async function createAnnual({ label, kind = 'transferee', assessment = true, evaluation = false }) {
      const lrn = String(900000000000 + Math.floor(Math.random() * 999999999));
      const [studentResult] = await appPool.execute(`INSERT INTO students
        (user_id, student_no, lrn, first_name, last_name, status)
        VALUES (NULL, ?, ?, 'Synthetic', ?, 'active')`,
      [`SYN-RETAKE-${uuid().slice(0, 8)}`, lrn, label]);
      const studentId = Number(studentResult.insertId);
      let evaluationId = null;
      if (evaluation) {
        evaluationId = uuid();
        await appPool.execute(`INSERT INTO readmission_evaluations
          (id, applicant_lrn, student_id, first_name, last_name, school_year, target_grade_level,
            prior_progress, evidence_reviewed, curriculum_comparison, curriculum_review_status,
            required_subjects, subject_availability, status, version, created_by, updated_by, decided_by, decided_at)
          VALUES (?, ?, ?, 'Synthetic', ?, ?, 'Grade 11', 'Synthetic progress reference',
            'Reviewed paper record', 'Comparison recorded in restricted evaluation', 'resolved',
            'Restricted evaluation detail remains out of Finance', 'available', 'accepted', 1, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [evaluationId, lrn, studentId, label, YEAR, registrarId, registrarId, registrarId]);
      }
      const [annualResult] = await appPool.execute(`INSERT INTO annual_enrollments
        (student_id, school_year, grade_level, voucher_code, intake_status, created_by, entry_term_number,
          intake_kind, readmission_evaluation_id, readmission_evaluation_version)
        VALUES (?, ?, 'Grade 11', 'PUB', 'enrolled', ?, 1, ?, ?, ?)` ,
      [studentId, YEAR, registrarId, kind, evaluationId, evaluationId ? 1 : null]);
      const annualId = Number(annualResult.insertId);
      const [enrollmentResult] = await appPool.execute(`INSERT INTO enrollments
        (student_id, academic_term_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status)
        VALUES (?, ?, 'enrolled', ?, 1, 'applicable')`, [studentId, academicTermId, annualId]);
      const enrollmentId = Number(enrollmentResult.insertId);
      if (assessment) await insertAssessment(annualId);
      await appPool.execute('INSERT INTO student_subjects (enrollment_id, subject_id) VALUES (?, ?)', [enrollmentId, subjectId]);
      await appPool.execute('INSERT INTO financial_accounts (student_id, balance) VALUES (?, 0.00)', [studentId]);
      return { studentId, annualId, enrollmentId, evaluationId, lrn };
    }

    async function insertAssessment(annualId) {
      const [result] = await appPool.execute(`INSERT INTO annual_assessments
        (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by,
          selection_json, idempotency_key, request_fingerprint)
        VALUES (?, ?, 1, 'PUB', ?, '{}', ?, ?)`, [annualId, scheduleId, financeId, uuid(), fingerprint()]);
      return Number(result.insertId);
    }

    const getPool = async () => new PoolFacade(appPool);
    const referralService = createRetakeReferralService({ getPool, sql });
    const annualFinanceService = createAnnualFinanceService({ getPool, sql });
    const financeActions = createFinanceReviewActionService({ getPool, sql });
    const binding = fingerprint();
    const safeInput = { subjectId: String(subjectId), subjectName: 'Ignored where catalog reference is selected',
      targetTerm: '1', financeExplanation: 'Approved repeat module for the new target term.\nReview only this operational explanation.' };

    const main = await createAnnual({ label: 'Transfer' });
    const [termTwoResult] = await appPool.execute('INSERT INTO academic_terms (school_year, term, is_current) VALUES (?, ?, 0)', [YEAR, 'Term 2']);
    const [termTwoEnrollmentResult] = await appPool.execute(`INSERT INTO enrollments
      (student_id, academic_term_id, enrollment_status, annual_enrollment_id, annual_term_number, term_scope_status)
      VALUES (?, ?, 'enrolled', ?, 2, 'applicable')`, [main.studentId, Number(termTwoResult.insertId), main.annualId]);
    const [termTwoSubjectResult] = await appPool.execute('INSERT INTO subjects (subject_code, subject_name) VALUES (?, ?)',
      ['SYN-RETAKE-T2', 'Synthetic Term Two Placement Subject']);
    await appPool.execute('INSERT INTO student_subjects (enrollment_id, subject_id) VALUES (?, ?)',
      [Number(termTwoEnrollmentResult.insertId), Number(termTwoSubjectResult.insertId)]);
    assert.deepEqual(await referralService.listTargetTerms(registrarId, main.annualId), [1, 2]);
    const targetSubjectChoices = await referralService.listTargetSubjects(registrarId, main.annualId);
    assert.ok(targetSubjectChoices.some((subject) => Number(subject.id) === subjectId && Number(subject.term_number) === 1));
    assert.ok(targetSubjectChoices.some((subject) => Number(subject.id) === Number(termTwoSubjectResult.insertId) && Number(subject.term_number) === 2));
    const mainDraft = await referralService.createDraft(registrarId, main.annualId, {
      evaluationReference: 'Registrar file TR-2026-001', idempotencyKey: uuid()
    });
    await assert.rejects(referralService.addItem(registrarId, mainDraft.referralId, {
      ...safeInput, subjectName: '   ', itemKeyToken: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 400);
    await assert.rejects(referralService.addItem(registrarId, mainDraft.referralId, {
      ...safeInput, subjectId: String(termTwoSubjectResult.insertId), itemKeyToken: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 409);
    const mainItem = await referralService.addItem(registrarId, mainDraft.referralId, { ...safeInput, itemKeyToken: uuid() });
    assert.equal((await referralService.finalize(registrarId, mainDraft.referralId)).itemCount, 1);
    const [mainItemRow] = await appPool.execute('SELECT item_key_id FROM registrar_retake_referral_items WHERE id = ?', [mainItem.itemId]);
    const itemKeyId = Number(mainItemRow[0].item_key_id);

    await assert.rejects(referralService.financeDecisionInTransaction(registrarId, itemKeyId, {
      decision: 'no_charge', reason: 'Registrar cannot decide Finance liability.', idempotencyKey: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 403);
    for (const disallowedActor of [studentUserId, frontDeskId]) {
      await assert.rejects(referralService.listTargets(disallowedActor),
        (error) => error instanceof RetakeReferralError && error.status === 403);
    }
    await assert.rejects(referralService.listFinanceQueue(studentUserId),
      (error) => error instanceof RetakeReferralError && error.status === 403);
    await assert.rejects(referralService.listFinanceQueue(frontDeskId),
      (error) => error instanceof RetakeReferralError && error.status === 403);

    const action = '/retake-referrals/items/' + itemKeyId + '/decision';
    await assert.rejects(annualFinanceService.addSupplementaryCharge(financeId, main.studentId, main.enrollmentId, {
      feeCategory: 'retake', lineName: 'Invalid\nmultiline charge name', installment: 'As incurred', amount: '1.00',
      reason: 'Valid reason', idempotencyKey: uuid()
    }), (error) => error instanceof AnnualFinanceError && /Supplementary charge name/.test(error.message),
    'single-line supplementary charge names still reject line breaks');
    await assert.rejects(annualFinanceService.addSupplementaryCharge(financeId, main.studentId, main.enrollmentId, {
      feeCategory: 'retake\ncategory', lineName: 'Retake validation probe', installment: 'As incurred', amount: '1.00',
      reason: 'Valid reason', idempotencyKey: uuid()
    }), (error) => error instanceof AnnualFinanceError && /Fee category/.test(error.message),
    'single-line fee categories still reject line breaks');
    await assert.rejects(annualFinanceService.addSupplementaryCharge(financeId, main.studentId, main.enrollmentId, {
      feeCategory: 'retake', lineName: 'Retake validation probe', installment: 'As incurred', amount: '1.00',
      reason: 'Invalid\u000bcontrol character', idempotencyKey: uuid()
    }), (error) => error instanceof AnnualFinanceError && /Supplementary charge reason/.test(error.message),
    'supplementary charge reasons reject controls other than tab and line feed');
    await assert.rejects(referralService.financeDecisionInTransaction(financeId, itemKeyId, {
      decision: 'charge', amount: '20.00', chargeDescription: 'Invalid\nmultiline description',
      reason: 'This reason is allowed to span lines.', idempotencyKey: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 400,
    'Finance charge descriptions remain single-line');
    const reviewInput = { decision: 'charge', amount: '20.00', chargeDescription: 'Repeat module assessment',
      reason: 'Approved for this referred module.\r\nReviewed against the annual assessment.\tRegistrar follow-up recorded.' };
    const normalizedChargeReason = 'Approved for this referred module.\nReviewed against the annual assessment.\tRegistrar follow-up recorded.';
    const createdDraft = await financeActions.startDraft(financeId, binding, action, reviewInput);
    const draft = await financeActions.freshReview(financeId, binding, createdDraft.id);
    assert.equal(draft.actionType, 'retake_item_decision');
    assert.equal(Number(draft.entityContext.annualId), main.annualId,
      'the resolved annual context is saved before exemption rows are fingerprinted');
    assert.equal(Number(draft.entityContext.enrollmentId), main.enrollmentId);
    const [exemptionCase] = await appPool.execute(`INSERT INTO finance_exemption_cases
      (annual_enrollment_id, status, requested_by, reviewed_by, review_reason, idempotency_key, request_fingerprint, reviewed_at)
      VALUES (?, 'approved', ?, ?, 'Synthetic matching exemption', ?, ?, UTC_TIMESTAMP(3))`,
    [main.annualId, registrarId, financeId, uuid(), fingerprint()]);
    await appPool.execute(`INSERT INTO finance_exemption_rules
      (exemption_case_id, term_number, fee_category, line_name, approved_amount)
      VALUES (?, 1, 'retake', 'Repeat module assessment', 4.50)`, [Number(exemptionCase.insertId)]);
    const stale = await financeActions.commit(financeId, binding, draft.id, draft.revision, draft.dependencyFingerprint);
    assert.equal(stale.stale, true, 'an approved exemption change invalidates the old review before any charge/adjustment exists');
    const refreshed = await financeActions.freshReview(financeId, binding, draft.id);
    assert.equal(refreshed.revision, draft.revision + 1, 'the stale review advances to a new revision before it can be saved');
    assert.notEqual(refreshed.dependencyFingerprint, draft.dependencyFingerprint);
    assert.equal(refreshed.preview.retakeDecision.charge.approvedExemption, '4.50');
    assert.equal(refreshed.preview.retakeDecision.charge.payableAmount, '15.50');
    const committed = await financeActions.commit(financeId, binding, refreshed.id, refreshed.revision, refreshed.dependencyFingerprint);
    assert.equal(committed.committed, true);
    const [posted] = await appPool.execute(`SELECT decision.id AS decision_id, decision.decision, decision.decision_reason, decision.charge_id,
        CAST(charge.gross_amount AS CHAR(40)) AS gross_amount, CAST(charge.waived_amount AS CHAR(40)) AS waived_amount,
        CAST(charge.amount AS CHAR(40)) AS assessed_amount, charge.reason AS charge_reason,
        application.id AS exemption_application_id
      FROM finance_retake_item_decisions AS decision INNER JOIN assessed_charges AS charge ON charge.id = decision.charge_id
      LEFT JOIN finance_exemption_applications AS application ON application.charge_id = charge.id
      WHERE decision.item_key_id = ? AND decision.superseded_at IS NULL`, [itemKeyId]);
    assert.equal(posted.length, 1);
    assert.deepEqual([posted[0].decision, posted[0].gross_amount, posted[0].waived_amount, posted[0].assessed_amount],
      ['charge', '20.00', '4.50', '20.00']);
    assert.equal(posted[0].decision_reason, normalizedChargeReason);
    assert.equal(posted[0].charge_reason, normalizedChargeReason,
      'the exact normalized multiline reason is stored on the supplementary charge');
    const [chargeAudit] = await appPool.execute(`SELECT details_json FROM audit_logs
      WHERE action = 'finance.supplementary_charge_added' AND entity_id = ?`, [String(posted[0].charge_id)]);
    const [decisionAudit] = await appPool.execute(`SELECT details_json FROM audit_logs
      WHERE action = 'finance.retake_item_decided' AND entity_id = ?`, [String(posted[0].decision_id)]);
    assert.equal(JSON.parse(chargeAudit[0].details_json).reason, normalizedChargeReason);
    assert.equal(JSON.parse(decisionAudit[0].details_json).reason, normalizedChargeReason,
      'both charge and Finance decision audit preserve the normalized text');
    assert.ok(posted[0].exemption_application_id, 'the normal supplementary charge path applies the same approved exemption exactly once');
    const [due] = await appPool.execute('SELECT CAST(amount_due AS CHAR(40)) AS amount_due FROM v_finance_assessed_charge_due WHERE charge_id = ?', [Number(posted[0].charge_id)]);
    assert.equal(due[0].amount_due, '15.50');

    const correction = await referralService.startCorrection(registrarId, mainDraft.referralId, uuid());
    await referralService.updateEvaluationReference(registrarId, correction.referralId, {
      evaluationReference: 'Corrected Registrar file TR-2026-001 · verified copy'
    });
    const corrected = await referralService.getReferral(registrarId, correction.referralId);
    assert.equal(Number(corrected.items[0].item_key_id), itemKeyId, 'a corrected version keeps its stable item identity');
    assert.equal(corrected.items[0].finance_decision, null, 'the earlier Finance decision remains attached to its original referral revision');
    assert.ok(corrected.items[0].stable_charge_id, 'the copied item separately exposes its stable posted-charge lock');
    assert.equal(Number(corrected.items[0].linked_charge_id), Number(posted[0].charge_id));
    const correctedMarkup = await ejs.renderFile(path.join(__dirname, '../views/retake-referrals/registrar-detail.ejs'), {
      title: 'Retake correction', csrfToken: 'synthetic-csrf', referral: corrected, history: [], subjects: [], termOptions: [1],
      values: {}, editValues: {}, referenceValue: null, error: null, itemKeyToken: uuid(), correctionToken: uuid(), formatFinanceDateTime
    });
    assert.match(correctedMarkup, /This linked charge stays in history/);
    assert.doesNotMatch(correctedMarkup, /Edit this draft item/, 'the corrected draft does not offer an editor for its posted-charge item');
    await assert.rejects(referralService.editItem(registrarId, correction.referralId, corrected.items[0].id, {
      ...safeInput, subjectId: '', subjectName: 'Repriced posted item'
    }), (error) => error instanceof RetakeReferralError && error.status === 409,
    'posted-charge items stay locked in the correction draft');
    await assert.rejects(referralService.removeItem(registrarId, correction.referralId, corrected.items[0].id),
      (error) => error instanceof RetakeReferralError && error.status === 409,
      'posted-charge items cannot be removed in the correction draft');
    assert.equal(corrected.evaluation_reference, 'Corrected Registrar file TR-2026-001 · verified copy');
    const referenceEvent = corrected.events.find((event) => event.event_type === 'reference_updated');
    assert.deepEqual(JSON.parse(referenceEvent.details_json), {
      previousReference: 'Registrar file TR-2026-001',
      evaluationReference: 'Corrected Registrar file TR-2026-001 · verified copy'
    }, 'the revision audit preserves the old and corrected safe reference');
    await referralService.finalize(registrarId, correction.referralId);
    await assert.rejects(referralService.financeDecisionInTransaction(financeId, itemKeyId, {
      decision: 'charge', amount: '1.00', chargeDescription: 'Duplicate', reason: 'Do not post twice.', idempotencyKey: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 409);
    const [chargeCount] = await appPool.execute('SELECT COUNT(*) AS count FROM finance_retake_item_decisions WHERE item_key_id = ? AND decision = \'charge\'', [itemKeyId]);
    assert.equal(Number(chargeCount[0].count), 1, 'a posted charge remains terminal across revisions');
    const [currentUnique] = await appPool.execute(`SELECT decision.current_item_key_id, decision.charge_item_key_id
      FROM finance_retake_item_decisions AS decision WHERE decision.item_key_id = ?`, [itemKeyId]);
    assert.equal(Number(currentUnique[0].current_item_key_id), itemKeyId);
    assert.equal(Number(currentUnique[0].charge_item_key_id), itemKeyId);

    const noChargeAnnual = await createAnnual({ label: 'NoCharge' });
    const noChargeDraft = await referralService.createDraft(registrarId, noChargeAnnual.annualId, {
      evaluationReference: 'Registrar file NC-2026-002', idempotencyKey: uuid()
    });
    const noChargeItem = await referralService.addItem(registrarId, noChargeDraft.referralId, {
      ...safeInput, subjectId: '', subjectName: 'Independent catalog module', itemKeyToken: uuid()
    });
    await referralService.finalize(registrarId, noChargeDraft.referralId);
    const [noChargeKey] = await appPool.execute('SELECT item_key_id FROM registrar_retake_referral_items WHERE id = ?', [noChargeItem.itemId]);
    const noChargeItemKey = Number(noChargeKey[0].item_key_id);
    const noChargeReasonInput = 'No additional charge is approved for this module.\r\nThe Registrar referral remains on record.';
    const normalizedNoChargeReason = 'No additional charge is approved for this module.\nThe Registrar referral remains on record.';
    await referralService.financeDecisionInTransaction(financeId, noChargeItemKey, {
      decision: 'no_charge', reason: noChargeReasonInput, idempotencyKey: uuid()
    });
    const [noChargeEvidence] = await appPool.execute(`SELECT id, decision_reason FROM finance_retake_item_decisions
      WHERE item_key_id = ? AND decision = 'no_charge' AND superseded_at IS NULL`, [noChargeItemKey]);
    assert.equal(noChargeEvidence[0].decision_reason, normalizedNoChargeReason,
      'no-charge decisions also preserve normalized multiline reasons');
    const [noChargeAudit] = await appPool.execute(`SELECT details_json FROM audit_logs
      WHERE action = 'finance.retake_item_decided' AND entity_id = ?`, [String(noChargeEvidence[0].id)]);
    assert.equal(JSON.parse(noChargeAudit[0].details_json).reason, normalizedNoChargeReason);
    const noChargeCorrection = await referralService.startCorrection(registrarId, noChargeDraft.referralId, uuid());
    const revisionTwo = await referralService.getReferral(registrarId, noChargeCorrection.referralId);
    assert.equal(Number(revisionTwo.items[0].item_key_id), noChargeItemKey);
    await referralService.editItem(registrarId, noChargeCorrection.referralId, revisionTwo.items[0].id, {
      ...safeInput, subjectId: '', subjectName: 'Independent catalog module (corrected)', targetTerm: '1',
      financeExplanation: 'Corrected operational context, still without restricted evaluation notes.'
    });
    await referralService.finalize(registrarId, noChargeCorrection.referralId);
    const [decisionsAfterCorrection] = await appPool.execute(`SELECT decision, superseded_at, referral_item_id
      FROM finance_retake_item_decisions WHERE item_key_id = ? ORDER BY id`, [noChargeItemKey]);
    assert.deepEqual(decisionsAfterCorrection.map((row) => [row.decision, row.superseded_at == null]), [['no_charge', false]],
      'only explicit correction finalization supersedes prior no-charge evidence');
    await referralService.financeDecisionInTransaction(financeId, noChargeItemKey, {
      decision: 'charge', amount: '18.00', chargeDescription: 'Corrected independent module retake',
      reason: 'Fresh Finance review after the Registrar correction approves this charge.', idempotencyKey: uuid()
    });
    const [decisionHistory] = await appPool.execute(`SELECT decision, superseded_at FROM finance_retake_item_decisions
      WHERE item_key_id = ? ORDER BY id`, [noChargeItemKey]);
    assert.deepEqual(decisionHistory.map((row) => [row.decision, row.superseded_at == null]), [
      ['no_charge', false], ['charge', true]
    ], 'the original no-charge evidence remains while the corrected revision receives a current charge');
    const originalNoChargeView = await referralService.getReferral(registrarId, noChargeDraft.referralId);
    assert.equal(originalNoChargeView.items[0].finance_decision, 'no_charge');
    assert.equal(originalNoChargeView.items[0].stable_charge_id, null,
      'an earlier no-charge revision does not display charge data from a later current revision');
    const originalNoChargeMarkup = await ejs.renderFile(path.join(__dirname, '../views/retake-referrals/registrar-detail.ejs'), {
      title: 'Historical retake referral', csrfToken: 'synthetic-csrf', referral: originalNoChargeView, history: [], subjects: [], termOptions: [1],
      values: {}, editValues: {}, referenceValue: null, error: null, itemKeyToken: uuid(), correctionToken: uuid(), formatFinanceDateTime
    });
    assert.match(originalNoChargeMarkup, /Finance · no charge/);
    assert.doesNotMatch(originalNoChargeMarkup, /Linked charge/, 'an earlier referral shows only its exact no-charge decision');
    await assert.rejects(referralService.financeDecisionInTransaction(financeId, noChargeItemKey, {
      decision: 'charge', amount: '18.00', chargeDescription: 'Duplicate corrected module charge',
      reason: 'Must not create a second charge for the same stable item.', idempotencyKey: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 409);
    const [revisedChargeCount] = await appPool.execute(`SELECT COUNT(*) AS count FROM finance_retake_item_decisions
      WHERE item_key_id = ? AND decision = 'charge'`, [noChargeItemKey]);
    assert.equal(Number(revisedChargeCount[0].count), 1, 'a corrected no-charge item can receive one charge, never two');

    const returning = await createAnnual({ label: 'Return', kind: 'returning', evaluation: true });
    const returningDraft = await referralService.createDraft(registrarId, returning.annualId, {
      evaluationReference: 'Registrar return evaluation record RV-1', idempotencyKey: uuid()
    });
    const returningItem = await referralService.addItem(registrarId, returningDraft.referralId, { ...safeInput, itemKeyToken: uuid() });
    await referralService.finalize(registrarId, returningDraft.referralId);
    const [returnKey] = await appPool.execute('SELECT item_key_id FROM registrar_retake_referral_items WHERE id = ?', [returningItem.itemId]);
    const returnItemKey = Number(returnKey[0].item_key_id);
    await appPool.execute('UPDATE readmission_evaluations SET version = 2 WHERE id = ?', [returning.evaluationId]);
    await appPool.execute('UPDATE annual_enrollments SET readmission_evaluation_version = 2 WHERE id = ?', [returning.annualId]);
    await assert.rejects(referralService.financeDecisionInTransaction(financeId, returnItemKey, {
      decision: 'no_charge', reason: 'Should reject the stale accepted evaluation version.', idempotencyKey: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 409);
    const returnCorrection = await referralService.startCorrection(registrarId, returningDraft.referralId, uuid());
    const correctedReturn = await referralService.getReferral(registrarId, returnCorrection.referralId);
    assert.equal(correctedReturn.readmission_evaluation_id, returning.evaluationId);
    assert.equal(Number(correctedReturn.readmission_evaluation_version), 2,
      'Registrar correction explicitly binds to the newly accepted evaluation version');
    await referralService.finalize(registrarId, returnCorrection.referralId);
    await referralService.financeDecisionInTransaction(financeId, returnItemKey, {
      decision: 'no_charge', reason: 'Reviewed current accepted evaluation binding.', idempotencyKey: uuid()
    });

    const removedBinding = await createAnnual({ label: 'RemovedBinding', kind: 'returning', evaluation: true });
    const removedDraft = await referralService.createDraft(registrarId, removedBinding.annualId, {
      evaluationReference: 'Registrar return evaluation record RV-2', idempotencyKey: uuid()
    });
    const removedItem = await referralService.addItem(registrarId, removedDraft.referralId, { ...safeInput, itemKeyToken: uuid() });
    await referralService.finalize(registrarId, removedDraft.referralId);
    const [removedKey] = await appPool.execute('SELECT item_key_id FROM registrar_retake_referral_items WHERE id = ?', [removedItem.itemId]);
    await appPool.execute(`UPDATE annual_enrollments SET readmission_evaluation_id = NULL,
      readmission_evaluation_version = NULL WHERE id = ?`, [removedBinding.annualId]);
    await assert.rejects(referralService.financeDecisionInTransaction(financeId, Number(removedKey[0].item_key_id), {
      decision: 'no_charge', reason: 'A removed saved evaluation binding cannot be silently accepted.', idempotencyKey: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 409);

    const noAssessment = await createAnnual({ label: 'NoAssessment', assessment: false });
    const unassessedDraft = await referralService.createDraft(registrarId, noAssessment.annualId, {
      evaluationReference: 'Registrar record NA-1', idempotencyKey: uuid()
    });
    const unassessedItem = await referralService.addItem(registrarId, unassessedDraft.referralId, { ...safeInput, itemKeyToken: uuid() });
    await referralService.finalize(registrarId, unassessedDraft.referralId);
    const [unassessedKey] = await appPool.execute('SELECT item_key_id FROM registrar_retake_referral_items WHERE id = ?', [unassessedItem.itemId]);
    await assert.rejects(referralService.financeDecisionInTransaction(financeId, Number(unassessedKey[0].item_key_id), {
      decision: 'no_charge', reason: 'An assessment is required even for no charge.', idempotencyKey: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 409);

    const cancelled = await createAnnual({ label: 'Cancelled' });
    const cancelledDraft = await referralService.createDraft(registrarId, cancelled.annualId, {
      evaluationReference: 'Registrar record C-1', idempotencyKey: uuid()
    });
    const cancelledItem = await referralService.addItem(registrarId, cancelledDraft.referralId, { ...safeInput, itemKeyToken: uuid() });
    await referralService.finalize(registrarId, cancelledDraft.referralId);
    const [cancelledKey] = await appPool.execute('SELECT item_key_id FROM registrar_retake_referral_items WHERE id = ?', [cancelledItem.itemId]);
    await appPool.execute("UPDATE annual_enrollments SET intake_status = 'cancelled' WHERE id = ?", [cancelled.annualId]);
    await assert.rejects(referralService.financeDecisionInTransaction(financeId, Number(cancelledKey[0].item_key_id), {
      decision: 'no_charge', reason: 'Cancelled annual enrollment cannot receive a decision.', idempotencyKey: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 409);

    const archived = await createAnnual({ label: 'Archived' });
    const archivedDraft = await referralService.createDraft(registrarId, archived.annualId, {
      evaluationReference: 'Registrar record A-1', idempotencyKey: uuid()
    });
    const archivedItem = await referralService.addItem(registrarId, archivedDraft.referralId, { ...safeInput, itemKeyToken: uuid() });
    await referralService.finalize(registrarId, archivedDraft.referralId);
    const [archivedKey] = await appPool.execute('SELECT item_key_id FROM registrar_retake_referral_items WHERE id = ?', [archivedItem.itemId]);
    await appPool.execute("UPDATE students SET status = 'archived' WHERE id = ?", [archived.studentId]);
    await assert.rejects(referralService.financeDecisionInTransaction(financeId, Number(archivedKey[0].item_key_id), {
      decision: 'no_charge', reason: 'Archived student cannot receive a decision.', idempotencyKey: uuid()
    }), (error) => error instanceof RetakeReferralError && error.status === 409);

    const assessmentChange = await createAnnual({ label: 'AssessmentChange' });
    const assessmentDraft = await referralService.createDraft(registrarId, assessmentChange.annualId, {
      evaluationReference: 'Registrar record AC-1', idempotencyKey: uuid()
    });
    const assessmentItem = await referralService.addItem(registrarId, assessmentDraft.referralId, { ...safeInput, itemKeyToken: uuid() });
    await referralService.finalize(registrarId, assessmentDraft.referralId);
    const [assessmentKey] = await appPool.execute('SELECT item_key_id FROM registrar_retake_referral_items WHERE id = ?', [assessmentItem.itemId]);
    const assessmentPath = `/retake-referrals/items/${assessmentKey[0].item_key_id}/decision`;
    const createdAssessmentDraft = await financeActions.startDraft(financeId, binding, assessmentPath, {
      decision: 'no_charge', reason: 'Fresh review required if assessment changes.'
    });
    const assessmentDraftFinance = await financeActions.freshReview(financeId, binding, createdAssessmentDraft.id);
    await appPool.execute('DELETE FROM annual_assessments WHERE annual_enrollment_id = ?', [assessmentChange.annualId]);
    await insertAssessment(assessmentChange.annualId);
    const assessmentStale = await financeActions.commit(financeId, binding, assessmentDraftFinance.id,
      assessmentDraftFinance.revision, assessmentDraftFinance.dependencyFingerprint);
    assert.equal(assessmentStale.stale, true, 'changing the saved annual assessment invalidates a pending Finance review');

    const correctionDuringReviewAnnual = await createAnnual({ label: 'CorrectionDuringReview' });
    const correctionDuringReviewReferral = await referralService.createDraft(registrarId, correctionDuringReviewAnnual.annualId, {
      evaluationReference: 'Registrar record CR-1', idempotencyKey: uuid()
    });
    const correctionDuringReviewItem = await referralService.addItem(registrarId, correctionDuringReviewReferral.referralId,
      { ...safeInput, itemKeyToken: uuid() });
    await referralService.finalize(registrarId, correctionDuringReviewReferral.referralId);
    const [correctionDuringReviewKey] = await appPool.execute(
      'SELECT item_key_id FROM registrar_retake_referral_items WHERE id = ?', [correctionDuringReviewItem.itemId]);
    const correctionDuringReviewKeyId = Number(correctionDuringReviewKey[0].item_key_id);
    const correctionDuringReviewInput = { decision: 'charge', amount: '19.00',
      chargeDescription: 'Correction during review retake', reason: 'Reviewed before Registrar correction.' };
    const correctionDuringReviewAction = `/retake-referrals/items/${correctionDuringReviewKeyId}/decision`;
    const pendingCorrectionReview = await financeActions.startDraft(financeId, binding,
      correctionDuringReviewAction, correctionDuringReviewInput);
    const reviewedBeforeCorrection = await financeActions.freshReview(financeId, binding, pendingCorrectionReview.id);
    const registrarCorrection = await referralService.startCorrection(registrarId,
      correctionDuringReviewReferral.referralId, uuid());
    await assert.rejects(financeActions.freshReview(financeId, binding, reviewedBeforeCorrection.id),
      (error) => error instanceof FinanceReviewDraftError && error.status === 409,
      'a pending retake review cannot refresh against an unfinished Registrar correction');
    await assert.rejects(financeActions.commit(financeId, binding, reviewedBeforeCorrection.id,
      reviewedBeforeCorrection.revision, reviewedBeforeCorrection.dependencyFingerprint),
    (error) => error instanceof FinanceReviewDraftError && error.status === 409,
    'confirming while a Registrar correction is unfinished returns a recoverable conflict');
    const retainedReview = await financeActions.getDraft(financeId, reviewedBeforeCorrection.id);
    assert.equal(retainedReview.status, 'pending');
    assert.equal(retainedReview.input.amount, '19.00', 'the saved Finance amount remains editable for fresh review');
    const [prematureDecisionCount] = await appPool.execute(
      'SELECT COUNT(*) AS count FROM finance_retake_item_decisions WHERE item_key_id = ?', [correctionDuringReviewKeyId]);
    const [prematureChargeCount] = await appPool.execute(`SELECT COUNT(*) AS count FROM assessed_charges
      WHERE annual_enrollment_id = ? AND fee_category = 'retake' AND line_name = ?`,
    [correctionDuringReviewAnnual.annualId, correctionDuringReviewInput.chargeDescription]);
    assert.equal(Number(prematureDecisionCount[0].count), 0, 'an unfinished correction cannot save a Finance decision');
    assert.equal(Number(prematureChargeCount[0].count), 0, 'an unfinished correction cannot post a supplementary charge');

    await referralService.finalize(registrarId, registrarCorrection.referralId);
    const refreshedCorrectionReview = await financeActions.freshReview(financeId, binding, reviewedBeforeCorrection.id);
    assert.ok(refreshedCorrectionReview.revision > reviewedBeforeCorrection.revision,
      'finalizing the Registrar correction advances the Finance review for explicit re-review');
    assert.equal(refreshedCorrectionReview.requiresReview, true);
    assert.equal(refreshedCorrectionReview.input.amount, '19.00');
    const correctionCommit = await financeActions.commit(financeId, binding, refreshedCorrectionReview.id,
      refreshedCorrectionReview.revision, refreshedCorrectionReview.dependencyFingerprint);
    assert.equal(correctionCommit.committed, true);
    const [correctedDecisionCount] = await appPool.execute(
      'SELECT COUNT(*) AS count FROM finance_retake_item_decisions WHERE item_key_id = ?', [correctionDuringReviewKeyId]);
    const [correctedChargeCount] = await appPool.execute(`SELECT COUNT(*) AS count FROM assessed_charges
      WHERE annual_enrollment_id = ? AND fee_category = 'retake' AND line_name = ?`,
    [correctionDuringReviewAnnual.annualId, correctionDuringReviewInput.chargeDescription]);
    assert.equal(Number(correctedDecisionCount[0].count), 1);
    assert.equal(Number(correctedChargeCount[0].count), 1, 'the charge posts only after finalized correction and a fresh review');

    const duplicateRaceAnnual = await createAnnual({ label: 'Race' });
    const raceDraft = await referralService.createDraft(registrarId, duplicateRaceAnnual.annualId, {
      evaluationReference: 'Registrar record R-1', idempotencyKey: uuid()
    });
    const raceItem = await referralService.addItem(registrarId, raceDraft.referralId, { ...safeInput, itemKeyToken: uuid() });
    await referralService.finalize(registrarId, raceDraft.referralId);
    const [raceKey] = await appPool.execute('SELECT item_key_id FROM registrar_retake_referral_items WHERE id = ?', [raceItem.itemId]);
    const raceKeyId = Number(raceKey[0].item_key_id);
    const raceInputs = ['20.00', '24.00'].map((amount) => ({ decision: 'charge', amount,
      chargeDescription: 'Concurrent retake supplementary charge', reason: `Synthetic concurrent approved amount ${amount}.`, idempotencyKey: uuid() }));
    const race = await Promise.allSettled(raceInputs.map((input) => referralService.financeDecisionInTransaction(financeId, raceKeyId, input)));
    assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1,
      'transaction locking allows exactly one Finance decision under concurrent attempts');
    const [raceDecisions] = await appPool.execute('SELECT COUNT(*) AS count FROM finance_retake_item_decisions WHERE item_key_id = ?', [raceKeyId]);
    const [raceCharges] = await appPool.execute(`SELECT COUNT(*) AS count FROM assessed_charges
      WHERE annual_enrollment_id = ? AND fee_category = 'retake' AND line_name = 'Concurrent retake supplementary charge'`, [duplicateRaceAnnual.annualId]);
    assert.equal(Number(raceDecisions[0].count), 1);
    assert.equal(Number(raceCharges[0].count), 1, 'no duplicate supplementary charge is created by a racing decision');
  } finally {
    await appPool?.end().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS \`${databaseName}\``).catch(() => {});
    await adminPool.end();
  }
});
