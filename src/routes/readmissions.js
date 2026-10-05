'use strict';

const express = require('express');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { ReadmissionError, createReadmissionService } = require('../services/readmissionService');

function createReadmissionRouter({ getPool, sql, readmissionService } = {}) {
  const router = express.Router();
  const service = readmissionService || createReadmissionService({ getPool, sql });
  const privateHeaders = (res) => res.set('Cache-Control', 'private, no-store, max-age=0').set('Pragma', 'no-cache');
  const renderError = (res, error) => {
    if (error instanceof ReadmissionError) return res.status(error.status).render('error', { title: 'Balik-aral evaluation', message: error.message });
    return res.status(503).render('error', { title: 'Balik-aral evaluation unavailable', message: 'Readmission information could not be loaded or saved.' });
  };

  router.get('/', async (req, res) => {
    try {
      const rows = await service.list(req.authUser.id, req.query || {});
      return privateHeaders(res).render('readmissions/index', {
        title: 'Balik-aral evaluations', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), rows,
        filterStatus: req.query?.status || '', query: req.query || {}
      });
    } catch (error) { return renderError(res, error); }
  });

  router.get('/new', (req, res) => {
    if (req.authUser.role !== 'registrar') return res.status(403).render('error', { title: 'Read-only access', message: 'Database administrators can review evaluations but cannot create them.' });
    return privateHeaders(res).render('readmissions/form', {
      title: 'New balik-aral evaluation', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), evaluation: null,
      values: { schoolYear: '', targetGradeLevel: '', subjectAvailability: 'unresolved' }, error: null
    });
  });

  router.post('/', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      const result = await service.create(req.authUser.id, req.body || {});
      return res.redirect(303, `/registrar/readmissions/${encodeURIComponent(result.id)}`);
    } catch (error) { return renderError(res, error); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const evaluation = await service.get(req.authUser.id, req.params.id);
      return privateHeaders(res).render('readmissions/form', {
        title: 'Balik-aral evaluation', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), evaluation,
        values: {}, error: null
      });
    } catch (error) { return renderError(res, error); }
  });

  router.post('/:id', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await service.update(req.authUser.id, req.params.id, req.body?.version, req.body || {});
      return res.redirect(303, `/registrar/readmissions/${encodeURIComponent(req.params.id)}`);
    } catch (error) { return renderError(res, error); }
  });

  router.post('/:id/decision', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await service.decide(req.authUser.id, req.params.id, req.body?.version, req.body?.decision, req.body?.decisionReason);
      return res.redirect(303, `/registrar/readmissions/${encodeURIComponent(req.params.id)}`);
    } catch (error) { return renderError(res, error); }
  });

  return router;
}

module.exports = { createReadmissionRouter };
