'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStudentActivationPassword, validStudentActivationIdentity } = require('../src/utils/temporaryPassword');

const now = new Date('2026-10-13T04:00:00.000Z');

test('first activation password is saved surname plus YYYYMMDD with no suffix or random suffix', () => {
  assert.equal(createStudentActivationPassword('Ramos', '2004-10-09', now), 'Ramos20041009');
  assert.equal(createStudentActivationPassword('Li', '2004-10-09', now), 'Li20041009',
    'short surname credentials stay valid even below permanent-password minimum length');
  assert.equal(createStudentActivationPassword("Dela Cruz-Santos'", '2004-10-09', now), "Dela Cruz-Santos'20041009",
    'surname case, spaces, hyphens, and apostrophes are preserved');
});

test('first activation accepts date-only strings and Date values without parsing a timezone suffix into another day', () => {
  assert.equal(createStudentActivationPassword('Ramos', new Date('2004-10-09T23:59:00.000Z'), now), 'Ramos20041009');
  assert.equal(createStudentActivationPassword('Ramos', '2004-10-09T23:00:00-08:00', now), 'Ramos20041009');
});

test('first activation rejects missing or invalid identity and future/today birth dates', () => {
  for (const [surname, birthDate] of [
    ['', '2004-10-09'], ['   ', '2004-10-09'], ['Ramos', null], ['Ramos', ''],
    ['Ramos', '2004-02-30'], ['Ramos', new Date(Number.NaN)], ['Ramos', '2026-10-13'],
    ['Ramos', '2026-10-14'], ['Ramos', '10/09/2004']
  ]) {
    assert.equal(validStudentActivationIdentity(surname, birthDate, now), false);
    assert.equal(createStudentActivationPassword(surname, birthDate, now), null);
  }
});

test('first activation uses UTF-8 byte count and rejects passwords over bcrypt’s 72-byte limit without truncation', () => {
  const maximumSurname = 'É'.repeat(32);
  const tooLongSurname = 'É'.repeat(33);
  assert.equal(Buffer.byteLength(`${maximumSurname}20041009`, 'utf8'), 72);
  assert.equal(validStudentActivationIdentity(maximumSurname, '2004-10-09', now), true);
  assert.equal(createStudentActivationPassword(maximumSurname, '2004-10-09', now), `${maximumSurname}20041009`);
  assert.equal(Buffer.byteLength(`${tooLongSurname}20041009`, 'utf8'), 74);
  assert.equal(validStudentActivationIdentity(tooLongSurname, '2004-10-09', now), false);
  assert.equal(createStudentActivationPassword(tooLongSurname, '2004-10-09', now), null);
});
