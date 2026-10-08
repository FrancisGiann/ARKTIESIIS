'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const express = require('express');
const { normalizeRecord, RECEIPT_REQUIREMENTS, PreEnrollmentError } = require('../src/services/preEnrollmentService');
const { createPreEnrollmentRouter } = require('../src/routes/preEnrollments');
const { requireRole } = require('../src/middleware/roles');
const { applyAddressInput } = require('../src/services/studentRecordsService');
const { normalizeStructuredAddress, StudentAddressError } = require('../src/utils/studentAddress');
const { comparePreEnrollmentProfile, PROFILE_REVIEW_GROUPS } = require('../src/utils/studentProfileReview');
const { initialize: initializeAddressCopy } = require('../public/js/pre-enrollment-address-copy');

function readyInput(overrides = {}) {
  return {
    schoolYear: '2027-2028', firstName: 'Ari', middleName: 'Mae', lastName: 'Santos', suffix: '', lrn: '012345678901',
    email: 'ari.santos@example.test',
    studentContactNumber: '09171234567', voucherTypeText: 'ESC', voucherCategoryText: 'CATEGORY A',
    preferredTrack: 'Academic Track', preferredCluster: 'ASSH (Arts, Social Science, and Humanities)',
    targetGradeLevel: 'Grade 11', priorGradeLevel: 'Grade 10', priorSchool: 'Lucena High School',
    studentSignaturePresent: '1', studentSignedDate: '2026-10-01', status: 'ready_for_registrar', ...overrides
  };
}

test('pre-enrollment validates supplied paper data, ready requirements, school year, phone, and status', () => {
  const ready = normalizeRecord(readyInput());
  assert.equal(ready.status, 'ready_for_registrar');
  assert.equal(ready.lrn, '012345678901');
  assert.equal(ready.missingRequired.length, 0);
  assert.equal(ready.receipts.length, 9);
  assert.deepEqual(RECEIPT_REQUIREMENTS.map(([code]) => code), [
    'report_card', 'birth_certificate', 'good_moral', 'junior_high_certificate', 'certificate_of_rating',
    'esc_certificate', 'national_id', 'two_by_two_photos', 'long_brown_envelopes'
  ]);

  const draft = normalizeRecord({ schoolYear: '2027-2028', status: 'draft' });
  assert.ok(draft.missingRequired.includes('12-digit LRN'));
  assert.throws(() => normalizeRecord(readyInput({ schoolYear: '2027-2029' })), /consecutive years/);
  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'unknown' }), /Choose Draft or Ready/);
  assert.throws(() => normalizeRecord(readyInput({ studentContactNumber: '+63 (917' })), /valid phone format/);
  assert.throws(() => normalizeRecord(readyInput({ lrn: '1234' })), /12-digit LRN/);
  assert.throws(() => normalizeRecord(readyInput({ studentSignedDate: '' })), /signature and date/);
  assert.throws(() => normalizeRecord(readyInput({ status: 'enrollment_started' })), /Choose Draft or Ready/);
});

test('receipt counts require a received original or photocopy and stay independent', () => {
  const value = normalizeRecord(readyInput({ receipt_report_card_original: '1', receipt_report_card_original_pieces: '1' }));
  assert.equal(value.receipts[0].originalReceived, true);
  assert.equal(value.receipts[0].originalPieces, 1);
  assert.equal(value.receipts[0].photocopyReceived, false);
  assert.equal(value.receipts[0].photocopyPieces, null);
  assert.throws(() => normalizeRecord(readyInput({ receipt_report_card_original_pieces: '1' })), /only when those papers were received/);
});

test('structured student and emergency addresses preserve legacy text unless explicitly replaced', () => {
  const legacy = 'Lot 4, Old Street, Lucena';
  const emergency = { emergencyContactAddress: 'Emergency legacy location' };
  applyAddressInput(emergency, { emergencyContactAddress: 'Emergency legacy location' }, 'emergencyContactAddress');
  assert.equal(emergency.emergencyContactAddress, 'Emergency legacy location', 'old API emergency address field remains intact on creation');

  const existing = { address: legacy, address_zip: null };
  const profile = { address: 'client-controlled hidden legacy text' };
  applyAddressInput(profile, { addressMode: 'preserve', address: 'spoofed value' }, 'address', existing);
  assert.equal(profile.address, legacy, 'preserve reads the authoritative stored value');
  assert.equal(profile.addressZip, null);

  const replacement = {};
  applyAddressInput(replacement, {
    addressMode: 'replace', addressBlockLotStreetPurok: 'Block 2, Street 1',
    addressBarangay: 'Ibabang Iyam', addressCity: 'Lucena', addressProvince: 'Quezon', addressZip: '0123'
  }, 'address');
  assert.equal(replacement.addressZip, '0123');
  assert.equal(replacement.address, 'Block 2, Street 1, Ibabang Iyam, Lucena, Quezon, 0123');

  const emergencyReplacement = {};
  applyAddressInput(emergencyReplacement, {
    emergencyContactAddressMode: 'replace', emergencyContactAddressBlockLotStreetPurok: 'Purok 1',
    emergencyContactAddressBarangay: 'Gulang-gulang', emergencyContactAddressCity: 'Lucena',
    emergencyContactAddressProvince: 'Quezon', emergencyContactAddressZip: '4301'
  }, 'emergencyContactAddress');
  assert.equal(emergencyReplacement.emergencyContactAddress, 'Purok 1, Gulang-gulang, Lucena, Quezon, 4301');
});

