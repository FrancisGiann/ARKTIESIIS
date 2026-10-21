'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

const MAX_MASTERLIST_ROWS = 10000;
const MANILA_DATE_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
});
const COL_HEADERS = Object.freeze([
  'NO.', '1ST SEM E-FORM', 'GRADE 11 CARD', 'VOUCHER TYPE', 'ESC ID', 'G11 SECTION 1st Sem - S.Y (previous year)',
  'G11 SECTION (2nd Sem - S.Y (previous year)', 'LIS REMARKS', 'VMS REMARKS', 'VMS STATUS', 'FINAL GRADE', 'LRN',
  'FULL NAME', 'LAST NAME', 'FIRST NAME', 'MIDDLE NAME', 'SUFFIX', 'GENDER', 'BIRTHDATE', 'BIRTHPLACE',
  'STRAND (TERM 1)', 'SECTION (TERM 1)', 'ADVISER (TERM 1)', 'DATE ENROLLED (TERM 1)', 'REMARKS (TERM 1)', 'MODALITY (TERM 1)',
  'LIS STATUS (TERM 2)', 'STRAND (TERM 2)', 'SECTION (TERM 2)', 'ADVISER (TERM 2)', 'DATE ENROLLED (TERM 2)', 'REMARKS (TERM 2)', 'MODALITY (TERM 2)',
  'LIS STATUS (TERM 3)', 'STRAND (TERM 3)', 'SECTION (TERM 3)', 'ADVISER (TERM 3)', 'DATE ENROLLED (TERM 3)', 'REMARKS (TERM 3)', 'MODALITY (TERM 3)',
  "STUDENT'S CONTACT NUMBER", 'FACEBOOK NAME (student)', 'EMAIL ADDRESS (student)', 'PRESENT ADDRESS', 'EMERGENCY CONTACT PERSON', 'RELATIONSHIP',
  'CONTACT NUMBER (Emergency Contact Person)', 'ADDRESS (Emergency Contact Person)', "MOTHER'S NAME", 'CONTACT NUMBER (mother)',
  "FATHER'S NAME", 'CONTACT NUMBER (father)', 'DO/TO DATE AND REASON', 'GUIDANCE REMARKS', 'INTERNAL AGREEMENT REMARKS', 'EDUC TOUR',
  'Birth Cert.', 'Card', 'JHS Cert', 'Good Moral Cert', '2x2 pic', 'SF10', 'others', 'REMARKS', 'SCHOOL ID', 'DATE CLAIMED',
  'SCHOOL UNIFORM', 'DATE CLAIMED', 'PE UNIFORM', 'DATE CLAIMED'
]);

const HEADER_GROUPS = Object.freeze([
  [1, 3, 'FOR REGISTRAR'], [4, 7, 'FOR FINANCE / REGISTRAR'], [8, 11, 'FOR REGISTRAR'], [12, 20, 'STUDENT DETAILS'],
  [21, 26, 'TERM 1'], [27, 33, 'TERM 2'], [34, 40, 'TERM 3'], [41, 52, 'STUDENT DETAILS'],
  [53, 56, 'FOR GUIDANCE ADVOCATE'], [57, 66, 'FOR REGISTRAR'], [67, 70, 'PROPERTY CUSTODIAN']
]);

const COL_WIDTHS = Object.freeze([
  7, 14, 13, 16, 13, 20, 20, 16, 16, 14, 14, 16, 32, 18, 18, 18, 12, 13, 14, 20,
  16, 18, 20, 16, 18, 16, 14, 16, 18, 20, 16, 18, 16, 14, 16, 18, 20, 16, 18, 16,
  20, 22, 28, 32, 24, 16, 20, 30, 24, 20, 24, 20, 24, 24, 24, 16, 16, 16, 16, 18,
  16, 14, 18, 16, 16, 18, 16, 18, 16, 16
]);

class RegistrarMasterlistError extends Error {
  constructor(message, status = 400, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'RegistrarMasterlistError';
    this.status = status;
    if (options.cause) this.cause = options.cause;
    if (options.phase) this.phase = options.phase;
  }
}

