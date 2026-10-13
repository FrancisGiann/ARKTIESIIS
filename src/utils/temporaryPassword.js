'use strict';

const crypto = require('node:crypto');

function createTemporaryPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

function manilaDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);
}

function normalizeDateOnly(value) {
  let text;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    text = value.toISOString().slice(0, 10);
  } else if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)$/.test(value)) return null;
    text = value.slice(0, 10);
  } else return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

function validStudentActivationIdentity(lastName, birthDate, now = new Date()) {
  if (typeof lastName !== 'string' || !lastName.trim() || /[\u0000-\u001f\u007f]/.test(lastName)) return false;
  const date = normalizeDateOnly(birthDate);
  if (!date || date >= manilaDate(now)) return false;
  return Buffer.byteLength(`${lastName}${date.replaceAll('-', '')}`, 'utf8') <= 72;
}

function createStudentActivationPassword(lastName, birthDate, now = new Date()) {
  if (!validStudentActivationIdentity(lastName, birthDate, now)) return null;
  return `${lastName}${normalizeDateOnly(birthDate).replaceAll('-', '')}`;
}

module.exports = { createTemporaryPassword, createStudentActivationPassword, validStudentActivationIdentity };
