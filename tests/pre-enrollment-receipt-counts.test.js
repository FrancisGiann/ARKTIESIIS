'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('front-desk receipt counts fill only new checked blanks and preserve corrections across toggles', () => {
  const listeners = new Map();
  const pair = (name, initial, configured, checked = false) => {
    const count = { value: initial, dataset: { defaultCount: configured },
      addEventListener(event, callback) { listeners.set(`${name}:count:${event}`, callback); } };
    const checkbox = { checked,
      addEventListener(event, callback) { listeners.set(`${name}:check:${event}`, callback); },
      closest() { return { querySelector() { return count; } }; } };
    return { count, checkbox };
  };
  const required = pair('required', '', '3');
  const zero = pair('zero', '', '');
  const saved = pair('saved', '2', '3', true);
  const form = { querySelector() { return null; }, querySelectorAll() { return [required.checkbox, zero.checkbox, saved.checkbox]; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/pre-enrollment-receipt-counts.js'), 'utf8'), {
    document: { querySelector() { return form; } }
  });

  assert.equal(saved.count.value, '2', 'an already checked saved count stays unchanged on load');
  required.checkbox.checked = true;
  listeners.get('required:check:change')();
  assert.equal(required.count.value, '3');
  required.count.value = '1';
  listeners.get('required:count:input')();
  required.checkbox.checked = false;
  listeners.get('required:check:change')();
  assert.equal(required.count.value, '', 'unchecked count is not submitted');
  required.checkbox.checked = true;
  listeners.get('required:check:change')();
  assert.equal(required.count.value, '1', 'edited amount returns on recheck');

  zero.checkbox.checked = true;
  listeners.get('zero:check:change')();
  assert.equal(zero.count.value, '', 'zero-required copies do not receive invented counts');
  saved.checkbox.checked = false;
  listeners.get('saved:check:change')();
  saved.checkbox.checked = true;
  listeners.get('saved:check:change')();
  assert.equal(saved.count.value, '2', 'saved count survives an accidental toggle');
});

test('Front Desk select all fills only eligible blanks, tracks mixed state, and retains edited counts', () => {
  const callbacks = new Map();
  const item = (name, value, configured, checked = false, disabled = false) => {
    const count = { value, dataset: { defaultCount: configured }, addEventListener(event, callback) { callbacks.set(`${name}:count:${event}`, callback); } };
    const checkbox = { checked, disabled,
      addEventListener(event, callback) { callbacks.set(`${name}:check:${event}`, callback); },
      closest() { return { querySelector() { return count; } }; } };
    return { checkbox, count };
  };
  const original = item('original', '', '1');
  const copies = item('copies', '1', '2', true);
  const optional = item('optional', '', '');
  const disabled = item('disabled', '', '3', false, true);
  const selectAll = { checked: false, indeterminate: false, disabled: false,
    addEventListener(event, callback) { callbacks.set(`all:${event}`, callback); } };
  const form = { querySelector() { return selectAll; },
    querySelectorAll() { return [original.checkbox, copies.checkbox, optional.checkbox, disabled.checkbox]; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/pre-enrollment-receipt-counts.js'), 'utf8'), {
    document: { querySelector() { return form; } }
  });
  assert.equal(selectAll.indeterminate, true, 'one of two eligible receipts is selected');
  selectAll.checked = true;
  callbacks.get('all:change')();
  assert.equal(original.count.value, '1');
  assert.equal(copies.count.value, '1', 'saved corrected quantity is not replaced');
  assert.equal(optional.checkbox.checked, false, 'zero-required optional item is not invented');
  assert.equal(disabled.checkbox.checked, false);
  assert.equal(selectAll.checked, true);
  original.count.value = '2';
  callbacks.get('original:count:input')();
  selectAll.checked = false;
  callbacks.get('all:change')();
  assert.equal(original.count.value, '', 'deselected counts are not submitted');
  selectAll.checked = true;
  callbacks.get('all:change')();
  assert.equal(original.count.value, '2', 'manual correction returns on reselection');
  copies.checkbox.checked = false;
  callbacks.get('copies:check:change')();
  assert.equal(selectAll.indeterminate, true, 'individual changes refresh the bulk state');
});
