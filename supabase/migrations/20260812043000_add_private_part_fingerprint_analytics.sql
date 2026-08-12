-- OVD-349
-- Record cross-organization fingerprint observations for service-only aggregate
-- analytics. These records never participate in intake, access, file reuse, or
-- sourcing decisions and are not exposed to authenticated clients.
--
-- Rollback: revoke the worker RPC, drop the observation trigger/function, then
-- drop the three private tables. Public part identities and customer records are
-- unaffected.

create table if not exists private.part_fingerprint_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  part_version_id uuid not null references public.part_versions(id) on delete cascade,
  fingerprint_version text not null,
  package_fingerprint text not null,
  observed_at timestamptz not null default timezone('utc', now()),
  constraint part_fingerprint_observations_hash_check
    check (package_fingerprint ~ '^[0-9a-f]{64}$'),
  unique (part_version_id, fingerprint_version)
);

create index if not exists idx_private_part_fingerprint_match
on private.part_fingerprint_observations(fingerprint_version, package_fingerprint);

create table if not exists private.part_geometry_fingerprints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  part_version_id uuid not null references public.part_versions(id) on delete cascade,
  algorithm_version text not null,
  geometry_fingerprint text not null,
  evidence jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default timezone('utc', now()),
  constraint part_geometry_fingerprints_hash_check
    check (geometry_fingerprint ~ '^[0-9a-f]{64}$'),
  unique (part_version_id, algorithm_version)
);

create index if not exists idx_private_part_geometry_match
on private.part_geometry_fingerprints(algorithm_version, geometry_fingerprint);

create table if not exists private.part_geometry_candidates (
  id uuid primary key default gen_random_uuid(),
  left_part_version_id uuid not null references public.part_versions(id) on delete cascade,
  right_part_version_id uuid not null references public.part_versions(id) on delete cascade,
  algorithm_version text not null,
  score numeric(8, 6) not null,
  status text not null default 'candidate',
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint part_geometry_candidates_distinct_check
    check (left_part_version_id <> right_part_version_id),
  constraint part_geometry_candidates_score_check check (score between 0 and 1),
  constraint part_geometry_candidates_status_check
    check (status in ('candidate', 'confirmed', 'rejected')),
  unique (left_part_version_id, right_part_version_id, algorithm_version)
);

revoke all on private.part_fingerprint_observations,
  private.part_geometry_fingerprints,
  private.part_geometry_candidates
from public, anon, authenticated;
grant all on private.part_fingerprint_observations,
  private.part_geometry_fingerprints,
  private.part_geometry_candidates
to service_role;

create or replace function private.observe_part_version_fingerprint()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.version_state = 'unverified' then
    delete from private.part_fingerprint_observations observation
    where observation.part_version_id = new.id
      and observation.fingerprint_version = 'exact-part-package.v1';
    return new;
  end if;

  insert into private.part_fingerprint_observations (
    organization_id, part_version_id, fingerprint_version, package_fingerprint
  ) values (
    new.organization_id, new.id, 'exact-part-package.v1', new.package_fingerprint
  )
  on conflict (part_version_id, fingerprint_version) do update
  set package_fingerprint = excluded.package_fingerprint,
      observed_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists observe_part_version_fingerprint on public.part_versions;
create trigger observe_part_version_fingerprint
after insert or update of package_fingerprint, version_state on public.part_versions
for each row execute function private.observe_part_version_fingerprint();

insert into private.part_fingerprint_observations (
  organization_id, part_version_id, fingerprint_version, package_fingerprint
)
select
  version.organization_id, version.id, 'exact-part-package.v1', version.package_fingerprint
from public.part_versions version
where version.version_state <> 'unverified'
on conflict (part_version_id, fingerprint_version) do update
set package_fingerprint = excluded.package_fingerprint,
    observed_at = timezone('utc', now());

create or replace function public.api_register_part_geometry_candidate(
  p_part_id uuid,
  p_geometry_fingerprint text,
  p_algorithm_version text,
  p_evidence jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_part public.parts%rowtype;
  v_version public.part_versions%rowtype;
  v_hash text := lower(trim(coalesce(p_geometry_fingerprint, '')));
  v_algorithm_version text := trim(coalesce(p_algorithm_version, ''));
  v_previous_hash text;
  v_candidate_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Geometry candidates may only be registered by the worker.';
  end if;
  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid geometry fingerprint is required.';
  end if;
  if v_algorithm_version = '' then
    raise exception 'A geometry algorithm version is required.';
  end if;

  select part.* into v_part
  from public.parts part
  where part.id = p_part_id;
  select version.* into v_version
  from public.part_versions version
  where version.id = v_part.part_version_id;
  if v_version.id is null or v_version.version_state <> 'complete' then
    return 0;
  end if;

  -- Serialize updates for one version and discoveries for one fingerprint.
  -- The second lock prevents two first-time observations from each missing the
  -- other's uncommitted row.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_algorithm_version || ':version:' || v_version.id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_algorithm_version || ':fingerprint:' || v_hash,
      0
    )
  );

  select fingerprint.geometry_fingerprint into v_previous_hash
  from private.part_geometry_fingerprints fingerprint
  where fingerprint.part_version_id = v_version.id
    and fingerprint.algorithm_version = v_algorithm_version;

  -- A newer observation supersedes candidates produced by the prior
  -- fingerprint for this version and algorithm. Candidates are analytics only;
  -- retaining stale pairs would make aggregate results misleading.
  if v_previous_hash is distinct from v_hash then
    delete from private.part_geometry_candidates candidate
    where candidate.algorithm_version = v_algorithm_version
      and (
        candidate.left_part_version_id = v_version.id
        or candidate.right_part_version_id = v_version.id
      );
  end if;

  insert into private.part_geometry_fingerprints (
    organization_id, part_version_id, algorithm_version,
    geometry_fingerprint, evidence
  ) values (
    v_version.organization_id, v_version.id, v_algorithm_version,
    v_hash, coalesce(p_evidence, '{}'::jsonb)
  )
  on conflict (part_version_id, algorithm_version) do update
  set geometry_fingerprint = excluded.geometry_fingerprint,
      evidence = excluded.evidence,
      observed_at = timezone('utc', now());

  with candidates as (
    insert into private.part_geometry_candidates (
      left_part_version_id, right_part_version_id, algorithm_version,
      score, status, evidence
    )
    select
      least(v_version.id, matched.part_version_id),
      greatest(v_version.id, matched.part_version_id),
      v_algorithm_version, 1, 'candidate',
      pg_catalog.jsonb_build_object(
        'observations', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'part_version_id', v_version.id,
            'evidence', coalesce(p_evidence, '{}'::jsonb)
          ),
          pg_catalog.jsonb_build_object(
            'part_version_id', matched.part_version_id,
            'evidence', matched.evidence
          )
        )
      )
    from private.part_geometry_fingerprints matched
    where matched.part_version_id <> v_version.id
      and matched.geometry_fingerprint = v_hash
      and matched.algorithm_version = v_algorithm_version
    on conflict (left_part_version_id, right_part_version_id, algorithm_version)
      do nothing
    returning id
  )
  select count(*)::integer into v_candidate_count from candidates;

  return v_candidate_count;
end;
$$;

revoke all on function public.api_register_part_geometry_candidate(uuid, text, text, jsonb)
from public, anon, authenticated;
grant execute on function public.api_register_part_geometry_candidate(uuid, text, text, jsonb)
to service_role;

revoke all on function private.observe_part_version_fingerprint()
from public, anon, authenticated;
