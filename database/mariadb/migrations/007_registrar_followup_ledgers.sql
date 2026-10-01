-- MariaDB forward-only port of V2 007_registrar_followup_ledgers.sql.
-- Applies only to an empty fresh target database; no SQL Server data is changed.
CREATE TABLE student_document_requests (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  student_id INT NOT NULL,
  document_type VARCHAR(50) NOT NULL,
  document_name VARCHAR(150) NOT NULL,
  requested_on DATE NOT NULL,
  requested_by INT NOT NULL,
  reference_text VARCHAR(200) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'processing', 'ready', 'released', 'cancelled')),
  released_on DATE NULL,
  recipient VARCHAR(150) NULL,
  create_idempotency_key CHAR(36) NOT NULL,
  create_request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_student_document_request_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_student_document_request_actor FOREIGN KEY (requested_by) REFERENCES users(id),
  CONSTRAINT CK_student_document_request_release CHECK (
    (status = 'released' AND released_on IS NOT NULL AND released_on >= requested_on
      AND recipient IS NOT NULL AND CHAR_LENGTH(TRIM(recipient)) > 0)
    OR (status <> 'released' AND released_on IS NULL AND recipient IS NULL)
  ),
  CONSTRAINT UQ_student_document_request_create_key UNIQUE (requested_by, create_idempotency_key)
);
CREATE INDEX IX_student_document_request_student ON student_document_requests (student_id, requested_on DESC, created_at DESC);

CREATE TABLE student_document_request_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  request_id CHAR(36) NOT NULL,
  actor_id INT NOT NULL,
  event_type VARCHAR(20) NOT NULL
    CHECK (event_type IN ('requested', 'processing', 'ready', 'released', 'cancelled', 'corrected')),
  status_from VARCHAR(20) NULL,
  status_to VARCHAR(20) NOT NULL
    CHECK (status_to IN ('requested', 'processing', 'ready', 'released', 'cancelled')),
  document_type_before VARCHAR(50) NULL,
  document_type_after VARCHAR(50) NULL,
  document_name_before VARCHAR(150) NULL,
  document_name_after VARCHAR(150) NULL,
  requested_on_before DATE NULL,
  requested_on_after DATE NULL,
  reference_before VARCHAR(200) NULL,
  reference_after VARCHAR(200) NULL,
  released_on_before DATE NULL,
  released_on_after DATE NULL,
  recipient_before VARCHAR(150) NULL,
  recipient_after VARCHAR(150) NULL,
  released_on DATE NULL,
  recipient VARCHAR(150) NULL,
  reason VARCHAR(500) NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_student_document_request_event_request FOREIGN KEY (request_id) REFERENCES student_document_requests(id),
  CONSTRAINT FK_student_document_request_event_actor FOREIGN KEY (actor_id) REFERENCES users(id),
  CONSTRAINT UQ_student_document_request_event_key UNIQUE (request_id, idempotency_key),
  CONSTRAINT CK_student_document_request_event_status_pair CHECK (
    (event_type = 'corrected' AND status_from IS NOT NULL AND status_from = status_to)
    OR (event_type <> 'corrected' AND event_type = status_to)
  ),
  CONSTRAINT CK_student_document_request_event_release CHECK (
    (event_type = 'released' AND released_on IS NOT NULL AND requested_on_after IS NOT NULL
      AND released_on >= requested_on_after AND recipient IS NOT NULL AND CHAR_LENGTH(TRIM(recipient)) > 0
      AND released_on_before IS NULL AND released_on_after IS NULL
      AND recipient_before IS NULL AND recipient_after IS NULL)
    OR (event_type = 'corrected' AND status_to = 'released'
      AND released_on IS NULL AND recipient IS NULL
      AND released_on_before IS NOT NULL AND released_on_after IS NOT NULL
      AND requested_on_after IS NOT NULL AND released_on_after >= requested_on_after
      AND recipient_before IS NOT NULL AND CHAR_LENGTH(TRIM(recipient_before)) > 0
      AND recipient_after IS NOT NULL AND CHAR_LENGTH(TRIM(recipient_after)) > 0)
    OR (event_type = 'corrected' AND status_to <> 'released'
      AND released_on IS NULL AND recipient IS NULL
      AND released_on_before IS NULL AND released_on_after IS NULL
      AND recipient_before IS NULL AND recipient_after IS NULL)
    OR (event_type NOT IN ('released', 'corrected')
      AND released_on IS NULL AND recipient IS NULL
      AND released_on_before IS NULL AND released_on_after IS NULL
      AND recipient_before IS NULL AND recipient_after IS NULL)
  ),
  CONSTRAINT CK_student_document_request_event_reason CHECK (
    (event_type IN ('cancelled', 'corrected') AND reason IS NOT NULL AND CHAR_LENGTH(TRIM(reason)) >= 5)
    OR (event_type NOT IN ('cancelled', 'corrected'))
  )
);
CREATE INDEX IX_student_document_request_event_history ON student_document_request_events (request_id, created_at, id);

CREATE TABLE student_profile_revisions (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  revision_group CHAR(36) NOT NULL,
  student_id INT NOT NULL,
  actor_id INT NOT NULL,
  field_name VARCHAR(40) NOT NULL,
  before_value LONGTEXT NULL,
  after_value LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_student_profile_revision_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_student_profile_revision_actor FOREIGN KEY (actor_id) REFERENCES users(id),
  CONSTRAINT CK_student_profile_revision_field CHECK (field_name IN (
    'student_no', 'lrn', 'first_name', 'middle_name', 'last_name', 'suffix',
    'birth_date', 'sex', 'address', 'phone'
  ))
);
CREATE INDEX IX_student_profile_revision_history ON student_profile_revisions (student_id, created_at DESC, revision_group);
