'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { firstInvalidControl, initializeForm, isValidPhone, validateControl } = require('../public/js/student-profile-validation');
const { studentValues } = require('../src/routes/studentRecords');

function makeControl({ name, value = '', type = 'text', required = false, pattern = '' }) {
  const attributes = new Map();
  const listeners = new Map();
  return {
    name, value, type, tagName: 'INPUT', required, pattern, id: name, disabled: false, readOnly: false,
    customValidity: '', parentElement: null,
    setCustomValidity(message) { this.customValidity = message; },
    checkValidity() { return !this.customValidity && (!this.required || Boolean(this.value)); },
    setAttribute(key, next) { attributes.set(key, next); },
    getAttribute(key) { return attributes.get(key) || (key === 'pattern' ? this.pattern : ''); },
    removeAttribute(key) { attributes.delete(key); },
    hasAttribute(key) { return attributes.has(key); },
    closest() { return null; },
    addEventListener(typeName, callback) { listeners.set(typeName, callback); },
    dispatch(typeName) { listeners.get(typeName)?.({ target: this }); },
    focus() { this.focused = true; },
    reportValidity() { this.reported = true; },
    get ariaInvalid() { return attributes.get('aria-invalid'); }
  };
}

test('profile validator accepts Unicode and punctuated names, optional blanks, and rejects pasted digits or symbols without rewriting them', () => {
  for (const value of ['José', 'Jose\u0301', 'Anne-Marie', 'O’Neill de la Cruz', 'D\'Arcy', 'Jr.']) {
    const control = makeControl({ name: 'lastName', value });
    assert.equal(validateControl(control), true, value);
    assert.equal(control.value, value, 'validation must preserve the entered identity');
  }

  for (const value of ['Alex123', 'Lee@#', 'Alex 2']) {
    const control = makeControl({ name: 'middleName', value });
    assert.equal(validateControl(control), false, value);
    assert.match(control.customValidity, /letters/);
    assert.equal(control.value, value, 'invalid input is reported without destructive sanitization');
    assert.equal(control.ariaInvalid, 'true');
  }

  const blankMiddle = makeControl({ name: 'middleName' });
  assert.equal(validateControl(blankMiddle), true, 'middle name remains optional');
  assert.equal(blankMiddle.ariaInvalid, undefined);
  const tooLong = makeControl({ name: 'firstName', value: 'A'.repeat(101) });
  assert.equal(validateControl(tooLong), false);
  assert.match(tooLong.customValidity, /100 characters/);
});

test('LRN validation keeps leading zeros, allows Draft partials, and rejects overlong or letter-containing paste unchanged', () => {
  const complete = makeControl({ name: 'lrn', value: '000000000001', pattern: '[0-9]{12}' });
  assert.equal(validateControl(complete), true);
  assert.equal(complete.value, '000000000001');

  const partialDraft = makeControl({ name: 'lrn', value: '00123', pattern: '[0-9]{0,12}' });
  assert.equal(validateControl(partialDraft), true);
  assert.equal(validateControl(makeControl({ name: 'lrn', pattern: '[0-9]{0,12}' })), true, 'blank Draft LRN is permitted');

  for (const value of ['012345678901X', '1234567890123']) {
    const control = makeControl({ name: 'lrn', value, pattern: '[0-9]{12}' });
    assert.equal(validateControl(control), false);
    assert.equal(control.value, value, 'overlong and malformed pasted values remain visible for correction');
  }
  const invalidDraft = makeControl({ name: 'lrn', value: '1234567890123', pattern: '[0-9]{0,12}' });
  assert.equal(validateControl(invalidDraft), false);
  assert.equal(invalidDraft.value, '1234567890123');
});

test('phone validation accepts formatted local and international numbers but rejects letters, invalid parentheses, and overlong text', () => {
  for (const value of ['09171234567', '+63 (917) 123-4567', '+44 20 7946 0958', '(02) 8123-4567']) {
    const control = makeControl({ name: 'studentContactNumber', value, type: 'tel' });
    assert.equal(validateControl(control), true, value);
    assert.equal(control.value, value);
  }
  for (const value of ['Call 09171234567', '+63 (917 123-4567', '1234567890123456', `0917${' '.repeat(47)}123`]) {
    const control = makeControl({ name: 'studentContactNumber', value, type: 'tel' });
    assert.equal(validateControl(control), false, value);
    assert.equal(control.value, value, 'invalid pasted phone data is not rewritten');
  }
  assert.equal(isValidPhone(`0917${' '.repeat(47)}123`), false, 'raw input length limit matches the server limit');
});

