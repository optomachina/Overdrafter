# Homepage Studio end-to-end suite

Real Chromium (Playwright, the repo's existing `@playwright/test`) against the real studio code and the public prototype pages.
Own config, own output directory (OS temp dir), no new dependencies, no network except `127.0.0.1`.

```
npx playwright test -c tools/homepage-studio/e2e/playwright.config.mjs                       # everything (about 1.5 to 2 minutes)
npx playwright test -c tools/homepage-studio/e2e/playwright.config.mjs --project=studio-local
npx playwright test -c tools/homepage-studio/e2e/playwright.config.mjs --project=security
npx playwright test -c tools/homepage-studio/e2e/playwright.config.mjs --grep @a11y
```

Projects / tags: `studio-local` (`@studio-local`), `studio-hosted` (`@studio-hosted`), `pages` (`@pages`), `security` (`@security`), `a11y` (`@a11y`).
Traces and screenshots of failures, plus the HTML report, are written under `$TMPDIR/homepage-studio-e2e-output` (never the repo).
`CI=1` turns on one retry; locally there are none. Two workers.

## How it is isolated
- Every test gets its own studio server **in the test process** (`helpers/studio-server.mjs`): `server.mjs` + `lib/app.mjs`, a fresh temp data
  directory, an ephemeral `127.0.0.1` port. `tools/homepage-studio/data` and any real data repo are never touched. HOME is pointed at an empty
  directory while the app is built, so results do not depend on skills installed on the machine.
- Seams used are existing `createApp` parameters: `probe` (stands in for `claude auth status`), `fetchImpl`, `extraEngines` (a gate in front of the real
  demo engine, and the existing fake engine for forced failures). No test-only code is compiled into production paths.
- Hosted mode runs against `helpers/fake-github.mjs`, an in-memory `node:http` GitHub stub (contents, git-data, workflow dispatch, runs). The
  adapter's `fetchImpl` rewrites `api.github.com` to the stub and throws for any other host. A "worker" (`helpers/fake-worker.mjs`) finishes jobs by using
  the studio's own `finalizeJob` and storage adapter.
- Production hook: `STUDIO_GITHUB_API_BASE` is honoured only when `STUDIO_ALLOW_TEST_API_BASE=1` AND the value is a plain `http` loopback URL
  (`resolveApiBase` in `lib/storage/github.mjs`, unit-tested). The e2e suite itself uses `fetchImpl`, not this variable.
- `helpers/fixtures.mjs` has an automatic guard on every test: any request to a host other than `127.0.0.1`, or any console/page error that is not
  allow-listed (password-field advisories; per-test `guard.expectHttp(status)` for deliberate 4xx/5xx), fails the test.
- Hosted cookies: Chromium stores and sends `Secure` cookies on `http://127.0.0.1`, so hosted tests run over http and assert the real cookie flags
  (HttpOnly, Secure, SameSite=Strict). In hosted mode API calls from tests go through `fetch` inside the page (the Node request context would not send a Secure cookie over http).
- No sleeps: expect polling, event waits, and a promise gate for in-flight jobs. Colour contrast is computed from computed styles (formula in `helpers/color.mjs`).

## Groups
- A/B/C `studio-local-*`: Page mode at 1024, 768 touch and 390 touch (sandbox attributes, top bar, hint, in-place edits, lint blocking and warning confirm,
  copy history/diff/restore, append-only versions), figure icons on hero and 7 chapters, demo generation, versions, blocked / missing skill / failed jobs, theme, Interact mode, Outline view, Compare.
- D `studio-hosted`: auth, rate limit, cookie flags, fail closed, commits to the fake data repo, conflicts, GitHub 401/403/429, github-actions dispatch and job states, blocked worker job.
- E `security`: editor injection only into baselines, CSP/headers, Origin/Sec-Fetch-Site/Host/content-type/size guards, path traversal, forged postMessages from inside the page, generated-asset isolation.
- F `pages-*`: v2 to v9, variants index and tagline page; rail, roadmap wires, cluster keyboard, v9 prompt bar and Coming soon panel, reduced motion, `CAPABILITIES` flip.
- G `a11y`: keyboard walks, accessible names, 44px targets, contrast 4.5:1.

## Known findings
All seven findings from the first run are fixed and covered by regular tests (Page mode regenerate sends `sectionId`; a started local job reports
`running`; a `conflict_exhausted` save shows Failed with the reason and keeps the edit; v7/v8 roadmap wording is generic; Replay controls are hidden under
reduced motion in v7, v8 and v9; toolbar Tab order and the bottom sheet focus trap; v9 Coming soon button contrast).
Remaining skip: "flipping statuses in CAPABILITIES re-renders" for v7 only, because v7 renders its roadmap once and has no re-render hook.

## Not covered
Real iPad or iPhone touch and soft keyboard (CDP touch emulation only), Safari, real GitHub or Vercel, real model runs and the real `claude` CLI,
the hosted worker script itself, the React app at `/`, visual regression, screen readers.
