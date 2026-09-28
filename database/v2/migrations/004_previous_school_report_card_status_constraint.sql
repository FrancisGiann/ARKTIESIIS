DECLARE @previousStatusConstraint sysname;
SELECT TOP (1) @previousStatusConstraint = name
FROM sys.check_constraints
WHERE parent_object_id = OBJECT_ID(N'dbo.previous_school_report_card_status_events')
  AND definition LIKE N'%pending%'
  AND definition LIKE N'%received%'
  AND definition LIKE N'%verified%'
  AND definition LIKE N'%correction%';

IF @previousStatusConstraint IS NOT NULL
  AND @previousStatusConstraint <> N'CK_previous_school_report_card_status_status'
BEGIN
    DECLARE @dropPreviousStatusConstraintSql NVARCHAR(500) =
        N'ALTER TABLE dbo.previous_school_report_card_status_events DROP CONSTRAINT '
        + QUOTENAME(@previousStatusConstraint);
    EXEC sys.sp_executesql @dropPreviousStatusConstraintSql;
END;

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID(N'dbo.previous_school_report_card_status_events')
      AND name = N'CK_previous_school_report_card_status_status'
)
BEGIN
    ALTER TABLE dbo.previous_school_report_card_status_events WITH CHECK
        ADD CONSTRAINT CK_previous_school_report_card_status_status
        CHECK (status IN ('pending', 'received', 'verified', 'correction', 'rejected'));
END;
GO
