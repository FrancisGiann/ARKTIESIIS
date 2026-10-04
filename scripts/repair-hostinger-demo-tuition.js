'use strict';

const { createHash } = require('node:crypto');
const { isIP } = require('node:net');
const environment = require('../src/config/environment');
const { getPool, closePool, sql } = require('../src/config/database');
const { createAnnualFinanceService, normalizeLineRows } = require('../src/services/annualFinanceService');
const { parseMoneyCents, formatMoneyCents } = require('../src/services/financeService');
const { buildExpansionPlan, HOSTINGER_SEED_MARKER, EXPANSION_MARKER, REQUIRED_VERSIONS, REQUIRED_OBJECTS, ExpansionError, requireExpectedSchema } = require('./expand-hostinger-demo');

const REPAIR_MARKER = 'hostinger-demo-tuition-split-25-v1';
const REPAIR_ACTION_MARKER = 'hostinger-demo-tuition-split-25-v1';
const APPLICATION_LOCK = 'ARKTIESIIS Hostinger demo tuition split v1';
const SCHOOL_YEAR = '2026-2027';
const INSTALLMENTS = ['DP', 'Prelim', 'Midterm', 'Finals'];
const GRADE_LEVELS = ['Grade 11', 'Grade 12'];
const VOUCHERS = ['PUB', 'ESC', 'NV'];

