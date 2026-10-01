/* Configurable annual term order, midyear entry, reviewed finance cases, and reporting. */

ALTER TABLE dbo.annual_enrollments ADD intake_kind NVARCHAR(20) NOT NULL
  CONSTRAINT DF_annual_enrollment_intake_kind DEFAULT N'unspecified' WITH VALUES;
GO
ALTER TABLE dbo.annual_enrollments ADD CONSTRAINT CK_annual_enrollment_intake_kind
  CHECK (intake_kind IN (N'new', N'returning', N'transferee', N'unspecified'));
ALTER TABLE dbo.annual_enrollments ADD entry_term_number TINYINT NULL;
GO
ALTER TABLE dbo.annual_enrollments ADD CONSTRAINT CK_annual_enrollment_entry_term
  CHECK (entry_term_number IS NULL OR entry_term_number BETWEEN 1 AND 3);
ALTER TABLE dbo.annual_enrollments ADD enrollment_start_date DATE NULL;
ALTER TABLE dbo.enrollments ADD term_scope_status NVARCHAR(20) NOT NULL
  CONSTRAINT DF_enrollment_term_scope DEFAULT N'applicable' WITH VALUES;
GO
ALTER TABLE dbo.enrollments ADD CONSTRAINT CK_enrollment_term_scope
  CHECK (term_scope_status IN (N'applicable', N'not_applicable'));
GO

