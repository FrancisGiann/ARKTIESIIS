-- Registrar-led paper pre-enrollment intake, receipt-only checklist, and structured address components.
-- Fail before changing any tables if the baseline role metadata differs from the expected CHECK.
SET @ark_role_check_total = (
  SELECT COUNT(*) FROM information_schema.check_constraints AS checks
  INNER JOIN information_schema.table_constraints AS constraints
    ON constraints.constraint_schema = checks.constraint_schema
    AND constraints.constraint_name = checks.constraint_name
    AND constraints.table_name = checks.table_name
  WHERE constraints.constraint_schema = DATABASE() AND constraints.table_name = 'users'
    AND constraints.constraint_type = 'CHECK' AND LOWER(checks.check_clause) LIKE '%role%'
);
SET @ark_role_check_name = (
  SELECT constraints.constraint_name FROM information_schema.check_constraints AS checks
  INNER JOIN information_schema.table_constraints AS constraints
    ON constraints.constraint_schema = checks.constraint_schema
    AND constraints.constraint_name = checks.constraint_name
    AND constraints.table_name = checks.table_name
  WHERE constraints.constraint_schema = DATABASE() AND constraints.table_name = 'users'
    AND constraints.constraint_type = 'CHECK' AND LOWER(checks.check_clause) LIKE '%role%'
  LIMIT 1
);
SET @ark_role_check_level = (
  SELECT checks.level FROM information_schema.check_constraints AS checks
  INNER JOIN information_schema.table_constraints AS constraints
    ON constraints.constraint_schema = checks.constraint_schema
    AND constraints.constraint_name = checks.constraint_name
    AND constraints.table_name = checks.table_name
  WHERE constraints.constraint_schema = DATABASE() AND constraints.table_name = 'users'
    AND constraints.constraint_type = 'CHECK' AND LOWER(checks.check_clause) LIKE '%role%'
  LIMIT 1
);
SET @ark_role_check_clause = (
  SELECT LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(checks.check_clause, '`', ''), ' ', ''), '(', ''), ')', ''), CHAR(10), ''))
  FROM information_schema.check_constraints AS checks
  INNER JOIN information_schema.table_constraints AS constraints
    ON constraints.constraint_schema = checks.constraint_schema
    AND constraints.constraint_name = checks.constraint_name
    AND constraints.table_name = checks.table_name
  WHERE constraints.constraint_schema = DATABASE() AND constraints.table_name = 'users'
    AND constraints.constraint_type = 'CHECK' AND LOWER(checks.check_clause) LIKE '%role%'
  LIMIT 1
);
SET @ark_role_column_definition_ok = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'role'
    AND LOWER(column_type) = 'varchar(30)' AND is_nullable = 'NO' AND column_default IS NULL
    AND extra = '' AND character_set_name REGEXP '^[A-Za-z0-9_]+$'
    AND collation_name REGEXP '^[A-Za-z0-9_]+$'
);
SET @ark_role_charset = (
  SELECT character_set_name FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'role'
);
SET @ark_role_collation = (
  SELECT collation_name FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'role'
);
SET @ark_role_check_sql = CASE
  WHEN @ark_role_check_total = 1
    AND @ark_role_check_clause = 'rolein''database_admin'',''registrar'',''teacher'',''finance'',''student'''
    AND LOWER(@ark_role_check_level) = 'column'
    AND @ark_role_check_name = 'role'
    AND @ark_role_column_definition_ok = 1
    THEN CONCAT('ALTER TABLE users MODIFY COLUMN `role` VARCHAR(30) CHARACTER SET `',
      REPLACE(@ark_role_charset, '`', '``'), '` COLLATE `', REPLACE(@ark_role_collation, '`', '``'),
      '` NOT NULL, ADD CONSTRAINT CK_users_role CHECK (role IN (''database_admin'',''registrar'',''front_desk'',''teacher'',''finance'',''student''))')
  WHEN @ark_role_check_total = 1
    AND @ark_role_check_clause = 'rolein''database_admin'',''registrar'',''teacher'',''finance'',''student'''
    AND LOWER(@ark_role_check_level) = 'table'
    AND @ark_role_column_definition_ok = 1
    AND @ark_role_check_name IS NOT NULL
    THEN CONCAT('ALTER TABLE users DROP CONSTRAINT `', REPLACE(@ark_role_check_name, '`', '``'),
      '`, ADD CONSTRAINT CK_users_role CHECK (role IN (''database_admin'',''registrar'',''front_desk'',''teacher'',''finance'',''student''))')
  ELSE 'SELECT * FROM __arktiesiis_unexpected_users_role_check__'
