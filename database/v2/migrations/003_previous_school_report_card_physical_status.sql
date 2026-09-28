CREATE TABLE dbo.previous_school_report_card_status_events (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    student_id INT NOT NULL,
    recorded_by INT NOT NULL,
    status NVARCHAR(30) NOT NULL CHECK (status IN ('pending', 'received', 'verified', 'correction', 'rejected')),
    instruction NVARCHAR(1000) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_previous_school_report_card_status_created_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_previous_school_report_card_status_student FOREIGN KEY (student_id) REFERENCES dbo.students(id),
    CONSTRAINT FK_previous_school_report_card_status_recorder FOREIGN KEY (recorded_by) REFERENCES dbo.users(id),
    CONSTRAINT CK_previous_school_report_card_status_correction_instruction CHECK (
        status <> 'correction' OR (instruction IS NOT NULL AND LEN(LTRIM(RTRIM(instruction))) > 0))
);
GO

CREATE INDEX IX_previous_school_report_card_status_student_created
    ON dbo.previous_school_report_card_status_events (student_id, created_at DESC, id DESC);
GO
