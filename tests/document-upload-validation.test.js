const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

test('a later file selection cannot inherit validation from an older async check or resumed submit', async () => {
  const handlers = {};
  class Input {
    constructor() { this.type = 'file'; this.name = 'document'; this.files = []; this.parentElement = { querySelector: () => this.notice || null }; }
    insertAdjacentElement(_where, notice) { this.notice = notice; }
    focus() { this.focused = true; }
  }
  class Form {
    constructor(input) { this.input = input; this.resubmissions = 0; }
    querySelector() { return this.input; }
    requestSubmit() {
      this.resubmissions += 1;
      handlers.submit({ target: this, preventDefault() { this.defaultPrevented = true; } });
    }
  }
  const document = {
    addEventListener(name, handler) { handlers[name] = handler; },
    createElement() { return { dataset: {}, setAttribute() {}, textContent: '' }; }
  };
  const script = await fs.readFile(path.join(__dirname, '../public/js/document-upload-validation.js'), 'utf8');
  vm.runInNewContext(script, { document, HTMLInputElement: Input, HTMLFormElement: Form, Uint8Array });
  const input = new Input();
  const form = new Form(input);
  let resolveOld;
  const old = { name: 'old.pdf', type: 'application/pdf', slice: () => ({ arrayBuffer: () => new Promise((resolve) => { resolveOld = resolve; }) }) };
  const invalid = { name: 'new.exe', type: 'application/octet-stream', slice: () => ({ arrayBuffer: async () => Buffer.from('invalid') }) };
  input.files = [old];
  handlers.change({ target: input });
  input.files = [invalid];
  handlers.change({ target: input });
  resolveOld(Buffer.from('%PDF-1.7'));
  await new Promise((resolve) => setImmediate(resolve));
  const blocked = { target: form, preventDefault() { this.defaultPrevented = true; } };
  handlers.submit(blocked);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blocked.defaultPrevented, true);
  assert.equal(form.resubmissions, 0);
  assert.match(input.notice.textContent, /Choose a PDF, JPEG, or PNG/);

  const valid = { name: 'new.pdf', type: 'application/pdf', slice: () => ({ arrayBuffer: async () => Buffer.from('%PDF-1.7') }) };
  input.files = [valid];
  handlers.change({ target: input });
  await new Promise((resolve) => setImmediate(resolve));
  input.files = [invalid];
  handlers.change({ target: input });
  handlers.submit({ target: form, preventDefault() { this.defaultPrevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(form.resubmissions, 0, 'a new invalid file is checked even after an earlier file passed');

  const secondInput = new Input();
  const secondForm = new Form(secondInput);
  secondInput.files = [valid];
  handlers.submit({ target: secondForm, preventDefault() { this.defaultPrevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondForm.resubmissions, 1);
  secondInput.files = [invalid];
  handlers.change({ target: secondInput });
  handlers.submit({ target: secondForm, preventDefault() { this.defaultPrevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondForm.resubmissions, 1, 'a resumed submit does not exempt a later file selection');
});
