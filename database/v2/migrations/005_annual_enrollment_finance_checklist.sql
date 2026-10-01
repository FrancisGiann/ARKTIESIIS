/* Annual enrollment, allocated finance ledger, term decisions, and student physical checklist. */

IF COL_LENGTH(N'dbo.sections', N'cluster') IS NULL
  ALTER TABLE dbo.sections ADD cluster NVARCHAR(80) NULL;
IF COL_LENGTH(N'dbo.sections', N'strand') IS NULL
  ALTER TABLE dbo.sections ADD strand NVARCHAR(80) NULL;
IF COL_LENGTH(N'dbo.sections', N'adviser') IS NULL
  ALTER TABLE dbo.sections ADD adviser NVARCHAR(160) NULL;
IF COL_LENGTH(N'dbo.sections', N'modality') IS NULL
  ALTER TABLE dbo.sections ADD modality NVARCHAR(30) NULL;
IF COL_LENGTH(N'dbo.sections', N'modular_subtype') IS NULL
  ALTER TABLE dbo.sections ADD modular_subtype NVARCHAR(80) NULL;
GO

CREATE TABLE dbo.annual_enrollments (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  student_id INT NOT NULL,
  school_year NVARCHAR(20) NOT NULL,
  grade_level NVARCHAR(50) NOT NULL,
  voucher_code NVARCHAR(10) NULL CHECK (voucher_code IS NULL OR voucher_code IN (N'PUB', N'ESC', N'NV')),
  voucher_category NCHAR(1) NULL CHECK (voucher_category IS NULL OR voucher_category IN (N'A', N'B', N'C', N'D', N'E')),
  intake_status NVARCHAR(20) NOT NULL CONSTRAINT DF_annual_enrollment_status DEFAULT N'pending'
    CHECK (intake_status IN (N'pending', N'enrolled', N'cancelled', N'dropped', N'transferred', N'legacy')),
  account_activation_pending BIT NOT NULL CONSTRAINT DF_annual_enrollment_activation_pending DEFAULT 0,
  created_by INT NULL,
  idempotency_key UNIQUEIDENTIFIER NULL,
  request_fingerprint CHAR(64) NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_annual_enrollment_created_at DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL CONSTRAINT DF_annual_enrollment_updated_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_annual_enrollment_student_year UNIQUE (student_id, school_year),
  CONSTRAINT FK_annual_enrollment_student FOREIGN KEY (student_id) REFERENCES dbo.students(id),
  CONSTRAINT FK_annual_enrollment_creator FOREIGN KEY (created_by) REFERENCES dbo.users(id)
);
GO

ALTER TABLE dbo.enrollments ADD annual_enrollment_id INT NULL;
ALTER TABLE dbo.enrollments ADD CONSTRAINT FK_enrollment_annual_enrollment
  FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id);
CREATE INDEX IX_enrollments_annual_parent ON dbo.enrollments (annual_enrollment_id, academic_term_id, id)
  INCLUDE (student_id, enrollment_status, section_id, finalized_at);
ALTER TABLE dbo.enrollments ADD annual_term_number TINYINT NULL;
GO
ALTER TABLE dbo.enrollments ADD CONSTRAINT CK_enrollment_annual_term_number CHECK (annual_term_number IS NULL OR annual_term_number BETWEEN 1 AND 3);
CREATE UNIQUE INDEX UX_enrollment_annual_term_number ON dbo.enrollments (annual_enrollment_id, annual_term_number)
  WHERE annual_enrollment_id IS NOT NULL AND annual_term_number IS NOT NULL;
CREATE UNIQUE INDEX UX_annual_enrollment_idempotency ON dbo.annual_enrollments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
ALTER TABLE dbo.enrollment_clearances ADD account_activation_pending BIT NOT NULL
  CONSTRAINT DF_enrollment_clearance_activation_pending DEFAULT 0;
/* Existing intakes require explicit registrar review before any first activation is authorized. */
GO

/* Group existing placements by their original school year without changing their term labels or IDs. */
INSERT INTO dbo.annual_enrollments (student_id, school_year, grade_level, voucher_code, intake_status, account_activation_pending)
SELECT enrollment.student_id, term.school_year, N'Unattributed (legacy)', NULL, N'legacy', 0
FROM dbo.enrollments AS enrollment
INNER JOIN dbo.academic_terms AS term ON term.id = enrollment.academic_term_id
GROUP BY enrollment.student_id, term.school_year;

