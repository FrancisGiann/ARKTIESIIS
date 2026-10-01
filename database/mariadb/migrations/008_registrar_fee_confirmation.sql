-- MariaDB forward-only port of V2 008_registrar_fee_confirmation.sql.
-- Applies only to an empty fresh target database; no SQL Server data is changed.
/* Registrar confirms the configured payable assessment and entry placement in one workflow. */

ALTER TABLE annual_enrollments ADD CONSTRAINT UQ_annual_enrollment_confirmation_scope
  UNIQUE (id, student_id, school_year, grade_level);
ALTER TABLE enrollments ADD CONSTRAINT UQ_enrollment_confirmation_owner
  UNIQUE (id, annual_enrollment_id, student_id);
ALTER TABLE annual_assessments ADD CONSTRAINT UQ_assessment_confirmation_context
  UNIQUE (id, annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot);
ALTER TABLE finance_schedules ADD CONSTRAINT UQ_schedule_confirmation_context
  UNIQUE (id, school_year, grade_level, voucher_code, version_no);

CREATE TABLE annual_registrar_confirmations (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  student_id INT NOT NULL,
  school_year VARCHAR(20) NOT NULL,
  grade_level VARCHAR(50) NOT NULL,
  entry_enrollment_id INT NOT NULL,
  assessment_id INT NOT NULL,
  schedule_id INT NOT NULL,
  schedule_version INT NOT NULL CHECK (schedule_version > 0),
  voucher_code_snapshot VARCHAR(10) NOT NULL CHECK (voucher_code_snapshot IN ('PUB', 'ESC', 'NV')),
  payable_total DECIMAL(12,2) NOT NULL CHECK (payable_total >= 0),
  selection_json LONGTEXT NOT NULL CHECK (JSON_VALID(selection_json) = 1),
  assessment_snapshot_fingerprint CHAR(64) NOT NULL,
  confirmed_by INT NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  confirmed_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_annual_registrar_confirmation_annual UNIQUE (annual_enrollment_id),
  CONSTRAINT UQ_annual_registrar_confirmation_token UNIQUE (idempotency_key),
  CONSTRAINT FK_annual_registrar_confirmation_annual FOREIGN KEY (annual_enrollment_id, student_id, school_year, grade_level)
    REFERENCES annual_enrollments(id, student_id, school_year, grade_level),
  CONSTRAINT FK_annual_registrar_confirmation_entry FOREIGN KEY (entry_enrollment_id, annual_enrollment_id, student_id)
    REFERENCES enrollments(id, annual_enrollment_id, student_id),
  CONSTRAINT FK_annual_registrar_confirmation_assessment FOREIGN KEY
    (assessment_id, annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot)
    REFERENCES annual_assessments(id, annual_enrollment_id, schedule_id, schedule_version, voucher_code_snapshot),
  CONSTRAINT FK_annual_registrar_confirmation_schedule FOREIGN KEY
    (schedule_id, school_year, grade_level, voucher_code_snapshot, schedule_version)
    REFERENCES finance_schedules(id, school_year, grade_level, voucher_code, version_no),
  CONSTRAINT FK_annual_registrar_confirmation_actor FOREIGN KEY (confirmed_by) REFERENCES users(id)
);
CREATE INDEX IX_annual_registrar_confirmation_student ON annual_registrar_confirmations (student_id, confirmed_at, id);
