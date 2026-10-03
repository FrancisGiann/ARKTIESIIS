'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  ACADEMIC_MARKER,
  EXPANSION_MARKER,
  AcademicExpansionError,
  buildPlan,
  buildWorkbooks,
  chooseScheduleSlots,
  parseOptions,
  validateHostApplyTarget,
  requirePrivateStorage,
  rollbackExpansionAttempt,
  discardUncertainConnection
} = require('../scripts/expand-hostinger-academic');
const { parseWorkbook } = require('../scripts/hostinger-academic-workbooks');

test('the academic plan creates connected grade 11 and 12 fixture rosters without demo display names', () => {
  const plan = buildPlan({ today: new Date('2026-10-03T00:00:00.000Z') });
  assert.equal(plan.newStudents.length, 120);
  assert.equal(plan.newStudents.filter(({ gradeLevel }) => gradeLevel === 'Grade 11').length, 60);
  assert.equal(plan.newStudents.filter(({ gradeLevel }) => gradeLevel === 'Grade 12').length, 60);
  assert.equal(new Set(plan.newStudents.map(({ studentNo }) => studentNo)).size, 120);
  assert.equal(new Set(plan.newStudents.map(({ lrn }) => lrn)).size, 120);
  for (const student of plan.newStudents) {
    assert.match(student.lrn, /^\d{12}$/);
    assert.match(student.phone, /^09\d{9}$/);
    assert.ok(student.birthDate < '2026-10-03');
    assert.doesNotMatch(`${student.firstName} ${student.lastName}`, /demo|\d/i);
  }
  for (const section of plan.normalizedSections) assert.doesNotMatch(section.newName, /demo/i);
  assert.deepEqual(plan.counts, {
    studentsAdded: 120,
    existingStudentsRenamed: 100,
    teacherAccountsAdded: 4,
    existingStaffProfilesRenamed: 4,
    subjectsAdded: 4,
    sectionsReused: 12,
    assignmentsAdded: 24,
    schedulesAdded: 24,
    approvedGradeRows: 960,
    pendingReviewSubmissions: 8,
    pendingReviewRows: 240,
    sourceFiles: 8,
    currentTermAfter: '2026-2027 Term 2'
  });
  assert.equal(ACADEMIC_MARKER, 'hostinger-academic-expansion-v1');
});

test('eight private workbook fixtures parse to their exact class contexts and thirty eligible students', async () => {
  const workbooks = buildWorkbooks(buildPlan({ today: new Date('2026-10-03T00:00:00.000Z') }));
  assert.equal(workbooks.length, 8);
  for (const workbook of workbooks) {
    assert.match(workbook.filename, /^SSHS-2026-2027-Term-2-Grade-(11|12)-(STEM|HUMSS)-[AB]-[A-Za-z-]+\.xlsx$/);
    assert.doesNotMatch(workbook.filename, /demo/i);
    const parsed = await parseWorkbook(workbook.buffer);
    assert.equal(parsed.context.schoolYear, '2026-2027');
    assert.equal(parsed.context.gradeLevel, workbook.subject.gradeLevel.replace('Grade ', ''));
    assert.equal(parsed.context.sectionName, `Grade ${workbook.subject.gradeLevel === 'Grade 11' ? '11' : '12'} ${workbook.suffix === 'A' ? 'STEM A' : 'HUMSS B'}`);
    assert.equal(parsed.context.subjectName, workbook.subject.name);
    assert.equal(parsed.rows.length, 30);
    assert.ok(parsed.rows.every((row) => !row.issue && row.grades.length === 4));
    assert.deepEqual(new Set(parsed.rows.map(({ lrn }) => lrn)), new Set(workbook.students.map(({ lrn }) => lrn)));
  }
});

test('the schedule planner skips existing overlaps and produces non-overlapping weekly slots', () => {
  const assignments = Array.from({ length: 24 }, (_, index) => ({ assignment: index + 1 }));
  const schedules = chooseScheduleSlots(assignments, [
    { day_of_week: 1, start_time: '07:00:00', end_time: '08:00:00' },
    { day_of_week: 2, start_time: '07:00:00', end_time: '09:00:00' }
  ]);
  assert.equal(schedules.length, 24);
  const all = [...schedules.map(({ dayOfWeek, startTime, endTime }) => ({
    day: dayOfWeek, start: startTime, end: endTime
  })), ...[
    { day: 1, start: '07:00:00', end: '08:00:00' },
    { day: 2, start: '07:00:00', end: '09:00:00' }
  ]];
  for (let left = 0; left < all.length; left += 1) {
    for (let right = left + 1; right < all.length; right += 1) {
      if (all[left].day !== all[right].day) continue;
      assert.ok(all[left].end <= all[right].start || all[right].end <= all[left].start);
    }
  }
});

