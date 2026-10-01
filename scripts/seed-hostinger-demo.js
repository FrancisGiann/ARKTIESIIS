'use strict';

const { isIP } = require('node:net');
const environment = require('../src/config/environment');
const { DemoSeedError, seedPassword, runDemoSeed } = require('./seed-demo-mariadb');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRODUCTION_PROFILE = {
  auditKey: 'hostinger-demo-seed-v1',
  schoolYear: '2026-2027', term: 'Term 1', sectionName: 'Demo Hostinger Section A', gradeLevel: 'Grade 11',
  subjectCode: 'DEMO-HOSTINGER-ENG-001', subjectName: 'Demo Communication Skills', subjectUnits: '3.00',
  studentNo: 'DEMO-HOSTINGER-0001', lrn: '999000000091', firstName: 'Demo', lastName: 'Learner',
  birthDate: '2008-01-15', address: 'Fictional demo record'
};

const HOSTINGER_ROLES = [
  { key: 'admin', role: 'database_admin', name: 'Demo Administrator', employeeNo: 'HDMO-ADMIN-001' },
  { key: 'registrar', role: 'registrar', name: 'Demo Registrar', employeeNo: 'HDMO-REG-001' },
  { key: 'teacher', role: 'teacher', name: 'Demo Teacher', employeeNo: 'HDMO-TEACH-001' },
  { key: 'finance', role: 'finance', name: 'Demo Finance', employeeNo: 'HDMO-FIN-001' },
  { key: 'student', role: 'student' }
];
const BASELINE_REFERENCE_REQUIREMENTS = new Set([
  'birth_certificate', 'jhs_report_card', 'grade11_card', 'good_moral', 'jhs_certificate',
  'als_certificate_of_rating', 'esc_certificate', 'national_id', 'two_by_two_photo',
  'long_brown_envelopes', 'sf10_form137'
]);

class HostingerSeedError extends DemoSeedError {
  constructor(message, status = 400) {
    super(message);
    this.name = 'HostingerSeedError';
    this.status = status;
  }
}

function parseOptions(args, configuredDatabase = environment.database.database) {
  if (!Array.isArray(args)) throw new HostingerSeedError('Seed arguments are invalid.');
  const options = { mode: null, targetDatabase: null, confirmDatabase: null, acknowledged: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (options.mode || seen.has(argument)) throw new HostingerSeedError('Choose exactly one mode: --dry-run or --apply.');
      options.mode = argument.slice(2);
      seen.add(argument);
    } else if (argument === '--target-database' || argument === '--confirm-database') {
      if (seen.has(argument) || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new HostingerSeedError(`Provide one value for ${argument}.`);
      }
      if (argument === '--target-database') options.targetDatabase = args[index + 1];
      else options.confirmDatabase = args[index + 1];
      seen.add(argument);
      index += 1;
    } else if (argument === '--acknowledge-production-demo-seed') {
      if (options.acknowledged) throw new HostingerSeedError('The production seed acknowledgement was repeated.');
      options.acknowledged = true;
    } else {
      throw new HostingerSeedError('Seed arguments are invalid.');
    }
  }

  if (!options.mode || !options.targetDatabase || !options.confirmDatabase) {
    throw new HostingerSeedError('Provide a mode and confirm the exact configured database name twice.');
  }
  if (options.targetDatabase !== options.confirmDatabase || options.targetDatabase !== configuredDatabase) {
    throw new HostingerSeedError('Both confirmed database names must exactly match DB_NAME.');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.targetDatabase)) {
    throw new HostingerSeedError('The target database name is invalid.');
  }
  if (options.mode === 'apply' && !options.acknowledged) {
    throw new HostingerSeedError('Apply requires --acknowledge-production-demo-seed.');
  }
  if (options.mode === 'dry-run' && options.acknowledged) {
    throw new HostingerSeedError('The production seed acknowledgement is only valid with --apply.');
  }
  return options;
}

function validateProductionTarget(configuration = environment) {
  if (configuration.nodeEnv !== 'production') throw new HostingerSeedError('The Hostinger seed requires NODE_ENV=production.');
  if (configuration.devPasswordOnlyLogin) throw new HostingerSeedError('The development password-only login must remain disabled.');
  const database = configuration.database || {};
  const host = String(database.host || '').trim().toLowerCase();
  const addressType = isIP(host);
  if (!host || host === 'localhost' || host === '::1' || (addressType === 4 && /^127\./.test(host))) {
    throw new HostingerSeedError('The Hostinger seed requires the remote MariaDB connection host from hPanel.');
  }
  if (!database.database || !database.user || String(database.user).toLowerCase() === 'root' || !database.password) {
    throw new HostingerSeedError('DB_NAME, DB_USER, and DB_PASSWORD must identify the existing hPanel database.');
  }
}

