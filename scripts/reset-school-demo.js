const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getPool, sql } = require('../src/config/database');
const environment = require('../src/config/environment');

const SOURCE_DATABASE = 'ARKTIESIIS_V2';
const BASE_SEED = { action: 'school.demo_seeded', entityType: 'school_demo_seed', entityId: 'school-2026-2027-v2' };
const DOCUMENT_SEED = { action: 'school.demo_documents_seeded', entityType: 'school_demo_seed', entityId: 'school-2026-2027-documents-v1' };
const RESET_MARKER = { action: 'school.demo_reset', entityType: 'school_demo_reset', entityId: 'school-demo-reset-v1' };
const DISPOSABLE_PROTOTYPE_TRANSACTION = {
  id: 1002, financialAccountId: 320, studentId: 320, studentNo: 'SHS-2026-0320',
  type: 'payment', amount: 5000, recordedBy: 2, legacyUnattributed: true,
  auditId: 10002, auditAction: 'finance.transaction_recorded', auditEntityType: 'financial_account',
  auditEntityId: '320', auditUserId: 2, auditDetails: { transactionId: 1002, transactionType: 'payment', amount: '5000.00', referenceNo: null }
};
const USER_ATTESTED_PRIVATE_FILE_DISPOSALS = Object.freeze([
  { path: '2d4019be-2cc4-404d-b93c-cc40138b471d.jpg', size: 95509, sha256: '90cd6c0c9e2dc12f62c6f2ab594de58bee6aaa34430c2992d87a8ecfe7d22024' },
  { path: '4488919d-d9cf-4908-90e2-24a2f5673d5d.jpg', size: 425478, sha256: 'b674a7b36e6d0bbb817fc71b2b05a7228192ef9d1d091b91360af56e9657ac0b' },
  { path: 'b797545c-214f-424a-b8b4-1a33d17636c1.png', size: 4683, sha256: '854a9fd0871e6e3bf4a8ac423afcb285014f722a2155f2b60125e6acd35e0b81' }
]);
const USER_ATTESTED_PRIVATE_FILE_NOTE = 'User confirmed on 2026-10-01 that only these exact unlinked prototype files are disposable.';
const REHEARSAL_DATABASE = /^ARKTIESIIS_V2_REHEARSAL_[0-9]{8}_[0-9]{6}_[a-f0-9]{6}$/;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');

class SchoolResetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SchoolResetError';
    this.status = status;
  }
}

function parseOptions(args) {
  if (!Array.isArray(args) || !args.length || !['--dry-run', '--backup', '--rehearse', '--apply'].includes(args[0])) {
    throw new SchoolResetError('Choose one option: --dry-run, --backup, --rehearse, or --apply --evidence <manifest>.');
  }
  const mode = args[0].slice(2);
  if (mode === 'apply') {
    if (args.length !== 3 || args[1] !== '--evidence' || typeof args[2] !== 'string' || !args[2].trim()) {
      throw new SchoolResetError('Apply requires the manifest path from a successful isolated rehearsal: --apply --evidence <manifest>.');
    }
    return { mode, evidencePath: args[2] };
  }
  if (args.length !== 1) throw new SchoolResetError(`${args[0]} does not accept extra arguments.`);
  return { mode };
}

function isLoopbackServer(server) {
  return new Set(['localhost', '127.0.0.1', '::1']).has(String(server || '').trim().toLowerCase());
}

function assertLocalDatabase(configuration = environment, databaseName = configuration.database?.database) {
  if (configuration.nodeEnv !== 'development') throw new SchoolResetError('School demo cleanup can only run when NODE_ENV=development.');
  if (!isLoopbackServer(configuration.database?.server)) throw new SchoolResetError('School demo cleanup requires a loopback SQL Server.');
  if (databaseName !== SOURCE_DATABASE && !REHEARSAL_DATABASE.test(String(databaseName || ''))) {
    throw new SchoolResetError('School demo cleanup accepts only ARKTIESIIS_V2 or its isolated rehearsal database.');
  }
}

