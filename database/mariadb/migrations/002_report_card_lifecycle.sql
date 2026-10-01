-- MariaDB forward-only port of V2 002_report_card_lifecycle.sql.
-- Applies only to an empty fresh target database; no SQL Server data is changed.
-- Add the active/archive distinction to new document rows. The fresh target contains no source rows.
ALTER TABLE documents ADD is_legacy_archive TINYINT(1) NOT NULL DEFAULT 0;
