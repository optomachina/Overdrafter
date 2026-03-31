create or replace function public.user_can_destructively_edit_job(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.jobs job
    where job.id = p_job_id
      and (
        job.created_by = auth.uid()
        or exists (
          select 1
          from public.organization_memberships membership
          where membership.organization_id = job.organization_id
            and membership.user_id = auth.uid()
            and membership.role = 'internal_admin'
        )
        or (
          job.project_id is not null
          and public.user_can_edit_project(job.project_id)
        )
        or exists (
          select 1
          from public.project_jobs project_job
          where project_job.job_id = job.id
            and public.user_can_edit_project(project_job.project_id)
        )
      )
  );
$$;

create or replace function public.api_archive_job(
  p_job_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_next_project_id uuid;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_destructively_edit_job(v_job.id) then
    raise exception 'You do not have permission to archive this part.';
  end if;

  select project_job.project_id
  into v_next_project_id
  from public.project_jobs project_job
  join public.projects project_row on project_row.id = project_job.project_id
  where project_job.job_id = v_job.id
    and project_row.archived_at is null
  order by project_job.created_at asc
  limit 1;

  update public.jobs
  set
    archived_at = coalesce(archived_at, timezone('utc', now())),
    project_id = v_next_project_id,
    updated_at = timezone('utc', now())
  where id = v_job.id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.archived',
    jsonb_build_object('jobId', v_job.id),
    v_job.id,
    null
  );

  return v_job.id;
end;
$$;

create or replace function public.api_unarchive_job(
  p_job_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if v_job.archived_at is null then
    raise exception 'Part % is not archived.', p_job_id;
  end if;

  if not public.user_can_destructively_edit_job(v_job.id) then
    raise exception 'You do not have permission to unarchive this part.';
  end if;

  update public.jobs
  set
    archived_at = null,
    updated_at = timezone('utc', now())
  where id = v_job.id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.unarchived',
    jsonb_build_object('jobId', v_job.id),
    v_job.id,
    null
  );

  return v_job.id;
end;
$$;