UPDATE enrollment
SET annual_enrollment_id = annual.id
FROM dbo.enrollments AS enrollment
INNER JOIN dbo.academic_terms AS term ON term.id = enrollment.academic_term_id
INNER JOIN dbo.annual_enrollments AS annual
  ON annual.student_id = enrollment.student_id AND annual.school_year = term.school_year;

IF COL_LENGTH(N'dbo.financial_transactions', N'is_legacy_unattributed') IS NULL
  ALTER TABLE dbo.financial_transactions ADD is_legacy_unattributed BIT NOT NULL
    CONSTRAINT DF_financial_transaction_legacy_unattributed DEFAULT (1);
GO

CREATE TABLE dbo.annual_enrollment_events (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  enrollment_id INT NULL,
  actor_id INT NOT NULL,
  event_type NVARCHAR(40) NOT NULL CHECK (event_type IN (N'created', N'term_cancelled', N'term_dropped', N'term_transferred', N'term_placement_changed', N'voucher_review_flagged', N'voucher_review_resolved')),
  reason NVARCHAR(1000) NULL,
  idempotency_key UNIQUEIDENTIFIER NULL,
  request_fingerprint CHAR(64) NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_annual_enrollment_event_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_annual_enrollment_event_parent FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id),
  CONSTRAINT FK_annual_enrollment_event_term FOREIGN KEY (enrollment_id) REFERENCES dbo.enrollments(id),
  CONSTRAINT FK_annual_enrollment_event_actor FOREIGN KEY (actor_id) REFERENCES dbo.users(id)
);
CREATE INDEX IX_annual_enrollment_event_history ON dbo.annual_enrollment_events (annual_enrollment_id, created_at, id);
CREATE UNIQUE INDEX UX_annual_enrollment_event_idempotency ON dbo.annual_enrollment_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
GO

CREATE TABLE dbo.finance_schedules (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  school_year NVARCHAR(20) NOT NULL,
  grade_level NVARCHAR(50) NOT NULL,
  voucher_code NVARCHAR(10) NOT NULL CHECK (voucher_code IN (N'PUB', N'ESC', N'NV')),
  version_no INT NOT NULL CHECK (version_no > 0),
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_finance_schedule_status DEFAULT N'active'
    CHECK (status IN (N'active', N'retired')),
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_schedule_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_schedule_version UNIQUE (school_year, grade_level, voucher_code, version_no),
  CONSTRAINT UQ_finance_schedule_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_schedule_creator FOREIGN KEY (created_by) REFERENCES dbo.users(id)
);
CREATE UNIQUE INDEX UX_finance_schedule_active ON dbo.finance_schedules (school_year, grade_level, voucher_code)
  WHERE status = N'active';

CREATE TABLE dbo.finance_schedule_lines (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  schedule_id INT NOT NULL,
  term_number TINYINT NOT NULL CHECK (term_number BETWEEN 1 AND 3),
  fee_category NVARCHAR(40) NOT NULL CHECK (fee_category IN (N'tuition', N'miscellaneous', N'uniform', N'id', N'activity', N'retake', N'other')),
  line_name NVARCHAR(120) NOT NULL,
  installment NVARCHAR(40) NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount >= 0),
  is_optional BIT NOT NULL CONSTRAINT DF_finance_schedule_line_optional DEFAULT 0,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_schedule_line_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_finance_schedule_line_schedule FOREIGN KEY (schedule_id) REFERENCES dbo.finance_schedules(id)
);
CREATE INDEX IX_finance_schedule_lines_schedule ON dbo.finance_schedule_lines (schedule_id, term_number, id);
GO

