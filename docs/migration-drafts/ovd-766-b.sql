-- OVD-768 (OVD-766 group b): require verified auth on the four platform admin
-- list RPCs.
--
-- Authored as a DRAFT in docs/migration-drafts/ovd-766-b.sql: NOT APPLIED until
-- a Blaine-approved migration window, where it is promoted unchanged with a
-- single git mv to supabase/migrations/<timestamp>_ovd768_admin_list_guards.sql.
-- Plain SQL, no psql meta-commands, no transaction control (the migration
-- runner wraps it). Rollback: docs/migration-drafts/ovd-766-b.rollback.sql.
-- pgTAP: supabase/tests/pending/ovd768_admin_list_guards.sql.pending, moved to
-- supabase/tests/ovd768_admin_list_guards.sql in the promoting change.
--
-- Functions (latest definitions: 20260325120000_add_platform_admin_god_mode.sql):
--   public.api_admin_list_organizations()
--   public.api_admin_list_all_users()
--   public.api_admin_list_all_jobs()
--   public.api_admin_list_all_projects()
--
-- Signatures (no arguments) and return types (jsonb) are unchanged, so
-- create or replace keeps each function's OID and existing grants.
--
-- What changes:
--   * public.require_verified_auth() is the first statement, before the existing
--     public.is_platform_admin() check, so a platform admin with no confirmed
--     email and no OAuth provider is refused, as in the other internal-role
--     admin RPCs (for example api_admin_get_founding_beta_enrollment). No AAL2
--     check: these are read-only lists.
--   * search_path is pinned to '' and every reference is schema qualified.
--   * EXECUTE is revoked from PUBLIC and anon and granted to authenticated only.
--     This is idempotent with the OVD-736 anon revoke: whichever lands first,
--     the other's revoke is a no-op.
--
-- Unchanged for legitimate callers: result shape, ordering, filters, the
-- non-admin error text ('Platform admin access required.'), volatility and
-- SECURITY DEFINER. When applied, drop the PUBLIC and anon OVD-736 rows for
-- these four signatures from supabase/tests/api_role_privilege_inventory.sql in
-- the same change.

create or replace function public.api_admin_list_organizations()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  perform public.require_verified_auth();

  if not public.is_platform_admin() then
    raise exception 'Platform admin access required.';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', organization_row.id,
        'name', organization_row.name,
        'slug', organization_row.slug,
        'memberCount', coalesce(member_counts.member_count, 0),
        'activeJobCount', coalesce(job_counts.active_job_count, 0),
        'createdAt', organization_row.created_at
      )
      order by organization_row.created_at desc
    ),
    '[]'::pg_catalog.jsonb
  )
  into v_rows
  from public.organizations organization_row
  left join lateral (
    select pg_catalog.count(*)::integer as member_count
    from public.organization_memberships membership
    where membership.organization_id = organization_row.id
  ) member_counts on true
  left join lateral (
    select pg_catalog.count(*)::integer as active_job_count
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
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  perform public.require_verified_auth();

  if not public.is_platform_admin() then
    raise exception 'Platform admin access required.';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
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
    '[]'::pg_catalog.jsonb
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
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  perform public.require_verified_auth();

  if not public.is_platform_admin() then
    raise exception 'Platform admin access required.';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
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
    '[]'::pg_catalog.jsonb
  )
  into v_rows
  from public.jobs job
  join public.organizations organization_row on organization_row.id = job.organization_id
  left join lateral (
    select pg_catalog.count(*)::integer as part_count
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
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  perform public.require_verified_auth();

  if not public.is_platform_admin() then
    raise exception 'Platform admin access required.';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
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
    '[]'::pg_catalog.jsonb
  )
  into v_rows
  from public.projects project
  join public.organizations organization_row on organization_row.id = project.organization_id
  left join auth.users owner_user on owner_user.id = project.owner_user_id
  left join lateral (
    select pg_catalog.count(*)::integer as member_count
    from public.project_memberships membership
    where membership.project_id = project.id
  ) member_counts on true
  left join lateral (
    select pg_catalog.count(*)::integer as job_count
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

grant execute on function public.api_admin_list_organizations() to authenticated;
grant execute on function public.api_admin_list_all_users() to authenticated;
grant execute on function public.api_admin_list_all_jobs() to authenticated;
grant execute on function public.api_admin_list_all_projects() to authenticated;
