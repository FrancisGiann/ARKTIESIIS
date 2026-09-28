const express = require('express');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { createAcademicRecordsService } = require('../services/academicRecordsService');
const {
  StudentRecordsError,
  createStudentRecordsService,
  normalizeRecordId,
  normalizeUniqueConflict
} = require('../services/studentRecordsService');

const notices = {
  studentCreated: 'Student profile created.',
  studentUpdated: 'Student profile updated.',
  studentArchived: 'Student record archived. Academic and finance history was retained.',
  loginDeactivated: 'Student login deactivated.',
  termCreated: 'Academic term created.',
  termCurrent: 'Current academic term updated.',
  sectionCreated: 'Section created.',
  enrollmentSaved: 'Enrollment saved.',
};

function studentValues(input = {}) {
  return {
    studentNo: typeof input.studentNo === 'string' ? input.studentNo.slice(0, 50) : '',
    lrn: typeof input.lrn === 'string' ? input.lrn.slice(0, 12) : '',
    firstName: typeof input.firstName === 'string' ? input.firstName.slice(0, 100) : '',
    middleName: typeof input.middleName === 'string' ? input.middleName.slice(0, 100) : '',
    lastName: typeof input.lastName === 'string' ? input.lastName.slice(0, 100) : '',
    suffix: typeof input.suffix === 'string' ? input.suffix.slice(0, 20) : '',
    birthDate: typeof input.birthDate === 'string' ? input.birthDate.slice(0, 10) : '',
    sex: typeof input.sex === 'string' ? input.sex.slice(0, 20) : '',
    address: typeof input.address === 'string' ? input.address.slice(0, 500) : '',
    phone: typeof input.phone === 'string' ? input.phone.slice(0, 50) : ''
  };
}

function valuesFromStudent(student) {
  return studentValues({
    studentNo: student.student_no,
    lrn: student.lrn,
    firstName: student.first_name,
    middleName: student.middle_name,
    lastName: student.last_name,
    suffix: student.suffix,
    birthDate: student.birth_date instanceof Date ? student.birth_date.toISOString().slice(0, 10) : student.birth_date,
    sex: student.sex,
    address: student.address,
    phone: student.phone
  });
}

function isUniqueStudentConflict(error) {
  return normalizeUniqueConflict(error);
}

