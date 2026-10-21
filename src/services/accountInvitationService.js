'use strict';

const { getPool: defaultGetPool, sql: defaultSql, Transaction } = require('../config/database');
const bcrypt = require('bcrypt');
const {
  ACTION_TOKEN_TTL_MINUTES,
  normalizeTokenId,
  normalizeActionToken,
  hashActionToken,
  createActionToken,
  validatePassword
} = require('./accountService');
const { buildAccountInvitationEmail, deliverTransactionalEmail } = require('./transactionalEmail');
const { runSerializableTransaction } = require('./transactionRetry');

const MAX_INVITATION_BATCH = 100;
const INVITATION_SEND_WINDOW_MINUTES = 15;
const BULK_DELIVERY_RESPONSE_WAIT_MS = 20_000;

class AccountInvitationError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = 'AccountInvitationError';
    this.status = status;
    this.code = code;
  }
}

function maskEmail(value) {
  if (typeof value !== 'string') return '';
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return '';
  const local = value.slice(0, at);
  const visible = local.length < 3 ? local.slice(0, 1) : `${local[0]}•••${local.at(-1)}`;
  return `${visible}@${value.slice(at + 1)}`;
}

function affectedRows(result) {
  return result?.rowsAffected?.[0] ?? result?.affectedRows ?? 0;
}

