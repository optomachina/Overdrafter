# Customer quote commercial-validity acceptance

The customer offer conversion now respects an explicitly supplied `valid_until`
when deciding whether an offer is selectable. Previously an expired persisted
offer could still win a preset or resolve as the current selection even though
server-side eligibility would reject it. Missing validity keeps the established
legacy behavior; an explicit unparseable value fails closed. The deadline is
inclusive, matching the server eligibility predicate `valid_until >= p_at`.

The offer remains visible with its original price and deadline for review. Existing
selection consumers receive `isSelectable: false` and `eligible: false`, so current
selection recovery, published-option pointer recovery, presets, and bulk presets
cannot choose it. Existing customer-safe needs-review presentation explains that
selection is unavailable. No vendor, authorization, publication, or database logic
is changed, and client checks do not replace server enforcement.

Run the synthetic connected acceptance path:

```sh
npm test -- src/features/quotes/selection.test.ts src/features/quotes/client-workspace-state.test.ts src/features/quotes/sourcing-result.test.ts
npm run typecheck
npm exec eslint -- src/features/quotes/selection.ts src/features/quotes/selection.test.ts
```

On 2026-10-02, the new expired/malformed cases first failed against the old code.
After the fix, all 61 tests passed, including exact-deadline, future-deadline, and
unspecified-validity controls; root typechecks and scoped lint passed. The existing
fixtures contain only synthetic data. No customer upload, vendor submission, real
offer selection, browser session, or production mutation was performed.

Limits: this guard evaluates at option conversion time; it does not add a background
expiry timer for an idle browser tab. Server-time lane eligibility alone did not
revalidate either selection RPC.
The source-only follow-up in `20261002041305_enforce_quote_selection_expiry.sql`
adds server selection enforcement, but is not active until separately validated
and deployed. Cross-track aggregate verification and real browser/
controlled-beta journey qualification remain separate integration/release evidence.
