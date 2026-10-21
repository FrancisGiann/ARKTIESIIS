'use strict';

const nodemailer = require('nodemailer');

const BRAND = 'ARKTIESIIS';
const BRANCH = 'Main Branch';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new TypeError('A valid action URL is required.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TypeError('A valid action URL is required.');
  return url.toString();
}

function buildTransactionalEmail({
  title,
  preheader,
  intro,
  code,
  actionLabel,
  actionUrl,
  expiresInMinutes,
  fallbackLabel = 'If the button does not work, copy and paste this address into your browser:',
  securityNote
}) {
  const normalizedTitle = String(title || '').trim();
  const normalizedIntro = String(intro || '').trim();
  const normalizedPreheader = String(preheader || normalizedTitle).trim();
  if (!normalizedTitle || !normalizedIntro || normalizedTitle.length > 120 || normalizedIntro.length > 500) {
    throw new TypeError('Email title and message are required.');
  }
  const normalizedCode = code === undefined ? null : String(code);
  if (normalizedCode !== null && !/^\d{6}$/.test(normalizedCode)) throw new TypeError('Verification codes must contain six digits.');
  const normalizedActionUrl = actionUrl === undefined ? null : safeUrl(actionUrl);
  if (Boolean(actionLabel) !== Boolean(normalizedActionUrl)) throw new TypeError('Action label and URL must be supplied together.');
  const expiry = expiresInMinutes === undefined ? null : Number(expiresInMinutes);
  if (expiry !== null && (!Number.isSafeInteger(expiry) || expiry < 1 || expiry > 1440)) throw new TypeError('Email expiry must be a valid number of minutes.');
  const normalizedSecurityNote = String(securityNote || '').trim();

  const htmlParts = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>',
    escapeHtml(normalizedTitle),
    '</title></head><body style="margin:0;padding:0;background-color:#f3f6f6;color:#1c3037;font-family:Arial,Helvetica,sans-serif;line-height:1.55">',
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(normalizedPreheader)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background-color:#f3f6f6"><tr><td align="center" style="padding:28px 14px">',
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;border-collapse:collapse;background-color:#ffffff;border:1px solid #d8e1e3;border-radius:12px"><tr><td style="padding:24px 28px;border-bottom:1px solid #d8e1e3">',
    '<p style="margin:0;color:#1c3037;font-size:16px;font-weight:700;letter-spacing:.04em">ARKTIESIIS</p><p style="margin:3px 0 0;color:#5a6d74;font-size:12px">Ark Technological Institute Education System Inc. · Main Branch</p>',
    '</td></tr><tr><td style="padding:28px">',
    `<h1 style="margin:0 0 14px;color:#1c3037;font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:700;line-height:1.2">${escapeHtml(normalizedTitle)}</h1>`,
    `<p style="margin:0 0 18px;color:#344a52;font-size:16px">${escapeHtml(normalizedIntro)}</p>`
  ];
  if (normalizedCode !== null) {
    htmlParts.push(`<p style="margin:0 0 16px;padding:14px 18px;background-color:#f7e9eb;border:1px solid #eac5cc;border-radius:8px;color:#802131;font-size:28px;font-weight:700;letter-spacing:.18em;text-align:center;font-variant-numeric:tabular-nums">${normalizedCode}</p>`);
  }
  if (actionLabel) {
    htmlParts.push(`<p style="margin:22px 0"><a href="${escapeHtml(normalizedActionUrl)}" style="display:inline-block;padding:12px 18px;background-color:#a22b3d;border-radius:8px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">${escapeHtml(actionLabel)}</a></p>`);
    htmlParts.push(`<p style="margin:18px 0 6px;color:#5a6d74;font-size:13px">${escapeHtml(fallbackLabel)}</p><p style="margin:0 0 18px;overflow-wrap:anywhere"><a href="${escapeHtml(normalizedActionUrl)}" style="color:#802131;font-size:13px;overflow-wrap:anywhere">${escapeHtml(normalizedActionUrl)}</a></p>`);
  }
  if (expiry !== null) htmlParts.push(`<p style="margin:0 0 14px;color:#344a52;font-size:14px">This ${normalizedCode !== null ? 'code' : 'link'} expires in ${expiry} minutes and can be used once.</p>`);
  if (normalizedSecurityNote) htmlParts.push(`<p style="margin:18px 0 0;padding-top:14px;border-top:1px solid #d8e1e3;color:#5a6d74;font-size:13px">${escapeHtml(normalizedSecurityNote)}</p>`);
  htmlParts.push('</td></tr><tr><td style="padding:16px 28px;background-color:#f8fafa;color:#5a6d74;font-size:12px">ARKTIESIIS · Main Branch</td></tr></table></td></tr></table></body></html>');

  const textParts = [BRAND, `Ark Technological Institute Education System Inc. · ${BRANCH}`, '', normalizedTitle, '', normalizedIntro];
  if (normalizedCode !== null) textParts.push('', `Verification code: ${normalizedCode}`);
  if (expiry !== null) textParts.push('', `This ${normalizedCode !== null ? 'code' : 'link'} expires in ${expiry} minutes and can be used once.`);
  if (normalizedActionUrl) textParts.push('', `${actionLabel}: ${normalizedActionUrl}`, '', fallbackLabel, normalizedActionUrl);
  if (normalizedSecurityNote) textParts.push('', normalizedSecurityNote);
  return { html: htmlParts.join(''), text: textParts.join('\n') };
}

