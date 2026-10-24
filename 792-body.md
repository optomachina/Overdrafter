Implements **OVD-829** (OVD-828 S1): one per-supplier settings framework for every supplier.

## Summary
- Migration **draft only**: `docs/migration-drafts/ovd-828-s1.sql` + `.rollback.sql`. Adds `daily_quote_cap` to `private.provider_kill_switches` (default 20; null means unlimited; must be > 0). Adds a durable `private.provider_daily_quote_usage` counter and a service_role-only `api_worker_reserve_provider_dispatch`, which checks the limit and increments the counter in one atomic step. The new admin RPC `api_admin_set_provider_settings` is SECURITY DEFINER with `search_path=''`, REVOKE/GRANT, auth check, `is_platform_admin()` and `current_user_has_aal2()`. Also adds the missing AAL2 check to `api_admin_set_provider_kill_switch`.
- pgTAP: `supabase/tests/pending/ovd829_provider_settings.sql.pending`.
- Worker: `providerKillSwitch.ts` becomes `providerSettings.ts`; the old path re-exports. One guard at the generic dispatch step. The kill switch beats the cap. If the on/off read fails, the supplier is treated as off. If the cap read fails, the cap falls back to 20. Counting is durable in the DB.
- RMFG: removed `RMFG_DAILY_QUOTE_CAP`, the in-memory `quotesToday` counter and the daily-cap branch.
- OSHCut: #743 adds a separate per-process cap in `worker/src/providerDailyQuoteCap.ts`. Whichever of #743 / this PR lands second must replace that cap with this universal supplier settings gate (no parallel caps).
- Admin UI: each supplier row gets a cap input with an Unlimited option.
- Docs: `business-model.md` now says the cap defaults to 20 and is admin-configurable per supplier, including unlimited (OVD-828).

## Deploy notes
- Apply the migration **before** deploying the worker. Without the counting function, every live dispatch is refused.
- When the migration is promoted, `supabase/tests/ovd722_provider_kill_switch.sql` needs `aal2` claims, and `api_role_privilege_inventory.sql` needs a row for the new RPC.

## Proof
- `npm run preflight -- lint typecheck`: pass
- `npx vitest run --maxWorkers=2`: 11496 passed, 3 failed. All 3 failures are the known docker `scripts/qualify-ovd417-four-migration-suffix.test.mjs` failure.
- New `worker/src/providerSettings.test.ts`:
  - A new fake adapter gets the cap and kill switch with no code of its own.
  - Turning a supplier off stops the next dispatch.
  - A null cap never refuses; a raised cap of 50 works; a cap of N refuses at N+1.
  - A cap read failure falls back to 20; an engaged kill switch returns `provider_disabled`.
  - A static check that no adapter references a cap.
- `e2e/admin-operations.spec.ts`: covers set cap, persist across reload, unlimited, and toggle off (6/6 pass locally).
- Nothing under `supabase/migrations/` changed; no SQL was applied anywhere.


## Deploy gate (added after Opus review)
- New worker flag `WORKER_PROVIDER_DURABLE_DISPATCH_CAP` (default `off`). Off: kill switch still fails closed; cap read fail-safe (default 20) and counted per process. Turn `on` only after `docs/migration-drafts/ovd-828-s1.sql` is applied in a Blaine-approved window; rollback = flag off first.
- Operator CLI tools (vendorWorkflowSmoke, xometryQuantitySweep) now go through the same dispatch gate, so RMFG keeps a cap on every path.

Linear: https://linear.app/overdrafter/issue/OVD-829
