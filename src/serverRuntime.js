const { createApp } = require('./app');
const env = require('./config/environment');
const { getPool } = require('./config/database');
const { getListenHost } = require('./config/server');
const { createDocumentProcessingService, startProcessingRecoveryScheduler } = require('./services/documentProcessingService');

function start({
  environment = env,
  databasePool = getPool,
  appFactory = createApp,
  processingServiceFactory = createDocumentProcessingService,
  recoverySchedulerFactory = startProcessingRecoveryScheduler,
  logger = console
} = {}) {
  const processingService = processingServiceFactory({ getPool: databasePool });
  const app = appFactory({
    documentProcessingService: processingService,
    databasePool,
    environment
  });
  const host = getListenHost(environment);
  const onListening = () => {
    logger.log(`ARKTIESIIS running at http://${host || 'localhost'}:${environment.port}`);
  };
  const server = host
    ? app.listen(environment.port, host, onListening)
    : app.listen(environment.port, onListening);

  let processingRecovery = null;
  let serverClosed = false;
  server.once('close', () => {
    serverClosed = true;
    processingRecovery?.stop();
  });
  server.once('error', () => {
    logger.error('ARKTIESIIS could not start the HTTP server. Check the configured port and hosting settings.');
    process.exitCode = 1;
  });

  void Promise.resolve()
    .then(() => databasePool())
    .catch(() => {
      logger.error('ARKTIESIIS could not connect to the database. Check the database settings and server availability.');
    });

  try {
    processingRecovery = recoverySchedulerFactory(processingService);
    if (serverClosed) processingRecovery.stop();
  } catch {
    logger.error('ARKTIESIIS could not start document processing recovery. Background processing is unavailable.');
  }

  return server;
}

module.exports = { start };
