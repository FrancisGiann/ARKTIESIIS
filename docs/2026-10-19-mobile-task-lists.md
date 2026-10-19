# Mobile task lists — 19 October 2026

Based on ten visually inspected user screenshots. Presentation changes only; existing server permissions, record actions, payment identities, balances and validation remain in place.

- Pre-enrollment lists shared by Front desk and Admin show name, full status and Open record on phones. Other metadata remains in the record and in larger layouts.
- Finance account cards remove inherited flex heights on phones. They show name, school-year balance and Open student account. Earlier-balance and voucher-review warnings remain visible. Full term details remain in the account and larger roster layouts.
- Subjects use aligned name/Edit and code/units rows on phones. Native disclosure editing remains keyboard-operable.
- Student records have clearer dividers and smaller mobile type. User account rows retain identifiers, email, status and Manage with less spacing.
- Mobile Menu contains Account settings and CSRF-protected Sign out. The signed-in role and email are highlighted within the menu. Desktop header controls remain available. Escape closes the menu and restores its summary focus.
- Payment choices group by school year, grade and term, with concise fee/installment/due labels. Full purpose remains in the option title. Zero balances, recovered selections, unavailable-selection warnings and oldest-balance ordering metadata are retained. No accounting service or route changed.

Validation uses actual EJS fragments rendered with synthetic long names, subject codes and email addresses. At 360, 375, 390, 412, 768 and 1280px, no whole-page or main-control overflow was measured. Mobile menu containment and 44px account controls were checked at five widths. Native subject Enter and menu Escape/focus were exercised. Comparable 390px synthetic rows: pre-enrollment 334→98px; finance card 496→154px. These are fixture measurements, not claims about every live record.

Relevant navigation, account, student record, pre-enrollment, finance browse, academic record and annual workflow regressions were run. No real student decision, financial transaction, account/security change, or database migration was performed. Physical mobile devices and OS-native select popup appearance remain outside this browser check.
