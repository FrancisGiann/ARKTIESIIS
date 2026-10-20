'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');
const { createFinanceReviewActionService } = require('../src/services/financeReviewActionService');
const { FinanceReviewDraftError } = require('../src/services/financeReviewDraftService');
const { RetakeReferralError } = require('../src/services/retakeReferralService');

const environment = {
  nodeEnv: 'development',
  devPasswordOnlyLogin: true,
  sessionSecret: 'retake-referral-http-route-test-session-secret'
};
const password = 'Correct-Horse-Battery-12';
const passwordHash = bcrypt.hashSync(password, 4);

function makeAuthPool(role) {
  const user = {
    id: 7, email: `${role}@example.edu`, password_hash: passwordHash, role,
    is_active: true, updated_at_fingerprint: '', auth_session_version: '', must_change_password: false
  };
  return async () => ({
    request() {
      return {
        input() { return this; },
        async query(statement) {
          if (statement.includes('WHERE email = @email')) return { recordset: [user] };
          if (statement.includes('WHERE id = @userId')) return { recordset: [{ ...user }] };
          throw new Error(`Unexpected auth query: ${statement}`);
        }
      };
    }
  });
}

function cookieFrom(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function signIn(baseUrl, role) {
  const page = await fetch(`${baseUrl}/login`);
  const cookie = cookieFrom(page);
  const token = csrfFrom(await page.text());
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, email: `${role}@example.edu`, password })
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

function noCallService(calls) {
  return new Proxy({}, {
    get(_target, method) {
      return async (...args) => {
        calls.push({ method, args });
        throw new Error(`Service method ${String(method)} should not be called.`);
      };
    }
  });
}

test('retake referral mutation routes require Registrar authorization and valid CSRF before service calls', async () => {
  const calls = [];
  const app = createApp({ databasePool: makeAuthPool('registrar'), environment,
    retakeReferralService: noCallService(calls) });
  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const paths = [
      ['/registrar/retake-referrals', { annualEnrollmentId: '4', evaluationReference: 'review', idempotencyKey: 'token' }],
      ['/registrar/retake-referrals/91/reference', { evaluationReference: 'corrected' }],
      ['/registrar/retake-referrals/91/items', { subjectName: 'Module', targetTerm: '2', financeExplanation: 'Explanation' }],
      ['/registrar/retake-referrals/91/items/31/update', { subjectName: 'Module', targetTerm: '2', financeExplanation: 'Explanation' }],
      ['/registrar/retake-referrals/91/items/31/remove', {}],
      ['/registrar/retake-referrals/91/finalize', {}],
      ['/registrar/retake-referrals/91/corrections', { idempotencyKey: 'token' }]
    ];
    for (const [index, [pathname, fields]] of paths.entries()) {
      const body = index === 0 ? fields : { ...fields, _csrf: 'invalid-session-token' };
      const response = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body)
      });
      assert.equal(response.status, 403, `${pathname} rejects ${index === 0 ? 'missing' : 'invalid'} CSRF`);
    }
  });
  assert.deepEqual(calls, [], 'CSRF checks reject before invoking any referral mutation or read service');
});

test('Finance, student, and front desk roles cannot reach Registrar retake mutations', async () => {
  const calls = [];
  for (const role of ['finance', 'student', 'front_desk']) {
    const app = createApp({ databasePool: makeAuthPool(role), environment, retakeReferralService: noCallService(calls) });
    await withServer(app, async (baseUrl) => {
      const cookie = await signIn(baseUrl, role);
      const response = await fetch(`${baseUrl}/registrar/retake-referrals/91/finalize`, {
        method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: 'not-relevant-without-role', _method: 'POST' })
      });
      assert.equal(response.status, 403, `${role} is denied by the route role boundary`);
    });
  }
  assert.deepEqual(calls, []);
});

