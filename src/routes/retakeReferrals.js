'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { formatFinanceDateTime } = require('../utils/financeDateTime');
const { RetakeReferralError } = require('../services/retakeReferralService');

function privateResponse(res) {
  return res.set('Cache-Control', 'private, no-store');
}

function cleanValue(value, maxLength, multiline = false) {
  if (typeof value !== 'string') return '';
  const controlPattern = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return value.slice(0, maxLength).replace(controlPattern, '').replace(/\r\n?/g, '\n');
}

function createRegistrarRetakeReferralRouter({ retakeReferralService } = {}) {
  const router = express.Router();
  const service = retakeReferralService;
  if (!service) throw new TypeError('A retake referral service is required.');

  async function renderIndex(req, res, { status = 200, error = null, values = {} } = {}) {
    try {
      const targets = await service.listTargets(req.authUser.id);
      return privateResponse(res).status(status).render('retake-referrals/registrar-index', {
        title: 'Retake referrals', currentUser: req.authUser, csrfToken: ensureCsrfToken(req), targets,
        error, values, idempotencyKey: crypto.randomUUID()
      });
    } catch (loadError) {
      if (loadError instanceof RetakeReferralError) return res.status(loadError.status).render('error', { title: 'Retake referrals', message: loadError.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Retake referral records could not be loaded.' });
    }
  }

  async function renderReferral(req, res, referralId, { status = 200, error = null, values = {}, editValues = {}, referenceValue = null } = {}) {
    try {
      const referral = await service.getReferral(req.authUser.id, referralId);
      const history = await service.listReferralHistory(req.authUser.id, referral.annual_enrollment_id);
      const [subjects, termOptions] = await Promise.all([
        service.listTargetSubjects(req.authUser.id, referral.annual_enrollment_id),
        service.listTargetTerms(req.authUser.id, referral.annual_enrollment_id)
      ]);
      return privateResponse(res).status(status).render('retake-referrals/registrar-detail', {
        title: `Retake referral · ${referral.student_name}`, currentUser: req.authUser, csrfToken: ensureCsrfToken(req),
        referral, history, subjects, termOptions, values, editValues, referenceValue, error, formatFinanceDateTime,
        itemKeyToken: crypto.randomUUID(),
        correctionToken: crypto.randomUUID()
      });
    } catch (loadError) {
      if (loadError instanceof RetakeReferralError) return res.status(loadError.status).render('error', { title: 'Retake referral', message: loadError.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The retake referral could not be loaded.' });
    }
  }

  router.get('/', (req, res) => renderIndex(req, res));

  router.post('/', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      const result = await service.createDraft(req.authUser.id, req.body?.annualEnrollmentId, {
        evaluationReference: req.body?.evaluationReference, idempotencyKey: req.body?.idempotencyKey
      });
      return privateResponse(res).redirect(303, `/registrar/retake-referrals/${result.referralId}`);
    } catch (error) {
      if (error instanceof RetakeReferralError) return renderIndex(req, res, { status: error.status, error: error.message, values: {
        annualEnrollmentId: cleanValue(req.body?.annualEnrollmentId, 12),
        evaluationReference: cleanValue(req.body?.evaluationReference, 160)
      } });
      return res.status(503).render('error', { title: 'Create retake referral', message: 'The draft referral could not be created.' });
    }
  });

  router.get('/:referralId', (req, res) => renderReferral(req, res, req.params.referralId));

  router.post('/:referralId/reference', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await service.updateEvaluationReference(req.authUser.id, req.params.referralId, req.body || {});
      return privateResponse(res).redirect(303, `/registrar/retake-referrals/${encodeURIComponent(req.params.referralId)}`);
    } catch (error) {
      if (error instanceof RetakeReferralError) return renderReferral(req, res, req.params.referralId, {
        status: error.status, error: error.message, referenceValue: cleanValue(req.body?.evaluationReference, 160)
      });
      return res.status(503).render('error', { title: 'Update evaluation reference', message: 'The reference could not be updated.' });
    }
  });

  router.post('/:referralId/items', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await service.addItem(req.authUser.id, req.params.referralId, req.body || {});
      return privateResponse(res).redirect(303, `/registrar/retake-referrals/${encodeURIComponent(req.params.referralId)}`);
    } catch (error) {
      if (error instanceof RetakeReferralError) return renderReferral(req, res, req.params.referralId, { status: error.status, error: error.message, values: {
        subjectName: cleanValue(req.body?.subjectName, 120), subjectId: cleanValue(req.body?.subjectId, 12),
        targetTerm: cleanValue(req.body?.targetTerm, 2), financeExplanation: cleanValue(req.body?.financeExplanation, 500, true)
      } });
      return res.status(503).render('error', { title: 'Add retake item', message: 'The item could not be saved.' });
    }
  });

  router.post('/:referralId/items/:itemId/update', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await service.editItem(req.authUser.id, req.params.referralId, req.params.itemId, req.body || {});
      return privateResponse(res).redirect(303, `/registrar/retake-referrals/${encodeURIComponent(req.params.referralId)}`);
    } catch (error) {
      if (error instanceof RetakeReferralError) return renderReferral(req, res, req.params.referralId, { status: error.status, error: error.message, editValues: {
        [String(req.params.itemId)]: {
          subjectName: cleanValue(req.body?.subjectName, 120), subjectId: cleanValue(req.body?.subjectId, 12),
          targetTerm: cleanValue(req.body?.targetTerm, 2), financeExplanation: cleanValue(req.body?.financeExplanation, 500, true)
        }
      } });
      return res.status(503).render('error', { title: 'Update retake item', message: 'The item could not be updated.' });
    }
  });

  router.post('/:referralId/items/:itemId/remove', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await service.removeItem(req.authUser.id, req.params.referralId, req.params.itemId);
      return privateResponse(res).redirect(303, `/registrar/retake-referrals/${encodeURIComponent(req.params.referralId)}`);
    } catch (error) {
      if (error instanceof RetakeReferralError) return renderReferral(req, res, req.params.referralId, { status: error.status, error: error.message });
      return res.status(503).render('error', { title: 'Remove retake item', message: 'The item could not be removed.' });
    }
  });

  router.post('/:referralId/finalize', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      await service.finalize(req.authUser.id, req.params.referralId);
      return privateResponse(res).redirect(303, `/registrar/retake-referrals/${encodeURIComponent(req.params.referralId)}`);
    } catch (error) {
      if (error instanceof RetakeReferralError) return renderReferral(req, res, req.params.referralId, { status: error.status, error: error.message });
      return res.status(503).render('error', { title: 'Finalize retake referral', message: 'The referral could not be finalized.' });
    }
  });

  router.post('/:referralId/corrections', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload and try again.' });
    try {
      const result = await service.startCorrection(req.authUser.id, req.params.referralId, req.body?.idempotencyKey);
      return privateResponse(res).redirect(303, `/registrar/retake-referrals/${result.referralId}`);
    } catch (error) {
      if (error instanceof RetakeReferralError) return renderReferral(req, res, req.params.referralId, { status: error.status, error: error.message });
      return res.status(503).render('error', { title: 'Correct retake referral', message: 'A correction draft could not be started.' });
    }
  });

  return router;
}

