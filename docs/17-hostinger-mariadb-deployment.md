# MariaDB setup and Hostinger deployment

## Create and configure the database

Create the database and its single database user in Hostinger hPanel before connecting the application. Hostinger prefixes both values; use the exact database name, user, and password shown by hPanel. Configure the app with `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`; a local socket path is optional for development. The usual Hostinger application connection uses `localhost` and port `3306`.

The setup runner connects to the selected existing database. It does not run `CREATE DATABASE`, `DROP DATABASE`, triggers, procedures, or `DEFINER` statements. Run `npm run db:setup` once against the empty database and then `npm run db:check`. Setup records `v2.001` and applies forward migrations through `v2.011`; app startup and deployment do not rerun schema setup automatically.

Hostinger's Business/Cloud Node deployment runs npm commands as part of deployment and does not provide SSH commands for one-time database setup. A maintainer can apply migrations from a trusted development machine by temporarily allowing its IP through Remote MySQL, running setup and the schema check, then removing that remote access. Use the repository's MariaDB setup runner so it records the baseline and migration versions consistently; the hPanel SQL import path has not been verified for this bookkeeping. Do not upload the old SQL Server baseline or its migrations. Review Hostinger's [Node.js deployment workflow](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/), [redeployment guide](https://www.hostinger.com/support/how-to-redeploy-a-node-js-application/), [environment variable guidance](https://www.hostinger.com/support/how-to-edit-or-add-environment-variables-after-deployment/), [remote MySQL access](https://www.hostinger.com/support/1583546-how-to-set-up-remote-mysql-access-in-hostinger/), and [database creation guide](https://www.hostinger.com/support/1583542-how-to-create-a-new-mysql-database-in-hostinger/) before deployment because account controls can change.

After schema setup, choose exactly one account/data setup path. For an empty real deployment, create the first database administrator with `npm run admin:bootstrap`; enter its password in the private interactive terminal, since it is not a deployment variable or command-line argument. Skip the demo seed below. For a dummy-data deployment, skip `admin:bootstrap` and use the one-time `demo:seed-hostinger` procedure below, which creates its own administrator and sample accounts. Do not run both: the demo seed requires empty business tables and refuses a database where bootstrap has already created an administrator. Restrict database-user permissions in hPanel after setup if required by the deployment plan. The MariaDB baseline and migration runner do not require creating a database user or other database.

The source SQL Server data was classified as dummy and disposable. The deployment path starts with a new empty MariaDB database and does not include a SQL Server data transfer. Preserve the SQL Server source database and its files until the separate prototype shutdown decision; do not point the app at it or delete it as part of deployment.

## Environment and release checks

Set `NODE_ENV=production`, a unique `SESSION_SECRET` of at least 32 characters, the exact hPanel database credentials, `APP_BASE_URL` with the public HTTPS origin, SMTP configuration for email two-factor authentication, an absolute private `DOCUMENT_STORAGE_DIR` outside the checkout, and the approved Gemini configuration. Production startup rejects missing/placeholder SMTP settings, partial SMTP credentials, and relative upload paths inside the checkout or Hostinger deployment-managed `hbuilds/` and `public_html` paths. Keep secrets in the host's environment settings and never commit `.env` files. Keep `DEV_PASSWORD_ONLY_LOGIN=false` in production. The temporary demo-only OTP exception is opt-in and separately allowlisted below.

Configure Hostinger's application entry file as `src/server.js`. Hostinger loads this file as the app entry point; it starts the HTTP listener immediately and runs the database probe and document-recovery scheduler in the background. A database outage is reported through safe server logs and `/health`, while the listener remains available. `/health` checks database connectivity with `SELECT 1`; an empty database can report `connected`, so use `npm run db:setup` and `npm run db:check` separately to verify schema setup and migrations before role-based checks.

Verify the production app connects to the selected MariaDB database and passes `npm run db:check` from an approved maintenance context. Deploy the reviewed source through Hostinger's Node application manager and check the app health and role-based login paths after deployment. The production Express app trusts one immediate proxy hop so HTTPS cookies and per-client rate limits can use forwarded request metadata; verify that the actual app connection supplies the expected headers. Do not run the development demo seed in production; it rejects non-development `NODE_ENV` and non-local hosts.

