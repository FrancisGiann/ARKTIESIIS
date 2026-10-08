# ARKTIESIIS interface system

## Direction

The shipped interface follows a calm school-app direction. Staff pages are task-oriented workspaces built around searchable records, enrollment, document review, and grade approval. Student pages make the current term and today's classes easy to find, followed by the student's own grades, balance, and document status. The public home foregrounds the Lucena campus and school identity, introduces portal benefits in community terms, and provides a concise path to sign-in and account help.

The interface uses near-white surfaces, deep readable ink, cool rules, and the school's restrained crimson for primary actions, focus, and selected destinations. A single system sans-serif family keeps tables, forms, headings, and controls familiar. Panels are compact; headings are direct; action lists and record rows carry the content without decorative dashboards.

## Shared shell and navigation

- The shared masthead keeps the official seal, ARKTIESIIS name, full institution name, and Lucena Branch.
- Desktop authenticated pages use a light grouped sidebar. Registrar destinations are grouped into student records, academic work, and setup. The front desk has only pre-enrollment records. Account and sign-out actions remain in the header.
- On desktop, the sidebar stays in view while the page scrolls and scrolls internally when its links exceed the viewport. The main content keeps its natural page height. At tablet and phone widths, the native menu disclosure remains in normal document flow.
- Finance and database-administrator roles share six finance destinations: Overview, Student accounts, Fee schedules, Reports, Stopped or transferred, and Unfinished reviews. Finance begins at Overview; annual student accounts, statements, and retained historical account details stay under Student accounts, with historical entries available through annual account History and Statements of Account. Mark only the matching destination current and keep these destinations out of duplicate title-row navigation.
- At tablet and phone widths, the sidebar is replaced by a native keyboard-operable disclosure menu. It contains all destinations available to the signed-in role. Role checks remain on the server.
- The page title and current task begin in the content area. Main content reflows structurally rather than shrinking labels to fit.

## Information hierarchy

### Staff

- Registrar overview starts with the compact school-year and term selectors and the selected term's active, Grade 11, and Grade 12 counts linked to matching filtered records. Term comparisons and methodology remain secondary disclosures. Student search follows, then a concise all-school-year **Needs your review** list with exact saved-state filters for ready paper intakes, annual confirmations, latest digital submissions, and teacher grade submissions. A failed count appears unavailable without removing search; authorization refusals remain refusals. Setup destinations stay in secondary navigation.
- Database administration starts with concise links to separate student and staff account directories, student records, and audit activity; the directories filter and page through all matching accounts, and adding a user stays directly available. Audit activity uses compact searchable, paginated rows that show Manila time, actor, action, and record.
- Student records lead with search and results; each result keeps identity, enrollment, document state, and a prominent record-opening action together. Academic terms and sections are available from the dedicated setup view.
- A student record keeps the learner identity visible above the shared Overview, Profile, Academics, Documents, and History destinations. Overview gives a next action from saved annual-intake context and names each linked school year; without a current paper-intake link it points to front-desk intake review and academic history. Return evaluation remains limited to saved departure or gap eligibility. Profile shows term history and direct annual-record links; correction controls are limited to existing source-less historical terms. Documents divide digital submissions, paper requirements, staff-only Form 137, and the request-ledger link into focused sections, with the same tabs retained on Requests. Legacy document anchors remain usable when JavaScript is disabled.
- Annual enrollments are an existing-student lookup led by name or student number and school-year/term filters. The list pages 20 annual records at a time, and each student-year row opens to its matching term placements; counts and voucher, section, status, and activation controls stay in secondary disclosures. Teacher assignments group by section, schedules group by weekday within each section, and subject rows can be searched and edited inline. Academic term, section, subject, and class-time create forms start collapsed while existing records remain browsable.
- Finance begins with Overview, which has a direct name/student-number search to the Student accounts list, with term status counts and exceptional review queues below. School year, term, and payment period lead into five linked payment-status counts, including zero-count links; grade, section, and voucher filters stay in a secondary disclosure that opens when selected. The searchable Student accounts list groups by annual enrollment and pages 20 records at a time. Each collapsed summary shows annual balance and any nonzero earlier balance or required voucher review; term due, registrar confirmation, Finance term account clearance, and section appear in expanded placement details. Annual student account Overview separates all-years fees due, earlier account balances, confirmed previous balances, and unused payment credit. It offers Record a payment as the primary action and keeps the Statement of Account secondary. The fee breakdown labels the latest assessed school year and amount, expands its year and term fee rows, and keeps earlier-year detail collapsed; term context is described as already included, and payment credit stays separate until applied. Payments keep required amount, date, receipt, and allocation choices visible while optional transmittal references and private notes use a recoverable disclosure. Finance reports lead with report-view tabs, then group the date range, Run reports action, and Manila date shortcuts together. Fee schedule creation, saved-version lines, term status breakdowns, and stopped-or-transferred review fields use native disclosures. Document request fee review actions name that decision separately from Finance term account clearance. The five payment categories and all their filters preserve their existing query values. Amounts use grouped peso formatting without changing stored values.
- Front-desk staff use the paper pre-enrollment form and receipt counts only. The required source remains visible during registrar enrollment; receipt counts do not mark documents inspected or accepted.
- The registrar's dedicated Paper clearance workspace records only Not completed or Completed for each applicable student term. The one **Paper clearance completed** checkbox records the registrar's inspection attestation, with the authenticated operator, Manila inspection date, and audited history saved automatically. Reopening a saved completion requires a reason. A separate collapsed registrar control can correct whole-term applicability to not attended for eligible past/current placements; it requires a reason and remains outside the routine checkbox form. Old signature-checklist evidence remains historical and read-only; new records do not require templates or fabricated signature rows. Not completed does not describe signature collection. The student record keeps a concise safe summary and link; students see only their own status. Finance term account clearance and document request fee review are separate decisions.
- Teachers see assigned classes led by subject, then term and placement, with the corrected-workbook submission path. Registrar review remains the publication gate for grades.
- Document pages keep missing states, staff review filters, submission history, and human decisions visible. Source inspection sits beside findings and the decision on wide screens and stacks on phones. Correction, rejection, versions, and history are secondary disclosures; deletion remains separate. Precheck wording stays advisory.

