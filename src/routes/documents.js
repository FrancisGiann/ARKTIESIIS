const express = require('express');
const multer = require('multer');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { DocumentServiceError, createDocumentService, normalizeId, verificationChecklistItems } = require('../services/documentService');
const { createDocumentProcessingService } = require('../services/documentProcessingService');
const { createLocalOcrService } = require('../services/localOcrService');
const { Form137ScanError, createForm137ScanService } = require('../services/form137ScanService');

const STAFF_ROLES = ['registrar', 'database_admin'];
const DOCUMENT_TYPES = [
  { value: 'good_moral', label: 'Good Moral Certificate' },
  { value: 'report_card', label: 'Report card' },
  { value: 'form_137', label: 'Form 137' },
  { value: 'psa_birth_certificate', label: 'PSA birth certificate' }
];
const STUDENT_DOCUMENT_TYPES = DOCUMENT_TYPES.filter(({ value }) => ['good_moral', 'psa_birth_certificate'].includes(value));
const STAFF_UPLOAD_DOCUMENT_TYPES = DOCUMENT_TYPES.filter(({ value }) => !['form_137', 'report_card'].includes(value));

function configuredMaxBytes(environment) {
  const maxMb = Number(environment?.upload?.maxMb ?? 10);
  const maxBytes = Math.floor(maxMb * 1024 * 1024);
  return Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 10 * 1024 * 1024;
}

function configuredMaxMegabytes(environment) {
  const maxMb = Number(environment?.upload?.maxMb ?? 10);
  return Number.isFinite(maxMb) && maxMb > 0 ? maxMb : 10;
}

function documentTypeLabel(value) {
  return DOCUMENT_TYPES.find((documentType) => documentType.value === value)?.label || 'Document';
}

function documentStatusLabel(status, latestDecisionType, latestReviewAction, documentType) {
  if (documentType === 'report_card') return 'Historical archive';
  if (status === 'valid') return 'Verified after staff source inspection';
  if (status === 'rejected') return 'Rejected after staff review';
  if (status === 'failed') return 'OCR could not process; staff review required';
  if (status === 'pending') return 'Waiting for OCR';
  if (status === 'processing') return 'OCR processing';
  if (status === 'needs_review') {
    return latestDecisionType === 'correction_requested' || latestReviewAction === 'correction_requested'
      ? 'Correction requested'
      : 'Awaiting staff review';
  }
  return 'Status unavailable';
}

function uploadErrorMessage(error) {
  if (error?.code === 'LIMIT_FILE_SIZE') return 'The selected file exceeds the configured upload limit.';
  if (error?.code === 'LIMIT_UNEXPECTED_FILE') return 'Choose one PDF, JPEG, or PNG file.';
  return 'The upload request could not be processed. Check the file and try again.';
}

function clearUploadBuffer(file) {
  if (Buffer.isBuffer(file?.buffer)) file.buffer.fill(0);
}

