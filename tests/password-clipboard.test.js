const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/password-clipboard.js'), 'utf8');

function harness() {
  const document = new EventTarget();
  vm.runInNewContext(source, { document });
  function field(type, attributes = {}) {
    return { type, attributes, value: 'Synthetic-Only-42!',
      matches() { return this.type === 'password' || 'data-password-field' in this.attributes || 'data-password-toggle' in this.attributes; } };
  }
  function dispatch(type, target) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  }
  return { field, dispatch };
}

for (const action of ['copy', 'cut']) {
  test(`${action} is blocked for masked and newly inserted password fields`, () => {
    const h = harness();
    assert.equal(h.dispatch(action, h.field('password')), true);
    assert.equal(h.dispatch(action, h.field('password')), true);
  });
  test(`${action} stays blocked through show/hide and preserves value and attributes`, () => {
    const h = harness();
    for (const marker of ['data-password-field', 'data-password-toggle']) {
      const field = h.field('password', { [marker]: '', autocomplete: 'new-password', required: '', 'aria-describedby': 'help' });
      const attributes = { ...field.attributes };
      for (const type of ['text', 'password', 'text']) {
        field.type = type;
        assert.equal(h.dispatch(action, field), true);
        assert.equal(field.value, 'Synthetic-Only-42!');
        assert.deepEqual(field.attributes, attributes);
      }
    }
  });
  test(`${action} remains available for ordinary controls and document content`, () => {
    const h = harness();
    for (const field of [h.field('text'), h.field('email'), {}, null]) assert.equal(h.dispatch(action, field), false);
  });
}

test('paste, input, focus, selection, context menus, and keys stay available', () => {
  const h = harness();
  for (const type of ['paste', 'beforeinput', 'input', 'focusin', 'select', 'contextmenu', 'keydown']) {
    assert.equal(h.dispatch(type, h.field('password')), false);
  }
});


test('the shared head loads the delegated guard before deferred page initialization', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  assert.match(fs.readFileSync(path.join(__dirname, '../views/partials/head.ejs'), 'utf8'), /<script src="\/js\/password-clipboard\.js" defer><\/script>/);
  assert.match(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), /data-password-toggle/);
});
