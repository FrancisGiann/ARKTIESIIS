'use strict';

const { isIP } = require('node:net');
const environment = require('../src/config/environment');
const database = require('../src/config/database');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');
const { createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { buildExpansionPlan, stableUuid, fingerprint, EXPANSION_MARKER, HOSTINGER_SEED_MARKER,
  SCHOOL_YEAR, REQUIRED_VERSIONS, REQUIRED_OBJECTS } = require('./expand-hostinger-demo');

const ACTIVATION_MARKER = 'hostinger-demo-enrollment-activation-v1';
const APPLICATION_LOCK = 'ARKTIESIIS Hostinger demo enrollment activation v1';
const ACTIVATION_ORDINALS = Object.freeze([
  ...Array.from({ length: 10 }, (_, index) => index + 22),
  ...Array.from({ length: 10 }, (_, index) => index + 51)
]);

class ActivationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ActivationError';
    this.status = status;
  }
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function parseOptions(args, configuredDatabase = environment.database.database) {
  if (!Array.isArray(args)) throw new ActivationError('Activation arguments are invalid.');
  const options = { mode: null, targetDatabase: null, confirmDatabase: null, seedMarker: null, expansionMarker: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (options.mode) throw new ActivationError('Choose exactly one mode: --dry-run or --apply.');
      options.mode = argument.slice(2);
    } else if (['--target-database', '--confirm-database', '--confirm-seed-marker', '--confirm-expansion-marker'].includes(argument)) {
      if (seen.has(argument) || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new ActivationError(`Provide one value for ${argument}.`);
      }
      if (argument === '--target-database') options.targetDatabase = args[index + 1];
      if (argument === '--confirm-database') options.confirmDatabase = args[index + 1];
      if (argument === '--confirm-seed-marker') options.seedMarker = args[index + 1];
      if (argument === '--confirm-expansion-marker') options.expansionMarker = args[index + 1];
      seen.add(argument);
      index += 1;
    } else {
      throw new ActivationError('Activation arguments are invalid.');
    }
  }
  if (!options.mode || !options.targetDatabase || !options.confirmDatabase || !options.seedMarker || !options.expansionMarker) {
    throw new ActivationError('Provide a mode, the exact database name twice, and the exact Hostinger seed and expansion markers.');
  }
  if (options.targetDatabase !== options.confirmDatabase || options.targetDatabase !== configuredDatabase) {
    throw new ActivationError('Both confirmed database names must exactly match DB_NAME.');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.targetDatabase)) throw new ActivationError('The target database name is invalid.');
  if (options.seedMarker !== HOSTINGER_SEED_MARKER) throw new ActivationError('Confirm the exact hostinger-demo-seed-v1 marker.');
  if (options.expansionMarker !== EXPANSION_MARKER) throw new ActivationError(`Confirm the exact ${EXPANSION_MARKER} marker.`);
  return options;
}

function validateProductionTarget(configuration = environment) {
  if (configuration.nodeEnv !== 'production') throw new ActivationError('Demo enrollment activation requires NODE_ENV=production.');
  if (configuration.devPasswordOnlyLogin) throw new ActivationError('The development password-only login must remain disabled.');
  const db = configuration.database || {};
  const host = String(db.host || '').trim().toLowerCase();
  const addressType = isIP(host);
  if (!host || host === 'localhost' || host === '::1' || (addressType === 4 && /^127\./.test(host))) {
    throw new ActivationError('Activation requires the remote MariaDB host from hPanel.');
  }
  if (!db.database || !db.user || String(db.user).toLowerCase() === 'root' || !db.password) {
    throw new ActivationError('DB_NAME, DB_USER, and DB_PASSWORD must identify the existing hPanel database.');
  }
}

async function execute(connection, statement, values = []) {
  return connection.execute(statement, values);
}

async function readRows(connection, statement, values = []) {
  const [rows] = await execute(connection, statement, values);
  return rows;
}

function buildActivationPlan() {
  const expansion = buildExpansionPlan();
  const annualStudents = new Map(expansion.annualStudents.map((student) => [student.ordinal, student]));
  const selected = ACTIVATION_ORDINALS.map((ordinal) => annualStudents.get(ordinal));
  if (selected.some((student) => !student) || selected.length !== 20) {
    throw new ActivationError('The reserved activation selection does not match the Hostinger demo expansion.');
  }
  return {
    expansion,
    selected,
    selectedByOrdinal: new Map(selected.map((student) => [student.ordinal, student])),
    selectedByAnnualKey: new Map(selected.map((student) => [student.annualKey, student])),
    expectedGradeCounts: { 'Grade 11': 10, 'Grade 12': 10 }
  };
}

