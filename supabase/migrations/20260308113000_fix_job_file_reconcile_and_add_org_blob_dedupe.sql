create table if not exists public.organization_file_blobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  content_sha256 text not null,
  storage_bucket text not null default 'job-files',
  storage_path text not null,
  size_bytes bigint,
  mime_type text,
  created_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, content_sha256),
  unique (storage_path)
);

create index if not exists idx_organization_file_blobs_org_hash
on public.organization_file_blobs(organization_id, content_sha256);

alter table public.organization_file_blobs enable row level security;

drop policy if exists "organization_file_blobs_internal_only" on public.organization_file_blobs;
create policy "organization_file_blobs_internal_only"
on public.organization_file_blobs
for select
to authenticated
using (public.is_internal_user(organization_id));

drop policy if exists "organization_file_blobs_manage_internal" on public.organization_file_blobs;
create policy "organization_file_blobs_manage_internal"
on public.organization_file_blobs
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

alter table public.job_files
add column if not exists blob_id uuid references public.organization_file_blobs(id) on delete set null,
add column if not exists content_sha256 text;

create index if not exists idx_job_files_blob_id on public.job_files(blob_id);
create index if not exists idx_job_files_job_hash on public.job_files(job_id, content_sha256);

alter table public.job_files
drop constraint if exists job_files_storage_path_key;

update public.job_files file
set content_sha256 = coalesce(file.content_sha256, md5(file.storage_path)),
    blob_id = coalesce(
      file.blob_id,
      (
        select blob.id
        from public.organization_file_blobs blob
        where blob.organization_id = file.organization_id
          and blob.storage_path = file.storage_path
        limit 1
      )
    )
where file.content_sha256 is null
   or file.blob_id is null;

insert into public.organization_file_blobs (
  organization_id,
  content_sha256,
  storage_bucket,
  storage_path,
  size_bytes,
  mime_type
)
select distinct on (file.organization_id, file.storage_path)
  file.organization_id,
  coalesce(file.content_sha256, md5(file.storage_path)),
  file.storage_bucket,
  file.storage_path,
  file.size_bytes,
  file.mime_type
from public.job_files file
where not exists (
  select 1
  from public.organization_file_blobs blob
  where blob.organization_id = file.organization_id
    and blob.storage_path = file.storage_path
)
order by file.organization_id, file.storage_path, file.created_at asc, file.id asc
on conflict (organization_id, content_sha256) do nothing;

update public.job_files file
set blob_id = blob.id
from public.organization_file_blobs blob
where file.blob_id is null
  and blob.organization_id = file.organization_id
  and blob.storage_path = file.storage_path;

create or replace function public.build_org_file_blob_storage_path(
  p_organization_id uuid,
  p_content_sha256 text,
  p_original_name text
)
returns text
language sql
immutable
set search_path = public
as $$
  select concat(
    'org-sha256/',
    p_organization_id::text,
    '/',
    lower(coalesce(p_content_sha256, '')),
    '/',
    coalesce(
      nullif(
        regexp_replace(lower(coalesce(p_original_name, 'file')), '[^a-z0-9._-]+', '-', 'g'),
        ''
      ),
      'file'
    )
  );
$$;

create or replace function public.job_part_file_set(p_job_id uuid)
returns table (
  normalized_name text,
  cad_file_id uuid,
  drawing_file_id uuid
)
language sql
stable
set search_path = public
as $$
  with normalized_keys as (
    select distinct file.normalized_name
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind in ('cad', 'drawing')
  ),
  latest_cad as (
    select distinct on (file.normalized_name)
      file.normalized_name,
      file.id as cad_file_id
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind = 'cad'
    order by file.normalized_name, file.created_at desc, file.id desc
  ),
  latest_drawing as (
    select distinct on (file.normalized_name)
      file.normalized_name,
      file.id as drawing_file_id
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind = 'drawing'
    order by file.normalized_name, file.created_at desc, file.id desc
  )
  select
    keyset.normalized_name,
    cad.cad_file_id,
    drawing.drawing_file_id
  from normalized_keys keyset
  left join latest_cad cad
    on cad.normalized_name = keyset.normalized_name
  left join latest_drawing drawing
    on drawing.normalized_name = keyset.normalized_name;
