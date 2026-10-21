'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { validatePassword } = require('../services/accountService');

function createAccountInvitationRouter({ accountInvitationService } = {}) {
  if (!accountInvitationService) throw new TypeError('An account invitation service is required.');
  const router = express.Router();
  function privateResponse(res) {
    return res.set('Cache-Control', 'no-store, private, max-age=0')
      .set('Pragma', 'no-cache')
      .set('Referrer-Policy', 'no-referrer')
      .set('X-Robots-Tag', 'noindex, nofollow');
  }

  const setupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => privateResponse(res).status(429).render('auth/account-setup', {
      title: 'Set up your account',
      error: 'Too many setup attempts. Wait before trying again.',
      requestId: '', token: '', emailHint: '', csrfToken: ensureCsrfToken(req), linkUnavailable: true
    })
  });

  function renderInvalid(req, res, status = 400, error = 'This setup link is invalid or has expired.') {
    return privateResponse(res).status(status).render('auth/account-setup', {
      title: 'Set up your account',
      error,
      requestId: '', token: '', emailHint: '', csrfToken: ensureCsrfToken(req), linkUnavailable: true
    });
  }

  router.get('/', async (req, res) => {
    privateResponse(res);
    try {
      const invitation = await accountInvitationService.inspectInvitation(req.query?.requestId, req.query?.token);
      if (!invitation) return renderInvalid(req, res);
      return res.render('auth/account-setup', {
        title: 'Set up your account', error: null,
        requestId: req.query.requestId, token: req.query.token,
        emailHint: invitation.emailHint, expiresAt: invitation.expiresAt,
        csrfToken: ensureCsrfToken(req), linkUnavailable: false
      });
    } catch {
      return privateResponse(res).status(503).render('auth/account-setup', {
        title: 'Set up your account', error: 'Account setup is temporarily unavailable. Try again shortly.',
        requestId: '', token: '', emailHint: '', csrfToken: ensureCsrfToken(req), linkUnavailable: true
      });
    }
  });

  router.post('/', setupLimiter, async (req, res) => {
    privateResponse(res);
    if (!hasValidCsrfToken(req)) {
      return renderInvalid(req, res, 403, 'The form session expired. Reload the link and try again.');
    }
    const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const confirmation = typeof req.body?.confirmPassword === 'string' ? req.body.confirmPassword : '';
    if (password !== confirmation) {
      try {
        const invitation = await accountInvitationService.inspectInvitation(requestId, token);
        if (!invitation) return renderInvalid(req, res);
        return privateResponse(res).status(400).render('auth/account-setup', {
          title: 'Set up your account', error: 'The passwords do not match.',
          requestId, token, emailHint: invitation.emailHint, expiresAt: invitation.expiresAt,
          csrfToken: ensureCsrfToken(req), linkUnavailable: false
        });
      } catch {
        return renderInvalid(req, res, 503, 'Account setup is temporarily unavailable. Try again shortly.');
      }
    }
    if (!validatePassword(password)) {
      try {
        const invitation = await accountInvitationService.inspectInvitation(requestId, token);
        if (!invitation) return renderInvalid(req, res);
        return privateResponse(res).status(400).render('auth/account-setup', {
          title: 'Set up your account',
          error: 'Use at least 12 characters. Very long or symbol-heavy passwords may exceed the 72-byte limit.',
          requestId, token, emailHint: invitation.emailHint, expiresAt: invitation.expiresAt,
          csrfToken: ensureCsrfToken(req), linkUnavailable: false
        });
      } catch {
        return renderInvalid(req, res, 503, 'Account setup is temporarily unavailable. Try again shortly.');
      }
    }
    try {
      const result = await accountInvitationService.acceptInvitation(requestId, token, password);
      if (result === 'accepted') return res.redirect(303, '/login?notice=accountSetup');
      if (result === 'invalid_request') {
        return renderInvalid(req, res, 400, 'Use a valid setup link and a password with at least 12 characters.');
      }
      return renderInvalid(req, res, 400, 'This setup link is invalid or has expired.');
    } catch {
      return renderInvalid(req, res, 503, 'Account setup is temporarily unavailable. Try again shortly.');
    }
  });

  return router;
}

module.exports = { createAccountInvitationRouter };
