-- OVD-513: two PostgREST-visible service-only wrappers over the OVD-512 ledger.
-- The private append primitive remains the sole owner of normalization, ordered
-- advisory locking, canonical replay, and insertion. No direct ledger grant is
-- added and no worker or client projection is changed.
--
-- Operational disable/rollback (retain indefinite audit history):
-- 1. REVOKE EXECUTE on both public functions from service_role immediately.
-- 2. DROP these two public functions only after callers are disabled.
-- 3. Keep private.capability_observations, its sequence, constraints, triggers,
--    and private.record_capability_observation(...) intact; never delete rows.

begin;

create function public.api_record_capability_observation(
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
security definer
set search_path = pg_catalog
as $$
begin
  perform private.record_capability_observation(
    p_provider, p_capability, p_route, p_surface, p_surface_revision,
    p_contract_version, p_observation_state, p_observed_extensions,
    p_observed_mime_types, p_accept_attribute_present, p_observed_at,
    p_expires_at, p_actor_kind, p_source_kind, p_source_version,
    p_evidence_reference, p_idempotency_key, p_observation_revision
  );

  -- Return the caller's proven scoped revision, never the private row id.
  return p_observation_revision;
exception
  when unique_violation then
    raise exception using errcode = '23505',
      message = 'Capability observation replay conflict.';
  when others then
    raise exception using errcode = '22023',
      message = 'Capability observation rejected.';
end;
$$;

alter function public.api_record_capability_observation(
  public.vendor_name, text, text, text, text, text, text, text[], text[],
  boolean, timestamptz, timestamptz, text, text, text, text, text, bigint
) owner to postgres;
revoke all on function public.api_record_capability_observation(
  public.vendor_name, text, text, text, text, text, text, text[], text[],
  boolean, timestamptz, timestamptz, text, text, text, text, text, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.api_record_capability_observation(
  public.vendor_name, text, text, text, text, text, text, text[], text[],
  boolean, timestamptz, timestamptz, text, text, text, text, text, bigint
) to service_role;

create function public.api_resolve_current_capability_observation(
  p_provider public.vendor_name,
  p_capability text,
  p_route text,
  p_surface text,
  p_surface_revision text
)
returns table (
  provider text,
  capability text,
  route text,
  surface text,
  surface_revision text,
  contract_version text,
  observation_state text,
  observed_extensions text[],
  observed_mime_types text[],
  accept_attribute_present boolean,
  observed_at timestamptz,
  expires_at timestamptz,
  freshness text,
  observation_revision bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_capability text := pg_catalog.lower(pg_catalog.btrim(p_capability));
  v_route text := pg_catalog.lower(pg_catalog.btrim(p_route));
  v_surface text := pg_catalog.lower(pg_catalog.btrim(p_surface));
  v_surface_revision text := pg_catalog.lower(pg_catalog.btrim(p_surface_revision));
  v_scope_ok boolean;
  v_latest private.capability_observations%rowtype;
  v_found boolean := false;
  v_disagree boolean := false;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_state text := 'ambiguous';
  v_freshness text := 'invalid_scope';
  v_extensions text[] := array[]::text[];
  v_mime_types text[] := array[]::text[];
  v_accept boolean;
  v_observed_at timestamptz;
  v_expires_at timestamptz;
  v_revision bigint;
  v_version text;
begin
  v_scope_ok := p_provider is not null
    and v_capability = 'provider_upload'
    and v_route ~ '^[a-z][a-z0-9._-]{0,79}$'
    and v_surface ~ '^[a-z][a-z0-9._-]{0,79}$'
    and v_surface_revision ~ '^[a-z][a-z0-9._-]{0,79}$';

  if v_scope_ok then
    select observation.* into v_latest
    from private.capability_observations observation
    where observation.provider = p_provider
      and observation.capability = v_capability
      and observation.route = v_route
      and observation.surface = v_surface
      and observation.surface_revision = v_surface_revision
    order by observation.observed_at desc,
      observation.observation_revision desc, observation.id desc
    limit 1;
    v_found := found;

    if not v_found then
      v_state := 'missing';
      v_freshness := 'missing';
    else
      -- Every row at the newest observation time participates. In particular,
      -- expiry disagreement is ambiguous even if one row has already expired.
      select exists (
        select 1 from private.capability_observations tied
        where tied.provider = p_provider
          and tied.capability = v_capability
          and tied.route = v_route
          and tied.surface = v_surface
          and tied.surface_revision = v_surface_revision
          and tied.observed_at = v_latest.observed_at
          and (
            tied.contract_version is distinct from v_latest.contract_version
            or tied.observation_state is distinct from v_latest.observation_state
            or tied.observed_extensions is distinct from v_latest.observed_extensions
            or tied.observed_mime_types is distinct from v_latest.observed_mime_types
            or tied.accept_attribute_present is distinct from v_latest.accept_attribute_present
            or tied.expires_at is distinct from v_latest.expires_at
          )
      ) into v_disagree;

      if v_disagree then
        v_state := 'ambiguous';
        v_freshness := 'ambiguous';
      elsif v_latest.contract_version <> 'provider-upload-capability.v1'
        or v_latest.observation_state not in (
          'fresh', 'ambiguous', 'loading', 'route_or_selector_drift',
          'authentication_required', 'anti_bot_or_challenge',
          'provider_error', 'unclassified_response'
        )
        or not private.capability_observation_extensions_are_safe(v_latest.observed_extensions)
        or not private.capability_observation_mime_types_are_safe(v_latest.observed_mime_types)
        or (v_latest.observation_state = 'fresh'
          and v_latest.accept_attribute_present is null)
        or (v_latest.observation_state <> 'fresh'
          and (pg_catalog.cardinality(v_latest.observed_extensions) <> 0
            or pg_catalog.cardinality(v_latest.observed_mime_types) <> 0
            or v_latest.accept_attribute_present is not null))
        or v_latest.expires_at <= v_latest.observed_at
        or v_latest.expires_at > v_latest.observed_at + interval '26 hours'
        or v_latest.observed_at > v_now
      then
        v_state := 'ambiguous';
        v_freshness := 'malformed';
      elsif v_latest.expires_at <= v_now then
        v_state := 'stale';
        v_freshness := 'stale';
        v_observed_at := v_latest.observed_at;
        v_expires_at := v_latest.expires_at;
      elsif v_latest.observation_state = 'ambiguous' then
        v_state := 'ambiguous';
        v_freshness := 'ambiguous';
        v_observed_at := v_latest.observed_at;
        v_expires_at := v_latest.expires_at;
      else
        v_state := v_latest.observation_state;
        v_freshness := 'current';
        v_version := v_latest.contract_version;
        v_observed_at := v_latest.observed_at;
        v_expires_at := v_latest.expires_at;
        v_revision := v_latest.observation_revision;
        if v_state = 'fresh' then
          v_extensions := v_latest.observed_extensions;
          v_mime_types := v_latest.observed_mime_types;
          v_accept := v_latest.accept_attribute_present;
        end if;
      end if;
    end if;
  end if;

  return query select
    case when v_scope_ok then p_provider::text else null::text end,
    case when v_scope_ok then v_capability else null::text end,
    case when v_scope_ok then v_route else null::text end,
    case when v_scope_ok then v_surface else null::text end,
    case when v_scope_ok then v_surface_revision else null::text end,
    v_version, v_state, v_extensions, v_mime_types, v_accept,
    v_observed_at, v_expires_at, v_freshness, v_revision;
end;
$$;

alter function public.api_resolve_current_capability_observation(
  public.vendor_name, text, text, text, text
) owner to postgres;
revoke all on function public.api_resolve_current_capability_observation(
  public.vendor_name, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.api_resolve_current_capability_observation(
  public.vendor_name, text, text, text, text
) to service_role;

comment on function public.api_record_capability_observation(
  public.vendor_name, text, text, text, text, text, text, text[], text[],
  boolean, timestamptz, timestamptz, text, text, text, text, text, bigint
) is 'OVD-513 service-only append boundary; returns only the scoped observation revision.';
comment on function public.api_resolve_current_capability_observation(
  public.vendor_name, text, text, text, text
) is 'OVD-513 service-only sanitized current observation; never a dispatch permit.';

commit;
