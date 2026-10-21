'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function control(value = '') {
  const listeners = new Map();
  const attributes = new Map();
  return {
    value,
    checked: false,
    disabled: false,
    hidden: false,
    attributes,
    addEventListener(name, listener) {
      listeners.set(name, [...(listeners.get(name) || []), listener]);
    },
    setAttribute(name, nextValue) { attributes.set(name, nextValue); },
    dispatch(name) { for (const listener of listeners.get(name) || []) listener({ target: this }); }
  };
}

function rowFixture({ decision = '', amount = '', keepAmountNeedsCorrection = false } = {}) {
  const retain = control();
  retain.value = 'retain';
  const reduce = control();
  reduce.value = 'reduce';
  retain.checked = decision === 'retain';
  reduce.checked = decision === 'reduce';
  const amountInput = control(amount);
  const amountField = control();
  const error = control();
  error.hidden = true;
  const row = {
    dataset: { keepAmountNeedsCorrection: keepAmountNeedsCorrection ? 'true' : 'false' },
    querySelector(selector) {
      if (selector === '[name$="_reductionAmount"]') return amountInput;
      if (selector === '[data-departure-reduction-field]') return amountField;
      if (selector === '[data-keep-amount-error]') return error;
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'input[type="radio"][name$="_decision"]' ? [retain, reduce] : [];
    }
  };
  return { row, retain, reduce, amountInput, amountField, error };
}

test('initial invalid recovered Keep amount remains correctable', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/finance-departure-decisions.js'), 'utf8');
  const fixture = rowFixture({ decision: 'retain', amount: '25.00', keepAmountNeedsCorrection: true });
  vm.runInNewContext(source, { document: { querySelectorAll: () => [fixture.row] } });

  assert.equal(fixture.amountField.hidden, false, 'a recovered nonzero Keep amount stays visible for correction');
  assert.equal(fixture.amountInput.disabled, false);
  assert.equal(fixture.error.hidden, false);
  assert.equal(fixture.amountInput.value, '25.00');

  fixture.amountInput.value = '0.00';
  fixture.amountInput.dispatch('input');
  assert.equal(fixture.amountField.hidden, true, 'a corrected zero Keep value can be omitted from submission');
  assert.equal(fixture.amountInput.disabled, true);
  assert.equal(fixture.error.hidden, true);
});

test('choosing Keep hides and disables a typed reduction while preserving it for a later Reduce', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/finance-departure-decisions.js'), 'utf8');
  const fixture = rowFixture({ decision: 'reduce', amount: '' });
  vm.runInNewContext(source, { document: { querySelectorAll: () => [fixture.row] } });

  assert.equal(fixture.amountField.hidden, false, 'Reduce reveals its editable amount');
  assert.equal(fixture.amountInput.disabled, false);
  assert.equal(fixture.amountInput.attributes.get('aria-required'), 'true');

  fixture.amountInput.value = '100';
  fixture.amountInput.dispatch('input');
  fixture.retain.checked = true;
  fixture.reduce.checked = false;
  fixture.retain.dispatch('change');
  assert.equal(fixture.amountField.hidden, true, 'a deliberate Keep selection hides the reduction control');
  assert.equal(fixture.amountInput.disabled, true);
  assert.equal(fixture.error.hidden, true);
  assert.equal(fixture.amountInput.value, '100', 'Keep does not erase the amount if the user switches back');

  fixture.reduce.checked = true;
  fixture.retain.checked = false;
  fixture.reduce.dispatch('change');
  assert.equal(fixture.amountField.hidden, false);
  assert.equal(fixture.amountInput.disabled, false);
  assert.equal(fixture.amountInput.value, '100');
});
