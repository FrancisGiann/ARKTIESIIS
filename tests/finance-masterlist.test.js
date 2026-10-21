'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {
  FinanceMasterlistError, parseMasterlistFilters, buildMasterlistProjection, createFinanceMasterlistService
} = require('../src/services/financeMasterlistService');
const { createCsvColumns, csvHeader, csvRow, neutralizeSpreadsheetText } = require('../src/utils/financeMasterlistCsv');

function annualRow(id, overrides = {}) {
  return {
    annual_enrollment_id: id, student_id: id, school_year: '2026-2027', grade_level: 'Grade 10',
    voucher_code: 'NV', intake_status: 'enrolled', student_no: `SHS-2026-${String(id).padStart(4, '0')}`,
    lrn: String(id).padStart(12, '0'), first_name: 'Alex', middle_name: '', last_name: `Student ${String(id).padStart(3, '0')}`,
    suffix: '', assessment_id: 100 + id, schedule_version: 1, selection_json: '{"optionalLineIds":[]}',
    confirmation_id: 200 + id, enrollment_id: 300 + id, annual_term_number: 1, term_label: 'Term 1',
    section_id: 11, section_name: 'Section A', section_strand: 'STEM', section_adviser: 'Adviser',
    enrollment_status: 'enrolled', term_scope_status: 'applicable', finance_clearance: 'signed',
    finance_clearance_date: '2026-08-01 00:00:00', ...overrides
  };
}

function charge(id, annualId, overrides = {}) {
  return {
    charge_id: id, annual_enrollment_id: annualId, term_number: 1, fee_category: 'tuition',
    line_name: 'Tuition', installment: 'DP', schedule_line_id: 10, is_optional: 0,
    gross_amount: '100.00', waived_amount: '10.00', adjustments_amount: '0.00',
    required_amount: '90.00', applied_amount: '20.00', balance_amount: '70.00', ...overrides
  };
}

function termRows(id, overrides = {}) {
  return [1, 2, 3].map((termNumber) => annualRow(id, {
    enrollment_id: id * 10 + termNumber, annual_term_number: termNumber,
    term_label: `Term ${termNumber}`, section_id: termNumber === 1 ? 11 : 22,
    section_name: termNumber === 1 ? 'Section A' : 'Section B',
    enrollment_status: 'enrolled', term_scope_status: 'applicable', ...overrides,
    ...(overrides.termRows?.[termNumber] || {})
  }));
}

function projection(annualRows, chargeRows = [], configuredLines = [], historyRows = [], accountRows = [], page = 1) {
  return buildMasterlistProjection({ annualRows, chargeRows, configuredLines, historyRows, accountRows }, {
    schoolYear: '2026-2027', gradeLevel: '', voucherCode: '', search: '', section: '', placementTerm: 1, page
  });
}

test('filters reject unbounded, malformed, or unsupported values before database access', () => {
  assert.deepEqual(parseMasterlistFilters({ placementTerm: '3', voucherCode: 'ESC', section: 'unassigned', page: '7' }), {
    schoolYear: null, gradeLevel: '', voucherCode: 'ESC', search: '', section: 'unassigned', cluster: '', strand: '',
    status: '', financeStatus: '', installment: 'whole', termId: '', placementTerm: 3, page: 7
  });
  assert.equal(parseMasterlistFilters({ schoolYear: '' }).schoolYear, 'all', 'empty year keeps the legacy all-years meaning');
  assert.equal(parseMasterlistFilters({ schoolYear: 'all' }).schoolYear, 'all');
  assert.equal(parseMasterlistFilters({ sectionId: '12' }).section, '12');
  assert.throws(() => parseMasterlistFilters({ section: '12', sectionId: '13' }), FinanceMasterlistError);
  assert.throws(() => parseMasterlistFilters({ financeStatus: 'paid' }), FinanceMasterlistError);
  assert.throws(() => parseMasterlistFilters({ installment: 'unexpected' }), FinanceMasterlistError);
  for (const filters of [
    { page: '0' }, { page: '1e5' }, { placementTerm: '4' }, { voucherCode: 'ALL' },
    { section: '11 OR 1=1' }, { search: 'x'.repeat(101) }, { schoolYear: ['2026-2027'] }
  ]) assert.throws(() => parseMasterlistFilters(filters), FinanceMasterlistError);
});

test('annual projection keeps one row per annual account, all terms, status, and term-specific sections', () => {
  const rows = termRows(1, { intake_status: 'pending', enrollment_status: 'dropped' });
  rows[1] = { ...rows[1], section_id: 33, section_name: 'Section C', section_strand: 'ABM', enrollment_status: 'transferred' };
  rows[2] = { ...rows[2], section_id: null, section_name: null, term_scope_status: 'not_applicable' };
  const result = projection(rows, [charge(1, 1)]);
  assert.equal(result.totalRecords, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].terms[1].section, 'Section A · STEM');
  assert.equal(result.rows[0].terms[2].section, 'Section C · ABM');
  assert.equal(result.rows[0].terms[2].enrollmentStatus, 'transferred');
  assert.equal(result.rows[0].terms[3].status, 'Not applicable');
  assert.equal(result.rows[0].terms[3].paymentAvailability, 'not_applicable');
  assert.deepEqual(result.counts[1], {
    fullyPaid: 0, partiallyPaid: 1, unpaid: 0, noPaymentRequired: 0, unavailable: 0, notApplicable: 0
  });
  assert.equal(result.counts[3].notApplicable, 1);
  assert.equal(result.rows[0].readiness, 'Pending intake');
});