test('the CLI requires exact database and prior-expansion acknowledgement before apply', () => {
  const baseArgs = ['--target-database', 'school_demo', '--confirm-database', 'school_demo',
    '--confirm-seed-marker', EXPANSION_MARKER];
  assert.equal(parseOptions(['--dry-run', ...baseArgs], 'school_demo').mode, 'dry-run');
  assert.throws(() => parseOptions(['--apply', ...baseArgs], 'school_demo'), /acknowledge/);
  assert.throws(() => parseOptions(['--dry-run', ...baseArgs.slice(0, -1), 'wrong-marker'], 'school_demo'), /exact hostinger-demo-expansion-v1/);
  assert.throws(() => parseOptions(['--dry-run', ...baseArgs], 'other_database'), /exactly match DB_NAME/);
  assert.throws(() => parseOptions(['--dry-run', '--apply', ...baseArgs,
    '--acknowledge-production-academic-expansion'], 'school_demo'), /exactly one mode/);
});

test('apply accepts only Hostinger localhost plus private storage outside the checkout', () => {
  const configuration = {
    nodeEnv: 'production', devPasswordOnlyLogin: false,
    database: { host: 'localhost', database: 'school_demo', user: 'school_user', password: 'private' },
    upload: { storageDirectory: path.join(os.tmpdir(), 'academic-fixture-private') }
  };
  assert.doesNotThrow(() => validateHostApplyTarget(configuration));
  assert.throws(() => validateHostApplyTarget({ ...configuration,
    database: { ...configuration.database, host: 'db.remote.invalid' } }), /DB_HOST=localhost/);
  assert.throws(() => validateHostApplyTarget({ ...configuration,
    upload: { storageDirectory: path.resolve(__dirname, '..', 'public', 'uploads') } }), /outside the checkout/);
});

test('private storage rejects symlinks and keeps fixture directories owner-only', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arktiesiis-academic-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = await requirePrivateStorage(root, { create: true });
  assert.equal((await fs.stat(storage.directory)).mode & 0o777, 0o700);
  await fs.rm(storage.directory, { recursive: true, force: true });
  const target = path.join(root, 'outside');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, storage.directory, 'dir');
  await assert.rejects(requirePrivateStorage(root, { create: true }), /real directory/);
});

test('rollback removes only known-uncommitted files and destroys uncertain sessions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arktiesiis-academic-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const removedPath = path.join(root, 'rolled-back.xlsx');
  await fs.writeFile(removedPath, 'temporary');
  const successful = await rollbackExpansionAttempt({ async rollback() {} }, {
    started: true, commitAttempted: false, createdFiles: [removedPath]
  });
  assert.deepEqual(successful, { destroyConnection: false });
  await assert.rejects(fs.access(removedPath));

  const preservedPath = path.join(root, 'uncertain.xlsx');
  await fs.writeFile(preservedPath, 'preserve for recovery');
  const state = { destroyed: 0 };
  const failed = await rollbackExpansionAttempt({ async rollback() { throw new Error('rollback uncertain'); } }, {
    started: true, commitAttempted: false, createdFiles: [preservedPath]
  });
  if (failed.destroyConnection) discardUncertainConnection({ destroy() { state.destroyed += 1; } });
  assert.deepEqual(failed, { destroyConnection: true });
  assert.equal(state.destroyed, 1);
  assert.equal(await fs.readFile(preservedPath, 'utf8'), 'preserve for recovery');

  const commitPath = path.join(root, 'commit-ambiguous.xlsx');
  await fs.writeFile(commitPath, 'keep until marker can be checked');
  await rollbackExpansionAttempt({ async rollback() {} }, {
    started: true, commitAttempted: true, createdFiles: [commitPath]
  });
  assert.equal(await fs.readFile(commitPath, 'utf8'), 'keep until marker can be checked');
});
