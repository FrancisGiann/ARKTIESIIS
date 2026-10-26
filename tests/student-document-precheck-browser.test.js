const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

test('student precheck never transfers a stale result to a replaced file', async () => {
  const controls = new Map();
  const control = (selector, value = '') => {
    const handlers = new Map();
    const item = { value, files: [], disabled: false, hidden: true, dataset: {},
      addEventListener(name, handler) { handlers.set(name, handler); },
      fire(name) { return handlers.get(name)?.(); }, click() {}, focus() {} };
    controls.set(selector, item);
    return item;
  };
  const file = control('input[type="file"][name="document"]');
  control('[name="documentType"]', 'report_card');
  const token = control('[name="precheckToken"]');
  const check = control('[data-check-document]');
  const proceed = control('[data-proceed-document]');
  control('[data-replace-document]');
  control('[name="_csrf"]', 'synthetic-csrf');
  const result = { children: [], replaceChildren() { this.children = []; }, append(item) { this.children.push(item); } };
  controls.set('[data-precheck-result]', result);
  const form = { dataset: {}, querySelector(selector) { return controls.get(selector); } };
  let resolveResponse;
  const fetch = () => new Promise((resolve) => { resolveResponse = resolve; });
  class FormData { append() {} }
  const document = {
    querySelectorAll() { return [form]; },
    createElement() { return { textContent: '', children: [], append(item) { this.children.push(item); } }; }
  };
  const script = await fs.readFile(path.join(__dirname, '../public/js/student-document-precheck.js'), 'utf8');
  vm.runInNewContext(script, { document, fetch, FormData });
  assert.equal(proceed.disabled, false, 'manual submission is available without an AI check');
  assert.equal(proceed.textContent, 'Submit for manual review');
  file.files = [{ name: 'original.pdf' }];
  file.fire('change');
  const pending = check.fire('click');
  file.files = [{ name: 'replacement.pdf' }];
  file.fire('change');
  resolveResponse({ ok: true, json: async () => ({ token: 'old-token', message: 'Old result' }) });
  await pending;
  assert.equal(token.value, '');
  assert.equal(proceed.disabled, false, 'a changed file may be sent directly for manual review');
  assert.doesNotMatch(result.children[0].textContent, /Old result/);
  const warningCheck = check.fire('click');
  resolveResponse({ ok: true, json: async () => ({ token: 'current-token', message: 'Check the selected document.',
    warnings: ['The visible name may differ.'] }) });
  await warningCheck;
  assert.equal(proceed.disabled, false);
  assert.equal(proceed.textContent, 'Submit anyway');
  assert.equal(result.children[0].textContent, 'Possible issue with this document');
  assert.match(result.children.at(-1).textContent, /Staff will review it/);
  file.files = [{ name: 'unsupported.exe' }];
  file.fire('change');
  assert.equal(proceed.disabled, false);
  assert.equal(proceed.textContent, 'Submit for manual review');
  const rejectedCheck = check.fire('click');
  resolveResponse({ ok: false, status: 400, json: async () => ({ error: 'Unsupported file format.' }) });
  await rejectedCheck;
  assert.equal(proceed.disabled, true, 'a definite unsupported format must not be submitted');
  assert.equal(token.value, '');
  file.files = [{ name: 'quota-file.pdf' }];
  file.fire('change');
  const limitedCheck = check.fire('click');
  resolveResponse({ ok: true, json: async () => ({ status: 'limited', token: 'manual-token',
    message: 'The next AI check is available in about 1 minute. You can submit this document for manual staff review now.' }) });
  await limitedCheck;
  assert.equal(proceed.disabled, false, 'AI quota must not block staff review');
  assert.equal(proceed.textContent, 'Submit for manual review');
});
