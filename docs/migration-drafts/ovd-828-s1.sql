-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-828 S1 (OVD-829): universal per-supplier settings. One row per supplier
-- in private.provider_kill_switches now carries both the on/off switch and an
-- optional daily quote cap, and the worker counts every dispatch durably.
-- There is NO default cap (Blaine, 2026-10-16): the column defaults to null
-- (unlimited) and existing rows are not backfilled. A supplier is capped only
-- when an admin sets a positive integer.
--
-- This is a DRAFT. It must not be copied into supabase/migrations/ or applied
-- to any database outside a Blaine-approved migration window. When approved,
-- it ships as ONE migration (next timestamp from `npm run migration:new`), and
-- supabase/tests/pending/ovd829_provider_settings.sql.pending is renamed to
-- supabase/tests/ovd829_provider_settings.sql in the same change.
-- Rollback: docs/migration-drafts/ovd-828-s1.rollback.sql.
--
-- Requires: 20261013043100_ovd722_provider_kill_switch.sql (applied).
--
-- Transaction: no begin/commit of its own. The migration runner wraps it in
-- one transaction. By hand:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f <file>
--
-- Companion changes in the same window/PR as the migration:
--   * supabase/tests/ovd722_provider_kill_switch.sql: its pg_temp.ovd722_as
--     helper must add 'aal': 'aal2' to the JWT claims. This draft adds the
--     AAL2 check to api_admin_set_provider_kill_switch, so the admin calls in
--     that suite fail without it.
--   * supabase/tests/api_role_privilege_inventory.sql: add
--     ('public.api_admin_set_provider_settings(public.vendor_name,boolean,integer,text,bigint)',
--      'authenticated', 'admin-aal2', 'OVD-829').
--
-- Interaction with other unapplied drafts:
--   * ovd-766-a.sql replaces api_admin_set_provider_kill_switch with the same
--     require_verified_auth() + current_user_has_aal2() guard used here. Either
--     order is safe: if 766-a runs after this draft, its body writes only the
--     on/off columns and leaves daily_quote_cap untouched (its audit rows carry
--     a null cap). Prefer running this draft last so the delegating body wins.
--   * ovd-771.sql changes provider_kill_switch_audit.actor to text. The uuid
--     actor inserted below assigns to text through the standard assignment
--     cast, so either order works. Its service_role list RPC does not return
--     the cap; the CLI keeps flipping on/off only.
--   * ovd-678-provider-daily-quote-cap.sql (worker passes the cap in) and the
--     v_daily_cap constant in provider-fanout-guards.sql are superseded by the
--     database cap here. Neither is applied; rebind fan-out guards to
--     private.provider_daily_quote_usage and the row cap before review.
--
-- Deploy gate (worker flag WORKER_PROVIDER_DURABLE_DISPATCH_CAP, default off):
--   * The OVD-829 worker may merge and deploy before this migration with the
--     flag off. Off keeps the kill switch (fail closed) and counts an
--     admin-set cap per worker process, using the cap read through
--     api_worker_provider_settings_state. While that RPC does not exist yet,
--     or whenever the read fails, there is no cap (never a default). It never
--     calls api_worker_reserve_provider_dispatch.
--   * Turn the flag on (worker and operator tool env) AFTER this migration is
--     applied, in the same window. With the flag on, every live dispatch
--     reserves through api_worker_reserve_provider_dispatch. If that RPC is
--     missing or failing, the worker re-reads the settings: a supplier with a
--     readable positive cap is refused (provider_dispatch_counter_unavailable);
--     otherwise there is no cap to enforce and the dispatch goes ahead
--     uncounted. The kill switch fails closed in every case.
--   * Rollback order is the reverse: flag off first, then the rollback file.
--
-- Not changed here: api_admin_set_global_kill_switch stays AAL1 until
-- ovd-766-a.sql is applied. That draft owns the global switch's AAL2 guard;
-- this draft deliberately touches only the per-supplier RPCs.
--
-- Counting: a reservation is taken immediately before the adapter launches,
-- ahead of the generic route's inner export-control recheck, and is never
-- refunded. A lane refused after reserving, or a reservation that commits
-- after the worker's 2s client timeout, still counts. usedToday can therefore
-- run slightly above real sends; it never runs below.
--
-- What changes:
--   * private.provider_kill_switches.daily_quote_cap: integer, default null
--     (unlimited), otherwise > 0. No backfill: every existing row stays null.
--     The check constraint refuses <= 0, so a cap is only ever a positive
--     integer an admin set.
--   * private.provider_kill_switch_audit gains daily_quote_cap and
--     previous_daily_quote_cap (both null on global rows and on rows written
--     before this migration).
--   * private.provider_daily_quote_usage: durable per supplier, per UTC day
--     dispatch counter. Shared by every worker and survives restarts.
--   * public.api_worker_reserve_provider_dispatch (service_role): atomic
--     check and increment. Kill switch beats cap.
--   * public.api_worker_provider_settings_state (service_role): read only.
--   * public.api_admin_set_provider_settings (authenticated, admin + AAL2).
--   * api_admin_set_provider_kill_switch: CREATE OR REPLACE, adds
--     require_verified_auth() and the AAL2 check, delegates to the shared
--     private writer and preserves the cap under the row lock.
--   * api_admin_list_provider_kill_switches: CREATE OR REPLACE, returns
--     dailyQuoteCap and usedToday per provider. Same schema tag; the client
--     treats the new keys as optional.
-- =====================================================================

