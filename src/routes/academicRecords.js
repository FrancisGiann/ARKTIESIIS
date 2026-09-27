const express = require('express');
const multer = require('multer');
const path = require('node:path');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const {
  AcademicRecordsError,
  createAcademicRecordsService,
  normalizeId,
  isUniqueConflict
} = require('../services/academicRecordsService');
const { GradeImportError, createGradeImportService } = require('../services/gradeImportService');
const { TeacherGradeSubmissionError, createTeacherGradeSubmissionService } = require('../services/teacherGradeSubmissionService');

const notices = {
  subjectCreated: 'Subject created.',
  subjectUpdated: 'Subject updated.',
  subjectAssigned: 'Subject assigned to the enrollment.',
  gradeSaved: 'Grade saved.'
};

function subjectValues(input = {}) {
  return {
    subjectCode: typeof input.subjectCode === 'string' ? input.subjectCode.slice(0, 50) : '',
    subjectName: typeof input.subjectName === 'string' ? input.subjectName.slice(0, 200) : '',
    units: typeof input.units === 'string' || typeof input.units === 'number' ? String(input.units).slice(0, 6) : ''
  };
}

function createAcademicRecordsRouter({ getPool, sql, academicRecordsService, gradeImportService, teacherGradeSubmissionService } = {}) {
  const router = express.Router();
  const service = academicRecordsService || createAcademicRecordsService({ getPool, sql });
  const importService = gradeImportService || createGradeImportService({ getPool, sql });
  const teacherService = teacherGradeSubmissionService || createTeacherGradeSubmissionService({ getPool, sql });
  const workbookUpload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: 5 * 1024 * 1024, fields: 3, parts: 4 }
  }).single('workbook');

  router.use('/grade-import', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  async function renderGradeImport(req, res, { status = 200, error = null, preview = null, contextKey = '' } = {}) {
    try {
      const contexts = await importService.listImportContexts(req.authUser.id);
      const summary = req.session.gradeImportSummary || null;
      delete req.session.gradeImportSummary;
      return res.status(status).render('records/grade-import', {
        title: 'Import SSHS E-Class Record Grades',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        contexts,
        contextKey,
        preview,
        summary,
        error,
        notice: req.query.notice === 'gradeImportCompleted' ? 'Grade import completed.' : null
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The grade-import workspace could not be loaded.' });
    }
  }

  function parseWorkbookUpload(req, res, next) {
    workbookUpload(req, res, (error) => {
      if (!error) return next();
      const message = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
        ? 'The XLSX workbook must be 5 MB or smaller.'
        : 'Choose one XLSX workbook to preview.';
      return renderGradeImport(req, res, { status: error.status || 400, error: message });
    });
  }

  router.get('/grade-import', requireRole('registrar'), (req, res) => renderGradeImport(req, res, { contextKey: req.query.contextKey || '' }));

  router.post('/grade-import/preview', requireRole('registrar'), parseWorkbookUpload, async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      if (req.file?.buffer) req.file.buffer.fill(0);
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const file = req.file;
    if (!file) return renderGradeImport(req, res, { status: 400, error: 'Choose one XLSX workbook.' });
    try {
      const extension = path.extname(file.originalname).toLocaleLowerCase();
      const validMime = file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const validZip = file.buffer.length >= 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
      if (extension !== '.xlsx' || !validMime || !validZip) {
        return renderGradeImport(req, res, { status: 400, error: 'Upload a valid .xlsx workbook with the Excel XLSX MIME type.' });
      }
      const contextKey = typeof req.body?.contextKey === 'string' ? req.body.contextKey : '';
      const preview = await importService.createPreview({
        actorId: req.authUser.id,
        sessionId: req.sessionID,
        contextKey,
        buffer: file.buffer
      });
      return renderGradeImport(req, res, { preview, contextKey });
    } catch (error) {
      if (error instanceof GradeImportError) return renderGradeImport(req, res, { status: error.status, error: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The workbook could not be previewed.' });
    } finally {
      file.buffer.fill(0);
      req.file = undefined;
    }
  });

  router.get('/grade-import/:previewId', requireRole('registrar'), async (req, res) => {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(req.params.previewId)) {
      return renderGradeImport(req, res, { status: 404, error: 'Grade preview not found.' });
    }
    try {
      const preview = await importService.getPreview({ actorId: req.authUser.id, sessionId: req.sessionID, previewId: req.params.previewId });
      return renderGradeImport(req, res, { preview });
    } catch (error) {
      if (error instanceof GradeImportError) return renderGradeImport(req, res, { status: error.status, error: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The grade preview could not be loaded.' });
    }
  });

  router.post('/grade-import/:previewId/confirm', requireRole('registrar'), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(req.params.previewId)) {
      return renderGradeImport(req, res, { status: 404, error: 'Grade preview not found.' });
    }
    try {
      const preview = await importService.getPreview({ actorId: req.authUser.id, sessionId: req.sessionID, previewId: req.params.previewId });
      const decisions = preview.rows.map((row) => {
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
      const summary = await importService.confirmPreview({
        actorId: req.authUser.id,
        sessionId: req.sessionID,
        previewId: req.params.previewId,
        decisions
      });
      req.session.gradeImportSummary = summary;
      return res.redirect(303, '/records/grade-import?notice=gradeImportCompleted');
    } catch (error) {
      if (error instanceof GradeImportError) return renderGradeImport(req, res, { status: error.status, error: error.message });
      if (isUniqueConflict(error)) return renderGradeImport(req, res, { status: 409, error: 'A grade changed during confirmation. Upload the workbook again.' });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The grade import could not be confirmed.' });
    }
  });

  async function renderSubjects(req, res, { status = 200, error = null, values = {} } = {}) {
    try {
      const subjects = await service.listSubjects();
      return res.status(status).render('records/subjects', {
        title: 'Subject Catalog',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        subjects,
        values: subjectValues(values),
        error,
        notice: notices[req.query.notice] || null
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The subject catalog could not be loaded.' });
    }
  }

  async function renderTeacherAssignments(req, res, { status = 200, error = null, values = {} } = {}) {
    try {
      const options = await teacherService.listAssignmentOptions(req.authUser.id);
      return res.status(status).render('records/teacher-assignments', {
        title: 'Teacher Assignments', csrfToken: ensureCsrfToken(req), currentUser: req.authUser,
        ...options, values, error,
        notice: req.query.notice === 'assignmentCreated' ? 'Teacher assignment created.'
          : req.query.notice === 'assignmentRevoked' ? 'Teacher assignment revoked.' : null
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Teacher assignments are temporarily unavailable.' });
    }
  }

  router.get('/teacher-assignments', (req, res) => renderTeacherAssignments(req, res));

  router.post('/teacher-assignments', requireRole('database_admin', 'registrar'), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const values = {
      teacherId: typeof req.body?.teacherId === 'string' ? req.body.teacherId : '',
      academicTermId: typeof req.body?.academicTermId === 'string' ? req.body.academicTermId : '',
      sectionId: typeof req.body?.sectionId === 'string' ? req.body.sectionId : '',
      subjectId: typeof req.body?.subjectId === 'string' ? req.body.subjectId : ''
    };
    try {
      await teacherService.createAssignment(req.authUser.id, values);
      return res.redirect(303, '/records/teacher-assignments?notice=assignmentCreated');
    } catch (error) {
      if (error instanceof TeacherGradeSubmissionError) return renderTeacherAssignments(req, res, { status: error.status, error: error.message, values });
      if (isUniqueConflict(error)) return renderTeacherAssignments(req, res, { status: 409, error: 'That class context already has an active teacher assignment.', values });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The teacher assignment could not be created.' });
    }
  });

  router.post('/teacher-assignments/:id/revoke', requireRole('database_admin', 'registrar'), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await teacherService.revokeAssignment(req.authUser.id, req.params.id);
      return res.redirect(303, '/records/teacher-assignments?notice=assignmentRevoked');
    } catch (error) {
      if (error instanceof TeacherGradeSubmissionError) return renderTeacherAssignments(req, res, { status: error.status, error: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The teacher assignment could not be revoked.' });
    }
  });

  async function renderAcademicRecord(req, res, studentId, { status = 200, error = null } = {}) {
    try {
      const record = await service.getStudentAcademicRecord(studentId);
      if (!record) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
      return res.status(status).render('records/student-academic', {
        title: 'Student Academic Records',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        ...record,
        error,
        notice: notices[req.query.notice] || null
      });
    } catch (loadError) {
      if (loadError instanceof AcademicRecordsError) {
        return res.status(loadError.status).render('error', {
          title: loadError.status === 404 ? 'Not Found' : 'Invalid Request',
          message: loadError.message
        });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The academic record could not be loaded.' });
    }
  }

  router.get('/subjects', (req, res) => renderSubjects(req, res));

  router.post('/subjects', requireRole('database_admin', 'registrar'), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const values = subjectValues(req.body);
    try {
      await service.saveSubject(req.authUser.id, null, req.body);
      return res.redirect(303, '/records/subjects?notice=subjectCreated');
    } catch (error) {
      if (error instanceof AcademicRecordsError) return renderSubjects(req, res, { status: error.status, error: error.message, values });
      if (isUniqueConflict(error)) return renderSubjects(req, res, { status: 409, error: 'That subject code is already in use.', values });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The subject could not be created.' });
    }
  });

  router.post('/subjects/:id', requireRole('database_admin', 'registrar'), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const subjectId = normalizeId(req.params.id);
    if (!subjectId) return res.status(404).render('error', { title: 'Not Found', message: 'Subject not found.' });
    try {
      await service.saveSubject(req.authUser.id, subjectId, req.body);
      return res.redirect(303, '/records/subjects?notice=subjectUpdated');
    } catch (error) {
      if (error instanceof AcademicRecordsError) return renderSubjects(req, res, { status: error.status, error: error.message, values: req.body });
      if (isUniqueConflict(error)) return renderSubjects(req, res, { status: 409, error: 'That subject code is already in use.', values: req.body });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The subject could not be updated.' });
    }
  });

  router.get('/students/:id/academic', async (req, res) => {
    const studentId = normalizeId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return renderAcademicRecord(req, res, studentId);
  });

  router.post('/student-subjects', requireRole('database_admin', 'registrar'), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const studentId = normalizeId(req.body?.studentId);
    if (!studentId) return res.status(400).render('error', { title: 'Invalid Request', message: 'Choose a valid student record.' });
    try {
      const savedStudentId = await service.assignSubject(req.authUser.id, req.body);
      return res.redirect(303, `/records/students/${savedStudentId}/academic?notice=subjectAssigned`);
    } catch (error) {
      if (error instanceof AcademicRecordsError) return renderAcademicRecord(req, res, studentId, { status: error.status, error: error.message });
      if (isUniqueConflict(error)) return renderAcademicRecord(req, res, studentId, { status: 409, error: 'This subject is already assigned to the enrollment.' });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The subject could not be assigned.' });
    }
  });

  router.post('/grades', requireRole('database_admin', 'registrar'), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const studentId = normalizeId(req.body?.studentId);
    if (!studentId) return res.status(400).render('error', { title: 'Invalid Request', message: 'Choose a valid student record.' });
    try {
      const savedStudentId = await service.saveGrade(req.authUser.id, req.body);
      return res.redirect(303, `/records/students/${savedStudentId}/academic?notice=gradeSaved`);
    } catch (error) {
      if (error instanceof AcademicRecordsError) return renderAcademicRecord(req, res, studentId, { status: error.status, error: error.message });
      if (isUniqueConflict(error)) return renderAcademicRecord(req, res, studentId, { status: 409, error: 'A grade for this enrollment subject and grading period already exists.' });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The grade could not be saved.' });
    }
  });

  return router;
}

module.exports = { createAcademicRecordsRouter, subjectValues };
