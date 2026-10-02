const express = require('express');
const crypto = require('node:crypto');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { buildNavigation } = require('../middleware/navigation');
const { createAcademicRecordsService } = require('../services/academicRecordsService');
const { StudentDocumentRequestError, createStudentDocumentRequestService } = require('../services/studentDocumentRequestService');
const {
  StudentDocumentFinanceClearanceError,
  createStudentDocumentFinanceClearanceService
} = require('../services/studentDocumentFinanceClearanceService');
const { RegistrarGradeOverviewError, createRegistrarGradeOverviewService } = require('../services/registrarGradeOverviewService');
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
  documentRequestCreated: 'Document request recorded.',
  documentRequestUpdated: 'Document request updated.',
  documentRequestCorrected: 'Document request details corrected.',
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
    phone: typeof input.phone === 'string' ? input.phone.slice(0, 50) : '',
    birthplace: typeof input.birthplace === 'string' ? input.birthplace.slice(0, 160) : '',
    facebookName: typeof input.facebookName === 'string' ? input.facebookName.slice(0, 120) : '',
    emergencyContactPerson: typeof input.emergencyContactPerson === 'string' ? input.emergencyContactPerson.slice(0, 160) : '',
    emergencyContactRelationship: typeof input.emergencyContactRelationship === 'string' ? input.emergencyContactRelationship.slice(0, 80) : '',
    emergencyContactPhone: typeof input.emergencyContactPhone === 'string' ? input.emergencyContactPhone.slice(0, 50) : '',
    emergencyContactAddress: typeof input.emergencyContactAddress === 'string' ? input.emergencyContactAddress.slice(0, 500) : '',
    motherName: typeof input.motherName === 'string' ? input.motherName.slice(0, 160) : '',
    motherPhone: typeof input.motherPhone === 'string' ? input.motherPhone.slice(0, 50) : '',
    fatherName: typeof input.fatherName === 'string' ? input.fatherName.slice(0, 160) : '',
    fatherPhone: typeof input.fatherPhone === 'string' ? input.fatherPhone.slice(0, 50) : ''
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
    phone: student.phone,
    birthplace: student.birthplace,
    facebookName: student.facebook_name,
    emergencyContactPerson: student.emergency_contact_person,
    emergencyContactRelationship: student.emergency_contact_relationship,
    emergencyContactPhone: student.emergency_contact_phone,
    emergencyContactAddress: student.emergency_contact_address,
    motherName: student.mother_name,
    motherPhone: student.mother_phone,
    fatherName: student.father_name,
    fatherPhone: student.father_phone
  });
}

function isUniqueStudentConflict(error) {
  return normalizeUniqueConflict(error);
}

