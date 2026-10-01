-- MariaDB forward-only port of V2 006_configurable_term_transfer_exemptions_and_reporting.sql.
-- Applies only to an empty fresh target database; no SQL Server data is changed.
/* Configurable annual term order, midyear entry, reviewed finance cases, and reporting. */

ALTER TABLE annual_enrollments ADD intake_kind VARCHAR(20) NOT NULL
  DEFAULT 'unspecified' ;

ALTER TABLE annual_enrollments ADD CONSTRAINT CK_annual_enrollment_intake_kind
  CHECK (intake_kind IN ('new', 'returning', 'transferee', 'unspecified'));
ALTER TABLE annual_enrollments ADD entry_term_number TINYINT NULL;

ALTER TABLE annual_enrollments ADD CONSTRAINT CK_annual_enrollment_entry_term
  CHECK (entry_term_number IS NULL OR entry_term_number BETWEEN 1 AND 3);
ALTER TABLE annual_enrollments ADD enrollment_start_date DATE NULL;
ALTER TABLE enrollments ADD term_scope_status VARCHAR(20) NOT NULL
  DEFAULT 'applicable' ;

ALTER TABLE enrollments ADD CONSTRAINT CK_enrollment_term_scope
  CHECK (term_scope_status IN ('applicable', 'not_applicable'));

CREATE TABLE school_year_term_order (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  school_year VARCHAR(20) NOT NULL,
  term_number TINYINT NOT NULL CHECK (term_number BETWEEN 1 AND 3),
  academic_term_id INT NOT NULL UNIQUE,
  configured_by INT NULL,
  configuration_source VARCHAR(40) NOT NULL DEFAULT 'staff'
    CHECK (configuration_source IN ('staff', 'explicit_v2_005_backfill')),
  configured_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_school_year_term_order_year_number UNIQUE (school_year, term_number),
  CONSTRAINT FK_school_year_term_order_term FOREIGN KEY (academic_term_id) REFERENCES academic_terms(id),
  CONSTRAINT FK_school_year_term_order_actor FOREIGN KEY (configured_by) REFERENCES users(id)
);

CREATE TABLE school_year_term_order_reviews (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  school_year VARCHAR(20) NOT NULL,
  academic_term_id INT NOT NULL,
  review_reason VARCHAR(500) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  resolved_by INT NULL,
  resolved_at DATETIME NULL,
  CONSTRAINT UQ_school_year_term_order_review_term UNIQUE (academic_term_id),
  CONSTRAINT FK_school_year_term_order_review_term FOREIGN KEY (academic_term_id) REFERENCES academic_terms(id),
  CONSTRAINT FK_school_year_term_order_review_actor FOREIGN KEY (resolved_by) REFERENCES users(id)
);

CREATE TABLE annual_workflow_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  enrollment_id INT NULL,
  actor_id INT NOT NULL,
  event_type VARCHAR(40) NOT NULL CHECK (event_type IN (
    'term_order_configured', 'enrollment_tag_recorded', 'special_subject_recorded',
    'departure_recorded', 'departure_finance_reviewed')),
  reason VARCHAR(1000) NULL,
  idempotency_key CHAR(36) NULL,
  request_fingerprint CHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_annual_workflow_event_parent FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_annual_workflow_event_term FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
  CONSTRAINT FK_annual_workflow_event_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX UX_annual_workflow_event_idempotency ON annual_workflow_events (idempotency_key);
CREATE INDEX IX_annual_workflow_event_history ON annual_workflow_events (annual_enrollment_id, created_at, id);

-- Fresh empty target: no legacy term-order backfill is needed.
CREATE TABLE annual_enrollment_tags (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  tag_type VARCHAR(30) NOT NULL CHECK (tag_type IN ('internal', 'athlete', 'performer', 'named_arrangement')),
  label VARCHAR(120) NOT NULL,
  note VARCHAR(500) NULL,
  effective_term_from TINYINT NULL,
  effective_term_to TINYINT NULL,
  recorded_by INT NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_annual_enrollment_tag_key UNIQUE (idempotency_key),
  CONSTRAINT CK_annual_enrollment_tag_term_scope CHECK (
    (effective_term_from IS NULL AND effective_term_to IS NULL) OR
    (effective_term_from BETWEEN 1 AND 3 AND effective_term_to BETWEEN effective_term_from AND 3)),
  CONSTRAINT FK_annual_enrollment_tag_parent FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_annual_enrollment_tag_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);
CREATE INDEX IX_annual_enrollment_tags_parent ON annual_enrollment_tags (annual_enrollment_id, created_at, id);