test('money stays in cents; prior years, opening liability, legacy balance, and credit stay separate', () => {
  const annualRows = termRows(1);
  const charges = [
    charge(1, 1, { required_amount: '90.01', applied_amount: '20.01', balance_amount: '70.00' }),
    charge(2, 1, { term_number: 2, required_amount: '11.11', applied_amount: '1.11', balance_amount: '10.00' })
  ];
  const result = projection(annualRows, charges, [], [
    { student_id: 1, school_year: '2025-2026', assessment_id: 91, confirmation_id: 92, assessed_charge_count: 1, balance_amount: '15.50' }
  ], [{ student_id: 1, unattributed_legacy_balance: '3.00', opening_liability_due: '4.00', available_credit: '2.00' }]);
  const row = result.rows[0];
  const termTotal = [row.terms[1].balance, row.terms[2].balance].reduce((sum, amount) => sum + Math.round(Number(amount) * 100), 0);
  assert.equal(row.selectedYearBalance, '80.00');
  assert.equal(row.selectedYearBalance, (termTotal / 100).toFixed(2));
  assert.equal(row.earlierYearBalance, '15.50');
  assert.equal(row.earlierAccountBalance, '3.00');
  assert.equal(row.openingLiability, '4.00');
  assert.equal(row.unusedPaymentCredit, '2.00');
});

test('saved zero, optional fee, missing assessment, incomplete tuition split, waiver and missing confirmation stay distinct', () => {
  const configured = [
    { annual_enrollment_id: 1, schedule_line_id: 10, term_number: 1, fee_category: 'tuition', line_name: 'Tuition', installment: 'DP', amount: '100.00', is_optional: 0 },
    { annual_enrollment_id: 1, schedule_line_id: 11, term_number: 1, fee_category: 'miscellaneous', line_name: 'Activity', installment: 'Whole term', amount: '0.00', is_optional: 0 },
    { annual_enrollment_id: 1, schedule_line_id: 12, term_number: 1, fee_category: 'miscellaneous', line_name: 'Club', installment: 'Whole term', amount: '20.00', is_optional: 1 },
    { annual_enrollment_id: 1, schedule_line_id: 13, term_number: 2, fee_category: 'tuition', line_name: 'Tuition', installment: 'DP', amount: '100.00', is_optional: 0 },
    { annual_enrollment_id: 1, schedule_line_id: 15, term_number: 2, fee_category: 'miscellaneous', line_name: 'No assessed zero', installment: 'Whole term', amount: '0.00', is_optional: 0 },
    { annual_enrollment_id: 2, schedule_line_id: 14, term_number: 1, fee_category: 'miscellaneous', line_name: 'Contribution', installment: 'Whole term', amount: '50.00', is_optional: 0 }
  ];
  const annualRows = [annualRow(1), annualRow(1, {
    enrollment_id: 12, annual_term_number: 2
  }), annualRow(2, { enrollment_id: 21, confirmation_id: null })];
  const charges = [
    charge(1, 1, { gross_amount: '100.00', waived_amount: '10.00', required_amount: '90.00', applied_amount: '20.00', balance_amount: '70.00' }),
    charge(2, 1, { fee_category: 'miscellaneous', line_name: 'Activity', installment: 'Whole term', schedule_line_id: 11,
      gross_amount: '0.00', waived_amount: '0.00', required_amount: '0.00', applied_amount: '0.00', balance_amount: '0.00' }),
    charge(3, 2, { term_number: 1, fee_category: 'miscellaneous', line_name: 'Contribution', installment: 'Whole term',
      schedule_line_id: 14, required_amount: '50.00', applied_amount: '4.00', balance_amount: '46.00' })
  ];
  const result = projection(annualRows, charges, configured);
  const row = result.rows[0];
  const cell = (account, term, category, name, installment) => account.terms[term].fees[JSON.stringify([category, name, installment])];
  const unconfirmed = result.rows.find((annual) => annual.annualEnrollmentId === 2);
  assert.equal(cell(row, 1, 'tuition', 'tuition', 'dp').status, 'Partially paid');
  assert.equal(cell(row, 1, 'tuition', 'tuition', 'dp').coverage, '10.00');
  assert.equal(cell(row, 1, 'tuition', 'tuition', 'prelim').status, 'Installment detail missing');
  assert.equal(cell(row, 1, 'tuition', 'tuition', 'midterm').status, 'Installment detail missing');
  assert.equal(cell(row, 1, 'tuition', 'tuition', 'finals').status, 'Installment detail missing');
  assert.equal(cell(row, 1, 'miscellaneous', 'activity', 'whole term').status, 'Configured zero');
  assert.equal(cell(row, 1, 'miscellaneous', 'club', 'whole term').status, 'Optional not selected');
  assert.equal(row.terms[1].otherFees.status, 'No payment required', 'an unrelated cohort fee placeholder does not make this student appear unavailable');
  assert.equal(cell(unconfirmed, 1, 'miscellaneous', 'contribution', 'whole term').status, 'Unavailable');
  assert.equal(cell(unconfirmed, 1, 'miscellaneous', 'contribution', 'whole term').balance, '46.00', 'known payable balance is preserved while confirmation is missing');
  assert.equal(cell(row, 2, 'tuition', 'tuition', 'dp').status, 'Missing assessment detail');
  assert.equal(cell(row, 2, 'miscellaneous', 'no assessed zero', 'whole term').status, 'Missing assessment detail',
    'a zero schedule amount without an assessed charge is not configured zero');

  const missing = projection([annualRow(2, { assessment_id: null, confirmation_id: null })]);
  assert.equal(missing.rows[0].selectedYearBalance, null);
  assert.equal(missing.rows[0].terms[1].status, 'Unavailable — no assessment');
  assert.equal(missing.rows[0].terms[1].fees[JSON.stringify(['tuition', 'tuition', 'dp'])].status, 'No assessment');
});

