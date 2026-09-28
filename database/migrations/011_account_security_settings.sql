/* Account security settings: other-session invalidation and one-time action tokens. */
SET XACT_ABORT ON;
GO

BEGIN TRY
    BEGIN TRANSACTION;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.schema_migrations WHERE [version] = '011'
    )
    BEGIN
        IF COL_LENGTH('dbo.users', 'auth_session_version') IS NULL
        BEGIN
            ALTER TABLE dbo.users
                ADD auth_session_version UNIQUEIDENTIFIER NOT NULL
                    CONSTRAINT DF_users_auth_session_version DEFAULT NEWID();
        END;

        IF OBJECT_ID('dbo.password_reset_tokens', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.password_reset_tokens (
                id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
                user_id INT NOT NULL,
                token_hash CHAR(64) NOT NULL,
                expires_at DATETIME2 NOT NULL,
                attempt_count INT NOT NULL CONSTRAINT DF_password_reset_attempt_count DEFAULT 0,
                consumed_at DATETIME2 NULL,
                created_at DATETIME2 NOT NULL CONSTRAINT DF_password_reset_created_at DEFAULT SYSUTCDATETIME(),
                CONSTRAINT CK_password_reset_attempt_count CHECK (attempt_count >= 0),
                CONSTRAINT FK_password_reset_user FOREIGN KEY (user_id) REFERENCES dbo.users(id)
            );
            CREATE UNIQUE INDEX UX_password_reset_token_hash ON dbo.password_reset_tokens (token_hash);
            CREATE UNIQUE INDEX UX_password_reset_active_user ON dbo.password_reset_tokens (user_id) WHERE consumed_at IS NULL;
        END;

        IF OBJECT_ID('dbo.pending_email_changes', 'U') IS NULL
        BEGIN
            CREATE TABLE dbo.pending_email_changes (
                id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
                user_id INT NOT NULL,
                new_email NVARCHAR(255) NOT NULL,
                token_hash CHAR(64) NOT NULL,
                expires_at DATETIME2 NOT NULL,
                attempt_count INT NOT NULL CONSTRAINT DF_pending_email_change_attempt_count DEFAULT 0,
                consumed_at DATETIME2 NULL,
                created_at DATETIME2 NOT NULL CONSTRAINT DF_pending_email_change_created_at DEFAULT SYSUTCDATETIME(),
                CONSTRAINT CK_pending_email_change_attempt_count CHECK (attempt_count >= 0),
                CONSTRAINT FK_pending_email_change_user FOREIGN KEY (user_id) REFERENCES dbo.users(id)
            );
            CREATE UNIQUE INDEX UX_pending_email_change_token_hash ON dbo.pending_email_changes (token_hash);
            CREATE UNIQUE INDEX UX_pending_email_change_active_user ON dbo.pending_email_changes (user_id) WHERE consumed_at IS NULL;
            CREATE INDEX IX_pending_email_change_email_expiry
                ON dbo.pending_email_changes (new_email, expires_at) WHERE consumed_at IS NULL;
        END;

        INSERT INTO dbo.schema_migrations ([version]) VALUES ('011');
    END;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
GO
