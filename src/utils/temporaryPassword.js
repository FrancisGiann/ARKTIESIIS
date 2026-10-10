'use strict';

const crypto = require('node:crypto');

function createTemporaryPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

module.exports = { createTemporaryPassword };
