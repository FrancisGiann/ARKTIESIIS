'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const environment = require('../src/config/environment');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESET_TABLES = Object.freeze([
  'audit_logs', 'document_decision_events', 'document_review_events', 'document_validations',
  'form137_status_events', 'previous_school_report_card_status_events', 'documents', 'student_document_claim_slips',
  'student_document_clearance_events', 'student_document_request_events', 'student_document_requests',
  'student_physical_checklist_events', 'student_profile_revisions', 'grade_import_preview_grades',
  'teacher_grade_submission_grades', 'grade_import_preview_rows', 'teacher_grade_submission_events',
  'teacher_grade_submission_rows', 'grade_import_previews', 'teacher_grade_submissions', 'grades',
  'finance_payment_allocation_releases', 'finance_payment_allocations', 'finance_allocation_batches',
  'finance_payment_metadata_events', 'finance_payment_reversals', 'finance_payments',
  'finance_legacy_reconciliation_releases', 'finance_legacy_reconciliations',
  'finance_legacy_reconciliation_batches', 'finance_transaction_reversals', 'enrollment_clearances',
  'term_clearance_events', 'term_finance_approvals', 'annual_registrar_confirmations',
  'finance_charge_adjustments', 'finance_exemption_applications', 'finance_exemption_rules',
  'finance_exemption_cases', 'finance_departure_case_terms', 'finance_departure_cases',
  'finance_fee_comment_events', 'finance_handbook_number_events', 'finance_review_drafts',
  'assessed_charges', 'annual_assessments', 'finance_legacy_opening_charges', 'financial_transactions',
  'annual_enrollment_admin_revisions', 'annual_enrollment_events', 'annual_enrollment_tags',
  'annual_workflow_events', 'annual_special_subjects', 'student_subjects', 'enrollments',
  'annual_enrollments', 'pre_enrollment_events', 'pre_enrollment_receipts', 'pre_enrollment_revisions',
  'pre_enrollments', 'readmission_evaluation_events', 'readmission_evaluations', 'financial_accounts',
  'students'
]);
const PRESERVED_TABLES = Object.freeze([
  'academic_terms', 'sections', 'subjects', 'teacher_assignments', 'class_schedules', 'finance_schedules',
  'finance_schedule_lines', 'school_year_term_order', 'school_year_term_order_reviews',
  'physical_requirement_definitions', 'staff_profiles', 'application_locks', 'schema_migrations'
]);
const STUDENT_AUTH_TABLES = Object.freeze(['two_factor_codes', 'two_factor_auth_limits', 'password_reset_tokens', 'pending_email_changes']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_FILES = Object.freeze([
  { kind: 'studentDocuments', query: 'SELECT stored_filename AS file_key FROM documents', format: (key) => key, directory: '' },
  { kind: 'teacherWorkbooks', query: 'SELECT storage_key AS file_key FROM teacher_grade_submissions', format: (key) => `${key}.xlsx`, directory: 'teacher-grade-submissions' },
  { kind: 'gradeImportStaging', query: 'SELECT id AS file_key FROM grade_import_previews', format: (key) => `${key}.xlsx`, directory: 'teacher-grade-staging' }
]);

class ResetError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ResetError'; this.status = status; }
}

function parseOptions(args = []) {
  if (!Array.isArray(args) || args.some((arg) => !['--apply', '--dry-run', '--database-only', '--resume-files', '--mark-files-removed'].includes(arg))
    || new Set(args).size !== args.length) {
    throw new ResetError('Usage: node scripts/reset-demo-students-mariadb.js [--database-only] [--apply|--resume-files|--mark-files-removed]. Dry-run is the default.');
  }
  if (args.includes('--apply') && args.includes('--dry-run')) throw new ResetError('Choose either --dry-run or --apply.');
  const operations = ['--apply', '--resume-files', '--mark-files-removed'].filter((option) => args.includes(option));
  if (operations.length > 1) throw new ResetError('Choose exactly one reset or file-manifest operation.');
  return { mode: operations.length ? operations[0].slice(2) : 'dry-run', databaseOnly: args.includes('--database-only') };
}

function resetConfirmation(databaseName) { return `DELETE STUDENT DATA FROM ${databaseName}`; }

