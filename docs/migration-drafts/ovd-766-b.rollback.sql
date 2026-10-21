-- OVD-768 (OVD-766 group b): ROLLBACK for docs/migration-drafts/ovd-766-b.sql.
--
-- DRAFT ONLY. NOT APPLIED anywhere; runs only inside the same Blaine-approved
-- migration window as the forward draft. Restores the four definitions from
-- supabase/migrations/20260325120000_add_platform_admin_god_mode.sql exactly
-- (search_path public, auth, private; is_platform_admin() check only).
-- Grants restore the post-OVD-736 state (20261015074957): no EXECUTE for PUBLIC or anon; EXECUTE for authenticated and service_role. Never re-grant PUBLIC or anon (OVD-949).

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

revoke all on function public.api_admin_list_organizations() from public, anon;
revoke all on function public.api_admin_list_all_users() from public, anon;
revoke all on function public.api_admin_list_all_jobs() from public, anon;
revoke all on function public.api_admin_list_all_projects() from public, anon;
grant execute on function public.api_admin_list_organizations() to authenticated, service_role;
grant execute on function public.api_admin_list_all_users() to authenticated, service_role;
grant execute on function public.api_admin_list_all_jobs() to authenticated, service_role;
grant execute on function public.api_admin_list_all_projects() to authenticated, service_role;

do $ovd949$
declare f regprocedure;
begin
  foreach f in array array['public.api_admin_list_organizations()', 'public.api_admin_list_all_users()', 'public.api_admin_list_all_jobs()', 'public.api_admin_list_all_projects()']::regprocedure[] loop
    if has_function_privilege('anon', f, 'EXECUTE') or exists (
      select 1 from pg_catalog.pg_proc p,
        pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'OVD-949: % is executable by anon or PUBLIC after rollback', f;
    end if;
  end loop;
end;
$ovd949$;
