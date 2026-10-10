# Free quote confirmation browser regression lane

This is source acceptance coverage for the real `ClientPart` page, its actual
controller, `useQuoteAccess`, dialog, Supabase HTTP RPC client, and strict scope /
result parsers. It does not establish SQL admission, live authentication, a real
quote, file transfer, provider execution, payment behavior, or release readiness.

## Isolation and mocked boundaries

- A synthetic authenticated client identity replaces only `useAppSession`.
- Workspace read functions return one synthetic, quote-ready part. All UI
  components, notifications, confirmation state, controller and quote APIs remain
  the actual product modules. No feature module is replaced with a passing stub.
- The quote-access HTTP response is explicitly `free_beta`; no commercial
  automatic entitlement is fabricated. Founding Beta enrollment is an eligible
  synthetic response, not a real account or grant.
- Playwright intercepts every HTTP request before send. Only the exact loopback
  origin, built fixture HTML and built asset paths can reach the preview server.
  Allowlisted RPCs are fulfilled in memory; unknown RPCs, other APIs, mutations,
  object/file reads, off-origin requests and all WebSockets are aborted. Service
  workers are disabled. Any unexpected request fails the test after containment.
- The fixture bundle uses the dedicated static build/preview server (no Vite dev
  WebSocket). The product Vite config never imports this fixture configuration.
  Environment overrides cannot redirect its backend/base URL. No saved auth state
  or auth-setup script is loaded. CI uses installed Chrome with its sandbox on.
- The disclosure shows synthetic CAD metadata only. There are no CAD/PDF bytes,
  previews, object URLs, SQL fixtures, external databases, real credentials, model
  calls, vendors or external HTTP connections. `publicDir: false` excludes public
  fixture assets. This lane makes no claim about CAD preview rendering.
- The in-memory ledger models committed/lost/deduplicated HTTP results solely to
  observe client request identity. Its logical-create count is not SQL evidence.

## Regression matrix

| Trigger | Observable acceptance | Failure detected |
| --- | --- | --- |
| Eligible enrolled Free client opens confirmation | Units blank, no scope call until chosen, all three affirmations required, exact disclosure visible | Implicit consent or bypassed Free access |
| Quote access blocked, lookup error, malformed response | Request action absent; zero scope/dispatch calls | Fail-open access |
| Scope lookup error or malformed response | Error, no affirmations, disabled submit; explicit retry recovers | Malformed/stale scope admitted |
| Units changed before submission | Consent cleared; millimeter scope and units serialized | Old consent applied to new scope |
| Pending request, repeat activation and attempted edits | Single RPC; units/checkboxes/submit locked | Duplicate requests or mutable in-flight scope |
| Commit followed by lost HTTP response | Truthful unknown status, no queued claim, consent controls locked | Unknown result presented as success |
| Unknown outcome then changed scope refresh, access eligible or blocked | Old displayed scope and complete original payload/key retained for replay | New key, changed units or changed scope used during uncertain replay |
| Unknown outcome closed/reopened after eligible or blocked access refresh | Recovery-only Check previous quote request reopens the frozen confirmation; general Request quote stays absent when blocked | Reopening loses approval identity or restores fresh admission |
| Exact replay succeeds | Deduplicated success, one synthetic create, disabled further confirmation | Repeat submission or duplicate admission |
| Explicit stale-scope/free-allowance denial | No create; refreshed scope shown, consent reset; fresh confirmation has new key and scope | Stale confirmation automatically reused after denial |
| Unknown recovery explicitly denied while access blocked | No create, no fresh consent, no request/recovery action after closing | Recovery privilege survives definitive denial |
| Close before submit, reopen, Escape | Unsubmitted consent discarded; no dispatch or stale dialog | Accidental submit or stale consent |

Source review identified and this bounded repair addresses an existing recovery
edge: closing an uncertain confirmation after quote access becomes blocked had
removed every way to reopen it. The dedicated recovery-only action is bound to an
actually attempted, unresolved request and the current verified actor/org/job.
It neither restores fresh admission nor changes RPC authorization. It disappears
while pending and after a definitive result; identity change or unverified auth
cannot expose it. Browser coverage exercises the actual Close/reopen and exact
replay path after blocked refresh, plus a denied-recovery negative case.

Scope refresh and same-mounted-page Close/reopen are covered. Full-page reload
persistence is not claimed or introduced by this repair.

## Required execution and evidence

Run `npm run e2e:quote-confirmation`. It first typechecks the fixture and its real
imports, then builds a synthetic-only static app and runs all browser cases. CI
runs it as an unconditional step in the required `browser-test` job; failures
block aggregate `ci`. There are no conditional skips or browser fallbacks. The
ordinary Playwright discovery does not select the dedicated `*.browser.ts` file.

CI retains `quote-confirmation-results/report.json`, Playwright failure evidence
and per-test synthetic RPC audits containing request identity, logical-create
count and contained unexpected attempts. Success is bound to the CI source SHA,
Chrome version logged by the existing CI browser setup, and the committed fixture
and check definitions.

Source-only validation while authoring from base
`c542641f62950680386ecf0fd066b109b2c88dee`:

- Focused tests including source/boundary contracts and existing ClientPart,
  dialog, quote-access and parser tests: passed, 152 tests.
- Full app/server TypeScript checks, dedicated fixture compile, ESLint, fixture
  production bundle and Playwright list/discovery (13 cases): passed.
- Chromium/browser acceptance: NOT RUN locally. Reviewed source must still pass
  the dedicated approved GitHub Actions lane before making a browser pass claim.
- Root aggregate `npm run verify` and live/provider/native qualification: not run
  as part of this source-only browser test unit.

Offline fixture/source contracts are in
`scripts/quote-confirmation-browser-contract.test.mjs`. They validate fixture
parser compatibility, pre-send containment, synthetic replay response semantics,
sandbox/static configuration and required CI wiring. They are deliberately
labeled as non-browser evidence.
