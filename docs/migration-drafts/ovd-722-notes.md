# OVD-722 provider kill switch: implementation notes

Status: SQL is a draft (`docs/migration-drafts/ovd-722.sql`, **NEEDS BLAINE
MIGRATION WINDOW - not applied**). Nothing under `supabase/migrations/` was
created or edited. No database, remote, or provider was touched.

## Release requirement: off within 1 hour, no deploy

The switch is runtime data in `private.provider_kill_switches` and
`private.provider_global_kill_switch`. Nothing caches it:

- the server preflights and enqueue RPCs read the rows in the same transaction;
- the worker reads `api_worker_provider_kill_switch_state` at claim, right
  before launch, and before navigation, upload and configuration;
- a periodic sweep in the worker loop cancels queued tasks for a switched-off
  provider.

A flip therefore takes effect at the next checkpoint, typically seconds, with
no deploy and no worker restart. Proven by
`worker/src/providerKillSwitch.test.ts` ("RELEASE REQUIREMENT ...": same module
instance and guard, flip the fake store, next check refuses; flip back, the
next dispatch quotes) and `worker/src/providerKillSwitch.handler.test.ts`
("same handler, no restart").

How to flip (once the migration is applied): the admin page card
"Provider kill switch" on `/internal/admin`, or
`npm run provider:kill -- <provider>|--all --on|--off --reason "..."` with the
admin's own session (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`OVERDRAFTER_ADMIN_ACCESS_TOKEN`). The service role is refused.

## Plan assumptions that were wrong or needed adapting

1. **`xometryDispatchPreflight.ts` is not "seen via import only".** It is a full
   module on main (`authorizeXometryDispatch`, `quoteWithDispatchPreflight`)
   with a closed denial vocabulary. `provider_kill_switch_engaged` had to be
   added to `BOUNDED_DENIAL_REASON_CODES`, otherwise the server denial would
   collapse to `dispatch_authorization_denied`.
2. **"`dispatchRouting.ts` callers run the re-check" -> the check lives inside
   `quoteWithRoutedDispatchPreflight` itself.** It wraps the adapter so the
   read sits between the admitted authorization and launch, and hands the bound
   guard to the adapter as `providerKillSwitchCheckpoint`. There is one caller
   (`handleVendorQuoteTask`), so putting it in the seam covers every provider.
3. **"The same check repeats inside the portal kernel" covers only part of the
   fleet.** Quickparts, Weerg and Geomiq run through `providerPortalKernel.ts`,
   but Xometry (`adapters/xometry.ts`) and Fictiv (`adapters/fictiv.ts`) are
   bespoke adapters. Checkpoints were added to all three code paths (before
   navigation, upload, configure, and Xometry's drawing fallback upload). RMFG
   is an API transport (`adapters/rmfgQuoteTransport.ts`) with no production
   caller and no default network transport today; whenever it is wired as an
   adapter it goes through `quoteWithRoutedDispatchPreflight`, which already
   refuses at `before_launch`. Its per-request checkpoints should be added in
   that wiring change.
4. **There is no `cancelled_provider_disabled` status value.**
   `queue_task_status` is `queued|running|completed|failed|cancelled` and
   `vendor_status` has no cancelled value. Represented as: `work_queue.status =
   'cancelled'` with `payload.cancellationReason = 'cancelled_provider_disabled'`
   and `last_error` prefixed with it; `vendor_quote_results.status = 'failed'`
   with `raw_payload.failureCode = 'cancelled_provider_disabled'` and the note
   "Provider temporarily unavailable." No enum change was needed.
5. **The server preflight denial needed worker-side handling.** If the switch
   flips between the claim check and the server preflight, the preflight
   denies `provider_kill_switch_engaged`. The routing seam converts that into
   the same terminal `ProviderKillSwitchError` (checkpoint `server_preflight`)
   so the task also ends `cancelled_provider_disabled` rather than `failed`.
6. **"Each RPC edit" means wrapping, not editing.** The existing preflight and
   enqueue RPCs are large and pinned by pgTAP `prosrc` postconditions. The draft
   renames each to `private.*_pre_ovd722` (byte-for-byte body preserved, all
   grants revoked) and installs a same-signature public wrapper that checks the
   switch first. Three existing suites must be retargeted to the private names
   in the migration window (listed in the draft header). The generic preflight
   already delegates Xometry to the Xometry RPC, so both wrappers cover it.
7. **"Enqueue" is two RPCs**: `api_request_provider_dispatch` and
   `api_request_xometry_beta_dispatch` (the legacy Xometry path). Both are
   wrapped.
8. **Fail-closed seeding.** A provider with no kill-switch row, an unknown
   provider string, or a missing global row is treated as **engaged**, not
   disengaged. Seeds cover every current `vendor_name` value. A future
   `alter type public.vendor_name add value` must also insert a row (or that
   provider is switched off by default). The plan's "provider:check asserts a
   row per registry key" cannot be checked offline (`provider:check` has no DB
   access); the seed-from-enum plus fail-closed default makes it unnecessary.
   Not added.
