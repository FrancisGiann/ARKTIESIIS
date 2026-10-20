const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { EventEmitter } = require('node:events');
const { start } = require('../src/serverRuntime');
const { startDepartureRecoveryScheduler } = require('../src/services/departureLifecycleService');

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('loading the Hostinger entry starts the runtime without a main-module guard', () => {
  const entryPath = path.join(__dirname, '../src/server.js');
  const entrySource = readFileSync(entryPath, 'utf8');
  let startCalls = 0;

  runInNewContext(entrySource, {
    require(modulePath) {
      assert.equal(modulePath, './serverRuntime');
      return { start: () => { startCalls += 1; return Promise.resolve(); } };
    },
    console: { error() {} },
    process: { exitCode: 0, env: { APP_MAINTENANCE_MODE: 'false' } }
  }, { filename: entryPath });

  assert.equal(startCalls, 1);
});

test('maintenance entry bypasses application runtime and starts only the read-only 503 server', () => {
  const entryPath = path.join(__dirname, '../src/server.js');
  const entrySource = readFileSync(entryPath, 'utf8');
  let requiredModule;
  let maintenanceCalls = 0;
  runInNewContext(entrySource, {
    require(modulePath) {
      requiredModule = modulePath;
      return { start: () => { maintenanceCalls += 1; } };
    },
    process: { exitCode: 0, env: { APP_MAINTENANCE_MODE: 'true' } }
  }, { filename: entryPath });
  assert.equal(requiredModule, './maintenanceRuntime');
  assert.equal(maintenanceCalls, 1);
});

test('maintenance runtime responds 503 before the application runtime, DB, or workers are loaded', async (context) => {
  const { start } = require('../src/maintenanceRuntime');
  const server = start({ port: 0, logger: { log() {} } });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/anything?write=true`, { method: 'POST' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '300');
  assert.match(await response.text(), /scheduled update/i);
});

test('server drains due departures before listening and stops both recovery timers on close', async () => {
  let resolveDatabase;
  const databaseProbe = new Promise((resolve) => { resolveDatabase = resolve; });
  const errors = [];
  const calls = [];
  const fakeServer = new EventEmitter();
  let stoppedDocumentRecovery = 0;
  let stoppedDepartureRecovery = 0;
  let closedPool = 0;

  const starting = start({
    environment: { nodeEnv: 'production', devPasswordOnlyLogin: false, port: 3000 },
    databasePool: () => databaseProbe,
    closeDatabasePool: async () => { closedPool += 1; },
    appFactory: ({ databasePool, environment, documentProcessingService }) => {
      calls.push('app');
      assert.equal(typeof databasePool, 'function');
      assert.equal(environment.nodeEnv, 'production');
      assert.ok(documentProcessingService);
      return {
        listen(...args) {
          calls.push('listen');
          return fakeServer;
        }
      };
    },
    processingServiceFactory: ({ getPool }) => ({ getPool }),
    recoverySchedulerFactory: () => ({ stop() { stoppedDocumentRecovery += 1; } }),
    departureLifecycleFactory: () => ({ async processDueDepartures(options) {
      calls.push(['catchup', options]);
    } }),
    departureRecoverySchedulerFactory: () => ({ stop() { stoppedDepartureRecovery += 1; } }),
    logger: { log() {}, error(message) { errors.push(message); } }
  });

  await nextTurn();
  assert.deepEqual(calls, [], 'HTTP app and server wait while the database pool is pending');
  resolveDatabase({});
  const server = await starting;
  assert.equal(server, fakeServer);
  assert.deepEqual(calls, [['catchup', { drain: true }], 'app', 'listen']);
  fakeServer.emit('close');
  await nextTurn();
  assert.equal(stoppedDocumentRecovery, 1);
  assert.equal(stoppedDepartureRecovery, 1);
  assert.equal(closedPool, 1);
  assert.deepEqual(errors, []);
});

test('failed scheduled-departure catch-up prevents listening, closes the pool, and masks the database error', async () => {
  const errors = [];
  let appCreated = false;
  let closedPool = 0;
  await assert.rejects(start({
    environment: { nodeEnv: 'production', devPasswordOnlyLogin: false, port: 3000 },
    databasePool: async () => ({}),
    closeDatabasePool: async () => { closedPool += 1; },
    appFactory() { appCreated = true; return { listen() { throw new Error('must not listen'); } }; },
    processingServiceFactory: () => ({}),
    departureLifecycleFactory: () => ({ async processDueDepartures() { throw new Error('secret-host.internal password=hidden'); } }),
    logger: { log() {}, error(message) { errors.push(message); } }
  }), /Scheduled departure recovery failed during startup/);
  assert.equal(appCreated, false);
  assert.equal(closedPool, 1);
  assert.deepEqual(errors, [
    'ARKTIESIIS could not complete scheduled departure recovery. Application startup stopped before serving requests.'
  ]);
  assert.doesNotMatch(errors.join('\n'), /secret-host|password=/);
});

test('departure recovery scheduler coalesces overlap, retries failures, unreferences, and stops cleanly', async () => {
  let tick;
  let resolveFirstRun;
  let unrefCalls = 0;
  let clearCalls = 0;
  let attempts = 0;
  const errors = [];
  const timer = { unref() { unrefCalls += 1; } };
  const scheduler = startDepartureRecoveryScheduler({
    processDueDepartures() {
      attempts += 1;
      if (attempts === 1) return new Promise((resolve) => { resolveFirstRun = resolve; });
      return Promise.resolve({ applied: 1 });
    }
  }, {
    intervalMs: 1000,
    setIntervalFn(callback, delay) { assert.equal(delay, 1000); tick = callback; return timer; },
    clearIntervalFn(value) { assert.equal(value, timer); clearCalls += 1; },
    logger: { error(message) { errors.push(message); } }
  });
  const initialTick = tick;

  assert.equal(unrefCalls, 1);
  const firstRun = scheduler.run();
  assert.equal(scheduler.run(), firstRun, 'manual and periodic scans share the same in-flight run');
  tick();
  await nextTurn();
  assert.equal(attempts, 1, 'overlapping timer tick does not start a second worker');
  resolveFirstRun({ applied: 0 });
  await firstRun;

  const failingScheduler = startDepartureRecoveryScheduler({
    async processDueDepartures() {
      attempts += 1;
      if (attempts === 2) throw new Error('private database detail');
      return { applied: 0 };
    }
  }, {
    intervalMs: 1000,
    setIntervalFn(callback) { tick = callback; return timer; },
    clearIntervalFn() {},
    logger: { error(message) { errors.push(message); } }
  });
  const failingTick = tick;
  await failingScheduler.run();
  assert.deepEqual(errors, ['Scheduled departure recovery failed. Due cases will be retried on the next recovery scan.']);
  assert.equal(attempts, 2);
  await failingScheduler.run();
  assert.equal(attempts, 3, 'a later scan retries after infrastructure failure');
  failingScheduler.stop();
  failingTick();
  await failingScheduler.run();
  assert.equal(attempts, 3, 'stopped scheduler ignores timer ticks and direct run requests');
  scheduler.stop();
  scheduler.stop();
  initialTick();
  await scheduler.run();
  assert.equal(attempts, 3, 'stopped scheduler ignores timer ticks and direct run requests');
  assert.equal(clearCalls, 1, 'stop clears its timer once');
  assert.doesNotMatch(errors.join('\n'), /private database detail/);
});
