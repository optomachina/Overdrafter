create type public.project_role as enum ('owner', 'editor');

create type public.project_invite_status as enum ('pending', 'accepted', 'revoked', 'expired');

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.project_memberships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.project_role not null default 'editor',
  created_at timestamptz not null default timezone('utc', now()),
  unique (project_id, user_id)
);

create table if not exists public.project_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  role public.project_role not null default 'editor',
  invited_by uuid not null references auth.users(id) on delete cascade,
  accepted_by uuid references auth.users(id) on delete set null,
  token text not null unique,
  status public.project_invite_status not null default 'pending',
  expires_at timestamptz not null default timezone('utc', now()) + interval '30 days',
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.jobs
add column if not exists project_id uuid references public.projects(id) on delete set null;

create index if not exists idx_projects_org_created on public.projects(organization_id, created_at desc);
create index if not exists idx_projects_owner on public.projects(owner_user_id, created_at desc);
create index if not exists idx_project_memberships_user on public.project_memberships(user_id, created_at desc);
create index if not exists idx_project_invites_project on public.project_invites(project_id, created_at desc);
create index if not exists idx_project_invites_email on public.project_invites(lower(email));
create index if not exists idx_jobs_project on public.jobs(project_id, created_at desc);

drop trigger if exists touch_projects_updated_at on public.projects;
create trigger touch_projects_updated_at
before update on public.projects
for each row execute function public.touch_updated_at();

create or replace function public.current_user_home_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select membership.organization_id
  from public.organization_memberships membership
  where membership.user_id = auth.uid()
  order by membership.created_at asc
  limit 1;
$$;

create or replace function public.user_is_project_owner(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects project
    where project.id = p_project_id
      and (
        public.is_internal_user(project.organization_id)
        or exists (
          select 1
          from public.project_memberships membership
          where membership.project_id = project.id
            and membership.user_id = auth.uid()
            and membership.role = 'owner'
        )
      )
  );
$$;

create or replace function public.user_can_access_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects project
    where project.id = p_project_id
      and (
        public.is_internal_user(project.organization_id)
        or exists (
          select 1
          from public.project_memberships membership
          where membership.project_id = project.id
            and membership.user_id = auth.uid()
        )
      )
  );
$$;

create or replace function public.user_can_edit_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects project
    where project.id = p_project_id
      and (
        public.is_internal_user(project.organization_id)
        or exists (
          select 1
          from public.project_memberships membership
          where membership.project_id = project.id
            and membership.user_id = auth.uid()
            and membership.role in ('owner', 'editor')
        )
      )
  );
$$;

create or replace function public.user_can_access_job_via_project(p_job_id uuid)
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
      and job.project_id is not null
      and public.user_can_access_project(job.project_id)
  );
$$;

create or replace function public.user_can_access_job(p_job_id uuid)
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
        or public.user_can_access_job_via_project(job.id)
        or job.created_by = auth.uid()
      )
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
        or (
          job.project_id is not null
          and public.user_can_edit_project(job.project_id)
        )
      )
  );
$$;

create or replace function public.user_can_access_package(p_package_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.published_quote_packages package_row
    join public.jobs job on job.id = package_row.job_id
    where package_row.id = p_package_id
      and public.user_can_access_job(job.id)
  );
$$;

alter table public.projects enable row level security;
alter table public.project_memberships enable row level security;
alter table public.project_invites enable row level security;

drop policy if exists "projects_select_accessible" on public.projects;
create policy "projects_select_accessible"
on public.projects
for select
to authenticated
using (public.user_can_access_project(id));

drop policy if exists "project_memberships_select_accessible" on public.project_memberships;
create policy "project_memberships_select_accessible"
on public.project_memberships
for select
to authenticated
using (public.user_can_access_project(project_id));

drop policy if exists "project_invites_select_owners" on public.project_invites;
create policy "project_invites_select_owners"
on public.project_invites
for select
to authenticated
using (public.user_is_project_owner(project_id));

drop policy if exists "jobs_select_members" on public.jobs;
create policy "jobs_select_members"
on public.jobs
for select
to authenticated
using (public.user_can_access_job(id));

drop policy if exists "job_files_select_members" on public.job_files;
create policy "job_files_select_members"
on public.job_files
for select
to authenticated
using (public.user_can_access_job(job_id));

drop policy if exists "parts_select_members" on public.parts;
create policy "parts_select_members"
on public.parts
for select
to authenticated
using (public.user_can_access_job(job_id));

