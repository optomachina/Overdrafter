# Continuous local customer fixture acceptance

Owner: `01a0fae5-d8ff-74ca-9131-e762f8674037`; branch `qa/customer-workflow`.
Base repair commit: `b7f18aec976068b66e72a64aa3369fc2d2ede637`.
Worktree: `/Users/blainewilson/Documents/Codex/2026-10-01/task-14/qa-worktree`.
Exclusive follow-up scope: local fixture navigation and browser acceptance evidence. No task4 source ownership overlap. Completion: one continuous browser upload → comparison → selection run with cancel, failure/retry, Back/Forward and persistence checks.

## Repair and boundary

Upload success previously navigated to a bare part URL, losing query-backed fixture session state. `withLocalFixtureContext` carries the recognized active scenario through upload destinations and Parts collection links. It requires development/test mode, `VITE_ENABLE_FIXTURE_MODE=1`, and an exact loopback hostname. It only rewrites internal parts/projects/quotes paths. Production, unrecognized scenarios, missing opt-in, nonlocal hosts, authentication, external and protocol-relative targets remain unchanged. It adds no authentication, access grant, backend bypass, or provider behavior.

## Continuous browser result: PASS

Run date: 2026-10-02 UTC. Local Vite 5.4.19; cached Playwright CLI 0.1.21; Chromium. Start port 4187 with `VITE_ENABLE_FIXTURE_MODE=1`, `VITE_SUPABASE_URL=http://127.0.0.1:9`, synthetic publishable key. The replay is `customer-continuous-fixture.js`, passed to Playwright CLI `run-code` after opening the local fixture URL. Create `output/playwright/qa-repeat.step` with synthetic nonempty text first.

One uninterrupted browser session:

1. Open Parts with `fixture=client-published`; clear only the disposable store's seeded offer selection to prove a subsequent UI write.
2. Cancel file input: zero backend calls.
3. Select synthetic file: intercept intake with 503 `Synthetic upload interruption`; error visible and route remains Parts.
4. Retry same file: observe prepare intake, create draft, prepare upload, storage upload, finalize, reconcile, extraction request, then automatic part navigation retaining the fixture query. No manual navigation or fixture URL restoration occurs after upload.
5. Switch to All sourcing; use Enter on the Xometry row. Observe `Selected quote updated.` and verify fixture storage changed from null to `fx-offer-published-xometry`.
6. Browser Back to Parts, Forward to part, Back, then reopen via the Parts link. The stored selection remains identical and the rendered row has `aria-selected=true`.

Result receipt: `output/playwright/continuous-receipt.txt`. External requests are blocked; none were attempted during the successful run. Backend/storage operations are synthetic intercepted responses. The returned draft ID connects to the preseeded synthetic comparison; extraction and provider quoting are not executed. Persistence is in-session fixture-store persistence, not database or reload persistence.

Regression: 17 tests passed across fixture navigation (3), upload picker (5), and home auth/controller (9). Root typecheck, scoped lint, production build and whitespace checks passed; existing build chunk-size warnings remain. The previous fixture-navigation blocker is resolved for this acceptance path. A first harness run used an unavailable CLI sandbox `URL` global; replacing that harness parsing with string checks fixed the harness, not application behavior.

## Independent task4 UI review: PASS within browser scope

Exact untouched checkout: `/Users/blainewilson/Documents/Codex/2026-10-01/task-14/selection-review`, detached at `a7772e1f821bafd9d9b089585ca1e5e8f58759ba` (task4 base `0263731698a130f2c2d404dc79d2131dc3c8e10f`). Read intended behavior in its `docs/workflows/selection-publication-contract-repair.md`. No SQL, migration, provider currency, or task4 source file was edited or executed.

Serve exact checkout on loopback 4188 with synthetic closed-loopback backend. Replay `source-link-browser-setup.js`, snapshot the resulting package, then `source-link-browser-check.js` through the isolated Playwright CLI session. The setup intercepts package/job/option/history HTTP responses to render one source-less option and one actually linked option with null validity on the real `/client/packages/qa-package` page.

Observed and asserted:

- Source-less option, price, details, and prior selection note render.
- Retired action is disabled, refuses focus, and references refresh guidance through `aria-describedby`.
- Click, Enter and Space event attempts produce zero selection RPCs.
- Linked legacy-null option is enabled; Enter dispatches exactly one `api_select_quote_option` with `p_option_id=option-linked` and the synthetic note.
- After refetch, the retired option remains visible and the latest selection receipt shows the new note.

Evidence: `output/playwright/source-link-receipt.txt`, initial accessibility snapshot, and visually inspected `source-link-browser.png`. The page displays the latest selection receipt rather than a full history list; the original browser assertion expecting the old note after a new selection was corrected after inspecting that existing component contract. No database history preservation or SQL qualification is claimed. Parent/lead retain integration and live gates.