CREATE TABLE dbo.annual_assessments (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  schedule_id INT NOT NULL,
  schedule_version INT NOT NULL,
  voucher_code_snapshot NVARCHAR(10) NOT NULL CHECK (voucher_code_snapshot IN (N'PUB', N'ESC', N'NV')),
  assessed_by INT NOT NULL,
  assessed_at DATETIME2 NOT NULL CONSTRAINT DF_annual_assessment_created_at DEFAULT SYSUTCDATETIME(),
  selection_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(selection_json) = 1),
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  CONSTRAINT UQ_annual_assessment_parent UNIQUE (annual_enrollment_id),
  CONSTRAINT UQ_annual_assessment_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_annual_assessment_parent FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id),
  CONSTRAINT FK_annual_assessment_schedule FOREIGN KEY (schedule_id) REFERENCES dbo.finance_schedules(id),
  CONSTRAINT FK_annual_assessment_actor FOREIGN KEY (assessed_by) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.assessed_charges (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  assessment_id INT NOT NULL,
  annual_enrollment_id INT NOT NULL,
  enrollment_id INT NOT NULL,
  schedule_line_id INT NULL,
  fee_category NVARCHAR(40) NOT NULL,
  line_name NVARCHAR(120) NOT NULL,
  installment NVARCHAR(40) NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount >= 0),
  is_manual BIT NOT NULL CONSTRAINT DF_assessed_charge_manual DEFAULT 0,
  reason NVARCHAR(1000) NULL,
  idempotency_key UNIQUEIDENTIFIER NULL,
  request_fingerprint CHAR(64) NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_assessed_charge_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_assessed_charge_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.annual_assessments(id),
  CONSTRAINT FK_assessed_charge_parent FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id),
  CONSTRAINT FK_assessed_charge_term FOREIGN KEY (enrollment_id) REFERENCES dbo.enrollments(id),
  CONSTRAINT FK_assessed_charge_line FOREIGN KEY (schedule_line_id) REFERENCES dbo.finance_schedule_lines(id)
);
CREATE UNIQUE INDEX UX_assessed_charge_idempotency ON dbo.assessed_charges (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IX_assessed_charge_parent_term ON dbo.assessed_charges (annual_enrollment_id, enrollment_id, id)
  INCLUDE (amount, fee_category, line_name, installment);
GO

CREATE TABLE dbo.finance_charge_adjustments (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  charge_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount <> 0),
  reason NVARCHAR(1000) NOT NULL,
  reverses_adjustment_id BIGINT NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_charge_adjustment_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_charge_adjustment_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_charge_adjustment_charge FOREIGN KEY (charge_id) REFERENCES dbo.assessed_charges(id),
  CONSTRAINT FK_finance_charge_adjustment_reverse FOREIGN KEY (reverses_adjustment_id) REFERENCES dbo.finance_charge_adjustments(id),
  CONSTRAINT FK_finance_charge_adjustment_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);
CREATE UNIQUE INDEX UX_finance_charge_adjustment_reversal ON dbo.finance_charge_adjustments (reverses_adjustment_id)
  WHERE reverses_adjustment_id IS NOT NULL;

CREATE TABLE dbo.finance_payments (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  student_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL,
  reference_no NVARCHAR(100) NULL,
  receipt_issued BIT NOT NULL CONSTRAINT DF_finance_payment_receipt_issued DEFAULT 0,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_payment_created_at DEFAULT SYSUTCDATETIME(),
  is_reversed BIT NOT NULL CONSTRAINT DF_finance_payment_reversed DEFAULT 0,
  reverses_payment_id BIGINT NULL,
  CONSTRAINT UQ_finance_payment_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_payment_student FOREIGN KEY (student_id) REFERENCES dbo.students(id),
  CONSTRAINT FK_finance_payment_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id),
  CONSTRAINT FK_finance_payment_reverse FOREIGN KEY (reverses_payment_id) REFERENCES dbo.finance_payments(id)
);
CREATE INDEX IX_finance_payment_student_date ON dbo.finance_payments (student_id, payment_date, id);

