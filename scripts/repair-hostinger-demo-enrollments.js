'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const mysql = require('mysql2/promise');
const { PoolFacade, Transaction, sql } = require('../src/config/database');
const { normalizeRecord, RECEIPT_REQUIREMENTS } = require('../src/services/preEnrollmentService');
const { createAnnualFinanceService } = require('../src/services/annualFinanceService');
const { createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');
const { createTermClearanceService } = require('../src/services/termClearanceService');
const { createAdminService } = require('../src/services/adminService');
const { buildExpansionPlan, stableUuid, SCHOOL_YEAR } = require('./expand-hostinger-demo');

const DATABASE = 'u364362094_arkteisiis';
const FIXTURE_MARKER = 'hostinger-demo-legacy-intake-v2';
const TODAY = '2026-10-08';
const FIRST_ORDINAL = 22;
const LAST_ORDINAL = 100;
const STUDENT_PREFIX = 'DEMO-HOSTINGER-';
const EXTRA_DUMMY_ALLOWLIST = Object.freeze([
  Object.freeze({ studentNo: 'SHS-2026-0001', studentId: 101, annualId: 80, annualKey: '0df74596-8de2-407f-95f9-649aa084ec4a', userId: 7, gradeLevel: 'Grade 11', voucherCode: 'PUB', entryTermNumber: 2, priorIntakeKind: 'transferee', paymentCount: 0, paymentTotal: '0.00', unallocatedPaymentCount: 0, unallocatedPaymentTotal: '0.00' }),
  Object.freeze({ studentNo: 'SHS-2026-0002', studentId: 102, annualId: 81, annualKey: '2593fbd5-8c18-4f64-9185-2887be264b12', userId: 8, gradeLevel: 'Grade 11', voucherCode: 'NV', entryTermNumber: 2, priorIntakeKind: 'transferee', paymentCount: 1, paymentTotal: '600.00', unallocatedPaymentCount: 1, unallocatedPaymentTotal: '600.00' }),
  Object.freeze({ studentNo: 'SHS-2026-0004', studentId: 224, annualId: 83, annualKey: '01628be6-8f69-48c6-8cf5-c2552aa45726', userId: 14, gradeLevel: 'Grade 11', voucherCode: 'PUB', entryTermNumber: 1, priorIntakeKind: 'new', paymentCount: 0, paymentTotal: '0.00', unallocatedPaymentCount: 0, unallocatedPaymentTotal: '0.00' })
]);
const MARIADB_REHEARSAL_ROOT = path.join(os.tmpdir(), 'arktiesiis-dummy-preview-');
const SCHOOL_SETUP_TABLES = Object.freeze([
  'academic_terms', 'school_year_term_order', 'school_year_term_order_reviews', 'sections', 'subjects',
  'student_subjects', 'annual_special_subjects', 'finance_schedules', 'finance_schedule_lines',
  'term_clearance_templates', 'term_clearance_template_items', 'physical_requirement_definitions'
]);
const CHECKSUM_FIELDS = Object.freeze([
  ['school_year', 'schoolYear'], ['first_name', 'firstName'], ['middle_name', 'middleName'],
  ['last_name', 'lastName'], ['suffix', 'suffix'], ['lrn', 'lrn'],
  ['student_contact_number', 'studentContactNumber'], ['voucher_type_text', 'voucherTypeText'],
  ['voucher_category_text', 'voucherCategoryText'], ['preferred_track', 'preferredTrack'],
  ['applicant_kind', 'applicantKind'], ['email', 'email'], ['birth_date', 'birthDate'], ['sex', 'sex'],
  ['address', 'address'], ['address_block_lot_street_purok', 'addressBlockLotStreetPurok'],
  ['address_barangay', 'addressBarangay'], ['address_city', 'addressCity'],
  ['address_province', 'addressProvince'], ['address_zip', 'addressZip'], ['profile_phone', 'profilePhone'],
  ['birthplace', 'birthplace'], ['facebook_name', 'facebookName'],
  ['emergency_contact_person', 'emergencyContactPerson'], ['emergency_contact_relationship', 'emergencyContactRelationship'],
  ['emergency_contact_phone', 'emergencyContactPhone'], ['emergency_contact_address', 'emergencyContactAddress'],
  ['emergency_contact_address_block_lot_street_purok', 'emergencyContactAddressBlockLotStreetPurok'],
  ['emergency_contact_address_barangay', 'emergencyContactAddressBarangay'],
  ['emergency_contact_address_city', 'emergencyContactAddressCity'],
  ['emergency_contact_address_province', 'emergencyContactAddressProvince'],
  ['emergency_contact_address_zip', 'emergencyContactAddressZip'],
  ['mother_name', 'motherName'], ['mother_phone', 'motherPhone'], ['father_name', 'fatherName'],
  ['father_phone', 'fatherPhone'], ['preferred_cluster', 'preferredCluster'],
  ['target_grade_level', 'targetGradeLevel'], ['prior_grade_level', 'priorGradeLevel'],
  ['prior_school', 'priorSchool'], ['student_signed_date', 'studentSignedDate'],
  ['received_by', 'receivedBy'], ['received_date', 'receivedDate']
]);

class RepairError extends Error {
  constructor(message) { super(message); this.name = 'RepairError'; }
}

function parseArgs(args) {
  const options = { mode: null, socket: null, deltaFile: null, backupFile: null, backupSha256: null };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--preview' || value === '--rehearse') {
      if (options.mode) throw new RepairError('Choose exactly one mode: --preview or --rehearse.');
      options.mode = value.slice(2);
    } else if (['--socket', '--delta-file', '--backup-file', '--backup-sha256'].includes(value)) {
      if (args[index + 1] === undefined || args[index + 1].startsWith('--')) throw new RepairError(`${value} requires a value.`);
      const next = args[++index];
      if (value === '--socket') options.socket = next;
      else if (value === '--delta-file') options.deltaFile = next;
      else if (value === '--backup-file') options.backupFile = next;
      else options.backupSha256 = next;
    } else throw new RepairError('Usage: node scripts/repair-hostinger-demo-enrollments.js --preview|--rehearse --socket <local MariaDB socket> --backup-file <private dump> --backup-sha256 <sha256> [--delta-file <private output path>].');
  }
  if (!options.mode || !options.socket || !path.isAbsolute(options.socket) || !options.backupFile
    || !path.isAbsolute(options.backupFile) || !/^[a-f0-9]{64}$/i.test(String(options.backupSha256 || ''))) {
    throw new RepairError('A mode, local MariaDB socket, private database backup file, and expected SHA-256 are required.');
  }
  if (options.mode === 'rehearse' && !options.deltaFile) throw new RepairError('Rehearsal requires a private delta output path outside the checkout.');
  if (options.deltaFile && (!path.isAbsolute(options.deltaFile) || options.deltaFile.startsWith(`${path.resolve(__dirname, '..')}${path.sep}`))) {
    throw new RepairError('The delta output must be an absolute private file outside the checkout.');
  }
  return options;
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

async function verifyBackup(filePath, expectedSha256) {
  const resolved = path.resolve(filePath);
  const checkout = path.resolve(__dirname, '..');
  if (resolved === checkout || resolved.startsWith(`${checkout}${path.sep}`)) throw new RepairError('The database backup must be outside the checkout.');
  const stats = await fs.lstat(resolved).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size < 1 || (stats.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new RepairError('The backup must be a private regular file owned by this user.');
  const digest = crypto.createHash('sha256').update(await fs.readFile(resolved)).digest('hex');
  if (digest.toLowerCase() !== String(expectedSha256).toLowerCase()) throw new RepairError('The private database backup SHA-256 does not match.');
  return digest;
}

function stableKey(value) { return stableUuid(`legacy-repair:${value}`); }

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new RepairError('Unexpected database identifier.');
  return `\`${value}\``;
}

function stableJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (Buffer.isBuffer(item)) return { __bytes: item.toString('base64') };
    if (item instanceof Date) return item.toISOString();
    return item;
  });
}

function canonicalRows(rows) { return rows.map((row) => stableJson(row)).sort(); }

async function allRows(pool, table, where = '', values = []) {
  const [rows] = await pool.execute(`SELECT * FROM ${quoteIdentifier(table)} ${where}`, values);
  return rows;
}

