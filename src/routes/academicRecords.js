const express = require('express');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const {
  AcademicRecordsError,
  createAcademicRecordsService,
  normalizeId,
  isUniqueConflict
} = require('../services/academicRecordsService');
const { TeacherGradeSubmissionError, createTeacherGradeSubmissionService } = require('../services/teacherGradeSubmissionService');

const notices = {
  subjectCreated: 'Subject created.',
  subjectUpdated: 'Subject updated.',
  subjectAssigned: 'Subject assigned to the enrollment.',
};

function subjectValues(input = {}) {
  return {
    subjectCode: typeof input.subjectCode === 'string' ? input.subjectCode.slice(0, 50) : '',
    subjectName: typeof input.subjectName === 'string' ? input.subjectName.slice(0, 200) : '',
    units: typeof input.units === 'string' || typeof input.units === 'number' ? String(input.units).slice(0, 6) : ''
  };
}

function createAcademicRecordsRouter({ getPool, sql, academicRecordsService, teacherGradeSubmissionService } = {}) {
  const router = express.Router();
  const service = academicRecordsService || createAcademicRecordsService({ getPool, sql });
  const teacherService = teacherGradeSubmissionService || createTeacherGradeSubmissionService({ getPool, sql });

  async function renderSubjects(req, res, { status = 200, error = null, values = {} } = {}) {
    try {
      const allSubjects = await service.listSubjects();
      const search = typeof req.query?.search === 'string' ? req.query.search.slice(0, 100).trim() : '';
      const searchNeedle = search.toLocaleLowerCase();
      const subjects = searchNeedle ? allSubjects.filter((subject) =>
        `${subject.subject_code} ${subject.subject_name}`.toLocaleLowerCase().includes(searchNeedle)) : allSubjects;
      return res.status(status).render('records/subjects', {
        title: 'Subjects',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        subjects,
        subjectCount: allSubjects.length,
        search,
        showCreateForm: req.query?.openForm === '1' || Boolean(error),
        values: subjectValues(values),
        error,
        notice: notices[req.query.notice] || null
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The subjects list could not be loaded.' });
    }
  }

  function teacherAssignmentContext(req, values = {}) {
    const queryFilters = req.method === 'GET' ? req.query : {};
    return {
      termId: queryFilters.termId ?? req.body?.filterTermId ?? values.academicTermId ?? '',
      sectionId: queryFilters.sectionId ?? req.body?.filterSectionId ?? values.sectionId ?? ''
    };
  }

  function teacherAssignmentUrl(context, notice) {
    const query = new URLSearchParams();
    if (context.termId) query.set('termId', context.termId);
    if (context.sectionId) query.set('sectionId', context.sectionId);
    if (notice) query.set('notice', notice);
    const serialized = query.toString();
    return `/registrar/records/teacher-assignments${serialized ? `?${serialized}` : ''}`;
  }

  async function renderTeacherAssignments(req, res, { status = 200, error = null, values = {}, filters = null } = {}) {
    try {
      const context = filters || teacherAssignmentContext(req, values);
      const options = await teacherService.listAssignmentOptions(req.authUser.id, context);
      return res.status(status).render('records/teacher-assignments', {
        title: 'Teacher Assignments', csrfToken: ensureCsrfToken(req), currentUser: req.authUser,
        ...options, values, error,
        notice: req.query.notice === 'assignmentCreated' ? 'Teacher assignment created.'
          : req.query.notice === 'assignmentRevoked' ? 'Teacher assignment revoked.' : null
      });
    } catch (loadError) {
      if (loadError instanceof TeacherGradeSubmissionError) {
        return res.status(loadError.status).render('error', { title: 'Invalid class context', message: loadError.message });
      }
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
    const context = teacherAssignmentContext(req, values);
    try {
      await teacherService.createAssignment(req.authUser.id, values);
      return res.redirect(303, teacherAssignmentUrl(context, 'assignmentCreated'));
    } catch (error) {
      if (error instanceof TeacherGradeSubmissionError) return renderTeacherAssignments(req, res, { status: error.status, error: error.message, values, filters: context });
      if (isUniqueConflict(error)) return renderTeacherAssignments(req, res, { status: 409, error: 'That class context already has an active teacher assignment.', values, filters: context });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The teacher assignment could not be created.' });
    }
  });

  router.post('/teacher-assignments/:id/revoke', requireRole('database_admin', 'registrar'), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await teacherService.revokeAssignment(req.authUser.id, req.params.id);
      return res.redirect(303, teacherAssignmentUrl(teacherAssignmentContext(req), 'assignmentRevoked'));
    } catch (error) {
      if (error instanceof TeacherGradeSubmissionError) return renderTeacherAssignments(req, res, { status: error.status, error: error.message, filters: teacherAssignmentContext(req) });
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
      return res.redirect(303, '/registrar/records/subjects?notice=subjectCreated');
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
      return res.redirect(303, '/registrar/records/subjects?notice=subjectUpdated');
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
      return res.redirect(303, `/registrar/records/students/${savedStudentId}/academic?notice=subjectAssigned`);
    } catch (error) {
      if (error instanceof AcademicRecordsError) return renderAcademicRecord(req, res, studentId, { status: error.status, error: error.message });
      if (isUniqueConflict(error)) return renderAcademicRecord(req, res, studentId, { status: 409, error: 'This subject is already assigned to the enrollment.' });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The subject could not be assigned.' });
    }
  });

  return router;
}

module.exports = { createAcademicRecordsRouter, subjectValues };
