# OCR-Assisted Document Validation

## Intended flow

1. The uploader selects the document type; OCR does not classify it.
2. The server checks the role, file type, and size, then saves the immutable submission privately as `pending`.
3. A background worker atomically claims pending submissions from SQL Server and changes them to `processing`.
4. Installed local Tesseract and Poppler command-line tools extract text from JPEG/PNG uploads and PDFs.
5. ARKTIESIIS records advisory OCR suggestions for linked student-name text and possible school-name lines, depending on the selected digital document type.
6. The OCR result and suggestions are attached to that immutable submission and shown only to registrar/database administrator users. Staff inspect the source file and manually verify, request correction, or reject it.
7. Form 137 follows a separate physical-paper workflow. An authorized staff member sends scan bytes to the server for local processing, receives only bounded advisory snippets in a private no-store response, and manually records the paper's status. The private temporary file is deleted after processing; the scan and OCR text do not enter document storage, validation tables, audit logs, logs, or the session.

## Local tools and runtime configuration

Install Tesseract OCR with the English language data and Poppler utilities that provide `pdfinfo` and `pdftoppm`. See the [official Tesseract installation guide](https://github.com/tesseract-ocr/tessdoc/blob/main/Installation.md). Phase 9 runtime acceptance uses real binaries on the local Linux environment. Windows executable paths may include spaces; a mocked unit test verifies they are passed to `execFile` as single arguments without a shell, but this is compatibility coverage only. Set `TESSERACT_PATH`, `PDFINFO_PATH`, and `PDFTOPPM_PATH` in the private runtime `.env` when the tools are not available on `PATH`. `OCR_LANGUAGE` defaults to `eng`.

`OCR_TIMEOUT_MS` defaults to 60 seconds and accepts 1–120 seconds. The timeout aborts the active subprocess. `OCR_CONCURRENCY` defaults to two workers and accepts one through four. `OCR_MAX_PDF_PAGES` defaults to 20 and accepts 1–20. Poppler renders one page at a time at no more than 1,800 pixels on its longest side, and each rendered page is removed after OCR. OCR output is limited to 4 MiB per submission. The Phase 8 upload size remains configurable with a 10 MB default through `MAX_UPLOAD_MB`.

Uploads remain private. OCR first copies a verified regular file to a private temporary directory, invokes local tools with argument arrays, and removes the temporary directory on success or failure. PDF pages are processed in page order. If any page cannot render or OCR, the submission fails as a whole; partial text is not saved as a completed result. Missing tools, malformed or encrypted PDFs, page-limit violations, timeouts, output-limit violations, and processing errors receive fixed safe status messages. Raw command output and SQL errors are not logged or shown.

## Advisory OCR suggestions

The current capstone leader-directed implementation suggestions check for these OCR-readable clues:

- Good Moral Certificate: linked student name and up to three possible school-name lines.
- PSA birth certificate: linked student name.
- Physical Form 137 scan: linked student name and up to three possible school-name lines.

Legacy report-card rows are excluded from active OCR processing and staff review. Existing validation history is retained in storage but is not surfaced in the staff-only archive view.

Candidate lines are bounded and HTML-escaped. “Possible” is intentional: an OCR suggestion does not confirm an institution name or document requirement. There is no school-name whitelist, grade threshold, automated OCR completeness check, format rule, or automatic acceptance. Each digital submission requires staff source inspection and a manual decision. A reason is required to verify a digital submission despite a failed OCR result or a missed advisory check. Only the manual `verified` decision sets `documents.status` to `valid`.

The linked student-name clue compares normalized first- and last-name text from the linked student record. It looks for both name parts on the same OCR line, in either order, with no more than two OCR tokens between them. This bounded text heuristic can miss names split across lines, name variants, or OCR errors, and a match still requires staff inspection. It does not establish that a document belongs to the linked student or prove document authenticity.

## Thesis source-inspection checklist

Before a registrar or database administrator records `verified`, the server requires the reviewer to attest that they inspected the source file and confirmed:

- For a Good Moral Certificate: the linked student name is visibly present and legible; school-name text is visibly present and legible; the selected document type matches the file; and every submitted page is readable and complete.
- For a PSA birth certificate: the linked student name is visibly present and legible; the selected document type matches the file; and every submitted page is readable and complete. There is no school-name checklist item for PSA.

These are thesis-owned manual review defaults. The school-name item records only that text is visible and legible; it does not verify a school's legitimacy, approve a school name, or establish document authenticity. The page item covers the pages submitted for review and does not define which pages an institution requires. OCR never fills or satisfies this checklist. The verified decision and its structured checklist, including checklist schema version 1, are written together to immutable decision history. History renders the wording defined for that stored version; an unknown version is withheld rather than reinterpreted. Migration `008_document_verification_checklist.sql` adds nullable storage, so decisions recorded before migration 008 remain unknown rather than being inferred. Only authorized staff can see checklist details. Students see operational status and correction instructions without OCR output or internal review notes.

OCR remains advisory. A missing student-name or possible-school-name clue requires the existing staff override reason before verification; an OCR failure also requires a reason. Staff may choose correction or rejection with the existing specific instruction/reason controls. The checklist does not auto-choose a correction or rejection.

Student-facing operational status text is: “Waiting for OCR,” “OCR processing,” “OCR could not process; staff review required,” “Awaiting staff review,” “Correction requested,” “Verified after staff source inspection,” and “Rejected after staff review.” These labels describe workflow events; they do not imply institution approval, document ownership, authenticity, or school-name legitimacy. The exact checklist and status wording are thesis defaults, not institution-approved policy. Institution signoff is pending before school deployment.

These advisory checks and decision controls are capstone leader implementation choices, not institutional policy. No document is accepted automatically.

Automated tests assert the SQL row-lock hints and guarded status updates and simulate OCR/manual-decision races. They do not exercise simultaneous SQL Server sessions; verify database-level concurrency in an integration environment after migration deployment.

## Status meanings

- `valid`: a registrar or database administrator completed the required thesis source-inspection checklist and recorded a manual verified decision.
- `needs_review`: OCR completed and the digital submission awaits staff source inspection, or staff requested a correction.
- `failed`: OCR processing failed; authorized staff review is still required.
- `pending` and `processing`: background work has not finished.

Form 137 status is separate from digital document status. Staff append `pending`, `received`, `verified`, `correction`, or `rejected` events for the physical document. If no staff status has been recorded, the student view says “Not recorded.” The physical paper can be sent to the server for local OCR suggestions by registrar/database administrator users. The private temporary file is deleted after processing, the multipart buffer is cleared, and neither the scan nor OCR text is saved as an uploaded document or database record. Suggestions are returned only on the staff scan response with `Cache-Control: private, no-store`; OCR failures are shown to staff and do not block a manual status decision. The status workflow creates no document or OCR validation row. Historical Form 137 files remain staff-only.

## Phase 8 document management boundary

Permitted digital document submissions are stored privately and begin with `pending` status. Students may upload Good Moral Certificates and PSA birth certificates only for their own linked student record. Students cannot access report-card rows, including historical rows. Existing report cards are retained as a staff-only archive for registrar/database administrator read/download; new report-card upload, correction, listing, OCR, and review are blocked. Students may view or download their own PSA submissions and staff-uploaded PSA files; they may re-upload only a student-origin PSA after staff requests a correction. Staff correction instructions and reasons for staff-origin PSA files remain staff-only. Form 137 has no persistent new file upload; authorized staff may send a scan of its physical paper to the server for transient local OCR suggestions, while only physical status history is stored. The temporary scan is deleted after processing. Existing Form 137 files remain staff-only. Finance users have no document access. Each corrected permitted digital upload is a new submission linked to the earlier one; OCR records, review decisions, and correction instructions remain in append-only history. Students see status and their applicable correction instructions, not OCR output or staff-only override notes. The upload limit defaults to 10 MB as a technical setting and is configurable with `MAX_UPLOAD_MB`; no school retention period or automatic deletion behavior is set for stored digital submissions.

## Phase 9 local OCR boundary

The upload response does not wait for OCR. The application schedules a pending-queue scan, and a database-backed worker also scans at startup and periodically. Pending rows are claimed atomically under SQL Server read-committed locking, so concurrent workers cannot process the same immutable submission. A bounded number of jobs run per server process. A timestamped processing lease supports recovery after a worker stops; startup and periodic recovery mark stale jobs `failed` with a safe result after the configured timeout plus a 30-second grace period.

Successful nonempty OCR and empty OCR for stored digital submissions are recorded as `needs_review`; malformed/encrypted PDFs, unavailable tools, file access failures, page-limit/output-limit violations, timeouts, and utility errors are recorded as `failed`. Each digital validation record is labeled `Tesseract OCR`. Advisory checks do not change that status to `valid`. Historical Form 137 document rows are excluded from OCR claim and recovery queues; temporary Form 137 scans bypass the persistent queue and validation table entirely. Migration `005_local_ocr_processor_default.sql` changes the database default for new validation rows while preserving the labels on existing rows.

OCR text, candidate lines, and advisory details are available only to registrars and database administrators. Students receive their permitted document status and correction instructions without extracted text or staff-only decision notes. OCR is untrusted text and is rendered with escaping. Phase 9 does not classify documents, prove authenticity, or apply institution-approved required-field, completeness, or format/compliance checks. Digital documents can become `valid` only through manual source inspection and staff verification.

Automated tests cover the local adapter and queue behavior. Run `npm run ocr:smoke` on Linux to check installed binaries and English data against synthetic JPEG, PNG, and two-page PDF samples, including page order and temporary-file cleanup. This is the real native-runtime acceptance check. Windows path-handling tests and the historical Windows report provide compatibility context only; they do not replace the Linux run. The smoke command does not exercise the authenticated upload or Form 137 scan route end to end. Timeout and failure handling are covered by automated tests.

Tesseract provides OCR/text extraction; Poppler renders PDF pages. Node.js handles queueing, private storage, status normalization, access control, and later validation rules. No cloud document-processing API, custom model, or forensic analysis is in scope.

## SSHS E-Class Record grade import

The registrar-only direct grade import accepts the corrected SSHS E-Class Record for SY 2026–2027 as a fallback. Assigned teachers can also submit one corrected workbook for their term/section/subject assignment. Both paths read cached Term 1, Term 2, Term 3, and Final Grade values and do not recalculate formulas. Blank formula caches make the affected learner row ineligible; recalculate and save the workbook in Excel before uploading it again. The direct registrar path uses the workbook in memory and never stores it. The teacher path retains the original XLSX and parsed snapshot privately until the documented archival retention policy is defined.

Before upload, a registrar chooses an existing 2026–2027 school-year, grade-level, section, and subject context. The preview compares this selection with the workbook context and matches learners by a unique 12-digit LRN to active students and exactly one existing enrollment and assigned subject. Missing/ambiguous matches, incomplete cached grades, duplicate workbook LRNs, and context mismatches are excluded for roster correction and reupload. The preview shows student number and database name; an LRN match with a name difference requires a registrar review checkbox and reason. Every row must be explicitly included. Different existing grades are kept unless the registrar chooses replacement with a reason; equal values are left unchanged.

Preview data is private and tied to the uploader's session; transient previews become inaccessible after 30 minutes and are deleted when confirmation completes. Expired rows are removed opportunistically on the next grade-import request. No timed SQL cleanup job is configured. Teacher submission stores a private original workbook and a non-sensitive parsed snapshot; teacher submit does not write grades. Registrar approval rechecks the active assignment, student identity, enrollment, subject, roster, and existing grade state in a serializable SQL Server transaction. The audit record contains counts and recorded review reasons, not raw LRNs, grade values, or workbook bytes. Migration `007_student_lrn.sql` adds nullable unique LRNs for existing rows; new student records require an LRN. Registrars may backfill a blank LRN, while only database administrators may change a recorded value. Migration `009_teacher_grade_submissions.sql` adds teacher assignments and durable submission/history storage.

The registrar may approve, request correction, or reject a pending workbook. A correction request permits a new revision; submissions and decision events remain in history. Revoking an assignment blocks further teacher access and registrar approval. Deactivating the submitting teacher blocks their access/revision, but does not discard a durable pending submission; registrar review remains possible if the assignment stays active. Approval detects changes to roster/enrollment/subject identities or grade state and writes no grades if the snapshot conflicts.

This import's fixed 0–100 range and four period names are implementation constraints for the approved workbook, not an institution-wide grading policy. The Phase 10 thesis implementation gate is separate from the school-adoption gate: the selected manual checklist and status labels still require institution signoff before school deployment.
