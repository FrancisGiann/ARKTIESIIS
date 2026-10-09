# ARKTIESIIS feature and input verification

Run date: 2026-10-09 (Asia/Manila)

## Outcome

The audit corrected the report-card correction-access gate and added shared XLSX archive bounds for teacher and registrar imports. Follow-up HTTP checks also exposed and corrected a teacher multipart field-count mismatch, report-card success redirects to a locked detail page, and an annual-finance error-class mismatch for malformed search text. Three stale integration fixtures were aligned with their tools' supported schema versions, and the annual-intake collation fixture now uses the current ready pre-enrollment source contract. No production schema or applied migration was changed.

## Verification results

| Check | Result |
|---|---:|
| `npm run check` | Passed |
| `npm test` | 606 tests: 597 passed, 0 failed, 9 skipped |
| Gated MariaDB tests on an isolated `/tmp` socket | 10 tests: 10 passed, 0 failed, 0 skipped |
| `npm run test:document-clearance-mariadb` | Passed on an isolated v2.011 fixture |
| Focused document, teacher import, annual finance, and finance route tests | 99 tests: 99 passed, 0 failed |
| Post-fix browser runtime on synthetic MariaDB data | Report-card upload/re-upload, teacher XLSX preview → approval → student grade visibility, and finance NUL/valid search all passed |
| Independent v2.011 guard review | Passed; 12 focused tests independently passed |
| SMTP `verify()` | Transport authenticated; no email was sent |
| Bounded Gemini smoke check | One synthetic Good Moral PDF extracted successfully; only status and field count were recorded |

The nine default-suite skips are explicitly gated MariaDB tests. With their disposable socket variables set, all ten test cases passed, including the two reset cases. The separately invoked document-clearance integration script also passed. Scratch databases used synthetic fixtures only; the configured school database was not selected.

An authenticated HTTP pass checked 31 representative paths for each of the six roles (186 role/path requests), covering dashboard, navigation, role-gated pages, malformed filters, and static assets. A separate malformed/protected-request matrix returned controlled statuses (3×401, 13×400, 1×403, 1×404, and 1×200 generic reset; a repeated account-email action later returned the configured 429). That matrix checked response handling, not database persistence after each rejection. A post-fix Chrome DevTools run then completed synthetic report-card upload and correction re-upload, teacher workbook preview through registrar approval and student grade visibility, and finance NUL-search rejection plus a valid search. DOM, upload, and network evidence is retained in `/tmp/arktiesiis-fixed-runtime-verification.md`. The CUA browser surface was unavailable, so no CUA-specific coverage is claimed.

The Gemini request used `tests/fixtures/document-precheck/good-moral-clear.pdf`, a fictional sample identified as synthetic in that fixture directory's README. The existing adapter enforced its configured timeout and response bounds. The result values were not printed, and the in-memory sample buffer was cleared after the request. SMTP verification tested the configured transport only and did not submit a message. No external email was sent.

## Corrected behavior

### Report-card source access

Student document lists retain safe report-card status and date metadata. They mask filenames and file properties when source access is closed. The service checks the latest governing review or decision for the latest active student-origin version before returning document detail or opening a preview/download. A current correction request permits the source and correction upload; a later final decision, a superseding child, a newer active report card, a different owner, archive row, or staff-origin report card does not. Staff access remains available under existing role rules, and pre-lifecycle archive rows remain read-only and staff-only. The detail page hides source links when denied; service authorization still rejects guessed URLs.

Tests cover pending/needs-review without correction, correction permission, final decision revocation, stale correction history, superseded/newer versions, verified status, owner mismatch, archive and staff-origin rows, staff access, list metadata, detail/download access, and re-upload rules. `tests/document-report-card-access-mariadb.integration.test.js` also runs the correction lifecycle against live MariaDB predicates rather than relying only on mocked SQL results.

The browser run confirmed that a student upload and correction re-upload each return to `/documents?notice=uploaded` and show safe status without a source link. A staff correction unlocks only the current active version; staff verification removes the student's detail, preview, download, and re-upload access again.

### Multipart and malformed-search handling

The teacher workbook form sends two text fields (`_csrf` and `contextKey`) plus one workbook file. Multer now permits those exact two fields and three parts, caps each text field at 256 bytes, and continues to cap the workbook at 5 MiB. The route derives the preview context from the teacher's live server-side assignment; a submitted `contextKey` cannot select another section or subject. HTTP tests exercise the ordinary form, an extra third field, a forged context value, and the subsequent preview/submit/registrar-approval route sequence.

