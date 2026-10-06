'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SeedError, SEED_KEY, EXPECTED_FIXTURE, parseOptions, scenarioFingerprint,
  normalizeServerIdentity, assertManifestTarget, validateAuthorization, sourcePayload, evaluationInput } = require('../scripts/seed-demo-students-mariadb');

test('demo student seed defaults to preview and only accepts one explicit operation', () => {
  assert.deepEqual(parseOptions([]), { mode: 'dry-run' });
  assert.deepEqual(parseOptions(['--dry-run']), { mode: 'dry-run' });
  assert.deepEqual(parseOptions(['--apply']), { mode: 'apply' });
  assert.throws(() => parseOptions(['--dry-run', '--apply']), SeedError);
  assert.throws(() => parseOptions(['--force']), SeedError);
});

test('demo seed apply requires an allowlisted database, verified maintenance and no outbound mail', () => {
  const databaseName = 'ark_demo_students';
  const variables = {
    DEMO_STUDENT_SEED_ALLOWED_DATABASE: databaseName,
    DEMO_STUDENT_SEED_MAINTENANCE_CONFIRMED: 'true',
    DEMO_STUDENT_SEED_OUTBOUND_EMAILS_DISABLED: 'true',
    DEMO_STUDENT_SEED_EXPECTED_STAFF_USERS: '9',
    DEMO_STUDENT_SEED_CONFIRM: `SEED DEMO STUDENTS INTO ${databaseName}`,
    APP_MAINTENANCE_MODE: 'true'
  };
  assert.doesNotThrow(() => validateAuthorization({ mode: 'apply', variables, databaseName }));
  assert.throws(() => validateAuthorization({ mode: 'apply', variables: { ...variables, APP_MAINTENANCE_MODE: 'false' }, databaseName }), /workers are paused/);
  assert.throws(() => validateAuthorization({ mode: 'apply', variables: { ...variables, DEMO_STUDENT_SEED_OUTBOUND_EMAILS_DISABLED: 'false' }, databaseName }), /outbound email/);
  assert.throws(() => validateAuthorization({ mode: 'apply', variables: { ...variables, DEMO_STUDENT_SEED_ALLOWED_DATABASE: 'another_db' }, databaseName }), /allowlisted/);
  assert.throws(() => validateAuthorization({ mode: 'apply', variables: { ...variables, DEMO_STUDENT_SEED_EXPECTED_STAFF_USERS: '0' }, databaseName }), /staff-account count/);
  assert.throws(() => validateAuthorization({ mode: 'apply', variables: { ...variables, DEMO_STUDENT_SEED_CONFIRM: 'SEED DEMO STUDENTS' }, databaseName }), /confirmation phrase/);
});

test('demo seed replay is bound to the completed schema, configured endpoint and live server identity', () => {
  const database = { database: 'ark_demo_students', host: 'localhost', port: 3307 };
  const target = { transport: 'tcp', endpoint: 'localhost:3307' };
  const identity = normalizeServerIdentity({ databaseName: database.database, hostname: 'local-fixture', port: 3307, serverId: 44, version: '11.8.9-MariaDB' });
  const manifest = { databaseName: database.database, schemaVersion: 'v2.017', status: 'completed', target,
    serverIdentity: identity, fileMode: 'local-exact', files: [] };
  assert.doesNotThrow(() => assertManifestTarget(manifest, { database, target, identity }));
  assert.throws(() => assertManifestTarget({ ...manifest, status: 'pending_host_files' }, { database, target, identity }), /completed v2.017 reset manifest/);
  assert.throws(() => assertManifestTarget(manifest, { database, target: { ...target, endpoint: 'other:3307' }, identity }), /different database endpoint/);
  assert.throws(() => assertManifestTarget(manifest, { database, target, identity: { ...identity, serverId: '45' } }), /server identity differs/);
  assert.notEqual(scenarioFingerprint(), '');
  assert.equal(SEED_KEY, 'arktiesiis-demo-students-v2.017');
});

test('fixture profiles include complete required paper identity, both address records and receipt-only quantities', () => {
  const ready = sourcePayload({ index: 302, schoolYear: '2026-2027', status: 'ready_for_registrar' });
  assert.equal(ready.email, 'demo.student.302@example.invalid');
  assert.equal(ready.lrn.length, 12);
  assert.equal(ready.addressZip, '4301');
  assert.equal(ready.emergencyContactAddressZip, '4301');
  assert.equal(ready.receipt_two_by_two_photos_original_pieces, '3');
  assert.equal(ready.receipt_long_brown_envelopes_photocopy_pieces, '3');
  assert.equal(Object.keys(ready).filter((key) => key.startsWith('receipt_')).length, 16);

  const retainedYearReady = sourcePayload({ index: 306, schoolYear: '2026-2027' });
  assert.equal(retainedYearReady.status, 'ready_for_registrar');
  assert.equal(retainedYearReady.schoolYear, '2026-2027', 'one ready new-applicant example can use the preserved configured terms');
  const canonicalReadmission = sourcePayload({ index: 308, schoolYear: '2027-2028', lrn: '980261100304',
    identity: { first_name: 'Demo Ari', middle_name: 'Sample', last_name: 'Santos', email: 'demo.student.304@example.invalid' } });
  assert.equal(canonicalReadmission.firstName, 'Demo Ari');
  assert.equal(canonicalReadmission.lastName, 'Santos');
  assert.equal(canonicalReadmission.email, 'demo.student.304@example.invalid');

  const draft = sourcePayload({ index: 305, schoolYear: '2027-2028', status: 'draft' });
  assert.equal(draft.email, '');
  assert.equal(draft.lrn, '');
  assert.equal(draft.receipt_two_by_two_photos_original_pieces, '3');
  assert.equal(EXPECTED_FIXTURE.preEnrollments, 9);
  assert.equal(EXPECTED_FIXTURE.verifiedPaperEvents, 0);
});

test('readmission sample carries human-reviewed evidence and a new target school year', () => {
  const input = evaluationInput('980261100304');
  assert.equal(input.schoolYear, '2027-2028');
  assert.ok(input.evidenceReviewed);
  assert.ok(input.curriculumComparison);
  assert.ok(input.requiredSubjects);
  assert.equal(input.subjectAvailability, 'available');
  assert.equal(input.curriculumReviewStatus, 'resolved');
});
