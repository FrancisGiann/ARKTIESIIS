const express = require('express');
const multer = require('multer');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { StudentSetupError, MAX_BULK_ROWS, createStudentSetupService } = require('../services/studentSetupService');

const MAX_BULK_FILE_BYTES = 2 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 80;
const MAX_XLSX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_XLSX_TOTAL_BYTES = 16 * 1024 * 1024;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const readSheet = require('read-excel-file/node').readSheet;

class WorkbookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkbookError';
  }
}

function inspectZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new WorkbookError('Upload a valid .xlsx workbook.');
  }
  const minimum = Math.max(0, buffer.length - 65_557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0 || endOffset + 22 > buffer.length) throw new WorkbookError('The workbook archive is invalid.');
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const directoryDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const directoryBytes = buffer.readUInt32LE(endOffset + 12);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (diskNumber || directoryDisk || diskEntries !== totalEntries || totalEntries < 1 || totalEntries > MAX_XLSX_ENTRIES
    || totalEntries === 0xffff || directoryOffset === 0xffffffff || directoryBytes === 0xffffffff
    || directoryOffset + directoryBytes > endOffset) {
    throw new WorkbookError('The workbook contains an unsupported or oversized archive.');
  }

  let cursor = directoryOffset;
  let totalUncompressed = 0;
  let inspectedEntries = 0;
  let sheetRows = 0;
  while (cursor < directoryOffset + directoryBytes) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new WorkbookError('The workbook archive is invalid.');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > directoryOffset + directoryBytes || uncompressedSize === 0xffffffff
      || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new WorkbookError('The workbook contains an unsupported archive entry.');
    }
    const entryName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor = entryEnd;
    inspectedEntries += 1;
    if (entryName.endsWith('/')) continue;
    if ((flags & 0x0001) !== 0 || (method !== 0 && method !== 8)) {
      throw new WorkbookError('The workbook uses an unsupported or encrypted archive entry.');
    }
    totalUncompressed += uncompressedSize;
    if (uncompressedSize > MAX_XLSX_ENTRY_BYTES || totalUncompressed > MAX_XLSX_TOTAL_BYTES) {
      throw new WorkbookError('The workbook expands beyond the allowed size.');
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new WorkbookError('The workbook archive is invalid.');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryOffset || dataEnd > buffer.length) throw new WorkbookError('The workbook archive is invalid.');
    let contents;
    try {
      const compressed = buffer.subarray(dataStart, dataEnd);
      contents = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_XLSX_ENTRY_BYTES });
    } catch {
      throw new WorkbookError('The workbook contains an invalid or oversized archive entry.');
    }
    if (contents.length !== uncompressedSize) throw new WorkbookError('The workbook archive is invalid.');
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(entryName)) {
      const xml = contents.toString('utf8');
      const rows = xml.match(/<row(?:\s|>)/gi)?.length || 0;
      sheetRows = Math.max(sheetRows, rows);
    }
  }
  if (inspectedEntries !== totalEntries || cursor !== directoryOffset + directoryBytes) {
    throw new WorkbookError('The workbook archive is invalid.');
  }
  if (sheetRows > MAX_BULK_ROWS + 1) {
    throw new WorkbookError(`The first worksheet may contain at most ${MAX_BULK_ROWS} student rows.`);
  }
}

function normalizeHeader(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '';
}

function cellText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isSafeInteger(value) ? String(value) : '';
  return '';
}

async function parseStudentRoster(buffer) {
  inspectZip(buffer);
  let sheet;
  try { sheet = await readSheet(buffer); }
  catch { throw new WorkbookError('The workbook could not be read. Upload a valid .xlsx workbook.'); }
  if (!Array.isArray(sheet) || sheet.length < 2) throw new WorkbookError('The first worksheet must contain a header and at least one student row.');
  if (sheet.length - 1 > MAX_BULK_ROWS) throw new WorkbookError(`The workbook cannot contain more than ${MAX_BULK_ROWS} student rows.`);
  const headers = sheet[0] || [];
  const studentNoIndex = headers.findIndex((header) => ['student number', 'student no', 'student no.'].includes(normalizeHeader(header)));
  const emailIndex = headers.findIndex((header) => normalizeHeader(header) === 'email');
  if (studentNoIndex < 0 || emailIndex < 0 || studentNoIndex === emailIndex) {
    throw new WorkbookError('The first worksheet must have “Student Number” and “Email” columns in its first row.');
  }
  const rows = [];
  for (let index = 1; index < sheet.length; index += 1) {
    const values = sheet[index] || [];
    const studentNo = cellText(values[studentNoIndex]);
    const email = cellText(values[emailIndex]);
    if (!studentNo && !email) continue;
    rows.push({ rowNumber: index + 1, studentNo, email });
  }
  if (!rows.length) throw new WorkbookError('No student rows were found in the first worksheet.');
  return rows;
}

