# PR #972 run-the-app proof (owner-collected, not a QA verdict)

PR head: `37f83a69dea8721cb7d2ef137d39d9b12685da00`. Collected 2026-10-31 in a Linux cloud container (Node 22, git 2.43, Chromium from the preinstalled Playwright).

1. **Touched check (`headDiffId` in `scripts/ovd-merge-gate.mjs`).** `headdiff.mjs` imports the PR-head script and runs a real `headDiffId` against github.com for PR 972 (no token, public repo). Result in `headdiff.log`: diffId `c142726c94d2ffdfe1845f09761aeef23df593573f5c3d34b09d62540654784b`, which is the diff_id in the QA and reviewer verdicts. No error, and no `ovd-merge-gate-data-*` store left in the temp dir.
2. **Unit tests.** `npx vitest run scripts/ovd-merge-gate.test.mjs`: 258/258 pass (`vitest.log`).
3. **App.** `npm run build` (exit 0) with the repo's fixture-lane Supabase values from `playwright.config.ts` (dead local URL plus the public local demo key, never a hosted project), then `vite preview` on 127.0.0.1:4180. `run.cjs` drives Chromium: the anonymous landing page opens the auth dialog, `#auth-email` and the Log in button are visible, and there are 0 page errors (`playwright.log`, `01-landing-auth-dialog.png`, `02-landing.png`, `trace.zip`; open the trace with `npx playwright show-trace trace.zip`).

The PR's edited workflow YAML (`queue: max`) cannot run before merge, because `pull_request_target` loads the default-branch copy. Its post-merge check is (a) to (d) in the PR body.