async function exactCounts(pool) {
  const [tables] = await pool.execute(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const counts = {};
  for (const { table_name: table } of tables) {
    const [rows] = await pool.execute(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
    counts[table] = Number(rows[0]?.count || 0);
  }
  return counts;
}

async function autoIncrementValues(pool, tables) {
  const [rows] = await pool.execute(`SELECT table_name, AUTO_INCREMENT AS next_id FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name IN (${tables.map(() => '?').join(', ')})`, tables);
  return Object.fromEntries(rows.map((row) => [row.table_name, row.next_id == null ? null : Number(row.next_id)]));
}

function tableDigest(rows) { return sha256(canonicalRows(rows).join('\n')); }

function sqlRowHash(row, columns) {
  const parts = columns.map((column) => {
    const value = row[column];
    if (value === null || value === undefined) return '-1:';
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value instanceof Date
      ? value.toISOString().replace('T', ' ').replace('Z', '') : String(value), 'utf8');
    return `${bytes.length}:${bytes.toString('hex').toUpperCase()}`;
  });
  return sha256(parts.join('|'));
}

function sqlTableDigest(rows, columns) {
  return sha256(rows.map((row) => sqlRowHash(row, columns)).sort().join(''));
}

async function selectCohort(pool) {
  const [rows] = await pool.execute(`SELECT annual.id AS annual_id, annual.student_id, annual.school_year,
      annual.grade_level, annual.voucher_code, annual.voucher_category, annual.intake_status,
      annual.entry_term_number, annual.intake_kind, annual.idempotency_key AS annual_key,
      annual.pre_enrollment_id, annual.account_activation_pending, student.student_no, student.lrn, student.first_name, student.middle_name,
      student.last_name, student.suffix, student.birth_date, student.sex, student.phone,
      student.status AS student_status, student.user_id, account.role AS user_role,
      account.is_active AS user_active, account.must_change_password,
      student.address, student.address_block_lot_street_purok, student.address_barangay, student.address_city,
      student.address_province, student.address_zip, student.birthplace, student.facebook_name,
      student.emergency_contact_person, student.emergency_contact_relationship, student.emergency_contact_phone,
      student.emergency_contact_address, student.emergency_contact_address_block_lot_street_purok,
      student.emergency_contact_address_barangay, student.emergency_contact_address_city,
      student.emergency_contact_address_province, student.emergency_contact_address_zip,
      student.mother_name, student.mother_phone, student.father_name, student.father_phone,
      section.cluster AS section_cluster, section.strand AS section_strand,
      assessment.id AS assessment_id, assessment.idempotency_key AS assessment_key,
      assessment.schedule_id, assessment.schedule_version, assessment.voucher_code_snapshot,
      assessment.request_fingerprint AS assessment_fingerprint,
      confirmation.id AS confirmation_id, confirmation.confirmed_by,
      (SELECT COUNT(*) FROM enrollments placement WHERE placement.annual_enrollment_id = annual.id) AS placement_count,
      (SELECT COUNT(*) FROM assessed_charges charge WHERE charge.annual_enrollment_id = annual.id) AS charge_count,
      (SELECT COUNT(*) FROM finance_payments payment WHERE payment.student_id = student.id) AS payment_count,
      CAST(COALESCE((SELECT SUM(payment.amount) FROM finance_payments payment WHERE payment.student_id = student.id), 0.00) AS CHAR(40)) AS payment_total,
      (SELECT COUNT(*) FROM finance_payments payment WHERE payment.student_id = student.id AND payment.is_reversed=0
        AND NOT EXISTS (SELECT 1 FROM finance_payment_allocations allocation WHERE allocation.payment_id=payment.id)) AS unallocated_payment_count,
      CAST(COALESCE((SELECT SUM(payment.amount) FROM finance_payments payment WHERE payment.student_id = student.id AND payment.is_reversed=0
        AND NOT EXISTS (SELECT 1 FROM finance_payment_allocations allocation WHERE allocation.payment_id=payment.id)), 0.00) AS CHAR(40)) AS unallocated_payment_total,
      (SELECT COUNT(*) FROM annual_enrollments history WHERE history.student_id = student.id) AS annual_history_count,
      (SELECT COUNT(*) FROM finance_departure_cases departure
        INNER JOIN annual_enrollments departure_annual ON departure_annual.id = departure.annual_enrollment_id
        WHERE departure_annual.student_id = student.id) AS departure_case_count,
      (SELECT COUNT(*) FROM readmission_evaluations evaluation
        WHERE evaluation.student_id = student.id OR evaluation.applicant_lrn = student.lrn) AS readmission_evaluation_count,
      (SELECT COUNT(*) FROM grades grade INNER JOIN student_subjects student_subject ON student_subject.id = grade.student_subject_id
        INNER JOIN enrollments placement ON placement.id = student_subject.enrollment_id
        WHERE placement.student_id = student.id) AS grade_count
    FROM students student
    INNER JOIN annual_enrollments annual ON annual.student_id = student.id
    LEFT JOIN users account ON account.id = student.user_id
    LEFT JOIN enrollments entry ON entry.annual_enrollment_id = annual.id
      AND entry.annual_term_number = annual.entry_term_number
    LEFT JOIN sections section ON section.id = entry.section_id
      AND section.academic_term_id = entry.academic_term_id
    LEFT JOIN annual_assessments assessment ON assessment.annual_enrollment_id = annual.id
    LEFT JOIN annual_registrar_confirmations confirmation ON confirmation.annual_enrollment_id = annual.id
    WHERE annual.school_year = ? AND (student.student_no BETWEEN ? AND ? OR student.student_no IN (${EXTRA_DUMMY_ALLOWLIST.map(() => '?').join(', ')}))
    ORDER BY student.student_no`, [SCHOOL_YEAR, `${STUDENT_PREFIX}0022`, `${STUDENT_PREFIX}0100`, ...EXTRA_DUMMY_ALLOWLIST.map(({ studentNo }) => studentNo)]);
  return rows;
}

async function actorIds(pool) {
  const [rows] = await pool.execute(`SELECT account.id, account.role, profile.user_id AS has_profile
    FROM users account LEFT JOIN staff_profiles profile ON profile.user_id = account.id
    WHERE account.is_active = 1 AND account.role IN ('database_admin','front_desk','registrar','finance') ORDER BY account.role, account.id`);
  const actors = {};
  for (const role of ['database_admin', 'front_desk', 'registrar', 'finance']) {
    const candidates = rows.filter((row) => row.role === role);
    if (candidates.length !== 1 || !candidates[0].has_profile) throw new RepairError(`Expected exactly one active ${role} staff account with a profile.`);
    actors[role] = Number(candidates[0].id);
  }
  return actors;
}

function assertPlanCohort(rows, plan) {
  const expected = plan.annualStudents.filter(({ ordinal }) => ordinal >= FIRST_ORDINAL && ordinal <= LAST_ORDINAL);
  const legacyRows = rows.filter((row) => String(row.student_no).startsWith(STUDENT_PREFIX));
  const extraRows = rows.filter((row) => !String(row.student_no).startsWith(STUDENT_PREFIX));
  if (legacyRows.length !== expected.length || expected.length !== LAST_ORDINAL - FIRST_ORDINAL + 1
    || extraRows.length !== EXTRA_DUMMY_ALLOWLIST.length || rows.length !== 82) {
    throw new RepairError('The exact 79 Hostinger demo rows plus the three approved dummy identities do not match the 82-record target.');
  }
  const annualByNo = new Map(expected.map((annual) => [annual.studentNo, annual]));
  for (const row of legacyRows) {
    const seed = annualByNo.get(row.student_no);
    if (!seed || row.school_year !== SCHOOL_YEAR || row.student_status !== 'active' || row.intake_kind !== 'new'
      || row.user_id != null || row.pre_enrollment_id != null || row.annual_key !== seed.annualKey
      || row.assessment_key !== stableUuid(`assessment:${seed.ordinal}`) || Number(row.placement_count) !== 3
      || Number(row.charge_count) !== 6 || !/^[0-9]{12}$/.test(String(row.lrn || ''))
      || !['pending', 'enrolled'].includes(row.intake_status) || Number(row.account_activation_pending) !== 0) {
      throw new RepairError('A target annual differs from the fixed legacy Hostinger demo seed fingerprint.');
    }
    if ((row.intake_status === 'enrolled') !== (row.confirmation_id != null)) {
      throw new RepairError('A target annual has an inconsistent confirmation state.');
    }
  }
  for (const expectedExtra of EXTRA_DUMMY_ALLOWLIST) {
    const row = extraRows.find((candidate) => candidate.student_no === expectedExtra.studentNo);
    if (!row || Number(row.student_id) !== expectedExtra.studentId || Number(row.annual_id) !== expectedExtra.annualId
      || row.annual_key !== expectedExtra.annualKey || Number(row.user_id) !== expectedExtra.userId
      || row.school_year !== SCHOOL_YEAR || row.grade_level !== expectedExtra.gradeLevel
      || row.voucher_code !== expectedExtra.voucherCode || Number(row.entry_term_number) !== expectedExtra.entryTermNumber
      || row.intake_kind !== expectedExtra.priorIntakeKind || row.intake_status !== 'pending'
      || row.pre_enrollment_id != null || Number(row.account_activation_pending) !== 1
      || row.student_status !== 'active' || row.user_role !== 'student' || Number(row.user_active) !== 0
      || Number(row.must_change_password) !== 1 || Number(row.placement_count) !== 3
      || row.assessment_id != null || Number(row.charge_count) !== 0 || Number(row.payment_count) !== expectedExtra.paymentCount
      || String(row.payment_total) !== expectedExtra.paymentTotal
      || Number(row.unallocated_payment_count) !== expectedExtra.unallocatedPaymentCount
      || String(row.unallocated_payment_total) !== expectedExtra.unallocatedPaymentTotal
      || Number(row.annual_history_count) !== 1 || Number(row.departure_case_count) !== 0
      || Number(row.readmission_evaluation_count) !== 0 || Number(row.grade_count) !== 0
      || !/^[0-9]{12}$/.test(String(row.lrn || '')) || row.confirmation_id != null) {
      throw new RepairError(`The exact saved backup fingerprint for ${expectedExtra.studentNo} or its no-prior-history evidence changed.`);
    }
  }
  const confirmed = legacyRows.filter((row) => row.intake_status === 'enrolled').length;
  const pending = legacyRows.filter((row) => row.intake_status === 'pending').length;
  if (confirmed !== 22 || pending !== 57) throw new RepairError('The original confirmed/pending fixture split changed from 22/57.');
  return { count: rows.length, legacyCount: legacyRows.length, explicitExtraCount: extraRows.length,
    confirmedBefore: confirmed, pendingBefore: pending, unassessedPendingExtras: extraRows.length,
    totalExistingCharges: rows.reduce((sum, row) => sum + Number(row.charge_count), 0),
    preservedTargetPaymentRows: extraRows.reduce((sum, row) => sum + Number(row.payment_count), 0),
    preservedUnallocatedTargetCredits: extraRows.filter((row) => Number(row.unallocated_payment_count) > 0)
      .map((row) => ({ studentNo: row.student_no, paymentCount: Number(row.unallocated_payment_count), availableCredit: String(row.unallocated_payment_total) })),
    extraIdentityAllowlist: EXTRA_DUMMY_ALLOWLIST.map(({ studentNo, studentId, annualId, userId }) => ({ studentNo, studentId, annualId, userId })),
    targetDigest: sha256(rows.map((row) => `${row.student_no}:${row.student_id}:${row.annual_id}:${row.annual_key}:${row.intake_status}:${row.assessment_key || ''}`).join('\n')) };
}

function fixtureKeyPart(row) {
  return String(row.student_no).startsWith(STUDENT_PREFIX)
    ? String(Number(row.student_no.slice(STUDENT_PREFIX.length))) : row.student_no;
}

function extraDummyTarget(studentNo) {
  return EXTRA_DUMMY_ALLOWLIST.find((item) => item.studentNo === studentNo) || null;
}

function buildSourceRecord(row) {
  const keyPart = fixtureKeyPart(row);
  const ordinal = String(row.student_no).startsWith(STUDENT_PREFIX) ? Number(keyPart) : null;
  const phone = typeof row.phone === 'string' && row.phone.trim() ? row.phone : '0000000000';
  const sex = ['male', 'female', 'other'].includes(String(row.sex || '').toLowerCase()) ? row.sex : '';
  const humss = row.section_cluster === 'Academic' && row.section_strand === 'HUMSS';
  const preferredTrack = 'Academic Track';
  const preferredCluster = 'ASSH (Arts, Social Science, and Humanities)';
  const syntheticEmailAlias = ordinal === null
    ? `fixture-${String(keyPart).toLowerCase()}` : String(ordinal).padStart(4, '0');
  const payload = {
    idempotencyKey: stableKey(`source-token:${keyPart}`), schoolYear: row.school_year,
    firstName: row.first_name, middleName: row.middle_name || '', lastName: row.last_name, suffix: row.suffix || '',
    lrn: row.lrn, studentContactNumber: phone, email: `demo-hostinger-${syntheticEmailAlias}@example.invalid`,
    birthDate: row.birth_date ? String(row.birth_date).slice(0, 10) : '', sex,
    profilePhone: phone, birthplace: row.birthplace || '', facebookName: row.facebook_name || '',
    emergencyContactPerson: row.emergency_contact_person || '',
    emergencyContactRelationship: row.emergency_contact_relationship || '',
    emergencyContactPhone: row.emergency_contact_phone || '',
    motherName: row.mother_name || '', motherPhone: row.mother_phone || '',
    fatherName: row.father_name || '', fatherPhone: row.father_phone || '',
    addressMode: 'preserve', emergencyContactAddressMode: 'preserve',
    preferredTrack, preferredCluster, applicantKind: 'new', targetGradeLevel: row.grade_level,
    priorGradeLevel: 'Synthetic demo fixture only', priorSchool: 'Synthetic demo fixture only; no paper source',
    studentSignaturePresent: '1', studentSignedDate: TODAY,
    receivedBy: 'SYNTHETIC DEMO FIXTURE; NO PAPER INSPECTED', receivedDate: TODAY,
    voucherTypeText: '', voucherCategoryText: '', status: 'ready_for_registrar'
  };
  const record = normalizeRecord(payload, { current: row });
  const preferenceContext = {
    fixtureType: FIXTURE_MARKER, preferenceFieldsSynthetic: true,
    seedSectionContext: { cluster: row.section_cluster || null, strand: row.section_strand || null },
    syntheticPreferenceMapping: humss ? 'Academic/HUMSS shown as a synthetic Academic/ASSH intake preference.'
      : 'A validator-accepted synthetic Academic/ASSH intake preference; no paper preference was supplied.',
    syntheticValues: ['student contact if absent from profile', 'reserved non-deliverable email', 'preference track and cluster',
      'prior grade and school', 'signature-present flag', 'signature date', 'receiver/date'],
    paperInspected: false, studentSignatureInspected: false,
    receiptItemsMarkedReceived: false, paperClearanceRecorded: false,
    note: 'Legacy demo annual adoption. Fixture values satisfy ordinary ready validation; they are not paper transcription or evidence.'
  };
  if (row.intake_kind === 'transferee') {
    preferenceContext.syntheticValues.push('Legacy intake classification normalized from transferee to new after backup history showed no prior internal annual, departure, or readmission record.');
  }
  preferenceContext.sourceIdentity = row.student_no;
  return { ordinal, keyPart, record, preferenceContext, id: stableKey(`source:${keyPart}`), idempotencyKey: stableKey(`source-token:${keyPart}`) };
}

function rowRevisionValues(source) {
  const changed = [];
  for (const [column, key] of CHECKSUM_FIELDS) {
    const value = source.record[key] ?? null;
    if (value !== null) changed.push([column, null, String(value)]);
  }
  for (const requirement of RECEIPT_REQUIREMENTS) {
    const code = requirement[0];
    for (const suffix of ['original_received', 'photocopy_received']) {
      changed.push([`receipt_${code}_${suffix}`, null, 'false']);
    }
  }
  return changed;
}

async function snapshotTables(pool, tables) {
  const output = {};
  for (const table of tables) output[table] = await allRows(pool, table, 'ORDER BY 1');
  return output;
}

function listChangedTables(before, after) {
  return Object.keys(before).filter((table) => stableJson(canonicalRows(before[table])) !== stableJson(canonicalRows(after[table])));
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) value = value.toISOString().replace('T', ' ').replace('Z', '');
  return `CONVERT(X'${Buffer.from(String(value), 'utf8').toString('hex')}' USING utf8mb4)`;
}

function sumMoney(rows, column) {
  const cents = rows.reduce((sum, row) => {
    const value = String(row[column] ?? '0.00');
    const match = value.match(/^(-?)(\d+)\.(\d{2})$/);
    if (!match) throw new RepairError('A verified financial amount has an unsupported decimal representation.');
    const amount = BigInt(match[2]) * 100n + BigInt(match[3]);
    return sum + (match[1] ? -amount : amount);
  }, 0n);
  const sign = cents < 0n ? '-' : '';
  const positive = cents < 0n ? -cents : cents;
  return `${sign}${positive / 100n}.${String(positive % 100n).padStart(2, '0')}`;
}

