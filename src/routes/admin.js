const express = require('express');
const { ensureCsrfToken, hasValidCsrfToken } = require('../middleware/auth');
const { AdminServiceError, createAdminService, normalizeUserId } = require('../services/adminService');

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
  return error?.number === 2601 || error?.number === 2627;
}

function createAdminRouter({ getPool, sql, adminService } = {}) {
  const router = express.Router();
  const service = adminService || createAdminService({ getPool, sql });

  const renderNewUser = (req, res, { error = null, status = 200, values = {} } = {}) => res.status(status).render('admin/user-new', {
    title: 'Create User Account',
    csrfToken: ensureCsrfToken(req),
    error,
    values: { role: 'registrar', ...values }
  });

  router.get('/', async (req, res) => {
    const searchTerm = req.query.search === undefined ? '' : req.query.search;
    try {
      const dashboard = await service.listDashboard(searchTerm);
      res.render('dashboards/database-admin', {
        title: 'Database Admin Dashboard',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        users: dashboard.users,
        searchTerm: dashboard.searchTerm,
        searchError: null,
        notice: notices[req.query.notice] || null
      });
    } catch (error) {
      if (error instanceof AdminServiceError) {
        return res.status(error.status).render('dashboards/database-admin', {
          title: 'Database Admin Dashboard',
          csrfToken: ensureCsrfToken(req),
          currentUser: req.authUser,
          users: [],
          searchTerm: '',
          searchError: error.message,
          notice: null
        });
      }
      res.status(503).render('error', { title: 'Service Unavailable', message: 'Database administration is temporarily unavailable.' });
    }
  });

  router.get('/audit', async (req, res) => {
    try {
      const auditLogs = await service.listAuditLogs();
      return res.render('admin/audit', {
        title: 'Audit activity',
        csrfToken: ensureCsrfToken(req),
        currentUser: req.authUser,
        auditLogs
      });
    } catch {
      return res.status(503).render('error', {
        title: 'Service Unavailable',
        message: 'Audit activity is temporarily unavailable.'
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
