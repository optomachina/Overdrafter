-- OVD-829 (OVD-828 S1): universal per-supplier settings. Promotes
-- docs/migration-drafts/ovd-828-s1.sql, rebased onto the bodies deployed today.
--
-- One row per supplier in private.provider_kill_switches now carries both the
-- on/off switch and an optional daily quote cap, and the worker can count every
-- dispatch durably. There is NO default cap (Blaine, 2026-10-16): the column
-- defaults to null (unlimited) and existing rows are not backfilled. A supplier
-- is capped only when an admin or an audited service-role operator sets a
-- positive integer.
--
-- Apply as one transaction, in filename order (after 20261101130300 and any
-- migration timestamped before this one). Production apply follows
-- merge and requires the authorized migration window.
-- Rollback: docs/migration-drafts/ovd-829.rollback.sql.
-- Runbook (deploy order, setting a Xometry cap): docs/migration-drafts/ovd-829-notes.md.
-- Tests: supabase/tests/ovd829_provider_settings.sql and
-- supabase/tests/ovd829_provider_settings_rollback.sql.
--
-- Rebased (md5 of prosrc, guarded below):
--   public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
--     from 20261016000156_ovd767_admin_write_aal2_guards.sql. Keeps
--     require_verified_auth(), the platform admin check and the AAL2 check
--     with the same message and SQLSTATE (P0001), and the same engage/release
--     compare and set rule. Now delegates to the shared writer so a flip keeps
--     the cap, and returns dailyQuoteCap.
--   public.api_admin_list_provider_kill_switches()
--     from 20261013043100_ovd722_provider_kill_switch.sql. Adds dailyQuoteCap
--     and usedToday per provider; same schema tag.
-- New functions are refused if a different body already holds the name. Every
-- guarded function also accepts this migration's own body, so re-running the
-- file is a no-op.
--
-- Requires 20261015221725_ovd771_service_kill_switch.sql (audit actor is text
-- with the cli:service_role/operator check); the guard refuses otherwise.
--
-- What changes:
--   * private.provider_kill_switches.daily_quote_cap: integer, default null
--     (unlimited), otherwise > 0. No backfill.
--   * private.provider_kill_switch_audit gains daily_quote_cap and
--     previous_daily_quote_cap (null on global rows and on older rows).
--   * private.provider_daily_quote_usage: durable per supplier, per UTC day
--     dispatch counter. Shared by every worker and survives restarts.
--   * public.api_worker_reserve_provider_dispatch (service_role): atomic
--     check and increment. Kill switch beats cap.
--   * public.api_worker_provider_settings_state (service_role): read only.
--   * public.api_admin_set_provider_settings (authenticated, admin + AAL2).
--   * public.api_service_set_provider_daily_quote_cap (service_role): sets
--     only the cap, compare and set, audited as actor 'cli:service_role' with
--     the named operator (the OVD-771 rule). Never changes the on/off state.
--
-- Deploy gate (worker flag WORKER_PROVIDER_DURABLE_DISPATCH_CAP, default off):
-- with the flag off the worker already reads the cap through
-- api_worker_provider_settings_state and counts it per process; turn the flag
-- on (worker and operator tool env) after this migration is applied so every
-- worker shares the durable counter. Rollback order is the reverse.
--
-- Counting: a reservation is taken immediately before the adapter launches
-- and is never refunded, so usedToday can run slightly above real sends; it
-- never runs below.

set local lock_timeout = '5s';

do $ovd829_guard$
declare
  v_md5 text;
  v_type text;
  v_check record;
begin
  if pg_catalog.to_regclass('private.provider_kill_switches') is null
    or pg_catalog.to_regclass('private.provider_kill_switch_audit') is null
    or pg_catalog.to_regclass('private.provider_global_kill_switch') is null then
    raise exception 'OVD-829 refused: the OVD-722 kill switch tables are missing'
      using errcode = '55000';
  end if;

  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute a
  where a.attrelid = 'private.provider_kill_switch_audit'::regclass
    and a.attname = 'actor' and not a.attisdropped;
  if v_type is distinct from 'text' then
    raise exception 'OVD-829 refused: provider_kill_switch_audit.actor is %, expected text (OVD-771)', v_type
      using errcode = '55000';
  end if;

  select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type
  from pg_catalog.pg_attribute a
  where a.attrelid = 'private.provider_kill_switches'::regclass
    and a.attname = 'daily_quote_cap' and not a.attisdropped;
  if v_type is not null and v_type <> 'integer' then
    raise exception 'OVD-829 refused: provider_kill_switches.daily_quote_cap already exists as %', v_type
      using errcode = '55000';
  end if;

  for v_check in
    select * from (values
      ('public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)',
        array['09f76c673f7e13f2e49fe6faed0c44d3', '3fb90f240be8141453f95d74abe7e6ed'], false),
      ('public.api_admin_list_provider_kill_switches()',
        array['568ff534f3ad60f4d4754b6e7f754a74', '47235811f7e1e294aa04724cfe572694'], false),
      ('public.api_worker_reserve_provider_dispatch(public.vendor_name)',
        array['9b0dc98bbe7d3cc3e1efd0a820c3f42f'], true),
      ('public.api_worker_provider_settings_state(public.vendor_name)',
        array['60f3757a9865774c036c3fb145ad5559'], true),
      ('private.write_provider_settings(uuid, public.vendor_name, boolean, boolean, integer, text, bigint)',
        array['82f4deaf313bd7210db541b1f945cf99'], true),
      ('public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint)',
        array['39cd3b51531de910bb488b2ca75c1859'], true),
      ('public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)',
        array['5ca9b2fd26b389c1c09afffc4901239d'], true)
    ) as t(signature, accepted, may_be_absent)
  loop
    v_md5 := null;
    select pg_catalog.md5(p.prosrc) into v_md5
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure(v_check.signature);
    if v_md5 is null and v_check.may_be_absent then
      continue;
    end if;
    if v_md5 is null or not (v_md5 = any (v_check.accepted)) then
      raise exception 'OVD-829 refused: % has an unexpected body', v_check.signature
        using errcode = '55000';
    end if;
  end loop;