test('input/change feedback clears after correction and invalid submissions remain blocked', () => {
  const control = makeControl({ name: 'firstName', value: 'Alex123', required: true });
  const controls = [control];
  const formListeners = new Map();
  const form = {
    matches: () => false,
    querySelectorAll: () => controls,
    addEventListener(typeName, callback) { formListeners.set(typeName, callback); }
  };
  initializeForm(form);
  assert.equal(control.ariaInvalid, 'true');

  control.value = 'Alex';
  control.dispatch('input');
  assert.equal(control.customValidity, '');
  assert.equal(control.ariaInvalid, undefined);

  control.value = 'Alex@#'; // Simulates a paste; the original text remains untouched.
  control.dispatch('change');
  assert.equal(control.value, 'Alex@#');
  assert.equal(control.ariaInvalid, 'true');
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  formListeners.get('submit')(event);
  assert.equal(event.prevented, true);
  assert.equal(control.focused, true);
  assert.equal(control.reported, true);
  assert.equal(control.value, 'Alex@#');

  control.value = 'Alex';
  control.dispatch('input');
  assert.equal(firstInvalidControl({ querySelectorAll: () => controls }), null);
});

test('feedback is visible and linked accessibly, while blank optional and locked identity values stay intact', () => {
  let feedbackNode = null;
  const field = {
    querySelector() { return feedbackNode; },
    appendChild(node) { feedbackNode = node; }
  };
  const feedbackDocument = {
    createElement(tagName) {
      return {
        tagName, dataset: {}, attributes: {}, hidden: false, textContent: '',
        setAttribute(key, value) { this.attributes[key] = value; }
      };
    }
  };
  const control = makeControl({ name: 'lastName', value: 'Lee@#' });
  control.closest = (selector) => selector === '.field' ? field : null;
  control.insertAdjacentElement = (_position, node) => { feedbackNode = node; };
  const previousDocument = global.document;
  global.document = feedbackDocument;
  try {
    assert.equal(validateControl(control), false);
    assert.equal(feedbackNode.hidden, false);
    assert.match(feedbackNode.textContent, /letters/);
    assert.equal(feedbackNode.attributes.role, 'status');
    assert.equal(feedbackNode.attributes['aria-live'], 'polite');
    assert.match(control.getAttribute('aria-describedby'), /lastName-validation-error/);

    control.value = 'Lee';
    assert.equal(validateControl(control), true);
    assert.equal(feedbackNode.hidden, true);
    assert.equal(feedbackNode.textContent, '');
  } finally {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }

  const locked = makeControl({ name: 'firstName', value: '  Existing Name  ' });
  locked.readOnly = true;
  const disabled = makeControl({ name: 'lastName', value: '  Existing Surname  ' });
  disabled.disabled = true;
  const blankMiddle = makeControl({ name: 'middleName', value: '   ' });
  assert.equal(firstInvalidControl({ querySelectorAll: () => [locked, disabled, blankMiddle] }), null);
  assert.equal(locked.value, '  Existing Name  ', 'readonly names never change during submission validation');
  assert.equal(disabled.value, '  Existing Surname  ', 'disabled names never change during submission validation');
  assert.equal(blankMiddle.value, '', 'optional whitespace middle names normalize to an empty value');
});

test('identity and phone controls do not truncate overlong paste, including student form recovery values', () => {
  const templates = [
    'views/admin/user-new.ejs', 'views/admin/user-edit.ejs', 'views/pre-enrollments/form.ejs',
    'views/readmissions/form.ejs', 'views/partials/return-evaluation-form.ejs',
    'views/records/student-form.ejs', 'views/records/student-intake-form.ejs', 'views/records/annual-intake-form.ejs'
  ];
  const identityFields = new Set(['lrn', 'applicantLrn', 'firstName', 'middleName', 'lastName', 'suffix',
    'studentContactNumber', 'profilePhone', 'phone', 'emergencyContactPhone', 'motherPhone', 'fatherPhone',
    'emergencyContactPerson', 'motherName', 'fatherName']);
  for (const template of templates) {
    const html = fs.readFileSync(path.join(__dirname, '..', template), 'utf8');
    for (const input of html.match(/<input\b[^>]*>/g) || []) {
      const field = input.match(/\bname="([^"]+)"/)?.[1];
      if (identityFields.has(field)) assert.doesNotMatch(input, /\bmaxlength=/, `${template}: ${field}`);
    }
  }

  const overlongLrn = '012345678901X';
  const overlongName = 'A'.repeat(101);
  const values = studentValues({ lrn: overlongLrn, firstName: overlongName, emergencyContactPerson: 'Z'.repeat(161) });
  assert.equal(values.lrn, overlongLrn);
  assert.equal(values.firstName, overlongName);
  assert.equal(values.emergencyContactPerson, 'Z'.repeat(161));
});