function printable(input, label, max, { allowedEmpty = true } = {}) {
  if (input == null || input === '') {
    if (!allowedEmpty) throw new RegistrarMasterlistError(`Choose a valid ${label}.`);
    return '';
  }
  if (typeof input !== 'string' || input.length > max || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new RegistrarMasterlistError(`Choose a valid ${label}.`);
  }
  return input.trim();
}

function parseMasterlistFilters(input = {}) {
  const schoolYear = printable(input.schoolYear, 'school year', 20);
  const hasGradeLevel = Object.prototype.hasOwnProperty.call(input, 'gradeLevel');
  const rawGradeLevel = printable(input.gradeLevel, 'grade level', 20);
  const gradeLevel = hasGradeLevel ? rawGradeLevel : 'Grade 12';
  if (gradeLevel && !['Grade 11', 'Grade 12'].includes(gradeLevel)) throw new RegistrarMasterlistError('Choose Grade 11 or Grade 12.');
  const termRaw = printable(input.term, 'term', 2);
  if (termRaw && !/^[1-3]$/.test(termRaw)) throw new RegistrarMasterlistError('Choose Term 1, 2, or 3.');
  const sectionRaw = printable(input.sectionId, 'section', 10);
  if (sectionRaw && !/^\d{1,10}$/.test(sectionRaw)) throw new RegistrarMasterlistError('Choose a valid section.');
  return { schoolYear, gradeLevel: gradeLevel || 'Grade 12', termNumber: termRaw ? Number(termRaw) : null, sectionId: sectionRaw ? Number(sectionRaw) : null };
}

function normalizeActorId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function databaseBoolean(value) {
  return value === true || value === 1 || value === '1';
}

function databaseDateToExcel(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.valueOf())) return null;
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? date : null;
}

function databaseTimestampToManilaExcel(value) {
  let instant = value instanceof Date && Number.isFinite(value.valueOf()) ? value : null;
  if (!instant && typeof value === 'string') {
    const text = value.trim();
    const utcFields = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(text);
    if (utcFields) {
      const [, year, month, day, hour, minute, second, fraction = '0'] = utcFields;
      const parts = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)];
      const candidate = new Date(Date.UTC(...parts, Number(fraction.slice(0, 3).padEnd(3, '0'))));
      if (candidate.getUTCFullYear() === parts[0] && candidate.getUTCMonth() === parts[1] && candidate.getUTCDate() === parts[2]
        && candidate.getUTCHours() === parts[3] && candidate.getUTCMinutes() === parts[4] && candidate.getUTCSeconds() === parts[5]) {
        instant = candidate;
      }
    } else if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      const candidate = new Date(text);
      if (Number.isFinite(candidate.valueOf())) instant = candidate;
    }
  }
  if (!instant) return null;
  const fields = Object.fromEntries(MANILA_DATE_PARTS.formatToParts(instant).map((part) => [part.type, part.value]));
  return databaseDateToExcel(`${fields.year}-${fields.month}-${fields.day}`);
}

function asLiteral(value) {
  if (value == null) return '';
  const text = String(value);
  // Explicit strings plus a text number format prevent formula evaluation in Excel.
  return text;
}

function enrollmentStatusLabel(value) {
  const labels = { enrolled: 'Enrolled', pending_payment: 'Pending payment', dropped: 'Dropped', transferred: 'Transferred',
    not_applicable: 'Not applicable', cancelled: 'Cancelled' };
  return typeof value === 'string' ? (labels[value] || value.replaceAll('_', ' ')) : '';
}

function currentTermPlacement(placements, termNumber, confirmed) {
  const placement = placements.get(termNumber);
  if (!placement) return {};
  const isEnrolled = placement.enrollment_status === 'enrolled' && confirmed;
  return {
    strand: placement.strand,
    section: placement.section_name,
    adviser: placement.adviser,
    enrolledAt: isEnrolled ? databaseTimestampToManilaExcel(placement.enrolled_at) : null,
    remarks: enrollmentStatusLabel(placement.enrollment_status),
    modality: placement.modality
  };
}

