# ARKTIESIIS

**ARKTIESIIS: A Web-Based Information Management System with AI-Assisted Document Validation**

Starter repository for the thesis system of Ark Technological Institute Education System Incorporated - Lucena Branch.

## Stack
- Node.js + Express.js
- EJS / HTML / CSS / JavaScript
- Microsoft SQL Server
- Local Tesseract OCR and Poppler PDF utilities
- Email-based two-factor authentication

## Important terminology
The thesis may use the phrase **AI-based document verification**, but the implemented AI scope is limited to OCR-assisted document completeness and format/compliance checks. It does not perform forensic authenticity or fraud detection.

## Quick start

1. Install Node.js 20+, Docker Engine, and Docker Compose V2. On Fedora, install and start the packaged engine and Compose plugin:

   ```bash
   sudo dnf install moby-engine docker-compose
   sudo systemctl enable --now docker
   docker compose version
   ```

   If Docker reports a socket permission error, use `sudo` for Docker commands or add your account to the `docker` group and sign in again. Docker group membership grants root-equivalent access.

2. Copy `.env.example` to `.env`. Review Microsoft's SQL Server license terms, then set `ACCEPT_EULA=Y` in `.env`. Set `DB_PASSWORD` to a unique local password; on Linux, generate one with `printf 'Ark_%s\n' "$(openssl rand -hex 24)"` and paste the result into `.env`. `.env` is ignored by Git.

3. Install the locked package versions:

```bash
npm ci
```

4. Start the local SQL Server 2022 Developer container for development and testing only. Developer edition is not licensed for production; a production deployment must use an edition and license that permit its workload. Its port is published only on `127.0.0.1`; its data persists in the `sqlserver_data` Docker volume:

```bash
docker compose up -d sqlserver
docker compose logs -f sqlserver
```

Wait for SQL Server to report that it is ready, then press Ctrl+C to leave the log view. This does not stop the container.

5. Initialize a fresh database and apply any pending numbered migrations:

```bash
npm run db:setup
npm run db:check
```

`db:setup` runs the one-time baseline only when `ARKTIESIIS` does not exist. For an existing initialized database, it applies only unapplied migration scripts. It refuses to rerun the baseline if the database is missing its migration history or baseline marker. See [database/README.md](database/README.md) for the forward-only migration policy and recovery guidance.

6. Configure `SMTP_HOST` and the matching SMTP port/security settings, `SMTP_FROM`, and both SMTP credentials when required by the mail server before using email-based sign-in. Database setup does not require SMTP. The explicit development password-only bypass is described below.

7. Create the first database administrator from a private interactive terminal:

```bash
npm run admin:bootstrap
```

The command prompts for the administrator's email, name, and password. Password input is not echoed or accepted as a command-line argument. It creates the account only when no `database_admin` exists, and writes the user, staff profile, and audit event in one transaction.

8. Start the development server:

```bash
npm run dev
```

9. Open:

```text
http://localhost:3000
```

10. Check database connectivity while the server is running:

```text
http://localhost:3000/health
```

The server checks the database before opening its HTTP listener. `/health` returns `200` when SQL Server responds and `503` when the database is unavailable; it does not include database error details.

## Phase 2 and 3 authentication

Outside the explicit development bypass, a correct password starts email two-factor authentication. Set `SMTP_HOST` and the matching SMTP port/security settings, `SMTP_FROM`, and both SMTP credentials when required by the mail server. A cryptographically generated six-digit code expires after five minutes; only its bcrypt hash is stored. Verification allows five attempts per account every 15 minutes. Code sends are limited to three per account every 15 minutes with a 30-second cooldown; a new code invalidates the previous one. If SMTP is not configured, sign in fails closed.

Password-only login is available only when both `NODE_ENV=development` and `DEV_PASSWORD_ONLY_LOGIN=true`. That path is denied in production and test environments. Protected requests re-check the account's active status and role in SQL Server.

## Phase 4 database administration

Only active `database_admin` accounts can use `/admin`. Administrators can search accounts by email or student number, create and update user accounts, assign the approved roles, activate or deactivate accounts, reset passwords, and view the latest 100 audit events. Account/profile changes and their audit events are committed together. At least one active database administrator must remain, and an administrator cannot demote or deactivate their own account. Account changes invalidate older sessions; changing your own email or password signs out that session, and password resets also invalidate pending email sign-in codes. Passwords and raw audit details are not shown in the administration screens.

