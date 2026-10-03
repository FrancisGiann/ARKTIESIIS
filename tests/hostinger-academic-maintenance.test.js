'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { Worker } = require('node:worker_threads');
const {
  WORKER_TIMEOUT_MS,
  REQUIRED_ACK,
  SEED_MARKER,
  createHostingerAcademicMaintenance,
  normalizeWorkerResult,
  resolveMaintenanceJob
} = require('../src/hostingerAcademicSeedMaintenance');
const { runSeedJob } = require('../scripts/hostinger-academic-seed-worker');
const SEED_WORKER = path.resolve(__dirname, '../scripts/hostinger-academic-seed-worker.js');
const TARGET_DATABASE = 'u364362094_arkteisiis';

function makeEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    DB_HOST: 'localhost',
    DB_NAME: TARGET_DATABASE,
    DB_PASSWORD: 'private-db-password',
    SESSION_SECRET: 'private-session-secret',
    ...overrides
  };
}

function completeCounts() {
  return {
    studentsAdded: 120,
    existingStudentsRenamed: 100,
    teacherAccountsAdded: 4,
    existingStaffProfilesRenamed: 4,
    subjectsAdded: 4,
    sectionsReused: 12,
    assignmentsAdded: 24,
    schedulesAdded: 24,
    approvedGradeRows: 960,
    pendingReviewSubmissions: 8,
    pendingReviewRows: 240,
    sourceFiles: 8,
    currentTermAfter: '2026-2027 Term 2'
  };
}

function completeTransition() {
  return { from: '2026-2027 Term 1', fromTermId: 1, to: '2026-2027 Term 2', toTermId: 2 };
}

function completeWorkerMessage(mode = 'dry-run') {
  return {
    type: 'result', mode, status: 'completed', resultMode: mode,
    counts: completeCounts(),
    ...(mode === 'dry-run' ? { currentTermChange: completeTransition() } : {})
  };
}

function makeServer() {
  const server = new EventEmitter();
  server.listening = false;
  return server;
}

function emitListening(server) {
  server.listening = true;
  server.emit('listening');
}

function makeWorker() {
  const worker = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.terminationCount = 0;
  worker.terminate = () => {
    worker.terminationCount += 1;
    return Promise.resolve(1);
  };
  return worker;
}

function makeClock() {
  let sequence = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(callback, delay) {
      sequence += 1;
      timers.set(sequence, { callback, delay });
      return sequence;
    },
    clearTimer(id) { timers.delete(id); },
    fire(id) {
      const timer = timers.get(id);
      assert.ok(timer, `expected timer ${id}`);
      timers.delete(id);
      timer.callback();
    }
  };
}

test('maintenance is off by default and validates mode, exact database, and apply acknowledgement', () => {
  assert.deepEqual(resolveMaintenanceJob(makeEnvironment()), { enabled: false, disabled: true });
  assert.equal(resolveMaintenanceJob(makeEnvironment({ HOSTINGER_ACADEMIC_SEED_MODE: 'yes' })).reason, 'invalid-mode');
  assert.equal(resolveMaintenanceJob(makeEnvironment({
    HOSTINGER_ACADEMIC_SEED_MODE: 'dry-run', HOSTINGER_ACADEMIC_SEED_DATABASE: 'another_db'
  })).reason, 'database-mismatch');
  assert.equal(resolveMaintenanceJob(makeEnvironment({
    DB_NAME: 'bad db', HOSTINGER_ACADEMIC_SEED_MODE: 'dry-run', HOSTINGER_ACADEMIC_SEED_DATABASE: 'bad db'
  })).reason, 'invalid-database');
  assert.equal(resolveMaintenanceJob(makeEnvironment({
    HOSTINGER_ACADEMIC_SEED_MODE: 'apply', HOSTINGER_ACADEMIC_SEED_DATABASE: TARGET_DATABASE
  })).reason, 'missing-acknowledgement');

  const apply = resolveMaintenanceJob(makeEnvironment({
    HOSTINGER_ACADEMIC_SEED_MODE: 'apply',
    HOSTINGER_ACADEMIC_SEED_DATABASE: TARGET_DATABASE,
    HOSTINGER_ACADEMIC_SEED_ACK: REQUIRED_ACK
  }));
  assert.deepEqual(apply.args, [
    '--apply', '--target-database', TARGET_DATABASE,
    '--confirm-database', TARGET_DATABASE,
    '--confirm-seed-marker', SEED_MARKER,
    '--acknowledge-production-academic-expansion'
  ]);
});

