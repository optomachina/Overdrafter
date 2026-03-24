create table if not exists public.service_request_line_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  job_id uuid references public.jobs(id) on delete cascade,
  service_type text not null,
  scope text not null default 'part',
  status text not null default 'open',
  service_detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint service_request_line_items_target_check check (
    project_id is not null or job_id is not null
  ),
  constraint service_request_line_items_service_type_check check (
    service_type in (
      'manufacturing_quote',
      'cad_modeling',
      'drawing_redraft',
      'fea_analysis',
      'dfm_review',
      'dfa_review',
      'assembly_support',
      'sourcing_only'
    )
  ),
  constraint service_request_line_items_scope_check check (
    scope in ('part', 'assembly', 'project')
  )
);

create unique index if not exists idx_service_request_line_items_job_service_scope
on public.service_request_line_items(job_id, service_type, scope)
where job_id is not null;

create index if not exists idx_service_request_line_items_project_service_scope
on public.service_request_line_items(project_id, service_type, scope)
where project_id is not null;

alter table public.service_request_line_items enable row level security;

drop policy if exists "service_request_line_items_select_accessible" on public.service_request_line_items;
create policy "service_request_line_items_select_accessible"
on public.service_request_line_items
for select
to authenticated
using (
  (job_id is not null and public.user_can_access_job(job_id))
  or
  (job_id is null and project_id is not null and public.user_can_access_project(project_id))
);

drop trigger if exists touch_service_request_line_items_updated_at on public.service_request_line_items;
create trigger touch_service_request_line_items_updated_at
before update on public.service_request_line_items
for each row execute function public.touch_updated_at();

grant select on public.service_request_line_items to authenticated;

alter table public.quote_requests
add column if not exists service_request_line_item_id uuid
references public.service_request_line_items(id) on delete set null;

create index if not exists idx_quote_requests_service_request_line_item_created_at
on public.quote_requests(service_request_line_item_id, created_at desc)
where service_request_line_item_id is not null;

create or replace function public.build_manufacturing_quote_service_detail(
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_requested_service_kinds text[];
begin
  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  v_requested_service_kinds := public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  );

  return jsonb_build_object(
    'origin', 'phase_2_quote_request_transition',
    'requestBridge', jsonb_build_object(
      'requestedServiceKinds', to_jsonb(v_requested_service_kinds),
      'primaryServiceKind', v_job.primary_service_kind,
      'serviceNotes', v_job.service_notes
    ),
    'quoteRequest', jsonb_build_object(
      'requestedQuoteQuantities', to_jsonb(coalesce(v_job.requested_quote_quantities, '{}'::integer[])),
      'requestedByDate', v_job.requested_by_date
    )
  );
end;
$$;

insert into public.service_request_line_items (
  organization_id,
  project_id,
  job_id,
  service_type,
  scope,
  status,
  service_detail
)
select distinct on (job.id)
  job.organization_id,
  job.project_id,
  job.id,
  'manufacturing_quote',
  'part',
  'open',
  public.build_manufacturing_quote_service_detail(job.id)
from public.quote_requests request_row
join public.jobs job on job.id = request_row.job_id
order by job.id, request_row.created_at desc
on conflict (job_id, service_type, scope) where job_id is not null do update
set
  organization_id = excluded.organization_id,
  project_id = coalesce(excluded.project_id, public.service_request_line_items.project_id),
  service_detail = coalesce(public.service_request_line_items.service_detail, '{}'::jsonb) || excluded.service_detail,
  updated_at = timezone('utc', now());

update public.quote_requests request_row
set service_request_line_item_id = line_item.id
from public.service_request_line_items line_item
where request_row.job_id = line_item.job_id
  and line_item.service_type = 'manufacturing_quote'
  and line_item.scope = 'part'
  and request_row.service_request_line_item_id is distinct from line_item.id;

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
      'serviceRequestLineItemId', null,
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
      'serviceRequestLineItemId', null,
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
        'serviceRequestLineItemId', null,
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
        'serviceRequestLineItemId', null,
        'status', 'not_requested',
        'reasonCode', 'org_cost_ceiling_reached',
        'reason', 'Quote requests are temporarily paused for this workspace while current Xometry requests are still in flight.',
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
