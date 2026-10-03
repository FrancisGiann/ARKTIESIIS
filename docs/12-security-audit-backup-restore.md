# Phase 12 — Security Audit and Backup/Restore Runbook

## Audit scope and result

This is a repository-level review of the current Node.js, Express, EJS, SQL Server, session, and private document-storage paths. It is not a penetration test, a production configuration review, or institution signoff. The application remains a thesis implementation and must be rechecked against the eventual deployment topology.

One response-caching gap was fixed: successful authenticated requests now receive `Cache-Control: private, no-store` in `src/middleware/auth.js`. A regression assertion covers this header in `tests/smoke.test.js`.

## Finding inventory

| ID | Finding | Status and evidence |
| --- | --- | --- |
| SEC-01 | Authenticated HTML responses did not explicitly prevent caching. | **Fixed in this phase.** Auth middleware now sets `private, no-store`; the smoke test checks the dashboard response header. |
| SEC-02 | The default `express-session` in-memory store loses sessions on restart and cannot share sessions between app workers. | **Open before production.** The current single-process development setup is covered; persistence, multi-worker behavior, and production session-store operations are not. Select and test a maintained production store for the deployment topology. |
| SEC-03 | Express proxy trust is not configured. | **Open before reverse-proxy deployment.** With TLS terminated upstream, Express may not see the request as secure and may omit the production Secure cookie. Trusting forwarded headers too broadly can also weaken IP-based controls. Configure only the verified proxy hops and test cookie and spoofed-header behavior. |
| SEC-04 | The example SQL settings disable transport encryption and trust the server certificate. | **Open before production.** They are development defaults only. Enable SQL Server encryption and certificate validation with deployment-managed settings and a valid certificate. |
| SEC-05 | School-approved document, audit, and backup retention periods are not specified. | **Open for institutional operations.** Obtain the approved schedule and authorized operator responsibilities before production; this phase does not invent policy. |
| SEC-06 | Coordinated database and file-storage backup/restore has not been exercised. | **Pending Phase 15.** This document provides a procedure, but no backup or restore was run. A successful isolated restore drill is still required before deployment readiness can be claimed. |
| SEC-07 | Authentication and denied-access outcomes are not written to the audit log. | **Open for production operations.** Rate-limit counters and OTP state exist, but they are not a durable security-event trail. Define which events, minimized identifiers, access controls, and retention are approved before adding persistent authentication logging. |
| SEC-08 | The per-IP login and OTP route limits use the limiter's in-process default store. | **Open for multi-worker production.** Limits reset on restart and are not shared between workers; OTP also has database-backed per-account limits. Select and test shared per-IP limit storage after the proxy/IP trust boundary is known. |

No additional code changes were made because the remaining findings require a deployment topology or institutional logging/retention decisions that are not established in this phase. This is a scoped source review and local test gate, not a penetration test, a production readiness approval, or evidence that the open findings are resolved.

## Controls inspected

