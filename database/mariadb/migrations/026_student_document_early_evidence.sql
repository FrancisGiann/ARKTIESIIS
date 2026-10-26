-- Short-lived, server-owned extraction handoff. Final documents and validation history stay in their existing tables.
CREATE TABLE student_document_early_evidence (
  id CHAR(36) NOT NULL PRIMARY KEY,
  actor_id INT NOT NULL,
  student_id INT NOT NULL,
  document_type VARCHAR(60) NOT NULL,
  requirement_assignment_id INT NULL,
  source_document_id INT NULL,
  file_sha256 CHAR(64) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  provider VARCHAR(30) NOT NULL,
  model VARCHAR(100) NOT NULL,
  schema_fingerprint CHAR(64) NOT NULL,
  fields_json LONGTEXT NOT NULL CHECK (JSON_VALID(fields_json) = 1),
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  expires_at DATETIME(3) NOT NULL,
  consumed_document_id INT NULL,
  consumed_at DATETIME(3) NULL,
  CONSTRAINT FK_student_early_actor FOREIGN KEY (actor_id) REFERENCES users(id),
  CONSTRAINT FK_student_early_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_student_early_source FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE CASCADE,
  CONSTRAINT FK_student_early_consumed FOREIGN KEY (consumed_document_id) REFERENCES documents(id) ON DELETE CASCADE,
  CONSTRAINT UQ_student_early_consumed UNIQUE (consumed_document_id),
  CONSTRAINT CK_student_early_consumption CHECK ((consumed_document_id IS NULL AND consumed_at IS NULL)
    OR (consumed_document_id IS NOT NULL AND consumed_at IS NOT NULL))
);
CREATE INDEX IX_student_early_expiry ON student_document_early_evidence (expires_at);
CREATE INDEX IX_student_early_lookup ON student_document_early_evidence (consumed_document_id, actor_id, student_id);