function connectionTarget(database = {}) {
  if (database.socketPath) return { transport: 'unix_socket', endpoint: path.resolve(String(database.socketPath)) };
  const host = String(database.host || '').trim().toLowerCase();
  if (!host) throw new ResetError('A configured database host or socket is required for reset planning.');
  return { transport: 'tcp', endpoint: `${host}:${Number(database.port || 3306)}` };
}

function planDigestFor({ databaseName, schemaVersion, counts, students, studentUsers, staffUsers, fileReferences, fileSnapshot, serverIdentity, target }) {
  return crypto.createHash('sha256').update(JSON.stringify({ databaseName, schemaVersion, counts, students, studentUsers,
    staffUsers, fileReferences, fileSnapshot, serverIdentity, target })).digest('hex');
}

function validateTarget({ configuration, variables = process.env, mode }) {
  const databaseName = String(configuration?.database?.database || '').trim();
  if (!databaseName || variables.RESET_DEMO_ALLOWED_DATABASE !== databaseName) {
    throw new ResetError('The selected database is not the explicitly allowlisted reset target.');
  }
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(databaseName)) throw new ResetError('The selected database name is invalid.');
  if (mode === 'dry-run') return databaseName;
  if (variables.RESET_DEMO_CONFIRM !== resetConfirmation(databaseName)) {
    throw new ResetError('Set RESET_DEMO_CONFIRM to the exact confirmation phrase for the allowlisted database.');
  }
  if (variables.RESET_DEMO_MAINTENANCE_CONFIRMED !== 'true') {
    throw new ResetError('Confirm the application and background writers are paused before applying the reset.');
  }
  if (mode !== 'apply') {
    if (!/^[a-f0-9]{64}$/i.test(String(variables.RESET_DEMO_PENDING_FILES_MANIFEST_SHA256 || ''))) {
      throw new ResetError('File-manifest operations require the current private manifest SHA-256.');
    }
    if (mode === 'mark-files-removed' && variables.RESET_DEMO_FILES_REMOVED_CONFIRMED !== 'true') {
      throw new ResetError('Confirm that the exact host files in the manifest were removed before marking cleanup complete.');
    }
    return databaseName;
  }
  if (!/^(0|[1-9]\d*)$/.test(String(variables.RESET_DEMO_EXPECTED_STUDENTS || ''))
    || !/^(0|[1-9]\d*)$/.test(String(variables.RESET_DEMO_EXPECTED_STUDENT_USERS || ''))) {
    throw new ResetError('Apply requires the exact expected student and student-login counts from the final preview.');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(variables.RESET_DEMO_EXPECTED_PLAN_SHA256 || ''))) {
    throw new ResetError('Apply requires RESET_DEMO_EXPECTED_PLAN_SHA256 from the matching dry-run preview.');
  }
  if (variables.RESET_DEMO_DATABASE_BACKUP_VERIFIED !== 'true'
    || variables.RESET_DEMO_UPLOAD_BACKUP_VERIFIED !== 'true') {
    throw new ResetError('Apply requires verified private database and uploaded-file backups.');
  }
  if (!variables.RESET_DEMO_PENDING_FILES_MANIFEST) {
    throw new ResetError('Apply requires an absolute private path for the resumable exact-file manifest.');
  }
  return databaseName;
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(value)) throw new ResetError('A database metadata identifier was invalid.');
  return `\`${value.replaceAll('`', '``')}\``;
}

async function countTable(connection, table) {
  const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
  return Number(rows[0]?.count || 0);
}

async function readFileReferences(connection) {
  const references = [];
  for (const definition of STORAGE_FILES) {
    const [rows] = await connection.query(definition.query);
    for (const row of rows) {
      const key = String(row.file_key || '');
      const uuid = key.replace(/\.(?:pdf|jpe?g|png)$/i, '');
      if (!UUID_PATTERN.test(uuid)) throw new ResetError(`A ${definition.kind} reference is not a UUID-backed stored file.`);
      references.push({ kind: definition.kind, relativePath: path.posix.join(definition.directory, definition.format(key)) });
    }
  }
  return references.sort((left, right) => `${left.kind}:${left.relativePath}`.localeCompare(`${right.kind}:${right.relativePath}`));
}