function createFinanceRetakeReferralRouter({ retakeReferralService } = {}) {
  const router = express.Router();
  const service = retakeReferralService;
  if (!service) throw new TypeError('A retake referral service is required.');
  router.get('/', async (req, res) => {
    try {
      const items = await service.listFinanceQueue(req.authUser.id);
      return privateResponse(res).render('retake-referrals/finance-queue', {
        title: 'Retake review', currentUser: req.authUser, items,
        notice: req.query.notice === 'saved' ? 'The Finance decision was saved.' : null
      });
    } catch (error) {
      if (error instanceof RetakeReferralError) return res.status(error.status).render('error', { title: 'Retake review', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Finalized retake items could not be loaded.' });
    }
  });

  router.get('/items/:itemKeyId', async (req, res) => {
    try {
      const item = await service.getFinanceItem(req.authUser.id, req.params.itemKeyId);
      return privateResponse(res).render('retake-referrals/finance-item', {
        title: `Retake review · ${item.student_name}`, currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req), item, idempotencyKey: crypto.randomUUID()
      });
    } catch (error) {
      if (error instanceof RetakeReferralError) return res.status(error.status).render('error', { title: 'Retake review', message: error.message });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The retake item could not be loaded.' });
    }
  });

  return router;
}

module.exports = { createRegistrarRetakeReferralRouter, createFinanceRetakeReferralRouter };
