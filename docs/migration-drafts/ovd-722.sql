-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-722: per-provider and global provider kill switch.
--
-- This is a DRAFT. It must not be copied into supabase/migrations/ or applied
-- to any database outside a Blaine-approved migration window. When approved,
-- it ships as ONE migration (next timestamp from `npm run migration:new`), and
-- supabase/tests/pending/ovd722_provider_kill_switch.sql.pending is renamed to
-- supabase/tests/ovd722_provider_kill_switch.sql in the same change.
--
-- Transaction: this file has no begin/commit of its own. The migration
-- runner wraps it in one transaction (the Supabase CLI does). By hand:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f <file>
--
-- Companion change in the same window/PR as the migration: promote
-- supabase/tests/pending/ovd722_provider_kill_switch.sql.pending. No existing
-- suite needs retargeting: no existing function is renamed, wrapped or
-- replaced, so every existing prosrc/proconfig pin holds.
--
-- Deploy ordering: apply this migration BEFORE (or together with) the worker
-- build containing OVD-722. That worker fails closed: without
-- api_worker_provider_kill_switch_state every live dispatch is refused with
-- provider_kill_switch_unavailable (retried, then manual follow-up).
--
-- Purpose: stop all automated traffic to one provider (or to every provider)
-- with a data flip. No deploy, no worker restart, no caching: every server
-- preflight and every worker checkpoint reads the current row.
--
-- The switch is deliberately separate from
-- private.quote_provider_admission_policies revisions and
-- private.provider_dispatch_envelope_reviews.withdrawn_at. Admission changes
-- are reviewed and slow; the switch is an emergency brake that only ever
-- denies. Withdrawing an envelope stays the durable follow-up.
--
-- Fail-closed rules:
--   * A provider with no kill-switch row is treated as ENGAGED.
--   * A missing global singleton row is treated as ENGAGED.
--   * The worker treats an RPC error, malformed response, or a read slower than
--     2s as ENGAGED for the purpose of refusing (worker/src/providerKillSwitch.ts).
--
-- Layout (expand -> enforce -> contract):
--   PHASE 1 EXPAND   additive objects only; no existing behavior changes.
--   PHASE 2 ENFORCE  adds a BEFORE INSERT trigger on both permit tables
--                    that refuses enqueue for a switched-off provider. This
--                    is still expand only: it adds objects and alters no
--                    existing function, signature, body or grant. While every
--                    switch is disengaged (the seed) nothing behaves
--                    differently.
--   PHASE 3 CONTRACT not in this window (see the end of the file).
--   ROLLBACK         guarded reversal of PHASE 2 then PHASE 1.
-- =====================================================================

-- =====================================================================
-- PHASE 1 EXPAND
-- =====================================================================

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
  v_at timestamptz;
  v_current_version bigint;
  v_version bigint;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
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

  -- A missing row reads as engaged (fail closed). Materialize it that way so
  -- there is always a row to lock; a concurrent flip cannot slip in unlocked.
  insert into private.provider_kill_switches (provider, engaged)
  values (p_provider, true)
  on conflict (provider) do nothing;

  -- Take the row lock first; the version check and timestamp are read after it.
  select s.version into strict v_current_version
  from private.provider_kill_switches s
  where s.provider = p_provider
  for update;

  if not p_engaged
    and (p_expected_version is null or p_expected_version <> v_current_version) then
    raise exception 'kill_switch_version_conflict'
      using errcode = 'P0001',
            detail = pg_catalog.format('expected version %s, current version %s',
              coalesce(p_expected_version::text, 'none'), v_current_version);
  end if;

  -- Captured after the lock wait so the recorded time orders with the commit.
  v_at := pg_catalog.clock_timestamp();

  update private.provider_kill_switches s
  set engaged = p_engaged,
      reason = v_reason,
      engaged_by = v_actor,
      engaged_at = v_at,
      version = s.version + 1
  where s.provider = p_provider
  returning s.version into strict v_version;

  insert into private.provider_kill_switch_audit (at, actor, provider, engaged, reason)
  values (v_at, v_actor, p_provider, p_engaged, v_reason);

  return pg_catalog.jsonb_build_object(
    'provider', p_provider,
    'engaged', p_engaged,
    'reason', v_reason,
    'changedBy', v_actor,
    'changedAt', v_at,
    'version', v_version
  );
