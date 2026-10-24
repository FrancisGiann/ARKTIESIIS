'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const express = require('express');
const { normalizeDate, manilaDate, normalizeRecord, RECEIPT_REQUIREMENTS, PreEnrollmentError, createPreEnrollmentService } = require('../src/services/preEnrollmentService');
const { createPreEnrollmentRouter } = require('../src/routes/preEnrollments');
const { requireRole } = require('../src/middleware/roles');
const { applyAddressInput, latestBirthDate, validateStudent } = require('../src/services/studentRecordsService');
const { normalizeStructuredAddress, StudentAddressError } = require('../src/utils/studentAddress');
const { comparePreEnrollmentProfile, PROFILE_REVIEW_GROUPS } = require('../src/utils/studentProfileReview');
const { PROGRAM_CATALOG } = require('../src/utils/paperProgramCatalog');
const { initialize: initializeAddressCopy } = require('../public/js/pre-enrollment-address-copy');
const { initialize: initializeReadmissionEvaluation } = require('../public/js/pre-enrollment-readmission');

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
    'esc_certificate', 'national_id', 'two_by_two_photos'
  ]);

  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'draft' }), /at least one applicant detail or mark a paper item received/);
  assert.throws(() => normalizeRecord(readyInput({ schoolYear: '2027-2029' })), /consecutive years/);
  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'unknown' }), /Choose Draft or Ready/);
  assert.throws(() => normalizeRecord(readyInput({ studentContactNumber: '+63 (917' })), /valid phone format/);
  assert.throws(() => normalizeRecord(readyInput({ lrn: '1234' })), /12-digit LRN/);
  assert.throws(() => normalizeRecord(readyInput({ studentSignedDate: '' })), /signature date/);
  assert.throws(() => normalizeRecord(readyInput({ status: 'enrollment_started' })), /Choose Draft or Ready/);
});

test('front-desk receipt defaults use configured Registrar requirement counts, including zero-count sides', async () => {
  const sql = { Int: 'int' };
  const pool = { request() { return {
    input() { return this; },
    async query(query) {
      if (query.includes('FROM users AS account')) return { recordset: [{ id: 7, role: 'front_desk' }] };
      assert.match(query, /FROM physical_requirement_definitions/);
      return { recordset: [
        { requirement_code: 'jhs_report_card', originals_required: 2, copies_required: 1 },
        { requirement_code: 'birth_certificate', originals_required: 0, copies_required: 3 },
        { requirement_code: 'two_by_two_photo', originals_required: 0, copies_required: 0, pieces_required: 3 }
      ] };
    }
  }; } };
  const service = createPreEnrollmentService({ getPool: async () => pool, sql });
  const defaults = await service.listReceiptCountDefaults(7);
  assert.deepEqual(defaults.report_card, { original: 2, photocopy: 1 });
  assert.deepEqual(defaults.birth_certificate, { original: 0, photocopy: 3 });
  assert.deepEqual(defaults.two_by_two_photos, { original: 3, photocopy: 0 });
  assert.deepEqual(defaults.good_moral, { original: 0, photocopy: 0 }, 'missing configuration never invents a count');
});

test('drafts defer completion but validate every supplied field and Ready errors identify missing controls', () => {
  const draft = normalizeRecord({ schoolYear: '2027-2028', status: 'draft', firstName: '', lrn: '1234',
    email: '', studentContactNumber: '' });
  assert.equal(draft.firstName, null);
  assert.equal(draft.lrn, '1234', 'a syntactically valid partial LRN may be saved for a Draft');
  assert.ok(draft.missingRequired.includes('12-digit LRN'));
  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'draft', email: 'not-an-email' }), (error) => {
    assert.equal(error.field, 'email');
    return /valid email address/.test(error.message);
  });
  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'draft', lrn: '12x4' }), (error) => {
    assert.equal(error.field, 'lrn');
    return /digits only/.test(error.message);
  });
  assert.throws(() => normalizeRecord(readyInput({ firstName: '', email: '' })), (error) => {
    assert.deepEqual(error.fields, ['firstName', 'email']);
    return /Complete the paper form/.test(error.message);
  });
});

test('an empty or whitespace-only Draft is rejected while applicant details and explicit paper receipts qualify', () => {
  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'draft', applicantKind: 'new',
    receivedBy: 'Front Desk', receivedDate: '2026-10-21', studentSignaturePresent: '1', studentSignedDate: '2026-10-21' }),
  /at least one applicant detail or mark a paper item received/,
  'default school year, actor/date metadata, applicant kind, and signature flags alone are not saved applicant content');
  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'draft', applicantKind: 'continuing',
    preferredTrack: '', preferredCluster: '', targetGradeLevel: '' }),
  /at least one applicant detail or mark a paper item received/,
  'placeholder selections and applicant classification alone are not applicant details');
  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'draft', firstName: '   ', lastName: '   ',
    lrn: '   ', studentContactNumber: '   ', receivedBy: 'Front Desk', receivedDate: '2026-10-21' }),
  /at least one applicant detail or mark a paper item received/,
  'whitespace-only applicant values normalize away before the content check');
  assert.equal(normalizeRecord({ schoolYear: '2027-2028', status: 'draft', firstName: 'Ari' }).firstName, 'Ari');
  const receiptOnly = normalizeRecord({ schoolYear: '2027-2028', status: 'draft',
    receipt_report_card_original: '1', receipt_report_card_original_pieces: '1' });
  assert.equal(receiptOnly.firstName, null);
  assert.equal(receiptOnly.receipts.find(({ requirementCode }) => requirementCode === 'report_card').originalReceived, true,
    'explicit receipt of a paper item is sufficient content for a partial Draft');
});

