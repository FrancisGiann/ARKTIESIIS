Source totals: 135 form elements and 633 named controls inside locally parsed form bodies. Standalone address controls are added below; EJS partial expansion means the raw count is not a total of rendered controls.
# Static EJS form and input inventory

Read-only inventory generated from current views/**/*.ejs markup. EJS conditionals are scanned together; runtime conditions can hide fields. Browser-created controls and JS behavior require runtime checks.
### Named controls in partials without a local <form>

`views/records/partials/address-fields.ejs` is included inside parent forms, so these controls are not captured by the local-form parser above. It renders these fields (the student and emergency groups are conditional):

- Student address mode: `addressMode` (`preserve|replace` select for existing student, otherwise hidden `replace`); `addressBlockLotStreetPurok` (max 200), `addressBarangay`, `addressCity`, `addressProvince` (max 100 each), and `addressZip` (max 4, four digits).
- Emergency contact address mode: `emergencyContactAddressMode` (`preserve|replace` select for existing student, otherwise hidden `replace`); `emergencyContactAddressBlockLotStreetPurok` (max 200), `emergencyContactAddressBarangay`, `emergencyContactAddressCity`, `emergencyContactAddressProvince` (max 100 each), and `emergencyContactAddressZip` (max 4, four digits).
- Pre-enrollment can also render `emergencyContactSameAsStudent` (checkbox `1`). The server normalizes/copies the structured components and validates them in `src/utils/studentAddress.js`; existing saved addresses are retained unless the mode explicitly requests replacement.


## account/email-confirm.ejs:11 — POST /account/email/confirm
- "_csrf" (hidden); "requestId" (hidden); "token" (hidden)

## account/index.ejs:32 — POST /account/password
- "_csrf" (hidden); "currentPassword" (password; required, maxlength=72); "password" (password; required, minlength=12, maxlength=72); "confirmPassword" (password; required, minlength=12, maxlength=72)

## account/index.ejs:56 — POST /account/email/request
- "_csrf" (hidden); "currentPassword" (password; required, maxlength=72); "email" (email; required, maxlength=255)

## account/index.ejs:77 — POST /account/sessions/revoke-others
- "_csrf" (hidden); "currentPassword" (password; required, maxlength=72)

## account/password-required.ejs:8 — POST /account/password
- "_csrf" (hidden); "currentPassword" (password; required, maxlength=72); "password" (password; required, minlength=12, maxlength=72); "confirmPassword" (password; required, minlength=12, maxlength=72)

## account/password-required.ejs:15 — POST /logout
- "_csrf" (hidden)

## admin/accounts.ejs:36 — GET /admin/users
- "category" (hidden); "search" (search; maxlength=100); "role" (select options=[]); "status" (select options=[all|active|inactive])

## admin/audit.ejs:29 — GET /admin/audit
- "search" (search; maxlength=100); "category" (select)

## admin/student-account-bulk.ejs:16 — POST /admin/student-accounts/preview
- "_csrf" (hidden); "workbook" (file; required)

## admin/student-account-bulk.ejs:40 — POST /admin/student-accounts/confirm
- "_csrf" (hidden); "previewId" (hidden)

## admin/user-edit.ejs:18 — POST (EJS-generated)
- "_csrf" (hidden); "email" (email; required, maxlength=255); "role" (select; required); "firstName" (text; maxlength=100); "lastName" (text; maxlength=100); "department" (text; maxlength=100); "studentNo" (text; maxlength=50); "isActive" (checkbox)

## admin/user-edit.ejs:73 — POST (EJS-generated)
- "_csrf" (hidden); "password" (password; required, minlength=12, maxlength=72); "confirmPassword" (password; required, minlength=12, maxlength=72)

## admin/user-new.ejs:16 — POST /admin/users
- "_csrf" (hidden); "email" (email; required, maxlength=255); "role" (select; required); "firstName" (text; maxlength=100); "lastName" (text; maxlength=100); "department" (text; maxlength=100); "studentNo" (text; maxlength=50); "password" (password; required, minlength=12, maxlength=72); "confirmPassword" (password; required, minlength=12, maxlength=72)

