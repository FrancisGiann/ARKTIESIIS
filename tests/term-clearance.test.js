'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ejs = require('ejs');
const { once } = require('node:events');
const express = require('express');
const { requireRole } = require('../src/middleware/roles');
const {
  TermClearanceError, cleanTemplateInput, cleanReconciliation, cleanItemUpdates,
  completeFromCounts, awaitingRegistrarConfirmation, clearanceEventSummary, isPastAcademicTerm
} = require('../src/services/termClearanceService');
const { createStudentRecordsRouter } = require('../src/routes/studentRecords');
const { createStudentPortalRouter } = require('../src/routes/studentPortal');

const checkedTemplate = { gradeLevel: 'Grade 11', trackLabel: 'Academic Track', registrarLabel: 'Registrar',
  guidanceLabel: 'Guidance', financeLabel: 'Finance', paperFormConfirmed: '1', teacherRosterConfirmed: '1',
  laboratoryRowsConfirmed: '1' };

test('template input allows explicitly approved no-laboratory paper forms and ignores blank form fields', () => {
  const clean = cleanTemplateInput({ ...checkedTemplate, laboratoryLabels: ['', '  '] });
  assert.deepEqual(clean.laboratoryLabels, []);
  assert.throws(() => cleanTemplateInput({ ...checkedTemplate, laboratoryRowsConfirmed: '' }), TermClearanceError);
  assert.deepEqual(cleanTemplateInput({ ...checkedTemplate, laboratoryLabels: ['Chemistry Lab'] }).laboratoryLabels,
    ['Chemistry Lab']);
});

test('paper roster reconciliation requires reasoned manual teacher rows and rejects duplicates', () => {
  assert.deepEqual(cleanReconciliation({}), { rows: [], reason: null, reviewed: false });
  assert.throws(() => cleanReconciliation({ paperTeacherRows: [{ subjectName: 'General Mathematics' }] }), /reason/i);
  const clean = cleanReconciliation({ rosterReviewed: '1', rosterReconciliationReason: 'Matched school paper record',
    paperTeacherRows: [{ subjectCode: '', subjectName: 'Historical subject' }] });
  assert.equal(clean.rows[0].subjectName, 'Historical subject');
  assert.throws(() => cleanReconciliation({ rosterReviewed: '1', rosterReconciliationReason: 'Compared with paper',
    paperTeacherRows: [{ subjectCode: 'MATH', subjectName: 'Math' }, { subjectCode: 'math', subjectName: 'MATH' }] }), /more than once/i);
});

test('signature updates require explicit applicability and preserve optional paper dates', () => {
  const [update] = cleanItemUpdates({ items: [{ itemId: '5', applicabilityStatus: 'required', signaturePresent: '1',
    signerName: 'Paper teacher', paperSignedOn: '', signerContextReason: 'Teacher name recorded on prior paper form' }] });
  assert.equal(update.paperSignedOn, null);
  assert.equal(update.signerName, 'Paper teacher');
  const [undecidedLaboratory] = cleanItemUpdates({ items: [{ itemId: '6', applicabilityStatus: 'unreviewed' }] });
  assert.equal(undecidedLaboratory.applicabilityStatus, 'unreviewed', 'an unresolved lab row can be saved as progress');
  assert.throws(() => cleanItemUpdates({ items: [{ itemId: '6', applicabilityStatus: 'unreviewed', signaturePresent: '1', signerName: 'Lab signer' }] }), /clear the laboratory signature/i);
  assert.throws(() => cleanItemUpdates({ items: [{ itemId: '5', applicabilityStatus: 'not_applicable',
    applicabilityReason: '' }] }), /reason/i);
});

test('completion requires an attended template, teacher/office rows, signatures, and registrar inspection attestation', () => {
  const complete = { scope_status: 'attended', template_id: 1, attested_by: 8, attested_at: new Date(), inspected_on: '2026-10-05',
    teacher_count: 2, registrar_count: 1, guidance_count: 1, finance_count: 1, required_unsigned_count: 0,
    unresolved_count: 0, teacher_context_missing_count: 0 };
  assert.equal(completeFromCounts(complete), true);
  for (const change of [{ teacher_count: 0 }, { guidance_count: 0 }, { required_unsigned_count: 1 },
    { inspected_on: null }, { attested_by: null }, { unresolved_count: 1 }, { teacher_context_missing_count: 1 }]) {
    assert.equal(completeFromCounts({ ...complete, ...change }), false);
  }
});