Gemini document-processing and transient Form 137 scan concurrency limits are held in process memory. They apply per Node.js process, not across the account: multiple instances or overlapping deploys can multiply simultaneous provider requests. Verify the actual Hostinger instance and rollout behavior before relying on the configured limit; keep a single active app process when the provider cap requires a global bound. Form 137 scan bytes remain transient and are not written as files or database rows.

The local demo seed is a development fixture. Use a separate local database whose name includes `demo`, `dev`, or `test`, set `DEV_PASSWORD_ONLY_LOGIN=true` only for that development environment, and provide `DEMO_SEED_PASSWORD` privately before `npm run demo:seed-school -- --apply`. It inserts five role accounts and a small fictional academic roster. It has no reset operation; use a new empty database to restart the demo.

The current application uses `express-session`'s in-memory store. The [Express session documentation](https://expressjs.com/en/resources/middleware/session/) warns that its default `MemoryStore` is not designed for production, can leak memory, and does not scale past one process. Node process restarts invalidate active logins, and multiple processes do not share sessions. This is acceptable for the current single-process demo only; verify that the Hostinger app runs one process and expect users to sign in again after a restart or redeploy. A persistent/shared session store remains a production security-readiness item before real school data is used. The app does not require a Gemini key at startup: without `GEMINI_API_KEY`, document prechecks return the existing safe unavailable result and staff can still review submissions. Configure and verify an approved key before demonstrating Gemini prechecks.

### One-time production-shaped demo seed

For a dummy-data deployment, use the separate one-time production seed from a trusted development machine after `db:setup` and `db:check`, instead of running `admin:bootstrap`. This seed requires the same valid production startup configuration as the app: `NODE_ENV=production`, `DEV_PASSWORD_ONLY_LOGIN=false`, a private absolute `DOCUMENT_STORAGE_DIR` outside the checkout, Hostinger-managed directories, and working SMTP sender settings. It also requires the exact remote hPanel DB settings and the `DEMO_ADMIN_EMAIL/PASSWORD`, `DEMO_REGISTRAR_EMAIL/PASSWORD`, `DEMO_TEACHER_EMAIL/PASSWORD`, `DEMO_FINANCE_EMAIL/PASSWORD`, and `DEMO_STUDENT_EMAIL/PASSWORD` values. Each account needs a distinct reachable email and unique strong password. Supply passwords only through a private environment file or shell environment; do not place them in command arguments, deployment logs, or the repository. The application continues to require email two-factor authentication for sign-in. The seed requires empty business tables and creates the administrator itself; do not run it after `admin:bootstrap` or on an existing school database.

The script requires the target DB name twice, requires an explicit production-seed acknowledgement for writes, and makes no changes in dry-run mode. Set the private environment before running these commands and replace the example database name with the exact prefixed `DB_NAME` from hPanel:

```sh
npm run demo:seed-hostinger -- --dry-run --target-database 'PREFIX_database' --confirm-database 'PREFIX_database'
npm run demo:seed-hostinger -- --apply --target-database 'PREFIX_database' --confirm-database 'PREFIX_database' --acknowledge-production-demo-seed
```

Apply is allowed only when the database contains no business records apart from the exact baseline physical-requirement reference rows. It inserts five fictional role accounts, one fictional student with a single term/section/subject, and an audit marker. It never prints the account passwords, has no reset mode, and refuses a second application. Keep the passwords in an approved private store, test each role through its email-code sign-in, and remove or rotate demo accounts before real student data is used. Do not point the seed at an existing school database.

#### One-time demo data expansion

After the Hostinger seed succeeds, `demo:expand-hostinger` can add a larger fictional dataset to that same demo database. Run it only while the original seed profile is untouched: the expansion checks the exact `hostinger-demo-seed-v1` marker, the complete MariaDB v2.011 schema, the exact DB name twice, and the baseline counts for the five seeded accounts and one initial academic record. It also requires `NODE_ENV=production`, `DEV_PASSWORD_ONLY_LOGIN=false`, the remote hPanel database host, and the existing database credentials. It uses an advisory lock and one transaction; the expansion marker is written with the fixture rows, and a failed run rolls back. A successful run cannot be repeated.

