const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HostingerSeedError,
  BASELINE_REFERENCE_REQUIREMENTS,
  parseOptions,
  validateProductionTarget,
  buildHostingerAccounts,
  requireEmptyBusinessTables
} = require('../scripts/seed-hostinger-demo');

const databaseName = 'u123456_demo_db';
const productionConfiguration = {
  nodeEnv: 'production',
  devPasswordOnlyLogin: false,
  database: { host: 'remote-mysql.example.net', database: databaseName, user: 'u123456_user', password: 'secret' }
};

function seedValues() {
  const values = {};
  for (const [role, alias] of [['ADMIN', 'admin'], ['REGISTRAR', 'registrar'], ['TEACHER', 'teacher'], ['FINANCE', 'finance'], ['STUDENT', 'student']]) {
    values[`DEMO_${role}_EMAIL`] = `demo+${alias}@school.edu.ph`;
    values[`DEMO_${role}_PASSWORD`] = `different-private-${alias}-password`;
  }
  return values;
}

test('Hostinger seed requires the same exact database name twice and an explicit production acknowledgement', () => {
  assert.deepEqual(parseOptions([
    '--apply', '--target-database', databaseName, '--confirm-database', databaseName,
    '--acknowledge-production-demo-seed'
  ], databaseName), {
    mode: 'apply', targetDatabase: databaseName, confirmDatabase: databaseName, acknowledged: true
  });
  assert.throws(() => parseOptions(['--apply', '--target-database', databaseName, '--confirm-database', databaseName], databaseName), /acknowledge/);
  assert.throws(() => parseOptions(['--apply', '--target-database', databaseName, '--confirm-database', 'other_db', '--acknowledge-production-demo-seed'], databaseName), HostingerSeedError);
  assert.throws(() => parseOptions(['--apply', '--dry-run', '--target-database', databaseName, '--confirm-database', databaseName], databaseName), /exactly one mode/);
});

test('production seed rejects local databases and the development password bypass', () => {
  assert.doesNotThrow(() => validateProductionTarget(productionConfiguration));
  assert.throws(() => validateProductionTarget({ ...productionConfiguration,
    database: { ...productionConfiguration.database, host: '127.0.0.1' }
  }), /remote MariaDB/);
  assert.throws(() => validateProductionTarget({ ...productionConfiguration, devPasswordOnlyLogin: true }), /password-only login/);
  assert.throws(() => validateProductionTarget({ ...productionConfiguration, nodeEnv: 'development' }), /NODE_ENV=production/);
});

test('production demo accounts require distinct reachable emails and unique strong passwords', () => {
  const { accounts, passwords } = buildHostingerAccounts(seedValues());
  assert.equal(accounts.length, 5);
  assert.equal(new Set(accounts.map(({ email }) => email)).size, 5);
  assert.equal(new Set(Object.values(passwords)).size, 5);
  assert.equal(accounts.find(({ key }) => key === 'student').role, 'student');
  assert.throws(() => buildHostingerAccounts({ ...seedValues(), DEMO_STUDENT_EMAIL: 'demo.student@example.test' }), /reachable email/);
  assert.throws(() => buildHostingerAccounts({ ...seedValues(), DEMO_FINANCE_PASSWORD: seedValues().DEMO_ADMIN_PASSWORD }), /different password/);
});

function tableCheckTransaction({ requirementCodes = [...BASELINE_REFERENCE_REQUIREMENTS], usersPresent = false } = {}) {
  return {
    request() {
      return {
        async query(statement) {
          if (statement.includes('information_schema.tables')) {
            return { recordset: [{ table_name: 'physical_requirement_definitions' }, { table_name: 'users' }] };
          }
          if (statement.includes('SELECT requirement_code')) {
            return { recordset: requirementCodes.map((requirement_code) => ({ requirement_code })) };
          }
          if (statement.includes('SELECT 1 AS present')) {
            return { recordset: usersPresent ? [{ present: 1 }] : [] };
          }
          throw new Error('Unexpected table emptiness query.');
        }
      };
    }
  };
}

test('production seed allows only the exact v2.005 reference fixture in an otherwise empty database', async () => {
  await assert.doesNotReject(requireEmptyBusinessTables(tableCheckTransaction()));
  await assert.rejects(
    requireEmptyBusinessTables(tableCheckTransaction({ requirementCodes: ['good_moral'] })),
    /already contains application records/
  );
  await assert.rejects(
    requireEmptyBusinessTables(tableCheckTransaction({ usersPresent: true })),
    /already contains application records/
  );
});
