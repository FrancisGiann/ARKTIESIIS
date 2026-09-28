const test = require('node:test');
const assert = require('node:assert/strict');
const { DocumentServiceError } = require('../src/services/documentService');
const { Form137ScanError, createForm137ScanService } = require('../src/services/form137ScanService');

const student = { id: 44, first_name: 'Jamie', middle_name: null, last_name: 'Garcia' };
function makePdfFile() {
  const buffer = Buffer.from('%PDF-1.7\nsource');
  return { originalname: 'paper.pdf', mimetype: 'application/pdf', buffer, size: buffer.length };
}
function extractor(extractDocument) { return { extractDocument }; }

test('Form 137 sends validated bytes to Gemini and returns bounded transient field suggestions only', async () => {
  const calls = [];
  const service = createForm137ScanService({
    maxUploadBytes: 1024,
    timeoutMs: 12000,
    async getStudentDocuments(actorId, studentId) {
      calls.push(['student', actorId, studentId]);
      return { student };
    },
    geminiFieldExtractor: extractor(async (input) => {
      calls.push(['gemini', input]);
      assert.equal(input.documentType, 'form_137');
      assert.equal(input.mimeType, 'application/pdf');
      assert.equal(input.buffer.toString(), '%PDF-1.7\nsource');
      assert.ok(input.signal instanceof AbortSignal);
      return { status: 'extracted', code: 'extracted', fields: {
        studentName: 'Jamie Garcia',
        possibleSchoolName: 'Possible Academy <script>alert(1)</script>'.repeat(8)
      } };
    })
  });

  const file = makePdfFile();
  const result = await service.scan(7, '44', file);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls[0], ['student', 7, 44]);
  assert.deepEqual(result.suggestions.map(({ key, found }) => [key, found]), [
    ['student_name', true], ['possible_school_name', true]
  ]);
  assert.equal(result.suggestions[1].candidates[0].length, 240);
  assert.equal(Object.hasOwn(result, 'text'), false);
  assert.deepEqual(calls.map(([operation]) => operation), ['student', 'gemini'], 'the scan performs no persistence writes');
  assert.ok(file.buffer.every((byte) => byte === 0), 'the multipart buffer is cleared after processing');
});

test('scan validation rejects unsupported extension, MIME, signature, and size before Gemini', async () => {
  let lookupCount = 0;
  const service = createForm137ScanService({
    maxUploadBytes: 32,
    async getStudentDocuments() { lookupCount += 1; return { student }; },
    geminiFieldExtractor: extractor(async () => assert.fail('invalid input must not reach Gemini'))
  });
  await assert.rejects(service.scan(7, '44', { ...makePdfFile(), originalname: 'paper.txt' }), DocumentServiceError);
  await assert.rejects(service.scan(7, '44', { ...makePdfFile(), mimetype: 'image/png' }), /extension and declared file type/);
  await assert.rejects(service.scan(7, '44', { ...makePdfFile(), buffer: Buffer.from('not pdf'), size: 7 }), /content does not match/);
  await assert.rejects(service.scan(7, '44', { ...makePdfFile(), size: 33 }), /configured upload limit/);
  await assert.rejects(service.scan(7, 'invalid', makePdfFile()), { status: 404 });
  assert.equal(lookupCount, 0);
});

test('Gemini unavailability returns a safe transient result and clears the scan buffer', async () => {
  const service = createForm137ScanService({
    async getStudentDocuments() { return { student }; },
    geminiFieldExtractor: extractor(async () => ({ status: 'unavailable', code: 'api_error', fields: null }))
  });
  const file = makePdfFile();
  const result = await service.scan(7, 44, file);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /Gemini field extraction is unavailable/);
  assert.deepEqual(result.suggestions, []);
  assert.ok(file.buffer.every((byte) => byte === 0));
});

test('Form 137 scan concurrency is bounded and busy scans never call Gemini', async () => {
  let releaseFirst;
  let started = 0;
  const firstGemini = new Promise((resolve) => { releaseFirst = resolve; });
  const service = createForm137ScanService({
    concurrency: 1,
    async getStudentDocuments() { return { student }; },
    geminiFieldExtractor: extractor(async () => {
      started += 1;
      if (started === 1) await firstGemini;
      return { status: 'extracted', code: 'extracted', fields: { studentName: 'Jamie Garcia' } };
    })
  });
  try {
    const pending = service.scan(7, 44, makePdfFile());
    while (started === 0) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(service.scan(7, 44, makePdfFile()), { status: 429 });
    assert.equal(started, 1);
    releaseFirst();
    assert.equal((await pending).status, 'completed');
  } finally {
    releaseFirst();
  }
});

test('a timed out Gemini operation returns no suggestions and aborts the provider request', async () => {
  let receivedSignal;
  const service = createForm137ScanService({
    timeoutMs: 1000,
    async getStudentDocuments() { return { student }; },
    geminiFieldExtractor: extractor(async ({ signal }) => {
      receivedSignal = signal;
      return new Promise(() => {});
    })
  });
  const started = Date.now();
  const result = await service.scan(7, 44, makePdfFile());
  assert.equal(result.status, 'failed');
  assert.match(result.message, /timed out/);
  assert.deepEqual(result.suggestions, []);
  assert.equal(receivedSignal.aborted, true);
  assert.ok(Date.now() - started >= 900);
});

test('staff lookup failures return a safe transient result and clear scan buffers', async () => {
  const service = createForm137ScanService({
    async getStudentDocuments() { throw new Error('private database detail'); },
    geminiFieldExtractor: extractor(async () => assert.fail('must not call Gemini without linked student'))
  });
  const file = makePdfFile();
  const result = await service.scan(7, 44, file);
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(result.message, /private database detail/);
  assert.deepEqual(result.suggestions, []);
  assert.ok(file.buffer.every((byte) => byte === 0));
});