function createStudentRecordsRouter({ getPool, sql, studentRecordsService, academicRecordsService, documentRequestService, documentClearanceService, gradeOverviewService } = {}) {
  const router = express.Router();
  const service = studentRecordsService || createStudentRecordsService({ getPool, sql });
  const academics = academicRecordsService || createAcademicRecordsService({ getPool, sql });
  const documentRequests = documentRequestService || (studentRecordsService
    ? { async getStudentRequests() { return []; } }
    : createStudentDocumentRequestService({ getPool, sql }));
  const documentClearance = documentClearanceService || createStudentDocumentFinanceClearanceService({ getPool, sql });
  const gradeOverview = gradeOverviewService || createRegistrarGradeOverviewService({ getPool, sql });

  async function loadWorkspace(search = '', termId = '', page = 1) {
    return service.listWorkspace(search, termId, page);
  }

  async function renderDashboard(req, res, { status = 200, error = null, notice = null, search = '', termId = '', page = 1, openForm = null, formValues = {}, view = 'records' } = {}) {
    try {
      if (view === 'setup') {
        const navigation = buildNavigation(req.authUser.role, '/registrar/records?view=setup');
        res.locals.navigationItems = navigation.items;
        res.locals.navigationGroups = navigation.groups;
        res.locals.currentPage = navigation.currentPage;
      }
      const workspace = await loadWorkspace(search, termId, page);
      return res.status(status).render('records/index', {
        title: 'Student Records',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        notice,
        error,
        view,
        openForm,
        formValues,
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
        notice: null, error: loadError.message, openForm: null, formValues: {}, view
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

  async function renderStudentOverview(req, res, {
    status = 200, error = null, view = 'overview', requestForm = null, requestId = null,
    requestValues = {}, requestIdempotencyKey = null
  } = {}) {
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      const [record, academicRecord, documentRequestRows, revisions, clearanceData] = await Promise.all([
        service.getStudent(studentId),
        academics.getStudentAcademicRecord(studentId),
        documentRequests.getStudentRequests ? documentRequests.getStudentRequests(req.authUser.id, studentId) : [],
        service.listStudentProfileRevisions ? service.listStudentProfileRevisions(req.authUser.id, studentId) : [],
        documentClearance.getRegistrarData(req.authUser.id, studentId)
      ]);
      if (!record || !academicRecord) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
      const requestIdempotencyKeys = Object.fromEntries(documentRequestRows.map((request) => [request.id, crypto.randomUUID()]));
      const correctionIdempotencyKeys = Object.fromEntries(documentRequestRows.map((request) => [request.id, crypto.randomUUID()]));
      const claimSlipIdempotencyKeys = Object.fromEntries(documentRequestRows.map((request) => [request.id, crypto.randomUUID()]));
      const requestClearanceData = Object.fromEntries(clearanceData.requests.map((item) => [item.requestId, item]));
      if (requestId && requestIdempotencyKey) {
        const targetKeys = requestForm === 'correct' ? correctionIdempotencyKeys : requestForm === 'claim-slip' ? claimSlipIdempotencyKeys : requestIdempotencyKeys;
        targetKeys[requestId] = requestIdempotencyKey;
      }
      return res.status(status).set('Cache-Control', 'private, no-store').render('records/student-overview', {
        title: 'Student record overview', currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
        studentView: view, notice: notices[req.query.notice] || null, requestError: error,
        requestForm, requestFormId: requestId, requestFormValues: requestValues,
        student: record.student, enrollments: academicRecord.enrollments,
        documentRequests: documentRequestRows, profileRevisions: revisions,
        financeSummary: clearanceData.financeSummary, requestClearanceData,
        newDocumentRequestKey: requestIdempotencyKey || crypto.randomUUID(), requestIdempotencyKeys, correctionIdempotencyKeys,
        claimSlipIdempotencyKeys
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The student record could not be loaded.' });
    }
  }

  router.get('/', (req, res) => renderDashboard(req, res, {
    search: req.query.search === undefined ? '' : req.query.search,
    termId: req.query.termId === undefined ? '' : req.query.termId,
    page: req.query.page === undefined ? 1 : req.query.page,
    view: req.query.view === 'setup' ? 'setup' : 'records',
    notice: notices[req.query.notice] || null
  }));

  router.get('/grades/missing', async (req, res) => {
    try {
      const contexts = await gradeOverview.listContexts(req.authUser.id);
      const hasAllFilters = req.query.termId && req.query.sectionId && req.query.subjectId;
      const overview = hasAllFilters ? await gradeOverview.getOverview(req.authUser.id, req.query) : null;
      return res.render('records/missing-grade-overview', {
        title: 'Grade completion overview', currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
        contexts, overview, filters: req.query, error: null
      });
    } catch (error) {
      if (error instanceof RegistrarGradeOverviewError) {
        let contexts = { terms: [], sections: [], subjects: [] };
        try { contexts = await gradeOverview.listContexts(req.authUser.id); } catch { /* keep the original safe error */ }
        return res.status(error.status).render('records/missing-grade-overview', {
          title: 'Grade completion overview', currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
          contexts, overview: null, filters: req.query, error: error.message
        });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The grade completion overview could not be loaded.' });
    }
  });

  router.get('/students/new', (req, res) => req.authUser.role === 'registrar'
    ? res.redirect(303, '/registrar/intake/new')
    : renderStudentForm(req, res));

  router.get('/students/:id', (req, res) => renderStudentOverview(req, res, {
    view: ['history', 'requests'].includes(req.query.view) ? req.query.view : 'overview'
  }));

  router.post('/students/:id/document-requests', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await documentRequests.createRequest(req.authUser.id, studentId, req.body);
      return res.redirect(303, `/registrar/records/students/${studentId}?view=requests&notice=documentRequestCreated`);
    } catch (error) {
      if (error instanceof StudentDocumentRequestError) return renderStudentOverview(req, res, { status: error.status, error: error.message, view: 'requests', requestForm: 'create', requestValues: req.body || {}, requestIdempotencyKey: req.body?.idempotencyKey });
      return renderStudentOverview(req, res, { status: 503, error: 'The document request could not be recorded.', view: 'requests', requestForm: 'create', requestValues: req.body || {}, requestIdempotencyKey: req.body?.idempotencyKey });
    }
  });

  router.post('/students/:id/document-requests/:requestId/status', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await documentRequests.transitionRequest(req.authUser.id, studentId, req.params.requestId, req.body);
      return res.redirect(303, `/registrar/records/students/${studentId}?view=requests&notice=documentRequestUpdated`);
    } catch (error) {
      if (error instanceof StudentDocumentRequestError) return renderStudentOverview(req, res, { status: error.status, error: error.message, view: 'requests', requestForm: 'status', requestId: req.params.requestId, requestValues: req.body || {}, requestIdempotencyKey: req.body?.idempotencyKey });
      return renderStudentOverview(req, res, { status: 503, error: 'The document request could not be updated.', view: 'requests', requestForm: 'status', requestId: req.params.requestId, requestValues: req.body || {}, requestIdempotencyKey: req.body?.idempotencyKey });
    }
  });

  router.post('/students/:id/document-requests/:requestId/correct', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await documentRequests.correctRequest(req.authUser.id, studentId, req.params.requestId, req.body);
      return res.redirect(303, `/registrar/records/students/${studentId}?view=requests&notice=documentRequestCorrected`);
    } catch (error) {
      if (error instanceof StudentDocumentRequestError) return renderStudentOverview(req, res, { status: error.status, error: error.message, view: 'requests', requestForm: 'correct', requestId: req.params.requestId, requestValues: req.body || {}, requestIdempotencyKey: req.body?.idempotencyKey });
      return renderStudentOverview(req, res, { status: 503, error: 'The document request could not be corrected.', view: 'requests', requestForm: 'correct', requestId: req.params.requestId, requestValues: req.body || {}, requestIdempotencyKey: req.body?.idempotencyKey });
    }
  });

  router.post('/students/:id/document-requests/:requestId/claim-slip', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Document request not found.' });
    try {
      await documentClearance.issueClaimSlip(req.authUser.id, req.params.requestId, { ...req.body, studentId });
      return res.redirect(303, `/registrar/records/students/${studentId}?view=requests&notice=documentRequestUpdated`);
    } catch (error) {
      if (error instanceof StudentDocumentFinanceClearanceError) return renderStudentOverview(req, res, { status: error.status, error: error.message, view: 'requests', requestForm: 'claim-slip', requestId: req.params.requestId, requestValues: req.body || {}, requestIdempotencyKey: req.body?.idempotencyKey });
      return renderStudentOverview(req, res, { status: 503, error: 'The claim slip could not be issued.', view: 'requests', requestForm: 'claim-slip', requestId: req.params.requestId, requestValues: req.body || {}, requestIdempotencyKey: req.body?.idempotencyKey });
    }
  });

  router.get('/students/:id/document-requests/:requestId/claim-slip', async (req, res) => {
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Document request not found.' });
    try {
      const claimSlip = await documentClearance.getPrintableClaimSlip(req.authUser.id, req.params.requestId, studentId);
      return res.set({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' })
        .render('records/document-claim-slip', { title: 'Document Claim Slip', currentUser: req.authUser, claimSlip });
    } catch (error) {
      if (error instanceof StudentDocumentFinanceClearanceError) return res.status(error.status).set('Cache-Control', 'private, no-store').render('error', { title: error.status === 404 ? 'Not Found' : 'Claim Slip Unavailable', message: error.message });
      return res.status(503).set('Cache-Control', 'private, no-store').render('error', { title: 'Service Unavailable', message: 'The claim slip could not be loaded.' });
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
      return res.redirect(303, '/registrar/records?view=setup&notice=termCreated');
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderDashboard(req, res, { view: 'setup', error: error.message, status: error.status, openForm: 'term', formValues: req.body || {} });
      if (isUniqueStudentConflict(error)) return renderDashboard(req, res, { view: 'setup', error: 'That academic term already exists.', status: 409, openForm: 'term', formValues: req.body || {} });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The academic term could not be created.' });
    }
  });

  router.post('/terms/:id/current', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await service.setCurrentTerm(req.authUser.id, req.params.id);
      return res.redirect(303, '/registrar/records?view=setup&notice=termCurrent');
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderDashboard(req, res, { view: 'setup', error: error.message, status: error.status });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The current academic term could not be changed.' });
    }
  });

  router.post('/sections', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await service.createSection(req.authUser.id, req.body);
      return res.redirect(303, '/registrar/records?view=setup&notice=sectionCreated');
    } catch (error) {
      if (error instanceof StudentRecordsError) return renderDashboard(req, res, { view: 'setup', error: error.message, status: error.status, openForm: 'section', formValues: req.body || {} });
      if (isUniqueStudentConflict(error)) return renderDashboard(req, res, { view: 'setup', error: 'That section already exists for the selected term.', status: 409, openForm: 'section', formValues: req.body || {} });
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
