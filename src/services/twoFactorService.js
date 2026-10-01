const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { sql: databaseTypes, Transaction } = require('../config/database');

const OTP_TTL_MINUTES = 5;
const VERIFY_WINDOW_MINUTES = 15;
const MAX_VERIFY_ATTEMPTS = 5;
const SEND_WINDOW_MINUTES = 15;
const MAX_SENDS_PER_WINDOW = 3;
const RESEND_COOLDOWN_SECONDS = 30;
const BCRYPT_ROUNDS = 12;

function generateOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashOtp(code) {
  return bcrypt.hash(code, BCRYPT_ROUNDS);
}

function compareOtp(code, codeHash) {
  return bcrypt.compare(code, codeHash);
}

async function issueOtpChallenge({
  getPool,
  sql = databaseTypes,
  userId,
  createCode = generateOtp,
  hash = hashOtp,
  transactionFactory = (pool) => new Transaction(pool)
}) {
  const code = createCode();
  const codeHash = await hash(code);
  const pool = await getPool();
  const transaction = transactionFactory(pool);
  let started = false;
  try {
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    started = true;
    await transaction.request()
      .input('userId', sql.Int, userId)
      .query(`INSERT INTO two_factor_auth_limits
        (user_id, failed_attempts, failed_window_started_at, send_count, send_window_started_at, last_sent_at)
        VALUES (@userId, 0, UTC_TIMESTAMP(), 0, UTC_TIMESTAMP(), NULL)
        ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`);
    const limitsResult = await transaction.request().input('userId', sql.Int, userId)
      .query(`SELECT send_count,
          CASE WHEN send_window_started_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${SEND_WINDOW_MINUTES} MINUTE) THEN 1 ELSE 0 END AS window_expired,
          CASE WHEN last_sent_at IS NULL THEN 1
            WHEN last_sent_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${RESEND_COOLDOWN_SECONDS} SECOND) THEN 1 ELSE 0 END AS cooldown_elapsed
        FROM two_factor_auth_limits WHERE user_id = @userId FOR UPDATE`);
    const limits = limitsResult.recordset?.[0];
    const windowExpired = Number(limits?.window_expired) === 1;
    const allowed = windowExpired
      || (Number(limits?.send_count) < MAX_SENDS_PER_WINDOW && Number(limits?.cooldown_elapsed) === 1);
    if (!allowed) {
      await transaction.commit();
      started = false;
      return { allowed: false, codeId: null, code };
    }

    await transaction.request().input('userId', sql.Int, userId).input('windowExpired', sql.Bit, windowExpired)
      .query(`UPDATE two_factor_auth_limits
        SET send_count = CASE WHEN @windowExpired = 1 THEN 1 ELSE send_count + 1 END,
          send_window_started_at = CASE WHEN @windowExpired = 1 THEN UTC_TIMESTAMP() ELSE send_window_started_at END,
          last_sent_at = UTC_TIMESTAMP()
        WHERE user_id = @userId`);
    await transaction.request().input('userId', sql.Int, userId)
      .query(`UPDATE two_factor_codes SET consumed_at = UTC_TIMESTAMP()
        WHERE user_id = @userId AND consumed_at IS NULL`);
    const inserted = await transaction.request()
      .input('userId', sql.Int, userId)
      .input('codeHash', sql.NVarChar(255), codeHash)
      .input('ttlMinutes', sql.Int, OTP_TTL_MINUTES)
      .query(`INSERT INTO two_factor_codes (user_id, code_hash, expires_at, created_at)
        VALUES (@userId, @codeHash, DATE_ADD(UTC_TIMESTAMP(), INTERVAL @ttlMinutes MINUTE), UTC_TIMESTAMP())`);
    await transaction.commit();
    started = false;
    return { allowed: true, codeId: inserted.insertId || null, code };
  } catch (error) {
    if (started) {
      try { await transaction.rollback(); } catch { /* Keep the original error. */ }
    }
    throw error;
  }
}

async function sendOtpEmail(smtp, to, code) {
  if (!smtp?.host || !smtp?.from) throw new Error('SMTP is not configured.');

  const transportOptions = {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000
  };
  if (smtp.user || smtp.pass) {
    if (!smtp.user || !smtp.pass) throw new Error('SMTP credentials are incomplete.');
    transportOptions.auth = { user: smtp.user, pass: smtp.pass };
  }

  const transporter = nodemailer.createTransport(transportOptions);
  await transporter.sendMail({
    from: smtp.from,
    to,
    subject: 'Your ARKTIESIIS sign-in code',
    text: `Your sign-in verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes. If you did not request this code, you can ignore this message.`
  });
}