## auth/forgot-password.ejs:12 — POST /password/forgot
- "_csrf" (hidden); "email" (email; required, maxlength=255)

## auth/login.ejs:16 — POST /login
- "_csrf" (hidden); "email" (email; required, maxlength=255); "password" (password; required)

## auth/password-reset.ejs:15 — POST /password/reset
- "_csrf" (hidden); "requestId" (hidden); "token" (hidden); "password" (password; required, minlength=12, maxlength=72); "confirmPassword" (password; required, minlength=12, maxlength=72)

## auth/verify.ejs:10 — POST /login/verify
- "_csrf" (hidden); "code" (text; required, pattern=[0-9]{6}, maxlength=6)

## auth/verify.ejs:19 — POST /login/verify/resend
- "_csrf" (hidden)

## auth/verify.ejs:23 — POST /login/verify/cancel
- "_csrf" (hidden)

## dashboards/registrar.ejs:18 — GET /registrar
- "schoolYear" (select options=[])

## dashboards/registrar.ejs:29 — GET /registrar
- "schoolYear" (hidden); "termId" (select options=[])

## dashboards/registrar.ejs:124 — GET /registrar/records
- "search" (search; required, maxlength=100)

## documents/detail.ejs:85 — POST (EJS-generated)
- "_csrf" (hidden)

## documents/detail.ejs:120 — POST (EJS-generated)
- "_csrf" (hidden)

## documents/detail.ejs:162 — POST (EJS-generated)
- "_csrf" (hidden); "decision" (hidden); "reason" (textarea; maxlength=1000)

## documents/detail.ejs:175 — POST (EJS-generated)
- "_csrf" (hidden); "instruction" (textarea; required, maxlength=1000)

## documents/detail.ejs:182 — POST (EJS-generated)
- "_csrf" (hidden); "decision" (hidden); "reason" (textarea; required, maxlength=1000)

## documents/detail.ejs:196 — POST (EJS-generated)
- "_csrf" (hidden); "document" (file; required)

## documents/detail.ejs:209 — POST (EJS-generated)
- "_csrf" (hidden); "document" (file; required)

## documents/detail.ejs:224 — POST (EJS-generated)
- "_csrf" (hidden)

## documents/index.ejs:38 — POST /documents
- "_csrf" (hidden); "documentType" (select; required options=[]); "document" (file; required)

## documents/index.ejs:62 — GET /documents
- "search" (search; maxlength=100); "documentType" (select options=[all]); "status" (select)

## documents/physical.ejs:15 — GET /documents/physical
- "search" (search; maxlength=100)

## documents/student.ejs:27 — POST (EJS-generated)
- "_csrf" (hidden); "requirementCode" (hidden); "idempotencyKey" (hidden); "isApplicable" (hidden)

## documents/student.ejs:59 — POST (EJS-generated)
- "_csrf" (hidden); "requirementCode" (hidden); "requirementName" (hidden); "idempotencyKey" (hidden); "isApplicable" (hidden)

## documents/student.ejs:83 — POST (EJS-generated)
- "_csrf" (hidden); "requirementCode" (hidden); "idempotencyKey" (hidden); "isApplicable" (hidden); "requirementName" (input; maxlength=120); "status" (select; required); "originalsReceived" (number; min=0, max=20); "copiesReceived" (number; min=0, max=50); "piecesReceived" (number; min=0, max=50); "note" (textarea; maxlength=1000)

## documents/student.ejs:118 — POST (EJS-generated)
- "_csrf" (hidden); "status" (select; required); "instruction" (textarea; maxlength=1000)

## documents/student.ejs:147 — POST (EJS-generated)
- "_csrf" (hidden); "status" (select; required); "instruction" (textarea; maxlength=1000)

## documents/student.ejs:170 — POST (EJS-generated)
- "_csrf" (hidden); "form137Scan" (file; required)

