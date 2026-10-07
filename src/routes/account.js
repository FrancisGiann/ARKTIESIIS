const express = require('express');
const rateLimit = require('express-rate-limit');
const { ensureCsrfToken, hasValidCsrfToken, destroySession } = require('../middleware/auth');

const accountNotices = {
  emailPending: 'A confirmation link was sent to the new address, and a security notice was sent to your current address. Your sign-in email will change only after confirmation.',
  sessionsRevoked: 'Other sessions were signed out. This session remains active.',
  passwordChanged: 'Your password was changed. Sign in again with the new password.',
  emailChanged: 'Your sign-in and verification email was changed. Sign in again with the new address.'
};

function createAccountRouter({ accountService, environment } = {}) {
  const router = express.Router();
  const mutationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });

  const renderAccount = async (req, res, { error = null, status = 200 } = {}) => {
    try {
      const account = await accountService.getAccountDetails(req.authUser.id);
      if (!account) return res.status(503).render('error', { title: 'Account Unavailable', message: 'Account details are temporarily unavailable.' });
      return res.status(status).render('account/index', {
        title: 'Account settings', account, error,
        notice: accountNotices[req.query.notice] || null,
        csrfToken: ensureCsrfToken(req)
      });
    } catch {
      return res.status(503).render('error', { title: 'Account Unavailable', message: 'Account details are temporarily unavailable.' });
    }
  };

  const csrfFailure = (req, res) => {
    if (hasValidCsrfToken(req)) return false;
    res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    return true;
  };

  async function renderRequiredPassword(req, res, { error = null, status = 200 } = {}) {
    try {
      const account = await accountService.getAccountDetails(req.authUser.id);
      if (!account) return res.status(503).render('error', { title: 'Account Unavailable', message: 'Account details are temporarily unavailable.' });
      if (!(account.must_change_password === true || account.must_change_password === 1)) return renderAccount(req, res, { error, status });
      return res.set('Cache-Control', 'private, no-store, max-age=0')
        .set('Referrer-Policy', 'no-referrer')
        .status(status)
        .render('account/password-required', { title: 'Change temporary password', csrfToken: ensureCsrfToken(req), error });
    } catch {
      return res.status(503).render('error', { title: 'Account Unavailable', message: 'The password change page is temporarily unavailable.' });
    }
  }

  const saveSession = (req) => new Promise((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
  });

  router.get('/password/required', async (req, res) => {
    return renderRequiredPassword(req, res);
  });

  router.get('/', (req, res) => renderAccount(req, res));

  router.post('/password', mutationLimiter, async (req, res) => {
    if (csrfFailure(req, res)) return;
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password !== req.body?.confirmPassword) return req.authUser.mustChangePassword
      ? renderRequiredPassword(req, res, { error: 'The new passwords do not match.', status: 400 })
      : renderAccount(req, res, { error: 'The new passwords do not match.', status: 400 });

    try {
      const result = await accountService.changePassword(req.authUser.id, req.body?.currentPassword, password);
      if (result === 'invalid_password') return req.authUser.mustChangePassword
        ? renderRequiredPassword(req, res, { error: 'Password must contain 12 to 72 UTF-8 bytes.', status: 400 })
        : renderAccount(req, res, { error: 'Password must contain 12 to 72 UTF-8 bytes.', status: 400 });
      if (result === 'invalid_current_password') return req.authUser.mustChangePassword
        ? renderRequiredPassword(req, res, { error: 'Enter your current password and try again.', status: 401 })
        : renderAccount(req, res, { error: 'Enter your current password and try again.', status: 401 });
      if (result === 'same_password') return req.authUser.mustChangePassword
        ? renderRequiredPassword(req, res, { error: 'Choose a password different from your temporary password.', status: 400 })
        : renderAccount(req, res, { error: 'Choose a password different from your current password.', status: 400 });
      if (result !== 'changed') return res.status(503).render('error', { title: 'Password Unavailable', message: 'The password could not be changed.' });

      return destroySession(req, res, environment, (error) => {
        if (error) return res.status(500).render('error', { title: 'Error', message: 'The password changed, but this session could not be cleared. Sign in again.' });
        return res.redirect(303, '/login?notice=passwordChanged');
      });
    } catch {
      return res.status(503).render('error', { title: 'Password Unavailable', message: 'The password could not be changed.' });
    }
  });

  router.post('/email/request', mutationLimiter, async (req, res) => {
    if (csrfFailure(req, res)) return;
    try {
      const result = await accountService.requestEmailChange(req.authUser.id, req.body?.currentPassword, req.body?.email);
      const errors = {
        invalid_email: 'Enter a valid email address.',
        invalid_current_password: 'Enter your current password and try again.',
        same_email: 'That is already the email address on this account.',
        email_in_use: 'That email address is already in use or has another pending change.',
        delivery_failed: 'Email change instructions could not be sent. Try again later.'
      };
      if (result === 'created') return res.redirect(303, '/account?notice=emailPending');
      if (errors[result]) return renderAccount(req, res, { error: errors[result], status: result === 'invalid_current_password' ? 401 : 400 });
      return res.status(503).render('error', { title: 'Email Change Unavailable', message: 'The email change could not be requested.' });
    } catch {
      return res.status(503).render('error', { title: 'Email Change Unavailable', message: 'The email change could not be requested.' });
    }
  });

  router.post('/sessions/revoke-others', mutationLimiter, async (req, res) => {
    if (csrfFailure(req, res)) return;
    try {
      if (!await accountService.verifyCurrentPassword(req.authUser.id, req.body?.currentPassword)) {
        return renderAccount(req, res, { error: 'Enter your current password and try again.', status: 401 });
      }
      const version = await accountService.rotateOtherSessions(req.authUser.id);
      if (typeof version !== 'string' || !version) {
        return res.status(503).render('error', { title: 'Sessions Unavailable', message: 'Other sessions could not be signed out.' });
      }
      req.session.authSessionVersion = version;
      await saveSession(req);
      return res.redirect(303, '/account?notice=sessionsRevoked');
    } catch {
      return res.status(503).render('error', { title: 'Sessions Unavailable', message: 'Other sessions could not be signed out.' });
    }
  });

  return router;
}

