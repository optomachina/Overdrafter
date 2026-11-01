-- OVD-746 down path for the promoted migration
-- supabase/migrations/20261031052436_ovd746_client_rpc_auth_gate.sql.
-- No forward draft: the forward SQL lives only in migrations. Run only inside
-- a migration window, as postgres, if the gate must be withdrawn, as one
-- transaction (so the SET LOCAL below bounds every statement):
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f docs/migration-drafts/ovd-746.rollback.sql
-- It reopens the KNOWN GAP and GAP-B5 behaviors that
-- supabase/tests/client_rpc_least_privilege.sql now refuses.
--
-- 1. Restores, byte for byte, the prior bodies of api_cancel_quote_request
--    (20261002182714), api_select_quote_option (20261016004826),
--    api_get_quote_run_readiness (20260307190000) and
--    load_editable_project_part_context (20260402120000). CREATE OR REPLACE
--    keeps the owner and the ACL, which the migration did not change.
-- 2. For the three client reads, drops the public wrapper, moves the untouched
--    body back from private to public and restores the prior ACL
--    (authenticated and service_role; owner postgres). A read whose body is no
--    longer in private is skipped.
--
-- Replayable: running it twice leaves the same state. No data change; no data
-- loss. docs/migration-drafts/ovd-978.sql targets the private body, so roll
-- this back only while OVD-978 is unapplied (or roll OVD-978 back first).

set local lock_timeout = '3s';

create or replace function public.api_cancel_quote_request(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.quote_requests%rowtype;
  v_quote_run public.quote_runs%rowtype;
  v_has_terminal_vendor_outcome boolean := false;
  v_canceled_at timestamptz := timezone('utc', now());
begin
  perform public.require_verified_auth();

  select *
  into v_request
  from public.quote_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    return jsonb_build_object(
      'jobId', null,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', null,
      'quoteRunId', null,
      'status', 'not_requested',
      'reasonCode', 'not_found',
      'reason', 'Quote request not found.'
    );
  end if;

  if not public.user_can_edit_job(v_request.job_id) then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', null,
      'status', v_request.status,
      'reasonCode', 'forbidden',
      'reason', 'You do not have permission to cancel this quote request.'
    );
  end if;

  select *
  into v_quote_run
  from public.quote_runs
  where quote_request_id = v_request.id
  order by created_at desc, id desc
  limit 1
  for update;

  if v_request.status = 'canceled' then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'already_canceled',
      'reason', 'This quote request is already canceled.'
    );
  end if;

  if v_request.status = 'received' then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'already_received',
      'reason', 'A quote response has already been received for this request.'
    );
  end if;

  if v_request.status not in ('queued', 'requesting') then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'not_cancelable',
      'reason', 'Only queued or requesting quote requests can be canceled.'
    );
  end if;

  if v_quote_run.id is not null then
    select exists(
      select 1
      from public.vendor_quote_results result
      where result.quote_run_id = v_quote_run.id
        and result.status in (
          'instant_quote_received',
          'official_quote_received',
          'manual_review_pending',
          'manual_vendor_followup'
        )
    )
    into v_has_terminal_vendor_outcome;
  end if;

  if v_has_terminal_vendor_outcome then
    return jsonb_build_object(
      'jobId', v_request.job_id,
      'accepted', false,
      'canceled', false,
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'status', v_request.status,
      'reasonCode', 'not_cancelable',
      'reason', 'This quote request already produced a terminal vendor outcome and cannot be canceled.'
    );
  end if;

  update public.quote_requests
  set
    status = 'canceled',
    failure_reason = null,
    received_at = null,
    failed_at = null,
    canceled_at = v_canceled_at
  where id = v_request.id;

  if v_quote_run.id is not null then
    update public.work_queue
    set
      status = 'cancelled',
      locked_at = null,
      locked_by = null,
      last_error = 'Canceled by client request.',
      payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
        'canceledAt', v_canceled_at,
        'canceledBy', auth.uid(),
        'cancellationSource', 'client-request'
      )
    where quote_run_id = v_quote_run.id
      and task_type = 'run_vendor_quote'
      and status = 'queued';

    update public.quote_runs
    set status = 'failed'
    where id = v_quote_run.id;
  end if;

  update public.jobs
  set status = case
    when status in ('closed', 'client_selected') then status
    when status = 'quoting' then 'ready_to_quote'
    else status
  end
  where id = v_request.job_id;

  -- Request/run/queue/jobs locks already held; never acquire result or offer.
  perform private.release_cancelled_free_quote_job(v_request.id);

  perform public.log_audit_event(
    v_request.organization_id,
    'job.quote_request_canceled',
    jsonb_build_object(
      'quoteRequestId', v_request.id,
      'quoteRunId', v_quote_run.id,
      'requestedVendors', v_request.requested_vendors,
      'canceledAt', v_canceled_at,
      'clientTriggered', true
    ),
    v_request.job_id,
    null
  );

  return jsonb_build_object(
    'jobId', v_request.job_id,
    'accepted', true,
    'canceled', true,
    'quoteRequestId', v_request.id,
    'quoteRunId', v_quote_run.id,
    'status', 'canceled',
    'reasonCode', 'canceled',
    'reason', 'Quote request canceled.'
  );