-- =====================================================================
-- Settings columns
-- =====================================================================
-- No default and no backfill: null is unlimited.
alter table private.provider_kill_switches
  add column if not exists daily_quote_cap integer;

alter table private.provider_kill_switches
  drop constraint if exists provider_kill_switches_daily_quote_cap_check;
alter table private.provider_kill_switches
  add constraint provider_kill_switches_daily_quote_cap_check
  check (daily_quote_cap is null or daily_quote_cap > 0);

comment on column private.provider_kill_switches.daily_quote_cap is
  'OVD-828: automated quote dispatches allowed per UTC day, set by an admin. Null (the default) means unlimited.';

-- ADD COLUMN with no volatile default rewrites nothing and fires no row
-- trigger, so the append-only triggers on the audit table are untouched.
alter table private.provider_kill_switch_audit
  add column if not exists daily_quote_cap integer,
  add column if not exists previous_daily_quote_cap integer;

-- =====================================================================
-- Durable daily counter
-- =====================================================================
create table if not exists private.provider_daily_quote_usage (
  provider public.vendor_name not null,
  -- UTC calendar day.
  usage_date date not null,
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (provider, usage_date)
);

revoke all on table private.provider_daily_quote_usage from public, anon, authenticated, service_role;
alter table private.provider_daily_quote_usage enable row level security;
alter table private.provider_daily_quote_usage force row level security;

-- Atomic check and increment for one dispatch. Called by the worker
-- immediately before an adapter launches, once per dispatch.
--
-- Order, all under the supplier's settings row lock:
--   1. global switch engaged, missing row, or supplier engaged -> refuse
--      provider_disabled (fail closed, same rule as
--      private.provider_kill_switch_engaged). Nothing is counted.
--   1a. a stored cap <= 0 (impossible under the check constraint) -> null.
--   2. cap is null (the default) -> allowed, counted (usedToday stays truthful).
--   3. today's count >= cap -> refuse provider_daily_cap_reached, not counted.
--   4. otherwise -> allowed, counted.
-- A reservation is never refunded: a dispatch that then fails still counts.
create or replace function public.api_worker_reserve_provider_dispatch(p_provider public.vendor_name)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := pg_catalog.timezone('UTC', pg_catalog.now())::date;
  v_global_engaged boolean;
  v_engaged boolean;
  v_cap integer;
  v_used integer;
begin
  if p_provider is null then
    raise exception 'provider_required' using errcode = '22023';
  end if;

  -- Global row first: the same table order as every switch reader and the
  -- OVD-722 rollback guard, so this can never deadlock with them.
  v_global_engaged := coalesce(
    (select g.engaged from private.provider_global_kill_switch g where g.singleton), true);

  -- The lock serializes reservations for one supplier with each other and with
  -- an admin flip, so a cap or switch change applies to the very next dispatch.
  select s.engaged, s.daily_quote_cap into v_engaged, v_cap
  from private.provider_kill_switches s
  where s.provider = p_provider
  for update;

  if not found then
    v_engaged := true;
  end if;

  -- A stored cap that is not a positive integer can only be a corrupt row (the
  -- check constraint forbids it). There is no default cap, so it reads as no
  -- cap, the same as the worker treats an unreadable or invalid cap. The kill
  -- switch above is what stops a supplier; the cap applies only when an admin
  -- set a positive integer.
  if v_cap is not null and v_cap <= 0 then
    v_cap := null;
  end if;

  select u.count into v_used
  from private.provider_daily_quote_usage u
  where u.provider = p_provider and u.usage_date = v_today;
  v_used := coalesce(v_used, 0);

  if v_global_engaged or v_engaged then
    return pg_catalog.jsonb_build_object(
      'schema', 'provider-dispatch-reservation.v1',
      'provider', p_provider, 'allowed', false, 'reason', 'provider_disabled',
      'cap', v_cap, 'used', v_used);
  end if;

  if v_cap is not null and v_used >= v_cap then
    return pg_catalog.jsonb_build_object(
      'schema', 'provider-dispatch-reservation.v1',
      'provider', p_provider, 'allowed', false, 'reason', 'provider_daily_cap_reached',
      'cap', v_cap, 'used', v_used);
  end if;

  insert into private.provider_daily_quote_usage as u (provider, usage_date, count)
  values (p_provider, v_today, 1)
  on conflict (provider, usage_date) do update
    set count = u.count + 1, updated_at = pg_catalog.clock_timestamp()
  returning u.count into v_used;

  return pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-reservation.v1',
    'provider', p_provider, 'allowed', true, 'reason', null,
    'cap', v_cap, 'used', v_used);
