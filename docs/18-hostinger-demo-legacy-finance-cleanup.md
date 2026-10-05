# Narrow Hostinger demo finance cleanup

`scripts/cleanup-hostinger-demo-legacy-finance.js` is a one-time maintenance utility for the existing Hostinger dummy-data cohort. It is not a demo reset or a general cleanup command. It targets only the two specifically flagged legacy charge transactions and the existing legacy account balance for the reserved demo student; it leaves student/account rows in place. It refuses other linked legacy-payment or opening-liability dependencies, records one audit event, and advances the affected student's finance debt revision so older clearance reviews cannot be reused.

The utility requires production mode with password-only development login disabled, a remote non-root database account, the exact database name supplied twice, and the stored Hostinger seed and expansion markers. Before `--apply`, create a private database backup outside the repository and `public_html`, record its SHA-256, then run `--dry-run` and review the target counts and modern-finance snapshot. The apply path additionally requires explicit acknowledgement and the backup path/hash. It uses a transaction and advisory lock, rechecks the target rows under lock, compares modern finance rows before and after, and emits the completion result only after commit. An exact repeat returns the saved `already-applied` result; changed or unexpected data fails closed.

Example read-only invocation (load the approved production-shaped maintenance environment and replace the database name with the exact hPanel value):

```sh
node --dns-result-order=ipv4first scripts/cleanup-hostinger-demo-legacy-finance.js --dry-run \
  --target-database 'PREFIX_database' --confirm-database 'PREFIX_database' \
  --confirm-seed-marker hostinger-demo-seed-v1 --confirm-expansion-marker hostinger-demo-expansion-v1
```

Apply uses the same arguments with `--apply --acknowledge-demo-legacy-finance-cleanup --backup-file ABSOLUTE_PRIVATE_BACKUP --backup-sha256 VERIFIED_SHA256`. Keep the backup path and digest private when they reveal account-specific maintenance locations. Do not retry after an interrupted operation until the saved audit marker, account balance, target transactions, debt revision, and modern-finance snapshot have been checked.

The authorized 2026-10-05 cleanup removed two legacy charges totaling ₱5,500 and set the existing account balance to zero. It preserved the 100-student fictional cohort, all modern annual finance rows, and the three paper pre-enrollment examples. Do not run the cleanup again against a different cohort or use it as authorization to remove other demo or school data.
