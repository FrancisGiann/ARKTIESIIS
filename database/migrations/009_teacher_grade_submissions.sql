DECLARE @roleConstraint sysname;
SELECT TOP (1) @roleConstraint = cc.name
FROM sys.check_constraints AS cc
WHERE cc.parent_object_id = OBJECT_ID(N'dbo.users')
  AND cc.definition LIKE N'%database_admin%'
  AND cc.definition LIKE N'%student%';

IF @roleConstraint IS NOT NULL
BEGIN
    DECLARE @dropRoleConstraintSql NVARCHAR(400);
    SET @dropRoleConstraintSql = N'ALTER TABLE dbo.users DROP CONSTRAINT ' + QUOTENAME(@roleConstraint);
    EXEC sys.sp_executesql @dropRoleConstraintSql;
END;

ALTER TABLE dbo.users
ADD CONSTRAINT CK_users_role
CHECK (role IN ('database_admin', 'registrar', 'finance', 'teacher', 'student'));

ALTER TABLE dbo.grade_import_previews
ADD academic_term_id INT NULL;

ALTER TABLE dbo.grade_import_previews
ADD original_filename NVARCHAR(255) NULL;

ALTER TABLE dbo.grade_import_previews
ADD CONSTRAINT FK_grade_import_preview_term FOREIGN KEY (academic_term_id) REFERENCES dbo.academic_terms(id);

CREATE TABLE dbo.teacher_assignments (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    teacher_id INT NOT NULL,
    academic_term_id INT NOT NULL,
    section_id INT NOT NULL,
    subject_id INT NOT NULL,
    assigned_by INT NOT NULL,
    is_active BIT NOT NULL CONSTRAINT DF_teacher_assignments_is_active DEFAULT 1,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_teacher_assignments_created_at DEFAULT SYSUTCDATETIME(),
    revoked_at DATETIME2 NULL,
    CONSTRAINT FK_teacher_assignment_teacher FOREIGN KEY (teacher_id) REFERENCES dbo.users(id),
    CONSTRAINT FK_teacher_assignment_term FOREIGN KEY (academic_term_id) REFERENCES dbo.academic_terms(id),
    CONSTRAINT FK_teacher_assignment_section_term FOREIGN KEY (section_id, academic_term_id)
        REFERENCES dbo.sections(id, academic_term_id),
    CONSTRAINT FK_teacher_assignment_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id),
    CONSTRAINT FK_teacher_assignment_assigner FOREIGN KEY (assigned_by) REFERENCES dbo.users(id),
    CONSTRAINT CK_teacher_assignment_revoked_at CHECK ((is_active = 1 AND revoked_at IS NULL) OR is_active = 0)
);

CREATE UNIQUE INDEX UX_teacher_assignment_active_context
    ON dbo.teacher_assignments (academic_term_id, section_id, subject_id)
    WHERE is_active = 1;

CREATE INDEX IX_teacher_assignment_active_teacher
    ON dbo.teacher_assignments (teacher_id, academic_term_id, section_id, subject_id)
    WHERE is_active = 1;

CREATE TABLE dbo.teacher_grade_submissions (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    assignment_id INT NOT NULL,
    previous_submission_id UNIQUEIDENTIFIER NULL,
    revision_number INT NOT NULL,
    submitted_by INT NOT NULL,
    school_year NVARCHAR(20) NOT NULL,
    grade_level NVARCHAR(50) NOT NULL,
    section_name NVARCHAR(100) NOT NULL,
    subject_id INT NOT NULL,
    subject_name NVARCHAR(200) NOT NULL,
    workbook_grade_level NVARCHAR(50) NOT NULL,
    workbook_section_name NVARCHAR(100) NOT NULL,
    workbook_subject_name NVARCHAR(200) NOT NULL,
    context_mismatch BIT NOT NULL,
    original_filename NVARCHAR(255) NOT NULL,
    storage_key UNIQUEIDENTIFIER NOT NULL UNIQUE,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes BETWEEN 4 AND 5242880),
    status NVARCHAR(30) NOT NULL CONSTRAINT DF_teacher_grade_submission_status DEFAULT N'pending'
        CHECK (status IN (N'pending', N'approved', N'correction_requested', N'rejected')),
    submitted_at DATETIME2 NOT NULL CONSTRAINT DF_teacher_grade_submission_submitted DEFAULT SYSUTCDATETIME(),
    decided_by INT NULL,
    decided_at DATETIME2 NULL,
    decision_reason NVARCHAR(500) NULL,
    CONSTRAINT UQ_teacher_grade_submission_revision UNIQUE (assignment_id, revision_number),
    CONSTRAINT FK_teacher_grade_submission_assignment FOREIGN KEY (assignment_id) REFERENCES dbo.teacher_assignments(id),
    CONSTRAINT FK_teacher_grade_submission_previous FOREIGN KEY (previous_submission_id) REFERENCES dbo.teacher_grade_submissions(id),
    CONSTRAINT FK_teacher_grade_submission_submitter FOREIGN KEY (submitted_by) REFERENCES dbo.users(id),
    CONSTRAINT FK_teacher_grade_submission_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id),
    CONSTRAINT FK_teacher_grade_submission_decider FOREIGN KEY (decided_by) REFERENCES dbo.users(id)
);

