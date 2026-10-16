-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-831 (OVD-828 slice 3): agent-caller API keys. Scoped, hashed,
-- expiring, revocable, rate limited and audited.
--
-- This is a DRAFT. It must not be copied into supabase/migrations/ or applied
-- to any database outside a Blaine-approved migration window (a separate
-- approval card). When approved, it ships as ONE migration (next timestamp
-- from `npm run migration:new`), and
-- supabase/tests/pending/ovd831_agent_api_keys.sql.pending is renamed to
-- supabase/tests/ovd831_agent_api_keys.sql in the same change.
-- Rollback: docs/migration-drafts/ovd-831-agent-api-keys.rollback.sql.
-- Notes, OVD-602 allowlist rows and promotion checklist:
-- docs/migration-drafts/ovd-831-notes.md.
--
-- Requires (already applied): auth.users, auth.uid(), auth.jwt(),
-- public.organizations, public.organization_memberships,
-- public.user_can_access_org(uuid), public.is_org_admin(uuid),
-- public.is_platform_admin(), public.current_user_has_aal2(),
-- pgcrypto in the extensions schema (extensions.gen_random_bytes).
--
-- Transaction: no begin/commit of its own. The migration runner wraps it in
-- one transaction. By hand:
--   psql --single-transaction -v ON_ERROR_STOP=1 -f <file>
--
-- Key format: ovd_<prefix>_<secret>
--   prefix  16 lowercase hex chars (8 random bytes). Not secret; shown in UI
--           and used to find the row.
--   secret  43 base64url chars (32 random bytes = 256 bits) from
--           extensions.gen_random_bytes. Generated here, so no caller can
--           pick a weak secret. Stored only as key_hash =
--           hex(sha256(utf8(secret))). The plaintext key is returned once by
--           api_create_agent_api_key and is never stored or returned again.
--   The server verifier (server/agent-auth/) recomputes the hash and compares
--   it with timingSafeEqual.
--
-- Access model:
--   * public.agent_api_keys: RLS on. anon has nothing. authenticated has
--     column-level SELECT on every column except key_hash, limited by policy
--     to keys of orgs it belongs to. No client INSERT/UPDATE/DELETE grant or
--     policy: writes go through the SECURITY DEFINER RPCs below.
--   * private.agent_api_key_audit and private.agent_api_key_rate_limits:
--     no grant to any API role, RLS forced with no policy. Audit is
--     append-only (trigger).
--   * User RPCs (authenticated): create and revoke require AAL2 and org
--     membership; list is SECURITY INVOKER (RLS applies).
--   * Admin RPCs (authenticated): list by org and revoke any key require
--     public.current_user_has_aal2() AND public.is_platform_admin().
--   * Service RPCs (service_role only): lookup by prefix, admit a use (re-check
--     + rate limit + audit), record a refused use.
--
-- Additive only: three new tables, nine new functions, one trigger function.
-- No existing object changes.

-- =====================================================================
-- Tables
-- =====================================================================
create table public.agent_api_keys (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  name text not null check (pg_catalog.char_length(pg_catalog.btrim(name)) between 1 and 100),
  key_prefix text not null unique check (key_prefix ~ '^[0-9a-f]{16}$'),
  -- hex sha256 of the secret part. Never granted to a client role.
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default array['quotes:read']::text[],
  created_at timestamptz not null default pg_catalog.now(),
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  -- Least privilege: only these scopes exist. There is no admin scope.
  constraint agent_api_keys_scopes_allowed check (
    pg_catalog.cardinality(scopes) between 1 and 2
    -- A null element never matches, so <@ also rejects nulls.
    and scopes <@ array['quotes:read', 'quotes:request']::text[]
  ),
  -- Expiry is required and at most one year after creation.
  constraint agent_api_keys_expiry_window check (
    expires_at > created_at and expires_at <= created_at + interval '1 year'
  ),
  constraint agent_api_keys_revoked_after_created check (
    revoked_at is null or revoked_at >= created_at
  )
);
create index agent_api_keys_org_id_idx on public.agent_api_keys (org_id);
create index agent_api_keys_created_by_idx on public.agent_api_keys (created_by);
comment on table public.agent_api_keys is
  'OVD-831: agent-caller API keys (ovd_<prefix>_<secret>). Only prefix and sha256 hash are stored. Written through RPCs only.';