From the trusted maintenance machine, temporarily allow its IP through Hostinger Remote MySQL. Use the same private production environment that can connect to the existing demo database. Replace both example names with the exact prefixed `DB_NAME` shown in hPanel, then run dry-run before apply:

```sh
npm run demo:expand-hostinger -- --dry-run --target-database 'PREFIX_database' --confirm-database 'PREFIX_database' --confirm-seed-marker hostinger-demo-seed-v1
npm run demo:expand-hostinger -- --apply --target-database 'PREFIX_database' --confirm-database 'PREFIX_database' --confirm-seed-marker hostinger-demo-seed-v1
```

The expansion adds 99 fictional, unlinked students, bringing the total to 100. Twenty use the existing Term 1 section, subject, and teacher assignment as legacy-style enrolled academic fixtures; each has four synthetic grade rows. Those direct fixture grades are not teacher workbook submissions or registrar approvals. The other 79 have pending annual intake records with three pending-payment term placements each, plus 79 assessments and 474 assessed fee lines. Twenty-seven receive sample payments and allocations so finance dashboards show varied balances. The run adds 12 sections, four subjects, 24 teacher assignments, six fee schedules, and the two remaining terms for the seeded school year. It also adds 25 timetable rows linked to the seeded teacher's active assignments: one for the original assignment and one for each new assignment. The expansion requires that the original seed has no timetable rows and rejects any existing class schedule; it does not modify existing schedules. Generated days, times, and demo rooms do not overlap for this teacher within a term. It does not add login accounts, documents, registrar confirmations, or grades for pending students. All fee amounts are fictional examples, not approved tuition rates.

The expansion’s focused test uses a mocked MariaDB connection to verify counts, one-time behavior, collision guards, rollback, and safe errors; it does not connect to Hostinger. After the approved apply, check the expected counts in the app and remove the temporary Remote MySQL allowlist entry.

#### One-time demo enrollment activation

After the expansion is applied, `demo:activate-hostinger-enrollments` can confirm a fixed set of 20 fictional annual intakes through the registrar confirmation service: student ordinals 22–31 in Grade 11 and 51–60 in Grade 12. It requires the production-shaped remote database, the exact seeded demo account marker, the exact expansion marker, the v2.011 schema, and the reserved 99-student/79-intake fixture state. Dry-run previews every selected intake's existing assessment before apply. It does not create logins or documents and does not change the saved assessment or charge snapshot.

Use the private, ignored `.env.hostinger-activate` file with production database settings. For Hostinger Remote MySQL, select IPv4 first: the maintenance connection may otherwise choose IPv6, which can be denied even while the trusted IPv4 address is allowlisted. Replace both example database names with the exact prefixed `DB_NAME` from hPanel:

```sh
node --dns-result-order=ipv4first --env-file=.env.hostinger-activate scripts/activate-hostinger-demo-enrollments.js --dry-run --target-database 'PREFIX_database' --confirm-database 'PREFIX_database' --confirm-seed-marker hostinger-demo-seed-v1 --confirm-expansion-marker hostinger-demo-expansion-v1
node --dns-result-order=ipv4first --env-file=.env.hostinger-activate scripts/activate-hostinger-demo-enrollments.js --apply --target-database 'PREFIX_database' --confirm-database 'PREFIX_database' --confirm-seed-marker hostinger-demo-seed-v1 --confirm-expansion-marker hostinger-demo-expansion-v1
```

Each registrar confirmation and entry-term activation is a transaction with a deterministic idempotency key. The 20-student batch commits one learner at a time so an interrupted run can be resumed with the same apply command; the one-time completion marker is added only after all 20 are verified. After success, the current Term 1 registrar overview should show 20 enrolled and 59 pending activation. The later term placements remain pending payment until their own workflow is completed. Review that overview, then remove the temporary Remote MySQL allowlist entry. This one-time operation is for the fictional demo database only.

