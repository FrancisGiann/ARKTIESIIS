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

Older one-off demo seed scripts and the native OCR smoke script are retained as historical development artifacts. They are not exposed as npm commands or part of active application setup. The retired Tesseract/Poppler service is not used by current Good Moral, PSA, Form 137, or grade-submission workflows. Current document prechecks use the bounded Gemini adapter and always require staff review.
