-- OVD-379: add the private, default-deny provider admission registry.
--
-- This registry records reviewed provider metadata only. It is not a dispatch
-- permit, does not enable an adapter, and is not consumed by the current
-- Xometry permit/preflight path. Missing rows and incomplete rows resolve
-- closed. Provider routing remains unchanged by this migration.
--
-- Operational rollback before OVD-380 consumes this contract:
-- 1. Keep every provider rollout disabled.
-- 2. Revoke and drop private.resolve_quote_provider_admission_policy(text).
-- 3. Drop the policy/history triggers and their helper functions.
-- 4. Export and retain the append-only history unless retention is explicitly
--    waived, then drop the two tables and the extension validator.
-- After a consumer exists, roll that consumer back before this registry.

create or replace function private.quote_provider_extensions_are_safe(
  p_extensions text[]
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_extension text;
begin
  if p_extensions is null or pg_catalog.cardinality(p_extensions) > 32 then
    return false;
  end if;

  foreach v_extension in array p_extensions
  loop
    if v_extension is null
      or v_extension !~ '^[a-z0-9][a-z0-9_-]{0,31}$'
    then
      return false;
    end if;
  end loop;

  return pg_catalog.cardinality(p_extensions) = (
    select pg_catalog.count(distinct extension_value)
    from pg_catalog.unnest(p_extensions) as extension_value
  );
end;
$$;

revoke all on function private.quote_provider_extensions_are_safe(text[])
  from public, anon, authenticated, service_role;

create table private.quote_provider_admission_policies (
  provider public.vendor_name primary key,
  admission_state text not null default 'disabled', -- NOSONAR: canonical fail-closed provider admission state
  generic_dispatch_enabled boolean not null default false,
  policy_revision text not null,
  evidence_reference text,
  permission_basis text,
  supported_processes public.process_types[] not null
    default array[]::public.process_types[],
  accepted_file_extensions text[] not null default array[]::text[],
  session_owner text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  expires_at timestamptz,
  change_reason text not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint quote_provider_admission_state_check
    check (admission_state in ('disabled', 'evidence_required', 'controlled_beta_only', 'approved')), -- NOSONAR: explicit bounded admission vocabulary
  constraint quote_provider_policy_revision_check check (
    policy_revision = pg_catalog.btrim(policy_revision)
    and policy_revision ~ '^[a-z0-9][a-z0-9._-]{2,199}$'
  ),
  constraint quote_provider_evidence_reference_check check (
    evidence_reference is null
    or evidence_reference ~ '^OVD-[1-9][0-9]{0,9}$'
  ),
  constraint quote_provider_permission_basis_check check (
    permission_basis is null
    or permission_basis in (
      'provider_terms_allow_automation',
      'written_provider_authorization',
      'existing_controlled_beta_path' -- NOSONAR: explicit permission vocabulary shared with resolver validation
    )
  ),
  constraint quote_provider_processes_check check (
    pg_catalog.cardinality(supported_processes) <= 16
    and pg_catalog.array_position(supported_processes, null) is null
  ),
  constraint quote_provider_extensions_check check (
    private.quote_provider_extensions_are_safe(accepted_file_extensions)
  ),
  constraint quote_provider_session_owner_check check (
    session_owner is null
    or session_owner in (
      'overdrafter_managed',
      'provider_api',
      'customer_managed'
    )
  ),
  constraint quote_provider_change_reason_check check (
    change_reason in (
      'initial_seed', -- NOSONAR: explicit append-only policy event vocabulary
      'certification_evidence_recorded',
      'approval_recorded',
      'policy_updated',
      'policy_expired',
      'policy_disabled',
      'policy_reinstated',
      'correction'
    )
  ),
  constraint quote_provider_generic_dispatch_state_check check (
    not generic_dispatch_enabled or admission_state = 'approved'
  ),
  constraint quote_provider_approved_permission_check check (
    admission_state <> 'approved'
    or permission_basis in (
      'provider_terms_allow_automation',
      'written_provider_authorization'
    )
  ),
  constraint quote_provider_controlled_beta_permission_check check (
    permission_basis <> 'existing_controlled_beta_path'
    or (
      provider = 'xometry'::public.vendor_name
      and admission_state = 'controlled_beta_only'
    )
  ),
  constraint quote_provider_admitted_completeness_check check (
    admission_state not in ('controlled_beta_only', 'approved')
    or (
      evidence_reference is not null
      and permission_basis is not null
      and pg_catalog.cardinality(supported_processes) > 0
      and pg_catalog.cardinality(accepted_file_extensions) > 0
      and session_owner is not null
      and reviewed_at is not null
      and (admission_state <> 'approved' or reviewed_by is not null)
    )
  ),
  constraint quote_provider_expiry_check check (
    expires_at is null
    or (reviewed_at is not null and expires_at > reviewed_at)
  )
);

create table private.quote_provider_admission_policy_history (
  id bigint generated always as identity primary key,
  provider public.vendor_name not null,
  admission_state text not null,
  generic_dispatch_enabled boolean not null,
  policy_revision text not null,
  evidence_reference text,
  permission_basis text,
  supported_processes public.process_types[] not null,
  accepted_file_extensions text[] not null,
  session_owner text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  expires_at timestamptz,
  change_kind text not null,
  change_reason text not null,
  changed_by_role text not null,
  changed_at timestamptz not null default pg_catalog.now(),
  constraint quote_provider_history_change_kind_check
    check (change_kind in ('insert', 'update')),
  constraint quote_provider_history_role_check check (
    pg_catalog.length(pg_catalog.btrim(changed_by_role)) between 1 and 200
  ),
  constraint quote_provider_history_revision_unique
    unique (provider, policy_revision)
);

create index quote_provider_admission_policy_history_provider_idx
  on private.quote_provider_admission_policy_history
    (provider, changed_at desc, id desc);

create or replace function private.guard_quote_provider_admission_policy_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Provider admission policies cannot be deleted.';
  end if;

  if new.provider is distinct from old.provider then
    raise exception 'Provider admission policy identity is immutable.';
  end if;

  if pg_catalog.btrim(new.policy_revision)
    = pg_catalog.btrim(old.policy_revision)
  then
    raise exception 'Provider admission policy updates require a new revision.';
  end if;

  new.created_at := old.created_at;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function private.guard_quote_provider_admission_policy_mutation()
  from public, anon, authenticated, service_role;

create trigger guard_quote_provider_admission_policy_mutation
before update or delete on private.quote_provider_admission_policies
for each row execute function private.guard_quote_provider_admission_policy_mutation();

create or replace function private.capture_quote_provider_admission_policy_history()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  insert into private.quote_provider_admission_policy_history (
    provider,
    admission_state,
    generic_dispatch_enabled,
    policy_revision,
    evidence_reference,
    permission_basis,
    supported_processes,
    accepted_file_extensions,
    session_owner,
    reviewed_by,
    reviewed_at,
    expires_at,
    change_kind,
    change_reason,
    changed_by_role
  )
  values (
    new.provider,
    new.admission_state,
    new.generic_dispatch_enabled,
    new.policy_revision,
    new.evidence_reference,
    new.permission_basis,
    new.supported_processes,
    new.accepted_file_extensions,
    new.session_owner,
    new.reviewed_by,
    new.reviewed_at,
    new.expires_at,
    pg_catalog.lower(tg_op),
    new.change_reason,
    session_user
  );

  return new;
end;
$$;

revoke all on function private.capture_quote_provider_admission_policy_history()
  from public, anon, authenticated, service_role;

create trigger capture_quote_provider_admission_policy_history
after insert or update on private.quote_provider_admission_policies
for each row execute function private.capture_quote_provider_admission_policy_history();

create or replace function private.reject_quote_provider_admission_history_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'Provider admission policy history is append-only.';
end;
$$;

revoke all on function private.reject_quote_provider_admission_history_mutation()
  from public, anon, authenticated, service_role;

create trigger reject_quote_provider_admission_history_mutation
before update or delete on private.quote_provider_admission_policy_history
for each row execute function private.reject_quote_provider_admission_history_mutation();

insert into private.quote_provider_admission_policies (
  provider,
  admission_state,
  generic_dispatch_enabled,
  policy_revision,
  evidence_reference,
  permission_basis,
  supported_processes,
  accepted_file_extensions,
  session_owner,
  reviewed_by,
  reviewed_at,
  expires_at,
  change_reason
)
values
  (
    'xometry'::public.vendor_name, 'controlled_beta_only', false,
    'xometry-controlled-beta-2026-08-17.v1',
    'OVD-373',
    'existing_controlled_beta_path',
    array['cnc_milling']::public.process_types[], array['step', 'stp']::text[],
    'overdrafter_managed', null, timestamptz '2026-08-17 00:00:00+00', null,
    'initial_seed'
  ),
  ('fictiv'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'), -- NOSONAR: intentionally explicit default-deny seed template for every provider
  ('protolabs'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('sendcutsend'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('partsbadger'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('fastdms'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('devzmanufacturing'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('infraredlaboratories'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('oshcut'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('fabworks'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('ponoko'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('quickparts'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('rapiddirect'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('geomiq'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('weerg'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed'),
  ('protolabsnetwork'::public.vendor_name, 'disabled', false, 'disabled-2026-08-17.v1', null, null, array[]::public.process_types[], array[]::text[], null, null, null, null, 'initial_seed');

alter table private.quote_provider_admission_policies enable row level security;
alter table private.quote_provider_admission_policies force row level security;
alter table private.quote_provider_admission_policy_history enable row level security;
alter table private.quote_provider_admission_policy_history force row level security;

revoke all on table private.quote_provider_admission_policies from public, anon, authenticated, service_role;
revoke all on table private.quote_provider_admission_policy_history from public, anon, authenticated, service_role;
revoke all on sequence private.quote_provider_admission_policy_history_id_seq from public, anon, authenticated, service_role;

create or replace function private.resolve_quote_provider_admission_policy(p_provider text)
returns table (
  policy_present boolean,
  provider_admitted boolean,
  generically_dispatchable boolean,
  provider public.vendor_name,
  admission_state text,
  policy_revision text,
  evidence_reference text,
  permission_basis text,
  supported_processes public.process_types[],
  accepted_file_extensions text[],
  session_owner text,
  reviewed_at timestamptz,
  expires_at timestamptz,
  reason_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_policy private.quote_provider_admission_policies%rowtype;
  v_complete boolean;
  v_expired boolean;
  v_admitted boolean;
  v_generically_dispatchable boolean;
  v_reason_code text;
begin
  if p_provider is null or pg_catalog.btrim(p_provider) = '' then
    return query select false, false, false, null::public.vendor_name,
      'disabled'::text, null::text, null::text, null::text,
      array[]::public.process_types[], array[]::text[], null::text,
      null::timestamptz, null::timestamptz, 'provider_unknown'::text;
    return;
  end if;

  select policy.*
  into v_policy
  from private.quote_provider_admission_policies policy
  where policy.provider::text = pg_catalog.btrim(p_provider);

  if not found then
    return query select false, false, false, null::public.vendor_name,
      'disabled'::text, null::text, null::text, null::text,
      array[]::public.process_types[], array[]::text[], null::text,
      null::timestamptz, null::timestamptz, 'provider_unknown'::text;
    return;
  end if;

  v_complete := v_policy.evidence_reference is not null
    and v_policy.permission_basis is not null
    and pg_catalog.cardinality(v_policy.supported_processes) > 0
    and pg_catalog.cardinality(v_policy.accepted_file_extensions) > 0
    and v_policy.session_owner is not null
    and v_policy.reviewed_at is not null
    and (
      v_policy.admission_state <> 'approved'
      or v_policy.reviewed_by is not null
    );
  v_expired := v_policy.expires_at is not null
    and v_policy.expires_at <= pg_catalog.now();
  v_admitted := v_policy.admission_state in ('controlled_beta_only', 'approved')
    and v_complete
    and not v_expired;
  v_generically_dispatchable := v_policy.admission_state = 'approved'
    and v_policy.generic_dispatch_enabled is true
    and v_complete
    and not v_expired;

  if v_expired then
    v_reason_code := 'policy_expired';
  elsif v_policy.admission_state in ('controlled_beta_only', 'approved')
    and not v_complete
  then
    v_reason_code := 'policy_incomplete';
  elsif v_generically_dispatchable then
    v_reason_code := 'provider_approved';
  elsif v_policy.admission_state = 'controlled_beta_only' then
    v_reason_code := 'controlled_beta_only';
  elsif v_policy.admission_state = 'evidence_required' then
    v_reason_code := 'evidence_required';
  elsif v_policy.admission_state = 'approved' then
    v_reason_code := 'generic_dispatch_disabled';
  else
    v_reason_code := 'provider_disabled';
  end if;

  return query select
    true,
    v_admitted,
    v_generically_dispatchable,
    v_policy.provider,
    v_policy.admission_state,
    v_policy.policy_revision,
    v_policy.evidence_reference,
    v_policy.permission_basis,
    v_policy.supported_processes,
    v_policy.accepted_file_extensions,
    v_policy.session_owner,
    v_policy.reviewed_at,
    v_policy.expires_at,
    v_reason_code;
end;
$$;

revoke all on function private.resolve_quote_provider_admission_policy(text) from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant execute on function private.resolve_quote_provider_admission_policy(text) to service_role;
