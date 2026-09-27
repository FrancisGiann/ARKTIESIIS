const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');
const defaultEnvironment = require('../config/environment');
const twoFactor = require('../services/twoFactorService');
const {
  ensureCsrfToken,
  hasValidCsrfToken,
  createAuthFingerprint,
  hasMatchingAuthFingerprint,
  isDevelopmentPasswordLoginEnabled,
  createRequireAuth,
  destroySession
} = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { createAdminRouter } = require('./admin');
const { createStudentRecordsRouter } = require('./studentRecords');
const { createAcademicRecordsRouter } = require('./academicRecords');
const { createFinanceRouter } = require('./finance');
const { createTeacherGradeSubmissionRouter, createRegistrarGradeSubmissionRouter } = require('./teacherGradeSubmissions');
const { createDocumentsRouter } = require('./documents');
const { createStudentRecordsService } = require('../services/studentRecordsService');
const { createAcademicRecordsService } = require('../services/academicRecordsService');
const { createFinanceService } = require('../services/financeService');
const { createTeacherGradeSubmissionService } = require('../services/teacherGradeSubmissionService');
const { createGradeImportService } = require('../services/gradeImportService');

const credentialError = 'Invalid email or password.';
// Fixed cost-12 hash for timing equalization; no account uses its discarded random source value.
const DUMMY_PASSWORD_HASH = '$2b$12$2GN3Hm/rogpWV12Ve9rA..0pPmX1b0nzDXo16QFiqYwSNc/bRiMb2';
const dashboardViews = {
  database_admin: { path: '/admin', view: 'dashboards/database-admin', title: 'Database Admin Dashboard' },
  registrar: { path: '/dashboard/registrar', view: 'dashboards/registrar', title: 'Registrar Dashboard' },
  teacher: { path: '/dashboard/teacher', view: 'dashboards/teacher', title: 'Teacher Dashboard' },
  finance: { path: '/finance', title: 'Finance Workspace' },
  student: { path: '/dashboard/student', view: 'dashboards/student', title: 'Student Dashboard' }
};

function normalizeCredentials(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (!password || Buffer.byteLength(password, 'utf8') > 72) return null;
  return { email, password };
}

async function verifyPassword(user, password, comparePassword = bcrypt.compare) {
  const active = user && (user.is_active === true || user.is_active === 1);
  const candidateHash = active ? user.password_hash : DUMMY_PASSWORD_HASH;
  const passwordMatches = await comparePassword(password, candidateHash);
  return Boolean(active && passwordMatches);
}

