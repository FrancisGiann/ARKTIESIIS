const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');
const { parseMoneyCents, formatMoneyCents } = require('./financeService');
const { createFinanceDebtRevisionService } = require('./financeDebtRevisionService');
const { runSerializableTransaction } = require('./transactionRetry');

const ID = /^\d{1,10}$/;
const BIG_ID = /^\d{1,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(['tuition', 'miscellaneous', 'uniform', 'id', 'activity', 'retake', 'other']);

class FinanceCasesError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'FinanceCasesError';
    this.status = status;
  }
}

function validId(value, label, large = false) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !(large ? BIG_ID : ID).test(raw)) throw new FinanceCasesError(`Choose a valid ${label}.`);
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || (!large && numeric > 2147483647)) throw new FinanceCasesError(`Choose a valid ${label}.`);
  return numeric;
}

function text(value, label, max, required = false) {
  if (typeof value !== 'string') throw new FinanceCasesError(`${label} must be ${max} printable characters or fewer.`);
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > max || /[\u0000-\u001f\u007f]/.test(cleaned)) throw new FinanceCasesError(`${label} is required and must be ${max} printable characters or fewer.`);
  return cleaned || null;
}

function token(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceCasesError(`The ${label} token is invalid. Reload the form and try again.`);
  return value;
}

function requestFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function formatDbId(value, label) {
  if (value && typeof value === 'object' && ('insertId' in value || 'recordset' in value)) {
    value = value.insertId || value.recordset?.[0]?.id;
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error(`${label} insert returned no safe identifier.`);
  return numeric;
}

function normalizeRules(value, entryTermNumber) {
  let rules = value;
  if (typeof rules === 'string') {
    try { rules = JSON.parse(rules); } catch { throw new FinanceCasesError('Exemption coverage rows are invalid.'); }
  }
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 30) throw new FinanceCasesError('Add between 1 and 30 exemption coverage rows.');
  const normalized = rules.map((rule, index) => {
    const termNumber = Number(rule.termNumber);
    if (!Number.isInteger(termNumber) || termNumber < entryTermNumber || termNumber > 3) throw new FinanceCasesError(`Coverage row ${index + 1} must apply to an eligible entry term or later.`);
    const feeCategory = rule.feeCategory ? text(rule.feeCategory, `Fee category on row ${index + 1}`, 40, true) : null;
    if (feeCategory && !CATEGORIES.has(feeCategory)) throw new FinanceCasesError(`Choose a supported fee category on row ${index + 1}.`);
    const lineName = rule.lineName ? text(rule.lineName, `Fee name on row ${index + 1}`, 120, true) : null;
    if (!feeCategory && !lineName) throw new FinanceCasesError(`Coverage row ${index + 1} must name a fee category or fee line.`);
    const fullCoverage = rule.isFullCoverage === true || rule.isFullCoverage === 1 || rule.isFullCoverage === '1' || rule.isFullCoverage === 'on';
    const approvedAmountCents = parseMoneyCents(String(rule.approvedAmount ?? (fullCoverage ? '0.00' : '')), { allowZero: fullCoverage });
    if (fullCoverage && approvedAmountCents !== 0n) throw new FinanceCasesError('Full coverage rows use a zero cap; the rule covers each matching charge in scope.');
    return { termNumber, feeCategory, lineName, isFullCoverage: fullCoverage, approvedAmountCents };
  });
  return normalized;
}

function normalizeAdjustmentRows(value) {
  let rows = value;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { throw new FinanceCasesError('Departure adjustment rows are invalid.'); }
  }
  if (rows == null) return [];
  if (!Array.isArray(rows) || rows.length > 60) throw new FinanceCasesError('A departure review may include up to 60 charge corrections.');
  return rows.filter((row) => row && String(row.amount || '').trim() !== '').map((row) => ({
    chargeId: validId(row.chargeId, 'charge', true),
    amountCents: parseMoneyCents(String(row.amount), { allowZero: false }),
    reason: text(row.reason || '', 'Correction reason', 1000, true)
  }));
}

