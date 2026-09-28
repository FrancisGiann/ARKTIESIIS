# Phase 15 — Deployment Preparation and Defense Runbook

> **Historical planning document.** This runbook describes the earlier `ARKTIESIIS` application and its database; it is not deployment guidance for the active rebuilt prototype. The current app targets the separate `ARKTIESIIS_V2` database with a consolidated baseline and no data migration. Any future deployment plan must be reviewed against the rebuilt app, its current authentication and storage behavior, and institution-approved policy. No thesis objective or school policy is finalized by this prototype.

## Status and scope

This document is a preparation artifact for the proposed Hostinger KVM 2 virtual server with the plain Ubuntu 22.04 image. **No VPS has been ordered or provisioned; no production secrets were used; no production database was created or migrated; no backup or restore drill was run; and no app was deployed.** The local checks listed below do not establish live deployment readiness.

The Phase 15 preparation gate covers a reviewable target plan, configuration checklist, private database-and-file backup/isolated-restore procedure, unresolved security findings, defense demonstration script, and local validation of the guarded demo seeder. The distinct **live-deployment gate remains pending** until the environment is provisioned and all operational checks in this runbook are exercised. The **school-adoption gate also remains pending** institution signoff. These gates are independent: passing preparation does not approve institution policy or authorize deploying to the school.

## Target and version checks

