const express = require('express');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { ClassScheduleError, createClassScheduleService, positiveId } = require('../services/classScheduleService');

const notices = {
  scheduleCreated: 'Class time added.',
  scheduleUpdated: 'Class time updated.',
  scheduleRemoved: 'Class time removed.'
};

function scheduleContext(req) {
  const source = req.method === 'GET' ? req.query : req.body || {};
  return {
    termId: source.termId ?? '',
    sectionId: source.sectionId ?? source.filterSectionId ?? '',
    assignmentId: req.method === 'GET'
      ? source.assignmentId ?? ''
      : source.filterAssignmentId ?? ''
  };
}

function scheduleUrl(context, notice, focusScheduleId = null, showCreate = false) {
  const query = new URLSearchParams();
  if (context.termId) query.set('termId', context.termId);
  if (context.sectionId) query.set('sectionId', context.sectionId);
  if (context.assignmentId) query.set('assignmentId', context.assignmentId);
  if (focusScheduleId) query.set('focusScheduleId', String(focusScheduleId));
  if (showCreate) query.set('showCreate', '1');
  if (notice) query.set('notice', notice);
  const serialized = query.toString();
  return `/registrar/schedules${serialized ? `?${serialized}` : ''}`;
}

function createClassSchedulesRouter({ getPool, sql, classScheduleService } = {}) {
  const router = express.Router();
  const service = classScheduleService || createClassScheduleService({ getPool, sql });

  async function renderWorkspace(req, res, { status = 200, error = null, values = {}, filters = null, editScheduleId = null } = {}) {
    try {
      const context = filters || scheduleContext(req);
      const workspace = await service.listRegistrarWorkspace(req.authUser.id, context);
      return res.status(status).render('registrar/schedules', {
        title: 'Class schedules',
        currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req),
        notice: notices[req.query.notice] || null,
        error,
        values,
        editScheduleId,
        focusScheduleId: positiveId(req.query?.focusScheduleId),
        showCreate: req.query?.showCreate === '1' || Boolean(error),
        ...workspace
      });
    } catch (loadError) {
      if (loadError instanceof ClassScheduleError) {
        return res.status(loadError.status).render('registrar/schedules', {
          title: 'Class schedules', currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
          notice: null, error: loadError.message, values, editScheduleId, focusScheduleId: null, showCreate: true,
          terms: [], sections: [], academicTermId: null, selectedSectionId: null,
          selectedAssignmentId: null, contextNotice: null, assignments: [], schedules: []
        });
      }
      return res.status(503).render('error', {
        title: 'Service Unavailable', message: 'Class schedules are temporarily unavailable.'
      });
    }
  }

  router.get('/', (req, res) => renderWorkspace(req, res));

  router.post('/', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await service.saveSchedule(req.authUser.id, null, req.body);
      return res.redirect(303, `${scheduleUrl(scheduleContext(req), 'scheduleCreated', null, true)}#schedule-create-title`);
    } catch (error) {
      const status = error instanceof ClassScheduleError ? error.status : 503;
      const message = error instanceof ClassScheduleError ? error.message : 'The class time could not be saved.';
      return renderWorkspace(req, res, { status, error: message, values: req.body || {}, filters: scheduleContext(req) });
    }
  });

  router.post('/:id', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).render('error', { title: 'Not Found', message: 'Class schedule not found.' });
    try {
      await service.saveSchedule(req.authUser.id, id, req.body);
      return res.redirect(303, `${scheduleUrl(scheduleContext(req), 'scheduleUpdated', id)}#schedule-${id}`);
    } catch (error) {
      const status = error instanceof ClassScheduleError ? error.status : 503;
      const message = error instanceof ClassScheduleError ? error.message : 'The class time could not be updated.';
      return renderWorkspace(req, res, { status, error: message, values: req.body || {}, filters: scheduleContext(req), editScheduleId: id });
    }
  });

  router.post('/:id/delete', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).render('error', { title: 'Not Found', message: 'Class schedule not found.' });
    try {
      await service.deleteSchedule(req.authUser.id, id);
      return res.redirect(303, `${scheduleUrl(scheduleContext(req), 'scheduleRemoved')}#schedule-list-title`);
    } catch (error) {
      if (error instanceof ClassScheduleError) return renderWorkspace(req, res, {
        status: error.status, error: error.message, filters: scheduleContext(req)
      });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The class time could not be removed.' });
    }
  });

  return router;
}

module.exports = { createClassSchedulesRouter };
