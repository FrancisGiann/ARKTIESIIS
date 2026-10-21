-- Keep invitation setup separate from administrative account deactivation.
-- Existing accounts remain immediately usable with invitation_required = 0.
ALTER TABLE users
  ADD invitation_required TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE account_setup_tokens (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  user_id INT NOT NULL,
  created_by INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  email_snapshot VARCHAR(255) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  consumed_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  active_user_id INT GENERATED ALWAYS AS (
    CASE WHEN consumed_at IS NULL AND revoked_at IS NULL THEN user_id ELSE NULL END
  ) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT CK_account_setup_delivery_status CHECK (delivery_status IN ('pending', 'sent', 'failed', 'unknown')),
  CONSTRAINT FK_account_setup_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT FK_account_setup_creator FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE UNIQUE INDEX UX_account_setup_token_hash ON account_setup_tokens (token_hash);
CREATE UNIQUE INDEX UX_account_setup_active_user ON account_setup_tokens (active_user_id);
CREATE INDEX IX_account_setup_user_history ON account_setup_tokens (user_id, created_at, id);