CREATE TABLE dbo.finance_allocation_batches (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  payment_id BIGINT NOT NULL,
  student_id INT NOT NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  allocated_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_allocation_batch_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_allocation_batch_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_allocation_batch_payment FOREIGN KEY (payment_id) REFERENCES dbo.finance_payments(id),
  CONSTRAINT FK_finance_allocation_batch_student FOREIGN KEY (student_id) REFERENCES dbo.students(id),
  CONSTRAINT FK_finance_allocation_batch_actor FOREIGN KEY (allocated_by) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.finance_payment_allocations (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  payment_id BIGINT NOT NULL,
  charge_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  allocation_batch_id BIGINT NOT NULL,
  allocated_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_allocation_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_finance_allocation_payment FOREIGN KEY (payment_id) REFERENCES dbo.finance_payments(id),
  CONSTRAINT FK_finance_allocation_charge FOREIGN KEY (charge_id) REFERENCES dbo.assessed_charges(id),
  CONSTRAINT FK_finance_allocation_batch FOREIGN KEY (allocation_batch_id) REFERENCES dbo.finance_allocation_batches(id),
  CONSTRAINT FK_finance_allocation_actor FOREIGN KEY (allocated_by) REFERENCES dbo.users(id)
);
CREATE INDEX IX_finance_allocation_payment ON dbo.finance_payment_allocations (payment_id, id);
CREATE INDEX IX_finance_allocation_charge ON dbo.finance_payment_allocations (charge_id, id);
GO

CREATE TABLE dbo.finance_legacy_reconciliation_batches (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  transaction_id INT NOT NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_legacy_reconciliation_batch_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_legacy_reconciliation_batch_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_legacy_reconciliation_batch_transaction FOREIGN KEY (transaction_id) REFERENCES dbo.financial_transactions(id),
  CONSTRAINT FK_finance_legacy_reconciliation_batch_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.finance_legacy_reconciliations (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  transaction_id INT NOT NULL,
  charge_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  reason NVARCHAR(1000) NOT NULL,
  batch_id BIGINT NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_legacy_reconciliation_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_finance_legacy_reconciliation_transaction FOREIGN KEY (transaction_id) REFERENCES dbo.financial_transactions(id),
  CONSTRAINT FK_finance_legacy_reconciliation_batch FOREIGN KEY (batch_id) REFERENCES dbo.finance_legacy_reconciliation_batches(id),
  CONSTRAINT FK_finance_legacy_reconciliation_charge FOREIGN KEY (charge_id) REFERENCES dbo.assessed_charges(id),
  CONSTRAINT FK_finance_legacy_reconciliation_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);
CREATE INDEX IX_finance_legacy_reconciliation_transaction ON dbo.finance_legacy_reconciliations (transaction_id, id);
GO

CREATE TABLE dbo.finance_payment_reversals (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  payment_id BIGINT NOT NULL,
  reason NVARCHAR(1000) NOT NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_payment_reversal_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_payment_reversal_payment UNIQUE (payment_id),
  CONSTRAINT UQ_finance_payment_reversal_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_payment_reversal_payment FOREIGN KEY (payment_id) REFERENCES dbo.finance_payments(id),
  CONSTRAINT FK_finance_payment_reversal_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);
GO

CREATE TABLE dbo.term_finance_approvals (
  enrollment_id INT NOT NULL PRIMARY KEY,
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_term_finance_approval_status DEFAULT N'pending'
    CHECK (status IN (N'pending', N'approved')),
  approved_by INT NULL,
  approved_at DATETIME2 NULL,
  approval_reason NVARCHAR(1000) NULL,
  finance_review_required BIT NOT NULL CONSTRAINT DF_term_finance_review_required DEFAULT 0,
  finance_review_reason NVARCHAR(1000) NULL,
  finance_review_requested_by INT NULL,
  finance_review_requested_at DATETIME2 NULL,
  CONSTRAINT FK_term_finance_approval_enrollment FOREIGN KEY (enrollment_id) REFERENCES dbo.enrollments(id),
  CONSTRAINT FK_term_finance_approval_actor FOREIGN KEY (approved_by) REFERENCES dbo.users(id),
  CONSTRAINT FK_term_finance_review_actor FOREIGN KEY (finance_review_requested_by) REFERENCES dbo.users(id),
  CONSTRAINT CK_term_finance_approval_state CHECK (
    (status = N'pending' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status = N'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE TABLE dbo.term_clearance_events (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  enrollment_id INT NOT NULL,
  event_type NVARCHAR(20) NOT NULL CHECK (event_type IN (N'signed', N'revoked')),
  reason NVARCHAR(1000) NULL,
  arrangement NVARCHAR(1000) NULL,
  finance_note NVARCHAR(2000) NULL,
  idempotency_key UNIQUEIDENTIFIER NULL,
  request_fingerprint CHAR(64) NULL,
  outstanding_snapshot DECIMAL(12,2) NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_term_clearance_event_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_term_clearance_event_enrollment FOREIGN KEY (enrollment_id) REFERENCES dbo.enrollments(id),
  CONSTRAINT FK_term_clearance_event_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id),
  CONSTRAINT CK_term_clearance_event_signed_reason CHECK (event_type <> N'signed' OR (reason IS NOT NULL AND LEN(LTRIM(RTRIM(reason))) > 0))
);
CREATE UNIQUE INDEX UX_term_clearance_event_idempotency ON dbo.term_clearance_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IX_term_clearance_event_history ON dbo.term_clearance_events (enrollment_id, created_at, id);
GO

CREATE TABLE dbo.student_physical_checklist_events (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  student_id INT NOT NULL,
  requirement_code NVARCHAR(60) NOT NULL,
  requirement_name NVARCHAR(120) NOT NULL,
  status NVARCHAR(30) NOT NULL CHECK (status IN (N'pending', N'received', N'verified', N'correction', N'rejected')),
  note NVARCHAR(1000) NULL,
  is_applicable BIT NOT NULL CONSTRAINT DF_student_physical_checklist_applicable DEFAULT 1,
  originals_received TINYINT NOT NULL CONSTRAINT DF_student_physical_checklist_originals DEFAULT 0 CHECK (originals_received <= 20),
  copies_received TINYINT NOT NULL CONSTRAINT DF_student_physical_checklist_copies DEFAULT 0 CHECK (copies_received <= 50),
  pieces_received TINYINT NOT NULL CONSTRAINT DF_student_physical_checklist_pieces DEFAULT 0 CHECK (pieces_received <= 50),
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_student_physical_checklist_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_student_physical_checklist_student FOREIGN KEY (student_id) REFERENCES dbo.students(id),
  CONSTRAINT FK_student_physical_checklist_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id),
  CONSTRAINT UQ_student_physical_checklist_idempotency UNIQUE (idempotency_key),
  CONSTRAINT CK_student_physical_checklist_correction_note CHECK (status <> N'correction' OR (note IS NOT NULL AND LEN(LTRIM(RTRIM(note))) > 0))
);
CREATE INDEX IX_student_physical_checklist_history ON dbo.student_physical_checklist_events (student_id, requirement_code, created_at DESC, id DESC);
GO

CREATE TABLE dbo.physical_requirement_definitions (
  requirement_code NVARCHAR(60) NOT NULL PRIMARY KEY,
  requirement_name NVARCHAR(120) NOT NULL,
  guidance NVARCHAR(500) NOT NULL,
  applicability NVARCHAR(20) NOT NULL CHECK (applicability IN (N'all', N'als', N'esc', N'optional', N'grade11', N'grade12', N'staff')),
  originals_required TINYINT NOT NULL DEFAULT 0 CHECK (originals_required <= 20),
  copies_required TINYINT NOT NULL DEFAULT 0 CHECK (copies_required <= 50),
  pieces_required TINYINT NOT NULL DEFAULT 0 CHECK (pieces_required <= 50),
  is_optional BIT NOT NULL DEFAULT 0,
  display_order TINYINT NOT NULL
);

INSERT INTO dbo.physical_requirement_definitions
  (requirement_code, requirement_name, guidance, applicability, originals_required, copies_required, pieces_required, is_optional, display_order)
VALUES
  (N'birth_certificate', N'Birth Certificate (PSA / NSO / OLD)', N'3 photocopies.', N'all', 0, 3, 0, 0, 1),
  (N'jhs_report_card', N'Report Card (Grade-10 / ALS-AF5)', N'Original + 1 photocopy. Use the Grade-10 or ALS-AF5 description as applicable; applies to Grade 11 learners.', N'grade11', 1, 1, 0, 0, 2),
  (N'grade11_card', N'Grade 11 Card', N'Grade 11 card applies to Grade 12 learners.', N'grade12', 0, 0, 0, 0, 3),
  (N'good_moral', N'Good Moral Certificate', N'Original + 1 photocopy.', N'all', 1, 1, 0, 0, 4),
  (N'jhs_certificate', N'Junior High School Certificate', N'2 photocopies.', N'all', 0, 2, 0, 0, 5),
  (N'als_certificate_of_rating', N'Certificate of Rating (ALS)', N'Original + 1 photocopy. Mark not applicable when the learner is not an ALS learner.', N'als', 1, 1, 0, 0, 6),
  (N'esc_certificate', N'ESC Certificate (Private School)', N'Original + 1 photocopy. Mark not applicable when this requirement does not apply.', N'esc', 1, 1, 0, 0, 7),
  (N'national_id', N'National ID (if you have)', N'1 photocopy; optional.', N'optional', 0, 1, 0, 1, 8),
  (N'two_by_two_photo', N'2x2 Picture with name tag & white background', N'3 pieces.', N'all', 0, 0, 3, 0, 9),
  (N'long_brown_envelopes', N'Long Brown Envelopes', N'2 pieces.', N'all', 0, 0, 2, 0, 10),
  (N'sf10_form137', N'SF10 / Form 137', N'Staff-only physical record; reuses the existing Form 137 status history.', N'staff', 0, 0, 0, 0, 11);
GO

CREATE TABLE dbo.finance_transaction_reversals (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  transaction_id INT NOT NULL,
  reason NVARCHAR(1000) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_transaction_reversal_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_transaction_reversal UNIQUE (transaction_id),
  CONSTRAINT FK_finance_transaction_reversal_transaction FOREIGN KEY (transaction_id) REFERENCES dbo.financial_transactions(id),
  CONSTRAINT FK_finance_transaction_reversal_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);
GO
