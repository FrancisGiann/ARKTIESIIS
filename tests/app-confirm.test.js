'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initialize } = require('../public/js/app-confirm');

class FakeElement {
  constructor(tagName, document, { supported = true, throwsOnShow = false } = {}) {
    this.tagName = tagName.toUpperCase();
    this.document = document;
    this.listeners = new Map();
    this.attributes = new Map();
    this.children = [];
    this.isConnected = false;
    this.open = false;
    this.returnValue = '';
    if (tagName.toLowerCase() === 'dialog' && supported) {
      this.showModal = () => {
        if (throwsOnShow) throw new Error('Synthetic modal unavailable');
        this.open = true;
      };
      this.close = (returnValue = '') => {
        this.returnValue = returnValue;
        this.open = false;
        this.dispatch('close', { target: this });
      };
    }
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) {
    this.children.push(...children);
    for (const child of children) {
      child.parentElement = this;
      child.isConnected = this.isConnected;
    }
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
  }
  dispatch(type, event = {}) {
    event.preventDefault ||= function preventDefault() { this.defaultPrevented = true; };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
  }
  focus() { this.document.activeElement = this; }
  remove() {
    this.isConnected = false;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
  }
}

function fakeDocument({ supported = true, throwsOnShow = false } = {}) {
  const document = { activeElement: null };
  document.body = new FakeElement('body', document);
  document.body.isConnected = true;
  document.createElement = (tagName) => new FakeElement(tagName, document, { supported, throwsOnShow });
  document.body.append = function append(...children) {
    FakeElement.prototype.append.apply(this, children);
    const connect = (element) => {
      element.isConnected = true;
      for (const child of element.children) connect(child);
    };
    for (const child of children) connect(child);
  };
  document.getElementById = (id) => {
    const pending = [...document.body.children];
    while (pending.length) {
      const element = pending.shift();
      if (element.id === id) return element;
      pending.push(...element.children);
    }
    return null;
  };
  return document;
}

function findById(root, id) {
  const pending = [...root.children];
  while (pending.length) {
    const element = pending.shift();
    if (element.id === id) return element;
    pending.push(...element.children);
  }
  return null;
}

function findByClass(root, className) {
  const pending = [...root.children];
  while (pending.length) {
    const element = pending.shift();
    if (element.className === className) return element;
    pending.push(...element.children);
  }
  return null;
}

test('modal uses safe text, starts at Cancel, restores focus, and does not share approvals', async () => {
  const document = fakeDocument();
  const trigger = new FakeElement('button', document);
  trigger.isConnected = true;
  document.activeElement = trigger;
  let nativeDialogs = 0;
  const window = {
    confirm() { nativeDialogs += 1; throw new Error('Native confirm must not run'); },
    alert() { nativeDialogs += 1; throw new Error('Native alert must not run'); },
    prompt() { nativeDialogs += 1; throw new Error('Native prompt must not run'); }
  };
  initialize({ document, window });

  const pending = window.appConfirm('<script>do not parse</script>', { title: 'Synthetic action', confirmLabel: 'Proceed' });
  const dialog = document.body.children.find((element) => element.tagName === 'DIALOG');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute('role'), 'alertdialog');
  assert.equal(dialog.getAttribute('aria-modal'), null, 'native dialog modality supplies modal semantics');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'app-confirm-title');
  assert.equal(findById(dialog, 'app-confirm-title').textContent, 'Synthetic action');
  assert.equal(findById(dialog, 'app-confirm-message').textContent, '<script>do not parse</script>');
  assert.equal(document.activeElement.textContent, 'Cancel');

  const cancelButton = document.activeElement;
  const confirmButton = findByClass(dialog, 'button button--primary');
  const wrappedFromStart = { key: 'Tab', shiftKey: true };
  dialog.dispatch('keydown', wrappedFromStart);
  assert.equal(wrappedFromStart.defaultPrevented, true, 'Shift+Tab from the first button wraps to the final button');
  assert.equal(document.activeElement, confirmButton);
  const wrappedFromEnd = { key: 'Tab', shiftKey: false };
  dialog.dispatch('keydown', wrappedFromEnd);
  assert.equal(wrappedFromEnd.defaultPrevented, true, 'Tab from the final button wraps to Cancel');
  assert.equal(document.activeElement, cancelButton);
  document.activeElement = document.body;
  const restoredInside = { key: 'Tab', shiftKey: false };
  dialog.dispatch('keydown', restoredInside);
  assert.equal(restoredInside.defaultPrevented, true, 'focus moved outside is returned to the dialog');
  assert.equal(document.activeElement, cancelButton);

  const duplicateApproval = await window.appConfirm('A second action must not inherit the open approval');
  assert.equal(duplicateApproval, false);
  assert.equal(dialog.open, true);
  confirmButton.listeners.get('click')[0]();
  assert.equal(await pending, true);
  assert.equal(dialog.isConnected, false);
  assert.equal(document.activeElement, trigger);
  assert.equal(nativeDialogs, 0);
});

