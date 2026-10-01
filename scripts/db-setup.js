'use strict';

const { runSetup } = require('./db-setup-v2');

if (require.main === module) {
  runSetup().catch((error) => {
    console.error(`MariaDB setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = require('./db-setup-v2');