test('the temporary entry starts when required, without a main-module guard', () => {
  const entryPath = path.join(__dirname, '../src/hostinger-academic-seed-entry.js');
  const entrySource = readFileSync(entryPath, 'utf8');
  let startCalls = 0;
  runInNewContext(entrySource, {
    require(modulePath) {
      assert.equal(modulePath, './hostingerAcademicSeedMaintenance');
      return { start() { startCalls += 1; } };
    }
  }, { filename: entryPath });
  assert.equal(startCalls, 1);
});

test('the server listens before one worker receives only fixed args and logs its sanitized summary', () => {
  const server = makeServer();
  const worker = makeWorker();
  const environment = makeEnvironment({
    HOSTINGER_ACADEMIC_SEED_MODE: 'dry-run',
    HOSTINGER_ACADEMIC_SEED_DATABASE: TARGET_DATABASE
  });
  const workerCalls = [];
  const logs = [];
  const errors = [];
  let serverStartCalls = 0;
  const start = createHostingerAcademicMaintenance({
    environment,
    serverStart() { serverStartCalls += 1; return server; },
    workerFactory(...args) { workerCalls.push(args); return worker; },
    logger: { log(value) { logs.push(value); }, error(value) { errors.push(value); } },
    setTimer() { return 1; }, clearTimer() {}
  });

  assert.equal(start(), server);
  assert.equal(start(), null);
  assert.equal(serverStartCalls, 1);
  assert.equal(workerCalls.length, 0);
  emitListening(server);
  server.emit('listening');
  assert.equal(workerCalls.length, 1);

  const [workerPath, options] = workerCalls[0];
  assert.equal(workerPath, SEED_WORKER);
  assert.deepEqual(options.workerData, {
    args: [
      '--dry-run', '--target-database', TARGET_DATABASE,
      '--confirm-database', TARGET_DATABASE,
      '--confirm-seed-marker', SEED_MARKER
    ]
  });
  assert.deepEqual(Object.keys(options.workerData), ['args']);
  assert.notEqual(options.env, environment);
  assert.equal(options.env.DB_PASSWORD, environment.DB_PASSWORD);
  assert.equal(options.stdout, true);
  assert.equal(options.stderr, true);
  assert.equal(JSON.stringify(options.workerData).includes('private-db-password'), false);
  assert.equal(JSON.stringify(options.workerData).includes('private-session-secret'), false);

  worker.stdout.emit('data', Buffer.from('password=must-not-reach-the-app-log'));
  worker.stderr.emit('data', Buffer.from('/private/credential/path must be suppressed'));
  worker.emit('message', {
    ...completeWorkerMessage(),
    currentTermChange: { ...completeTransition(), database: 'must-not-be-logged' },
    credentialArtifact: '/private/credential/path'
  });
  worker.emit('exit', 0);

  assert.equal(errors.length, 0);
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]), {
    event: 'hostinger-academic-seed', mode: 'dry-run', status: 'completed', exitCode: 0,
    resultMode: 'dry-run', counts: completeCounts(), currentTermChange: completeTransition()
  });
  assert.doesNotMatch(logs.join('\n') + errors.join('\n'), /private-db-password|private-session-secret|credential\/path|must-not-be-logged|password=/);
});

test('unset mode starts the app but never creates a worker', () => {
  const server = makeServer();
  const logs = [];
  let workerCalls = 0;
  const start = createHostingerAcademicMaintenance({
    environment: makeEnvironment(), serverStart: () => server,
    workerFactory() { workerCalls += 1; }, logger: { log(value) { logs.push(value); }, error() {} }
  });
  assert.equal(start(), server);
  emitListening(server);
  assert.equal(workerCalls, 0);
  assert.deepEqual(JSON.parse(logs[0]), { event: 'hostinger-academic-seed', status: 'disabled' });
});

test('invalid mode and mismatched database reject without leaking configuration', () => {
  const environments = [
    makeEnvironment({ HOSTINGER_ACADEMIC_SEED_MODE: 'apply', HOSTINGER_ACADEMIC_SEED_DATABASE: 'wrong_db' }),
    makeEnvironment({ HOSTINGER_ACADEMIC_SEED_MODE: 'unexpected' })
  ];
  for (const environment of environments) {
    const server = makeServer();
    const errors = [];
    let workerCalls = 0;
    const start = createHostingerAcademicMaintenance({
      environment, serverStart: () => server,
      workerFactory() { workerCalls += 1; },
      logger: { log() {}, error(value) { errors.push(value); } }
    });
    start();
    emitListening(server);
    assert.equal(workerCalls, 0);
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0], /wrong_db|private-db-password/);
  }
});

