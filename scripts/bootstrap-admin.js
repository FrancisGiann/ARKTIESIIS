const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { emitKeypressEvents } = require('node:readline');
const bcrypt = require('bcrypt');
const { getPool, closePool, sql, acquireTransactionLock } = require('../src/config/database');

const PASSWORD_HASH_ROUNDS = 12;

function validateBootstrapInput({ email, firstName, lastName, password }) {
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedFirstName = typeof firstName === 'string' ? firstName.trim() : '';
  const normalizedLastName = typeof lastName === 'string' ? lastName.trim() : '';
  if (normalizedEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error('Enter a valid email address.');
  }
  for (const name of [normalizedFirstName, normalizedLastName]) {
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error('First and last names must each contain 1 to 100 printable characters.');
    }
  }
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Password must contain 12 to 72 UTF-8 bytes.');
  }
  return { email: normalizedEmail, firstName: normalizedFirstName, lastName: normalizedLastName, password };
}

function readHidden(promptText, { input = stdin, output = stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('Run this command from a private interactive terminal.'));
      return;
    }

    emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    output.write(promptText);
    let value = '';
    let finished = false;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      input.removeListener('keypress', onKeypress);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onKeypress = (character, key = {}) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        finish(new Error('Bootstrap cancelled.'));
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
      } else if (key.name === 'backspace') {
        value = value.slice(0, -1);
      } else if (character && !key.ctrl && !key.meta) {
        value += character;
      }
    };

    input.on('keypress', onKeypress);
  });
}

async function promptForAdmin() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Run this command from a private interactive terminal.');
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  let email;
  let firstName;
  let lastName;
  try {
    email = await prompt.question('Admin email: ');
    firstName = await prompt.question('First name: ');
    lastName = await prompt.question('Last name: ');
  } finally {
    prompt.close();
  }
  const password = await readHidden('Password (12–72 UTF-8 bytes): ');
  return validateBootstrapInput({ email, firstName, lastName, password });
}

async function bootstrapAdmin(input, { getDatabasePool = getPool, sqlTypes = sql, hashPassword = bcrypt.hash } = {}) {
  const admin = validateBootstrapInput(input);
  const passwordHash = await hashPassword(admin.password, PASSWORD_HASH_ROUNDS);
  const pool = await getDatabasePool();
  const transaction = new sqlTypes.Transaction(pool);
  let transactionStarted = false;

  try {
    await transaction.begin(sqlTypes.ISOLATION_LEVEL.SERIALIZABLE);
    transactionStarted = true;
    await acquireTransactionLock(transaction, 'bootstrap-database-admin');

    const existingAdmin = await transaction.request()
      .input('role', sqlTypes.NVarChar(30), 'database_admin')
      .query('SELECT id FROM users WHERE role = @role LIMIT 1 FOR UPDATE');
    if (existingAdmin.recordset?.length) {
      await transaction.rollback();
      transactionStarted = false;
      throw new Error('A database administrator already exists.');
    }

    const insertedUser = await transaction.request()
      .input('email', sqlTypes.NVarChar(255), admin.email)
      .input('passwordHash', sqlTypes.NVarChar(255), passwordHash)
      .input('role', sqlTypes.NVarChar(30), 'database_admin')
      .query('INSERT INTO users (email, password_hash, role, is_active) VALUES (@email, @passwordHash, @role, 1)');
    const userId = insertedUser.insertId;
    if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Bootstrap insert failed.');

    await transaction.request()
      .input('userId', sqlTypes.Int, userId)
      .input('firstName', sqlTypes.NVarChar(100), admin.firstName)
      .input('lastName', sqlTypes.NVarChar(100), admin.lastName)
      .query('INSERT INTO staff_profiles (user_id, first_name, last_name) VALUES (@userId, @firstName, @lastName)');

    await transaction.request()
      .input('userId', sqlTypes.Int, userId)
      .input('action', sqlTypes.NVarChar(100), 'admin.bootstrap')
      .input('entityType', sqlTypes.NVarChar(100), 'user')
      .input('entityId', sqlTypes.NVarChar(100), String(userId))
      .input('detailsJson', sqlTypes.NVarChar(sqlTypes.MAX), JSON.stringify({ source: 'one_time_bootstrap' }))
      .query('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details_json) VALUES (@userId, @action, @entityType, @entityId, @detailsJson)');

    await transaction.commit();
    transactionStarted = false;
    return userId;
  } catch (error) {
    if (transactionStarted) {
      try {
        await transaction.rollback();
      } catch {
        // Preserve the original failure and avoid printing database details.
      }
    }
    throw error;
  }
}

async function main() {
  try {
    const input = await promptForAdmin();
    await bootstrapAdmin(input);
    stdout.write('Database administrator created. Remove bootstrap access from your deployment process.\n');
  } catch (error) {
    const expectedMessages = new Set([
      'Run this command from a private interactive terminal.',
      'Enter a valid email address.',
      'First and last names must each contain 1 to 100 printable characters.',
      'Password must contain 12 to 72 UTF-8 bytes.',
      'Bootstrap cancelled.',
      'A database administrator already exists.'
    ]);
    stdout.write(`${expectedMessages.has(error.message) ? error.message : 'Admin bootstrap failed. Check database connectivity and schema setup.'}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await closePool();
    } catch {
      // Do not print database or connection details.
    }
  }
}

if (require.main === module) main();

module.exports = { bootstrapAdmin, promptForAdmin, readHidden, validateBootstrapInput };
