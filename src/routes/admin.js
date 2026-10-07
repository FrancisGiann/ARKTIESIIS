const express = require('express');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { AdminServiceError, createAdminService, normalizeUserId } = require('../services/adminService');
const { isDuplicateKeyError } = require('../config/database');

const notices = {
  created: 'Account created.',
  updated: 'Account updated.',
  password: 'Password reset completed. Any pending email sign-in codes were invalidated.'
};

function inputText(body, key, maxLength = 255) {
  return typeof body?.[key] === 'string' ? body[key].slice(0, maxLength) : '';
}

function formValues(body = {}) {
  return {
    email: inputText(body, 'email'),
    role: inputText(body, 'role', 30),
    first_name: inputText(body, 'firstName', 100),
    last_name: inputText(body, 'lastName', 100),
    department: inputText(body, 'department', 100),
    student_no: inputText(body, 'studentNo', 50),
    is_active: body.isActive === '1' || body.isActive === 'true'
  };
}

function isUniqueConflict(error) {
  return isDuplicateKeyError(error);
}

function safeAccountFilters(query = {}) {
  const category = ['students', 'staff'].includes(query.category) ? query.category : 'students';
  const status = ['all', 'active', 'inactive'].includes(query.status) ? query.status : 'all';
  const role = category === 'staff' && ['database_admin', 'registrar', 'front_desk', 'finance', 'teacher'].includes(query.role) ? query.role : '';
  return {
    category,
    status,
    role,
    searchTerm: typeof query.search === 'string' ? query.search.slice(0, 100) : ''
  };
}

function safeAuditFilters(query = {}) {
  return {
    category: ['all', 'accounts', 'students', 'documents', 'finance', 'academics', 'other'].includes(query.category) ? query.category : 'all',
    searchTerm: typeof query.search === 'string' ? query.search.slice(0, 100) : ''
  };
}

function emptyPagination(pageSize = 25) {
  return { page: 1, pageSize, totalRecords: 0, totalPages: 1, from: 0, to: 0 };
}

function formatAuditDateTime(value) {
  if (!value) return { display: '—', iso: '' };
  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string') {
    const raw = value.trim();
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    date = new Date(hasTimezone ? raw : `${raw.replace(' ', 'T')}Z`);
  } else {
    return { display: '—', iso: '' };
  }
  if (!Number.isFinite(date.valueOf())) return { display: '—', iso: '' };
  return {
    display: new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    }).format(date),
    iso: date.toISOString()
  };
}

