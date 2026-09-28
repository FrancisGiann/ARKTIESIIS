# Active prototype database

The rebuilt application uses the isolated `ARKTIESIIS_V2` database. Its consolidated fresh-install baseline is [`v2/schema.sql`](v2/schema.sql), version `v2.001`. Forward-only V2 migrations live in [`v2/migrations/`](v2/migrations/). Migration `v2.002` adds `documents.is_legacy_archive` and marks pre-lifecycle report-card rows as archive records. Migration `v2.003` adds a separate staff-audited event history for physical previous-school report-card paper-copy status. Migration `v2.004` replaces only its status check with a stable named constraint supporting the prototype vocabulary, including `rejected`. The migration runner records versions and skips already-applied migrations; the database check requires all four versions and the named constraint. The setup and check commands target that database only:

```bash
npm run db:setup
npm run db:check
npm run demo:seed-school -- --dry-run
npm run demo:seed-school -- --apply
```

Copy `.env.example` to `.env` and configure the loopback SQL Server connection before setup. `db:setup` creates `ARKTIESIIS_V2` if needed, installs its consolidated baseline once, then applies unapplied numbered V2 migrations transactionally. It skips recorded versions and stops if it finds an unexpected schema marker or unmarked tables. It does not import or alter the former `ARKTIESIIS` database. The school seed is fictional Grade 11–12 data, runs only in development against loopback `ARKTIESIIS_V2`, and is safe to rerun after its seed marker is written. It creates distinct logins and stores credentials in ignored `.env.school-demo` with owner-only permissions; it never prints passwords. Two explicitly synthetic Good Moral and PSA sample files are stored privately for staff-review demonstrations; they contain no Gemini result or authenticity claim.

## Inert legacy history

[`schema.sql`](schema.sql) and [`migrations/`](migrations/) record the earlier `ARKTIESIIS` database history. They remain in the repository for reference and are not used by the active application setup, tests, seed, or database check. Do not run or edit the old baseline or replay old migrations as part of this prototype. No data migration is included; existing old-database data stays where it is.

Uploaded documents use the private storage directory configured by `DOCUMENT_STORAGE_DIR` (outside `public/`). The prototype does not configure automatic retention or deletion.