## documents/student.ejs:184 — POST (EJS-generated)
- "_csrf" (hidden); "documentType" (select; required options=[]); "document" (file; required)

## finance/annual-roster.ejs:10 — GET /finance
- "search" (search; maxlength=100); "schoolYear" (select options=[]); "termId" (select options=[]); "gradeLevel" (select options=[]); "sectionId" (select options=[]); "cluster" (text; maxlength=100); "strand" (text; maxlength=100); "voucherCode" (select options=[]); "status" (select options=[]); "financeStatus" (select options=[]); "installment" (select)

## finance/annual-student.ejs:64 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "scheduleId" (hidden); "scheduleVersion" (hidden); "voucherCode" (hidden); "optionalLineId" (hidden)

## finance/annual-student.ejs:99 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "amount" (input; maxlength=14); "reason" (textarea; required, maxlength=1000)

## finance/annual-student.ejs:101 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "comment" (textarea; required, maxlength=1000)

## finance/annual-student.ejs:121 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "financeHandbookNumber" (input; maxlength=80)

## finance/annual-student.ejs:136 — POST (EJS-generated)
- "_csrf" (hidden); "optionalLineId" (checkbox)

## finance/annual-student.ejs:156 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "resolution" (select; required options=[assessment_stands|adjustments_recorded]); "reason" (textarea; required, maxlength=900)

## finance/annual-student.ejs:177 — POST (EJS-generated)
- "_csrf" (hidden); "studentId" (hidden); "idempotencyKey" (hidden); "confirmClearance" (checkbox); "reason" (textarea; required, maxlength=1000); "arrangement" (textarea; maxlength=1000); "financeNote" (textarea; maxlength=2000)

## finance/annual-student.ejs:190 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "feeCategory" (select); "lineName" (input; maxlength=120); "installment" (input; maxlength=40); "amount" (input; maxlength=14); "reason" (textarea; required, maxlength=1000)

## finance/annual-student.ejs:214 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "ruleTerm" (select); "ruleCategory" (select options=[]); "ruleLineName" (input; maxlength=120); "ruleAmount" (input; maxlength=14); "fullCoverageIndex" (checkbox); "reason" (textarea; required, maxlength=1000)

## finance/annual-student.ejs:246 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "amount" (input; maxlength=14); "installment" (input); "reason" (textarea; required, maxlength=1000)

## finance/annual-student.ejs:267 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "amount" (input; maxlength=14); "paymentDate" (date); "referenceNo" (input; maxlength=100); "receiptIssued" (select options=[0|1]); "transmittalReference" (input; maxlength=100); "privateRemarks" (textarea; maxlength=1000); "allocationTarget" (select options=[]); "allocationAmount" (input); "allocationTarget" (select options=[]); "allocationAmount" (input; maxlength=14); "allocationMode" (submit)

## finance/annual-student.ejs:309 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "allocationTarget" (select options=[]); "allocationAmount" (input); "allocationTarget" (select options=[]); "allocationAmount" (input; maxlength=14)

## finance/annual-student.ejs:321 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "allocationTarget" (select options=[]); "allocationAmount" (input); "allocationTarget" (select options=[]); "allocationAmount" (input; maxlength=14); "reason" (textarea; required, maxlength=1000)

## finance/annual-student.ejs:336 — POST (EJS-generated)
- "_csrf" (hidden)

## finance/annual-student.ejs:342 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "expectedAmount" (hidden); "sourceLabel" (input; maxlength=120); "reason" (textarea; required, maxlength=1000)

## finance/annual-student.ejs:359 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "amount" (input; maxlength=14); "reason" (textarea; required, maxlength=1000)

## finance/annual-student.ejs:362 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "amount" (input; maxlength=14); "reason" (textarea; required, maxlength=1000)

## finance/annual-student.ejs:370 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "eventType" (select; required options=[receipt_reference_updated|receipt_marked_issued|private_remark_added]); "referenceNo" (input; maxlength=100); "privateRemark" (textarea; maxlength=1000)

