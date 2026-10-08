const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { evaluateExtractedFields } = require('../src/services/documentValidationService');
const {
  DEFAULT_MODEL,
  MAX_INLINE_FILE_BYTES,
  createGeminiFieldExtractionService
} = require('../src/services/geminiFieldExtractionService');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST = path.join(REPOSITORY_ROOT, 'tests/fixtures/document-precheck/manifest.json');
const DEFAULT_SAMPLE_ROOT = path.join(REPOSITORY_ROOT, 'tests/fixtures/document-precheck');
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SAMPLES = 12;
const MAX_TOTAL_SAMPLE_BYTES = 40 * 1024 * 1024;
const MAX_EVALUATION_MS = 6 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 45000;
const DOCUMENT_MIME_TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png']
]);
const EXPECTED_EXTRACTION_STATUSES = new Set(['extracted', 'unavailable']);
const EXPECTED_PRECHECK_CODES = new Set(['precheck_pass', 'precheck_attention']);

class EvaluationInputError extends Error {
  constructor() {
    super('The evaluation manifest or sample files are invalid.');
    this.name = 'EvaluationInputError';
  }
}

function isBoundedText(value, maxLength, { allowEmpty = false } = {}) {
  return typeof value === 'string' && value.length <= maxLength
    && (allowEmpty || value.trim().length > 0)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || !hasOnlyKeys(manifest, ['version', 'sampleType', 'samples'])
    || manifest.version !== 1 || !['synthetic', 'representative'].includes(manifest.sampleType)
    || !Array.isArray(manifest.samples) || manifest.samples.length < 1 || manifest.samples.length > MAX_SAMPLES) {
    throw new EvaluationInputError();
  }

  const ids = new Set();
  for (const sample of manifest.samples) {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)
      || !hasOnlyKeys(sample, ['id', 'file', 'mimeType', 'documentType', 'student', 'expected'])
      || !/^[a-z][a-z0-9_-]{0,39}$/.test(sample.id) || ids.has(sample.id)
      || typeof sample.file !== 'string'
      || sample.file !== path.basename(sample.file)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:pdf|jpe?g|png)$/i.test(sample.file)
      || !DOCUMENT_MIME_TYPES.has(path.extname(sample.file).toLowerCase())
      || sample.mimeType !== DOCUMENT_MIME_TYPES.get(path.extname(sample.file).toLowerCase())
      || !['good_moral', 'psa_birth_certificate', 'report_card'].includes(sample.documentType)
      || !sample.student || typeof sample.student !== 'object' || Array.isArray(sample.student)
      || !hasOnlyKeys(sample.student, ['firstName', 'middleName', 'lastName'])
      || !isBoundedText(sample.student.firstName, 80)
      || !isBoundedText(sample.student.lastName, 80)
      || (sample.student.middleName !== undefined
        && !isBoundedText(sample.student.middleName, 80, { allowEmpty: true }))) {
      throw new EvaluationInputError();
    }
    const expected = sample.expected;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)
      || !hasOnlyKeys(expected, ['extractionStatus', 'studentName', 'linkedMatch', 'precheckCode'])
      || !EXPECTED_EXTRACTION_STATUSES.has(expected.extractionStatus)
      || !EXPECTED_PRECHECK_CODES.has(expected.precheckCode)
      || typeof expected.linkedMatch !== 'boolean'
      || !(expected.studentName === null || isBoundedText(expected.studentName, 240))
      || (expected.studentName === null && expected.linkedMatch)
      || (expected.linkedMatch && expected.extractionStatus !== 'extracted')
      || (expected.extractionStatus === 'unavailable' && expected.studentName !== null)
      || (expected.extractionStatus === 'unavailable' && expected.precheckCode !== 'precheck_attention')
      || (expected.extractionStatus === 'extracted' && expected.studentName === null
        && expected.precheckCode === 'precheck_pass')
      || (expected.precheckCode === 'precheck_pass'
        && (!expected.linkedMatch || expected.extractionStatus !== 'extracted' || expected.studentName === null))) {
      throw new EvaluationInputError();
    }
    ids.add(sample.id);
  }
  return manifest;
}