function parseJson(value, message) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new ActivationError(message); }
}

async function requireExpectedSchema(connection) {
  const versions = await readRows(connection, 'SELECT version FROM schema_migrations ORDER BY version');
  const applied = versions.map(({ version }) => String(version));
  if (applied.length !== REQUIRED_VERSIONS.length || REQUIRED_VERSIONS.some((version) => !applied.includes(version))) {
    throw new ActivationError('Activation requires the complete MariaDB v2.011 schema.');
  }
  const objects = await readRows(connection,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (${placeholders(REQUIRED_OBJECTS.length)})`,
    REQUIRED_OBJECTS);
  const found = new Set(objects.map(({ table_name }) => String(table_name)));
  if (REQUIRED_OBJECTS.some((name) => !found.has(name))
    || !found.has('annual_registrar_confirmations')) {
    throw new ActivationError('The selected database is missing expected MariaDB demo schema objects.');
  }
}

async function requireHostingerMarkers(connection) {
  const seeds = await readRows(connection,
    `SELECT marker.id FROM audit_logs AS marker
      INNER JOIN users AS actor ON actor.id = marker.user_id AND actor.role = 'database_admin'
      WHERE marker.entity_type = ? AND marker.entity_id = ?`,
    ['school_demo_seed', HOSTINGER_SEED_MARKER]);
  if (seeds.length !== 1) throw new ActivationError('The exact Hostinger demo seed marker was not found.');

  const expansions = await readRows(connection,
    `SELECT marker.id, marker.details_json FROM audit_logs AS marker
      INNER JOIN users AS actor ON actor.id = marker.user_id AND actor.role = 'database_admin'
      WHERE marker.entity_type = ? AND marker.entity_id = ?`,
    ['school_demo_expansion', EXPANSION_MARKER]);
  if (expansions.length !== 1) throw new ActivationError('The exact Hostinger demo expansion marker was not found.');
  const details = parseJson(expansions[0].details_json, 'The Hostinger expansion audit marker is invalid.');
  const counts = details?.counts || {};
  if (details?.version !== 1 || Number(counts.students) !== 99 || Number(counts.legacyStyleStudents) !== 20
    || Number(counts.pendingAnnualStudents) !== 79 || Number(counts.annualEnrollments) !== 79
    || Number(counts.pendingTermPlacements) !== 237 || Number(counts.registrarConfirmations) !== 0) {
    throw new ActivationError('The expansion audit marker does not match the expected one-time 99-student demo fixture.');
  }

  const used = await readRows(connection,
    'SELECT id FROM audit_logs WHERE entity_type = ? AND entity_id = ? LIMIT 1',
    ['school_demo_enrollment_activation', ACTIVATION_MARKER]);
  if (used.length) throw new ActivationError('The one-time Hostinger demo enrollment activation was already completed.');
  return details;
}

function expectedStudentFields(student) {
  return {
    student_no: student.studentNo,
    lrn: student.lrn,
    first_name: student.firstName,
    middle_name: student.middleName,
    last_name: student.lastName,
    sex: student.sex,
    address: student.address,
    status: 'active'
  };
}

async function requireExactExpansionRows(connection, plan) {
  const actors = await requireHostingerActors(connection);
  const studentRows = await readRows(connection,
    `SELECT id, user_id, student_no, lrn, first_name, middle_name, last_name, sex, address, status
      FROM students WHERE student_no BETWEEN ? AND ? ORDER BY student_no`, ['DEMO-HOSTINGER-0002', 'DEMO-HOSTINGER-0100']);
  const expectedStudents = plan.expansion.students;
  const rowsByStudentNo = new Map(studentRows.map((row) => [String(row.student_no), row]));
  if (studentRows.length !== expectedStudents.length
    || expectedStudents.some((student) => {
      const row = rowsByStudentNo.get(student.studentNo);
      return !row || row.user_id != null || Object.entries(expectedStudentFields(student))
        .some(([field, value]) => row[field] !== value);
    })) {
    throw new ActivationError('The 99 fictional Hostinger expansion students do not match their reserved records or contain linked accounts.');
  }

  const expansionStudentIds = expectedStudents.map((student) => Number(rowsByStudentNo.get(student.studentNo).id));
  const annualRows = await readRows(connection,
    `SELECT annual.id, annual.student_id, annual.school_year, annual.grade_level, annual.voucher_code,
        annual.intake_status, annual.account_activation_pending, annual.created_by,
        annual.intake_kind, annual.entry_term_number,
        annual.idempotency_key, annual.request_fingerprint,
        assessment.id AS assessment_id, assessment.schedule_id, assessment.schedule_version,
        assessment.voucher_code_snapshot, assessment.selection_json, schedule.idempotency_key AS schedule_key
      FROM annual_enrollments AS annual
      LEFT JOIN annual_assessments AS assessment ON assessment.annual_enrollment_id = annual.id
      LEFT JOIN finance_schedules AS schedule ON schedule.id = assessment.schedule_id
      WHERE annual.student_id IN (${placeholders(expansionStudentIds.length)})`, expansionStudentIds);
  const annualByKey = new Map(annualRows.map((row) => [String(row.idempotency_key), row]));
  if (annualRows.length !== 79 || annualByKey.size !== 79) {
    throw new ActivationError('The expected 79 annual enrollment fixtures could not be verified.');
  }
  const annualByOrdinal = new Map();
  for (const student of plan.expansion.annualStudents) {
    const row = annualByKey.get(student.annualKey);
    const studentRow = rowsByStudentNo.get(student.studentNo);
    const expectedSchedule = plan.expansion.schedules.find((schedule) =>
      schedule.gradeLevel === student.gradeLevel && schedule.voucherCode === student.voucherCode);
    const expectedAnnualFingerprint = fingerprint({ studentNo: student.studentNo, schoolYear: SCHOOL_YEAR });
    if (!row || Number(row.student_id) !== Number(studentRow.id) || row.school_year !== SCHOOL_YEAR
      || row.grade_level !== student.gradeLevel || row.voucher_code !== student.voucherCode
      || Number(row.created_by) !== actors.adminId
      || row.intake_kind !== 'new' || Number(row.entry_term_number) !== 1
      || row.account_activation_pending !== 0 && row.account_activation_pending !== false
      || row.request_fingerprint !== expectedAnnualFingerprint || !row.assessment_id
      || Number(row.schedule_version) !== 1 || row.voucher_code_snapshot !== student.voucherCode
      || String(row.schedule_key) !== expectedSchedule.idempotencyKey) {
      throw new ActivationError('An annual intake or its existing fee assessment differs from the reserved demo fixture.');
    }
    const selection = parseJson(row.selection_json, 'A saved demo assessment selection could not be validated.');
    if (!selection || !Array.isArray(selection.optionalLineIds) || selection.optionalLineIds.length !== 0) {
      throw new ActivationError('A demo fee assessment has a changed optional-fee selection.');
    }
    const keyExpected = stableUuid(`annual:${student.ordinal}`);
    if (String(row.idempotency_key) !== keyExpected) throw new ActivationError('An annual intake identifier differs from the reserved demo fixture.');
    const selected = plan.selectedByOrdinal.has(student.ordinal);
    if (row.intake_status !== 'pending' && !(selected && row.intake_status === 'enrolled')) {
      throw new ActivationError('An annual intake is outside the expected pending or activation replay state.');
    }
    annualByOrdinal.set(student.ordinal, row);
  }

  const annualIds = annualRows.map(({ id }) => Number(id));
  const placements = await readRows(connection,
    `SELECT enrollment.id, enrollment.student_id, enrollment.annual_enrollment_id, enrollment.academic_term_id,
        enrollment.section_id, enrollment.enrollment_status, enrollment.finalized_at, enrollment.annual_term_number,
        enrollment.term_scope_status, annual.grade_level, annual.intake_status, annual.student_id AS annual_student_id,
        student.student_no, term.school_year, term.term, term.is_current, section.name AS section_name
      FROM enrollments AS enrollment
      INNER JOIN annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
      INNER JOIN students AS student ON student.id = enrollment.student_id
      INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
      INNER JOIN sections AS section ON section.id = enrollment.section_id AND section.academic_term_id = term.id
      WHERE enrollment.annual_enrollment_id IN (${placeholders(annualIds.length)})
      ORDER BY enrollment.annual_enrollment_id, enrollment.annual_term_number`, annualIds);
  if (placements.length !== 237) throw new ActivationError('The expected 237 annual term placements could not be verified.');
  const placementByAnnualTerm = new Map();
  for (const placement of placements) {
    const ordinalMatch = /^DEMO-HOSTINGER-(\d{4})$/.exec(String(placement.student_no));
    const ordinal = ordinalMatch ? Number(ordinalMatch[1]) : NaN;
    const termNumber = Number(placement.annual_term_number);
    const student = plan.expansion.annualStudents.find((item) => item.ordinal === ordinal);
    const shouldBeConfirmed = plan.selectedByOrdinal.has(ordinal)
      && annualByOrdinal.get(ordinal)?.intake_status === 'enrolled' && termNumber === 1;
    const sectionNumber = ordinal <= 50 ? ordinal - 2 : ordinal - 51;
    const suffix = sectionNumber % 2 === 0 ? 'A' : 'B';
    const expectedSection = `Demo Hostinger ${student?.gradeLevel} ${suffix}`;
    const key = `${Number(placement.annual_enrollment_id)}:${termNumber}`;
    if (!student || termNumber < 1 || termNumber > 3 || placementByAnnualTerm.has(key)
      || Number(placement.student_id) !== Number(placement.annual_student_id)
      || placement.school_year !== SCHOOL_YEAR || placement.term !== `Term ${termNumber}`
      || Number(placement.is_current) !== (termNumber === 1 ? 1 : 0)
      || placement.grade_level !== student.gradeLevel || placement.section_name !== expectedSection
      || placement.term_scope_status !== 'applicable'
      || (shouldBeConfirmed
        ? placement.enrollment_status !== 'enrolled' || placement.finalized_at == null
        : placement.enrollment_status !== 'pending_payment' || placement.finalized_at != null)) {
      throw new ActivationError('A demo annual term placement differs from the expected section, term, or activation state.');
    }
    placementByAnnualTerm.set(key, placement);
  }
  for (const annual of annualRows) {
    for (let termNumber = 1; termNumber <= 3; termNumber += 1) {
      if (!placementByAnnualTerm.has(`${Number(annual.id)}:${termNumber}`)) {
        throw new ActivationError('A demo annual enrollment is missing one of its three term placements.');
      }
    }
  }

  const confirmationRows = await readRows(connection,
    `SELECT id, annual_enrollment_id, entry_enrollment_id, confirmed_by, idempotency_key, request_fingerprint
      FROM annual_registrar_confirmations
      WHERE annual_enrollment_id IN (${placeholders(annualIds.length)})`, annualIds);
  const selectedIds = new Map(plan.selected.map((student) => [
    Number(annualByOrdinal.get(student.ordinal).id), student
  ]));
  const confirmationByAnnual = new Map();
  for (const row of confirmationRows) {
    const annualId = Number(row.annual_enrollment_id);
    const student = selectedIds.get(annualId);
    const key = `${annualId}`;
    if (!student || confirmationByAnnual.has(key)
      || String(row.idempotency_key) !== stableUuid(`registrar-confirmation:${student.ordinal}`)
      || !/^[0-9a-f]{64}$/i.test(String(row.request_fingerprint))) {
      throw new ActivationError('A confirmation exists outside the reserved replay-safe activation set.');
    }
    const expectedEntry = placementByAnnualTerm.get(`${annualId}:1`);
    if (Number(row.entry_enrollment_id) !== Number(expectedEntry.id)
      || Number(row.confirmed_by) !== actors.registrarId) {
      throw new ActivationError('A saved confirmation does not match the seeded registrar and expected entry-term placement.');
    }
    confirmationByAnnual.set(key, row);
  }
  for (const student of plan.selected) {
    const annual = annualByOrdinal.get(student.ordinal);
    const placement = placementByAnnualTerm.get(`${Number(annual.id)}:1`);
    const confirmation = confirmationByAnnual.get(String(annual.id));
    const confirmed = annual.intake_status === 'enrolled' && placement.enrollment_status === 'enrolled';
    if (confirmed !== Boolean(confirmation)) throw new ActivationError('A selected demo intake has an incomplete activation state.');
  }

  const selectedStudentIds = plan.selected.map((student) => Number(rowsByStudentNo.get(student.studentNo).id));
  const documents = await readRows(connection,
    `SELECT id FROM documents WHERE student_id IN (${placeholders(selectedStudentIds.length)}) LIMIT 1`, selectedStudentIds);
  if (documents.length) throw new ActivationError('The selected fictional records contain documents; activation requires the untouched demo fixtures.');

  return { actors, annualByOrdinal, placementByAnnualTerm,
    confirmationByAnnual, completedCount: confirmationByAnnual.size };
}

async function requireHostingerActors(connection) {
  const actors = await readRows(connection,
    `SELECT profile.employee_no, actor.id, actor.role FROM staff_profiles AS profile
      INNER JOIN users AS actor ON actor.id = profile.user_id AND actor.is_active = 1
      WHERE profile.employee_no IN (?, ?)`, ['HDMO-ADMIN-001', 'HDMO-REG-001']);
  const byEmployee = new Map(actors.map((row) => [String(row.employee_no), row]));
  const admin = byEmployee.get('HDMO-ADMIN-001');
  const registrar = byEmployee.get('HDMO-REG-001');
  if (!admin || admin.role !== 'database_admin' || !registrar || registrar.role !== 'registrar') {
    throw new ActivationError('The seeded Hostinger administrator and registrar roles could not be verified.');
  }
  return { adminId: Number(admin.id), registrarId: Number(registrar.id) };
}

function assertPreviewMatches(preview, annual, student) {
  const selection = parseJson(annual.selection_json, 'A saved demo assessment selection could not be validated.');
  if (!preview || preview.existingAssessment !== true
    || Number(preview.assessmentId) !== Number(annual.assessment_id)
    || Number(preview.scheduleId) !== Number(annual.schedule_id)
    || Number(preview.scheduleVersion) !== Number(annual.schedule_version)
    || preview.voucherCode !== student.voucherCode
    || JSON.stringify([...(preview.optionalLineIds || [])].map(Number).sort((a, b) => a - b))
      !== JSON.stringify([...selection.optionalLineIds].map(Number).sort((a, b) => a - b))
    || typeof preview.snapshotFingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(preview.snapshotFingerprint)) {
    throw new ActivationError('The registrar fee preview no longer matches a saved demo assessment; no confirmation was attempted for that intake.');
  }
  return preview;
}

async function verifyCompletedActivation(connection, plan) {
  await connection.beginTransaction();
  try {
    const verified = await requireExactExpansionRows(connection, plan);
    await connection.rollback();
    if (verified.completedCount !== plan.selected.length) {
      throw new ActivationError('Not all 20 selected demo confirmations and finalized Term 1 placements were verified; the activation marker was not written.');
    }
    return verified;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  }
}

async function writeActivationMarker(connection, actors, plan) {
  await connection.beginTransaction();
  try {
    const existing = await readRows(connection,
      'SELECT id FROM audit_logs WHERE entity_type = ? AND entity_id = ? LIMIT 1',
      ['school_demo_enrollment_activation', ACTIVATION_MARKER]);
    if (existing.length) throw new ActivationError('The one-time Hostinger demo enrollment activation was already completed.');
    const finalState = await requireExactExpansionRows(connection, plan);
    if (finalState.completedCount !== plan.selected.length) {
      throw new ActivationError('Not all 20 selected demo confirmations completed; the one-time activation marker was not written.');
    }
    const details = {
      version: 1,
      selectedStudents: plan.selected.length,
      gradeCounts: plan.expectedGradeCounts,
      notes: [
        'All activated student records are fictional Hostinger demo fixtures.',
        'The existing registrar confirmation service preserved each posted fee assessment snapshot.',
        'No student login accounts or documents were created.'
      ]
    };
    await execute(connection,
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (?, 'database_admin.demo_enrollments_activated', 'school_demo_enrollment_activation', ?, ?)`,
      [actors.adminId, ACTIVATION_MARKER, JSON.stringify(details)]);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  }
}

