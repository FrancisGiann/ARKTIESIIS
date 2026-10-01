'use strict';

const { sql, getPool, closePool } = require('../src/config/database');
const env = require('../src/config/environment');

const REQUIRED_OBJECTS = Object.freeze([
  'schema_migrations', 'application_locks', 'users', 'staff_profiles', 'students', 'academic_terms', 'sections',
  'enrollments', 'subjects', 'student_subjects', 'grades', 'financial_accounts', 'financial_transactions',
  'documents', 'document_validations', 'two_factor_codes', 'audit_logs', 'two_factor_auth_limits',
  'document_review_events', 'document_decision_events', 'form137_status_events', 'grade_import_previews',
  'grade_import_preview_rows', 'grade_import_preview_grades', 'teacher_assignments', 'teacher_grade_submissions',
  'teacher_grade_submission_rows', 'teacher_grade_submission_grades', 'teacher_grade_submission_events',
  'password_reset_tokens', 'pending_email_changes', 'enrollment_clearances', 'class_schedules',
  'previous_school_report_card_status_events', 'annual_enrollments', 'annual_enrollment_events', 'finance_schedules',
  'finance_schedule_lines', 'annual_assessments', 'assessed_charges', 'finance_charge_adjustments', 'finance_payments',
  'finance_allocation_batches', 'finance_payment_allocations', 'finance_legacy_reconciliation_batches',
  'finance_legacy_reconciliations', 'finance_payment_reversals', 'term_finance_approvals', 'term_clearance_events',
  'student_physical_checklist_events', 'physical_requirement_definitions', 'finance_transaction_reversals',
  'school_year_term_order', 'school_year_term_order_reviews', 'annual_workflow_events', 'annual_enrollment_tags',
  'annual_special_subjects', 'finance_exemption_cases', 'finance_exemption_rules', 'finance_exemption_applications',
  'finance_departure_cases', 'finance_departure_case_terms', 'finance_payment_metadata_events',
  'finance_legacy_opening_charges', 'finance_payment_allocation_releases', 'finance_legacy_reconciliation_releases',
  'v_finance_net_payment_allocations', 'v_finance_net_legacy_reconciliations', 'v_finance_payment_credit',
  'v_finance_assessed_charge_due', 'v_finance_opening_liability_due', 'v_finance_legacy_account_balance',
  'student_document_requests', 'student_document_request_events', 'student_profile_revisions',
  'annual_registrar_confirmations', 'annual_enrollment_admin_revisions', 'finance_fee_comment_events',
  'finance_handbook_number_events', 'v_document_latest_review_event', 'v_document_latest_decision_event',
  'v_document_latest_validation', 'v_form137_latest_status_event', 'v_previous_school_report_card_latest_status_event'
]);

