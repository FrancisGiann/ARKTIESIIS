# Product

<!-- impeccable:product-schema 1 -->

## Platform

Web application built with Node.js 20+, Express, EJS, HTML, CSS, and JavaScript, backed by MariaDB.

## Users

- `database_admin`: manages accounts and audit activity, and oversees student records, documents, and finance workspaces.
- `registrar`: searches and maintains student records, manages enrollment and academic setup, and reviews documents and teacher grade submissions.
- `front_desk`: records paper pre-enrollment details and received-document counts; cannot manage student master records or staff decisions.
- `teacher`: views assigned classes and submits a corrected SSHS E-Class Record workbook for registrar review.
- `finance`: searches student accounts and records charges, payments, adjustments, term account clearance, and document request fee reviews.
- `student`: views only the linked student's profile, enrollment, schedule, registrar-approved grades, finance ledger, and permitted documents.

## Product Purpose

ARKTIESIIS is a centralized school records system for Ark Technological Institute Education System Incorporated, Lucena Branch. Staff use it to find student records and manage paper pre-enrollment, enrollment, academics, documents, paper-clearance evidence, and finance workflows. Students have a private self-service view of their own records.

## Operating Context

This is a thesis prototype. Front-desk staff record paper pre-enrollment; registrar staff review and finalize the linked student and enrollment record. The interface supports searchable records and the approved workbook workflows; it does not provide a general-purpose import for unspecified school spreadsheets. The bulk student-login workbook links accounts to existing unlinked records. Teacher grade submissions use the corrected SSHS E-Class Record format recognized by the parser. Product and design documentation describe shipped behavior without establishing final thesis objectives, school policy, or a future compatibility claim.

## Capabilities and Constraints

- Registrar and database administrator record search supports student name, student number, and LRN, with a unified student detail for enrollment, academic history, and document status.
- Front-desk pre-enrollment is limited to the paper intake form and receipt counts. The front desk cannot create or edit the student master record, approve documents, decide finance status, or manage accounts.
- Paper clearance records only whether the registrar inspected a fully signed paper form: Not completed or Completed. Finance term account clearance is a separate signed fees/payment decision. Document request fee review is a separate decision before releasing a requested document. None substitutes for another.
- Student numbers are assigned server-side during student intake and administrator profile creation in the provisional prototype format `SHS-<school-year-start>-<at-least-4-digit-sequence>`. Intake uses its selected academic year; administrator profile creation uses the current academic year. Existing matching numbers determine the next sequence. The format is a prototype convention pending school confirmation, not a confirmed numbering policy.
- Teachers may submit a corrected workbook only for an assigned term, section, and subject. Submission creates a review item; grades are written only when the registrar approves eligible rows within the approval transaction.
- Finance entries are recorded in the student's ledger. Students may view their own balance and transactions. A balance alone does not clear an enrollment.
- Students may upload Good Moral Certificates, PSA birth certificates, and report cards only for their own linked record. Students may correct an active report card after staff requests it.
- New report cards receive a bounded Gemini precheck for visible student-name comparison and supported file format, followed by mandatory staff source review; no grade information is extracted or changed. Pre-lifecycle report-card archives remain staff-only, read-only, and excluded from processing/retry. Form 137 uses a staff-only physical-status and history workflow; a temporary scan can produce bounded suggestions without storing that scan as a file or database record.
- The Gemini precheck is limited to configured PDF/JPEG/PNG checks and visible field suggestions. For Good Moral and PSA it compares the extracted student name with the linked record; for Good Moral it may return configured issuing-school and certificate-context clues. It cannot prove authenticity, detect forgery, verify signatures or seals, or perform forensic analysis. A human staff member inspects the source and makes each final document decision.
- The former local Tesseract/Poppler service is inactive legacy code. It is not used by current digital-document or Form 137 workflows.

## Stack and Security

- Node.js 20+, Express, EJS, HTML/CSS/JavaScript, MariaDB.
- Google Gemini API calls use built-in Node.js `fetch`; no SDK is required.
- Authentication uses bcrypt passwords, sessions, CSRF checks, server-side role authorization, rate limits, and email-based two-factor authentication outside the explicitly enabled development password bypass.
- Use parameterized SQL and validate all input. Store uploads outside public web access and enforce configured file, request, provider-response, timeout, and worker bounds.
- Never log credentials, API keys, raw document bytes, provider errors, or sensitive extracted fields. Do not expose raw database errors in production.

## Brand Commitments

- Preserve the supplied official school seal and the ARKTIESIIS name.
- Retain the full school name and Lucena Branch identification in the shared shell.
- Use a calm near-white interface, readable ink text, and restrained school-crimson action/current-state emphasis.

## Evidence and Claims

No deployment claims, performance measurements, customer stories, sample metrics, school-wide policies, or general spreadsheet compatibility are established by the project materials. Label synthetic defense data as synthetic and keep automated document checks advisory.

## Product Principles

- Make student lookup and the unified school record the first staff task.
- Keep role-specific workspaces and the front-desk boundary clear; keep paper clearance, finance decisions, and document-request fee reviews separate.
- Keep human review and ownership checks visible where staff decide or students access personal records.
- Describe only functionality that exists; keep prototype conventions distinct from confirmed school policy.
- Use clear empty states, labeled forms, visible keyboard focus, and layouts usable at 320px.
