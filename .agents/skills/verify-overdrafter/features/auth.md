# Auth and session

A visitor signs in through the auth dialog, keeps the session across reloads, lands in the client or internal shell for their role, and only sees their own organization's data.

## Sub-features

- `auth-dialog` anonymous landing opens the auth dialog.
- `auth-session` session survives reload on `/` and on a protected part route; logout and login restore the workspace.
- `auth-shell` one application frame across client routes; exits fixture mode cleanly.
- `auth-scope` Founding Beta enrollment, organization isolation, account switch without stale data, self-service signup lands not-enrolled.

## How to get to it (user POV)

- Open `/` signed out; the auth dialog appears (`#auth-email`).
- Sign in as client or internal; open the account menu (`open account menu` button).
- Reload `/parts/<id>` with a persisted session.

## Driving it with Playwright

Preconditions: fixture mode for `auth-shell` and reload checks; local mode (seeded accounts, `client.demo@overdrafter.local`, `estimator.demo@overdrafter.local`) for `auth-dialog`, `auth-session`, `auth-scope`.

- **Shell and reload (fixture).** `verify.sh --features auth` runs `e2e/client-shell.spec.ts` and `e2e/part-reload.spec.ts`. Expect the shell instead of the boot screen and no part data requested before auth verifies.
- **Session and scope (local).** `verify.sh --mode local --prepare --features auth` runs `e2e/smoke.spec.ts` and `e2e/access-scope.spec.ts`. Expect the client "Parts" heading, the internal "Operations Dashboard", and an outsider unable to read another organization's part.
- **Evidence.** Manifest verdict, `playwright-report-<n>.json`, failure screenshots/traces.

## Gotchas

- Fixture mode points Supabase at a dead port, so it cannot prove real sign-in, RLS or enrollment. Only local mode can; if Docker is unavailable, report `auth-dialog`, `auth-session`, `auth-scope` as not verified.
- Cold dev server can take over 5 s to paint; specs already allow 15 s.
- `npm run dev:login` uses macOS `open`; not usable on the box.