test('dynamic columns, counts, and full-row export data are based on the whole filtered cohort', () => {
  const annualRows = Array.from({ length: 51 }, (_, index) => annualRow(index + 1));
  annualRows.push(annualRow(51, { enrollment_id: 531, annual_term_number: 1 }));
  const charges = [charge(999, 51, { fee_category: 'miscellaneous', line_name: 'Late cohort fee', installment: 'Whole term' })];
  const firstPage = projection(annualRows, charges, [], [], [], 1);
  const thirdPage = projection(annualRows, charges, [], [], [], 3);
  assert.equal(firstPage.rows.length, 20);
  assert.equal(thirdPage.rows.length, 11);
  assert.equal(firstPage.allRows.length, 51);
  assert.equal(firstPage.termColumns[1].some((column) => column.lineName === 'Late cohort fee'), true);
  assert.deepEqual(firstPage.counts, thirdPage.counts);
  assert.equal(firstPage.filters.page, 1);
  assert.equal(thirdPage.filters.page, 3);
  const outOfRangePage = projection(annualRows, [], [], [], [], 100);
  assert.equal(outOfRangePage.filters.page, 3);
  assert.equal(outOfRangePage.rows.length, 11);
});

test('all-years projection preserves distinct annual accounts and exports school-year identity', () => {
  const newer = annualRow(1, { school_year: '2026-2027' });
  const older = annualRow(2, { student_id: 1, school_year: '2025-2026', student_no: newer.student_no, lrn: newer.lrn });
  const result = buildMasterlistProjection({ annualRows: [newer, older] }, {
    schoolYear: 'all', gradeLevel: '', voucherCode: '', search: '', section: '', placementTerm: 1, page: 1
  });
  assert.equal(result.totalRecords, 2);
  assert.deepEqual(new Set(result.allRows.map((row) => row.schoolYear)), new Set(['2025-2026', '2026-2027']));
  const schoolYearColumn = createCsvColumns(result).find((column) => column.heading === 'School year');
  assert.deepEqual(result.rows.map((row) => schoolYearColumn.read(row)), result.rows.map((row) => row.schoolYear));
});

test('legacy whole-term tuition keeps its saved total outside the combined other-fee summary', () => {
  const annual = annualRow(8);
  const legacy = charge(81, 8, {
    fee_category: 'tuition', line_name: 'Tuition', installment: 'Whole term', schedule_line_id: 81,
    gross_amount: '500.00', waived_amount: '25.00', required_amount: '475.00', applied_amount: '125.00', balance_amount: '350.00'
  });
  const result = projection([annual], [legacy]);
  const row = result.rows[0];
  const legacyCell = row.terms[1].fees[JSON.stringify(['tuition', 'tuition', 'whole term'])];
  assert.equal(legacyCell.status, 'Partially paid');
  assert.equal(legacyCell.applied, '125.00');
  assert.equal(legacyCell.balance, '350.00');
  assert.equal(row.terms[1].otherFees.status, 'No other fees recorded');
  assert.equal(row.terms[1].otherFees.balance, null);
});

