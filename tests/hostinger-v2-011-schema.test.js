'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { REQUIRED_VERSIONS } = require('../scripts/expand-hostinger-demo');
const { REQUIRED_OBJECTS } = require('../scripts/hostinger-demo-v2.011-schema');

test('Hostinger demo tool object inventory exactly matches baseline through v2.011 DDL', () => {
  assert.deepEqual(REQUIRED_VERSIONS, Array.from({ length: 11 }, (_, index) => `v2.${String(index + 1).padStart(3, '0')}`));
  const statements = [
    ...readSqlFile('database/mariadb/schema.sql'),
    ...readForwardMigrations().filter(({ version }) => version <= 'v2.011').flatMap(({ statements: migration }) => migration)
  ];
  const declaredObjects = statements.flatMap((statement) => {
    let normalized = statement.trim();
    while (normalized.startsWith('--') || normalized.startsWith('/*')) {
      if (normalized.startsWith('--')) normalized = normalized.replace(/^--[^\r\n]*(?:\r?\n|$)/, '').trimStart();
      else {
        const commentEnd = normalized.indexOf('*/');
        if (commentEnd < 0) break;
        normalized = normalized.slice(commentEnd + 2).trimStart();
      }
    }
    const match = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(TABLE|VIEW)\s+`?([a-z0-9_]+)`?/i.exec(normalized);
    return match ? [match[2]] : [];
  }).sort();
  assert.deepEqual([...REQUIRED_OBJECTS].sort(), declaredObjects,
    'the v2.011 maintenance tools require every object in that snapshot and no objects from later migrations');
  for (const laterMigrationObject of [
    'finance_review_drafts', 'pre_enrollments', 'readmission_evaluations', 'term_clearance_templates',
    'student_term_clearances', 'annual_term_finalizations'
  ]) assert.equal(REQUIRED_OBJECTS.includes(laterMigrationObject), false);
});
