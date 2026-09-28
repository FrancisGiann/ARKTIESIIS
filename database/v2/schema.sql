/* ARKTIESIIS V2 fresh-install schema - Microsoft SQL Server.
   This is the consolidated prototype baseline; it never updates ARKTIESIIS. */

IF DB_ID('ARKTIESIIS_V2') IS NULL
BEGIN
    CREATE DATABASE ARKTIESIIS_V2;
END;
GO

USE ARKTIESIIS_V2;
GO

CREATE TABLE schema_migrations (
    version NVARCHAR(50) NOT NULL PRIMARY KEY,
    applied_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE users (
    id INT IDENTITY(1,1) PRIMARY KEY,
    email NVARCHAR(255) NOT NULL UNIQUE,
    password_hash NVARCHAR(255) NOT NULL,
    role NVARCHAR(30) NOT NULL CHECK (role IN ('database_admin','registrar','teacher','finance','student')),
    is_active BIT NOT NULL DEFAULT 1,
    email_verified_at DATETIME2 NULL,
    auth_session_version UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_users_auth_session_version DEFAULT NEWID(),
    must_change_password BIT NOT NULL CONSTRAINT DF_users_must_change_password DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE staff_profiles (
    id INT IDENTITY(1,1) PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    employee_no NVARCHAR(50) NULL UNIQUE,
    first_name NVARCHAR(100) NOT NULL,
    last_name NVARCHAR(100) NOT NULL,
    department NVARCHAR(100) NULL,
    CONSTRAINT FK_staff_user FOREIGN KEY (user_id) REFERENCES users(id)
);
GO

CREATE TABLE students (
    id INT IDENTITY(1,1) PRIMARY KEY,
    user_id INT NULL,
    student_no NVARCHAR(50) NOT NULL UNIQUE,
    lrn NVARCHAR(12) NOT NULL,
    first_name NVARCHAR(100) NOT NULL,
    middle_name NVARCHAR(100) NULL,
    last_name NVARCHAR(100) NOT NULL,
    suffix NVARCHAR(20) NULL,
    birth_date DATE NULL,
    sex NVARCHAR(20) NULL,
    address NVARCHAR(500) NULL,
    phone NVARCHAR(50) NULL,
    status NVARCHAR(30) NOT NULL DEFAULT 'active',
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_student_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT CK_students_lrn_format CHECK (DATALENGTH(lrn) = 24 AND lrn NOT LIKE N'%[^0-9]%')
);
GO

CREATE UNIQUE INDEX UX_students_user_id_linked ON students (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX UX_students_lrn ON students (lrn);
GO

CREATE TABLE academic_terms (
    id INT IDENTITY(1,1) PRIMARY KEY,
    school_year NVARCHAR(20) NOT NULL,
    term NVARCHAR(30) NOT NULL,
    is_current BIT NOT NULL DEFAULT 0,
    UNIQUE (school_year, term)
);
GO

CREATE UNIQUE INDEX UX_academic_terms_single_current
    ON academic_terms (is_current)
    WHERE is_current = 1;
GO

CREATE TABLE sections (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(100) NOT NULL,
    grade_level NVARCHAR(50) NULL,
    academic_term_id INT NOT NULL,
    CONSTRAINT UQ_section_id_term UNIQUE (id, academic_term_id),
    CONSTRAINT FK_section_term FOREIGN KEY (academic_term_id) REFERENCES academic_terms(id)
);
GO

CREATE TABLE enrollments (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    academic_term_id INT NOT NULL,
    section_id INT NULL,
    enrollment_status NVARCHAR(30) NOT NULL DEFAULT 'enrolled',
    enrolled_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    finalized_at DATETIME2 NULL,
    UNIQUE (student_id, academic_term_id),
    CONSTRAINT FK_enrollment_student FOREIGN KEY (student_id) REFERENCES students(id),
    CONSTRAINT FK_enrollment_term FOREIGN KEY (academic_term_id) REFERENCES academic_terms(id),
    CONSTRAINT FK_enrollment_section_term FOREIGN KEY (section_id, academic_term_id)
        REFERENCES sections(id, academic_term_id)
);
GO

CREATE TABLE subjects (
    id INT IDENTITY(1,1) PRIMARY KEY,
    subject_code NVARCHAR(50) NOT NULL UNIQUE,
    subject_name NVARCHAR(200) NOT NULL,
    units DECIMAL(5,2) NULL
);
GO

CREATE TABLE student_subjects (
    id INT IDENTITY(1,1) PRIMARY KEY,
    enrollment_id INT NOT NULL,
    subject_id INT NOT NULL,
    UNIQUE (enrollment_id, subject_id),
    CONSTRAINT FK_student_subject_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
    CONSTRAINT FK_student_subject_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
);
GO

CREATE TABLE grades (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_subject_id INT NOT NULL,
    grading_period NVARCHAR(50) NOT NULL,
    grade_value DECIMAL(6,2) NULL,
    remarks NVARCHAR(100) NULL,
    recorded_by INT NOT NULL,
    recorded_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_grade_student_subject_period UNIQUE (student_subject_id, grading_period),
    CONSTRAINT FK_grade_student_subject FOREIGN KEY (student_subject_id) REFERENCES student_subjects(id),
    CONSTRAINT FK_grade_user FOREIGN KEY (recorded_by) REFERENCES users(id)
);
GO

CREATE TABLE financial_accounts (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL UNIQUE,
    balance DECIMAL(12,2) NOT NULL DEFAULT 0,
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_financial_account_student FOREIGN KEY (student_id) REFERENCES students(id)
);
GO

CREATE TABLE financial_transactions (
    id INT IDENTITY(1,1) PRIMARY KEY,
    financial_account_id INT NOT NULL,
    transaction_type NVARCHAR(30) NOT NULL CHECK (transaction_type IN ('charge','payment','adjustment')),
    amount DECIMAL(12,2) NOT NULL,
    description NVARCHAR(500) NULL,
    reference_no NVARCHAR(100) NULL,
    recorded_by INT NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_financial_transaction_account FOREIGN KEY (financial_account_id) REFERENCES financial_accounts(id),
    CONSTRAINT FK_financial_transaction_user FOREIGN KEY (recorded_by) REFERENCES users(id)
);
GO

CREATE TABLE documents (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    document_type NVARCHAR(50) NOT NULL CHECK (document_type IN ('form_137','report_card','good_moral','psa_birth_certificate')),
    original_filename NVARCHAR(255) NOT NULL,
    stored_filename NVARCHAR(255) NOT NULL UNIQUE,
    mime_type NVARCHAR(100) NOT NULL,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
    uploaded_by INT NOT NULL,
    upload_source NVARCHAR(30) NOT NULL CHECK (upload_source IN ('student','registrar','database_admin')),
    status NVARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','valid','needs_review','rejected','failed')),
    supersedes_document_id INT NULL,
    processing_started_at DATETIME2(3) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_document_student FOREIGN KEY (student_id) REFERENCES students(id),
    CONSTRAINT FK_document_supersedes_document FOREIGN KEY (supersedes_document_id) REFERENCES documents(id),
    CONSTRAINT CK_document_not_superseding_itself CHECK (supersedes_document_id IS NULL OR supersedes_document_id <> id),
    CONSTRAINT FK_document_user FOREIGN KEY (uploaded_by) REFERENCES users(id)
);
GO

CREATE UNIQUE INDEX UX_documents_supersedes_document_id ON documents (supersedes_document_id)
    WHERE supersedes_document_id IS NOT NULL;
CREATE INDEX IX_documents_status_processing_started_at ON documents (processing_started_at, id)
    WHERE status = 'processing';
GO

CREATE TABLE document_validations (
    id INT IDENTITY(1,1) PRIMARY KEY,
    document_id INT NOT NULL,
    processor NVARCHAR(100) NOT NULL DEFAULT 'Gemini field extraction',
    extracted_text NVARCHAR(MAX) NULL,
    validation_json NVARCHAR(MAX) NULL,
    completeness_passed BIT NULL,
    format_passed BIT NULL,
    result_status NVARCHAR(30) NOT NULL CHECK (result_status IN ('valid','needs_review','failed')),
    reviewed_by INT NULL,
    reviewed_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_validation_document FOREIGN KEY (document_id) REFERENCES documents(id),
    CONSTRAINT FK_validation_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id)
);
GO

CREATE TABLE two_factor_codes (
    id INT IDENTITY(1,1) PRIMARY KEY,
    user_id INT NOT NULL,
    code_hash NVARCHAR(255) NOT NULL,
    expires_at DATETIME2 NOT NULL,
    consumed_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_two_factor_user FOREIGN KEY (user_id) REFERENCES users(id)
);
GO

CREATE TABLE audit_logs (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    user_id INT NULL,
    action NVARCHAR(100) NOT NULL,
    entity_type NVARCHAR(100) NULL,
    entity_id NVARCHAR(100) NULL,
    details_json NVARCHAR(MAX) NULL,
    ip_address NVARCHAR(64) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_audit_user FOREIGN KEY (user_id) REFERENCES users(id)
);
GO

CREATE TABLE two_factor_auth_limits (
    user_id INT NOT NULL PRIMARY KEY,
    failed_attempts INT NOT NULL CONSTRAINT DF_two_factor_limits_failed_attempts DEFAULT 0,
    failed_window_started_at DATETIME2 NOT NULL CONSTRAINT DF_two_factor_limits_failed_window DEFAULT SYSUTCDATETIME(),
    send_count INT NOT NULL CONSTRAINT DF_two_factor_limits_send_count DEFAULT 0,
    send_window_started_at DATETIME2 NOT NULL CONSTRAINT DF_two_factor_limits_send_window DEFAULT SYSUTCDATETIME(),
    last_sent_at DATETIME2 NULL,
    CONSTRAINT CK_two_factor_limits_failed_attempts CHECK (failed_attempts >= 0),
    CONSTRAINT CK_two_factor_limits_send_count CHECK (send_count >= 0),
    CONSTRAINT FK_two_factor_limits_user FOREIGN KEY (user_id) REFERENCES users(id)
);
GO

CREATE TABLE document_review_events (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    document_id INT NOT NULL,
    reviewer_id INT NOT NULL,
    action_type NVARCHAR(40) NOT NULL CHECK (action_type IN ('review_requested', 'correction_requested')),
    instruction NVARCHAR(1000) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_document_review_event_document FOREIGN KEY (document_id) REFERENCES documents(id),
    CONSTRAINT FK_document_review_event_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id),
    CONSTRAINT CK_document_review_event_instruction CHECK (
        (action_type = 'correction_requested' AND instruction IS NOT NULL) OR action_type = 'review_requested')
);
CREATE INDEX IX_document_review_events_document_created
    ON document_review_events (document_id, created_at DESC, id DESC);

CREATE TABLE document_decision_events (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    document_id INT NOT NULL,
    reviewer_id INT NOT NULL,
    decision_type NVARCHAR(40) NOT NULL CHECK (decision_type IN ('verified', 'correction_requested', 'rejected')),
    reason NVARCHAR(1000) NULL,
    verification_checklist_json NVARCHAR(500) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_document_decision_event_document FOREIGN KEY (document_id) REFERENCES documents(id),
    CONSTRAINT FK_document_decision_event_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id),
    CONSTRAINT CK_document_decision_event_reason CHECK (
        decision_type = 'verified' OR (reason IS NOT NULL AND LEN(LTRIM(RTRIM(reason))) > 0)),
    CONSTRAINT CK_document_decision_event_verification_checklist CHECK (
        verification_checklist_json IS NULL OR (decision_type = 'verified' AND ISJSON(verification_checklist_json) = 1))
);
CREATE INDEX IX_document_decision_events_document_created
    ON document_decision_events (document_id, created_at DESC, id DESC);

