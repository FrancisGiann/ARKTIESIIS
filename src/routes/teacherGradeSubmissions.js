const express = require('express');
const multer = require('multer');
const path = require('node:path');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { GradeImportError } = require('../services/gradeImportService');
const { TeacherGradeSubmissionError } = require('../services/teacherGradeSubmissionService');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

function isUploadError(error) {
  return error instanceof GradeImportError || error instanceof TeacherGradeSubmissionError;
}

function createTeacherGradeSubmissionRouter({ gradeImportService, teacherGradeSubmissionService } = {}) {
  const router = express.Router();
  const service = teacherGradeSubmissionService;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: 5 * 1024 * 1024, fields: 1, parts: 2 }
  }).single('workbook');

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  async function renderAssignment(req, res, assignmentId, { status = 200, preview = null, error = null } = {}) {
    try {
      const assignment = await service.getTeacherAssignment(req.authUser.id, assignmentId);
      const contexts = await gradeImportService.listImportContexts(req.authUser.id);
      const context = contexts.find((item) => item.school_year === assignment.school_year
        && item.grade_level === assignment.grade_level && item.section_name === assignment.section_name
        && item.subject_id === assignment.subject_id && item.academic_term_id === assignment.academic_term_id);
      return res.status(status).render('records/teacher-grade-upload', {
        title: 'Submit Class Grades', currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
        assignment, contextKey: context?.key || '', preview, error
      });
    } catch (loadError) {
      if (isUploadError(loadError)) return res.status(loadError.status).render('error', { title: loadError.status === 404 ? 'Not Found' : 'Invalid Request', message: loadError.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The assigned class could not be loaded.' });
    }
  }

  router.get('/', async (req, res) => {
    try {
      const assignments = await service.listTeacherAssignments(req.authUser.id);
      return res.render('dashboards/teacher', {
        title: 'Teacher Dashboard', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), assignments
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Teacher assignments are temporarily unavailable.' });
    }
  });

  router.get('/:assignmentId', async (req, res) => {
    return renderAssignment(req, res, req.params.assignmentId);
  });

  router.post('/:assignmentId/preview', (req, res, next) => {
    upload(req, res, (error) => {
      if (!error) return next();
      const message = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
        ? 'The XLSX workbook must be 5 MB or smaller.' : 'Choose one XLSX workbook to preview.';
      return renderAssignment(req, res, req.params.assignmentId, { status: error.status || 400, error: message });
    });
  }, async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      if (req.file?.buffer) req.file.buffer.fill(0);
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const file = req.file;
    if (!file) return renderAssignment(req, res, req.params.assignmentId, { status: 400, error: 'Choose one XLSX workbook.' });
    const filename = path.basename(file.originalname.replaceAll('\\', '/'));
    try {
      const validMime = file.mimetype === XLSX_MIME;
      const validZip = file.buffer.length >= 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
      if (path.extname(filename).toLowerCase() !== '.xlsx' || !validMime || !validZip) {
        return renderAssignment(req, res, req.params.assignmentId, { status: 400, error: 'Upload a valid .xlsx workbook with the Excel XLSX MIME type.' });
      }
      const assignment = await service.getTeacherAssignment(req.authUser.id, req.params.assignmentId);
      const contexts = await gradeImportService.listImportContexts(req.authUser.id);
      const context = contexts.find((item) => item.school_year === assignment.school_year
        && item.grade_level === assignment.grade_level && item.section_name === assignment.section_name
        && item.subject_id === assignment.subject_id && item.academic_term_id === assignment.academic_term_id);
      if (!context) return renderAssignment(req, res, req.params.assignmentId, { status: 409, error: 'This class context is not available for grade submission.' });
      const preview = await gradeImportService.createPreview({
        actorId: req.authUser.id, sessionId: req.sessionID, contextKey: context.key,
        originalFilename: filename, buffer: file.buffer
      });
      await service.stageWorkbook(req.authUser.id, req.params.assignmentId, preview.id, req.sessionID, file.buffer);
      return renderAssignment(req, res, req.params.assignmentId, { preview });
    } catch (error) {
      if (isUploadError(error)) return renderAssignment(req, res, req.params.assignmentId, { status: error.status, error: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The workbook could not be previewed.' });
    } finally {
      file.buffer.fill(0);
      req.file = undefined;
    }
  });

  router.post('/:assignmentId/submit', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const previewId = typeof req.body?.previewId === 'string' && UUID_PATTERN.test(req.body.previewId) ? req.body.previewId : null;
    if (!previewId) return renderAssignment(req, res, req.params.assignmentId, { status: 400, error: 'The workbook preview expired. Upload it again.' });
    let buffer;
    try {
      const preview = await gradeImportService.getPreview({ actorId: req.authUser.id, sessionId: req.sessionID, previewId });
      buffer = await service.getStagedWorkbook(req.authUser.id, req.params.assignmentId, previewId, req.sessionID);
      const submissionId = await service.submitPreview({
        actorId: req.authUser.id,
        assignmentId: req.params.assignmentId,
        previousSubmissionId: req.body?.previousSubmissionId || null,
        preview,
        sessionId: req.sessionID,
        buffer
      });
      await service.clearStagedWorkbook(previewId);
      return res.redirect(303, `/teacher/grades/submissions/${submissionId}`);
    } catch (error) {
      if (isUploadError(error)) return renderAssignment(req, res, req.params.assignmentId, { status: error.status, error: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The grade workbook could not be submitted.' });
    } finally {
      if (buffer) buffer.fill(0);
    }
  });

  router.get('/submissions/:submissionId', async (req, res) => {
    try {
      const submission = await service.readSubmission(req.authUser.id, req.params.submissionId, 'teacher');
      return res.render('records/teacher-grade-submission', {
        title: 'My Grade Workbook', currentUser: req.authUser, submission
      });
    } catch (error) {
      if (isUploadError(error)) return res.status(error.status).render('error', { title: error.status === 404 ? 'Not Found' : 'Invalid Request', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The grade submission could not be loaded.' });
    }
  });

  router.get('/submissions/:submissionId/workbook', async (req, res) => {
    try {
      const workbook = await service.getWorkbook(req.authUser.id, req.params.submissionId, 'teacher');
      return res.type(workbook.mimeType).download(workbook.filePath, workbook.filename);
    } catch (error) {
      if (isUploadError(error)) return res.status(error.status).render('error', { title: error.status === 404 ? 'Not Found' : 'Invalid Request', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The workbook could not be downloaded.' });
    }
  });

  return router;
}

function createRegistrarGradeSubmissionRouter({ gradeImportService, teacherGradeSubmissionService } = {}) {
  const router = express.Router();
  const service = teacherGradeSubmissionService;
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  router.get('/', async (req, res) => {
    try {
      const submissions = await service.listReviewQueue(req.authUser.id);
      return res.render('records/teacher-grade-queue', {
        title: 'Teacher Grade Submissions', currentUser: req.authUser, submissions,
        notice: req.query.notice === 'reviewRecorded' ? 'The submission review was recorded.' : null
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The teacher grade review queue is temporarily unavailable.' });
    }
  });

  router.get('/:submissionId', async (req, res) => {
    try {
      const submission = await service.readSubmission(req.authUser.id, req.params.submissionId, 'registrar');
      return res.render('records/teacher-grade-review', {
        title: 'Review Teacher Grade Workbook', currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req), submission, error: null
      });
    } catch (error) {
      if (isUploadError(error)) return res.status(error.status).render('error', { title: error.status === 404 ? 'Not Found' : 'Invalid Request', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The grade submission could not be loaded.' });
    }
  });

  router.get('/:submissionId/workbook', async (req, res) => {
    try {
      const workbook = await service.getWorkbook(req.authUser.id, req.params.submissionId, 'registrar');
      return res.type(workbook.mimeType).download(workbook.filePath, workbook.filename);
    } catch (error) {
      if (isUploadError(error)) return res.status(error.status).render('error', { title: error.status === 404 ? 'Not Found' : 'Invalid Request', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The workbook could not be downloaded.' });
    }
  });

  router.post('/:submissionId/decision', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const decision = req.body?.decision;
    const submissionId = req.params.submissionId;
    try {
      if (decision === 'approve') {
        const submission = await service.readSubmission(req.authUser.id, submissionId, 'registrar');
        const decisions = submission.rows.map((row) => {
          const grades = {};
          for (const grade of row.grades) {
            const key = grade.gradingPeriod === 'Term 1' ? 'term1'
              : grade.gradingPeriod === 'Term 2' ? 'term2'
                : grade.gradingPeriod === 'Term 3' ? 'term3' : 'final';
            grades[grade.gradingPeriod] = {
              action: req.body?.[`action_${row.sourceRow}_${key}`] === 'replace' ? 'replace' : 'skip',
              reason: req.body?.[`reason_${row.sourceRow}_${key}`]
            };
          }
          return {
            sourceRow: row.sourceRow,
            include: req.body?.[`includeRow_${row.sourceRow}`] === 'yes',
            allowNameMismatch: req.body?.[`overrideName_${row.sourceRow}`] === 'yes',
            nameReason: req.body?.[`nameReason_${row.sourceRow}`],
            grades
          };
        });
        await gradeImportService.confirmPreview({ actorId: req.authUser.id, submissionId, decisions });
      } else {
        await service.decideSubmission(req.authUser.id, submissionId, decision, req.body?.reason);
      }
      return res.redirect(303, '/registrar/grade-submissions?notice=reviewRecorded');
    } catch (error) {
      if (isUploadError(error)) {
        try {
          const submission = await service.readSubmission(req.authUser.id, submissionId, 'registrar');
          return res.status(error.status).render('records/teacher-grade-review', {
            title: 'Review Teacher Grade Workbook', currentUser: req.authUser,
            csrfToken: ensureCsrfToken(req), submission, error: error.message
          });
        } catch {
          return res.status(error.status).render('error', { title: error.status === 404 ? 'Not Found' : 'Invalid Request', message: error.message });
        }
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The grade submission review could not be recorded.' });
    }
  });

  return router;
}

module.exports = { createTeacherGradeSubmissionRouter, createRegistrarGradeSubmissionRouter };
