-- Full front-desk profile snapshot and registrar-owned balik-aral evaluations.
ALTER TABLE pre_enrollments
  ADD created_by_role VARCHAR(20) NULL,
  ADD applicant_kind VARCHAR(20) NOT NULL DEFAULT 'new',
  ADD email VARCHAR(255) NULL,
  ADD birth_date DATE NULL,
  ADD sex VARCHAR(20) NULL,
  ADD address VARCHAR(500) NULL,
  ADD address_block_lot_street_purok VARCHAR(200) NULL,
  ADD address_barangay VARCHAR(100) NULL,
  ADD address_city VARCHAR(100) NULL,
  ADD address_province VARCHAR(100) NULL,
  ADD address_zip CHAR(4) NULL,
  ADD profile_phone VARCHAR(50) NULL,
  ADD birthplace VARCHAR(160) NULL,
  ADD facebook_name VARCHAR(120) NULL,
  ADD emergency_contact_person VARCHAR(160) NULL,
  ADD emergency_contact_relationship VARCHAR(80) NULL,
  ADD emergency_contact_phone VARCHAR(50) NULL,
  ADD emergency_contact_address VARCHAR(500) NULL,
  ADD emergency_contact_address_block_lot_street_purok VARCHAR(200) NULL,
  ADD emergency_contact_address_barangay VARCHAR(100) NULL,
  ADD emergency_contact_address_city VARCHAR(100) NULL,
  ADD emergency_contact_address_province VARCHAR(100) NULL,
  ADD emergency_contact_address_zip CHAR(4) NULL,
  ADD mother_name VARCHAR(160) NULL,
  ADD mother_phone VARCHAR(50) NULL,
  ADD father_name VARCHAR(160) NULL,
  ADD father_phone VARCHAR(50) NULL,
  ADD readmission_evaluation_id CHAR(36) NULL,
  ADD readmission_evaluation_version INT UNSIGNED NULL,
  ADD CONSTRAINT CK_pre_enrollment_created_by_role CHECK (created_by_role IS NULL OR created_by_role = 'front_desk'),
  ADD CONSTRAINT CK_pre_enrollment_applicant_kind CHECK (applicant_kind IN ('new', 'continuing', 'readmission')),
  ADD CONSTRAINT CK_pre_enrollment_profile_sex CHECK (sex IS NULL OR sex IN ('Male', 'Female', 'Other')),
  ADD CONSTRAINT CK_pre_enrollment_profile_zip CHECK (address_zip IS NULL OR address_zip REGEXP '^[0-9]{4}$'),
  ADD CONSTRAINT CK_pre_enrollment_emergency_profile_zip CHECK (emergency_contact_address_zip IS NULL OR emergency_contact_address_zip REGEXP '^[0-9]{4}$');

CREATE TABLE readmission_evaluations (
  id CHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
  applicant_lrn CHAR(12) NOT NULL,
  student_id INT NULL,
  first_name VARCHAR(100) NOT NULL,
  middle_name VARCHAR(100) NULL,
  last_name VARCHAR(100) NOT NULL,
  suffix VARCHAR(20) NULL,
  school_year VARCHAR(20) NOT NULL,
  target_grade_level VARCHAR(20) NOT NULL,
  prior_progress LONGTEXT NOT NULL,
  evidence_reviewed LONGTEXT NOT NULL,
  form137_supporting TINYINT(1) NOT NULL DEFAULT 0,
  curriculum_comparison LONGTEXT NOT NULL,
  curriculum_review_status VARCHAR(20) NOT NULL DEFAULT 'unresolved',
  required_subjects LONGTEXT NOT NULL,
  subject_availability VARCHAR(20) NOT NULL,
  availability_notes LONGTEXT NULL,
  decision_reason LONGTEXT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'under_review',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by INT NOT NULL,
  updated_by INT NOT NULL,
  decided_by INT NULL,
  decided_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT CK_readmission_evaluation_lrn CHECK (applicant_lrn REGEXP '^[0-9]{12}$'),
  CONSTRAINT CK_readmission_evaluation_grade CHECK (target_grade_level IN ('Grade 11', 'Grade 12')),
  CONSTRAINT CK_readmission_evaluation_availability CHECK (subject_availability IN ('unresolved', 'available', 'unavailable')),
  CONSTRAINT CK_readmission_evaluation_curriculum_status CHECK (curriculum_review_status IN ('unresolved', 'resolved')),
  CONSTRAINT CK_readmission_evaluation_status CHECK (status IN ('under_review', 'accepted', 'not_accepted')),
  CONSTRAINT CK_readmission_evaluation_version CHECK (version > 0),
  CONSTRAINT FK_readmission_evaluation_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_readmission_evaluation_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT FK_readmission_evaluation_updated_by FOREIGN KEY (updated_by) REFERENCES users(id),
  CONSTRAINT FK_readmission_evaluation_decided_by FOREIGN KEY (decided_by) REFERENCES users(id)
);
CREATE INDEX IX_readmission_evaluation_lookup ON readmission_evaluations (applicant_lrn, school_year, target_grade_level, status, updated_at);