function buildHostingerAccounts(values = process.env) {
  const accounts = HOSTINGER_ROLES.map((role) => {
    const emailVariable = `DEMO_${role.key.toUpperCase()}_EMAIL`;
    const passwordVariable = `DEMO_${role.key.toUpperCase()}_PASSWORD`;
    const email = String(values[emailVariable] || '').trim().toLowerCase();
    const password = seedPassword(values[passwordVariable]);
    if (email.length > 255 || !EMAIL_PATTERN.test(email)
      || /\.(?:test|example|invalid)$/i.test(email.split('@')[1] || '')) {
      throw new HostingerSeedError(`${emailVariable} must be a reachable email address for the demo account.`);
    }
    return { ...role, email, password };
  });
  const emails = accounts.map(({ email }) => email);
  const passwords = accounts.map(({ password }) => password);
  if (new Set(emails).size !== emails.length) throw new HostingerSeedError('Use a distinct reachable email address for each demo role.');
  if (new Set(passwords).size !== passwords.length) throw new HostingerSeedError('Use a different password for each demo role.');
  return {
    accounts: accounts.map(({ password: _password, ...account }) => account),
    passwords: Object.fromEntries(accounts.map(({ key, password }) => [key, password]))
  };
}

async function requireEmptyBusinessTables(transaction) {
  const result = await transaction.request().query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('schema_migrations', 'application_locks')`);
  for (const row of result.recordset || []) {
    const tableName = String(row.table_name || '');
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) throw new HostingerSeedError('Could not verify that the selected database is empty.');
    if (tableName === 'physical_requirement_definitions') {
      const definitions = await transaction.request().query('SELECT requirement_code FROM `physical_requirement_definitions` ORDER BY requirement_code');
      const codes = (definitions.recordset || []).map(({ requirement_code }) => String(requirement_code));
      if (codes.length !== BASELINE_REFERENCE_REQUIREMENTS.size
        || codes.some((code) => !BASELINE_REFERENCE_REQUIREMENTS.has(code))) {
        throw new HostingerSeedError('The selected database already contains application records. The one-time seed was not applied.');
      }
      continue;
    }
    const contents = await transaction.request().query(`SELECT 1 AS present FROM \`${tableName}\` LIMIT 1`);
    if (contents.recordset?.length) {
      throw new HostingerSeedError('The selected database already contains application records. The one-time seed was not applied.');
    }
  }
}

async function runHostingerSeed({ options = parseOptions(process.argv.slice(2)), values = process.env,
  configuration = environment, logger = console } = {}) {
  validateProductionTarget(configuration);
  if (options.mode !== 'apply' || !options.acknowledged) {
    throw new HostingerSeedError('A production seed requires the explicit --apply acknowledgement.');
  }
  if (options.targetDatabase !== configuration.database.database
    || options.confirmDatabase !== configuration.database.database) {
    throw new HostingerSeedError('Both confirmed database names must exactly match DB_NAME.');
  }
  const { accounts, passwords } = buildHostingerAccounts(values);
  return runDemoSeed({
    accounts,
    passwords,
    profile: PRODUCTION_PROFILE,
    oneTime: true,
    validate: () => validateProductionTarget(configuration),
    beforeSeed: requireEmptyBusinessTables,
    includeEmails: false,
    logger
  });
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    validateProductionTarget();
    if (options.mode === 'dry-run') {
      buildHostingerAccounts(process.env);
      console.log(`Dry run passed for the explicitly confirmed database ${options.targetDatabase}. No connection or writes were made.`);
      return;
    }
    await runHostingerSeed({ options });
  } catch (error) {
    console.error(error instanceof HostingerSeedError ? error.message : 'Hostinger demo seed failed. Check the hPanel database, migration version, and private environment values.');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  HOSTINGER_ROLES,
  BASELINE_REFERENCE_REQUIREMENTS,
  PRODUCTION_PROFILE,
  HostingerSeedError,
  parseOptions,
  validateProductionTarget,
  buildHostingerAccounts,
  requireEmptyBusinessTables,
  runHostingerSeed
};
