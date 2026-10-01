-- MariaDB forward-only port of V2 005_annual_enrollment_finance_checklist.sql.
-- Applies only to an empty fresh target database; no SQL Server data is changed.
/* Annual enrollment, allocated finance ledger, term decisions, and student physical checklist. */

ALTER TABLE sections ADD cluster VARCHAR(80) NULL;
ALTER TABLE sections ADD strand VARCHAR(80) NULL;
ALTER TABLE sections ADD adviser VARCHAR(160) NULL;
ALTER TABLE sections ADD modality VARCHAR(30) NULL;
ALTER TABLE sections ADD modular_subtype VARCHAR(80) NULL;

CREATE TABLE annual_enrollments (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  student_id INT NOT NULL,
  school_year VARCHAR(20) NOT NULL,
  grade_level VARCHAR(50) NOT NULL,
  voucher_code VARCHAR(10) NULL CHECK (voucher_code IS NULL OR voucher_code IN ('PUB', 'ESC', 'NV')),
  voucher_category CHAR(1) NULL CHECK (voucher_category IS NULL OR voucher_category IN ('A', 'B', 'C', 'D', 'E')),
  intake_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (intake_status IN ('pending', 'enrolled', 'cancelled', 'dropped', 'transferred', 'legacy')),
  account_activation_pending TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NULL,
  idempotency_key CHAR(36) NULL,
  request_fingerprint CHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_annual_enrollment_student_year UNIQUE (student_id, school_year),
  CONSTRAINT FK_annual_enrollment_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_annual_enrollment_creator FOREIGN KEY (created_by) REFERENCES users(id)
);

ALTER TABLE enrollments ADD annual_enrollment_id INT NULL;
ALTER TABLE enrollments ADD CONSTRAINT FK_enrollment_annual_enrollment
  FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id);
CREATE INDEX IX_enrollments_annual_parent ON enrollments (annual_enrollment_id, academic_term_id, id);
ALTER TABLE enrollments ADD annual_term_number TINYINT NULL;

ALTER TABLE enrollments ADD CONSTRAINT CK_enrollment_annual_term_number CHECK (annual_term_number IS NULL OR annual_term_number BETWEEN 1 AND 3);
CREATE UNIQUE INDEX UX_enrollment_annual_term_number ON enrollments (annual_enrollment_id, annual_term_number);
CREATE UNIQUE INDEX UX_annual_enrollment_idempotency ON annual_enrollments (idempotency_key);
ALTER TABLE enrollment_clearances ADD account_activation_pending TINYINT(1) NOT NULL
  DEFAULT 0;
ALTER TABLE financial_transactions ADD is_legacy_unattributed TINYINT(1) NOT NULL DEFAULT 1;

CREATE TABLE annual_enrollment_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  enrollment_id INT NULL,
  actor_id INT NOT NULL,
  event_type VARCHAR(40) NOT NULL CHECK (event_type IN ('created', 'term_cancelled', 'term_dropped', 'term_transferred', 'term_placement_changed', 'voucher_review_flagged', 'voucher_review_resolved')),
  reason VARCHAR(1000) NULL,
  idempotency_key CHAR(36) NULL,
  request_fingerprint CHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_annual_enrollment_event_parent FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_annual_enrollment_event_term FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
  CONSTRAINT FK_annual_enrollment_event_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IX_annual_enrollment_event_history ON annual_enrollment_events (annual_enrollment_id, created_at, id);
CREATE UNIQUE INDEX UX_annual_enrollment_event_idempotency ON annual_enrollment_events (idempotency_key);

