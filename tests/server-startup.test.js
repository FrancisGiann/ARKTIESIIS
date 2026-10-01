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
    process: { exitCode: 0 }
  }, { filename: entryPath });

  assert.equal(startCalls, 1);
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