test('readmission Drafts may await a reference, while supplied bindings validate and Ready requires one', () => {
  const id = 'c342bc01-2a68-4f19-a7fd-4d5bb1d83261';
  const partial = normalizeRecord({ schoolYear: '2027-2028', status: 'draft', applicantKind: 'readmission',
    lrn: '012345', targetGradeLevel: 'Grade 11' });
  assert.equal(partial.readmissionEvaluationId, null);
  assert.equal(partial.lrn, '012345');
  const supplied = normalizeRecord({ schoolYear: '2027-2028', status: 'draft', applicantKind: 'readmission',
    lrn: '012345', readmissionEvaluationBinding: `${id}@4` });
  assert.equal(supplied.readmissionEvaluationId, id);
  assert.equal(supplied.readmissionEvaluationVersion, 4);
  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'draft', applicantKind: 'readmission',
    lrn: '012345', readmissionEvaluationId: id }), /Reload the return evaluation/);
  assert.throws(() => normalizeRecord(readyInput({ applicantKind: 'readmission' })), (error) => {
    assert.ok(error.fields.includes('readmissionEvaluationBinding'));
    return /accepted, current return evaluation/.test(error.message);
  });
});

test('voucher type accepts only canonical new values and preserves unchanged historical values and category history', () => {
  for (const value of ['', 'PUB', 'ESC', 'NV']) {
    assert.equal(normalizeRecord(readyInput({ voucherTypeText: value })).voucherTypeText, value || null);
  }
  assert.throws(() => normalizeRecord(readyInput({ voucherTypeText: 'PUBLIC' })), /Choose PUB, ESC, NV/);

  const current = { voucher_type_text: 'ESC as written on the original form', voucher_category_text: 'Legacy category' };
  const preserved = normalizeRecord(readyInput({ voucherTypeText: current.voucher_type_text,
    voucherCategoryText: ['malformed hidden legacy field'] }), { current });
  assert.equal(preserved.voucherTypeText, current.voucher_type_text);
  assert.equal(preserved.voucherCategoryText, current.voucher_category_text);
  assert.throws(() => normalizeRecord(readyInput({ voucherTypeText: 'different arbitrary text' }), { current }), /Choose PUB, ESC, NV/);
  assert.equal(normalizeRecord(readyInput({ voucherCategoryText: 'new category input' })).voucherCategoryText, null,
    'removed category inputs never create or overwrite category history');
});

test('pre-enrollment and sections share an exact safe paper program catalog', () => {
  assert.deepEqual(PROGRAM_CATALOG['Academic Track'], [
    'ASSH (Arts, Social Science, and Humanities)',
    'BE (Business & Entrepreneurship)',
    'BE-TECH-PRO HM (Hospitality Management)'
  ]);
  for (const inheritedKey of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => normalizeRecord(readyInput({ preferredTrack: inheritedKey, preferredCluster: '' })), /listed preferred track/);
    assert.throws(() => normalizeRecord(readyInput({ preferredTrack: 'Academic Track', preferredCluster: inheritedKey })), /belongs to the selected preferred track/);
  }
});

test('shared paper program controls filter every cluster by selected track on both forms', () => {
  const controls = new Map();
  const makePair = (prefix, initialTrack, initialCluster) => {
    const trackListeners = {};
    const track = { value: initialTrack, addEventListener(type, callback) { trackListeners[type] = callback; }, change() { trackListeners.change?.(); } };
    const options = [{ value: '', dataset: {}, hidden: false, disabled: false },
      ...Object.entries(PROGRAM_CATALOG).flatMap(([trackName, clusters]) => clusters.map((clusterName) => ({
        value: clusterName, dataset: { track: trackName }, hidden: false, disabled: false
      })))];
    let selectedValue = initialCluster;
    const cluster = { options, get value() { return selectedValue; }, set value(value) { selectedValue = value; },
      get selectedOptions() { return options.filter((option) => option.value === selectedValue); } };
    controls.set(`${prefix}-track`, track);
    controls.set(`${prefix}-cluster`, cluster);
    return { track, cluster };
  };
  const pre = makePair('pre', 'Academic Track', PROGRAM_CATALOG['Academic Track'][0]);
  const section = makePair('section', 'Tech-Pro Track', PROGRAM_CATALOG['Tech-Pro Track'][1]);
  const source = fs.readFileSync(path.resolve(__dirname, '../public/js/paper-program-fields.js'), 'utf8');
  vm.runInNewContext(source, { document: { getElementById(id) { return controls.get(id) || null; } } });

  const preAcademic = pre.cluster.options.find((option) => option.value === PROGRAM_CATALOG['Academic Track'][0]);
  const preTech = pre.cluster.options.find((option) => option.value === PROGRAM_CATALOG['Tech-Pro Track'][0]);
  assert.equal(preAcademic.hidden, false);
  assert.equal(preTech.hidden, true);
  pre.track.value = 'Tech-Pro Track';
  pre.track.change();
  assert.equal(pre.cluster.value, '', 'changing tracks clears an incompatible saved cluster');
  assert.equal(preAcademic.disabled, true);
  assert.equal(preTech.disabled, false);
  const sectionIct = section.cluster.options.find((option) => option.value === PROGRAM_CATALOG['Tech-Pro Track'][1]);
  assert.equal(section.cluster.value, PROGRAM_CATALOG['Tech-Pro Track'][1]);
  assert.equal(sectionIct.disabled, false, 'section creation uses the same exact catalog filtering');
});

test('long brown envelope checkbox maps only an explicit replacement and preserves legacy receipt rows', () => {
  const received = normalizeRecord(readyInput({ envelopeReceiptMode: 'replace', receipt_long_brown_envelopes_received: '1' }));
  assert.deepEqual(received.receipts.at(-1), {
    requirementCode: 'long_brown_envelopes', originalReceived: true, originalPieces: 3,
    photocopyReceived: false, photocopyPieces: null
  });
  const unchecked = normalizeRecord(readyInput({ envelopeReceiptMode: 'replace' }));
  assert.deepEqual(unchecked.receipts.at(-1), {
    requirementCode: 'long_brown_envelopes', originalReceived: false, originalPieces: null,
    photocopyReceived: false, photocopyPieces: null
  });

  const legacy = { requirement_code: 'long_brown_envelopes', original_received: 1,
    original_pieces: 2, photocopy_received: 1, photocopy_pieces: 1 };
  const preserved = normalizeRecord(readyInput({ envelopeReceiptMode: 'preserve' }), {
    current: { voucher_category_text: 'Legacy category' }, currentReceipts: [legacy]
  });
  assert.deepEqual(preserved.receipts.at(-1), {
    requirementCode: 'long_brown_envelopes', originalReceived: true, originalPieces: 2,
    photocopyReceived: true, photocopyPieces: 1
  });
  assert.throws(() => normalizeRecord(readyInput({ envelopeReceiptMode: 'replace',
    receipt_long_brown_envelopes_original_pieces: '3' })), /one received checkbox/);
});

