const crypto = require('node:crypto');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const defaultEnvironment = require('../config/environment');
const { buildNavigation } = require('./navigation');

function isDevelopmentPasswordLoginEnabled(environment = defaultEnvironment) {
  return environment.nodeEnv === 'development' && environment.devPasswordOnlyLogin === true;
}

function isDemoPasswordOnlyLoginEnabled(environment = defaultEnvironment) {
  const emails = environment.demoPasswordOnlyEmails;
  return environment.nodeEnv === 'production'
    && environment.demoPasswordOnlyLogin === true
    && Array.isArray(emails)
    && emails.length > 0
    && emails.every((email) => typeof email === 'string'
      && email.length <= 255
      && email === email.trim().toLowerCase()
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

function isDemoPasswordOnlyEmailAllowed(environment, email) {
  if (!isDemoPasswordOnlyLoginEnabled(environment) || typeof email !== 'string') return false;
  return environment.demoPasswordOnlyEmails.includes(email.trim().toLowerCase());
}

function createCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = createCsrfToken();
  return req.session.csrfToken;
}

function hasValidCsrfToken(req) {
  const expected = req.session?.csrfToken;
  const supplied = req.body?._csrf;
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;

  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

function createAuthFingerprint(user, environment = defaultEnvironment) {
  if (!user || typeof user.role !== 'string' || typeof user.password_hash !== 'string' || !user.password_hash) return null;
  const updatedAt = typeof user.updated_at_fingerprint === 'string' ? user.updated_at_fingerprint : '';
  return crypto.createHmac('sha256', environment.sessionSecret)
    .update(`${user.role}\u0000${user.password_hash}\u0000${updatedAt}`)
    .digest('hex');
}

function hasMatchingAuthFingerprint(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

function createPageSessionBinding(sessionId, sessionVersion, userId, secret) {
  if (typeof sessionId !== 'string' || !sessionId || typeof sessionVersion !== 'string'
    || !sessionVersion || !Number.isSafeInteger(userId) || userId < 1
    || typeof secret !== 'string' || !secret) return null;
  return crypto.createHmac('sha256', secret)
    .update(`page-session\u0000${sessionId}\u0000${sessionVersion}\u0000${userId}`)
    .digest('hex');
}

function hasMatchingPageSessionBinding(expected, actual) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)
    || typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) return false;
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  return expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

function clearSessionCookie(res, environment = defaultEnvironment) {
  res.clearCookie('connect.sid', {
    httpOnly: true,
    sameSite: 'lax',
    secure: environment.nodeEnv === 'production',
    path: '/'
  });
}

function destroySession(req, res, environment, callback) {
  req.session.destroy((error) => {
    clearSessionCookie(res, environment);
    callback(error);
  });
}

function createRequireAuth({ getPool = defaultGetPool, sql = defaultSql, environment = defaultEnvironment } = {}) {
  return async function requireAuth(req, res, next) {
    const requestPath = typeof req.path === 'string' ? req.path : req.originalUrl.split('?', 1)[0];
    const normalizedPath = requestPath.toLowerCase().replace(/\/+$/, '') || '/';
    const sessionCheckRequest = req.method === 'GET' && normalizedPath === '/session/check';
    const historySessionEndRequest = req.method === 'POST' && normalizedPath === '/session/end-history';
    const guardedSessionRequest = sessionCheckRequest || historySessionEndRequest;
    const deny = () => sessionCheckRequest
      ? res.status(401).set('Cache-Control', 'no-store').json({ valid: false })
      : historySessionEndRequest
        ? res.status(401).set('Cache-Control', 'no-store').json({ ended: true })
        : res.redirect('/login');
    const invalidateOrDeny = () => guardedSessionRequest
      ? deny()
      : destroySession(req, res, environment, deny);
    const userId = req.session?.userId;
    if (!Number.isSafeInteger(userId) || userId < 1) return deny();

    const developmentLogin = req.session.authLevel === 'password_only_dev';
    const demoPasswordLogin = req.session.authLevel === 'password_only_demo';
    const emailTwoFactorLogin = req.session.authLevel === 'email_2fa';
    if (developmentLogin && !isDevelopmentPasswordLoginEnabled(environment)) {
      return invalidateOrDeny();
    }
    if (demoPasswordLogin && !isDemoPasswordOnlyLoginEnabled(environment)) {
      return invalidateOrDeny();
    }
    if (!developmentLogin && !demoPasswordLogin && !emailTwoFactorLogin) return deny();

    try {
      const pool = await getPool();
      const result = await pool.request()
        .input('userId', sql.Int, userId)
        .query("SELECT id, email, role, is_active, invitation_required, password_hash, must_change_password, auth_session_version, DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%f') AS updated_at_fingerprint FROM users WHERE id = @userId");
      const user = result.recordset?.[0];

      if (!user || !(user.is_active === true || user.is_active === 1)
        || user.invitation_required === true || user.invitation_required === 1) {
        return invalidateOrDeny();
      }
      if (demoPasswordLogin && !isDemoPasswordOnlyEmailAllowed(environment, user.email)) {
        return invalidateOrDeny();
      }

      const expectedFingerprint = createAuthFingerprint(user, environment);
      if (!hasMatchingAuthFingerprint(expectedFingerprint, req.session.authFingerprint)) {
        return invalidateOrDeny();
      }
      if ((req.session.authSessionVersion || '') !== (user.auth_session_version || '')) {
        return invalidateOrDeny();
      }

      const mustChangePassword = user.must_change_password === true || user.must_change_password === 1;
      if (mustChangePassword && developmentLogin) {
        return invalidateOrDeny();
      }
      const passwordChangePath = requestPath === '/account/password/required'
        || (requestPath === '/account/password' && req.method === 'POST');
      const logoutPath = requestPath === '/logout' && req.method === 'POST';
      if (mustChangePassword && !passwordChangePath && !logoutPath && !guardedSessionRequest) {
        return res.redirect(303, '/account/password/required');
      }

      req.authUser = { id: user.id, email: user.email, role: user.role, mustChangePassword };
      res.set('Cache-Control', 'private, no-store');
      res.locals.pageSessionBinding = createPageSessionBinding(req.sessionID, req.session.authSessionVersion, user.id, environment.sessionSecret);
      const navigation = buildNavigation(req.authUser.role, req.originalUrl);
      res.locals.currentUser = req.authUser;
      res.locals.currentPath = req.originalUrl.split('?', 1)[0];
      res.locals.navigationItems = navigation.items;
      res.locals.navigationGroups = navigation.groups;
      res.locals.currentPage = navigation.currentPage;
      if (!guardedSessionRequest) res.locals.csrfToken = ensureCsrfToken(req);
      const workspaceHomes = { database_admin: '/admin', registrar: '/registrar', front_desk: '/front-desk', teacher: '/teacher', finance: '/finance', student: '/student' };
      res.locals.errorRecovery = { href: workspaceHomes[req.authUser.role] || '/', label: 'Return to your workspace' };
      return next();
    } catch {
      if (sessionCheckRequest) return res.status(503).set('Cache-Control', 'no-store').json({ valid: false, unavailable: true });
      if (historySessionEndRequest) return res.status(503).set('Cache-Control', 'no-store').json({ unavailable: true });
      return res.status(503).render('error', {
        title: 'Service Unavailable',
        message: 'Authentication is temporarily unavailable.'
      });
    }
  };
}

module.exports = {
  ensureCsrfToken,
  hasValidCsrfToken,
  createAuthFingerprint,
  hasMatchingAuthFingerprint,
  createPageSessionBinding,
  hasMatchingPageSessionBinding,
  isDevelopmentPasswordLoginEnabled,
  isDemoPasswordOnlyLoginEnabled,
  isDemoPasswordOnlyEmailAllowed,
  createRequireAuth,
  destroySession,
  clearSessionCookie
};
