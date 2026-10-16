# Provider and supplier operations

Operators manage suppliers (on/off and daily cap) in the admin operations view, internal users reach engineering admin routes, and quote offers stay attributed to the right provider. Live provider dispatch is never exercised.

## Sub-features

- `provider-supplier-settings` set a cap, see it persist, set unlimited, switch a supplier off (OVD-829).
- `provider-admin-access` a non-platform session makes no operations request; keyboard and width checks.
- `provider-attribution` Xometry variants stay attributed to one provider (covered under `quote-compare`).
- `provider-front-door` Jarvis front door journey (known `test.fail()` until OVD-805).

## How to get to it (user POV)

- Internal session, Operations/Admin operations route.
- Engineering admin route (`e2e/engineering-admin-route.spec.ts`, local mode).

## Driving it with Playwright

Preconditions: fixture mode for operations specs; local mode with `estimator.demo` for the engineering admin route.

- **Operations (fixture).** `verify.sh --features provider` runs `e2e/admin-operations.spec.ts` and `e2e/journeys/jarvis-front-door.spec.ts`. Expect the supplier cap to persist after reload and the off switch to stick.
- **Admin route (local).** `verify.sh --mode local --prepare --features provider`.
- **Reachability.** `npx vitest run src/journeys --maxWorkers=2` checks every claimed entry point resolves.

## Gotchas

- Fixture supplier settings are in-memory; persistence against the real table is not proven here.
- `jarvis-front-door.spec.ts` is expected-fail until OVD-805; a "failed as expected" result is not a pass of that journey.
- Provider upload, checkout and worker adapters are protected actions; this skill never runs them.