CREATE TABLE annual_special_subjects (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  enrollment_id INT NOT NULL,
  student_id INT NOT NULL,
  student_subject_id INT NOT NULL UNIQUE,
  arrangement_type VARCHAR(30) NOT NULL CHECK (arrangement_type IN ('internal', 'athlete', 'performer', 'modular', 'other')),
  modular_subtype VARCHAR(80) NULL,
  prepaid_arrangement_note VARCHAR(500) NULL,
  recorded_by INT NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_annual_special_subject_key UNIQUE (idempotency_key),
  CONSTRAINT FK_annual_special_subject_parent FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_annual_special_subject_term FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
  CONSTRAINT FK_annual_special_subject_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_annual_special_subject_assignment FOREIGN KEY (student_subject_id) REFERENCES student_subjects(id),
  CONSTRAINT FK_annual_special_subject_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);
CREATE INDEX IX_annual_special_subject_parent ON annual_special_subjects (annual_enrollment_id, enrollment_id, id);

CREATE TABLE finance_exemption_cases (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by INT NOT NULL,
  reviewed_by INT NULL,
  review_reason VARCHAR(1000) NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  reviewed_at DATETIME NULL,
  CONSTRAINT UQ_finance_exemption_case_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_exemption_case_parent FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_finance_exemption_case_requestor FOREIGN KEY (requested_by) REFERENCES users(id),
  CONSTRAINT FK_finance_exemption_case_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id)
);

CREATE TABLE finance_exemption_rules (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  exemption_case_id BIGINT NOT NULL,
  term_number TINYINT NOT NULL CHECK (term_number BETWEEN 1 AND 3),
  fee_category VARCHAR(40) NULL,
  line_name VARCHAR(120) NULL,
  is_full_coverage TINYINT(1) NOT NULL DEFAULT 0,
  approved_amount DECIMAL(12,2) NOT NULL CHECK (approved_amount >= 0),
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT CK_finance_exemption_rule_match CHECK (fee_category IS NOT NULL OR line_name IS NOT NULL),
  CONSTRAINT CK_finance_exemption_rule_amount CHECK (
    (is_full_coverage = 1 AND approved_amount = 0) OR (is_full_coverage = 0 AND approved_amount > 0)),
  CONSTRAINT FK_finance_exemption_rule_case FOREIGN KEY (exemption_case_id) REFERENCES finance_exemption_cases(id)
);

CREATE TABLE finance_exemption_applications (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  exemption_rule_id BIGINT NOT NULL,
  charge_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  applied_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_exemption_application_rule_charge UNIQUE (exemption_rule_id, charge_id),
  CONSTRAINT FK_finance_exemption_application_rule FOREIGN KEY (exemption_rule_id) REFERENCES finance_exemption_rules(id),
  CONSTRAINT FK_finance_exemption_application_charge FOREIGN KEY (charge_id) REFERENCES assessed_charges(id)
);

ALTER TABLE assessed_charges ADD gross_amount DECIMAL(12,2) NULL;
ALTER TABLE assessed_charges ADD waived_amount DECIMAL(12,2) NOT NULL
  DEFAULT (0) ;

UPDATE assessed_charges SET gross_amount = amount WHERE gross_amount IS NULL;

ALTER TABLE assessed_charges MODIFY gross_amount DECIMAL(12,2) NOT NULL;
ALTER TABLE assessed_charges ADD special_subject_id BIGINT NULL;

ALTER TABLE assessed_charges ADD CONSTRAINT FK_assessed_charge_special_subject
  FOREIGN KEY (special_subject_id) REFERENCES annual_special_subjects(id);
ALTER TABLE finance_charge_adjustments ADD exemption_application_id BIGINT NULL;

ALTER TABLE finance_charge_adjustments ADD CONSTRAINT FK_finance_adjustment_exemption_application
  FOREIGN KEY (exemption_application_id) REFERENCES finance_exemption_applications(id);
CREATE UNIQUE INDEX UX_assessed_charge_special_subject ON assessed_charges (special_subject_id);
CREATE UNIQUE INDEX UX_finance_adjustment_exemption_application ON finance_charge_adjustments (exemption_application_id);