test('Escape cancellation restores focus without approving and unavailable dialogs fail closed accessibly', async () => {
  const document = fakeDocument();
  const trigger = new FakeElement('a', document);
  trigger.isConnected = true;
  document.activeElement = trigger;
  const window = {};
  initialize({ document, window });
  const pending = window.appConfirm('Confirm a change?');
  const dialog = document.body.children.find((element) => element.tagName === 'DIALOG');
  dialog.close('');
  assert.equal(await pending, false, 'the browser Escape close value is treated as cancel');
  assert.equal(document.activeElement, trigger);

  const unsupportedDocument = fakeDocument({ supported: false });
  let nativeCalls = 0;
  const unsupportedWindow = {
    confirm() { nativeCalls += 1; return true; },
    alert() { nativeCalls += 1; },
    prompt() { nativeCalls += 1; }
  };
  initialize({ document: unsupportedDocument, window: unsupportedWindow });
  assert.equal(await unsupportedWindow.appConfirm('Do not silently approve this action.'), false);
  const notice = unsupportedDocument.getElementById('app-confirm-unavailable');
  assert.equal(notice.getAttribute('role'), 'alert');
  assert.match(notice.textContent, /Your changes are still here/);
  assert.equal(nativeCalls, 0, 'unsupported dialogs do not fall back to native browser prompts');
});

test('a dialog-opening failure is canceled and announced', async () => {
  const document = fakeDocument({ throwsOnShow: true });
  let nativeCalls = 0;
  const window = { confirm() { nativeCalls += 1; return true; } };
  initialize({ document, window });
  assert.equal(await window.appConfirm('Dangerous action?'), false);
  assert.equal(document.getElementById('app-confirm-unavailable').getAttribute('role'), 'alert');
  assert.equal(nativeCalls, 0);
});

test('application JavaScript and templates do not call native alert, confirm, or prompt APIs', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const sourceFiles = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (/\.(?:js|ejs|html)$/i.test(entry.name)) sourceFiles.push(filename);
    }
  }
  visit(path.join(projectRoot, 'public', 'js'));
  visit(path.join(projectRoot, 'views'));
  const nativeDialogCall = /\b(?:window|globalThis)\s*\.\s*(?:alert|confirm|prompt)\s*\(|\b(?:alert|prompt|confirm)\s*\(|\bon(?:submit|click)\s*=\s*["'][^"']*\bconfirm\s*\(/i;
  const offenders = sourceFiles.filter((filename) => {
    const source = fs.readFileSync(filename, 'utf8').replace(/\bfunction\s+confirm\s*\(/g, 'function confirmHandler(');
    return nativeDialogCall.test(source);
  });
  assert.deepEqual(offenders, [], 'app-owned confirmations must use the accessible modal helper');
});
