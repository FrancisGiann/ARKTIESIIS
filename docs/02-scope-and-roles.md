# Scope and Roles

## Prototype workflow priority
The product centers on a searchable database of student records because staff need to find a learner and check the learner's enrollment and documents together. Registrar and database administrator workspaces open with the student master list, which searches name, student number, and LRN and shows Good Moral, PSA, both previous-school report-card channels, and Form 137 status. A unified student record brings profile, enrollment, academic history, and document status together; the digital document workspace filters uploaded files and shows required-document counts, including missing submissions. Its staff-only `/documents/physical` workspace separately searches active students by name, student number, or LRN and links to Form 137 and paper previous-school report-card status forms. The student portal is a secondary self-service view of each learner's own records.

New applicants and continuing students use the school's required paper form. A learner returning after an interruption first needs an accepted return evaluation. Front-desk staff transcribe the paper form into a pre-enrollment record; the registrar reviews the saved source, confirms the placement and fee assessment, and creates the enrollment. Registrars and database administrators can maintain existing student profiles under their role-specific permissions. New student numbers are assigned in the provisional `SHS-<school-year start>-<sequence>` format, padded to at least four sequence digits, and continue from the highest matching number already stored for that chosen annual school year. The paper pre-enrollment school year can be selected without a configured academic term; saving a preliminary paper record does not create a student number, login, or charges. The chosen number format awaits school confirmation. The bulk login spreadsheet is only for linking logins to existing student records. Teacher grade imports support the known corrected SSHS E-Class Record workbook and assigned class context; the system does not assume other school spreadsheets share that format. School-specific spreadsheet intake beyond those workflows needs an approved template before implementation.

## Authentication
- Login for students, registrar, front desk, teacher, finance, and database administrator.
- Email-based two-factor authentication after valid credentials.
- Role-based redirect and server-side authorization.

## Front desk
- Transcribe paper pre-enrollment details and original/photocopy counts from the required paper form.
- Find, review, and correct those entries before registrar enrollment starts; each update retains its actor and revision history.
- No student master-record, account, document-acceptance, academic, paper-clearance, or finance access. Receipt counts are not proof of document inspection or acceptance.

## Database Administrator
- User account management.
- Full system oversight of student, academic, document, and finance records according to approved school policy.
- Search and maintain student profiles, review enrollment and academic history, manage finance accounts and transactions, and oversee document status.
- Grade entries are written only when the registrar approves a teacher's corrected class workbook submission; administrators do not directly upload report cards or write grades through a manual form.
- Archive student records while retaining linked academic and finance history; archiving disables the linked student login.
- Upload a bounded Excel roster to create missing login accounts only for existing, unlinked student records. The preview must be entirely valid before confirmation; temporary passwords are returned once through the private credential export and are never stored in plaintext.
- Review activity through the audit log.
- Document oversight and validation result monitoring.
- Audit/activity monitoring.
- Data consistency and system maintenance functions.

