const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');

const source = readFileSync(path.join(__dirname, '../public/js/auth-history-session-end.js'), 'utf8');
const pageSessionGuardSource = readFileSync(path.join(__dirname, '../public/js/page-session-guard.js'), 'utf8');

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
