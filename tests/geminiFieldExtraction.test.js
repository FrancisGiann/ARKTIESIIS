const test = require('node:test');
const assert = require('node:assert/strict');
const { createGeminiFieldExtractionService, MAX_INLINE_FILE_BYTES } = require('../src/services/geminiFieldExtractionService');

function responseFor(fields, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(fields) }] } }]
  }), { status, headers });
}

test('Gemini adapter sends a bounded inline Good Moral PDF request with structured extraction fields', async () => {
  const fields = {
    student_name: 'Jamie Garcia',
    issuing_school_name: 'North Academy',
    good_moral_context_evidence: 'This certifies the student is of good moral character.',
    good_moral_layout_evidence: 'A certificate heading appears above the statement.'
  };
  let request;
  const service = createGeminiFieldExtractionService({
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return responseFor(fields);
    }
  });

  const result = await service.extractDocument({
    buffer: Buffer.from('%PDF-1.7\nvisible contents'),
    mimeType: 'application/pdf',
    documentType: 'good_moral'
  });

  assert.equal(result.status, 'extracted');
  assert.deepEqual(result.fields, {
    studentName: 'Jamie Garcia',
    issuingSchoolName: 'North Academy',
    goodMoralContextEvidence: 'This certifies the student is of good moral character.',
    goodMoralLayoutEvidence: 'A certificate heading appears above the statement.'
  });
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(request.options.headers['x-goog-api-key'], 'test-key');
  assert.equal(request.url.includes('test-key'), false, 'the key is sent only in the request header');
  assert.equal(request.body.contents[0].parts[0].inline_data.mime_type, 'application/pdf');
  assert.equal(Buffer.from(request.body.contents[0].parts[0].inline_data.data, 'base64').toString(), '%PDF-1.7\nvisible contents');
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(request.body.generationConfig.responseSchema.required, [
    'student_name', 'issuing_school_name', 'good_moral_context_evidence', 'good_moral_layout_evidence'
  ]);
  assert.match(request.body.contents[0].parts[1].text, /Names and school details alone are not evidence/);
  assert.match(request.body.contents[0].parts[1].text, /Do not require a particular template/);
});

test('Form 137 requests bounded student and possible school suggestions only', async () => {
  let schema;
  let prompt;
  const service = createGeminiFieldExtractionService({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      schema = body.generationConfig.responseSchema;
      prompt = body.contents[0].parts[1].text;
      return responseFor({ student_name: 'Jamie Garcia', possible_school_name: 'North Academy' });
    }
  });
  const result = await service.extractDocument({
    buffer: Buffer.from('%PDF-1.7'), mimeType: 'application/pdf', documentType: 'form_137'
  });
  assert.deepEqual(result.fields, { studentName: 'Jamie Garcia', possibleSchoolName: 'North Academy' });
  assert.deepEqual(schema.required, ['student_name', 'possible_school_name']);
  assert.match(prompt, /Do not classify authenticity/);
});

test('PSA schema requests only the linked student name and does not require school fields', async () => {
  let schema;
  const service = createGeminiFieldExtractionService({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      schema = JSON.parse(options.body).generationConfig.responseSchema;
      return responseFor({ student_name: 'Jamie Garcia' });
    }
  });
  const result = await service.extractDocument({
    buffer: Buffer.from([0xff, 0xd8, 0xff]),
    mimeType: 'image/jpeg',
    documentType: 'psa_birth_certificate'
  });
  assert.deepEqual(result, { status: 'extracted', code: 'extracted', fields: { studentName: 'Jamie Garcia' } });
  assert.deepEqual(schema.required, ['student_name']);
  assert.deepEqual(Object.keys(schema.properties), ['student_name']);
});

test('report-card schema asks only for the visible student name and explicitly excludes grade extraction', async () => {
  let schema;
  let prompt;
  const service = createGeminiFieldExtractionService({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      schema = body.generationConfig.responseSchema;
      prompt = body.contents[0].parts[1].text;
      return responseFor({ student_name: 'Jamie Garcia', grades: ['A'] });
    }
  });
  const result = await service.extractDocument({
    buffer: Buffer.from('%PDF-1.7'), mimeType: 'application/pdf', documentType: 'report_card'
  });
  assert.deepEqual(result, { status: 'extracted', code: 'extracted', fields: { studentName: 'Jamie Garcia' } });
  assert.deepEqual(schema.required, ['student_name']);
  assert.deepEqual(Object.keys(schema.properties), ['student_name']);
  assert.match(prompt, /Do not extract, read, summarize, compare, or return grades/);
  assert.match(prompt, /Do not classify authenticity, detect forgery/);
});