CREATE TABLE finance_schedules (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  school_year VARCHAR(20) NOT NULL,
  grade_level VARCHAR(50) NOT NULL,
  voucher_code VARCHAR(10) NOT NULL CHECK (voucher_code IN ('PUB', 'ESC', 'NV')),
  version_no INT NOT NULL CHECK (version_no > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired')),
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  active_school_year VARCHAR(20) GENERATED ALWAYS AS (CASE WHEN status = 'active' THEN school_year ELSE NULL END) STORED,
  active_grade_level VARCHAR(50) GENERATED ALWAYS AS (CASE WHEN status = 'active' THEN grade_level ELSE NULL END) STORED,
  active_voucher_code VARCHAR(10) GENERATED ALWAYS AS (CASE WHEN status = 'active' THEN voucher_code ELSE NULL END) STORED,
  CONSTRAINT UQ_finance_schedule_version UNIQUE (school_year, grade_level, voucher_code, version_no),
  CONSTRAINT UQ_finance_schedule_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_schedule_creator FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE UNIQUE INDEX UX_finance_schedule_active ON finance_schedules (active_school_year, active_grade_level, active_voucher_code);

CREATE TABLE finance_schedule_lines (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  schedule_id INT NOT NULL,
  term_number TINYINT NOT NULL CHECK (term_number BETWEEN 1 AND 3),
  fee_category VARCHAR(40) NOT NULL CHECK (fee_category IN ('tuition', 'miscellaneous', 'uniform', 'id', 'activity', 'retake', 'other')),
  line_name VARCHAR(120) NOT NULL,
  installment VARCHAR(40) NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount >= 0),
  is_optional TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_finance_schedule_line_schedule FOREIGN KEY (schedule_id) REFERENCES finance_schedules(id)
);
CREATE INDEX IX_finance_schedule_lines_schedule ON finance_schedule_lines (schedule_id, term_number, id);

CREATE TABLE annual_assessments (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  schedule_id INT NOT NULL,
  schedule_version INT NOT NULL,
  voucher_code_snapshot VARCHAR(10) NOT NULL CHECK (voucher_code_snapshot IN ('PUB', 'ESC', 'NV')),
  assessed_by INT NOT NULL,
  assessed_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  selection_json LONGTEXT NOT NULL CHECK (JSON_VALID(selection_json) = 1),
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  CONSTRAINT UQ_annual_assessment_parent UNIQUE (annual_enrollment_id),
  CONSTRAINT UQ_annual_assessment_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_annual_assessment_parent FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_annual_assessment_schedule FOREIGN KEY (schedule_id) REFERENCES finance_schedules(id),
  CONSTRAINT FK_annual_assessment_actor FOREIGN KEY (assessed_by) REFERENCES users(id)
);

CREATE TABLE assessed_charges (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  assessment_id INT NOT NULL,
  annual_enrollment_id INT NOT NULL,
  enrollment_id INT NOT NULL,
  schedule_line_id INT NULL,
  fee_category VARCHAR(40) NOT NULL,
  line_name VARCHAR(120) NOT NULL,
  installment VARCHAR(40) NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount >= 0),
  is_manual TINYINT(1) NOT NULL DEFAULT 0,
  reason VARCHAR(1000) NULL,
  idempotency_key CHAR(36) NULL,
  request_fingerprint CHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_assessed_charge_assessment FOREIGN KEY (assessment_id) REFERENCES annual_assessments(id),
  CONSTRAINT FK_assessed_charge_parent FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_assessed_charge_term FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
  CONSTRAINT FK_assessed_charge_line FOREIGN KEY (schedule_line_id) REFERENCES finance_schedule_lines(id)
);
CREATE UNIQUE INDEX UX_assessed_charge_idempotency ON assessed_charges (idempotency_key);
CREATE INDEX IX_assessed_charge_parent_term ON assessed_charges (annual_enrollment_id, enrollment_id, id);

CREATE TABLE finance_charge_adjustments (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  charge_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount <> 0),
  reason VARCHAR(1000) NOT NULL,
  reverses_adjustment_id BIGINT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_charge_adjustment_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_charge_adjustment_charge FOREIGN KEY (charge_id) REFERENCES assessed_charges(id),
  CONSTRAINT FK_finance_charge_adjustment_reverse FOREIGN KEY (reverses_adjustment_id) REFERENCES finance_charge_adjustments(id),
  CONSTRAINT FK_finance_charge_adjustment_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);
CREATE UNIQUE INDEX UX_finance_charge_adjustment_reversal ON finance_charge_adjustments (reverses_adjustment_id);

CREATE TABLE finance_payments (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  student_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL,
  reference_no VARCHAR(100) NULL,
  receipt_issued TINYINT(1) NOT NULL DEFAULT 0,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  is_reversed TINYINT(1) NOT NULL DEFAULT 0,
  reverses_payment_id BIGINT NULL,
  CONSTRAINT UQ_finance_payment_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_payment_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_finance_payment_actor FOREIGN KEY (recorded_by) REFERENCES users(id),
  CONSTRAINT FK_finance_payment_reverse FOREIGN KEY (reverses_payment_id) REFERENCES finance_payments(id)
);
CREATE INDEX IX_finance_payment_student_date ON finance_payments (student_id, payment_date, id);

