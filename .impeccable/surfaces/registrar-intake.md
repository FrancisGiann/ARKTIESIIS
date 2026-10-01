<!-- Surface-specific brief for the guided annual registrar intake. -->

# Registrar annual intake

Mode: Operate

## User and setting

A registrar records a new, returning, or midyear-transfer student during a front-desk enrollment task. The user may be speaking with a student while completing the form and needs to move through it without losing entered information.

## Success

Create one annual enrollment, record only paper updates explicitly collected at intake, review the configured payable fees, and confirm enrollment with the entry term active. Finance records payments later. Missing paper requirements do not block enrollment.

## Flow

1. **Student** — create a new profile or use a known existing student number. Link to the student finder when the number is unknown.
2. **Enrollment** — choose school year, grade, voucher reference, entry term, start date, and section. The same annual section is the default; the registrar can choose different term sections when needed. Future placements may stay unassigned.
3. **Documents received** — mark only the paper updates collected now. Status and counts are explicit. Existing checklist history is preserved, missing papers remain nonblocking, and SF10/Form 137 keeps its separate staff-only workflow.
4. **Fees and confirmation** — review required charges, selected optional items, approved coverage, term subtotals, and the payable total. Confirming saves the exact reviewed assessment and activates the entry placement. Payment entry remains a finance task.

“Save and review fees” saves a recoverable pending intake and selected paper events atomically; it is not confirmation. Back and Continue preserve form values. Server validation remains authoritative when scripts are unavailable. Errors name the issue and focus the relevant step. Duplicate submissions replay the saved result without issuing credentials again.

## Guardrails

- A returning student keeps the existing profile, login state, and document history; do not reset credentials.
- Resolve other term sections only by one exact school-year/grade/name/cluster/strand match. Show the result; ask for a separate choice or leave a future term open when ambiguous or absent.
- A transferee starts at the selected term. Earlier terms remain not applicable and are excluded from fees and academic rosters.
- Do not expose balances, payment history, receipt details, finance notes, or finance-only adjustments to the registrar. The payable assessment is visible because confirming that amount is part of intake.
- Do not collect scans or imply that document precheck happens in this flow. Paper checklist events remain distinct from uploads and AI processing.

## Visual and interaction direction

Preserve the existing ARKTIESIIS school identity, light workspace, readable ink, and restrained crimson for the primary action and current step. Keep one focused step visible, one primary action per step, direct labels, and a compact progress indicator. On phones, use short visible step names while retaining the full accessible names. Keep the payable total and term subtotals near “Confirm enrollment”; put long itemized fee lines in a clearly labeled native disclosure. Avoid decorative metric cards and nested panels.

The form must remain keyboard-operable and readable at 320px. Use native select, checkbox, details, and disclosure behavior where appropriate. Do not store personal form data in browser storage.