CREATE TABLE finance_departure_cases (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL UNIQUE,
  effective_enrollment_id INT NOT NULL,
  effective_date DATE NOT NULL,
  departure_type VARCHAR(20) NOT NULL CHECK (departure_type IN ('dropped', 'transferred')),
  reason VARCHAR(1000) NOT NULL,
  finance_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (finance_status IN ('pending', 'reviewed')),
  recorded_by INT NOT NULL,
  reviewed_by INT NULL,
  review_reason VARCHAR(1000) NULL,
  review_idempotency_key CHAR(36) NULL,
  review_request_fingerprint CHAR(64) NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  reviewed_at DATETIME NULL,
  CONSTRAINT UQ_finance_departure_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_departure_parent FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_finance_departure_effective_enrollment FOREIGN KEY (effective_enrollment_id) REFERENCES enrollments(id),
  CONSTRAINT FK_finance_departure_registrar FOREIGN KEY (recorded_by) REFERENCES users(id),
  CONSTRAINT FK_finance_departure_finance FOREIGN KEY (reviewed_by) REFERENCES users(id)
);
CREATE UNIQUE INDEX UX_finance_departure_review_key ON finance_departure_cases (review_idempotency_key);

CREATE TABLE finance_departure_case_terms (
  departure_case_id BIGINT NOT NULL,
  enrollment_id INT NOT NULL,
  academic_activity_review_required TINYINT(1) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT PK_finance_departure_case_terms PRIMARY KEY (departure_case_id, enrollment_id),
  CONSTRAINT FK_finance_departure_term_case FOREIGN KEY (departure_case_id) REFERENCES finance_departure_cases(id),
  CONSTRAINT FK_finance_departure_term_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments(id)
);

ALTER TABLE finance_charge_adjustments ADD departure_case_id BIGINT NULL;
ALTER TABLE finance_charge_adjustments ADD CONSTRAINT FK_finance_adjustment_departure_case
  FOREIGN KEY (departure_case_id) REFERENCES finance_departure_cases(id);

ALTER TABLE finance_payments ADD transmittal_reference VARCHAR(100) NULL;
ALTER TABLE finance_payments ADD private_remarks VARCHAR(1000) NULL;

CREATE TABLE finance_payment_metadata_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  payment_id BIGINT NOT NULL,
  event_type VARCHAR(30) NOT NULL CHECK (event_type IN ('receipt_reference_updated', 'receipt_marked_issued', 'private_remark_added')),
  reference_no VARCHAR(100) NULL,
  private_remark VARCHAR(1000) NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_payment_metadata_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_payment_metadata_payment FOREIGN KEY (payment_id) REFERENCES finance_payments(id),
  CONSTRAINT FK_finance_payment_metadata_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);
CREATE INDEX IX_finance_payment_metadata_history ON finance_payment_metadata_events (payment_id, created_at, id);

CREATE TABLE finance_legacy_opening_charges (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  financial_account_id INT NOT NULL UNIQUE,
  student_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  source_label VARCHAR(120) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_legacy_opening_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_legacy_opening_account FOREIGN KEY (financial_account_id) REFERENCES financial_accounts(id),
  CONSTRAINT FK_finance_legacy_opening_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_finance_legacy_opening_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);

ALTER TABLE finance_payment_allocations MODIFY charge_id BIGINT NULL;
ALTER TABLE finance_payment_allocations ADD legacy_opening_charge_id BIGINT NULL;

ALTER TABLE finance_payment_allocations ADD CONSTRAINT CK_finance_payment_allocation_target
  CHECK ((charge_id IS NOT NULL AND legacy_opening_charge_id IS NULL) OR (charge_id IS NULL AND legacy_opening_charge_id IS NOT NULL));

ALTER TABLE finance_payment_allocations ADD CONSTRAINT FK_finance_payment_allocation_legacy_opening
  FOREIGN KEY (legacy_opening_charge_id) REFERENCES finance_legacy_opening_charges(id);

CREATE TABLE finance_payment_allocation_releases (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  allocation_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  reason VARCHAR(1000) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_payment_allocation_release_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_payment_allocation_release_allocation FOREIGN KEY (allocation_id) REFERENCES finance_payment_allocations(id),
  CONSTRAINT FK_finance_payment_allocation_release_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);
CREATE INDEX IX_finance_payment_allocation_release_origin ON finance_payment_allocation_releases (allocation_id, id);

CREATE TABLE finance_legacy_reconciliation_releases (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  reconciliation_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  reason VARCHAR(1000) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_legacy_reconciliation_release_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_legacy_reconciliation_release_source FOREIGN KEY (reconciliation_id) REFERENCES finance_legacy_reconciliations(id),
  CONSTRAINT FK_finance_legacy_reconciliation_release_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);
CREATE INDEX IX_finance_legacy_reconciliation_release_origin ON finance_legacy_reconciliation_releases (reconciliation_id, id);

/* Shared net projections keep append-only releases/reversals consistent across ledgers and reports. */

CREATE OR REPLACE VIEW v_finance_net_payment_allocations AS
SELECT allocation.id AS allocation_id, allocation.payment_id, allocation.charge_id,
  allocation.legacy_opening_charge_id, allocation.allocation_batch_id, allocation.allocated_by,
  CAST(allocation.amount - COALESCE(released.amount, 0) AS DECIMAL(12,2)) AS net_amount