test('student-facing confirmation status is shown only when every non-attestation requirement is complete', () => {
  const signed = { scope_status: 'attended', template_id: 1, attested_by: null, attested_at: null, inspected_on: '2026-10-05',
    teacher_count: 2, registrar_count: 1, guidance_count: 1, finance_count: 1, required_unsigned_count: 0,
    unresolved_count: 0, teacher_context_missing_count: 0 };
  assert.equal(awaitingRegistrarConfirmation(signed), true);
  for (const change of [{ template_id: null }, { inspected_on: null }, { teacher_count: 0 }, { registrar_count: 0 },
    { guidance_count: 0 }, { finance_count: 0 }, { required_unsigned_count: 1 }, { unresolved_count: 1 },
    { teacher_context_missing_count: 1 }]) {
    assert.equal(awaitingRegistrarConfirmation({ ...signed, ...change }), false, JSON.stringify(change));
  }
  assert.equal(awaitingRegistrarConfirmation({ ...signed, attested_by: 9, attested_at: new Date() }), false,
    'an already-confirmed review is not waiting for confirmation');
});

test('historical term comparison allows older templates only for terms before the configured current period', () => {
  const current = { school_year: '2027-2028', term_number: 2 };
  assert.equal(isPastAcademicTerm(current, '2026-2027', 3), true);
  assert.equal(isPastAcademicTerm(current, '2027-2028', 1), true);
  assert.equal(isPastAcademicTerm(current, '2027-2028', 2), false);
  assert.equal(isPastAcademicTerm(current, '2027-2028', 3), false);
});

