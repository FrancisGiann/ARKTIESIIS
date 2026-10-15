-- Preserve Finance review of the exact annual assessment before Registrar enrollment confirmation.
-- Rows are append-only application evidence; role is captured at decision time.

CREATE TABLE annual_finance_assessment_reviews (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  assessment_id INT NOT NULL,
  schedule_id INT NOT NULL,
  schedule_version INT NOT NULL,
  voucher_code_snapshot VARCHAR(10) NOT NULL CHECK (voucher_code_snapshot IN ('PUB', 'ESC', 'NV')),
  current_voucher_code_snapshot VARCHAR(10) NOT NULL CHECK (current_voucher_code_snapshot IN ('PUB', 'ESC', 'NV')),
  voucher_review_event_id BIGINT NULL,
  selection_json LONGTEXT NOT NULL CHECK (JSON_VALID(selection_json) = 1),
  assessment_fingerprint CHAR(64) NOT NULL,
  dependency_fingerprint CHAR(64) NOT NULL,
  zero_dp_attested TINYINT(1) NOT NULL DEFAULT 0 CHECK (zero_dp_attested IN (0, 1)),
  reviewed_by INT NOT NULL,
  reviewed_by_role VARCHAR(20) NOT NULL CHECK (reviewed_by_role IN ('finance', 'database_admin')),
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  reviewed_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_annual_finance_assessment_review_key UNIQUE (idempotency_key),
  CONSTRAINT UQ_annual_finance_assessment_review_confirmation_context
    UNIQUE (id, annual_enrollment_id, assessment_id),
  CONSTRAINT FK_annual_finance_assessment_review_annual FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_annual_finance_assessment_review_context FOREIGN KEY
    (assessment_id, annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot)
    REFERENCES annual_assessments(id, annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot),
  CONSTRAINT FK_annual_finance_assessment_review_actor FOREIGN KEY (reviewed_by) REFERENCES users(id),
  CONSTRAINT FK_annual_finance_assessment_review_voucher_event FOREIGN KEY (voucher_review_event_id) REFERENCES annual_enrollment_events(id)
);

CREATE INDEX IX_annual_finance_assessment_review_latest
  ON annual_finance_assessment_reviews (annual_enrollment_id, assessment_id, reviewed_at, id);

-- Historical confirmations remain valid; only new confirmations record the exact review and DP outcome.
ALTER TABLE annual_registrar_confirmations
  ADD finance_review_id BIGINT NULL AFTER assessment_id,
  ADD entry_dp_state_at_confirmation VARCHAR(24) NULL AFTER finance_review_id,
  ADD CONSTRAINT CK_annual_registrar_confirmation_entry_dp_state CHECK
    (entry_dp_state_at_confirmation IS NULL OR entry_dp_state_at_confirmation IN ('settled', 'zero_due')),
  ADD CONSTRAINT FK_annual_registrar_confirmation_finance_review_context FOREIGN KEY
    (finance_review_id, annual_enrollment_id, assessment_id)
    REFERENCES annual_finance_assessment_reviews (id, annual_enrollment_id, assessment_id);
CREATE INDEX IX_annual_registrar_confirmation_finance_review
  ON annual_registrar_confirmations (finance_review_id);

-- Bind voucher transitions to the exact posted assessment even when legacy DATETIME precision ties timestamps.
ALTER TABLE annual_enrollment_events
  ADD finance_assessment_id INT NULL AFTER annual_enrollment_id,
  ADD CONSTRAINT FK_annual_enrollment_event_finance_assessment FOREIGN KEY (finance_assessment_id)
    REFERENCES annual_assessments(id);
CREATE INDEX IX_annual_enrollment_event_finance_assessment
  ON annual_enrollment_events (finance_assessment_id, created_at, id);
