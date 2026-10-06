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
  isDemoPasswordOnlyLoginEnabled,
  isDemoPasswordOnlyEmailAllowed,
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
const { createStudentBulkAccountsRouter, createStudentIntakeRouter, createAnnualStudentIntakeRouter,
  createAnnualConfirmationRouter } = require('./studentSetup');
const { createStudentPortalRouter } = require('./studentPortal');
const { createClassSchedulesRouter } = require('./classSchedules');
const { createStudentRecordsService } = require('../services/studentRecordsService');
const { createAcademicRecordsService } = require('../services/academicRecordsService');
const { createFinanceService } = require('../services/financeService');
const { createAnnualFinanceCasesService } = require('../services/annualFinanceCasesService');
const { createAnnualFinanceReportsService } = require('../services/annualFinanceReportsService');
const { createTeacherGradeSubmissionService } = require('../services/teacherGradeSubmissionService');
const { createGradeImportService } = require('../services/gradeImportService');
const { createAccountService } = require('../services/accountService');
const { createStudentSetupService } = require('../services/studentSetupService');
const { createAnnualEnrollmentService } = require('../services/annualEnrollmentService');
const { createAnnualFinanceService } = require('../services/annualFinanceService');
const { createPhysicalChecklistService } = require('../services/physicalChecklistService');
const { createStudentDocumentRequestService } = require('../services/studentDocumentRequestService');
const { createStudentDocumentFinanceClearanceService } = require('../services/studentDocumentFinanceClearanceService');
const { createRegistrarGradeOverviewService } = require('../services/registrarGradeOverviewService');
const { createRegistrarDashboardService } = require('../services/registrarDashboardService');
const { createFinanceDashboardService } = require('../services/financeDashboardService');
const { RegistrarDashboardError } = require('../services/registrarDashboardService');
const { createClassScheduleService } = require('../services/classScheduleService');
const { createPreEnrollmentService } = require('../services/preEnrollmentService');
const { createPreEnrollmentRouter } = require('./preEnrollments');
const { createReadmissionRouter } = require('./readmissions');
const { createReadmissionService } = require('../services/readmissionService');
const { createAccountRouter, createEmailConfirmationRouter } = require('./account');

