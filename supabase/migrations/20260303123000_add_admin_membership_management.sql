create schema if not exists private;

create table if not exists private.platform_admin_emails (
  email text primary key,
  created_at timestamptz not null default timezone('utc', now())
);

revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

insert into private.platform_admin_emails (email)
values ('blaineswilson@gmail.com')
on conflict (email) do nothing;

create or replace function public.is_org_admin(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
      and membership.role = 'internal_admin'
  );
$$;

create or replace function public.get_self_service_membership_role(p_user_id uuid)
returns public.app_role
language sql
stable
security definer
set search_path = public, auth, private
as $$
  select case
    when exists (
      select 1
      from auth.users app_user
      join private.platform_admin_emails allowlist
        on lower(allowlist.email) = lower(app_user.email)
      where app_user.id = p_user_id
    ) then 'internal_admin'::public.app_role
    else 'client'::public.app_role
  end;
$$;

create or replace function public.api_create_self_service_organization(
  p_organization_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, auth, private
as $$
declare
  v_trimmed_name text := trim(coalesce(p_organization_name, ''));
  v_base_slug text;
  v_slug text;
  v_organization_id uuid;
  v_role public.app_role;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create an organization.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));

  if exists (
    select 1
    from public.organization_memberships membership
    where membership.user_id = auth.uid()
  ) then
    raise exception 'Your account already has an organization membership.';
  end if;

  if v_trimmed_name = '' then
    raise exception 'Organization name is required.';
  end if;

  v_base_slug := trim(
    both '-'
    from regexp_replace(lower(v_trimmed_name), '[^a-z0-9]+', '-', 'g')
  );

  if v_base_slug = '' then
    v_base_slug := 'organization';
  end if;

  v_slug := v_base_slug;

  while exists (
    select 1
    from public.organizations organization_row
    where organization_row.slug = v_slug
  ) loop
    v_slug := v_base_slug || '-' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6);
  end loop;

  v_role := public.get_self_service_membership_role(auth.uid());

  insert into public.organizations (name, slug)
  values (v_trimmed_name, v_slug)
  returning id into v_organization_id;

  insert into public.organization_memberships (
    organization_id,
    user_id,
    role
  )
  values (
    v_organization_id,
    auth.uid(),
    v_role
  );

  perform public.log_audit_event(
    v_organization_id,
    'organization.self_service_bootstrapped',
    jsonb_build_object(
      'organizationName', v_trimmed_name,
      'organizationSlug', v_slug,
      'role', v_role
    ),
    null,
    null
  );

  return v_organization_id;
end;
$$;

create or replace function public.api_list_organization_memberships(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_memberships jsonb;
begin
  if not public.is_org_admin(p_organization_id) then
    raise exception 'You do not have admin access to organization %', p_organization_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', membership.id,
        'userId', membership.user_id,
        'email', coalesce(app_user.email, 'unknown'),
        'role', membership.role,
        'createdAt', membership.created_at
      )
      order by membership.created_at asc
    ),
    '[]'::jsonb
  )
  into v_memberships
  from public.organization_memberships membership
  left join auth.users app_user on app_user.id = membership.user_id
  where membership.organization_id = p_organization_id;

  return v_memberships;
end;
$$;

create or replace function public.api_update_organization_membership_role(
  p_membership_id uuid,
  p_role public.app_role
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_membership public.organization_memberships%rowtype;
  v_admin_count integer;
begin
  select *
  into v_membership
  from public.organization_memberships
  where id = p_membership_id;

  if v_membership.id is null then
    raise exception 'Membership % not found', p_membership_id;
  end if;

  if not public.is_org_admin(v_membership.organization_id) then
    raise exception 'You do not have admin access to organization %', v_membership.organization_id;
  end if;

  if v_membership.role = p_role then
    return v_membership.id;
  end if;

  if v_membership.role = 'internal_admin' and p_role <> 'internal_admin' then
    select count(*)
    into v_admin_count
    from public.organization_memberships membership
    where membership.organization_id = v_membership.organization_id
      and membership.role = 'internal_admin';

    if v_admin_count <= 1 then
      raise exception 'Each organization must keep at least one internal admin.';
    end if;
  end if;

  update public.organization_memberships
  set role = p_role
  where id = v_membership.id;

  perform public.log_audit_event(
    v_membership.organization_id,
    'organization_membership.role_updated',
    jsonb_build_object(
      'membershipId', v_membership.id,
      'userId', v_membership.user_id,
      'previousRole', v_membership.role,
      'newRole', p_role
    ),
    null,
    null
  );

  return v_membership.id;
end;
$$;

update public.organization_memberships membership
set role = 'internal_admin'
from auth.users app_user
join private.platform_admin_emails allowlist
  on lower(allowlist.email) = lower(app_user.email)
where membership.user_id = app_user.id
  and membership.role <> 'internal_admin';

drop policy if exists "organizations_manage_internal_admins" on public.organizations;
create policy "organizations_manage_internal_admins"
on public.organizations
for all
to authenticated
using (public.is_org_admin(id))
with check (public.is_org_admin(id));

drop policy if exists "memberships_manage_internal_admins" on public.organization_memberships;
create policy "memberships_manage_internal_admins"
on public.organization_memberships
for all
to authenticated
using (public.is_org_admin(organization_id))
with check (public.is_org_admin(organization_id));

grant execute on function public.api_list_organization_memberships(uuid) to authenticated;
grant execute on function public.api_update_organization_membership_role(uuid, public.app_role) to authenticated;
