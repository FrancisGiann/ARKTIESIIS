const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

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

async function issueOtpChallenge({ getPool, sql, userId, createCode = generateOtp, hash = hashOtp }) {
  const code = createCode();
  const codeHash = await hash(code);
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .input('codeHash', sql.NVarChar(255), codeHash)
    .input('ttlMinutes', sql.Int, OTP_TTL_MINUTES)
    .input('sendWindowMinutes', sql.Int, SEND_WINDOW_MINUTES)
    .input('maxSends', sql.Int, MAX_SENDS_PER_WINDOW)
    .input('cooldownSeconds', sql.Int, RESEND_COOLDOWN_SECONDS)
    .query(`
      SET NOCOUNT ON;
      SET XACT_ABORT ON;
      DECLARE @now DATETIME2 = SYSUTCDATETIME();
      DECLARE @allowed BIT = 0;
      DECLARE @codeId INT = NULL;

      BEGIN TRY
        BEGIN TRANSACTION;

        IF EXISTS (
          SELECT 1 FROM dbo.two_factor_auth_limits WITH (UPDLOCK, HOLDLOCK)
          WHERE user_id = @userId
        )
        BEGIN
          UPDATE dbo.two_factor_auth_limits
          SET send_count = CASE
                WHEN send_window_started_at <= DATEADD(MINUTE, -@sendWindowMinutes, @now) THEN 1
                ELSE send_count + 1
              END,
              send_window_started_at = CASE
                WHEN send_window_started_at <= DATEADD(MINUTE, -@sendWindowMinutes, @now) THEN @now
                ELSE send_window_started_at
              END,
              last_sent_at = @now
          WHERE user_id = @userId
            AND (
              send_window_started_at <= DATEADD(MINUTE, -@sendWindowMinutes, @now)
              OR (
                send_count < @maxSends
                AND (last_sent_at IS NULL OR last_sent_at <= DATEADD(SECOND, -@cooldownSeconds, @now))
              )
            );
          IF @@ROWCOUNT = 1 SET @allowed = 1;
        END
        ELSE
        BEGIN
          INSERT INTO dbo.two_factor_auth_limits
            (user_id, failed_attempts, failed_window_started_at, send_count, send_window_started_at, last_sent_at)
          VALUES (@userId, 0, @now, 1, @now, @now);
          SET @allowed = 1;
        END;

        IF @allowed = 1
        BEGIN
          UPDATE dbo.two_factor_codes
          SET consumed_at = @now
          WHERE user_id = @userId AND consumed_at IS NULL;

          INSERT INTO dbo.two_factor_codes (user_id, code_hash, expires_at, created_at)
          VALUES (@userId, @codeHash, DATEADD(MINUTE, @ttlMinutes, @now), @now);
          SET @codeId = CONVERT(INT, SCOPE_IDENTITY());
        END;

        COMMIT TRANSACTION;
        SELECT @allowed AS allowed, @codeId AS codeId;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;
    `);
  const row = result.recordset?.[0];
  return { allowed: row?.allowed === true || row?.allowed === 1, codeId: row?.codeId ?? null, code };
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
      UPDATE dbo.two_factor_codes
      SET consumed_at = SYSUTCDATETIME()
      WHERE user_id = @userId AND id = @codeId AND consumed_at IS NULL;
    `);
}

async function getActiveUser({ getPool, sql, userId }) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query('SELECT id, email, role, password_hash, is_active, must_change_password, auth_session_version, CONVERT(NVARCHAR(33), updated_at, 126) AS updated_at_fingerprint FROM dbo.users WHERE id = @userId');
  return result.recordset?.[0] || null;
}

async function getOtpChallenge({ getPool, sql, userId, codeId }) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .input('codeId', sql.Int, codeId)
    .query(`
      SELECT id, code_hash, expires_at
      FROM dbo.two_factor_codes
      WHERE id = @codeId AND user_id = @userId
        AND consumed_at IS NULL AND expires_at > SYSUTCDATETIME();
    `);
  return result.recordset?.[0] || null;
}

async function reserveOtpAttempt({ getPool, sql, userId }) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .input('windowMinutes', sql.Int, VERIFY_WINDOW_MINUTES)
    .input('maxAttempts', sql.Int, MAX_VERIFY_ATTEMPTS)
    .query(`
      DECLARE @now DATETIME2 = SYSUTCDATETIME();
      UPDATE dbo.two_factor_auth_limits
      SET failed_attempts = CASE
            WHEN failed_window_started_at <= DATEADD(MINUTE, -@windowMinutes, @now) THEN 1
            ELSE failed_attempts + 1
          END,
          failed_window_started_at = CASE
            WHEN failed_window_started_at <= DATEADD(MINUTE, -@windowMinutes, @now) THEN @now
            ELSE failed_window_started_at
          END
      OUTPUT inserted.failed_attempts AS attempts
      WHERE user_id = @userId
        AND (
          failed_window_started_at <= DATEADD(MINUTE, -@windowMinutes, @now)
          OR failed_attempts < @maxAttempts
        );
    `);
  return Boolean(result.recordset?.length);
}

async function consumeOtpChallenge({ getPool, sql, userId, codeId, codeHash }) {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .input('codeId', sql.Int, codeId)
    .input('codeHash', sql.NVarChar(255), codeHash)
    .query(`
      SET NOCOUNT ON;
      SET XACT_ABORT ON;
      DECLARE @consumed BIT = 0;
      DECLARE @lockedUserId INT;

      BEGIN TRY
        BEGIN TRANSACTION;
        SELECT @lockedUserId = user_id
        FROM dbo.two_factor_auth_limits WITH (UPDLOCK, HOLDLOCK)
        WHERE user_id = @userId;

        UPDATE otp
        SET consumed_at = SYSUTCDATETIME()
        FROM dbo.two_factor_codes AS otp
        INNER JOIN dbo.users AS [user] ON [user].id = otp.user_id
        WHERE otp.id = @codeId AND otp.user_id = @userId
          AND otp.code_hash = @codeHash
          AND otp.consumed_at IS NULL AND otp.expires_at > SYSUTCDATETIME()
          AND [user].is_active = 1;
        IF @@ROWCOUNT = 1
        BEGIN
          SET @consumed = 1;
          UPDATE dbo.two_factor_auth_limits
          SET failed_attempts = 0, failed_window_started_at = SYSUTCDATETIME()
          WHERE user_id = @userId;
        END;

        COMMIT TRANSACTION;
        SELECT @consumed AS consumed;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;
      END CATCH;
    `);
  const consumed = result.recordset?.[0]?.consumed;
  return consumed === true || consumed === 1;
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
