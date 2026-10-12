# OVD-722 provider kill switch: implementation notes

Status: SQL is a draft (`docs/migration-drafts/ovd-722.sql`, **NEEDS BLAINE
MIGRATION WINDOW - not applied**). Nothing under `supabase/migrations/` was
created or edited. No database, remote, or provider was touched.

## Release requirement: off within 1 hour, no deploy

The switch is runtime data in `private.provider_kill_switches` and
`private.provider_global_kill_switch`. Nothing caches it:

- enqueue is refused by a trigger on the permit tables, in the request's own
  transaction (the server preflights are unchanged in window 1, see item 6);
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
   In window 1 the preflights do not emit this code (item 6); the handling is
   kept, tested, for the later contract step.
6. **No existing RPC is edited or wrapped (window 1 is expand only).** The
   existing preflight and enqueue RPCs are large, and existing main pgTAP
   suites pin their `prosrc` and `proconfig`. Window rules allow expand only,
   so the two worker preflights are left as they are: the OVD-722 worker
   enforces the switch at claim and before every provider step, and the
   worker's handling of a server `provider_kill_switch_engaged` denial stays
   in place for the later contract step that folds the check into the
   preflight bodies. The two request (enqueue) RPCs are not touched at
   all either: both insert exactly one permit row for every new dispatch, inside
   their own transaction and with no exception handler, so a BEFORE INSERT
   trigger on `private.provider_dispatch_permits` and
   `private.xometry_beta_dispatch_permits` refuses with
   `provider_kill_switch_engaged` and rolls back the lane and task created in
   the same call. An idempotent replay of an existing permit inserts nothing
   and is not refused there; the worker claim check still stops it. No existing suite needs retargeting (window 1 rehearsal, see below).
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
    executed (no Docker daemon or Supabase CLI in this environment). The admin
    RPCs and tables themselves are executed by
    `docs/migration-drafts/ovd-722-race-check.sh` on a disposable local
    Postgres (see "Cross review fixes").
13. **Plan test 8 (OVD-319 certification per 1.0 provider)** is a live
    acceptance step recorded in the OVD-395..398 tables. It needs the migration
    applied and live adapters, both out of scope here. The offline equivalent
    is covered: the 1.0 providers are seeded, and the TS tests flip each one
    off/on and check denial and recovery.

## Cross review fixes (Codex static review of 8e557eb)

1. **Fresh check before every mutation, not once per phase.** The kernel now
   re-reads the switch immediately before the CAD `setInputFiles`, the drawing
   `setInputFiles`, the quantity fill, each configure hook `fill`/`select`, any
   bounded recovery, and before every navigation attempt including the retry;
   `runIntentionalPortalRetry` never retries past a `ProviderKillSwitchError`.
   Xometry re-reads before the export control submit, each of material,
   finish and tolerance, and before Save Configuration (new checkpoint
   `before_save`). Fictiv re-reads between quantity, material/finish and end
   use. A request the browser already sent cannot be recalled; the switch stops
   the next step, and `providerMutationPossible` records that the provider may
   already hold the upload.
2. **Release is compare and set.** Both switch tables carry `version`, bumped on
   every flip. `api_admin_set_provider_kill_switch` and
   `api_admin_set_global_kill_switch` take `p_expected_version bigint default
   null`. Engage ignores it and always wins. Release must match the current
   version or fails `kill_switch_version_conflict` with no write and no audit
   row. The list RPC returns `version`; the admin card sends the version of the
   row the admin clicked, and the CLI reads and shows the current row before
   confirming a release. A missing row is first materialized engaged (fail
   closed) so there is always a row to lock.
3. **`changedAt` is taken after the row lock**, not at function entry.
4. **Audit immutability wording** now says what holds: no application role can
   update, delete or truncate the audit table; the owner or a superuser can
   still disable triggers.
5. **Forced RLS with no policies** on all three tables, matching
   `private.provider_dispatch_permits`. Nothing reads them directly; every
   caller goes through the security definer RPCs, owned by the BYPASSRLS
   migration role.

`docs/migration-drafts/ovd-722-race-check.sh` runs the draft's switch section on
a throwaway local Postgres (non superuser BYPASSRLS owner, like Supabase's
`postgres`) and checks: versionless and stale releases are refused; a release
waiting on the row lock behind an engage is refused after the engage commits;
`changedAt` is after the lock wait; the global switch follows the same rule;
forced RLS hides rows from a mistakenly granted role while the RPCs still read
them. Against the pre-fix draft it fails.

## Window 1 rehearsal fixes

The window 1 rehearsal (PR #687) ran the draft at f3ce78b3 and found 4 main
suites broken (`job_service_detail_privileges`,
`provider_dispatch_admission_serialization`, `provider_dispatch_permits`,
`xometry_beta_dispatch_admission_serialization`), a nested `begin;`/`commit;`,
and no rollback order guard.

* All four wrappers are gone (expand only, item 6). Enqueue is refused by
  the permit insert trigger. All main suites keep their original assertions.
  A worker build without OVD-722 does not read the switch, so the migration
  and the OVD-722 worker deploy go in the same window.
* The file has no transaction control of its own; the runner owns the
  transaction. `begin;`/`commit;` remain only in the commented rollback.
* The rollback starts with a guard modeled on OVD-462: it refuses a role that
  cannot bypass RLS, takes ACCESS EXCLUSIVE on both switch tables (global
  first) before checking, refuses while any switch is engaged unless
  `set local ovd722.rollback_discard_engagements = 'confirmed'`, and refuses
  while any function outside this migration references the switch (roll the
  dependent migration back first).
* The worker state read takes the global row before the provider row, the
  same order as the guard's lock, so the two cannot deadlock.
* The sweep joins `vendor_quote_results` on its uuid key (indexable) and skips
  queued tasks that carry no `vendor`.

## Acceptance criteria -> tests

| Plan test | Where |
| --- | --- |
| 1 engaged: dispatch refused, others continue | pgTAP pending suite (enqueue trigger); `providerKillSwitch.test.ts` (worker checkpoints) |
| 2 engaged after authorization: refused before launch, no adapter call | `providerKillSwitch.test.ts` "worker re-check after authorization"; handler test "flipped after the server authorized" |
| 3 read throws or times out: refuse | `providerKillSwitch.test.ts` fail-closed cases (throw, sync throw, >2 s, malformed, missing row, RPC error) |
| 4 audit row per flip; UPDATE/DELETE fail | pgTAP pending suite |
| 5 non-admin/anon refused; EXECUTE grants via pg_proc | pgTAP pending suite; `scripts/provider-kill.test.mjs` (service role refused) |
| 6 global: all denied; off restores per-provider state | `providerKillSwitch.test.ts`; pgTAP pending suite |
| 7 queued -> cancelled_provider_disabled; running stops at checkpoint | handler tests; `providerPortalKernel.test.ts`; sweep tests; pgTAP sweep |
| Release: data flip, no redeploy/restart | `providerKillSwitch.test.ts` "RELEASE REQUIREMENT"; handler "same handler, no restart" |
| Admin UI typed reason + confirmation | `src/components/admin/ProviderKillSwitchCard.test.tsx` |
| Engaged mid step: no later upload, save or navigation retry | `providerPortalKernel.test.ts` (OVD-722 block); `xometry.test.ts` "Save Configuration is never clicked" |
| Stale release never clears a newer engagement | `ovd-722-race-check.sh` (two sessions); pgTAP pending suite; API, card and CLI tests |
| CLI uses admin session only | `scripts/provider-kill.test.mjs` |
