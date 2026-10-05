'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const express = require('express');
const { normalizeRecord, RECEIPT_REQUIREMENTS } = require('../src/services/preEnrollmentService');
const { createPreEnrollmentRouter } = require('../src/routes/preEnrollments');
const { requireRole } = require('../src/middleware/roles');
const { applyAddressInput } = require('../src/services/studentRecordsService');
const { normalizeStructuredAddress, StudentAddressError } = require('../src/utils/studentAddress');

function readyInput(overrides = {}) {
  return {
    schoolYear: '2027-2028', firstName: 'Ari', middleName: 'Mae', lastName: 'Santos', suffix: '', lrn: '012345678901',
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
  const roleIds = { registrar: 1, front_desk: 2, database_admin: 3, teacher: 4, finance: 5, student: 6 };
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
      async list(actorId) { calls.push(['list', actorId]); return { rows: [], filters: { search: '', schoolYear: '', status: '' }, pagination: { page: 1, pageSize: 20, totalRecords: 0, totalPages: 1, from: 0, to: 0 } }; },
      async getActorDisplayName(actorId) { calls.push(['display', actorId]); return 'Front Desk'; },
      async create(actorId) { calls.push(['create', actorId]); return { id: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83261' }; },
      async update(actorId) { calls.push(['update', actorId]); return { id: 'a342bc01-2a68-4f19-a7fd-4d5bb1d83261' }; },
      async get(actorId, id) { calls.push(['get', actorId]); return detailRecord(id, id === 'b342bc01-2a68-4f19-a7fd-4d5bb1d83261' ? 'enrollment_started' : 'ready_for_registrar'); }
    }
  }));
  app.post('/registrar/intake', requireRole('registrar'), (_req, res) => res.status(204).end());
  const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const frontDeskHome = await fetch(`${origin}/front-desk`, { redirect: 'manual' });
    assert.equal(frontDeskHome.status, 303);
    assert.equal(frontDeskHome.headers.get('location'), '/pre-enrollments');
    assert.equal((await fetch(`${origin}/pre-enrollments`)).status, 200);
    assert.equal((await fetch(`${origin}/pre-enrollments/new`)).status, 200);
    const detail = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`);
    assert.equal(detail.status, 200);
    const detailHtml = await detail.text();
    for (const [, label] of RECEIPT_REQUIREMENTS) assert.ok(detailHtml.includes(label), `detail renders receipt row ${label}`);
    for (const label of ['Student and contact', 'Program and previous school', 'Signature and office record', 'Entered by']) {
      assert.ok(detailHtml.includes(label), `detail presents the grouped ${label} information`);
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
    const startedDetail = await fetch(`${origin}/pre-enrollments/b342bc01-2a68-4f19-a7fd-4d5bb1d83261`);
    const startedHtml = await startedDetail.text();
    assert.match(startedHtml, /Enrollment started/);
    assert.match(startedHtml, /Read-only after annual enrollment starts/);
    assert.doesNotMatch(startedHtml, /Correct paper record|Start enrollment/);

    const adminHeaders = { 'x-test-role': 'database_admin' };
    const adminList = await fetch(`${origin}/pre-enrollments`, { headers: adminHeaders });
    assert.equal(adminList.status, 200);
    assert.doesNotMatch(await adminList.text(), /Record paper form/);
    const adminDetail = await fetch(`${origin}/pre-enrollments/a342bc01-2a68-4f19-a7fd-4d5bb1d83261`, { headers: adminHeaders });
    assert.equal(adminDetail.status, 200);
    assert.doesNotMatch(await adminDetail.text(), /Correct paper record|Start enrollment/);
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
    assert.deepEqual(calls.filter(([method]) => ['create', 'update'].includes(method)), [],
      'read-only/unauthorized role requests stop before service writes');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
