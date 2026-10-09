'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const mysql = require('mysql2/promise');
const os = require('node:os');
const path = require('node:path');
const { readSqlFile, readForwardMigrations } = require('../scripts/db-setup-v2');
const { PoolFacade, Transaction, sql } = require('../src/config/database');
const { createDocumentService } = require('../src/services/documentService');

const socketPath = process.env.REPORT_CARD_ACCESS_MARIADB_TEST_SOCKET;
const projectRoot = path.resolve(__dirname, '..');
const PDF_BYTES = Buffer.from('%PDF-1.7\nsynthetic report-card access fixture');

function quoteDatabase(value) { return `\`${value.replaceAll('`', '``')}\``; }
function uuid() { return crypto.randomUUID(); }

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

test('MariaDB enforces the current correction gate for report-card source reads and metadata', {
  skip: !socketPath && 'Set REPORT_CARD_ACCESS_MARIADB_TEST_SOCKET to a disposable MariaDB socket under /tmp.',
  timeout: 180000
}, async (t) => {
  assert.equal(path.isAbsolute(socketPath), true, 'the integration socket must be absolute');
  assert.equal(path.resolve(socketPath).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`), true,
    'the integration must use a disposable MariaDB socket under /tmp');
  const databaseName = `ark_report_access_${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-report-access-'));
  await fs.chmod(storageRoot, 0o700);
  const admin = await mysql.createConnection({ socketPath, user: 'root', password: '', multipleStatements: false });
  let rawPool;
  t.after(async () => {
    if (rawPool) await rawPool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteDatabase(databaseName)}`).catch(() => {});
    await admin.end().catch(() => {});
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  await admin.query(`CREATE DATABASE ${quoteDatabase(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const setup = await mysql.createConnection({ socketPath, user: 'root', password: '', database: databaseName });
  try {
    await applyStatements(setup, readSqlFile(path.join(projectRoot, 'database/mariadb/schema.sql')));
    for (const migration of readForwardMigrations()) {
      await applyStatements(setup, migration.statements);
      await setup.execute('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
    }
  } finally {
    await setup.end();
  }

  rawPool = mysql.createPool({ socketPath, user: 'root', password: '', database: databaseName,
    waitForConnections: true, connectionLimit: 6, queueLimit: 0, multipleStatements: false,
    dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'] });
  const facade = new PoolFacade(rawPool);
  const service = createDocumentService({
    getPool: async () => facade,
    sql,
    transactionFactory: (pool) => new Transaction(pool),
    storageDirectory: storageRoot
  });

  const [firstUserResult] = await rawPool.execute(`INSERT INTO users (email, password_hash, role)
    VALUES (?, 'integration-only-not-a-login-hash', 'student')`, [`owner-${uuid()}@integration.invalid`]);
  const firstUserId = Number(firstUserResult.insertId);
  const [otherUserResult] = await rawPool.execute(`INSERT INTO users (email, password_hash, role)
    VALUES (?, 'integration-only-not-a-login-hash', 'student')`, [`other-${uuid()}@integration.invalid`]);
  const otherUserId = Number(otherUserResult.insertId);
  const [fallbackUserResult] = await rawPool.execute(`INSERT INTO users (email, password_hash, role)
    VALUES (?, 'integration-only-not-a-login-hash', 'student')`, [`fallback-${uuid()}@integration.invalid`]);
  const fallbackUserId = Number(fallbackUserResult.insertId);
  const [registrarResult] = await rawPool.execute(`INSERT INTO users (email, password_hash, role)
    VALUES (?, 'integration-only-not-a-login-hash', 'registrar')`, [`registrar-${uuid()}@integration.invalid`]);
  const registrarId = Number(registrarResult.insertId);
  const [studentResult] = await rawPool.execute(`INSERT INTO students (user_id, student_no, lrn, first_name, last_name)
    VALUES (?, ?, ?, 'Synthetic', 'Owner')`, [firstUserId, `ACCESS-${uuid()}`, '198765432101']);
  const studentId = Number(studentResult.insertId);
  const [otherStudentResult] = await rawPool.execute(`INSERT INTO students (user_id, student_no, lrn, first_name, last_name)
    VALUES (?, ?, ?, 'Synthetic', 'Other')`, [otherUserId, `ACCESS-${uuid()}`, '198765432102']);
  const otherStudentId = Number(otherStudentResult.insertId);
  const [fallbackStudentResult] = await rawPool.execute(`INSERT INTO students (user_id, student_no, lrn, first_name, last_name)
    VALUES (?, ?, ?, 'Synthetic', 'Fallback')`, [fallbackUserId, `ACCESS-${uuid()}`, '198765432103']);
  const fallbackStudentId = Number(fallbackStudentResult.insertId);
  const userByStudentId = new Map([
    [studentId, firstUserId], [otherStudentId, otherUserId], [fallbackStudentId, fallbackUserId]
  ]);

  async function addDocument({ student = studentId, source = 'student', status = 'needs_review', archive = 0,
    createdAt, supersedes = null, originalFilename = 'synthetic-report-card.pdf' } = {}) {
    const storedFilename = `${uuid()}.pdf`;
    const [result] = await rawPool.execute(`INSERT INTO documents
      (student_id, document_type, original_filename, stored_filename, mime_type, file_size_bytes,
       uploaded_by, upload_source, status, supersedes_document_id, is_legacy_archive, created_at)
      VALUES (?, 'report_card', ?, ?, 'application/pdf', ?, ?, ?, ?, ?, ?, ?)`,
    [student, originalFilename, storedFilename, PDF_BYTES.length, source === 'student' ? userByStudentId.get(student) : registrarId,
      source, status, supersedes, archive, createdAt]);
    return { id: Number(result.insertId), storedFilename };
  }

  async function addDecision(documentId, decisionType, createdAt) {
    const reason = decisionType === 'verified' ? null : `Synthetic ${decisionType} reason.`;
    await rawPool.execute(`INSERT INTO document_decision_events
      (document_id, reviewer_id, decision_type, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
    [documentId, registrarId, decisionType, reason, createdAt]);
  }

  const deniedNoRequest = await addDocument({ createdAt: '2026-10-01 00:00:00' });
  const revokedByFinalDecision = await addDocument({ createdAt: '2026-10-02 00:00:00' });
  await addDecision(revokedByFinalDecision.id, 'correction_requested', '2026-10-02 00:00:00');
  await addDecision(revokedByFinalDecision.id, 'rejected', '2026-10-02 00:00:01');
  const superseded = await addDocument({ createdAt: '2026-10-03 00:00:00' });
  await addDecision(superseded.id, 'correction_requested', '2026-10-03 00:00:00');
  const childVersion = await addDocument({ createdAt: '2026-10-04 00:00:00', supersedes: superseded.id,
    originalFilename: 'synthetic-corrected-report-card.pdf' });
  const verifiedWithStaleCorrection = await addDocument({ status: 'valid', createdAt: '2026-10-05 00:00:00' });
  await addDecision(verifiedWithStaleCorrection.id, 'correction_requested', '2026-10-05 00:00:00');
  const olderReviewCorrection = await addDocument({ status: 'failed', createdAt: '2026-10-06 00:00:00' });
  await rawPool.execute(`INSERT INTO document_review_events
    (document_id, reviewer_id, action_type, instruction, created_at)
    VALUES (?, ?, 'correction_requested', 'Synthetic older instruction.', '2026-10-06 00:00:00')`,
  [olderReviewCorrection.id, registrarId]);
  const reviewEventFallback = await addDocument({ student: fallbackStudentId, status: 'failed', createdAt: '2026-10-06 00:00:00' });
  await rawPool.execute(`INSERT INTO document_review_events
    (document_id, reviewer_id, action_type, instruction, created_at)
    VALUES (?, ?, 'correction_requested', 'Synthetic fallback instruction.', '2026-10-06 00:00:00')`,
  [reviewEventFallback.id, registrarId]);
  const archived = await addDocument({ archive: 1, createdAt: '2026-10-07 00:00:00' });
  await addDecision(archived.id, 'correction_requested', '2026-10-07 00:00:00');
  const staffOrigin = await addDocument({ source: 'registrar', createdAt: '2026-10-08 00:00:00' });
  await addDecision(staffOrigin.id, 'correction_requested', '2026-10-08 00:00:00');
  const otherOwner = await addDocument({ student: otherStudentId, createdAt: '2026-10-09 00:00:00' });
  await addDecision(otherOwner.id, 'correction_requested', '2026-10-09 00:00:00');
  const currentCorrection = await addDocument({ createdAt: '2026-10-10 00:00:00' });
  await addDecision(currentCorrection.id, 'correction_requested', '2026-10-10 00:00:00');
  await fs.writeFile(path.join(storageRoot, currentCorrection.storedFilename), PDF_BYTES, { mode: 0o600 });

  const ownList = await service.listDocuments(firstUserId);
  const ownRows = new Map(ownList.documents.map((row) => [Number(row.id), row]));
  const lockedOwnRows = [deniedNoRequest, revokedByFinalDecision, superseded, childVersion,
    verifiedWithStaleCorrection, olderReviewCorrection];
  for (const row of lockedOwnRows) {
    const listed = ownRows.get(row.id);
    assert.ok(listed, `own report-card status metadata remains visible for row ${row.id}`);
    assert.equal(listed.status != null, true);
    assert.equal(listed.created_at != null, true);
    assert.equal(listed.original_filename, null, `source filename is hidden without the current correction request for row ${row.id}`);
    assert.equal(listed.mime_type, null, `source MIME is hidden without the current correction request for row ${row.id}`);
    assert.equal(listed.file_size_bytes, null, `source size is hidden without the current correction request for row ${row.id}`);
    assert.equal(Number(listed.student_can_view_source), 0);
  }
  assert.equal(ownRows.get(currentCorrection.id).original_filename, 'synthetic-report-card.pdf');
  assert.equal(Number(ownRows.get(currentCorrection.id).student_can_view_source), 1);
  assert.equal(ownRows.has(otherOwner.id), false, 'a student list never includes another student record');
  assert.equal(Number((await service.listDocuments(fallbackUserId)).documents.find(({ id }) => Number(id) === reviewEventFallback.id)
    .student_can_view_source), 1, 'a current review-event correction permits a source when decision history is absent');

  for (const row of [...lockedOwnRows, archived, staffOrigin, otherOwner]) {
    assert.equal(await service.getDocument(firstUserId, String(row.id)), null,
      `guessed document detail remains denied for row ${row.id}`);
    await assert.rejects(service.openDownload(firstUserId, String(row.id)), (error) => error.status === 404,
      `guessed source download remains denied for row ${row.id}`);
  }
  const currentDetail = await service.getDocument(firstUserId, String(currentCorrection.id));
  assert.equal(currentDetail.original_filename, 'synthetic-report-card.pdf');
  assert.equal(currentDetail.history.find(({ id }) => Number(id) === deniedNoRequest.id).original_filename, null,
    'a permitted current detail page does not reveal old report-card source metadata');
  const opened = await service.openDownload(firstUserId, String(currentCorrection.id));
  try {
    assert.deepEqual(await opened.fileHandle.readFile(), PDF_BYTES);
  } finally {
    await opened.fileHandle.close();
  }

  assert.equal((await service.getDocument(firstUserId, String(reviewEventFallback.id))), null,
    'a student cannot use another student’s current review-event correction');
  assert.equal((await service.getDocument(fallbackUserId, String(reviewEventFallback.id))).document_type, 'report_card',
    'the review-event fallback is effective when there is no decision history or newer version');
  assert.equal(await service.getDocument(firstUserId, String(olderReviewCorrection.id)), null,
    'an older review-event correction loses access after a newer report-card version');
  assert.equal((await service.getDocument(registrarId, String(deniedNoRequest.id))).id, deniedNoRequest.id,
    'staff retains read access without a student correction request');
  assert.equal((await service.getDocument(registrarId, String(archived.id))).isArchivedReportCard, true,
    'staff retains read-only access to archived report-card rows');
});