Annual finance roster search now translates only the shared validator's typed `FinanceServiceError` into `AnnualFinanceError`, matching the route's established client-validation response handling. Both roster service entry points reject malformed text before database access; the authenticated NUL query returns HTTP 400 with a validation message, not a generic 503. Other search validators and unexpected database errors retain their existing handling.

### XLSX archive bounds

`src/services/gradeImportService.js` applies `src/utils/inspectXlsxArchive.js` at the shared preview boundary before invoking `read-excel-file`, covering teacher submissions and registrar imports. The existing 5 MiB compressed-file limit remains. Archive inspection caps 128 entries, 8 MiB expanded per entry, and 32 MiB expanded total; it checks actual inflate output, CRCs, local/central directory consistency, and data descriptors. It rejects malformed, encrypted, ZIP64, unsupported-compression, oversized, and inconsistent archives with a bounded validation error. Tests prove valid STORE/DEFLATE and signed/unsigned descriptor preflight compatibility, and reject expanded-size, entry-count, metadata-spoofing, malformed, encrypted, ZIP64, and unsupported-compression fixtures before calling the workbook parser.

The caps are finite and tested with small synthetic workbooks. They have not been calibrated against a full corrected SSHS workbook from the school. Inflating an accepted archive is synchronous and can consume CPU up to these finite limits per request.

### Integration fixtures and maintenance schema gates

The annual-intake collation integration now creates a ready `front_desk` pre-enrollment source and converts it with the stored source ID, version, and fingerprint; its existing mixed-collation and idempotent-replay assertions remain. Its disposable fixture must be migrated through current v2.018 because the scenario exercises current intake and clearance tables.

Reset, academic expansion, and legacy finance cleanup integration fixtures now stop at their tools' exact historical schema versions (v2.017, v2.011, and v2.015). Destructive version gates remain strict. Both v2.011 expansion tools use an explicit required-object inventory matched to the baseline plus migrations through v2.011, instead of importing the current global inventory containing later-schema objects. Tests verify newer-schema refusal and refusal before writes when a v2.011-critical object is missing.

## Feature and input coverage

Static review counted 198 route registrations across 13 route modules, 84 EJS templates, 135 locally parsed forms, and 633 named controls inside those forms. EJS conditionals and generated forms mean these figures inventory source occurrences, not every rendered permutation. The shared student/emergency address partial contributes additional controls to parent forms. Thirteen client-side JavaScript files were included in the source review.