function buildOtpEmail(code, expiresInMinutes = 5) {
  return {
    subject: 'Your ARKTIESIIS sign-in code',
    ...buildTransactionalEmail({
      title: 'Your sign-in code',
      preheader: 'Use this code to finish signing in to ARKTIESIIS.',
      intro: 'Enter this verification code on the sign-in page to continue.',
      code,
      expiresInMinutes,
      securityNote: 'If you did not request this code, ignore this email. Do not share the code with anyone.'
    })
  };
}

function buildPasswordResetEmail(url, expiresInMinutes = 30) {
  return {
    subject: 'Reset your ARKTIESIIS password',
    ...buildTransactionalEmail({
      title: 'Reset your password',
      preheader: 'Use the secure link to choose a new ARKTIESIIS password.',
      intro: 'A password reset was requested for your ARKTIESIIS account.',
      actionLabel: 'Choose a new password',
      actionUrl: url,
      expiresInMinutes,
      securityNote: 'If you did not request this reset, ignore this email. Your current password will remain unchanged.'
    })
  };
}

function buildEmailChangeRequestNotice(newEmail) {
  return {
    subject: 'ARKTIESIIS email change requested',
    ...buildTransactionalEmail({
      title: 'Email change requested',
      preheader: 'A change to your ARKTIESIIS sign-in email was requested.',
      intro: `A request was made to change your sign-in and verification email to ${newEmail}. The change will not take effect until the new address is confirmed.`,
      securityNote: 'If you did not request this, change your password and contact the school administrator.'
    })
  };
}

function buildEmailConfirmationEmail(url, expiresInMinutes = 30) {
  return {
    subject: 'Confirm your ARKTIESIIS email address',
    ...buildTransactionalEmail({
      title: 'Confirm your email address',
      preheader: 'Confirm this address for ARKTIESIIS sign-in and email verification.',
      intro: 'Confirm this address for ARKTIESIIS sign-in and email verification.',
      actionLabel: 'Confirm email address',
      actionUrl: url,
      expiresInMinutes,
      securityNote: 'If you did not request this change, ignore this email and contact the school administrator.'
    })
  };
}

function buildAccountInvitationEmail(url, expiresInMinutes = 30) {
  return {
    subject: 'Set up your ARKTIESIIS account',
    ...buildTransactionalEmail({
      title: 'Set up your account',
      preheader: 'Choose a password to finish setting up your ARKTIESIIS account.',
      intro: 'An ARKTIESIIS administrator created an account for you. Use this secure link to choose your password.',
      actionLabel: 'Choose your password',
      actionUrl: url,
      expiresInMinutes,
      securityNote: 'If you were not expecting this invitation, contact the school administrator. Do not forward this link.'
    })
  };
}

async function deliverTransactionalEmail(smtp, { to, subject, text, html }) {
  if (!smtp?.host || !smtp?.from || Boolean(smtp.user) !== Boolean(smtp.pass)) {
    throw new Error('Mail delivery is unavailable.');
  }
  if (typeof to !== 'string' || !to.trim() || typeof subject !== 'string' || !subject.trim()
    || typeof text !== 'string' || !text.trim() || typeof html !== 'string' || !html.trim()) {
    throw new TypeError('A complete transactional email is required.');
  }
  const options = {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000
  };
  if (smtp.user && smtp.pass) options.auth = { user: smtp.user, pass: smtp.pass };
  const transporter = nodemailer.createTransport(options);
  await transporter.sendMail({ from: smtp.from, to, subject, text, html });
}

module.exports = {
  deliverTransactionalEmail,
  buildTransactionalEmail,
  buildOtpEmail,
  buildPasswordResetEmail,
  buildEmailChangeRequestNotice,
  buildEmailConfirmationEmail,
  buildAccountInvitationEmail
};