CREATE TABLE dbo.school_year_term_order (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  school_year NVARCHAR(20) NOT NULL,
  term_number TINYINT NOT NULL CHECK (term_number BETWEEN 1 AND 3),
  academic_term_id INT NOT NULL UNIQUE,
  configured_by INT NULL,
  configuration_source NVARCHAR(40) NOT NULL CONSTRAINT DF_school_year_term_order_source DEFAULT N'staff'
    CHECK (configuration_source IN (N'staff', N'explicit_v2_005_backfill')),
  configured_at DATETIME2 NOT NULL CONSTRAINT DF_school_year_term_order_configured_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_school_year_term_order_year_number UNIQUE (school_year, term_number),
  CONSTRAINT FK_school_year_term_order_term FOREIGN KEY (academic_term_id) REFERENCES dbo.academic_terms(id),
  CONSTRAINT FK_school_year_term_order_actor FOREIGN KEY (configured_by) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.school_year_term_order_reviews (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  school_year NVARCHAR(20) NOT NULL,
  academic_term_id INT NOT NULL,
  review_reason NVARCHAR(500) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_school_year_term_order_review_created_at DEFAULT SYSUTCDATETIME(),
  resolved_by INT NULL,
  resolved_at DATETIME2 NULL,
  CONSTRAINT UQ_school_year_term_order_review_term UNIQUE (academic_term_id),
  CONSTRAINT FK_school_year_term_order_review_term FOREIGN KEY (academic_term_id) REFERENCES dbo.academic_terms(id),
  CONSTRAINT FK_school_year_term_order_review_actor FOREIGN KEY (resolved_by) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.annual_workflow_events (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  enrollment_id INT NULL,
  actor_id INT NOT NULL,
  event_type NVARCHAR(40) NOT NULL CHECK (event_type IN (
    N'term_order_configured', N'enrollment_tag_recorded', N'special_subject_recorded',
    N'departure_recorded', N'departure_finance_reviewed')),
  reason NVARCHAR(1000) NULL,
  idempotency_key UNIQUEIDENTIFIER NULL,
  request_fingerprint CHAR(64) NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_annual_workflow_event_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_annual_workflow_event_parent FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id),
  CONSTRAINT FK_annual_workflow_event_term FOREIGN KEY (enrollment_id) REFERENCES dbo.enrollments(id),
  CONSTRAINT FK_annual_workflow_event_actor FOREIGN KEY (actor_id) REFERENCES dbo.users(id)
);
CREATE UNIQUE INDEX UX_annual_workflow_event_idempotency ON dbo.annual_workflow_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IX_annual_workflow_event_history ON dbo.annual_workflow_events (annual_enrollment_id, created_at, id);

/* Backfill only associations already stored explicitly on v2.005 annual placements. */
WITH term_candidates AS (
  SELECT term.school_year, term.id AS academic_term_id,
    MIN(enrollment.annual_term_number) AS term_number,
    COUNT(DISTINCT enrollment.annual_term_number) AS assigned_numbers
  FROM dbo.enrollments AS enrollment
  INNER JOIN dbo.academic_terms AS term ON term.id = enrollment.academic_term_id
  INNER JOIN dbo.annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
  WHERE annual.intake_status <> N'legacy' AND enrollment.annual_term_number IS NOT NULL
  GROUP BY term.school_year, term.id
), unique_year_number AS (
  SELECT school_year, term_number, MIN(academic_term_id) AS academic_term_id
  FROM term_candidates
  GROUP BY school_year, term_number
  HAVING COUNT(*) = 1 AND MIN(assigned_numbers) = 1
)
INSERT INTO dbo.school_year_term_order (school_year, term_number, academic_term_id, configured_by, configuration_source)
SELECT candidate.school_year, candidate.term_number, candidate.academic_term_id, NULL, N'explicit_v2_005_backfill'
FROM term_candidates AS candidate
INNER JOIN unique_year_number AS mapped
  ON mapped.school_year = candidate.school_year AND mapped.term_number = candidate.term_number
  AND mapped.academic_term_id = candidate.academic_term_id
WHERE candidate.assigned_numbers = 1;

WITH term_candidates AS (
  SELECT term.school_year, term.id AS academic_term_id,
    MIN(enrollment.annual_term_number) AS term_number,
    COUNT(DISTINCT enrollment.annual_term_number) AS assigned_numbers
  FROM dbo.enrollments AS enrollment
  INNER JOIN dbo.academic_terms AS term ON term.id = enrollment.academic_term_id
  INNER JOIN dbo.annual_enrollments AS annual ON annual.id = enrollment.annual_enrollment_id
  WHERE annual.intake_status <> N'legacy' AND enrollment.annual_term_number IS NOT NULL
  GROUP BY term.school_year, term.id
)
INSERT INTO dbo.school_year_term_order_reviews (school_year, academic_term_id, review_reason)
SELECT candidate.school_year, candidate.academic_term_id,
  N'Existing annual placements contain conflicting explicit term numbers. Review and map this academic term before using it for new annual intake.'
FROM term_candidates AS candidate
WHERE candidate.assigned_numbers > 1
   OR EXISTS (
      SELECT 1 FROM term_candidates AS other
      WHERE other.school_year = candidate.school_year
        AND other.term_number = candidate.term_number
        AND other.academic_term_id <> candidate.academic_term_id
        AND other.assigned_numbers = 1
   );
GO

CREATE TABLE dbo.annual_enrollment_tags (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  tag_type NVARCHAR(30) NOT NULL CHECK (tag_type IN (N'internal', N'athlete', N'performer', N'named_arrangement')),
  label NVARCHAR(120) NOT NULL,
  note NVARCHAR(500) NULL,
  effective_term_from TINYINT NULL,
  effective_term_to TINYINT NULL,
  recorded_by INT NOT NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_annual_enrollment_tag_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_annual_enrollment_tag_key UNIQUE (idempotency_key),
  CONSTRAINT CK_annual_enrollment_tag_term_scope CHECK (
    (effective_term_from IS NULL AND effective_term_to IS NULL) OR
    (effective_term_from BETWEEN 1 AND 3 AND effective_term_to BETWEEN effective_term_from AND 3)),
  CONSTRAINT FK_annual_enrollment_tag_parent FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id),
  CONSTRAINT FK_annual_enrollment_tag_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);
CREATE INDEX IX_annual_enrollment_tags_parent ON dbo.annual_enrollment_tags (annual_enrollment_id, created_at, id);

