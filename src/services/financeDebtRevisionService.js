'use strict';

const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

function cents(value) {
  const text = String(value ?? '0.00');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error('The finance balance projection returned an invalid amount.');
  const fraction = (match[3] || '').padEnd(2, '0');
  const amount = BigInt(match[2]) * 100n + BigInt(fraction || '0');
  return match[1] ? -amount : amount;
}

function formatCents(value) {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function ledgerCompletenessCondition(studentExpression) {
  return `((EXISTS (SELECT 1 FROM financial_accounts AS account WHERE account.student_id = ${studentExpression})
      OR EXISTS (SELECT 1 FROM annual_assessments AS assessment
        INNER JOIN annual_enrollments AS assessed_annual ON assessed_annual.id = assessment.annual_enrollment_id
        WHERE assessed_annual.student_id = ${studentExpression}))
    AND NOT EXISTS (SELECT 1 FROM annual_enrollments AS annual
      WHERE annual.student_id = ${studentExpression}
        AND ((annual.intake_status = 'legacy' AND NOT EXISTS (
          SELECT 1 FROM financial_accounts AS account WHERE account.student_id = ${studentExpression}))
          OR (annual.intake_status IN ('enrolled', 'dropped', 'transferred') AND NOT EXISTS (
            SELECT 1 FROM annual_assessments AS assessment WHERE assessment.annual_enrollment_id = annual.id)))))`;
}

function createFinanceDebtRevisionService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool)
} = {}) {
  async function lockStudent(transaction, studentId) {
    const studentResult = await transaction.request().input('studentId', sql.Int, studentId)
      .query('SELECT id, status, CAST(debt_increase_revision AS CHAR(40)) AS debt_increase_revision FROM students WHERE id = @studentId FOR UPDATE');
    const student = studentResult.recordset?.[0];
    if (!student) return null;
    return { ...student, debtIncreaseRevision: String(student.debt_increase_revision ?? '0') };
  }

  async function readSnapshot(transaction, studentId) {
    const annualDueResult = await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT CAST(due.amount_due AS CHAR(40)) AS amount_due
        FROM v_finance_assessed_charge_due AS due
        INNER JOIN annual_enrollments AS annual ON annual.id = due.annual_enrollment_id
        WHERE annual.student_id = @studentId`);
    const openingDueResult = await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT CAST(due.amount_due AS CHAR(40)) AS amount_due
        FROM v_finance_opening_liability_due AS due
        WHERE due.student_id = @studentId`);
    const legacyBalanceResult = await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT CAST(balance.remaining_legacy_balance AS CHAR(40)) AS remaining_legacy_balance
        FROM v_finance_legacy_account_balance AS balance
        WHERE balance.student_id = @studentId`);
    const completenessResult = await transaction.request().input('studentId', sql.Int, studentId)
      .query(`SELECT CAST(CASE WHEN ${ledgerCompletenessCondition('@studentId')}
        THEN 1 ELSE 0 END AS UNSIGNED) AS ledger_complete`);
    const completenessRow = completenessResult.recordset?.[0];
    if (!completenessRow || !annualDueResult.recordset || !openingDueResult.recordset || !legacyBalanceResult.recordset) {
      throw new Error('The finance balance projection is unavailable.');
    }
    const canonicalBalanceCents = [
      ...annualDueResult.recordset.map((row) => row.amount_due),
      ...openingDueResult.recordset.map((row) => row.amount_due),
      ...legacyBalanceResult.recordset.map((row) => row.remaining_legacy_balance)
    ].reduce((total, amount) => total + cents(amount), 0n);
    return {
      canonicalBalanceCents,
      ledgerComplete: completenessRow.ledger_complete === true || completenessRow.ledger_complete === 1 || completenessRow.ledger_complete === '1'
    };
  }

  async function recordIncreaseIfAny(transaction, studentId, beforeBalanceCents) {
    const after = await readSnapshot(transaction, studentId);
    if (after.canonicalBalanceCents <= BigInt(beforeBalanceCents)) {
      return { increased: false, ...after };
    }
    await transaction.request().input('studentId', sql.Int, studentId)
      .query(`UPDATE students
        SET debt_increase_revision = debt_increase_revision + 1
        WHERE id = @studentId`);
    const revision = await transaction.request().input('studentId', sql.Int, studentId)
      .query('SELECT CAST(debt_increase_revision AS CHAR(40)) AS revision FROM students WHERE id = @studentId');
    return {
      increased: true,
      debtIncreaseRevision: String(revision.recordset?.[0]?.revision ?? '0'),
      ...after
    };
  }

  async function getStudentSnapshot(studentId) {
    const pool = await getPool();
    const transaction = transactionFactory(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.REPEATABLE_READ);
    try {
      const student = await lockStudent(transaction, studentId);
      if (!student) {
        await transaction.commit();
        return null;
      }
      const balance = await readSnapshot(transaction, studentId);
      await transaction.commit();
      const safeOutstandingCents = balance.canonicalBalanceCents > 0n ? balance.canonicalBalanceCents : 0n;
      return {
        debtIncreaseRevision: student.debtIncreaseRevision,
        canonicalBalance: formatCents(balance.canonicalBalanceCents),
        outstanding: formatCents(safeOutstandingCents),
        ledgerComplete: balance.ledgerComplete
      };
    } catch (error) {
      await transaction.rollback().catch(() => {});
      throw error;
    }
  }

  return { lockStudent, readSnapshot, recordIncreaseIfAny, getStudentSnapshot };
}

module.exports = { createFinanceDebtRevisionService, cents, formatCents, ledgerCompletenessCondition };
