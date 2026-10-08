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
  completeFromCounts, awaitingRegistrarConfirmation, clearanceEventSummary, isPastAcademicTerm,
  normalizeClearanceDashboardFilters, resolveCurrentAcademicPosition
} = require('../src/services/termClearanceService');
const { createStudentRecordsRouter } = require('../src/routes/studentRecords');
const { createStudentPortalRouter } = require('../src/routes/studentPortal');

const checkedTemplate = { gradeLevel: 'Grade 11', trackLabel: 'Academic Track',
  officeConfirmations: ['registrar', 'guidance', 'finance'], teacherRosterConfirmed: '1',
  laboratoryRowsConfirmed: '1' };

test('template input allows explicitly approved no-laboratory paper forms and ignores blank form fields', () => {
  const clean = cleanTemplateInput({ ...checkedTemplate, laboratoryLabels: ['', '  '] });
  assert.deepEqual(clean.laboratoryLabels, []);
  assert.throws(() => cleanTemplateInput({ ...checkedTemplate, laboratoryRowsConfirmed: '' }), TermClearanceError);
  assert.deepEqual(cleanTemplateInput({ ...checkedTemplate, laboratoryLabels: ['Chemistry Lab'] }).laboratoryLabels,
    ['Chemistry Lab']);
  assert.deepEqual([clean.registrarLabel, clean.guidanceLabel, clean.financeLabel], ['Registrar', 'Guidance', 'Finance']);
  assert.equal(Object.hasOwn(clean, 'officeConfirmations'), false,
    'paper-form evidence validates the required office rows without changing canonical saved template values');
  assert.deepEqual(cleanTemplateInput({ ...checkedTemplate, officeConfirmations: ['finance', 'registrar', 'guidance'],
    registrarLabel: 'Forged label' }), clean, 'equivalent office confirmations keep the same canonical template values');
  assert.throws(() => cleanTemplateInput({ ...checkedTemplate, officeConfirmations: ['registrar', 'finance'] }), /Registrar, Guidance, and Finance/i);
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
  assert.equal(undecidedLaboratory.applicabilityStatus, 'unreviewed', 'an unresolved lab row remains not completed until completed paper is recorded');
  assert.throws(() => cleanItemUpdates({ items: [{ itemId: '6', applicabilityStatus: 'unreviewed', signaturePresent: '1', signerName: 'Lab signer' }] }), /laboratory line is required on the form/i);
  assert.throws(() => cleanItemUpdates({ items: [{ itemId: '5', applicabilityStatus: 'not_applicable',
    applicabilityReason: '' }] }), /reason/i);
});

test('completion requires an attended template, teacher/office rows, signatures, and registrar inspection attestation', () => {
  const complete = { scope_status: 'attended', template_id: 1, attested_by: 8, attested_at: new Date(), inspected_on: '2026-10-05',
    teacher_count: 2, registrar_count: 1, guidance_count: 1, finance_count: 1, required_unsigned_count: 0,
    unresolved_count: 0, teacher_context_missing_count: 0 };
  assert.equal(completeFromCounts(complete), true);
  assert.equal(completeFromCounts({ ...complete, clearance_complete: 1 }), true,
    'the SQL projection does not replace the evidence predicate');
  for (const change of [{ teacher_count: 0 }, { guidance_count: 0 }, { required_unsigned_count: 1 },
    { inspected_on: null }, { attested_by: null }, { unresolved_count: 1 }, { teacher_context_missing_count: 1 },
    { clearance_complete: 1, teacher_context_missing_count: 1 }]) {
    assert.equal(completeFromCounts({ ...complete, ...change }), false);
  }
});

