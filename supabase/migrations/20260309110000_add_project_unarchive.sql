create or replace function public.api_unarchive_project(
  p_project_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.projects%rowtype;
  v_timestamp timestamptz := timezone('utc', now());
begin
  perform public.require_verified_auth();

  select *
  into v_project
  from public.projects
  where id = p_project_id;

  if v_project.id is null then
    raise exception 'Project % not found.', p_project_id;
  end if;

  if not public.user_can_edit_project(v_project.id) then
    raise exception 'You do not have permission to restore this project.';
  end if;

  if v_project.archived_at is null then
    return v_project.id;
  end if;

  update public.projects
  set
    archived_at = null,
    updated_at = v_timestamp
  where id = v_project.id;

  with project_jobs as (
    select distinct project_job.job_id
    from public.project_jobs project_job
    where project_job.project_id = v_project.id
  )
  update public.jobs job_row
  set
    archived_at = null,
    project_id = coalesce(job_row.project_id, v_project.id),
    updated_at = v_timestamp
  from project_jobs
  where job_row.id = project_jobs.job_id
    and job_row.archived_at is not null;

  perform public.log_audit_event(
    v_project.organization_id,
    'project.unarchived',
    jsonb_build_object('projectId', v_project.id, 'name', v_project.name),
    null,
    null
  );

  return v_project.id;
end;
$$;

grant execute on function public.api_unarchive_project(uuid) to authenticated;
