# Paper Objectives, Scope, and Limitations

This document organizes the objectives, scope, and limitations supplied for the thesis paper. The final section records implementation clarifications separately so application behavior is not presented as school policy or as wording from the paper.

## General objective

Develop a web-based information management system with an AI-assisted document verification module to improve the efficiency, accuracy, and organization of student records and document processing at Ark Technological Institute Education System Incorporated - Lucena Branch.

## Specific objectives

1. Centralize student information, including personal data, enrollment, grades, financial accounts, and academic history.
2. Allow students and staff to upload Form 137, PSA birth certificates, report cards, and Good Moral Certificates in PDF, JPEG, or PNG format. Form 137 is restricted to authorized staff such as the registrar and database administrator.
3. Allow administrative staff, including the registrar, finance staff, and database administrator, to create, read, update, and delete permitted student records. The registrar and database administrator can deactivate student accounts.
4. Use an existing AI document-processing service to automatically check uploaded documents for required information, completeness, and configured format rules. A registrar may perform manual verification when needed.

## Scope

### Platform and access

- The system serves Ark Technological Institute Education System Incorporated - Lucena Branch. It is not a general multi-school platform.
- Users sign in with assigned credentials and complete email-based two-factor authentication.
- The system presents role-appropriate functions and protects records according to the user's role.

### Database administrator module

- Manage user accounts and oversee student, academic, finance, and document records and system activity.
- Create, update, and oversee student information, academic history, and finance accounts.
- Manage finance accounts, tuition balances, payments, and account status.
- Monitor uploaded documents and their validation results.
- Maintain the master list of students by class, section, and subject, including enrollment counts.
- Support data consistency, storage integrity, and database backup operations.

### Registrar module

- Create, read, and update academic information, including grades and enrollment records.
- Search and manage student records and view the student master list.
- View a student's submitted documents and their validation status.
- Review documents, accept them when the applicable process permits, request a corrected re-upload, or perform manual verification when needed.
- Manage the academic documents listed in the objectives, subject to role restrictions and institution-approved requirements.

### Finance module

- Read and update student-linked finance accounts, balances, payments, and account status.
- Access finance information needed for the finance role.

### Student module

- Access only the student's own permitted records.
- View grades, including subjects and grading periods.
- Upload and view Good Moral Certificates and report cards.
- View document validation results and re-upload a corrected document when requested.

### Document processing

- Accept PDF, JPEG, and PNG uploads for the document types in scope.
- Have the uploader choose the document type before upload; the AI service does not classify documents.
- Use an existing document-processing service for OCR/text extraction, required-field checks, completeness validation, and configured format/compliance checks.
- Keep human review available when the result needs judgment or when document acceptance requires it.

## Limitations

- The project uses existing local OCR/document-processing software. It does not train or introduce a new AI model.
- Validation is limited to OCR/text extraction, required information, completeness, and configured format/compliance checks.
- The uploader selects the document type. Automatic document classification is outside scope.
- The system does not claim to prove document authenticity, detect forged documents, authenticate signatures or seals, examine paper/material authenticity, or perform forensic document analysis. Human intervention is required for authenticity judgments.
- The system depends on server availability and installed local OCR/PDF utilities; the document OCR workflow does not require a cloud document-processing service.
- The implementation is limited to the Lucena Branch of Ark Technological Institute Education System Incorporated.

## Implementation clarifications kept separate from the paper and school policy

These capstone leader decisions guide application behavior. They preserve the paper's wording above and must not be described as institutional policy:

