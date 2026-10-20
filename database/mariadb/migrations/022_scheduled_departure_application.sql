-- Schedule future departures without changing historical case or placement state.
-- Existing cases are explicitly preserved as already applied; no past/future
-- effective date is used to guess whether their placement updates occurred.

ALTER TABLE finance_departure_cases
  ADD application_status VARCHAR(20) NOT NULL DEFAULT 'legacy_applied',
  ADD application_review_reason VARCHAR(40) NULL,
  ADD student_id_at_recording INT NULL,
  ADD school_year_at_recording VARCHAR(20) NULL,
  ADD grade_level_at_recording VARCHAR(20) NULL,
  ADD entry_term_number_at_recording TINYINT NULL,
  ADD intake_kind_at_recording VARCHAR(20) NULL,
  ADD pre_enrollment_id_at_recording CHAR(36) NULL,
  ADD readmission_evaluation_id_at_recording CHAR(36) NULL,
  ADD readmission_evaluation_version_at_recording INT UNSIGNED NULL,
  ADD continuity_source_annual_enrollment_id_at_recording INT NULL,
  ADD application_updated_at DATETIME(3) NULL,
  ADD CONSTRAINT CK_finance_departure_application_status
    CHECK (application_status IN ('scheduled', 'applied', 'needs_review', 'legacy_applied')),
  ADD CONSTRAINT CK_finance_departure_application_review_reason
    CHECK ((application_status = 'needs_review' AND application_review_reason IS NOT NULL)
      OR (application_status <> 'needs_review' AND application_review_reason IS NULL)),
  ADD INDEX IX_finance_departure_application_due (application_status, effective_date, id);

ALTER TABLE finance_departure_case_terms
  ADD enrollment_status_at_recording VARCHAR(20) NULL,
  ADD student_id_at_recording INT NULL,
  ADD annual_enrollment_id_at_recording INT NULL,
  ADD academic_term_id_at_recording INT NULL,
  ADD annual_term_number_at_recording TINYINT NULL,
  ADD school_year_at_recording VARCHAR(20) NULL,
  ADD term_scope_status_at_recording VARCHAR(20) NULL,
  ADD enrollment_status_at_application VARCHAR(20) NULL,
  ADD academic_activity_review_required_at_application TINYINT(1) NULL,
  ADD applied_at DATETIME(3) NULL,
  ADD CONSTRAINT CK_finance_departure_term_snapshot_status
    CHECK (enrollment_status_at_recording IS NULL OR enrollment_status_at_recording IN ('pending_payment', 'enrolled')),
  ADD CONSTRAINT CK_finance_departure_term_applied_status
    CHECK (enrollment_status_at_application IS NULL OR enrollment_status_at_application IN ('pending_payment', 'enrolled'));

CREATE TABLE finance_departure_application_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  departure_case_id BIGINT NOT NULL,
  event_type VARCHAR(20) NOT NULL,
  source VARCHAR(20) NOT NULL,
  actor_id INT NULL,
  actor_role VARCHAR(20) NULL,
  details_json LONGTEXT NOT NULL CHECK (JSON_VALID(details_json) = 1),
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT CK_finance_departure_application_event_type
    CHECK (event_type IN ('scheduled', 'applied', 'needs_review')),
  CONSTRAINT CK_finance_departure_application_event_source
    CHECK (source IN ('registrar', 'system_scheduler')),
  CONSTRAINT CK_finance_departure_application_event_actor
    CHECK ((source = 'registrar' AND actor_id IS NOT NULL AND actor_role IS NOT NULL
        AND actor_role IN ('registrar', 'database_admin'))
      OR (source = 'system_scheduler' AND actor_id IS NULL AND actor_role IS NULL)),
  CONSTRAINT FK_finance_departure_application_event_case
    FOREIGN KEY (departure_case_id) REFERENCES finance_departure_cases(id),
  CONSTRAINT FK_finance_departure_application_event_actor
    FOREIGN KEY (actor_id) REFERENCES users(id)
);
CREATE INDEX IX_finance_departure_application_event_history
  ON finance_departure_application_events (departure_case_id, created_at, id);
