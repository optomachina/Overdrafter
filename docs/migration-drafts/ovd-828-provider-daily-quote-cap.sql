-- OVD-828: per-supplier daily quote cap as an admin setting next to the OVD-722
-- provider kill switch.
--
-- DRAFT. NOT APPLIED. NEEDS A BLAINE-APPROVED MIGRATION WINDOW. Do not copy
-- into supabase/migrations/ or run against any database before that window.
-- Rollback: docs/migration-drafts/ovd-828-provider-daily-quote-cap.rollback.sql.
-- Notes: docs/migration-drafts/ovd-828-notes.md.
--
-- Purely additive. No existing table column, function, signature, body or
-- grant changes; in particular api_worker_provider_kill_switch_state keeps its
-- exact four-key v1 payload, because deployed workers parse it strictly and
-- would fail closed on every provider if a key were added. The cap is read
-- through its own worker RPC instead.
--
-- Semantics of the setting on private.provider_kill_switches:
--   daily_quote_cap null, daily_quote_cap_unlimited false  -> unset: the worker
--     uses its env fallback (WORKER_OSHCUT_DAILY_QUOTE_CAP, default 20).
--   daily_quote_cap N (N >= 1), unlimited false            -> N quotes per UTC day.
--   daily_quote_cap null, daily_quote_cap_unlimited true   -> no cap.
-- There is no upper bound. A missing provider row reads as unset. Setting a
-- cap for a provider with no row materializes the row engaged (the same fail
-- closed default as api_admin_set_provider_kill_switch); a cap never releases
-- the switch, and it never bumps the switch's compare and set version.
--
-- Every statement is if not exists / create or replace / revoke / grant, so
-- re-running the whole file is a no-op.

-- ---------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------
alter table private.provider_kill_switches
  add column if not exists daily_quote_cap integer,
  add column if not exists daily_quote_cap_unlimited boolean not null default false,
  add column if not exists daily_quote_cap_changed_by uuid,
  add column if not exists daily_quote_cap_changed_at timestamptz;

do $constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'provider_kill_switches_daily_quote_cap_check'
      and conrelid = 'private.provider_kill_switches'::regclass
  ) then
    alter table private.provider_kill_switches
      add constraint provider_kill_switches_daily_quote_cap_check
      check (
        (daily_quote_cap is null or daily_quote_cap >= 1)
        and (not daily_quote_cap_unlimited or daily_quote_cap is null)
      );
  end if;
end;
$constraints$;

-- Separate from private.provider_kill_switch_audit, whose engaged column is
-- not null and whose shape the OVD-771 draft changes. Same append-only rules.
create table if not exists private.provider_daily_quote_cap_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default pg_catalog.clock_timestamp(),
  actor uuid not null,
  provider public.vendor_name not null,
  previous_daily_quote_cap integer,
  previous_unlimited boolean not null,
  daily_quote_cap integer check (daily_quote_cap is null or daily_quote_cap >= 1),
  unlimited boolean not null,
  reason text not null check (pg_catalog.char_length(pg_catalog.btrim(reason)) >= 10),
  check (not unlimited or daily_quote_cap is null)
);

create index if not exists provider_daily_quote_cap_audit_provider_at_idx
  on private.provider_daily_quote_cap_audit (provider, at desc);

revoke all on table private.provider_daily_quote_cap_audit from public, anon, authenticated, service_role;
alter table private.provider_daily_quote_cap_audit enable row level security;
alter table private.provider_daily_quote_cap_audit force row level security;

create or replace function private.provider_daily_quote_cap_audit_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'provider_daily_quote_cap_audit is append-only'
    using errcode = '42501';
end;
$$;

revoke all on function private.provider_daily_quote_cap_audit_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists provider_daily_quote_cap_audit_no_update_delete
  on private.provider_daily_quote_cap_audit;
create trigger provider_daily_quote_cap_audit_no_update_delete
  before update or delete on private.provider_daily_quote_cap_audit
  for each row execute function private.provider_daily_quote_cap_audit_immutable();

drop trigger if exists provider_daily_quote_cap_audit_no_truncate
  on private.provider_daily_quote_cap_audit;
create trigger provider_daily_quote_cap_audit_no_truncate
  before truncate on private.provider_daily_quote_cap_audit
  for each statement execute function private.provider_daily_quote_cap_audit_immutable();