drop policy if exists "packages_select_members" on public.published_quote_packages;
create policy "packages_select_members"
on public.published_quote_packages
for select
to authenticated
using (public.user_can_access_package(id));

drop policy if exists "package_options_select_members" on public.published_quote_options;
create policy "package_options_select_members"
on public.published_quote_options
for select
to authenticated
using (public.user_can_access_package(package_id));

drop policy if exists "client_selections_select_members" on public.client_selections;
create policy "client_selections_select_members"
on public.client_selections
for select
to authenticated
using (public.user_can_access_package(package_id));

drop policy if exists "client_selections_insert_members" on public.client_selections;
create policy "client_selections_insert_members"
on public.client_selections
for insert
to authenticated
with check (
  selected_by = auth.uid()
  and public.user_can_access_package(package_id)
);

drop policy if exists "job_files_storage_insert" on storage.objects;
create policy "job_files_storage_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'job-files'
  and exists (
    select 1
    from public.jobs job
    where job.id::text = split_part(name, '/', 1)
      and public.user_can_edit_job(job.id)
  )
);

drop policy if exists "job_files_storage_read" on storage.objects;
create policy "job_files_storage_read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'job-files'
  and exists (
    select 1
    from public.job_files file
    where file.storage_path = name
      and public.user_can_access_job(file.job_id)
  )
);