async function readBoundedRegularFile(filePath, maxBytes) {
  let fileHandle;
  try {
    const pathStats = await fs.lstat(filePath);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size < 1 || pathStats.size > maxBytes) {
      throw new EvaluationInputError();
    }
    fileHandle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const openedStats = await fileHandle.stat();
    if (!openedStats.isFile() || openedStats.size < 1 || openedStats.size > maxBytes
      || pathStats.dev !== openedStats.dev || pathStats.ino !== openedStats.ino) {
      throw new EvaluationInputError();
    }

    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const remainingWithSentinel = maxBytes + 1 - totalBytes;
      const chunk = Buffer.alloc(Math.min(64 * 1024, remainingWithSentinel));
      const { bytesRead } = await fileHandle.read(chunk, 0, chunk.length, totalBytes);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    const afterReadStats = await fileHandle.stat();
    if (totalBytes > maxBytes || totalBytes !== openedStats.size || afterReadStats.size !== openedStats.size) {
      throw new EvaluationInputError();
    }
    return Buffer.concat(chunks, totalBytes);
  } catch {
    throw new EvaluationInputError();
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

async function readManifest(manifestPath) {
  const manifestBytes = await readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new EvaluationInputError();
  }
  return validateManifest(parsed);
}

function supportedFileSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'image/jpeg') return buffer.length >= 3
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return false;
}

async function readSampleSafely(realRoot, sample) {
  const resolved = path.resolve(realRoot, sample.file);
  const relative = path.relative(realRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new EvaluationInputError();
  }
  try {
    const buffer = await readBoundedRegularFile(resolved, MAX_INLINE_FILE_BYTES);
    if (!supportedFileSignature(buffer, sample.mimeType)) {
      buffer.fill(0);
      throw new EvaluationInputError();
    }
    return buffer;
  } catch {
    throw new EvaluationInputError();
  }
}

async function loadValidatedSamples(manifestPath = DEFAULT_MANIFEST, sampleRoot = DEFAULT_SAMPLE_ROOT) {
  const manifest = await readManifest(manifestPath);
  let realRoot;
  try {
    realRoot = await fs.realpath(sampleRoot);
    const rootStats = await fs.stat(realRoot);
    if (!rootStats.isDirectory()) throw new EvaluationInputError();
  } catch {
    throw new EvaluationInputError();
  }

  let totalBytes = 0;
  const validatedSamples = [];
  try {
    for (const sample of manifest.samples) {
      const buffer = await readSampleSafely(realRoot, sample);
      totalBytes += buffer.length;
      if (totalBytes > MAX_TOTAL_SAMPLE_BYTES) {
        buffer.fill(0);
        throw new EvaluationInputError();
      }
      validatedSamples.push({
        id: sample.id,
        documentType: sample.documentType,
        mimeType: sample.mimeType,
        student: {
          first_name: sample.student.firstName,
          middle_name: sample.student.middleName || null,
          last_name: sample.student.lastName
        },
        expected: sample.expected,
        buffer
      });
    }
  } catch (error) {
    for (const sample of validatedSamples) sample.buffer.fill(0);
    throw error instanceof EvaluationInputError ? error : new EvaluationInputError();
  }
  validatedSamples.sampleType = manifest.sampleType;
  return { sampleType: manifest.sampleType, samples: validatedSamples };
}

function emptyConfusionCounts() {
  return {
    truePositive: 0,
    falseNegative: 0,
    falsePositive: 0,
    trueNegative: 0,
    abstentionsForMatch: 0,
    abstentionsForNonMatch: 0,
    skippedForMatch: 0,
    skippedForNonMatch: 0
  };
}

function ratio(numerator, denominator) {
  return { numerator, denominator, rate: denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null };
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return null;
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(percentileValue * sortedValues.length) - 1)];
}