## finance/annual-student.ejs:391 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "reason" (textarea; required, maxlength=1000)

## finance/annual-student.ejs:401 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "reason" (textarea; required, maxlength=1000)

## finance/departures.ejs:28 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "departureChargeId" (hidden); "departureAdjustmentAmount" (input; maxlength=14); "departureAdjustmentReason" (input; required, maxlength=1000); "reason" (textarea; required, maxlength=1000)

## finance/document-clearance.ejs:12 — GET /finance/document-clearance
- "search" (search; maxlength=100); "status" (select options=[]); "page" (hidden)

## finance/document-clearance.ejs:56 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "decision" (hidden); "expectedRevision" (hidden); "expectedOutstanding" (hidden); "search" (hidden); "status" (hidden); "page" (hidden); "ledgerReviewConfirmed" (checkbox)

## finance/document-clearance.ejs:69 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "decision" (hidden); "search" (hidden); "status" (hidden); "page" (hidden)

## finance/document-clearance.ejs:76 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "decision" (hidden); "search" (hidden); "status" (hidden); "page" (hidden)

## finance/overview.ejs:5 — GET /finance
- "search" (search; required, maxlength=100)

## finance/overview.ejs:16 — GET /finance/overview
- "schoolYear" (select; required); "termId" (select; required); "installment" (select); "gradeLevel" (select options=[]); "voucherCode" (select options=[]); "sectionId" (select options=[])

## finance/reports.ejs:14 — GET /finance/reports
- "view" (hidden); "fromDate" (date); "toDate" (date)

## finance/review-draft.ejs:94 — POST (EJS-generated)
- "_csrf" (hidden)

## finance/review-draft.ejs:181 — POST (EJS-generated)
- "_csrf" (hidden); "revision" (hidden); "dependencyFingerprint" (hidden)

## finance/review-draft.ejs:187 — POST (EJS-generated)
- "_csrf" (hidden)

## finance/review-drafts.ejs:20 — POST (EJS-generated)
- "_csrf" (hidden)

## finance/schedules.ejs:9 — GET /finance/schedules
- "voucherCode" (hidden); "schoolYear" (input); "gradeLevel" (select options=[])

## finance/schedules.ejs:39 — POST /finance/schedules
- "_csrf" (hidden); "idempotencyKey" (hidden); "schoolYear" (hidden); "gradeLevel" (hidden); "voucherCode" (hidden); "termNumber" (hidden); "feeCategory" (hidden); "lineName" (hidden); "installment" (hidden); "optionalIndex" (checkbox); "termNumber" (select; required options=[1|2|3]); "feeCategory" (select; required options=[tuition|miscellaneous|uniform|id|activity|retake|other]); "lineName" (input; required, maxlength=120); "installment" (input; required, maxlength=40); "lineAmount" (input; required, maxlength=14); "optionalIndex" (checkbox)

## partials/head.ejs:42 — POST /logout
- "_csrf" (hidden)

## partials/return-evaluation-form.ejs:63 — POST (EJS-generated)
- "_csrf" (hidden); "version" (hidden); "applicantLrn" (input; required, pattern=[0-9]{12}, maxlength=12); "firstName" (input; required, maxlength=100); "middleName" (input; maxlength=100); "lastName" (input; required, maxlength=100); "suffix" (input; maxlength=20); "schoolYear" (input; required, maxlength=20); "targetGradeLevel" (select; required options=[]); "targetGradeLevel" (hidden); "priorProgress" (textarea; required, maxlength=4000); "evidenceReviewed" (textarea; required, maxlength=4000); "form137Supporting" (checkbox); "curriculumComparison" (textarea; required, maxlength=4000); "requiredSubjects" (textarea; required, maxlength=4000); "curriculumReviewStatus" (select); "curriculumReviewStatus" (hidden); "subjectAvailability" (select); "subjectAvailability" (hidden); "availabilityNotes" (textarea; maxlength=4000); "decisionReason" (textarea; maxlength=4000)

