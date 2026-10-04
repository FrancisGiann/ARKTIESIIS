const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const formScript = fs.readFileSync(path.join(__dirname, '../public/js/finance-schedule-form.js'), 'utf8');

class FakeHTMLElement {
  constructor(disclosure) {
    this.disclosure = disclosure;
  }

  closest(selector) {
    return selector === 'details' ? this.disclosure : null;
  }

  matches(selector) {
    return selector === '[data-schedule-term]' && Boolean(this.disclosure?.isTerm);
  }

  focus() { this.disclosure.focused = true; }
}

function loadScheduleFormScript() {
  const listeners = new Map();
  const rows = { children: [], querySelectorAll: () => [], addEventListener() {} };
  const formTermPanels = [1, 2, 3].map(() => ({ open: true, isTerm: true, parentElement: { closest: () => null } }));
  const invalidElements = [];
  const form = {
    noValidate: false,
    elements: invalidElements,
    addEventListener(name, listener) { listeners.set(name, listener); },
    querySelector(selector) {
      if (selector === '[data-finance-line-rows]') return rows;
      if (selector === '[data-finance-line-template]') return { content: { cloneNode: () => ({}) } };
      if (selector === '[data-add-finance-line]') return { addEventListener() {} };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-required-tuition-line]') return Array.from({ length: 12 });
      if (selector === '[data-schedule-term]') return formTermPanels;
      return [];
    }
  };

  vm.runInNewContext(formScript, {
    document: { querySelector: () => form },
    HTMLElement: FakeHTMLElement
  });

  return { form, listeners, termPanels: formTermPanels, invalidElements };
}

test('schedule submit reveals only the first invalid field before asking the browser to report it', () => {
  const { form, listeners, termPanels, invalidElements } = loadScheduleFormScript();
  const hiddenParent = termPanels[0];
  hiddenParent.open = false;
  hiddenParent.matches = (selector) => selector === '[data-schedule-term]';
  hiddenParent.parentElement = { closest: () => null };
  const firstInvalid = {
    willValidate: true, validity: { valid: false },
    closest: () => hiddenParent,
    focus() { this.focused = true; },
    reportValidity() { this.reported = true; }
  };
  const laterInvalid = { willValidate: true, validity: { valid: false } };
  invalidElements.push(firstInvalid, laterInvalid);
  let prevented = false;
  listeners.get('submit')({ preventDefault() { prevented = true; } });
  assert.equal(form.noValidate, true);
  assert.equal(prevented, true);
  assert.equal(hiddenParent.open, true);
  assert.equal(firstInvalid.focused, true);
  assert.equal(firstInvalid.reported, true);
  assert.deepEqual(termPanels.map((panel) => panel.open), [true, false, false]);
});
