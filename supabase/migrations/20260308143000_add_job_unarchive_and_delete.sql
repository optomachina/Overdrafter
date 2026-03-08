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

  if not public.user_can_edit_job(v_job.id) then
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

create or replace function public.api_delete_archived_job(
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
    raise exception 'Only archived parts can be deleted.';
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to delete this archived part.';
  end if;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.deleted',
    jsonb_build_object('jobId', v_job.id, 'archivedAt', v_job.archived_at),
    v_job.id,
    null
  );

  delete from public.jobs
  where id = v_job.id;

  return v_job.id;
end;
$$;

grant execute on function public.api_unarchive_job(uuid) to authenticated;
grant execute on function public.api_delete_archived_job(uuid) to authenticated;
