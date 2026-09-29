# ARKTIESIIS School Records Workspace

ARKTIESIIS is a centralized school records system for Ark Technological Institute Education System Incorporated, Lucena Branch. Staff can find a learner by name, student number, or LRN and review the profile, enrollment history, academic records, Good Moral and PSA status, both channels for previous-school report-card enrollment requirements, and staff-only Form 137 physical-record status together. Document review and reliable record maintenance are the core workflows; the student portal provides secondary self-service access to each student's own records.

## Main workflows

- **Registrar:** search the student master list; update records and enrollment; manage terms, sections, subjects, assignments, and weekly class schedules; review documents; approve teacher grade submissions. The staff-only `/documents/physical` workspace searches active students by name, student number, or LRN and links directly to per-student Form 137 and paper previous-school report-card status forms. Uploaded digital documents stay in the separate `/documents` search and review list. Assignment and schedule workspaces default to the marked current term, filter by section, and keep prior assignments available under history. Each active class links directly to its schedule form.
- **Database administrator:** manage accounts and audit activity; search and maintain student records; oversee documents and finance records. The database administrator shares the staff-only physical-requirements workspace with the registrar.
- **Teacher:** `/teacher` shows the assigned-class overview; `/teacher/grades` opens the grade submission picker and links to each assigned class upload. Upload the corrected SSHS E-Class Record workbook for an assigned term, section, and subject. Uploads create a review submission and never write grades. The registrar approves the matched rows atomically.
- **Finance:** manage student charges, payments, balances, and enrollment clearance.
- **Student:** `/student` is a current-day overview. Separate Schedule, Grades, Finance, and My records pages show only the authenticated student's class schedule, registrar-approved grades, own read-only ledger, and profile/enrollment history. Documents remain on their own page.

Students may upload a scan of a previous-school report card only for their own linked record. A bounded Gemini precheck compares the visible student name and checks the supported file format; staff inspect the source and make every final decision. The precheck does not extract or change grades. Pre-lifecycle report-card archive rows remain staff-only and read-only, outside the processing and retry queues. Staff can separately record the paper copy brought to school, with its own status history; students see only the latest status/date. The paper-copy status vocabulary is a prototype assumption and requires school review. Form 137 keeps its own staff-only physical-status workflow; temporary scan suggestions are not saved.

## Data entry and spreadsheet support

Registrar intake creates student profiles and enrollment records. New numbers are assigned from the selected academic year's start year in the provisional format `SHS-YYYY-0001`; the sequence continues after the highest matching number in `ARKTIESIIS_V2`. Admin-created profiles use the current academic year. The format is a prototype convention pending school confirmation. A bulk student-login workbook can link existing unlinked student records; it does not import student records. The teacher grade workflow supports the corrected SSHS E-Class Record format that its parser recognizes and requires the teacher's active class assignment. It is not a general-purpose spreadsheet importer. Other school spreadsheets are not assumed compatible; use the registrar forms until the school provides and approves a stable import template.

## Stack

- Node.js 20+, Express, EJS, HTML/CSS/JavaScript
- Microsoft SQL Server
- Google Gemini API through built-in Node.js `fetch` for bounded field extraction
- Email-based two-factor authentication

## Local setup

1. Copy `.env.example` to `.env`; set SQL Server credentials, SMTP settings, a session secret, and any Gemini configuration needed for document prechecks. Keep `.env` private.
2. Install the locked dependencies with `npm ci`.
3. Start the local SQL Server container if needed: `docker compose up -d sqlserver`.
4. Initialize and check the dedicated prototype database:

   ```bash
   npm run db:setup
   npm run db:check
   ```

   These commands target **`ARKTIESIIS_V2`**, its consolidated baseline at `database/v2/schema.sql`, and idempotently apply the new forward-only V2 migrations in `database/v2/migrations/` (currently through `v2.002`). They do not modify the legacy `ARKTIESIIS` database, its one-time baseline, or its migration history. There is no data migration between databases.

5. Create the first database administrator with `npm run admin:bootstrap`. Password input is hidden and is never accepted as a command-line argument.
6. Start the app with `npm run dev` and open `http://localhost:3000`.

Email 2FA is required outside the explicit development-only password bypass. The bypass needs both `NODE_ENV=development` and `DEV_PASSWORD_ONLY_LOGIN=true` and is restricted to loopback. Configure a working SMTP relay for regular sign-in.
The login-attempt limiter is skipped only while that development password-only mode is enabled; OTP and non-development login limits remain active.

## Fictional defense seed

The optional Grade 11–12 seed creates fictional, labeled prototype data, including private synthetic Good Moral and PSA sample files in staff review states. The samples include no Gemini result and make no authenticity claim. Review the plan first:

```bash
npm run demo:seed-school -- --dry-run
npm run demo:seed-school -- --apply
```

Seed application requires explicit local development mode and a loopback SQL connection to `ARKTIESIIS_V2`. The generated demo sign-in aliases and passwords are kept in the owner-only ignored `.env.school-demo` file; do not paste those credentials into source control or public channels.

## Checks

```bash
npm run check
npm test
npm run db:check
```

The test suite uses mocked SQL/HTTP services for authorization and transaction failure cases. Live database setup and seeded-data verification are separate local checks.

## Database history

`database/schema.sql` and `database/migrations/` are retained as inert legacy history. For this prototype, use only `database/v2/schema.sql`, `scripts/db-setup-v2.js`, and `scripts/check-db.js`. Do not rerun or edit the old applied schema/migrations to initialize the V2 database.
