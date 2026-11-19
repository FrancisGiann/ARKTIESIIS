-- Record the Registrar's digital academic review separately from Finance evidence.
-- Existing annual_registrar_confirmations remain unchanged for historical consumers.
CREATE TABLE annual_registrar_handoff_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  student_id INT NOT NULL,
  school_year VARCHAR(20) NOT NULL,
  grade_level VARCHAR(50) NOT NULL,
  handoff_version INT NOT NULL,
  clearance_fingerprint CHAR(64) NOT NULL,
  prerequisite_fingerprint CHAR(64) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  handed_off_by INT NOT NULL,
  handed_off_by_role VARCHAR(20) NOT NULL CHECK (handed_off_by_role = 'registrar'),
  handed_off_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  activation_attempt_status VARCHAR(32) NOT NULL DEFAULT 'awaiting_finance'
    CHECK (activation_attempt_status IN ('awaiting_finance', 'academic_review_required', 'registrar_review_required', 'retry_required', 'activated')),
  last_activation_attempt_at DATETIME(6) NULL,
  last_activation_error_code VARCHAR(40) NULL,
  CONSTRAINT UQ_annual_registrar_handoff_idempotency UNIQUE (idempotency_key),
  CONSTRAINT UQ_annual_registrar_handoff_version UNIQUE (annual_enrollment_id, handoff_version),
  CONSTRAINT UQ_annual_registrar_handoff_context UNIQUE (id, annual_enrollment_id, student_id, school_year, grade_level),
  CONSTRAINT FK_annual_registrar_handoff_annual FOREIGN KEY (annual_enrollment_id, student_id, school_year, grade_level)
    REFERENCES annual_enrollments(id, student_id, school_year, grade_level),
  CONSTRAINT FK_annual_registrar_handoff_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_annual_registrar_handoff_actor FOREIGN KEY (handed_off_by) REFERENCES users(id)
);
CREATE INDEX IX_annual_registrar_handoff_latest
  ON annual_registrar_handoff_events (annual_enrollment_id, handoff_version, handed_off_at);
CREATE INDEX IX_annual_registrar_handoff_pending
  ON annual_registrar_handoff_events (student_id, activation_attempt_status, annual_enrollment_id);

-- Keep legacy confirmation readers working while explicitly linking new-flow compatibility evidence to its Registrar handoff.
ALTER TABLE annual_registrar_confirmations
  ADD registrar_handoff_event_id BIGINT NULL AFTER entry_dp_state_at_confirmation,
  ADD CONSTRAINT UQ_annual_registrar_confirmation_handoff UNIQUE (registrar_handoff_event_id),
  ADD CONSTRAINT FK_annual_registrar_confirmation_handoff_context FOREIGN KEY
    (registrar_handoff_event_id, annual_enrollment_id, student_id, school_year, grade_level)
    REFERENCES annual_registrar_handoff_events (id, annual_enrollment_id, student_id, school_year, grade_level);

-- One activation row is the idempotency boundary for automatic entry-term enrollment.
CREATE TABLE annual_entry_activations (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  student_id INT NOT NULL,
  school_year VARCHAR(20) NOT NULL,
  grade_level VARCHAR(50) NOT NULL,
  entry_enrollment_id INT NOT NULL,
  registrar_handoff_id BIGINT NOT NULL,
  finance_review_id BIGINT NOT NULL,
  assessment_id INT NOT NULL,
  entry_dp_state VARCHAR(24) NOT NULL CHECK (entry_dp_state IN ('settled', 'zero_due')),
  activation_trigger VARCHAR(24) NOT NULL CHECK (activation_trigger IN ('registrar_handoff', 'finance_commit')),
  activated_by INT NOT NULL,
  activated_by_role VARCHAR(20) NOT NULL CHECK (activated_by_role IN ('registrar', 'finance', 'database_admin')),
  activated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT UQ_annual_entry_activation_annual UNIQUE (annual_enrollment_id),
  CONSTRAINT UQ_annual_entry_activation_entry UNIQUE (entry_enrollment_id),
  CONSTRAINT UQ_annual_entry_activation_handoff UNIQUE (registrar_handoff_id),
  CONSTRAINT FK_annual_entry_activation_handoff FOREIGN KEY
    (registrar_handoff_id, annual_enrollment_id, student_id, school_year, grade_level)
    REFERENCES annual_registrar_handoff_events(id, annual_enrollment_id, student_id, school_year, grade_level),
  CONSTRAINT FK_annual_entry_activation_finance_review FOREIGN KEY
    (finance_review_id, annual_enrollment_id, assessment_id)
    REFERENCES annual_finance_assessment_reviews(id, annual_enrollment_id, assessment_id),
  CONSTRAINT FK_annual_entry_activation_annual FOREIGN KEY (annual_enrollment_id, student_id, school_year, grade_level)
    REFERENCES annual_enrollments(id, student_id, school_year, grade_level),
  CONSTRAINT FK_annual_entry_activation_entry FOREIGN KEY (entry_enrollment_id, annual_enrollment_id, student_id)
    REFERENCES enrollments(id, annual_enrollment_id, student_id),
  CONSTRAINT FK_annual_entry_activation_actor FOREIGN KEY (activated_by) REFERENCES users(id)
);
CREATE INDEX IX_annual_entry_activation_student ON annual_entry_activations (student_id, activated_at);