| Feature group | Input families reviewed | Verification evidence and boundary |
|---|---|---|
| Authentication, recovery, 2FA, account | Email/password; reset IDs/tokens; six-digit OTP; resend/cancel; current/new/confirmation passwords; email change; session revocation; CSRF | Auth tests cover wrong, expired, replayed, and rate-limited OTPs, session rotation/revocation, password reset, generic recovery responses, and CSRF. A six-role scratch HTTP crawl covered landing and protected pages. SMTP transport verification succeeded without sending an email; no actual recipient message or reset message was sent. |
| Administration and bulk setup | Role, email, staff profile, active flag, password; account/audit filters and pagination; bulk roster workbook and preview token | Role and field validators, CSRF, rollback, pagination, and workbook expansion limits are covered by tests. Representative admin pages were crawled. No live account or roster upload mutation was submitted. |
| Front-desk pre-enrollment and readmission | Names/LRN/contact, school year, grade/track/cluster, signature/receipt/status; receipt counts; student/emergency addresses and same-address mode; readmission evidence and status | Unit tests exercise required values, identity/date/phone bounds, address preserve/replace/copy behavior, receipt constraints, and role separation. Pre-enrollment MariaDB integration exercised synthetic create, recovery, receipts, conversion, and grade-overview behavior. |
| Student records and academic setup | Student number/LRN/name/demographics/contact/address; term/year/current flag; section/grade/track/adviser; subject code/name/units; enrollment and subject assignment IDs; archive/deactivation confirmation | Unit tests validate bounded strings, numeric IDs, dates, phone/LRN formats, allowlists, term/section binding, duplicate records, and archive write restrictions. Role pages and cross-role refusals were crawled; populated HTTP record mutations were not performed. |
| Teacher assignments, workbook import, grade review | Term/section/subject/teacher assignment; workbook extension/MIME/signature/size/archive; context and preview IDs; LRN/name/cached grades; include/replacement/review reasons; registrar decision | Unit tests cover ownership and revocation, row matching, cached formulas, grade range/precision, stale snapshots, idempotency, and rollback. XLSX archive limits run before parser invocation. The teacher multipart route test verifies the rendered two-field upload, rejects an extra field, sends a forged context key and asserts the server-derived assignment context is used, and exercises preview, submit, and registrar approval. The browser run uploaded a valid synthetic workbook, approved its grade conflicts, and confirmed the grade appears for the student only after approval. The separate browser-side context tamper attempt did not complete after the scratch socket stopped; server-context binding is covered by the HTTP route regression. |
| Class schedules | Term/section/assignment, weekday, start/end time, room | Validators and route tests cover weekday/time bounds, positive IDs, term and active-assignment relationships, overlap checks, adjacent boundaries, and CSRF. No live schedule form mutation was submitted. |
| Finance and reports | Roster filters; annual fee lines; amount/date/reference/receipt; allocations; adjustment/waiver/departure; clearance; revision/draft/version; report type/date/page | Tests cover integer-cent parsing, decimal/sign/zero/overflow limits, duplicate targets, row/array bounds, expected versions, snapshot dependencies, transactions and replay. MariaDB finance browse and document-finance-clearance integrations passed. Browser and route tests verify a malformed NUL search returns 400 and valid search returns 200. Payment, statement, and annual-finance write workflows were not submitted through HTTP. |
| Digital documents, paper records, Form 137 | Document type/file/MIME/extension/signature/size; correction/review reason/checklist; physical-copy status/count/note; Form 137 scan; document-finance request/decision | Service/route tests cover own-student linking, staff roles, private storage, allowed formats and size, correction lifecycle, archive read-only access, Form 137 scope, paper history, and no grade writes. Reviewer negative-input HTTP cases were controlled (3×401, 13×400, 1×403, 1×404, 1×200 generic reset); no 5xx or raw diagnostic was observed. The MariaDB correction lifecycle passed. |
| Student self-service and navigation | Own term/grade period/schedule, account/statement/history, own record/clearance, document and physical-copy status | Authenticated student pages and access boundaries were crawled. Student document list still exposes safe status/date metadata while the report-card source is closed. No cross-student source bytes were returned. |
| Dashboards, filters, errors, responsive UI | Role landing paths, search/status/page filters, malformed IDs, health and unknown paths; public forms/assets at multiple widths | Six roles completed login in the prior HTTP runtime crawl; 31 representative role/path combinations per role (186 requests) checked canonical pages and role denials. Malformed input produced controlled 400/empty/default responses; no 5xx or raw query reflection was seen. Public home/login/recovery pages were checked at three widths. No committed visual baseline exists. |

Input boundary review covered integer/date/time values, text lengths and schema columns, allowlists/select values, hidden IDs and CSRF, duplicate form keys/array limits, search and pagination, money precision and range, term/section/subject relationships, schedule overlap, ownership, and file MIME/extension/content. The [static route and form input inventory](feature-input-inventory-2026-10.md) lists the reviewed form actions and named controls. No new weakness was confirmed in these reviewed validator paths.

## Remaining limits

- No production data, configured school database, or real student document was used. All connected database verification used isolated scratch schemas under `/tmp` and synthetic records.
- A full school-corrected SSHS XLSX was not available to calibrate the 128-entry/8 MiB/32 MiB bounds.
- SMTP was verified without sending. No email-based 2FA or reset message was delivered to a mailbox. Gemini was exercised with one synthetic PDF only; this does not establish representative extraction accuracy or provider reliability.
- The 186-request role/path matrix was HTTP-only. Chrome DevTools supplied DOM and network evidence for the named browser workflows, but did not visually inspect every route or page. Finance payment, statement, account change, annual intake, and readmission were not submitted through HTTP.
- One successful bounded Gemini response does not prove every allowed document format or provider failure mode. Production multi-process worker limits and proxy/session persistence were not exercised.
- The UI has no committed visual regression baseline, so visual comparison remains inconclusive.
- The temporary app is stopped and the owned MariaDB process/socket are no longer running; I verified port 3111 and the socket are closed. The pre-existing system MariaDB process was left untouched. The private `/tmp/arktiesiis-feature-fix-mariadb` datadir remains because the shell safety gate rejected recursive deletion. It contains only the synthetic audit schemas.
