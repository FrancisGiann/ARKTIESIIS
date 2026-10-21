'use strict';

const crypto = require('node:crypto');

const MANIFEST_KIND_ORDER = Object.freeze([
  'annual-and-confirmation',
  'expected-expansion-charge',
  'cohort-student-payment',
  'missing-expected-expansion-payment',
  'cohort-payment-allocation',
  'configured-target-v2-line'
]);
const INSTALLMENT_ORDER = Object.freeze(['DP', 'Prelim', 'Midterm', 'Finals']);
const EXPECTED_COUNTS = Object.freeze({
  'annual-and-confirmation': 79,
  'expected-expansion-charge': 474,
  'cohort-student-payment': 28,
  'missing-expected-expansion-payment': 27,
  'cohort-payment-allocation': 29,
  'configured-target-v2-line': 72
});

class RestatementManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RestatementManifestError';
  }
}

function sortedJson(value) {
  if (value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new RestatementManifestError('A snapshot date is invalid.');
    return JSON.stringify(value.toISOString());
  }
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString('base64'));
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RestatementManifestError('A snapshot number is invalid.');
  return JSON.stringify(value);
}

function manifestRowId(row) {
  return Number(row.chargeId ?? row.annualId ?? row.paymentId ?? row.allocationId ?? row.scheduleLineId ?? 0);
}