test('a server listen error prevents worker startup', () => {
  const server = makeServer();
  const errors = [];
  let workerCalls = 0;
  const start = createHostingerAcademicMaintenance({
    environment: makeEnvironment({
      HOSTINGER_ACADEMIC_SEED_MODE: 'dry-run', HOSTINGER_ACADEMIC_SEED_DATABASE: TARGET_DATABASE
    }),
    serverStart: () => server,
    workerFactory() { workerCalls += 1; },
    logger: { log() {}, error(value) { errors.push(value); } }
  });
  start();
  server.emit('error', new Error('private host details'));
  server.emit('listening');
  assert.equal(workerCalls, 0);
  assert.deepEqual(JSON.parse(errors[0]), {
    event: 'hostinger-academic-seed', status: 'not-started', reason: 'server-listen-failed'
  });
});

test('worker exit without a valid dry-run summary is reported as missing-summary', () => {
  const server = makeServer();
  const worker = makeWorker();
  const errors = [];
  const start = createHostingerAcademicMaintenance({
    environment: makeEnvironment({
      HOSTINGER_ACADEMIC_SEED_MODE: 'dry-run', HOSTINGER_ACADEMIC_SEED_DATABASE: TARGET_DATABASE
    }),
    serverStart: () => server, workerFactory: () => worker,
    logger: { log() {}, error(value) { errors.push(value); } },
    setTimer() { return 1; }, clearTimer() {}
  });
  start();
  emitListening(server);
  worker.emit('message', { type: 'result', mode: 'dry-run', status: 'completed' });
  worker.emit('exit', 0);
  assert.deepEqual(JSON.parse(errors[0]), {
    event: 'hostinger-academic-seed', mode: 'dry-run', status: 'missing-summary', exitCode: 0
  });
});

test('worker failure leaves the server listening and logs no worker error details', () => {
  const server = makeServer();
  const worker = makeWorker();
  const errors = [];
  const start = createHostingerAcademicMaintenance({
    environment: makeEnvironment({
      HOSTINGER_ACADEMIC_SEED_MODE: 'dry-run', HOSTINGER_ACADEMIC_SEED_DATABASE: TARGET_DATABASE
    }),
    serverStart: () => server, workerFactory: () => worker,
    logger: { log() {}, error(value) { errors.push(value); } },
    setTimer() { return 1; }, clearTimer() {}
  });
  start();
  emitListening(server);
  worker.emit('error', new Error('private host password=never-log'));
  worker.emit('exit', 1);
  assert.deepEqual(JSON.parse(errors[0]), {
    event: 'hostinger-academic-seed', mode: 'dry-run', status: 'worker-error', exitCode: 1
  });
  assert.equal(server.listening, true);
  assert.doesNotMatch(errors.join('\n'), /private host|password=/);
});

test('worker timeout terminates only the worker and clears its timer at exit', () => {
  const server = makeServer();
  const worker = makeWorker();
  const clock = makeClock();
  const errors = [];
  const start = createHostingerAcademicMaintenance({
    environment: makeEnvironment({
      HOSTINGER_ACADEMIC_SEED_MODE: 'apply',
      HOSTINGER_ACADEMIC_SEED_DATABASE: TARGET_DATABASE,
      HOSTINGER_ACADEMIC_SEED_ACK: REQUIRED_ACK
    }),
    serverStart: () => server, workerFactory: () => worker,
    logger: { log() {}, error(value) { errors.push(value); } },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeoutMs: WORKER_TIMEOUT_MS
  });
  start();
  emitListening(server);
  assert.equal(clock.timers.size, 1);
  const [timeoutId] = clock.timers.keys();
  clock.fire(timeoutId);
  assert.equal(worker.terminationCount, 1);
  worker.emit('exit', 1);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(JSON.parse(errors[0]), {
    event: 'hostinger-academic-seed', mode: 'apply', status: 'timeout', exitCode: 1
  });
  assert.equal(server.listening, true);
});

test('server close terminates an active worker and cleans up its timer', () => {
  const server = makeServer();
  const worker = makeWorker();
  const clock = makeClock();
  const errors = [];
  const start = createHostingerAcademicMaintenance({
    environment: makeEnvironment({
      HOSTINGER_ACADEMIC_SEED_MODE: 'dry-run', HOSTINGER_ACADEMIC_SEED_DATABASE: TARGET_DATABASE
    }),
    serverStart: () => server, workerFactory: () => worker,
    logger: { log() {}, error(value) { errors.push(value); } },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer
  });
  start();
  emitListening(server);
  assert.equal(clock.timers.size, 1);
  server.emit('close');
  assert.equal(worker.terminationCount, 1);
  assert.equal(clock.timers.size, 0);
  worker.emit('exit', 1);
  assert.equal(JSON.parse(errors[0]).status, 'cancelled');
});

