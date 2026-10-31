# PR #977 app-run proof at 96b3a35e9107a8bad3266d181f240e50ff741c50

Owner-produced supporting evidence for QA. This is not a QA or reviewer verdict.

## Run the app (fixture mode, local)

The app was run at head with a clean tree using
`.agents/skills/verify-overdrafter/scripts/verify.sh --mode fixture --features auth,quote,provider`.
That started the Vite dev server with a dead Supabase URL and drove Playwright through the
auth, quote and provider fixture journeys.

- `verify-manifest.txt`: `verdict: PASS`, `tests: passed=37 failed=0 skipped=0 expectedFail=0 flaky=0`, `git head: 96b3a35… (clean tree)`.
- `traces/`: full Playwright traces (`--trace on`) for three of the passing journeys. The client-shell and quote-comparison fixture specs were re-run with tracing on, and all 23 tests passed. View a trace with `npx playwright show-trace <file>`.
- `screenshots/`: the final frame of each of those traces.

Container deviations, none of which touch the app under test:

- Only Chromium build 1243 is installed in this container, so the project's pinned build 1208 path was symlinked to it through `PLAYWRIGHT_BROWSERS_PATH`.
- Chromium's sandbox cannot start as root here, so a wrapper passes `--no-sandbox` to the headless shell.

The hosted `verify (run journeys at head)` job for this SHA logged a report-mode FAIL (missing manifest and Playwright report). That job is not counted as proof here.

## Touched check

The PR adds `scripts/test-lane-contract*` to `infra_ci` in `docs/sensitive-paths.json` and in the AGENTS.md mirror.
`classify.mjs` runs the repo matcher (`scripts/lib/sensitive-paths.mjs`) at the base `ff166ee` and at head. See `touched-check.txt`:

- base: `scripts/test-lane-contract.test.mjs` is not sensitive;
- head: it is `infra_ci` via `scripts/test-lane-contract*`. The negative control `scripts/test-lane-notcontract.mjs` stays unclassified;
- AGENTS.md parity: no differences. `findGateLoosening`: `detected: false`.

Also at head: `node scripts/validate-agent-contract.mjs` reports valid, and `scripts/test-lane-contract.test.mjs` with `scripts/verify-overdrafter-skill.test.mjs` pass 59 of 59.