- **Authentication and sessions:** passwords use bcrypt; production requires a configured session secret; password-only login is development-gated; email OTP values are random, hashed, expiring, throttled, and atomically consumed. Successful authentication regenerates the session. The authenticated request reloads the active user and checks a keyed fingerprint of role, password hash, and account update time. Session cookies are HttpOnly, SameSite=Lax, and Secure in production.
- **Authorization and ownership:** protected workspace routes use `requireAuth` and server-side role middleware. Services recheck active roles for sensitive writes. Student profile, grade, document, and file reads are tied to the account-to-student link. Staff document, academic, finance, and administrator operations use their existing role boundaries. Student and staff Form 137 behavior follows the current implementation matrix.
- **CSRF and input validation:** state-changing HTML routes validate the session CSRF token. IDs, search strings, student/profile fields, academic inputs, finance amounts, decision text, and uploaded workbook/document metadata are validated server-side. SQL values use bound parameters.
- **Rate limits:** login and OTP routes have per-IP limits; OTP issuance and verification attempts also have database-backed per-account limits. The per-IP limiter store is process-local in the current configuration; see SEC-08.
- **Files and document processing:** uploads have configured size limits and extension, declared MIME, and signature checks. Stored names are random UUIDs; storage is rejected under `public`; directories and files are created with owner-only modes, enforced on POSIX. Download handlers recheck current role and ownership, validate stored names, use no-follow opens where the platform supports them, and set private/no-store, attachment, and nosniff headers. Form 137 scans are transient, staff-only, and marked no-store. OCR uses local utilities, bounded pages, timeouts, and worker concurrency; it is advisory and does not make authenticity claims.
- **Auditing:** account changes, academic changes, finance account/ledger writes, digital document upload/re-upload/review decisions, Form 137 status changes, and grade-import confirmation write audit rows with their mutations. The recorded details are bounded to identifiers, action/status, and other workflow metadata; document bytes, extracted text, secrets, and Form 137 instructions are not included. The administrator audit view searches actor/action/record text, filters known record categories, pages 25 events at a time in stable newest-first order, displays time in Asia/Manila, and omits raw `details_json`. Authentication outcomes and denied-access events are not persisted; see SEC-07.
- **Errors and rendered output:** route handlers return fixed safe messages for unexpected failures. The final error middleware does not expose exception messages or stacks for server errors. EJS output uses escaped interpolation for database and user-provided text. Cleanup failures use a fixed log message.
- **Configuration and secrets:** `.env` and `.env.*` are ignored by Git except `.env.example`; the tracked example contains placeholders. Production must provide a unique session secret and deployment secrets outside the repository. Local SQL defaults in `.env.example` (`DB_ENCRYPT=false`, `DB_TRUST_SERVER_CERTIFICATE=true`) are development settings and are not production guidance.

The automated suite covers the role and ownership boundaries, CSRF-protected writes, upload validation and private file delivery, audit behavior, OTP controls, and safe failure handling. `npm run db:check` verified the connected development database and migrations 001–008 during this phase.

## Items still required before deployment

- `express-session` currently uses its default in-memory store. It is suitable only for the current single-process prototype; sessions are lost at restart and are not shared across app workers. Select and configure a maintained production session store, then test expiry, logout, account-change invalidation, and multi-worker behavior before production. No new package or session-table migration was added in this phase.
- The app does not configure Express proxy trust. If deployment terminates TLS at a reverse proxy, configure trust for the actual proxy hop count so Secure cookies work, and verify spoofed forwarding headers cannot bypass IP-based controls. Do not use blanket `trust proxy = true` without a reviewed network boundary.
- Align the login/OTP per-IP rate-limit store with the production worker topology and trusted client-IP configuration. The current in-process counters are not a shared production limit store.
- Decide whether authentication and denied-access outcomes need a persistent security-event log. If approved, minimize personal/network identifiers and define authorized access and retention before recording them.
- Configure production SQL Server transport encryption and certificate validation. Keep the database off the public network and use a least-privilege application login instead of the local `sa` development account.
- The application does not define a school-approved retention period for documents or audit logs. Confirm retention, backup retention, and authorized restore operators before school deployment.
- This runbook has not been exercised against production storage or a production SQL Server. The restore drill remains pending for Phase 15.

## Coordinated backup procedure

Back up the database and private document tree as a coordinated set. A SQL backup alone cannot restore uploaded files, and a file archive alone cannot restore document ownership or audit history. Since the application has no cross-store snapshot transaction, stop application writes and the OCR worker before taking both copies.