test('same-address flag copies normalized student address and ignores malformed emergency address fields', () => {
  const copied = normalizeRecord(readyInput({
    addressMode: 'replace', addressBlockLotStreetPurok: ' Block 2, Lot 4 ', addressBarangay: 'Ibabang Iyam',
    addressCity: 'Lucena', addressProvince: 'Quezon', addressZip: '0123',
    emergencyContactSameAsStudent: '1', emergencyContactAddressMode: ['invalid'],
    emergencyContactAddress: ['forged legacy text'], emergencyContactAddressBlockLotStreetPurok: ['bad'],
    emergencyContactAddressBarangay: 'E'.repeat(101), emergencyContactAddressCity: 'Lucena',
    emergencyContactAddressProvince: 'Quezon', emergencyContactAddressZip: '12',
    emergencyContactPerson: 'Mae Santos', emergencyContactRelationship: 'Mother', emergencyContactPhone: '09181234567'
  }));
  assert.equal(copied.address, 'Block 2, Lot 4, Ibabang Iyam, Lucena, Quezon, 0123');
  assert.equal(copied.addressZip, '0123');
  assert.equal(copied.emergencyContactAddress, copied.address);
  assert.equal(copied.emergencyContactAddressBlockLotStreetPurok, copied.addressBlockLotStreetPurok);
  assert.equal(copied.emergencyContactAddressBarangay, copied.addressBarangay);
  assert.equal(copied.emergencyContactAddressCity, copied.addressCity);
  assert.equal(copied.emergencyContactAddressProvince, copied.addressProvince);
  assert.equal(copied.emergencyContactAddressZip, '0123');
  assert.equal(copied.emergencyContactPerson, 'Mae Santos');
  assert.equal(copied.emergencyContactRelationship, 'Mother');
  assert.equal(copied.emergencyContactPhone, '09181234567');
  assert.equal(Object.hasOwn(copied, 'emergencyContactSameAsStudent'), false,
    'the transient form control is absent from the canonical record');
  const manualCopy = normalizeRecord(readyInput({
    addressMode: 'replace', addressBlockLotStreetPurok: 'Block 2, Lot 4', addressBarangay: 'Ibabang Iyam',
    addressCity: 'Lucena', addressProvince: 'Quezon', addressZip: '0123', emergencyContactSameAsStudent: '0',
    emergencyContactAddressMode: 'replace', emergencyContactAddressBlockLotStreetPurok: 'Block 2, Lot 4',
    emergencyContactAddressBarangay: 'Ibabang Iyam', emergencyContactAddressCity: 'Lucena',
    emergencyContactAddressProvince: 'Quezon', emergencyContactAddressZip: '0123',
    emergencyContactPerson: 'Mae Santos', emergencyContactRelationship: 'Mother', emergencyContactPhone: '09181234567'
  }));
  assert.deepEqual(copied, manualCopy, 'equivalent copy and manual submissions normalize to one canonical record');

  const blank = normalizeRecord(readyInput({ emergencyContactSameAsStudent: 'on' }));
  assert.equal(blank.emergencyContactAddress, null);
  assert.equal(blank.emergencyContactAddressZip, null);
  assert.equal(normalizeRecord(readyInput({ emergencyContactSameAsStudent: '0',
    emergencyContactAddressMode: 'replace', emergencyContactAddressBlockLotStreetPurok: 'Separate location' })).emergencyContactAddress,
  'Separate location', 'an unchecked form keeps the independent emergency address');
  for (const malformed of [['1'], 'yes', 2]) {
    assert.throws(() => normalizeRecord(readyInput({ emergencyContactSameAsStudent: malformed })), /same address as the student/);
  }
});