async function checkUnexpectedReferences(connection, databaseName) {
  const [outsideReset] = await connection.execute(`SELECT DISTINCT key_usage.table_name, key_usage.constraint_name
    FROM information_schema.key_column_usage AS key_usage
    WHERE key_usage.table_schema = ? AND key_usage.referenced_table_name IN (${RESET_TABLES.map(() => '?').join(',')})
      AND key_usage.table_name NOT IN (${RESET_TABLES.map(() => '?').join(',')})
      AND key_usage.referenced_table_name <> 'users'`, [databaseName, ...RESET_TABLES, ...RESET_TABLES]);
  if (outsideReset.length) throw new ResetError('An unexpected retained table references student reset data; no rows were deleted.');

  const [userForeignKeys] = await connection.execute(`SELECT table_name, column_name, constraint_name
    FROM information_schema.key_column_usage
    WHERE table_schema = ? AND referenced_table_name = 'users' AND referenced_column_name = 'id'
      AND table_name NOT IN (${RESET_TABLES.map(() => '?').join(',')})`, [databaseName, ...RESET_TABLES]);
  for (const key of userForeignKeys) {
    const table = quoteIdentifier(String(key.table_name));
    const column = quoteIdentifier(String(key.column_name));
    const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM ${table} AS child
      INNER JOIN users AS account ON account.id = child.${column} WHERE account.role = 'student'`);
    if (Number(rows[0]?.count || 0) > 0) throw new ResetError('A retained staff/setup row references a student login; no rows were deleted.');
  }
}

async function localFileState(references, storageRoot) {
  if (!storageRoot) return { inspected: false, present: null, missing: null };
  if (!path.isAbsolute(storageRoot)) throw new ResetError('The uploaded-file root must be an absolute path.');
  const root = await fsp.realpath(storageRoot).catch(() => { throw new ResetError('The uploaded-file root is unavailable.'); });
  if (root === path.parse(root).root || root === PROJECT_ROOT || root.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new ResetError('The uploaded-file root must be a private storage directory outside the application checkout.');
  }
  let present = 0;
  let missing = 0;
  const filePaths = [];
  for (const reference of references) {
    const absolute = path.resolve(root, reference.relativePath);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ResetError('An uploaded-file path escaped the configured storage root.');
    try {
      const stats = await fsp.lstat(absolute);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new ResetError('A stored upload is not a regular file; no files were removed.');
      present += 1;
      filePaths.push({ absolute, relativePath: reference.relativePath, dev: stats.dev, ino: stats.ino,
        size: stats.size, mtimeMs: stats.mtimeMs });
    } catch (error) {
      if (error.code === 'ENOENT') { missing += 1; continue; }
      throw error;
    }
  }
  return { inspected: true, present, missing, root, filePaths };
}

async function readPlan(connection, databaseName, { storageRoot, target } = {}) {
  if (!target || !['tcp', 'unix_socket'].includes(target.transport) || !target.endpoint) {
    throw new ResetError('The database connection endpoint is unavailable; reset planning fails closed.');
  }
  const [identityRows] = await connection.query(`SELECT DATABASE() AS databaseName, @@hostname AS hostname,
    @@port AS port, @@server_id AS serverId, @@version AS version`);
  const serverIdentity = identityRows[0] || {};
  if (String(serverIdentity.databaseName || '') !== databaseName) throw new ResetError('Connected database does not match the allowlisted target.');
  const [versions] = await connection.query('SELECT version FROM schema_migrations ORDER BY version');
  const schemaVersion = String(versions.at(-1)?.version || '');
  if (schemaVersion !== 'v2.016') throw new ResetError('The reset helper requires the v2.016 schema.');
  await checkUnexpectedReferences(connection, databaseName);
  const tables = [...new Set([...RESET_TABLES, ...PRESERVED_TABLES, ...STUDENT_AUTH_TABLES, 'users'])];
  const counts = {};
  for (const table of tables) counts[table] = await countTable(connection, table);
  const [students] = await connection.query('SELECT COUNT(*) AS count FROM students');
  const [studentUsers] = await connection.query("SELECT COUNT(*) AS count FROM users WHERE role = 'student'");
  const [staffUsers] = await connection.query("SELECT COUNT(*) AS count FROM users WHERE role <> 'student'");
  const [activeAdmins] = await connection.query("SELECT id FROM users WHERE role = 'database_admin' AND is_active = 1 ORDER BY id LIMIT 1");
  if (!activeAdmins.length) throw new ResetError('An active database administrator is required to record the reset audit event.');
  const fileReferences = await readFileReferences(connection);
  const fileState = await localFileState(fileReferences, storageRoot);
  const studentsCount = Number(students[0]?.count || 0);
  const studentUsersCount = Number(studentUsers[0]?.count || 0);
  const staffUsersCount = Number(staffUsers[0]?.count || 0);
  const fileReferenceList = fileReferences.map(({ kind, relativePath }) => [kind, relativePath]);
  const fileSnapshot = fileState.inspected ? fileState.filePaths.map(({ relativePath, dev, ino, size, mtimeMs }) =>
    [relativePath, dev, ino, size, mtimeMs]) : null;
  const planDigest = planDigestFor({ databaseName, schemaVersion, counts, students: studentsCount,
    studentUsers: studentUsersCount, staffUsers: staffUsersCount, fileReferences: fileReferenceList,
    fileSnapshot, serverIdentity, target });
  return {
    databaseName, schemaVersion, counts,
    students: studentsCount, studentUsers: studentUsersCount, staffUsers: staffUsersCount,
    serverIdentity, target: { transport: target.transport, endpoint: target.endpoint,
      endpointFingerprint: crypto.createHash('sha256').update(target.endpoint).digest('hex') },
    activeDatabaseAdminId: Number(activeAdmins[0].id), fileReferences, fileState, planDigest
  };
}

function publicPlan(plan, databaseOnly) {
  const { activeDatabaseAdminId, fileReferences, fileState, ...safe } = plan;
  const files = {
    studentDocuments: fileReferences.filter((entry) => entry.kind === 'studentDocuments').length,
    teacherWorkbooks: fileReferences.filter((entry) => entry.kind === 'teacherWorkbooks').length,
    gradeImportStaging: fileReferences.filter((entry) => entry.kind === 'gradeImportStaging').length,
    localRootInspected: fileState.inspected,
    localFilesPresent: fileState.present,
    localFilesMissing: fileState.missing,
    deletionMode: databaseOnly ? 'database-only; uploaded files require separate verified cleanup' : 'database plus exact UUID-backed files'
  };
  return { ...safe, files };
}

async function verifyBackupFile(filePath, expectedSha256, label) {
  if (!filePath || !/^[a-f0-9]{64}$/i.test(String(expectedSha256 || ''))) {
    throw new ResetError(`A private ${label} backup path and SHA-256 are required.`);
  }
  if (!path.isAbsolute(filePath) || path.resolve(filePath) === PROJECT_ROOT || path.resolve(filePath).startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new ResetError(`The private ${label} backup must be outside the application checkout.`);
  }
  const stats = await fsp.lstat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size < 1) throw new ResetError(`The private ${label} backup is missing or empty.`);
  if ((stats.mode & 0o077) !== 0) throw new ResetError(`The ${label} backup permissions are not private.`);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  const digest = hash.digest('hex');
  if (digest.toLowerCase() !== String(expectedSha256).toLowerCase()) throw new ResetError(`The private ${label} backup checksum does not match.`);
}

async function privateManifestPath(filePath) {
  if (!filePath || !path.isAbsolute(filePath)) throw new ResetError('The file manifest path must be absolute.');
  const resolved = path.resolve(filePath);
  if (resolved === PROJECT_ROOT || resolved.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new ResetError('The private file manifest must be outside the application checkout.');
  }
  const parent = await fsp.realpath(path.dirname(resolved)).catch(() => null);
  if (!parent || (await fsp.stat(parent)).mode & 0o077) {
    throw new ResetError('The manifest directory must exist and be private to the operating-system user.');
  }
  const existing = await fsp.lstat(resolved).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0)) {
    throw new ResetError('The existing manifest must be a private regular file.');
  }
  return resolved;
}

function manifestSha256(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

async function writePrivateManifest(filePath, manifest) {
  const target = await privateManifestPath(filePath);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, target);
  await fsp.chmod(target, 0o600);
  return manifestSha256(manifest);
}

async function readPrivateManifest(filePath, expectedSha256) {
  const target = await privateManifestPath(filePath);
  const stats = await fsp.stat(target);
  if (stats.size < 2 || stats.size > 10 * 1024 * 1024) throw new ResetError('The private file manifest has an invalid size.');
  const raw = await fsp.readFile(target, 'utf8');
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw new ResetError('The private file manifest is not valid JSON.'); }
  const digest = manifestSha256(manifest);
  if (digest.toLowerCase() !== String(expectedSha256 || '').toLowerCase()) {
    throw new ResetError('The private file manifest checksum does not match the supplied approval.');
  }
  if (manifest.formatVersion !== 1 || !manifest.databaseName || !manifest.planDigest
    || !['prepared', 'pending_local_files', 'pending_host_files', 'completed'].includes(manifest.status)
    || !Array.isArray(manifest.files)) {
    throw new ResetError('The private file manifest structure is not supported.');
  }
  return { path: target, manifest, digest };
}

function createManifest(plan, databaseOnly, storageRoot) {
  return {
    formatVersion: 1,
    resetId: crypto.randomUUID(),
    databaseName: plan.databaseName,
    schemaVersion: plan.schemaVersion,
    planDigest: plan.planDigest,
    target: plan.target,
    serverIdentity: plan.serverIdentity,
    createdAt: new Date().toISOString(),
    status: 'prepared',
    fileMode: databaseOnly ? 'host-manual' : 'local-exact',
    storageRoot: databaseOnly ? null : path.resolve(storageRoot),
    preservedCounts: Object.fromEntries(PRESERVED_TABLES.map((table) => [table, plan.counts[table]])),
    files: databaseOnly
      ? plan.fileReferences.map(({ kind, relativePath }) => ({ kind, relativePath }))
      : plan.fileState.filePaths.map(({ relativePath, dev, ino, size, mtimeMs }) => ({
        relativePath, dev, ino, size, mtimeMs
      }))
  };
}

async function assertResetCommitted(connection, manifest, target) {
  const current = await readPlan(connection, manifest.databaseName, {
    storageRoot: manifest.fileMode === 'local-exact' ? manifest.storageRoot : undefined,
    target
  });
  if (JSON.stringify(current.serverIdentity) !== JSON.stringify(manifest.serverIdentity)
    || current.planDigest === manifest.planDigest) {
    throw new ResetError('The live database identity does not match the prepared reset manifest.');
  }
  const resetRowsEmpty = RESET_TABLES.filter((table) => table !== 'audit_logs')
    .every((table) => current.counts[table] === 0)
    && STUDENT_AUTH_TABLES.every((table) => current.counts[table] === 0);
  if (!resetRowsEmpty || current.students !== 0 || current.studentUsers !== 0) {
    throw new ResetError('The database reset is not committed; exact files remain untouched.');
  }
  for (const table of PRESERVED_TABLES) {
    if (current.counts[table] !== manifest.preservedCounts[table]) {
      throw new ResetError(`A retained table differs from the approved reset snapshot (${table}).`);
    }
  }
  const [rows] = await connection.execute(`SELECT details_json FROM audit_logs
    WHERE action = 'maintenance.demo_student_data_reset' AND entity_type = 'database' AND entity_id = ?
    ORDER BY id DESC LIMIT 1`, [manifest.databaseName]);
  let auditDetails;
  try { auditDetails = typeof rows[0]?.details_json === 'string' ? JSON.parse(rows[0].details_json) : rows[0]?.details_json; }
  catch { auditDetails = null; }
  if (!auditDetails || auditDetails.inventorySha256 !== manifest.planDigest) {
    throw new ResetError('A matching committed reset audit event was not found; exact files remain untouched.');
  }
  return current;
}

async function executeManifestOperation(connection, options, { databaseName, target, variables, logger }) {
  const { path: manifestPath, manifest } = await readPrivateManifest(
    variables.RESET_DEMO_PENDING_FILES_MANIFEST, variables.RESET_DEMO_PENDING_FILES_MANIFEST_SHA256);
  if (manifest.databaseName !== databaseName
    || manifest.target.transport !== target.transport || manifest.target.endpoint !== target.endpoint) {
    throw new ResetError('The file manifest belongs to a different database endpoint.');
  }
  if (manifest.fileMode === 'local-exact') {
    const configuredRoot = variables.RESET_DEMO_STORAGE_ROOT;
    if (!configuredRoot || path.resolve(configuredRoot) !== manifest.storageRoot) {
      throw new ResetError('The configured uploaded-file root does not match the private manifest.');
    }
  }
  await assertResetCommitted(connection, manifest, target);
  if (options.mode === 'mark-files-removed') {
    if (manifest.fileMode !== 'host-manual' || manifest.status !== 'pending_host_files') {
      throw new ResetError('Only a committed host-manual manifest can be marked after external file removal.');
    }
    manifest.status = 'completed';
    manifest.completedAt = new Date().toISOString();
    manifest.hostFilesRemovedConfirmed = true;
    const digest = await writePrivateManifest(manifestPath, manifest);
    logger.log(JSON.stringify({ mode: options.mode, databaseName, manifestPath,
      manifestSha256: digest, status: manifest.status }, null, 2));
    return { mode: options.mode, manifest, manifestSha256: digest };
  }
  if (manifest.fileMode !== 'local-exact') {
    throw new ResetError('This manifest requires exact host-file cleanup followed by --mark-files-removed.');
  }
  if (!['prepared', 'pending_local_files'].includes(manifest.status)) {
    throw new ResetError('The manifest has no pending local files.');
  }
  if (manifest.status === 'prepared') {
    manifest.status = 'pending_local_files';
    manifest.databaseCommittedAt = new Date().toISOString();
    await writePrivateManifest(manifestPath, manifest);
  }
  const fileEntries = manifest.files.map((entry) => ({
    ...entry, absolute: path.resolve(manifest.storageRoot, entry.relativePath)
  }));
  const removedFiles = await deleteExactFiles(fileEntries);
  manifest.status = 'completed';
  manifest.completedAt = new Date().toISOString();
  const digest = await writePrivateManifest(manifestPath, manifest);
  logger.log(JSON.stringify({ mode: options.mode, databaseName, manifestPath,
    manifestSha256: digest, status: manifest.status, removedFiles }, null, 2));
  return { mode: options.mode, manifest, manifestSha256: digest, removedFiles };
}

async function performDelete(connection, databaseName, actorId, plan, storageRoot, target) {
  await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  await connection.beginTransaction();
  try {
    await connection.query('SELECT id FROM students ORDER BY id FOR UPDATE');
    await connection.query("SELECT id FROM users WHERE role = 'student' ORDER BY id FOR UPDATE");
    const current = await readPlan(connection, databaseName, { storageRoot, target });
    if (current.planDigest !== plan.planDigest) throw new ResetError('The database changed after preview; no rows were deleted.');

    await connection.query('UPDATE documents SET supersedes_document_id = NULL WHERE supersedes_document_id IS NOT NULL');
    await connection.query('UPDATE student_document_requests SET current_claim_slip_id = NULL WHERE current_claim_slip_id IS NOT NULL');
    await connection.query('UPDATE teacher_grade_submissions SET previous_submission_id = NULL WHERE previous_submission_id IS NOT NULL');
    await connection.query('UPDATE finance_payments SET reverses_payment_id = NULL WHERE reverses_payment_id IS NOT NULL');
    await connection.query('UPDATE finance_charge_adjustments SET reverses_adjustment_id = NULL WHERE reverses_adjustment_id IS NOT NULL');

    for (const table of RESET_TABLES) {
      if (table === 'users' || table === 'two_factor_codes' || table === 'two_factor_auth_limits'
        || table === 'password_reset_tokens' || table === 'pending_email_changes') continue;
      await connection.query(`DELETE FROM ${quoteIdentifier(table)}`);
    }
    for (const table of STUDENT_AUTH_TABLES) {
      await connection.query(`DELETE FROM ${quoteIdentifier(table)} WHERE user_id IN
        (SELECT id FROM users WHERE role = 'student')`);
    }
    await connection.query("DELETE FROM students");
    await connection.query("DELETE FROM users WHERE role = 'student'");
    const remaining = await readPlan(connection, databaseName, { storageRoot, target });
    if (remaining.students !== 0 || remaining.studentUsers !== 0) throw new ResetError('Student rows remain after the reset; transaction rolled back.');
    for (const table of PRESERVED_TABLES) {
      if (remaining.counts[table] !== plan.counts[table]) throw new ResetError(`A retained setup table changed during reset (${table}); transaction rolled back.`);
    }
    if (remaining.staffUsers !== plan.staffUsers) throw new ResetError('A retained staff account changed during reset; transaction rolled back.');
    await connection.execute(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
      VALUES (?, 'maintenance.demo_student_data_reset', 'database', ?, ?)`,
    [actorId, databaseName, JSON.stringify({ schemaVersion: plan.schemaVersion, inventorySha256: plan.planDigest,
      removedRows: Object.fromEntries(RESET_TABLES.filter((table) => table !== 'audit_logs').map((table) => [table, plan.counts[table] || 0])),
      studentUsers: plan.studentUsers })]);
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch { /* preserve the original failure */ }
    throw error;
  }
}

