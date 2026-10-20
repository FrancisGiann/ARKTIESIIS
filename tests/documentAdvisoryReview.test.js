const test = require('node:test');
const assert = require('node:assert/strict');
const {
  advisoryChecks,
  currentComparisonStatus,
  evaluateBirthDateAdvisory,
  evaluateExtractedFields,
  evaluateIssuingSchoolAdvisory,
  parseVisibleBirthDate,
  profileValueFingerprint,
  schoolComparisonForCurrentSource,
  schoolNameFingerprint,
  profileDateOnly
} = require('../src/services/documentValidationService');

const student = { first_name: 'Jamie', last_name: 'Garcia' };
const sessionSecret = 'synthetic-document-advisory-test-secret-v1';

test('report-card prechecks compare only the linked student name', () => {
  const checks = advisoryChecks('report_card', 'JAMIE GARCIA\nOther Academy\nMathematics 150', student);
  assert.deepEqual(checks.map(({ key, found }) => [key, found]), [['linked_student_name', true]]);
});

test('Good Moral and PSA checks are limited to their leader-directed advisory clues', () => {
  const goodMoral = advisoryChecks('good_moral', 'Jamie M. Garcia\nNo institution text\nMathematics 100', student);
  assert.deepEqual(goodMoral.map(({ key }) => key), ['linked_student_name', 'possible_school_name']);
  assert.equal(goodMoral[1].found, false);
  assert.deepEqual(goodMoral[1].candidates, []);

  const psa = advisoryChecks('psa_birth_certificate', 'Jamie Garcia\nCity Civil Registry', student);
  assert.deepEqual(psa.map(({ key, found }) => [key, found]), [['linked_student_name', true]]);
});

test('digital document name clues compare linked first and last names on one OCR line', () => {
  for (const documentType of ['good_moral', 'psa_birth_certificate']) {
    const getNameMatch = (text) => advisoryChecks(documentType, text, student)
      .find(({ key }) => key === 'linked_student_name').found;

    assert.equal(getNameMatch('Student: JAMIE M. GARCIA'), true, `${documentType} recognizes a nearby name clue`);
    assert.equal(getNameMatch('Student: Garcia, Jamie'), true, `${documentType} allows surname-first text`);
    assert.equal(getNameMatch('Jamie Cruz\nLuis Garcia'), false, `${documentType} ignores name parts on separate lines`);
    assert.equal(getNameMatch('Jamie is enrolled at the school while Luis Garcia attends elsewhere'), false,
      `${documentType} ignores distant names on the same line`);
    assert.equal(getNameMatch('Jamieston Garcia'), false, `${documentType} requires complete name tokens`);
  }
});

test('school-name candidate lines are capped and bounded before staff views render them', () => {
  const longLine = `Private School ${'x'.repeat(500)}`;
  const checks = advisoryChecks('good_moral', `Jamie Garcia\n${longLine}\nAnother College\nThird Institute\nFourth Academy\nMathematics 150`, student);
  assert.equal(checks[1].candidates.length, 3);
  assert.ok(checks[1].candidates.every((candidate) => candidate.length <= 200));
});

test('PSA birth-date parsing accepts valid complete and unambiguous calendar dates only', () => {
  for (const [visible, normalizedDate] of [
    ['2008-02-29', '2008-02-29'],
    ['February 29, 2008', '2008-02-29'],
    ['29 February 2008', '2008-02-29'],
    ['13/04/2008', '2008-04-13'],
    ['04/13/2008', '2008-04-13'],
    ['04/04/2008', '2008-04-04']
  ]) {
    assert.deepEqual(parseVisibleBirthDate(visible), { status: 'identified', normalizedDate }, visible);
  }

  for (const visible of [
    '04/05/2008', 'April 2008', '29/02/2007', '2008-02-30', '31 April 2008', '2008/02-29'
  ]) {
    assert.deepEqual(parseVisibleBirthDate(visible), { status: 'uncertain', normalizedDate: null }, visible);
  }
  assert.deepEqual(parseVisibleBirthDate(''), { status: 'not_identified', normalizedDate: null });
  assert.equal(profileDateOnly('2008-02-29Tinvalid'), null, 'profile dates must be complete date-only values');
  assert.equal(profileDateOnly('2007-02-29'), null, 'malformed profile dates cannot compare');
});