test('same-address flag resolves saved keep and submitted replace student addresses before copying', () => {
  const legacyCurrent = {
    address: '  Legacy address, exactly as saved  ', address_block_lot_street_purok: null,
    address_barangay: null, address_city: null, address_province: null, address_zip: null,
    emergency_contact_address: 'Separate emergency legacy', emergency_contact_address_zip: '4301'
  };
  const preserved = normalizeRecord(readyInput({
    addressMode: 'preserve', address: 'spoofed posted legacy', addressBlockLotStreetPurok: 'ignored component',
    emergencyContactSameAsStudent: 'true', emergencyContactAddressMode: 'replace', emergencyContactAddressZip: 'bad'
  }), { current: legacyCurrent });
  assert.equal(preserved.address, '  Legacy address, exactly as saved  ');
  assert.equal(preserved.emergencyContactAddress, '  Legacy address, exactly as saved  ');
  assert.equal(preserved.emergencyContactAddressBlockLotStreetPurok, null);
  assert.equal(preserved.emergencyContactAddressZip, null);

  const replaced = normalizeRecord(readyInput({
    addressMode: 'replace', addressBlockLotStreetPurok: 'Block 9', addressBarangay: 'Gulang-gulang',
    addressCity: 'Lucena', addressProvince: 'Quezon', addressZip: '0123', emergencyContactSameAsStudent: true
  }), { current: { ...legacyCurrent, address: 'Old saved address' } });
  assert.equal(replaced.address, 'Block 9, Gulang-gulang, Lucena, Quezon, 0123');
  assert.equal(replaced.emergencyContactAddress, replaced.address);
  assert.equal(replaced.emergencyContactAddressZip, '0123');
});

test('address-copy browser behavior tracks student modes and restores the separate emergency draft', () => {
  function input(value) {
    const listeners = {};
    return { value, readOnly: false, listeners, addEventListener(type, listener) { listeners[type] = listener; },
      dispatch(type) { listeners[type]?.(); } };
  }
  function form({ savedStudentAddress = '', checked = false, studentMode = 'replace', studentValues = [], emergencyValues = [] } = {}) {
    const checkbox = input('1'); checkbox.checked = checked;
    const mode = input(studentMode);
    const manualFields = { hidden: false };
    const preview = { hidden: true };
    const previewValue = { textContent: '' };
    const studentComponents = studentValues.map(input);
    const emergencyComponents = emergencyValues.map(input);
    const selectors = new Map([
      ['[data-copy-student-address-checkbox]', checkbox], ['[data-emergency-address-manual-fields]', manualFields],
      ['[data-student-address-copy-preview]', preview], ['[data-student-address-copy-value]', previewValue],
      ['[data-student-address-mode]', mode]
    ]);
    return { dataset: { savedStudentAddress }, selectors, studentComponents, emergencyComponents,
      querySelector(selector) { return selectors.get(selector) || null; },
      querySelectorAll(selector) { return selector === '[data-student-address-component]' ? studentComponents : emergencyComponents; } };
  }

  const view = form({ savedStudentAddress: 'Legacy student text stays exact', studentValues: ['Block 2', 'Barangay', 'Lucena', 'Quezon', '0123'],
    emergencyValues: ['Emergency draft', '', '', '', '4301'] });
  initializeAddressCopy(view);
  const checkbox = view.selectors.get('[data-copy-student-address-checkbox]');
  const preview = view.selectors.get('[data-student-address-copy-preview]');
  const previewValue = view.selectors.get('[data-student-address-copy-value]');
  const manual = view.selectors.get('[data-emergency-address-manual-fields]');
  assert.equal(preview.hidden, true);
  assert.equal(manual.hidden, false);
  checkbox.checked = true; checkbox.dispatch('change');
  assert.equal(manual.hidden, true);
  assert.equal(preview.hidden, false);
  assert.equal(previewValue.textContent, 'Block 2, Barangay, Lucena, Quezon, 0123');
  assert.ok(view.emergencyComponents.every((field) => field.readOnly));
  view.studentComponents[0].value = 'Block 8'; view.studentComponents[0].dispatch('input');
  assert.match(previewValue.textContent, /^Block 8,/);
  const mode = view.selectors.get('[data-student-address-mode]');
  mode.value = 'preserve'; mode.dispatch('change');
  assert.equal(previewValue.textContent, 'Legacy student text stays exact');
  view.studentComponents[0].value = 'Ignored while preserving'; view.studentComponents[0].dispatch('input');
  assert.equal(previewValue.textContent, 'Legacy student text stays exact');
  checkbox.checked = false; checkbox.dispatch('change');
  assert.equal(manual.hidden, false);
  assert.equal(preview.hidden, true);
  assert.ok(view.emergencyComponents.every((field) => !field.readOnly));
  assert.deepEqual(view.emergencyComponents.map((field) => field.value), ['Emergency draft', '', '', '', '4301']);
  assert.equal(mode.value, 'preserve');

  const rerenderedError = form({ savedStudentAddress: 'Saved address', checked: true, studentMode: 'preserve',
    studentValues: ['draft student component'], emergencyValues: ['separate emergency draft', '', '', '', 'bad'] });
  initializeAddressCopy(rerenderedError);
  assert.equal(rerenderedError.selectors.get('[data-student-address-copy-preview]').hidden, false);
  assert.equal(rerenderedError.selectors.get('[data-student-address-copy-value]').textContent, 'Saved address');
  assert.deepEqual(rerenderedError.emergencyComponents.map((field) => field.value), ['separate emergency draft', '', '', '', 'bad']);
});