CREATE TABLE dbo.annual_special_subjects (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  enrollment_id INT NOT NULL,
  student_id INT NOT NULL,
  student_subject_id INT NOT NULL UNIQUE,
  arrangement_type NVARCHAR(30) NOT NULL CHECK (arrangement_type IN (N'internal', N'athlete', N'performer', N'modular', N'other')),
  modular_subtype NVARCHAR(80) NULL,
  prepaid_arrangement_note NVARCHAR(500) NULL,
  recorded_by INT NOT NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_annual_special_subject_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_annual_special_subject_key UNIQUE (idempotency_key),
  CONSTRAINT FK_annual_special_subject_parent FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id),
  CONSTRAINT FK_annual_special_subject_term FOREIGN KEY (enrollment_id) REFERENCES dbo.enrollments(id),
  CONSTRAINT FK_annual_special_subject_student FOREIGN KEY (student_id) REFERENCES dbo.students(id),
  CONSTRAINT FK_annual_special_subject_assignment FOREIGN KEY (student_subject_id) REFERENCES dbo.student_subjects(id),
  CONSTRAINT FK_annual_special_subject_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);
CREATE INDEX IX_annual_special_subject_parent ON dbo.annual_special_subjects (annual_enrollment_id, enrollment_id, id);

CREATE TABLE dbo.finance_exemption_cases (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL UNIQUE,
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_finance_exemption_case_status DEFAULT N'pending'
    CHECK (status IN (N'pending', N'approved', N'rejected')),
  requested_by INT NOT NULL,
  reviewed_by INT NULL,
  review_reason NVARCHAR(1000) NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_exemption_case_created_at DEFAULT SYSUTCDATETIME(),
  reviewed_at DATETIME2 NULL,
  CONSTRAINT UQ_finance_exemption_case_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_exemption_case_parent FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id),
  CONSTRAINT FK_finance_exemption_case_requestor FOREIGN KEY (requested_by) REFERENCES dbo.users(id),
  CONSTRAINT FK_finance_exemption_case_reviewer FOREIGN KEY (reviewed_by) REFERENCES dbo.users(id)
);

CREATE TABLE dbo.finance_exemption_rules (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  exemption_case_id BIGINT NOT NULL,
  term_number TINYINT NOT NULL CHECK (term_number BETWEEN 1 AND 3),
  fee_category NVARCHAR(40) NULL,
  line_name NVARCHAR(120) NULL,
  is_full_coverage BIT NOT NULL CONSTRAINT DF_finance_exemption_rule_full_coverage DEFAULT 0,
  approved_amount DECIMAL(12,2) NOT NULL CHECK (approved_amount >= 0),
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_exemption_rule_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT CK_finance_exemption_rule_match CHECK (fee_category IS NOT NULL OR line_name IS NOT NULL),
  CONSTRAINT CK_finance_exemption_rule_amount CHECK (
    (is_full_coverage = 1 AND approved_amount = 0) OR (is_full_coverage = 0 AND approved_amount > 0)),
  CONSTRAINT FK_finance_exemption_rule_case FOREIGN KEY (exemption_case_id) REFERENCES dbo.finance_exemption_cases(id)
);

CREATE TABLE dbo.finance_exemption_applications (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  exemption_rule_id BIGINT NOT NULL,
  charge_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  applied_at DATETIME2 NOT NULL CONSTRAINT DF_finance_exemption_application_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_exemption_application_rule_charge UNIQUE (exemption_rule_id, charge_id),
  CONSTRAINT FK_finance_exemption_application_rule FOREIGN KEY (exemption_rule_id) REFERENCES dbo.finance_exemption_rules(id),
  CONSTRAINT FK_finance_exemption_application_charge FOREIGN KEY (charge_id) REFERENCES dbo.assessed_charges(id)
);

ALTER TABLE dbo.assessed_charges ADD gross_amount DECIMAL(12,2) NULL;
ALTER TABLE dbo.assessed_charges ADD waived_amount DECIMAL(12,2) NOT NULL
  CONSTRAINT DF_assessed_charge_waived_amount DEFAULT (0) WITH VALUES;
