-- OVD-462 provider session lease: PROPOSED migration draft.
--
-- NOT APPLIED. This file is intentionally outside supabase/migrations/ and needs
-- Blaine's migration window 1 (blaine-window label). When it is promoted, copy it
-- byte-for-byte into supabase/migrations/<npm run migration:next>_ovd462_provider_session_leases.sql.
-- supabase/tests/fixtures/ovd462_provider_session_leases.inc is a byte copy of this
-- file, enforced by scripts/run-supabase-policy-tests.node-test.mjs.
--
-- ===========================================================================
-- PHASE 1: EXPAND (this window)
-- Adds two tables, one private validator and six service-role-only RPCs. No
-- existing object is altered, so the phase is backward compatible: running
-- workers ignore it until OVD-464 wires the worker lease manager to these RPCs.
--
-- Data boundary: rows hold only opaque HMAC-derived references (acct_<hex>,
-- sb_<hex>), the provider slug, the runtime environment, a task reference, a
-- random holder token, opaque operator actor/reason references and timestamps.
-- Credentials, cookies, storage state, profile bytes, account names, e-mail
-- addresses and paths are never stored; the format checks below reject them.
--
-- Locking: every RPC serializes on a transaction advisory lock for the
-- provider/account/environment key. RPCs that can associate a session binding
-- with a key (acquire, revoke) then take a second lock on the session_binding_ref.
-- The order is always key lock first, then exactly one session-binding lock, so
-- no deadlock cycle is possible. Each RPC sets lock_timeout = 2s: a stuck holder
-- makes callers fail with 55P03 (lock_not_available), which the worker treats as
-- an unconfirmed store call and fails closed, instead of waiting without bound.
--
-- Invariant: one lease RPC per transaction. Advisory transaction locks are held
-- until commit, so two of these RPCs in one transaction could take locks in an
-- order the rule above does not cover. PostgREST runs every RPC call in its own
-- transaction, which is the only supported caller.
-- ===========================================================================

-- Storage backstop for "a session binding belongs to exactly one
-- provider/account/environment": the primary key makes the association unique
-- even if the advisory locks were bypassed, and lease rows reference it. It also
-- carries the generation counter, so generations stay strictly increasing after
-- lease history is deleted by retention.
create table public.provider_session_bindings (
  session_binding_ref text primary key,
  provider text not null,
  account_ref text not null,
  environment text not null,
  next_generation bigint not null default 1,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint provider_session_bindings_provider_format
    check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint provider_session_bindings_account_ref_format
    check (account_ref ~ '^acct_[0-9a-f]{32}$'),
  constraint provider_session_bindings_environment_known
    check (environment in ('production', 'staging', 'development', 'test')),
  constraint provider_session_bindings_session_binding_ref_format
    check (session_binding_ref ~ '^sb_[0-9a-f]{32}$'),
  constraint provider_session_bindings_next_generation_positive check (next_generation > 0),
  constraint provider_session_bindings_identity_unique
    unique (session_binding_ref, provider, account_ref, environment)
);

comment on table public.provider_session_bindings is
  'OVD-462 session binding registry. Each session_binding_ref belongs to exactly one provider/account/environment and carries the per-key generation counter. Opaque references only. Service-role RPC access only.';

create index provider_session_bindings_key_idx
  on public.provider_session_bindings (provider, account_ref, environment);

alter table public.provider_session_bindings enable row level security;
alter table public.provider_session_bindings force row level security;
revoke all on table public.provider_session_bindings from public, anon, authenticated, service_role;

