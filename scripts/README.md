# Development scripts

The supported prototype database commands are:

```bash
npm run db:setup
npm run db:check
npm run demo:seed-school -- --dry-run
npm run demo:seed-school -- --apply
```

They target only `ARKTIESIIS_V2`; setup installs its consolidated baseline and applies pending numbered V2 migrations, while the seed adds fictional Grade 11–12 data plus two clearly labeled synthetic Good Moral and PSA files in private storage for staff-review demonstrations. No Gemini result is seeded. See [`database/README.md`](../database/README.md) for setup limits, credential handling, and the inert legacy database history.

`npm run admin:bootstrap` creates the first local database administrator for a fresh V2 prototype when one is needed. The script prompts for a password and hashes it before storage; it does not print or persist a plaintext password.

For the already expanded Hostinger demo only, `npm run demo:activate-hostinger-enrollments -- --dry-run ...` validates the reserved 20-student selection and previews every saved assessment through the registrar fee workflow. The explicit `--apply` command confirms 10 Grade 11 and 10 Grade 12 fictional intakes, preserving their existing assessment snapshots. Each student confirmation is transactional and uses a deterministic idempotency key; if the process stops mid-batch, repeat the exact apply command to finish the remaining students. The completion marker is written after all 20 registrar confirmations commit. This script creates no student logins or documents. See [`docs/17-hostinger-mariadb-deployment.md`](../docs/17-hostinger-mariadb-deployment.md) for required production, database, and marker acknowledgements.

Older one-off demo seed scripts and the native OCR smoke script are retained as historical development artifacts. They are not exposed as npm commands or part of active application setup. The retired Tesseract/Poppler service is not used by current Good Moral, PSA, Form 137, or grade-submission workflows. Current document prechecks use the bounded Gemini adapter and always require staff review.