function safeDirectory(directory, { create = false } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new SchoolResetError('Choose a private backup directory.');
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root || isInside(PROJECT_ROOT, resolved) || path.basename(resolved) !== 'school-demo-rehearsal') {
    throw new SchoolResetError('Use the dedicated school-demo-rehearsal directory outside the repository.');
  }
  const existed = fs.existsSync(resolved);
  if (create) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  else if (!existed) throw new SchoolResetError('The private backup directory does not exist.');
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SchoolResetError('The backup directory must be a real directory, not a symbolic link.');
  if (fs.realpathSync(resolved) !== resolved) throw new SchoolResetError('The backup directory path cannot traverse a symbolic link.');
  if (existed && (stat.mode & 0o077) !== 0) throw new SchoolResetError('The existing backup directory must already have private 0700 permissions.');
  if (!existed) fs.chmodSync(resolved, 0o700);
  return resolved;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function exactCount(value) {
  const count = Number(value || 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : -1;
}

function normalizeGuid(value) {
  return String(value || '').toLowerCase();
}

function classifyPrivateDemoAssets({ documentInventory, teacherSubmissionInventory, completedE2e, expectedStorageSnapshot,
  userAttestedFiles = USER_ATTESTED_PRIVATE_FILE_DISPOSALS } = {}) {
  const issues = [];
  const files = Array.isArray(expectedStorageSnapshot?.files) ? expectedStorageSnapshot.files : [];
  if (exactCount(expectedStorageSnapshot?.fileCount) !== files.length) issues.push('paired backup file count is invalid');
  const backedUp = new Map(files.map((file) => [file.path, file]));
  const removals = new Map();
  const addRowAsset = (relativePath, row, provenance) => {
    const backupFile = backedUp.get(relativePath);
    if (!backupFile || backupFile.size !== Number(row.fileSizeBytes)) {
      issues.push(`database-linked private file does not match its exact backup entry: ${relativePath}`);
      return null;
    }
    removals.set(relativePath, { ...backupFile, provenance });
    return backupFile;
  };

  const knownDocumentNames = new Set([
    'SYNTHETIC-DEFENSE-ONLY-Good-Moral-NOT-OFFICIAL.pdf',
    'SYNTHETIC-DEFENSE-ONLY-PSA-NOT-OFFICIAL.png',
    'SYNTHETIC-E2E-Good-Moral-NOT-OFFICIAL.pdf'
  ]);
  const documents = Array.isArray(documentInventory) ? documentInventory : [];
  if (documents.length !== knownDocumentNames.size || documents.some((document) => !knownDocumentNames.has(document.originalFilename))
    || new Set(documents.map((document) => document.originalFilename)).size !== knownDocumentNames.size) {
    issues.push('document rows do not match the exact synthetic demo document set');
  }
  const fixtureHashes = new Set();
  for (const document of documents) {
    let fixturePath;
    if (document.originalFilename?.includes('Good-Moral')) fixturePath = path.join(PROJECT_ROOT, 'tests/fixtures/ocr/synthetic-two-page.pdf');
    else if (document.originalFilename?.includes('PSA')) fixturePath = path.join(PROJECT_ROOT, 'tests/fixtures/ocr/synthetic-png.png');
    if (!fixturePath) {
      issues.push(`document row has no known synthetic fixture: ${document.originalFilename || 'unknown'}`);
      continue;
    }
    const fixtureFingerprint = fingerprintFile(fixturePath);
    const backedUpFile = addRowAsset(document.storedFilename, document, `database-document:${document.id}`);
    if (!backedUpFile) continue;
    if (backedUpFile.size !== fixtureFingerprint.size || backedUpFile.sha256 !== fixtureFingerprint.sha256) {
      issues.push(`document bytes do not match the known synthetic fixture: ${document.storedFilename}`);
      continue;
    }
    fixtureHashes.add(`${backedUpFile.size}:${backedUpFile.sha256}`);
  }

  const submissions = Array.isArray(teacherSubmissionInventory) ? teacherSubmissionInventory : [];
  const firstRevision = submissions.find((row) => Number(row.revision) === 1);
  const latestRevision = submissions.find((row) => Number(row.revision) === 2);
  if (submissions.length !== 2 || !firstRevision || !latestRevision
    || firstRevision.status !== 'correction_requested' || latestRevision.status !== 'approved'
    || firstRevision.originalFilename !== 'SYNTHETIC-E2E-Corrected-SSHS-ECR.xlsx'
    || latestRevision.originalFilename !== 'SYNTHETIC-E2E-Corrected-SSHS-ECR.xlsx'
    || normalizeGuid(latestRevision.previousSubmissionId) !== normalizeGuid(firstRevision.id)
    || normalizeGuid(completedE2e?.submissionId) !== normalizeGuid(latestRevision.id)
    || Number(firstRevision.assignmentId) !== Number(completedE2e?.assignmentId)
    || Number(latestRevision.assignmentId) !== Number(completedE2e?.assignmentId)
    || !/^[0-9a-f-]{36}$/i.test(String(firstRevision.storageKey || ''))
    || !/^[0-9a-f-]{36}$/i.test(String(latestRevision.storageKey || ''))) {
    issues.push('teacher workbook rows do not match the exact completed synthetic E2E revision chain');
  } else {
    for (const submission of [firstRevision, latestRevision]) {
      const relativePath = path.posix.join('teacher-grade-submissions', `${String(submission.storageKey).toLowerCase()}.xlsx`);
      addRowAsset(relativePath, submission, `synthetic-e2e-submission:${submission.id}`);
    }
  }

  for (const attested of userAttestedFiles) {
    const backedUpFile = backedUp.get(attested.path);
    if (!backedUpFile || backedUpFile.size !== attested.size || backedUpFile.sha256 !== attested.sha256) {
      issues.push(`user-attested prototype file no longer matches its exact path and fingerprint: ${attested.path}`);
    } else {
      removals.set(attested.path, { ...backedUpFile, provenance: 'user-attested-unlinked-prototype-file' });
    }
  }

  for (const file of files) {
    if (removals.has(file.path)) continue;
    if (fixtureHashes.has(`${file.size}:${file.sha256}`)) {
      removals.set(file.path, { ...file, provenance: 'duplicate-of-synthetic-document-fixture' });
    }
  }

  const preservedScaffolding = files.filter((file) => file.path === '.gitkeep' && file.size === 0);
  const unclassifiedFiles = files.filter((file) => !removals.has(file.path) && !preservedScaffolding.includes(file));
  return { issues, removals: [...removals.values()].sort((a, b) => a.path.localeCompare(b.path)),
    preservedScaffolding, unclassifiedFiles, userAttestation: USER_ATTESTED_PRIVATE_FILE_NOTE };
}

function validateCleanupSnapshot(snapshot) {
  const issues = [];
  const marker = snapshot.seedMarker;
  if (!marker || marker.action !== BASE_SEED.action || marker.entityType !== BASE_SEED.entityType || marker.entityId !== BASE_SEED.entityId) {
    issues.push('the known legacy school seed marker is missing or has changed');
  } else {
    let details;
    try { details = JSON.parse(marker.detailsJson || '{}'); } catch { details = null; }
    if (!details?.synthetic || details.seedVersion !== BASE_SEED.entityId || Number(details.students) !== 320
      || Number(details.financialTransactions) !== 960) {
      issues.push('the legacy seed marker does not match the expected synthetic cohort');
    }
  }
  if (!snapshot.documentMarker || Number(snapshot.documentMarker.documents) !== 2) {
    issues.push('the synthetic document marker is missing or does not match the expected two examples');
  }
  if (!snapshot.completedE2e?.studentNo?.startsWith('SYN-E2E-') || Number(snapshot.completedE2e.studentId) !== 321
    || Number(snapshot.completedE2e.financeTransactionCount) !== 2 || Number(snapshot.completedE2e.documentId) !== 3) {
    issues.push('the extra E2E records do not have a matching completed synthetic journey marker');
  }
  const submissionInventory = Array.isArray(snapshot.teacherSubmissionInventory) ? snapshot.teacherSubmissionInventory : [];
  const submissionRevisionOne = submissionInventory.find((row) => Number(row.revision) === 1);
  const submissionRevisionTwo = submissionInventory.find((row) => Number(row.revision) === 2);
  if (submissionInventory.length !== 2 || !submissionRevisionOne || !submissionRevisionTwo
    || submissionRevisionOne.status !== 'correction_requested' || submissionRevisionTwo.status !== 'approved'
    || submissionRevisionOne.originalFilename !== 'SYNTHETIC-E2E-Corrected-SSHS-ECR.xlsx'
    || submissionRevisionTwo.originalFilename !== 'SYNTHETIC-E2E-Corrected-SSHS-ECR.xlsx'
    || normalizeGuid(submissionRevisionTwo.previousSubmissionId) !== normalizeGuid(submissionRevisionOne.id)
    || normalizeGuid(snapshot.completedE2e?.submissionId) !== normalizeGuid(submissionRevisionTwo.id)
    || Number(submissionRevisionOne.assignmentId) !== Number(snapshot.completedE2e?.assignmentId)
    || Number(submissionRevisionTwo.assignmentId) !== Number(snapshot.completedE2e?.assignmentId)) {
    issues.push('teacher workbook rows do not match the exact completed synthetic E2E revision chain');
  }
  if (snapshot.markerCounts?.seed !== 1 || snapshot.markerCounts?.document !== 1
    || snapshot.markerCounts?.reset !== 0 || snapshot.markerCounts?.completedE2e !== 1) {
    issues.push('audit marker counts do not match the known demo provenance');
  }

  const expected = {
    totalUsers: 22, staffProfiles: 18, staffUsers: 18, studentUsers: 4,
    students: 321, seededPatternStudents: 320, e2eStudents: 1,
    annualParents: 321, legacyAnnualParents: 321, placements: 321,
    academicTerms: 1, configuredTerms: 0, sections: 16, subjects: 21,
    teacherAssignments: 112, classSchedules: 112, studentSubjects: 2241, grades: 4484,
    financialAccounts: 321, seedTransactions: 960, e2eTransactions: 2, documents: 3,
    seedDocuments: 2, e2eDocuments: 1, documentValidations: 1, documentDecisions: 3,
    e2eSubmissions: 2, e2eSubmissionRows: 2, e2eSubmissionGrades: 8, e2eSubmissionEvents: 4
  };
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (exactCount(snapshot.counts?.[name]) !== expectedValue) issues.push(`${name} does not match the known synthetic inventory`);
  }
  const roles = snapshot.roleCounts || {};
  if (exactCount(roles.registrar) !== 1 || exactCount(roles.finance) !== 1 || exactCount(roles.teacher) !== 16
    || exactCount(roles.database_admin) !== 0 || exactCount(roles.student) !== 4 || exactCount(snapshot.counts?.otherRoleUsers) !== 0) {
    issues.push('user roles do not match the preserved 18 staff and four student logins');
  }
  if (exactCount(snapshot.counts?.unrecognizedLegacyTransactions) !== 1
    || exactCount(snapshot.counts?.attestedDisposableTransactionRows) !== 1
    || exactCount(snapshot.counts?.attestedDisposableAuditRows) !== 1
    || Number(snapshot.disposableTransaction?.id) !== DISPOSABLE_PROTOTYPE_TRANSACTION.id
    || Number(snapshot.disposableTransaction?.financialAccountId) !== DISPOSABLE_PROTOTYPE_TRANSACTION.financialAccountId
    || Number(snapshot.disposableTransaction?.studentId) !== DISPOSABLE_PROTOTYPE_TRANSACTION.studentId
    || snapshot.disposableTransaction?.studentNo !== DISPOSABLE_PROTOTYPE_TRANSACTION.studentNo
    || snapshot.disposableTransaction?.transactionType !== DISPOSABLE_PROTOTYPE_TRANSACTION.type
    || Number(snapshot.disposableTransaction?.amount) !== DISPOSABLE_PROTOTYPE_TRANSACTION.amount
    || snapshot.disposableTransaction?.description !== null || snapshot.disposableTransaction?.referenceNo !== null
    || Number(snapshot.disposableTransaction?.recordedBy) !== DISPOSABLE_PROTOTYPE_TRANSACTION.recordedBy
    || !snapshot.disposableTransaction?.isLegacyUnattributed
    || Number(snapshot.disposableAudit?.id) !== DISPOSABLE_PROTOTYPE_TRANSACTION.auditId
    || Number(snapshot.disposableAudit?.userId) !== DISPOSABLE_PROTOTYPE_TRANSACTION.auditUserId
    || snapshot.disposableAudit?.action !== DISPOSABLE_PROTOTYPE_TRANSACTION.auditAction
    || snapshot.disposableAudit?.entityType !== DISPOSABLE_PROTOTYPE_TRANSACTION.auditEntityType
    || String(snapshot.disposableAudit?.entityId) !== DISPOSABLE_PROTOTYPE_TRANSACTION.auditEntityId
    || JSON.stringify(snapshot.disposableAudit?.details || {}) !== JSON.stringify(DISPOSABLE_PROTOTYPE_TRANSACTION.auditDetails)) {
    issues.push('the user-attested disposable prototype transaction does not match its exact row and audit provenance');
  }
  if (exactCount(snapshot.counts?.nonSyntheticDocuments) !== 0) issues.push('one or more documents lack a synthetic filename marker');
  if (exactCount(snapshot.counts?.studentActorAuditRows) !== 0) issues.push('student-owned audit rows could block safe student-login removal');
  if (exactCount(snapshot.counts?.unsupportedAnnualRows) !== 0) issues.push('annual enrollment rows contain unrecognized intake states');

  const emptyTables = [
    'enrollmentClearances', 'annualEnrollmentEvents', 'annualWorkflowEvents', 'annualEnrollmentTags',
    'annualSpecialSubjects', 'annualAssessments', 'annualRegistrarConfirmations', 'financeSchedules',
    'assessedCharges', 'financeChargeAdjustments', 'financePayments', 'financeAllocationBatches',
    'financePaymentAllocations', 'financeLegacyReconciliationBatches', 'financeLegacyReconciliations',
    'financeLegacyOpeningCharges', 'financeExemptionCases', 'financeDepartureCases', 'financePaymentMetadataEvents',
    'termFinanceApprovals', 'termClearanceEvents', 'physicalChecklistEvents', 'studentDocumentRequests',
    'studentDocumentRequestEvents', 'studentProfileRevisions', 'annualEnrollmentAdminRevisions',
    'financeFeeCommentEvents', 'financeHandbookNumberEvents', 'form137Events', 'physicalReportCardEvents',
    'financeTransactionReversals', 'schoolYearTermOrderReviews', 'documentReviewEvents'
  ];
  for (const name of emptyTables) {
    if (exactCount(snapshot.counts?.[name]) !== 0) issues.push(`${name} contains records outside the legacy demo seed`);
  }
  return [...new Set(issues)];
}