test('pre-enrollment optional birth date is blank or before the current Manila day', () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const priorDay = new Date(`${today}T00:00:00.000Z`);
  priorDay.setUTCDate(priorDay.getUTCDate() - 1);
  const priorDate = priorDay.toISOString().slice(0, 10);
  const nextDay = new Date(`${today}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDate = nextDay.toISOString().slice(0, 10);

  assert.equal(normalizeRecord({ schoolYear: '2027-2028', status: 'draft', firstName: 'Ari', birthDate: '' }).birthDate, null);
  assert.equal(normalizeRecord({ schoolYear: '2027-2028', status: 'draft', firstName: 'Ari', birthDate: priorDate }).birthDate, priorDate);
  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'draft', firstName: 'Ari', birthDate: today }), /Birth date must be before today/);
  assert.throws(() => normalizeRecord({ schoolYear: '2027-2028', status: 'draft', firstName: 'Ari', birthDate: nextDate }), /Birth date must be before today/);
});

test('return evaluation is required only for readmission and its selection survives status changes', () => {
  const listeners = {};
  const applicantKind = { value: 'new', addEventListener(type, callback) { listeners[type] = callback; } };
  const evaluation = { value: '', disabled: false, required: false };
  const field = { hidden: false };
  const form = { querySelector(selector) {
    return selector === '#pre-applicant-kind' ? applicantKind
      : selector === '#pre-readmission-evaluation' ? evaluation
        : selector === '[data-readmission-evaluation-field]' ? field : null;
  } };

  initializeReadmissionEvaluation(form);
  assert.equal(field.hidden, true);
  assert.equal(evaluation.disabled, true);
  assert.equal(evaluation.required, false);

  applicantKind.value = 'readmission';
  listeners.change();
  assert.equal(field.hidden, false);
  assert.equal(evaluation.disabled, false);
  assert.equal(evaluation.required, false, 'the server validates the accepted reference only when submitting as Ready');
  evaluation.value = 'c342bc01-2a68-4f19-a7fd-4d5bb1d83261@4';

  applicantKind.value = 'continuing';
  listeners.change();
  assert.equal(field.hidden, true);
  assert.equal(evaluation.disabled, true);
  assert.equal(evaluation.required, false);
  assert.equal(evaluation.value, 'c342bc01-2a68-4f19-a7fd-4d5bb1d83261@4');

  applicantKind.value = 'readmission';
  listeners.change();
  assert.equal(field.hidden, false);
  assert.equal(evaluation.disabled, false);
  assert.equal(evaluation.required, false);
  assert.equal(evaluation.value, 'c342bc01-2a68-4f19-a7fd-4d5bb1d83261@4');
});

test('birth-date validation and input max use the Manila day when UTC is still on the previous date', () => {
  const justAfterManilaMidnight = new Date('2026-10-01T16:00:00.000Z');
  const manilaToday = manilaDate(justAfterManilaMidnight);
  assert.equal(manilaToday, '2026-10-02');
  assert.equal(normalizeDate('2026-10-01', 'Birth date', false, manilaToday), '2026-10-01');
  assert.throws(() => normalizeDate(manilaToday, 'Birth date', false, manilaToday), /Birth date must be before today/);
  assert.equal(latestBirthDate(justAfterManilaMidnight), '2026-10-01');
});

test('pre-enrollment rejects a future birth date submitted directly to the server before database access', async () => {
  const csrfToken = 'c'.repeat(64);
  let poolCalls = 0;
  const service = createPreEnrollmentService({ getPool: async () => { poolCalls += 1; throw new Error('unexpected database access'); } });
  service.listAcceptedReadmissionChoices = async () => [];
  const app = express();
  app.set('views', path.resolve(__dirname, '../views'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.authUser = { id: 2, email: 'front-desk@test.invalid', role: 'front_desk' };
    req.session = { csrfToken };
    next();
  });
  app.use('/pre-enrollments', createPreEnrollmentRouter({ preEnrollmentService: service }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/pre-enrollments`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, schoolYear: '2027-2028', status: 'draft', birthDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()) })
    });
    const html = await response.text();
    assert.equal(response.status, 400);
    assert.match(html, /Birth date must be before today/);
    assert.match(html, /name="birthDate" type="date" max="\d{4}-\d{2}-\d{2}"/);
    assert.equal(poolCalls, 0, 'invalid direct requests fail before the service opens a transaction or persists a row');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('pre-enrollment person fields reject numeric garbage and accept legitimate Unicode names', () => {
  const valid = normalizeRecord(readyInput({
    facebookName: 'J. Ari 204', emergencyContactPerson: 'José O’Neill', emergencyContactRelationship: 'Guardian 2',
    motherName: 'María-José', fatherName: 'Jean-Luc D’Arcy', motherPhone: '09171234567', fatherPhone: '09171234567'
  }));
  assert.equal(valid.facebookName, 'J. Ari 204');
  assert.equal(valid.emergencyContactPerson, 'José O’Neill');
  assert.equal(valid.emergencyContactRelationship, 'Guardian 2');
  assert.equal(valid.motherPhone, valid.fatherPhone, 'shared household numbers remain valid');
  for (const [field, value] of [
    ['motherName', '12345'], ['fatherName', '0000'], ['emergencyContactPerson', '9876'],
    ['facebookName', '009988'], ['emergencyContactRelationship', '2']
  ]) assert.throws(() => normalizeRecord(readyInput({ [field]: value })), /letter/);
  assert.equal(normalizeRecord(readyInput({ motherName: '', fatherName: '', facebookName: '', emergencyContactPerson: '', emergencyContactRelationship: '' })).motherName, null);
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
  assert.throws(() => applyAddressInput({}, {
    addressMode: 'replace', addressBarangay: 'Barangay 4', addressCity: '123', addressProvince: 'Quezon'
  }, 'address'), /City must include at least one letter/);
  assert.throws(() => normalizeStructuredAddress({ addressProvince: '17' }, 'address'), /Province must include at least one letter/);
  const numberedAddress = normalizeStructuredAddress({
    addressBlockLotStreetPurok: 'Block 3, Lot 4', addressBarangay: 'Barangay 7',
    addressCity: 'Lucena 2', addressProvince: 'Quezon', addressZip: '0123'
  }, 'address');
  assert.equal(numberedAddress.address_barangay, 'Barangay 7');
  assert.equal(numberedAddress.address_zip, '0123');
  const digitOnlyComponents = normalizeStructuredAddress({
    addressBlockLotStreetPurok: '1234', addressBarangay: '7',
    addressCity: 'Lucena 2', addressProvince: 'Quezon', addressZip: '4301'
  }, 'address');
  assert.equal(digitOnlyComponents.address_block_lot_street_purok, '1234');
  assert.equal(digitOnlyComponents.address_barangay, '7');
  const masterProfile = validateStudent({ studentNo: 'S-1', lrn: '012345678901', firstName: 'Ari', lastName: 'Santos' });
  applyAddressInput(masterProfile, {
    addressMode: 'replace', addressBlockLotStreetPurok: '1234', addressBarangay: '7', addressZip: '4301'
  }, 'address');
  assert.equal(masterProfile.address, '1234, 7, 4301');
  assert.equal(masterProfile.addressCity, null);

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
    })).concat([{ requirement_code: 'long_brown_envelopes', original_received: 1, original_pieces: 3,
      photocopy_received: 0, photocopy_pieces: null }]),
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

