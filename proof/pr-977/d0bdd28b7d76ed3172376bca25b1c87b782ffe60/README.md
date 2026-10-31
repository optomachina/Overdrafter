# PR #977 app-run evidence at d0bdd28b7d76ed3172376bca25b1c87b782ffe60

Owner-produced evidence for QA. This is not a QA or reviewer verdict, and this orphan commit is not meant to merge.

- `verify.sh --mode fixture --features auth,quote,provider` on a clean tree at d0bdd28b7d76ed3172376bca25b1c87b782ffe60: `verdict: PASS`, `passed=37 failed=0 skipped=0 flaky=0` (verify-manifest.txt).
- Screenshots: the final frames from re-running `quote-comparison.spec.ts` and `client-shell.spec.ts` (@fixture, 23/23 passed) with a temporary config that set `screenshot: on`. The temporary config was deleted and the tree is clean.
- touched-check.txt: `findGateLoosening` at list level and with the full diff, plus `validate-agent-contract`.
- Container deviations, outside the app under test: Playwright pins Chromium 1208, but only 1243 is installed, so a scratch `PLAYWRIGHT_BROWSERS_PATH` maps 1208 to 1243. Its headless-shell shim adds `--no-sandbox` because Chromium's sandbox cannot start as root here.
- Fixture mode proves UI behavior only, not database or RLS behavior.