$$;

create or replace function public.api_reconcile_job_parts(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_total_parts integer := 0;
  v_matched_pairs integer := 0;
  v_missing_drawings integer := 0;
  v_missing_cad integer := 0;
begin
  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_access_org(v_job.organization_id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  delete from public.parts part
  where part.job_id = p_job_id
    and not exists (
      select 1
      from public.job_part_file_set(p_job_id) fs
      where fs.normalized_name = part.normalized_key
    );

  insert into public.parts (
    job_id,
    organization_id,
    name,
    normalized_key,
    cad_file_id,
    drawing_file_id,
    quantity
  )
  select
    p_job_id,
    v_job.organization_id,
    fs.normalized_name,
    fs.normalized_name,
    fs.cad_file_id,
    fs.drawing_file_id,
    1
  from public.job_part_file_set(p_job_id) fs
  on conflict (job_id, normalized_key) do update
    set cad_file_id = excluded.cad_file_id,
        drawing_file_id = excluded.drawing_file_id,
        updated_at = timezone('utc', now());

  update public.job_files
  set matched_part_key = normalized_name
  where job_id = p_job_id
    and file_kind in ('cad', 'drawing');

  select
    count(*)::integer,
    count(*) filter (where cad_file_id is not null and drawing_file_id is not null)::integer,
    count(*) filter (where cad_file_id is not null and drawing_file_id is null)::integer,
    count(*) filter (where cad_file_id is null and drawing_file_id is not null)::integer
  into
    v_total_parts,
    v_matched_pairs,
    v_missing_drawings,
    v_missing_cad
  from public.job_part_file_set(p_job_id);

  perform public.log_audit_event(
    v_job.organization_id,
    'job.parts_reconciled',
    jsonb_build_object(
      'totalParts', coalesce(v_total_parts, 0),
      'matchedPairs', coalesce(v_matched_pairs, 0),
      'missingDrawings', coalesce(v_missing_drawings, 0),
      'missingCad', coalesce(v_missing_cad, 0)
    ),
    p_job_id,
    null
  );

  return jsonb_build_object(
    'totalParts', coalesce(v_total_parts, 0),
    'matchedPairs', coalesce(v_matched_pairs, 0),
    'missingDrawings', coalesce(v_missing_drawings, 0),
    'missingCad', coalesce(v_missing_cad, 0)
  );
end;
$$;

create or replace function public.api_prepare_job_file_upload(
  p_job_id uuid,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_content_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_blob public.organization_file_blobs%rowtype;
  v_file_id uuid;
  v_normalized_hash text := lower(trim(coalesce(p_content_sha256, '')));
begin
  perform public.require_verified_auth();

  if v_normalized_hash = '' then
    raise exception 'A content hash is required to prepare a file upload.';
  end if;

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to attach files to job %', p_job_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_job.organization_id::text || ':' || v_normalized_hash, 0));

  if exists (
    select 1
    from public.job_files file
    where file.job_id = p_job_id
      and lower(coalesce(file.content_sha256, '')) = v_normalized_hash
  ) then
    return jsonb_build_object('status', 'duplicate_in_job');
  end if;

  select *
  into v_blob
  from public.organization_file_blobs blob
  where blob.organization_id = v_job.organization_id
    and blob.content_sha256 = v_normalized_hash;

  if v_blob.id is not null then
    insert into public.job_files (
      job_id,
      organization_id,
      uploaded_by,
      blob_id,
      content_sha256,
      storage_bucket,
      storage_path,
      original_name,
      normalized_name,
      file_kind,
      mime_type,
      size_bytes
    )
    values (
      p_job_id,
      v_job.organization_id,
      auth.uid(),
      v_blob.id,
      v_normalized_hash,
      v_blob.storage_bucket,
      v_blob.storage_path,
      p_original_name,
      public.normalize_file_basename(p_original_name),
      p_file_kind,
      coalesce(p_mime_type, v_blob.mime_type),
      coalesce(p_size_bytes, v_blob.size_bytes)
    )
    returning id into v_file_id;

    perform public.log_audit_event(
      v_job.organization_id,
      'job.file_attached',
      jsonb_build_object(
        'fileId', v_file_id,
        'originalName', p_original_name,
        'kind', p_file_kind,
        'dedupe', 'reused'
      ),
      p_job_id,
      null
    );

    return jsonb_build_object(
      'status', 'reused',
      'fileId', v_file_id
    );
  end if;

  return jsonb_build_object(
    'status', 'upload_required',
    'storageBucket', 'job-files',
    'storagePath', public.build_org_file_blob_storage_path(v_job.organization_id, v_normalized_hash, p_original_name)
  );
end;
$$;

create or replace function public.api_finalize_job_file_upload(
  p_job_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_content_sha256 text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_blob_id uuid;
  v_file_id uuid;
  v_normalized_hash text := lower(trim(coalesce(p_content_sha256, '')));
  v_storage_bucket text := coalesce(nullif(p_storage_bucket, ''), 'job-files');
begin
  perform public.require_verified_auth();

  if v_normalized_hash = '' then
    raise exception 'A content hash is required to finalize a file upload.';
  end if;

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to attach files to job %', p_job_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_job.organization_id::text || ':' || v_normalized_hash, 0));

  if exists (
    select 1
    from public.job_files file
    where file.job_id = p_job_id
      and lower(coalesce(file.content_sha256, '')) = v_normalized_hash
  ) then
    raise exception 'A matching file is already attached to this job.';
  end if;

  insert into public.organization_file_blobs (
    organization_id,
    content_sha256,
    storage_bucket,
    storage_path,
    size_bytes,
    mime_type
  )
  values (
    v_job.organization_id,
    v_normalized_hash,
    v_storage_bucket,
    p_storage_path,
    p_size_bytes,
    p_mime_type
  )
  on conflict (organization_id, content_sha256) do update
    set storage_bucket = excluded.storage_bucket,
        storage_path = excluded.storage_path,
        size_bytes = coalesce(public.organization_file_blobs.size_bytes, excluded.size_bytes),
        mime_type = coalesce(public.organization_file_blobs.mime_type, excluded.mime_type)
  returning id into v_blob_id;

  insert into public.job_files (
    job_id,
    organization_id,
    uploaded_by,
    blob_id,
    content_sha256,
    storage_bucket,
    storage_path,
    original_name,
    normalized_name,
    file_kind,
    mime_type,
    size_bytes
  )
  select
    p_job_id,
    v_job.organization_id,
    auth.uid(),
    blob.id,
    v_normalized_hash,
    blob.storage_bucket,
    blob.storage_path,
    p_original_name,
    public.normalize_file_basename(p_original_name),
    p_file_kind,
    coalesce(p_mime_type, blob.mime_type),
    coalesce(p_size_bytes, blob.size_bytes)
  from public.organization_file_blobs blob
  where blob.id = v_blob_id
  returning id into v_file_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.file_attached',
    jsonb_build_object(
      'fileId', v_file_id,
      'originalName', p_original_name,
      'kind', p_file_kind,
      'dedupe', 'uploaded'
    ),
    p_job_id,
    null
  );

  return v_file_id;
end;
$$;

grant execute on function public.api_prepare_job_file_upload(uuid, text, public.job_file_kind, text, bigint, text) to authenticated;
grant execute on function public.api_finalize_job_file_upload(uuid, text, text, text, public.job_file_kind, text, bigint, text) to authenticated;

notify pgrst, 'reload schema';

drop policy if exists "job_files_storage_insert" on storage.objects;
create policy "job_files_storage_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'job-files'
  and (
    (
      split_part(name, '/', 1) = 'org-sha256'
      and exists (
        select 1
        from public.jobs job
        where job.organization_id::text = split_part(name, '/', 2)
          and public.user_can_edit_job(job.id)
      )
    )
    or exists (
      select 1
      from public.jobs job
      where job.id::text = split_part(name, '/', 1)
        and public.user_can_edit_job(job.id)
    )
  )
);
