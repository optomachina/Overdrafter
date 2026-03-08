alter table public.projects
add column if not exists archived_at timestamptz;

alter table public.jobs
add column if not exists archived_at timestamptz;

create index if not exists idx_projects_archived_at on public.projects(archived_at);
create index if not exists idx_jobs_archived_at on public.jobs(archived_at);

create or replace function public.api_update_project(
  p_project_id uuid,
  p_name text,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.projects%rowtype;
  v_name text := trim(coalesce(p_name, ''));
begin
  perform public.require_verified_auth();

  select *
  into v_project
  from public.projects
  where id = p_project_id;

  if v_project.id is null or v_project.archived_at is not null then
    raise exception 'Project % not found', p_project_id;
  end if;

  if not public.user_is_project_owner(v_project.id) then
    raise exception 'You do not have permission to update this project.';
  end if;

  if v_name = '' then
    raise exception 'Project name is required.';
  end if;

  update public.projects
  set
    name = v_name,
    description = nullif(trim(coalesce(p_description, '')), ''),
    updated_at = timezone('utc', now())
  where id = p_project_id;

  perform public.log_audit_event(
    v_project.organization_id,
    'project.updated',
    jsonb_build_object('projectId', v_project.id, 'name', v_name),
    null,
    null
  );

  return v_project.id;
end;
$$;

drop function if exists public.api_create_client_draft(text, text, uuid, text[]);

create or replace function public.api_create_client_draft(
  p_title text,
  p_description text default null,
  p_project_id uuid default null,
  p_tags text[] default '{}'::text[],
  p_requested_quote_quantities integer[] default '{}'::integer[],
  p_requested_by_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text := trim(coalesce(p_title, ''));
  v_project public.projects%rowtype;
  v_organization_id uuid;
  v_job_id uuid;
begin
  perform public.require_verified_auth();

  if v_title = '' then
    raise exception 'Draft title is required.';
  end if;

  if p_project_id is not null then
    select *
    into v_project
    from public.projects
    where id = p_project_id;

    if v_project.id is null or v_project.archived_at is not null then
      raise exception 'Project % not found.', p_project_id;
    end if;

    if not public.user_can_edit_project(v_project.id) then
      raise exception 'You do not have permission to add drafts to this project.';
    end if;

    v_organization_id := v_project.organization_id;
  else
    v_organization_id := public.current_user_home_organization_id();
  end if;

  if v_organization_id is null then
    raise exception 'A home workspace is still being prepared for this account.';
  end if;

  v_job_id := public.api_create_job(
    v_organization_id,
    v_title,
    p_description,
    case when p_project_id is null then 'client_home' else 'shared_project' end,
    p_tags,
    p_requested_quote_quantities,
    p_requested_by_date
  );

  if p_project_id is not null then
    update public.jobs
    set project_id = p_project_id
    where id = v_job_id;

    insert into public.project_jobs (project_id, job_id, created_by)
    values (p_project_id, v_job_id, auth.uid())
    on conflict (project_id, job_id) do nothing;
  end if;

  return v_job_id;
end;
$$;

create or replace function public.api_assign_job_to_project(
  p_job_id uuid,
  p_project_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_project public.projects%rowtype;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if v_job.archived_at is not null then
    raise exception 'Archived parts cannot be added to projects.';
  end if;

  select *
  into v_project
  from public.projects
  where id = p_project_id;

  if v_project.id is null or v_project.archived_at is not null then
    raise exception 'Project % not found.', p_project_id;
  end if;

  if not public.user_can_edit_project(v_project.id) then
    raise exception 'You do not have permission to add parts to this project.';
  end if;

  if v_job.organization_id <> v_project.organization_id then
    raise exception 'Parts can only be moved into projects from the same hidden workspace.';
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to move this part.';
  end if;

  insert into public.project_jobs (project_id, job_id, created_by)
  values (v_project.id, v_job.id, auth.uid())
  on conflict (project_id, job_id) do nothing;

  update public.jobs
  set
    project_id = case
      when project_id is null or project_id = v_project.id then v_project.id
      else project_id
    end,
    updated_at = timezone('utc', now())
  where id = v_job.id;

  perform public.log_audit_event(
    v_project.organization_id,
    'project.job_assigned',
    jsonb_build_object('projectId', v_project.id, 'jobId', v_job.id),
    v_job.id,
    null
  );

  return v_job.id;
end;
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

  if not public.user_can_edit_job(v_job.id) then
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

create or replace function public.api_archive_project(
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

  if v_project.archived_at is not null then
    return v_project.id;
  end if;

  if not public.user_can_edit_project(v_project.id) then
    raise exception 'You do not have permission to archive this project.';
  end if;

  update public.projects
  set
    archived_at = v_timestamp,
    updated_at = v_timestamp
  where id = v_project.id;

  with affected_jobs as (
    select distinct project_job.job_id
    from public.project_jobs project_job
    where project_job.project_id = v_project.id
  ),
  remaining_projects as (
    select
      affected_jobs.job_id,
      (
        select other_project.id
        from public.project_jobs other_membership
        join public.projects other_project on other_project.id = other_membership.project_id
        where other_membership.job_id = affected_jobs.job_id
          and other_membership.project_id <> v_project.id
          and other_project.archived_at is null
        order by other_membership.created_at asc
        limit 1
      ) as next_project_id
    from affected_jobs
  )
  update public.jobs job_row
  set
    archived_at = case
      when remaining_projects.next_project_id is null then coalesce(job_row.archived_at, v_timestamp)
      else job_row.archived_at
    end,
    project_id = remaining_projects.next_project_id,
    updated_at = v_timestamp
  from remaining_projects
  where job_row.id = remaining_projects.job_id;

  perform public.log_audit_event(
    v_project.organization_id,
    'project.archived',
    jsonb_build_object('projectId', v_project.id, 'name', v_project.name),
    null,
    null
  );

  return v_project.id;
end;
$$;

create or replace function public.api_dissolve_project(
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

  if not public.user_is_project_owner(v_project.id) then
    raise exception 'You do not have permission to dissolve this project.';
  end if;

  with deleted_memberships as (
    delete from public.project_jobs project_job
    where project_job.project_id = v_project.id
    returning project_job.job_id
  ),
  affected_jobs as (
    select distinct deleted_memberships.job_id
    from deleted_memberships
  ),
  remaining_projects as (
    select
      affected_jobs.job_id,
      (
        select other_project.id
        from public.project_jobs other_membership
        join public.projects other_project on other_project.id = other_membership.project_id
        where other_membership.job_id = affected_jobs.job_id
          and other_project.archived_at is null
        order by other_membership.created_at asc
        limit 1
      ) as next_project_id
    from affected_jobs
  )
  update public.jobs job_row
  set
    project_id = remaining_projects.next_project_id,
    updated_at = v_timestamp
  from remaining_projects
  where job_row.id = remaining_projects.job_id;

  delete from public.projects
  where id = v_project.id;

  perform public.log_audit_event(
    v_project.organization_id,
    'project.dissolved',
    jsonb_build_object('projectId', v_project.id, 'name', v_project.name),
    null,
    null
  );

  return v_project.id;
end;
$$;

grant execute on function public.api_create_client_draft(
  text,
  text,
  uuid,
  text[],
  integer[],
  date
) to authenticated;

grant execute on function public.api_assign_job_to_project(uuid, uuid) to authenticated;
grant execute on function public.api_archive_job(uuid) to authenticated;
grant execute on function public.api_archive_project(uuid) to authenticated;
grant execute on function public.api_dissolve_project(uuid) to authenticated;
