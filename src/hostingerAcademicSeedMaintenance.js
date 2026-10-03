'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { start: startServer } = require('./serverRuntime');

const MODE_ENV = 'HOSTINGER_ACADEMIC_SEED_MODE';
const DATABASE_ENV = 'HOSTINGER_ACADEMIC_SEED_DATABASE';
const ACK_ENV = 'HOSTINGER_ACADEMIC_SEED_ACK';
const REQUIRED_ACK = 'hostinger-academic-expansion-v1';
const SEED_MARKER = 'hostinger-demo-expansion-v1';
const SEED_WORKER = path.resolve(__dirname, '../scripts/hostinger-academic-seed-worker.js');
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;
const COUNT_KEYS = [
  'studentsAdded', 'existingStudentsRenamed', 'teacherAccountsAdded', 'existingStaffProfilesRenamed',
  'subjectsAdded', 'sectionsReused', 'assignmentsAdded', 'schedulesAdded', 'approvedGradeRows',
  'pendingReviewSubmissions', 'pendingReviewRows', 'sourceFiles'
];

function resolveMaintenanceJob(environment) {
  const mode = environment[MODE_ENV];
  if (mode === undefined) return { enabled: false, disabled: true };
  if (mode !== 'dry-run' && mode !== 'apply') return { enabled: false, reason: 'invalid-mode' };

  const targetDatabase = environment[DATABASE_ENV];
  if (!targetDatabase || targetDatabase !== environment.DB_NAME) {
    return { enabled: false, reason: 'database-mismatch' };
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(targetDatabase)) {
    return { enabled: false, reason: 'invalid-database' };
  }
  if (mode === 'apply' && environment[ACK_ENV] !== REQUIRED_ACK) {
    return { enabled: false, reason: 'missing-acknowledgement' };
  }

  const args = [
    `--${mode}`,
    '--target-database', targetDatabase,
    '--confirm-database', targetDatabase,
    '--confirm-seed-marker', SEED_MARKER
  ];
  if (mode === 'apply') args.push('--acknowledge-production-academic-expansion');
  return { enabled: true, mode, targetDatabase, args };
}

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

function normalizeWorkerResult(message, expectedMode) {
  if (!message || typeof message !== 'object' || message.type !== 'result' || message.mode !== expectedMode) {
    return { status: 'missing-summary' };
  }
  if (message.status === 'failed') return { status: 'failed' };
  if (message.status === 'missing-summary') return { status: 'missing-summary' };
  if (message.status !== 'completed' || !['dry-run', 'applied', 'already-applied'].includes(message.resultMode)) {
    return { status: 'missing-summary' };
  }

  const counts = safeCounts(message.counts);
  const currentTermChange = safeTermTransition(message.currentTermChange);
  if (!counts) return { status: 'missing-summary' };
  if (message.currentTermChange !== undefined && !currentTermChange) return { status: 'missing-summary' };
  if (expectedMode === 'dry-run' && message.resultMode === 'dry-run' && !currentTermChange) {
    return { status: 'missing-summary' };
  }
  if (expectedMode === 'dry-run' && message.resultMode === 'already-applied' && currentTermChange) {
    return { status: 'missing-summary' };
  }
  if (expectedMode === 'dry-run' && !['dry-run', 'already-applied'].includes(message.resultMode)) {
    return { status: 'missing-summary' };
  }
  if (expectedMode === 'apply' && !['applied', 'already-applied'].includes(message.resultMode)) {
    return { status: 'missing-summary' };
  }
  return {
    status: 'completed',
    resultMode: message.resultMode,
    counts,
    ...(currentTermChange ? { currentTermChange } : {})
  };
}

function emit(logger, level, record) {
  try {
    const write = logger && typeof logger[level] === 'function' ? logger[level] : null;
    if (write) write.call(logger, JSON.stringify({ event: 'hostinger-academic-seed', ...record }));
  } catch {
    // Maintenance logging must not interrupt the serving app.
  }
}

