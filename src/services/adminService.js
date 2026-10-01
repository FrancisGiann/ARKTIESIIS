const bcrypt = require('bcrypt');
const { getPool: defaultGetPool, sql: defaultSql } = require('../config/database');

const PASSWORD_HASH_ROUNDS = 12;
const STAFF_ROLES = new Set(['database_admin', 'registrar', 'finance', 'teacher']);
const ROLES = new Set([...STAFF_ROLES, 'student']);

class AdminServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AdminServiceError';
    this.status = status;
  }
}

function textValue(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function normalizeUserId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeSearchTerm(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new AdminServiceError('Search terms must be 100 printable characters or fewer.');
  const searchTerm = value.trim();
  if (searchTerm.length > 100 || /[\u0000-\u001f\u007f]/.test(searchTerm)) {
    throw new AdminServiceError('Search terms must be 100 printable characters or fewer.');
  }
  return searchTerm;
}

function escapeLikePattern(value) {
  return value.replace(/[~%_[\]]/g, (character) => `~${character}`);
}

function validatePassword(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new AdminServiceError('Password must contain 12 to 72 UTF-8 bytes.');
  }
  return password;
}

function validateCreateUser(input = {}) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AdminServiceError('Enter a valid email address.');
  }

  const role = typeof input.role === 'string' ? input.role : '';
  if (!ROLES.has(role)) throw new AdminServiceError('Choose an approved account role.');

  const password = validatePassword(input.password);
  if (role === 'student') {
    const studentNo = textValue(input.studentNo, 50);
    if (!studentNo) throw new AdminServiceError('Enter a valid student number to link an existing student record.');
    return { email, role, password, studentNo };
  }

  const firstName = textValue(input.firstName, 100);
  const lastName = textValue(input.lastName, 100);
  const department = textValue(input.department, 100);
  if (!firstName || !lastName || department === null) {
    throw new AdminServiceError('First and last names are required. Department must be 100 characters or fewer.');
  }
  return { email, role, password, firstName, lastName, department: department || null };
}

function normalizeActive(value) {
  if (value === '1' || value === 'true' || value === true) return true;
  if (value === '0' || value === 'false' || value === false || value === undefined) return false;
  throw new AdminServiceError('Choose whether the account is active.');
}

function validateUpdateUser(input = {}) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AdminServiceError('Enter a valid email address.');
  }

  const role = typeof input.role === 'string' ? input.role : '';
  if (!ROLES.has(role)) throw new AdminServiceError('Choose an approved account role.');
  const isActive = normalizeActive(input.isActive);
  if (role === 'student') {
    const studentNo = textValue(input.studentNo, 50);
    if (!studentNo) throw new AdminServiceError('Enter a valid student number to link an existing student record.');
    return { email, role, isActive, studentNo };
  }

  const firstName = textValue(input.firstName, 100);
  const lastName = textValue(input.lastName, 100);
  const department = textValue(input.department, 100);
  if (!firstName || !lastName || department === null) {
    throw new AdminServiceError('First and last names are required. Department must be 100 characters or fewer.');
  }
  return { email, role, isActive, firstName, lastName, department: department || null };
}