CREATE TABLE form137_status_events (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    student_id INT NOT NULL,
    recorded_by INT NOT NULL,
    status NVARCHAR(30) NOT NULL CHECK (status IN ('pending', 'received', 'verified', 'correction', 'rejected')),
    instruction NVARCHAR(1000) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_form137_status_student FOREIGN KEY (student_id) REFERENCES students(id),
    CONSTRAINT FK_form137_status_recorder FOREIGN KEY (recorded_by) REFERENCES users(id),
    CONSTRAINT CK_form137_status_correction_instruction CHECK (
        status <> 'correction' OR (instruction IS NOT NULL AND LEN(LTRIM(RTRIM(instruction))) > 0))
);
CREATE INDEX IX_form137_status_events_student_created
    ON form137_status_events (student_id, created_at DESC, id DESC);
GO

CREATE TABLE grade_import_previews (
    id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    uploaded_by INT NOT NULL,
    session_fingerprint CHAR(64) NOT NULL,
    school_year NVARCHAR(20) NOT NULL,
    grade_level NVARCHAR(50) NOT NULL,
    section_name NVARCHAR(100) NOT NULL,
    subject_id INT NOT NULL,
    subject_name NVARCHAR(200) NOT NULL,
    workbook_grade_level NVARCHAR(50) NOT NULL,
    workbook_section_name NVARCHAR(100) NOT NULL,
    workbook_subject_name NVARCHAR(200) NOT NULL,
    context_mismatch BIT NOT NULL DEFAULT 0,
    status NVARCHAR(20) NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'confirmed')),
    academic_term_id INT NOT NULL,
    original_filename NVARCHAR(255) NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    expires_at DATETIME2 NOT NULL,
    CONSTRAINT FK_grade_import_preview_user FOREIGN KEY (uploaded_by) REFERENCES users(id),
    CONSTRAINT FK_grade_import_preview_subject FOREIGN KEY (subject_id) REFERENCES subjects(id),
    CONSTRAINT FK_grade_import_preview_term FOREIGN KEY (academic_term_id) REFERENCES academic_terms(id)
);
CREATE INDEX IX_grade_import_previews_expiry ON grade_import_previews (expires_at);

