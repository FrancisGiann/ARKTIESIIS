'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { PreEnrollmentError, RECEIPT_REQUIREMENTS, createPreEnrollmentService } = require('../services/preEnrollmentService');
const { latestBirthDate } = require('../services/studentRecordsService');
const { PROGRAM_CATALOG, TRACKS } = require('../utils/paperProgramCatalog');

const DEFAULT_SCHOOL_YEAR = '2027-2028';
const FORM_ERROR_FIELDS = Object.freeze({
  schoolYear: ['pre-school-year', 'School year'], applicantKind: ['pre-applicant-kind', 'Applicant status'],
  firstName: ['pre-first', 'First name'], middleName: ['pre-middle', 'Middle name'], lastName: ['pre-last', 'Last name'],
  suffix: ['pre-suffix', 'Suffix'], lrn: ['pre-lrn', 'LRN'], studentContactNumber: ['pre-contact', 'Student contact number'],
  readmissionEvaluationBinding: ['pre-readmission-evaluation', 'Accepted return evaluation'],
  voucherTypeText: ['pre-voucher-type', 'Voucher type'], preferredTrack: ['pre-track', 'Preferred track'],
  preferredCluster: ['pre-cluster', 'Preferred cluster'], targetGradeLevel: ['pre-grade', 'Grade to enroll'],
  priorGradeLevel: ['pre-prior-grade', 'Last grade level'], priorSchool: ['pre-prior-school', 'School attended'],
  studentSignaturePresent: ['pre-signature-check', 'Student signature'], studentSignedDate: ['pre-signed-date', 'Student signature date'],
  receivedBy: ['pre-received-by', 'Paper received by'], receivedDate: ['pre-received-date', 'Paper received date'],
  email: ['pre-email', 'Email'], birthDate: ['pre-birth-date', 'Birth date'], sex: ['pre-sex', 'Gender'],
  profilePhone: ['pre-profile-phone', 'Phone'], birthplace: ['pre-birthplace', 'Birthplace'], facebookName: ['pre-facebook-name', 'Facebook name'],
  addressBlockLotStreetPurok: ['student-address-addressBlockLotStreetPurok', 'Student address: Block and lot, street/Purok'],
  addressBarangay: ['student-address-addressBarangay', 'Student address: Barangay'],
  addressCity: ['student-address-addressCity', 'Student address: City'],
  addressProvince: ['student-address-addressProvince', 'Student address: Province'],
  addressZip: ['student-address-addressZip', 'Student address: ZIP code'],
  emergencyContactSameAsStudent: ['emergency-address-same', 'Same address as student'],
  emergencyContactAddressBlockLotStreetPurok: ['emergency-address-emergencyContactAddressBlockLotStreetPurok', 'Emergency address: Block and lot, street/Purok'],
  emergencyContactAddressBarangay: ['emergency-address-emergencyContactAddressBarangay', 'Emergency address: Barangay'],
  emergencyContactAddressCity: ['emergency-address-emergencyContactAddressCity', 'Emergency address: City'],
  emergencyContactAddressProvince: ['emergency-address-emergencyContactAddressProvince', 'Emergency address: Province'],
  emergencyContactAddressZip: ['emergency-address-emergencyContactAddressZip', 'Emergency address: ZIP code'],
  emergencyContactPerson: ['pre-emergency-person', 'Emergency contact person'],
  emergencyContactRelationship: ['pre-emergency-relationship', 'Emergency contact relationship'],
  emergencyContactPhone: ['pre-emergency-phone', 'Emergency contact number'], motherName: ['pre-mother-name', 'Mother’s name'],
  motherPhone: ['pre-mother-phone', 'Mother’s phone'], fatherName: ['pre-father-name', 'Father’s name'],
  fatherPhone: ['pre-father-phone', 'Father’s phone'],
  receipt_long_brown_envelopes_received: ['receipt-long_brown_envelopes-original-check', 'Three long brown envelopes received'],
  envelopeReceiptMode: ['pre-envelope-receipt', 'Envelope receipt'],
  status: ['pre-form-actions', 'Submit action'], addressMode: ['student-address-heading', 'Student address'],
  emergencyContactAddressMode: ['emergency-address-heading', 'Emergency contact address']
});
const RECEIPT_CODES = new Set([...RECEIPT_REQUIREMENTS.map(([code]) => code), 'long_brown_envelopes']);