create or replace function public.api_delete_archived_jobs(
  p_job_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_requested_job_ids uuid[] := coalesce(
    array(
      select distinct requested.job_id
      from unnest(coalesce(p_job_ids, array[]::uuid[])) as requested(job_id)
      where requested.job_id is not null
    ),
    array[]::uuid[]
  );
  v_deletable_job_ids uuid[] := array[]::uuid[];
  v_failure_records jsonb := '[]'::jsonb;
  v_storage_candidates jsonb := '[]'::jsonb;
  v_orphan_blob_ids uuid[] := array[]::uuid[];
  v_job public.jobs%rowtype;
begin
  perform public.require_verified_auth();

  if coalesce(array_length(v_requested_job_ids, 1), 0) = 0 then
    return jsonb_build_object(
      'deletedJobIds', '[]'::jsonb,
      'failures', '[]'::jsonb
    );
  end if;

  select coalesce(array_agg(candidate.id order by candidate.id), array[]::uuid[])
  into v_deletable_job_ids
  from (
    select job.id
    from public.jobs job
    where job.id = any(v_requested_job_ids)
      and job.archived_at is not null
      and public.user_can_destructively_edit_job(job.id)
  ) candidate;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'jobId', requested.job_id,
        'message', 'Part not found, not archived, or you do not have permission to delete it.'
      )
      order by requested.job_id
    ),
    '[]'::jsonb
  )
  into v_failure_records
  from unnest(v_requested_job_ids) as requested(job_id)
  where not exists (
    select 1
    from public.jobs job
    where job.id = requested.job_id
      and job.archived_at is not null
      and public.user_can_destructively_edit_job(job.id)
  );

  if coalesce(array_length(v_deletable_job_ids, 1), 0) = 0 then
    return jsonb_build_object(
      'deletedJobIds', '[]'::jsonb,
      'failures', v_failure_records
    );
  end if;

  select
    coalesce(array_agg(candidate.id order by candidate.id), array[]::uuid[]),
    coalesce(
      jsonb_agg(jsonb_build_object('bucket', candidate.storage_bucket, 'path', candidate.storage_path)),
      '[]'::jsonb
    )
  into v_orphan_blob_ids, v_storage_candidates
  from (
    select distinct blob.id, blob.storage_bucket, blob.storage_path
    from public.organization_file_blobs blob
    join public.job_files file on file.blob_id = blob.id
    where file.job_id = any(v_deletable_job_ids)
      and not exists (
        select 1
        from public.job_files other
        where other.blob_id = blob.id
          and other.job_id <> all(v_deletable_job_ids)
      )
  ) candidate;

  select v_storage_candidates
    || coalesce(
      (
        select jsonb_agg(jsonb_build_object('bucket', candidate.storage_bucket, 'path', candidate.storage_path))
        from (
          select distinct asset.storage_bucket, asset.storage_path
          from public.drawing_preview_assets asset
          join public.parts part on part.id = asset.part_id
          where part.job_id = any(v_deletable_job_ids)
            and not exists (
              select 1
              from public.parts other_part
              join public.drawing_preview_assets other_asset on other_asset.part_id = other_part.id
              where other_asset.storage_bucket = asset.storage_bucket
                and other_asset.storage_path = asset.storage_path
                and other_part.job_id <> all(v_deletable_job_ids)
            )
        ) candidate
      ),
      '[]'::jsonb
    )
    || coalesce(
      (
        select jsonb_agg(jsonb_build_object('bucket', candidate.storage_bucket, 'path', candidate.storage_path))
        from (
          select distinct artifact.storage_bucket, artifact.storage_path
          from public.vendor_quote_artifacts artifact
          join public.vendor_quote_results result on result.id = artifact.vendor_quote_result_id
          join public.parts part on part.id = result.part_id
          where part.job_id = any(v_deletable_job_ids)
        ) candidate
      ),
      '[]'::jsonb
    )
    || coalesce(
      (
        select jsonb_agg(jsonb_build_object('bucket', candidate.storage_bucket, 'path', candidate.storage_path))
        from (
          select distinct file.storage_bucket, file.storage_path
          from public.job_files file
          where file.job_id = any(v_deletable_job_ids)
            and file.blob_id is null
            and not exists (
              select 1
              from public.job_files other
              where other.storage_bucket = file.storage_bucket
                and other.storage_path = file.storage_path
                and other.job_id <> all(v_deletable_job_ids)
            )
            and not exists (
              select 1
              from public.organization_file_blobs blob
              where blob.storage_bucket = file.storage_bucket
                and blob.storage_path = file.storage_path
                and blob.id <> all(v_orphan_blob_ids)
            )
        ) candidate
      ),
      '[]'::jsonb
    )
  into v_storage_candidates;

  for v_job in
    select *
    from public.jobs job
    where id = any(v_deletable_job_ids)
  loop
    perform public.log_audit_event(
      v_job.organization_id,
      'job.deleted',
      jsonb_build_object(
        'jobId', v_job.id,
        'archivedAt', v_job.archived_at,
        'deleteScope', case when coalesce(array_length(v_deletable_job_ids, 1), 0) > 1 then 'bulk' else 'single' end
      ),
      v_job.id,
      null
    );
  end loop;

  -- Published package options can still reference vendor_quote_results with
  -- ON DELETE RESTRICT, so clear them before the job/quote cascade runs.
  delete from public.published_quote_options option_row
  using public.published_quote_packages package_row
  where option_row.package_id = package_row.id
    and package_row.job_id = any(v_deletable_job_ids);

  if jsonb_array_length(v_storage_candidates) > 0 then
    delete from storage.objects object_row
    using (
      select distinct candidate.bucket, candidate.path
      from jsonb_to_recordset(v_storage_candidates) as candidate(bucket text, path text)
    ) candidate
    where object_row.bucket_id = candidate.bucket
      and object_row.name = candidate.path;
  end if;

  delete from public.jobs
  where id = any(v_deletable_job_ids);

  if coalesce(array_length(v_orphan_blob_ids, 1), 0) > 0 then
    delete from public.organization_file_blobs
    where id = any(v_orphan_blob_ids);
  end if;

  return jsonb_build_object(
    'deletedJobIds',
    coalesce(
      (
        select jsonb_agg(deleted_job_id order by deleted_job_id)
        from unnest(v_deletable_job_ids) as deleted_job_id
      ),
      '[]'::jsonb
    ),
    'failures',
    v_failure_records
  );
end;
$$;

create or replace function public.api_delete_archived_job(
  p_job_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_deleted_job_id uuid;
  v_failure_message text;
begin
  v_result := public.api_delete_archived_jobs(array[p_job_id]);

  select failure.value ->> 'message'
  into v_failure_message
  from jsonb_array_elements(coalesce(v_result -> 'failures', '[]'::jsonb)) as failure(value)
  limit 1;

  if v_failure_message is not null then
    raise exception '%', v_failure_message;
  end if;

  select deleted_job_id.value::text::uuid
  into v_deleted_job_id
  from jsonb_array_elements_text(coalesce(v_result -> 'deletedJobIds', '[]'::jsonb)) as deleted_job_id(value)
  limit 1;

  if v_deleted_job_id is null then
    raise exception 'Archived part % could not be deleted.', p_job_id;
  end if;

  return v_deleted_job_id;
end;
$$;

grant execute on function public.api_delete_archived_jobs(uuid[]) to authenticated;
grant execute on function public.api_delete_archived_job(uuid) to authenticated;
