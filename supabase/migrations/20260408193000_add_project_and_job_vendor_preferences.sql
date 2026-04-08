-- Task 021: Per-project and per-job vendor preferences for client quote requests.
--
-- Adds persisted vendor preference scopes and merges them into quote fan-out
-- before vendor_quote_results and work_queue rows are created.
--
-- Rollback path:
-- 1) Drop api_set/api_get vendor preference functions.
-- 2) Drop project_vendor_preferences + job_vendor_preferences tables.
-- 3) Restore api_request_quote to the previous helper call signature.

create table if not exists public.project_vendor_preferences (
  project_id uuid primary key references public.projects(id) on delete cascade,
  included_vendors public.vendor_name[] not null default '{}'::public.vendor_name[],
  excluded_vendors public.vendor_name[] not null default '{}'::public.vendor_name[],
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint project_vendor_preferences_no_overlap
    check (not (included_vendors && excluded_vendors))
);

create table if not exists public.job_vendor_preferences (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  included_vendors public.vendor_name[] not null default '{}'::public.vendor_name[],
  excluded_vendors public.vendor_name[] not null default '{}'::public.vendor_name[],
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint job_vendor_preferences_no_overlap
    check (not (included_vendors && excluded_vendors))
);

alter table public.project_vendor_preferences enable row level security;
alter table public.job_vendor_preferences enable row level security;

drop policy if exists "project_vendor_preferences_select" on public.project_vendor_preferences;
create policy "project_vendor_preferences_select"
on public.project_vendor_preferences
for select
to authenticated
using (public.user_can_access_project(project_id));

drop policy if exists "job_vendor_preferences_select" on public.job_vendor_preferences;
create policy "job_vendor_preferences_select"
on public.job_vendor_preferences
for select
to authenticated
using (public.user_can_access_job(job_id));

drop trigger if exists touch_project_vendor_preferences_updated_at on public.project_vendor_preferences;
create trigger touch_project_vendor_preferences_updated_at
before update on public.project_vendor_preferences
for each row execute function public.touch_updated_at();

drop trigger if exists touch_job_vendor_preferences_updated_at on public.job_vendor_preferences;
create trigger touch_job_vendor_preferences_updated_at
before update on public.job_vendor_preferences
for each row execute function public.touch_updated_at();

grant select on public.project_vendor_preferences to authenticated;
grant select on public.job_vendor_preferences to authenticated;

create or replace function public.normalize_vendor_name_array(
  p_vendors public.vendor_name[]
)
returns public.vendor_name[]
language sql
immutable
as $$
  select coalesce(
    array_agg(distinct item.vendor order by item.vendor),
    array[]::public.vendor_name[]
  )
  from unnest(coalesce(p_vendors, array[]::public.vendor_name[])) as item(vendor);
$$;

grant execute on function public.normalize_vendor_name_array(public.vendor_name[]) to authenticated;

create or replace function public.build_vendor_preferences_json(
  p_included_vendors public.vendor_name[],
  p_excluded_vendors public.vendor_name[],
  p_updated_at timestamptz
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'includedVendors',
    to_jsonb(coalesce(p_included_vendors, array[]::public.vendor_name[])),
    'excludedVendors',
    to_jsonb(coalesce(p_excluded_vendors, array[]::public.vendor_name[])),
    'updatedAt',
    p_updated_at
  );
$$;

grant execute on function public.build_vendor_preferences_json(public.vendor_name[], public.vendor_name[], timestamptz) to authenticated;