create table public.provider_session_leases (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  account_ref text not null,
  environment text not null,
  session_binding_ref text not null,
  generation bigint not null,
  state text not null,
  owner_task_ref text,
  holder_token uuid,
  outcome text,
  ttl_seconds integer,
  max_renewals integer,
  renewal_count integer not null default 0,
  acquired_at timestamptz,
  expires_at timestamptz,
  hard_expires_at timestamptz,
  ended_at timestamptz,
  revoked_by_ref text,
  revoke_reason_ref text,
  cleared_by_ref text,
  clear_reason_ref text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint provider_session_leases_provider_format
    check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint provider_session_leases_account_ref_format
    check (account_ref ~ '^acct_[0-9a-f]{32}$'),
  constraint provider_session_leases_environment_known
    check (environment in ('production', 'staging', 'development', 'test')),
  constraint provider_session_leases_session_binding_ref_format
    check (session_binding_ref ~ '^sb_[0-9a-f]{32}$'),
  constraint provider_session_leases_owner_task_ref_format
    check (owner_task_ref is null or owner_task_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  constraint provider_session_leases_generation_positive check (generation > 0),
  constraint provider_session_leases_state_known
    check (state in ('active', 'released', 'expired', 'blocked', 'cleared', 'revoked')),
  constraint provider_session_leases_outcome_known
    check (outcome is null or outcome in
      ('missing_session', 'login_required', 'challenge_required', 'owner_revoked', 'corrupt_state')),
  -- Lease columns are all present (a granted lease) or all absent (an operator
  -- revocation recorded while no lease was held).
  constraint provider_session_leases_lease_columns_together
    check (num_nulls(owner_task_ref, holder_token, ttl_seconds, max_renewals,
      acquired_at, expires_at, hard_expires_at) in (0, 7)),
  constraint provider_session_leases_granted_states_have_lease
    check (state not in ('active', 'released', 'expired') or holder_token is not null),
  -- 'revoked' is the ended row of a holder an operator revoked; the block itself
  -- is a separate 'blocked' row with a fresh generation.
  constraint provider_session_leases_outcome_matches_state
    check ((state in ('blocked', 'cleared', 'revoked')) = (outcome is not null)),
  constraint provider_session_leases_revoked_state_is_owner_revoked
    check (state <> 'revoked' or (outcome = 'owner_revoked' and holder_token is not null)),
  constraint provider_session_leases_ended_matches_state
    check ((state = 'active') = (ended_at is null)),
  constraint provider_session_leases_ttl_bounded
    check (ttl_seconds is null or ttl_seconds between 5 and 300),
  constraint provider_session_leases_renewals_bounded
    check (max_renewals is null or (max_renewals between 0 and 720
      and renewal_count between 0 and max_renewals)),
  constraint provider_session_leases_expiry_bounded
    check (acquired_at is null or (expires_at <= hard_expires_at
      and hard_expires_at > acquired_at
      and hard_expires_at <= acquired_at + interval '4 hours')),
  -- Operator audit: revocations and clears record who acted and why, as opaque
  -- references (never names or e-mail addresses).
  constraint provider_session_leases_operator_refs_format
    check ((revoked_by_ref is null or revoked_by_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
      and (revoke_reason_ref is null or revoke_reason_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
      and (cleared_by_ref is null or cleared_by_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
      and (clear_reason_ref is null or clear_reason_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')),
  constraint provider_session_leases_revoke_audit_together
    check ((revoked_by_ref is null) = (revoke_reason_ref is null)
      and (revoked_by_ref is null or outcome = 'owner_revoked')),
  constraint provider_session_leases_clear_audit_matches_state
    check ((cleared_by_ref is null) = (clear_reason_ref is null)
      and (state = 'cleared') = (cleared_by_ref is not null)),
  -- Generation fencing: every grant or revocation for a binding gets a fresh,
  -- strictly increasing generation.
  constraint provider_session_leases_generation_unique
    unique (provider, account_ref, environment, generation),
  -- A lease row can only name a session binding registered to the same key.
  constraint provider_session_leases_binding_registered
    foreign key (session_binding_ref, provider, account_ref, environment)
    references public.provider_session_bindings (session_binding_ref, provider, account_ref, environment)
);

comment on table public.provider_session_leases is
  'OVD-462 provider session leases. One occupant (active or blocked) per provider/account/environment binding. Opaque references only; never credentials or session material. Service-role RPC access only.';

-- At most one occupant per provider/account/environment binding. This is the
-- storage backstop that keeps crash/expiry recovery from ever producing two
-- simultaneous owners even if the advisory lock below were bypassed.
create unique index provider_session_leases_one_occupant
  on public.provider_session_leases (provider, account_ref, environment)
  where state in ('active', 'blocked');

-- Supports the binding foreign key and lookups by session binding.
create index provider_session_leases_session_binding_ref_idx
  on public.provider_session_leases (session_binding_ref);

alter table public.provider_session_leases enable row level security;
alter table public.provider_session_leases force row level security;
-- No policies: every direct read or write is denied, including for the table
-- owner, because RLS is forced. The SECURITY DEFINER RPCs below run as the
-- function owner, which therefore must have BYPASSRLS or be a superuser
-- (Supabase's `postgres` role has BYPASSRLS). The pgTAP suite asserts this; a
-- migration run as any other owner would fail closed on every RPC.
revoke all on table public.provider_session_leases from public, anon, authenticated, service_role;

-- Not callable by any API role; lives in the repo's private helper schema.
create function private.provider_session_lease_identity_ok(
  p_provider text,
  p_account_ref text,
  p_environment text,
  p_session_binding_ref text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_provider ~ '^[a-z][a-z0-9_]{1,31}$'
      and p_account_ref ~ '^acct_[0-9a-f]{32}$'
      and p_environment in ('production', 'staging', 'development', 'test')
      and p_session_binding_ref ~ '^sb_[0-9a-f]{32}$',
    false)
$$;

revoke all on function private.provider_session_lease_identity_ok(text, text, text, text)
  from public, anon, authenticated, service_role;

create function public.acquire_provider_session_lease(
  p_provider text,
  p_account_ref text,
  p_environment text,
  p_session_binding_ref text,
  p_task_ref text,
  p_holder_token uuid,
  p_ttl_seconds integer,
  p_max_renewals integer,
  p_max_duration_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_now timestamptz;
  v_row public.provider_session_leases%rowtype;
  v_generation bigint;
begin
  if not private.provider_session_lease_identity_ok(p_provider, p_account_ref, p_environment, p_session_binding_ref)
     or p_task_ref is null or p_task_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
     or p_holder_token is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_identity');
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 5 and 300
     or p_max_renewals is null or p_max_renewals not between 0 and 720
     or p_max_duration_seconds is null or p_max_duration_seconds not between p_ttl_seconds and 14400 then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_policy');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ovd462|' || p_provider || '|' || p_account_ref || '|' || p_environment, 462));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ovd462sb|' || p_session_binding_ref, 462));
  -- Read the clock after the lock wait so expiry checks and new deadlines are current.
  v_now := pg_catalog.clock_timestamp();

  -- A session binding belongs to exactly one provider/account/environment.
  if exists (
    select 1 from public.provider_session_bindings b
    where b.session_binding_ref = p_session_binding_ref
      and (b.provider, b.account_ref, b.environment) is distinct from (p_provider, p_account_ref, p_environment)
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'binding_mismatch');
  end if;

  -- Expiry recovery: an expired holder loses the binding before anyone else
  -- can be granted it, inside the same serialized section.
  update public.provider_session_leases l
     set state = 'expired', ended_at = v_now, updated_at = v_now
   where l.provider = p_provider and l.account_ref = p_account_ref and l.environment = p_environment
     and l.state = 'active' and l.expires_at <= v_now;

  select * into v_row from public.provider_session_leases l
   where l.provider = p_provider and l.account_ref = p_account_ref and l.environment = p_environment
     and l.state in ('active', 'blocked')
   for update;

  if found then
    if v_row.state = 'blocked' then
      return jsonb_build_object('status', 'manual_follow_up', 'outcome', v_row.outcome);
    end if;
    if v_row.owner_task_ref = p_task_ref and v_row.holder_token = p_holder_token
       and v_row.session_binding_ref = p_session_binding_ref then
      return jsonb_build_object(
        'status', 'acquired',
        'generation', v_row.generation,
        'idempotent', true,
        'expires_in_ms', greatest(0, floor(extract(epoch from (v_row.expires_at - v_now)) * 1000))::bigint,
        'renewals_remaining', v_row.max_renewals - v_row.renewal_count);
    end if;
    return jsonb_build_object(
      'status', 'contended',
      'retry_after_ms', least(
        greatest(1, ceil(extract(epoch from (v_row.expires_at - v_now)) * 1000)),
        p_ttl_seconds * 1000)::bigint);
  end if;

  -- Register the session binding to this key (storage backstop) and re-check.
  insert into public.provider_session_bindings (session_binding_ref, provider, account_ref, environment, created_at, updated_at)
  values (p_session_binding_ref, p_provider, p_account_ref, p_environment, v_now, v_now)
  on conflict (session_binding_ref) do nothing;
  if not exists (
    select 1 from public.provider_session_bindings b
    where b.session_binding_ref = p_session_binding_ref
      and b.provider = p_provider and b.account_ref = p_account_ref and b.environment = p_environment
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'binding_mismatch');
  end if;

  -- The per-key counter lives on every binding row of the key and is advanced
  -- together under the key lock; lease history is only a floor for it.
  select greatest(
           coalesce(max(b.next_generation), 1),
           coalesce((select max(l.generation) from public.provider_session_leases l
                      where l.provider = p_provider and l.account_ref = p_account_ref
                        and l.environment = p_environment), 0) + 1)
    into v_generation
    from public.provider_session_bindings b
   where b.provider = p_provider and b.account_ref = p_account_ref and b.environment = p_environment;
  update public.provider_session_bindings b
     set next_generation = v_generation + 1, updated_at = v_now
   where b.provider = p_provider and b.account_ref = p_account_ref and b.environment = p_environment;

  insert into public.provider_session_leases (
    provider, account_ref, environment, session_binding_ref, generation, state,
    owner_task_ref, holder_token, ttl_seconds, max_renewals, renewal_count,
    acquired_at, expires_at, hard_expires_at, created_at, updated_at)
  values (
    p_provider, p_account_ref, p_environment, p_session_binding_ref, v_generation, 'active',
    p_task_ref, p_holder_token, p_ttl_seconds, p_max_renewals, 0,
    v_now, v_now + make_interval(secs => p_ttl_seconds),
    v_now + make_interval(secs => p_max_duration_seconds), v_now, v_now);

  return jsonb_build_object(
    'status', 'acquired',
    'generation', v_generation,
    'idempotent', false,
    'expires_in_ms', p_ttl_seconds * 1000,
    'renewals_remaining', p_max_renewals);
end;
$$;

create function public.renew_provider_session_lease(
  p_provider text,
  p_account_ref text,
  p_environment text,
  p_session_binding_ref text,
  p_task_ref text,
  p_holder_token uuid,
  p_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_now timestamptz;
  v_row public.provider_session_leases%rowtype;
  v_expires timestamptz;
begin
  if not private.provider_session_lease_identity_ok(p_provider, p_account_ref, p_environment, p_session_binding_ref) then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_identity');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ovd462|' || p_provider || '|' || p_account_ref || '|' || p_environment, 462));
  v_now := pg_catalog.clock_timestamp();

  select * into v_row from public.provider_session_leases l
   where l.provider = p_provider and l.account_ref = p_account_ref and l.environment = p_environment
     and l.generation = p_generation
   for update;

  if not found or v_row.holder_token is null
     or v_row.session_binding_ref <> p_session_binding_ref
     or v_row.owner_task_ref is distinct from p_task_ref
     or v_row.holder_token is distinct from p_holder_token then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_owner');
  end if;

  if v_row.state <> 'active' then
    return jsonb_build_object('status', 'lost', 'reason', v_row.state, 'outcome', v_row.outcome);
  end if;

  if v_row.expires_at <= v_now then
    update public.provider_session_leases l
       set state = 'expired', ended_at = v_now, updated_at = v_now
     where l.id = v_row.id;
    return jsonb_build_object('status', 'lost', 'reason', 'expired', 'outcome', null);
  end if;

  -- The renewal is denied (terminal lease_lost for the worker), but the lease
  -- stays active until its current expires_at: the holder may still be running
  -- up to the deadline it was given, so nobody else may be granted the binding
  -- before then. Expiry recovery or the holder's release ends the row.
  if v_row.renewal_count >= v_row.max_renewals or v_row.hard_expires_at <= v_now then
    return jsonb_build_object('status', 'lost', 'reason', 'renewal_exhausted', 'outcome', null);
  end if;

  v_expires := least(v_now + make_interval(secs => v_row.ttl_seconds), v_row.hard_expires_at);
  update public.provider_session_leases l
     set renewal_count = l.renewal_count + 1, expires_at = v_expires, updated_at = v_now
   where l.id = v_row.id;

  return jsonb_build_object(
    'status', 'renewed',
    'expires_in_ms', greatest(0, floor(extract(epoch from (v_expires - v_now)) * 1000))::bigint,
    'renewals_remaining', v_row.max_renewals - v_row.renewal_count - 1);
end;
$$;

create function public.release_provider_session_lease(
  p_provider text,
  p_account_ref text,
  p_environment text,
  p_session_binding_ref text,
  p_task_ref text,
  p_holder_token uuid,
  p_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_now timestamptz;
  v_row public.provider_session_leases%rowtype;
  v_final text;
begin
  if not private.provider_session_lease_identity_ok(p_provider, p_account_ref, p_environment, p_session_binding_ref) then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_identity');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ovd462|' || p_provider || '|' || p_account_ref || '|' || p_environment, 462));
  v_now := pg_catalog.clock_timestamp();

  select * into v_row from public.provider_session_leases l
   where l.provider = p_provider and l.account_ref = p_account_ref and l.environment = p_environment
     and l.generation = p_generation
   for update;

  if not found or v_row.holder_token is null
     or v_row.session_binding_ref <> p_session_binding_ref
     or v_row.owner_task_ref is distinct from p_task_ref
     or v_row.holder_token is distinct from p_holder_token then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_owner');
  end if;

  if v_row.state <> 'active' then
    -- Idempotent: the exact owner already no longer holds this generation.
    return jsonb_build_object('status', 'released', 'changed', false, 'final_state', v_row.state);
  end if;

  v_final := case when v_row.expires_at <= v_now then 'expired' else 'released' end;
  update public.provider_session_leases l
     set state = v_final, ended_at = v_now, updated_at = v_now
   where l.id = v_row.id;

  return jsonb_build_object('status', 'released', 'changed', v_final = 'released', 'final_state', v_final);
end;
$$;

create function public.report_provider_session_lease_outcome(
  p_provider text,
  p_account_ref text,
  p_environment text,
  p_session_binding_ref text,
  p_task_ref text,
  p_holder_token uuid,
  p_generation bigint,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_now timestamptz;
  v_row public.provider_session_leases%rowtype;
begin
  if not private.provider_session_lease_identity_ok(p_provider, p_account_ref, p_environment, p_session_binding_ref) then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_identity');
  end if;
  -- owner_revoked is not reportable by a holder: only the operator revoke RPC
  -- below may set it, so a worker cannot forge an operator fence.
  if p_outcome is null
     or p_outcome not in ('missing_session', 'login_required', 'challenge_required', 'corrupt_state') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_outcome');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ovd462|' || p_provider || '|' || p_account_ref || '|' || p_environment, 462));
  v_now := pg_catalog.clock_timestamp();

  select * into v_row from public.provider_session_leases l
   where l.provider = p_provider and l.account_ref = p_account_ref and l.environment = p_environment
     and l.generation = p_generation
   for update;

  if not found or v_row.holder_token is null
     or v_row.session_binding_ref <> p_session_binding_ref
     or v_row.owner_task_ref is distinct from p_task_ref
     or v_row.holder_token is distinct from p_holder_token then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_owner');
  end if;

  if v_row.state <> 'active' then
    return jsonb_build_object('status', 'lost', 'reason', v_row.state, 'outcome', v_row.outcome);
  end if;
  if v_row.expires_at <= v_now then
    update public.provider_session_leases l
       set state = 'expired', ended_at = v_now, updated_at = v_now
     where l.id = v_row.id;
    return jsonb_build_object('status', 'lost', 'reason', 'expired', 'outcome', null);
  end if;

  update public.provider_session_leases l
     set state = 'blocked', outcome = p_outcome, ended_at = v_now, updated_at = v_now
   where l.id = v_row.id;

  return jsonb_build_object('status', 'blocked', 'outcome', p_outcome, 'generation', v_row.generation);
end;
$$;

-- Operator fence: revokes the owner currently holding the binding on exactly
-- this session binding and blocks new grants until
-- clear_provider_session_binding_block runs. Requires and records opaque actor
-- and reason references. Revoking with a session binding that is not the current
-- holder's is rejected (binding_mismatch). A current holder's row ends as
-- 'revoked'; the block is always a new 'blocked' row with a fresh generation,
-- which is what this returns and what the clear RPC takes. With no holder, the
-- session binding is registered to this key first.
--
-- Operator RPCs are granted to service_role like the worker RPCs, for 1.0; they
-- are called from the admin server path, the worker code path cannot construct
-- them (separate TS factory) and every use is attributable. A dedicated
-- operator database role is deferred to 1.1.
create function public.revoke_provider_session_binding(
  p_provider text,
  p_account_ref text,
  p_environment text,
  p_session_binding_ref text,
  p_actor_ref text,
  p_reason_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_now timestamptz;
  v_row public.provider_session_leases%rowtype;
  v_generation bigint;
begin
  if not private.provider_session_lease_identity_ok(p_provider, p_account_ref, p_environment, p_session_binding_ref) then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_identity');
  end if;
  if p_actor_ref is null or p_actor_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
     or p_reason_ref is null or p_reason_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_actor');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ovd462|' || p_provider || '|' || p_account_ref || '|' || p_environment, 462));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ovd462sb|' || p_session_binding_ref, 462));
  v_now := pg_catalog.clock_timestamp();

  if exists (
    select 1 from public.provider_session_bindings b
    where b.session_binding_ref = p_session_binding_ref
      and (b.provider, b.account_ref, b.environment) is distinct from (p_provider, p_account_ref, p_environment)
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'binding_mismatch');
  end if;

  select * into v_row from public.provider_session_leases l
   where l.provider = p_provider and l.account_ref = p_account_ref and l.environment = p_environment
     and l.state in ('active', 'blocked')
   for update;

  if found and v_row.session_binding_ref <> p_session_binding_ref then
    return jsonb_build_object('status', 'rejected', 'reason', 'binding_mismatch');
  end if;

  if found and v_row.state = 'blocked' then
    return jsonb_build_object('status', 'blocked', 'outcome', v_row.outcome, 'generation', v_row.generation);
  end if;

  -- The revoked holder's row ends as 'revoked' (its renew, report and release
  -- see owner_revoked); the block below gets a fresh generation, so revoked and
  -- pre-revocation authority are always distinguishable.
  if found then
    update public.provider_session_leases l
       set state = 'revoked', outcome = 'owner_revoked', ended_at = v_now, updated_at = v_now
     where l.id = v_row.id;
  end if;

  insert into public.provider_session_bindings (session_binding_ref, provider, account_ref, environment, created_at, updated_at)
  values (p_session_binding_ref, p_provider, p_account_ref, p_environment, v_now, v_now)
  on conflict (session_binding_ref) do nothing;
  if not exists (
    select 1 from public.provider_session_bindings b
    where b.session_binding_ref = p_session_binding_ref
      and b.provider = p_provider and b.account_ref = p_account_ref and b.environment = p_environment
  ) then
    return jsonb_build_object('status', 'rejected', 'reason', 'binding_mismatch');
  end if;

  select greatest(
           coalesce(max(b.next_generation), 1),
           coalesce((select max(l.generation) from public.provider_session_leases l
                      where l.provider = p_provider and l.account_ref = p_account_ref
                        and l.environment = p_environment), 0) + 1)
    into v_generation
    from public.provider_session_bindings b
   where b.provider = p_provider and b.account_ref = p_account_ref and b.environment = p_environment;
  update public.provider_session_bindings b
     set next_generation = v_generation + 1, updated_at = v_now
   where b.provider = p_provider and b.account_ref = p_account_ref and b.environment = p_environment;

  insert into public.provider_session_leases (
    provider, account_ref, environment, session_binding_ref, generation, state, outcome,
    ended_at, revoked_by_ref, revoke_reason_ref, created_at, updated_at)
  values (
    p_provider, p_account_ref, p_environment, p_session_binding_ref, v_generation, 'blocked',
    'owner_revoked', v_now, p_actor_ref, p_reason_ref, v_now, v_now);

  return jsonb_build_object('status', 'blocked', 'outcome', 'owner_revoked', 'generation', v_generation);
end;
$$;

-- Operator action after manual follow-up (re-authentication, challenge cleared,
-- owner re-approved) completed outside this system. Clears exactly one block
-- and records opaque actor and reason references. See the role note above.
create function public.clear_provider_session_binding_block(
  p_provider text,
  p_account_ref text,
  p_environment text,
  p_generation bigint,
  p_actor_ref text,
  p_reason_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_now timestamptz;
  v_id uuid;
begin
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{1,31}$'
     or p_account_ref is null or p_account_ref !~ '^acct_[0-9a-f]{32}$'
     or p_environment is null or p_environment not in ('production', 'staging', 'development', 'test') then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_identity');
  end if;
  if p_actor_ref is null or p_actor_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
     or p_reason_ref is null or p_reason_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' then
    return jsonb_build_object('status', 'rejected', 'reason', 'invalid_actor');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ovd462|' || p_provider || '|' || p_account_ref || '|' || p_environment, 462));
  v_now := pg_catalog.clock_timestamp();

  update public.provider_session_leases l
     set state = 'cleared', updated_at = v_now, cleared_by_ref = p_actor_ref, clear_reason_ref = p_reason_ref
   where l.provider = p_provider and l.account_ref = p_account_ref and l.environment = p_environment
     and l.generation = p_generation and l.state = 'blocked'
  returning l.id into v_id;

  if v_id is null then
    return jsonb_build_object('status', 'rejected', 'reason', 'not_blocked');
  end if;
  return jsonb_build_object('status', 'cleared');
end;
$$;

revoke all on function public.acquire_provider_session_lease(text, text, text, text, text, uuid, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.renew_provider_session_lease(text, text, text, text, text, uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.release_provider_session_lease(text, text, text, text, text, uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.report_provider_session_lease_outcome(text, text, text, text, text, uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.revoke_provider_session_binding(text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.clear_provider_session_binding_block(text, text, text, bigint, text, text)
  from public, anon, authenticated;

grant execute on function public.acquire_provider_session_lease(text, text, text, text, text, uuid, integer, integer, integer)
  to service_role;
grant execute on function public.renew_provider_session_lease(text, text, text, text, text, uuid, bigint)
  to service_role;
grant execute on function public.release_provider_session_lease(text, text, text, text, text, uuid, bigint)
  to service_role;
grant execute on function public.report_provider_session_lease_outcome(text, text, text, text, text, uuid, bigint, text)
  to service_role;
grant execute on function public.revoke_provider_session_binding(text, text, text, text, text, text)
  to service_role;
grant execute on function public.clear_provider_session_binding_block(text, text, text, bigint, text, text)
  to service_role;

-- ===========================================================================
-- PHASE 2: CONTRACT (NOT part of this window; separate issue and window)
-- The expand phase changes no existing object, so nothing must be contracted
-- for correctness. Candidates once OVD-464 has run on these RPCs in production
-- for a full release cycle, each as its own reviewed migration:
--
--   -- Retention: bound lease history growth (keep occupants). Generations stay
--   -- monotonic because they come from provider_session_bindings.next_generation,
--   -- which retention must never delete or lower.
--   -- delete from public.provider_session_leases
--   --  where state in ('released', 'expired', 'cleared', 'revoked')
--   --    and ended_at < now() - interval '30 days';
--
--   -- If a later design replaces operator revocation with an approval table:
--   -- drop function public.revoke_provider_session_binding(text, text, text, text, text, text);
--
-- Worker-side contract (code, not SQL): retire the file-system sidecar lock in
-- worker/src/adapters/persistentProfileLock.ts only after the DB lease is the
-- sole cross-host owner and the native browser lock check is kept.
-- ===========================================================================