const REQUIRED_COLUMNS = Object.freeze({
  users: ['auth_session_version', 'must_change_password'],
  students: ['birthplace', 'emergency_contact_person'],
  documents: ['is_legacy_archive'],
  enrollments: ['finalized_at', 'annual_enrollment_id', 'term_scope_status'],
  annual_enrollments: ['esc_id', 'eform_status', 'finance_handbook_number'],
  previous_school_report_card_status_events: ['status'],
  finance_payment_allocations: ['legacy_opening_charge_id'],
  assessed_charges: ['gross_amount', 'waived_amount']
});
const EXPECTED_VERSIONS = Object.freeze(Array.from({ length: 10 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`));

function bindInList(request, values, prefix) {
  return values.map((value, index) => {
    const name = `${prefix}${index}`;
    request.input(name, sql.VarChar(100), value);
    return `@${name}`;
  });
}

async function checkDatabase({ getDatabasePool = getPool, closeDatabasePool = closePool, logger = console } = {}) {
  try {
    const pool = await getDatabasePool();
    const databaseResult = await pool.request().query('SELECT DATABASE() AS databaseName');
    const databaseName = databaseResult.recordset?.[0]?.databaseName;
    if (!databaseName || databaseName !== env.database.database) {
      logger.error('MariaDB is reachable, but the selected database does not match DB_NAME.');
      process.exitCode = 1;
      return;
    }

    const versionRequest = pool.request();
    const versionNames = bindInList(versionRequest, EXPECTED_VERSIONS, 'version');
    const versionResult = await versionRequest.query(`SELECT version FROM schema_migrations WHERE version IN (${versionNames.join(', ')})`);
    const versions = new Set((versionResult.recordset || []).map(({ version }) => String(version)));

    const objectRequest = pool.request();
    const objectNames = bindInList(objectRequest, REQUIRED_OBJECTS, 'object');
    const objectResult = await objectRequest.query(`SELECT table_name AS objectName FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name IN (${objectNames.join(', ')})`);
    const objects = new Set((objectResult.recordset || []).map(({ objectName }) => String(objectName)));

    const columnRequest = pool.request();
    const columnPairs = [];
    for (const [tableName, columnNames] of Object.entries(REQUIRED_COLUMNS)) {
      for (const columnName of columnNames) {
        const index = columnPairs.length;
        const tableParameter = `columnTable${index}`;
        const columnParameter = `columnName${index}`;
        columnRequest.input(tableParameter, sql.VarChar(100), tableName);
        columnRequest.input(columnParameter, sql.VarChar(100), columnName);
        columnPairs.push(`(table_name = @${tableParameter} AND column_name = @${columnParameter})`);
      }
    }
    const columnResult = await columnRequest.query(`SELECT table_name AS tableName, column_name AS columnName
      FROM information_schema.columns WHERE table_schema = DATABASE() AND (${columnPairs.join(' OR ')})`);
    const columns = new Set((columnResult.recordset || []).map(({ tableName, columnName }) => `${tableName}.${columnName}`));

    const constraintRequest = pool.request()
      .input('constraintName', sql.VarChar(100), 'CK_previous_school_report_card_status_status');
    const constraintResult = await constraintRequest.query(`SELECT COUNT(*) AS constraintCount
      FROM information_schema.table_constraints
      WHERE constraint_schema = DATABASE() AND table_name = 'previous_school_report_card_status_events'
        AND constraint_name = @constraintName AND constraint_type = 'CHECK'`);

    const indexRequest = pool.request()
      .input('indexName', sql.VarChar(100), 'UX_students_user_id_linked');
    const indexResult = await indexRequest.query(`SELECT COUNT(*) AS indexCount FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'students' AND index_name = @indexName AND non_unique = 0`);

    const missing = [
      ...REQUIRED_OBJECTS.filter((name) => !objects.has(name)).map((name) => `object ${name}`),
      ...Object.entries(REQUIRED_COLUMNS).flatMap(([tableName, columnNames]) => columnNames
        .filter((columnName) => !columns.has(`${tableName}.${columnName}`))
        .map((columnName) => `column ${tableName}.${columnName}`)),
      ...EXPECTED_VERSIONS.filter((version) => !versions.has(version)).map((version) => `migration ${version}`),
      ...(Number(constraintResult.recordset?.[0]?.constraintCount || 0) < 1 ? ['paper-copy status constraint'] : []),
      ...(Number(indexResult.recordset?.[0]?.indexCount || 0) < 1 ? ['unique linked student-account index'] : [])
    ];
    if (missing.length) {
      logger.error(`MariaDB is reachable, but its ARKTIESIIS schema is incomplete: ${missing.join(', ')}.`);
      process.exitCode = 1;
      return;
    }
    logger.log(`MariaDB connectivity and schema in ${databaseName} are verified through v2.010.`);
  } catch {
    logger.error('MariaDB database check failed. Confirm DB_HOST, DB_PORT, DB_NAME, DB_USER, and DB_PASSWORD, then run npm run db:setup.');
    process.exitCode = 1;
  } finally {
    try {
      await closeDatabasePool();
    } catch {
      logger.error('MariaDB database check could not close its connection cleanly.');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) checkDatabase();

module.exports = { REQUIRED_OBJECTS, REQUIRED_COLUMNS, EXPECTED_VERSIONS, checkDatabase };
