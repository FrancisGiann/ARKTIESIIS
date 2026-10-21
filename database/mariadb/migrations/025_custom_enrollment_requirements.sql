-- Add versioned school-owned requirement definitions and per-student annual assignments.
-- Built-in document type identities are retained and seeded before replacing the old CHECK with an FK.

CREATE TABLE requirement_catalog (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  requirement_code VARCHAR(60) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  student_instructions VARCHAR(1000) NOT NULL,
  channel VARCHAR(12) NOT NULL CHECK (channel IN ('paper', 'digital', 'both')),
  is_active TINYINT(1) NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_builtin TINYINT(1) NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  version_no INT NOT NULL DEFAULT 1 CHECK (version_no > 0),
  created_by INT NULL,
  updated_by INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_requirement_catalog_id_code UNIQUE (id, requirement_code),
  CONSTRAINT FK_requirement_catalog_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT FK_requirement_catalog_updater FOREIGN KEY (updated_by) REFERENCES users(id),
  CONSTRAINT CK_requirement_catalog_builtin_identity CHECK (is_builtin = 0 OR requirement_code IN ('form_137','report_card','good_moral','psa_birth_certificate'))
);

INSERT INTO requirement_catalog
  (requirement_code, display_name, student_instructions, channel, is_active, is_builtin)
VALUES
  ('form_137', 'SF10 / Form 137', 'This is recorded through its restricted staff-only paper status history.', 'paper', 1, 1),
  ('report_card', 'Previous-school report-card scan', 'Upload a readable scan of the previous-school report card for staff review. This does not change published grades.', 'digital', 1, 1),
  ('good_moral', 'Good Moral Certificate', 'Upload a readable Good Moral Certificate for staff review.', 'both', 1, 1),
  ('psa_birth_certificate', 'PSA birth certificate', 'Upload a readable PSA birth certificate for staff review.', 'both', 1, 1);

CREATE TABLE requirement_assignments (
  id INT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  requirement_id INT NOT NULL,
  requirement_code VARCHAR(60) NOT NULL,
  student_id INT NOT NULL,
  school_year VARCHAR(20) NOT NULL,
  display_name_snapshot VARCHAR(120) NOT NULL,
  student_instructions_snapshot VARCHAR(1000) NOT NULL,
  channel_snapshot VARCHAR(12) NOT NULL CHECK (channel_snapshot IN ('paper', 'digital', 'both')),
  catalog_version_snapshot INT NOT NULL CHECK (catalog_version_snapshot > 0),
  is_required TINYINT(1) NOT NULL DEFAULT 1 CHECK (is_required IN (0, 1)),
  status VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  withdrawal_reason VARCHAR(1000) NULL,
  version_no INT NOT NULL DEFAULT 1 CHECK (version_no > 0),
  assigned_by INT NOT NULL,
  updated_by INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_requirement_assignment_context UNIQUE (id, student_id, requirement_code),
  CONSTRAINT UQ_requirement_assignment_student_year UNIQUE (student_id, school_year, requirement_code),
  CONSTRAINT FK_requirement_assignment_catalog FOREIGN KEY (requirement_id, requirement_code)
    REFERENCES requirement_catalog (id, requirement_code),
  CONSTRAINT FK_requirement_assignment_student FOREIGN KEY (student_id) REFERENCES students(id),
  CONSTRAINT FK_requirement_assignment_creator FOREIGN KEY (assigned_by) REFERENCES users(id),
  CONSTRAINT FK_requirement_assignment_updater FOREIGN KEY (updated_by) REFERENCES users(id),
  CONSTRAINT CK_requirement_assignment_withdrawal_reason CHECK
    ((status = 'withdrawn' AND withdrawal_reason IS NOT NULL AND CHAR_LENGTH(TRIM(withdrawal_reason)) > 0)
      OR (status = 'active' AND withdrawal_reason IS NULL))
);
CREATE INDEX IX_requirement_assignment_student_year ON requirement_assignments (student_id, school_year, status, id);