comment on column public.agent_api_keys.key_hash is
  'OVD-831: hex sha256 of the 256-bit secret. Not selectable by any client role.';

create table private.agent_api_key_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default pg_catalog.clock_timestamp(),
  event text not null check (event in ('create', 'revoke', 'use')),
  key_id uuid not null,
  org_id uuid not null,
  -- The signed-in user for create/revoke; null for use (the caller is the key).
  actor_user_id uuid,
  -- use: the endpoint name, never a URL with a query string or the key.
  endpoint text check (endpoint is null or endpoint ~ '^[a-z][a-z0-9_.:/-]{0,127}$'),
  result text not null check (result ~ '^[a-z][a-z0-9_]{0,63}$'),
  detail jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(detail) = 'object'),
  constraint agent_api_key_audit_use_has_endpoint check ((event = 'use') = (endpoint is not null))
);
create index agent_api_key_audit_key_id_at_idx on private.agent_api_key_audit (key_id, at desc);
create index agent_api_key_audit_org_id_at_idx on private.agent_api_key_audit (org_id, at desc);
comment on table private.agent_api_key_audit is
  'OVD-831: append-only audit of agent key create / revoke / use. Holds key ids, never key material.';

create table private.agent_api_key_rate_limits (
  scope text not null check (scope in ('key', 'org')),
  subject_id uuid not null,
  window_started_at timestamptz not null,
  window_seconds integer not null check (window_seconds between 1 and 3600),
  attempt_count integer not null check (attempt_count >= 1),
  expires_at timestamptz not null,
  primary key (scope, subject_id, window_started_at, window_seconds),
  constraint agent_api_key_rate_limits_expiry check (
    expires_at = window_started_at + pg_catalog.make_interval(secs => window_seconds)
  )
);
create index agent_api_key_rate_limits_expires_at_idx on private.agent_api_key_rate_limits (expires_at);
comment on table private.agent_api_key_rate_limits is
  'OVD-831: fixed-window counters per key and per org for agent key use.';

-- =====================================================================
-- Privileges and RLS
-- =====================================================================
revoke all on table public.agent_api_keys from public, anon, authenticated, service_role;
revoke all on table private.agent_api_key_audit from public, anon, authenticated, service_role;
revoke all on table private.agent_api_key_rate_limits from public, anon, authenticated, service_role;

-- Column-level SELECT: key_hash is deliberately absent.
grant select (id, org_id, created_by, name, key_prefix, scopes, created_at,
              last_used_at, expires_at, revoked_at, revoked_by)
  on table public.agent_api_keys to authenticated;

alter table public.agent_api_keys enable row level security;
alter table private.agent_api_key_audit enable row level security;
alter table private.agent_api_key_audit force row level security;
alter table private.agent_api_key_rate_limits enable row level security;
alter table private.agent_api_key_rate_limits force row level security;

create policy agent_api_keys_select_org_member
on public.agent_api_keys
for select
to authenticated
using (public.user_can_access_org(org_id));

-- Audit is append-only through every granted path (same rule as
-- private.provider_kill_switch_audit).
create function private.agent_api_key_audit_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'agent_api_key_audit is append-only' using errcode = '42501';
end;
$$;
revoke all on function private.agent_api_key_audit_immutable()
  from public, anon, authenticated, service_role;

create trigger agent_api_key_audit_no_update_delete
  before update or delete on private.agent_api_key_audit
  for each row execute function private.agent_api_key_audit_immutable();
create trigger agent_api_key_audit_no_truncate
  before truncate on private.agent_api_key_audit
  for each statement execute function private.agent_api_key_audit_immutable();

