'use strict';

const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const { moneyCents, moneyText } = require('../utils/financeStatementProjection');
const { FINANCE_STATUS, FINANCE_TERM_CLASSIFICATION_CTES, TRACKING_MODES } = require('./financeTermClassification');

const PAGE_SIZE = 20;
const EXPORT_BATCH_SIZE = 50;
const TUITION_INSTALLMENTS = ['dp', 'prelim', 'midterm', 'finals'];
const TUITION_INSTALLMENT_LABELS = { dp: 'DP', prelim: 'Prelim', midterm: 'Midterm', finals: 'Finals' };
const PAYMENT_STATUSES = Object.freeze({ FULL: 'Fully paid', PARTIAL: 'Partially paid', UNPAID: 'Unpaid', NONE: 'No payment required', UNAVAILABLE: 'Unavailable' });
const FINANCE_STATUS_COLUMNS = Object.freeze({ whole: 'whole_status', dp: 'dp_status', prelim: 'prelim_status', midterm: 'midterm_status', finals: 'finals_status' });

class FinanceMasterlistError extends Error {
  constructor(message, status = 400, { cause, queryPhase } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FinanceMasterlistError';
    this.status = status;
    if (cause) this.cause = cause;
    if (queryPhase) this.queryPhase = queryPhase;
  }
}

const MATCHING_ANNUALS_CTE = `MatchingAnnual AS (
  SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.school_year, annual.grade_level,
    annual.voucher_code, annual.intake_status, annual.entry_term_number,
    student.student_no, student.lrn, student.first_name, student.middle_name, student.last_name, student.suffix
  FROM annual_enrollments AS annual
  INNER JOIN students AS student ON student.id = annual.student_id
  WHERE (@schoolYear = '' OR annual.school_year = @schoolYear)
    AND (@gradeLevel = '' OR annual.grade_level = @gradeLevel)
    AND (@voucherCode = '' OR annual.voucher_code = @voucherCode)
    AND (@searchTerm = '' OR INSTR(LOWER(CONCAT_WS(' ', student.first_name, student.middle_name, student.last_name, student.suffix)), LOWER(@searchTerm)) > 0
      OR INSTR(LOWER(student.student_no), LOWER(@searchTerm)) > 0 OR INSTR(LOWER(student.lrn), LOWER(@searchTerm)) > 0)
    AND ((@termId = 0 AND @sectionMode = 'all' AND @cluster = '' AND @strand = '' AND @placementStatus = '') OR EXISTS (
      SELECT 1 FROM enrollments AS selected_enrollment
      LEFT JOIN sections AS selected_section ON selected_section.id = selected_enrollment.section_id
        AND selected_section.academic_term_id = selected_enrollment.academic_term_id
      WHERE selected_enrollment.annual_enrollment_id = annual.id
        AND selected_enrollment.annual_term_number = @placementTerm
        AND (@termId = 0 OR selected_enrollment.academic_term_id = @termId)
        AND ((@sectionMode = 'unassigned' AND selected_enrollment.section_id IS NULL)
          OR (@sectionMode = 'assigned' AND selected_enrollment.section_id = @sectionId)
          OR @sectionMode = 'all')
        AND (@cluster = '' OR selected_section.cluster = @cluster)
        AND (@strand = '' OR selected_section.strand = @strand)
        AND (@placementStatus = '' OR selected_enrollment.enrollment_status = @placementStatus)
    ))
    __FINANCE_STATUS_FILTER__
)`;

function queryString(input, field, maxLength, { allowEmpty = true } = {}) {
  const value = input?.[field];
  if (value == null || value === '') {
    if (!allowEmpty) throw new FinanceMasterlistError(`Choose a valid ${field}.`);
    return '';
  }
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new FinanceMasterlistError(`Choose a valid ${field}.`);
  }
  return value.trim();
}

function parseMasterlistFilters(input = {}) {
  const pageValue = input.page == null || input.page === '' ? '1' : input.page;
  if (typeof pageValue !== 'string' || !/^\d{1,6}$/.test(pageValue) || Number(pageValue) < 1) {
    throw new FinanceMasterlistError('Choose a valid page number.');
  }
  const placementValue = input.placementTerm == null || input.placementTerm === '' ? '' : input.placementTerm;
  if (placementValue !== '' && (typeof placementValue !== 'string' || !/^[1-3]$/.test(placementValue))) {
    throw new FinanceMasterlistError('Choose Term 1, Term 2, or Term 3.');
  }
  const voucherCode = queryString(input, 'voucherCode', 3);
  if (voucherCode && !['PUB', 'ESC', 'NV'].includes(voucherCode)) throw new FinanceMasterlistError('Choose a valid voucher type.');
  const canonicalSection = queryString(input, 'section', 10);
  const legacySection = queryString(input, 'sectionId', 10);
  if (canonicalSection && legacySection && canonicalSection !== legacySection) throw new FinanceMasterlistError('Choose one valid section.');
  const rawSection = canonicalSection || legacySection;
  if (rawSection && rawSection !== 'unassigned' && !/^\d{1,10}$/.test(rawSection)) {
    throw new FinanceMasterlistError('Choose a valid section.');
  }
  const schoolYearProvided = Object.prototype.hasOwnProperty.call(input, 'schoolYear');
  const rawSchoolYear = schoolYearProvided ? queryString(input, 'schoolYear', 20) : null;
  const termId = queryString(input, 'termId', 10);
  if (termId && (!/^\d{1,10}$/.test(termId) || Number(termId) < 1)) throw new FinanceMasterlistError('Choose a valid term.');
  const status = queryString(input, 'status', 30);
  if (status && !['pending_payment', 'enrolled', 'cancelled', 'dropped', 'transferred'].includes(status)) {
    throw new FinanceMasterlistError('Choose a valid term placement status.');
  }
  const financeStatus = queryString(input, 'financeStatus', 30);
  if (financeStatus && !Object.values(FINANCE_STATUS).includes(financeStatus)) throw new FinanceMasterlistError('Choose a valid finance status.');
  const installment = queryString(input, 'installment', 20).toLowerCase() || 'whole';
  if (!TRACKING_MODES.includes(installment)) throw new FinanceMasterlistError('Choose whole-term or a canonical tuition installment.');
  return {
    schoolYear: !schoolYearProvided ? null : (rawSchoolYear === '' ? 'all' : rawSchoolYear),
    gradeLevel: queryString(input, 'gradeLevel', 50),
    voucherCode,
    search: queryString(input, 'search', 100),
    section: rawSection,
    cluster: queryString(input, 'cluster', 100),
    strand: queryString(input, 'strand', 100),
    status,
    financeStatus,
    installment,
    termId,
    placementTerm: placementValue ? Number(placementValue) : null,
    page: Number(pageValue)
  };
}