CREATE TABLE readmission_evaluation_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  evaluation_id CHAR(36) NOT NULL,
  evaluation_version INT UNSIGNED NOT NULL,
  actor_id INT NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  from_status VARCHAR(24) NULL,
  to_status VARCHAR(24) NOT NULL,
  details_json LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT CK_readmission_evaluation_event_type CHECK (event_type IN ('created', 'updated', 'accepted', 'not_accepted', 'reopened')),
  CONSTRAINT FK_readmission_evaluation_event_evaluation FOREIGN KEY (evaluation_id) REFERENCES readmission_evaluations(id),
  CONSTRAINT FK_readmission_evaluation_event_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IX_readmission_evaluation_event_history ON readmission_evaluation_events (evaluation_id, created_at, id);

ALTER TABLE pre_enrollments ADD CONSTRAINT FK_pre_enrollment_readmission_evaluation
  FOREIGN KEY (readmission_evaluation_id) REFERENCES readmission_evaluations(id);

ALTER TABLE annual_enrollments
  MODIFY intake_kind VARCHAR(20) NOT NULL DEFAULT 'unspecified',
  ADD readmission_evaluation_id CHAR(36) NULL,
  ADD readmission_evaluation_version INT UNSIGNED NULL;
ALTER TABLE annual_enrollments DROP CONSTRAINT CK_annual_enrollment_intake_kind;
ALTER TABLE annual_enrollments ADD CONSTRAINT CK_annual_enrollment_intake_kind
  CHECK (intake_kind IN ('new', 'returning', 'transferee', 'continuing', 'readmission', 'unspecified'));
ALTER TABLE annual_enrollments ADD CONSTRAINT FK_annual_enrollment_readmission_evaluation
  FOREIGN KEY (readmission_evaluation_id) REFERENCES readmission_evaluations(id);

ALTER TABLE student_profile_revisions DROP CONSTRAINT CK_student_profile_revision_field;
ALTER TABLE student_profile_revisions MODIFY field_name VARCHAR(60) NOT NULL;
ALTER TABLE student_profile_revisions ADD CONSTRAINT CK_student_profile_revision_field CHECK (field_name IN (
  'student_no', 'lrn', 'first_name', 'middle_name', 'last_name', 'suffix', 'birth_date', 'sex', 'address', 'phone',
  'birthplace', 'facebook_name', 'emergency_contact_person', 'emergency_contact_relationship', 'emergency_contact_phone',
  'emergency_contact_address', 'address_block_lot_street_purok', 'address_barangay', 'address_city', 'address_province',
  'address_zip', 'emergency_contact_address_block_lot_street_purok', 'emergency_contact_address_barangay',
  'emergency_contact_address_city', 'emergency_contact_address_province', 'emergency_contact_address_zip',
  'mother_name', 'mother_phone', 'father_name', 'father_phone', 'email'
));