end;
$$;

revoke all on function public.api_worker_reserve_provider_dispatch(public.vendor_name)
  from public, anon, authenticated, service_role;
grant execute on function public.api_worker_reserve_provider_dispatch(public.vendor_name)
  to service_role;

-- Worker read of one supplier's settings; counts nothing. Missing rows read
-- as engaged, like api_worker_provider_kill_switch_state (which is unchanged:
-- the worker parses its exact v1 key set).
create or replace function public.api_worker_provider_settings_state(p_provider public.vendor_name)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-settings-state.v1',
    'provider', p_provider,
    'globalEngaged',
      coalesce((select g.engaged from private.provider_global_kill_switch g where g.singleton), true),
    'engaged', p_provider is null
      or coalesce((select s.engaged from private.provider_kill_switches s where s.provider = p_provider), true),
    'dailyQuoteCap', (select s.daily_quote_cap from private.provider_kill_switches s where s.provider = p_provider),
    'usedToday', coalesce((
      select u.count from private.provider_daily_quote_usage u
      where u.provider = p_provider
        and u.usage_date = pg_catalog.timezone('UTC', pg_catalog.now())::date), 0)
  );
$$;

revoke all on function public.api_worker_provider_settings_state(public.vendor_name)
  from public, anon, authenticated, service_role;
grant execute on function public.api_worker_provider_settings_state(public.vendor_name)
  to service_role;