async function deleteExactFiles(fileEntries) {
  const removed = [];
  for (const entry of fileEntries) {
    try {
      const stats = await fsp.lstat(entry.absolute);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.dev !== entry.dev || stats.ino !== entry.ino
        || stats.size !== entry.size || stats.mtimeMs !== entry.mtimeMs) {
        throw new ResetError('A stored upload changed after preview; remaining files were left untouched.');
      }
      await fsp.unlink(entry.absolute);
      removed.push(entry.absolute);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return removed.length;
}

async function runReset({ args = [], configuration = environment, variables = process.env,
  connectionFactory = (database) => mysql.createConnection({
    host: database.host, port: database.port, database: database.database,
    user: database.user, password: database.password, socketPath: database.socketPath || undefined,
    multipleStatements: false
  }), logger = console, fileDeletion = deleteExactFiles } = {}) {
  const options = parseOptions(args);
  const databaseName = validateTarget({ configuration, variables, mode: options.mode });
  const target = connectionTarget(configuration.database);
  const databaseOnly = options.databaseOnly || !variables.RESET_DEMO_STORAGE_ROOT;
  if (options.mode === 'apply') {
    const expectedStudents = Number(variables.RESET_DEMO_EXPECTED_STUDENTS);
    const expectedUsers = Number(variables.RESET_DEMO_EXPECTED_STUDENT_USERS);
    if (options.databaseOnly && variables.RESET_DEMO_FILES_BACKUP_VERIFIED !== 'true') {
      throw new ResetError('Database-only reset still requires a verified uploaded-file backup.');
    }
    await verifyBackupFile(variables.RESET_DEMO_DATABASE_BACKUP_PATH, variables.RESET_DEMO_DATABASE_BACKUP_SHA256, 'database');
    await verifyBackupFile(variables.RESET_DEMO_UPLOAD_BACKUP_PATH, variables.RESET_DEMO_UPLOAD_BACKUP_SHA256, 'uploaded-file');
    if (!Number.isSafeInteger(expectedStudents) || !Number.isSafeInteger(expectedUsers)) throw new ResetError('The expected cohort counts are invalid.');
  }
  const storageRoot = databaseOnly ? undefined : variables.RESET_DEMO_STORAGE_ROOT;
  const connection = await connectionFactory(configuration.database);
  let lockAcquired = false;
  try {
    const lockName = `arktiesiis-demo-reset-${crypto.createHash('sha256').update(databaseName).digest('hex').slice(0, 24)}`;
    const [locks] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
    if (Number(locks[0]?.acquired) !== 1) throw new ResetError('Another demo reset operation is already running.');
    lockAcquired = true;
    if (options.mode === 'resume-files' || options.mode === 'mark-files-removed') {
      return await executeManifestOperation(connection, options, { databaseName, target, variables, logger });
    }
    const plan = await readPlan(connection, databaseName, { storageRoot, target });
    if (options.mode === 'dry-run') {
      logger.log(JSON.stringify({ mode: 'dry-run', ...publicPlan(plan, databaseOnly) }, null, 2));
      return { mode: 'dry-run', plan };
    }
    if (plan.students !== Number(variables.RESET_DEMO_EXPECTED_STUDENTS)
      || plan.studentUsers !== Number(variables.RESET_DEMO_EXPECTED_STUDENT_USERS)) {
      throw new ResetError('The current student cohort does not match the exact expected counts; no rows were deleted.');
    }
    if (plan.planDigest !== String(variables.RESET_DEMO_EXPECTED_PLAN_SHA256).toLowerCase()) {
      const resetRowsEmpty = RESET_TABLES.filter((table) => table !== 'audit_logs')
        .every((table) => plan.counts[table] === 0)
        && STUDENT_AUTH_TABLES.every((table) => plan.counts[table] === 0);
      const alreadyApplied = plan.students === 0 && plan.studentUsers === 0 && resetRowsEmpty;
      if (alreadyApplied) {
        const [rows] = await connection.execute(`SELECT id FROM audit_logs
          WHERE action = 'maintenance.demo_student_data_reset' AND entity_type = 'database' AND entity_id = ? LIMIT 1`, [databaseName]);
        if (rows.length) {
          logger.log(JSON.stringify({ mode: 'apply', alreadyApplied: true, databaseName }, null, 2));
          return { mode: 'apply', alreadyApplied: true, plan };
        }
      }
      throw new ResetError('The inventory no longer matches the approved preview; no rows were deleted.');
    }
    if (!databaseOnly && plan.fileState.missing !== 0) throw new ResetError('Some referenced uploaded files are missing; no rows were deleted.');
    const [admins] = await connection.query("SELECT id FROM users WHERE role = 'database_admin' AND is_active = 1 ORDER BY id LIMIT 1 FOR UPDATE");
    if (!admins.length) throw new ResetError('An active database administrator is required; no rows were deleted.');

    const manifestPath = await privateManifestPath(variables.RESET_DEMO_PENDING_FILES_MANIFEST);
    let manifest;
    let manifestHash;
    const priorManifestStat = await fsp.lstat(manifestPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (priorManifestStat) {
      const prior = await readPrivateManifest(manifestPath, variables.RESET_DEMO_PENDING_FILES_MANIFEST_SHA256);
      if (prior.manifest.status !== 'prepared' || prior.manifest.planDigest !== plan.planDigest
        || prior.manifest.fileMode !== (databaseOnly ? 'host-manual' : 'local-exact')) {
        throw new ResetError('The existing private manifest does not match this unchanged reset preview.');
      }
      manifest = prior.manifest;
      manifestHash = prior.digest;
    } else {
      manifest = createManifest(plan, databaseOnly, storageRoot);
      manifestHash = await writePrivateManifest(manifestPath, manifest);
    }
    logger.log(JSON.stringify({ mode: 'apply', manifestPrepared: true, manifestPath,
      manifestSha256: manifestHash, databaseCommitted: false }, null, 2));
    await performDelete(connection, databaseName, Number(admins[0].id), plan, storageRoot, target);
    manifest.status = databaseOnly
      ? (manifest.files.length ? 'pending_host_files' : 'completed')
      : (manifest.files.length ? 'pending_local_files' : 'completed');
    manifest.databaseCommittedAt = new Date().toISOString();
    manifestHash = await writePrivateManifest(manifestPath, manifest);
    let removedFiles = null;
    let fileCleanupFailed = false;
    if (!databaseOnly && manifest.status === 'pending_local_files') {
      try {
        const fileEntries = manifest.files.map((entry) => ({
          ...entry, absolute: path.resolve(manifest.storageRoot, entry.relativePath)
        }));
        removedFiles = await fileDeletion(fileEntries);
        manifest.status = 'completed';
        manifest.completedAt = new Date().toISOString();
        manifestHash = await writePrivateManifest(manifestPath, manifest);
      }
      catch { fileCleanupFailed = true; }
    }
    logger.log(JSON.stringify({ mode: 'apply', databaseName, removedStudents: plan.students,
      removedStudentUsers: plan.studentUsers, databaseCommitted: true,
      uploadedFilesDeleted: databaseOnly ? false : fileCleanupFailed ? 'incomplete; resume with --resume-files' : removedFiles,
      manifestPath, manifestSha256: manifestHash, manifestStatus: manifest.status }, null, 2));
    return { mode: 'apply', plan, removedFiles, databaseOnly, fileCleanupFailed, manifestPath,
      manifest, manifestSha256: manifestHash };
  } finally {
    if (lockAcquired) {
      try { await connection.execute('SELECT RELEASE_LOCK(?)', [`arktiesiis-demo-reset-${crypto.createHash('sha256').update(databaseName).digest('hex').slice(0, 24)}`]); } catch { /* close the connection below */ }
    }
    await connection.end();
  }
}

if (require.main === module) {
  runReset({ args: process.argv.slice(2) }).then((result) => {
    if (result.fileCleanupFailed) process.exitCode = 2;
  }).catch((error) => {
    console.error(`Student reset stopped: ${error instanceof ResetError ? error.message : 'database reset failed safely; inspect the target before retrying.'}`);
    process.exitCode = 1;
  });
}

module.exports = { ResetError, RESET_TABLES, PRESERVED_TABLES, STUDENT_AUTH_TABLES,
  parseOptions, resetConfirmation, connectionTarget, planDigestFor, validateTarget, readPlan,
  readPrivateManifest, deleteExactFiles, runReset };
