-- Finance clearance, debt-increase revisions, and printable claim-slip history.
-- This migration extends the active MariaDB schema without changing its baseline.

ALTER TABLE students
  ADD debt_increase_revision BIGINT UNSIGNED NOT NULL DEFAULT 0;

CREATE TABLE student_document_clearance_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  request_id CHAR(36) NOT NULL,
  actor_id INT NOT NULL,
  event_type VARCHAR(20) NOT NULL
    CHECK (event_type IN ('approved', 'held', 'withdrawn')),
  clearance_status VARCHAR(24) NOT NULL
    CHECK (clearance_status IN ('approved', 'on_hold', 'withdrawn')),
  debt_increase_revision BIGINT UNSIGNED NOT NULL,
  outstanding_snapshot DECIMAL(12,2) NOT NULL CHECK (outstanding_snapshot >= 0),
  reason VARCHAR(1000) NULL,
  payment_arrangement VARCHAR(1000) NULL,
  finance_note VARCHAR(1000) NULL,
  ledger_review_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_document_clearance_request FOREIGN KEY (request_id) REFERENCES student_document_requests(id),
  CONSTRAINT FK_document_clearance_actor FOREIGN KEY (actor_id) REFERENCES users(id),
  CONSTRAINT CK_document_clearance_details CHECK (
    (event_type = 'approved' AND clearance_status = 'approved' AND ledger_review_confirmed = 1
      AND ((outstanding_snapshot = 0 AND reason IS NULL AND payment_arrangement IS NULL)
        OR (outstanding_snapshot > 0 AND reason IS NOT NULL AND CHAR_LENGTH(TRIM(reason)) >= 5
          AND payment_arrangement IS NOT NULL AND CHAR_LENGTH(TRIM(payment_arrangement)) >= 5)))
    OR (event_type = 'held' AND clearance_status = 'on_hold' AND reason IS NOT NULL
      AND CHAR_LENGTH(TRIM(reason)) >= 5 AND payment_arrangement IS NULL AND ledger_review_confirmed = 0)
    OR (event_type = 'withdrawn' AND clearance_status = 'withdrawn' AND reason IS NOT NULL
      AND CHAR_LENGTH(TRIM(reason)) >= 5 AND payment_arrangement IS NULL AND ledger_review_confirmed = 0)
  )
);
CREATE INDEX IX_document_clearance_request_history ON student_document_clearance_events (request_id, created_at, id);
CREATE UNIQUE INDEX UX_document_clearance_idempotency ON student_document_clearance_events (request_id, idempotency_key);

CREATE TABLE student_document_claim_slips (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  request_id CHAR(36) NOT NULL,
  finance_approval_event_id BIGINT NOT NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('issued', 'rescheduled')),
  expected_claim_date DATE NOT NULL,
  previous_claim_date DATE NULL,
  reason VARCHAR(500) NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  issued_by INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_document_claim_slip_request FOREIGN KEY (request_id) REFERENCES student_document_requests(id),
  CONSTRAINT FK_document_claim_slip_approval FOREIGN KEY (finance_approval_event_id) REFERENCES student_document_clearance_events(id),
  CONSTRAINT FK_document_claim_slip_issuer FOREIGN KEY (issued_by) REFERENCES users(id),
  CONSTRAINT UQ_document_claim_slip_idempotency UNIQUE (request_id, idempotency_key),
  CONSTRAINT CK_document_claim_slip_history CHECK (
    (event_type = 'issued' AND previous_claim_date IS NULL AND reason IS NULL)
    OR (event_type = 'rescheduled' AND previous_claim_date IS NOT NULL AND reason IS NOT NULL
      AND CHAR_LENGTH(TRIM(reason)) >= 5)
  )
);
CREATE INDEX IX_document_claim_slip_history ON student_document_claim_slips (request_id, created_at, id);

ALTER TABLE student_document_requests
  ADD expected_claim_date DATE NULL,
  ADD handover_reference VARCHAR(200) NULL,
  ADD current_claim_slip_id BIGINT NULL,
  ADD CONSTRAINT FK_document_request_current_claim_slip FOREIGN KEY (current_claim_slip_id) REFERENCES student_document_claim_slips(id);

ALTER TABLE student_document_request_events
  ADD handover_reference_before VARCHAR(200) NULL,
  ADD handover_reference_after VARCHAR(200) NULL,
  ADD handover_reference VARCHAR(200) NULL;
