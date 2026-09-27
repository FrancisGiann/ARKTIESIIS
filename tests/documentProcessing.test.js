const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const environment = require('../src/config/environment');
const { readMigrationFiles, splitSqlBatches } = require('../scripts/db-setup');
const { createDocumentProcessingService, startProcessingRecoveryScheduler } = require('../src/services/documentProcessingService');
const { createDocumentService, verificationChecklistItems } = require('../src/services/documentService');
const { createLocalOcrService } = require('../src/services/localOcrService');
const { createForm137ScanService } = require('../src/services/form137ScanService');

const runNativeOcrIntegration = process.env.ARKTIESIIS_RUN_NATIVE_OCR_INTEGRATION === '1';
const ocrFixtureDirectory = path.join(__dirname, 'fixtures/ocr');

function fakeSql() {
  return {
    MAX: 'MAX',
    Int: 'Int',
    BigInt: 'BigInt',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE', READ_COMMITTED: 'READ_COMMITTED' },
    NVarChar: (length) => `NVarChar(${length})`
  };
}

function documentHarness({ status = 'pending', storedFilename, mimeType, documentType = 'good_moral' } = {}) {
  const state = {
    document: {
      id: 84,
      status,
      processing_started_at: status === 'processing' ? null : null,
      stored_filename: storedFilename || '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf',
      mime_type: mimeType || 'application/pdf',
      document_type: documentType
    },
    queries: [],
    validations: [],
    commits: 0,
    rollbacks: 0,
    decisionEvents: [],
    failNextValidationInsert: false,
    staleProcessing: status === 'processing'
  };

  const transactionFactory = () => {
    const transaction = {
      localDocument: { ...state.document },
      localValidations: [],
      localDecisions: [],
      async begin() {},
      request() {
        const values = {};
        return {
          input(name, _type, value) { values[name] = value; return this; },
          async query(statement) {
            state.queries.push({ statement, values: { ...values } });
            if (statement.includes('OUTER APPLY')) {
              const latestValidation = [...state.validations, ...transaction.localValidations].at(-1)?.values;
              return { recordset: [{
                id: transaction.localDocument.id,
                student_id: 44,
                document_type: transaction.localDocument.document_type,
                status: transaction.localDocument.status,
                result_status: latestValidation?.resultStatus || null,
                validation_json: latestValidation?.validationJson || null
              }] };
            }
            if (statement.includes('FROM dbo.document_decision_events')) {
              const latestDecision = state.decisionEvents.at(-1);
              return { recordset: latestDecision ? [{ decision_type: latestDecision.decisionType }] : [] };
            }
            if (statement.includes("SET status = 'processing'")) {
            if (transaction.localDocument.status !== 'pending' || ['form_137', 'report_card'].includes(transaction.localDocument.document_type)) return { recordset: [] };
              transaction.localDocument.status = 'processing';
              transaction.localDocument.processing_started_at = 'started';
              return { recordset: [{ ...transaction.localDocument }] };
            }
            if (statement.includes('SET status = @documentStatus')) {
              if (transaction.localDocument.status !== 'processing') return { recordset: [] };
              transaction.localDocument.status = values.documentStatus;
              transaction.localDocument.processing_started_at = null;
              return { recordset: [{ id: transaction.localDocument.id }] };
            }
            if (statement.includes('DECLARE @recovered TABLE')) {
              if (transaction.localDocument.status !== 'processing' || !state.staleProcessing) {
                return { recordset: [{ recovered_count: 0 }] };
              }
              transaction.localDocument.status = 'failed';
              transaction.localDocument.processing_started_at = null;
              transaction.localValidations.push({ statement, values: { ...values, resultStatus: 'failed' } });
              return { recordset: [{ recovered_count: 1 }] };
            }
            if (statement.includes('INSERT INTO dbo.document_validations')) {
              if (state.failNextValidationInsert) {
                state.failNextValidationInsert = false;
                throw new Error('simulated validation persistence failure');
              }
              transaction.localValidations.push({ statement, values: { ...values } });
              return { recordset: [] };
            }
            if (statement.includes('INSERT INTO dbo.document_decision_events')) {
              transaction.localDecisions.push({ ...values });
              return { recordset: [] };
            }
            if (statement.includes('UPDATE dbo.documents SET status = @nextStatus')) {
              if (transaction.localDocument.status !== values.currentStatus || !['needs_review', 'failed'].includes(transaction.localDocument.status)) return { recordset: [] };
              transaction.localDocument.status = values.nextStatus;
              return { recordset: [{ id: transaction.localDocument.id }] };
            }
            if (statement.includes('FROM dbo.users WITH')) return { recordset: [{ id: 7, role: 'registrar' }] };
            if (statement.includes('SELECT id FROM dbo.students WITH') && statement.includes('WHERE id = @studentId')) {
              return { recordset: [{ id: values.studentId }] };
            }
            if (statement.includes('INSERT INTO dbo.documents')) {
              transaction.localDocument = {
                ...transaction.localDocument,
                id: 84,
                status: 'pending',
                stored_filename: values.storedFilename,
                mime_type: values.mimeType,
                document_type: values.documentType
              };
              return { recordset: [{ id: transaction.localDocument.id }] };
            }
            if (statement.includes('SELECT s.first_name, s.last_name')) return { recordset: [{ first_name: 'Test', last_name: 'Student' }] };
            if (statement.includes('FROM dbo.documents WITH')) return { recordset: [{ id: 84, student_id: 44, document_type: transaction.localDocument.document_type }] };
            if (statement.includes('INSERT INTO dbo.document_review_events')) return { recordset: [] };
            if (statement.includes("SET status = CASE WHEN status = 'processing'")) {
              if (transaction.localDocument.status !== 'processing') transaction.localDocument.status = 'needs_review';
              return { recordset: [] };
            }
            if (statement.includes('INSERT INTO dbo.audit_logs')) return { recordset: [] };
            throw new Error(`Unexpected SQL: ${statement}`);
          }
        };
      },
      async commit() {
        state.document = { ...transaction.localDocument };
        state.validations.push(...transaction.localValidations);
        state.decisionEvents.push(...transaction.localDecisions);
        state.commits += 1;
      },
      async rollback() { state.rollbacks += 1; }
    };
    return transaction;
  };

  return { state, transactionFactory };
}

