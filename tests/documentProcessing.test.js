const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { constants: fsConstants } = require('node:fs');
const { createDocumentProcessingService } = require('../src/services/documentProcessingService');

const STORED_PDF = '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf';
const VALID_GOOD_MORAL_FIELDS = {
  studentName: 'Jamie Garcia',
  issuingSchoolName: 'North Academy',
  goodMoralContextEvidence: 'This certifies that the named student is of good moral character.',
  goodMoralLayoutEvidence: 'A certificate title appears above a substantive character statement and student details.'
};

function fakeSql() {
  return {
    MAX: 'MAX', Int: 'Int',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE', READ_COMMITTED: 'READ_COMMITTED' },
    NVarChar: (length) => `NVarChar(${length})`
  };
}

function makeHarness({ documentType = 'good_moral', status = 'pending', isLegacyArchive = false, storedFilename = STORED_PDF, mimeType = 'application/pdf', originalFilename = 'moral.pdf' } = {}) {
  const state = {
    document: { id: 84, student_id: 44, status, processing_started_at: null, stored_filename: storedFilename, mime_type: mimeType, document_type: documentType, is_legacy_archive: isLegacyArchive ? 1 : 0, original_filename: originalFilename },
    validations: [], queries: [], commits: 0
  };
  const transactionFactory = () => {
    const transaction = { document: { ...state.document }, validations: [],
      async begin() {},
      request() {
        const values = {};
        return {
          input(name, _type, value) { values[name] = value; return this; },
          async query(statement) {
            state.queries.push(statement);
            if (statement.includes("SET status = 'processing'")) {
              if (transaction.document.status !== 'pending' || transaction.document.document_type === 'form_137'
                || (transaction.document.document_type === 'report_card' && transaction.document.is_legacy_archive === 1)) return { recordset: [] };
              transaction.document.status = 'processing';
              return { rowsAffected: [1] };
            }
            if (statement.includes('SELECT id, stored_filename, mime_type, document_type, is_legacy_archive')) {
              return { recordset: [{ ...transaction.document }] };
            }
            if (statement.includes('SELECT d.original_filename, s.first_name')) return { recordset: [{
              original_filename: transaction.document.original_filename,
              first_name: 'Jamie', middle_name: null, last_name: 'Garcia'
            }] };
            if (statement.includes('SET status = @documentStatus')) {
              if (transaction.document.status !== 'processing') return { recordset: [] };
              transaction.document.status = values.documentStatus;
              transaction.document.processing_started_at = null;
              return { rowsAffected: [1] };
            }
            if (statement.includes('INSERT INTO document_validations')) {
              transaction.validations.push({ ...values });
              return { recordset: [] };
            }
            throw new Error(`Unexpected SQL: ${statement}`);
          }
        };
      },
      async commit() { state.document = { ...transaction.document }; state.validations.push(...transaction.validations); state.commits += 1; },
      async rollback() {}
    };
    return transaction;
  };
  return { state, transactionFactory };
}

async function temporaryStorage() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ark-gemini-precheck-'));
}

function createService(harness, storageDirectory, extractDocument, overrides = {}) {
  return createDocumentProcessingService({
    getPool: async () => ({}),
    sql: fakeSql(),
    transactionFactory: harness.transactionFactory,
    storageDirectory,
    maxFileBytes: 16 * 1024 * 1024,
    timeoutMs: 1000,
    geminiConfig: { apiKey: '', model: 'gemini-3.8-flash', timeoutMs: 1000 },
    geminiFieldExtractor: { extractDocument },
    logger: { error() {} },
    ...overrides
  });
}

