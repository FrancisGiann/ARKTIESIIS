# Phase 11 — Dashboards and Reporting

This implementation adds compact count summaries to the existing role workspaces. It uses the current SQL Server schema and Express/EJS routes; it adds no schema changes, dashboard APIs, or dependencies.

## Dashboard summaries

- **Student:** own enrollment records, grade entries, permitted documents, and permitted documents still in processing or review. Every student count is scoped through `students.user_id = @actorId`; document counts include Good Moral Certificates, PSA birth certificates, and only the student's own active student-origin report cards. Legacy report-card rows remain staff archive records and are not counted. Form 137 remains a physical status workflow and is not counted as a stored document.
- **Registrar:** active and archived student records, current enrolled records, documents awaiting staff review (`needs_review` or `failed`), documents queued or processing OCR (`pending` or `processing`), and pending teacher grade workbooks.
- **Teacher:** assigned term/section/subject contexts, current enrolled roster counts, and each assignment's latest submission status.
- **Finance:** financial account counts by positive, zero, and negative balance, plus recorded charge and payment counts. The existing finance route permits `finance` and `database_admin` roles; the service query checks the active actor against those same roles.
- **Database administrator:** active/inactive user accounts, active/archived student records, and documents awaiting staff review. The summary query checks for an active `database_admin` actor.

All summary queries use a bound actor ID and return aggregate counts only. Student data is never selected by a URL or form student identifier. The existing route middleware continues to protect each role workspace, and summary services independently verify active role access. Finance summaries are not included in the registrar or student workspace.

These summaries report saved workflow states. OCR remains advisory and does not accept documents or establish authenticity. “Awaiting staff review” counts the stored `needs_review` and `failed` states; it does not make a school-policy decision.

## Verification

Focused service tests cover the role predicates, student ownership scope, parameterized actor IDs, and aggregate-only results. Existing route tests cover workspace authorization and student session ownership. Project checks are recorded in the Phase 11 handoff.
