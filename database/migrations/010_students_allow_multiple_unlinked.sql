DECLARE @studentsObjectId INT = OBJECT_ID(N'dbo.students', N'U');

IF @studentsObjectId IS NULL
    THROW 51010, 'Migration 010 requires dbo.students.', 1;

IF COL_LENGTH(N'dbo.students', N'user_id') IS NULL
    THROW 51011, 'Migration 010 requires dbo.students.user_id.', 1;

IF EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = @studentsObjectId
      AND name = N'user_id'
      AND is_nullable = 0
)
    THROW 51012, 'Migration 010 expects dbo.students.user_id to remain nullable.', 1;

IF EXISTS (
    SELECT user_id
    FROM dbo.students
    WHERE user_id IS NOT NULL
    GROUP BY user_id
    HAVING COUNT_BIG(*) > 1
)
    THROW 51013, 'Migration 010 found duplicate linked student user IDs; resolve them before applying.', 1;

DECLARE @targetIndexId INT;
SELECT @targetIndexId = index_id
FROM sys.indexes
WHERE object_id = @studentsObjectId
  AND name = N'UX_students_user_id_linked';

IF @targetIndexId IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM sys.indexes AS i
    WHERE i.object_id = @studentsObjectId
      AND i.index_id = @targetIndexId
      AND i.is_unique = 1
      AND i.is_unique_constraint = 0
      AND i.has_filter = 1
      AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(i.filter_definition), N'[', N''), N']', N''), N'(', N''), N')', N''), N' ', N'') = N'USER_IDISNOTNULL'
      AND (SELECT COUNT(*)
           FROM sys.index_columns AS key_column
           WHERE key_column.object_id = i.object_id
             AND key_column.index_id = i.index_id
             AND key_column.key_ordinal > 0) = 1
      AND EXISTS (
          SELECT 1
          FROM sys.index_columns AS key_column
          INNER JOIN sys.columns AS c
              ON c.object_id = key_column.object_id
             AND c.column_id = key_column.column_id
          WHERE key_column.object_id = i.object_id
            AND key_column.index_id = i.index_id
            AND key_column.key_ordinal = 1
            AND c.name = N'user_id'
      )
)
    THROW 51014, 'Migration 010 found UX_students_user_id_linked in an unexpected state.', 1;

DECLARE @legacyConstraintName SYSNAME;
DECLARE @legacyIndexId INT;
DECLARE @legacyConstraintCount INT;

SELECT
    @legacyConstraintCount = COUNT(*),
    @legacyConstraintName = MAX(kc.name),
    @legacyIndexId = MAX(i.index_id)
FROM sys.key_constraints AS kc
INNER JOIN sys.indexes AS i
    ON i.object_id = kc.parent_object_id
   AND i.index_id = kc.unique_index_id
WHERE kc.parent_object_id = @studentsObjectId
  AND kc.type = N'UQ'
  AND i.is_unique = 1
  AND i.has_filter = 0
  AND (SELECT COUNT(*)
       FROM sys.index_columns AS key_column
       WHERE key_column.object_id = i.object_id
         AND key_column.index_id = i.index_id
         AND key_column.key_ordinal > 0) = 1
  AND EXISTS (
      SELECT 1
      FROM sys.index_columns AS key_column
      INNER JOIN sys.columns AS c
          ON c.object_id = key_column.object_id
         AND c.column_id = key_column.column_id
      WHERE key_column.object_id = i.object_id
        AND key_column.index_id = i.index_id
        AND key_column.key_ordinal = 1
        AND c.name = N'user_id'
  );

IF @legacyConstraintCount > 1
    THROW 51015, 'Migration 010 found multiple unique constraints on dbo.students.user_id; inspect the schema before applying.', 1;

IF @legacyConstraintCount = 0 AND @targetIndexId IS NULL
    THROW 51016, 'Migration 010 could not find the expected nullable user_id unique constraint or its replacement index.', 1;

IF EXISTS (
    SELECT 1
    FROM sys.key_constraints AS kc
    INNER JOIN sys.indexes AS i
        ON i.object_id = kc.parent_object_id
       AND i.index_id = kc.unique_index_id
    WHERE kc.parent_object_id = @studentsObjectId
      AND kc.type = N'UQ'
      AND EXISTS (
          SELECT 1
          FROM sys.index_columns AS key_column
          INNER JOIN sys.columns AS c
              ON c.object_id = key_column.object_id
             AND c.column_id = key_column.column_id
          WHERE key_column.object_id = i.object_id
            AND key_column.index_id = i.index_id
            AND key_column.key_ordinal > 0
            AND c.name = N'user_id'
      )
      AND (SELECT COUNT(*)
           FROM sys.index_columns AS key_column
           WHERE key_column.object_id = i.object_id
             AND key_column.index_id = i.index_id
             AND key_column.key_ordinal > 0) <> 1
)
    THROW 51017, 'Migration 010 found an unexpected composite unique constraint containing user_id.', 1;

IF EXISTS (
    SELECT 1
    FROM sys.indexes AS i
    WHERE i.object_id = @studentsObjectId
      AND i.is_unique = 1
      AND i.index_id <> ISNULL(@legacyIndexId, -1)
      AND i.index_id <> ISNULL(@targetIndexId, -1)
      AND (SELECT COUNT(*)
           FROM sys.index_columns AS key_column
           WHERE key_column.object_id = i.object_id
             AND key_column.index_id = i.index_id
             AND key_column.key_ordinal > 0) = 1
      AND EXISTS (
          SELECT 1
          FROM sys.index_columns AS key_column
          INNER JOIN sys.columns AS c
              ON c.object_id = key_column.object_id
             AND c.column_id = key_column.column_id
          WHERE key_column.object_id = i.object_id
            AND key_column.index_id = i.index_id
            AND key_column.key_ordinal = 1
            AND c.name = N'user_id'
      )
)
    THROW 51018, 'Migration 010 found another unique index on dbo.students.user_id; inspect the schema before applying.', 1;

IF @legacyConstraintName IS NOT NULL
BEGIN
    DECLARE @dropConstraintSql NVARCHAR(500) =
        N'ALTER TABLE dbo.students DROP CONSTRAINT ' + QUOTENAME(@legacyConstraintName) + N';';
    EXEC sys.sp_executesql @dropConstraintSql;
END;

IF @targetIndexId IS NULL
    CREATE UNIQUE INDEX UX_students_user_id_linked
        ON dbo.students (user_id)
        WHERE user_id IS NOT NULL;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes AS i
    WHERE i.object_id = @studentsObjectId
      AND i.name = N'UX_students_user_id_linked'
      AND i.is_unique = 1
      AND i.is_unique_constraint = 0
      AND i.has_filter = 1
      AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(UPPER(i.filter_definition), N'[', N''), N']', N''), N'(', N''), N')', N''), N' ', N'') = N'USER_IDISNOTNULL'
      AND (SELECT COUNT(*)
           FROM sys.index_columns AS key_column
           WHERE key_column.object_id = i.object_id
             AND key_column.index_id = i.index_id
             AND key_column.key_ordinal > 0) = 1
      AND EXISTS (
          SELECT 1
          FROM sys.index_columns AS key_column
          INNER JOIN sys.columns AS c
              ON c.object_id = key_column.object_id
             AND c.column_id = key_column.column_id
          WHERE key_column.object_id = i.object_id
            AND key_column.index_id = i.index_id
            AND key_column.key_ordinal = 1
            AND c.name = N'user_id'
      )
)
    THROW 51019, 'Migration 010 could not verify the filtered unique student user link index.', 1;
