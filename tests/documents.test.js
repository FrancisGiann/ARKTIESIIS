const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const vm = require('node:vm');
const bcrypt = require('bcrypt');
const { createApp } = require('../src/app');
const { configuredMaxBytes, documentStatusLabel } = require('../src/routes/documents');
const {
  DocumentServiceError,
  createDocumentService,
  validateUpload,
  verificationChecklistItems
} = require('../src/services/documentService');

function fakeSql() {
  return {
    MAX: 'MAX',
    Int: 'Int',
    BigInt: 'BigInt',
    Bit: 'Bit',
    ISOLATION_LEVEL: { SERIALIZABLE: 'SERIALIZABLE' },
    NVarChar: (length) => `NVarChar(${length})`
  };
}

function makeFile({ name = 'report.pdf', mimeType = 'application/pdf', bytes = Buffer.from('%PDF-1.7\nexample'), size } = {}) {
  return { originalname: name, mimetype: mimeType, buffer: bytes, size: size ?? bytes.length };
}

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ark-document-test-'));
}

function confirmedChecklist(documentType) {
  return Object.fromEntries(verificationChecklistItems(documentType).map(({ key }) => [key, 'yes']));
}

test('upload validation requires supported extension, MIME, signature, nonempty content, and configured size', () => {
  assert.equal(configuredMaxBytes({ upload: { maxMb: 0.5 } }), 524288);
  assert.deepEqual(validateUpload(makeFile(), 100), {
    originalFilename: 'report.pdf', extension: '.pdf', mimeType: 'application/pdf', fileSizeBytes: 16
  });
  assert.equal(validateUpload(makeFile({ name: 'scan.PNG', mimeType: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }), 100).mimeType, 'image/png');
  assert.equal(validateUpload(makeFile({ name: 'scan.jpeg', mimeType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }), 100).extension, '.jpeg');
  assert.throws(() => validateUpload(null, 100), /Choose a PDF/);
  assert.throws(() => validateUpload(makeFile({ bytes: Buffer.alloc(0), size: 0 }), 100), /file is empty/);
  assert.throws(() => validateUpload(makeFile({ size: 101 }), 100), /configured upload limit/);
  assert.throws(() => validateUpload(makeFile({ name: 'report.jpg', mimeType: 'application/pdf' }), 100), /extension and declared file type/);
  assert.throws(() => validateUpload(makeFile({ bytes: Buffer.from('not a pdf') }), 100), /content does not match/);
  assert.throws(() => validateUpload(makeFile({ name: 'report.exe' }), 100), /extension and declared file type/);
});

test('document status labels distinguish active report cards from the legacy archive', () => {
  assert.equal(documentStatusLabel('valid'), 'Verified after staff source inspection');
  assert.equal(documentStatusLabel('needs_review'), 'Awaiting staff review');
  assert.equal(documentStatusLabel('needs_review', 'correction_requested'), 'Correction requested');
  assert.equal(documentStatusLabel('failed'), 'Automated precheck unavailable; staff review required');
  assert.equal(documentStatusLabel('rejected'), 'Rejected after staff review');
  assert.equal(documentStatusLabel('needs_review', null, null, 'report_card'), 'Awaiting staff review');
  assert.equal(documentStatusLabel('needs_review', 'correction_requested', null, 'report_card'), 'Correction requested');
  assert.equal(documentStatusLabel('pending', null, null, 'report_card'), 'Waiting for field precheck');
  assert.equal(documentStatusLabel('processing', null, null, 'report_card'), 'Field precheck processing');
  assert.equal(documentStatusLabel('failed', null, null, 'report_card'), 'Precheck unavailable; staff review required');
  assert.equal(documentStatusLabel('pending', null, null, 'report_card', true), 'Historical archive');
});

function transactionHarness({ actorRole = 'student', ownStudentId = 44, previousOwnerId = 7, previousDocumentType = 'good_moral', previousUploadSource = actorRole === 'student' ? 'student' : 'registrar', previousIsLegacyArchive = false, failAt = null, correctionAction = 'correction_requested', hasRevision = false, hasCorrectedSubmission = false, originalSubmissionExists = false, latestSubmissionStatus = originalSubmissionExists ? 'needs_review' : null, latestSubmissionRows = null, documentStatus = 'needs_review', ocrResultStatus = 'needs_review', validationJson = JSON.stringify({ advisoryChecks: [{ key: 'linked_student_name', found: true }] }), originalFilename = 'report.pdf', storedFilename = '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf', previousDecision = null, id = 90, fileSystem } = {}) {
  const state = { queries: [], inserted: [], events: [], decisions: [], form137Statuses: [], previousSchoolReportCardStatuses: [], deletedRows: [], documentExists: true, committed: false, rolledBack: false, id, documentStatus, previousDecision };
  const transactionFactory = () => ({
    async begin(isolation) {
      state.isolation = isolation;
      state.transactionSnapshot = {
        documentStatus: state.documentStatus,
        insertedCount: state.inserted.length,
        eventCount: state.events.length,
        decisionCount: state.decisions.length,
        deletedRowCount: state.deletedRows.length,
        documentExists: state.documentExists,
        form137StatusCount: state.form137Statuses.length,
        previousSchoolReportCardStatusCount: state.previousSchoolReportCardStatuses.length,
        audit: state.audit
      };
    },
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          const call = { statement, values: { ...values } };
          state.queries.push(call);
          if (statement.includes('FROM users')) return { recordset: actorRole ? [{ id: 7, role: actorRole }] : [] };
          if (statement.startsWith('DELETE FROM document_validations')) { state.deletedRows.push('document_validations'); return { recordset: [] }; }
          if (statement.startsWith('DELETE FROM document_review_events')) { state.deletedRows.push('document_review_events'); return { recordset: [] }; }
          if (statement.startsWith('DELETE FROM document_decision_events')) { state.deletedRows.push('document_decision_events'); return { recordset: [] }; }
          if (statement.startsWith('DELETE FROM documents')) {
            state.documentExists = false;
            return { affectedRows: 1 };
          }
          if (statement.includes('FROM documents AS d') && statement.includes('stored_filename')) {
            return { recordset: state.documentExists ? [{ id: values.documentId, student_id: 44, document_type: previousDocumentType, is_legacy_archive: previousIsLegacyArchive ? 1 : 0, stored_filename: storedFilename }] : [] };
          }
          if (statement.includes('WHERE supersedes_document_id = @documentId') && statement.includes('FOR UPDATE')) return { recordset: hasCorrectedSubmission ? [{ id: 91 }] : [] };
          if (statement.includes('v_document_latest_validation')) return { recordset: [{ id: values.documentId, student_id: 44, document_type: previousDocumentType, is_legacy_archive: previousIsLegacyArchive ? 1 : 0, status: state.documentStatus, original_filename: originalFilename, mime_type: 'application/pdf', result_status: ocrResultStatus, validation_json: validationJson, precheck_attempt_count: 1 }] };
          if (statement.includes('SELECT id FROM documents') && statement.includes('supersedes_document_id')) return { recordset: hasRevision ? [{ id: 91 }] : [] };
          if (statement.includes('FROM students') && statement.includes('WHERE user_id = @actorId')) return { recordset: ownStudentId ? [{ id: ownStudentId }] : [] };
          if (statement.includes('FROM students') && statement.includes('WHERE id = @studentId')) return { recordset: [{ id: values.studentId }] };
          if (statement.includes('SELECT id, status FROM documents') && statement.includes('student_id = @studentId')) {
            if (previousDocumentType === 'report_card' && previousIsLegacyArchive) return { recordset: [] };
            return { recordset: latestSubmissionRows || (latestSubmissionStatus ? [{ id: 12, status: latestSubmissionStatus }] : []) };
          }
          if (statement.includes('FROM documents AS d')) return { recordset: [{ id: values.documentId, student_id: 44, document_type: previousDocumentType, upload_source: previousUploadSource, is_legacy_archive: previousIsLegacyArchive ? 1 : 0, status: state.documentStatus, original_filename: originalFilename, mime_type: 'application/pdf', result_status: ocrResultStatus, validation_json: validationJson, student_user_id: previousOwnerId }] };
          if (statement.includes('FROM documents')) return { recordset: [{ id: values.documentId, student_id: 44, document_type: 'good_moral' }] };
          if (statement.includes('FROM document_validations AS validation')) return { recordset: [{ id: 1, processor: 'gemini-document-precheck-v2', extracted_text: '', validation_json: validationJson, result_status: ocrResultStatus, created_at: new Date(), precheck_attempt_count: 1 }] };
          if (statement.includes('FROM document_decision_events')) return { recordset: state.previousDecision ? [{ decision_type: state.previousDecision }] : [] };
          if (statement.includes('FROM document_review_events')) return { recordset: correctionAction ? [{ action_type: correctionAction }] : [] };
          if (statement.includes('INSERT INTO documents')) {
            if (failAt === 'insert') throw new Error('database details are private');
            state.inserted.push(call);
            return { insertId: state.id++ };
          }
          if (statement.includes('INSERT INTO document_review_events')) { state.events.push(call); return { recordset: [] }; }
          if (statement.includes('INSERT INTO document_decision_events')) { state.decisions.push(call); return { recordset: [] }; }
          if (statement.includes('INSERT INTO form137_status_events')) { state.form137Statuses.push(call); return { recordset: [] }; }
          if (statement.includes('INSERT INTO previous_school_report_card_status_events')) { state.previousSchoolReportCardStatuses.push(call); return { recordset: [] }; }
          if (statement.includes('UPDATE documents')) {
            if (statement.includes("SET status = 'pending'")) {
              state.documentStatus = 'pending';
              return { affectedRows: 1 };
            }
            if (statement.includes('@nextStatus')) {
              if (state.documentStatus !== values.currentStatus || !['needs_review', 'failed'].includes(state.documentStatus)) return { affectedRows: 0 };
              state.documentStatus = values.nextStatus;
              return { affectedRows: 1 };
            }
            return { recordset: [] };
          }
          if (statement.includes('INSERT INTO audit_logs')) {
            if (failAt === 'audit') throw new Error('database details are private');
            state.audit = call;
            return { recordset: [] };
          }
          throw new Error(`Unexpected SQL: ${statement}`);
        }
      };
    },
    async commit() { if (failAt === 'commit') throw new Error('database details are private'); state.committed = true; },
    async rollback() {
      state.rolledBack = true;
      const snapshot = state.transactionSnapshot;
      if (!snapshot) return;
      state.documentStatus = snapshot.documentStatus;
      state.inserted.length = snapshot.insertedCount;
      state.events.length = snapshot.eventCount;
      state.decisions.length = snapshot.decisionCount;
      state.deletedRows.length = snapshot.deletedRowCount;
      state.documentExists = snapshot.documentExists;
      state.form137Statuses.length = snapshot.form137StatusCount;
      state.previousSchoolReportCardStatuses.length = snapshot.previousSchoolReportCardStatusCount;
      if (snapshot.audit === undefined) delete state.audit;
      else state.audit = snapshot.audit;
    }
  });
  const service = createDocumentService({ getPool: async () => ({}), sql: fakeSql(), transactionFactory, maxUploadBytes: 100, fileSystem });
  return { state, transactionFactory, service };
}

// Replace test service with a storage-root-scoped instance while retaining the same SQL fixture.
function serviceWithStorage(harness, storageDirectory, fileSystem, logger) {
  return createDocumentService({
    getPool: async () => ({}),
    sql: fakeSql(),
    transactionFactory: harness.transactionFactory,
    maxUploadBytes: 100,
    storageDirectory,
    fileSystem,
    logger
  });
}

