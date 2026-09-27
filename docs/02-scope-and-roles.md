# Scope and Roles

## Authentication
- Login for students, registrar, teacher, finance, and database administrator.
- Email-based two-factor authentication after valid credentials.
- Role-based redirect and server-side authorization.

## Database Administrator
- User account management.
- Full system oversight of student, academic, and finance records according to approved school policy.
- Create and update student profiles, manage subject/grade records, and manage finance accounts and transactions.
- Archive student records while retaining linked academic and finance history; archiving disables the linked student login.
- Review activity through the audit log.
- Document oversight and validation result monitoring.
- Audit/activity monitoring.
- Data consistency and system maintenance functions.

## Registrar
- Student information management.
- Enrollment and academic history.
- Create and update student profiles, enrollment history, the subject catalog, subject assignments, and grades by grading period. Registrars can add an LRN to a legacy profile when blank; only database administrators can change a recorded LRN.
- Preview and confirm grade imports from the corrected SSHS E-Class Record for SY 2026–2027, matched by LRN to existing school-year enrollment and subject assignments.
- Create and revoke term-specific teacher assignments and review, approve, request corrections for, or reject submitted grade workbooks.
- Student master list.
- Deactivate linked student login accounts without archiving the student master record.
- Authorized document management and review.
- May upload Good Moral Certificates and PSA birth certificates for student records. Existing report-card documents are a staff-only read/download archive; no new report-card uploads or corrections are accepted.
- Records Form 137 physical receipt/review status and instructions. Authorized staff may send a scan to the server for temporary local OCR suggestions; the temporary scan is removed after processing and neither the scan nor OCR text is retained as a document or database record. Historical Form 137 files stay staff-only.

## Finance
- Search for a student by name or student number and access only finance identifiers, account details, balances, and transaction history.
- Create a financial account explicitly, then record positive PHP charges and payments or nonzero signed PHP adjustments with a reason.
- Charge increases balance; payment decreases balance; a negative balance represents a credit.
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
- Upload Good Moral Certificates and PSA birth certificates only for their own linked record.
- No access to report-card documents, including historical report-card rows. Existing report cards are kept in a staff-only archive and cannot be newly uploaded or corrected as documents.
- View document status and correction instructions, and re-upload their own Good Moral Certificates and student-uploaded PSA files when requested.
- View/download student-uploaded and staff-uploaded PSA birth certificates belonging to their own record. Students cannot re-upload staff-uploaded PSA files, and staff correction instructions/reasons for those files remain staff-only.
- View their own Form 137 physical status and staff instruction; students cannot scan, upload, or view Form 137 files or OCR suggestions.
- No access to another student's records.
- Archived student records retain academic and finance history; the linked student login is inactive.

## Academic grade scale
Until the school confirms its grading policy, grade entry uses a provisional numeric range of 0–100 with up to two decimal places. The application accepts a staff-provided grading period label and does not prescribe period names. This provisional range is centralized in the academic records service for later adjustment.

## Document types
Document types retained in the database schema:
- Form 137
- Report Card
- Good Moral Certificate
- PSA Birth Certificate

Students may upload Good Moral Certificates and PSA birth certificates only for their own linked record. Existing report-card rows are legacy archive records readable/downloadable only by registrar/database administrator; active upload, correction, student listing, and OCR flows block `report_card`. Students may view/download their own PSA submissions and staff-uploaded PSA files, but may re-upload only a student-origin PSA after staff requests a correction; staff correction instructions and reasons on staff-origin PSA files remain staff-only. Form 137 is a physical status workflow for registrar/database administrator users; it records pending, received, verified, correction, or rejected status. Staff may send the physical paper scan to the server through a CSRF-protected endpoint for local OCR suggestions. The temporary file is deleted after processing; no persistent Form 137 file or OCR record is created. Only staff-recorded status and instruction are saved. Historical Form 137 files are restricted to staff.

The uploader chooses the document type before upload. Active digital OCR suggestions are advisory: they look for the linked student name and a possible school-name line on Good Moral Certificates, and the linked student name on PSA certificates. Legacy report-card archive rows do not enter active OCR or review flows. The checks do not use a school-name whitelist, grading thresholds, completeness rules, or automatic acceptance. A registrar/database administrator inspects each permitted digital source and records verification, a correction request, or rejection. A reason is required to verify after an OCR failure or a missed advisory check. OCR does not classify documents or claim to prove authenticity, detect forgery, verify signatures or seals, or perform forensic analysis. These are capstone leader implementation decisions, not school policy; school approval is still required for policy-dependent Phase 10 acceptance checks.