test('clearance dashboard filters preserve an explicit all-terms scope and reject malformed values', () => {
  assert.equal(normalizeClearanceDashboardFilters({}).scopeSpecified, false);
  const allTerms = normalizeClearanceDashboardFilters({ search: '', schoolYear: '', termId: '', status: 'all' });
  assert.equal(allTerms.scopeSpecified, true);
  assert.equal(allTerms.termId, null);
  assert.equal(allTerms.schoolYear, null);
  assert.equal(normalizeClearanceDashboardFilters({ status: 'incomplete' }).status, 'pending', 'legacy links map to the Not completed filter');
  assert.equal(normalizeClearanceDashboardFilters({ status: 'not_reviewed' }).status, 'pending', 'legacy unreviewed links map to the Not completed filter');
  assert.throws(() => normalizeClearanceDashboardFilters({ termId: ['1'] }), /academic term/i);
  assert.throws(() => normalizeClearanceDashboardFilters({ schoolYear: '2026/2027' }), /school year/i);
  assert.throws(() => normalizeClearanceDashboardFilters({ status: 'unreviewed' }), /clearance status/i);
  assert.throws(() => normalizeClearanceDashboardFilters({ page: '0' }), /page/i);
  assert.throws(() => normalizeClearanceDashboardFilters({ search: 'x'.repeat(101) }), /100 printable/i);
});

