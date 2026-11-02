# Repair mode

Repair selector drift without turning observed portal data into trusted quote output prematurely.

## Diagnose with minimal state

1. Start from a finite selector-drift or unrecognized-state result. Do not keep interacting with the portal after drift is detected.
2. Compare a scrubbed, minimal current-state fixture with the last reviewed provider reference. Limit fixtures to the smallest structural facts needed for repair, such as roles, stable labels, test IDs, route class, terminal signals, and redacted element relationships.
3. Never capture or commit raw whole-page HTML, CAD/drawing bytes, cookies, tokens, account/customer identifiers, quotes belonging to a customer, or unsanitized screenshots.
4. Describe the proposed old/new selector or signal, the scrubbed evidence, affected state, and uncertainty. Confidence scores are advisory only.

This preserves the useful snapshot/reference comparison pattern from `mfg-quotes` but rejects its auto-apply behavior. No confidence threshold may apply a selector change automatically.

## Review and revalidation gate

Keep a proposed selector or terminal-signal change untrusted until a human reviews it. After review, make the smallest adapter/portal-definition change by hand. Do not rerun `fixture:onboard` to regenerate it: Fixture never overwrites, so edited files are only reported `kept`. Then run:

- the provider portal kernel tests;
- the reusable adapter contract suite;
- the affected provider's offline tests with scrubbed fixtures;
- `npm run provider:check`; and
- the repository's required worker/full verification lane.

Until those checks pass, changed selectors must not publish quote data. Unanchored prices or lead times remain observations only and route to a finite manual-review/drift state.

A later provider-interacting retest is a new live-continuation action. Rebuild and present the exact provider/account/files/hashes/action/origins/artifacts tuple, then obtain fresh explicit approval. Never reuse the repair review as upload authorization.

## Xometry quote page and auth probe

`docs/provider-integration.md` (Selector repair, and Quote-page price collection) is the contract. Apply it as follows:

- `anonymous_quote_home` is an expired session, including the instant-pricing upload prompt with no dashboard evidence. Re-authenticate. Do not start selector repair.
- `authenticated_dashboard_not_confirmed` is selector repair. Start from the scrubbed `fixtureHealFingerprint` line. Do not route it to session refresh.
- Do not wrap `page.goto`, the inspection loop, and fingerprint capture in one empty `catch`. Report the sub-stage (`goto`, `inspection`, `fingerprint`) and a closed cause (`timeout`, `navigation_aborted`, `context_destroyed`, `net_error`, `other`) with no URL or page text.
- Publish a price only for the complete tier set at the price the customer pays. A hidden, loading, disabled, mislabelled, stale, or conditionally withdrawn tier is a refusal. Two of three tiers is not a complete instant quote. Do not exempt a filename or `originalName` to make the settle wait pass.
- Update the synthetic fixture in the same change (`worker/src/adapters/fixtures/xometry-quote-page-price-panel-2026-10.html`, `worker/src/adapters/fixtures/xometry-anonymous-quote-home.json`).
- Do not open this repair while another PR already changes the same adapter files.

## Repair report

Return the drift state, files inspected, sanitized comparison, proposed and reviewed changes, offline verification evidence, remaining unknowns, and whether a separately approved live retest is still required. Do not claim the provider is production-ready.