CREATE TABLE finance_allocation_batches (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  payment_id BIGINT NOT NULL,
  student_id INT NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  allocated_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_allocation_batch_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_allocation_batch_payment FOREIGN KEY (payment_id) REFERENCES finance_payments(id),
  CONSTRAINT FK_finance_allocation_batch_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_finance_allocation_batch_actor FOREIGN KEY (allocated_by) REFERENCES users(id)
);

CREATE TABLE finance_payment_allocations (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  payment_id BIGINT NOT NULL,
  charge_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  allocation_batch_id BIGINT NOT NULL,
  allocated_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_finance_allocation_payment FOREIGN KEY (payment_id) REFERENCES finance_payments(id),
  CONSTRAINT FK_finance_allocation_charge FOREIGN KEY (charge_id) REFERENCES assessed_charges(id),
  CONSTRAINT FK_finance_allocation_batch FOREIGN KEY (allocation_batch_id) REFERENCES finance_allocation_batches(id),
  CONSTRAINT FK_finance_allocation_actor FOREIGN KEY (allocated_by) REFERENCES users(id)
);
CREATE INDEX IX_finance_allocation_payment ON finance_payment_allocations (payment_id, id);
CREATE INDEX IX_finance_allocation_charge ON finance_payment_allocations (charge_id, id);

CREATE TABLE finance_legacy_reconciliation_batches (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  transaction_id INT NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_legacy_reconciliation_batch_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_legacy_reconciliation_batch_transaction FOREIGN KEY (transaction_id) REFERENCES financial_transactions(id),
  CONSTRAINT FK_finance_legacy_reconciliation_batch_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);

CREATE TABLE finance_legacy_reconciliations (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  transaction_id INT NOT NULL,
  charge_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  reason VARCHAR(1000) NOT NULL,
  batch_id BIGINT NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_finance_legacy_reconciliation_transaction FOREIGN KEY (transaction_id) REFERENCES financial_transactions(id),
  CONSTRAINT FK_finance_legacy_reconciliation_batch FOREIGN KEY (batch_id) REFERENCES finance_legacy_reconciliation_batches(id),
  CONSTRAINT FK_finance_legacy_reconciliation_charge FOREIGN KEY (charge_id) REFERENCES assessed_charges(id),
  CONSTRAINT FK_finance_legacy_reconciliation_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);
CREATE INDEX IX_finance_legacy_reconciliation_transaction ON finance_legacy_reconciliations (transaction_id, id);

CREATE TABLE finance_payment_reversals (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  payment_id BIGINT NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_payment_reversal_payment UNIQUE (payment_id),
  CONSTRAINT UQ_finance_payment_reversal_idempotency UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_payment_reversal_payment FOREIGN KEY (payment_id) REFERENCES finance_payments(id),
  CONSTRAINT FK_finance_payment_reversal_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);

CREATE TABLE term_finance_approvals (
  enrollment_id INT NOT NULL PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved')),
  approved_by INT NULL,
  approved_at DATETIME NULL,
  approval_reason VARCHAR(1000) NULL,
  finance_review_required TINYINT(1) NOT NULL DEFAULT 0,
  finance_review_reason VARCHAR(1000) NULL,
  finance_review_requested_by INT NULL,
  finance_review_requested_at DATETIME NULL,
  CONSTRAINT FK_term_finance_approval_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
  CONSTRAINT FK_term_finance_approval_actor FOREIGN KEY (approved_by) REFERENCES users(id),
  CONSTRAINT FK_term_finance_review_actor FOREIGN KEY (finance_review_requested_by) REFERENCES users(id),
  CONSTRAINT CK_term_finance_approval_state CHECK (
    (status = 'pending' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE TABLE term_clearance_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  enrollment_id INT NOT NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('signed', 'revoked')),
  reason VARCHAR(1000) NULL,
  arrangement VARCHAR(1000) NULL,
  finance_note VARCHAR(2000) NULL,
  idempotency_key CHAR(36) NULL,
  request_fingerprint CHAR(64) NULL,
  outstanding_snapshot DECIMAL(12,2) NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_term_clearance_event_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
  CONSTRAINT FK_term_clearance_event_actor FOREIGN KEY (recorded_by) REFERENCES users(id),
  CONSTRAINT CK_term_clearance_event_signed_reason CHECK (event_type <> 'signed' OR (reason IS NOT NULL AND CHAR_LENGTH(TRIM(reason)) > 0))
);
CREATE UNIQUE INDEX UX_term_clearance_event_idempotency ON term_clearance_events (idempotency_key);
CREATE INDEX IX_term_clearance_event_history ON term_clearance_events (enrollment_id, created_at, id);

CREATE TABLE student_physical_checklist_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  student_id INT NOT NULL,
  requirement_code VARCHAR(60) NOT NULL,
  requirement_name VARCHAR(120) NOT NULL,
  status VARCHAR(30) NOT NULL CHECK (status IN ('pending', 'received', 'verified', 'correction', 'rejected')),
  note VARCHAR(1000) NULL,
  is_applicable TINYINT(1) NOT NULL DEFAULT 1,
  originals_received TINYINT NOT NULL DEFAULT 0 CHECK (originals_received <= 20),
  copies_received TINYINT NOT NULL DEFAULT 0 CHECK (copies_received <= 50),
  pieces_received TINYINT NOT NULL DEFAULT 0 CHECK (pieces_received <= 50),
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_student_physical_checklist_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_student_physical_checklist_actor FOREIGN KEY (recorded_by) REFERENCES users(id),
  CONSTRAINT UQ_student_physical_checklist_idempotency UNIQUE (idempotency_key),
  CONSTRAINT CK_student_physical_checklist_correction_note CHECK (status <> 'correction' OR (note IS NOT NULL AND CHAR_LENGTH(TRIM(note)) > 0))
);
CREATE INDEX IX_student_physical_checklist_history ON student_physical_checklist_events (student_id, requirement_code, created_at DESC, id DESC);