function createAccountInvitationService({
  getPool = defaultGetPool,
  sql = defaultSql,
  smtp,
  appBaseUrl = 'http://localhost:3000',
  createToken = createActionToken,
  hashToken = hashActionToken,
  hashPassword = bcrypt.hash,
  deliverEmail = deliverTransactionalEmail,
  bulkResponseWaitMs = BULK_DELIVERY_RESPONSE_WAIT_MS,
  transactionFactory = (pool) => new Transaction(pool)
} = {}) {
  let configuredOrigin;
  try {
    const parsed = new URL(appBaseUrl);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('invalid origin');
    configuredOrigin = parsed.origin;
  } catch {
    throw new TypeError('Account invitation URLs require a configured application origin.');
  }

  async function execute(statement, bind = () => {}) {
    const pool = await getPool();
    const request = pool.request();
    bind(request);
    return request.query(statement);
  }

  async function inTransaction(callback) {
    return runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
  }

  async function requireAdminActor(request, actorInput) {
    const actorId = normalizeTokenId(actorInput);
    if (!actorId) throw new AccountInvitationError('Database administrator access is required.', 403);
    const result = await request.input('actorId', sql.Int, actorId)
      .query("SELECT id FROM users WHERE id = @actorId AND role = 'database_admin' AND is_active = 1 AND invitation_required = 0 FOR UPDATE");
    if (!result.recordset?.length) throw new AccountInvitationError('Your administrator access is no longer active. Sign in again.', 403);
    return actorId;
  }

  function normalizeRecipients(recipients) {
    if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > MAX_INVITATION_BATCH) {
      throw new AccountInvitationError('Choose between one and 100 accounts for invitation delivery.');
    }
    const seen = new Set();
    return recipients.map((recipient) => {
      const userId = normalizeTokenId(recipient?.userId ?? recipient?.id);
      if (!userId || seen.has(userId)) throw new AccountInvitationError('The invitation list is invalid. Review the accounts and try again.', 409);
      seen.add(userId);
      return {
        userId,
        rowNumber: Number.isSafeInteger(recipient?.rowNumber) ? recipient.rowNumber : null,
        studentNo: typeof recipient?.studentNo === 'string' ? recipient.studentNo : null,
        requiredRole: typeof recipient?.requiredRole === 'string' ? recipient.requiredRole : null
      };
    });
  }

  function makeTokenRecord() {
    const token = createToken();
    if (!normalizeActionToken(token)) throw new TypeError('The invitation token generator returned an invalid token.');
    const tokenHash = hashToken(token);
    if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/i.test(tokenHash)) throw new TypeError('The invitation token hash is invalid.');
    return { token, tokenHash };
  }

  async function prepareInvitations(actorInput, recipientsInput) {
    const recipients = normalizeRecipients(recipientsInput);
    const candidates = new Map(recipients.map((recipient) => [recipient.userId, makeTokenRecord()]));
    return inTransaction(async (transaction) => {
      const actorId = await requireAdminActor(transaction.request(), actorInput);
      const sendCount = await transaction.request().input('actorId', sql.Int, actorId)
        .query(`SELECT COUNT(*) AS send_count FROM account_setup_tokens
          WHERE created_by = @actorId
            AND created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${INVITATION_SEND_WINDOW_MINUTES} MINUTE)`);
      if (Number(sendCount.recordset?.[0]?.send_count || 0) + recipients.length > MAX_INVITATION_BATCH) {
        throw new AccountInvitationError('No more than 100 setup invitations can be sent in 15 minutes. Try again later.', 429, 'send_window');
      }
      const accountById = new Map();
      for (const recipient of [...recipients].sort((left, right) => left.userId - right.userId)) {
        const result = await transaction.request().input('userId', sql.Int, recipient.userId)
          .query(`SELECT id, email, role, is_active, invitation_required
            FROM users WHERE id = @userId FOR UPDATE`);
        const account = result.recordset?.[0];
        if (!account) throw new AccountInvitationError('An account is no longer available for setup.', 409);
        if (!(account.is_active === true || account.is_active === 1)
          || !(account.invitation_required === true || account.invitation_required === 1)
          || (recipient.requiredRole && account.role !== recipient.requiredRole)) {
          throw new AccountInvitationError('An account is no longer waiting for an invitation. Review its current status.', 409);
        }
        accountById.set(recipient.userId, account);
      }

      const prepared = [];
      for (const recipient of [...recipients].sort((left, right) => left.userId - right.userId)) {
        const account = accountById.get(recipient.userId);
        const history = await transaction.request().input('userId', sql.Int, recipient.userId)
          .query(`SELECT id, created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 SECOND) AS cooldown_active
            FROM account_setup_tokens
            WHERE user_id = @userId ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`);
        const previousInvitation = history.recordset?.[0];
        if (Number(previousInvitation?.cooldown_active) === 1) {
          throw new AccountInvitationError('Wait 30 seconds before sending another setup invitation.', 429, 'cooldown');
        }
        await transaction.request().input('userId', sql.Int, recipient.userId)
          .query(`UPDATE account_setup_tokens SET revoked_at = UTC_TIMESTAMP(3)
            WHERE user_id = @userId AND consumed_at IS NULL AND revoked_at IS NULL`);
        const token = candidates.get(recipient.userId);
        const inserted = await transaction.request()
          .input('userId', sql.Int, recipient.userId)
          .input('createdBy', sql.Int, actorId)
          .input('tokenHash', sql.Char(64), token.tokenHash)
          .input('emailSnapshot', sql.NVarChar(255), account.email)
          .input('ttlMinutes', sql.Int, ACTION_TOKEN_TTL_MINUTES)
          .query(`INSERT INTO account_setup_tokens
              (user_id, created_by, token_hash, email_snapshot, expires_at, delivery_status)
            VALUES (@userId, @createdBy, @tokenHash, @emailSnapshot,
              DATE_ADD(UTC_TIMESTAMP(3), INTERVAL @ttlMinutes MINUTE), 'pending')`);
        if (!Number.isSafeInteger(inserted.insertId) || inserted.insertId < 1) {
          throw new Error('Invitation insert returned no identifier.');
        }
        prepared.push({
          userId: recipient.userId,
          invitationId: inserted.insertId,
          email: account.email,
          role: account.role,
          resent: Boolean(previousInvitation),
          tokenHash: token.tokenHash,
          token: token.token,
          rowNumber: recipient.rowNumber,
          studentNo: recipient.studentNo
        });
      }
      for (const item of prepared) {
        await transaction.request()
          .input('actorId', sql.Int, actorId)
          .input('action', sql.NVarChar(100), item.resent ? 'account.invitation_resent' : 'account.invitation_issued')
          .input('userId', sql.Int, item.userId)
          .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify({ role: item.role, bulk: recipients.length > 1 }))
          .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
            VALUES (@actorId, @action, 'user', CAST(@userId AS CHAR(100)), @detailsJson)`);
      }
      return prepared;
    });
  }

  async function updateDeliveryStatus(invitationId, status) {
    const result = await execute(`UPDATE account_setup_tokens AS invitation
      INNER JOIN users AS account ON account.id = invitation.user_id
      SET invitation.delivery_status = @status
      WHERE invitation.id = @invitationId AND invitation.consumed_at IS NULL AND invitation.revoked_at IS NULL
        AND invitation.expires_at > UTC_TIMESTAMP(3) AND invitation.delivery_status = 'pending'
        AND account.is_active = 1 AND account.invitation_required = 1
        AND account.email = invitation.email_snapshot`, (request) => request
      .input('invitationId', sql.Int, invitationId)
      .input('status', sql.NVarChar(20), status));
    return result?.affectedRows ?? result?.rowsAffected?.[0] ?? 0;
  }

  async function preparedInvitationIsCurrent(prepared) {
    const result = await execute(`SELECT invitation.id FROM account_setup_tokens AS invitation
      INNER JOIN users AS account ON account.id = invitation.user_id
      WHERE invitation.id = @invitationId AND invitation.user_id = @userId
        AND invitation.token_hash = @tokenHash AND invitation.email_snapshot = @email
        AND invitation.consumed_at IS NULL AND invitation.revoked_at IS NULL
        AND invitation.expires_at > UTC_TIMESTAMP(3) AND invitation.delivery_status = 'pending'
        AND account.is_active = 1 AND account.invitation_required = 1
        AND account.email = invitation.email_snapshot`, (request) => request
      .input('invitationId', sql.Int, prepared.invitationId)
      .input('userId', sql.Int, prepared.userId)
      .input('tokenHash', sql.Char(64), prepared.tokenHash)
      .input('email', sql.NVarChar(255), prepared.email));
    return Boolean(result.recordset?.length);
  }

  function isDefinitiveMailRejection(error) {
    const responseCode = Number(error?.responseCode);
    if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode < 600) return true;
    return ['EAUTH', 'EENVELOPE'].includes(String(error?.code || '').toUpperCase());
  }

  async function deliverPreparedInvitation(prepared) {
    try {
      if (!await preparedInvitationIsCurrent(prepared)) return { ...prepared, token: undefined, status: 'delivery_not_current' };
    } catch {
      return { ...prepared, token: undefined, status: 'delivery_status_unknown' };
    }

    const url = new URL('/account/setup', configuredOrigin);
    url.searchParams.set('requestId', String(prepared.invitationId));
    url.searchParams.set('token', prepared.token);
    const email = buildAccountInvitationEmail(url.toString(), ACTION_TOKEN_TTL_MINUTES);
    try {
      await deliverEmail(smtp, { to: prepared.email, ...email });
    } catch (error) {
      const deliveryStatus = isDefinitiveMailRejection(error) ? 'failed' : 'unknown';
      try {
        const changed = await updateDeliveryStatus(prepared.invitationId, deliveryStatus);
        if (!changed) return { ...prepared, token: undefined, status: 'delivery_not_current' };
        return { ...prepared, token: undefined, status: deliveryStatus === 'failed' ? 'delivery_failed' : 'delivery_status_unknown' };
      } catch {
        return { ...prepared, token: undefined, status: 'delivery_status_unknown' };
      }
    }
    try {
      const changed = await updateDeliveryStatus(prepared.invitationId, 'sent');
      if (!changed) return { ...prepared, token: undefined, status: 'delivery_not_current' };
      return { ...prepared, token: undefined, status: 'sent' };
    } catch {
      // The message may have arrived; don't tell the administrator it failed.
      return { ...prepared, token: undefined, status: 'delivery_status_unknown' };
    }
  }

  function startPreparedDelivery(prepared) {
    const results = new Array(prepared.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(4, prepared.length) }, async () => {
      while (next < prepared.length) {
        const index = next;
        next += 1;
        try {
          results[index] = await deliverPreparedInvitation(prepared[index]);
        } catch {
          results[index] = { ...prepared[index], token: undefined, status: 'delivery_status_unknown' };
        }
      }
    });
    const completion = Promise.all(workers).then(() => undefined, () => {
      for (let index = 0; index < prepared.length; index += 1) {
        if (!results[index]) results[index] = { ...prepared[index], token: undefined, status: 'delivery_status_unknown' };
      }
    });
    // The bulk response may return before SMTP completes. Keep the continuation observed
    // so an unexpected worker rejection cannot become an unhandled rejection.
    completion.catch(() => {});
    return { results, completion };
  }

  async function waitForBulkDelivery(completion) {
    const timeoutMs = Number.isSafeInteger(bulkResponseWaitMs) && bulkResponseWaitMs >= 0
      ? Math.min(bulkResponseWaitMs, BULK_DELIVERY_RESPONSE_WAIT_MS)
      : BULK_DELIVERY_RESPONSE_WAIT_MS;
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([completion.then(() => undefined, () => undefined), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function issueInvitation(actorId, userIdInput) {
    const userId = normalizeTokenId(userIdInput);
    if (!userId) throw new AccountInvitationError('Account not found.', 404);
    const prepared = await prepareInvitations(actorId, [{ userId }]);
    const delivery = startPreparedDelivery(prepared);
    await delivery.completion;
    const [result] = delivery.results;
    return { status: result.status, email: result.email };
  }

  async function issueBulkInvitations(actorId, recipientsInput) {
    const prepared = await prepareInvitations(actorId, recipientsInput);
    const delivery = startPreparedDelivery(prepared);
    await waitForBulkDelivery(delivery.completion);
    return prepared.map(({ userId, email, rowNumber, studentNo }, index) => ({
      userId, email, rowNumber, studentNo,
      status: delivery.results[index]?.status || 'delivery_pending'
    }));
  }

  async function revokeInvitation(actorInput, userIdInput) {
    const userId = normalizeTokenId(userIdInput);
    if (!userId) throw new AccountInvitationError('Account not found.', 404);
    return inTransaction(async (transaction) => {
      await requireAdminActor(transaction.request(), actorInput);
      const accountResult = await transaction.request().input('userId', sql.Int, userId)
        .query('SELECT id, is_active, invitation_required FROM users WHERE id = @userId FOR UPDATE');
      const account = accountResult.recordset?.[0];
      if (!account) throw new AccountInvitationError('Account not found.', 404);
      if (!(account.invitation_required === true || account.invitation_required === 1)) return 'already_accepted';
      if (!(account.is_active === true || account.is_active === 1)) return 'inactive';
      await transaction.request().input('userId', sql.Int, userId)
        .query(`UPDATE account_setup_tokens SET revoked_at = UTC_TIMESTAMP(3)
          WHERE user_id = @userId AND consumed_at IS NULL AND revoked_at IS NULL`);
      await transaction.request()
        .input('actorId', sql.Int, normalizeTokenId(actorInput))
        .input('userId', sql.Int, userId)
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@actorId, 'account.invitation_revoked', 'user', CAST(@userId AS CHAR(100)),
            '{"reason":"administrator_revoked"}')`);
      return 'revoked';
    });
  }

  async function inspectInvitation(idInput, tokenInput) {
    const invitationId = normalizeTokenId(idInput);
    const token = normalizeActionToken(tokenInput);
    if (!invitationId || !token) return null;
    const result = await execute(`SELECT invitation.email_snapshot, invitation.expires_at
      FROM account_setup_tokens AS invitation
      INNER JOIN users AS account ON account.id = invitation.user_id
      WHERE invitation.id = @invitationId AND invitation.token_hash = @tokenHash
        AND invitation.consumed_at IS NULL AND invitation.revoked_at IS NULL
        AND invitation.expires_at > UTC_TIMESTAMP(3)
        AND account.is_active = 1 AND account.invitation_required = 1
        AND account.email = invitation.email_snapshot`, (request) => request
      .input('invitationId', sql.Int, invitationId)
      .input('tokenHash', sql.Char(64), hashActionToken(token))
      );
    const invitation = result.recordset?.[0];
    return invitation ? { emailHint: maskEmail(invitation.email_snapshot), expiresAt: invitation.expires_at } : null;
  }

  async function acceptInvitation(idInput, tokenInput, passwordInput) {
    const invitationId = normalizeTokenId(idInput);
    const token = normalizeActionToken(tokenInput);
    const password = validatePassword(passwordInput);
    if (!invitationId || !token || !password) return 'invalid_request';
    if (typeof hashPassword !== 'function') throw new TypeError('A password hash function is required.');
    const tokenHash = hashActionToken(token);
    const lookup = await execute('SELECT user_id FROM account_setup_tokens WHERE id = @invitationId', (request) =>
      request.input('invitationId', sql.Int, invitationId));
    const userId = normalizeTokenId(lookup.recordset?.[0]?.user_id);
    if (!userId) return 'invalid_token';
    const available = await execute(`SELECT invitation.id FROM account_setup_tokens AS invitation
      INNER JOIN users AS account ON account.id = invitation.user_id
      WHERE invitation.id = @invitationId AND invitation.consumed_at IS NULL AND invitation.revoked_at IS NULL
        AND invitation.token_hash = @tokenHash
        AND invitation.expires_at > UTC_TIMESTAMP(3)
        AND account.is_active = 1 AND account.invitation_required = 1
        AND account.email = invitation.email_snapshot`, (request) => request
      .input('invitationId', sql.Int, invitationId)
      .input('tokenHash', sql.Char(64), tokenHash));
    if (!available.recordset?.length) return 'invalid_token';
    const passwordHash = await hashPassword(password, 12);

    return inTransaction(async (transaction) => {
      const accountResult = await transaction.request().input('userId', sql.Int, userId)
        .query(`SELECT id, email, is_active, invitation_required FROM users
          WHERE id = @userId FOR UPDATE`);
      const account = accountResult.recordset?.[0];
      const invitationResult = await transaction.request().input('invitationId', sql.Int, invitationId)
        .input('userId', sql.Int, userId)
        .query(`SELECT id, token_hash, email_snapshot,
            expires_at <= UTC_TIMESTAMP(3) AS is_expired, consumed_at, revoked_at
          FROM account_setup_tokens WHERE id = @invitationId AND user_id = @userId FOR UPDATE`);
      const invitation = invitationResult.recordset?.[0];
      if (!account || !invitation || invitation.consumed_at || invitation.revoked_at) return 'invalid_token';
      if (!(account.is_active === true || account.is_active === 1)
        || !(account.invitation_required === true || account.invitation_required === 1)) return 'invalid_token';
      if (Number(invitation.is_expired) === 1) {
        await transaction.request().input('invitationId', sql.Int, invitationId)
          .query('UPDATE account_setup_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE id = @invitationId AND revoked_at IS NULL');
        return 'expired';
      }
      if (invitation.token_hash !== tokenHash) {
        return 'invalid_token';
      }
      if (account.email !== invitation.email_snapshot) {
        await transaction.request().input('invitationId', sql.Int, invitationId)
          .query('UPDATE account_setup_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE id = @invitationId AND revoked_at IS NULL');
        return 'invalid_token';
      }

      const updated = await transaction.request()
        .input('userId', sql.Int, userId)
        .input('passwordHash', sql.NVarChar(255), passwordHash)
        .query(`UPDATE users SET password_hash = @passwordHash, invitation_required = 0,
            email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP(3)), must_change_password = 0,
            auth_session_version = UUID(), updated_at = UTC_TIMESTAMP(3)
          WHERE id = @userId AND is_active = 1 AND invitation_required = 1`);
      if (affectedRows(updated) !== 1) return 'invalid_token';
      await transaction.request().input('invitationId', sql.Int, invitationId)
        .query('UPDATE account_setup_tokens SET consumed_at = UTC_TIMESTAMP(3) WHERE id = @invitationId AND consumed_at IS NULL');
      await transaction.request().input('userId', sql.Int, userId).input('invitationId', sql.Int, invitationId)
        .query(`UPDATE account_setup_tokens SET revoked_at = UTC_TIMESTAMP(3)
          WHERE user_id = @userId AND id <> @invitationId AND consumed_at IS NULL AND revoked_at IS NULL`);
      for (const table of ['two_factor_codes', 'password_reset_tokens', 'pending_email_changes']) {
        await transaction.request().input('userId', sql.Int, userId)
          .query(`UPDATE ${table} SET consumed_at = UTC_TIMESTAMP(3) WHERE user_id = @userId AND consumed_at IS NULL`);
      }
      await transaction.request().input('userId', sql.Int, userId)
        .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
          VALUES (@userId, 'account.invitation_accepted', 'user', CAST(@userId AS CHAR(100)),
            '{"setupCompleted":true,"sessionsInvalidated":true}')`);
      return 'accepted';
    });
  }

  return { issueInvitation, issueBulkInvitations, revokeInvitation, inspectInvitation, acceptInvitation };
}

module.exports = {
  ACTION_TOKEN_TTL_MINUTES,
  MAX_INVITATION_BATCH,
  BULK_DELIVERY_RESPONSE_WAIT_MS,
  AccountInvitationError,
  maskEmail,
  createAccountInvitationService
};