END;
PREPARE ark_role_check_stmt FROM @ark_role_check_sql;
EXECUTE ark_role_check_stmt;
DEALLOCATE PREPARE ark_role_check_stmt;

ALTER TABLE students
  ADD address_block_lot_street_purok VARCHAR(200) NULL,
  ADD address_barangay VARCHAR(100) NULL,
  ADD address_city VARCHAR(100) NULL,
  ADD address_province VARCHAR(100) NULL,
  ADD address_zip CHAR(4) NULL,
  ADD emergency_contact_address_block_lot_street_purok VARCHAR(200) NULL,
  ADD emergency_contact_address_barangay VARCHAR(100) NULL,
  ADD emergency_contact_address_city VARCHAR(100) NULL,
  ADD emergency_contact_address_province VARCHAR(100) NULL,
  ADD emergency_contact_address_zip CHAR(4) NULL,
  ADD CONSTRAINT CK_student_address_zip CHECK (address_zip IS NULL OR address_zip REGEXP '^[0-9]{4}$'),
  ADD CONSTRAINT CK_student_emergency_address_zip CHECK (emergency_contact_address_zip IS NULL OR emergency_contact_address_zip REGEXP '^[0-9]{4}$');

ALTER TABLE student_profile_revisions DROP CONSTRAINT CK_student_profile_revision_field;
ALTER TABLE student_profile_revisions MODIFY field_name VARCHAR(60) NOT NULL;
ALTER TABLE student_profile_revisions ADD CONSTRAINT CK_student_profile_revision_field CHECK (field_name IN (
  'student_no', 'lrn', 'first_name', 'middle_name', 'last_name', 'suffix',
  'birth_date', 'sex', 'address', 'phone', 'birthplace', 'facebook_name',
  'emergency_contact_person', 'emergency_contact_relationship', 'emergency_contact_phone',
  'emergency_contact_address', 'mother_name', 'mother_phone', 'father_name', 'father_phone',
  'address_block_lot_street_purok', 'address_barangay', 'address_city', 'address_province', 'address_zip',
  'emergency_contact_address_block_lot_street_purok',
  'emergency_contact_address_barangay', 'emergency_contact_address_city',
  'emergency_contact_address_province', 'emergency_contact_address_zip'
));

CREATE TABLE pre_enrollments (
  id CHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  school_year VARCHAR(20) NOT NULL,
  first_name VARCHAR(100) NULL,
  middle_name VARCHAR(100) NULL,
  last_name VARCHAR(100) NULL,
  suffix VARCHAR(20) NULL,
  lrn VARCHAR(12) NULL,
  complete_lrn VARCHAR(12) GENERATED ALWAYS AS (CASE WHEN lrn REGEXP '^[0-9]{12}$' THEN lrn ELSE NULL END) STORED,
  student_contact_number VARCHAR(50) NULL,
  voucher_type_text VARCHAR(120) NULL,
  voucher_category_text VARCHAR(120) NULL,
  preferred_track VARCHAR(40) NULL,
  preferred_cluster VARCHAR(100) NULL,
  target_grade_level VARCHAR(20) NULL,
  prior_grade_level VARCHAR(80) NULL,
  prior_school VARCHAR(200) NULL,
  student_signature_present TINYINT(1) NOT NULL DEFAULT 0,
  student_signed_date DATE NULL,
  received_by VARCHAR(100) NULL,
  received_date DATE NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by INT NOT NULL,
  updated_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_pre_enrollment_idempotency UNIQUE (idempotency_key),
  CONSTRAINT UQ_pre_enrollment_year_lrn UNIQUE (school_year, complete_lrn),
  CONSTRAINT CK_pre_enrollment_lrn CHECK (lrn IS NULL OR (CHAR_LENGTH(lrn) <= 12 AND lrn NOT REGEXP '[^0-9]')),
  CONSTRAINT CK_pre_enrollment_track CHECK (preferred_track IS NULL OR preferred_track IN ('Academic Track', 'Tech-Pro Track')),
  CONSTRAINT CK_pre_enrollment_cluster CHECK (preferred_cluster IS NULL OR preferred_cluster IN (
    'ASSH (Arts, Social Science, and Humanities)', 'BE (Business & Entrepreneurship)',
    'BE-TECH-PRO HM (Hospitality Management)', 'Hospitality and Tourism',
    'ICT Support & Computer Programming')),
  CONSTRAINT CK_pre_enrollment_grade CHECK (target_grade_level IS NULL OR target_grade_level IN ('Grade 11', 'Grade 12')),
  CONSTRAINT CK_pre_enrollment_status CHECK (status IN ('draft', 'ready_for_registrar', 'enrollment_started')),
  CONSTRAINT CK_pre_enrollment_version CHECK (version > 0),
  CONSTRAINT FK_pre_enrollment_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT FK_pre_enrollment_updated_by FOREIGN KEY (updated_by) REFERENCES users(id)
);
CREATE INDEX IX_pre_enrollment_year_status ON pre_enrollments (school_year, status, updated_at, id);
CREATE INDEX IX_pre_enrollment_name ON pre_enrollments (last_name, first_name, id);