CREATE TABLE grade_import_preview_rows (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    preview_id UNIQUEIDENTIFIER NOT NULL,
    source_row INT NOT NULL,
    student_id INT NULL,
    enrollment_id INT NULL,
    student_subject_id INT NULL,
    student_no NVARCHAR(50) NULL,
    workbook_name NVARCHAR(200) NULL,
    student_name NVARCHAR(200) NULL,
    lrn_fingerprint CHAR(64) NULL,
    name_mismatch BIT NOT NULL DEFAULT 0,
    issue NVARCHAR(500) NULL,
    CONSTRAINT UQ_grade_import_preview_row UNIQUE (preview_id, source_row),
    CONSTRAINT FK_grade_import_preview_row_preview FOREIGN KEY (preview_id)
        REFERENCES grade_import_previews(id) ON DELETE CASCADE,
    CONSTRAINT FK_grade_import_preview_row_student FOREIGN KEY (student_id) REFERENCES students(id),
    CONSTRAINT FK_grade_import_preview_row_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
    CONSTRAINT FK_grade_import_preview_row_assignment FOREIGN KEY (student_subject_id) REFERENCES student_subjects(id)
);

CREATE TABLE grade_import_preview_grades (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    preview_row_id BIGINT NOT NULL,
    grading_period NVARCHAR(50) NOT NULL,
    grade_value DECIMAL(6,2) NOT NULL,
    existing_grade_id INT NULL,
    existing_grade_value DECIMAL(6,2) NULL,
    CONSTRAINT UQ_grade_import_preview_grade_period UNIQUE (preview_row_id, grading_period),
    CONSTRAINT FK_grade_import_preview_grade_row FOREIGN KEY (preview_row_id)
        REFERENCES grade_import_preview_rows(id) ON DELETE CASCADE,
    CONSTRAINT FK_grade_import_preview_grade_existing FOREIGN KEY (existing_grade_id) REFERENCES grades(id)
);
GO

