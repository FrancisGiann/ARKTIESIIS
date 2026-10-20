-- Registrar-reviewed retake referrals with Finance-only item decisions.
-- Referral versions preserve the linked Finance item identity across corrections.

CREATE TABLE registrar_retake_referrals (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  revision_no INT UNSIGNED NOT NULL,
  intake_kind_snapshot VARCHAR(20) NOT NULL,
  evaluation_reference VARCHAR(160) NOT NULL,
  readmission_evaluation_id CHAR(36) NULL,
  readmission_evaluation_version INT UNSIGNED NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  idempotency_key CHAR(36) NOT NULL,
  created_by INT NOT NULL,
  finalized_by INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  finalized_at DATETIME(3) NULL,
  current_annual_enrollment_id INT AS (CASE WHEN is_current = 1 THEN annual_enrollment_id ELSE NULL END) STORED,
  CONSTRAINT UQ_registrar_retake_referral_revision UNIQUE (annual_enrollment_id, revision_no),
  CONSTRAINT UQ_registrar_retake_referral_key UNIQUE (idempotency_key),
  CONSTRAINT UQ_registrar_retake_referral_context UNIQUE (id, annual_enrollment_id),
  CONSTRAINT CK_registrar_retake_referral_kind CHECK (intake_kind_snapshot IN ('transferee', 'returning', 'readmission')),
  CONSTRAINT CK_registrar_retake_referral_status CHECK (status IN ('draft', 'finalized')),
  CONSTRAINT CK_registrar_retake_referral_finalization CHECK (
    (status = 'draft' AND finalized_by IS NULL AND finalized_at IS NULL) OR
    (status = 'finalized' AND finalized_by IS NOT NULL AND finalized_at IS NOT NULL)
  ),
  CONSTRAINT CK_registrar_retake_referral_evaluation CHECK (
    (readmission_evaluation_id IS NULL AND readmission_evaluation_version IS NULL) OR
    (readmission_evaluation_id IS NOT NULL AND readmission_evaluation_version > 0)
  ),
  CONSTRAINT FK_registrar_retake_referral_annual FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_registrar_retake_referral_readmission FOREIGN KEY (readmission_evaluation_id) REFERENCES readmission_evaluations(id),
  CONSTRAINT FK_registrar_retake_referral_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT FK_registrar_retake_referral_finalizer FOREIGN KEY (finalized_by) REFERENCES users(id)
);

CREATE UNIQUE INDEX UX_registrar_retake_referral_current
  ON registrar_retake_referrals (current_annual_enrollment_id);
CREATE INDEX IX_registrar_retake_referral_finance_queue
  ON registrar_retake_referrals (status, is_current, created_at, id);

CREATE TABLE registrar_retake_item_keys (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_registrar_retake_item_key UNIQUE (idempotency_key),
  CONSTRAINT UQ_registrar_retake_item_key_context UNIQUE (id, annual_enrollment_id),
  CONSTRAINT FK_registrar_retake_item_key_annual FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id)
);

CREATE TABLE registrar_retake_referral_items (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  referral_id BIGINT NOT NULL,
  annual_enrollment_id INT NOT NULL,
  item_key_id BIGINT NOT NULL,
  subject_name VARCHAR(120) NOT NULL,
  subject_id INT NULL,
  target_term_number TINYINT NOT NULL,
  finance_explanation VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_registrar_retake_item_revision UNIQUE (referral_id, item_key_id),
  CONSTRAINT UQ_registrar_retake_item_context UNIQUE (id, referral_id, annual_enrollment_id),
  CONSTRAINT CK_registrar_retake_item_term CHECK (target_term_number BETWEEN 1 AND 3),
  CONSTRAINT FK_registrar_retake_item_referral FOREIGN KEY (referral_id, annual_enrollment_id)
    REFERENCES registrar_retake_referrals (id, annual_enrollment_id),
  CONSTRAINT FK_registrar_retake_item_key FOREIGN KEY (item_key_id, annual_enrollment_id)
    REFERENCES registrar_retake_item_keys (id, annual_enrollment_id),
  CONSTRAINT FK_registrar_retake_item_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
);

CREATE INDEX IX_registrar_retake_item_referral ON registrar_retake_referral_items (referral_id, target_term_number, id);
CREATE INDEX IX_registrar_retake_item_key ON registrar_retake_referral_items (item_key_id, referral_id);

CREATE TABLE finance_retake_item_decisions (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  item_key_id BIGINT NOT NULL,
  referral_item_id BIGINT NOT NULL,
  decision VARCHAR(16) NOT NULL,
  approved_amount DECIMAL(12,2) NULL,
  charge_description VARCHAR(120) NULL,
  decision_reason VARCHAR(1000) NOT NULL,
  charge_id BIGINT NULL,
  reviewed_by INT NOT NULL,
  reviewed_by_role VARCHAR(20) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  reviewed_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  superseded_at DATETIME(3) NULL,
  current_item_key_id BIGINT AS (CASE WHEN superseded_at IS NULL THEN item_key_id ELSE NULL END) STORED,
  charge_item_key_id BIGINT AS (CASE WHEN decision = 'charge' THEN item_key_id ELSE NULL END) STORED,
  CONSTRAINT UQ_finance_retake_item_decision_current UNIQUE (current_item_key_id),
  CONSTRAINT UQ_finance_retake_item_decision_charge_item UNIQUE (charge_item_key_id),
  CONSTRAINT UQ_finance_retake_item_decision_charge UNIQUE (charge_id),
  CONSTRAINT UQ_finance_retake_item_decision_key UNIQUE (idempotency_key),
  CONSTRAINT CK_finance_retake_item_decision_type CHECK (decision IN ('charge', 'no_charge')),
  CONSTRAINT CK_finance_retake_item_decision_role CHECK (reviewed_by_role IN ('finance', 'database_admin')),
  CONSTRAINT CK_finance_retake_item_decision_shape CHECK (
    (decision = 'charge' AND approved_amount > 0 AND charge_description IS NOT NULL AND charge_id IS NOT NULL) OR
    (decision = 'no_charge' AND approved_amount IS NULL AND charge_description IS NULL AND charge_id IS NULL)
  ),
  CONSTRAINT CK_finance_retake_item_decision_supersession CHECK (decision = 'no_charge' OR superseded_at IS NULL),
  CONSTRAINT FK_finance_retake_item_decision_key FOREIGN KEY (item_key_id) REFERENCES registrar_retake_item_keys(id),
  CONSTRAINT FK_finance_retake_item_decision_revision FOREIGN KEY (referral_item_id) REFERENCES registrar_retake_referral_items(id),
  CONSTRAINT FK_finance_retake_item_decision_charge FOREIGN KEY (charge_id) REFERENCES assessed_charges(id),
  CONSTRAINT FK_finance_retake_item_decision_actor FOREIGN KEY (reviewed_by) REFERENCES users(id)
);

CREATE TABLE registrar_retake_referral_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  referral_id BIGINT NOT NULL,
  actor_id INT NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  details_json LONGTEXT NOT NULL CHECK (JSON_VALID(details_json) = 1),
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT CK_registrar_retake_referral_event_type CHECK (event_type IN ('created', 'reference_updated', 'item_added', 'item_updated', 'item_removed', 'finalized', 'correction_started')),
  CONSTRAINT FK_registrar_retake_referral_event_referral FOREIGN KEY (referral_id) REFERENCES registrar_retake_referrals(id),
  CONSTRAINT FK_registrar_retake_referral_event_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);

CREATE INDEX IX_registrar_retake_referral_event_history
  ON registrar_retake_referral_events (referral_id, created_at, id);