CREATE TABLE pre_enrollment_receipts (
  pre_enrollment_id CHAR(36) NOT NULL,
  requirement_code VARCHAR(40) NOT NULL,
  original_received TINYINT(1) NOT NULL DEFAULT 0,
  original_pieces SMALLINT UNSIGNED NULL,
  photocopy_received TINYINT(1) NOT NULL DEFAULT 0,
  photocopy_pieces SMALLINT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (pre_enrollment_id, requirement_code),
  CONSTRAINT CK_pre_enrollment_receipt_code CHECK (requirement_code IN (
    'report_card', 'birth_certificate', 'good_moral', 'junior_high_certificate',
    'certificate_of_rating', 'esc_certificate', 'national_id', 'two_by_two_photos', 'long_brown_envelopes')),
  CONSTRAINT CK_pre_enrollment_receipt_original_count CHECK (original_pieces IS NULL OR original_pieces BETWEEN 1 AND 99),
  CONSTRAINT CK_pre_enrollment_receipt_copy_count CHECK (photocopy_pieces IS NULL OR photocopy_pieces BETWEEN 1 AND 99),
  CONSTRAINT FK_pre_enrollment_receipt_parent FOREIGN KEY (pre_enrollment_id) REFERENCES pre_enrollments(id) ON DELETE CASCADE
);

CREATE TABLE pre_enrollment_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  pre_enrollment_id CHAR(36) NOT NULL,
  actor_id INT NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  version INT UNSIGNED NOT NULL,
  from_status VARCHAR(30) NULL,
  to_status VARCHAR(30) NOT NULL,
  details_json LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT CK_pre_enrollment_event_type CHECK (event_type IN ('created', 'updated', 'submitted_ready', 'enrollment_started')),
  CONSTRAINT FK_pre_enrollment_event_parent FOREIGN KEY (pre_enrollment_id) REFERENCES pre_enrollments(id),
  CONSTRAINT FK_pre_enrollment_event_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IX_pre_enrollment_event_history ON pre_enrollment_events (pre_enrollment_id, created_at, id);

CREATE TABLE pre_enrollment_revisions (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  pre_enrollment_id CHAR(36) NOT NULL,
  revision_group CHAR(36) NOT NULL,
  actor_id INT NOT NULL,
  field_name VARCHAR(80) NOT NULL,
  before_value LONGTEXT NULL,
  after_value LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_pre_enrollment_revision_parent FOREIGN KEY (pre_enrollment_id) REFERENCES pre_enrollments(id),
  CONSTRAINT FK_pre_enrollment_revision_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IX_pre_enrollment_revision_history ON pre_enrollment_revisions (pre_enrollment_id, created_at, id);

ALTER TABLE annual_enrollments ADD pre_enrollment_id CHAR(36) NULL;
ALTER TABLE annual_enrollments ADD CONSTRAINT UQ_annual_enrollment_pre_enrollment UNIQUE (pre_enrollment_id);
ALTER TABLE annual_enrollments ADD CONSTRAINT FK_annual_enrollment_pre_enrollment
  FOREIGN KEY (pre_enrollment_id) REFERENCES pre_enrollments(id);