9. **The worker reader is a separate unavailable code.** An RPC error, a
   malformed payload or a read over 2 s refuses with
   `provider_kill_switch_unavailable`, which is retryable only before any
   provider mutation (then manual follow-up). An engaged switch is
   `provider_kill_switch_engaged`, terminal. Both are added to the admin
   operations failure vocabulary (`server/admin-operations/projection.ts`) so
   they don't mark the failure feed `source_malformed`.
10. **Deploy ordering.** Because the worker fails closed, shipping the worker
    build before the migration would refuse every live dispatch. Apply the
    migration first (or together).
11. **Name clash.** `api_spend_summary`/`api_set_global_spend_cap` already have a
    spend `killSwitch`. That is a spend halt, unrelated; the new feature is
    always called the *provider* kill switch.
12. **pgTAP cannot run against the draft in CI.** The suite lives at
    `supabase/tests/pending/ovd722_provider_kill_switch.sql.pending`; the policy
    runner stages but does not execute non-`.sql` files. It has not been
    executed (no local Postgres in this environment).
13. **Plan test 8 (OVD-319 certification per 1.0 provider)** is a live
    acceptance step recorded in the OVD-395..398 tables. It needs the migration
    applied and live adapters, both out of scope here. The offline equivalent
    is covered: the 1.0 providers are seeded, and the TS tests flip each one
    off/on and check denial and recovery.

## Acceptance criteria -> tests

| Plan test | Where |
| --- | --- |
| 1 engaged: preflight denies, others authorize | pgTAP pending suite; `providerKillSwitch.test.ts` (checkpoint, server preflight) |
| 2 engaged after authorization: refused before launch, no adapter call | `providerKillSwitch.test.ts` "worker re-check after authorization"; handler test "flipped after the server authorized" |
| 3 read throws or times out: refuse | `providerKillSwitch.test.ts` fail-closed cases (throw, sync throw, >2 s, malformed, missing row, RPC error) |
| 4 audit row per flip; UPDATE/DELETE fail | pgTAP pending suite |
| 5 non-admin/anon refused; EXECUTE grants via pg_proc | pgTAP pending suite; `scripts/provider-kill.test.mjs` (service role refused) |
| 6 global: all denied; off restores per-provider state | `providerKillSwitch.test.ts`; pgTAP pending suite |
| 7 queued -> cancelled_provider_disabled; running stops at checkpoint | handler tests; `providerPortalKernel.test.ts`; sweep tests; pgTAP sweep |
| Release: data flip, no redeploy/restart | `providerKillSwitch.test.ts` "RELEASE REQUIREMENT"; handler "same handler, no restart" |
| Admin UI typed reason + confirmation | `src/components/admin/ProviderKillSwitchCard.test.tsx` |
| CLI uses admin session only | `scripts/provider-kill.test.mjs` |
