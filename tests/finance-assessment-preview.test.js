'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('assessment preview opens for review and cancel or Escape returns focus without confirming', () => {
  const listeners = {};
  const classes = new Set();
  let focused = '';
  let open = true;
  const closeLink = { focus() { focused = 'cancel'; },
    addEventListener(type, handler) { listeners[`link:${type}`] = handler; } };
  const opener = { isConnected: true, focus() { focused = 'opener'; } };
  const dialog = { dataset: { annualId: '21' },
    querySelector() { return closeLink; },
    removeAttribute(name) { assert.equal(name, 'open'); open = false; },
    showModal() { open = true; },
    close() { open = false; listeners['dialog:close'](); },
    addEventListener(type, handler) { listeners[`dialog:${type}`] = handler; } };
  const document = { body: { classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); } } },
    querySelector() { return dialog; },
    querySelectorAll() { return [{ dataset: { annualId: '21' }, querySelector() { return opener; } }]; } };

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/finance-assessment-preview.js'), 'utf8'), { document });
  assert.equal(open, true);
  assert.equal(focused, 'cancel', 'safe cancel action receives initial focus');
  assert.equal(classes.has('finance-assessment-dialog-open'), true);
  let prevented = false;
  listeners['link:click']({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(open, false);
  assert.equal(focused, 'opener');
  assert.equal(classes.has('finance-assessment-dialog-open'), false);
});