test('missing key, unsupported input, and oversized file fail closed without an API call', async () => {
  let calls = 0;
  const service = createGeminiFieldExtractionService({
    fetchImpl: async () => { calls += 1; return responseFor({ student_name: 'Jamie Garcia' }); }
  });
  const request = { buffer: Buffer.from('%PDF-'), mimeType: 'application/pdf', documentType: 'good_moral' };
  assert.deepEqual(await service.extractDocument(request), { status: 'unavailable', code: 'missing_api_key', fields: null });

  const keyed = createGeminiFieldExtractionService({ apiKey: 'test-key', fetchImpl: async () => { calls += 1; } });
  assert.equal((await keyed.extractDocument({ ...request, mimeType: 'text/plain' })).code, 'unsupported_input');
  assert.equal((await keyed.extractDocument({ ...request, buffer: Buffer.alloc(MAX_INLINE_FILE_BYTES + 1) })).code, 'unsupported_input');
  assert.equal(calls, 0);
});

test('API, blocked, malformed, and oversized responses expose only fixed safe outcomes', async () => {
  const apiFailure = createGeminiFieldExtractionService({
    apiKey: 'test-key', fetchImpl: async () => new Response('private provider detail', { status: 403 })
  });
  assert.deepEqual(await apiFailure.extractDocument({ buffer: Buffer.from('%PDF-'), mimeType: 'application/pdf', documentType: 'good_moral' }), {
    status: 'unavailable', code: 'api_error', fields: null
  });

  const malformed = createGeminiFieldExtractionService({
    apiKey: 'test-key', fetchImpl: async () => new Response('{"candidates":[]}')
  });
  assert.equal((await malformed.extractDocument({ buffer: Buffer.from('%PDF-'), mimeType: 'application/pdf', documentType: 'good_moral' })).code, 'blocked_or_empty_response');

  const invalidStructured = createGeminiFieldExtractionService({
    apiKey: 'test-key', fetchImpl: async () => responseFor({ student_name: 'Jamie Garcia' })
  });
  assert.equal((await invalidStructured.extractDocument({ buffer: Buffer.from('%PDF-'), mimeType: 'application/pdf', documentType: 'good_moral' })).code, 'malformed_response');

  const tooLarge = createGeminiFieldExtractionService({
    apiKey: 'test-key', maxResponseBytes: 1024,
    fetchImpl: async () => new Response('x'.repeat(2048), { headers: { 'content-length': '2048' } })
  });
  assert.deepEqual(await tooLarge.extractDocument({ buffer: Buffer.from('%PDF-'), mimeType: 'application/pdf', documentType: 'good_moral' }), {
    status: 'unavailable', code: 'response_too_large', fields: null
  });

  let unboundedBodyRead = false;
  const missingStream = createGeminiFieldExtractionService({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      body: null,
      async arrayBuffer() { unboundedBodyRead = true; return Buffer.alloc(0); }
    })
  });
  assert.deepEqual(await missingStream.extractDocument({ buffer: Buffer.from('%PDF-'), mimeType: 'application/pdf', documentType: 'good_moral' }), {
    status: 'unavailable', code: 'response_body_unavailable', fields: null
  });
  assert.equal(unboundedBodyRead, false, 'a missing stream never triggers an unbounded body read');
});

test('caller abort maps to a safe timeout result without exposing the provider error', async () => {
  const service = createGeminiFieldExtractionService({
    apiKey: 'test-key',
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('private transport error', 'AbortError')), { once: true });
    })
  });
  const controller = new AbortController();
  const pending = service.extractDocument({
    buffer: Buffer.from('%PDF-'), mimeType: 'application/pdf', documentType: 'good_moral', signal: controller.signal
  });
  await Promise.resolve();
  controller.abort();
  assert.deepEqual(await pending, { status: 'unavailable', code: 'timeout', fields: null });
});