## partials/return-evaluation-form.ejs:88 — POST (EJS-generated)
- "_csrf" (hidden); "version" (hidden); "decisionReason" (textarea; required, maxlength=4000); "decision" (submit); "decision" (submit)

## pre-enrollments/form.ejs:10 — POST <%= record ? `/pre-enrollments/${encodeURIComponent(record.id)}` :
- "_csrf" (hidden); "version" (hidden); "idempotencyKey" (hidden); "schoolYear" (input; required, maxlength=20); "applicantKind" (select); "firstName" (input; maxlength=100); "middleName" (input; maxlength=100); "lastName" (input; maxlength=100); "suffix" (input; maxlength=20); "lrn" (input; pattern=[0-9]{0,12}, maxlength=12); "studentContactNumber" (tel; maxlength=50); "readmissionEvaluationBinding" (select options=[]); "voucherTypeText" (input; maxlength=120); "voucherCategoryText" (input; maxlength=120); "preferredTrack" (select options=[]); "preferredCluster" (select options=[]); "targetGradeLevel" (select options=[]); "priorGradeLevel" (input; maxlength=80); "priorSchool" (input; maxlength=200); "studentSignaturePresent" (checkbox); "studentSignedDate" (date); "receivedBy" (input; maxlength=100); "receivedDate" (date); "email" (email; maxlength=255); "birthDate" (date); "sex" (select options=[]); "profilePhone" (tel; maxlength=50); "birthplace" (input; maxlength=160); "facebookName" (input; maxlength=120); "emergencyContactPerson" (input; maxlength=160); "emergencyContactRelationship" (input; maxlength=80); "emergencyContactPhone" (tel; maxlength=50); "motherName" (input; maxlength=160); "motherPhone" (tel; maxlength=50); "fatherName" (input; maxlength=160); "fatherPhone" (tel; maxlength=50); "status" (select options=[draft|ready_for_registrar])

## pre-enrollments/index.ejs:8 — GET /pre-enrollments
- "search" (input); "schoolYear" (input); "status" (select options=[])

## readmissions/form.ejs:68 — POST <%= evaluation ? `/registrar/readmissions/${encodeURIComponent(evaluation.id)}` :
- "_csrf" (hidden); "version" (hidden); "applicantLrn" (input; required, pattern=[0-9]{12}, maxlength=12); "firstName" (input; required, maxlength=100); "middleName" (input; maxlength=100); "lastName" (input; required, maxlength=100); "suffix" (input; maxlength=20); "schoolYear" (input; required, maxlength=20); "targetGradeLevel" (select; required options=[]); "targetGradeLevel" (hidden); "priorProgress" (textarea; required, maxlength=4000); "evidenceReviewed" (textarea; required, maxlength=4000); "form137Supporting" (checkbox); "curriculumComparison" (textarea; required, maxlength=4000); "requiredSubjects" (textarea; required, maxlength=4000); "curriculumReviewStatus" (select); "curriculumReviewStatus" (hidden); "subjectAvailability" (select); "subjectAvailability" (hidden); "availabilityNotes" (textarea; maxlength=4000); "decisionReason" (textarea; maxlength=4000)

## readmissions/form.ejs:92 — POST (EJS-generated)
- "_csrf" (hidden); "version" (hidden); "decisionReason" (textarea; required, maxlength=4000); "decision" (submit); "decision" (submit)

## readmissions/index.ejs:4 — GET /registrar/readmissions
- "search" (input; maxlength=100); "status" (select options=[])

## records/annual-intake-fees.ejs:22 — GET (EJS-generated)
- "idempotencyKey" (hidden); "optionalLineIds" (hidden); "optionalLineIds" (checkbox)

