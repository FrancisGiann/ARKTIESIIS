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
const { ReadmissionError, createReadmissionService } = require('../services/readmissionService');
const {
  TermClearanceError, TermClearanceSummaryUnavailableError, createTermClearanceService
} = require('../services/termClearanceService');
const {
  StudentRecordsError,
  createStudentRecordsService,
  normalizeRecordId,
  normalizeUniqueConflict,
  latestBirthDate
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

const CLEARANCE_SCHEMA_UNAVAILABLE_MESSAGE = 'Paper-clearance status cannot be read from the installed schema. No status was changed. Ask a database administrator to verify the clearance migration.';

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
    addressMode: input.addressMode === 'replace' ? 'replace' : 'preserve',
    addressBlockLotStreetPurok: typeof input.addressBlockLotStreetPurok === 'string' ? input.addressBlockLotStreetPurok.slice(0, 200) : '',
    addressBarangay: typeof input.addressBarangay === 'string' ? input.addressBarangay.slice(0, 100) : '',
    addressCity: typeof input.addressCity === 'string' ? input.addressCity.slice(0, 100) : '',
    addressProvince: typeof input.addressProvince === 'string' ? input.addressProvince.slice(0, 100) : '',
    addressZip: typeof input.addressZip === 'string' ? input.addressZip.slice(0, 4) : '',
    phone: typeof input.phone === 'string' ? input.phone.slice(0, 50) : '',
    birthplace: typeof input.birthplace === 'string' ? input.birthplace.slice(0, 160) : '',
    facebookName: typeof input.facebookName === 'string' ? input.facebookName.slice(0, 120) : '',
    emergencyContactPerson: typeof input.emergencyContactPerson === 'string' ? input.emergencyContactPerson.slice(0, 160) : '',
    emergencyContactRelationship: typeof input.emergencyContactRelationship === 'string' ? input.emergencyContactRelationship.slice(0, 80) : '',
    emergencyContactPhone: typeof input.emergencyContactPhone === 'string' ? input.emergencyContactPhone.slice(0, 50) : '',
    emergencyContactAddress: typeof input.emergencyContactAddress === 'string' ? input.emergencyContactAddress.slice(0, 500) : '',
    emergencyContactAddressMode: input.emergencyContactAddressMode === 'replace' ? 'replace' : 'preserve',
    emergencyContactAddressBlockLotStreetPurok: typeof input.emergencyContactAddressBlockLotStreetPurok === 'string' ? input.emergencyContactAddressBlockLotStreetPurok.slice(0, 200) : '',
    emergencyContactAddressBarangay: typeof input.emergencyContactAddressBarangay === 'string' ? input.emergencyContactAddressBarangay.slice(0, 100) : '',
    emergencyContactAddressCity: typeof input.emergencyContactAddressCity === 'string' ? input.emergencyContactAddressCity.slice(0, 100) : '',
    emergencyContactAddressProvince: typeof input.emergencyContactAddressProvince === 'string' ? input.emergencyContactAddressProvince.slice(0, 100) : '',
    emergencyContactAddressZip: typeof input.emergencyContactAddressZip === 'string' ? input.emergencyContactAddressZip.slice(0, 4) : '',
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
    addressMode: 'preserve',
    addressBlockLotStreetPurok: student.address_block_lot_street_purok,
    addressBarangay: student.address_barangay,
    addressCity: student.address_city,
    addressProvince: student.address_province,
    addressZip: student.address_zip,
    phone: student.phone,
    birthplace: student.birthplace,
    facebookName: student.facebook_name,
    emergencyContactPerson: student.emergency_contact_person,
    emergencyContactRelationship: student.emergency_contact_relationship,
    emergencyContactPhone: student.emergency_contact_phone,
    emergencyContactAddress: student.emergency_contact_address,
    emergencyContactAddressMode: 'preserve',
    emergencyContactAddressBlockLotStreetPurok: student.emergency_contact_address_block_lot_street_purok,
    emergencyContactAddressBarangay: student.emergency_contact_address_barangay,
    emergencyContactAddressCity: student.emergency_contact_address_city,
    emergencyContactAddressProvince: student.emergency_contact_address_province,
    emergencyContactAddressZip: student.emergency_contact_address_zip,
    motherName: student.mother_name,
    motherPhone: student.mother_phone,
    fatherName: student.father_name,
    fatherPhone: student.father_phone
  });
}

function isUniqueStudentConflict(error) {
  return normalizeUniqueConflict(error);
}

