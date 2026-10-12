-- OVD-734 durable provider dispatch permit consumption: PROPOSED migration draft.
--
-- NOT APPLIED. This file is intentionally outside supabase/migrations/ and needs
-- a Blaine-approved migration window (blaine-window label). When it is promoted,
-- copy it byte-for-byte into
-- supabase/migrations/<npm run migration:next>_ovd734_provider_dispatch_permit_consumption.sql.
-- supabase/tests/fixtures/ovd734_provider_dispatch_permit_consumption.inc is a
-- byte copy of this file, enforced by scripts/run-supabase-policy-tests.node-test.mjs.
--
-- Transaction: this file has no begin/commit of its own. It relies on the
-- migration runner wrapping it in one transaction (the Supabase CLI does). If
-- run by hand, use `psql --single-transaction -v ON_ERROR_STOP=1 -f ovd-734.sql`.
--
-- ===========================================================================
-- DEPLOY ORDER (all three steps, in this order)
--   1. docs/migration-drafts/ovd-722.sql (OVD-722 kill switch). This draft reads
--      private.provider_kill_switches and private.provider_global_kill_switch by
--      those exact names. Applied without them, every consume is DENIED with
--      provider_kill_switch_engaged (fail closed), never granted.
--   2. This draft.
--   3. The worker build containing OVD-734. That worker calls the consume RPC
--      before every generic (non-Xometry) provider dispatch and fails closed
--      when it is missing: with no RPC, every generic dispatch is refused
--      before the adapter launches. Xometry dispatch is unaffected.
-- ===========================================================================
--
-- Problem: public.api_authorize_provider_worker_dispatch (OVD-459) is a
-- read-only check that returns the same authority on every call until the
-- permit expires. Nothing records that a permit was used, so a task requeued
-- onto another worker passes the preflight again and dispatches twice. The
-- worker's in-process guard (OVD-461) only protects one process.
--
-- Design (expand only; no existing object is altered):
--   * private.provider_dispatch_permit_consumptions: append-only, one row per
--     dispatch attempt, primary key (permit_id, attempt), attempt in (1, 2).
--   * public.api_consume_provider_dispatch_permit: atomically records the
--     attempt immediately before dispatch. A second dispatch of the same permit
--     and envelope fingerprint is refused across workers with
--     permit_already_consumed. The one exception is a single transient retry:
--     attempt 2 is granted only if attempt 1 never started a side effect and
--     recorded the transient outcome.
--   * public.api_mark_provider_dispatch_permit_side_effect_started: stamped
--     immediately before the first provider-facing action. After this stamp the
--     attempt is never transient, so no retry is possible.
--   * public.api_record_provider_dispatch_permit_outcome: one-way outcome stamp.
--
-- Transient means the attempt failed before any side effect: the worker timed
-- out or lost infrastructure (lease, storage, RPC) before launch, or the browser
-- failed to launch. A crash between consume and the outcome stamp leaves the
-- outcome null, which is not transient: the retry is burned and the permit is
-- exhausted (fail closed). Any further dispatch needs a fresh preflight AND a
-- new permit.
--
-- Locking: consume takes the same order as the OVD-459 preflight:
--   1. public.work_queue task row FOR UPDATE (the worker's claim)
--   2. private.provider_dispatch_permits row FOR UPDATE
--   3. reads and inserts private.provider_dispatch_permit_consumptions
-- Two consumers of one permit therefore serialize on the task row; the second
-- sees the first's committed attempt and is refused. Every RPC sets
-- lock_timeout = 2s, so a stuck holder makes a caller fail with 55P03, which the
-- worker treats as unavailable and fails closed (no adapter call).
-- The stamp RPCs lock only the consumption row they stamp.
--
-- Security: every function is SECURITY DEFINER with search_path = '' and fully
-- qualified names. EXECUTE is revoked from public, anon and authenticated and
-- granted to service_role only. The table grants nothing to any API role, has
-- forced RLS with no policies, and a trigger permits only one-way null-to-value
-- stamps of side_effect_started_at and outcome and rejects DELETE and TRUNCATE.
--
-- Rollback: docs/migration-drafts/ovd-734.rollback.sql (refuses while
-- consumption rows exist for unexpired permits; see that file).
-- ===========================================================================

create table private.provider_dispatch_permit_consumptions (
  permit_id uuid not null references private.provider_dispatch_permits (id),
  attempt smallint not null,
  work_queue_task_id uuid not null,
  worker_name text not null,
  envelope_fingerprint text not null,
  consumed_at timestamptz not null default pg_catalog.clock_timestamp(),
  side_effect_started_at timestamptz,
  outcome text,
  constraint provider_dispatch_permit_consumptions_pkey primary key (permit_id, attempt),
  constraint provider_dispatch_permit_consumptions_attempt_check check (attempt in (1, 2)),
  constraint provider_dispatch_permit_consumptions_worker_name_check
    check (pg_catalog.char_length(worker_name) between 1 and 200),
  constraint provider_dispatch_permit_consumptions_fingerprint_check
    check (envelope_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint provider_dispatch_permit_consumptions_outcome_check
    check (outcome is null or outcome in ('transient_pre_launch_failure', 'completed', 'failed')),
  -- A transient outcome means no side effect started.
  constraint provider_dispatch_permit_consumptions_transient_check
    check (outcome is distinct from 'transient_pre_launch_failure' or side_effect_started_at is null),
  constraint provider_dispatch_permit_consumptions_side_effect_order_check
    check (side_effect_started_at is null or side_effect_started_at >= consumed_at)
);

comment on table private.provider_dispatch_permit_consumptions is
  'OVD-734 append-only record of provider dispatch permit consumption. One row per dispatch attempt; at most one transient retry (attempt 2). Service-role RPC access only.';

alter table private.provider_dispatch_permit_consumptions enable row level security;
alter table private.provider_dispatch_permit_consumptions force row level security;
revoke all on table private.provider_dispatch_permit_consumptions
  from public, anon, authenticated, service_role;

-- Append-only guard. Inserts start unstamped and attempt 2 needs a transient
-- attempt 1; updates may only stamp side_effect_started_at and outcome from null
-- to a value, and side_effect_started_at cannot be stamped after the outcome.
-- DELETE and TRUNCATE are rejected. Not tamper proof against the table owner or
-- a superuser, who can disable triggers; no application role can rewrite rows.
create function private.guard_provider_dispatch_permit_consumption()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'provider_dispatch_permit_consumptions is append-only'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.side_effect_started_at is not null or new.outcome is not null then
      raise exception 'provider_dispatch_permit_consumptions rows start unstamped'
        using errcode = '42501';
    end if;
    if new.attempt = 2 and not exists (
      select 1
      from private.provider_dispatch_permit_consumptions first_attempt
      where first_attempt.permit_id = new.permit_id
        and first_attempt.attempt = 1
        and first_attempt.side_effect_started_at is null
        and first_attempt.outcome = 'transient_pre_launch_failure'
    ) then
      raise exception 'provider_dispatch_permit_consumptions attempt 2 requires a transient attempt 1'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if (new.permit_id, new.attempt, new.work_queue_task_id, new.worker_name,
      new.envelope_fingerprint, new.consumed_at)
     is distinct from
     (old.permit_id, old.attempt, old.work_queue_task_id, old.worker_name,
      old.envelope_fingerprint, old.consumed_at) then
    raise exception 'provider_dispatch_permit_consumptions identity columns are immutable'
      using errcode = '42501';
  end if;
  if old.side_effect_started_at is not null
     and new.side_effect_started_at is distinct from old.side_effect_started_at then
    raise exception 'provider_dispatch_permit_consumptions side_effect_started_at is stamped once'
      using errcode = '42501';
  end if;
  if old.outcome is not null and new.outcome is distinct from old.outcome then
    raise exception 'provider_dispatch_permit_consumptions outcome is stamped once'
      using errcode = '42501';
  end if;
  if old.outcome is not null and old.side_effect_started_at is null
     and new.side_effect_started_at is not null then
    raise exception 'provider_dispatch_permit_consumptions attempt already ended'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_provider_dispatch_permit_consumption()
  from public, anon, authenticated, service_role;

create trigger provider_dispatch_permit_consumptions_append_only
  before insert or update or delete on private.provider_dispatch_permit_consumptions
  for each row execute function private.guard_provider_dispatch_permit_consumption();

create trigger provider_dispatch_permit_consumptions_no_truncate
  before truncate on private.provider_dispatch_permit_consumptions
  for each statement execute function private.guard_provider_dispatch_permit_consumption();

create function private.provider_dispatch_permit_consumption_denial(p_denial text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-permit-consumption.v1',
    'consumed', false,
    'denial', p_denial
  );
$$;

revoke all on function private.provider_dispatch_permit_consumption_denial(text)
  from public, anon, authenticated, service_role;

-- OVD-722 kill switch, read by its exact table names. Fail closed: missing
-- tables, a missing global row, or a missing provider row all count as engaged.
create function private.provider_dispatch_permit_kill_switch_engaged(p_provider public.vendor_name)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_provider is null
     or pg_catalog.to_regclass('private.provider_kill_switches') is null
     or pg_catalog.to_regclass('private.provider_global_kill_switch') is null then
    return true;
  end if;
  return coalesce(
      (select global_switch.engaged from private.provider_global_kill_switch global_switch
       where global_switch.singleton),
      true)
    or coalesce(
      (select provider_switch.engaged from private.provider_kill_switches provider_switch
       where provider_switch.provider = p_provider),
      true);
end;
$$;

revoke all on function private.provider_dispatch_permit_kill_switch_engaged(public.vendor_name)
  from public, anon, authenticated, service_role;

create function public.api_consume_provider_dispatch_permit(
  p_work_queue_task_id uuid,
  p_vendor_quote_result_id uuid,
  p_permit_id uuid,
  p_envelope_fingerprint text,
  p_worker_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_task public.work_queue%rowtype;
  v_permit private.provider_dispatch_permits%rowtype;
  v_first private.provider_dispatch_permit_consumptions%rowtype;
  v_attempts integer;
  v_attempt smallint;
  v_permit_state text;
  v_now timestamptz;
begin
  if p_work_queue_task_id is null
    or p_vendor_quote_result_id is null
    or p_permit_id is null
    or p_envelope_fingerprint is null
    or p_envelope_fingerprint !~ '^[a-f0-9]{64}$'
    or nullif(pg_catalog.btrim(p_worker_name), '') is null
    or pg_catalog.char_length(p_worker_name) > 200 then
    return private.provider_dispatch_permit_consumption_denial('permit_mismatch');
  end if;

  -- 1. The worker's claim, locked first (OVD-459 order).
  select task_row.* into v_task
  from public.work_queue task_row
  where task_row.id = p_work_queue_task_id
  for update;

  if v_task.id is null
    or v_task.task_type <> 'run_vendor_quote'
    or v_task.status <> 'running'
    or v_task.locked_by is distinct from p_worker_name then
    return private.provider_dispatch_permit_consumption_denial('task_inactive');
  end if;
  if v_task.payload ->> 'providerDispatchPermitId' is distinct from p_permit_id::text
    or v_task.payload ->> 'providerDispatchEnvelopeFingerprint' is distinct from p_envelope_fingerprint then
    return private.provider_dispatch_permit_consumption_denial('permit_mismatch');
  end if;
  if v_task.payload ->> 'vendorQuoteResultId' is distinct from p_vendor_quote_result_id::text then
    return private.provider_dispatch_permit_consumption_denial('task_lane_mismatch');
  end if;

  -- 2. The permit, FOR UPDATE: every consumer of this permit serializes here.
  select permit_row.* into v_permit
  from private.provider_dispatch_permits permit_row
  where permit_row.id = p_permit_id
  for update;

  if v_permit.id is null then
    return private.provider_dispatch_permit_consumption_denial('permit_state_missing');
  end if;
  if v_permit.work_queue_task_id <> v_task.id
    or v_permit.vendor_quote_result_id <> p_vendor_quote_result_id
    or v_permit.envelope_fingerprint <> p_envelope_fingerprint then
    return private.provider_dispatch_permit_consumption_denial('permit_mismatch');
  end if;
  if v_permit.provider::text is distinct from v_task.payload ->> 'vendor' then
    return private.provider_dispatch_permit_consumption_denial('provider_mismatch');
  end if;
  if v_task.payload ->> 'quoteLaneScopeFingerprint' is distinct from v_permit.scope_fingerprint then
    return private.provider_dispatch_permit_consumption_denial('scope_mismatch');
  end if;

  -- 3. Permit state and lifetime against the clock sampled after the locks.
  v_now := pg_catalog.clock_timestamp();
  v_permit_state := private.resolve_provider_dispatch_permit_state(v_permit.id);
  if v_permit_state = 'revoked' then
    return private.provider_dispatch_permit_consumption_denial('permit_revoked');
  end if;
  if v_permit_state = 'expired' or not (v_permit.expires_at > v_now) then
    return private.provider_dispatch_permit_consumption_denial('permit_expired');
  end if;
  if v_permit_state is distinct from 'active' then
    return private.provider_dispatch_permit_consumption_denial('permit_state_missing');
  end if;
  if v_now < v_permit.issued_at then
    return private.provider_dispatch_permit_consumption_denial('permit_not_yet_valid');
  end if;

  -- 4. OVD-722 kill switch, provider and global.
  if private.provider_dispatch_permit_kill_switch_engaged(v_permit.provider) then
    return private.provider_dispatch_permit_consumption_denial('provider_kill_switch_engaged');
  end if;

  -- 5. At most one attempt, plus one transient retry.
  select pg_catalog.count(*)::integer into v_attempts
  from private.provider_dispatch_permit_consumptions consumption
  where consumption.permit_id = v_permit.id;

  if v_attempts = 0 then
    v_attempt := 1;
  elsif v_attempts = 1 then
    select consumption.* into v_first
    from private.provider_dispatch_permit_consumptions consumption
    where consumption.permit_id = v_permit.id
      and consumption.attempt = 1;
    if v_first.side_effect_started_at is null
      and v_first.outcome is not distinct from 'transient_pre_launch_failure' then
      v_attempt := 2;
    else
      return private.provider_dispatch_permit_consumption_denial('permit_already_consumed');
    end if;
  else
    return private.provider_dispatch_permit_consumption_denial('permit_already_consumed');
  end if;

  insert into private.provider_dispatch_permit_consumptions (
    permit_id, attempt, work_queue_task_id, worker_name, envelope_fingerprint, consumed_at
  ) values (
    v_permit.id, v_attempt, v_task.id, p_worker_name, v_permit.envelope_fingerprint, v_now
  );

  return pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-permit-consumption.v1',
    'consumed', true,
    'permitId', v_permit.id,
    'attempt', v_attempt
  );
end;
$$;

revoke all on function public.api_consume_provider_dispatch_permit(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_consume_provider_dispatch_permit(uuid, uuid, uuid, text, text)
  to service_role;

-- Called immediately before the first provider-facing action of an attempt.
-- Rechecks the kill switch at that moment.
create function public.api_mark_provider_dispatch_permit_side_effect_started(
  p_permit_id uuid,
  p_attempt integer,
  p_worker_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_consumption private.provider_dispatch_permit_consumptions%rowtype;
  v_provider public.vendor_name;
  v_now timestamptz;
begin
  if p_permit_id is null or p_attempt is null or p_attempt not in (1, 2) then
    return private.provider_dispatch_permit_consumption_denial('permit_mismatch');
  end if;

  select consumption.* into v_consumption
  from private.provider_dispatch_permit_consumptions consumption
  where consumption.permit_id = p_permit_id
    and consumption.attempt = p_attempt
  for update;

  if v_consumption.permit_id is null
    or v_consumption.worker_name is distinct from p_worker_name then
    return private.provider_dispatch_permit_consumption_denial('permit_mismatch');
  end if;
  if v_consumption.side_effect_started_at is not null or v_consumption.outcome is not null then
    return private.provider_dispatch_permit_consumption_denial('permit_already_consumed');
  end if;

  select permit_row.provider into v_provider
  from private.provider_dispatch_permits permit_row
  where permit_row.id = p_permit_id;
  if private.provider_dispatch_permit_kill_switch_engaged(v_provider) then
    return private.provider_dispatch_permit_consumption_denial('provider_kill_switch_engaged');
  end if;

  v_now := pg_catalog.clock_timestamp();
  update private.provider_dispatch_permit_consumptions consumption
  set side_effect_started_at = v_now
  where consumption.permit_id = p_permit_id
    and consumption.attempt = p_attempt;

  return pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-permit-consumption.v1',
    'sideEffectStarted', true,
    'permitId', p_permit_id,
    'attempt', p_attempt
  );
end;
$$;

revoke all on function public.api_mark_provider_dispatch_permit_side_effect_started(uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_mark_provider_dispatch_permit_side_effect_started(uuid, integer, text)
  to service_role;

-- One-way outcome stamp. A transient outcome is refused once a side effect has
-- started (the table check enforces the same).
create function public.api_record_provider_dispatch_permit_outcome(
  p_permit_id uuid,
  p_attempt integer,
  p_worker_name text,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_consumption private.provider_dispatch_permit_consumptions%rowtype;
begin
  if p_permit_id is null or p_attempt is null or p_attempt not in (1, 2)
    or p_outcome is null
    or p_outcome not in ('transient_pre_launch_failure', 'completed', 'failed') then
    return private.provider_dispatch_permit_consumption_denial('permit_mismatch');
  end if;

  select consumption.* into v_consumption
  from private.provider_dispatch_permit_consumptions consumption
  where consumption.permit_id = p_permit_id
    and consumption.attempt = p_attempt
  for update;

  if v_consumption.permit_id is null
    or v_consumption.worker_name is distinct from p_worker_name then
    return private.provider_dispatch_permit_consumption_denial('permit_mismatch');
  end if;
  if v_consumption.outcome is not null
    or (p_outcome = 'transient_pre_launch_failure' and v_consumption.side_effect_started_at is not null) then
    return private.provider_dispatch_permit_consumption_denial('permit_already_consumed');
  end if;

  update private.provider_dispatch_permit_consumptions consumption
  set outcome = p_outcome
  where consumption.permit_id = p_permit_id
    and consumption.attempt = p_attempt;

  return pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-permit-consumption.v1',
    'outcomeRecorded', true,
    'permitId', p_permit_id,
    'attempt', p_attempt,
    'outcome', p_outcome
  );
end;
$$;

revoke all on function public.api_record_provider_dispatch_permit_outcome(uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_record_provider_dispatch_permit_outcome(uuid, integer, text, text)
  to service_role;
