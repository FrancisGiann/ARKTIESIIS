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

test('paper count defaults only fill pristine configured fields and survive edits, zero, toggles, and recovered forms', () => {
  function runPaperFixture({ prefill = '1', initial = ['', '', ''], defaults = ['2', '1', '3'] } = {}) {
    const listeners = new Map();
    const control = (id, value = '') => ({
      id, value, required: false, disabled: false, hidden: false, checked: false,
      dataset: {}, options: [], selectedOptions: [],
      addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); },
      querySelectorAll() { return []; },
      setCustomValidity() {}
    });
    const countInputs = initial.map((value, index) => {
      const input = control(`count-${index}`, value);
      input.dataset.defaultCount = defaults[index];
      return input;
    });
    const checkbox = control('paper-record');
    const details = { open: false };
    const row = {
      hidden: false, dataset: { requirementApplicability: 'all' },
      querySelector(selector) { return selector === '[data-paper-record]' ? checkbox : selector === '[data-paper-details]' ? details : null; },
      querySelectorAll(selector) {
        if (selector === '[data-paper-count]' || selector === '.paper-checklist-row__details input') return countInputs;
        return [];
      }
    };
    checkbox.closest = () => row;
    const newFields = { hidden: false, querySelectorAll: () => [] };
    const mode = control('annual-student-mode', 'new');
    const returningInput = control('annual-student-no');
    const year = control('annual-school-year');
    const grade = control('annual-grade');
    const entryTerm = control('annual-entry-term', '1');
    const sectionMode = control('annual-section-mode', 'separate');
    const commonSection = control('annual-common-section');
    commonSection.options = [{ value: '', dataset: {} }];
    commonSection.selectedOptions = [commonSection.options[0]];
    const preview = { replaceChildren() {} };
    const elements = new Map([
      [mode.id, mode], ['returning-student-field', { hidden: true }], ['new-student-fields', newFields],
      [returningInput.id, returningInput], ['annual-birth-date', control('annual-birth-date')],
      ['annual-birth-date-requirement', { textContent: '' }], ['annual-birth-date-help', { textContent: '' }],
      [year.id, year], [grade.id, grade], [entryTerm.id, entryTerm], [sectionMode.id, sectionMode],
      ['annual-common-section-field', { hidden: false }], [commonSection.id, commonSection], ['annual-section-plan-preview', preview]
    ]);
    const form = {
      dataset: { activeStep: '3', paperPrefill: prefill }, noValidate: false,
      querySelector: () => null,
      querySelectorAll(selector) {
        if (selector === '[data-paper-record]') return [checkbox];
        if (selector === '[data-paper-count]') return countInputs;
        return [];
      },
      addEventListener() {}
    };
    const document = {
      querySelector(selector) { return selector === '[data-intake-wizard]' ? form : null; },
      querySelectorAll(selector) { return selector === '[data-requirement-applicability]' ? [row] : []; },
      getElementById(id) { return elements.get(id) || null; },
      createElement() { return { textContent: '' }; }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/annual-intake-form.js'), 'utf8'), {
      document,
      window: { ARKTIESIISProfileValidation: {
        validateControl() {}, firstInvalidControl() { return null; }, focusInvalidControl() {}
      } }
    });
    return { checkbox, countInputs, details, listeners };
  }

  const pristine = runPaperFixture();
  pristine.checkbox.checked = true;
  pristine.listeners.get('paper-record:change')();
  assert.deepEqual(pristine.countInputs.map((input) => input.value), ['2', '1', '3']);
  assert.equal(pristine.countInputs.every((input) => !input.disabled), true);

  pristine.countInputs[0].value = '0';
  pristine.listeners.get('count-0:input')();
  pristine.countInputs[1].value = '4';
  pristine.listeners.get('count-1:change')();
  pristine.checkbox.checked = false;
  pristine.listeners.get('paper-record:change')();
  assert.equal(pristine.countInputs.every((input) => input.disabled), true);
  pristine.checkbox.checked = true;
  pristine.listeners.get('paper-record:change')();
  assert.deepEqual(pristine.countInputs.map((input) => input.value), ['0', '4', '3'],
    'rechecking does not replace a deliberate zero or manually edited partial quantity');

  const partial = runPaperFixture({ initial: ['5', '', ''] });
  partial.checkbox.checked = true;
  partial.listeners.get('paper-record:change')();
  assert.deepEqual(partial.countInputs.map((input) => input.value), ['5', '1', '3'],
    'a nonempty saved/partial value is retained while other blank fields use configured counts');

  const recovered = runPaperFixture({ prefill: '0', initial: ['0', '2', ''] });
  recovered.checkbox.checked = true;
  recovered.listeners.get('paper-record:change')();
  assert.deepEqual(recovered.countInputs.map((input) => input.value), ['0', '2', ''],
    'error recovery never autofills or replaces returned values');

  const invalidDefinitions = runPaperFixture({ defaults: ['-1', '1.5', ' '] });
  invalidDefinitions.checkbox.checked = true;
  invalidDefinitions.listeners.get('paper-record:change')();
  assert.deepEqual(invalidDefinitions.countInputs.map((input) => input.value), ['', '', ''],
    'invalid configured quantities are ignored rather than guessed or coerced');
});