CREATE TABLE requirement_assignment_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  assignment_id INT NOT NULL,
  actor_id INT NOT NULL,
  event_type VARCHAR(16) NOT NULL CHECK (event_type IN ('assigned', 'reactivated', 'withdrawn')),
  version_no INT NOT NULL CHECK (version_no > 0),
  details_json LONGTEXT NOT NULL CHECK (JSON_VALID(details_json) = 1),
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT FK_requirement_assignment_event_assignment FOREIGN KEY (assignment_id) REFERENCES requirement_assignments(id),
  CONSTRAINT FK_requirement_assignment_event_actor FOREIGN KEY (actor_id) REFERENCES users(id),
  CONSTRAINT UQ_requirement_assignment_event_version UNIQUE (assignment_id, version_no)
);
CREATE INDEX IX_requirement_assignment_event_history ON requirement_assignment_events (assignment_id, created_at, id);

-- Keep the existing paper event ledger. Custom events carry their assignment and manual source-inspection checklist.
ALTER TABLE student_physical_checklist_events
  ADD requirement_assignment_id INT NULL,
  ADD verification_checklist_json LONGTEXT NULL,
  ADD CONSTRAINT FK_physical_event_requirement_assignment FOREIGN KEY
    (requirement_assignment_id, student_id, requirement_code)
    REFERENCES requirement_assignments (id, student_id, requirement_code),
  ADD CONSTRAINT CK_physical_event_verification_checklist CHECK
    (verification_checklist_json IS NULL OR JSON_VALID(verification_checklist_json) = 1);
CREATE INDEX IX_physical_event_requirement_assignment ON student_physical_checklist_events
  (requirement_assignment_id, created_at, id);

-- The baseline CHECK was the only allowed-value gate. Discover its actual MariaDB-generated name and
-- fail closed if the expected single CHECK is absent/ambiguous. MariaDB removes this column CHECK when
-- the column is rebuilt below; the catalog foreign key replaces it as the allowed-value gate.
SET @ark_document_type_check_count = (
  SELECT COUNT(*) FROM information_schema.check_constraints AS checks
  INNER JOIN information_schema.table_constraints AS constraints
    ON constraints.constraint_schema = checks.constraint_schema
    AND constraints.constraint_name = checks.constraint_name
    AND constraints.table_name = checks.table_name
  WHERE constraints.constraint_schema = DATABASE() AND constraints.table_name = 'documents'
    AND constraints.constraint_type = 'CHECK' AND LOWER(checks.check_clause) LIKE '%document_type%'
);
SET @ark_document_type_check_name = (
  SELECT constraints.constraint_name FROM information_schema.check_constraints AS checks
  INNER JOIN information_schema.table_constraints AS constraints
    ON constraints.constraint_schema = checks.constraint_schema
    AND constraints.constraint_name = checks.constraint_name
    AND constraints.table_name = checks.table_name
  WHERE constraints.constraint_schema = DATABASE() AND constraints.table_name = 'documents'
    AND constraints.constraint_type = 'CHECK' AND LOWER(checks.check_clause) LIKE '%document_type%'
  LIMIT 1
);
SET @ark_document_type_check_sql = CASE
  WHEN @ark_document_type_check_count = 1 AND @ark_document_type_check_name IS NOT NULL
    THEN 'SELECT 1'
  ELSE 'SELECT * FROM __arktiesiis_unexpected_documents_type_check__'
END;
PREPARE ark_document_type_check_stmt FROM @ark_document_type_check_sql;
EXECUTE ark_document_type_check_stmt;
DEALLOCATE PREPARE ark_document_type_check_stmt;

ALTER TABLE documents
  MODIFY document_type VARCHAR(60) NOT NULL,
  ADD requirement_assignment_id INT NULL,
  ADD CONSTRAINT FK_document_requirement_assignment FOREIGN KEY
    (requirement_assignment_id, student_id, document_type)
    REFERENCES requirement_assignments (id, student_id, requirement_code),
  ADD CONSTRAINT FK_documents_requirement_type FOREIGN KEY (document_type)
    REFERENCES requirement_catalog (requirement_code);
CREATE INDEX IX_documents_requirement_assignment ON documents (requirement_assignment_id, created_at, id);
