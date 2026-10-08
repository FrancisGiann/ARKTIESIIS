const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const projectRoot = path.resolve(__dirname, '..');
const viewsRoot = path.join(projectRoot, 'views');
const inventoryPath = path.join(projectRoot, 'docs', '25-ui-ux-review.md');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath) : [fullPath];
  });
}

function routeViewTargets() {
  const sources = [
    ...sourceFiles(path.join(projectRoot, 'src', 'routes')).filter((file) => file.endsWith('.js')),
    path.join(projectRoot, 'src', 'app.js'),
    path.join(projectRoot, 'src', 'middleware', 'errorHandler.js')
  ];
  const targets = new Set();
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\.render\(\s*['"]([^'"]+)['"]/g)) targets.add(match[1]);
    for (const match of source.matchAll(/renderOwnPage\(req,\s*res,\s*['"]([^'"]+)['"]/g)) targets.add(match[1]);
    if (file.endsWith(path.join('routes', 'index.js'))) {
      const dashboardConfig = source.match(/const dashboardViews\s*=\s*\{([\s\S]*?)\n\};/);
      for (const match of dashboardConfig?.[1]?.matchAll(/view:\s*['"]([^'"]+)['"]/g) || []) targets.add(match[1]);
    }
  }
  return [...targets].sort();
}

const compatibilityOnlyTargets = [
  'records/legacy-activation-review',
  'records/student-intake-form',
  'records/student-intake-list'
];

test('reachable EJS render targets compile and every active screen is present in the UI review inventory', () => {
  const inventory = fs.readFileSync(inventoryPath, 'utf8');
  const renderTargets = routeViewTargets();
  const targets = renderTargets.filter((target) => !compatibilityOnlyTargets.includes(target));
  assert.ok(targets.length >= 68, 'active route inventory should include the current screen families');

  for (const target of targets) {
    const filename = path.join(viewsRoot, `${target}.ejs`);
    assert.ok(fs.existsSync(filename), `active route view exists: ${target}`);
    assert.ok(inventory.includes(`views/${target}.ejs`), `active view is inventoried: ${target}`);
    assert.doesNotThrow(() => ejs.compile(fs.readFileSync(filename, 'utf8'), { filename }), `EJS compiles: ${target}`);
  }

  for (const target of compatibilityOnlyTargets) {
    assert.ok(renderTargets.includes(target), `compatibility-only render code remains visible for review: ${target}`);
    assert.ok(inventory.includes(`views/${target}.ejs`), `compatibility-only view is explicitly classified: ${target}`);
    assert.doesNotThrow(() => ejs.compile(fs.readFileSync(path.join(viewsRoot, `${target}.ejs`), 'utf8')),
      `compatibility-only EJS still compiles: ${target}`);
  }

  const nonPartialViews = sourceFiles(viewsRoot)
    .filter((file) => file.endsWith('.ejs') && !file.split(path.sep).includes('partials'))
    .map((file) => path.relative(viewsRoot, file).replace(/\.ejs$/, ''));
  const orphanViews = nonPartialViews.filter((view) => !renderTargets.includes(view));
  assert.deepEqual(orphanViews.sort(), ['readmissions/form', 'readmissions/index', 'records/grade-import']);
  for (const orphan of orphanViews) assert.ok(inventory.includes(`views/${orphan}.ejs`), `orphan view is explicitly classified: ${orphan}`);
});
