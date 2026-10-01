const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseOptions,
  assertLocalDatabase,
  cleanupSchoolDemoData,
  removeReplacedDemoDocuments,
  snapshotPrivateTree,
  classifyPrivateDemoAssets,
  safeDirectory,
  SchoolResetError
} = require('../scripts/reset-school-demo');

test('reset commands require a private rehearsal manifest for apply', () => {
  assert.deepEqual(parseOptions(['--dry-run']), { mode: 'dry-run' });
  assert.deepEqual(parseOptions(['--rehearse']), { mode: 'rehearse' });
  assert.deepEqual(parseOptions(['--apply', '--evidence', '/tmp/school-demo-rehearsal/manifest.json']), {
    mode: 'apply', evidencePath: '/tmp/school-demo-rehearsal/manifest.json'
  });
  assert.throws(() => parseOptions(['--apply']), SchoolResetError);
  assert.throws(() => parseOptions(['--apply', '--evidence', '/tmp/manifest.json', '--force']), SchoolResetError);
  assert.throws(() => parseOptions(['--rehearse', '--force']), SchoolResetError);
});

test('reset guard accepts only loopback development V2 and generated rehearsal names', () => {
  const local = { nodeEnv: 'development', database: { server: 'localhost', database: 'ARKTIESIIS_V2' } };
  assert.doesNotThrow(() => assertLocalDatabase(local));
  assert.doesNotThrow(() => assertLocalDatabase(local, 'ARKTIESIIS_V2_REHEARSAL_20261001_123456_a1b2c3'));
  assert.throws(() => assertLocalDatabase({ ...local, nodeEnv: 'production' }), SchoolResetError);
  assert.throws(() => assertLocalDatabase({ ...local, database: { ...local.database, server: 'db.example' } }), SchoolResetError);
  assert.throws(() => assertLocalDatabase(local, 'ARKTIESIIS'), SchoolResetError);
});

