'use strict';

function createCsvColumns(masterlist) {
  const columns = [
    { heading: 'Student name', kind: 'text', read: (row) => row.studentName },
    { heading: 'Student no.', kind: 'text', read: (row) => row.studentNo },
    { heading: 'LRN', kind: 'lrn', read: (row) => row.lrn },
    { heading: 'School year', kind: 'text', read: (row) => row.schoolYear },
    { heading: 'Grade', kind: 'text', read: (row) => row.gradeLevel },
    { heading: 'Voucher', kind: 'text', read: (row) => row.voucherCode },
    { heading: 'Annual intake status', kind: 'text', read: (row) => row.intakeStatus },
    { heading: 'Assessed voucher', kind: 'text', read: (row) => row.assessedVoucherCode },
    { heading: 'Assessment schedule version', kind: 'text', read: (row) => row.assessmentVersion },
    { heading: 'Current fee composition provenance', kind: 'text', read: (row) => row.restatement?.label || '' },
    { heading: 'Voucher review required', kind: 'text', read: (row) => row.voucherReviewRequired ? 'Yes' : 'No' }
  ];
  for (const termNumber of [1, 2, 3]) {
    const prefix = `Term ${termNumber}`;
    columns.push(
      { heading: `${prefix} / Section`, kind: 'text', read: (row) => row.terms[termNumber]?.section || 'Not applicable' },
      { heading: `${prefix} / Enrollment state`, kind: 'text', read: (row) => row.terms[termNumber]?.enrollmentStatus || 'Not applicable' },
      { heading: `${prefix} / Registrar confirmation`, kind: 'text', read: (row) => row.terms[termNumber]?.registrarConfirmation || 'Not applicable' },
      { heading: `${prefix} / Finance clearance`, kind: 'text', read: (row) => clearanceLabel(row.terms[termNumber]) },
      { heading: `${prefix} / Applied total`, kind: 'number', read: (row) => row.terms[termNumber]?.applied },
      { heading: `${prefix} / Balance`, kind: 'number', read: (row) => row.terms[termNumber]?.balance },
      { heading: `${prefix} / Payment status`, kind: 'text', read: (row) => row.terms[termNumber]?.status || 'Not applicable' }
    );
    for (const fee of masterlist.termColumns[termNumber] || []) {
      const feePrefix = `${prefix} / ${fee.label}`;
      columns.push(
        { heading: `${feePrefix} / Payable`, kind: 'number', read: (row) => row.terms[termNumber]?.fees?.[fee.key]?.configured },
        { heading: `${feePrefix} / Applied`, kind: 'number', read: (row) => row.terms[termNumber]?.fees?.[fee.key]?.applied },
        { heading: `${feePrefix} / Balance`, kind: 'number', read: (row) => row.terms[termNumber]?.fees?.[fee.key]?.balance },
        { heading: `${feePrefix} / Status`, kind: 'text', read: (row) => row.terms[termNumber]?.fees?.[fee.key]?.status || 'Not applicable' },
        { heading: `${feePrefix} / Payment details`, kind: 'text', read: (row) => applicationSummary(row.terms[termNumber]?.fees?.[fee.key]?.applications || []) }
      );
    }
  }
  columns.push(
    { heading: 'Selected-year balance', kind: 'number', read: (row) => row.selectedYearBalance },
    { heading: 'Earlier-year balance', kind: 'number', read: (row) => row.earlierYearBalance },
    { heading: 'Earlier-year balance status', kind: 'text', read: (row) => row.earlierYearStatus },
    { heading: 'Earlier account balance', kind: 'number', read: (row) => row.earlierAccountBalance },
    { heading: 'Opening liability', kind: 'number', read: (row) => row.openingLiability },
    { heading: 'Unused payment credit', kind: 'number', read: (row) => row.unusedPaymentCredit },
    { heading: 'Readiness', kind: 'text', read: (row) => row.readiness }
  );
  return columns;
}

function clearanceLabel(term) {
  if (!term || term.scopeStatus === 'not_applicable') return 'Not applicable';
  if (term.financeClearance === 'signed') return `Signed${term.financeClearanceDate ? ` · ${String(term.financeClearanceDate).slice(0, 10)}` : ''}`;
  if (term.financeClearance === 'revoked') return `Revoked${term.financeClearanceDate ? ` · ${String(term.financeClearanceDate).slice(0, 10)}` : ''}`;
  return 'Not recorded';
}

function applicationSummary(applications) {
  return applications.map((item) => [
    neutralizeSpreadsheetText(item.type),
    neutralizeSpreadsheetText(item.date),
    `Reference: ${neutralizeSpreadsheetText(item.reference)}`,
    item.originalPurpose ? `Original purpose: ${neutralizeSpreadsheetText(item.originalPurpose)}` : '',
    item.restatementHistory ? neutralizeSpreadsheetText(item.restatementHistory) : '',
    `Original ${item.original}`,
    `Applied ${item.current}`,
    `Released ${item.released}`,
    item.recordedReleased != null && String(item.recordedReleased) !== String(item.released)
      ? `Recorded release ${item.recordedReleased} (historical)` : '',
    item.receiptIssued ? 'Receipt issued' : '',
    item.reversed ? 'Payment reversed' : ''
  ].filter(Boolean).join('; ')).join(' | ');
}

function neutralizeSpreadsheetText(value, { lrn = false } = {}) {
  const text = String(value ?? '');
  if (lrn || /^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(text)) return `'${text}`;
  return text;
}

function csvCell(value, kind = 'text') {
  if (value == null) return '';
  const text = kind === 'number' ? String(value) : neutralizeSpreadsheetText(value, { lrn: kind === 'lrn' });
  return `"${text.replaceAll('"', '""')}"`;
}

function csvHeader(columns) { return `${columns.map((column) => csvCell(column.heading, 'text')).join(',')}\r\n`; }

function csvRow(row, columns) {
  return `${columns.map((column) => csvCell(column.read(row), column.kind)).join(',')}\r\n`;
}

module.exports = { createCsvColumns, clearanceLabel, applicationSummary, neutralizeSpreadsheetText, csvCell, csvHeader, csvRow };
