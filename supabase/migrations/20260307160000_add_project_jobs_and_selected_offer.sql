create table if not exists public.project_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  unique (project_id, job_id)
);

create index if not exists idx_project_jobs_project on public.project_jobs(project_id, created_at desc);
create index if not exists idx_project_jobs_job on public.project_jobs(job_id, created_at desc);

insert into public.project_jobs (project_id, job_id, created_by, created_at)
select
  job.project_id,
  job.id,
  job.created_by,
  coalesce(job.created_at, timezone('utc', now()))
from public.jobs job
where job.project_id is not null
on conflict (project_id, job_id) do nothing;

alter table public.jobs
add column if not exists selected_vendor_quote_offer_id uuid references public.vendor_quote_offers(id) on delete set null;

create table if not exists public.drawing_preview_assets (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references public.parts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  page_number integer not null default 1,
  kind text not null default 'page',
  storage_bucket text not null default 'job-files',
  storage_path text not null,
  width integer,
  height integer,
  created_at timestamptz not null default timezone('utc', now()),
  unique (part_id, page_number, kind)
);

create index if not exists idx_drawing_preview_assets_part on public.drawing_preview_assets(part_id, page_number);

create or replace function public.user_can_access_job_via_project(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_jobs project_job
    where project_job.job_id = p_job_id
      and public.user_can_access_project(project_job.project_id)
  );
$$;

create or replace function public.user_can_edit_job(p_job_id uuid)
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
        public.user_can_access_org(job.organization_id)
        or job.created_by = auth.uid()
        or exists (
          select 1
          from public.project_jobs project_job
          where project_job.job_id = job.id
            and public.user_can_edit_project(project_job.project_id)
        )
      )
  );
$$;

alter table public.project_jobs enable row level security;
alter table public.drawing_preview_assets enable row level security;

drop policy if exists "project_jobs_select_accessible" on public.project_jobs;
create policy "project_jobs_select_accessible"
on public.project_jobs
for select
to authenticated
using (public.user_can_access_project(project_id));

drop policy if exists "project_jobs_manage_editors" on public.project_jobs;
create policy "project_jobs_manage_editors"
on public.project_jobs
for all
to authenticated
using (public.user_can_edit_project(project_id))
with check (public.user_can_edit_project(project_id));

drop policy if exists "drawing_preview_assets_select_accessible" on public.drawing_preview_assets;
create policy "drawing_preview_assets_select_accessible"
on public.drawing_preview_assets
for select
to authenticated
using (public.user_can_access_job((select part.job_id from public.parts part where part.id = part_id)));

drop policy if exists "drawing_preview_assets_manage_internal" on public.drawing_preview_assets;
create policy "drawing_preview_assets_manage_internal"
on public.drawing_preview_assets
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

create or replace function public.api_create_client_draft(
  p_title text,
  p_description text default null,
  p_project_id uuid default null,
  p_tags text[] default '{}'::text[]
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

    if v_project.id is null then
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
    p_tags
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

  select *
  into v_project
  from public.projects
  where id = p_project_id;

  if v_project.id is null then
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

  if v_job.project_id is null then
    update public.jobs
    set
      project_id = v_project.id,
      updated_at = timezone('utc', now())
    where id = v_job.id;
  end if;

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

drop function if exists public.api_remove_job_from_project(uuid);

create or replace function public.api_remove_job_from_project(
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
    raise exception 'You do not have permission to move this part.';
  end if;

  delete from public.project_jobs
  where job_id = v_job.id
    and project_id = p_project_id;

  select project_job.project_id
  into v_next_project_id
  from public.project_jobs project_job
  where project_job.job_id = v_job.id
  order by project_job.created_at asc
  limit 1;

  update public.jobs
  set
    project_id = v_next_project_id,
    updated_at = timezone('utc', now())
  where id = v_job.id;

  perform public.log_audit_event(
    v_job.organization_id,
    'project.job_removed',
    jsonb_build_object('jobId', v_job.id, 'projectId', p_project_id),
    v_job.id,
    null
  );

  return v_job.id;
end;
$$;

create or replace function public.api_set_job_selected_vendor_quote_offer(
  p_job_id uuid,
  p_vendor_quote_offer_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_part_id uuid;
  v_offer public.vendor_quote_offers%rowtype;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_access_job(v_job.id) then
    raise exception 'You do not have access to job %.', p_job_id;
  end if;

  select id
  into v_part_id
  from public.parts
  where job_id = v_job.id
  order by created_at asc
  limit 1;

  if v_part_id is null then
    raise exception 'Job % has no part revisions yet.', p_job_id;
  end if;

  select *
  into v_offer
  from public.vendor_quote_offers offer
  join public.vendor_quote_results result on result.id = offer.vendor_quote_result_id
  where offer.id = p_vendor_quote_offer_id
    and result.part_id = v_part_id;

  if v_offer.id is null then
    raise exception 'Offer % is not valid for job %.', p_vendor_quote_offer_id, p_job_id;
  end if;

  update public.jobs
  set
    selected_vendor_quote_offer_id = v_offer.id,
    updated_at = timezone('utc', now())
  where id = v_job.id;

  return v_job.id;
end;
$$;

grant execute on function public.api_create_client_draft(text, text, uuid, text[]) to authenticated;
grant execute on function public.api_assign_job_to_project(uuid, uuid) to authenticated;
grant execute on function public.api_remove_job_from_project(uuid, uuid) to authenticated;
grant execute on function public.api_set_job_selected_vendor_quote_offer(uuid, uuid) to authenticated;