test('worker validates and posts only a complete sanitized dry-run summary', async () => {
  const messages = [];
  const seedApi = {
    parseOptions(args) {
      assert.equal(args[0], '--dry-run');
      return { mode: 'dry-run' };
    },
    async seedAcademicFixtures({ logger }) {
      logger.log(JSON.stringify({
        mode: 'dry-run',
        counts: completeCounts(),
        currentTermChange: { ...completeTransition(), privatePath: '/do/not/post' },
        credentialArtifact: '/do/not/post'
      }));
    }
  };
  const result = await runSeedJob({
    args: ['--dry-run'], loadSeedApi: () => seedApi,
    postMessage(message) { messages.push(message); }
  });
  assert.deepEqual(result, completeWorkerMessage());
  assert.deepEqual(messages, [completeWorkerMessage()]);
  assert.doesNotMatch(JSON.stringify(messages), /do\/not\/post/);

  const missing = await runSeedJob({
    args: ['--dry-run'],
    loadSeedApi: () => ({
      parseOptions() { return { mode: 'dry-run' }; },
      async seedAcademicFixtures() {}
    }),
    postMessage() {}
  });
  assert.deepEqual(missing, { type: 'result', mode: 'dry-run', status: 'missing-summary' });
});

test('dry-run accepts a validated already-applied summary without inventing a term transition', async () => {
  const summary = { mode: 'already-applied', counts: completeCounts() };
  const result = await runSeedJob({
    args: ['--dry-run'],
    loadSeedApi: () => ({
      parseOptions() { return { mode: 'dry-run' }; },
      async seedAcademicFixtures({ logger }) { logger.log(JSON.stringify(summary)); }
    }),
    postMessage() {}
  });
  assert.deepEqual(result, {
    type: 'result', mode: 'dry-run', status: 'completed',
    resultMode: 'already-applied', counts: completeCounts()
  });
  assert.deepEqual(normalizeWorkerResult(result, 'dry-run'), {
    status: 'completed', resultMode: 'already-applied', counts: completeCounts()
  });

  const fabricated = normalizeWorkerResult({
    ...result, currentTermChange: completeTransition()
  }, 'dry-run');
  assert.deepEqual(fabricated, { status: 'missing-summary' });
  const malformed = await runSeedJob({
    args: ['--dry-run'],
    loadSeedApi: () => ({
      parseOptions() { return { mode: 'dry-run' }; },
      async seedAcademicFixtures({ logger }) {
        logger.log(JSON.stringify({ ...summary, currentTermChange: { from: 'unknown' } }));
      }
    }),
    postMessage() {}
  });
  assert.deepEqual(malformed, { type: 'result', mode: 'dry-run', status: 'missing-summary' });
});

test('worker validates an applied summary without exposing the private credential artifact path', async () => {
  const applied = await runSeedJob({
    args: ['--apply'],
    loadSeedApi: () => ({
      parseOptions() { return { mode: 'apply' }; },
      async seedAcademicFixtures({ logger }) {
        logger.log(JSON.stringify({
          mode: 'applied', counts: completeCounts(),
          credentialArtifact: '/private/credentials.json', privateWorkbookDirectory: '/private/workbooks'
        }));
      }
    }),
    postMessage() {}
  });
  assert.deepEqual(applied, {
    type: 'result', mode: 'apply', status: 'completed', resultMode: 'applied', counts: completeCounts()
  });
  assert.doesNotMatch(JSON.stringify(applied), /private\/credentials|private\/workbooks/);
});

test('a real worker loads the existing CLI but a development preflight rejects before database access', async (t) => {
  const args = [
    '--dry-run', '--target-database', 'worker_test_db',
    '--confirm-database', 'worker_test_db', '--confirm-seed-marker', SEED_MARKER
  ];
  const worker = new Worker(SEED_WORKER, {
    workerData: { args },
    env: {
      NODE_ENV: 'development', DEV_PASSWORD_ONLY_LOGIN: 'false',
      DB_HOST: 'localhost', DB_NAME: 'worker_test_db', DB_USER: 'worker_test',
      DB_PASSWORD: 'test-only-not-a-real-secret', DB_SOCKET_PATH: '/tmp/no-arktiesiis-worker-db.sock',
      APP_BASE_URL: 'http://localhost:3000'
    },
    stdout: true,
    stderr: true
  });
  t.after(() => { void worker.terminate(); });
  worker.stdout.on('data', () => {});
  worker.stderr.on('data', () => {});
  const result = await new Promise((resolve, reject) => {
    let message;
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('The isolated worker smoke test timed out.'));
    }, 10000);
    worker.once('message', (value) => { message = value; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, message });
    });
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.message, { type: 'result', mode: 'dry-run', status: 'failed' });
  assert.doesNotMatch(JSON.stringify(result.message), /test-only-not-a-real-secret|sock/);
});