## Registrar
- Student information management.
- Enrollment and academic history.
- Create and update student profiles, enrollment history, the subject catalog, subject assignments, and class schedules. Registrars can add an LRN to a legacy profile when blank; only database administrators can change a recorded LRN.
- Review and approve teacher submissions from the corrected SSHS E-Class Record, matched by LRN to the teacher's current class assignment, student enrollment, and subject assignment. Only approval writes grades.
- Create and revoke term-specific teacher assignments and review, approve, request corrections for, or reject submitted grade workbooks.
- Student master list.
- Deactivate linked student login accounts without archiving the student master record.
- Guide new, returning, and transfer intake through student, enrollment, documents received, and fees/confirmation steps. Review the approved schedule and discounts, then confirm the payable assessment and entry-term enrollment; returning students reuse their linked profile and login.
- For an eligible first-time student, the initial private confirmation displays the temporary password and can be printed for handoff; saved or reopened confirmation copies omit it.
- Update the annual voucher type (PUB, ESC, NV), plus each term's section placement. Type changes after assessment remain visible for finance review and do not rewrite the reviewed charges.
- Finalize the entry term when the registrar confirms the reviewed fee assessment; later terms are activated individually after the annual confirmation and a valid section. Finance payment or term account clearance is not an enrollment prerequisite. Only a verified first-time intake activates a pending new login; returning accounts and previously finalized terms do not have credentials rotated. Historical pending accounts do not gain activation eligibility from their old status; retired intake/finalization URLs remain guarded compatibility paths.
- Record dated, reasoned cancel/drop/transfer changes without deleting academic history or canceling finance debt.
- Authorized document management and review.
- May upload Good Moral Certificates and PSA birth certificates for student records. Students upload previous-school report-card scans for their own linked record; registrars and database administrators review the source manually, request correction, verify, or reject. Historical archive rows remain read-only. Staff separately record paper-copy receipt/review status; missing paper records are informational and do not block enrollment. Neither channel is a current-grade source.
- Records Form 137 physical receipt/review status and instructions. The student master record links directly to this staff-only workflow. Authorized staff may send an in-memory scan to Google Gemini for temporary student-name and possible school-name suggestions; the application does not retain the scan or Gemini result as a file or database record. Historical Form 137 files stay staff-only.
- Dedicated Paper clearance workspace: prepare the matching checklist and record Not completed or Completed only after the registrar inspects a fully signed paper form. Marking an entire term not attended requires a reason. Paper clearance does not track signature collection and is separate from Finance's signed term account clearance.

## Finance
- Search for a student by name or student number and access only finance identifiers, account details, balances, and transaction history.
- Maintain versioned schedules by school year, grade, and voucher using student-payable amounts. The registrar reviews the configured fees and confirms the immutable annual assessment during intake; optional fees are added only when selected. Voucher changes after assessment remain visible for explicit review and never silently rewrite assessed charges.
- Record actual payment date, receipt/reference, and receipt-issued status separately from official receipt issuance. Allocate across this or prior assessments/terms. Payments, allocations, adjustments, reversals, legacy credits, and audit records remain separate and append-only.
- Record payments and allocations, and record a Finance term account clearance separately from registrar enrollment confirmation. This review applies to enrolled, pending, cancelled, dropped, or transferred placements. An outstanding balance requires a payment arrangement and remains owed after clearance. Finance has no enrollment-approval action in the current annual workflow.
- Review the fee decision for document requests before release. This is separate from paper document receipt/inspection, registrar paper clearance, and term account clearance.
- Read one shared finance projection for annual balance, current-term amount due, prior debt, and available credit. Old unattributed balances remain visible until explicitly reconciled; reconciliation does not create duplicate cash.
- Open authenticated, complete Statements of Account for finance work or a student's own account. A statement is not an official receipt. Private notes and payment arrangements remain finance/database-admin only.
- Finance users have no academic or system-administrator privileges.
- Database administrators also have finance workspace access and may create/update financial accounts and ledger entries.

## Teacher
- Open only currently active term/section/subject assignments and the roster currently enrolled in each assigned context.
- Upload and preview the corrected SSHS E-Class Record workbook for SY 2026–2027. The original workbook and parsed snapshot are retained privately for authorized review.
- A teacher submission never writes grades. The registrar must approve after current roster, enrollment, subject, and grade state are rechecked transactionally. Teachers can submit a revision only after a correction request.
- Access only the teacher's own submission history and workbook while their account and assignment remain active. A revoked assignment or inactive account ends teacher access.