CREATE TABLE teacher_assignments (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    teacher_id INT NOT NULL,
    academic_term_id INT NOT NULL,
    section_id INT NOT NULL,
    subject_id INT NOT NULL,
    assigned_by INT NOT NULL,
    is_active BIT NOT NULL CONSTRAINT DF_teacher_assignments_is_active DEFAULT 1,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_teacher_assignments_created_at DEFAULT SYSUTCDATETIME(),
    revoked_at DATETIME2 NULL,
    CONSTRAINT FK_teacher_assignment_teacher FOREIGN KEY (teacher_id) REFERENCES users(id),
    CONSTRAINT FK_teacher_assignment_term FOREIGN KEY (academic_term_id) REFERENCES academic_terms(id),
    CONSTRAINT FK_teacher_assignment_section_term FOREIGN KEY (section_id, academic_term_id)
        REFERENCES sections(id, academic_term_id),
    CONSTRAINT FK_teacher_assignment_subject FOREIGN KEY (subject_id) REFERENCES subjects(id),
    CONSTRAINT FK_teacher_assignment_assigner FOREIGN KEY (assigned_by) REFERENCES users(id),
    CONSTRAINT CK_teacher_assignment_revoked_at CHECK ((is_active = 1 AND revoked_at IS NULL) OR is_active = 0)
);
CREATE UNIQUE INDEX UX_teacher_assignment_active_context
    ON teacher_assignments (academic_term_id, section_id, subject_id) WHERE is_active = 1;