async function runActivation({
  options = parseOptions(process.argv.slice(2)), configuration = environment,
  getDatabasePool = database.getPool, closeDatabasePool = database.closePool,
  logger = console, services = null
} = {}) {
  validateProductionTarget(configuration);
  if (!options || !['apply', 'dry-run'].includes(options.mode)
    || options.targetDatabase !== configuration.database.database
    || options.confirmDatabase !== configuration.database.database
    || options.seedMarker !== HOSTINGER_SEED_MARKER || options.expansionMarker !== EXPANSION_MARKER) {
    throw new ActivationError('Confirm the production demo database and exact seed and expansion markers before continuing.');
  }
  const plan = buildActivationPlan();
  const pool = await getDatabasePool();
  let connection;
  let locked = false;
  let guardTransactionStarted = false;
  try {
    if (!pool?.source || typeof pool.source.getConnection !== 'function') {
      throw new ActivationError('The MariaDB connection pool is unavailable for the one-time activation lock.');
    }
    connection = await pool.source.getConnection();
    const lockRows = await readRows(connection, 'SELECT GET_LOCK(?, 15) AS acquired', [APPLICATION_LOCK]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new ActivationError('Could not acquire the one-time demo enrollment activation lock.');
    locked = true;

    await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await connection.beginTransaction();
    guardTransactionStarted = true;
    await requireExpectedSchema(connection);
    await requireHostingerMarkers(connection);
    const guarded = await requireExactExpansionRows(connection, plan);
    await connection.rollback();
    guardTransactionStarted = false;

    const serviceSet = services || (() => {
      const annualFinanceService = createAnnualFinanceService({ getPool: getDatabasePool, sql: database.sql });
      const annualEnrollmentService = createAnnualEnrollmentService({ getPool: getDatabasePool, sql: database.sql, annualFinanceService });
      return { annualFinanceService, annualEnrollmentService };
    })();
    const previewsByOrdinal = new Map();
    for (const student of plan.selected) {
      const annual = guarded.annualByOrdinal.get(student.ordinal);
      if (guarded.confirmationByAnnual.has(String(annual.id))) continue;
      const preview = assertPreviewMatches(
        await serviceSet.annualFinanceService.annualAssessmentPreviewForRegistrar(guarded.actors.registrarId, Number(annual.id)),
        annual, student);
      previewsByOrdinal.set(student.ordinal, preview);
    }

    if (options.mode === 'dry-run') {
      const pendingCount = plan.selected.length - guarded.completedCount;
      logger.log(`Dry run passed: 20 fictional demo intakes selected (10 Grade 11, 10 Grade 12); ${guarded.completedCount} already have matching confirmations and ${pendingCount} saved assessments are ready. No rows were written.`);
      return { mode: 'dry-run', selectedStudents: 20, gradeCounts: plan.expectedGradeCounts,
        completedForReplay: guarded.completedCount, readyToConfirm: pendingCount };
    }

    for (const student of plan.selected) {
      const annual = guarded.annualByOrdinal.get(student.ordinal);
      if (guarded.confirmationByAnnual.has(String(annual.id))) continue;
      const preview = previewsByOrdinal.get(student.ordinal);
      await serviceSet.annualEnrollmentService.confirmAnnualEnrollment(guarded.actors.registrarId, Number(annual.id), {
        idempotencyKey: stableUuid(`registrar-confirmation:${student.ordinal}`),
        scheduleId: preview.scheduleId,
        scheduleVersion: preview.scheduleVersion,
        voucherCode: preview.voucherCode,
        assessmentId: preview.assessmentId,
        optionalLineIds: preview.optionalLineIds,
        snapshotFingerprint: preview.snapshotFingerprint
      });
    }

    await verifyCompletedActivation(connection, plan);
    await writeActivationMarker(connection, guarded.actors, plan);
    logger.log('Hostinger demo enrollment activation applied: 20 fictional students confirmed through the registrar workflow (10 Grade 11, 10 Grade 12). Existing fee assessments were preserved; no logins or documents were created.');
    return { mode: 'apply', selectedStudents: 20, gradeCounts: plan.expectedGradeCounts };
  } catch (error) {
    if (guardTransactionStarted) await connection?.rollback().catch(() => {});
    if (error instanceof ActivationError) throw error;
    const safeError = new ActivationError('Hostinger demo activation stopped. Each completed learner confirmation committed safely; rerun the exact apply command to resume any interrupted batch.');
    safeError.cause = error;
    throw safeError;
  } finally {
    if (connection) {
      if (locked) await execute(connection, 'SELECT RELEASE_LOCK(?)', [APPLICATION_LOCK]).catch(() => {});
      connection.release();
    }
    await closeDatabasePool().catch(() => {});
  }
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    validateProductionTarget();
    await runActivation({ options });
  } catch (error) {
    console.error(error instanceof ActivationError ? error.message : 'Hostinger demo activation failed. Check the approved production demo configuration and MariaDB reachability.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ACTIVATION_MARKER,
  ACTIVATION_ORDINALS,
  APPLICATION_LOCK,
  ActivationError,
  buildActivationPlan,
  parseOptions,
  validateProductionTarget,
  assertPreviewMatches,
  runActivation
};