function createAnnualFinanceCasesService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  transaction: boundTransaction = null,
  debtRevisions = createFinanceDebtRevisionService({ getPool, sql, transactionFactory, transaction: boundTransaction })
  } = {}) {
  async function transaction(callback) {
    try {
      if (boundTransaction) return await callback(boundTransaction);
      return await runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new FinanceCasesError('This finance workflow was already recorded or conflicts with an existing record.', 409);
      throw error;
    }
  }

  async function requireActor(request, actorInput) {
    const actorId = validId(actorInput, 'user');
    const result = await request.input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin') FOR UPDATE`);
    const actor = result.recordset?.[0];
    if (!actor) throw new FinanceCasesError('Your finance access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function writeAudit(tx, actor, action, entityId, details) {
    const rolePrefix = actor.role === 'database_admin' ? 'database_admin.finance_' : actor.role === 'registrar'
      ? 'registrar.finance_' : 'finance.';
    await tx.request().input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), `${rolePrefix}${action}`)
      .input('entityType', sql.NVarChar(100), 'annual_finance_case')
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  async function requireAnnual(tx, annualEnrollmentId) {
    const result = await tx.request().input('annualId', sql.Int, annualEnrollmentId)
      .query(`SELECT annual.id, annual.student_id, annual.school_year, annual.grade_level, annual.entry_term_number,
          annual.intake_status, student.status AS student_status
        FROM annual_enrollments AS annual
        INNER JOIN students AS student  ON student.id = annual.student_id
        WHERE annual.id = @annualId AND annual.intake_status <> 'legacy' FOR UPDATE`);
    const row = result.recordset?.[0];
    if (!row) throw new FinanceCasesError('Annual enrollment not found.', 404);
    if (row.student_status === 'archived') throw new FinanceCasesError('Archived students are read-only.', 409);
    return row;
  }

  async function requireFreshApproval(tx, actor, enrollmentId, reason) {
    const result = await tx.request().input('enrollmentId', sql.Int, enrollmentId)
      .query(`SELECT enrollment.enrollment_status, annual.intake_status, approval.status
        FROM enrollments AS enrollment
        INNER JOIN annual_enrollments AS annual  ON annual.id = enrollment.annual_enrollment_id
        LEFT JOIN term_finance_approvals AS approval  ON approval.enrollment_id = enrollment.id
        WHERE enrollment.id = @enrollmentId FOR UPDATE`);
    const current = result.recordset?.[0];
    // Do not mutate historical approval rows for the registrar-confirmed
    // annual workflow. Financial case audit remains separate from enrollment.
    if (!current || current.intake_status !== 'legacy') return;
    if (current.status !== 'approved' || !['pending_payment', 'enrolled'].includes(current.enrollment_status)) return;
    const finalized = current.enrollment_status === 'enrolled';
    await tx.request().input('enrollmentId', sql.Int, enrollmentId).input('actorId', sql.Int, actor.id)
      .input('reason', sql.NVarChar(1000), reason).input('finalized', sql.Bit, finalized)
      .query(`UPDATE term_finance_approvals SET
          status = CASE WHEN @finalized = 1 THEN status ELSE 'pending' END,
          approved_by = CASE WHEN @finalized = 1 THEN approved_by ELSE NULL END,
          approved_at = CASE WHEN @finalized = 1 THEN approved_at ELSE NULL END,
          approval_reason = CASE WHEN @finalized = 1 THEN approval_reason ELSE NULL END,
          finance_review_required = @finalized,
          finance_review_reason = CASE WHEN @finalized = 1 THEN @reason ELSE NULL END,
          finance_review_requested_by = CASE WHEN @finalized = 1 THEN @actorId ELSE NULL END,
          finance_review_requested_at = CASE WHEN @finalized = 1 THEN UTC_TIMESTAMP(6) ELSE NULL END
        WHERE enrollment_id = @enrollmentId AND status = 'approved'`);
    await writeAudit(tx, actor, finalized ? 'finance_review_required' : 'term_approval_reopened', enrollmentId, { reason, enrollmentPreserved: finalized });
  }

  async function releaseOverpayment(tx, actor, chargeId, reason) {
    const dueResult = await tx.request().input('chargeId', sql.BigInt, chargeId)
      .query('SELECT amount_due FROM v_finance_assessed_charge_due WHERE charge_id = @chargeId');
    let excess = parseMoneyCents(String(dueResult.recordset?.[0]?.amount_due || '0.00'), { allowNegative: true, allowZero: true });
    excess = -excess;
    if (excess <= 0n) return;
    const allocations = await tx.request().input('chargeId', sql.BigInt, chargeId)
      .query(`SELECT allocation.allocation_id, CAST(allocation.net_amount AS CHAR(40)) AS amount
        FROM v_finance_net_payment_allocations AS allocation
        INNER JOIN finance_payments AS payment  ON payment.id = allocation.payment_id
        WHERE allocation.charge_id = @chargeId AND payment.is_reversed = 0 AND allocation.net_amount > 0
        ORDER BY payment.payment_date, payment.id, allocation.allocation_id`);
    for (const allocation of allocations.recordset || []) {
      if (excess <= 0n) break;
      const available = parseMoneyCents(String(allocation.amount));
      const release = available < excess ? available : excess;
      const key = crypto.randomUUID();
      const fp = requestFingerprint({ kind: 'exemption-release', allocationId: Number(allocation.allocation_id), amount: formatMoneyCents(release), reason });
      await tx.request().input('allocationId', sql.BigInt, allocation.allocation_id)
        .input('amount', sql.Decimal(12, 2), formatMoneyCents(release)).input('reason', sql.NVarChar(1000), reason)
        .input('key', sql.UniqueIdentifier, key).input('fingerprint', sql.NVarChar(64), fp).input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO finance_payment_allocation_releases
          (allocation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
          VALUES (@allocationId, @amount, @reason, @key, @fingerprint, @actorId)`);
      excess -= release;
    }
    if (excess > 0n) {
      const accountResult = await tx.request().input('chargeId', sql.BigInt, chargeId)
        .query(`SELECT account.id FROM assessed_charges AS charge
          INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
          INNER JOIN financial_accounts AS account  ON account.student_id = annual.student_id
          WHERE charge.id = @chargeId FOR UPDATE`);
      const accountId = accountResult.recordset?.[0]?.id;
      const reconciliations = await tx.request().input('chargeId', sql.BigInt, chargeId)
        .query(`SELECT reconciliation.reconciliation_id, reconciliation.transaction_id,
            CAST(reconciliation.net_amount AS CHAR(40)) AS amount, legacy.financial_account_id
          FROM v_finance_net_legacy_reconciliations AS reconciliation
          INNER JOIN financial_transactions AS legacy  ON legacy.id = reconciliation.transaction_id
          WHERE reconciliation.charge_id = @chargeId AND reconciliation.net_amount > 0
          ORDER BY legacy.created_at, legacy.id, reconciliation.reconciliation_id`);
      for (const reconciliation of reconciliations.recordset || []) {
        if (excess <= 0n) break;
        if (!accountId || Number(reconciliation.financial_account_id) !== Number(accountId)) throw new FinanceCasesError('Legacy reconciliation credit belongs to a different student account.', 409);
        const opening = await tx.request().input('accountId', sql.Int, accountId)
          .query('SELECT id FROM finance_legacy_opening_charges WHERE financial_account_id = @accountId FOR UPDATE');
        if (opening.recordset?.length) throw new FinanceCasesError('Legacy reconciliation credit cannot be released after its account was transferred.', 409);
        const available = parseMoneyCents(String(reconciliation.amount));
        const release = available < excess ? available : excess;
        const key = crypto.randomUUID();
        const fp = requestFingerprint({ kind: 'exemption-legacy-release', reconciliationId: Number(reconciliation.reconciliation_id), amount: formatMoneyCents(release), reason });
        await tx.request().input('reconciliationId', sql.BigInt, reconciliation.reconciliation_id)
          .input('amount', sql.Decimal(12, 2), formatMoneyCents(release)).input('reason', sql.NVarChar(1000), reason)
          .input('key', sql.UniqueIdentifier, key).input('fingerprint', sql.NVarChar(64), fp).input('actorId', sql.Int, actor.id)
          .query(`INSERT INTO finance_legacy_reconciliation_releases
            (reconciliation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
            VALUES (@reconciliationId, @amount, @reason, @key, @fingerprint, @actorId)`);
        excess -= release;
      }
    }
    if (excess > 0n) throw new FinanceCasesError('The exemption would create more credit than its recorded allocations can release.', 409);
  }

  async function applyRuleToCharge(tx, actor, annual, rule, charge, reason) {
    const existing = await tx.request().input('ruleId', sql.BigInt, rule.id).input('chargeId', sql.BigInt, charge.charge_id)
      .query('SELECT id FROM finance_exemption_applications WHERE exemption_rule_id = @ruleId AND charge_id = @chargeId FOR UPDATE');
    if (existing.recordset?.length) return false;
    const grossCents = parseMoneyCents(String(charge.gross_amount));
    const alreadyWaived = parseMoneyCents(String(charge.waived_amount || '0.00'), { allowZero: true });
    const remainingGross = grossCents - alreadyWaived;
    if (remainingGross <= 0n) return false;
    const capCents = rule.is_full_coverage
      ? remainingGross
      : parseMoneyCents(String(rule.approved_amount), { allowZero: true }) - parseMoneyCents(String(rule.applied_total || '0.00'), { allowZero: true });
    if (capCents <= 0n) return false;
    const amountCents = remainingGross < capCents ? remainingGross : capCents;
    const applicationResult = await tx.request().input('ruleId', sql.BigInt, rule.id).input('chargeId', sql.BigInt, charge.charge_id)
      .input('amount', sql.Decimal(12, 2), formatMoneyCents(amountCents))
      .query(`INSERT INTO finance_exemption_applications (exemption_rule_id, charge_id, amount)
        VALUES (@ruleId, @chargeId, @amount)`);
    const applicationId = formatDbId(applicationResult, 'Exemption application');
    const adjustmentKey = crypto.randomUUID();
    const adjustmentReason = `Approved exemption case #${rule.exemption_case_id}: ${reason}`.slice(0, 1000);
    const fp = requestFingerprint({ kind: 'exemption', applicationId, chargeId: Number(charge.charge_id), amount: formatMoneyCents(-amountCents) });
    await tx.request().input('chargeId', sql.BigInt, charge.charge_id).input('amount', sql.Decimal(12, 2), formatMoneyCents(-amountCents))
      .input('reason', sql.NVarChar(1000), adjustmentReason).input('key', sql.UniqueIdentifier, adjustmentKey)
      .input('fingerprint', sql.NVarChar(64), fp).input('actorId', sql.Int, actor.id).input('applicationId', sql.BigInt, applicationId)
      .query(`INSERT INTO finance_charge_adjustments
        (charge_id, amount, reason, idempotency_key, request_fingerprint, recorded_by, exemption_application_id)
        VALUES (@chargeId, @amount, @reason, @key, @fingerprint, @actorId, @applicationId)`);
    const updated = await tx.request().input('chargeId', sql.BigInt, charge.charge_id).input('waived', sql.Decimal(12, 2), formatMoneyCents(amountCents))
      .query('UPDATE assessed_charges SET waived_amount = waived_amount + @waived WHERE id = @chargeId AND waived_amount + @waived <= gross_amount');
    if (updated.rowsAffected?.[0] !== 1) throw new FinanceCasesError('Exemption coverage exceeds the remaining charge amount.', 409);
    charge.waived_amount = formatMoneyCents(alreadyWaived + amountCents);
    await releaseOverpayment(tx, actor, Number(charge.charge_id), 'Approved exemption released excess prior allocations as account credit.');
    await requireFreshApproval(tx, actor, Number(charge.enrollment_id), 'Approved exemption changed this term’s payable assessment.');
    await writeAudit(tx, actor, 'exemption_applied', applicationId, {
      annualEnrollmentId: Number(annual.id), exemptionCaseId: Number(rule.exemption_case_id),
      chargeId: Number(charge.charge_id), amount: formatMoneyCents(amountCents)
    });
    return true;
  }

  async function applyApprovedExemptionsForCharge(tx, actor, annualEnrollmentId, chargeId) {
    const annual = await requireAnnual(tx, validId(annualEnrollmentId, 'annual enrollment'));
    const chargeResult = await tx.request().input('chargeId', sql.BigInt, validId(chargeId, 'charge', true))
      .input('annualId', sql.Int, annual.id)
      .query(`SELECT charge.id AS charge_id, charge.annual_enrollment_id, charge.enrollment_id,
          charge.fee_category, charge.line_name, CAST(charge.gross_amount AS CHAR(40)) AS gross_amount,
          CAST(charge.waived_amount AS CHAR(40)) AS waived_amount, enrollment.annual_term_number
        FROM assessed_charges AS charge
        INNER JOIN enrollments AS enrollment  ON enrollment.id = charge.enrollment_id
        WHERE charge.id = @chargeId AND charge.annual_enrollment_id = @annualId FOR UPDATE`);
    const charge = chargeResult.recordset?.[0];
    if (!charge) throw new FinanceCasesError('The charge does not belong to this annual enrollment.', 409);
    const rulesResult = await tx.request().input('annualId', sql.Int, annual.id).input('termNumber', sql.TinyInt, charge.annual_term_number)
      .input('category', sql.NVarChar(40), charge.fee_category).input('lineName', sql.NVarChar(120), charge.line_name)
      .query(`SELECT exemption_rule.id, exemption_rule.exemption_case_id, exemption_rule.term_number, exemption_rule.fee_category, exemption_rule.line_name,
          exemption_rule.is_full_coverage, CAST(exemption_rule.approved_amount AS CHAR(40)) AS approved_amount,
          CAST(COALESCE(applications.applied_total, 0) AS CHAR(40)) AS applied_total, exemption.review_reason
        FROM finance_exemption_cases AS exemption
        INNER JOIN finance_exemption_rules AS exemption_rule  ON exemption_rule.exemption_case_id = exemption.id
        LEFT JOIN (SELECT exemption_rule_id, SUM(amount) AS applied_total
          FROM finance_exemption_applications GROUP BY exemption_rule_id) AS applications
          ON applications.exemption_rule_id = exemption_rule.id
        WHERE exemption.annual_enrollment_id = @annualId AND exemption.status = 'approved'
          AND exemption_rule.term_number = @termNumber AND (exemption_rule.fee_category IS NULL OR exemption_rule.fee_category = @category)
          AND (exemption_rule.line_name IS NULL OR exemption_rule.line_name = @lineName)
        ORDER BY exemption_rule.id FOR UPDATE`);
    let count = 0;
    for (const rule of rulesResult.recordset || []) {
      if (await applyRuleToCharge(tx, actor, annual, rule, charge, rule.review_reason || 'Approved finance exemption.')) count += 1;
    }
    return count;
  }

  async function approveExemptionCase(actorInput, annualInput, input = {}) {
    const annualEnrollmentId = validId(annualInput, 'annual enrollment');
    const expectedStudentId = input.expectedStudentId == null ? null : validId(input.expectedStudentId, 'student');
    const reason = text(input.reason, 'Finance exemption approval reason', 1000, true);
    const idempotencyKey = token(input.idempotencyKey, 'exemption approval');
    const pool = await getPool();
    const ownerResult = await pool.request().input('annualId', sql.Int, annualEnrollmentId)
      .query('SELECT student_id FROM annual_enrollments WHERE id = @annualId');
    const owner = ownerResult.recordset?.[0];
    if (!owner) throw new FinanceCasesError('Annual enrollment not found.', 404);
    const ownerStudentId = Number(owner.student_id);
    return transaction(async (tx) => {
      const actor = await requireActor(tx.request(), actorInput);
      const student = await debtRevisions.lockStudent(tx, ownerStudentId);
      if (!student) throw new FinanceCasesError('Student record not found.', 404);
      const debtBefore = (await debtRevisions.readSnapshot(tx, ownerStudentId)).canonicalBalanceCents;
      const annual = await requireAnnual(tx, annualEnrollmentId);
      if (Number(annual.student_id) !== ownerStudentId) throw new FinanceCasesError('Annual enrollment ownership changed. Reload before continuing.', 409);
      if (expectedStudentId && Number(annual.student_id) !== expectedStudentId) {
        throw new FinanceCasesError('This annual enrollment does not belong to the selected student.', 404);
      }
      const rules = normalizeRules(input.rules, Number(annual.entry_term_number || 1));
      const canonical = requestFingerprint({ annualEnrollmentId, reason, rules: rules.map((rule) => ({ termNumber: rule.termNumber, feeCategory: rule.feeCategory, lineName: rule.lineName, isFullCoverage: rule.isFullCoverage, approvedAmount: formatMoneyCents(rule.approvedAmountCents) })) });
      const prior = await tx.request().input('key', sql.UniqueIdentifier, idempotencyKey)
        .query('SELECT id, annual_enrollment_id, request_fingerprint FROM finance_exemption_cases  WHERE idempotency_key = @key FOR UPDATE');
      if (prior.recordset?.[0]) {
        const row = prior.recordset[0];
        if (Number(row.annual_enrollment_id) !== annualEnrollmentId || row.request_fingerprint !== canonical) throw new FinanceCasesError('This token was already used for different exemption details.', 409);
        return { exemptionCaseId: Number(row.id), alreadyApproved: true, studentId: Number(annual.student_id) };
      }
      const existing = await tx.request().input('annualId', sql.Int, annualEnrollmentId)
        .query('SELECT id FROM finance_exemption_cases  WHERE annual_enrollment_id = @annualId');
      if (existing.recordset?.length) throw new FinanceCasesError('An exemption approval already exists for this annual enrollment.', 409);
      const inserted = await tx.request().input('annualId', sql.Int, annualEnrollmentId).input('actorId', sql.Int, actor.id)
        .input('reason', sql.NVarChar(1000), reason).input('key', sql.UniqueIdentifier, idempotencyKey).input('fingerprint', sql.NVarChar(64), canonical)
        .query(`INSERT INTO finance_exemption_cases
          (annual_enrollment_id, status, requested_by, reviewed_by, review_reason, idempotency_key, request_fingerprint, reviewed_at)
          VALUES (@annualId, 'approved', @actorId, @actorId, @reason, @key, @fingerprint, UTC_TIMESTAMP(6))`);
      const caseId = formatDbId(inserted, 'Exemption case');
      for (const rule of rules) {
        await tx.request().input('caseId', sql.BigInt, caseId).input('termNumber', sql.TinyInt, rule.termNumber)
          .input('category', sql.NVarChar(40), rule.feeCategory).input('lineName', sql.NVarChar(120), rule.lineName)
          .input('fullCoverage', sql.Bit, rule.isFullCoverage).input('approvedAmount', sql.Decimal(12, 2), formatMoneyCents(rule.approvedAmountCents))
          .query(`INSERT INTO finance_exemption_rules (exemption_case_id, term_number, fee_category, line_name, is_full_coverage, approved_amount)
            VALUES (@caseId, @termNumber, @category, @lineName, @fullCoverage, @approvedAmount)`);
      }
      const charges = await tx.request().input('annualId', sql.Int, annualEnrollmentId)
        .query(`SELECT charge.id AS charge_id FROM assessed_charges AS charge
          WHERE charge.annual_enrollment_id = @annualId ORDER BY charge.enrollment_id, charge.id FOR UPDATE`);
      for (const charge of charges.recordset || []) await applyApprovedExemptionsForCharge(tx, actor, annualEnrollmentId, charge.charge_id);
      await debtRevisions.recordIncreaseIfAny(tx, ownerStudentId, debtBefore);
      await writeAudit(tx, actor, 'exemption_approved', caseId, { annualEnrollmentId, schoolYear: annual.school_year, reason, ruleCount: rules.length });
      return { exemptionCaseId: caseId, studentId: Number(annual.student_id) };
    });
  }

  async function billSpecialSubject(actorInput, studentInput, specialSubjectInput, input = {}) {
    const studentId = validId(studentInput, 'student');
    const specialSubjectId = validId(specialSubjectInput, 'special subject', true);
    const amountCents = parseMoneyCents(String(input.amount || ''), { allowZero: false });
    const installment = text(input.installment || 'As incurred', 'Installment', 40, true);
    const reason = text(input.reason, 'Finance billing reason', 1000, true);
    const idempotencyKey = token(input.idempotencyKey, 'special subject billing');
    const fingerprint = requestFingerprint({ studentId, specialSubjectId, amount: formatMoneyCents(amountCents), installment, reason });
    return transaction(async (tx) => {
      const actor = await requireActor(tx.request(), actorInput);
      const student = await debtRevisions.lockStudent(tx, studentId);
      if (!student) throw new FinanceCasesError('Student record not found.', 404);
      if (student.status === 'archived') throw new FinanceCasesError('Archived students cannot receive new finance records.', 409);
      const debtBefore = (await debtRevisions.readSnapshot(tx, studentId)).canonicalBalanceCents;
      const existing = await tx.request().input('key', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT charge.id, charge.special_subject_id, charge.request_fingerprint, annual.student_id
          FROM assessed_charges AS charge
          INNER JOIN annual_enrollments AS annual  ON annual.id = charge.annual_enrollment_id
          WHERE charge.idempotency_key = @key FOR UPDATE`);
      if (existing.recordset?.[0]) {
        const row = existing.recordset[0];
        if (Number(row.student_id) !== studentId || Number(row.special_subject_id) !== specialSubjectId || row.request_fingerprint !== fingerprint) throw new FinanceCasesError('This token was used for different special subject billing details.', 409);
        return { chargeId: Number(row.id), alreadyRecorded: true };
      }
      const specialResult = await tx.request().input('specialSubjectId', sql.BigInt, specialSubjectId).input('studentId', sql.Int, studentId)
        .query(`SELECT special.id, special.annual_enrollment_id, special.enrollment_id, special.student_id,
            annual.entry_term_number, annual.intake_status, student.status AS student_status,
            enrollment.annual_term_number, enrollment.enrollment_status, enrollment.term_scope_status,
            assessment.id AS assessment_id, subject.subject_name
          FROM annual_special_subjects AS special
          INNER JOIN annual_enrollments AS annual  ON annual.id = special.annual_enrollment_id AND annual.student_id = special.student_id
          INNER JOIN students AS student  ON student.id = special.student_id
          INNER JOIN enrollments AS enrollment  ON enrollment.id = special.enrollment_id AND enrollment.annual_enrollment_id = special.annual_enrollment_id AND enrollment.student_id = special.student_id
          INNER JOIN student_subjects AS assignment  ON assignment.id = special.student_subject_id AND assignment.enrollment_id = special.enrollment_id
          INNER JOIN subjects AS subject  ON subject.id = assignment.subject_id
          LEFT JOIN annual_assessments AS assessment  ON assessment.annual_enrollment_id = annual.id
          WHERE special.id = @specialSubjectId AND special.student_id = @studentId FOR UPDATE`);
      const special = specialResult.recordset?.[0];
      if (!special || special.intake_status === 'legacy' || special.student_status === 'archived') throw new FinanceCasesError('This special-subject record is unavailable for billing.', 409);
      if (special.term_scope_status !== 'applicable' || Number(special.annual_term_number) < Number(special.entry_term_number)) throw new FinanceCasesError('Pre-entry terms cannot receive special-subject charges.', 409);
      if (!['pending_payment', 'enrolled'].includes(special.enrollment_status) || !special.assessment_id) throw new FinanceCasesError('The applicable term must have an assessment before it can be billed.', 409);
      const alreadyCharged = await tx.request().input('specialSubjectId', sql.BigInt, specialSubjectId)
        .query('SELECT id FROM assessed_charges WHERE special_subject_id = @specialSubjectId FOR UPDATE');
      if (alreadyCharged.recordset?.length) throw new FinanceCasesError('This linked special subject has already been billed.', 409);
      const inserted = await tx.request().input('assessmentId', sql.Int, special.assessment_id).input('annualId', sql.Int, special.annual_enrollment_id)
        .input('enrollmentId', sql.Int, special.enrollment_id).input('lineName', sql.NVarChar(120), special.subject_name)
        .input('installment', sql.NVarChar(40), installment).input('amount', sql.Decimal(12, 2), formatMoneyCents(amountCents))
        .input('reason', sql.NVarChar(1000), reason).input('key', sql.UniqueIdentifier, idempotencyKey)
        .input('fingerprint', sql.NVarChar(64), fingerprint).input('specialSubjectId', sql.BigInt, specialSubjectId)
        .query(`INSERT INTO assessed_charges
          (assessment_id, annual_enrollment_id, enrollment_id, fee_category, line_name, installment, amount, gross_amount, is_manual, reason, idempotency_key, request_fingerprint, special_subject_id)
          VALUES (@assessmentId, @annualId, @enrollmentId, 'other', @lineName, @installment, @amount, @amount, 1, @reason, @key, @fingerprint, @specialSubjectId)`);
      const chargeId = formatDbId(inserted, 'Special-subject charge');
      await applyApprovedExemptionsForCharge(tx, actor, Number(special.annual_enrollment_id), chargeId);
      await requireFreshApproval(tx, actor, Number(special.enrollment_id), 'Special-subject charge added to this term.');
      await writeAudit(tx, actor, 'special_subject_billed', chargeId, { studentId, specialSubjectId, enrollmentId: special.enrollment_id, subjectName: special.subject_name, amount: formatMoneyCents(amountCents), reason });
      await debtRevisions.recordIncreaseIfAny(tx, studentId, debtBefore);
      return { chargeId };
    });
  }

  async function reviewDepartureCase(actorInput, departureCaseInput, input = {}) {
    const departureCaseId = validId(departureCaseInput, 'departure case', true);
    const reason = text(input.reason, 'Finance departure review reason', 1000, true);
    const idempotencyKey = token(input.idempotencyKey, 'departure review');
    const adjustments = normalizeAdjustmentRows(input.adjustments);
    const fingerprint = requestFingerprint({ departureCaseId, reason, adjustments: adjustments.map((row) => ({ ...row, amount: formatMoneyCents(row.amountCents), amountCents: undefined })).sort((a, b) => a.chargeId - b.chargeId) });
    const pool = await getPool();
    const ownerResult = await pool.request().input('caseId', sql.BigInt, departureCaseId)
      .query(`SELECT annual.student_id FROM finance_departure_cases AS departure
        INNER JOIN annual_enrollments AS annual ON annual.id = departure.annual_enrollment_id
        WHERE departure.id = @caseId`);
    const owner = ownerResult.recordset?.[0];
    if (!owner) throw new FinanceCasesError('Departure case not found.', 404);
    const ownerStudentId = Number(owner.student_id);
    return transaction(async (tx) => {
      const actor = await requireActor(tx.request(), actorInput);
      const student = await debtRevisions.lockStudent(tx, ownerStudentId);
      if (!student) throw new FinanceCasesError('Student record not found.', 404);
      const debtBefore = (await debtRevisions.readSnapshot(tx, ownerStudentId)).canonicalBalanceCents;
      const caseResult = await tx.request().input('caseId', sql.BigInt, departureCaseId)
        .query(`SELECT departure.id, departure.annual_enrollment_id, departure.finance_status,
            departure.review_idempotency_key, departure.review_request_fingerprint,
            annual.student_id, student.status AS student_status
          FROM finance_departure_cases AS departure
          INNER JOIN annual_enrollments AS annual  ON annual.id = departure.annual_enrollment_id
          INNER JOIN students AS student  ON student.id = annual.student_id
          WHERE departure.id = @caseId FOR UPDATE`);
      const departure = caseResult.recordset?.[0];
      if (!departure) throw new FinanceCasesError('Departure case not found.', 404);
      if (Number(departure.student_id) !== ownerStudentId) throw new FinanceCasesError('Departure case ownership changed. Reload before continuing.', 409);
      if (departure.student_status === 'archived') throw new FinanceCasesError('Archived student history is read-only.', 409);
      if (departure.finance_status === 'reviewed') {
        const storedKey = String(departure.review_idempotency_key || '').trim().toLowerCase();
        const storedFingerprint = String(departure.review_request_fingerprint || '').trim().toLowerCase();
        if (storedKey === idempotencyKey.toLowerCase() && storedFingerprint === fingerprint.toLowerCase()) return { departureCaseId, alreadyReviewed: true, studentId: Number(departure.student_id) };
        throw new FinanceCasesError('This departure case was already reviewed. Record a separate audited adjustment for any later correction.', 409);
      }
      const priorToken = await tx.request().input('key', sql.UniqueIdentifier, idempotencyKey)
        .query('SELECT id FROM finance_departure_cases  WHERE review_idempotency_key = @key FOR UPDATE');
      if (priorToken.recordset?.length) {
        const row = priorToken.recordset[0];
        if (Number(row.id) !== departureCaseId) throw new FinanceCasesError('This token was used for another departure review.', 409);
      }
      const allowed = await tx.request().input('caseId', sql.BigInt, departureCaseId)
        .query(`SELECT terms.enrollment_id, terms.academic_activity_review_required, enrollment.student_id,
            enrollment.annual_enrollment_id
          FROM finance_departure_case_terms AS terms
          INNER JOIN enrollments AS enrollment  ON enrollment.id = terms.enrollment_id
          WHERE terms.departure_case_id = @caseId FOR UPDATE`);
      const eligibleEnrollmentIds = new Set((allowed.recordset || []).map((row) => Number(row.enrollment_id)));
      if (!eligibleEnrollmentIds.size || (allowed.recordset || []).some((row) => Number(row.student_id) !== Number(departure.student_id) || Number(row.annual_enrollment_id) !== Number(departure.annual_enrollment_id))) throw new FinanceCasesError('Departure case placements no longer match their annual enrollment.', 409);
      const normalizedAdjustments = adjustments.sort((a, b) => a.chargeId - b.chargeId);
      if (new Set(normalizedAdjustments.map((row) => row.chargeId)).size !== normalizedAdjustments.length) throw new FinanceCasesError('List each departure charge once.', 400);
      for (const adjustment of normalizedAdjustments) {
        const chargeResult = await tx.request().input('chargeId', sql.BigInt, adjustment.chargeId)
          .query(`SELECT charge.id, charge.enrollment_id, charge.annual_enrollment_id,
              CAST(charge.gross_amount AS CHAR(40)) AS gross_amount,
              CAST(COALESCE(adjustments.total, 0) AS CHAR(40)) AS prior_adjustments
            FROM assessed_charges AS charge
            LEFT JOIN (SELECT charge_id, SUM(amount) AS total
              FROM finance_charge_adjustments GROUP BY charge_id) AS adjustments ON adjustments.charge_id = charge.id
            WHERE charge.id = @chargeId FOR UPDATE`);
        const charge = chargeResult.recordset?.[0];
        if (!charge || !eligibleEnrollmentIds.has(Number(charge.enrollment_id)) || Number(charge.annual_enrollment_id) !== Number(departure.annual_enrollment_id)) throw new FinanceCasesError('Each departure correction must target a charge from the affected terms of this same annual enrollment.', 409);
        const grossCents = parseMoneyCents(String(charge.gross_amount));
        const priorCents = parseMoneyCents(String(charge.prior_adjustments || '0.00'), { allowNegative: true, allowZero: true });
        if (adjustment.amountCents > grossCents + priorCents) throw new FinanceCasesError('A departure correction cannot exceed the remaining charge basis.', 409);
        const key = crypto.randomUUID();
        const fp = requestFingerprint({ departureCaseId, chargeId: adjustment.chargeId, amount: formatMoneyCents(-adjustment.amountCents), reason: adjustment.reason });
        await tx.request().input('chargeId', sql.BigInt, adjustment.chargeId).input('amount', sql.Decimal(12, 2), formatMoneyCents(-adjustment.amountCents))
          .input('lineReason', sql.NVarChar(1000), adjustment.reason).input('key', sql.UniqueIdentifier, key)
          .input('fingerprint', sql.NVarChar(64), fp).input('actorId', sql.Int, actor.id).input('departureCaseId', sql.BigInt, departureCaseId)
          .query(`INSERT INTO finance_charge_adjustments
            (charge_id, amount, reason, idempotency_key, request_fingerprint, recorded_by, departure_case_id)
            VALUES (@chargeId, @amount, @lineReason, @key, @fingerprint, @actorId, @departureCaseId)`);
        await releaseOverpayment(tx, actor, adjustment.chargeId, 'Approved departure adjustment released excess prior allocations as account credit.');
        await requireFreshApproval(tx, actor, Number(charge.enrollment_id), 'Finance approved a departure correction to this term.');
      }
      const updated = await tx.request().input('caseId', sql.BigInt, departureCaseId).input('actorId', sql.Int, actor.id)
        .input('reviewReason', sql.NVarChar(1000), reason).input('key', sql.UniqueIdentifier, idempotencyKey).input('fingerprint', sql.NVarChar(64), fingerprint)
        .query(`UPDATE finance_departure_cases SET finance_status = 'reviewed', reviewed_by = @actorId,
            review_reason = @reviewReason, reviewed_at = UTC_TIMESTAMP(6), review_idempotency_key = @key,
            review_request_fingerprint = @fingerprint
          WHERE id = @caseId AND finance_status = 'pending';`);
      if (updated.rowsAffected?.at(-1) !== 1) throw new FinanceCasesError('The departure case changed during review. Reload it and try again.', 409);
      await writeAudit(tx, actor, 'departure_case_reviewed', departureCaseId, { annualEnrollmentId: Number(departure.annual_enrollment_id), reason, adjustmentCount: normalizedAdjustments.length });
      await debtRevisions.recordIncreaseIfAny(tx, Number(departure.student_id), debtBefore);
      return { departureCaseId, reviewed: true, studentId: Number(departure.student_id) };
    });
  }

  async function getStudentCases(actorInput, studentInput) {
    const studentId = validId(studentInput, 'student');
    const pool = await getPool();
    await requireActor(pool.request(), actorInput);
    const [subjects, exemptions, departures] = await Promise.all([
      pool.request().input('studentId', sql.Int, studentId).query(`SELECT special.id AS special_subject_id, special.annual_enrollment_id, special.enrollment_id,
          special.prepaid_arrangement_note, annual.school_year, annual.grade_level, enrollment.annual_term_number, enrollment.enrollment_status,
          subject.subject_name, assignment.id AS student_subject_id, charge.id AS charge_id,
          CAST(charge.amount AS CHAR(40)) AS charge_amount, CAST(due.amount_due AS CHAR(40)) AS amount_due
        FROM annual_special_subjects AS special
        INNER JOIN annual_enrollments AS annual ON annual.id = special.annual_enrollment_id AND annual.student_id = special.student_id
        INNER JOIN enrollments AS enrollment ON enrollment.id = special.enrollment_id AND enrollment.annual_enrollment_id = special.annual_enrollment_id AND enrollment.student_id = special.student_id
        INNER JOIN student_subjects AS assignment ON assignment.id = special.student_subject_id AND assignment.enrollment_id = special.enrollment_id
        INNER JOIN subjects AS subject ON subject.id = assignment.subject_id
        LEFT JOIN assessed_charges AS charge ON charge.special_subject_id = special.id
        LEFT JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
        WHERE special.student_id = @studentId ORDER BY annual.school_year DESC, enrollment.annual_term_number, subject.subject_name`),
      pool.request().input('studentId', sql.Int, studentId).query(`SELECT exemption.id AS exemption_case_id, annual.id AS annual_enrollment_id,
          annual.school_year, exemption.status, exemption.review_reason, exemption.reviewed_at,
          exemption_rule.id AS rule_id, exemption_rule.term_number, exemption_rule.fee_category, exemption_rule.line_name, exemption_rule.is_full_coverage,
          CAST(exemption_rule.approved_amount AS CHAR(40)) AS approved_amount
        FROM finance_exemption_cases AS exemption
        INNER JOIN annual_enrollments AS annual ON annual.id = exemption.annual_enrollment_id
        LEFT JOIN finance_exemption_rules AS exemption_rule ON exemption_rule.exemption_case_id = exemption.id
        WHERE annual.student_id = @studentId ORDER BY annual.school_year DESC, exemption_rule.term_number, exemption_rule.id`),
      pool.request().input('studentId', sql.Int, studentId).query(`SELECT departure.id AS departure_case_id, departure.annual_enrollment_id,
          annual.school_year, departure.effective_date, departure.departure_type, departure.reason,
          departure.finance_status, departure.review_reason, departure.reviewed_at,
          terms.enrollment_id, terms.academic_activity_review_required, enrollment.annual_term_number,
          charge.id AS charge_id, charge.line_name, charge.installment, CAST(due.amount_due AS CHAR(40)) AS amount_due
        FROM finance_departure_cases AS departure
        INNER JOIN annual_enrollments AS annual ON annual.id = departure.annual_enrollment_id
        INNER JOIN finance_departure_case_terms AS terms ON terms.departure_case_id = departure.id
        INNER JOIN enrollments AS enrollment ON enrollment.id = terms.enrollment_id
        LEFT JOIN assessed_charges AS charge ON charge.enrollment_id = enrollment.id
        LEFT JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
        WHERE annual.student_id = @studentId ORDER BY annual.school_year DESC, departure.id, enrollment.annual_term_number`)
    ]);
    const departureCases = new Map();
    for (const row of departures.recordset || []) {
      let item = departureCases.get(Number(row.departure_case_id));
      if (!item) {
        item = { ...row, terms: [] };
        departureCases.set(Number(row.departure_case_id), item);
      }
      let term = item.terms.find((candidate) => Number(candidate.enrollment_id) === Number(row.enrollment_id));
      if (!term) {
        term = { enrollment_id: row.enrollment_id, annual_term_number: row.annual_term_number, academic_activity_review_required: row.academic_activity_review_required, charges: [] };
        item.terms.push(term);
      }
      if (row.charge_id) term.charges.push({ charge_id: row.charge_id, line_name: row.line_name, installment: row.installment, amount_due: row.amount_due });
    }
    return { specialSubjects: subjects.recordset || [], exemptions: exemptions.recordset || [], departures: [...departureCases.values()] };
  }

  async function listPendingDepartureCases(actorInput) {
    const pool = await getPool();
    await requireActor(pool.request(), actorInput);
    const result = await pool.request().query(`SELECT departure.id AS departure_case_id, annual.student_id, student.student_no,
        CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) AS student_name,
        annual.school_year, annual.grade_level, departure.effective_date, departure.departure_type, departure.reason,
        terms.enrollment_id, enrollment.annual_term_number, terms.academic_activity_review_required,
        charge.id AS charge_id, charge.line_name, charge.installment, CAST(due.amount_due AS CHAR(40)) AS amount_due
      FROM finance_departure_cases AS departure
      INNER JOIN annual_enrollments AS annual ON annual.id = departure.annual_enrollment_id
      INNER JOIN students AS student ON student.id = annual.student_id
      INNER JOIN finance_departure_case_terms AS terms ON terms.departure_case_id = departure.id
      INNER JOIN enrollments AS enrollment ON enrollment.id = terms.enrollment_id
      LEFT JOIN assessed_charges AS charge ON charge.enrollment_id = enrollment.id
      LEFT JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
      WHERE departure.finance_status = 'pending'
      ORDER BY departure.effective_date, departure.id, enrollment.annual_term_number, charge.id`);
    return result.recordset || [];
  }

  return { approveExemptionCase, applyApprovedExemptionsForCharge, billSpecialSubject, reviewDepartureCase, getStudentCases, listPendingDepartureCases };
}

module.exports = { FinanceCasesError, createAnnualFinanceCasesService, normalizeRules, normalizeAdjustmentRows };
