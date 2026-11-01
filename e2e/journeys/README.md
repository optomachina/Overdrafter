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