test('PSA birth-date extraction and local comparison retain distinct unknown reasons', () => {
  const matching = evaluateBirthDateAdvisory(
    { dateOfBirthText: '29 February 2008' }, { birth_date: '2008-02-29' }, sessionSecret
  );
  assert.equal(matching.extractionStatus, 'identified');
  assert.equal(matching.visibleValue, '29 February 2008');
  assert.equal(matching.comparisonStatus, 'match');
  assert.ok(matching.profileFingerprint);

  const mismatch = evaluateBirthDateAdvisory(
    { dateOfBirthText: 'March 1, 2008' }, { birth_date: '2008-02-29' }, sessionSecret
  );
  assert.equal(mismatch.comparisonStatus, 'mismatch');
  const ambiguous = evaluateBirthDateAdvisory(
    { dateOfBirthText: '04/05/2008' }, { birth_date: '2008-04-05' }, sessionSecret
  );
  assert.equal(ambiguous.extractionStatus, 'uncertain');
  assert.equal(ambiguous.comparisonStatus, 'unknown');
  assert.equal(ambiguous.comparisonReason, 'date_ambiguous_or_invalid');
  const missingProfile = evaluateBirthDateAdvisory(
    { dateOfBirthText: 'April 5, 2008' }, { birth_date: null }, sessionSecret
  );
  assert.equal(missingProfile.comparisonStatus, 'unknown');
  assert.equal(missingProfile.comparisonReason, 'profile_date_not_recorded');
  assert.equal(evaluateBirthDateAdvisory({}, { birth_date: '2008-04-05' }, sessionSecret).extractionStatus, 'not_recorded');
});

test('profile fingerprints require a strong caller-provided existing session secret', () => {
  const withoutSecret = evaluateBirthDateAdvisory(
    { dateOfBirthText: 'April 5, 2008' }, { birth_date: '2008-04-05' }
  );
  assert.equal(withoutSecret.comparisonStatus, 'unknown');
  assert.equal(withoutSecret.comparisonReason, 'comparison_unavailable');
  assert.equal(withoutSecret.profileFingerprint, null);
  assert.equal(profileValueFingerprint('2008-04-05', 'short-test-key'), null);
});

test('a changed linked birth date makes a saved PSA comparison unknown', () => {
  const snapshot = evaluateBirthDateAdvisory(
    { dateOfBirthText: 'April 5, 2008' }, { birth_date: '2008-04-05' }, sessionSecret
  );
  assert.deepEqual(currentComparisonStatus(
    snapshot, profileValueFingerprint('2008-04-06', sessionSecret), snapshot.comparisonStatus, snapshot.comparisonReason
  ), { status: 'unknown', reason: 'source_changed_since_precheck' });
  assert.equal(currentComparisonStatus(
    snapshot, profileValueFingerprint('2008-04-05', sessionSecret), snapshot.comparisonStatus, snapshot.comparisonReason
  ).status, 'match');
  assert.deepEqual(currentComparisonStatus({}, profileValueFingerprint('2008-04-05', sessionSecret)), {
    status: 'unknown', reason: 'not_recorded'
  });
});

test('Good Moral school text comparison is advisory, source-aware, and conservative about uncertainty', () => {
  const source = {
    recordId: 'pre-enrollment-fixture', schoolYear: '2026-2027',
    value: 'North Academy', createdAt: '2026-06-01 09:00:00.000', updatedAt: '2026-06-02 09:00:00.000'
  };
  const matching = evaluateIssuingSchoolAdvisory({ issuingSchoolName: 'north-academy.' }, { lastSchoolSource: source });
  assert.equal(matching.status, 'match', 'case, diacritic, spacing, and punctuation differences normalize');
  assert.equal(matching.source.schoolYear, '2026-2027');
  assert.ok(matching.source.fingerprint);
  assert.equal(schoolNameFingerprint({ ...source, updatedAt: '2026-06-03 09:00:00.000' }), matching.source.fingerprint,
    'unrelated intake edits do not invalidate an unchanged source identity and school value');

  const mismatch = evaluateIssuingSchoolAdvisory({ issuingSchoolName: 'North Academy - Lucena' }, { lastSchoolSource: source });
  assert.equal(mismatch.status, 'mismatch');
  const uncertainIssuer = evaluateIssuingSchoolAdvisory({ issuingSchoolName: 'Possibly North Academy' }, { lastSchoolSource: source });
  assert.equal(uncertainIssuer.status, 'unknown');
  assert.equal(uncertainIssuer.reason, 'issuer_school_uncertain');
  assert.equal(evaluateIssuingSchoolAdvisory({ issuingSchoolName: 'North Academy or South College' }, { lastSchoolSource: source }).status, 'unknown');
  const absentSource = evaluateIssuingSchoolAdvisory({ issuingSchoolName: 'North Academy' }, { lastSchoolSource: null });
  assert.equal(absentSource.status, 'unknown');

  assert.deepEqual(schoolComparisonForCurrentSource(matching, { ...source, updatedAt: '2026-06-03 10:00:00.000' }), {
    status: 'match', reason: null
  });
  assert.deepEqual(schoolComparisonForCurrentSource(matching, { ...source, value: 'South Academy' }), {
    status: 'unknown', reason: 'source_changed_since_precheck'
  });

  const goodMoral = evaluateExtractedFields('good_moral', {
    studentName: 'Jamie Garcia', issuingSchoolName: 'Different Academy',
    goodMoralContextEvidence: 'Good Moral Certificate',
    goodMoralLayoutEvidence: 'A certificate title appears above the student name and date.'
  }, { ...student, lastSchoolSource: source }, true);
  assert.equal(goodMoral.code, 'precheck_pass', 'school text mismatch does not change the required precheck outcome');
  assert.equal(goodMoral.advisories.issuingSchool.status, 'mismatch');
});