GO
UPDATE dbo.assessed_charges SET gross_amount = amount WHERE gross_amount IS NULL;
GO
ALTER TABLE dbo.assessed_charges ALTER COLUMN gross_amount DECIMAL(12,2) NOT NULL;
ALTER TABLE dbo.assessed_charges ADD special_subject_id BIGINT NULL;
GO
ALTER TABLE dbo.assessed_charges ADD CONSTRAINT FK_assessed_charge_special_subject
  FOREIGN KEY (special_subject_id) REFERENCES dbo.annual_special_subjects(id);
ALTER TABLE dbo.finance_charge_adjustments ADD exemption_application_id BIGINT NULL;
GO
ALTER TABLE dbo.finance_charge_adjustments ADD CONSTRAINT FK_finance_adjustment_exemption_application
  FOREIGN KEY (exemption_application_id) REFERENCES dbo.finance_exemption_applications(id);
CREATE UNIQUE INDEX UX_assessed_charge_special_subject ON dbo.assessed_charges (special_subject_id)
  WHERE special_subject_id IS NOT NULL;
CREATE UNIQUE INDEX UX_finance_adjustment_exemption_application ON dbo.finance_charge_adjustments (exemption_application_id)
  WHERE exemption_application_id IS NOT NULL;
GO

CREATE TABLE dbo.finance_departure_cases (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL UNIQUE,
  effective_enrollment_id INT NOT NULL,
  effective_date DATE NOT NULL,
  departure_type NVARCHAR(20) NOT NULL CHECK (departure_type IN (N'dropped', N'transferred')),
  reason NVARCHAR(1000) NOT NULL,
  finance_status NVARCHAR(20) NOT NULL CONSTRAINT DF_finance_departure_status DEFAULT N'pending'
    CHECK (finance_status IN (N'pending', N'reviewed')),
  recorded_by INT NOT NULL,
  reviewed_by INT NULL,
  review_reason NVARCHAR(1000) NULL,
  review_idempotency_key UNIQUEIDENTIFIER NULL,
  review_request_fingerprint CHAR(64) NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_departure_created_at DEFAULT SYSUTCDATETIME(),
  reviewed_at DATETIME2 NULL,
  CONSTRAINT UQ_finance_departure_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_departure_parent FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id),
  CONSTRAINT FK_finance_departure_effective_enrollment FOREIGN KEY (effective_enrollment_id) REFERENCES dbo.enrollments(id),
  CONSTRAINT FK_finance_departure_registrar FOREIGN KEY (recorded_by) REFERENCES dbo.users(id),
  CONSTRAINT FK_finance_departure_finance FOREIGN KEY (reviewed_by) REFERENCES dbo.users(id)
);
CREATE UNIQUE INDEX UX_finance_departure_review_key ON dbo.finance_departure_cases (review_idempotency_key)
  WHERE review_idempotency_key IS NOT NULL;

CREATE TABLE dbo.finance_departure_case_terms (
  departure_case_id BIGINT NOT NULL,
  enrollment_id INT NOT NULL,
  academic_activity_review_required BIT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_departure_term_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_finance_departure_case_terms PRIMARY KEY (departure_case_id, enrollment_id),
  CONSTRAINT FK_finance_departure_term_case FOREIGN KEY (departure_case_id) REFERENCES dbo.finance_departure_cases(id),
  CONSTRAINT FK_finance_departure_term_enrollment FOREIGN KEY (enrollment_id) REFERENCES dbo.enrollments(id)
);

ALTER TABLE dbo.finance_charge_adjustments ADD departure_case_id BIGINT NULL;
ALTER TABLE dbo.finance_charge_adjustments ADD CONSTRAINT FK_finance_adjustment_departure_case
  FOREIGN KEY (departure_case_id) REFERENCES dbo.finance_departure_cases(id);

ALTER TABLE dbo.finance_payments ADD transmittal_reference NVARCHAR(100) NULL;
ALTER TABLE dbo.finance_payments ADD private_remarks NVARCHAR(1000) NULL;

CREATE TABLE dbo.finance_payment_metadata_events (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  payment_id BIGINT NOT NULL,
  event_type NVARCHAR(30) NOT NULL CHECK (event_type IN (N'receipt_reference_updated', N'receipt_marked_issued', N'private_remark_added')),
  reference_no NVARCHAR(100) NULL,
  private_remark NVARCHAR(1000) NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_payment_metadata_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_payment_metadata_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_payment_metadata_payment FOREIGN KEY (payment_id) REFERENCES dbo.finance_payments(id),
  CONSTRAINT FK_finance_payment_metadata_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);