The proposed Hostinger target is a plain Ubuntu 22.04 VPS image. Hostinger currently lists plain Ubuntu 22.04 for KVM VPS and its [KVM VPS plan page](https://www.hostinger.com/vps-hosting) currently lists KVM 2 with 2 vCPU, 8 GB RAM, and 100 GB NVMe. These are planning inputs only: recheck plan/image availability, included resources, backup options, and applicable terms before any purchase or provisioning. No price is recorded. Confirm the plan can support the app, SQL Server, Gemini API calls, private upload growth, and backup staging together before selecting it.

The platform constraints below were checked on **2026-09-26** and must be checked again before provisioning:

| Component | Preparation requirement |
| --- | --- |
| Hostinger image | Use the proposed plain Ubuntu 22.04 image only after confirming it is still offered for the selected KVM plan. The [Hostinger VPS operating-system templates](https://www.hostinger.com/support/1583571-what-are-the-available-operating-systems-for-vps-at-hostinger/) page lists plain Ubuntu 22.04. |
| KVM 2 sizing | The current Hostinger listing is 2 vCPU, 8 GB RAM, and 100 GB NVMe. Microsoft's [SQL Server on Linux setup guidance](https://learn.microsoft.com/en-us/sql/linux/install-upgrade/setup?view=sql-server-ver17) lists a minimum of 2 processor cores, 2 GB RAM, and 6 GB disk for SQL Server; those are startup minimums, not a capacity estimate. A 2-vCPU plan leaves no CPU headroom above SQL Server's stated minimum for Node.js, file delivery, or maintenance. Complete workload, upload growth, backup-space, and recovery sizing or select a separate appropriately sized private database host before purchase. Recheck the provider and SQL figures at provisioning. |
| Ubuntu support | Ubuntu 22.04 standard security maintenance is scheduled to end in **May 2027**. Confirm an approved Ubuntu Pro/ESM arrangement or a tested upgrade path for the intended service lifetime; the [Ubuntu release cycle](https://ubuntu.com/about/release-cycle) is the current reference. |
| Node.js | The repository requires Node.js 20+, but the [Node.js release page](https://nodejs.org/en/about/previous-releases) lists Node.js 20 as EOL since March 24, 2026. Select a Node.js Active or Maintenance LTS release supported at deployment, then test this project on that exact runtime. Do not deploy Node 20 merely because it meets the repository's minimum engine field. |
| SQL Server | If using SQL Server 2022 on Ubuntu 22.04, use CU 10 or later as described in Microsoft's [SQL Server 2022 on Linux support notes](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-whats-new-2022?view=sql-server-ver17). Confirm the selected edition, build, and host configuration against current Microsoft support documentation. |
| SQL licensing | SQL Server Developer edition is for non-production use. Microsoft's [SQL Server licensing guidance](https://www.microsoft.com/licensing/guidance/SQL) is informational and does not replace the applicable Product Terms or license agreement. Obtain written confirmation of a production-appropriate edition and licensing rights before school use; availability and cost remain unverified. |

Hostinger listing Ubuntu 22.04 does not establish that the plan is sufficient, that the SQL configuration is supported, or that the complete service has adequate security support. Because standard Ubuntu 22.04 maintenance is near its listed end at the review date, include the support extension or migration decision in the pre-provisioning review.

## Decisions required before provisioning

Record an owner and approved answer for each item before creating an externally reachable service:

- Confirm the Hostinger account, exact KVM 2 specification, data location, snapshot/backup features, support terms, and an approved budget owner. No plan has been purchased or reserved.
- Confirm whether SQL Server runs on the same VPS or a separate private host. If separate, define the private network, firewall, TLS certificate name, and coordinated database/file backup ownership. In either design, port 1433 must not be reachable from the public internet.
- Select a supported SQL Server production edition and verify its licensing for the specific provider, virtualized host, number of users, and intended use. Do not use the local SQL Server Developer container for production.
- Choose a supported Node.js LTS version and an Ubuntu support route. Verify package support and rerun tests and database checks on the exact deployment versions. Confirm outbound HTTPS access, a school-approved Gemini API key/model, and the provider's current data handling terms before enabling document processing.
- Assign the school-approved owner for student data, account provisioning, security incidents, backup access, backup retention, and deletion. Retention periods and operating roles have not been supplied.
- Confirm DNS/domain ownership, HTTPS certificate issuance and renewal, SMTP sender/provider and delivery limits, approved support contacts, monitoring/alert routing, recovery objectives, and the private off-host backup destination. These values are not specified here.
- Resolve the open production findings in the [Phase 12 security audit](12-security-audit-backup-restore.md), including persistent/shared session and rate-limit stores, exact proxy trust, SQL certificate validation, audit/retention decisions, and a successful restore drill.
- Obtain institution signoff for school adoption and any policy-dependent document, grading, validation, retention, and decision wording. The paper and its current implementation discrepancies are recorded in [Phase 13 evidence](13-testing-objective-alignment.md); this runbook does not close them.

## Proposed host and service configuration

This is an operator checklist, not a tested installation script. Keep an installation/change record with the selected versions and configuration, and redact all secret values.

1. Start from the verified plain Ubuntu image. Apply supported OS security updates. Use individual named operator accounts, SSH keys, and a tested recovery path before disabling password/root SSH. Restrict SSH to the approved operator network where practical.
2. Configure the host firewall and provider firewall before starting services. Permit only required administration and HTTPS ingress; expose HTTP only for the approved redirect/certificate flow. Keep the Node application port private to the reverse proxy and restrict SQL Server to loopback or the chosen private network. Verify externally that SQL port 1433 and the app's direct port are blocked.
3. Run the application as a dedicated unprivileged service account under a process supervisor such as `systemd`, behind a maintained HTTPS reverse proxy. Terminate TLS at the approved proxy and renew the certificate. Test the proxy-to-app path and cookie behavior before public traffic. Express proxy trust is currently unconfigured; see SEC-03 below. Do not compensate by trusting arbitrary forwarded headers.
4. Install a Node.js Active or Maintenance LTS version that is still supported at deployment, install production dependencies from the lockfile using `npm ci --omit=dev`, and record `node --version` and `npm --version`. Test the app under that precise runtime before release.
5. Configure an approved Gemini API key and model for the deployed environment. Digital Good Moral/PSA uploads and temporary staff Form 137 scans send file bytes to Google Gemini for bounded field suggestions. No local OCR executable or PDF-rendering utility is required for active document processing. Verify outbound HTTPS, API key access controls, request timeout, upload-size limit, worker concurrency, and the current provider data-handling terms before enabling the feature.
6. Install a Microsoft-supported and correctly licensed SQL Server build. Bind its listener to loopback if co-located, or a private interface with a narrowly scoped firewall rule if remote. Validate TLS with a trusted certificate. Use a database application login with only runtime privileges; keep the migration operator credential separate and short-lived. The current database setup script reads `DB_USER`/`DB_PASSWORD` from the process environment, so use an approved protected operator environment for migrations and do not put elevated migration credentials in the application service's persistent environment.
7. Inject application secrets through a service-manager environment source outside the checkout (for example, a root-owned systemd `EnvironmentFile` with restrictive permissions). Do not put secrets in `.env.example`, source, Git, shell transcripts, screenshots, or this runbook. The current `src/config/environment.js` calls dotenv with a fixed project-root `.env` path, so do not put a production `.env` in the checkout; ensure the production service receives its settings from the external service manager and deploy no secret-bearing checkout `.env`. Set owner/group and modes explicitly; do not copy the ignored local `.env` or `.env.demo` files to the VPS.
8. Choose a durable upload directory outside the repository, `public`, web-server roots, and temporary storage; for example, an operator-approved `/var/lib/arkt/.../uploads` path. Set `DOCUMENT_STORAGE_DIR` to its absolute path, make the app service owner the only reader/writer, and confirm it survives application restarts and host maintenance. Measure free space and alerting against an approved capacity plan. No retention/deletion schedule is implied.
9. Deploy a reviewed release artifact from a known commit. Record its revision, migration versions, package/runtime versions, and release operator. Keep the prior application artifact available for rollback. Do not deploy directly from an unreviewed working tree.

### Environment checklist

Use actual values from approved operations sources; the entries below are names and requirements, not sample secrets:

| Variable | Production preparation |
| --- | --- |
| `NODE_ENV` | `production`; this enables production cookie behavior and disallows the development password-only login path. |
| `PORT` | Internal application listener port allowed only from the reverse proxy. |
| `SESSION_SECRET` | Unique, randomly generated secret of at least 32 characters, held outside the repository and rotated through a reviewed session invalidation plan. |
| `APP_BASE_URL` | Canonical public HTTPS origin used to build password-reset and email-confirmation links. Set it explicitly; production rejects HTTP origins. |
| `DEV_PASSWORD_ONLY_LOGIN` | Explicitly `false`. Never enable the development bypass on a public or production service. |
| `DB_SERVER`, `DB_PORT`, `DB_NAME` | The approved SQL endpoint, private port, and `ARKTIESIIS` database. For a same-host SQL service, use the locally bound endpoint. |
| `DB_USER`, `DB_PASSWORD` | Separate least-privilege application identity and secret. Do not run the app as `sa`, database owner, or migration operator. |
| `DB_ENCRYPT`, `DB_TRUST_SERVER_CERTIFICATE` | Set encryption on and certificate trust bypass off after a valid SQL TLS certificate and hostname are configured and tested. The example values are development-only. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Approved production sender/provider values with tested TLS and delivery. Do not route school messages to personal or demo aliases. |
| `GEMINI_API_KEY` | Secret supplied by an authorized Google AI Studio account; keep it outside the repository and restrict access. Digital Good Moral/PSA uploads and temporary Form 137 scans are sent to Google Gemini for field suggestions. Confirm school approval and current provider data handling before use. |
| `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS`, `DOCUMENT_PROCESSING_CONCURRENCY` | Use a supported Gemini model identifier; keep the configured timeout within 1–120 seconds and worker concurrency within 1–4. No native OCR binaries or PDF-rendering utilities are required for active document processing. |
| `MAX_UPLOAD_MB` | A deliberate technical capacity setting, currently defaulting to 10 MB; it is not a school-approved document policy. Validate against storage and proxy request limits. |
| `DOCUMENT_STORAGE_DIR` | Absolute durable private path outside all public/static roots and the repository. |

`npm run db:setup` uses the checked-in one-time baseline only when the database does not exist and otherwise applies missing numbered migrations after validating migration history. Use it only after a reviewed backup, a maintenance window, an isolated rehearsal, and explicit production-change authorization. Never manually replay `database/schema.sql` against an initialized database or alter already-applied migration files. No production migration was run for this preparation phase.

## Coordinated database and private-file backup

The approved backup frequency, retention, encryption destination, operator access, and recovery point/recovery time objectives are not defined. Obtain those decisions first; do not invent them. Follow the [Phase 12 backup/restore procedure](12-security-audit-backup-restore.md) and use a maintenance window so SQL rows and stored files represent one consistent application state.

1. Confirm a current encrypted off-host backup destination, capacity, access controls, and a tested restoration environment. Keep any staging directory outside the repository, static/public roots, and upload root. Create it with restrictive permissions and `umask 077`; restrict the SQL backup directory to the SQL Server service account and approved backup operator.
2. Record the approved window and migration version. Stop the application service, which also stops the background document-processing recovery/worker. Confirm no other application writer or import job is active; leave SQL Server running for its native backup operation.
3. Back up the full `ARKTIESIIS` database using SQL Server `BACKUP DATABASE` with `COPY_ONLY`, `CHECKSUM`, and an operator-selected timestamped destination that is private and writable by the SQL Server service account:

   ```sql
   BACKUP DATABASE [ARKTIESIIS]
     TO DISK = N'<private-sql-backup-path>/ARKTIESIIS_<UTC-timestamp>.bak'
     WITH COPY_ONLY, CHECKSUM, STATS = 10;
   ```

   Replace both placeholders with reviewed paths before running. Never place the `.bak` under a web root, repository, upload directory, or user download area.
4. Confirm the configured `DOCUMENT_STORAGE_DIR` resolves to the approved private upload root and is not itself a symlink. Refuse the backup if the tree contains symlinks, special files, or multiply linked regular files; investigate those entries rather than following or archiving links. Archive only that directory to a pre-created private staging directory with mode 0700 while the app is stopped. The template uses `set -eu` so failed preflight checks stop the operation, verifies the upload root and staging path, refuses an existing archive path, and archives only the named upload directory from its parent so tar stores relative paths. Preserve file names and metadata needed for restoration. Substitute reviewed absolute paths and the storage directory name before running:

   ```bash
   set -eu
   umask 077
   test ! -L '<DOCUMENT_STORAGE_DIR>'
   test "$(realpath -e '<DOCUMENT_STORAGE_DIR>')" = '<approved-absolute-storage-root>'
   test -d '<private-staging-path>' && test ! -L '<private-staging-path>'
   test "$(stat -c '%a' '<private-staging-path>')" = 700
   upload_tree_report=$(find '<DOCUMENT_STORAGE_DIR>' -xdev \( ! -type d ! -type f -o \( -type f -links +1 \) \) -print -quit) || {
     echo 'Refusing backup: could not inspect the upload tree.' >&2
     exit 1
   }
   if [ -n "$upload_tree_report" ]; then
     echo 'Refusing backup: unexpected symlink, special file, or hard-linked file found.' >&2
     exit 1
   fi
   test ! -e '<private-staging-path>/uploads_<UTC-timestamp>.tar.gz'
   tar --numeric-owner --acls --xattrs --create --gzip \
     --file='<private-staging-path>/uploads_<UTC-timestamp>.tar.gz' \
     --directory='<parent-of-DOCUMENT_STORAGE_DIR>' '<storage-directory-name>'
   chmod 0600 '<private-staging-path>/uploads_<UTC-timestamp>.tar.gz'
   ```

   The SQL Server backup and file archive are a pair; do not report a completed backup if either fails. Record file counts and total bytes without listing document contents in the operations log.
5. Generate and check SHA-256 checksums for both artifacts, for example `sha256sum '<database-backup>' '<upload-archive>' > '<private-staging-path>/SHA256SUMS'`, then `sha256sum --check '<private-staging-path>/SHA256SUMS'`. Run `RESTORE VERIFYONLY ... WITH CHECKSUM` for the database backup. Artifact verification is not a restore drill.
6. Encrypt backups before transfer to the approved off-host destination using the selected managed key process. Store recovery keys separately with restricted access. Verify remote checksums and access controls; a second copy on the same VPS is not a disaster-recovery backup.
7. Record UTC start/end, source host and database, application revision, schema migration versions, storage path, backup names/checksums, operator, and errors. Restart the application and verify its health, SQL connectivity, authenticated role pages, private file download route, and document queue recovery. Do not include secrets, extracted fields, student names, or original filenames in the record.

## Isolated restore drill procedure

This is a future procedure. **It has not been exercised.** Do not point a drill at the production database, production upload directory, public DNS, live SMTP sender, or the only backup copy. Use a separate test SQL Server instance and a separate private filesystem root with network ingress disabled. Restrict operator access because the backup may contain sensitive school records.

1. Select a recent paired database backup and upload archive. Verify recorded SHA-256 checksums and SQL `RESTORE VERIFYONLY`. Record the source SQL Server build, application revision, migration versions, and backup time. `VERIFYONLY` does not replace this full restore.
2. On the isolated SQL Server instance, run `RESTORE FILELISTONLY` for the selected backup. Confirm the target `ARKTIESIIS` database does not already exist on this isolated instance. Map every logical data/log file to a fresh, empty, isolated test path. Restore without `WITH REPLACE`:

   ```sql
   RESTORE DATABASE [ARKTIESIIS]
     FROM DISK = N'<private-sql-backup-path>/ARKTIESIIS_<UTC-timestamp>.bak'
     WITH MOVE N'<logical-data-name>' TO N'<isolated-test-path>/ARKTIESIIS.mdf',
          MOVE N'<logical-log-name>' TO N'<isolated-test-path>/ARKTIESIIS_log.ldf',
          CHECKSUM, RECOVERY, STATS = 10;
   ```

   Add a `MOVE` clause for every database file returned by `RESTORE FILELISTONLY`. If the destination exists or the restore reports an unexpected layout, stop and select a fresh isolated instance/path. Do not add `WITH REPLACE`.
3. Inspect archive paths with tar listing, then run this standard-library-only validator before any extraction. It rejects absolute paths, parent traversal, unexpected archive roots, nested or duplicate paths, symlinks, hardlinks, and special-file entries. Set the expected root name to the basename used by the archive-create command:

   ~~~bash
   python3 - '<private-upload-archive>' '<expected-archive-root-name>' <<'PY'
   import sys
   import tarfile

   archive_path, expected_root = sys.argv[1:]
   slash = chr(92)
   if not expected_root or '/' in expected_root or slash in expected_root or expected_root in {'.', '..'}:
       raise SystemExit('Refusing archive: invalid expected root name.')

   seen = set()
   with tarfile.open(archive_path, 'r:gz') as archive:
       for member in archive.getmembers():
           raw_name = member.name
           parts = raw_name.split('/')
           if member.isdir() and parts and parts[-1] == '':
               parts.pop()
           if (not raw_name or raw_name.startswith('/') or slash in raw_name
                   or any(part in {'', '.', '..'} for part in parts)
                   or not parts or parts[0] != expected_root or len(parts) > 2):
               raise SystemExit('Refusing archive: unsafe or unexpected path.')
           if member.issym() or member.islnk():
               raise SystemExit('Refusing archive: symlinks and hardlinks are not allowed.')
           if not (member.isfile() or member.isdir()):
               raise SystemExit('Refusing archive: special file is not allowed.')
           normalized = '/'.join(parts)
           if normalized in seen:
               raise SystemExit('Refusing archive: duplicate path.')
           seen.add(normalized)
   print('Archive paths and member types passed inspection.')
   PY
   ~~~

   Stop and investigate if validation fails; do not extract or silently skip unsafe entries. Create a new empty private directory outside all web/public roots with owner-only permissions. Extract only after validation, using tar's strip-components and no-same-owner/no-same-permissions options; then set the service owner, directories to mode 0700, and files to mode 0600 on POSIX. Configure the isolated app's DOCUMENT_STORAGE_DIR to this new directory. Never point the test app at production storage.
4. Compare `documents.stored_filename` and `file_size_bytes` from the restored database to the restored file tree. Confirm every referenced private file exists at the expected size; record missing or unreferenced files for investigation without opening their contents. Keep both copies access-controlled.
5. Create a separate least-privilege SQL login/database user for the isolated app; do not copy production SQL credentials or elevate the runtime account. Use fresh isolated app secrets and an isolated app port; block public ingress and production SMTP. Exercise `npm run db:check`, authentication/session/logout, all four role read/denial paths, private download authorization, missing-file safe errors, and an approved synthetic Gemini example. Mutating upload, review, or finance checks require an isolated copy and explicit test plan; they must not write to production. Verify Gemini findings remain advisory and that a human decision controls document status.
6. Record restore start/end, SQL Server build, app revision, migration versions, paired artifact checksums, test paths/statuses, file comparison results, and errors. After recording the result, stop the isolated service and securely remove temporary restored copies after the approved test retention period. No test retention period is defined in this document.

## Production security go/no-go checklist

The following Phase 12 findings remain open or pending; preparation does not resolve them:

| Finding | Required before live deployment |
| --- | --- |
| SEC-02 — in-memory session store | Select, configure, and test a maintained production session store appropriate to the selected process topology. Demonstrate persistence/restart and worker behavior. |
| SEC-03 — proxy trust | Configure trust only for verified proxy hops and test the production Secure-cookie path plus spoofed forwarded IP/protocol headers. The current app has no proxy trust setting. |
| SEC-04 — SQL TLS | Provision and validate a trusted SQL Server certificate; use encryption without trusting arbitrary server certificates. Verify the app's SQL connection path. |
| SEC-05 — retention and operations | Obtain institution-approved file, database backup, audit, and test-copy retention; assign authorized operators and deletion responsibilities. |
| SEC-06 — backup/restore | Complete the paired private SQL/file backup and a full isolated restore drill; record checksums, database-to-file consistency, and role/download tests. No drill has been run. |
| SEC-07 — authentication/denial audit | Obtain approval for which authentication and denied-access events to record, minimization, access control, and retention; implement and verify before production if required. Do not put passwords, OTPs, document bytes, extracted fields, or raw errors into the audit trail. |
| SEC-08 — per-IP rate-limit store | Select and test shared rate-limit state for the chosen number of processes; ensure proxy/IP identity is trustworthy. The existing in-process default is not shared or persistent. |

Also verify public access cannot reach SQL Server, the Node port, the upload directory, backup staging, or application secrets; use the app's authenticated private-download handler for documents; confirm user-facing failures do not disclose SQL/stack details; and re-run the Phase 12 access and file privacy checks against the deployed reverse-proxy topology. SEC-01's authenticated `private, no-store` response control is fixed and regression-tested locally, but still must be checked on the deployed path. This list is an operations gate, not a claim of penetration testing or institutional security approval.

## Defense demonstration checklist

Use a dedicated development/demo environment with clearly synthetic records and test documents. Do not use real student data, production credentials, the production SMTP sender, or real school files in slides, screenshots, or screen sharing. Keep `.env.demo` and all passwords private. The demo seeder creates fake registrar, finance, and student users only; it does not create a database-administrator account, document, or Gemini result. Never change an existing administrator credential for a defense demonstration.

Before the session:

- Confirm environment and database are isolated, firewall/public access are appropriate for the demo, the application is current, the database is disposable or backed up, and private uploads have no real files. If the demo uses the development-only password path, keep it in a local loopback environment; never expose that bypass publicly. Otherwise use an approved test SMTP path for email 2FA.
- Confirm test accounts in `.env.demo` match the intended local SMTP aliases without displaying or copying their passwords. Use a separately authorized synthetic administrator account if one is available; do not invent a credential or reset an existing user's password.
- Prepare synthetic/redacted fixtures and a walkthrough that avoids irreversible writes. The seeder has no undo operation; it writes sample accounts, academic rows, ledgers, and an audit marker, but no document/Gemini result rows. Do not rerun `--apply` merely to reset a demo.

Suggested order:

1. **Student:** sign in as a seeded student; show only that student's own dashboard, grades, permitted document history, and upload options. Attempt one denied cross-student or staff-only path and show the safe denial without exposing another student's information.
2. **Registrar:** show student/academic search, existing grade/context workflows, permitted document review, and staff-only document access. If showing a digital Gemini result, say it is an advisory field precheck; inspect the synthetic source and demonstrate that only an authorized human review decision changes status. Do not claim Gemini proves authenticity, detects forgery, or checks complete pages or every school requirement.
3. **Finance:** show only the finance workspace, ledger entries, and balance derived from the demo ledger. Do not open student documents or unrelated academic records from the finance account.
4. **Database administrator:** if a separately authorized synthetic test account exists, show administration, records, document oversight, finance summaries, and audit view within that role. Otherwise label the administrator screen unshown; do not borrow, guess, or alter a real administrator credential.
5. **Access boundaries and limits:** show role denials from the Phase 13 access matrix. Explain that students see only their own permitted scope; Form 137 scans are transient staff-only Gemini suggestions and do not create a persistent Form 137 upload/extraction record; staff inspect originals and make decisions. State that paper objectives concerning persistent Form 137 uploads, complete page checks, and hard deletion remain objective gaps in the Phase 13 report.

After the session, sign out of each account, close the demo session, store the demo credentials privately, and follow only the approved development-data reset/deletion procedure. The demo seeder does not reset or delete records. Record any failures as prototype limitations; do not imply the demo is school-adopted or ready for operational student records.

## Local preparation evidence and pending gates

The seed implementation is guarded by `NODE_ENV=development`, an explicit `--dry-run` or `--apply` mode, and an allowlist of loopback database hosts plus the `ARKTIESIIS` database name. The data write rechecks those constraints, uses a serializable transaction and seed marker, stops on conflicting stable identifiers, and commits its marker with the demo records. Tests verify production/non-loopback/wrong-database rejection, atomic rollback on conflicts, credential-file rerun preservation, and that a completed rerun adds no rows. The seeder does not seed documents/Gemini results or modify existing accounts. These are source/test observations; this phase does not apply the seeder to a database.

The Phase 15 preparation gate is limited to this runbook, the locally reviewed configuration/seed protections, defense checklist, and the local automated checks recorded in the handoff. **Pending:** Hostinger purchase/provisioning and current plan checks; production edition/licensing; DNS/TLS/SMTP; production environment and proxy/session/rate-limit choices; Gemini key/model and institution approval; production migrations; durable upload setup; coordinated backup; isolated restore drill; production role/download smoke; live Gemini/data-handling review; live E2E and final defense. Neither this document nor local test passes close those gates.
