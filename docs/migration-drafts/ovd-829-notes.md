# OVD-829 notes

The supplier-settings draft `docs/migration-drafts/ovd-828-s1.sql` is promoted to
`supabase/migrations/20261104032100_ovd829_provider_daily_quote_cap.sql` and kept
only as history (SUPERSEDED). Rollback: `docs/migration-drafts/ovd-829.rollback.sql`.
Tests: `supabase/tests/ovd829_provider_settings.sql` and
`supabase/tests/ovd829_provider_settings_rollback.sql` (re-run, rollback, rollback
replay, re-apply).

## What the migration does on production data

- Adds `private.provider_kill_switches.daily_quote_cap` (integer, no default, `> 0`
  or null). No backfill: every supplier, Xometry included, stays **uncapped** after
  apply. Nothing is capped until someone sets a cap.
- Adds `daily_quote_cap` / `previous_daily_quote_cap` to the append-only audit table
  (null on every existing row) and creates `private.provider_daily_quote_usage`.
- No supplier's on/off state changes. The kill switch keeps failing closed.
- Rebased onto the deployed bodies: `api_admin_set_provider_kill_switch` (OVD-767,
  md5 `09f76c673f7e13f2e49fe6faed0c44d3`) and `api_admin_list_provider_kill_switches`
  (OVD-722, md5 `568ff534f3ad60f4d4754b6e7f754a74`). The guard refuses (SQLSTATE
  55000, nothing changed) if either holds any other body, or if a new function name
  already holds a different body. Re-running the file is a no-op.
- `lock_timeout` is 5 s. If a worker holds the settings row lock that long, the apply
  fails cleanly; re-run it.

## Deploy order

1. Apply the migration in the authorized window (one transaction).
2. Set `WORKER_PROVIDER_DURABLE_DISPATCH_CAP=on` on the worker and in the operator
   tool environment, and restart the worker. Before this, the worker already reads
   the cap through `api_worker_provider_settings_state` but counts it per process
   (each worker and each restart gets its own allowance). With the flag on, every
   live dispatch takes one atomic reservation in `private.provider_daily_quote_usage`.
3. Set the caps you want (below). Until you do, nothing is capped.

Rollback order is the reverse: flag off, then the rollback file.

## Setting a Xometry daily cap (audited service-role setter)

`public.api_service_set_provider_daily_quote_cap(p_provider, p_daily_quote_cap,
p_reason, p_operator, p_expected_version)` is executable by `service_role` only. It
changes only the cap, never the on/off state, and always compares and sets: pass the
row's current `version`, or it fails with `kill_switch_version_conflict` and changes
nothing. Each call writes one audit row with actor `cli:service_role`, the operator
name (2 to 120 characters), the reason (at least 10 characters), the new cap and the
previous cap. A cap must be a positive integer; `null` clears it (unlimited).

From a SQL session in the migration window (role switched so the grant is what
allows the call):

```sql
begin;
set local role service_role;

-- 1. Read Xometry's current version (and on/off state).
select p
from jsonb_array_elements(public.api_service_list_provider_kill_switches() -> 'providers') p
where p ->> 'provider' = 'xometry';

-- 2. Set the cap, naming that version (here: 20 dispatches per UTC day).
select public.api_service_set_provider_daily_quote_cap(
  'xometry', 20, 'OVD-829: Xometry daily quote cap for the controlled beta',
  '<your name>', <version from step 1>);

-- 3. Verify what the worker will read.
select public.api_worker_provider_settings_state('xometry');
-- expect "dailyQuoteCap": 20, plus today's "usedToday"
commit;
```

The same call over PostgREST with the service-role key (never echo or log the key):

```sh
curl -sS -X POST "$SUPABASE_URL/rest/v1/rpc/api_service_set_provider_daily_quote_cap" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"p_provider":"xometry","p_daily_quote_cap":20,"p_reason":"OVD-829: Xometry daily quote cap for the controlled beta","p_operator":"<your name>","p_expected_version":<version>}'
```

Read the version first with `POST /rest/v1/rpc/api_service_list_provider_kill_switches`
(or `npm run provider:kill -- --list`).

The response carries `dailyQuoteCap`, `previousDailyQuoteCap`, `engaged` (unchanged),
`changedBy: "cli:service_role"`, `operator` and the new `version`. To clear the cap,
repeat with `p_daily_quote_cap` null and the new version. A platform admin with an
AAL2 session can also set the cap in the admin dashboard
(`api_admin_set_provider_settings`).

When the cap is reached, the next Xometry dispatch that UTC day is refused with
`provider_daily_cap_reached` before anything is sent; the count resets at 00:00 UTC.
A reservation is never refunded, so `usedToday` can run slightly above real sends.
