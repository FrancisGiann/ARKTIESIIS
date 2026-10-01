const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { getPool: defaultGetPool, sql: defaultSql, Transaction } = require('../config/database');

const PASSWORD_HASH_ROUNDS = 12;
const ACTION_TOKEN_TTL_MINUTES = 30;
const MAX_ACTION_TOKEN_ATTEMPTS = 5;
const DUMMY_PASSWORD_HASH = '$2b$12$2GN3Hm/rogpWV12Ve9rA..0pPmX1b0nzDXo16QFiqYwSNc/bRiMb2';

class AccountServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AccountServiceError';
    this.status = status;
  }
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) return null;
  return email;
}

function validatePassword(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 12 || Buffer.byteLength(value, 'utf8') > 72) return null;
  return value;
}

function normalizeTokenId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeActionToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function hashActionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createActionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function smtpReady(smtp) {
  return Boolean(smtp?.host && smtp?.from
    && (!smtp.user && !smtp.pass || smtp.user && smtp.pass));
}

async function sendEmail(smtp, { to, subject, text }) {
  if (!smtpReady(smtp)) throw new Error('Mail delivery is unavailable.');
  const options = {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000
  };
  if (smtp.user || smtp.pass) options.auth = { user: smtp.user, pass: smtp.pass };
  const transporter = nodemailer.createTransport(options);
  await transporter.sendMail({ from: smtp.from, to, subject, text });
}

