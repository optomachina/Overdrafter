-- TODO-021: Per-project and per-job vendor preferences for client quote requests.
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
  v_enabled_vendors public.vendor_name[] := coalesce(
    public.get_enabled_client_quote_vendors(p_organization_id),
    array[]::public.vendor_name[]
  );
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

    if cardinality(v_project_included) > 0 then
      select coalesce(array_agg(vendor_row.vendor order by vendor_row.vendor), array[]::public.vendor_name[])
      into v_enabled_vendors
      from unnest(v_enabled_vendors) as vendor_row(vendor)
      where vendor_row.vendor = any(v_project_included);
    end if;

    if cardinality(v_project_excluded) > 0 then
      select coalesce(array_agg(vendor_row.vendor order by vendor_row.vendor), array[]::public.vendor_name[])
      into v_enabled_vendors
      from unnest(v_enabled_vendors) as vendor_row(vendor)
      where vendor_row.vendor <> all(v_project_excluded);
    end if;
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

    if cardinality(v_job_included) > 0 then
      select coalesce(array_agg(vendor_row.vendor order by vendor_row.vendor), array[]::public.vendor_name[])
      into v_enabled_vendors
      from unnest(v_enabled_vendors) as vendor_row(vendor)
      where vendor_row.vendor = any(v_job_included);
    end if;

    if cardinality(v_job_excluded) > 0 then
      select coalesce(array_agg(vendor_row.vendor order by vendor_row.vendor), array[]::public.vendor_name[])
      into v_enabled_vendors
      from unnest(v_enabled_vendors) as vendor_row(vendor)
      where vendor_row.vendor <> all(v_job_excluded);
    end if;
  end if;

  return v_enabled_vendors;
end;
$$;

