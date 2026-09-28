const path = require('node:path');
const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const defaultEnvironment = require('../config/environment');
const { createGeminiFieldExtractionService, MAX_INLINE_FILE_BYTES } = require('./geminiFieldExtractionService');
const { linkedStudentNameFound } = require('./documentValidationService');

const MIME_BY_EXTENSION = new Map([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png']
]);
const STORED_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$/i;
const PROCESSING_TIMEOUT_CODE = 'DOCUMENT_PROCESSING_TIMEOUT';
const PROCESSING_RECOVERY_GRACE_MS = 30000;
const PROCESSING_RECOVERY_INTERVAL_MS = 30000;
const PROCESSING_RECOVERY_BATCH_SIZE = 100;
const PROCESSING_RECOVERY_MESSAGE = 'Gemini field extraction did not finish within the recovery window. Staff review is required.';
const PROCESSING_LABEL = 'Gemini field extraction';

class DocumentProcessingError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = 'DocumentProcessingError';
    this.status = status;
  }
}

function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      const error = new Error('Document processing timed out.');
      error.code = PROCESSING_TIMEOUT_CODE;
      reject(error);
    }, timeoutMs);
  });
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([operationPromise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function createDocumentProcessingService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  geminiFieldExtractor,
  geminiConfig = defaultEnvironment.gemini,
  storageDirectory = defaultEnvironment.upload.storageDirectory,
  maxFileBytes = Math.floor(defaultEnvironment.upload.maxMb * 1024 * 1024),
  timeoutMs = defaultEnvironment.gemini.timeoutMs,
  concurrency = defaultEnvironment.documentProcessing.concurrency,
  recoveryGraceMs = PROCESSING_RECOVERY_GRACE_MS,
  recoveryBatchSize = PROCESSING_RECOVERY_BATCH_SIZE,
  fileSystem = fs,
  logger = console,
  setImmediateFn = setImmediate
} = {}) {
  const storageRoot = path.resolve(storageDirectory);
  const publicRoot = path.resolve(__dirname, '../../public');
  if (storageRoot === publicRoot || storageRoot.startsWith(`${publicRoot}${path.sep}`)) {
    throw new Error('DOCUMENT_STORAGE_DIR must be outside the public web directory.');
  }
  const requestTimeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120000
    ? timeoutMs
    : 45000;
  const fieldExtractionTimeoutMs = Number.isSafeInteger(geminiConfig?.timeoutMs)
    && geminiConfig.timeoutMs >= 1000 && geminiConfig.timeoutMs <= 120000
    ? geminiConfig.timeoutMs
    : 45000;
  const workerConcurrency = Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 4
    ? concurrency
    : 2;
  const uploadLimitBytes = Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : 10 * 1024 * 1024;
  const geminiEngine = geminiFieldExtractor || createGeminiFieldExtractionService({
    apiKey: geminiConfig?.apiKey,
    model: geminiConfig?.model,
    timeoutMs: fieldExtractionTimeoutMs,
    maxFileBytes: uploadLimitBytes
  });
  const staleAfterMs = Math.max(requestTimeoutMs, fieldExtractionTimeoutMs) + (Number.isSafeInteger(recoveryGraceMs) && recoveryGraceMs >= 1000 && recoveryGraceMs <= 300000
    ? recoveryGraceMs
    : PROCESSING_RECOVERY_GRACE_MS);
  const recoveryLimit = Number.isSafeInteger(recoveryBatchSize) && recoveryBatchSize >= 1 && recoveryBatchSize <= 1000
    ? recoveryBatchSize
    : PROCESSING_RECOVERY_BATCH_SIZE;
  let activeJobCount = 0;
  let queueScanActive = false;
  let queueScanScheduled = false;

  async function runTransaction(callback, isolationLevel = sql.ISOLATION_LEVEL.SERIALIZABLE) {
    const pool = await getPool();
    const transaction = transactionFactory(pool);
    let started = false;
    try {
      await transaction.begin(isolationLevel);
      started = true;
      const result = await callback(transaction);
      await transaction.commit();
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try {
          await transaction.rollback();
        } catch {
          // Preserve the original failure without exposing database details.
        }
      }
      throw error;
    }
  }

  async function startProcessing(documentId) {
    return runTransaction(async (transaction) => {
      const result = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .query(`UPDATE dbo.documents
          SET status = 'processing', processing_started_at = SYSUTCDATETIME()
          OUTPUT INSERTED.id AS id, INSERTED.stored_filename AS stored_filename,
            INSERTED.mime_type AS mime_type, INSERTED.document_type AS document_type,
            INSERTED.is_legacy_archive AS is_legacy_archive
          WHERE id = @documentId AND status = 'pending' AND document_type <> 'form_137'
            AND (document_type <> 'report_card' OR is_legacy_archive = 0)`);
      const document = result.recordset?.[0];
      if (!document) return null;
      return loadStudentName(transaction, document);
    });
  }

  async function loadStudentName(transaction, document) {
    const result = await transaction.request()
      .input('documentId', sql.Int, document.id)
      .query(`SELECT d.original_filename, s.first_name, s.middle_name, s.last_name
        FROM dbo.documents AS d INNER JOIN dbo.students AS s ON s.id = d.student_id
        WHERE d.id = @documentId`);
    const linkedStudent = result.recordset?.[0] || {};
    return { ...document, original_filename: linkedStudent.original_filename, student: linkedStudent };
  }

  async function claimNextPendingDocument() {
    return runTransaction(async (transaction) => {
      const result = await transaction.request()
        .query(`;WITH next_pending AS (
            SELECT TOP (1) id
            FROM dbo.documents WITH (UPDLOCK, READPAST, READCOMMITTEDLOCK)
            WHERE status = 'pending' AND document_type <> 'form_137'
              AND (document_type <> 'report_card' OR is_legacy_archive = 0)
            ORDER BY created_at, id
          )
          UPDATE d
          SET status = 'processing', processing_started_at = SYSUTCDATETIME()
          OUTPUT INSERTED.id AS id, INSERTED.stored_filename AS stored_filename,
            INSERTED.mime_type AS mime_type, INSERTED.document_type AS document_type,
            INSERTED.is_legacy_archive AS is_legacy_archive
          FROM dbo.documents AS d
          INNER JOIN next_pending AS pending ON pending.id = d.id`);
      const document = result.recordset?.[0];
      if (!document) return null;
      return loadStudentName(transaction, document);
    }, sql.ISOLATION_LEVEL.READ_COMMITTED);
  }

  async function ensurePrivateStorageRoot() {
    const realStorageRoot = await fileSystem.realpath(storageRoot);
    const realPublicRoot = await fileSystem.realpath(publicRoot);
    if (realStorageRoot === realPublicRoot || realStorageRoot.startsWith(`${realPublicRoot}${path.sep}`)) {
      throw new DocumentProcessingError('Document storage is not configured as a private location.');
    }
  }

  function resolveStoredPath(storedFilename, mimeType) {
    if (typeof storedFilename !== 'string' || !STORED_NAME_PATTERN.test(storedFilename)) {
      throw new DocumentProcessingError('The stored document is unavailable.', 404);
    }
    const extension = path.extname(storedFilename).toLowerCase();
    if (MIME_BY_EXTENSION.get(extension) !== mimeType) {
      throw new DocumentProcessingError('The stored document is unavailable.', 404);
    }
    const resolved = path.resolve(storageRoot, storedFilename);
    const relative = path.relative(storageRoot, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new DocumentProcessingError('The stored document is unavailable.', 404);
    }
    return resolved;
  }

  function supportedFileSignature(buffer, document) {
    if (!Buffer.isBuffer(buffer) || typeof document.original_filename !== 'string') return false;
    const expectedMimeType = MIME_BY_EXTENSION.get(path.extname(document.original_filename).toLowerCase());
    if (!expectedMimeType || expectedMimeType !== document.mime_type) return false;
    if (document.mime_type === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    if (document.mime_type === 'image/jpeg') return buffer.length >= 3
      && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (document.mime_type === 'image/png') return buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return false;
  }

  function safeProcessingFailureFor(error) {
    if (error?.code === PROCESSING_TIMEOUT_CODE || error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR') {
      return { outcome: 'processor_timeout', message: 'Gemini field extraction timed out.' };
    }
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP'
      || (error instanceof DocumentProcessingError && error.status === 404)) {
      return { outcome: 'stored_file_unavailable', message: 'The stored document is unavailable.' };
    }
    return { outcome: 'processor_error', message: 'Gemini field extraction could not be completed.' };
  }

  function failureOutcome(code, message) {
    return {
      documentStatus: 'failed',
      resultStatus: 'failed',
      extractedText: null,
      code,
      message,
      fileFormatPassed: false,
      gemini: { status: 'unavailable', code, fields: null, studentNameMatchesLinkedRecord: null }
    };
  }

  function matchesLinkedStudent(extractedName, student = {}) {
    if (typeof extractedName !== 'string' || extractedName.length > 240
      || /[,;|/\n\r]|\b(?:and|&|or)\b/i.test(extractedName)) return false;
    const normalizedTokens = extractedName.normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) || [];
    if (normalizedTokens.length < 2 || normalizedTokens.length > 8) return false;
    return linkedStudentNameFound(extractedName, student);
  }

  function evaluateFieldExtraction(document, extraction, fileFormatPassed) {
    if (extraction?.status !== 'extracted' || !extraction.fields) {
      return {
        status: 'unavailable',
        code: typeof extraction?.code === 'string' ? extraction.code.slice(0, 40) : 'unavailable',
        fields: null,
        studentNameMatchesLinkedRecord: null
      };
    }
    const fields = extraction.fields;
    const studentName = typeof fields.studentName === 'string' ? fields.studentName.slice(0, 240) : '';
    const normalizedFields = { studentName };
    let studentNameMatchesLinkedRecord = studentName
      ? matchesLinkedStudent(studentName, document.student)
      : false;
    let requiredFieldsPresent = Boolean(studentName) && studentNameMatchesLinkedRecord;
    if (document.document_type === 'good_moral') {
      const issuingSchoolName = typeof fields.issuingSchoolName === 'string' ? fields.issuingSchoolName.slice(0, 240) : '';
      const goodMoralContextEvidence = typeof fields.goodMoralContextEvidence === 'string'
        ? fields.goodMoralContextEvidence.slice(0, 240)
        : '';
      const goodMoralLayoutEvidence = typeof fields.goodMoralLayoutEvidence === 'string'
        ? fields.goodMoralLayoutEvidence.slice(0, 240)
        : '';
      normalizedFields.issuingSchoolName = issuingSchoolName;
      normalizedFields.goodMoralContextEvidence = goodMoralContextEvidence;
      normalizedFields.goodMoralLayoutEvidence = goodMoralLayoutEvidence;
      const hasGoodMoralContext = /\b(?:good moral|moral character|good character|character certificate|good conduct)\b/i
        .test(goodMoralContextEvidence);
      const hasSurroundingContent = goodMoralLayoutEvidence.length >= 30;
      requiredFieldsPresent = requiredFieldsPresent && Boolean(issuingSchoolName)
        && hasGoodMoralContext && hasSurroundingContent;
    }
    return {
      status: 'extracted',
      code: requiredFieldsPresent && fileFormatPassed ? 'precheck_pass' : 'precheck_attention',
      fields: normalizedFields,
      studentNameMatchesLinkedRecord,
      requiredFieldsPresent
    };
  }

  async function saveOutcome(documentId, outcome) {
    return runTransaction(async (transaction) => {
      const updateResult = await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('documentStatus', sql.NVarChar(30), outcome.documentStatus)
        .query(`UPDATE dbo.documents
          SET status = @documentStatus, processing_started_at = NULL
          OUTPUT INSERTED.id AS id
          WHERE id = @documentId AND status = 'processing'`);
      if (!updateResult.recordset?.length) return false;

      const validationJson = JSON.stringify({
        stage: 'gemini_precheck',
        precheckVersion: 2,
        outcome: outcome.code,
        message: outcome.message,
        fileFormatPassed: outcome.fileFormatPassed === true,
        gemini: outcome.gemini || { status: 'unavailable', code: 'not_run', fields: null },
        advisoryChecks: outcome.advisoryChecks || []
      });
      await transaction.request()
        .input('documentId', sql.Int, documentId)
        .input('processor', sql.NVarChar(100), PROCESSING_LABEL)
        .input('extractedText', sql.NVarChar(sql.MAX), outcome.extractedText)
        .input('validationJson', sql.NVarChar(sql.MAX), validationJson)
        .input('resultStatus', sql.NVarChar(30), outcome.resultStatus)
        .query(`INSERT INTO dbo.document_validations
          (document_id, processor, extracted_text, validation_json,
            completeness_passed, format_passed, result_status)
          VALUES (@documentId, @processor, @extractedText, @validationJson, NULL, NULL, @resultStatus)`);
      return true;
    });
  }

  async function recoverStaleProcessing() {
    return runTransaction(async (transaction) => {
      const result = await transaction.request()
        .input('staleAfterMs', sql.Int, staleAfterMs)
        .input('batchSize', sql.Int, recoveryLimit)
        .input('processor', sql.NVarChar(100), PROCESSING_LABEL)
        .input('validationJson', sql.NVarChar(sql.MAX), JSON.stringify({
          stage: 'gemini_precheck',
          precheckVersion: 2,
          outcome: 'processing_recovered',
          message: PROCESSING_RECOVERY_MESSAGE,
          fileFormatPassed: false,
          gemini: { status: 'unavailable', code: 'processing_recovered', fields: null }
        }))
        .query(`DECLARE @recovered TABLE (id INT NOT NULL PRIMARY KEY);
          ;WITH stale_documents AS (
            SELECT TOP (@batchSize) id
            FROM dbo.documents WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
            WHERE status = 'processing' AND document_type <> 'form_137'
              AND (document_type <> 'report_card' OR is_legacy_archive = 0)
              AND (processing_started_at IS NULL
                OR processing_started_at < DATEADD(MILLISECOND, -@staleAfterMs, SYSUTCDATETIME()))
            ORDER BY CASE WHEN processing_started_at IS NULL THEN 0 ELSE 1 END,
              processing_started_at, id
          )
          UPDATE d
          SET status = 'failed', processing_started_at = NULL
          OUTPUT INSERTED.id INTO @recovered (id)
          FROM dbo.documents AS d
          INNER JOIN stale_documents AS stale ON stale.id = d.id;

          INSERT INTO dbo.document_validations
            (document_id, processor, extracted_text, validation_json,
              completeness_passed, format_passed, result_status)
          SELECT id, @processor, NULL, @validationJson, NULL, NULL, 'failed'
          FROM @recovered;

          SELECT COUNT(*) AS recovered_count FROM @recovered;`);
      const count = Number(result.recordset?.[0]?.recovered_count);
      return Number.isSafeInteger(count) && count > 0 ? count : 0;
    });
  }

  async function processClaimedDocument(document) {
    let outcome;
    let fileBuffer = null;
    try {
      await ensurePrivateStorageRoot();
      const filePath = resolveStoredPath(document.stored_filename, document.mime_type);
      const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
      const fileHandle = await fileSystem.open(filePath, openFlags);
      let fileStats;
      let fileFormatPassed = false;
      try {
        fileStats = await fileHandle.stat();
        if (!fileStats.isFile() || fileStats.size < 1 || fileStats.size > uploadLimitBytes) {
          throw new DocumentProcessingError('The stored document is unavailable.', 404);
        }
        const header = Buffer.alloc(Math.min(8, fileStats.size));
        const { bytesRead: headerBytesRead } = await fileHandle.read(header, 0, header.length, 0);
        fileFormatPassed = headerBytesRead === header.length && supportedFileSignature(header, document);
        const inlineFileLimit = Math.min(uploadLimitBytes, MAX_INLINE_FILE_BYTES);
        if (fileFormatPassed && fileStats.size <= inlineFileLimit) {
          fileBuffer = Buffer.alloc(fileStats.size);
          let offset = 0;
          while (offset < fileBuffer.length) {
            const { bytesRead } = await fileHandle.read(fileBuffer, offset, fileBuffer.length - offset, offset);
            if (bytesRead < 1) throw new DocumentProcessingError('The stored document is unavailable.', 404);
            offset += bytesRead;
          }
          const afterRead = await fileHandle.stat();
          if (afterRead.size !== fileStats.size || fileBuffer.length !== fileStats.size) {
            throw new DocumentProcessingError('The stored document is unavailable.', 404);
          }
        }
      } finally {
        await fileHandle.close();
      }

      let extraction = {
        status: 'unavailable',
        code: !fileFormatPassed ? 'invalid_file_format' : fileBuffer ? 'missing_api_key' : 'file_too_large',
        fields: null
      };
      if (fileFormatPassed) {
        const extractionPromise = fileBuffer
          ? withTimeout(
            (signal) => geminiEngine.extractDocument({
              buffer: fileBuffer,
              mimeType: document.mime_type,
              documentType: document.document_type,
              signal
            }),
            fieldExtractionTimeoutMs
          ).then((result) => { extraction = result; })
            .catch(() => { extraction = { status: 'unavailable', code: 'timeout', fields: null }; })
          : Promise.resolve();
        await extractionPromise;
      }

      const gemini = evaluateFieldExtraction(document, extraction, fileFormatPassed);
      const code = !fileFormatPassed
        ? 'invalid_file_format'
        : gemini.status !== 'extracted' ? 'gemini_unavailable' : gemini.code;
      const message = !fileFormatPassed
        ? 'The stored file does not match its declared PDF, JPEG, or PNG format. Staff review is required.'
        : gemini.status !== 'extracted'
          ? 'Gemini field extraction is unavailable. No automated precheck pass was recorded; staff source inspection is required.'
          : gemini.code === 'precheck_pass'
            ? 'The linked student-name and supported file-format checks passed. A registrar or database administrator must inspect the source and make the final decision.'
            : 'The extracted student name or supported file-format check needs source inspection.';
      outcome = {
        documentStatus: 'needs_review',
        resultStatus: 'needs_review',
        extractedText: null,
        code,
        message,
        advisoryChecks: [],
        fileFormatPassed,
        gemini
      };
    } catch (error) {
      const failure = safeProcessingFailureFor(error);
      outcome = failureOutcome(failure.outcome, 'Document processing could not complete. Staff review is required.');
    } finally {
      fileBuffer?.fill(0);
    }

    let saved;
    try {
      saved = await saveOutcome(document.id, outcome);
    } catch {
      throw new DocumentProcessingError('The upload was saved, but its processing result could not be recorded. Contact a registrar.');
    }
    if (!saved) {
      throw new DocumentProcessingError('The processing result could not be recorded because the submission state changed. Contact a registrar.');
    }
    return { documentId: document.id, status: outcome.documentStatus, resultStatus: outcome.resultStatus, code: outcome.code };
  }

  async function processPendingDocument(documentInput) {
    const documentId = Number(documentInput);
    if (!Number.isSafeInteger(documentId) || documentId < 1 || documentId > 2147483647) {
      throw new DocumentProcessingError('Document processing is unavailable.', 404);
    }

    const document = await startProcessing(documentId);
    if (!document) return { documentId, status: 'not_pending' };
    return processClaimedDocument(document);
  }

  async function processPendingQueue() {
    if (queueScanActive) return 0;
    queueScanActive = true;
    let claimed = 0;
    try {
      while (activeJobCount < workerConcurrency) {
        let document;
        try {
          document = await claimNextPendingDocument();
        } catch {
          logger.error('Pending document processing scan failed.');
          break;
        }
        if (!document) break;
        claimed += 1;
        activeJobCount += 1;
        void processClaimedDocument(document)
          .catch(() => logger.error('Document processing result could not be saved.'))
          .finally(() => {
            activeJobCount -= 1;
            schedulePendingProcessing();
          });
      }
    } finally {
      queueScanActive = false;
    }
    return claimed;
  }

  function schedulePendingProcessing() {
    if (queueScanScheduled) return;
    queueScanScheduled = true;
    setImmediateFn(() => {
      queueScanScheduled = false;
      void processPendingQueue();
    });
  }

  return {
    processPendingDocument,
    processPendingQueue,
    recoverStaleProcessing,
    schedulePendingProcessing
  };
}

function startProcessingRecoveryScheduler(processingService, {
  intervalMs = PROCESSING_RECOVERY_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console
} = {}) {
  const scanIntervalMs = Number.isSafeInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 300000
    ? intervalMs
    : PROCESSING_RECOVERY_INTERVAL_MS;
  let activeRun = null;

  function run() {
    if (activeRun) return activeRun;
    activeRun = Promise.resolve()
      .then(() => processingService.recoverStaleProcessing())
      .then(() => processingService.processPendingQueue?.())
      .catch(() => {
        logger.error('Document processing recovery scan failed.');
        return null;
      })
      .finally(() => { activeRun = null; });
    return activeRun;
  }

  const timer = setIntervalFn(() => { void run(); }, scanIntervalMs);
  timer.unref?.();
  void run();
  return {
    run,
    stop() { clearIntervalFn(timer); }
  };
}

module.exports = {
  DocumentProcessingError,
  PROCESSING_RECOVERY_GRACE_MS,
  PROCESSING_RECOVERY_INTERVAL_MS,
  PROCESSING_RECOVERY_MESSAGE,
  startProcessingRecoveryScheduler,
  createDocumentProcessingService,
  withTimeout
};