function academicYearStart(value) {
  if (typeof value !== 'string' || !/^(\d{4})-(\d{4})$/.test(value)) return null;
  const [, start, end] = value.match(/^(\d{4})-(\d{4})$/);
  const year = Number(start);
  return Number(end) === year + 1 ? year : null;
}

function lastRecordedEnrollment(enrollments = [], eligibility = null) {
  const rows = (Array.isArray(enrollments) ? enrollments : [])
    .filter((row) => row.term_scope_status !== 'not_applicable' && academicYearStart(row.school_year) !== null);
  if (!rows.length) return null;
  const latestYear = Math.max(...rows.map((row) => academicYearStart(row.school_year)));
  const latestYearRows = rows.filter((row) => academicYearStart(row.school_year) === latestYear);
  const departure = eligibility?.departure;
  if (eligibility?.basis === 'recorded_departure' && departure
    && academicYearStart(departure.schoolYear) === latestYear && departure.effectiveEnrollmentId) {
    const effective = latestYearRows.find((row) => Number(row.id) === departure.effectiveEnrollmentId);
    if (effective) return effective;
  }
  const participation = latestYearRows.filter((row) => ['enrolled', 'pending_payment'].includes(row.enrollment_status));
  const candidates = participation.length ? participation
    : latestYearRows.filter((row) => ['dropped', 'transferred'].includes(row.enrollment_status));
  if (candidates.length === 1) return candidates[0];
  if (candidates.some((row) => !(Number.isSafeInteger(Number(row.term_number)) && Number(row.term_number) > 0))) return null;
  const ordered = candidates.filter((row) => Number.isSafeInteger(Number(row.term_number)) && Number(row.term_number) > 0);
  if (!ordered.length) return null;
  const latestTermNumber = Math.max(...ordered.map((row) => Number(row.term_number)));
  const latestTermRows = ordered.filter((row) => Number(row.term_number) === latestTermNumber);
  return latestTermRows.length === 1 ? latestTermRows[0] : null;
}

function repeatedFields(body, fieldName) {
  const value = body?.[fieldName];
  return value == null ? [] : (Array.isArray(value) ? value : [value]).map((item) => typeof item === 'string' ? item.slice(0, 500) : '');
}

function paperTeacherRowsFromBody(body) {
  const codes = repeatedFields(body, 'paperSubjectCode');
  const names = repeatedFields(body, 'paperSubjectName');
  return Array.from({ length: Math.max(codes.length, names.length) }, (_, index) => ({
    subjectCode: codes[index] || '', subjectName: names[index] || ''
  })).filter((row) => row.subjectCode.trim() || row.subjectName.trim());
}

function clearanceItemsFromBody(body) {
  const ids = new Set();
  for (const key of Object.keys(body || {})) {
    const match = /^item_(\d+)_applicabilityStatus$/.exec(key);
    if (match && match[1].length <= 10 && ids.size < 180) ids.add(match[1]);
  }
  return [...ids].map((rawId) => ({
    itemId: rawId,
    signaturePresent: body[`item_${rawId}_signaturePresent`] === '1',
    signerName: typeof body[`item_${rawId}_signerName`] === 'string' ? body[`item_${rawId}_signerName`] : '',
    paperSignedOn: typeof body[`item_${rawId}_paperSignedOn`] === 'string' ? body[`item_${rawId}_paperSignedOn`] : '',
    signerContextReason: typeof body[`item_${rawId}_signerContextReason`] === 'string' ? body[`item_${rawId}_signerContextReason`] : '',
    applicabilityStatus: body[`item_${rawId}_applicabilityStatus`],
    applicabilityReason: typeof body[`item_${rawId}_applicabilityReason`] === 'string' ? body[`item_${rawId}_applicabilityReason`] : ''
  }));
}

function boundedString(body, key, maxLength) {
  return typeof body?.[key] === 'string' ? body[key].slice(0, maxLength) : '';
}

