-- OVD-234: establish the privileged commercial-operation boundary.
--
-- This migration intentionally does not promote the legacy email allowlist into
-- mutation authority. Platform viewers stay read-only until a stable auth user
-- ID is explicitly assigned billing_admin or order_admin through a server-only
-- path. Real commercial mutations will reuse the private guard and audit helper
-- introduced here.

create table if not exists private.platform_admin_capabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  capability text not null,
  granted_by_user_id uuid references auth.users(id) on delete set null,
  grant_reason text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid references auth.users(id) on delete set null,
  revocation_reason text,
  created_at timestamptz not null default timezone('utc', now()),
  constraint platform_admin_capabilities_capability_check
    check (capability in ('billing_admin', 'order_admin')),
  constraint platform_admin_capabilities_grant_reason_check
    check (length(trim(grant_reason)) between 1 and 1000),
  constraint platform_admin_capabilities_expiry_check
    check (expires_at is null or expires_at > created_at),
  constraint platform_admin_capabilities_revocation_check
    check (
      (
        revoked_at is null
        and revoked_by_user_id is null
        and revocation_reason is null
      )
      or (
        revoked_at is not null
        and revocation_reason is not null
        and length(trim(revocation_reason)) between 1 and 1000
      )
    )
);

create unique index if not exists platform_admin_capabilities_active_unique
  on private.platform_admin_capabilities (user_id, capability)
  where revoked_at is null;

revoke all on private.platform_admin_capabilities
  from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant select, insert, update on private.platform_admin_capabilities to service_role;

create or replace function public.current_user_has_aal2()
returns boolean
language sql
stable
set search_path = pg_catalog
as $$
  select
    auth.uid() is not null
    and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

revoke all on function public.current_user_has_aal2() from public, anon;
grant execute on function public.current_user_has_aal2() to authenticated;