Staff accounts use `staff_profiles`; administrator account creation/editing supports registrar, teacher, finance, and database administrator roles. A student login can only be attached to an existing unlinked `students` record by student number. Changing a student account to a staff role clears that login link and preserves the student record and its academic history. Student record creation and editing remain in Phase 5. Existing databases need no Phase 4 migration.

## Finance workspace

Active `finance` and `database_admin` accounts can use `/finance`; students and registrars are denied. Finance staff and database administrators can search by student number or name (up to 100 results), open an existing financial account, or explicitly create one. Account pages show the student's finance identifiers, balance, and up to 100 latest transactions without academic records.

Charges and payments require a positive PHP amount; charges increase the balance and payments decrease it. Adjustments accept a nonzero positive or negative PHP amount and require a description explaining the reason. All amounts allow up to two decimal places within the `DECIMAL(12,2)` limit. Negative balances represent credits. Account creation, transaction insertion, balance updates, and audit events use serializable database transactions and commit together. A nonempty reference number can be used once per account after trimming; duplicate matching follows the SQL Server database collation, while reuse on another account is allowed. Existing databases need no Phase 7 migration because the baseline already includes the required financial tables.

Database administrators can archive a student record after typing its student number to confirm. The operation keeps academic and finance history, marks the record archived, disables its linked student login, and consumes pending sign-in codes. Registrars can disable a linked student login separately; they cannot archive the master record. Archived profiles cannot be edited or receive new enrollments.

## Development demo data

Preview and seed clearly labeled sample records using the guarded development-only script:

```bash
npm run demo:seed -- --dry-run
npm run demo:seed -- --apply
```

Both commands require `NODE_ENV=development`; database writes require the explicit `--apply` flag. `SMTP_USER` must be a valid Gmail or Googlemail address so the script can derive separate plus-address aliases. On first apply, random passwords and aliases are saved in ignored `.env.demo` with owner-only permissions and are never printed. The seed includes three fake students, demo academic records, and a matching finance ledger. It creates no documents or OCR records. Re-running after a successful seed adds nothing; conflicting pre-existing demo keys abort the transaction without changing existing data. See [scripts/README.md](scripts/README.md).

## Document management

Students can upload and retrieve Good Moral Certificates and PSA birth certificates only for their own linked record. Students cannot read report cards, including historical rows. Existing report-card rows remain in the database as a staff-only archive for registrars and database administrators; new report-card uploads, corrections, student listing, and OCR are blocked. Registrars and database administrators continue to upload Good Moral Certificates and PSA birth certificates for student records. Students may view and download their own student-uploaded PSA submissions and staff-uploaded PSA files. Students can re-upload a PSA only when they originally submitted it and staff requested a correction; correction instructions and reasons for staff-uploaded PSA files remain staff-only. Form 137 uses a physical status history (pending, received, verified, correction, or rejected). Authorized staff may send a scan of the physical paper to the server for temporary local OCR suggestions; the temporary file is deleted after processing, and the scan and OCR text are not retained as a document or database record. Only the human-recorded status and instruction are saved. Historical Form 137 files remain staff-only. Staff must inspect each permitted digital source file and manually verify, request correction, or reject it. OCR suggestions are advisory and cannot set a digital document to valid. Finance accounts have no document access. Downloads recheck the current role and student ownership, and persistent files are kept in private `storage/uploads` by default (`DOCUMENT_STORAGE_DIR` can override it). `MAX_UPLOAD_MB` configures the size limit and defaults to 10 MB as a technical default, not an institution policy. Corrected permitted uploads create a new submission linked to the earlier document; no retention period or automatic deletion is configured.

## Teacher grade submissions

Active teachers receive term-specific assignments from a registrar or database administrator. Each active assignment fixes one academic term, section, and subject; teachers can open only those class contexts and their currently enrolled rosters. The teacher uploads one corrected SSHS E-Class Record workbook for SY 2026–2027 per assigned context. The application validates the workbook and shows the roster/grade preview before the teacher submits it. Submission stores the original XLSX privately and preserves the parsed preview and immutable status history; it does not write grades.