function safeClearanceFormValues(body = {}) {
  const token = boundedString(body, 'idempotencyKey', 36);
  const itemsById = Object.fromEntries(clearanceItemsFromBody(body).slice(0, 180).map((item) => [item.itemId, {
    applicabilityStatus: ['required', 'not_applicable', 'unreviewed'].includes(item.applicabilityStatus) ? item.applicabilityStatus : '',
    applicabilityReason: item.applicabilityReason.slice(0, 1000), signaturePresent: item.signaturePresent,
    signerName: item.signerName.slice(0, 160), paperSignedOn: item.paperSignedOn.slice(0, 10),
    signerContextReason: item.signerContextReason.slice(0, 1000)
  }]));
  return {
    idempotencyKey: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token) ? token : crypto.randomUUID(),
    expectedVersion: /^\d{1,10}$/.test(boundedString(body, 'expectedVersion', 10)) ? body.expectedVersion : '',
    scopeStatus: ['attended', 'not_attended'].includes(body.scopeStatus) ? body.scopeStatus : '',
    scopeReason: boundedString(body, 'scopeReason', 1000),
    templateId: /^\d{1,10}$/.test(boundedString(body, 'templateId', 10)) ? body.templateId : '',
    templateSelectionReason: boundedString(body, 'templateSelectionReason', 1000),
    correctionReason: boundedString(body, 'correctionReason', 1000),
    inspectedOn: boundedString(body, 'inspectedOn', 10),
    clearanceAction: ['prepare', 'complete', 'reopen'].includes(body.clearanceAction) ? body.clearanceAction : '',
    rosterReviewed: body.rosterReviewed === '1',
    rosterReconciliationReason: boundedString(body, 'rosterReconciliationReason', 1000),
    paperTeacherRows: paperTeacherRowsFromBody(body).slice(0, 8).map((row) => ({
      subjectCode: row.subjectCode.slice(0, 50), subjectName: row.subjectName.slice(0, 200)
    })),
    itemsById
  };
}

function safeClearanceTemplateValues(body = {}) {
  const token = boundedString(body, 'idempotencyKey', 36);
  return {
    idempotencyKey: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token) ? token : crypto.randomUUID(),
    gradeLevel: ['Grade 11', 'Grade 12'].includes(body.gradeLevel) ? body.gradeLevel : '',
    trackLabel: boundedString(body, 'trackLabel', 80),
    officeConfirmations: repeatedFields(body, 'officeConfirmations').filter((office) => ['registrar', 'guidance', 'finance'].includes(office)).slice(0, 3),
    teacherRosterConfirmed: body.teacherRosterConfirmed === '1',
    laboratoryRowsConfirmed: body.laboratoryRowsConfirmed === '1',
    laboratoryLabels: repeatedFields(body, 'laboratoryLabel').slice(0, 8).map((label) => label.slice(0, 120))
  };
}

function clearanceFormAttempt(body, kind, rawRecordId) {
  const recordId = normalizeRecordId(rawRecordId);
  return recordId ? { kind, recordId, values: safeClearanceFormValues(body) } : null;
}