function createAdminService({
  getPool = defaultGetPool,
  sql = defaultSql,
  hashPassword = bcrypt.hash,
  transactionFactory = (pool) => new sql.Transaction(pool)
} = {}) {
  async function runTransaction(callback) {
    const pool = await getPool();
    const transaction = transactionFactory(pool);
    let started = false;
    try {
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
      const result = await callback(transaction);
      await transaction.commit();
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try {
          await transaction.rollback();
        } catch {
          // Preserve the original error without exposing database details.
        }
      }
      throw error;
    }
  }

  async function requireAdminActor(transaction, actorId) {
    const actor = await transaction.request()
      .input('actorId', sql.Int, actorId)
      .input('adminRole', sql.NVarChar(30), 'database_admin')
      .query('SELECT id FROM users WHERE id = @actorId AND role = @adminRole AND is_active = 1 FOR UPDATE');
    if (!actor.recordset?.length) throw new AdminServiceError('Your administrator access is no longer active. Sign in again.', 403);
  }

  async function writeAudit(transaction, { actorId, action, entityId, details }) {
    await transaction.request()
      .input('actorId', sql.Int, actorId)
      .input('action', sql.NVarChar(100), action)
      .input('entityType', sql.NVarChar(100), 'user')
      .input('entityId', sql.NVarChar(100), String(entityId))
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json) VALUES (@actorId, @action, @entityType, @entityId, @detailsJson)');
  }

  async function loadTarget(transaction, userId) {
    const result = await transaction.request()
      .input('userId', sql.Int, userId)
      .query('SELECT id, email, role, is_active FROM users WHERE id = @userId FOR UPDATE');
    const user = result.recordset?.[0];
    if (!user) throw new AdminServiceError('Account not found.', 404);
    return user;
  }

  async function guardAdminTransition(transaction, { actorId, userId, current, role, isActive }) {
    if (userId === actorId && (current.role !== role || !isActive)) {
      throw new AdminServiceError('You cannot change your own role or deactivate your own account.');
    }
    const losesActiveAdmin = current.role === 'database_admin' && Boolean(current.is_active) && (role !== 'database_admin' || !isActive);
    if (!losesActiveAdmin) return;

    const result = await transaction.request()
      .input('adminRole', sql.NVarChar(30), 'database_admin')
      .query('SELECT id FROM users WHERE role = @adminRole AND is_active = 1 FOR UPDATE');
    if ((result.recordset || []).length <= 1) {
      throw new AdminServiceError('At least one active database administrator must remain.');
    }
  }

  async function linkStudent(transaction, { userId, studentNo }) {
    const studentResult = await transaction.request()
      .input('studentNo', sql.NVarChar(50), studentNo)
      .query('SELECT id, user_id, status FROM students WHERE student_no = @studentNo FOR UPDATE');
    const student = studentResult.recordset?.[0];
    if (!student || student.status === 'archived' || (student.user_id !== null && student.user_id !== userId)) {
      throw new AdminServiceError('That student number is unavailable or does not match an existing student record.', 409);
    }

    await transaction.request()
      .input('userId', sql.Int, userId)
      .input('studentId', sql.Int, student.id)
      .query('UPDATE students SET user_id = NULL, updated_at = UTC_TIMESTAMP(6) WHERE user_id = @userId AND id <> @studentId');
    await transaction.request()
      .input('userId', sql.Int, userId)
      .input('studentId', sql.Int, student.id)
      .query('UPDATE students SET user_id = @userId, updated_at = UTC_TIMESTAMP(6) WHERE id = @studentId');
  }

  async function saveStaffProfile(transaction, { userId, firstName, lastName, department }) {
    const existing = await transaction.request()
      .input('userId', sql.Int, userId)
      .query('SELECT id FROM staff_profiles WHERE user_id = @userId FOR UPDATE');
    const request = transaction.request()
      .input('userId', sql.Int, userId)
      .input('firstName', sql.NVarChar(100), firstName)
      .input('lastName', sql.NVarChar(100), lastName)
      .input('department', sql.NVarChar(100), department);
    if (existing.recordset?.length) {
      await request.query('UPDATE staff_profiles SET first_name = @firstName, last_name = @lastName, department = @department WHERE user_id = @userId');
    } else {
      await request.query('INSERT INTO staff_profiles (user_id, first_name, last_name, department) VALUES (@userId, @firstName, @lastName, @department)');
    }
  }

  async function listDashboard(searchInput = '') {
    const searchTerm = normalizeSearchTerm(searchInput);
    const searchPattern = searchTerm ? `%${escapeLikePattern(searchTerm)}%` : null;
    const pool = await getPool();
    const users = await pool.request()
      .input('searchPattern', sql.NVarChar(204), searchPattern)
      .query(`
      SELECT
        u.id, u.email, u.role, u.is_active, u.created_at,
        CASE WHEN u.role = 'student'
          THEN COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(s.first_name, ' ', s.middle_name, ' ', s.last_name, ' ', s.suffix))), ''), CONCAT('User ', u.id))
          ELSE COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(sp.first_name, ' ', sp.last_name))), ''), CONCAT('User ', u.id))
        END AS display_name,
        s.student_no, sp.department
      FROM users AS u
      LEFT JOIN staff_profiles AS sp ON sp.user_id = u.id
      LEFT JOIN students AS s ON s.user_id = u.id
      WHERE @searchPattern IS NULL
        OR u.email LIKE @searchPattern ESCAPE '~'
        OR s.student_no LIKE @searchPattern ESCAPE '~'
      ORDER BY u.created_at DESC, u.id DESC LIMIT 250`);
    return { users: users.recordset || [], searchTerm };
  }

  async function listAuditLogs() {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT a.id, a.user_id, actor.email AS actor_email, a.action, a.entity_type,
        a.entity_id, a.created_at
      FROM audit_logs AS a
      LEFT JOIN users AS actor ON actor.id = a.user_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT 100`);
    return result.recordset || [];
  }

  async function getDashboardSummary(actorInput) {
    const actorId = normalizeUserId(actorInput);
    if (!actorId) throw new AdminServiceError('Database administrator dashboard access is required.', 403);
    const pool = await getPool();
    const result = await pool.request()
      .input('actorId', sql.Int, actorId)
      .query(`SELECT
          (SELECT COUNT(*) FROM users WHERE is_active = 1) AS active_user_count,
          (SELECT COUNT(*) FROM users WHERE is_active = 0) AS inactive_user_count,
          (SELECT COUNT(*) FROM students WHERE status = 'active') AS active_student_count,
          (SELECT COUNT(*) FROM students WHERE status = 'archived') AS archived_student_count,
          (SELECT COUNT(*) FROM documents WHERE status IN ('needs_review', 'failed')) AS documents_awaiting_review_count
        WHERE EXISTS (SELECT 1 FROM users
          WHERE id = @actorId AND role = 'database_admin' AND is_active = 1)`);
    const summary = result.recordset?.[0];
    if (!summary) throw new AdminServiceError('Your administrator access is no longer active. Sign in again.', 403);
    return summary;
  }

  async function getUser(userId) {
    const id = normalizeUserId(userId);
    if (!id) throw new AdminServiceError('Account not found.', 404);
    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.Int, id)
      .query(`
        SELECT u.id, u.email, u.role, u.is_active, u.created_at,
          sp.first_name, sp.last_name, sp.department, s.student_no,
          s.first_name AS student_first_name, s.middle_name AS student_middle_name,
          s.last_name AS student_last_name, s.suffix AS student_suffix
        FROM users AS u
        LEFT JOIN staff_profiles AS sp ON sp.user_id = u.id
        LEFT JOIN students AS s ON s.user_id = u.id
        WHERE u.id = @userId`);
    return result.recordset?.[0] || null;
  }

  async function createUser(actorId, input) {
    const account = validateCreateUser(input);
    const passwordHash = await hashPassword(account.password, PASSWORD_HASH_ROUNDS);
    return runTransaction(async (transaction) => {
      await requireAdminActor(transaction, actorId);
      const inserted = await transaction.request()
        .input('email', sql.NVarChar(255), account.email)
        .input('passwordHash', sql.NVarChar(255), passwordHash)
        .input('role', sql.NVarChar(30), account.role)
        .query('INSERT INTO users (email, password_hash, role, is_active) VALUES (@email, @passwordHash, @role, 1)');
      const userId = inserted.insertId;
      if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Account insert failed.');

      if (account.role === 'student') {
        await linkStudent(transaction, { userId, studentNo: account.studentNo });
      } else {
        await saveStaffProfile(transaction, { userId, ...account });
      }

      await writeAudit(transaction, { actorId, action: 'admin.user_created', entityId: userId, details: { role: account.role } });
      return userId;
    });
  }

  async function updateUser(actorId, userId, input) {
    const id = normalizeUserId(userId);
    if (!id) throw new AdminServiceError('Account not found.', 404);
    const account = validateUpdateUser(input);
    return runTransaction(async (transaction) => {
      await requireAdminActor(transaction, actorId);
      const current = await loadTarget(transaction, id);
      await guardAdminTransition(transaction, { actorId, userId: id, current, role: account.role, isActive: account.isActive });

      await transaction.request()
        .input('userId', sql.Int, id)
        .input('email', sql.NVarChar(255), account.email)
        .input('role', sql.NVarChar(30), account.role)
        .input('isActive', sql.Bit, account.isActive)
        .input('emailChanged', sql.Bit, String(current.email).toLowerCase() !== account.email.toLowerCase())
        .query('UPDATE users SET email = @email, role = @role, is_active = @isActive, updated_at = UTC_TIMESTAMP(6) WHERE id = @userId');
      if (String(current.email).toLowerCase() !== account.email || !account.isActive) {
        for (const table of ['two_factor_codes', 'password_reset_tokens', 'pending_email_changes']) {
          await transaction.request().input('userId', sql.Int, id)
            .query(`UPDATE ${table} SET consumed_at = UTC_TIMESTAMP(6) WHERE user_id = @userId AND consumed_at IS NULL`);
        }
      }

      if (account.role === 'student') {
        await linkStudent(transaction, { userId: id, studentNo: account.studentNo });
        if (!account.isActive) {
          await transaction.request().input('userId', sql.Int, id)
            .query(`UPDATE annual_enrollments SET account_activation_pending = 0, updated_at = UTC_TIMESTAMP(6)
              WHERE student_id IN (SELECT id FROM students WHERE user_id = @userId) AND account_activation_pending = 1`);
          await transaction.request().input('userId', sql.Int, id)
            .query(`UPDATE enrollment_clearances SET account_activation_pending = 0
              WHERE created_for_intake = 1 AND account_activation_pending = 1
                AND enrollment_id IN (SELECT enrollment.id FROM enrollments AS enrollment
                  INNER JOIN students AS student ON student.id = enrollment.student_id WHERE student.user_id = @userId)`);
        }
      } else {
        await transaction.request()
          .input('userId', sql.Int, id)
          .query('UPDATE students SET user_id = NULL, updated_at = UTC_TIMESTAMP(6) WHERE user_id = @userId');
        await saveStaffProfile(transaction, { userId: id, ...account });
      }

      await writeAudit(transaction, {
        actorId,
        action: 'admin.user_updated',
        entityId: id,
        details: {
          previousRole: current.role,
          role: account.role,
          wasActive: Boolean(current.is_active),
          isActive: account.isActive,
          emailChanged: current.email !== account.email
        }
      });
    });
  }

  async function resetPassword(actorId, userId, newPassword) {
    const id = normalizeUserId(userId);
    if (!id) throw new AdminServiceError('Account not found.', 404);
    const password = validatePassword(newPassword);
    const passwordHash = await hashPassword(password, PASSWORD_HASH_ROUNDS);
    return runTransaction(async (transaction) => {
      await requireAdminActor(transaction, actorId);
      await loadTarget(transaction, id);
      await transaction.request()
        .input('userId', sql.Int, id)
        .input('passwordHash', sql.NVarChar(255), passwordHash)
        .query('UPDATE users SET password_hash = @passwordHash, updated_at = UTC_TIMESTAMP(6) WHERE id = @userId');
      for (const table of ['two_factor_codes', 'password_reset_tokens', 'pending_email_changes']) {
        await transaction.request().input('userId', sql.Int, id)
          .query(`UPDATE ${table} SET consumed_at = UTC_TIMESTAMP(6) WHERE user_id = @userId AND consumed_at IS NULL`);
      }
      await writeAudit(transaction, {
        actorId,
        action: 'admin.user_password_reset',
        entityId: id,
        details: { pendingSignInCodesInvalidated: true }
      });
    });
  }

  return { listDashboard, listAuditLogs, getDashboardSummary, getUser, createUser, updateUser, resetPassword };
}

module.exports = {
  AdminServiceError,
  createAdminService,
  normalizeUserId,
  validatePassword,
  validateCreateUser,
  validateUpdateUser
};
