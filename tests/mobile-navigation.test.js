import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
function fixture() {
  let focused = false;
  let handler;
  const menu = {open: true, addEventListener(_name, listener) {handler = listener;}, querySelector() {return {focus() {focused = true;}};}};
  vm.runInNewContext(source, {
    document: {querySelectorAll(selector) {return selector === 'details.mobile-nav' ? [menu] : [];}, querySelector() {return null;}, getElementById() {return null;}, addEventListener() {}},
    window: {location: {hash: ''}, addEventListener() {}}
  });
  return {menu, dispatch(key) {let prevented=false;handler({key,preventDefault() {prevented=true;}});return {prevented,focused};}};
}
test('Escape closes an open mobile drawer and restores summary focus', () => {
  const f = fixture();
  assert.deepEqual(f.dispatch('Escape'), {prevented:true,focused:true});
  assert.equal(f.menu.open,false);
});
test('ordinary Tab and Enter retain native disclosure behavior', () => {
  const f = fixture();
  assert.deepEqual(f.dispatch('Tab'), {prevented:false,focused:false});
  assert.deepEqual(f.dispatch('Enter'), {prevented:false,focused:false});
  assert.equal(f.menu.open,true);
});
test('a closed drawer does not consume another control’s Escape', () => {
  const f = fixture(); f.menu.open=false;
  assert.deepEqual(f.dispatch('Escape'), {prevented:false,focused:false});
});
