const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');
const { parseMoneyCents, formatMoneyCents } = require('./financeService');
const { FinanceServiceError, normalizeId, normalizeSearchTerm } = require('./financeService');
const { createAnnualFinanceCasesService } = require('./annualFinanceCasesService');
const { createFinanceDebtRevisionService } = require('./financeDebtRevisionService');
const { runSerializableTransaction } = require('./transactionRetry');
const { FINANCE_STATUS, FINANCE_TERM_CLASSIFICATION_CTES, TRACKING_MODES } = require('./financeTermClassification');
const {
  formatFeePurpose, formatAllocationPurpose, annotateRestatementSourceAllocations,
  buildRestatementSourceAllocationPurposeMap, annotateRestatementSyntheticPlacementAllocations,
  buildRestatementSyntheticPlacementPurposeMap, buildPaymentPurposeHistory
} = require('../utils/paymentPurpose');

const FEE_CATEGORIES = new Set(['tuition', 'miscellaneous', 'uniform', 'id', 'activity', 'retake', 'other']);
const ID_PATTERN = /^\d{1,10}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CENTS = 999999999999n;
const TUITION_INSTALLMENTS = ['DP', 'Prelim', 'Midterm', 'Finals'];
const FINANCE_ROSTER_QUERY_PHASES = Object.freeze([
  'count', 'status_count', 'status_page', 'page_ids', 'page_data', 'classification',
  'assessed_charge_balances', 'legacy_account_balances', 'opening_liability_balances',
  'options_year', 'options_term', 'options_section'
]);
// Base-table sums avoid MariaDB failures on repeated prepared execution of nested aggregate views.
const STUDENT_LEDGER_SUMMARY_SQL = `SELECT
    CAST(COALESCE(legacy.total, 0) AS CHAR(40)) AS unattributed_legacy_balance,
    CAST(COALESCE(opening.total, 0) AS CHAR(40)) AS opening_liability_due,
    CAST(COALESCE(charges.total, 0) AS CHAR(40)) AS assessed_charges,
    CAST(COALESCE(adjustments.total, 0) AS CHAR(40)) AS adjustments,
    CAST(COALESCE(payments.total, 0) AS CHAR(40)) AS annual_payments,
    CAST(COALESCE(reconciliations.total, 0) AS CHAR(40)) AS legacy_reconciled_amount,
    CAST(
      COALESCE((SELECT SUM(payment.amount) FROM finance_payments AS payment
        WHERE payment.student_id = @studentId AND payment.is_reversed = 0), 0)
      - COALESCE((SELECT SUM(allocation.net_amount) FROM v_finance_net_payment_allocations AS allocation
        INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
        WHERE payment.student_id = @studentId AND payment.is_reversed = 0), 0)
      AS CHAR(40)) AS available_credit
  FROM students AS student
  LEFT JOIN (
    SELECT account.student_id,
      account.balance
        + COALESCE((SELECT SUM(reconciliation.amount)
          FROM finance_legacy_reconciliations AS reconciliation
          INNER JOIN financial_transactions AS transaction_record ON transaction_record.id = reconciliation.transaction_id
          WHERE transaction_record.financial_account_id = account.id), 0)
        - COALESCE((SELECT SUM(release_row.amount)
          FROM finance_legacy_reconciliation_releases AS release_row
          INNER JOIN finance_legacy_reconciliations AS reconciliation ON reconciliation.id = release_row.reconciliation_id
          INNER JOIN financial_transactions AS transaction_record ON transaction_record.id = reconciliation.transaction_id
          WHERE transaction_record.financial_account_id = account.id), 0)
        - COALESCE((SELECT SUM(opening.amount) FROM finance_legacy_opening_charges AS opening
          WHERE opening.financial_account_id = account.id), 0) AS total
    FROM financial_accounts AS account WHERE account.student_id = @studentId
  ) AS legacy ON legacy.student_id = student.id
  LEFT JOIN (
    SELECT opening.student_id,
      opening.amount
        - COALESCE((SELECT SUM(allocation.amount)
          FROM finance_payment_allocations AS allocation
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
          WHERE allocation.legacy_opening_charge_id = opening.id AND payment.is_reversed = 0), 0)
        + COALESCE((SELECT SUM(release_row.amount)
          FROM finance_payment_allocation_releases AS release_row
          INNER JOIN finance_payment_allocations AS allocation ON allocation.id = release_row.allocation_id
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
          WHERE allocation.legacy_opening_charge_id = opening.id AND payment.is_reversed = 0), 0) AS total
    FROM finance_legacy_opening_charges AS opening WHERE opening.student_id = @studentId
  ) AS opening ON opening.student_id = student.id
  LEFT JOIN (
    SELECT annual.student_id, SUM(charge.amount) AS total
    FROM v_finance_effective_assessed_charges AS charge
    INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
    WHERE annual.student_id = @studentId
    GROUP BY annual.student_id
  ) AS charges ON charges.student_id = student.id
  LEFT JOIN (
    SELECT annual.student_id, SUM(adjustment.amount) AS total
    FROM finance_charge_adjustments AS adjustment
    INNER JOIN v_finance_effective_assessed_charges AS charge ON charge.id = adjustment.charge_id
    INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
    WHERE annual.student_id = @studentId
    GROUP BY annual.student_id
  ) AS adjustments ON adjustments.student_id = student.id
  LEFT JOIN (
    SELECT payment.student_id, SUM(allocation.net_amount) AS total
    FROM v_finance_net_payment_allocations AS allocation
    INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
    WHERE payment.student_id = @studentId AND payment.is_reversed = 0 AND allocation.charge_id IS NOT NULL
    GROUP BY payment.student_id
  ) AS payments ON payments.student_id = student.id
  LEFT JOIN (
    SELECT account.student_id, SUM(reconciliation.net_amount) AS total
    FROM v_finance_net_legacy_reconciliations AS reconciliation
    INNER JOIN financial_transactions AS legacy ON legacy.id = reconciliation.transaction_id
    INNER JOIN financial_accounts AS account ON account.id = legacy.financial_account_id
    WHERE account.student_id = @studentId
    GROUP BY account.student_id
  ) AS reconciliations ON reconciliations.student_id = student.id
  WHERE student.id = @studentId`;

async function runFinanceRosterQuery(request, phase, statement) {
  try {
    return await request.query(statement);
  } catch (error) {
    if (error && typeof error === 'object' && FINANCE_ROSTER_QUERY_PHASES.includes(phase)) {
      try { Object.defineProperty(error, 'financeRosterQueryPhase', { value: phase, configurable: true }); } catch { /* Keep the original database error. */ }
    }
    throw error;
  }
}

class AnnualFinanceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AnnualFinanceError';
    this.status = status;
  }
}

function normalizeAnnualSearchTerm(value) {
  try {
    return normalizeSearchTerm(value);
  } catch (error) {
    if (error instanceof FinanceServiceError) throw new AnnualFinanceError(error.message, error.status);
    throw error;
  }
}

function cleanText(value, label, maxLength, required = false) {
  if (typeof value !== 'string') throw new AnnualFinanceError(`${label} must be ${maxLength} printable characters or fewer.`);
  const text = value.trim();
  if ((required && !text) || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new AnnualFinanceError(`${label} is required and must be ${maxLength} printable characters or fewer.`);
  }
  return text || null;
}

function cleanTextArea(value, label, maxLength, required = false) {
  if (typeof value !== 'string') throw new AnnualFinanceError(`${label} must be ${maxLength} characters or fewer.`);
  const text = value.replace(/\r\n?/g, '\n').trim();
  if ((required && !text) || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new AnnualFinanceError(`${label} is required and must be ${maxLength} characters or fewer.`);
  }
  return text || null;
}

function id(value, label) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw new AnnualFinanceError(`Choose a valid ${label}.`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new AnnualFinanceError(`Choose a valid ${label}.`);
  return number;
}

function bigId(value, label) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,18}$/.test(raw)) throw new AnnualFinanceError(`Choose a valid ${label}.`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < 1) throw new AnnualFinanceError(`Choose a valid ${label}.`);
  return number;
}