function createDocumentsRouter({ getPool, sql, environment, documentService, documentProcessingService, form137ScanService } = {}) {
  const router = express.Router();
  const maxUploadBytes = configuredMaxBytes(environment);
  const uploadMaxMb = configuredMaxMegabytes(environment);
  const service = documentService || createDocumentService({
    getPool,
    sql,
    storageDirectory: environment?.upload?.storageDirectory,
    maxUploadBytes: configuredMaxBytes(environment)
  });
  const processingService = documentProcessingService || createDocumentProcessingService({
    getPool,
    sql,
    storageDirectory: environment?.upload?.storageDirectory,
    maxFileBytes: configuredMaxBytes(environment),
    ocrConfig: environment?.ocr,
    timeoutMs: environment?.ocr?.timeoutMs,
    concurrency: environment?.ocr?.concurrency
  });
  const scanService = form137ScanService || createForm137ScanService({
    getStudentDocuments: service.getStudentDocuments,
    localOcr: createLocalOcrService({ ocrConfig: environment?.ocr, uploadConfig: environment?.upload }),
    maxUploadBytes,
    timeoutMs: environment?.ocr?.timeoutMs,
    concurrency: environment?.ocr?.concurrency
  });
  const parseSingleUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 5, fieldSize: 2048 }
  }).single('document');
  const parseSingleForm137Scan = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 5, fieldSize: 2048 }
  }).single('form137Scan');

  router.use(requireRole('student', ...STAFF_ROLES));

  function renderError(res, error, fallback = 'Documents could not be loaded.') {
    if (error instanceof DocumentServiceError) {
      return res.status(error.status).render('error', {
        title: error.status === 404 ? 'Not Found' : error.status === 403 ? 'Forbidden' : 'Document Request',
        message: error.message
      });
    }
    return res.status(503).render('error', { title: 'Service Unavailable', message: fallback });
  }

  function parseUpload(req, res, next) {
    parseSingleUpload(req, res, (error) => {
      if (!error) return next();
      clearUploadBuffer(req.file);
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).render('error', {
        title: 'Upload Error',
        message: uploadErrorMessage(error)
      });
    });
  }

  async function renderDocumentList(req, res, { status = 200, error = null, documentType = '' } = {}) {
    try {
      const result = await service.listDocuments(req.authUser.id, req.query.search);
      return res.status(status).render('documents/index', {
        title: 'Documents',
        currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req),
        documents: result.documents,
        searchTerm: result.searchTerm,
        isStaff: result.isStaff,
        documentTypes: result.isStaff ? STAFF_UPLOAD_DOCUMENT_TYPES : STUDENT_DOCUMENT_TYPES,
        form137Status: result.form137Status,
        documentType,
        uploadMaxMb,
        error,
        notice: req.query.notice === 'uploaded'
          ? 'Document uploaded.'
          : null,
        documentTypeLabel,
        documentStatusLabel
      });
    } catch (loadError) {
      return renderError(res, loadError, 'Documents could not be loaded.');
    }
  }

  async function renderStudentDocuments(req, res, studentId, { status = 200, error = null, form137Scan = null } = {}) {
    try {
      const workspace = await service.getStudentDocuments(req.authUser.id, studentId);
      if (!workspace) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
      return res.status(status).render('documents/student', {
        title: 'Student Documents',
        currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req),
        student: workspace.student,
        documents: workspace.documents,
        documentTypes: STAFF_UPLOAD_DOCUMENT_TYPES,
        form137Status: workspace.form137Status,
        form137StatusHistory: workspace.form137StatusHistory,
        form137Scan,
        ocrMaxPdfPages: environment?.ocr?.maxPdfPages,
        uploadMaxMb,
        error,
        notice: req.query.notice === 'uploaded'
          ? 'Document uploaded.'
          : req.query.notice === 'form137StatusRecorded'
            ? 'Form 137 status recorded.'
            : null,
        documentTypeLabel,
        documentStatusLabel
      });
    } catch (loadError) {
      return renderError(res, loadError, 'Student documents could not be loaded.');
    }
  }

  router.get('/', (req, res) => renderDocumentList(req, res));

  router.post('/', parseUpload, async (req, res) => {
    try {
      if (!hasValidCsrfToken(req)) {
        return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
      }
      const result = await service.upload(req.authUser.id, req.body, req.file);
      processingService.schedulePendingProcessing();
      return res.redirect(303, `/documents/${result.id}?notice=uploaded`);
    } catch (error) {
      return renderError(res, error, 'The document could not be uploaded.');
    } finally {
      clearUploadBuffer(req.file);
    }
  });

  router.get('/students/:studentId', requireRole(...STAFF_ROLES), async (req, res) => {
    const studentId = normalizeId(req.params.studentId);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    return renderStudentDocuments(req, res, studentId);
  });

  router.post('/students/:studentId', requireRole(...STAFF_ROLES), parseUpload, async (req, res) => {
    const studentId = normalizeId(req.params.studentId);
    try {
      if (!hasValidCsrfToken(req)) {
        return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
      }
      if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
      const result = await service.upload(req.authUser.id, { ...req.body, studentId }, req.file);
      processingService.schedulePendingProcessing();
      return res.redirect(303, `/documents/students/${studentId}?notice=uploaded`);
    } catch (error) {
      if (error instanceof DocumentServiceError && error.status < 500) {
        return renderStudentDocuments(req, res, studentId, { status: error.status, error: error.message });
      }
      return renderError(res, error, 'The document could not be uploaded.');
    } finally {
      clearUploadBuffer(req.file);
    }
  });

  router.post('/students/:studentId/form137-status', requireRole(...STAFF_ROLES), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const studentId = normalizeId(req.params.studentId);
    if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
    try {
      await service.recordForm137Status(req.authUser.id, studentId, req.body?.status, req.body?.instruction);
      return res.redirect(303, `/documents/students/${studentId}?notice=form137StatusRecorded`);
    } catch (error) {
      if (error instanceof DocumentServiceError && error.status < 500) {
        return renderStudentDocuments(req, res, studentId, { status: error.status, error: error.message });
      }
      return renderError(res, error, 'The Form 137 status could not be saved.');
    }
  });

  router.post('/students/:studentId/form137-scan', requireRole(...STAFF_ROLES), (req, res, next) => {
    parseSingleForm137Scan(req, res, (error) => {
      res.set('Cache-Control', 'private, no-store');
      res.set('Pragma', 'no-cache');
      if (!error) return next();
      clearUploadBuffer(req.file);
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).render('error', {
        title: 'Form 137 Scan',
        message: error.code === 'LIMIT_FILE_SIZE'
          ? 'The selected scan exceeds the configured upload limit.'
          : 'Choose one PDF, JPEG, or PNG scan file.'
      });
    });
  }, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Pragma', 'no-cache');
    let studentId = null;
    try {
      if (!hasValidCsrfToken(req)) {
        return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
      }
      studentId = normalizeId(req.params.studentId);
      if (!studentId) return res.status(404).render('error', { title: 'Not Found', message: 'Student record not found.' });
      const result = await scanService.scan(req.authUser.id, studentId, req.file);
      return renderStudentDocuments(req, res, studentId, { form137Scan: result });
    } catch (error) {
      if (error instanceof DocumentServiceError || error instanceof Form137ScanError) {
        return renderStudentDocuments(req, res, studentId, { status: error.status, error: error.message });
      }
      return renderError(res, error, 'The temporary Form 137 scan could not be processed. Inspect the physical paper and record its status manually.');
    } finally {
      clearUploadBuffer(req.file);
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const document = await service.getDocument(req.authUser.id, req.params.id);
      if (!document) return res.status(404).render('error', { title: 'Not Found', message: 'Document not found.' });
      const { stored_filename, student_user_id, uploader_role, uploaded_by, ...visibleDocument } = document;
      return res.render('documents/detail', {
        title: documentTypeLabel(document.document_type),
        currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req),
        document: visibleDocument,
        documentTypes: document.isStaff ? STAFF_UPLOAD_DOCUMENT_TYPES : STUDENT_DOCUMENT_TYPES,
        uploadMaxMb,
        isStaff: document.isStaff,
        verificationChecklistItems: document.isStaff ? verificationChecklistItems(document.document_type) : [],
        documentStatusLabel,
        error: null,
        notice: req.query.notice === 'uploaded'
          ? 'Document uploaded.'
          : req.query.notice === 'reviewRequested'
            ? 'Document sent for staff review.'
          : req.query.notice === 'correctionRequested'
            ? 'Correction request recorded.'
            : req.query.notice === 'decisionRecorded'
              ? 'Staff decision recorded.'
              : null,
        documentTypeLabel
      });
    } catch (error) {
      return renderError(res, error, 'The document could not be loaded.');
    }
  });

  router.get('/:id/download', async (req, res) => {
    try {
      const { document, fileHandle, size } = await service.openDownload(req.authUser.id, req.params.id);
      const encodedFilename = encodeURIComponent(document.original_filename).replaceAll("'", '%27').replaceAll('(', '%28').replaceAll(')', '%29');
      const extension = document.original_filename.match(/\.(pdf|jpe?g|png)$/i)?.[1]?.toLowerCase() || 'bin';
      res.set({
        'Content-Type': document.mime_type,
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="document.${extension}"; filename*=UTF-8''${encodedFilename}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      const stream = fileHandle.createReadStream({ autoClose: true });
      stream.on('error', () => {
        if (!res.headersSent) return res.status(404).render('error', { title: 'Not Found', message: 'Document not found.' });
        res.destroy();
      });
      return stream.pipe(res);
    } catch (error) {
      return renderError(res, error, 'The document could not be downloaded.');
    }
  });

  router.post('/:id/review', requireRole(...STAFF_ROLES), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await service.addReviewEvent(req.authUser.id, req.params.id, 'review_requested');
      return res.redirect(303, `/documents/${normalizeId(req.params.id)}?notice=reviewRequested`);
    } catch (error) {
      return renderError(res, error, 'The document could not be sent for review.');
    }
  });

  router.post('/:id/correction', requireRole(...STAFF_ROLES), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await service.decideDocument(req.authUser.id, req.params.id, 'correction_requested', req.body?.instruction);
      return res.redirect(303, `/documents/${normalizeId(req.params.id)}?notice=decisionRecorded`);
    } catch (error) {
      return renderError(res, error, 'The correction request could not be saved.');
    }
  });

  router.post('/:id/decision', requireRole(...STAFF_ROLES), async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    try {
      await service.decideDocument(req.authUser.id, req.params.id, req.body?.decision, req.body?.reason, req.body);
      return res.redirect(303, `/documents/${normalizeId(req.params.id)}?notice=decisionRecorded`);
    } catch (error) {
      return renderError(res, error, 'The staff decision could not be saved.');
    }
  });

  router.post('/:id/reupload', parseUpload, async (req, res) => {
    try {
      if (!hasValidCsrfToken(req)) {
        return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
      }
      const result = await service.reupload(req.authUser.id, req.params.id, req.file);
      processingService.schedulePendingProcessing();
      return res.redirect(303, `/documents/${result.id}?notice=uploaded`);
    } catch (error) {
      return renderError(res, error, 'The corrected document could not be uploaded.');
    } finally {
      clearUploadBuffer(req.file);
    }
  });

  return router;
}

module.exports = { createDocumentsRouter, documentTypeLabel, documentStatusLabel, configuredMaxBytes, configuredMaxMegabytes };