test('Registrar select all uses visible grade-applicable papers and preserves corrected counts', () => {
  const listeners = new Map();
  const control = (id, value = '') => ({ id, value, dataset: {}, options: [], selectedOptions: [],
    checked: false, disabled: false, hidden: false,
    addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); },
    querySelectorAll() { return []; }, setCustomValidity() {} });
  const rowFor = (id, applicability, configured, checked = false) => {
    const record = control(`${id}-record`);
    record.checked = checked;
    const count = control(`${id}-count`, checked ? '1' : '');
    count.dataset.defaultCount = configured;
    const details = { open: checked };
    const row = { hidden: false, dataset: { requirementApplicability: applicability },
      querySelector(selector) { return selector === '[data-paper-record]' ? record : selector === '[data-paper-details]' ? details : null; },
      querySelectorAll(selector) { return ['[data-paper-count]', '.paper-checklist-row__details input'].includes(selector) ? [count] : []; } };
    record.closest = () => row;
    return { row, record, count };
  };
  const common = rowFor('common', 'all', '1', true);
  const grade11 = rowFor('grade11', 'grade11', '2');
  const grade12 = rowFor('grade12', 'grade12', '3');
  const optional = rowFor('optional', 'optional', '4');
  const rows = [common, grade11, grade12, optional];
  const selectAll = control('select-all-paper');
  const mode = control('annual-student-mode', 'new');
  const grade = control('annual-grade', 'Grade 11');
  const commonSection = control('annual-common-section');
  commonSection.options = [{ value: '', dataset: {} }];
  commonSection.selectedOptions = [commonSection.options[0]];
  const elements = new Map([
    [mode.id, mode], ['returning-student-field', { hidden: true }],
    ['new-student-fields', { hidden: false, querySelectorAll() { return []; } }],
    ['annual-student-no', control('annual-student-no')], ['annual-birth-date', control('annual-birth-date')],
    ['annual-birth-date-requirement', { textContent: '' }], ['annual-birth-date-help', { textContent: '' }],
    ['annual-school-year', control('annual-school-year')], [grade.id, grade],
    ['annual-entry-term', control('annual-entry-term', '1')], ['annual-section-mode', control('annual-section-mode', 'separate')],
    ['annual-common-section-field', { hidden: false }], [commonSection.id, commonSection],
    ['annual-section-plan-preview', { replaceChildren() {} }]
  ]);
  const form = { dataset: { activeStep: '3', paperPrefill: '1' }, noValidate: false,
    querySelector(selector) { return selector === '[data-select-all-paper]' ? selectAll : null; },
    querySelectorAll(selector) {
      if (selector === '[data-paper-record]') return rows.map((item) => item.record);
      if (selector === '[data-paper-count]') return rows.map((item) => item.count);
      return [];
    }, addEventListener() {} };
  const document = { querySelector(selector) { return selector === '[data-intake-wizard]' ? form : null; },
    querySelectorAll(selector) { return selector === '[data-requirement-applicability]' ? rows.map((item) => item.row) : []; },
    getElementById(id) { return elements.get(id) || null; }, createElement() { return { textContent: '' }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/annual-intake-form.js'), 'utf8'), {
    document, window: { ARKTIESIISProfileValidation: {
      validateControl() {}, firstInvalidControl() { return null; }, focusInvalidControl() {}
    } }
  });
  assert.equal(selectAll.indeterminate, true);
  selectAll.checked = true;
  listeners.get('select-all-paper:change')();
  assert.equal(grade11.record.checked, true);
  assert.equal(grade11.count.value, '2');
  assert.equal(grade12.record.checked, false, 'other grade stays untouched');
  assert.equal(optional.record.checked, false, 'manual applicability stays individual');
  grade11.count.value = '1';
  listeners.get('grade11-count:input')();
  selectAll.checked = false;
  listeners.get('select-all-paper:change')();
  selectAll.checked = true;
  listeners.get('select-all-paper:change')();
  assert.equal(grade11.count.value, '1', 'correction survives a bulk toggle');
  grade.value = 'Grade 12';
  listeners.get('annual-grade:change')();
  assert.equal(selectAll.indeterminate, true);
  selectAll.checked = true;
  listeners.get('select-all-paper:change')();
  assert.equal(grade12.count.value, '3');
  assert.equal(grade11.record.disabled, true, 'other grade is not submitted');
});