CREATE INDEX IX_teacher_assignment_active_teacher
    ON teacher_assignments (teacher_id, academic_term_id, section_id, subject_id) WHERE is_active = 1;

CREATE TABLE teacher_grade_submissions (
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
    CONSTRAINT FK_teacher_grade_submission_assignment FOREIGN KEY (assignment_id) REFERENCES teacher_assignments(id),
    CONSTRAINT FK_teacher_grade_submission_previous FOREIGN KEY (previous_submission_id) REFERENCES teacher_grade_submissions(id),
    CONSTRAINT FK_teacher_grade_submission_submitter FOREIGN KEY (submitted_by) REFERENCES users(id),
    CONSTRAINT FK_teacher_grade_submission_subject FOREIGN KEY (subject_id) REFERENCES subjects(id),
    CONSTRAINT FK_teacher_grade_submission_decider FOREIGN KEY (decided_by) REFERENCES users(id)
);
CREATE UNIQUE INDEX UX_teacher_grade_submission_pending_assignment
    ON teacher_grade_submissions (assignment_id) WHERE status = N'pending';
CREATE INDEX IX_teacher_grade_submission_review_queue
    ON teacher_grade_submissions (status, submitted_at DESC);
CREATE INDEX IX_teacher_grade_submission_owner
    ON teacher_grade_submissions (submitted_by, assignment_id, submitted_at DESC);

CREATE TABLE teacher_grade_submission_rows (
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
        REFERENCES teacher_grade_submissions(id) ON DELETE CASCADE,
    CONSTRAINT FK_teacher_grade_submission_row_student FOREIGN KEY (student_id) REFERENCES students(id),
    CONSTRAINT FK_teacher_grade_submission_row_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
    CONSTRAINT FK_teacher_grade_submission_row_assignment FOREIGN KEY (student_subject_id) REFERENCES student_subjects(id)
);

CREATE TABLE teacher_grade_submission_grades (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    submission_row_id BIGINT NOT NULL,
    grading_period NVARCHAR(50) NOT NULL,
    grade_value DECIMAL(6,2) NOT NULL CHECK (grade_value BETWEEN 0 AND 100),
    existing_grade_id INT NULL,
    existing_grade_value DECIMAL(6,2) NULL,
    CONSTRAINT UQ_teacher_grade_submission_grade_period UNIQUE (submission_row_id, grading_period),
    CONSTRAINT FK_teacher_grade_submission_grade_row FOREIGN KEY (submission_row_id)
        REFERENCES teacher_grade_submission_rows(id) ON DELETE CASCADE,
    CONSTRAINT FK_teacher_grade_submission_grade_existing FOREIGN KEY (existing_grade_id) REFERENCES grades(id)
);