-- =====================================================================
-- User RPCs
-- =====================================================================
-- Creates a key for an org the caller belongs to. Needs AAL2. Returns the
-- plaintext key exactly once, in "key". Default scope quotes:read, default
-- expiry 90 days, maximum 1 year.
create function public.api_create_agent_api_key(
  p_org_id uuid,
  p_name text,
  p_scopes text[] default array['quotes:read']::text[],
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_now timestamptz := pg_catalog.now();
  v_name text := pg_catalog.btrim(p_name);
  v_scopes text[];
  v_expires_at timestamptz := coalesce(p_expires_at, pg_catalog.now() + interval '90 days');
  v_prefix text;
  v_secret text;
  v_id uuid;
  v_attempt integer := 0;
begin
  if v_actor is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if not public.current_user_has_aal2() then
    raise exception 'aal2_required' using errcode = '42501';
  end if;
  if p_org_id is null or not public.user_can_access_org(p_org_id) then
    raise exception 'organization_access_required' using errcode = '42501';
  end if;
  if v_name is null or pg_catalog.char_length(v_name) not between 1 and 100 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  select pg_catalog.array_agg(distinct s order by s) into v_scopes
  from pg_catalog.unnest(coalesce(p_scopes, array['quotes:read']::text[])) as s;
  if v_scopes is null
    or pg_catalog.cardinality(v_scopes) = 0
    or not (v_scopes <@ array['quotes:read', 'quotes:request']::text[]) then
    raise exception 'invalid_scopes' using errcode = '22023';
  end if;

  if v_expires_at <= v_now or v_expires_at > v_now + interval '1 year' then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_prefix := pg_catalog.encode(extensions.gen_random_bytes(8), 'hex');
    v_secret := pg_catalog.translate(
      pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
    begin
      insert into public.agent_api_keys
        (org_id, created_by, name, key_prefix, key_hash, scopes, created_at, expires_at)
      values
        (p_org_id, v_actor, v_name, v_prefix,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_secret, 'UTF8')), 'hex'),
         v_scopes, v_now, v_expires_at)
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 3 then
        raise exception 'key_prefix_collision' using errcode = 'P0001';
      end if;
    end;
  end loop;

  insert into private.agent_api_key_audit (event, key_id, org_id, actor_user_id, result, detail)
  values ('create', v_id, p_org_id, v_actor, 'created',
          pg_catalog.jsonb_build_object('scopes', v_scopes, 'expiresAt', v_expires_at));

  return pg_catalog.jsonb_build_object(
    'id', v_id,
    'orgId', p_org_id,
    'name', v_name,
    'keyPrefix', v_prefix,
    'scopes', v_scopes,
    'createdAt', v_now,
    'expiresAt', v_expires_at,
    'key', 'ovd_' || v_prefix || '_' || v_secret
  );
end;
$$;

-- Lists the org's keys (non-secret columns only). SECURITY INVOKER: the
-- caller's column grant and RLS policy decide what it sees.
create function public.api_list_agent_api_keys(p_org_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', k.id, 'orgId', k.org_id, 'createdBy', k.created_by, 'name', k.name,
      'keyPrefix', k.key_prefix, 'scopes', k.scopes, 'createdAt', k.created_at,
      'lastUsedAt', k.last_used_at, 'expiresAt', k.expires_at,
      'revokedAt', k.revoked_at) order by k.created_at desc), '[]'::jsonb)
  from public.agent_api_keys k
  where k.org_id = p_org_id;
$$;

-- Shared revoke body. Idempotent: an already revoked key keeps its original
-- revoked_at and reports alreadyRevoked = true.
create function private.agent_api_key_revoke(p_key_id uuid, p_actor uuid, p_result text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key public.agent_api_keys%rowtype;
  v_already boolean;
begin
  select * into v_key from public.agent_api_keys k where k.id = p_key_id for update;
  if not found then
    raise exception 'key_not_found' using errcode = 'P0002';
  end if;
  v_already := v_key.revoked_at is not null;
  if not v_already then
    update public.agent_api_keys k
    set revoked_at = greatest(pg_catalog.clock_timestamp(), k.created_at),
        revoked_by = p_actor
    where k.id = p_key_id
    returning * into v_key;
    insert into private.agent_api_key_audit (event, key_id, org_id, actor_user_id, result)
    values ('revoke', v_key.id, v_key.org_id, p_actor, p_result);
  end if;
  return pg_catalog.jsonb_build_object(
    'id', v_key.id, 'keyPrefix', v_key.key_prefix,
    'revokedAt', v_key.revoked_at, 'alreadyRevoked', v_already);
end;
$$;

-- Revokes a key. Needs AAL2, and the caller must be the key's creator (and
-- still in the org) or an org admin. Takes effect on the very next verify.
create function public.api_revoke_agent_api_key(p_key_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_org_id uuid;
  v_created_by uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if not public.current_user_has_aal2() then
    raise exception 'aal2_required' using errcode = '42501';
  end if;
  select k.org_id, k.created_by into v_org_id, v_created_by
  from public.agent_api_keys k where k.id = p_key_id;
  -- An unknown key and a key in another org get the same answer.
  if v_org_id is null
    or not public.user_can_access_org(v_org_id)
    or not (v_created_by = v_actor or public.is_org_admin(v_org_id)) then
    raise exception 'key_not_found' using errcode = 'P0002';
  end if;
  return private.agent_api_key_revoke(p_key_id, v_actor, 'revoked');
end;
$$;

-- =====================================================================
-- Admin RPCs: AAL2 AND platform admin
-- =====================================================================
create function public.api_admin_list_agent_api_keys(p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (coalesce(public.current_user_has_aal2(), false)
          and coalesce(public.is_platform_admin(), false)) then
    raise exception 'platform_admin_aal2_required' using errcode = '42501';
  end if;
  return (
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', k.id, 'orgId', k.org_id, 'createdBy', k.created_by, 'name', k.name,
        'keyPrefix', k.key_prefix, 'scopes', k.scopes, 'createdAt', k.created_at,
        'lastUsedAt', k.last_used_at, 'expiresAt', k.expires_at,
        'revokedAt', k.revoked_at, 'revokedBy', k.revoked_by) order by k.created_at desc), '[]'::jsonb)
    from public.agent_api_keys k
    where k.org_id = p_org_id
  );
