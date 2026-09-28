const express = require('express');
const { requireRole } = require('../middleware/roles');
const { createStudentRecordsService } = require('../services/studentRecordsService');
const { createAcademicRecordsService } = require('../services/academicRecordsService');
const { createFinanceService } = require('../services/financeService');
const { createClassScheduleService } = require('../services/classScheduleService');

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
    return { ownRecords, grades };
  }));

  router.get('/finance', (req, res) => renderOwnPage(req, res, 'student/finance', 'My finance account', async (userId) => ({
    finance: await finances.getOwnStudentAccount(userId)
  })));

  router.get('/records', (req, res) => renderOwnPage(req, res, 'student/records', 'My profile and enrollment history', async (userId) => ({
    ownRecords: await records.getOwnStudentRecord(userId)
  })));

  return router;
}

module.exports = { createStudentPortalRouter };