function createUploadMiddleware() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BULK_FILE_BYTES, files: 1, fields: 1, parts: 2 },
    fileFilter(req, file, callback) {
      const extension = path.extname(path.basename(file.originalname || '')).toLowerCase();
      if (extension !== '.xlsx' || file.mimetype !== XLSX_MIME) {
        return callback(new WorkbookError('Upload an .xlsx workbook with the Excel workbook file type.'));
      }
      return callback(null, true);
    }
  });
}

function setPrivateHeaders(res) {
  return res.set('Cache-Control', 'private, no-store, max-age=0')
    .set('Pragma', 'no-cache')
    .set('Expires', '0')
    .set('Referrer-Policy', 'no-referrer')
    .set('X-Content-Type-Options', 'nosniff');
}

function csvEscape(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function credentialsCsv(credentials) {
  const lines = [['Row', 'Student number', 'Email', 'Temporary password'].map(csvEscape).join(',')];
  for (const entry of credentials) {
    lines.push([entry.rowNumber, entry.studentNo, entry.email, entry.password].map(csvEscape).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function createStudentBulkAccountsRouter({ getPool, sql, studentSetupService } = {}) {
  const router = express.Router();
  const service = studentSetupService || createStudentSetupService({ getPool, sql });
  const upload = createUploadMiddleware();

  function renderBulkPage(req, res, { status = 200, error = null, rows = [], canConfirm = false, previewId = '' } = {}) {
    return setPrivateHeaders(res).status(status).render('admin/student-account-bulk', {
      title: 'Student Login Setup', csrfToken: ensureCsrfToken(req), error, rows, canConfirm, previewId
    });
  }

  router.get('/template.csv', (req, res) => setPrivateHeaders(res)
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set('Content-Disposition', 'attachment; filename="student-login-roster-template.csv"')
    .send(`\uFEFFStudent Number,Email\r\nREPLACE-WITH-EXISTING-STUDENT-NUMBER,student@example.edu\r\n`));

  router.get('/', (req, res) => {
    const preview = req.session.studentBulkPreview;
    if (preview && preview.expiresAt <= Date.now()) delete req.session.studentBulkPreview;
    return renderBulkPage(req, res, {
      rows: req.session.studentBulkPreview?.rows || [],
      canConfirm: Boolean(req.session.studentBulkPreview?.valid),
      previewId: req.session.studentBulkPreview?.id || ''
    });
  });

  router.post('/preview', (req, res, next) => {
    return upload.single('workbook')(req, res, (error) => {
      if (!error) return next();
      const message = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
        ? `The workbook must be ${MAX_BULK_FILE_BYTES / (1024 * 1024)} MB or smaller.`
        : error instanceof WorkbookError ? error.message : 'The workbook upload could not be processed.';
      delete req.session.studentBulkPreview;
      return renderBulkPage(req, res, { status: error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, error: message });
    });
  }, async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      if (req.file) req.file.buffer = null;
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    delete req.session.studentBulkPreview;
    if (!req.file) return renderBulkPage(req, res, { status: 400, error: 'Choose an .xlsx workbook to preview.' });
    try {
      const rows = await parseStudentRoster(req.file.buffer);
      req.file.buffer = null;
      const preview = await service.previewBulkStudentAccounts(req.authUser.id, rows);
      const previewId = require('node:crypto').randomUUID();
      req.session.studentBulkPreview = {
        id: previewId,
        createdAt: Date.now(),
        expiresAt: Date.now() + PREVIEW_TTL_MS,
        rows: preview.rows,
        valid: preview.valid,
        validRows: preview.validRows
      };
      return renderBulkPage(req, res, {
        rows: preview.rows,
        canConfirm: preview.valid,
        previewId
      });
    } catch (error) {
      req.file.buffer = null;
      if (error instanceof StudentSetupError || error instanceof WorkbookError) {
        return renderBulkPage(req, res, { status: error.status || 400, error: error.message, rows: error.details || [] });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The workbook preview could not be completed.' });
    }
  });

  router.post('/confirm', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    const preview = req.session.studentBulkPreview;
    if (!preview || preview.expiresAt <= Date.now() || preview.id !== req.body?.previewId) {
      delete req.session.studentBulkPreview;
      return renderBulkPage(req, res, { status: 410, error: 'This roster preview expired. Upload the workbook and preview it again.' });
    }
    if (!preview.valid || preview.rows.some((row) => row.errors.length)) {
      return renderBulkPage(req, res, { status: 409, error: 'Correct every roster row before confirming. No accounts were created.', rows: preview.rows, previewId: preview.id });
    }
    try {
      const credentials = await service.createBulkStudentAccounts(req.authUser.id, preview.validRows);
      delete req.session.studentBulkPreview;
      return setPrivateHeaders(res)
        .type('text/csv; charset=utf-8')
        .set('Content-Disposition', 'attachment; filename="student-temporary-credentials.csv"')
        .send(credentialsCsv(credentials));
    } catch (error) {
      delete req.session.studentBulkPreview;
      if (error instanceof StudentSetupError) {
        return renderBulkPage(req, res, { status: error.status, error: error.message, rows: error.details || preview.rows });
      }
      if (error?.number === 2601 || error?.number === 2627) {
        return renderBulkPage(req, res, { status: 409, error: 'A student login conflict occurred. No accounts were created; preview the corrected roster again.' });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'Student login setup could not be completed.' });
    }
  });

  return router;
}

function createStudentIntakeRouter({ getPool, sql, studentSetupService } = {}) {
  const router = express.Router();
  const service = studentSetupService || createStudentSetupService({ getPool, sql });
  const notices = { intakeCreated: 'Student intake saved. Finance must clear this specific enrollment before finalization.' };

  async function renderIntakeList(req, res, { status = 200, error = null, notice = null } = {}) {
    try {
      const pendingIntakes = await service.listPendingIntakes(req.authUser.id);
      return setPrivateHeaders(res).status(status).render('records/student-intake-list', {
        title: 'Student Enrollment Intake', currentUser: req.authUser,
        csrfToken: ensureCsrfToken(req), pendingIntakes, error, notice: notice || notices[req.query.notice] || null
      });
    } catch (loadError) {
      if (loadError instanceof StudentSetupError) return res.status(loadError.status).render('error', { title: 'Intake Unavailable', message: loadError.message });
      return res.status(503).render('error', { title: 'Intake Unavailable', message: 'Pending student intake could not be loaded.' });
    }
  }

  router.get('/', (req, res) => renderIntakeList(req, res));

  router.get('/new', async (req, res) => {
    try {
      const options = await service.loadIntakeOptions(req.authUser.id);
      return setPrivateHeaders(res).render('records/student-intake-form', {
        title: 'New Student Intake', csrfToken: ensureCsrfToken(req), ...options, values: {}, error: null
      });
    } catch {
      return res.status(503).render('error', { title: 'Intake Unavailable', message: 'Academic terms and sections could not be loaded.' });
    }
  });

  router.post('/', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    const values = {};
    for (const key of ['lrn', 'firstName', 'middleName', 'lastName', 'suffix', 'birthDate', 'sex', 'address', 'phone', 'email', 'academicTermId', 'sectionId']) {
      values[key] = typeof req.body?.[key] === 'string' ? req.body[key].slice(0, 500) : '';
    }
    try {
      await service.createEnrollmentIntake(req.authUser.id, req.body);
      return res.redirect(303, '/registrar/intake?notice=intakeCreated');
    } catch (error) {
      if (error instanceof StudentSetupError) {
        try {
          const options = await service.loadIntakeOptions(req.authUser.id);
          return setPrivateHeaders(res).status(error.status).render('records/student-intake-form', {
            title: 'New Student Intake', csrfToken: ensureCsrfToken(req), ...options, values, error: error.message
          });
        } catch {
          return res.status(503).render('error', { title: 'Intake Unavailable', message: 'The student intake could not be saved.' });
        }
      }
      if (error?.number === 2601 || error?.number === 2627) {
        const options = await service.loadIntakeOptions(req.authUser.id);
        return setPrivateHeaders(res).status(409).render('records/student-intake-form', {
          title: 'New Student Intake', csrfToken: ensureCsrfToken(req), ...options, values,
          error: 'A record conflict occurred. Check the LRN and contact email, then retry the intake.'
        });
      }
      return res.status(503).render('error', { title: 'Intake Unavailable', message: 'The student intake could not be saved.' });
    }
  });

  router.post('/:id/finalize', async (req, res) => {
    if (!hasValidCsrfToken(req)) return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    try {
      const enrollment = await service.finalizeEnrollment(req.authUser.id, req.params.id);
      return setPrivateHeaders(res).render('records/enrollment-print', {
        title: 'Enrollment Form', enrollment, printedAt: new Date()
      });
    } catch (error) {
      if (error instanceof StudentSetupError) return renderIntakeList(req, res, { status: error.status, error: error.message });
      return res.status(503).render('error', { title: 'Enrollment Finalization Unavailable', message: 'The enrollment could not be finalized.' });
    }
  });

  return router;
}

module.exports = {
  MAX_BULK_FILE_BYTES,
  MAX_BULK_ROWS,
  WorkbookError,
  inspectZip,
  parseStudentRoster,
  credentialsCsv,
  createStudentBulkAccountsRouter,
  createStudentIntakeRouter
};
