# Debugging Workflows

Last updated: March 13, 2026

This repo supports three local debugging lanes. They share the same app code, but optimize for different feedback loops.

## Prerequisites

- Node dependencies installed with `npm install`
- local Supabase CLI available for `npm run db:start` and `npm run db:reset`
- Playwright browsers installed before the first E2E run:

```bash
npx playwright install
```

## Seeded Accounts

`npm run seed:dev` creates or updates these local users:

- `client.demo@overdrafter.local`
- `estimator.demo@overdrafter.local`
- `admin.demo@overdrafter.local`

Shared local-only password:

- `Overdrafter123!`

The seed is idempotent and targets local Supabase by default. It refuses non-local Supabase URLs unless you explicitly pass `--allow-remote`.

## 1. Production-Realistic Lane

Use this when you need real auth, real RLS, real memberships, and real seeded quote data.

Commands:

```bash
npm run db:start
npm run db:reset
npm run seed:dev
npm run dev
```

What you get:

- a demo organization with client and internal memberships
- canonical empty, needs-attention, quoted, and published job/project states
- sample CAD, PDF, and drawing preview assets uploaded to local storage

Recommended usage:

- sign-in, redirect, and permission bugs
- membership and route issues
- real query/mutation troubleshooting against local Supabase

## 2. Fast E2E Lane

Use this when you want repeatable browser automation without paying the login ceremony on every spec.

Commands:

```bash
npm run e2e:prepare
npm run e2e
```

What `npm run e2e:prepare` does:

- resets the local database
- runs `npm run seed:dev`
- signs in once as the demo client and internal estimator
- saves auth state to:
  - `playwright/.auth/client.json`
  - `playwright/.auth/internal.json`

What `npm run e2e` does:

- starts a dedicated app server on `http://127.0.0.1:4173`
- reuses saved `storageState`
- captures trace, video, and screenshot on failure
- attaches a diagnostics JSON snapshot on failure

Current smoke coverage:

- anonymous landing and auth dialog
- seeded client workspace shell
- seeded internal dashboard shell
- fixture-mode rendering without a real signed-in backend session

## 3. UI Tuning Lane

Use this when you need deterministic client workspace screens without depending on Supabase state.

Start the app with fixture mode enabled:

```bash
VITE_ENABLE_FIXTURE_MODE=1 npm run dev
```

Fixture scenarios are selected through the normal app URL using `?fixture=<scenarioId>`.

Supported v1 scenarios:

- `landing-anonymous`
- `client-empty`
- `client-needs-attention`
- `client-quoted`
- `client-published`

Example URLs:

- `http://127.0.0.1:5173/?fixture=landing-anonymous&debug=1`
- `http://127.0.0.1:5173/?fixture=client-empty&debug=1`
- `http://127.0.0.1:5173/parts/fx-job-needs-attention?fixture=client-needs-attention&debug=1`
- `http://127.0.0.1:5173/projects/fx-project-quoted?fixture=client-quoted&debug=1`
- `http://127.0.0.1:5173/projects/fx-project-published/review?fixture=client-published&debug=1`

The in-app `Fixtures` launcher lets you switch scenarios quickly in dev/test.

Fixture mode is intentionally narrow. It supports:

- navigation across the client workspace routes
- search and filtering surfaces backed by fixture data
- dialog open and close flows
- project and job pinning
- project create, rename, archive, unarchive, and dissolve flows
- project member invite and removal
- job archive and unarchive flows
- quote-offer selection UI

Fixture mode does not try to simulate the full backend or worker behavior.

## Diagnostics and Bug Reports

Add `?debug=1` to any local URL when you want the diagnostics surfaces active.

From the UI:

- open the diagnostics panel from the account menu or launcher
- copy the structured diagnostics bundle when filing a bug

From the browser console:

```js
window.__OVERDRAFTER_DEBUG__?.getSnapshot()
window.__OVERDRAFTER_DEBUG__?.exportJson()
```

Playwright uses the same diagnostics surface and stores the snapshot as a test artifact on failure.

## Recommended Usage

Pick the fastest lane that still exercises the behavior you are debugging:

- use production-realistic for auth, role, data, and permission bugs
- use fast E2E for regression coverage and reproducible browser failures
- use fixture mode for layout, state, and interaction tuning on client workspace screens

## Change-Type Mapping

Use this alongside `TEST_STRATEGY.md` and `docs/recurring-workflows.md`:

- docs-only changes usually do not need a debugging lane unless you are validating commands, fixture URLs, or diagnostics instructions
- client workspace layout and interaction tuning usually start in the UI tuning lane
- Supabase-backed auth, membership, permission, and routing issues belong in the production-realistic lane
- browser regressions, smoke coverage, and saved-session flows belong in the fast E2E lane
- if the change crosses categories, start with the cheapest lane that reproduces the issue and escalate only when the lighter lane cannot prove the fix
