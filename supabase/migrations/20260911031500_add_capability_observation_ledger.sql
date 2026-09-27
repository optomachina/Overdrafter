-- OVD-512: add the private append-only provider capability observation ledger.
--
-- This migration creates storage and an owner-only append primitive. It does
-- not create a public/PostgREST RPC, resolver, worker integration, dispatch
-- gate, provider call, or client projection. OVD-513 may wrap the private
-- append primitive in a separately reviewed service-role-only boundary.
--
-- Operational rollback/disable (preserves the indefinite v1 audit record):
-- 1. Revoke and remove every future OVD-513 public wrapper before rollback.
-- 2. Keep EXECUTE on private.record_capability_observation(...) revoked from
--    PUBLIC and every application role.
-- 3. Keep the table, identity sequence, constraints, and append-only triggers
--    in place. Do not drop, truncate, update, or delete retained observations.

create or replace function private.capability_observation_extensions_are_safe(
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

alter function private.capability_observation_extensions_are_safe(text[])
  owner to postgres;
revoke all on function private.capability_observation_extensions_are_safe(text[])
  from public, anon, authenticated, service_role;

create or replace function private.capability_observation_mime_types_are_safe(
  p_mime_types text[]
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_mime_type text;
begin
  if p_mime_types is null or pg_catalog.cardinality(p_mime_types) > 32 then
    return false;
  end if;

  foreach v_mime_type in array p_mime_types
  loop
    if v_mime_type is null
      or v_mime_type !~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'
    then
      return false;
    end if;
  end loop;

  return pg_catalog.cardinality(p_mime_types) = (
    select pg_catalog.count(distinct mime_type_value)
    from pg_catalog.unnest(p_mime_types) as mime_type_value
  );
end;
$$;

alter function private.capability_observation_mime_types_are_safe(text[])
  owner to postgres;
revoke all on function private.capability_observation_mime_types_are_safe(text[])
  from public, anon, authenticated, service_role;

create table private.capability_observations (
  id bigint generated always as identity primary key,
  provider public.vendor_name not null,
  capability text not null,
  route text not null,
  surface text not null,
  surface_revision text not null,
  contract_version text not null,
  observation_state text not null,
  observed_extensions text[] not null default array[]::text[],
  observed_mime_types text[] not null default array[]::text[],
  accept_attribute_present boolean,
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  actor_kind text not null,
  source_kind text not null,
  source_version text not null,
  evidence_reference text not null,
  idempotency_key text not null,
  observation_revision bigint not null,
  inserted_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint capability_observations_capability_check check (
    capability = 'provider_upload'
  ),
  constraint capability_observations_route_check check (
    route = pg_catalog.lower(pg_catalog.btrim(route))
    and route ~ '^[a-z][a-z0-9._-]{0,79}$'
  ),
  constraint capability_observations_surface_check check (
    surface = pg_catalog.lower(pg_catalog.btrim(surface))
    and surface ~ '^[a-z][a-z0-9._-]{0,79}$'
  ),
  constraint capability_observations_surface_revision_check check (
    surface_revision = pg_catalog.lower(pg_catalog.btrim(surface_revision))
    and surface_revision ~ '^[a-z][a-z0-9._-]{0,79}$'
  ),
  constraint capability_observations_contract_version_check check (
    contract_version = 'provider-upload-capability.v1'
  ),
  constraint capability_observations_state_check check (
    observation_state in (
      'fresh',
      'ambiguous',
      'loading',
      'route_or_selector_drift',
      'authentication_required',
      'anti_bot_or_challenge',
      'provider_error',
      'unclassified_response'
    )
  ),
  constraint capability_observations_extensions_check check (
    private.capability_observation_extensions_are_safe(observed_extensions)
  ),
  constraint capability_observations_mime_types_check check (
    private.capability_observation_mime_types_are_safe(observed_mime_types)
  ),
  constraint capability_observations_non_fresh_payload_check check (
    (
      observation_state = 'fresh'
      and accept_attribute_present is not null
    )
    or (
      observation_state <> 'fresh'
      and pg_catalog.cardinality(observed_extensions) = 0
      and pg_catalog.cardinality(observed_mime_types) = 0
      and accept_attribute_present is null
    )
  ),
  constraint capability_observations_ttl_check check (
    expires_at > observed_at
    and expires_at <= observed_at + interval '26 hours'
  ),
  constraint capability_observations_clock_skew_check check (
    observed_at <= inserted_at + interval '5 minutes'
  ),
  constraint capability_observations_actor_kind_check check (
    actor_kind in ('worker', 'operator', 'scheduled_canary', 'system')
  ),
  constraint capability_observations_source_kind_check check (
    source_kind in ('provider_surface', 'controlled_probe', 'scheduled_canary')
  ),
  constraint capability_observations_source_version_check check (
    source_version = pg_catalog.lower(pg_catalog.btrim(source_version))
    and source_version ~ '^[a-z][a-z0-9._-]{0,79}$'
  ),
  constraint capability_observations_evidence_reference_check check (
    evidence_reference ~ '^issue:OVD-[1-9][0-9]{0,9}$'
  ),
  constraint capability_observations_idempotency_key_check check (
    idempotency_key = pg_catalog.lower(pg_catalog.btrim(idempotency_key))
    and idempotency_key ~ '^[a-z][a-z0-9._:-]{2,127}$'
    and idempotency_key !~ '^[a-f0-9]{32,}$'
  ),
  constraint capability_observations_revision_check check (
    observation_revision > 0
  ),
  constraint capability_observations_idempotency_key_unique
    unique (idempotency_key),
  constraint capability_observations_scope_revision_unique
    unique (
      provider,
      capability,
      route,
      surface,
      surface_revision,
      observation_revision
    )
);

alter table private.capability_observations owner to postgres;
alter sequence private.capability_observations_id_seq owner to postgres;

create index capability_observations_current_scope_idx
  on private.capability_observations (
    provider,
    capability,
    route,
    surface,
    surface_revision,
    observed_at desc,
    observation_revision desc,
    id desc
  );

create or replace function private.prepare_capability_observation_insert()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.inserted_at := pg_catalog.statement_timestamp();
  return new;
end;
$$;

alter function private.prepare_capability_observation_insert() owner to postgres;
revoke all on function private.prepare_capability_observation_insert()
  from public, anon, authenticated, service_role;

create trigger prepare_capability_observation_insert
before insert on private.capability_observations
for each row execute function private.prepare_capability_observation_insert();

create or replace function private.reject_capability_observation_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'Capability observations are append-only.';
end;
$$;

alter function private.reject_capability_observation_mutation() owner to postgres;
revoke all on function private.reject_capability_observation_mutation()
  from public, anon, authenticated, service_role;

create trigger reject_capability_observation_row_mutation
before update or delete on private.capability_observations
for each row execute function private.reject_capability_observation_mutation();

create trigger reject_capability_observation_truncate
before truncate on private.capability_observations
for each statement execute function private.reject_capability_observation_mutation();

create or replace function private.record_capability_observation(
  p_provider public.vendor_name,
  p_capability text,
  p_route text,
  p_surface text,
  p_surface_revision text,
  p_contract_version text,
  p_observation_state text,
  p_observed_extensions text[],
  p_observed_mime_types text[],
  p_accept_attribute_present boolean,
  p_observed_at timestamptz,
  p_expires_at timestamptz,
  p_actor_kind text,
  p_source_kind text,
  p_source_version text,
  p_evidence_reference text,
  p_idempotency_key text,
  p_observation_revision bigint
)
returns bigint
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_capability text := pg_catalog.lower(pg_catalog.btrim(p_capability));
  v_route text := pg_catalog.lower(pg_catalog.btrim(p_route));
  v_surface text := pg_catalog.lower(pg_catalog.btrim(p_surface));
  v_surface_revision text := pg_catalog.lower(pg_catalog.btrim(p_surface_revision));
  v_contract_version text := pg_catalog.lower(pg_catalog.btrim(p_contract_version));
  v_observation_state text := pg_catalog.lower(pg_catalog.btrim(p_observation_state));
  v_observed_extensions text[];
  v_observed_mime_types text[];
  v_actor_kind text := pg_catalog.lower(pg_catalog.btrim(p_actor_kind));
  v_source_kind text := pg_catalog.lower(pg_catalog.btrim(p_source_kind));
  v_source_version text := pg_catalog.lower(pg_catalog.btrim(p_source_version));
  v_evidence_reference text := pg_catalog.btrim(p_evidence_reference);
  v_idempotency_key text := pg_catalog.lower(pg_catalog.btrim(p_idempotency_key));
  v_idempotency_lock bigint;
  v_revision_lock bigint;
  v_existing_count integer;
  v_exact_id bigint;
  v_inserted_id bigint;
begin
  select coalesce(
    pg_catalog.array_agg(normalized_extension order by normalized_extension),
    array[]::text[]
  )
  into v_observed_extensions
  from (
    select distinct pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(extension_value)),
      '^[.]',
      ''
    ) as normalized_extension
    from pg_catalog.unnest(
      coalesce(p_observed_extensions, array[]::text[])
    ) as extension_value
  ) normalized_extensions;

  select coalesce(
    pg_catalog.array_agg(normalized_mime_type order by normalized_mime_type),
    array[]::text[]
  )
  into v_observed_mime_types
  from (
    select distinct pg_catalog.lower(
      pg_catalog.btrim(mime_type_value)
    ) as normalized_mime_type
    from pg_catalog.unnest(
      coalesce(p_observed_mime_types, array[]::text[])
    ) as mime_type_value
  ) normalized_mime_types;

  v_idempotency_lock := pg_catalog.hashtextextended(
    'capability-observation:idempotency:' || v_idempotency_key,
    0
  );
  v_revision_lock := pg_catalog.hashtextextended(
    'capability-observation:revision:'
      || p_provider::text || ':'
      || v_capability || ':'
      || v_route || ':'
      || v_surface || ':'
      || v_surface_revision || ':'
      || p_observation_revision::text,
    0
  );

  perform pg_catalog.pg_advisory_xact_lock(
    least(v_idempotency_lock, v_revision_lock)
  );
  if v_idempotency_lock <> v_revision_lock then
    perform pg_catalog.pg_advisory_xact_lock(
      greatest(v_idempotency_lock, v_revision_lock)
    );
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.min(observation.id) filter (
      where observation.idempotency_key = v_idempotency_key
        and observation.provider = p_provider
        and observation.capability = v_capability
        and observation.route = v_route
        and observation.surface = v_surface
        and observation.surface_revision = v_surface_revision
        and observation.observation_revision = p_observation_revision
        and observation.contract_version is not distinct from v_contract_version
        and observation.observation_state is not distinct from v_observation_state
        and observation.observed_extensions is not distinct from v_observed_extensions
        and observation.observed_mime_types is not distinct from v_observed_mime_types
        and observation.accept_attribute_present is not distinct from p_accept_attribute_present
        and observation.observed_at is not distinct from p_observed_at
        and observation.expires_at is not distinct from p_expires_at
        and observation.actor_kind is not distinct from v_actor_kind
        and observation.source_kind is not distinct from v_source_kind
        and observation.source_version is not distinct from v_source_version
        and observation.evidence_reference is not distinct from v_evidence_reference
    )
  into v_existing_count, v_exact_id
  from private.capability_observations observation
  where observation.idempotency_key = v_idempotency_key
    or (
      observation.provider = p_provider
      and observation.capability = v_capability
      and observation.route = v_route
      and observation.surface = v_surface
      and observation.surface_revision = v_surface_revision
      and observation.observation_revision = p_observation_revision
    );

  if v_existing_count > 0 then
    if v_existing_count = 1 and v_exact_id is not null then
      return v_exact_id;
    end if;

    raise exception using
      errcode = '23505',
      message = 'Capability observation replay conflict.';
  end if;

  insert into private.capability_observations (
    provider,
    capability,
    route,
    surface,
    surface_revision,
    contract_version,
    observation_state,
    observed_extensions,
    observed_mime_types,
    accept_attribute_present,
    observed_at,
    expires_at,
    actor_kind,
    source_kind,
    source_version,
    evidence_reference,
    idempotency_key,
    observation_revision
  ) values (
    p_provider,
    v_capability,
    v_route,
    v_surface,
    v_surface_revision,
    v_contract_version,
    v_observation_state,
    v_observed_extensions,
    v_observed_mime_types,
    p_accept_attribute_present,
    p_observed_at,
    p_expires_at,
    v_actor_kind,
    v_source_kind,
    v_source_version,
    v_evidence_reference,
    v_idempotency_key,
    p_observation_revision
  )
  returning id into v_inserted_id;

  return v_inserted_id;
end;
$$;

alter function private.record_capability_observation(
  public.vendor_name,
  text,
  text,
  text,
  text,
  text,
  text,
  text[],
  text[],
  boolean,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  text,
  text,
  bigint
) owner to postgres;

revoke all on function private.record_capability_observation(
  public.vendor_name,
  text,
  text,
  text,
  text,
  text,
  text,
  text[],
  text[],
  boolean,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  text,
  text,
  bigint
) from public, anon, authenticated, service_role;

alter table private.capability_observations enable row level security;
alter table private.capability_observations force row level security;

revoke all on table private.capability_observations
  from public, anon, authenticated, service_role;
revoke all on sequence private.capability_observations_id_seq
  from public, anon, authenticated, service_role;

comment on table private.capability_observations is
  'OVD-512 private, append-only, indefinitely retained v1 provider capability observations; never a dispatch permit or client projection.';
comment on function private.record_capability_observation(
  public.vendor_name,
  text,
  text,
  text,
  text,
  text,
  text,
  text[],
  text[],
  boolean,
  timestamptz,
  timestamptz,
  text,
  text,
  text,
  text,
  text,
  bigint
) is
  'Owner-only normalized append primitive. Exact key, revision, and canonical payload replay returns the retained row id; every conflict raises 23505.';
