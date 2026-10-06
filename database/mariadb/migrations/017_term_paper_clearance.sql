-- Registrar-managed paper clearance requirements and audited term applicability.
-- Paper signatures remain on the school's existing printed form.

ALTER TABLE annual_enrollments
  ADD continuity_source_annual_enrollment_id INT NULL,
  ADD CONSTRAINT FK_annual_enrollment_continuity_source
    FOREIGN KEY (continuity_source_annual_enrollment_id) REFERENCES annual_enrollments(id);

ALTER TABLE annual_registrar_confirmations
  ADD input_fingerprint CHAR(64) NULL,
  ADD clearance_snapshot_fingerprint CHAR(64) NULL;

CREATE TABLE annual_continuity_source_events (
  id BIGINT UNSIGNED AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  source_annual_enrollment_id INT NOT NULL,
  student_id INT NOT NULL,
  actor_id INT NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  UNIQUE KEY UQ_annual_continuity_source_event_token (idempotency_key),
  CONSTRAINT CK_annual_continuity_source_event_reason CHECK (CHAR_LENGTH(TRIM(reason)) >= 5),
  CONSTRAINT FK_annual_continuity_source_event_annual FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_annual_continuity_source_event_source FOREIGN KEY (source_annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_annual_continuity_source_event_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_annual_continuity_source_event_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IX_annual_continuity_source_event_history ON annual_continuity_source_events (annual_enrollment_id, created_at, id);

CREATE TABLE term_clearance_templates (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  grade_level VARCHAR(50) NOT NULL,
  track_label VARCHAR(80) NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'approved',
  teacher_roster_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  paper_form_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  laboratory_rows_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  UNIQUE KEY UQ_term_clearance_template_version (grade_level, track_label, version_no),
  UNIQUE KEY UQ_term_clearance_template_token (idempotency_key),
  CONSTRAINT CK_term_clearance_template_grade CHECK (grade_level IN ('Grade 11', 'Grade 12')),
  CONSTRAINT CK_term_clearance_template_version CHECK (version_no > 0),
  CONSTRAINT CK_term_clearance_template_status CHECK (status IN ('approved', 'superseded')),
  CONSTRAINT CK_term_clearance_template_confirmations CHECK (teacher_roster_confirmed = 1 AND paper_form_confirmed = 1 AND laboratory_rows_confirmed = 1),
  CONSTRAINT FK_term_clearance_template_creator FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IX_term_clearance_template_lookup ON term_clearance_templates (grade_level, status, track_label, version_no);

CREATE TABLE term_clearance_template_items (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  template_id INT NOT NULL,
  category VARCHAR(20) NOT NULL,
  label VARCHAR(120) NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  UNIQUE KEY UQ_term_clearance_template_item_order (template_id, sort_order),
  CONSTRAINT CK_term_clearance_template_item_category CHECK (category IN ('registrar', 'guidance', 'finance', 'laboratory')),
  CONSTRAINT FK_term_clearance_template_item_template FOREIGN KEY (template_id) REFERENCES term_clearance_templates(id)
);

CREATE TABLE student_term_clearances (
  id BIGINT UNSIGNED AUTO_INCREMENT NOT NULL PRIMARY KEY,
  enrollment_id INT NOT NULL,
  annual_enrollment_id INT NOT NULL,
  student_id INT NOT NULL,
  template_id INT NULL,
  grade_level_snapshot VARCHAR(50) NOT NULL,
  school_year_snapshot VARCHAR(20) NOT NULL,
  term_label_snapshot VARCHAR(100) NOT NULL,
  academic_term_id_snapshot INT NOT NULL,
  term_number_snapshot TINYINT NULL,
  section_id_snapshot INT NULL,
  section_name_snapshot VARCHAR(100) NULL,
  section_cluster_snapshot VARCHAR(80) NULL,
  section_strand_snapshot VARCHAR(80) NULL,
  track_label_snapshot VARCHAR(80) NULL,
  scope_status VARCHAR(20) NOT NULL DEFAULT 'unreviewed',
  scope_reason VARCHAR(1000) NULL,
  inspected_on DATE NULL,
  attested_by INT NULL,
  attested_at DATETIME(3) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  UNIQUE KEY UQ_student_term_clearance_enrollment (enrollment_id),
  UNIQUE KEY UQ_student_term_clearance_owner (id, student_id, annual_enrollment_id),
  CONSTRAINT CK_student_term_clearance_scope CHECK (scope_status IN ('unreviewed', 'attended', 'not_attended')),
  CONSTRAINT CK_student_term_clearance_scope_reason CHECK (
    scope_status <> 'not_attended' OR (scope_reason IS NOT NULL AND CHAR_LENGTH(TRIM(scope_reason)) >= 5)
  ),
  CONSTRAINT CK_student_term_clearance_number CHECK (term_number_snapshot IS NULL OR term_number_snapshot BETWEEN 1 AND 3),
  CONSTRAINT CK_student_term_clearance_version CHECK (version > 0),
  CONSTRAINT CK_student_term_clearance_attestation CHECK (
    ((attested_by IS NULL AND attested_at IS NULL)
      OR (attested_by IS NOT NULL AND attested_at IS NOT NULL AND scope_status = 'attended' AND template_id IS NOT NULL))
    AND (inspected_on IS NULL OR (scope_status = 'attended' AND template_id IS NOT NULL))
  ),
  CONSTRAINT FK_student_term_clearance_enrollment FOREIGN KEY (enrollment_id, annual_enrollment_id, student_id)
    REFERENCES enrollments(id, annual_enrollment_id, student_id),
  CONSTRAINT FK_student_term_clearance_annual FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_student_term_clearance_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_student_term_clearance_template FOREIGN KEY (template_id) REFERENCES term_clearance_templates(id),
  CONSTRAINT FK_student_term_clearance_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT FK_student_term_clearance_attestor FOREIGN KEY (attested_by) REFERENCES users(id)
);
CREATE INDEX IX_student_term_clearance_student ON student_term_clearances (student_id, school_year_snapshot, term_number_snapshot, id);
CREATE INDEX IX_student_term_clearance_annual ON student_term_clearances (annual_enrollment_id, term_number_snapshot, id);

CREATE TABLE student_term_clearance_items (
  id BIGINT UNSIGNED AUTO_INCREMENT NOT NULL PRIMARY KEY,
  clearance_id BIGINT UNSIGNED NOT NULL,
  template_item_id INT NULL,
  category VARCHAR(20) NOT NULL,
  label_snapshot VARCHAR(120) NOT NULL,
  subject_id INT NULL,
  student_subject_id INT NULL,
  subject_code_snapshot VARCHAR(50) NULL,
  subject_name_snapshot VARCHAR(200) NULL,
  teacher_assignment_id INT NULL,
  teacher_user_id INT NULL,
  teacher_name_snapshot VARCHAR(240) NULL,
  teacher_context_status VARCHAR(20) NULL,
  applicability_status VARCHAR(20) NOT NULL DEFAULT 'required',
  applicability_reason VARCHAR(1000) NULL,
  signature_present TINYINT(1) NOT NULL DEFAULT 0,
  signer_name VARCHAR(160) NULL,
  paper_signed_on DATE NULL,
  signer_context_reason VARCHAR(1000) NULL,
  sort_order SMALLINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  UNIQUE KEY UQ_student_term_clearance_item_order (clearance_id, sort_order),
  CONSTRAINT CK_student_term_clearance_item_category CHECK (category IN ('teacher', 'registrar', 'guidance', 'finance', 'laboratory')),
  CONSTRAINT CK_student_term_clearance_item_applicability CHECK (applicability_status IN ('unreviewed', 'required', 'not_applicable')),
  CONSTRAINT CK_student_term_clearance_item_teacher_context CHECK (teacher_context_status IS NULL OR teacher_context_status IN ('assigned', 'revoked', 'missing', 'ambiguous')),
  CONSTRAINT CK_student_term_clearance_item_teacher_subject CHECK (
    category <> 'teacher' OR (teacher_context_status IS NOT NULL AND subject_name_snapshot IS NOT NULL AND CHAR_LENGTH(TRIM(subject_name_snapshot)) > 0)
  ),
  CONSTRAINT CK_student_term_clearance_item_signature CHECK (
    (signature_present = 0 AND signer_name IS NULL AND paper_signed_on IS NULL)
    OR (signature_present = 1 AND signer_name IS NOT NULL AND CHAR_LENGTH(TRIM(signer_name)) > 0)
  ),
  CONSTRAINT CK_student_term_clearance_item_exclusion CHECK (
    applicability_status <> 'not_applicable' OR (category = 'laboratory' AND applicability_reason IS NOT NULL AND CHAR_LENGTH(TRIM(applicability_reason)) >= 5)
  ),
  CONSTRAINT CK_student_term_clearance_item_teacher_reason CHECK (
    category <> 'teacher' OR teacher_context_status = 'assigned' OR signature_present = 0
    OR (signer_context_reason IS NOT NULL AND CHAR_LENGTH(TRIM(signer_context_reason)) >= 5)
  ),
  CONSTRAINT FK_student_term_clearance_item_clearance FOREIGN KEY (clearance_id) REFERENCES student_term_clearances(id),
  CONSTRAINT FK_student_term_clearance_item_template FOREIGN KEY (template_item_id) REFERENCES term_clearance_template_items(id)
);
CREATE INDEX IX_student_term_clearance_items_clearance ON student_term_clearance_items (clearance_id, category, sort_order);

CREATE TABLE student_term_clearance_events (
  id BIGINT UNSIGNED AUTO_INCREMENT NOT NULL PRIMARY KEY,
  clearance_id BIGINT UNSIGNED NOT NULL,
  actor_id INT NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  reason VARCHAR(1000) NULL,
  before_json LONGTEXT NULL CHECK (before_json IS NULL OR JSON_VALID(before_json) = 1),
  after_json LONGTEXT NOT NULL CHECK (JSON_VALID(after_json) = 1),
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  UNIQUE KEY UQ_student_term_clearance_event_token (idempotency_key),
  CONSTRAINT CK_student_term_clearance_event_type CHECK (event_type IN ('created', 'scope_reviewed', 'items_updated', 'attested', 'reopened')),
  CONSTRAINT FK_student_term_clearance_event_clearance FOREIGN KEY (clearance_id) REFERENCES student_term_clearances(id),
  CONSTRAINT FK_student_term_clearance_event_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IX_student_term_clearance_event_history ON student_term_clearance_events (clearance_id, created_at, id);

CREATE TABLE annual_term_finalizations (
  id BIGINT UNSIGNED AUTO_INCREMENT NOT NULL PRIMARY KEY,
  enrollment_id INT NOT NULL,
  student_id INT NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  input_fingerprint CHAR(64) NOT NULL,
  clearance_snapshot_fingerprint CHAR(64) NOT NULL,
  result_json LONGTEXT NOT NULL CHECK (JSON_VALID(result_json) = 1),
  finalized_by INT NOT NULL,
  finalized_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  UNIQUE KEY UQ_annual_term_finalization_enrollment (enrollment_id),
  UNIQUE KEY UQ_annual_term_finalization_token (idempotency_key),
  CONSTRAINT FK_annual_term_finalization_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments(id),
  CONSTRAINT FK_annual_term_finalization_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_annual_term_finalization_actor FOREIGN KEY (finalized_by) REFERENCES users(id)
);
