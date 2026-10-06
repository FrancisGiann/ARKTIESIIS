const path = require('node:path');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const env = require('./config/environment');
const { getPool } = require('./config/database');
const { createRouter } = require('./routes');
const { errorHandler } = require('./middleware/errorHandler');
const { formatMoney } = require('./utils/formatMoney');
const { formatStudentPlacement } = require('./utils/formatStudentPlacement');

const projectRoot = path.resolve(__dirname, '..');

function createApp({ databasePool = getPool, environment = env, twoFactorService, accountService, adminService, studentRecordsService, academicRecordsService, gradeImportService, teacherGradeSubmissionService, financeService, annualFinanceService, financeCasesService, financeReportsService, financeDashboardService, financeReviewActionService, registrarDashboardService, annualEnrollmentService, preEnrollmentService, studentSetupService, classScheduleService, documentService, documentProcessingService, form137ScanService, physicalChecklistService, documentRequestService, documentClearanceService, gradeOverviewService, readmissionService, termClearanceService } = {}) {
  const app = express();
  const stylesheetPath = path.join(projectRoot, 'public', 'css', 'app.css');
  app.locals.formatMoney = formatMoney;
  app.locals.formatStudentPlacement = formatStudentPlacement;
  app.locals.assetVersion = createHash('sha256').update(readFileSync(stylesheetPath)).digest('hex').slice(0, 16);

  if (environment.nodeEnv === 'production') app.set('trust proxy', 1);

  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));

  app.use(helmet());
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 500 }));
  app.use(express.urlencoded({ extended: false, parameterLimit: 1200, limit: '300kb' }));
  app.use(express.json());
  app.use(express.static(path.join(projectRoot, 'public')));

  app.use(session({
    secret: environment.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: environment.nodeEnv === 'production',
      maxAge: 8 * 60 * 60 * 1000
    }
  }));

  app.use(createRouter({ getPool: databasePool, environment, twoFactorService, accountService, adminService, studentRecordsService, academicRecordsService, gradeImportService, teacherGradeSubmissionService, financeService, annualFinanceService, financeCasesService, financeReportsService, financeDashboardService, financeReviewActionService, registrarDashboardService, annualEnrollmentService, preEnrollmentService, studentSetupService, classScheduleService, documentService, documentProcessingService, form137ScanService, physicalChecklistService, documentRequestService, documentClearanceService, gradeOverviewService, readmissionService, termClearanceService }));

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Not Found',
      message: 'Page not found.',
        errorRecovery: res.locals.currentUser
        ? { href: ({ database_admin: '/admin', registrar: '/registrar', front_desk: '/front-desk', teacher: '/teacher', finance: '/finance/overview', student: '/student' })[res.locals.currentUser.role] || '/', label: 'Return to your workspace' }
        : { href: '/', label: 'Return to home' }
    });
  });

  app.use(errorHandler);

  return app;
}

module.exports = createApp();
module.exports.createApp = createApp;