create or replace function public.get_enabled_client_quote_vendors(
  p_organization_id uuid,
  p_project_id uuid,
  p_job_id uuid
)
returns public.vendor_name[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_baseline_vendors public.vendor_name[] := coalesce(
    public.get_enabled_client_quote_vendors(p_organization_id),
    array[]::public.vendor_name[]
  );
  v_enabled_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_project_included public.vendor_name[] := array[]::public.vendor_name[];
  v_project_excluded public.vendor_name[] := array[]::public.vendor_name[];
  v_job_included public.vendor_name[] := array[]::public.vendor_name[];
  v_job_excluded public.vendor_name[] := array[]::public.vendor_name[];
begin
  if p_project_id is not null then
    select
      coalesce(pref.included_vendors, array[]::public.vendor_name[]),
      coalesce(pref.excluded_vendors, array[]::public.vendor_name[])
    into
      v_project_included,
      v_project_excluded
    from public.project_vendor_preferences pref
    where pref.project_id = p_project_id;

    v_project_included := public.normalize_vendor_name_array(v_project_included);
    v_project_excluded := public.normalize_vendor_name_array(v_project_excluded);
  end if;

  if p_job_id is not null then
    select
      coalesce(pref.included_vendors, array[]::public.vendor_name[]),
      coalesce(pref.excluded_vendors, array[]::public.vendor_name[])
    into
      v_job_included,
      v_job_excluded
    from public.job_vendor_preferences pref
    where pref.job_id = p_job_id;

    v_job_included := public.normalize_vendor_name_array(v_job_included);
    v_job_excluded := public.normalize_vendor_name_array(v_job_excluded);
  end if;

  select coalesce(array_agg(vendor_row.vendor order by vendor_row.vendor), array[]::public.vendor_name[])
  into v_enabled_vendors
  from unnest(v_baseline_vendors) as vendor_row(vendor)
  where case
    when vendor_row.vendor = any(v_job_included) then true
    when vendor_row.vendor = any(v_job_excluded) then false
    else
      (cardinality(v_project_included) = 0 or vendor_row.vendor = any(v_project_included))
      and vendor_row.vendor <> all(v_project_excluded)
  end;

  return v_enabled_vendors;
end;
$$;

-- Keep the three-argument resolver internal to guarded definer RPCs.
revoke execute on function public.get_enabled_client_quote_vendors(uuid, uuid, uuid) from authenticated;
revoke all on function public.get_enabled_client_quote_vendors(uuid, uuid, uuid) from public;

create or replace function public.api_get_job_vendor_preferences(
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_project_preferences public.project_vendor_preferences%rowtype;
  v_job_preferences public.job_vendor_preferences%rowtype;
  v_empty_vendor_array public.vendor_name[] := array[]::public.vendor_name[];
  v_available_vendors public.vendor_name[] := v_empty_vendor_array;
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
    raise exception 'You do not have permission to inspect vendor preferences for job %.', p_job_id;
  end if;

  if v_job.project_id is not null then
    select *
    into v_project_preferences
    from public.project_vendor_preferences
    where project_id = v_job.project_id;
  end if;

  select *
  into v_job_preferences
  from public.job_vendor_preferences
  where job_id = v_job.id;

  v_available_vendors := coalesce(
    public.get_enabled_client_quote_vendors(v_job.organization_id),
    v_empty_vendor_array
  );

  return jsonb_build_object(
    'jobId', v_job.id,
    'projectId', v_job.project_id,
    'organizationId', v_job.organization_id,
    'availableVendors', to_jsonb(v_available_vendors),
    'projectVendorPreferences', public.build_vendor_preferences_json(
      coalesce(v_project_preferences.included_vendors, v_empty_vendor_array),
      coalesce(v_project_preferences.excluded_vendors, v_empty_vendor_array),
      v_project_preferences.updated_at
    ),
    'jobVendorPreferences', public.build_vendor_preferences_json(
      coalesce(v_job_preferences.included_vendors, v_empty_vendor_array),
      coalesce(v_job_preferences.excluded_vendors, v_empty_vendor_array),
      v_job_preferences.updated_at
    )
  );
end;
$$;

grant execute on function public.api_get_job_vendor_preferences(uuid) to authenticated;

create or replace function public.api_set_project_vendor_preferences(
  p_project_id uuid,
  p_included_vendors public.vendor_name[] default '{}'::public.vendor_name[],
  p_excluded_vendors public.vendor_name[] default '{}'::public.vendor_name[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.projects%rowtype;
  v_included public.vendor_name[] := public.normalize_vendor_name_array(p_included_vendors);
  v_excluded public.vendor_name[] := public.normalize_vendor_name_array(p_excluded_vendors);
  v_allowed_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_disallowed_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_updated_at timestamptz := null;
begin
  perform public.require_verified_auth();

  select *
  into v_project
  from public.projects
  where id = p_project_id;

  if v_project.id is null then
    raise exception 'Project % not found.', p_project_id;
  end if;

  if not public.user_can_edit_project(v_project.id) then
    raise exception 'You do not have permission to edit vendor preferences for project %.', p_project_id;
  end if;

  v_allowed_vendors := coalesce(
    public.get_enabled_client_quote_vendors(v_project.organization_id),
    array[]::public.vendor_name[]
  );

  select coalesce(array_agg(distinct vendor_row.vendor order by vendor_row.vendor), array[]::public.vendor_name[])
  into v_disallowed_vendors
  from (
    select unnest(v_included) as vendor
    union all
    select unnest(v_excluded) as vendor
  ) as vendor_row
  where vendor_row.vendor <> all(v_allowed_vendors);

  if cardinality(v_disallowed_vendors) > 0 then
    raise exception
      'Vendor preferences include unsupported vendors for project %: %.',
      p_project_id,
      array_to_string(v_disallowed_vendors, ', ');
  end if;

  select coalesce(array_agg(vendor_row.vendor order by vendor_row.vendor), array[]::public.vendor_name[])
  into v_excluded
  from unnest(v_excluded) as vendor_row(vendor)
  where vendor_row.vendor <> all(v_included);

  if cardinality(v_included) = 0 and cardinality(v_excluded) = 0 then
    delete from public.project_vendor_preferences pref
    where pref.project_id = p_project_id;
  else
    insert into public.project_vendor_preferences (
      project_id,
      included_vendors,
      excluded_vendors
    )
    values (
      p_project_id,
      v_included,
      v_excluded
    )
    on conflict (project_id)
    do update set
      included_vendors = excluded.included_vendors,
      excluded_vendors = excluded.excluded_vendors
    returning updated_at into v_updated_at;
  end if;

  return jsonb_build_object('projectId', p_project_id)
    || public.build_vendor_preferences_json(v_included, v_excluded, v_updated_at);
end;
$$;

grant execute on function public.api_set_project_vendor_preferences(uuid, public.vendor_name[], public.vendor_name[]) to authenticated;

create or replace function public.api_set_job_vendor_preferences(
  p_job_id uuid,
  p_included_vendors public.vendor_name[] default '{}'::public.vendor_name[],
  p_excluded_vendors public.vendor_name[] default '{}'::public.vendor_name[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_included public.vendor_name[] := public.normalize_vendor_name_array(p_included_vendors);
  v_excluded public.vendor_name[] := public.normalize_vendor_name_array(p_excluded_vendors);
  v_allowed_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_disallowed_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_updated_at timestamptz := null;
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
    raise exception 'You do not have permission to edit vendor preferences for job %.', p_job_id;
  end if;

  v_allowed_vendors := coalesce(
    public.get_enabled_client_quote_vendors(v_job.organization_id),
    array[]::public.vendor_name[]
  );

  select coalesce(array_agg(distinct vendor_row.vendor order by vendor_row.vendor), array[]::public.vendor_name[])
  into v_disallowed_vendors
  from (
    select unnest(v_included) as vendor
    union all
    select unnest(v_excluded) as vendor
  ) as vendor_row
  where vendor_row.vendor <> all(v_allowed_vendors);

  if cardinality(v_disallowed_vendors) > 0 then
    raise exception
      'Vendor preferences include unsupported vendors for job %: %.',
      p_job_id,
      array_to_string(v_disallowed_vendors, ', ');
  end if;

  select coalesce(array_agg(vendor_row.vendor order by vendor_row.vendor), array[]::public.vendor_name[])
  into v_excluded
  from unnest(v_excluded) as vendor_row(vendor)
  where vendor_row.vendor <> all(v_included);

  if cardinality(v_included) = 0 and cardinality(v_excluded) = 0 then
    delete from public.job_vendor_preferences pref
    where pref.job_id = p_job_id;
  else
    insert into public.job_vendor_preferences (
      job_id,
      included_vendors,
      excluded_vendors
    )
    values (
      p_job_id,
      v_included,
      v_excluded
    )
    on conflict (job_id)
    do update set
      included_vendors = excluded.included_vendors,
      excluded_vendors = excluded.excluded_vendors
    returning updated_at into v_updated_at;
  end if;

  return jsonb_build_object('jobId', p_job_id)
    || public.build_vendor_preferences_json(v_included, v_excluded, v_updated_at);
end;
$$;

grant execute on function public.api_set_job_vendor_preferences(uuid, public.vendor_name[], public.vendor_name[]) to authenticated;

-- Patch api_request_quote in place without duplicating the full function body.
-- Rationale:
-- - Uses pg_get_functiondef + replace(v_old_call, v_new_call) to keep this
--   migration narrowly scoped to the vendor-helper callsite only.
-- - Avoids recreating the full function body in this migration, which reduces
--   duplication and drift risk while preserving behavior outside this call.
--
-- Safety checks:
-- - position(v_new_call in v_definition) > 0 makes the patch idempotent.
-- - v_updated_definition = v_definition raises when replacement did not occur.
--
-- Rollback guidance:
-- - Restore the original function text by recreating
--   public.api_request_quote(uuid, boolean) with the previous helper call
--   signature (public.get_enabled_client_quote_vendors(v_job.organization_id)).
-- - Validate pg_get_functiondef output in staging before/after rollback and
--   across supported PostgreSQL versions.
do $$
declare
  v_definition text;
  v_updated_definition text;
  v_old_call text := 'public.get_enabled_client_quote_vendors(v_job.organization_id)';
  v_new_call text := 'public.get_enabled_client_quote_vendors(v_job.organization_id, v_job.project_id, v_job.id)';
begin
  select pg_get_functiondef('public.api_request_quote(uuid, boolean)'::regprocedure)
  into v_definition;

  if v_definition is null then
    raise exception 'Function public.api_request_quote(uuid, boolean) not found.';
  end if;

  if position(v_new_call in v_definition) > 0 then
    return;
  end if;

  v_updated_definition := replace(v_definition, v_old_call, v_new_call);

  if v_updated_definition = v_definition then
    raise exception 'Unable to patch public.api_request_quote(uuid, boolean); expected vendor helper call was not found.';
  end if;

  execute v_updated_definition;
end;
$$;