### Temporary password-only sign-in for the dummy-data demo

Email two-factor authentication remains the production default. If groupmates need direct access to the seeded dummy-data deployment, configure these environment variables in Hostinger hPanel for that app:

```text
NODE_ENV=production
DEV_PASSWORD_ONLY_LOGIN=false
DEMO_PASSWORD_ONLY_LOGIN=true
DEMO_PASSWORD_ONLY_EMAILS=admin@example.edu,registrar@example.edu,teacher@example.edu,finance@example.edu,student@example.edu
```

Replace the five example addresses with the exact `DEMO_ADMIN_EMAIL`, `DEMO_REGISTRAR_EMAIL`, `DEMO_TEACHER_EMAIL`, `DEMO_FINANCE_EMAIL`, and `DEMO_STUDENT_EMAIL` addresses used by the one-time seed. Enter only those accounts, separated by commas. Keep production SMTP configured: it is still required at startup and accounts outside this list continue to receive email verification codes. The mode does not change `NODE_ENV`, does not use `DEV_PASSWORD_ONLY_LOGIN`, and keeps the normal login rate limiter, password checks, CSRF checks, session regeneration, role authorization, and forced password changes.

The app enables the exception only when `DEMO_PASSWORD_ONLY_LOGIN` is exactly `true` and every allowlist entry is a valid email. A missing or malformed list disables password-only demo access. Removing an address or turning the flag off revokes that account's existing demo session on its next protected request. Keep this setting enabled only while the database contains disposable demo data.

To restore OTP for all accounts, set `DEMO_PASSWORD_ONLY_LOGIN=false` in hPanel and apply the environment change by restarting or redeploying the app. Keep `DEV_PASSWORD_ONLY_LOGIN=false` and retain working SMTP settings. Existing password-only demo sessions will be redirected to sign-in when they next access a protected page; subsequent sign-ins use email OTP. You can also remove `DEMO_PASSWORD_ONLY_EMAILS` after disabling the mode.

For both schema setup and this seed, temporarily allow only the trusted machine's current IP through Hostinger Remote MySQL. Run the setup, `npm run db:check`, the production-shaped seed, and a second `npm run db:check`; then remove the Remote MySQL allowlist entry. The application itself should connect using Hostinger's normal application environment, usually `localhost:3306`.

## Private document storage and backups

Uploaded documents must remain outside public/static paths. Hostinger creates a new versioned build on redeploy, advances `hbuilds/current` to the latest successful one, retains only its two latest successful versions, and manages files under `hbuilds/` and `public_html`. Configure `DOCUMENT_STORAGE_DIR` to an absolute location outside those managed paths and the application checkout. Hostinger's dashboard restart restarts the server process without a rebuild; redeployment rebuilds the app, and environment-variable changes may require applying them in the redeployment flow. Verify the exact storage path on the actual hosting account for write access, persistence across redeploys, and backup coverage before using real student documents. Do not assume a particular account path is durable. The local file-storage checks cannot prove Hostinger persistence or account backup behavior.

Back up the MariaDB database and private upload directory as a coordinated pair using the account's approved backup process. Verify a restoration into isolated resources before relying on it. No live account migration, upload-path validation, backup, or restore has been performed by this repository change.

## Migration and self-link invariants

The MariaDB schema is a fresh baseline in `database/mariadb/schema.sql`, with numbered forward-only migrations in `database/mariadb/migrations/`. Migration `010_latest_event_views.sql` adds latest-event views for document histories and physical-status records without depending on triggers or stored programs. Migration `011_document_request_finance_clearance.sql` adds the student debt-increase revision and append-only finance-clearance and claim-slip histories; apply it through the setup runner before deploying code that uses document clearance.

The MariaDB schema cannot enforce that `documents.supersedes_document_id` differs from the same row's auto-increment id with a `CHECK` constraint. `documentService.reupload` rejects a self-link before the transaction commits; `tests/documents.test.js` covers that invariant through the service path. The view migration does not change that rule.