test('current academic period resolution fails closed unless exactly one mapped current term exists', () => {
  const current = { id: 7, school_year: '2026-2027', term_number: 1 };
  assert.deepEqual(resolveCurrentAcademicPosition([current]),
    { academic_term_id: 7, school_year: '2026-2027', term_number: 1 });
  assert.equal(resolveCurrentAcademicPosition([]), null);
  assert.equal(resolveCurrentAcademicPosition([current, { id: 8, school_year: '2098-2099', term_number: null }]), null,
    'an unmapped second current row cannot be filtered away before the uniqueness check');
  assert.equal(resolveCurrentAcademicPosition([{ id: 8, school_year: '2098/2099', term_number: 1 }]), null);
  assert.equal(resolveCurrentAcademicPosition([{ id: 8, school_year: '2026-2027', term_number: 4 }]), null);
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

test('clearance checklist uses year groups and hash-addressable term summaries', () => {
  const template = fs.readFileSync(require('node:path').resolve(__dirname, '../views/records/student-clearance.ejs'), 'utf8');
  assert.match(template, /<section class="clearance-year"/);
  assert.match(template, /<details id="clearance-term-<%= term\.enrollment_id %>" class="clearance-term/);
  assert.match(template, /<summary class="clearance-term-summary">/);
  assert.doesNotMatch(template, /class="clearance-term-table|clearance-requirements-row/);
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
  assert.ok(summary.some((line) => line.includes('confirmation removed')));
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

test('clearance overview route keeps explicit scope, paginates all terms, and enforces staff read roles', async () => {
  const calls = [];
  const router = createStudentRecordsRouter({
    studentRecordsService: {}, academicRecordsService: {}, documentRequestService: {}, documentClearanceService: {},
    gradeOverviewService: {}, readmissionService: {},
    termClearanceService: { async getClearanceDashboard(actorId, filters) {
      calls.push({ actorId, filters: { ...filters } });
      const page = Number(filters.page || 1);
      const usesDefaultTerm = !Object.hasOwn(filters, 'schoolYear') && !Object.hasOwn(filters, 'termId');
      const allTermRows = [
        { student_id: 17, enrollment_id: 44, first_name: 'Ari', last_name: 'Santos', student_no: 'ST-17',
          school_year: '2026-2027', term_label: 'First Term', grade_level: 'Grade 11', section_name: 'STEM A', clearance_state: 'incomplete' },
        { student_id: 19, enrollment_id: 49, first_name: 'Alexandra Very Long Student Name for Mobile Review', middle_name: 'Rae', last_name: 'Reyes', student_no: 'SHS-2025-0599',
          school_year: '2025-2026', term_label: 'Second Term', grade_level: 'Grade 12', section_name: 'HUMSS & Social Sciences', clearance_state: 'complete' }
      ];
      const noMatches = filters.search === 'No matching student';
      const includeAllTermRows = !filters.search && filters.schoolYear === '' && filters.termId === '';
      return {
        rows: noMatches ? [] : includeAllTermRows ? allTermRows : [allTermRows[0]],
        terms: [{ id: 4, school_year: '2026-2027', term: 'First Term' }], schoolYears: ['2026-2027'],
        currentTerm: usesDefaultTerm ? { id: 4, school_year: '2026-2027', term: 'First Term' } : null,
        usesDefaultTerm, needsTermSelection: false,
        filters: { search: filters.search || '', schoolYear: usesDefaultTerm ? '2026-2027' : filters.schoolYear || '', termId: usesDefaultTerm ? '4' : filters.termId || '',
          status: filters.status || 'all', page },
        counts: { totalRecords: 27, completed: 4, pending: 21, incomplete: 3, notReviewed: 18, notAttended: 1, notApplicable: 1 },
        countsIgnoreStatusFilter: filters.status === 'pending',
        pagination: { page, pageSize: 25, totalRecords: noMatches ? 0 : 27, matchedRecords: noMatches ? 0 : 27, totalPages: noMatches ? 1 : 2,
          from: noMatches ? 0 : page === 1 ? 1 : 26, to: noMatches ? 0 : page === 1 ? 25 : 27 }
      };
    } }
  });
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').resolve(__dirname, '../views'));
  app.use('/registrar/records', (req, _res, next) => {
    req.authUser = { id: req.headers['x-user-id'] || '17', role: req.headers['x-user-role'] || 'registrar' };
    req.session = {};
    next();
  }, requireRole('registrar', 'database_admin'), router);
  await withServer(app, async (url) => {
    const response = await fetch(`${url}/registrar/records/clearance?search=Ari&schoolYear=&termId=&status=all&page=2`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(html, /Clearance/);
    assert.match(html, /Status meanings and other filters/);
    assert.match(html, /Counts cover student-term records, not unique students/);
    assert.match(html, /status filters only narrow the list/);
    assert.match(html, /Filter to not completed: 21 term entries/);
    assert.match(html, /<strong>Not completed:<\/strong> The registrar has not confirmed a completed paper form/);
    assert.doesNotMatch(html, /<strong>Pending:<\/strong>/);
    assert.match(html, /<span class="record-status clearance-status clearance-status--pending">Not completed<\/span>/);
    assert.equal(html.split('The registrar has not confirmed a completed paper form.').length - 1, 1,
      'the pending explanation appears once in the shared status help, not on each student row');
    assert.match(html, /<form class="clearance-dashboard-filters" method="get" action="\/registrar\/records\/clearance"/);
    assert.match(html, /<button class="button button--primary clearance-dashboard-search-submit" type="submit">Search<\/button>/);
    assert.match(html, /<summary>More filters<\/summary>/);
    assert.match(html, /<a class="clearance-dashboard-reset" href="\/registrar\/records\/clearance">Reset<\/a>/);
    assert.match(html, /<thead class="clearance-dashboard-table-head"><tr><th scope="col">Student<\/th><th scope="col">School year and term<\/th>/,
      'the responsive list keeps semantic table headings for assistive technology');
    assert.match(html, /class="clearance-dashboard-student" data-label="Student"/);
    assert.match(html, /class="clearance-dashboard-row-action" data-label="Action"/);
    assert.doesNotMatch(html, /Apply filters|Clear filters|clearance-dashboard-filter-actions/);
    assert.match(html, /href="\/registrar\/records\/clearance\?search=Ari&amp;schoolYear=&amp;termId=&amp;status=pending&amp;page=1"/,
      'status links preserve search and explicit All terms while resetting pagination');
    assert.match(html, /href="\/registrar\/records\/clearance\?search=Ari&amp;schoolYear=&amp;termId=&amp;status=all&amp;page=1"/,
      'pagination keeps blank All terms scope keys so the next page cannot reset to the current term');
    const defaultResponse = await fetch(`${url}/registrar/records/clearance`);
    const defaultHtml = await defaultResponse.text();
    const defaultDisclosure = /<details class="clearance-dashboard-filter-more"([^>]*)>/.exec(defaultHtml)?.[1] || '';
    assert.match(defaultDisclosure, /data-default-open="false"/, 'the current period does not request an expanded mobile refinement panel');
    assert.match(defaultDisclosure, /\bopen\b/, 'year and term fields remain visible without JavaScript');
    assert.match(defaultHtml, /href="\/registrar\/records\/clearance\?search=&amp;status=pending&amp;page=1"/,
      'status links retain the implicit configured period without turning it into an explicit filter');
    const followedStatusLink = await fetch(`${url}/registrar/records/clearance?search=&status=pending&page=1`);
    assert.equal(followedStatusLink.status, 200);
    const excludedStatus = await fetch(`${url}/registrar/records/clearance?search=&status=not_attended&page=1`);
    const excludedHtml = await excludedStatus.text();
    assert.equal(excludedStatus.status, 200);
    assert.match(excludedHtml, /<details class="clearance-dashboard-status-meanings"\s*>/,
      'the secondary status help stays collapsed after an exclusion filter is selected');
    assert.match(excludedHtml, /class="clearance-dashboard-active-filter" role="status">Filtered to <strong>Term not attended<\/strong>/,
      'the active exclusion is summarized beside the results');
    assert.match(excludedHtml, /Term not attended/);
    assert.match(excludedHtml, /registrar records the reason/);
    const customPeriod = await fetch(`${url}/registrar/records/clearance?search=&schoolYear=2026-2027&termId=4&status=all`);
    const customPeriodHtml = await customPeriod.text();
    assert.equal(customPeriod.status, 200);
    assert.match(customPeriodHtml, /<option value="2026-2027" selected>2026-2027<\/option>/,
      'the selected school year remains visible in the native GET filter');
    assert.match(customPeriodHtml, /<option value="4" selected>2026-2027 · First Term<\/option>/,
      'the selected term remains visible in the native GET filter');
    assert.match(customPeriodHtml, /data-default-open="false"/,
      'saved custom filters do not force the mobile period controls open');
    const allTerms = await fetch(`${url}/registrar/records/clearance?search=&schoolYear=&termId=&status=all`);
    const allTermsHtml = await allTerms.text();
    assert.equal(allTerms.status, 200);
    assert.match(allTermsHtml, /Alexandra Very Long Student Name for Mobile Review Rae Reyes/);
    assert.match(allTermsHtml, /SHS-2025-0599/);
    assert.match(allTermsHtml, /2025-2026<\/span><span class="clearance-dashboard-separator" aria-hidden="true">·<\/span><strong>Second Term<\/strong>/,
      'all-term rows retain their own school year and term context');
    assert.match(allTermsHtml, /HUMSS &amp; Social Sciences/);
    assert.match(allTermsHtml, /aria-label="Open paper clearance checklist for Alexandra Very Long Student Name for Mobile Review Rae Reyes, 2025-2026 Second Term"/,
      'each open action has a student and term-specific accessible name');
    assert.match(allTermsHtml, /<details class="clearance-dashboard-filter-more" open data-clearance-filter-more data-default-open="false">/,
      'All terms remain selected in the native GET controls while mobile JavaScript can collapse their disclosure');
    const emptyResults = await fetch(`${url}/registrar/records/clearance?search=No%20matching%20student&schoolYear=&termId=&status=all`);
    const emptyResultsHtml = await emptyResults.text();
    assert.equal(emptyResults.status, 200);
    assert.match(emptyResultsHtml, /No term entries match these filters/);
    assert.match(emptyResultsHtml, /name="search" maxlength="100" value="No matching student"/,
      'empty results keep search and filter recovery available');
    const admin = await fetch(`${url}/registrar/records/clearance?search=&schoolYear=&termId=&status=pending&page=2`,
      { headers: { 'x-user-role': 'database_admin', 'x-user-id': '18' } });
    assert.equal(admin.status, 200);
    for (const role of ['front_desk', 'teacher', 'finance', 'student']) {
      const denied = await fetch(`${url}/registrar/records/clearance`, { headers: { 'x-user-role': role } });
      assert.equal(denied.status, 403, `${role} cannot read the staff clearance dashboard`);
    }
    assert.match(await followedStatusLink.text(), /aria-current="true"/,
      'the selected status link exposes the active filter state');
    assert.deepEqual(calls, [
      { actorId: '17', filters: { search: 'Ari', schoolYear: '', termId: '', status: 'all', page: '2' } },
      { actorId: '17', filters: {} },
      { actorId: '17', filters: { search: '', status: 'pending', page: '1' } },
      { actorId: '17', filters: { search: '', status: 'not_attended', page: '1' } },
      { actorId: '17', filters: { search: '', schoolYear: '2026-2027', termId: '4', status: 'all' } },
      { actorId: '17', filters: { search: '', schoolYear: '', termId: '', status: 'all' } },
      { actorId: '17', filters: { search: 'No matching student', schoolYear: '', termId: '', status: 'all' } },
      { actorId: '18', filters: { search: '', schoolYear: '', termId: '', status: 'pending', page: '2' } }
    ]);
  });
});

test('clearance tab records completed paper for registrars and stays read-only for database administrators', async () => {
  const calls = [];
  const saved = {
    clearance_id: 77, version: 2, state: 'incomplete', scope_status: 'attended', scope_reason: '',
    enrollment_id: 10, school_year: '2025-2026', grade_level: 'Grade 11', term_label: 'Second', annual_term_number: 2,
    section_name: 'STEM A', clearanceItems: [
      { id: 1, category: 'teacher', label_snapshot: 'Teacher signature', subject_code_snapshot: 'ENG11',
        subject_name_snapshot: 'Oral Communication', teacher_context_status: 'assigned', teacher_name_snapshot: 'Pat Cruz',
        applicability_status: 'required', signature_present: 0, signer_name: '', paper_signed_on: null },
      { id: 2, category: 'registrar', label_snapshot: 'Registrar', applicability_status: 'required', signature_present: 0 },
      { id: 3, category: 'laboratory', label_snapshot: 'Laboratory', subject_name_snapshot: 'Chemistry Lab',
        applicability_status: 'unreviewed', signature_present: 0, signer_name: '' }
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
    assert.match(registrarHtml, /id="clearance-signatures-heading-77">Paper form signatures/);
    assert.match(registrarHtml, /Enter each required line from the fully signed paper form/);
    assert.match(registrarHtml, /Oral Communication/);
    assert.match(registrarHtml, /Record completed paper/);
    assert.match(registrarHtml, /name="clearanceAction" value="complete"/);
    assert.match(registrarHtml, /name="clearanceAction" value="prepare"/,
      'attendance and matching-form changes remain available in the correction disclosure');
    assert.doesNotMatch(registrarHtml, /Save progress|In progress|Needs review|awaiting registrar confirmation|\b\d+\s+of\s+\d+\s+required signatures/i);
    assert.match(registrarHtml, /Correct attendance or saved details/);
    assert.match(registrarHtml, /Required on this form\?/);
    assert.match(registrarHtml, /value="not_applicable"[^>]*>Not required/);
    assert.match(registrarHtml, /Paper form and review history/);
    assert.match(registrarHtml, /Review version/);
    assert.doesNotMatch(registrarHtml, /No saved change history|Review this paper form/);
    assert.doesNotMatch(registrarHtml, /<details class="clearance-details"/,
      'the current term checklist and signature form are visible directly inside the open term');
    assert.match(registrarHtml, /id="clearance-term-10" class="clearance-term clearance-term--incomplete" open/);
    assert.doesNotMatch(registrarHtml, /clearance-term-table|clearance-requirements-row/);
    assert.match(registrarHtml, /Term not attended:<\/strong> school records show no attendance for the entire term/);
    assert.match(registrarHtml, /Registrar’s reason:<\/strong> School records show no attendance/);
    assert.match(registrarHtml, /<a href="\/registrar\/records\/clearance" aria-current="page">Overview<\/a>/,
      'the active workspace tab renders aria-current as the value page');
    assert.match(registrarHtml, /aria-label="Signature on paper: ENG11 · Oral Communication" aria-describedby="clearance-signature-help-77"/,
      'each checkbox has a contextual accessible name and the shared form instructions');
    assert.match(registrarHtml, /id="clearance-signature-help-77"/);
    assert.doesNotMatch(registrarHtml, /When checked, enter the signer/);
    assert.doesNotMatch(registrarHtml, /data-label="Required signature line"|data-label="Paper record"/);
    const notAttendedForm = /<form class="admin-form clearance-edit-form"[^>]*records\/78[\s\S]*?<\/form>/.exec(registrarHtml)?.[0] || '';
    assert.match(notAttendedForm, /Save attendance decision/);
    assert.doesNotMatch(notAttendedForm, /Mark clearance completed/,
      'a not-attended record cannot show an inspection-confirmation action even if old template rows remain');
    const admin = await fetch(`${url}/records/students/42/clearance`, { headers: { 'x-user-role': 'database_admin', 'x-user-id': '18' } });
    const adminHtml = await admin.text();
    assert.equal(admin.status, 200);
    assert.match(adminHtml, /Read-only clearance details/);
    assert.doesNotMatch(adminHtml, /Record completed paper|name="clearanceAction"|<button[^>]*type="submit"/);
    assert.match(adminHtml, /<fieldset disabled aria-label="Read-only clearance details">/,
      'database administrators can inspect paper signature evidence inside a disabled fieldset');
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
    assert.match(clearanceHtml, /entire term was not attended, with a reason/);
    assert.match(clearanceHtml, /Set up a paper form/);

    const setup = await fetch(`${url}/records/clearance/templates`);
    const setupHtml = await setup.text();
    assert.equal(setup.status, 200);
    assert.match(setupHtml, /No paper forms set up yet/);
    assert.match(setupHtml, /Set up the first paper form/);
    assert.match(setupHtml, /<a href="\/registrar\/records\/clearance\/templates" aria-current="page">Checklist setup<\/a>/,
      'the checklist setup tab renders aria-current as the value page');

    const admin = await fetch(`${url}/records/clearance/templates`, { headers: { 'x-user-role': 'database_admin' } });
    const adminHtml = await admin.text();
    assert.equal(admin.status, 200);
    assert.match(adminHtml, /Ask the registrar to set up the matching paper form/);
    assert.doesNotMatch(adminHtml, /action="\/registrar\/records\/clearance\/templates"/);
  });
});

test('annual activation review uses only Not completed and Completed paper statuses and annual views compile', async () => {
  const viewPath = require('node:path').resolve(__dirname, '../views/records/annual-term-activation-review.ejs');
  const review = { targetTermLabel: 'Second Term', targetTermNumber: 2, studentName: 'Ari Santos', studentNo: 'ST-17',
    schoolYear: '2026-2027', gradeLevel: 'Grade 11', sectionName: 'STEM A', studentId: 42, enrollmentId: 91,
    terms: [{ termLabel: 'First Term', state: 'incomplete', awaitingConfirmation: true, requiredCount: 3, signedCount: 3 }],
    blockers: ['First Term: registrar confirmation remains.'], ready: false, alreadyFinalized: false };
  const html = await ejs.renderFile(viewPath, { title: 'Activation review', error: null, review,
    csrfToken: 'csrf', idempotencyKey: '11111111-1111-4111-8111-111111111111' });
  assert.match(html, /Ari Santos/);
  assert.match(html, /Paper clearance status/);
  assert.match(html, /Not completed/);
  assert.doesNotMatch(html, />Pending</);
  assert.doesNotMatch(html, /In progress|Needs review|Waiting for registrar confirmation|Required signatures/);

  const unresolved = await ejs.renderFile(viewPath, { title: 'Activation review', error: null,
    review: { ...review, terms: [{ ...review.terms[0], awaitingConfirmation: false }] }, csrfToken: 'csrf', idempotencyKey: 'token' });
  assert.match(unresolved, /Not completed/);
  assert.doesNotMatch(unresolved, />Pending</);
  assert.doesNotMatch(unresolved, /Signatures or review incomplete|Waiting for registrar confirmation/);

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
      trackLabel: rawTrackLabel, teacherRosterConfirmed: '1', laboratoryRowsConfirmed: '1' });
    for (const office of ['registrar', 'guidance', 'finance']) body.append('officeConfirmations', office);
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
  const saved = { clearance_id: 77, version: 2, state: 'complete', scope_status: 'attended', enrollment_id: 10,
    school_year: '2025-2026', grade_level: 'Grade 11', term_label: 'Second', annual_term_number: 2, section_name: 'STEM A',
    clearanceItems: [{ id: 1, category: 'teacher', label_snapshot: 'Teacher signature', subject_code_snapshot: 'ENG11',
      subject_name_snapshot: 'Oral Communication', teacher_context_status: 'assigned', applicability_status: 'required',
      signature_present: 1, signer_name: 'Saved signer', paper_signed_on: null },
    { id: 2, category: 'teacher', label_snapshot: 'Teacher signature', subject_code_snapshot: 'SCI11',
      subject_name_snapshot: 'Earth Science', teacher_context_status: 'assigned', applicability_status: 'required',
      signature_present: 1, signer_name: 'Saved teacher', paper_signed_on: null }],
    track_label_snapshot: 'Academic Track', template_version: 1, template_id: 3, attested_at: '2026-09-20T08:00:00Z',
    inspected_on: '2026-09-20', history: [] };
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
      item_1_signerName: 'Draft signer', item_1_paperSignedOn: '',
      item_2_applicabilityStatus: 'required', item_2_signaturePresent: '1', item_2_signerName: '',
      clearanceAction: 'reopen' });
    const response = await fetch(`${url}/records/students/42/clearance/records/77`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const validationHtml = await response.text();
    assert.equal(response.status, 400);
    assert.match(validationHtml, /value="Draft signer"/);
    assert.match(validationHtml, /<details id="clearance-term-10" class="clearance-term clearance-term--complete" open>/,
      'a validation rerender opens the attempted term so its submitted values remain visible');
    assert.match(validationHtml, /<details class="clearance-signer-details" open>\s*<summary>Enter the name beside this signature<\/summary>/,
      'a checked signature with a missing name exposes the required signer fields without JavaScript');
    assert.match(validationHtml, new RegExp(`name="idempotencyKey" value="${submittedToken}"`));

    failureStatus = 409;
    const staleResponse = await fetch(`${url}/records/students/42/clearance/records/77`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const staleHtml = await staleResponse.text();
    assert.equal(staleResponse.status, 409);
    assert.match(staleHtml, /Your changes were not saved because this form was out of date/);
    assert.match(staleHtml, /Unapplied submitted values/);
    assert.match(staleHtml, /Draft signer/);
    assert.match(staleHtml, /value="Saved signer"/);
    assert.doesNotMatch(staleHtml, new RegExp(`name="idempotencyKey" value="${submittedToken}"`));
  });
});

test('student paper-clearance status uses only the authenticated linked account and hides staff evidence', async () => {
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
        requirementCount: 4, signedCount: 4, awaitingConfirmation: false },
      { schoolYear: '2025-2026', gradeLevel: 'Grade 11', term: 'Third Term', status: 'not_attended' },
      { schoolYear: '2025-2026', gradeLevel: 'Grade 11', term: 'Fourth Term', status: 'not_applicable' },
      { schoolYear: '2025-2026', gradeLevel: 'Grade 11', term: 'Fifth Term', status: 'complete' }
    ] }; } }
  }));
  await withServer(app, async (url) => {
    const response = await fetch(`${url}/student/records?studentId=999`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Paper clearance status/);
    assert.equal((html.match(/>Not completed<\/strong>/g) || []).length, 2,
      'legacy unfinished rows with or without complete signature evidence both display as Not completed');
    assert.match(html, />Completed<\/strong>/);
    assert.match(html, /the registrar has not confirmed a completed paper form for this term/);
    assert.match(html, /registrar recorded no attendance for the entire term; excluded from required clearance and not completed/);
    assert.match(html, /Outside required terms/);
    assert.doesNotMatch(html, /Private staff value|Private note|In progress|Needs review|awaiting registrar confirmation|\d+ of \d+ required signatures/);
    assert.deepEqual(calls, [['record', 27], ['clearance', 27]]);
  });
});
