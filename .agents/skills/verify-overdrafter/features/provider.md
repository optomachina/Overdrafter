# Provider and supplier operations

Operators manage suppliers (on/off and daily cap) in the admin operations view, internal users reach engineering admin routes, and quote offers stay attributed to the right provider. Live provider dispatch is never exercised.

## Sub-features

- `provider-supplier-settings` set a cap, see it persist, set unlimited, switch a supplier off (OVD-829).
- `provider-admin-access` a non-platform session makes no operations request; keyboard and width checks.
- `provider-attribution` Xometry variants stay attributed to one provider (covered under `quote-compare`).
- `provider-front-door` Jarvis front door journey: **pending until OVD-805** (its journey is `test.fail()`), so `feature-specs.mjs` holds it in `PENDING_SPECS` and verify does not run it.

## How to get to it (user POV)

- Internal session, Operations/Admin operations route.
- Engineering admin route (`e2e/engineering-admin-route.spec.ts`, fixture mode; builds its own synthetic server).

## Driving it with Playwright

Preconditions: fixture mode for every mapped provider spec. There is no local-mode provider spec.

- **Operations (fixture).** `verify.sh --features provider` runs `e2e/admin-operations.spec.ts` under `e2e/admin-operations.config.ts` (synthetic admin server on 4174; under the default config it skips every test), then `e2e/engineering-admin-route.spec.ts` under the default config. It then runs `e2e/journeys/jarvis-front-door.spec.ts` (the public Jarvis link from OVD-805) under the default config. Expect the supplier cap to persist after reload and the off switch to stick.
- **Admin route.** Covered by the fixture command above (synthetic network only). `verify.sh --mode local --features provider` exits 2: no local provider spec exists, so report real-database provider behavior as not verified.
- **Reachability.** `npx vitest run src/journeys --maxWorkers=2` checks every claimed entry point resolves.

## Gotchas

- Fixture supplier settings are in-memory; persistence against the real table is not proven here.
- Provider upload, checkout and worker adapters are protected actions; this skill never runs them.
