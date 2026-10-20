const { createApp } = require('./app');
const env = require('./config/environment');
const { getPool, closePool } = require('./config/database');
const { getListenHost } = require('./config/server');
const { createDocumentProcessingService, startProcessingRecoveryScheduler } = require('./services/documentProcessingService');
const { createDepartureLifecycleService, startDepartureRecoveryScheduler } = require('./services/departureLifecycleService');

async function start({
  environment = env,
  databasePool = getPool,
  closeDatabasePool = closePool,
  appFactory = createApp,
  processingServiceFactory = createDocumentProcessingService,
  recoverySchedulerFactory = startProcessingRecoveryScheduler,
  departureLifecycleFactory = createDepartureLifecycleService,
  departureRecoverySchedulerFactory = startDepartureRecoveryScheduler,
  logger = console
} = {}) {
  const processingService = processingServiceFactory({ getPool: databasePool, sessionSecret: environment.sessionSecret });
  const departureLifecycle = departureLifecycleFactory({ getPool: databasePool });
  let departureRecovery = null;

  try {
    await databasePool();
    await departureLifecycle.processDueDepartures({ drain: true });
    departureRecovery = departureRecoverySchedulerFactory(departureLifecycle);
  } catch {
    departureRecovery?.stop();
    await Promise.resolve().then(() => closeDatabasePool()).catch(() => {});
    logger.error('ARKTIESIIS could not complete scheduled departure recovery. Application startup stopped before serving requests.');
    throw new Error('Scheduled departure recovery failed during startup.');
  }

  let app;
  try {
    app = appFactory({ documentProcessingService: processingService, databasePool, environment });
  } catch (error) {
    departureRecovery?.stop();
    await Promise.resolve().then(() => closeDatabasePool()).catch(() => {});
    throw error;
  }
  const host = getListenHost(environment);
  const onListening = () => {
    logger.log(`ARKTIESIIS running at http://${host || 'localhost'}:${environment.port}`);
  };
  let server;
  try {
    server = host
      ? app.listen(environment.port, host, onListening)
      : app.listen(environment.port, onListening);
  } catch (error) {
    departureRecovery?.stop();
    await Promise.resolve().then(() => closeDatabasePool()).catch(() => {});
    throw error;
  }

  let processingRecovery = null;
  let serverClosed = false;
  const stopRecoveries = () => {
    processingRecovery?.stop();
    departureRecovery?.stop();
  };
  server.once('close', () => {
    serverClosed = true;
    stopRecoveries();
    void Promise.resolve().then(() => closeDatabasePool()).catch(() => {});
  });
  server.once('error', () => {
    logger.error('ARKTIESIIS could not start the HTTP server. Check the configured port and hosting settings.');
    serverClosed = true;
    stopRecoveries();
    void Promise.resolve().then(() => closeDatabasePool()).catch(() => {});
    process.exitCode = 1;
  });

  try {
    processingRecovery = recoverySchedulerFactory(processingService);
  } catch {
    logger.error('ARKTIESIIS could not start document processing recovery. Background processing is unavailable.');
  }
  if (serverClosed) stopRecoveries();

  return server;
}

module.exports = { start };
