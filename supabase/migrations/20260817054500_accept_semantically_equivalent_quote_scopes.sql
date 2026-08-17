-- OVD-375: PostgREST decodes JSON numbers into JavaScript numbers, so a worker
-- round-trip can serialize a database numeric such as 0.0050 as 0.005. JSONB
-- treats those values as equal, but hashing jsonb::text preserves the textual
-- scale and produced a different fingerprint during the first OVD-206 run.
--
-- Preserve the original server-created lane and permit fingerprints as the
-- approval identity. Compare the worker snapshot to the stored and current
-- server snapshots using JSONB semantic equality, while retaining every file,
-- task, permit, access, rollout, and current-candidate guard.
--
-- Rollback: restore both function definitions from migrations
-- 20260812041000_add_quote_scope_validity_and_lane_eligibility.sql and
-- 20260815184740_add_xometry_worker_dispatch_preflight.sql. Existing lane and
-- permit rows require no data rollback because this migration rewrites none.

create or replace function public.api_register_quote_request_lane(
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_result public.vendor_quote_results%rowtype;
  v_quote_request_id uuid;
  v_part public.parts%rowtype;
  v_cad_file public.job_files%rowtype;
  v_drawing_file public.job_files%rowtype;
  v_scope_fingerprint text;
  v_existing_lane public.quote_request_lanes%rowtype;
begin
  select * into v_result
  from public.vendor_quote_results
  where id = p_vendor_quote_result_id
  for update;

  if v_result.id is null then
    raise exception 'Vendor quote result was not found.';
  end if;

  select quote_run.quote_request_id into v_quote_request_id
  from public.quote_runs quote_run
  where quote_run.id = v_result.quote_run_id;

  if v_quote_request_id is null then
    raise exception 'Vendor quote result is not linked to a quote request.';
  end if;

  if p_scope_snapshot is null
    or pg_catalog.jsonb_typeof(p_scope_snapshot) <> 'object'
    or p_scope_snapshot ->> 'schema' <> 'quote-lane-scope.v1'
    or p_scope_snapshot ->> 'vendor' <> v_result.vendor::text -- NOSONAR: protocol key is repeated across independent validation boundaries
    or (p_scope_snapshot ->> 'quantity')::integer <> v_result.requested_quantity
    or p_scope_snapshot #>> '{part,id}' <> v_result.part_id::text then
    raise exception 'Quote scope does not match the vendor result lane.';
  end if;

  select * into v_part
  from public.parts
  where id = v_result.part_id;

  select * into v_cad_file
  from public.job_files
  where id = v_part.cad_file_id;

  if v_cad_file.id is null
    or p_scope_snapshot #>> '{part,cad,fileId}' <> v_cad_file.id::text
    or p_scope_snapshot #>> '{part,cad,sha256}' is null
    or p_scope_snapshot #>> '{part,cad,sha256}' <> v_cad_file.trusted_content_sha256 then
    raise exception 'Quote scope CAD does not match the worker-trusted staged file.';
  end if;

  if v_part.drawing_file_id is null then
    if p_scope_snapshot #> '{part,drawing}' is distinct from 'null'::jsonb then
      raise exception 'Quote scope includes an unexpected drawing.';
    end if;
  else
    select * into v_drawing_file
    from public.job_files
    where id = v_part.drawing_file_id;

    if v_drawing_file.id is null
      or p_scope_snapshot #>> '{part,drawing,fileId}' <> v_drawing_file.id::text
      or p_scope_snapshot #>> '{part,drawing,sha256}' is null
      or p_scope_snapshot #>> '{part,drawing,sha256}' <> v_drawing_file.trusted_content_sha256 then
      raise exception 'Quote scope drawing does not match the worker-trusted staged file.';
    end if;
  end if;

  v_scope_fingerprint := private.quote_scope_fingerprint(p_scope_snapshot);

  insert into public.quote_request_lanes (
    organization_id, quote_request_id, quote_run_id, vendor_quote_result_id,
    part_id, vendor, requested_quantity, scope_version, scope_fingerprint,
    scope_snapshot
  ) values (
    v_result.organization_id, v_quote_request_id, v_result.quote_run_id, v_result.id,
    v_result.part_id, v_result.vendor, v_result.requested_quantity, 1,
    v_scope_fingerprint, p_scope_snapshot
  )
  on conflict (quote_request_id, part_id, vendor, requested_quantity) do nothing;

  if not found then
    select * into v_existing_lane
    from public.quote_request_lanes
    where quote_request_id = v_quote_request_id
      and part_id = v_result.part_id
      and vendor = v_result.vendor
      and requested_quantity = v_result.requested_quantity;

    if v_existing_lane.vendor_quote_result_id <> v_result.id
      or v_existing_lane.scope_snapshot is distinct from p_scope_snapshot then
      raise exception 'Quote lane was already registered with a different immutable scope.';
    end if;
  end if;
end;
$$;

revoke all on function public.api_register_quote_request_lane(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.api_register_quote_request_lane(uuid, jsonb)
to service_role;

create or replace function public.api_authorize_xometry_beta_worker_dispatch(
  p_work_queue_task_id uuid,
  p_vendor_quote_result_id uuid,
  p_scope_snapshot jsonb,
  p_expected_worker_name text,
  p_expected_claimed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_provider constant public.vendor_name := 'xometry';
  v_envelope_revision constant text := 'xometry-controlled-beta-envelope.v1';
  v_authorized_key constant text := 'authorized';
  v_reason_key constant text := 'reasonCode';
  v_task public.work_queue%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_permit private.xometry_beta_dispatch_permits%rowtype;
  v_job public.jobs%rowtype;
  v_request_status text;
  v_notice jsonb;
  v_beta_state jsonb;
  v_entitlements jsonb;
  v_effective_vendors public.vendor_name[];
  v_current_candidate record;
  v_current_candidate_count integer;
  v_task_permit_id_text text;
begin
  if p_work_queue_task_id is null
    or p_vendor_quote_result_id is null
    or p_scope_snapshot is null
    or nullif(pg_catalog.btrim(p_expected_worker_name), '') is null
    or p_expected_claimed_at is null
    or pg_catalog.jsonb_typeof(p_scope_snapshot) <> 'object'
    or p_scope_snapshot ->> 'schema' <> 'quote-lane-scope.v1'
    or p_scope_snapshot ->> 'vendor' <> v_provider::text then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_preflight_invalid_input'
    );
  end if;

  select task_row.* into v_task
  from public.work_queue task_row
  where task_row.id = p_work_queue_task_id
  for update;

  if v_task.id is null
    or v_task.task_type <> 'run_vendor_quote'
    or v_task.status <> 'running'
    or v_task.locked_at is null
    or v_task.locked_by is distinct from p_expected_worker_name
    or v_task.locked_at is distinct from p_expected_claimed_at then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_task_not_running'
    );
  end if;

  if v_task.payload ->> 'vendor' is distinct from v_provider::text
    or v_task.payload ->> 'vendorQuoteResultId' is distinct from p_vendor_quote_result_id::text
    or v_task.payload ->> 'quoteRunId' is distinct from v_task.quote_run_id::text
    or v_task.payload ->> 'partId' is distinct from v_task.part_id::text then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_task_identity_mismatch'
    );
  end if;

  v_task_permit_id_text := v_task.payload ->> 'xometryBetaDispatchPermitId';
  if v_task_permit_id_text is null
    or v_task_permit_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or v_task.payload ->> 'xometryBetaEnvelopeRevision' is distinct from v_envelope_revision
    or v_task.payload ->> 'quoteLaneScopeFingerprint' is null then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_permit_binding_missing'
    );
  end if;

  select permit_row.* into v_permit
  from private.xometry_beta_dispatch_permits permit_row
  where permit_row.id = v_task_permit_id_text::uuid;

  select result_row.* into v_result
  from public.vendor_quote_results result_row
  where result_row.id = p_vendor_quote_result_id;

  if v_permit.id is null
    or v_result.id is null
    or v_result.status <> 'running'
    or v_permit.provider <> v_provider
    or v_permit.envelope_revision <> v_envelope_revision
    or v_permit.authority_to_share is not true
    or v_permit.non_export_controlled is not true
    or v_permit.quote_only is not true
    or v_permit.work_queue_task_id <> v_task.id
    or v_permit.vendor_quote_result_id <> v_result.id
    or v_permit.organization_id <> v_task.organization_id
    or v_permit.organization_id <> v_result.organization_id
    or v_permit.job_id <> v_task.job_id
    or v_permit.part_id <> v_task.part_id
    or v_permit.part_id <> v_result.part_id
    or v_permit.quote_run_id <> v_task.quote_run_id
    or v_permit.quote_run_id <> v_result.quote_run_id then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_permit_identity_mismatch'
    );
  end if;

  select lane_row.* into v_lane
  from public.quote_request_lanes lane_row
  where lane_row.id = v_permit.quote_request_lane_id;

  if v_lane.id is null
    or v_lane.organization_id <> v_permit.organization_id
    or v_lane.quote_request_id <> v_permit.quote_request_id
    or v_lane.quote_run_id <> v_permit.quote_run_id
    or v_lane.vendor_quote_result_id <> v_permit.vendor_quote_result_id
    or v_lane.part_id <> v_permit.part_id
    or v_lane.vendor <> v_provider
    or v_lane.requested_quantity <> 1
    or v_lane.scope_version <> v_permit.scope_version
    or v_lane.scope_fingerprint <> v_permit.scope_fingerprint
    or v_task.payload ->> 'quoteLaneScopeFingerprint' is distinct from v_permit.scope_fingerprint then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_lane_identity_mismatch'
    );
  end if;

  select job_row.* into v_job
  from public.jobs job_row
  where job_row.id = v_permit.job_id;

  select request_row.status::text into v_request_status
  from public.quote_requests request_row
  where request_row.id = v_permit.quote_request_id;

  if v_job.id is null
    or v_job.organization_id <> v_permit.organization_id
    or v_request_status is null
    or v_request_status not in ('queued', 'requesting') then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_request_inactive'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'founding-beta:' || v_permit.organization_id::text,
      0
    )
  );

  v_notice := private.current_founding_beta_notice();
  v_beta_state := private.resolve_founding_beta_access_state(
    v_permit.organization_id,
    v_permit.actor_user_id
  );
  if v_beta_state ->> 'state' <> 'eligible'
    or v_notice ->> 'policyRevision' is distinct from v_permit.notice_revision then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_beta_authorization_revoked'
    );
  end if;

  v_entitlements := private.resolve_organization_entitlements_at(
    v_permit.organization_id,
    pg_catalog.now()
  );
  if coalesce(
    v_entitlements -> 'automaticQuoteCollection' = 'true'::jsonb,
    false
  ) is not true then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_automatic_access_revoked'
    );
  end if;

  if not private.automatic_quote_rollout_enabled_with_lock() then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_rollout_disabled'
    );
  end if;

  if not exists (
    select 1
    from public.org_vendor_configs config_row
    where config_row.organization_id = v_permit.organization_id
  ) then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_provider_configuration_changed'
    );
  end if;

  v_effective_vendors := public.get_enabled_client_quote_vendors(
    v_permit.organization_id,
    v_job.project_id,
    v_job.id
  );
  if v_effective_vendors <> array[v_provider]::public.vendor_name[] then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_provider_configuration_changed'
    );
  end if;

  if p_scope_snapshot is distinct from v_lane.scope_snapshot then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_staged_scope_changed'
    );
  end if;

  select candidate.* into v_current_candidate
  from private.quote_lane_candidates(
    v_permit.job_id,
    array[v_provider]::public.vendor_name[]
  ) candidate
  where candidate.organization_id = v_permit.organization_id
    and candidate.part_id = v_permit.part_id
    and candidate.vendor = v_provider
    and candidate.requested_quantity = 1;

  select count(*)::integer into v_current_candidate_count
  from private.quote_lane_candidates(
    v_permit.job_id,
    array[v_provider]::public.vendor_name[]
  ) candidate;

  if v_current_candidate_count <> 1
    or v_current_candidate.scope_fingerprint is null
    or v_current_candidate.scope_version <> v_permit.scope_version
    or v_current_candidate.scope_fingerprint <> v_permit.scope_fingerprint
    or v_current_candidate.scope_snapshot is distinct from p_scope_snapshot then
    return pg_catalog.jsonb_build_object(
      v_authorized_key, false,
      v_reason_key, 'dispatch_current_scope_changed'
    );
  end if;

  return pg_catalog.jsonb_build_object(
    v_authorized_key, true,
    v_reason_key, null,
    'permitId', v_permit.id,
    'provider', v_provider,
    'scopeFingerprint', v_permit.scope_fingerprint,
    'envelopeRevision', v_envelope_revision,
    'nonExportControlled', true
  );
end;
$$;

revoke all on function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_xometry_beta_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) to service_role;
