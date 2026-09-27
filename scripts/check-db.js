const { getPool, closePool } = require('../src/config/database');

async function checkDatabase() {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query("SELECT [version] FROM dbo.schema_migrations WHERE [version] IN ('001', '002', '003', '004', '005', '006', '007', '008', '009')");
    const versions = new Set(result.recordset.map(({ version }) => version));
    const missingVersions = ['001', '002', '003', '004', '005', '006', '007', '008', '009'].filter((version) => !versions.has(version));
    const objects = await pool.request().query(`SELECT
        OBJECT_ID(N'dbo.grade_import_previews', N'U') AS grade_import_previews,
        OBJECT_ID(N'dbo.grade_import_preview_rows', N'U') AS grade_import_preview_rows,
        OBJECT_ID(N'dbo.grade_import_preview_grades', N'U') AS grade_import_preview_grades,
        OBJECT_ID(N'dbo.teacher_assignments', N'U') AS teacher_assignments,
        OBJECT_ID(N'dbo.teacher_grade_submissions', N'U') AS teacher_grade_submissions,
        OBJECT_ID(N'dbo.teacher_grade_submission_rows', N'U') AS teacher_grade_submission_rows,
        OBJECT_ID(N'dbo.teacher_grade_submission_grades', N'U') AS teacher_grade_submission_grades,
        OBJECT_ID(N'dbo.teacher_grade_submission_events', N'U') AS teacher_grade_submission_events,
        (SELECT TOP (1) cc.object_id FROM sys.check_constraints AS cc
          WHERE cc.parent_object_id = OBJECT_ID(N'dbo.users') AND cc.name = N'CK_users_role'
            AND cc.definition LIKE N'%teacher%') AS user_role_constraint,
        COL_LENGTH(N'dbo.grade_import_previews', N'academic_term_id') AS grade_preview_term_column_length,
        COL_LENGTH(N'dbo.grade_import_previews', N'original_filename') AS grade_preview_filename_column_length,
        COL_LENGTH(N'dbo.students', N'lrn') AS lrn_column_length,
        OBJECT_ID(N'dbo.CK_students_lrn_format', N'C') AS lrn_check_constraint,
        OBJECT_ID(N'dbo.TR_students_require_lrn_on_insert', N'TR') AS lrn_insert_trigger,
        COL_LENGTH(N'dbo.document_decision_events', N'verification_checklist_json') AS verification_checklist_column_length,
        OBJECT_ID(N'dbo.CK_document_decision_event_verification_checklist', N'C') AS verification_checklist_constraint,
        CASE WHEN EXISTS (
          SELECT 1 FROM sys.indexes
          WHERE object_id = OBJECT_ID(N'dbo.students') AND name = N'UX_students_lrn'
            AND is_unique = 1 AND has_filter = 1
        ) THEN 1 ELSE 0 END AS unique_lrn_index`);
    const schema = objects.recordset?.[0] || {};
    const missingObjects = [
      ...['grade_import_previews', 'grade_import_preview_rows', 'grade_import_preview_grades']
        .filter((name) => !schema[name]).map((name) => `dbo.${name}`),
      ...['teacher_assignments', 'teacher_grade_submissions', 'teacher_grade_submission_rows',
        'teacher_grade_submission_grades', 'teacher_grade_submission_events']
        .filter((name) => !schema[name]).map((name) => `dbo.${name}`),
      ...(!schema.user_role_constraint ? ['dbo.CK_users_role (including teacher)'] : []),
      ...(schema.grade_preview_term_column_length !== 4 ? ['dbo.grade_import_previews.academic_term_id'] : []),
      ...(schema.grade_preview_filename_column_length !== 510 ? ['dbo.grade_import_previews.original_filename NVARCHAR(255)'] : []),
      ...(schema.lrn_column_length !== 24 ? ['dbo.students.lrn NVARCHAR(12)'] : []),
      ...(!schema.lrn_check_constraint ? ['dbo.CK_students_lrn_format'] : []),
      ...(!schema.lrn_insert_trigger ? ['dbo.TR_students_require_lrn_on_insert'] : []),
      ...(schema.verification_checklist_column_length !== 1000 ? ['dbo.document_decision_events.verification_checklist_json NVARCHAR(500)'] : []),
      ...(!schema.verification_checklist_constraint ? ['dbo.CK_document_decision_event_verification_checklist'] : []),
      ...(schema.unique_lrn_index !== 1 ? ['dbo.UX_students_lrn'] : [])
    ];

    if (missingVersions.length > 0 || missingObjects.length > 0) {
      if (missingVersions.length > 0) console.error(`Database is reachable, but required schema migration(s) ${missingVersions.join(', ')} are not installed.`);
      if (missingObjects.length > 0) console.error(`Required grade-import/teacher/LRN schema objects are missing or invalid: ${missingObjects.join(', ')}.`);
      process.exitCode = 1;
      return;
    }

    console.log('Database connectivity, migrations 001–009, teacher grade submission schema, LRN constraints/index/trigger, verification checklist storage, and grade-import preview tables verified.');
  } catch {
    console.error('Database check failed. Confirm the database settings, connectivity, and schema migrations 001 through 009.');
    process.exitCode = 1;
  } finally {
    try {
      await closePool();
    } catch {
      console.error('Database check could not close its connection cleanly.');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  checkDatabase();
}

module.exports = { checkDatabase };