create or replace function public.current_user_has_commercial_capability(
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    p_capability in ('billing_admin', 'order_admin')
    and auth.uid() is not null
    and exists (
      select 1
      from private.platform_admin_capabilities assignment
      where assignment.user_id = auth.uid()
        and assignment.capability = p_capability
        and assignment.revoked_at is null
        and (
          assignment.expires_at is null
          or assignment.expires_at > pg_catalog.timezone('utc', pg_catalog.now())
        )
    );
$$;

revoke all on function public.current_user_has_commercial_capability(text)
  from public, anon;
grant execute on function public.current_user_has_commercial_capability(text)
  to authenticated;

create or replace function private.require_commercial_admin_capability(
  p_capability text
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_actor_user_id uuid := auth.uid();
begin
  if p_capability not in ('billing_admin', 'order_admin') then
    raise exception 'Unsupported commercial capability.';
  end if;

  if v_actor_user_id is null then
    raise exception 'You must be signed in to perform this commercial operation.';
  end if;

  if not public.current_user_has_commercial_capability(p_capability) then
    raise exception 'You do not have the required commercial capability.';
  end if;

  if not public.current_user_has_aal2() then
    raise exception 'Multi-factor authentication is required for this commercial operation.';
  end if;

  return v_actor_user_id;
end;
$$;

revoke all on function private.require_commercial_admin_capability(text)
  from public, anon, authenticated, service_role;

create or replace function private.is_luhn_valid(
  p_digits text
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_sum integer := 0;
  v_digit integer;
begin
  if p_digits is null
    or p_digits !~ '^[0-9]{13,19}$'
  then
    return false;
  end if;

  for v_index in 1..pg_catalog.length(p_digits)
  loop
    v_digit := pg_catalog.substr(p_digits, v_index, 1)::integer;
    if mod(pg_catalog.length(p_digits) - v_index, 2) = 1 then
      v_digit := v_digit * 2;
      if v_digit > 9 then
        v_digit := v_digit - 9;
      end if;
    end if;
    v_sum := v_sum + v_digit;
  end loop;

  return mod(v_sum, 10) = 0;
end;
$$;

revoke all on function private.is_luhn_valid(text)
  from public, anon, authenticated, service_role;

create or replace function private.assert_safe_commercial_audit_value(
  p_value jsonb
)
returns void
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_key text;
  v_normalized_key text;
  v_child jsonb;
  v_text text;
  v_match text[];
  v_digits text;
begin
  if p_value is null or p_value = 'null'::jsonb then
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in
      select entry.key, entry.value
      from pg_catalog.jsonb_each(p_value) as entry
    loop
      v_normalized_key := pg_catalog.regexp_replace(
        pg_catalog.lower(v_key),
        '[^a-z0-9]+',
        '',
        'g'
      );

      if v_normalized_key ~
        '(secret|password|passwd|authorization|token|apikey|accesskey|privatekey|cvc|cvv|cardnumber|paymentmethod|primaryaccountnumber)'
        or v_normalized_key = 'pan'
      then
        raise exception 'Sensitive payment or credential data cannot be written to commercial audit records.';
      end if;

      perform private.assert_safe_commercial_audit_value(v_child);
    end loop;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_value) = 'array' then
    for v_child in
      select item.value
      from pg_catalog.jsonb_array_elements(p_value) as item
    loop
      perform private.assert_safe_commercial_audit_value(v_child);
    end loop;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_value) = 'number' then
    v_text := p_value #>> '{}';
    if private.is_luhn_valid(v_text) then
      raise exception 'Potential card data cannot be written to commercial audit records.';
    end if;
    return;
  end if;

  if pg_catalog.jsonb_typeof(p_value) <> 'string' then
    return;
  end if;

  v_text := p_value #>> '{}';

  if v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    return;
  end if;

  if v_text ~* (
    '(bearer[[:space:]]+[a-z0-9._-]{8,}'
    || '|sk[-_](live|test|proj)?[-_]?[a-z0-9_-]{8,}'
    || '|whsec_[a-z0-9]{8,}'
    || '|gh[pousr]_[a-z0-9]{8,}'
    || '|github_pat_[a-z0-9_]{8,}'
    || '|xox[baprs]-[a-z0-9-]{8,}'
    || '|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}'
    || '|(akia|asia)[a-z0-9]{16}'
    || '|sb_secret_[a-z0-9_-]{8,}'
    || '|-----begin [a-z0-9 ]*private key-----'
    || '|client[_ -]?secret[[:space:]:=]+[^[:space:]]{8,})'
  )
  then
    raise exception 'Potential credential data cannot be written to commercial audit records.';
  end if;

  for v_match in
    select matched.value
    from pg_catalog.regexp_matches(
      v_text,
      '([0-9][0-9 -]{11,21}[0-9])',
      'g'
    ) as matched(value)
  loop
    v_digits := pg_catalog.regexp_replace(v_match[1], '[^0-9]+', '', 'g');
    if private.is_luhn_valid(v_digits) then
      raise exception 'Potential card data cannot be written to commercial audit records.';
    end if;
  end loop;
end;
$$;

revoke all on function private.assert_safe_commercial_audit_value(jsonb)
  from public, anon, authenticated, service_role;

create table if not exists public.commercial_admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  actor_user_id uuid not null,
  required_capability text not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  reason text not null,
  before_state jsonb,
  after_state jsonb,
  request_metadata jsonb not null default '{}'::jsonb,
  idempotency_scope text not null,
  idempotency_key text not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint commercial_admin_audit_capability_check
    check (required_capability in ('billing_admin', 'order_admin')),
  constraint commercial_admin_audit_action_check
    check (action ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  constraint commercial_admin_audit_target_type_check
    check (target_type ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  constraint commercial_admin_audit_target_id_check
    check (length(trim(target_id)) between 1 and 500),
  constraint commercial_admin_audit_reason_check
    check (length(trim(reason)) between 1 and 1000),
  constraint commercial_admin_audit_before_state_check
    check (before_state is null or jsonb_typeof(before_state) = 'object'),
  constraint commercial_admin_audit_after_state_check
    check (after_state is null or jsonb_typeof(after_state) = 'object'),
  constraint commercial_admin_audit_request_metadata_check
    check (jsonb_typeof(request_metadata) = 'object'),
  constraint commercial_admin_audit_idempotency_scope_check
    check (length(trim(idempotency_scope)) between 1 and 700),
  constraint commercial_admin_audit_idempotency_key_check
    check (length(trim(idempotency_key)) between 1 and 200),
  constraint commercial_admin_audit_idempotency_unique
    unique (idempotency_scope, idempotency_key)
);

create index if not exists commercial_admin_audit_created_idx
  on public.commercial_admin_audit_events (created_at desc);

create index if not exists commercial_admin_audit_org_created_idx
  on public.commercial_admin_audit_events (organization_id, created_at desc);

alter table public.commercial_admin_audit_events enable row level security;

drop policy if exists "commercial_admin_audit_select_by_capability"
  on public.commercial_admin_audit_events;
create policy "commercial_admin_audit_select_by_capability"
on public.commercial_admin_audit_events
for select
to authenticated
using (
  public.current_user_has_commercial_capability(required_capability)
);

revoke all on public.commercial_admin_audit_events
  from public, anon, authenticated, service_role;
grant select on public.commercial_admin_audit_events to authenticated, service_role;

create or replace function private.reject_commercial_admin_audit_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using
    errcode = '42501',
    message = 'Commercial audit events are append-only.';
end;
$$;

revoke all on function private.reject_commercial_admin_audit_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists reject_commercial_admin_audit_mutation
  on public.commercial_admin_audit_events;
create trigger reject_commercial_admin_audit_mutation
before update or delete on public.commercial_admin_audit_events
for each row execute function private.reject_commercial_admin_audit_mutation();

create or replace function private.append_commercial_admin_audit_event(
  p_organization_id uuid,
  p_required_capability text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_reason text,
  p_before_state jsonb,
  p_after_state jsonb,
  p_request_metadata jsonb,
  p_idempotency_scope text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_event_id uuid;
begin
  perform private.require_commercial_admin_capability(p_required_capability);
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_action)
  );
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_target_type)
  );
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_target_id)
  );
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_reason)
  );
  perform private.assert_safe_commercial_audit_value(p_before_state);
  perform private.assert_safe_commercial_audit_value(p_after_state);
  perform private.assert_safe_commercial_audit_value(p_request_metadata);
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_idempotency_scope)
  );
  perform private.assert_safe_commercial_audit_value(
    pg_catalog.to_jsonb(p_idempotency_key)
  );

  insert into public.commercial_admin_audit_events (
    organization_id,
    actor_user_id,
    required_capability,
    action,
    target_type,
    target_id,
    reason,
    before_state,
    after_state,
    request_metadata,
    idempotency_scope,
    idempotency_key
  )
  values (
    p_organization_id,
    auth.uid(),
    p_required_capability,
    p_action,
    p_target_type,
    p_target_id,
    trim(p_reason),
    p_before_state,
    p_after_state,
    p_request_metadata,
    trim(p_idempotency_scope),
    trim(p_idempotency_key)
  )
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke all on function private.append_commercial_admin_audit_event(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  text,
  text
) from public, anon, authenticated, service_role;

-- Rollback:
-- 1. Drop the commercial audit table, trigger, and private helpers.
-- 2. Drop private.platform_admin_capabilities last.
-- Historical public.audit_events and the legacy platform-admin allowlist are
-- deliberately untouched by this migration.