end;
$$;

revoke all on function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)
  to authenticated;

-- Same compare and set rule as the per-provider switch.
create or replace function public.api_admin_set_global_kill_switch(
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
  v_at timestamptz;
  v_current_version bigint;
  v_version bigint;
begin
  if not coalesce(public.is_platform_admin(), false) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  v_actor := auth.uid();
  v_reason := pg_catalog.btrim(p_reason);
  if v_actor is null then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  if p_engaged is null then
    raise exception 'engaged_required' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.char_length(v_reason) < 10 then
    raise exception 'reason_required_min_10_chars' using errcode = '22023';
  end if;

  insert into private.provider_global_kill_switch (singleton, engaged)
  values (true, true)
  on conflict (singleton) do nothing;

  select g.version into strict v_current_version
  from private.provider_global_kill_switch g
  where g.singleton
  for update;

  if not p_engaged
    and (p_expected_version is null or p_expected_version <> v_current_version) then
    raise exception 'kill_switch_version_conflict'
      using errcode = 'P0001',
            detail = pg_catalog.format('expected version %s, current version %s',
              coalesce(p_expected_version::text, 'none'), v_current_version);
  end if;

  v_at := pg_catalog.clock_timestamp();

  update private.provider_global_kill_switch g
  set engaged = p_engaged,
      reason = v_reason,
      engaged_by = v_actor,
      engaged_at = v_at,
      version = g.version + 1
  where g.singleton
  returning g.version into strict v_version;

  insert into private.provider_kill_switch_audit (at, actor, provider, engaged, reason)
  values (v_at, v_actor, null, p_engaged, v_reason);

  return pg_catalog.jsonb_build_object(
    'provider', null,
    'engaged', p_engaged,
    'reason', v_reason,
    'changedBy', v_actor,
    'changedAt', v_at,
    'version', v_version
  );
end;
$$;

revoke all on function public.api_admin_set_global_kill_switch(boolean, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_set_global_kill_switch(boolean, text, bigint)
  to authenticated;

-- Admin page / CLI read: every provider's state, last reason, actor, time.
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
create or replace function public.api_worker_cancel_provider_disabled_tasks()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cancelled jsonb;
begin
  with doomed as (
    select q.id
    from public.work_queue q
    where q.status = 'queued'
      and q.task_type = 'run_vendor_quote'
      -- A task with no vendor is not the switch's to cancel; the handler fails it.
      and q.payload ? 'vendor'
      and private.provider_kill_switch_engaged_text(q.payload ->> 'vendor')
    for update skip locked
  ),
  tasks as (
    update public.work_queue q
    set status = 'cancelled',
        locked_at = null,
        locked_by = null,
        last_error = 'cancelled_provider_disabled: provider kill switch engaged (sweep).',
        payload = q.payload || pg_catalog.jsonb_build_object(
          'cancellationReason', 'cancelled_provider_disabled',
          'killSwitchCheckpoint', 'sweep')
    from doomed
    where q.id = doomed.id
    returning q.job_id, q.quote_run_id,
      case when q.payload ->> 'vendorQuoteResultId'
             ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (q.payload ->> 'vendorQuoteResultId')::uuid end as vendor_quote_result_id
  ),
  results as (
    update public.vendor_quote_results r
    set status = 'failed',
        notes = '["Provider temporarily unavailable."]'::jsonb,
        raw_payload = pg_catalog.jsonb_build_object(
          'failureCode', 'cancelled_provider_disabled',
          'killSwitchReasonCode', 'provider_kill_switch_engaged',
          'killSwitchCheckpoint', 'sweep',
          'providerMutationPossible', false,
          'retryScheduledFor', null)
    from tasks
    where r.id = tasks.vendor_quote_result_id
      and r.status = 'queued'
    returning r.id
  )
  select pg_catalog.jsonb_build_object(
    'cancelled', (select pg_catalog.count(*) from tasks),
    'quoteRuns', coalesce((
      select pg_catalog.jsonb_agg(distinct pg_catalog.jsonb_build_object(
        'jobId', t.job_id, 'quoteRunId', t.quote_run_id))
      from tasks t where t.job_id is not null and t.quote_run_id is not null
    ), '[]'::jsonb),
    'resultsUpdated', (select pg_catalog.count(*) from results)
  ) into v_cancelled;

  return v_cancelled;
end;
$$;

revoke all on function public.api_worker_cancel_provider_disabled_tasks()
  from public, anon, authenticated, service_role;
grant execute on function public.api_worker_cancel_provider_disabled_tasks()
  to service_role;

-- =====================================================================
-- PHASE 2 ENFORCE (expand only)
-- No existing function is renamed, wrapped or replaced. The two worker
-- preflights (api_authorize_provider_worker_dispatch,
-- api_authorize_xometry_beta_worker_dispatch) and the two request RPCs keep
-- their bodies, signatures and grants. The switch is enforced by:
--   * the OVD-722 worker, which reads api_worker_provider_kill_switch_state
--     at claim, before launch, and before every navigation, upload,
--     configuration and save, and fails closed when it cannot;
--   * the permit insert trigger below, which refuses enqueue;
--   * the sweep above, which cancels queued tasks.
-- A worker build without OVD-722 does not read the switch, so apply this
-- migration and deploy the OVD-722 worker in the same window. Folding the
-- check into the preflight bodies is a contract step for a later window.
-- =====================================================================

-- 2c. Enqueue: refuse a new permit for a switched-off provider. Both request
-- RPCs insert exactly one permit row for every new dispatch, inside their own
-- transaction and with no exception handler, so raising here rolls back the
-- lane and queue task they created in the same call. An idempotent replay of
-- an existing permit inserts nothing and is not refused here; the worker claim
-- check and the 2a/2b preflights still stop that dispatch.
create or replace function private.provider_kill_switch_permit_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Both permit tables carry provider (the Xometry table defaults and checks
  -- it to 'xometry'); defaults are applied before BEFORE triggers fire.
  if private.provider_kill_switch_engaged(new.provider) then
    raise exception 'provider_kill_switch_engaged' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function private.provider_kill_switch_permit_guard()
  from public, anon, authenticated, service_role;

-- Named to sort before the existing BEFORE INSERT triggers on these tables,
-- so the switch refuses first.
drop trigger if exists provider_kill_switch_permit_guard on private.provider_dispatch_permits;
create trigger provider_kill_switch_permit_guard
  before insert on private.provider_dispatch_permits
  for each row execute function private.provider_kill_switch_permit_guard();

drop trigger if exists provider_kill_switch_permit_guard on private.xometry_beta_dispatch_permits;
create trigger provider_kill_switch_permit_guard
  before insert on private.xometry_beta_dispatch_permits
  for each row execute function private.provider_kill_switch_permit_guard();

-- =====================================================================
-- PHASE 3 CONTRACT (later window, separately reviewed)
-- The next time a preflight body is rewritten anyway, fold the switch check
-- into it so a worker that skips its own checkpoints is still denied. That is
-- an in-place body change and needs its own window and exception.
-- =====================================================================

-- =====================================================================
-- ROLLBACK (run as one transaction, only in a Blaine-approved window)
-- Reverses PHASE 2 first (drops the permit triggers), then PHASE 1. No
-- existing function was changed, so nothing is restored. Audit rows are evidence: export private.provider_kill_switch_audit
-- before running the final drop, or leave those statements out to keep it.
--
-- The guard at the top refuses, before anything is dropped, when:
--   * the running role cannot bypass RLS (the switch tables force RLS with no
--     policies, so such a role would see no engagement and pass the check);
--   * any provider or the global switch is engaged. Rolling back would stop
--     the server side refusal and, on a later re-apply, re-seed every switch
--     as disengaged, silently lifting an emergency stop. Record the
--     engagements out of band first, or set in the same transaction:
--       set local ovd722.rollback_discard_engagements = 'confirmed';
--   * any function outside this migration references the switch (a later
--     migration depends on it). Roll that migration back first.
-- The guard takes ACCESS EXCLUSIVE on both switch tables (global first, the
-- table order every switch reader uses) before it checks, so no flip can be
-- committed between the check and the drops.
-- =====================================================================
-- begin;
--
-- do $$
-- declare
--   v_dependents text;
-- begin
--   if pg_catalog.to_regclass('private.provider_kill_switches') is not null then
--     if not exists (select 1 from pg_catalog.pg_roles r
--                    where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
--       raise exception 'OVD-722 rollback refused: the running role must bypass RLS to see engagements'
--         using errcode = 'P0001';
--     end if;
--     lock table private.provider_global_kill_switch, private.provider_kill_switches in access exclusive mode;
--     if coalesce(pg_catalog.current_setting('ovd722.rollback_discard_engagements', true), '') <> 'confirmed'
--        and (exists (select 1 from private.provider_global_kill_switch where engaged)
--             or exists (select 1 from private.provider_kill_switches where engaged)) then
--       raise exception 'OVD-722 rollback refused: a provider kill switch is engaged'
--         using errcode = 'P0001',
--               hint = 'Record the engagements, or set local ovd722.rollback_discard_engagements = ''confirmed''.';
--     end if;
--   end if;
--   select pg_catalog.string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname)
--   into v_dependents
--   from pg_catalog.pg_proc p
--   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--   where (p.prosrc like '%provider\_kill\_switch%' or p.prosrc like '%provider\_global\_kill\_switch%')
--     and (n.nspname, p.proname) not in (
--       ('private', 'provider_kill_switch_engaged'), ('private', 'provider_kill_switch_engaged_text'),
--       ('private', 'provider_kill_switch_audit_immutable'), ('private', 'provider_kill_switch_permit_guard'),
--       ('public', 'api_worker_provider_kill_switch_state'), ('public', 'api_admin_set_provider_kill_switch'),
--       ('public', 'api_admin_set_global_kill_switch'), ('public', 'api_admin_list_provider_kill_switches'),
--       ('public', 'api_worker_cancel_provider_disabled_tasks'));
--   if v_dependents is not null then
--     raise exception 'OVD-722 rollback refused: other functions depend on the kill switch (%); roll that migration back first', v_dependents
--       using errcode = 'P0001';
--   end if;
-- end
-- $$;
--
-- drop trigger provider_kill_switch_permit_guard on private.xometry_beta_dispatch_permits;
-- drop trigger provider_kill_switch_permit_guard on private.provider_dispatch_permits;
-- drop function private.provider_kill_switch_permit_guard();
--
-- drop function public.api_worker_cancel_provider_disabled_tasks();
-- drop function public.api_admin_list_provider_kill_switches();
-- drop function public.api_admin_set_global_kill_switch(boolean, text, bigint);
-- drop function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint);
-- drop function public.api_worker_provider_kill_switch_state(public.vendor_name);
-- drop function private.provider_kill_switch_engaged_text(text);
-- drop function private.provider_kill_switch_engaged(public.vendor_name);
-- drop table private.provider_global_kill_switch;
-- drop table private.provider_kill_switches;
-- -- Evidence: export first, or omit the next four statements to keep the audit trail.
-- drop trigger provider_kill_switch_audit_no_truncate on private.provider_kill_switch_audit;
-- drop trigger provider_kill_switch_audit_no_update_delete on private.provider_kill_switch_audit;
-- drop table private.provider_kill_switch_audit;
-- drop function private.provider_kill_switch_audit_immutable();
--
-- commit;
--
-- Worker compatibility on rollback: the worker reads
-- api_worker_provider_kill_switch_state on every live checkpoint and refuses
-- when it is missing (fail-closed). Roll the worker back to a build without
-- OVD-722 BEFORE running this rollback, or every live dispatch will refuse.
