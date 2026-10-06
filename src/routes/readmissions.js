'use strict';

const express = require('express');
const { hasValidCsrfToken } = require('../middleware/auth');
const { ReadmissionError, createReadmissionService } = require('../services/readmissionService');

function createReadmissionRouter({ getPool, sql, readmissionService } = {}) {
  const router = express.Router();
  const service = readmissionService || createReadmissionService({ getPool, sql });
  const recordsPath = '/registrar/records';
  const privateHeaders = (res) => res.set('Cache-Control', 'private, no-store, max-age=0').set('Pragma', 'no-cache');
  const renderError = (res, error) => {
    if (error instanceof ReadmissionError) return res.status(error.status).render('error', { title: 'Return evaluation', message: error.message });
    return res.status(503).render('error', { title: 'Return evaluation unavailable', message: 'The evaluation could not be loaded or saved.' });
  };

  function evaluationPath(evaluation) {
    if (evaluation.student_id) {
      return `${recordsPath}/students/${encodeURIComponent(evaluation.student_id)}/return-evaluations/${encodeURIComponent(evaluation.id)}`;
    }
    return `${recordsPath}/return-evaluations/${encodeURIComponent(evaluation.id)}`;
  }

  router.get('/', (req, res) => {
    const query = new URLSearchParams();
    if (typeof req.query?.search === 'string' && req.query.search.trim()) query.set('search', req.query.search.slice(0, 100));
    if (typeof req.query?.status === 'string' && ['under_review', 'accepted', 'not_accepted'].includes(req.query.status)) {
      query.set('returnStatus', req.query.status);
    }
    const suffix = query.toString();
    return privateHeaders(res).redirect(303, `${recordsPath}${suffix ? `?${suffix}` : ''}`);
  });

  router.get('/new', (req, res) => privateHeaders(res).redirect(303, `${recordsPath}/return-evaluations/new`));

  router.post('/', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      const result = await service.create(req.authUser.id, req.body || {});
      const evaluation = await service.get(req.authUser.id, result.id);
      return privateHeaders(res).redirect(303, evaluationPath(evaluation));
    } catch (error) { return renderError(res, error); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const evaluation = await service.get(req.authUser.id, req.params.id);
      return privateHeaders(res).redirect(303, evaluationPath(evaluation));
    } catch (error) { return renderError(res, error); }
  });

  router.post('/:id', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await service.update(req.authUser.id, req.params.id, req.body?.version, req.body || {});
      const evaluation = await service.get(req.authUser.id, req.params.id);
      return privateHeaders(res).redirect(303, evaluationPath(evaluation));
    } catch (error) { return renderError(res, error); }
  });

  router.post('/:id/decision', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await service.decide(req.authUser.id, req.params.id, req.body?.version, req.body?.decision, req.body?.decisionReason);
      const evaluation = await service.get(req.authUser.id, req.params.id);
      return privateHeaders(res).redirect(303, evaluationPath(evaluation));
    } catch (error) { return renderError(res, error); }
  });

  return router;
}

module.exports = { createReadmissionRouter };
