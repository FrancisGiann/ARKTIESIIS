const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('node:path');
const {readFileSync} = require('node:fs');
const root = path.join(__dirname, '..');
test('grouped payment choices preserve identities, zero balances, original ordering metadata and recovery selection', async () => {
  const targets = [
    {value:'opening:7', group:'Confirmed previous balances', label:'Earlier <balance>', fullLabel:'Full & original', balance:'12.34', order:0},
    {value:'charge:8', group:'2026 · Grade 11 · Term 1', label:'Tuition · prelim', fullLabel:'Long original purpose', balance:'0.00', order:1},
    {value:'charge:9', group:'2027 · Grade 12 · Term 1', label:'Tuition · finals', fullLabel:'Another purpose', balance:'123.45', order:2},
    {value:'charge:10', group:'2026 · Grade 11 · Term 1', label:'Lab', fullLabel:'Lab', balance:'56.00', order:3}
  ];
  const html = await ejs.renderFile(path.join(root,'views/finance/_allocation-options.ejs'), {allocationTargets:targets,selectedTarget:'charge:8',formatMoney:v=>v});
  assert.equal((html.match(/<optgroup /g)||[]).length,3);
  for (const t of targets) assert.ok(html.includes(`value="${t.value}" data-balance="${t.balance}" data-order="${t.order}"`));
  assert.match(html,/value="charge:8"[^>]* selected/);
  assert.match(html,/Earlier &lt;balance&gt;/);
  assert.match(html,/title="Full &amp; original"/);
  assert.equal((html.match(/<option /g)||[]).length,targets.length);
});
test('all payment and existing-credit rows share concise choices while retaining unavailable recovery options', () => {
  const source=readFileSync(path.join(root,'views/finance/annual-student.ejs'),'utf8');
  assert.equal((source.match(/include\('_allocation-options'/g)||[]).length,4);
  assert.equal((source.match(/Previously selected balance is no longer available/g)||[]).length,2);
  assert.match(readFileSync(path.join(root,'public/js/finance-allocation-form.js'),'utf8'),/sort\(\(a, b\) => Number\(a.dataset.order/);
});
test('mobile account menu identifies the signed-in account and retains CSRF-protected logout', async () => {
  const html=await ejs.renderFile(path.join(root,'views/partials/head.ejs'),{title:'Fixture',currentUser:{role:'front_desk',email:'qa@example.invalid'},navigationItems:[],navigationGroups:[],csrfToken:'synthetic-csrf'});
  assert.match(html,/mobile-nav__identity[^]*?Front desk[^]*?qa@example.invalid/);
  const panel=html.split('mobile-nav__panel')[1].split('</details>')[0];
  assert.match(panel,/href="\/account"/);
  assert.match(panel,/action="\/logout"[^]*?value="synthetic-csrf"/);
});
