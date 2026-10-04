'use strict';

const MANILA_DATE_TIME = new Intl.DateTimeFormat('en-PH', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila'
});

function parseUtcDateTime(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const mariaDbDateTime = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(text);
  if (mariaDbDateTime) {
    const [, year, month, day, hour, minute, second, millisecond = '0'] = mariaDbDateTime;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond.padEnd(3, '0'))));
    if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() !== Number(month) - 1 || parsed.getUTCDate() !== Number(day)
      || parsed.getUTCHours() !== Number(hour) || parsed.getUTCMinutes() !== Number(minute) || parsed.getUTCSeconds() !== Number(second)) return null;
    return parsed;
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatFinanceDateTime(value) {
  const date = parseUtcDateTime(value);
  return date ? MANILA_DATE_TIME.format(date) : 'Date unavailable';
}

function manilaWeekStartDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) return null;
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

module.exports = { formatFinanceDateTime, manilaWeekStartDate, parseUtcDateTime };