function createEmailConfirmationRouter({ accountService } = {}) {
  const router = express.Router();
  const pageLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const confirmationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });

  const csrfFailure = (req, res) => {
    if (hasValidCsrfToken(req)) return false;
    res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the confirmation link and try again.' });
    return true;
  };

  const setLinkSecurityHeaders = (res) => res
    .set('Referrer-Policy', 'no-referrer')
    .set('Cache-Control', 'no-store');

  router.get('/', pageLimiter, async (req, res) => {
    setLinkSecurityHeaders(res);
    try {
      const pending = await accountService.inspectEmailChange(req.query.requestId, req.query.token);
      if (!pending) return res.status(400).render('error', { title: 'Confirmation Unavailable', message: 'This email confirmation link is invalid or has expired.' });
      return res.render('account/email-confirm', {
        title: 'Confirm Email Address', email: pending.new_email,
        requestId: req.query.requestId, token: req.query.token,
        csrfToken: ensureCsrfToken(req), error: null
      });
    } catch {
      return res.status(503).render('error', { title: 'Confirmation Unavailable', message: 'This email confirmation link could not be checked.' });
    }
  });

  router.post('/', confirmationLimiter, async (req, res) => {
    setLinkSecurityHeaders(res);
    if (csrfFailure(req, res)) return;
    try {
      const result = await accountService.confirmEmailChange(req.body?.requestId, req.body?.token);
      if (result === 'changed') return res.redirect(303, '/login?notice=emailChanged');

      const message = result === 'email_in_use'
        ? 'That email address is no longer available. Request a new change from your account page.'
        : 'This email confirmation link is invalid, expired, or no longer available. Request a new change from your account page.';
      return res.status(400).render('account/email-confirm', {
        title: 'Confirm Email Address', email: '', requestId: '', token: '',
        csrfToken: ensureCsrfToken(req), error: message
      });
    } catch {
      return res.status(503).render('error', { title: 'Confirmation Unavailable', message: 'The email change could not be confirmed.' });
    }
  });

  return router;
}

module.exports = { createAccountRouter, createEmailConfirmationRouter, accountNotices };