1. Confirm the target SQL Server version/edition, a private backup path on an approved encrypted volume, the private upload directory from `DOCUMENT_STORAGE_DIR`, and access to an approved encrypted archive destination. If SQL Server native backup encryption is used, include the separately escrowed certificate/key recovery procedure in the restore drill. Use the deployment's secret manager for database and SMTP credentials; do not place `.env` or secrets in the archive.
2. Stop the app service and wait until requests and OCR work have drained. Confirm no second app worker or scheduled process can write documents or database rows during the backup window.
3. From an authorized SQL Server administrative connection, back up `ARKTIESIIS` to the private encrypted volume at a path visible to the SQL Server service account. Substitute a unique path:

   ```sql
   BACKUP DATABASE [ARKTIESIIS]
     TO DISK = N'<private-backup-path>/ARKTIESIIS_<timestamp>.bak'
     WITH COPY_ONLY, CHECKSUM, STATS = 10;
   ```

4. Archive the configured private upload directory to the approved encrypted backup destination. Preserve opaque stored filenames and timestamps. Create a SHA-256 manifest for the archive and protect the manifest with the archive. Do not put the archive in the repository, the public web directory, or a user-accessible download location.
5. Run `RESTORE VERIFYONLY ... WITH CHECKSUM` against the database backup and verify the archive and manifest checksums. This checks the backup artifact but does not replace a real restore drill.
6. Record the backup timestamp, source database/server, migration version, storage directory, archive and database-backup checksums, operator, and any failures in the approved operations record. Resume the app and OCR worker after both copies are complete.

Do not invent a retention period. Apply the institution-approved backup retention and deletion schedule once one exists.

## Isolated restore drill

Restore to a separate test SQL Server instance and a separate private filesystem path. Never use `WITH REPLACE` against the only live database as part of this drill.

1. Provision or select an isolated SQL Server instance compatible with the backup. Copy the backup to a path readable by that instance's SQL Server service account. Use `RESTORE FILELISTONLY` to obtain the logical data/log names and map them to new test paths.
2. Restore into a new isolated database named `ARKTIESIIS` (the repository setup/check tools expect that database name) without overwriting an existing database. Use `RESTORE FILELISTONLY` output for every data/log file and substitute new paths that do not already exist:

   ```sql
   RESTORE DATABASE [ARKTIESIIS]
     FROM DISK = N'<private-backup-path>/ARKTIESIIS_<timestamp>.bak'
     WITH MOVE N'<logical-data-name>' TO N'<isolated-test-path>/ARKTIESIIS.mdf',
          MOVE N'<logical-log-name>' TO N'<isolated-test-path>/ARKTIESIIS_log.ldf',
          CHECKSUM, RECOVERY, STATS = 10;
   ```

   Add a `MOVE` clause for every additional database file reported by `RESTORE FILELISTONLY`. Do not add `WITH REPLACE`; if the target database already exists, choose a fresh isolated instance or resolve it before proceeding. Run `RESTORE VERIFYONLY FROM DISK = N'<private-backup-path>/ARKTIESIIS_<timestamp>.bak' WITH CHECKSUM` as an additional artifact check.
3. Restore the upload archive into a new directory outside the test app's public tree. Confirm the directory is private (owner-only, mode `0700`) and files are owner-only (`0600`) on POSIX deployments. Configure the isolated test app's `DOCUMENT_STORAGE_DIR` to this directory; do not point it at production storage.
4. Compare the database's `documents.stored_filename` and `file_size_bytes` rows with files in the restored tree. Confirm every referenced file exists with the recorded size, and record any unreferenced files or missing rows for investigation. Do not open or copy student documents into an unsecured test area.
5. Configure the test app with isolated database settings and fresh test secrets. Run `npm run db:check`, then exercise authorized and denied role paths, private download, logout, and account-change invalidation against the restored instance. Confirm private files remain inaccessible through static HTTP paths.
6. Record the restore start/end time, SQL Server build, app/migration version, checksums, checks performed, missing-file findings, and outcome. Stop the isolated app and securely remove test copies after the approved test retention window.

`RESTORE VERIFYONLY` is not a completed restore test. No backup or restore command was run for this Phase 12 task; the isolated restore drill remains pending until Phase 15 deployment readiness work.