function buildOverallRow(source, index, paperEvidence) {
  const placements = source.placements;
  const confirmed = databaseBoolean(source.confirmed);
  const row = Array(70).fill('');
  const name = [source.first_name, source.middle_name, source.last_name, source.suffix].filter((part) => String(part || '').trim()).join(' ');
  row[0] = index;
  row[3] = source.voucher_code || '';
  row[11] = asLiteral(source.lrn);
  row[12] = name;
  row[13] = source.last_name || '';
  row[14] = source.first_name || '';
  row[15] = source.middle_name || '';
  row[16] = source.suffix || '';
  row[17] = source.sex || '';
  row[18] = databaseDateToExcel(source.birth_date);
  row[19] = source.birthplace || '';
  const term1 = currentTermPlacement(placements, 1, confirmed);
  row[20] = term1.strand || '';
  row[21] = term1.section || '';
  row[22] = term1.adviser || '';
  row[23] = databaseDateToExcel(term1.enrolledAt);
  row[24] = term1.remarks || '';
  row[25] = term1.modality || '';
  const term2 = currentTermPlacement(placements, 2, confirmed);
  row[27] = term2.strand || '';
  row[28] = term2.section || '';
  row[29] = term2.adviser || '';
  row[30] = databaseDateToExcel(term2.enrolledAt);
  row[31] = term2.remarks || '';
  row[32] = term2.modality || '';
  const term3 = currentTermPlacement(placements, 3, confirmed);
  row[34] = term3.strand || '';
  row[35] = term3.section || '';
  row[36] = term3.adviser || '';
  row[37] = databaseDateToExcel(term3.enrolledAt);
  row[38] = term3.remarks || '';
  row[39] = term3.modality || '';
  row[40] = source.phone || '';
  row[41] = source.facebook_name || '';
  row[42] = source.email || '';
  row[43] = source.address || '';
  row[44] = source.emergency_contact_person || '';
  row[45] = source.emergency_contact_relationship || '';
  row[46] = source.emergency_contact_phone || '';
  row[47] = source.emergency_contact_address || '';
  row[48] = source.mother_name || '';
  row[49] = source.mother_phone || '';
  row[50] = source.father_name || '';
  row[51] = source.father_phone || '';
  if (source.departure) {
    const date = databaseDateToExcel(source.departure.effective_date);
    row[52] = [
      source.departure.annual_term_number ? `Term ${source.departure.annual_term_number}` : '',
      enrollmentStatusLabel(source.departure.departure_type),
      date ? date.toISOString().slice(0, 10) : '',
      source.departure.reason || ''
    ].filter(Boolean).join(' · ');
  }
  const evidenceColumns = {
    birth_certificate: 57, grade11_card: 58, jhs_certificate: 59, good_moral: 60, two_by_two_photo: 61, sf10_form137: 62
  };
  for (const [code, col] of Object.entries(evidenceColumns)) {
    const evidence = paperEvidence.get(`${source.student_id}:${code}`);
    if (!evidence) continue;
    if (typeof evidence === 'string') {
      row[col - 1] = evidence;
      continue;
    }
    const counts = [
      ['originals', evidence.originals], ['copies', evidence.copies], ['pieces', evidence.pieces]
    ].filter(([, count]) => Number.isFinite(Number(count))).map(([label, count]) => `${label}: ${Number(count)}`).join(', ');
    row[col - 1] = [evidence.status, counts].filter(Boolean).join('; ');
  }
  // Previous-year semester fields, LIS/VMS/grades, digital document evidence, guidance and property records
  // have no matching authoritative source in this application and deliberately stay blank.
  return row;
}

