-- OVD-346
-- Replace permanent job-history blocking with per-vendor, per-part, per-quantity
-- eligibility derived from immutable disclosure scopes and explicit commercial
-- validity. Existing entitlement, rollout, rate, cost, and authorization gates
-- remain authoritative.
--
-- Rollback: disable callers of api_request_quote_scoped, restore the public
-- compatibility wrappers from 20260802015500, then drop the functions, policy,
-- trigger, columns, and index added here. Retaining lane history is safe.

alter table public.quote_request_guardrails
add column if not exists same_scope_cooldown_minutes integer not null default 1440;

alter table public.quote_request_guardrails
drop constraint if exists quote_request_guardrails_same_scope_cooldown_minutes_check;

alter table public.quote_request_guardrails
add constraint quote_request_guardrails_same_scope_cooldown_minutes_check
check (same_scope_cooldown_minutes >= 0);

alter table public.vendor_quote_offers
add column if not exists invalidated_at timestamptz,
add column if not exists invalidated_by uuid references auth.users(id) on delete restrict,
add column if not exists invalidation_reason text;

alter table public.vendor_quote_offers
drop constraint if exists vendor_quote_offers_invalidation_state_check;

alter table public.vendor_quote_offers
add constraint vendor_quote_offers_invalidation_state_check
  check (
    (invalidated_at is null and invalidated_by is null and invalidation_reason is null)
    or (
      invalidated_at is not null
      and invalidated_by is not null
      and length(trim(invalidation_reason)) between 1 and 1000
    )
  );

drop index if exists public.idx_vendor_quote_offers_validity;
create index idx_vendor_quote_offers_validity
on public.vendor_quote_offers(valid_until, vendor_quote_result_id)
where invalidated_at is null and valid_until is not null;

alter table public.quote_request_lanes
add column if not exists cooldown_released_at timestamptz,
add column if not exists cooldown_released_by_offer_id uuid
  references public.vendor_quote_offers(id) on delete set null;

revoke all on public.quote_request_lanes from public, anon, authenticated;
grant all on public.quote_request_lanes to service_role;

-- Disjoint lane groups may be active for one job. The job-level unique index
-- encoded the old permanent/single-round model; the job advisory lock and exact
-- lane eligibility checks below now serialize submissions safely.
drop index if exists public.idx_quote_requests_active_job;

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
    'sameScopeCooldownMinutes', coalesce(v_guardrail.same_scope_cooldown_minutes, 1440),
    'enabled', coalesce(v_guardrail.enabled, true)
  );
end;
$$;

create or replace function private.build_quote_lane_scope_snapshot(
  p_part_id uuid,
  p_vendor public.vendor_name,
  p_requested_quantity integer
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
      'schema', 'quote-lane-scope.v1',
      'vendor', p_vendor,
      'quantity', p_requested_quantity,
      'part', pg_catalog.jsonb_build_object(
        'id', part.id,
        'cad', case when cad_file.id is null then null else pg_catalog.jsonb_build_object(
          'fileId', cad_file.id,
          'sha256', cad_file.trusted_content_sha256,
          'name', cad_file.original_name,
          'mimeType', cad_file.mime_type,
          'sizeBytes', cad_file.size_bytes
        ) end,
        'drawing', case when drawing_file.id is null then null else pg_catalog.jsonb_build_object(
          'fileId', drawing_file.id,
          'sha256', drawing_file.trusted_content_sha256,
          'name', drawing_file.original_name,
          'mimeType', drawing_file.mime_type,
          'sizeBytes', drawing_file.size_bytes
        ) end
      ),
      'requirements', pg_catalog.jsonb_build_object(
        'id', requirement.id,
        'capturedAt', requirement.updated_at,
        'description', requirement.description,
        'partNumber', requirement.part_number,
        'revision', requirement.revision,
        'material', requirement.material,
        'finish', requirement.finish,
        'tightestToleranceInch', requirement.tightest_tolerance_inch,
        'requestedDeliveryDate', requirement.requested_by_date,
        'specification', requirement.spec_snapshot
      )
    )
  from public.parts part
  join public.approved_part_requirements requirement on requirement.part_id = part.id
  left join public.job_files cad_file on cad_file.id = part.cad_file_id
  left join public.job_files drawing_file on drawing_file.id = part.drawing_file_id
  where part.id = p_part_id;
