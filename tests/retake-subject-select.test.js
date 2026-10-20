'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initialize } = require('../public/js/retake-subject-select');

function makeSelect(options, value) {
  const listeners = new Map();
  return {
    options,
    value,
    selectedOptions: [],
    addEventListener(name, listener) { listeners.set(name, listener); },
    trigger(name) {
      this.selectedOptions = options.filter((option) => option.value === this.value);
      listeners.get(name)?.();
      this.selectedOptions = options.filter((option) => option.value === this.value);
    }
  };
}

test('retake subject options follow the selected current placement and clear stale choices', () => {
  const subjectOptions = [
    { value: '', dataset: {}, hidden: false, disabled: false },
    { value: '44', dataset: { term: '1' }, hidden: false, disabled: false },
    { value: '53', dataset: { term: '2' }, hidden: false, disabled: false }
  ];
  const termSelect = makeSelect([], '1');
  const subjectSelect = makeSelect(subjectOptions, '44');
  subjectSelect.selectedOptions = [subjectOptions[1]];
  const form = { querySelector(selector) {
    return selector === '[name="targetTerm"]' ? termSelect : selector === '[data-retake-subject-select]' ? subjectSelect : null;
  } };

  initialize({ querySelectorAll: () => [form] });
  assert.equal(subjectOptions[1].hidden, false);
  assert.equal(subjectOptions[2].hidden, true);
  assert.equal(subjectOptions[2].disabled, true);

  termSelect.value = '2';
  termSelect.trigger('change');
  assert.equal(subjectSelect.value, '', 'the term 1 subject is cleared when the selected term changes');
  assert.equal(subjectOptions[1].hidden, true);
  assert.equal(subjectOptions[2].hidden, false);
});
