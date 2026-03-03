create or replace function public.api_create_self_service_organization(
  p_organization_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trimmed_name text := trim(coalesce(p_organization_name, ''));
  v_base_slug text;
  v_slug text;
  v_organization_id uuid;
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
    'client'
  );

  perform public.log_audit_event(
    v_organization_id,
    'organization.self_service_bootstrapped',
    jsonb_build_object(
      'organizationName', v_trimmed_name,
      'organizationSlug', v_slug
    ),
    null,
    null
  );

  return v_organization_id;
end;
$$;

grant execute on function public.api_create_self_service_organization(text) to authenticated;
