# ARKTIESIIS School Records Workspace

ARKTIESIIS is a centralized school records system for Ark Technological Institute Education System Incorporated, Lucena Branch. Staff can find a learner by name, student number, or LRN and review the profile, enrollment history, academic records, Good Moral and PSA status, digital and paper previous-school report-card records, and staff-only Form 137 physical-record status together. Document review and reliable record maintenance are the core workflows; the student portal provides secondary self-service access to each student's own records.

## Main workflows

- **Registrar:** search the student master list; review and correct paper pre-enrollment records at `/pre-enrollments`; start annual enrollment only after a paper record is marked Ready for registrar; guide new, returning, and transfer intake through student details, enrollment, documents received, fee confirmation, and prior-term paper-clearance review; reuse existing profiles for returning students; maintain voucher and per-term section placement; manage terms, sections, subjects, assignments, and weekly class schedules; review documents; approve teacher grade submissions. The registrar transcribes signatures from the school’s printed form into each student's Clearance tab and attests after inspecting the paper. Finance handles payments and its separate finance-clearance records. The shared finance roster at `/finance` reflects current registrar placements. The staff-only `/documents/physical` workspace includes the separate paper checklist, Form 137 and previous-school report-card paper status. Student records include staff-only document request/release history, missing-grade overview, and profile change history. See [Registrar and finance workflows](docs/16-registrar-finance-workflows.md).
- **Front desk:** record, search, view, and correct paper pre-enrollment details and receipt counts at `/pre-enrollments`. Drafts may be saved with missing paper details. Front desk staff cannot access student master records, grades, finance, documents, or account administration and cannot start enrollment.
- **Database administrator:** manage accounts and audit activity; search and maintain student records; oversee documents and finance records; view pre-enrollment records and history without editing them. The database administrator shares the staff-only physical-requirements workspace with the registrar.
- **Teacher:** `/teacher` shows the assigned-class overview; `/teacher/grades` opens the grade submission picker and links to each assigned class upload. Upload the corrected SSHS E-Class Record workbook for an assigned term, section, and subject. Uploads create a review submission and never write grades. The registrar approves the matched rows atomically.
- **Finance:** review per-term payment, settled-balance, and no-payment-required summaries at `/finance/overview`; use the annual roster at `/finance` to configure versioned student-payable schedules, record date-specific payments and allocations, sign term-end clearances, and issue printable Statements of Account. Finance does not approve enrollment; finance data stays out of registrar views.
- **Student:** `/student` is a current-day overview. Separate Schedule, Grades, Finance, and My records pages show only the authenticated student's class schedule, registrar-approved grades, own read-only ledger, and profile/enrollment history. Documents remain on their own page.

Students may upload a scan of a previous-school report card only for their own linked record. A bounded Gemini precheck compares the visible student name and checks the supported file format; staff inspect the source and make every final decision. The precheck does not extract or change grades. Pre-lifecycle report-card archive rows remain staff-only and read-only, outside the processing and retry queues. Staff can separately record the paper copy brought to school, with its own status history; students see only the latest status/date. The paper-copy status vocabulary is a prototype assumption and requires school review. Form 137 keeps its own staff-only physical-status workflow; temporary scan suggestions are not saved.

## Data entry and spreadsheet support

Front desk transcribes the required paper form; the registrar reviews its saved profile and supplies placement and finance classification before creating an annual enrollment. Applicants returning after a break need an accepted registrar return evaluation before paper intake. New numbers are assigned from the selected academic year's start year in the provisional format `SHS-YYYY-0001`; the sequence continues after the highest matching number in the configured MariaDB database. Admin-created profiles use the current academic year. The format is a prototype convention pending school confirmation. A bulk student-login workbook can link existing unlinked student records; it does not import student records. The teacher grade workflow supports the corrected SSHS E-Class Record format that its parser recognizes and requires the teacher's active class assignment. It is not a general-purpose spreadsheet importer. Other school spreadsheets are not assumed compatible; use the front-desk paper intake and registrar record workflows until the school provides and approves a stable import template.

## Stack

- Node.js 20+, Express, EJS, HTML/CSS/JavaScript
- MariaDB using the `mysql2` prepared-query driver
- Google Gemini API through built-in Node.js `fetch` for bounded field extraction
- Email-based two-factor authentication

