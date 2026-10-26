'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { readSqlFile } = require('../scripts/db-setup-v2');
const { PoolFacade, sql } = require('../src/config/database');
const { findReusableEvidence, reserveAiCheck, finishAiCheck, cleanupOldAiAttempts } = require('../src/services/studentDocumentAiQuota');
const { insertEarlyEvidence } = require('../src/services/studentEarlyEvidence');

const socketPath = process.env.STUDENT_AI_QUOTA_TEST_SOCKET;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('isolated MariaDB enforces shared cooldown, rolling quota, correction bonus and duplicate-call reservation', {
  skip: !socketPath && 'Set STUDENT_AI_QUOTA_TEST_SOCKET to a disposable MariaDB socket under /tmp.'
}, async (t) => {
  assert.ok(path.resolve(socketPath).startsWith(`${os.tmpdir()}${path.sep}`));
  const dbName = `ark_quota_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const admin = mysql.createPool({ socketPath, user: os.userInfo().username, password: '' });
  let raw;
  t.after(async () => {
    if (raw) await raw.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  raw = mysql.createPool({ socketPath, user: os.userInfo().username, password: '', database: dbName,
    connectionLimit: 6 });
  for (const statement of [
    'CREATE TABLE users (id INT PRIMARY KEY)',
    'CREATE TABLE students (id INT PRIMARY KEY)',
    `CREATE TABLE documents (id INT PRIMARY KEY, student_id INT NOT NULL, document_type VARCHAR(60) NOT NULL,
      requirement_assignment_id INT NULL, supersedes_document_id INT NULL, file_size_bytes BIGINT NOT NULL,
      uploaded_by INT NOT NULL, mime_type VARCHAR(100) NOT NULL)`,
    ...readSqlFile(path.resolve(__dirname, '../database/mariadb/migrations/026_student_document_early_evidence.sql')),
    ...readSqlFile(path.resolve(__dirname, '../database/mariadb/migrations/027_student_document_ai_quota.sql'))
  ]) await raw.query(statement);
  await raw.query('INSERT INTO users (id) VALUES (11), (12)');
  await raw.query('INSERT INTO students (id) VALUES (21), (22)');
  await raw.query(`INSERT INTO documents (id, student_id, document_type, file_size_bytes, uploaded_by, mime_type)
    VALUES (31, 21, 'report_card', 10, 11, 'application/pdf')`);
  const pool = new PoolFacade(raw);
  const early = { actorId: 11, studentId: 21, type: 'report_card', assignmentId: null,
    sourceDocumentId: null, digest: digest('reusable-file'), mimeType: 'application/pdf',
    fileSizeBytes: 10, model: 'gemini-synthetic-model', fields: { studentName: 'Synthetic Learner' } };
  const evidenceId = await insertEarlyEvidence(pool, sql, early);
  assert.equal((await findReusableEvidence(pool, sql, early)).id, evidenceId);
  assert.equal(await findReusableEvidence(pool, sql, { ...early, actorId: 12 }), null);
  assert.equal(await findReusableEvidence(pool, sql, { ...early, digest: digest('changed') }), null);
  assert.equal(await findReusableEvidence(pool, sql, { ...early, model: 'changed-model' }), null);
  const input = { actorId: 11, type: 'report_card', assignmentId: null, sourceDocumentId: null,
    correctionRequested: false, maxChecksPerHour: 3, cooldownSeconds: 30 };
  const first = await reserveAiCheck(pool, sql, { ...input, digest: digest('file-1') });
  assert.equal(first.allowed, true);
  const duplicate = await reserveAiCheck(pool, sql, { ...input, digest: digest('file-1') });
  assert.deepEqual([duplicate.allowed, duplicate.reason], [false, 'in_progress']);
  await finishAiCheck(pool, sql, first.attemptId);
  const cooling = await reserveAiCheck(pool, sql, { ...input, digest: digest('file-2') });
  assert.deepEqual([cooling.allowed, cooling.reason], [false, 'cooldown']);
  for (let sequence = 2; sequence <= 3; sequence += 1) {
    await raw.query(`UPDATE student_document_ai_attempts SET started_at = TIMESTAMPADD(SECOND, -31, UTC_TIMESTAMP(3))
      WHERE actor_id = 11 AND requirement_key = 'report_card:0' AND started_at > TIMESTAMPADD(HOUR, -1, UTC_TIMESTAMP(3))`);
    const reserved = await reserveAiCheck(pool, sql, { ...input, digest: digest(`file-${sequence}`) });
    assert.equal(reserved.allowed, true);
    await finishAiCheck(pool, sql, reserved.attemptId);
  }
  await raw.query(`UPDATE student_document_ai_attempts SET started_at = TIMESTAMPADD(SECOND, -31, UTC_TIMESTAMP(3))
    WHERE actor_id = 11 AND requirement_key = 'report_card:0'`);
  const hourly = await reserveAiCheck(pool, sql, { ...input, digest: digest('file-4') });
  assert.deepEqual([hourly.allowed, hourly.reason], [false, 'hourly_limit']);
  const bonusInput = { ...input, sourceDocumentId: 31, correctionRequested: true, digest: digest('corrected-file') };
  const bonus = await reserveAiCheck(pool, sql, bonusInput);
  assert.equal(bonus.allowed, true);
  assert.equal(bonus.correctionBonus, true);
  await finishAiCheck(pool, sql, bonus.attemptId);
  await raw.query(`UPDATE student_document_ai_attempts SET started_at = TIMESTAMPADD(SECOND, -31, UTC_TIMESTAMP(3))
    WHERE id = ?`, [bonus.attemptId]);
  const noSecondBonus = await reserveAiCheck(pool, sql, { ...bonusInput, digest: digest('another-correction') });
  assert.deepEqual([noSecondBonus.allowed, noSecondBonus.reason], [false, 'hourly_limit']);

  const parallel = await Promise.all(Array.from({ length: 4 }, () => reserveAiCheck(pool, sql, {
    ...input, actorId: 12, digest: digest('parallel-file')
  })));
  assert.equal(parallel.filter((result) => result.allowed).length, 1);
  assert.ok(parallel.every((result) => result.allowed || ['in_progress', 'cooldown'].includes(result.reason)));
  await raw.query(`UPDATE student_document_ai_attempts SET started_at = TIMESTAMPADD(HOUR, -25, UTC_TIMESTAMP(3))
    WHERE actor_id = 12`);
  await cleanupOldAiAttempts(pool);
  const [oldRows] = await raw.query('SELECT id FROM student_document_ai_attempts WHERE actor_id = 12');
  assert.equal(oldRows.length, 0);
});
