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
  const form = { querySelectorAll() { return [required.checkbox, zero.checkbox, saved.checkbox]; } };
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
