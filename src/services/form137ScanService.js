const { DocumentServiceError, normalizeId, validateUpload } = require('./documentService');
const { createGeminiFieldExtractionService } = require('./geminiFieldExtractionService');

const FIELD_LIMIT = 240;
const FAILURE_MESSAGES = new Map([
  ['missing_api_key', 'Gemini field extraction is not configured. Inspect the physical paper and record its status manually.'],
  ['timeout', 'Gemini field extraction timed out. Inspect the physical paper and record its status manually.'],
  ['api_error', 'Gemini field extraction is unavailable. Inspect the physical paper and record its status manually.'],
  ['network_error', 'Gemini field extraction is unavailable. Inspect the physical paper and record its status manually.']
]);

class Form137ScanError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = 'Form137ScanError';
    this.status = status;
  }
}

function safeField(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, FIELD_LIMIT)
    : '';
}

function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: 'unavailable', code: 'timeout', fields: null });
    }, timeoutMs);
  });
  const result = Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([result, timeout]).finally(() => clearTimeout(timer));
}

function createForm137ScanService({
  getStudentDocuments,
  geminiFieldExtractor,
  geminiConfig = {},
  maxUploadBytes = 10 * 1024 * 1024,
  timeoutMs = geminiConfig.timeoutMs || 45000,
  concurrency = 2
} = {}) {
  if (typeof getStudentDocuments !== 'function') throw new TypeError('A staff-scoped student lookup is required.');
  const geminiEngine = geminiFieldExtractor || createGeminiFieldExtractionService({
    apiKey: geminiConfig.apiKey,
    model: geminiConfig.model,
    timeoutMs,
    maxFileBytes: maxUploadBytes
  });
  if (!geminiEngine || typeof geminiEngine.extractDocument !== 'function') {
    throw new TypeError('A Gemini field extraction service is required.');
  }
  const boundedTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120000 ? timeoutMs : 45000;
  const maximumConcurrentScans = Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 4 ? concurrency : 2;
  let activeScans = 0;

  async function scan(actorInput, studentInput, file) {
    try {
      return await processScan(actorInput, studentInput, file);
    } finally {
      if (Buffer.isBuffer(file?.buffer)) file.buffer.fill(0);
    }
  }

  async function processScan(actorInput, studentInput, file) {
    const studentId = normalizeId(studentInput);
    if (!studentId) throw new DocumentServiceError('Student record not found.', 404);
    const metadata = validateUpload(file, maxUploadBytes);
    if (activeScans >= maximumConcurrentScans) {
      throw new Form137ScanError('The temporary Gemini scan service is busy. Try again shortly.', 429);
    }

    activeScans += 1;
    try {
      const workspace = await getStudentDocuments(actorInput, studentId);
      if (!workspace) throw new DocumentServiceError('Student record not found.', 404);

      const result = await withTimeout((signal) => geminiEngine.extractDocument({
        buffer: file.buffer,
        mimeType: metadata.mimeType,
        documentType: 'form_137',
        signal
      }), boundedTimeout);
      if (result?.status !== 'extracted' || !result.fields || typeof result.fields !== 'object') {
        return {
          status: 'failed',
          message: FAILURE_MESSAGES.get(result?.code) || 'Gemini could not provide field suggestions. Inspect the physical paper and record its status manually.',
          suggestions: []
        };
      }

      const studentName = safeField(result.fields.studentName);
      const schoolName = safeField(result.fields.possibleSchoolName);
      const suggestions = [
        { key: 'student_name', label: 'Student name extracted (compare with linked record)', found: Boolean(studentName), candidates: studentName ? [studentName] : [] },
        { key: 'possible_school_name', label: 'Possible school name', found: Boolean(schoolName), candidates: schoolName ? [schoolName] : [] }
      ];
      const hasSuggestions = suggestions.some(({ found }) => found);
      return {
        status: hasSuggestions ? 'completed' : 'empty',
        message: hasSuggestions
          ? 'Gemini field suggestions are ready for staff inspection. They do not establish completeness, authenticity, or acceptance.'
          : 'Gemini did not identify these fields with confidence. Inspect the physical paper and record its status manually.',
        suggestions
      };
    } catch (error) {
      if (error instanceof DocumentServiceError) throw error;
      return {
        status: 'failed',
        message: 'Gemini field extraction is unavailable. Inspect the physical paper and record its status manually.',
        suggestions: []
      };
    } finally {
      activeScans -= 1;
    }
  }

  return { scan };
}

module.exports = { Form137ScanError, createForm137ScanService };