async function invalidateOtpChallenge({ getPool, sql, userId, codeId }) {
  const pool = await getPool();
  await pool.request()
    .input('userId', sql.Int, userId)
    .input('codeId', sql.Int, codeId)
    .query(`
      UPDATE two_factor_codes
      SET consumed_at = UTC_TIMESTAMP()
      WHERE user_id = @userId AND id = @codeId AND consumed_at IS NULL;
    `);
}

async function getActiveUser({ getPool, sql, userId }) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query("SELECT id, email, role, password_hash, is_active, must_change_password, auth_session_version, DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%f') AS updated_at_fingerprint FROM users WHERE id = @userId");
  return result.recordset?.[0] || null;
}

async function getOtpChallenge({ getPool, sql, userId, codeId }) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .input('codeId', sql.Int, codeId)
    .query(`
      SELECT id, code_hash, expires_at
      FROM two_factor_codes
      WHERE id = @codeId AND user_id = @userId
        AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP();
    `);
  return result.recordset?.[0] || null;
}

async function reserveOtpAttempt({ getPool, sql, userId }) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .input('windowMinutes', sql.Int, VERIFY_WINDOW_MINUTES)
    .input('maxAttempts', sql.Int, MAX_VERIFY_ATTEMPTS)
    .query(`UPDATE two_factor_auth_limits
      SET failed_attempts = CASE
            WHEN failed_window_started_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL @windowMinutes MINUTE) THEN 1
            ELSE failed_attempts + 1
          END,
          failed_window_started_at = CASE
            WHEN failed_window_started_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL @windowMinutes MINUTE) THEN UTC_TIMESTAMP()
            ELSE failed_window_started_at
          END
      WHERE user_id = @userId
        AND (
          failed_window_started_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL @windowMinutes MINUTE)
          OR failed_attempts < @maxAttempts
        )`);
  return result.rowsAffected?.[0] === 1;
}

async function consumeOtpChallenge({ getPool, sql = databaseTypes, userId, codeId, codeHash, transactionFactory = (pool) => new Transaction(pool) }) {
  const pool = await getPool();
  const transaction = transactionFactory(pool);
  let started = false;
  try {
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    started = true;
    await transaction.request().input('userId', sql.Int, userId)
      .query('SELECT user_id FROM two_factor_auth_limits WHERE user_id = @userId FOR UPDATE');
    const consumed = await transaction.request()
      .input('userId', sql.Int, userId)
      .input('codeId', sql.Int, codeId)
      .input('codeHash', sql.NVarChar(255), codeHash)
      .query(`UPDATE two_factor_codes AS otp
        INNER JOIN users AS account ON account.id = otp.user_id
        SET otp.consumed_at = UTC_TIMESTAMP()
        WHERE otp.id = @codeId AND otp.user_id = @userId AND otp.code_hash = @codeHash
          AND otp.consumed_at IS NULL AND otp.expires_at > UTC_TIMESTAMP() AND account.is_active = 1`);
    const didConsume = consumed.rowsAffected?.[0] === 1;
    if (didConsume) {
      await transaction.request().input('userId', sql.Int, userId)
        .query(`UPDATE two_factor_auth_limits
          SET failed_attempts = 0, failed_window_started_at = UTC_TIMESTAMP()
          WHERE user_id = @userId`);
    }
    await transaction.commit();
    started = false;
    return didConsume;
  } catch (error) {
    if (started) {
      try { await transaction.rollback(); } catch { /* Keep the original error. */ }
    }
    throw error;
  }
}

module.exports = {
  OTP_TTL_MINUTES,
  MAX_VERIFY_ATTEMPTS,
  MAX_SENDS_PER_WINDOW,
  RESEND_COOLDOWN_SECONDS,
  generateOtp,
  hashOtp,
  compareOtp,
  issueOtpChallenge,
  sendOtpEmail,
  invalidateOtpChallenge,
  getActiveUser,
  getOtpChallenge,
  reserveOtpAttempt,
  consumeOtpChallenge
};