CREATE UNIQUE INDEX UX_teacher_grade_submission_pending_assignment
    ON dbo.teacher_grade_submissions (assignment_id)
    WHERE status = N'pending';

CREATE INDEX IX_teacher_grade_submission_review_queue
    ON dbo.teacher_grade_submissions (status, submitted_at DESC);

CREATE INDEX IX_teacher_grade_submission_owner
    ON dbo.teacher_grade_submissions (submitted_by, assignment_id, submitted_at DESC);

CREATE TABLE dbo.teacher_grade_submission_rows (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    submission_id UNIQUEIDENTIFIER NOT NULL,
    source_row INT NOT NULL,
    student_id INT NULL,
    enrollment_id INT NULL,
    student_subject_id INT NULL,
    student_no NVARCHAR(50) NULL,
    workbook_name NVARCHAR(200) NULL,
    student_name NVARCHAR(200) NULL,
    lrn_fingerprint CHAR(64) NULL,
    name_mismatch BIT NOT NULL,
    issue NVARCHAR(500) NULL,
    CONSTRAINT UQ_teacher_grade_submission_row UNIQUE (submission_id, source_row),
    CONSTRAINT FK_teacher_grade_submission_row_submission FOREIGN KEY (submission_id)
        REFERENCES dbo.teacher_grade_submissions(id) ON DELETE CASCADE,
    CONSTRAINT FK_teacher_grade_submission_row_student FOREIGN KEY (student_id) REFERENCES dbo.students(id),
    CONSTRAINT FK_teacher_grade_submission_row_enrollment FOREIGN KEY (enrollment_id) REFERENCES dbo.enrollments(id),
    CONSTRAINT FK_teacher_grade_submission_row_assignment FOREIGN KEY (student_subject_id) REFERENCES dbo.student_subjects(id)
);

CREATE TABLE dbo.teacher_grade_submission_grades (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    submission_row_id BIGINT NOT NULL,
    grading_period NVARCHAR(50) NOT NULL,
    grade_value DECIMAL(6,2) NOT NULL CHECK (grade_value BETWEEN 0 AND 100),
    existing_grade_id INT NULL,
    existing_grade_value DECIMAL(6,2) NULL,
    CONSTRAINT UQ_teacher_grade_submission_grade_period UNIQUE (submission_row_id, grading_period),
    CONSTRAINT FK_teacher_grade_submission_grade_row FOREIGN KEY (submission_row_id)
        REFERENCES dbo.teacher_grade_submission_rows(id) ON DELETE CASCADE,
    CONSTRAINT FK_teacher_grade_submission_grade_existing FOREIGN KEY (existing_grade_id) REFERENCES dbo.grades(id)
);

CREATE TABLE dbo.teacher_grade_submission_events (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    submission_id UNIQUEIDENTIFIER NOT NULL,
    actor_id INT NOT NULL,
    event_type NVARCHAR(40) NOT NULL
        CHECK (event_type IN (N'submitted', N'revision_submitted', N'approved', N'correction_requested', N'rejected')),
    reason NVARCHAR(500) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_teacher_grade_submission_event_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_teacher_grade_submission_event_submission FOREIGN KEY (submission_id)
        REFERENCES dbo.teacher_grade_submissions(id),
    CONSTRAINT FK_teacher_grade_submission_event_actor FOREIGN KEY (actor_id) REFERENCES dbo.users(id)
);

CREATE INDEX IX_teacher_grade_submission_event_history
    ON dbo.teacher_grade_submission_events (submission_id, created_at, id);
