'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const COUNT_KEYS = [
  'studentsAdded', 'existingStudentsRenamed', 'teacherAccountsAdded', 'existingStaffProfilesRenamed',
  'subjectsAdded', 'sectionsReused', 'assignmentsAdded', 'schedulesAdded', 'approvedGradeRows',
  'pendingReviewSubmissions', 'pendingReviewRows', 'sourceFiles'
];
const MAX_CAPTURED_OUTPUT = 32 * 1024;

function safeCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.currentTermAfter !== '2026-2027 Term 2') return undefined;
  const counts = {};
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return undefined;
    counts[key] = value[key];
  }
  counts.currentTermAfter = '2026-2027 Term 2';
  return counts;
}

function safeTermTransition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fromMatch = typeof value.from === 'string'
    ? /^(\d{4}-\d{4}) (Term [1-3])$/.exec(value.from) : null;
  if (!fromMatch || value.to !== '2026-2027 Term 2'
    || !Number.isSafeInteger(value.fromTermId) || value.fromTermId < 1
    || !Number.isSafeInteger(value.toTermId) || value.toTermId < 1) return undefined;
  return {
    from: `${fromMatch[1]} ${fromMatch[2]}`,
    fromTermId: value.fromTermId,
    to: '2026-2027 Term 2',
    toTermId: value.toTermId
  };
}

function readSummary(output) {
  if (typeof output !== 'string' || output.length > MAX_CAPTURED_OUTPUT) return null;
  for (const line of output.split(/\r?\n/)) {
    if (!line || line.length > 8192) continue;
    try {
      const value = JSON.parse(line);
      if (!['dry-run', 'applied', 'already-applied'].includes(value.mode)) continue;
      const counts = safeCounts(value.counts);
      if (!counts) continue;
      const hasCurrentTermChange = Object.hasOwn(value, 'currentTermChange');
      const currentTermChange = hasCurrentTermChange ? safeTermTransition(value.currentTermChange) : undefined;
      if (hasCurrentTermChange && !currentTermChange) continue;
      return { mode: value.mode, counts, currentTermChange };
    } catch {
      // The seed service logger output is an optional summary, never an error channel.
    }
  }
  return null;
}

function validatedResult(mode, summary) {
  if (!summary) return null;
  if (mode === 'dry-run' && summary.mode === 'dry-run' && !summary.currentTermChange) return null;
  if (mode === 'dry-run' && summary.mode === 'already-applied' && summary.currentTermChange) return null;
  if (mode === 'dry-run' && !['dry-run', 'already-applied'].includes(summary.mode)) return null;
  if (mode === 'apply' && !['applied', 'already-applied'].includes(summary.mode)) return null;
  return {
    type: 'result',
    mode,
    status: 'completed',
    resultMode: summary.mode,
    counts: summary.counts,
    ...(summary.currentTermChange ? { currentTermChange: summary.currentTermChange } : {})
  };
}

async function runSeedJob({ args, loadSeedApi, postMessage } = {}) {
  const mode = Array.isArray(args) && args[0] === '--dry-run' ? 'dry-run'
    : Array.isArray(args) && args[0] === '--apply' ? 'apply' : undefined;
  const send = typeof postMessage === 'function'
    ? postMessage
    : (message) => parentPort?.postMessage(message);
  let output = '';
  let message;

  try {
    const seedApi = loadSeedApi ? loadSeedApi() : require('./expand-hostinger-academic');
    const options = seedApi.parseOptions(args);
    if (!mode || options.mode !== mode) throw new Error('invalid-options');
    await seedApi.seedAcademicFixtures({
      options,
      logger: {
        log(value) {
          if (output.length < MAX_CAPTURED_OUTPUT && typeof value === 'string') {
            output += `${value}\n`.slice(0, MAX_CAPTURED_OUTPUT - output.length);
          }
        }
      }
    });
    message = validatedResult(mode, readSummary(output))
      || { type: 'result', mode, status: 'missing-summary' };
  } catch {
    message = { type: 'result', ...(mode ? { mode } : {}), status: 'failed' };
  }

  try { send(message); } catch { /* The parent may already be shutting down. */ }
  return message;
}

if (parentPort) {
  void runSeedJob({ args: workerData?.args }).finally(() => parentPort.close());
}

module.exports = { runSeedJob, safeCounts, safeTermTransition, readSummary, validatedResult };
