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
  result card, PNG, GLB/USDZ and AR link. Marked `test.fail()` until
  [OVD-805](https://linear.app/overdrafter/issue/OVD-805) lands. Two sibling
  tests keep that honest: a boot guard (shell must mount) and an OVD-805 guard
  asserting no Jarvis link on `/`. When OVD-805 adds the link the guard goes
  red; then remove `test.fail()` from the journey and delete the guard.

```bash
npx vitest run src/journeys --maxWorkers=2
PLAYWRIGHT_SKIP_AUTH_SETUP=1 npx playwright test e2e/journeys/jarvis-front-door.spec.ts --workers=1
```

## Follow-up PRs

1. Channel parity: the same request from each enabled channel adapter (stubbed
   transport) lands in one shared thread with the same result (OVD-807, OVD-808, OVD-809).
2. Job control: start, pause, steer, resume and cancel from the phone; assert
   state changes and preserved partial work (OVD-810, OVD-812).
3. Access: an allowlisted user gets in, a non-allowlisted user is blocked, a
   cross-user decision returns 403 (OVD-803, OVD-806).
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
