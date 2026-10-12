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
-- Companion changes that MUST land in the same window/PR as the migration:
--   * Retarget the prosrc/proconfig postconditions in these existing suites
--     from the public RPC to the preserved private.*_pre_ovd722 body (the
--     public name becomes the thin kill-switch wrapper below):
--       supabase/tests/provider_dispatch_admission_serialization.sql
--         (public.api_request_provider_dispatch)
--       supabase/tests/xometry_beta_dispatch_admission_serialization.sql
--         (public.api_request_xometry_beta_dispatch)
--       supabase/tests/job_service_detail_privileges.sql
--         (:dispatch_signature = public.api_request_xometry_beta_dispatch)
--   * Promote supabase/tests/pending/ovd722_provider_kill_switch.sql.pending.
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
--   PHASE 2 ENFORCE  wraps the existing preflight and enqueue RPCs so the
--                    switch is checked first. Original bodies are preserved
--                    byte-for-byte under private.*_pre_ovd722 names.
--   PHASE 3 CONTRACT nothing is dropped in this window (see notes at the end).
--   ROLLBACK         explicit reversal of PHASE 2 then PHASE 1.
-- =====================================================================

begin;

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
  engaged_at timestamptz
);

create table if not exists private.provider_global_kill_switch (
  singleton boolean primary key default true check (singleton),
  engaged boolean not null default false,
  reason text,
  engaged_by uuid,
  engaged_at timestamptz
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

-- The audit table is append-only for everyone, including the owner.
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
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-kill-switch-state.v1',
    'provider', p_provider,
    'engaged', p_provider is null
      or coalesce((select s.engaged from private.provider_kill_switches s where s.provider = p_provider), true),
    'globalEngaged',
      coalesce((select g.engaged from private.provider_global_kill_switch g where g.singleton), true)
  );
$$;

revoke all on function public.api_worker_provider_kill_switch_state(public.vendor_name)
  from public, anon, authenticated, service_role;
grant execute on function public.api_worker_provider_kill_switch_state(public.vendor_name)
  to service_role;

create or replace function public.api_admin_set_provider_kill_switch(
  p_provider public.vendor_name,
  p_engaged boolean,
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
  v_at timestamptz := pg_catalog.clock_timestamp();
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

  insert into private.provider_kill_switches as s (provider, engaged, reason, engaged_by, engaged_at)
  values (p_provider, p_engaged, v_reason, v_actor, v_at)
  on conflict (provider) do update
    set engaged = excluded.engaged,
        reason = excluded.reason,
        engaged_by = excluded.engaged_by,
        engaged_at = excluded.engaged_at;

  insert into private.provider_kill_switch_audit (at, actor, provider, engaged, reason)
  values (v_at, v_actor, p_provider, p_engaged, v_reason);

  return pg_catalog.jsonb_build_object(
    'provider', p_provider,
    'engaged', p_engaged,
    'reason', v_reason,
    'changedBy', v_actor,
    'changedAt', v_at
  );
end;
$$;

revoke all on function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text)
  to authenticated;

