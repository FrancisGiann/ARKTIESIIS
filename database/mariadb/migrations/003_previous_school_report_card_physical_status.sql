-- MariaDB forward-only port of V2 003_previous_school_report_card_physical_status.sql.
-- Applies only to an empty fresh target database; no SQL Server data is changed.
CREATE TABLE previous_school_report_card_status_events (
    id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
    student_id INT NOT NULL,
    recorded_by INT NOT NULL,
    status VARCHAR(30) NOT NULL CHECK (status IN ('pending', 'received', 'verified', 'correction', 'rejected')),
    instruction VARCHAR(1000) NULL,
    created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
    CONSTRAINT FK_previous_school_report_card_status_student FOREIGN KEY (student_id) REFERENCES students(id),
    CONSTRAINT FK_previous_school_report_card_status_recorder FOREIGN KEY (recorded_by) REFERENCES users(id),
    CONSTRAINT CK_previous_school_report_card_status_correction_instruction CHECK (
        status <> 'correction' OR (instruction IS NOT NULL AND CHAR_LENGTH(TRIM(instruction)) > 0))
);

CREATE INDEX IX_previous_school_report_card_status_student_created ON previous_school_report_card_status_events (student_id, created_at DESC, id DESC);
