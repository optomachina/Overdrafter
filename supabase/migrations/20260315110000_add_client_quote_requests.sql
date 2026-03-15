do $$
begin
  if not exists (select 1 from pg_type where typname = 'quote_request_status') then
    create type public.quote_request_status as enum (
      'queued',
      'requesting',
      'received',
      'failed',
      'canceled'
    );
  end if;
end
$$;

create table if not exists public.quote_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  requested_vendors public.vendor_name[] not null default array['xometry']::public.vendor_name[],
  status public.quote_request_status not null default 'queued',
  failure_reason text,
  received_at timestamptz,
  failed_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.quote_runs
add column if not exists quote_request_id uuid references public.quote_requests(id) on delete set null;

create unique index if not exists idx_quote_runs_quote_request_id
on public.quote_runs(quote_request_id)
where quote_request_id is not null;

create index if not exists idx_quote_requests_job_created_at
on public.quote_requests(job_id, created_at desc);

create unique index if not exists idx_quote_requests_active_job
on public.quote_requests(job_id)
where status in ('queued', 'requesting');

alter table public.quote_requests enable row level security;

drop policy if exists "quote_requests_select_accessible" on public.quote_requests;
create policy "quote_requests_select_accessible"
on public.quote_requests
for select
to authenticated
using (public.user_can_access_job(job_id));

drop trigger if exists touch_quote_requests_updated_at on public.quote_requests;
create trigger touch_quote_requests_updated_at
before update on public.quote_requests
for each row execute function public.touch_updated_at();

create or replace function public.sync_quote_request_status_for_run(
  p_quote_run_id uuid,
  p_failure_reason text default null
)
returns public.quote_request_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.quote_requests%rowtype;
  v_has_queued boolean := false;
  v_has_running boolean := false;
  v_has_success boolean := false;
  v_has_manual boolean := false;
  v_has_failed boolean := false;
  v_next_status public.quote_request_status;
  v_failure_reason text;
begin
  select request_row.*
  into v_request
  from public.quote_requests request_row
  join public.quote_runs quote_run on quote_run.quote_request_id = request_row.id
  where quote_run.id = p_quote_run_id;

  if v_request.id is null then
    return null;
  end if;

  if v_request.status = 'canceled' then
    return v_request.status;
  end if;

  select
    bool_or(result.status = 'queued'),
    bool_or(result.status = 'running'),
    bool_or(result.status in ('instant_quote_received', 'official_quote_received')),
    bool_or(result.status in ('manual_review_pending', 'manual_vendor_followup')),
    bool_or(result.status = 'failed')
  into
    v_has_queued,
    v_has_running,
    v_has_success,
    v_has_manual,
    v_has_failed
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id;

  v_next_status := case
    when coalesce(v_has_running, false) then 'requesting'
    when coalesce(v_has_queued, false) and coalesce(v_has_success, false) then 'requesting'
    when coalesce(v_has_queued, false) then 'queued'
    when coalesce(v_has_success, false) then 'received'
    else 'failed'
  end;

  v_failure_reason := case
    when v_next_status <> 'failed' then null
    when nullif(trim(coalesce(p_failure_reason, '')), '') is not null then nullif(trim(coalesce(p_failure_reason, '')), '')
    when coalesce(v_has_manual, false) then 'Xometry could not return an automated quote and needs manual follow-up.'
    when coalesce(v_has_failed, false) then 'Xometry quote collection failed before a usable response was received.'
    else 'Quote collection ended without a usable Xometry response.'
  end;

  update public.quote_requests
  set
    status = v_next_status,
    failure_reason = v_failure_reason,
    received_at = case
      when v_next_status = 'received' then timezone('utc', now())
      else null
    end,
    failed_at = case
      when v_next_status = 'failed' then timezone('utc', now())
      else null
    end,
    canceled_at = case
      when v_next_status = 'canceled' then coalesce(v_request.canceled_at, timezone('utc', now()))
      else null
    end
  where id = v_request.id;

  return v_next_status;
end;
$$;

create or replace function public.sync_quote_request_status_from_vendor_result()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_quote_request_status_for_run(new.quote_run_id);
  return new;
end;
$$;

drop trigger if exists sync_quote_request_status_on_vendor_result on public.vendor_quote_results;
create trigger sync_quote_request_status_on_vendor_result
after insert or update of status on public.vendor_quote_results
for each row execute function public.sync_quote_request_status_from_vendor_result();

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
  v_failure_status public.quote_request_status := 'failed';
  v_request_id uuid;
  v_requested_vendors public.vendor_name[] := array['xometry']::public.vendor_name[];
  v_requested_service_kinds text[] := public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  );
  v_is_quote_compatible boolean := false;
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

create or replace function public.api_request_quotes(
  p_job_ids uuid[],
  p_force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_results jsonb := '[]'::jsonb;
begin
  perform public.require_verified_auth();

  foreach v_job_id in array coalesce(p_job_ids, '{}'::uuid[])
  loop
    v_results := v_results || jsonb_build_array(public.api_request_quote(v_job_id, p_force_retry));
  end loop;

  return v_results;
end;
$$;

grant execute on function public.sync_quote_request_status_for_run(uuid, text) to authenticated;
grant execute on function public.api_request_quote(uuid, boolean) to authenticated;
grant execute on function public.api_request_quotes(uuid[], boolean) to authenticated;