test('Gemini precheck reads one private file handle, stores bounded findings, and never marks the document valid', async () => {
  const storageDirectory = await temporaryStorage();
  const harness = makeHarness();
  const privateBytes = Buffer.from('%PDF-1.7\nprivate-upload');
  await fs.writeFile(path.join(storageDirectory, STORED_PDF), privateBytes, { mode: 0o600 });
  let request;
  try {
    const service = createService(harness, storageDirectory, async (input) => {
      request = input;
      assert.deepEqual(input.buffer, privateBytes);
      assert.equal(input.documentType, 'good_moral');
      assert.equal(input.mimeType, 'application/pdf');
      assert.ok(input.signal instanceof AbortSignal);
      return { status: 'extracted', code: 'extracted', fields: VALID_GOOD_MORAL_FIELDS };
    });
    const result = await service.processPendingDocument(84);
    assert.equal(result.code, 'precheck_pass');
    assert.equal(result.status, 'needs_review');
    assert.equal(harness.state.document.status, 'needs_review');
    assert.equal(harness.state.validations.length, 1);
    const saved = harness.state.validations[0];
    assert.equal(saved.processor, 'Gemini field extraction');
    assert.equal(saved.extractedText, null, 'the API output is not stored as OCR text');
    assert.equal(saved.resultStatus, 'needs_review');
    const summary = JSON.parse(saved.validationJson);
    assert.equal(summary.stage, 'gemini_precheck');
    assert.equal(summary.precheckVersion, 2);
    assert.equal(summary.fileFormatPassed, true);
    assert.equal(summary.gemini.fields.issuingSchoolName, 'North Academy');
    assert.equal(saved.validationJson.includes(privateBytes.toString()), false);
    assert.equal(harness.state.document.status === 'valid', false, 'only a separate manual staff decision can set valid');
    assert.ok(request.buffer.every((byte) => byte === 0), 'the in-memory file copy is cleared after extraction');
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('Good Moral name and school alone never produce a precheck pass', async () => {
  const storageDirectory = await temporaryStorage();
  const harness = makeHarness();
  await fs.writeFile(path.join(storageDirectory, STORED_PDF), Buffer.from('%PDF-1.7\nJamie Garcia\nNorth Academy'));
  try {
    const service = createService(harness, storageDirectory, async () => ({
      status: 'extracted', code: 'extracted', fields: {
        studentName: 'Jamie Garcia', issuingSchoolName: 'North Academy',
        goodMoralContextEvidence: '', goodMoralLayoutEvidence: ''
      }
    }));
    const result = await service.processPendingDocument(84);
    assert.equal(result.code, 'precheck_attention');
    assert.equal(result.status, 'needs_review');
    assert.equal(JSON.parse(harness.state.validations[0].validationJson).gemini.requiredFieldsPresent, false);
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('active report-card precheck compares only the linked name and format, then leaves staff decision pending', async () => {
  const storageDirectory = await temporaryStorage();
  const harness = makeHarness({ documentType: 'report_card', originalFilename: 'term-report.pdf' });
  const privateBytes = Buffer.from('%PDF-1.7\nsynthetic report card');
  await fs.writeFile(path.join(storageDirectory, STORED_PDF), privateBytes, { mode: 0o600 });
  let request;
  try {
    const service = createService(harness, storageDirectory, async (input) => {
      request = input;
      return { status: 'extracted', code: 'extracted', fields: { studentName: 'Jamie Garcia' } };
    });
    const result = await service.processPendingDocument(84);
    assert.equal(request.documentType, 'report_card');
    assert.equal(result.code, 'precheck_pass');
    assert.equal(result.status, 'needs_review');
    assert.equal(harness.state.document.status, 'needs_review');
    assert.equal(harness.state.validations.length, 1);
    const saved = harness.state.validations[0];
    const summary = JSON.parse(saved.validationJson);
    assert.equal(summary.fileFormatPassed, true);
    assert.deepEqual(Object.keys(summary.gemini.fields), ['studentName']);
    assert.doesNotMatch(saved.validationJson, /grade|mark|subject/i);
    assert.match(summary.message, /registrar or database administrator must inspect/i);
    assert.equal(saved.resultStatus, 'needs_review');
    assert.equal(saved.extractedText, null);
    assert.equal(harness.state.queries.some((query) => query.includes("document_type <> 'report_card' OR is_legacy_archive = 0")), true);
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('student-name comparison rejects distant tokens and multi-name model output', async () => {
  const storageDirectory = await temporaryStorage();
  try {
    for (const studentName of [
      'Jamie describes a long set of unrelated details before Garcia',
      'Jamie Garcia and Alex Smith'
    ]) {
      const harness = makeHarness();
      await fs.writeFile(path.join(storageDirectory, STORED_PDF), Buffer.from('%PDF-1.7\nsource'));
      const service = createService(harness, storageDirectory, async () => ({
        status: 'extracted', code: 'extracted', fields: { ...VALID_GOOD_MORAL_FIELDS, studentName }
      }));
      const result = await service.processPendingDocument(84);
      const summary = JSON.parse(harness.state.validations[0].validationJson);
      assert.equal(summary.gemini.studentNameMatchesLinkedRecord, false, studentName);
      assert.equal(result.code, 'precheck_attention', studentName);
      assert.equal(result.status, 'needs_review', studentName);
    }
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('Gemini unavailability, malformed output, and timeout all fail closed', async () => {
  const storageDirectory = await temporaryStorage();
  try {
    const cases = [
      { name: 'missing key', response: { status: 'unavailable', code: 'missing_api_key', fields: null }, code: 'gemini_unavailable' },
      { name: 'malformed extraction', response: { status: 'extracted', code: 'extracted', fields: null }, code: 'gemini_unavailable' }
    ];
    for (const item of cases) {
      const harness = makeHarness();
      await fs.writeFile(path.join(storageDirectory, STORED_PDF), Buffer.from('%PDF-1.7\nprivate'));
      const service = createService(harness, storageDirectory, async () => item.response);
      const result = await service.processPendingDocument(84);
      assert.equal(result.code, item.code, item.name);
      assert.equal(result.status, 'needs_review', item.name);
      const summary = JSON.parse(harness.state.validations[0].validationJson);
      assert.equal(summary.gemini.status, 'unavailable', item.name);
      assert.equal(summary.fileFormatPassed, true, item.name);
      assert.equal(harness.state.document.status, 'needs_review', item.name);
    }

    const timeoutHarness = makeHarness();
    let signal;
    await fs.writeFile(path.join(storageDirectory, STORED_PDF), Buffer.from('%PDF-1.7\ntimeout'));
    const timeoutService = createService(timeoutHarness, storageDirectory, async (input) => {
      signal = input.signal;
      return new Promise(() => {});
    }, { timeoutMs: 1000 });
    const timeoutResult = await timeoutService.processPendingDocument(84);
    assert.equal(timeoutResult.code, 'gemini_unavailable');
    assert.equal(signal.aborted, true);
    assert.equal(timeoutHarness.state.document.status, 'needs_review');
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('stored symlinks are rejected before bytes can reach Gemini', { skip: fsConstants.O_NOFOLLOW === undefined }, async () => {
  const storageDirectory = await temporaryStorage();
  const outsideDirectory = await temporaryStorage();
  const harness = makeHarness();
  const outsideFile = path.join(outsideDirectory, 'sensitive.pdf');
  await fs.writeFile(outsideFile, Buffer.from('%PDF-1.7\nsensitive unrelated file'));
  try {
    await fs.symlink(outsideFile, path.join(storageDirectory, STORED_PDF));
    let calls = 0;
    const service = createService(harness, storageDirectory, async () => { calls += 1; return { status: 'extracted', fields: VALID_GOOD_MORAL_FIELDS }; });
    const result = await service.processPendingDocument(84);
    assert.equal(calls, 0);
    assert.equal(result.status, 'failed');
    assert.equal(JSON.parse(harness.state.validations[0].validationJson).outcome, 'stored_file_unavailable');
    assert.equal(harness.state.document.status, 'failed');
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
    await fs.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('invalid stored signatures are rejected without an API request', async () => {
  const storageDirectory = await temporaryStorage();
  const harness = makeHarness();
  await fs.writeFile(path.join(storageDirectory, STORED_PDF), Buffer.from('not a PDF'));
  try {
    let calls = 0;
    const service = createService(harness, storageDirectory, async () => { calls += 1; return { status: 'extracted', fields: VALID_GOOD_MORAL_FIELDS }; });
    const result = await service.processPendingDocument(84);
    assert.equal(calls, 0);
    assert.equal(result.code, 'invalid_file_format');
    assert.equal(result.status, 'needs_review');
    assert.equal(JSON.parse(harness.state.validations[0].validationJson).fileFormatPassed, false);
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('already processed and excluded document types never reach Gemini', async () => {
  const storageDirectory = await temporaryStorage();
  try {
    for (const options of [
      { status: 'needs_review' },
      { documentType: 'form_137' },
      { documentType: 'report_card', isLegacyArchive: true }
    ]) {
      const harness = makeHarness(options);
      let calls = 0;
      const service = createService(harness, storageDirectory, async () => { calls += 1; return {}; });
      const result = await service.processPendingDocument(84);
      assert.equal(result.status, 'not_pending');
      assert.equal(calls, 0);
    }
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('queue claim and stale recovery scope report cards to active lifecycle rows', async () => {
  const storageDirectory = await temporaryStorage();
  const statements = [];
  const service = createDocumentProcessingService({
    getPool: async () => ({}),
    sql: fakeSql(),
    transactionFactory: () => ({
      async begin() {},
      request() {
        return {
          input() { return this; },
          async query(statement) {
            statements.push(statement);
            if (statement.includes('FROM documents') && statement.includes("status = 'pending'")) return { recordset: [] };
            if (statement.includes('FROM documents') && statement.includes("status = 'processing'")) return { recordset: [] };
            throw new Error('Unexpected test query.');
          }
        };
      },
      async commit() {},
      async rollback() {}
    }),
    storageDirectory,
    geminiFieldExtractor: { extractDocument: async () => ({ status: 'unavailable' }) },
    logger: { error() {} }
  });
  try {
    assert.equal(await service.processPendingQueue(), 0);
    assert.equal(await service.recoverStaleProcessing(), 0);
    const claim = statements.find((statement) => statement.includes("status = 'pending'"));
    const recovery = statements.find((statement) => statement.includes("status = 'processing'"));
    for (const statement of [claim, recovery]) {
      assert.match(statement, /document_type <> 'form_137'/);
      assert.match(statement, /document_type <> 'report_card' OR is_legacy_archive = 0/);
      assert.doesNotMatch(statement, /document_type NOT IN \('form_137', 'report_card'\)/);
    }
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});
