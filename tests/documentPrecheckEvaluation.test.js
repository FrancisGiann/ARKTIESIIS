const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  evaluateSamples,
  loadValidatedSamples,
  readManifest,
  runCli
} = require('../scripts/evaluate-document-precheck');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures/document-precheck');
const CLEAR_FIELDS = {
  studentName: 'Jamie Garcia',
  issuingSchoolName: 'North Academy',
  goodMoralContextEvidence: 'This certifies that Jamie Garcia is of good moral character.',
  goodMoralLayoutEvidence: 'A certificate title appears above a substantive character statement and student details.'
};

async function withTemporaryDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-document-eval-'));
  try {
    await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('synthetic manifest validates all PDFs before a sequential mocked evaluation', async () => {
  const validated = await loadValidatedSamples();
  assert.equal(validated.sampleType, 'synthetic');
  assert.equal(validated.samples.length, 6);
  assert.ok(validated.samples.every(({ buffer }) => buffer.subarray(0, 5).toString('ascii') === '%PDF-'));

  let activeCalls = 0;
  let maxActiveCalls = 0;
  const extractor = {
    async extractDocument({ buffer }) {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      const sample = validated.samples.find(({ buffer: candidate }) => candidate === buffer);
      await Promise.resolve();
      activeCalls -= 1;
      if (sample.id === 'good_moral_clear') throw new Error('private provider error');
      if (sample.id === 'good_moral_missing_name') {
        return { status: 'extracted', fields: { ...CLEAR_FIELDS, studentName: '' } };
      }
      if (sample.id === 'good_moral_mismatched_identity') {
        return { status: 'extracted', fields: { ...CLEAR_FIELDS, studentName: 'Alex Smith' } };
      }
      if (sample.id === 'good_moral_negated_context') {
        return { status: 'extracted', fields: {
          ...CLEAR_FIELDS,
          goodMoralContextEvidence: 'This certifies that Jamie Garcia is not of good moral character.'
        } };
      }
      if (sample.id === 'good_moral_unrelated_context') {
        return { status: 'extracted', fields: {
          ...CLEAR_FIELDS,
          goodMoralContextEvidence: 'This page confirms enrollment at North Academy.'
        } };
      }
      return { status: 'extracted', fields: { ...CLEAR_FIELDS, studentName: 'García, Jamie M.' } };
    }
  };

  let report;
  try {
    report = await evaluateSamples(validated.samples, extractor);
  } finally {
    for (const sample of validated.samples) sample.buffer.fill(0);
  }
  assert.equal(maxActiveCalls, 1);
  assert.equal(report.evaluationType, 'synthetic');
  assert.equal(report.sampleCount, 6);
  assert.equal(report.providerCalls, 6);
  assert.equal(report.extraction.statusComparisonDenominator, 6);
  assert.equal(report.extraction.statusMatches, 5);
  assert.equal(report.extraction.unavailableNameAbstentions, 1);
  assert.equal(report.extraction.skippedNameSamples, 0);
  assert.deepEqual(report.extraction.normalizedExactNameRate, { numerator: 4, denominator: 5, rate: 0.8 });
  assert.equal(report.linkedNameComparison.truePositive, 3);
  assert.equal(report.linkedNameComparison.trueNegative, 2);
  assert.equal(report.linkedNameComparison.abstentionsForMatch, 1);
  assert.deepEqual(report.linkedNameComparison.falsePositiveRate, { numerator: 0, denominator: 2, rate: 0 });
  assert.deepEqual(report.linkedNameComparison.falseNegativeRate, { numerator: 0, denominator: 3, rate: 0 });
  assert.equal(report.precheckCodeMatches, 5);
  assert.equal(report.latencyMs.callCount, 6);
  assert.equal(report.representativeSchoolAccuracyMeasured, false);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /Jamie|Garcia|Alex Smith|North Academy|good-moral-clear\.pdf|private provider error/i);
});