FROM finance_payment_allocations AS allocation
LEFT JOIN (SELECT allocation_id, SUM(amount) AS amount FROM finance_payment_allocation_releases GROUP BY allocation_id) AS released
  ON released.allocation_id = allocation.id;

CREATE OR REPLACE VIEW v_finance_net_legacy_reconciliations AS
SELECT reconciliation.id AS reconciliation_id, reconciliation.transaction_id, reconciliation.charge_id,
  reconciliation.batch_id, reconciliation.recorded_by,
  CAST(reconciliation.amount - COALESCE(released.amount, 0) AS DECIMAL(12,2)) AS net_amount
FROM finance_legacy_reconciliations AS reconciliation
LEFT JOIN (SELECT reconciliation_id, SUM(amount) AS amount FROM finance_legacy_reconciliation_releases GROUP BY reconciliation_id) AS released
  ON released.reconciliation_id = reconciliation.id;

CREATE OR REPLACE VIEW v_finance_payment_credit AS
SELECT payment.id AS payment_id, payment.student_id, payment.amount, payment.payment_date,
  CAST(CASE WHEN payment.is_reversed = 1 THEN 0 ELSE payment.amount - COALESCE(SUM(allocation.net_amount), 0) END AS DECIMAL(12,2)) AS available_credit,
  payment.is_reversed
FROM finance_payments AS payment
LEFT JOIN v_finance_net_payment_allocations AS allocation ON allocation.payment_id = payment.id
GROUP BY payment.id, payment.student_id, payment.amount, payment.payment_date, payment.is_reversed;

CREATE OR REPLACE VIEW v_finance_assessed_charge_due AS
SELECT charge.id AS charge_id, charge.annual_enrollment_id, charge.enrollment_id,
  CAST(charge.amount + COALESCE((SELECT SUM(adjustment.amount) FROM finance_charge_adjustments AS adjustment WHERE adjustment.charge_id = charge.id), 0)
    - COALESCE((SELECT SUM(allocation.net_amount) FROM v_finance_net_payment_allocations AS allocation
      INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
      WHERE allocation.charge_id = charge.id AND payment.is_reversed = 0), 0)
    - COALESCE((SELECT SUM(reconciliation.net_amount) FROM v_finance_net_legacy_reconciliations AS reconciliation WHERE reconciliation.charge_id = charge.id), 0)
    AS DECIMAL(12,2)) AS amount_due,
  CAST(COALESCE((SELECT SUM(allocation.net_amount) FROM v_finance_net_payment_allocations AS allocation
    INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
    WHERE allocation.charge_id = charge.id AND payment.is_reversed = 0), 0) AS DECIMAL(12,2)) AS annual_allocated,
  CAST(COALESCE((SELECT SUM(reconciliation.net_amount) FROM v_finance_net_legacy_reconciliations AS reconciliation WHERE reconciliation.charge_id = charge.id), 0) AS DECIMAL(12,2)) AS legacy_allocated
FROM assessed_charges AS charge;

CREATE OR REPLACE VIEW v_finance_opening_liability_due AS
SELECT opening.id AS opening_charge_id, opening.student_id,
  CAST(opening.amount - COALESCE((SELECT SUM(allocation.net_amount) FROM v_finance_net_payment_allocations AS allocation
    INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
    WHERE allocation.legacy_opening_charge_id = opening.id AND payment.is_reversed = 0), 0) AS DECIMAL(12,2)) AS amount_due,
  CAST(COALESCE((SELECT SUM(allocation.net_amount) FROM v_finance_net_payment_allocations AS allocation
    INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id
    WHERE allocation.legacy_opening_charge_id = opening.id AND payment.is_reversed = 0), 0) AS DECIMAL(12,2)) AS allocated
FROM finance_legacy_opening_charges AS opening;

CREATE OR REPLACE VIEW v_finance_legacy_account_balance AS
SELECT account.id AS financial_account_id, account.student_id,
  CAST(account.balance + COALESCE((SELECT SUM(reconciliation.net_amount) FROM financial_transactions AS transaction_record
    INNER JOIN v_finance_net_legacy_reconciliations AS reconciliation ON reconciliation.transaction_id = transaction_record.id
    WHERE transaction_record.financial_account_id = account.id), 0)
    - COALESCE((SELECT SUM(opening.amount) FROM finance_legacy_opening_charges AS opening
      WHERE opening.financial_account_id = account.id), 0) AS DECIMAL(12,2)) AS remaining_legacy_balance
FROM financial_accounts AS account;