test('clearance checklist remains full-width and its mobile summary cells override desktop widths', () => {
  const css = fs.readFileSync(require('node:path').resolve(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /\.student-clearance-page \.clearance-requirements-row > td \{ width: 100%;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.student-clearance-page \.clearance-year \.admin-table > tbody > tr > td \{[\s\S]*?width: 100%;[\s\S]*?box-sizing: border-box;/);
  assert.match(css, /\.student-clearance-page \.clearance-next-step \{[\s\S]*?border-top: 1px solid var\(--line\);/);
  assert.match(css, /\.student-clearance-page \.clearance-details > summary[\s\S]*?display: list-item;[\s\S]*?min-height: 2\.75rem;/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.student-clearance-page \.clearance-next-step \{[^}]*flex-direction: column;/);
});

test('staff history summaries expose changed paper fields without exposing raw JSON', () => {
  const summary = clearanceEventSummary({ before_json: JSON.stringify({ version: 1, scopeStatus: 'attended', attestedBy: 8,
    attestedAt: '2026-10-01', inspectedOn: '2026-10-01', items: [{ id: 4, category: 'teacher', label: 'Teacher signature',
      subjectCode: 'ENG', subjectName: 'English', signaturePresent: true, signerName: 'Old Name', paperSignedOn: '2026-09-20',
      applicabilityStatus: 'required' }] }), after_json: JSON.stringify({ version: 2, scopeStatus: 'attended', attested: false,
    inspectedOn: null, items: [{ id: 4, category: 'teacher', label: 'Teacher signature', subjectCode: 'ENG', subjectName: 'English',
      signaturePresent: true, signerName: 'Corrected Name', paperSignedOn: '2026-09-21', applicabilityStatus: 'required' }] }) });
  assert.ok(summary.some((line) => line.includes('Old Name') && line.includes('Corrected Name')));
  assert.ok(summary.some((line) => line.includes('2026-09-21')));
  assert.ok(summary.some((line) => line.includes('attestation removed')));
  assert.doesNotMatch(summary.join(' '), /before_json|after_json|signerContextReason/);
});

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('front desk and database administrators cannot write staff paper-clearance history', async () => {
  let writes = 0;
  const router = createStudentRecordsRouter({
    studentRecordsService: {}, academicRecordsService: {}, documentRequestService: {}, documentClearanceService: {},
    gradeOverviewService: {}, readmissionService: {},
    termClearanceService: { async createTermClearance() { writes += 1; } }
  });
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').resolve(__dirname, '../views'));
  app.use(express.urlencoded({ extended: false }));
  app.use('/records', (req, _res, next) => {
    req.authUser = { id: req.headers['x-user-id'] || '17', role: req.headers['x-user-role'] || 'front_desk' };
    req.session = {};
    next();
  }, requireRole('registrar', 'database_admin'), router);
  await withServer(app, async (url) => {
    for (const role of ['front_desk', 'database_admin']) {
      const response = await fetch(`${url}/records/students/1/clearance/terms/10`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-user-role': role }, body: 'scopeStatus=attended' });
      assert.equal(response.status, 403);
    }
    assert.equal(writes, 0);
  });
});

test('clearance tab renders the full checklist for registrars and read-only history for database administrators', async () => {
  const calls = [];
  const saved = {
    clearance_id: 77, version: 2, state: 'incomplete', scope_status: 'attended', scope_reason: '',
    enrollment_id: 10, school_year: '2025-2026', grade_level: 'Grade 11', term_label: 'Second', annual_term_number: 2,
    section_name: 'STEM A', clearanceItems: [
      { id: 1, category: 'teacher', label_snapshot: 'Teacher signature', subject_code_snapshot: 'ENG11',
        subject_name_snapshot: 'Oral Communication', teacher_context_status: 'assigned', teacher_name_snapshot: 'Pat Cruz',
        applicability_status: 'required', signature_present: 0, signer_name: '', paper_signed_on: null },
      { id: 2, category: 'registrar', label_snapshot: 'Registrar', applicability_status: 'required', signature_present: 0 }
    ],
    teacherCount: 1, track_label_snapshot: 'Academic Track', template_version: 1,
    template_id: 3, attested_at: null, inspected_on: '2026-09-20', history: []
  };
  const clearance = { async getStudentClearance(actorId, studentId) {
    calls.push([actorId, studentId]);
    return { student: { id: Number(studentId), student_no: 'ST-17', first_name: 'Ari', last_name: 'Santos', status: 'active' },
      terms: [{ ...saved, clearanceItems: saved.clearanceItems, history: [] }, {
        clearance_id: 78, version: 3, state: 'not_attended', scope_status: 'not_attended', scope_reason: 'School records show no attendance.',
        enrollment_id: 11, school_year: '2025-2026', grade_level: 'Grade 11', term_label: 'Third', annual_term_number: 3,
        section_name: 'STEM A', clearanceItems: [{ id: 4, category: 'teacher', label_snapshot: 'Teacher signature',
          subject_code_snapshot: 'ENG11', subject_name_snapshot: 'Oral Communication', teacher_context_status: 'assigned',
          applicability_status: 'required', signature_present: 0, signer_name: '' }],
        track_label_snapshot: 'Academic Track', template_version: 1, template_id: 3, attested_at: null, inspected_on: null, history: []
      }], templates: [] };
  } };
  const router = createStudentRecordsRouter({
    studentRecordsService: {}, academicRecordsService: {}, documentRequestService: {}, documentClearanceService: {},
    gradeOverviewService: {}, readmissionService: {}, termClearanceService: clearance
  });
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').resolve(__dirname, '../views'));
  app.use('/records', (req, _res, next) => {
    req.authUser = { id: req.headers['x-user-id'] || '17', role: req.headers['x-user-role'] || 'registrar' };
    req.session = {};
    next();
  }, requireRole('registrar', 'database_admin'), router);
  await withServer(app, async (url) => {
    const registrar = await fetch(`${url}/records/students/42/clearance`, { headers: { 'x-user-role': 'registrar' } });
    const registrarHtml = await registrar.text();
    assert.equal(registrar.status, 200);
    assert.match(registrarHtml, /Ari Santos/);
    assert.match(registrarHtml, /Student no\. ST-17/);
    assert.match(registrarHtml, /Record paper signatures/);
    assert.match(registrarHtml, /Oral Communication/);
    assert.match(registrarHtml, /Confirm inspected paper form/);
    assert.match(registrarHtml, /Save progress/);
    assert.match(registrarHtml, /Change attendance or correct saved details/);
    assert.match(registrarHtml, /data-label="Paper requirements" colspan="3"/);
    const notAttendedForm = /<form class="admin-form clearance-edit-form"[^>]*records\/78[\s\S]*?<\/form>/.exec(registrarHtml)?.[0] || '';
    assert.match(notAttendedForm, /Save attendance decision/);
    assert.doesNotMatch(notAttendedForm, /Confirm inspected paper form/,
      'a not-attended record cannot show an inspection-confirmation action even if old template rows remain');
    const admin = await fetch(`${url}/records/students/42/clearance`, { headers: { 'x-user-role': 'database_admin', 'x-user-id': '18' } });
    const adminHtml = await admin.text();
    assert.equal(admin.status, 200);
    assert.match(adminHtml, /Read-only clearance details/);
    assert.doesNotMatch(adminHtml, /Save progress|Confirm inspected paper form/);
    assert.deepEqual(calls, [['17', 42], ['18', 42]]);
  });
});

test('empty template setup has a direct registrar action and remains read-only for database administrators', async () => {
  const clearance = {
    async getStudentClearance(_actorId, studentId) {
      return { student: { id: Number(studentId), student_no: 'ST-42', first_name: 'Mia', last_name: 'Reyes' },
        terms: [{ enrollment_id: 10, school_year: '2026-2027', grade_level: 'Grade 11', term_label: 'First Term',
          annual_term_number: 1, section_name: 'STEM A', state: 'not_reviewed', scope_status: 'unreviewed', clearanceItems: [] }],
        templates: [] };
    },
    async listTemplates() { return { templates: [] }; }
  };
  const router = createStudentRecordsRouter({ studentRecordsService: {}, academicRecordsService: {}, documentRequestService: {},
    documentClearanceService: {}, gradeOverviewService: {}, readmissionService: {}, termClearanceService: clearance });
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').resolve(__dirname, '../views'));
  app.use('/records', (req, _res, next) => {
    req.authUser = { id: req.headers['x-user-id'] || '17', role: req.headers['x-user-role'] || 'registrar' };
    req.session = {};
    next();
  }, requireRole('registrar', 'database_admin'), router);
  await withServer(app, async (url) => {
    const registrar = await fetch(`${url}/records/students/42/clearance`);
    const clearanceHtml = await registrar.text();
    assert.equal(registrar.status, 200);
    assert.match(clearanceHtml, /Mia Reyes/);
    assert.match(clearanceHtml, /ST-42/);
    assert.match(clearanceHtml, /Set up paper forms/);
    assert.match(clearanceHtml, /A registrar can still record “Did not attend”/);
    assert.match(clearanceHtml, /Set up a paper form/);

    const setup = await fetch(`${url}/records/clearance/templates`);
    const setupHtml = await setup.text();
    assert.equal(setup.status, 200);
    assert.match(setupHtml, /No paper form versions are set up yet/);
    assert.match(setupHtml, /Set up the first paper form/);

    const admin = await fetch(`${url}/records/clearance/templates`, { headers: { 'x-user-role': 'database_admin' } });
    const adminHtml = await admin.text();
    assert.equal(admin.status, 200);
    assert.match(adminHtml, /Ask the registrar to set up the matching paper form/);
    assert.doesNotMatch(adminHtml, /action="\/registrar\/records\/clearance\/templates"/);
  });
});

test('annual activation review distinguishes pending confirmation from missing paper review and annual views compile', async () => {
  const viewPath = require('node:path').resolve(__dirname, '../views/records/annual-term-activation-review.ejs');
  const review = { targetTermLabel: 'Second Term', targetTermNumber: 2, studentName: 'Ari Santos', studentNo: 'ST-17',
    schoolYear: '2026-2027', gradeLevel: 'Grade 11', sectionName: 'STEM A', studentId: 42, enrollmentId: 91,
    terms: [{ termLabel: 'First Term', state: 'incomplete', awaitingConfirmation: true, requiredCount: 3, signedCount: 3 }],
    blockers: ['First Term: registrar confirmation remains.'], ready: false, alreadyFinalized: false };
  const html = await ejs.renderFile(viewPath, { title: 'Activation review', error: null, review,
    csrfToken: 'csrf', idempotencyKey: '11111111-1111-4111-8111-111111111111' });
  assert.match(html, /Ari Santos/);
  assert.match(html, /Waiting for registrar confirmation/);
  assert.match(html, /Required signatures/);

  const unresolved = await ejs.renderFile(viewPath, { title: 'Activation review', error: null,
    review: { ...review, terms: [{ ...review.terms[0], awaitingConfirmation: false }] }, csrfToken: 'csrf', idempotencyKey: 'token' });
  assert.match(unresolved, /Signatures or review incomplete/);
  assert.doesNotMatch(unresolved, /Waiting for registrar confirmation/);

  for (const path of ['annual-intake-review.ejs', 'annual-term-activation-review.ejs']) {
    const filename = require('node:path').resolve(__dirname, `../views/records/${path}`);
    assert.doesNotThrow(() => ejs.compile(fs.readFileSync(filename, 'utf8'), { filename }));
  }
});

test('template form recovery bounds displayed drafts and refreshes idempotency tokens after conflicts', async () => {
  const csrfToken = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  const submittedToken = '88888888-8888-4888-8888-888888888888';
  const rawTrackLabel = 'T'.repeat(81);
  let failureStatus = 400;
  let receivedTrackLabel = null;
  const clearance = {
    async listTemplates() { return { templates: [] }; },
    async createTemplateVersion(_actorId, input) {
      receivedTrackLabel = input.trackLabel;
      throw new TermClearanceError('Complete the highlighted paper form fields.', failureStatus);
    }
  };
  const router = createStudentRecordsRouter({ studentRecordsService: {}, academicRecordsService: {}, documentRequestService: {},
    documentClearanceService: {}, gradeOverviewService: {}, readmissionService: {}, termClearanceService: clearance });
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').resolve(__dirname, '../views'));
  app.use(express.urlencoded({ extended: false }));
  app.use('/records', (req, _res, next) => {
    req.authUser = { id: 17, role: 'registrar' };
    req.session = { csrfToken };
    next();
  }, requireRole('registrar', 'database_admin'), router);
  await withServer(app, async (url) => {
    const body = new URLSearchParams({ _csrf: csrfToken, idempotencyKey: submittedToken, gradeLevel: 'Grade 11',
      trackLabel: rawTrackLabel, registrarLabel: 'Registrar', guidanceLabel: 'Guidance', financeLabel: 'Finance',
      paperFormConfirmed: '1', teacherRosterConfirmed: '1', laboratoryRowsConfirmed: '1' });
    const validationResponse = await fetch(`${url}/records/clearance/templates`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const validationHtml = await validationResponse.text();
    assert.equal(validationResponse.status, 400);
    assert.equal(receivedTrackLabel, rawTrackLabel, 'the service validates untruncated input');
    assert.match(validationHtml, new RegExp(`value="${'T'.repeat(80)}"`));
    assert.doesNotMatch(validationHtml, new RegExp(`value="${'T'.repeat(81)}"`));
    assert.match(validationHtml, new RegExp(`name="idempotencyKey" value="${submittedToken}"`));

    failureStatus = 409;
    const conflictResponse = await fetch(`${url}/records/clearance/templates`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const conflictHtml = await conflictResponse.text();
    assert.equal(conflictResponse.status, 409);
    assert.match(conflictHtml, /This template was not saved/);
    assert.doesNotMatch(conflictHtml, new RegExp(`name="idempotencyKey" value="${submittedToken}"`));
    assert.match(conflictHtml, new RegExp(`name="idempotencyKey" value="[0-9a-f-]{36}"`));
  });
});

test('stale clearance submissions stay separate from current values and validation errors preserve bounded drafts', async () => {
  const submittedToken = '77777777-7777-4777-8777-777777777777';
  const csrfToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const saved = { clearance_id: 77, version: 2, state: 'incomplete', scope_status: 'attended', enrollment_id: 10,
    school_year: '2025-2026', grade_level: 'Grade 11', term_label: 'Second', annual_term_number: 2, section_name: 'STEM A',
    clearanceItems: [{ id: 1, category: 'teacher', label_snapshot: 'Teacher signature', subject_code_snapshot: 'ENG11',
      subject_name_snapshot: 'Oral Communication', teacher_context_status: 'assigned', applicability_status: 'required',
      signature_present: 1, signer_name: 'Saved signer', paper_signed_on: null }],
    track_label_snapshot: 'Academic Track', template_version: 1, template_id: 3, attested_at: null,
    inspected_on: null, history: [] };
  let failureStatus = 400;
  const clearance = {
    async getStudentClearance(_actorId, studentId) {
      return { student: { id: Number(studentId), student_no: 'ST-17', first_name: 'Ari', last_name: 'Santos' },
        terms: [{ ...saved, clearanceItems: saved.clearanceItems }], templates: [] };
    },
    async updateTermClearance() { throw new TermClearanceError('Correct the highlighted paper details.', failureStatus); }
  };
  const router = createStudentRecordsRouter({ studentRecordsService: {}, academicRecordsService: {}, documentRequestService: {},
    documentClearanceService: {}, gradeOverviewService: {}, readmissionService: {}, termClearanceService: clearance });
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').resolve(__dirname, '../views'));
  app.use(express.urlencoded({ extended: false }));
  app.use('/records', (req, _res, next) => {
    req.authUser = { id: 17, role: 'registrar' };
    req.session = { csrfToken };
    next();
  }, requireRole('registrar', 'database_admin'), router);
  await withServer(app, async (url) => {
    const body = new URLSearchParams({ _csrf: csrfToken, idempotencyKey: submittedToken, expectedVersion: '2',
      scopeStatus: 'attended', item_1_applicabilityStatus: 'required', item_1_signaturePresent: '1',
      item_1_signerName: 'Draft signer', item_1_paperSignedOn: '', clearanceAction: 'progress' });
    const response = await fetch(`${url}/records/students/42/clearance/records/77`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const validationHtml = await response.text();
    assert.equal(response.status, 400);
    assert.match(validationHtml, /value="Draft signer"/);
    assert.match(validationHtml, new RegExp(`name="idempotencyKey" value="${submittedToken}"`));

    failureStatus = 409;
    const staleResponse = await fetch(`${url}/records/students/42/clearance/records/77`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const staleHtml = await staleResponse.text();
    assert.equal(staleResponse.status, 409);
    assert.match(staleHtml, /Your changes were not saved because this form was out of date/);
    assert.match(staleHtml, /Unapplied changes \(not saved\)/);
    assert.match(staleHtml, /Draft signer/);
    assert.match(staleHtml, /value="Saved signer"/);
    assert.doesNotMatch(staleHtml, new RegExp(`name="idempotencyKey" value="${submittedToken}"`));
  });
});

test('student paper-clearance progress uses only the authenticated linked account', async () => {
  const calls = [];
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').resolve(__dirname, '../views'));
  app.use((req, _res, next) => { req.authUser = { id: 27, role: 'student' }; next(); });
  app.use('/student', createStudentPortalRouter({
    studentRecordsService: { async getOwnStudentRecord(userId) {
      calls.push(['record', userId]); return { student: { first_name: 'Ari', last_name: 'Santos', student_no: 'STU-1', status: 'active' }, enrollments: [] };
    } },
    academicRecordsService: {}, financeService: {}, annualFinanceService: {}, classScheduleService: {},
    termClearanceService: { async getOwnStudentProgress(userId) { calls.push(['clearance', userId]); return { terms: [
      { schoolYear: '2025-2026', gradeLevel: 'Grade 11', term: 'First Term', status: 'incomplete',
        requirementCount: 4, signedCount: 4, awaitingConfirmation: true, signerName: 'Private staff value', reason: 'Private note' },
      { schoolYear: '2025-2026', gradeLevel: 'Grade 11', term: 'Second Term', status: 'incomplete',
        requirementCount: 4, signedCount: 4, awaitingConfirmation: false }
    ] }; } }
  }));
  await withServer(app, async (url) => {
    const response = await fetch(`${url}/student/records?studentId=999`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Paper clearance progress/);
    assert.match(html, /All recorded signatures are present · waiting for registrar confirmation/);
    assert.match(html, /4 of 4 required signatures recorded · registrar review pending/);
    assert.doesNotMatch(html, /Private staff value|Private note/);
    assert.deepEqual(calls, [['record', 27], ['clearance', 27]]);
  });
});