test('CSV and screen share fee application data; spreadsheet text is escaped and LRN zeros are preserved', () => {
  const annual = annualRow(1, { first_name: '=1+1', lrn: '000012345678', student_no: 'SHS, "A"\n1' });
  const chargeRow = charge(1, 1, { reference_no: '=HYPERLINK("x")' });
  const result = projection([annual], [chargeRow]);
  const row = result.rows[0];
  row.terms[1].fees[JSON.stringify(['tuition', 'tuition', 'dp'])].applications.push({
    type: 'Payment', date: '2026-08-12', reference: '=HYPERLINK("x")', original: '20.00',
    current: '15.00', released: '5.00', receiptIssued: true, reversed: false
  });
  const columns = createCsvColumns(result);
  const output = `${csvHeader(columns)}${csvRow(row, columns)}`;
  assert.match(output, /"'=1\+1 Student 001"/);
  assert.match(output, /"'000012345678"/);
  assert.match(output, /"SHS, ""A""\n1"/);
  assert.match(output, /Reference: '=HYPERLINK/);
  assert.match(output, /"70\.00"/);
  assert.match(output, /"Payment; 2026-08-12; Reference: '=HYPERLINK/);
  assert.equal(neutralizeSpreadsheetText(' -4.50'), "' -4.50");
  assert.equal(neutralizeSpreadsheetText('20.00'), '20.00', 'numeric money is kept as a numeric CSV value');
  assert.match(csvHeader([{ heading: '=danger', kind: 'text' }]), /"'=danger"/);
});

test('rendered Student accounts page exposes compact installment cells and targeted details', async () => {
  const result = projection([annualRow(1)], [charge(1, 1, { applied_amount: '15.00', balance_amount: '75.00' })]);
  const row = result.rows[0];
  row.terms[1].fees[JSON.stringify(['tuition', 'tuition', 'dp'])].applications.push({
    type: 'Payment', date: '2026-08-12', reference: 'RCPT-54321', original: '20.00',
    current: '15.00', released: '5.00', recordedReleased: '8.00', originalPurpose: 'Original whole-term tuition · 2026-2027 · Term 1 · Tuition',
    restatementHistory: 'Original assessment allocation release remains in history.', receiptIssued: true, reversed: false
  });
  const masterlist = {
    ...result,
    options: { schoolYears: ['2026-2027'], grades: ['Grade 10'], sections: [{ id: '11', label: 'Section A' }], placementTerms: [1, 2, 3] }
  };
  const html = await ejs.renderFile(path.join(__dirname, '../views/finance/masterlist.ejs'), {
    title: 'Student accounts', currentUser: { id: 7, role: 'finance' }, csrfToken: '',
    navigationItems: [{ id: 'finance-roster', label: 'Student accounts', href: '/finance', current: true }],
    navigationGroups: [], masterlist
  });
  const columns = createCsvColumns(result);
  const csv = `${csvHeader(columns)}${csvRow(row, columns)}`;
  assert.match(html, /<h1>Student accounts<\/h1>/);
  assert.match(html, /<form method="get" action="\/finance"/);
  assert.match(html, /class="button button--primary finance-accounts-apply-button" type="submit">Apply filters<\/button>/);
  assert.match(html, /id="finance-masterlist-filters" class="finance-accounts-filter-disclosure"/);
  assert.match(html, /<summary><strong>Filters<\/strong><\/summary>/);
  assert.match(html, /<strong>2026-2027<\/strong><span>Term 1<\/span><span>1 matching annual accounts<\/span>/);
  assert.doesNotMatch(html, /<details id="finance-masterlist-filters"[^>]*open/);
  assert.doesNotMatch(html, /<summary>More filters<\/summary>/);
  assert.doesNotMatch(html.match(/<details id="finance-masterlist-filters"[\s\S]*?<\/details>/)?.[0] || '', /type="submit"/);
  assert.match(html, /<th scope="col">DP<\/th><th scope="col">Prelim<\/th><th scope="col">Midterm<\/th><th scope="col">Finals<\/th>/);
  assert.match(html, /href="\/finance\/students\/1\/annual\?backSchoolYear=2026-2027&amp;backPlacementTerm=1/);
  assert.match(html, /RCPT-54321/);
  assert.match(html, /Original ₱20\.00 · Applied ₱15\.00 · Current release ₱5\.00/);
  assert.match(html, /Original whole-term tuition · 2026-2027 · Term 1 · Tuition/);
  assert.match(html, /Recorded release ₱8\.00 \(historical\)/);
  assert.match(html, /aria-controls="finance-account-details-1-dp"/);
  assert.match(html, /id="finance-account-details-1-dp"[^>]*data-finance-account-panel="dp" hidden/);
  assert.match(html, /id="finance-account-details-1-account"[^>]*data-finance-account-panel="account" hidden/);
  const identityCell = html.match(/<td class="finance-accounts-student"[\s\S]*?<\/td>/)?.[0] || '';
  assert.doesNotMatch(identityCell, /LRN 000012345678/);
  assert.match(html, /<dt>LRN<\/dt><dd>000000000001<\/dd>/);
  const activeAccountActions = identityCell.match(/<div class="finance-account-actions">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.match(activeAccountActions, /class="button button--primary" href="[^"]*view=payments#payment-record-title">Record payment<\/a>/,
    'an assessed, payment-available row gets the primary payment action');
  assert.doesNotMatch(activeAccountActions, /Review assessment/,
    'an ordinary active assessed row does not show a redundant review action');
  assert.match(csv, /Reference: RCPT-54321/);
  assert.match(csv, /Original 20\.00; Applied 15\.00; Released 5\.00/);
  assert.match(csv, /Original purpose: Original whole-term tuition/);
  assert.match(csv, /Recorded release 8\.00 \(historical\)/);
  assert.match(csv, /"School year"/);
  assert.doesNotMatch(html, /Test decision|Registrar confirmation is missing/);

  const unassessedProjection = projection([annualRow(3, {
    assessment_id: null, confirmation_id: null, intake_status: 'pending'
  })]);
  const unassessedHtml = await ejs.renderFile(path.join(__dirname, '../views/finance/masterlist.ejs'), {
    title: 'Student accounts', currentUser: { id: 7, role: 'finance' }, csrfToken: '',
    navigationItems: [{ id: 'finance-roster', label: 'Student accounts', href: '/finance', current: true }],
    navigationGroups: [], masterlist: {
      ...unassessedProjection,
      options: { schoolYears: ['2026-2027'], grades: ['Grade 10'], sections: [{ id: '11', label: 'Section A' }], placementTerms: [1, 2, 3] }
    }
  });
  const unassessedRow = unassessedHtml.match(/<tr class="finance-accounts-row">[\s\S]*?<\/tr>/)?.[0] || '';
  assert.match(unassessedRow, /class="button button--primary" href="\/finance\/students\/3\/annual\?backSchoolYear=2026-2027&amp;backPlacementTerm=1&amp;backPage=1&amp;view=charges#assessment-3">Review assessment<\/a>/);
  assert.doesNotMatch(unassessedRow, /Record payment/);
  assert.match(unassessedRow, /<span>Applied —<\/span><span>Balance —<\/span>/,
    'a missing assessment displays unavailable amounts instead of zeros');
  assert.match(unassessedRow, /class="finance-accounts-term-balance"[^>]*><strong>—<\/strong>/);

  const pendingAssessmentProjection = projection([annualRow(4, {
    intake_status: 'pending', confirmation_id: null
  })], [charge(401, 4)]);
  const pendingAssessmentHtml = await ejs.renderFile(path.join(__dirname, '../views/finance/masterlist.ejs'), {
    title: 'Student accounts', currentUser: { id: 7, role: 'finance' }, csrfToken: '',
    navigationItems: [{ id: 'finance-roster', label: 'Student accounts', href: '/finance', current: true }],
    navigationGroups: [], masterlist: {
      ...pendingAssessmentProjection,
      options: { schoolYears: ['2026-2027'], grades: ['Grade 10'], sections: [{ id: '11', label: 'Section A' }], placementTerms: [1, 2, 3] }
    }
  });
  const pendingAssessmentRow = pendingAssessmentHtml.match(/<tr class="finance-accounts-row">[\s\S]*?<\/tr>/)?.[0] || '';
  assert.match(pendingAssessmentRow, /class="button button--primary" href="\/finance\/students\/4\/annual\?backSchoolYear=2026-2027&amp;backPlacementTerm=1&amp;backPage=1&amp;view=charges#assessment-review-4">Review assessment<\/a>/);
  assert.match(pendingAssessmentRow, /class="button button--secondary" href="\/finance\/students\/4\/annual\?backSchoolYear=2026-2027&amp;backPlacementTerm=1&amp;backPage=1&amp;view=payments#payment-record-title">Record payment<\/a>/,
    'pending entry-term DP remains reachable before Registrar confirmation, while assessment review stays primary');

  const mixedResult = projection([annualRow(2)], [
    charge(201, 2, { applied_amount: '10.00', balance_amount: '80.00' }),
    charge(202, 2, { installment: 'Whole term', schedule_line_id: 11, gross_amount: '40.00', required_amount: '40.00', applied_amount: '5.00', balance_amount: '35.00' })
  ]);
  const mixedHtml = await ejs.renderFile(path.join(__dirname, '../views/finance/masterlist.ejs'), {
    title: 'Student accounts', currentUser: { id: 7, role: 'finance' }, csrfToken: '',
    navigationItems: [{ id: 'finance-roster', label: 'Student accounts', href: '/finance', current: true }],
    navigationGroups: [], masterlist: {
      ...mixedResult,
      options: { schoolYears: ['2026-2027'], grades: ['Grade 10'], sections: [{ id: '11', label: 'Section A' }], placementTerms: [1, 2, 3] }
    }
  });
  const mixedRow = mixedHtml.match(/<tr class="finance-accounts-row">[\s\S]*?<\/tr>/)?.[0] || '';
  assert.match(mixedRow, /aria-controls="finance-account-details-2-dp"/);
  assert.doesNotMatch(mixedRow, /colspan="4"/);
  assert.match(mixedRow, /aria-controls="finance-account-details-2-whole-tuition"/,
    'a saved whole-term tuition detail remains directly reachable beside canonical installment cells');
  assert.match(mixedHtml, /Whole-term tuition · Term 1/);
  assert.doesNotMatch(mixedHtml, /shown under Other fees without an installment split/);
});

test('changing year or placement term disables stale grade and section filters until refreshed options load', () => {
  const listeners = new Map();
  const element = (id, value = '') => ({
    id, value, disabled: false, hidden: true, textContent: '', attributes: {},
    addEventListener(name, handler) { listeners.set(`${id}:${name}`, handler); },
    setAttribute(name, attributeValue) { this.attributes[name] = attributeValue; }
  });
  const schoolYear = element('finance-masterlist-year', '2027-2028');
  const grade = element('finance-masterlist-grade', 'Grade 10');
  const placementTerm = element('finance-masterlist-term', '2');
  const section = element('finance-masterlist-section', '42');
  const gradeHelp = element('finance-masterlist-grade-help');
  const sectionLabel = element('finance-masterlist-section-label');
  const sectionHelp = element('finance-masterlist-section-help');
  const fields = new Map([
    ['#finance-masterlist-year', schoolYear], ['#finance-masterlist-grade', grade],
    ['#finance-masterlist-term', placementTerm], ['#finance-masterlist-section', section],
    ['#finance-masterlist-grade-help', gradeHelp], ['#finance-masterlist-section-label', sectionLabel],
    ['#finance-masterlist-section-help', sectionHelp]
  ]);
  const form = { querySelector: (selector) => fields.get(selector) || null };
  const script = fs.readFileSync(path.join(__dirname, '../public/js/finance-masterlist-filters.js'), 'utf8');
  vm.runInNewContext(script, { document: { querySelector: () => form } });
  assert.equal(section.disabled, false, 'normal page load leaves server-rendered sections available');
  assert.equal(grade.disabled, false, 'normal page load leaves server-rendered grades available');

  listeners.get('finance-masterlist-term:change')();
  assert.equal(section.value, '');
  assert.equal(section.disabled, true);
  assert.equal(sectionLabel.textContent, 'Section in Term 2');
  assert.equal(sectionHelp.textContent, 'Apply filters to load sections for Term 2.');
  assert.equal(section.attributes['aria-describedby'], sectionHelp.id);
  assert.equal(grade.disabled, false, 'term changes do not invalidate the school-year grade list');

  listeners.get('finance-masterlist-year:change')();
  assert.equal(grade.value, '');
  assert.equal(grade.disabled, true);
  assert.equal(gradeHelp.textContent, 'Apply filters to load grades for school year 2027-2028.');
  assert.equal(grade.attributes['aria-describedby'], gradeHelp.id);
  assert.equal(section.disabled, true, 'year changes also keep the previous section options unavailable');
});

test('installment disclosure switches to its targeted panel and updates only its trigger', () => {
  const listeners = new Map();
  const panels = ['account', 'dp', 'prelim', 'midterm', 'finals', 'other'].map((key) => ({ id: `account-${key}`, hidden: true }));
  const detailRow = {
    hidden: true,
    querySelector(selector) { return selector === '[data-finance-account-panel]:not([hidden])' ? panels.find((panel) => !panel.hidden) || null : null; },
    querySelectorAll() { return panels; }
  };
  const buttons = ['dp', 'prelim', 'account'].map((key) => ({
    dataset: { financeAccountRow: 'details' }, attributes: { 'aria-controls': `account-${key}`, 'aria-expanded': 'false' },
    addEventListener(name, handler) { listeners.set(`${key}:${name}`, handler); },
    getAttribute(name) { return this.attributes[name]; },
    setAttribute(name, value) { this.attributes[name] = value; }
  }));
  const byId = new Map([['details', detailRow], ...panels.map((panel) => [panel.id, panel])]);
  const script = fs.readFileSync(path.join(__dirname, '../public/js/finance-masterlist-filters.js'), 'utf8');
  vm.runInNewContext(script, { document: { querySelector: () => null, querySelectorAll: () => buttons, getElementById: (id) => byId.get(id) || null } });
  listeners.get('dp:click')();
  assert.equal(detailRow.hidden, false);
  assert.equal(panels.find((panel) => panel.id === 'account-dp').hidden, false);
  assert.equal(buttons[0].attributes['aria-expanded'], 'true');
  assert.equal(buttons[1].attributes['aria-expanded'], 'false');
  listeners.get('prelim:click')();
  assert.equal(panels.find((panel) => panel.id === 'account-dp').hidden, true);
  assert.equal(panels.find((panel) => panel.id === 'account-prelim').hidden, false);
  assert.equal(buttons[0].attributes['aria-expanded'], 'false');
  assert.equal(buttons[1].attributes['aria-expanded'], 'true');
  listeners.get('prelim:click')();
  assert.equal(detailRow.hidden, true);
  assert.ok(panels.every((panel) => panel.hidden));
  assert.ok(buttons.every((button) => button.attributes['aria-expanded'] === 'false'));
});

function mockMasterlistDatabase({ authorized = true, currentTerms = [{ school_year: '2026-2027', term_number: 2 }], schoolYears = [] } = {}) {
  const calls = [];
  const transaction = {
    active: false,
    async begin(level) { this.active = true; this.level = level; },
    async commit() { this.active = false; this.committed = true; },
    async rollback() { this.active = false; this.rolledBack = true; },
    request() {
      const params = {};
      return {
        input(name, _type, value) { params[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, params: { ...params } });
          if (statement.includes('FROM users WHERE id = @actorId')) return { recordset: authorized ? [{ id: 1 }] : [] };
          if (statement.includes('FROM academic_terms AS term') && statement.includes('WHERE term.is_current = 1')) return { recordset: currentTerms };
          if (statement.includes('FROM academic_terms AS term') && statement.includes('WHERE term.id = @termId')) return { recordset: [{ school_year: '2026-2027', term_number: 2, term: 'Term 2' }] };
          if (statement.includes('SELECT DISTINCT school_year')) return { recordset: schoolYears.map((school_year) => ({ school_year })) };
          return { recordset: [] };
        }
      };
    }
  };
  const sql = {
    ISOLATION_LEVEL: { REPEATABLE_READ: 'REPEATABLE_READ' },
    NVarChar: (length) => `NVarChar(${length})`, VarChar: (length) => `VarChar(${length})`,
    TinyInt: 'TinyInt', Int: 'Int'
  };
  return { calls, transaction, sql, service: createFinanceMasterlistService({
    getPool: async () => ({}), sql, transactionFactory: () => transaction
  }) };
}

test('service rechecks Finance roles, binds filter text, supports an empty configured current year, and never mutates', async () => {
  const rejected = mockMasterlistDatabase({ authorized: false });
  await assert.rejects(rejected.service.list(7, { schoolYear: '2026-2027' }), (error) => error.status === 403);
  assert.equal(rejected.transaction.rolledBack, true);

  const db = mockMasterlistDatabase();
  const search = "' OR 1=1 --";
  const result = await db.service.list('7', { schoolYear: '2026-2027', search, page: '8' });
  assert.equal(result.totalRecords, 0);
  assert.equal(result.filters.page, 1);
  assert.equal(result.filters.placementTerm, 2);
  assert.deepEqual(result.options.schoolYears, ['2026-2027']);
  const matching = db.calls.find((call) => call.statement.includes('MatchingAnnual AS'));
  assert.ok(matching);
  assert.equal(matching.params.searchTerm, search);
  assert.doesNotMatch(matching.statement, /' OR 1=1/);
  assert.ok(db.calls.every(({ statement }) => /^\s*(?:WITH\b|SELECT\b)/i.test(statement)), 'all SQL statements are read-only projections');
  assert.equal(db.transaction.committed, true);
});

test('masterlist keeps incomplete restatement source allocations distinct from reversed history', async () => {
  const operationId = '96c41280-66f5-4e26-a2bb-27ed65ea8321';
  const beforeImage = {
    annual: { id: 1, school_year: '2026-2027', grade_level: 'Grade 10' },
    enrollments: [{ id: 11, annual_term_number: 1 }],
    charges: [{ id: 81, enrollment_id: 11, fee_category: 'tuition', line_name: 'Tuition', installment: 'Whole term' }],
    allocations: [{ id: 91, charge_id: 81, payment_id: 101, amount: '50.00' }]
  };
  const beforeImageJson = JSON.stringify(beforeImage);
  const appliedImageJson = JSON.stringify({ placementAllocations: [] });
  const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const annual = annualRow(1);
  const assessedCharge = charge(81, 1, {
    line_name: 'Tuition', installment: 'Whole term', gross_amount: '100.00', waived_amount: '0.00',
    required_amount: '100.00', applied_amount: '50.00', balance_amount: '50.00'
  });
  const transaction = {
    active: false,
    async begin(level) { this.active = true; this.level = level; },
    async commit() { this.active = false; this.committed = true; },
    async rollback() { this.active = false; this.rolledBack = true; },
    request() {
      const params = {};
      return {
        input(name, _type, value) { params[name] = value; return this; },
        async query(statement) {
          if (statement.includes('FROM users WHERE id = @actorId')) return { recordset: [{ id: 7 }] };
          if (statement.includes('WHERE term.is_current = 1')) return { recordset: [{ school_year: '2026-2027', term_number: 1 }] };
          if (statement.includes('SELECT DISTINCT school_year')) return { recordset: [{ school_year: '2026-2027' }] };
          if (statement.includes('SELECT DISTINCT grade_level')) return { recordset: [{ grade_level: 'Grade 10' }] };
          if (statement.includes('SELECT DISTINCT section.id AS section_id')) return { recordset: [] };
          if (statement.includes('LatestFinanceClearance AS')) return { recordset: [annual] };
          if (statement.includes('SELECT charge.id AS charge_id')) return { recordset: [assessedCharge] };
          if (statement.includes('ConfiguredFeeRows AS')) return { recordset: [] };
          if (statement.includes('COUNT(charge.id) AS assessed_charge_count')) return { recordset: [] };
          if (statement.includes('v_finance_legacy_account_balance')) return { recordset: [] };
          if (statement.includes('FROM finance_payment_allocations AS allocation')) {
            return { recordset: [{
              charge_id: 81, application_type: 'Original tuition release', application_date: '2026-08-01',
              reference_no: 'PRIVATE-REFERENCE', receipt_issued: 0, is_reversed: 0,
              original_amount: '50.00', current_amount: '50.00', released_amount: '0.00',
              recorded_released_amount: '50.00', allocation_id: 91,
              source_restatement_operation_id: operationId,
              synthetic_restatement_operation_id: null, synthetic_restatement_kind: null
            }] };
          }
          if (statement.includes('FROM finance_assessment_restatement_annuals AS archive')) {
            return { recordset: [{
              operation_id: operationId, annual_enrollment_id: 1, school_year: '2026-2027', grade_level: 'Grade 10',
              before_image_json: beforeImageJson, before_image_sha256: sha256(beforeImageJson),
              applied_image_json: appliedImageJson, applied_image_sha256: sha256(appliedImageJson),
              applied_event_id: null, reversed_event_id: null
            }] };
          }
          return { recordset: [] };
        }
      };
    }
  };
  const sql = {
    ISOLATION_LEVEL: { REPEATABLE_READ: 'REPEATABLE_READ' },
    NVarChar: (length) => `NVarChar(${length})`, VarChar: (length) => `VarChar(${length})`,
    Char: (length) => `Char(${length})`, TinyInt: 'TinyInt', Int: 'Int'
  };
  const service = createFinanceMasterlistService({
    getPool: async () => ({}), sql, transactionFactory: () => transaction
  });

  const result = await service.list(7, { schoolYear: '2026-2027', placementTerm: '1' });
  const tuition = result.rows[0].terms[1].fees[JSON.stringify(['tuition', 'tuition', 'whole term'])];
  assert.equal(tuition.applications[0].type,
    'Original whole-term tuition source allocation; restatement apply evidence is incomplete');
  assert.match(tuition.applications[0].restatementHistory, /apply evidence is incomplete/);
  assert.equal(tuition.applications[0].current, '50.00');
  assert.equal(tuition.applications[0].released, '0.00');
  assert.equal(tuition.applications[0].recordedReleased, '50.00', 'recorded release history remains distinct from effective net allocation');
  assert.equal(transaction.committed, true);
});

test('unmapped or ambiguous current terms require explicit year and placement term without hiding explicit scopes', async () => {
  for (const currentTerms of [
    [{ school_year: '2027-2028', term_number: null }],
    [{ school_year: '2026-2027', term_number: 2, has_unresolved_review: 1 }],
    [{ school_year: '2026-2027', term_number: 2 }, { school_year: '2027-2028', term_number: 1 }]
  ]) {
    const db = mockMasterlistDatabase({ currentTerms, schoolYears: ['2026-2027'] });
    const result = await db.service.list('7', {});
    assert.equal(result.currentScopeConfigured, false);
    assert.equal(result.currentSchoolYear, null);
    assert.equal(result.defaultPlacementTerm, null);
    assert.equal(result.needsScopeSelection, true);
    assert.equal(result.filters.schoolYear, '');
    assert.equal(result.filters.placementTerm, null);
    assert.deepEqual(result.options.schoolYears, ['2026-2027'], 'an unmapped current year is not inserted as a selectable saved year');
    assert.equal(db.calls.some((call) => call.statement.includes('MatchingAnnual AS')), false, 'no annual cohort is queried until scope is explicit');

    const html = await ejs.renderFile(path.join(__dirname, '../views/finance/masterlist.ejs'), {
      title: 'Student accounts', currentUser: { id: 7, role: 'finance' }, csrfToken: '',
      navigationItems: [{ id: 'finance-roster', label: 'Student accounts', href: '/finance', current: true }],
      navigationGroups: [], masterlist: result
    });
    assert.match(html, /No unique configured current year and placement term is available/);
    assert.match(html, /Choose a school year/);
    assert.match(html, /value="" disabled selected>Choose term/);
    assert.match(html, /id="finance-masterlist-filters" class="finance-accounts-filter-disclosure" open/,
      'the required scope controls are revealed when selection is needed');
    assert.doesNotMatch(html, /Term 1 status counts/);
  }

  const explicit = mockMasterlistDatabase({ currentTerms: [{ school_year: '2027-2028', term_number: null }], schoolYears: ['2026-2027'] });
  const result = await explicit.service.list('7', { schoolYear: '2026-2027', placementTerm: '2' });
  assert.equal(result.currentScopeConfigured, false);
  assert.equal(result.needsScopeSelection, false);
  assert.equal(result.filters.schoolYear, '2026-2027');
  assert.equal(result.filters.placementTerm, 2);
  assert.ok(explicit.calls.some((call) => call.statement.includes('MatchingAnnual AS')));
});
