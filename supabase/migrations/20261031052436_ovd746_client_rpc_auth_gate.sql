-- OVD-746: authorize client RPCs before any lookup or row lock, and refuse
-- unverified callers on the client read RPCs.
-- Rollback: docs/migration-drafts/ovd-746.rollback.sql.
-- Not applied to staging or production in this change. Staging apply and the
-- production window stay with Blaine.
--
-- Found by supabase/tests/client_rpc_least_privilege.sql (OVD-623), which
-- pinned these behaviors as KNOWN GAP and GAP-B5:
--   - api_cancel_quote_request took FOR UPDATE on the request row before its
--     permission check, and answered a foreign id with that job's id and status
--     (forbidden) but an absent id with not_found;
--   - load_editable_project_part_context, api_select_quote_option and
--     api_get_quote_run_readiness reported "not found" before checking
--     authorization (api_select_quote_option also took FOR SHARE first);
--   - an unverified org member could read through api_list_client_part_metadata,
--     api_list_client_quote_workspace and api_list_client_activity_events.
-- api_reconcile_job_parts and the api_select_quote_option verified-auth gate
-- were already restored by OVD-769 and OVD-770; anon EXECUTE was revoked by
-- OVD-736.
--
-- 1. The four plpgsql functions are restated from their latest definitions
--    with only the authorization moved. The permission predicate is part of
--    the (locking) read, so a row the caller may not use is never locked, and
--    absent and foreign ids get one answer:
--      api_cancel_quote_request           the not_found payload (no job id or
--                                         status); the forbidden branch is gone
--      api_select_quote_option            'You do not have access to package %'
--      api_get_quote_run_readiness        'Only internal users can inspect quote run readiness.'
--      load_editable_project_part_context 'You do not have permission to edit job %.'
--    search_path becomes '' (every reference was already schema qualified).
--    Base bodies: 20261002182714_free_quote_job_meter.sql,
--    20261016004826_ovd770_quote_select_editor_guard.sql,
--    20260307190000_add_request_intake_and_multi_quantity_quotes.sql and
--    20260402120000_persist_project_part_property_overrides.sql.
-- 2. Read decision: the three client reads refuse unverified callers with the
--    require_verified_auth error the writes use. The app never calls them for
--    an unverified session (src/hooks/use-app-session.ts keeps `user` null and
--    data queries disabled until the session is verified), so no client flow
--    changes. Each read body moves unchanged to private, with no grant to
--    PUBLIC, anon, authenticated or service_role, behind a public wrapper with
--    the same signature, defaults, return type and volatility that runs
--    require_verified_auth and then calls the body as the owner. This keeps the
--    large SQL bodies byte for byte (docs/migration-drafts/ovd-978.sql now
--    replaces private.api_list_client_part_metadata).
-- Every public function keeps its prior ACL: authenticated and service_role,
-- except api_select_quote_option (authenticated) and
-- load_editable_project_part_context (service_role; it is reached through
-- other SECURITY DEFINER functions).
--
-- Expand only: no table, column or data change; every public signature stays.
-- Rerunning fails at the first ALTER ... SET SCHEMA (the private name exists);
-- the migration runner applies it once.

set local lock_timeout = '3s';

create or replace function public.api_cancel_quote_request(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.quote_requests%rowtype;
  v_quote_run public.quote_runs%rowtype;
  v_has_terminal_vendor_outcome boolean := false;
  v_canceled_at timestamptz := timezone('utc', now());
begin
  perform public.require_verified_auth();

  -- Authorize in the locking read itself, so a row the caller cannot edit is
  -- never locked and an absent and a foreign id get the same not_found answer.
  select *
  into v_request
  from public.quote_requests
  where id = p_request_id
    and public.user_can_edit_job(job_id)
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

  -- Authorize in the locking read itself, so a package the caller cannot edit
  -- is never locked and an absent and a foreign id get the same answer.
  select *
  into v_package
  from public.published_quote_packages
  where id = p_package_id
    and public.user_can_edit_job(job_id)
  for share;

  if v_package.id is null then
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
set search_path = ''
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
  -- Authorize in the read itself, so an absent and a foreign id get the same
  -- answer.
  select *
  into v_quote_run
  from public.quote_runs
  where id = p_quote_run_id
    and public.is_internal_user(organization_id);

  if v_quote_run.id is null then
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
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_extraction public.drawing_extractions%rowtype;
begin
  perform public.require_verified_auth();

  -- user_can_edit_job is false for an absent job, so an absent and a foreign
  -- id get the same answer before the job is read.
  if not public.user_can_edit_job(p_job_id) then
    raise exception 'You do not have permission to edit job %.', p_job_id;
  end if;

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
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

alter function public.api_list_client_part_metadata(uuid[]) set schema private;
alter function public.api_list_client_quote_workspace(uuid[]) set schema private;
alter function public.api_list_client_activity_events(uuid[], integer) set schema private;

revoke all on function private.api_list_client_part_metadata(uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.api_list_client_quote_workspace(uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.api_list_client_activity_events(uuid[], integer) from public, anon, authenticated, service_role;

create or replace function public.api_list_client_part_metadata(p_job_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_verified_auth();
  return private.api_list_client_part_metadata(p_job_ids);
end;
$$;

create or replace function public.api_list_client_quote_workspace(p_job_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_verified_auth();
  return private.api_list_client_quote_workspace(p_job_ids);
end;
$$;

create or replace function public.api_list_client_activity_events(
  p_job_ids uuid[],
  p_limit_per_job integer default 6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_verified_auth();
  return private.api_list_client_activity_events(p_job_ids, p_limit_per_job);
end;
$$;

revoke all on function public.api_cancel_quote_request(uuid) from public, anon;
revoke all on function public.api_select_quote_option(uuid, uuid, text) from public, anon;
revoke all on function public.api_get_quote_run_readiness(uuid) from public, anon;
revoke all on function public.load_editable_project_part_context(uuid) from public, anon, authenticated;
revoke all on function public.api_list_client_part_metadata(uuid[]) from public, anon;
revoke all on function public.api_list_client_quote_workspace(uuid[]) from public, anon;
revoke all on function public.api_list_client_activity_events(uuid[], integer) from public, anon;

grant execute on function public.api_cancel_quote_request(uuid) to authenticated, service_role;
grant execute on function public.api_select_quote_option(uuid, uuid, text) to authenticated;
grant execute on function public.api_get_quote_run_readiness(uuid) to authenticated, service_role;
grant execute on function public.load_editable_project_part_context(uuid) to service_role;
grant execute on function public.api_list_client_part_metadata(uuid[]) to authenticated, service_role;
grant execute on function public.api_list_client_quote_workspace(uuid[]) to authenticated, service_role;
grant execute on function public.api_list_client_activity_events(uuid[], integer) to authenticated, service_role;
