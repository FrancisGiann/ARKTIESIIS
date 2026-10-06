'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { getPool: defaultGetPool, sql: defaultSql, Transaction } = require('../src/config/database');
const environment = require('../src/config/environment');
const { readPrivateManifest, connectionTarget, PRESERVED_TABLES } = require('./reset-demo-students-mariadb');
const { createPreEnrollmentService } = require('../src/services/preEnrollmentService');
const { RECEIPT_REQUIREMENTS } = require('../src/services/preEnrollmentService');
const { createReadmissionService } = require('../src/services/readmissionService');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');
const { createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { createTermClearanceService } = require('../src/services/termClearanceService');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SEED_KEY = 'arktiesiis-demo-students-v2.017';
const SCHOOL_YEAR_WITH_TERMS = '2026-2027';
const PRE_ENROLLMENT_YEAR = '2027-2028';
const EXPECTED_FIXTURE = Object.freeze({ students: 4, studentAccounts: 4, annuals: 4, assessments: 4,
  preEnrollments: 9, evaluations: 1, verifiedPaperEvents: 0 });
const SOURCE_IDENTITIES = Object.freeze([
  { suffix: 301, grade: 'Grade 11', voucherCode: 'PUB', financeState: 'unpaid', track: 'Academic Track', cluster: 'ASSH (Arts, Social Science, and Humanities)' },
  { suffix: 302, grade: 'Grade 11', voucherCode: 'ESC', financeState: 'partial', track: 'Tech-Pro Track', cluster: 'ICT Support & Computer Programming' },
  { suffix: 303, grade: 'Grade 12', voucherCode: 'NV', financeState: 'settled', track: 'Academic Track', cluster: 'BE (Business & Entrepreneurship)' },
  { suffix: 304, grade: 'Grade 11', voucherCode: 'PUB', financeState: 'unpaid', track: 'Tech-Pro Track', cluster: 'Hospitality and Tourism' }
]);
const RECEIPT_SELECTIONS = Object.freeze({
  report_card: ['photocopy', 1], birth_certificate: ['original', 1], good_moral: ['original', 1],
  junior_high_certificate: ['photocopy', 1], certificate_of_rating: ['photocopy', 1],
  esc_certificate: ['photocopy', 1], national_id: [null, null], two_by_two_photos: ['original', 3],
  long_brown_envelopes: ['photocopy', 3]
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class SeedError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'SeedError'; this.status = status; }
}

function parseOptions(args = []) {
  if (!Array.isArray(args) || args.some((arg) => !['--apply', '--dry-run'].includes(arg)) || new Set(args).size !== args.length
    || args.includes('--apply') && args.includes('--dry-run')) {
    throw new SeedError('Usage: node scripts/seed-demo-students-mariadb.js [--dry-run|--apply]. Dry-run is the default.');
  }
  return { mode: args.includes('--apply') ? 'apply' : 'dry-run' };
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function scenarioFingerprint() {
  return sha256(JSON.stringify({ seedKey: SEED_KEY, expected: EXPECTED_FIXTURE,
    sourceIdentities: SOURCE_IDENTITIES, receiptRequirements: RECEIPT_REQUIREMENTS,
    academicYear: SCHOOL_YEAR_WITH_TERMS, preEnrollmentYear: PRE_ENROLLMENT_YEAR,
    readyNewApplicantYear: { index: 306, schoolYear: SCHOOL_YEAR_WITH_TERMS } }));
}

function normalizeServerIdentity(row = {}) {
  return {
    databaseName: String(row.databaseName || ''), hostname: String(row.hostname || ''),
    port: Number(row.port), serverId: String(row.serverId), version: String(row.version || '')
  };
}

function assertManifestTarget(manifest, { database, target, identity }) {
  if (manifest.databaseName !== database.database || manifest.schemaVersion !== 'v2.017' || manifest.status !== 'completed') {
    throw new SeedError('A completed v2.017 reset manifest for this exact database is required.');
  }
  if (manifest.target?.transport !== target.transport || manifest.target?.endpoint !== target.endpoint) {
    throw new SeedError('The completed reset manifest belongs to a different database endpoint.');
  }
  const planned = normalizeServerIdentity(manifest.serverIdentity);
  const current = normalizeServerIdentity(identity);
  if (JSON.stringify(planned) !== JSON.stringify(current)) {
    throw new SeedError('The live MariaDB server identity differs from the completed reset manifest.');
  }
  if (manifest.fileMode === 'host-manual' && manifest.files.length && manifest.hostFilesRemovedConfirmed !== true) {
    throw new SeedError('The reset manifest still has uploaded-file cleanup pending. Finish and mark file cleanup before seeding.');
  }
}

async function verifyPrivateBackup(filePath, expectedDigest, label) {
  if (!filePath || !path.isAbsolute(filePath) || !/^[a-f0-9]{64}$/i.test(String(expectedDigest || ''))
    || path.resolve(filePath) === PROJECT_ROOT || path.resolve(filePath).startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new SeedError(`A private outside-checkout ${label} backup and SHA-256 are required.`);
  }
  const stats = await fs.lstat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size < 1 || (stats.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new SeedError(`The private ${label} backup is missing or has unsafe permissions.`);
  }
  const digest = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
  if (digest.toLowerCase() !== String(expectedDigest).toLowerCase()) throw new SeedError(`The ${label} backup SHA-256 does not match.`);
}

async function verifyPrivateOutput(filePath) {
  if (!filePath || !path.isAbsolute(filePath) || path.resolve(filePath) === PROJECT_ROOT
    || path.resolve(filePath).startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new SeedError('The student credential artifact must be an absolute path outside the application checkout.');
  }
  const parent = await fs.realpath(path.dirname(filePath)).catch(() => null);
  if (!parent || (await fs.stat(parent)).mode & 0o077
    || typeof process.getuid === 'function' && (await fs.stat(parent)).uid !== process.getuid()) {
    throw new SeedError('The credential artifact directory must be private to the operating-system user.');
  }
  const existing = await fs.lstat(filePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0)) {
    throw new SeedError('The existing credential artifact must be a private regular file.');
  }
  return existing;
}

async function writePrivateCredentials(filePath, artifact) {
  const existing = await verifyPrivateOutput(filePath);
  if (existing) throw new SeedError('The credential artifact already exists; choose a new private path for a new reset-and-seed run.');
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
  return sha256(content);
}

async function inspectCredentialArtifact(filePath, databaseName) {
  const stats = await verifyPrivateOutput(filePath);
  if (!stats) return null;
  const content = await fs.readFile(filePath, 'utf8');
  let artifact;
  try { artifact = JSON.parse(content); }
  catch { throw new SeedError('The private credential artifact is unreadable; do not regenerate credentials on an existing seed.'); }
  if (artifact.seedKey !== SEED_KEY || artifact.database !== databaseName
    || !Array.isArray(artifact.credentials) || artifact.credentials.length !== EXPECTED_FIXTURE.studentAccounts
    || artifact.credentials.some((entry) => typeof entry.email !== 'string' || typeof entry.password !== 'string' || !entry.password)) {
    throw new SeedError('The private credential artifact does not match the completed seed.');
  }
  return { digest: sha256(content), stats };
}

function stringifyRow(row) {
  return JSON.stringify(row, (_key, value) => Buffer.isBuffer(value) ? value.toString('base64') : value);
}

async function tableFingerprint(request, table, where = '') {
  if (!/^[a-z_]+$/.test(table)) throw new SeedError('An unexpected setup table name was supplied.');
  const rows = await request.query(`SELECT * FROM \`${table}\` ${where}`);
  const canonical = (rows.recordset || []).map(stringifyRow).sort();
  return { count: canonical.length, fingerprint: sha256(canonical.join('\n')) };
}

async function preservedFingerprints(pool) {
  const values = {};
  for (const table of PRESERVED_TABLES) values[table] = await tableFingerprint(pool.request(), table);
  values.staffUsers = await tableFingerprint(pool.request(), 'users', "WHERE role <> 'student'");
  return { values, fingerprint: sha256(JSON.stringify(values)) };
}

async function readCounts(pool) {
  const result = await pool.request().query(`SELECT
    (SELECT COUNT(*) FROM students) AS students,
    (SELECT COUNT(*) FROM users WHERE role = 'student') AS studentAccounts,
    (SELECT COUNT(*) FROM annual_enrollments) AS annuals,
    (SELECT COUNT(*) FROM annual_assessments) AS assessments,
    (SELECT COUNT(*) FROM assessed_charges) AS assessedCharges,
    (SELECT COUNT(*) FROM finance_payments) AS payments,
    (SELECT COUNT(*) FROM finance_payment_allocations) AS allocations,
    (SELECT COUNT(*) FROM pre_enrollments) AS preEnrollments,
    (SELECT COUNT(*) FROM readmission_evaluations) AS evaluations,
    (SELECT COUNT(*) FROM student_physical_checklist_events) AS verifiedPaperEvents,
    (SELECT COUNT(*) FROM users WHERE role <> 'student') AS staffUsers`);
  return result.recordset?.[0] || {};
}

function assertEmptyStudentState(counts) {
  const resetDataCounts = ['students', 'studentAccounts', 'annuals', 'assessments', 'assessedCharges', 'payments',
    'allocations', 'preEnrollments', 'evaluations', 'verifiedPaperEvents'];
  if (resetDataCounts.some((key) => Number(counts[key] || 0) !== 0)) {
    throw new SeedError('Student, enrollment, finance, or paper data is already present. Run the guarded reset again before seeding.');
  }
}

async function findSeedMarker(pool, databaseName, queryTypes) {
  const result = await pool.request().input('databaseName', queryTypes.NVarChar(64), databaseName)
    .query(`SELECT details_json FROM audit_logs
      WHERE action = 'maintenance.demo_student_fixture_seeded' AND entity_type = 'database'
        AND entity_id = @databaseName ORDER BY id DESC LIMIT 1`);
  const raw = result.recordset?.[0]?.details_json;
  if (!raw) return null;
  let marker;
  try { marker = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw new SeedError('An existing demo-seed audit marker is unreadable; inspect the target before retrying.'); }
  if (marker.seedKey !== SEED_KEY || marker.seedFingerprint !== scenarioFingerprint()) {
    throw new SeedError('The target contains a different demo-seed marker; no new fixture data was written.');
  }
  return marker;
}

async function acquireSeedLock(pool, databaseName) {
  const connection = await pool.source?.getConnection?.();
  if (!connection) throw new SeedError('The database adapter cannot hold the required demo-seed advisory lock.');
  const lockName = `arktiesiis-demo-seed-${sha256(databaseName).slice(0, 24)}`;
  try {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (Number(rows?.[0]?.acquired) !== 1) throw new SeedError('Another demo seed operation is already active for this database.');
    return { connection, lockName };
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function releaseSeedLock(lock) {
  if (!lock) return;
  try { await lock.connection.query('SELECT RELEASE_LOCK(?)', [lock.lockName]); }
  finally { lock.connection.release(); }
}

function expectedStaffCount(variables) {
  const value = String(variables.DEMO_STUDENT_SEED_EXPECTED_STAFF_USERS || '');
  if (!/^[1-9]\d*$/.test(value)) throw new SeedError('Set the exact preserved staff-account count from the reset preview.');
  return Number(value);
}

function validateAuthorization({ mode, variables, databaseName }) {
  if (variables.DEMO_STUDENT_SEED_ALLOWED_DATABASE !== databaseName) {
    throw new SeedError('The configured database is not the explicitly allowlisted seed target.');
  }
  if (variables.APP_MAINTENANCE_MODE !== 'true' || variables.DEMO_STUDENT_SEED_MAINTENANCE_CONFIRMED !== 'true') {
    throw new SeedError('Confirm that public writes and background workers are paused before demo seeding.');
  }
  if (variables.DEMO_STUDENT_SEED_OUTBOUND_EMAILS_DISABLED !== 'true') {
    throw new SeedError('Confirm that this service-only fixture run will not send outbound email.');
  }
  expectedStaffCount(variables);
  if (mode === 'apply' && variables.DEMO_STUDENT_SEED_CONFIRM !== `SEED DEMO STUDENTS INTO ${databaseName}`) {
    throw new SeedError('Apply requires the exact database-specific seed confirmation phrase.');
  }
}

function lrnFor(suffix) { return `98026110${String(suffix).padStart(4, '0')}`; }

function sourcePayload({ index, schoolYear, applicantKind = 'new', status = 'ready_for_registrar', track = 'Academic Track',
  cluster = 'ASSH (Arts, Social Science, and Humanities)', grade = 'Grade 11', evaluationBinding = '', email, lrn, identity = {} } = {}) {
  const firstNames = ['Ari', 'Bea', 'Cory', 'Dani', 'Eli', 'Faye', 'Gio', 'Hana'];
  const lastNames = ['Santos', 'Reyes', 'Cruz', 'Mendoza', 'Garcia', 'Dela Cruz', 'Flores', 'Ramos'];
  const payload = {
    idempotencyKey: crypto.randomUUID(), schoolYear, firstName: identity.firstName || identity.first_name || `Demo ${firstNames[index % firstNames.length]}`,
    middleName: identity.middleName ?? identity.middle_name ?? 'Sample', lastName: identity.lastName || identity.last_name || lastNames[index % lastNames.length],
    suffix: identity.suffix || '', lrn: lrn || lrnFor(index),
    email: email || identity.email || `demo.student.${index}@example.invalid`, birthDate: identity.birthDate || identity.birth_date || (grade === 'Grade 12' ? '2008-03-14' : '2009-06-21'),
    sex: identity.sex || (index % 2 ? 'Female' : 'Male'), studentContactNumber: identity.studentContactNumber || identity.student_contact_number || `0917123${String(index).padStart(4, '0')}`,
    profilePhone: identity.profilePhone || identity.profile_phone || `0918123${String(index).padStart(4, '0')}`, addressMode: 'replace',
    addressBlockLotStreetPurok: `Block ${index % 20 + 1}, Demo Road`, addressBarangay: 'Ibabang Iyam',
    addressCity: 'Lucena', addressProvince: 'Quezon', addressZip: '4301',
    emergencyContactPerson: `Demo Contact ${index}`, emergencyContactRelationship: 'Parent',
    emergencyContactPhone: `0919123${String(index).padStart(4, '0')}`, emergencyContactAddressMode: 'replace',
    emergencyContactAddressBlockLotStreetPurok: `Lot ${index % 20 + 10}, Sample Street`,
    emergencyContactAddressBarangay: 'Ibabang Iyam', emergencyContactAddressCity: 'Lucena',
    emergencyContactAddressProvince: 'Quezon', emergencyContactAddressZip: '4301',
    motherName: 'Sample Mother', motherPhone: `0920123${String(index).padStart(4, '0')}`,
    fatherName: 'Sample Father', fatherPhone: `0921123${String(index).padStart(4, '0')}`,
    birthplace: 'Lucena City', facebookName: `Demo Student ${index}`,
    voucherTypeText: 'ESC Certificate', voucherCategoryText: 'Paper form notation', preferredTrack: track,
    preferredCluster: cluster, applicantKind, targetGradeLevel: grade,
    priorGradeLevel: grade === 'Grade 12' ? 'Grade 11' : 'Grade 10',
    priorSchool: schoolYear === SCHOOL_YEAR_WITH_TERMS ? 'Demo Junior High School' : 'Demo Senior High School',
    studentSignaturePresent: '1', studentSignedDate: '2026-10-05', receivedBy: 'Demo Front Desk',
    receivedDate: '2026-10-05', status
  };
  if (evaluationBinding) payload.readmissionEvaluationBinding = evaluationBinding;
  for (const [code, [copyType, pieces]] of Object.entries(RECEIPT_SELECTIONS)) {
    if (!copyType) continue;
    payload[`receipt_${code}_${copyType}`] = '1';
    payload[`receipt_${code}_${copyType}_pieces`] = String(pieces);
  }
  if (status === 'draft') {
    payload.firstName = '';
    payload.email = '';
    payload.lrn = '';
    payload.studentSignaturePresent = '';
  }
  return payload;
}

function evaluationInput(applicantLrn, targetGradeLevel = 'Grade 11', identity = {}) {
  return {
    applicantLrn, firstName: identity.first_name || 'Demo Returning', middleName: identity.middle_name || 'Sample',
    lastName: identity.last_name || 'Applicant', suffix: identity.suffix || '',
    schoolYear: PRE_ENROLLMENT_YEAR, targetGradeLevel,
    priorProgress: 'Completed one term of Grade 11 before leaving the fictional sample cohort.',
    evidenceReviewed: 'Registrar inspected the recorded prior-year placement and paper school record.',
    form137Supporting: '1', curriculumComparison: 'Registrar compared completed subjects with the current Grade 11 curriculum.',
    curriculumReviewStatus: 'resolved',
    requiredSubjects: 'Complete the required Grade 11 subjects after schedule review.', subjectAvailability: 'available',
    availabilityNotes: 'All listed required subjects are offered in this retained sample setup.',
    decisionReason: 'Human review required; sample case contains no automated evaluation.'
  };
}

function receiptSource(payload) {
  return payload;
}

function moneyCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new SeedError('A saved assessment amount is invalid.');
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
}

function formatCents(value) { return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`; }

async function runSeed({ args = [], configuration = environment, variables = process.env, getPool = defaultGetPool,
  sql: queryTypes = defaultSql, logger = console, serviceFactory } = {}) {
  const options = parseOptions(args);
  const database = configuration.database;
  const databaseName = String(database?.database || '').trim();
  if (!databaseName || !/^[A-Za-z0-9_$-]{1,64}$/.test(databaseName)) throw new SeedError('A valid configured MariaDB database is required.');
  validateAuthorization({ mode: options.mode, variables, databaseName });
  const target = connectionTarget(database);
  const { manifest } = await readPrivateManifest(variables.DEMO_STUDENT_SEED_RESET_MANIFEST,
    variables.DEMO_STUDENT_SEED_RESET_MANIFEST_SHA256);
  await verifyPrivateBackup(variables.DEMO_STUDENT_SEED_DATABASE_BACKUP_PATH,
    variables.DEMO_STUDENT_SEED_DATABASE_BACKUP_SHA256, 'database');
  await verifyPrivateBackup(variables.DEMO_STUDENT_SEED_UPLOAD_BACKUP_PATH,
    variables.DEMO_STUDENT_SEED_UPLOAD_BACKUP_SHA256, 'uploaded-file');
  const pool = await getPool();
  let seedLock = null;
  try {
    seedLock = await acquireSeedLock(pool, databaseName);
    const identityResult = await pool.request().query(`SELECT DATABASE() AS databaseName, @@hostname AS hostname,
      @@port AS port, @@server_id AS serverId, @@version AS version`);
    const identity = identityResult.recordset?.[0] || {};
    assertManifestTarget(manifest, { database, target, identity });
    const versionResult = await pool.request().query('SELECT version FROM schema_migrations ORDER BY version');
    if (String(versionResult.recordset?.at(-1)?.version || '') !== 'v2.017') throw new SeedError('Demo seeding requires schema v2.017.');

    const counts = await readCounts(pool);
    if (Number(counts.staffUsers) !== expectedStaffCount(variables)) {
      throw new SeedError('The preserved staff roster count differs from the approved reset preview.');
    }
    const preservedBefore = await preservedFingerprints(pool);
    for (const table of PRESERVED_TABLES) {
      if (Number(preservedBefore.values[table].count) !== Number(manifest.preservedCounts?.[table])) {
        throw new SeedError(`The retained setup table differs from the completed reset manifest (${table}).`);
      }
    }
    const existingSeed = await findSeedMarker(pool, databaseName, queryTypes);
    if (existingSeed) {
      if (existingSeed.serverFingerprint !== sha256(JSON.stringify(normalizeServerIdentity(identity)))
        || existingSeed.preservedFingerprint !== preservedBefore.fingerprint) {
        throw new SeedError('The completed seed marker does not match the current endpoint and preserved setup.');
      }
      for (const [key, recorded] of Object.entries(existingSeed.counts || {})) {
        if (counts[key] === undefined || Number(counts[key]) !== Number(recorded)) {
          throw new SeedError('The completed seed inventory changed; no fixture rows were rewritten.');
        }
      }
      const credentialPath = variables.DEMO_STUDENT_SEED_CREDENTIALS_PATH;
      if (!credentialPath) throw new SeedError('The completed seed exists; specify its private credential artifact path for replay verification.');
      const credentialArtifact = await inspectCredentialArtifact(credentialPath, databaseName);
      if (!credentialArtifact || credentialArtifact.digest !== existingSeed.credentialArtifactSha256) {
        throw new SeedError('The completed seed credential artifact is missing or changed; it will not be regenerated or overwritten.');
      }
      const result = { mode: options.mode, alreadySeeded: true, databaseName,
        counts: existingSeed.counts, preservedFingerprint: preservedBefore.fingerprint,
        credentialArtifactPath: credentialPath };
      logger.log(JSON.stringify(result, null, 2));
      return result;
    }
    assertEmptyStudentState(counts);
    const credentialPath = variables.DEMO_STUDENT_SEED_CREDENTIALS_PATH;
    if (!credentialPath) throw new SeedError('Set the absolute private DEMO_STUDENT_SEED_CREDENTIALS_PATH for generated student credentials.');
    if (options.mode === 'apply' && await verifyPrivateOutput(credentialPath)) {
      throw new SeedError('The credential artifact path already exists without a matching seed marker; choose a new private path or reset the target.');
    }
    if (options.mode === 'dry-run') {
      const result = { mode: 'dry-run', databaseName, schemaVersion: 'v2.017',
        serverIdentity: normalizeServerIdentity(identity), target: { transport: target.transport,
          endpointFingerprint: sha256(target.endpoint) }, counts, preservedFingerprint: preservedBefore.fingerprint,
        resetStatus: manifest.status, seedScenarioKey: SEED_KEY };
      logger.log(JSON.stringify(result, null, 2));
      return result;
    }

    const [actorsResult, termsResult] = await Promise.all([
      pool.request().query("SELECT id, role FROM users WHERE is_active = 1 AND role IN ('database_admin','front_desk','registrar','finance')"),
      pool.request().input('schoolYear', queryTypes.NVarChar(20), SCHOOL_YEAR_WITH_TERMS)
        .query(`SELECT configured.term_number, configured.academic_term_id FROM school_year_term_order AS configured
          WHERE configured.school_year = @schoolYear ORDER BY configured.term_number`)
    ]);
    const actors = Object.fromEntries((actorsResult.recordset || []).map((row) => [row.role, Number(row.id)]));
    if (!actors.database_admin || !actors.front_desk || !actors.registrar || !actors.finance) {
      throw new SeedError('The preserved staff roles required by the demo workflow were not found.');
    }
    const termOrder = termsResult.recordset || [];
    if (termOrder.length !== 3 || termOrder.some((row, index) => Number(row.term_number) !== index + 1)) {
      throw new SeedError(`Configure and retain three ordered terms for ${SCHOOL_YEAR_WITH_TERMS} before seeding assessed examples.`);
    }
    const [sectionResult, scheduleResult] = await Promise.all([
      pool.request().input('schoolYear', queryTypes.NVarChar(20), SCHOOL_YEAR_WITH_TERMS)
        .query(`SELECT section.id, section.name, section.grade_level, configured.term_number FROM sections AS section
          INNER JOIN school_year_term_order AS configured ON configured.academic_term_id = section.academic_term_id
          WHERE configured.school_year = @schoolYear ORDER BY configured.term_number, section.grade_level, section.name`),
      pool.request().input('schoolYear', queryTypes.NVarChar(20), SCHOOL_YEAR_WITH_TERMS)
        .query(`SELECT grade_level, voucher_code, COUNT(*) AS count FROM finance_schedules
          WHERE school_year = @schoolYear AND status = 'active' GROUP BY grade_level, voucher_code`)
    ]);
    const sections = sectionResult.recordset || [];
    const schedules = scheduleResult.recordset || [];
    const sectionFor = (grade, termNumber) => {
      const match = sections.find((row) => row.grade_level === grade && Number(row.term_number) === termNumber
        && row.name.includes('STEM A'));
      if (!match) throw new SeedError(`A retained ${grade} section is missing for term ${termNumber}.`);
      return Number(match.id);
    };
    for (const scenario of SOURCE_IDENTITIES) {
      if (!schedules.some((row) => row.grade_level === scenario.grade && row.voucher_code === scenario.voucherCode && Number(row.count) > 0)) {
        throw new SeedError(`A retained active ${scenario.voucherCode} finance schedule is missing for ${scenario.grade}.`);
      }
      for (let termNumber = 1; termNumber <= 3; termNumber += 1) sectionFor(scenario.grade, termNumber);
    }
    const seedPrimaryEmail = String(variables.DEMO_STUDENT_EMAIL || 'demo.student.partial@example.invalid').trim().toLowerCase();
    const existingEmail = await pool.request().input('email', queryTypes.NVarChar(255), seedPrimaryEmail)
      .query('SELECT id FROM users WHERE LOWER(email) = @email LIMIT 1');
    if (existingEmail.recordset?.length) throw new SeedError('The designated demo-student email is already used by a preserved account.');
    const getServices = serviceFactory || ((options) => {
      const preEnrollments = createPreEnrollmentService(options);
      const readmissions = createReadmissionService(options);
      const annualFinance = createAnnualFinanceService(options);
      const termClearance = createTermClearanceService(options);
      const annualEnrollments = createAnnualEnrollmentService({ ...options, annualFinanceService: annualFinance,
        termClearanceService: termClearance,
        hashPassword: (password, rounds) => bcrypt.hash(password, rounds),
        createPassword: () => crypto.randomBytes(24).toString('base64url') });
      return { preEnrollments, readmissions, annualFinance, termClearance, annualEnrollments };
    });
    const services = getServices({ getPool, sql: queryTypes, transactionFactory: (currentPool) => new Transaction(currentPool) });
    const credentials = [];
    const createdSources = [];
    async function createSource(definition) {
      const result = await services.preEnrollments.create(actors.front_desk, sourcePayload(definition));
      const record = await services.preEnrollments.get(actors.registrar, result.id);
      createdSources.push(record);
      return record;
    }
    async function createConfirmedAnnual(source, definition) {
      const input = {
        preEnrollmentId: source.id, preEnrollmentVersion: Number(source.version), idempotencyKey: source.id,
        studentNo: '', email: source.email, lrn: source.lrn, schoolYear: source.school_year,
        gradeLevel: source.target_grade_level, voucherCode: definition.voucherCode,
        entryTermNumber: '1', enrollmentStartDate: '2026-10-05', sectionMode: 'per_term',
        section1Id: String(sectionFor(source.target_grade_level, 1)),
        section2Id: String(sectionFor(source.target_grade_level, 2)),
        section3Id: String(sectionFor(source.target_grade_level, 3))
      };
      const annual = await services.annualEnrollments.createAnnualIntake(actors.registrar, input);
      const preview = await services.annualFinance.annualAssessmentPreviewForRegistrar(actors.registrar, annual.annualEnrollmentId, []);
      if (!preview.lines.length || preview.total === '0.00') throw new SeedError('An expected assessed fee schedule returned no payable charges.');
      if (!services.termClearance || typeof services.termClearance.getAnnualPrerequisiteReview !== 'function') {
        throw new SeedError('The paper-clearance prerequisite review is unavailable for annual confirmation.');
      }
      const clearanceReview = await services.termClearance.getAnnualPrerequisiteReview(actors.registrar, annual.annualEnrollmentId);
      const confirmed = await services.annualEnrollments.confirmAnnualEnrollment(actors.registrar, annual.annualEnrollmentId, {
        idempotencyKey: crypto.randomUUID(), scheduleId: String(preview.scheduleId), scheduleVersion: String(preview.scheduleVersion),
        voucherCode: preview.voucherCode, optionalLineIds: [], snapshotFingerprint: preview.snapshotFingerprint, assessmentId: null,
        clearanceSnapshotFingerprint: clearanceReview.fingerprint
      });
      if (!confirmed.temporaryPassword) throw new SeedError('The new fictional student login was not activated through annual confirmation.');
      credentials.push({ email: source.email, studentNo: confirmed.studentNo,
        name: `${source.first_name} ${source.last_name}`, password: confirmed.temporaryPassword });
      const charges = await pool.request().input('annualEnrollmentId', queryTypes.Int, annual.annualEnrollmentId)
        .query(`SELECT charge.id, CAST(charge.amount AS CHAR(40)) AS amount FROM assessed_charges AS charge
          WHERE charge.annual_enrollment_id = @annualEnrollmentId ORDER BY charge.id`);
      const totalCents = (charges.recordset || []).reduce((sum, row) => sum + moneyCents(row.amount), 0n);
      if (totalCents <= 0n) throw new SeedError('The saved assessment contains no payable assessed charges.');
      if (definition.financeState === 'partial' || definition.financeState === 'settled') {
        let remaining = definition.financeState === 'settled' ? totalCents : totalCents / 2n;
        const allocations = [];
        for (const charge of charges.recordset || []) {
          if (remaining <= 0n) break;
          const due = moneyCents(charge.amount);
          const amount = due < remaining ? due : remaining;
          if (amount > 0n) allocations.push({ chargeId: String(charge.id), amount: formatCents(amount) });
          remaining -= amount;
        }
        if (remaining !== 0n) throw new SeedError('The payment allocations do not cover the requested demo payment.');
        const paymentCents = definition.financeState === 'settled' ? totalCents : totalCents / 2n;
        await services.annualFinance.recordPayment(actors.finance, Number(confirmed.studentId), {
          amount: formatCents(paymentCents), paymentDate: '2026-10-05',
          referenceNo: `DEMO-SEED-${SEED_KEY}-${definition.financeState}-${definition.grade}`.slice(0, 100),
          receiptIssued: true, idempotencyKey: crypto.randomUUID(), allocations
        });
      }
      const ledger = await services.annualFinance.getStudentLedger(actors.finance, Number(confirmed.studentId), 'finance');
      const ledgerBalance = moneyCents(ledger.summary.allYearsAnnualBalance);
      if ((definition.financeState === 'settled' && ledgerBalance !== 0n)
        || (definition.financeState === 'partial' && (ledgerBalance <= 0n || ledgerBalance >= totalCents))
        || (definition.financeState === 'unpaid' && ledgerBalance <= 0n)) {
        throw new SeedError(`The saved canonical finance balance did not match the ${definition.financeState} scenario.`);
      }
      return { annualEnrollmentId: Number(annual.annualEnrollmentId), studentId: Number(confirmed.studentId),
        studentNo: confirmed.studentNo, sourceId: source.id, assessmentTotal: preview.total,
        balance: ledger.summary.allYearsAnnualBalance,
        financialState: definition.financeState };
    }

    // A temporary app-independent seed uses only existing audited intake and finance services; it never invokes mail or document workers.
    const primary = await createSource({ index: 302, schoolYear: SCHOOL_YEAR_WITH_TERMS,
      grade: 'Grade 11', track: 'Tech-Pro Track', cluster: 'ICT Support & Computer Programming', email: seedPrimaryEmail });
    const financialRecords = [];
    for (const definition of SOURCE_IDENTITIES) {
      const source = definition.suffix === 302 ? primary : await createSource({ index: definition.suffix,
        schoolYear: SCHOOL_YEAR_WITH_TERMS, grade: definition.grade, track: definition.track, cluster: definition.cluster,
        email: `demo.student.${definition.suffix}@example.invalid` });
      const created = await createConfirmedAnnual(source, definition);
      financialRecords.push(created);
    }
    const interrupted = financialRecords.find((row) => row.sourceId === createdSources.find((source) => source.lrn === lrnFor(304))?.id);
    if (!interrupted) throw new SeedError('The interrupted student scenario could not be matched to its saved annual record.');
    const firstPlacement = await pool.request().input('annualEnrollmentId', queryTypes.Int, interrupted.annualEnrollmentId)
      .query(`SELECT id FROM enrollments WHERE annual_enrollment_id = @annualEnrollmentId
        AND annual_term_number = 1 AND term_scope_status = 'applicable'`);
    const departure = await services.annualEnrollments.createDepartureCase(actors.registrar, interrupted.annualEnrollmentId,
      Number(firstPlacement.recordset?.[0]?.id), { departureType: 'transferred', effectiveDate: '2026-10-05',
        reason: 'Fictional demonstration case only; transferred from the sample cohort.', idempotencyKey: crypto.randomUUID() });
    if (!departure.departureCaseId) throw new SeedError('The fictional registrar transfer case was not recorded.');

    await services.preEnrollments.create(actors.front_desk, sourcePayload({ index: 305, schoolYear: PRE_ENROLLMENT_YEAR, status: 'draft' }));
    await createSource({ index: 306, schoolYear: SCHOOL_YEAR_WITH_TERMS, track: 'Academic Track',
      cluster: 'ASSH (Arts, Social Science, and Humanities)', grade: 'Grade 11' });
    await createSource({ index: 307, schoolYear: PRE_ENROLLMENT_YEAR, track: 'Tech-Pro Track',
      cluster: 'Hospitality and Tourism', grade: 'Grade 11' });
    const continuingIdentity = createdSources.find((source) => source.lrn === lrnFor(301));
    if (!continuingIdentity || continuingIdentity.email !== `demo.student.301@example.invalid`) {
      throw new SeedError('The continuing paper example does not match its canonical student email.');
    }
    const continuingAnnual = financialRecords.find((record) => record.sourceId === continuingIdentity.id);
    const continuingMaster = await pool.request().input('studentId', queryTypes.Int, continuingAnnual?.studentId)
      .query(`SELECT student.lrn, student.first_name, student.middle_name, student.last_name, student.suffix, account.email
        FROM students AS student INNER JOIN users AS account ON account.id = student.user_id
        WHERE student.id = @studentId AND account.role = 'student'`);
    const continuingSavedStudent = continuingMaster.recordset?.[0];
    if (!continuingAnnual || !continuingSavedStudent
      || continuingSavedStudent.lrn !== continuingIdentity.lrn
      || continuingSavedStudent.first_name !== continuingIdentity.first_name
      || continuingSavedStudent.middle_name !== continuingIdentity.middle_name
      || continuingSavedStudent.last_name !== continuingIdentity.last_name
      || continuingSavedStudent.suffix !== continuingIdentity.suffix
      || continuingSavedStudent.email !== continuingIdentity.email) {
      throw new SeedError('The continuing paper example differs from its canonical saved-student identity.');
    }
    const noGapSource = await createSource({ index: 301, schoolYear: PRE_ENROLLMENT_YEAR, applicantKind: 'continuing',
      track: 'Academic Track', cluster: 'BE (Business & Entrepreneurship)', grade: 'Grade 12', email: continuingIdentity.email });
    if (noGapSource.applicant_kind !== 'continuing' || noGapSource.lrn !== continuingIdentity.lrn
      || noGapSource.first_name !== continuingSavedStudent.first_name || noGapSource.middle_name !== continuingSavedStudent.middle_name
      || noGapSource.last_name !== continuingSavedStudent.last_name || noGapSource.suffix !== continuingSavedStudent.suffix
      || noGapSource.email !== continuingSavedStudent.email) {
      throw new SeedError('The no-gap continuing paper source does not match its canonical student identity.');
    }

    const interruptedIdentity = createdSources.find((source) => source.lrn === lrnFor(304));
    if (!interruptedIdentity || interruptedIdentity.first_name !== 'Demo Ari' || interruptedIdentity.last_name !== 'Santos') {
      throw new SeedError('The balik-aral example does not match its canonical student record.');
    }
    const interruptedAnnual = financialRecords.find((record) => record.sourceId === interruptedIdentity.id);
    const interruptedMaster = await pool.request().input('studentId', queryTypes.Int, interruptedAnnual?.studentId)
      .query(`SELECT student.lrn, student.first_name, student.middle_name, student.last_name, student.suffix, account.email
        FROM students AS student INNER JOIN users AS account ON account.id = student.user_id
        WHERE student.id = @studentId AND account.role = 'student'`);
    const interruptedSavedStudent = interruptedMaster.recordset?.[0];
    if (!interruptedAnnual || !interruptedSavedStudent
      || interruptedSavedStudent.lrn !== interruptedIdentity.lrn
      || interruptedSavedStudent.first_name !== interruptedIdentity.first_name
      || interruptedSavedStudent.middle_name !== interruptedIdentity.middle_name
      || interruptedSavedStudent.last_name !== interruptedIdentity.last_name
      || interruptedSavedStudent.suffix !== interruptedIdentity.suffix
      || interruptedSavedStudent.email !== interruptedIdentity.email) {
      throw new SeedError('The balik-aral sample differs from its canonical saved-student identity.');
    }
    const acceptedEvaluation = await services.readmissions.create(actors.registrar, evaluationInput(lrnFor(304), 'Grade 11', interruptedIdentity));
    const savedEvaluation = await services.readmissions.get(actors.registrar, acceptedEvaluation.id);
    if (savedEvaluation.applicant_lrn !== interruptedSavedStudent.lrn
      || savedEvaluation.first_name !== interruptedSavedStudent.first_name
      || savedEvaluation.middle_name !== interruptedSavedStudent.middle_name
      || savedEvaluation.last_name !== interruptedSavedStudent.last_name
      || savedEvaluation.suffix !== interruptedSavedStudent.suffix) {
      throw new SeedError('The balik-aral evaluation does not match its canonical student identity.');
    }
    const accepted = await services.readmissions.decide(actors.registrar, acceptedEvaluation.id, acceptedEvaluation.version,
      'accepted', 'Accepted after fictional registrar review; subject availability confirmed.');
    const balikPaperSource = await createSource({ index: 308, lrn: lrnFor(304), schoolYear: PRE_ENROLLMENT_YEAR,
      applicantKind: 'readmission', track: 'Tech-Pro Track', cluster: 'Hospitality and Tourism', grade: 'Grade 11',
      email: interruptedIdentity.email, identity: interruptedIdentity,
      evaluationBinding: `${accepted.id}@${accepted.version}` });
    if (balikPaperSource.first_name !== interruptedSavedStudent.first_name
      || balikPaperSource.middle_name !== interruptedSavedStudent.middle_name
      || balikPaperSource.last_name !== interruptedSavedStudent.last_name
      || balikPaperSource.suffix !== interruptedSavedStudent.suffix
      || balikPaperSource.email !== interruptedSavedStudent.email
      || balikPaperSource.lrn !== interruptedSavedStudent.lrn
      || balikPaperSource.readmission_evaluation_id !== accepted.id
      || Number(balikPaperSource.readmission_evaluation_version) !== accepted.version) {
      throw new SeedError('The balik-aral paper source does not match its canonical accepted evaluation and student.');
    }
    const finalCounts = await readCounts(pool);
    for (const [key, expected] of Object.entries(EXPECTED_FIXTURE)) {
      if (Number(finalCounts[key]) !== expected) throw new SeedError(`The final demo inventory does not match the expected ${key} count.`);
    }
    if (Number(finalCounts.assessedCharges) < 4 || Number(finalCounts.payments) !== 2 || Number(finalCounts.allocations) < 2) {
      throw new SeedError('The assessed fee and payment examples are incomplete.');
    }
    const preservedAfter = await preservedFingerprints(pool);
    if (preservedAfter.fingerprint !== preservedBefore.fingerprint) throw new SeedError('A staff credential or retained setup row changed during seeding.');
    const credentialArtifact = { generatedAt: new Date().toISOString(), purpose: 'Fictional v2.017 demonstration student credentials',
      database: databaseName, seedKey: SEED_KEY, credentials };
    const credentialArtifactSha256 = await writePrivateCredentials(credentialPath, credentialArtifact);
    const marker = {
      seedKey: SEED_KEY, seedFingerprint: scenarioFingerprint(),
      serverFingerprint: sha256(JSON.stringify(normalizeServerIdentity(identity))),
      preservedFingerprint: preservedAfter.fingerprint, credentialArtifactSha256, counts: finalCounts,
      academicYear: SCHOOL_YEAR_WITH_TERMS, preEnrollmentYear: PRE_ENROLLMENT_YEAR,
      readmissionStatuses: { accepted: accepted.status },
      completedAt: new Date().toISOString()
    };
    await pool.request().input('actorId', queryTypes.Int, actors.database_admin)
      .input('databaseName', queryTypes.NVarChar(64), databaseName)
      .input('details', queryTypes.NVarChar(queryTypes.MAX), JSON.stringify(marker))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, 'maintenance.demo_student_fixture_seeded', 'database', @databaseName, @details)`);
    const result = { mode: 'apply', alreadySeeded: false, databaseName, counts: finalCounts,
      financialOutcomes: financialRecords.map((record) => ({ state: record.financialState, assessed: record.assessmentTotal,
        remaining: record.balance })),
      readmissionStatuses: marker.readmissionStatuses, preservedFingerprint: preservedAfter.fingerprint,
      staffUserFingerprint: preservedAfter.values.staffUsers.fingerprint, credentialArtifactPath: credentialPath };
    logger.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    try { await releaseSeedLock(seedLock); }
    finally { if (typeof pool.close === 'function') await pool.close(); }
  }
}

if (require.main === module) {
  runSeed({ args: process.argv.slice(2) }).catch((error) => {
    const message = error instanceof SeedError ? error.message
      : 'Demo seeding stopped safely. Inspect the target before any retry; no credential values were printed.';
    console.error(`Demo seed stopped: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = { SeedError, SEED_KEY, EXPECTED_FIXTURE, parseOptions, scenarioFingerprint,
  normalizeServerIdentity, assertManifestTarget, validateAuthorization, verifyPrivateBackup,
  sourcePayload, evaluationInput, runSeed };
