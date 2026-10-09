# ARKTIESIIS Process Flows

## 1. Sign in

1. The user enters their email and password.
2. The system emails a six-digit code. The user enters it to verify sign-in.
3. If the account requires a temporary-password change, the user sets a new password.
4. The system opens the user's role workspace. Regular sign-in does not issue a new temporary password.

## 2. Enroll a new student

1. **Front desk** enters the details from the paper form, records counts of documents received, and saves the entry. This creates only a paper pre-enrollment record, with no student number, login, enrollment, or charges.
2. **Registrar** opens the saved form and checks the student's identity, school year, grade, voucher, entry term, section, and enrollment date.
3. **Registrar** selects **Save and review fees**. The system creates a pending student record, assigns a student number, and leaves the login inactive. Fees are not added to the account yet.
4. **Registrar** reviews the fees that match the approved schedule and the selected optional fees. Reviewing the amount does not post charges.
5. **Registrar** selects **Confirm enrollment**. The system adds the reviewed fees to the student's account, enrolls the entry term, and activates the login for an eligible first-time student. It shows the temporary password once, privately; it does not email or print it. The student then signs in with email two-factor verification and changes the password.
6. Finance payment or account clearance is not required to confirm enrollment.

## 3. Continue, activate a later term, or return after a break

1. **Registrar** uses the existing student record and login for a continuing student. No new account or student number is needed.
2. For continuation or a later term, **Registrar** confirms the annual record and activates each applicable term with a valid section. Required paper clearance for earlier attended terms must be complete first. A term recorded as not attended, with a reason, is excluded; it does not count as completed clearance.
3. For a student returning after an interruption, **Registrar** selects **Evaluate return** on an eligible saved student record. The registrar reviews prior progress, curriculum, required subjects, and availability, then records a human decision. The system does not decide equivalency or admission automatically.
4. After the evaluation is accepted, **Front desk** saves a new paper form linked to that acceptance. **Registrar** confirms intake using the existing student profile and login. This does not create a new login or reset the password.

## 4. Review a student's digital documents

1. **Student** uploads a Good Moral Certificate, PSA birth certificate, or previous-school report-card scan for their own record as a PDF, JPEG, or PNG.
2. **System** checks the file format and asks Gemini for limited suggestions from visible fields. For a report card, it reads only the visible student name; it does not extract grades or other results. The app compares a suggested name with the linked student record.
3. **Authorized registrar or database administrator** inspects the original document and records a decision: verify, request correction, or reject. Gemini's result is advice, not acceptance.
4. If correction is requested, **Student** uploads a replacement and checks their own document status. The format check, suggestions, and staff review happen again.
5. If Gemini is unavailable, **Authorized staff** can still inspect the document and make a decision.

## 5. Record paper report-card and Form 137 histories

1. **Authorized staff** inspect a previous-school report-card paper copy and save its physical-copy status and history. The student sees only the latest status and date, without staff notes. This record does not create grades.
2. **Authorized staff** inspect the physical Form 137 and save its status in the separate staff-only history. Students cannot access this history.
3. A Form 137 scan for optional Gemini suggestions is temporary. The scan and suggestions are not saved as a file or database record; only the staff-recorded physical status and history remain.

## 6. Submit and approve grades

1. **Teacher** opens an assigned class, uploads the corrected SSHS E-Class Record Excel workbook, previews the matches, and submits it for review. Previewing and submitting do not write grades.
2. **Registrar** reviews the workbook, checks the class and student matches, selects eligible grades, and approves the import. Only registrar approval writes the selected grades. The registrar can request a correction; **Teacher** then submits a revised workbook.
3. **Student** views the approved grades in their own account. Document scans are not a source of grades.

## 7. Record payments and review Finance term clearance

1. **Finance** records the amount received, actual payment date, and receipt or reference number, then applies the payment to the intended assessed fees or terms.
2. **Finance** reviews where to apply the payment and saves it. This final save records the payment and allocations. Any amount left unapplied remains as account credit; applying existing credit does not record new money.
3. **Student** views their own fees and payment details. The Statement of Account is an account summary, not an official receipt.
4. Separately, **Finance** reviews and records a signed term account-clearance decision. If a balance remains, a payment arrangement is required for the decision; the debt remains owed. Finance clearance is separate from enrollment and paper clearance.

## 8. Complete registrar paper clearance for a later term

1. **Student** returns the completed, signed paper form.
2. **Registrar** inspects the whole form, then marks **Paper clearance completed** to confirm inspection. The current process does not track each signature separately.
3. **Registrar** checks that required earlier attended terms are complete before activating an eligible later term. A term recorded as not attended, with a reason, is excluded and is not marked complete. Finance account clearance cannot replace paper clearance.

## 9. Process a document request

1. **Registrar** records the student's document request.
2. **Finance** reviews the fee for that specific request and approves it or places it on hold. If a balance remains, any accepted arrangement does not erase the debt.
3. After **Finance** approves the request, **Registrar** records processing, marks the request ready, and records release with the date and recipient. The registrar may provide a claim slip.
4. This process tracks the request and handover. It does not create or send the requested document file.
