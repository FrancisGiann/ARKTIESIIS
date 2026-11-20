'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { once } = require('node:events');
const { formatMoney } = require('../src/utils/formatMoney');
const { createFinanceRouter } = require('../src/routes/finance');
const { AnnualFinanceError } = require('../src/services/annualFinanceService');
const { AnnualEnrollmentError } = require('../src/services/annualEnrollmentService');

const ROOT = path.resolve(__dirname, '..');
const csrfToken = 'c'.repeat(64);

function sheetFixture(pending = true) {
  return {
    activation_id: 901, reference: 'ENR-901', annual_enrollment_id: 23, student_id: 22, user_id: 55,
    first_name: 'Synthetic', middle_name: null, last_name: 'Learner', suffix: null, student_no: 'SYNTH-22',
    lrn: '000000000022', birth_date: '2010-05-14', sex: 'Female', address: 'Lucena City', phone: '09990000000',
    email: 'learner@example.invalid', school_year: '2027-2028', grade_level: 'Grade 11', voucher_code: 'ESC',
    intake_kind: 'new', entry_term_number: 1, entry_term: 'First Semester', section_name: '11-A',
    enrollment_date: '2026-11-20', first_login_pending: pending,
    placements: [{ annual_term_number: 1, term: 'First Semester', section_name: '11-A', enrollment_status: 'enrolled', term_scope_status: 'in_scope' }],
    assessment: {
      assessmentId: 800, scheduleVersion: 3, voucherCode: 'ESC', total: '100.00', grossTotal: '120.00', coverageTotal: '20.00',
      lines: [{ termNumber: 1, lineName: 'Tuition', category: 'tuition', installment: 'DP', grossAmount: '120.00', waivedAmount: '20.00', amount: '100.00', isOptional: false }],
      termTotals: [{ termNumber: 1, amount: '100.00' }], tuitionTermTotals: [{ termNumber: 1, amount: '100.00' }],
      nonTuitionTermTotals: []
    }
  };
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test('Finance prints an exact private enrollment sheet and issues the first-login password once by CSRF POST', async () => {
  let pending = true;
  const sequence = [];
  const financeReads = [];
  const issueCalls = [];
  const annualFinanceService = {
    async getEntryEnrollmentPrintSheet(actorId, studentId, annualId) {
      financeReads.push({ actorId, studentId, annualId });
      sequence.push('print-preflight');
      if (annualId === 24) throw new AnnualFinanceError('The enrollment sheet is unavailable.', 404);
      return { ...sheetFixture(pending), student_id: studentId === 999 ? 22 : studentId };
    }
  };
  const annualEnrollmentService = {
    async issueFirstLoginPasswordForFinance(actorId, annualId, studentId) {
      issueCalls.push({ actorId, annualId, studentId });
      sequence.push('issue-password');
      if (!pending) throw new AnnualEnrollmentError('A first-login password is available only while the enrolled student login is pending.', 409);
      pending = false;
      return { annualEnrollmentId: annualId, studentId, studentNo: 'SYNTH-22', firstName: 'Synthetic', lastName: 'Learner',
        email: 'learner@example.invalid', temporaryPassword: 'OneTime-QA-Password-77' };
    }
  };
  const app = express();
  app.set('views', path.join(ROOT, 'views'));
  app.set('view engine', 'ejs');
  app.locals.formatMoney = formatMoney;
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.authUser = { id: 7, role: req.get('x-test-role') || 'finance', email: 'finance@example.invalid' };
    req.session = { csrfToken };
    next();
  });
  app.use('/finance', (req, res, next) => {
    if (req.authUser.role !== 'finance') return res.status(403).render('error', { title: 'Forbidden', message: 'Finance access is required.' });
    next();
  }, createFinanceRouter({ annualFinanceService, annualEnrollmentService }));

  await withServer(app, async (baseUrl) => {
    const sheetUrl = `${baseUrl}/finance/students/22/annual/23/enrollment-sheet`;
    const page = await fetch(sheetUrl);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get('cache-control'), /private, no-store/);
    assert.match(html, /<h1>Enrollment Sheet<\/h1>/);
    assert.match(html, /ENR-901/);
    assert.match(html, /SYNTH-22/);
    assert.match(html, /2027-2028/);
    assert.match(html, /Tuition/);
    assert.match(html, /Approved coverage/);
    assert.match(html, /₱20\.00/);
    assert.match(html, /Blank Registrar stamp area/);
    assert.match(html, /min-height: 2\.2in|enrollment-sheet-stamp/);
    assert.match(html, /enrollment-sheet-assessment-panel/);
    assert.match(html, /enrollment-sheet-login-note/);
    assert.match(html, /action="\/finance\/students\/22\/annual\/23\/first-login-password"/);
    assert.doesNotMatch(html, /OneTime-QA-Password-77/);
    assert.doesNotMatch(html, /Payment history|Private Finance note/);

    const forbidden = await fetch(`${baseUrl}/finance/students/22/annual/23/enrollment-sheet`, {
      headers: { 'x-test-role': 'registrar' }
    });
    assert.equal(forbidden.status, 403);

    const denied = await fetch(`${baseUrl}/finance/students/22/annual/23/first-login-password`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_csrf=wrong'
    });
    assert.equal(denied.status, 403);
    assert.equal(issueCalls.length, 0, 'missing or invalid CSRF never consumes the one-time credential');

    const invalidPrintData = await fetch(`${baseUrl}/finance/students/22/annual/24/first-login-password`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrfToken })
    });
    assert.equal(invalidPrintData.status, 404);
    assert.equal(issueCalls.length, 0, 'a known print-data failure is returned before password issuance');

    const issued = await fetch(`${baseUrl}/finance/students/22/annual/23/first-login-password`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrfToken })
    });
    const issuedHtml = await issued.text();
    assert.equal(issued.status, 200, issuedHtml);
    assert.equal(issued.headers.get('cache-control'), 'private, no-store');
    assert.equal(issued.headers.get('location'), null, 'the credential response does not redirect or place the secret in a URL');
    assert.match(issuedHtml, /OneTime-QA-Password-77/);
    assert.match(issuedHtml, /learner@example\.invalid/);
    assert.match(issuedHtml, /must complete the existing email sign-in verification and change this password/);
    assert.match(issuedHtml, /Blank Registrar stamp area/);
    assert.match(issuedHtml, /enrollment-sheet-credential/);
    assert.deepEqual(sequence.slice(-2), ['print-preflight', 'issue-password'], 'print data validates before the locked credential issue');

    const reprint = await fetch(sheetUrl);
    const reprintHtml = await reprint.text();
    assert.equal(reprint.status, 200);
    assert.doesNotMatch(reprintHtml, /first-login-password"/);
    assert.match(reprintHtml, /learner@example\.invalid/);
    assert.match(reprintHtml, /password reset page/);
    assert.match(reprintHtml, /href="\/password\/forgot"/);
    assert.doesNotMatch(reprintHtml, /OneTime-QA-Password-77/);

    const replay = await fetch(`${baseUrl}/finance/students/22/annual/23/first-login-password`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrfToken })
    });
    assert.equal(replay.status, 409, 'the issue service rejects a second password for this activated record');
    assert.equal(issueCalls.length, 2);

    const wrongOwner = await fetch(`${baseUrl}/finance/students/999/annual/23/enrollment-sheet`);
    assert.equal(wrongOwner.status, 404, 'a sheet is never rendered for a mismatched student and annual record');
  });

  assert.deepEqual(financeReads[0], { actorId: 7, studentId: 22, annualId: 23 });
  assert.deepEqual(issueCalls, [
    { actorId: 7, annualId: 23, studentId: 22 },
    { actorId: 7, annualId: 23, studentId: 22 }
  ]);
});