function createAdminRouter({ getPool, sql, adminService } = {}) {
  const router = express.Router();
  const service = adminService || createAdminService({ getPool, sql });

  const renderNewUser = (req, res, { error = null, status = 200, values = {} } = {}) => {
    const requestedRole = ['database_admin', 'registrar', 'front_desk', 'teacher', 'finance'].includes(req.query?.role)
      ? req.query.role : 'registrar';
    return res.status(status).render('admin/user-new', {
      title: 'Create User Account',
      csrfToken: ensureCsrfToken(req),
      error,
      values: { role: requestedRole, ...values }
    });
  };

  router.get('/', async (req, res) => {
    if (req.query.search !== undefined) {
      const search = typeof req.query.search === 'string' ? `&search=${encodeURIComponent(req.query.search)}` : '';
      return res.redirect(303, `/admin/users?category=students${search}`);
    }
    return res.render('dashboards/database-admin', {
      title: 'Admin overview',
      csrfToken: ensureCsrfToken(req),
      currentUser: req.authUser,
      notice: notices[req.query.notice] || null
    });
  });

  router.get('/users', async (req, res) => {
    const base = {
      title: 'User accounts',
      csrfToken: ensureCsrfToken(req),
      currentUser: req.authUser,
      users: [],
      filters: safeAccountFilters(req.query),
      pagination: emptyPagination(),
      error: null
    };
    try {
      const directory = await service.listAccounts(req.query);
      return res.render('admin/accounts', { ...base, ...directory, error: null });
    } catch (error) {
      const isInputError = error instanceof AdminServiceError;
      return res.status(isInputError ? error.status : 503).render('admin/accounts', {
        ...base,
        error: isInputError ? error.message : 'User accounts are temporarily unavailable. Try again shortly.'
      });
    }
  });

  router.get('/audit', async (req, res) => {
    const base = {
      title: 'Activity log',
      csrfToken: ensureCsrfToken(req),
      currentUser: req.authUser,
      events: [],
      filters: safeAuditFilters(req.query),
      pagination: emptyPagination(),
      error: null
    };
    try {
      const result = await service.listAuditLogs(req.query);
      const events = result.events.map((event) => ({
        ...event,
        displayDateTime: formatAuditDateTime(event.created_at)
      }));
      return res.render('admin/audit', { ...base, ...result, events, error: null });
    } catch (error) {
      const isInputError = error instanceof AdminServiceError;
      return res.status(isInputError ? error.status : 503).render('admin/audit', {
        ...base,
        error: isInputError ? error.message : 'The activity log is temporarily unavailable. Try again shortly.'
      });
    }
  });

  router.get('/users/new', (req, res) => renderNewUser(req, res));

  router.post('/users', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const values = formValues(req.body);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const confirmation = typeof req.body?.confirmPassword === 'string' ? req.body.confirmPassword : '';
    if (password !== confirmation) {
      return renderNewUser(req, res, { error: 'Passwords do not match.', status: 400, values });
    }

    try {
      const userId = await service.createUser(req.authUser.id, req.body);
      return res.redirect(303, `/admin/users/${userId}/edit?notice=created`);
    } catch (error) {
      if (error instanceof AdminServiceError) return renderNewUser(req, res, { error: error.message, status: error.status, values });
      if (isUniqueConflict(error)) return renderNewUser(req, res, { error: 'An account with that email already exists.', status: 409, values });
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The account could not be created.' });
    }
  });

  router.get('/users/:id/edit', async (req, res) => {
    const userId = normalizeUserId(req.params.id);
    if (!userId) return res.status(404).render('error', { title: 'Not Found', message: 'Account not found.' });
    try {
      const user = await service.getUser(userId);
      if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'Account not found.' });
      return res.render('admin/user-edit', {
        title: 'Edit User Account',
        csrfToken: ensureCsrfToken(req),
        currentUserId: req.authUser.id,
        user,
        notice: notices[req.query.notice] || null,
        error: null
      });
    } catch {
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The account could not be loaded.' });
    }
  });

  router.post('/users/:id', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const userId = normalizeUserId(req.params.id);
    if (!userId) return res.status(404).render('error', { title: 'Not Found', message: 'Account not found.' });
    const values = { ...formValues(req.body), id: userId };

    try {
      await service.updateUser(req.authUser.id, userId, req.body);
      return res.redirect(303, `/admin/users/${userId}/edit?notice=updated`);
    } catch (error) {
      if (error instanceof AdminServiceError) {
        return res.status(error.status).render('admin/user-edit', {
          title: 'Edit User Account', csrfToken: ensureCsrfToken(req), currentUserId: req.authUser.id, user: values, notice: null, error: error.message
        });
      }
      if (isUniqueConflict(error)) {
        return res.status(409).render('admin/user-edit', {
          title: 'Edit User Account', csrfToken: ensureCsrfToken(req), currentUserId: req.authUser.id, user: values, notice: null,
          error: 'An account with that email already exists.'
        });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The account could not be updated.' });
    }
  });

  router.post('/users/:id/password', async (req, res) => {
    if (!hasValidCsrfToken(req)) {
      return res.status(403).render('error', { title: 'Forbidden', message: 'The form session expired. Reload the page and try again.' });
    }
    const userId = normalizeUserId(req.params.id);
    if (!userId) return res.status(404).render('error', { title: 'Not Found', message: 'Account not found.' });
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const confirmation = typeof req.body?.confirmPassword === 'string' ? req.body.confirmPassword : '';
    if (password !== confirmation) {
      let user;
      try {
        user = await service.getUser(userId);
      } catch {
        return res.status(503).render('error', { title: 'Service Unavailable', message: 'The account could not be loaded.' });
      }
      if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'Account not found.' });
      return res.status(400).render('admin/user-edit', {
        title: 'Edit User Account', csrfToken: ensureCsrfToken(req), currentUserId: req.authUser.id, user, notice: null, error: 'Passwords do not match.'
      });
    }

    try {
      await service.resetPassword(req.authUser.id, userId, password);
      return res.redirect(303, `/admin/users/${userId}/edit?notice=password`);
    } catch (error) {
      if (error instanceof AdminServiceError) {
        let user;
        try {
          user = await service.getUser(userId);
        } catch {
          return res.status(503).render('error', { title: 'Service Unavailable', message: 'The account could not be loaded.' });
        }
        if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'Account not found.' });
        return res.status(error.status).render('admin/user-edit', {
          title: 'Edit User Account', csrfToken: ensureCsrfToken(req), currentUserId: req.authUser.id, user, notice: null, error: error.message
        });
      }
      return res.status(503).render('error', { title: 'Service Unavailable', message: 'The password could not be reset.' });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
