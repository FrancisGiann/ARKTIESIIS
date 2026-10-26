'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { readSqlFile } = require('../scripts/db-setup-v2');
const { PoolFacade, Transaction, sql } = require('../src/config/database');
const { insertEarlyEvidence, bindEarlyEvidence, loadEarlyEvidence, deleteEvidenceForDocument,
  cleanupExpiredEvidence } = require('../src/services/studentEarlyEvidence');

const socketPath = process.env.STUDENT_EARLY_EVIDENCE_TEST_SOCKET;
const digest = crypto.createHash('sha256').update('%PDF-1.7\nsynthetic').digest('hex');

test('isolated early evidence binds once to exact committed bytes and expires safely', {
  skip: !socketPath && 'Set STUDENT_EARLY_EVIDENCE_TEST_SOCKET to a disposable MariaDB socket under /tmp.'
}, async (t) => {
  assert.ok(path.resolve(socketPath).startsWith(`${os.tmpdir()}${path.sep}`));
  const dbName = `ark_early_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const admin = mysql.createPool({ socketPath, user: os.userInfo().username, password: '' });
  let raw;
  t.after(async () => {
    if (raw) await raw.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  raw = mysql.createPool({ socketPath, user: os.userInfo().username, password: '', database: dbName });
  for (const statement of [
    'CREATE TABLE users (id INT PRIMARY KEY)',
    'CREATE TABLE students (id INT PRIMARY KEY)',
    `CREATE TABLE documents (id INT PRIMARY KEY, student_id INT NOT NULL, document_type VARCHAR(60) NOT NULL,
      requirement_assignment_id INT NULL, supersedes_document_id INT NULL, file_size_bytes BIGINT NOT NULL,
      uploaded_by INT NOT NULL, mime_type VARCHAR(100) NOT NULL)`,
    ...readSqlFile(path.resolve(__dirname, '../database/mariadb/migrations/026_student_document_early_evidence.sql'))
  ]) await raw.query(statement);
  await raw.query('INSERT INTO users (id) VALUES (11), (12)');
  await raw.query('INSERT INTO students (id) VALUES (21), (22)');
  const bytes = Buffer.from('%PDF-1.7\nsynthetic');
  await raw.query(`INSERT INTO documents (id, student_id, document_type, file_size_bytes, uploaded_by, mime_type)
    VALUES (31, 21, 'report_card', ?, 11, 'application/pdf'), (32, 22, 'report_card', ?, 12, 'application/pdf')`,
  [bytes.length, bytes.length]);
  const pool = new PoolFacade(raw);
  const params = { actorId: 11, studentId: 21, type: 'report_card', assignmentId: null,
    sourceDocumentId: null, digest, mimeType: 'application/pdf', fileSizeBytes: bytes.length,
    model: 'synthetic-model', fields: { studentName: 'Synthetic Learner', grades: 'never retain' } };
  const id = await insertEarlyEvidence(pool, sql, params);
  assert.match(id, /^[a-f0-9-]{36}$/);
  const transaction = new Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  assert.equal(await bindEarlyEvidence(transaction, sql, { ...params, evidenceId: id, actorId: 12, documentId: 31 }), false);
  assert.equal(await bindEarlyEvidence(transaction, sql, { ...params, evidenceId: id, digest: '0'.repeat(64), documentId: 31 }), false);
  assert.equal(await bindEarlyEvidence(transaction, sql, { ...params, evidenceId: id, documentId: 31 }), true);
  assert.equal(await bindEarlyEvidence(transaction, sql, { ...params, evidenceId: id, documentId: 31 }), false);
  await transaction.commit();
  const document = { id: 31, document_type: 'report_card' };
  assert.deepEqual((await loadEarlyEvidence(pool, sql, { document, digest, fileSizeBytes: bytes.length,
    model: 'synthetic-model' })).fields, { studentName: 'Synthetic Learner' });
  assert.equal(await loadEarlyEvidence(pool, sql, { document: { ...document, id: 32 }, digest,
    fileSizeBytes: bytes.length, model: 'synthetic-model' }), null);
  assert.equal(await loadEarlyEvidence(pool, sql, { document, digest: '0'.repeat(64),
    fileSizeBytes: bytes.length, model: 'synthetic-model' }), null);
  assert.equal(await loadEarlyEvidence(pool, sql, { document, digest,
    fileSizeBytes: bytes.length, model: 'other-model' }), null);
  await raw.query('UPDATE student_document_early_evidence SET schema_fingerprint = ? WHERE id = ?', ['0'.repeat(64), id]);
  assert.equal(await loadEarlyEvidence(pool, sql, { document, digest,
    fileSizeBytes: bytes.length, model: 'synthetic-model' }), null);
  const completed = new Transaction(pool);
  await completed.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  await deleteEvidenceForDocument(completed, sql, 31);
  await completed.commit();
  assert.equal(await loadEarlyEvidence(pool, sql, { document, digest,
    fileSizeBytes: bytes.length, model: 'synthetic-model' }), null);
  const abandonedId = await insertEarlyEvidence(pool, sql, params);
  await raw.query('UPDATE student_document_early_evidence SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?', [abandonedId]);
  assert.equal(await loadEarlyEvidence(pool, sql, { document, digest,
    fileSizeBytes: bytes.length, model: 'synthetic-model' }), null);
  await cleanupExpiredEvidence(pool);
  const [rows] = await raw.query('SELECT id FROM student_document_early_evidence WHERE id = ?', [abandonedId]);
  assert.equal(rows.length, 0);
});