CREATE INDEX IX_finance_payment_metadata_history ON dbo.finance_payment_metadata_events (payment_id, created_at, id);

CREATE TABLE dbo.finance_legacy_opening_charges (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  financial_account_id INT NOT NULL UNIQUE,
  student_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  source_label NVARCHAR(120) NOT NULL,
  reason NVARCHAR(1000) NOT NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_legacy_opening_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_legacy_opening_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_legacy_opening_account FOREIGN KEY (financial_account_id) REFERENCES dbo.financial_accounts(id),
  CONSTRAINT FK_finance_legacy_opening_student FOREIGN KEY (student_id) REFERENCES dbo.students(id),
  CONSTRAINT FK_finance_legacy_opening_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);
GO
ALTER TABLE dbo.finance_payment_allocations ALTER COLUMN charge_id BIGINT NULL;
ALTER TABLE dbo.finance_payment_allocations ADD legacy_opening_charge_id BIGINT NULL;
GO
ALTER TABLE dbo.finance_payment_allocations ADD CONSTRAINT CK_finance_payment_allocation_target
  CHECK ((charge_id IS NOT NULL AND legacy_opening_charge_id IS NULL) OR (charge_id IS NULL AND legacy_opening_charge_id IS NOT NULL));
GO
ALTER TABLE dbo.finance_payment_allocations ADD CONSTRAINT FK_finance_payment_allocation_legacy_opening
  FOREIGN KEY (legacy_opening_charge_id) REFERENCES dbo.finance_legacy_opening_charges(id);

CREATE TABLE dbo.finance_payment_allocation_releases (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  allocation_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  reason NVARCHAR(1000) NOT NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_payment_allocation_release_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_payment_allocation_release_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_payment_allocation_release_allocation FOREIGN KEY (allocation_id) REFERENCES dbo.finance_payment_allocations(id),
  CONSTRAINT FK_finance_payment_allocation_release_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);
CREATE INDEX IX_finance_payment_allocation_release_origin ON dbo.finance_payment_allocation_releases (allocation_id, id);

CREATE TABLE dbo.finance_legacy_reconciliation_releases (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  reconciliation_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  reason NVARCHAR(1000) NOT NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_legacy_reconciliation_release_created_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_finance_legacy_reconciliation_release_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_legacy_reconciliation_release_source FOREIGN KEY (reconciliation_id) REFERENCES dbo.finance_legacy_reconciliations(id),
  CONSTRAINT FK_finance_legacy_reconciliation_release_actor FOREIGN KEY (recorded_by) REFERENCES dbo.users(id)
);
CREATE INDEX IX_finance_legacy_reconciliation_release_origin ON dbo.finance_legacy_reconciliation_releases (reconciliation_id, id);
GO

/* Shared net projections keep append-only releases/reversals consistent across ledgers and reports. */
CREATE VIEW dbo.v_finance_net_payment_allocations AS
SELECT allocation.id AS allocation_id, allocation.payment_id, allocation.charge_id,
  allocation.legacy_opening_charge_id, allocation.allocation_batch_id, allocation.allocated_by,
  CAST(allocation.amount - COALESCE(released.amount, 0) AS DECIMAL(12,2)) AS net_amount
FROM dbo.finance_payment_allocations AS allocation
OUTER APPLY (SELECT SUM(release.amount) AS amount
  FROM dbo.finance_payment_allocation_releases AS release
  WHERE release.allocation_id = allocation.id) AS released;
GO

CREATE VIEW dbo.v_finance_net_legacy_reconciliations AS
SELECT reconciliation.id AS reconciliation_id, reconciliation.transaction_id, reconciliation.charge_id,
  reconciliation.batch_id, reconciliation.recorded_by,
  CAST(reconciliation.amount - COALESCE(released.amount, 0) AS DECIMAL(12,2)) AS net_amount
