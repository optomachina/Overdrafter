-- OVD-348 / OVD-349
-- Add organization-scoped technical identities and exact package versions while
-- retaining existing jobs/parts as lightweight placements. Cross-organization
-- observations are private analytics only and have no authenticated API/grants.
--
-- Rollback: stop the prepare/finalize intake callers, drop the assignment
-- trigger/functions, drop the nullable parts.part_version_id column, then drop
-- private observations/candidates and public version/identity tables. Existing
-- jobs, files, parts, extractions, requirements, and quote history are preserved.

do $$
begin
  if not exists (
    select 1 from pg_type
    where typnamespace = 'public'::regnamespace and typname = 'part_version_state'
  ) then
    create type public.part_version_state as enum ('unverified', 'provisional', 'complete');
  end if;
end
$$;

create table if not exists public.canonical_parts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text,
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.organization_file_blobs
add column if not exists trusted_content_sha256 text;
alter table public.job_files
add column if not exists trusted_content_sha256 text;

alter table public.organization_file_blobs
drop constraint if exists organization_file_blobs_trusted_hash_check;
alter table public.organization_file_blobs
add constraint organization_file_blobs_trusted_hash_check
check (trusted_content_sha256 is null or trusted_content_sha256 ~ '^[0-9a-f]{64}$');

alter table public.job_files
drop constraint if exists job_files_trusted_hash_check;
alter table public.job_files
add constraint job_files_trusted_hash_check
check (trusted_content_sha256 is null or trusted_content_sha256 ~ '^[0-9a-f]{64}$');

create index if not exists idx_organization_file_blobs_org_trusted_hash
on public.organization_file_blobs(organization_id, trusted_content_sha256)
where trusted_content_sha256 is not null;

create index if not exists idx_canonical_parts_organization
on public.canonical_parts(organization_id, created_at desc);