### Student

- The first screen shows the current term, a direct route to document status, and today's schedule.
- Enrollment details sit beside today's classes. Approved grades, the own finance ledger, profile, and document status follow below.
- Student finance leads with the combined account balance while showing unused payment credit separately; balance details, registrar enrollment confirmation, Finance's term account clearance, and recent activity remain distinct. The complete ledger history is available in a disclosure.
- The profile is read-only in the student flow. Empty states explain what is not available and what the student can do next.

## Components and states

- Buttons, form controls, navigation items, row actions, tabs, and disclosure summaries target at least 44px where practical. Native checkbox and radio geometry remains unchanged. Crimson marks the primary action; bordered white controls are secondary; destructive actions remain explicit.
- Inputs have visible labels, a readable outline, and a clear focus ring. Disabled, error, success, warning, and informational states use consistent text and backgrounds.
- Tables remain dense enough for staff review. At narrow widths, ordinary tables expose their existing column labels as stacked values; transaction and long review histories keep a keyboard-scrollable table region where aligned columns help.
- Native disclosure controls handle mobile navigation and progressive details. Password-match, file-preview, and submitting feedback keep their existing behavior.
- Empty states describe the next useful action. Dashboard counts describe saved enrollment or finance workflow states and link to relevant work where a matching filtered view exists; generic role-dashboard KPI strips are omitted.
- The public entry page, sign-in flow, and all role workspaces share the same light surfaces, readable ink, restrained school crimson, visible focus, and supplied seal. Role-specific task order and server-side access remain intact.
- The public entry page opens with a full-width Lucena campus photograph and an overlaid welcome panel with school identity and direct sign-in. Distinct school-day and document-status moments lead to a crimson school-community close with brief account guidance. The page uses the near-white and restrained school-crimson palette without turning into a role directory or procedural guide. Sign-in keeps status messages and the applicable development, demo, or email-verification instruction together with the credential form. Student quick links follow today's classes.
- Reduced-motion preferences are respected. The interface does not use page-load choreography or decorative motion.

## Responsive behavior

- At 1532px, staff content uses a compact sidebar and a dense, readable work column.
- At 900px, the sidebar becomes a mobile disclosure menu.
- At 768px, multi-column forms, student panels, schedules, and review layouts stack.
- At 390px and 320px, header identity wraps, the menu remains operable, tables reflow or scroll in their labeled region, and the page has no horizontal layout overflow.
- Screen-level review evidence is tracked in `docs/25-ui-ux-review.md`. It identifies the specific routes, templates, states, tests, and browser evidence reviewed; a template compile check alone is not reported as visual verification. Synthetic fixtures are labeled and do not access a database or perform writes. Any unreadable viewer or otherwise unverified content is explicitly marked.

## Accessibility and identity

- Keep a visible keyboard focus indicator, a skip link, semantic headings, labeled navigation groups, and explicitly labeled form controls.
- The navigation menu uses native `<details>` and `<summary>` controls on mobile.
- Maintain readable contrast on neutral and status backgrounds; do not communicate status by color alone.
- Preserve the supplied official seal and campus image unchanged. Do not invent school policy, document-verification claims, live operational counts, or spreadsheet compatibility.
