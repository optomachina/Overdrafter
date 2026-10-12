-- OVD-601: reject empty job-file uploads at the server boundary.
--
-- api_prepare_job_file_upload and api_finalize_job_file_upload are restated
-- byte-for-byte from 20260815093000_enforce_founding_beta_file_boundaries.sql
-- with one added guard each, placed directly after the SHA-256 format check:
-- a null, zero or negative p_size_bytes, or the SHA-256 of empty content,
-- raises P0001 file_upload_empty before any job, blob or storage lookup, so a
-- denial writes no job_files or organization_file_blobs rows.
--
-- Contract note: p_size_bytes keeps its "default null" signature, but a null
-- size is now rejected. The only application caller (uploads-api.ts) always
-- sends file.size.
--
-- api_attach_job_file and every other statement of 20260815093000 are not
-- touched. The revoke/grant statements for the two functions are restated
-- unchanged.
--
-- Rollback: re-run the two create or replace statements from
-- 20260815093000_enforce_founding_beta_file_boundaries.sql. No data changes.

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

  if v_normalized_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid SHA-256 content hash is required to prepare a file upload.';
  end if;

  if p_size_bytes is null
     or p_size_bytes <= 0
     or v_normalized_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' then
    raise exception using
      errcode = 'P0001', -- NOSONAR: stable customer-safe PostgreSQL error contract
      message = 'file_upload_empty';
  end if;

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id; -- NOSONAR: preserved RPC error contract
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to attach files to job %', p_job_id; -- NOSONAR: preserved RPC error contract
  end if;

  perform private.require_current_founding_beta_file_access(
    v_job.organization_id,
    'prepare'
  );
  perform pg_advisory_xact_lock(
    hashtextextended(v_job.organization_id::text || ':' || v_normalized_hash, 0)
  );

  if exists (
    select 1
    from public.job_files file
    where file.job_id = p_job_id
      and lower(coalesce(file.content_sha256, '')) = v_normalized_hash
  ) then
    return jsonb_build_object('status', 'duplicate_in_job'); -- NOSONAR: stable RPC response field
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
        'fileId', v_file_id, -- NOSONAR: stable audit/response field
        'originalName', p_original_name,
        'kind', p_file_kind,
        'dedupe', 'reused'
      ),
      p_job_id,
      null
    );

    return jsonb_build_object('status', 'reused', 'fileId', v_file_id);
  end if;

  return jsonb_build_object(
    'status', 'upload_required',
    'storageBucket', 'job-files', -- NOSONAR: canonical bucket contract
    'storagePath', public.build_org_file_blob_storage_path(
      v_job.organization_id,
      v_normalized_hash,
      p_original_name
    )
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
  v_expected_path text;
begin
  perform public.require_verified_auth();

  if v_normalized_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid SHA-256 content hash is required to finalize a file upload.';
  end if;

  if p_size_bytes is null
     or p_size_bytes <= 0
     or v_normalized_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' then
    raise exception using
      errcode = 'P0001', -- NOSONAR: stable customer-safe PostgreSQL error contract
      message = 'file_upload_empty';
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

  perform private.require_current_founding_beta_file_access(
    v_job.organization_id,
    'finalize'
  );

  v_expected_path := public.build_org_file_blob_storage_path(
    v_job.organization_id,
    v_normalized_hash,
    p_original_name
  );

  if p_storage_bucket is distinct from 'job-files'
     or p_storage_path is distinct from v_expected_path then
    raise log 'Founding Beta file finalize denied: reason=canonical_path_mismatch';
    raise exception using
      errcode = 'P0001',
      message = 'file_upload_path_mismatch';
  end if;

  if not exists (
    select 1
    from storage.objects object_row
    where object_row.bucket_id = 'job-files'
      and object_row.name = v_expected_path
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'file_upload_object_missing';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_job.organization_id::text || ':' || v_normalized_hash, 0)
  );

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
    'job-files',
    v_expected_path,
    p_size_bytes,
    p_mime_type
  )
  on conflict (organization_id, content_sha256) do update
    set size_bytes = coalesce(public.organization_file_blobs.size_bytes, excluded.size_bytes),
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

revoke all on function public.api_prepare_job_file_upload(
  uuid, text, public.job_file_kind, text, bigint, text
) from public, anon;
grant execute on function public.api_prepare_job_file_upload(
  uuid, text, public.job_file_kind, text, bigint, text
) to authenticated;

revoke all on function public.api_finalize_job_file_upload(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) from public, anon;
grant execute on function public.api_finalize_job_file_upload(
  uuid, text, text, text, public.job_file_kind, text, bigint, text
) to authenticated;