end;
$ovd829_guard$;

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

-- Same signature, grants, guards and return keys as OVD-767, plus
-- dailyQuoteCap. Engage still ignores p_expected_version (the emergency stop
-- always wins); release stays compare and set. The cap is never changed here.
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
    raise exception 'Multi-factor authentication is required for provider kill switch administration.';
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

-- =====================================================================
-- Service-role cap setter (operator path, OVD-771 audit rule)
-- =====================================================================
-- Sets only the daily quote cap of one supplier; the on/off state is never
-- touched, so setting a cap can never switch a supplier on. A cap of null
-- means unlimited. Always compare and set: p_expected_version must equal the
-- row's current version (read it from api_service_list_provider_kill_switches),
-- or the call fails with kill_switch_version_conflict and changes nothing.
-- The audit row records actor 'cli:service_role' (fixed here; the caller
-- cannot choose it), the required operator name, the reason, the new cap and
-- the previous cap.
create or replace function public.api_service_set_provider_daily_quote_cap(
  p_provider public.vendor_name,
  p_daily_quote_cap integer,
  p_reason text,
  p_operator text,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_operator text;
  v_at timestamptz;
  v_current_version bigint;
  v_engaged boolean;
  v_previous_cap integer;
  v_version bigint;
begin
  v_reason := pg_catalog.btrim(p_reason);
  v_operator := pg_catalog.btrim(p_operator);
  if p_provider is null then
    raise exception 'provider_required' using errcode = '22023';
  end if;
  if p_daily_quote_cap is not null and p_daily_quote_cap <= 0 then
    raise exception 'daily_quote_cap_must_be_positive' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;
  if v_operator is null or pg_catalog.char_length(v_operator) not between 2 and 120 then
    raise exception 'operator_required' using errcode = '22023';
  end if;

  -- A missing row reads as engaged (fail closed); materialize it that way so
  -- there is always a row to lock.
  insert into private.provider_kill_switches (provider, engaged)
  values (p_provider, true)
  on conflict (provider) do nothing;

  select s.version, s.engaged, s.daily_quote_cap
  into strict v_current_version, v_engaged, v_previous_cap
  from private.provider_kill_switches s
  where s.provider = p_provider
  for update;

  if p_expected_version is null or p_expected_version <> v_current_version then
    raise exception 'kill_switch_version_conflict'
      using errcode = 'P0001',
            detail = pg_catalog.format('expected version %s, current version %s',
              coalesce(p_expected_version::text, 'none'), v_current_version);
  end if;

  v_at := pg_catalog.clock_timestamp();

  -- engaged_by is a user id; a service change has none. The operator is in the audit row.
  update private.provider_kill_switches s
  set daily_quote_cap = p_daily_quote_cap,
      reason = v_reason,
      engaged_by = null,
      engaged_at = v_at,
      version = s.version + 1
  where s.provider = p_provider
  returning s.version into strict v_version;

  insert into private.provider_kill_switch_audit
    (at, actor, provider, engaged, reason, operator, daily_quote_cap, previous_daily_quote_cap)
  values (v_at, 'cli:service_role', p_provider, v_engaged, v_reason, v_operator,
    p_daily_quote_cap, v_previous_cap);

  return pg_catalog.jsonb_build_object(
    'provider', p_provider,
    'engaged', v_engaged,
    'dailyQuoteCap', p_daily_quote_cap,
    'previousDailyQuoteCap', v_previous_cap,
    'reason', v_reason,
    'changedBy', 'cli:service_role',
    'operator', v_operator,
    'changedAt', v_at,
    'version', v_version
  );
end;
$$;

revoke all on function public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)
  to service_role;
