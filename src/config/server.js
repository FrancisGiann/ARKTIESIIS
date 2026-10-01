const { isDevelopmentPasswordLoginEnabled } = require('../middleware/auth');
const env = require('./environment');

function getListenHost(environment = env) {
  return isDevelopmentPasswordLoginEnabled(environment) ? '127.0.0.1' : undefined;
}

module.exports = { getListenHost };