function createStudentRecordsRouter({ getPool, sql, studentRecordsService, academicRecordsService, documentRequestService, documentClearanceService, gradeOverviewService, readmissionService, termClearanceService } = {}) {
  const router = express.Router();
  const service = studentRecordsService || createStudentRecordsService({ getPool, sql });
  const academics = academicRecordsService || createAcademicRecordsService({ getPool, sql });
  const documentRequests = documentRequestService || (studentRecordsService
    ? { async getStudentRequests() { return []; } }
    : createStudentDocumentRequestService({ getPool, sql }));
  const documentClearance = documentClearanceService || createStudentDocumentFinanceClearanceService({ getPool, sql });
  const gradeOverview = gradeOverviewService || createRegistrarGradeOverviewService({ getPool, sql });
  const readmissions = readmissionService || createReadmissionService({ getPool, sql });
  const termClearances = termClearanceService || createTermClearanceService({ getPool, sql });

  async function loadWorkspace(search = '', termId = '', page = 1) {
    return service.listWorkspace(search, termId, page);
  }

  async function renderDashboard(req, res, { status = 200, error = null, notice = null, search = '', termId = '', page = 1, openForm = null, formValues = {}, view = 'records', returnStatus = '' } = {}) {
    try {
      if (view === 'setup') {
        const navigation = buildNavigation(req.authUser.role, '/registrar/records?view=setup');
        res.locals.navigationItems = navigation.items;
        res.locals.navigationGroups = navigation.groups;
        res.locals.currentPage = navigation.currentPage;
      }
      const workspace = await loadWorkspace(search, termId, page);
      const unlinkedEvaluations = view === 'records' && String(search || '').trim()
        ? await readmissions.searchUnlinkedMatches(req.authUser.id, search, returnStatus) : [];
      const setupTerms = workspace.terms || [];
      const setupSections = workspace.sections || [];
      const requestedOpenForm = ['term', 'section'].includes(req.query?.openForm) ? req.query.openForm : null;
      const requestedSetupTermId = typeof req.query?.termId === 'string' ? req.query.termId : '';
      const currentSetupTerm = setupTerms.find((term) => term.is_current === true || term.is_current === 1) || null;
      const selectedSetupTerm = setupTerms.find((term) => String(term.id) === requestedSetupTermId) || currentSetupTerm;
      const formSectionTermId = formValues.academicTermId || selectedSetupTerm?.id || '';
      const setupNeedsSection = Boolean(selectedSetupTerm)
        && !setupSections.some((section) => Number(section.academic_term_id) === Number(selectedSetupTerm.id));
      const defaultOpenForm = setupTerms.length === 0 ? 'term' : setupNeedsSection ? 'section' : null;
      return res.status(status).render('records/index', {
        title: 'Student Records',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        notice,
        error,
        view,
        unlinkedEvaluations,
        returnStatus,
        openForm: openForm || requestedOpenForm || (view === 'setup' ? defaultOpenForm : null),
        formValues: { ...formValues, ...(formSectionTermId ? { academicTermId: formSectionTermId } : {}) },
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
      if (!record && !Object.keys(values).length) {
        formValues.addressMode = 'replace';
        formValues.emergencyContactAddressMode = 'replace';
      }
      if (record && req.authUser.role === 'registrar') formValues.studentNo = record.student.student_no;
      return res.status(status).render('records/student-form', {
        title: studentId === null ? 'Create Student Profile' : 'Student Record',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        student: record?.student || null,
        terms: record?.terms || workspace.terms,
        sections: record?.sections || workspace.sections,
        enrollments: record?.enrollments || [],
        annualEnrollments: record?.annualEnrollments || [],
        values: formValues,
        maxBirthDate: latestBirthDate(),
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
    requestValues = {}, requestIdempotencyKey = null, returnEvaluation = null, returnEvaluationValues = {},
    returnEvaluationError = null, returnEvaluationExpectedVersion = null
  } = {}) {
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      const clearanceOverviewPromise = view === 'overview' && termClearances.getStudentClearanceOverview
        ? termClearances.getStudentClearanceOverview(req.authUser.id, studentId).then((overview) => ({ overview, unavailable: false })).catch((loadError) => {
          if (loadError instanceof TermClearanceSummaryUnavailableError) return { overview: null, unavailable: true };
          throw loadError;
        })
        : Promise.resolve({ overview: null, unavailable: false });
      const [record, academicRecord, documentRequestRows, revisions, clearanceData, returnEvaluations, returnEligibility, clearanceResult] = await Promise.all([
        service.getStudent(studentId),
        academics.getStudentAcademicRecord(studentId),
        documentRequests.getStudentRequests ? documentRequests.getStudentRequests(req.authUser.id, studentId) : [],
        service.listStudentProfileRevisions ? service.listStudentProfileRevisions(req.authUser.id, studentId) : [],
        documentClearance.getRegistrarData(req.authUser.id, studentId),
        readmissions.listForStudent ? readmissions.listForStudent(req.authUser.id, studentId) : [],
        readmissions.getStudentReturnEligibility ? readmissions.getStudentReturnEligibility(req.authUser.id, studentId) : { eligible: false },
        clearanceOverviewPromise
      ]);
      if (!record || !academicRecord) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
      const lastEnrollment = lastRecordedEnrollment(academicRecord.enrollments, returnEligibility);
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
        returnEvaluationError, returnEvaluation, returnEvaluationValues, returnEvaluationExpectedVersion, returnEvaluations, returnEligibility,
        requestForm, requestFormId: requestId, requestFormValues: requestValues,
        student: record.student, enrollments: academicRecord.enrollments,
        annualEnrollments: record.annualEnrollments || [], lastEnrollment,
        documentRequests: documentRequestRows, profileRevisions: revisions,
        clearanceOverview: clearanceResult.overview,
        clearanceOverviewUnavailable: clearanceResult.unavailable,
        financeSummary: clearanceData.financeSummary, requestClearanceData,
        newDocumentRequestKey: requestIdempotencyKey || crypto.randomUUID(), requestIdempotencyKeys, correctionIdempotencyKeys,
        claimSlipIdempotencyKeys
      });
    } catch (loadError) {
      if (loadError instanceof TermClearanceError) {
        return res.status(loadError.status).render('error', {
          title: loadError.status === 403 ? 'Forbidden' : 'Student record unavailable', message: loadError.message
        });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The student record could not be loaded.' });
    }
  }

  async function renderTermClearance(req, res, studentIdInput, {
    status = 200, error = null, completionAttempt = null, scopeAttempt = null, staleEnrollmentId = null,
    staleScopeEnrollmentId = null
  } = {}) {
    const studentId = normalizeRecordId(studentIdInput);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      const data = await termClearances.getStudentClearance(req.authUser.id, studentId);
      for (const term of data.terms) {
        term.completionToken = crypto.randomUUID();
        term.scopeToken = crypto.randomUUID();
        if (completionAttempt && Number(completionAttempt.enrollmentId) === Number(term.enrollment_id)) {
          term.completionAttempt = completionAttempt;
          term.completionToken = completionAttempt.values.idempotencyKey;
        }
        if (scopeAttempt && Number(scopeAttempt.enrollmentId) === Number(term.enrollment_id)) {
          term.scopeAttempt = scopeAttempt;
          term.scopeToken = scopeAttempt.values.idempotencyKey;
        }
        if (staleEnrollmentId != null && Number(staleEnrollmentId) === Number(term.enrollment_id)) term.completionConflict = true;
        if (staleScopeEnrollmentId != null && Number(staleScopeEnrollmentId) === Number(term.enrollment_id)) term.scopeConflict = true;
      }
      return res.status(status).set('Cache-Control', 'private, no-store').render('records/student-clearance', {
        title: 'Paper clearance', currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
        student: data.student, terms: data.terms, error, staleEnrollmentId,
        notice: req.query?.notice === 'scopeSaved' ? 'Term attendance exception saved.'
          : req.query?.notice === 'saved' ? 'Paper clearance status saved.' : null
      });
    } catch (loadError) {
      if (loadError instanceof TermClearanceSummaryUnavailableError) {
        return res.status(503).render('error', {
          title: 'Paper clearance unavailable', message: CLEARANCE_SCHEMA_UNAVAILABLE_MESSAGE
        });
      }
      if (loadError instanceof TermClearanceError) return res.status(loadError.status).render('error', { title: 'Paper clearance unavailable', message: loadError.message });
      return res.status(503).render('error', { title: 'Paper clearance unavailable', message: 'Student paper-clearance records could not be loaded.' });
    }
  }

  async function renderClearanceDashboard(req, res, filterInput = req.query || {}) {
    try {
      const dashboard = await termClearances.getClearanceDashboard(req.authUser.id, filterInput);
      return res.status(200).set('Cache-Control', 'private, no-store').render('records/clearance-dashboard', {
        title: 'Clearance', currentUser: req.authUser, ...dashboard
      });
    } catch (loadError) {
      if (loadError instanceof TermClearanceSummaryUnavailableError) {
        return res.status(503).render('error', {
          title: 'Paper clearance unavailable', message: CLEARANCE_SCHEMA_UNAVAILABLE_MESSAGE
        });
      }
      if (loadError instanceof TermClearanceError) {
        return res.status(loadError.status).render('error', { title: 'Clearance unavailable', message: loadError.message });
      }
      return res.status(503).render('error', { title: 'Clearance unavailable', message: 'The clearance workspace could not be loaded.' });
    }
  }

  async function renderClearanceTemplates(req, res, { status = 200, error = null, values = {}, recoveryNotice = null } = {}) {
    try {
      const data = await termClearances.listTemplates(req.authUser.id);
      return res.status(status).set('Cache-Control', 'private, no-store').render('records/term-clearance-templates', {
        title: 'Paper-clearance templates', currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
        templates: data.templates, values, error, recoveryNotice, idempotencyKey: values.idempotencyKey || crypto.randomUUID(),
        notice: req.query?.notice === 'saved' ? 'A new approved template version was saved.' : null
      });
    } catch (loadError) {
      if (loadError instanceof TermClearanceError) return res.status(loadError.status).render('error', { title: 'Paper-clearance templates unavailable', message: loadError.message });
      return res.status(503).render('error', { title: 'Paper-clearance templates unavailable', message: 'Approved paper-clearance templates could not be loaded.' });
    }
  }

  router.get('/', (req, res) => renderDashboard(req, res, {
    search: req.query.search === undefined ? '' : req.query.search,
    termId: req.query.termId === undefined ? '' : req.query.termId,
    page: req.query.page === undefined ? 1 : req.query.page,
    view: req.query.view === 'setup' ? 'setup' : 'records',
    returnStatus: typeof req.query.returnStatus === 'string' ? req.query.returnStatus : '',
    notice: notices[req.query.notice] || null
  }));

  function renderUnlinkedEvaluation(req, res, { evaluation = null, values = {}, error = null, status = 200, expectedVersion = null } = {}) {
    return res.status(status).set('Cache-Control', 'private, no-store').render('records/unlinked-return-evaluation', {
      title: evaluation ? 'Return evaluation' : 'New return evaluation', currentUser: req.authUser,
      csrfToken: ensureCsrfToken(req), evaluation, values, error, expectedVersion
    });
  }

  async function renderStudentEvaluation(req, res, { status = 200, evaluationId = null, values = {}, error = null, expectedVersion = null } = {}) {
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    let returnEvaluation = null;
    if (evaluationId) {
      try {
        returnEvaluation = await readmissions.getForStudent(req.authUser.id, studentId, evaluationId);
      } catch (loadError) {
        const message = loadError instanceof ReadmissionError ? loadError.message : 'The return evaluation could not be loaded.';
        return res.status(loadError instanceof ReadmissionError ? loadError.status : 503).render('error', { title: 'Return evaluation unavailable', message });
      }
    }
    return renderStudentOverview(req, res, {
      status, view: 'return-evaluation', returnEvaluation, returnEvaluationValues: values,
      returnEvaluationError: error, returnEvaluationExpectedVersion: expectedVersion
    });
  }

  const savedStudentRequired = (res) => res.status(409).render('error', {
    title: 'Saved student record required',
    message: 'Return evaluations can only be started from an eligible saved student record. Search Student records by name or LRN; if no record matches, resolve the student record before beginning this review.',
    errorRecovery: { href: '/registrar/records', label: 'Search student records' }
  });

  router.get('/return-evaluations/new', (req, res) => req.authUser.role === 'registrar'
    ? savedStudentRequired(res)
    : res.status(403).render('error', { title: 'Read-only access', message: 'Database administrators can review return evaluations but cannot create them.' }));

  router.post('/return-evaluations', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    if (req.authUser.role !== 'registrar') return res.status(403).render('error', {
      title: 'Read-only access', message: 'Database administrators can review return evaluations but cannot create them.'
    });
    return savedStudentRequired(res);
  });

  router.get('/return-evaluations/:evaluationId', async (req, res) => {
    try {
      const evaluation = await readmissions.get(req.authUser.id, req.params.evaluationId);
      if (evaluation.student_id) return res.redirect(303, `/registrar/records/students/${encodeURIComponent(evaluation.student_id)}/return-evaluations/${encodeURIComponent(evaluation.id)}`);
      return renderUnlinkedEvaluation(req, res, { evaluation });
    } catch (error) {
      if (error instanceof ReadmissionError) return res.status(error.status).render('error', { title: 'Return evaluation unavailable', message: error.message });
      return res.status(503).render('error', { title: 'Return evaluation unavailable', message: 'The evaluation could not be loaded.' });
    }
  });

  router.post('/return-evaluations/:evaluationId', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await readmissions.update(req.authUser.id, req.params.evaluationId, req.body?.version, req.body || {}, null, true);
      return res.redirect(303, `/registrar/records/return-evaluations/${encodeURIComponent(req.params.evaluationId)}`);
    } catch (error) {
      if (error instanceof ReadmissionError) {
        try {
          const evaluation = await readmissions.get(req.authUser.id, req.params.evaluationId);
          if (evaluation.student_id) return res.redirect(303, `/registrar/records/students/${encodeURIComponent(evaluation.student_id)}/return-evaluations/${encodeURIComponent(evaluation.id)}`);
          return renderUnlinkedEvaluation(req, res, {
            evaluation, values: error.status === 409 ? {} : req.body || {}, expectedVersion: req.body?.version,
            error: error.message, status: error.status
          });
        } catch { return res.status(error.status).render('error', { title: 'Return evaluation unavailable', message: error.message }); }
      }
      return res.status(503).render('error', { title: 'Return evaluation unavailable', message: 'The evaluation could not be saved.' });
    }
  });

  router.post('/return-evaluations/:evaluationId/decision', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await readmissions.decide(req.authUser.id, req.params.evaluationId, req.body?.version, req.body?.decision, req.body?.decisionReason, null, true);
      return res.redirect(303, `/registrar/records/return-evaluations/${encodeURIComponent(req.params.evaluationId)}`);
    } catch (error) {
      if (error instanceof ReadmissionError) {
        try {
          const evaluation = await readmissions.get(req.authUser.id, req.params.evaluationId);
          if (evaluation.student_id) return res.redirect(303, `/registrar/records/students/${encodeURIComponent(evaluation.student_id)}/return-evaluations/${encodeURIComponent(evaluation.id)}`);
          return renderUnlinkedEvaluation(req, res, { evaluation, expectedVersion: req.body?.version, error: error.message, status: error.status });
        } catch { return res.status(error.status).render('error', { title: 'Return evaluation unavailable', message: error.message }); }
      }
      return res.status(503).render('error', { title: 'Return evaluation unavailable', message: 'The decision could not be saved.' });
    }
  });

  router.get('/students/:id/return-evaluations/new', async (req, res) => {
    if (req.authUser.role !== 'registrar') {
      return res.status(403).render('error', { title: 'Read-only access', message: 'Database administrators can review return evaluations but cannot create them.' });
    }
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      const eligibility = await readmissions.getStudentReturnEligibility(req.authUser.id, studentId);
      if (!eligibility.eligible) return renderStudentOverview(req, res, {
        status: 409, view: 'overview', error: 'A return evaluation can be started only after a recorded departure or an established school-year break.'
      });
      return renderStudentEvaluation(req, res);
    } catch (error) {
      if (error instanceof ReadmissionError) return res.status(error.status).render('error', { title: 'Return evaluation unavailable', message: error.message });
      return res.status(503).render('error', { title: 'Return evaluation unavailable', message: 'The student history could not be checked.' });
    }
  });

  router.post('/students/:id/return-evaluations', async (req, res) => {
    if (req.authUser.role !== 'registrar') return res.status(403).render('error', {
      title: 'Read-only access', message: 'Database administrators can review return evaluations but cannot create them.'
    });
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      const eligibility = await readmissions.getStudentReturnEligibility(req.authUser.id, studentId);
      if (!eligibility.eligible) return renderStudentOverview(req, res, {
        status: 409, view: 'overview', error: 'A return evaluation can be started only after a recorded departure or an established school-year break.'
      });
      const result = await readmissions.createForStudent(req.authUser.id, studentId, req.body || {});
      return res.redirect(303, `/registrar/records/students/${studentId}/return-evaluations/${encodeURIComponent(result.id)}`);
    } catch (error) {
      if (error instanceof ReadmissionError && error.code === 'RETURN_INELIGIBLE') return renderStudentOverview(req, res, {
        status: error.status, view: 'overview', error: error.message
      });
      if (error instanceof ReadmissionError) return renderStudentEvaluation(req, res, {
        status: error.status, values: error.status === 409 ? {} : req.body || {}, expectedVersion: req.body?.version, error: error.message
      });
      return res.status(503).render('error', { title: 'Return evaluation unavailable', message: 'The evaluation could not be saved.' });
    }
  });

  router.get('/students/:id/return-evaluations/:evaluationId', async (req, res) => renderStudentEvaluation(req, res, { evaluationId: req.params.evaluationId }));

  router.post('/students/:id/return-evaluations/:evaluationId', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await readmissions.update(req.authUser.id, req.params.evaluationId, req.body?.version, req.body || {}, studentId);
      return res.redirect(303, `/registrar/records/students/${studentId}/return-evaluations/${encodeURIComponent(req.params.evaluationId)}`);
    } catch (error) {
      if (error instanceof ReadmissionError) return renderStudentEvaluation(req, res, {
        status: error.status, evaluationId: req.params.evaluationId, values: error.status === 409 ? {} : req.body || {},
        expectedVersion: req.body?.version, error: error.message
      });
      return res.status(503).render('error', { title: 'Return evaluation unavailable', message: 'The evaluation could not be saved.' });
    }
  });

  router.post('/students/:id/return-evaluations/:evaluationId/decision', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    const studentId = normalizeRecordId(req.params.id);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await readmissions.decide(req.authUser.id, req.params.evaluationId, req.body?.version, req.body?.decision, req.body?.decisionReason, studentId);
      return res.redirect(303, `/registrar/records/students/${studentId}/return-evaluations/${encodeURIComponent(req.params.evaluationId)}`);
    } catch (error) {
      if (error instanceof ReadmissionError) return renderStudentEvaluation(req, res, {
        status: error.status, evaluationId: req.params.evaluationId, expectedVersion: req.body?.version, error: error.message
      });
      return res.status(503).render('error', { title: 'Return evaluation unavailable', message: 'The decision could not be saved.' });
    }
  });

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

  router.get('/clearance', (req, res) => renderClearanceDashboard(req, res));
  router.get('/clearance/templates', (req, res) => res.redirect(303, '/registrar/records/clearance'));
  router.post('/clearance/templates', (req, res) => {
    if (req.authUser.role !== 'registrar') return res.status(403).render('error', {
      title: 'Forbidden', message: 'Only registrars can change paper-clearance settings.'
    });
    return res.status(410).render('error', {
    title: 'Paper-clearance setup retired',
    message: 'Paper clearance is now recorded as one registrar-confirmed completion for each term.'
    });
  });

  router.get('/students/:id/clearance', (req, res) => renderTermClearance(req, res, req.params.id));
  router.post('/students/:id/clearance/terms/:enrollmentId', async (req, res) => {
    if (req.authUser.role !== 'registrar') return res.status(403).render('error', { title: 'Forbidden', message: 'Only registrars can record paper clearance completion.' });
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      await termClearances.recordTermCompletion(req.authUser.id, req.params.enrollmentId, {
        paperCompleted: req.body?.paperCompleted,
        expectedVersion: req.body?.expectedVersion,
        correctionReason: req.body?.correctionReason,
        idempotencyKey: req.body?.idempotencyKey
      }, req.params.id);
      return res.redirect(303, `/registrar/records/students/${encodeURIComponent(req.params.id)}/clearance?notice=saved`);
    } catch (error) {
      if (error instanceof TermClearanceError) {
        const version = boundedString(req.body, 'expectedVersion', 10);
        const token = boundedString(req.body, 'idempotencyKey', 36);
        const values = {
          paperCompleted: req.body?.paperCompleted === '1',
          correctionReason: boundedString(req.body, 'correctionReason', 1000),
          expectedVersion: /^\d{1,10}$/.test(version) ? version : '0',
          idempotencyKey: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token) ? token : crypto.randomUUID()
        };
        if (error.status === 409) return renderTermClearance(req, res, req.params.id, {
          status: error.status, error: error.message, staleEnrollmentId: req.params.enrollmentId
        });
        return renderTermClearance(req, res, req.params.id, { status: error.status, error: error.message,
          completionAttempt: { enrollmentId: req.params.enrollmentId, values } });
      }
      return res.status(503).render('error', { title: 'Paper clearance unavailable', message: 'The paper clearance status could not be saved.' });
    }
  });
  router.post('/students/:id/clearance/terms/:enrollmentId/not-attended', async (req, res) => {
    if (req.authUser.role !== 'registrar') return res.status(403).render('error', { title: 'Forbidden', message: 'Only registrars can record a whole-term attendance exception.' });
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      await termClearances.recordTermNotAttended(req.authUser.id, req.params.enrollmentId, {
        scopeReason: req.body?.scopeReason,
        expectedVersion: req.body?.expectedVersion,
        idempotencyKey: req.body?.idempotencyKey
      }, req.params.id);
      return res.redirect(303, `/registrar/records/students/${encodeURIComponent(req.params.id)}/clearance?notice=scopeSaved`);
    } catch (error) {
      if (error instanceof TermClearanceError) {
        const version = boundedString(req.body, 'expectedVersion', 10);
        const token = boundedString(req.body, 'idempotencyKey', 36);
        const values = {
          scopeReason: boundedString(req.body, 'scopeReason', 1000),
          expectedVersion: /^\d{1,10}$/.test(version) ? version : '0',
          idempotencyKey: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token) ? token : crypto.randomUUID()
        };
        if (error.status === 409) return renderTermClearance(req, res, req.params.id, {
          status: error.status, error: error.message, staleScopeEnrollmentId: req.params.enrollmentId
        });
        return renderTermClearance(req, res, req.params.id, { status: error.status, error: error.message,
          scopeAttempt: { enrollmentId: req.params.enrollmentId, values } });
      }
      return res.status(503).render('error', { title: 'Paper clearance unavailable', message: 'The term attendance exception could not be saved.' });
    }
  });
  router.post('/students/:id/clearance/records/:clearanceId', async (req, res) => {
    if (req.authUser.role !== 'registrar') return res.status(403).render('error', { title: 'Forbidden', message: 'Only registrars can update paper-clearance records.' });
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    return res.status(410).render('error', {
      title: 'Signature checklist retired',
      message: 'Use the term checkbox to record whether the registrar inspected the returned paper form.'
    });
  });

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

module.exports = { createStudentRecordsRouter, studentValues, valuesFromStudent, lastRecordedEnrollment };