-- ---------------------------------------------------------------------
-- Worker read: called once per dispatch, never cached. Service role only.
-- The worker parses exactly these four keys (worker/src/providerDailyQuoteCap.ts).
-- ---------------------------------------------------------------------
create or replace function public.api_worker_provider_daily_quote_cap(p_provider public.vendor_name)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-daily-quote-cap.v1',
    'provider', p_provider,
    'dailyQuoteCap', (select s.daily_quote_cap from private.provider_kill_switches s where s.provider = p_provider),
    'unlimited', coalesce(
      (select s.daily_quote_cap_unlimited from private.provider_kill_switches s where s.provider = p_provider),
      false)
  );
$$;

revoke all on function public.api_worker_provider_daily_quote_cap(public.vendor_name)
  from public, anon, authenticated, service_role;
grant execute on function public.api_worker_provider_daily_quote_cap(public.vendor_name)
  to service_role;

-- ---------------------------------------------------------------------
-- Admin write: verified auth + platform admin + AAL2 (the OVD-766 group a
-- pattern), reason of at least 10 characters, one audit row per change.
-- p_unlimited true needs p_daily_quote_cap null. p_unlimited false with
-- p_daily_quote_cap null resets the provider to the worker's env default.
-- Last write wins; every write is in the audit table with the value it replaced.
-- ---------------------------------------------------------------------
create or replace function public.api_admin_set_provider_daily_quote_cap(
  p_provider public.vendor_name,
  p_daily_quote_cap integer,
  p_unlimited boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_reason text;
  v_at timestamptz;
  v_previous_cap integer;
  v_previous_unlimited boolean;
begin
  perform public.require_verified_auth();

  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  if not public.current_user_has_aal2() then
    raise exception 'Multi-factor authentication is required for provider daily quote cap administration.';
  end if;

  v_actor := auth.uid();
  v_reason := pg_catalog.btrim(p_reason);
  if v_actor is null then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  if p_provider is null then
    raise exception 'provider_required' using errcode = '22023';
  end if;
  if p_unlimited is null then
    raise exception 'unlimited_required' using errcode = '22023';
  end if;
  if p_unlimited and p_daily_quote_cap is not null then
    raise exception 'unlimited_cap_must_be_null' using errcode = '22023';
  end if;
  if p_daily_quote_cap is not null and p_daily_quote_cap < 1 then
    raise exception 'daily_quote_cap_must_be_positive' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;

  -- A missing row reads as engaged (fail closed); materialize it that way so a
  -- cap change can never release the switch.
  insert into private.provider_kill_switches (provider, engaged)
  values (p_provider, true)
  on conflict (provider) do nothing;

  select s.daily_quote_cap, s.daily_quote_cap_unlimited
    into strict v_previous_cap, v_previous_unlimited
  from private.provider_kill_switches s
  where s.provider = p_provider
  for update;

  v_at := pg_catalog.clock_timestamp();

  update private.provider_kill_switches s
  set daily_quote_cap = p_daily_quote_cap,
      daily_quote_cap_unlimited = p_unlimited,
      daily_quote_cap_changed_by = v_actor,
      daily_quote_cap_changed_at = v_at
  where s.provider = p_provider;

  insert into private.provider_daily_quote_cap_audit (
    at, actor, provider, previous_daily_quote_cap, previous_unlimited, daily_quote_cap, unlimited, reason)
  values (v_at, v_actor, p_provider, v_previous_cap, v_previous_unlimited, p_daily_quote_cap, p_unlimited, v_reason);

  return pg_catalog.jsonb_build_object(
    'provider', p_provider,
    'dailyQuoteCap', p_daily_quote_cap,
    'unlimited', p_unlimited,
    'reason', v_reason,
    'changedBy', v_actor,
    'changedAt', v_at
  );
end;
$$;

revoke all on function public.api_admin_set_provider_daily_quote_cap(public.vendor_name, integer, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_set_provider_daily_quote_cap(public.vendor_name, integer, boolean, text)
  to authenticated;

-- ---------------------------------------------------------------------
-- Admin read: every provider row's cap setting. Same gate as
-- api_admin_list_provider_kill_switches.
-- ---------------------------------------------------------------------
create or replace function public.api_admin_list_provider_daily_quote_caps()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'schema', 'provider-daily-quote-cap-admin.v1',
    'providers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'provider', s.provider,
        'dailyQuoteCap', s.daily_quote_cap,
        'unlimited', s.daily_quote_cap_unlimited,
        'changedBy', s.daily_quote_cap_changed_by,
        'changedAt', s.daily_quote_cap_changed_at) order by s.provider::text)
      from private.provider_kill_switches s
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.api_admin_list_provider_daily_quote_caps()
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_list_provider_daily_quote_caps()
  to authenticated;