test('returning address comparison presents one atomic approval per address with components visible', () => {
  const source = {
    address: 'Block 2, Ibabang Iyam, Lucena, Quezon, 0123',
    address_block_lot_street_purok: 'Block 2', address_barangay: 'Ibabang Iyam', address_city: 'Lucena',
    address_province: 'Quezon', address_zip: '0123',
    emergency_contact_address: 'Purok 3, Gulang-gulang, Lucena, Quezon, 4301',
    emergency_contact_address_block_lot_street_purok: 'Purok 3', emergency_contact_address_barangay: 'Gulang-gulang',
    emergency_contact_address_city: 'Lucena', emergency_contact_address_province: 'Quezon', emergency_contact_address_zip: '4301'
  };
  const current = { address: 'Legacy student address', emergency_contact_address: 'Legacy emergency address' };
  const differences = comparePreEnrollmentProfile(source, current).filter((item) => item.differs);
  const address = differences.find((item) => item.key === 'address');
  const emergency = differences.find((item) => item.key === 'emergencyContactAddress');
  assert.match(address.sourceValue, /Barangay: Ibabang Iyam/);
  assert.match(address.sourceValue, /ZIP code: 0123/);
  assert.match(address.studentValue, /Legacy free-text address/);
  assert.match(emergency.sourceValue, /Block and lot, street\/purok: Purok 3/);
  assert.ok(PROFILE_REVIEW_GROUPS.some(({ key }) => key === 'address'));
  assert.ok(!PROFILE_REVIEW_GROUPS.some(({ key }) => ['addressZip', 'addressCity', 'emergencyContactAddressZip'].includes(key)),
    'address columns cannot be approved separately');
});

test('address field component strings stay at five visible fields and enforce compatibility length and ZIP markup', async () => {
  const base = {
    addressBlockLotStreetPurok: 'B'.repeat(200), addressBarangay: 'B'.repeat(100),
    addressCity: 'C'.repeat(100), addressProvince: 'P'.repeat(88), addressZip: '0123'
  };
  const exactLimit = normalizeStructuredAddress(base, 'address');
  assert.equal(exactLimit.formatted.length, 500);
  assert.equal(exactLimit.address_zip, '0123');
  assert.throws(() => normalizeStructuredAddress({ ...base, addressProvince: 'P'.repeat(90) }, 'address'), StudentAddressError);
  assert.throws(() => normalizeStructuredAddress({ ...base, addressZip: '123' }, 'address'), /exactly four digits/);

  const partial = path.resolve(__dirname, '../views/records/partials/address-fields.ejs');
  const html = await ejs.renderFile(partial, {
    prefix: 'address', values: { addressZip: '0123', addressMode: 'preserve' }, student: { address: 'Old free text address' }
  });
  assert.equal((html.match(/<label for="student-address-(?:addressBlockLotStreetPurok|addressBarangay|addressCity|addressProvince|addressZip)">/g) || []).length, 5);
  assert.match(html, /name="addressZip" maxlength="4" inputmode="numeric" pattern="\[0-9\]\{4\}"[^>]*value="0123"/);
  assert.match(html, /Old free text address/);
  assert.match(html, /name="addressMode"/);
  assert.doesNotMatch(html, /data-student-address-source|data-student-address-component|emergencyContactSameAsStudent/,
    'shared profile callers keep the original markup without explicit opt-in');

  const emergencyPartial = path.resolve(__dirname, '../views/records/partials/address-fields.ejs');
  const optedIn = await ejs.renderFile(emergencyPartial, {
    prefix: 'emergencyContactAddress', allowEmergencyAddressCopy: true,
    values: { emergencyContactAddressMode: 'replace', emergencyContactSameAsStudent: '1' }, student: null
  });
  assert.match(optedIn, /name="emergencyContactSameAsStudent" value="1"[^>]*checked/);
  assert.match(optedIn, /data-emergency-address-manual-fields/);
  assert.match(optedIn, /data-emergency-address-component/);
});