## Student
- Access only the student's own account and records.
- View grades.
- Upload Good Moral Certificates, PSA birth certificates, and previous-school report-card scans only for their own linked record.
- No access to historical report-card archive rows. Students can view and download only their active student-origin report-card submissions.
- View document status and applicable correction instructions and rejection reasons for their own Good Moral, PSA, and active report-card submissions. Re-upload their own Good Moral Certificates, student-uploaded PSA files, and report cards after staff requests a correction. If staff rejects the latest submission, students can start a new original submission while the rejected record stays in history.
- View/download student-uploaded and staff-uploaded PSA birth certificates belonging to their own record. Students cannot re-upload staff-uploaded PSA files, and staff correction instructions/reasons for those files remain staff-only.
- View the latest status/date for their own previous-school report-card paper copy without staff notes or history.
- View their own read-only Statement of Account and complete financial history without staff-only notes.
- Form 137 is staff-only: students cannot view its physical status, staff instructions, scans, or Gemini suggestions.
- No access to another student's records.
- Archived student records retain academic and finance history; the linked student login is inactive.
- Temporary-password accounts must change the password after email two-factor verification and before accessing protected student pages. If the initial printed confirmation or one-time credential export is lost, the user sets a password through the existing reset flow.

## Academic grade scale
Until the school confirms its grading policy, grade entry uses a provisional numeric range of 0–100 with up to two decimal places. The application accepts a staff-provided grading period label and does not prescribe period names. This provisional range is centralized in the academic records service for later adjustment.

## Document types
Document types retained in the database schema:
- Form 137
- Report Card
- Good Moral Certificate
- PSA Birth Certificate

Students may upload scans of a previous-school report card only for their own linked record. V2 marks pre-lifecycle report-card rows as legacy archive records; only registrar/database administrator users may read or download them, and they remain outside student lists, Gemini processing, retry, and decisions. New active digital scans enter `pending`, receive a bounded Gemini precheck for visible student-name comparison and supported file format, then require manual staff source inspection and checklist review. Provider failure remains reviewable; eligible transient failures can be retried within the existing limit. Students can correct/re-upload only after staff requests it. The precheck and staff review do not extract grades or change published grades. A separate V2 event history records the paper copy brought to school. Its provisional statuses are pending (not yet recorded as received), received, verified (staff checked the copy under the current prototype process), correction (a clearer/replacement copy is needed), and rejected (not accepted for this requirement); the school must confirm meanings and criteria before deployment. Authorized staff see full notes/history; the linked student sees only latest status/date. Neither channel supplies current grades. Students may view/download their own PSA submissions and staff-uploaded PSA files, but may re-upload only a student-origin PSA after staff requests a correction; staff correction instructions and reasons on staff-origin PSA files remain staff-only. Form 137 is a separate physical status workflow for registrar/database administrator users; it records pending, received, verified, correction, or rejected status. Staff may send the physical paper scan to the server through a CSRF-protected endpoint for temporary Gemini field suggestions. The scan is processed in memory; no persistent Form 137 file or extraction result is created. Only staff-recorded status and instruction are saved. Historical Form 137 files are restricted to staff.

The uploader chooses the document type before upload. New student-origin report cards enter a limited Gemini precheck for visible linked-name comparison and supported PDF/JPEG/PNG format, followed by manual staff source review and the provisional checklist for learner identity/student number, grading period or school year, selected type, and submitted-page readability/completeness. The report-card response schema requests no grade fields and this workflow does not publish or change grades. The configured Gemini precheck extracts the linked student name on Good Moral and PSA submissions, and additionally suggests an issuing-school name and Good Moral certificate context on Good Moral submissions. A Good Moral precheck pass requires the linked-name comparison, school field, certificate-context evidence, surrounding content, and an accepted PDF/JPEG/PNG signature; a minimal text page with only names is insufficient. A PSA pass requires the linked-name comparison and supported file format. These bounded clues do not check page completeness or broader institution-specific requirements. Legacy report-card archive rows do not enter active Gemini processing or retry. There is no school-name whitelist, grading threshold, or automatic acceptance. A registrar/database administrator inspects each permitted digital source and records verification, a correction request, or rejection. A reason is required to verify after a failed configured check or an unavailable Gemini result. Gemini does not classify documents or claim to prove authenticity, detect forgery, verify signatures or seals, or perform forensic analysis. These are prototype checks, not school policy; school approval is still required for policy-dependent acceptance rules.
