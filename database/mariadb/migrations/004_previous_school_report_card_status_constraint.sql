-- MariaDB forward-only port of V2 004_previous_school_report_card_status_constraint.sql.
-- Applies only to an empty fresh target database; no SQL Server data is changed.
-- The named constraint is kept in a separate forward-only migration, as in V2.
ALTER TABLE previous_school_report_card_status_events
  ADD CONSTRAINT CK_previous_school_report_card_status_status
  CHECK (status IN ('pending', 'received', 'verified', 'correction', 'rejected'));