function summarizeEvaluation(entries, sampleType, providerCalls) {
  let extractionStatusMatches = 0;
  let nameExactMatches = 0;
  let nameExtractionErrors = 0;
  let nameExtractionAbstentions = 0;
  let expectedNameCount = 0;
  let expectedMissingNameCount = 0;
  let emptyNameOutputs = 0;
  let unexpectedNameOutputs = 0;
  let unavailableMissingNameSamples = 0;
  let skippedNameSamples = 0;
  let skippedMissingNameSamples = 0;
  let skippedSamples = 0;
  let precheckCodeMatches = 0;
  let precheckCodeEvaluatedCount = 0;
  const confusion = emptyConfusionCounts();
  const latencies = [];

  for (const entry of entries) {
    const { sample, status, extractedName, evaluation, latencyMs } = entry;
    if (status === 'not_run') skippedSamples += 1;
    else if (status === sample.expected.extractionStatus) extractionStatusMatches += 1;
    if (latencyMs !== null) latencies.push(latencyMs);
    if (evaluation) {
      precheckCodeEvaluatedCount += 1;
      if (evaluation.code === sample.expected.precheckCode) precheckCodeMatches += 1;
    }

    if (sample.expected.studentName === null) {
      expectedMissingNameCount += 1;
      if (status === 'extracted' && extractedName) unexpectedNameOutputs += 1;
      else if (status === 'extracted') emptyNameOutputs += 1;
      else if (status === 'unavailable') unavailableMissingNameSamples += 1;
      else if (status === 'not_run') skippedMissingNameSamples += 1;
    } else {
      expectedNameCount += 1;
      if (status === 'unavailable') nameExtractionAbstentions += 1;
      else if (status === 'not_run') skippedNameSamples += 1;
      else if (extractedName && normalizeVisibleName(extractedName) === normalizeVisibleName(sample.expected.studentName)) nameExactMatches += 1;
      else nameExtractionErrors += 1;
    }

    const predictedMatch = status === 'extracted' ? evaluation?.studentNameMatchesLinkedRecord === true : null;
    if (status === 'not_run') {
      if (sample.expected.linkedMatch) confusion.skippedForMatch += 1;
      else confusion.skippedForNonMatch += 1;
    } else if (predictedMatch === null) {
      if (sample.expected.linkedMatch) confusion.abstentionsForMatch += 1;
      else confusion.abstentionsForNonMatch += 1;
    } else if (sample.expected.linkedMatch && predictedMatch) confusion.truePositive += 1;
    else if (sample.expected.linkedMatch) confusion.falseNegative += 1;
    else if (predictedMatch) confusion.falsePositive += 1;
    else confusion.trueNegative += 1;
  }

  latencies.sort((left, right) => left - right);
  const determinatePositiveCount = confusion.truePositive + confusion.falseNegative;
  const determinateNegativeCount = confusion.falsePositive + confusion.trueNegative;
  const allExpectedPositiveCount = determinatePositiveCount + confusion.abstentionsForMatch + confusion.skippedForMatch;
  const allExpectedNegativeCount = determinateNegativeCount + confusion.abstentionsForNonMatch + confusion.skippedForNonMatch;
  const usableExtractedResultCount = entries.filter(({ status }) => status === 'extracted').length;
  return {
    evaluationType: sampleType,
    sampleCount: entries.length,
    processedCount: entries.filter(({ status }) => status !== 'not_run').length,
    skippedSamples,
    providerCalls,
    usableExtractedResultCount,
    unavailableResultCount: entries.filter(({ status }) => status === 'unavailable').length,
    extraction: {
      statusMatches: extractionStatusMatches,
      statusErrors: entries.length - skippedSamples - extractionStatusMatches,
      statusComparisonDenominator: entries.length - skippedSamples,
      labeledStudentNames: expectedNameCount,
      exactNameMatches: nameExactMatches,
      nameExtractionErrors: nameExtractionErrors,
      unavailableNameAbstentions: nameExtractionAbstentions,
      skippedNameSamples,
      normalizedExactNameRate: ratio(nameExactMatches, expectedNameCount),
      expectedMissingNameSamples: expectedMissingNameCount,
      emptyNameOutputsForMissingLabels: emptyNameOutputs,
      unexpectedNameOutputsForMissingLabels: unexpectedNameOutputs,
      unavailableMissingNameSamples,
      skippedMissingNameSamples
    },
    linkedNameComparison: {
      ...confusion,
      expectedMatchSamples: allExpectedPositiveCount,
      expectedNonMatchSamples: allExpectedNegativeCount,
      determinateMatchDenominator: determinatePositiveCount,
      determinateNonMatchDenominator: determinateNegativeCount,
      falsePositiveRate: ratio(confusion.falsePositive, determinateNegativeCount),
      falseNegativeRate: ratio(confusion.falseNegative, determinatePositiveCount)
    },
    precheckCodeMatches,
    precheckCodeEvaluatedCount,
    latencyMs: {
      callCount: latencies.length,
      mean: latencies.length ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(1)) : null,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? latencies[latencies.length - 1] : null
    },
    representativeSchoolAccuracyMeasured: sampleType === 'representative' && usableExtractedResultCount > 0
  };
}

function normalizeVisibleName(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().match(/[a-z0-9]+/g)?.join(' ') || '';
}

