const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { start } = require('../src/serverRuntime');

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
      return { start: () => { startCalls += 1; } };
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

test('server listens before a pending database probe settles and logs failures safely', async () => {
  let rejectDatabase;
  let databaseProbeStarted = false;
  const databaseProbe = new Promise((_resolve, reject) => { rejectDatabase = reject; });
  const errors = [];
  const calls = [];
  const fakeServer = {
    once(event, callback) {
      calls.push(['server-event', event]);
      return this;
    }
  };

  const server = start({
    environment: { nodeEnv: 'production', devPasswordOnlyLogin: false, port: 3000 },
    databasePool: () => {
      databaseProbeStarted = true;
      return databaseProbe;
    },
    appFactory: ({ databasePool, environment, documentProcessingService }) => {
      assert.equal(typeof databasePool, 'function');
      assert.equal(environment.nodeEnv, 'production');
      assert.ok(documentProcessingService);
      return {
        listen(...args) {
          calls.push(['listen', ...args]);
          return fakeServer;
        }
      };
    },
    processingServiceFactory: ({ getPool }) => ({ getPool }),
    recoverySchedulerFactory: () => ({ stop() {} }),
    logger: { log() {}, error(message) { errors.push(message); } }
  });

  assert.equal(server, fakeServer);
  assert.equal(calls[0][0], 'listen');
  assert.equal(databaseProbeStarted, false);

  await nextTurn();
  assert.equal(databaseProbeStarted, true);
  rejectDatabase(new Error('secret-host.internal password=must-not-be-logged'));
  await nextTurn();

  assert.deepEqual(errors, [
    'ARKTIESIIS could not connect to the database. Check the database settings and server availability.'
  ]);
  assert.doesNotMatch(errors.join('\n'), /secret-host|password=/);
});
