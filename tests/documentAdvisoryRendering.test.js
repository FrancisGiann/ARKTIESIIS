const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const ejs = require('ejs');
const { safeGeminiAdvisoryFindings } = require('../src/services/documentService');
const {
  evaluateIssuingSchoolAdvisory,
  profileValueFingerprint
} = require('../src/services/documentValidationService');

const root = path.resolve(__dirname, '..');
const template = path.join(root, 'views/documents/detail.ejs');
const sessionSecret = 'synthetic-document-rendering-test-secret-v1';

function documentFixture(documentType, validation, { isStaff = true, correctionRequested = false } = {}) {
  const decisions = correctionRequested ? [{ decision_type: 'correction_requested', reason: 'Synthetic correction instruction.' }] : [];
  return {
    title: 'Synthetic document advisory preview',
    isStaff,
    csrfToken: 'synthetic-csrf-token',
    notice: null,
    error: null,
    uploadMaxMb: 10,
    verificationChecklistItems: [],
    documentTypeLabel: (type) => type === 'good_moral' ? 'Good Moral Certificate' : type === 'report_card' ? 'Previous-school report card' : 'PSA Birth Certificate',
    documentStatusLabel: () => 'Needs staff review',
    document: {
      id: 204,
      student_id: 44,
      student_no: 'SYN-44',
      first_name: 'Synthetic',
      middle_name: null,
      last_name: 'Student',
      suffix: null,
      status: 'needs_review',
      document_type: documentType,
      original_filename: 'synthetic-document.pdf',
      stored_filename: '00000000-0000-4000-8000-000000000044.pdf',
      mime_type: 'application/pdf',
      file_size_bytes: 1024,
      upload_source: 'student',
      is_legacy_archive: 0,
      isArchivedReportCard: false,
      supersedes_document_id: null,
      created_at: '2026-06-01 09:00:00',
      validation,
      history: [],
      decisions,
      reviewEvents: []
    },
    student: {
      id: 44, student_no: 'SYN-44', first_name: 'Synthetic', middle_name: null,
      last_name: 'Student', suffix: null, status: 'active'
    },
    activeStudentView: 'documents'
  };
}

async function render(documentType, advisoryFindings, { isStaff = true, correctionRequested = false } = {}) {
  const validation = advisoryFindings ? {
    message: 'Synthetic review fixture.',
    processor: 'Synthetic field extraction',
    created_at: '2026-06-01 09:00:00',
    formatCheckPassed: true,
    automatedCheckOutcome: 'pass',
    fieldChecks: [],
    advisoryFindings
  } : null;
  return ejs.renderFile(template, documentFixture(documentType, validation, { isStaff, correctionRequested }));
}

function psaFindings(visibleDate, currentBirthDate, { storedFingerprint = profileValueFingerprint(currentBirthDate, sessionSecret), status = 'match' } = {}) {
  return safeGeminiAdvisoryFindings('psa_birth_certificate', {
    gemini: {
      status: 'extracted',
      fields: { studentName: 'Synthetic Student', dateOfBirthText: visibleDate },
      advisories: { birthDate: { comparisonStatus: status, profileFingerprint: storedFingerprint } }
    }
  }, { birthDate: currentBirthDate }, sessionSecret);
}

test('staff PSA rendering shows visible text and the explicitly current saved DOB for every advisory state', async () => {
  const match = await render('psa_birth_certificate', psaFindings('29 February 2008', '2008-02-29'));
  assert.match(match, /Visible date text extracted/);
  assert.match(match, /29 February 2008/);
  assert.match(match, /Birth date matches the current saved profile · advisory only/);
  assert.match(match, /Current saved profile date of birth: 2008-02-29/);

  const mismatch = await render('psa_birth_certificate', psaFindings('March 1, 2008', '2008-02-29'));
  assert.match(mismatch, /Birth date differs from the current saved profile · human check recommended/);
  assert.match(mismatch, /Current saved profile date of birth: 2008-02-29/);

  const changedReference = await render('psa_birth_certificate', psaFindings(
    '29 February 2008', '2008-03-01', { storedFingerprint: profileValueFingerprint('2008-02-29', sessionSecret) }
  ));
  assert.match(changedReference, /Unknown · the saved reference changed since processing or the prior comparison cannot be confirmed/);
  assert.match(changedReference, /Current saved profile date of birth: 2008-03-01/);
  assert.doesNotMatch(changedReference, /Birth date matches the current saved profile/);

  const providerFailure = await render('psa_birth_certificate', safeGeminiAdvisoryFindings('psa_birth_certificate', {
    gemini: { status: 'unavailable', fields: null }
  }));
  assert.match(providerFailure, /Gemini extraction unavailable/);
  assert.match(providerFailure, /Comparison unavailable because field extraction did not complete/);

  const ambiguous = await render('psa_birth_certificate', psaFindings('04/05/2008', '2008-04-05'));
  assert.match(ambiguous, /Ambiguous or invalid date · comparison unknown/);
  assert.match(ambiguous, /Unknown · the visible date is ambiguous or invalid/);
});