The registrar reviews the pending workbook, preview, and conflicts. Approval rechecks the assignment, active student/enrollment/subject identities, current roster, and every grade snapshot in one serializable transaction before writing any grades. Existing grades are replaced only after the registrar supplies a reason. Students see imported grades only after approval. A correction request allows a teacher to submit a new revision; rejection closes that submission. A deactivated teacher cannot access or revise the workbook, while an active registrar can still finish review of a pending snapshot if its assignment remains active. Revoked assignments block approval. Original workbooks are retained in private storage and downloadable only by the registrar and owning active teacher while the assignment remains active. Database administrators can manage assignments but do not have workbook review/download access. Migration `009_teacher_grade_submissions.sql` adds the assignment, submission, snapshot, and history tables, extends the teacher role, and stores term/filename context for previews. No automatic retention/deletion policy is configured.

### Local document OCR

Install Tesseract with English language data and Poppler utilities (`pdfinfo` and `pdftoppm`) on the server. See the [official Tesseract installation guide](https://github.com/tesseract-ocr/tessdoc/blob/main/Installation.md). Set `TESSERACT_PATH`, `PDFINFO_PATH`, and `PDFTOPPM_PATH` in `.env` if they are not on `PATH`; executable paths may contain spaces. The worker uses `OCR_LANGUAGE=eng`, a 60-second bounded timeout, and two concurrent jobs by default. It handles up to 20 PDF pages per submission (`OCR_MAX_PDF_PAGES` can lower that limit), renders one page at a time, and runs in the background after upload. `OCR_TIMEOUT_MS` accepts 1–120 seconds, `OCR_CONCURRENCY` accepts 1–4 workers, and `OCR_MAX_PDF_PAGES` accepts 1–20. OCR output and advisory suggestions for stored digital documents are available only to registrars and database administrators. Form 137 physical scans use the same local tools in a bounded temporary workflow; only bounded advisory snippets appear in a private no-store response, and the scan file and extracted OCR text are not persisted. Staff must inspect the paper original and record status manually. Digital documents remain `needs_review` until staff inspect the source; only a manual staff verification sets the status to `valid`. OCR does not classify documents or determine authenticity.

Phase 9's native runtime acceptance check is a real `npm run ocr:smoke` on the local Linux environment with installed Tesseract, English trained data, and Poppler. Windows path-handling tests use mocked command results and establish compatibility for executable paths with spaces; they do not establish live OCR availability or replace the Linux run. `windows-ocr-test-report.md` is historical compatibility evidence from an earlier Windows checkout.

To check an installed native runtime against synthetic image and PDF samples on Linux, configure the executable paths if needed and run `npm run ocr:smoke`. The command verifies extracted phrases, two-page order, and private temporary-file cleanup without using SQL Server. The smoke test does not exercise authenticated upload or Form 137 routes. Windows executable-path behavior is covered by a mocked unit test; a historical Windows smoke report is retained for reference.

See [scripts/README.md](scripts/README.md) for smoke-test scope and [HANDOFF_PROMPT.md](HANDOFF_PROMPT.md) for the supplemental Windows compatibility check.

## Current starter status
This repository contains the project foundation, email authentication, database administration, student and academic records, the Phase 7 finance workspace, document management, local OCR, advisory document review, and teacher grade-workbook submission/review. Migration 009 has been applied and verified against the configured local SQL Server with `npm run db:check`. Teacher submission, registrar review, and grade writes are covered by service/HTTP tests with SQL doubles; no live grade submission or approval was run against the configured database. The thesis implementation gates for Phases 8–10 are complete; Phase 9 included a real Linux OCR smoke and a synthetic/in-memory service integration check, which did not exercise live SQL Server or the authenticated route end to end. The separate school-adoption gate remains pending institution signoff before deploying school policy.

### Planned deployment target (Phase 15)

The future deployment runbook targets a Hostinger KVM 2 VPS with the plain Ubuntu 22.04 image, Node.js 20+, the existing Express/EJS application, local Tesseract/Poppler, private persistent uploads, and a production-licensed SQL Server edition. SQL Server 2022 requires CU 10 or later for Ubuntu 22.04 ([Microsoft support details](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-whats-new-2022?view=sql-server-ver17)). The local SQL Server Developer container is for development/testing only, not production. Provisioning and deployment are deferred to Phase 15; see [the phase plan](docs/08-phase-8-to-15-goal-plan.md).

## Recommended workflow with Codex
Start with the content of `CODEX_START_PROMPT.md`.

Use one phase at a time, test it, then commit it before moving to the next phase.