function generatedId(value, label) {
  if (value && typeof value === 'object' && ('insertId' in value || 'recordset' in value)) {
    value = value.insertId || value.recordset?.[0]?.id;
  }
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} insert returned no safe identifier.`);
  return number;
}

function uuid(value, label = 'submission') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new AnnualFinanceError(`The ${label} token is invalid. Reload the form and try again.`);
  return value;
}

function flag(value) {
  return value === true || value === 1 || value === '1' || value === 'on';
}

function schoolYearStartYear(value) {
  const match = /^(\d{4})(?:\s*[-/]\s*\d{4})?$/.exec(String(value || '').trim());
  return match ? Number(match[1]) : null;
}

function annualTermOrder(value) {
  const match = /^(?:term|trimester)\s*([1-3])$/i.exec(String(value || '').trim());
  return match ? Number(match[1]) : null;
}

function normalizeLineRows(input) {
  let rows = input;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { throw new AnnualFinanceError('Schedule lines are invalid.'); }
  }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 120) throw new AnnualFinanceError('A schedule must contain 1 to 120 fee lines.');
  const normalized = rows.map((row, index) => {
    const termNumber = Number(row.termNumber);
    const category = cleanText(row.feeCategory, `Fee category on line ${index + 1}`, 40, true);
    if (!FEE_CATEGORIES.has(category)) throw new AnnualFinanceError(`Choose a supported fee category for line ${index + 1}.`);
    if (![1, 2, 3].includes(termNumber)) throw new AnnualFinanceError(`Choose term 1, 2, or 3 for line ${index + 1}.`);
    const lineName = cleanText(row.lineName, `Fee name on line ${index + 1}`, 120, true);
    const installment = cleanText(row.installment, `Installment on line ${index + 1}`, 40, true);
    const amountCents = parseMoneyCents(String(row.amount ?? ''), { allowZero: true });
    return { termNumber, category, lineName, installment, amount: formatMoneyCents(amountCents), amountCents, isOptional: flag(row.isOptional) };
  });
  const requiredTuitionRows = new Set();
  for (const line of normalized) {
    const label = TUITION_INSTALLMENTS.find((item) => item.toLowerCase() === line.installment.toLowerCase());
    if (line.category !== 'tuition' || line.lineName.toLowerCase() !== 'tuition' || !label) continue;
    const key = `${line.termNumber}:${label}`;
    if (line.isOptional || requiredTuitionRows.has(key)) throw new AnnualFinanceError(`Each term must have one non-optional tuition amount for ${label}.`);
    requiredTuitionRows.add(key);
  }
  const missingTuitionRows = [1, 2, 3].flatMap((termNumber) => TUITION_INSTALLMENTS
    .filter((installment) => !requiredTuitionRows.has(`${termNumber}:${installment}`))
    .map((installment) => `Term ${termNumber} ${installment}`));
  if (missingTuitionRows.length) throw new AnnualFinanceError(`Enter a staff-approved amount, including 0.00 when no amount is payable, for each tuition installment: ${missingTuitionRows.join(', ')}.`);
  return normalized;
}

function tuitionInstallmentBreakdown(lines, entryTermNumber = 1) {
  return [1, 2, 3].map((termNumber) => {
    const notApplicable = termNumber < Number(entryTermNumber || 1);
    const tuitionLines = lines.filter((line) => Number(line.termNumber) === termNumber
      && String(line.category || '').toLowerCase() === 'tuition');
    const installments = TUITION_INSTALLMENTS.map((installment) => {
      if (notApplicable) return { label: installment, configured: false, notApplicable: true, amount: null };
      const matched = tuitionLines.filter((line) => String(line.lineName || '').trim().toLowerCase() === 'tuition'
        && String(line.installment || '').trim().toLowerCase() === installment.toLowerCase());
      const configured = matched.length === 1 && !flag(matched[0].isOptional);
      const cents = matched.reduce((sum, line) => sum + parseMoneyCents(String(line.amount || '0.00'), { allowZero: true }), 0n);
      return { label: installment, configured, amount: configured ? formatMoneyCents(cents) : null };
    });
    const installmentLines = tuitionLines.filter((line) => String(line.lineName || '').trim().toLowerCase() === 'tuition'
      && TUITION_INSTALLMENTS.some((installment) => String(line.installment || '').trim().toLowerCase() === installment.toLowerCase()));
    const complete = notApplicable || (tuitionLines.length === TUITION_INSTALLMENTS.length
      && installmentLines.length === TUITION_INSTALLMENTS.length
      && installments.every(({ configured }) => configured));
    return { termNumber, installments, complete };
  });
}

function normalizeSelections(value) {
  if (value == null || value === '') return new Set();
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 120) throw new AnnualFinanceError('Too many optional schedule lines were selected.');
  return new Set(values.map((item) => id(item, 'optional schedule line')));
}

function normalizeAllocations(input = {}) {
  let rows = input.allocations;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { throw new AnnualFinanceError('Payment allocations are invalid.'); }
  }
  if (rows == null) rows = [];
  if (!Array.isArray(rows) || rows.length > 120) throw new AnnualFinanceError('A payment may have up to 120 charge allocations.');
  const normalized = [];
  for (const row of rows) {
    if (!row) continue;
    const rawChargeId = row.chargeId == null ? '' : String(row.chargeId).trim();
    const rawOpeningId = row.openingLiabilityId == null ? '' : String(row.openingLiabilityId).trim();
    const rawAmount = row.amount == null ? '' : String(row.amount).trim();
    if (!rawChargeId && !rawOpeningId && !rawAmount) continue;
    if (!rawAmount) continue;
    if (Boolean(rawChargeId) === Boolean(rawOpeningId)) throw new AnnualFinanceError('Choose exactly one charge or legacy opening liability for each allocation.');
    normalized.push({
      chargeId: rawChargeId ? bigId(rawChargeId, 'charge') : null,
      openingLiabilityId: rawOpeningId ? bigId(rawOpeningId, 'legacy opening liability') : null,
      amountCents: parseMoneyCents(rawAmount, { allowZero: false })
    });
  }
  const targetKeys = normalized.map((row) => `${row.chargeId ? 'charge' : 'opening'}:${row.chargeId || row.openingLiabilityId}`);
  if (new Set(targetKeys).size !== normalized.length) throw new AnnualFinanceError('List each charge or opening liability only once per allocation.');
  return normalized;
}

function parsePaymentDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AnnualFinanceError('Enter the actual payment date.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new AnnualFinanceError('Enter a valid payment date.');
  return value;
}

function requestFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function loadVoucherReviewState(request, sqlTypes, {
  annualEnrollmentId, assessmentId, scheduleId, scheduleVersion, assessedVoucherCode, currentVoucherCode, assessedAt
}, { lock = false } = {}) {
  if (!assessedAt) return null;
  const latestResult = await request.input('voucherAnnualEnrollmentId', sqlTypes.Int, annualEnrollmentId)
    .input('voucherAssessmentId', sqlTypes.Int, assessmentId)
    .input('voucherAssessedAt', sqlTypes.DateTime2, assessedAt)
    .input('voucherAssessedCode', sqlTypes.NVarChar(10), assessedVoucherCode)
    .input('voucherCurrentCode', sqlTypes.NVarChar(10), currentVoucherCode)
    .query(`SELECT id, finance_assessment_id, event_type, reason, request_fingerprint
      FROM annual_enrollment_events
      WHERE annual_enrollment_id = @voucherAnnualEnrollmentId
        AND event_type IN ('voucher_review_flagged', 'voucher_review_resolved')
        AND (created_at > @voucherAssessedAt OR finance_assessment_id = @voucherAssessmentId
          OR @voucherAssessedCode <> @voucherCurrentCode)
      ORDER BY created_at DESC, id DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`);
  const event = latestResult.recordset?.[0];
  if (!event) return null;
  const assessmentBound = Number(event.finance_assessment_id) === Number(assessmentId);
  const state = { eventId: Number(event.id), eventType: event.event_type, assessmentBound,
    assessedVoucherCode: assessedVoucherCode || null, currentVoucherCode: currentVoucherCode || null,
    resolution: null };
  if (event.event_type !== 'voucher_review_resolved') return { ...state, status: 'unresolved' };
  // Historical resolutions were not linked to an assessment and cannot serve as handoff evidence.
  if (!assessmentBound) return { ...state, status: 'unverified' };
  const resolutionPrefixes = [
    ['Assessment remains valid: ', 'assessment_stands'],
    ['Required adjustments were recorded: ', 'adjustments_recorded']
  ];
  const matchedPrefix = resolutionPrefixes.find(([prefix]) => String(event.reason || '').startsWith(prefix));
  if (!matchedPrefix) return { ...state, status: 'unverified' };
  const [prefix, resolution] = matchedPrefix;
  const reason = String(event.reason).slice(prefix.length);
  const newFingerprint = requestFingerprint({ annualEnrollmentId, assessmentId, scheduleId, scheduleVersion,
    assessedVoucherCode, currentVoucherCode, resolution, reason });
  if (event.request_fingerprint !== newFingerprint) {
    return { ...state, status: 'unverified' };
  }
  return { ...state, status: 'resolved', resolution };
}

function canonicalAssessmentSnapshot(lines) {
  const normalized = lines.map((line) => ({
    scheduleLineId: line.scheduleLineId == null ? null : Number(line.scheduleLineId),
    termNumber: Number(line.termNumber),
    category: String(line.category || ''),
    lineName: String(line.lineName || ''),
    installment: String(line.installment || ''),
    grossAmount: formatMoneyCents(parseMoneyCents(String(line.grossAmount ?? line.amount), { allowZero: true })),
    waivedAmount: formatMoneyCents(parseMoneyCents(String(line.waivedAmount || '0.00'), { allowZero: true }))
  })).sort((left, right) => left.termNumber - right.termNumber
    || (left.scheduleLineId ?? Number.MAX_SAFE_INTEGER) - (right.scheduleLineId ?? Number.MAX_SAFE_INTEGER)
    || left.category.localeCompare(right.category) || left.lineName.localeCompare(right.lineName)
    || left.installment.localeCompare(right.installment));
  const totalCents = normalized.reduce((sum, line) => sum
    + parseMoneyCents(line.grossAmount, { allowZero: true })
    - parseMoneyCents(line.waivedAmount, { allowZero: true }), 0n);
  return { lines: normalized, total: formatMoneyCents(totalCents), fingerprint: requestFingerprint(normalized) };
}

async function loadAnnualRestatement(request, sqlTypes, annualEnrollmentId, assessmentId = null) {
  request.input('restatementAnnualEnrollmentId', sqlTypes.Int, annualEnrollmentId);
  if (assessmentId != null) request.input('restatementAssessmentId', sqlTypes.Int, assessmentId);
  const result = await request.query(`SELECT archive.operation_id, archive.annual_enrollment_id, archive.assessment_id,
      archive.source_schedule_id, archive.source_schedule_version,
      archive.target_tuition_schedule_id, archive.target_tuition_schedule_version,
      archive.before_image_sha256, archive.applied_image_sha256,
      operation.operation_kind, operation.manifest_sha256,
      applied.id AS applied_event_id, applied.manifest_sha256 AS applied_manifest_sha256,
      applied.resulting_state_sha256 AS applied_state_sha256,
      reversed.id AS reversed_event_id, reversed.manifest_sha256 AS reversed_manifest_sha256,
      reversed.resulting_state_sha256 AS reversed_state_sha256
    FROM finance_assessment_restatement_annuals AS archive
    INNER JOIN finance_assessment_restatement_operations AS operation ON operation.operation_id = archive.operation_id
    LEFT JOIN finance_assessment_restatement_events AS applied
      ON applied.operation_id = archive.operation_id AND applied.event_type = 'applied'
    LEFT JOIN finance_assessment_restatement_events AS reversed
      ON reversed.operation_id = archive.operation_id AND reversed.event_type = 'reversed'
    WHERE archive.annual_enrollment_id = @restatementAnnualEnrollmentId
      ${assessmentId == null ? '' : 'AND archive.assessment_id = @restatementAssessmentId'}
    LIMIT 1`);
  const row = result.recordset?.[0];
  if (!row) return null;
  validateRestatementRow(row);
  const isActive = row.reversed_event_id == null;
  return {
    operationId: String(row.operation_id), status: isActive ? 'active' : 'reversed',
    annualEnrollmentId: Number(row.annual_enrollment_id), assessmentId: Number(row.assessment_id),
    sourceScheduleId: Number(row.source_schedule_id), sourceScheduleVersion: Number(row.source_schedule_version),
    targetTuitionScheduleId: Number(row.target_tuition_schedule_id),
    targetTuitionScheduleVersion: Number(row.target_tuition_schedule_version),
    beforeImageSha256: String(row.before_image_sha256), appliedImageSha256: String(row.applied_image_sha256),
    compositionLabel: isActive
      ? `Synthetic tuition installments from schedule v${Number(row.target_tuition_schedule_version)}; non-tuition fees remain from the original schedule v${Number(row.source_schedule_version)}.`
      : 'Original fee composition restored after a logical finance restatement reversal.',
    confirmationLabel: 'The original Registrar confirmation and its saved assessment snapshot were not changed.'
  };
}

function validateRestatementRow(row) {
  const sha256 = /^[a-f0-9]{64}$/i;
  const operationManifest = String(row.manifest_sha256 || '').toLowerCase();
  if (row.operation_kind !== 'synthetic_tuition_installments'
    || row.applied_event_id == null
    || !sha256.test(operationManifest)
    || String(row.applied_manifest_sha256 || '').toLowerCase() !== operationManifest
    || !sha256.test(String(row.applied_state_sha256 || ''))
    || !sha256.test(String(row.before_image_sha256 || ''))
    || !sha256.test(String(row.applied_image_sha256 || ''))
    || (row.reversed_event_id != null && (String(row.reversed_manifest_sha256 || '').toLowerCase() !== operationManifest
      || !sha256.test(String(row.reversed_state_sha256 || ''))))) {
    throw new AnnualFinanceError('The saved finance restatement history is incomplete or inconsistent.', 409);
  }
  for (const field of ['annual_enrollment_id', 'assessment_id', 'source_schedule_id', 'source_schedule_version',
    'target_tuition_schedule_id', 'target_tuition_schedule_version']) {
    if (!Number.isSafeInteger(Number(row[field])) || Number(row[field]) < 1) {
      throw new AnnualFinanceError('The saved finance restatement schedule binding is invalid.', 409);
    }
  }
}

function activeRestatementFingerprint(restatement) {
  if (!restatement || restatement.status !== 'active') return null;
  return {
    operationId: restatement.operationId,
    sourceScheduleId: restatement.sourceScheduleId,
    sourceScheduleVersion: restatement.sourceScheduleVersion,
    targetTuitionScheduleId: restatement.targetTuitionScheduleId,
    targetTuitionScheduleVersion: restatement.targetTuitionScheduleVersion,
    beforeImageSha256: restatement.beforeImageSha256,
    appliedImageSha256: restatement.appliedImageSha256
  };
}

function archiveTimestamp(value, label) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) throw new AnnualFinanceError(`The archived ${label} timestamp is invalid.`, 409);
  return timestamp;
}

function buildArchivedConfirmationLines(beforeImage, assessmentId, confirmedAt) {
  const confirmedTimestamp = archiveTimestamp(confirmedAt, 'confirmation');
  const termsByEnrollment = new Map((beforeImage.enrollments || []).map((row) => [Number(row.id), Number(row.annual_term_number)]));
  const scheduleLinesById = new Map((beforeImage.sourceScheduleLines || []).map((row) => [Number(row.id), row]));
  const waivedByCharge = new Map();
  for (const application of beforeImage.exemptionApplications || []) {
    if (archiveTimestamp(application.applied_at, 'exemption') > confirmedTimestamp) continue;
    const chargeId = Number(application.charge_id);
    waivedByCharge.set(chargeId, (waivedByCharge.get(chargeId) || 0n)
      + parseMoneyCents(String(application.amount), { allowZero: true }));
  }
  return (beforeImage.charges || [])
    .filter((charge) => Number(charge.assessment_id) === assessmentId
      && archiveTimestamp(charge.created_at, 'charge') <= confirmedTimestamp)
    .map((charge) => {
      const scheduleLine = charge.schedule_line_id == null ? null : scheduleLinesById.get(Number(charge.schedule_line_id));
      const grossCents = parseMoneyCents(String(charge.amount), { allowZero: true });
      const waivedCents = waivedByCharge.get(Number(charge.id)) || 0n;
      if (waivedCents > grossCents) throw new AnnualFinanceError('The saved coverage exceeds its original charge amount.', 409);
      const termNumber = termsByEnrollment.get(Number(charge.enrollment_id));
      if (!Number.isInteger(termNumber) || termNumber < 1 || termNumber > 3) {
        throw new AnnualFinanceError('An original confirmed charge has no archived term placement.', 409);
      }
      return {
        term_number: termNumber, fee_category: charge.fee_category, line_name: charge.line_name,
        installment: charge.installment, schedule_line_id: charge.schedule_line_id,
        is_optional: scheduleLine && flag(scheduleLine.is_optional) ? 1 : 0,
        original_gross_amount: formatMoneyCents(grossCents), confirmed_waived_amount: formatMoneyCents(waivedCents)
      };
    });
}

function applyExemptionPreview(lines, rules) {
  const cappedRuleRemaining = new Map(rules.filter((rule) => !flag(rule.is_full_coverage))
    .map((rule) => [Number(rule.id), parseMoneyCents(String(rule.approved_amount || '0.00'), { allowZero: true })
      - parseMoneyCents(String(rule.applied_total || '0.00'), { allowZero: true })]));
  return lines.map((source) => {
    const line = { ...source };
    let remaining = parseMoneyCents(line.amount, { allowZero: true });
    let waived = 0n;
    for (const rule of rules) {
      if (Number(rule.term_number) !== line.termNumber
        || rule.fee_category && rule.fee_category !== line.category
        || rule.line_name && rule.line_name !== line.lineName) continue;
      const cap = flag(rule.is_full_coverage) ? remaining : cappedRuleRemaining.get(Number(rule.id)) || 0n;
      if (cap <= 0n || remaining <= 0n) continue;
      const amount = cap < remaining ? cap : remaining;
      waived += amount;
      remaining -= amount;
      if (!flag(rule.is_full_coverage)) cappedRuleRemaining.set(Number(rule.id), cap - amount);
    }
    line.grossAmount = line.amount;
    line.waivedAmount = formatMoneyCents(waived);
    line.amount = formatMoneyCents(remaining);
    return line;
  });
}

function assessmentTermTotals(lines, entryTermNumber) {
  return [1, 2, 3].filter((termNumber) => termNumber >= Number(entryTermNumber || 1)).map((termNumber) => {
    const cents = lines.filter((line) => Number(line.termNumber) === termNumber)
      .reduce((sum, line) => sum + parseMoneyCents(String(line.amount || '0.00'), { allowZero: true }), 0n);
    return { termNumber, amount: formatMoneyCents(cents) };
  });
}

function tuitionTermTotals(lines, entryTermNumber) {
  return [1, 2, 3].filter((termNumber) => termNumber >= Number(entryTermNumber || 1)).map((termNumber) => {
    const cents = lines.filter((line) => Number(line.termNumber) === termNumber
      && String(line.category || '').toLowerCase() === 'tuition')
      .reduce((sum, line) => sum + parseMoneyCents(String(line.amount || '0.00'), { allowZero: true }), 0n);
    return { termNumber, amount: formatMoneyCents(cents) };
  });
}

function nonTuitionTermTotals(lines, entryTermNumber) {
  return assessmentTermTotals(lines.filter((line) => String(line.category || '').toLowerCase() !== 'tuition'), entryTermNumber);
}

function classifyEntryDownPaymentBalances(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { status: 'ledger_unavailable' };
  try {
    const entries = rows.map((row) => {
      const due = parseMoneyCents(String(row.amount_due), { allowNegative: true, allowZero: true });
      const annualAllocated = parseMoneyCents(String(row.annual_allocated || '0.00'), { allowZero: true });
      const legacyAllocated = parseMoneyCents(String(row.legacy_allocated || '0.00'), { allowZero: true });
      return { due, basis: due + annualAllocated + legacyAllocated };
    });
    if (entries.some((entry) => entry.basis < 0n)) return { status: 'invalid' };
    const totalBasis = entries.reduce((sum, entry) => sum + entry.basis, 0n);
    if (totalBasis === 0n) return { status: 'zero_due' };
    return { status: entries.some((entry) => entry.basis > 0n && entry.due > 0n) ? 'unpaid' : 'settled' };
  } catch {
    return { status: 'invalid' };
  }
}

function canonicalAllocations(allocations) {
  return allocations.map((allocation) => ({
    chargeId: allocation.chargeId,
    openingLiabilityId: allocation.openingLiabilityId,
    amount: formatMoneyCents(allocation.amountCents)
  })).sort((left, right) => (left.chargeId || Number.MAX_SAFE_INTEGER) - (right.chargeId || Number.MAX_SAFE_INTEGER)
    || (left.openingLiabilityId || 0) - (right.openingLiabilityId || 0));
}

function createAnnualFinanceService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  transaction = null
} = {}) {
  const debtRevisions = createFinanceDebtRevisionService({ getPool, sql, transactionFactory, transaction });
  const financeCases = createAnnualFinanceCasesService({ getPool, sql, transactionFactory, debtRevisions, transaction });

  async function loadAssessmentSnapshot(transaction, assessmentId) {
    const result = await transaction.request().input('assessmentId', sql.Int, assessmentId)
      .query(`SELECT charge.schedule_line_id, enrollment.annual_term_number AS term_number,
          charge.fee_category, charge.line_name, charge.installment,
          CAST(charge.amount AS CHAR(40)) AS gross_amount,
          CAST(charge.waived_amount AS CHAR(40)) AS waived_amount
        FROM v_finance_effective_assessed_charges AS charge
        INNER JOIN enrollments AS enrollment  ON enrollment.id = charge.enrollment_id
        WHERE charge.assessment_id = @assessmentId`);
    const lines = (result.recordset || []).map((line) => ({
      scheduleLineId: line.schedule_line_id == null ? null : Number(line.schedule_line_id),
      termNumber: Number(line.term_number), category: line.fee_category, lineName: line.line_name,
      installment: line.installment, grossAmount: String(line.gross_amount), waivedAmount: String(line.waived_amount || '0.00')
    }));
    return canonicalAssessmentSnapshot(lines);
  }

  async function annualFinanceEvidenceSnapshot(transaction, annualEnrollmentId, { lock = false } = {}) {
    const lockClause = lock ? ' FOR UPDATE' : '';
    const parentResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT annual.id, annual.student_id, annual.school_year, annual.grade_level,
          annual.voucher_code, annual.entry_term_number, annual.intake_status,
          assessment.id AS assessment_id, assessment.schedule_id, assessment.schedule_version,
          assessment.voucher_code_snapshot, assessment.selection_json, assessment.assessed_at
        FROM annual_enrollments AS annual
        LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
        WHERE annual.id = @annualEnrollmentId${lockClause}`);
    const parent = parentResult.recordset?.[0];
    if (!parent || parent.assessment_id == null) {
      return { parent: parent || null, assessment: null, assessmentFingerprint: null,
        dependencyFingerprint: null, dp: { status: 'missing_assessment' }, latestReview: null };
    }
    const restatement = await loadAnnualRestatement(transaction.request(), sql, annualEnrollmentId, Number(parent.assessment_id));
    let selection;
    try {
      selection = JSON.parse(parent.selection_json || '{}');
    } catch {
      throw new AnnualFinanceError('The saved assessment selection needs Finance review.', 409);
    }
    const optionalLineIds = [...normalizeSelections(selection.optionalLineIds || [])].sort((left, right) => left - right);
    const scheduleResult = await transaction.request().input('scheduleId', sql.Int, parent.schedule_id)
      .query(`SELECT id, school_year, grade_level, voucher_code, version_no
        FROM finance_schedules WHERE id = @scheduleId${lockClause}`);
    const schedule = scheduleResult.recordset?.[0];
    if (!schedule || Number(schedule.version_no) !== Number(parent.schedule_version)
      || schedule.voucher_code !== parent.voucher_code_snapshot
      || schedule.school_year !== parent.school_year || schedule.grade_level !== parent.grade_level) {
      return { parent, assessment: { id: Number(parent.assessment_id) }, assessmentFingerprint: null,
        dependencyFingerprint: null, dp: { status: 'invalid_schedule' }, latestReview: null };
    }
    const voucherReview = await loadVoucherReviewState(transaction.request(), sql, {
      annualEnrollmentId, assessmentId: Number(parent.assessment_id), scheduleId: Number(parent.schedule_id),
      scheduleVersion: Number(parent.schedule_version), assessedVoucherCode: parent.voucher_code_snapshot,
      currentVoucherCode: parent.voucher_code, assessedAt: parent.assessed_at
    }, { lock });
    const scheduleLinesResult = await transaction.request().input('scheduleId', sql.Int, parent.schedule_id)
      .query(`SELECT id, term_number, fee_category, line_name, installment,
          CAST(amount AS CHAR(40)) AS amount, is_optional
        FROM finance_schedule_lines WHERE schedule_id = @scheduleId ORDER BY term_number, id${lock ? ' FOR UPDATE' : ''}`);
    let scheduleLines = (scheduleLinesResult.recordset || []).map((line) => ({
      id: Number(line.id), termNumber: Number(line.term_number), category: String(line.fee_category),
      lineName: String(line.line_name), installment: String(line.installment), amount: String(line.amount),
      isOptional: flag(line.is_optional)
    }));
    if (restatement?.status === 'active') {
      const targetLinesResult = await transaction.request().input('targetScheduleId', sql.Int, restatement.targetTuitionScheduleId)
        .query(`SELECT id, term_number, fee_category, line_name, installment,
            CAST(amount AS CHAR(40)) AS amount, is_optional
          FROM finance_schedule_lines WHERE schedule_id = @targetScheduleId
            AND LOWER(TRIM(fee_category)) = 'tuition' ORDER BY term_number, id${lock ? ' FOR UPDATE' : ''}`);
      const targetTuitionLines = (targetLinesResult.recordset || []).map((line) => ({
        id: Number(line.id), termNumber: Number(line.term_number), category: String(line.fee_category),
        lineName: String(line.line_name), installment: String(line.installment), amount: String(line.amount),
        isOptional: flag(line.is_optional)
      }));
      if (targetTuitionLines.length !== 12) throw new AnnualFinanceError('The bound tuition installment schedule is incomplete.', 409);
      scheduleLines = [...scheduleLines.filter((line) => line.category.trim().toLowerCase() !== 'tuition'), ...targetTuitionLines]
        .sort((left, right) => left.termNumber - right.termNumber || left.id - right.id);
    }
    const chargeResult = await transaction.request().input('assessmentId', sql.Int, parent.assessment_id)
      .query(`SELECT charge.id, charge.annual_enrollment_id, charge.enrollment_id, charge.schedule_line_id,
          charge.fee_category, charge.line_name, charge.installment, charge.is_manual,
          CAST(charge.amount AS CHAR(40)) AS amount, CAST(charge.waived_amount AS CHAR(40)) AS waived_amount,
          enrollment.annual_term_number AS term_number
        FROM assessed_charges AS charge
        INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
        WHERE charge.assessment_id = @assessmentId
          AND EXISTS (SELECT 1 FROM v_finance_effective_assessed_charges AS effective WHERE effective.id = charge.id)
        ORDER BY charge.id${lock ? ' FOR UPDATE' : ''}`);
    const charges = chargeResult.recordset || [];
    const chargeIds = charges.map((charge) => Number(charge.id));
    let adjustments = [];
    if (chargeIds.length) {
      const request = transaction.request();
      const names = chargeIds.map((chargeId, index) => {
        const name = `charge${index}`;
        request.input(name, sql.BigInt, chargeId);
        return `@${name}`;
      });
      const adjustmentResult = await request.query(`SELECT adjustment.id, adjustment.charge_id,
          adjustment.reverses_adjustment_id, CAST(adjustment.amount AS CHAR(40)) AS amount
        FROM finance_charge_adjustments AS adjustment
        WHERE adjustment.charge_id IN (${names.join(', ')}) ORDER BY adjustment.id${lock ? ' FOR UPDATE' : ''}`);
      adjustments = (adjustmentResult.recordset || []).map((row) => ({
        id: Number(row.id), chargeId: Number(row.charge_id),
        reversesAdjustmentId: row.reverses_adjustment_id == null ? null : Number(row.reverses_adjustment_id),
        amount: String(row.amount)
      }));
    }
    const assessedComposition = canonicalAssessmentSnapshot(charges.map((charge) => ({
      scheduleLineId: charge.schedule_line_id == null ? null : Number(charge.schedule_line_id),
      termNumber: Number(charge.term_number), category: charge.fee_category, lineName: charge.line_name,
      installment: charge.installment, grossAmount: String(charge.amount), waivedAmount: String(charge.waived_amount || '0.00')
    })));
    const assessmentFingerprint = assessedComposition.fingerprint;
    const assessmentSnapshotState = { assessmentId: Number(parent.assessment_id),
      scheduleId: Number(parent.schedule_id), scheduleVersion: Number(parent.schedule_version),
      voucherCode: parent.voucher_code_snapshot, payableTotal: assessedComposition.total,
      optionalLineIds, postedComposition: assessmentFingerprint };
    const activeRestatement = activeRestatementFingerprint(restatement);
    if (activeRestatement) assessmentSnapshotState.restatement = activeRestatement;
    const assessmentSnapshotFingerprint = requestFingerprint(assessmentSnapshotState);
    const dependencyState = {
      annualEnrollmentId: Number(parent.id), studentId: Number(parent.student_id), schoolYear: parent.school_year,
      gradeLevel: parent.grade_level, voucherCode: parent.voucher_code, entryTermNumber: Number(parent.entry_term_number || 1),
      assessmentId: Number(parent.assessment_id), scheduleId: Number(parent.schedule_id),
      scheduleVersion: Number(parent.schedule_version), assessedVoucher: parent.voucher_code_snapshot,
      currentVoucher: parent.voucher_code, voucherReview, optionalLineIds, scheduleLines,
      charges: charges.map((charge) => ({
        id: Number(charge.id), termNumber: Number(charge.term_number), scheduleLineId: charge.schedule_line_id == null ? null : Number(charge.schedule_line_id),
        category: charge.fee_category, lineName: charge.line_name, installment: charge.installment,
        isManual: flag(charge.is_manual), amount: String(charge.amount), waivedAmount: String(charge.waived_amount || '0.00')
      })),
      adjustments
    };
    if (activeRestatement) dependencyState.restatement = activeRestatement;
    const dependencyFingerprint = requestFingerprint(dependencyState);
    const selectedOptional = new Set(optionalLineIds);
    const expectedDpLines = scheduleLines.filter((line) => line.termNumber === Number(parent.entry_term_number || 1)
      && line.category.trim().toLowerCase() === 'tuition' && line.installment.trim().toUpperCase() === 'DP'
      && (!line.isOptional || selectedOptional.has(line.id)));
    const assessedDpByScheduleLine = new Map();
    for (const charge of charges) {
      if (Number(charge.term_number) !== Number(parent.entry_term_number || 1)
        || String(charge.fee_category || '').trim().toLowerCase() !== 'tuition'
        || String(charge.installment || '').trim().toUpperCase() !== 'DP') continue;
      if (charge.schedule_line_id != null) {
        const scheduleLineId = Number(charge.schedule_line_id);
        assessedDpByScheduleLine.set(scheduleLineId, (assessedDpByScheduleLine.get(scheduleLineId) || 0) + 1);
      }
    }
    let dp = { status: 'missing_dp_setup' };
    if (expectedDpLines.length && expectedDpLines.every((line) => assessedDpByScheduleLine.get(line.id) === 1)) {
      const dpChargeIds = charges.filter((charge) => Number(charge.term_number) === Number(parent.entry_term_number || 1)
        && String(charge.fee_category || '').trim().toLowerCase() === 'tuition'
        && String(charge.installment || '').trim().toUpperCase() === 'DP').map((charge) => Number(charge.id));
      const dueResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('entryTermNumber', sql.TinyInt, Number(parent.entry_term_number || 1))
        .query(`SELECT due.charge_id, CAST(due.amount_due AS CHAR(40)) AS amount_due,
            CAST(due.annual_allocated AS CHAR(40)) AS annual_allocated,
            CAST(due.legacy_allocated AS CHAR(40)) AS legacy_allocated
          FROM v_finance_assessed_charge_due AS due
          INNER JOIN enrollments AS enrollment ON enrollment.id = due.enrollment_id
          WHERE due.annual_enrollment_id = @annualEnrollmentId
            AND enrollment.annual_term_number = @entryTermNumber`);
      const dpIds = new Set(dpChargeIds);
      const dpBalances = (dueResult.recordset || []).filter((row) => dpIds.has(Number(row.charge_id)));
      if (dpBalances.length === dpChargeIds.length) {
        dp = classifyEntryDownPaymentBalances(dpBalances);
      } else {
        dp = { status: 'ledger_unavailable' };
      }
    } else if (expectedDpLines.length && charges.some((charge) => Number(charge.term_number) === Number(parent.entry_term_number || 1)
      && String(charge.fee_category || '').trim().toLowerCase() === 'tuition'
      && String(charge.installment || '').trim().toUpperCase() === 'DP')) {
      dp = { status: 'incomplete_assessment' };
    }
    const latestResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .input('assessmentId', sql.Int, parent.assessment_id)
      .query(`SELECT id, assessment_fingerprint, dependency_fingerprint, zero_dp_attested,
          reviewed_by, reviewed_by_role, reviewed_at, current_voucher_code_snapshot,
          voucher_review_event_id
        FROM annual_finance_assessment_reviews
        WHERE annual_enrollment_id = @annualEnrollmentId AND assessment_id = @assessmentId
        ORDER BY id DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`);
    return { parent, assessment: { id: Number(parent.assessment_id), scheduleId: Number(parent.schedule_id),
      scheduleVersion: Number(parent.schedule_version), voucherCode: parent.voucher_code_snapshot,
      optionalLineIds, total: assessedComposition.total, snapshotFingerprint: assessmentSnapshotFingerprint },
      assessmentFingerprint, dependencyFingerprint, dp, voucherReview, latestReview: latestResult.recordset?.[0] || null,
      ...(restatement ? { restatement } : {}) };
  }

  async function recordAnnualFinanceReview(transaction, actor, annualEnrollmentId, confirmation) {
    const intakeResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT intake_status FROM annual_enrollments WHERE id = @annualEnrollmentId FOR UPDATE`);
    if (intakeResult.recordset?.[0]?.intake_status !== 'pending') return { skipped: true };
    const review = await annualFinanceEvidenceSnapshot(transaction, annualEnrollmentId, { lock: true });
    if (!review.assessment || !review.assessmentFingerprint || !review.dependencyFingerprint) {
      throw new AnnualFinanceError('The saved fee assessment could not be verified for Finance review.', 409);
    }
    if ((review.voucherReview && review.voucherReview.status !== 'resolved')
      || (review.parent.voucher_code !== review.assessment.voucherCode && !review.voucherReview)) {
      throw new AnnualFinanceError('Finance must resolve the current voucher change for this posted assessment before re-review.', 409);
    }
    if (review.dp.status === 'missing_dp_setup' || review.dp.status === 'incomplete_assessment'
      || review.dp.status === 'ledger_unavailable' || review.dp.status === 'invalid') {
      throw new AnnualFinanceError('The entry-term tuition down-payment setup or ledger needs Finance review before enrollment can proceed.', 409);
    }
    const zeroDpAttested = flag(confirmation.zeroDpAttested);
    if (review.dp.status === 'zero_due' && !zeroDpAttested) {
      throw new AnnualFinanceError('Explicitly approve this legitimately zero/net-waived entry-term down payment in the Finance review before saving.', 409);
    }
    if (review.dp.status !== 'zero_due' && zeroDpAttested) {
      throw new AnnualFinanceError('The zero down-payment approval does not match the current positive entry-term tuition obligation.', 409);
    }
    const idempotencyKey = uuid(confirmation.idempotencyKey, 'Finance assessment review');
    const fingerprint = requestFingerprint({ annualEnrollmentId, assessmentId: review.assessment.id,
      assessmentFingerprint: review.assessmentFingerprint, dependencyFingerprint: review.dependencyFingerprint,
      zeroDpAttested });
    const priorResult = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
      .query(`SELECT annual_enrollment_id, assessment_id, assessment_fingerprint,
          dependency_fingerprint, zero_dp_attested, request_fingerprint
        FROM annual_finance_assessment_reviews WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
    const prior = priorResult.recordset?.[0];
    if (prior) {
      if (Number(prior.annual_enrollment_id) !== annualEnrollmentId
        || Number(prior.assessment_id) !== review.assessment.id
        || prior.assessment_fingerprint !== review.assessmentFingerprint
        || prior.dependency_fingerprint !== review.dependencyFingerprint
        || flag(prior.zero_dp_attested) !== zeroDpAttested || prior.request_fingerprint !== fingerprint) {
        throw new AnnualFinanceError('This Finance review token was already used for different assessment details.', 409);
      }
      return { ...review, alreadyReviewed: true };
    }
    const inserted = await transaction.request()
      .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .input('assessmentId', sql.Int, review.assessment.id)
      .input('scheduleId', sql.Int, review.assessment.scheduleId)
      .input('scheduleVersion', sql.Int, review.assessment.scheduleVersion)
      .input('voucherCode', sql.NVarChar(10), review.assessment.voucherCode)
      .input('currentVoucherCode', sql.NVarChar(10), review.parent.voucher_code)
      .input('voucherReviewEventId', sql.BigInt, review.voucherReview?.eventId || null)
      .input('selectionJson', sql.NVarChar(sql.MAX), JSON.stringify({ optionalLineIds: review.assessment.optionalLineIds }))
      .input('assessmentFingerprint', sql.Char(64), review.assessmentFingerprint)
      .input('dependencyFingerprint', sql.Char(64), review.dependencyFingerprint)
      .input('zeroDpAttested', sql.Bit, zeroDpAttested)
      .input('actorId', sql.Int, actor.id)
      .input('actorRole', sql.NVarChar(20), actor.role)
      .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
      .input('requestFingerprint', sql.Char(64), fingerprint)
      .query(`INSERT INTO annual_finance_assessment_reviews
          (annual_enrollment_id, assessment_id, schedule_id, schedule_version, voucher_code_snapshot,
            current_voucher_code_snapshot, voucher_review_event_id,
            selection_json, assessment_fingerprint, dependency_fingerprint, zero_dp_attested,
            reviewed_by, reviewed_by_role, idempotency_key, request_fingerprint)
        VALUES (@annualEnrollmentId, @assessmentId, @scheduleId, @scheduleVersion, @voucherCode,
          @currentVoucherCode, @voucherReviewEventId,
          @selectionJson, @assessmentFingerprint, @dependencyFingerprint, @zeroDpAttested,
          @actorId, @actorRole, @idempotencyKey, @requestFingerprint)`);
    await writeAudit(transaction, actor, 'annual_assessment_reviewed', review.assessment.id, {
      annualEnrollmentId, scheduleId: review.assessment.scheduleId,
      scheduleVersion: review.assessment.scheduleVersion, voucherCode: review.assessment.voucherCode,
      zeroDpAttested
    });
    return { reviewId: generatedId(inserted, 'Finance assessment review'), ...review };
  }

  async function getAnnualEntryFinanceReadinessForRegistrar(actorInput, annualEnrollmentInput) {
    const annualEnrollmentId = id(annualEnrollmentInput, 'annual enrollment');
    const pool = await getPool();
    await requireRegistrarActor(pool.request(), actorInput);
    return withRosterReadSnapshot(pool, async (snapshot) => {
      const state = await annualFinanceEvidenceSnapshot(snapshot, annualEnrollmentId);
      if (!state.parent) throw new AnnualFinanceError('Annual enrollment not found.', 404);
      const voucherEvidenceMatches = state.latestReview
        && String(state.latestReview.current_voucher_code_snapshot || '') === String(state.parent.voucher_code || '')
        && (state.latestReview.voucher_review_event_id == null ? state.voucherReview == null
          : Number(state.latestReview.voucher_review_event_id) === Number(state.voucherReview?.eventId));
      const matchingReview = state.latestReview && voucherEvidenceMatches
        && state.latestReview.assessment_fingerprint === state.assessmentFingerprint
        && state.latestReview.dependency_fingerprint === state.dependencyFingerprint;
      const status = !state.assessment ? 'awaiting_finance_assessment'
        : !matchingReview ? 'finance_review_required'
          : state.dp.status === 'unpaid' ? 'awaiting_down_payment'
            : state.dp.status === 'settled' || (state.dp.status === 'zero_due' && flag(state.latestReview.zero_dp_attested))
              ? 'ready_for_registrar' : 'finance_review_required';
      return { annualEnrollmentId, entryTermNumber: Number(state.parent.entry_term_number || 1), status,
        hasAssessment: Boolean(state.assessment), reviewed: Boolean(matchingReview),
        downPaymentSettled: state.dp.status === 'settled' || state.dp.status === 'zero_due',
        zeroDownPaymentApproved: Boolean(matchingReview && flag(state.latestReview.zero_dp_attested)) };
    });
  }

  async function assertAnnualEntryDownPaymentReadyInTransaction(transaction, annualEnrollmentInput) {
    const annualEnrollmentId = id(annualEnrollmentInput, 'annual enrollment');
    const state = await annualFinanceEvidenceSnapshot(transaction, annualEnrollmentId, { lock: true });
    if (!state.assessment || !state.assessmentFingerprint || !state.dependencyFingerprint) {
      throw new AnnualFinanceError('Finance must post and review the annual assessment before enrollment can be confirmed.', 409);
    }
    const review = state.latestReview;
    const voucherEvidenceMatches = review
      && String(review.current_voucher_code_snapshot || '') === String(state.parent.voucher_code || '')
      && (review.voucher_review_event_id == null ? state.voucherReview == null
        : Number(review.voucher_review_event_id) === Number(state.voucherReview?.eventId));
    if ((state.voucherReview && state.voucherReview.status !== 'resolved')
      || (state.parent.voucher_code !== state.assessment.voucherCode && !state.voucherReview)) {
      throw new AnnualFinanceError('Finance must resolve the current voucher change for this posted assessment before enrollment can be confirmed.', 409);
    }
    if (!review || !voucherEvidenceMatches || review.assessment_fingerprint !== state.assessmentFingerprint
      || review.dependency_fingerprint !== state.dependencyFingerprint) {
      throw new AnnualFinanceError('The fee assessment changed after Finance review. Finance must review the current assessment before enrollment can be confirmed.', 409);
    }
    if (state.dp.status === 'missing_dp_setup' || state.dp.status === 'incomplete_assessment'
      || state.dp.status === 'ledger_unavailable' || state.dp.status === 'invalid') {
      throw new AnnualFinanceError('The entry-term tuition down-payment setup or ledger needs Finance review before enrollment can proceed.', 409);
    }
    if (state.dp.status === 'unpaid') {
      throw new AnnualFinanceError('The full scheduled entry-term tuition down payment must be settled before enrollment can be confirmed.', 409);
    }
    if (state.dp.status === 'zero_due' && !flag(review.zero_dp_attested)) {
      throw new AnnualFinanceError('Finance must explicitly approve the zero/net-waived entry-term tuition down payment before enrollment can be confirmed.', 409);
    }
    return { assessmentId: state.assessment.id, scheduleId: state.assessment.scheduleId,
      scheduleVersion: state.assessment.scheduleVersion, voucherCode: state.assessment.voucherCode,
      optionalLineIds: state.assessment.optionalLineIds, payableTotal: state.assessment.total,
      assessmentSnapshotFingerprint: state.assessment.snapshotFingerprint,
      financeReviewId: Number(review.id), entryDpState: state.dp.status };
  }

  async function runTransaction(callback) {
    try {
      if (transaction) return await callback(transaction);
      return await runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new AnnualFinanceError('This finance submission was already recorded or conflicts with an existing record.', 409);
      throw error;
    }
  }

  async function withRosterReadSnapshot(pool, callback) {
    if (transaction) return callback(transaction);
    const snapshot = transactionFactory(pool);
    let started = false;
    try {
      await snapshot.begin(sql.ISOLATION_LEVEL.REPEATABLE_READ);
      started = true;
      const result = await callback(snapshot);
      await snapshot.commit();
      return result;
    } catch (error) {
      if (started) await snapshot.rollback().catch(() => {});
      throw error;
    }
  }

  async function requireFinanceActor(request, actorInput) {
    const actorId = id(actorInput, 'user');
    const result = await request.input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin') FOR UPDATE`);
    const actor = result.recordset?.[0];
    if (!actor) throw new AnnualFinanceError('Your finance access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function requireFinanceActorForRoster(request, actorInput) {
    const actorId = id(actorInput, 'user');
    const result = await request.input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin')`);
    const actor = result.recordset?.[0];
    if (!actor) throw new AnnualFinanceError('Your finance access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function requireRegistrarActor(request, actorInput) {
    const actorId = id(actorInput, 'user');
    const result = await request.input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role = 'registrar' FOR UPDATE`);
    const actor = result.recordset?.[0];
    if (!actor) throw new AnnualFinanceError('Your registrar access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function requireConfirmationStaffActor(request, actorInput) {
    const actorId = id(actorInput, 'user');
    const result = await request.input('actorId', sql.Int, actorId)
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin') FOR UPDATE`);
    const actor = result.recordset?.[0];
    if (!actor) throw new AnnualFinanceError('Your registrar or database administrator access is no longer active. Sign in again.', 403);
    return actor;
  }

  async function writeAudit(transaction, actor, action, entityId, details) {
    await transaction.request()
      .input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), actor.role === 'database_admin' ? `database_admin.finance_${action}` : `finance.${action}`)
      .input('entityType', sql.NVarChar(100), 'annual_finance')
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  async function requireFreshApproval(transaction, actor, enrollmentId, reason) {
    const selected = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
      .query(`SELECT enrollment.enrollment_status, annual.intake_status, approval.status, approval.finance_review_required
        FROM enrollments AS enrollment
        INNER JOIN annual_enrollments AS annual  ON annual.id = enrollment.annual_enrollment_id
        LEFT JOIN term_finance_approvals AS approval  ON approval.enrollment_id = enrollment.id
        WHERE enrollment.id = @enrollmentId FOR UPDATE`);
    const current = selected.recordset?.[0];
    // Current annual enrollment is confirmed by the registrar. Keep the old
    // finance approval rows as historical records; money corrections do not
    // mutate them or change enrollment state.
    if (!current || current.intake_status !== 'legacy') return;
    if (current.status !== 'approved' || !['pending_payment', 'enrolled'].includes(current.enrollment_status)) return;
    const finalized = current.enrollment_status === 'enrolled';
    await transaction.request()
      .input('enrollmentId', sql.Int, enrollmentId)
      .input('actorId', sql.Int, actor.id)
      .input('reason', sql.NVarChar(1000), reason)
      .input('finalized', sql.Bit, finalized)
      .query(`UPDATE term_finance_approvals
        SET status = CASE WHEN @finalized = 1 THEN status ELSE 'pending' END,
          approved_by = CASE WHEN @finalized = 1 THEN approved_by ELSE NULL END,
          approved_at = CASE WHEN @finalized = 1 THEN approved_at ELSE NULL END,
          approval_reason = CASE WHEN @finalized = 1 THEN approval_reason ELSE NULL END,
          finance_review_required = @finalized,
          finance_review_reason = CASE WHEN @finalized = 1 THEN @reason ELSE NULL END,
          finance_review_requested_by = CASE WHEN @finalized = 1 THEN @actorId ELSE NULL END,
          finance_review_requested_at = CASE WHEN @finalized = 1 THEN UTC_TIMESTAMP(6) ELSE NULL END
        WHERE enrollment_id = @enrollmentId AND status = 'approved'`);
    await writeAudit(transaction, actor, finalized ? 'term_finance_review_required' : 'term_approval_reopened', enrollmentId, { reason, enrollmentPreserved: finalized });
  }

  async function verifyStudent(transaction, studentId) {
    const student = await debtRevisions.lockStudent(transaction, studentId);
    if (!student) throw new AnnualFinanceError('Student record not found.', 404);
    if (student.status === 'archived') throw new AnnualFinanceError('Archived students cannot receive new finance records.', 409);
    return student;
  }

  async function listSchedules(actorInput) {
    const pool = await getPool();
    await requireFinanceActor(pool.request(), actorInput);
    const result = await pool.request().query(`SELECT schedule.id, schedule.school_year, schedule.grade_level,
        schedule.voucher_code, schedule.version_no, schedule.status, schedule.created_at,
        line.id AS line_id, line.term_number, line.fee_category, line.line_name, line.installment,
        CAST(line.amount AS CHAR(40)) AS amount, line.is_optional
      FROM finance_schedules AS schedule
      LEFT JOIN finance_schedule_lines AS line ON line.schedule_id = schedule.id
      ORDER BY schedule.school_year DESC, schedule.grade_level, schedule.voucher_code, schedule.version_no DESC,
        line.term_number, line.id`);
    return result.recordset || [];
  }

  async function createSchedule(actorInput, input = {}) {
    const schoolYear = cleanText(input.schoolYear, 'School year', 20, true);
    const gradeLevel = cleanText(input.gradeLevel, 'Grade level', 50, true);
    if (!['Grade 11', 'Grade 12'].includes(gradeLevel)) throw new AnnualFinanceError('Choose Grade 11 or Grade 12.');
    const voucherCode = input.voucherCode;
    if (!['PUB', 'ESC', 'NV'].includes(voucherCode)) throw new AnnualFinanceError('Choose PUB, ESC, or NV.');
    const lines = normalizeLineRows(input.lines);
    const idempotencyKey = uuid(input.idempotencyKey, 'schedule submission');
    let expectedPreviousSchedule = null;
    if (input.expectedPreviousSchedule != null) {
      if (typeof input.expectedPreviousSchedule !== 'object' || Array.isArray(input.expectedPreviousSchedule)) {
        throw new AnnualFinanceError('The expected previous schedule is invalid.');
      }
      expectedPreviousSchedule = {
        scheduleId: id(input.expectedPreviousSchedule.scheduleId, 'previous schedule'),
        versionNo: id(input.expectedPreviousSchedule.versionNo, 'previous schedule version')
      };
    }
    const fingerprint = requestFingerprint({ schoolYear, gradeLevel, voucherCode, lines: lines.map(({ termNumber, category, lineName, installment, amount, isOptional }) => ({ termNumber, category, lineName, installment, amount, isOptional })) });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      const priorSchedule = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query('SELECT id, version_no, request_fingerprint FROM finance_schedules  WHERE idempotency_key = @idempotencyKey FOR UPDATE');
      if (priorSchedule.recordset?.[0]) {
        const prior = priorSchedule.recordset[0];
        if (prior.request_fingerprint !== fingerprint) throw new AnnualFinanceError('This submission token was already used for different schedule details.', 409);
        return { scheduleId: prior.id, versionNo: prior.version_no, alreadyRecorded: true };
      }
      const contextResult = await transaction.request()
        .input('schoolYear', sql.NVarChar(20), schoolYear)
        .input('gradeLevel', sql.NVarChar(50), gradeLevel)
        .input('voucherCode', sql.NVarChar(10), voucherCode)
        .query(`SELECT id, version_no, status FROM finance_schedules
          WHERE school_year = @schoolYear AND grade_level = @gradeLevel AND voucher_code = @voucherCode
          ORDER BY version_no DESC FOR UPDATE`);
      const contextSchedules = contextResult.recordset || [];
      const previousSchedule = contextSchedules.find((row) => row.status === 'active');
      const latestVersion = Number(contextSchedules[0]?.version_no || 0);
      if (expectedPreviousSchedule && (Number(previousSchedule?.id) !== expectedPreviousSchedule.scheduleId
        || Number(previousSchedule?.version_no) !== expectedPreviousSchedule.versionNo
        || latestVersion !== expectedPreviousSchedule.versionNo)) {
        throw new AnnualFinanceError('The active approved schedule changed while this update was prepared. Reload the schedule and review the latest version before saving.', 409);
      }
      const versionNo = latestVersion + 1;
      if (!Number.isSafeInteger(versionNo) || versionNo > 2147483647) throw new AnnualFinanceError('The schedule version limit has been reached.', 409);
      if (previousSchedule) {
        await transaction.request().input('scheduleId', sql.Int, previousSchedule.id)
          .query('UPDATE finance_schedules SET status = N\'retired\' WHERE id = @scheduleId AND status = N\'active\'');
      }
      const inserted = await transaction.request()
        .input('schoolYear', sql.NVarChar(20), schoolYear)
        .input('gradeLevel', sql.NVarChar(50), gradeLevel)
        .input('voucherCode', sql.NVarChar(10), voucherCode)
        .input('versionNo', sql.Int, versionNo)
        .input('actorId', sql.Int, actor.id)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.NVarChar(64), fingerprint)
        .query(`INSERT INTO finance_schedules (school_year, grade_level, voucher_code, version_no, idempotency_key, request_fingerprint, created_by)
          VALUES (@schoolYear, @gradeLevel, @voucherCode, @versionNo, @idempotencyKey, @requestFingerprint, @actorId)`);
      const scheduleId = generatedId(inserted, 'Finance schedule');
      for (const line of lines) {
        await transaction.request()
          .input('scheduleId', sql.Int, scheduleId)
          .input('termNumber', sql.TinyInt, line.termNumber)
          .input('category', sql.NVarChar(40), line.category)
          .input('lineName', sql.NVarChar(120), line.lineName)
          .input('installment', sql.NVarChar(40), line.installment)
          .input('amount', sql.Decimal(12, 2), line.amount)
          .input('isOptional', sql.Bit, line.isOptional)
          .query(`INSERT INTO finance_schedule_lines
              (schedule_id, term_number, fee_category, line_name, installment, amount, is_optional)
            VALUES (@scheduleId, @termNumber, @category, @lineName, @installment, @amount, @isOptional)`);
      }
      await writeAudit(transaction, actor, 'schedule_version_created', scheduleId, { schoolYear, gradeLevel, voucherCode, versionNo, lineCount: lines.length });
      return { scheduleId, versionNo };
    });
  }

  async function annualAssessmentPreview(actorInput, annualEnrollmentInput, optionalLineInputs = []) {
    const annualEnrollmentId = id(annualEnrollmentInput, 'annual enrollment');
    const selectedOptionalLines = normalizeSelections(optionalLineInputs);
    const pool = await getPool();
    await requireFinanceActor(pool.request(), actorInput);
    const parentResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT annual.id, annual.student_id, annual.school_year, annual.grade_level, annual.voucher_code, annual.entry_term_number,
          annual.intake_status,
          student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix
        FROM annual_enrollments AS annual
        INNER JOIN students AS student ON student.id = annual.student_id
        WHERE annual.id = @annualEnrollmentId AND annual.intake_status <> 'legacy' FOR UPDATE`);
    const parent = parentResult.recordset?.[0];
    if (!parent) throw new AnnualFinanceError('Annual enrollment not found.', 404);
    const existingAssessment = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT assessment.id, assessment.schedule_id, assessment.schedule_version,
          assessment.voucher_code_snapshot, assessment.selection_json, assessment.assessed_at
        FROM annual_assessments AS assessment
        WHERE assessment.annual_enrollment_id = @annualEnrollmentId FOR UPDATE`);
    const posted = existingAssessment.recordset?.[0] || null;
    if (posted) {
      const voucherReview = await loadVoucherReviewState(pool.request(), sql, {
        annualEnrollmentId, assessmentId: Number(posted.id), scheduleId: Number(posted.schedule_id),
        scheduleVersion: Number(posted.schedule_version), assessedVoucherCode: posted.voucher_code_snapshot,
        currentVoucherCode: parent.voucher_code, assessedAt: posted.assessed_at
      });
      if (parent.voucher_code !== posted.voucher_code_snapshot
        && (parent.intake_status !== 'pending' || voucherReview?.status !== 'resolved')) {
        throw new AnnualFinanceError('The voucher changed after this assessment. Finance must review the existing assessment before enrollment can be confirmed.', 409);
      }
      if (parent.intake_status === 'pending' && voucherReview && voucherReview.status !== 'resolved') {
        throw new AnnualFinanceError('Resolve the current Finance voucher review before re-attesting this posted assessment.', 409);
      }
      let selection = {};
      try { selection = JSON.parse(posted.selection_json || '{}'); } catch { throw new AnnualFinanceError('The saved assessment selection needs staff review.', 409); }
      const selected = normalizeSelections(selection.optionalLineIds || []);
      const restatement = await loadAnnualRestatement(pool.request(), sql, annualEnrollmentId, Number(posted.id));
      const charges = await pool.request().input('assessmentId', sql.Int, posted.id)
        .query(`SELECT charge.id, charge.enrollment_id, enrollment.annual_term_number AS term_number,
            charge.fee_category, charge.line_name, charge.installment, charge.schedule_line_id,
            COALESCE(schedule_line.is_optional, CAST(0 AS UNSIGNED)) AS is_optional,
            CAST(charge.amount AS CHAR(40)) AS amount,
            CAST(charge.waived_amount AS CHAR(40)) AS waived_amount
          FROM v_finance_effective_assessed_charges AS charge
          INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
          LEFT JOIN finance_schedule_lines AS schedule_line ON schedule_line.id = charge.schedule_line_id
          WHERE charge.assessment_id = @assessmentId ORDER BY enrollment.annual_term_number, charge.id`);
      const lines = (charges.recordset || []).map((line) => {
        const grossCents = parseMoneyCents(String(line.amount), { allowZero: true });
        const waiverCents = parseMoneyCents(String(line.waived_amount || '0.00'), { allowZero: true });
        return { scheduleLineId: line.schedule_line_id == null ? null : Number(line.schedule_line_id), termNumber: Number(line.term_number), enrollmentId: Number(line.enrollment_id),
          category: line.fee_category, lineName: line.line_name, installment: line.installment,
          amount: formatMoneyCents(grossCents - waiverCents), grossAmount: String(line.amount),
          waivedAmount: formatMoneyCents(waiverCents), isOptional: flag(line.is_optional), alreadyPosted: true };
      });
      const snapshot = canonicalAssessmentSnapshot(lines);
      const totalCents = parseMoneyCents(snapshot.total, { allowZero: true });
      const tuitionBreakdown = tuitionInstallmentBreakdown(lines, parent.entry_term_number);
      const activeRestatement = activeRestatementFingerprint(restatement);
      const snapshotFingerprint = activeRestatement
        ? requestFingerprint({ postedComposition: snapshot.fingerprint, restatement: activeRestatement })
        : snapshot.fingerprint;
      return { parent, scheduleId: Number(posted.schedule_id), scheduleVersion: Number(posted.schedule_version),
        voucherCode: posted.voucher_code_snapshot, assessmentId: Number(posted.id), existingAssessment: true,
        voucherReview, ...(restatement ? { restatement } : {}),
        optionalLineIds: [...selected], lines, total: formatMoneyCents(totalCents), totalCents,
        optionalLines: [], termTotals: assessmentTermTotals(lines, parent.entry_term_number),
        tuitionTermTotals: tuitionTermTotals(lines, parent.entry_term_number),
        nonTuitionTermTotals: nonTuitionTermTotals(lines, parent.entry_term_number),
        tuitionBreakdown,
        tuitionBreakdownComplete: tuitionBreakdown.filter((term) => !term.installments[0].notApplicable).every((term) => term.complete),
        snapshotFingerprint };
    }

    const scheduleResult = await pool.request()
      .input('schoolYear', sql.NVarChar(20), parent.school_year)
      .input('gradeLevel', sql.NVarChar(50), parent.grade_level)
      .input('voucherCode', sql.NVarChar(10), parent.voucher_code)
      .query(`SELECT id, version_no FROM finance_schedules
        WHERE school_year = @schoolYear AND grade_level = @gradeLevel AND voucher_code = @voucherCode AND status = 'active'
        ORDER BY version_no DESC LIMIT 1`);
    const schedule = scheduleResult.recordset?.[0];
    if (!schedule) throw new AnnualFinanceError('No active approved fee schedule matches this school year, grade, and voucher. Ask Finance to configure one, then reload this page.', 409);
    const linesResult = await pool.request().input('scheduleId', sql.Int, schedule.id)
      .query(`SELECT id, term_number, fee_category, line_name, installment,
          CAST(amount AS CHAR(40)) AS amount, is_optional
        FROM finance_schedule_lines WHERE schedule_id = @scheduleId ORDER BY term_number, id`);
    const placementsResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT id AS enrollment_id, annual_term_number, enrollment_status, term_scope_status, academic_term_id
        FROM enrollments WHERE annual_enrollment_id = @annualEnrollmentId ORDER BY annual_term_number`);
    const placements = placementsResult.recordset || [];
    if (placements.length !== 3 || placements.some((placement, index) => Number(placement.annual_term_number) !== index + 1)) {
      throw new AnnualFinanceError('All three term placements must exist before the annual assessment can be previewed.', 409);
    }
    const entryTermNumber = Number(parent.entry_term_number || 1);
    if (placements.some((placement) => Number(placement.annual_term_number) < entryTermNumber
      ? placement.term_scope_status !== 'not_applicable' || placement.enrollment_status !== 'not_applicable'
      : placement.term_scope_status !== 'applicable' || placement.enrollment_status !== 'pending_payment')) {
      throw new AnnualFinanceError('An assessment can be previewed only before a term is finalized.', 409);
    }
    const enrollmentByTerm = new Map(placements.filter((placement) => Number(placement.annual_term_number) >= entryTermNumber)
      .map((placement) => [Number(placement.annual_term_number), placement]));
    const rawLines = linesResult.recordset || [];
    if (rawLines.some((line) => line.is_optional && !selectedOptionalLines.has(Number(line.id)))) {
      // Unselected optional lines are intentionally omitted from the assessment.
    }
    const applicableLines = rawLines.filter((line) => Number(line.term_number) >= entryTermNumber);
    const optionalLines = applicableLines.filter((line) => flag(line.is_optional)).map((line) => ({
      id: Number(line.id), termNumber: Number(line.term_number), category: line.fee_category,
      lineName: line.line_name, installment: line.installment, amount: String(line.amount),
      selected: selectedOptionalLines.has(Number(line.id))
    }));
    const included = applicableLines.filter((line) => !line.is_optional || selectedOptionalLines.has(Number(line.id)));
    for (const selectedId of selectedOptionalLines) {
      if (!applicableLines.some((line) => Number(line.id) === selectedId && flag(line.is_optional))) {
        throw new AnnualFinanceError('A selected optional fee line is not part of the active schedule.', 409);
      }
    }
    let lines = included.map((line) => ({
      scheduleLineId: Number(line.id), termNumber: Number(line.term_number), enrollmentId: enrollmentByTerm.get(Number(line.term_number))?.enrollment_id,
      category: line.fee_category, lineName: line.line_name, installment: line.installment,
      amount: String(line.amount), isOptional: flag(line.is_optional)
    }));
    const exemptionRulesResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT exemption_rule.id, exemption_rule.term_number, exemption_rule.fee_category, exemption_rule.line_name, exemption_rule.is_full_coverage,
          CAST(exemption_rule.approved_amount AS CHAR(40)) AS approved_amount,
          CAST(COALESCE(applied.applied_total, 0) AS CHAR(40)) AS applied_total
        FROM finance_exemption_cases AS exemption
        INNER JOIN finance_exemption_rules AS exemption_rule ON exemption_rule.exemption_case_id = exemption.id
        LEFT JOIN (SELECT exemption_rule_id, SUM(amount) AS applied_total
          FROM finance_exemption_applications GROUP BY exemption_rule_id) AS applied
          ON applied.exemption_rule_id = exemption_rule.id
        WHERE exemption.annual_enrollment_id = @annualEnrollmentId AND exemption.status = 'approved'
        ORDER BY exemption_rule.id`);
    lines = applyExemptionPreview(lines, exemptionRulesResult.recordset || []);
    const snapshot = canonicalAssessmentSnapshot(lines);
    const totalCents = parseMoneyCents(snapshot.total, { allowZero: true });
    const tuitionBreakdown = tuitionInstallmentBreakdown(lines, entryTermNumber);
    return { parent, scheduleId: schedule.id, scheduleVersion: schedule.version_no, voucherCode: parent.voucher_code,
      assessmentId: null, existingAssessment: false, optionalLineIds: [...selectedOptionalLines], optionalLines, lines,
      total: formatMoneyCents(totalCents), totalCents, termTotals: assessmentTermTotals(lines, entryTermNumber),
      tuitionTermTotals: tuitionTermTotals(lines, entryTermNumber),
      nonTuitionTermTotals: nonTuitionTermTotals(lines, entryTermNumber),
      tuitionBreakdown,
      tuitionBreakdownComplete: tuitionBreakdown.filter((term) => !term.installments[0].notApplicable).every((term) => term.complete),
      snapshotFingerprint: snapshot.fingerprint };
  }

  async function annualConfirmationAssessmentSnapshotForStaff(actorInput, annualEnrollmentInput) {
    const annualEnrollmentId = id(annualEnrollmentInput, 'annual enrollment');
    const pool = await getPool();
    await requireConfirmationStaffActor(pool.request(), actorInput);
    const confirmationResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT confirmation.id AS confirmation_id, confirmation.annual_enrollment_id,
          confirmation.assessment_id, confirmation.schedule_id, confirmation.schedule_version,
          confirmation.voucher_code_snapshot, CAST(confirmation.payable_total AS CHAR(40)) AS payable_total,
          confirmation.selection_json, confirmation.assessment_snapshot_fingerprint, confirmation.confirmed_at,
          annual.student_id, annual.school_year, annual.grade_level, annual.entry_term_number,
          student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix
        FROM annual_registrar_confirmations AS confirmation
        INNER JOIN annual_enrollments AS annual ON annual.id = confirmation.annual_enrollment_id
        INNER JOIN students AS student ON student.id = confirmation.student_id
        WHERE confirmation.annual_enrollment_id = @annualEnrollmentId AND annual.intake_status <> 'legacy'`);
    const confirmation = confirmationResult.recordset?.[0];
    if (!confirmation) throw new AnnualFinanceError('Enrollment confirmation not found.', 404);

    let confirmationSelection = {};
    let assessmentSelection = {};
    try {
      confirmationSelection = JSON.parse(confirmation.selection_json || '{}');
    } catch { throw new AnnualFinanceError('The saved confirmation selection could not be verified.', 409); }
    const assessmentResult = await pool.request()
      .input('assessmentId', sql.Int, confirmation.assessment_id)
      .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
      .query(`SELECT selection_json FROM annual_assessments
        WHERE id = @assessmentId AND annual_enrollment_id = @annualEnrollmentId`);
    const savedAssessment = assessmentResult.recordset?.[0];
    if (!savedAssessment) throw new AnnualFinanceError('The saved assessment for this confirmation was not found.', 409);
    try {
      assessmentSelection = JSON.parse(savedAssessment.selection_json || '{}');
    } catch { throw new AnnualFinanceError('The saved assessment selection could not be verified.', 409); }
    const optionalLineIds = [...normalizeSelections(confirmationSelection.optionalLineIds || [])].sort((left, right) => left - right);
    const assessmentOptionalLineIds = [...normalizeSelections(assessmentSelection.optionalLineIds || [])].sort((left, right) => left - right);
    if (JSON.stringify(optionalLineIds) !== JSON.stringify(assessmentOptionalLineIds)) {
      throw new AnnualFinanceError('The saved assessment and confirmation selections do not match.', 409);
    }

    const restatement = await loadAnnualRestatement(pool.request(), sql, annualEnrollmentId, Number(confirmation.assessment_id));
    let archivedBeforeImage = null;
    if (restatement) {
      const archiveResult = await pool.request().input('operationId', sql.Char(36), restatement.operationId)
        .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('restatementAssessmentId', sql.Int, Number(confirmation.assessment_id))
        .query(`SELECT before_image_json, before_image_sha256
          FROM finance_assessment_restatement_annuals
          WHERE operation_id = @operationId AND annual_enrollment_id = @annualEnrollmentId
            AND assessment_id = @restatementAssessmentId`);
      const archive = archiveResult.recordset?.[0];
      if (!archive || crypto.createHash('sha256').update(String(archive.before_image_json)).digest('hex')
        !== String(archive.before_image_sha256).toLowerCase()) {
        throw new AnnualFinanceError('The original Registrar confirmation snapshot failed its finance archive check.', 409);
      }
      try { archivedBeforeImage = JSON.parse(String(archive.before_image_json)); }
      catch { throw new AnnualFinanceError('The original Registrar confirmation snapshot is unreadable.', 409); }
      if (Number(archivedBeforeImage.annual?.id) !== annualEnrollmentId
        || !Array.isArray(archivedBeforeImage.charges) || !Array.isArray(archivedBeforeImage.enrollments)
        || !Array.isArray(archivedBeforeImage.sourceScheduleLines) || !Array.isArray(archivedBeforeImage.exemptionApplications)) {
        throw new AnnualFinanceError('The original Registrar confirmation archive is incomplete.', 409);
      }
    }
    const chargesResult = archivedBeforeImage
      ? { recordset: buildArchivedConfirmationLines(archivedBeforeImage, Number(confirmation.assessment_id), confirmation.confirmed_at) }
      : await pool.request().input('assessmentId', sql.Int, confirmation.assessment_id)
      .query(`SELECT enrollment.annual_term_number AS term_number, charge.fee_category, charge.line_name,
          charge.installment, charge.schedule_line_id,
          COALESCE(schedule_line.is_optional, CAST(0 AS UNSIGNED)) AS is_optional,
          CAST(charge.amount AS CHAR(40)) AS original_gross_amount,
          CAST(COALESCE((SELECT SUM(application.amount) FROM finance_exemption_applications AS application
            WHERE application.charge_id = charge.id AND application.applied_at <= confirmation.confirmed_at), 0) AS CHAR(40)) AS confirmed_waived_amount
        FROM v_finance_effective_assessed_charges AS charge
        INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
        INNER JOIN annual_registrar_confirmations AS confirmation
          ON confirmation.assessment_id = charge.assessment_id
          AND confirmation.annual_enrollment_id = charge.annual_enrollment_id
        LEFT JOIN finance_schedule_lines AS schedule_line ON schedule_line.id = charge.schedule_line_id
        WHERE charge.assessment_id = @assessmentId AND charge.created_at <= confirmation.confirmed_at
        ORDER BY enrollment.annual_term_number, charge.id`);
    const lines = (chargesResult.recordset || []).map((line) => {
      const grossCents = parseMoneyCents(String(line.original_gross_amount), { allowZero: true });
      const waivedCents = parseMoneyCents(String(line.confirmed_waived_amount || '0.00'), { allowZero: true });
      if (waivedCents > grossCents) throw new AnnualFinanceError('The saved coverage exceeds its original charge amount.', 409);
      return {
        scheduleLineId: line.schedule_line_id == null ? null : Number(line.schedule_line_id),
        termNumber: Number(line.term_number), category: line.fee_category, lineName: line.line_name,
        installment: line.installment, grossAmount: formatMoneyCents(grossCents),
        waivedAmount: formatMoneyCents(waivedCents), amount: formatMoneyCents(grossCents - waivedCents),
        isOptional: flag(line.is_optional), alreadyPosted: true
      };
    });
    const snapshot = canonicalAssessmentSnapshot(lines);
    const payableCents = parseMoneyCents(String(confirmation.payable_total), { allowZero: true });
    const payableTotal = formatMoneyCents(payableCents);
    const compositeFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      assessmentId: Number(confirmation.assessment_id), scheduleId: Number(confirmation.schedule_id),
      scheduleVersion: Number(confirmation.schedule_version), voucherCode: confirmation.voucher_code_snapshot,
      payableTotal, optionalLineIds, postedComposition: snapshot.fingerprint
    })).digest('hex');
    if (snapshot.total !== payableTotal || compositeFingerprint !== String(confirmation.assessment_snapshot_fingerprint).toLowerCase()) {
      throw new AnnualFinanceError('The original confirmed fee details could not be verified from the saved fee history.', 409);
    }

    const entryTermNumber = Number(confirmation.entry_term_number || 1);
    const tuitionBreakdown = tuitionInstallmentBreakdown(lines, entryTermNumber);
    return {
      parent: {
        student_id: Number(confirmation.student_id), student_no: confirmation.student_no,
        first_name: confirmation.first_name, middle_name: confirmation.middle_name,
        last_name: confirmation.last_name, suffix: confirmation.suffix,
        school_year: confirmation.school_year, grade_level: confirmation.grade_level,
        voucher_code: confirmation.voucher_code_snapshot, entry_term_number: entryTermNumber
      },
      scheduleId: Number(confirmation.schedule_id), scheduleVersion: Number(confirmation.schedule_version),
      voucherCode: confirmation.voucher_code_snapshot, assessmentId: Number(confirmation.assessment_id),
      existingAssessment: true, optionalLineIds, lines, total: snapshot.total,
      totalCents: payableCents, optionalLines: [],
      termTotals: assessmentTermTotals(lines, entryTermNumber),
      tuitionTermTotals: tuitionTermTotals(lines, entryTermNumber),
      nonTuitionTermTotals: nonTuitionTermTotals(lines, entryTermNumber),
      tuitionBreakdown,
      tuitionBreakdownComplete: tuitionBreakdown.filter((term) => !term.installments[0].notApplicable).every((term) => term.complete),
      snapshotFingerprint: snapshot.fingerprint,
      ...(restatement ? { restatement } : {})
    };
  }

  async function confirmAnnualAssessment(actorInput, annualEnrollmentInput, optionalLineInputs = [], confirmation = {}) {
    return confirmAnnualAssessmentInternal(actorInput, annualEnrollmentInput, optionalLineInputs, confirmation, transaction, 'finance');
  }

  async function confirmAnnualAssessmentInTransaction(transaction, actorInput, annualEnrollmentInput, optionalLineInputs = [], confirmation = {}) {
    if (!transaction || typeof transaction.request !== 'function') throw new AnnualFinanceError('The registrar confirmation transaction is unavailable.', 500);
    return confirmAnnualAssessmentInternal(actorInput, annualEnrollmentInput, optionalLineInputs, confirmation, transaction, 'registrar');
  }

  async function confirmAnnualAssessmentInternal(actorInput, annualEnrollmentInput, optionalLineInputs, confirmation, sharedTransaction, actorRole) {
    const annualEnrollmentId = id(annualEnrollmentInput, 'annual enrollment');
    const selectedOptionalLines = normalizeSelections(optionalLineInputs);
    const idempotencyKey = uuid(confirmation.idempotencyKey, 'assessment confirmation');
    const expectedScheduleId = id(confirmation.scheduleId, 'previewed schedule');
    const expectedScheduleVersion = id(confirmation.scheduleVersion, 'previewed schedule version');
    const expectedVoucherCode = confirmation.voucherCode;
    const expectedSnapshotFingerprint = confirmation.snapshotFingerprint;
    if (actorRole !== 'finance') {
      throw new AnnualFinanceError('Registrar cannot post or review an annual assessment. Finance owns this action.', 403);
    }
    if (!['PUB', 'ESC', 'NV'].includes(expectedVoucherCode)) throw new AnnualFinanceError('The assessment preview context is invalid. Preview the annual assessment again.');
    if (actorRole === 'registrar' && (typeof expectedSnapshotFingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedSnapshotFingerprint))) {
      throw new AnnualFinanceError('The fee summary changed or expired. Review it again before confirming enrollment.', 409);
    }
    const fingerprint = requestFingerprint({ annualEnrollmentId, scheduleId: expectedScheduleId, scheduleVersion: expectedScheduleVersion,
      voucherCode: expectedVoucherCode, optionalLineIds: [...selectedOptionalLines].sort((a, b) => a - b),
      ...(actorRole === 'registrar' ? { snapshotFingerprint: expectedSnapshotFingerprint } : {}) });
    let ownerStudentId;
    if (sharedTransaction) {
      ownerStudentId = id(confirmation.studentId, 'student');
    } else {
      const pool = await getPool();
      const ownerResult = await pool.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query('SELECT student_id FROM annual_enrollments WHERE id = @annualEnrollmentId');
      const owner = ownerResult.recordset?.[0];
      if (!owner) throw new AnnualFinanceError('Annual enrollment not found.', 404);
      ownerStudentId = Number(owner.student_id);
    }
    const execute = async (transaction) => {
      const actor = actorRole === 'registrar'
        ? await requireRegistrarActor(transaction.request(), actorInput)
        : await requireFinanceActor(transaction.request(), actorInput);
      if (!sharedTransaction) await verifyStudent(transaction, ownerStudentId);
      const lockedOwnerResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query(`SELECT annual.student_id, annual.intake_status FROM annual_enrollments AS annual
          WHERE annual.id = @annualEnrollmentId AND annual.intake_status <> 'legacy' FOR UPDATE`);
      const lockedOwner = lockedOwnerResult.recordset?.[0];
      const lockedOwnerId = Number(lockedOwner?.student_id);
      if (!Number.isSafeInteger(lockedOwnerId) || lockedOwnerId < 1) throw new AnnualFinanceError('Annual enrollment not found.', 404);
      const pendingHandoff = lockedOwner.intake_status === 'pending';
      if (pendingHandoff && confirmation.financeAttestation !== true) {
        throw new AnnualFinanceError('A Finance reviewer must explicitly attest the pending annual assessment before it is saved.', 403);
      }
      if (lockedOwnerId !== ownerStudentId) throw new AnnualFinanceError('The student account does not match this annual enrollment.', 409);
      ownerStudentId = lockedOwnerId;
      const beforeDebt = (await debtRevisions.readSnapshot(transaction, ownerStudentId)).canonicalBalanceCents;
      const priorAssessment = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT id, annual_enrollment_id, request_fingerprint
          FROM annual_assessments  WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
      if (priorAssessment.recordset?.[0]) {
        const prior = priorAssessment.recordset[0];
        if (Number(prior.annual_enrollment_id) !== annualEnrollmentId || prior.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different assessment details.', 409);
        }
        const snapshot = await loadAssessmentSnapshot(transaction, Number(prior.id));
        if (actorRole === 'registrar' && snapshot.fingerprint !== expectedSnapshotFingerprint) {
          throw new AnnualFinanceError('The posted fee lines differ from the summary you reviewed. Reload the fee summary before confirming.', 409);
        }
        await recordAnnualFinanceReview(transaction, actor, annualEnrollmentId, confirmation);
        return { assessmentId: Number(prior.id), lineCount: snapshot.lines.length, total: snapshot.total,
          snapshotFingerprint: snapshot.fingerprint, alreadyPosted: true };
      }
      const parentResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query(`SELECT annual.id, annual.student_id, annual.school_year, annual.grade_level, annual.voucher_code, annual.entry_term_number, annual.intake_status,
            student.status AS student_status
          FROM annual_enrollments AS annual
          INNER JOIN students AS student  ON student.id = annual.student_id
          WHERE annual.id = @annualEnrollmentId AND annual.intake_status <> 'legacy' FOR UPDATE`);
      const parent = parentResult.recordset?.[0];
      if (!parent) throw new AnnualFinanceError('Annual enrollment not found.', 404);
      if (parent.student_status === 'archived') throw new AnnualFinanceError('Archived students cannot receive new assessments.', 409);
      const existing = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query(`SELECT id, schedule_id, schedule_version, voucher_code_snapshot, selection_json, assessed_at
          FROM annual_assessments  WHERE annual_enrollment_id = @annualEnrollmentId`);
      if (existing.recordset?.[0]) {
        const saved = existing.recordset[0];
        const voucherReview = await loadVoucherReviewState(transaction.request(), sql, {
          annualEnrollmentId, assessmentId: Number(saved.id), scheduleId: Number(saved.schedule_id),
          scheduleVersion: Number(saved.schedule_version), assessedVoucherCode: saved.voucher_code_snapshot,
          currentVoucherCode: parent.voucher_code, assessedAt: saved.assessed_at
        }, { lock: true });
        let savedSelection = {};
        try { savedSelection = JSON.parse(saved.selection_json || '{}'); } catch { throw new AnnualFinanceError('The saved assessment selection needs staff review.', 409); }
        const savedIds = normalizeSelections(savedSelection.optionalLineIds || []);
        const sameSelection = savedIds.size === selectedOptionalLines.size && [...savedIds].every((lineId) => selectedOptionalLines.has(lineId));
        const voucherResolvedForPending = parent.intake_status === 'pending' && voucherReview?.status === 'resolved';
        if (Number(saved.schedule_id) !== expectedScheduleId || Number(saved.schedule_version) !== expectedScheduleVersion
          || saved.voucher_code_snapshot !== expectedVoucherCode
          || (parent.voucher_code !== saved.voucher_code_snapshot && !voucherResolvedForPending)
          || (voucherReview && voucherReview.status !== 'resolved') || !sameSelection) {
          throw new AnnualFinanceError('The saved assessment or voucher differs from this review. Finance must resolve the change before enrollment can be confirmed.', 409);
        }
        const snapshot = await loadAssessmentSnapshot(transaction, Number(saved.id));
        if (actorRole === 'registrar' && snapshot.fingerprint !== expectedSnapshotFingerprint) {
          throw new AnnualFinanceError('The posted fee lines differ from the summary you reviewed. Reload the fee summary before confirming.', 409);
        }
        await recordAnnualFinanceReview(transaction, actor, annualEnrollmentId, confirmation);
        return { assessmentId: saved.id, scheduleVersion: saved.schedule_version,
          lineCount: snapshot.lines.length, total: snapshot.total, snapshotFingerprint: snapshot.fingerprint, alreadyPosted: true };
      }
      const scheduleResult = await transaction.request()
        .input('schoolYear', sql.NVarChar(20), parent.school_year)
        .input('gradeLevel', sql.NVarChar(50), parent.grade_level)
        .input('voucherCode', sql.NVarChar(10), parent.voucher_code)
        .query(`SELECT id, version_no FROM finance_schedules
          WHERE school_year = @schoolYear AND grade_level = @gradeLevel AND voucher_code = @voucherCode AND status = 'active'
          ORDER BY version_no DESC LIMIT 1 FOR UPDATE`);
      const schedule = scheduleResult.recordset?.[0];
      if (!schedule) throw new AnnualFinanceError('No active finance schedule matches this annual enrollment.', 409);
      if (Number(schedule.id) !== expectedScheduleId || Number(schedule.version_no) !== expectedScheduleVersion || parent.voucher_code !== expectedVoucherCode) {
        throw new AnnualFinanceError('The active schedule or voucher changed after preview. Preview the annual assessment again before posting.', 409);
      }
      const placementsResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query(`SELECT id AS enrollment_id, annual_term_number, enrollment_status, term_scope_status FROM enrollments
          WHERE annual_enrollment_id = @annualEnrollmentId ORDER BY annual_term_number`);
      const placements = placementsResult.recordset || [];
      if (placements.length !== 3 || placements.some((placement, index) => Number(placement.annual_term_number) !== index + 1)) {
        throw new AnnualFinanceError('All three term placements must exist before assessment.', 409);
      }
      const entryTermNumber = Number(parent.entry_term_number || 1);
      if (placements.some((placement) => Number(placement.annual_term_number) < entryTermNumber
        ? placement.term_scope_status !== 'not_applicable' || placement.enrollment_status !== 'not_applicable'
        : placement.term_scope_status !== 'applicable' || placement.enrollment_status !== 'pending_payment')) {
        throw new AnnualFinanceError('Assessment must include only pending applicable terms before activation.', 409);
      }
      const linesResult = await transaction.request().input('scheduleId', sql.Int, schedule.id)
        .query(`SELECT id, term_number, fee_category, line_name, installment, CAST(amount AS CHAR(40)) AS amount, is_optional
          FROM finance_schedule_lines  WHERE schedule_id = @scheduleId ORDER BY term_number, id`);
      const lines = linesResult.recordset || [];
      const applicableLines = lines.filter((line) => Number(line.term_number) >= entryTermNumber);
      for (const selectedId of selectedOptionalLines) {
        if (!applicableLines.some((line) => Number(line.id) === selectedId && flag(line.is_optional))) throw new AnnualFinanceError('A selected optional fee line is not part of the active schedule or entry-term scope.', 409);
      }
      const placementByTerm = new Map(placements.filter((placement) => Number(placement.annual_term_number) >= entryTermNumber)
        .map((placement) => [Number(placement.annual_term_number), placement]));
      const includedLines = applicableLines.filter((line) => !flag(line.is_optional) || selectedOptionalLines.has(Number(line.id)));
      const assessmentResult = await transaction.request()
        .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('scheduleId', sql.Int, schedule.id)
        .input('scheduleVersion', sql.Int, schedule.version_no)
        .input('voucherCode', sql.NVarChar(10), parent.voucher_code)
        .input('actorId', sql.Int, actor.id)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.NVarChar(64), fingerprint)
        .input('selectionJson', sql.NVarChar(sql.MAX), JSON.stringify({ optionalLineIds: [...selectedOptionalLines].sort((a, b) => a - b) }))
        .query(`INSERT INTO annual_assessments
            (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot, assessed_by, selection_json, idempotency_key, request_fingerprint)
          VALUES (@annualEnrollmentId, @scheduleId, @scheduleVersion, @voucherCode, @actorId, @selectionJson, @idempotencyKey, @requestFingerprint)`);
      const assessmentId = generatedId(assessmentResult, 'Assessment');
      for (const line of includedLines) {
        const enrollment = placementByTerm.get(Number(line.term_number));
        if (!enrollment) throw new AnnualFinanceError('The schedule references a missing annual term.', 409);
        const insertedCharge = await transaction.request()
          .input('assessmentId', sql.Int, assessmentId)
          .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
          .input('enrollmentId', sql.Int, enrollment.enrollment_id)
          .input('scheduleLineId', sql.Int, line.id)
          .input('category', sql.NVarChar(40), line.fee_category)
          .input('lineName', sql.NVarChar(120), line.line_name)
          .input('installment', sql.NVarChar(40), line.installment)
          .input('amount', sql.Decimal(12, 2), line.amount)
          .query(`INSERT INTO assessed_charges
              (assessment_id, annual_enrollment_id, enrollment_id, schedule_line_id, fee_category, line_name, installment, amount, gross_amount)
            VALUES (@assessmentId, @annualEnrollmentId, @enrollmentId, @scheduleLineId, @category, @lineName, @installment, @amount, @amount)`);
        await financeCases.applyApprovedExemptionsForCharge(transaction, actor, annualEnrollmentId, generatedId(insertedCharge, 'Assessed charge'));
      }
      await debtRevisions.recordIncreaseIfAny(transaction, ownerStudentId, beforeDebt);
      await writeAudit(transaction, actor, 'annual_assessment_posted', assessmentId, {
        annualEnrollmentId, scheduleId: schedule.id, scheduleVersion: schedule.version_no,
        voucherCodeSnapshot: parent.voucher_code, lineCount: includedLines.length
      });
      const snapshot = await loadAssessmentSnapshot(transaction, assessmentId);
      if (actorRole === 'registrar' && snapshot.fingerprint !== expectedSnapshotFingerprint) {
        throw new AnnualFinanceError('The posted fee lines changed while this summary was being saved. Review the fee summary again.', 409);
      }
      await recordAnnualFinanceReview(transaction, actor, annualEnrollmentId, confirmation);
      return { assessmentId, scheduleVersion: schedule.version_no, lineCount: includedLines.length,
        total: snapshot.total, snapshotFingerprint: snapshot.fingerprint };
    };
    return sharedTransaction ? execute(sharedTransaction) : runTransaction(execute);
  }

  async function insertAllocations(transaction, actor, { paymentId, studentId, allocations, batchKey, fingerprint }) {
    if (!allocations.length) return { allocatedCents: 0n };
    const paymentResult = await transaction.request().input('paymentId', sql.BigInt, paymentId)
      .query(`SELECT payment.id, payment.student_id, payment.is_reversed, CAST(payment.amount AS CHAR(40)) AS amount
        FROM finance_payments AS payment  WHERE payment.id = @paymentId`);
    const payment = paymentResult.recordset?.[0];
    if (!payment || Number(payment.student_id) !== studentId) throw new AnnualFinanceError('Choose a payment from this student account.', 409);
    if (flag(payment.is_reversed)) throw new AnnualFinanceError('A reversed payment cannot be allocated.', 409);
    const priorAllocation = await transaction.request().input('paymentId', sql.BigInt, paymentId)
      .query(`SELECT COALESCE(SUM(net_amount), 0) AS allocated FROM v_finance_net_payment_allocations
        WHERE payment_id = @paymentId`);
    const paymentAmount = parseMoneyCents(String(payment.amount));
    let availableCents = paymentAmount - parseMoneyCents(String(priorAllocation.recordset?.[0]?.allocated || '0.00'), { allowZero: true });
    const requested = allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0n);
    if (requested > availableCents) throw new AnnualFinanceError('Allocations cannot exceed this payment’s remaining unallocated credit.', 409);

    const batchResult = await transaction.request()
      .input('paymentId', sql.BigInt, paymentId)
      .input('studentId', sql.Int, studentId)
      .input('idempotencyKey', sql.UniqueIdentifier, batchKey)
      .input('requestFingerprint', sql.NVarChar(64), fingerprint)
      .input('actorId', sql.Int, actor.id)
      .query(`INSERT INTO finance_allocation_batches (payment_id, student_id, idempotency_key, request_fingerprint, allocated_by)
        VALUES (@paymentId, @studentId, @idempotencyKey, @requestFingerprint, @actorId)`);
    const batchId = generatedId(batchResult, 'Payment allocation batch');

    let allocatedCents = 0n;
    for (const allocation of allocations) {
      let targetId;
      let due;
      if (allocation.chargeId) {
        targetId = allocation.chargeId;
        const owner = await transaction.request().input('chargeId', sql.BigInt, targetId)
          .input('studentId', sql.Int, studentId)
          .query(`SELECT charge.id FROM assessed_charges AS charge
            INNER JOIN annual_enrollments AS annual  ON annual.id = charge.annual_enrollment_id
            INNER JOIN students AS student  ON student.id = annual.student_id
            WHERE charge.id = @chargeId AND annual.student_id = @studentId
              AND EXISTS (SELECT 1 FROM v_finance_effective_assessed_charges AS effective WHERE effective.id = charge.id)
            FOR UPDATE`);
        if (!owner.recordset?.length) throw new AnnualFinanceError('A charge must belong to the same student account as its payment.', 409);
        const dueResult = await transaction.request().input('chargeId', sql.BigInt, targetId)
          .query('SELECT amount_due FROM v_finance_assessed_charge_due WHERE charge_id = @chargeId');
        due = parseMoneyCents(String(dueResult.recordset?.[0]?.amount_due ?? '0.00'), { allowNegative: true, allowZero: true });
      } else {
        targetId = allocation.openingLiabilityId;
        const owner = await transaction.request().input('openingId', sql.BigInt, targetId)
          .input('studentId', sql.Int, studentId)
          .query(`SELECT opening.id FROM finance_legacy_opening_charges AS opening
            INNER JOIN financial_accounts AS account  ON account.id = opening.financial_account_id
            WHERE opening.id = @openingId AND opening.student_id = @studentId AND account.student_id = @studentId`);
        if (!owner.recordset?.length) throw new AnnualFinanceError('A legacy opening liability must belong to the same student account as its payment.', 409);
        const dueResult = await transaction.request().input('openingId', sql.BigInt, targetId)
          .query('SELECT amount_due FROM v_finance_opening_liability_due WHERE opening_charge_id = @openingId');
        due = parseMoneyCents(String(dueResult.recordset?.[0]?.amount_due ?? '0.00'), { allowNegative: true, allowZero: true });
      }
      if (due <= 0n || allocation.amountCents > due) throw new AnnualFinanceError('An allocation cannot exceed the charge’s remaining amount due.', 409);
      if (allocation.amountCents > availableCents) throw new AnnualFinanceError('Allocations cannot exceed this payment’s remaining unallocated credit.', 409);
      await transaction.request()
        .input('paymentId', sql.BigInt, paymentId)
        .input('chargeId', sql.BigInt, allocation.chargeId)
        .input('openingId', sql.BigInt, allocation.openingLiabilityId)
        .input('amount', sql.Decimal(12, 2), formatMoneyCents(allocation.amountCents))
        .input('batchId', sql.BigInt, batchId)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO finance_payment_allocations (payment_id, charge_id, legacy_opening_charge_id, amount, allocation_batch_id, allocated_by)
          VALUES (@paymentId, @chargeId, @openingId, @amount, @batchId, @actorId)`);
      availableCents -= allocation.amountCents;
      allocatedCents += allocation.amountCents;
    }
    return { allocatedCents, batchId };
  }

  async function recordPayment(actorInput, studentInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const amountCents = parseMoneyCents(String(input.amount || ''));
    const amount = formatMoneyCents(amountCents);
    const paymentDate = parsePaymentDate(input.paymentDate);
    const referenceNo = input.referenceNo == null || input.referenceNo === '' ? null : cleanText(input.referenceNo, 'Receipt/reference number', 100);
    const transmittalReference = input.transmittalReference == null || input.transmittalReference === '' ? null : cleanText(input.transmittalReference, 'Transmittal reference', 100);
    const privateRemarks = input.privateRemarks == null || input.privateRemarks === '' ? null : cleanText(input.privateRemarks, 'Private payment remarks', 1000);
    const receiptIssued = flag(input.receiptIssued);
    const idempotencyKey = uuid(input.idempotencyKey);
    const allocations = normalizeAllocations(input);
    const fingerprint = requestFingerprint({
      studentId, amount, paymentDate, referenceNo, transmittalReference, privateRemarks, receiptIssued, allocations: canonicalAllocations(allocations)
    });
    const allocatedCents = allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0n);
    if (allocatedCents > amountCents) throw new AnnualFinanceError('Allocations cannot exceed the payment amount.', 409);
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const existing = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT id, student_id, amount, payment_date, reference_no, transmittal_reference, private_remarks, receipt_issued, request_fingerprint
          FROM finance_payments  WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
      if (existing.recordset?.[0]) {
        const prior = existing.recordset[0];
        if (Number(prior.student_id) !== studentId || prior.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different payment details.', 409);
        }
        return { paymentId: generatedId(prior.id, 'Payment'), amount: formatMoneyCents(parseMoneyCents(String(prior.amount))), allocatedAmount: formatMoneyCents(allocatedCents), alreadyRecorded: true };
      }
      const inserted = await transaction.request()
        .input('studentId', sql.Int, studentId)
        .input('amount', sql.Decimal(12, 2), amount)
        .input('paymentDate', sql.Date, paymentDate)
        .input('referenceNo', sql.NVarChar(100), referenceNo)
        .input('transmittalReference', sql.NVarChar(100), transmittalReference)
        .input('privateRemarks', sql.NVarChar(1000), privateRemarks)
        .input('receiptIssued', sql.Bit, receiptIssued)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.NVarChar(64), fingerprint)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO finance_payments (student_id, amount, payment_date, reference_no, transmittal_reference, private_remarks, receipt_issued, idempotency_key, request_fingerprint, recorded_by)
          VALUES (@studentId, @amount, @paymentDate, @referenceNo, @transmittalReference, @privateRemarks, @receiptIssued, @idempotencyKey, @requestFingerprint, @actorId)`);
      const paymentId = generatedId(inserted, 'Payment');
      if (allocations.length) {
        const allocationResult = await insertAllocations(transaction, actor, {
          paymentId, studentId, allocations, batchKey: crypto.randomUUID(), fingerprint
        });
        if (allocationResult.allocatedCents !== allocatedCents) throw new Error('Payment allocation amount changed unexpectedly.');
      }
      if (privateRemarks) {
        const noteFingerprint = requestFingerprint({ studentId, paymentId, eventType: 'private_remark_added', privateRemark: privateRemarks });
        await transaction.request().input('paymentId', sql.BigInt, paymentId).input('privateRemark', sql.NVarChar(1000), privateRemarks)
          .input('idempotencyKey', sql.UniqueIdentifier, crypto.randomUUID()).input('fingerprint', sql.NVarChar(64), noteFingerprint).input('actorId', sql.Int, actor.id)
          .query(`INSERT INTO finance_payment_metadata_events
              (payment_id, event_type, private_remark, idempotency_key, request_fingerprint, recorded_by)
            VALUES (@paymentId, 'private_remark_added', @privateRemark, @idempotencyKey, @fingerprint, @actorId)`);
      }
      await writeAudit(transaction, actor, 'payment_recorded', paymentId, {
        studentId, amount, paymentDate, referenceNo, transmittalReference, receiptIssued, privateRemarkRecorded: Boolean(privateRemarks),
        allocatedAmount: formatMoneyCents(allocatedCents), allocationCount: allocations.length
      });
      return { paymentId, amount, allocatedAmount: formatMoneyCents(allocatedCents) };
    });
  }

  async function updatePaymentMetadata(actorInput, studentInput, paymentInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const paymentId = bigId(paymentInput, 'payment');
    const eventType = input.eventType;
    if (!['receipt_reference_updated', 'receipt_marked_issued', 'private_remark_added'].includes(eventType)) {
      throw new AnnualFinanceError('Choose a supported receipt or private payment metadata update.');
    }
    const referenceNo = eventType === 'receipt_reference_updated'
      ? cleanText(input.referenceNo, 'Receipt/reference number', 100, true) : null;
    const privateRemark = eventType === 'private_remark_added'
      ? cleanText(input.privateRemark, 'Private payment remark', 1000, true) : null;
    const idempotencyKey = uuid(input.idempotencyKey, 'payment metadata update');
    const fingerprint = requestFingerprint({ studentId, paymentId, eventType, referenceNo, privateRemark });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT id, payment_id, event_type, request_fingerprint FROM finance_payment_metadata_events
          WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
      if (prior.recordset?.[0]) {
        const row = prior.recordset[0];
        if (Number(row.payment_id) !== paymentId || row.event_type !== eventType || row.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different payment metadata.', 409);
        }
        return { metadataEventId: generatedId(row.id, 'Payment metadata event'), alreadyRecorded: true };
      }
      const paymentResult = await transaction.request().input('paymentId', sql.BigInt, paymentId)
        .input('studentId', sql.Int, studentId)
        .query(`SELECT id, receipt_issued, private_remarks FROM finance_payments
          WHERE id = @paymentId AND student_id = @studentId`);
      const payment = paymentResult.recordset?.[0];
      if (!payment) throw new AnnualFinanceError('Payment not found for this student.', 404);
      if (eventType === 'receipt_marked_issued' && flag(payment.receipt_issued)) throw new AnnualFinanceError('A receipt is already marked as issued.', 409);
      if (eventType === 'private_remark_added'
        && String(payment.private_remarks || '').length + (payment.private_remarks ? 1 : 0) + privateRemark.length > 1000) {
        throw new AnnualFinanceError('Payment remarks are limited to 1,000 characters in total. The existing note history is preserved.', 409);
      }
      const inserted = await transaction.request().input('paymentId', sql.BigInt, paymentId)
        .input('eventType', sql.NVarChar(30), eventType).input('referenceNo', sql.NVarChar(100), referenceNo)
        .input('privateRemark', sql.NVarChar(1000), privateRemark).input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('fingerprint', sql.NVarChar(64), fingerprint).input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO finance_payment_metadata_events
            (payment_id, event_type, reference_no, private_remark, idempotency_key, request_fingerprint, recorded_by)
          VALUES (@paymentId, @eventType, @referenceNo, @privateRemark, @idempotencyKey, @fingerprint, @actorId)`);
      const metadataEventId = generatedId(inserted, 'Payment metadata event');
      if (eventType === 'receipt_reference_updated') {
        await transaction.request().input('paymentId', sql.BigInt, paymentId).input('referenceNo', sql.NVarChar(100), referenceNo)
          .query('UPDATE finance_payments SET reference_no = @referenceNo WHERE id = @paymentId');
      } else if (eventType === 'receipt_marked_issued') {
        await transaction.request().input('paymentId', sql.BigInt, paymentId)
          .query('UPDATE finance_payments SET receipt_issued = 1 WHERE id = @paymentId AND receipt_issued = 0');
      } else {
        await transaction.request().input('paymentId', sql.BigInt, paymentId).input('privateRemark', sql.NVarChar(1000), privateRemark)
          .query('UPDATE finance_payments SET private_remarks = CONCAT(NULLIF(private_remarks, N\'\'), CASE WHEN NULLIF(private_remarks, N\'\') IS NULL THEN N\'\' ELSE N\'\n\' END, @privateRemark) WHERE id = @paymentId');
      }
      await writeAudit(transaction, actor, 'payment_metadata_updated', metadataEventId, {
        studentId, paymentId, eventType, referenceNo, privateRemarkRecorded: Boolean(privateRemark)
      });
      return { metadataEventId };
    });
  }

  async function previewLegacyOpeningLiability(actorInput, studentInput) {
    const studentId = id(studentInput, 'student');
    const pool = await getPool();
    await requireFinanceActor(pool.request(), actorInput);
    const studentResult = await pool.request().input('studentId', sql.Int, studentId)
      .query('SELECT id, status FROM students WHERE id = @studentId');
    const student = studentResult.recordset?.[0];
    if (!student) throw new AnnualFinanceError('Student record not found.', 404);
    if (student.status === 'archived') throw new AnnualFinanceError('Archived student finance history is read-only.', 409);
    const [balanceResult, openingResult, releaseResult] = await Promise.all([
      pool.request().input('studentId', sql.Int, studentId).query(`SELECT account.id AS financial_account_id,
          CAST(projection.remaining_legacy_balance AS CHAR(40)) AS remaining_balance
        FROM financial_accounts AS account
        INNER JOIN v_finance_legacy_account_balance AS projection ON projection.financial_account_id = account.id
        WHERE account.student_id = @studentId`),
      pool.request().input('studentId', sql.Int, studentId).query('SELECT id FROM finance_legacy_opening_charges WHERE student_id = @studentId'),
      pool.request().input('studentId', sql.Int, studentId).query(`SELECT COUNT(*) AS active_count
        FROM v_finance_net_legacy_reconciliations AS reconciliation
        INNER JOIN financial_transactions AS legacy ON legacy.id = reconciliation.transaction_id
        INNER JOIN financial_accounts AS account ON account.id = legacy.financial_account_id
        WHERE account.student_id = @studentId AND reconciliation.net_amount > 0`)
    ]);
    const row = balanceResult.recordset?.[0];
    if (!row) throw new AnnualFinanceError('This student has no legacy finance account to reconcile.', 404);
    return {
      financialAccountId: Number(row.financial_account_id),
      remainingBalance: String(row.remaining_balance),
      alreadyTransferred: Boolean(openingResult.recordset?.length),
      activeReconciliationCount: Number(releaseResult.recordset?.[0]?.active_count || 0)
    };
  }

  async function transferLegacyOpeningLiability(actorInput, studentInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const expectedAmountCents = parseMoneyCents(String(input.expectedAmount || ''), { allowZero: false });
    const expectedAmount = formatMoneyCents(expectedAmountCents);
    const sourceLabel = cleanText(input.sourceLabel, 'Legacy balance source', 120, true);
    const reason = cleanText(input.reason, 'Opening liability review reason', 1000, true);
    const idempotencyKey = uuid(input.idempotencyKey, 'legacy opening liability transfer');
    const fingerprint = requestFingerprint({ studentId, expectedAmount, sourceLabel, reason });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query('SELECT id, student_id, financial_account_id, request_fingerprint FROM finance_legacy_opening_charges  WHERE idempotency_key = @idempotencyKey FOR UPDATE');
      if (prior.recordset?.[0]) {
        const row = prior.recordset[0];
        if (Number(row.student_id) !== studentId || row.request_fingerprint !== fingerprint) throw new AnnualFinanceError('This submission token was already used for different opening-liability details.', 409);
        return { openingLiabilityId: generatedId(row.id, 'Legacy opening liability'), alreadyTransferred: true };
      }
      const accountResult = await transaction.request().input('studentId', sql.Int, studentId)
        .query(`SELECT account.id, CAST(projection.remaining_legacy_balance AS CHAR(40)) AS remaining_balance
          FROM financial_accounts AS account
          INNER JOIN v_finance_legacy_account_balance AS projection ON projection.financial_account_id = account.id
          WHERE account.student_id = @studentId`);
      const account = accountResult.recordset?.[0];
      if (!account) throw new AnnualFinanceError('This student has no legacy finance account to reconcile.', 404);
      const existing = await transaction.request().input('accountId', sql.Int, account.id)
        .query('SELECT id FROM finance_legacy_opening_charges  WHERE financial_account_id = @accountId');
      if (existing.recordset?.length) throw new AnnualFinanceError('The legacy account already has an opening-liability transfer.', 409);
      const activeReconciliations = await transaction.request().input('accountId', sql.Int, account.id)
        .query(`SELECT reconciliation.reconciliation_id
          FROM v_finance_net_legacy_reconciliations AS reconciliation
          INNER JOIN financial_transactions AS legacy  ON legacy.id = reconciliation.transaction_id
          WHERE legacy.financial_account_id = @accountId AND reconciliation.net_amount > 0 LIMIT 1`);
      if (activeReconciliations.recordset?.length) throw new AnnualFinanceError('Release all active legacy-payment reconciliations to their source account before transferring the remaining liability.', 409);
      const actualCents = parseMoneyCents(String(account.remaining_balance || '0.00'), { allowNegative: true, allowZero: true });
      if (actualCents <= 0n) throw new AnnualFinanceError('Only a positive remaining legacy balance can be transferred to an opening liability.', 409);
      if (actualCents !== expectedAmountCents) throw new AnnualFinanceError('The legacy balance changed after preview. Reload the review before confirming.', 409);
      const inserted = await transaction.request().input('accountId', sql.Int, account.id).input('studentId', sql.Int, studentId)
        .input('amount', sql.Decimal(12, 2), expectedAmount).input('sourceLabel', sql.NVarChar(120), sourceLabel)
        .input('reason', sql.NVarChar(1000), reason).input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('fingerprint', sql.NVarChar(64), fingerprint).input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO finance_legacy_opening_charges
            (financial_account_id, student_id, amount, source_label, reason, idempotency_key, request_fingerprint, recorded_by)
          VALUES (@accountId, @studentId, @amount, @sourceLabel, @reason, @idempotencyKey, @fingerprint, @actorId)`);
      const openingLiabilityId = generatedId(inserted, 'Legacy opening liability');
      await writeAudit(transaction, actor, 'legacy_opening_liability_transferred', openingLiabilityId, {
        studentId, financialAccountId: Number(account.id), amount: expectedAmount, sourceLabel, reason
      });
      return { openingLiabilityId, amount: expectedAmount };
    });
  }

  async function allocateExistingCredit(actorInput, studentInput, paymentInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const paymentId = bigId(paymentInput, 'payment');
    const allocations = normalizeAllocations(input);
    if (!allocations.length) throw new AnnualFinanceError('Add at least one charge allocation.');
    const batchKey = uuid(input.idempotencyKey, 'allocation submission');
    const fingerprint = requestFingerprint({ studentId, paymentId, allocations: canonicalAllocations(allocations) });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, batchKey)
        .query(`SELECT id, payment_id, student_id, request_fingerprint FROM finance_allocation_batches
          WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
      if (prior.recordset?.[0]) {
        const existing = prior.recordset[0];
        if (Number(existing.payment_id) !== paymentId || Number(existing.student_id) !== studentId || existing.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different allocation details.', 409);
        }
        return { allocationBatchId: generatedId(existing.id, 'Payment allocation batch'), amount: formatMoneyCents(allocations.reduce((sum, row) => sum + row.amountCents, 0n)), alreadyAllocated: true };
      }
      const result = await insertAllocations(transaction, actor, { paymentId, studentId, allocations, batchKey, fingerprint });
      await writeAudit(transaction, actor, 'credit_allocated', result.batchId, {
        studentId, paymentId, amount: formatMoneyCents(result.allocatedCents), allocationCount: allocations.length
      });
      return { allocationBatchId: result.batchId, amount: formatMoneyCents(result.allocatedCents) };
    });
  }

  async function releasePaymentAllocation(actorInput, studentInput, allocationInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const allocationId = bigId(allocationInput, 'payment allocation');
    const amountCents = parseMoneyCents(String(input.amount || ''), { allowZero: false });
    const reason = cleanText(input.reason, 'Allocation release reason', 1000, true);
    const idempotencyKey = uuid(input.idempotencyKey, 'allocation release');
    const fingerprint = requestFingerprint({ studentId, allocationId, amount: formatMoneyCents(amountCents), reason });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const debtBefore = (await debtRevisions.readSnapshot(transaction, studentId)).canonicalBalanceCents;
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT allocation_release.id, allocation_release.allocation_id, allocation_release.request_fingerprint, payment.student_id
          FROM finance_payment_allocation_releases AS allocation_release
          INNER JOIN finance_payment_allocations AS allocation ON allocation.id = allocation_release.allocation_id
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
          WHERE allocation_release.idempotency_key = @idempotencyKey FOR UPDATE`);
      if (prior.recordset?.[0]) {
        const row = prior.recordset[0];
        if (Number(row.student_id) !== studentId || Number(row.allocation_id) !== allocationId || row.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different allocation release details.', 409);
        }
        return { releaseId: generatedId(row.id, 'Allocation release'), alreadyReleased: true };
      }
      const sourceResult = await transaction.request().input('allocationId', sql.BigInt, allocationId)
        .input('studentId', sql.Int, studentId)
        .query(`SELECT allocation.id, allocation.charge_id, allocation.legacy_opening_charge_id,
            CAST(allocation.amount AS CHAR(40)) AS amount, payment.id AS payment_id, payment.is_reversed
          FROM finance_payment_allocations AS allocation
          INNER JOIN finance_payments AS payment  ON payment.id = allocation.payment_id
          WHERE allocation.id = @allocationId AND payment.student_id = @studentId
            AND (allocation.charge_id IS NULL OR EXISTS (SELECT 1 FROM v_finance_effective_assessed_charges AS charge
              WHERE charge.id = allocation.charge_id))
          FOR UPDATE`);
      const source = sourceResult.recordset?.[0];
      if (!source) throw new AnnualFinanceError('Payment allocation not found for this student.', 404);
      if (flag(source.is_reversed)) throw new AnnualFinanceError('Allocations from a reversed payment cannot be released as available credit.', 409);
      const releasedResult = await transaction.request().input('allocationId', sql.BigInt, allocationId)
        .query(`SELECT COALESCE(MAX(active_released_amount), 0) AS amount
          FROM v_finance_net_payment_allocations WHERE allocation_id = @allocationId`);
      const originCents = parseMoneyCents(String(source.amount));
      const releasedCents = parseMoneyCents(String(releasedResult.recordset?.[0]?.amount || '0.00'), { allowZero: true });
      if (amountCents > originCents - releasedCents) throw new AnnualFinanceError('Cumulative releases cannot exceed the original allocation.', 409);
      const inserted = await transaction.request().input('allocationId', sql.BigInt, allocationId)
        .input('amount', sql.Decimal(12, 2), formatMoneyCents(amountCents)).input('reason', sql.NVarChar(1000), reason)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey).input('fingerprint', sql.NVarChar(64), fingerprint)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO finance_payment_allocation_releases
            (allocation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
          VALUES (@allocationId, @amount, @reason, @idempotencyKey, @fingerprint, @actorId)`);
      const releaseId = generatedId(inserted, 'Allocation release');
      if (source.charge_id) {
        const charge = await transaction.request().input('chargeId', sql.BigInt, source.charge_id)
        .query('SELECT enrollment_id FROM v_finance_effective_assessed_charges WHERE id = @chargeId');
        if (charge.recordset?.[0]) await requireFreshApproval(transaction, actor, Number(charge.recordset[0].enrollment_id), 'payment_allocation_released');
      }
      await writeAudit(transaction, actor, 'payment_allocation_released', releaseId, {
        studentId, allocationId, amount: formatMoneyCents(amountCents), reason
      });
      await debtRevisions.recordIncreaseIfAny(transaction, studentId, debtBefore);
      return { releaseId };
    });
  }

  async function releaseLegacyReconciliation(actorInput, studentInput, reconciliationInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const reconciliationId = bigId(reconciliationInput, 'legacy reconciliation');
    const amountCents = parseMoneyCents(String(input.amount || ''), { allowZero: false });
    const reason = cleanText(input.reason, 'Legacy reconciliation release reason', 1000, true);
    const idempotencyKey = uuid(input.idempotencyKey, 'legacy reconciliation release');
    const fingerprint = requestFingerprint({ studentId, reconciliationId, amount: formatMoneyCents(amountCents), reason });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const debtBefore = (await debtRevisions.readSnapshot(transaction, studentId)).canonicalBalanceCents;
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT reconciliation_release.id, reconciliation_release.reconciliation_id, reconciliation_release.request_fingerprint, account.student_id
          FROM finance_legacy_reconciliation_releases AS reconciliation_release
          INNER JOIN finance_legacy_reconciliations AS reconciliation ON reconciliation.id = reconciliation_release.reconciliation_id
          INNER JOIN financial_transactions AS legacy ON legacy.id = reconciliation.transaction_id
          INNER JOIN financial_accounts AS account ON account.id = legacy.financial_account_id
          WHERE reconciliation_release.idempotency_key = @idempotencyKey FOR UPDATE`);
      if (prior.recordset?.[0]) {
        const row = prior.recordset[0];
        if (Number(row.student_id) !== studentId || Number(row.reconciliation_id) !== reconciliationId || row.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different reconciliation release details.', 409);
        }
        return { releaseId: generatedId(row.id, 'Legacy reconciliation release'), alreadyReleased: true };
      }
      // Serialize source-credit changes with opening-liability transfer, which
      // takes the same account-row lock before checking active reconciliations.
      const account = await transaction.request().input('studentId', sql.Int, studentId)
        .query('SELECT id FROM financial_accounts  WHERE student_id = @studentId');
      if (!account.recordset?.[0]) throw new AnnualFinanceError('This student has no legacy finance account to reconcile.', 404);
      const opening = await transaction.request().input('accountId', sql.Int, account.recordset[0].id)
        .query('SELECT id FROM finance_legacy_opening_charges  WHERE financial_account_id = @accountId');
      if (opening.recordset?.length) throw new AnnualFinanceError('Legacy reconciliations cannot be released after the account has been transferred to an opening liability.', 409);
      const sourceResult = await transaction.request().input('reconciliationId', sql.BigInt, reconciliationId)
        .input('studentId', sql.Int, studentId)
        .query(`SELECT reconciliation.id, reconciliation.charge_id, CAST(reconciliation.amount AS CHAR(40)) AS amount,
            annual.student_id, charge.enrollment_id
          FROM finance_legacy_reconciliations AS reconciliation
          INNER JOIN v_finance_effective_assessed_charges AS charge ON charge.id = reconciliation.charge_id
          INNER JOIN annual_enrollments AS annual  ON annual.id = charge.annual_enrollment_id
          WHERE reconciliation.id = @reconciliationId AND annual.student_id = @studentId`);
      const source = sourceResult.recordset?.[0];
      if (!source) throw new AnnualFinanceError('Legacy reconciliation not found for this student.', 404);
      const releasedResult = await transaction.request().input('reconciliationId', sql.BigInt, reconciliationId)
        .query('SELECT COALESCE(SUM(amount), 0) AS amount FROM finance_legacy_reconciliation_releases  WHERE reconciliation_id = @reconciliationId');
      const originCents = parseMoneyCents(String(source.amount));
      const releasedCents = parseMoneyCents(String(releasedResult.recordset?.[0]?.amount || '0.00'), { allowZero: true });
      if (amountCents > originCents - releasedCents) throw new AnnualFinanceError('Cumulative releases cannot exceed the original legacy reconciliation.', 409);
      const inserted = await transaction.request().input('reconciliationId', sql.BigInt, reconciliationId)
        .input('amount', sql.Decimal(12, 2), formatMoneyCents(amountCents)).input('reason', sql.NVarChar(1000), reason)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey).input('fingerprint', sql.NVarChar(64), fingerprint)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO finance_legacy_reconciliation_releases
            (reconciliation_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
          VALUES (@reconciliationId, @amount, @reason, @idempotencyKey, @fingerprint, @actorId)`);
      const releaseId = generatedId(inserted, 'Legacy reconciliation release');
      await requireFreshApproval(transaction, actor, Number(source.enrollment_id), 'legacy_reconciliation_released');
      await writeAudit(transaction, actor, 'legacy_reconciliation_released', releaseId, {
        studentId, reconciliationId, amount: formatMoneyCents(amountCents), reason
      });
      await debtRevisions.recordIncreaseIfAny(transaction, studentId, debtBefore);
      return { releaseId };
    });
  }

  async function updateFinanceHandbookNumber(actorInput, annualEnrollmentInput, input = {}) {
    const annualEnrollmentId = id(annualEnrollmentInput, 'annual enrollment');
    const expectedStudentId = input.expectedStudentId == null ? null : id(input.expectedStudentId, 'student');
    const handbookNumber = cleanText(input.financeHandbookNumber ?? '', 'Finance handbook number', 80);
    const idempotencyKey = uuid(input.idempotencyKey, 'finance handbook number update');
    const fingerprint = requestFingerprint({ annualEnrollmentId, handbookNumber });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      const priorResult = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query('SELECT request_fingerprint FROM finance_handbook_number_events  WHERE idempotency_key = @idempotencyKey FOR UPDATE');
      if (priorResult.recordset?.[0]) {
        if (priorResult.recordset[0].request_fingerprint !== fingerprint) throw new AnnualFinanceError('This submission token was already used for different handbook details.', 409);
        return { annualEnrollmentId, alreadyRecorded: true };
      }
      const annualRequest = transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('expectedStudentId', sql.Int, expectedStudentId);
      const annualResult = await annualRequest
        .query(`SELECT annual.id, annual.intake_status, annual.finance_handbook_number
          FROM annual_enrollments AS annual
          WHERE annual.id = @annualEnrollmentId AND (@expectedStudentId IS NULL OR annual.student_id = @expectedStudentId)`);
      const annual = annualResult.recordset?.[0];
      if (!annual || annual.intake_status === 'legacy') throw new AnnualFinanceError('A current annual enrollment is required.', 404);
      const before = annual.finance_handbook_number || null;
      if (before !== handbookNumber) {
        await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
          .input('handbookNumber', sql.NVarChar(80), handbookNumber)
          .query('UPDATE annual_enrollments SET finance_handbook_number = @handbookNumber WHERE id = @annualEnrollmentId');
      }
      await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId).input('actorId', sql.Int, actor.id)
        .input('beforeValue', sql.NVarChar(80), before).input('afterValue', sql.NVarChar(80), handbookNumber)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey).input('fingerprint', sql.NVarChar(64), fingerprint)
        .query(`INSERT INTO finance_handbook_number_events
          (annual_enrollment_id, actor_id, before_value, after_value, idempotency_key, request_fingerprint)
          VALUES (@annualEnrollmentId, @actorId, @beforeValue, @afterValue, @idempotencyKey, @fingerprint)`);
      await writeAudit(transaction, actor, 'finance_handbook_number_updated', annualEnrollmentId, { changed: before !== handbookNumber });
      return { annualEnrollmentId, changed: before !== handbookNumber };
    });
  }

  async function addFeeComment(actorInput, studentInput, chargeInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const chargeId = bigId(chargeInput, 'charge');
    const comment = cleanText(input.comment, 'Fee comment', 1000, true);
    const idempotencyKey = uuid(input.idempotencyKey, 'fee comment');
    const fingerprint = requestFingerprint({ studentId, chargeId, comment });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      const priorResult = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query('SELECT id, request_fingerprint FROM finance_fee_comment_events  WHERE idempotency_key = @idempotencyKey FOR UPDATE');
      if (priorResult.recordset?.[0]) {
        const prior = priorResult.recordset[0];
        if (prior.request_fingerprint !== fingerprint) throw new AnnualFinanceError('This submission token was already used for a different fee comment.', 409);
        return { commentEventId: generatedId(prior.id, 'Fee comment'), alreadyRecorded: true };
      }
      const chargeResult = await transaction.request().input('studentId', sql.Int, studentId).input('chargeId', sql.BigInt, chargeId)
        .query(`SELECT charge.id FROM v_finance_effective_assessed_charges AS charge
          INNER JOIN annual_enrollments AS annual  ON annual.id = charge.annual_enrollment_id
          WHERE charge.id = @chargeId AND annual.student_id = @studentId`);
      if (!chargeResult.recordset?.length) throw new AnnualFinanceError('Choose a fee from this student account.', 404);
      const inserted = await transaction.request().input('chargeId', sql.BigInt, chargeId).input('actorId', sql.Int, actor.id)
        .input('comment', sql.NVarChar(1000), comment).input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('fingerprint', sql.NVarChar(64), fingerprint)
        .query(`INSERT INTO finance_fee_comment_events (charge_id, actor_id, comment, idempotency_key, request_fingerprint)
          VALUES (@chargeId, @actorId, @comment, @idempotencyKey, @fingerprint)`);
      const commentEventId = generatedId(inserted, 'Fee comment');
      await writeAudit(transaction, actor, 'finance_fee_comment_added', commentEventId, { studentId, chargeId });
      return { commentEventId };
    });
  }

  async function recordChargeAdjustment(actorInput, studentInput, chargeInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const chargeId = bigId(chargeInput, 'charge');
    const amountCents = parseMoneyCents(String(input.amount || ''), { allowNegative: true });
    const reason = cleanText(input.reason, 'Adjustment reason', 1000, true);
    const idempotencyKey = uuid(input.idempotencyKey, 'adjustment submission');
    const fingerprint = requestFingerprint({ studentId, chargeId, amount: formatMoneyCents(amountCents), reason });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const debtBefore = (await debtRevisions.readSnapshot(transaction, studentId)).canonicalBalanceCents;
      const duplicate = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT adjustment.id, adjustment.charge_id, adjustment.request_fingerprint, annual.student_id
          FROM finance_charge_adjustments AS adjustment
          INNER JOIN assessed_charges AS charge  ON charge.id = adjustment.charge_id
          INNER JOIN annual_enrollments AS annual  ON annual.id = charge.annual_enrollment_id
          WHERE adjustment.idempotency_key = @idempotencyKey FOR UPDATE`);
      if (duplicate.recordset?.[0]) {
        const prior = duplicate.recordset[0];
        if (Number(prior.student_id) !== studentId || Number(prior.charge_id) !== chargeId || prior.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different adjustment details.', 409);
        }
        return { adjustmentId: generatedId(prior.id, 'Charge adjustment'), alreadyRecorded: true };
      }
      const owner = await transaction.request().input('chargeId', sql.BigInt, chargeId)
        .query(`SELECT annual.student_id FROM v_finance_effective_assessed_charges AS charge
          INNER JOIN annual_enrollments AS annual  ON annual.id = charge.annual_enrollment_id
          WHERE charge.id = @chargeId`);
      if (!owner.recordset?.[0] || Number(owner.recordset[0].student_id) !== studentId) throw new AnnualFinanceError('This charge does not belong to the selected student.', 409);
      const chargeResult = await transaction.request().input('chargeId', sql.BigInt, chargeId)
        .query(`SELECT charge.id FROM assessed_charges AS charge WHERE charge.id = @chargeId
          AND EXISTS (SELECT 1 FROM v_finance_effective_assessed_charges AS effective WHERE effective.id = charge.id)
          FOR UPDATE`);
      if (!chargeResult.recordset?.length) throw new AnnualFinanceError('This assessed fee is no longer available.', 409);
      const basisResult = await transaction.request().input('chargeId', sql.BigInt, chargeId)
        .query(`SELECT CAST(charge.amount + COALESCE((SELECT SUM(adjustment.amount)
              FROM finance_charge_adjustments AS adjustment WHERE adjustment.charge_id = charge.id), 0) AS CHAR(40)) AS fee_basis,
            CAST(due.amount_due AS CHAR(40)) AS amount_due
          FROM v_finance_effective_assessed_charges AS charge
          INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
          WHERE charge.id = @chargeId`);
      const beforeBasisCents = parseMoneyCents(String(basisResult.recordset?.[0]?.fee_basis ?? '0.00'), { allowNegative: true, allowZero: true });
      const afterBasisCents = beforeBasisCents + amountCents;
      if (afterBasisCents < 0n) throw new AnnualFinanceError('The adjustment would reduce this fee below zero. Reverse an earlier reduction if it needs correction.', 409);
      const inserted = await transaction.request()
        .input('chargeId', sql.BigInt, chargeId)
        .input('amount', sql.Decimal(12, 2), formatMoneyCents(amountCents))
        .input('reason', sql.NVarChar(1000), reason)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.NVarChar(64), fingerprint)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO finance_charge_adjustments (charge_id, amount, reason, idempotency_key, request_fingerprint, recorded_by)
          VALUES (@chargeId, @amount, @reason, @idempotencyKey, @requestFingerprint, @actorId)`);
      const adjustmentId = generatedId(inserted, 'Charge adjustment');
      if (amountCents > 0n) {
        const termResult = await transaction.request().input('chargeId', sql.BigInt, chargeId)
          .query('SELECT enrollment_id FROM v_finance_effective_assessed_charges WHERE id = @chargeId');
        if (termResult.recordset?.[0]) await requireFreshApproval(transaction, actor, Number(termResult.recordset[0].enrollment_id), 'positive_charge_adjustment');
      }
      let releasePlan = { totalCents: 0n, annualCents: 0n, legacyCents: 0n };
      if (afterBasisCents >= 0n) {
        const dueAfterCents = parseMoneyCents(String(basisResult.recordset[0].amount_due), { allowNegative: true, allowZero: true }) + amountCents;
        if (dueAfterCents < 0n) {
          releasePlan = await financeCases.releaseOverpayment(transaction, actor, chargeId,
            `Adjustment #${adjustmentId} reduced the fee below its applied amount. Excess applications were released as account credit.`);
        }
      }
      await writeAudit(transaction, actor, 'charge_adjustment_recorded', adjustmentId, {
        studentId, chargeId, amount: formatMoneyCents(amountCents), reason,
        releasedAnnualAllocations: formatMoneyCents(releasePlan.annualCents),
        releasedLegacyReconciliations: formatMoneyCents(releasePlan.legacyCents)
      });
      await debtRevisions.recordIncreaseIfAny(transaction, studentId, debtBefore);
      return { adjustmentId };
    });
  }

  async function addSupplementaryCharge(actorInput, studentInput, enrollmentInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const enrollmentId = id(enrollmentInput, 'term enrollment');
    const category = cleanText(input.feeCategory, 'Fee category', 40, true);
    if (!FEE_CATEGORIES.has(category)) throw new AnnualFinanceError('Choose a supported fee category.');
    const lineName = cleanText(input.lineName, 'Supplementary charge name', 120, true);
    const installment = cleanText(input.installment || 'As incurred', 'Installment', 40, true);
    const amountCents = parseMoneyCents(String(input.amount || ''), { allowZero: false });
    const reason = cleanTextArea(input.reason, 'Supplementary charge reason', 1000, true);
    const idempotencyKey = uuid(input.idempotencyKey, 'supplementary charge');
    const fingerprint = requestFingerprint({ studentId, enrollmentId, category, lineName, installment, amount: formatMoneyCents(amountCents), reason });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const debtBefore = (await debtRevisions.readSnapshot(transaction, studentId)).canonicalBalanceCents;
      const existing = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT charge.id, charge.enrollment_id, charge.request_fingerprint, annual.student_id
          FROM assessed_charges AS charge
          INNER JOIN annual_enrollments AS annual  ON annual.id = charge.annual_enrollment_id
          WHERE charge.idempotency_key = @idempotencyKey FOR UPDATE`);
      if (existing.recordset?.[0]) {
        const prior = existing.recordset[0];
        if (Number(prior.student_id) !== studentId || Number(prior.enrollment_id) !== enrollmentId || prior.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different supplementary charge details.', 409);
        }
        return { chargeId: generatedId(prior.id, 'Supplementary charge'), alreadyRecorded: true };
      }
      const termResult = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
        .query(`SELECT enrollment.id, enrollment.annual_enrollment_id, enrollment.enrollment_status,
            assessment.id AS assessment_id, annual.student_id
          FROM enrollments AS enrollment
          INNER JOIN annual_enrollments AS annual  ON annual.id = enrollment.annual_enrollment_id
          LEFT JOIN annual_assessments AS assessment  ON assessment.annual_enrollment_id = annual.id
          WHERE enrollment.id = @enrollmentId AND annual.intake_status <> 'legacy' FOR UPDATE`);
      const term = termResult.recordset?.[0];
      if (!term || Number(term.student_id) !== studentId) throw new AnnualFinanceError('Choose a term placement from this student account.', 409);
      if (!term.assessment_id) throw new AnnualFinanceError('Post the annual assessment before adding a supplementary charge.', 409);
      if (!['pending_payment', 'enrolled'].includes(term.enrollment_status)) throw new AnnualFinanceError('Cancelled, dropped, or transferred terms cannot receive charges.', 409);
      const inserted = await transaction.request()
        .input('assessmentId', sql.Int, term.assessment_id)
        .input('annualEnrollmentId', sql.Int, term.annual_enrollment_id)
        .input('enrollmentId', sql.Int, enrollmentId)
        .input('category', sql.NVarChar(40), category)
        .input('lineName', sql.NVarChar(120), lineName)
        .input('installment', sql.NVarChar(40), installment)
        .input('amount', sql.Decimal(12, 2), formatMoneyCents(amountCents))
        .input('reason', sql.NVarChar(1000), reason)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.NVarChar(64), fingerprint)
        .query(`INSERT INTO assessed_charges
            (assessment_id, annual_enrollment_id, enrollment_id, fee_category, line_name, installment, amount, gross_amount, is_manual, reason, idempotency_key, request_fingerprint)
          VALUES (@assessmentId, @annualEnrollmentId, @enrollmentId, @category, @lineName, @installment, @amount, @amount, 1, @reason, @idempotencyKey, @requestFingerprint)`);
      const chargeId = generatedId(inserted, 'Supplementary charge');
      await financeCases.applyApprovedExemptionsForCharge(transaction, actor, Number(term.annual_enrollment_id), chargeId);
      await requireFreshApproval(transaction, actor, enrollmentId, 'supplementary_charge_added');
      await writeAudit(transaction, actor, 'supplementary_charge_added', chargeId, {
        studentId, enrollmentId, feeCategory: category, lineName, installment, amount: formatMoneyCents(amountCents), reason
      });
      await debtRevisions.recordIncreaseIfAny(transaction, studentId, debtBefore);
      return { chargeId };
    });
  }

  async function reverseAdjustment(actorInput, studentInput, adjustmentInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const adjustmentId = bigId(adjustmentInput, 'adjustment');
    const reason = cleanText(input.reason, 'Reversal reason', 1000, true);
    const idempotencyKey = uuid(input.idempotencyKey, 'adjustment reversal');
    const fingerprint = requestFingerprint({ studentId, adjustmentId, reason });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const debtBefore = (await debtRevisions.readSnapshot(transaction, studentId)).canonicalBalanceCents;
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT adjustment.id, adjustment.reverses_adjustment_id, adjustment.request_fingerprint, annual.student_id
          FROM finance_charge_adjustments AS adjustment
          INNER JOIN v_finance_effective_assessed_charges AS charge ON charge.id = adjustment.charge_id
          INNER JOIN annual_enrollments AS annual  ON annual.id = charge.annual_enrollment_id
          WHERE adjustment.idempotency_key = @idempotencyKey FOR UPDATE`);
      if (prior.recordset?.[0]) {
        const existing = prior.recordset[0];
        if (Number(existing.student_id) !== studentId || Number(existing.reverses_adjustment_id) !== adjustmentId || existing.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different reversal details.', 409);
        }
        return { reversalId: existing.id, alreadyReversed: true };
      }
      const originalResult = await transaction.request().input('adjustmentId', sql.BigInt, adjustmentId)
        .query(`SELECT adjustment.id, adjustment.charge_id, adjustment.reverses_adjustment_id, CAST(adjustment.amount AS CHAR(40)) AS amount,
            charge.enrollment_id,
            annual.student_id
          FROM finance_charge_adjustments AS adjustment
          INNER JOIN assessed_charges AS charge ON charge.id = adjustment.charge_id
          INNER JOIN annual_enrollments AS annual  ON annual.id = charge.annual_enrollment_id
          WHERE adjustment.id = @adjustmentId
            AND EXISTS (SELECT 1 FROM v_finance_effective_assessed_charges AS effective WHERE effective.id = charge.id)
          FOR UPDATE`);
      const original = originalResult.recordset?.[0];
      if (!original || Number(original.student_id) !== studentId) throw new AnnualFinanceError('Adjustment not found for this student.', 404);
      if (original.reverses_adjustment_id != null) throw new AnnualFinanceError('A reversal entry cannot be reversed again.', 409);
      const existingReversal = await transaction.request().input('adjustmentId', sql.BigInt, adjustmentId)
        .query('SELECT id FROM finance_charge_adjustments WHERE reverses_adjustment_id = @adjustmentId LIMIT 1 FOR UPDATE');
      if (existingReversal.recordset?.length) throw new AnnualFinanceError('This adjustment has already been reversed.', 409);
      const chargeLock = await transaction.request().input('chargeId', sql.BigInt, original.charge_id)
        .query(`SELECT charge.id FROM assessed_charges AS charge WHERE charge.id = @chargeId
          AND EXISTS (SELECT 1 FROM v_finance_effective_assessed_charges AS effective WHERE effective.id = charge.id)
          FOR UPDATE`);
      if (!chargeLock.recordset?.length) throw new AnnualFinanceError('This assessed fee is no longer available.', 409);
      const basisResult = await transaction.request().input('chargeId', sql.BigInt, original.charge_id)
        .query(`SELECT CAST(charge.amount + COALESCE((SELECT SUM(adjustment.amount)
              FROM finance_charge_adjustments AS adjustment WHERE adjustment.charge_id = charge.id), 0) AS CHAR(40)) AS fee_basis,
            CAST(due.amount_due AS CHAR(40)) AS amount_due
          FROM v_finance_effective_assessed_charges AS charge
          INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
          WHERE charge.id = @chargeId`);
      const beforeBasisCents = parseMoneyCents(String(basisResult.recordset?.[0]?.fee_basis ?? '0.00'), { allowNegative: true, allowZero: true });
      const originalAmountCents = parseMoneyCents(String(original.amount), { allowNegative: true });
      const reversalAmountCents = -originalAmountCents;
      const afterBasisCents = beforeBasisCents + reversalAmountCents;
      if (originalAmountCents > 0n && afterBasisCents < 0n) {
        throw new AnnualFinanceError('Reversing this increase would reduce the fee below zero. Reverse earlier reductions first.', 409);
      }
      if (originalAmountCents < 0n && afterBasisCents <= beforeBasisCents) {
        throw new AnnualFinanceError('A corrective reversal must improve the saved fee basis.', 409);
      }
      const result = await transaction.request()
        .input('chargeId', sql.BigInt, original.charge_id)
        .input('amount', sql.Decimal(12, 2), formatMoneyCents(reversalAmountCents))
        .input('reason', sql.NVarChar(1000), reason)
        .input('reversesId', sql.BigInt, adjustmentId)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.NVarChar(64), fingerprint)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO finance_charge_adjustments
            (charge_id, amount, reason, reverses_adjustment_id, idempotency_key, request_fingerprint, recorded_by)
          VALUES (@chargeId, @amount, @reason, @reversesId, @idempotencyKey, @requestFingerprint, @actorId)`);
      if (originalAmountCents < 0n) {
        await requireFreshApproval(transaction, actor, Number(original.enrollment_id), 'negative_adjustment_reversed');
      }
      const reversalId = generatedId(result, 'Charge adjustment reversal');
      let releasePlan = { totalCents: 0n, annualCents: 0n, legacyCents: 0n };
      if (afterBasisCents >= 0n) {
        const dueAfterCents = parseMoneyCents(String(basisResult.recordset[0].amount_due), { allowNegative: true, allowZero: true }) + reversalAmountCents;
        if (dueAfterCents < 0n) {
          releasePlan = await financeCases.releaseOverpayment(transaction, actor, Number(original.charge_id),
            `Reversal #${reversalId} restored the fee basis. Excess applications were released as account credit.`);
        }
      }
      await writeAudit(transaction, actor, 'charge_adjustment_reversed', reversalId, {
        studentId, adjustmentId, reason, feeBasisBefore: formatMoneyCents(beforeBasisCents),
        feeBasisAfter: formatMoneyCents(afterBasisCents),
        releasedAnnualAllocations: formatMoneyCents(releasePlan.annualCents),
        releasedLegacyReconciliations: formatMoneyCents(releasePlan.legacyCents)
      });
      await debtRevisions.recordIncreaseIfAny(transaction, studentId, debtBefore);
      return { reversalId };
    });
  }

  async function reversePayment(actorInput, studentInput, paymentInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const paymentId = bigId(paymentInput, 'payment');
    const reason = cleanText(input.reason, 'Reversal reason', 1000, true);
    const idempotencyKey = uuid(input.idempotencyKey, 'payment reversal');
    const fingerprint = requestFingerprint({ studentId, paymentId, reason });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const debtBefore = (await debtRevisions.readSnapshot(transaction, studentId)).canonicalBalanceCents;
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT reversal.id, reversal.payment_id, reversal.request_fingerprint, payment.student_id
          FROM finance_payment_reversals AS reversal
          INNER JOIN finance_payments AS payment  ON payment.id = reversal.payment_id
          WHERE reversal.idempotency_key = @idempotencyKey FOR UPDATE`);
      if (prior.recordset?.[0]) {
        const existing = prior.recordset[0];
        if (Number(existing.student_id) !== studentId || Number(existing.payment_id) !== paymentId || existing.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different reversal details.', 409);
        }
        return { paymentId, reversed: true, alreadyReversed: true };
      }
      const paymentResult = await transaction.request().input('paymentId', sql.BigInt, paymentId)
        .query(`SELECT id, student_id, is_reversed FROM finance_payments  WHERE id = @paymentId FOR UPDATE`);
      const payment = paymentResult.recordset?.[0];
      if (!payment || Number(payment.student_id) !== studentId) throw new AnnualFinanceError('Payment not found for this student.', 404);
      if (flag(payment.is_reversed)) throw new AnnualFinanceError('This payment has already been reversed.', 409);
      const affectedTerms = await transaction.request().input('paymentId', sql.BigInt, paymentId)
        .query(`SELECT DISTINCT charge.enrollment_id
          FROM v_finance_net_payment_allocations AS allocation
            INNER JOIN v_finance_effective_assessed_charges AS charge ON charge.id = allocation.charge_id
          INNER JOIN enrollments AS enrollment  ON enrollment.id = charge.enrollment_id
          WHERE allocation.payment_id = @paymentId AND allocation.net_amount > 0`);
      await transaction.request().input('paymentId', sql.BigInt, paymentId).input('actorId', sql.Int, actor.id)
        .input('reason', sql.NVarChar(1000), reason).input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.NVarChar(64), fingerprint)
        .query(`INSERT INTO finance_payment_reversals (payment_id, reason, idempotency_key, request_fingerprint, recorded_by)
          VALUES (@paymentId, @reason, @idempotencyKey, @requestFingerprint, @actorId)`);
      const reversed = await transaction.request().input('paymentId', sql.BigInt, paymentId)
        .query('UPDATE finance_payments SET is_reversed = 1 WHERE id = @paymentId AND is_reversed = 0');
      if (reversed.rowsAffected?.[0] !== 1) throw new AnnualFinanceError('This payment changed before it could be reversed.', 409);
      for (const row of affectedTerms.recordset || []) {
        await requireFreshApproval(transaction, actor, Number(row.enrollment_id), 'qualifying_payment_reversed');
      }
      await writeAudit(transaction, actor, 'payment_reversed', paymentId, { studentId, reason });
      await debtRevisions.recordIncreaseIfAny(transaction, studentId, debtBefore);
      return { paymentId, reversed: true };
      return { paymentId, reversed: true };
    });
  }

  async function reconcileLegacyPayment(actorInput, studentInput, transactionInput, input = {}) {
    const studentId = id(studentInput, 'student');
    const transactionId = id(transactionInput, 'legacy transaction');
    const reason = cleanText(input.reason, 'Reconciliation reason', 1000, true);
    const idempotencyKey = uuid(input.idempotencyKey, 'legacy reconciliation');
    const allocations = normalizeAllocations(input);
    if (!allocations.length) throw new AnnualFinanceError('Add at least one charge allocation.');
    if (allocations.some((row) => row.openingLiabilityId)) throw new AnnualFinanceError('A legacy payment reconciliation can target assessed annual charges only.');
    const fingerprint = requestFingerprint({ studentId, transactionId, reason, allocations: canonicalAllocations(allocations) });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      await verifyStudent(transaction, studentId);
      const debtBefore = (await debtRevisions.readSnapshot(transaction, studentId)).canonicalBalanceCents;
      const legacyResult = await transaction.request().input('transactionId', sql.Int, transactionId)
        .input('studentId', sql.Int, studentId)
        .query(`SELECT transaction_record.id, transaction_record.transaction_type,
            transaction_record.is_legacy_unattributed, CAST(transaction_record.amount AS CHAR(40)) AS amount,
            account.student_id
          FROM financial_transactions AS transaction_record
          INNER JOIN financial_accounts AS account  ON account.id = transaction_record.financial_account_id
          WHERE transaction_record.id = @transactionId AND account.student_id = @studentId`);
      const legacyPayment = legacyResult.recordset?.[0];
      if (!legacyPayment || legacyPayment.transaction_type !== 'payment' || !flag(legacyPayment.is_legacy_unattributed)) {
        throw new AnnualFinanceError('Choose an unattributed legacy payment from this student account.', 409);
      }
      const opening = await transaction.request().input('studentId', sql.Int, studentId)
        .query(`SELECT id FROM finance_legacy_opening_charges  WHERE student_id = @studentId`);
      if (opening.recordset?.length) throw new AnnualFinanceError('Legacy payment credits cannot be reassigned after the source account is transferred to an opening liability.', 409);
      const priorBatch = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT id, transaction_id, request_fingerprint FROM finance_legacy_reconciliation_batches
          WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
      if (priorBatch.recordset?.[0]) {
        const prior = priorBatch.recordset[0];
        if (Number(prior.transaction_id) !== transactionId || prior.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different reconciliation details.', 409);
        }
        return { reconciliationBatchId: generatedId(prior.id, 'Legacy reconciliation batch'), amount: formatMoneyCents(allocations.reduce((sum, row) => sum + row.amountCents, 0n)), alreadyReconciled: true };
      }
      const prior = await transaction.request().input('transactionId', sql.Int, transactionId)
        .query(`SELECT COALESCE(SUM(net_amount), 0) AS allocated FROM v_finance_net_legacy_reconciliations
          WHERE transaction_id = @transactionId`);
      const amountCents = parseMoneyCents(String(legacyPayment.amount));
      const priorCents = parseMoneyCents(String(prior.recordset?.[0]?.allocated || '0.00'), { allowZero: true });
      const requestedCents = allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0n);
      if (priorCents + requestedCents > amountCents) throw new AnnualFinanceError('Reconciliation cannot exceed the unattributed legacy payment amount.', 409);
      const batchResult = await transaction.request()
        .input('transactionId', sql.Int, transactionId)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.NVarChar(64), fingerprint)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO finance_legacy_reconciliation_batches (transaction_id, idempotency_key, request_fingerprint, recorded_by)
          VALUES (@transactionId, @idempotencyKey, @requestFingerprint, @actorId)`);
      const batchId = generatedId(batchResult, 'Legacy reconciliation batch');
      for (const allocation of allocations) {
        const chargeResult = await transaction.request().input('chargeId', sql.BigInt, allocation.chargeId)
          .input('studentId', sql.Int, studentId)
          .query(`SELECT annual.student_id, charge.enrollment_id
            FROM assessed_charges AS charge
            INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
            WHERE charge.id = @chargeId AND annual.student_id = @studentId
              AND EXISTS (SELECT 1 FROM v_finance_effective_assessed_charges AS effective WHERE effective.id = charge.id)
            FOR UPDATE`);
        const charge = chargeResult.recordset?.[0];
        if (!charge || Number(charge.student_id) !== studentId) throw new AnnualFinanceError('A legacy payment may only be reconciled to a charge for the same student.', 409);
        const dueResult = await transaction.request().input('chargeId', sql.BigInt, allocation.chargeId)
          .query('SELECT amount_due FROM v_finance_assessed_charge_due WHERE charge_id = @chargeId');
        const due = parseMoneyCents(String(dueResult.recordset?.[0]?.amount_due || '0.00'), { allowNegative: true, allowZero: true });
        if (due <= 0n || allocation.amountCents > due) throw new AnnualFinanceError('Reconciliation cannot exceed the charge’s remaining amount due.', 409);
        await transaction.request().input('transactionId', sql.Int, transactionId)
          .input('chargeId', sql.BigInt, allocation.chargeId)
          .input('amount', sql.Decimal(12, 2), formatMoneyCents(allocation.amountCents))
          .input('reason', sql.NVarChar(1000), reason)
          .input('batchId', sql.BigInt, batchId)
          .input('actorId', sql.Int, actor.id)
          .query(`INSERT INTO finance_legacy_reconciliations
              (transaction_id, charge_id, amount, reason, batch_id, recorded_by)
            VALUES (@transactionId, @chargeId, @amount, @reason, @batchId, @actorId)`);
      }
      await writeAudit(transaction, actor, 'legacy_payment_reconciled', transactionId, { studentId, batchId, amount: formatMoneyCents(requestedCents), reason, allocationCount: allocations.length });
      await debtRevisions.recordIncreaseIfAny(transaction, studentId, debtBefore);
      return { transactionId, batchId, amount: formatMoneyCents(requestedCents) };
    });
  }

  async function approveTerm(actorInput, enrollmentInput, input = {}) {
    const enrollmentId = id(enrollmentInput, 'term enrollment');
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      const termResult = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
        .query(`SELECT enrollment.id, enrollment.student_id, enrollment.annual_enrollment_id,
            annual.intake_status
          FROM enrollments AS enrollment
          INNER JOIN annual_enrollments AS annual  ON annual.id = enrollment.annual_enrollment_id
          WHERE enrollment.id = @enrollmentId`);
      const term = termResult.recordset?.[0];
      if (!term) throw new AnnualFinanceError('Annual term placement not found.', 404);
      if (term.intake_status !== 'legacy') {
        throw new AnnualFinanceError('Enrollment is confirmed by the registrar; use payment and term clearance actions.', 409);
      }
      throw new AnnualFinanceError('Historical finance approval records are read-only.', 409);
    });
  }

  async function signTermClearance(actorInput, enrollmentInput, input = {}) {
    const enrollmentId = id(enrollmentInput, 'term enrollment');
    if (!flag(input.confirmClearance)) throw new AnnualFinanceError('Confirm the signed clearance decision.');
    const reason = cleanText(input.reason, 'Clearance reason', 1000, true);
    const arrangement = input.arrangement == null || input.arrangement === '' ? null : cleanText(input.arrangement, 'Payment arrangement', 1000);
    const financeNote = input.financeNote == null || input.financeNote === '' ? null : cleanText(input.financeNote, 'Private finance note', 2000);
    const idempotencyKey = uuid(input.idempotencyKey, 'clearance submission');
    const fingerprint = requestFingerprint({ enrollmentId, reason, arrangement, financeNote, confirmClearance: true });
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT id, enrollment_id, event_type, request_fingerprint, outstanding_snapshot
          FROM term_clearance_events  WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
      if (prior.recordset?.[0]) {
        const existing = prior.recordset[0];
        if (Number(existing.enrollment_id) !== enrollmentId || existing.event_type !== 'signed' || existing.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different clearance details.', 409);
        }
        return { enrollmentId, clearanceStatus: 'signed', outstanding: String(existing.outstanding_snapshot || '0.00'), alreadySigned: true };
      }
      const termResult = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
        .query(`SELECT enrollment.id, enrollment.annual_enrollment_id, enrollment.term_scope_status
          FROM enrollments AS enrollment
          INNER JOIN annual_enrollments AS annual  ON annual.id = enrollment.annual_enrollment_id
          WHERE enrollment.id = @enrollmentId AND annual.intake_status <> 'legacy' FOR UPDATE`);
      const term = termResult.recordset?.[0];
      if (!term) throw new AnnualFinanceError('Annual term placement not found.', 404);
      if (term.term_scope_status !== 'applicable') throw new AnnualFinanceError('A pre-entry term has no term-end clearance.', 409);
      const signed = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
        .query(`SELECT id FROM term_clearance_events
          WHERE enrollment_id = @enrollmentId AND event_type = 'signed' ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`);
      if (signed.recordset?.length) throw new AnnualFinanceError('A signed term-end clearance is already recorded for this placement.', 409);
      const chargeOutstanding = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
        .query(`SELECT COALESCE(SUM(amount_due), 0) AS outstanding
          FROM v_finance_assessed_charge_due WHERE enrollment_id = @enrollmentId`);
      const outstandingCents = parseMoneyCents(String(chargeOutstanding.recordset?.[0]?.outstanding || '0.00'), { allowNegative: true, allowZero: true });
      if (outstandingCents > 0n && !arrangement) throw new AnnualFinanceError('Record a payment arrangement when signing clearance with a remaining balance.');
      await transaction.request()
        .input('enrollmentId', sql.Int, enrollmentId)
        .input('reason', sql.NVarChar(1000), reason)
        .input('arrangement', sql.NVarChar(1000), arrangement)
        .input('financeNote', sql.NVarChar(2000), financeNote)
        .input('actorId', sql.Int, actor.id)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('requestFingerprint', sql.NVarChar(64), fingerprint)
        .input('outstanding', sql.Decimal(12, 2), formatMoneyCents(outstandingCents))
        .query(`INSERT INTO term_clearance_events
            (enrollment_id, event_type, reason, arrangement, finance_note, recorded_by, idempotency_key, request_fingerprint, outstanding_snapshot)
          VALUES (@enrollmentId, 'signed', @reason, @arrangement, @financeNote, @actorId, @idempotencyKey, @requestFingerprint, @outstanding)`);
      await writeAudit(transaction, actor, 'term_clearance_signed', enrollmentId, {
        outstanding: formatMoneyCents(outstandingCents), arrangementRecorded: Boolean(arrangement), reason
      });
      return { enrollmentId, clearanceStatus: 'signed', outstanding: formatMoneyCents(outstandingCents) };
    });
  }

  async function resolveVoucherReview(actorInput, annualEnrollmentInput, input = {}) {
    const annualEnrollmentId = id(annualEnrollmentInput, 'annual enrollment');
    const resolution = input.resolution;
    if (!['assessment_stands', 'adjustments_recorded'].includes(resolution)) throw new AnnualFinanceError('Choose how finance resolved the voucher review.');
    const reason = cleanText(input.reason, 'Voucher review reason', 900, true);
    const idempotencyKey = uuid(input.idempotencyKey, 'voucher review resolution');
    const recordedReason = `${resolution === 'assessment_stands' ? 'Assessment remains valid' : 'Required adjustments were recorded'}: ${reason}`;
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction.request(), actorInput);
      const parentResult = await transaction.request().input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .query(`SELECT annual.id, annual.student_id, annual.voucher_code, annual.intake_status,
            student.status AS student_status,
            assessment.id AS assessment_id, assessment.schedule_id, assessment.schedule_version,
            assessment.voucher_code_snapshot, assessment.assessed_at
          FROM annual_enrollments AS annual
          INNER JOIN students AS student  ON student.id = annual.student_id
          LEFT JOIN annual_assessments AS assessment  ON assessment.annual_enrollment_id = annual.id
          WHERE annual.id = @annualEnrollmentId AND annual.intake_status <> 'legacy' FOR UPDATE`);
      const parent = parentResult.recordset?.[0];
      if (!parent) throw new AnnualFinanceError('Annual enrollment not found.', 404);
      if (parent.student_status === 'archived') throw new AnnualFinanceError('Archived student finance history is read-only.', 409);
      if (!parent.assessment_id) throw new AnnualFinanceError('Post the annual assessment before resolving a voucher review.', 409);
      const fingerprint = requestFingerprint({ annualEnrollmentId, assessmentId: Number(parent.assessment_id),
        scheduleId: Number(parent.schedule_id), scheduleVersion: Number(parent.schedule_version),
        assessedVoucherCode: parent.voucher_code_snapshot, currentVoucherCode: parent.voucher_code,
        resolution, reason });
      const prior = await transaction.request().input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .query(`SELECT annual_enrollment_id, event_type, request_fingerprint FROM annual_enrollment_events
          WHERE idempotency_key = @idempotencyKey FOR UPDATE`);
      if (prior.recordset?.[0]) {
        const old = prior.recordset[0];
        if (Number(old.annual_enrollment_id) !== annualEnrollmentId || old.event_type !== 'voucher_review_resolved' || old.request_fingerprint !== fingerprint) {
          throw new AnnualFinanceError('This submission token was already used for different voucher review details.', 409);
        }
        return { annualEnrollmentId, studentId: Number(parent.student_id), resolved: true, alreadyResolved: true };
      }
      const voucherReview = await loadVoucherReviewState(transaction.request(), sql, {
        annualEnrollmentId, assessmentId: Number(parent.assessment_id), scheduleId: Number(parent.schedule_id),
        scheduleVersion: Number(parent.schedule_version), assessedVoucherCode: parent.voucher_code_snapshot,
        currentVoucherCode: parent.voucher_code, assessedAt: parent.assessed_at
      }, { lock: true });
      const flaggedReview = voucherReview?.eventType === 'voucher_review_flagged';
      const legacyResolutionNeedsFreshReview = parent.intake_status === 'pending'
        && parent.voucher_code !== parent.voucher_code_snapshot
        && voucherReview?.eventType === 'voucher_review_resolved'
        && voucherReview.status === 'unverified' && voucherReview.assessmentBound === false;
      if (!flaggedReview && !legacyResolutionNeedsFreshReview) {
        throw new AnnualFinanceError('There is no unresolved voucher change for this assessment.', 409);
      }
      const event = await transaction.request()
        .input('annualEnrollmentId', sql.Int, annualEnrollmentId)
        .input('assessmentId', sql.Int, Number(parent.assessment_id))
        .input('actorId', sql.Int, actor.id)
        .input('reason', sql.NVarChar(1000), recordedReason)
        .input('idempotencyKey', sql.UniqueIdentifier, idempotencyKey)
        .input('fingerprint', sql.NVarChar(64), fingerprint)
        .query(`INSERT INTO annual_enrollment_events
            (annual_enrollment_id, finance_assessment_id, actor_id, event_type, reason, idempotency_key, request_fingerprint)
          VALUES (@annualEnrollmentId, @assessmentId, @actorId, 'voucher_review_resolved', @reason, @idempotencyKey, @fingerprint)`);
      await writeAudit(transaction, actor, 'voucher_review_resolved', event.insertId || event.recordset?.[0]?.id, {
        annualEnrollmentId, assessmentId: Number(parent.assessment_id), scheduleId: Number(parent.schedule_id),
        scheduleVersion: Number(parent.schedule_version), currentVoucher: parent.voucher_code,
        assessedVoucher: parent.voucher_code_snapshot, resolution, reason
      });
      return { annualEnrollmentId, studentId: Number(parent.student_id), resolved: true };
    });
  }

  async function getStudentLedger(actorInput, studentInput, access = 'finance') {
    const studentId = id(studentInput, 'student');
    return runTransaction(async (transaction) => {
    if (access === 'student') {
      const owner = await transaction.request().input('actorId', sql.Int, id(actorInput, 'user')).input('studentId', sql.Int, studentId)
        .query(`SELECT student.id FROM students AS student
          INNER JOIN users AS account ON account.id = student.user_id
          WHERE student.id = @studentId AND account.id = @actorId AND account.is_active = 1 AND account.role = 'student'`);
      if (!owner.recordset?.length) throw new AnnualFinanceError('This student statement is not available to your account.', 403);
    } else {
      await requireFinanceActor(transaction.request(), actorInput);
    }
    const eventsRequest = transaction.request().input('studentId', sql.Int, studentId).input('isStudent', sql.Bit, access === 'student');
    const studentResult = await transaction.request().input('studentId', sql.Int, studentId).input('isStudent', sql.Bit, access === 'student')
      .query(`SELECT id, student_no, CASE WHEN @isStudent = 1 THEN NULL ELSE lrn END AS lrn,
          first_name, middle_name, last_name, suffix, status
        FROM students WHERE id = @studentId`);
    const summaryResult = await transaction.request().input('studentId', sql.Int, studentId)
      .query(STUDENT_LEDGER_SUMMARY_SQL);
    const chargesResult = await transaction.request().input('studentId', sql.Int, studentId).query(`SELECT charge.id AS charge_id, charge.annual_enrollment_id, charge.enrollment_id,
          annual.school_year, annual.grade_level, annual.voucher_code, enrollment.annual_term_number, term.term,
          section.name AS section_name, charge.fee_category, charge.line_name, charge.installment,
          CAST(COALESCE(schedule_line.is_optional, 0) AS UNSIGNED) AS is_optional,
          CAST(charge.gross_amount AS CHAR(40)) AS amount,
          CAST(charge.waived_amount AS CHAR(40)) AS waived_amount,
          CAST(COALESCE((SELECT SUM(adjustment.amount) FROM finance_charge_adjustments AS adjustment WHERE adjustment.charge_id = charge.id), 0) AS CHAR(40)) AS adjustments,
          CAST(COALESCE(due.annual_allocated + due.legacy_allocated, 0) AS CHAR(40)) AS allocated,
          CAST(COALESCE(due.amount_due, charge.amount) AS CHAR(40)) AS remaining_due,
          CAST(CASE WHEN term.is_current = 1 THEN 1 ELSE 0 END AS UNSIGNED) AS is_current_term
        FROM v_finance_effective_assessed_charges AS charge
        INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
        INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN finance_schedule_lines AS schedule_line ON schedule_line.id = charge.schedule_line_id
        LEFT JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
        WHERE annual.student_id = @studentId ORDER BY annual.school_year, enrollment.annual_term_number, charge.id`);
    const eventsResult = await eventsRequest.query(`
        SELECT event_date, event_type, amount, reference_no, details, sort_key, source_id
        FROM (
          SELECT charge.created_at AS event_date, 'charge' AS event_type,
            CAST(charge.amount AS CHAR(40)) AS amount, CAST(NULL AS CHAR(100)) AS reference_no,
            CONCAT(CASE WHEN charge.synthetic_restatement_role = 'source'
              THEN 'Original whole-term tuition source · '
              WHEN charge.synthetic_restatement_role = 'generated' AND EXISTS (
                SELECT 1 FROM finance_assessment_restatement_events AS reversed
                WHERE reversed.operation_id = charge.synthetic_restatement_operation_id AND reversed.event_type = 'reversed')
              THEN 'Retired synthetic tuition installment (restatement reversed) · '
              WHEN charge.synthetic_restatement_role = 'generated' THEN 'Synthetic tuition installment · ' ELSE '' END,
              annual.school_year, ' · Term ', enrollment.annual_term_number, ' · ', charge.line_name, ' · ', charge.installment) AS details,
            charge.id AS sort_key, charge.id AS source_id
          FROM assessed_charges AS charge
          INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
          INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id WHERE annual.student_id = @studentId
          UNION ALL
          SELECT adjustment.created_at, 'adjustment', CAST(adjustment.amount AS CHAR(40)), CAST(NULL AS CHAR(100)),
            CASE WHEN @isStudent = 1 THEN CONCAT('Finance adjustment to charge #', adjustment.charge_id,
                CASE WHEN charge.synthetic_restatement_role = 'generated' THEN ' · synthetic tuition installment'
                  WHEN charge.synthetic_restatement_role = 'source' THEN ' · original whole-term tuition source' ELSE '' END)
              ELSE CONCAT('Charge #', adjustment.charge_id, ' · ', adjustment.reason,
                CASE WHEN charge.synthetic_restatement_role = 'generated' THEN ' · synthetic tuition installment'
                  WHEN charge.synthetic_restatement_role = 'source' THEN ' · original whole-term tuition source' ELSE '' END) END,
            adjustment.id, adjustment.id
          FROM finance_charge_adjustments AS adjustment
          INNER JOIN assessed_charges AS charge ON charge.id = adjustment.charge_id
          INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id WHERE annual.student_id = @studentId
          UNION ALL
          SELECT payment.payment_date, 'payment', CAST(payment.amount AS CHAR(40)), payment.reference_no,
            CONCAT('Payment #', payment.id, CASE WHEN payment.receipt_issued = 1 THEN ' · receipt issued' ELSE '' END), payment.id, payment.id
          FROM finance_payments AS payment WHERE payment.student_id = @studentId
          UNION ALL
          SELECT opening.created_at, 'legacy opening liability', CAST(opening.amount AS CHAR(40)), CAST(NULL AS CHAR(100)),
            CASE WHEN @isStudent = 1 THEN 'Verified prior account balance transferred to the statement'
              ELSE CONCAT(opening.source_label, ' · ', opening.reason) END, opening.id, opening.id
          FROM finance_legacy_opening_charges AS opening WHERE opening.student_id = @studentId
          UNION ALL
          SELECT allocation.created_at, 'allocation', CAST(NULL AS CHAR(40)), CAST(NULL AS CHAR(100)),
            CONCAT(CASE
              WHEN allocation.synthetic_restatement_kind = 'placement' AND EXISTS (
                SELECT 1 FROM finance_assessment_restatement_events AS reversed
                WHERE reversed.operation_id = allocation.synthetic_restatement_operation_id AND reversed.event_type = 'reversed')
                THEN 'Retired synthetic tuition installment placement · '
              WHEN allocation.synthetic_restatement_kind = 'placement' AND EXISTS (
                SELECT 1 FROM finance_assessment_restatement_events AS applied
                WHERE applied.operation_id = allocation.synthetic_restatement_operation_id AND applied.event_type = 'applied')
                THEN 'Synthetic tuition installment placement · '
              WHEN allocation.synthetic_restatement_kind = 'placement' THEN 'Inactive synthetic tuition installment placement · '
              WHEN allocation.synthetic_restatement_kind = 'restoration' THEN 'Restored original tuition application · '
              ELSE '' END,
              'Payment #', allocation.payment_id, ' allocated to charge #', allocation.charge_id, ' · ', CAST(allocation.amount AS CHAR(40))), allocation.id, allocation.id
          FROM finance_payment_allocations AS allocation
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
          INNER JOIN assessed_charges AS charge ON charge.id = allocation.charge_id
          WHERE payment.student_id = @studentId
          UNION ALL
          SELECT allocation.created_at, 'allocation', CAST(NULL AS CHAR(40)), CAST(NULL AS CHAR(100)),
            CONCAT(CASE
              WHEN allocation.synthetic_restatement_kind = 'placement' AND EXISTS (
                SELECT 1 FROM finance_assessment_restatement_events AS reversed
                WHERE reversed.operation_id = allocation.synthetic_restatement_operation_id AND reversed.event_type = 'reversed')
                THEN 'Retired synthetic tuition installment placement · '
              WHEN allocation.synthetic_restatement_kind = 'placement' AND EXISTS (
                SELECT 1 FROM finance_assessment_restatement_events AS applied
                WHERE applied.operation_id = allocation.synthetic_restatement_operation_id AND applied.event_type = 'applied')
                THEN 'Synthetic tuition installment placement · '
              WHEN allocation.synthetic_restatement_kind = 'placement' THEN 'Inactive synthetic tuition installment placement · '
              WHEN allocation.synthetic_restatement_kind = 'restoration' THEN 'Restored original tuition application · '
              ELSE '' END,
              'Payment #', allocation.payment_id, ' allocated to verified prior balance · ', CAST(allocation.amount AS CHAR(40))), allocation.id, allocation.id
          FROM finance_payment_allocations AS allocation
          INNER JOIN finance_legacy_opening_charges AS opening ON opening.id = allocation.legacy_opening_charge_id
          WHERE opening.student_id = @studentId
          UNION ALL
          SELECT allocation_release.created_at, 'allocation release', CAST(allocation_release.amount AS CHAR(40)), CAST(NULL AS CHAR(100)),
            CASE WHEN allocation_release.synthetic_restatement_operation_id IS NOT NULL
                AND allocation.synthetic_restatement_kind IS NULL
              THEN CONCAT('Original tuition application released for canonical installment placement · Payment #', payment.id)
              WHEN allocation_release.synthetic_restatement_operation_id IS NOT NULL
                AND allocation.synthetic_restatement_kind = 'placement'
              THEN CONCAT('Synthetic tuition installment placement released during reversal · Payment #', payment.id)
              WHEN allocation_release.synthetic_restatement_operation_id IS NOT NULL
              THEN CONCAT('Finance restatement allocation release · Payment #', payment.id)
              WHEN @isStudent = 1 THEN CONCAT('Payment #', payment.id, ' allocation corrected')
              ELSE CONCAT('Payment #', payment.id, ' allocation released · ', allocation_release.reason) END,
            allocation_release.id, allocation_release.id
          FROM finance_payment_allocation_releases AS allocation_release
          INNER JOIN finance_payment_allocations AS allocation ON allocation.id = allocation_release.allocation_id
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
          WHERE payment.student_id = @studentId
          UNION ALL
          SELECT metadata.created_at, CONCAT('payment ', metadata.event_type), CAST(NULL AS CHAR(40)), metadata.reference_no,
            CASE WHEN @isStudent = 1 THEN CASE WHEN metadata.event_type = 'receipt_marked_issued' THEN 'Receipt marked issued' ELSE 'Receipt reference updated' END
              ELSE COALESCE(metadata.private_remark, CONCAT('Payment #', metadata.payment_id, ' receipt metadata updated')) END,
            metadata.id, metadata.id
          FROM finance_payment_metadata_events AS metadata
          INNER JOIN finance_payments AS payment ON payment.id = metadata.payment_id
          WHERE payment.student_id = @studentId AND (metadata.event_type <> 'private_remark_added' OR @isStudent = 0)
          UNION ALL
          SELECT reversal.created_at, 'payment reversal', CAST(NULL AS CHAR(40)), CAST(NULL AS CHAR(100)),
            CASE WHEN @isStudent = 1 THEN CONCAT('Payment #', reversal.payment_id, ' reversed')
              ELSE CONCAT('Payment #', reversal.payment_id, ' · ', reversal.reason) END, reversal.id, reversal.payment_id
          FROM finance_payment_reversals AS reversal
          INNER JOIN finance_payments AS payment ON payment.id = reversal.payment_id WHERE payment.student_id = @studentId
          UNION ALL
          SELECT transaction_record.created_at, CONCAT('unattributed legacy ', transaction_record.transaction_type),
            CAST(transaction_record.amount AS CHAR(40)), transaction_record.reference_no,
            CASE WHEN @isStudent = 1 THEN 'Legacy transaction retained without new-charge attribution'
              ELSE COALESCE(transaction_record.description, 'Legacy balance retained without new-charge attribution') END, transaction_record.id, transaction_record.id
          FROM financial_transactions AS transaction_record
          INNER JOIN financial_accounts AS account ON account.id = transaction_record.financial_account_id
          WHERE account.student_id = @studentId AND transaction_record.is_legacy_unattributed = 1
          UNION ALL
          SELECT reconciliation.created_at, 'legacy reconciliation', CAST(reconciliation.amount AS CHAR(40)), CAST(NULL AS CHAR(100)),
            CASE WHEN @isStudent = 1 THEN 'Prior recorded credit applied to an assessed charge'
              ELSE CONCAT('Legacy payment #', reconciliation.transaction_id, ' allocated to charge #', reconciliation.charge_id, ' · ', reconciliation.reason) END,
            reconciliation.id, reconciliation.id
          FROM finance_legacy_reconciliations AS reconciliation
          INNER JOIN financial_transactions AS legacy ON legacy.id = reconciliation.transaction_id
          INNER JOIN financial_accounts AS account ON account.id = legacy.financial_account_id
          WHERE account.student_id = @studentId
          UNION ALL
          SELECT clearance.created_at, 'signed clearance', CAST(clearance.outstanding_snapshot AS CHAR(40)), CAST(NULL AS CHAR(100)),
            CASE WHEN @isStudent = 1 THEN 'Signed term-end clearance recorded'
              ELSE CONCAT('Signed clearance · ', clearance.reason,
                CASE WHEN clearance.arrangement IS NULL THEN '' ELSE CONCAT(' · Arrangement: ', clearance.arrangement) END,
                CASE WHEN clearance.finance_note IS NULL THEN '' ELSE CONCAT(' · Private note: ', clearance.finance_note) END) END,
            clearance.id, clearance.id
          FROM term_clearance_events AS clearance
          INNER JOIN enrollments AS enrollment ON enrollment.id = clearance.enrollment_id
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          WHERE annual.student_id = @studentId AND clearance.event_type = 'signed'
        ) AS entries ORDER BY event_date, event_type, sort_key`);
    const termsResult = await transaction.request().input('studentId', sql.Int, studentId).input('isStudent', sql.Bit, access === 'student').query(`WITH latest_voucher_event AS (
          SELECT annual_enrollment_id, finance_assessment_id, event_type, reason, created_at,
            ROW_NUMBER() OVER (PARTITION BY annual_enrollment_id ORDER BY created_at DESC, id DESC) AS event_rank
          FROM annual_enrollment_events
          WHERE event_type IN ('voucher_review_flagged', 'voucher_review_resolved')
        ), latest_clearance_event AS (
          SELECT enrollment_id, event_type,
            ROW_NUMBER() OVER (PARTITION BY enrollment_id ORDER BY created_at DESC, id DESC) AS event_rank
          FROM term_clearance_events
        )
        SELECT enrollment.id AS enrollment_id,
          enrollment.academic_term_id, annual.id AS annual_enrollment_id, annual.school_year, annual.grade_level,
          annual.voucher_code, annual.voucher_category, annual.intake_status, annual.entry_term_number,
          assessment.id AS assessment_id, assessment.schedule_version,
          enrollment.annual_term_number, enrollment.term_scope_status, enrollment.enrollment_status, term.term, term.is_current,
          section.name AS section_name, section.cluster, section.strand, section.adviser, section.modality, section.modular_subtype,
          CAST(COALESCE(due_by_enrollment.total, 0) AS CHAR(40)) AS outstanding,
          confirmation.id AS registrar_confirmation_id,
          assessment.voucher_code_snapshot AS assessed_voucher_code, assessment.schedule_version AS assessed_schedule_version,
          CASE WHEN voucher_event.event_type = 'voucher_review_flagged'
            OR (@isStudent = 0 AND annual.intake_status = 'pending' AND assessment.voucher_code_snapshot IS NOT NULL
              AND annual.voucher_code <> assessment.voucher_code_snapshot
              AND voucher_event.event_type = 'voucher_review_resolved'
              AND (voucher_event.finance_assessment_id IS NULL OR voucher_event.finance_assessment_id <> assessment.id))
            THEN CAST(1 AS UNSIGNED) ELSE CAST(0 AS UNSIGNED) END AS voucher_review_required,
          CASE WHEN @isStudent = 1 THEN NULL ELSE voucher_event.reason END AS voucher_review_reason,
          clearance.event_type AS signed_clearance_status
        FROM enrollments AS enrollment
        INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN (
          SELECT due.enrollment_id, SUM(due.amount_due) AS total
          FROM v_finance_assessed_charge_due AS due
          INNER JOIN annual_enrollments AS due_annual ON due_annual.id = due.annual_enrollment_id
          WHERE due_annual.student_id = @studentId GROUP BY due.enrollment_id
        ) AS due_by_enrollment ON due_by_enrollment.enrollment_id = enrollment.id
        LEFT JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = annual.id
        LEFT JOIN latest_voucher_event AS voucher_event ON voucher_event.annual_enrollment_id = annual.id
          AND voucher_event.event_rank = 1
        LEFT JOIN latest_clearance_event AS clearance ON clearance.enrollment_id = enrollment.id AND clearance.event_rank = 1
        WHERE annual.student_id = @studentId ORDER BY annual.school_year DESC, enrollment.annual_term_number`);
    const restatementResult = await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT archive.operation_id, archive.annual_enrollment_id, archive.assessment_id,
          annual.school_year, annual.grade_level,
          archive.source_schedule_id, archive.source_schedule_version,
          archive.target_tuition_schedule_id, archive.target_tuition_schedule_version,
          archive.before_image_json, archive.before_image_sha256,
          archive.applied_image_json, archive.applied_image_sha256,
          operation.operation_kind, operation.manifest_sha256,
          applied.id AS applied_event_id, applied.manifest_sha256 AS applied_manifest_sha256,
          applied.resulting_state_sha256 AS applied_state_sha256,
          reversed.id AS reversed_event_id, reversed.manifest_sha256 AS reversed_manifest_sha256,
          reversed.resulting_state_sha256 AS reversed_state_sha256
        FROM finance_assessment_restatement_annuals AS archive
        INNER JOIN annual_enrollments AS annual ON annual.id = archive.annual_enrollment_id
        INNER JOIN finance_assessment_restatement_operations AS operation ON operation.operation_id = archive.operation_id
        LEFT JOIN finance_assessment_restatement_events AS applied
          ON applied.operation_id = archive.operation_id AND applied.event_type = 'applied'
        LEFT JOIN finance_assessment_restatement_events AS reversed
          ON reversed.operation_id = archive.operation_id AND reversed.event_type = 'reversed'
        WHERE annual.student_id = @studentId ORDER BY annual.school_year, archive.annual_enrollment_id`);
    const restatementsByAnnual = new Map();
    const sourceAllocationPurposeById = buildRestatementSourceAllocationPurposeMap(restatementResult.recordset || []);
    const syntheticPlacementPurposeById = buildRestatementSyntheticPlacementPurposeMap(restatementResult.recordset || []);
    for (const row of restatementResult.recordset || []) {
      validateRestatementRow(row);
      const isActive = row.reversed_event_id == null;
      restatementsByAnnual.set(Number(row.annual_enrollment_id), {
        schoolYear: String(row.school_year), gradeLevel: String(row.grade_level),
        status: isActive ? 'active' : 'reversed',
        sourceScheduleVersion: Number(row.source_schedule_version),
        targetTuitionScheduleVersion: Number(row.target_tuition_schedule_version),
        compositionLabel: isActive
          ? `Current composition: synthetic tuition installments from schedule v${Number(row.target_tuition_schedule_version)}; non-tuition fees from original schedule v${Number(row.source_schedule_version)}.`
          : 'Original fee composition restored after a logical Finance restatement reversal.',
        confirmationLabel: 'The original Registrar confirmation and its saved assessment snapshot were not changed.'
      });
    }
    const financeClassificationsResult = access === 'student'
      ? { recordset: [] }
      : await transaction.request().input('studentId', sql.Int, studentId)
        .query(`SET STATEMENT optimizer_switch='derived_merge=off,condition_pushdown_for_derived=off' FOR
          WITH ${FINANCE_TERM_CLASSIFICATION_CTES}
          SELECT classification.enrollment_id, classification.assessment_id,
            classification.registrar_confirmation_id, classification.assessed_charge_count,
            classification.tuition_line_count, classification.canonical_tuition_count,
            classification.dp_count, classification.prelim_count, classification.midterm_count, classification.finals_count,
            classification.whole_tracking_available, classification.installment_tracking_available,
            classification.whole_status, classification.dp_status, classification.prelim_status,
            classification.midterm_status, classification.finals_status
          FROM FinanceTermClassification AS classification WHERE classification.student_id = @studentId`);
    const currentTermContextResult = await transaction.request().query(`SELECT term.school_year,
        termOrder.term_number AS current_term_number
      FROM academic_terms AS term
      LEFT JOIN school_year_term_order AS termOrder ON termOrder.academic_term_id = term.id
      WHERE term.is_current = 1 ORDER BY term.school_year DESC, term.id DESC LIMIT 1`);
    const paymentOptionsResult = await transaction.request().input('studentId', sql.Int, studentId).query(`SELECT payment.id AS payment_id,
        CAST(payment.amount AS CHAR(40)) AS amount, CAST(credit.available_credit AS CHAR(40)) AS available_amount,
        payment.payment_date, payment.reference_no, payment.receipt_issued
      FROM v_finance_payment_credit AS credit
      INNER JOIN finance_payments AS payment ON payment.id = credit.payment_id
      WHERE credit.student_id = @studentId AND credit.is_reversed = 0 AND credit.available_credit > 0
      ORDER BY payment.payment_date, payment.id`);
    const openingLiabilitiesResult = access === 'student' ? { recordset: [] } : await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT opening.id AS opening_liability_id, opening.source_label,
          CAST(opening.amount AS CHAR(40)) AS amount, CAST(due.amount_due AS CHAR(40)) AS amount_due,
          opening.created_at
        FROM finance_legacy_opening_charges AS opening
        INNER JOIN v_finance_opening_liability_due AS due ON due.opening_charge_id = opening.id
        WHERE opening.student_id = @studentId ORDER BY opening.created_at, opening.id`);
    const allocationHistoryResult = await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT allocation.id AS allocation_id, allocation.payment_id, allocation.charge_id,
          allocation.legacy_opening_charge_id, payment.payment_date, payment.reference_no, payment.is_reversed,
          allocation.synthetic_restatement_operation_id, allocation.synthetic_restatement_kind,
          CAST(CASE WHEN allocation.charge_id IS NOT NULL AND current_charge.id IS NULL THEN 0 ELSE 1 END AS UNSIGNED) AS charge_is_effective,
          CASE
            WHEN allocation.synthetic_restatement_kind = 'placement' AND net.is_effective = 1
              THEN 'Synthetic tuition installment placement'
            WHEN allocation.synthetic_restatement_kind = 'placement' AND EXISTS (
              SELECT 1 FROM finance_assessment_restatement_events AS reversed
              WHERE reversed.operation_id = allocation.synthetic_restatement_operation_id AND reversed.event_type = 'reversed')
              THEN 'Historical synthetic tuition installment placement; restatement reversed'
            WHEN allocation.synthetic_restatement_kind = 'placement'
              THEN 'Inactive synthetic tuition installment placement; no active apply event'
            WHEN allocation.synthetic_restatement_kind = 'restoration' AND net.is_effective = 1
              THEN 'Restored original tuition application'
            WHEN allocation.synthetic_restatement_kind = 'restoration'
              THEN 'Inactive original tuition application restoration'
            ELSE NULL
          END AS restatement_history_label,
          CAST(allocation.amount AS CHAR(40)) AS original_amount,
          CAST(CASE WHEN payment.is_reversed = 1 THEN 0 ELSE net.net_amount END AS CHAR(40)) AS remaining_amount,
          CAST(net.active_released_amount AS CHAR(40)) AS released_amount,
          CAST(COALESCE(release_history.recorded_released_amount, 0) AS CHAR(40)) AS recorded_released_amount,
          release_history.source_restatement_operation_id,
          annual.school_year, annual.grade_level, enrollment.annual_term_number, term.term,
          charge.line_name, charge.fee_category, charge.installment,
          CAST(COALESCE(charge_due.amount_due, opening_due.amount_due) AS CHAR(40)) AS current_due_amount,
          opening.source_label
        FROM finance_payment_allocations AS allocation
        INNER JOIN v_finance_net_payment_allocations AS net ON net.allocation_id = allocation.id
        INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
        LEFT JOIN assessed_charges AS charge ON charge.id = allocation.charge_id
        LEFT JOIN v_finance_effective_assessed_charges AS current_charge ON current_charge.id = charge.id
        LEFT JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
        LEFT JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
        LEFT JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN v_finance_assessed_charge_due AS charge_due ON charge_due.charge_id = allocation.charge_id
        LEFT JOIN finance_legacy_opening_charges AS opening ON opening.id = allocation.legacy_opening_charge_id
        LEFT JOIN v_finance_opening_liability_due AS opening_due ON opening_due.opening_charge_id = opening.id
        LEFT JOIN (
          SELECT release_row.allocation_id,
            SUM(release_row.amount) AS recorded_released_amount,
            MAX(CASE WHEN release_row.synthetic_restatement_operation_id IS NOT NULL
              THEN release_row.synthetic_restatement_operation_id END) AS source_restatement_operation_id
          FROM finance_payment_allocation_releases AS release_row
          GROUP BY release_row.allocation_id
        ) AS release_history ON release_history.allocation_id = allocation.id
        WHERE payment.student_id = @studentId
          AND (net.net_amount > 0 OR net.active_released_amount > 0 OR allocation.synthetic_restatement_operation_id IS NOT NULL)
        ORDER BY payment.payment_date, allocation.id`);
    const legacyReconciliationHistoryResult = await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT reconciliation.id AS reconciliation_id, reconciliation.transaction_id,
          reconciliation.charge_id,
          CAST(reconciliation.amount AS CHAR(40)) AS original_amount,
          CAST(net.net_amount AS CHAR(40)) AS remaining_amount,
          CAST(reconciliation.amount - net.net_amount AS CHAR(40)) AS released_amount,
          legacy.created_at AS payment_date, legacy.reference_no, annual.school_year, annual.grade_level,
          enrollment.annual_term_number, term.term, charge.line_name, charge.fee_category, charge.installment,
          CAST(due.amount_due AS CHAR(40)) AS current_due_amount
        FROM finance_legacy_reconciliations AS reconciliation
        INNER JOIN v_finance_net_legacy_reconciliations AS net ON net.reconciliation_id = reconciliation.id
        INNER JOIN financial_transactions AS legacy ON legacy.id = reconciliation.transaction_id
        INNER JOIN financial_accounts AS account ON account.id = legacy.financial_account_id
        INNER JOIN v_finance_effective_assessed_charges AS charge ON charge.id = reconciliation.charge_id
        INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
        INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
        WHERE account.student_id = @studentId AND (net.net_amount > 0 OR reconciliation.amount > net.net_amount)
        ORDER BY legacy.created_at, reconciliation.id`);
    const paymentMetadataResult = await transaction.request().input('studentId', sql.Int, studentId).input('isStudent', sql.Bit, access === 'student')
      .query(`SELECT payment.id AS payment_id, payment.payment_date, CAST(payment.amount AS CHAR(40)) AS amount,
          payment.reference_no, payment.receipt_issued, payment.is_reversed,
          CAST(COALESCE(credit.available_credit, 0) AS CHAR(40)) AS current_available_credit,
          CASE WHEN @isStudent = 1 THEN NULL ELSE payment.transmittal_reference END AS transmittal_reference,
          CASE WHEN @isStudent = 1 THEN NULL ELSE payment.private_remarks END AS private_remarks
        FROM finance_payments AS payment
        LEFT JOIN v_finance_payment_credit AS credit ON credit.payment_id = payment.id
        WHERE payment.student_id = @studentId ORDER BY payment.payment_date, payment.id`);
    const legacyCreditsResult = await transaction.request().input('studentId', sql.Int, studentId).input('isStudent', sql.Bit, access === 'student').query(`SELECT transaction_record.id AS transaction_id,
        transaction_record.reference_no, transaction_record.created_at,
        CAST(transaction_record.amount - COALESCE(reconciliation.amount, 0) AS CHAR(40)) AS available_amount,
        CASE WHEN @isStudent = 1 THEN NULL ELSE transaction_record.description END AS description
      FROM financial_transactions AS transaction_record
      INNER JOIN financial_accounts AS account ON account.id = transaction_record.financial_account_id
      LEFT JOIN (SELECT transaction_id, SUM(net_amount) AS amount
        FROM v_finance_net_legacy_reconciliations GROUP BY transaction_id) AS reconciliation
        ON reconciliation.transaction_id = transaction_record.id
      WHERE account.student_id = @studentId AND transaction_record.is_legacy_unattributed = 1 AND transaction_record.transaction_type = 'payment'
        AND transaction_record.amount > COALESCE(reconciliation.amount, 0)
        AND NOT EXISTS (SELECT 1 FROM finance_legacy_opening_charges AS opening WHERE opening.financial_account_id = account.id)
      ORDER BY transaction_record.created_at, transaction_record.id`);
    const privateClearanceResult = access === 'student' ? { recordset: [] } : await transaction.request().input('studentId', sql.Int, studentId).query(`SELECT event.id,
        event.enrollment_id, event.event_type, event.reason, event.arrangement, event.finance_note, event.outstanding_snapshot,
        event.created_at, event.recorded_by
      FROM term_clearance_events AS event
      INNER JOIN enrollments AS enrollment ON enrollment.id = event.enrollment_id
      INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
      WHERE annual.student_id = @studentId ORDER BY event.created_at, event.id`);
    const adjustmentsResult = await transaction.request().input('studentId', sql.Int, studentId).input('isStudent', sql.Bit, access === 'student').query(`SELECT adjustment.id AS adjustment_id,
        adjustment.charge_id, CAST(adjustment.amount AS CHAR(40)) AS amount,
        CASE WHEN @isStudent = 1 THEN 'Finance adjustment' ELSE adjustment.reason END AS reason,
        adjustment.reverses_adjustment_id, adjustment.created_at,
        CASE WHEN adjustment.reverses_adjustment_id IS NULL AND EXISTS(
          SELECT 1 FROM finance_charge_adjustments AS reversal WHERE reversal.reverses_adjustment_id = adjustment.id)
          THEN CAST(1 AS UNSIGNED) ELSE CAST(0 AS UNSIGNED) END AS already_reversed,
        annual.school_year, enrollment.annual_term_number, charge.line_name, charge.installment
      FROM finance_charge_adjustments AS adjustment
      INNER JOIN v_finance_effective_assessed_charges AS charge ON charge.id = adjustment.charge_id
      INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
      INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
      WHERE annual.student_id = @studentId ORDER BY adjustment.created_at, adjustment.id`);
    const handbookNumberResult = access === 'student' ? { recordset: [] } : await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT annual.id AS annual_enrollment_id, annual.school_year, annual.finance_handbook_number
        FROM annual_enrollments AS annual
        WHERE annual.student_id = @studentId AND annual.intake_status <> 'legacy'
        ORDER BY annual.school_year DESC, annual.id DESC`);
    const handbookHistoryResult = access === 'student' ? { recordset: [] } : await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT history.id, history.annual_enrollment_id, history.before_value, history.after_value, history.created_at,
          actor.first_name AS actor_first_name, actor.last_name AS actor_last_name
        FROM finance_handbook_number_events AS history
        INNER JOIN annual_enrollments AS annual ON annual.id = history.annual_enrollment_id
        LEFT JOIN staff_profiles AS actor ON actor.user_id = history.actor_id
        WHERE annual.student_id = @studentId ORDER BY history.created_at DESC, history.id DESC`);
    const feeCommentResult = access === 'student' ? { recordset: [] } : await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT event.id, event.charge_id, event.comment, event.created_at,
          COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(actor.first_name, ' ', actor.last_name))), ''), CONCAT('Staff ', event.actor_id)) AS actor_name
        FROM finance_fee_comment_events AS event
        INNER JOIN v_finance_effective_assessed_charges AS charge ON charge.id = event.charge_id
        INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
        LEFT JOIN staff_profiles AS actor ON actor.user_id = event.actor_id
        WHERE annual.student_id = @studentId ORDER BY event.created_at DESC, event.id DESC`);
    const student = studentResult.recordset?.[0];
    if (!student) throw new AnnualFinanceError('Student record not found.', 404);
    const summary = summaryResult.recordset?.[0] || {};
    const legacyCents = parseMoneyCents(String(summary.unattributed_legacy_balance || '0.00'), { allowNegative: true, allowZero: true });
    const openingDueCents = parseMoneyCents(String(summary.opening_liability_due || '0.00'), { allowNegative: true, allowZero: true });
    const chargesCents = parseMoneyCents(String(summary.assessed_charges || '0.00'), { allowZero: true });
    const adjustmentsCents = parseMoneyCents(String(summary.adjustments || '0.00'), { allowNegative: true, allowZero: true });
    const paymentsCents = parseMoneyCents(String(summary.annual_payments || '0.00'), { allowZero: true });
    const legacyReconciledCents = parseMoneyCents(String(summary.legacy_reconciled_amount || '0.00'), { allowZero: true });
    const financeClassificationByEnrollmentId = new Map((financeClassificationsResult.recordset || [])
      .map((classification) => [Number(classification.enrollment_id), classification]));
    const termRows = (termsResult.recordset || []).map((term) => {
      const restatement = restatementsByAnnual.get(Number(term.annual_enrollment_id));
      if (access === 'student') return { ...term, ...(restatement ? { restatement } : {}) };
      const classification = financeClassificationByEnrollmentId.get(Number(term.enrollment_id));
      return {
        ...term,
        ...(restatement ? { restatement } : {}),
        paymentClassification: classification ? {
          assessment_id: classification.assessment_id,
          registrar_confirmation_id: classification.registrar_confirmation_id,
          assessed_charge_count: classification.assessed_charge_count,
          tuition_line_count: classification.tuition_line_count,
          canonical_tuition_count: classification.canonical_tuition_count,
          dp_count: classification.dp_count,
          prelim_count: classification.prelim_count,
          midterm_count: classification.midterm_count,
          finals_count: classification.finals_count,
          whole_tracking_available: classification.whole_tracking_available,
          installment_tracking_available: classification.installment_tracking_available,
          whole_status: classification.whole_status,
          dp_status: classification.dp_status,
          prelim_status: classification.prelim_status,
          midterm_status: classification.midterm_status,
          finals_status: classification.finals_status
        } : null
      };
    });
    const currentTermContext = currentTermContextResult.recordset?.[0] || null;
    const charges = (chargesResult.recordset || []).map((charge) => ({
      ...charge,
      ...(restatementsByAnnual.has(Number(charge.annual_enrollment_id))
        ? { restatement: restatementsByAnnual.get(Number(charge.annual_enrollment_id)) } : {}),
      purpose_label: formatFeePurpose(charge),
      remaining_amount: formatMoneyCents(parseMoneyCents(String(charge.remaining_due || '0.00'), { allowNegative: true, allowZero: true }))
    }));
    const waivedCents = charges.reduce((sum, charge) => sum + parseMoneyCents(String(charge.waived_amount || '0.00'), { allowZero: true }), 0n);
    const termBalances = termRows.map((term) => ({ ...term, outstandingCents: parseMoneyCents(String(term.outstanding || '0.00'), { allowNegative: true, allowZero: true }) }));
    const currentTermOutstanding = termBalances.filter((term) => flag(term.is_current) && term.outstandingCents > 0n).reduce((sum, term) => sum + term.outstandingCents, 0n);
    const currentSchoolYearStart = schoolYearStartYear(currentTermContext?.school_year);
    const currentTermNumber = Number(currentTermContext?.current_term_number);
    const priorDebt = currentTermContext
      ? termBalances.filter((term) => {
        if (term.outstandingCents <= 0n) return false;
        const placementYearStart = schoolYearStartYear(term.school_year);
        if (placementYearStart === null || currentSchoolYearStart === null) return false;
        if (placementYearStart < currentSchoolYearStart) return true;
        if (placementYearStart > currentSchoolYearStart || currentTermNumber === null) return false;
        const placementTermNumber = Number(term.annual_term_number);
        return Number.isInteger(placementTermNumber) && placementTermNumber < currentTermNumber;
      }).reduce((sum, term) => sum + term.outstandingCents, 0n)
      : 0n;
    const annualByYear = new Map();
    for (const charge of charges) {
      const year = String(charge.school_year);
      const priorAmount = annualByYear.get(year) || 0n;
      annualByYear.set(year, priorAmount
        + parseMoneyCents(String(charge.amount || '0.00'), { allowZero: true })
        + parseMoneyCents(String(charge.adjustments || '0.00'), { allowNegative: true, allowZero: true })
        - parseMoneyCents(String(charge.allocated || '0.00'), { allowZero: true }));
    }
    const allYearsAnnualBalanceCents = [...annualByYear.values()].reduce((sum, amount) => sum + amount, 0n);
    const annualBalanceSchoolYear = [...annualByYear.keys()].sort().at(-1) || null;
    const annualBalanceCents = annualBalanceSchoolYear ? annualByYear.get(annualBalanceSchoolYear) : 0n;
    const totalBalanceCents = legacyCents + openingDueCents + allYearsAnnualBalanceCents;
    const allocationHistory = annotateRestatementSyntheticPlacementAllocations(
      annotateRestatementSourceAllocations(allocationHistoryResult.recordset || [], sourceAllocationPurposeById),
      syntheticPlacementPurposeById
    );
    const paymentPurposeHistory = buildPaymentPurposeHistory({
      payments: paymentMetadataResult.recordset || [],
      allocations: allocationHistory,
      legacyReconciliations: legacyReconciliationHistoryResult.recordset || [],
      events: eventsResult.recordset || []
    });
    return {
      student,
      summary: {
        unattributedLegacyBalance: formatMoneyCents(legacyCents),
        openingLiabilityDue: formatMoneyCents(openingDueCents),
        annualAssessedCharges: formatMoneyCents(chargesCents),
        annualWaivedAmount: formatMoneyCents(waivedCents),
        annualAdjustments: formatMoneyCents(adjustmentsCents),
        annualPayments: formatMoneyCents(paymentsCents),
        reconciledLegacyCredits: formatMoneyCents(legacyReconciledCents),
        annualBalanceSchoolYear,
        annualBalance: formatMoneyCents(annualBalanceCents),
        allYearsAnnualBalance: formatMoneyCents(allYearsAnnualBalanceCents),
        totalBalance: formatMoneyCents(totalBalanceCents),
        currentTermOutstanding: formatMoneyCents(currentTermOutstanding),
        priorTermYearDebt: formatMoneyCents(priorDebt),
        availableCredit: String(summary.available_credit || '0.00')
      },
      charges,
      restatements: [...restatementsByAnnual.entries()].map(([annualEnrollmentId, restatement]) => ({ annualEnrollmentId, ...restatement })),
      events: eventsResult.recordset || [],
      terms: termBalances,
      availablePayments: paymentOptionsResult.recordset || [],
      openingLiabilities: openingLiabilitiesResult.recordset || [],
      paymentPurposeHistory,
      allocationHistory: access === 'student' ? [] : allocationHistory,
      legacyReconciliationHistory: access === 'student' ? [] : legacyReconciliationHistoryResult.recordset || [],
      payments: access === 'student' ? [] : paymentMetadataResult.recordset || [],
      legacyCredits: legacyCreditsResult.recordset || [],
      privateClearances: privateClearanceResult.recordset || [],
      adjustments: adjustmentsResult.recordset || [],
      financeHandbookNumbers: handbookNumberResult.recordset || [],
      financeHandbookHistory: handbookHistoryResult.recordset || [],
      feeComments: feeCommentResult.recordset || []
    };
    });
  }

  async function getAnnualPaymentConfirmation(actorInput, studentInput, paymentInput, access = 'finance') {
    const studentId = id(studentInput, 'student');
    const paymentId = bigId(paymentInput, 'payment');
    return runTransaction(async (transaction) => {
      if (access === 'student') {
        const owner = await transaction.request().input('actorId', sql.Int, id(actorInput, 'user')).input('studentId', sql.Int, studentId)
          .query(`SELECT student.id FROM students AS student INNER JOIN users AS account ON account.id = student.user_id
            WHERE student.id = @studentId AND account.id = @actorId AND account.is_active = 1 AND account.role = 'student' FOR UPDATE`);
        if (!owner.recordset?.length) throw new AnnualFinanceError('This payment confirmation is not available to your account.', 403);
      } else await requireFinanceActor(transaction.request(), actorInput);
      const paymentResult = await transaction.request().input('studentId', sql.Int, studentId).input('paymentId', sql.BigInt, paymentId)
        .query(`SELECT payment.id AS payment_id, payment.payment_date, CAST(payment.amount AS CHAR(40)) AS amount,
            payment.reference_no, payment.receipt_issued, payment.is_reversed,
            CAST(COALESCE(credit.available_credit, 0) AS CHAR(40)) AS current_available_credit, student.id AS student_id,
            student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix
          FROM finance_payments AS payment INNER JOIN students AS student ON student.id = payment.student_id
          LEFT JOIN v_finance_payment_credit AS credit ON credit.payment_id = payment.id
          WHERE payment.student_id = @studentId AND payment.id = @paymentId`);
      const payment = paymentResult.recordset?.[0];
      if (!payment) throw new AnnualFinanceError('Payment not found for this student.', 404);
      const allocationResult = await transaction.request().input('paymentId', sql.BigInt, paymentId)
        .query(`SELECT allocation.id AS allocation_id, allocation.charge_id, allocation.legacy_opening_charge_id,
            allocation.synthetic_restatement_operation_id, allocation.synthetic_restatement_kind,
            CASE
              WHEN allocation.synthetic_restatement_kind = 'placement' AND net.is_effective = 1
                THEN 'Synthetic tuition installment placement'
              WHEN allocation.synthetic_restatement_kind = 'placement' AND EXISTS (
                SELECT 1 FROM finance_assessment_restatement_events AS reversed
                WHERE reversed.operation_id = allocation.synthetic_restatement_operation_id AND reversed.event_type = 'reversed')
                THEN 'Historical synthetic tuition installment placement; restatement reversed'
              WHEN allocation.synthetic_restatement_kind = 'placement'
                THEN 'Inactive synthetic tuition installment placement; no active apply event'
              WHEN allocation.synthetic_restatement_kind = 'restoration' AND net.is_effective = 1
                THEN 'Restored original tuition application'
              WHEN allocation.synthetic_restatement_kind = 'restoration'
                THEN 'Inactive original tuition application restoration'
              ELSE NULL
            END AS restatement_history_label,
            CAST(allocation.amount AS CHAR(40)) AS original_amount,
            CAST(CASE WHEN payment.is_reversed = 1 THEN 0 ELSE COALESCE(net.net_amount, 0) END AS CHAR(40)) AS current_net_amount,
            CAST(COALESCE(net.active_released_amount, 0) AS CHAR(40)) AS released_amount,
            CAST(COALESCE(release_history.recorded_released_amount, 0) AS CHAR(40)) AS recorded_released_amount,
            release_history.source_restatement_operation_id,
            annual.school_year, annual.grade_level, enrollment.annual_term_number,
            charge.line_name, charge.fee_category, charge.installment, opening.source_label,
            CAST(COALESCE(charge_due.amount_due, opening_due.amount_due) AS CHAR(40)) AS current_due_amount
          FROM finance_payment_allocations AS allocation
          INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
          INNER JOIN v_finance_net_payment_allocations AS net ON net.allocation_id = allocation.id
          LEFT JOIN assessed_charges AS charge ON charge.id = allocation.charge_id
          LEFT JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
          LEFT JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
          LEFT JOIN finance_legacy_opening_charges AS opening ON opening.id = allocation.legacy_opening_charge_id
          LEFT JOIN v_finance_assessed_charge_due AS charge_due ON charge_due.charge_id = allocation.charge_id
          LEFT JOIN v_finance_opening_liability_due AS opening_due ON opening_due.opening_charge_id = opening.id
          LEFT JOIN (
            SELECT release_row.allocation_id,
              SUM(release_row.amount) AS recorded_released_amount,
              MAX(CASE WHEN release_row.synthetic_restatement_operation_id IS NOT NULL
                THEN release_row.synthetic_restatement_operation_id END) AS source_restatement_operation_id
            FROM finance_payment_allocation_releases AS release_row
            GROUP BY release_row.allocation_id
          ) AS release_history ON release_history.allocation_id = allocation.id
          WHERE allocation.payment_id = @paymentId
          ORDER BY allocation.id`);
      const allocations = allocationResult.recordset || [];
      const sourceOperationIds = [...new Set(allocations
        .flatMap((allocation) => [allocation.source_restatement_operation_id, allocation.synthetic_restatement_operation_id])
        .map((operationId) => String(operationId || '').trim())
        .filter(Boolean))];
      let sourcePurposeByAllocationId = new Map();
      let syntheticPlacementPurposeById = new Map();
      if (sourceOperationIds.length) {
        const archiveRequest = transaction.request().input('studentId', sql.Int, studentId);
        const operationParams = sourceOperationIds.map((operationId, index) => {
          const name = `sourceOperationId${index}`;
          archiveRequest.input(name, sql.Char(36), operationId);
          return `@${name}`;
        }).join(', ');
        const archiveResult = await archiveRequest.query(`SELECT archive.operation_id, archive.annual_enrollment_id,
            annual.school_year, annual.grade_level,
            archive.before_image_json, archive.before_image_sha256,
            archive.applied_image_json, archive.applied_image_sha256,
            applied.id AS applied_event_id,
            reversed.id AS reversed_event_id
          FROM finance_assessment_restatement_annuals AS archive
          INNER JOIN annual_enrollments AS annual ON annual.id = archive.annual_enrollment_id
          LEFT JOIN finance_assessment_restatement_events AS applied
            ON applied.operation_id = archive.operation_id AND applied.event_type = 'applied'
          LEFT JOIN finance_assessment_restatement_events AS reversed
            ON reversed.operation_id = archive.operation_id AND reversed.event_type = 'reversed'
          WHERE annual.student_id = @studentId AND archive.operation_id IN (${operationParams})`);
        sourcePurposeByAllocationId = buildRestatementSourceAllocationPurposeMap(archiveResult.recordset || []);
        syntheticPlacementPurposeById = buildRestatementSyntheticPlacementPurposeMap(archiveResult.recordset || []);
      }
      const annotatedAllocations = annotateRestatementSyntheticPlacementAllocations(
        annotateRestatementSourceAllocations(allocations, sourcePurposeByAllocationId),
        syntheticPlacementPurposeById
      );
      return { payment, allocations: annotatedAllocations.map((allocation) => ({
        ...allocation,
        target_label: allocation.original_purpose_label || (allocation.charge_id != null ? formatFeePurpose(allocation) : formatAllocationPurpose(allocation))
      })) };
    });
  }

  async function getLegacyPaymentConfirmation(actorInput, studentInput, transactionInput, access = 'finance') {
    const studentId = id(studentInput, 'student');
    const transactionId = id(transactionInput, 'legacy payment');
    return runTransaction(async (transaction) => {
      if (access === 'student') {
        const owner = await transaction.request().input('actorId', sql.Int, id(actorInput, 'user')).input('studentId', sql.Int, studentId)
          .query(`SELECT student.id FROM students AS student INNER JOIN users AS account ON account.id = student.user_id
            WHERE student.id = @studentId AND account.id = @actorId AND account.is_active = 1 AND account.role = 'student' FOR UPDATE`);
        if (!owner.recordset?.length) throw new AnnualFinanceError('This payment confirmation is not available to your account.', 403);
      } else await requireFinanceActor(transaction.request(), actorInput);
      const paymentResult = await transaction.request().input('studentId', sql.Int, studentId).input('transactionId', sql.Int, transactionId)
        .query(`SELECT legacy.id AS transaction_id, legacy.created_at, CAST(legacy.amount AS CHAR(40)) AS amount,
            legacy.reference_no, legacy.transaction_type, student.id AS student_id,
            student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix
          FROM financial_transactions AS legacy INNER JOIN financial_accounts AS account ON account.id = legacy.financial_account_id
          INNER JOIN students AS student ON student.id = account.student_id
          WHERE account.student_id = @studentId AND legacy.id = @transactionId AND legacy.transaction_type = 'payment'`);
      const payment = paymentResult.recordset?.[0];
      if (!payment) throw new AnnualFinanceError('Legacy payment not found for this student.', 404);
      const allocationsResult = await transaction.request().input('transactionId', sql.Int, transactionId)
        .query(`SELECT reconciliation.id AS allocation_id, reconciliation.charge_id,
            CAST(reconciliation.amount AS CHAR(40)) AS original_amount,
            CAST(COALESCE(net.net_amount, 0) AS CHAR(40)) AS current_net_amount,
            CAST(reconciliation.amount - COALESCE(net.net_amount, 0) AS CHAR(40)) AS released_amount,
            annual.school_year, annual.grade_level, enrollment.annual_term_number,
            charge.line_name, charge.fee_category, charge.installment,
            CAST(due.amount_due AS CHAR(40)) AS current_due_amount
          FROM finance_legacy_reconciliations AS reconciliation
          LEFT JOIN v_finance_net_legacy_reconciliations AS net ON net.reconciliation_id = reconciliation.id
        INNER JOIN v_finance_effective_assessed_charges AS charge ON charge.id = reconciliation.charge_id
          INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id
          INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
          LEFT JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
          WHERE reconciliation.transaction_id = @transactionId ORDER BY reconciliation.id`);
      return { payment, allocations: (allocationsResult.recordset || []).map((allocation) => ({
        ...allocation, target_label: formatFeePurpose(allocation)
      })) };
    });
  }

  async function listRoster(actorInput, filters = {}) {
    const searchTerm = normalizeAnnualSearchTerm(filters.search || '');
    const schoolYear = filters.schoolYear ? cleanText(filters.schoolYear, 'School year', 20) : null;
    const gradeLevel = filters.gradeLevel ? cleanText(filters.gradeLevel, 'Grade level', 50) : null;
    const voucherCode = filters.voucherCode ? cleanText(filters.voucherCode, 'Voucher', 10) : null;
    if (voucherCode && !['PUB', 'ESC', 'NV'].includes(voucherCode)) throw new AnnualFinanceError('Choose PUB, ESC, or NV.');
    const termId = filters.termId ? id(filters.termId, 'term') : null;
    const sectionId = filters.sectionId ? id(filters.sectionId, 'section') : null;
    const cluster = filters.cluster ? cleanText(filters.cluster, 'Cluster', 100) : null;
    const strand = filters.strand ? cleanText(filters.strand, 'Strand', 100) : null;
    const status = filters.status ? cleanText(filters.status, 'Placement status', 30) : null;
    if (status && !['pending_payment', 'enrolled', 'cancelled', 'dropped', 'transferred'].includes(status)) {
      throw new AnnualFinanceError('Choose a valid term placement status.');
    }
    const financeStatus = filters.financeStatus ? cleanText(filters.financeStatus, 'Finance status', 30) : null;
    if (financeStatus && !Object.values(FINANCE_STATUS).includes(financeStatus)) throw new AnnualFinanceError('Choose a valid finance status.');
    const installment = filters.installment ? cleanText(filters.installment, 'Tuition tracking', 20).toLowerCase() : 'whole';
    if (!TRACKING_MODES.includes(installment)) throw new AnnualFinanceError('Choose whole-term or a canonical tuition installment.');
    const statusColumn = `${installment}_status`;
    const pool = await getPool();
    await requireFinanceActor(pool.request(), actorInput);
    const request = pool.request()
      .input('searchPattern', sql.NVarChar(204), searchTerm ? `%${searchTerm.replace(/[~%_[\]]/g, (character) => `~${character}`)}%` : null)
      .input('schoolYear', sql.NVarChar(20), schoolYear)
      .input('gradeLevel', sql.NVarChar(50), gradeLevel)
      .input('voucherCode', sql.NVarChar(10), voucherCode)
      .input('termId', sql.Int, termId)
      .input('sectionId', sql.Int, sectionId)
      .input('cluster', sql.NVarChar(100), cluster)
      .input('strand', sql.NVarChar(100), strand)
      .input('placementStatus', sql.NVarChar(30), status);
    const [result, filterOptions] = await Promise.all([request.query(`SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.school_year, annual.grade_level,
          annual.voucher_code, annual.voucher_category, annual.intake_status, student.student_no, student.lrn,
          student.first_name, student.middle_name, student.last_name, student.suffix,
          enrollment.id AS enrollment_id, enrollment.annual_term_number, enrollment.enrollment_status, enrollment.term_scope_status,
          term.id AS term_id, term.term, section.id AS section_id, section.name AS section_name, section.cluster, section.strand,
          section.adviser, section.modality, section.modular_subtype,
          confirmation.id AS registrar_confirmation_id,
          assessment.voucher_code_snapshot AS assessed_voucher_code, assessment.schedule_version AS assessed_schedule_version,
          CASE WHEN voucher_event.event_type = 'voucher_review_flagged' THEN CAST(1 AS UNSIGNED) ELSE CAST(0 AS UNSIGNED) END AS voucher_review_required,
          voucher_event.reason AS voucher_review_reason, clearance.event_type AS signed_clearance_status,
          CAST(COALESCE(annual_due.amount_due, 0) AS CHAR(40)) AS annual_balance,
          CAST(COALESCE(term_due.amount_due, 0) AS CHAR(40)) AS current_term_due,
          CAST(COALESCE(legacy_balance.remaining_legacy_balance, 0) AS CHAR(40)) AS unattributed_legacy_balance,
          CAST(COALESCE(opening_due.amount_due, 0) AS CHAR(40)) AS opening_liability_due
        FROM annual_enrollments AS annual
        INNER JOIN students AS student ON student.id = annual.student_id
        LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
        LEFT JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = annual.id
        LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
        LEFT JOIN (SELECT charge.annual_enrollment_id, SUM(due.amount_due) AS amount_due
        FROM v_finance_effective_assessed_charges AS charge INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
          GROUP BY charge.annual_enrollment_id) AS annual_due ON annual_due.annual_enrollment_id = annual.id
        LEFT JOIN (SELECT charge.enrollment_id, SUM(due.amount_due) AS amount_due
          FROM v_finance_effective_assessed_charges AS charge INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
          GROUP BY charge.enrollment_id) AS term_due ON term_due.enrollment_id = enrollment.id
        LEFT JOIN v_finance_legacy_account_balance AS legacy_balance ON legacy_balance.student_id = annual.student_id
        LEFT JOIN (SELECT due.student_id, SUM(due.amount_due) AS amount_due
          FROM v_finance_opening_liability_due AS due GROUP BY due.student_id) AS opening_due
          ON opening_due.student_id = annual.student_id
        LEFT JOIN (SELECT annual_event.annual_enrollment_id, annual_event.event_type, annual_event.reason
          FROM (SELECT annual_enrollment_id, event_type, reason,
              ROW_NUMBER() OVER (PARTITION BY annual_enrollment_id ORDER BY created_at DESC, id DESC) AS event_rank
            FROM annual_enrollment_events
            WHERE event_type IN ('voucher_review_flagged', 'voucher_review_resolved')) AS annual_event
          WHERE annual_event.event_rank = 1) AS voucher_event ON voucher_event.annual_enrollment_id = annual.id
        LEFT JOIN (SELECT clearance_event.enrollment_id, clearance_event.event_type
          FROM (SELECT enrollment_id, event_type,
              ROW_NUMBER() OVER (PARTITION BY enrollment_id ORDER BY created_at DESC, id DESC) AS event_rank
            FROM term_clearance_events) AS clearance_event
          WHERE clearance_event.event_rank = 1) AS clearance ON clearance.enrollment_id = enrollment.id
        WHERE annual.intake_status <> 'legacy'
          AND (@searchPattern IS NULL OR student.student_no LIKE @searchPattern ESCAPE '~'
            OR student.lrn LIKE @searchPattern ESCAPE '~'
            OR CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) LIKE @searchPattern ESCAPE '~')
          AND (@schoolYear IS NULL OR annual.school_year = @schoolYear)
          AND (@gradeLevel IS NULL OR annual.grade_level = @gradeLevel)
          AND (@voucherCode IS NULL OR annual.voucher_code = @voucherCode)
          AND (@termId IS NULL OR term.id = @termId)
          AND (@sectionId IS NULL OR section.id = @sectionId)
          AND (@cluster IS NULL OR section.cluster = @cluster)
          AND (@strand IS NULL OR section.strand = @strand)
          AND (@placementStatus IS NULL OR enrollment.enrollment_status = @placementStatus)
        ORDER BY annual.school_year DESC, student.last_name, student.first_name, annual.id, enrollment.annual_term_number`),
      Promise.all([
        pool.request().query(`SELECT DISTINCT school_year FROM annual_enrollments WHERE intake_status <> 'legacy' ORDER BY school_year DESC`),
        pool.request().query(`SELECT DISTINCT term.id AS term_id, CONCAT(term.school_year, ' · ', term.term) AS term_label
          FROM academic_terms AS term INNER JOIN enrollments AS enrollment ON enrollment.academic_term_id = term.id
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          WHERE annual.intake_status <> 'legacy' ORDER BY term.id`),
        pool.request().query(`SELECT DISTINCT section.id AS section_id, section.name AS section_name, section.cluster, section.strand
          FROM sections AS section INNER JOIN enrollments AS enrollment ON enrollment.section_id = section.id
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          WHERE annual.intake_status <> 'legacy' ORDER BY section.name, section.id`)
      ])
    ]);
    const optionRows = filterOptions.map((result) => result.recordset || []);
    return {
      searchTerm,
      rows: result.recordset || [],
      options: {
        schoolYears: (optionRows[0] || []).map((row) => row.school_year),
        terms: (optionRows[1] || []).map((row) => ({ id: row.term_id, label: row.term_label })),
        sections: (optionRows[2] || []).map((row) => ({ id: row.section_id, label: row.section_name, cluster: row.cluster, strand: row.strand }))
      }
    };
  }

  async function listRosterPage(actorInput, filters = {}) {
    const searchTerm = normalizeAnnualSearchTerm(filters.search || '');
    const schoolYear = filters.schoolYear ? cleanText(filters.schoolYear, 'School year', 20) : null;
    const gradeLevel = filters.gradeLevel ? cleanText(filters.gradeLevel, 'Grade level', 50) : null;
    const voucherCode = filters.voucherCode ? cleanText(filters.voucherCode, 'Voucher', 10) : null;
    if (voucherCode && !['PUB', 'ESC', 'NV'].includes(voucherCode)) throw new AnnualFinanceError('Choose PUB, ESC, or NV.');
    const termId = filters.termId ? id(filters.termId, 'term') : null;
    const sectionId = filters.sectionId ? id(filters.sectionId, 'section') : null;
    const cluster = filters.cluster ? cleanText(filters.cluster, 'Cluster', 100) : null;
    const strand = filters.strand ? cleanText(filters.strand, 'Strand', 100) : null;
    const status = filters.status ? cleanText(filters.status, 'Placement status', 30) : null;
    if (status && !['pending_payment', 'enrolled', 'cancelled', 'dropped', 'transferred'].includes(status)) {
      throw new AnnualFinanceError('Choose a valid term placement status.');
    }
    const financeStatus = filters.financeStatus ? cleanText(filters.financeStatus, 'Finance status', 30) : null;
    if (financeStatus && !Object.values(FINANCE_STATUS).includes(financeStatus)) throw new AnnualFinanceError('Choose a valid finance status.');
    const installment = filters.installment ? cleanText(filters.installment, 'Tuition tracking', 20).toLowerCase() : 'whole';
    if (!TRACKING_MODES.includes(installment)) throw new AnnualFinanceError('Choose whole-term or a canonical tuition installment.');
    const statusColumn = `${installment}_status`;
    const availabilityColumn = installment === 'whole' ? 'whole_tracking_available' : 'installment_tracking_available';
    const amountColumns = installment === 'whole'
      ? { required: 'required_amount', applied: 'applied_amount', due: 'amount_due' }
      : { required: `${installment}_required`, applied: `${installment}_applied`, due: `${installment}_due` };
    const pageSize = 20;
    const requestedPage = typeof filters.page === 'string' && /^\d{1,12}$/.test(filters.page)
      && Number.isSafeInteger(Number(filters.page)) && Number(filters.page) > 0
      ? Number(filters.page)
      : 1;
    const pool = transaction ? null : await getPool();

    return withRosterReadSnapshot(pool, async (snapshot) => {
      const request = () => snapshot.request();
      await requireFinanceActorForRoster(request(), actorInput);

      const matchingFrom = `FROM annual_enrollments AS annual
        INNER JOIN students AS student ON student.id = annual.student_id
        LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
        LEFT JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id`;
      const matchingWhere = `annual.intake_status <> 'legacy'
          AND (@searchPattern IS NULL OR student.student_no LIKE @searchPattern ESCAPE '~'
            OR student.lrn LIKE @searchPattern ESCAPE '~'
            OR CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) LIKE @searchPattern ESCAPE '~')
          AND (@schoolYear IS NULL OR annual.school_year = @schoolYear)
          AND (@gradeLevel IS NULL OR annual.grade_level = @gradeLevel)
          AND (@voucherCode IS NULL OR annual.voucher_code = @voucherCode)
          AND (@termId IS NULL OR term.id = @termId)
          AND (@sectionId IS NULL OR section.id = @sectionId)
          AND (@cluster IS NULL OR section.cluster = @cluster)
          AND (@strand IS NULL OR section.strand = @strand)
          AND (@placementStatus IS NULL OR enrollment.enrollment_status = @placementStatus)`;
      const matchingFromWhere = matchingFrom + '\nWHERE ' + matchingWhere;

      function bindRosterFilters(targetRequest) {
        return targetRequest
          .input('searchPattern', sql.NVarChar(204), searchTerm ? `%${searchTerm.replace(/[~%_[\]]/g, (character) => `~${character}`)}%` : null)
          .input('schoolYear', sql.NVarChar(20), schoolYear)
          .input('gradeLevel', sql.NVarChar(50), gradeLevel)
          .input('voucherCode', sql.NVarChar(10), voucherCode)
          .input('termId', sql.Int, termId)
          .input('sectionId', sql.Int, sectionId)
          .input('cluster', sql.NVarChar(100), cluster)
          .input('strand', sql.NVarChar(100), strand)
          .input('placementStatus', sql.NVarChar(30), status)
          .input('financeStatus', sql.NVarChar(30), financeStatus);
      }

      function bindAnnualIds(targetRequest, annualIds, prefix) {
        return annualIds.map((annualId, index) => {
          const name = `${prefix}${index}`;
          targetRequest.input(name, sql.Int, annualId);
          return `@${name}`;
        });
      }

      function formatMoneyTotals(recordset, keyField, valueField) {
        const totals = new Map();
        for (const row of recordset || []) {
          const key = Number(row[keyField]);
          if (!Number.isSafeInteger(key) || key <= 0) continue;
          const cents = parseMoneyCents(String(row[valueField] ?? '0.00'), { allowNegative: true, allowZero: true });
          totals.set(key, (totals.get(key) || 0n) + cents);
        }
        return new Map([...totals].map(([key, cents]) => [key, formatMoneyCents(cents)]));
      }

      let totalRecords = 0;
      let matchingFinanceAnnualIds = null;
      if (financeStatus) {
        const statusFilters = `(@schoolYear IS NULL OR classification.school_year = @schoolYear)
          AND (@gradeLevel IS NULL OR classification.grade_level = @gradeLevel)
          AND (@voucherCode IS NULL OR classification.voucher_code = @voucherCode)
          AND (@termId IS NULL OR classification.academic_term_id = @termId)
          AND (@sectionId IS NULL OR classification.section_id = @sectionId)
          AND (@cluster IS NULL OR section.cluster = @cluster)
          AND (@strand IS NULL OR section.strand = @strand)
          AND (@placementStatus IS NULL OR classification.enrollment_status = @placementStatus)
          AND classification.term_scope_status = 'applicable'
          AND classification.enrollment_status IN ('enrolled', 'pending_payment')
          AND classification.intake_status NOT IN ('legacy', 'cancelled', 'dropped', 'transferred')
          AND classification.student_status = 'active'
          AND classification.${statusColumn} = @financeStatus
          AND (@searchPattern IS NULL OR student.student_no LIKE @searchPattern ESCAPE '~'
            OR student.lrn LIKE @searchPattern ESCAPE '~'
            OR CONCAT_WS(' ', student.first_name, NULLIF(student.middle_name, ''), student.last_name, NULLIF(student.suffix, '')) LIKE @searchPattern ESCAPE '~')`;
        const statusCount = await runFinanceRosterQuery(bindRosterFilters(request()), 'status_count', `SET STATEMENT optimizer_switch='derived_merge=off,condition_pushdown_for_derived=off' FOR
          WITH ${FINANCE_TERM_CLASSIFICATION_CTES}
          SELECT COUNT(*) AS total_records
          FROM FinanceTermClassification AS classification
          INNER JOIN students AS student ON student.id = classification.student_id
          LEFT JOIN sections AS section ON section.id = classification.section_id
            AND section.academic_term_id = classification.academic_term_id
          WHERE ${statusFilters}`);
        totalRecords = Math.max(0, Number(statusCount.recordset?.[0]?.total_records || 0));
        const effectivePage = Math.min(requestedPage, Math.max(1, Math.ceil(totalRecords / pageSize)));
        const statusPageRequest = bindRosterFilters(request())
          .input('offset', sql.Int, (effectivePage - 1) * pageSize)
          .input('pageSize', sql.Int, pageSize);
        const statusPage = await runFinanceRosterQuery(statusPageRequest, 'status_page', `SET STATEMENT optimizer_switch='derived_merge=off,condition_pushdown_for_derived=off' FOR
          WITH ${FINANCE_TERM_CLASSIFICATION_CTES}
          SELECT classification.annual_enrollment_id, classification.school_year,
            student.last_name, student.first_name
          FROM FinanceTermClassification AS classification
          INNER JOIN students AS student ON student.id = classification.student_id
          LEFT JOIN sections AS section ON section.id = classification.section_id
            AND section.academic_term_id = classification.academic_term_id
          WHERE ${statusFilters}
          ORDER BY classification.school_year DESC, student.last_name, student.first_name,
            classification.annual_enrollment_id
          LIMIT @pageSize OFFSET @offset`);
        matchingFinanceAnnualIds = [...new Set((statusPage.recordset || [])
          .map((row) => Number(row.annual_enrollment_id))
          .filter((annualId) => Number.isSafeInteger(annualId) && annualId > 0))];
      } else {
        const countResult = await runFinanceRosterQuery(bindRosterFilters(request()), 'count',
          'SELECT COUNT(DISTINCT annual.id) AS total_records ' + matchingFromWhere);
        totalRecords = Math.max(0, Number(countResult.recordset?.[0]?.total_records || 0));
      }

      const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
      const page = Math.min(requestedPage, totalPages);
      const offset = (page - 1) * pageSize;
      if (!financeStatus) {
        const pageIdRequest = bindRosterFilters(request())
          .input('offset', sql.Int, offset)
          .input('pageSize', sql.Int, pageSize);
        const pageIds = await runFinanceRosterQuery(pageIdRequest, 'page_ids', `SELECT DISTINCT annual.id AS annual_enrollment_id,
            annual.school_year, student.last_name, student.first_name
          ${matchingFromWhere}
          ORDER BY annual.school_year DESC, student.last_name, student.first_name, annual.id
          LIMIT @pageSize OFFSET @offset`);
        matchingFinanceAnnualIds = [...new Set((pageIds.recordset || [])
          .map((row) => Number(row.annual_enrollment_id))
          .filter((annualId) => Number.isSafeInteger(annualId) && annualId > 0))];
      }

      const annualIds = matchingFinanceAnnualIds || [];
      const annualRows = new Map();
      const financeClassificationByEnrollmentId = new Map();
      const annualBalanceById = new Map();
      const termDueByEnrollmentId = new Map();
      const legacyBalanceByStudentId = new Map();
      const openingDueByStudentId = new Map();
      let pageDataRows = [];
      if (annualIds.length) {
        const pageDataRequest = bindRosterFilters(request());
        const pageIdPlaceholders = bindAnnualIds(pageDataRequest, annualIds, 'pageAnnualId');
        const pageDataRowsResult = await runFinanceRosterQuery(pageDataRequest, 'page_data', `SELECT annual.id AS annual_enrollment_id,
            annual.student_id, annual.school_year, annual.grade_level,
            annual.voucher_code, annual.voucher_category, annual.intake_status, student.student_no, student.lrn,
            student.first_name, student.middle_name, student.last_name, student.suffix,
            enrollment.id AS enrollment_id, enrollment.annual_term_number,
            enrollment.enrollment_status, enrollment.term_scope_status,
            term.id AS term_id, term.term, section.id AS section_id, section.name AS section_name,
            section.cluster, section.strand, section.adviser, section.modality, section.modular_subtype,
            confirmation.id AS registrar_confirmation_id,
            assessment.voucher_code_snapshot AS assessed_voucher_code,
            assessment.schedule_version AS assessed_schedule_version,
            CASE WHEN voucher_event.event_type = 'voucher_review_flagged'
              THEN CAST(1 AS UNSIGNED) ELSE CAST(0 AS UNSIGNED) END AS voucher_review_required,
            voucher_event.reason AS voucher_review_reason,
            clearance.event_type AS signed_clearance_status
          FROM annual_enrollments AS annual
          INNER JOIN students AS student ON student.id = annual.student_id
          LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
          LEFT JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
          LEFT JOIN sections AS section ON section.id = enrollment.section_id
            AND section.academic_term_id = enrollment.academic_term_id
          LEFT JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = annual.id
          LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
          LEFT JOIN (SELECT annual_event.annual_enrollment_id, annual_event.event_type, annual_event.reason
            FROM (SELECT annual_enrollment_id, event_type, reason,
                ROW_NUMBER() OVER (PARTITION BY annual_enrollment_id ORDER BY created_at DESC, id DESC) AS event_rank
              FROM annual_enrollment_events
              WHERE event_type IN ('voucher_review_flagged', 'voucher_review_resolved')) AS annual_event
            WHERE annual_event.event_rank = 1) AS voucher_event ON voucher_event.annual_enrollment_id = annual.id
          LEFT JOIN (SELECT clearance_event.enrollment_id, clearance_event.event_type
            FROM (SELECT enrollment_id, event_type,
                ROW_NUMBER() OVER (PARTITION BY enrollment_id ORDER BY created_at DESC, id DESC) AS event_rank
              FROM term_clearance_events) AS clearance_event
            WHERE clearance_event.event_rank = 1) AS clearance ON clearance.enrollment_id = enrollment.id
          WHERE ${matchingWhere} AND annual.id IN (${pageIdPlaceholders.join(', ')})
          ORDER BY annual.school_year DESC, student.last_name, student.first_name,
            annual.id, enrollment.annual_term_number`);
        pageDataRows = pageDataRowsResult.recordset || [];

        const classificationRequest = request();
        const classificationIds = bindAnnualIds(classificationRequest, annualIds, 'classificationAnnualId');
        const classifications = await runFinanceRosterQuery(classificationRequest, 'classification', `SET STATEMENT optimizer_switch='derived_merge=off,condition_pushdown_for_derived=off' FOR
          WITH ${FINANCE_TERM_CLASSIFICATION_CTES}
          SELECT classification.*,
            CAST(classification.${amountColumns.required} AS CHAR(40)) AS classified_required,
            CAST(classification.${amountColumns.applied} AS CHAR(40)) AS classified_applied,
            CAST(classification.${amountColumns.due} AS CHAR(40)) AS classified_due
          FROM FinanceTermClassification AS classification
          WHERE classification.annual_enrollment_id IN (${classificationIds.join(', ')})`);
        for (const row of classifications.recordset || []) {
          financeClassificationByEnrollmentId.set(Number(row.enrollment_id), row);
        }

        // These annual IDs already reflect the school-year roster filter; sum every term in each selected annual.
        const annualBalanceRequest = request();
        const annualBalanceIds = bindAnnualIds(annualBalanceRequest, annualIds, 'assessedAnnualId');
        const assessedCharges = await runFinanceRosterQuery(annualBalanceRequest, 'assessed_charge_balances', `SELECT charge.annual_enrollment_id,
            charge.enrollment_id, CAST(due.amount_due AS CHAR(40)) AS amount_due
          FROM v_finance_effective_assessed_charges AS charge
          INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
          WHERE charge.annual_enrollment_id IN (${annualBalanceIds.join(', ')})`);
        for (const row of assessedCharges.recordset || []) {
          const annualId = Number(row.annual_enrollment_id);
          const enrollmentId = Number(row.enrollment_id);
          const cents = parseMoneyCents(String(row.amount_due ?? '0.00'), { allowNegative: true, allowZero: true });
          if (Number.isSafeInteger(annualId) && annualId > 0) {
            annualBalanceById.set(annualId, (annualBalanceById.get(annualId) || 0n) + cents);
          }
          if (Number.isSafeInteger(enrollmentId) && enrollmentId > 0) {
            termDueByEnrollmentId.set(enrollmentId, (termDueByEnrollmentId.get(enrollmentId) || 0n) + cents);
          }
        }
        for (const [annualId, cents] of annualBalanceById) annualBalanceById.set(annualId, formatMoneyCents(cents));
        for (const [enrollmentId, cents] of termDueByEnrollmentId) termDueByEnrollmentId.set(enrollmentId, formatMoneyCents(cents));

        const studentIds = [...new Set(pageDataRows.map((row) => Number(row.student_id))
          .filter((studentId) => Number.isSafeInteger(studentId) && studentId > 0))];
        if (studentIds.length) {
          const legacyRequest = request();
          const legacyIds = bindAnnualIds(legacyRequest, studentIds, 'legacyStudentId');
          const legacyBalances = await runFinanceRosterQuery(legacyRequest, 'legacy_account_balances', `SELECT student_id,
              CAST(remaining_legacy_balance AS CHAR(40)) AS remaining_legacy_balance
            FROM v_finance_legacy_account_balance
            WHERE student_id IN (${legacyIds.join(', ')})`);
          const legacyTotals = formatMoneyTotals(legacyBalances.recordset, 'student_id', 'remaining_legacy_balance');
          for (const [studentId, value] of legacyTotals) legacyBalanceByStudentId.set(studentId, value);

          const openingRequest = request();
          const openingIds = bindAnnualIds(openingRequest, studentIds, 'openingStudentId');
          const openingLiabilities = await runFinanceRosterQuery(openingRequest, 'opening_liability_balances', `SELECT student_id,
              CAST(amount_due AS CHAR(40)) AS amount_due
            FROM v_finance_opening_liability_due
            WHERE student_id IN (${openingIds.join(', ')})`);
          const openingTotals = formatMoneyTotals(openingLiabilities.recordset, 'student_id', 'amount_due');
          for (const [studentId, value] of openingTotals) openingDueByStudentId.set(studentId, value);
        }
      }

      for (const row of pageDataRows) {
        const annualId = Number(row.annual_enrollment_id);
        const studentId = Number(row.student_id);
        let annual = annualRows.get(annualId);
        if (!annual) {
          annual = {
            annual_enrollment_id: row.annual_enrollment_id,
            student_id: row.student_id,
            school_year: row.school_year,
            grade_level: row.grade_level,
            voucher_code: row.voucher_code,
            voucher_category: row.voucher_category,
            intake_status: row.intake_status,
            student_no: row.student_no,
            lrn: row.lrn,
            first_name: row.first_name,
            middle_name: row.middle_name,
            last_name: row.last_name,
            suffix: row.suffix,
            registrar_confirmation_id: row.registrar_confirmation_id,
            assessed_voucher_code: row.assessed_voucher_code,
            assessed_schedule_version: row.assessed_schedule_version,
            voucher_review_required: row.voucher_review_required,
            voucher_review_reason: row.voucher_review_reason,
            annual_balance: annualBalanceById.get(annualId) || '0.00',
            unattributed_legacy_balance: legacyBalanceByStudentId.get(studentId) || '0.00',
            opening_liability_due: openingDueByStudentId.get(studentId) || '0.00',
            placements: []
          };
          annualRows.set(annualId, annual);
        }
        if (row.enrollment_id != null) {
          const classified = financeClassificationByEnrollmentId.get(Number(row.enrollment_id)) || null;
          annual.placements.push({
            enrollment_id: row.enrollment_id,
            annual_term_number: row.annual_term_number,
            enrollment_status: row.enrollment_status,
            term_scope_status: row.term_scope_status,
            term_id: row.term_id,
            term: row.term,
            section_id: row.section_id,
            section_name: row.section_name,
            cluster: row.cluster,
            strand: row.strand,
            adviser: row.adviser,
            modality: row.modality,
            modular_subtype: row.modular_subtype,
            finance_status: classified?.[statusColumn] ?? null,
            classified_required: classified?.[amountColumns.required] ?? classified?.classified_required ?? null,
            classified_applied: classified?.[amountColumns.applied] ?? classified?.classified_applied ?? null,
            classified_due: classified?.[amountColumns.due] ?? classified?.classified_due ?? null,
            tracking_available: classified?.[availabilityColumn] ?? null,
            current_term_due: termDueByEnrollmentId.get(Number(row.enrollment_id)) || '0.00',
            registrar_confirmation_id: row.registrar_confirmation_id,
            matching_assessment_confirmation_id: classified?.registrar_confirmation_id,
            assessment_id: classified?.assessment_id,
            assessed_charge_count: classified?.assessed_charge_count,
            tuition_line_count: classified?.tuition_line_count,
            canonical_tuition_count: classified?.canonical_tuition_count,
            dp_count: classified?.dp_count,
            prelim_count: classified?.prelim_count,
            midterm_count: classified?.midterm_count,
            finals_count: classified?.finals_count,
            whole_tracking_available: classified?.whole_tracking_available,
            installment_tracking_available: classified?.installment_tracking_available,
            signed_clearance_status: row.signed_clearance_status
          });
        }
      }

      const optionQueries = [
        ['options_year', `SELECT DISTINCT school_year
          FROM annual_enrollments
          WHERE intake_status <> 'legacy'
          ORDER BY school_year DESC`],
        ['options_term', `SELECT DISTINCT term.id AS term_id, CONCAT(term.school_year, ' · ', term.term) AS term_label
          FROM academic_terms AS term INNER JOIN enrollments AS enrollment ON enrollment.academic_term_id = term.id
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          WHERE annual.intake_status <> 'legacy' ORDER BY term.id`],
        ['options_section', `SELECT DISTINCT section.id AS section_id, section.name AS section_name, section.cluster, section.strand
          FROM sections AS section INNER JOIN enrollments AS enrollment ON enrollment.section_id = section.id
          INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
          WHERE annual.intake_status <> 'legacy' ORDER BY section.name, section.id`]
      ];
      const filterOptions = [];
      for (const [phase, statement] of optionQueries) {
        filterOptions.push(await runFinanceRosterQuery(request(), phase, statement));
      }
      const optionRows = filterOptions.map((result) => result.recordset || []);
      const rows = [...annualRows.values()];
      return {
        searchTerm,
        rows,
        options: {
          schoolYears: (optionRows[0] || []).map((row) => row.school_year),
          terms: (optionRows[1] || []).map((row) => ({ id: row.term_id, label: row.term_label })),
          sections: (optionRows[2] || []).map((row) => ({ id: row.section_id, label: row.section_name, cluster: row.cluster, strand: row.strand }))
        },
        pagination: {
          page,
          pageSize,
          totalRecords,
          totalPages,
          from: rows.length ? offset + 1 : 0,
          to: rows.length ? offset + rows.length : 0
        }
      };
    });
  }

  return {
    listSchedules, createSchedule, annualAssessmentPreview,
    annualConfirmationAssessmentSnapshotForStaff, getAnnualEntryFinanceReadinessForRegistrar,
    assertAnnualEntryDownPaymentReadyInTransaction,
    confirmAnnualAssessment, confirmAnnualAssessmentInTransaction, addSupplementaryCharge,
    recordPayment, updatePaymentMetadata, previewLegacyOpeningLiability, transferLegacyOpeningLiability,
    allocateExistingCredit, releasePaymentAllocation, releaseLegacyReconciliation,
    recordChargeAdjustment, reverseAdjustment,
    updateFinanceHandbookNumber, addFeeComment,
    reversePayment, reconcileLegacyPayment, approveTerm, signTermClearance,
    resolveVoucherReview, getStudentLedger, getAnnualPaymentConfirmation, getLegacyPaymentConfirmation, listRoster, listRosterPage
  };
}

module.exports = {
  AnnualFinanceError,
  FINANCE_ROSTER_QUERY_PHASES,
  TUITION_INSTALLMENTS,
  STUDENT_LEDGER_SUMMARY_SQL,
  createAnnualFinanceService,
  normalizeLineRows,
  tuitionInstallmentBreakdown,
  normalizeAllocations,
  parsePaymentDate,
  cleanText,
  canonicalAssessmentSnapshot,
  applyExemptionPreview,
  assessmentTermTotals,
  tuitionTermTotals,
  nonTuitionTermTotals,
  classifyEntryDownPaymentBalances
};
