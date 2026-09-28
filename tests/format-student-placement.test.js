const test = require('node:test');
const assert = require('node:assert/strict');
const { formatGradeLevel, formatStudentPlacement } = require('../src/utils/formatStudentPlacement');

test('student placement formats the grade once when a section name repeats it', () => {
  assert.equal(formatStudentPlacement('Grade 11', 'Grade 11 STEM A'), 'Grade 11 · STEM A');
  assert.equal(formatStudentPlacement('11', 'Grade 11 ABM B'), 'Grade 11 · ABM B');
  assert.equal(formatStudentPlacement('Grade 12', 'Grade 12'), 'Grade 12');
});

test('student placement preserves a section without a repeated grade and handles missing values', () => {
  assert.equal(formatStudentPlacement('11', 'STEM A'), 'Grade 11 · STEM A');
  assert.equal(formatStudentPlacement(null, 'Grade 12 HUMSS A'), 'Grade 12 HUMSS A');
  assert.equal(formatStudentPlacement('Grade 11', null), 'Grade 11');
  assert.equal(formatGradeLevel(''), '');
});
