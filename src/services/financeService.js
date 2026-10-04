const { getPool: defaultGetPool, sql: defaultSql, isDuplicateKeyError } = require('../config/database');
const { createFinanceDebtRevisionService } = require('./financeDebtRevisionService');
const { runSerializableTransaction } = require('./transactionRetry');

const ID_PATTERN = /^\d{1,10}$/;
const MAX_MONEY_CENTS = 999999999999n;

class FinanceServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'FinanceServiceError';
    this.status = status;
  }
}

function normalizeId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

function recordInput(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new FinanceServiceError(`${label} must be ${maxLength} printable characters or fewer.`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new FinanceServiceError(`${label} must be ${maxLength} printable characters or fewer.`);
  }
  return text;
}

function normalizeSearchTerm(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new FinanceServiceError('Search must be 100 printable characters or fewer.');
  const searchTerm = value.trim();
  if (searchTerm.length > 100 || /[\u0000-\u001f\u007f]/.test(searchTerm)) {
    throw new FinanceServiceError('Search must be 100 printable characters or fewer.');
  }
  return searchTerm;
}

function escapeLikePattern(value) {
  return value.replace(/[~%_[\]]/g, (character) => `~${character}`);
}

function parseMoneyCents(value, { allowNegative = false, allowZero = false } = {}) {
  const raw = typeof value === 'number' ? String(value) : value;
  const pattern = allowNegative ? /^-?\d{1,10}(?:\.\d{1,2})?$/ : /^\d{1,10}(?:\.\d{1,2})?$/;
  if (typeof raw !== 'string' || !pattern.test(raw)) {
    throw new FinanceServiceError('Amount must be a valid decimal with up to 10 whole digits and 2 decimal places.');
  }
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  if (cents > MAX_MONEY_CENTS) throw new FinanceServiceError('Amount exceeds the supported financial limit.');
  const signedCents = negative ? -cents : cents;
  if (!allowZero && signedCents === 0n) throw new FinanceServiceError('Amount must not be zero.');
  return signedCents;
}

function formatMoneyCents(cents) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function validateTransaction(input = {}) {
  input = recordInput(input);
  const transactionType = input.transactionType;
  if (!['charge', 'payment', 'adjustment'].includes(transactionType)) {
    throw new FinanceServiceError('Choose a charge, payment, or adjustment.');
  }
  const amountCents = parseMoneyCents(input.amount, { allowNegative: transactionType === 'adjustment' });
  const description = optionalText(input.description, 'Description', 500);
  if (transactionType === 'adjustment' && !description) {
    throw new FinanceServiceError('Enter a reason for the balance adjustment.');
  }
  const referenceNo = optionalText(input.referenceNo, 'Reference number', 100);
  const clearEnrollmentId = input.clearEnrollmentId === undefined || input.clearEnrollmentId === null || input.clearEnrollmentId === ''
    ? null
    : normalizeId(input.clearEnrollmentId);
  if (input.clearEnrollmentId !== undefined && input.clearEnrollmentId !== null && input.clearEnrollmentId !== '' && !clearEnrollmentId) {
    throw new FinanceServiceError('Choose a valid pending enrollment to clear.');
  }
  const confirmEnrollmentClearance = input.confirmEnrollmentClearance === '1' || input.confirmEnrollmentClearance === true;
  if (clearEnrollmentId && (transactionType !== 'payment' || !confirmEnrollmentClearance)) {
    throw new FinanceServiceError('Enrollment clearance requires a payment and explicit finance confirmation.');
  }
  if (confirmEnrollmentClearance && !clearEnrollmentId) {
    throw new FinanceServiceError('Choose the specific enrollment to clear.');
  }
  return {
    transactionType,
    amountCents,
    amount: formatMoneyCents(amountCents),
    description,
    referenceNo,
    clearEnrollmentId,
    confirmEnrollmentClearance
  };
}

function isUniqueConflict(error) {
  return isDuplicateKeyError(error);
}

