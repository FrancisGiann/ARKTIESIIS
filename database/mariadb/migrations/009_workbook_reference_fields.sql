-- MariaDB forward-only port of V2 009_workbook_reference_fields.sql.
-- Applies only to an empty fresh target database; no SQL Server data is changed.
/* Add optional staff-managed profile, annual administration, and finance reference fields. */

ALTER TABLE students ADD birthplace VARCHAR(160) NULL;
ALTER TABLE students ADD facebook_name VARCHAR(120) NULL;
ALTER TABLE students ADD emergency_contact_person VARCHAR(160) NULL;
ALTER TABLE students ADD emergency_contact_relationship VARCHAR(80) NULL;
ALTER TABLE students ADD emergency_contact_phone VARCHAR(50) NULL;
ALTER TABLE students ADD emergency_contact_address VARCHAR(500) NULL;
ALTER TABLE students ADD mother_name VARCHAR(160) NULL;
ALTER TABLE students ADD mother_phone VARCHAR(50) NULL;
ALTER TABLE students ADD father_name VARCHAR(160) NULL;
ALTER TABLE students ADD father_phone VARCHAR(50) NULL;

ALTER TABLE annual_enrollments ADD esc_id VARCHAR(80) NULL;
ALTER TABLE annual_enrollments ADD eform_status VARCHAR(20) NOT NULL DEFAULT 'not_recorded';
ALTER TABLE annual_enrollments ADD eform_remarks VARCHAR(500) NULL;
ALTER TABLE annual_enrollments ADD lis_status VARCHAR(20) NOT NULL DEFAULT 'not_recorded';
ALTER TABLE annual_enrollments ADD lis_remarks VARCHAR(500) NULL;
ALTER TABLE annual_enrollments ADD vms_status VARCHAR(20) NOT NULL DEFAULT 'not_recorded';
ALTER TABLE annual_enrollments ADD vms_remarks VARCHAR(500) NULL;
ALTER TABLE annual_enrollments ADD acquaintance_waiver_status VARCHAR(20) NOT NULL DEFAULT 'not_recorded';
ALTER TABLE annual_enrollments ADD acquaintance_party VARCHAR(120) NULL;
ALTER TABLE annual_enrollments ADD educational_tour_status VARCHAR(24) NOT NULL DEFAULT 'not_recorded';
ALTER TABLE annual_enrollments ADD internal_agreement_remarks VARCHAR(1000) NULL;
ALTER TABLE annual_enrollments ADD modules_claimed_date DATE NULL;
ALTER TABLE annual_enrollments ADD student_id_claimed_date DATE NULL;
ALTER TABLE annual_enrollments ADD uniform_claimed_date DATE NULL;
ALTER TABLE annual_enrollments ADD pe_uniform_claimed_date DATE NULL;
ALTER TABLE annual_enrollments ADD finance_handbook_number VARCHAR(80) NULL;

ALTER TABLE annual_enrollments ADD CONSTRAINT CK_annual_enrollment_eform_status
  CHECK (eform_status IN ('not_recorded', 'pending', 'submitted', 'complete', 'not_applicable'));
ALTER TABLE annual_enrollments ADD CONSTRAINT CK_annual_enrollment_lis_status
  CHECK (lis_status IN ('not_recorded', 'pending', 'submitted', 'complete', 'not_applicable'));
ALTER TABLE annual_enrollments ADD CONSTRAINT CK_annual_enrollment_vms_status
  CHECK (vms_status IN ('not_recorded', 'pending', 'submitted', 'complete', 'not_applicable'));
ALTER TABLE annual_enrollments ADD CONSTRAINT CK_annual_enrollment_acquaintance_status
  CHECK (acquaintance_waiver_status IN ('not_recorded', 'complete', 'not_applicable'));
ALTER TABLE annual_enrollments ADD CONSTRAINT CK_annual_enrollment_tour_status
  CHECK (educational_tour_status IN ('not_recorded', 'participating', 'not_participating'));

CREATE TABLE annual_enrollment_admin_revisions (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  revision_group CHAR(36) NOT NULL,
  annual_enrollment_id INT NOT NULL,
  actor_id INT NOT NULL,
  field_name VARCHAR(50) NOT NULL,
  before_value LONGTEXT NULL,
  after_value LONGTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_annual_enrollment_admin_revision_annual FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_annual_enrollment_admin_revision_actor FOREIGN KEY (actor_id) REFERENCES users(id),
  CONSTRAINT CK_annual_enrollment_admin_revision_field CHECK (field_name IN (
    'esc_id', 'eform_status', 'eform_remarks', 'lis_status', 'lis_remarks', 'vms_status', 'vms_remarks',
    'acquaintance_waiver_status', 'acquaintance_party', 'educational_tour_status', 'internal_agreement_remarks',
    'modules_claimed_date', 'student_id_claimed_date', 'uniform_claimed_date', 'pe_uniform_claimed_date'
  ))
);
CREATE INDEX IX_annual_enrollment_admin_revision_history ON annual_enrollment_admin_revisions (annual_enrollment_id, created_at DESC, revision_group);

/* Existing profile history gains the optional fields without changing its append-only behavior. */
ALTER TABLE student_profile_revisions DROP CONSTRAINT CK_student_profile_revision_field;
ALTER TABLE student_profile_revisions MODIFY field_name VARCHAR(50) NOT NULL;
ALTER TABLE student_profile_revisions ADD CONSTRAINT CK_student_profile_revision_field CHECK (field_name IN (
  'student_no', 'lrn', 'first_name', 'middle_name', 'last_name', 'suffix',
  'birth_date', 'sex', 'address', 'phone', 'birthplace', 'facebook_name',
  'emergency_contact_person', 'emergency_contact_relationship', 'emergency_contact_phone',
  'emergency_contact_address', 'mother_name', 'mother_phone', 'father_name', 'father_phone'
));

CREATE TABLE finance_fee_comment_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  charge_id BIGINT NOT NULL,
  actor_id INT NOT NULL,
  comment VARCHAR(1000) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_finance_fee_comment_charge FOREIGN KEY (charge_id) REFERENCES assessed_charges(id),
  CONSTRAINT FK_finance_fee_comment_actor FOREIGN KEY (actor_id) REFERENCES users(id),
  CONSTRAINT UQ_finance_fee_comment_token UNIQUE (idempotency_key)
);
CREATE INDEX IX_finance_fee_comment_charge_history ON finance_fee_comment_events (charge_id, created_at, id);

CREATE TABLE finance_handbook_number_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  actor_id INT NOT NULL,
  before_value VARCHAR(80) NULL,
  after_value VARCHAR(80) NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_finance_handbook_event_annual FOREIGN KEY (annual_enrollment_id) REFERENCES annual_enrollments(id),
  CONSTRAINT FK_finance_handbook_event_actor FOREIGN KEY (actor_id) REFERENCES users(id),
  CONSTRAINT UQ_finance_handbook_event_token UNIQUE (idempotency_key)
);
CREATE INDEX IX_finance_handbook_event_history ON finance_handbook_number_events (annual_enrollment_id, created_at, id);
