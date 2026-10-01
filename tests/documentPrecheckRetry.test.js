const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { createDocumentService } = require('../src/services/documentService');
const {
  MAX_GEMINI_PRECHECK_ATTEMPTS,
  canRetryGeminiPrecheck
} = require('../src/services/documentValidationService');

const TRANSIENT_SUMMARY = {
  stage: 'gemini_precheck',
  precheckVersion: 2,
  outcome: 'gemini_unavailable',
  fileFormatPassed: true,
  gemini: { status: 'unavailable', code: 'timeout', fields: null }
};

function fakeSql() {
  return {
    MAX: 'MAX', Int: 'Int',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
    NVarChar: (length) => `NVarChar(${length})`
  };
}

function retryService({
  actorRole = 'registrar',
  documentType = 'good_moral',
  isLegacyArchive = false,
  documentStatus = 'needs_review',
  summary = TRANSIENT_SUMMARY,
  attemptCount = 1,
  finalDecision = null
} = {}) {
  const state = { documentStatus, committed: false, rolledBack: false, queries: [], audit: null };
  const transactionFactory = () => ({
    async begin(isolation) { state.isolation = isolation; },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          state.queries.push({ statement, values: { ...values } });
          if (statement.includes('FROM users')) {
            return { recordset: actorRole ? [{ id: values.actorId, role: actorRole }] : [] };
          }
          if (statement.includes('FROM documents AS d') && statement.includes('FOR UPDATE')) {
            return { recordset: [{
              id: values.documentId,
              student_id: 44,
              document_type: documentType,
              is_legacy_archive: isLegacyArchive ? 1 : 0,
              status: state.documentStatus,
              validation_json: JSON.stringify(summary),
              precheck_attempt_count: String(attemptCount)
            }] };
          }
          if (statement.includes('FROM document_decision_events')) {
            return { recordset: finalDecision ? [{ decision_type: finalDecision }] : [] };
          }
          if (statement.includes("SET status = 'pending'")) {
            if (state.documentStatus !== 'needs_review') return { affectedRows: 0 };
            state.documentStatus = 'pending';
            return { affectedRows: 1 };
          }
          if (statement.includes('INSERT INTO audit_logs')) {
            state.audit = values;
            return { recordset: [] };
          }
          throw new Error(`Unexpected SQL: ${statement}`);
        }
      };
    },
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; }
  });
  const service = createDocumentService({
    getPool: async () => ({}),
    sql: fakeSql(),
    transactionFactory,
    storageDirectory: path.join(os.tmpdir(), 'ark-document-precheck-retry-test')
  });
  return { service, state };
}

test('retry policy allows only a bounded transient Gemini failure with a passed file-format check', () => {
  assert.equal(MAX_GEMINI_PRECHECK_ATTEMPTS, 3);
  const eligible = {
    documentType: 'good_moral',
    documentStatus: 'needs_review',
    validationSummary: TRANSIENT_SUMMARY,
    precheckAttemptCount: 1,
    hasFinalDecision: false
  };
  assert.equal(canRetryGeminiPrecheck(eligible), true);
  assert.equal(canRetryGeminiPrecheck({ ...eligible, documentType: 'psa_birth_certificate' }), true);
  assert.equal(canRetryGeminiPrecheck({ ...eligible, documentType: 'report_card', isLegacyArchive: false }), true);
  assert.equal(canRetryGeminiPrecheck({ ...eligible, documentType: 'report_card', isLegacyArchive: true }), false);
  assert.equal(canRetryGeminiPrecheck({ ...eligible, documentType: 'report_card' }), false, 'archive state must be explicit');
  assert.equal(canRetryGeminiPrecheck({ ...eligible, documentType: 'form_137' }), false);
  assert.equal(canRetryGeminiPrecheck({ ...eligible, documentStatus: 'valid' }), false);
  assert.equal(canRetryGeminiPrecheck({ ...eligible, hasFinalDecision: true }), false);
  assert.equal(canRetryGeminiPrecheck({ ...eligible, precheckAttemptCount: 3 }), false);
  assert.equal(canRetryGeminiPrecheck({ ...eligible, validationSummary: { ...TRANSIENT_SUMMARY, fileFormatPassed: false } }), false);
  assert.equal(canRetryGeminiPrecheck({
    ...eligible,
    validationSummary: { ...TRANSIENT_SUMMARY, gemini: { status: 'unavailable', code: 'missing_api_key' } }
  }), false);
});

test('registrar retry atomically queues the same submission and preserves its validation history', async () => {
  const { service, state } = retryService();
  const result = await service.requestPrecheckRetry(7, '84');

  assert.deepEqual(result, { id: 84, status: 'pending' });
  assert.equal(state.documentStatus, 'pending');
  assert.equal(state.committed, true);
  assert.equal(state.rolledBack, false);
  assert.equal(state.isolation, 'SERIALIZABLE');
  const documentLock = state.queries.find(({ statement }) => statement.includes('FROM documents AS d') && statement.includes('FOR UPDATE'));
  assert.match(documentLock.statement, /FOR UPDATE/);
  assert.equal(state.queries.some(({ statement }) => statement.startsWith('DELETE FROM document_validations')), false);
  assert.equal(state.audit.action, 'registrar.document_precheck_retry_queued');
  assert.equal(state.audit.detailsJson.includes('timeout'), false);
});

test('database administrators can also queue an eligible retry', async () => {
  const { service, state } = retryService({ actorRole: 'database_admin' });
  assert.deepEqual(await service.requestPrecheckRetry(7, '84'), { id: 84, status: 'pending' });
  assert.equal(state.audit.action, 'database_admin.document_precheck_retry_queued');
});

test('staff can retry an active report-card precheck and SQL rechecks the archive flag', async () => {
  const { service, state } = retryService({ documentType: 'report_card', isLegacyArchive: false });
  assert.deepEqual(await service.requestPrecheckRetry(7, '84'), { id: 84, status: 'pending' });
  const update = state.queries.find(({ statement }) => statement.includes("SET status = 'pending'"));
  assert.match(update.statement, /document_type = 'report_card' AND is_legacy_archive = 0/);
  assert.equal(state.audit.action, 'registrar.document_precheck_retry_queued');
});

test('retry refuses inactive roles, legacy/unsupported documents, final decisions, permanent errors, and exhausted attempts', async () => {
  const cases = [
    { options: { actorRole: null }, status: 403 },
    { options: { actorRole: 'student' }, status: 403 },
    { options: { documentType: 'report_card', isLegacyArchive: true }, status: 409 },
    { options: { finalDecision: 'verified' }, status: 409 },
    { options: { attemptCount: 3 }, status: 409 },
    { options: { summary: { ...TRANSIENT_SUMMARY, gemini: { status: 'unavailable', code: 'invalid_model' } } }, status: 409 },
    { options: { documentStatus: 'valid', finalDecision: 'verified' }, status: 409 }
  ];

  for (const { options, status } of cases) {
    const { service, state } = retryService(options);
    await assert.rejects(service.requestPrecheckRetry(7, '84'), (error) => error.status === status);
    assert.notEqual(state.documentStatus, 'pending');
    assert.equal(state.audit, null);
  }
});