end;
$$;

create function public.api_admin_revoke_agent_api_key(p_key_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not (coalesce(public.current_user_has_aal2(), false)
          and coalesce(public.is_platform_admin(), false)) then
    raise exception 'platform_admin_aal2_required' using errcode = '42501';
  end if;
  return private.agent_api_key_revoke(p_key_id, auth.uid(), 'admin_revoked');
end;
$$;

-- =====================================================================
-- Service RPCs (server verifier only)
-- =====================================================================
-- Row for one prefix, including key_hash, so the server can compare in
-- constant time. Null when no key has that prefix. Read on every call; the
-- server keeps no cache.
create function public.api_service_get_agent_api_key(p_key_prefix text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', k.id, 'orgId', k.org_id, 'keyHash', k.key_hash, 'scopes', k.scopes,
    'expiresAt', k.expires_at, 'revokedAt', k.revoked_at)
  from public.agent_api_keys k
  where k.key_prefix = p_key_prefix;
$$;

-- Admits one authenticated use after the server has matched the hash and
-- the scope. Under a row lock it re-checks revocation, expiry and that the
-- creator is still an org member, then takes the per-key and per-org rate
-- limits, stamps last_used_at and writes the 'use' audit row. Every outcome
-- is audited. Returns { allowed, result, retryAfterSeconds }.
create function public.api_service_admit_agent_api_key_use(
  p_key_id uuid,
  p_endpoint text,
  p_window_seconds integer,
  p_key_limit integer,
  p_org_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_key public.agent_api_keys%rowtype;
  v_window_started_at timestamptz;
  v_expires_at timestamptz;
  v_key_count integer;
  v_org_count integer;
  v_result text;
  v_retry integer := 0;
begin
  if p_window_seconds is null or p_window_seconds not between 1 and 3600
    or p_key_limit is null or p_key_limit not between 1 and 100000
    or p_org_limit is null or p_org_limit not between 1 and 1000000 then
    raise exception 'invalid_rate_limit' using errcode = '22023';
  end if;
  if p_endpoint is null or p_endpoint !~ '^[a-z][a-z0-9_.:/-]{0,127}$' then
    raise exception 'invalid_endpoint' using errcode = '22023';
  end if;

  -- FOR NO KEY UPDATE: a concurrent revoke (FOR UPDATE) waits for this use to
  -- commit, and this use waits for a revoke in flight, so the two cannot
  -- interleave. It also serialises uses of the same key, so the later
  -- last_used_at UPDATE never upgrades a lock shared with another session
  -- (FOR SHARE here deadlocked two parallel uses of one key).
  select * into v_key from public.agent_api_keys k where k.id = p_key_id for no key update;
  if not found then
    raise exception 'key_not_found' using errcode = 'P0002';
  end if;

  if v_key.revoked_at is not null then
    v_result := 'revoked';
  elsif v_key.expires_at <= v_now then
    v_result := 'expired';
  elsif not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = v_key.org_id and m.user_id = v_key.created_by
  ) then
    v_result := 'creator_not_member';
  else
    v_window_started_at := pg_catalog.to_timestamp(
      pg_catalog.floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);
    v_expires_at := v_window_started_at + pg_catalog.make_interval(secs => p_window_seconds);

    delete from private.agent_api_key_rate_limits r
    where r.scope in ('key', 'org')
      and r.subject_id in (v_key.id, v_key.org_id)
      and r.expires_at <= v_now;

    -- Key first, then org: one lock order for every caller (key row, key
    -- counter, org counter). The org counter is only touched when the key is
    -- under its own limit, so one runaway key cannot spend the org's budget.
    insert into private.agent_api_key_rate_limits as r
      (scope, subject_id, window_started_at, window_seconds, attempt_count, expires_at)
    values ('key', v_key.id, v_window_started_at, p_window_seconds, 1, v_expires_at)
    on conflict (scope, subject_id, window_started_at, window_seconds)
    do update set attempt_count = least(r.attempt_count + 1, p_key_limit + 1)
    returning r.attempt_count into v_key_count;

    if v_key_count <= p_key_limit then
      insert into private.agent_api_key_rate_limits as r
        (scope, subject_id, window_started_at, window_seconds, attempt_count, expires_at)
      values ('org', v_key.org_id, v_window_started_at, p_window_seconds, 1, v_expires_at)
      on conflict (scope, subject_id, window_started_at, window_seconds)
      do update set attempt_count = least(r.attempt_count + 1, p_org_limit + 1)
      returning r.attempt_count into v_org_count;
    end if;

    if v_key_count > p_key_limit then
      v_result := 'rate_limited_key';
    elsif v_org_count > p_org_limit then
      v_result := 'rate_limited_org';
    else
      v_result := 'allowed';
      update public.agent_api_keys k set last_used_at = v_now where k.id = v_key.id;
    end if;
    if v_result <> 'allowed' then
      v_retry := greatest(
        pg_catalog.ceil(extract(epoch from v_expires_at - v_now))::integer, 1);
    end if;
  end if;

  insert into private.agent_api_key_audit (at, event, key_id, org_id, endpoint, result)
  values (v_now, 'use', v_key.id, v_key.org_id, p_endpoint, v_result);

  return pg_catalog.jsonb_build_object(
    'allowed', v_result = 'allowed',
    'result', v_result,
    'retryAfterSeconds', v_retry);
end;
$$;

-- Audits a use the server refused before admission (wrong secret, missing
-- scope, or revoked/expired as read by the lookup). Never takes key material.
create function public.api_service_record_agent_api_key_refusal(
  p_key_id uuid,
  p_endpoint text,
  p_result text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if p_result is null
    or p_result not in ('invalid_secret', 'insufficient_scope', 'revoked', 'expired') then
    raise exception 'invalid_result' using errcode = '22023';
  end if;
  if p_endpoint is null or p_endpoint !~ '^[a-z][a-z0-9_.:/-]{0,127}$' then
    raise exception 'invalid_endpoint' using errcode = '22023';
  end if;
  select k.org_id into v_org_id from public.agent_api_keys k where k.id = p_key_id;
  if v_org_id is null then
    raise exception 'key_not_found' using errcode = 'P0002';
  end if;
  insert into private.agent_api_key_audit (event, key_id, org_id, endpoint, result)
  values ('use', p_key_id, v_org_id, p_endpoint, p_result);
end;
$$;

-- =====================================================================
-- Function privileges
-- =====================================================================
revoke all on function public.api_create_agent_api_key(uuid, text, text[], timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.api_create_agent_api_key(uuid, text, text[], timestamptz)
  to authenticated;

revoke all on function public.api_list_agent_api_keys(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_list_agent_api_keys(uuid) to authenticated;

revoke all on function private.agent_api_key_revoke(uuid, uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function public.api_revoke_agent_api_key(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_revoke_agent_api_key(uuid) to authenticated;

revoke all on function public.api_admin_list_agent_api_keys(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_list_agent_api_keys(uuid) to authenticated;

revoke all on function public.api_admin_revoke_agent_api_key(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.api_admin_revoke_agent_api_key(uuid) to authenticated;

revoke all on function public.api_service_get_agent_api_key(text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_service_get_agent_api_key(text) to service_role;

revoke all on function public.api_service_admit_agent_api_key_use(uuid, text, integer, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.api_service_admit_agent_api_key_use(uuid, text, integer, integer, integer)
  to service_role;

revoke all on function public.api_service_record_agent_api_key_refusal(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_service_record_agent_api_key_refusal(uuid, text, text)
  to service_role;
