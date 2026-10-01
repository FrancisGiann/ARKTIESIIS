-- MariaDB read views replacing SQL Server OUTER APPLY latest-event lookups.
-- Views contain no stored program, trigger, definer, or cross-database DDL.
CREATE OR REPLACE VIEW v_document_latest_review_event AS
SELECT event.*
FROM document_review_events AS event
WHERE NOT EXISTS (
  SELECT 1 FROM document_review_events AS newer
  WHERE newer.document_id = event.document_id
    AND (newer.created_at > event.created_at OR (newer.created_at = event.created_at AND newer.id > event.id))
);

CREATE OR REPLACE VIEW v_document_latest_decision_event AS
SELECT event.*
FROM document_decision_events AS event
WHERE NOT EXISTS (
  SELECT 1 FROM document_decision_events AS newer
  WHERE newer.document_id = event.document_id
    AND (newer.created_at > event.created_at OR (newer.created_at = event.created_at AND newer.id > event.id))
);

CREATE OR REPLACE VIEW v_document_latest_validation AS
SELECT validation.*
FROM document_validations AS validation
WHERE NOT EXISTS (
  SELECT 1 FROM document_validations AS newer
  WHERE newer.document_id = validation.document_id
    AND (newer.created_at > validation.created_at OR (newer.created_at = validation.created_at AND newer.id > validation.id))
);

CREATE OR REPLACE VIEW v_form137_latest_status_event AS
SELECT event.*
FROM form137_status_events AS event
WHERE NOT EXISTS (
  SELECT 1 FROM form137_status_events AS newer
  WHERE newer.student_id = event.student_id
    AND (newer.created_at > event.created_at OR (newer.created_at = event.created_at AND newer.id > event.id))
);

CREATE OR REPLACE VIEW v_previous_school_report_card_latest_status_event AS
SELECT event.*
FROM previous_school_report_card_status_events AS event
WHERE NOT EXISTS (
  SELECT 1 FROM previous_school_report_card_status_events AS newer
  WHERE newer.student_id = event.student_id
    AND (newer.created_at > event.created_at OR (newer.created_at = event.created_at AND newer.id > event.id))
);
