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
}

function loadScheduleFormScript() {
  const listeners = new Map();
  const rows = { children: [], querySelectorAll: () => [], addEventListener() {} };
  const form = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    querySelector(selector) {
      if (selector === '[data-finance-line-rows]') return rows;
      if (selector === '[data-finance-line-template]') return { content: { cloneNode: () => ({}) } };
      if (selector === '[data-add-finance-line]') return { addEventListener() {} };
      return null;
    },
    querySelectorAll(selector) {
      return selector === '[data-required-tuition-line]' ? Array.from({ length: 12 }) : [];
    }
  };

  vm.runInNewContext(formScript, {
    document: { querySelector: () => form },
    HTMLElement: FakeHTMLElement
  });

  return { form, listeners };
}

test('native validation opens each invalid term and its ancestor fee disclosures', () => {
  const { listeners } = loadScheduleFormScript();
  const createForm = { open: false, parentElement: null };
  const termPanels = [1, 2, 3].map(() => ({
    open: false,
    parentElement: { closest: (selector) => selector === 'details' ? createForm : null }
  }));
  const additionalFees = {
    open: false,
    parentElement: { closest: (selector) => selector === 'details' ? createForm : null }
  };
  const invalid = listeners.get('invalid');

  for (const panel of termPanels) invalid({ target: new FakeHTMLElement(panel) });
  invalid({ target: new FakeHTMLElement(additionalFees) });

  assert.deepEqual(termPanels.map((panel) => panel.open), [true, true, true]);
  assert.equal(additionalFees.open, true);
  assert.equal(createForm.open, true);
});