-- =====================================================================
-- Shared writer (no grants; called only from the admin RPCs below)
-- =====================================================================
-- Compare and set:
--   * p_expected_version null: an emergency engage. Allowed only with
--     p_engaged = true, and it never changes the cap, so a stop decided on a
--     stale view still wins and cannot overwrite another admin's cap.
--   * otherwise the version must equal the row's current version, or the call
--     fails with kill_switch_version_conflict and changes nothing.
-- p_set_cap false keeps the current cap (read under the row lock).
create or replace function private.write_provider_settings(
  p_actor uuid,
  p_provider public.vendor_name,
  p_engaged boolean,
  p_set_cap boolean,
  p_daily_quote_cap integer,
  p_reason text,
  p_expected_version bigint
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_at timestamptz;
  v_current_version bigint;
  v_previous_cap integer;
  v_cap integer;
  v_version bigint;
begin
  -- A missing row reads as engaged (fail closed). Materialize it that way so
  -- there is always a row to lock; a concurrent flip cannot slip in unlocked.
  insert into private.provider_kill_switches (provider, engaged)
  values (p_provider, true)
  on conflict (provider) do nothing;

  -- Take the row lock first; the version check and timestamp are read after it.
  select s.version, s.daily_quote_cap into strict v_current_version, v_previous_cap
  from private.provider_kill_switches s
  where s.provider = p_provider
  for update;

  if p_expected_version is null then
    if not p_engaged then
      raise exception 'kill_switch_version_conflict'
        using errcode = 'P0001',
              detail = pg_catalog.format('expected version none, current version %s', v_current_version);
    end if;
  elsif p_expected_version <> v_current_version then
    raise exception 'kill_switch_version_conflict'
      using errcode = 'P0001',
            detail = pg_catalog.format('expected version %s, current version %s',
              p_expected_version, v_current_version);
  end if;

  v_cap := case when p_set_cap and p_expected_version is not null then p_daily_quote_cap else v_previous_cap end;

  -- Captured after the lock wait so the recorded time orders with the commit.
  v_at := pg_catalog.clock_timestamp();

  update private.provider_kill_switches s
  set engaged = p_engaged,
      daily_quote_cap = v_cap,
      reason = p_reason,
      engaged_by = p_actor,
      engaged_at = v_at,
      version = s.version + 1
  where s.provider = p_provider
  returning s.version into strict v_version;

  insert into private.provider_kill_switch_audit
    (at, actor, provider, engaged, reason, daily_quote_cap, previous_daily_quote_cap)
  values (v_at, p_actor, p_provider, p_engaged, p_reason, v_cap, v_previous_cap);

  return pg_catalog.jsonb_build_object(
    'provider', p_provider,
    'engaged', p_engaged,
    'dailyQuoteCap', v_cap,
    'reason', p_reason,
    'changedBy', p_actor,
    'changedAt', v_at,
    'version', v_version
  );
end;
$$;

revoke all on function private.write_provider_settings(uuid, public.vendor_name, boolean, boolean, integer, text, bigint)
  from public, anon, authenticated, service_role;

-- =====================================================================
-- Admin RPCs
-- =====================================================================
-- Sets one supplier's on/off state and daily quote cap together. A cap of
-- null means unlimited. Changing the cap, or releasing, needs the version the
-- admin decided on; an engage with no version is the emergency stop and keeps
-- the current cap.
create or replace function public.api_admin_set_provider_settings(
  p_provider public.vendor_name,
  p_engaged boolean,
  p_daily_quote_cap integer,
  p_reason text,
  p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_reason text;
begin
  perform public.require_verified_auth();

  v_actor := auth.uid();
  if v_actor is null or not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  if not public.current_user_has_aal2() then
    raise exception 'Multi-factor authentication is required for provider kill switch administration.'
      using errcode = '42501';
  end if;

  v_reason := pg_catalog.btrim(p_reason);
  if p_provider is null then
    raise exception 'provider_required' using errcode = '22023';
  end if;
  if p_engaged is null then
    raise exception 'engaged_required' using errcode = '22023';
  end if;
  if p_daily_quote_cap is not null and p_daily_quote_cap <= 0 then
    raise exception 'daily_quote_cap_must_be_positive' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;

  return private.write_provider_settings(
    v_actor, p_provider, p_engaged, true, p_daily_quote_cap, v_reason, p_expected_version);
end;
$$;

revoke all on function public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint)
  to authenticated;

-- Same signature, grants and return keys as OVD-722, plus dailyQuoteCap.
-- Adds verified auth and AAL2. Engage still ignores p_expected_version (the
-- emergency stop always wins); release stays compare and set. The cap is
-- never changed here.
create or replace function public.api_admin_set_provider_kill_switch(
  p_provider public.vendor_name,
  p_engaged boolean,
  p_reason text,
  p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_reason text;
begin
  perform public.require_verified_auth();

  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  if not public.current_user_has_aal2() then
    raise exception 'Multi-factor authentication is required for provider kill switch administration.'
      using errcode = '42501';
  end if;

  v_actor := auth.uid();
  v_reason := pg_catalog.btrim(p_reason);
  if v_actor is null then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  if p_provider is null then
    raise exception 'provider_required' using errcode = '22023';
  end if;
  if p_engaged is null then
    raise exception 'engaged_required' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;

  return private.write_provider_settings(
    v_actor, p_provider, p_engaged, false, null, v_reason,
    case when p_engaged then null else p_expected_version end);
end;
$$;

revoke all on function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
  to authenticated;

-- Admin page read: OVD-722 shape plus dailyQuoteCap and usedToday per provider.
create or replace function public.api_admin_list_provider_kill_switches()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := pg_catalog.timezone('UTC', pg_catalog.now())::date;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'schema', 'provider-kill-switch-admin.v1',
    'global', (
      select pg_catalog.jsonb_build_object(
        'engaged', g.engaged, 'reason', g.reason,
        'changedBy', g.engaged_by, 'changedAt', g.engaged_at, 'version', g.version)
      from private.provider_global_kill_switch g where g.singleton
    ),
    'providers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'provider', s.provider, 'engaged', s.engaged, 'reason', s.reason,
        'changedBy', s.engaged_by, 'changedAt', s.engaged_at, 'version', s.version,
        'dailyQuoteCap', s.daily_quote_cap,
        'usedToday', coalesce(u.count, 0)) order by s.provider::text)
      from private.provider_kill_switches s
      left join private.provider_daily_quote_usage u
        on u.provider = s.provider and u.usage_date = v_today
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.api_admin_list_provider_kill_switches()
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_list_provider_kill_switches()
  to authenticated;