- Although specific objective 2 lists all four document types and restricts Form 137 to authorized staff, the implementation allows students to upload Good Moral Certificates, PSA birth certificates, and report cards only for their own linked record. New student-origin report cards enter a bounded Gemini precheck for visible student-name comparison and PDF/JPEG/PNG format, then mandatory registrar/database-administrator source review; they may be corrected by the student after a staff request. The precheck does not extract or write grades. V2 migration `002_report_card_lifecycle.sql` marks pre-lifecycle report-card rows as a staff-only read/download archive; students cannot read those rows and archive rows are excluded from processing/retry. Staff report-card upload and persistent Form 137 upload remain outside the implemented scope. This implementation detail does not revise the paper objective, which remains subject to advisor review. Teachers submit the corrected SSHS E-Class Record XLSX to the registrar for their assigned term/section/subject; the teacher submission stores the source workbook and preview privately but does not write grades. Students see grades only after registrar approval. Only student-origin PSA files can be re-uploaded by students after correction is requested. Staff correction instructions and reasons for staff-origin PSA files remain staff-only. Persistent Form 137 upload remains unavailable under the separate physical-status workflow described above.
- The paper's specific objective lists Form 137 among the uploads by authorized staff; that source wording is preserved above. The current application does not permit persistent Form 137 file uploads. Only registrar/database administrator users may send a scan of the physical paper for temporary local OCR suggestions; the temporary file is deleted after processing and no Form 137 document or OCR record is created. The only saved data is the human-recorded physical status and instruction. Form 137 status values are pending, received, verified, correction, or rejected. Students see status/instruction only; historical Form 137 files remain staff-only.
- Active digital prechecks are advisory: Good Moral and PSA submissions use configured visible fields, while active report cards request only the visible linked student name plus server-side PDF/JPEG/PNG format validation. Report-card prompts/schemas do not request grades or academic results; staff still inspect the full source and use a manual checklist, and the workflow does not write grades. Legacy report-card rows remain read-only archive records outside active processing/retry. There is no school-name whitelist, grading threshold, completeness rule, or automatic acceptance. A registrar/database administrator inspects each permitted digital source file and manually verifies, requests correction, or rejects it. A reason is required to verify after a warning or unavailable precheck. The Phase 10 thesis implementation gate has passed; the separate school-adoption gate remains pending institution signoff before school deployment under these rules.
- A separate academic-records feature supports registrar review and confirmation of cached Term 1–3 and Final Grade values from the corrected SSHS E-Class Record for SY 2026–2027. It matches by LRN to an existing student, enrollment, section, grade level, and assigned subject; this workbook-specific import is a separate grade source and does not set institution-wide grading or document-acceptance policy or change the pending school-adoption gate.
- The paper's confirmed-deletion language applies to database-administrator deletion of student records. In the application, the user's chosen behavior is to archive/deactivate the student record while retaining linked academic and finance history. Separately, a registrar may deactivate a linked student login without archiving the student record.
- A registrar cannot edit an existing student number. A database administrator may correct it.
- The application's current 0–100 grade range is provisional, not a grading policy stated in the paper. The school must confirm its grading scale before the range is represented as official policy.
- Tesseract and Poppler remain inactive legacy code and are not used by the current Gemini field-extraction workflow.

## Proposed paper correction for advisor review (not approved)

The source wording in the general/specific objectives and scope above remains unchanged. The following is a proposed revision reflecting current application behavior; it is not approved paper wording or school policy:

- Any revision to specific objective 2 remains an advisor/proponent decision. The current prototype lets a student submit a report card for their own record for a bounded visible-name/file-format precheck followed by manual staff review; the document is separate from the teacher grade workbook and does not extract or publish grades. The prototype does not accept staff-uploaded report cards or persistent Form 137 uploads. Keep the original objective visible until the authors formally revise it.
- Clarify specific objective 1/scope to include the teacher grade-submission workflow: registrars assign teachers by academic term, section, and subject; teachers submit the corrected SSHS E-Class Record XLSX for assigned classes; registrar approval validates current enrollment and grade state before records change.
- Add a separate objective if the authors intend to claim teacher submission/approval as a thesis deliverable. No source objective currently describes this workflow, so it should not be retroactively presented as part of the supplied paper text.