function detailRecord(id, status = 'ready_for_registrar') {
  return {
    id,
    school_year: '2027-2028',
    first_name: 'Ari',
    middle_name: 'Mae',
    last_name: 'Santos',
    suffix: '',
    lrn: '012345678901',
    student_contact_number: '09171234567',
    applicant_kind: 'readmission',
    email: 'ari.santos@example.test', birth_date: '2008-04-21', sex: 'Female', profile_phone: '09171234567',
    address: 'Block 2, Lucena', address_block_lot_street_purok: 'Block 2', address_barangay: 'Ibabang Iyam',
    address_city: 'Lucena', address_province: 'Quezon', address_zip: '4301',
    emergency_contact_person: 'Mae Santos', emergency_contact_relationship: 'Mother',
    emergency_contact_phone: '09181234567', emergency_contact_address: 'Purok 3, Lucena',
    emergency_contact_address_block_lot_street_purok: 'Purok 3', emergency_contact_address_barangay: 'Gulang-gulang',
    emergency_contact_address_city: 'Lucena', emergency_contact_address_province: 'Quezon', emergency_contact_address_zip: '0123',
    mother_name: 'Ana Santos', mother_phone: '09170000001', father_name: 'Ben Santos', father_phone: '09170000002',
    birthplace: 'Lucena City', facebook_name: 'Ari Santos',
    readmission_evaluation_id: 'c342bc01-2a68-4f19-a7fd-4d5bb1d83261', readmission_evaluation_version: 4,
    readmission_evaluation: { applicant_lrn: '012345678901', school_year: '2027-2028', target_grade_level: 'Grade 11', status: 'accepted', version: 4 },
    voucher_type_text: 'ESC as written on original school form',
    voucher_category_text: 'CATEGORY A',
    preferred_track: 'Academic Track',
    preferred_cluster: 'ASSH (Arts, Social Science, and Humanities) — long fixture cluster text to verify wrapping',
    target_grade_level: 'Grade 11',
    prior_grade_level: 'Grade 10',
    prior_school: 'Lucena High School',
    student_signature_present: 1,
    student_signed_date: '2026-10-01',
    received_by: 'Pat Fixture',
    received_date: '2026-10-03',
    creator_first_name: 'Pat',
    creator_last_name: 'Fixture',
    updater_first_name: 'Rae',
    updater_last_name: 'Registrar',
    status,
    version: status === 'enrollment_started' ? 3 : 2,
    receipts: RECEIPT_REQUIREMENTS.map(([requirement_code], index) => ({
      requirement_code,
      original_received: index === 0 || index === 7,
      original_pieces: index === 0 ? 1 : index === 7 ? 3 : null,
      photocopy_received: index === 1,
      photocopy_pieces: index === 1 ? 1 : null
    })),
    events: [
      { event_type: 'created', version: 1, first_name: 'Pat', last_name: 'Fixture', created_at: '2026-10-02 09:10:00.000', from_status: null, to_status: 'draft' },
      { event_type: 'submitted_ready', version: 2, first_name: 'Rae', last_name: 'Registrar', created_at: '2026-10-03 10:30:00.000', from_status: 'draft', to_status: 'ready_for_registrar' },
      ...(status === 'enrollment_started'
        ? [{ event_type: 'enrollment_started', version: 3, first_name: 'Rae', last_name: 'Registrar', created_at: '2026-10-04 11:45:00.000', from_status: 'ready_for_registrar', to_status: 'enrollment_started' }]
        : [])
    ],
    revisions: [{
      field_name: 'preferred_cluster',
      before_value: 'ASSH (Arts, Social Science, and Humanities)',
      after_value: 'ASSH (Arts, Social Science, and Humanities) — confirmed from a longer handwritten paper note to test wrapping',
      first_name: 'Rae',
      last_name: 'Registrar',
      created_at: '2026-10-03 10:30:00.000'
    }]
  };
}

