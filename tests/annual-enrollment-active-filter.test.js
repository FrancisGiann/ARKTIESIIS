const test = require('node:test');
const assert = require('node:assert/strict');
const { sql } = require('../src/config/database');
const { AnnualEnrollmentError, createAnnualEnrollmentService } = require('../src/services/annualEnrollmentService');

test('dashboard intake filters exclude inactive students who retain an enrolled placement', async () => {
  const fixtures = [
    { annual_enrollment_id: 1, student_id: 11, student_status: 'active', enrollment_status: 'enrolled' },
    { annual_enrollment_id: 2, student_id: 12, student_status: 'inactive', enrollment_status: 'enrolled' }
  ];
  const observed = [];
  const getPool = async () => ({ request() {
    const values = {};
    return {
      input(name, _type, value) { values[name] = value; return this; },
      async query(statement) {
        observed.push({ statement, values: { ...values } });
        if (statement.includes('SELECT role FROM users')) return { recordset: [{ role: 'registrar' }] };
        assert.match(statement, /\(@studentStatus IS NULL OR student\.status = @studentStatus\)/);
        assert.equal(values.studentStatus, 'active');
        return { recordset: fixtures.filter((row) => row.student_status === values.studentStatus) };
      }
    };
  } });
  const service = createAnnualEnrollmentService({ getPool, sql });
  const filters = { schoolYear: '2026-2027', termId: '62', gradeLevel: 'Grade 11', status: 'enrolled', studentStatus: 'active' };

  const placements = await service.listAnnualEnrollments(7, filters);
  const counts = await service.listAnnualEnrollmentCounts(7, filters);

  assert.deepEqual(placements.map((row) => row.student_id), [11]);
  assert.deepEqual(counts.map((row) => row.student_id), [11]);
  assert.equal(observed.filter(({ statement }) => statement.includes('@studentStatus')).length, 2);
  assert.ok(fixtures.some((row) => row.enrollment_status === 'enrolled' && row.student_status === 'inactive'));
});

test('annual intake accepts only the dashboard active-student filter value', async () => {
  const service = createAnnualEnrollmentService({ getPool: async () => ({ request() { throw new Error('database must not be queried'); } }), sql });
  await assert.rejects(service.listAnnualEnrollments(7, { studentStatus: 'inactive' }), AnnualEnrollmentError);
  await assert.rejects(service.listAnnualEnrollmentCounts(7, { studentStatus: 'archived' }), AnnualEnrollmentError);
});

test('annual roster pages whole annual records with a bounded SQL offset and clamps page input', async () => {
  const observed = [];
  const getPool = async () => ({ request() {
    const values = {};
    return {
      input(name, _type, value) { values[name] = value; return this; },
      async query(statement) {
        observed.push({ statement, values: { ...values } });
        if (statement.includes('SELECT role FROM users')) return { recordset: [{ role: 'registrar' }] };
        if (statement.includes('COUNT(DISTINCT annual.id)')) return { recordset: [{ total_records: 41 }] };
        assert.match(statement, /WITH MatchingAnnualEnrollments AS/);
        assert.match(statement, /LIMIT @pageSize OFFSET @offset/);
        return { recordset: [
          { annual_enrollment_id: 10, enrollment_id: 81, annual_term_number: 1 },
          { annual_enrollment_id: 10, enrollment_id: 82, annual_term_number: 2 }
        ] };
      }
    };
  } });
  const service = createAnnualEnrollmentService({ getPool, sql });

  const lastPage = await service.listAnnualEnrollmentsPage(7, { page: '99', search: 'Ari', schoolYear: '2026-2027' });

  assert.equal(lastPage.pagination.page, 3);
  assert.equal(lastPage.pagination.pageSize, 20);
  assert.equal(lastPage.pagination.totalRecords, 41);
  assert.equal(lastPage.pagination.totalPages, 3);
  assert.equal(lastPage.pagination.from, 41);
  assert.equal(lastPage.pagination.to, 41);
  assert.deepEqual(lastPage.rows.map((row) => row.annual_enrollment_id), [10, 10], 'all matching placements for a paged annual record are returned');
  const lastPageQuery = observed.at(-1);
  assert.equal(lastPageQuery.values.offset, 40);
  assert.equal(lastPageQuery.values.pageSize, 20);
  assert.equal(lastPageQuery.values.searchPattern, '%Ari%');

  await service.listAnnualEnrollmentsPage(7, { page: 'not-a-page' });
  assert.equal(observed.at(-1).values.offset, 0, 'invalid page input safely returns to the first page');
});