async function readCleanupSnapshot(executor) {
  const countResult = await executor.request().query(`SELECT
      (SELECT COUNT_BIG(*) FROM dbo.users) AS totalUsers,
      (SELECT COUNT_BIG(*) FROM dbo.staff_profiles) AS staffProfiles,
      (SELECT COUNT_BIG(*) FROM dbo.users WHERE role IN (N'registrar', N'finance', N'teacher')) AS staffUsers,
      (SELECT COUNT_BIG(*) FROM dbo.users WHERE role=N'student') AS studentUsers,
      (SELECT COUNT_BIG(*) FROM dbo.audit_logs AS audit INNER JOIN dbo.users AS actor ON actor.id=audit.user_id
        WHERE actor.role=N'student') AS studentActorAuditRows,
      (SELECT COUNT_BIG(*) FROM dbo.two_factor_auth_limits AS limits INNER JOIN dbo.users AS actor ON actor.id=limits.user_id
        WHERE actor.role=N'student') AS studentAuthLimitRows,
      (SELECT COUNT_BIG(*) FROM dbo.users WHERE role NOT IN (N'registrar', N'finance', N'teacher', N'student', N'database_admin')) AS otherRoleUsers,
      (SELECT COUNT_BIG(*) FROM dbo.students) AS students,
      (SELECT COUNT_BIG(*) FROM dbo.students WHERE student_no LIKE N'SHS-2026-[0-9][0-9][0-9][0-9]') AS seededPatternStudents,
      (SELECT COUNT_BIG(*) FROM dbo.students WHERE student_no LIKE N'SYN-E2E-%') AS e2eStudents,
      (SELECT COUNT_BIG(*) FROM dbo.annual_enrollments) AS annualParents,
      (SELECT COUNT_BIG(*) FROM dbo.annual_enrollments WHERE intake_status=N'legacy') AS legacyAnnualParents,
      (SELECT COUNT_BIG(*) FROM dbo.annual_enrollments WHERE intake_status NOT IN (N'legacy', N'enrolled', N'pending', N'cancelled', N'dropped', N'transferred')) AS unsupportedAnnualRows,
      (SELECT COUNT_BIG(*) FROM dbo.enrollments) AS placements,
      (SELECT COUNT_BIG(*) FROM dbo.academic_terms) AS academicTerms,
      (SELECT COUNT_BIG(*) FROM dbo.school_year_term_order) AS configuredTerms,
      (SELECT COUNT_BIG(*) FROM dbo.sections) AS sections,
      (SELECT COUNT_BIG(*) FROM dbo.subjects) AS subjects,
      (SELECT COUNT_BIG(*) FROM dbo.teacher_assignments) AS teacherAssignments,
      (SELECT COUNT_BIG(*) FROM dbo.class_schedules) AS classSchedules,
      (SELECT COUNT_BIG(*) FROM dbo.student_subjects) AS studentSubjects,
      (SELECT COUNT_BIG(*) FROM dbo.grades) AS grades,
      (SELECT COUNT_BIG(*) FROM dbo.financial_accounts) AS financialAccounts,
      (SELECT COUNT_BIG(*) FROM dbo.financial_transactions) AS totalLegacyTransactions,
      (SELECT COUNT_BIG(*) FROM dbo.financial_transactions AS tx
        INNER JOIN dbo.financial_accounts AS account ON account.id=tx.financial_account_id
        INNER JOIN dbo.students AS student ON student.id=account.student_id
        WHERE student.student_no LIKE N'SHS-2026-[0-9][0-9][0-9][0-9]'
          AND ((tx.description IN (N'Tuition assessment - AY 2026-2027', N'Student account payment')
            AND tx.reference_no LIKE student.student_no + N'-%')
            OR (tx.description LIKE N'%laboratory and program fee' AND tx.reference_no LIKE student.student_no + N'-%'))) AS seedTransactions,
      (SELECT COUNT_BIG(*) FROM dbo.financial_transactions AS tx
        INNER JOIN dbo.financial_accounts AS account ON account.id=tx.financial_account_id
        INNER JOIN dbo.students AS student ON student.id=account.student_id
        WHERE student.student_no LIKE N'SYN-E2E-%' AND tx.description LIKE N'Synthetic E2E finance %'
          AND tx.reference_no LIKE N'SYN-%') AS e2eTransactions,
      (SELECT COUNT_BIG(*) FROM dbo.financial_transactions AS tx
        INNER JOIN dbo.financial_accounts AS account ON account.id=tx.financial_account_id
        INNER JOIN dbo.students AS student ON student.id=account.student_id
        WHERE student.student_no LIKE N'SHS-2026-[0-9][0-9][0-9][0-9]' OR student.student_no LIKE N'SYN-E2E-%')
        - (SELECT COUNT_BIG(*) FROM dbo.financial_transactions AS tx
          INNER JOIN dbo.financial_accounts AS account ON account.id=tx.financial_account_id
          INNER JOIN dbo.students AS student ON student.id=account.student_id
          WHERE student.student_no LIKE N'SHS-2026-[0-9][0-9][0-9][0-9]'
            AND ((tx.description IN (N'Tuition assessment - AY 2026-2027', N'Student account payment')
              AND tx.reference_no LIKE student.student_no + N'-%')
              OR (tx.description LIKE N'%laboratory and program fee' AND tx.reference_no LIKE student.student_no + N'-%')))
        - (SELECT COUNT_BIG(*) FROM dbo.financial_transactions AS tx
          INNER JOIN dbo.financial_accounts AS account ON account.id=tx.financial_account_id
          INNER JOIN dbo.students AS student ON student.id=account.student_id
          WHERE student.student_no LIKE N'SYN-E2E-%' AND tx.description LIKE N'Synthetic E2E finance %'
            AND tx.reference_no LIKE N'SYN-%') AS unrecognizedLegacyTransactions,
      (SELECT COUNT_BIG(*) FROM dbo.financial_transactions AS tx
        INNER JOIN dbo.financial_accounts AS account ON account.id=tx.financial_account_id
        INNER JOIN dbo.students AS student ON student.id=account.student_id
        WHERE tx.id=1002 AND tx.financial_account_id=320 AND account.student_id=320
          AND student.student_no=N'SHS-2026-0320' AND tx.transaction_type=N'payment' AND tx.amount=5000.00
          AND tx.description IS NULL AND tx.reference_no IS NULL AND tx.recorded_by=2
          AND tx.is_legacy_unattributed=1 AND CAST(tx.created_at AS date)='2026-09-29') AS attestedDisposableTransactionRows,
      (SELECT COUNT_BIG(*) FROM dbo.audit_logs AS audit
        WHERE audit.id=10002 AND audit.user_id=2 AND audit.action=N'finance.transaction_recorded'
          AND audit.entity_type=N'financial_account' AND audit.entity_id=N'320'
          AND audit.details_json=N'{"transactionId":1002,"transactionType":"payment","amount":"5000.00","referenceNo":null}'
          AND CAST(audit.created_at AS date)='2026-09-29') AS attestedDisposableAuditRows,
      (SELECT COUNT_BIG(*) FROM dbo.documents) AS documents,
      (SELECT COUNT_BIG(*) FROM dbo.documents WHERE original_filename LIKE N'SYNTHETIC-DEFENSE-ONLY-%') AS seedDocuments,
      (SELECT COUNT_BIG(*) FROM dbo.documents WHERE original_filename LIKE N'SYNTHETIC-E2E-%') AS e2eDocuments,
      (SELECT COUNT_BIG(*) FROM dbo.documents WHERE original_filename NOT LIKE N'SYNTHETIC-%') AS nonSyntheticDocuments,
      (SELECT COUNT_BIG(*) FROM dbo.document_validations) AS documentValidations,
      (SELECT COUNT_BIG(*) FROM dbo.document_review_events) AS documentReviewEvents,
      (SELECT COUNT_BIG(*) FROM dbo.document_decision_events) AS documentDecisions,
      (SELECT COUNT_BIG(*) FROM dbo.teacher_grade_submissions) AS e2eSubmissions,
      (SELECT COUNT_BIG(*) FROM dbo.teacher_grade_submission_rows) AS e2eSubmissionRows,
      (SELECT COUNT_BIG(*) FROM dbo.teacher_grade_submission_grades) AS e2eSubmissionGrades,
      (SELECT COUNT_BIG(*) FROM dbo.teacher_grade_submission_events) AS e2eSubmissionEvents,
      (SELECT COUNT_BIG(*) FROM dbo.enrollment_clearances) AS enrollmentClearances,
      (SELECT COUNT_BIG(*) FROM dbo.annual_enrollment_events) AS annualEnrollmentEvents,
      (SELECT COUNT_BIG(*) FROM dbo.annual_workflow_events) AS annualWorkflowEvents,
      (SELECT COUNT_BIG(*) FROM dbo.annual_enrollment_tags) AS annualEnrollmentTags,
      (SELECT COUNT_BIG(*) FROM dbo.annual_special_subjects) AS annualSpecialSubjects,
      (SELECT COUNT_BIG(*) FROM dbo.annual_assessments) AS annualAssessments,
      (SELECT COUNT_BIG(*) FROM dbo.annual_registrar_confirmations) AS annualRegistrarConfirmations,
      (SELECT COUNT_BIG(*) FROM dbo.finance_schedules) AS financeSchedules,
      (SELECT COUNT_BIG(*) FROM dbo.assessed_charges) AS assessedCharges,
      (SELECT COUNT_BIG(*) FROM dbo.finance_charge_adjustments) AS financeChargeAdjustments,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payments) AS financePayments,
      (SELECT COUNT_BIG(*) FROM dbo.finance_allocation_batches) AS financeAllocationBatches,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payment_allocations) AS financePaymentAllocations,
      (SELECT COUNT_BIG(*) FROM dbo.finance_legacy_reconciliation_batches) AS financeLegacyReconciliationBatches,
      (SELECT COUNT_BIG(*) FROM dbo.finance_legacy_reconciliations) AS financeLegacyReconciliations,
      (SELECT COUNT_BIG(*) FROM dbo.finance_legacy_opening_charges) AS financeLegacyOpeningCharges,
      (SELECT COUNT_BIG(*) FROM dbo.finance_exemption_cases) AS financeExemptionCases,
      (SELECT COUNT_BIG(*) FROM dbo.finance_departure_cases) AS financeDepartureCases,
      (SELECT COUNT_BIG(*) FROM dbo.finance_payment_metadata_events) AS financePaymentMetadataEvents,
      (SELECT COUNT_BIG(*) FROM dbo.term_finance_approvals) AS termFinanceApprovals,
      (SELECT COUNT_BIG(*) FROM dbo.term_clearance_events) AS termClearanceEvents,
      (SELECT COUNT_BIG(*) FROM dbo.student_physical_checklist_events) AS physicalChecklistEvents,
      (SELECT COUNT_BIG(*) FROM dbo.student_document_requests) AS studentDocumentRequests,
      (SELECT COUNT_BIG(*) FROM dbo.student_document_request_events) AS studentDocumentRequestEvents,
      (SELECT COUNT_BIG(*) FROM dbo.student_profile_revisions) AS studentProfileRevisions,
      (SELECT COUNT_BIG(*) FROM dbo.annual_enrollment_admin_revisions) AS annualEnrollmentAdminRevisions,
      (SELECT COUNT_BIG(*) FROM dbo.finance_fee_comment_events) AS financeFeeCommentEvents,
      (SELECT COUNT_BIG(*) FROM dbo.finance_handbook_number_events) AS financeHandbookNumberEvents,
      (SELECT COUNT_BIG(*) FROM dbo.form137_status_events) AS form137Events,
      (SELECT COUNT_BIG(*) FROM dbo.previous_school_report_card_status_events) AS physicalReportCardEvents,
      (SELECT COUNT_BIG(*) FROM dbo.finance_transaction_reversals) AS financeTransactionReversals,
      (SELECT COUNT_BIG(*) FROM dbo.school_year_term_order_reviews) AS schoolYearTermOrderReviews,
      (SELECT COUNT_BIG(*) FROM dbo.two_factor_codes) AS twoFactorCodes,
      (SELECT COUNT_BIG(*) FROM dbo.password_reset_tokens) AS passwordResetTokens,
      (SELECT COUNT_BIG(*) FROM dbo.pending_email_changes) AS pendingEmailChanges`);
  const roleResult = await executor.request().query(`SELECT role, COUNT_BIG(*) AS total
    FROM dbo.users GROUP BY role`);
  const markerRequest = executor.request()
    .input('seedAction', sql.NVarChar(100), BASE_SEED.action).input('documentAction', sql.NVarChar(100), DOCUMENT_SEED.action)
    .input('resetAction', sql.NVarChar(100), RESET_MARKER.action).input('seedType', sql.NVarChar(100), BASE_SEED.entityType)
    .input('resetType', sql.NVarChar(100), RESET_MARKER.entityType);
  const markerResult = await markerRequest.query(`SELECT id, user_id, action, entity_type, entity_id, details_json
    FROM dbo.audit_logs
    WHERE (action IN (@seedAction, @documentAction, @resetAction)
      AND entity_type IN (@seedType, @resetType))
    OR (action = N'synthetic.e2e_completed' AND entity_type = N'synthetic_v2_journey')
    ORDER BY id`);
  const disposableResult = await executor.request().query(`SELECT tx.id, tx.financial_account_id AS financialAccountId,
      account.student_id AS studentId, student.student_no AS studentNo, tx.transaction_type AS transactionType,
      tx.amount, tx.description, tx.reference_no AS referenceNo, tx.recorded_by AS recordedBy,
      tx.is_legacy_unattributed AS isLegacyUnattributed
    FROM dbo.financial_transactions AS tx
    INNER JOIN dbo.financial_accounts AS account ON account.id=tx.financial_account_id
    INNER JOIN dbo.students AS student ON student.id=account.student_id
    WHERE tx.id=1002;
    SELECT id, user_id AS userId, action, entity_type AS entityType, entity_id AS entityId, details_json AS detailsJson
    FROM dbo.audit_logs WHERE id=10002;`);
  const documentInventoryResult = await executor.request().query(`SELECT id, student_id AS studentId, original_filename AS originalFilename,
      stored_filename AS storedFilename, file_size_bytes AS fileSizeBytes
    FROM dbo.documents ORDER BY id`);
  const teacherSubmissionInventoryResult = await executor.request().query(`SELECT CONVERT(NVARCHAR(36), id) AS id,
      CONVERT(NVARCHAR(36), previous_submission_id) AS previousSubmissionId,
      CONVERT(NVARCHAR(36), storage_key) AS storageKey, original_filename AS originalFilename,
      file_size_bytes AS fileSizeBytes, status, revision_number AS revision, assignment_id AS assignmentId
    FROM dbo.teacher_grade_submissions ORDER BY revision_number`);
  const staffState = await readPreservedStaffState(executor);
  const counts = countResult.recordset?.[0] || {};
  const roleCounts = Object.fromEntries((roleResult.recordset || []).map((row) => [row.role, row.total]));
  const markers = markerResult.recordset || [];
  const seed = markers.find((row) => row.action === BASE_SEED.action && row.entity_id === BASE_SEED.entityId);
  const document = markers.find((row) => row.action === DOCUMENT_SEED.action && row.entity_id === DOCUMENT_SEED.entityId);
  const reset = markers.find((row) => row.action === RESET_MARKER.action && row.entity_id === RESET_MARKER.entityId);
  const e2eRows = markers.filter((row) => row.action === 'synthetic.e2e_completed');
  const parseJson = (value) => { try { return JSON.parse(value || '{}'); } catch { return null; } };
  const documentDetails = parseJson(document?.details_json);
  const disposableAuditRow = disposableResult.recordsets?.[1]?.[0];
  return {
    counts,
    roleCounts,
    seedMarker: seed ? { action: seed.action, entityType: seed.entity_type, entityId: seed.entity_id, detailsJson: seed.details_json } : null,
    documentMarker: documentDetails,
    resetMarker: reset ? { action: reset.action, entityType: reset.entity_type, entityId: reset.entity_id } : null,
    completedE2e: e2eRows.length === 1 ? parseJson(e2eRows[0].details_json) : null,
    disposableTransaction: disposableResult.recordsets?.[0]?.[0] || null,
    disposableAudit: disposableAuditRow ? { id: disposableAuditRow.id, userId: disposableAuditRow.userId,
      action: disposableAuditRow.action, entityType: disposableAuditRow.entityType, entityId: disposableAuditRow.entityId,
      details: parseJson(disposableAuditRow.detailsJson) } : null,
    documentInventory: documentInventoryResult.recordset || [],
    teacherSubmissionInventory: teacherSubmissionInventoryResult.recordset || [],
    staffFingerprint: staffState.fingerprint,
    staffSessionFingerprint: staffState.sessionFingerprint,
    markerCounts: { seed: markers.filter((row) => row.action === BASE_SEED.action).length,
      document: markers.filter((row) => row.action === DOCUMENT_SEED.action).length,
      reset: markers.filter((row) => row.action === RESET_MARKER.action).length, completedE2e: e2eRows.length }
  };
}