test('pre-enrollment routes keep database administrators read-only and deny unrelated staff roles', async () => {
  const app = express();
  const csrfToken = 'c'.repeat(64);
  const calls = [];
  const choicesCalls = [];
  const updateInputs = [];
  const roleIds = { registrar: 1, front_desk: 2, database_admin: 3, teacher: 4, finance: 5, student: 6 };
  const acceptedChoice = { id: 'c342bc01-2a68-4f19-a7fd-4d5bb1d83261', version: 4, applicant_lrn: '012345678901', first_name: 'Ari', last_name: 'Santos', school_year: '2027-2028', target_grade_level: 'Grade 11' };
  app.set('views', path.resolve(__dirname, '../views'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role'] || 'front_desk';
    req.authUser = { id: roleIds[role], email: `${role}@test.invalid`, role };
    req.session = { csrfToken };
    next();
  });
  app.get('/front-desk', requireRole('front_desk'), (_req, res) => res.redirect(303, '/pre-enrollments'));
  app.use('/pre-enrollments', requireRole('registrar', 'front_desk', 'database_admin'), createPreEnrollmentRouter({
    preEnrollmentService: {
      async list(actorId) { calls.push(['list', actorId]); return { rows: [{ id: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83261', first_name: 'Ari', middle_name: '', last_name: 'Santos', suffix: '', lrn: '012345678901', school_year: '2027-2028', status: 'ready_for_registrar', recorder_first_name: 'Front', recorder_last_name: 'Desk', updated_at: '2026-10-03' }], filters: { search: '', schoolYear: '', status: '' }, pagination: { page: 1, pageSize: 20, totalRecords: 1, totalPages: 1, from: 1, to: 1 } }; },
      async getActorDisplayName(actorId) { calls.push(['display', actorId]); return 'Front Desk'; },
      async create(actorId) { calls.push(['create', actorId]); return { id: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83261' }; },
      async update(actorId, id, version, input) { calls.push(['update', actorId]); updateInputs.push(input); throw new PreEnrollmentError('The correction needs a current accepted evaluation.', 409); },
      async listAcceptedReadmissionChoices(actorId, schoolYear) { choicesCalls.push([actorId, schoolYear]); return [acceptedChoice]; },
      async get(actorId, id) {
        calls.push(['get', actorId]);
        const record = detailRecord(id, ['b342bc01-2a68-4f19-a7fd-4d5bb1d83261', 'd342bc01-2a68-4f19-a7fd-4d5bb1d83261', 'e342bc01-2a68-4f19-a7fd-4d5bb1d83261'].includes(id)
          ? 'enrollment_started' : 'ready_for_registrar');
        if (['b342bc01-2a68-4f19-a7fd-4d5bb1d83261', 'd342bc01-2a68-4f19-a7fd-4d5bb1d83261'].includes(id)) {
          record.linkedAnnualEnrollment = {
            id: id === 'd342bc01-2a68-4f19-a7fd-4d5bb1d83261' ? 72 : 71,
            intake_status: id === 'd342bc01-2a68-4f19-a7fd-4d5bb1d83261' ? 'enrolled' : 'pending',
            school_year: '2026-2027', grade_level: 'Grade 11'
          };
        }
        return record;
      }
    }
  }));
  app.post('/registrar/intake', requireRole('registrar'), (_req, res) => res.status(204).end());
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const frontDeskHome = await fetch(`${origin}/front-desk`, { redirect: 'manual' });
    assert.equal(frontDeskHome.status, 303);
    assert.equal(frontDeskHome.headers.get('location'), '/pre-enrollments');
    const frontDeskList = await fetch(`${origin}/pre-enrollments`);
    assert.equal(frontDeskList.status, 200);
    const frontDeskListHtml = await frontDeskList.text();
    assert.match(frontDeskListHtml, /Copy the details from the student’s paper form/);
    assert.match(frontDeskListHtml, /Record paper form/);
    assert.match(frontDeskListHtml, /class="records-student-list pre-enrollment-record-list"/);
    assert.match(frontDeskListHtml, /LRN 012345678901/);
    assert.match(frontDeskListHtml, /2027-2028/);
    assert.match(frontDeskListHtml, /href="\/pre-enrollments\/a342bc01-2a68-4f19-a7fd-4d5bb1d83261">Open record/);
    assert.match(frontDeskListHtml, /aria-label="Open pre-enrollment record for Ari Santos"/);
    assert.match(frontDeskListHtml, /Last updated[\s\S]*?2026-10-03[\s\S]*?By Front Desk/);
    assert.doesNotMatch(frontDeskListHtml, /<table[^>]*pre-enrollment-list-table/,
      'front-desk records use stacked identity rows rather than a wide table');
    const newFormResponse = await fetch(`${origin}/pre-enrollments/new`);
    assert.equal(newFormResponse.status, 200);
    assert.match(newFormResponse.headers.get('cache-control'), /no-store/);
    const newFormHtml = await newFormResponse.text();
    assert.match(newFormHtml, /<label for="pre-email">Email<\/label>/);
    assert.match(newFormHtml, /aria-describedby="pre-email-help"/);
    assert.match(newFormHtml, /id="pre-email-help">This email will be used for the student’s account\./);
    assert.match(newFormHtml, /name="emergencyContactSameAsStudent" value="1"[^>]*><span>Same address as student<\/span>/);
    assert.match(newFormHtml, /src="\/js\/pre-enrollment-address-copy\.js" defer/);
    assert.match(newFormHtml, /accepted evaluation for this applicant, school year, and grade/);
    assert.doesNotMatch(newFormHtml, /profile source|saved binding is stale|explicit current selection/i);
    assert.match(newFormHtml, /Copy these contact details from the paper form/);
    assert.doesNotMatch(newFormHtml, /name="emergencyContactSameAsStudent" value="1"[^>]*checked/,
      'fresh pre-enrollment forms start unchecked');
    const detail = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`);
    assert.equal(detail.status, 200);
    const detailHtml = await detail.text();
    for (const [, label] of RECEIPT_REQUIREMENTS) assert.ok(detailHtml.includes(label), `detail renders receipt row ${label}`);
    for (const label of ['Student and contact', 'Program and previous school', 'Signature and office record', 'Entered by']) {
      assert.ok(detailHtml.includes(label), `detail presents the grouped ${label} information`);
    }
    for (const label of ['Email', 'Gender', 'Birthplace', 'Facebook name', 'Student address',
      'Block 2', 'ZIP code', 'Emergency contact', 'Mother’s name', 'Father’s phone', '012345678901, 2027-2028, Grade 11']) {
      assert.ok(detailHtml.includes(label), `detail shows saved profile or evaluation binding ${label}`);
    }
    assert.match(detailHtml, /Submitted as ready/);
    assert.match(detailHtml, /Status changed/);
    assert.match(detailHtml, /datetime="2026-10-03T10:30:00.000Z"/);
    assert.match(detailHtml, /Field revision details · 1 change/);
    assert.match(detailHtml, /confirmed from a longer handwritten paper note/);
    assert.doesNotMatch(detailHtml, /ready_for_registrar|submitted_ready/);
    assert.doesNotMatch(detailHtml, /Start enrollment/, 'front desk can correct a ready record but cannot start enrollment');
    assert.match(detailHtml, /Correct paper record/);

    const registrarDetail = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`, {
      headers: { 'x-test-role': 'registrar' }
    });
    assert.match(await registrarDetail.text(), /Start enrollment/);
    const registrarList = await fetch(`${origin}/pre-enrollments`, { headers: { 'x-test-role': 'registrar' } });
    assert.doesNotMatch(await registrarList.text(), /Record paper form/, 'only front desk can create paper records');
    const registrarEdit = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261/edit`, { headers: { 'x-test-role': 'registrar' } });
    const registrarEditHtml = await registrarEdit.text();
    assert.equal(registrarEdit.status, 200);
    assert.doesNotMatch(registrarEditHtml, /name="emergencyContactSameAsStudent" value="1"[^>]*checked/,
      'reopened corrections start unchecked because the control is not stored');
    assert.ok(registrarEditHtml.includes('value="c342bc01-2a68-4f19-a7fd-4d5bb1d83261@4" selected'),
      'registrar correction shows the current saved accepted evaluation as an explicit selection');
    assert.ok(choicesCalls.some(([actorId]) => actorId === roleIds.registrar), 'the correction route asks the service for registrar-authorized identity choices');
    assert.doesNotMatch(registrarEditHtml, /Prior progress|Evidence reviewed|Decision reason/,
      'paper correction gets no private academic evaluation notes');
    const csrfCorrection = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`, {
      method: 'POST', headers: { 'x-test-role': 'registrar', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, version: '2', schoolYear: '2027-2028', applicantKind: 'readmission',
        readmissionEvaluationBinding: 'c342bc01-2a68-4f19-a7fd-4d5bb1d83261@4', emergencyContactSameAsStudent: '1',
        emergencyContactPerson: 'Mae Santos', emergencyContactRelationship: 'Mother', emergencyContactPhone: '09181234567',
        emergencyContactAddressMode: 'replace', emergencyContactAddressBlockLotStreetPurok: 'Separate emergency draft',
        emergencyContactAddressZip: 'bad' })
    });
    const correctionHtml = await csrfCorrection.text();
    assert.equal(csrfCorrection.status, 409);
    assert.ok(correctionHtml.includes('value="c342bc01-2a68-4f19-a7fd-4d5bb1d83261@4" selected'),
      'a failed correction rerender retains the explicit evaluation binding and version');
    assert.match(correctionHtml, /name="emergencyContactSameAsStudent" value="1"[^>]*checked/,
      'validation-error rerenders retain the transient checkbox');
    assert.match(correctionHtml, /value="Separate emergency draft"/);
    assert.match(correctionHtml, /value="bad"/);
    assert.equal(updateInputs[0].emergencyContactSameAsStudent, '1',
      'the checked value reaches the service in the ordinary URL-encoded request');
    assert.equal(updateInputs[0].emergencyContactPerson, 'Mae Santos');
    assert.equal(updateInputs[0].emergencyContactRelationship, 'Mother');
    assert.equal(updateInputs[0].emergencyContactPhone, '09181234567');
    const startedDetail = await fetch(`${origin}/pre-enrollments/b342bc01-2a68-4f19-a7fd-4d5bb1d83261`);
    const startedHtml = await startedDetail.text();
    assert.match(startedHtml, /Student details can no longer be changed here after enrollment is prepared/);
    assert.match(startedHtml, /<h2 id="enrollment-state-heading">Enrollment status<\/h2>/);
    assert.match(startedHtml, /Awaiting registrar confirmation/);
    assert.match(startedHtml, /The registrar still needs to review and confirm this enrollment/);
    assert.doesNotMatch(startedHtml, /Correct paper record|Start enrollment/);
    assert.doesNotMatch(startedHtml, /\/registrar\/intake\/71\/review|\/registrar\/intake\/71\/manage/,
      'front desk does not receive a registrar workflow link');
    const unknownDetail = await fetch(`${origin}/pre-enrollments/e342bc01-2a68-4f19-a7fd-4d5bb1d83261`);
    const unknownHtml = await unknownDetail.text();
    assert.match(unknownHtml, /Enrollment status unavailable/);
    assert.match(unknownHtml, /No confirmation is inferred; ask the registrar to check this record/);
    assert.doesNotMatch(unknownHtml, /\/registrar\/intake\//);
    const registrarStartedDetail = await fetch(`${origin}/pre-enrollments/b342bc01-2a68-4f19-a7fd-4d5bb1d83261`, {
      headers: { 'x-test-role': 'registrar' }
    });
    const registrarStartedHtml = await registrarStartedDetail.text();
    assert.equal(registrarStartedDetail.status, 200);
    assert.match(registrarStartedHtml, /Awaiting registrar confirmation/);
    assert.match(registrarStartedHtml, /The registrar still needs to review and confirm this enrollment/);
    assert.match(registrarStartedHtml, /href="\/registrar\/intake\/71\/review">Review for confirmation/);
    assert.doesNotMatch(registrarStartedHtml, /Enrollment confirmed/);
    const registrarConfirmedDetail = await fetch(`${origin}/pre-enrollments/d342bc01-2a68-4f19-a7fd-4d5bb1d83261`, {
      headers: { 'x-test-role': 'registrar' }
    });
    const registrarConfirmedHtml = await registrarConfirmedDetail.text();
    assert.equal(registrarConfirmedDetail.status, 200);
    assert.match(registrarConfirmedHtml, /class="status-chip pre-enrollment-status pre-enrollment-status--ready">Enrollment confirmed/);
    assert.match(registrarConfirmedHtml, /Enrollment is confirmed for this school year\. Each term is activated separately/);
    assert.match(registrarConfirmedHtml, /href="\/registrar\/intake\/72\/manage">Open enrollment/);
    assert.doesNotMatch(registrarConfirmedHtml, /href="\/registrar\/intake\/72\/review/);
    const frontDeskConfirmed = await fetch(`${origin}/pre-enrollments/d342bc01-2a68-4f19-a7fd-4d5bb1d83261`);
    const frontDeskConfirmedHtml = await frontDeskConfirmed.text();
    assert.match(frontDeskConfirmedHtml, /class="status-chip pre-enrollment-status pre-enrollment-status--ready">Enrollment confirmed/);
    assert.match(frontDeskConfirmedHtml, /Enrollment is confirmed for this school year\. Each term is activated separately/);
    assert.doesNotMatch(frontDeskConfirmedHtml, /\/registrar\/intake\//);
    const startedEditHtml = await (await fetch(`${origin}/pre-enrollments/b342bc01-2a68-4f19-a7fd-4d5bb1d83261/edit`)).text();
    assert.match(startedEditHtml, /Annual enrollment has started\. This paper record is read-only\./);
    assert.doesNotMatch(startedEditHtml, /emergencyContactSameAsStudent/);

    const adminHeaders = { 'x-test-role': 'database_admin' };
    const adminList = await fetch(`${origin}/pre-enrollments`, { headers: adminHeaders });
    assert.equal(adminList.status, 200);
    assert.doesNotMatch(await adminList.text(), /Record paper form/);
    const adminDetail = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`, { headers: adminHeaders });
    assert.equal(adminDetail.status, 200);
    assert.doesNotMatch(await adminDetail.text(), /Correct paper record|Start enrollment/);
    const adminConfirmed = await fetch(`${origin}/pre-enrollments/d342bc01-2a68-4f19-a7fd-4d5bb1d83261`, { headers: adminHeaders });
    const adminConfirmedHtml = await adminConfirmed.text();
    assert.match(adminConfirmedHtml, /class="status-chip pre-enrollment-status pre-enrollment-status--ready">Enrollment confirmed/);
    assert.doesNotMatch(adminConfirmedHtml, /\/registrar\/intake\//);
    const adminPending = await fetch(`${origin}/pre-enrollments/b342bc01-2a68-4f19-a7fd-4d5bb1d83261`, { headers: adminHeaders });
    assert.match(await adminPending.text(), /Awaiting registrar confirmation/);
    assert.equal((await fetch(`${origin}/pre-enrollments/new`, { headers: adminHeaders })).status, 403);
    const adminCreate = await fetch(`${origin}/pre-enrollments`, {
      method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83261' })
    });
    assert.equal(adminCreate.status, 403);
    const adminUpdate = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`, {
      method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, version: '1', schoolYear: '2027-2028' })
    });
    assert.equal(adminUpdate.status, 403);

    for (const role of ['teacher', 'finance', 'student']) {
      assert.equal((await fetch(`${origin}/pre-enrollments`, { headers: { 'x-test-role': role } })).status, 403);
      assert.equal((await fetch(`${origin}/registrar/intake`, { method: 'POST', headers: {
        'x-test-role': role, 'content-type': 'application/x-www-form-urlencoded'
      }, body: new URLSearchParams({ _csrf: csrfToken }) })).status, 403);
    }
    assert.deepEqual(calls.filter(([method]) => ['create', 'update'].includes(method)), [['update', roleIds.registrar]],
      'only the explicit registrar correction reaches the write service; admin and unrelated roles stop first');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
