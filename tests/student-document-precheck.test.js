const test = require('node:test');
const assert = require('node:assert/strict');
const { createStudentDocumentPrecheckService } = require('../src/services/studentDocumentPrecheckService');

const sql = { Int: 'INT', BigInt: 'BIGINT', MAX: 'MAX', Char: () => 'CHAR', NVarChar: () => 'VARCHAR' };
const pdf = (content = 'one') => {
  const buffer = Buffer.from(`%PDF-1.4\n${content}`);
  return { buffer, size: buffer.length, originalname: 'sample.pdf', mimetype: 'application/pdf' };
};

function setup({ actorRole = 'student', enabled = true, extraction, clock, getDocument, model = null,
  reserveCheck = async () => ({ allowed: true, attemptId: 1 }), findReusable = async () => null,
  finishCheck = async () => {} } = {}) {
  let calls = 0;
  let stored = 0;
  const pool = {
    request() {
      return {
        input() { return this; },
        async query(query) {
          if (query.includes('FROM students AS s')) {
            return { recordset: actorRole === 'student' ? [{ id: 7, status: 'active', first_name: 'Alex', last_name: 'Reyes' }] : [] };
          }
          if (query.includes('FROM requirement_assignments')) return { recordset: [{ id: 12 }] };
          if (query.includes('DELETE FROM student_document_early_evidence')) return { rowsAffected: [0] };
          if (query.includes('INSERT INTO student_document_early_evidence')) { stored += 1; return { rowsAffected: [1] }; }
          throw new Error('Unexpected query');
        }
      };
    }
  };
  const service = createStudentDocumentPrecheckService({
    getPool: async () => pool, sql, secret: 'synthetic-test-signing-secret-32bytes', maxUploadBytes: 1024,
    enabled, now: clock || (() => Date.now()), getDocument, geminiConfig: { model },
    reserveCheck, findReusable, finishCheck,
    extractor: { async extractDocument() { calls += 1; return extraction || { status: 'extracted', fields: { studentName: 'Alex Reyes' } }; } }
  });
  return { service, calls: () => calls, stored: () => stored };
}

test('a successful early extraction creates a signed server-evidence reference for only the checked file', async () => {
  const { service, calls, stored } = setup({ model: 'gemini-synthetic-model' });
  const checked = await service.check(11, 'report_card', null, pdf());
  assert.equal(checked.status, 'checked');
  assert.equal(stored(), 1);
  assert.equal(calls(), 1);
  assert.match(service.evidenceIdFor(checked.token, 11, 'report_card', null, pdf()), /^[a-f0-9-]{36}$/);
  assert.equal(service.evidenceIdFor(checked.token, 11, 'report_card', null, pdf('replaced')), null);
  assert.equal(service.evidenceIdFor(checked.token, 12, 'report_card', null, pdf()), null);
  await service.check(11, 'report_card', null, pdf());
  assert.equal(stored(), 1, 'repeat checks reuse the same server record and provider response');
});

test('hourly limit and cooldown leave final manual submission available with a next-check message', async () => {
  const quota = setup({ model: 'gemini-synthetic-model', reserveCheck: async () =>
    ({ allowed: false, retryAfterSeconds: 42, reason: 'cooldown' }) });
  const result = await quota.service.check(11, 'report_card', null, pdf());
  assert.equal(result.status, 'limited');
  assert.match(result.message, /next AI check.*1 minute/i);
  assert.match(result.message, /manual staff review/);
  assert.equal(quota.calls(), 0);
  assert.equal(quota.service.matchesToken(result.token, 11, 'report_card', null, pdf()), true);
});

test('unchanged server-side extraction is reused without reserving another provider call', async () => {
  const reusable = setup({ model: 'gemini-synthetic-model',
    findReusable: async () => ({ id: '32131649-0d53-4bd4-80bb-581369893734', fields: { studentName: 'Alex Reyes' } }),
    reserveCheck: async () => assert.fail('valid saved extraction should not burn quota') });
  const result = await reusable.service.check(11, 'report_card', null, pdf());
  assert.equal(result.status, 'checked');
  assert.equal(reusable.calls(), 0);
  assert.match(reusable.service.evidenceIdFor(result.token, 11, 'report_card', null, pdf()), /^[a-f0-9-]{36}$/);
});

test('correction bonus is requested only for a server-confirmed correction revision', async () => {
  const seen = [];
  const getDocument = async (_actorId, id) => ({ id, student_user_id: 11, upload_source: 'student',
    document_type: 'report_card', requirement_assignment_id: null,
    decisions: [{ decision_type: 'correction_requested' }], history: [] });
  const service = setup({ model: 'gemini-synthetic-model', getDocument,
    reserveCheck: async (_pool, _sql, values) => { seen.push(values); return { allowed: true, attemptId: 1 }; } });
  await service.service.check(11, 'report_card', null, pdf(), 42);
  assert.equal(seen[0].sourceDocumentId, 42);
  assert.equal(seen[0].correctionRequested, true);
  const notCorrected = setup({ model: 'gemini-synthetic-model', getDocument: async (_actorId, id) => ({
    id, student_user_id: 11, upload_source: 'student', document_type: 'report_card',
    requirement_assignment_id: null, decisions: [{ decision_type: 'verified' }], history: []
  }), reserveCheck: async () => assert.fail('unapproved revision must not reserve a bonus') });
  await assert.rejects(notCorrected.service.check(11, 'report_card', null, pdf(), 42), { status: 409 });
});