const credentialError = 'Invalid email or password.';
// Fixed cost-12 hash for timing equalization; no account uses its discarded random source value.
const DUMMY_PASSWORD_HASH = '$2b$12$2GN3Hm/rogpWV12Ve9rA..0pPmX1b0nzDXo16QFiqYwSNc/bRiMb2';
const dashboardViews = {
  database_admin: { path: '/admin', view: 'dashboards/database-admin', title: 'Admin overview' },
  registrar: { path: '/registrar', view: 'dashboards/registrar', title: 'Registrar workspace' },
  front_desk: { path: '/front-desk', title: 'Pre-enrollment records' },
  teacher: { path: '/teacher', view: 'dashboards/teacher', title: 'My classes' },
  finance: { path: '/finance/overview', title: 'Finance overview' },
  student: { path: '/student', view: 'dashboards/student', title: 'My school day' }
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

function createRouter({ getPool = defaultGetPool, sql = defaultSql, environment = defaultEnvironment, twoFactorService = twoFactor, accountService, adminService, studentRecordsService, academicRecordsService, gradeImportService, teacherGradeSubmissionService, financeService, annualFinanceService, financeCasesService, financeReportsService, financeDashboardService, financeReviewActionService, registrarDashboardService, annualEnrollmentService, preEnrollmentService, studentSetupService, classScheduleService, documentService, documentProcessingService, form137ScanService, physicalChecklistService, documentRequestService, documentClearanceService, gradeOverviewService, readmissionService } = {}) {
  const router = express.Router();
  const authRouter = express.Router();
  const requireAuth = createRequireAuth({ getPool, sql, environment });
  const recordsService = studentRecordsService || createStudentRecordsService({ getPool, sql });
  const academicsService = academicRecordsService || createAcademicRecordsService({ getPool, sql });
  const gradeImports = gradeImportService || createGradeImportService({ getPool, sql });
  const teacherSubmissions = teacherGradeSubmissionService || createTeacherGradeSubmissionService({ getPool, sql, storageDirectory: environment.upload?.storageDirectory });
  const financesService = financeService || createFinanceService({ getPool, sql });
  const annualFinancesService = annualFinanceService || createAnnualFinanceService({ getPool, sql });
  const annualFinanceCases = financeCasesService || createAnnualFinanceCasesService({ getPool, sql });
  const annualFinanceReports = financeReportsService || createAnnualFinanceReportsService({ getPool, sql });
  const financeDashboard = financeDashboardService || createFinanceDashboardService({ getPool, sql });
  const physicalChecklistsService = physicalChecklistService || createPhysicalChecklistService({ getPool, sql });
  const annualEnrollmentsService = annualEnrollmentService || createAnnualEnrollmentService({
    getPool, sql, physicalChecklistService: physicalChecklistsService, annualFinanceService: annualFinancesService
  });
  const preEnrollmentsService = preEnrollmentService || createPreEnrollmentService({ getPool, sql });
  const readmissionsService = readmissionService || createReadmissionService({ getPool, sql });
  const studentDocumentRequests = documentRequestService || createStudentDocumentRequestService({ getPool, sql });
  const studentDocumentClearance = documentClearanceService || createStudentDocumentFinanceClearanceService({ getPool, sql });
  const registrarGradeOverview = gradeOverviewService || createRegistrarGradeOverviewService({ getPool, sql });
  const registrarDashboard = registrarDashboardService || createRegistrarDashboardService({ getPool, sql });
  const studentSetup = studentSetupService || createStudentSetupService({ getPool, sql });
  const schedulesService = classScheduleService || createClassScheduleService({ getPool, sql });
  const accountsService = accountService || createAccountService({ getPool, sql, smtp: environment.smtp, appBaseUrl: environment.appBaseUrl });
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skip: () => isDevelopmentPasswordLoginEnabled(environment),
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
  const passwordResetRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(200).render('auth/forgot-password', {
      title: 'Forgot Password', csrfToken: ensureCsrfToken(req),
      notice: 'If the account is active, password reset instructions will be sent shortly.', error: null
    })
  });
  const passwordResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(400).render('auth/password-reset', {
      title: 'Reset Password', csrfToken: ensureCsrfToken(req), requestId: '', token: '', error: 'This reset link is invalid or has expired.'
    })
  });

  const loginNotices = {
    passwordChanged: 'Your password was changed. Sign in with the new password.',
    passwordReset: 'Your password was reset. Sign in with the new password.',
    emailChanged: 'Your sign-in and verification email was changed. Sign in with the new address.'
  };
  const renderLogin = (req, res, error, status = 200) => res.status(status).render('auth/login', {
    title: 'Login',
    csrfToken: ensureCsrfToken(req),
    developmentPasswordLoginEnabled: isDevelopmentPasswordLoginEnabled(environment),
    demoPasswordOnlyLoginEnabled: isDemoPasswordOnlyLoginEnabled(environment),
    twoFactorRequired: !isDevelopmentPasswordLoginEnabled(environment) && !isDemoPasswordOnlyLoginEnabled(environment),
    notice: loginNotices[req.query.notice] || null,
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

  router.use('/admin/student-accounts', requireAuth, requireRole('database_admin'), createStudentBulkAccountsRouter({ getPool, sql, studentSetupService: studentSetup }));
  router.use('/registrar/intake', requireAuth, requireRole('registrar', 'database_admin'), createAnnualConfirmationRouter({
    getPool, sql, annualEnrollmentService: annualEnrollmentsService, annualFinanceService: annualFinancesService
  }));
  router.use('/registrar/intake', requireAuth, requireRole('registrar'), createAnnualStudentIntakeRouter({
    getPool, sql, annualEnrollmentService: annualEnrollmentsService,
    annualFinanceService: annualFinancesService, physicalChecklistService: physicalChecklistsService,
    preEnrollmentService: preEnrollmentsService
  }));
  router.use('/pre-enrollments', requireAuth, requireRole('registrar', 'front_desk', 'database_admin'),
    createPreEnrollmentRouter({ getPool, sql, preEnrollmentService: preEnrollmentsService }));
  router.use('/registrar/readmissions', requireAuth, requireRole('registrar', 'database_admin'),
    createReadmissionRouter({ getPool, sql, readmissionService: readmissionsService }));
  router.get('/front-desk', requireAuth, requireRole('front_desk'), (req, res) => res.redirect(303, '/pre-enrollments'));
  router.use('/registrar/intake/legacy', requireAuth, requireRole('registrar'), createStudentIntakeRouter({ getPool, sql, studentSetupService: studentSetup }));
  router.use('/finance', requireAuth, requireRole('finance', 'database_admin'), createFinanceRouter({ getPool, sql,
    annualFinanceService: annualFinancesService, financeCasesService: annualFinanceCases,
    financeReportsService: annualFinanceReports, financeDashboardService: financeDashboard, financeReviewActionService,
    documentClearanceService: studentDocumentClearance, sessionSecret: environment.sessionSecret }));
  router.use('/admin', requireAuth, requireRole('database_admin'), createAdminRouter({ getPool, sql, adminService }));
  router.use('/registrar/records', requireAuth, requireRole('registrar', 'database_admin'), createStudentRecordsRouter({ getPool, sql, studentRecordsService: recordsService, academicRecordsService: academicsService, documentRequestService: studentDocumentRequests, documentClearanceService: studentDocumentClearance, gradeOverviewService: registrarGradeOverview, readmissionService: readmissionsService }));
  router.use('/registrar/records', requireAuth, requireRole('registrar', 'database_admin'), createAcademicRecordsRouter({ getPool, sql, academicRecordsService: academicsService, gradeImportService: gradeImports, teacherGradeSubmissionService: teacherSubmissions }));
  router.use('/registrar/schedules', requireAuth, requireRole('registrar'), createClassSchedulesRouter({ getPool, sql, classScheduleService: schedulesService }));
  router.use('/student', requireAuth, requireRole('student'), createStudentPortalRouter({ getPool, sql, studentRecordsService: recordsService, academicRecordsService: academicsService, financeService: financesService, annualFinanceService: annualFinancesService, classScheduleService: schedulesService }));
  router.use('/teacher/grades', requireAuth, requireRole('teacher'), createTeacherGradeSubmissionRouter({ getPool, sql, gradeImportService: gradeImports, teacherGradeSubmissionService: teacherSubmissions }));
  router.use('/registrar/grade-submissions', requireAuth, requireRole('registrar'), createRegistrarGradeSubmissionRouter({ getPool, sql, gradeImportService: gradeImports, teacherGradeSubmissionService: teacherSubmissions }));
  router.use('/documents', requireAuth, requireRole('database_admin', 'registrar', 'teacher', 'finance', 'student'), createDocumentsRouter({ getPool, sql, environment, documentService, documentProcessingService, form137ScanService, physicalChecklistService: physicalChecklistsService }));
  router.use('/account/email/confirm', createEmailConfirmationRouter({ accountService: accountsService }));
  router.use(authRouter);
  router.use('/account', requireAuth, createAccountRouter({ accountService: accountsService, environment }));

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

  authRouter.get('/login', (req, res) => {
    return renderLogin(req, res, null);
  });

  authRouter.get('/password/forgot', (req, res) => res.render('auth/forgot-password', {
    title: 'Forgot Password', csrfToken: ensureCsrfToken(req), notice: null, error: null
  }));

  authRouter.post('/password/forgot', passwordResetRequestLimiter, async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    queueMicrotask(() => {
      void accountsService.requestPasswordReset(email).catch(() => {
        // Keep delivery and database failures out of the unauthenticated response.
      });
    });
    return res.status(200).render('auth/forgot-password', {
      title: 'Forgot Password', csrfToken: ensureCsrfToken(req),
      notice: 'If the account is active, password reset instructions will be sent shortly.', error: null
    });
  });

  authRouter.get('/password/reset', async (req, res) => {
    try {
      const valid = await accountsService.inspectPasswordReset(req.query.requestId, req.query.token);
      if (!valid) return res.status(400).set('Referrer-Policy', 'no-referrer').set('Cache-Control', 'no-store').render('auth/password-reset', {
        title: 'Reset Password', csrfToken: ensureCsrfToken(req), requestId: '', token: '', error: 'This reset link is invalid or has expired.'
      });
      return res.set('Referrer-Policy', 'no-referrer').set('Cache-Control', 'no-store').render('auth/password-reset', {
        title: 'Reset Password', csrfToken: ensureCsrfToken(req), requestId: req.query.requestId, token: req.query.token, error: null
      });
    } catch {
      return res.status(503).render('error', { title: 'Reset Unavailable', message: 'The password reset link could not be checked.' });
    }
  });

  authRouter.post('/password/reset', passwordResetLimiter, async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password !== req.body?.confirmPassword) return res.status(400).render('auth/password-reset', {
      title: 'Reset Password', csrfToken: ensureCsrfToken(req), requestId: req.body?.requestId || '', token: req.body?.token || '', error: 'The new passwords do not match.'
    });
    try {
      const result = await accountsService.resetPasswordWithToken(req.body?.requestId, req.body?.token, password);
      if (result === 'reset') return res.redirect(303, '/login?notice=passwordReset');
      const error = result === 'invalid_request'
        ? 'Password must contain 12 to 72 UTF-8 bytes, and the reset link must be valid.'
        : 'This reset link is invalid or has expired.';
      return res.status(400).render('auth/password-reset', {
        title: 'Reset Password', csrfToken: ensureCsrfToken(req), requestId: req.body?.requestId || '', token: req.body?.token || '', error
      });
    } catch {
      return res.status(503).render('error', { title: 'Reset Unavailable', message: 'The password could not be reset.' });
    }
  });

  authRouter.post('/login', loginLimiter, async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }

    const credentials = normalizeCredentials(req.body);
    if (!credentials) {
      return renderLogin(req, res, credentialError, 401);
    }

    const developmentLogin = isDevelopmentPasswordLoginEnabled(environment);
    const demoPasswordLoginCandidate = isDemoPasswordOnlyEmailAllowed(environment, credentials.email);
    if (!developmentLogin && !demoPasswordLoginCandidate && !smtpReady()) {
      return res.status(503).render('error', {
        title: 'Login Unavailable',
        message: 'Sign in is temporarily unavailable.'
      });
    }

    try {
      const pool = await getPool();
      const result = await pool.request()
        .input('email', sql.NVarChar(255), credentials.email)
        .query("SELECT id, email, password_hash, role, is_active, must_change_password, auth_session_version, DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%f') AS updated_at_fingerprint FROM users WHERE email = @email");
      const user = result.recordset?.[0];
      const passwordMatches = await verifyPassword(user, credentials.password);

      if (!passwordMatches) {
        return renderLogin(req, res, credentialError, 401);
      }

      const mustChangePassword = user.must_change_password === true || user.must_change_password === 1;
      const passwordOnlyLogin = developmentLogin && !mustChangePassword;
      const demoPasswordOnlyLogin = isDemoPasswordOnlyEmailAllowed(environment, user.email);
      if (!passwordOnlyLogin && !demoPasswordOnlyLogin && !smtpReady()) {
        return res.status(503).render('error', {
          title: 'Login Unavailable',
          message: 'Sign in is temporarily unavailable.'
        });
      }

      if (passwordOnlyLogin || demoPasswordOnlyLogin) {
        await regenerateSession(req);
        req.session.userId = user.id;
        req.session.authLevel = demoPasswordOnlyLogin ? 'password_only_demo' : 'password_only_dev';
        req.session.authFingerprint = createAuthFingerprint(user, environment);
        req.session.authSessionVersion = user.auth_session_version || '';
        await saveSession(req);
        return res.redirect(303, dashboardViews[user.role].path);
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
      req.session.pendingAuthSessionVersion = user.auth_session_version || '';
      req.session.cookie.maxAge = twoFactorService.OTP_TTL_MINUTES * 60 * 1000;
      await saveSession(req);
      return res.redirect(303, '/login/verify');
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Authentication is temporarily unavailable.' });
    }
  });

  authRouter.get('/login/verify', async (req, res) => {
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
      if ((req.session.pendingAuthSessionVersion || '') !== (user.auth_session_version || '')) {
        return resetSessionAndRespond(req, res, () => renderLogin(req, res, credentialError, 401));
      }
      return renderVerification(req, res);
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Authentication is temporarily unavailable.' });
    }
  });

  authRouter.post('/login/verify', otpLimiter, async (req, res) => {
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
      if ((req.session.pendingAuthSessionVersion || '') !== (user.auth_session_version || '')) {
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
      req.session.authSessionVersion = user.auth_session_version || '';
      await saveSession(req);
      return res.redirect(303, dashboardViews[user.role].path);
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Authentication is temporarily unavailable.' });
    }
  });

  authRouter.post('/login/verify/resend', otpLimiter, async (req, res) => {
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
      if ((req.session.pendingAuthSessionVersion || '') !== (user.auth_session_version || '')) {
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

  authRouter.post('/logout', (req, res) => {
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

  authRouter.post('/login/verify/cancel', (req, res) => {
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

  const legacyDashboardPaths = {
    '/dashboard/database-admin': ['database_admin', '/admin'],
    '/dashboard/registrar': ['registrar', '/registrar'],
    '/dashboard/front-desk': ['front_desk', '/front-desk'],
    '/dashboard/teacher': ['teacher', '/teacher'],
    '/dashboard/finance': ['finance', '/finance'],
    '/dashboard/student': ['student', '/student']
  };
  for (const [legacyPath, [role, destination]] of Object.entries(legacyDashboardPaths)) {
    router.get(legacyPath, requireAuth, requireRole(role), (req, res) => res.redirect(303, destination));
  }

  router.get('/teacher', requireAuth, requireRole('teacher'), async (req, res) => {
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

  router.get('/registrar', requireAuth, requireRole('registrar'), async (req, res) => {
    try {
      const overview = await registrarDashboard.getDashboard(req.authUser.id, req.query);
      return res.status(200).set('Cache-Control', 'private, no-store').render('dashboards/registrar', {
        title: dashboardViews.registrar.title,
        csrfToken: ensureCsrfToken(req),
        overview
      });
    } catch (error) {
      if (error instanceof RegistrarDashboardError) {
        return res.status(error.status).render('error', { title: 'Registrar overview', message: error.message });
      }
      return res.status(503).render('error', {
        title: 'Service Unavailable', message: 'The registrar dashboard is temporarily unavailable.'
      });
    }
  });

  for (const [role, dashboard] of Object.entries(dashboardViews)) {
    if (role === 'database_admin' || role === 'finance' || role === 'student' || role === 'teacher' || role === 'registrar' || role === 'front_desk') continue;
    router.get(dashboard.path, requireAuth, requireRole(role), async (req, res) => {
      try {
        return res.render(dashboard.view, {
          title: dashboard.title,
          csrfToken: ensureCsrfToken(req)
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