function createPreEnrollmentTransactionHarness({ evaluation = null, students = [], duplicateAnnual = [], history = [], current = null } = {}) {
  const queries = [];
  const createdSubmissions = new Map();
  let poolCalls = 0;
  const sql = {
    ISOLATION_LEVEL: { SERIALIZABLE: 'serializable' }, MAX: 'MAX', Int: 'INT', Date: 'DATE', Bit: 'BIT', SmallInt: 'SMALLINT',
    Char: () => 'CHAR', VarChar: () => 'VARCHAR', NVarChar: () => 'NVARCHAR'
  };
  class Request {
    constructor() { this.inputs = {}; }
    input(name, _type, value) { this.inputs[name] = value; return this; }
    async query(statement) {
      const normalized = statement.replace(/\s+/g, ' ').trim();
      const call = { statement: normalized, inputs: { ...this.inputs } };
      queries.push(call);
      if (normalized.startsWith('SELECT account.id, account.role')) {
        return { recordset: [{ id: 1, role: 'front_desk', first_name: 'Synthetic', last_name: 'Desk' }] };
      }
      if (normalized.startsWith('SELECT id, request_fingerprint FROM pre_enrollments WHERE idempotency_key')) {
        const prior = createdSubmissions.get(call.inputs.idempotencyKey);
        return { recordset: prior ? [{ ...prior }] : [] };
      }
      if (normalized.includes('FROM readmission_evaluations WHERE id = @evaluationId FOR UPDATE')) {
        return { recordset: evaluation ? [evaluation] : [] };
      }
      if (normalized === 'SELECT id FROM students WHERE lrn = @lrn FOR UPDATE') {
        return { recordset: students.filter((student) => student.lrn === call.inputs.lrn).map(({ id }) => ({ id })) };
      }
      if (normalized === 'SELECT id, lrn FROM students WHERE id = @evaluationStudentId FOR UPDATE') {
        return { recordset: students.filter((student) => Number(student.id) === call.inputs.evaluationStudentId) };
      }
      if (normalized.startsWith('SELECT id FROM annual_enrollments WHERE student_id = @studentId')) {
        return { recordset: duplicateAnnual };
      }
      if (normalized.startsWith('SELECT annual.school_year, annual.intake_status')) return { recordset: history };
      if (normalized.startsWith('SELECT entry.*')) return { recordset: current ? [{ ...current }] : [] };
      if (normalized.startsWith('SELECT * FROM pre_enrollment_receipts')) return { recordset: [] };
      if (normalized.startsWith('INSERT INTO pre_enrollments')) {
        createdSubmissions.set(call.inputs.idempotencyKey, { id: call.inputs.recordId, request_fingerprint: call.inputs.fingerprint });
      }
      if (normalized.startsWith('UPDATE pre_enrollments SET')) return { rowsAffected: [1] };
      return { recordset: [], rowsAffected: [1] };
    }
  }
  class Transaction {
    constructor() { this.started = false; }
    async begin() { this.started = true; }
    request() { return new Request(); }
    async commit() { this.started = false; }
    async rollback() { this.started = false; }
  }
  const pool = { request: () => new Request() };
  const service = createPreEnrollmentService({ getPool: async () => { poolCalls += 1; return pool; }, sql, transactionFactory: () => new Transaction() });
  return { service, queries, getPoolCalls: () => poolCalls };
}