function canonicalManifestRows(rows) {
  if (!Array.isArray(rows)) throw new RestatementManifestError('The approved manifest rows are invalid.');
  const rank = new Map(MANIFEST_KIND_ORDER.map((kind, index) => [kind, index]));
  return [...rows].sort((left, right) => {
    const leftRank = rank.get(left.kind);
    const rightRank = rank.get(right.kind);
    if (leftRank === undefined || rightRank === undefined) throw new RestatementManifestError('The approved manifest contains an unknown row type.');
    return leftRank - rightRank
      || Number(left.ordinal || 0) - Number(right.ordinal || 0)
      || manifestRowId(left) - manifestRowId(right);
  }).map(sortedJson).join('\n') + '\n';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseCents(value, label = 'amount') {
  const text = typeof value === 'number' ? String(value) : String(value ?? '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) throw new RestatementManifestError(`${label} is not a non-negative cent amount.`);
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (cents > 99999999999999n) throw new RestatementManifestError(`${label} is outside the supported range.`);
  return cents;
}

function formatCents(cents) {
  if (typeof cents !== 'bigint' || cents < 0n) throw new RestatementManifestError('A cent amount is invalid.');
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

function allocateCents(amountCents, lineMap, remainingByLine = new Map()) {
  if (typeof amountCents !== 'bigint' || amountCents < 0n) throw new RestatementManifestError('An allocation amount is invalid.');
  let remainingAmount = amountCents;
  const placements = [];
  for (const installment of INSTALLMENT_ORDER) {
    if (remainingAmount === 0n) break;
    const line = lineMap.get(installment);
    if (!line) throw new RestatementManifestError('A configured tuition installment is missing.');
    const lineId = Number(line.scheduleLineId);
    const available = remainingByLine.has(lineId) ? remainingByLine.get(lineId) : parseCents(line.amount);
    if (available < 0n) throw new RestatementManifestError('A tuition line capacity is invalid.');
    if (available === 0n) continue;
    const placed = remainingAmount < available ? remainingAmount : available;
    placements.push({ line, amount: placed });
    remainingAmount -= placed;
    remainingByLine.set(lineId, available - placed);
  }
  if (remainingAmount !== 0n) throw new RestatementManifestError('A payment cannot be allocated entirely within configured tuition lines.');
  return placements;
}

function groupRows(rows) {
  const groups = new Map(MANIFEST_KIND_ORDER.map((kind) => [kind, []]));
  for (const row of rows) {
    if (!groups.has(row.kind)) throw new RestatementManifestError('The approved manifest contains an unknown row type.');
    groups.get(row.kind).push(row);
  }
  return groups;
}

function uniqueIds(rows, property, label) {
  const values = rows.map((row) => Number(row[property]));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1) || new Set(values).size !== values.length) {
    throw new RestatementManifestError(`The approved manifest has invalid or repeated ${label} identifiers.`);
  }
}

function validateFixedManifest(manifest, expectedSha256) {
  if (!manifest || manifest.readOnly !== true || manifest.rollbackObserved !== true || !Array.isArray(manifest.rows)) {
    throw new RestatementManifestError('The saved manifest is not a completed read-only transaction.');
  }
  return validateManifestRows(manifest.rows, expectedSha256);
}

function validateManifestRows(rows, expectedSha256) {
  const digest = sha256(canonicalManifestRows(rows));
  if (digest !== expectedSha256) throw new RestatementManifestError('The approved fixed-cohort manifest digest does not match.');
  const groups = groupRows(rows);
  for (const [kind, count] of Object.entries(EXPECTED_COUNTS)) {
    if (groups.get(kind).length !== count) throw new RestatementManifestError(`The fixed cohort has an unexpected ${kind} row count.`);
  }

  const annuals = groups.get('annual-and-confirmation');
  uniqueIds(annuals, 'annualId', 'annual');
  uniqueIds(annuals, 'assessmentId', 'assessment');
  uniqueIds(annuals, 'confirmationId', 'confirmation');
  const ordinals = new Set(annuals.map(({ ordinal }) => Number(ordinal)));
  if (ordinals.size !== 79 || Array.from({ length: 79 }, (_, index) => index + 22).some((ordinal) => !ordinals.has(ordinal))) {
    throw new RestatementManifestError('The approved annual cohort is not the fixed ordinal range 22–100.');
  }
  for (const annual of annuals) {
    if (annual.actualAnnualKey !== annual.expectedAnnualKey || annual.actualAssessmentKey !== annual.expectedAssessmentKey
      || !annual.confirmationSnapshotFingerprint || Number(annual.sourceScheduleVersion) !== 1) {
      throw new RestatementManifestError('A fixed annual or original Registrar confirmation no longer matches its approved key.');
    }
  }

  const charges = groups.get('expected-expansion-charge');
  uniqueIds(charges, 'chargeId', 'charge');
  if (charges.some((charge) => charge.actualChargeKey !== charge.expectedChargeKey
    || charge.chargeAnnualId !== charge.annualId || charge.chargeAssessmentId !== charge.assessmentId
    || charge.expectedCategory !== charge.actualCategory || charge.waivedAmount !== 0 || Number(charge.isManual) !== 0)) {
    throw new RestatementManifestError('A source charge is not an exact, unwaived fixed-cohort row.');
  }
  const chargeKinds = charges.reduce((counts, row) => {
    const key = `${row.term}:${row.expectedCategory}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
  for (let term = 1; term <= 3; term += 1) {
    if (chargeKinds.get(`${term}:tuition`) !== 79 || chargeKinds.get(`${term}:miscellaneous`) !== 79) {
      throw new RestatementManifestError('The approved source charge composition has drifted.');
    }
  }

  const payments = groups.get('cohort-student-payment');
  uniqueIds(payments, 'paymentId', 'payment');
  if (payments.some((row) => !row.actualPaymentKey || Number(row.isReversed) !== 0
    || (row.expectedExpansionPaymentKey && row.actualPaymentKey !== row.expectedExpansionPaymentKey)
    || (!row.expectedExpansionPaymentKey && Number(row.paymentId) !== 29))) {
    throw new RestatementManifestError('A fixed-cohort payment is missing or reversed.');
  }
  const expectedPayments = groups.get('missing-expected-expansion-payment');
  if (expectedPayments.some((row) => !row.expectedPaymentKey || !row.expectedAllocationBatchKey || !row.paymentId)) {
    throw new RestatementManifestError('An expected fixed-cohort payment key was not found.');
  }
  const allocations = groups.get('cohort-payment-allocation');
  uniqueIds(allocations, 'allocationId', 'allocation');
  const tuitionAllocations = allocations.filter((row) => row.targetCategory === 'tuition');
  const miscellaneousAllocations = allocations.filter((row) => row.targetCategory === 'miscellaneous');
  if (tuitionAllocations.length !== 28 || miscellaneousAllocations.length !== 1
    || tuitionAllocations.some((row) => Number(row.effectiveNetApplied) !== Number(row.allocationAmount)
      || Number(row.releasedAmount) !== 0 || Number(row.paymentReversed) !== 0
      || row.legacyOpeningChargeId != null || Number(row.targetChargeAnnualId) !== Number(row.annualId)
      || Number(row.targetTerm) < 1 || Number(row.targetTerm) > 3)
    || miscellaneousAllocations[0].allocationId !== 29 || Number(miscellaneousAllocations[0].allocationAmount) !== 50) {
    throw new RestatementManifestError('The approved allocation split or same-term source state has drifted.');
  }
  const later = payments.find((row) => Number(row.paymentId) === 29);
  const laterTuition = tuitionAllocations.find((row) => Number(row.allocationId) === 28);
  if (!later || Number(later.amount) !== 1000 || later.paymentDate !== '2026-10-08' || !later.receiptPresent
    || !laterTuition || Number(laterTuition.paymentId) !== 29 || Number(laterTuition.allocationAmount) !== 950
    || Number(laterTuition.chargeId) !== 1) {
    throw new RestatementManifestError('The separately approved later-payment lineage has changed.');
  }

  const lines = groups.get('configured-target-v2-line');
  uniqueIds(lines, 'scheduleLineId', 'target schedule-line');
  if (lines.some((line) => line.category !== 'tuition' || Number(line.optional) !== 0
    || Number(line.scheduleVersion) !== 2 || line.scheduleStatus !== 'active'
    || line.schoolYear !== '2026-2027' || !INSTALLMENT_ORDER.includes(line.installment))) {
    throw new RestatementManifestError('A configured target tuition line is not an approved active v2 line.');
  }
  return { digest, groups, lines };
}

function uuidBytes(uuid) {
  if (typeof uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new RestatementManifestError('A valid operation UUID is required.');
  }
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function uuidV5(namespace, name) {
  const digest = crypto.createHash('sha1').update(Buffer.concat([uuidBytes(namespace), Buffer.from(String(name), 'utf8')])).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildChargePlan(validatedManifest, operationId) {
  const { groups } = validatedManifest;
  const annualById = new Map(groups.get('annual-and-confirmation').map((row) => [Number(row.annualId), row]));
  const scheduleByContext = new Map();
  for (const line of groups.get('configured-target-v2-line')) {
    const key = `${line.grade}|${line.voucher}|${line.scheduleId}|${line.term}`;
    if (!scheduleByContext.has(key)) scheduleByContext.set(key, []);
    scheduleByContext.get(key).push(line);
  }
  const sources = [];
  const generated = [];
  const sourceTuitionTotals = new Map();
  for (const row of groups.get('expected-expansion-charge')) {
    if (row.expectedCategory !== 'tuition') continue;
    const annual = annualById.get(Number(row.annualId));
    if (!annual) throw new RestatementManifestError('A tuition charge is outside the approved annual set.');
    const key = `${annual.annualGrade}|${annual.annualVoucher}|${scheduleForAnnual(groups.get('configured-target-v2-line'), annual)}|${row.term}`;
    const targetLines = scheduleByContext.get(key) || [];
    const byInstallment = new Map(targetLines.map((line) => [line.installment, line]));
    if (targetLines.length !== 4 || INSTALLMENT_ORDER.some((installment) => !byInstallment.has(installment))) {
      throw new RestatementManifestError('A fixed annual does not have four exact configured tuition installments for its term.');
    }
    sources.push({ annualId: Number(row.annualId), assessmentId: Number(row.assessmentId), chargeId: Number(row.chargeId), term: Number(row.term) });
    const totalKey = `${row.annualId}|${row.term}`;
    sourceTuitionTotals.set(totalKey, (sourceTuitionTotals.get(totalKey) || 0n) + parseCents(row.amount, 'source tuition charge'));
    for (const installment of INSTALLMENT_ORDER) {
      const line = byInstallment.get(installment);
      generated.push({ annualId: Number(row.annualId), assessmentId: Number(row.assessmentId), sourceChargeId: Number(row.chargeId), term: Number(row.term), line,
        idempotencyKey: uuidV5(operationId, `charge:${row.chargeId}:${line.scheduleLineId}`) });
    }
  }
  if (sources.length !== 237 || generated.length !== 948) throw new RestatementManifestError('The fixed tuition charge plan is incomplete.');
  for (const annual of annualById.values()) {
    const scheduleId = scheduleForAnnual(groups.get('configured-target-v2-line'), annual);
    for (let term = 1; term <= 3; term += 1) {
      const lines = scheduleByContext.get(`${annual.annualGrade}|${annual.annualVoucher}|${scheduleId}|${term}`) || [];
      const configured = lines.reduce((sum, line) => sum + parseCents(line.amount, 'configured tuition line'), 0n);
      if (configured !== sourceTuitionTotals.get(`${annual.annualId}|${term}`)) {
        throw new RestatementManifestError('A configured target tuition total differs from the original same-term tuition total.');
      }
    }
  }
  return { sources, generated };
}

function scheduleForAnnual(lines, annual) {
  const scheduleIds = [...new Set(lines.filter((line) => line.grade === annual.annualGrade && line.voucher === annual.annualVoucher)
    .map((line) => Number(line.scheduleId)))];
  if (scheduleIds.length !== 1) throw new RestatementManifestError('A fixed annual does not resolve to one exact target tuition schedule.');
  return scheduleIds[0];
}

function buildAllocationPlan(validatedManifest, operationId) {
  const { groups } = validatedManifest;
  const annualById = new Map(groups.get('annual-and-confirmation').map((row) => [Number(row.annualId), row]));
  const targetLines = new Map();
  for (const line of groups.get('configured-target-v2-line')) {
    const key = `${line.scheduleId}|${line.term}`;
    if (!targetLines.has(key)) targetLines.set(key, new Map());
    const installments = targetLines.get(key);
    if (installments.has(line.installment)) throw new RestatementManifestError('A target tuition schedule has duplicate installment lines.');
    installments.set(line.installment, line);
  }
  const remaining = new Map();
  for (const lines of targetLines.values()) {
    if (lines.size !== 4 || INSTALLMENT_ORDER.some((installment) => !lines.has(installment))) {
      throw new RestatementManifestError('A target tuition schedule term is not composed of exactly four installments.');
    }
  }
  const allocations = groups.get('cohort-payment-allocation').filter((row) => row.targetCategory === 'tuition')
    .sort((left, right) => Number(left.ordinal) - Number(right.ordinal) || Number(left.allocationId) - Number(right.allocationId));
  const placements = [];
  for (const allocation of allocations) {
    const annual = annualById.get(Number(allocation.annualId));
    if (!annual) throw new RestatementManifestError('A tuition allocation is outside the fixed annual cohort.');
    const scheduleId = scheduleForAnnual(groups.get('configured-target-v2-line'), annual);
    const lineMap = targetLines.get(`${scheduleId}|${Number(allocation.targetTerm)}`);
    if (!lineMap) throw new RestatementManifestError('A tuition allocation has no same-term target schedule.');
    const originalAmount = parseCents(allocation.effectiveNetApplied, 'allocation amount');
    const annualRemaining = new Map(INSTALLMENT_ORDER.map((installment) => {
      const line = lineMap.get(installment);
      const capacityKey = `${allocation.annualId}|${Number(line.scheduleLineId)}`;
      return [Number(line.scheduleLineId), remaining.has(capacityKey) ? remaining.get(capacityKey) : parseCents(line.amount)];
    }));
    const plannedPlacements = allocateCents(originalAmount, lineMap, annualRemaining);
    for (const planned of plannedPlacements) {
      const line = planned.line;
      const lineId = Number(line.scheduleLineId);
      placements.push({
        oldAllocationId: Number(allocation.allocationId),
        annualId: Number(allocation.annualId),
        paymentId: Number(allocation.paymentId),
        term: Number(allocation.targetTerm),
        scheduleLineId: lineId,
        installment: line.installment,
        amount: formatCents(planned.amount),
        kind: 'placement',
        idempotencyKey: uuidV5(operationId, `allocation:${allocation.allocationId}:${lineId}`)
      });
    }
    for (const [lineId, amount] of annualRemaining) remaining.set(`${allocation.annualId}|${lineId}`, amount);
  }
  if (allocations.length !== 28 || placements.length === 0) throw new RestatementManifestError('The approved tuition allocation plan is incomplete.');
  return placements;
}

module.exports = {
  EXPECTED_COUNTS,
  INSTALLMENT_ORDER,
  MANIFEST_KIND_ORDER,
  RestatementManifestError,
  allocateCents,
  buildAllocationPlan,
  buildChargePlan,
  canonicalManifestRows,
  formatCents,
  parseCents,
  sha256,
  sortedJson,
  uuidV5,
  validateManifestRows,
  validateFixedManifest
};
