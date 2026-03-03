alter type public.vendor_name add value if not exists 'partsbadger';
alter type public.vendor_name add value if not exists 'fastdms';

alter table public.jobs
add column if not exists tags text[] not null default '{}'::text[];

create index if not exists idx_jobs_tags on public.jobs using gin (tags);

drop function if exists public.api_create_job(uuid, text, text, text);
drop function if exists public.api_create_job(uuid, text, text, text, text[]);

create function public.api_create_job(
  p_organization_id uuid,
  p_title text,
  p_description text default null,
  p_source text default 'client',
  p_tags text[] default '{}'::text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_pricing_policy_id uuid;
  v_tags text[];
begin
  perform public.require_verified_auth();

  if not public.user_can_access_org(p_organization_id) then
    raise exception 'You do not have access to organization %', p_organization_id;
  end if;

  v_pricing_policy_id := public.get_active_pricing_policy_id(p_organization_id);
  select coalesce(array_agg(tag), '{}'::text[])
  into v_tags
  from (
    select distinct on (lower(trim(item))) trim(item) as tag
    from unnest(coalesce(p_tags, '{}'::text[])) item
    where nullif(trim(item), '') is not null
    order by lower(trim(item)), trim(item)
  ) cleaned;

  insert into public.jobs (
    organization_id,
    created_by,
    title,
    description,
    source,
    active_pricing_policy_id,
    tags
  )
  values (
    p_organization_id,
    auth.uid(),
    p_title,
    p_description,
    coalesce(nullif(trim(p_source), ''), 'client'),
    v_pricing_policy_id,
    v_tags
  )
  returning id into v_job_id;

  perform public.log_audit_event(
    p_organization_id,
    'job.created',
    jsonb_build_object(
      'title', p_title,
      'source', coalesce(p_source, 'client'),
      'tags', v_tags
    ),
    v_job_id,
    null
  );

  return v_job_id;
end;
$$;

grant execute on function public.api_create_job(uuid, text, text, text, text[]) to authenticated;