class TuitionRepairError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TuitionRepairError';
    this.status = status;
  }
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function repairIdempotencyKey(sourceKey) {
  const hex = createHash('sha256').update(`arktiesiis:${REPAIR_MARKER}:${sourceKey}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function splitTuitionCents(cents) {
  if (typeof cents !== 'bigint' || cents < 0n) throw new TuitionRepairError('A tuition amount is invalid.');
  const divisor = BigInt(INSTALLMENTS.length);
  const base = cents / divisor;
  const remainder = cents % divisor;
  return INSTALLMENTS.map((_, index) => base + (BigInt(index) < remainder ? 1n : 0n));
}

function serviceLinesFingerprint(lines) {
  return fingerprint({
    schoolYear: SCHOOL_YEAR,
    gradeLevel: lines.gradeLevel,
    voucherCode: lines.voucherCode,
    lines: lines.lines.map(({ termNumber, category, lineName, installment, amount, isOptional }) => ({
      termNumber, category, lineName, installment, amount, isOptional
    }))
  });
}

function buildTuitionRepairPlan() {
  const expansionPlan = buildExpansionPlan();
  const contexts = expansionPlan.schedules.map((sourceSchedule) => {
    const sourceLines = expansionPlan.scheduleLines.filter((line) => line.schedule.idempotencyKey === sourceSchedule.idempotencyKey);
    const tuitionByTerm = new Map();
    const repairedLines = [];
    for (const sourceLine of sourceLines) {
      if (sourceLine.feeCategory !== 'tuition') {
        repairedLines.push({
          termNumber: sourceLine.termNumber, feeCategory: sourceLine.feeCategory,
          lineName: sourceLine.lineName, installment: sourceLine.installment,
          amount: sourceLine.amount, isOptional: false
        });
        continue;
      }
      const totalCents = parseMoneyCents(sourceLine.amount, { allowZero: true });
      tuitionByTerm.set(sourceLine.termNumber, totalCents);
      const split = splitTuitionCents(totalCents);
      INSTALLMENTS.forEach((installment, index) => repairedLines.push({
        termNumber: sourceLine.termNumber,
        feeCategory: sourceLine.feeCategory,
        lineName: sourceLine.lineName,
        installment,
        amount: formatMoneyCents(split[index]),
        isOptional: false
      }));
    }
    const normalized = normalizeLineRows(repairedLines.map((line) => ({
      termNumber: String(line.termNumber), feeCategory: line.feeCategory, lineName: line.lineName,
      installment: line.installment, amount: line.amount, isOptional: line.isOptional
    })));
    if (normalized.length !== repairedLines.length) throw new TuitionRepairError('A planned fee schedule is invalid.');
    for (const termNumber of [1, 2, 3]) {
      const plannedTuition = repairedLines.filter((line) => line.termNumber === termNumber && line.feeCategory === 'tuition')
        .reduce((sum, line) => sum + parseMoneyCents(line.amount, { allowZero: true }), 0n);
      if (plannedTuition !== tuitionByTerm.get(termNumber)) throw new TuitionRepairError('A planned tuition split does not preserve its term total.');
    }
    const newLines = normalized.map(({ termNumber, category, lineName, installment, amount, isOptional }) => ({
      termNumber, category, lineName, installment, amount, isOptional
    }));
    return {
      schoolYear: SCHOOL_YEAR,
      gradeLevel: sourceSchedule.gradeLevel,
      voucherCode: sourceSchedule.voucherCode,
      sourceScheduleKey: sourceSchedule.idempotencyKey,
      sourceFingerprint: sourceSchedule.requestFingerprint,
      repairKey: repairIdempotencyKey(sourceSchedule.idempotencyKey),
      repairFingerprint: serviceLinesFingerprint({ gradeLevel: sourceSchedule.gradeLevel, voucherCode: sourceSchedule.voucherCode, lines: newLines }),
      sourceLines,
      lines: newLines
    };
  });
  return contexts;
}

function parseOptions(args, configuredDatabase = environment.database.database) {
  if (!Array.isArray(args)) throw new TuitionRepairError('Repair arguments are invalid.');
  const options = { mode: null, targetDatabase: null, confirmDatabase: null, seedMarker: null, expansionMarker: null, repairMarker: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (options.mode) throw new TuitionRepairError('Choose exactly one mode: --dry-run or --apply.');
      options.mode = argument.slice(2);
    } else if (['--target-database', '--confirm-database', '--confirm-seed-marker', '--confirm-expansion-marker', '--confirm-repair-marker'].includes(argument)) {
      if (seen.has(argument) || !args[index + 1] || args[index + 1].startsWith('--')) throw new TuitionRepairError(`Provide one value for ${argument}.`);
      if (argument === '--target-database') options.targetDatabase = args[index + 1];
      if (argument === '--confirm-database') options.confirmDatabase = args[index + 1];
      if (argument === '--confirm-seed-marker') options.seedMarker = args[index + 1];
      if (argument === '--confirm-expansion-marker') options.expansionMarker = args[index + 1];
      if (argument === '--confirm-repair-marker') options.repairMarker = args[index + 1];
      seen.add(argument);
      index += 1;
    } else {
      throw new TuitionRepairError('Repair arguments are invalid.');
    }
  }
  if (!options.mode || !options.targetDatabase || !options.confirmDatabase || !options.seedMarker || !options.expansionMarker) {
    throw new TuitionRepairError('Provide a mode, the exact database name twice, and both Hostinger demo source markers.');
  }
  if (options.targetDatabase !== options.confirmDatabase || options.targetDatabase !== configuredDatabase) {
    throw new TuitionRepairError('Both confirmed database names must exactly match DB_NAME.');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.targetDatabase)) throw new TuitionRepairError('The target database name is invalid.');
  if (options.seedMarker !== HOSTINGER_SEED_MARKER || options.expansionMarker !== EXPANSION_MARKER) {
    throw new TuitionRepairError('Confirm the exact Hostinger demo seed and expansion markers.');
  }
  if (options.mode === 'apply' && options.repairMarker !== REPAIR_ACTION_MARKER) {
    throw new TuitionRepairError('Apply requires the exact hostinger-demo-tuition-split-25-v1 acknowledgement.');
  }
  if (options.mode === 'dry-run' && options.repairMarker) throw new TuitionRepairError('The apply acknowledgement is only valid with --apply.');
  return options;
}

function validateProductionTarget(configuration = environment) {
  if (configuration.nodeEnv !== 'production') throw new TuitionRepairError('The Hostinger tuition repair requires NODE_ENV=production.');
  if (configuration.devPasswordOnlyLogin) throw new TuitionRepairError('The development password-only login must remain disabled.');
  const database = configuration.database || {};
  const host = String(database.host || '').trim().toLowerCase();
  const addressType = isIP(host);
  if (!host || host === 'localhost' || host === '::1' || (addressType === 4 && /^127\./.test(host))) {
    throw new TuitionRepairError('The repair requires the remote MariaDB host from hPanel.');
  }
  if (!database.database || !database.user || String(database.user).toLowerCase() === 'root' || !database.password) {
    throw new TuitionRepairError('DB_NAME, DB_USER, and DB_PASSWORD must identify the existing hPanel database.');
  }
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

async function readRows(connection, statement, values = []) {
  const [rows] = await connection.execute(statement, values);
  return rows;
}

async function requireSourceMarkers(connection) {
  const rows = await readRows(connection,
    `SELECT marker.entity_type, marker.entity_id, marker.action, marker.details_json, actor.role
      FROM audit_logs AS marker
      INNER JOIN users AS actor ON actor.id = marker.user_id
      WHERE (marker.entity_type = ? AND marker.entity_id = ?)
        OR (marker.entity_type = ? AND marker.entity_id = ?)
      ORDER BY marker.entity_type`,
    ['school_demo_seed', HOSTINGER_SEED_MARKER, 'school_demo_expansion', EXPANSION_MARKER]);
  const seedRows = rows.filter((row) => row.entity_type === 'school_demo_seed' && row.entity_id === HOSTINGER_SEED_MARKER);
  const expansionRows = rows.filter((row) => row.entity_type === 'school_demo_expansion' && row.entity_id === EXPANSION_MARKER);
  if (rows.length !== 2 || seedRows.length !== 1 || expansionRows.length !== 1 || rows.some((row) => row.role !== 'database_admin')
    || seedRows[0]?.action !== 'admin.demo_seeded'
    || expansionRows[0]?.action !== 'database_admin.demo_data_expanded') {
    throw new TuitionRepairError('The exact database-admin Hostinger seed and expansion markers were not found.');
  }
  let details;
  try { details = JSON.parse(expansionRows[0].details_json); } catch { throw new TuitionRepairError('The Hostinger expansion source record is invalid.'); }
  const counts = details?.counts || {};
  if (Number(counts.financeSchedules) !== 6 || Number(counts.financeScheduleLines) !== 36
    || Number(counts.annualAssessments) !== 79 || Number(counts.registrarConfirmations) !== 0) {
    throw new TuitionRepairError('The Hostinger expansion marker does not match the original demo schedule manifest.');
  }
}

async function findFinanceActor(connection) {
  const rows = await readRows(connection,
    `SELECT actor.id FROM staff_profiles AS profile
      INNER JOIN users AS actor ON actor.id = profile.user_id
      WHERE profile.employee_no = ? AND actor.role = 'finance' AND actor.is_active = 1`,
    ['HDMO-FIN-001']);
  if (rows.length !== 1) throw new TuitionRepairError('The original active demo finance account could not be verified.');
  return Number(rows[0].id);
}

function moneySignature(value) {
  return formatMoneyCents(parseMoneyCents(String(value), { allowZero: true }));
}

function optionalFlag(value) {
  return value === true || value === 1 || value === '1';
}

function lineSignature(line) {
  return [Number(line.termNumber ?? line.term_number), String(line.category ?? line.feeCategory ?? line.fee_category),
    String(line.lineName ?? line.line_name), String(line.installment), moneySignature(line.amount),
    Boolean(line.isOptional ?? optionalFlag(line.is_optional))];
}

function linesMatch(actualLines, expectedLines) {
  const signature = (line) => JSON.stringify(lineSignature(line));
  const actual = actualLines.map(signature).sort();
  const expected = expectedLines.map(signature).sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function scheduleContextKey(gradeLevel, voucherCode) {
  return `${gradeLevel}:${voucherCode}`;
}

async function readAnnualImpact(connection, context, sourceScheduleId) {
  const rows = await readRows(connection,
    `SELECT COUNT(*) AS annual_count,
        SUM(assessment.id IS NULL) AS unassessed_count,
        SUM(assessment.id IS NOT NULL) AS saved_assessment_count,
        SUM(assessment.id IS NOT NULL AND confirmation.id IS NULL) AS saved_unconfirmed_count,
        SUM(confirmation.id IS NOT NULL) AS confirmed_count,
        SUM(assessment.id IS NOT NULL AND assessment.schedule_id = ? AND assessment.schedule_version = 1) AS source_snapshot_count,
        SUM(assessment.id IS NOT NULL AND (assessment.schedule_id <> ? OR assessment.schedule_version <> 1)) AS other_snapshot_count
      FROM annual_enrollments AS annual
      LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
      LEFT JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = annual.id
      WHERE annual.school_year = ? AND annual.grade_level = ? AND annual.voucher_code = ?`,
    [sourceScheduleId, sourceScheduleId, context.schoolYear, context.gradeLevel, context.voucherCode]);
  const row = rows[0] || {};
  return Object.fromEntries(['annual_count', 'unassessed_count', 'saved_assessment_count', 'saved_unconfirmed_count',
    'confirmed_count', 'source_snapshot_count', 'other_snapshot_count'].map((key) => [key, Number(row[key] || 0)]));
}

async function readSourceAssessmentDigest(connection, inspectedContexts) {
  const sourceIds = inspectedContexts.map((context) => Number(context.sourceScheduleId));
  if (!sourceIds.length || sourceIds.some((scheduleId) => !Number.isSafeInteger(scheduleId) || scheduleId < 1)) {
    throw new TuitionRepairError('The source assessment scope could not be verified.');
  }
  const sourceFilter = placeholders(sourceIds.length);
  const assessments = await readRows(connection,
    `SELECT id, annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot,
        CAST(assessed_at AS CHAR(32)) AS assessed_at, selection_json, idempotency_key, request_fingerprint
      FROM annual_assessments
      WHERE schedule_id IN (${sourceFilter}) AND schedule_version = 1
      ORDER BY annual_enrollment_id, id`, sourceIds);
  const charges = await readRows(connection,
    `SELECT charge.id, charge.assessment_id, charge.annual_enrollment_id, enrollment.annual_term_number,
        charge.schedule_line_id, charge.fee_category, charge.line_name, charge.installment,
        CAST(charge.amount AS CHAR(40)) AS amount, CAST(charge.gross_amount AS CHAR(40)) AS gross_amount,
        CAST(charge.waived_amount AS CHAR(40)) AS waived_amount,
        charge.is_manual, SHA2(COALESCE(charge.reason, ''), 256) AS reason_sha256,
        charge.idempotency_key, charge.request_fingerprint, CAST(charge.created_at AS CHAR(32)) AS created_at
      FROM assessed_charges AS charge
      INNER JOIN annual_assessments AS assessment ON assessment.id = charge.assessment_id
      INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
      WHERE assessment.schedule_id IN (${sourceFilter}) AND assessment.schedule_version = 1
      ORDER BY charge.annual_enrollment_id, enrollment.annual_term_number, charge.id`, sourceIds);
  const assessmentRows = assessments.map((row) => ({
    id: Number(row.id), annualEnrollmentId: Number(row.annual_enrollment_id), scheduleId: Number(row.schedule_id),
    scheduleVersion: Number(row.schedule_version), voucherCode: String(row.voucher_code_snapshot),
    assessedAt: String(row.assessed_at), selectionJson: String(row.selection_json),
    idempotencyKey: String(row.idempotency_key), requestFingerprint: String(row.request_fingerprint)
  }));
  let grossCents = 0n;
  let amountCentsTotal = 0n;
  let waivedCents = 0n;
  const chargeRows = charges.map((row) => {
    const amountCents = parseMoneyCents(String(row.amount), { allowZero: true });
    const grossAmountCents = parseMoneyCents(String(row.gross_amount), { allowZero: true });
    const waivedAmountCents = parseMoneyCents(String(row.waived_amount || '0.00'), { allowZero: true });
    grossCents += grossAmountCents;
    amountCentsTotal += amountCents;
    waivedCents += waivedAmountCents;
    return {
      id: Number(row.id), assessmentId: Number(row.assessment_id), annualEnrollmentId: Number(row.annual_enrollment_id),
      termNumber: Number(row.annual_term_number), scheduleLineId: row.schedule_line_id == null ? null : Number(row.schedule_line_id),
      feeCategory: String(row.fee_category), lineName: String(row.line_name), installment: String(row.installment),
      amount: formatMoneyCents(amountCents), grossAmount: formatMoneyCents(grossAmountCents),
      waivedAmount: formatMoneyCents(waivedAmountCents),
      isManual: Boolean(row.is_manual), reasonSha256: String(row.reason_sha256),
      idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
      requestFingerprint: row.request_fingerprint == null ? null : String(row.request_fingerprint),
      createdAt: String(row.created_at)
    };
  });
  return {
    sourceVersion: 1,
    assessmentRows: assessmentRows.length,
    chargeRows: chargeRows.length,
    grossCharges: formatMoneyCents(grossCents),
    waivedCharges: formatMoneyCents(waivedCents),
    payableCharges: formatMoneyCents(amountCentsTotal - waivedCents),
    assessmentSnapshotSha256: fingerprint(assessmentRows),
    savedChargeRowsSha256: fingerprint(chargeRows),
    combinedSha256: fingerprint({ assessments: assessmentRows, charges: chargeRows })
  };
}

function summarizeTerms(lines) {
  return [1, 2, 3].map((termNumber) => {
    const centsByCategory = new Map();
    for (const line of lines) {
      if (Number(line.termNumber ?? line.term_number) !== termNumber) continue;
      const category = String(line.category ?? line.fee_category).toLowerCase();
      const cents = parseMoneyCents(String(line.amount), { allowZero: true });
      centsByCategory.set(category, (centsByCategory.get(category) || 0n) + cents);
    }
    const tuition = centsByCategory.get('tuition') || 0n;
    const total = [...centsByCategory.values()].reduce((sum, value) => sum + value, 0n);
    return { termNumber, tuition: formatMoneyCents(tuition), other: formatMoneyCents(total - tuition), total: formatMoneyCents(total) };
  });
}

async function inspectTarget(connection, contexts = buildTuitionRepairPlan()) {
  await requireExpectedSchema(connection);
  await requireSourceMarkers(connection);
  const financeId = await findFinanceActor(connection);
  const scheduleRows = await readRows(connection,
    `SELECT id, school_year, grade_level, voucher_code, version_no, status, idempotency_key,
        request_fingerprint, created_by
      FROM finance_schedules
      WHERE school_year = ? AND grade_level IN (?, ?) AND voucher_code IN (?, ?, ?)
      ORDER BY grade_level, voucher_code, version_no`,
    [SCHOOL_YEAR, ...GRADE_LEVELS, ...VOUCHERS]);
  const rowsByContext = new Map();
  for (const row of scheduleRows) {
    const key = scheduleContextKey(row.grade_level, row.voucher_code);
    rowsByContext.set(key, [...(rowsByContext.get(key) || []), row]);
  }
  const allScheduleIds = scheduleRows.map((row) => Number(row.id));
  const lineRows = allScheduleIds.length ? await readRows(connection,
    `SELECT schedule_id, term_number, fee_category, line_name, installment, CAST(amount AS CHAR(40)) AS amount, is_optional
      FROM finance_schedule_lines WHERE schedule_id IN (${placeholders(allScheduleIds.length)})
      ORDER BY schedule_id, term_number, id`, allScheduleIds) : [];
  const linesBySchedule = new Map();
  for (const row of lineRows) linesBySchedule.set(Number(row.schedule_id), [...(linesBySchedule.get(Number(row.schedule_id)) || []), row]);

  const result = [];
  for (const context of contexts) {
    const key = scheduleContextKey(context.gradeLevel, context.voucherCode);
    const rows = rowsByContext.get(key) || [];
    const original = rows.find((row) => row.idempotency_key === context.sourceScheduleKey);
    const repaired = rows.find((row) => row.idempotency_key === context.repairKey);
    if (!original || Number(original.version_no) !== 1 || Number(original.created_by) !== financeId
      || original.request_fingerprint !== context.sourceFingerprint
      || !linesMatch(linesBySchedule.get(Number(original.id)) || [], context.sourceLines)) {
      throw new TuitionRepairError(`The original ${context.gradeLevel} ${context.voucherCode} demo schedule failed its ownership or line check.`);
    }
    const allowedRows = repaired ? [original, repaired] : [original];
    if (rows.length !== allowedRows.length || rows.some((row) => !allowedRows.includes(row))) {
      throw new TuitionRepairError(`A newer or unowned ${context.gradeLevel} ${context.voucherCode} schedule exists; no replacement was created.`);
    }
    let state = 'original';
    if (repaired) {
      if (Number(repaired.version_no) !== 2 || Number(repaired.created_by) !== financeId
        || repaired.request_fingerprint !== context.repairFingerprint || repaired.status !== 'active'
        || original.status !== 'retired' || !linesMatch(linesBySchedule.get(Number(repaired.id)) || [], context.lines)) {
        throw new TuitionRepairError(`The ${context.gradeLevel} ${context.voucherCode} repair version changed; no replacement was created.`);
      }
      state = 'repaired';
    } else if (original.status !== 'active') {
      throw new TuitionRepairError(`The original ${context.gradeLevel} ${context.voucherCode} schedule is no longer active; no replacement was created.`);
    }
    if (rows.filter((row) => row.status === 'active').length !== 1) {
      throw new TuitionRepairError(`The ${context.gradeLevel} ${context.voucherCode} schedule has an unexpected active-version state.`);
    }
    const impact = await readAnnualImpact(connection, context, Number(original.id));
    result.push({
      schoolYear: context.schoolYear, gradeLevel: context.gradeLevel, voucherCode: context.voucherCode,
      state, sourceScheduleId: Number(original.id), sourceVersion: 1,
      activeVersion: repaired ? 2 : 1,
      termsBefore: summarizeTerms(linesBySchedule.get(Number(original.id)) || []),
      termsAfter: summarizeTerms(context.lines),
      impact
    });
  }
  return { financeId, contexts: result };
}

function sanitizedReport(mode, inspected, changedContexts = [], snapshotProof = {}) {
  return {
    mode,
    repair: 'fictional demo tuition split into 25% installments',
    contexts: inspected.contexts.map(({ schoolYear, gradeLevel, voucherCode, state, sourceVersion, activeVersion, termsBefore, termsAfter, impact }) => ({
      schoolYear, gradeLevel, voucherCode, state, sourceVersion, activeVersion, termsBefore, termsAfter,
      impact: {
        annualRecords: impact.annual_count,
        noSavedAssessment: impact.unassessed_count,
        savedAssessments: impact.saved_assessment_count,
        savedButUnconfirmed: impact.saved_unconfirmed_count,
        confirmed: impact.confirmed_count,
        immutableSourceVersion1Snapshots: impact.source_snapshot_count,
        otherVersionSnapshots: impact.other_snapshot_count
      }
    })),
    changedContexts,
    sourceVersion1SnapshotProof: snapshotProof,
    unchangedAssessmentSnapshots: true,
    optionalAndNonTuitionLinesPreserved: true,
    rounding: 'Any remainder cents go in order to Downpayment, Prelim, Midterm, then Finals.'
  };
}

async function runRepair({
  options = parseOptions(process.argv.slice(2)), configuration = environment,
  getDatabasePool = getPool, closeDatabasePool = closePool,
  createFinance = () => createAnnualFinanceService({ getPool, sql }),
  logger = console
} = {}) {
  validateProductionTarget(configuration);
  if (!options || !['apply', 'dry-run'].includes(options.mode)
    || options.targetDatabase !== configuration.database.database
    || options.confirmDatabase !== configuration.database.database
    || options.seedMarker !== HOSTINGER_SEED_MARKER || options.expansionMarker !== EXPANSION_MARKER
    || (options.mode === 'apply' && options.repairMarker !== REPAIR_ACTION_MARKER)) {
    throw new TuitionRepairError('Confirm the production demo database, both source markers, and repair acknowledgement before continuing.');
  }
  const contexts = buildTuitionRepairPlan();
  const pool = await getDatabasePool();
  let connection;
  let locked = false;
  try {
    connection = await pool.source.getConnection();
    if (options.mode === 'apply') {
      const lockRows = await readRows(connection, 'SELECT GET_LOCK(?, 15) AS acquired', [APPLICATION_LOCK]);
      if (Number(lockRows[0]?.acquired) !== 1) throw new TuitionRepairError('Could not acquire the demo tuition repair lock.', 409);
      locked = true;
    }
    const inspected = await inspectTarget(connection, contexts);
    const snapshotsBefore = await readSourceAssessmentDigest(connection, inspected.contexts);
    const changedContexts = [];
    if (options.mode === 'apply') {
      const finance = createFinance();
      for (let index = 0; index < contexts.length; index += 1) {
        const context = contexts[index];
        const state = inspected.contexts[index];
        if (state.state === 'repaired') continue;
        try {
          await finance.createSchedule(inspected.financeId, {
            schoolYear: context.schoolYear, gradeLevel: context.gradeLevel, voucherCode: context.voucherCode,
            lines: context.lines.map((line) => ({
              termNumber: String(line.termNumber), feeCategory: line.category, lineName: line.lineName,
              installment: line.installment, amount: line.amount, isOptional: line.isOptional
            })),
            idempotencyKey: context.repairKey,
            expectedPreviousSchedule: { scheduleId: state.sourceScheduleId, versionNo: state.activeVersion }
          });
        } catch (error) {
          const safeReason = error?.name === 'AnnualFinanceError' && typeof error.message === 'string'
            ? ` ${error.message}` : ' A database or audit failure rolled back this schedule transaction.';
          throw new TuitionRepairError(`Repair stopped after ${changedContexts.length} of ${contexts.length} new contexts were verified.${safeReason} Re-run --dry-run to inspect progress; a later --apply can resume only exact untouched source versions.`, 409);
        }
        const verified = await inspectTarget(connection, contexts);
        const verifiedContext = verified.contexts[index];
        if (verifiedContext.state !== 'repaired' || verifiedContext.activeVersion !== 2) {
          throw new TuitionRepairError(`Repair stopped after ${changedContexts.length} of ${contexts.length} new contexts were verified. Re-run --dry-run to inspect progress; no custom latest schedule is overwritten.` , 409);
        }
        changedContexts.push(scheduleContextKey(context.gradeLevel, context.voucherCode));
      }
    }
    const finalState = options.mode === 'apply' ? await inspectTarget(connection, contexts) : inspected;
    const snapshotsAfter = options.mode === 'apply'
      ? await readSourceAssessmentDigest(connection, finalState.contexts)
      : snapshotsBefore;
    const snapshotsUnchanged = JSON.stringify(snapshotsBefore) === JSON.stringify(snapshotsAfter);
    if (!snapshotsUnchanged) {
      throw new TuitionRepairError(`The source version 1 assessment or saved charge changed during repair after ${changedContexts.length} of 6 schedule contexts were verified. Re-run --dry-run to review progress and the current read-only snapshot digest.`, 409);
    }
    const report = sanitizedReport(options.mode, finalState, changedContexts, { before: snapshotsBefore, after: snapshotsAfter, unchanged: snapshotsUnchanged });
    if (options.mode === 'dry-run') {
      logger.log(JSON.stringify({ ...report, status: finalState.contexts.every((context) => context.state === 'repaired') ? 'already-applied' : 'preview' }, null, 2));
    } else {
      const completed = finalState.contexts.every((context) => context.state === 'repaired');
      if (!completed) throw new TuitionRepairError('The repair did not verify all six schedule contexts. Re-run --dry-run to inspect progress.', 409);
      logger.log(JSON.stringify({ ...report, status: changedContexts.length ? 'completed' : 'already-applied' }, null, 2));
    }
    return report;
  } finally {
    if (connection) {
      if (locked) await readRows(connection, 'SELECT RELEASE_LOCK(?) AS released', [APPLICATION_LOCK]).catch(() => {});
      connection.release();
    }
    await closeDatabasePool().catch(() => {});
  }
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    validateProductionTarget();
    await runRepair({ options });
  } catch (error) {
    console.error(error instanceof TuitionRepairError || error instanceof ExpansionError
      ? error.message
      : 'The Hostinger demo tuition repair failed. Verify the approved production demo configuration and MariaDB reachability.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  REPAIR_MARKER,
  SCHOOL_YEAR,
  INSTALLMENTS,
  TuitionRepairError,
  repairIdempotencyKey,
  splitTuitionCents,
  buildTuitionRepairPlan,
  parseOptions,
  validateProductionTarget,
  inspectTarget,
  runRepair
};
