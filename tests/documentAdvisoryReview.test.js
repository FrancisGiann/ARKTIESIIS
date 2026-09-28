const test = require('node:test');
const assert = require('node:assert/strict');
const { advisoryChecks } = require('../src/services/documentValidationService');

const student = { first_name: 'Jamie', last_name: 'Garcia' };

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
