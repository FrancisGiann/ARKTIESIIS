/* Student account setup, pending enrollment payment clearance, and first-login password change. */
SET XACT_ABORT ON;
GO

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE [version] = '012')
    BEGIN
        IF COL_LENGTH('dbo.users', 'must_change_password') IS NULL
        BEGIN
            ALTER TABLE dbo.users ADD must_change_password BIT NOT NULL
                CONSTRAINT DF_users_must_change_password DEFAULT 0;
        END;

        IF COL_LENGTH('dbo.enrollments', 'finalized_at') IS NULL
        BEGIN
            ALTER TABLE dbo.enrollments ADD finalized_at DATETIME2 NULL;
        END;

        IF OBJECT_ID('dbo.enrollment_clearances', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.enrollment_clearances (
                enrollment_id INT NOT NULL PRIMARY KEY,
                clearance_status NVARCHAR(20) NOT NULL CONSTRAINT DF_enrollment_clearance_status DEFAULT N'pending',
                payment_transaction_id INT NULL,
                cleared_by INT NULL,
                cleared_at DATETIME2 NULL,
                created_by INT NOT NULL,
                created_for_intake BIT NOT NULL CONSTRAINT DF_enrollment_clearance_created_for_intake DEFAULT 0,
                created_at DATETIME2 NOT NULL CONSTRAINT DF_enrollment_clearance_created_at DEFAULT SYSUTCDATETIME(),
                CONSTRAINT CK_enrollment_clearance_status CHECK (
                    (clearance_status = N'pending' AND payment_transaction_id IS NULL AND cleared_by IS NULL AND cleared_at IS NULL)
                    OR
                    (clearance_status = N'cleared' AND payment_transaction_id IS NOT NULL AND cleared_by IS NOT NULL AND cleared_at IS NOT NULL)
                ),
                CONSTRAINT FK_enrollment_clearance_enrollment FOREIGN KEY (enrollment_id) REFERENCES dbo.enrollments(id),
                CONSTRAINT FK_enrollment_clearance_payment FOREIGN KEY (payment_transaction_id) REFERENCES dbo.financial_transactions(id),
                CONSTRAINT FK_enrollment_clearance_cleared_by FOREIGN KEY (cleared_by) REFERENCES dbo.users(id),
                CONSTRAINT FK_enrollment_clearance_created_by FOREIGN KEY (created_by) REFERENCES dbo.users(id)
            );
            CREATE UNIQUE INDEX UX_enrollment_clearance_payment ON dbo.enrollment_clearances(payment_transaction_id)
                WHERE payment_transaction_id IS NOT NULL;
            CREATE INDEX IX_enrollment_clearance_pending ON dbo.enrollment_clearances(clearance_status, enrollment_id)
                INCLUDE (created_at);
        END;

        IF COL_LENGTH('dbo.enrollment_clearances', 'created_for_intake') IS NULL
        BEGIN
            ALTER TABLE dbo.enrollment_clearances ADD created_for_intake BIT NOT NULL
                CONSTRAINT DF_enrollment_clearance_created_for_intake DEFAULT 0;
        END;

        INSERT INTO dbo.schema_migrations ([version]) VALUES ('012');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
GO