## records/annual-intake-form.ejs:24 — POST /registrar/intake
- "_csrf" (hidden); "idempotencyKey" (hidden); "preEnrollmentId" (hidden); "preEnrollmentVersion" (hidden); "studentReviewFingerprint" (hidden); "studentNo" (hidden); "approvedProfileFields" (checkbox); "studentNo" (input; disabled); "studentNo" (input; maxlength=50); "lrn" (input; pattern=[0-9]{12}, maxlength=12); "email" (email; maxlength=255); "firstName" (input; maxlength=100, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "middleName" (input; maxlength=100, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "lastName" (input; maxlength=100, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "suffix" (input; maxlength=20, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "birthDate" (date); "sex" (select options=[]); "phone" (tel; maxlength=50, pattern=\+?[0-9\x28\x29\x20\x2d]{7,50}); "emergencyContactPerson" (input; maxlength=160); "emergencyContactRelationship" (input; maxlength=80); "emergencyContactPhone" (tel; maxlength=50, pattern=\+?[0-9\x28\x29\x20\x2d]{7,50}); "schoolYear" (select; required options=[]); "gradeLevel" (select; required options=[]); "voucherCode" (select; required options=[]); "intakeKind" (select options=[standard|transferee]); "entryTermNumber" (select; required options=[]); "enrollmentStartDate" (date); "sectionMode" (select options=[same|per_term]); "annualSectionId" (select; required options=[])

## records/annual-intake-list.ejs:29 — GET /registrar/intake
- "studentStatus" (hidden); "search" (search; maxlength=100); "schoolYear" (select options=[]); "termId" (select options=[]); "gradeLevel" (select options=[]); "voucherCode" (select options=[]); "sectionId" (select options=[]); "cluster" (input; maxlength=80); "strand" (input; maxlength=80); "status" (select options=[]); "confirmationStatus" (select options=[|needs_confirmation])

## records/annual-intake-list.ejs:84 — POST (EJS-generated)
- "_csrf" (hidden)

## records/annual-intake-list.ejs:108 — POST (EJS-generated)
- "_csrf" (hidden)

## records/annual-intake-list.ejs:119 — POST (EJS-generated)
- "_csrf" (hidden)

## records/annual-intake-review.ejs:85 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "sourceAnnualId" (select; required options=[]); "reason" (textarea; required, maxlength=1000)

## records/annual-intake-review.ejs:140 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "scheduleId" (hidden); "scheduleVersion" (hidden); "voucherCode" (hidden); "assessmentId" (hidden); "snapshotFingerprint" (hidden); "clearanceSnapshotFingerprint" (hidden); "optionalLineIds" (hidden)

## records/annual-management.ejs:35 — POST (EJS-generated)
- "_csrf" (hidden); "escId" (input; maxlength=80); "acquaintanceWaiverStatus" (select; required); "acquaintanceParty" (input; maxlength=120); "educationalTourStatus" (select; required); "internalAgreementRemarks" (textarea; maxlength=1000)

## records/annual-management.ejs:77 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "tagType" (select; required options=[internal|athlete|performer|named_arrangement]); "label" (input; required, maxlength=120); "effectiveTermFrom" (select options=[]); "effectiveTermTo" (select options=[]); "note" (input; maxlength=500)

## records/annual-management.ejs:88 — POST (EJS-generated)
- "_csrf" (hidden); "studentSubjectId" (hidden); "idempotencyKey" (hidden); "modularSubtype" (input; maxlength=80); "prepaidArrangementNote" (input; maxlength=500)

## records/annual-management.ejs:95 — POST (EJS-generated)
- "_csrf" (hidden); "effectiveEnrollmentId" (select; required options=[]); "departureType" (select; required options=[transferred|dropped]); "effectiveDate" (date); "reason" (textarea; required, maxlength=1000)

## records/annual-management.ejs:101 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "effectiveEnrollmentId" (hidden); "departureType" (hidden); "effectiveDate" (hidden); "reason" (hidden)

## records/annual-term-activation-review.ejs:30 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "clearanceSnapshotFingerprint" (hidden)

## records/clearance-dashboard.ejs:42 — GET /registrar/records/clearance
- "status" (hidden); "search" (search; maxlength=100); "schoolYear" (select options=[]); "termId" (select options=[])

## records/grade-import.ejs:17 — POST /registrar/records/grade-import/preview
- "_csrf" (hidden); "contextKey" (select; required options=[]); "workbook" (file; required)

## records/grade-import.ejs:41 — POST (EJS-generated)
- "_csrf" (hidden)

## records/index.ejs:39 — GET /registrar/records
- "search" (search; maxlength=100); "termId" (select options=[]); "returnStatus" (select options=[])

## records/index.ejs:128 — POST /registrar/records/terms
- "_csrf" (hidden); "schoolYear" (text; required, maxlength=20); "term" (text; required, maxlength=30); "isCurrent" (checkbox)

## records/index.ejs:145 — POST (EJS-generated)
- "_csrf" (hidden)

## records/index.ejs:157 — POST /registrar/records/sections
- "_csrf" (hidden); "name" (text; required, maxlength=100); "gradeLevel" (text; maxlength=50); "academicTermId" (select; required options=[]); "cluster" (input; maxlength=80); "strand" (input; maxlength=80); "adviser" (input; maxlength=160); "modality" (select options=[]); "modularSubtype" (input; maxlength=80)

## records/legacy-activation-review.ejs:15 — POST (EJS-generated)
- "_csrf" (hidden)

## records/missing-grade-overview.ejs:8 — GET /registrar/records/grades/missing
- "termId" (select; required options=[]); "sectionId" (select; required options=[]); "subjectId" (select; required options=[]); "gradingPeriod" (select options=[])

## records/student-academic.ejs:50 — POST /registrar/records/student-subjects
- "_csrf" (hidden); "studentId" (hidden); "enrollmentId" (hidden)

## records/student-clearance.ejs:37 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "expectedVersion" (hidden); "paperCompleted" (checkbox)

## records/student-clearance.ejs:75 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "expectedVersion" (hidden)

## records/student-form.ejs:18 — POST <%= student ? `/registrar/records/students/${student.id}` :
- "_csrf" (hidden); "studentNo" (text; required, maxlength=50); "lrn" (text; maxlength=12, pattern=[0-9]{12}); "firstName" (text; required, maxlength=100, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "middleName" (text; maxlength=100, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "lastName" (text; required, maxlength=100, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "suffix" (text; maxlength=20, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "birthDate" (date); "sex" (select options=[|unspecified]); "phone" (tel; maxlength=50, pattern=\+?[0-9\x28\x29\x20\x2d]{7,50}); "birthplace" (input; maxlength=160); "facebookName" (input; maxlength=120); "motherName" (input; maxlength=160); "motherPhone" (tel; maxlength=50, pattern=\+?[0-9\x28\x29\x20\x2d]{7,50}); "fatherName" (input; maxlength=160); "fatherPhone" (tel; maxlength=50, pattern=\+?[0-9\x28\x29\x20\x2d]{7,50}); "emergencyContactPerson" (input; maxlength=160); "emergencyContactRelationship" (input; maxlength=80); "emergencyContactPhone" (tel; maxlength=50, pattern=\+?[0-9\x28\x29\x20\x2d]{7,50})

## records/student-form.ejs:58 — POST (EJS-generated)
- "_csrf" (hidden); "confirmation" (text; required, maxlength=10)

## records/student-form.ejs:65 — POST (EJS-generated)
- "_csrf" (hidden); "confirmation" (text; required, maxlength=50)

## records/student-form.ejs:98 — POST /registrar/records/enrollments
- "_csrf" (hidden); "studentId" (hidden); "academicTermId" (select; required options=[]); "sectionId" (select options=[])

## records/student-intake-form.ejs:9 — POST /registrar/intake
- "_csrf" (hidden); "lrn" (input; required, pattern=[0-9]{12}, maxlength=12); "firstName" (input; required, maxlength=100, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "middleName" (input; maxlength=100, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "lastName" (input; required, maxlength=100, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "suffix" (input; maxlength=20, pattern=\p{L}[\p{L}\p{M}]*(?:[.\x2d); "birthDate" (date); "sex" (select options=[]); "phone" (tel; maxlength=50, pattern=\+?[0-9\x28\x29\x20\x2d]{7,50}); "email" (email; required, maxlength=255); "academicTermId" (select; required options=[]); "sectionId" (select; required options=[]); "address" (textarea; maxlength=500)

## records/student-intake-list.ejs:25 — POST (EJS-generated)
- "_csrf" (hidden)

## records/student-overview.ejs:144 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden); "documentType" (input; maxlength=50); "documentName" (input; maxlength=150); "requestedOn" (date); "reference" (input; maxlength=200)

## records/student-overview.ejs:169 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden)

## records/student-overview.ejs:179 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden)

## records/student-overview.ejs:193 — POST (EJS-generated)
- "_csrf" (hidden); "idempotencyKey" (hidden)

## records/subjects.ejs:23 — POST /registrar/records/subjects
- "_csrf" (hidden); "subjectCode" (text; required, maxlength=50); "subjectName" (text; required, maxlength=200); "units" (number; min=0.01, max=999.99, step=0.01)

## records/subjects.ejs:38 — GET /registrar/records/subjects
- "search" (search; maxlength=100)

## records/subjects.ejs:55 — POST (EJS-generated)
- "_csrf" (hidden)

## records/teacher-assignments.ejs:10 — GET /registrar/records/teacher-assignments
- "termId" (select; required); "sectionId" (select options=[])

## records/teacher-assignments.ejs:47 — POST /registrar/records/teacher-assignments
- "_csrf" (hidden); "academicTermId" (hidden); "filterTermId" (hidden); "sectionId" (select; required options=[]); "teacherId" (select; required options=[]); "subjectId" (select; required options=[])

## records/teacher-assignments.ejs:90 — POST (EJS-generated)
- "_csrf" (hidden); "filterTermId" (hidden); "filterSectionId" (hidden)

## records/teacher-grade-review.ejs:10 — POST (EJS-generated)
- "_csrf" (hidden); "reason" (textarea; required, maxlength=500); "decision" (submit); "decision" (submit); "decision" (submit)

## records/teacher-grade-upload.ejs:15 — POST (EJS-generated)
- "_csrf" (hidden); "contextKey" (hidden); "workbook" (file; required)

## records/teacher-grade-upload.ejs:34 — POST (EJS-generated)
- "_csrf" (hidden); "previewId" (hidden); "previousSubmissionId" (hidden)

## records/term-clearance-templates.ejs:31 — POST /registrar/records/clearance/templates
- "_csrf" (hidden); "idempotencyKey" (hidden); "gradeLevel" (select; required options=[]); "trackLabel" (input; maxlength=80); "officeConfirmations" (checkbox); "teacherRosterConfirmed" (checkbox); "laboratoryRowsConfirmed" (checkbox)

## records/term-order-setup.ejs:17 — POST /registrar/intake/setup/terms
- "_csrf" (hidden); "schoolYear" (input; required, maxlength=20)

## registrar/schedules.ejs:16 — GET /registrar/schedules
- "termId" (select; required); "sectionId" (select options=[]); "assignmentId" (select options=[])

## registrar/schedules.ejs:43 — POST /registrar/schedules
- "_csrf" (hidden); "scheduleId" (hidden); "termId" (hidden); "filterSectionId" (hidden); "filterAssignmentId" (hidden); "assignmentId" (select; required options=[]); "dayOfWeek" (select; required); "startTime" (time; required); "endTime" (time; required); "room" (input; maxlength=80)

## registrar/schedules.ejs:133 — POST (EJS-generated)
- "_csrf" (hidden); "scheduleId" (hidden); "termId" (hidden); "filterSectionId" (hidden); "filterAssignmentId" (hidden)

## registrar/schedules.ejs:154 — POST (EJS-generated)
- "_csrf" (hidden); "termId" (hidden); "filterSectionId" (hidden); "filterAssignmentId" (hidden)

## student/grades.ejs:10 — GET /student/grades
- "semester" (select); "gradingPeriod" (select)