function createFinanceService({
  getPool = defaultGetPool,
  sql = defaultSql,
  transactionFactory = (pool) => new sql.Transaction(pool),
  debtRevisionService = null,
  transaction = null
} = {}) {
  const debtRevisions = debtRevisionService || createFinanceDebtRevisionService({ getPool, sql, transactionFactory, transaction });

  async function runTransaction(callback) {
    if (transaction) return callback(transaction);
    return runSerializableTransaction({ getPool, sql, transactionFactory }, callback);
  }

  async function requireFinanceActor(transaction, actorInput) {
    const actorId = normalizeId(actorInput);
    if (!actorId) throw new FinanceServiceError('Finance or database administrator access is required.', 403);
    const result = await transaction.request()
      .input('actorId', sql.Int, actorId)
      .input('financeRole', sql.NVarChar(30), 'finance')
      .input('adminRole', sql.NVarChar(30), 'database_admin')
      .query(`SELECT id, role FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN (@financeRole, @adminRole)
        FOR UPDATE`);
    const actor = result.recordset?.[0];
    if (!actor || !['finance', 'database_admin'].includes(actor.role)) {
      throw new FinanceServiceError('Your finance access is no longer active. Sign in again.', 403);
    }
    return actor;
  }

  async function writeAudit(transaction, { actorId, actorRole, action, entityId, details }) {
    await transaction.request()
      .input('actorId', sql.Int, actorId)
      .input('action', sql.NVarChar(100), actorRole === 'database_admin'
        ? `database_admin.finance_${action}`
        : `finance.${action}`)
      .input('entityType', sql.NVarChar(100), 'financial_account')
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)`);
  }

  async function searchStudents(searchInput = '') {
    const searchTerm = normalizeSearchTerm(searchInput);
    if (!searchTerm) return { students: [], searchTerm };
    const searchPattern = `%${escapeLikePattern(searchTerm)}%`;
    const pool = await getPool();
    const result = await pool.request()
      .input('searchPattern', sql.NVarChar(204), searchPattern)
      .query(`SELECT s.id AS student_id, s.student_no, s.first_name, s.middle_name,
          s.last_name, s.suffix, a.id AS financial_account_id,
          CAST(balance.remaining_legacy_balance AS CHAR(40)) AS balance
        FROM students AS s
        LEFT JOIN financial_accounts AS a ON a.student_id = s.id
        LEFT JOIN v_finance_legacy_account_balance AS balance ON balance.financial_account_id = a.id
        WHERE NOT EXISTS (SELECT 1 FROM annual_enrollments AS annual
            WHERE annual.student_id = s.id AND annual.intake_status <> 'legacy')
          AND NOT EXISTS (SELECT 1 FROM finance_legacy_opening_charges AS opening WHERE opening.student_id = s.id)
          AND (s.student_no LIKE @searchPattern ESCAPE '~'
          OR s.first_name LIKE @searchPattern ESCAPE '~'
          OR s.middle_name LIKE @searchPattern ESCAPE '~'
          OR s.last_name LIKE @searchPattern ESCAPE '~'
          OR CONCAT_WS(' ', s.first_name, NULLIF(s.middle_name, ''), s.last_name, NULLIF(s.suffix, '')) LIKE @searchPattern ESCAPE '~')
        ORDER BY s.last_name, s.first_name, s.student_no, s.id
        LIMIT 100`);
    return { students: result.recordset || [], searchTerm };
  }

  async function listRecentAccounts(actorInput) {
    const actorId = normalizeId(actorInput);
    if (!actorId) throw new FinanceServiceError('Finance or database administrator access is required.', 403);
    const pool = await getPool();
    const actorResult = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query(`SELECT id FROM users WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin')`);
    if (!actorResult.recordset?.length) {
      throw new FinanceServiceError('Your finance access is no longer active. Sign in again.', 403);
    }
    const result = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query(`SELECT s.id AS student_id, s.student_no, s.first_name, s.middle_name,
          s.last_name, s.suffix, s.status, a.id AS financial_account_id,
          CAST(balance.remaining_legacy_balance AS CHAR(40)) AS balance, a.updated_at
        FROM financial_accounts AS a
        INNER JOIN students AS s ON s.id = a.student_id
        LEFT JOIN v_finance_legacy_account_balance AS balance ON balance.financial_account_id = a.id
        WHERE EXISTS (SELECT 1 FROM users
          WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin'))
          AND NOT EXISTS (SELECT 1 FROM annual_enrollments AS annual
            WHERE annual.student_id = s.id AND annual.intake_status <> 'legacy')
          AND NOT EXISTS (SELECT 1 FROM finance_legacy_opening_charges AS opening WHERE opening.student_id = s.id)
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT 8`);
    return result.recordset || [];
  }

  async function getStudentAccount(studentInput) {
    const studentId = normalizeId(studentInput);
    if (!studentId) throw new FinanceServiceError('Student record not found.', 404);
    const pool = await getPool();
    const studentResult = await pool.request()
      .input('studentId', sql.Int, studentId)
      .query(`SELECT student.id AS student_id, student_no, first_name, middle_name, last_name, suffix, status,
          CAST(CASE WHEN EXISTS (SELECT 1 FROM annual_enrollments AS annual
              WHERE annual.student_id = student.id AND annual.intake_status <> 'legacy')
            OR EXISTS (SELECT 1 FROM finance_legacy_opening_charges AS opening WHERE opening.student_id = student.id)
            THEN 1 ELSE 0 END AS UNSIGNED) AS annual_finance_required
        FROM students AS student WHERE student.id = @studentId
          FOR UPDATE`);
    const student = studentResult.recordset?.[0];
    if (!student) return null;
    if (student.annual_finance_required === true || student.annual_finance_required === 1) {
      throw new FinanceServiceError('This student uses the annual finance workspace.', 409);
    }

    const pendingEnrollmentResult = await pool.request()
      .input('studentId', sql.Int, studentId)
      .query(`SELECT enrollment.id AS enrollment_id, term.school_year, term.term,
          section.name AS section_name, clearance.clearance_status
        FROM enrollments AS enrollment
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id
          AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN enrollment_clearances AS clearance ON clearance.enrollment_id = enrollment.id
        WHERE enrollment.student_id = @studentId AND clearance.created_for_intake = 1
          AND enrollment.enrollment_status = 'pending_payment'
          AND enrollment.finalized_at IS NULL
        ORDER BY enrollment.id DESC`);
    const pendingEnrollments = pendingEnrollmentResult.recordset || [];

    const accountResult = await pool.request()
      .input('studentId', sql.Int, studentId)
      .query(`SELECT account.id AS financial_account_id, CAST(balance.remaining_legacy_balance AS CHAR(40)) AS balance
        FROM financial_accounts AS account
        INNER JOIN v_finance_legacy_account_balance AS balance ON balance.financial_account_id = account.id
        WHERE account.student_id = @studentId`);
    const account = accountResult.recordset?.[0] || null;
    if (!account) return { student, account: null, transactions: [], pendingEnrollments };

    const transactionResult = await pool.request()
      .input('accountId', sql.Int, account.financial_account_id)
      .query(`SELECT t.id, t.transaction_type,
          CAST(t.amount AS CHAR(40)) AS amount, t.description, t.reference_no,
          t.recorded_by, COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(sp.first_name, ' ', sp.last_name))), ''), CONCAT('Staff ', t.recorded_by)) AS recorded_by_name,
          t.created_at
        FROM financial_transactions AS t
        LEFT JOIN staff_profiles AS sp ON sp.user_id = t.recorded_by
        WHERE t.financial_account_id = @accountId
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT 100`);
    const paymentOptionsResult = await pool.request()
      .input('accountId', sql.Int, account.financial_account_id)
      .query(`SELECT payment.id AS transaction_id,
          CAST(payment.amount AS CHAR(40)) AS amount, payment.reference_no, payment.created_at
        FROM financial_transactions AS payment
        WHERE payment.financial_account_id = @accountId AND payment.transaction_type = 'payment'
          AND payment.amount > 0
          AND NOT EXISTS (SELECT 1 FROM enrollment_clearances AS clearance
            WHERE clearance.payment_transaction_id = payment.id)
        ORDER BY payment.created_at DESC, payment.id DESC
        LIMIT 100`);
    return {
      student, account, transactions: transactionResult.recordset || [], pendingEnrollments,
      availableEnrollmentPayments: paymentOptionsResult.recordset || []
    };
  }

  async function getOwnStudentAccount(userInput) {
    const userId = normalizeId(userInput);
    if (!userId) throw new FinanceServiceError('Your student finance access is unavailable.', 403);
    const pool = await getPool();
    const ownerResult = await pool.request()
      .input('userId', sql.Int, userId)
      .query(`SELECT student.id AS student_id, student.student_no, student.first_name,
          student.middle_name, student.last_name, student.suffix, account.id AS financial_account_id,
          CAST(balance.remaining_legacy_balance AS CHAR(40)) AS balance
        FROM users AS user_account
        LEFT JOIN students AS student ON student.user_id = user_account.id
        LEFT JOIN financial_accounts AS account ON account.student_id = student.id
        LEFT JOIN v_finance_legacy_account_balance AS balance ON balance.financial_account_id = account.id
        WHERE user_account.id = @userId AND user_account.is_active = 1 AND user_account.role = 'student'`);
    const owner = ownerResult.recordset?.[0];
    if (!owner) throw new FinanceServiceError('Your student finance access is no longer active. Sign in again.', 403);
    if (!owner.student_id) return { student: null, account: null, transactions: [] };
    const student = {
      id: owner.student_id,
      student_no: owner.student_no,
      first_name: owner.first_name,
      middle_name: owner.middle_name,
      last_name: owner.last_name,
      suffix: owner.suffix
    };
    if (!owner.financial_account_id) return { student, account: null, transactions: [] };

    const transactions = await pool.request()
      .input('accountId', sql.Int, owner.financial_account_id)
      .input('studentId', sql.Int, owner.student_id)
      .query(`SELECT transaction_record.id, transaction_record.transaction_type,
          CAST(transaction_record.amount AS CHAR(40)) AS amount,
          transaction_record.description, transaction_record.reference_no, transaction_record.created_at
        FROM financial_transactions AS transaction_record
        INNER JOIN financial_accounts AS account ON account.id = transaction_record.financial_account_id
        WHERE account.id = @accountId AND account.student_id = @studentId
        ORDER BY transaction_record.created_at DESC, transaction_record.id DESC
        LIMIT 100`);
    return {
      student,
      account: { id: owner.financial_account_id, balance: owner.balance },
      transactions: transactions.recordset || []
    };
  }

  async function listPendingEnrollmentClearances(actorInput) {
    const actorId = normalizeId(actorInput);
    if (!actorId) throw new FinanceServiceError('Finance or database administrator access is required.', 403);
    const pool = await getPool();
    const actorResult = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query(`SELECT id FROM users
        WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin')`);
    if (!actorResult.recordset?.length) throw new FinanceServiceError('Your finance access is no longer active. Sign in again.', 403);
    const result = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query(`SELECT enrollment.id AS enrollment_id, student.id AS student_id,
          student.student_no, student.first_name, student.middle_name, student.last_name, student.suffix,
          term.school_year, term.term, section.name AS section_name
        FROM enrollments AS enrollment
        INNER JOIN students AS student ON student.id = enrollment.student_id
        INNER JOIN academic_terms AS term ON term.id = enrollment.academic_term_id
        LEFT JOIN sections AS section ON section.id = enrollment.section_id
          AND section.academic_term_id = enrollment.academic_term_id
        LEFT JOIN enrollment_clearances AS clearance ON clearance.enrollment_id = enrollment.id
        WHERE clearance.created_for_intake = 1 AND enrollment.enrollment_status = 'pending_payment'
          AND enrollment.finalized_at IS NULL
          AND COALESCE(clearance.clearance_status, 'pending') = 'pending'
          AND EXISTS (SELECT 1 FROM users
            WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin'))
        ORDER BY enrollment.id DESC`);
    return result.recordset;
  }

  async function getDashboardSummary(actorInput) {
    const actorId = normalizeId(actorInput);
    if (!actorId) throw new FinanceServiceError('Finance or database administrator access is required.', 403);
    const pool = await getPool();
    const result = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query(`WITH annual_totals AS (
            SELECT annual.student_id, SUM(due.amount_due) AS annual_balance
            FROM annual_enrollments AS annual
            INNER JOIN assessed_charges AS charge ON charge.annual_enrollment_id = annual.id
            INNER JOIN v_finance_assessed_charge_due AS due ON due.charge_id = charge.id
            WHERE annual.intake_status <> 'legacy'
            GROUP BY annual.student_id
          ), opening_totals AS (
            SELECT student_id, SUM(amount_due) AS opening_balance
            FROM v_finance_opening_liability_due GROUP BY student_id
          ), finance_students AS (
            SELECT combined.student_id, SUM(combined.balance) AS balance
            FROM (
              SELECT student_id, remaining_legacy_balance AS balance FROM v_finance_legacy_account_balance
              UNION ALL SELECT student_id, annual_balance AS balance FROM annual_totals
              UNION ALL SELECT student_id, opening_balance AS balance FROM opening_totals
            ) AS combined
            GROUP BY combined.student_id
          )
        SELECT
          (SELECT COUNT(*) FROM finance_students) AS account_count,
          (SELECT COUNT(*) FROM finance_students WHERE balance > 0) AS accounts_due_count,
          (SELECT COUNT(*) FROM finance_students WHERE balance = 0) AS accounts_settled_count,
          (SELECT COUNT(*) FROM finance_students WHERE balance < 0) AS accounts_credit_count,
          (SELECT COUNT(*) FROM financial_transactions WHERE transaction_type = 'charge')
            + (SELECT COUNT(*) FROM assessed_charges AS charge INNER JOIN annual_enrollments AS annual ON annual.id = charge.annual_enrollment_id WHERE annual.intake_status <> 'legacy') AS charge_count,
          (SELECT COUNT(*) FROM financial_transactions WHERE transaction_type = 'payment')
            + (SELECT COUNT(*) FROM finance_payments) AS payment_count
        WHERE EXISTS (SELECT 1 FROM users
          WHERE id = @actorId AND is_active = 1 AND role IN ('finance', 'database_admin'))`);
    const summary = result.recordset?.[0];
    if (!summary) throw new FinanceServiceError('Your finance access is no longer active. Sign in again.', 403);
    return summary;
  }

  async function createAccount(actorInput, studentInput) {
    const studentId = normalizeId(studentInput);
    if (!studentId) throw new FinanceServiceError('Choose a valid student record.');
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction, actorInput);
      const studentResult = await transaction.request()
        .input('studentId', sql.Int, studentId)
        .query('SELECT id, status FROM students WHERE id = @studentId FOR UPDATE');
      const student = studentResult.recordset?.[0];
      if (!student) throw new FinanceServiceError('Student record not found.', 404);
      if (student.status === 'archived') throw new FinanceServiceError('Archived students cannot receive new finance records.', 409);

      const existingResult = await transaction.request()
        .input('studentId', sql.Int, studentId)
        .query('SELECT id FROM financial_accounts WHERE student_id = @studentId FOR UPDATE');
      if (existingResult.recordset?.length) throw new FinanceServiceError('This student already has a financial account.', 409);

      const insertResult = await transaction.request()
        .input('studentId', sql.Int, studentId)
        .query(`INSERT INTO financial_accounts (student_id, balance)
          VALUES (@studentId, 0)`);
      const accountId = Number(insertResult.insertId || insertResult.recordset?.[0]?.id);
      if (!Number.isSafeInteger(accountId) || accountId < 1) throw new Error('Financial account insert returned no identifier.');
      await writeAudit(transaction, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'account_created',
        entityId: accountId,
        details: { studentId }
      });
      return accountId;
    });
  }

  async function recordTransaction(actorInput, studentInput, input = {}) {
    const studentId = normalizeId(studentInput);
    if (!studentId) throw new FinanceServiceError('Choose a valid student record.');
    const entry = validateTransaction(input);
    return runTransaction(async (transaction) => {
      const actor = await requireFinanceActor(transaction, actorInput);
      const student = await debtRevisions.lockStudent(transaction, studentId);
      if (!student) throw new FinanceServiceError('Student record not found.', 404);
      if (student.status === 'archived') throw new FinanceServiceError('Archived students cannot receive new finance records.', 409);
      const beforeDebt = (await debtRevisions.readSnapshot(transaction, studentId)).canonicalBalanceCents;
      const accountResult = await transaction.request()
        .input('studentId', sql.Int, studentId)
        .query(`SELECT a.id AS financial_account_id, CAST(a.balance AS CHAR(40)) AS balance, s.status
          FROM financial_accounts AS a
          INNER JOIN students AS s  ON s.id = a.student_id
          WHERE s.id = @studentId
          FOR UPDATE`);
      const account = accountResult.recordset?.[0];
      if (!account) throw new FinanceServiceError('Financial account not found. Create the account before recording a transaction.', 404);
      if (account.status === 'archived') throw new FinanceServiceError('Archived students cannot receive new finance records.', 409);
      const annualWorkflow = await transaction.request().input('studentId', sql.Int, studentId)
        .query(`SELECT id FROM annual_enrollments
          WHERE student_id = @studentId AND intake_status <> 'legacy'
          LIMIT 1 FOR UPDATE`);
      if (annualWorkflow.recordset?.length) {
        throw new FinanceServiceError('This student uses the annual finance ledger. Record charges and payments in the annual account workspace.', 409);
      }
      const openingLiability = await transaction.request().input('accountId', sql.Int, account.financial_account_id)
        .query(`SELECT id FROM finance_legacy_opening_charges
          WHERE financial_account_id = @accountId
          LIMIT 1 FOR UPDATE`);
      if (openingLiability.recordset?.length) {
        throw new FinanceServiceError('This account has a reviewed opening liability. Record payments in the annual finance workspace.', 409);
      }

      let clearance = null;
      if (entry.clearEnrollmentId) {
        const clearanceResult = await transaction.request()
          .input('enrollmentId', sql.Int, entry.clearEnrollmentId)
          .input('studentId', sql.Int, studentId)
          .query(`SELECT enrollment.id, enrollment.enrollment_status, enrollment.finalized_at,
              clearance.clearance_status, clearance.created_for_intake
            FROM enrollments AS enrollment
            INNER JOIN students AS student  ON student.id = enrollment.student_id
            INNER JOIN enrollment_clearances AS clearance
              ON clearance.enrollment_id = enrollment.id
            WHERE enrollment.id = @enrollmentId AND enrollment.student_id = @studentId
            FOR UPDATE`);
        clearance = clearanceResult.recordset?.[0];
        if (!clearance || !(clearance.created_for_intake === true || clearance.created_for_intake === 1)
          || clearance.enrollment_status !== 'pending_payment' || clearance.finalized_at
          || clearance.clearance_status !== 'pending') {
          throw new FinanceServiceError('Choose an uncleared pending enrollment for this student.', 409);
        }
      }

      if (entry.referenceNo) {
        const duplicate = await transaction.request()
          .input('accountId', sql.Int, account.financial_account_id)
          .input('referenceNo', sql.NVarChar(100), entry.referenceNo)
          .query(`SELECT id FROM financial_transactions
            WHERE financial_account_id = @accountId AND reference_no = @referenceNo
            LIMIT 1 FOR UPDATE`);
        if (duplicate.recordset?.length) throw new FinanceServiceError('That reference number is already used for this account.', 409);
      }

      const previousBalanceCents = parseMoneyCents(account.balance, { allowNegative: true, allowZero: true });
      const direction = entry.transactionType === 'charge' ? 1n : entry.transactionType === 'payment' ? -1n : 1n;
      const nextBalanceCents = previousBalanceCents + (entry.amountCents * direction);
      if (nextBalanceCents > MAX_MONEY_CENTS || nextBalanceCents < -MAX_MONEY_CENTS) {
        throw new FinanceServiceError('This transaction would exceed the supported balance limit.');
      }
      const nextBalance = formatMoneyCents(nextBalanceCents);

      await transaction.request()
        .input('accountId', sql.Int, account.financial_account_id)
        .input('balance', sql.Decimal(12, 2), nextBalance)
        .query(`UPDATE financial_accounts SET balance = @balance, updated_at = UTC_TIMESTAMP(6)
          WHERE id = @accountId`);
      const inserted = await transaction.request()
        .input('accountId', sql.Int, account.financial_account_id)
        .input('transactionType', sql.NVarChar(30), entry.transactionType)
        .input('amount', sql.Decimal(12, 2), entry.amount)
        .input('description', sql.NVarChar(500), entry.description)
        .input('referenceNo', sql.NVarChar(100), entry.referenceNo)
        .input('actorId', sql.Int, actor.id)
        .query(`INSERT INTO financial_transactions
          (financial_account_id, transaction_type, amount, description, reference_no, recorded_by)
          VALUES (@accountId, @transactionType, @amount, @description, @referenceNo, @actorId)`);
      const transactionId = Number(inserted.insertId || inserted.recordset?.[0]?.id);
      if (!Number.isSafeInteger(transactionId) || transactionId < 1) throw new Error('Financial transaction insert returned no identifier.');
      await debtRevisions.recordIncreaseIfAny(transaction, studentId, beforeDebt);
      if (entry.clearEnrollmentId) {
        const cleared = await transaction.request()
          .input('enrollmentId', sql.Int, entry.clearEnrollmentId)
          .input('transactionId', sql.Int, transactionId)
          .input('actorId', sql.Int, actor.id)
          .query(`UPDATE enrollment_clearances
            SET clearance_status = 'cleared', payment_transaction_id = @transactionId,
              cleared_by = @actorId, cleared_at = UTC_TIMESTAMP(6)
            WHERE enrollment_id = @enrollmentId AND clearance_status = 'pending'
              AND payment_transaction_id IS NULL AND cleared_by IS NULL AND cleared_at IS NULL`);
        if (cleared.rowsAffected?.[0] !== 1) throw new FinanceServiceError('This enrollment was cleared by another finance transaction. Nothing was recorded.', 409);
      }
      await writeAudit(transaction, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'transaction_recorded',
        entityId: account.financial_account_id,
        details: {
          transactionId,
          transactionType: entry.transactionType,
          amount: entry.amount,
          referenceNo: entry.referenceNo,
          ...(entry.clearEnrollmentId ? { enrollmentId: entry.clearEnrollmentId, enrollmentCleared: true } : {})
        }
      });
      return { accountId: account.financial_account_id, transactionId, balance: nextBalance };
    });
  }

  async function clearEnrollmentWithExistingPayment(actorInput, studentInput, enrollmentInput, paymentInput, confirmedEligibility) {
    const studentId = normalizeId(studentInput);
    const enrollmentId = normalizeId(enrollmentInput);
    const paymentTransactionId = normalizeId(paymentInput);
    if (!studentId || !enrollmentId || !paymentTransactionId) {
      throw new FinanceServiceError('Choose a valid pending enrollment and recorded payment.');
    }
    if (confirmedEligibility !== '1' && confirmedEligibility !== true) {
      throw new FinanceServiceError('Finance must confirm that this payment satisfies eligibility for the selected enrollment.');
    }
    try {
      return await runTransaction(async (transaction) => {
        const actor = await requireFinanceActor(transaction, actorInput);
        const accountResult = await transaction.request()
          .input('studentId', sql.Int, studentId)
          .query(`SELECT account.id AS financial_account_id, student.status
            FROM financial_accounts AS account
            INNER JOIN students AS student  ON student.id = account.student_id
            WHERE student.id = @studentId
          FOR UPDATE`);
        const account = accountResult.recordset?.[0];
        if (!account) throw new FinanceServiceError('Financial account not found.', 404);
        if (account.status === 'archived') throw new FinanceServiceError('Archived students cannot receive new finance records.', 409);
        const openingLiability = await transaction.request().input('accountId', sql.Int, account.financial_account_id)
          .query(`SELECT id FROM finance_legacy_opening_charges
            WHERE financial_account_id = @accountId
            LIMIT 1 FOR UPDATE`);
        if (openingLiability.recordset?.length) {
          throw new FinanceServiceError('This account has a reviewed opening liability. Use the annual finance workflow for payment and clearance records.', 409);
        }

        const enrollmentResult = await transaction.request()
          .input('enrollmentId', sql.Int, enrollmentId)
          .input('studentId', sql.Int, studentId)
          .query(`SELECT enrollment.id, enrollment.enrollment_status, enrollment.finalized_at,
              clearance.clearance_status, clearance.payment_transaction_id, clearance.created_for_intake
            FROM enrollments AS enrollment
            INNER JOIN enrollment_clearances AS clearance
              ON clearance.enrollment_id = enrollment.id
            WHERE enrollment.id = @enrollmentId AND enrollment.student_id = @studentId
            FOR UPDATE`);
        const enrollment = enrollmentResult.recordset?.[0];
        if (!enrollment || !(enrollment.created_for_intake === true || enrollment.created_for_intake === 1)
          || enrollment.enrollment_status !== 'pending_payment' || enrollment.finalized_at
          || enrollment.clearance_status !== 'pending' || enrollment.payment_transaction_id) {
          throw new FinanceServiceError('Choose an uncleared pending enrollment for this student.', 409);
        }
        const annualWorkflow = await transaction.request().input('enrollmentId', sql.Int, enrollmentId)
          .query(`SELECT annual.id FROM enrollments AS enrollment
            INNER JOIN annual_enrollments AS annual  ON annual.id = enrollment.annual_enrollment_id
            WHERE enrollment.id = @enrollmentId AND annual.intake_status <> 'legacy'
            FOR UPDATE`);
        if (annualWorkflow.recordset?.length) {
          throw new FinanceServiceError('This term uses the annual finance approval and clearance workflow.', 409);
        }

        const paymentResult = await transaction.request()
          .input('paymentTransactionId', sql.Int, paymentTransactionId)
          .input('accountId', sql.Int, account.financial_account_id)
          .query(`SELECT payment.id
            FROM financial_transactions AS payment
            WHERE payment.id = @paymentTransactionId AND payment.financial_account_id = @accountId
              AND payment.transaction_type = 'payment' AND payment.amount > 0
              AND NOT EXISTS (SELECT 1 FROM enrollment_clearances AS used
                WHERE used.payment_transaction_id = payment.id)
            FOR UPDATE`);
        if (!paymentResult.recordset?.length) {
          throw new FinanceServiceError('Choose an unused recorded payment from this student account.', 409);
        }

        const cleared = await transaction.request()
          .input('enrollmentId', sql.Int, enrollmentId)
          .input('transactionId', sql.Int, paymentTransactionId)
          .input('actorId', sql.Int, actor.id)
          .query(`UPDATE enrollment_clearances
            SET clearance_status = 'cleared', payment_transaction_id = @transactionId,
              cleared_by = @actorId, cleared_at = UTC_TIMESTAMP(6)
            WHERE enrollment_id = @enrollmentId AND clearance_status = 'pending'
              AND payment_transaction_id IS NULL AND cleared_by IS NULL AND cleared_at IS NULL`);
        if (cleared.rowsAffected?.[0] !== 1) {
          throw new FinanceServiceError('This enrollment was cleared by another finance action. Nothing was changed.', 409);
        }
        await writeAudit(transaction, {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'enrollment_clearance_updated',
          entityId: account.financial_account_id,
          details: { enrollmentId, paymentTransactionId, existingPayment: true, financeConfirmedEligibility: true }
        });
        return { enrollmentId, paymentTransactionId };
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new FinanceServiceError('That payment has already been assigned to an enrollment clearance.', 409);
      }
      throw error;
    }
  }

  return {
    searchStudents, listRecentAccounts, getStudentAccount, getOwnStudentAccount, listPendingEnrollmentClearances,
    getDashboardSummary, createAccount, recordTransaction, clearEnrollmentWithExistingPayment
  };
}

module.exports = {
  FinanceServiceError,
  createFinanceService,
  normalizeId,
  normalizeSearchTerm,
  parseMoneyCents,
  formatMoneyCents,
  validateTransaction,
  isUniqueConflict
};
