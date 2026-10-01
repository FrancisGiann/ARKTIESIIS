const SCHOOL_YEAR_PATTERN = /^(\d{4})-(\d{4})$/;
const MAX_STUDENT_SEQUENCE = BigInt('9'.repeat(38));

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

  const { acquireTransactionLock } = require('../config/database');
  await acquireTransactionLock(transaction, `student-number:${yearStart}`);

  const result = await transaction.request()
    .input('prefix', sql.NVarChar(50), `SHS-${yearStart}-`)
    .query(`SELECT SUBSTRING(student_no, CHAR_LENGTH(@prefix) + 1) AS sequence
      FROM students
      WHERE student_no LIKE CONCAT(@prefix, '%')
        AND CHAR_LENGTH(student_no) > CHAR_LENGTH(@prefix)
        AND SUBSTRING(student_no, CHAR_LENGTH(@prefix) + 1) REGEXP '^[0-9]+$'
      FOR UPDATE`);
  let maxSequence = 0n;
  for (const row of result.recordset || []) {
    const sequence = String(row.sequence);
    if (sequence.length > 38) {
      throw new StudentNumberAllocationError('The student number sequence for this school year has reached its limit. Contact an administrator.', 409);
    }
    const numericSequence = BigInt(sequence);
    if (numericSequence > maxSequence) maxSequence = numericSequence;
  }
  if (maxSequence >= MAX_STUDENT_SEQUENCE) {
    throw new StudentNumberAllocationError('The student number sequence for this school year has reached its limit. Contact an administrator.', 409);
  }
  const nextSequence = String(maxSequence + 1n).padStart(4, '0');
  const studentNo = `SHS-${yearStart}-${nextSequence}`;
  if (typeof studentNo !== 'string' || !new RegExp(`^SHS-${yearStart}-\\d{4,}$`).test(studentNo) || studentNo.length > 50) {
    throw new Error('Student number allocation returned an invalid identifier.');
  }
  return studentNo;
}

module.exports = { StudentNumberAllocationError, schoolYearStart, allocateStudentNumber };
