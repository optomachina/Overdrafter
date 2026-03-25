create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth, private
as $$
  select exists (
    select 1
    from auth.users app_user
    join private.platform_admin_emails allowlist
      on lower(allowlist.email) = lower(app_user.email)
    where app_user.id = auth.uid()
  );
$$;

drop policy if exists "organizations_select_platform_admins" on public.organizations;
create policy "organizations_select_platform_admins"
on public.organizations
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "organization_memberships_select_platform_admins" on public.organization_memberships;
create policy "organization_memberships_select_platform_admins"
on public.organization_memberships
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "pricing_policies_select_platform_admins" on public.pricing_policies;
create policy "pricing_policies_select_platform_admins"
on public.pricing_policies
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "jobs_select_platform_admins" on public.jobs;
create policy "jobs_select_platform_admins"
on public.jobs
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "job_files_select_platform_admins" on public.job_files;
create policy "job_files_select_platform_admins"
on public.job_files
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "parts_select_platform_admins" on public.parts;
create policy "parts_select_platform_admins"
on public.parts
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "drawing_extractions_select_platform_admins" on public.drawing_extractions;
create policy "drawing_extractions_select_platform_admins"
on public.drawing_extractions
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "approved_part_requirements_select_platform_admins" on public.approved_part_requirements;
create policy "approved_part_requirements_select_platform_admins"
on public.approved_part_requirements
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "quote_runs_select_platform_admins" on public.quote_runs;
create policy "quote_runs_select_platform_admins"
on public.quote_runs
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "vendor_quote_results_select_platform_admins" on public.vendor_quote_results;
create policy "vendor_quote_results_select_platform_admins"
on public.vendor_quote_results
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "vendor_quote_artifacts_select_platform_admins" on public.vendor_quote_artifacts;
create policy "vendor_quote_artifacts_select_platform_admins"
on public.vendor_quote_artifacts
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "vendor_quote_offers_select_platform_admins" on public.vendor_quote_offers;
create policy "vendor_quote_offers_select_platform_admins"
on public.vendor_quote_offers
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "published_quote_packages_select_platform_admins" on public.published_quote_packages;
create policy "published_quote_packages_select_platform_admins"
on public.published_quote_packages
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "published_quote_options_select_platform_admins" on public.published_quote_options;
create policy "published_quote_options_select_platform_admins"
on public.published_quote_options
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "client_selections_select_platform_admins" on public.client_selections;
create policy "client_selections_select_platform_admins"
on public.client_selections
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "work_queue_select_platform_admins" on public.work_queue;
create policy "work_queue_select_platform_admins"
on public.work_queue
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "projects_select_platform_admins" on public.projects;
create policy "projects_select_platform_admins"
on public.projects
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "project_memberships_select_platform_admins" on public.project_memberships;
create policy "project_memberships_select_platform_admins"
on public.project_memberships
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "drawing_preview_assets_select_platform_admins" on public.drawing_preview_assets;
create policy "drawing_preview_assets_select_platform_admins"
on public.drawing_preview_assets
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists "debug_extraction_runs_select_platform_admins" on public.debug_extraction_runs;
create policy "debug_extraction_runs_select_platform_admins"
on public.debug_extraction_runs
for select
to authenticated
using (public.is_platform_admin());

create or replace function public.api_get_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth, private
as $$
  select public.is_platform_admin();
$$;

create or replace function public.api_admin_list_organizations()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, private
as $$
declare
  v_rows jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', organization_row.id,
        'name', organization_row.name,
        'slug', organization_row.slug,
        'memberCount', coalesce(member_counts.member_count, 0),
        'activeJobCount', coalesce(job_counts.active_job_count, 0),
        'createdAt', organization_row.created_at
      )
      order by organization_row.created_at desc
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.organizations organization_row
  left join lateral (
    select count(*)::integer as member_count
    from public.organization_memberships membership
    where membership.organization_id = organization_row.id
  ) member_counts on true
  left join lateral (
    select count(*)::integer as active_job_count
    from public.jobs job
    where job.organization_id = organization_row.id
      and job.archived_at is null
  ) job_counts on true;

  return v_rows;
end;
$$;

create or replace function public.api_admin_list_all_users()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, private
as $$
declare
  v_rows jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', membership.id,
        'userId', membership.user_id,
        'email', coalesce(app_user.email, 'unknown'),
        'organizationId', organization_row.id,
        'organizationName', organization_row.name,
        'organizationSlug', organization_row.slug,
        'role', membership.role,
        'createdAt', membership.created_at
      )
      order by membership.created_at desc
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.organization_memberships membership
  join public.organizations organization_row on organization_row.id = membership.organization_id
  left join auth.users app_user on app_user.id = membership.user_id;

  return v_rows;
end;
$$;

create or replace function public.api_admin_list_all_jobs()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, private
as $$
declare
  v_rows jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', job.id,
        'organizationId', organization_row.id,
        'organizationName', organization_row.name,
        'title', job.title,
        'status', job.status,
        'partCount', coalesce(part_counts.part_count, 0),
        'createdAt', job.created_at
      )
      order by job.created_at desc
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.jobs job
  join public.organizations organization_row on organization_row.id = job.organization_id
  left join lateral (
    select count(*)::integer as part_count
    from public.parts part
    where part.job_id = job.id
  ) part_counts on true
  where job.archived_at is null;

  return v_rows;
end;
$$;

create or replace function public.api_admin_list_all_projects()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, private
as $$
declare
  v_rows jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required.';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', project.id,
        'organizationId', organization_row.id,
        'organizationName', organization_row.name,
        'name', project.name,
        'ownerEmail', owner_user.email,
        'memberCount', coalesce(member_counts.member_count, 0),
        'jobCount', coalesce(job_counts.job_count, 0),
        'createdAt', project.created_at
      )
      order by project.created_at desc
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.projects project
  join public.organizations organization_row on organization_row.id = project.organization_id
  left join auth.users owner_user on owner_user.id = project.owner_user_id
  left join lateral (
    select count(*)::integer as member_count
    from public.project_memberships membership
    where membership.project_id = project.id
  ) member_counts on true
  left join lateral (
    select count(*)::integer as job_count
    from public.jobs job
    where job.project_id = project.id
      and job.archived_at is null
  ) job_counts on true
  where project.archived_at is null;

  return v_rows;
end;
$$;

grant execute on function public.api_get_is_platform_admin() to authenticated;
grant execute on function public.api_admin_list_organizations() to authenticated;
grant execute on function public.api_admin_list_all_users() to authenticated;
grant execute on function public.api_admin_list_all_jobs() to authenticated;
grant execute on function public.api_admin_list_all_projects() to authenticated;
