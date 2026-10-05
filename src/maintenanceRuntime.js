'use strict';

const express = require('express');

function maintenanceApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res) => {
    res.set('Retry-After', '300').status(503).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ARKTIESIIS maintenance</title></head><body>
<main><h1>ARKTIESIIS is temporarily unavailable</h1><p>We are completing a scheduled update. Please try again in a few minutes.</p></main>
</body></html>`);
  });
  return app;
}

function start({ port = Number(process.env.PORT || 3000), host, appFactory = maintenanceApp, logger = console } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be a valid TCP port number.');
  }
  const app = appFactory();
  const onListening = () => logger.log(`ARKTIESIIS maintenance response listening on port ${port}.`);
  return host ? app.listen(port, host, onListening) : app.listen(port, onListening);
}

module.exports = { maintenanceApp, start };
