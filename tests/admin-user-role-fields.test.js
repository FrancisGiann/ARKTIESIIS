const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('account role changes show only relevant fields without losing entered values', () => {
  const listener = {};
  const role = {
    value: 'front_desk',
    addEventListener(event, callback) { listener[event] = callback; }
  };
  const staffControl = { value: 'Casey', disabled: false };
  const studentControl = { value: 'SHS-2026-0001', disabled: true };
  const staff = {
    hidden: false,
    hasAttribute(name) { return name === 'data-staff-profile'; },
    querySelectorAll() { return [staffControl]; }
  };
  const student = {
    hidden: true,
    hasAttribute(name) { return name === 'data-student-profile'; },
    querySelectorAll() { return [studentControl]; }
  };
  const form = {
    querySelector() { return role; },
    querySelectorAll() { return [staff, student]; }
  };
  const document = { querySelectorAll() { return [form]; } };
  const script = fs.readFileSync(path.join(__dirname, '../public/js/admin-user-role-fields.js'), 'utf8');
  vm.runInNewContext(script, { document });
  assert.equal(staff.hidden, false);
  assert.equal(studentControl.disabled, true);

  role.value = 'student';
  listener.change();
  assert.equal(staff.hidden, true);
  assert.equal(staffControl.disabled, true);
  assert.equal(student.hidden, false);
  assert.equal(studentControl.disabled, false);

  role.value = 'finance';
  listener.change();
  assert.equal(staff.hidden, false);
  assert.equal(staffControl.disabled, false);
  assert.equal(student.hidden, true);
  assert.equal(studentControl.disabled, true);
  assert.equal(staffControl.value, 'Casey');
  assert.equal(studentControl.value, 'SHS-2026-0001');
});