async function temporaryStorage() {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-local-ocr-'));
  return storageDirectory;
}

function makeService(harness, storageDirectory, options = {}) {
  return createDocumentProcessingService({
    getPool: async () => ({}),
    sql: fakeSql(),
    transactionFactory: harness.transactionFactory,
    storageDirectory,
    timeoutMs: 1000,
    ...options
  });
}

test('configured processing sends private PDF and image submissions to local OCR and persists OCR without marking valid', async () => {
  const storageDirectory = await temporaryStorage();
  try {
    for (const file of [
      { storedFilename: '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf', mimeType: 'application/pdf' },
      { storedFilename: '8bbd4569-d20b-4c62-81cf-dd0952324d03.png', mimeType: 'image/png' }
    ]) {
      const harness = documentHarness({ storedFilename: file.storedFilename, mimeType: file.mimeType });
      await fs.writeFile(path.join(storageDirectory, file.storedFilename), Buffer.from('private-upload'));
      const calls = [];
      const service = makeService(harness, storageDirectory, {
        localOcr: {
          async processDocument(filePath, mimeType, options) {
            assert.equal(harness.state.document.status, 'processing');
            calls.push({ filePath, mimeType, options });
            return { text: '  extracted name\r\n  school information  ' };
          }
        }
      });

      const result = await service.processPendingDocument(84);
      assert.equal(result.status, 'needs_review');
      assert.equal(result.resultStatus, 'needs_review');
      assert.equal(harness.state.document.status, 'needs_review');
      assert.equal(harness.state.validations.length, 1);
      assert.equal(harness.state.validations[0].values.extractedText, 'extracted name\n  school information');
      assert.equal(harness.state.validations[0].values.resultStatus, 'needs_review');
      assert.equal(harness.state.validations[0].values.processor, 'Tesseract OCR');
      assert.deepEqual(calls.map(({ mimeType }) => mimeType), [file.mimeType]);
      assert.equal(calls[0].options.timeoutMs, 1000);
      assert.match(calls[0].filePath, new RegExp(`${file.storedFilename.replaceAll('.', '\\.')}$`));
      assert.equal(JSON.parse(harness.state.validations[0].values.validationJson).outcome, 'extracted');
      assert.equal(harness.state.validations[0].values.validationJson.includes('extracted name'), false);
      assert.equal(harness.state.validations[0].values.validationJson.includes('valid'), false);
    }
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('native digital upload is processed from private storage and its OCR text is staff-only', { skip: runNativeOcrIntegration ? false : 'Set ARKTIESIIS_RUN_NATIVE_OCR_INTEGRATION=1 to run against installed local OCR tools.' }, async () => {
  const storageDirectory = await temporaryStorage();
  const ocrTemporaryDirectory = await temporaryStorage();
  const harness = documentHarness();
  try {
    const imagePath = path.join(ocrFixtureDirectory, 'synthetic-png.png');
    const uploadBuffer = await fs.readFile(imagePath);
    const documentService = createDocumentService({
      getPool: async () => ({}),
      sql: fakeSql(),
      transactionFactory: harness.transactionFactory,
      storageDirectory
    });
    const uploaded = await documentService.upload(7, {
      studentId: '44',
      documentType: 'good_moral'
    }, {
      originalname: 'synthetic-report.png',
      mimetype: 'image/png',
      buffer: uploadBuffer,
      size: uploadBuffer.length
    });
    assert.equal(uploaded.id, harness.state.document.id);
    assert.equal(harness.state.document.status, 'pending');
    const storedPath = path.join(storageDirectory, harness.state.document.stored_filename);
    assert.deepEqual(await fs.readFile(storedPath), uploadBuffer);
    if (process.platform !== 'win32') assert.equal((await fs.stat(storedPath)).mode & 0o777, 0o600);

    const processingService = makeService(harness, storageDirectory, {
      timeoutMs: environment.ocr.timeoutMs,
      localOcr: createLocalOcrService({
        ocrConfig: environment.ocr,
        uploadConfig: environment.upload,
        temporaryDirectory: ocrTemporaryDirectory
      })
    });
    const processed = await processingService.processPendingDocument(uploaded.id);
    assert.equal(processed.status, 'needs_review');
    assert.equal(harness.state.document.status, 'needs_review');
    const validation = harness.state.validations.find(({ values }) => values.documentId === uploaded.id);
    assert.ok(validation, 'the validation row is tied to the uploaded immutable submission id');
    assert.equal(validation.values.processor, 'Tesseract OCR');
    assert.match(validation.values.extractedText.toUpperCase(), /SYNTHETIC PNG/);
    assert.equal(validation.values.resultStatus, 'needs_review');
    assert.deepEqual(await fs.readFile(storedPath), uploadBuffer, 'processing retains the private source submission');
    assert.deepEqual(await fs.readdir(ocrTemporaryDirectory), [], 'native OCR removes its working files');

    const validationQueries = [];
    const readPool = {
      request() {
        const values = {};
        return {
          input(name, _type, value) { values[name] = value; return this; },
          async query(statement) {
            if (statement.startsWith('SELECT id, role FROM dbo.users WHERE')) {
              const role = values.actorId === 7 ? 'registrar' : 'student';
              return { recordset: [{ id: values.actorId, role }] };
            }
            if (statement.includes('FROM dbo.documents AS d')) {
              return { recordset: [{
                id: uploaded.id,
                student_id: 44,
                document_type: 'good_moral',
                original_filename: 'synthetic-report.png',
                stored_filename: harness.state.document.stored_filename,
                mime_type: 'image/png',
                file_size_bytes: uploadBuffer.length,
                uploaded_by: 7,
                upload_source: 'registrar',
                status: harness.state.document.status,
                supersedes_document_id: null,
                created_at: new Date(),
                student_user_id: 8,
                student_no: 'SYN-44',
                first_name: 'Synthetic',
                middle_name: null,
                last_name: 'Student',
                uploader_role: 'registrar'
              }] };
            }
            if (statement.includes('FROM dbo.document_validations')) {
              validationQueries.push({ actorId: values.actorId, statement });
              return { recordset: [{
                id: 1,
                processor: validation.values.processor,
                extracted_text: validation.values.extractedText,
                validation_json: validation.values.validationJson,
                result_status: validation.values.resultStatus,
                created_at: new Date()
              }] };
            }
            if (statement.startsWith('SELECT id, original_filename')) return { recordset: [] };
            if (statement.includes('FROM dbo.document_review_events') || statement.includes('FROM dbo.document_decision_events')) return { recordset: [] };
            throw new Error(`Unexpected read query: ${statement}`);
          }
        };
      }
    };
    const readService = createDocumentService({ getPool: async () => readPool, sql: fakeSql(), storageDirectory });
    const staffView = await readService.getDocument(7, uploaded.id);
    assert.match(staffView.validation.extracted_text.toUpperCase(), /SYNTHETIC PNG/);
    assert.match(validationQueries[0].statement, /role IN \('registrar', 'database_admin'\)/);
    const studentView = await readService.getDocument(8, uploaded.id);
    assert.equal(studentView.validation, null);
    assert.deepEqual(validationQueries.map(({ actorId }) => actorId), [7], 'student detail reads never fetch extracted OCR text');
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
    await fs.rm(ocrTemporaryDirectory, { recursive: true, force: true });
  }
});

test('native Form 137 scan returns suggestions only and clears the synthetic scan', { skip: runNativeOcrIntegration ? false : 'Set ARKTIESIIS_RUN_NATIVE_OCR_INTEGRATION=1 to run against installed local OCR tools.' }, async () => {
  const temporaryDirectory = await temporaryStorage();
  try {
    const filePath = path.join(ocrFixtureDirectory, 'synthetic-jpeg.jpg');
    const buffer = await fs.readFile(filePath);
    const upload = {
      originalname: 'synthetic-form137-scan.jpg',
      mimetype: 'image/jpeg',
      size: buffer.length,
      buffer
    };
    const service = createForm137ScanService({
      temporaryDirectory,
      localOcr: createLocalOcrService({
        ocrConfig: environment.ocr,
        uploadConfig: environment.upload,
        temporaryDirectory
      }),
      async getStudentDocuments(_actorId, studentId) {
        assert.equal(studentId, 44);
        return { student: { id: 44, first_name: 'Synthetic', middle_name: null, last_name: 'Student' } };
      }
    });

    const result = await service.scan(7, 44, upload);
    assert.equal(result.status, 'completed');
    assert.equal(Object.hasOwn(result, 'text'), false);
    assert.ok(upload.buffer.every((byte) => byte === 0));
    assert.deepEqual(await fs.readdir(temporaryDirectory), []);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('a missing local OCR executable records a terminal safe failure', async () => {
  const storageDirectory = await temporaryStorage();
  try {
    const harness = documentHarness();
    let calls = 0;
    const service = makeService(harness, storageDirectory, {
      localOcr: { async processDocument() { calls += 1; const error = new Error('binary not found'); error.code = 'OCR_BINARY_UNAVAILABLE'; throw error; } }
    });
    const result = await service.processPendingDocument(84);
    const saved = harness.state.validations[0].values;
    assert.equal(result.status, 'failed');
    assert.equal(harness.state.document.status, 'failed');
    assert.equal(calls, 1);
    assert.equal(saved.resultStatus, 'failed');
    assert.equal(JSON.parse(saved.validationJson).outcome, 'processor_unavailable');
    assert.equal(saved.extractedText, null);
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('timeouts, OCR errors, malformed results, and empty OCR are terminal and safe', async () => {
  const storageDirectory = await temporaryStorage();
  let timeoutSignal;
  const cases = [
    {
      name: 'timeout',
      ocrProcess: (_filePath, _mimeType, { signal }) => { timeoutSignal = signal; return new Promise(() => {}); },
      status: 'failed',
      resultStatus: 'failed',
      code: 'processor_timeout'
    },
    {
      name: 'OCR error',
      ocrProcess: async () => { throw new Error('sensitive utility output and credential details'); },
      status: 'failed',
      resultStatus: 'failed',
      code: 'processor_error'
    },
    {
      name: 'malformed OCR result',
      ocrProcess: async () => ({ text: ['not', 'text'] }),
      status: 'failed',
      resultStatus: 'failed',
      code: 'malformed_response'
    },
    {
      name: 'empty OCR',
      ocrProcess: async () => ({ text: ' \n  ' }),
      status: 'needs_review',
      resultStatus: 'needs_review',
      code: 'empty_ocr'
    }
  ];
  try {
    for (const testCase of cases) {
      const harness = documentHarness();
      const service = makeService(harness, storageDirectory, {
        localOcr: { processDocument: testCase.ocrProcess }
      });
      const result = await service.processPendingDocument(84);
      const saved = harness.state.validations[0].values;
      const summary = JSON.parse(saved.validationJson);
      assert.equal(result.status, testCase.status, testCase.name);
      assert.equal(saved.resultStatus, testCase.resultStatus, testCase.name);
      assert.equal(summary.outcome, testCase.code, testCase.name);
      assert.equal(summary.message.includes('sensitive utility output'), false);
      assert.equal(harness.state.document.status, testCase.status, testCase.name);
      if (testCase.name === 'timeout') assert.equal(timeoutSignal.aborted, true, 'timeout cancels the active OCR subprocess signal');
    }
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('already processed submissions are not sent to local OCR again', async () => {
  const storageDirectory = await temporaryStorage();
  try {
    const harness = documentHarness({ status: 'needs_review' });
    let calls = 0;
    const service = makeService(harness, storageDirectory, {
      localOcr: { async processDocument() { calls += 1; return { text: 'should not run' }; } }
    });
    const result = await service.processPendingDocument(84);
    assert.equal(result.status, 'not_pending');
    assert.equal(calls, 0);
    assert.equal(harness.state.validations.length, 0);
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('OCR processing does not report success when another state transition wins before result persistence', async () => {
  const storageDirectory = await temporaryStorage();
  const storedFilename = '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf';
  try {
    const harness = documentHarness();
    await fs.writeFile(path.join(storageDirectory, storedFilename), Buffer.from('private-upload'));
    const service = makeService(harness, storageDirectory, {
      localOcr: {
        async processDocument() {
          harness.state.document.status = 'valid';
          harness.state.document.processing_started_at = null;
          return { text: 'OCR text' };
        }
      }
    });

    await assert.rejects(service.processPendingDocument(84), /submission state changed/);
    assert.equal(harness.state.document.status, 'valid', 'a completed manual verification remains final');
    assert.equal(harness.state.validations.length, 0, 'the OCR result was not recorded for the competing terminal state');
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('a manual decision cannot overlap an OCR lease and stays final after the worker completes', async () => {
  const storageDirectory = await temporaryStorage();
  const storedFilename = '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf';
  try {
    const harness = documentHarness();
    await fs.writeFile(path.join(storageDirectory, storedFilename), Buffer.from('private-upload'));
    let resolveOcr;
    let signalOcrStarted;
    const ocrStarted = new Promise((resolve) => { signalOcrStarted = resolve; });
    const processing = makeService(harness, storageDirectory, {
      localOcr: {
        processDocument() {
          signalOcrStarted();
          return new Promise((resolve) => { resolveOcr = resolve; });
        }
      }
    });
    const review = createDocumentService({
      getPool: async () => ({}),
      sql: fakeSql(),
      transactionFactory: harness.transactionFactory,
      storageDirectory
    });

    const job = processing.processPendingDocument(84);
    await ocrStarted;
    assert.equal(harness.state.document.status, 'processing');
    await assert.rejects(review.decideDocument(7, '84', 'verified'), /finish OCR/);
    assert.equal(harness.state.decisionEvents.length, 0);

    resolveOcr({ text: 'Test Student\nExample School\nMathematics 90' });
    await job;
    assert.equal(harness.state.document.status, 'needs_review');
    assert.equal(harness.state.validations.length, 1);
    const verificationChecklist = Object.fromEntries(verificationChecklistItems('good_moral').map(({ key }) => [key, 'yes']));
    await review.decideDocument(7, '84', 'verified', 'Source document inspected by registrar.', verificationChecklist);
    assert.equal(harness.state.document.status, 'valid');
    assert.equal(harness.state.decisionEvents.length, 1);
    assert.deepEqual(JSON.parse(harness.state.decisionEvents[0].verificationChecklistJson), {
      schemaVersion: 1,
      linkedStudentNameLegible: true,
      schoolNameLegible: true,
      selectedDocumentTypeCorrect: true,
      allSubmittedPagesReadableComplete: true
    });
    assert.equal((await processing.processPendingDocument(84)).status, 'not_pending');
    assert.equal(harness.state.document.status, 'valid', 'a later worker scan cannot replace the manual decision');
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('Form 137 and historical report-card submissions are excluded from direct OCR processing', async () => {
  const storageDirectory = await temporaryStorage();
  try {
    for (const documentType of ['form_137', 'report_card']) {
      const harness = documentHarness({ documentType });
      let calls = 0;
      const service = makeService(harness, storageDirectory, {
        localOcr: { async processDocument() { calls += 1; return { text: 'must not process' }; } }
      });
      assert.deepEqual(await service.processPendingDocument(84), { documentId: 84, status: 'not_pending' });
      assert.equal(calls, 0);
      assert.equal(harness.state.document.status, 'pending');
      assert.ok(harness.state.queries.some(({ statement }) => statement.includes("document_type NOT IN ('form_137', 'report_card')")));
    }
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('a failed OCR result transaction leaves a persisted lease that recovery terminalizes with a safe validation row', async () => {
  const storageDirectory = await temporaryStorage();
  const storedFilename = '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf';
  try {
    const harness = documentHarness();
    await fs.writeFile(path.join(storageDirectory, storedFilename), Buffer.from('private-upload'));
    harness.state.failNextValidationInsert = true;
    const service = makeService(harness, storageDirectory, {
      recoveryGraceMs: 1000,
      localOcr: { async processDocument() { return { text: 'OCR text' }; } }
    });

    await assert.rejects(service.processPendingDocument(84), /processing result could not be recorded/);
    assert.equal(harness.state.document.status, 'processing');
    assert.equal(harness.state.document.processing_started_at, 'started');
    assert.equal(harness.state.validations.length, 0);
    assert.equal(harness.state.rollbacks, 1);

    harness.state.staleProcessing = true;
    assert.equal(await service.recoverStaleProcessing(), 1);
    assert.equal(harness.state.document.status, 'failed');
    assert.equal(harness.state.document.processing_started_at, null);
    assert.equal(harness.state.validations.length, 1);
    const recoveryRow = harness.state.validations[0];
    assert.equal(recoveryRow.values.processor, 'Tesseract OCR');
    assert.equal(recoveryRow.values.staleAfterMs, 2000);
    assert.equal(recoveryRow.values.batchSize, 100);
    assert.equal(JSON.parse(recoveryRow.values.validationJson).outcome, 'processing_recovered');
    assert.match(recoveryRow.statement, /INSERT INTO dbo\.document_validations[\s\S]*SELECT id, @processor, NULL, @validationJson, NULL, NULL, 'failed'/);
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('migration 004 is discoverable and adds the timestamped processing recovery index', async () => {
  const migration = readMigrationFiles().find(({ version }) => version === '004');
  assert.ok(migration);
  assert.equal(migration.fileName, '004_document_processing_recovery.sql');
  const batches = splitSqlBatches(await fs.readFile(migration.filePath, 'utf8'));
  assert.equal(batches.length, 2);
  assert.match(batches[0], /ALTER TABLE dbo\.documents[\s\S]+ADD processing_started_at DATETIME2\(3\) NULL/);
  assert.match(batches[1], /CREATE INDEX IX_documents_status_processing_started_at[\s\S]+WHERE status = 'processing'/);
});

test('migration 005 changes only the default processor label and preserves existing validation rows', async () => {
  const migration = readMigrationFiles().find(({ version }) => version === '005');
  assert.ok(migration);
  assert.equal(migration.fileName, '005_local_ocr_processor_default.sql');
  const batches = splitSqlBatches(await fs.readFile(migration.filePath, 'utf8'));
  assert.equal(batches.length, 1);
  assert.match(batches[0], /sys\.default_constraints[\s\S]+c\.name = N'processor'/i);
  assert.match(batches[0], /DROP CONSTRAINT[\s\S]+QUOTENAME\(@processorDefaultConstraint\)/i);
  assert.match(batches[0], /DEFAULT \(N'Tesseract OCR'\) FOR processor/i);
  assert.doesNotMatch(batches[0], /UPDATE\s+dbo\.document_validations/i);
});

test('migration 006 is numbered forward-only and records decisions/status history without rewriting old results', async () => {
  const migration = readMigrationFiles().find(({ version }) => version === '006');
  assert.ok(migration);
  assert.equal(migration.fileName, '006_document_decisions_and_form137_status.sql');
  const batches = splitSqlBatches(await fs.readFile(migration.filePath, 'utf8'));
  assert.equal(batches.length, 1);
  assert.match(batches[0], /CREATE TABLE dbo\.document_decision_events/);
  assert.match(batches[0], /CREATE TABLE dbo\.form137_status_events/);
  assert.match(batches[0], /decision_type IN \('verified', 'correction_requested', 'rejected'\)/);
  assert.match(batches[0], /status IN \('pending', 'received', 'verified', 'correction', 'rejected'\)/);
  assert.doesNotMatch(batches[0], /UPDATE\s+dbo\.(?:documents|document_validations)/i);
  assert.doesNotMatch(batches[0], /DROP\s+(?:TABLE|COLUMN|CONSTRAINT)/i);
  const rollbackScript = await fs.readFile(path.resolve(__dirname, '../scripts/migration-rollback.js'), 'utf8');
  assert.match(rollbackScript, /await transaction\.rollback\(\)/);
  assert.match(rollbackScript, /OBJECT_ID\(N'dbo\.document_decision_events'/);
});

test('migration 008 adds nullable verified-checklist storage without rewriting legacy decisions', async () => {
  const migration = readMigrationFiles().find(({ version }) => version === '008');
  assert.ok(migration);
  assert.equal(migration.fileName, '008_document_verification_checklist.sql');
  const batches = splitSqlBatches(await fs.readFile(migration.filePath, 'utf8'));
  assert.equal(batches.length, 2);
  assert.match(batches[0], /ADD verification_checklist_json NVARCHAR\(500\) NULL/);
  assert.match(batches[1], /ADD CONSTRAINT CK_document_decision_event_verification_checklist[\s\S]*CHECK \([\s\S]*verification_checklist_json IS NULL[\s\S]*decision_type = 'verified'[\s\S]*ISJSON\(verification_checklist_json\) = 1/i);
  assert.doesNotMatch(batches.join('\n'), /UPDATE\s+dbo\.document_decision_events|DROP\s+(?:TABLE|COLUMN|CONSTRAINT)/i);
  const checkScript = await fs.readFile(path.resolve(__dirname, '../scripts/check-db.js'), 'utf8');
  assert.match(checkScript, /'008'/);
  assert.match(checkScript, /verification_checklist_json/);
});

test('parallel queue workers claim distinct submissions at bounded per-service concurrency', async () => {
  const storageDirectory = await temporaryStorage();
  const documents = [84, 85, 86].map((id) => ({
    id,
    status: 'pending',
    stored_filename: `${String(id).padStart(8, '0')}-aaaa-4bbb-8ccc-000000000000.pdf`,
    mime_type: 'application/pdf',
    document_type: 'good_moral'
  }));
  const state = { documents, claimed: [], validationRows: [], claimIsolation: [] };
  const transactionFactory = () => ({
    async begin(isolation) { state.claimIsolation.push(isolation); },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          if (statement.includes('WITH (UPDLOCK, READPAST, READCOMMITTEDLOCK)')) {
            const document = state.documents.find((row) => row.status === 'pending');
            if (!document) return { recordset: [] };
            document.status = 'processing';
            state.claimed.push(document.id);
            return { recordset: [{ ...document }] };
          }
          if (statement.includes('SELECT s.first_name, s.last_name')) return { recordset: [{ first_name: 'Test', last_name: 'Student' }] };
          if (statement.includes('SET status = @documentStatus')) {
            const document = state.documents.find((row) => row.id === values.documentId);
            if (document?.status !== 'processing') return { recordset: [] };
            document.status = values.documentStatus;
            return { recordset: [{ id: document.id }] };
          }
          if (statement.includes('INSERT INTO dbo.document_validations')) {
            state.validationRows.push({ ...values });
            return { recordset: [] };
          }
          throw new Error(`Unexpected queue SQL: ${statement}`);
        }
      };
    },
    async commit() {},
    async rollback() {}
  });
  let activeOcr = 0;
  let maxActiveOcr = 0;
  const pendingOcr = [];
  let resolveOcrStarted;
  const ocrStarted = new Promise((resolve) => { resolveOcrStarted = resolve; });
  let resolveResultsSaved;
  const resultsSaved = new Promise((resolve) => { resolveResultsSaved = resolve; });
  const localOcr = {
    processDocument() {
      activeOcr += 1;
      maxActiveOcr = Math.max(maxActiveOcr, activeOcr);
      return new Promise((resolve) => {
        pendingOcr.push(() => {
          activeOcr -= 1;
          resolve({ text: 'queued text' });
        });
        if (pendingOcr.length === 2) resolveOcrStarted();
      });
    }
  };

  try {
    for (const document of documents) {
      await fs.writeFile(path.join(storageDirectory, document.stored_filename), Buffer.from('private upload'));
    }
    const options = {
      getPool: async () => ({}),
      sql: fakeSql(),
      transactionFactory,
      localOcr,
      storageDirectory,
      timeoutMs: 5000,
      concurrency: 1,
      setImmediateFn() {}
    };
    const workers = [createDocumentProcessingService(options), createDocumentProcessingService(options)];
    const claimedCounts = await Promise.all(workers.map((worker) => worker.processPendingQueue()));
    await ocrStarted;
    assert.deepEqual(claimedCounts, [1, 1]);
    assert.equal(new Set(state.claimed).size, 2, 'simultaneous workers claim different pending rows');
    assert.deepEqual(state.claimIsolation, ['READ_COMMITTED', 'READ_COMMITTED']);
    assert.equal(maxActiveOcr, 2, 'each service runs no more than its configured one OCR job');
    assert.equal(await workers[0].processPendingQueue(), 0, 'a busy service does not claim another row');

    for (const release of pendingOcr) release();
    const originalLength = state.validationRows.length;
    const pollForSavedResults = async () => {
      const deadline = Date.now() + 1000;
      while (state.validationRows.length < originalLength + 2 && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (state.validationRows.length >= originalLength + 2) resolveResultsSaved();
    };
    await pollForSavedResults();
    await resultsSaved;
    assert.equal(state.validationRows.length, 2);
    assert.equal(state.documents.filter(({ status }) => status === 'pending').length, 1);
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('review requests during OCR preserve the processing lease until the OCR result is committed', async () => {
  const storageDirectory = await temporaryStorage();
  const storedFilename = '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf';
  try {
    const harness = documentHarness();
    await fs.writeFile(path.join(storageDirectory, storedFilename), Buffer.from('private-upload'));
    let resolveProvider;
    let ocrStarted;
    const ocrStartedPromise = new Promise((resolve) => { ocrStarted = resolve; });
    const processingService = makeService(harness, storageDirectory, {
      localOcr: {
        processDocument() {
          ocrStarted();
          return new Promise((resolve) => { resolveProvider = resolve; });
        }
      }
    });
    const documentService = createDocumentService({
      getPool: async () => ({}),
      sql: fakeSql(),
      transactionFactory: harness.transactionFactory,
      storageDirectory
    });

    const processing = processingService.processPendingDocument(84);
    await ocrStartedPromise;
    assert.equal(harness.state.document.status, 'processing');
    await documentService.addReviewEvent(7, '84', 'correction_requested', 'Please provide a clearer scan.');
    assert.equal(harness.state.document.status, 'processing');
    assert.equal(harness.state.document.processing_started_at, 'started');

    resolveProvider({ text: 'OCR text' });
    const result = await processing;
    assert.equal(result.status, 'needs_review');
    assert.equal(harness.state.document.status, 'needs_review');
    assert.equal(harness.state.document.processing_started_at, null);
    assert.equal(harness.state.validations.length, 1);
    assert.equal(harness.state.validations[0].values.resultStatus, 'needs_review');
    assert.equal(harness.state.queries.some(({ statement }) => statement.includes('INSERT INTO dbo.document_review_events')), true);
    assert.equal(harness.state.queries.some(({ statement }) => statement.includes("SET status = CASE WHEN status = 'processing'")), false);
  } finally {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  }
});

test('stale recovery scheduler runs immediately, periodically, and prevents overlapping scans', async () => {
  let intervalHandler;
  let intervalMs;
  let cleared = false;
  let unrefCalled = false;
  let resolveFirst;
  let calls = 0;
  let queueScans = 0;
  const scheduler = startProcessingRecoveryScheduler({
    recoverStaleProcessing() {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve(0);
    },
    processPendingQueue() {
      queueScans += 1;
      return Promise.resolve(0);
    }
  }, {
    intervalMs: 2000,
    setIntervalFn(callback, delay) {
      intervalHandler = callback;
      intervalMs = delay;
      return { unref() { unrefCalled = true; } };
    },
    clearIntervalFn() { cleared = true; },
    logger: { error() { assert.fail('successful test scan should not log an error'); } }
  });

  try {
    await Promise.resolve();
    assert.equal(calls, 1, 'startup kicks off recovery');
    assert.equal(queueScans, 0, 'queue scan follows stale recovery');
    assert.equal(intervalMs, 2000);
    assert.equal(unrefCalled, true);
    intervalHandler();
    await Promise.resolve();
    assert.equal(calls, 1, 'a periodic scan does not overlap the startup scan');
    resolveFirst(0);
    await scheduler.run();
    assert.equal(queueScans, 1, 'startup scans pending OCR after recovery');
    intervalHandler();
    await scheduler.run();
    assert.equal(calls, 2, 'the next periodic scan runs after the previous scan settles');
    assert.equal(queueScans, 2, 'periodic recovery also scans pending OCR');
  } finally {
    scheduler.stop();
  }
  assert.equal(cleared, true);
});
