'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const os = require('node:os');
const path = require('node:path');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { PoolFacade, sql } = require('../src/config/database');
const { createFinanceMasterlistService } = require('../src/services/financeMasterlistService');
const { createCsvColumns, csvHeader, csvRow } = require('../src/utils/financeMasterlistCsv');

const socketPath = process.env.FINANCE_MASTERLIST_TEST_SOCKET;
const databaseUser = process.env.FINANCE_MASTERLIST_TEST_USER || os.userInfo().username;
const repoRoot = path.resolve(__dirname, '..');

function disposableDatabaseName() {
  return `arktiesiis_masterlist_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
}

async function executeStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

test('Finance masterlist reads the saved annual cohort from isolated MariaDB', {
  skip: !socketPath && 'Set FINANCE_MASTERLIST_TEST_SOCKET to a disposable MariaDB socket under /tmp.'
}, async () => {
  assert.equal(path.isAbsolute(socketPath), true);
  assert.equal(path.resolve(socketPath).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), true,
    'the integration socket must live under /tmp');

  const databaseName = disposableDatabaseName();
  const adminPool = mysql.createPool({ socketPath, user: databaseUser, password: '', waitForConnections: true, connectionLimit: 2 });
  let appPool;
  try {
    await adminPool.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    appPool = mysql.createPool({
      socketPath, user: databaseUser, password: '', database: databaseName,
      waitForConnections: true, connectionLimit: 4, supportBigNumbers: true, bigNumberStrings: true,
      decimalNumbers: false, dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'], multipleStatements: false
    });
    const setup = await appPool.getConnection();
    try {
      await executeStatements(setup, readSqlFile(path.join(repoRoot, 'database/mariadb/schema.sql')));
      for (const migration of readForwardMigrations()) {
        await executeStatements(setup, migration.statements);
        await setup.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
      }
    } finally {
      setup.release();
    }

    const [actorInsert] = await appPool.execute(
      "INSERT INTO users (email, password_hash, role, is_active) VALUES (?, 'integration-only', 'finance', 1)",
      [`finance-masterlist-${crypto.randomUUID()}@example.test`]);
    const actorId = Number(actorInsert.insertId);
    const termIds = [];
    for (const [number, label] of [[1, 'Term 1'], [2, 'Term 2'], [3, 'Term 3']]) {
      const [termInsert] = await appPool.execute(
        'INSERT INTO academic_terms (school_year, term, is_current) VALUES (?, ?, ?)',
        ['2026-2027', label, number === 2 ? 1 : 0]);
      termIds.push(Number(termInsert.insertId));
      await appPool.execute(
        'INSERT INTO school_year_term_order (school_year, term_number, academic_term_id, configured_by) VALUES (?, ?, ?, ?)',
        ['2026-2027', number, Number(termInsert.insertId), actorId]);
    }
    const [section1] = await appPool.execute(
      'INSERT INTO sections (name, grade_level, academic_term_id, strand, adviser) VALUES (?, ?, ?, ?, ?)',
      ['North', 'Grade 10', termIds[0], 'STEM', 'A. Adviser']);
    const [section2] = await appPool.execute(
      'INSERT INTO sections (name, grade_level, academic_term_id, strand, adviser) VALUES (?, ?, ?, ?, ?)',
      ['South', 'Grade 10', termIds[1], 'ABM', 'B. Adviser']);
    const [scheduleInsert] = await appPool.execute(
      `INSERT INTO finance_schedules (school_year, grade_level, voucher_code, version_no, status, idempotency_key, request_fingerprint, created_by)
       VALUES ('2026-2027', 'Grade 10', 'NV', 1, 'active', ?, ?, ?)`,
      [crypto.randomUUID(), 'a'.repeat(64), actorId]);
    const scheduleId = Number(scheduleInsert.insertId);
    const [tuitionLine] = await appPool.execute(
      `INSERT INTO finance_schedule_lines (schedule_id, term_number, fee_category, line_name, installment, amount, is_optional)
       VALUES (?, 1, 'tuition', 'Tuition', 'DP', 100.00, 0)`, [scheduleId]);
    await appPool.execute(
      `INSERT INTO finance_schedule_lines (schedule_id, term_number, fee_category, line_name, installment, amount, is_optional)
       VALUES (?, 1, 'miscellaneous', 'Laboratory', 'Prelim', 25.00, 0)`, [scheduleId]);
    const term2TuitionLines = [];
    for (const installment of ['DP', 'Prelim', 'Midterm', 'Finals']) {
      const [line] = await appPool.execute(
        `INSERT INTO finance_schedule_lines (schedule_id, term_number, fee_category, line_name, installment, amount, is_optional)
         VALUES (?, 2, 'tuition', 'Tuition', ?, 100.00, 0)`, [scheduleId, installment]);
      term2TuitionLines.push(Number(line.insertId));
    }

    const [studentInsert] = await appPool.execute(
      `INSERT INTO students (student_no, lrn, first_name, middle_name, last_name, suffix, status)
       VALUES ('MASTERLIST-01', '000012345678', 'Mika', 'R.', 'Rivera', '', 'active')`);
    const studentId = Number(studentInsert.insertId);
    const [annualInsert] = await appPool.execute(
      `INSERT INTO annual_enrollments (student_id, school_year, grade_level, voucher_code, intake_status, created_by, entry_term_number)
       VALUES (?, '2026-2027', 'Grade 10', 'NV', 'legacy', ?, 1)`, [studentId, actorId]);
    const annualId = Number(annualInsert.insertId);
    const [term1Enrollment] = await appPool.execute(
      `INSERT INTO enrollments (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id,
        annual_term_number, term_scope_status) VALUES (?, ?, ?, 'enrolled', ?, 1, 'applicable')`,
      [studentId, termIds[0], Number(section1.insertId), annualId]);
    const [term2Enrollment] = await appPool.execute(
      `INSERT INTO enrollments (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id,
        annual_term_number, term_scope_status) VALUES (?, ?, ?, 'transferred', ?, 2, 'applicable')`,
      [studentId, termIds[1], Number(section2.insertId), annualId]);
    const [assessmentInsert] = await appPool.execute(
      `INSERT INTO annual_assessments (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot,
        assessed_by, selection_json, idempotency_key, request_fingerprint)
       VALUES (?, ?, 1, 'NV', ?, '{"optionalLineIds":[]}', ?, ?)`,
      [annualId, scheduleId, actorId, crypto.randomUUID(), 'b'.repeat(64)]);
    const assessmentId = Number(assessmentInsert.insertId);
    await appPool.execute(
      `INSERT INTO annual_registrar_confirmations
        (annual_enrollment_id, student_id, school_year, grade_level, entry_enrollment_id, assessment_id, schedule_id,
         schedule_version, voucher_code_snapshot, payable_total, selection_json, assessment_snapshot_fingerprint,
         confirmed_by, idempotency_key, request_fingerprint)
       VALUES (?, ?, '2026-2027', 'Grade 10', ?, ?, ?, 1, 'NV', 100.00, '{"optionalLineIds":[]}', ?, ?, ?, ?)`,
      [annualId, studentId, Number(term1Enrollment.insertId), assessmentId, scheduleId, 'c'.repeat(64), actorId,
        crypto.randomUUID(), 'd'.repeat(64)]);
    await appPool.execute(
      `INSERT INTO assessed_charges (assessment_id, annual_enrollment_id, enrollment_id, schedule_line_id,
        fee_category, line_name, installment, amount, gross_amount, waived_amount)
       VALUES (?, ?, ?, ?, 'tuition', 'Tuition', 'DP', 90.00, 100.00, 10.00)`,
      [assessmentId, annualId, Number(term1Enrollment.insertId), Number(tuitionLine.insertId)]);
    await appPool.execute(
      `INSERT INTO term_clearance_events (enrollment_id, event_type, reason, recorded_by, created_at)
       VALUES (?, 'signed', 'Test decision', ?, '2026-08-10 20:30:00')`, [Number(term2Enrollment.insertId), actorId]);

    const [activeStudentInsert] = await appPool.execute(
      `INSERT INTO students (student_no, lrn, first_name, middle_name, last_name, suffix, status)
       VALUES ('MASTERLIST-02', '000012345679', 'Noah', 'J.', 'Santos', '', 'active')`);
    const activeStudentId = Number(activeStudentInsert.insertId);
    const [activeAnnualInsert] = await appPool.execute(
      `INSERT INTO annual_enrollments (student_id, school_year, grade_level, voucher_code, intake_status, created_by, entry_term_number)
       VALUES (?, '2026-2027', 'Grade 10', 'NV', 'enrolled', ?, 2)`, [activeStudentId, actorId]);
    const activeAnnualId = Number(activeAnnualInsert.insertId);
    const [priorAnnualInsert] = await appPool.execute(
      `INSERT INTO annual_enrollments (student_id, school_year, grade_level, voucher_code, intake_status, created_by, entry_term_number)
       VALUES (?, '2025-2026', 'Grade 9', 'NV', 'transferred', ?, 1)`, [activeStudentId, actorId]);
    const priorAnnualId = Number(priorAnnualInsert.insertId);
    const [activeEnrollmentInsert] = await appPool.execute(
      `INSERT INTO enrollments (student_id, academic_term_id, section_id, enrollment_status, annual_enrollment_id,
        annual_term_number, term_scope_status) VALUES (?, ?, ?, 'enrolled', ?, 2, 'applicable')`,
      [activeStudentId, termIds[1], Number(section2.insertId), activeAnnualId]);
    const [activeAssessmentInsert] = await appPool.execute(
      `INSERT INTO annual_assessments (annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot,
        assessed_by, selection_json, idempotency_key, request_fingerprint)
       VALUES (?, ?, 1, 'NV', ?, '{"optionalLineIds":[]}', ?, ?)`,
      [activeAnnualId, scheduleId, actorId, crypto.randomUUID(), 'e'.repeat(64)]);
    const activeAssessmentId = Number(activeAssessmentInsert.insertId);
    await appPool.execute(
      `INSERT INTO annual_registrar_confirmations
        (annual_enrollment_id, student_id, school_year, grade_level, entry_enrollment_id, assessment_id, schedule_id,
         schedule_version, voucher_code_snapshot, payable_total, selection_json, assessment_snapshot_fingerprint,
         confirmed_by, idempotency_key, request_fingerprint)
       VALUES (?, ?, '2026-2027', 'Grade 10', ?, ?, ?, 1, 'NV', 400.00, '{"optionalLineIds":[]}', ?, ?, ?, ?)`,
      [activeAnnualId, activeStudentId, Number(activeEnrollmentInsert.insertId), activeAssessmentId, scheduleId,
        'f'.repeat(64), actorId, crypto.randomUUID(), '1'.repeat(64)]);
    for (const [index, installment] of ['DP', 'Prelim', 'Midterm', 'Finals'].entries()) {
      await appPool.execute(
        `INSERT INTO assessed_charges (assessment_id, annual_enrollment_id, enrollment_id, schedule_line_id,
          fee_category, line_name, installment, amount, gross_amount, waived_amount)
         VALUES (?, ?, ?, ?, 'tuition', 'Tuition', ?, 100.00, 100.00, 0.00)`,
        [activeAssessmentId, activeAnnualId, Number(activeEnrollmentInsert.insertId), term2TuitionLines[index], installment]);
    }

    const facade = new PoolFacade(appPool);
    const service = createFinanceMasterlistService({ getPool: async () => facade, sql });
    const result = await service.list(actorId, { schoolYear: '2026-2027', placementTerm: '2', status: 'transferred' });
    assert.equal(result.totalRecords, 1, 'legacy annual accounts remain in the historical cohort');
    assert.equal(result.filters.placementTerm, 2);
    assert.equal(result.rows[0].lrn, '000012345678');
    assert.equal(result.rows[0].terms[1].section, 'North · STEM');
    assert.equal(result.rows[0].terms[2].section, 'South · ABM');
    assert.equal(result.rows[0].terms[2].financeClearance, 'signed');
    assert.equal(result.rows[0].terms[2].financeClearanceDate, '2026-08-11', 'Finance timestamps are shown in Manila local date');
    assert.equal(result.rows[0].terms[3].scopeStatus, 'not_applicable');
    assert.equal(result.rows[0].selectedYearBalance, '90.00');
    assert.equal(result.rows[0].terms[1].fees[JSON.stringify(['tuition', 'tuition', 'dp'])].coverage, '10.00');
    assert.equal(result.rows[0].terms[1].fees[JSON.stringify(['tuition', 'tuition', 'dp'])].status, 'Unpaid');

    const exportBatches = [];
    await service.streamExport(actorId, { schoolYear: '2026-2027', placementTerm: '2', status: 'transferred' }, async (batch) => exportBatches.push(batch));
    assert.equal(exportBatches[0].first, true);
    assert.equal(exportBatches[1].rows.length, 1);
    const csvColumns = createCsvColumns(exportBatches[0].masterlist);
    const csv = csvHeader(csvColumns) + csvRow(exportBatches[1].rows[0], csvColumns);
    assert.match(csv, /"'000012345678"/);
    assert.match(csv, /Term 2 \/ Finance clearance/);
    const [remainingCharges] = await appPool.execute('SELECT COUNT(*) AS count FROM assessed_charges WHERE annual_enrollment_id = ?', [annualId]);
    assert.equal(Number(remainingCharges[0].count), 1, 'the read-only screen and export do not change saved charges');

    const activeFilters = {
      termId: String(termIds[1]), sectionId: String(section2.insertId), status: 'enrolled',
      financeStatus: 'unpaid', installment: 'dp'
    };
    const activeResult = await service.list(actorId, activeFilters);
    assert.equal(activeResult.filters.schoolYear, '2026-2027', 'legacy termId selects its saved school year');
    assert.equal(activeResult.filters.placementTerm, 2, 'legacy termId selects its saved placement term');
    assert.equal(activeResult.filters.section, String(section2.insertId), 'legacy sectionId remains accepted');
    assert.equal(activeResult.totalRecords, 1, 'financeStatus counts only the matching active placement and section');
    assert.equal(activeResult.rows[0].studentNo, 'MASTERLIST-02');
    assert.equal(activeResult.rows[0].terms[2].fees[JSON.stringify(['tuition', 'tuition', 'dp'])].status, 'Unpaid');
    const repeatedActiveResult = await service.list(actorId, activeFilters);
    assert.deepEqual(repeatedActiveResult.rows.map((row) => row.annualEnrollmentId),
      activeResult.rows.map((row) => row.annualEnrollmentId), 'repeated requests reuse the saved active cohort without state changes');
    const allYearsResult = await service.list(actorId, { schoolYear: 'all', placementTerm: '2' });
    assert.equal(allYearsResult.totalRecords, 3, 'All years includes the earlier annual account as a separate row');
    assert.deepEqual([...new Set(allYearsResult.rows.map((row) => row.schoolYear))].sort(), ['2025-2026', '2026-2027']);
    assert.equal(allYearsResult.rows.filter((row) => row.studentId === activeStudentId).length, 2,
      'one student can appear once for each saved annual school year');
    assert.equal(allYearsResult.rows.some((row) => row.annualEnrollmentId === priorAnnualId), true);

    await appPool.execute(
      'INSERT INTO school_year_term_order_reviews (school_year, academic_term_id, review_reason) VALUES (?, ?, ?)',
      ['2026-2027', termIds[1], 'integration-only pending mapping review']);
    const unresolvedCurrentScope = await service.list(actorId, {});
    assert.equal(unresolvedCurrentScope.currentScopeConfigured, false,
      'an unresolved mapping review blocks use of the globally current term as a default');
    assert.equal(unresolvedCurrentScope.needsScopeSelection, true);
    assert.equal(unresolvedCurrentScope.totalRecords, 0,
      'the default request does not silently apply another term while the current mapping needs review');
  } finally {
    if (appPool) await appPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await adminPool.end();
  }
});