function errorFieldLinks(error) {
  const fields = [...(Array.isArray(error?.fields) ? error.fields : []), error?.field].filter((field) => typeof field === 'string');
  return [...new Set(fields)].flatMap((name) => {
    const direct = FORM_ERROR_FIELDS[name];
    if (direct) return [{ name, id: direct[0], label: direct[1] }];
    const receipt = name.match(/^receipt_([a-z_]+)_(original|photocopy)(_pieces)?$/);
    if (!receipt || !RECEIPT_CODES.has(receipt[1])) return [];
    const [, code, side, pieces] = receipt;
    return [{ name, id: pieces ? `receipt-${code}-${side}` : `receipt-${code}-${side}-check`,
      label: `${RECEIPT_REQUIREMENTS.find(([item]) => item === code)?.[1] || 'Three long brown envelopes'}: ${side}${pieces ? ' pieces' : ' received'}` }];
  });
}

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

  async function renderForm(req, res, { record = null, values = {}, error = null, errorFields = [], staleVersion = false, status = 200 } = {}) {
    const receipts = new Map((record?.receipts || []).map((receipt) => [receipt.requirement_code, receipt]));
    const receiptValues = {};
    for (const [code] of RECEIPT_REQUIREMENTS) {
      const receipt = receipts.get(code);
      receiptValues[`receipt_${code}_original`] = receipt?.original_received ? '1' : '';
      receiptValues[`receipt_${code}_original_pieces`] = receipt?.original_pieces ?? '';
      receiptValues[`receipt_${code}_photocopy`] = receipt?.photocopy_received ? '1' : '';
      receiptValues[`receipt_${code}_photocopy_pieces`] = receipt?.photocopy_pieces ?? '';
    }
    const envelopeReceipt = receipts.get('long_brown_envelopes') || {};
    const envelopeExact = Boolean(envelopeReceipt.original_received)
      && Number(envelopeReceipt.original_pieces) === 3
      && !envelopeReceipt.photocopy_received && envelopeReceipt.photocopy_pieces == null;
    const envelopeState = !record ? 'No saved receipt' : envelopeExact
      ? 'All three received'
      : !envelopeReceipt.original_received && envelopeReceipt.original_pieces == null
        && !envelopeReceipt.photocopy_received && envelopeReceipt.photocopy_pieces == null
        ? 'Not recorded'
        : `Legacy receipt: original ${envelopeReceipt.original_received ? 'received' : 'not received'}${envelopeReceipt.original_pieces == null ? ' (quantity unknown)' : ` (${envelopeReceipt.original_pieces})`}; photocopy ${envelopeReceipt.photocopy_received ? 'received' : 'not received'}${envelopeReceipt.photocopy_pieces == null ? '' : ` (${envelopeReceipt.photocopy_pieces})`}`;
    const envelopeCheckboxDefault = values.envelopeReceiptMode === 'replace'
      ? ''
      : envelopeExact ? '1' : '';
    let acceptedReadmissionChoices = [];
    if (['front_desk', 'registrar'].includes(req.authUser.role) && service.listAcceptedReadmissionChoices) {
      try { acceptedReadmissionChoices = await service.listAcceptedReadmissionChoices(req.authUser.id, values.schoolYear || record?.school_year || ''); }
      catch (loadError) {
        if (loadError instanceof PreEnrollmentError) return res.status(loadError.status).render('error', { title: 'Return evaluation choices', message: loadError.message });
        return res.status(503).render('error', { title: 'Return evaluation choices', message: 'Accepted return evaluations could not be loaded.' });
      }
    }
    let receiptCountDefaults = {};
    if (!error && service.listReceiptCountDefaults) {
      try { receiptCountDefaults = await service.listReceiptCountDefaults(req.authUser.id); }
      catch { /* An unavailable count hint must not block correcting or saving the paper form. */ }
    }
    return privateHeaders(res).status(status).render('pre-enrollments/form', {
      title: record ? 'Correct pre-enrollment record' : 'Record paper form',
      currentUser: req.authUser, csrfToken: ensureCsrfToken(req), record,
      values: {
        schoolYear: DEFAULT_SCHOOL_YEAR, status: 'draft', applicantKind: 'new', studentSignaturePresent: '',
        receivedDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()),
        ...recordFormValues(record), ...receiptValues,
        receipt_long_brown_envelopes_received: envelopeCheckboxDefault,
        envelopeReceiptMode: record ? 'preserve' : 'replace', ...values
      },
      requirements: RECEIPT_REQUIREMENTS, receiptCountDefaults, acceptedReadmissionChoices, latestBirthDate: latestBirthDate(),
      programCatalog: PROGRAM_CATALOG, programTracks: TRACKS, envelopeState, error,
      errorFieldLinks: errorFieldLinks({ fields: errorFields }), hasRecoveredValues: Boolean(error && values && Object.keys(values).length), staleVersion
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
      return res.status(503).render('error', { title: 'Pre-enrollment unavailable', message: 'Pre-enrollment records could not be loaded.' });
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
      if (error instanceof PreEnrollmentError) return renderForm(req, res, { status: error.status, error: error.message, errorFields: [...error.fields, error.field].filter(Boolean), values: req.body || {} });
      if (error?.code === 'ER_DUP_ENTRY') return renderForm(req, res, { status: 409, error: 'A record with this school year and complete LRN already exists.', errorFields: ['lrn'], values: req.body || {} });
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
        try { return renderForm(req, res, { status: error.status, record: await service.get(req.authUser.id, req.params.id), error: error.message,
          errorFields: [...error.fields, error.field].filter(Boolean), staleVersion: error.status === 409 && /This record changed after the form was opened/.test(error.message), values: req.body || {} }); }
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