function createStudentRecordsRouter({ getPool, sql, studentRecordsService, academicRecordsService } = {}) {
  const router = express.Router();
  const service = studentRecordsService || createStudentRecordsService({ getPool, sql });
  const academics = academicRecordsService || createAcademicRecordsService({ getPool, sql });

  async function loadWorkspace(search = '', termId = '', page = 1) {
    return service.listWorkspace(search, termId, page);
  }

  async function renderDashboard(req, res, { status = 200, error = null, notice = null, search = '', termId = '', page = 1 } = {}) {
    try {
      const workspace = await loadWorkspace(search, termId, page);
      return res.status(status).render('records/index', {
        title: 'Student Records',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        notice,
        error,
        ...workspace,
        students: workspace.students || [],
        terms: workspace.terms || [],
        sections: workspace.sections || [],
        searchTerm: workspace.searchTerm ?? search,
        academicTermId: workspace.academicTermId ?? null,
        totalStudents: workspace.totalStudents ?? workspace.students?.length ?? 0,
        page: workspace.page ?? 1,
        pageSize: workspace.pageSize ?? 25,
        totalPages: workspace.totalPages ?? 1
      });
    } catch (loadError) {
      if (!(loadError instanceof StudentRecordsError)) {
        return res.status(503).render('error', { title: 'Service Unavailable', message: 'Student records could not be loaded.' });
      }
      return res.status(loadError.status).render('records/index', {
        title: 'Student Records', csrfToken: ensureCsrfToken(req), currentUser: req.authUser,
        students: [], terms: [], sections: [], searchTerm: '', academicTermId: null,
        totalStudents: 0, page: 1, pageSize: 25, totalPages: 1,
        notice: null, error: loadError.message
      });
    }
  }

  async function renderStudentForm(req, res, { studentId = null, values = {}, error = null, status = 200, notice = null } = {}) {
    try {
      const record = studentId === null ? null : await service.getStudent(studentId);
      if (studentId !== null && !record) {
        return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
      }
      const workspace = record ? null : await service.listWorkspace('', '');
      const formValues = Object.keys(values).length
        ? studentValues(values)
        : record ? valuesFromStudent(record.student) : studentValues();
      if (!record) formValues.studentNo = '';
      if (record && req.authUser.role === 'registrar') formValues.studentNo = record.student.student_no;
      return res.status(status).render('records/student-form', {
        title: studentId === null ? 'Create Student Profile' : 'Student Record',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        student: record?.student || null,
        terms: record?.terms || workspace.terms,
        sections: record?.sections || workspace.sections,
        enrollments: record?.enrollments || [],
        values: formValues,
        error,
        notice
      });
    } catch (loadError) {
      if (loadError instanceof StudentRecordsError) {
        return res.status(loadError.status).render('error', { title: loadError.status === 404 ? 'Not Found' : 'Invalid Request', message: loadError.message });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The student record could not be loaded.' });
    }
  }

  router.get('/', (req, res) => renderDashboard(req, res, {
    search: req.query.search === undefined ? '' : req.query.search,
    termId: req.query.termId === undefined ? '' : req.query.termId,
    page: req.query.page === undefined ? 1 : req.query.page,
    notice: notices[req.query.notice] || null
  }));

  router.get('/students/new', (req, res) => req.authUser.role === 'registrar'
    ? res.redirect(303, '/registrar/intake/new')
    : renderStudentForm(req, res));

  router.get('/students/:id', async (req, res) => {
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      const [record, academicRecord] = await Promise.all([
        service.getStudent(studentId),
        academics.getStudentAcademicRecord(studentId)
      ]);
      if (!record || !academicRecord) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
      return res.render('records/student-overview', {
        title: 'Student record overview', currentUser: req.authUser,
        student: record.student, enrollments: academicRecord.enrollments
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The student record could not be loaded.' });
    }
  });

  router.post('/students', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    if (req.authUser.role === 'registrar') {
      return res.status(403).render('error', {
        title: 'Forbidden', message: 'Registrars must create new student profiles through student enrollment intake.'
      });
    }
    const values = studentValues(req.body);
    try {
      const studentId = await service.saveStudent(req.authUser.id, null, req.body);
      return res.redirect(303, `/registrar/records/students/${studentId}/edit?notice=studentCreated`);
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderStudentForm(req, res, { values, error: error.message, status: error.status });
      if (isUniqueStudentConflict(error)) return renderStudentForm(req, res, { values, error: 'A record conflict occurred. Check the LRN and retry the profile creation.', status: 409 });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The student profile could not be created.' });
    }
  });

  router.get('/students/:id/edit', async (req, res) => {
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return renderStudentForm(req, res, { studentId, notice: notices[req.query.notice] || null });
  });

  router.post('/students/:id', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    const values = studentValues(req.body);
    try {
      await service.saveStudent(req.authUser.id, studentId, req.body);
      return res.redirect(303, `/registrar/records/students/${studentId}/edit?notice=studentUpdated`);
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderStudentForm(req, res, { studentId, values, error: error.message, status: error.status });
      if (isUniqueStudentConflict(error)) return renderStudentForm(req, res, { studentId, values, error: 'That student number or LRN is already in use.', status: 409 });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The student profile could not be updated.' });
    }
  });

  router.post('/students/:id/login/deactivate', requireRole('registrar'), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await service.deactivateStudentLogin(req.authUser.id, studentId, req.body?.confirmation);
      return res.redirect(303, `/registrar/records/students/${studentId}/edit?notice=loginDeactivated`);
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderStudentForm(req, res, { studentId, error: error.message, status: error.status });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The student login could not be deactivated.' });
    }
  });

  router.post('/students/:id/archive', requireRole('database_admin'), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await service.archiveStudent(req.authUser.id, studentId, req.body?.confirmation);
      return res.redirect(303, `/registrar/records?notice=studentArchived`);
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderStudentForm(req, res, { studentId, error: error.message, status: error.status });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The student record could not be archived.' });
    }
  });

  router.post('/terms', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await service.createTerm(req.authUser.id, req.body);
      return res.redirect(303, '/registrar/records?notice=termCreated');
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderDashboard(req, res, { error: error.message, status: error.status });
      if (isUniqueStudentConflict(error)) return renderDashboard(req, res, { error: 'That academic term already exists.', status: 409 });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The academic term could not be created.' });
    }
  });

  router.post('/terms/:id/current', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await service.setCurrentTerm(req.authUser.id, req.params.id);
      return res.redirect(303, '/registrar/records?notice=termCurrent');
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderDashboard(req, res, { error: error.message, status: error.status });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The current academic term could not be changed.' });
    }
  });

  router.post('/sections', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await service.createSection(req.authUser.id, req.body);
      return res.redirect(303, '/registrar/records?notice=sectionCreated');
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderDashboard(req, res, { error: error.message, status: error.status });
      if (isUniqueStudentConflict(error)) return renderDashboard(req, res, { error: 'That section already exists for the selected term.', status: 409 });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The section could not be created.' });
    }
  });

  router.post('/enrollments', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const studentId = normalizeRecordId(req.body?.studentId);
    if (!studentId) return res.status(400).render('error', { title: 'Invalid Request', message: 'Choose a valid student record.' });
    try {
      await service.saveEnrollment(req.authUser.id, req.body);
      return res.redirect(303, `/registrar/records/students/${studentId}/edit?notice=enrollmentSaved`);
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderStudentForm(req, res, { studentId, error: error.message, status: error.status });
      if (isUniqueStudentConflict(error)) return renderStudentForm(req, res, { studentId, error: 'This student already has an enrollment for that term.', status: 409 });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The enrollment could not be saved.' });
    }
  });

  return router;
}

module.exports = { createStudentRecordsRouter, studentValues, valuesFromStudent };
