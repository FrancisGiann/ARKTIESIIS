const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

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
  deliverEmail = sendEmail
} = {}) {
  async function execute(statement, bind = () => {}) {
    const pool = await getPool();
    const request = pool.request();
    bind(request);
    return request.query(statement);
  }

  async function readPasswordAccount(userId) {
    const result = await execute(`
      SELECT id, email, password_hash, is_active
      FROM dbo.users WHERE id = @userId;
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
        CASE WHEN u.role = N'student'
          THEN NULLIF(LTRIM(RTRIM(CONCAT(s.first_name, N' ', s.middle_name, N' ', s.last_name, N' ', s.suffix))), N'')
          ELSE NULLIF(LTRIM(RTRIM(CONCAT(sp.first_name, N' ', sp.last_name))), N'')
        END AS display_name,
        pending.new_email AS pending_email
      FROM dbo.users AS u
      LEFT JOIN dbo.staff_profiles AS sp ON sp.user_id = u.id
      LEFT JOIN dbo.students AS s ON s.user_id = u.id
      OUTER APPLY (
        SELECT TOP (1) new_email
        FROM dbo.pending_email_changes
        WHERE user_id = u.id AND consumed_at IS NULL AND expires_at > SYSUTCDATETIME()
        ORDER BY created_at DESC, id DESC
      ) AS pending
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
    const result = await execute(`
      SET XACT_ABORT ON;
      BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @changed BIT = 0;
        UPDATE dbo.users
        SET password_hash = @passwordHash, must_change_password = 0, updated_at = SYSUTCDATETIME()
        WHERE id = @userId AND is_active = 1 AND password_hash = @currentHash;
        IF @@ROWCOUNT = 1
        BEGIN
          SET @changed = 1;
          UPDATE dbo.two_factor_codes
          SET consumed_at = SYSUTCDATETIME()
          WHERE user_id = @userId AND consumed_at IS NULL;
          UPDATE dbo.password_reset_tokens
          SET consumed_at = SYSUTCDATETIME()
          WHERE user_id = @userId AND consumed_at IS NULL;
          UPDATE dbo.pending_email_changes
          SET consumed_at = SYSUTCDATETIME()
          WHERE user_id = @userId AND consumed_at IS NULL;
          INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@userId, N'account.password_changed', N'user', CONVERT(NVARCHAR(100), @userId), N'{"sessionsInvalidated":true}');
        END;
        COMMIT TRANSACTION;
        SELECT @changed AS changed;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;
    `, (request) => request
      .input('userId', sql.Int, userId)
      .input('passwordHash', sql.NVarChar(255), passwordHash)
      .input('currentHash', sql.NVarChar(255), account.password_hash));
    return result.recordset?.[0]?.changed === true || result.recordset?.[0]?.changed === 1
      ? 'changed'
      : 'invalid_current_password';
  }

  async function rotateOtherSessions(userId) {
    const result = await execute(`
      SET XACT_ABORT ON;
      BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @updatedVersions TABLE (auth_session_version UNIQUEIDENTIFIER);
        UPDATE dbo.users
        SET auth_session_version = NEWID()
        OUTPUT inserted.auth_session_version INTO @updatedVersions (auth_session_version)
        WHERE id = @userId AND is_active = 1;

        IF EXISTS (SELECT 1 FROM @updatedVersions)
        BEGIN
          INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@userId, N'account.sessions_revoked', N'user', CONVERT(NVARCHAR(100), @userId), N'{"otherSessionsInvalidated":true,"currentSessionRetained":true}');
        END;

        COMMIT TRANSACTION;
        SELECT CONVERT(NVARCHAR(36), auth_session_version) AS auth_session_version
        FROM @updatedVersions;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;
    `, (request) => request.input('userId', sql.Int, userId));
    return result.recordset?.[0]?.auth_session_version || null;
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
    const result = await execute(`
      SET XACT_ABORT ON;
      BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @currentEmail NVARCHAR(255);
        DECLARE @currentHash NVARCHAR(255);
        DECLARE @requestId INT = NULL;
        DECLARE @status NVARCHAR(30) = N'account_changed';

        SELECT @currentEmail = email, @currentHash = password_hash
        FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @userId AND is_active = 1;

        IF @currentEmail IS NOT NULL AND @currentHash = @currentHashCheck
        BEGIN
          IF EXISTS (SELECT 1 FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE email = @newEmail AND id <> @userId)
            SET @status = N'email_in_use';
          ELSE IF EXISTS (
            SELECT 1 FROM dbo.pending_email_changes WITH (UPDLOCK, HOLDLOCK)
            WHERE new_email = @newEmail AND user_id <> @userId
              AND consumed_at IS NULL AND expires_at > SYSUTCDATETIME()
          ) SET @status = N'email_in_use';
          ELSE
          BEGIN
            UPDATE dbo.pending_email_changes
            SET consumed_at = SYSUTCDATETIME()
            WHERE user_id = @userId AND consumed_at IS NULL;
            INSERT INTO dbo.pending_email_changes (user_id, new_email, token_hash, expires_at)
            VALUES (@userId, @newEmail, @tokenHash, DATEADD(MINUTE, @ttlMinutes, SYSUTCDATETIME()));
            SET @requestId = CONVERT(INT, SCOPE_IDENTITY());
            SET @status = N'created';
            INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
            VALUES (@userId, N'account.email_change_requested', N'user', CONVERT(NVARCHAR(100), @userId), N'{"newAddressRequiresConfirmation":true}');
          END;
        END;

        COMMIT TRANSACTION;
        SELECT @status AS status, @requestId AS request_id, @currentEmail AS current_email;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;
    `, (request) => request
      .input('userId', sql.Int, userId)
      .input('currentHashCheck', sql.NVarChar(255), account.password_hash)
      .input('newEmail', sql.NVarChar(255), newEmail)
      .input('tokenHash', sql.Char(64), tokenHash)
      .input('ttlMinutes', sql.Int, ACTION_TOKEN_TTL_MINUTES));
    const row = result.recordset?.[0];
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
        UPDATE dbo.pending_email_changes SET consumed_at = SYSUTCDATETIME()
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
      FROM dbo.pending_email_changes
      WHERE id = @requestId AND token_hash = @tokenHash
        AND consumed_at IS NULL AND expires_at > SYSUTCDATETIME() AND attempt_count < @maxAttempts;
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
    const result = await execute(`
      SET XACT_ABORT ON;
      BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @now DATETIME2 = SYSUTCDATETIME();
        DECLARE @oldEmail NVARCHAR(255);
        DECLARE @newEmail NVARCHAR(255);
        DECLARE @storedHash CHAR(64);
        DECLARE @attemptCount INT;
        DECLARE @status NVARCHAR(30) = N'invalid_token';
        DECLARE @userId INT;

        SELECT @userId = user_id, @newEmail = new_email, @storedHash = token_hash, @attemptCount = attempt_count
        FROM dbo.pending_email_changes WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @requestId AND consumed_at IS NULL;

        SELECT @oldEmail = email
        FROM dbo.users WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @userId AND is_active = 1;

        IF @oldEmail IS NOT NULL AND @newEmail IS NOT NULL
        BEGIN
          IF @attemptCount >= @maxAttempts OR (SELECT expires_at FROM dbo.pending_email_changes WHERE id = @requestId) <= @now
          BEGIN
            UPDATE dbo.pending_email_changes SET consumed_at = @now WHERE id = @requestId;
            SET @status = N'expired';
          END
          ELSE IF @storedHash <> @tokenHash
          BEGIN
            UPDATE dbo.pending_email_changes
            SET attempt_count = attempt_count + 1,
                consumed_at = CASE WHEN attempt_count + 1 >= @maxAttempts THEN @now ELSE NULL END
            WHERE id = @requestId;
            SET @status = N'invalid_token';
          END
          ELSE IF EXISTS (SELECT 1 FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE email = @newEmail AND id <> @userId)
          BEGIN
            UPDATE dbo.pending_email_changes SET consumed_at = @now WHERE id = @requestId;
            SET @status = N'email_in_use';
          END
          ELSE
          BEGIN
            UPDATE dbo.users SET email = @newEmail, updated_at = @now
            WHERE id = @userId AND is_active = 1;
            IF @@ROWCOUNT = 1
            BEGIN
              UPDATE dbo.pending_email_changes SET consumed_at = @now WHERE id = @requestId;
              UPDATE dbo.two_factor_codes SET consumed_at = @now
              WHERE user_id = @userId AND consumed_at IS NULL;
              UPDATE dbo.password_reset_tokens SET consumed_at = @now
              WHERE user_id = @userId AND consumed_at IS NULL;
              INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
              VALUES (@userId, N'account.email_changed', N'user', CONVERT(NVARCHAR(100), @userId), N'{"confirmedByNewAddress":true,"sessionsInvalidated":true}');
              SET @status = N'changed';
            END;
          END;
        END;

        COMMIT TRANSACTION;
        SELECT @status AS status;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;
    `, (request) => request
      .input('requestId', sql.Int, requestId)
      .input('tokenHash', sql.Char(64), hashActionToken(token))
      .input('maxAttempts', sql.Int, MAX_ACTION_TOKEN_ATTEMPTS));
    return result.recordset?.[0]?.status || 'invalid_token';
  }

  async function requestPasswordReset(emailInput) {
    const email = normalizeEmail(emailInput);
    if (!email || !smtpReady(smtp)) return false;
    const userResult = await execute(`
      SELECT id, email FROM dbo.users WHERE email = @email AND is_active = 1;
    `, (request) => request.input('email', sql.NVarChar(255), email));
    const user = userResult.recordset?.[0];
    if (!user) return false;

    const token = createToken();
    const tokenHash = hashActionToken(token);
    const inserted = await execute(`
      SET XACT_ABORT ON;
      BEGIN TRY
        BEGIN TRANSACTION;
        UPDATE dbo.password_reset_tokens SET consumed_at = SYSUTCDATETIME()
        WHERE user_id = @userId AND consumed_at IS NULL;
        INSERT INTO dbo.password_reset_tokens (user_id, token_hash, expires_at)
        OUTPUT inserted.id AS request_id
        VALUES (@userId, @tokenHash, DATEADD(MINUTE, @ttlMinutes, SYSUTCDATETIME()));
        COMMIT TRANSACTION;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;
    `, (request) => request
      .input('userId', sql.Int, user.id)
      .input('tokenHash', sql.Char(64), tokenHash)
      .input('ttlMinutes', sql.Int, ACTION_TOKEN_TTL_MINUTES));
    const requestId = inserted.recordset?.[0]?.request_id;
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
        UPDATE dbo.password_reset_tokens SET consumed_at = SYSUTCDATETIME()
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
      FROM dbo.password_reset_tokens AS token
      INNER JOIN dbo.users AS [user] ON [user].id = token.user_id AND [user].is_active = 1
      WHERE token.id = @requestId AND token.token_hash = @tokenHash
        AND token.consumed_at IS NULL AND token.expires_at > SYSUTCDATETIME()
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
    const result = await execute(`
      SET XACT_ABORT ON;
      BEGIN TRY
        BEGIN TRANSACTION;
        DECLARE @now DATETIME2 = SYSUTCDATETIME();
        DECLARE @userId INT;
        DECLARE @storedHash CHAR(64);
        DECLARE @attemptCount INT;
        DECLARE @expiresAt DATETIME2;
        DECLARE @status NVARCHAR(30) = N'invalid_token';

        SELECT @userId = user_id, @storedHash = token_hash,
          @attemptCount = attempt_count, @expiresAt = expires_at
        FROM dbo.password_reset_tokens WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @requestId AND consumed_at IS NULL;

        IF @userId IS NOT NULL
        BEGIN
          IF @attemptCount >= @maxAttempts OR @expiresAt <= @now
          BEGIN
            UPDATE dbo.password_reset_tokens SET consumed_at = @now WHERE id = @requestId;
            SET @status = N'expired';
          END
          ELSE IF @storedHash <> @tokenHash
          BEGIN
            UPDATE dbo.password_reset_tokens
            SET attempt_count = attempt_count + 1,
                consumed_at = CASE WHEN attempt_count + 1 >= @maxAttempts THEN @now ELSE NULL END
            WHERE id = @requestId;
            SET @status = N'invalid_token';
          END
          ELSE IF EXISTS (SELECT 1 FROM dbo.users WITH (UPDLOCK, HOLDLOCK) WHERE id = @userId AND is_active = 1)
          BEGIN
            UPDATE dbo.password_reset_tokens SET consumed_at = @now WHERE id = @requestId;
            UPDATE dbo.password_reset_tokens SET consumed_at = @now
            WHERE user_id = @userId AND consumed_at IS NULL;
            UPDATE dbo.users SET password_hash = @passwordHash, must_change_password = 0, updated_at = @now
            WHERE id = @userId AND is_active = 1;
            UPDATE dbo.two_factor_codes SET consumed_at = @now
            WHERE user_id = @userId AND consumed_at IS NULL;
            INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
            VALUES (@userId, N'account.password_reset_completed', N'user', CONVERT(NVARCHAR(100), @userId), N'{"sessionsInvalidated":true}');
            SET @status = N'reset';
          END
          ELSE
          BEGIN
            UPDATE dbo.password_reset_tokens SET consumed_at = @now WHERE id = @requestId;
            SET @status = N'expired';
          END;
        END;

        COMMIT TRANSACTION;
        SELECT @status AS status;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;
    `, (request) => request
      .input('requestId', sql.Int, requestId)
      .input('tokenHash', sql.Char(64), hashActionToken(token))
      .input('passwordHash', sql.NVarChar(255), passwordHash)
      .input('maxAttempts', sql.Int, MAX_ACTION_TOKEN_ATTEMPTS));
    return result.recordset?.[0]?.status || 'invalid_token';
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