async function readPreservedStaffState(executor) {
  const result = await executor.request().query(`SELECT user_record.id, user_record.email, user_record.password_hash AS passwordHash,
      user_record.role, user_record.is_active AS isActive, user_record.email_verified_at AS emailVerifiedAt,
      user_record.must_change_password AS mustChangePassword, user_record.auth_session_version AS authSessionVersion,
      profile.employee_no AS employeeNo, profile.first_name AS firstName, profile.last_name AS lastName,
      profile.department
    FROM dbo.users AS user_record
    INNER JOIN dbo.staff_profiles AS profile ON profile.user_id=user_record.id
    WHERE user_record.role IN (N'registrar', N'finance', N'teacher') ORDER BY user_record.id`);
  const records = result.recordset || [];
  const stableRecords = records.map(({ authSessionVersion, ...record }) => record);
  return {
    records,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(stableRecords)).digest('hex'),
    sessionFingerprint: crypto.createHash('sha256').update(JSON.stringify(records.map(({ id, authSessionVersion }) => [id, authSessionVersion]))).digest('hex')
  };
}

function preservedStaffWasRetained(before, after) {
  if (!Array.isArray(before?.records) || !Array.isArray(after?.records) || before.records.length !== 18 || after.records.length !== 18) return false;
  const stripSession = ({ authSessionVersion, ...record }) => record;
  if (before.records.some((record, index) => JSON.stringify(stripSession(record)) !== JSON.stringify(stripSession(after.records[index])))) return false;
  return before.records.every((record, index) => String(record.authSessionVersion) !== String(after.records[index].authSessionVersion));
}