function createAccountService({
  getPool = defaultGetPool,
  sql = defaultSql,
  smtp,
  appBaseUrl = 'http://localhost:3000',
  hashPassword = bcrypt.hash,
  comparePassword = bcrypt.compare,
  createToken = createActionToken,
  deliverEmail = sendEmail,
  transactionFactory = (pool) => new Transaction(pool)
} = {}) {
  async function execute(statement, bind = () => {}) {
    const pool = await getPool();
    const request = pool.request();
    bind(request);
    return request.query(statement);
  }

  async function inTransaction(callback) {
    const pool = await getPool();
    const transaction = transactionFactory(pool);
    let started = false;
    try {
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      const result = await callback(transaction);
      await transaction.commit();
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try { await transaction.rollback(); } catch { /* Preserve the original failure. */ }
      }
      throw error;
    }
  }

  async function readPasswordAccount(userId) {
    const result = await execute(`
      SELECT id, email, password_hash, is_active
      FROM users WHERE id = @userId;
    `, (request) => request.input('userId', sql.Int, userId));
    return result.recordset?.[0] || null;
  }

  async function currentPasswordMatches(userId, currentPassword) {
    if (typeof currentPassword !== 'string' || !currentPassword || Buffer.byteLength(currentPassword, 'utf8') > 72) return null;
    const account = await readPasswordAccount(userId);
    const active = account && (account.is_active === true || account.is_active === 1);
    const matches = await comparePassword(currentPassword, active ? account.password_hash : DUMMY_PASSWORD_HASH);
    return active && matches ? account : null;
  }

  async function getAccountDetails(userId) {
    const result = await execute(`
      SELECT u.id, u.email, u.role, u.must_change_password,
        CASE WHEN u.role = 'student'
          THEN NULLIF(CONCAT_WS(' ', NULLIF(TRIM(s.first_name), ''), NULLIF(TRIM(s.middle_name), ''), NULLIF(TRIM(s.last_name), ''), NULLIF(TRIM(s.suffix), '')), '')
          ELSE NULLIF(CONCAT_WS(' ', NULLIF(TRIM(sp.first_name), ''), NULLIF(TRIM(sp.last_name), '')), '')
        END AS display_name,
        (SELECT pending.new_email FROM pending_email_changes AS pending
        WHERE user_id = u.id AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP()
        ORDER BY created_at DESC, id DESC LIMIT 1) AS pending_email
      FROM users AS u
      LEFT JOIN staff_profiles AS sp ON sp.user_id = u.id
      LEFT JOIN students AS s ON s.user_id = u.id
      WHERE u.id = @userId AND u.is_active = 1;
    `, (request) => request.input('userId', sql.Int, userId));
    return result.recordset?.[0] || null;
  }

  async function changePassword(userId, currentPassword, newPassword) {
    const password = validatePassword(newPassword);
    if (!password) return 'invalid_password';
    const account = await currentPasswordMatches(userId, currentPassword);
    if (!account) return 'invalid_current_password';
    if (await comparePassword(password, account.password_hash)) return 'same_password';

    const passwordHash = await hashPassword(password, PASSWORD_HASH_ROUNDS);
    const changed = await inTransaction(async (transaction) => {
      const current = await transaction.request().input('userId', sql.Int, userId)
        .input('currentHash', sql.NVarChar(255), account.password_hash)
        .query(`SELECT id FROM users WHERE id = @userId AND is_active = 1
          AND password_hash = @currentHash FOR UPDATE`);
      if (!current.recordset?.length) return false;
      await transaction.request().input('userId', sql.Int, userId)
        .input('passwordHash', sql.NVarChar(255), passwordHash)
        .query(`UPDATE users SET password_hash = @passwordHash, must_change_password = 0, updated_at = UTC_TIMESTAMP()
          WHERE id = @userId AND is_active = 1`);
      await transaction.request().input('userId', sql.Int, userId)
        .query('UPDATE two_factor_codes SET consumed_at = UTC_TIMESTAMP() WHERE user_id = @userId AND consumed_at IS NULL');
      await transaction.request().input('userId', sql.Int, userId)
        .query('UPDATE password_reset_tokens SET consumed_at = UTC_TIMESTAMP() WHERE user_id = @userId AND consumed_at IS NULL');
      await transaction.request().input('userId', sql.Int, userId)
        .query('UPDATE pending_email_changes SET consumed_at = UTC_TIMESTAMP() WHERE user_id = @userId AND consumed_at IS NULL');
      await transaction.request().input('userId', sql.Int, userId)
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@userId, 'account.password_changed', 'user', CAST(@userId AS CHAR(100)), '{"sessionsInvalidated":true}')`);
      return true;
    });
    return changed ? 'changed' : 'invalid_current_password';
  }

  async function rotateOtherSessions(userId) {
    return inTransaction(async (transaction) => {
      const active = await transaction.request().input('userId', sql.Int, userId)
        .query('SELECT id FROM users WHERE id = @userId AND is_active = 1 FOR UPDATE');
      if (!active.recordset?.length) return null;
      await transaction.request().input('userId', sql.Int, userId)
        .query('UPDATE users SET auth_session_version = UUID() WHERE id = @userId AND is_active = 1');
      const result = await transaction.request().input('userId', sql.Int, userId)
        .query('SELECT auth_session_version FROM users WHERE id = @userId');
      await transaction.request().input('userId', sql.Int, userId)
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@userId, 'account.sessions_revoked', 'user', CAST(@userId AS CHAR(100)), '{"otherSessionsInvalidated":true,"currentSessionRetained":true}')`);
      return result.recordset?.[0]?.auth_session_version || null;
    });
  }

  async function requestEmailChange(userId, currentPassword, emailInput) {
    const newEmail = normalizeEmail(emailInput);
    if (!newEmail) return 'invalid_email';
    const account = await currentPasswordMatches(userId, currentPassword);
    if (!account) return 'invalid_current_password';
    if (newEmail === String(account.email).toLowerCase()) return 'same_email';
    if (!smtpReady(smtp)) return 'delivery_failed';

    const token = createToken();
    const tokenHash = hashActionToken(token);
    const row = await inTransaction(async (transaction) => {
      const current = await transaction.request().input('userId', sql.Int, userId)
        .query('SELECT email, password_hash FROM users WHERE id = @userId AND is_active = 1 FOR UPDATE');
      const currentAccount = current.recordset?.[0];
      if (!currentAccount || currentAccount.password_hash !== account.password_hash) return { status: 'account_changed' };

      const userConflict = await transaction.request().input('newEmail', sql.NVarChar(255), newEmail)
        .input('userId', sql.Int, userId)
        .query('SELECT id FROM users WHERE email = @newEmail AND id <> @userId FOR UPDATE');
      if (userConflict.recordset?.length) return { status: 'email_in_use' };
      const pendingConflict = await transaction.request().input('newEmail', sql.NVarChar(255), newEmail)
        .input('userId', sql.Int, userId)
        .query(`SELECT id FROM pending_email_changes
          WHERE new_email = @newEmail AND user_id <> @userId
            AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP() FOR UPDATE`);
      if (pendingConflict.recordset?.length) return { status: 'email_in_use' };

      await transaction.request().input('userId', sql.Int, userId)
        .query('UPDATE pending_email_changes SET consumed_at = UTC_TIMESTAMP() WHERE user_id = @userId AND consumed_at IS NULL');
      const inserted = await transaction.request()
        .input('userId', sql.Int, userId)
        .input('newEmail', sql.NVarChar(255), newEmail)
        .input('tokenHash', sql.Char(64), tokenHash)
        .input('ttlMinutes', sql.Int, ACTION_TOKEN_TTL_MINUTES)
        .query(`INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
          VALUES (@userId, @newEmail, @tokenHash, DATE_ADD(UTC_TIMESTAMP(), INTERVAL @ttlMinutes MINUTE))`);
      await transaction.request().input('userId', sql.Int, userId)
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@userId, 'account.email_change_requested', 'user', CAST(@userId AS CHAR(100)), '{"newAddressRequiresConfirmation":true}')`);
      return { status: 'created', request_id: inserted.insertId, current_email: currentAccount.email };
    });
    if (row?.status !== 'created' || !Number.isSafeInteger(row.request_id)) return row?.status || 'account_changed';

    const query = new URLSearchParams({ requestId: String(row.request_id), token });
    const confirmationUrl = `${appBaseUrl}/account/email/confirm?${query.toString()}`;
    try {
      await deliverEmail(smtp, {
        to: row.current_email,
        subject: 'ARKTIESIIS email change requested',
        text: `A request was made to change your ARKTIESIIS sign-in and verification email to ${newEmail}. The change will not take effect until the new address is confirmed. If you did not request this, change your password and contact the school administrator.`
      });
      await deliverEmail(smtp, {
        to: newEmail,
        subject: 'Confirm your ARKTIESIIS email address',
        text: `Confirm this address for ARKTIESIIS sign-in and email verification. This link expires in ${ACTION_TOKEN_TTL_MINUTES} minutes and can be used once: ${confirmationUrl}`
      });
      return 'created';
    } catch {
      await execute(`
        UPDATE pending_email_changes SET consumed_at = UTC_TIMESTAMP()
        WHERE id = @requestId AND user_id = @userId AND consumed_at IS NULL;
      `, (request) => request.input('requestId', sql.Int, row.request_id).input('userId', sql.Int, userId));
      return 'delivery_failed';
    }
  }

  async function inspectEmailChange(idInput, tokenInput) {
    const requestId = normalizeTokenId(idInput);
    const token = normalizeActionToken(tokenInput);
    if (!requestId || !token) return null;
    const result = await execute(`
      SELECT new_email
      FROM pending_email_changes
      WHERE id = @requestId AND token_hash = @tokenHash
        AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP() AND attempt_count < @maxAttempts;
    `, (request) => request
      .input('requestId', sql.Int, requestId)
      .input('tokenHash', sql.Char(64), hashActionToken(token))
      .input('maxAttempts', sql.Int, MAX_ACTION_TOKEN_ATTEMPTS));
    return result.recordset?.[0] || null;
  }

  async function confirmEmailChange(idInput, tokenInput) {
    const requestId = normalizeTokenId(idInput);
    const token = normalizeActionToken(tokenInput);
    if (!requestId || !token) return 'invalid_token';
    return inTransaction(async (transaction) => {
      const pendingResult = await transaction.request().input('requestId', sql.Int, requestId)
        .query(`SELECT id, user_id, new_email, token_hash, attempt_count,
            expires_at <= UTC_TIMESTAMP() AS is_expired
          FROM pending_email_changes WHERE id = @requestId AND consumed_at IS NULL FOR UPDATE`);
      const pending = pendingResult.recordset?.[0];
      if (!pending) return 'invalid_token';
      const userResult = await transaction.request().input('userId', sql.Int, pending.user_id)
        .query('SELECT id FROM users WHERE id = @userId AND is_active = 1 FOR UPDATE');
      if (!userResult.recordset?.length) return 'invalid_token';
      if (Number(pending.attempt_count) >= MAX_ACTION_TOKEN_ATTEMPTS || Number(pending.is_expired) === 1) {
        await transaction.request().input('requestId', sql.Int, requestId)
          .query('UPDATE pending_email_changes SET consumed_at = UTC_TIMESTAMP() WHERE id = @requestId AND consumed_at IS NULL');
        return 'expired';
      }
      if (pending.token_hash !== hashActionToken(token)) {
        await transaction.request().input('requestId', sql.Int, requestId).input('maxAttempts', sql.Int, MAX_ACTION_TOKEN_ATTEMPTS)
          .query(`UPDATE pending_email_changes
            SET attempt_count = attempt_count + 1,
              consumed_at = CASE WHEN attempt_count + 1 >= @maxAttempts THEN UTC_TIMESTAMP() ELSE NULL END
            WHERE id = @requestId AND consumed_at IS NULL`);
        return 'invalid_token';
      }
      const conflict = await transaction.request().input('newEmail', sql.NVarChar(255), pending.new_email)
        .input('userId', sql.Int, pending.user_id)
        .query('SELECT id FROM users WHERE email = @newEmail AND id <> @userId FOR UPDATE');
      if (conflict.recordset?.length) {
        await transaction.request().input('requestId', sql.Int, requestId)
          .query('UPDATE pending_email_changes SET consumed_at = UTC_TIMESTAMP() WHERE id = @requestId');
        return 'email_in_use';
      }
      const updated = await transaction.request().input('newEmail', sql.NVarChar(255), pending.new_email)
        .input('userId', sql.Int, pending.user_id)
        .query('UPDATE users SET email = @newEmail, updated_at = UTC_TIMESTAMP() WHERE id = @userId AND is_active = 1');
      if (updated.rowsAffected?.[0] !== 1) return 'invalid_token';
      await transaction.request().input('requestId', sql.Int, requestId)
        .query('UPDATE pending_email_changes SET consumed_at = UTC_TIMESTAMP() WHERE id = @requestId');
      await transaction.request().input('userId', sql.Int, pending.user_id)
        .query('UPDATE two_factor_codes SET consumed_at = UTC_TIMESTAMP() WHERE user_id = @userId AND consumed_at IS NULL');
      await transaction.request().input('userId', sql.Int, pending.user_id)
        .query('UPDATE password_reset_tokens SET consumed_at = UTC_TIMESTAMP() WHERE user_id = @userId AND consumed_at IS NULL');
      await transaction.request().input('userId', sql.Int, pending.user_id)
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@userId, 'account.email_changed', 'user', CAST(@userId AS CHAR(100)), '{"confirmedByNewAddress":true,"sessionsInvalidated":true}')`);
      return 'changed';
    });
  }

  async function requestPasswordReset(emailInput) {
    const email = normalizeEmail(emailInput);
    if (!email || !smtpReady(smtp)) return false;
    const userResult = await execute(`
      SELECT id, email FROM users WHERE email = @email AND is_active = 1;
    `, (request) => request.input('email', sql.NVarChar(255), email));
    const user = userResult.recordset?.[0];
    if (!user) return false;

    const token = createToken();
    const tokenHash = hashActionToken(token);
    const requestId = await inTransaction(async (transaction) => {
      await transaction.request().input('userId', sql.Int, user.id)
        .query('UPDATE password_reset_tokens SET consumed_at = UTC_TIMESTAMP() WHERE user_id = @userId AND consumed_at IS NULL');
      const inserted = await transaction.request()
        .input('userId', sql.Int, user.id)
        .input('tokenHash', sql.Char(64), tokenHash)
        .input('ttlMinutes', sql.Int, ACTION_TOKEN_TTL_MINUTES)
        .query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
          VALUES (@userId, @tokenHash, DATE_ADD(UTC_TIMESTAMP(), INTERVAL @ttlMinutes MINUTE))`);
      return inserted.insertId;
    });
    if (!Number.isSafeInteger(requestId)) return false;
    const query = new URLSearchParams({ requestId: String(requestId), token });
    const resetUrl = `${appBaseUrl}/password/reset?${query.toString()}`;
    try {
      await deliverEmail(smtp, {
        to: user.email,
        subject: 'Reset your ARKTIESIIS password',
        text: `A password reset was requested for your ARKTIESIIS account. This link expires in ${ACTION_TOKEN_TTL_MINUTES} minutes and can be used once: ${resetUrl}`
      });
      return true;
    } catch {
      await execute(`
        UPDATE password_reset_tokens SET consumed_at = UTC_TIMESTAMP()
        WHERE id = @requestId AND user_id = @userId AND consumed_at IS NULL;
      `, (request) => request.input('requestId', sql.Int, requestId).input('userId', sql.Int, user.id));
      return false;
    }
  }

  async function inspectPasswordReset(idInput, tokenInput) {
    const requestId = normalizeTokenId(idInput);
    const token = normalizeActionToken(tokenInput);
    if (!requestId || !token) return false;
    const result = await execute(`
      SELECT token.id
      FROM password_reset_tokens AS token
      INNER JOIN users AS account_user ON account_user.id = token.user_id AND account_user.is_active = 1
      WHERE token.id = @requestId AND token.token_hash = @tokenHash
        AND token.consumed_at IS NULL AND token.expires_at > UTC_TIMESTAMP()
        AND token.attempt_count < @maxAttempts;
    `, (request) => request
      .input('requestId', sql.Int, requestId)
      .input('tokenHash', sql.Char(64), hashActionToken(token))
      .input('maxAttempts', sql.Int, MAX_ACTION_TOKEN_ATTEMPTS));
    return Boolean(result.recordset?.length);
  }

  async function resetPasswordWithToken(idInput, tokenInput, passwordInput) {
    const requestId = normalizeTokenId(idInput);
    const token = normalizeActionToken(tokenInput);
    const password = validatePassword(passwordInput);
    if (!requestId || !token || !password) return 'invalid_request';
    const passwordHash = await hashPassword(password, PASSWORD_HASH_ROUNDS);
    return inTransaction(async (transaction) => {
      const result = await transaction.request().input('requestId', sql.Int, requestId)
        .query(`SELECT id, user_id, token_hash, attempt_count, expires_at <= UTC_TIMESTAMP() AS is_expired
          FROM password_reset_tokens WHERE id = @requestId AND consumed_at IS NULL FOR UPDATE`);
      const tokenRecord = result.recordset?.[0];
      if (!tokenRecord) return 'invalid_token';
      if (Number(tokenRecord.attempt_count) >= MAX_ACTION_TOKEN_ATTEMPTS || Number(tokenRecord.is_expired) === 1) {
        await transaction.request().input('requestId', sql.Int, requestId)
          .query('UPDATE password_reset_tokens SET consumed_at = UTC_TIMESTAMP() WHERE id = @requestId');
        return 'expired';
      }
      if (tokenRecord.token_hash !== hashActionToken(token)) {
        await transaction.request().input('requestId', sql.Int, requestId).input('maxAttempts', sql.Int, MAX_ACTION_TOKEN_ATTEMPTS)
          .query(`UPDATE password_reset_tokens
            SET attempt_count = attempt_count + 1,
              consumed_at = CASE WHEN attempt_count + 1 >= @maxAttempts THEN UTC_TIMESTAMP() ELSE NULL END
            WHERE id = @requestId AND consumed_at IS NULL`);
        return 'invalid_token';
      }
      const account = await transaction.request().input('userId', sql.Int, tokenRecord.user_id)
        .query('SELECT id FROM users WHERE id = @userId AND is_active = 1 FOR UPDATE');
      if (!account.recordset?.length) {
        await transaction.request().input('requestId', sql.Int, requestId)
          .query('UPDATE password_reset_tokens SET consumed_at = UTC_TIMESTAMP() WHERE id = @requestId');
        return 'expired';
      }
      await transaction.request().input('requestId', sql.Int, requestId)
        .query('UPDATE password_reset_tokens SET consumed_at = UTC_TIMESTAMP() WHERE id = @requestId');
      await transaction.request().input('userId', sql.Int, tokenRecord.user_id)
        .query('UPDATE password_reset_tokens SET consumed_at = UTC_TIMESTAMP() WHERE user_id = @userId AND consumed_at IS NULL');
      await transaction.request().input('userId', sql.Int, tokenRecord.user_id)
        .input('passwordHash', sql.NVarChar(255), passwordHash)
        .query(`UPDATE users SET password_hash = @passwordHash, must_change_password = 0, updated_at = UTC_TIMESTAMP()
          WHERE id = @userId AND is_active = 1`);
      await transaction.request().input('userId', sql.Int, tokenRecord.user_id)
        .query('UPDATE two_factor_codes SET consumed_at = UTC_TIMESTAMP() WHERE user_id = @userId AND consumed_at IS NULL');
      await transaction.request().input('userId', sql.Int, tokenRecord.user_id)
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@userId, 'account.password_reset_completed', 'user', CAST(@userId AS CHAR(100)), '{"sessionsInvalidated":true}')`);
      return 'reset';
    });
  }

  return {
    getAccountDetails,
    verifyCurrentPassword: async (userId, currentPassword) => Boolean(await currentPasswordMatches(userId, currentPassword)),
    changePassword,
    rotateOtherSessions,
    requestEmailChange,
    inspectEmailChange,
    confirmEmailChange,
    requestPasswordReset,
    inspectPasswordReset,
    resetPasswordWithToken
  };
}

module.exports = {
  ACTION_TOKEN_TTL_MINUTES,
  MAX_ACTION_TOKEN_ATTEMPTS,
  AccountServiceError,
  normalizeEmail,
  validatePassword,
  normalizeTokenId,
  normalizeActionToken,
  hashActionToken,
  createActionToken,
  createAccountService
};
