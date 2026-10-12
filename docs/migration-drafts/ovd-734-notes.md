# OVD-734 durable permit consumption: draft notes

`ovd-734.sql` and `ovd-734.rollback.sql` are **not applied** and are not in
`supabase/migrations/`. They need a Blaine-approved migration window, then are
promoted byte-for-byte with `npm run migration:next`.

## Deploy order

1. `ovd-722.sql` (OVD-722 kill switch, PR #676). The consume RPC reads
   `private.provider_kill_switches` and `private.provider_global_kill_switch` by
   those names. Without them every consume is denied with
   `provider_kill_switch_engaged`, so nothing dispatches twice, but nothing
   generic dispatches either.
2. `ovd-734.sql`.
3. The worker build containing OVD-734. It calls
   `public.api_consume_provider_dispatch_permit` before every generic
   (non-Xometry) dispatch and fails closed when the RPC is missing (PostgREST
   `PGRST202` is classified terminal), so deploying the worker first stops
   every generic dispatch. Xometry and simulate mode never call it.

Rollback runs in the reverse order: roll back the worker build first, then
`ovd-734.rollback.sql`. That rollback refuses while consumption rows exist for
unexpired permits unless `ovd734.rollback_discard_consumptions = 'confirmed'`
is set in the same transaction.

## Contract

| RPC | Purpose | Response (`provider-dispatch-permit-consumption.v1`) |
| --- | --- | --- |
| `api_consume_provider_dispatch_permit(task, result, permit, fingerprint, worker)` | Records attempt 1, or attempt 2 after a transient side-effect-free attempt 1 | `{consumed: true, permitId, attempt}` or `{consumed: false, denial}` |
| `api_mark_provider_dispatch_permit_side_effect_started(permit, attempt, worker)` | Immediately before the first provider-facing action | `{sideEffectStarted: true, permitId, attempt}` or a denial |
| `api_record_provider_dispatch_permit_outcome(permit, attempt, worker, outcome)` | One-way outcome: `transient_pre_launch_failure`, `completed`, `failed` | `{outcomeRecorded: true, ...}` or a denial |

All three are SECURITY DEFINER with `search_path = ''` and `lock_timeout = 2s`,
executable by `service_role` only. Consume locks the task row, then the permit,
FOR UPDATE (the OVD-459 preflight order), rechecks the binding, permit state,
`expires_at > now`, and the kill switch, then counts prior attempts.

## Worker integration

- Main branch: `worker/src/dispatchRouting.ts` passes a durable
  `ProviderDispatchPermitConsumer` (`worker/src/providerDispatchPermitConsumption.ts`)
  to the generic preflight path. The adapter runs only after consume and the
  side-effect stamp both succeed.
- OVD-461 seam (PR #682): call `consume` and `startSideEffect` immediately before
  `adapter.execute`, and map a thrown `ProviderDispatchAuthorizationError` with
  the seam's `providerExecutionDenialFromError`. Its in-process
  `ProviderAuthorizationConsumer` stays the fast first check, but it should mark
  a key only after `startSideEffect` succeeds. Otherwise a transient pre-launch
  failure turns the one permitted retry into `authorization_replayed` on the
  same process.

## Tests

- `supabase/tests/provider_dispatch_permit_consumption.sql` (pgTAP) installs the
  byte-copied fixture inside its rolled-back transaction while the table is
  absent, and stubs the two OVD-722 tables (clearly marked) while they are
  absent.
- `supabase/tests/provider_dispatch_permit_consumption_concurrency.sql` races
  two dblink sessions, the same pattern as
  `provider_dispatch_preflight_concurrency.sql`. dblink sessions cannot see
  uncommitted objects, so while the draft is absent this file commits the
  fixture and stubs, then removes them with the byte-copied rollback.
- `scripts/run-supabase-policy-tests.node-test.mjs` enforces the byte copies,
  the security posture, and the rollback guard order.
