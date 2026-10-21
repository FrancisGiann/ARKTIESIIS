# ARKTIESIIS Codex Instructions

## Project
ARKTIESIIS is a thesis project for Ark Technological Institute Education System Incorporated - Lucena Branch.

It is a web-based information management system with AI-assisted document validation.

## Fixed stack
- Node.js 20+
- Express.js
- EJS + HTML/CSS/JavaScript
- MariaDB (the active app database; the user approved the SQL Server-to-MariaDB port)
- Google Gemini API for bounded document-field extraction, using built-in Node.js `fetch`
- Email-based two-factor authentication

Do not replace the stack unless the user explicitly approves it.

## Main roles
- `database_admin`
- `registrar`
- `front_desk` (paper pre-enrollment only; no student master, grades, finance, documents, or account administration)
- `teacher`
- `finance`
- `student`

Enforce authorization on the server. Hiding UI buttons is never enough.

## AI scope - very important
The automated document precheck is limited to:
- visible field extraction for Good Moral, PSA, active student-uploaded previous-school report-card scans, and transient Form 137 scans
- comparison of the extracted student name with the linked student record; a local, advisory-only PSA birth-date comparison; and a local, advisory-only Good Moral issuing-school comparison with the recorded last-school source
- Good Moral certificate-context clues
- configured PDF/JPEG/PNG file-format checks

It MUST NOT claim to:
- prove document authenticity
- detect forged documents
- verify signatures
- verify seals
- perform forensic document analysis

Human review is always responsible for acceptance; the precheck never sets a digital document to `valid`.

Good Moral/PSA and active student-uploaded report-card bytes are sent to Google Gemini for the explicitly approved bounded precheck. Report-card extraction is limited to the visible student name; it must not extract grades, marks, subjects, attendance, or other academic results. Staff scan bytes for Form 137 are also sent to Gemini transiently; the app does not save these scans as files or database rows. Do not log raw bytes, extracted personal fields, API keys, or provider errors. Enforce file, request/response, timeout, and bounded worker limits. The Gemini adapter uses inline bytes and structured responses; do not add an SDK package.

For PSA, Gemini may extract only the visible student name and date of birth as written. The saved birth date is never sent to Gemini; date parsing and comparison happen locally and remain advisory. Ambiguous, partial, invalid, missing, changed-profile, historical-not-recorded, and provider-unavailable states remain distinct from a match. For Good Moral, compare the extracted issuing-school name only with the latest non-cancelled prior-school value linked through a registrar intake; preserve its intake provenance and treat missing or changed sources as unknown. School-name differences are text-review clues only and must not claim authenticity or change acceptance. Neither advisory can set a document to `valid`.

New student-origin previous-school report-card scans use the bounded worker for visible-name comparison and PDF/JPEG/PNG format checks, then require staff source inspection and a staff checklist decision. Provider failure leaves the submission reviewable; eligible transient failures may be retried within the existing limit. The precheck never writes grades. Rows marked as the pre-lifecycle archive remain read-only for staff and are excluded from processing and retry. Paper copies have a separate staff-recorded event history; neither channel is a grade source.

The former local Tesseract/Poppler service remains inactive legacy code only. It is not used by current digital-document or Form 137 workflows. Gemini worker and transient Form 137 scan concurrency limits are per Node.js process, not global across multiple instances.

## Document access rules
- Students may only access their own permitted documents.
- Students may upload Good Moral Certificates, PSA birth certificates, and scans of a previous-school report card only for their own linked student record. Students may view, preview, download, or re-upload their own student-origin scan only after staff requests a correction. Their documents page shows only the latest status/date of a separate physical paper-copy record, without staff notes. Teachers submit corrected SSHS E-Class Record workbooks for assigned term/section/subject contexts to the registrar; grades are written only after registrar approval.
- Registrar/database administrator staff can record the separate physical previous-school report-card paper-copy history. The prototype statuses are pending, received, verified, correction, and rejected; this vocabulary and what each means require school review before production use. The staff history never writes grades.
- Pre-lifecycle report-card archive rows remain staff-only and read-only. A student cannot access them, including through a guessed document URL. Staff can inspect, preview, and download archive rows, but cannot decide, correct, or delete them.
- Students may view/download their own PSA submissions and staff-uploaded PSA files, and may re-upload only a student-origin PSA after staff requests a correction. Staff-origin PSA correction instructions and reasons remain staff-only.
- Form 137 is restricted to authorized staff such as registrar/database admin.
- Database admin may oversee stored documents and validation results.
- Registrar may manage academic records and review permitted documents.
- Finance users may only access finance-related data required by their role.

## Security rules
- Never hard-code credentials or API keys.
- Use `.env` for secrets.
- Use bcrypt for passwords.
- Use parameterized SQL queries.
- Validate all input server-side.
- Validate upload MIME type, file size, and extension.
- Store uploaded files outside public web access when implementation begins.
- Regenerate sessions after successful authentication.
- Apply rate limiting to login and 2FA endpoints.
- Log important admin/registrar/finance actions.
- Do not expose raw database errors in production.

## Database baseline and migrations
- Active prototype setup uses the MariaDB baseline in `database/mariadb/schema.sql` (`v2.001`) and numbered forward-only migrations in `database/mariadb/migrations/` through `v2.025`. Migration 019 records Finance review evidence for pending annual intake and binds Registrar confirmation to the reviewed assessment and entry-term DP state while leaving historical confirmations unchanged. Migration 020 adds Finance departure tuition-cutoff and per-charge review evidence without inferring historical decisions. Migration 021 adds versioned Registrar retake referrals and reviewed Finance item decisions without rewriting existing assessment or financial history. Migration 022 adds scheduled departure application snapshots and audit evidence while preserving all prior cases and placement state. Migration 023 adds pending account setup invitations without changing existing accounts; migration 024 adds Finance assessment restatement evidence; migration 025 adds versioned school-owned enrollment requirements and per-student school-year assignments while retaining historical paper and digital evidence. Hostinger creates the database and user in hPanel; setup connects to that existing database and does not create or drop databases.
- `database/schema.sql`, `database/v2/schema.sql`, and the existing SQL Server migration files are historical archive material. Do not apply them to MariaDB or rewrite them as part of the port.
- Migration 017 adds paper-clearance templates and per-term signature/applicability evidence. Registrar records signatures from the existing printed paper form and attests after inspection. Database administrators may read history; students see only their own safe progress; front-desk staff cannot access clearance. This workflow does not use finance or document clearance events and never writes grades.
- Apply later schema changes through new, numbered, forward-only MariaDB migrations. Do not edit or rerun the baseline to update an initialized database, and do not rewrite migrations that have already been applied. Keep Form 137 restricted to authorized staff and its own workflow.

## Development workflow
For every requested phase:
1. Read the related docs and existing code first.
2. Inspect only the files needed for the task where possible.
3. Make a short implementation plan.
4. Implement the requested scope only.
5. Run checks/tests.
6. Fix errors caused by the change.
7. Review changed files for security and role access.
8. Update relevant docs if behavior changed.
9. Do not start the next phase without being asked.

## Git
- Keep changes small and reviewable.
- Do not rewrite unrelated working code.
- Do not make destructive database changes without explaining them first.
- Prefer a commit after a meaningful milestone passes tests.

## Coding style
- Keep modules small.
- Use clear names.
- Avoid unnecessary abstractions.
- Add comments only where logic is not obvious.
- Prefer simple thesis-friendly code that the proponents can explain during defense.