test('empty direct Draft submissions stop before database access and valid Draft retries remain idempotent', async () => {
  const empty = createPreEnrollmentTransactionHarness();
  await assert.rejects(empty.service.create(1, { schoolYear: '2027-2028', status: 'draft', applicantKind: 'new',
    receivedBy: 'Front Desk', receivedDate: '2026-10-21', studentSignaturePresent: '1', studentSignedDate: '2026-10-21',
    idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83260' }), /at least one applicant detail or mark a paper item received/);
  assert.equal(empty.getPoolCalls(), 0, 'normalization rejects a default-only direct request before opening a database connection');
  assert.equal(empty.queries.length, 0, 'an invalid empty Draft cannot write a row or audit event');

  const serviceHarness = createPreEnrollmentTransactionHarness();
  const partial = { schoolYear: '2027-2028', status: 'draft', firstName: 'Ari',
    idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83261' };
  const saved = await serviceHarness.service.create(1, partial);
  const repeated = await serviceHarness.service.create(1, partial);
  assert.equal(saved.alreadyCreated, false);
  assert.equal(repeated.id, saved.id);
  assert.equal(repeated.alreadyCreated, true, 'a repeated valid Draft submission returns its existing row');
  assert.equal(serviceHarness.queries.filter(({ statement }) => statement.startsWith('INSERT INTO pre_enrollments')).length, 1,
    'an idempotent retry does not insert a duplicate record');
});

test('pre-enrollment Draft transaction defers missing readmission evaluation without creating student or annual rows', async () => {
  const learner = { id: 44, lrn: '012345678901' };
  const noEvaluation = createPreEnrollmentTransactionHarness({ students: [learner], history: [
    { school_year: '2025-2026', intake_status: 'enrolled', has_departure: 0 }
  ] });
  const saved = await noEvaluation.service.create(1, { schoolYear: '2027-2028', status: 'draft', applicantKind: 'readmission',
    lrn: learner.lrn, idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83263' });
  assert.equal(saved.alreadyCreated, false);
  assert.ok(noEvaluation.queries.some(({ statement }) => statement.startsWith('INSERT INTO pre_enrollments')));
  assert.ok(noEvaluation.queries.some(({ statement }) => statement.startsWith('SELECT annual.school_year')),
    'existing enrollment history still informs readmission eligibility');
  assert.equal(noEvaluation.queries.some(({ statement }) => /INSERT INTO (students|annual_enrollments)/.test(statement)), false,
    'saving a Draft creates only the paper intake row and its audit/receipt history');

  const currentReference = { id: 'c342bc01-2a68-4f19-a7fd-4d5bb1d83261', applicant_lrn: learner.lrn, student_id: learner.id,
    school_year: '2027-2028', target_grade_level: 'Grade 11', status: 'accepted', version: 4, curriculum_review_status: 'resolved' };
  const partialBinding = createPreEnrollmentTransactionHarness({ evaluation: currentReference, students: [learner] });
  await partialBinding.service.create(1, { schoolYear: '2027-2028', status: 'draft', applicantKind: 'readmission',
    lrn: '012345', readmissionEvaluationBinding: `${currentReference.id}@4`,
    idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83264' });
  assert.ok(partialBinding.queries.some(({ statement }) => statement === 'SELECT id, lrn FROM students WHERE id = @evaluationStudentId FOR UPDATE'),
    'a supplied reference still verifies ownership when the Draft LRN is incomplete');
  assert.ok(partialBinding.queries.some(({ statement }) => statement.startsWith('INSERT INTO pre_enrollments')));

  const staleBinding = createPreEnrollmentTransactionHarness({ evaluation: { ...currentReference, version: 3 } });
  await assert.rejects(staleBinding.service.create(1, { schoolYear: '2027-2028', status: 'draft', applicantKind: 'readmission',
    lrn: '012345', readmissionEvaluationBinding: `${currentReference.id}@4`,
    idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83265' }), /no longer accepted and current/);
  assert.equal(staleBinding.queries.some(({ statement }) => statement.startsWith('INSERT INTO pre_enrollments')), false,
    'stale supplied evaluation references cannot be stored in a Draft');

  const duplicate = createPreEnrollmentTransactionHarness({ students: [learner], duplicateAnnual: [{ id: 92 }] });
  await assert.rejects(duplicate.service.create(1, { schoolYear: '2027-2028', status: 'draft', applicantKind: 'readmission',
    lrn: learner.lrn, idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83266' }), /already has an annual record/);
  assert.equal(duplicate.queries.some(({ statement }) => statement.startsWith('INSERT INTO pre_enrollments')), false,
    'same-year duplicate guards remain active for Drafts');
});

test('Ready record updates preserve their status without an action and allow only an explicit Draft action to downgrade', async () => {
  const current = Object.fromEntries([
    ['id', 'a342bc01-2a68-4f19-a7fd-4d5bb1d83267'], ['status', 'ready_for_registrar'], ['version', 3],
    ['school_year', '2027-2028'], ['applicant_kind', 'new'], ['student_signature_present', 0]
  ]);
  current.school_year = '2027-2028';
  current.applicant_kind = 'new';
  const noAction = createPreEnrollmentTransactionHarness({ current });
  const input = readyInput({ status: undefined });
  const updated = await noAction.service.update(1, current.id, 3, input);
  assert.equal(updated.status, 'ready_for_registrar');
  assert.equal(noAction.queries.find(({ statement }) => statement.startsWith('UPDATE pre_enrollments SET'))?.inputs.status,
    'ready_for_registrar');

  const explicitDraft = createPreEnrollmentTransactionHarness({ current });
  const downgraded = await explicitDraft.service.update(1, current.id, 3, readyInput({ status: 'draft' }));
  assert.equal(downgraded.status, 'draft');
  assert.equal(explicitDraft.queries.find(({ statement }) => statement.startsWith('UPDATE pre_enrollments SET'))?.inputs.status,
    'draft', 'a downgrade is possible only when the user explicitly chooses Save draft');
});

test('pre-enrollment routes keep database administrators read-only and deny unrelated staff roles', async () => {
  const app = express();
  const csrfToken = 'c'.repeat(64);
  const calls = [];
  const successfulCreates = [];
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
      async create(actorId, input) {
        calls.push(['create', actorId]);
        const record = normalizeRecord(input);
        successfulCreates.push({ actorId, record });
        return { id: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83261' };
      },
      async update(actorId, id, version, input) {
        calls.push(['update', actorId]); updateInputs.push(input);
        if (input.lastName === 'stale-version') throw new PreEnrollmentError('This record changed after the form was opened. Reload and review the latest version.', 409);
        throw new PreEnrollmentError('The correction needs a current accepted evaluation.', 409, 'readmissionEvaluationBinding');
      },
      async listAcceptedReadmissionChoices(actorId, schoolYear) { choicesCalls.push([actorId, schoolYear]); return [acceptedChoice]; },
      async get(actorId, id) {
        calls.push(['get', actorId]);
        const record = detailRecord(id, ['b342bc01-2a68-4f19-a7fd-4d5bb1d83261', 'd342bc01-2a68-4f19-a7fd-4d5bb1d83261', 'e342bc01-2a68-4f19-a7fd-4d5bb1d83261'].includes(id)
          ? 'enrollment_started' : 'ready_for_registrar');
        if (id === 'f342bc01-2a68-4f19-a7fd-4d5bb1d83261') {
          record.events = [{
            ...record.events[0],
            details_json: JSON.stringify({ demoFixture: { fixtureType: 'hostinger-demo-legacy-intake-v2' } })
          }];
        }
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
    assert.match(newFormHtml, /Voucher type as written <span class="muted-copy">\(optional\)<\/span>/);
    assert.match(newFormHtml, /name="voucherTypeText"/);
    assert.doesNotMatch(newFormHtml, /voucher category|voucherCategoryText/i,
      'removed voucher category is absent from active paper forms');
    assert.doesNotMatch(newFormHtml, /Historical value \(preserve\)/,
      'new forms never relabel rejected POST text as a saved historical value');
    for (const cluster of Object.values(PROGRAM_CATALOG).flat()) assert.ok(newFormHtml.includes(cluster.replaceAll('&', '&amp;')),
      `paper cluster option ${cluster} is present for dynamic track selection`);
    assert.match(newFormHtml, /src="\/js\/paper-program-fields\.js" defer/);
    assert.match(newFormHtml, /Three long brown envelopes received/);
    assert.match(newFormHtml, /<label for="pre-email">Email<\/label>/);
    assert.match(newFormHtml, /aria-describedby="pre-email-help"/);
    assert.match(newFormHtml, /id="pre-email-help">This email will be used for the student’s account\./);
    assert.ok(newFormHtml.indexOf('<label for="pre-email">Email</label>') < newFormHtml.indexOf('data-pre-enrollment-optional-profile'),
      'required Email stays visible before the collapsed optional profile details');
    assert.match(newFormHtml, /<details class="pre-enrollment-optional-details" data-pre-enrollment-optional-profile>/,
      'optional profile, address, family, and emergency details are collapsed on a clean form');
    assert.match(newFormHtml, /<details class="pre-enrollment-optional-details" data-pre-enrollment-receipts><summary>Optional receipt checklist/,
      'the optional receipt checklist has a separate collapsed disclosure');
    for (const [id, name] of [['pre-lrn', 'lrn'], ['pre-track', 'preferredTrack'], ['pre-grade', 'targetGradeLevel'],
      ['pre-prior-grade', 'priorGradeLevel'], ['pre-prior-school', 'priorSchool'], ['pre-signature-check', 'studentSignaturePresent'],
      ['pre-received-date', 'receivedDate']]) {
      assert.match(newFormHtml, new RegExp(`id="${id}"[^>]*name="${name}"`), `${name} remains in the visible paper form`);
    }
    const optionalProfileBlock = newFormHtml.match(/<details class="pre-enrollment-optional-details" data-pre-enrollment-optional-profile>([\s\S]*?)<\/details>/)?.[1];
    assert.ok(optionalProfileBlock);
    assert.match(optionalProfileBlock, /name="birthDate"/);
    assert.match(optionalProfileBlock, /name="addressBlockLotStreetPurok"/);
    assert.match(optionalProfileBlock, /name="motherName"/);
    assert.match(optionalProfileBlock, /name="emergencyContactPerson"/);
    assert.match(newFormHtml, /name="receipt_report_card_original"/);
    assert.match(newFormHtml, /name="emergencyContactSameAsStudent" value="1"[^>]*><span>Same address as student<\/span>/);
    assert.match(newFormHtml, /src="\/js\/pre-enrollment-address-copy\.js" defer/);
    assert.match(newFormHtml, /data-readmission-evaluation-field/);
    assert.match(newFormHtml, /data-pre-enrollment-form/);
    assert.match(newFormHtml, /novalidate/);
    assert.match(newFormHtml, /Save an incomplete Draft after entering at least one applicant detail or marking a paper item received; an empty form cannot be saved/);
    assert.match(newFormHtml, /name="status" value="draft">Save draft/);
    assert.match(newFormHtml, /name="status" value="ready_for_registrar">Submit as Ready/);
    assert.doesNotMatch(newFormHtml, /<select[^>]+name="status"/);
    assert.match(newFormHtml, /src="\/js\/form-unsaved-changes\.js" defer/);
    assert.match(newFormHtml, /src="\/js\/pre-enrollment-readmission\.js" defer/);
    assert.match(fs.readFileSync(path.resolve(__dirname, '../public/css/app.css'), 'utf8'),
      /\.pre-enrollment-form \[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
    assert.match(newFormHtml, /accepted evaluation for this applicant, school year, and grade/);
    assert.doesNotMatch(newFormHtml, /profile source|saved binding is stale|explicit current selection/i);
    assert.match(newFormHtml, /Copy these contact details from the paper form/);
    assert.doesNotMatch(newFormHtml, /name="emergencyContactSameAsStudent" value="1"[^>]*checked/,
      'fresh pre-enrollment forms start unchecked');
    const idempotencyKey = newFormHtml.match(/name="idempotencyKey" value="([0-9a-f-]{36})"/)?.[1];
    assert.ok(idempotencyKey);
    const writesBeforeCsrfFailures = calls.filter(([method]) => ['create', 'update'].includes(method)).length;
    for (const token of [undefined, 'invalid-csrf-token']) {
      const headers = { 'x-test-role': 'front_desk', 'content-type': 'application/x-www-form-urlencoded' };
      const fields = { idempotencyKey, schoolYear: '2027-2028', status: 'draft' };
      if (token !== undefined) fields._csrf = token;
      const rejected = await fetch(`${origin}/pre-enrollments`, { method: 'POST', headers,
        body: new URLSearchParams(fields) });
      assert.equal(rejected.status, 403, 'authorized front desk still needs a valid CSRF token to create a paper draft');
    }
    for (const token of [undefined, 'invalid-csrf-token']) {
      const headers = { 'x-test-role': 'registrar', 'content-type': 'application/x-www-form-urlencoded' };
      const fields = { version: '2', schoolYear: '2027-2028', status: 'draft' };
      if (token !== undefined) fields._csrf = token;
      const rejected = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`, {
        method: 'POST', headers, body: new URLSearchParams(fields)
      });
      assert.equal(rejected.status, 403, 'authorized registrar still needs a valid CSRF token to edit a paper record');
    }
    assert.equal(calls.filter(([method]) => ['create', 'update'].includes(method)).length, writesBeforeCsrfFailures,
      'missing or invalid CSRF requests are rejected before create/update service writes');
    const blankDraft = await fetch(`${origin}/pre-enrollments`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey, schoolYear: '2027-2028', status: 'draft' }), redirect: 'manual'
    });
    const blankDraftHtml = await blankDraft.text();
    assert.equal(blankDraft.status, 400, 'a default-only Draft is rejected by the HTTP route');
    assert.match(blankDraftHtml, /Add at least one applicant detail or mark a paper item received before saving a Draft/);
    assert.match(blankDraftHtml, /id="pre-enrollment-error-summary" role="alert" tabindex="-1"/,
      'the validation response exposes the focusable error summary even when no individual field is invalid');
    assert.doesNotMatch(blankDraftHtml, /notice=saved|enrollment_started/i,
      'an empty submission does not show a saved or enrolled outcome');
    assert.equal(successfulCreates.length, 0, 'the route service does not persist an empty Draft');
    const whitespaceDraft = await fetch(`${origin}/pre-enrollments`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey, schoolYear: '2027-2028', status: 'draft',
        firstName: '   ', lrn: '  ', receivedBy: 'Front Desk', receivedDate: '2026-10-21' })
    });
    assert.equal(whitespaceDraft.status, 400, 'whitespace-only direct requests are not meaningful Drafts');
    assert.equal(successfulCreates.length, 0, 'auto-filled receipt metadata does not cause an empty request to persist');
    const partialDraft = await fetch(`${origin}/pre-enrollments`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey, schoolYear: '2027-2028', status: 'draft', firstName: 'Draft learner' }),
      redirect: 'manual'
    });
    assert.equal(partialDraft.status, 303, 'a partial Draft with applicant content still saves through the HTTP route');
    assert.match(partialDraft.headers.get('location'), /\?notice=saved$/);
    assert.equal(successfulCreates.length, 1);
    assert.equal(successfulCreates[0].record.status, 'draft');
    const validReady = await fetch(`${origin}/pre-enrollments`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83270', ...readyInput() }),
      redirect: 'manual'
    });
    assert.equal(validReady.status, 303, 'the new Draft content guard leaves a complete Ready submission valid');
    assert.equal(successfulCreates.length, 2);
    assert.equal(successfulCreates[1].record.status, 'ready_for_registrar');
    const readyFailure = await fetch(`${origin}/pre-enrollments`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83262',
        schoolYear: '2027-2028', firstName: 'Recovered first name', status: 'ready_for_registrar' })
    });
    const readyFailureHtml = await readyFailure.text();
    assert.equal(readyFailure.status, 400);
    assert.match(readyFailureHtml, /Complete the paper form/);
    assert.match(readyFailureHtml, /href="#pre-last" data-error-target="lastName">Last name/);
    assert.match(readyFailureHtml, /href="#pre-lrn" data-error-target="lrn">LRN/);
    assert.match(readyFailureHtml, /data-unsaved-initially-dirty="true"/);
    assert.match(readyFailureHtml, /id="pre-first" name="firstName" maxlength="100" value="Recovered first name"/);
    assert.match(readyFailureHtml, /<details class="pre-enrollment-optional-details" data-pre-enrollment-optional-profile>/,
      'required-field Ready errors do not expand unrelated optional details');
    assert.match(readyFailureHtml, /<details class="pre-enrollment-optional-details" data-pre-enrollment-receipts>/,
      'required-field Ready errors leave the optional receipt checklist collapsed');
    const invalidOptionalProfile = await fetch(`${origin}/pre-enrollments`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83263',
        schoolYear: '2027-2028', status: 'draft', profilePhone: 'not a phone' })
    });
    const invalidOptionalProfileHtml = await invalidOptionalProfile.text();
    assert.equal(invalidOptionalProfile.status, 400);
    assert.match(invalidOptionalProfileHtml, /href="#pre-profile-phone" data-error-target="profilePhone">Phone/);
    assert.match(invalidOptionalProfileHtml, /data-pre-enrollment-optional-profile open/,
      'a format error in optional profile data expands the section containing the error');
    assert.match(invalidOptionalProfileHtml, /id="pre-profile-phone" name="profilePhone" type="tel" maxlength="50" value="not a phone"/,
      'failed optional profile input remains available for correction');
    assert.match(invalidOptionalProfileHtml, /<details class="pre-enrollment-optional-details" data-pre-enrollment-receipts>/,
      'a profile error does not expand the neighboring receipt checklist');
    const invalidOptionalReceipt = await fetch(`${origin}/pre-enrollments`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, idempotencyKey: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83264',
        schoolYear: '2027-2028', status: 'draft', receipt_report_card_original: '1', receipt_report_card_original_pieces: '0' })
    });
    const invalidOptionalReceiptHtml = await invalidOptionalReceipt.text();
    assert.equal(invalidOptionalReceipt.status, 400);
    assert.match(invalidOptionalReceiptHtml, /href="#receipt-report_card-original" data-error-target="receipt_report_card_original_pieces/);
    assert.match(invalidOptionalReceiptHtml, /data-pre-enrollment-receipts open/,
      'a receipt error expands the receipt disclosure so the linked control is reachable');
    assert.match(invalidOptionalReceiptHtml, /id="receipt-report_card-original" name="receipt_report_card_original_pieces" type="number" min="1" max="99"[^>]*value="0"/,
      'failed receipt quantity remains visible for correction');
    assert.match(invalidOptionalReceiptHtml, /<details class="pre-enrollment-optional-details" data-pre-enrollment-optional-profile>/,
      'a receipt error does not expand the neighboring optional profile details');
    const detail = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`);
    assert.equal(detail.status, 200);
    const detailHtml = await detail.text();
    assert.match(detailHtml, /Voucher type as written/);
    assert.match(detailHtml, /ESC as written on original school form/);
    assert.doesNotMatch(detailHtml, /voucher category|CATEGORY A/i,
      'record detail hides category while retaining it in persisted history');
    for (const [, label] of RECEIPT_REQUIREMENTS) assert.ok(detailHtml.includes(label), `detail renders receipt row ${label}`);
    for (const label of ['Student identity', 'Student contact', 'Student address', 'Parents and guardians',
      'Emergency contact', 'Program and previous school', 'Signature and office record', 'Entered by']) {
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
    assert.doesNotMatch(detailHtml, /Synthetic demo intake record/);

    const syntheticDetail = await fetch(`${origin}/pre-enrollments/f342bc01-2a68-4f19-a7fd-4d5bb1d83261`);
    assert.equal(syntheticDetail.status, 200);
    const syntheticDetailHtml = await syntheticDetail.text();
    assert.match(syntheticDetailHtml, /Synthetic demo intake record/);
    assert.match(syntheticDetailHtml, /No paper form, actual signature, received receipt, or paper clearance was inspected or recorded/);

    const registrarDetail = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`, {
      headers: { 'x-test-role': 'registrar' }
    });
    assert.match(await registrarDetail.text(), /Start enrollment/);
    const registrarList = await fetch(`${origin}/pre-enrollments`, { headers: { 'x-test-role': 'registrar' } });
    assert.doesNotMatch(await registrarList.text(), /Record paper form/, 'only front desk can create paper records');
    const registrarEdit = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261/edit`, { headers: { 'x-test-role': 'registrar' } });
    const registrarEditHtml = await registrarEdit.text();
    assert.equal(registrarEdit.status, 200);
    assert.match(registrarEditHtml, /Historical value \(preserve\): ESC as written on original school form/,
      'an existing record alone receives a selected option for its unchanged historical voucher text');
    assert.ok(registrarEditHtml.indexOf('name="status" value="ready_for_registrar">Save corrections as Ready')
      < registrarEditHtml.indexOf('name="status" value="draft">Save draft'),
    'the Ready action is the default keyboard submit on a Ready edit, while an explicit Save draft remains available');
    assert.match(registrarEditHtml, /name="receipt_long_brown_envelopes_received" value="1" data-envelope-receipt-checkbox checked/,
      'saved exact envelope receipt is shown checked before an edit');
    const savedOptionalProfile = registrarEditHtml.match(/<details class="pre-enrollment-optional-details" data-pre-enrollment-optional-profile>([\s\S]*?)<\/details>/)?.[1];
    assert.ok(savedOptionalProfile?.includes('value="2008-04-21"'),
      'saved profile values remain in the collapsed editor and are discoverable by expanding it');
    assert.doesNotMatch(registrarEditHtml, /name="voucherCategoryText"/);
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
        envelopeReceiptMode: 'replace',
        emergencyContactPerson: 'Mae Santos', emergencyContactRelationship: 'Mother', emergencyContactPhone: '09181234567',
        emergencyContactAddressMode: 'replace', emergencyContactAddressBlockLotStreetPurok: 'Separate emergency draft',
        emergencyContactAddressZip: 'bad' })
    });
    const correctionHtml = await csrfCorrection.text();
    assert.equal(csrfCorrection.status, 409);
    assert.ok(correctionHtml.includes('value="c342bc01-2a68-4f19-a7fd-4d5bb1d83261@4" selected'),
      'a failed correction rerender retains the explicit evaluation binding and version');
    assert.match(correctionHtml, /href="#pre-readmission-evaluation" data-error-target="readmissionEvaluationBinding">Accepted return evaluation/);
    assert.match(correctionHtml, /data-unsaved-initially-dirty="true"/,
      'a failed update rerender starts with recovered values still marked unsaved');
    assert.match(correctionHtml, /name="emergencyContactSameAsStudent" value="1"[^>]*checked/,
      'validation-error rerenders retain the transient checkbox');
    assert.match(correctionHtml, /value="Separate emergency draft"/);
    assert.match(correctionHtml, /value="bad"/);
    assert.match(correctionHtml, /name="envelopeReceiptMode" value="replace"/);
    assert.match(correctionHtml, /name="receipt_long_brown_envelopes_received" value="1" data-envelope-receipt-checkbox(?![^>]*checked)/,
      'an explicitly unchecked replacement remains unchecked after an unrelated validation error');
    assert.doesNotMatch(correctionHtml, /name="voucherCategoryText"/,
      'unrelated edits do not submit a removed hidden category field');
    assert.equal(updateInputs[0].emergencyContactSameAsStudent, '1',
      'the checked value reaches the service in the ordinary URL-encoded request');
    assert.equal(updateInputs[0].emergencyContactPerson, 'Mae Santos');
    assert.equal(updateInputs[0].emergencyContactRelationship, 'Mother');
    assert.equal(updateInputs[0].emergencyContactPhone, '09181234567');
    const staleCorrection = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`, {
      method: 'POST', headers: { 'x-test-role': 'registrar', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfToken, version: '1', schoolYear: '2027-2028', lastName: 'stale-version' })
    });
    const staleCorrectionHtml = await staleCorrection.text();
    assert.equal(staleCorrection.status, 409);
    assert.match(staleCorrectionHtml, /Another staff member saved a newer version/);
    assert.match(staleCorrectionHtml, /href="\/pre-enrollments\/a342bc01-2a68-4f19-a7fd-4d5bb1d83261\/edit">Reload latest record/);
    assert.match(staleCorrectionHtml, /name="version" value="1"/,
      'stale recovery retains the version that was submitted instead of silently rebasing to the latest record');
    assert.match(staleCorrectionHtml, /id="pre-last" name="lastName" maxlength="100" value="stale-version"/,
      'stale recovery retains the unsaved correction for staff review');
    assert.match(staleCorrectionHtml, /data-unsaved-initially-dirty="true"/);
    assert.match(staleCorrectionHtml, /data-pre-enrollment-optional-profile open/,
      'a stale conflict without field links opens optional-profile details so recovered inputs are visible');
    assert.match(staleCorrectionHtml, /data-pre-enrollment-receipts open/,
      'a stale conflict without field links opens the receipt checklist so recovered inputs are visible');
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
    assert.deepEqual(calls.filter(([method]) => ['create', 'update'].includes(method)), [
      ['create', roleIds.front_desk], ['create', roleIds.front_desk], ['create', roleIds.front_desk], ['create', roleIds.front_desk],
      ['create', roleIds.front_desk], ['create', roleIds.front_desk], ['create', roleIds.front_desk],
      ['update', roleIds.registrar], ['update', roleIds.registrar]
    ], 'authorized front-desk attempts reach the validation service, while admin and unrelated roles stop before writes; only registrar can submit corrections');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
