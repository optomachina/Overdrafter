create table if not exists public.quote_request_guardrails (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  user_window_minutes integer not null default 60,
  user_max_requests_per_window integer not null default 5,
  org_pending_cost_ceiling_usd numeric(12, 2) not null default 500.00,
  default_cost_per_requested_lane_usd numeric(12, 2) not null default 75.00,
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint quote_request_guardrails_user_window_minutes_check check (user_window_minutes > 0),
  constraint quote_request_guardrails_user_max_requests_check check (user_max_requests_per_window >= 0),
  constraint quote_request_guardrails_org_pending_cost_ceiling_check check (org_pending_cost_ceiling_usd >= 0),
  constraint quote_request_guardrails_default_cost_per_lane_check check (default_cost_per_requested_lane_usd >= 0)
);

alter table public.quote_request_guardrails enable row level security;

drop policy if exists "quote_request_guardrails_internal_select" on public.quote_request_guardrails;
create policy "quote_request_guardrails_internal_select"
on public.quote_request_guardrails
for select
to authenticated
using (public.is_internal_user(organization_id));

drop trigger if exists touch_quote_request_guardrails_updated_at on public.quote_request_guardrails;
create trigger touch_quote_request_guardrails_updated_at
before update on public.quote_request_guardrails
for each row execute function public.touch_updated_at();

grant select on public.quote_request_guardrails to authenticated;

create or replace function public.get_quote_request_guardrails(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guardrail public.quote_request_guardrails%rowtype;
begin
  select *
  into v_guardrail
  from public.quote_request_guardrails
  where organization_id = p_organization_id;

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'userWindowMinutes', coalesce(v_guardrail.user_window_minutes, 60),
    'userMaxRequestsPerWindow', coalesce(v_guardrail.user_max_requests_per_window, 5),
    'orgPendingCostCeilingUsd', coalesce(v_guardrail.org_pending_cost_ceiling_usd, 500.00),
    'defaultCostPerRequestedLaneUsd', coalesce(v_guardrail.default_cost_per_requested_lane_usd, 75.00),
    'enabled', coalesce(v_guardrail.enabled, true)
  );
end;
$$;

create or replace function public.get_quote_request_pending_estimated_cost_usd(
  p_organization_id uuid
)
returns numeric(12, 2)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guardrails jsonb := public.get_quote_request_guardrails(p_organization_id);
  v_default_cost_per_requested_lane_usd numeric(12, 2) :=
    coalesce((v_guardrails ->> 'defaultCostPerRequestedLaneUsd')::numeric(12, 2), 75.00);
  v_pending_lane_count integer := 0;
begin
  select count(*)::integer
  into v_pending_lane_count
  from public.vendor_quote_results result
  join public.quote_runs quote_run on quote_run.id = result.quote_run_id
  join public.quote_requests request_row on request_row.id = quote_run.quote_request_id
  where result.organization_id = p_organization_id
    and result.vendor = 'xometry'
    and request_row.status in ('queued', 'requesting');

  return round((v_pending_lane_count::numeric * v_default_cost_per_requested_lane_usd)::numeric, 2);
end;
$$;

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
  v_requested_vendors public.vendor_name[] := array['xometry']::public.vendor_name[];
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
        'status', v_existing_request.status,
        'reasonCode', 'retry_required',
        'reason', coalesce(v_existing_request.failure_reason, 'Retry the quote request to try Xometry again.'),
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
          'status', 'failed',
          'reasonCode', 'retry_required',
          'reason', 'A previous quote attempt failed. Retry to start Xometry again.',
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
      'status', 'not_requested',
      'reasonCode', 'missing_cad',
      'reason', 'Upload a CAD model before requesting a quote from Xometry.',
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
      'status', 'not_requested',
      'reasonCode', 'missing_requirements',
      'reason', 'Finish the request details so OverDrafter can create approved quote requirements first.',
      'requestedVendors', to_jsonb(v_requested_vendors)
    );
  end if;

  if exists (
    select 1
    from public.parts part
    join public.approved_part_requirements requirement on requirement.part_id = part.id
    where part.job_id = p_job_id
      and not ('xometry' = any(requirement.applicable_vendors))
  ) then
    return jsonb_build_object(
      'jobId', p_job_id,
      'accepted', false,
      'created', false,
      'deduplicated', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'status', 'not_requested',
      'reasonCode', 'xometry_unavailable',
      'reason', 'Xometry is not available for this part in its current package state.',
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
        'status', 'not_requested',
        'reasonCode', 'rate_limited_user',
        'reason', 'You have reached the quote request limit for now. Try again later or contact your estimator.',
        'requestedVendors', to_jsonb(v_requested_vendors)
      );
    end if;

    select count(*)::integer
    into v_new_request_lane_count
    from public.parts part
    join public.approved_part_requirements requirement on requirement.part_id = part.id
    cross join lateral unnest(public.normalize_positive_integer_array(requirement.quote_quantities, requirement.quantity))
      as requested_quantity
    where part.job_id = p_job_id
      and 'xometry' = any(requirement.applicable_vendors);

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
        'status', 'not_requested',
        'reasonCode', 'org_cost_ceiling_reached',
        'reason', 'Quote requests are temporarily paused for this workspace while current Xometry requests are still in flight.',
        'requestedVendors', to_jsonb(v_requested_vendors)
      );
    end if;
  end if;

  insert into public.quote_requests (
    organization_id,
    job_id,
    requested_by,
    requested_vendors,
    status
  )
  values (
    v_job.organization_id,
    p_job_id,
    auth.uid(),
    v_requested_vendors,
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
    'xometry'::public.vendor_name,
    requested_quantity,
    'queued'
  from public.parts part
  join public.approved_part_requirements requirement on requirement.part_id = part.id
  cross join lateral unnest(public.normalize_positive_integer_array(requirement.quote_quantities, requirement.quantity))
    as requested_quantity
  where part.job_id = p_job_id
    and 'xometry' = any(requirement.applicable_vendors);

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
    'status', 'queued',
    'reasonCode', null,
    'reason', null,
    'requestedVendors', to_jsonb(v_requested_vendors)
  );
end;
$$;

grant execute on function public.get_quote_request_guardrails(uuid) to authenticated;
grant execute on function public.get_quote_request_pending_estimated_cost_usd(uuid) to authenticated;
grant execute on function public.api_request_quote(uuid, boolean) to authenticated;
