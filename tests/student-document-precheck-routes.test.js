const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createDocumentsRouter } = require('../src/routes/documents');

test('student early check needs CSRF, stays private, and a changed checked file cannot be submitted', async () => {
  const app = express();
  const calls = [];
  app.set('views', require('node:path').join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.use((req, _res, next) => {
    req.authUser = { id: 17, role: 'student' };
    req.session = { csrfToken: 'synthetic-csrf' };
    next();
  });
  app.use('/documents', createDocumentsRouter({
    environment: { upload: { maxMb: 1 }, sessionSecret: 'synthetic-test-signing-secret-32bytes' },
    documentService: { async upload() { calls.push('uploaded'); return { id: 1, documentType: 'good_moral', status: 'pending' }; } },
    documentProcessingService: { schedulePendingProcessing() {} },
    form137ScanService: { async scan() {} },
    physicalChecklistService: {},
    studentDocumentPrecheckService: {
      async check() { calls.push('checked'); return { status: 'checked', warnings: [], message: 'Staff review is required.', token: 'bound-token' }; },
      matchesToken(token, actorId, type, assignmentId, file) {
        return token === 'bound-token' && actorId === 17 && type === 'good_moral'
          && assignmentId === null && file.buffer.includes(Buffer.from('original'));
      }
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const form = (content, csrf = 'synthetic-csrf', token = '') => {
      const data = new FormData();
      data.append('_csrf', csrf);
      data.append('documentType', 'good_moral');
      if (token) data.append('precheckToken', token);
      data.append('document', new Blob([`%PDF-1.4\n${content}`], { type: 'application/pdf' }), 'sample.pdf');
      return data;
    };
    const forbidden = await fetch(`${base}/documents/precheck`, { method: 'POST', body: form('original', 'bad') });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(calls, []);
    const checked = await fetch(`${base}/documents/precheck`, { method: 'POST', body: form('original') });
    assert.equal(checked.status, 200);
    assert.match(checked.headers.get('cache-control'), /private, no-store/);
    assert.equal((await checked.json()).token, 'bound-token');
    const stale = await fetch(`${base}/documents`, { method: 'POST', body: form('replacement', 'synthetic-csrf', 'bound-token'), redirect: 'manual' });
    assert.equal(stale.status, 409);
    assert.deepEqual(calls, ['checked']);
    const allowed = await fetch(`${base}/documents`, { method: 'POST', body: form('original', 'synthetic-csrf', 'bound-token'), redirect: 'manual' });
    assert.equal(allowed.status, 303);
    assert.deepEqual(calls, ['checked', 'uploaded']);
    const manual = await fetch(`${base}/documents`, { method: 'POST', body: form('manual-review'), redirect: 'manual' });
    assert.equal(manual.status, 303, 'an unavailable or disabled early AI check does not block final staff review');
    assert.deepEqual(calls, ['checked', 'uploaded', 'uploaded']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