async function evaluateSamples(samples, extractor, { maxDurationMs = MAX_EVALUATION_MS } = {}) {
  const startedAt = performance.now();
  const deadline = startedAt + Math.min(MAX_EVALUATION_MS, Math.max(1, maxDurationMs));
  let providerCalls = 0;
  const entries = [];
  try {
    for (const sample of samples) {
      const remainingMs = Math.max(0, deadline - performance.now());
      if (!remainingMs) {
        entries.push({ sample, status: 'not_run', extractedName: '', evaluation: null, latencyMs: null });
        continue;
      }
      const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remainingMs);
      const controller = new AbortController();
      const requestStartedAt = performance.now();
      providerCalls += 1;
      let extraction;
      let timer;
      try {
        extraction = await Promise.race([
          extractor.extractDocument({
            buffer: sample.buffer,
            mimeType: sample.mimeType,
            documentType: sample.documentType,
            signal: controller.signal
          }),
          new Promise((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve({ status: 'unavailable', fields: null });
            }, timeoutMs);
          })
        ]);
      } catch {
        extraction = { status: 'unavailable', fields: null };
      } finally {
        clearTimeout(timer);
      }
      const latencyMs = Number((performance.now() - requestStartedAt).toFixed(1));
      const extracted = extraction?.status === 'extracted' && extraction.fields
        && typeof extraction.fields === 'object' && !Array.isArray(extraction.fields);
      const status = extracted ? 'extracted' : 'unavailable';
      const fields = extracted ? extraction.fields : {};
      const extractedName = typeof fields.studentName === 'string' ? fields.studentName.slice(0, 240) : '';
      const evaluation = extracted
        ? evaluateExtractedFields(sample.documentType, fields, sample.student, true)
        : null;
      entries.push({ sample, status, extractedName, evaluation, latencyMs });
      sample.buffer.fill(0);
    }
    const sampleType = samples.sampleType || 'synthetic';
    return summarizeEvaluation(entries, sampleType, providerCalls);
  } finally {
    for (const sample of samples) sample.buffer.fill(0);
  }
}

function dryRunSummary(samples, sampleType) {
  return {
    evaluationType: sampleType,
    mode: 'dry_run',
    sampleCount: samples.length,
    formatValidatedCount: samples.length,
    providerCalls: 0,
    representativeSchoolAccuracyMeasured: false
  };
}

function parseArguments(args) {
  let live = false;
  let manifestPath = DEFAULT_MANIFEST;
  let sampleRoot = DEFAULT_SAMPLE_ROOT;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--live') live = true;
    else if (args[index] === '--manifest' && args[index + 1]) manifestPath = path.resolve(args[++index]);
    else if (args[index] === '--root' && args[index + 1]) sampleRoot = path.resolve(args[++index]);
    else throw new EvaluationInputError();
  }
  return { live, manifestPath, sampleRoot };
}

async function runCli(args = process.argv.slice(2)) {
  let validated;
  try {
    const options = parseArguments(args);
    validated = await loadValidatedSamples(options.manifestPath, options.sampleRoot);
    if (!options.live) {
      process.stdout.write(`${JSON.stringify(dryRunSummary(validated.samples, validated.sampleType), null, 2)}\n`);
      for (const sample of validated.samples) sample.buffer.fill(0);
      return 0;
    }

    require('dotenv').config({ path: path.join(REPOSITORY_ROOT, '.env'), quiet: true });
    const apiKey = typeof process.env.GEMINI_API_KEY === 'string' ? process.env.GEMINI_API_KEY.trim() : '';
    if (!apiKey) {
      process.stdout.write(`${JSON.stringify({
        ...dryRunSummary(validated.samples, validated.sampleType),
        mode: 'live',
        status: 'skipped_missing_api_key'
      }, null, 2)}\n`);
      for (const sample of validated.samples) sample.buffer.fill(0);
      return 0;
    }

    const requestedModel = typeof process.env.GEMINI_MODEL === 'string' ? process.env.GEMINI_MODEL.trim() : '';
    const model = /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+){1,5}$/.test(requestedModel) ? requestedModel : DEFAULT_MODEL;
    const extractor = createGeminiFieldExtractionService({ apiKey, model, timeoutMs: REQUEST_TIMEOUT_MS });
    const report = await evaluateSamples(validated.samples, extractor);
    process.stdout.write(`${JSON.stringify({
      mode: 'live',
      status: 'completed',
      evaluationDate: new Date().toISOString(),
      model,
      ...report
    }, null, 2)}\n`);
    return 0;
  } catch {
    for (const sample of validated?.samples || []) sample.buffer.fill(0);
    process.stderr.write('Document precheck evaluation could not run; check the manifest and sample files.\n');
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  MAX_INLINE_FILE_BYTES,
  MAX_SAMPLES,
  dryRunSummary,
  evaluateSamples,
  loadValidatedSamples,
  parseArguments,
  readManifest,
  runCli,
  summarizeEvaluation,
  supportedFileSignature,
  validateManifest
};