$$;


create or replace function private.quote_lane_candidates(
  p_job_id uuid,
  p_selected_vendors public.vendor_name[] default null
)
returns table (
  organization_id uuid,
  part_id uuid,
  vendor public.vendor_name,
  requested_quantity integer,
  scope_version integer,
  scope_fingerprint text,
  scope_snapshot jsonb
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with requested as (
    select case
      when p_selected_vendors is null then public.get_enabled_client_quote_vendors(job.organization_id)
      else p_selected_vendors
    end as vendors
    from public.jobs job
    where job.id = p_job_id
  ), candidate as (
    select
      part.organization_id,
      part.id as part_id,
      selected_vendor.vendor,
      quantity.value as requested_quantity,
      1 as scope_version,
      private.build_quote_lane_scope_snapshot(part.id, selected_vendor.vendor, quantity.value) as scope_snapshot
    from public.parts part
    join public.approved_part_requirements requirement on requirement.part_id = part.id
    cross join requested
    cross join lateral unnest(coalesce(requested.vendors, array[]::public.vendor_name[]))
      as selected_vendor(vendor)
    cross join lateral unnest(
      public.normalize_positive_integer_array(requirement.quote_quantities, requirement.quantity)
    ) as quantity(value)
    where part.job_id = p_job_id
      and selected_vendor.vendor = any(requirement.applicable_vendors)
  )
  select
    candidate.organization_id,
    candidate.part_id,
    candidate.vendor,
    candidate.requested_quantity,
    candidate.scope_version,
    private.quote_scope_fingerprint(candidate.scope_snapshot),
    candidate.scope_snapshot
  from candidate;
$$;

create or replace function private.resolve_quote_lane_eligibility(
  p_job_id uuid,
  p_selected_vendors public.vendor_name[] default null,
  p_at timestamptz default timezone('utc', now())
)
returns table (
  organization_id uuid,
  part_id uuid,
  vendor public.vendor_name,
  requested_quantity integer,
  state text,
  current_offer_id uuid,
  valid_until timestamptz,
  retry_at timestamptz,
  quote_request_id uuid,
  scope_version integer,
  scope_fingerprint text,
  scope_snapshot jsonb
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    candidate.organization_id,
    candidate.part_id,
    candidate.vendor,
    candidate.requested_quantity,
    case
      when active_lane.quote_request_id is not null then 'active'
      when valid_offer.offer_id is not null then 'valid_quote'
      when cooldown_lane.retry_at is not null and cooldown_lane.retry_at > p_at then 'cooldown'
      else 'requestable'
    end as state,
    valid_offer.offer_id,
    valid_offer.valid_until,
    case
      when cooldown_lane.retry_at > p_at then cooldown_lane.retry_at
      else null
    end,
    active_lane.quote_request_id,
    candidate.scope_version,
    candidate.scope_fingerprint,
    candidate.scope_snapshot
  from private.quote_lane_candidates(p_job_id, p_selected_vendors) candidate
  left join lateral (
    select lane.quote_request_id
    from public.quote_request_lanes lane
    join public.quote_requests request_row on request_row.id = lane.quote_request_id
    where lane.organization_id = candidate.organization_id
      and lane.vendor = candidate.vendor
      and lane.requested_quantity = candidate.requested_quantity
      and lane.scope_version = candidate.scope_version
      and lane.scope_fingerprint = candidate.scope_fingerprint
      and request_row.status in ('queued', 'requesting')
    order by lane.created_at desc
    limit 1
  ) active_lane on true
  left join lateral (
    select offer.id as offer_id, offer.valid_until
    from public.quote_request_lanes lane
    join public.vendor_quote_results result on result.id = lane.vendor_quote_result_id
    join public.vendor_quote_offers offer on offer.vendor_quote_result_id = result.id
    where lane.organization_id = candidate.organization_id
      and lane.vendor = candidate.vendor
      and lane.requested_quantity = candidate.requested_quantity
      and lane.scope_version = candidate.scope_version
      and lane.scope_fingerprint = candidate.scope_fingerprint
      and result.status in ('instant_quote_received', 'official_quote_received')
      and offer.provenance_status in ('trusted_adapter', 'manual_verified')
      and (offer.total_price_usd is not null or offer.unit_price_usd is not null)
      and offer.valid_until is not null
      and offer.valid_until >= p_at
      and offer.invalidated_at is null
    order by offer.valid_until desc, offer.created_at desc
    limit 1
  ) valid_offer on true
  left join lateral (
    select lane.created_at + make_interval(
      mins => coalesce(guardrail.same_scope_cooldown_minutes, 1440)
    ) as retry_at
    from public.quote_request_lanes lane
    left join public.quote_request_guardrails guardrail
      on guardrail.organization_id = candidate.organization_id
    where lane.organization_id = candidate.organization_id
      and lane.vendor = candidate.vendor
      and lane.requested_quantity = candidate.requested_quantity
      and lane.scope_version = candidate.scope_version
      and lane.scope_fingerprint = candidate.scope_fingerprint
      and lane.cooldown_released_at is null
    order by lane.created_at desc
    limit 1
  ) cooldown_lane on true;
$$;

create or replace function public.api_get_quote_lane_eligibility(
  p_job_id uuid,
  p_selected_vendors public.vendor_name[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
begin
  perform public.require_verified_auth();

  select job_row.* into v_job
  from public.jobs job_row
  where job_row.id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_access_job(v_job.id) then
    raise exception 'You do not have permission to view quote eligibility for job %.', p_job_id;
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'vendor', eligibility.vendor,
        'partId', eligibility.part_id,
        'requestedQuantity', eligibility.requested_quantity,
        'state', eligibility.state,
        'currentOfferId', eligibility.current_offer_id,
        'validUntil', eligibility.valid_until,
        'retryAt', eligibility.retry_at
      )
      order by eligibility.vendor, eligibility.part_id, eligibility.requested_quantity
    )
    from private.resolve_quote_lane_eligibility(p_job_id, p_selected_vendors) eligibility
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.api_get_quote_lane_eligibility(uuid, public.vendor_name[])
from public, anon, authenticated, service_role;
grant execute on function public.api_get_quote_lane_eligibility(uuid, public.vendor_name[])
to authenticated;

create or replace function private.request_scoped_automatic_quote_impl(
  p_job_id uuid,
  p_selected_vendors public.vendor_name[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_available_vendors public.vendor_name[];
  v_selected_vendors public.vendor_name[];
  v_requested_vendors public.vendor_name[];
  v_requested_service_kinds text[];
  v_service_request_line_item_id uuid;
  v_request_id uuid;
  v_quote_run_id uuid;
  v_guardrails jsonb;
  v_user_request_count integer;
  v_pending_estimated_cost_usd numeric(12, 2);
  v_estimated_new_request_cost_usd numeric(12, 2);
  v_new_request_lane_count integer;
  v_all_lane_count integer;
  v_eligibility jsonb;
  v_active_request_id uuid;
  v_active_quote_run_id uuid;
begin
  select job_row.* into v_job
  from public.jobs job_row
  where job_row.id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;

  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('quote-lane-submit:' || p_job_id::text, 0)
  );

  if v_job.archived_at is not null then
    return pg_catalog.jsonb_build_object(
      'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
      'status', 'not_requested', 'reasonCode', 'archived',
      'reason', 'Archived parts cannot request quotes.', 'requestedVendors', '[]'::jsonb,
      'laneEligibility', '[]'::jsonb
    );
  end if;

  v_requested_service_kinds := public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  );
  if not exists (
    select 1 from unnest(v_requested_service_kinds) item(value)
    where item.value in ('manufacturing_quote', 'sourcing_only')
  ) then
    return pg_catalog.jsonb_build_object(
      'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
      'status', 'not_requested', 'reasonCode', 'unsupported_service_kind',
      'reason', 'Only manufacturing quote and sourcing-only requests can start vendor quote collection.',
      'requestedVendors', '[]'::jsonb, 'laneEligibility', '[]'::jsonb
    );
  end if;

  if not exists (select 1 from public.parts part where part.job_id = p_job_id) then
    return pg_catalog.jsonb_build_object(
      'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
      'status', 'not_requested', 'reasonCode', 'missing_part',
      'reason', 'This job does not have a part revision ready for quoting yet.',
      'requestedVendors', '[]'::jsonb, 'laneEligibility', '[]'::jsonb
    );
  end if;

  if exists (
    select 1 from public.parts part
    where part.job_id = p_job_id and part.cad_file_id is null
  ) then
    return pg_catalog.jsonb_build_object(
      'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
      'status', 'not_requested', 'reasonCode', 'missing_cad',
      'reason', 'Upload a CAD model before requesting a quote.',
      'requestedVendors', '[]'::jsonb, 'laneEligibility', '[]'::jsonb
    );
  end if;

  if exists (
    select 1
    from public.parts part
    join public.job_files cad_file on cad_file.id = part.cad_file_id
    left join public.job_files drawing_file on drawing_file.id = part.drawing_file_id
    where part.job_id = p_job_id
      and (
        cad_file.trusted_content_sha256 is null
        or (drawing_file.id is not null and drawing_file.trusted_content_sha256 is null)
      )
  ) then
    return pg_catalog.jsonb_build_object(
      'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
      'status', 'not_requested', 'reasonCode', 'files_still_verifying',
      'reason', 'File verification is still finishing. Try again shortly.',
      'requestedVendors', '[]'::jsonb, 'laneEligibility', '[]'::jsonb
    );
  end if;

  if exists (
    select 1 from public.parts part
    where part.job_id = p_job_id
      and not exists (
        select 1 from public.approved_part_requirements requirement
        where requirement.part_id = part.id
      )
  ) then
    return pg_catalog.jsonb_build_object(
      'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
      'status', 'not_requested', 'reasonCode', 'missing_requirements',
      'reason', 'Finish the request details before requesting a quote.',
      'requestedVendors', '[]'::jsonb, 'laneEligibility', '[]'::jsonb
    );
  end if;

  v_available_vendors := coalesce(
    public.get_enabled_client_quote_vendors(v_job.organization_id),
    array[]::public.vendor_name[]
  );

  select coalesce(array_agg(distinct selected.vendor order by selected.vendor), array[]::public.vendor_name[])
  into v_selected_vendors
  from unnest(coalesce(p_selected_vendors, v_available_vendors)) selected(vendor)
  where selected.vendor = any(v_available_vendors);

  if coalesce(array_length(v_selected_vendors, 1), 0) = 0 then
    return pg_catalog.jsonb_build_object(
      'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
      'status', 'not_requested', 'reasonCode', 'no_enabled_vendors',
      'reason', 'Select at least one enabled vendor for this quote request.',
      'requestedVendors', '[]'::jsonb, 'laneEligibility', '[]'::jsonb
    );
  end if;

  select count(*), count(*) filter (where state = 'requestable')
  into v_all_lane_count, v_new_request_lane_count
  from private.resolve_quote_lane_eligibility(p_job_id, v_selected_vendors);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'vendor', lane.vendor,
    'partId', lane.part_id,
    'requestedQuantity', lane.requested_quantity,
    'state', lane.state,
    'currentOfferId', lane.current_offer_id,
    'validUntil', lane.valid_until,
    'retryAt', lane.retry_at
  ) order by lane.vendor, lane.part_id, lane.requested_quantity), '[]'::jsonb)
  into v_eligibility
  from private.resolve_quote_lane_eligibility(p_job_id, v_selected_vendors) lane;

  if v_all_lane_count = 0 then
    return pg_catalog.jsonb_build_object(
      'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
      'status', 'not_requested', 'reasonCode', 'no_applicable_lanes',
      'reason', 'The selected vendors are not applicable to the approved part requirements.',
      'requestedVendors', pg_catalog.to_jsonb(v_selected_vendors),
      'laneEligibility', v_eligibility
    );
  end if;

  if v_new_request_lane_count = 0 then
    select lane.quote_request_id into v_active_request_id
    from private.resolve_quote_lane_eligibility(p_job_id, v_selected_vendors) lane
    where lane.state = 'active'
    order by lane.quote_request_id
    limit 1;

    if v_active_request_id is not null then
      select quote_run.id into v_active_quote_run_id
      from public.quote_runs quote_run
      where quote_run.quote_request_id = v_active_request_id
      limit 1;

      return pg_catalog.jsonb_build_object(
        'jobId', p_job_id, 'accepted', true, 'created', false, 'deduplicated', true,
        'quoteRequestId', v_active_request_id, 'quoteRunId', v_active_quote_run_id,
        'status', 'requesting', 'reasonCode', 'already_in_progress',
        'reason', 'A matching quote request is already active.',
        'requestedVendors', pg_catalog.to_jsonb(v_selected_vendors),
        'laneEligibility', v_eligibility
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
      'status', 'not_requested', 'reasonCode', 'all_lanes_covered',
      'reason', 'Every selected vendor and quantity is already covered. Review the current comparison or retry when eligible.',
      'requestedVendors', pg_catalog.to_jsonb(v_selected_vendors),
      'laneEligibility', v_eligibility
    );
  end if;

  -- Snapshot requestable candidates once. Re-running eligibility after the
  -- result trigger creates lanes would otherwise turn the remaining insert
  -- source into `active` and drop the later quantities/vendors.
  create temporary table if not exists pg_temp.requestable_quote_lanes (
    organization_id uuid,
    part_id uuid,
    vendor public.vendor_name,
    requested_quantity integer,
    scope_version integer,
    scope_fingerprint text,
    scope_snapshot jsonb
  ) on commit drop;
  truncate table pg_temp.requestable_quote_lanes;
  insert into pg_temp.requestable_quote_lanes
  select
    lane.organization_id, lane.part_id, lane.vendor, lane.requested_quantity,
    lane.scope_version, lane.scope_fingerprint, lane.scope_snapshot
  from private.resolve_quote_lane_eligibility(p_job_id, v_selected_vendors) lane
  where lane.state = 'requestable';

  v_guardrails := public.get_quote_request_guardrails(v_job.organization_id);
  if coalesce((v_guardrails ->> 'enabled')::boolean, true) then
    select count(*)::integer into v_user_request_count
    from public.quote_requests request_row
    where request_row.organization_id = v_job.organization_id
      and request_row.requested_by = auth.uid()
      and request_row.created_at >= timezone('utc', now()) - make_interval(
        mins => coalesce((v_guardrails ->> 'userWindowMinutes')::integer, 60)
      );

    if v_user_request_count >= coalesce((v_guardrails ->> 'userMaxRequestsPerWindow')::integer, 5) then
      return pg_catalog.jsonb_build_object(
        'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
        'status', 'not_requested', 'reasonCode', 'rate_limited_user',
        'reason', 'You have reached the quote request limit for now. Try again later or contact your estimator.',
        'requestedVendors', pg_catalog.to_jsonb(v_selected_vendors),
        'laneEligibility', v_eligibility
      );
    end if;

    v_pending_estimated_cost_usd := public.get_quote_request_pending_estimated_cost_usd(v_job.organization_id);
    v_estimated_new_request_cost_usd := round(
      v_new_request_lane_count::numeric
      * coalesce((v_guardrails ->> 'defaultCostPerRequestedLaneUsd')::numeric, 75.00),
      2
    );
    if v_pending_estimated_cost_usd + v_estimated_new_request_cost_usd
      > coalesce((v_guardrails ->> 'orgPendingCostCeilingUsd')::numeric, 500.00) then
      return pg_catalog.jsonb_build_object(
        'jobId', p_job_id, 'accepted', false, 'created', false, 'deduplicated', false,
        'status', 'not_requested', 'reasonCode', 'org_cost_ceiling_reached',
        'reason', 'Quote requests are temporarily paused while vendor requests are still in flight.',
        'requestedVendors', pg_catalog.to_jsonb(v_selected_vendors),
        'laneEligibility', v_eligibility
      );
    end if;
  end if;

  select coalesce(array_agg(distinct lane.vendor order by lane.vendor), array[]::public.vendor_name[])
  into v_requested_vendors
  from pg_temp.requestable_quote_lanes lane;

  insert into public.service_request_line_items (
    organization_id, project_id, job_id, service_type, scope, status, service_detail
  ) values (
    v_job.organization_id, v_job.project_id, p_job_id,
    'manufacturing_quote', 'part', 'open',
    public.build_manufacturing_quote_service_detail(p_job_id)
  )
  on conflict (job_id, service_type, scope) where job_id is not null do update
  set organization_id = excluded.organization_id,
      project_id = coalesce(excluded.project_id, public.service_request_line_items.project_id),
      service_detail = coalesce(public.service_request_line_items.service_detail, '{}'::jsonb) || excluded.service_detail,
      updated_at = timezone('utc', now())
  returning id into v_service_request_line_item_id;

  insert into public.quote_requests (
    organization_id, job_id, requested_by, requested_vendors,
    service_request_line_item_id, status
  ) values (
    v_job.organization_id, p_job_id, auth.uid(), v_requested_vendors,
    v_service_request_line_item_id, 'queued'
  ) returning id into v_request_id;

  insert into public.quote_runs (
    quote_request_id, job_id, organization_id, initiated_by, status, requested_auto_publish
  ) values (
    v_request_id, p_job_id, v_job.organization_id, auth.uid(), 'queued', false
  ) returning id into v_quote_run_id;

  insert into public.vendor_quote_results (
    quote_run_id, part_id, organization_id, vendor, requested_quantity, status
  )
  select v_quote_run_id, lane.part_id, lane.organization_id,
    lane.vendor, lane.requested_quantity, 'queued'
  from pg_temp.requestable_quote_lanes lane;

  -- Reserve exactly the requestable immutable scopes in this transaction.
  -- The worker's service-only registration call later verifies that the bytes
  -- and manufacturing payload about to be disclosed still match this record.
  insert into public.quote_request_lanes (
    organization_id, quote_request_id, quote_run_id, vendor_quote_result_id,
    part_id, vendor, requested_quantity, scope_version, scope_fingerprint,
    scope_snapshot
  )
  select
    lane.organization_id, v_request_id, v_quote_run_id, result.id,
    lane.part_id, lane.vendor, lane.requested_quantity, lane.scope_version,
    lane.scope_fingerprint, lane.scope_snapshot
  from pg_temp.requestable_quote_lanes lane
  join public.vendor_quote_results result
    on result.quote_run_id = v_quote_run_id
    and result.part_id = lane.part_id
    and result.vendor = lane.vendor
    and result.requested_quantity = lane.requested_quantity;


  insert into public.work_queue (
    organization_id, job_id, part_id, quote_run_id, task_type, payload
  )
  select
    v_job.organization_id, p_job_id, result.part_id, v_quote_run_id,
    'run_vendor_quote',
    pg_catalog.jsonb_build_object(
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

  update public.jobs set status = 'quoting' where id = p_job_id;

  perform public.log_audit_event(
    v_job.organization_id,
    'job.quote_run_started',
    pg_catalog.jsonb_build_object(
      'quoteRequestId', v_request_id,
      'quoteRunId', v_quote_run_id,
      'serviceRequestLineItemId', v_service_request_line_item_id,
      'clientTriggered', true,
      'requestedVendors', v_requested_vendors,
      'requestedLaneCount', v_new_request_lane_count
    ),
    p_job_id,
    null
  );

  return pg_catalog.jsonb_build_object(
    'jobId', p_job_id, 'accepted', true, 'created', true, 'deduplicated', false,
    'quoteRequestId', v_request_id, 'quoteRunId', v_quote_run_id,
    'serviceRequestLineItemId', v_service_request_line_item_id,
    'status', 'queued', 'reasonCode', null, 'reason', null,
    'requestedVendors', pg_catalog.to_jsonb(v_requested_vendors),
    'laneEligibility', v_eligibility
  );
end;
$$;

revoke all on function private.request_scoped_automatic_quote_impl(uuid, public.vendor_name[])
from public, anon, authenticated, service_role;

create or replace function private.require_automatic_quote_access(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_entitlements jsonb;
begin
  perform public.require_verified_auth();

  select job_row.* into v_job
  from public.jobs job_row
  where job_row.id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;
  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;

  v_entitlements := private.resolve_organization_entitlements_at(
    v_job.organization_id,
    pg_catalog.now()
  );
  if coalesce(v_entitlements -> 'automaticQuoteCollection' = 'true'::jsonb, false) is not true then
    return pg_catalog.jsonb_build_object(
      'jobId', v_job.id, 'accepted', false, 'created', false, 'deduplicated', false,
      'quoteRequestId', null, 'quoteRunId', null, 'serviceRequestLineItemId', null,
      'status', 'not_requested', 'reasonCode', 'pro_required',
      'reason', 'Automatic quote collection requires a Pro account.',
      'requestedVendors', pg_catalog.jsonb_build_array(),
      'laneEligibility', pg_catalog.jsonb_build_array(),
      'quoteMode', 'automatic'
    );
  end if;

  if not private.automatic_quote_rollout_enabled_with_lock() then
    return pg_catalog.jsonb_build_object(
      'jobId', v_job.id, 'accepted', false, 'created', false, 'deduplicated', false,
      'quoteRequestId', null, 'quoteRunId', null, 'serviceRequestLineItemId', null,
      'status', 'not_requested', 'reasonCode', 'automatic_quote_disabled',
      'reason', 'Automatic quote collection is temporarily unavailable. You can still request a manual quote.',
      'requestedVendors', pg_catalog.jsonb_build_array(),
      'laneEligibility', pg_catalog.jsonb_build_array(),
      'quoteMode', 'automatic'
    );
  end if;

  return null;
end;
$$;

revoke all on function private.require_automatic_quote_access(uuid)
from public, anon, authenticated, service_role;

create or replace function public.api_request_quote_scoped(
  p_job_id uuid,
  p_selected_vendors public.vendor_name[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_denial jsonb;
begin
  v_denial := private.require_automatic_quote_access(p_job_id);
  if v_denial is not null then
    return v_denial;
  end if;

  return private.request_scoped_automatic_quote_impl(p_job_id, p_selected_vendors)
    || pg_catalog.jsonb_build_object('quoteMode', 'automatic');
end;
$$;

revoke all on function public.api_request_quote_scoped(uuid, public.vendor_name[])
from public, anon, authenticated, service_role;
grant execute on function public.api_request_quote_scoped(uuid, public.vendor_name[])
to authenticated;

-- Compatibility wrapper: force retry is intentionally ignored. Client callers
-- cannot bypass validity or cooldown controls; uncovered lanes remain requestable.
create or replace function public.api_request_quote(
  p_job_id uuid,
  p_force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_denial jsonb;
begin
  v_denial := private.require_automatic_quote_access(p_job_id);
  if v_denial is not null then
    return v_denial;
  end if;

  -- Keep the established implementation marker in this wrapper so rollout
  -- ordering audits continue to prove that lifecycle writes happen only after
  -- the gate. The scoped implementation supersedes the legacy helper.
  -- private.request_automatic_quote_impl
  return private.request_scoped_automatic_quote_impl(p_job_id, null)
    || pg_catalog.jsonb_build_object('quoteMode', 'automatic');
end;
$$;

revoke all on function public.api_request_quote(uuid, boolean)
from public, anon, authenticated, service_role;
grant execute on function public.api_request_quote(uuid, boolean)
to authenticated;

-- Batch compatibility also delegates to lane eligibility. Its legacy retry
-- flag is retained only for schema compatibility and cannot bypass controls.
create or replace function public.api_request_quotes(
  p_job_ids uuid[],
  p_force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job_id uuid;
  v_results jsonb := '[]'::jsonb;
begin
  perform public.require_verified_auth();
  foreach v_job_id in array coalesce(p_job_ids, '{}'::uuid[])
  loop
    v_results := v_results || pg_catalog.jsonb_build_array(
      public.api_request_quote_scoped(v_job_id, null)
    );
  end loop;
  return v_results;
end;
$$;

revoke all on function public.api_request_quotes(uuid[], boolean)
from public, anon, authenticated, service_role;
grant execute on function public.api_request_quotes(uuid[], boolean)
to authenticated;

-- Internal helpers and trigger functions are not Data API endpoints.
revoke all on function private.build_quote_lane_scope_snapshot(uuid, public.vendor_name, integer)
from public, anon, authenticated;
revoke all on function private.quote_scope_fingerprint(jsonb)
from public, anon, authenticated;
revoke all on function private.quote_lane_candidates(uuid, public.vendor_name[])
from public, anon, authenticated;
revoke all on function private.resolve_quote_lane_eligibility(uuid, public.vendor_name[], timestamptz)
from public, anon, authenticated;