create or replace function public.api_create_project(
  p_name text,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_project_id uuid;
  v_organization_id uuid;
begin
  perform public.require_verified_auth();

  v_organization_id := public.current_user_home_organization_id();

  if v_organization_id is null then
    raise exception 'A home workspace is still being prepared for this account.';
  end if;

  if v_name = '' then
    raise exception 'Project name is required.';
  end if;

  insert into public.projects (
    organization_id,
    owner_user_id,
    name,
    description
  )
  values (
    v_organization_id,
    auth.uid(),
    v_name,
    nullif(trim(coalesce(p_description, '')), '')
  )
  returning id into v_project_id;

  insert into public.project_memberships (
    project_id,
    user_id,
    role
  )
  values (
    v_project_id,
    auth.uid(),
    'owner'
  )
  on conflict (project_id, user_id) do update
    set role = 'owner';

  perform public.log_audit_event(
    v_organization_id,
    'project.created',
    jsonb_build_object('projectId', v_project_id, 'name', v_name),
    null,
    null
  );

  return v_project_id;
end;
$$;

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

  if v_project.id is null then
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

create or replace function public.api_delete_project(
  p_project_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.projects%rowtype;
begin
  perform public.require_verified_auth();

  select *
  into v_project
  from public.projects
  where id = p_project_id;

  if v_project.id is null then
    raise exception 'Project % not found', p_project_id;
  end if;

  if not public.user_is_project_owner(v_project.id) then
    raise exception 'You do not have permission to delete this project.';
  end if;

  delete from public.projects
  where id = p_project_id;

  perform public.log_audit_event(
    v_project.organization_id,
    'project.deleted',
    jsonb_build_object('projectId', v_project.id, 'name', v_project.name),
    null,
    null
  );

  return v_project.id;
end;
$$;

create or replace function public.api_invite_project_member(
  p_project_id uuid,
  p_email text,
  p_role public.project_role default 'editor'
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_project public.projects%rowtype;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_token text := encode(gen_random_bytes(24), 'hex');
  v_invite_id uuid;
  v_existing_user_id uuid;
begin
  perform public.require_verified_auth();

  select *
  into v_project
  from public.projects
  where id = p_project_id;

  if v_project.id is null then
    raise exception 'Project % not found', p_project_id;
  end if;

  if not public.user_is_project_owner(v_project.id) then
    raise exception 'You do not have permission to invite members to this project.';
  end if;

  if v_email = '' then
    raise exception 'Invite email is required.';
  end if;

  select app_user.id
  into v_existing_user_id
  from auth.users app_user
  where lower(app_user.email) = v_email
  limit 1;

  if v_existing_user_id is not null and exists (
    select 1
    from public.project_memberships membership
    where membership.project_id = v_project.id
      and membership.user_id = v_existing_user_id
  ) then
    raise exception '% is already a member of this project.', v_email;
  end if;

  update public.project_invites
  set
    email = v_email,
    role = coalesce(p_role, 'editor'),
    invited_by = auth.uid(),
    token = v_token,
    status = 'pending',
    accepted_by = null,
    accepted_at = null,
    revoked_at = null,
    expires_at = timezone('utc', now()) + interval '30 days'
  where project_id = v_project.id
    and lower(email) = v_email
    and status in ('pending', 'expired', 'revoked')
  returning id into v_invite_id;

  if v_invite_id is null then
    insert into public.project_invites (
      project_id,
      email,
      role,
      invited_by,
      token
    )
    values (
      v_project.id,
      v_email,
      coalesce(p_role, 'editor'),
      auth.uid(),
      v_token
    )
    returning id into v_invite_id;
  end if;

  perform public.log_audit_event(
    v_project.organization_id,
    'project.member_invited',
    jsonb_build_object('projectId', v_project.id, 'inviteId', v_invite_id, 'email', v_email, 'role', coalesce(p_role, 'editor')),
    null,
    null
  );

  return jsonb_build_object(
    'id', v_invite_id,
    'projectId', v_project.id,
    'email', v_email,
    'role', coalesce(p_role, 'editor'),
    'token', v_token,
    'expiresAt', timezone('utc', now()) + interval '30 days'
  );
end;
$$;

create or replace function public.api_accept_project_invite(
  p_token text
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_token text := trim(coalesce(p_token, ''));
  v_invite public.project_invites%rowtype;
  v_user_email text;
begin
  perform public.require_verified_auth();

  select app_user.email
  into v_user_email
  from auth.users app_user
  where app_user.id = auth.uid();

  if v_token = '' then
    raise exception 'Invite token is required.';
  end if;

  update public.project_invites invite_row
  set status = 'expired'
  where invite_row.status = 'pending'
    and invite_row.expires_at < timezone('utc', now());

  select *
  into v_invite
  from public.project_invites invite_row
  where invite_row.token = v_token;

  if v_invite.id is null then
    raise exception 'Invite not found.';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'This invite is no longer active.';
  end if;

  if lower(coalesce(v_user_email, '')) <> lower(v_invite.email) then
    raise exception 'This invite is intended for %.', v_invite.email;
  end if;

  insert into public.project_memberships (
    project_id,
    user_id,
    role
  )
  values (
    v_invite.project_id,
    auth.uid(),
    v_invite.role
  )
  on conflict (project_id, user_id) do update
    set role = excluded.role;

  update public.project_invites
  set
    status = 'accepted',
    accepted_by = auth.uid(),
    accepted_at = timezone('utc', now())
  where id = v_invite.id;

  perform public.log_audit_event(
    (select organization_id from public.projects where id = v_invite.project_id),
    'project.member_joined',
    jsonb_build_object('projectId', v_invite.project_id, 'email', v_invite.email),
    null,
    null
  );

  return v_invite.project_id;
end;
$$;

create or replace function public.api_remove_project_member(
  p_project_membership_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_membership public.project_memberships%rowtype;
  v_project public.projects%rowtype;
begin
  perform public.require_verified_auth();

  select *
  into v_membership
  from public.project_memberships
  where id = p_project_membership_id;

  if v_membership.id is null then
    raise exception 'Project membership % not found.', p_project_membership_id;
  end if;

  select *
  into v_project
  from public.projects
  where id = v_membership.project_id;

  if v_project.id is null then
    raise exception 'Project % not found.', v_membership.project_id;
  end if;

  if not public.user_is_project_owner(v_project.id) then
    raise exception 'You do not have permission to remove members from this project.';
  end if;

  if v_membership.role = 'owner' then
    raise exception 'Owner memberships cannot be removed.';
  end if;

  delete from public.project_memberships
  where id = v_membership.id;

  perform public.log_audit_event(
    v_project.organization_id,
    'project.member_removed',
    jsonb_build_object('projectId', v_project.id, 'membershipId', v_membership.id, 'userId', v_membership.user_id),
    null,
    null
  );

  return v_membership.id;
end;
$$;

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

  update public.jobs
  set
    project_id = v_project.id,
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

create or replace function public.api_remove_job_from_project(
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

  if v_job.project_id is null then
    return v_job.id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to move this part.';
  end if;

  update public.jobs
  set
    project_id = null,
    updated_at = timezone('utc', now())
  where id = v_job.id;

  perform public.log_audit_event(
    v_job.organization_id,
    'project.job_removed',
    jsonb_build_object('jobId', v_job.id),
    v_job.id,
    null
  );

  return v_job.id;
end;
$$;

create or replace function public.api_attach_job_file(
  p_job_id uuid,
  p_storage_bucket text,
  p_storage_path text,
  p_original_name text,
  p_file_kind public.job_file_kind,
  p_mime_type text default null,
  p_size_bytes bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_file_id uuid;
begin
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  insert into public.job_files (
    job_id,
    organization_id,
    uploaded_by,
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
    coalesce(nullif(p_storage_bucket, ''), 'job-files'),
    p_storage_path,
    p_original_name,
    public.normalize_file_basename(p_original_name),
    p_file_kind,
    p_mime_type,
    p_size_bytes
  )
  returning id into v_file_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.file_attached',
    jsonb_build_object('fileId', v_file_id, 'originalName', p_original_name, 'kind', p_file_kind),
    p_job_id,
    null
  );

  return v_file_id;
end;
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
  perform public.require_verified_auth();

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  with file_set as (
    select
      file.normalized_name,
      max(file.id) filter (where file.file_kind = 'cad') as cad_file_id,
      max(file.id) filter (where file.file_kind = 'drawing') as drawing_file_id
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind in ('cad', 'drawing')
    group by file.normalized_name
  )
  delete from public.parts part
  where part.job_id = p_job_id
    and not exists (
      select 1
      from file_set fs
      where fs.normalized_name = part.normalized_key
    );

  with file_set as (
    select
      file.normalized_name,
      max(file.id) filter (where file.file_kind = 'cad') as cad_file_id,
      max(file.id) filter (where file.file_kind = 'drawing') as drawing_file_id
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind in ('cad', 'drawing')
    group by file.normalized_name
  )
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
  from file_set fs
  on conflict (job_id, normalized_key) do update
    set cad_file_id = excluded.cad_file_id,
        drawing_file_id = excluded.drawing_file_id,
        updated_at = timezone('utc', now());

  update public.job_files
  set matched_part_key = normalized_name
  where job_id = p_job_id
    and file_kind in ('cad', 'drawing');

  with file_set as (
    select
      file.normalized_name,
      max(file.id) filter (where file.file_kind = 'cad') as cad_file_id,
      max(file.id) filter (where file.file_kind = 'drawing') as drawing_file_id
    from public.job_files file
    where file.job_id = p_job_id
      and file.file_kind in ('cad', 'drawing')
    group by file.normalized_name
  )
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
  from file_set;

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

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  perform public.api_reconcile_job_parts(p_job_id);

  with enqueued as (
    insert into public.work_queue (
      organization_id,
      job_id,
      part_id,
      task_type,
      payload
    )
    select
      v_job.organization_id,
      p_job_id,
      part.id,
      'extract_part',
      jsonb_build_object('partId', part.id, 'jobId', p_job_id)
    from public.parts part
    where part.job_id = p_job_id
      and not exists (
        select 1
        from public.work_queue queue
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

create or replace function public.api_select_quote_option(
  p_package_id uuid,
  p_option_id uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package public.published_quote_packages%rowtype;
  v_option public.published_quote_options%rowtype;
  v_selection_id uuid;
begin
  select *
  into v_package
  from public.published_quote_packages
  where id = p_package_id;

  if v_package.id is null then
    raise exception 'Package % not found', p_package_id;
  end if;

  if not public.user_can_access_package(v_package.id) then
    raise exception 'You do not have access to package %', p_package_id;
  end if;

  select *
  into v_option
  from public.published_quote_options
  where id = p_option_id
    and package_id = p_package_id;

  if v_option.id is null then
    raise exception 'Option % does not belong to package %', p_option_id, p_package_id;
  end if;

  insert into public.client_selections (
    package_id,
    option_id,
    organization_id,
    selected_by,
    note
  )
  values (
    p_package_id,
    p_option_id,
    v_package.organization_id,
    auth.uid(),
    p_note
  )
  returning id into v_selection_id;

  update public.jobs
  set status = 'client_selected'
  where id = v_package.job_id;

  perform public.log_audit_event(
    v_package.organization_id,
    'client.quote_option_selected',
    jsonb_build_object('selectionId', v_selection_id, 'optionId', p_option_id),
    v_package.job_id,
    p_package_id
  );

  return v_selection_id;
end;
$$;

grant execute on function public.api_create_project(text, text) to authenticated;
grant execute on function public.api_update_project(uuid, text, text) to authenticated;
grant execute on function public.api_delete_project(uuid) to authenticated;
grant execute on function public.api_invite_project_member(uuid, text, public.project_role) to authenticated;
grant execute on function public.api_accept_project_invite(text) to authenticated;
grant execute on function public.api_remove_project_member(uuid) to authenticated;
grant execute on function public.api_create_client_draft(text, text, uuid, text[]) to authenticated;
grant execute on function public.api_assign_job_to_project(uuid, uuid) to authenticated;
grant execute on function public.api_remove_job_from_project(uuid) to authenticated;
