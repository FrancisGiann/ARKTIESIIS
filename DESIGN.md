# ARKTIESIIS interface system

## Direction

The shipped interface follows a calm school-app direction. Staff pages are task-oriented workspaces built around searchable records, enrollment, document review, and grade approval. Student pages make the current term and today's classes easy to find, followed by the student's own grades, balance, and document status. The public home explains the centralized records purpose and keeps the official school identity visible.

The interface uses near-white surfaces, deep readable ink, cool rules, and the school's restrained crimson for primary actions, focus, and selected destinations. A single system sans-serif family keeps tables, forms, headings, and controls familiar. Panels are compact; headings are direct; action lists and record rows carry the content without decorative dashboards.

## Shared shell and navigation

- The shared masthead keeps the official seal, ARKTIESIIS name, full institution name, and Lucena Branch.
- Desktop authenticated pages use a light grouped sidebar. Registrar destinations are grouped into student records, academic work, and setup, so all eight destinations remain visible without a horizontal strip. Account and sign-out actions remain in the header.
- At tablet and phone widths, the sidebar is replaced by a native keyboard-operable disclosure menu. It contains all destinations available to the signed-in role. Role checks remain on the server.
- The page title and current task begin in the content area. Main content reflows structurally rather than shrinking labels to fit.

## Information hierarchy

### Staff

- Registrar overview starts with a labeled search for name, student number, or LRN, followed by enrollment and review tasks. Subject catalog and teacher assignments sit in an academic-setup group.
- Database administration leads with account search and management, with direct links to student records and audit activity.
- The student master list keeps the student number, LRN, enrollment, Good Moral/PSA states, staff-only Form 137 physical status, and record actions together.
- Finance begins with student account search and puts enrollment payments, ledger posting, balance, and transaction history in context. Amounts use grouped peso formatting without changing stored values.
- Teachers see assigned classes and the corrected-workbook submission path. Registrar review remains the publication gate for grades.
- Document pages keep missing states, staff review filters, submission history, and human decisions visible. Precheck wording stays advisory.

### Student

- The first screen shows the current term, a direct route to document status, and today's schedule.
- Enrollment details sit beside today's classes. Approved grades, the own finance ledger, profile, and document status follow below.
- The profile is read-only in the student flow. Empty states explain what is not available and what the student can do next.

## Components and states

- Buttons share a compact 2.65rem minimum height. Crimson marks the primary action; bordered white controls are secondary; destructive actions remain explicit.
- Inputs have visible labels, a readable outline, and a clear focus ring. Disabled, error, success, warning, and informational states use consistent text and backgrounds.
- Tables remain dense enough for staff review. At narrow widths, ordinary tables expose their existing column labels as stacked values; transaction and long review histories keep a keyboard-scrollable table region where aligned columns help.
- Native disclosure controls handle mobile navigation and progressive details. Password-match, file-preview, and submitting feedback keep their existing behavior.
- Empty states describe the next useful action. Counts appear only when they directly describe saved records or review statuses; generic role-dashboard KPI strips are omitted.
- Reduced-motion preferences are respected. The interface does not use page-load choreography or decorative motion.

## Responsive behavior

- At 1532px, staff content uses a compact sidebar and a dense, readable work column.
- At 900px, the sidebar becomes a mobile disclosure menu.
- At 768px, multi-column forms, student panels, schedules, and review layouts stack.
- At 390px and 320px, header identity wraps, the menu remains operable, tables reflow or scroll in their labeled region, and the page has no horizontal layout overflow.

## Accessibility and identity

- Keep a visible keyboard focus indicator, a skip link, semantic headings, labeled navigation groups, and explicitly labeled form controls.
- The navigation menu uses native `<details>` and `<summary>` controls on mobile.
- Maintain readable contrast on neutral and status backgrounds; do not communicate status by color alone.
- Preserve the supplied official seal and campus image unchanged. Do not invent school policy, document-verification claims, live operational counts, or spreadsheet compatibility.
