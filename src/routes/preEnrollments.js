'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { PreEnrollmentError, RECEIPT_REQUIREMENTS, createPreEnrollmentService } = require('../services/preEnrollmentService');

const DEFAULT_SCHOOL_YEAR = '2027-2028';

function recordFormValues(record) {
  if (!record) return {};
  return {
    schoolYear: record.school_year, firstName: record.first_name, middleName: record.middle_name,
    lastName: record.last_name, suffix: record.suffix, lrn: record.lrn,
    studentContactNumber: record.student_contact_number, voucherTypeText: record.voucher_type_text,
    voucherCategoryText: record.voucher_category_text, preferredTrack: record.preferred_track,
    preferredCluster: record.preferred_cluster, targetGradeLevel: record.target_grade_level,
    priorGradeLevel: record.prior_grade_level, priorSchool: record.prior_school,
    studentSignaturePresent: record.student_signature_present, studentSignedDate: record.student_signed_date,
    receivedBy: record.received_by, receivedDate: record.received_date, status: record.status,
    applicantKind: record.applicant_kind, email: record.email, birthDate: record.birth_date, sex: record.sex,
    address: record.address, addressBlockLotStreetPurok: record.address_block_lot_street_purok,
    addressBarangay: record.address_barangay, addressCity: record.address_city, addressProvince: record.address_province,
    addressZip: record.address_zip, profilePhone: record.profile_phone, birthplace: record.birthplace,
    facebookName: record.facebook_name, emergencyContactPerson: record.emergency_contact_person,
    emergencyContactRelationship: record.emergency_contact_relationship,
    emergencyContactPhone: record.emergency_contact_phone, emergencyContactAddress: record.emergency_contact_address,
    emergencyContactAddressBlockLotStreetPurok: record.emergency_contact_address_block_lot_street_purok,
    emergencyContactAddressBarangay: record.emergency_contact_address_barangay,
    emergencyContactAddressCity: record.emergency_contact_address_city,
    emergencyContactAddressProvince: record.emergency_contact_address_province,
    emergencyContactAddressZip: record.emergency_contact_address_zip,
    motherName: record.mother_name, motherPhone: record.mother_phone, fatherName: record.father_name,
    fatherPhone: record.father_phone, readmissionEvaluationId: record.readmission_evaluation_id,
    readmissionEvaluationVersion: record.readmission_evaluation_version
  };
}