test('backup path validation refuses to loosen an existing shared directory', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'school-reset-permissions-'));
  const backupDirectory = path.join(temporaryRoot, 'school-demo-rehearsal');
  try {
    fs.mkdirSync(backupDirectory, { mode: 0o755 });
    fs.chmodSync(backupDirectory, 0o755);
    assert.throws(() => safeDirectory(backupDirectory), /already have private 0700 permissions/);
    assert.equal(fs.statSync(backupDirectory).mode & 0o077, 0o055);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('cleanup refuses to start until paired backup and restore evidence exists', async () => {
  await assert.rejects(() => cleanupSchoolDemoData({ pool: null, databaseName: 'ARKTIESIIS_V2',
    configuration: { nodeEnv: 'development', database: { server: '127.0.0.1', database: 'ARKTIESIIS_V2' } } }),
  /Verified database and private-document backups plus an isolated restore are required/);
});

test('private demo cleanup removes only backed-up, provenance-matched assets and preserves unknown files', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'school-reset-documents-'));
  try {
    const moral = fs.readFileSync(path.join(__dirname, 'fixtures/ocr/synthetic-two-page.pdf'));
    const psa = fs.readFileSync(path.join(__dirname, 'fixtures/ocr/synthetic-png.png'));
    const workbook = fs.readFileSync(path.join(__dirname, 'fixtures/grade-import/corrected-mini.xlsx'));
    const docs = [
      { id: 1, studentId: 1, originalFilename: 'SYNTHETIC-DEFENSE-ONLY-Good-Moral-NOT-OFFICIAL.pdf', storedFilename: 'moral.pdf', fileSizeBytes: moral.length },
      { id: 2, studentId: 2, originalFilename: 'SYNTHETIC-DEFENSE-ONLY-PSA-NOT-OFFICIAL.png', storedFilename: 'psa.png', fileSizeBytes: psa.length },
      { id: 3, studentId: 321, originalFilename: 'SYNTHETIC-E2E-Good-Moral-NOT-OFFICIAL.pdf', storedFilename: 'e2e-moral.pdf', fileSizeBytes: moral.length }
    ];
    const submissions = [
      { id: '72052464-5f0e-4a3c-bd4f-fc7953d09f82', previousSubmissionId: null,
        storageKey: '917adb99-283c-43ed-98d1-ab75dce6fbd2', originalFilename: 'SYNTHETIC-E2E-Corrected-SSHS-ECR.xlsx',
        fileSizeBytes: workbook.length, status: 'correction_requested', revision: 1, assignmentId: 15 },
      { id: 'a8f8ac00-da3d-4482-941b-50fa48e6fd33', previousSubmissionId: '72052464-5f0e-4a3c-bd4f-fc7953d09f82',
        storageKey: '3c3a7680-8da7-4445-9883-338bdb119e4a', originalFilename: 'SYNTHETIC-E2E-Corrected-SSHS-ECR.xlsx',
        fileSizeBytes: workbook.length, status: 'approved', revision: 2, assignmentId: 15 }
    ];
    fs.mkdirSync(path.join(temporaryRoot, 'teacher-grade-submissions'));
    fs.writeFileSync(path.join(temporaryRoot, 'moral.pdf'), moral);
    fs.writeFileSync(path.join(temporaryRoot, 'psa.png'), psa);
    fs.writeFileSync(path.join(temporaryRoot, 'e2e-moral.pdf'), moral);
    fs.writeFileSync(path.join(temporaryRoot, 'duplicate-moral.pdf'), moral);
    fs.writeFileSync(path.join(temporaryRoot, 'duplicate-psa.png'), psa);
    fs.writeFileSync(path.join(temporaryRoot, 'teacher-grade-submissions/917adb99-283c-43ed-98d1-ab75dce6fbd2.xlsx'), workbook);
    fs.writeFileSync(path.join(temporaryRoot, 'teacher-grade-submissions/3c3a7680-8da7-4445-9883-338bdb119e4a.xlsx'), workbook);
    fs.writeFileSync(path.join(temporaryRoot, 'attested-prototype.jpg'), 'user-attested private prototype asset');
    fs.writeFileSync(path.join(temporaryRoot, 'unclassified.bin'), 'preserve pending classification');
    fs.writeFileSync(path.join(temporaryRoot, '.gitkeep'), '');
    const attestedBytes = fs.readFileSync(path.join(temporaryRoot, 'attested-prototype.jpg'));
    const userAttestedFiles = [{ path: 'attested-prototype.jpg', size: attestedBytes.length,
      sha256: crypto.createHash('sha256').update(attestedBytes).digest('hex') }];
    const completedE2e = { assignmentId: 15, submissionId: submissions[1].id };
    const expectedStorageSnapshot = snapshotPrivateTree(temporaryRoot);
    const plan = classifyPrivateDemoAssets({ documentInventory: docs, teacherSubmissionInventory: submissions,
      completedE2e, expectedStorageSnapshot, userAttestedFiles });
    assert.deepEqual(plan.issues, []);
    assert.equal(plan.removals.length, 8);
    assert.deepEqual(plan.unclassifiedFiles.map((file) => file.path), ['unclassified.bin']);
    assert.equal(plan.preservedScaffolding.length, 1);

    fs.writeFileSync(path.join(temporaryRoot, 'unclassified.bin'), 'changed after backup');
    assert.throws(() => removeReplacedDemoDocuments({ storageDirectory: temporaryRoot, documentInventory: docs,
      teacherSubmissionInventory: submissions, completedE2e, expectedStorageSnapshot, userAttestedFiles }), /changed after its paired backup/);
    assert.ok(fs.existsSync(path.join(temporaryRoot, 'moral.pdf')));
    fs.writeFileSync(path.join(temporaryRoot, 'unclassified.bin'), 'preserve pending classification');
    const removed = removeReplacedDemoDocuments({ storageDirectory: temporaryRoot, documentInventory: docs,
      teacherSubmissionInventory: submissions, completedE2e, expectedStorageSnapshot, userAttestedFiles });
    assert.equal(removed.removedFiles, 8);
    assert.deepEqual(removed.unclassifiedFiles.map((file) => file.path), ['unclassified.bin']);
    assert.ok(fs.existsSync(path.join(temporaryRoot, '.gitkeep')));
    assert.ok(fs.existsSync(path.join(temporaryRoot, 'unclassified.bin')));
    for (const file of plan.removals) assert.equal(fs.existsSync(path.join(temporaryRoot, file.path)), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