test('Good Moral staff rendering separates missing source, uncertain issuer, mismatch, and legacy result', async () => {
  const visibleIssuerHtml = await render('good_moral', [{
    key: 'issuing_school_name', label: 'Visible issuing-school text', status: 'identified', value: 'North Academy'
  }]);
  assert.match(visibleIssuerHtml, /Visible issuing-school text extracted/);
  assert.doesNotMatch(visibleIssuerHtml, /Unknown · not enough information for comparison/);

  const noSource = safeGeminiAdvisoryFindings('good_moral', {
    gemini: {
      status: 'extracted', fields: { issuingSchoolName: 'North Academy' },
      advisories: { issuingSchool: { status: 'match', recordedSchool: '', source: null } }
    }
  }, { lastSchoolSource: null });
  const noSourceHtml = await render('good_moral', noSource);
  assert.match(noSourceHtml, /Unknown · no linked saved last-school value is available/);
  assert.doesNotMatch(noSourceHtml, /no comparison was recorded for this result/);

  const uncertainIssuer = safeGeminiAdvisoryFindings('good_moral', {
    gemini: {
      status: 'extracted', fields: { issuingSchoolName: 'North Academy or South College' },
      advisories: { issuingSchool: { status: 'match', recordedSchool: '', source: null } }
    }
  }, { lastSchoolSource: null });
  const uncertainHtml = await render('good_moral', uncertainIssuer);
  assert.match(uncertainHtml, /Unknown · issuing-school text is ambiguous/);

  const source = {
    recordId: '00000000-0000-4000-8000-000000000044', schoolYear: '2026-2027', value: 'North Academy',
    createdAt: '2026-05-31 18:00:00.000', updatedAt: '2026-06-02 09:00:00.000'
  };
  const schoolFinding = evaluateIssuingSchoolAdvisory({ issuingSchoolName: 'South Academy' }, { lastSchoolSource: source });
  const mismatchHtml = await render('good_moral', safeGeminiAdvisoryFindings('good_moral', {
    gemini: {
      status: 'extracted', fields: { issuingSchoolName: 'South Academy' },
      advisories: { issuingSchool: { ...schoolFinding, status: 'match' } }
    }
  }, { lastSchoolSource: source }));
  assert.match(mismatchHtml, /Text differs from the saved record · human check recommended/);
  assert.match(mismatchHtml, /Registrar intake · school year 2026-2027 · recorded Jun 1, 2026, 2:00 AM Manila time/,
    'the UTC source timestamp is displayed in Manila time across a date boundary');
  assert.doesNotMatch(mismatchHtml, /00000000-0000-4000-8000-000000000044/);

  const legacyHtml = await render('good_moral', safeGeminiAdvisoryFindings('good_moral', {
    gemini: { status: 'extracted', fields: { issuingSchoolName: 'North Academy' } }
  }));
  assert.match(legacyHtml, /Unknown · no comparison was recorded for this result/);
});

test('student rendering never displays staff-only document advisory findings or linked DOB', async () => {
  const html = await render('psa_birth_certificate', null, { isStaff: false });
  assert.doesNotMatch(html, /Birth-date advisory|Current saved profile date of birth|29 February 2008/);
  const css = await fs.readFile(path.join(root, 'public/css/app.css'), 'utf8');
  assert.match(html, /href="\/css\/app\.css"/);
  assert.match(css, /\.document-advisory-findings/);
});

test('correction upload forms explain provider fields and local comparisons before file selection', async () => {
  const studentPsa = await render('psa_birth_certificate', null, { isStaff: false, correctionRequested: true });
  assert.match(studentPsa, /Google Gemini receives this file to suggest the visible student name and copy visible birth-date text as written/);
  assert.match(studentPsa, /The birth date is compared locally with the current saved profile; profile data is not sent to Gemini/);
  assert.match(studentPsa, /This birth-date comparison is advisory only/);

  const staffGoodMoral = await render('good_moral', null, { isStaff: true, correctionRequested: true });
  assert.match(staffGoodMoral, /Google Gemini receives this file to suggest the visible student name, issuing-school text, and certificate-context clues/);
  assert.match(staffGoodMoral, /The issuing-school text is compared locally with the saved last-school value; profile data is not sent to Gemini/);
  assert.match(staffGoodMoral, /The birth-date or issuing-school comparison is advisory only/);

  const studentReportCard = await render('report_card', null, { isStaff: false, correctionRequested: true });
  assert.match(studentReportCard, /The app checks file size and configured PDF, JPEG, or PNG format on the server/);
  assert.match(studentReportCard, /Google Gemini suggests only the visible student name; it does not extract grades or other academic results/);
  assert.match(studentReportCard, /Staff review the source after the limited name and server-side file-format checks/);
});