FROM dbo.finance_legacy_reconciliations AS reconciliation
OUTER APPLY (SELECT SUM(release.amount) AS amount
  FROM dbo.finance_legacy_reconciliation_releases AS release
  WHERE release.reconciliation_id = reconciliation.id) AS released;
GO

CREATE VIEW dbo.v_finance_payment_credit AS
SELECT payment.id AS payment_id, payment.student_id, payment.amount, payment.payment_date,
  CAST(CASE WHEN payment.is_reversed = 1 THEN 0
    ELSE payment.amount - COALESCE(SUM(allocation.net_amount), 0) END AS DECIMAL(12,2)) AS available_credit,
  payment.is_reversed
FROM dbo.finance_payments AS payment
LEFT JOIN dbo.v_finance_net_payment_allocations AS allocation ON allocation.payment_id = payment.id
GROUP BY payment.id, payment.student_id, payment.amount, payment.payment_date, payment.is_reversed;
GO

CREATE VIEW dbo.v_finance_assessed_charge_due AS
SELECT charge.id AS charge_id, charge.annual_enrollment_id, charge.enrollment_id,
  CAST(charge.amount + COALESCE(adjustments.amount, 0) - COALESCE(payments.amount, 0) - COALESCE(legacy.amount, 0) AS DECIMAL(12,2)) AS amount_due,
  CAST(COALESCE(payments.amount, 0) AS DECIMAL(12,2)) AS annual_allocated,
  CAST(COALESCE(legacy.amount, 0) AS DECIMAL(12,2)) AS legacy_allocated
FROM dbo.assessed_charges AS charge
OUTER APPLY (SELECT SUM(adjustment.amount) AS amount FROM dbo.finance_charge_adjustments AS adjustment WHERE adjustment.charge_id = charge.id) AS adjustments
OUTER APPLY (SELECT SUM(allocation.net_amount) AS amount
  FROM dbo.v_finance_net_payment_allocations AS allocation
  INNER JOIN dbo.finance_payments AS payment ON payment.id = allocation.payment_id
  WHERE allocation.charge_id = charge.id AND payment.is_reversed = 0) AS payments
OUTER APPLY (SELECT SUM(reconciliation.net_amount) AS amount
  FROM dbo.v_finance_net_legacy_reconciliations AS reconciliation
  WHERE reconciliation.charge_id = charge.id) AS legacy;
GO

CREATE VIEW dbo.v_finance_opening_liability_due AS
SELECT opening.id AS opening_charge_id, opening.student_id,
  CAST(opening.amount - COALESCE(allocations.amount, 0) AS DECIMAL(12,2)) AS amount_due,
  CAST(COALESCE(allocations.amount, 0) AS DECIMAL(12,2)) AS allocated
FROM dbo.finance_legacy_opening_charges AS opening
OUTER APPLY (SELECT SUM(allocation.net_amount) AS amount
  FROM dbo.v_finance_net_payment_allocations AS allocation
  INNER JOIN dbo.finance_payments AS payment ON payment.id = allocation.payment_id
  WHERE allocation.legacy_opening_charge_id = opening.id AND payment.is_reversed = 0) AS allocations;
GO

CREATE VIEW dbo.v_finance_legacy_account_balance AS
SELECT account.id AS financial_account_id, account.student_id,
  CAST(account.balance + COALESCE(reconciliations.amount, 0) - COALESCE(openings.amount, 0) AS DECIMAL(12,2)) AS remaining_legacy_balance
FROM dbo.financial_accounts AS account
OUTER APPLY (SELECT SUM(reconciliation.net_amount) AS amount
  FROM dbo.financial_transactions AS transaction_record
  INNER JOIN dbo.v_finance_net_legacy_reconciliations AS reconciliation ON reconciliation.transaction_id = transaction_record.id
  WHERE transaction_record.financial_account_id = account.id) AS reconciliations
OUTER APPLY (SELECT SUM(opening.amount) AS amount FROM dbo.finance_legacy_opening_charges AS opening
  WHERE opening.financial_account_id = account.id) AS openings;
GO
