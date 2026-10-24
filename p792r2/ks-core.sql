create table if not exists private.provider_kill_switches (
  provider public.vendor_name primary key,
  engaged boolean not null default false,
  reason text,
  -- Actor and time of the most recent flip (on or off). The full history is
  -- private.provider_kill_switch_audit.
  engaged_by uuid,
  engaged_at timestamptz,
  -- Bumped on every flip. A release must name the version it was decided on
  -- (compare and set); an engage never needs one, so an emergency stop always wins.
  version bigint not null default 0 check (version >= 0)
);

create table if not exists private.provider_global_kill_switch (
  singleton boolean primary key default true check (singleton),
  engaged boolean not null default false,
  reason text,
  engaged_by uuid,
  engaged_at timestamptz,
  version bigint not null default 0 check (version >= 0)
);

create table if not exists private.provider_kill_switch_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default pg_catalog.clock_timestamp(),
  actor uuid not null,
  -- null means the global switch.
  provider public.vendor_name,
  engaged boolean not null,
  reason text not null check (pg_catalog.char_length(pg_catalog.btrim(reason)) >= 10)
);

create index if not exists provider_kill_switch_audit_provider_at_idx
  on private.provider_kill_switch_audit (provider, at desc);

revoke all on table private.provider_kill_switches from public, anon, authenticated, service_role;
revoke all on table private.provider_global_kill_switch from public, anon, authenticated, service_role;
revoke all on table private.provider_kill_switch_audit from public, anon, authenticated, service_role;

-- Defense in depth: nothing reads these tables directly. Every caller goes
-- through the security definer RPCs below, owned by the migration role
-- (BYPASSRLS), matching private.provider_dispatch_permits. No policies exist,
-- so any other role sees no rows even if a grant is added by mistake.
alter table private.provider_kill_switches enable row level security;
alter table private.provider_kill_switches force row level security;
alter table private.provider_global_kill_switch enable row level security;
alter table private.provider_global_kill_switch force row level security;
alter table private.provider_kill_switch_audit enable row level security;
alter table private.provider_kill_switch_audit force row level security;

-- The audit table is append-only through every granted path: no role but the
-- owner holds any privilege on it, and these triggers reject UPDATE, DELETE
-- and TRUNCATE. This is not tamper proof against the table owner or a
-- superuser, who can disable triggers or drop the table; the guarantee is
-- that no application role, admin RPC, or worker can rewrite history.
create or replace function private.provider_kill_switch_audit_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'provider_kill_switch_audit is append-only'
    using errcode = '42501';
end;
$$;

revoke all on function private.provider_kill_switch_audit_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists provider_kill_switch_audit_no_update_delete
  on private.provider_kill_switch_audit;
create trigger provider_kill_switch_audit_no_update_delete
  before update or delete on private.provider_kill_switch_audit
  for each row execute function private.provider_kill_switch_audit_immutable();

drop trigger if exists provider_kill_switch_audit_no_truncate
  on private.provider_kill_switch_audit;
create trigger provider_kill_switch_audit_no_truncate
  before truncate on private.provider_kill_switch_audit
  for each statement execute function private.provider_kill_switch_audit_immutable();

-- Seed: every current provider and the global singleton start disengaged.
insert into private.provider_kill_switches (provider, engaged)
select provider, false
from pg_catalog.unnest(pg_catalog.enum_range(null::public.vendor_name)) as provider
on conflict (provider) do nothing;

insert into private.provider_global_kill_switch (singleton, engaged)
values (true, false)
on conflict (singleton) do nothing;

-- Single source of truth for "is this provider switched off". Fail-closed on
-- null input, a missing provider row, or a missing global row.
create or replace function private.provider_kill_switch_engaged(p_provider public.vendor_name)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_provider is null
    or coalesce((select g.engaged from private.provider_global_kill_switch g where g.singleton), true)
    or coalesce((select s.engaged from private.provider_kill_switches s where s.provider = p_provider), true);
$$;

revoke all on function private.provider_kill_switch_engaged(public.vendor_name)
  from public, anon, authenticated, service_role;

-- Text variant for jsonb payload values; an unknown provider string is engaged.
create or replace function private.provider_kill_switch_engaged_text(p_provider text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_provider is null
      or not (p_provider = any (pg_catalog.enum_range(null::public.vendor_name)::text[]))
      then true
    else private.provider_kill_switch_engaged(p_provider::public.vendor_name)
  end;
$$;

revoke all on function private.provider_kill_switch_engaged_text(text)
  from public, anon, authenticated, service_role;

-- Worker checkpoint read: one indexed row plus the singleton. Service role only.
create or replace function public.api_worker_provider_kill_switch_state(p_provider public.vendor_name)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- The global row is read before the provider row: the same table order as
  -- the rollback guard's lock, so the two can never deadlock.
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-kill-switch-state.v1',
    'provider', p_provider,
    'globalEngaged',
      coalesce((select g.engaged from private.provider_global_kill_switch g where g.singleton), true),
    'engaged', p_provider is null
      or coalesce((select s.engaged from private.provider_kill_switches s where s.provider = p_provider), true)
  );
$$;

revoke all on function public.api_worker_provider_kill_switch_state(public.vendor_name)
  from public, anon, authenticated, service_role;
grant execute on function public.api_worker_provider_kill_switch_state(public.vendor_name)
  to service_role;

-- Release is compare and set: p_expected_version must equal the row's current
-- version, so a release decided on a stale view (for example admin A's delayed
-- request arriving after admin B engaged) fails with kill_switch_version_conflict
-- instead of clearing the newer engagement. Engage ignores p_expected_version.
create or replace function public.api_admin_list_provider_kill_switches()
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
        'changedBy', s.engaged_by, 'changedAt', s.engaged_at, 'version', s.version) order by s.provider::text)
      from private.provider_kill_switches s
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.api_admin_list_provider_kill_switches()
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_list_provider_kill_switches()
  to authenticated;

-- Periodic sweep: queued run_vendor_quote tasks for a switched-off provider end
-- truthfully as cancelled_provider_disabled instead of staying parked. Rows a
-- worker already holds are skipped; the worker's own checkpoints stop those.
-- Rows are handled one at a time, each in its own subtransaction: an exception
-- raised while a row is updated (for example private.fence_free_quote_result
-- raising free_quote_terminal_fenced for a canceled free beta request, or a
-- task whose lane cannot be settled) rolls back only that row, which stays
-- queued and is counted as skipped; the worker's claim check settles it later.
-- This covers immediate triggers only. A deferred constraint trigger such as
-- settle_terminal_free_quote_result fires at commit, after this function has
-- returned, so an exception there still aborts the caller's whole
-- transaction and the sweep's other rows with it.
--
-- A task is only cancelled together with its lane. A task whose payload has
-- no usable vendorQuoteResultId, or whose lane is no longer queued, raises
-- inside its subtransaction and is skipped, so a cancelled task never leaves
-- its lane queued with nothing left to run it.
