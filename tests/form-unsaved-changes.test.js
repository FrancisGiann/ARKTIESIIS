'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { initialize } = require('../public/js/form-unsaved-changes');

function control({ tag = 'INPUT', type = 'text', name = 'field', value = '', checked = false, hidden = false } = {}) {
  return { tagName: tag, type, name, value, checked, hidden, disabled: false, readOnly: false, files: [], multiple: false,
    selectedOptions: [], setAttribute() {}, getAttribute() { return null; } };
}

function form(fields = [], { method = 'post', attributes = {} } = {}) {
  const attrs = new Map(Object.entries(attributes));
  return { tagName: 'FORM', method, dataset: {}, fields, isConnected: true,
    querySelectorAll() { return this.fields; },
    hasAttribute(name) { return attrs.has(name); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    setAttribute(name, value) { attrs.set(name, value); }
  };
}

function environment(forms = [], { appConfirm, readyState = 'loading', url = 'https://school.test/pre-enrollments/1/edit' } = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const queuedMicrotasks = [];
  const timers = new Map();
  let nextTimerId = 1;
  const assignedUrls = [];
  const document = {
    readyState, documentElement: {},
    querySelectorAll(selector) {
      if (selector === 'form') return forms;
      if (selector === '[data-error-target]') return [];
      return [];
    },
    querySelector() { return null; },
    getElementById() { return null; },
    addEventListener(type, listener, options = false) {
      const listeners = documentListeners.get(type) || [];
      listeners.push({ listener, capture: options === true || options?.capture === true });
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      documentListeners.set(type, (documentListeners.get(type) || []).filter((item) => item.listener !== listener));
    }
  };
  const window = {
    location: { href: url, assign(href) { assignedUrls.push(href); } },
    appConfirm,
    MutationObserver: null,
    queueMicrotask(callback) { queuedMicrotasks.push(callback); },
    setTimeout(callback, delay) { const id = nextTimerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, listener) { windowListeners.set(type, (windowListeners.get(type) || []).filter((item) => item !== listener)); }
  };
  function flushMicrotasks() { while (queuedMicrotasks.length) queuedMicrotasks.shift()(); }
  function dispatchDocument(type, event = {}) {
    event.defaultPrevented = Boolean(event.defaultPrevented);
    event.preventDefault ||= function preventDefault() { this.defaultPrevented = true; };
    event.stopImmediatePropagation ||= function stopImmediatePropagation() { this.immediateStopped = true; };
    for (const { listener } of [...(documentListeners.get(type) || [])]) {
      listener(event);
      if (event.immediateStopped) break;
    }
    return event;
  }
  function dispatchWindow(type, event = {}) {
    event.defaultPrevented = Boolean(event.defaultPrevented);
    event.preventDefault ||= function preventDefault() { this.defaultPrevented = true; };
    for (const listener of [...(windowListeners.get(type) || [])]) listener(event);
    return event;
  }
  function ready() {
    document.readyState = 'interactive';
    dispatchDocument('DOMContentLoaded', {});
  }
  const guard = initialize({ document, window, queueMicrotask: (callback) => queuedMicrotasks.push(callback),
    setTimeout: (callback, delay) => { const id = nextTimerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id), now: () => 1000 });
  return { document, window, guard, ready, dispatchDocument, dispatchWindow, flushMicrotasks, timers, assignedUrls };
}

function controlledConfirmations() {
  const requests = [];
  return {
    requests,
    appConfirm(message, options) {
      return new Promise((resolve) => requests.push({ message, options, resolve }));
    }
  };
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function clickEvent(anchor) {
  return { target: anchor, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
}

function link(href, attributes = {}) {
  const attrs = new Map(Object.entries(attributes));
  return { href, isConnected: true,
    closest(selector) { return selector === 'a[href]' ? this : null; },
    hasAttribute(name) { return attrs.has(name); },
    getAttribute(name) { return attrs.get(name) ?? null; }
  };
}

function beforeUnload(environment) {
  return environment.dispatchWindow('beforeunload', { returnValue: undefined });
}

test('dirty baselines follow page initialization and compare text, select, checkbox, and file values', () => {
  const text = control({ name: 'comment', value: '' });
  const select = control({ tag: 'SELECT', name: 'term', value: 'term-1' });
  const checkbox = control({ type: 'checkbox', name: 'confirm', value: '1' });
  const file = control({ type: 'file', name: 'attachment' });
  const hidden = control({ type: 'hidden', name: 'calculated-total', value: '0' });
  const postForm = form([text, select, checkbox, file, hidden]);
  const search = control({ name: 'search', value: '' });
  const getForm = form([search], { method: 'get' });
  const env = environment([postForm, getForm]);
  env.guard;

  text.value = 'initialized default';
  select.value = 'term-1';
  env.ready();
  assert.equal(env.guard.dirtyForms().length, 0, 'script-populated defaults are part of the initial baseline');

  text.value = 'changed';
  assert.deepEqual(env.guard.dirtyForms(), [postForm]);
  assert.equal(beforeUnload(env).defaultPrevented, true, 'when native validation blocks submit before a submit event, unsaved values remain protected');
  text.value = 'initialized default';
  assert.equal(env.guard.dirtyForms().length, 0, 'reverting a text field to its saved value clears dirty state');
  select.value = 'term-2';
  assert.equal(env.guard.dirtyForms().length, 1);
  select.value = 'term-1';
  checkbox.checked = true;
  assert.equal(env.guard.dirtyForms().length, 1);
  checkbox.checked = false;
  const firstFile = { name: 'scan.pdf', size: 12, lastModified: 23, type: 'application/pdf' };
  file.files = [firstFile];
  assert.equal(env.guard.dirtyForms().length, 1);
  file.files = [];
  file.files = [firstFile];
  env.guard.refreshBaseline(postForm);
  const sameMetadataFile = { name: 'scan.pdf', size: 12, lastModified: 23, type: 'application/pdf' };
  file.files = [sameMetadataFile];
  assert.equal(env.guard.dirtyForms().length, 1, 'replacing a file with one having identical metadata still counts as an edit');
  file.files = [firstFile];
  assert.equal(env.guard.dirtyForms().length, 0, 'restoring the original selected file clears its dirty state');
  file.files = [];
  env.guard.refreshBaseline(postForm);
  hidden.value = '42';
  search.value = 'Ari';
  assert.equal(env.guard.dirtyForms().length, 0, 'calculated hidden values and GET filters do not dirty tracked forms');
  env.dispatchDocument('submit', { target: getForm, submitter: null });
  env.flushMicrotasks();
  assert.equal(env.guard.dirtyForms().length, 0, 'submitting a GET search form does not make that form dirty');

  postForm.fields.push(control({ name: 'added-row-reason', value: '' }));
  assert.equal(env.guard.dirtyForms().length, 1, 'new editable controls are protected once added to an initialized form');
});

test('navigation ignores same-page, new-tab, and download links; modal cancel retains values and acceptance is one-use', async () => {
  const field = control({ name: 'firstName', value: 'Saved' });
  const editForm = form([field]);
  const confirmations = controlledConfirmations();
  const env = environment([editForm], { ...confirmations, url: 'https://school.test/pre-enrollments/1/edit?tab=paper' });
  env.ready();
  field.value = 'Changed';

  for (const anchor of [
    link('/pre-enrollments/1/edit?tab=paper#identity'),
    link('/login', { target: '_blank' }),
    link('/source.pdf', { download: '' }),
    link('/documents/8/preview', { 'data-document-preview-trigger': '' }),
    link('/documents?section=paper#paper-records', { 'data-student-document-section': 'paper' })
  ]) env.dispatchDocument('click', clickEvent(anchor));
  assert.equal(env.guard.dirtyForms().length, 1);

  const samePathReload = env.dispatchDocument('click', clickEvent(link('/pre-enrollments/1/edit?tab=paper')));
  assert.equal(samePathReload.defaultPrevented, true, 'a same-path link without a fragment still reloads and must warn');
  assert.equal(field.value, 'Changed');
  assert.equal(confirmations.requests.length, 1);
  confirmations.requests[0].resolve(false);
  await settlePromises();

  const canceled = env.dispatchDocument('click', clickEvent(link('/pre-enrollments')));
  assert.equal(canceled.defaultPrevented, true);
  assert.equal(canceled.immediateStopped, true);
  assert.equal(confirmations.requests.length, 2);
  confirmations.requests[1].resolve(false);
  await settlePromises();
  assert.equal(field.value, 'Changed');
  const unloadAfterCancel = beforeUnload(env);
  assert.equal(unloadAfterCancel.defaultPrevented, true);
  assert.equal(unloadAfterCancel.returnValue, '');

  env.dispatchDocument('click', clickEvent(link('/login')));
  confirmations.requests[2].resolve(true);
  await settlePromises();
  assert.deepEqual(env.assignedUrls, ['/login']);
  const unloadAfterAcceptance = beforeUnload(env);
  assert.equal(unloadAfterAcceptance.defaultPrevented, false, 'accepted navigation consumes a one-shot unload approval');
  assert.equal(env.guard.dirtyForms().length, 1, 'the approval does not mark the form saved');
});

test('an accepted navigation that does not unload expires without suppressing a later warning', async () => {
  const field = control({ name: 'firstName', value: 'Saved' });
  const confirmations = controlledConfirmations();
  const env = environment([form([field])], confirmations);
  env.ready();
  field.value = 'Changed';
  const click = env.dispatchDocument('click', clickEvent(link('/login')));
  assert.equal(click.defaultPrevented, true);
  confirmations.requests[0].resolve(true);
  await settlePromises();
  const approvalTimer = [...env.timers.values()].find((record) => record.delay === 1500);
  assert.ok(approvalTimer, 'accepted navigation has a short-lived one-use approval');
  approvalTimer.callback();
  assert.equal(beforeUnload(env).defaultPrevented, true, 'a navigation that does not unload cannot leave stale suppression');
});

test('multi-form saves ask before discarding other edits; prevented preview submissions remain dirty', async () => {
  const edited = form([control({ name: 'reason', value: '' })]);
  const clean = form([control({ name: 'filter', value: '' })]);
  const confirmations = controlledConfirmations();
  const env = environment([edited, clean], confirmations);
  clean.requestSubmit = (submitter) => env.dispatchDocument('submit', { target: clean, submitter });
  env.ready();
  edited.fields[0].value = 'Unsaved reason';

  const canceled = env.dispatchDocument('submit', { target: clean, submitter: null });
  assert.equal(canceled.defaultPrevented, true);
  confirmations.requests[0].resolve(false);
  await settlePromises();
  assert.equal(env.guard.dirtyForms().length, 1);
  assert.equal(edited.fields[0].value, 'Unsaved reason');

  const accepted = env.dispatchDocument('submit', { target: clean, submitter: null });
  assert.equal(accepted.defaultPrevented, true);
  confirmations.requests[1].resolve(true);
  await settlePromises();
  assert.equal(beforeUnload(env).defaultPrevented, false, 'the accepted save does not trigger a second generic warning');

  const preview = form([control({ name: 'reason', value: '' })]);
  const previewEnv = environment([preview]);
  previewEnv.ready();
  preview.fields[0].value = 'Preview only';
  previewEnv.document.addEventListener('submit', (event) => event.preventDefault());
  previewEnv.dispatchDocument('submit', { target: preview, submitter: null });
  previewEnv.flushMicrotasks();
  assert.equal(previewEnv.guard.dirtyForms().length, 1, 'preventDefault previews do not mark the form saved');
  assert.equal(beforeUnload(previewEnv).defaultPrevented, true);
});

test('failed-post recovery stays dirty, and native submission approval never marks a form saved', () => {
  const recovered = form([control({ name: 'firstName', value: 'Recovered value' })], {
    attributes: { 'data-unsaved-initially-dirty': 'true' }
  });
  const env = environment([recovered]);
  env.ready();
  assert.equal(env.guard.dirtyForms().length, 1, 'recovered request values are not mistaken for a saved baseline');
  env.document.addEventListener('submit', (event) => event.preventDefault());
  env.dispatchDocument('submit', { target: recovered, submitter: null });
  env.flushMicrotasks();
  assert.equal(env.guard.dirtyForms().length, 1, 'a failed or prevented post remains protected');

  const successful = form([control({ name: 'firstName', value: 'Saved' })]);
  const saveEnv = environment([successful]);
  saveEnv.ready();
  successful.fields[0].value = 'Submitted value';
  saveEnv.dispatchDocument('submit', { target: successful, submitter: null });
  saveEnv.flushMicrotasks();
  assert.equal(saveEnv.guard.dirtyForms().length, 1, 'the submitted form stays dirty until the browser actually leaves the page');
  assert.equal(beforeUnload(saveEnv).defaultPrevented, false, 'a native save avoids a second generic unload warning');
  assert.equal(saveEnv.guard.dirtyForms().length, 1, 'one-shot unload approval does not change the saved baseline');
  assert.equal(beforeUnload(saveEnv).defaultPrevented, true, 'if the POST fails without leaving, the approval is consumed and edits stay protected');
});

test('confirmed form actions replay once with the original submitter and reject a changed target', async () => {
  const confirmations = controlledConfirmations();
  const remove = form([], { attributes: {
    'data-confirm': '',
    'data-confirm-message': 'Remove this draft item?',
    method: 'post',
    action: '/registrar/retake-referrals/77/items/4/remove'
  } });
  remove.action = 'https://school.test/registrar/retake-referrals/77/items/4/remove';
  let replayedEvent;
  let replayCount = 0;
  const submitter = { name: 'removeItem', value: '4', isConnected: true, form: remove,
    getAttribute() { return null; } };
  const env = environment([remove], confirmations);
  remove.requestSubmit = (originalSubmitter) => {
    replayCount += 1;
    replayedEvent = env.dispatchDocument('submit', { target: remove, submitter: originalSubmitter });
  };
  env.ready();
  const initial = env.dispatchDocument('submit', { target: remove, submitter });
  const repeated = env.dispatchDocument('submit', { target: remove, submitter });
  assert.equal(initial.defaultPrevented, true);
  assert.equal(repeated.defaultPrevented, true, 'a repeated submit cannot pass while confirmation is pending');
  assert.equal(confirmations.requests.length, 1, 'repeated submission does not open a second approval');
  assert.match(confirmations.requests[0].message, /Remove this draft item/);
  confirmations.requests[0].resolve(true);
  await settlePromises();
  assert.equal(replayedEvent?.defaultPrevented, false, 'the exact approved replay is allowed through the guard');
  assert.equal(replayedEvent?.submitter, submitter, 'requestSubmit keeps the successful submitter');
  assert.equal(replayCount, 1, 'accepting the destructive confirmation causes exactly one form replay');

  const changedConfirmations = controlledConfirmations();
  const changed = form([], { attributes: { 'data-confirm': '', method: 'post', action: '/remove/one' } });
  changed.action = 'https://school.test/remove/one';
  let changedReplayCount = 0;
  const changedEnv = environment([changed], changedConfirmations);
  changed.requestSubmit = () => { changedReplayCount += 1; };
  changedEnv.ready();
  changedEnv.dispatchDocument('submit', { target: changed, submitter: null });
  changed.action = 'https://school.test/remove/two';
  changedConfirmations.requests[0].resolve(true);
  await settlePromises();
  assert.equal(changedReplayCount, 0, 'approval is discarded if the form action changed while the modal was open');
});

test('repeated actions cannot reuse an open confirmation and detached forms are not replayed', async () => {
  const confirmations = controlledConfirmations();
  const action = form([], { attributes: { 'data-confirm': '', method: 'post' } });
  const env = environment([action], confirmations);
  let replayCount = 0;
  action.requestSubmit = () => { replayCount += 1; };
  env.ready();
  const first = env.dispatchDocument('submit', { target: action, submitter: null });
  const second = env.dispatchDocument('submit', { target: action, submitter: null });
  assert.equal(first.defaultPrevented, true);
  assert.equal(second.defaultPrevented, true);
  assert.equal(confirmations.requests.length, 1, 'one pending dialog cannot authorize a second submit event');
  action.isConnected = false;
  confirmations.requests[0].resolve(true);
  await settlePromises();
  assert.equal(replayCount, 0, 'a removed form is not submitted after the user confirms');
});