test('limited early check caches exact file and binds token to actor, type, version and expiry', async () => {
  let time = 1000;
  const { service, calls } = setup({ clock: () => time });
  const first = await service.check(11, 'report_card', null, pdf());
  assert.equal(first.status, 'checked');
  assert.equal(first.warnings.length, 0);
  assert.equal((await service.check(11, 'report_card', null, pdf())).token, first.token);
  assert.equal(calls(), 1);
  assert.equal(service.matchesToken(first.token, 11, 'report_card', null, pdf()), true);
  assert.equal(service.matchesToken(first.token, 12, 'report_card', null, pdf()), false);
  assert.equal(service.matchesToken(first.token, 11, 'good_moral', null, pdf()), false);
  assert.equal(service.matchesToken(first.token, 11, 'report_card', null, pdf('replacement')), false);
  assert.equal(service.matchesToken(first.token, 11, 'report_card', null, null), false);
  time += 5 * 60 * 1000 + 1;
  assert.equal(service.matchesToken(first.token, 11, 'report_card', null, pdf()), false);
});

test('name mismatch is a warning, not rejection; provider unavailability permits manual review', async () => {
  const mismatch = setup({ extraction: { status: 'extracted', fields: { studentName: 'Someone Else' } } });
  const result = await mismatch.service.check(11, 'report_card', null, pdf());
  assert.equal(result.status, 'checked');
  assert.match(result.warnings.join(' '), /may differ/);
  const unavailable = setup({ extraction: { status: 'unavailable', code: 'timeout' } });
  const fallback = await unavailable.service.check(11, 'report_card', null, pdf());
  assert.equal(fallback.status, 'unavailable');
  assert.match(fallback.message, /staff review/);
});

test('a provider timeout consumes one reserved attempt and still permits manual submission', async () => {
  let reservations = 0;
  const finished = [];
  const unavailable = setup({ extraction: { status: 'unavailable', code: 'timeout' },
    reserveCheck: async () => { reservations += 1; return { allowed: true, attemptId: 17 }; },
    finishCheck: async (_pool, _sql, attemptId) => { finished.push(attemptId); } });
  const result = await unavailable.service.check(11, 'report_card', null, pdf());
  assert.equal(result.status, 'unavailable');
  assert.equal(unavailable.calls(), 1);
  assert.equal(reservations, 1);
  assert.deepEqual(finished, [17]);
  assert.equal(unavailable.service.matchesToken(result.token, 11, 'report_card', null, pdf()), true);
});

test('disabled provider never receives file; custom assigned evidence is manual-review only', async () => {
  const disabled = setup({ enabled: false,
    reserveCheck: async () => assert.fail('disabled AI must not reserve quota') });
  assert.equal((await disabled.service.check(11, 'report_card', null, pdf())).status, 'format_checked');
  assert.equal(disabled.calls(), 0);
  const custom = setup();
  const result = await custom.service.check(11, `custom_${'a'.repeat(32)}`, 12, pdf());
  assert.equal(result.status, 'format_checked');
  assert.equal(custom.calls(), 0);
});

test('rejects unlinked accounts and invalid file content before AI', async () => {
  const denied = setup({ actorRole: 'finance' });
  await assert.rejects(denied.service.check(11, 'report_card', null, pdf()), { status: 403 });
  const normal = setup();
  const bad = { ...pdf(), buffer: Buffer.from('not a pdf'), size: 9 };
  await assert.rejects(normal.service.check(11, 'report_card', null, bad), { status: 400 });
  assert.equal(normal.calls(), 0);
});

test('correction precheck is bound to the owned submission version', async () => {
  const getDocument = async (_actorId, id) => ({
    id, student_user_id: 11, upload_source: 'student', document_type: 'report_card', requirement_assignment_id: null,
    decisions: [{ decision_type: 'correction_requested' }], history: []
  });
  const { service } = setup({ getDocument });
  const checked = await service.check(11, 'report_card', null, pdf(), 42);
  assert.equal(service.matchesToken(checked.token, 11, 'report_card', null, pdf(), 42), true);
  assert.equal(service.matchesToken(checked.token, 11, 'report_card', null, pdf(), 43), false);
  const denied = setup({ getDocument: async () => ({ student_user_id: 99, upload_source: 'student', document_type: 'report_card' }) });
  await assert.rejects(denied.service.check(11, 'report_card', null, pdf(), 42), { status: 404 });
});

test('concurrent repeated checks reuse one provider call', async () => {
  let release;
  let calls = 0;
  const getPool = async () => ({ request() { return {
    input() { return this; }, async query() { return { recordset: [{ id: 7, status: 'active', first_name: 'Alex', last_name: 'Reyes' }] }; }
  }; } });
  const service = createStudentDocumentPrecheckService({ getPool, sql,
    secret: 'synthetic-test-signing-secret-32bytes', maxUploadBytes: 1024, enabled: true,
    reserveCheck: async () => ({ allowed: true, attemptId: 1 }), finishCheck: async () => {},
    extractor: { async extractDocument() { calls += 1; await new Promise((resolve) => { release = resolve; });
      return { status: 'extracted', fields: { studentName: 'Alex Reyes' } }; } }
  });
  const first = service.check(11, 'report_card', null, pdf());
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.check(11, 'report_card', null, pdf());
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a.token, b.token);
});