async function resolveDockerContainer(port = environment.database.port, runDocker = execFileSync) {
  let names;
  try {
    names = runDocker('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}'], { encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(Boolean);
  } catch {
    throw new SchoolResetError('Could not inspect the local SQL Server container for backup transfer.');
  }
  if (names.length !== 1) throw new SchoolResetError('Expected exactly one local SQL Server container on the configured port.');
  const image = runDocker('docker', ['inspect', '--format', '{{.Config.Image}}', names[0]], { encoding: 'utf8' }).trim();
  if (!/mcr\.microsoft\.com\/mssql\/server(?::|$)/i.test(image)) {
    throw new SchoolResetError('The local SQL Server container image did not match the expected Microsoft SQL Server image.');
  }
  return names[0];
}

function makePrivateDirectory(directory, fileSystem = fs) {
  const existed = fileSystem.existsSync(directory);
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fileSystem.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SchoolResetError('The backup artifact path must be a real directory.');
  if (existed && (stat.mode & 0o077) !== 0) throw new SchoolResetError('An existing backup artifact directory must already have private 0700 permissions.');
  if (!existed) fileSystem.chmodSync(directory, 0o700);
  return directory;
}

function fingerprintFile(filePath, fileSystem = fs) {
  const noFollow = fileSystem.constants.O_NOFOLLOW || 0;
  const descriptor = fileSystem.openSync(filePath, fileSystem.constants.O_RDONLY | noFollow);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  try {
    let bytesRead;
    while ((bytesRead = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally {
    fileSystem.closeSync(descriptor);
  }
  return { size, sha256: hash.digest('hex') };
}

function snapshotPrivateTree(source, fileSystem = fs) {
  const root = path.resolve(source);
  const rootStat = fileSystem.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || isInside(PUBLIC_ROOT, root)) {
    throw new SchoolResetError('Private document storage must be a real directory outside the public web directory.');
  }
  const files = [];
  const walk = (directory, relativeDirectory = '') => {
    const entries = fileSystem.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const stat = fileSystem.lstatSync(filePath);
      if (stat.isSymbolicLink()) throw new SchoolResetError('Symbolic links are not allowed in private document storage.');
      if (stat.isDirectory()) walk(filePath, relativePath);
      else if (stat.isFile()) files.push({ path: relativePath, ...fingerprintFile(filePath, fileSystem) });
      else throw new SchoolResetError('Private document storage contains an unsupported file type.');
    }
  };
  walk(root);
  return { fileCount: files.length, files };
}

function copyPrivateTree(source, destination, fileSystem = fs) {
  const sourceRoot = path.resolve(source);
  const destinationRoot = path.resolve(destination);
  const sourceStat = fileSystem.lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new SchoolResetError('Private document storage must be a real directory.');
  if (isInside(PUBLIC_ROOT, sourceRoot)) throw new SchoolResetError('Private documents must stay outside the public web directory.');
  makePrivateDirectory(destinationRoot, fileSystem);
  let fileCount = 0;
  const walk = (from, to) => {
    for (const entry of fileSystem.readdirSync(from, { withFileTypes: true })) {
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      const stat = fileSystem.lstatSync(fromPath);
      if (stat.isSymbolicLink()) throw new SchoolResetError('Symbolic links are not allowed in private document storage.');
      if (stat.isDirectory()) {
        makePrivateDirectory(toPath, fileSystem);
        walk(fromPath, toPath);
      } else if (stat.isFile()) {
        fileSystem.copyFileSync(fromPath, toPath, fs.constants.COPYFILE_EXCL);
        fileSystem.chmodSync(toPath, 0o600);
        fileCount += 1;
      } else {
        throw new SchoolResetError('Private document storage contains an unsupported file type.');
      }
    }
  };
  walk(sourceRoot, destinationRoot);
  const sourceFiles = snapshotPrivateTree(sourceRoot, fileSystem);
  const copiedFiles = snapshotPrivateTree(destinationRoot, fileSystem);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(copiedFiles) || copiedFiles.fileCount !== fileCount) {
    throw new SchoolResetError('The private document copy does not exactly match its source fingerprint.');
  }
  return { directory: destinationRoot, fileCount, files: copiedFiles.files };
}

function resolveBackupArtifactRoot(root = path.join(os.homedir(), '.local', 'state', 'arktiesiis', 'school-demo-rehearsal')) {
  const resolved = path.resolve(root);
  if (isInside(PROJECT_ROOT, resolved) || path.basename(resolved) !== 'school-demo-rehearsal') {
    throw new SchoolResetError('Backup artifacts must use the dedicated school-demo-rehearsal directory outside the repository.');
  }
  return resolved;
}

async function backupDatabaseAndDocuments({ sourcePool, configuration = environment, storageDirectory = environment.upload?.storageDirectory,
  backupRoot = resolveBackupArtifactRoot(), runDocker = execFileSync, fileSystem = fs, now = new Date() } = {}) {
  assertLocalDatabase(configuration, SOURCE_DATABASE);
  await assertNoOtherDatabaseSessions(sourcePool);
  const beforeSnapshot = await readCleanupSnapshot(sourcePool);
  const documentsBefore = snapshotPrivateTree(storageDirectory, fileSystem);
  const root = safeDirectory(backupRoot, { create: true });
  const artifactsDirectory = makePrivateDirectory(fileSystem.mkdtempSync(path.join(root, 'school-demo-backup-')), fileSystem);
  const containerName = await resolveDockerContainer(configuration.database.port, runDocker);
  const serverResult = await sourcePool.request().query(`SELECT DB_NAME() AS databaseName,
    CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS NVARCHAR(4000)) AS backupDirectory`);
  const server = serverResult.recordset?.[0] || {};
  if (server.databaseName !== SOURCE_DATABASE || typeof server.backupDirectory !== 'string'
    || !server.backupDirectory.startsWith('/var/opt/mssql/')) {
    throw new SchoolResetError('The connected database or SQL Server backup path did not match local V2 expectations.');
  }
  const nonce = crypto.randomBytes(6).toString('hex');
  const backupFileName = `ARKTIESIIS_V2_school_demo_${now.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}_${nonce}.bak`;
  const serverBackupPath = path.posix.join(server.backupDirectory, backupFileName);
  const hostBackupPath = path.join(artifactsDirectory, backupFileName);
  await sourcePool.request().input('backupPath', sql.NVarChar(4000), serverBackupPath)
    .query('BACKUP DATABASE [ARKTIESIIS_V2] TO DISK = @backupPath WITH COPY_ONLY, CHECKSUM, COMPRESSION, INIT');
  await sourcePool.request().input('backupPath', sql.NVarChar(4000), serverBackupPath)
    .query('RESTORE VERIFYONLY FROM DISK = @backupPath WITH CHECKSUM');
  runDocker('docker', ['cp', `${containerName}:${serverBackupPath}`, hostBackupPath], { encoding: 'utf8' });
  fileSystem.chmodSync(hostBackupPath, 0o600);
  const backupStat = fileSystem.statSync(hostBackupPath);
  if (!backupStat.isFile() || backupStat.size < 1) throw new SchoolResetError('The copied database backup is empty.');
  const backupFingerprint = fingerprintFile(hostBackupPath, fileSystem);

  const documentCopy = copyPrivateTree(storageDirectory, path.join(artifactsDirectory, 'documents'), fileSystem);
  const documentsAfter = snapshotPrivateTree(storageDirectory, fileSystem);
  const snapshot = await readCleanupSnapshot(sourcePool);
  await assertNoOtherDatabaseSessions(sourcePool);
  if (JSON.stringify(beforeSnapshot) !== JSON.stringify(snapshot) || JSON.stringify(documentsBefore) !== JSON.stringify(documentsAfter)
    || JSON.stringify(documentsBefore) !== JSON.stringify({ fileCount: documentCopy.fileCount, files: documentCopy.files })) {
    throw new SchoolResetError('The source database or private document tree changed during backup; artifacts were retained but cannot be used for cleanup.');
  }
  const manifest = {
    createdAt: now.toISOString(), sourceDatabase: SOURCE_DATABASE,
    backupFile: backupFileName, backupBytes: backupStat.size, backupSha256: backupFingerprint.sha256,
    serverBackupPath, sqlServerBackupVerified: true,
    documentStorage: { fileCount: documentCopy.fileCount, files: documentCopy.files },
    privateFileAttestation: { note: USER_ATTESTED_PRIVATE_FILE_NOTE, files: USER_ATTESTED_PRIVATE_FILE_DISPOSALS },
    sourceSnapshot: snapshot
  };
  const manifestPath = path.join(artifactsDirectory, 'manifest.json');
  fileSystem.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fileSystem.chmodSync(manifestPath, 0o600);
  return { artifactsDirectory, hostBackupPath, serverBackupPath, backupFileName, backupBytes: backupStat.size,
    documentBackupDirectory: documentCopy.directory, copiedDocumentFiles: documentCopy.fileCount,
    documentStorage: manifest.documentStorage, manifestPath, containerName, sourceSnapshot: snapshot };
}

async function assertNoOtherDatabaseSessions(sourcePool) {
  const result = await sourcePool.request().query(`SELECT session_id, host_name, program_name
    FROM sys.dm_exec_sessions
    WHERE database_id = DB_ID() AND is_user_process = 1 AND session_id <> @@SPID`);
  if (result.recordset?.length) {
    throw new SchoolResetError('Stop the application and all other V2 database clients before creating the paired database and document backup.');
  }
}

async function restoreIsolatedCopy({ sourcePool, backup, configuration = environment, now = new Date(),
  runDocker = execFileSync, poolFactory = (config) => new sql.ConnectionPool(config) } = {}) {
  assertLocalDatabase(configuration, SOURCE_DATABASE);
  if (!backup?.serverBackupPath || !backup?.hostBackupPath || !backup?.sourceSnapshot) {
    throw new SchoolResetError('An owner-only SQL backup and source snapshot are required before rehearsal.');
  }
  const portStamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const rehearsalName = `ARKTIESIIS_V2_REHEARSAL_${portStamp.slice(0, 8)}_${portStamp.slice(8)}_${crypto.randomBytes(3).toString('hex')}`;
  if (!REHEARSAL_DATABASE.test(rehearsalName)) throw new SchoolResetError('Could not create a safe rehearsal database name.');
  const existingDatabase = await sourcePool.request().input('databaseName', sql.NVarChar(128), rehearsalName)
    .query('SELECT DB_ID(@databaseName) AS databaseId');
  if (existingDatabase.recordset?.[0]?.databaseId !== null) {
    throw new SchoolResetError('The generated rehearsal database name already exists; restore refused to overwrite it.');
  }
  const fileListResult = await sourcePool.request().input('backupPath', sql.NVarChar(4000), backup.serverBackupPath)
    .query('RESTORE FILELISTONLY FROM DISK = @backupPath');
  const files = (fileListResult.recordset || []).filter((row) => ['D', 'L'].includes(row.Type));
  if (files.filter((row) => row.Type === 'D').length !== 1 || files.filter((row) => row.Type === 'L').length !== 1
    || files.some((row) => !/^[A-Za-z0-9_ -]{1,128}$/.test(row.LogicalName))) {
    throw new SchoolResetError('The SQL backup file list did not match the expected single data and log file layout.');
  }
  const backupDirectory = path.posix.dirname(backup.serverBackupPath);
  const moveClauses = files.map((row) => {
    const suffix = row.Type === 'D' ? '.mdf' : '.ldf';
    const physicalPath = path.posix.join(backupDirectory, `${rehearsalName}${suffix}`);
    const logicalName = String(row.LogicalName).replace(/'/g, "''");
    const escapedPath = physicalPath.replace(/'/g, "''");
    return `MOVE N'${logicalName}' TO N'${escapedPath}'`;
  });
  const restoreSql = `RESTORE DATABASE [${rehearsalName}] FROM DISK = @backupPath WITH FILE = 1, ${moveClauses.join(', ')}, CHECKSUM, RECOVERY`;
  await sourcePool.request().input('backupPath', sql.NVarChar(4000), backup.serverBackupPath).query(restoreSql);

  const rehearsalConfig = { ...configuration.database, database: rehearsalName };
  const rehearsalPool = await poolFactory(rehearsalConfig).connect();
  try {
    const identity = await rehearsalPool.request().query('SELECT DB_NAME() AS databaseName');
    if (identity.recordset?.[0]?.databaseName !== rehearsalName) throw new SchoolResetError('The restored connection did not select its isolated rehearsal database.');
    const restoredSnapshot = await readCleanupSnapshot(rehearsalPool);
    if (JSON.stringify(restoredSnapshot) !== JSON.stringify(backup.sourceSnapshot)) {
      throw new SchoolResetError('The isolated restore did not reproduce the source inventory exactly.');
    }
    return { databaseName: rehearsalName, restoredSnapshot, pool: rehearsalPool, config: rehearsalConfig };
  } catch (error) {
    await rehearsalPool.close();
    throw error;
  }
}

async function cleanupSchoolDemoData({ pool, databaseName, configuration = environment, backupVerified = false,
  transactionFactory = (source) => new sql.Transaction(source), transaction: sharedTransaction = null } = {}) {
  assertLocalDatabase(configuration, databaseName);
  if (!backupVerified) throw new SchoolResetError('Verified database and private-document backups plus an isolated restore are required before cleanup.');
  if (!sharedTransaction) await assertNoOtherDatabaseSessions(pool);
  const preflight = await readCleanupSnapshot(sharedTransaction || pool);
  if (preflight.resetMarker && exactCount(preflight.counts?.students) === 0 && exactCount(preflight.counts?.totalLegacyTransactions) === 0
    && exactCount(preflight.markerCounts?.reset) === 1) {
    return { alreadyClean: true, preservedStaff: 18 };
  }
  const issues = validateCleanupSnapshot(preflight);
  if (issues.length) throw new SchoolResetError(`Cleanup refused: ${issues.join('; ')}. No database rows were changed.`, 409);

  const transaction = sharedTransaction || transactionFactory(pool);
  let started = false;
  try {
    if (!sharedTransaction) {
      await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
      started = true;
    }
    const lockedSnapshot = await readCleanupSnapshot(transaction);
    const lockedIssues = validateCleanupSnapshot(lockedSnapshot);
    if (lockedIssues.length) throw new SchoolResetError(`Cleanup refused after locked recheck: ${lockedIssues.join('; ')}.`, 409);
    const staffBefore = await readPreservedStaffState(transaction);
    const deletes = [
      `DELETE FROM dbo.teacher_grade_submission_grades`,
      `DELETE FROM dbo.teacher_grade_submission_rows`,
      `DELETE FROM dbo.teacher_grade_submission_events`,
      `DELETE FROM dbo.teacher_grade_submissions`,
      `DELETE FROM dbo.document_validations`,
      `DELETE FROM dbo.document_review_events`,
      `DELETE FROM dbo.document_decision_events`,
      `DELETE FROM dbo.form137_status_events`,
      `DELETE FROM dbo.previous_school_report_card_status_events`,
      `DELETE FROM dbo.documents`,
      `DELETE FROM dbo.grades`,
      `DELETE FROM dbo.student_subjects`,
      `DELETE FROM dbo.class_schedules`,
      `DELETE FROM dbo.teacher_assignments`,
      `DELETE FROM dbo.finance_transaction_reversals`,
      `DELETE FROM dbo.financial_transactions`,
      `DELETE FROM dbo.financial_accounts`,
      `DELETE FROM dbo.term_finance_approvals`,
      `DELETE FROM dbo.term_clearance_events`,
      `DELETE FROM dbo.enrollments`,
      `DELETE FROM dbo.annual_enrollments`,
      `DELETE FROM dbo.sections`,
      `DELETE FROM dbo.subjects`,
      `DELETE FROM dbo.school_year_term_order`,
      `DELETE FROM dbo.school_year_term_order_reviews`,
      `DELETE FROM dbo.academic_terms`,
      `DELETE FROM dbo.students`,
      `DELETE FROM dbo.two_factor_codes`,
      `DELETE FROM dbo.password_reset_tokens`,
      `DELETE FROM dbo.pending_email_changes`,
      `DELETE FROM dbo.two_factor_auth_limits WHERE user_id IN (SELECT id FROM dbo.users WHERE role=N'student')`,
      `DELETE FROM dbo.users WHERE role = N'student'`,
      `UPDATE dbo.users SET auth_session_version = NEWID(), updated_at = SYSUTCDATETIME()
        WHERE role IN (N'registrar', N'finance', N'teacher')`,
      `DELETE FROM dbo.audit_logs WHERE (action = @seedAction AND entity_type = @seedType AND entity_id = @seedId)
        OR (action = @documentAction AND entity_type = @seedType AND entity_id = @documentId)
        OR (action LIKE N'synthetic.e2e_%' AND entity_type = N'synthetic_v2_journey')`
    ];
    for (const statement of deletes) {
      const request = transaction.request();
      if (statement.includes('@seedAction')) request
        .input('seedAction', sql.NVarChar(100), BASE_SEED.action).input('seedType', sql.NVarChar(100), BASE_SEED.entityType)
        .input('seedId', sql.NVarChar(100), BASE_SEED.entityId).input('documentAction', sql.NVarChar(100), DOCUMENT_SEED.action)
        .input('documentId', sql.NVarChar(100), DOCUMENT_SEED.entityId);
      await request.query(statement);
    }
    const staffAfter = await readPreservedStaffState(transaction);
    if (!preservedStaffWasRetained(staffBefore, staffAfter)) {
      throw new SchoolResetError('Staff profiles, email/password hashes, or all-session rotation did not match the preserved-staff invariant.');
    }
    await transaction.request().input('action', sql.NVarChar(100), RESET_MARKER.action)
      .input('entityType', sql.NVarChar(100), RESET_MARKER.entityType).input('entityId', sql.NVarChar(100), RESET_MARKER.entityId)
      .input('detailsJson', sql.NVarChar(sql.MAX), JSON.stringify({
        synthetic: true,
        seedMarker: BASE_SEED.entityId,
        preservedStaff: 18,
        userAttestation: {
          classifiedAt: '2026-10-01',
          transactionId: DISPOSABLE_PROTOTYPE_TRANSACTION.id,
          auditId: DISPOSABLE_PROTOTYPE_TRANSACTION.auditId,
          transientTokensCleared: {
            twoFactorCodes: Number(preflight.counts.twoFactorCodes),
            passwordResetTokens: Number(preflight.counts.passwordResetTokens),
            pendingEmailChanges: Number(preflight.counts.pendingEmailChanges),
            studentAuthLimitRows: Number(preflight.counts.studentAuthLimitRows)
          },
          statement: 'User classified this exact local prototype transaction as disposable; no other unmatched transaction is authorized for deletion.'
        },
        privateFileAttestation: {
          statement: USER_ATTESTED_PRIVATE_FILE_NOTE,
          files: USER_ATTESTED_PRIVATE_FILE_DISPOSALS
        }
      }))
      .query(`INSERT INTO dbo.audit_logs (user_id, action, entity_type, entity_id, details_json)
        VALUES (NULL, @action, @entityType, @entityId, @detailsJson)`);
    if (started) {
      await transaction.commit();
      started = false;
    }
    return { alreadyClean: false, preservedStaff: 18, authSessionVersionsRotated: 18,
      removedDocumentInventory: lockedSnapshot.documentInventory,
      removedTeacherSubmissionInventory: lockedSnapshot.teacherSubmissionInventory,
      removedCompletedE2e: lockedSnapshot.completedE2e, staffFingerprint: lockedSnapshot.staffFingerprint };
  } catch (error) {
    if (started) {
      try { await transaction.rollback(); } catch { /* Keep the original error. */ }
    }
    throw error;
  }
}

function removeReplacedDemoDocuments({ storageDirectory = environment.upload?.storageDirectory, documentInventory,
  teacherSubmissionInventory, completedE2e, expectedStorageSnapshot,
  userAttestedFiles = USER_ATTESTED_PRIVATE_FILE_DISPOSALS, fileSystem = fs } = {}) {
  const root = path.resolve(storageDirectory || '');
  const current = snapshotPrivateTree(root, fileSystem);
  if (!expectedStorageSnapshot || JSON.stringify(current) !== JSON.stringify(expectedStorageSnapshot)) {
    throw new SchoolResetError('Private storage changed after its paired backup; no files were removed.');
  }
  const plan = classifyPrivateDemoAssets({ documentInventory, teacherSubmissionInventory, completedE2e,
    expectedStorageSnapshot, userAttestedFiles });
  if (plan.issues.length) throw new SchoolResetError(`Private demo-file provenance did not match its paired backup: ${plan.issues.join('; ')}.`);
  for (const file of plan.removals) {
    const filePath = path.resolve(root, ...file.path.split('/'));
    if (!isInside(root, filePath)) throw new SchoolResetError('A verified private file path escaped its storage directory.');
    const stat = fileSystem.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SchoolResetError('A verified private file is not a regular file.');
  }
  for (const file of plan.removals) fileSystem.unlinkSync(path.resolve(root, ...file.path.split('/')));
  return { removedFiles: plan.removals.length, removed: plan.removals,
    unclassifiedFiles: plan.unclassifiedFiles, preservedScaffolding: plan.preservedScaffolding,
    userAttestation: plan.userAttestation };
}

function writePrivateManifest(manifestPath, manifest, fileSystem = fs) {
  fileSystem.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fileSystem.chmodSync(manifestPath, 0o600);
}

function readPrivateManifest(evidencePath, backupRoot, fileSystem = fs) {
  const manifestPath = path.resolve(evidencePath);
  if (!isInside(backupRoot, manifestPath) || path.basename(manifestPath) !== 'manifest.json') {
    throw new SchoolResetError('Apply evidence must be a manifest.json inside the private rehearsal backup directory.');
  }
  const artifactStat = fileSystem.lstatSync(path.dirname(manifestPath));
  if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink() || (artifactStat.mode & 0o077) !== 0
    || fileSystem.realpathSync(path.dirname(manifestPath)) !== path.dirname(manifestPath)) {
    throw new SchoolResetError('The rehearsal artifact directory must be a real owner-only directory.');
  }
  const stat = fileSystem.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new SchoolResetError('Apply evidence must be a regular owner-only file.');
  }
  let manifest;
  try { manifest = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8')); } catch {
    throw new SchoolResetError('Apply evidence is not a readable reset manifest.');
  }
  if (manifest?.sourceDatabase !== SOURCE_DATABASE || manifest?.sqlServerBackupVerified !== true
    || manifest?.rehearsal?.verified !== true || manifest?.rehearsal?.cleanupRollbackVerified !== true
    || !manifest?.sourceSnapshot || !manifest?.backupFile) {
    throw new SchoolResetError('Apply requires a successful isolated reset and seed rehearsal recorded in its manifest.');
  }
  return { manifest, manifestPath, artifactsDirectory: path.dirname(manifestPath) };
}

function backupDetailsFromManifest({ manifest, artifactsDirectory, configuration = environment }) {
  if (path.basename(manifest.backupFile) !== manifest.backupFile || !/^[A-Za-z0-9_.-]{1,180}\.bak$/.test(manifest.backupFile)) {
    throw new SchoolResetError('The backup manifest contains an invalid file name.');
  }
  const hostBackupPath = path.join(artifactsDirectory, manifest.backupFile);
  const documentBackupDirectory = path.join(artifactsDirectory, 'documents');
  const containerName = resolveDockerContainer(configuration.database.port);
  const serverBackupPath = manifest.serverBackupPath;
  if (typeof serverBackupPath !== 'string' || !serverBackupPath.startsWith('/var/opt/mssql/')) {
    throw new SchoolResetError('The backup manifest contains an invalid SQL Server backup path.');
  }
  return { hostBackupPath, serverBackupPath, documentBackupDirectory, containerName };
}

async function verifyRecordedBackup({ sourcePool, manifest, paths, fileSystem = fs }) {
  const backupStat = fileSystem.lstatSync(paths.hostBackupPath);
  const fingerprint = fingerprintFile(paths.hostBackupPath, fileSystem);
  if (!backupStat.isFile() || backupStat.isSymbolicLink() || (backupStat.mode & 0o077) !== 0
    || fingerprint.size !== Number(manifest.backupBytes) || fingerprint.sha256 !== manifest.backupSha256) {
    throw new SchoolResetError('The owner-only host database backup no longer matches its recorded size and checksum.');
  }
  const documents = snapshotPrivateTree(paths.documentBackupDirectory, fileSystem);
  if (JSON.stringify(documents) !== JSON.stringify(manifest.documentStorage)) {
    throw new SchoolResetError('The backed-up private documents no longer match their recorded fingerprints.');
  }
  await sourcePool.request().input('backupPath', sql.NVarChar(4000), paths.serverBackupPath)
    .query('RESTORE VERIFYONLY FROM DISK = @backupPath WITH CHECKSUM');
}

async function cleanupAndSeed({ pool, databaseName, configuration, credentials, documentDirectory, documentBackupSnapshot, backupVerified }) {
  const transaction = new sql.Transaction(pool);
  let started = false;
  try {
    const before = await readCleanupSnapshot(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    started = true;
    const cleanup = await cleanupSchoolDemoData({ pool, databaseName, configuration, backupVerified, transaction });
    const { seedSchoolData } = require('./seed-school-three-term');
    const seed = await seedSchoolData({ credentials, runtime: configuration, transaction });
    await transaction.commit();
    started = false;
    const after = await readCleanupSnapshot(pool);
    if (after.staffFingerprint !== before.staffFingerprint || after.staffSessionFingerprint === before.staffSessionFingerprint
      || exactCount(after.counts?.students) !== 320
      || exactCount(after.markerCounts?.reset) !== 1) {
      throw new SchoolResetError('The reset and seed completed, but post-commit staff or dataset verification failed.');
    }
    const removedDocuments = cleanup.alreadyClean ? { removedFiles: 0, removed: [], unclassifiedFiles: [],
      preservedScaffolding: [], userAttestation: USER_ATTESTED_PRIVATE_FILE_NOTE }
      : removeReplacedDemoDocuments({ storageDirectory: documentDirectory,
        documentInventory: cleanup.removedDocumentInventory || [],
        teacherSubmissionInventory: cleanup.removedTeacherSubmissionInventory || [],
        completedE2e: cleanup.removedCompletedE2e,
        expectedStorageSnapshot: documentBackupSnapshot });
    return { cleanup, seed, removedDocuments, after };
  } catch (error) {
    if (started) {
      try { await transaction.rollback(); } catch { /* Keep the original operation error. */ }
    }
    throw error;
  }
}

async function verifyCleanupRollback({ pool, databaseName, configuration }) {
  await assertNoOtherDatabaseSessions(pool);
  const before = await readCleanupSnapshot(pool);
  const transaction = new sql.Transaction(pool);
  let started = false;
  try {
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    started = true;
    const cleanup = await cleanupSchoolDemoData({ pool, databaseName, configuration, backupVerified: true, transaction });
    if (cleanup.alreadyClean) throw new SchoolResetError('The rehearsal restore no longer matches the legacy rows needed to test cleanup rollback.');
    await transaction.rollback();
    started = false;
  } catch (error) {
    if (started) {
      try { await transaction.rollback(); } catch { /* Preserve the rollback rehearsal error. */ }
    }
    throw error;
  }
  const after = await readCleanupSnapshot(pool);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new SchoolResetError('The isolated cleanup rollback changed database rows or staff session versions.');
  }
  return true;
}

async function runRehearsal({ sourcePool, configuration = environment, storageDirectory = environment.upload?.storageDirectory,
  backupRoot = resolveBackupArtifactRoot(process.env.ARKTIESIIS_DEMO_BACKUP_ROOT || undefined),
  runDocker = execFileSync, fileSystem = fs, now = new Date() } = {}) {
  const sourcePrivateFiles = snapshotPrivateTree(storageDirectory, fileSystem);
  const backup = await backupDatabaseAndDocuments({ sourcePool, configuration, storageDirectory, backupRoot, runDocker, fileSystem, now });
  const rehearsal = await restoreIsolatedCopy({ sourcePool, backup, configuration, now, runDocker });
  const artifactsDirectory = backup.artifactsDirectory;
  const rehearsalDocumentDirectory = path.join(artifactsDirectory, 'rehearsal-documents');
  try {
    copyPrivateTree(backup.documentBackupDirectory, rehearsalDocumentDirectory, fileSystem);
    const privateAssetPlan = classifyPrivateDemoAssets({
      documentInventory: backup.sourceSnapshot.documentInventory,
      teacherSubmissionInventory: backup.sourceSnapshot.teacherSubmissionInventory,
      completedE2e: backup.sourceSnapshot.completedE2e,
      expectedStorageSnapshot: backup.documentStorage
    });
    if (privateAssetPlan.issues.length) {
      throw new SchoolResetError(`Private demo-file provenance did not match the paired backup: ${privateAssetPlan.issues.join('; ')}.`);
    }
    await verifyCleanupRollback({ pool: rehearsal.pool, databaseName: rehearsal.databaseName,
      configuration: { ...configuration, database: { ...configuration.database, database: rehearsal.databaseName } } });
    const { loadOrCreateCredentials } = require('./seed-school');
    const credentials = await loadOrCreateCredentials({ smtpUser: configuration.smtp.user,
      filePath: path.resolve(PROJECT_ROOT, '.env.school-demo') });
    const runtime = { ...configuration, database: { ...configuration.database, database: rehearsal.databaseName } };
    const result = await cleanupAndSeed({ pool: rehearsal.pool, databaseName: rehearsal.databaseName,
      configuration: runtime, credentials, documentDirectory: rehearsalDocumentDirectory,
      documentBackupSnapshot: backup.documentStorage, backupVerified: true });
    if (JSON.stringify(result.removedDocuments.removed) !== JSON.stringify(privateAssetPlan.removals)
      || JSON.stringify(result.removedDocuments.unclassifiedFiles) !== JSON.stringify(privateAssetPlan.unclassifiedFiles)) {
      throw new SchoolResetError('The isolated reset removed a different private-file set than the paired-backup provenance plan.');
    }
    const sourceAfter = await readCleanupSnapshot(sourcePool);
    const privateFilesAfter = snapshotPrivateTree(storageDirectory, fileSystem);
    if (JSON.stringify(sourceAfter) !== JSON.stringify(backup.sourceSnapshot)
      || JSON.stringify(privateFilesAfter) !== JSON.stringify(sourcePrivateFiles)) {
      throw new SchoolResetError('The isolated rehearsal changed the configured source database or original private documents.');
    }
    const { manifestPath } = backup;
    let manifest;
    try { manifest = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8')); } catch {
      throw new SchoolResetError('The paired backup manifest could not be reopened after rehearsal.');
    }
    manifest.rehearsal = {
      verified: true, databaseName: rehearsal.databaseName, completedAt: new Date().toISOString(),
      resetApplied: !result.cleanup.alreadyClean, seedVersion: require('./seed-school-three-term').SEED_VERSION,
      preservedStaff: 18, staffFingerprint: result.after.staffFingerprint,
      staffSessionFingerprintBefore: backup.sourceSnapshot.staffSessionFingerprint,
      staffSessionFingerprintAfterRotation: result.after.staffSessionFingerprint,
      databaseBackupSha256: manifest.backupSha256,
      restoredSnapshotMatched: true, cleanupRollbackVerified: true, seedCounts: result.seed.counts,
      privateFileCleanup: {
        removedFiles: result.removedDocuments.removed,
        unclassifiedFiles: result.removedDocuments.unclassifiedFiles,
        preservedScaffolding: result.removedDocuments.preservedScaffolding,
        userAttestation: result.removedDocuments.userAttestation
      }
    };
    writePrivateManifest(manifestPath, manifest, fileSystem);
    return { backup, rehearsalDatabase: rehearsal.databaseName, manifestPath, seedCounts: result.seed.counts,
      documentFilesCopied: backup.copiedDocumentFiles, rehearsalPrivateFilesRemoved: result.removedDocuments.removedFiles };
  } finally {
    await rehearsal.pool.close();
  }
}

async function applyFromRehearsalEvidence({ sourcePool, evidencePath, configuration = environment,
  storageDirectory = environment.upload?.storageDirectory, backupRoot = resolveBackupArtifactRoot(process.env.ARKTIESIIS_DEMO_BACKUP_ROOT || undefined),
  runDocker = execFileSync, fileSystem = fs } = {}) {
  assertLocalDatabase(configuration, SOURCE_DATABASE);
  const { manifest, artifactsDirectory } = readPrivateManifest(evidencePath, safeDirectory(backupRoot), fileSystem);
  if (manifest.sourceDatabase !== SOURCE_DATABASE) throw new SchoolResetError('The backup was not captured from configured local V2.');
  if (manifest.privateFileAttestation?.note !== USER_ATTESTED_PRIVATE_FILE_NOTE
    || JSON.stringify(manifest.privateFileAttestation?.files) !== JSON.stringify(USER_ATTESTED_PRIVATE_FILE_DISPOSALS)
    || manifest.rehearsal?.verified !== true || manifest.rehearsal?.cleanupRollbackVerified !== true
    || !Array.isArray(manifest.rehearsal?.privateFileCleanup?.removedFiles)
    || !Array.isArray(manifest.rehearsal?.privateFileCleanup?.unclassifiedFiles)
    || manifest.rehearsal.privateFileCleanup.unclassifiedFiles.length !== 0) {
    throw new SchoolResetError('The reviewed rehearsal must verify rollback and the exact classified private-file cleanup before active apply.');
  }
  const before = await readCleanupSnapshot(sourcePool);
  if (JSON.stringify(before) !== JSON.stringify(manifest.sourceSnapshot)) {
    throw new SchoolResetError('Configured V2 changed after rehearsal; the reviewed backup cannot be applied to a different source snapshot.');
  }
  const docsBefore = snapshotPrivateTree(storageDirectory, fileSystem);
  if (JSON.stringify(docsBefore) !== JSON.stringify(manifest.documentStorage)) {
    throw new SchoolResetError('Configured private documents changed after rehearsal; active reset refused.');
  }
  const privateAssetPlan = classifyPrivateDemoAssets({ documentInventory: before.documentInventory,
    teacherSubmissionInventory: before.teacherSubmissionInventory, completedE2e: before.completedE2e,
    expectedStorageSnapshot: docsBefore });
  if (privateAssetPlan.issues.length || privateAssetPlan.unclassifiedFiles.length
    || JSON.stringify(privateAssetPlan.removals) !== JSON.stringify(manifest.rehearsal.privateFileCleanup.removedFiles)) {
    throw new SchoolResetError('Configured private files no longer match the reviewed exact removal inventory; active reset refused.');
  }
  await assertNoOtherDatabaseSessions(sourcePool);
  const paths = backupDetailsFromManifest({ manifest, artifactsDirectory, configuration });
  await verifyRecordedBackup({ sourcePool, manifest, paths, fileSystem });
  const { loadOrCreateCredentials } = require('./seed-school');
  const credentials = await loadOrCreateCredentials({ smtpUser: configuration.smtp.user,
    filePath: path.resolve(PROJECT_ROOT, '.env.school-demo') });
  const result = await cleanupAndSeed({ pool: sourcePool, databaseName: SOURCE_DATABASE,
    configuration, credentials, documentDirectory: storageDirectory,
    documentBackupSnapshot: manifest.documentStorage, backupVerified: true });
  return { seedCounts: result.seed.counts, removedPrivateFiles: result.removedDocuments.removedFiles,
    preservedStaff: 18, staffFingerprint: result.after.staffFingerprint, sourceDatabase: SOURCE_DATABASE };
}

async function main(args = process.argv.slice(2)) {
  let sourcePool;
  try {
    const { mode, evidencePath } = parseOptions(args);
    assertLocalDatabase(environment, environment.database.database);
    sourcePool = await getPool();
    if (mode === 'dry-run') {
      const snapshot = await readCleanupSnapshot(sourcePool);
      const privateFiles = snapshotPrivateTree(environment.upload?.storageDirectory);
      const privateAssets = classifyPrivateDemoAssets({ documentInventory: snapshot.documentInventory,
        teacherSubmissionInventory: snapshot.teacherSubmissionInventory, completedE2e: snapshot.completedE2e,
        expectedStorageSnapshot: privateFiles });
      const issues = [...validateCleanupSnapshot(snapshot), ...privateAssets.issues,
        ...privateAssets.unclassifiedFiles.map((file) => `private file has no cleanup provenance: ${file.path}`)];
      process.stdout.write(`${JSON.stringify({ mode, eligible: issues.length === 0, issues, counts: snapshot.counts,
        roles: snapshot.roleCounts, privateAssets }, null, 2)}\n`);
      if (issues.length) process.exitCode = 2;
      return;
    }
    if (mode === 'backup') {
      const backup = await backupDatabaseAndDocuments({ sourcePool });
      process.stdout.write(`${JSON.stringify({ mode, artifactsDirectory: backup.artifactsDirectory,
        backupBytes: backup.backupBytes, backupSha256: backup.sourceSnapshot ? fingerprintFile(backup.hostBackupPath).sha256 : null,
        copiedPrivateFiles: backup.copiedDocumentFiles, manifestPath: backup.manifestPath }, null, 2)}\n`);
      return;
    }
    if (mode === 'rehearse') {
      const rehearsal = await runRehearsal({ sourcePool });
      process.stdout.write(`${JSON.stringify({ mode, rehearsalDatabase: rehearsal.rehearsalDatabase,
        artifactDirectory: rehearsal.backup.artifactsDirectory, manifestPath: rehearsal.manifestPath,
        backupBytes: rehearsal.backup.backupBytes, backupSha256: fingerprintFile(rehearsal.backup.hostBackupPath).sha256,
        documentsCopied: rehearsal.documentFilesCopied, rehearsalPrivateFilesRemoved: rehearsal.rehearsalPrivateFilesRemoved,
        seedCounts: rehearsal.seedCounts }, null, 2)}\n`);
      return;
    }
    const result = await applyFromRehearsalEvidence({ sourcePool, evidencePath });
    process.stdout.write(`${JSON.stringify({ mode, ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof SchoolResetError ? error.message : 'School demo reset operation failed. No unmatched records are authorized for cleanup.'}\n`);
    process.exitCode = 1;
  } finally {
    if (sourcePool) {
      try { await sourcePool.close(); } catch { /* Do not expose connection details. */ }
    }
  }
}

module.exports = {
  SOURCE_DATABASE,
  BASE_SEED,
  DOCUMENT_SEED,
  RESET_MARKER,
  REHEARSAL_DATABASE,
  SchoolResetError,
  parseOptions,
  assertLocalDatabase,
  validateCleanupSnapshot,
  readCleanupSnapshot,
  backupDatabaseAndDocuments,
  restoreIsolatedCopy,
  cleanupSchoolDemoData,
  cleanupAndSeed,
  verifyCleanupRollback,
  runRehearsal,
  applyFromRehearsalEvidence,
  readPrivateManifest,
  safeDirectory,
  snapshotPrivateTree,
  copyPrivateTree,
  removeReplacedDemoDocuments,
  classifyPrivateDemoAssets,
  USER_ATTESTED_PRIVATE_FILE_DISPOSALS,
  USER_ATTESTED_PRIVATE_FILE_NOTE
};

if (require.main === module) main();
