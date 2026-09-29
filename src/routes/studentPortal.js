const express = require('express');
const { requireRole } = require('../middleware/roles');
const { createStudentRecordsService } = require('../services/studentRecordsService');
const { createAcademicRecordsService } = require('../services/academicRecordsService');
const { createFinanceService } = require('../services/financeService');
const { createClassScheduleService } = require('../services/classScheduleService');

const gradeLabelCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const ordinalRanks = new Map([
  ['first', 1], ['1st', 1], ['second', 2], ['2nd', 2], ['third', 3], ['3rd', 3],
  ['fourth', 4], ['4th', 4], ['fifth', 5], ['5th', 5], ['sixth', 6], ['6th', 6]
]);

function labelRank(value) {
  const label = String(value || '').toLowerCase();
  const ordinal = label.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th)\b/);
  if (ordinal) return ordinalRanks.get(ordinal[1]);
  const numeric = label.match(/\b(?:term|semester|grading|quarter)\s+(\d+)\b/);
  if (numeric) return Number(numeric[1]);
  const quarter = label.match(/\bquarter\s+([a-z])\b/);
  if (quarter) return quarter[1].charCodeAt(0) - 96;
  return null;
}

function compareLabels(left, right) {
  const leftRank = labelRank(left);
  const rightRank = labelRank(right);
  if (leftRank !== null && rightRank !== null && leftRank !== rightRank) return leftRank - rightRank;
  return gradeLabelCollator.compare(String(left || ''), String(right || ''));
}

function makeGradeSelection(grades, enrollments, requestedSemester, requestedPeriod) {
  const semesterMap = new Map();
  for (const grade of grades) {
    const schoolYear = grade.school_year == null ? '' : String(grade.school_year);
    const term = grade.term == null ? '' : String(grade.term);
    const key = JSON.stringify([schoolYear, term]);
    let semester = semesterMap.get(key);
    if (!semester) {
      semester = { key, schoolYear, term, periods: new Map() };
      semesterMap.set(key, semester);
    }
    const period = grade.grading_period == null ? '' : String(grade.grading_period);
    if (!semester.periods.has(period)) semester.periods.set(period, []);
    semester.periods.get(period).push(grade);
  }

  const semesters = [...semesterMap.values()].sort((left, right) => {
    const yearOrder = gradeLabelCollator.compare(left.schoolYear, right.schoolYear);
    return yearOrder || compareLabels(left.term, right.term);
  });
  if (!semesters.length) return null;

  const currentEnrollment = (enrollments || []).find((enrollment) => enrollment.is_current === true || enrollment.is_current === 1);
  const currentKey = currentEnrollment
    ? JSON.stringify([
      currentEnrollment.school_year == null ? '' : String(currentEnrollment.school_year),
      currentEnrollment.term == null ? '' : String(currentEnrollment.term)
    ])
    : null;
  const requestedGroup = typeof requestedSemester === 'string'
    ? semesters.find((semester) => semester.key === requestedSemester)
    : null;
  const selectedSemester = requestedGroup || semesters.find((semester) => semester.key === currentKey) || semesters[semesters.length - 1];
  const periods = [...selectedSemester.periods.entries()]
    .map(([value, periodGrades]) => ({ value, label: value || 'Not listed', grades: periodGrades }))
    .sort((left, right) => compareLabels(left.value, right.value));
  const selectedPeriod = (typeof requestedPeriod === 'string'
    ? periods.find((period) => period.value === requestedPeriod)
    : null) || periods[periods.length - 1];
  const uniqueSubjects = new Map();
  for (const grade of selectedPeriod.grades) {
    const key = String(grade.subject_code || grade.subject_name || '').trim().toLocaleLowerCase();
    if (key && !uniqueSubjects.has(key)) uniqueSubjects.set(key, grade);
  }

  return {
    semesters: semesters.map((semester) => ({
      value: semester.key,
      label: [semester.schoolYear, semester.term].filter(Boolean).join(' · ') || 'Semester not listed'
    })),
    selectedSemester: selectedSemester.key,
    selectedSemesterLabel: [selectedSemester.schoolYear, selectedSemester.term].filter(Boolean).join(' · ') || 'Semester not listed',
    periods: periods.map(({ value, label }) => ({ value, label })),
    selectedPeriod: selectedPeriod.value,
    selectedPeriodLabel: selectedPeriod.label,
    grades: [...uniqueSubjects.values()].sort((left, right) => gradeLabelCollator.compare(left.subject_name || '', right.subject_name || ''))
  };
}

function createStudentPortalRouter({ getPool, sql, studentRecordsService, academicRecordsService, financeService, classScheduleService } = {}) {
  const router = express.Router();
  const records = studentRecordsService || createStudentRecordsService({ getPool, sql });
  const academics = academicRecordsService || createAcademicRecordsService({ getPool, sql });
  const finances = financeService || createFinanceService({ getPool, sql });
  const schedules = classScheduleService || createClassScheduleService({ getPool, sql });

  router.use(requireRole('student'));

  async function renderOwnPage(req, res, view, title, loadData) {
    try {
      const data = await loadData(req.authUser.id);
      return res.render(view, { title, currentUser: req.authUser, ...data });
    } catch {
      return res.status(503).render('error', {
        title: 'Student space unavailable', message: 'Your school information could not be loaded right now.'
      });
    }
  }

  router.get('/', (req, res) => renderOwnPage(req, res, 'dashboards/student', 'My school day', async (userId) => {
    const [ownRecords, classSchedule] = await Promise.all([
      records.getOwnStudentRecord(userId),
      schedules.getOwnStudentSchedule(userId)
    ]);
    return { ownRecords, classSchedule };
  }));

  router.get('/schedule', (req, res) => renderOwnPage(req, res, 'student/schedule', 'My class schedule', async (userId) => {
    const [ownRecords, classSchedule] = await Promise.all([
      records.getOwnStudentRecord(userId), schedules.getOwnStudentSchedule(userId)
    ]);
    return { ownRecords, classSchedule };
  }));

  router.get('/grades', (req, res) => renderOwnPage(req, res, 'student/grades', 'My grades', async (userId) => {
    const ownRecords = await records.getOwnStudentRecord(userId);
    const grades = ownRecords ? await academics.getOwnGrades(userId) : [];
    const gradeSelection = makeGradeSelection(grades, ownRecords?.enrollments, req.query.semester, req.query.gradingPeriod);
    return { ownRecords, gradeSelection };
  }));

  router.get('/finance', (req, res) => renderOwnPage(req, res, 'student/finance', 'My finance account', async (userId) => ({
    finance: await finances.getOwnStudentAccount(userId)
  })));

  router.get('/records', (req, res) => renderOwnPage(req, res, 'student/records', 'My profile and enrollment history', async (userId) => ({
    ownRecords: await records.getOwnStudentRecord(userId)
  })));

  return router;
}

module.exports = { createStudentPortalRouter, makeGradeSelection };