function createPreEnrollmentRouter({ getPool, sql, preEnrollmentService } = {}) {
  const router = express.Router();
  const service = preEnrollmentService || createPreEnrollmentService({ getPool, sql });
  const privateHeaders = (res) => res.set('Cache-Control', 'private, no-store');

  async function renderForm(req, res, { record = null, values = {}, error = null, status = 200 } = {}) {
    const receipts = new Map((record?.receipts || []).map((receipt) => [receipt.requirement_code, receipt]));
    const receiptValues = {};
    for (const [code] of RECEIPT_REQUIREMENTS) {
      const receipt = receipts.get(code);
      receiptValues[`receipt_${code}_original`] = receipt?.original_received ? '1' : '';
      receiptValues[`receipt_${code}_original_pieces`] = receipt?.original_pieces ?? '';
      receiptValues[`receipt_${code}_photocopy`] = receipt?.photocopy_received ? '1' : '';
      receiptValues[`receipt_${code}_photocopy_pieces`] = receipt?.photocopy_pieces ?? '';
    }
    let acceptedReadmissionChoices = [];
    if (['front_desk', 'registrar'].includes(req.authUser.role) && service.listAcceptedReadmissionChoices) {
      try { acceptedReadmissionChoices = await service.listAcceptedReadmissionChoices(req.authUser.id, values.schoolYear || record?.school_year || ''); }
      catch (loadError) {
        if (loadError instanceof PreEnrollmentError) return res.status(loadError.status).render('error', { title: 'Return evaluation choices', message: loadError.message });
        return res.status(503).render('error', { title: 'Return evaluation choices', message: 'Accepted return evaluations could not be loaded.' });
      }
    }
    return privateHeaders(res).status(status).render('pre-enrollments/form', {
      title: record ? 'Correct pre-enrollment record' : 'Record paper pre-enrollment',
      currentUser: req.authUser, csrfToken: ensureCsrfToken(req), record,
      values: {
        schoolYear: DEFAULT_SCHOOL_YEAR, status: 'draft', applicantKind: 'new', studentSignaturePresent: '',
        receivedDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()),
        ...recordFormValues(record), ...receiptValues, ...values
      },
      requirements: RECEIPT_REQUIREMENTS, acceptedReadmissionChoices, error
    });
  }

  async function renderList(req, res, { error = null, status = 200 } = {}) {
    try {
      const result = await service.list(req.authUser.id, req.query || {});
      return privateHeaders(res).status(status).render('pre-enrollments/index', {
        title: 'Pre-enrollment records', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), ...result, error
      });
    } catch (loadError) {
      if (loadError instanceof PreEnrollmentError) return res.status(loadError.status).render('error', { title: 'Pre-enrollment records', message: loadError.message });
      return res.status(503).render('error', { title: 'Pre-enrollment unavailable', message: 'Paper pre-enrollment records could not be loaded.' });
    }
  }

  router.get('/', (req, res) => renderList(req, res));
  router.get('/new', async (req, res) => {
    if (req.authUser.role !== 'front_desk') return res.status(403).render('error', { title: 'Forbidden', message: 'Only front-desk staff can create a paper pre-enrollment record.' });
    try {
      const receivedBy = await service.getActorDisplayName(req.authUser.id);
      return renderForm(req, res, { values: { idempotencyKey: crypto.randomUUID(), receivedBy } });
    } catch (error) {
      if (error instanceof PreEnrollmentError) return res.status(error.status).render('error', { title: 'Pre-enrollment record', message: error.message });
      return res.status(503).render('error', { title: 'Pre-enrollment unavailable', message: 'A paper record form could not be opened.' });
    }
  });
  router.post('/', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    if (req.authUser.role === 'database_admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Database administrators can view pre-enrollment records but cannot create them.' });
    try {
      const created = await service.create(req.authUser.id, { ...(req.body || {}), actorName: req.authUser.email });
      return res.redirect(303, `/pre-enrollments/${encodeURIComponent(created.id)}?notice=${created.alreadyCreated ? 'alreadySaved' : 'saved'}`);
    } catch (error) {
      if (error instanceof PreEnrollmentError) return renderForm(req, res, { status: error.status, error: error.message, values: req.body || {} });
      if (error?.code === 'ER_DUP_ENTRY') return renderForm(req, res, { status: 409, error: 'A record with this school year and complete LRN already exists.', values: req.body || {} });
      return res.status(503).render('error', { title: 'Pre-enrollment unavailable', message: 'The paper pre-enrollment record could not be saved.' });
    }
  });
  router.get('/:id/edit', async (req, res) => {
    if (req.authUser.role === 'database_admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Database administrators have read-only access to pre-enrollment records.' });
    try { return renderForm(req, res, { record: await service.get(req.authUser.id, req.params.id) }); }
    catch (error) {
      if (error instanceof PreEnrollmentError) return res.status(error.status).render('error', { title: 'Pre-enrollment record', message: error.message });
      return res.status(503).render('error', { title: 'Pre-enrollment unavailable', message: 'The record could not be loaded.' });
    }
  });
  router.post('/:id', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    if (req.authUser.role === 'database_admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Database administrators have read-only access to pre-enrollment records.' });
    try {
      const updated = await service.update(req.authUser.id, req.params.id, req.body?.version, { ...(req.body || {}), actorName: req.authUser.email });
      return res.redirect(303, `/pre-enrollments/${encodeURIComponent(updated.id)}?notice=saved`);
    } catch (error) {
      if (error instanceof PreEnrollmentError) {
        try { return renderForm(req, res, { status: error.status, record: await service.get(req.authUser.id, req.params.id), error: error.message, values: req.body || {} }); }
        catch { return res.status(error.status).render('error', { title: 'Pre-enrollment record', message: error.message }); }
      }
      return res.status(503).render('error', { title: 'Pre-enrollment unavailable', message: 'The paper pre-enrollment record could not be updated.' });
    }
  });
  router.get('/:id', async (req, res) => {
    try {
      const record = await service.get(req.authUser.id, req.params.id);
      return privateHeaders(res).render('pre-enrollments/detail', {
        title: 'Pre-enrollment record', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), record,
        requirements: RECEIPT_REQUIREMENTS,
        notice: req.query.notice === 'saved' ? 'Pre-enrollment record saved.' : req.query.notice === 'alreadySaved' ? 'This saved submission was already recorded.' : null
      });
    } catch (error) {
      if (error instanceof PreEnrollmentError) return res.status(error.status).render('error', { title: 'Pre-enrollment record', message: error.message });
      return res.status(503).render('error', { title: 'Pre-enrollment unavailable', message: 'The paper pre-enrollment record could not be loaded.' });
    }
  });

  return router;
}

module.exports = { DEFAULT_SCHOOL_YEAR, recordFormValues, createPreEnrollmentRouter };