test('manifest labels are independent ground truth and matcher disagreements count as false positives and negatives', async () => {
  await withTemporaryDirectory(async (directory) => {
    const manifestPath = path.join(directory, 'labels.json');
    const manifest = {
      version: 1,
      sampleType: 'synthetic',
      samples: [
        {
          id: 'manual_nonmatch', file: 'good-moral-clear.pdf', mimeType: 'application/pdf', documentType: 'good_moral',
          student: { firstName: 'Jamie', lastName: 'Garcia' },
          expected: { extractionStatus: 'extracted', studentName: 'Jamie Garcia', linkedMatch: false, precheckCode: 'precheck_attention' }
        },
        {
          id: 'manual_match', file: 'good-moral-surname-first.pdf', mimeType: 'application/pdf', documentType: 'good_moral',
          student: { firstName: 'Jamie', lastName: 'Garcia' },
          expected: { extractionStatus: 'extracted', studentName: 'Jamie Garcia', linkedMatch: true, precheckCode: 'precheck_pass' }
        }
      ]
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const validated = await loadValidatedSamples(manifestPath, FIXTURE_ROOT);
    assert.equal(validated.samples.length, 2, 'independently labelled disagreement is accepted as ground truth');
    const extractor = {
      async extractDocument({ buffer }) {
        const sample = validated.samples.find(({ buffer: candidate }) => candidate === buffer);
        return { status: 'extracted', fields: {
          ...CLEAR_FIELDS,
          studentName: sample.id === 'manual_match' ? 'Alex Smith' : 'Jamie Garcia'
        } };
      }
    };
    const report = await evaluateSamples(validated.samples, extractor);
    assert.equal(report.linkedNameComparison.falsePositive, 1);
    assert.equal(report.linkedNameComparison.falseNegative, 1);
    assert.deepEqual(report.linkedNameComparison.falsePositiveRate, { numerator: 1, denominator: 1, rate: 1 });
    assert.deepEqual(report.linkedNameComparison.falseNegativeRate, { numerator: 1, denominator: 1, rate: 1 });
  });
});

test('malformed expected labels are rejected before sample-root access or provider setup', async () => {
  await withTemporaryDirectory(async (directory) => {
    const manifestPath = path.join(directory, 'malformed.json');
    const manifest = JSON.parse(await fs.readFile(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'));
    manifest.samples[0].expected.linkedMatch = 'true';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadValidatedSamples(manifestPath, path.join(directory, 'does-not-exist')));

    const priorFetch = globalThis.fetch;
    let providerCalls = 0;
    let stderr = '';
    const priorStderrWrite = process.stderr.write;
    globalThis.fetch = async () => { providerCalls += 1; throw new Error('must not run'); };
    process.stderr.write = (chunk) => { stderr += String(chunk); return true; };
    try {
      assert.equal(await runCli(['--live', '--manifest', manifestPath, '--root', path.join(directory, 'does-not-exist')]), 1);
    } finally {
      globalThis.fetch = priorFetch;
      process.stderr.write = priorStderrWrite;
    }
    assert.equal(providerCalls, 0);
    assert.doesNotMatch(stderr, /malformed\.json|does-not-exist|must not run/);
  });
});

test('manifest and sample symlinks are rejected', async () => {
  await withTemporaryDirectory(async (directory) => {
    const sampleRoot = path.join(directory, 'samples');
    await fs.mkdir(sampleRoot);
    const linkedSample = path.join(sampleRoot, 'linked.pdf');
    await fs.symlink(path.join(FIXTURE_ROOT, 'good-moral-clear.pdf'), linkedSample);
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = {
      version: 1,
      sampleType: 'synthetic',
      samples: [{
        id: 'linked', file: 'linked.pdf', mimeType: 'application/pdf', documentType: 'good_moral',
        student: { firstName: 'Jamie', lastName: 'Garcia' },
        expected: { extractionStatus: 'extracted', studentName: 'Jamie Garcia', linkedMatch: true, precheckCode: 'precheck_pass' }
      }]
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadValidatedSamples(manifestPath, sampleRoot));
    const manifestLink = path.join(directory, 'manifest-link.json');
    await fs.symlink(path.join(FIXTURE_ROOT, 'manifest.json'), manifestLink);
    await assert.rejects(readManifest(manifestLink));
  });
});

test('default evaluation CLI performs a validated dry run without provider calls', async () => {
  const stdout = execFileSync(process.execPath, ['scripts/evaluate-document-precheck.js'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  const report = JSON.parse(stdout);
  assert.equal(report.mode, 'dry_run');
  assert.equal(report.sampleCount, 6);
  assert.equal(report.providerCalls, 0);
  assert.equal(report.representativeSchoolAccuracyMeasured, false);
  assert.doesNotMatch(stdout, /Jamie|Garcia|good-moral-clear\.pdf/i);
});

test('deadline results separate timeout abstentions from samples skipped before a request', async () => {
  const validated = await loadValidatedSamples();
  let calls = 0;
  try {
    const report = await evaluateSamples(validated.samples, {
      extractDocument() {
        calls += 1;
        return new Promise(() => {});
      }
    }, { maxDurationMs: 1 });
    assert.equal(calls, 1);
    assert.equal(report.providerCalls, 1);
    assert.equal(report.skippedSamples, 5);
    assert.equal(report.extraction.statusErrors, 1);
    assert.equal(report.extraction.nameExtractionErrors, 0);
    assert.equal(report.extraction.unavailableNameAbstentions, 1);
    assert.equal(report.extraction.skippedNameSamples, 4);
    assert.equal(report.extraction.skippedMissingNameSamples, 1);
    assert.equal(report.linkedNameComparison.abstentionsForMatch, 1);
    assert.equal(report.linkedNameComparison.skippedForMatch, 3);
    assert.equal(report.linkedNameComparison.skippedForNonMatch, 2);
    assert.equal(report.linkedNameComparison.expectedMatchSamples, 4);
    assert.equal(report.linkedNameComparison.expectedNonMatchSamples, 2);
  } finally {
    for (const sample of validated.samples) sample.buffer.fill(0);
  }
});

test('representative accuracy remains unmeasured when every provider result is unavailable', async () => {
  const validated = await loadValidatedSamples();
  validated.samples.sampleType = 'representative';
  try {
    const report = await evaluateSamples(validated.samples, {
      async extractDocument() { return { status: 'unavailable', code: 'api_error', fields: null }; }
    });
    assert.equal(report.evaluationType, 'representative');
    assert.equal(report.providerCalls, 6);
    assert.equal(report.usableExtractedResultCount, 0);
    assert.equal(report.unavailableResultCount, 6);
    assert.equal(report.representativeSchoolAccuracyMeasured, false);
    assert.equal(report.extraction.unavailableNameAbstentions, 5);
    assert.equal(report.linkedNameComparison.abstentionsForMatch, 4);
    assert.equal(report.linkedNameComparison.abstentionsForNonMatch, 2);
  } finally {
    for (const sample of validated.samples) sample.buffer.fill(0);
  }
});