create table if not exists public.part_versions (
  id uuid primary key default gen_random_uuid(),
  canonical_part_id uuid not null references public.canonical_parts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_state public.part_version_state not null,
  package_fingerprint text not null,
  cad_content_sha256 text,
  drawing_content_sha256 text,
  cad_blob_id uuid references public.organization_file_blobs(id) on delete restrict,
  drawing_blob_id uuid references public.organization_file_blobs(id) on delete restrict,
  source_part_id uuid,
  geometry_fingerprint text,
  geometry_fingerprint_version text,
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint part_versions_package_fingerprint_check check (package_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint part_versions_cad_hash_check check (cad_content_sha256 is null or cad_content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint part_versions_drawing_hash_check check (drawing_content_sha256 is null or drawing_content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint part_versions_state_check check (
    (version_state = 'complete' and cad_content_sha256 is not null)
    or (version_state = 'provisional' and cad_content_sha256 is null and drawing_content_sha256 is not null)
    or (version_state = 'unverified' and cad_content_sha256 is null and drawing_content_sha256 is null)
  ),
  unique (organization_id, package_fingerprint)
);

create index if not exists idx_part_versions_canonical
on public.part_versions(canonical_part_id, created_at desc);
create index if not exists idx_part_versions_org_cad
on public.part_versions(organization_id, cad_content_sha256)
where cad_content_sha256 is not null;

alter table public.parts
add column if not exists part_version_id uuid references public.part_versions(id) on delete restrict;

alter table public.part_versions
drop constraint if exists part_versions_source_part_id_fkey;
alter table public.part_versions
add constraint part_versions_source_part_id_fkey
foreign key (source_part_id) references public.parts(id) on delete set null;

create index if not exists idx_parts_part_version
on public.parts(part_version_id);

-- Multiple placements can reference one organization-owned blob. The blob
-- table remains the storage identity; job_files is now a placement reference.
alter table public.job_files
drop constraint if exists job_files_storage_path_key;
create index if not exists idx_job_files_storage_object
on public.job_files(storage_bucket, storage_path);

-- A preview object belongs to the immutable package and may be projected onto
-- multiple accessible placements. Keep placement/view uniqueness while allowing
-- those rows to reference the same organization-owned storage object.
alter table public.cad_preview_assets
drop constraint if exists cad_preview_assets_storage_bucket_storage_path_key;
create index if not exists idx_cad_preview_assets_storage_object
on public.cad_preview_assets(storage_bucket, storage_path);

alter table public.canonical_parts enable row level security;
alter table public.part_versions enable row level security;

drop policy if exists "canonical_parts_select_organization" on public.canonical_parts;
create policy "canonical_parts_select_organization"
on public.canonical_parts for select to authenticated
using (
  exists (
    select 1
    from public.part_versions version
    join public.parts placement on placement.part_version_id = version.id
    where version.canonical_part_id = canonical_parts.id
      and public.user_can_access_job(placement.job_id)
  )
);

drop policy if exists "part_versions_select_organization" on public.part_versions;
create policy "part_versions_select_organization"
on public.part_versions for select to authenticated
using (
  exists (
    select 1
    from public.parts placement
    where placement.part_version_id = part_versions.id
      and public.user_can_access_job(placement.job_id)
  )
);

revoke all on public.canonical_parts, public.part_versions from public, anon, authenticated;
grant select on public.canonical_parts, public.part_versions to authenticated;
grant all on public.canonical_parts, public.part_versions to service_role;

create table if not exists private.part_fingerprint_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  part_version_id uuid not null references public.part_versions(id) on delete cascade,
  fingerprint_version text not null,
  package_fingerprint text not null,
  observed_at timestamptz not null default timezone('utc', now()),
  unique (part_version_id, fingerprint_version)
);

create index if not exists idx_private_part_fingerprint_match
on private.part_fingerprint_observations(fingerprint_version, package_fingerprint);

create table if not exists private.part_geometry_candidates (
  id uuid primary key default gen_random_uuid(),
  left_part_version_id uuid not null references public.part_versions(id) on delete cascade,
  right_part_version_id uuid not null references public.part_versions(id) on delete cascade,
  algorithm_version text not null,
  score numeric(8, 6) not null,
  status text not null default 'candidate',
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint part_geometry_candidates_distinct_check check (left_part_version_id <> right_part_version_id),
  constraint part_geometry_candidates_score_check check (score between 0 and 1),
  constraint part_geometry_candidates_status_check check (status in ('candidate', 'confirmed', 'rejected')),
  unique (left_part_version_id, right_part_version_id, algorithm_version)
);

revoke all on private.part_fingerprint_observations, private.part_geometry_candidates
from public, anon, authenticated;
grant all on private.part_fingerprint_observations, private.part_geometry_candidates
to service_role;

create or replace function private.part_package_fingerprint(
  p_cad_content_sha256 text,
  p_drawing_content_sha256 text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, extensions
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'schema', 'exact-part-package.v1',
          'cad', nullif(lower(trim(coalesce(p_cad_content_sha256, ''))), ''),
          'drawing', nullif(lower(trim(coalesce(p_drawing_content_sha256, ''))), '')
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function private.observe_part_version_fingerprint()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.version_state = 'unverified' then
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
after insert or update of package_fingerprint on public.part_versions
for each row execute function private.observe_part_version_fingerprint();

create or replace function private.assign_canonical_part_version(
  p_part_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_part public.parts%rowtype;
  v_cad public.job_files%rowtype;
  v_drawing public.job_files%rowtype;
  v_identity_id uuid;
  v_version_id uuid;
  v_previous_version_id uuid;
  v_previous_identity_id uuid;
  v_fingerprint text;
  v_state public.part_version_state;
begin
  select part.* into v_part
  from public.parts part
  where part.id = p_part_id
  for update;

  if v_part.id is null then
    return null;
  end if;
  v_previous_version_id := v_part.part_version_id;

  select file.* into v_cad from public.job_files file where file.id = v_part.cad_file_id;
  select file.* into v_drawing from public.job_files file where file.id = v_part.drawing_file_id;

  if v_cad.id is null and v_drawing.id is null then
    return null;
  end if;

  if (v_cad.id is not null and v_cad.trusted_content_sha256 is null)
    or (v_drawing.id is not null and v_drawing.trusted_content_sha256 is null) then
    v_fingerprint := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to('unverified:' || v_part.id::text, 'UTF8'), 'sha256'),
      'hex'
    );
  else
    v_fingerprint := private.part_package_fingerprint(
      v_cad.trusted_content_sha256,
      v_drawing.trusted_content_sha256
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('part-version:' || v_part.organization_id::text || ':' || v_fingerprint, 0)
  );

  select version.id into v_version_id
  from public.part_versions version
  where version.organization_id = v_part.organization_id
    and version.package_fingerprint = v_fingerprint;

  if v_version_id is null then
    -- Same trusted CAD hash remains one canonical technical part; a different
    -- drawing becomes a separate version. Drawing-only packages are provisional.
    if v_cad.trusted_content_sha256 is not null then
      select version.canonical_part_id into v_identity_id
      from public.part_versions version
      where version.organization_id = v_part.organization_id
        and version.cad_content_sha256 = lower(v_cad.trusted_content_sha256)
      order by version.created_at asc
      limit 1;
    end if;

    if v_identity_id is null then
      insert into public.canonical_parts (
        organization_id, display_name, created_by
      ) values (
        v_part.organization_id, v_part.name, auth.uid()
      ) returning id into v_identity_id;
    end if;

    v_state := case
      when v_cad.id is not null and v_cad.trusted_content_sha256 is null then 'unverified'
      when v_cad.id is null then 'provisional'
      else 'complete'
    end;
    insert into public.part_versions (
      canonical_part_id, organization_id, version_state, package_fingerprint,
      cad_content_sha256, drawing_content_sha256, cad_blob_id, drawing_blob_id,
      source_part_id, created_by
    ) values (
      v_identity_id, v_part.organization_id, v_state, v_fingerprint,
      nullif(lower(v_cad.trusted_content_sha256), ''), nullif(lower(v_drawing.trusted_content_sha256), ''),
      v_cad.blob_id, v_drawing.blob_id, v_part.id, auth.uid()
    )
    on conflict (organization_id, package_fingerprint) do update
    set updated_at = timezone('utc', now())
    returning id into v_version_id;
  end if;

  update public.parts set part_version_id = v_version_id where id = v_part.id;
  update public.part_versions
  set source_part_id = coalesce(source_part_id, v_part.id),
      updated_at = timezone('utc', now())
  where id = v_version_id;

  -- Hashes arrive independently. Remove the temporary per-placement version
  -- after the trusted package has converged so it cannot become orphaned state.
  if v_previous_version_id is not null
    and v_previous_version_id is distinct from v_version_id then
    select version.canonical_part_id into v_previous_identity_id
    from public.part_versions version
    where version.id = v_previous_version_id
      and version.version_state = 'unverified';

    delete from public.part_versions version
    where version.id = v_previous_version_id
      and version.version_state = 'unverified'
      and not exists (
        select 1 from public.parts placement
        where placement.part_version_id = version.id
      );

    if v_previous_identity_id is not null then
      delete from public.canonical_parts identity
      where identity.id = v_previous_identity_id
        and not exists (
          select 1 from public.part_versions version
          where version.canonical_part_id = identity.id
        );
    end if;
  end if;
  return v_version_id;
end;
$$;

create or replace function public.api_register_trusted_file_hash(
  p_job_file_id uuid,
  p_content_sha256 text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_file public.job_files%rowtype;
  v_hash text := lower(trim(coalesce(p_content_sha256, '')));
  v_part_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Trusted file hashes may only be registered by the worker.';
  end if;
  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid SHA-256 hash is required.';
  end if;

  select file.* into v_file
  from public.job_files file
  where file.id = p_job_file_id
  for update;
  if v_file.id is null then
    raise exception 'Job file % not found.', p_job_file_id;
  end if;

  update public.job_files
  set trusted_content_sha256 = v_hash
  where id = v_file.id
    or (v_file.blob_id is not null and blob_id = v_file.blob_id);
  update public.organization_file_blobs
  set trusted_content_sha256 = v_hash
  where id = v_file.blob_id;

  for v_part_id in
    select distinct part.id
    from public.parts part
    join public.job_files file
      on file.id = part.cad_file_id or file.id = part.drawing_file_id
    where file.id = v_file.id
      or (v_file.blob_id is not null and file.blob_id = v_file.blob_id)
  loop
    perform private.assign_canonical_part_version(v_part_id);
  end loop;
  return v_file.id;
end;
$$;

revoke all on function public.api_register_trusted_file_hash(uuid, text)
from public, anon, authenticated;
grant execute on function public.api_register_trusted_file_hash(uuid, text)
to service_role;

create or replace function public.api_resolve_trusted_part_intake(
  p_part_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_part public.parts%rowtype;
  v_version public.part_versions%rowtype;
  v_source_part public.parts%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Trusted part intake may only be resolved by the worker.';
  end if;

  select part.* into v_part
  from public.parts part
  where part.id = p_part_id
  for update;
  if v_part.id is null then
    raise exception 'Part % not found.', p_part_id;
  end if;

  select version.* into v_version
  from public.part_versions version
  where version.id = private.assign_canonical_part_version(v_part.id);

  if v_version.id is null or v_version.version_state <> 'complete' then
    return pg_catalog.jsonb_build_object(
      'result', 'pending_verification',
      'partId', v_part.id
    );
  end if;

  select part.* into v_source_part
  from public.parts part
  where part.id = v_version.source_part_id;

  return pg_catalog.jsonb_build_object(
    'result', case
      when v_source_part.id is not null and v_source_part.id <> v_part.id
        then 'existing_version'
      else 'new_version'
    end,
    'partId', v_part.id,
    'partVersionId', v_version.id,
    'sourcePartId', v_source_part.id
  );
end;
$$;

revoke all on function public.api_resolve_trusted_part_intake(uuid)
from public, anon, authenticated;
grant execute on function public.api_resolve_trusted_part_intake(uuid)
to service_role;

create or replace function public.api_reuse_trusted_part_version_artifacts(
  p_target_part_id uuid,
  p_source_part_id uuid,
  p_part_version_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_target public.parts%rowtype;
  v_source public.parts%rowtype;
  v_version public.part_versions%rowtype;
  v_target_cad public.job_files%rowtype;
  v_target_drawing public.job_files%rowtype;
  v_source_cad public.job_files%rowtype;
  v_source_drawing public.job_files%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Trusted part reuse may only be completed by the worker.';
  end if;

  select part.* into v_target from public.parts part where part.id = p_target_part_id for update;
  select part.* into v_source from public.parts part where part.id = p_source_part_id;
  select version.* into v_version from public.part_versions version where version.id = p_part_version_id;

  if v_target.id is null or v_source.id is null or v_version.id is null
    or v_target.id = v_source.id
    or v_target.organization_id <> v_source.organization_id
    or v_target.part_version_id <> v_version.id
    or v_source.part_version_id <> v_version.id
    or v_version.version_state <> 'complete' then
    raise exception 'The trusted part reuse lineage is invalid.';
  end if;

  select file.* into v_target_cad from public.job_files file where file.id = v_target.cad_file_id;
  select file.* into v_target_drawing from public.job_files file where file.id = v_target.drawing_file_id;
  select file.* into v_source_cad from public.job_files file where file.id = v_source.cad_file_id;
  select file.* into v_source_drawing from public.job_files file where file.id = v_source.drawing_file_id;

  if v_target_cad.trusted_content_sha256 is distinct from v_source_cad.trusted_content_sha256
    or v_target_drawing.trusted_content_sha256 is distinct from v_source_drawing.trusted_content_sha256 then
    raise exception 'The trusted part package no longer matches its source version.';
  end if;

  -- An identical upload can finish hashing while the source placement is still
  -- extracting. Wait for that task to publish all extraction/preview artifacts
  -- instead of duplicating work or copying a partially written projection.
  if not exists (
      select 1 from public.drawing_extractions extraction
      where extraction.part_id = v_source.id
    ) or exists (
      select 1 from public.work_queue queue
      where queue.part_id = v_source.id
        and queue.task_type = 'extract_part'
        and queue.status in ('queued', 'running')
    ) then
    return pg_catalog.jsonb_build_object(
      'result', 'existing_version_pending',
      'partId', v_target.id,
      'partVersionId', v_version.id,
      'sourcePartId', v_source.id,
      'artifactsReady', false
    );
  end if;

  insert into public.drawing_extractions (
    part_id, organization_id, extractor_version, extraction, confidence,
    warnings, evidence, status, created_at, updated_at
  )
  select
    v_target.id, extraction.organization_id, extraction.extractor_version,
    extraction.extraction, extraction.confidence, extraction.warnings,
    extraction.evidence, extraction.status, extraction.created_at, extraction.updated_at
  from public.drawing_extractions extraction
  where extraction.part_id = v_source.id
  on conflict (part_id) do nothing;

  insert into public.drawing_preview_assets (
    part_id, organization_id, page_number, kind, storage_bucket, storage_path,
    width, height, created_at
  )
  select
    v_target.id, asset.organization_id, asset.page_number, asset.kind,
    asset.storage_bucket, asset.storage_path, asset.width, asset.height, asset.created_at
  from public.drawing_preview_assets asset
  where asset.part_id = v_source.id
  on conflict (part_id, page_number, kind) do nothing;

  insert into public.cad_preview_assets (
    part_id, organization_id, source_cad_file_id, source_content_sha256,
    display_style, view_orientation, renderer_version, storage_bucket,
    storage_path, mime_type, width, height, generated_at, created_at, updated_at
  )
  select
    v_target.id, asset.organization_id, v_target.cad_file_id, asset.source_content_sha256,
    asset.display_style, asset.view_orientation, asset.renderer_version, asset.storage_bucket,
    asset.storage_path, asset.mime_type, asset.width, asset.height,
    asset.generated_at, asset.created_at, asset.updated_at
  from public.cad_preview_assets asset
  where asset.part_id = v_source.id
    and v_target.cad_file_id is not null
  on conflict (part_id, display_style, view_orientation) do nothing;

  perform public.log_audit_event(
    v_target.organization_id,
    'part.exact_version_reused',
    pg_catalog.jsonb_build_object(
      'jobId', v_target.job_id,
      'partId', v_target.id,
      'partVersionId', v_version.id
    ),
    v_target.job_id,
    null
  );

  return pg_catalog.jsonb_build_object(
    'result', 'existing_version',
    'partId', v_target.id,
    'partVersionId', v_version.id,
    'sourcePartId', v_source.id,
    'artifactsReady', true,
    'artifactsReused', true
  );
end;
$$;

revoke all on function public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid)
to service_role;

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
  v_candidate_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Geometry candidates may only be registered by the worker.';
  end if;
  if lower(trim(coalesce(p_geometry_fingerprint, ''))) !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid geometry fingerprint is required.';
  end if;
  if length(trim(coalesce(p_algorithm_version, ''))) = 0 then
    raise exception 'A geometry algorithm version is required.';
  end if;

  select part.* into v_part from public.parts part where part.id = p_part_id;
  select version.* into v_version
  from public.part_versions version
  where version.id = v_part.part_version_id;
  if v_version.id is null or v_version.version_state <> 'complete' then
    return 0;
  end if;

  update public.part_versions
  set geometry_fingerprint = lower(trim(p_geometry_fingerprint)),
      geometry_fingerprint_version = trim(p_algorithm_version),
      updated_at = timezone('utc', now())
  where id = v_version.id;

  with candidates as (
    insert into private.part_geometry_candidates (
      left_part_version_id, right_part_version_id, algorithm_version,
      score, status, evidence
    )
    select
      least(v_version.id, matched.id), greatest(v_version.id, matched.id),
      trim(p_algorithm_version), 1, 'candidate',
      coalesce(p_evidence, '{}'::jsonb)
    from public.part_versions matched
    where matched.id <> v_version.id
      and matched.geometry_fingerprint = lower(trim(p_geometry_fingerprint))
      and matched.geometry_fingerprint_version = trim(p_algorithm_version)
    on conflict (left_part_version_id, right_part_version_id, algorithm_version) do nothing
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

create or replace function private.assign_canonical_part_version_trigger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform private.assign_canonical_part_version(new.id);
  return new;
end;
$$;

drop trigger if exists assign_canonical_part_version on public.parts;
create trigger assign_canonical_part_version
after insert or update of cad_file_id, drawing_file_id on public.parts
for each row execute function private.assign_canonical_part_version_trigger();

-- Additive backfill: every existing part gains a version, but no job, file,
-- extraction, reviewed requirement, or quote record is deleted or merged.
do $$
declare
  v_part record;
begin
  for v_part in select id from public.parts where part_version_id is null loop
    perform private.assign_canonical_part_version(v_part.id);
  end loop;
end
$$;

create or replace function public.api_prepare_part_intake(
  p_cad_content_sha256 text,
  p_drawing_content_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_organization_id uuid;
  v_cad_hash text := nullif(lower(trim(coalesce(p_cad_content_sha256, ''))), '');
  v_drawing_hash text := nullif(lower(trim(coalesce(p_drawing_content_sha256, ''))), '');
  v_fingerprint text;
  v_version public.part_versions%rowtype;
  v_existing_identity_id uuid;
begin
  perform public.require_verified_auth();
  v_organization_id := public.current_user_home_organization_id();
  if v_organization_id is null then
    raise exception 'A home workspace is still being prepared for this account.';
  end if;
  if v_cad_hash is null and v_drawing_hash is null then
    raise exception 'At least one file hash is required.';
  end if;

  v_fingerprint := private.part_package_fingerprint(v_cad_hash, v_drawing_hash);
  select version.* into v_version
  from public.part_versions version
  join public.parts source_part on source_part.id = version.source_part_id
  where version.organization_id = v_organization_id
    and version.package_fingerprint = v_fingerprint
    and version.version_state = 'complete'
    and public.user_can_access_job(source_part.job_id);

  if v_cad_hash is not null then
    select version.canonical_part_id into v_existing_identity_id
    from public.part_versions version
    join public.parts source_part on source_part.id = version.source_part_id
    where version.organization_id = v_organization_id
      and version.cad_content_sha256 = v_cad_hash
      and public.user_can_access_job(source_part.job_id)
    order by version.created_at asc
    limit 1;
  end if;

  return pg_catalog.jsonb_build_object(
    'result', case
      when v_version.id is not null then 'existing_version'
      when v_existing_identity_id is null then 'new_identity'
      else 'new_version'
    end,
    -- Browser digests are hints only. A client never receives the reusable
    -- version id; independently verified worker hashes establish final identity.
    'partVersionId', null
  );
end;
$$;

revoke all on function public.api_prepare_part_intake(text, text)
from public, anon, authenticated, service_role;
grant execute on function public.api_prepare_part_intake(text, text)
to authenticated;

create or replace function public.api_finalize_existing_part_intake(
  p_part_version_id uuid,
  p_title text,
  p_description text default null,
  p_project_id uuid default null,
  p_tags text[] default '{}'::text[],
  p_requested_service_kinds text[] default '{manufacturing_quote}'::text[],
  p_primary_service_kind text default null,
  p_service_notes text default null,
  p_requested_quote_quantities integer[] default '{}'::integer[],
  p_requested_by_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_version public.part_versions%rowtype;
  v_source_part public.parts%rowtype;
  v_source_requirement public.approved_part_requirements%rowtype;
  v_job_id uuid;
  v_part_id uuid;
  v_cad_file_id uuid;
  v_drawing_file_id uuid;
begin
  perform public.require_verified_auth();

  select version.* into v_version
  from public.part_versions version
  where version.id = p_part_version_id;
  if v_version.id is null
    or v_version.version_state <> 'complete'
    or not public.user_can_access_org(v_version.organization_id) then
    -- Exact same response for missing, inaccessible, and cross-org matches.
    raise exception 'Part version not found.';
  end if;

  select part.* into v_source_part
  from public.parts part
  where part.id = v_version.source_part_id;
  if v_source_part.id is null or not public.user_can_access_job(v_source_part.job_id) then
    raise exception 'Part version not found.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('part-placement:' || auth.uid()::text || ':' || v_version.id::text, 0)
  );

  v_job_id := public.api_create_client_draft(
    p_title, p_description, p_project_id, p_tags,
    p_requested_service_kinds, p_primary_service_kind, p_service_notes,
    p_requested_quote_quantities, p_requested_by_date
  );

  if v_version.cad_blob_id is not null then
    insert into public.job_files (
      job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
      storage_bucket, storage_path, original_name, normalized_name, file_kind,
      mime_type, size_bytes, matched_part_key
    )
    select
      v_job_id, v_version.organization_id, auth.uid(), blob.id, blob.content_sha256,
      blob.trusted_content_sha256,
      blob.storage_bucket, blob.storage_path,
      coalesce(source_file.original_name, p_title || '.step'),
      public.normalize_file_basename(coalesce(source_file.original_name, p_title || '.step')),
      'cad', blob.mime_type, blob.size_bytes, public.normalize_file_basename(p_title)
    from public.organization_file_blobs blob
    left join public.job_files source_file on source_file.id = v_source_part.cad_file_id
    where blob.id = v_version.cad_blob_id
    returning id into v_cad_file_id;
  end if;

  if v_version.drawing_blob_id is not null then
    insert into public.job_files (
      job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
      storage_bucket, storage_path, original_name, normalized_name, file_kind,
      mime_type, size_bytes, matched_part_key
    )
    select
      v_job_id, v_version.organization_id, auth.uid(), blob.id, blob.content_sha256,
      blob.trusted_content_sha256,
      blob.storage_bucket, blob.storage_path,
      coalesce(source_file.original_name, p_title || '.pdf'),
      public.normalize_file_basename(coalesce(source_file.original_name, p_title || '.pdf')),
      'drawing', blob.mime_type, blob.size_bytes, public.normalize_file_basename(p_title)
    from public.organization_file_blobs blob
    left join public.job_files source_file on source_file.id = v_source_part.drawing_file_id
    where blob.id = v_version.drawing_blob_id
    returning id into v_drawing_file_id;
  end if;

  insert into public.parts (
    job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id,
    quantity, part_version_id
  ) values (
    v_job_id, v_version.organization_id, p_title, public.normalize_file_basename(p_title),
    v_cad_file_id, v_drawing_file_id,
    coalesce(p_requested_quote_quantities[1], v_source_part.quantity, 1), v_version.id
  ) returning id into v_part_id;

  select requirement.* into v_source_requirement
  from public.approved_part_requirements requirement
  where requirement.part_id = v_source_part.id;

  if v_source_requirement.id is not null then
    insert into public.approved_part_requirements (
      part_id, organization_id, approved_by, description, part_number, revision,
      material, finish, tightest_tolerance_inch, quantity, quote_quantities,
      requested_by_date, applicable_vendors, spec_snapshot, approved_at
    ) values (
      v_part_id, v_version.organization_id, auth.uid(),
      v_source_requirement.description, v_source_requirement.part_number,
      v_source_requirement.revision, v_source_requirement.material,
      v_source_requirement.finish, v_source_requirement.tightest_tolerance_inch,
      coalesce(p_requested_quote_quantities[1], v_source_requirement.quantity),
      case when coalesce(array_length(p_requested_quote_quantities, 1), 0) > 0
        then public.normalize_positive_integer_array(p_requested_quote_quantities, v_source_requirement.quantity)
        else v_source_requirement.quote_quantities end,
      coalesce(p_requested_by_date, v_source_requirement.requested_by_date),
      v_source_requirement.applicable_vendors,
      v_source_requirement.spec_snapshot,
      timezone('utc', now())
    );
  end if;

  -- Technical artifacts belong to the immutable version. Placement-scoped rows
  -- remain compatibility projections until reads move directly to part_versions.
  insert into public.drawing_extractions (
    part_id, organization_id, extractor_version, extraction, confidence,
    warnings, evidence, status, created_at, updated_at
  )
  select
    v_part_id, extraction.organization_id, extraction.extractor_version,
    extraction.extraction, extraction.confidence, extraction.warnings,
    extraction.evidence, extraction.status, extraction.created_at, extraction.updated_at
  from public.drawing_extractions extraction
  where extraction.part_id = v_source_part.id
  on conflict (part_id) do nothing;

  insert into public.drawing_preview_assets (
    part_id, organization_id, page_number, kind, storage_bucket, storage_path,
    width, height, created_at
  )
  select
    v_part_id, asset.organization_id, asset.page_number, asset.kind,
    asset.storage_bucket, asset.storage_path, asset.width, asset.height, asset.created_at
  from public.drawing_preview_assets asset
  where asset.part_id = v_source_part.id
  on conflict (part_id, page_number, kind) do nothing;

  insert into public.cad_preview_assets (
    part_id, organization_id, source_cad_file_id, source_content_sha256,
    display_style, view_orientation, renderer_version, storage_bucket,
    storage_path, mime_type, width, height, generated_at, created_at, updated_at
  )
  select
    v_part_id, asset.organization_id, v_cad_file_id, asset.source_content_sha256,
    asset.display_style, asset.view_orientation, asset.renderer_version,
    asset.storage_bucket, asset.storage_path, asset.mime_type, asset.width,
    asset.height, asset.generated_at, asset.created_at, asset.updated_at
  from public.cad_preview_assets asset
  where asset.part_id = v_source_part.id
    and v_cad_file_id is not null
  on conflict (part_id, display_style, view_orientation) do nothing;

  perform public.log_audit_event(
    v_version.organization_id,
    'part.exact_version_reused',
    pg_catalog.jsonb_build_object(
      'jobId', v_job_id,
      'partId', v_part_id,
      'partVersionId', v_version.id
    ),
    v_job_id,
    null
  );

  return pg_catalog.jsonb_build_object(
    'result', 'existing_version',
    'jobId', v_job_id,
    'partId', v_part_id,
    'partVersionId', v_version.id
  );
end;
$$;

revoke all on function public.api_finalize_existing_part_intake(
  uuid, text, text, uuid, text[], text[], text, text, integer[], date
) from public, anon, authenticated, service_role;
grant execute on function public.api_finalize_existing_part_intake(
  uuid, text, text, uuid, text[], text[], text, text, integer[], date
) to authenticated;

-- Reused versions already have technical extraction/preview data. New versions
-- still queue one extraction per placement as before; exact reuse does not.
create or replace function public.api_request_extraction(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_count integer := 0;
begin
  perform public.require_verified_auth();

  select * into v_job from public.jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;
  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  perform public.api_reconcile_job_parts(p_job_id);

  with enqueued as (
    insert into public.work_queue (
      organization_id, job_id, part_id, task_type, payload
    )
    select
      v_job.organization_id, p_job_id, part.id, 'extract_part',
      jsonb_build_object('partId', part.id, 'jobId', p_job_id)
    from public.parts part
    where part.job_id = p_job_id
      and not exists (
        select 1 from public.drawing_extractions placement_extraction
        where placement_extraction.part_id = part.id
      )
      and not exists (
        select 1 from public.work_queue queue
        where queue.part_id = part.id
          and queue.task_type = 'extract_part'
          and queue.status in ('queued', 'running')
      )
    returning id
  )
  select count(*)::integer into v_count from enqueued;

  update public.jobs
  set status = case when v_count > 0 then 'extracting' else status end
  where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.extraction_requested',
    jsonb_build_object('jobId', p_job_id, 'tasksQueued', v_count),
    p_job_id,
    null
  );
  return v_count;
end;
$$;

-- These helpers run only behind worker RPCs or database triggers. Remove the
-- default PUBLIC execute privilege so they cannot become an accidental API.
revoke all on function private.part_package_fingerprint(text, text)
from public, anon, authenticated;
revoke all on function private.observe_part_version_fingerprint()
from public, anon, authenticated;
revoke all on function private.assign_canonical_part_version(uuid)
from public, anon, authenticated;
revoke all on function private.assign_canonical_part_version_trigger()
from public, anon, authenticated;