function makeSummaryRows(annuals, placementsByAnnual, termNumber) {
  const groups = new Map();
  for (const annual of annuals) {
    const placement = placementsByAnnual.get(Number(annual.annual_enrollment_id))?.get(termNumber);
    const strand = placement?.strand || 'Unspecified';
    const section = placement?.section_name || (placement ? 'Unassigned' : 'No placement recorded');
    const sex = annual.sex || 'Unspecified';
    const key = `${strand}\u0000${section}\u0000${sex}`;
    if (!groups.has(key)) groups.set(key, { strand, section, sex, confirmed: 0, statuses: new Map() });
    const group = groups.get(key);
    const isConfirmed = Boolean(placement && annual.confirmed === true && placement.enrollment_status === 'enrolled');
    if (isConfirmed) group.confirmed += 1;
    else {
      const status = !placement ? 'No term placement recorded' : placement.enrollment_status === 'enrolled'
        ? 'Enrollment confirmation missing' : placement.enrollment_status || annual.intake_status || 'Status unavailable';
      group.statuses.set(status, (group.statuses.get(status) || 0) + 1);
    }
  }
  const rows = [];
  const ordered = [...groups.values()].sort((a, b) => a.strand.localeCompare(b.strand) || a.section.localeCompare(b.section) || a.sex.localeCompare(b.sex));
  let confirmedTotal = 0;
  const statusTotals = new Map();
  for (const group of ordered) {
    confirmedTotal += group.confirmed;
    rows.push([group.strand, group.section, group.sex, 'Confirmed enrolled', group.confirmed]);
    for (const [status, count] of [...group.statuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      statusTotals.set(status, (statusTotals.get(status) || 0) + count);
      rows.push([group.strand, group.section, group.sex, status, count]);
    }
  }
  rows.push(['TOTAL', 'All sections', 'All sexes', 'Confirmed enrolled', confirmedTotal]);
  for (const [status, count] of [...statusTotals.entries()].sort(([a], [b]) => a.localeCompare(b))) rows.push(['TOTAL', 'All sections', 'All sexes', status, count]);
  return rows;
}

function createRegistrarMasterlistService({ getPool = defaultGetPool, sql = defaultSql, transactionFactory = (pool) => new sql.Transaction(pool) } = {}) {
  let exportBusy = false;

  async function begin(actorInput) {
    const actorId = normalizeActorId(actorInput);
    if (!actorId) throw new RegistrarMasterlistError('Your registrar access is no longer active. Sign in again.', 403);
    let transaction;
    try {
      transaction = transactionFactory(await getPool());
      await transaction.begin(sql.ISOLATION_LEVEL.REPEATABLE_READ);
      const actorResult = await transaction.request().input('actorId', sql.Int, actorId)
        .query(`SELECT id, role FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('registrar', 'database_admin')`);
      const actor = actorResult.recordset?.[0];
      if (!actor) throw new RegistrarMasterlistError('Your registrar access is no longer active. Sign in again.', 403);
      return { transaction, actor };
    } catch (cause) {
      if (transaction?.active) await transaction.rollback().catch(() => {});
      if (cause instanceof RegistrarMasterlistError) throw cause;
      throw new RegistrarMasterlistError('The enrollment masterlist is temporarily unavailable.', 503, { cause, phase: 'transaction_begin' });
    }
  }

  async function end(transaction, commit) {
    try { if (commit) await transaction.commit(); else await transaction.rollback(); }
    catch (cause) { throw new RegistrarMasterlistError('The enrollment masterlist is temporarily unavailable.', 503, { cause, phase: 'transaction_end' }); }
  }

  async function loadOptions(transaction, requested = {}) {
    const filters = parseMasterlistFilters(requested);
    const currentResult = await transaction.request().query(`SELECT DISTINCT school_year FROM academic_terms WHERE is_current = 1`);
    const currentYears = [...new Set((currentResult.recordset || []).map((row) => String(row.school_year || '').trim()).filter(Boolean))];
    const currentSchoolYear = currentYears.length === 1 ? currentYears[0] : '';
    const yearResult = await transaction.request().query(`SELECT DISTINCT school_year FROM annual_enrollments
      UNION SELECT DISTINCT school_year FROM academic_terms
      ORDER BY school_year DESC`);
    const schoolYears = [...new Set((yearResult.recordset || []).map((row) => String(row.school_year || '').trim()).filter(Boolean))];
    if (currentSchoolYear && !schoolYears.includes(currentSchoolYear)) schoolYears.unshift(currentSchoolYear);
    const selectedYear = filters.schoolYear || currentSchoolYear;
    if (selectedYear && !schoolYears.includes(selectedYear)) throw new RegistrarMasterlistError('Choose an available school year.');
    const gradeLevel = filters.gradeLevel;
    const termNumber = filters.termNumber;
    const sectionsResult = await transaction.request()
      .query(`SELECT DISTINCT section.id, section.name, section.strand, section.cluster, enrollment.annual_term_number,
          annual.school_year, annual.grade_level
        FROM annual_enrollments AS annual
        INNER JOIN enrollments AS enrollment ON enrollment.annual_enrollment_id = annual.id
        INNER JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
        WHERE enrollment.annual_term_number BETWEEN 1 AND 3
        ORDER BY annual.school_year DESC, annual.grade_level, enrollment.annual_term_number, section.name, section.id`);
    const sections = (sectionsResult.recordset || []).map((row) => ({ id: String(row.id), name: String(row.name), strand: row.strand || '', cluster: row.cluster || '', termNumber: Number(row.annual_term_number), schoolYear: String(row.school_year), gradeLevel: String(row.grade_level) }));
    if (filters.sectionId && !sections.some((section) => section.id === String(filters.sectionId)
      && section.schoolYear === selectedYear && (!gradeLevel || section.gradeLevel === gradeLevel)
      && (!termNumber || section.termNumber === termNumber))) {
      throw new RegistrarMasterlistError('Choose a section in the selected school year, grade, and term.');
    }
    return {
      schoolYears, currentSchoolYear, selectedSchoolYear: selectedYear,
      gradeLevels: ['Grade 11', 'Grade 12'], selectedGradeLevel: gradeLevel,
      selectedTermNumber: termNumber, selectedSectionId: filters.sectionId ? String(filters.sectionId) : '',
      sections, terms: [1, 2, 3], filters: { ...filters, schoolYear: selectedYear }
    };
  }

  function cohortSql() {
    return `SELECT annual.id AS annual_enrollment_id, annual.student_id, annual.school_year, annual.grade_level,
        annual.voucher_code, annual.intake_status, annual.entry_term_number,
        student.student_no, student.lrn, student.first_name, student.middle_name, student.last_name, student.suffix,
        student.sex, student.birth_date, student.birthplace, student.phone, student.facebook_name, student.address,
        student.emergency_contact_person, student.emergency_contact_relationship, student.emergency_contact_phone,
        student.emergency_contact_address, student.mother_name, student.mother_phone, student.father_name, student.father_phone,
        account.email,
        EXISTS (SELECT 1 FROM annual_registrar_confirmations AS confirmation WHERE confirmation.annual_enrollment_id = annual.id) AS confirmed
      FROM annual_enrollments AS annual
      INNER JOIN students AS student ON student.id = annual.student_id
      LEFT JOIN users AS account ON account.id = student.user_id
      WHERE annual.school_year = @schoolYear AND (@gradeLevel = '' OR annual.grade_level = @gradeLevel)
        AND ((@termNumber = 0 AND @sectionId = 0) OR EXISTS (
          SELECT 1 FROM enrollments AS selected
          WHERE selected.annual_enrollment_id = annual.id
            AND (@termNumber = 0 OR selected.annual_term_number = @termNumber)
            AND (@sectionId = 0 OR selected.section_id = @sectionId)
        ))
      `;
  }

  function bindFilters(request, options) {
    return request.input('schoolYear', sql.NVarChar(20), options.filters.schoolYear)
      .input('gradeLevel', sql.NVarChar(20), options.filters.gradeLevel || '')
      .input('termNumber', sql.TinyInt, options.filters.termNumber || 0)
      .input('sectionId', sql.Int, options.filters.sectionId || 0);
  }

  async function loadReport(transaction, options) {
    const countResult = await bindFilters(transaction.request(), options).query(`SELECT COUNT(*) AS total
      FROM annual_enrollments AS annual INNER JOIN students AS student ON student.id = annual.student_id
      WHERE annual.school_year = @schoolYear AND (@gradeLevel = '' OR annual.grade_level = @gradeLevel)
        AND ((@termNumber = 0 AND @sectionId = 0) OR EXISTS (
          SELECT 1 FROM enrollments AS selected WHERE selected.annual_enrollment_id = annual.id
            AND (@termNumber = 0 OR selected.annual_term_number = @termNumber)
            AND (@sectionId = 0 OR selected.section_id = @sectionId)))`);
    const total = Number(countResult.recordset?.[0]?.total || 0);
    if (!Number.isSafeInteger(total) || total < 0) throw new RegistrarMasterlistError('The enrollment masterlist count is unavailable.', 503);
    if (total > MAX_MASTERLIST_ROWS) throw new RegistrarMasterlistError(`The selected cohort has more than ${MAX_MASTERLIST_ROWS.toLocaleString()} students. Narrow the school year, grade, term, or section filters.`, 413);
    const annualResult = await bindFilters(transaction.request(), options).query(`${cohortSql()} ORDER BY student.last_name, student.first_name, student.id`);
    const annuals = annualResult.recordset || [];
    const placementsResult = await bindFilters(transaction.request(), options).query(`WITH cohort AS (${cohortSql()})
      SELECT enrollment.annual_enrollment_id, enrollment.annual_term_number, enrollment.enrollment_status, enrollment.enrolled_at,
        section.name AS section_name, section.strand, section.adviser, section.modality
      FROM enrollments AS enrollment INNER JOIN cohort ON cohort.annual_enrollment_id = enrollment.annual_enrollment_id
      LEFT JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = enrollment.academic_term_id
      WHERE enrollment.annual_term_number BETWEEN 1 AND 3`);
    const placementsByAnnual = new Map();
    for (const placement of placementsResult.recordset || []) {
      const annualId = Number(placement.annual_enrollment_id);
      if (!placementsByAnnual.has(annualId)) placementsByAnnual.set(annualId, new Map());
      placementsByAnnual.get(annualId).set(Number(placement.annual_term_number), placement);
    }
    const departuresResult = await bindFilters(transaction.request(), options).query(`WITH cohort AS (${cohortSql()})
      SELECT departure.annual_enrollment_id, effective.annual_term_number, departure.effective_date,
        departure.departure_type, departure.reason
      FROM finance_departure_cases AS departure
      INNER JOIN enrollments AS effective ON effective.id = departure.effective_enrollment_id
      INNER JOIN cohort ON cohort.annual_enrollment_id = departure.annual_enrollment_id`);
    const departuresByAnnual = new Map((departuresResult.recordset || []).map((departure) => [Number(departure.annual_enrollment_id), departure]));
    for (const annual of annuals) {
      annual.placements = placementsByAnnual.get(Number(annual.annual_enrollment_id)) || new Map();
      annual.departure = departuresByAnnual.get(Number(annual.annual_enrollment_id)) || null;
      annual.confirmed = annual.confirmed === true || annual.confirmed === 1 || annual.confirmed === '1';
    }
    const ids = annuals.map((annual) => Number(annual.student_id));
    let paperEvidence = new Map();
    if (ids.length) {
      const idParams = ids.map((id, index) => `@student${index}`).join(', ');
      let request = transaction.request();
      ids.forEach((id, index) => { request = request.input(`student${index}`, sql.Int, id); });
      const paperResult = await request.query(`WITH ranked AS (
        SELECT event.student_id, event.requirement_code, event.status,
          event.originals_received, event.copies_received, event.pieces_received,
          ROW_NUMBER() OVER (PARTITION BY event.student_id, event.requirement_code ORDER BY event.created_at DESC, event.id DESC) AS row_rank
        FROM student_physical_checklist_events AS event WHERE event.student_id IN (${idParams})
          AND event.requirement_code IN ('birth_certificate','grade11_card','jhs_certificate','good_moral','two_by_two_photo')
      ) SELECT student_id, requirement_code, status, originals_received, copies_received, pieces_received FROM ranked WHERE row_rank = 1`);
      paperEvidence = new Map((paperResult.recordset || []).map((row) => [`${row.student_id}:${row.requirement_code}`, {
        status: row.status, originals: row.originals_received, copies: row.copies_received, pieces: row.pieces_received
      }]));
      let form137Request = transaction.request();
      ids.forEach((id, index) => { form137Request = form137Request.input(`formStudent${index}`, sql.Int, id); });
      const form137In = ids.map((_, index) => `@formStudent${index}`).join(', ');
      const form137Result = await form137Request.query(`SELECT student_id, status FROM v_form137_latest_status_event WHERE student_id IN (${form137In})`);
      for (const row of form137Result.recordset || []) paperEvidence.set(`${row.student_id}:sf10_form137`, row.status);
    }
    const summaries = new Map([1, 2, 3].map((term) => [term, makeSummaryRows(annuals, placementsByAnnual, term)]));
    return { total, annuals, placementsByAnnual, paperEvidence, summaries };
  }

  async function writeAudit(transaction, actor, options, total) {
    const details = JSON.stringify({ schoolYear: options.filters.schoolYear, gradeLevel: options.filters.gradeLevel || null,
      termNumber: options.filters.termNumber, sectionId: options.filters.sectionId, studentCount: total });
    await transaction.request().input('actorId', sql.Int, actor.id)
      .input('action', sql.NVarChar(100), `${actor.role}.enrollment_masterlist_exported`)
      .input('entityId', sql.NVarChar(100), options.filters.schoolYear)
      .input('details', sql.NVarChar(sql.MAX), details)
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, 'enrollment_masterlist', @entityId, @details)`);
  }

  async function createWorkbook(tempDirectory, report, filters, scopeLabel) {
    const filePath = path.join(tempDirectory, 'enrollment-masterlist.xlsx');
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true, useSharedStrings: false });
    workbook.creator = 'ARKTIESIIS';
    workbook.subject = `Enrollment masterlist ${filters.schoolYear} ${filters.gradeLevel || 'all grades'}`;
    workbook.created = new Date();
    const overall = workbook.addWorksheet('Overall masterlist', {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 3, topLeftCell: 'B4', activePane: 'bottomRight' }],
      pageSetup: { paperSize: 8, orientation: 'landscape', scale: 100, fitToPage: false, horizontalDpi: 300, verticalDpi: 300 }
    });
    overall.properties.defaultRowHeight = 27;
    overall.pageSetup.margins = { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
    overall.pageSetup.printTitlesRow = '1:3';
    overall.columns = COL_WIDTHS.map((width, index) => ({ key: `col${index + 1}`, width, style: { alignment: { vertical: 'middle', wrapText: true } } }));
    const scope = overall.addRow(Array(70).fill(''));
    overall.mergeCells(1, 1, 1, 70);
    scope.height = 25;
    const scopeCell = scope.getCell(1);
    scopeCell.value = scopeLabel;
    scopeCell.font = { name: 'Aptos', size: 12, bold: true, color: { argb: 'FF17343A' } };
    scopeCell.alignment = { vertical: 'middle', wrapText: true };
    scopeCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F6F5' } };
    scope.commit();
    const group = overall.addRow(Array(70).fill(''));
    group.height = 25;
    for (const [from, to, title] of HEADER_GROUPS) {
      overall.mergeCells(2, from, 2, to);
      const cell = group.getCell(from);
      cell.value = title;
      cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF244548' } };
      for (let col = from; col <= to; col += 1) {
        const headerCell = group.getCell(col);
        headerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF244548' } };
        headerCell.border = { bottom: { style: 'thin', color: { argb: 'FF98B4AD' } } };
      }
    }
    group.commit();
    const headings = overall.addRow(COL_HEADERS);
    headings.height = 52;
    for (let col = 1; col <= 70; col += 1) {
      const cell = headings.getCell(col);
      cell.font = { name: 'Aptos', size: 9, bold: true, color: { argb: 'FF17343A' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4EFEC' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF91A8A2' } } };
    }
    headings.commit();
    let index = 0;
    for (const annual of report.annuals) {
      index += 1;
      const values = buildOverallRow(annual, index, report.paperEvidence);
      const row = overall.addRow(values);
      row.height = 22;
      for (let col = 1; col <= 70; col += 1) {
        const cell = row.getCell(col);
        cell.alignment = { vertical: 'top', wrapText: true };
        if (col === 1 || [19, 24, 31, 38, 66, 68, 70].includes(col)) cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        if (typeof cell.value === 'string') {
          cell.value = asLiteral(cell.value);
          cell.numFmt = '@';
        }
        if ([19, 24, 31, 38].includes(col) && cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd';
        if (index % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FAF9' } };
      }
      row.commit();
    }
    const lastRow = Math.max(3, report.annuals.length + 3);
    overall.autoFilter = { from: { row: 3, column: 1 }, to: { row: lastRow, column: 70 } };
    overall.commit();

    for (let termNumber = 1; termNumber <= 3; termNumber += 1) {
      const sheet = workbook.addWorksheet(`Term ${termNumber} summary`, { views: [{ state: 'frozen', ySplit: 2, topLeftCell: 'A3', activePane: 'bottomLeft' }] });
      sheet.columns = [{ key: 'strand', width: 22 }, { key: 'section', width: 28 },
        { key: 'sex', width: 18 }, { key: 'status', width: 28 },
        { key: 'count', width: 18, style: { numFmt: '0' } }];
      const titleRow = sheet.addRow([`Term ${termNumber} summary · ${scopeLabel}`]);
      sheet.mergeCells(1, 1, 1, 5);
      titleRow.height = 28;
      titleRow.getCell(1).font = { name: 'Aptos', size: 12, bold: true, color: { argb: 'FF17343A' } };
      titleRow.getCell(1).alignment = { vertical: 'middle', wrapText: true };
      titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F6F5' } };
      titleRow.commit();
      const headings = sheet.addRow(['Strand', 'Section', 'Sex', 'Enrollment status', 'Student count']);
      headings.height = 34;
      headings.eachCell((cell) => {
        cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF244548' } };
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
      headings.commit();
      for (const summaryRow of report.summaries.get(termNumber) || []) {
        const row = sheet.addRow(summaryRow);
        row.eachCell((cell, column) => {
          cell.alignment = { vertical: 'top', wrapText: true };
          if (column === 5) cell.numFmt = '0';
          else if (typeof cell.value === 'string') cell.numFmt = '@';
        });
        row.commit();
      }
      sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: Math.max(2, (report.summaries.get(termNumber) || []).length + 2), column: 5 } };
      sheet.pageSetup.printTitlesRow = '1:2';
      sheet.pageSetup = { paperSize: 8, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
      sheet.commit();
    }
    await workbook.commit();
    return filePath;
  }

  async function getFilterOptions(actorInput, input = {}) {
    const { transaction } = await begin(actorInput);
    try {
      const options = await loadOptions(transaction, input);
      await end(transaction, true);
      return options;
    } catch (error) {
      if (transaction.active) await end(transaction, false).catch(() => {});
      if (error instanceof RegistrarMasterlistError) throw error;
      throw new RegistrarMasterlistError('Masterlist filter options could not be loaded.', 503, { cause: error, phase: 'options' });
    }
  }

  async function generateExport(actorInput, input = {}) {
    if (exportBusy) throw new RegistrarMasterlistError('Another enrollment masterlist is being prepared. Try again shortly.', 429);
    exportBusy = true;
    let tempDirectory;
    let transaction;
    try {
      const started = await begin(actorInput);
      transaction = started.transaction;
      const options = await loadOptions(transaction, input);
      if (!options.selectedSchoolYear) throw new RegistrarMasterlistError('Choose an available school year before exporting.', 409);
      const report = await loadReport(transaction, options);
      tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'arktiesiis-masterlist-'));
      const section = options.sections.find((item) => item.id === String(options.filters.sectionId || ''));
      const cohortLabel = [options.filters.termNumber ? `Term ${options.filters.termNumber}` : 'All terms',
        section ? `${section.name}${section.strand ? ` · ${section.strand}` : ''}` : null].filter(Boolean).join(' · ');
      const scopeLabel = `School Year ${options.filters.schoolYear} · ${options.filters.gradeLevel || 'Grade 12'} · Cohort: ${cohortLabel}`;
      const filePath = await createWorkbook(tempDirectory, report, options.filters, scopeLabel);
      await writeAudit(transaction, started.actor, options, report.total);
      await end(transaction, true);
      transaction = null;
      return { filePath, rowCount: report.total, filters: options.filters, cleanup: () => fs.rm(tempDirectory, { recursive: true, force: true }) };
    } catch (error) {
      if (transaction?.active) await end(transaction, false).catch(() => {});
      if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
      if (error instanceof RegistrarMasterlistError) throw error;
      throw new RegistrarMasterlistError('The enrollment masterlist could not be generated.', 503, { cause: error, phase: 'export' });
    } finally {
      exportBusy = false;
    }
  }

  return { getFilterOptions, generateExport };
}

module.exports = { MAX_MASTERLIST_ROWS, COL_HEADERS, RegistrarMasterlistError, parseMasterlistFilters, databaseDateToExcel, databaseTimestampToManilaExcel, buildOverallRow, makeSummaryRows, createRegistrarMasterlistService };