CREATE TABLE teacher_grade_submission_events (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    submission_id UNIQUEIDENTIFIER NOT NULL,
    actor_id INT NOT NULL,
    event_type NVARCHAR(40) NOT NULL
        CHECK (event_type IN (N'submitted', N'revision_submitted', N'approved', N'correction_requested', N'rejected')),
    reason NVARCHAR(500) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_teacher_grade_submission_event_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_teacher_grade_submission_event_submission FOREIGN KEY (submission_id)
        REFERENCES teacher_grade_submissions(id),
    CONSTRAINT FK_teacher_grade_submission_event_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IX_teacher_grade_submission_event_history
    ON teacher_grade_submission_events (submission_id, created_at, id);
GO

CREATE TABLE password_reset_tokens (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at DATETIME2 NOT NULL,
    attempt_count INT NOT NULL CONSTRAINT DF_password_reset_attempt_count DEFAULT 0,
    consumed_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_password_reset_created_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_password_reset_attempt_count CHECK (attempt_count >= 0),
    CONSTRAINT FK_password_reset_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX UX_password_reset_token_hash ON password_reset_tokens (token_hash);
CREATE UNIQUE INDEX UX_password_reset_active_user ON password_reset_tokens (user_id) WHERE consumed_at IS NULL;

CREATE TABLE pending_email_changes (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    user_id INT NOT NULL,
    new_email NVARCHAR(255) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at DATETIME2 NOT NULL,
    attempt_count INT NOT NULL CONSTRAINT DF_pending_email_change_attempt_count DEFAULT 0,
    consumed_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_pending_email_change_created_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_pending_email_change_attempt_count CHECK (attempt_count >= 0),
    CONSTRAINT FK_pending_email_change_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX UX_pending_email_change_token_hash ON pending_email_changes (token_hash);
CREATE UNIQUE INDEX UX_pending_email_change_active_user ON pending_email_changes (user_id) WHERE consumed_at IS NULL;
CREATE INDEX IX_pending_email_change_email_expiry
    ON pending_email_changes (new_email, expires_at) WHERE consumed_at IS NULL;
GO

CREATE TABLE enrollment_clearances (
    enrollment_id INT NOT NULL PRIMARY KEY,
    clearance_status NVARCHAR(20) NOT NULL CONSTRAINT DF_enrollment_clearance_status DEFAULT N'pending',
    payment_transaction_id INT NULL,
    cleared_by INT NULL,
    cleared_at DATETIME2 NULL,
    created_by INT NOT NULL,
    created_for_intake BIT NOT NULL CONSTRAINT DF_enrollment_clearance_created_for_intake DEFAULT 0,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_enrollment_clearance_created_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_enrollment_clearance_status CHECK (
        (clearance_status = N'pending' AND payment_transaction_id IS NULL AND cleared_by IS NULL AND cleared_at IS NULL)
        OR (clearance_status = N'cleared' AND payment_transaction_id IS NOT NULL AND cleared_by IS NOT NULL AND cleared_at IS NOT NULL)),
    CONSTRAINT FK_enrollment_clearance_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
    CONSTRAINT FK_enrollment_clearance_payment FOREIGN KEY (payment_transaction_id) REFERENCES financial_transactions(id),
    CONSTRAINT FK_enrollment_clearance_cleared_by FOREIGN KEY (cleared_by) REFERENCES users(id),
    CONSTRAINT FK_enrollment_clearance_created_by FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE UNIQUE INDEX UX_enrollment_clearance_payment ON enrollment_clearances (payment_transaction_id)
    WHERE payment_transaction_id IS NOT NULL;
CREATE INDEX IX_enrollment_clearance_pending ON enrollment_clearances (clearance_status, enrollment_id)
    INCLUDE (created_at);
GO

CREATE TABLE class_schedules (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    assignment_id INT NOT NULL,
    day_of_week TINYINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 6),
    start_time TIME(0) NOT NULL,
    end_time TIME(0) NOT NULL,
    room NVARCHAR(80) NULL,
    created_by INT NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_class_schedule_time CHECK (start_time < end_time),
    CONSTRAINT FK_class_schedule_assignment FOREIGN KEY (assignment_id) REFERENCES teacher_assignments(id),
    CONSTRAINT FK_class_schedule_creator FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE UNIQUE INDEX UX_class_schedule_assignment_day_start
    ON class_schedules (assignment_id, day_of_week, start_time);
CREATE INDEX IX_class_schedule_day_time
    ON class_schedules (day_of_week, start_time, end_time, assignment_id);
GO

CREATE TRIGGER TR_students_require_lrn_on_insert
ON students
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM inserted WHERE lrn IS NULL)
        THROW 51007, 'A learner reference number is required for new student records.', 1;
END;
GO

INSERT INTO schema_migrations (version) VALUES ('v2.001');
GO
