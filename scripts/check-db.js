const { getPool, closePool } = require('../src/config/database');

async function checkDatabase({ getDatabasePool = getPool, closeDatabasePool = closePool, logger = console } = {}) {
  try {
    const pool = await getDatabasePool();
    const databaseResult = await pool.request().query('SELECT DB_NAME() AS databaseName;');
    const databaseName = databaseResult.recordset?.[0]?.databaseName;
    if (databaseName !== 'ARKTIESIIS_V2') {
      logger.error('The application is not connected to ARKTIESIIS_V2.');
      process.exitCode = 1;
      return;
    }

    const versionResult = await pool.request()
      .query("SELECT [version] FROM dbo.schema_migrations WHERE [version] IN ('v2.001', 'v2.002', 'v2.003', 'v2.004');");
    const schema = await pool.request().query(`SELECT
        OBJECT_ID(N'dbo.students', N'U') AS students,
        OBJECT_ID(N'dbo.enrollments', N'U') AS enrollments,
        OBJECT_ID(N'dbo.class_schedules', N'U') AS class_schedules,
        OBJECT_ID(N'dbo.teacher_grade_submissions', N'U') AS teacher_grade_submissions,
        OBJECT_ID(N'dbo.document_decision_events', N'U') AS document_decision_events,
        OBJECT_ID(N'dbo.form137_status_events', N'U') AS form137_status_events,
        OBJECT_ID(N'dbo.previous_school_report_card_status_events', N'U') AS previous_school_report_card_status_events,
        CASE WHEN EXISTS (SELECT 1 FROM sys.check_constraints AS cc
          WHERE cc.parent_object_id = OBJECT_ID(N'dbo.previous_school_report_card_status_events')
            AND cc.name = N'CK_previous_school_report_card_status_status'
            AND cc.definition LIKE N'%rejected%') THEN 1 ELSE 0 END AS previous_report_card_rejected_status_enabled,
        OBJECT_ID(N'dbo.financial_transactions', N'U') AS financial_transactions,
        OBJECT_ID(N'dbo.audit_logs', N'U') AS audit_logs,
        COL_LENGTH(N'dbo.users', N'auth_session_version') AS auth_session_version,
        COL_LENGTH(N'dbo.users', N'must_change_password') AS must_change_password,
        COL_LENGTH(N'dbo.enrollments', N'finalized_at') AS finalized_at,
        COL_LENGTH(N'dbo.documents', N'is_legacy_archive') AS is_legacy_archive,
        CASE WHEN EXISTS (SELECT 1 FROM sys.check_constraints AS cc
          WHERE cc.parent_object_id = OBJECT_ID(N'dbo.users') AND cc.definition LIKE N'%teacher%')
          THEN 1 ELSE 0 END AS teacher_role_enabled,
        CASE WHEN EXISTS (SELECT 1 FROM sys.indexes AS i
          WHERE i.object_id = OBJECT_ID(N'dbo.students') AND i.name = N'UX_students_user_id_linked'
            AND i.is_unique = 1 AND i.has_filter = 1) THEN 1 ELSE 0 END AS filtered_student_link_index;
    `);

    const row = schema.recordset?.[0] || {};
    const missing = [
      ...['students', 'enrollments', 'class_schedules', 'teacher_grade_submissions', 'document_decision_events',
        'form137_status_events', 'previous_school_report_card_status_events', 'financial_transactions', 'audit_logs']
        .filter((key) => !row[key]).map((key) => `dbo.${key}`),
      ...(row.previous_report_card_rejected_status_enabled !== 1 ? ['previous-school report-card paper status vocabulary'] : []),
      ...(row.auth_session_version !== 16 ? ['dbo.users.auth_session_version'] : []),
      ...(row.must_change_password !== 1 ? ['dbo.users.must_change_password'] : []),
      ...(row.finalized_at !== 8 ? ['dbo.enrollments.finalized_at'] : []),
      ...(row.is_legacy_archive !== 1 ? ['dbo.documents.is_legacy_archive'] : []),
      ...(row.teacher_role_enabled !== 1 ? ['teacher user role'] : []),
      ...(row.filtered_student_link_index !== 1 ? ['filtered student account link index'] : [])
    ];

    const versions = new Set((versionResult.recordset || []).map(({ version }) => version));
    if (!versions.has('v2.001') || !versions.has('v2.002') || !versions.has('v2.003') || !versions.has('v2.004') || missing.length) {
      logger.error(`ARKTIESIIS_V2 is reachable, but its prototype schema is incomplete${missing.length ? `: ${missing.join(', ')}` : ''}.`);
      process.exitCode = 1;
      return;
    }
    logger.log('ARKTIESIIS_V2 connectivity and the consolidated prototype schema are verified.');
  } catch {
    logger.error('V2 database check failed. Confirm SQL Server connectivity and run npm run db:setup for a fresh prototype database.');
    process.exitCode = 1;
  } finally {
    try {
      await closeDatabasePool();
    } catch {
      logger.error('V2 database check could not close its connection cleanly.');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) checkDatabase();

module.exports = { checkDatabase };
