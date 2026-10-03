'use strict';

function safeCode(value, pattern, maximumLength) {
  return typeof value === 'string' && value.length <= maximumLength && pattern.test(value) ? value : null;
}

function safeErrorDiagnostics(error) {
  const diagnostics = {};
  const name = safeCode(error?.name, /^[A-Za-z0-9_$.-]+$/, 80);
  const code = safeCode(error?.code, /^[A-Za-z0-9_-]+$/, 64);
  const sqlState = safeCode(error?.sqlState, /^[A-Z0-9]{5}$/, 5);
  const frames = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 12) : [];
  if (name) diagnostics.errorName = name;
  if (code) diagnostics.errorCode = code;
  if (Number.isSafeInteger(error?.errno) && error.errno >= 0) diagnostics.errorNumber = error.errno;
  if (sqlState) diagnostics.sqlState = sqlState;
  for (const frame of frames) {
    const match = /(?:^|\/)(src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.js):(\d{1,7}):(\d{1,6})\)?$/.exec(frame.trim());
    if (!match) continue;
    diagnostics.sourceLocation = `${match[1]}:${match[2]}:${match[3]}`;
    break;
  }
  return diagnostics;
}

module.exports = { safeErrorDiagnostics };