## Local setup

1. Copy `.env.example` to `.env`; set the existing MariaDB host, port, database name, username, and password, plus SMTP settings, a session secret, and any Gemini configuration needed for document prechecks. Keep `.env` private.

   For local development, use the MariaDB listener (normally port `3306`). SQL Server's usual port `1433` and legacy `DB_SERVER` settings do not configure this app. Use a separate local database; matching application code and migrations do not copy Hostinger accounts, records, or uploaded files.
2. Install the locked dependencies with `npm ci`.
3. Create an empty MariaDB database and its user in your local MariaDB or Hostinger hPanel. Hostinger supplies prefixed names; copy them exactly into `.env`. The app setup never creates a database.

   On Linux, `npm run db:local:start` can run an isolated, user-owned MariaDB instance on `127.0.0.1:3307`; it needs the installed `mariadbd`, `mariadb-install-db`, `mariadbd-safe`, and standard `getent`, `stat`, `flock`, and `setsid` tools. It stores data under `~/.local/share/arktiesiis/local-mariadb` and does not change a system MariaDB instance. Use `npm run db:local:status` and `npm run db:local:stop` to manage it. Create a separate local database and scoped user there, then put those local values in `.env`.
4. Initialize and check the selected empty database once:

   ```bash
   npm run db:setup
   npm run db:check
   ```

   Setup targets the database selected by `DB_NAME`, applies `database/mariadb/schema.sql` (`v2.001`) only when that database is empty, then applies each forward-only MariaDB migration through `v2.017`. Migration 017 adds approved paper-clearance templates, per-term applicability and signature history, and audited continuity-source links without changing existing confirmation history. Migrations 013–014 group authoritative Finance balances and do not rewrite financial rows. Setup does not create or drop databases and never runs automatically at app startup. The earlier SQL Server schema and migrations remain unchanged and are not applied to MariaDB.

5. For an empty real database, create the first administrator with `npm run admin:bootstrap`. Password input is hidden and is never accepted as a command-line argument. If deploying the Hostinger dummy dataset, skip this command and follow the one-time `demo:seed-hostinger` path in [the Hostinger deployment guide](docs/17-hostinger-mariadb-deployment.md); that seed creates its own administrator, and the two paths cannot be combined.
6. Start the app with `npm run dev` and open `http://localhost:3000`.

Email 2FA is required outside the explicit development-only password bypass. The bypass needs both `NODE_ENV=development` and `DEV_PASSWORD_ONLY_LOGIN=true` and is restricted to loopback. Configure a working SMTP relay for regular sign-in.
The login-attempt limiter is skipped only while that development password-only mode is enabled; OTP and non-development login limits remain active.

## Local demo seed

The minimal MariaDB seed creates repeatable demo accounts and one student, term, section, subject, enrollment, four grades, a teacher assignment, and an empty finance account. It only inserts missing reserved demo rows and stops if their identifiers are already used by incompatible records. It does not create financial transactions, document files, or school-approved fee rates; it is smaller than the expanded Hostinger demo and does not copy hosted records or files. Set `DEMO_SEED_PASSWORD` to a private 12–72 byte password, and enable `DEV_PASSWORD_ONLY_LOGIN=true` only in local development so the `.test` demo emails can sign in without a real mail relay. Seed application is limited to `NODE_ENV=development`, a loopback database host, and a database name containing `demo`, `dev`, or `test`.

```bash
npm run demo:seed-school -- --dry-run
npm run demo:seed-school -- --apply
```

The shared password is never printed or written to the repository. There is no demo reset command; use a new empty local demo database when you need to restart the example.

## Checks

```bash
npm run check
npm test
npm run db:check
```

The test suite uses mocked SQL/HTTP services for authorization and transaction failure cases. Live MariaDB setup and seeded-data verification use separate disposable databases. Never point setup, seeds, or integration probes at a configured school database.

## Database history

`database/schema.sql`, `database/v2/`, and their SQL Server migrations are retained as inert history. For this MariaDB prototype, use only `database/mariadb/schema.sql`, `database/mariadb/migrations/`, `scripts/db-setup-v2.js`, and `scripts/check-db.js`. Never edit or rerun applied baselines/migrations to update an initialized database.
