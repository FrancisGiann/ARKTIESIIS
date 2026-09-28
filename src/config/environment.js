const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const nodeEnv = process.env.NODE_ENV || 'development';

function parsePort(name, value, defaultValue) {
  const rawValue = value === undefined || value === '' ? String(defaultValue) : String(value);
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${name} must be a valid TCP port number.`);
  }

  const port = Number(rawValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid TCP port number.`);
  }

  return port;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseUploadMegabytes(value) {
  const rawValue = value === undefined || value === '' ? '10' : String(value);
  const megabytes = Number(rawValue);
  const bytes = Math.floor(megabytes * 1024 * 1024);
  if (!Number.isFinite(megabytes) || megabytes <= 0 || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error('MAX_UPLOAD_MB must be a positive number that fits within the supported upload size.');
  }
  return megabytes;
}

function parseDocumentProcessingConcurrency(value) {
  const rawValue = value === undefined || value === '' ? '2' : String(value);
  if (!/^[1-4]$/.test(rawValue)) throw new Error('DOCUMENT_PROCESSING_CONCURRENCY must be an integer between 1 and 4.');
  return Number(rawValue);
}

function configuredGeminiModel(value) {
  const model = value === undefined || value.trim() === '' ? 'gemini-3.8-flash' : value.trim();
  if (!/^gemini-[a-z0-9]+(?:[.-][a-z0-9]+){1,5}$/.test(model)) {
    throw new Error('GEMINI_MODEL must be a valid Gemini model identifier.');
  }
  return model;
}

function parseGeminiTimeout(value) {
  const rawValue = value === undefined || value === '' ? '45000' : String(value);
  if (!/^\d+$/.test(rawValue)) throw new Error('GEMINI_TIMEOUT_MS must be an integer between 1000 and 120000.');
  const timeoutMs = Number(rawValue);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error('GEMINI_TIMEOUT_MS must be an integer between 1000 and 120000.');
  }
  return timeoutMs;
}

function configuredGeminiApiKey(value) {
  const apiKey = value === undefined ? '' : value.trim();
  if (apiKey.length > 512 || /[\u0000-\u001f\u007f]/.test(apiKey)) {
    throw new Error('GEMINI_API_KEY is invalid.');
  }
  return apiKey;
}

const configuredSessionSecret = process.env.SESSION_SECRET;
const normalizedSessionSecret = configuredSessionSecret?.trim();
if (nodeEnv === 'production') {
  if (!normalizedSessionSecret || normalizedSessionSecret.length < 32 || normalizedSessionSecret === 'replace-with-a-long-random-secret') {
    throw new Error('SESSION_SECRET must be set to a random value with at least 32 characters in production.');
  }
}

function configuredAppBaseUrl(value, environment) {
  const rawValue = typeof value === 'string' && value.trim()
    ? value.trim()
    : environment === 'production' ? '' : `http://localhost:${process.env.PORT || '3000'}`;
  if (!rawValue) throw new Error('APP_BASE_URL must be set to the public application origin in production.');

  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error('APP_BASE_URL must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash || (environment === 'production' && url.protocol !== 'https:')) {
    throw new Error('APP_BASE_URL must be an absolute HTTP(S) origin and use HTTPS in production.');
  }
  return url.origin;
}

const appBaseUrl = configuredAppBaseUrl(process.env.APP_BASE_URL, nodeEnv);

module.exports = {
  nodeEnv,
  devPasswordOnlyLogin: process.env.DEV_PASSWORD_ONLY_LOGIN === 'true',
  port: parsePort('PORT', process.env.PORT, 3000),
  sessionSecret: normalizedSessionSecret || 'dev-only-change-me',
  appBaseUrl,
  database: {
    server: process.env.DB_SERVER || 'localhost',
    port: parsePort('DB_PORT', process.env.DB_PORT, 1433),
    // The active prototype is isolated from the legacy database. DB_NAME is
    // intentionally ignored so a developer's old .env cannot redirect writes.
    database: 'ARKTIESIIS_V2',
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || '',
    encrypt: String(process.env.DB_ENCRYPT || 'false') === 'true',
    trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERTIFICATE || 'true') === 'true'
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: parsePort('SMTP_PORT', process.env.SMTP_PORT, 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'ARKTIESIIS <no-reply@example.com>'
  },
  documentProcessing: {
    concurrency: parseDocumentProcessingConcurrency(process.env.DOCUMENT_PROCESSING_CONCURRENCY)
  },
  gemini: {
    apiKey: configuredGeminiApiKey(process.env.GEMINI_API_KEY),
    model: configuredGeminiModel(process.env.GEMINI_MODEL),
    timeoutMs: parseGeminiTimeout(process.env.GEMINI_TIMEOUT_MS)
  },
  upload: {
    maxMb: parseUploadMegabytes(process.env.MAX_UPLOAD_MB),
    storageDirectory: path.resolve(__dirname, '../../', process.env.DOCUMENT_STORAGE_DIR || 'storage/uploads')
  },
  required
};