function createHostingerAcademicMaintenance({
  environment = process.env,
  serverStart = startServer,
  workerFactory = (workerPath, options) => new Worker(workerPath, options),
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutMs = WORKER_TIMEOUT_MS
} = {}) {
  let startCalled = false;

  return function startMaintenanceEntry() {
    if (startCalled) return null;
    startCalled = true;

    const job = resolveMaintenanceJob(environment);
    const server = serverStart();
    let closed = false;
    let launchAttempted = false;
    let worker = null;
    let timeoutTimer = null;
    let timedOut = false;
    let cancelled = false;
    let workerFailure = false;
    let finished = false;
    let workerResult = null;
    let listenerFailed = false;

    const clearTimeoutTimer = () => {
      if (timeoutTimer !== null) clearTimer(timeoutTimer);
      timeoutTimer = null;
    };

    const terminateWorker = () => {
      try {
        const termination = worker?.terminate();
        if (termination && typeof termination.catch === 'function') void termination.catch(() => {});
      } catch { /* The worker may already be closing. */ }
    };

    const finishWorker = (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeoutTimer();
      const result = normalizeWorkerResult(workerResult, job.mode);
      const status = cancelled ? 'cancelled'
        : timedOut ? 'timeout'
          : workerFailure || (Number.isInteger(exitCode) && exitCode !== 0) ? 'worker-error'
            : result.status;
      const record = { mode: job.mode, status, exitCode: Number.isInteger(exitCode) ? exitCode : null };
      if (status === 'completed') {
        record.resultMode = result.resultMode;
        record.counts = result.counts;
        if (result.currentTermChange) record.currentTermChange = result.currentTermChange;
      }
      emit(logger, status === 'completed' ? 'log' : 'error', record);
      worker = null;
    };

    const onServerClosed = () => {
      closed = true;
      if (!launchAttempted) launchAttempted = true;
      if (!worker || finished) return;
      cancelled = true;
      clearTimeoutTimer();
      terminateWorker();
    };

    const onServerError = () => {
      if (launchAttempted) return;
      listenerFailed = true;
      launchAttempted = true;
      emit(logger, 'error', { status: 'not-started', reason: 'server-listen-failed' });
    };

    const launchAfterListening = () => {
      if (closed || listenerFailed || launchAttempted) return;
      launchAttempted = true;
      if (job.disabled) {
        emit(logger, 'log', { status: 'disabled' });
        return;
      }
      if (!job.enabled) {
        emit(logger, 'error', { status: 'rejected', reason: job.reason });
        return;
      }

      try {
        worker = workerFactory(SEED_WORKER, {
          workerData: { args: job.args },
          env: { ...environment },
          stdout: true,
          stderr: true
        });
      } catch {
        workerFailure = true;
        finishWorker(null);
        return;
      }

      if (!worker || typeof worker.once !== 'function') {
        workerFailure = true;
        finishWorker(null);
        return;
      }
      worker.stdout?.on('data', () => {});
      worker.stderr?.on('data', () => {});
      worker.once('message', (message) => { workerResult = message; });
      worker.once('error', () => { workerFailure = true; });
      worker.once('exit', (code) => finishWorker(code));
      timeoutTimer = setTimer(() => {
        timeoutTimer = null;
        timedOut = true;
        terminateWorker();
      }, timeoutMs);
    };

    if (!server || typeof server.once !== 'function') {
      emit(logger, 'error', { status: 'not-started', reason: 'server-handle-unavailable' });
      return server;
    }
    server.once('close', onServerClosed);
    server.once('error', onServerError);
    server.once('listening', launchAfterListening);
    if (server.listening) launchAfterListening();
    return server;
  };
}

const start = createHostingerAcademicMaintenance();

module.exports = {
  WORKER_TIMEOUT_MS,
  MODE_ENV,
  REQUIRED_ACK,
  SEED_MARKER,
  createHostingerAcademicMaintenance,
  normalizeWorkerResult,
  resolveMaintenanceJob,
  safeTermTransition,
  start
};
