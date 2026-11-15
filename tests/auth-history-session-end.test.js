const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');

const source = readFileSync(path.join(__dirname, '../public/js/auth-history-session-end.js'), 'utf8');
const pageSessionGuardSource = readFileSync(path.join(__dirname, '../public/js/page-session-guard.js'), 'utf8');
const pageSessionRestoreGateSource = readFileSync(path.join(__dirname, '../public/js/page-session-restore-gate.js'), 'utf8');

function createHarness({ navigationType = 'navigate', initialBinding = null, response } = {}) {
  const storage = new Map();
  if (initialBinding) storage.set('arktiesiis:page-session-binding', initialBinding);
  const listeners = new Map();
  const replacements = [];
  const fetchCalls = [];
  const elementListeners = new Map();
  const element = () => ({
    open: false,
    textContent: '',
    disabled: false,
    onclick: null,
    addEventListener(type, handler) { elementListeners.set(type, handler); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    setAttribute(name) { if (name === 'open') this.open = true; },
    removeAttribute(name) { if (name === 'open') this.open = false; }
  });
  const elements = new Map([
    ['auth-history-dialog', element()],
    ['auth-history-title', element()],
    ['auth-history-message', element()],
    ['auth-history-action', element()]
  ]);
  const document = {
    documentElement: { dataset: {}, removeAttribute(name) { delete this.dataset[name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; } },
    body: { dataset: {}, removeAttribute(name) { delete this.dataset[name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; } },
    getElementById(id) { return elements.get(id) || null; }
  };
  const window = {
    performance: { getEntriesByType() { return [{ type: navigationType }]; } },
    sessionStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    location: { replace(value) { replacements.push(value); } },
    addEventListener(type, handler) { listeners.set(type, handler); },
    setTimeout,
    clearTimeout
  };
  const fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return response;
  };
  runInNewContext(source, { window, document, fetch, AbortController });
  return { document, elements, listeners, replacements, fetchCalls, storage };
}

test('Login and Verify history listeners use a binding saved after their initial load', async () => {
  const harness = createHarness({
    response: { status: 200, ok: true, async json() { return { ended: true }; } }
  });
  const pageshow = harness.listeners.get('pageshow');
  assert.equal(typeof pageshow, 'function', 'the listener exists even when this page first loaded without a binding');
  pageshow({ persisted: false });
  assert.equal(harness.fetchCalls.length, 0, 'ordinary initial Login/Verify views do not end a session');

  const pageBinding = 'a'.repeat(64);
  harness.storage.set('arktiesiis:page-session-binding', pageBinding);
  pageshow({ persisted: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, '/session/end-history');
  assert.equal(harness.fetchCalls[0].options.method, 'POST');
  assert.equal(harness.fetchCalls[0].options.keepalive, true);
  assert.equal(harness.fetchCalls[0].options.redirect, 'error');
  assert.equal(harness.fetchCalls[0].options.headers['X-Page-Session-Binding'], pageBinding);
  assert.equal(harness.replacements[0], '/login');
  assert.equal(harness.storage.has('arktiesiis:page-session-binding'), false);
});

test('a mismatched restored page reveals its original form without replacing location or clearing the newer binding', async () => {
  const newerBinding = 'b'.repeat(64);
  const harness = createHarness({
    navigationType: 'back_forward',
    initialBinding: newerBinding,
    response: { status: 409, ok: false, async json() { return { ended: false, mismatch: true }; } }
  });
  assert.equal(harness.document.documentElement.dataset.authHistoryCheck, 'pending');
  harness.listeners.get('pageshow')({ persisted: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.document.documentElement.dataset.authHistoryCheck, undefined);
  assert.equal(harness.document.body.dataset.authHistoryState, undefined);
  assert.deepEqual(harness.replacements, []);
  assert.equal(harness.storage.get('arktiesiis:page-session-binding'), newerBinding);
  assert.equal(harness.elements.get('auth-history-dialog').open, false);
});

test('protected pages save their server binding before the first check and do not replace it from a restored page', () => {
  const pageBinding = 'c'.repeat(64);
  const newerBinding = 'd'.repeat(64);
  const storage = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const elements = new Map(['page-session-dialog', 'page-session-title', 'page-session-message', 'page-session-action']
    .map((id) => [id, {
      open: false, textContent: '', disabled: false, addEventListener() {},
      showModal() { this.open = true; }, close() { this.open = false; },
      setAttribute(name) { if (name === 'open') this.open = true; },
      removeAttribute(name) { if (name === 'open') this.open = false; }
    }]));
  const document = {
    documentElement: { dataset: {}, removeAttribute() {} },
    hidden: false,
    body: { dataset: { pageSessionBinding: pageBinding } },
    getElementById(id) { return elements.get(id) || null; },
    addEventListener(type, handler) { documentListeners.set(type, handler); }
  };
  const window = {
    sessionStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    location: { replace() {} },
    addEventListener(type, handler) { windowListeners.set(type, handler); },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 2; }, clearTimeout() {}
  };
  runInNewContext(pageSessionGuardSource, {
    window, document,
    fetch: () => new Promise(() => {}),
    AbortController
  });

  assert.equal(storage.get('arktiesiis:page-session-binding'), pageBinding,
    'a fast Back can read the bound session before the first heartbeat resolves');
  storage.set('arktiesiis:page-session-binding', newerBinding);
  windowListeners.get('pagehide')();
  windowListeners.get('pageshow')({ persisted: true });
  assert.equal(storage.get('arktiesiis:page-session-binding'), newerBinding,
    'a restored old page never overwrites the current tab binding');
  assert.equal(typeof documentListeners.get('visibilitychange'), 'function');
});

function createPageGuardHarness(navigationType = 'navigate', responsePromise = new Promise(() => {}), initialStoredBinding = null) {
  const pageBinding = 'e'.repeat(64);
  const storage = new Map();
  if (initialStoredBinding) storage.set('arktiesiis:page-session-binding', initialStoredBinding);
  const windowListeners = new Map();
  const documentListeners = new Map();
  const fetchCalls = [];
  const intervals = [];
  const replacements = [];
  const elementListeners = new Map();
  const element = () => ({
    open: false, textContent: '', disabled: false, onclick: null,
    addEventListener(type, handler) { elementListeners.set(type, handler); },
    showModal() { this.open = true; }, close() { this.open = false; },
    setAttribute(name) { if (name === 'open') this.open = true; },
    removeAttribute(name) { if (name === 'open') this.open = false; }
  });
  const elements = new Map(['page-session-dialog', 'page-session-title', 'page-session-message', 'page-session-action']
    .map((id) => [id, element()]));
  const documentElement = {
    dataset: {},
    removeAttribute(name) { delete this.dataset[name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]; }
  };
  const document = {
    hidden: false,
    documentElement,
    currentScript: { dataset: { pageSessionBinding: pageBinding } },
    body: { dataset: { pageSessionBinding: pageBinding } },
    getElementById(id) { return elements.get(id) || null; },
    addEventListener(type, handler) { documentListeners.set(type, handler); }
  };
  const window = {
    performance: { getEntriesByType() { return [{ type: navigationType }]; } },
    sessionStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    location: { replace(value) { replacements.push(value); } },
    addEventListener(type, handler) { windowListeners.set(type, handler); },
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {}
  };
  const fetch = (url, options) => {
    fetchCalls.push({ url, options });
    return responsePromise;
  };
  runInNewContext(pageSessionRestoreGateSource, { window, document });
  runInNewContext(pageSessionGuardSource, { window, document, fetch, AbortController });
  return { document, documentElement, elements, windowListeners, documentListeners, fetchCalls, intervals, storage, replacements };
}

test('fresh server-authorized pages stay visible and focus checks remain silent', () => {
  const harness = createPageGuardHarness();
  assert.equal(harness.storage.get('arktiesiis:page-session-binding'), 'e'.repeat(64), 'the head script stores the binding synchronously');
  assert.equal(harness.documentElement.dataset.pageSessionState, undefined);
  assert.equal(harness.document.body.dataset.pageSessionState, undefined);
  assert.equal(harness.elements.get('page-session-dialog').open, false);
  assert.equal(harness.fetchCalls.length, 1, 'the initial server-authorized page starts a silent check');

  harness.document.hidden = true;
  harness.documentListeners.get('visibilitychange')();
  harness.document.hidden = false;
  harness.documentListeners.get('visibilitychange')();
  assert.equal(harness.fetchCalls.length, 2, 'returning to the tab starts a fresh silent check');
  assert.equal(harness.document.body.dataset.pageSessionState, undefined);
  assert.equal(harness.elements.get('page-session-dialog').open, false);
});

test('back-forward documents stay hidden behind a check until the bound session is verified', async () => {
  const newerBinding = 'f'.repeat(64);
  const harness = createPageGuardHarness('back_forward', Promise.resolve({
    status: 200, ok: true, async json() { return { valid: true }; }
  }), newerBinding);
  assert.equal(harness.storage.get('arktiesiis:page-session-binding'), newerBinding, 'a restored document preserves the current tab binding');
  assert.equal(harness.documentElement.dataset.pageSessionState, 'checking', 'the head gate runs before body content renders');
  assert.equal(harness.document.body.dataset.pageSessionState, 'checking');
  assert.equal(harness.elements.get('page-session-dialog').open, true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.documentElement.dataset.pageSessionState, undefined);
  assert.equal(harness.document.body.dataset.pageSessionState, 'verified');
  assert.equal(harness.elements.get('page-session-dialog').open, false);
});

test('a restored BFCache page remains gated and shows the check dialog', () => {
  const harness = createPageGuardHarness();
  harness.windowListeners.get('pagehide')();
  assert.equal(harness.document.body.dataset.pageSessionState, 'checking');
  harness.windowListeners.get('pageshow')({ persisted: true });
  assert.equal(harness.document.body.dataset.pageSessionState, 'checking');
  assert.equal(harness.elements.get('page-session-dialog').open, true);
});

test('fresh-page network failures stay silent but a known revoked session opens the sign-in modal', async () => {
  const unavailable = createPageGuardHarness('navigate', Promise.reject(new Error('offline')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unavailable.document.body.dataset.pageSessionState, undefined);
  assert.equal(unavailable.elements.get('page-session-dialog').open, false);

  const revoked = createPageGuardHarness('navigate', Promise.resolve({
    status: 401, ok: false, async json() { return { valid: false }; }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revoked.document.body.dataset.pageSessionState, 'revoked');
  assert.equal(revoked.elements.get('page-session-dialog').open, true);
  assert.equal(revoked.elements.get('page-session-message').textContent, 'Your session ended. Please sign in again.');
  revoked.elements.get('page-session-action').onclick();
  assert.deepEqual(revoked.replacements, ['/login']);
});