CREATE TABLE physical_requirement_definitions (
  requirement_code VARCHAR(60) NOT NULL PRIMARY KEY,
  requirement_name VARCHAR(120) NOT NULL,
  guidance VARCHAR(500) NOT NULL,
  applicability VARCHAR(20) NOT NULL CHECK (applicability IN ('all', 'als', 'esc', 'optional', 'grade11', 'grade12', 'staff')),
  originals_required TINYINT NOT NULL DEFAULT 0 CHECK (originals_required <= 20),
  copies_required TINYINT NOT NULL DEFAULT 0 CHECK (copies_required <= 50),
  pieces_required TINYINT NOT NULL DEFAULT 0 CHECK (pieces_required <= 50),
  is_optional TINYINT(1) NOT NULL DEFAULT 0,
  display_order TINYINT NOT NULL
);

INSERT INTO physical_requirement_definitions
  (requirement_code, requirement_name, guidance, applicability, originals_required, copies_required, pieces_required, is_optional, display_order)
VALUES
  ('birth_certificate', 'Birth Certificate (PSA / NSO / OLD)', '3 photocopies.', 'all', 0, 3, 0, 0, 1),
  ('jhs_report_card', 'Report Card (Grade-10 / ALS-AF5)', 'Original + 1 photocopy. Use the Grade-10 or ALS-AF5 description as applicable; applies to Grade 11 learners.', 'grade11', 1, 1, 0, 0, 2),
  ('grade11_card', 'Grade 11 Card', 'Grade 11 card applies to Grade 12 learners.', 'grade12', 0, 0, 0, 0, 3),
  ('good_moral', 'Good Moral Certificate', 'Original + 1 photocopy.', 'all', 1, 1, 0, 0, 4),
  ('jhs_certificate', 'Junior High School Certificate', '2 photocopies.', 'all', 0, 2, 0, 0, 5),
  ('als_certificate_of_rating', 'Certificate of Rating (ALS)', 'Original + 1 photocopy. Mark not applicable when the learner is not an ALS learner.', 'als', 1, 1, 0, 0, 6),
  ('esc_certificate', 'ESC Certificate (Private School)', 'Original + 1 photocopy. Mark not applicable when this requirement does not apply.', 'esc', 1, 1, 0, 0, 7),
  ('national_id', 'National ID (if you have)', '1 photocopy; optional.', 'optional', 0, 1, 0, 1, 8),
  ('two_by_two_photo', '2x2 Picture with name tag & white background', '3 pieces.', 'all', 0, 0, 3, 0, 9),
  ('long_brown_envelopes', 'Long Brown Envelopes', '2 pieces.', 'all', 0, 0, 2, 0, 10),
  ('sf10_form137', 'SF10 / Form 137', 'Staff-only physical record; reuses the existing Form 137 status history.', 'staff', 0, 0, 0, 0, 11);

CREATE TABLE finance_transaction_reversals (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  transaction_id INT NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_transaction_reversal UNIQUE (transaction_id),
  CONSTRAINT FK_finance_transaction_reversal_transaction FOREIGN KEY (transaction_id) REFERENCES financial_transactions(id),
  CONSTRAINT FK_finance_transaction_reversal_actor FOREIGN KEY (recorded_by) REFERENCES users(id)
);
