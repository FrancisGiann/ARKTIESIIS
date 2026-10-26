-- Server-wide early AI reservations. These rows never contain document bytes or extracted fields.
CREATE TABLE student_document_ai_rate_scopes (
  actor_id INT NOT NULL,
  requirement_key VARCHAR(100) NOT NULL,
  PRIMARY KEY (actor_id, requirement_key),
  CONSTRAINT FK_student_ai_scope_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE student_document_ai_attempts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_id INT NOT NULL,
  requirement_key VARCHAR(100) NOT NULL,
  source_document_id INT NULL,
  file_sha256 CHAR(64) NOT NULL,
  correction_bonus TINYINT(1) NOT NULL DEFAULT 0,
  started_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  finished_at DATETIME(3) NULL,
  CONSTRAINT FK_student_ai_attempt_scope FOREIGN KEY (actor_id, requirement_key)
    REFERENCES student_document_ai_rate_scopes(actor_id, requirement_key) ON DELETE CASCADE,
  CONSTRAINT CK_student_ai_attempt_bonus CHECK (correction_bonus IN (0, 1))
);
CREATE INDEX IX_student_ai_attempt_window ON student_document_ai_attempts (actor_id, requirement_key, started_at);
CREATE INDEX IX_student_ai_attempt_cleanup ON student_document_ai_attempts (started_at);
CREATE TABLE student_document_ai_correction_uses (
  actor_id INT NOT NULL,
  source_document_id INT NOT NULL,
  used_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (actor_id, source_document_id),
  CONSTRAINT FK_student_ai_correction_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT FK_student_ai_correction_source FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE CASCADE
);