function subtractMoney(minuend, subtrahend) {
  const toCents = (value) => {
    const match = String(value).match(/^(\d+)\.(\d{2})$/);
    if (!match) throw new RepairError('A verified financial amount has an unsupported decimal representation.');
    return BigInt(match[1]) * 100n + BigInt(match[2]);
  };
  const cents = toCents(minuend) - toCents(subtrahend);
  if (cents < 0n) throw new RepairError('The saved exemption exceeds its assessed gross charges.');
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

async function tableColumns(pool, table) {
  const [rows] = await pool.execute(`SELECT column_name, extra FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`, [table]);
  return rows.filter((row) => !/generated/i.test(row.extra || '')).map((row) => row.column_name);
}

function rowKey(table, row) {
  if (table === 'pre_enrollment_receipts') return `${row.pre_enrollment_id}:${row.requirement_code}`;
  const key = row.id ?? row.pre_enrollment_id ?? row.annual_enrollment_id;
  if (key === null || key === undefined) throw new RepairError(`No supported primary key for changed table ${table}.`);
  return String(key);
}

function deltaPredicateColumns(table, columns) {
  if (table !== 'users') return columns;
  const guardedColumns = ['id', 'is_active', 'updated_at'];
  if (guardedColumns.some((column) => !columns.includes(column))) throw new RepairError('The account update is missing its non-secret compare-and-swap fields.');
  return guardedColumns;
}

async function makeDeltaSql(pool, before, after, beforeAutoIncrement, afterAutoIncrement, cohort, summary, actors) {
  const insertOrder = ['pre_enrollments', 'pre_enrollment_receipts', 'pre_enrollment_revisions', 'pre_enrollment_events',
    'users', 'students', 'annual_enrollments', 'annual_assessments', 'assessed_charges', 'finance_exemption_applications',
    'finance_charge_adjustments', 'annual_registrar_confirmations', 'enrollments', 'annual_enrollment_events', 'audit_logs'];
  const changed = listChangedTables(before, after).sort((left, right) => insertOrder.indexOf(left) - insertOrder.indexOf(right));
  const allowed = new Set(['pre_enrollments', 'pre_enrollment_receipts', 'pre_enrollment_revisions', 'pre_enrollment_events',
    'audit_logs', 'annual_enrollments', 'annual_registrar_confirmations', 'annual_enrollment_events', 'enrollments',
    'annual_assessments', 'assessed_charges', 'finance_exemption_applications', 'finance_charge_adjustments', 'students', 'users']);
  if (changed.some((table) => !allowed.has(table))) throw new RepairError(`Rehearsal changed an unexpected database table (${changed.filter((t) => !allowed.has(t)).join(', ')}).`);
  const statements = [];
  for (const table of changed) {
    const columns = await tableColumns(pool, table);
    const keyMap = new Map(before[table].map((row) => [rowKey(table, row), row]));
    const insertedRows = [];
    const rows = after[table];
    for (const row of rows) {
      const key = rowKey(table, row);
      const prior = keyMap.get(key);
      if (!prior) {
        insertedRows.push(row);
        continue;
      }
      const updated = columns.filter((column) => stableJson(prior[column]) !== stableJson(row[column]));
      if (!updated.length) continue;
      const predicates = deltaPredicateColumns(table, columns)
        .map((column) => `${quoteIdentifier(column)} <=> ${sqlLiteral(prior[column])}`);
      statements.push(`UPDATE ${quoteIdentifier(table)} SET ${updated.map((column) => `${quoteIdentifier(column)} = ${sqlLiteral(row[column])}`).join(', ')} WHERE ${predicates.join(' AND ')};`);
      statements.push(`IF ROW_COUNT() <> 1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Stale or ambiguous row image in ${table}'; END IF;`);
    }
    if (insertedRows.length) {
      const values = insertedRows.map((row) => `(${columns.map((column) => sqlLiteral(row[column])).join(', ')})`);
      statements.push(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES\n      ${values.join(',\n      ')};`);
      statements.push(`IF ROW_COUNT() <> ${insertedRows.length} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Unexpected insert count in ${table}'; END IF;`);
    }
  }
  const protectedTables = ['students', 'users', 'staff_profiles', 'annual_enrollments', 'enrollments', 'annual_enrollment_events',
    'annual_registrar_confirmations', 'pre_enrollments', 'pre_enrollment_receipts', 'pre_enrollment_revisions',
    'pre_enrollment_events', 'audit_logs', 'annual_assessments', 'assessed_charges', 'readmission_evaluations', 'finance_payments',
    'finance_payment_allocations', 'finance_allocation_batches', 'finance_payment_reversals', 'finance_charge_adjustments',
    'finance_exemption_applications', 'finance_exemption_rules', 'finance_exemption_cases', 'finance_legacy_reconciliations',
    'finance_legacy_reconciliation_batches', 'finance_legacy_reconciliation_releases', 'finance_payment_allocation_releases',
    'finance_legacy_opening_charges', 'finance_transaction_reversals', 'student_term_clearances',
    'student_term_clearance_items', 'student_term_clearance_events', ...SCHOOL_SETUP_TABLES];
  const columnsByTable = {};
  for (const table of protectedTables) {
    if (before[table]) columnsByTable[table] = await tableColumns(pool, table);
  }
  const maxFingerprintBytes = Math.max(1024, ...Object.keys(columnsByTable)
    .map((table) => Math.max(before[table].length, after[table].length) * 64));
  if (maxFingerprintBytes > 4294967295) throw new RepairError('A protected table is too large for a bounded SQL fingerprint guard.');
  const guardStatements = [];
  for (const table of protectedTables) {
    if (!before[table]) continue;
    const columns = columnsByTable[table];
    const digest = sqlTableDigest(before[table], columns);
    guardStatements.push(`IF SHA2(COALESCE((SELECT GROUP_CONCAT(row_hash ORDER BY row_hash SEPARATOR '') FROM (SELECT SHA2(CONCAT_WS('|', ${
      columns.map((column) => `COALESCE(CONCAT(OCTET_LENGTH(CAST(${quoteIdentifier(column)} AS BINARY)), ':', HEX(CAST(${quoteIdentifier(column)} AS BINARY))), '-1:')`).join(', ')
    }), 256) AS row_hash FROM ${quoteIdentifier(table)}) AS preimage_rows), ''), 256) <> '${digest}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Protected pre-repair fingerprint changed: ${table}'; END IF;`);
    if (beforeAutoIncrement[table] != null) guardStatements.push(`IF (SELECT AUTO_INCREMENT FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}') <> ${Number(beforeAutoIncrement[table])} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Auto-increment position changed: ${table}'; END IF;`);
  }
  const afterGuardStatements = [];
  for (const table of protectedTables.filter((name) => after[name])) {
    const columns = columnsByTable[table] || await tableColumns(pool, table);
    const digest = sqlTableDigest(after[table], columns);
    afterGuardStatements.push(`IF SHA2(COALESCE((SELECT GROUP_CONCAT(row_hash ORDER BY row_hash SEPARATOR '') FROM (SELECT SHA2(CONCAT_WS('|', ${columns
      .map((column) => `COALESCE(CONCAT(OCTET_LENGTH(CAST(${quoteIdentifier(column)} AS BINARY)), ':', HEX(CAST(${quoteIdentifier(column)} AS BINARY))), '-1:')`).join(', ')
    }), 256) AS row_hash FROM ${quoteIdentifier(table)}) AS postimage_rows), ''), 256) <> '${digest}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Completed repair post-image mismatch: ${table}'; END IF;`);
    if (afterAutoIncrement[table] != null) afterGuardStatements.push(`IF (SELECT AUTO_INCREMENT FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${table}') <> ${Number(afterAutoIncrement[table])} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Completed repair auto-increment mismatch: ${table}'; END IF;`);
  }
  const setupDigests = Object.fromEntries(SCHOOL_SETUP_TABLES.filter((table) => before[table])
    .map((table) => [table, tableDigest(before[table])]));
  const beforeFingerprints = Object.fromEntries(protectedTables.filter((table) => before[table])
    .map((table) => [table, sqlTableDigest(before[table], columnsByTable[table])]));
  const afterFingerprints = Object.fromEntries(protectedTables.filter((table) => after[table])
    .map((table) => [table, sqlTableDigest(after[table], columnsByTable[table])]));
  summary.schoolSetupFingerprints = setupDigests;
  summary.protectedFingerprintsBefore = beforeFingerprints;
  summary.protectedFingerprintsAfter = afterFingerprints;
  summary.sqlFingerprintConcatLimit = maxFingerprintBytes;
  const targetStudentIds = EXTRA_DUMMY_ALLOWLIST.map(({ studentId }) => studentId).join(', ');
  const targetAnnualIds = EXTRA_DUMMY_ALLOWLIST.map(({ annualId }) => annualId).join(', ');
  const targetUserIds = EXTRA_DUMMY_ALLOWLIST.map(({ userId }) => userId);
  const sourceRecords = cohort.map(buildSourceRecord);
  const sourceIds = sourceRecords.map((source) => sqlLiteral(source.id)).join(', ');
  const sourceTokens = sourceRecords.map((source) => sqlLiteral(source.idempotencyKey)).join(', ');
  const targetStudents = (alias = 'student') => `(${alias}.student_no BETWEEN '${STUDENT_PREFIX}0022' AND '${STUDENT_PREFIX}0100' OR ${alias}.id IN (${targetStudentIds}))`;
  const targetAnnuals = `(${targetStudents('student')} AND annual.school_year='${SCHOOL_YEAR}')`;
  const sourceLrnFilter = `source.school_year='${SCHOOL_YEAR}' AND source.lrn IN (SELECT student.lrn FROM students student WHERE ${targetStudents('student')})`;
  const lockStatements = [
    `SELECT COUNT(*) INTO lockRows FROM students student WHERE ${targetStudents('student')} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM annual_enrollments annual JOIN students student ON student.id=annual.student_id WHERE ${targetAnnuals} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM annual_assessments assessment JOIN annual_enrollments annual ON annual.id=assessment.annual_enrollment_id JOIN students student ON student.id=annual.student_id WHERE ${targetAnnuals} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM enrollments placement JOIN annual_enrollments annual ON annual.id=placement.annual_enrollment_id JOIN students student ON student.id=annual.student_id WHERE ${targetAnnuals} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM annual_registrar_confirmations confirmation JOIN annual_enrollments annual ON annual.id=confirmation.annual_enrollment_id JOIN students student ON student.id=annual.student_id WHERE ${targetAnnuals} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM annual_enrollment_events event JOIN annual_enrollments annual ON annual.id=event.annual_enrollment_id JOIN students student ON student.id=annual.student_id WHERE ${targetAnnuals} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM assessed_charges charge JOIN annual_enrollments annual ON annual.id=charge.annual_enrollment_id JOIN students student ON student.id=annual.student_id WHERE ${targetAnnuals} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM finance_charge_adjustments adjustment JOIN assessed_charges charge ON charge.id=adjustment.charge_id JOIN annual_enrollments annual ON annual.id=charge.annual_enrollment_id JOIN students student ON student.id=annual.student_id WHERE ${targetAnnuals} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM finance_exemption_applications application JOIN assessed_charges charge ON charge.id=application.charge_id JOIN annual_enrollments annual ON annual.id=charge.annual_enrollment_id JOIN students student ON student.id=annual.student_id WHERE ${targetAnnuals} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM finance_payments payment JOIN students student ON student.id=payment.student_id WHERE ${targetStudents('student')} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM finance_allocation_batches batch JOIN students student ON student.id=batch.student_id WHERE ${targetStudents('student')} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM finance_payment_allocations allocation JOIN assessed_charges charge ON charge.id=allocation.charge_id JOIN annual_enrollments annual ON annual.id=charge.annual_enrollment_id JOIN students student ON student.id=annual.student_id WHERE ${targetAnnuals} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM finance_payment_reversals reversal JOIN finance_payments payment ON payment.id=reversal.payment_id JOIN students student ON student.id=payment.student_id WHERE ${targetStudents('student')} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM finance_payment_allocation_releases release_row JOIN finance_payment_allocations allocation ON allocation.id=release_row.allocation_id JOIN assessed_charges charge ON charge.id=allocation.charge_id JOIN annual_enrollments annual ON annual.id=charge.annual_enrollment_id JOIN students student ON student.id=annual.student_id WHERE ${targetAnnuals} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM pre_enrollments source WHERE ${sourceLrnFilter} FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM pre_enrollments source WHERE source.id IN (${sourceIds}) FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM pre_enrollments source WHERE source.idempotency_key IN (${sourceTokens}) FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM pre_enrollment_receipts receipt WHERE receipt.pre_enrollment_id IN (${sourceIds}) FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM pre_enrollment_revisions revision WHERE revision.pre_enrollment_id IN (${sourceIds}) FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM pre_enrollment_events event WHERE event.pre_enrollment_id IN (${sourceIds}) FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM readmission_evaluations evaluation WHERE evaluation.student_id IN (${targetStudentIds}) OR evaluation.applicant_lrn IN (SELECT student.lrn FROM students student WHERE ${targetStudents('student')}) FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM users account WHERE account.id IN (${[...targetUserIds, actors.database_admin, actors.front_desk, actors.registrar, actors.finance].map(Number).join(', ')}) FOR UPDATE;`,
    `SELECT COUNT(*) INTO lockRows FROM staff_profiles profile WHERE profile.user_id IN (${[actors.database_admin, actors.front_desk, actors.registrar, actors.finance].map(Number).join(', ')}) FOR UPDATE;`,
    'SELECT COUNT(*) INTO lockRows FROM audit_logs FOR UPDATE;',
    ...SCHOOL_SETUP_TABLES.filter((table) => before[table]).map((table) => `SELECT COUNT(*) INTO lockRows FROM ${quoteIdentifier(table)} FOR UPDATE;`)
  ];
  const header = `-- Scoped additive repair delta for ${DATABASE}; generated from supported-service clone rehearsal.
-- Requires MariaDB 11.8+, the exact before-image, and the private pre-repair dump verified by the operator.
-- Review the matching backup SHA-256 and live cohort preview before importing. No DDL or foreign-key changes.
-- The proposed delta includes three admin-service activations. Obtain the requested action-time confirmation before any hosted import.
-- Those activations alter only is_active/updated_at; existing emails, roles, password hashes, must-change flags, and session versions are guarded.
-- If an import fails after inserts, MariaDB may consume AUTO_INCREMENT values despite rollback. Never retry a failed artifact; take a fresh backup/preview and regenerate.
-- Backup SHA-256: ${summary.backupSha256}
USE ${quoteIdentifier(DATABASE)};
DELIMITER $$
BEGIN NOT ATOMIC
  DECLARE lockRows BIGINT DEFAULT 0;
  DECLARE originalGroupConcatLen BIGINT;
  DECLARE originalTimeZone VARCHAR(64);
  DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN
    ROLLBACK;
    IF originalGroupConcatLen IS NOT NULL THEN SET SESSION group_concat_max_len = originalGroupConcatLen; END IF;
    IF originalTimeZone IS NOT NULL THEN SET SESSION time_zone = originalTimeZone; END IF;
    RESIGNAL;
  END;
  SET originalGroupConcatLen = @@session.group_concat_max_len;
  SET originalTimeZone = @@session.time_zone;
  SET SESSION group_concat_max_len = ${maxFingerprintBytes};
  SET SESSION time_zone = '+00:00';
  SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
  START TRANSACTION;
  IF DATABASE() <> '${DATABASE}' OR @@version NOT LIKE '11.8.%MariaDB%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Wrong database identity or unsupported MariaDB version';
  END IF;
  IF (SELECT COUNT(*) FROM schema_migrations) <> 18 OR (SELECT MAX(version) FROM schema_migrations) <> 'v2.018' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Unexpected schema migration state';
  END IF;
  -- Complete-state replay is a safe no-op; partial/mismatched states fail the preimage guards below.
  IF (SELECT COUNT(*) FROM pre_enrollments source WHERE EXISTS(SELECT 1 FROM pre_enrollment_events event
      WHERE event.pre_enrollment_id = source.id AND JSON_UNQUOTE(JSON_EXTRACT(event.details_json, '$.demoFixture.fixtureType')) = '${FIXTURE_MARKER}')) = 82
     AND (SELECT COUNT(*) FROM annual_enrollments annual JOIN students student ON student.id=annual.student_id
       WHERE ${targetAnnuals}
         AND annual.intake_status='enrolled' AND annual.pre_enrollment_id IS NOT NULL
         AND EXISTS(SELECT 1 FROM annual_registrar_confirmations confirmation WHERE confirmation.annual_enrollment_id=annual.id)) = 82
     AND (SELECT COUNT(*) FROM users account WHERE account.id IN (${targetUserIds.join(', ')}) AND account.is_active=1) = 3 THEN
    ${afterGuardStatements.join('\n    ')}
    SET SESSION group_concat_max_len = originalGroupConcatLen;
    SET SESSION time_zone = originalTimeZone;
    COMMIT;
  ELSE
    -- Result-free locking reads keep the phpMyAdmin import connection synchronized.
    ${lockStatements.join('\n    ')}
    ${guardStatements.join('\n    ')}
    ${statements.join('\n    ')}
    ${afterGuardStatements.join('\n    ')}
    SET SESSION group_concat_max_len = originalGroupConcatLen;
    SET SESSION time_zone = originalTimeZone;
    COMMIT;
  END IF;
END$$
DELIMITER ;
`;
  const hashFor = (table) => {
    const columns = columnsByTable[table];
    return `SHA2(COALESCE((SELECT GROUP_CONCAT(row_hash ORDER BY row_hash SEPARATOR '') FROM (SELECT SHA2(CONCAT_WS('|', ${columns
      .map((column) => `COALESCE(CONCAT(OCTET_LENGTH(CAST(${quoteIdentifier(column)} AS BINARY)), ':', HEX(CAST(${quoteIdentifier(column)} AS BINARY))), '-1:')`).join(', ')
    }), 256) AS row_hash FROM ${quoteIdentifier(DATABASE)}.${quoteIdentifier(table)}) AS fingerprint_rows), ''), 256)`;
  };
  const verificationPreamble = [
    '-- Read-only Hostinger dummy repair verification. It returns only aggregate counts and table fingerprints.',
    '-- Run against the exact expected database before apply (before-image) and after apply (post-image).',
    '-- No credentials, student names, LRNs, emails, or financial row details are selected.',
    `USE ${quoteIdentifier(DATABASE)};`,
    'SET @dummy_repair_verify_group_concat = @@session.group_concat_max_len;',
    'SET @dummy_repair_verify_time_zone = @@session.time_zone;',
    `SET SESSION group_concat_max_len = ${maxFingerprintBytes};`,
    `SET SESSION time_zone = '+00:00';`,
    `SELECT DATABASE() AS database_name, VERSION() AS mariadb_version, (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.schema_migrations) AS migration_count, (SELECT MAX(version) FROM ${quoteIdentifier(DATABASE)}.schema_migrations) AS latest_migration;`,
    `SELECT COUNT(*) AS target_annuals, SUM(annual.intake_status='pending') AS pending_annuals, SUM(annual.intake_status='enrolled') AS enrolled_annuals, SUM(annual.pre_enrollment_id IS NULL) AS unlinked_annuals, SUM(annual.account_activation_pending=1) AS activation_pending FROM ${quoteIdentifier(DATABASE)}.annual_enrollments annual JOIN ${quoteIdentifier(DATABASE)}.students student ON student.id=annual.student_id WHERE ${targetAnnuals};`,
    `SELECT COUNT(*) AS synthetic_demo_sources FROM ${quoteIdentifier(DATABASE)}.pre_enrollments source WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier(DATABASE)}.pre_enrollment_events event WHERE event.pre_enrollment_id=source.id AND JSON_UNQUOTE(JSON_EXTRACT(event.details_json, '$.demoFixture.fixtureType'))='${FIXTURE_MARKER}');`,
    `SELECT COUNT(*) AS confirmed_target_annuals, SUM(confirmation.id IS NOT NULL) AS confirmation_rows, SUM(source.status='enrollment_started' AND source.created_by_role='front_desk') AS adopted_front_desk_sources FROM ${quoteIdentifier(DATABASE)}.annual_enrollments annual JOIN ${quoteIdentifier(DATABASE)}.students student ON student.id=annual.student_id LEFT JOIN ${quoteIdentifier(DATABASE)}.annual_registrar_confirmations confirmation ON confirmation.annual_enrollment_id=annual.id LEFT JOIN ${quoteIdentifier(DATABASE)}.pre_enrollments source ON source.id=annual.pre_enrollment_id WHERE ${targetAnnuals} AND annual.intake_status='enrolled' AND annual.pre_enrollment_id IS NOT NULL;`,
    `SELECT (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.annual_assessments) AS all_assessments, (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.assessed_charges) AS posted_charge_rows, (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.finance_payments) AS payment_rows, (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.users) AS user_accounts, (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.staff_profiles) AS staff_profiles;`
  ];
  const makeFingerprintSelect = (table, expected) => {
    const currentName = `current_${table}`;
    const current = `(SELECT COUNT(*) AS row_count, ${hashFor(table)} AS fingerprint FROM ${quoteIdentifier(DATABASE)}.${quoteIdentifier(table)}) AS ${quoteIdentifier(currentName)}`;
    return `SELECT '${table}' AS table_name, current_image.row_count, current_image.fingerprint, '${expected}' AS expected_fingerprint, (current_image.fingerprint='${expected}') AS matches FROM ${current.replace(currentName, 'current_image')};`;
  };
  const beforeSqlParts = [...verificationPreamble,
    '-- Baseline fingerprints; every matches value must be 1 before an import is considered.',
    ...protectedTables.filter((table) => before[table]).map((table) => makeFingerprintSelect(table, beforeFingerprints[table])),
    'SET SESSION group_concat_max_len = @dummy_repair_verify_group_concat;',
    'SET SESSION time_zone = @dummy_repair_verify_time_zone;'];
  const verificationParts = [...verificationPreamble,
    '-- Post-image fingerprints; every matches value must be 1 after import.',
    ...protectedTables.filter((table) => after[table]).map((table) => makeFingerprintSelect(table, afterFingerprints[table])),
    'SET SESSION group_concat_max_len = @dummy_repair_verify_group_concat;',
    'SET SESSION time_zone = @dummy_repair_verify_time_zone;'];
  summary.failedImportRecovery = 'MariaDB may advance AUTO_INCREMENT counters for rolled-back inserts. If an apply import errors, never rerun that artifact; take a fresh backup and preview, then regenerate guards.';
  return { sql: header, beforeSql: `${beforeSqlParts.join('\n')}\n`, verificationSql: `${verificationParts.join('\n')}\n`, changedTables: changed, deltaStatements: statements.length,
    protectedTables: protectedTables.filter((table) => before[table]), targetCount: cohort.length, summary,
    beforeFingerprints, afterFingerprints, columnsByTable, maxFingerprintBytes };
}

function buildIntegrityAssertionSql({ phase, fingerprints, counts, autoIncrement, columnsByTable, maxFingerprintBytes }) {
  if (!['before', 'after'].includes(phase)) throw new RepairError('Choose a before or after database assertion phase.');
  const tableNames = Object.keys(fingerprints || {}).sort();
  if (tableNames.length !== 44 || !Number.isSafeInteger(Number(maxFingerprintBytes)) || Number(maxFingerprintBytes) < 1024) {
    throw new RepairError('The database assertion requires all 44 protected table fingerprints and a bounded digest size.');
  }
  const hashExpression = (table) => {
    const columns = columnsByTable[table];
    if (!Array.isArray(columns) || !columns.length || !/^[a-f0-9]{64}$/i.test(String(fingerprints[table] || ''))
      || !Number.isSafeInteger(Number(counts[table])) || Number(counts[table]) < 0) {
      throw new RepairError(`Missing a verified row image for assertion table ${table}.`);
    }
    return `SHA2(COALESCE((SELECT GROUP_CONCAT(row_hash ORDER BY row_hash SEPARATOR '') FROM (SELECT SHA2(CONCAT_WS('|', ${columns
      .map((column) => `COALESCE(CONCAT(OCTET_LENGTH(CAST(${quoteIdentifier(column)} AS BINARY)), ':', HEX(CAST(${quoteIdentifier(column)} AS BINARY))), '-1:')`).join(', ')
    }), 256) AS row_hash FROM ${quoteIdentifier(DATABASE)}.${quoteIdentifier(table)}) AS assertion_rows), ''), 256)`;
  };
  const assertions = tableNames.flatMap((table) => {
    const statements = [
      `IF (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.${quoteIdentifier(table)}) <> ${Number(counts[table])} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Assertion row count mismatch: ${table}'; END IF;`,
      `IF ${hashExpression(table)} <> '${fingerprints[table]}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Assertion fingerprint mismatch: ${table}'; END IF;`
    ];
    if (autoIncrement?.[table] != null) {
      const expected = Number(autoIncrement[table]);
      if (!Number.isSafeInteger(expected) || expected < 1) throw new RepairError(`Invalid AUTO_INCREMENT assertion for ${table}.`);
      statements.push(`IF COALESCE((SELECT AUTO_INCREMENT FROM information_schema.tables WHERE table_schema = '${DATABASE}' AND table_name = '${table}'), -1) <> ${expected} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Assertion AUTO_INCREMENT mismatch: ${table}'; END IF;`);
    }
    return statements;
  });
  const targetStudents = `(student.student_no BETWEEN '${STUDENT_PREFIX}0022' AND '${STUDENT_PREFIX}0100' OR student.id IN (${EXTRA_DUMMY_ALLOWLIST.map(({ studentId }) => studentId).join(', ')}))`;
  const targetAnnuals = `(${targetStudents} AND annual.school_year='${SCHOOL_YEAR}')`;
  const extraUserIds = EXTRA_DUMMY_ALLOWLIST.map(({ userId }) => userId).join(', ');
  return [
    `-- Read-only ${phase}-image assertion. The block returns no result sets; the final SELECT is the only result grid.`,
    `-- Every protected-table row count, fingerprint, and captured AUTO_INCREMENT value must match.`,
    `USE ${quoteIdentifier(DATABASE)};`,
    `SET @dummy_repair_assert_phase = '${phase}';`,
    'SET @dummy_repair_assert_pass = 0;',
    'DELIMITER $$',
    'BEGIN NOT ATOMIC',
    '  DECLARE originalGroupConcatLen BIGINT;',
    '  DECLARE originalTimeZone VARCHAR(64);',
    '  DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN',
    '    ROLLBACK;',
    '    IF originalGroupConcatLen IS NOT NULL THEN SET SESSION group_concat_max_len = originalGroupConcatLen; END IF;',
    '    IF originalTimeZone IS NOT NULL THEN SET SESSION time_zone = originalTimeZone; END IF;',
    '    RESIGNAL;',
    '  END;',
    '  SET originalGroupConcatLen = @@session.group_concat_max_len;',
    '  SET originalTimeZone = @@session.time_zone;',
    `  SET SESSION group_concat_max_len = ${Number(maxFingerprintBytes)};`,
    "  SET SESSION time_zone = '+00:00';",
    '  SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;',
    '  START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY;',
    `  IF DATABASE() <> '${DATABASE}' OR @@version NOT LIKE '11.8.%MariaDB%' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Assertion database identity or server version mismatch'; END IF;`,
    ...assertions.map((statement) => `  ${statement}`),
    '  SET @dummy_repair_assert_pass = 1;',
    '  COMMIT;',
    '  SET SESSION group_concat_max_len = originalGroupConcatLen;',
    '  SET SESSION time_zone = originalTimeZone;',
    'END$$',
    'DELIMITER ;',
    `SELECT @dummy_repair_assert_phase AS phase, IF(@dummy_repair_assert_pass=1,'PASS','FAIL') AS assertion,`,
    `  (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.annual_enrollments annual JOIN ${quoteIdentifier(DATABASE)}.students student ON student.id=annual.student_id WHERE ${targetAnnuals}) AS target_annuals,`,
    `  (SELECT SUM(annual.intake_status='pending') FROM ${quoteIdentifier(DATABASE)}.annual_enrollments annual JOIN ${quoteIdentifier(DATABASE)}.students student ON student.id=annual.student_id WHERE ${targetAnnuals}) AS pending_annuals,`,
    `  (SELECT SUM(annual.intake_status='enrolled') FROM ${quoteIdentifier(DATABASE)}.annual_enrollments annual JOIN ${quoteIdentifier(DATABASE)}.students student ON student.id=annual.student_id WHERE ${targetAnnuals}) AS enrolled_annuals,`,
    `  (SELECT SUM(annual.pre_enrollment_id IS NULL) FROM ${quoteIdentifier(DATABASE)}.annual_enrollments annual JOIN ${quoteIdentifier(DATABASE)}.students student ON student.id=annual.student_id WHERE ${targetAnnuals}) AS unlinked_annuals,`,
    `  (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.users WHERE id IN (${extraUserIds}) AND role='student' AND is_active=1) AS active_extra_users,`,
    `  (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.pre_enrollments source WHERE EXISTS (SELECT 1 FROM ${quoteIdentifier(DATABASE)}.pre_enrollment_events event WHERE event.pre_enrollment_id=source.id AND JSON_UNQUOTE(JSON_EXTRACT(event.details_json, '$.demoFixture.fixtureType'))='${FIXTURE_MARKER}')) AS synthetic_sources,`,
    `  (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.annual_assessments) AS assessments,`,
    `  (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.assessed_charges) AS charge_rows,`,
    `  (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.finance_payments) AS payments,`,
    `  (SELECT COUNT(*) FROM ${quoteIdentifier(DATABASE)}.staff_profiles) AS staff_profiles;`,
    ''
  ].join('\n');
}

async function createFixtureSource(pool, row, actor) {
  const source = buildSourceRecord(row);
  const record = source.record;
  const recordFingerprint = sha256(JSON.stringify(record));
  const [existingRows] = await pool.execute('SELECT id, request_fingerprint, status, version FROM pre_enrollments WHERE idempotency_key = ?', [source.idempotencyKey]);
  if (existingRows.length) {
    if (existingRows.length !== 1 || existingRows[0].id !== source.id || existingRows[0].request_fingerprint !== recordFingerprint) {
      throw new RepairError('A source idempotency key is already bound to different fixture details.');
    }
    return { ...source, alreadyCreated: true };
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const fields = CHECKSUM_FIELDS.map(([column]) => column);
    const values = CHECKSUM_FIELDS.map(([, key]) => record[key] ?? null);
    await connection.execute(`INSERT INTO pre_enrollments
      (id, idempotency_key, request_fingerprint, ${fields.map(quoteIdentifier).join(', ')}, student_signature_present,
       status, created_by, created_by_role, updated_by)
      VALUES (?, ?, ?, ${fields.map(() => '?').join(', ')}, 1, 'ready_for_registrar', ?, 'front_desk', ?)`,
    [source.id, source.idempotencyKey, recordFingerprint, ...values, actor.front_desk, actor.front_desk]);
    for (const receipt of record.receipts) {
      await connection.execute(`INSERT INTO pre_enrollment_receipts
        (pre_enrollment_id, requirement_code, original_received, original_pieces, photocopy_received, photocopy_pieces)
        VALUES (?, ?, ?, ?, ?, ?)`, [source.id, receipt.requirementCode, receipt.originalReceived ? 1 : 0,
        receipt.originalPieces, receipt.photocopyReceived ? 1 : 0, receipt.photocopyPieces]);
    }
    const revisionGroup = stableKey(`revision-group:${source.keyPart}`);
    const revisions = rowRevisionValues(source);
    for (const [fieldName, beforeValue, afterValue] of revisions) {
      await connection.execute(`INSERT INTO pre_enrollment_revisions
        (pre_enrollment_id, revision_group, actor_id, field_name, before_value, after_value)
        VALUES (?, ?, ?, ?, ?, ?)`, [source.id, revisionGroup, actor.front_desk, fieldName, beforeValue, afterValue]);
    }
    const changedFields = revisions.map(([fieldName]) => fieldName);
    const eventDetails = JSON.stringify({ changedFields, demoFixture: source.preferenceContext });
    await connection.execute(`INSERT INTO pre_enrollment_events
      (pre_enrollment_id, actor_id, event_type, version, from_status, to_status, details_json)
      VALUES (?, ?, 'submitted_ready', 1, NULL, 'ready_for_registrar', ?)`, [source.id, actor.front_desk, eventDetails]);
    await connection.execute(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
      VALUES (?, 'pre_enrollment.submitted_ready', 'pre_enrollment', ?, ?)`, [actor.front_desk, source.id,
      JSON.stringify({ version: 1, demoFixture: source.preferenceContext })]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  return { ...source, alreadyCreated: false };
}

async function adoptSource(pool, annualServicePool, preEnrollmentService, row, source, actor) {
  const conversion = await preEnrollmentService.getForConversion(actor.registrar, source.id);
  const student = conversion.existingStudent;
  if (!student || Number(student.id) !== Number(row.student_id) || student.profile.lrn !== row.lrn
    || student.profile.first_name !== row.first_name || student.profile.last_name !== row.last_name
    || conversion.school_year !== row.school_year || conversion.target_grade_level !== row.grade_level
    || conversion.applicant_kind !== 'new' || conversion.status !== 'ready_for_registrar') {
    throw new RepairError('The ordinary registrar Ready-for-enrollment validation did not match the exact target profile.');
  }
  const [linked] = await pool.execute('SELECT id, pre_enrollment_id, intake_status FROM annual_enrollments WHERE id = ?', [row.annual_id]);
  const [sourceRows] = await pool.execute('SELECT id, status, version FROM pre_enrollments WHERE id = ?', [source.id]);
  if (linked[0]?.pre_enrollment_id === source.id && sourceRows[0]?.status === 'enrollment_started') return;
  if (linked[0]?.pre_enrollment_id != null || linked[0]?.intake_status !== row.intake_status
    || sourceRows[0]?.status !== 'ready_for_registrar' || Number(sourceRows[0]?.version) !== 1) {
    throw new RepairError('The annual or source changed before the scoped adoption transition.');
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [currentAnnual] = await connection.execute('SELECT pre_enrollment_id, intake_status FROM annual_enrollments WHERE id = ? FOR UPDATE', [row.annual_id]);
    const [currentSource] = await connection.execute('SELECT status, version, created_by_role FROM pre_enrollments WHERE id = ? FOR UPDATE', [source.id]);
    if (currentAnnual[0]?.pre_enrollment_id != null || currentAnnual[0]?.intake_status !== row.intake_status
      || currentSource[0]?.status !== 'ready_for_registrar' || Number(currentSource[0]?.version) !== 1
      || currentSource[0]?.created_by_role !== 'front_desk') throw new RepairError('Stale source-to-annual link; no adoption was made.');
    const [annualUpdate] = await connection.execute(`UPDATE annual_enrollments SET pre_enrollment_id = ?
      WHERE id = ? AND pre_enrollment_id IS NULL AND intake_status = ?`, [source.id, row.annual_id, row.intake_status]);
    const [sourceUpdate] = await connection.execute(`UPDATE pre_enrollments SET status = 'enrollment_started', version = 2,
      updated_by = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'ready_for_registrar' AND version = 1`,
    [actor.registrar, source.id]);
    if (annualUpdate.affectedRows !== 1 || sourceUpdate.affectedRows !== 1) throw new RepairError('The source adoption lost a compare-and-swap race.');
    const details = JSON.stringify({ demoFixture: source.preferenceContext, annualEnrollmentId: Number(row.annual_id),
      previousStatus: 'ready_for_registrar', newStatus: 'enrollment_started', note: 'Audited adoption of an explicitly identified legacy demo annual.' });
    await connection.execute(`INSERT INTO pre_enrollment_events
      (pre_enrollment_id, actor_id, event_type, version, from_status, to_status, details_json)
      VALUES (?, ?, 'enrollment_started', 2, 'ready_for_registrar', 'enrollment_started', ?)`,
    [source.id, actor.registrar, details]);
    await connection.execute(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
      VALUES (?, 'annual_enrollment.demo_source_adopted', 'annual_enrollment', ?, ?)`,
    [actor.registrar, String(row.annual_id), details]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

async function normalizeLegacyIntakeKinds(pool, cohort, actor) {
  const targets = cohort.filter((row) => EXTRA_DUMMY_ALLOWLIST.some((item) => item.studentNo === row.student_no && item.priorIntakeKind === 'transferee'));
  if (targets.length !== 2 || targets.some((row) => Number(row.annual_history_count) !== 1
    || Number(row.departure_case_count) !== 0 || Number(row.readmission_evaluation_count) !== 0)) {
    throw new RepairError('The two legacy intake labels are not supported for exact normalization because their saved internal history changed.');
  }
  for (const row of targets) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [locked] = await connection.execute(`SELECT intake_kind, intake_status, pre_enrollment_id
        FROM annual_enrollments WHERE id = ? AND student_id = ? FOR UPDATE`, [row.annual_id, row.student_id]);
      if (locked.length !== 1 || locked[0].intake_kind !== 'transferee' || locked[0].intake_status !== 'pending'
        || locked[0].pre_enrollment_id != null) throw new RepairError('A legacy intake row changed before its exact demo-only normalization.');
      const [updated] = await connection.execute(`UPDATE annual_enrollments SET intake_kind = 'new', updated_at = UTC_TIMESTAMP(3)
        WHERE id = ? AND student_id = ? AND intake_kind = 'transferee' AND intake_status = 'pending' AND pre_enrollment_id IS NULL`,
      [row.annual_id, row.student_id]);
      if (updated.affectedRows !== 1) throw new RepairError('The legacy intake normalization lost its compare-and-swap guard.');
      const details = JSON.stringify({ demoFixture: { fixtureType: FIXTURE_MARKER, paperInspected: false,
        previousIntakeKind: 'transferee', normalizedIntakeKind: 'new',
        reason: 'The protected backup contains only this pending annual and no internal annual departure or readmission history; the legacy label is unsupported by current registrar intake classification.' } });
      await connection.execute(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (?, 'annual_enrollment.demo_fixture_intake_normalized', 'annual_enrollment', ?, ?)`,
      [actor.database_admin, String(row.annual_id), details]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }
  return targets.map((row) => ({ studentNo: row.student_no, studentId: Number(row.student_id), annualId: Number(row.annual_id),
    previousIntakeKind: 'transferee', normalizedIntakeKind: 'new', auditActorId: actor.database_admin }));
}

async function activateDummyAccounts(pool, adminService, cohort, actor) {
  const targets = cohort.filter((row) => EXTRA_DUMMY_ALLOWLIST.some((item) => item.studentNo === row.student_no));
  if (targets.length !== EXTRA_DUMMY_ALLOWLIST.length) throw new RepairError('The explicit dummy account allowlist no longer resolves to exactly three linked users.');
  const results = [];
  for (const row of targets) {
    const [beforeRows] = await pool.execute(`SELECT account.id, account.email, account.role, account.is_active, account.password_hash,
        account.must_change_password, account.auth_session_version, account.updated_at AS user_updated_at,
        student.student_no, student.user_id, student.updated_at AS student_updated_at
      FROM users account INNER JOIN students student ON student.user_id = account.id
      WHERE account.id = ? AND student.id = ?`, [row.user_id, row.student_id]);
    const before = beforeRows[0];
    if (!before || Number(before.is_active) !== 0 || before.role !== 'student' || before.student_no !== row.student_no
      || Number(before.must_change_password) !== 1 || before.email !== String(before.email).toLowerCase()) {
      throw new RepairError('A dummy account no longer matches its inactive linked-account activation guard.');
    }
    await adminService.updateUser(actor.database_admin, row.user_id, {
      email: before.email, role: 'student', isActive: true, studentNo: row.student_no
    });
    const [afterRows] = await pool.execute(`SELECT account.email, account.role, account.is_active, account.password_hash,
        account.must_change_password, account.auth_session_version, account.updated_at AS user_updated_at,
        student.student_no, student.user_id, student.updated_at AS student_updated_at
      FROM users account INNER JOIN students student ON student.user_id = account.id
      WHERE account.id = ? AND student.id = ?`, [row.user_id, row.student_id]);
    const after = afterRows[0];
    if (!after || Number(after.is_active) !== 1 || after.email !== before.email || after.role !== before.role
      || after.password_hash !== before.password_hash || Number(after.must_change_password) !== Number(before.must_change_password)
      || after.auth_session_version !== before.auth_session_version || after.student_no !== before.student_no
      || Number(after.user_id) !== Number(before.user_id)) {
      throw new RepairError('The supported administrator activation changed more than account active state and linked-profile timestamps.');
    }
    results.push({ studentNo: row.student_no, studentId: Number(row.student_id), userId: Number(row.user_id),
      isActiveBefore: false, isActiveAfter: true, passwordHashPreserved: true, mustChangePasswordPreserved: true,
      emailAndRolePreserved: true, authSessionVersionPreserved: true,
      userUpdatedAtChanged: String(after.user_updated_at) !== String(before.user_updated_at),
      studentUpdatedAtChanged: String(after.student_updated_at) !== String(before.student_updated_at), actorId: actor.database_admin });
  }
  return results;
}

async function confirmWithNormalRegistrarService(preEnrollmentService, financeService, annualService, termClearance,
  row, source, actor) {
  if (row.intake_status === 'enrolled') {
    if (!row.confirmation_id) throw new RepairError('A pre-confirmed fixture annual has no existing confirmation row.');
    return { alreadyConfirmed: true };
  }
  const preview = await financeService.annualAssessmentPreviewForRegistrar(actor.registrar, row.annual_id, []);
  if (row.assessment_id != null) {
    if (!preview.existingAssessment || Number(preview.assessmentId) !== Number(row.assessment_id)
      || Number(preview.scheduleId) !== Number(row.schedule_id) || Number(preview.scheduleVersion) !== Number(row.schedule_version)
      || preview.voucherCode !== row.voucher_code || preview.voucherCode !== row.voucher_code_snapshot) {
      throw new RepairError('The current registrar assessment preview does not match the existing posted snapshot.');
    }
  } else if (preview.existingAssessment || preview.assessmentId != null || preview.voucherCode !== row.voucher_code) {
    throw new RepairError('The new assessment preview does not match the saved active schedule and voucher.');
  }
  if (!preview.lines.length) throw new RepairError('The authoritative registrar fee preview contains no charge lines.');
  const readiness = await termClearance.getAnnualPrerequisiteReview(actor.registrar, row.annual_id);
  if (!readiness.ready || readiness.kind !== 'exempt') throw new RepairError('A target annual has a paper-clearance prerequisite that is not the normal new-intake exemption.');
  const result = await annualService.confirmAnnualEnrollment(actor.registrar, row.annual_id, {
    idempotencyKey: stableKey(`confirm:${fixtureKeyPart(row)}`),
    scheduleId: String(preview.scheduleId), scheduleVersion: String(preview.scheduleVersion),
    voucherCode: preview.voucherCode, optionalLineIds: [], snapshotFingerprint: preview.snapshotFingerprint,
    assessmentId: preview.assessmentId == null ? null : String(preview.assessmentId), clearanceSnapshotFingerprint: readiness.fingerprint
  });
  return { alreadyConfirmed: Boolean(result.alreadyConfirmed), total: String(result.total), assessmentId: Number(result.assessmentId),
    scheduleId: Number(preview.scheduleId), scheduleVersion: Number(preview.scheduleVersion), chargeLineCount: preview.lines.length,
    installmentBreakdownComplete: Boolean(preview.tuitionBreakdownComplete) };
}

async function verifyAfter(pool, financeService, rows, actors, beforeCounts, beforeTables, beforeMoneyRows, confirmationResults) {
  const studentIds = EXTRA_DUMMY_ALLOWLIST.map(({ studentId }) => studentId).join(', ');
  const [afterRows] = await pool.execute(`SELECT annual.id AS annual_id, annual.intake_status, annual.pre_enrollment_id,
      confirmation.id AS confirmation_id, assessment.id AS assessment_id, student.student_no,
      (SELECT COUNT(*) FROM assessed_charges charge WHERE charge.annual_enrollment_id=annual.id) AS charges
    FROM annual_enrollments annual JOIN students student ON student.id=annual.student_id
    LEFT JOIN annual_registrar_confirmations confirmation ON confirmation.annual_enrollment_id=annual.id
    LEFT JOIN annual_assessments assessment ON assessment.annual_enrollment_id=annual.id
    WHERE annual.school_year=? AND (student.student_no BETWEEN ? AND ? OR student.id IN (${studentIds})) ORDER BY student.student_no`,
  [SCHOOL_YEAR, `${STUDENT_PREFIX}0022`, `${STUDENT_PREFIX}0100`]);
  const extraChargeCounts = Object.fromEntries(EXTRA_DUMMY_ALLOWLIST.map(({ annualId }) => [annualId,
    Number(confirmationResults.get(annualId)?.chargeLineCount || 0)]));
  if (afterRows.length !== 82 || afterRows.some((row) => row.intake_status !== 'enrolled' || !row.pre_enrollment_id
    || !row.confirmation_id || !row.assessment_id
    || Number(row.charges) !== (extraChargeCounts[Number(row.annual_id)] || 6))) {
    throw new RepairError('The final 82-account cohort does not have the expected linked, confirmed, assessed state.');
  }
  const afterCounts = await exactCounts(pool);
  const countChanges = Object.entries(afterCounts).filter(([table, count]) => Number(beforeCounts[table]) !== count)
    .map(([table, count]) => ({ table, before: Number(beforeCounts[table]), after: count }));
  const expectedChanged = new Set(['annual_enrollment_events', 'annual_registrar_confirmations', 'audit_logs',
    'pre_enrollment_events', 'pre_enrollment_receipts', 'pre_enrollment_revisions', 'pre_enrollments',
    'annual_assessments', 'assessed_charges', 'finance_exemption_applications', 'finance_charge_adjustments', 'users', 'students']);
  if (countChanges.some(({ table }) => !expectedChanged.has(table))) {
    throw new RepairError(`An unexpected table row count changed: ${countChanges.filter(({ table }) => !expectedChanged.has(table)).map(({ table }) => table).join(', ')}.`);
  }
  const countDelta = (table) => {
    const change = countChanges.find(({ table: changedTable }) => changedTable === table);
    return change ? Number(change.after) - Number(change.before) : 0;
  };
  if (countDelta('pre_enrollments') !== 82 || countDelta('annual_registrar_confirmations') !== 60
    || countDelta('annual_assessments') !== 3 || countDelta('assessed_charges') !== Object.values(extraChargeCounts).reduce((sum, count) => sum + count, 0)
    || countDelta('finance_exemption_applications') !== 4 || countDelta('finance_charge_adjustments') !== 4) {
    throw new RepairError('Source, confirmation, assessment, or authoritative charge deltas did not match the 82-account plan.');
  }
  const accountRows = await allRows(pool, 'users', 'ORDER BY id');
  const beforeAccounts = beforeTables.users;
  const accountMap = new Map(accountRows.map((row) => [Number(row.id), row]));
  const allowedUserIds = new Set(EXTRA_DUMMY_ALLOWLIST.map(({ userId }) => userId));
  for (const oldRow of beforeAccounts) {
    const current = accountMap.get(Number(oldRow.id));
    if (!current) throw new RepairError('An existing account disappeared during rehearsal.');
    if (!allowedUserIds.has(Number(oldRow.id))) {
      if (stableJson(oldRow) !== stableJson(current)) throw new RepairError('A non-target user/account changed during rehearsal.');
      continue;
    }
    const beforeComparable = { ...oldRow }; const afterComparable = { ...current };
    delete beforeComparable.is_active; delete afterComparable.is_active;
    delete beforeComparable.updated_at; delete afterComparable.updated_at;
    if (stableJson(beforeComparable) !== stableJson(afterComparable) || Number(oldRow.is_active) !== 0
      || Number(current.is_active) !== 1 || oldRow.password_hash !== current.password_hash
      || Number(oldRow.must_change_password) !== Number(current.must_change_password)) {
      throw new RepairError('Demo account activation changed identity, password, session, or MFA data beyond the approved active flag.');
    }
  }
  const beforeStudentMap = new Map(beforeTables.students.map((row) => [Number(row.id), row]));
  const afterStudents = await allRows(pool, 'students', 'ORDER BY id');
  const targetStudentSet = new Set(EXTRA_DUMMY_ALLOWLIST.map(({ studentId }) => studentId));
  const debtIncreaseRevisionChanges = [];
  for (const current of afterStudents) {
    const oldRow = beforeStudentMap.get(Number(current.id));
    if (!oldRow) throw new RepairError('A student identity was added during rehearsal.');
    const beforeComparable = { ...oldRow }; const afterComparable = { ...current };
    if (targetStudentSet.has(Number(current.id))) {
      delete beforeComparable.updated_at; delete afterComparable.updated_at;
      delete beforeComparable.debt_increase_revision; delete afterComparable.debt_increase_revision;
      const beforeRevision = Number(oldRow.debt_increase_revision);
      const afterRevision = Number(current.debt_increase_revision);
      if (!Number.isSafeInteger(beforeRevision) || afterRevision !== beforeRevision + 1) {
        throw new RepairError('The normal finance service did not produce exactly one expected debt-increase revision for a newly assessed dummy account.');
      }
      debtIncreaseRevisionChanges.push({ studentId: Number(current.id), before: beforeRevision, after: afterRevision });
    }
    if (stableJson(beforeComparable) !== stableJson(afterComparable)) throw new RepairError('Student identity/profile data changed beyond the supported activation timestamp.');
  }
  const moneyTables = ['annual_assessments', 'assessed_charges', 'finance_charge_adjustments', 'finance_payments',
    'finance_payment_allocations', 'finance_allocation_batches', 'finance_payment_reversals', 'finance_payment_allocation_releases',
    'finance_legacy_reconciliations', 'finance_legacy_reconciliation_batches', 'finance_legacy_reconciliation_releases',
    'finance_legacy_opening_charges', 'finance_transaction_reversals', 'finance_exemption_cases', 'finance_exemption_rules',
    'finance_exemption_applications'];
  const moneyRows = {};
  for (const table of moneyTables) moneyRows[table] = await allRows(pool, table, 'ORDER BY 1');
  for (const table of moneyTables.filter((name) => !['annual_assessments', 'assessed_charges',
    'finance_exemption_applications', 'finance_charge_adjustments'].includes(name))) {
    if (tableDigest(moneyRows[table]) !== tableDigest(beforeMoneyRows[table])) {
      throw new RepairError(`Existing payment or finance history changed during rehearsal (${table}).`);
    }
  }
  const existingAnnualIds = new Set(rows.filter((row) => row.assessment_id != null).map((row) => Number(row.annual_id)));
  const oldAssessments = beforeMoneyRows.annual_assessments;
  const newAssessments = moneyRows.annual_assessments;
  const oldCharges = beforeMoneyRows.assessed_charges;
  const newCharges = moneyRows.assessed_charges;
  const extraAnnualIds = new Set(EXTRA_DUMMY_ALLOWLIST.map(({ annualId }) => annualId));
  const priorAssessmentsForLegacy = oldAssessments.filter((record) => existingAnnualIds.has(Number(record.annual_enrollment_id)));
  const afterAssessmentsForLegacy = newAssessments.filter((record) => existingAnnualIds.has(Number(record.annual_enrollment_id)));
  const priorChargesForLegacy = oldCharges.filter((record) => existingAnnualIds.has(Number(record.annual_enrollment_id)));
  const afterChargesForLegacy = newCharges.filter((record) => existingAnnualIds.has(Number(record.annual_enrollment_id)));
  if (tableDigest(priorAssessmentsForLegacy) !== tableDigest(afterAssessmentsForLegacy)
    || tableDigest(priorChargesForLegacy) !== tableDigest(afterChargesForLegacy)) {
    throw new RepairError('A posted assessment or charge snapshot from the original 79 demo rows changed.');
  }
  const newAssessmentRows = newAssessments.filter((record) => extraAnnualIds.has(Number(record.annual_enrollment_id)));
  const newChargeRows = newCharges.filter((record) => extraAnnualIds.has(Number(record.annual_enrollment_id)));
  if (newAssessmentRows.length !== 3 || newChargeRows.length !== Object.values(extraChargeCounts).reduce((sum, count) => sum + count, 0)
    || newAssessmentRows.some((record) => !extraAnnualIds.has(Number(record.annual_enrollment_id)))) {
    throw new RepairError('The three new fixture assessments or authoritative scheduled charge rows do not match their confirmation previews.');
  }
  for (const table of ['finance_exemption_applications', 'finance_charge_adjustments']) {
    const priorIds = new Set(beforeMoneyRows[table].map((row) => String(row.id)));
    const currentRows = moneyRows[table];
    const priorRows = currentRows.filter((row) => priorIds.has(String(row.id)));
    if (tableDigest(priorRows) !== tableDigest(beforeMoneyRows[table])) {
      throw new RepairError(`Existing exemption or adjustment history changed during rehearsal (${table}).`);
    }
  }
  const [exemptionRows] = await pool.execute(`SELECT application.id, application.exemption_rule_id, application.charge_id,
      CAST(application.amount AS CHAR(40)) AS amount, charge.annual_enrollment_id
    FROM finance_exemption_applications application INNER JOIN assessed_charges charge ON charge.id=application.charge_id
    WHERE charge.annual_enrollment_id IN (${EXTRA_DUMMY_ALLOWLIST.map(({ annualId }) => annualId).join(', ')}) ORDER BY application.id`);
  const [adjustmentRows] = await pool.execute(`SELECT adjustment.id, adjustment.exemption_application_id, adjustment.charge_id,
      CAST(adjustment.amount AS CHAR(40)) AS amount, charge.annual_enrollment_id
    FROM finance_charge_adjustments adjustment INNER JOIN assessed_charges charge ON charge.id=adjustment.charge_id
    WHERE charge.annual_enrollment_id IN (${EXTRA_DUMMY_ALLOWLIST.map(({ annualId }) => annualId).join(', ')}) ORDER BY adjustment.id`);
  const newExemptionRows = exemptionRows.filter((record) => Number(record.annual_enrollment_id) === 83);
  const newAdjustmentRows = adjustmentRows.filter((record) => Number(record.annual_enrollment_id) === 83);
  if (exemptionRows.length !== 4 || adjustmentRows.length !== 4 || newExemptionRows.some((record) => Number(record.exemption_rule_id) !== 1)
    || newAdjustmentRows.some((record) => record.exemption_application_id == null)
    || sumMoney(newExemptionRows, 'amount') !== '1200.00' || sumMoney(newAdjustmentRows, 'amount') !== '-1200.00') {
    throw new RepairError('The saved approved annual tuition exemption did not apply exactly through the normal finance service.');
  }
  const exemptionAnnualCharges = newChargeRows.filter((record) => Number(record.annual_enrollment_id) === 83);
  const exemptionGrossAmount = sumMoney(exemptionAnnualCharges, 'gross_amount');
  const exemptionWaivedAmount = sumMoney(exemptionAnnualCharges, 'waived_amount');
  const exemptionNetAmount = subtractMoney(exemptionGrossAmount, exemptionWaivedAmount);
  if (exemptionWaivedAmount !== sumMoney(newExemptionRows, 'amount')
    || exemptionNetAmount !== extraFinanceSummaries.find((record) => record.annualId === 83)?.annualBalance) {
    throw new RepairError('The saved annual exemption gross, applied, and net fee amounts do not reconcile.');
  }
  let wholeTermRows = 0;
  let unavailableInstallmentRows = 0;
  let annualBalanceMismatchRows = 0;
  let invalidWholeTermRows = 0;
  const wholeTermStatusCounts = {};
  const ledgerSamples = [];
  const extraFinanceSummaries = [];
  let extraApplicablePlacements = 0;
  let extraAvailableInstallmentPlacements = 0;
  for (const target of rows) {
    const roster = await financeService.listRosterPage(actors.finance, {
      search: target.student_no, schoolYear: SCHOOL_YEAR, installment: 'whole'
    });
    if (roster.rows.length !== 1 || roster.rows[0].student_no !== target.student_no) {
      throw new RepairError('An exact target did not resolve to one annual row in the registrar-backed Finance roster.');
    }
    const row = roster.rows[0];
    wholeTermRows += 1;
    if (row.annual_balance == null || row.unattributed_legacy_balance == null || row.opening_liability_due == null) annualBalanceMismatchRows += 1;
    for (const placement of row.placements) {
    if ([0, false, null, undefined, '0'].includes(placement.installment_tracking_available)) unavailableInstallmentRows += 1;
      const validApplicableStatus = placement.term_scope_status === 'applicable'
        && [1, true, '1'].includes(placement.whole_tracking_available)
        && ['unpaid', 'partially_paid', 'fully_paid', 'no_payment_required'].includes(placement.finance_status);
      const validNotApplicableStatus = placement.term_scope_status === 'not_applicable'
        && placement.enrollment_status === 'not_applicable'
        && placement.finance_status === 'needs_review'
        && [0, false, '0'].includes(placement.whole_tracking_available);
      if (!validApplicableStatus && !validNotApplicableStatus) invalidWholeTermRows += 1;
      wholeTermStatusCounts[placement.finance_status || 'missing'] = (wholeTermStatusCounts[placement.finance_status || 'missing'] || 0) + 1;
      if (EXTRA_DUMMY_ALLOWLIST.some((item) => item.studentNo === target.student_no)
        && placement.term_scope_status === 'applicable') {
        extraApplicablePlacements += 1;
        if ([1, true, '1'].includes(placement.installment_tracking_available)) extraAvailableInstallmentPlacements += 1;
      }
    }
    const targetConfirmation = confirmationResults.get(Number(target.annual_id));
    const expectedPayment = extraDummyTarget(target.student_no);
    if (targetConfirmation && expectedPayment) {
      const ledger = await financeService.getStudentLedger(actors.finance, target.student_id);
      const expectedAvailableCredit = expectedPayment?.paymentTotal || '0.00';
      if (String(ledger.summary.availableCredit) !== expectedAvailableCredit
        || ledger.availablePayments.length !== Number(expectedPayment?.paymentCount || 0)) {
        throw new RepairError('A pre-existing unallocated student payment was not preserved as available credit in the authoritative ledger.');
      }
      extraFinanceSummaries.push({ studentNo: target.student_no, annualId: Number(target.annual_id),
        annualBalance: String(row.annual_balance), availableCredit: String(ledger.summary.availableCredit),
        existingPaymentRows: ledger.availablePayments.length,
        chargesAdded: targetConfirmation.chargeLineCount, authoritativeAssessmentTotal: targetConfirmation.total,
        scheduleId: targetConfirmation.scheduleId, scheduleVersion: targetConfirmation.scheduleVersion,
        installmentBreakdownComplete: targetConfirmation.installmentBreakdownComplete });
    }
    if (ledgerSamples.length < 5) ledgerSamples.push({ hasAnnualBalance: row.annual_balance != null,
      placementCount: row.placements.length, hasUnattributedBalance: row.unattributed_legacy_balance != null,
      hasOpeningLiability: row.opening_liability_due != null });
  }
  if (wholeTermRows !== 82 || annualBalanceMismatchRows !== 0 || unavailableInstallmentRows !== 79 * 3 + 2 || invalidWholeTermRows !== 0
    || extraApplicablePlacements !== 7 || extraAvailableInstallmentPlacements !== 7
    || extraFinanceSummaries.length !== EXTRA_DUMMY_ALLOWLIST.length
    || [...Object.values(wholeTermStatusCounts)].reduce((sum, count) => sum + count, 0) !== 82 * 3) {
    throw new RepairError(`Finance roster validation failed (rows=${wholeTermRows}, balanceMissing=${annualBalanceMismatchRows}, unavailableInstallments=${unavailableInstallmentRows}, invalidWholeTerm=${invalidWholeTermRows}).`);
  }
  return { afterCounts, countChanges, accountChanges: { activatedUsers: EXTRA_DUMMY_ALLOWLIST.map(({ userId, studentId, studentNo }) => ({ userId, studentId, studentNo, isActiveBefore: false, isActiveAfter: true })),
      passwordsPreserved: true, mustChangePasswordPreserved: true, staffAccountsPreserved: true,
      financeServiceDebtRevisions: debtIncreaseRevisionChanges },
    finance: { wholeTermRows, missingAnnualBalanceRows: annualBalanceMismatchRows,
    placementsWithUnavailableInstallments: unavailableInstallmentRows, invalidWholeTermRows, wholeTermStatusCounts,
    extraApplicableInstallmentPlacements: extraApplicablePlacements, extraInstallmentBreakdownAvailable: extraAvailableInstallmentPlacements,
    addedAssessments: newAssessmentRows.length, addedChargeRows: newChargeRows.length,
    preservedOriginalLegacyPostedSnapshots: { assessments: priorAssessmentsForLegacy.length,
      chargeRows: priorChargesForLegacy.length, unchanged: true },
    preservedPaymentHistory: { paymentRows: beforeMoneyRows.finance_payments.length,
      allocationRows: beforeMoneyRows.finance_payment_allocations.length, unchanged: true },
    approvedExemption: { existingCaseId: 1, annualId: 83, applicationsAdded: newExemptionRows.length,
      adjustmentsAdded: newAdjustmentRows.length, grossScheduledCharges: exemptionGrossAmount,
      waivedAmount: exemptionWaivedAmount, appliedAmount: sumMoney(newExemptionRows, 'amount'),
      adjustmentAmount: sumMoney(newAdjustmentRows, 'amount'), netAnnualBalance: exemptionNetAmount },
    newDummyAssessments: extraFinanceSummaries, sampleShape: ledgerSamples } };
}

async function validateScratchServer(socketPath, dataDirectory = null) {
  const socket = path.resolve(socketPath);
  const rootPath = path.dirname(socket);
  const rootStats = await fs.lstat(rootPath).catch(() => null);
  const socketStats = await fs.lstat(socket).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink() || !socketStats?.isSocket()
    || (rootStats.mode & 0o077) !== 0 || typeof process.getuid === 'function' && rootStats.uid !== process.getuid()) {
    throw new RepairError('The rehearsal MariaDB socket must be inside an owner-only scratch directory.');
  }
  const expectedTmp = await fs.realpath(os.tmpdir());
  const realRoot = await fs.realpath(rootPath);
  const realSocket = await fs.realpath(socket);
  if (path.dirname(realRoot) !== expectedTmp || !path.basename(realRoot).startsWith(path.basename(MARIADB_REHEARSAL_ROOT))
    || path.dirname(realSocket) !== realRoot) throw new RepairError('The rehearsal socket resolves outside its private scratch directory.');
  let realData = null;
  if (dataDirectory) {
    realData = await fs.realpath(dataDirectory).catch(() => null);
    if (!realData || !realData.startsWith(`${realRoot}${path.sep}`)) {
      throw new RepairError('The MariaDB server data directory must resolve inside the same private rehearsal tree as its socket.');
    }
  }
  return { socket: realSocket, root: realRoot, dataDirectory: realData };
}

async function run({ options, logger = console }) {
  const socket = path.resolve(options.socket);
  const initialScratch = await validateScratchServer(socket);
  const backupDigest = await verifyBackup(options.backupFile, options.backupSha256);
  if (options.mode === 'rehearse' && process.env.DEMO_HOSTINGER_REPAIR_REHEARSAL !== 'true') {
    throw new RepairError('Set DEMO_HOSTINGER_REPAIR_REHEARSAL=true to enable writes on the disposable scratch MariaDB.');
  }
  if (options.deltaFile) {
    const parent = await fs.realpath(path.dirname(options.deltaFile)).catch(() => null);
    if (!parent || (await fs.stat(parent)).mode & 0o077) throw new RepairError('The delta file parent must be a private directory.');
  }
  const rawPool = mysql.createPool({ socketPath: initialScratch.socket, user: 'root', password: '', database: DATABASE,
    waitForConnections: true, connectionLimit: 1, queueLimit: 0, supportBigNumbers: true,
    bigNumberStrings: true, decimalNumbers: false, dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false });
  const pool = new PoolFacade(rawPool);
  const getPool = async () => pool;
  try {
    const rehearsalConnection = await rawPool.getConnection();
    try { await rehearsalConnection.query("SET SESSION time_zone = '+00:00'"); }
    finally { rehearsalConnection.release(); }
    const [identityRows] = await rawPool.execute('SELECT DATABASE() AS db, @@version AS version, @@hostname AS hostname, @@port AS port, @@server_id AS server_id, @@datadir AS datadir');
    const identity = identityRows[0];
    const scratch = await validateScratchServer(socket, identity.datadir);
    if (identity.db !== DATABASE || !String(identity.version).includes('MariaDB')) throw new RepairError('Unexpected database identity or server type.');
    const [migrationRows] = await rawPool.execute('SELECT version FROM schema_migrations ORDER BY version');
    if (migrationRows.length !== 18 || migrationRows.at(-1)?.version !== 'v2.018') throw new RepairError('The rehearsal database must be the backed-up v2.018 schema.');
    const actors = await actorIds(rawPool);
    const plan = buildExpansionPlan({ today: new Date(`${TODAY}T00:00:00Z`) });
    const cohort = await selectCohort(rawPool);
    const summary = assertPlanCohort(cohort, plan);
    const [approvedExemptionRows] = await rawPool.execute(`SELECT exemption.id, exemption.annual_enrollment_id, exemption.status,
        COUNT(rule.id) AS rule_count, SUM(rule.fee_category='tuition' AND rule.term_number=1 AND rule.is_full_coverage=1) AS matching_rules
      FROM finance_exemption_cases exemption LEFT JOIN finance_exemption_rules rule ON rule.exemption_case_id=exemption.id
      WHERE exemption.id=1 AND exemption.annual_enrollment_id=83 GROUP BY exemption.id, exemption.annual_enrollment_id, exemption.status`);
    if (approvedExemptionRows.length !== 1 || approvedExemptionRows[0].status !== 'approved'
      || Number(approvedExemptionRows[0].rule_count) !== 3 || Number(approvedExemptionRows[0].matching_rules) !== 3) {
      throw new RepairError('The explicit SHS-2026-0004 schedule exemption differs from its saved approved tuition rules.');
    }
    summary.existingApprovedExemption = { caseId: 1, annualId: 83, status: 'approved', matchingTuitionRules: 3,
      applicationsWillBeGeneratedByNormalAssessmentService: true };
    summary.backupSha256 = backupDigest;
    const countsBefore = await exactCounts(rawPool);
    const staffBefore = tableDigest(await allRows(rawPool, 'users', 'ORDER BY id'));
    const schoolSetupBefore = {};
    for (const table of SCHOOL_SETUP_TABLES) schoolSetupBefore[table] = tableDigest(await allRows(rawPool, table, 'ORDER BY 1'));
    const moneyTables = ['annual_assessments', 'assessed_charges', 'finance_charge_adjustments', 'finance_payments',
      'finance_payment_allocations', 'finance_allocation_batches', 'finance_payment_reversals', 'finance_payment_allocation_releases',
      'finance_legacy_reconciliations', 'finance_legacy_reconciliation_batches', 'finance_legacy_reconciliation_releases',
      'finance_legacy_opening_charges', 'finance_transaction_reversals', 'finance_exemption_cases', 'finance_exemption_rules',
      'finance_exemption_applications'];
    const moneyBeforeRows = {};
    for (const table of moneyTables) moneyBeforeRows[table] = await allRows(rawPool, table, 'ORDER BY 1');
    const moneyBefore = sha256(JSON.stringify(Object.fromEntries(Object.entries(moneyBeforeRows)
      .map(([table, rows]) => [table, tableDigest(rows)]))));
    logger.log(JSON.stringify({ mode: options.mode, database: identity.db, serverVersion: identity.version, backupSha256: backupDigest,
      schema: migrationRows.at(-1).version, target: summary, preRepairCounts: countsBefore,
      userAccountsFingerprint: staffBefore, schoolSetupFingerprints: schoolSetupBefore, postedFinanceFingerprint: moneyBefore,
      actors: { frontDeskPresent: Boolean(actors.front_desk), registrarPresent: Boolean(actors.registrar), financePresent: Boolean(actors.finance) } }, null, 2));
    if (options.mode === 'preview') return;

    const modifiedTables = ['pre_enrollments', 'pre_enrollment_receipts', 'pre_enrollment_revisions', 'pre_enrollment_events',
      'audit_logs', 'annual_enrollments', 'annual_registrar_confirmations', 'annual_enrollment_events', 'enrollments',
      'annual_assessments', 'assessed_charges', 'finance_exemption_applications', 'finance_charge_adjustments', 'users', 'students'];
    const preservedTables = ['student_term_clearances', 'student_term_clearance_items', 'student_term_clearance_events'];
    const beforeTables = await snapshotTables(rawPool, [...modifiedTables, ...moneyTables, 'staff_profiles', ...SCHOOL_SETUP_TABLES,
      ...preservedTables, 'readmission_evaluations']);
    const beforeAutoIncrement = await autoIncrementValues(rawPool, modifiedTables);
    const preEnrollments = require('../src/services/preEnrollmentService').createPreEnrollmentService({ getPool, sql,
      transactionFactory: (currentPool) => new Transaction(currentPool) });
    const finance = createAnnualFinanceService({ getPool, sql });
    const termClearance = createTermClearanceService({ getPool, sql, transactionFactory: (currentPool) => new Transaction(currentPool) });
    const admin = createAdminService({ getPool, sql, transactionFactory: (currentPool) => new Transaction(currentPool),
      hashPassword: async () => { throw new RepairError('Unexpected account password hashing in the scoped activation rehearsal.'); } });
    const annual = createAnnualEnrollmentService({ getPool, sql, annualFinanceService: finance, termClearanceService: termClearance,
      transactionFactory: (currentPool) => new Transaction(currentPool),
      createPassword: () => null,
      hashPassword: async () => { throw new RepairError('Unexpected student-account activation in scoped rehearsal.'); } });
    const intakeNormalizations = await normalizeLegacyIntakeKinds(rawPool, cohort, actors);
    const accountActivations = await activateDummyAccounts(rawPool, admin, cohort, actors);
    let adoptedCount = 0;
    let confirmedCount = 0;
    const confirmationResults = new Map();
    for (const row of cohort) {
      const source = await createFixtureSource(rawPool, row, actors);
      await adoptSource(rawPool, pool, preEnrollments, row, source, actors);
      adoptedCount += 1;
      if (row.intake_status === 'pending') {
        const result = await confirmWithNormalRegistrarService(preEnrollments, finance, annual, termClearance,
          row, source, actors);
        if (result.alreadyConfirmed) throw new RepairError('A pending target unexpectedly replayed as already confirmed.');
        confirmationResults.set(Number(row.annual_id), result);
        confirmedCount += 1;
      }
    }
    const post = await verifyAfter(rawPool, finance, cohort, actors, countsBefore, beforeTables, moneyBeforeRows, confirmationResults);
    if (confirmedCount !== 60 || adoptedCount !== 82) throw new RepairError('The service rehearsal did not process exactly 82 sources and 60 confirmations.');
    const afterTables = await snapshotTables(rawPool, [...modifiedTables, ...moneyTables, 'staff_profiles', ...SCHOOL_SETUP_TABLES,
      ...preservedTables, 'readmission_evaluations']);
    for (const table of SCHOOL_SETUP_TABLES) {
      if (tableDigest(beforeTables[table]) !== tableDigest(afterTables[table])) throw new RepairError(`School setup table changed during rehearsal: ${table}.`);
    }
    const afterAutoIncrement = await autoIncrementValues(rawPool, modifiedTables);
    const delta = await makeDeltaSql(rawPool, beforeTables, afterTables, beforeAutoIncrement, afterAutoIncrement, cohort, summary, actors);
    const directory = await fs.realpath(path.dirname(options.deltaFile));
    const safePath = path.join(directory, path.basename(options.deltaFile));
    const beforePath = `${safePath}.before.sql`;
    const verificationPath = `${safePath}.verify.sql`;
    const beforeAssertionPath = `${safePath}.assert-before.sql`;
    const afterAssertionPath = `${safePath}.assert-after.sql`;
    const protectedCounts = (tables) => Object.fromEntries(delta.protectedTables.map((table) => [table, tables[table].length]));
    const beforeAssertionSql = buildIntegrityAssertionSql({ phase: 'before', fingerprints: delta.beforeFingerprints,
      counts: protectedCounts(beforeTables), autoIncrement: beforeAutoIncrement, columnsByTable: delta.columnsByTable,
      maxFingerprintBytes: delta.maxFingerprintBytes });
    const afterAssertionSql = buildIntegrityAssertionSql({ phase: 'after', fingerprints: delta.afterFingerprints,
      counts: protectedCounts(afterTables), autoIncrement: afterAutoIncrement, columnsByTable: delta.columnsByTable,
      maxFingerprintBytes: delta.maxFingerprintBytes });
    const output = `${JSON.stringify({ backupSha256: backupDigest, rehearsal: identity,
      targetDigest: summary.targetDigest, sourceCount: adoptedCount, confirmationsAdded: confirmedCount,
      intakeNormalizations, accountActivations, hostedAccountActivationRequiresActionTimeConfirmation: true,
      countChanges: post.countChanges, accountChanges: post.accountChanges, finance: post.finance,
      changedTables: delta.changedTables, protectedTables: delta.protectedTables, deltaStatements: delta.deltaStatements,
      preRepairCounts: countsBefore, postRepairCounts: post.afterCounts, userAccountsFingerprint: staffBefore,
      schoolSetupFingerprints: schoolSetupBefore, autoIncrementBefore: beforeAutoIncrement, autoIncrementAfter: afterAutoIncrement,
      protectedFingerprintsBefore: summary.protectedFingerprintsBefore,
      protectedFingerprintsAfter: summary.protectedFingerprintsAfter,
      beforeImageSql: beforePath, verificationSql: verificationPath,
      assertBeforeSql: beforeAssertionPath, assertAfterSql: afterAssertionPath, failedImportRecovery: summary.failedImportRecovery,
      postedFinanceFingerprint: moneyBefore }, null, 2)}\n`;
    const fileHandle = await fs.open(safePath, 'wx', 0o600);
    try {
      await fileHandle.writeFile(delta.sql, 'utf8');
      await fileHandle.sync();
    } finally { await fileHandle.close(); }
    const beforeHandle = await fs.open(beforePath, 'wx', 0o600);
    try { await beforeHandle.writeFile(delta.beforeSql, 'utf8'); await beforeHandle.sync(); }
    finally { await beforeHandle.close(); }
    const verificationHandle = await fs.open(verificationPath, 'wx', 0o600);
    try { await verificationHandle.writeFile(delta.verificationSql, 'utf8'); await verificationHandle.sync(); }
    finally { await verificationHandle.close(); }
    const beforeAssertionHandle = await fs.open(beforeAssertionPath, 'wx', 0o600);
    try { await beforeAssertionHandle.writeFile(beforeAssertionSql, 'utf8'); await beforeAssertionHandle.sync(); }
    finally { await beforeAssertionHandle.close(); }
    const afterAssertionHandle = await fs.open(afterAssertionPath, 'wx', 0o600);
    try { await afterAssertionHandle.writeFile(afterAssertionSql, 'utf8'); await afterAssertionHandle.sync(); }
    finally { await afterAssertionHandle.close(); }
    const reportPath = `${safePath}.report.json`;
    await fs.writeFile(reportPath, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    logger.log(JSON.stringify({ rehearsalComplete: true, sourceCount: adoptedCount, confirmationsAdded: confirmedCount,
      intakeNormalizations, accountActivations, deltaFile: safePath, reportFile: reportPath,
      beforeImageFile: beforePath, verificationFile: verificationPath,
      assertBeforeFile: beforeAssertionPath, assertAfterFile: afterAssertionPath,
      changedTables: delta.changedTables, protectedTableCount: delta.protectedTables.length,
      deltaStatements: delta.deltaStatements, finance: post.finance }, null, 2));
  } finally { await rawPool.end(); }
}

async function main() {
  try { await run({ options: parseArgs(process.argv.slice(2)) }); }
  catch (error) {
    console.error(error instanceof RepairError ? error.message : 'Dummy Hostinger repair rehearsal failed. No hosted write was attempted.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { RepairError, EXTRA_DUMMY_ALLOWLIST, parseArgs, assertPlanCohort, buildSourceRecord,
  extraDummyTarget, subtractMoney, deltaPredicateColumns, buildIntegrityAssertionSql,
  selectCohort, actorIds, exactCounts, snapshotTables, autoIncrementValues, makeDeltaSql, createFixtureSource, run };
