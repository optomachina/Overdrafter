# Journey tests (OVD-825)

Component tests passed while Jarvis had no user-facing front door. These tests
start where a user starts.

- `capability-manifest.ts`: one entry per user-facing surface and the entry
  points it claims. `knownMissing` marks a surface that has no public front
  door yet, with the issue that will add one.
- `reachability.ts`: resolves each entry point against the code (app router,
  `vercel.json`, `api/`, `supabase/functions/`) as a non-admin user with no
  build flags set. Flag-gated, admin-only and demo-only paths do not count.
- `src/journeys/reachability.test.ts` (under `src/` so `npm test` collects it):
  fails on any surface with no reachable entry point. A `knownMissing` surface
  must stay unreachable; once it is reachable the test fails with
  `surface X is now reachable; remove knownMissing`. Prints a per-surface table.
- `jarvis-front-door.spec.ts` (`@fixture`, runs in `npm run e2e:fixture`): phone
  viewport, `/` -> Jarvis link -> "design a 4 inch square plate" -> status,
  result card, PNG, GLB/USDZ and AR link. The dev server still serves the
  OVD-805 sample. A production build omits `/jarvis` unless
  `JARVIS_PWA_ENABLED=1` (OVD-803). A boot guard keeps a broken fixture red
  on its own.
- `jarvis-pwa-gate.spec.ts` (`@fixture`): flag off leaves the route and the
  Jarvis chunks out of the production build; flag on keeps the shell lazy and
  admits only the server allowlist at AAL2.

```bash
npx vitest run src/journeys --maxWorkers=2
PLAYWRIGHT_SKIP_AUTH_SETUP=1 npx playwright test e2e/journeys/jarvis-front-door.spec.ts --workers=1
```

## Follow-up PRs

1. Channel parity: the same request from each enabled channel adapter (stubbed
   transport) lands in one shared thread with the same result (OVD-807, OVD-808, OVD-809).
2. Job control: start, pause, steer, resume and cancel from the phone; assert
   state changes and preserved partial work (OVD-810, OVD-812).
3. Access: the PWA shell gate is OVD-803 (`jarvis-pwa-gate.spec.ts`). Beta-crew
   tiers and a cross-user decision denial remain OVD-806.
4. Skip/best-guess: skip every decision card; the job completes with recorded guesses.
5. Acceptance gate: every Linear issue with user-facing scope links at least one
   journey test; fold into the OVD-788 proof check.

Also open: run the front-door spec against preview and nightly against the
production domain, and decide whether the ChatGPT app (`server/chatgpt`, local
demo only today) belongs in the manifest.

## Friends release (OVD-1011)

| Journey | Mode / config | Coverage |
| --- | --- | --- |
| `friends-release-golden.spec.ts` | Authenticated local Supabase / `playwright.config.ts` | STEP + PDF upload and CAD canvas; extracted-property edits across reload; quantity; display-only Need by; US/INTL filter; price/delivery chart; quote details; absence of purchasing controls |

Run after `npm run db:start`, `npm run db:reset`, and `npm run seed:dev`:

```bash
npx playwright test e2e/journeys/friends-release-golden.spec.ts --config playwright.config.ts
```

The journey uses the scrubbed repository STEP/PDF only. `friends-release-seed.mjs`
reuses seed-dev's psql discovery and copies its synthetic extraction, requirements,
and published quote package onto the newly uploaded part in the standard loopback
database. IDs and timestamps are fresh; offers are marked simulate and given explicit
domestic/foreign origins. No worker, live vendor, remote backend, or quote dispatch
is allowed. The browser uses real Supabase auth, storage, reads, and saves. Run-owned
records remain in the disposable database until its next reset; no existing seed rows
are changed. No screenshots are written to tracked source.

There are no skipped steps. The no-order assertions deliberately include disabled
and hidden controls and the existing `Review order` button; they are soft assertions
so subsequent evidence can still be collected, but any violation fails the test.
The current page still exposes that button, so this is a release regression gate,
not a claim that the friends release is ready. The chart currently presents price
against delivered date, derived from the seeded lead time. Quote detail requires exactly the price and lead-time facts plus absence of
purchasing controls. The current extra vendor/material/status facts also fail that
strict release assertion; this test change does not alter product UI.
