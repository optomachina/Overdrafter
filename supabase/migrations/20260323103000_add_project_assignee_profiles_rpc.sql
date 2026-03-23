create or replace function public.api_list_project_assignee_profiles(
  p_project_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profiles jsonb;
begin
  if not public.user_can_access_project(p_project_id) then
    raise exception 'You do not have access to project %.', p_project_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'userId', app_user.id,
        'email', app_user.email,
        'givenName', nullif(trim(coalesce(
          app_user.raw_user_meta_data ->> 'given_name',
          app_user.raw_user_meta_data ->> 'first_name',
          app_user.raw_user_meta_data ->> 'givenName',
          ''
        )), ''),
        'familyName', nullif(trim(coalesce(
          app_user.raw_user_meta_data ->> 'family_name',
          app_user.raw_user_meta_data ->> 'last_name',
          app_user.raw_user_meta_data ->> 'familyName',
          ''
        )), ''),
        'fullName', nullif(trim(coalesce(
          app_user.raw_user_meta_data ->> 'full_name',
          app_user.raw_user_meta_data ->> 'name',
          ''
        )), '')
      )
      order by coalesce(app_user.email, app_user.id::text)
    ),
    '[]'::jsonb
  )
  into v_profiles
  from (
    select distinct project_job.created_by as user_id
    from public.project_jobs project_job
    where project_job.project_id = p_project_id
  ) assignee
  join auth.users app_user on app_user.id = assignee.user_id;

  return v_profiles;
end;
$$;

grant execute on function public.api_list_project_assignee_profiles(uuid) to authenticated;
