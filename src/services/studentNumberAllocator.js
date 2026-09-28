const SCHOOL_YEAR_PATTERN = /^(\d{4})-(\d{4})$/;

class StudentNumberAllocationError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = 'StudentNumberAllocationError';
    this.status = status;
  }
}

function schoolYearStart(value) {
  if (typeof value !== 'string') return null;
  const match = SCHOOL_YEAR_PATTERN.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1000 || start > 9998 || end !== start + 1) return null;
  return String(start);
}

async function allocateStudentNumber(transaction, sql, schoolYear) {
  const yearStart = schoolYearStart(schoolYear);
  if (!yearStart) {
    throw new StudentNumberAllocationError('The academic term has an invalid school year. Correct the term before creating a student profile.');
  }

  const lockResult = await transaction.request()
    .input('resource', sql.NVarChar(255), `student-number:${yearStart}`)
    .query(`DECLARE @lockResult INT;
      EXEC @lockResult = sys.sp_getapplock
        @Resource = @resource,
        @LockMode = 'Exclusive',
        @LockOwner = 'Transaction',
        @LockTimeout = 10000,
        @DbPrincipal = 'public';
      SELECT @lockResult AS lock_result`);
  const lockCode = Number(lockResult.recordset?.[0]?.lock_result);
  if (!Number.isInteger(lockCode) || lockCode < 0) {
    throw new StudentNumberAllocationError('Student number allocation is busy. Try creating the student record again.', 503);
  }

  let result;
  try {
    result = await transaction.request()
      .input('schoolYearStart', sql.NVarChar(4), yearStart)
      .query(`DECLARE @prefix NVARCHAR(50) = CONCAT(N'SHS-', @schoolYearStart, N'-');
        DECLARE @maxSequence DECIMAL(38, 0);
        DECLARE @nextSequence NVARCHAR(38);
        IF EXISTS (
          SELECT 1 FROM dbo.students WITH (UPDLOCK, HOLDLOCK)
          WHERE student_no LIKE @prefix + N'%'
            AND LEN(student_no) > LEN(@prefix)
            AND SUBSTRING(student_no, LEN(@prefix) + 1, 50) NOT LIKE N'%[^0-9]%'
            AND LEN(SUBSTRING(student_no, LEN(@prefix) + 1, 50)) > 38
        ) THROW 51008, 'Student number sequence limit reached.', 1;
        SELECT @maxSequence = MAX(TRY_CONVERT(DECIMAL(38, 0), SUBSTRING(student_no, LEN(@prefix) + 1, 50)))
        FROM dbo.students WITH (UPDLOCK, HOLDLOCK)
        WHERE student_no LIKE @prefix + N'%'
          AND LEN(student_no) > LEN(@prefix)
          AND SUBSTRING(student_no, LEN(@prefix) + 1, 50) NOT LIKE N'%[^0-9]%';
        IF @maxSequence = CONVERT(DECIMAL(38, 0), REPLICATE(N'9', 38))
          THROW 51008, 'Student number sequence limit reached.', 1;
        SET @nextSequence = CONVERT(NVARCHAR(38), ISNULL(@maxSequence, 0) + 1);
        SELECT CONCAT(@prefix, RIGHT(REPLICATE(N'0', 4) + @nextSequence,
          CASE WHEN LEN(@nextSequence) < 4 THEN 4 ELSE LEN(@nextSequence) END)) AS student_no`);
  } catch (error) {
    if (error?.number === 51008) {
      throw new StudentNumberAllocationError('The student number sequence for this school year has reached its limit. Contact an administrator.', 409);
    }
    throw error;
  }
  const studentNo = result.recordset?.[0]?.student_no;
  if (typeof studentNo !== 'string' || !new RegExp(`^SHS-${yearStart}-\\d{4,}$`).test(studentNo) || studentNo.length > 50) {
    throw new Error('Student number allocation returned an invalid identifier.');
  }
  return studentNo;
}

module.exports = { StudentNumberAllocationError, schoolYearStart, allocateStudentNumber };