end;
$$;


create or replace function public.api_select_quote_option(
  p_package_id uuid,
  p_option_id uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_package public.published_quote_packages%rowtype;
  v_option public.published_quote_options%rowtype;
  v_selection_id uuid;
  v_offer public.vendor_quote_offers%rowtype;
begin
  -- Refuse unverified callers before taking any row lock.
  perform public.require_verified_auth();

  select *
  into v_package
  from public.published_quote_packages
  where id = p_package_id
  for share;

  if v_package.id is null then
    raise exception 'Package % not found', p_package_id;
  end if;

  if not public.user_can_edit_job(v_package.job_id) then
    raise exception 'You do not have access to package %', p_package_id;
  end if;

  select *
  into v_option
  from public.published_quote_options
  where id = p_option_id
    and package_id = p_package_id
  for share;

  if v_option.id is null then
    raise exception 'Option % does not belong to package %', p_option_id, p_package_id;
  end if;

  -- Never substitute another variant when the exact published source is absent.
  select offer.* into v_offer
  from public.vendor_quote_offers offer
  join public.vendor_quote_results result on result.id = offer.vendor_quote_result_id
  join public.parts part on part.id = result.part_id
  where offer.id = v_option.source_vendor_quote_offer_id
    and result.id = v_option.source_vendor_quote_id
    and result.quote_run_id = v_package.quote_run_id
    and part.job_id = v_package.job_id
    and offer.organization_id = v_package.organization_id
    and result.organization_id = v_package.organization_id
    and v_option.organization_id = v_package.organization_id
  for share of offer;

  if v_offer.id is null then
    raise exception 'Published option has no matching source offer and cannot be selected.';
  end if;
  if v_offer.invalidated_at is not null then
    raise exception 'Quote offer has been invalidated and cannot be selected.';
  end if;

  perform 1 from public.jobs where id = v_package.job_id for update;
  if not private.quote_offer_valid_at(v_offer.valid_until, pg_catalog.clock_timestamp()) then
    raise exception 'Quote offer has expired and cannot be selected.';
  end if;

  insert into public.client_selections (
    package_id,
    option_id,
    organization_id,
    selected_by,
    note
  )
  values (
    p_package_id,
    p_option_id,
    v_package.organization_id,
    auth.uid(),
    p_note
  )
  returning id into v_selection_id;

  update public.jobs
  set status = 'client_selected'::public.job_status
  where id = v_package.job_id;

  perform public.log_audit_event(
    v_package.organization_id,
    'client.quote_option_selected',
    pg_catalog.jsonb_build_object('selectionId', v_selection_id, 'optionId', p_option_id),
    v_package.job_id,
    p_package_id
  );

  return v_selection_id;
end;
$$;


create or replace function public.api_get_quote_run_readiness(p_quote_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote_run public.quote_runs%rowtype;
  v_success_count integer := 0;
  v_failed_count integer := 0;
  v_blocking_vendor_states integer := 0;
  v_unapproved_extractions integer := 0;
  v_repair_tasks integer := 0;
  v_prior_requirements_match boolean := false;
  v_ready boolean := false;
  v_expected_quantity_groups integer := 0;
  v_ready_quantity_groups integer := 0;
  v_reasons text[] := array[]::text[];
begin
  select *
  into v_quote_run
  from public.quote_runs
  where id = p_quote_run_id;

  if v_quote_run.id is null then
    raise exception 'Quote run % not found', p_quote_run_id;
  end if;

  if not public.is_internal_user(v_quote_run.organization_id) then
    raise exception 'Only internal users can inspect quote run readiness.';
  end if;

  select count(*)::integer
  into v_success_count
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id
    and result.status in ('instant_quote_received', 'official_quote_received');

  select count(*)::integer
  into v_failed_count
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id
    and result.status = 'failed';

  select count(*)::integer
  into v_blocking_vendor_states
  from public.vendor_quote_results result
  where result.quote_run_id = p_quote_run_id
    and result.status in ('manual_review_pending', 'manual_vendor_followup');

  select count(*)::integer
  into v_expected_quantity_groups
  from (
    select part.id, requested_quantity
    from public.parts part
    join public.approved_part_requirements requirement on requirement.part_id = part.id
    cross join lateral unnest(public.normalize_positive_integer_array(requirement.quote_quantities, requirement.quantity))
      as requested_quantity
    where part.job_id = v_quote_run.job_id
  ) groups;

  select count(*)::integer
  into v_ready_quantity_groups
  from (
    select result.part_id, result.requested_quantity
    from public.vendor_quote_results result
    where result.quote_run_id = p_quote_run_id
      and result.status in ('instant_quote_received', 'official_quote_received')
    group by result.part_id, result.requested_quantity
    having count(*) >= 2
  ) groups;

  select count(*)::integer
  into v_unapproved_extractions
  from public.parts part
  left join public.drawing_extractions extraction on extraction.part_id = part.id
  where part.job_id = v_quote_run.job_id
    and part.drawing_file_id is not null
    and coalesce(extraction.status::text, 'needs_review') <> 'approved';

  select count(*)::integer
  into v_repair_tasks
  from public.work_queue queue
  where queue.quote_run_id = p_quote_run_id
    and queue.task_type = 'repair_adapter_candidate'
    and queue.status in ('queued', 'running');

  select coalesce(bool_and(has_prior_match), false)
  into v_prior_requirements_match
  from (
    select exists (
      select 1
      from public.approved_part_requirements previous_requirement
      join public.parts previous_part on previous_part.id = previous_requirement.part_id
      join public.jobs previous_job on previous_job.id = previous_part.job_id
      join public.published_quote_packages previous_package on previous_package.job_id = previous_job.id
      where previous_requirement.organization_id = current_requirement.organization_id
        and previous_requirement.part_id <> current_requirement.part_id
        and coalesce(previous_requirement.part_number, '') = coalesce(current_requirement.part_number, '')
        and coalesce(previous_requirement.revision, '') = coalesce(current_requirement.revision, '')
        and coalesce(previous_requirement.description, '') = coalesce(current_requirement.description, '')
        and previous_requirement.material = current_requirement.material
        and coalesce(previous_requirement.finish, '') = coalesce(current_requirement.finish, '')
        and coalesce(previous_requirement.tightest_tolerance_inch, -1) = coalesce(current_requirement.tightest_tolerance_inch, -1)
        and previous_requirement.quantity = current_requirement.quantity
        and previous_requirement.quote_quantities = current_requirement.quote_quantities
        and coalesce(previous_requirement.requested_by_date::text, '') = coalesce(current_requirement.requested_by_date::text, '')
        and previous_requirement.applicable_vendors = current_requirement.applicable_vendors
    ) as has_prior_match
    from public.approved_part_requirements current_requirement
    join public.parts current_part on current_part.id = current_requirement.part_id
    where current_part.job_id = v_quote_run.job_id
  ) comparison;

  if v_ready_quantity_groups < v_expected_quantity_groups then
    v_reasons := array_append(v_reasons, 'At least two successful vendor quotes are required for each requested quantity.');
  end if;

  if v_failed_count > 0 then
    v_reasons := array_append(v_reasons, 'Failed vendor quotes block auto-publication.');
  end if;

  if v_blocking_vendor_states > 0 then
    v_reasons := array_append(v_reasons, 'Manual review or follow-up vendor states must be resolved first.');
  end if;

  if v_unapproved_extractions > 0 then
    v_reasons := array_append(v_reasons, 'All drawing extractions must be internally approved.');
  end if;

  if v_repair_tasks > 0 then
    v_reasons := array_append(v_reasons, 'Pending adapter repair tasks block auto-publication.');
  end if;

  if not v_prior_requirements_match then
    v_reasons := array_append(v_reasons, 'Auto-publication requires a prior published package with unchanged approved requirements.');
  end if;

  v_ready :=
    v_expected_quantity_groups > 0
    and v_ready_quantity_groups = v_expected_quantity_groups
    and v_failed_count = 0
    and v_blocking_vendor_states = 0
    and v_unapproved_extractions = 0
    and v_repair_tasks = 0
    and v_prior_requirements_match;

  return jsonb_build_object(
    'ready', v_ready,
    'successfulVendorQuotes', v_success_count,
    'failedVendorQuotes', v_failed_count,
    'blockingVendorStates', v_blocking_vendor_states,
    'unapprovedExtractions', v_unapproved_extractions,
    'repairTasks', v_repair_tasks,
    'priorRequirementsMatch', v_prior_requirements_match,
    'reasons', to_jsonb(v_reasons)
  );
end;
$$;


create or replace function public.load_editable_project_part_context(
  p_job_id uuid
)
returns table (
  job public.jobs,
  part public.parts,
  requirement public.approved_part_requirements,
  extraction public.drawing_extractions
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_extraction public.drawing_extractions%rowtype;
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
    raise exception 'You do not have permission to edit job %.', p_job_id;
  end if;

  select *
  into v_part
  from public.parts
  where job_id = v_job.id
  order by created_at asc, id asc
  limit 1;

  if v_part.id is null then
    raise exception 'Job % has no part revisions yet.', p_job_id;
  end if;

  select *
  into v_requirement
  from public.approved_part_requirements
  where part_id = v_part.id;

  select *
  into v_extraction
  from public.drawing_extractions
  where part_id = v_part.id;

  return query
  select
    v_job,
    v_part,
    v_requirement,
    v_extraction;
end;
$$;

do $rollback$
declare
  v_fn record;
begin
  for v_fn in
    select *
    from (values
      ('api_list_client_part_metadata', 'uuid[]', 'authenticated, service_role'),
      ('api_list_client_quote_workspace', 'uuid[]', 'authenticated, service_role'),
      ('api_list_client_activity_events', 'uuid[], integer', 'authenticated, service_role')
    ) as fn(name, args, grantees)
  loop
    if to_regprocedure(format('private.%I(%s)', v_fn.name, v_fn.args)) is null then
      continue;
    end if;

    execute format('drop function public.%I(%s)', v_fn.name, v_fn.args);
    execute format('alter function private.%I(%s) set schema public', v_fn.name, v_fn.args);
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated, service_role',
      v_fn.name, v_fn.args);
    execute format('grant execute on function public.%I(%s) to %s', v_fn.name, v_fn.args, v_fn.grantees);
  end loop;
end;
$rollback$;
