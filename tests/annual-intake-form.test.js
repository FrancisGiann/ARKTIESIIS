'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('birth date is required only for new annual intake and stays required after new/returning toggles', () => {
  const listeners = new Map();
  const control = (id, value = '') => ({
    id, value, required: false, disabled: false, dataset: {}, options: [], selectedOptions: [],
    addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); },
    querySelectorAll() { return []; },
    setCustomValidity() {}
  });
  const birthDate = control('annual-birth-date');
  const fields = [
    control('annual-lrn'), control('annual-email'), control('annual-first-name'),
    control('annual-last-name'), birthDate
  ];
  const newFields = { hidden: false, querySelectorAll: () => fields };
  const mode = control('annual-student-mode', 'new');
  const returningInput = control('annual-student-no');
  const year = control('annual-school-year');
  const grade = control('annual-grade');
  const entryTerm = control('annual-entry-term', '1');
  const sectionMode = control('annual-section-mode', 'separate');
  const commonSection = control('annual-common-section');
  commonSection.options = [{ value: '', dataset: {} }];
  commonSection.selectedOptions = [commonSection.options[0]];
  const elements = new Map([
    [mode.id, mode], ['returning-student-field', { hidden: true }],
    ['new-student-fields', newFields], [returningInput.id, returningInput],
    [birthDate.id, birthDate], ['annual-birth-date-requirement', { textContent: '' }],
    ['annual-birth-date-help', { textContent: '' }], [year.id, year], [grade.id, grade],
    [entryTerm.id, entryTerm], [sectionMode.id, sectionMode],
    ['annual-common-section-field', { hidden: false }], [commonSection.id, commonSection],
    ['annual-section-plan-preview', { replaceChildren() {} }]
  ]);
  const form = {
    dataset: { activeStep: '1' },
    noValidate: false,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const document = {
    querySelector(selector) { return selector === '[data-intake-wizard]' ? form : null; },
    querySelectorAll() { return []; },
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return { textContent: '' }; }
  };

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/annual-intake-form.js'), 'utf8'), {
    document,
    window: { ARKTIESIISProfileValidation: {
      validateControl() {}, firstInvalidControl() { return null; }, focusInvalidControl() {}
    } }
  });

  assert.equal(birthDate.required, true);
  assert.match(elements.get('annual-birth-date-requirement').textContent, /required for first account activation/i);
  mode.value = 'returning';
  listeners.get('annual-student-mode:change')();
  assert.equal(birthDate.required, false);
  assert.match(elements.get('annual-birth-date-requirement').textContent, /optional for an existing student/i);
  mode.value = 'new';
  listeners.get('annual-student-mode:change')();
  assert.equal(birthDate.required, true);
});