create or replace function public.api_admin_set_global_kill_switch(
  p_engaged boolean,
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
  v_at timestamptz := pg_catalog.clock_timestamp();
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

  insert into private.provider_global_kill_switch as g (singleton, engaged, reason, engaged_by, engaged_at)
  values (true, p_engaged, v_reason, v_actor, v_at)
  on conflict (singleton) do update
    set engaged = excluded.engaged,
        reason = excluded.reason,
        engaged_by = excluded.engaged_by,
        engaged_at = excluded.engaged_at;

  insert into private.provider_kill_switch_audit (at, actor, provider, engaged, reason)
  values (v_at, v_actor, null, p_engaged, v_reason);

  return pg_catalog.jsonb_build_object(
    'provider', null,
    'engaged', p_engaged,
    'reason', v_reason,
    'changedBy', v_actor,
    'changedAt', v_at
  );
end;
$$;

revoke all on function public.api_admin_set_global_kill_switch(boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_set_global_kill_switch(boolean, text)
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
        'changedBy', g.engaged_by, 'changedAt', g.engaged_at)
      from private.provider_global_kill_switch g where g.singleton
    ),
    'providers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'provider', s.provider, 'engaged', s.engaged, 'reason', s.reason,
        'changedBy', s.engaged_by, 'changedAt', s.engaged_at) order by s.provider::text)
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
    returning q.job_id, q.quote_run_id, q.payload ->> 'vendorQuoteResultId' as vendor_quote_result_id
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
    where r.id::text = tasks.vendor_quote_result_id
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
-- PHASE 2 ENFORCE
-- Each existing RPC keeps its exact body under a private *_pre_ovd722 name and
-- a same-signature public wrapper checks the switch FIRST. PL/pgSQL resolves
-- callee names at run time, so internal callers (the generic preflight's
-- Xometry delegation, the generic request's Xometry delegation) reach the
-- wrappers too.
-- =====================================================================

-- 2a. Server preflight: generic providers.
alter function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  rename to api_authorize_provider_worker_dispatch_pre_ovd722;
alter function public.api_authorize_provider_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  set schema private;
revoke all on function private.api_authorize_provider_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;

create function public.api_authorize_provider_worker_dispatch(
  p_work_queue_task_id uuid,
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb,
  p_expected_worker_name text,
  p_expected_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result_vendor text;
begin
  -- Xometry keeps its specialized response shape; its own wrapper checks the switch.
  if p_scope_snapshot ->> 'vendor' = 'xometry' then
    return public.api_authorize_xometry_beta_worker_dispatch(
      p_work_queue_task_id, p_vendor_quote_result_id, p_scope_snapshot,
      p_expected_worker_name, p_expected_claimed_at);
  end if;

  -- OVD-722: kill switch first. Both the claimed snapshot vendor and the
  -- stored result vendor are checked; either engaged denies.
  select r.vendor::text into v_result_vendor
  from public.vendor_quote_results r
  where r.id = p_vendor_quote_result_id;

  if private.provider_kill_switch_engaged_text(p_scope_snapshot ->> 'vendor')
    or (v_result_vendor is not null and private.provider_kill_switch_engaged_text(v_result_vendor)) then
    return private.provider_dispatch_authorization_denial('provider_kill_switch_engaged');
  end if;

  return private.api_authorize_provider_worker_dispatch_pre_ovd722(
    p_work_queue_task_id, p_vendor_quote_result_id, p_scope_snapshot,
    p_expected_worker_name, p_expected_claimed_at);
end;
$$;

revoke all on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  to service_role;

-- 2b. Server preflight: Xometry.
alter function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  rename to api_authorize_xometry_beta_worker_dispatch_pre_ovd722;
alter function public.api_authorize_xometry_beta_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  set schema private;
revoke all on function private.api_authorize_xometry_beta_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;

create function public.api_authorize_xometry_beta_worker_dispatch(
  p_work_queue_task_id uuid,
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb,
  p_expected_worker_name text,
  p_expected_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.provider_kill_switch_engaged('xometry'::public.vendor_name) then
    return pg_catalog.jsonb_build_object(
      'authorized', false,
      'reasonCode', 'provider_kill_switch_engaged');
  end if;

  return private.api_authorize_xometry_beta_worker_dispatch_pre_ovd722(
    p_work_queue_task_id, p_vendor_quote_result_id, p_scope_snapshot,
    p_expected_worker_name, p_expected_claimed_at);
end;
$$;

revoke all on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  to service_role;

-- 2c. Enqueue: generic dispatch requests.
alter function public.api_request_provider_dispatch(
  uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
  rename to api_request_provider_dispatch_pre_ovd722;
alter function public.api_request_provider_dispatch_pre_ovd722(
  uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
  set schema private;
revoke all on function private.api_request_provider_dispatch_pre_ovd722(
  uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;

create function public.api_request_provider_dispatch(
  p_job_id uuid,
  p_provider public.vendor_name,
  p_declared_model_units text,
  p_expected_scope_fingerprint text,
  p_notice_revision text,
  p_expected_envelope_revision text,
  p_approval_reference uuid,
  p_authority_to_share boolean,
  p_non_export_controlled boolean,
  p_quote_only boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.provider_kill_switch_engaged(p_provider) then
    raise exception 'provider_kill_switch_engaged' using errcode = 'P0001';
  end if;

  return private.api_request_provider_dispatch_pre_ovd722(
    p_job_id, p_provider, p_declared_model_units, p_expected_scope_fingerprint,
    p_notice_revision, p_expected_envelope_revision, p_approval_reference,
    p_authority_to_share, p_non_export_controlled, p_quote_only);
end;
$$;

revoke all on function public.api_request_provider_dispatch(
  uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.api_request_provider_dispatch(
  uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
  to authenticated;

-- 2d. Enqueue: Xometry dispatch requests.
alter function public.api_request_xometry_beta_dispatch(
  uuid, text, text, text, uuid, boolean, boolean, boolean)
  rename to api_request_xometry_beta_dispatch_pre_ovd722;
alter function public.api_request_xometry_beta_dispatch_pre_ovd722(
  uuid, text, text, text, uuid, boolean, boolean, boolean)
  set schema private;
revoke all on function private.api_request_xometry_beta_dispatch_pre_ovd722(
  uuid, text, text, text, uuid, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;

create function public.api_request_xometry_beta_dispatch(
  p_job_id uuid,
  p_declared_model_units text,
  p_expected_scope_fingerprint text,
  p_policy_revision text,
  p_approval_reference uuid,
  p_authority_to_share boolean,
  p_non_export_controlled boolean,
  p_quote_only boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.provider_kill_switch_engaged('xometry'::public.vendor_name) then
    raise exception 'provider_kill_switch_engaged' using errcode = 'P0001';
  end if;

  return private.api_request_xometry_beta_dispatch_pre_ovd722(
    p_job_id, p_declared_model_units, p_expected_scope_fingerprint,
    p_policy_revision, p_approval_reference, p_authority_to_share,
    p_non_export_controlled, p_quote_only);
end;
$$;

revoke all on function public.api_request_xometry_beta_dispatch(
  uuid, text, text, text, uuid, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.api_request_xometry_beta_dispatch(
  uuid, text, text, text, uuid, boolean, boolean, boolean)
  to authenticated;

-- =====================================================================
-- PHASE 3 CONTRACT
-- Nothing is dropped in this window. The private *_pre_ovd722 functions are
-- the live implementation behind the wrappers. The contract step is a later,
-- separately reviewed migration that, the next time one of those bodies is
-- rewritten anyway, folds the kill-switch check into the body and drops the
-- matching wrapper/inner pair.
-- =====================================================================

commit;

-- =====================================================================
-- ROLLBACK (run as one transaction, only in a Blaine-approved window)
-- Reverses PHASE 2 first (restores the original RPCs under their public names
-- with their original grants), then PHASE 1. Audit rows are evidence: export
-- private.provider_kill_switch_audit before running the final drop, or leave
-- that one statement out to keep the table.
-- =====================================================================
-- begin;
--
-- drop function public.api_request_xometry_beta_dispatch(uuid, text, text, text, uuid, boolean, boolean, boolean);
-- alter function private.api_request_xometry_beta_dispatch_pre_ovd722(uuid, text, text, text, uuid, boolean, boolean, boolean)
--   set schema public;
-- alter function public.api_request_xometry_beta_dispatch_pre_ovd722(uuid, text, text, text, uuid, boolean, boolean, boolean)
--   rename to api_request_xometry_beta_dispatch;
-- revoke all on function public.api_request_xometry_beta_dispatch(uuid, text, text, text, uuid, boolean, boolean, boolean)
--   from public, anon, authenticated, service_role;
-- grant execute on function public.api_request_xometry_beta_dispatch(uuid, text, text, text, uuid, boolean, boolean, boolean)
--   to authenticated;
--
-- drop function public.api_request_provider_dispatch(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean);
-- alter function private.api_request_provider_dispatch_pre_ovd722(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
--   set schema public;
-- alter function public.api_request_provider_dispatch_pre_ovd722(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
--   rename to api_request_provider_dispatch;
-- revoke all on function public.api_request_provider_dispatch(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
--   from public, anon, authenticated, service_role;
-- grant execute on function public.api_request_provider_dispatch(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)
--   to authenticated;
--
-- drop function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz);
-- alter function private.api_authorize_xometry_beta_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
--   set schema public;
-- alter function public.api_authorize_xometry_beta_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
--   rename to api_authorize_xometry_beta_worker_dispatch;
-- revoke all on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
--   from public, anon, authenticated, service_role;
-- grant execute on function public.api_authorize_xometry_beta_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
--   to service_role;
--
-- drop function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz);
-- alter function private.api_authorize_provider_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
--   set schema public;
-- alter function public.api_authorize_provider_worker_dispatch_pre_ovd722(uuid, uuid, jsonb, text, timestamptz)
--   rename to api_authorize_provider_worker_dispatch;
-- revoke all on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
--   from public, anon, authenticated, service_role;
-- grant execute on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
--   to service_role;
--
-- drop function public.api_worker_cancel_provider_disabled_tasks();
-- drop function public.api_admin_list_provider_kill_switches();
-- drop function public.api_admin_set_global_kill_switch(boolean, text);
-- drop function public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text);
-- drop function public.api_worker_provider_kill_switch_state(public.vendor_name);
-- drop function private.provider_kill_switch_engaged_text(text);
-- drop function private.provider_kill_switch_engaged(public.vendor_name);
-- drop table private.provider_global_kill_switch;
-- drop table private.provider_kill_switches;
-- -- Evidence: export first, or omit the next three statements to keep the audit trail.
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
