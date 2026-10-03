# ARKTIESIIS interface system

## Direction

The shipped interface follows a calm school-app direction. Staff pages are task-oriented workspaces built around searchable records, enrollment, document review, and grade approval. Student pages make the current term and today's classes easy to find, followed by the student's own grades, balance, and document status. The public home foregrounds the Lucena campus and school identity, introduces portal benefits in community terms, and provides a concise path to sign-in and account help.

The interface uses near-white surfaces, deep readable ink, cool rules, and the school's restrained crimson for primary actions, focus, and selected destinations. A single system sans-serif family keeps tables, forms, headings, and controls familiar. Panels are compact; headings are direct; action lists and record rows carry the content without decorative dashboards.

## Shared shell and navigation

- The shared masthead keeps the official seal, ARKTIESIIS name, full institution name, and Lucena Branch.
- Desktop authenticated pages use a light grouped sidebar. Registrar destinations are grouped into student records, academic work, and setup, so all eight destinations remain visible without a horizontal strip. Account and sign-out actions remain in the header.
- Finance and database-administrator roles share six finance destinations in the Finance group: Overview, Roster, Fee schedules, Reports, Departure review, and Legacy account history. Finance begins at Overview; annual student accounts and statements stay under Roster, while legacy account details stay under Legacy account history. Mark only the matching destination current and keep these destinations out of duplicate title-row navigation.
- At tablet and phone widths, the sidebar is replaced by a native keyboard-operable disclosure menu. It contains all destinations available to the signed-in role. Role checks remain on the server.
- The page title and current task begin in the content area. Main content reflows structurally rather than shrinking labels to fit.

## Information hierarchy

### Staff

- Registrar overview starts with a compact school-year and configured-term toolbar, then shows the selected term's active enrolled count and a compact Grade 11/12 term chart linked to matching filtered records. Yearly, pending, departed, and methodology details remain secondary disclosures. Labeled student search and enrollment/review tasks follow. Subject catalog and teacher assignments sit in an academic-setup group.
- Database administration leads with account search and contiguous results, then offers student-record and audit workspaces. Adding a user is its single primary creation action.
- Student records lead with search and results; each result keeps identity, enrollment, document state, and a prominent record-opening action together. Academic terms and sections are available from the dedicated setup view.
- A student record keeps the learner identity visible above the shared Overview, Profile, Academics, Documents, and History destinations. Overview is concise; request processing remains on the existing staff ledger, and profile revisions have their own history view. Documents divide digital submissions, paper requirements, Form 137, and the request-ledger link into focused sections. Legacy document anchors remain usable when JavaScript is disabled.
- Annual enrollments are an existing-student lookup led by name or student number and school-year/term filters. The roster pages 20 annual records at a time, and each collapsed student summary opens to its matching term placements; counts and voucher, section, status, and activation controls stay in secondary disclosures. Teacher assignments group by section, schedules group by weekday within each section, and subject catalog rows can be searched and edited inline. Academic term, section, subject, and class-time create forms start collapsed while their existing records remain browsable.
- Finance begins with Overview, which compares per-term positive net payment allocations, settled term balances, and assessed terms with no payment required for the selected school year and optional grade in readable term rows with numeric values and one shared count scale. These groups may overlap; the labels remain visible while counting methodology is secondary. The searchable roster groups by annual enrollment and pages 20 annual records at a time. Each collapsed summary shows annual balance and any nonzero legacy/opening liability or required voucher review; term due, registrar confirmation, clearance, and section appear in expanded placement details. Fee schedule creation, saved-version lines, term-progress breakdowns, and departure review fields use native disclosures. Term progress is a current snapshot across recorded placements, independent of the collection date range. Student annual accounts and statements are reached from the roster, and legacy account details remain in their history context. Amounts use grouped peso formatting without changing stored values.
- Teachers see assigned classes led by subject, then term and placement, with the corrected-workbook submission path. Registrar review remains the publication gate for grades.
- Document pages keep missing states, staff review filters, submission history, and human decisions visible. Source inspection sits beside findings and the decision on wide screens and stacks on phones. Correction, rejection, versions, and history are secondary disclosures; deletion remains separate. Precheck wording stays advisory.

### Student

- The first screen shows the current term, a direct route to document status, and today's schedule.
- Enrollment details sit beside today's classes. Approved grades, the own finance ledger, profile, and document status follow below.
- Student finance leads with the combined account balance while showing available payment credit separately; balance details, term placement confirmation, signed clearance, and recent activity remain distinct. The complete ledger history is available in a disclosure.
- The profile is read-only in the student flow. Empty states explain what is not available and what the student can do next.

## Components and states

- Buttons share a compact 2.65rem minimum height. Crimson marks the primary action; bordered white controls are secondary; destructive actions remain explicit.
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
- Synthetic browser review covered public home/sign-in, primary pages for all five roles, and the registrar records, setup, student, documents, and intake flows at 1366px, 1440px, 390px, and 320px. The shared student-record tabs wrap and remain visible at both phone widths; no page-level horizontal overflow or console errors were observed. A synthetic PDF preview endpoint and its desktop/mobile iframe layout were exercised, but the viewer area rendered black, so readable document contents were not verified. Browser screenshots were inline and could not be exported by the available harness.
- Landing-page smoke checks cover school identity, the campus image and supplied seal, portal content, staff-led document decisions, account guidance, and direct sign-in. Final browser review at 1440px, 1366px, 390px, and 320px confirmed the page stays within the document width, the campus image leads on desktop and mobile, and the portal anchor, sign-in, and return-home paths work without browser errors or warnings.

## Accessibility and identity

- Keep a visible keyboard focus indicator, a skip link, semantic headings, labeled navigation groups, and explicitly labeled form controls.
- The navigation menu uses native `<details>` and `<summary>` controls on mobile.
- Maintain readable contrast on neutral and status backgrounds; do not communicate status by color alone.
- Preserve the supplied official seal and campus image unchanged. Do not invent school policy, document-verification claims, live operational counts, or spreadsheet compatibility.