test('Registrar item errors re-render submitted subject, term, and multiline explanation', async () => {
  const calls = [];
  const referralService = {
    async addItem(...args) {
      calls.push(['addItem', ...args]);
      throw new RetakeReferralError('Choose a valid subject/module name.', 400);
    },
    async getReferral(_actorId, id) {
      return {
        id: Number(id), revision_no: 1, student_name: 'Synthetic Learner', student_no: 'SYN-101',
        school_year: '2026-2027', grade_level: 'Grade 11', intake_kind: 'transferee',
        evaluation_reference: 'Synthetic registrar file', entry_term_number: 1,
        readmission_evaluation_id: null, annual_evaluation_id: null, current_evaluation_version: null,
        annual_evaluation_version: null, evaluation_status: null, status: 'draft', is_current: 1,
        finalized_at: null, items: [], events: []
      };
    },
    async listReferralHistory() { return []; },
    async listTargetSubjects() { return []; },
    async listTargetTerms() { return [1, 3]; }
  };
  const app = createApp({ databasePool: makeAuthPool('registrar'), environment, retakeReferralService: referralService });
  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'registrar');
    const detail = await fetch(`${baseUrl}/registrar/retake-referrals/91`, { headers: { cookie } });
    const detailHtml = await detail.text();
    assert.equal(detail.status, 200);
    const response = await fetch(`${baseUrl}/registrar/retake-referrals/91/items`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf: csrfFrom(detailHtml), itemKeyToken: 'not-used-after-controlled-error',
        subjectName: '  Synthetic extended retake module  ', subjectId: '', targetTerm: '3',
        financeExplanation: 'Reviewed transfer mapping.\nPlacement needs a Term 3 Finance decision.'
      })
    });
    const html = await response.text();
    assert.equal(response.status, 400);
    assert.match(html, /Choose a valid subject\/module name\./);
    assert.match(html, /name="subjectName" value="  Synthetic extended retake module  "/);
    assert.match(html, /<option value="3" selected>Term 3<\/option>/);
    assert.match(html, /Reviewed transfer mapping\.\nPlacement needs a Term 3 Finance decision\./);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'addItem');
});

test('Finance retake decision route rejects missing CSRF before the reviewed writer', async () => {
  const registry = createFinanceReviewActionService({ getPool: async () => { throw new Error('writer probe must not read the database'); } });
  const starts = [];
  const financeReviewActionService = {
    matchesMutation: registry.matchesMutation,
    isReadOnlyPost: registry.isReadOnlyPost,
    actionLabel: registry.actionLabel,
    afterCommitPath: registry.afterCommitPath,
    async startDraft(...args) { starts.push(args); return { id: 'synthetic-review' }; }
  };
  const app = createApp({ databasePool: makeAuthPool('finance'), environment, financeReviewActionService,
    retakeReferralService: noCallService([]) });
  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const response = await fetch(`${baseUrl}/finance/retake-referrals/items/1/decision`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'no_charge', reason: 'No charge is approved.' })
    });
    assert.equal(response.status, 403);
  });
  assert.deepEqual(starts, [], 'Finance decision parsing and review draft creation happen only after CSRF verification');
});

test('a retake review draft stays recoverable while Registrar correction is unfinished', async () => {
  const draftId = '41111111-1111-4111-8111-111111111111';
  const draft = {
    id: draftId, actionType: 'retake_item_decision', status: 'pending', revision: 2,
    dependencyFingerprint: 'a'.repeat(64), sessionBindingHmac: 'b'.repeat(64), entityContext: { itemKeyId: 71 },
    input: { decision: 'charge', amount: '18.00', chargeDescription: 'Synthetic repeat module',
      reason: 'Reviewed for this item.' },
    preview: { student: { name: 'Synthetic Learner', studentNumber: 'SYN-71' }, fields: [],
      targetDetails: [{ label: 'Retake item', value: 'Synthetic repeat module' }],
      retakeDecision: { decision: 'charge', chargeDescription: 'Synthetic repeat module',
        charge: { grossAmount: '18.00', approvedExemption: '0.00', payableAmount: '18.00' } } }
  };
  const reviewActions = {
    matchesMutation: () => false, isReadOnlyPost: () => false,
    actionLabel: () => 'Review a retake referral item', afterCommitPath: () => '/finance/retake-referrals',
    async freshReview() {
      throw new FinanceReviewDraftError('This finalized retake item is no longer available for review.', 409);
    },
    async getDraft(actorId, requestedDraftId) {
      assert.equal(actorId, 7);
      assert.equal(requestedDraftId, draftId);
      return structuredClone(draft);
    }
  };
  const app = createApp({ databasePool: makeAuthPool('finance'), environment, financeReviewActionService: reviewActions });
  await withServer(app, async (baseUrl) => {
    const cookie = await signIn(baseUrl, 'finance');
    const response = await fetch(`${baseUrl}/finance/review-drafts/${draftId}`, { headers: { cookie } });
    const html = await response.text();
    assert.equal(response.status, 409);
    assert.match(html, /pending draft and values are retained/);
    assert.match(html, /wait until the record is available, then reload for a fresh review/);
    assert.match(html, /name="field_amount"[^>]*value="18\.00"/);
    assert.match(html, /name="field_reason"[^>]*>Reviewed for this item\./);
    assert.match(html, /<button[^>]*disabled[^>]*>Save Finance decision<\/button>/);
    assert.doesNotMatch(html, /Service Unavailable/);
  });
});
