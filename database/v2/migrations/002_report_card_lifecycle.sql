/* Distinguish the pre-lifecycle report-card archive from new student submissions. */
IF COL_LENGTH(N'dbo.documents', N'is_legacy_archive') IS NULL
BEGIN
    ALTER TABLE dbo.documents
      ADD is_legacy_archive BIT NOT NULL
        CONSTRAINT DF_documents_is_legacy_archive DEFAULT (0);
END;
GO

IF COL_LENGTH(N'dbo.documents', N'is_legacy_archive') IS NOT NULL
BEGIN
    UPDATE dbo.documents
      SET is_legacy_archive = 1
      WHERE document_type = 'report_card';
END;