function formatSchoolYearStart(value) {
  const match = /^(\d{4})/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function isEarlierSchoolYear(candidate, selected) {
  const candidateStart = formatSchoolYearStart(candidate);
  const selectedStart = formatSchoolYearStart(selected);
  if (candidateStart != null && selectedStart != null) return candidateStart < selectedStart;
  return String(candidate || '').localeCompare(String(selected || ''), undefined, { numeric: true, sensitivity: 'base' }) < 0;
}

function moneySum(values, selector = (value) => value) {
  return values.reduce((sum, value) => sum + moneyCents(selector(value)), 0n);
}

function truthyDb(value) { return value === true || value === 1 || value === '1'; }

function normalizedFeePart(value) { return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en'); }

function canonicalTuitionInstallment(value) {
  const normalized = normalizedFeePart(value);
  return TUITION_INSTALLMENTS.includes(normalized) ? normalized : null;
}

function feeIdentity({ fee_category: category, line_name: name, installment }) {
  return JSON.stringify([normalizedFeePart(category), normalizedFeePart(name), normalizedFeePart(installment)]);
}

function isLegacyWholeTermTuition(column) {
  return column.category === 'tuition' && normalizedFeePart(column.lineName) === 'tuition' && !column.canonicalTuition;
}

function feeColumnDescriptor(identity, sample, termNumber) {
  const category = normalizedFeePart(sample.fee_category);
  const name = String(sample.line_name || 'Unlabelled fee').trim();
  const installment = String(sample.installment || '').trim();
  const canonicalInstallment = canonicalTuitionInstallment(installment);
  const canonicalTuition = category === 'tuition' && normalizedFeePart(name) === 'tuition'
    ? canonicalInstallment : null;
  const categoryLabel = category === 'tuition' ? 'Tuition'
    : category === 'miscellaneous' ? 'Miscellaneous' : category ? category[0].toLocaleUpperCase('en') + category.slice(1) : 'Other';
  const nameLabel = category === 'tuition' && normalizedFeePart(name) === 'tuition' ? '' : name;
  const installmentLabel = canonicalInstallment ? TUITION_INSTALLMENT_LABELS[canonicalInstallment]
    : installment ? installment[0].toLocaleUpperCase('en') + installment.slice(1) : 'Whole term';
  const label = [categoryLabel, nameLabel, installmentLabel].filter(Boolean).join(' · ');
  return { key: identity, termNumber, category, lineName: name, installment, label, canonicalTuition, canonicalInstallment };
}

function tuitionSeed(termNumber, installment) {
  const sample = { fee_category: 'tuition', line_name: 'Tuition', installment: TUITION_INSTALLMENT_LABELS[installment] };
  return feeColumnDescriptor(feeIdentity(sample), sample, termNumber);
}

function feeComparator(left, right) {
  const categoryOrder = (category) => category === 'tuition' ? 0 : category === 'miscellaneous' ? 1 : 2;
  const categoryDifference = categoryOrder(left.category) - categoryOrder(right.category);
  if (categoryDifference) return categoryDifference;
  if (['tuition', 'miscellaneous'].includes(left.category) && left.category === right.category) {
    const leftRank = left.canonicalInstallment ? TUITION_INSTALLMENTS.indexOf(left.canonicalInstallment) : 99;
    const rightRank = right.canonicalInstallment ? TUITION_INSTALLMENTS.indexOf(right.canonicalInstallment) : 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }
  return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
    || left.key.localeCompare(right.key);
}

function cellDefault(status, reason = status) {
  return { configured: null, applied: null, balance: null, status, reason, applications: [] };
}

function feeStatus({ required, applied, due, configuration, assessmentId, confirmationId }) {
  if (!assessmentId) return { status: 'No assessment', reason: 'No assessment is posted for this annual enrollment.' };
  if (required != null && required < 0n) return { status: 'Review fee basis', reason: 'The saved payable basis is negative and needs Finance review.' };
  if (!confirmationId) return { status: 'Unavailable', reason: 'Registrar confirmation is not recorded for this assessment.' };
  if (required == null || due == null || applied == null) return { status: 'Unavailable', reason: 'The saved fee detail is incomplete.' };
  if (required === 0n && configuration && moneyCents(configuration.amount) === 0n) {
    return { status: 'Configured zero', reason: 'The saved schedule amount is zero.' };
  }
  if (required === 0n) return { status: PAYMENT_STATUSES.NONE, reason: 'No payment is required for this fee.' };
  if (due <= 0n) return { status: PAYMENT_STATUSES.FULL, reason: 'The saved payable amount is covered.' };
  if (applied > 0n) return { status: PAYMENT_STATUSES.PARTIAL, reason: 'Some payment remains applied to this fee.' };
  return { status: PAYMENT_STATUSES.UNPAID, reason: 'No payment is currently applied to this fee.' };
}

function buildMasterlistProjection({ annualRows = [], chargeRows = [], configuredLines = [], historyRows = [], accountRows = [] }, filters) {
  const annuals = new Map();
  for (const source of annualRows) {
    const annualId = Number(source.annual_enrollment_id);
    if (!Number.isSafeInteger(annualId) || annualId < 1) continue;
    let annual = annuals.get(annualId);
    if (!annual) {
      const studentName = [source.first_name, source.middle_name, source.last_name, source.suffix]
        .map((part) => String(part || '').trim()).filter(Boolean).join(' ');
      annual = {
        annualEnrollmentId: annualId, studentId: Number(source.student_id), studentName,
        studentNo: String(source.student_no || ''), lrn: String(source.lrn || ''),
        schoolYear: String(source.school_year || ''), gradeLevel: String(source.grade_level || ''),
        voucherCode: source.voucher_code || '', intakeStatus: source.intake_status || 'unknown',
        assessmentId: source.assessment_id == null ? null : Number(source.assessment_id),
        assessmentVersion: source.schedule_version == null ? null : Number(source.schedule_version),
        assessedVoucherCode: source.assessed_voucher_code || null,
        confirmationId: source.confirmation_id == null ? null : Number(source.confirmation_id),
        anyConfirmationId: source.any_confirmation_id == null ? null : Number(source.any_confirmation_id),
        voucherReviewRequired: truthyDb(source.voucher_review_required),
        voucherReviewReason: source.voucher_review_reason || null,
        assessmentSelectionJson: source.selection_json || '{}', terms: new Map(), charges: [], configs: new Map()
      };
      annuals.set(annualId, annual);
    }
    if (source.enrollment_id != null) {
      const termNumber = Number(source.annual_term_number);
      if (termNumber >= 1 && termNumber <= 3) annual.terms.set(termNumber, {
        enrollmentId: Number(source.enrollment_id), termNumber, termLabel: String(source.term_label || `Term ${termNumber}`),
        termId: source.term_id == null ? null : Number(source.term_id),
        sectionId: source.section_id == null ? null : Number(source.section_id),
        sectionName: source.section_name || null, sectionCluster: source.section_cluster || null,
        sectionStrand: source.section_strand || null, sectionAdviser: source.section_adviser || null,
        modality: source.modality || null, modularSubtype: source.modular_subtype || null,
        enrollmentStatus: source.enrollment_status || 'unknown', scopeStatus: source.term_scope_status || 'applicable',
        financeClearance: source.finance_clearance || null, financeClearanceDate: source.finance_clearance_date || null,
        charges: [], fees: new Map(), requiredCents: 0n, appliedCents: 0n, dueCents: 0n, status: PAYMENT_STATUSES.UNAVAILABLE
      });
    }
  }

  const sortedAnnuals = [...annuals.values()].sort((left, right) =>
    left.studentName.localeCompare(right.studentName, undefined, { sensitivity: 'base' })
      || left.studentNo.localeCompare(right.studentNo, undefined, { numeric: true, sensitivity: 'base' })
      || left.annualEnrollmentId - right.annualEnrollmentId);
  const columns = new Map([1, 2, 3].map((termNumber) => [termNumber, new Map(TUITION_INSTALLMENTS.map((installment) => {
    const descriptor = tuitionSeed(termNumber, installment);
    return [descriptor.key, descriptor];
  }))]));

  for (const source of configuredLines) {
    const annual = annuals.get(Number(source.annual_enrollment_id));
    const termNumber = Number(source.term_number);
    if (!annual || termNumber < 1 || termNumber > 3) continue;
    const identity = feeIdentity(source);
    const descriptor = columns.get(termNumber).get(identity) || feeColumnDescriptor(identity, source, termNumber);
    columns.get(termNumber).set(identity, descriptor);
    const existing = annual.configs.get(`${termNumber}|${identity}`) || {
      lineIds: new Set(), optional: false, selected: false, amountCents: null
    };
    existing.lineIds.add(Number(source.schedule_line_id));
    existing.optional ||= truthyDb(source.is_optional);
    const selection = parseSelection(annual.assessmentSelectionJson);
    existing.selected ||= !truthyDb(source.is_optional) || selection.has(Number(source.schedule_line_id));
    if (existing.amountCents == null) existing.amountCents = moneyCents(source.amount);
    annual.configs.set(`${termNumber}|${identity}`, existing);
  }

  for (const source of chargeRows) {
    const annual = annuals.get(Number(source.annual_enrollment_id));
    const termNumber = Number(source.term_number);
    if (!annual || termNumber < 1 || termNumber > 3) continue;
    const term = annual.terms.get(termNumber);
    const identity = feeIdentity(source);
    const descriptor = columns.get(termNumber).get(identity) || feeColumnDescriptor(identity, source, termNumber);
    columns.get(termNumber).set(identity, descriptor);
    const required = moneyCents(source.required_amount);
    const applied = moneyCents(source.applied_amount);
    const balance = moneyCents(source.balance_amount);
    const charge = {
      chargeId: Number(source.charge_id), termNumber, feeKey: identity, descriptor,
      grossCents: moneyCents(source.gross_amount), coverageCents: moneyCents(source.waived_amount),
      adjustmentsCents: moneyCents(source.adjustments_amount), requiredCents: required,
      appliedCents: applied, balanceCents: balance,
      isOptional: truthyDb(source.is_optional), scheduleLineId: source.schedule_line_id == null ? null : Number(source.schedule_line_id),
      applications: []
    };
    annual.charges.push(charge);
    if (term) {
      term.charges.push(charge);
      term.requiredCents += required;
      term.appliedCents += applied;
      term.dueCents += balance;
      const fee = term.fees.get(identity) || { requiredCents: 0n, appliedCents: 0n, balanceCents: 0n, grossCents: 0n, coverageCents: 0n, adjustmentsCents: 0n, charges: [] };
      fee.requiredCents += required;
      fee.appliedCents += applied;
      fee.balanceCents += balance;
      fee.grossCents += charge.grossCents;
      fee.coverageCents += charge.coverageCents;
      fee.adjustmentsCents += charge.adjustmentsCents;
      fee.charges.push(charge);
      term.fees.set(identity, fee);
    }
  }

  for (const annual of sortedAnnuals) {
    for (let termNumber = 1; termNumber <= 3; termNumber += 1) {
      if (!annual.terms.has(termNumber)) annual.terms.set(termNumber, {
        enrollmentId: null, termNumber, termLabel: `Term ${termNumber}`, sectionId: null, sectionName: null,
        enrollmentStatus: 'No placement', scopeStatus: 'not_applicable', financeClearance: null,
        charges: [], fees: new Map(), requiredCents: 0n, appliedCents: 0n, dueCents: 0n,
        status: 'Not applicable', paymentAvailability: 'not_applicable'
      });
    }
    for (let termNumber = 1; termNumber <= 3; termNumber += 1) {
      const term = annual.terms.get(termNumber);
      const termColumns = columns.get(termNumber);
      const applicable = term && term.scopeStatus !== 'not_applicable';
      const wholeTuitionKey = [...termColumns.values()].find((column) => column.category === 'tuition'
        && normalizedFeePart(column.lineName) === 'tuition' && !column.canonicalTuition)?.key;
      const hasTuitionCharge = Boolean(term && [...term.fees.keys()].some((key) => {
        const fee = term.fees.get(key);
        return fee.charges.some((charge) => charge.descriptor.category === 'tuition'
          && normalizedFeePart(charge.descriptor.lineName) === 'tuition');
      }));
      for (const column of termColumns.values()) {
        const fee = term?.fees.get(column.key);
        const config = annual.configs.get(`${termNumber}|${column.key}`);
        let cell;
        if (!applicable) {
          cell = cellDefault('Not applicable', 'This term is outside the saved annual enrollment scope.');
        } else if (fee) {
          const state = feeStatus({ required: fee.requiredCents, applied: fee.appliedCents, due: fee.balanceCents,
            configuration: config ? { amount: moneyText(config.amountCents) } : null,
            assessmentId: annual.assessmentId, confirmationId: annual.confirmationId });
          cell = {
            configured: moneyText(fee.requiredCents), gross: moneyText(fee.grossCents), coverage: moneyText(fee.coverageCents),
            adjustments: moneyText(fee.adjustmentsCents), applied: moneyText(fee.appliedCents), balance: moneyText(fee.balanceCents),
            status: state.status, reason: state.reason, applications: [], chargeIds: fee.charges.map((charge) => charge.chargeId)
          };
        } else if (annual.assessmentId && config?.optional && !config.selected) {
          cell = cellDefault('Optional not selected', 'This optional fee was not selected in the saved assessment.');
        } else if (!annual.assessmentId) {
          cell = cellDefault('No assessment', 'No assessment is posted for this annual enrollment.');
        } else if (hasTuitionCharge && column.category === 'tuition' && column.canonicalTuition) {
          cell = cellDefault('Installment detail missing', 'The saved assessment has tuition rows but this installment has no saved charge detail.');
        } else if (!config) {
          cell = cellDefault('Not applicable', 'This fee is not configured for the saved assessment schedule.');
        } else {
          cell = cellDefault('Missing assessment detail', annual.confirmationId
            ? 'The saved schedule fee has no corresponding assessed charge.'
            : 'The saved schedule fee has no corresponding assessed charge and Registrar confirmation is missing.');
        }
        term.fees.set(column.key, { ...(term.fees.get(column.key) || {}), display: { ...cell, savedScheduleFee: Boolean(config) || Boolean(fee) } });
      }
      if (!applicable) {
        term.status = 'Not applicable';
        term.paymentAvailability = 'not_applicable';
        term.applied = null;
        term.balance = null;
        term.required = null;
        term.otherFees = { configured: null, applied: null, balance: null, status: 'Not applicable', feeKeys: [] };
        continue;
      }
      const required = term.requiredCents;
      const hasCharges = term.charges.length > 0;
      const hasIncompleteAssessedDetail = annual.assessmentId != null && [...annual.configs.entries()].some(([key, config]) => {
        if (!key.startsWith(`${termNumber}|`) || (config.optional && !config.selected)) return false;
        const identity = key.slice(`${termNumber}|`.length);
        const fee = term.fees.get(identity);
        return !fee || (fee.charges?.length || 0) < config.lineIds.size;
      });
      if (!annual.assessmentId) term.status = `${PAYMENT_STATUSES.UNAVAILABLE} — no assessment`;
      else if (!annual.confirmationId) term.status = `${PAYMENT_STATUSES.UNAVAILABLE} — Registrar confirmation missing`;
      else if (!hasCharges) term.status = `${PAYMENT_STATUSES.UNAVAILABLE} — no assessed fees`;
      else if (hasIncompleteAssessedDetail) term.status = `${PAYMENT_STATUSES.UNAVAILABLE} — assessed fee detail is incomplete`;
      else if (required < 0n) term.status = 'Unavailable — fee basis needs review';
      else if (required === 0n) term.status = PAYMENT_STATUSES.NONE;
      else if (term.dueCents <= 0n) term.status = PAYMENT_STATUSES.FULL;
      else if (term.appliedCents > 0n) term.status = PAYMENT_STATUSES.PARTIAL;
      else term.status = PAYMENT_STATUSES.UNPAID;
      term.paymentAvailability = term.status.startsWith('Unavailable') ? 'unavailable' : 'available';
      term.applied = hasCharges ? moneyText(term.appliedCents) : null;
      term.balance = hasCharges ? moneyText(term.dueCents) : null;
      term.required = hasCharges ? moneyText(term.requiredCents) : null;
      const otherFeeColumns = [...termColumns.values()].filter((column) => !column.canonicalTuition && !isLegacyWholeTermTuition(column));
      const otherFeeEntries = otherFeeColumns.map((column) => ({
        column, fee: term.fees.get(column.key), config: annual.configs.get(`${termNumber}|${column.key}`)
      })).filter(({ fee, config }) => fee?.charges?.length || (config && (!config.optional || config.selected)));
      const assessedOtherFees = otherFeeEntries.map((entry) => entry.fee)
        .filter((fee) => fee?.charges?.length);
      const hasIncompleteOtherFeeDetail = annual.assessmentId != null && otherFeeColumns.some((column) => {
        const config = annual.configs.get(`${termNumber}|${column.key}`);
        if (!config || (config.optional && !config.selected)) return false;
        const fee = term.fees.get(column.key);
        return (fee?.charges?.length || 0) < config.lineIds.size;
      });
      const otherRequiredCents = assessedOtherFees.reduce((sum, fee) => sum + fee.requiredCents, 0n);
      const otherAppliedCents = assessedOtherFees.reduce((sum, fee) => sum + fee.appliedCents, 0n);
      const otherDueCents = assessedOtherFees.reduce((sum, fee) => sum + fee.balanceCents, 0n);
      let otherFeeStatus;
      if (!applicable) otherFeeStatus = 'Not applicable';
      else if (!annual.assessmentId) otherFeeStatus = 'No assessment';
      else if (!annual.confirmationId) otherFeeStatus = 'Unavailable — Registrar confirmation missing';
      else if (hasIncompleteOtherFeeDetail) otherFeeStatus = 'Unavailable — assessed fee detail is incomplete';
      else if (!otherFeeEntries.length) otherFeeStatus = 'No other fees recorded';
      else if (!assessedOtherFees.length) otherFeeStatus = 'Unavailable — configured fee detail is missing';
      else if (otherRequiredCents < 0n) otherFeeStatus = 'Review fee basis';
      else if (otherRequiredCents === 0n) otherFeeStatus = PAYMENT_STATUSES.NONE;
      else if (otherDueCents <= 0n) otherFeeStatus = PAYMENT_STATUSES.FULL;
      else if (otherAppliedCents > 0n) otherFeeStatus = PAYMENT_STATUSES.PARTIAL;
      else otherFeeStatus = PAYMENT_STATUSES.UNPAID;
      term.otherFees = {
        configured: assessedOtherFees.length ? moneyText(otherRequiredCents) : null,
        applied: assessedOtherFees.length ? moneyText(otherAppliedCents) : null,
        balance: assessedOtherFees.length ? moneyText(otherDueCents) : null,
        status: otherFeeStatus,
        feeKeys: otherFeeColumns.map((column) => column.key)
      };
      term.fees = displayFeeCells(term.fees);
    }
  }

  const termColumns = Object.fromEntries([1, 2, 3].map((termNumber) => [termNumber,
    [...columns.get(termNumber).values()].sort(feeComparator)]));
  const historyByStudent = groupBy(historyRows, (row) => Number(row.student_id));
  const accountByStudent = new Map(accountRows.map((row) => [Number(row.student_id), row]));
  for (const annual of sortedAnnuals) {
    const priorRows = (historyByStudent.get(annual.studentId) || []).filter((row) => isEarlierSchoolYear(row.school_year, annual.schoolYear));
    const priorCents = moneySum(priorRows, (row) => row.balance_amount);
    const priorUnavailable = priorRows.some((row) => !row.assessment_id || !row.confirmation_id || Number(row.assessed_charge_count) === 0);
    const annualCharges = annual.charges;
    const selectedYearDueCents = annualCharges.reduce((sum, charge) => sum + charge.balanceCents, 0n);
    const account = accountByStudent.get(annual.studentId) || {};
    annual.selectedYearBalance = annualCharges.length ? moneyText(selectedYearDueCents) : null;
    annual.earlierYearBalance = moneyText(priorCents);
    annual.earlierYearStatus = priorUnavailable ? 'Unavailable — one or more earlier annual accounts lack a confirmed assessment.' : 'Available';
    annual.earlierAccountBalance = String(account.unattributed_legacy_balance || '0.00');
    annual.openingLiability = String(account.opening_liability_due || '0.00');
    annual.unusedPaymentCredit = String(account.available_credit || '0.00');
    annual.readiness = annual.intakeStatus === 'pending' ? 'Pending intake'
      : !annual.assessmentId ? 'No assessment'
        : !annual.confirmationId ? 'Awaiting Registrar confirmation' : 'Assessment confirmed';
    annual.voucherReview = annual.voucherReviewRequired ? 'Required' : 'No review flag';
    const backParams = new URLSearchParams();
    const backKeys = ['search', 'schoolYear', 'termId', 'gradeLevel', 'section', 'cluster', 'strand', 'voucherCode', 'status', 'financeStatus', 'installment', 'placementTerm', 'page'];
    for (const key of backKeys) {
      const value = filters[key];
      if (value == null || value === '') continue;
      const backName = `back${key[0].toUpperCase()}${key.slice(1)}`;
      backParams.set(backName, String(value));
    }
    annual.accountHref = `/finance/students/${annual.studentId}/annual${backParams.size ? `?${backParams.toString()}` : ''}`;
    delete annual.assessmentSelectionJson;
    delete annual.configs;
    delete annual.charges;
    for (const term of annual.terms.values()) {
      term.section = term.sectionName ? [term.sectionName, term.sectionStrand].filter(Boolean).join(' · ') : 'Unassigned';
      term.sectionContext = [term.sectionCluster, term.sectionStrand, term.modality === 'modular'
        ? (term.modularSubtype ? `Modular · ${String(term.modularSubtype).replaceAll('_', ' ')}` : 'Modular')
        : ({ face_to_face: 'Face-to-face', online: 'Online', hybrid: 'Hybrid' })[term.modality] || term.modality]
        .filter(Boolean).join(' · ');
      term.registrarConfirmation = term.scopeStatus === 'not_applicable' ? 'Not applicable'
        : annual.confirmationId != null ? 'Confirmed by registrar'
          : annual.anyConfirmationId != null ? 'Earlier confirmation recorded' : 'Needs registrar confirmation';
      term.fees = term.fees instanceof Map ? displayFeeCells(term.fees) : term.fees || {};
      delete term.charges;
      delete term.requiredCents;
      delete term.appliedCents;
      delete term.dueCents;
    }
    annual.terms = Object.fromEntries(annual.terms);
  }

  const counts = Object.fromEntries([1, 2, 3].map((termNumber) => [termNumber, {
    fullyPaid: 0, partiallyPaid: 0, unpaid: 0, noPaymentRequired: 0, unavailable: 0, notApplicable: 0
  }]));
  for (const annual of sortedAnnuals) {
    for (const termNumber of [1, 2, 3]) {
      const term = annual.terms[termNumber];
      const bucket = counts[termNumber];
      if (term.scopeStatus === 'not_applicable') bucket.notApplicable += 1;
      else if (term.status === PAYMENT_STATUSES.FULL) bucket.fullyPaid += 1;
      else if (term.status === PAYMENT_STATUSES.PARTIAL) bucket.partiallyPaid += 1;
      else if (term.status === PAYMENT_STATUSES.UNPAID) bucket.unpaid += 1;
      else if (term.status === PAYMENT_STATUSES.NONE) bucket.noPaymentRequired += 1;
      else bucket.unavailable += 1;
    }
  }
  const totalRecords = sortedAnnuals.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
  const page = Math.min(filters.page || 1, totalPages);
  const rows = sortedAnnuals.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return {
    filters: { ...filters, page }, termColumns, counts, totalRecords, rows, allRows: sortedAnnuals,
    pagination: { page, pageSize: PAGE_SIZE, totalRecords, totalPages,
      from: totalRecords ? (page - 1) * PAGE_SIZE + 1 : 0, to: Math.min(page * PAGE_SIZE, totalRecords) }
  };
}

function displayFeeCells(fees) {
  return Object.fromEntries([...fees.entries()].map(([feeKey, fee]) => [feeKey, {
    ...(fee.display || cellDefault('Not applicable')),
    chargeIds: fee.charges?.map((charge) => charge.chargeId) || []
  }]));
}

function parseSelection(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return new Set(Array.isArray(parsed.optionalLineIds) ? parsed.optionalLineIds.map(Number).filter(Number.isSafeInteger) : []);
  } catch { return new Set(); }
}

function groupBy(rows, keyFn) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

function bindScope(request, filters, sql) {
  request.input('schoolYear', sql.NVarChar(20), filters.schoolYear === 'all' ? '' : filters.schoolYear)
    .input('gradeLevel', sql.NVarChar(50), filters.gradeLevel)
    .input('voucherCode', sql.NVarChar(3), filters.voucherCode)
    .input('searchTerm', sql.NVarChar(100), filters.search)
    .input('placementTerm', sql.TinyInt, filters.placementTerm)
    .input('termId', sql.Int, filters.termId ? Number(filters.termId) : 0)
    .input('sectionMode', sql.VarChar(12), filters.section === 'unassigned' ? 'unassigned' : filters.section ? 'assigned' : 'all')
    .input('sectionId', sql.Int, filters.section && filters.section !== 'unassigned' ? Number(filters.section) : 0)
    .input('cluster', sql.NVarChar(100), filters.cluster)
    .input('strand', sql.NVarChar(100), filters.strand)
    .input('placementStatus', sql.NVarChar(30), filters.status)
    .input('financeStatus', sql.NVarChar(30), filters.financeStatus);
  return request;
}

function matchingAnnualCte(filters) {
  const financeStatusFilter = filters.financeStatus ? `AND EXISTS (
      SELECT 1 FROM FinanceTermClassification AS classification
      WHERE classification.annual_enrollment_id = annual.id
        AND classification.annual_term_number = @placementTerm
        AND (@termId = 0 OR classification.academic_term_id = @termId)
        AND classification.term_scope_status = 'applicable'
        AND classification.enrollment_status IN ('enrolled', 'pending_payment')
        AND classification.intake_status NOT IN ('legacy', 'cancelled', 'dropped', 'transferred')
        AND classification.student_status = 'active'
        AND classification.${FINANCE_STATUS_COLUMNS[filters.installment]} = @financeStatus
    )` : '';
  const ctes = filters.financeStatus ? `${FINANCE_TERM_CLASSIFICATION_CTES}, ` : '';
  return `WITH ${ctes}${MATCHING_ANNUALS_CTE.replace('__FINANCE_STATUS_FILTER__', financeStatusFilter)}`;
}

function bindIds(request, ids, prefix, sql) {
  const names = [];
  ids.forEach((id, index) => {
    const name = `${prefix}${index}`;
    request.input(name, sql.Int, id);
    names.push(`@${name}`);
  });
  return names;
}

function createFinanceMasterlistService({ getPool = defaultGetPool, sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool) } = {}) {
  async function begin(actorInput) {
    const actorId = typeof actorInput === 'number' ? actorInput
      : typeof actorInput === 'string' && /^\d{1,15}$/.test(actorInput) ? Number(actorInput) : NaN;
    if (!Number.isSafeInteger(actorId) || actorId < 1) throw new FinanceMasterlistError('Your finance access is no longer active. Sign in again.', 403);
    let transaction;
    let queryPhase = 'transaction_begin';
    try {
      transaction = transactionFactory(await getPool());
      await transaction.begin(sql.ISOLATION_LEVEL.REPEATABLE_READ);
      queryPhase = 'authorization';
      const actor = await transaction.request().input('actorId', sql.Int, actorId)
        .query(`SELECT id FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin')`);
      if (!actor.recordset?.length) {
        await transaction.rollback();
        throw new FinanceMasterlistError('Your finance access is no longer active. Sign in again.', 403);
      }
      return transaction;
    } catch (cause) {
      if (transaction?.active) await transaction.rollback().catch(() => {});
      if (cause instanceof FinanceMasterlistError) throw cause;
      throw new FinanceMasterlistError('Finance masterlist could not be loaded.', 503, { cause, queryPhase });
    }
  }

  async function query(transaction, request, statement, queryPhase) {
    try { return await request.query(statement); }
    catch (cause) { throw new FinanceMasterlistError('Finance masterlist could not be loaded.', 503, { cause, queryPhase }); }
  }

  async function loadRows(transaction, parsedFilters, context) {
    const schoolYearOptionsResult = await query(transaction, transaction.request(), `SELECT DISTINCT school_year
      FROM annual_enrollments
      ORDER BY CAST(SUBSTRING_INDEX(school_year, '-', 1) AS UNSIGNED) DESC, school_year DESC`, 'school_year_options');
    const schoolYears = (schoolYearOptionsResult.recordset || []).map((row) => String(row.school_year));
    if (context.currentScopeConfigured && context.currentSchoolYear && !schoolYears.includes(String(context.currentSchoolYear))) {
      schoolYears.unshift(String(context.currentSchoolYear));
    }
    let requestedTerm = null;
    if (parsedFilters.termId) {
      const termResult = await query(transaction, transaction.request().input('termId', sql.Int, Number(parsedFilters.termId)), `SELECT term.school_year,
          termOrder.term_number, term.term
        FROM academic_terms AS term
        INNER JOIN school_year_term_order AS termOrder ON termOrder.academic_term_id = term.id
        WHERE term.id = @termId LIMIT 1`, 'selected_term');
      requestedTerm = termResult.recordset?.[0] || null;
      if (!requestedTerm || ![1, 2, 3].includes(Number(requestedTerm.term_number))) {
        throw new FinanceMasterlistError('Choose a configured school-year term.');
      }
    }
    if (requestedTerm && parsedFilters.schoolYear && parsedFilters.schoolYear !== 'all'
      && parsedFilters.schoolYear !== String(requestedTerm.school_year)) {
      throw new FinanceMasterlistError('The selected term does not belong to the chosen school year.');
    }
    if (requestedTerm && parsedFilters.placementTerm && parsedFilters.placementTerm !== Number(requestedTerm.term_number)) {
      throw new FinanceMasterlistError('The selected term conflicts with the placement term.');
    }
    let selectedSchoolYear = requestedTerm ? String(requestedTerm.school_year) : parsedFilters.schoolYear;
    if (selectedSchoolYear == null) selectedSchoolYear = requestedTerm?.school_year || (context.currentScopeConfigured ? context.currentSchoolYear : '') || '';
    if (selectedSchoolYear && selectedSchoolYear !== 'all' && !schoolYears.includes(selectedSchoolYear)) {
      throw new FinanceMasterlistError('Choose a school year with saved annual enrollments.');
    }
    if (requestedTerm && selectedSchoolYear !== 'all' && selectedSchoolYear !== String(requestedTerm.school_year)) {
      throw new FinanceMasterlistError('The selected term does not belong to the chosen school year.');
    }
    const scopeFilters = {
      ...parsedFilters,
      schoolYear: selectedSchoolYear,
      placementTerm: parsedFilters.placementTerm || Number(requestedTerm?.term_number) || (context.currentScopeConfigured ? context.defaultTerm : null),
      termId: ''
    };
    const normalizedFilters = { ...scopeFilters, page: parsedFilters.page };
    if (!scopeFilters.schoolYear || !scopeFilters.placementTerm) {
      const emptyProjection = buildMasterlistProjection({}, normalizedFilters);
      return {
        masterlist: { ...emptyProjection,
          options: { schoolYears, grades: [], sections: [], placementTerms: [1, 2, 3] },
          currentSchoolYear: context.currentSchoolYear || null,
          currentScopeConfigured: context.currentScopeConfigured,
          defaultPlacementTerm: context.defaultTerm,
          needsScopeSelection: true
        },
        transaction
      };
    }
    const gradeQuery = transaction.request().input('schoolYear', sql.NVarChar(20), scopeFilters.schoolYear === 'all' ? '' : scopeFilters.schoolYear);
    const gradesResult = await query(transaction, gradeQuery,
      `SELECT DISTINCT grade_level FROM annual_enrollments
        WHERE (@schoolYear = '' OR school_year = @schoolYear) ORDER BY grade_level`, 'grade_options');
    const grades = (gradesResult.recordset || []).map((row) => String(row.grade_level));
    if (scopeFilters.gradeLevel && !grades.includes(scopeFilters.gradeLevel)) throw new FinanceMasterlistError('Choose a grade with saved annual enrollments for this school year.');
    const sectionsResult = await query(transaction, transaction.request()
      .input('schoolYear', sql.NVarChar(20), scopeFilters.schoolYear === 'all' ? '' : scopeFilters.schoolYear)
      .input('placementTerm', sql.TinyInt, scopeFilters.placementTerm)
      .input('termId', sql.Int, 0), `SELECT DISTINCT section.id AS section_id, section.name AS section_name,
        section.strand AS section_strand, section.cluster AS section_cluster
      FROM enrollments AS enrollment
      INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
      LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
      WHERE (@schoolYear = '' OR annual.school_year = @schoolYear)
        AND enrollment.annual_term_number = @placementTerm AND (@termId = 0 OR enrollment.academic_term_id = @termId)
        AND section.id IS NOT NULL
      ORDER BY section.name, section.strand, section.id`, 'section_options');
    const sections = (sectionsResult.recordset || []).map((row) => ({
      id: String(row.section_id), name: String(row.section_name), strand: row.section_strand || null, cluster: row.section_cluster || null,
      label: [row.section_name, row.section_strand].filter(Boolean).join(' · ')
    }));
    if (scopeFilters.section && scopeFilters.section !== 'unassigned' && !sections.some((section) => section.id === scopeFilters.section)) {
      throw new FinanceMasterlistError('Choose a section in the selected placement term and school year.');
    }
    const cte = matchingAnnualCte(normalizedFilters);
    const bind = (request) => bindScope(request, normalizedFilters, sql);
    const annualRowsResult = await query(transaction, bind(transaction.request()), `${cte}
      , LatestFinanceClearance AS (
        SELECT clearance.enrollment_id, clearance.event_type, clearance.created_at,
          ROW_NUMBER() OVER (PARTITION BY clearance.enrollment_id ORDER BY clearance.created_at DESC, clearance.id DESC) AS event_rank
        FROM term_clearance_events AS clearance
      ), LatestAnnualConfirmation AS (
        SELECT confirmation.annual_enrollment_id, confirmation.assessment_id, confirmation.id,
          ROW_NUMBER() OVER (PARTITION BY confirmation.annual_enrollment_id ORDER BY confirmation.confirmed_at DESC, confirmation.id DESC) AS confirmation_rank
        FROM annual_registrar_confirmations AS confirmation
      ), LatestMatchingConfirmation AS (
        SELECT confirmation.annual_enrollment_id, confirmation.assessment_id, confirmation.id,
          ROW_NUMBER() OVER (PARTITION BY confirmation.annual_enrollment_id, confirmation.assessment_id
            ORDER BY confirmation.confirmed_at DESC, confirmation.id DESC) AS confirmation_rank
        FROM annual_registrar_confirmations AS confirmation
      ), LatestVoucherReviewEvent AS (
        SELECT event.annual_enrollment_id, event.event_type, event.reason,
          ROW_NUMBER() OVER (PARTITION BY event.annual_enrollment_id ORDER BY event.created_at DESC, event.id DESC) AS event_rank
        FROM annual_enrollment_events AS event
        WHERE event.event_type IN ('voucher_review_flagged', 'voucher_review_resolved')
      )
      SELECT annual.annual_enrollment_id, annual.student_id, annual.school_year, annual.grade_level, annual.voucher_code,
        annual.intake_status, annual.student_no, annual.lrn, annual.first_name, annual.middle_name, annual.last_name, annual.suffix,
        annual_assessment.id AS assessment_id, annual_assessment.schedule_version, annual_assessment.selection_json,
        annual_assessment.voucher_code_snapshot AS assessed_voucher_code,
        confirmation.id AS confirmation_id, any_confirmation.id AS any_confirmation_id,
        CASE WHEN voucher_event.event_type = 'voucher_review_flagged' THEN 1 ELSE 0 END AS voucher_review_required,
        voucher_event.reason AS voucher_review_reason,
        enrollment.id AS enrollment_id, enrollment.annual_term_number, enrollment.academic_term_id AS term_id,
        term.term AS term_label, section.id AS section_id, section.name AS section_name,
        section.cluster AS section_cluster, section.strand AS section_strand, section.adviser AS section_adviser,
        section.modality, section.modular_subtype,
        enrollment.enrollment_status, enrollment.term_scope_status,
          clearance.event_type AS finance_clearance,
          DATE_FORMAT(CONVERT_TZ(clearance.created_at, '+00:00', '+08:00'), '%Y-%m-%d') AS finance_clearance_date
      FROM MatchingAnnual AS annual
      LEFT JOIN annual_assessments AS annual_assessment ON annual_assessment.annual_enrollment_id = annual.annual_enrollment_id
      LEFT JOIN LatestMatchingConfirmation AS confirmation ON confirmation.annual_enrollment_id = annual.annual_enrollment_id
        AND confirmation.assessment_id = annual_assessment.id AND confirmation.confirmation_rank = 1
      LEFT JOIN LatestAnnualConfirmation AS any_confirmation ON any_confirmation.annual_enrollment_id = annual.annual_enrollment_id
        AND any_confirmation.confirmation_rank = 1
      LEFT JOIN LatestVoucherReviewEvent AS voucher_event ON voucher_event.annual_enrollment_id = annual.annual_enrollment_id
        AND voucher_event.event_rank = 1
      LEFT JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.annual_enrollment_id
      LEFT JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
      LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
      LEFT JOIN LatestFinanceClearance AS clearance ON clearance.enrollment_id = enrollment.id AND clearance.event_rank = 1
      ORDER BY annual.last_name, annual.first_name, annual.student_no, annual.annual_enrollment_id, enrollment.annual_term_number`, 'annual_rows');
    const chargeRowsResult = await query(transaction, bind(transaction.request()), `${cte}
      SELECT charge.id AS charge_id, charge.annual_enrollment_id, enrollment.annual_term_number AS term_number,
        charge.fee_category, charge.line_name, charge.installment, charge.schedule_line_id,
        CAST(COALESCE(schedule_line.is_optional, 0) AS UNSIGNED) AS is_optional,
        CAST(charge.gross_amount AS CHAR(40)) AS gross_amount, CAST(charge.waived_amount AS CHAR(40)) AS waived_amount,
        CAST(COALESCE(adjustment.total, 0) AS CHAR(40)) AS adjustments_amount,
        CAST(charge.amount + COALESCE(adjustment.total, 0) AS CHAR(40)) AS required_amount,
        CAST(COALESCE(due.annual_allocated + due.legacy_allocated, 0) AS CHAR(40)) AS applied_amount,
        CAST(COALESCE(due.amount_due, charge.amount + COALESCE(adjustment.total, 0)) AS CHAR(40)) AS balance_amount
      FROM MatchingAnnual AS annual
      INNER JOIN assessed_charges AS charge ON charge.annual_enrollment_id = annual.annual_enrollment_id
      INNER JOIN enrollments AS enrollment ON enrollment.id = charge.enrollment_id
      LEFT JOIN finance_schedule_lines AS schedule_line ON schedule_line.id = charge.schedule_line_id
      LEFT JOIN (SELECT charge_id, SUM(amount) AS total FROM finance_charge_adjustments GROUP BY charge_id) AS adjustment
        ON adjustment.charge_id = charge.id
      LEFT JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
      ORDER BY annual.annual_enrollment_id, enrollment.annual_term_number, charge.id`, 'charge_rows');
    const configuredLinesResult = await query(transaction, bind(transaction.request()), `${cte}
      SELECT annual.annual_enrollment_id, line.id AS schedule_line_id, line.term_number, line.fee_category,
        line.line_name, line.installment, line.is_optional, CAST(line.amount AS CHAR(40)) AS amount
      FROM MatchingAnnual AS annual
      LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.annual_enrollment_id
      INNER JOIN finance_schedules AS schedule ON schedule.id = assessment.schedule_id
        OR (assessment.id IS NULL AND schedule.status = 'active' AND schedule.school_year = annual.school_year
          AND schedule.grade_level = annual.grade_level AND schedule.voucher_code = annual.voucher_code)
      INNER JOIN finance_schedule_lines AS line ON line.schedule_id = schedule.id
      ORDER BY annual.annual_enrollment_id, line.term_number, line.fee_category, line.line_name, line.installment, line.id`, 'configured_fee_rows');
    const historyRowsResult = await query(transaction, bind(transaction.request()), `${cte}
      , MatchingStudent AS (SELECT DISTINCT student_id FROM MatchingAnnual)
      SELECT annual.student_id, annual.school_year, assessment.id AS assessment_id, confirmation.id AS confirmation_id,
        COUNT(charge.id) AS assessed_charge_count,
        CAST(COALESCE(SUM(due.amount_due), 0) AS CHAR(40)) AS balance_amount
      FROM MatchingStudent AS matched
      INNER JOIN annual_enrollments AS annual ON annual.student_id = matched.student_id
      LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
      LEFT JOIN annual_registrar_confirmations AS confirmation ON confirmation.annual_enrollment_id = annual.id
        AND confirmation.assessment_id = assessment.id
      LEFT JOIN assessed_charges AS charge ON charge.annual_enrollment_id = annual.id
      LEFT JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
      GROUP BY annual.student_id, annual.school_year, assessment.id, confirmation.id
      ORDER BY annual.student_id, annual.school_year`, 'earlier_year_balances');
    const accountRowsResult = await query(transaction, bind(transaction.request()), `${cte}
      , MatchingStudent AS (SELECT DISTINCT student_id FROM MatchingAnnual)
      SELECT matched.student_id,
        CAST(COALESCE(legacy.remaining_legacy_balance, 0) AS CHAR(40)) AS unattributed_legacy_balance,
        CAST(COALESCE(opening.total, 0) AS CHAR(40)) AS opening_liability_due,
        CAST(COALESCE(credit.total, 0) AS CHAR(40)) AS available_credit
      FROM MatchingStudent AS matched
      LEFT JOIN v_finance_legacy_account_balance AS legacy ON legacy.student_id = matched.student_id
      LEFT JOIN (SELECT due.student_id, SUM(due.amount_due) AS total FROM v_finance_opening_liability_due AS due GROUP BY due.student_id) AS opening
        ON opening.student_id = matched.student_id
      LEFT JOIN (SELECT credit.student_id, SUM(credit.available_credit) AS total FROM v_finance_payment_credit AS credit
        WHERE credit.is_reversed = 0 GROUP BY credit.student_id) AS credit ON credit.student_id = matched.student_id
      ORDER BY matched.student_id`, 'account_balances');
    const masterlist = buildMasterlistProjection({
      annualRows: annualRowsResult.recordset || [], chargeRows: chargeRowsResult.recordset || [],
      configuredLines: configuredLinesResult.recordset || [], historyRows: historyRowsResult.recordset || [],
      accountRows: accountRowsResult.recordset || []
    }, normalizedFilters);
    return {
      masterlist: { ...masterlist, options: { schoolYears, grades, sections, placementTerms: [1, 2, 3] },
        currentSchoolYear: context.currentSchoolYear || null, currentScopeConfigured: context.currentScopeConfigured,
        defaultPlacementTerm: context.defaultTerm, needsScopeSelection: false },
      transaction
    };
  }

  async function loadContext(transaction) {
    const currentResult = await query(transaction, transaction.request(), `SELECT term.school_year, termOrder.term_number,
        EXISTS (SELECT 1 FROM school_year_term_order_reviews AS review
          WHERE review.academic_term_id = term.id AND review.resolved_at IS NULL) AS has_unresolved_review
      FROM academic_terms AS term LEFT JOIN school_year_term_order AS termOrder
        ON termOrder.academic_term_id = term.id AND termOrder.school_year = term.school_year
      WHERE term.is_current = 1 ORDER BY term.school_year DESC, term.id DESC`, 'current_term');
    const currentTerms = currentResult.recordset || [];
    const current = currentTerms.length === 1 ? currentTerms[0] : null;
    const termNumber = Number(current?.term_number);
    const currentScopeConfigured = Boolean(current?.school_year && Number.isInteger(termNumber) && termNumber >= 1 && termNumber <= 3
      && !truthyDb(current.has_unresolved_review));
    return {
      currentSchoolYear: currentScopeConfigured ? String(current.school_year) : '',
      defaultTerm: currentScopeConfigured ? termNumber : null,
      currentScopeConfigured
    };
  }

  async function queryApplications(transaction, annualIds) {
    if (!annualIds.length) return new Map();
    const request = transaction.request();
    const ids = bindIds(request, annualIds, 'annualId', sql).join(', ');
    const result = await query(transaction, request, `SELECT application.charge_id, application.application_type,
        application.application_date, application.reference_no, application.receipt_issued,
        application.is_reversed, CAST(application.original_amount AS CHAR(40)) AS original_amount,
        CAST(application.current_amount AS CHAR(40)) AS current_amount,
        CAST(application.released_amount AS CHAR(40)) AS released_amount
      FROM (
        SELECT allocation.charge_id, 'Payment' AS application_type,
          DATE_FORMAT(payment.payment_date, '%Y-%m-%d') AS application_date, payment.reference_no,
          payment.receipt_issued, payment.is_reversed, allocation.amount AS original_amount,
          CASE WHEN payment.is_reversed = 1 THEN 0 ELSE net.net_amount END AS current_amount,
          allocation.amount - net.net_amount AS released_amount, allocation.id AS source_id
        FROM finance_payment_allocations AS allocation
        INNER JOIN v_finance_net_payment_allocations AS net ON net.allocation_id = allocation.id
        INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
        INNER JOIN assessed_charges AS charge ON charge.id = allocation.charge_id
        WHERE charge.annual_enrollment_id IN (${ids})
        UNION ALL
        SELECT reconciliation.charge_id, 'Earlier payment' AS application_type,
          DATE_FORMAT(CONVERT_TZ(transaction_record.created_at, '+00:00', '+08:00'), '%Y-%m-%d') AS application_date, transaction_record.reference_no,
          0 AS receipt_issued, 0 AS is_reversed, reconciliation.amount AS original_amount,
          net.net_amount AS current_amount, reconciliation.amount - net.net_amount AS released_amount,
          reconciliation.id AS source_id
        FROM finance_legacy_reconciliations AS reconciliation
        INNER JOIN v_finance_net_legacy_reconciliations AS net ON net.reconciliation_id = reconciliation.id
        INNER JOIN assessed_charges AS charge ON charge.id = reconciliation.charge_id
        INNER JOIN financial_transactions AS transaction_record ON transaction_record.id = reconciliation.transaction_id
        WHERE charge.annual_enrollment_id IN (${ids})
      ) AS application
      ORDER BY application.charge_id, application.application_date, application.source_id`, 'application_details');
    const grouped = new Map();
    for (const row of result.recordset || []) {
      const key = Number(row.charge_id);
      if (!grouped.has(key)) grouped.set(key, []);
      const reversed = truthyDb(row.is_reversed);
      grouped.get(key).push({
        type: row.application_type, date: row.application_date || 'Date unavailable', reference: row.reference_no || 'No receipt/reference recorded',
        receiptIssued: truthyDb(row.receipt_issued), reversed,
        original: String(row.original_amount || '0.00'), current: String(reversed ? '0.00' : row.current_amount || '0.00'),
        released: String(row.released_amount || '0.00')
      });
    }
    return grouped;
  }

  function attachApplications(rows, applicationMap) {
    for (const row of rows) {
      for (const term of Object.values(row.terms || {})) {
        if (!term) continue;
        for (const [feeKey, cell] of Object.entries(term.fees || {})) {
          const applications = (cell.chargeIds || []).flatMap((chargeId) => applicationMap.get(Number(chargeId)) || []);
          term.fees[feeKey] = { ...cell, applications };
        }
      }
    }
  }

  async function list(actorInput, rawFilters = {}) {
    const parsed = parseMasterlistFilters(rawFilters);
    const transaction = await begin(actorInput);
    let complete = false;
    try {
      const context = await loadContext(transaction);
      const { masterlist } = await loadRows(transaction, parsed, context);
      const applicationMap = await queryApplications(transaction, masterlist.rows.map((row) => row.annualEnrollmentId));
      attachApplications(masterlist.rows, applicationMap);
      const { allRows, ...screenMasterlist } = masterlist;
      await transaction.commit();
      complete = true;
      return screenMasterlist;
    } catch (error) {
      if (!complete && transaction.active) await transaction.rollback().catch(() => {});
      if (error instanceof FinanceMasterlistError) throw error;
      throw new FinanceMasterlistError('Finance masterlist could not be loaded.', 503, { cause: error, queryPhase: 'projection' });
    }
  }

  async function streamExport(actorInput, rawFilters = {}, onBatch = async () => {}) {
    const parsed = parseMasterlistFilters({ ...rawFilters, page: '1' });
    const transaction = await begin(actorInput);
    let complete = false;
    try {
      const context = await loadContext(transaction);
      const { masterlist } = await loadRows(transaction, parsed, context);
      const { allRows, ...exportMasterlist } = masterlist;
      await onBatch({ masterlist: exportMasterlist, rows: [], first: true });
      for (let offset = 0; offset < allRows.length; offset += EXPORT_BATCH_SIZE) {
        const rows = allRows.slice(offset, offset + EXPORT_BATCH_SIZE);
        const applicationMap = await queryApplications(transaction, rows.map((row) => row.annualEnrollmentId));
        attachApplications(rows, applicationMap);
        await onBatch({ masterlist: exportMasterlist, rows, first: false });
      }
      await transaction.commit();
      complete = true;
    } catch (error) {
      if (!complete && transaction.active) await transaction.rollback().catch(() => {});
      if (error instanceof FinanceMasterlistError) throw error;
      throw new FinanceMasterlistError('Finance masterlist export could not be prepared.', 503, { cause: error, queryPhase: 'export' });
    }
  }

  return { list, streamExport };
}

module.exports = {
  PAGE_SIZE, EXPORT_BATCH_SIZE, FinanceMasterlistError, parseMasterlistFilters,
  feeIdentity, buildMasterlistProjection, createFinanceMasterlistService
};