test('Good Moral upload derives the linked student record, checks private storage permissions where supported, and audits without file contents', async () => {
  const directory = await temporaryDirectory();
  try {
    const harness = transactionHarness();
    const service = serviceWithStorage(harness, directory);
    await service.upload(7, { documentType: 'good_moral', studentId: '999' }, makeFile({ name: 'moral.pdf' }));
    const insert = harness.state.inserted[0];
    assert.equal(insert.values.studentId, 44);
    assert.equal(insert.values.documentType, 'good_moral');
    assert.equal(insert.values.uploadSource, 'student');
    assert.equal(insert.values.initialStatus, 'pending');
    assert.equal(insert.values.isLegacyArchive, 0);
    assert.match(insert.values.storedFilename, /^[0-9a-f-]+\.pdf$/i);
    assert.notEqual(insert.values.storedFilename, 'moral.pdf');
    assert.equal(harness.state.committed, true);
    assert.equal(harness.state.isolation, 'SERIALIZABLE');
    const originalLookup = harness.state.queries.find(({ statement }) => statement.includes('SELECT id, status FROM documents') && statement.includes('student_id = @studentId'));
    assert.match(originalLookup.statement, /FOR UPDATE/);
    assert.match(originalLookup.statement, /ORDER BY created_at DESC, id DESC/);
    assert.doesNotMatch(originalLookup.statement, /supersedes_document_id IS NULL|status\s*=\s*'rejected'/);
    assert.deepEqual([originalLookup.values.studentId, originalLookup.values.documentType], [44, 'good_moral']);
    assert.match(harness.state.queries.find(({ statement }) => statement.includes('FROM students')).statement, /FOR UPDATE/);
    assert.equal(harness.state.audit.values.action, 'student.document_uploaded');
    assert.equal(harness.state.audit.values.detailsJson.includes('report.pdf'), false);
    assert.equal(harness.state.audit.values.detailsJson.includes('example'), false);
    const storedPath = path.join(directory, insert.values.storedFilename);
    assert.equal((await fs.readFile(storedPath)).toString(), '%PDF-1.7\nexample');
    // Windows uses ACLs; Node's chmod mode does not expose owner/group/other privacy bits.
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(storedPath)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    }
    assert.match(path.relative(directory, storedPath), /^[-0-9a-f]+\.pdf$/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a student and staff cannot create a second original submission for the same student and type', async () => {
  const directory = await temporaryDirectory();
  try {
    for (const actorRole of ['student', 'registrar', 'database_admin']) {
      const harness = transactionHarness({ actorRole, originalSubmissionExists: true });
      await assert.rejects(
        serviceWithStorage(harness, directory).upload(7, { documentType: 'good_moral', studentId: '44' }, makeFile()),
        (error) => error.status === 409 && /submission of this type already exists/.test(error.message)
      );
      assert.equal(harness.state.inserted.length, 0);
      assert.equal(harness.state.rolledBack, true);
      assert.deepEqual(await fs.readdir(directory), [], 'rejected originals never create stored files');
      const lockQuery = harness.state.queries.find(({ statement }) => statement.includes('SELECT id, status FROM documents') && statement.includes('student_id = @studentId'));
      assert.match(lockQuery.statement, /FOR UPDATE/);
      assert.match(lockQuery.statement, /ORDER BY created_at DESC, id DESC/);
      assert.deepEqual([lockQuery.values.studentId, lockQuery.values.documentType], [44, 'good_moral']);
    }

    const correction = transactionHarness({ originalSubmissionExists: true, correctionAction: 'correction_requested' });
    await serviceWithStorage(correction, directory).reupload(7, '12', makeFile({ name: 'corrected.pdf' }));
    assert.equal(correction.state.inserted[0].values.supersedesDocumentId, 12, 'requested corrections remain linked revisions');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a rejected latest Good Moral or PSA submission allows a fresh original while active latest submissions block it', async () => {
  const directory = await temporaryDirectory();
  try {
    for (const actorRole of ['student', 'registrar', 'database_admin']) {
      for (const documentType of ['good_moral', 'psa_birth_certificate']) {
        const rejected = transactionHarness({ actorRole, previousDocumentType: documentType, latestSubmissionStatus: 'rejected' });
        const result = await serviceWithStorage(rejected, directory).upload(7, { documentType, studentId: '44' }, makeFile());
        assert.equal(result.documentType, documentType);
        assert.equal(rejected.state.inserted[0].values.supersedesDocumentId, null, 'a post-rejection upload is a new original');
        assert.equal(rejected.state.inserted[0].values.studentId, 44);
        assert.equal(rejected.state.deletedRows.length, 0, 'rejection history is not deleted');
        const latestLookup = rejected.state.queries.find(({ statement }) => statement.includes('SELECT id, status FROM documents') && statement.includes('student_id = @studentId'));
        assert.match(latestLookup.statement, /ORDER BY created_at DESC, id DESC/);
        assert.doesNotMatch(latestLookup.statement, /supersedes_document_id IS NULL|status\s*=\s*'rejected'/);
      }
    }

    for (const actorRole of ['student', 'registrar', 'database_admin']) {
      for (const documentType of ['good_moral', 'psa_birth_certificate']) {
        for (const latestSubmissionStatus of ['pending', 'processing', 'valid', 'needs_review', 'failed']) {
          const activeLatest = transactionHarness({ actorRole, previousDocumentType: documentType, latestSubmissionStatus });
          await assert.rejects(
            serviceWithStorage(activeLatest, directory).upload(7, { documentType, studentId: '44' }, makeFile()),
            (error) => error.status === 409
          );
          assert.equal(activeLatest.state.inserted.length, 0, `${actorRole} cannot add ${documentType} while latest status is ${latestSubmissionStatus}`);
          assert.equal(activeLatest.state.rolledBack, true);
        }
      }
    }

    const olderRejectedNewerActive = transactionHarness({
      latestSubmissionRows: [
        { id: 24, status: 'needs_review' },
        { id: 12, status: 'rejected' }
      ]
    });
    await assert.rejects(
      serviceWithStorage(olderRejectedNewerActive, directory).upload(7, { documentType: 'good_moral' }, makeFile()),
      (error) => error.status === 409
    );
    assert.equal(olderRejectedNewerActive.state.inserted.length, 0, 'the latest active correction controls eligibility when an older row was rejected');
    assert.match(olderRejectedNewerActive.state.queries.find(({ statement }) => statement.includes('SELECT id, status FROM documents') && statement.includes('student_id = @studentId')).statement, /ORDER BY created_at DESC, id DESC/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('document storage rejects a location inside the public web directory', () => {
  const publicStorageDirectory = path.resolve(__dirname, '../public/private-uploads');
  assert.throws(() => createDocumentService({ storageDirectory: publicStorageDirectory }), /outside the public web directory/);
});

test('Form 137 cannot be uploaded; students can only upload report cards to their linked record', async () => {
  const directory = await temporaryDirectory();
  try {
    const restricted = transactionHarness();
    await assert.rejects(serviceWithStorage(restricted, directory).upload(7, { documentType: 'form_137', studentId: '44' }, makeFile()), /physical document status/);
    assert.equal(restricted.state.inserted.length, 0);
    assert.deepEqual(await fs.readdir(directory), []);

    const reportCard = transactionHarness();
    const reportCardResult = await serviceWithStorage(reportCard, directory).upload(7, { documentType: 'report_card', studentId: '999' }, makeFile({ name: 'term-report.pdf' }));
    assert.equal(reportCardResult.studentId, 44, 'forged studentId cannot redirect a report-card upload');
    assert.equal(reportCardResult.status, 'pending', 'new active report cards enter the bounded precheck queue');
    assert.equal(reportCard.state.inserted[0].values.uploadSource, 'student');
    assert.equal(reportCard.state.inserted[0].values.initialStatus, 'pending');
    assert.equal(reportCard.state.inserted[0].values.isLegacyArchive, 0);
    assert.equal(reportCard.state.queries.some(({ statement }) => statement.includes('SELECT id, status FROM documents') && statement.includes("@documentType <> 'report_card' OR is_legacy_archive = 0")), true);
    const legacyLatest = transactionHarness({ previousDocumentType: 'report_card', previousIsLegacyArchive: true, originalSubmissionExists: true });
    const afterLegacyArchive = await serviceWithStorage(legacyLatest, directory).upload(7, { documentType: 'report_card' }, makeFile({ name: 'new-term-report.pdf' }));
    assert.equal(afterLegacyArchive.status, 'pending', 'an old archive row does not block a new lifecycle submission');
    assert.equal(legacyLatest.state.inserted[0].values.documentType, 'report_card');
    const legacyGate = legacyLatest.state.queries.find(({ statement }) => statement.includes('SELECT id, status FROM documents') && statement.includes('student_id = @studentId'));
    assert.match(legacyGate.statement, /@documentType <> 'report_card' OR is_legacy_archive = 0/);

    const unlinked = transactionHarness({ ownStudentId: null });
    await assert.rejects(serviceWithStorage(unlinked, directory).upload(7, { documentType: 'good_moral' }, makeFile()), /No student record is linked/);
    assert.equal(unlinked.state.inserted.length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('student PSA upload uses the linked record and records student origin', async () => {
  const directory = await temporaryDirectory();
  try {
    const harness = transactionHarness();
    const service = serviceWithStorage(harness, directory);
    await service.upload(7, { documentType: 'psa_birth_certificate', studentId: '999' }, makeFile({ name: 'birth-certificate.pdf' }));
    const insert = harness.state.inserted[0];
    assert.equal(insert.values.studentId, 44, 'a submitted studentId cannot redirect the upload');
    assert.equal(insert.values.documentType, 'psa_birth_certificate');
    assert.equal(insert.values.uploadedBy, 7);
    assert.equal(insert.values.uploadSource, 'student');
    assert.equal(harness.state.audit.values.action, 'student.document_uploaded');
    assert.equal((await fs.readdir(directory)).length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('student re-upload creates a linked immutable submission only after a correction request', async () => {
  const directory = await temporaryDirectory();
  try {
    const harness = transactionHarness({ correctionAction: 'correction_requested' });
    const service = serviceWithStorage(harness, directory);
    const result = await service.reupload(7, '12', makeFile({ name: 'corrected.pdf' }));
    assert.equal(result.id, 90);
    assert.equal(harness.state.inserted[0].values.studentId, 44);
    assert.equal(harness.state.inserted[0].values.documentType, 'good_moral');
    assert.equal(harness.state.inserted[0].values.supersedesDocumentId, 12);
    assert.equal(harness.state.inserted[0].values.originalFilename, 'corrected.pdf');
    assert.equal(harness.state.queries.some(({ statement }) => statement.startsWith('UPDATE documents')), false);
    assert.equal(harness.state.audit.values.action, 'student.document_reuploaded');

    const selfSuperseding = transactionHarness({ id: 12 });
    await assert.rejects(
      serviceWithStorage(selfSuperseding, directory).reupload(7, '12', makeFile({ name: 'self-linked.pdf' })),
      /cannot supersede itself/
    );
    assert.equal(selfSuperseding.state.rolledBack, true, 'the invalid self-link is rejected before commit');

    const legacyReportCard = transactionHarness({ previousDocumentType: 'report_card', previousUploadSource: 'student', previousIsLegacyArchive: true });
    await assert.rejects(serviceWithStorage(legacyReportCard, directory).reupload(7, '12', makeFile({ name: 'corrected-report.pdf' })), /Document not found/);
    assert.equal(legacyReportCard.state.inserted.length, 0, 'legacy report-card archive is not available for student correction');
    const staffOriginReportCard = transactionHarness({ previousDocumentType: 'report_card', previousUploadSource: 'registrar' });
    await assert.rejects(serviceWithStorage(staffOriginReportCard, directory).reupload(7, '12', makeFile({ name: 'corrected-report.pdf' })), /Document not found/);
    assert.equal(staffOriginReportCard.state.inserted.length, 0, 'students cannot replace a staff-origin report card');
    const activeReportCard = transactionHarness({ previousDocumentType: 'report_card', previousUploadSource: 'student' });
    const reportRevision = await serviceWithStorage(activeReportCard, directory).reupload(7, '12', makeFile({ name: 'corrected-report.pdf' }));
    assert.equal(reportRevision.status, 'pending');
    assert.equal(activeReportCard.state.inserted[0].values.documentType, 'report_card');
    assert.equal(activeReportCard.state.inserted[0].values.supersedesDocumentId, 12);
    assert.equal(activeReportCard.state.inserted[0].values.initialStatus, 'pending');

    const noRequest = transactionHarness({ correctionAction: null });
    await assert.rejects(serviceWithStorage(noRequest, directory).reupload(7, '12', makeFile()), /has not been requested/);
    assert.equal(noRequest.state.inserted.length, 0);
    const alreadyReuploaded = transactionHarness({ hasRevision: true });
    await assert.rejects(serviceWithStorage(alreadyReuploaded, directory).reupload(7, '12', makeFile()), /already been submitted/);

    const restrictedType = transactionHarness({ previousDocumentType: 'form_137' });
    await assert.rejects(serviceWithStorage(restrictedType, directory).reupload(7, '12', makeFile()), /Document not found/);
    assert.equal(restrictedType.state.inserted.length, 0);

    const studentPsa = transactionHarness({ previousDocumentType: 'psa_birth_certificate', previousUploadSource: 'student' });
    await serviceWithStorage(studentPsa, directory).reupload(7, '12', makeFile({ name: 'corrected-birth-certificate.pdf' }));
    assert.equal(studentPsa.state.inserted[0].values.documentType, 'psa_birth_certificate');
    assert.equal(studentPsa.state.inserted[0].values.uploadSource, 'student');

    const staffPsa = transactionHarness({ previousDocumentType: 'psa_birth_certificate', previousUploadSource: 'registrar' });
    await assert.rejects(serviceWithStorage(staffPsa, directory).reupload(7, '12', makeFile()), /Document not found/);
    assert.equal(staffPsa.state.inserted.length, 0, 'student cannot replace a staff-uploaded PSA even after a correction request');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('student document lists include both student and staff PSA submissions for the linked record', async () => {
  const rows = [
    { id: 1, document_type: 'good_moral', status: 'needs_review' },
    { id: 2, document_type: 'report_card', upload_source: 'student' },
    { id: 3, document_type: 'form_137' },
    { id: 4, document_type: 'psa_birth_certificate', upload_source: 'registrar', status: 'rejected' },
    { id: 5, document_type: 'psa_birth_certificate', upload_source: 'student', status: 'rejected' }
  ];
  let listSql = '';
  let blockedTypesSql = '';
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          if (statement.startsWith('SELECT id, role FROM users')) return { recordset: [{ id: values.actorId, role: 'student' }] };
          if (statement.includes('form137_status_events')) return { recordset: [] };
          if (statement.includes('WITH latest_submissions AS')) {
            blockedTypesSql = statement;
            return { recordset: [{ document_type: 'good_moral' }] };
          }
          listSql = statement;
          const allowedTypeFilter = statement.includes("d.document_type IN ('good_moral', 'psa_birth_certificate')");
          return { recordset: allowedTypeFilter ? rows.filter((row) => ['good_moral', 'psa_birth_certificate', 'report_card'].includes(row.document_type)) : rows };
        }
      };
    }
  };
  const service = createDocumentService({ getPool: async () => pool, sql: fakeSql() });
  const result = await service.listDocuments(7);
  assert.deepEqual(result.documents.map(({ document_type, upload_source }) => `${document_type}:${upload_source || 'unknown'}`), [
    'good_moral:unknown', 'report_card:student', 'psa_birth_certificate:registrar', 'psa_birth_certificate:student'
  ]);
  assert.match(listSql, /s\.user_id = @actorId AND \(/);
  assert.match(listSql, /d\.document_type IN \('good_moral', 'psa_birth_certificate'\)/);
  assert.match(listSql, /d\.document_type = 'report_card' AND d\.is_legacy_archive = 0 AND d\.upload_source = 'student'/);
  assert.match(listSql, /THEN latest\.instruction ELSE NULL END AS latest_review_instruction/);
  assert.match(listSql, /d\.upload_source = 'student'/, 'student-facing list query excludes internal PSA instructions by upload origin');
  assert.match(listSql, /latest_decision\.decision_type AS latest_decision_type/);
  assert.match(listSql, /LEFT JOIN v_document_latest_decision_event AS latest_decision/);
  assert.deepEqual(result.blockedNewOriginalTypes, ['good_moral']);
  assert.match(blockedTypesSql, /ORDER BY d\.created_at DESC, d\.id DESC/);
  assert.match(blockedTypesSql, /s\.user_id = @actorId/);
  assert.doesNotMatch(blockedTypesSql, /TOP \(200\)/);
  assert.equal(result.form137Status, undefined);
  assert.doesNotMatch(listSql, /form137_status_events/, 'student document list never reads staff-only Form 137 status');
});

test('staff document queue supports bounded parameterized review filters and a missing-document summary', async () => {
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.startsWith('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'registrar' }] };
          if (statement.includes('LIMIT 200')) return { recordset: [{ id: 20, document_type: 'good_moral', status: 'needs_review' }] };
          if (statement.includes('GROUP BY required.document_type')) return { recordset: [{ document_type: 'good_moral', missing_count: 12, awaiting_review_count: 4 }] };
          if (statement.includes('WITH ranked_report_cards AS')) return { recordset: [{
            document_type: 'report_card', submitted_count: 3, awaiting_review_count: 1,
            processing_count: 0, review_required_count: 1, correction_requested_count: 1,
            verified_count: 0, rejected_count: 0
          }] };
          throw new Error(`Unexpected document query: ${statement}`);
        }
      };
    }
  };
  const service = createDocumentService({ getPool: async () => pool, sql: fakeSql() });
  const result = await service.listDocuments(7, 'Juan Dela Cruz', { documentType: 'good_moral', status: 'awaiting_review' });
  const listCall = calls.find(({ statement }) => statement.includes('LIMIT 200'));
  assert.equal(listCall.values.searchPattern, '%Juan Dela Cruz%');
  assert.equal(listCall.values.documentType, 'good_moral');
  assert.equal(listCall.values.statusFilter, 'awaiting_review');
  assert.match(listCall.statement, /s\.lrn LIKE @searchPattern/);
  assert.match(listCall.statement, /@documentType IS NULL OR d\.document_type = @documentType/);
  assert.match(listCall.statement, /@statusFilter = 'awaiting_review' AND d\.status = 'needs_review'[\s\S]*d\.document_type <> 'report_card' OR COALESCE\(latest_decision\.decision_type, ''\) <> 'correction_requested'/);
  assert.equal(result.documents[0].status, 'needs_review');
  assert.equal(result.statusSummary[0].missing_count, 12);
  assert.equal(result.documentType, 'good_moral');
  assert.equal(result.statusFilter, 'awaiting_review');
  const reportCardQueue = await service.listDocuments(7, '', { documentType: 'report_card' });
  assert.equal(reportCardQueue.documentType, 'report_card');
  const reportCardSummaryCall = calls.find(({ statement }) => statement.includes('WITH ranked_report_cards AS'));
  assert.match(reportCardSummaryCall.statement, /d\.document_type = 'report_card' AND d\.is_legacy_archive = 0 AND d\.upload_source = 'student'/);
  assert.match(reportCardSummaryCall.statement, /ROW_NUMBER\(\) OVER \(PARTITION BY d\.student_id ORDER BY d\.created_at DESC, d\.id DESC\)/);
  assert.match(reportCardSummaryCall.statement, /role IN \('registrar', 'database_admin'\)/);
  assert.equal(reportCardQueue.statusSummary[1].submitted_count, 3);
  assert.equal(reportCardQueue.statusSummary[1].awaiting_review_count, 1);
  assert.equal(reportCardQueue.statusSummary[1].correction_requested_count, 1);
});

test('physical requirements workspace searches and paginates latest staff-recorded statuses', async () => {
  const calls = [];
  let actorRole = 'registrar';
  const physicalStudent = {
    id: 44, student_no: 'SHS-2026-0321', lrn: '123456789012', first_name: 'Maria', middle_name: null,
    last_name: 'Santos', suffix: null, form137_status: 'received',
    form137_updated_at: new Date('2026-09-28T00:00:00Z'), paper_report_card_status: 'correction',
    paper_report_card_updated_at: new Date('2026-09-27T00:00:00Z')
  };
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.startsWith('SELECT id, role FROM users')) return { recordset: [{ id: values.actorId, role: actorRole }] };
          if (statement.includes('COUNT(*) AS total_students')) return { recordset: [{ total_students: 321 }] };
          if (statement.includes('v_form137_latest_status_event')) return { recordset: [physicalStudent] };
          throw new Error(`Unexpected physical-requirements query: ${statement}`);
        }
      };
    }
  };
  const service = createDocumentService({ getPool: async () => pool, sql: fakeSql() });
  const result = await service.listPhysicalRequirements(7, 'Maria Santos', '2');
  const countCall = calls.find(({ statement }) => statement.includes('COUNT(*) AS total_students'));
  const pageCall = calls.find(({ statement }) => statement.includes('v_form137_latest_status_event'));
  assert.equal(countCall.values.searchPattern, '%Maria Santos%');
  assert.match(countCall.statement, /s\.student_no LIKE @searchPattern/);
  assert.match(countCall.statement, /s\.lrn LIKE @searchPattern/);
  assert.match(countCall.statement, /CONCAT_WS\(' ', s\.first_name, NULLIF\(s\.middle_name, ''\), s\.last_name\) LIKE @searchPattern/);
  assert.match(countCall.statement, /s\.status = 'active'/);
  assert.match(countCall.statement, /role IN \('registrar', 'database_admin'\)/);
  assert.equal(pageCall.values.offset, 25);
  assert.equal(pageCall.values.pageSize, 25);
  assert.match(pageCall.statement, /ORDER BY s\.last_name, s\.first_name/);
  assert.match(pageCall.statement, /v_previous_school_report_card_latest_status_event/);
  assert.doesNotMatch(pageCall.statement, /instruction|recorded_by/);
  assert.deepEqual(result.students, [physicalStudent]);
  assert.deepEqual({ searchTerm: result.searchTerm, totalStudents: result.totalStudents, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages }, {
    searchTerm: 'Maria Santos', totalStudents: 321, page: 2, pageSize: 25, totalPages: 13
  });

  const lastPage = await service.listPhysicalRequirements(7, 'Maria %_[', '999');
  assert.equal(lastPage.page, 13);
  assert.equal(lastPage.totalPages, 13);
  assert.equal(calls.findLast(({ statement }) => statement.includes('COUNT(*) AS total_students')).values.searchPattern, '%Maria ~%~_~[%');
  assert.equal(calls.at(-1).values.offset, 300);
  await assert.rejects(service.listPhysicalRequirements(7, '', ['2']), /valid physical-requirements page/);
  assert.equal(calls.length, 6, 'invalid page input is rejected before SQL queries');
  actorRole = 'student';
  await assert.rejects(service.listPhysicalRequirements(7), /Staff physical-requirements access is required/);
  assert.equal(calls.length, 7, 'non-staff role is rejected before physical status queries');
});

test('Gemini findings are fetched only for registrar and database administrator document views', async () => {
  const document = {
    id: 88,
    student_id: 44,
    document_type: 'good_moral',
    original_filename: 'report.pdf',
    stored_filename: '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf',
    mime_type: 'application/pdf',
    file_size_bytes: 100,
    uploaded_by: 7,
    upload_source: 'student',
    is_legacy_archive: 0,
    status: 'needs_review',
    supersedes_document_id: null,
    created_at: new Date(),
    student_user_id: 7,
    student_no: 'S-44',
    first_name: 'Test',
    middle_name: null,
    last_name: 'Student',
    uploader_role: 'student'
  };

  async function readAsRole(role, {
    deactivateAfterDocumentRead = false,
    checklistSchemaVersion = 2,
    linkedNameFound = true,
    schoolNameFound = true,
    contextEvidenceFound = true,
    layoutEvidenceFound = true,
    legacyOcrOnly = false,
    resultStatus = 'needs_review',
    outcome = 'precheck_pass',
    documentType = 'good_moral',
    originalFilename = 'report.pdf',
    mimeType = 'application/pdf',
    extraCheck = false
  } = {}) {
    const queries = [];
    let staffIsActive = true;
    const pool = {
      request() {
        const values = {};
        return {
          input(name, _type, value) { values[name] = value; return this; },
          async query(statement) {
            queries.push({ statement, values: { ...values } });
            if (statement.includes('SELECT id, role FROM users')) return { recordset: [{ id: 7, role }] };
            if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.id = @documentId')) {
              if (deactivateAfterDocumentRead) staffIsActive = false;
              return { recordset: [{ ...document, document_type: documentType, original_filename: originalFilename, mime_type: mimeType }] };
            }
            if (statement.includes('FROM documents AS history_document')) return { recordset: [] };
            if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.student_id = @studentId')) return { recordset: [{ id: 88, original_filename: 'report.pdf', status: 'needs_review' }] };
            if (statement.includes('FROM document_review_events AS e')) return { recordset: [] };
            if (statement.includes('FROM document_decision_events AS e')) return { recordset: [{
              id: 5, decision_type: 'verified', reason: null,
              verification_checklist_json: role === 'student' ? null : JSON.stringify({
                schemaVersion: checklistSchemaVersion,
                linkedStudentNameLegible: true,
                schoolNameLegible: true,
                goodMoralContextLegible: true,
                selectedDocumentTypeCorrect: true,
                allSubmittedPagesReadableComplete: true
              }),
              created_at: new Date(), reviewer_name: null
            }] };
            if (statement.includes('FROM document_validations')) return { recordset: staffIsActive ? [{
              id: 4,
              processor: 'Gemini field extraction',
              extracted_text: null,
              validation_json: JSON.stringify({
                ...(legacyOcrOnly ? {} : { precheckVersion: 2 }),
                outcome, message: 'ignored untrusted message',
                fileFormatPassed: true,
                gemini: {
                  status: 'extracted',
                  studentNameMatchesLinkedRecord: linkedNameFound,
                  fields: {
                    studentName: 'Test Student',
                    issuingSchoolName: schoolNameFound ? 'Other Academy' : '',
                    goodMoralContextEvidence: contextEvidenceFound ? 'Good Moral character certificate statement.' : '',
                    goodMoralLayoutEvidence: layoutEvidenceFound ? 'Certificate title above a statement.' : ''
                  }
                },
                advisoryChecks: [
                  ...(documentType === 'good_moral'
                    ? [
                      { key: 'linked_student_name', found: linkedNameFound },
                      { key: 'possible_school_name', found: schoolNameFound, candidates: schoolNameFound ? ['Other Academy'] : [] }
                    ]
                    : [{ key: 'linked_student_name', found: linkedNameFound }]),
                  ...(extraCheck ? [{ key: 'unexpected_check', found: true }] : [])
                ]
              }),
              result_status: resultStatus,
              created_at: new Date()
            }] : [] };
            throw new Error(`Unexpected read SQL: ${statement}`);
          }
        };
      }
    };
    const service = createDocumentService({ getPool: async () => pool, sql: fakeSql() });
    return { result: await service.getDocument(7, '88'), queries };
  }

  const student = await readAsRole('student');
  assert.equal(student.result.validation, null);
  assert.deepEqual(student.result.decisions[0].verificationChecklist, []);
  assert.equal(student.queries.some(({ statement }) => statement.includes('FROM document_validations')), false);
  const studentDecisionQuery = student.queries.find(({ statement }) => statement.includes('FROM document_decision_events AS e'));
  assert.match(studentDecisionQuery.statement, /CAST\(NULL AS CHAR\(500\)\) AS verification_checklist_json/);

  const registrar = await readAsRole('registrar');
  assert.equal(registrar.result.validation.extracted_text, null);
  assert.equal(registrar.result.validation.message, 'The configured name and file-format checks passed. A registrar or database administrator must inspect the source and make the final decision.');
  assert.deepEqual(registrar.result.validation.fieldChecks.map(({ key, status }) => [key, status]), [
    ['student_name', 'matched'], ['issuing_school_name', 'identified'], ['good_moral_context', 'identified'], ['good_moral_layout', 'identified']
  ]);
  assert.deepEqual(registrar.result.validation.advisoryChecks.map(({ key }) => key), ['linked_student_name', 'possible_school_name']);
  assert.equal(registrar.result.validation.automatedCheckOutcome, 'pass');
  assert.equal(registrar.result.validation.formatCheckPassed, true);
  assert.equal(registrar.result.validation.requiresOverrideReason, false);
  assert.deepEqual(registrar.result.decisions[0].verificationChecklist, verificationChecklistItems('good_moral').map(({ label }) => label));
  const validationQuery = registrar.queries.find(({ statement }) => statement.includes('FROM document_validations'));
  assert.ok(validationQuery);
  assert.match(validationQuery.statement, /id = @actorId AND is_active = 1 AND role IN \('registrar', 'database_admin'\)/);
  assert.equal(validationQuery.values.actorId, 7);

  const unknownChecklistVersion = await readAsRole('registrar', { checklistSchemaVersion: 99 });
  assert.deepEqual(unknownChecklistVersion.result.decisions[0].verificationChecklist, [], 'history does not reinterpret an unknown checklist version');

  const attention = await readAsRole('registrar', { linkedNameFound: false });
  assert.equal(attention.result.validation.automatedCheckOutcome, 'attention');
  assert.equal(attention.result.validation.requiresOverrideReason, true);
  const unavailable = await readAsRole('registrar', { resultStatus: 'failed', outcome: 'processor_timeout' });
  assert.equal(unavailable.result.validation.automatedCheckOutcome, 'unavailable');
  const unknownOutcome = await readAsRole('registrar', { outcome: 'future_outcome' });
  assert.equal(unknownOutcome.result.validation.automatedCheckOutcome, 'unavailable');
  assert.equal(unknownOutcome.result.validation.requiresOverrideReason, true);
  const unknownResultStatus = await readAsRole('registrar', { resultStatus: 'valid' });
  assert.equal(unknownResultStatus.result.validation.automatedCheckOutcome, 'unavailable');
  const unsupportedFormat = await readAsRole('registrar', { originalFilename: 'report.exe', mimeType: 'application/octet-stream' });
  assert.equal(unsupportedFormat.result.validation.automatedCheckOutcome, 'attention');
  assert.equal(unsupportedFormat.result.validation.formatCheckPassed, false);
  const summaryWithLegacyAdvisory = await readAsRole('registrar', { extraCheck: true });
  assert.equal(summaryWithLegacyAdvisory.result.validation.automatedCheckOutcome, 'pass', 'legacy advisory fields do not affect the versioned Gemini precheck');
  const emptyOcr = await readAsRole('registrar', { linkedNameFound: false, outcome: 'precheck_attention' });
  assert.equal(emptyOcr.result.validation.automatedCheckOutcome, 'attention');
  const psa = await readAsRole('registrar', { documentType: 'psa_birth_certificate', schoolNameFound: false });
  assert.deepEqual(psa.result.validation.advisoryChecks.map(({ key }) => key), ['linked_student_name']);
  assert.equal(psa.result.validation.automatedCheckOutcome, 'pass', 'PSA checks do not require school-name text');
  assert.equal(psa.result.validation.fieldChecks.length, 1, 'PSA field findings contain only the linked name');

  const reportCard = await readAsRole('registrar', { documentType: 'report_card' });
  assert.equal(reportCard.result.validation.automatedCheckOutcome, 'pass');
  assert.deepEqual(reportCard.result.validation.fieldChecks.map(({ key }) => key), ['student_name']);
  assert.deepEqual(reportCard.result.validation.advisoryChecks.map(({ key }) => key), ['linked_student_name']);
  assert.ok(reportCard.queries.some(({ statement }) => statement.includes('FROM document_validations')),
    'staff can inspect the active report-card precheck result');

  const textOnlyGoodMoral = await readAsRole('registrar', { contextEvidenceFound: false, layoutEvidenceFound: false, outcome: 'precheck_attention' });
  assert.equal(textOnlyGoodMoral.result.validation.automatedCheckOutcome, 'attention', 'name and school values without certificate context do not pass');
  const legacyOcr = await readAsRole('registrar', { legacyOcrOnly: true, outcome: 'extracted', extraCheck: false });
  assert.equal(legacyOcr.result.validation.automatedCheckOutcome, 'unavailable');
  assert.equal(legacyOcr.result.validation.legacyOcrOnly, true);

  const revokedRegistrar = await readAsRole('registrar', { deactivateAfterDocumentRead: true });
  assert.equal(revokedRegistrar.result.validation, null, 'active-role recheck prevents OCR text disclosure after access is revoked');
});

test('student decision history exposes own Good Moral rejection reasons and keeps unrelated decision reasons hidden', async () => {
  for (const finalDecision of ['verified', 'rejected']) {
    const queries = [];
    const pool = {
      request() {
        const values = {};
        return {
          input(name, _type, value) { values[name] = value; return this; },
          async query(statement) {
            queries.push(statement);
            if (statement.startsWith('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'student' }] };
            if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.id = @documentId')) {
              return { recordset: [{
                id: 88, student_id: 44, document_type: 'good_moral', original_filename: 'report.pdf',
                stored_filename: '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf', mime_type: 'application/pdf',
                file_size_bytes: 100, uploaded_by: 7, upload_source: 'student', status: finalDecision === 'verified' ? 'valid' : 'rejected',
                supersedes_document_id: null, created_at: new Date(), student_user_id: 7,
                student_no: 'S-44', first_name: 'Test', middle_name: null, last_name: 'Student', uploader_role: 'student'
              }] };
            }
            if (statement.includes('FROM documents AS history_document')) return { recordset: [] };
            if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.student_id = @studentId')) return { recordset: [] };
            if (statement.includes('FROM document_review_events AS e')) return { recordset: [] };
            if (statement.includes('FROM document_decision_events AS e')) return { recordset: [
              { id: 2, decision_type: finalDecision, reason: finalDecision === 'rejected' ? 'The submitted certificate is unreadable.' : null, verification_checklist_json: null, created_at: new Date(), reviewer_name: null },
              { id: 1, decision_type: 'correction_requested', reason: 'Upload a clearer report card.', created_at: new Date(Date.now() - 1000), reviewer_name: null }
            ] };
            throw new Error(`Unexpected read SQL: ${statement}`);
          }
        };
      }
    };
    const result = await createDocumentService({ getPool: async () => pool, sql: fakeSql() }).getDocument(7, '88');
    assert.equal(result.decisions[0].decision_type, finalDecision);
    assert.equal(result.decisions[0].reason, finalDecision === 'rejected' ? 'The submitted certificate is unreadable.' : null);
    assert.equal(result.decisions[0].reviewer_name, null);
    assert.deepEqual(result.decisions[0].verificationChecklist, [], 'students do not receive stored staff attestations');
    assert.equal(result.decisions[1].reason, 'Upload a clearer report card.');
    const studentDecisionSql = queries.find((statement) => statement.includes('FROM document_decision_events AS e'));
    assert.match(studentDecisionSql, /CASE WHEN e\.decision_type IN \('rejected', 'correction_requested'\)[\s\S]*@documentType NOT IN \('psa_birth_certificate', 'report_card'\) OR @uploadSource = 'student'[\s\S]*THEN e\.reason ELSE NULL END AS reason/);
    assert.doesNotMatch(studentDecisionSql, /AND e\.decision_type = 'correction_requested'/);
    assert.doesNotMatch(studentDecisionSql, /JOIN staff_profiles/);
    assert.match(studentDecisionSql, /CAST\(NULL AS CHAR\(500\)\) AS verification_checklist_json/);
  }
});

test('student PSA decision reasons follow submission origin and own-record access', async () => {
  for (const uploadSource of ['registrar', 'student']) {
    const queries = [];
    const document = {
      id: 88,
      student_id: 44,
      document_type: 'psa_birth_certificate',
      original_filename: 'psa.pdf',
      stored_filename: '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf',
      mime_type: 'application/pdf',
      file_size_bytes: 100,
      uploaded_by: 9,
      upload_source: uploadSource,
      status: 'needs_review',
      supersedes_document_id: null,
      created_at: new Date(),
      student_user_id: 7,
      student_no: 'S-44',
      first_name: 'Test',
      middle_name: null,
      last_name: 'Student',
      uploader_role: 'registrar'
    };
    const pool = {
      request() {
        const values = {};
        return {
          input(name, _type, value) { values[name] = value; return this; },
          async query(statement) {
            queries.push({ statement, values: { ...values } });
            if (statement.startsWith('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'student' }] };
            if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.id = @documentId')) {
              const allowedByOwnRecord = statement.includes('s.user_id = @actorId')
                && statement.includes("d.document_type IN ('good_moral', 'psa_birth_certificate')");
              return { recordset: allowedByOwnRecord ? [{ ...document }] : [] };
            }
            if (statement.includes('FROM documents AS history_document')) {
              return { recordset: [{ id: 91, upload_source: 'registrar' }, { id: 92, upload_source: 'student' }] };
            }
            if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.student_id = @studentId')) return { recordset: [] };
            if (statement.includes('FROM document_review_events AS e')) {
              return { recordset: values.uploadSource === 'student'
                ? [{ id: 2, action_type: 'correction_requested', instruction: 'Upload your corrected PSA.', created_at: new Date(), reviewer_name: null }]
                : [] };
            }
            if (statement.includes('FROM document_decision_events AS e')) return { recordset: [
              { id: 3, decision_type: 'rejected', reason: values.uploadSource === 'student' ? 'The PSA scan is incomplete.' : null, created_at: new Date(), reviewer_name: null },
              { id: 2, decision_type: 'correction_requested', reason: values.uploadSource === 'student' ? 'Upload your corrected PSA.' : null, created_at: new Date(Date.now() - 1000), reviewer_name: null }
            ] };
            throw new Error(`Unexpected read SQL: ${statement}`);
          }
        };
      }
    };

    const result = await createDocumentService({ getPool: async () => pool, sql: fakeSql() }).getDocument(7, '88');
    assert.equal(result.decisions[0].decision_type, 'rejected');
    assert.equal(result.decisions[0].reason, uploadSource === 'student' ? 'The PSA scan is incomplete.' : null);
    assert.equal(result.decisions[1].reason, uploadSource === 'student' ? 'Upload your corrected PSA.' : null);
    assert.equal(result.reviewEvents.length, uploadSource === 'student' ? 1 : 0);
    assert.deepEqual(result.history.map(({ id }) => id), [91, 92], 'the student can see both origins in their own history');
    const documentQuery = queries.find(({ statement }) => statement.includes('WHERE d.id = @documentId'));
    const reviewQuery = queries.find(({ statement }) => statement.includes('FROM document_review_events AS e'));
    const decisionQuery = queries.find(({ statement }) => statement.includes('FROM document_decision_events AS e'));
    assert.match(documentQuery.statement, /s\.user_id = @actorId/);
    assert.doesNotMatch(documentQuery.statement, /d\.upload_source IN \('registrar', 'database_admin'\)/);
    assert.equal(reviewQuery.values.uploadSource, uploadSource);
    assert.match(reviewQuery.statement, /@documentType NOT IN \('psa_birth_certificate', 'report_card'\) OR @uploadSource = 'student'/);
    assert.equal(decisionQuery.values.uploadSource, uploadSource);
    assert.match(decisionQuery.statement, /@documentType NOT IN \('psa_birth_certificate', 'report_card'\) OR @uploadSource = 'student'/);
    assert.match(decisionQuery.statement, /e\.decision_type IN \('rejected', 'correction_requested'\)/);
    const historyQuery = queries.find(({ statement }) => statement.includes('FROM documents AS history_document'));
    assert.match(historyQuery.statement, /history_student\.user_id = @actorId/);
    assert.doesNotMatch(historyQuery.statement, /history_document\.upload_source IN/);
  }
});

test('failed document insert, audit, or transaction commit removes an unreferenced private file', async () => {
  for (const failAt of ['insert', 'audit', 'commit']) {
    const directory = await temporaryDirectory();
    try {
      const harness = transactionHarness({ failAt });
      const service = serviceWithStorage(harness, directory);
      await assert.rejects(service.upload(7, { documentType: 'good_moral' }, makeFile()));
      assert.equal(harness.state.rolledBack, true);
      assert.deepEqual(await fs.readdir(directory), [], `file leaked after ${failAt} failure`);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('failed file cleanup returns a safe storage error without exposing database details', async () => {
  const directory = await temporaryDirectory();
  try {
    const harness = transactionHarness({ failAt: 'insert' });
    const failingFileSystem = {
      ...fs,
      async unlink() { throw new Error('private filesystem path and details'); }
    };
    const service = serviceWithStorage(harness, directory, failingFileSystem, { error() {} });
    await assert.rejects(service.upload(7, { documentType: 'good_moral' }, makeFile()), (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /temporary file could not be removed/);
      assert.doesNotMatch(error.message, /private filesystem|database details/);
      return true;
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('finance and inactive actors are rejected before document writes', async () => {
  const directory = await temporaryDirectory();
  try {
    const finance = transactionHarness({ actorRole: 'finance' });
    await assert.rejects(serviceWithStorage(finance, directory).upload(7, { documentType: 'good_moral', studentId: '44' }, makeFile()), /access is no longer active/);
    assert.equal(finance.state.inserted.length, 0);
    const inactive = transactionHarness({ actorRole: null });
    await assert.rejects(serviceWithStorage(inactive, directory).upload(7, { documentType: 'good_moral' }, makeFile()), /access is no longer active/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('registrar can upload restricted document types and record correction/review events atomically', async () => {
  const directory = await temporaryDirectory();
  try {
    const uploadHarness = transactionHarness({ actorRole: 'registrar' });
    const service = serviceWithStorage(uploadHarness, directory);
    const physicalOnly = transactionHarness({ actorRole: 'registrar' });
    await assert.rejects(serviceWithStorage(physicalOnly, directory).upload(7, { studentId: '22', documentType: 'form_137' }, makeFile()), /physical document status/);
    assert.equal(physicalOnly.state.inserted.length, 0);
    const uploaded = await service.upload(7, { studentId: '22', documentType: 'psa_birth_certificate' }, makeFile());
    assert.equal(uploadHarness.state.inserted[0].values.studentId, 22);
    assert.equal(uploadHarness.state.inserted[0].values.documentType, 'psa_birth_certificate');
    assert.equal(uploadHarness.state.audit.values.action, 'registrar.document_uploaded');
    assert.ok(uploaded.id > 0);
    await assert.rejects(service.upload(7, { studentId: '22', documentType: 'report_card' }, makeFile({ name: 'teacher-report.pdf' })), /Only students may upload a previous-school report-card scan/);
    assert.equal(uploadHarness.state.inserted.length, 1, 'report-card uploads remain student-origin only');

    const reviewHarness = transactionHarness({ actorRole: 'registrar' });
    const reviewService = serviceWithStorage(reviewHarness, directory);
    await reviewService.addReviewEvent(7, '12', 'correction_requested', 'Upload a clearer report card.');
    assert.equal(reviewHarness.state.events[0].values.reviewerId, 7);
    assert.equal(reviewHarness.state.events[0].values.instruction, 'Upload a clearer report card.');
    assert.equal(reviewHarness.state.queries.some(({ statement }) => statement.includes('UPDATE documents')), false, 'recording a correction request does not disturb OCR state');
    assert.equal(reviewHarness.state.audit.values.action, 'registrar.document_correction_requested');
    assert.equal(reviewHarness.state.audit.values.detailsJson.includes('clearer'), false);

    const correctedRestrictedDocument = transactionHarness({
      actorRole: 'registrar', previousDocumentType: 'psa_birth_certificate', correctionAction: 'correction_requested'
    });
    await serviceWithStorage(correctedRestrictedDocument, directory).reupload(7, '12', makeFile({ name: 'corrected.pdf' }));
    assert.equal(correctedRestrictedDocument.state.inserted[0].values.studentId, 44);
    assert.equal(correctedRestrictedDocument.state.inserted[0].values.documentType, 'psa_birth_certificate');
    assert.equal(correctedRestrictedDocument.state.inserted[0].values.supersedesDocumentId, 12);
    assert.equal(correctedRestrictedDocument.state.audit.values.action, 'registrar.document_reuploaded');

    const correctedReportCard = transactionHarness({
      actorRole: 'registrar', previousDocumentType: 'report_card', previousUploadSource: 'registrar', correctionAction: 'correction_requested'
    });
    await assert.rejects(serviceWithStorage(correctedReportCard, directory).reupload(7, '12', makeFile({ name: 'corrected-report.pdf' })), /Document not found/);
    assert.equal(correctedReportCard.state.inserted.length, 0);

    const studentHarness = transactionHarness();
    await assert.rejects(serviceWithStorage(studentHarness, directory).addReviewEvent(7, '12', 'correction_requested', 'Please upload a clearer file.'), /access is no longer active/);
    await assert.rejects(reviewService.addReviewEvent(7, '12', 'review_requested'), /Choose a valid review action/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('registrar and database administrator can only set Form 137 physical statuses, with correction instructions audited', async () => {
  const registrar = transactionHarness({ actorRole: 'registrar' });
  const result = await registrar.service.recordForm137Status(7, '44', 'correction', 'Bring a clearer paper copy to the registrar.');
  assert.deepEqual(result, { studentId: 44, status: 'correction' });
  assert.equal(registrar.state.form137Statuses[0].values.status, 'correction');
  assert.equal(registrar.state.form137Statuses[0].values.instruction, 'Bring a clearer paper copy to the registrar.');
  assert.equal(registrar.state.inserted.length, 0, 'physical status does not create a document upload');
  assert.equal(registrar.state.audit.values.action, 'registrar.form137_status_recorded');
  assert.equal(registrar.state.audit.values.detailsJson.includes('clearer paper copy'), false);

  const verifiedAfterScanFailure = transactionHarness({ actorRole: 'registrar' });
  await verifiedAfterScanFailure.service.recordForm137Status(7, '44', 'verified', '');
  assert.equal(verifiedAfterScanFailure.state.form137Statuses[0].values.status, 'verified');
  assert.equal(verifiedAfterScanFailure.state.form137Statuses[0].values.instruction, null);
  assert.equal(verifiedAfterScanFailure.state.inserted.length, 0, 'a physical status decision stores no scan or OCR record');

  const missingInstruction = transactionHarness({ actorRole: 'database_admin' });
  await assert.rejects(missingInstruction.service.recordForm137Status(7, '44', 'correction'), /instruction when requesting/);
  assert.equal(missingInstruction.state.form137Statuses.length, 0);
  await assert.rejects(missingInstruction.service.recordForm137Status(7, '44', 'unknown'), /valid Form 137 status/);

  const student = transactionHarness({ actorRole: 'student' });
  await assert.rejects(student.service.recordForm137Status(7, '44', 'received'), /access is no longer active/);
});

test('registrar and database administrator record separate previous-school report-card paper statuses with audited history', async () => {
  const registrar = transactionHarness({ actorRole: 'registrar' });
  const result = await registrar.service.recordPreviousSchoolReportCardPhysicalStatus(7, '44', 'correction', 'Bring a clearer paper copy.');
  assert.deepEqual(result, { studentId: 44, status: 'correction' });
  assert.equal(registrar.state.previousSchoolReportCardStatuses[0].values.status, 'correction');
  assert.equal(registrar.state.previousSchoolReportCardStatuses[0].values.instruction, 'Bring a clearer paper copy.');
  assert.equal(registrar.state.inserted.length, 0, 'physical paper tracking does not create a digital document or grade');
  assert.equal(registrar.state.audit.values.action, 'registrar.previous_school_report_card_physical_status_recorded');
  assert.equal(registrar.state.audit.values.entityId, '44');
  assert.equal(registrar.state.audit.values.detailsJson.includes('clearer paper copy'), false, 'staff notes are not copied to the audit summary');

  const databaseAdmin = transactionHarness({ actorRole: 'database_admin' });
  await databaseAdmin.service.recordPreviousSchoolReportCardPhysicalStatus(7, '44', 'rejected', '');
  assert.equal(databaseAdmin.state.previousSchoolReportCardStatuses[0].values.status, 'rejected');
  assert.equal(databaseAdmin.state.audit.values.action, 'database_admin.previous_school_report_card_physical_status_recorded');

  const invalidStatus = transactionHarness({ actorRole: 'registrar' });
  await assert.rejects(invalidStatus.service.recordPreviousSchoolReportCardPhysicalStatus(7, '44', 'unknown'), /valid previous-school report-card paper status/);
  const missingCorrectionNote = transactionHarness({ actorRole: 'registrar' });
  await assert.rejects(missingCorrectionNote.service.recordPreviousSchoolReportCardPhysicalStatus(7, '44', 'correction'), /note when requesting/);
  const student = transactionHarness({ actorRole: 'student' });
  await assert.rejects(student.service.recordPreviousSchoolReportCardPhysicalStatus(7, '44', 'received'), /access is no longer active/);
  const rollback = transactionHarness({ actorRole: 'registrar', failAt: 'audit' });
  await assert.rejects(rollback.service.recordPreviousSchoolReportCardPhysicalStatus(7, '44', 'received'), /database details are private/);
  assert.equal(rollback.state.previousSchoolReportCardStatuses.length, 0, 'event insertion rolls back if its audit cannot be recorded');
});

test('student physical report-card status is ownership-scoped and hides staff notes', async () => {
  const calls = [];
  let role = 'student';
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('FROM users WHERE id = @actorId')) return { recordset: [{ id: 7, role }] };
          return { recordset: [{ status: 'received', created_at: new Date('2026-09-28T00:00:00Z') }] };
        }
      };
    }
  };
  const service = createDocumentService({ getPool: async () => pool, sql: fakeSql() });
  const status = await service.getOwnPreviousSchoolReportCardPhysicalStatus(7);
  assert.deepEqual(status, { status: 'received', created_at: new Date('2026-09-28T00:00:00Z') });
  assert.match(calls[1].statement, /s\.user_id = @actorId/);
  assert.match(calls[1].statement, /u\.role = 'student'/);
  assert.doesNotMatch(calls[1].statement, /instruction|recorded_by/);
  role = 'registrar';
  await assert.rejects(service.getOwnPreviousSchoolReportCardPhysicalStatus(7), /Student document access is required/);
});

test('staff document workspace keeps physical report-card paper events separate from Form 137 and digital uploads', async () => {
  const statements = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          statements.push(statement);
          if (statement.startsWith('SELECT id, role FROM users WHERE id = @actorId')) return { recordset: [{ id: 7, role: 'registrar' }] };
          if (statement.includes('FROM students AS s WHERE s.id = @studentId')) {
            return { recordset: [{ id: 44, student_no: 'S-44', first_name: 'Synthetic', last_name: 'Learner', status: 'active' }] };
          }
          if (statement.includes('FROM previous_school_report_card_status_events AS e')) {
            return { recordset: [{ id: 8, status: 'received', instruction: 'Paper copy received.', recorded_by_name: 'Registrar' }] };
          }
          return { recordset: [] };
        }
      };
    }
  };
  const service = createDocumentService({ getPool: async () => pool, sql: fakeSql() });
  const workspace = await service.getStudentDocuments(7, '44');
  assert.equal(workspace.previousSchoolReportCardPhysicalStatus.status, 'received');
  assert.equal(workspace.previousSchoolReportCardPhysicalStatusHistory[0].instruction, 'Paper copy received.');
  assert.equal(workspace.form137Status.status, 'not_recorded');
  assert.match(statements.find((statement) => statement.includes('previous_school_report_card_status_events')), /student_id = @studentId/);
  assert.match(statements.find((statement) => statement.includes('form137_status_events')), /form137_status_events/);
  assert.match(statements.find((statement) => statement.includes('FROM documents AS d')), /document_type/);
});

test('manual decisions require completed OCR, append history, and only verification sets valid', async () => {
  const missingChecklist = transactionHarness({ actorRole: 'registrar' });
  await assert.rejects(
    missingChecklist.service.decideDocument(7, '12', 'verified', 'I inspected this source.'),
    /Confirm every applicable source-inspection checklist item/
  );
  assert.equal(missingChecklist.state.decisions.length, 0);
  assert.equal(missingChecklist.state.documentStatus, 'needs_review');
  assert.equal(missingChecklist.state.rolledBack, true);

  const tamperedChecklist = transactionHarness({ actorRole: 'registrar' });
  await assert.rejects(tamperedChecklist.service.decideDocument(7, '12', 'verified', 'I inspected this source.', {
    ...confirmedChecklist('good_moral'), schoolNameLegible: 'no'
  }), /Confirm every applicable source-inspection checklist item/);
  assert.equal(tamperedChecklist.state.decisions.length, 0);

  const warning = transactionHarness({
    actorRole: 'registrar',
    validationJson: JSON.stringify({ advisoryChecks: [{ key: 'linked_student_name', found: false }] })
  });
  await assert.rejects(warning.service.decideDocument(7, '12', 'verified', '', confirmedChecklist('good_moral')), /reason to verify/);
  assert.equal(warning.state.decisions.length, 0);

  const verified = await warning.service.decideDocument(7, '12', 'verified', 'I inspected the source file and confirmed the student details.', confirmedChecklist('good_moral'));
  assert.deepEqual(verified, { id: 12, status: 'valid', decision: 'verified' });
  assert.equal(warning.state.documentStatus, 'valid');
  assert.equal(warning.state.decisions.length, 1);
  assert.deepEqual(JSON.parse(warning.state.decisions[0].values.verificationChecklistJson), {
    schemaVersion: 2,
    linkedStudentNameLegible: true,
    schoolNameLegible: true,
    goodMoralContextLegible: true,
    selectedDocumentTypeCorrect: true,
    allSubmittedPagesReadableComplete: true
  });
  assert.match(warning.state.queries.find(({ statement }) => statement.includes('FROM documents AS d') && statement.includes('v_document_latest_validation')).statement, /FOR UPDATE/);
  assert.equal(warning.state.audit.values.action, 'registrar.document_review_verified');
  assert.equal(warning.state.audit.values.detailsJson.includes('confirmed the student details'), false);
  await assert.rejects(warning.service.decideDocument(7, '12', 'rejected', 'Duplicate'), /finish before staff review/);

  const correction = transactionHarness({ actorRole: 'database_admin' });
  await correction.service.decideDocument(7, '12', 'correction_requested', 'Upload a clearer report card.');
  assert.equal(correction.state.decisions[0].values.decisionType, 'correction_requested');
  assert.equal(correction.state.documentStatus, 'needs_review');
  assert.equal(correction.state.audit.values.action, 'database_admin.document_review_correction_requested');

  const rejectedWithoutPrecheck = transactionHarness({ actorRole: 'registrar', ocrResultStatus: null, validationJson: null });
  const rejected = await rejectedWithoutPrecheck.service.decideDocument(7, '12', 'rejected', 'The submitted file is not an official certificate.');
  assert.deepEqual(rejected, { id: 12, status: 'rejected', decision: 'rejected' });
  assert.equal(rejectedWithoutPrecheck.state.documentStatus, 'rejected');
  assert.equal(rejectedWithoutPrecheck.state.decisions[0].values.decisionType, 'rejected');
  assert.equal(rejectedWithoutPrecheck.state.audit.values.action, 'registrar.document_review_rejected');

  const correctionWithoutPrecheck = transactionHarness({ actorRole: 'registrar', ocrResultStatus: null, validationJson: null });
  await correctionWithoutPrecheck.service.decideDocument(7, '12', 'correction_requested', 'Submit a clearer scan.');
  assert.equal(correctionWithoutPrecheck.state.documentStatus, 'needs_review');
  assert.equal(correctionWithoutPrecheck.state.decisions[0].values.decisionType, 'correction_requested');

  const auditFailure = transactionHarness({ actorRole: 'registrar', failAt: 'audit' });
  await assert.rejects(auditFailure.service.decideDocument(
    7, '12', 'verified', 'I inspected the source.', confirmedChecklist('good_moral')
  ));
  assert.equal(auditFailure.state.rolledBack, true);
  assert.equal(auditFailure.state.documentStatus, 'needs_review');
  assert.equal(auditFailure.state.decisions.length, 0, 'checklist decision is rolled back when its audit event cannot be recorded');
  assert.equal(auditFailure.state.audit, undefined);
});

test('active report cards use a bounded name/file-format precheck and staff-only decision checklist', async () => {
  const passingPrecheck = JSON.stringify({
    stage: 'gemini_precheck', precheckVersion: 2, outcome: 'precheck_pass', fileFormatPassed: true,
    gemini: { status: 'extracted', code: 'extracted', fields: { studentName: 'Test Student' }, studentNameMatchesLinkedRecord: true }
  });
  const retryablePrecheck = JSON.stringify({
    stage: 'gemini_precheck', precheckVersion: 2, outcome: 'gemini_unavailable', fileFormatPassed: true,
    gemini: { status: 'unavailable', code: 'timeout', fields: null }
  });
  const checklist = confirmedChecklist('report_card');
  assert.deepEqual(Object.keys(checklist), [
    'reportCardIdentityMatches', 'reportCardPeriodIdentified', 'selectedDocumentTypeCorrect', 'allSubmittedPagesReadableComplete'
  ]);

  const missingChecklist = transactionHarness({
    actorRole: 'registrar', previousDocumentType: 'report_card', validationJson: passingPrecheck
  });
  await assert.rejects(missingChecklist.service.decideDocument(7, '12', 'verified'), /Confirm every applicable source-inspection checklist item/);
  assert.equal(missingChecklist.state.decisions.length, 0);

  const archived = transactionHarness({
    actorRole: 'registrar', previousDocumentType: 'report_card', previousIsLegacyArchive: true, ocrResultStatus: null, validationJson: null
  });
  await assert.rejects(archived.service.decideDocument(7, '12', 'verified', '', checklist), /Historical report cards are read-only/);
  assert.equal(archived.state.decisions.length, 0);

  const student = transactionHarness({ actorRole: 'student', previousDocumentType: 'report_card', ocrResultStatus: null, validationJson: null });
  await assert.rejects(student.service.decideDocument(7, '12', 'verified', '', checklist), /access is no longer active/);
  assert.equal(student.state.decisions.length, 0);

  const manualVerification = transactionHarness({
    actorRole: 'registrar', previousDocumentType: 'report_card', validationJson: passingPrecheck
  });
  const result = await manualVerification.service.decideDocument(7, '12', 'verified', '', checklist);
  assert.deepEqual(result, { id: 12, status: 'valid', decision: 'verified' });
  assert.deepEqual(JSON.parse(manualVerification.state.decisions[0].values.verificationChecklistJson), {
    schemaVersion: 2,
    reportCardIdentityMatches: true,
    reportCardPeriodIdentified: true,
    selectedDocumentTypeCorrect: true,
    allSubmittedPagesReadableComplete: true
  });
  assert.equal(manualVerification.state.queries.some(({ statement }) => statement.includes('FROM teacher_grade_submissions') || statement.includes('UPDATE student_grades')), false);
  assert.equal(manualVerification.state.audit.values.action, 'registrar.document_review_verified');

  const correction = transactionHarness({ actorRole: 'database_admin', previousDocumentType: 'report_card', validationJson: passingPrecheck });
  await correction.service.decideDocument(7, '12', 'correction_requested', 'Upload a clearer report card.');
  assert.equal(correction.state.decisions[0].values.decisionType, 'correction_requested');
  assert.equal(correction.state.documentStatus, 'needs_review');

  const rejected = transactionHarness({ actorRole: 'registrar', previousDocumentType: 'report_card', validationJson: passingPrecheck });
  await rejected.service.decideDocument(7, '12', 'rejected', 'This copy is incomplete.');
  assert.equal(rejected.state.documentStatus, 'rejected');

  const retry = transactionHarness({ actorRole: 'registrar', previousDocumentType: 'report_card', validationJson: retryablePrecheck });
  assert.deepEqual(await retry.service.requestPrecheckRetry(7, '12'), { id: 12, status: 'pending' });
  assert.match(retry.state.queries.find(({ statement }) => statement.includes("SET status = 'pending'")).statement,
    /document_type = 'report_card' AND is_legacy_archive = 0/);

  const missingPrecheck = transactionHarness({
    actorRole: 'registrar', previousDocumentType: 'report_card', ocrResultStatus: null, validationJson: null
  });
  await assert.rejects(missingPrecheck.service.decideDocument(7, '12', 'rejected', 'Invalid file.'), /precheck result must be recorded/);
  assert.equal(missingPrecheck.state.decisions.length, 0);
});

test('staff can permanently delete Good Moral and PSA submissions with their private files and history', async () => {
  const directory = await temporaryDirectory();
  try {
    for (const [index, documentType] of ['good_moral', 'psa_birth_certificate'].entries()) {
      const storedFilename = `${crypto.randomUUID()}.pdf`;
      const filePath = path.join(directory, storedFilename);
      await fs.writeFile(filePath, Buffer.from('%PDF-1.7\nsynthetic'), { mode: 0o600 });
      const harness = transactionHarness({ actorRole: 'registrar', previousDocumentType: documentType, storedFilename });
      const service = serviceWithStorage(harness, directory, fs);
      const result = await service.deleteDocument(7, String(12 + index));

      assert.deepEqual(result, { id: 12 + index, fileDeleted: true });
      assert.equal(harness.state.documentExists, false);
      assert.deepEqual(harness.state.deletedRows, ['document_validations', 'document_review_events', 'document_decision_events']);
      assert.equal(harness.state.audit.values.action, 'registrar.document_deleted');
      assert.deepEqual(await fs.readdir(directory), []);
      for (const call of harness.state.queries.filter(({ statement }) => statement.startsWith('DELETE FROM '))) {
        assert.equal(call.values.documentId, 12 + index);
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('document deletion is staff-only, excludes archived types and preserves earlier versions with corrections', async () => {
  for (const actorRole of ['student', 'finance']) {
    const denied = transactionHarness({ actorRole });
    await assert.rejects(denied.service.deleteDocument(7, '12'), /access is no longer active/);
    assert.equal(denied.state.documentExists, true);
    assert.deepEqual(denied.state.deletedRows, []);
  }

  for (const documentType of ['report_card', 'form_137']) {
    const archived = transactionHarness({ actorRole: 'registrar', previousDocumentType: documentType, previousIsLegacyArchive: documentType === 'report_card' });
    await assert.rejects(archived.service.deleteDocument(7, '12'), /Only active Good Moral, PSA, or report-card submissions/);
    assert.equal(archived.state.documentExists, true);
    assert.deepEqual(archived.state.deletedRows, []);
  }

  const parent = transactionHarness({ actorRole: 'registrar', hasCorrectedSubmission: true });
  await assert.rejects(parent.service.deleteDocument(7, '12'), /Delete the latest corrected submission before deleting this earlier version/);
  assert.equal(parent.state.documentExists, true);
  assert.deepEqual(parent.state.deletedRows, []);
});

test('document deletion restores its file and rolls back history removal when the database transaction fails', async () => {
  const directory = await temporaryDirectory();
  const storedFilename = '5dd677e1-87fb-4214-a7c1-27aca233ae1f.pdf';
  const filePath = path.join(directory, storedFilename);
  try {
    await fs.writeFile(filePath, Buffer.from('%PDF-1.7\nsynthetic'), { mode: 0o600 });
    const harness = transactionHarness({ actorRole: 'registrar', failAt: 'audit', storedFilename });
    const service = serviceWithStorage(harness, directory, fs);
    await assert.rejects(service.deleteDocument(7, '12'));

    assert.equal(harness.state.rolledBack, true);
    assert.equal(harness.state.documentExists, true);
    assert.deepEqual(harness.state.deletedRows, []);
    assert.deepEqual(await fs.readdir(directory), [storedFilename]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('verification requires and stores the applicable checklist for each digital document type', async () => {
  for (const role of ['registrar', 'database_admin']) {
    for (const documentType of ['good_moral', 'psa_birth_certificate']) {
      const allowed = transactionHarness({ actorRole: role, previousDocumentType: documentType });
      const checklist = confirmedChecklist(documentType);
      await allowed.service.decideDocument(7, '12', 'verified', 'I inspected the submitted source.', checklist);
      const parsedChecklist = JSON.parse(allowed.state.decisions[0].values.verificationChecklistJson);
      assert.equal(parsedChecklist.schemaVersion, 2, `${role} ${documentType} records the current checklist schema version`);
      assert.equal(parsedChecklist.linkedStudentNameLegible, true, `${role} ${documentType} records linked-name inspection`);
      assert.equal(parsedChecklist.selectedDocumentTypeCorrect, true, `${role} ${documentType} records type inspection`);
      assert.equal(parsedChecklist.allSubmittedPagesReadableComplete, true, `${role} ${documentType} records page inspection`);
      assert.equal(Object.hasOwn(parsedChecklist, 'schoolNameLegible'), documentType !== 'psa_birth_certificate');
      assert.equal(Object.hasOwn(parsedChecklist, 'goodMoralContextLegible'), documentType === 'good_moral');
      assert.equal(allowed.state.audit.values.action, `${role}.document_review_verified`);
    }
  }

  for (const role of ['student', 'finance']) {
    const denied = transactionHarness({ actorRole: role });
    await assert.rejects(denied.service.decideDocument(7, '12', 'verified', 'Reviewed', confirmedChecklist('good_moral')), /access is no longer active/);
    assert.equal(denied.state.decisions.length, 0);
    assert.equal(denied.state.rolledBack, true);
  }
});

test('OCR failure and legacy OCR without advisory results require an override reason', async () => {
  const failed = transactionHarness({
    actorRole: 'registrar', documentStatus: 'failed', ocrResultStatus: 'failed',
    validationJson: JSON.stringify({ outcome: 'processor_unavailable' })
  });
  await assert.rejects(failed.service.decideDocument(7, '12', 'verified', '', confirmedChecklist('good_moral')), /reason to verify/);
  await failed.service.decideDocument(7, '12', 'verified', 'I inspected the original source despite OCR failure.', confirmedChecklist('good_moral'));
  assert.equal(failed.state.documentStatus, 'valid');

  const legacy = transactionHarness({
    actorRole: 'registrar', validationJson: JSON.stringify({ stage: 'ocr', outcome: 'extracted' })
  });
  await assert.rejects(legacy.service.decideDocument(7, '12', 'verified', '', confirmedChecklist('good_moral')), /reason to verify/);
  await legacy.service.decideDocument(7, '12', 'verified', 'I inspected the source; this legacy OCR result has no advisory checks.', confirmedChecklist('good_moral'));
  assert.equal(legacy.state.documentStatus, 'valid');

  const partialLegacy = transactionHarness({
    actorRole: 'registrar',
    validationJson: JSON.stringify({
      stage: 'ocr', outcome: 'extracted',
      advisoryChecks: [{ key: 'linked_student_name', found: true }]
    })
  });
  await assert.rejects(partialLegacy.service.decideDocument(7, '12', 'verified', '', confirmedChecklist('good_moral')), /reason to verify/);
  await partialLegacy.service.decideDocument(7, '12', 'verified', 'I inspected the source; the legacy advisory set is incomplete.', confirmedChecklist('good_moral'));
  assert.equal(partialLegacy.state.documentStatus, 'valid');

  const malformedCandidates = transactionHarness({
    actorRole: 'registrar',
    validationJson: JSON.stringify({ advisoryChecks: [
      { key: 'linked_student_name', found: true },
      { key: 'possible_school_name', found: true }
    ] })
  });
  await assert.rejects(malformedCandidates.service.decideDocument(7, '12', 'verified', '', confirmedChecklist('good_moral')), /reason to verify/);
  await malformedCandidates.service.decideDocument(7, '12', 'verified', 'I inspected the source; candidate text is missing from the stored OCR summary.', confirmedChecklist('good_moral'));
  assert.equal(malformedCandidates.state.documentStatus, 'valid');

  const mismatchedFormat = transactionHarness({
    actorRole: 'registrar',
    originalFilename: 'document.png',
    validationJson: JSON.stringify({ advisoryChecks: [
      { key: 'linked_student_name', found: true },
      { key: 'possible_school_name', found: true, candidates: ['Ark Academy'] }
    ] })
  });
  await assert.rejects(mismatchedFormat.service.decideDocument(7, '12', 'verified', '', confirmedChecklist('good_moral')), /reason to verify/);
  await mismatchedFormat.service.decideDocument(7, '12', 'verified', 'I inspected the file despite its extension mismatch.', confirmedChecklist('good_moral'));
  assert.equal(mismatchedFormat.state.documentStatus, 'valid');

  const unknownOutcome = transactionHarness({
    actorRole: 'registrar',
    validationJson: JSON.stringify({ outcome: 'future_outcome', advisoryChecks: [
      { key: 'linked_student_name', found: true },
      { key: 'possible_school_name', found: true, candidates: ['Ark Academy'] }
    ] })
  });
  await assert.rejects(unknownOutcome.service.decideDocument(7, '12', 'verified', '', confirmedChecklist('good_moral')), /reason to verify/);
  await unknownOutcome.service.decideDocument(7, '12', 'verified', 'I inspected the source because the stored automated outcome is unsupported.', confirmedChecklist('good_moral'));
  assert.equal(unknownOutcome.state.documentStatus, 'valid');

  const processing = transactionHarness({ actorRole: 'registrar', documentStatus: 'processing' });
  await assert.rejects(processing.service.decideDocument(7, '12', 'verified', 'Reviewed', confirmedChecklist('good_moral')), /finish before staff review/);
  assert.equal(processing.state.decisions.length, 0, 'a staff decision cannot race an active precheck lease');
  const noResult = transactionHarness({ actorRole: 'registrar', ocrResultStatus: null, validationJson: null });
  await assert.rejects(noResult.service.decideDocument(7, '12', 'verified', 'Reviewed', confirmedChecklist('good_moral')), /precheck result must be recorded/);
  assert.equal(noResult.state.decisions.length, 0);
});

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function csrfFromHtml(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'expected CSRF token');
  return match[1];
}

function blockedNewOriginalTypes(documents) {
  const latestByType = new Map();
  for (const document of documents) {
    if (!latestByType.has(document.document_type)) latestByType.set(document.document_type, document);
  }
  return [...latestByType]
    .filter(([, document]) => document.status !== 'rejected')
    .map(([documentType]) => documentType);
}

function sessionCookie(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'expected session cookie');
  return cookie.split(';', 1)[0];
}

function authPool(users) {
  return async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          if (statement.includes('WHERE email = @email')) {
            const user = users.find((candidate) => candidate.email === values.email);
            return { recordset: user ? [{ ...user }] : [] };
          }
          if (statement.includes('WHERE id = @userId')) {
            const user = users.find((candidate) => candidate.id === values.userId);
            return { recordset: user ? [{ ...user, updated_at_fingerprint: '' }] : [] };
          }
          throw new Error(`Unexpected auth SQL: ${statement}`);
        }
      };
    }
  });
}

async function login(baseUrl, email) {
  const loginPage = await fetch(`${baseUrl}/login`);
  const anonymousCookie = sessionCookie(loginPage);
  const csrfToken = csrfFromHtml(await loginPage.text());
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: anonymousCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfToken, email, password: 'Correct-Horse-Battery-12' })
  });
  assert.equal(response.status, 303);
  return sessionCookie(response);
}

test('HTTP document routes enforce role matrix and CSRF before writes', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const users = ['student', 'registrar', 'finance', 'database_admin', 'teacher'].map((role, index) => ({
    id: index + 1,
    email: `${role}@example.edu`,
    password_hash: passwordHash,
    role,
    is_active: true
  }));
  const calls = [];
  const processingCalls = [];
  const scanCalls = [];
  const decisionCalls = [];
  const retryCalls = [];
  const deleteCalls = [];
  const uploadedBuffers = [];
  const scanBuffers = [];
  let listedDocuments = [];
  let reportCardSummary = {
    document_type: 'report_card', submitted_count: 3, awaiting_review_count: 1,
    processing_count: 0, review_required_count: 1, correction_requested_count: 1,
    verified_count: 0, rejected_count: 0
  };
  const physicalWorkspaceCalls = [];
  const documentService = {
    async listDocuments(actorId) {
      calls.push(['list', actorId]);
      return {
        documents: listedDocuments, searchTerm: '', isStaff: actorId !== 1,
        blockedNewOriginalTypes: blockedNewOriginalTypes(listedDocuments),
        statusSummary: actorId === 1 ? [] : [reportCardSummary],
        form137Status: { status: 'not_recorded', instruction: null, created_at: null }
      };
    },
    async listPhysicalRequirements(actorId, searchTerm, page) {
      physicalWorkspaceCalls.push([actorId, searchTerm, page]);
      return {
        students: [{
          id: 44, student_no: 'SHS-2026-0321', lrn: '123456789012', first_name: 'Maria', middle_name: null,
          last_name: 'Santos', suffix: null, form137_status: 'received',
          form137_updated_at: new Date('2026-09-28T00:00:00Z'), paper_report_card_status: 'correction',
          paper_report_card_updated_at: new Date('2026-09-27T00:00:00Z'), instruction: 'Staff-only note must not appear here.'
        }],
        searchTerm: searchTerm || '', totalStudents: 51, page: Number(page || 1), pageSize: 25, totalPages: 3
      };
    },
    async getOwnPreviousSchoolReportCardPhysicalStatus(actorId) {
      calls.push(['own-paper-status', actorId]);
      return { status: 'received', created_at: new Date('2026-09-28T00:00:00Z') };
    },
    async getStudentDocuments(actorId, studentId) {
      calls.push(['student', actorId, studentId]);
      return {
        student: { id: studentId, student_no: 'S-1', first_name: 'Test', last_name: 'Student' },
        documents: listedDocuments, blockedNewOriginalTypes: blockedNewOriginalTypes(listedDocuments),
        form137Status: { status: 'not_recorded', instruction: null, created_at: null }, form137StatusHistory: [],
        previousSchoolReportCardPhysicalStatus: { status: 'correction', instruction: 'Staff-only paper note: bring a clearer copy.', created_at: new Date('2026-09-27T00:00:00Z') },
        previousSchoolReportCardPhysicalStatusHistory: [{ status: 'correction', instruction: 'Staff-only paper note: bring a clearer copy.', recorded_by_name: 'Registrar', created_at: new Date('2026-09-27T00:00:00Z') }]
      };
    },
    async recordPreviousSchoolReportCardPhysicalStatus(actorId, studentId, status, instruction) {
      calls.push(['previous-school-paper-status', actorId, studentId, status, instruction]);
      return { studentId: Number(studentId), status };
    },
    async upload(actorId, body, file) {
      if (body.documentType === 'form_137') throw new DocumentServiceError('Form 137 is tracked as a physical status only.');
      if (body.documentType === 'report_card' && actorId !== 1) {
        throw new DocumentServiceError('Only students may upload report cards through their own linked account.', 403);
      }
      if (actorId === 1 && !['good_moral', 'psa_birth_certificate', 'report_card'].includes(body.documentType)) {
        throw new DocumentServiceError('Students may upload Good Moral Certificates, PSA birth certificates, and report cards for their own record.', 403);
      }
      if (Buffer.isBuffer(file?.buffer)) uploadedBuffers.push(file.buffer);
      calls.push(['upload', actorId, body.documentType, file?.originalname]);
      const id = actorId !== 1 ? 18 : body.documentType === 'psa_birth_certificate' ? 23 : body.documentType === 'report_card' ? 27 : 15;
      return { id, status: 'pending' };
    },
    async reupload(actorId, documentId, file) {
      if (documentId === '24' && actorId === 1) throw new DocumentServiceError('Document not found.', 404);
      if (documentId === '24') throw new DocumentServiceError('Historical report cards are read-only archive records.', 409);
      calls.push(['reupload', actorId, documentId, file?.originalname]);
      return { id: actorId === 1 ? 17 : 19 };
    },
    async decideDocument(...args) {
      decisionCalls.push(args);
      return { id: Number(args[1]), decision: args[2], status: args[2] === 'verified' ? 'valid' : 'rejected' };
    },
    async requestPrecheckRetry(actorId, documentId) {
      retryCalls.push([actorId, documentId]);
      return { id: Number(documentId), status: 'pending' };
    },
    async deleteDocument(actorId, documentId) {
      deleteCalls.push([actorId, documentId]);
      return { id: Number(documentId), fileDeleted: true };
    },
    async getDocument(actorId, documentId) {
      calls.push(['detail', actorId, documentId]);
      const numericDocumentId = Number(documentId);
      const isHistoricalForm137 = numericDocumentId === 22;
      const isRetryablePrecheck = numericDocumentId === 25;
      const isRestrictedDocumentType = numericDocumentId === 16 || isHistoricalForm137;
      const isStudentPsa = numericDocumentId === 23;
      const isReportCard = numericDocumentId === 24 || numericDocumentId === 27;
      const isActiveReportCard = numericDocumentId === 27;
      const isArchivedReportCard = numericDocumentId === 24;
      const finalDecision = numericDocumentId === 20 || numericDocumentId === 26 ? 'rejected' : 'verified';
      const hasFinalDecision = [20, 21, 26].includes(numericDocumentId);
      if (actorId === 1 && (isRestrictedDocumentType || isArchivedReportCard)) return null;
      return {
        id: numericDocumentId, student_id: 44, student_user_id: 1, student_no: 'S-1',
        first_name: 'Test', middle_name: null, last_name: 'Student', document_type: isHistoricalForm137 ? 'form_137' : isRestrictedDocumentType || isStudentPsa ? 'psa_birth_certificate' : isReportCard ? 'report_card' : 'good_moral',
        original_filename: 'moral.pdf', stored_filename: 'opaque-stored-name.pdf', mime_type: 'application/pdf',
        file_size_bytes: 1000, uploaded_by: isRestrictedDocumentType ? 2 : 1, uploader_role: isRestrictedDocumentType ? 'registrar' : 'student', upload_source: isRestrictedDocumentType ? 'registrar' : 'student',
        status: numericDocumentId === 20 || numericDocumentId === 26 ? 'rejected' : numericDocumentId === 21 ? 'valid' : 'needs_review', supersedes_document_id: null, created_at: new Date(),
        history: [{ id: numericDocumentId, original_filename: 'moral.pdf', mime_type: 'application/pdf', status: 'needs_review', supersedes_document_id: null, created_at: new Date() }],
        reviewEvents: [{ id: 1, action_type: 'correction_requested', instruction: 'Upload a clearer file <script>alert(1)</script>', created_at: new Date(), reviewer_name: 'Registrar' }],
        validation: actorId === 1 || isHistoricalForm137 ? null : isActiveReportCard ? {
          processor: 'Gemini field extraction',
          legacyOcrOnly: false,
          result_status: 'needs_review',
          automatedCheckOutcome: 'pass',
          formatCheckPassed: true,
          created_at: new Date(),
          message: 'The linked student-name and supported file-format checks passed. Staff must inspect the source.',
          fieldChecks: [{ label: 'Gemini-extracted student name', value: 'Test Student', status: 'matched' }],
          requiresOverrideReason: false,
          canRetryPrecheck: false,
          precheckRetriesRemaining: 0
        } : {
          processor: isRetryablePrecheck ? 'Gemini field extraction' : 'Legacy OCR-only result',
          legacyOcrOnly: !isRetryablePrecheck,
          extracted_text: '<img src=x onerror=alert(1)>',
          result_status: 'needs_review',
          automatedCheckOutcome: isRetryablePrecheck ? 'unavailable' : 'attention',
          formatCheckPassed: true,
          created_at: new Date(),
          message: isRetryablePrecheck ? 'Gemini field extraction is unavailable. Staff source inspection is required.' : 'OCR text was extracted. Advisory checks are available; registrar or database administrator source inspection is required.',
          advisoryChecks: [
            { key: 'linked_student_name', label: 'Linked student name appears in the extracted text', found: false },
            { key: 'possible_school_name', label: 'Possible school name', found: true, candidates: ['Possible Academy'] }
          ],
          requiresOverrideReason: true,
          canRetryPrecheck: isRetryablePrecheck,
          precheckRetriesRemaining: isRetryablePrecheck ? 2 : 0
        },
        decisions: hasFinalDecision ? [
          { id: 2, decision_type: finalDecision, reason: numericDocumentId === 20 ? 'The submitted certificate is unreadable <script>alert(1)</script>.' : numericDocumentId === 26 ? '   ' : null, created_at: new Date(), reviewer_name: null },
          { id: 1, decision_type: 'correction_requested', reason: 'Upload a clearer file.', created_at: new Date(Date.now() - 1000), reviewer_name: null }
        ] : [],
        isStaff: actorId !== 1,
        isArchivedReportCard,
        is_legacy_archive: isArchivedReportCard ? 1 : 0
      };
    },
    async recordForm137Status(actorId, studentId, status, instruction) {
      calls.push(['form137', actorId, studentId, status, instruction]);
      return { studentId, status };
    }
  };
  const app = createApp({
    databasePool: authPool(users),
    environment: { nodeEnv: 'development', devPasswordOnlyLogin: true, sessionSecret: 'phase-eight-document-http-test-secret' },
    documentService,
    documentProcessingService: {
      schedulePendingProcessing() { processingCalls.push('scheduled'); }
    },
    form137ScanService: {
      async scan(actorId, studentId, file) {
        if (Buffer.isBuffer(file?.buffer)) scanBuffers.push(file.buffer);
        scanCalls.push(['scan', actorId, studentId, file?.originalname]);
        if (scanCalls.length === 1) {
          return {
            status: 'completed',
            message: 'Gemini field suggestions are ready for staff inspection.',
            suggestions: [
              { key: 'linked_student_name', label: 'Linked student name appears in the scanned text', found: true },
              { key: 'possible_school_name', label: 'Possible school name', found: true, candidates: ['Academy <script>alert(1)</script>'] }
            ]
          };
        }
        return { status: 'failed', message: 'Gemini field extraction timed out. Inspect the physical paper and record its status manually.', suggestions: [] };
      }
    },
    physicalChecklistService: {
      async getStudentChecklist(_actorId, studentId) {
        return {
          student: { id: studentId, student_no: 'SHS-2026-0321', first_name: 'Maria', last_name: 'Santos', requestedBy: 'registrar' },
          requirements: [], history: [], additionalItems: [],
          summary: { requiredCount: 9, completeCount: 2 }
        };
      },
      async getStudentSummaries(_actorId, studentIds) {
        return new Map(studentIds.map((studentId) => [Number(studentId), { required_count: 9, completed_count: 2 }]));
      }
    }
  });

  await withServer(app, async (baseUrl) => {
    const studentCookie = await login(baseUrl, 'student@example.edu');
    assert.equal((await fetch(`${baseUrl}/documents/physical`, { headers: { cookie: studentCookie } })).status, 403);
    assert.equal(physicalWorkspaceCalls.length, 0, 'students cannot load the staff physical requirements workspace');
    const studentPage = await fetch(`${baseUrl}/documents`, { headers: { cookie: studentCookie } });
    const studentHtml = await studentPage.text();
    assert.equal(studentPage.status, 200, JSON.stringify(calls));
    assert.doesNotMatch(studentHtml, /Search physical requirement statuses|Physical student requirements/);
    assert.match(studentHtml, /Good Moral Certificate/);
    assert.match(studentHtml, /report card/i);
    assert.match(studentHtml, /Previous-school report-card paper copy/);
    assert.match(studentHtml, /Paper-copy status:<\/strong> Received/);
    assert.doesNotMatch(studentHtml, /Staff-only paper note/);
    assert.doesNotMatch(studentHtml, /Form 137|form137_status|Gemini suggestions/i, 'Form 137 workflow details remain staff-only');
    assert.match(studentHtml, /id="document-file"[^>]*aria-describedby="upload-format-help"/);
    assert.match(studentHtml, /id="upload-format-help">Accepted file formats: PDF, JPEG, and PNG\. Maximum size: 10 MB\. Good Moral and PSA files receive configured field prechecks/);
    assert.match(studentHtml, /If staff rejects the latest submission, you can start a new original submission; earlier submissions stay in your history/);
    assert.doesNotMatch(studentHtml, /No file is uploaded or processed/);
    assert.match(studentHtml, /option value="psa_birth_certificate"/);
    assert.match(studentHtml, /option value="good_moral"/);
    assert.match(studentHtml, /option value="report_card"/);
    assert.doesNotMatch(studentHtml, /option value="form_137"/);
    assert.doesNotMatch(studentHtml, /OCR output|extracted text/i);

    listedDocuments = [{ id: 15, document_type: 'good_moral', status: 'needs_review' }];
    const studentPartialUploads = await fetch(`${baseUrl}/documents`, { headers: { cookie: studentCookie } });
    const studentPartialUploadsHtml = await studentPartialUploads.text();
    assert.equal(studentPartialUploads.status, 200);
    assert.doesNotMatch(studentPartialUploadsHtml, /option value="good_moral"/);
    assert.match(studentPartialUploadsHtml, /option value="psa_birth_certificate"/);

    listedDocuments = [{ id: 15, document_type: 'good_moral', status: 'rejected' }];
    const studentRejectedUpload = await fetch(`${baseUrl}/documents`, { headers: { cookie: studentCookie } });
    const studentRejectedUploadHtml = await studentRejectedUpload.text();
    assert.equal(studentRejectedUpload.status, 200);
    assert.match(studentRejectedUploadHtml, /option value="good_moral"/);

    listedDocuments = [
      { id: 24, document_type: 'good_moral', status: 'needs_review', created_at: new Date('2026-09-28T10:00:00Z') },
      { id: 15, document_type: 'good_moral', status: 'rejected', created_at: new Date('2026-09-28T09:00:00Z') }
    ];
    const studentNewerActive = await fetch(`${baseUrl}/documents`, { headers: { cookie: studentCookie } });
    const studentNewerActiveHtml = await studentNewerActive.text();
    assert.equal(studentNewerActive.status, 200);
    assert.doesNotMatch(studentNewerActiveHtml, /option value="good_moral"/);

    listedDocuments = [
      { id: 15, document_type: 'good_moral', status: 'needs_review' },
      { id: 23, document_type: 'psa_birth_certificate', status: 'valid' },
      { id: 27, document_type: 'report_card', is_legacy_archive: 0, status: 'needs_review' }
    ];
    const studentAllTypesUsed = await fetch(`${baseUrl}/documents`, { headers: { cookie: studentCookie } });
    const studentAllTypesUsedHtml = await studentAllTypesUsed.text();
    assert.equal(studentAllTypesUsed.status, 200);
    assert.doesNotMatch(studentAllTypesUsedHtml, /action="\/documents"[^>]*enctype="multipart\/form-data"/);
    assert.match(studentAllTypesUsedHtml, /Each allowed document type has a latest submission that was not rejected/);
    listedDocuments = [];

    assert.equal((await fetch(`${baseUrl}/documents/students/44`, { headers: { cookie: studentCookie } })).status, 403);
    const studentScan = new FormData();
    studentScan.set('_csrf', csrfFromHtml(studentHtml));
    studentScan.set('form137Scan', new Blob([Buffer.from('%PDF-1.7\nphysical paper')], { type: 'application/pdf' }), 'physical.pdf');
    assert.equal((await fetch(`${baseUrl}/documents/students/44/form137-scan`, {
      method: 'POST', headers: { cookie: studentCookie }, body: studentScan, redirect: 'manual'
    })).status, 403);
    assert.equal(scanCalls.length, 0, 'students cannot invoke the temporary scan service');

    const missingCsrfForm = new FormData();
    missingCsrfForm.set('_csrf', 'wrong');
    missingCsrfForm.set('documentType', 'report_card');
    missingCsrfForm.set('document', new Blob([Buffer.from('%PDF-1.7\nexample')], { type: 'application/pdf' }), 'report.pdf');
    const deniedWrite = await fetch(`${baseUrl}/documents`, { method: 'POST', headers: { cookie: studentCookie }, body: missingCsrfForm, redirect: 'manual' });
    assert.equal(deniedWrite.status, 403);
    assert.equal(calls.some(([action]) => action === 'upload'), false);

    const validForm = new FormData();
    validForm.set('_csrf', csrfFromHtml(studentHtml));
    validForm.set('documentType', 'good_moral');
    validForm.set('document', new Blob([Buffer.from('%PDF-1.7\nexample')], { type: 'application/pdf' }), 'moral.pdf');
    const acceptedWrite = await fetch(`${baseUrl}/documents`, { method: 'POST', headers: { cookie: studentCookie }, body: validForm, redirect: 'manual' });
    assert.equal(acceptedWrite.status, 303);
    assert.equal(acceptedWrite.headers.get('location'), '/documents/15?notice=uploaded');
    assert.equal(calls.some(([action, actorId, type, filename]) => action === 'upload' && actorId === 1 && type === 'good_moral' && filename === 'moral.pdf'), true);
    assert.ok(uploadedBuffers[0].every((byte) => byte === 0), 'the upload route clears the multipart buffer after the service returns');
    assert.deepEqual(processingCalls, ['scheduled'], 'student upload schedules background OCR');

    const studentReportCard = new FormData();
    studentReportCard.set('_csrf', csrfFromHtml(studentHtml));
    studentReportCard.set('documentType', 'report_card');
    studentReportCard.set('studentId', '999');
    studentReportCard.set('document', new Blob([Buffer.from('%PDF-1.7\nreport card')], { type: 'application/pdf' }), 'report.pdf');
    const processingCountBeforeStudentReportCard = processingCalls.length;
    const acceptedReportCard = await fetch(`${baseUrl}/documents`, { method: 'POST', headers: { cookie: studentCookie }, body: studentReportCard, redirect: 'manual' });
    assert.equal(acceptedReportCard.status, 303);
    assert.equal(acceptedReportCard.headers.get('location'), '/documents/27?notice=uploaded');
    assert.equal(calls.some(([action, actorId, type]) => action === 'upload' && actorId === 1 && type === 'report_card'), true);
    assert.equal(processingCalls.length, processingCountBeforeStudentReportCard + 1, 'active report-card upload queues the limited Gemini precheck');
    assert.ok(uploadedBuffers[1].every((byte) => byte === 0), 'the upload route clears the report-card multipart buffer');

    const activeReportCardDetail = await fetch(`${baseUrl}/documents/27?notice=uploaded`, { headers: { cookie: studentCookie } });
    const activeReportCardHtml = await activeReportCardDetail.text();
    assert.equal(activeReportCardDetail.status, 200);
    assert.match(activeReportCardHtml, /Staff review/);
    assert.match(activeReportCardHtml, /limited precheck/);
    assert.match(activeReportCardHtml, /does not extract grades/);
    assert.doesNotMatch(activeReportCardHtml, /Automated precheck|precheck-retry/);
    assert.match(activeReportCardHtml, /action="\/documents\/27\/reupload"/);
    assert.doesNotMatch(activeReportCardHtml, /opaque-stored-name/);

    const studentDetail = await fetch(`${baseUrl}/documents/15`, { headers: { cookie: studentCookie } });
    const studentDetailHtml = await studentDetail.text();
    assert.equal(studentDetail.status, 200);
    assert.doesNotMatch(studentDetailHtml, /action="\/documents\/15\/delete"/);
    assert.match(studentDetailHtml, /Upload a clearer file &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(studentDetailHtml, /action="\/documents\/15\/reupload"/);
    assert.doesNotMatch(studentDetailHtml, /precheck-retry/);
    assert.doesNotMatch(studentDetailHtml, /Required source-inspection checklist|Staff source-inspection checklist/);
    assert.doesNotMatch(studentDetailHtml, /opaque-stored-name|extracted text|OCR output|img src=x onerror/i);

    const historicalReportCardDetail = await fetch(`${baseUrl}/documents/24?notice=correctionRequested`, { headers: { cookie: studentCookie } });
    const historicalReportCardHtml = await historicalReportCardDetail.text();
    assert.equal(historicalReportCardDetail.status, 404, 'students cannot read historical report cards by direct URL');
    const forgedReportCardCorrection = new FormData();
    forgedReportCardCorrection.set('_csrf', csrfFromHtml(studentHtml));
    forgedReportCardCorrection.set('document', new Blob([Buffer.from('%PDF-1.7\nreplacement')], { type: 'application/pdf' }), 'replacement-report.pdf');
    const deniedReportCardCorrection = await fetch(`${baseUrl}/documents/24/reupload`, {
      method: 'POST', headers: { cookie: studentCookie }, body: forgedReportCardCorrection, redirect: 'manual'
    });
    assert.equal(deniedReportCardCorrection.status, 404, 'student cannot re-upload a historical student-origin report card');
    assert.equal(calls.some(([action, actorId, id]) => action === 'reupload' && actorId === 1 && id === '24'), false);

    for (const [documentId, expectedStatus] of [[20, /Rejected after staff review/], [21, /Verified after staff source inspection/], [26, /Rejected after staff review/]]) {
      const finalDetail = await fetch(`${baseUrl}/documents/${documentId}`, { headers: { cookie: studentCookie } });
      const finalDetailHtml = await finalDetail.text();
      assert.equal(finalDetail.status, 200);
      assert.match(finalDetailHtml, expectedStatus);
      assert.doesNotMatch(finalDetailHtml, new RegExp(`action="/documents/${documentId}/reupload"`), 'a final decision clears the old correction action');
      if (documentId === 20) {
        assert.match(finalDetailHtml, /<strong id="rejection-reason-title">Reason for rejection<\/strong>/);
        assert.match(finalDetailHtml, /The submitted certificate is unreadable &lt;script&gt;alert\(1\)&lt;\/script&gt;\./);
        assert.doesNotMatch(finalDetailHtml, /The submitted certificate is unreadable <script>alert\(1\)<\/script>/);
      } else {
        assert.doesNotMatch(finalDetailHtml, /document-rejection-callout/, 'verified decisions and rejected decisions with blank reasons have no rejection callout');
      }
    }

    const studentCorrection = new FormData();
    studentCorrection.set('_csrf', csrfFromHtml(studentDetailHtml));
    studentCorrection.set('document', new Blob([Buffer.from('%PDF-1.7\ncorrected')], { type: 'application/pdf' }), 'corrected.pdf');
    const correctedStudentWrite = await fetch(`${baseUrl}/documents/15/reupload`, {
      method: 'POST', headers: { cookie: studentCookie }, body: studentCorrection, redirect: 'manual'
    });
    assert.equal(correctedStudentWrite.status, 303);
    assert.equal(correctedStudentWrite.headers.get('location'), '/documents/17?notice=uploaded');
    assert.equal(processingCalls.at(-1), 'scheduled', 'student correction schedules background OCR');

    const studentPsaUpload = new FormData();
    studentPsaUpload.set('_csrf', csrfFromHtml(studentHtml));
    studentPsaUpload.set('documentType', 'psa_birth_certificate');
    studentPsaUpload.set('document', new Blob([Buffer.from('%PDF-1.7\nstudent PSA')], { type: 'application/pdf' }), 'birth-certificate.pdf');
    const acceptedStudentPsa = await fetch(`${baseUrl}/documents`, { method: 'POST', headers: { cookie: studentCookie }, body: studentPsaUpload, redirect: 'manual' });
    assert.equal(acceptedStudentPsa.status, 303);
    assert.equal(acceptedStudentPsa.headers.get('location'), '/documents/23?notice=uploaded');
    assert.equal(calls.some(([action, actorId, type, filename]) => action === 'upload' && actorId === 1 && type === 'psa_birth_certificate' && filename === 'birth-certificate.pdf'), true);
    const studentPsaDetail = await fetch(`${baseUrl}/documents/23`, { headers: { cookie: studentCookie } });
    const studentPsaDetailHtml = await studentPsaDetail.text();
    assert.equal(studentPsaDetail.status, 200);
    assert.match(studentPsaDetailHtml, /PSA birth certificate/);
    assert.match(studentPsaDetailHtml, /Follow the instruction from staff, then upload the corrected file as a new submission/);
    assert.match(studentPsaDetailHtml, /Upload a clearer file/);
    assert.match(studentPsaDetailHtml, /action="\/documents\/23\/reupload"/);
    const studentPsaCorrection = new FormData();
    studentPsaCorrection.set('_csrf', csrfFromHtml(studentPsaDetailHtml));
    studentPsaCorrection.set('document', new Blob([Buffer.from('%PDF-1.7\ncorrected student PSA')], { type: 'application/pdf' }), 'corrected-birth-certificate.pdf');
    const correctedStudentPsa = await fetch(`${baseUrl}/documents/23/reupload`, {
      method: 'POST', headers: { cookie: studentCookie }, body: studentPsaCorrection, redirect: 'manual'
    });
    assert.equal(correctedStudentPsa.status, 303);
    assert.equal(correctedStudentPsa.headers.get('location'), '/documents/17?notice=uploaded');
    assert.equal(calls.some(([action, actorId, id, filename]) => action === 'reupload' && actorId === 1 && id === '23' && filename === 'corrected-birth-certificate.pdf'), true);
    assert.equal((await fetch(`${baseUrl}/documents/16`, { headers: { cookie: studentCookie } })).status, 404, 'student cannot open staff-uploaded PSA corrections');
    assert.equal(processingCalls.at(-1), 'scheduled', 'student PSA upload schedules background OCR');

    const financeCookie = await login(baseUrl, 'finance@example.edu');
    const beforeDeniedList = calls.filter(([action]) => action === 'list').length;
    assert.equal((await fetch(`${baseUrl}/documents`, { headers: { cookie: financeCookie } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/documents/physical`, { headers: { cookie: financeCookie } })).status, 403);
    assert.equal(calls.filter(([action]) => action === 'list').length, beforeDeniedList);
    const financeScan = new FormData();
    financeScan.set('form137Scan', new Blob([Buffer.from('%PDF-1.7\nphysical paper')], { type: 'application/pdf' }), 'physical.pdf');
    assert.equal((await fetch(`${baseUrl}/documents/students/44/form137-scan`, {
      method: 'POST', headers: { cookie: financeCookie }, body: financeScan, redirect: 'manual'
    })).status, 403);
    assert.equal(scanCalls.length, 0, 'finance cannot invoke the temporary scan service');
    const beforeFinancePhysicalRequest = physicalWorkspaceCalls.length;
    assert.equal((await fetch(`${baseUrl}/documents/physical`, { headers: { cookie: financeCookie } })).status, 403);
    assert.equal(physicalWorkspaceCalls.length, beforeFinancePhysicalRequest, 'finance cannot load physical requirements');
    const teacherCookie = await login(baseUrl, 'teacher@example.edu');
    assert.equal((await fetch(`${baseUrl}/documents/physical`, { headers: { cookie: teacherCookie } })).status, 403);
    assert.equal(physicalWorkspaceCalls.length, beforeFinancePhysicalRequest, 'teachers cannot load physical requirements');

    const registrarCookie = await login(baseUrl, 'registrar@example.edu');
    const reportCardQueuePage = await fetch(`${baseUrl}/documents`, { headers: { cookie: registrarCookie } });
    const reportCardQueueHtml = await reportCardQueuePage.text();
    assert.equal(reportCardQueuePage.status, 200);
    assert.match(reportCardQueueHtml, /Physical student requirements/);
    assert.match(reportCardQueueHtml, /Form 137 physical record/);
    assert.match(reportCardQueueHtml, /href="\/documents\/physical"/);
    assert.match(reportCardQueueHtml, /These filters do not include Form 137 or paper-copy status records/);
    assert.match(reportCardQueueHtml, /Previous-school report-card scans/);
    assert.match(reportCardQueueHtml, /Latest submissions/);
    assert.match(reportCardQueueHtml, /Open active previous-school report-card scan queue/);
    assert.match(reportCardQueueHtml, /documentType=report_card&amp;status=awaiting_review/);

    const physicalPage = await fetch(`${baseUrl}/documents/physical?search=Maria%20Santos&page=2`, { headers: { cookie: registrarCookie } });
    const physicalHtml = await physicalPage.text();
    assert.equal(physicalPage.status, 200);
    assert.deepEqual(physicalWorkspaceCalls.at(-1), [2, 'Maria Santos', '2']);
    assert.match(physicalHtml, /Physical student requirements/);
    assert.match(physicalHtml, /Maria Santos/);
    assert.match(physicalHtml, /Student no\. SHS-2026-0321/);
    assert.match(physicalHtml, /LRN 123456789012/);
    assert.match(physicalHtml, /Form 137 physical record/);
    assert.match(physicalHtml, /Previous-school report-card paper copy/);
    assert.match(physicalHtml, /Record or update Form 137 status/);
    assert.match(physicalHtml, /href="\/documents\/students\/44#form137-status-title"/);
    assert.match(physicalHtml, /href="\/documents\/students\/44#previous-school-report-card-status-title"/);
    assert.match(physicalHtml, /search=Maria%20Santos&amp;page=1/);
    assert.match(physicalHtml, /search=Maria%20Santos&amp;page=3/);
    assert.doesNotMatch(physicalHtml, /Staff-only note must not appear here/);

    reportCardSummary = {
      document_type: 'report_card', submitted_count: 2, awaiting_review_count: 0,
      processing_count: 1, review_required_count: 0, correction_requested_count: 1,
      verified_count: 0, rejected_count: 0
    };
    const noAwaitingQueuePage = await fetch(`${baseUrl}/documents`, { headers: { cookie: registrarCookie } });
    const noAwaitingQueueHtml = await noAwaitingQueuePage.text();
    assert.equal(noAwaitingQueuePage.status, 200);
    assert.doesNotMatch(noAwaitingQueueHtml, /Open active previous-school report-card scan queue/);
    assert.match(noAwaitingQueueHtml, /No active scans are awaiting staff review/);
    reportCardSummary = {
      document_type: 'report_card', submitted_count: 0, awaiting_review_count: 0,
      processing_count: 0, review_required_count: 0, correction_requested_count: 0,
      verified_count: 0, rejected_count: 0
    };
    const noReportCardsPage = await fetch(`${baseUrl}/documents`, { headers: { cookie: registrarCookie } });
    const noReportCardsHtml = await noReportCardsPage.text();
    assert.equal(noReportCardsPage.status, 200);
    assert.match(noReportCardsHtml, /No active digital previous-school report-card scans have been submitted/);
    assert.doesNotMatch(noReportCardsHtml, /<dt>Latest submissions<\/dt>|<dt>Awaiting staff review<\/dt>|<dt>Correction requested<\/dt>/);
    assert.doesNotMatch(noReportCardsHtml, /Open active previous-school report-card scan queue/);
    reportCardSummary = {
      document_type: 'report_card', submitted_count: 3, awaiting_review_count: 1,
      processing_count: 0, review_required_count: 1, correction_requested_count: 1,
      verified_count: 0, rejected_count: 0
    };
    const staffPage = await fetch(`${baseUrl}/documents/students/44`, { headers: { cookie: registrarCookie } });
    assert.equal(staffPage.status, 200);
    const staffPageHtml = await staffPage.text();
    assert.match(staffPageHtml, /PSA birth certificate/);
    assert.match(staffPageHtml, /Previous-school report-card paper copy/);
    assert.match(staffPageHtml, /Staff-only paper note: bring a clearer copy/);
    assert.match(staffPageHtml, /action="\/documents\/students\/44\/previous-school-report-card-status"/);
    assert.doesNotMatch(staffPageHtml, /option value="form_137"/);
    assert.doesNotMatch(staffPageHtml, /option value="report_card"/);
    assert.match(staffPageHtml, /option value="psa_birth_certificate"/);
    assert.match(staffPageHtml, /If staff rejects the latest submission, you can start a new original submission; earlier submissions stay in the student’s history/);
    assert.match(staffPageHtml, /Not recorded/);
    assert.match(staffPageHtml, /form137-scan/);
    assert.match(staffPageHtml, /scan is processed in memory/);

    listedDocuments = [{ id: 15, document_type: 'good_moral', status: 'needs_review' }];
    const staffPartialUploads = await fetch(`${baseUrl}/documents/students/44`, { headers: { cookie: registrarCookie } });
    const staffPartialUploadsHtml = await staffPartialUploads.text();
    assert.equal(staffPartialUploads.status, 200);
    assert.doesNotMatch(staffPartialUploadsHtml, /option value="good_moral"/);
    assert.match(staffPartialUploadsHtml, /option value="psa_birth_certificate"/);

    listedDocuments = [{ id: 15, document_type: 'psa_birth_certificate', status: 'rejected' }];
    const staffRejectedUpload = await fetch(`${baseUrl}/documents/students/44`, { headers: { cookie: registrarCookie } });
    const staffRejectedUploadHtml = await staffRejectedUpload.text();
    assert.equal(staffRejectedUpload.status, 200);
    assert.match(staffRejectedUploadHtml, /option value="psa_birth_certificate"/);

    listedDocuments = [
      { id: 24, document_type: 'good_moral', status: 'processing', created_at: new Date('2026-09-28T10:00:00Z') },
      { id: 15, document_type: 'good_moral', status: 'rejected', created_at: new Date('2026-09-28T09:00:00Z') }
    ];
    const staffNewerActive = await fetch(`${baseUrl}/documents/students/44`, { headers: { cookie: registrarCookie } });
    const staffNewerActiveHtml = await staffNewerActive.text();
    assert.equal(staffNewerActive.status, 200);
    assert.doesNotMatch(staffNewerActiveHtml, /option value="good_moral"/);

    listedDocuments = [
      { id: 15, document_type: 'good_moral', status: 'needs_review' },
      { id: 23, document_type: 'psa_birth_certificate', status: 'valid' }
    ];
    const staffAllTypesUsed = await fetch(`${baseUrl}/documents/students/44`, { headers: { cookie: registrarCookie } });
    const staffAllTypesUsedHtml = await staffAllTypesUsed.text();
    assert.equal(staffAllTypesUsed.status, 200);
    assert.doesNotMatch(staffAllTypesUsedHtml, /action="\/documents\/students\/44"[^>]*enctype="multipart\/form-data"/);
    assert.match(staffAllTypesUsedHtml, /Each allowed document type has a latest submission that was not rejected/);
    listedDocuments = [];

    const deniedCsrfScan = new FormData();
    deniedCsrfScan.set('_csrf', 'wrong');
    deniedCsrfScan.set('form137Scan', new Blob([Buffer.from('%PDF-1.7\nphysical paper')], { type: 'application/pdf' }), 'physical.pdf');
    const deniedScan = await fetch(`${baseUrl}/documents/students/44/form137-scan`, {
      method: 'POST', headers: { cookie: registrarCookie }, body: deniedCsrfScan, redirect: 'manual'
    });
    assert.equal(deniedScan.status, 403);
    assert.match(deniedScan.headers.get('cache-control'), /no-store/);
    assert.equal(scanCalls.length, 0, 'CSRF failure prevents OCR');

    const staffScan = new FormData();
    staffScan.set('_csrf', csrfFromHtml(staffPageHtml));
    staffScan.set('form137Scan', new Blob([Buffer.from('%PDF-1.7\nphysical paper')], { type: 'application/pdf' }), 'physical.pdf');
    const scanResponse = await fetch(`${baseUrl}/documents/students/44/form137-scan`, {
      method: 'POST', headers: { cookie: registrarCookie }, body: staffScan, redirect: 'manual'
    });
    const scanHtml = await scanResponse.text();
    assert.equal(scanResponse.status, 200);
    assert.match(scanResponse.headers.get('cache-control'), /private, no-store/);
    assert.equal(scanResponse.headers.get('pragma'), 'no-cache');
    assert.match(scanHtml, /Temporary Gemini suggestions/);
    assert.match(scanHtml, /Academy &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(scanHtml, /Academy <script>alert\(1\)<\/script>/);
    assert.deepEqual(scanCalls[0], ['scan', 2, 44, 'physical.pdf']);
    assert.ok(scanBuffers[0].every((byte) => byte === 0), 'the scan route clears the multipart buffer after the scan service returns');

    const failedScan = new FormData();
    failedScan.set('_csrf', csrfFromHtml(scanHtml));
    failedScan.set('form137Scan', new Blob([Buffer.from('%PDF-1.7\nphysical paper')], { type: 'application/pdf' }), 'physical.pdf');
    const failedScanResponse = await fetch(`${baseUrl}/documents/students/44/form137-scan`, {
      method: 'POST', headers: { cookie: registrarCookie }, body: failedScan, redirect: 'manual'
    });
    const failedScanHtml = await failedScanResponse.text();
    assert.equal(failedScanResponse.status, 200);
    assert.match(failedScanResponse.headers.get('cache-control'), /no-store/);
    assert.match(failedScanHtml, /Gemini field extraction timed out/);
    assert.match(failedScanHtml, /Save Form 137 status/);
    assert.deepEqual(scanCalls[1], ['scan', 2, 44, 'physical.pdf']);

    const processingCallsBeforeStatus = processingCalls.length;
    const statusWrite = await fetch(`${baseUrl}/documents/students/44/form137-status`, {
      method: 'POST',
      headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFromHtml(failedScanHtml), status: 'verified', instruction: '' }),
      redirect: 'manual'
    });
    assert.equal(statusWrite.status, 303);
    assert.equal(calls.some(([action, actorId, studentId, status]) => action === 'form137' && actorId === 2 && studentId === 44 && status === 'verified'), true);
    assert.equal(processingCalls.length, processingCallsBeforeStatus, 'physical status updates do not schedule OCR');

    assert.equal((await fetch(`${baseUrl}/documents/students/44/previous-school-report-card-status`, {
      method: 'POST', headers: { cookie: studentCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ status: 'received' }), redirect: 'manual'
    })).status, 403, 'students cannot record paper-copy receipt');
    const noCsrfPaperStatus = await fetch(`${baseUrl}/documents/students/44/previous-school-report-card-status`, {
      method: 'POST', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ status: 'received' }), redirect: 'manual'
    });
    assert.equal(noCsrfPaperStatus.status, 403, 'paper-copy status writes require CSRF');
    const paperStatus = await fetch(`${baseUrl}/documents/students/44/previous-school-report-card-status`, {
      method: 'POST', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFromHtml(staffPageHtml), status: 'received', instruction: '' }), redirect: 'manual'
    });
    assert.equal(paperStatus.status, 303);
    assert.match(paperStatus.headers.get('location'), /notice=previousSchoolReportCardStatusRecorded#previous-school-report-card-status-title/);
    assert.equal(calls.some(([action, actorId, studentId, status]) => action === 'previous-school-paper-status' && actorId === 2 && studentId === 44 && status === 'received'), true);

    const staffReportCardUpload = new FormData();
    staffReportCardUpload.set('_csrf', csrfFromHtml(staffPageHtml));
    staffReportCardUpload.set('documentType', 'report_card');
    staffReportCardUpload.set('document', new Blob([Buffer.from('%PDF-1.7\nteacher report')], { type: 'application/pdf' }), 'teacher-report.pdf');
    const processingCountBeforeReportCard = processingCalls.length;
    const acceptedStaffReportCard = await fetch(`${baseUrl}/documents/students/44`, {
      method: 'POST', headers: { cookie: registrarCookie }, body: staffReportCardUpload, redirect: 'manual'
    });
    assert.equal(acceptedStaffReportCard.status, 403, 'staff report-card upload is retired at the service boundary');
    assert.equal(calls.some(([action, actorId, type]) => action === 'upload' && actorId === 2 && type === 'report_card'), false);
    assert.equal(processingCalls.length, processingCountBeforeReportCard, 'staff report-card upload remains blocked and does not enqueue processing');
    const staffReportCardDetail = await fetch(`${baseUrl}/documents/24`, { headers: { cookie: registrarCookie } });
    const staffReportCardHtml = await staffReportCardDetail.text();
    assert.equal(staffReportCardDetail.status, 200);
    assert.match(staffReportCardHtml, /read-only archive/);
    assert.match(staffReportCardHtml, /Download file/);
    assert.doesNotMatch(staffReportCardHtml, /Permanently delete submission/);
    assert.doesNotMatch(staffReportCardHtml, /OCR result|Staff review decision|reupload/);
    const staffReportCardCorrection = new FormData();
    staffReportCardCorrection.set('_csrf', csrfFromHtml(staffReportCardHtml));
    staffReportCardCorrection.set('document', new Blob([Buffer.from('%PDF-1.7\ncorrected staff report')], { type: 'application/pdf' }), 'corrected-report.pdf');
    const correctedStaffReportCard = await fetch(`${baseUrl}/documents/24/reupload`, {
      method: 'POST', headers: { cookie: registrarCookie }, body: staffReportCardCorrection, redirect: 'manual'
    });
    assert.equal(correctedStaffReportCard.status, 409);
    assert.equal(calls.some(([action, actorId, id]) => action === 'reupload' && actorId === 2 && id === '24'), false);

    const activeStaffReportCardDetail = await fetch(`${baseUrl}/documents/27`, { headers: { cookie: registrarCookie } });
    const activeStaffReportCardHtml = await activeStaffReportCardDetail.text();
    assert.equal(activeStaffReportCardDetail.status, 200);
    assert.match(activeStaffReportCardHtml, /Previous-school report-card scan review/);
    assert.match(activeStaffReportCardHtml, /Name and file-format checks passed/);
    assert.doesNotMatch(activeStaffReportCardHtml, /Good Moral title|certificate context evidence/);
    assert.match(activeStaffReportCardHtml, /Staff review decision/);
    assert.match(activeStaffReportCardHtml, /Required source-inspection checklist/);
    assert.doesNotMatch(activeStaffReportCardHtml, /Automated precheck|Retry automated precheck/);
    assert.doesNotMatch(activeStaffReportCardHtml, /action="\/documents\/27\/reupload"/);

    const staffUpload = new FormData();
    staffUpload.set('_csrf', csrfFromHtml(staffPageHtml));
    staffUpload.set('documentType', 'psa_birth_certificate');
    staffUpload.set('document', new Blob([Buffer.from('%PDF-1.7\nstaff source')], { type: 'application/pdf' }), 'psa.pdf');
    const acceptedStaffWrite = await fetch(`${baseUrl}/documents/students/44`, {
      method: 'POST', headers: { cookie: registrarCookie }, body: staffUpload, redirect: 'manual'
    });
    assert.equal(acceptedStaffWrite.status, 303);
    assert.equal(acceptedStaffWrite.headers.get('location'), '/documents/students/44?notice=uploaded');
    assert.equal(processingCalls.at(-1), 'scheduled', 'staff upload schedules background OCR');

    const restrictedStaffDetail = await fetch(`${baseUrl}/documents/16`, { headers: { cookie: registrarCookie } });
    const restrictedStaffDetailHtml = await restrictedStaffDetail.text();
    assert.equal(restrictedStaffDetail.status, 200);
    assert.match(restrictedStaffDetailHtml, /Correction instruction for staff/);
    assert.match(restrictedStaffDetailHtml, /action="\/documents\/16\/reupload"/);
    assert.doesNotMatch(restrictedStaffDetailHtml, /Follow the instruction from staff, then upload the corrected file as a new submission/);
    const studentOriginPsaStaffDetail = await fetch(`${baseUrl}/documents/23`, { headers: { cookie: registrarCookie } });
    assert.match(await studentOriginPsaStaffDetail.text(), /Correction instruction for the student/);
    const correctedStaffUpload = new FormData();
    correctedStaffUpload.set('_csrf', csrfFromHtml(restrictedStaffDetailHtml));
    correctedStaffUpload.set('document', new Blob([Buffer.from('%PDF-1.7\nstaff correction')], { type: 'application/pdf' }), 'corrected-137.pdf');
    const correctedStaffWrite = await fetch(`${baseUrl}/documents/16/reupload`, {
      method: 'POST', headers: { cookie: registrarCookie }, body: correctedStaffUpload, redirect: 'manual'
    });
    assert.equal(correctedStaffWrite.status, 303);
    assert.equal(correctedStaffWrite.headers.get('location'), '/documents/19?notice=uploaded');
    assert.equal(processingCalls.at(-1), 'scheduled', 'staff correction schedules background OCR');
    assert.equal(calls.some(([action, actorId, studentId]) => action === 'student' && actorId === 2 && studentId === 44), true);

    const staffDetail = await fetch(`${baseUrl}/documents/15`, { headers: { cookie: registrarCookie } });
    const staffDetailHtml = await staffDetail.text();
    assert.equal(staffDetail.status, 200);
    assert.match(staffDetailHtml, /href="\/documents\/15\/preview"[^>]*>View document<\/a>/);
    assert.match(staffDetailHtml, /Automated precheck/);
    assert.match(staffDetailHtml, /Needs attention/);
    assert.match(staffDetailHtml, /Supported PDF, JPEG, or PNG/);
    assert.match(staffDetailHtml, /confirm page completeness/i);
    assert.doesNotMatch(staffDetailHtml, /action="\/documents\/15\/review"|Send for staff review/);
    const removedHandoff = await fetch(`${baseUrl}/documents/15/review`, {
      method: 'POST', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFromHtml(staffDetailHtml) }), redirect: 'manual'
    });
    assert.equal(removedHandoff.status, 404);
    assert.match(staffDetailHtml, /action="\/documents\/15\/decision"/);
    assert.match(staffDetailHtml, /action="\/documents\/15\/correction"/);
    assert.doesNotMatch(staffDetailHtml, /precheck-retry/);
    assert.match(staffDetailHtml, /action="\/documents\/15\/delete"/);
    assert.match(staffDetailHtml, /name="confirmDelete" value="yes" type="checkbox" required/);
    assert.match(staffDetailHtml, /removes this active submission, its private file, and its review history/i);
    assert.match(staffDetailHtml, /Correction instruction for the student/);
    assert.match(staffDetailHtml, /Required source-inspection checklist/);
    assert.match(staffDetailHtml, /name="linkedStudentNameLegible" value="yes" type="checkbox" required/);
    assert.match(staffDetailHtml, /name="schoolNameLegible" value="yes" type="checkbox" required/);
    assert.match(staffDetailHtml, /name="selectedDocumentTypeCorrect" value="yes" type="checkbox" required/);
    assert.match(staffDetailHtml, /name="goodMoralContextLegible" value="yes" type="checkbox" required/);
    assert.match(staffDetailHtml, /name="allSubmittedPagesReadableComplete" value="yes" type="checkbox" required/);
    assert.match(staffDetailHtml, /Possible Academy/);
    assert.match(staffDetailHtml, /Linked student-name text/);
    assert.match(staffDetailHtml, /Legacy OCR-only · Needs review/);
    assert.match(staffDetailHtml, /Gemini was not run for this result/);
    assert.match(staffDetailHtml, /Possible text identified/);
    assert.match(staffDetailHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(staffDetailHtml, /<img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(staffDetailHtml, /opaque-stored-name/);

    const retryDetail = await fetch(`${baseUrl}/documents/25`, { headers: { cookie: registrarCookie } });
    const retryDetailHtml = await retryDetail.text();
    assert.equal(retryDetail.status, 200);
    assert.match(retryDetailHtml, /action="\/documents\/25\/precheck-retry"/);
    assert.match(retryDetailHtml, /retry up to 2 more times/);

    const invalidRetryCsrf = await fetch(`${baseUrl}/documents/25/precheck-retry`, {
      method: 'POST', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'invalid' }), redirect: 'manual'
    });
    assert.equal(invalidRetryCsrf.status, 403);
    assert.equal(retryCalls.length, 0, 'invalid CSRF cannot queue a retry');

    const deniedStudentRetry = await fetch(`${baseUrl}/documents/25/precheck-retry`, {
      method: 'POST', headers: { cookie: studentCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFromHtml(studentDetailHtml) }), redirect: 'manual'
    });
    assert.equal(deniedStudentRetry.status, 403);
    assert.equal(retryCalls.length, 0, 'students cannot invoke the retry service');

    const queuedRetry = await fetch(`${baseUrl}/documents/25/precheck-retry`, {
      method: 'POST', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFromHtml(retryDetailHtml) }), redirect: 'manual'
    });
    assert.equal(queuedRetry.status, 303);
    assert.equal(queuedRetry.headers.get('location'), '/documents/25?notice=precheckQueued');
    assert.deepEqual(retryCalls, [[2, '25']]);
    assert.equal(processingCalls.at(-1), 'scheduled', 'a staff retry schedules the existing pending-document worker');

    const registrarDecision = new URLSearchParams({
      _csrf: csrfFromHtml(staffDetailHtml), decision: 'verified', reason: 'I inspected the source.',
      linkedStudentNameLegible: 'yes', schoolNameLegible: 'yes', goodMoralContextLegible: 'yes',
      selectedDocumentTypeCorrect: 'yes', allSubmittedPagesReadableComplete: 'yes'
    });
    const registrarDecisionResponse = await fetch(`${baseUrl}/documents/15/decision`, {
      method: 'POST', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: registrarDecision, redirect: 'manual'
    });
    assert.equal(registrarDecisionResponse.status, 303);
    assert.equal(decisionCalls.length, 1);
    assert.equal(decisionCalls[0][4].schoolNameLegible, 'yes', 'the route forwards checklist fields to the server validator');

    const registrarRejection = await fetch(`${baseUrl}/documents/17/decision`, {
      method: 'POST', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFromHtml(staffDetailHtml), decision: 'rejected', reason: 'The submitted file is not an official certificate.' }), redirect: 'manual'
    });
    assert.equal(registrarRejection.status, 303);
    assert.deepEqual(decisionCalls[1].slice(0, 4), [2, '17', 'rejected', 'The submitted file is not an official certificate.']);

    const missingDeleteConfirmation = await fetch(`${baseUrl}/documents/15/delete`, {
      method: 'POST', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFromHtml(staffDetailHtml) }), redirect: 'manual'
    });
    assert.equal(missingDeleteConfirmation.status, 400);
    assert.equal(deleteCalls.length, 0, 'server-side confirmation is required before the deletion service runs');

    const deniedDeleteCsrf = await fetch(`${baseUrl}/documents/15/delete`, {
      method: 'POST', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'invalid', confirmDelete: 'yes' }), redirect: 'manual'
    });
    assert.equal(deniedDeleteCsrf.status, 403);
    assert.equal(deleteCalls.length, 0, 'CSRF validation runs before the deletion service');

    const deniedStudentDelete = await fetch(`${baseUrl}/documents/15/delete`, {
      method: 'POST', headers: { cookie: studentCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFromHtml(studentDetailHtml), confirmDelete: 'yes' }), redirect: 'manual'
    });
    assert.equal(deniedStudentDelete.status, 403);
    assert.equal(deleteCalls.length, 0, 'students cannot reach the deletion service');

    const registrarDelete = await fetch(`${baseUrl}/documents/15/delete`, {
      method: 'POST', headers: { cookie: registrarCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrfFromHtml(staffDetailHtml), confirmDelete: 'yes' }), redirect: 'manual'
    });
    assert.equal(registrarDelete.status, 303);
    assert.equal(registrarDelete.headers.get('location'), '/documents?notice=deleted');
    assert.deepEqual(deleteCalls, [[2, '15']]);

    const databaseAdminCookie = await login(baseUrl, 'database_admin@example.edu');
    assert.equal((await fetch(`${baseUrl}/documents/physical`, { headers: { cookie: databaseAdminCookie } })).status, 200);
    const psaDetail = await fetch(`${baseUrl}/documents/16`, { headers: { cookie: databaseAdminCookie } });
    const psaDetailHtml = await psaDetail.text();
    assert.equal(psaDetail.status, 200);
    assert.match(psaDetailHtml, /name="linkedStudentNameLegible" value="yes" type="checkbox" required/);
    assert.doesNotMatch(psaDetailHtml, /name="schoolNameLegible"/);
    const psaDecision = new URLSearchParams({
      _csrf: csrfFromHtml(psaDetailHtml), decision: 'verified', linkedStudentNameLegible: 'yes',
      selectedDocumentTypeCorrect: 'yes', allSubmittedPagesReadableComplete: 'yes'
    });
    const psaDecisionResponse = await fetch(`${baseUrl}/documents/16/decision`, {
      method: 'POST', headers: { cookie: databaseAdminCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: psaDecision, redirect: 'manual'
    });
    assert.equal(psaDecisionResponse.status, 303);
    assert.equal(decisionCalls.length, 3);
    assert.equal(decisionCalls[2][0], 4, 'database administrators can record digital review decisions');
    assert.equal(Object.hasOwn(decisionCalls[2][4], 'schoolNameLegible'), false, 'PSA does not submit a school-name attestation');

    const studentDecision = new URLSearchParams({ _csrf: csrfFromHtml(studentDetailHtml), decision: 'verified' });
    const deniedStudentDecision = await fetch(`${baseUrl}/documents/15/decision`, {
      method: 'POST', headers: { cookie: studentCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: studentDecision, redirect: 'manual'
    });
    assert.equal(deniedStudentDecision.status, 403);
    assert.equal(decisionCalls.length, 3, 'students cannot invoke the decision service');

    const historicalForm137Detail = await fetch(`${baseUrl}/documents/22`, { headers: { cookie: registrarCookie } });
    const historicalForm137Html = await historicalForm137Detail.text();
    assert.equal(historicalForm137Detail.status, 200);
    assert.match(historicalForm137Html, /authorized staff may send a temporary scan to Gemini for field suggestions/);
    assert.match(historicalForm137Html, /Scans and suggestions are not retained in that workflow/);
    assert.match(historicalForm137Html, /Scans and results are not saved in that workflow/);
    assert.doesNotMatch(historicalForm137Html, /without uploads or Gemini/);
    assert.doesNotMatch(historicalForm137Html, /action="\/documents\/22\/delete"/);

    const privateStatic = await fetch(`${baseUrl}/storage/uploads/anything.pdf`);
    assert.equal(privateStatic.status, 404);
  });
});

test('document detail pairs image preview with submission and puts staff precheck below', async () => {
  const styles = await fs.readFile(path.join(__dirname, '../public/css/app.css'), 'utf8');
  const template = await fs.readFile(path.join(__dirname, '../views/documents/detail.ejs'), 'utf8');
  const overviewStart = template.indexOf('<div class="document-detail-overview ');
  const overviewEnd = template.indexOf('\n  </div>\n\n  <% if (document.isArchivedReportCard)', overviewStart);
  assert.notEqual(overviewStart, -1);
  assert.notEqual(overviewEnd, -1);

  const overview = template.slice(overviewStart, overviewEnd);
  assert.match(overview, /document-detail-overview--with-preview/);
  assert.ok(overview.indexOf('document-image-thumbnail-card') < overview.indexOf('aria-labelledby="submission-title"'));
  assert.doesNotMatch(overview, /precheck-result-title/);
  assert.ok(template.indexOf('aria-labelledby="precheck-result-title"') > overviewEnd);
  assert.match(styles, /\.document-detail-overview\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s, 'documents without a thumbnail use full-width metadata');
  assert.match(styles, /\.document-detail-overview--with-preview\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*23rem\)\s+minmax\(0,\s*1fr\);/s);
  assert.match(styles, /@media \(max-width: 880px\)\s*\{[^}]*\.document-detail-overview\.document-detail-overview--with-preview\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
  assert.match(styles, /\.document-precheck-scope\s*\{[^}]*max-width:\s*74ch;/s);
  assert.match(template, /does not establish authenticity or acceptance/);
});

test('document preview links open the same-origin file in a modal and clear it on close', async () => {
  const source = await fs.readFile(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const styles = await fs.readFile(path.join(__dirname, '../public/css/app.css'), 'utf8');
  const template = await fs.readFile(path.join(__dirname, '../views/documents/detail.ejs'), 'utf8');
  assert.match(template, /href="\/documents\/<%= item\.id %>\/preview" data-document-preview-trigger/);
  assert.match(template, /data-preview-mime="<%= item\.mime_type \|\| '' %>"/);
  assert.match(template, /<a class="document-image-thumbnail" href="\/documents\/<%= document\.id %>\/preview" data-document-preview-trigger/);
  assert.match(template, /aria-label="Open full-size preview of <%= document\.original_filename %>"/);
  assert.match(template, /alt="Uploaded <%= documentTypeLabel\(document\.document_type\) %> image: <%= document\.original_filename %>"/);
  assert.match(template, /Open full-size image/);
  assert.doesNotMatch(template, /Expand image|document-image-viewer--detail/);
  assert.doesNotMatch(template, /data-document-preview-trigger[^>]*target="_blank"/);
  assert.match(template, /<dialog[^>]*data-document-preview-dialog[^>]*aria-labelledby="document-preview-title"/);
  assert.match(styles, /\.document-image-thumbnail-card\s*\{[^}]*width:\s*min\(100%,\s*23rem\);/s);
  assert.match(styles, /\.document-image-thumbnail__viewport\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*3;/s);
  assert.match(styles, /\.document-image-viewer__image\s*\{[^}]*object-fit:\s*contain;/s);
  assert.match(styles, /\.document-image-viewer__viewport\s*\{[^}]*touch-action:\s*pan-y;/s);
  assert.match(styles, /\.document-image-viewer__viewport\.is-pannable\s*\{[^}]*touch-action:\s*none;/s);
  assert.match(styles, /\.document-preview-dialog\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.document-preview-dialog--image\[open\]\s*\{[^}]*width:\s*calc\(100vw - 1rem\);[^}]*height:\s*calc\(100dvh - 1rem\);/s);

  const triggerListeners = new Map();
  const dialogListeners = new Map();
  const closeListeners = new Map();
  const dialogClasses = new Set();
  const trigger = {
    href: 'https://app.example/documents/88/preview',
    dataset: { previewTitle: '<img src=x onerror=alert(1)>.pdf', previewMime: 'application/pdf' },
    isConnected: true,
    focusCalls: 0,
    addEventListener(type, listener) { triggerListeners.set(type, listener); },
    focus() { this.focusCalls += 1; }
  };
  const frame = {
    src: 'about:blank',
    title: '',
    hidden: false,
    removedAttributes: [],
    removeAttribute(name) { this.removedAttributes.push(name); }
  };
  const imageListeners = new Map();
  const image = {
    naturalWidth: 1600,
    naturalHeight: 2400,
    style: {},
    classList: { toggle() {} },
    removedAttributes: [],
    addEventListener(type, listener) { imageListeners.set(type, listener); },
    removeAttribute(name) { this.removedAttributes.push(name); }
  };
  const viewport = {
    clientWidth: 800,
    clientHeight: 600,
    classList: { toggle() {} },
    addEventListener() {},
    setPointerCapture() {}
  };
  const zoomListeners = new Map();
  const zoomStatus = { textContent: '' };
  const zoomIn = { disabled: false, addEventListener(type, listener) { zoomListeners.set(type, listener); } };
  const zoomOut = { disabled: false, addEventListener(type, listener) { zoomListeners.set(`out-${type}`, listener); } };
  const zoomReset = { disabled: false, clicks: 0, addEventListener(type, listener) { zoomListeners.set(`reset-${type}`, listener); }, click() { this.clicks += 1; zoomListeners.get('reset-click')?.(); } };
  const imageViewer = {
    hidden: true,
    dataset: {},
    querySelector(selector) {
      return selector === '[data-document-image-viewport]' ? viewport
        : selector === '[data-document-image]' ? image
          : selector === '[data-image-zoom-status]' ? zoomStatus
            : selector === '[data-image-zoom-in]' ? zoomIn
              : selector === '[data-image-zoom-out]' ? zoomOut
                : selector === '[data-image-zoom-reset]' ? zoomReset : null;
    }
  };
  const title = { textContent: '' };
  const closeButton = { addEventListener(type, listener) { closeListeners.set(type, listener); } };
  const dialog = {
    open: false,
    showModalCalls: 0,
    classList: {
      toggle(name, force) {
        if (force) dialogClasses.add(name);
        else dialogClasses.delete(name);
      },
      remove(name) { dialogClasses.delete(name); }
    },
    addEventListener(type, listener) { dialogListeners.set(type, listener); },
    querySelector(selector) {
      return selector === '[data-document-preview-frame]' ? frame
        : selector === '[data-document-preview-image-viewer]' ? imageViewer
        : selector === '[data-document-preview-title]' ? title
          : selector === '[data-document-preview-close]' ? closeButton : null;
    },
    showModal() { this.open = true; this.showModalCalls += 1; },
    close() {
      this.open = false;
      dialogListeners.get('close')?.();
    }
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-document-preview-trigger]') return [trigger];
      if (selector === '[data-document-image-viewer]') return [];
      return [];
    },
    querySelector(selector) { return selector === '[data-document-preview-dialog]' ? dialog : null; }
  };
  const window = {
    location: { href: 'https://app.example/documents/88', origin: 'https://app.example' },
    addEventListener() {}
  };

  vm.runInNewContext(source, { document, window, URL });

  const clickEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  triggerListeners.get('click')(clickEvent);
  assert.equal(clickEvent.prevented, true);
  assert.equal(dialog.showModalCalls, 1);
  assert.equal(dialogClasses.has('document-preview-dialog--image'), false);
  assert.equal(frame.src, 'https://app.example/documents/88/preview');
  assert.equal(frame.title, 'Preview of <img src=x onerror=alert(1)>.pdf');
  assert.equal(title.textContent, 'Preview: <img src=x onerror=alert(1)>.pdf');

  closeListeners.get('click')();
  assert.deepEqual(frame.removedAttributes, ['src']);
  assert.equal(trigger.focusCalls, 1);

  triggerListeners.get('click')({ prevented: false, preventDefault() {} });
  dialogListeners.get('click')({ target: dialog });
  assert.equal(dialog.open, false, 'backdrop clicks close the native dialog');
  assert.deepEqual(frame.removedAttributes, ['src', 'src']);
  assert.equal(trigger.focusCalls, 2);

  trigger.dataset.previewMime = 'image/jpeg';
  trigger.dataset.previewTitle = 'scan.jpg';
  const imageClick = { prevented: false, preventDefault() { this.prevented = true; } };
  triggerListeners.get('click')(imageClick);
  assert.equal(imageClick.prevented, true);
  assert.equal(imageViewer.hidden, false);
  assert.equal(frame.hidden, true);
  assert.equal(dialogClasses.has('document-preview-dialog--image'), true);
  assert.equal(image.src, 'https://app.example/documents/88/preview');
  zoomListeners.get('click')();
  assert.equal(zoomStatus.textContent, 'Zoom 150%');
  closeListeners.get('click')();
  assert.equal(image.removedAttributes.at(-1), 'src');
  assert.equal(imageViewer.hidden, true);
  assert.equal(dialogClasses.has('document-preview-dialog--image'), false);
  assert.equal(trigger.focusCalls, 3);

  trigger.href = 'https://other.example/documents/88/preview';
  trigger.dataset.previewMime = 'image/jpeg';
  const unsafeClickEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  triggerListeners.get('click')(unsafeClickEvent);
  assert.equal(unsafeClickEvent.prevented, false, 'invalid or cross-origin URLs retain normal link behavior');
  assert.equal(dialog.showModalCalls, 3);
});

test('document routes preview files inline, keep downloads attached, and hide document failures', async () => {
  const passwordHash = await bcrypt.hash('Correct-Horse-Battery-12', 4);
  const users = ['student', 'finance'].map((role, index) => ({
    id: index + 1,
    email: `${role}@example.edu`,
    password_hash: passwordHash,
    role,
    is_active: true
  }));
  const uploadBuffers = [];
  const reuploadBuffers = [];
  const downloadCalls = [];
  const contents = Buffer.from('%PDF-1.7\nprivate test report');
  const pngContents = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpegContents = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const directory = await temporaryDirectory();
  const filePath = path.join(directory, 'opaque-stored-name.pdf');
  const pngFilePath = path.join(directory, 'opaque-stored-name.png');
  const jpegFilePath = path.join(directory, 'opaque-stored-name.jpg');

  try {
    await fs.writeFile(filePath, contents, { mode: 0o600 });
    await fs.writeFile(pngFilePath, pngContents, { mode: 0o600 });
    await fs.writeFile(jpegFilePath, jpegContents, { mode: 0o600 });
    const documentService = {
      async listDocuments(actorId) {
        return {
          documents: [], searchTerm: '', isStaff: actorId !== 1,
          form137Status: { status: 'not_recorded', instruction: null, created_at: null }
        };
      },
      async upload(_actorId, _body, file) {
        uploadBuffers.push(file.buffer);
        throw new Error('database connection secret');
      },
      async reupload(_actorId, _documentId, file) {
        reuploadBuffers.push(file.buffer);
        throw new Error('database connection secret');
      },
      async openDownload(actorId, documentId) {
        downloadCalls.push([actorId, documentId]);
        if (documentId === '404') throw new DocumentServiceError('Document not found.', 404);
        if (documentId === '89') {
          return {
            document: { original_filename: 'scan.png', mime_type: 'image/png' },
            fileHandle: await fs.open(pngFilePath, 'r'),
            size: pngContents.length
          };
        }
        if (documentId === '90') {
          return {
            document: { original_filename: 'scan.jpeg', mime_type: 'image/jpeg' },
            fileHandle: await fs.open(jpegFilePath, 'r'),
            size: jpegContents.length
          };
        }
        if (documentId === '91') {
          return {
            document: { original_filename: 'broken.pdf', mime_type: 'application/pdf' },
            fileHandle: {
              createReadStream() {
                return new Readable({ read() { this.destroy(new Error('private stream failure')); } });
              },
              async close() {}
            },
            size: 10
          };
        }
        if (documentId !== '88') throw new Error('database connection secret');
        return {
          document: { original_filename: 'Quarter 1 report.pdf', mime_type: 'application/pdf' },
          fileHandle: await fs.open(filePath, 'r'),
          size: contents.length
        };
      }
    };
    const app = createApp({
      databasePool: authPool(users),
      environment: { nodeEnv: 'development', devPasswordOnlyLogin: true, sessionSecret: 'phase-thirteen-document-route-test-secret' },
      documentService,
      documentProcessingService: { schedulePendingProcessing() {} },
      form137ScanService: { async scan() { throw new Error('Form 137 scan is outside this test.'); } }
    });

    await withServer(app, async (baseUrl) => {
      const studentCookie = await login(baseUrl, 'student@example.edu');
      const listResponse = await fetch(`${baseUrl}/documents`, { headers: { cookie: studentCookie } });
      assert.equal(listResponse.status, 200);
      const csrfToken = csrfFromHtml(await listResponse.text());

      const upload = new FormData();
      upload.set('_csrf', csrfToken);
      upload.set('documentType', 'report_card');
      upload.set('document', new Blob([Buffer.from('%PDF-1.7\nupload')], { type: 'application/pdf' }), 'report.pdf');
      const failedUpload = await fetch(`${baseUrl}/documents`, {
        method: 'POST', headers: { cookie: studentCookie }, body: upload, redirect: 'manual'
      });
      const failedUploadHtml = await failedUpload.text();
      assert.equal(failedUpload.status, 503);
      assert.match(failedUploadHtml, /The document could not be uploaded\./);
      assert.doesNotMatch(failedUploadHtml, /database connection secret/);
      assert.ok(uploadBuffers[0].every((byte) => byte === 0), 'failed uploads clear the multipart buffer');

      const correction = new FormData();
      correction.set('_csrf', csrfToken);
      correction.set('document', new Blob([Buffer.from('%PDF-1.7\ncorrected')], { type: 'application/pdf' }), 'corrected.pdf');
      const failedReupload = await fetch(`${baseUrl}/documents/88/reupload`, {
        method: 'POST', headers: { cookie: studentCookie }, body: correction, redirect: 'manual'
      });
      const failedReuploadHtml = await failedReupload.text();
      assert.equal(failedReupload.status, 503);
      assert.match(failedReuploadHtml, /The corrected document could not be uploaded\./);
      assert.doesNotMatch(failedReuploadHtml, /database connection secret/);
      assert.ok(reuploadBuffers[0].every((byte) => byte === 0), 'failed re-uploads clear the multipart buffer');

      const financeCookie = await login(baseUrl, 'finance@example.edu');
      const deniedDownload = await fetch(`${baseUrl}/documents/88/download`, { headers: { cookie: financeCookie } });
      assert.equal(deniedDownload.status, 403);
      assert.deepEqual(downloadCalls, [], 'finance is denied before the file service is called');

      const deniedPreview = await fetch(`${baseUrl}/documents/88/preview`, { headers: { cookie: financeCookie } });
      assert.equal(deniedPreview.status, 403);
      assert.deepEqual(downloadCalls, [], 'finance is denied before the preview service is called');

      const previewed = await fetch(`${baseUrl}/documents/88/preview`, { headers: { cookie: studentCookie } });
      assert.equal(previewed.status, 200);
      assert.equal(previewed.headers.get('content-type'), 'application/pdf');
      assert.equal(previewed.headers.get('content-length'), String(contents.length));
      assert.match(previewed.headers.get('content-disposition'), /^inline;/);
      assert.match(previewed.headers.get('content-disposition'), /filename="document\.pdf"/);
      assert.match(previewed.headers.get('content-disposition'), /filename\*=UTF-8''Quarter%201%20report\.pdf/);
      assert.equal(previewed.headers.get('cache-control'), 'private, no-store');
      assert.equal(previewed.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await previewed.arrayBuffer()), contents);

      const imagePreview = await fetch(`${baseUrl}/documents/89/preview`, { headers: { cookie: studentCookie } });
      assert.equal(imagePreview.status, 200);
      assert.equal(imagePreview.headers.get('content-type'), 'image/png');
      assert.match(imagePreview.headers.get('content-disposition'), /^inline;/);
      assert.deepEqual(Buffer.from(await imagePreview.arrayBuffer()), pngContents);

      const jpegPreview = await fetch(`${baseUrl}/documents/90/preview`, { headers: { cookie: studentCookie } });
      assert.equal(jpegPreview.status, 200);
      assert.equal(jpegPreview.headers.get('content-type'), 'image/jpeg');
      assert.match(jpegPreview.headers.get('content-disposition'), /^inline;/);
      assert.deepEqual(Buffer.from(await jpegPreview.arrayBuffer()), jpegContents);

      const brokenPreview = await fetch(`${baseUrl}/documents/91/preview`, { headers: { cookie: studentCookie } });
      assert.equal(brokenPreview.status, 404);
      const brokenPreviewHtml = await brokenPreview.text();
      assert.match(brokenPreviewHtml, /Document not found\./);
      assert.doesNotMatch(brokenPreviewHtml, /private stream failure/);

      const downloaded = await fetch(`${baseUrl}/documents/88/download`, { headers: { cookie: studentCookie } });
      assert.equal(downloaded.status, 200);
      assert.equal(downloaded.headers.get('content-type'), 'application/pdf');
      assert.equal(downloaded.headers.get('content-length'), String(contents.length));
      assert.match(downloaded.headers.get('content-disposition'), /filename="document\.pdf"/);
      assert.match(downloaded.headers.get('content-disposition'), /filename\*=UTF-8''Quarter%201%20report\.pdf/);
      assert.equal(downloaded.headers.get('cache-control'), 'private, no-store');
      assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), contents);

      const missing = await fetch(`${baseUrl}/documents/404/download`, { headers: { cookie: studentCookie } });
      assert.equal(missing.status, 404);
      assert.match(await missing.text(), /Document not found\./);

      const failedDownload = await fetch(`${baseUrl}/documents/500/download`, { headers: { cookie: studentCookie } });
      const failedDownloadHtml = await failedDownload.text();
      assert.equal(failedDownload.status, 503);
      assert.match(failedDownloadHtml, /The document could not be downloaded\./);
      assert.doesNotMatch(failedDownloadHtml, /database connection secret/);
      assert.deepEqual(downloadCalls, [[1, '88'], [1, '89'], [1, '90'], [1, '91'], [1, '88'], [1, '404'], [1, '500']]);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('download authorization hides missing or non-owned document identifiers', async () => {
  const calls = [];
  const pool = async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.id = @documentId')) return { recordset: [] };
          if (statement.includes('FROM users WHERE id = @actorId')) return { recordset: [{ id: 7, role: 'student' }] };
          throw new Error(`Unexpected read SQL: ${statement}`);
        }
      };
    }
  });
  const directory = await temporaryDirectory();
  try {
    const service = createDocumentService({ getPool: pool, sql: fakeSql(), storageDirectory: directory, maxUploadBytes: 100 });
    await assert.rejects(service.openDownload(7, '88'), (error) => error instanceof DocumentServiceError && error.status === 404);
    assert.equal(calls.some(({ statement }) => statement.includes('s.user_id = @actorId')), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('authorized student download opens the opaque private file only after current ownership lookup', async () => {
  const directory = await temporaryDirectory();
  const storedFilename = `${crypto.randomUUID()}.pdf`;
  const contents = Buffer.from('%PDF-1.7\nprivate');
  const document = {
    id: 88,
    student_id: 44,
    document_type: 'good_moral',
    original_filename: 'my report.pdf',
    stored_filename: storedFilename,
    mime_type: 'application/pdf',
    file_size_bytes: contents.length,
    uploaded_by: 7,
    upload_source: 'student',
    status: 'pending',
    supersedes_document_id: null,
    created_at: new Date(),
    student_user_id: 7,
    student_no: 'S-44',
    first_name: 'Test',
    middle_name: null,
    last_name: 'Student',
    uploader_role: 'student'
  };
  const calls = [];
  const pool = async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push(statement);
          if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.id = @documentId')) {
            return { recordset: values.actorId === 7 && values.documentId === 88 ? [{ ...document }] : [] };
          }
          if (statement.includes('FROM users WHERE id = @actorId')) return { recordset: [{ id: 7, role: 'student' }] };
          if (statement.includes('FROM documents WHERE student_id = @studentId')) return { recordset: [] };
          if (statement.includes('FROM document_review_events AS e')) return { recordset: [] };
          if (statement.includes('FROM document_decision_events AS e')) return { recordset: [] };
          throw new Error(`Unexpected read SQL: ${statement}`);
        }
      };
    }
  });
  try {
    await fs.writeFile(path.join(directory, storedFilename), contents, { mode: 0o600 });
    const service = createDocumentService({ getPool: pool, sql: fakeSql(), storageDirectory: directory, maxUploadBytes: 100 });
    const opened = await service.openDownload(7, '88');
    try {
      assert.equal((await opened.fileHandle.readFile()).toString(), contents.toString());
      assert.equal(opened.document.original_filename, 'my report.pdf');
      assert.equal(opened.size, contents.length);
      assert.match(calls.find((statement) => statement.includes('FROM documents AS d')), /s\.user_id = @actorId/);
    } finally {
      await opened.fileHandle.close();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('students can read only their own active student-origin report cards, never archive rows or Form 137', async () => {
  const directory = await temporaryDirectory();
  const reportFilename = `${crypto.randomUUID()}.pdf`;
  const reportContents = Buffer.from('%PDF-1.7\nstudent-owned report card');
  const calls = [];
  const pool = {
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.startsWith('SELECT id, role FROM users')) return { recordset: [{ id: 7, role: 'student' }] };
          if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.id = @documentId')) {
            const rows = {
              88: { id: 88, document_type: 'psa_birth_certificate', upload_source: 'registrar', student_user_id: 7, uploader_role: 'student' },
              89: { id: 89, document_type: 'psa_birth_certificate', upload_source: 'student', student_user_id: 7, uploader_role: 'registrar' },
              90: { id: 90, document_type: 'psa_birth_certificate', upload_source: 'registrar', student_user_id: 8, uploader_role: 'registrar' },
              91: { id: 91, student_id: 44, document_type: 'report_card', is_legacy_archive: 0, original_filename: 'my-report-card.pdf', stored_filename: reportFilename, mime_type: 'application/pdf', file_size_bytes: reportContents.length, uploaded_by: 7, upload_source: 'student', status: 'needs_review', student_user_id: 7, student_no: 'S-44', first_name: 'Test', middle_name: null, last_name: 'Student', uploader_role: 'student' },
              92: { id: 92, student_id: 45, document_type: 'report_card', is_legacy_archive: 0, upload_source: 'student', student_user_id: 8, uploader_role: 'student' },
              94: { id: 94, student_id: 44, document_type: 'report_card', is_legacy_archive: 1, upload_source: 'student', student_user_id: 7, uploader_role: 'student' },
              95: { id: 95, student_id: 44, document_type: 'report_card', is_legacy_archive: 0, upload_source: 'registrar', student_user_id: 7, uploader_role: 'registrar' },
              93: { id: 93, document_type: 'form_137', upload_source: 'registrar', student_user_id: 7, uploader_role: 'registrar' }
            };
            const row = rows[values.documentId];
            const studentTypeFilter = statement.includes("d.document_type IN ('good_moral', 'psa_birth_certificate')")
              && statement.includes("d.document_type = 'report_card' AND d.is_legacy_archive = 0 AND d.upload_source = 'student'");
            const allowedType = ['good_moral', 'psa_birth_certificate'].includes(row?.document_type)
              || (row?.document_type === 'report_card' && row.is_legacy_archive === 0 && row.upload_source === 'student');
            return { recordset: studentTypeFilter && row?.student_user_id === values.actorId && allowedType ? [row] : [] };
          }
          if (statement.includes('FROM documents AS history_document')) return { recordset: [] };
          if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.student_id = @studentId')) return { recordset: [] };
          if (statement.includes('FROM document_review_events AS e')) return { recordset: [] };
          if (statement.includes('FROM document_decision_events AS e')) return { recordset: [] };
          throw new Error(`Unexpected PSA read SQL: ${statement}`);
        }
      };
    }
  };
  const service = createDocumentService({ getPool: async () => pool, sql: fakeSql(), storageDirectory: directory, maxUploadBytes: 100 });
  await fs.writeFile(path.join(directory, reportFilename), reportContents, { mode: 0o600 });
  try {
  assert.equal((await service.getDocument(7, '88')).upload_source, 'registrar');
  assert.equal((await service.getDocument(7, '89')).upload_source, 'student', 'student can open their own PSA submission');
  assert.equal(await service.getDocument(7, '90'), null, 'another student PSA is not exposed');
  const ownReportCard = await service.getDocument(7, '91');
  assert.equal(ownReportCard.document_type, 'report_card', 'a student can open their active student-origin report card');
  assert.equal(ownReportCard.isArchivedReportCard, false);
  const reportDownload = await service.openDownload(7, '91');
  try {
    assert.equal((await reportDownload.fileHandle.readFile()).toString(), reportContents.toString());
    assert.equal(reportDownload.document.original_filename, 'my-report-card.pdf');
  } finally {
    await reportDownload.fileHandle.close();
  }
  assert.equal(await service.getDocument(7, '92'), null, 'another student report card is not exposed');
  assert.equal(await service.getDocument(7, '94'), null, 'a student cannot open a legacy report-card archive');
  assert.equal(await service.getDocument(7, '95'), null, 'a student cannot open a staff-origin report card');
  assert.equal(await service.getDocument(7, '93'), null, 'a student cannot open a Form 137 file');
  assert.equal(await service.openDownload(7, '94').catch((error) => error.status), 404);
  await assert.rejects(service.openDownload(7, '93'), (error) => error instanceof DocumentServiceError && error.status === 404);
  const documentQuery = calls.find(({ statement }) => statement.includes('WHERE d.id = @documentId'));
  assert.match(documentQuery.statement, /s\.user_id = @actorId/);
  assert.match(documentQuery.statement, /d\.document_type IN \('good_moral', 'psa_birth_certificate'\)/);
  assert.match(documentQuery.statement, /d\.document_type = 'report_card' AND d\.is_legacy_archive = 0 AND d\.upload_source = 'student'/);
  const historyQuery = calls.find(({ statement }) => statement.includes('FROM documents AS history_document'));
  assert.match(historyQuery.statement, /history_document\.is_legacy_archive = 0 AND history_document\.upload_source = 'student'/);
  assert.equal(calls.filter(({ statement }) => statement.includes('WHERE d.id = @documentId')).length, 11);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('legacy report cards remain readable and downloadable only by active staff, without entering review history', async () => {
  const directory = await temporaryDirectory();
  const storedFilename = `${crypto.randomUUID()}.pdf`;
  const contents = Buffer.from('%PDF-1.7\nlegacy archive');
  const calls = [];
  const archivedDocument = {
    id: 88, student_id: 44, document_type: 'report_card', original_filename: 'old-report.pdf',
    is_legacy_archive: 1,
    stored_filename: storedFilename, mime_type: 'application/pdf', file_size_bytes: contents.length,
    uploaded_by: 9, upload_source: 'student', status: 'needs_review', supersedes_document_id: null,
    created_at: new Date(), student_user_id: 7, student_no: 'S-44', first_name: 'Test', middle_name: null,
    last_name: 'Student', uploader_role: 'student'
  };
  const pool = async () => ({
    request() {
      const values = {};
      return {
        input(name, _type, value) { values[name] = value; return this; },
        async query(statement) {
          calls.push({ statement, values: { ...values } });
          if (statement.startsWith('SELECT id, role FROM users WHERE id = @actorId')) {
            return { recordset: [{ id: values.actorId, role: values.actorId === 7 ? 'registrar' : 'student' }] };
          }
          if (statement.includes('FROM documents AS d') && statement.includes('WHERE d.id = @documentId')) {
            return { recordset: values.actorId === 7 ? [{ ...archivedDocument }] : [] };
          }
          if (statement.includes('FROM documents AS history_document')) return { recordset: [{
            id: 88, original_filename: 'old-report.pdf', status: 'needs_review', supersedes_document_id: null,
            created_at: new Date(), latest_review_action: null, latest_decision_type: null
          }] };
          if (statement.startsWith('SELECT CAST(NULL AS SIGNED) AS id WHERE 1 = 0')) return { recordset: [] };
          throw new Error(`Unexpected archive SQL: ${statement}`);
        }
      };
    }
  });
  try {
    await fs.writeFile(path.join(directory, storedFilename), contents, { mode: 0o600 });
    const service = createDocumentService({ getPool: pool, sql: fakeSql(), storageDirectory: directory, maxUploadBytes: 100 });
    const staffView = await service.getDocument(7, '88');
    assert.equal(staffView.isArchivedReportCard, true);
    assert.equal(staffView.validation, null);
    assert.deepEqual(staffView.reviewEvents, []);
    assert.deepEqual(staffView.decisions, []);
  assert.equal(calls.some(({ statement }) => statement.includes('FROM document_validations')), false);

    const download = await service.openDownload(7, '88');
    try {
      assert.equal((await download.fileHandle.readFile()).toString(), contents.toString());
    } finally {
      await download.fileHandle.close();
    }
    await assert.rejects(service.openDownload(8, '88'), (error) => error.status === 404);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