grant execute on function public.get_enabled_client_quote_vendors(uuid, uuid, uuid) to authenticated;

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
  v_available_vendors public.vendor_name[] := array[]::public.vendor_name[];
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
    array[]::public.vendor_name[]
  );

  return jsonb_build_object(
    'jobId', v_job.id,
    'projectId', v_job.project_id,
    'organizationId', v_job.organization_id,
    'availableVendors', to_jsonb(v_available_vendors),
    'projectVendorPreferences', jsonb_build_object(
      'includedVendors', to_jsonb(coalesce(v_project_preferences.included_vendors, array[]::public.vendor_name[])),
      'excludedVendors', to_jsonb(coalesce(v_project_preferences.excluded_vendors, array[]::public.vendor_name[])),
      'updatedAt', v_project_preferences.updated_at
    ),
    'jobVendorPreferences', jsonb_build_object(
      'includedVendors', to_jsonb(coalesce(v_job_preferences.included_vendors, array[]::public.vendor_name[])),
      'excludedVendors', to_jsonb(coalesce(v_job_preferences.excluded_vendors, array[]::public.vendor_name[])),
      'updatedAt', v_job_preferences.updated_at
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
begin
  perform public.require_verified_auth();

  select *
  into v_project
  from public.projects
  where id = p_project_id;

  if v_project.id is null then
    raise exception 'Project % not found.', p_project_id;
  end if;

  if not public.user_can_access_project(v_project.id) then
    raise exception 'You do not have permission to edit vendor preferences for project %.', p_project_id;
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
      excluded_vendors = excluded.excluded_vendors;
  end if;

  return jsonb_build_object(
    'projectId', p_project_id,
    'includedVendors', to_jsonb(v_included),
    'excludedVendors', to_jsonb(v_excluded)
  );
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
      excluded_vendors = excluded.excluded_vendors;
  end if;

  return jsonb_build_object(
    'jobId', p_job_id,
    'includedVendors', to_jsonb(v_included),
    'excludedVendors', to_jsonb(v_excluded)
  );
end;
$$;

grant execute on function public.api_set_job_vendor_preferences(uuid, public.vendor_name[], public.vendor_name[]) to authenticated;

create or replace function public.api_request_quote(
  p_job_id uuid,
  p_force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_part_count integer := 0;
  v_quote_run_id uuid;
  v_existing_request public.quote_requests%rowtype;
  v_existing_quote_run public.quote_runs%rowtype;
  v_request_id uuid;
  v_service_request_line_item_id uuid;
  v_enabled_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_requested_vendors public.vendor_name[] := array[]::public.vendor_name[];
  v_requested_service_kinds text[] := '{}'::text[];
  v_is_quote_compatible boolean := false;
  v_guardrails jsonb;
  v_guardrails_enabled boolean := true;
  v_user_window_minutes integer := 60;
  v_user_max_requests_per_window integer := 5;
  v_org_pending_cost_ceiling_usd numeric(12, 2) := 500.00;
  v_default_cost_per_requested_lane_usd numeric(12, 2) := 75.00;
  v_user_request_count integer := 0;
  v_pending_estimated_cost_usd numeric(12, 2) := 0.00;
  v_new_request_lane_count integer := 0;
  v_estimated_new_request_cost_usd numeric(12, 2) := 0.00;
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
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;

  v_enabled_vendors := coalesce(
    public.get_enabled_client_quote_vendors(v_job.organization_id, v_job.project_id, v_job.id),
    array[]::public.vendor_name[]
  );
  v_requested_vendors := v_enabled_vendors;

  select count(*)::integer
  into v_part_count
  from public.parts part
  where part.job_id = p_job_id;

  select *
  into v_existing_request
  from public.quote_requests request_row
  where request_row.job_id = p_job_id
  order by request_row.created_at desc
  limit 1;

  if v_existing_request.id is not null then
    v_service_request_line_item_id := v_existing_request.service_request_line_item_id;

    if v_service_request_line_item_id is null then
      select line_item.id
      into v_service_request_line_item_id
      from public.service_request_line_items line_item
      where line_item.job_id = p_job_id
        and line_item.service_type = 'manufacturing_quote'
        and line_item.scope = 'part'
      limit 1;
    end if;

    select quote_run.*
    into v_existing_quote_run
    from public.quote_runs quote_run
    where quote_run.quote_request_id = v_existing_request.id
    limit 1;

    if v_existing_request.status in ('queued', 'requesting') then
      return jsonb_build_object(
        'jobId', p_job_id,
        'accepted', true,
        'created', false,
        'deduplicated', true,
        'quoteRequestId', v_existing_request.id,
        'quoteRunId', v_existing_quote_run.id,
        'serviceRequestLineItemId', v_service_request_line_item_id,
        'status', v_existing_request.status,
        'reasonCode', 'already_in_progress',
        'reason', 'A quote request is already active for this part.',
        'requestedVendors', to_jsonb(v_existing_request.requested_vendors)
      );
    end if;

    if v_existing_request.status = 'received' then
      return jsonb_build_object(
        'jobId', p_job_id,
        'accepted', false,
        'created', false,
        'deduplicated', false,
        'quoteRequestId', v_existing_request.id,
        'quoteRunId', v_existing_quote_run.id,
        'serviceRequestLineItemId', v_service_request_line_item_id,
        'status', v_existing_request.status,
        'reasonCode', 'already_received',
        'reason', 'A quote response has already been received for this part.',
        'requestedVendors', to_jsonb(v_existing_request.requested_vendors)
      );
    end if;

    if v_existing_request.status in ('failed', 'canceled') and not coalesce(p_force_retry, false) then
      return jsonb_build_object(
        'jobId', p_job_id,
        'accepted', false,
        'created', false,
        'deduplicated', false,
        'quoteRequestId', v_existing_request.id,
        'quoteRunId', v_existing_quote_run.id,
        'serviceRequestLineItemId', v_service_request_line_item_id,
        'status', v_existing_request.status,
        'reasonCode', 'retry_required',
        'reason', coalesce(v_existing_request.failure_reason, 'Retry the quote request to start vendor quote collection again.'),
        'requestedVendors', to_jsonb(v_existing_request.requested_vendors)
      );
    end if;
  end if;

  if v_existing_request.id is null then
    select *
    into v_existing_quote_run
    from public.quote_runs quote_run
    where quote_run.job_id = p_job_id
    order by quote_run.created_at desc
    limit 1;

    if v_existing_quote_run.id is not null then
      if v_job.status in ('quoting', 'awaiting_vendor_manual_review') or v_existing_quote_run.status in ('queued', 'running') then
        return jsonb_build_object(
          'jobId', p_job_id,
          'accepted', false,
          'created', false,
          'deduplicated', false,
          'quoteRequestId', null,
          'quoteRunId', v_existing_quote_run.id,
          'serviceRequestLineItemId', null,
          'status', 'requesting',
          'reasonCode', 'already_in_progress',
          'reason', 'Quote collection is already in progress for this part.',
          'requestedVendors', to_jsonb(v_requested_vendors)
        );
      end if;

      if v_job.status in ('internal_review', 'published', 'client_selected', 'closed')
        or v_existing_quote_run.status in ('completed', 'published') then
        return jsonb_build_object(
          'jobId', p_job_id,
          'accepted', false,
          'created', false,
          'deduplicated', false,
          'quoteRequestId', null,
          'quoteRunId', v_existing_quote_run.id,
          'serviceRequestLineItemId', null,
          'status', 'received',
          'reasonCode', 'already_received',
          'reason', 'A quote has already been requested for this part.',
          'requestedVendors', to_jsonb(v_requested_vendors)
        );
      end if;

      if v_existing_quote_run.status = 'failed' and not coalesce(p_force_retry, false) then
        return jsonb_build_object(
          'jobId', p_job_id,
          'accepted', false,
          'created', false,
          'deduplicated', false,
          'quoteRequestId', null,
          'quoteRunId', v_existing_quote_run.id,
          'serviceRequestLineItemId', null,
          'status', 'failed',
          'reasonCode', 'retry_required',
          'reason', 'A previous quote attempt failed. Retry to start vendor quote collection again.',
          'requestedVendors', to_jsonb(v_requested_vendors)
        );
      end if;
    end if;
  end if;

  v_requested_service_kinds := public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  );
  v_is_quote_compatible := exists (
    select 1
    from unnest(v_requested_service_kinds) as requested_service_kind(value)
    where value in ('manufacturing_quote', 'sourcing_only')
  );

  if v_job.archived_at is not null then
    return jsonb_build_object(
      'jobId', p_job_id,
      'accepted', false,
      'created', false,
      'deduplicated', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'serviceRequestLineItemId', null,
      'status', 'not_requested',
      'reasonCode', 'archived',
      'reason', 'Archived parts cannot request quotes.',
      'requestedVendors', to_jsonb(v_requested_vendors)
    );
  end if;

  if v_part_count = 0 then
    return jsonb_build_object(
      'jobId', p_job_id,
      'accepted', false,
      'created', false,
      'deduplicated', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'serviceRequestLineItemId', null,
      'status', 'not_requested',
      'reasonCode', 'missing_part',
      'reason', 'This job does not have a part revision ready for quoting yet.',
      'requestedVendors', to_jsonb(v_requested_vendors)
    );
  end if;

  if not coalesce(v_is_quote_compatible, false) then
    return jsonb_build_object(
      'jobId', p_job_id,
      'accepted', false,
      'created', false,
      'deduplicated', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'serviceRequestLineItemId', null,
      'status', 'not_requested',
      'reasonCode', 'unsupported_service_kind',
      'reason', 'Only manufacturing quote and sourcing-only requests can start vendor quote collection.',
      'requestedVendors', to_jsonb(v_requested_vendors)
    );
  end if;

  if exists (
    select 1
    from public.parts part
    where part.job_id = p_job_id
      and part.cad_file_id is null
  ) then
    return jsonb_build_object(
      'jobId', p_job_id,
      'accepted', false,
      'created', false,
      'deduplicated', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'serviceRequestLineItemId', null,
      'status', 'not_requested',
      'reasonCode', 'missing_cad',
      'reason', 'Upload a CAD model before requesting a quote.',
      'requestedVendors', to_jsonb(v_requested_vendors)
    );
  end if;

  if exists (
    select 1
    from public.parts part
    where part.job_id = p_job_id
      and not exists (
        select 1
        from public.approved_part_requirements requirement
        where requirement.part_id = part.id
      )
  ) then
    return jsonb_build_object(
      'jobId', p_job_id,
      'accepted', false,
      'created', false,
      'deduplicated', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'serviceRequestLineItemId', null,
      'status', 'not_requested',
      'reasonCode', 'missing_requirements',
      'reason', 'Finish the request details so OverDrafter can create approved quote requirements first.',
      'requestedVendors', to_jsonb(v_requested_vendors)
    );
  end if;

  select count(*)::integer
  into v_new_request_lane_count
  from (
    select
      enabled_vendor.vendor,
      part.id as part_id,
      requested_quantity.requested_quantity
    from public.parts part
    join public.approved_part_requirements requirement on requirement.part_id = part.id
    cross join lateral unnest(public.normalize_positive_integer_array(requirement.quote_quantities, requirement.quantity))
      as requested_quantity(requested_quantity)
    cross join lateral unnest(v_enabled_vendors) as enabled_vendor(vendor)
    where part.job_id = p_job_id
      and enabled_vendor.vendor = any(requirement.applicable_vendors)
  ) as eligible_lane;

  select coalesce(array_agg(enabled_vendor.vendor order by enabled_vendor.ordinality), array[]::public.vendor_name[])
  into v_requested_vendors
  from unnest(v_enabled_vendors) with ordinality as enabled_vendor(vendor, ordinality)
  where exists (
    select 1
    from public.parts part
    join public.approved_part_requirements requirement on requirement.part_id = part.id
    where part.job_id = p_job_id
      and enabled_vendor.vendor = any(requirement.applicable_vendors)
  );

  if coalesce(array_length(v_requested_vendors, 1), 0) = 0 then
    return jsonb_build_object(
      'jobId', p_job_id,
      'accepted', false,
      'created', false,
      'deduplicated', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'serviceRequestLineItemId', null,
      'status', 'not_requested',
      'reasonCode', 'no_enabled_vendors',
      'reason', 'No enabled vendors are available for this part in its current package state.',
      'requestedVendors', to_jsonb(v_requested_vendors)
    );
  end if;

  v_guardrails := public.get_quote_request_guardrails(v_job.organization_id);
  v_guardrails_enabled := coalesce((v_guardrails ->> 'enabled')::boolean, true);
  v_user_window_minutes := coalesce((v_guardrails ->> 'userWindowMinutes')::integer, 60);
  v_user_max_requests_per_window := coalesce((v_guardrails ->> 'userMaxRequestsPerWindow')::integer, 5);
  v_org_pending_cost_ceiling_usd := coalesce((v_guardrails ->> 'orgPendingCostCeilingUsd')::numeric(12, 2), 500.00);
  v_default_cost_per_requested_lane_usd :=
    coalesce((v_guardrails ->> 'defaultCostPerRequestedLaneUsd')::numeric(12, 2), 75.00);

  if v_guardrails_enabled then
    select count(*)::integer
    into v_user_request_count
    from public.quote_requests request_row
    where request_row.organization_id = v_job.organization_id
      and request_row.requested_by = auth.uid()
      and request_row.created_at >= timezone('utc', now()) - make_interval(mins => v_user_window_minutes);

    if v_user_request_count >= v_user_max_requests_per_window then
      perform public.log_audit_event(
        v_job.organization_id,
        'job.quote_request_rate_limited',
        jsonb_build_object(
          'jobId', p_job_id,
          'organizationId', v_job.organization_id,
          'quoteRequestGuardrail', v_guardrails,
          'requestedBy', auth.uid(),
          'userRequestCount', v_user_request_count,
          'estimatedNewRequestCostUsd', 0,
          'pendingEstimatedCostUsd', 0
        ),
        p_job_id,
        null
      );

      return jsonb_build_object(
        'jobId', p_job_id,
        'accepted', false,
        'created', false,
        'deduplicated', false,
        'quoteRequestId', null,
        'quoteRunId', null,
        'serviceRequestLineItemId', null,
        'status', 'not_requested',
        'reasonCode', 'rate_limited_user',
        'reason', 'You have reached the quote request limit for now. Try again later or contact your estimator.',
        'requestedVendors', to_jsonb(v_requested_vendors)
      );
    end if;

    v_pending_estimated_cost_usd := public.get_quote_request_pending_estimated_cost_usd(v_job.organization_id);
    v_estimated_new_request_cost_usd :=
      round((v_new_request_lane_count::numeric * v_default_cost_per_requested_lane_usd)::numeric, 2);

    if v_pending_estimated_cost_usd + v_estimated_new_request_cost_usd > v_org_pending_cost_ceiling_usd then
      perform public.log_audit_event(
        v_job.organization_id,
        'job.quote_request_cost_ceiling_blocked',
        jsonb_build_object(
          'jobId', p_job_id,
          'organizationId', v_job.organization_id,
          'quoteRequestGuardrail', v_guardrails,
          'requestedBy', auth.uid(),
          'estimatedNewRequestCostUsd', v_estimated_new_request_cost_usd,
          'pendingEstimatedCostUsd', v_pending_estimated_cost_usd
        ),
        p_job_id,
        null
      );

      return jsonb_build_object(
        'jobId', p_job_id,
        'accepted', false,
        'created', false,
        'deduplicated', false,
        'quoteRequestId', null,
        'quoteRunId', null,
        'serviceRequestLineItemId', null,
        'status', 'not_requested',
        'reasonCode', 'org_cost_ceiling_reached',
        'reason', 'Quote requests are temporarily paused for this workspace while current vendor quote requests are still in flight.',
        'requestedVendors', to_jsonb(v_requested_vendors)
      );
    end if;
  end if;

  insert into public.service_request_line_items (
    organization_id,
    project_id,
    job_id,
    service_type,
    scope,
    status,
    service_detail
  )
  values (
    v_job.organization_id,
    v_job.project_id,
    p_job_id,
    'manufacturing_quote',
    'part',
    'open',
    public.build_manufacturing_quote_service_detail(p_job_id)
  )
  on conflict (job_id, service_type, scope) where job_id is not null do update
  set
    organization_id = excluded.organization_id,
    project_id = coalesce(excluded.project_id, public.service_request_line_items.project_id),
    service_detail = coalesce(public.service_request_line_items.service_detail, '{}'::jsonb) || excluded.service_detail,
    updated_at = timezone('utc', now())
  returning id into v_service_request_line_item_id;

  insert into public.quote_requests (
    organization_id,
    job_id,
    requested_by,
    requested_vendors,
    service_request_line_item_id,
    status
  )
  values (
    v_job.organization_id,
    p_job_id,
    auth.uid(),
    v_requested_vendors,
    v_service_request_line_item_id,
    'queued'
  )
  returning id into v_request_id;

  insert into public.quote_runs (
    quote_request_id,
    job_id,
    organization_id,
    initiated_by,
    status,
    requested_auto_publish
  )
  values (
    v_request_id,
    p_job_id,
    v_job.organization_id,
    auth.uid(),
    'queued',
    false
  )
  returning id into v_quote_run_id;

  insert into public.vendor_quote_results (
    quote_run_id,
    part_id,
    organization_id,
    vendor,
    requested_quantity,
    status
  )
  select
    v_quote_run_id,
    part.id,
    v_job.organization_id,
    enabled_vendor.vendor,
    requested_quantity.requested_quantity,
    'queued'
  from public.parts part
  join public.approved_part_requirements requirement on requirement.part_id = part.id
  cross join lateral unnest(public.normalize_positive_integer_array(requirement.quote_quantities, requirement.quantity))
    as requested_quantity(requested_quantity)
  cross join lateral unnest(v_enabled_vendors) as enabled_vendor(vendor)
  where part.job_id = p_job_id
    and enabled_vendor.vendor = any(requirement.applicable_vendors);

  insert into public.work_queue (
    organization_id,
    job_id,
    part_id,
    quote_run_id,
    task_type,
    payload
  )
  select
    v_job.organization_id,
    p_job_id,
    result.part_id,
    v_quote_run_id,
    'run_vendor_quote',
    jsonb_build_object(
      'quoteRequestId', v_request_id,
      'quoteRunId', v_quote_run_id,
      'serviceRequestLineItemId', v_service_request_line_item_id,
      'partId', result.part_id,
      'vendor', result.vendor,
      'vendorQuoteResultId', result.id,
      'requestedQuantity', result.requested_quantity,
      'source', 'client-request-quote'
    )
  from public.vendor_quote_results result
  where result.quote_run_id = v_quote_run_id;

  update public.jobs
  set status = 'quoting'
  where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.quote_run_started',
    jsonb_build_object(
      'quoteRequestId', v_request_id,
      'quoteRunId', v_quote_run_id,
      'serviceRequestLineItemId', v_service_request_line_item_id,
      'clientTriggered', true,
      'requestedVendors', v_requested_vendors
    ),
    p_job_id,
    null
  );

  return jsonb_build_object(
    'jobId', p_job_id,
    'accepted', true,
    'created', true,
    'deduplicated', false,
    'quoteRequestId', v_request_id,
    'quoteRunId', v_quote_run_id,
    'serviceRequestLineItemId', v_service_request_line_item_id,
    'status', 'queued',
    'reasonCode', null,
    'reason', null,
    'requestedVendors', to_jsonb(v_requested_vendors)
  );
end;
$$;