function createRouter({ getPool = defaultGetPool, sql = defaultSql, environment = defaultEnvironment, twoFactorService = twoFactor, adminService, studentRecordsService, academicRecordsService, gradeImportService, teacherGradeSubmissionService, financeService, documentService, documentProcessingService, form137ScanService } = {}) {
  const router = express.Router();
  const requireAuth = createRequireAuth({ getPool, sql, environment });
  const recordsService = studentRecordsService || createStudentRecordsService({ getPool, sql });
  const academicsService = academicRecordsService || createAcademicRecordsService({ getPool, sql });
  const gradeImports = gradeImportService || createGradeImportService({ getPool, sql });
  const teacherSubmissions = teacherGradeSubmissionService || createTeacherGradeSubmissionService({ getPool, sql, storageDirectory: environment.upload?.storageDirectory });
  const financesService = financeService || createFinanceService({ getPool, sql });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).render('error', {
      title: 'Too Many Attempts',
      message: 'Too many login attempts. Try again later.'
    })
  });
  const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).render('error', {
      title: 'Too Many Attempts',
      message: 'Too many verification attempts. Try again later.'
    })
  });

  const renderLogin = (req, res, error, status = 200) => res.status(status).render('auth/login', {
    title: 'Login',
    csrfToken: ensureCsrfToken(req),
    twoFactorRequired: !isDevelopmentPasswordLoginEnabled(environment),
    error
  });
  const renderVerification = (req, res, error = null, status = 200) => res.status(status).render('auth/verify', {
    title: 'Verify Sign In',
    csrfToken: ensureCsrfToken(req),
    error
  });
  const regenerateSession = (req) => new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
  const saveSession = (req) => new Promise((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
  });
  const resetSessionAndRespond = (req, res, callback) => regenerateSession(req)
    .then(callback)
    .catch(() => res.status(500).render('error', { title: 'Error', message: 'Authentication could not be completed.' }));
  const smtpReady = () => Boolean(environment.smtp?.host && environment.smtp?.from
    && (!environment.smtp.user && !environment.smtp.pass || environment.smtp.user && environment.smtp.pass));
  const sendChallenge = async (user) => {
    const challenge = await twoFactorService.issueOtpChallenge({ getPool, sql, userId: user.id });
    if (!challenge.allowed) return { allowed: false };

    try {
      await twoFactorService.sendOtpEmail(environment.smtp, user.email, challenge.code);
    } catch {
      try {
        await twoFactorService.invalidateOtpChallenge({ getPool, sql, userId: user.id, codeId: challenge.codeId });
      } catch {
        // The pending session is also discarded, so a failed delivery cannot authenticate.
      }
      return { allowed: false, deliveryFailed: true };
    }
    return { allowed: true, codeId: challenge.codeId };
  };

  router.use('/finance', requireAuth, requireRole('finance', 'database_admin'), createFinanceRouter({ getPool, sql, financeService: financesService }));
  router.use('/admin', requireAuth, requireRole('database_admin'), createAdminRouter({ getPool, sql, adminService }));
  router.use('/records', requireAuth, requireRole('database_admin', 'registrar'), createStudentRecordsRouter({ getPool, sql, studentRecordsService: recordsService }));
  router.use('/records', requireAuth, requireRole('database_admin', 'registrar'), createAcademicRecordsRouter({ getPool, sql, academicRecordsService: academicsService, gradeImportService: gradeImports, teacherGradeSubmissionService: teacherSubmissions }));
  router.use('/teacher/grades', requireAuth, requireRole('teacher'), createTeacherGradeSubmissionRouter({ getPool, sql, gradeImportService: gradeImports, teacherGradeSubmissionService: teacherSubmissions }));
  router.use('/registrar/grade-submissions', requireAuth, requireRole('registrar'), createRegistrarGradeSubmissionRouter({ getPool, sql, gradeImportService: gradeImports, teacherGradeSubmissionService: teacherSubmissions }));
  router.use('/documents', requireAuth, createDocumentsRouter({ getPool, sql, environment, documentService, documentProcessingService, form137ScanService }));

  router.get('/', (req, res) => {
    res.render('home', { title: 'ARKTIESIIS' });
  });

  router.get('/health', async (req, res) => {
    try {
      const pool = await getPool();
      await pool.request().query('SELECT 1 AS ok');
      res.json({ ok: true, database: 'connected' });
    } catch {
      res.status(503).json({ ok: false, database: 'disconnected' });
    }
  });

  router.get('/login', (req, res) => {
    return renderLogin(req, res, null);
  });

  router.post('/login', loginLimiter, async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }

    const credentials = normalizeCredentials(req.body);
    if (!credentials) {
      return renderLogin(req, res, credentialError, 401);
    }

    const developmentLogin = isDevelopmentPasswordLoginEnabled(environment);
    if (!developmentLogin && !smtpReady()) {
      return res.status(503).render('error', {
        title: 'Login Unavailable',
        message: 'Sign in is temporarily unavailable.'
      });
    }

    try {
      const pool = await getPool();
      const result = await pool.request()
        .input('email', sql.NVarChar(255), credentials.email)
        .query('SELECT id, email, password_hash, role, is_active, CONVERT(NVARCHAR(33), updated_at, 126) AS updated_at_fingerprint FROM dbo.users WHERE email = @email');
      const user = result.recordset?.[0];
      const passwordMatches = await verifyPassword(user, credentials.password);

      if (!passwordMatches) {
        return renderLogin(req, res, credentialError, 401);
      }

      if (developmentLogin) {
        await regenerateSession(req);
        req.session.userId = user.id;
        req.session.authLevel = 'password_only_dev';
        req.session.authFingerprint = createAuthFingerprint(user, environment);
        await saveSession(req);
        return res.redirect(303, '/dashboard');
      }

      const challenge = await sendChallenge(user);
      if (challenge.deliveryFailed) {
        return resetSessionAndRespond(req, res, () => renderLogin(req, res, credentialError, 401));
      }
      if (!challenge.allowed) return renderLogin(req, res, 'A sign-in code cannot be sent yet. Try again later.', 429);
      await regenerateSession(req);
      req.session.pendingUserId = user.id;
      req.session.pendingOtpId = challenge.codeId;
      req.session.authLevel = 'pending_2fa';
      req.session.pendingAuthFingerprint = createAuthFingerprint(user, environment);
      req.session.cookie.maxAge = twoFactorService.OTP_TTL_MINUTES * 60 * 1000;
      await saveSession(req);
      return res.redirect(303, '/login/verify');
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Authentication is temporarily unavailable.' });
    }
  });

  router.get('/login/verify', async (req, res) => {
    const userId = req.session?.pendingUserId;
    const codeId = req.session?.pendingOtpId;
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(codeId) || codeId < 1 || req.session.authLevel !== 'pending_2fa') {
      return res.redirect('/login');
    }

    try {
      const user = await twoFactorService.getActiveUser({ getPool, sql, userId });
      if (!user || !(user.is_active === true || user.is_active === 1)) {
        return resetSessionAndRespond(req, res, () => renderLogin(req, res, credentialError, 401));
      }
      if (!hasMatchingAuthFingerprint(createAuthFingerprint(user, environment), req.session.pendingAuthFingerprint)) {
        return resetSessionAndRespond(req, res, () => renderLogin(req, res, credentialError, 401));
      }
      return renderVerification(req, res);
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Authentication is temporarily unavailable.' });
    }
  });

  router.post('/login/verify', otpLimiter, async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }

    const userId = req.session?.pendingUserId;
    const codeId = req.session?.pendingOtpId;
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(codeId) || codeId < 1 || req.session.authLevel !== 'pending_2fa') {
      return res.redirect('/login');
    }
    const code = typeof req.body?.code === 'string' && /^\d{6}$/.test(req.body.code) ? req.body.code : null;
    if (!code) return renderVerification(req, res, 'Enter the six-digit code from your email.', 401);

    try {
      const user = await twoFactorService.getActiveUser({ getPool, sql, userId });
      if (!user || !(user.is_active === true || user.is_active === 1)) {
        return resetSessionAndRespond(req, res, () => renderLogin(req, res, credentialError, 401));
      }
      if (!hasMatchingAuthFingerprint(createAuthFingerprint(user, environment), req.session.pendingAuthFingerprint)) {
        return resetSessionAndRespond(req, res, () => renderLogin(req, res, credentialError, 401));
      }

      const challenge = await twoFactorService.getOtpChallenge({ getPool, sql, userId, codeId });
      if (!challenge) return renderVerification(req, res, 'This code is invalid or has expired. Request a new code.', 401);

      const allowed = await twoFactorService.reserveOtpAttempt({ getPool, sql, userId });
      if (!allowed) return renderVerification(req, res, 'Too many code attempts. Request a new code later.', 429);

      if (!await twoFactorService.compareOtp(code, challenge.code_hash)) {
        return renderVerification(req, res, 'This code is invalid or has expired. Try again.', 401);
      }

      const consumed = await twoFactorService.consumeOtpChallenge({ getPool, sql, userId, codeId, codeHash: challenge.code_hash });
      if (!consumed) return resetSessionAndRespond(req, res, () => renderLogin(req, res, credentialError, 401));

      await regenerateSession(req);
      req.session.userId = user.id;
      req.session.authLevel = 'email_2fa';
      req.session.authFingerprint = createAuthFingerprint(user, environment);
      await saveSession(req);
      return res.redirect(303, '/dashboard');
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Authentication is temporarily unavailable.' });
    }
  });

  router.post('/login/verify/resend', otpLimiter, async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }

    const userId = req.session?.pendingUserId;
    if (!Number.isSafeInteger(userId) || userId < 1 || req.session.authLevel !== 'pending_2fa') return res.redirect('/login');

    try {
      const user = await twoFactorService.getActiveUser({ getPool, sql, userId });
      if (!user || !(user.is_active === true || user.is_active === 1)) {
        return resetSessionAndRespond(req, res, () => renderLogin(req, res, credentialError, 401));
      }
      if (!hasMatchingAuthFingerprint(createAuthFingerprint(user, environment), req.session.pendingAuthFingerprint)) {
        return resetSessionAndRespond(req, res, () => renderLogin(req, res, credentialError, 401));
      }

      const challenge = await sendChallenge(user);
      if (challenge.deliveryFailed) {
        return resetSessionAndRespond(req, res, () => res.status(503).render('error', {
          title: 'Service Unavailable',
          message: 'A sign-in code could not be sent. Sign in again later.'
        }));
      }
      if (!challenge.allowed) return renderVerification(req, res, 'Please wait before requesting another code.', 429);
      req.session.pendingOtpId = challenge.codeId;
      req.session.cookie.maxAge = twoFactorService.OTP_TTL_MINUTES * 60 * 1000;
      await saveSession(req);
      return renderVerification(req, res, 'A new code was sent to your email.');
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Authentication is temporarily unavailable.' });
    }
  });

  router.post('/logout', (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }

    destroySession(req, res, environment, (error) => {
      if (error) {
        return res.status(500).render('error', { title: 'Error', message: 'Logout could not be completed.' });
      }
      return res.redirect(303, '/login');
    });
  });

  router.post('/login/verify/cancel', (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }

    destroySession(req, res, environment, (error) => {
      if (error) {
        return res.status(500).render('error', { title: 'Error', message: 'The sign-in attempt could not be cleared.' });
      }
      return res.redirect(303, '/login');
    });
  });

  router.get('/dashboard', requireAuth, (req, res) => {
    const dashboard = dashboardViews[req.authUser.role];
    if (!dashboard) return res.status(403).send('Forbidden');
    return res.redirect(303, dashboard.path);
  });

  router.get('/dashboard/database-admin', requireAuth, requireRole('database_admin'), (req, res) => res.redirect(303, '/admin'));
  router.get('/dashboard/finance', requireAuth, requireRole('finance'), (req, res) => res.redirect(303, '/finance'));

  router.get('/dashboard/teacher', requireAuth, requireRole('teacher'), async (req, res) => {
    try {
      const assignments = await teacherSubmissions.listTeacherAssignments(req.authUser.id);
      return res.render('dashboards/teacher', {
        title: dashboardViews.teacher.title,
        csrfToken: ensureCsrfToken(req),
        assignments
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Teacher assignments are temporarily unavailable.' });
    }
  });

  router.get('/dashboard/student', requireAuth, requireRole('student'), async (req, res) => {
    try {
      const [ownRecords, summary] = await Promise.all([
        recordsService.getOwnStudentRecord(req.authUser.id),
        recordsService.getStudentDashboardSummary?.(req.authUser.id) || null
      ]);
      if (ownRecords) {
        ownRecords.grades = await academicsService.getOwnGrades(req.authUser.id);
      }
      return res.render('dashboards/student', {
        title: dashboardViews.student.title,
        csrfToken: ensureCsrfToken(req),
        ownRecords,
        summary
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Student records are temporarily unavailable.' });
    }
  });

  for (const [role, dashboard] of Object.entries(dashboardViews)) {
    if (role === 'database_admin' || role === 'finance' || role === 'student' || role === 'teacher') continue;
    router.get(dashboard.path, requireAuth, requireRole(role), async (req, res) => {
      try {
        const summary = await recordsService.getRegistrarDashboardSummary?.(req.authUser.id) || null;
        return res.render(dashboard.view, {
          title: dashboard.title,
          csrfToken: ensureCsrfToken(req),
          summary
        });
      } catch {
        return res.status(503).render('error', {
          title: 'Service Unavailable', message: 'The registrar dashboard is temporarily unavailable.'
        });
      }
    });
  }

  return router;
}

module.exports = { createRouter, normalizeCredentials, verifyPassword };
