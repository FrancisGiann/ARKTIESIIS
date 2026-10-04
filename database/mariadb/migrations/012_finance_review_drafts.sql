-- Durable, owner-bound review drafts for Finance writes.
-- Draft results and the underlying finance write are committed by one coordinator transaction.

CREATE TABLE finance_review_drafts (
  id CHAR(36) NOT NULL PRIMARY KEY,
  owner_user_id INT NOT NULL,
  action_type VARCHAR(80) NOT NULL,
  entity_context_json LONGTEXT NOT NULL CHECK (JSON_VALID(entity_context_json) = 1),
  input_json LONGTEXT NOT NULL CHECK (JSON_VALID(input_json) = 1),
  preview_json LONGTEXT NOT NULL CHECK (JSON_VALID(preview_json) = 1),
  dependency_fingerprint CHAR(64) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  session_binding_hmac CHAR(64) NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'committed', 'discarded')),
  review_expires_at DATETIME(3) NOT NULL,
  committed_result_json LONGTEXT NULL CHECK (committed_result_json IS NULL OR JSON_VALID(committed_result_json) = 1),
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_finance_review_draft_owner FOREIGN KEY (owner_user_id) REFERENCES users(id),
  CONSTRAINT UQ_finance_review_draft_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX IX_finance_review_draft_owner_status ON finance_review_drafts (owner_user_id, status, created_at, id);
CREATE INDEX IX_finance_review_draft_review_expiry ON finance_review_drafts (status, review_expires_at);
