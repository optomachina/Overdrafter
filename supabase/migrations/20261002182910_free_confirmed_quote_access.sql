-- Confirmed beta quote access: commercial entitlement OR explicitly configured free policy.
-- Depends on 20261002182714_free_quote_job_meter.sql. No production policy/allowance seeded.
-- Generic commercial/manual guards and existing AAL2 entrypoints remain unchanged.
-- Rollback: disable new free policy; retain admission receipts and lifecycle fences.
-- Database authorization/concurrency qualification is required before deployment.

create or replace function private.resolve_quote_access_for_permit(
  p_job_id uuid, p_actor_user_id uuid, p_permit_id uuid
) returns jsonb
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_permit private.xometry_beta_dispatch_permits%rowtype;
  v_beta jsonb;
  v_admission jsonb;
  v_entitlements jsonb;
  v_policy jsonb;
  v_source text;
  v_revision text;
  v_reason text := 'free_policy_unavailable';
begin
  select * into v_job from public.jobs where id = p_job_id;
  if v_job.id is null or p_actor_user_id is null then
    raise exception 'quote_access_invalid_identity';
  end if;
  -- Trusted callers establish job authority; replay identity is revalidated here.
  if p_permit_id is not null then
    select * into v_permit from private.xometry_beta_dispatch_permits where id = p_permit_id;
    if v_permit.id is null or v_permit.job_id <> p_job_id
      or v_permit.organization_id <> v_job.organization_id
      or v_permit.actor_user_id <> p_actor_user_id then
      raise exception 'xometry_beta_approval_reference_reused';
    end if;
    v_admission := private.validate_quote_access_admission(v_permit.quote_request_id, v_permit.id);
  end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('founding-beta:' || v_job.organization_id::text, 0));
  v_beta := private.resolve_founding_beta_access_state(v_job.organization_id, p_actor_user_id);
  if v_beta ->> 'state' is distinct from 'eligible' then
    v_reason := 'beta_access_required';
  else
    v_entitlements := private.resolve_organization_entitlements_at(v_job.organization_id, pg_catalog.clock_timestamp());
    if p_permit_id is not null and v_admission ->> 'source' = 'free_beta' then
      -- Pinned-window replay may acknowledge terminal history; execution requires reserved separately.
      if v_admission -> 'valid' = 'true'::jsonb
        and v_admission ->> 'state' in ('reserved', 'consumed', 'released') then
        v_source := 'free_beta';
        select policy_revision into v_revision from private.quote_access_admissions
        where quote_request_id = v_permit.quote_request_id and permit_id = v_permit.id;
      end if;
    elsif p_permit_id is null or (
      v_admission -> 'valid' = 'true'::jsonb
      and v_admission ->> 'source' = 'commercial_entitlement'
      and v_admission ->> 'state' = 'unmetered'
    ) or v_admission ->> 'reasonCode' = 'legacy_unrecorded' then
      if v_entitlements -> 'automaticQuoteCollection' = 'true'::jsonb then
        v_source := 'commercial_entitlement';
      elsif p_permit_id is null then
        v_policy := private.resolve_free_quote_policy(p_job_id, p_actor_user_id);
        if v_policy -> 'configured' = 'true'::jsonb
          and nullif(v_policy ->> 'policyRevision', '') is not null then
          v_source := 'free_beta';
          v_revision := v_policy ->> 'policyRevision';
        end if;
      end if;
    end if;
    if not private.automatic_quote_rollout_enabled_with_lock() then
      v_source := null;
      v_revision := null;
      v_reason := 'automatic_quote_disabled';
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'state', case when v_source is null then 'blocked' else 'eligible' end,
    'source', v_source,
    'reasonCode', case when v_source is null then v_reason else 'eligible' end,
    'policyRevision', case when v_source is null then null else v_revision end
  );
end;
$$;
revoke all on function private.resolve_quote_access_for_permit(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create or replace function private.resolve_quote_access(p_job_id uuid,p_actor_user_id uuid)
returns jsonb language sql security definer set search_path = pg_catalog
as $$ select private.resolve_quote_access_for_permit(p_job_id,p_actor_user_id,null); $$;
revoke all on function private.resolve_quote_access(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.api_get_quote_access(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare v_job public.jobs%rowtype; v_access jsonb;
begin
  perform public.require_verified_auth();
  select * into v_job from public.jobs where id=p_job_id;
  if v_job.id is null or not public.user_can_edit_job(p_job_id) then
    raise exception 'quote_access_not_authorized';
  end if;
  v_access := private.resolve_quote_access(p_job_id,auth.uid());
  return pg_catalog.jsonb_build_object('schema','quote-access.v1','jobId',v_job.id,
    'organizationId',v_job.organization_id,'actorUserId',auth.uid()) || v_access;
end;
$$;
revoke all on function public.api_get_quote_access(uuid) from public,anon,authenticated,service_role;
grant execute on function public.api_get_quote_access(uuid) to authenticated;

create or replace function private.resolve_xometry_beta_dispatch_scope_with_access(
  p_job_id uuid,
  p_declared_model_units text,
  p_existing_permit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_part public.parts%rowtype;
  v_cad public.job_files%rowtype;
  v_drawing public.job_files%rowtype;
  v_notice jsonb;
  v_beta_state jsonb;
  v_denial jsonb;
  v_effective_vendors public.vendor_name[];
  v_candidate record;
  v_special jsonb;
  v_process text;
  v_material text;
  v_finish text;
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
  if p_declared_model_units not in ('inch', 'millimeter') then
    raise exception 'Declared model units must be inch or millimeter.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'founding-beta:' || v_job.organization_id::text,
      0
    )
  );

  v_notice := private.current_founding_beta_notice();
  v_beta_state := private.resolve_founding_beta_access_state(
    v_job.organization_id,
    auth.uid()
  );
  if v_beta_state ->> 'state' <> 'eligible' then
    raise exception 'Founding Beta access and current notice acceptance are required.';
  end if;

  v_denial := private.resolve_quote_access_for_permit(p_job_id, auth.uid(), p_existing_permit_id);
  if v_denial ->> 'state' is distinct from 'eligible' then
    raise exception '%', coalesce(v_denial ->> 'reasonCode', 'automatic_quote_unavailable'); -- NOSONAR: stable denial contract shared with the existing quote boundary
  end if;

  if not exists (
    select 1 from public.org_vendor_configs config
    where config.organization_id = v_job.organization_id
  ) then
    raise exception 'xometry_beta_explicit_vendor_config_required';
  end if;

  v_effective_vendors := public.get_enabled_client_quote_vendors(
    v_job.organization_id,
    v_job.project_id,
    v_job.id
  );
  if v_effective_vendors is distinct from array['xometry']::public.vendor_name[] then
    raise exception 'xometry_beta_exact_provider_set_required';
  end if;

  if (select count(*) from public.parts part where part.job_id = p_job_id) <> 1 then
    raise exception 'xometry_beta_exactly_one_part_required';
  end if;

  select part.* into v_part
  from public.parts part
  where part.job_id = p_job_id;
  if v_part.organization_id <> v_job.organization_id then
    raise exception 'xometry_beta_part_organization_mismatch';
  end if;

  select requirement.* into v_requirement
  from public.approved_part_requirements requirement
  where requirement.part_id = v_part.id;
  if v_requirement.id is null then
    raise exception 'xometry_beta_approved_requirements_required';
  end if;
  if v_requirement.organization_id <> v_job.organization_id then
    raise exception 'xometry_beta_requirement_organization_mismatch';
  end if;

  select file_row.* into v_cad
  from public.job_files file_row
  where file_row.id = v_part.cad_file_id;
  if v_cad.id is null
    or v_cad.job_id <> v_job.id
    or v_cad.organization_id <> v_job.organization_id
    or v_cad.file_kind <> 'cad'
    or lower(v_cad.original_name) !~ '\.(step|stp)$'
    or v_cad.trusted_content_sha256 is null
    or v_cad.trusted_content_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'xometry_beta_trusted_step_required';
  end if;

  if v_part.drawing_file_id is not null then
    select file_row.* into v_drawing
    from public.job_files file_row
    where file_row.id = v_part.drawing_file_id;
    if v_drawing.id is null
      or v_drawing.job_id <> v_job.id
      or v_drawing.organization_id <> v_job.organization_id
      or v_drawing.file_kind <> 'drawing'
      or lower(v_drawing.original_name) !~ '\.pdf$'
      or v_drawing.trusted_content_sha256 is null
      or v_drawing.trusted_content_sha256 !~ '^[a-f0-9]{64}$' then
      raise exception 'xometry_beta_compatible_drawing_required';
    end if;
  end if;

  if public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  ) is distinct from array['manufacturing_quote']::text[] then
    raise exception 'xometry_beta_manufacturing_quote_only';
  end if;
  if public.normalize_positive_integer_array(
    v_requirement.quote_quantities,
    v_requirement.quantity
  ) is distinct from array[1]::integer[] then
    raise exception 'xometry_beta_quantity_one_required';
  end if;
  if v_requirement.applicable_vendors is null
    or coalesce(
      'xometry'::public.vendor_name = any(v_requirement.applicable_vendors),
      false
    ) is not true then
    raise exception 'xometry_beta_xometry_applicability_required';
  end if;

  v_process := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.spec_snapshot ->> 'process', ''))),
    '[^a-z0-9]', '', 'g' -- NOSONAR: identical normalization is required for process, material, and finish
  );
  v_material := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(v_requirement.material)),
    '[^a-z0-9]', '', 'g'
  );
  v_finish := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.finish, ''))),
    '[^a-z0-9]', '', 'g'
  );
  if v_process not in ('cncmilling', 'cncmachining', 'milling') then
    raise exception 'xometry_beta_cnc_milling_required';
  end if;
  if v_material not in ('6061t6', '6061t6aluminum', 'aluminum6061t6') then
    raise exception 'xometry_beta_6061_t6_required';
  end if;
  if v_finish not in ('', 'asmachined') then
    raise exception 'xometry_beta_as_machined_required';
  end if;
  if v_requirement.tightest_tolerance_inch is null
    or v_requirement.tightest_tolerance_inch < 0.005 then
    raise exception 'xometry_beta_standard_tolerance_required';
  end if;
  if v_requirement.requested_by_date is not null then
    raise exception 'xometry_beta_special_delivery_date_not_supported';
  end if;

  v_special := coalesce(v_requirement.spec_snapshot, '{}'::jsonb);
  if nullif(pg_catalog.btrim(coalesce(v_special ->> 'threads', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special ->> 'notes', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special ->> 'serviceNotes', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{shipping,packagingNotes}', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{shipping,shippingNotes}', '')), '') is not null
    or jsonb_array_length(coalesce(v_special #> '{certifications,requiredCertifications}', '[]'::jsonb)) > 0
    or coalesce((v_special #>> '{certifications,materialCertificationRequired}')::boolean, false)
    or coalesce((v_special #>> '{certifications,certificateOfConformanceRequired}')::boolean, false)
    or coalesce(v_special #>> '{certifications,inspectionLevel}', 'standard') not in ('', 'standard')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{certifications,notes}', '')), '') is not null
    or jsonb_array_length(coalesce(v_special #> '{sourcing,preferredSuppliers}', '[]'::jsonb)) > 0
    or coalesce(v_special #>> '{sourcing,regionPreferenceOverride}', 'best_value') not in ('', 'best_value')
    or coalesce(v_special #>> '{sourcing,materialProvisioning}', 'supplier_to_source') not in ('', 'supplier_to_source')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{sourcing,notes}', '')), '') is not null
    or coalesce(v_special #>> '{release,releaseStatus}', 'approved') in ('hold', 'blocked')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{release,notes}', '')), '') is not null then
    raise exception 'xometry_beta_special_requirements_not_supported';
  end if;

  select candidate.* into v_candidate
  from private.quote_lane_candidates(
    p_job_id,
    array['xometry']::public.vendor_name[]
  ) candidate;
  if not found then
    raise exception 'xometry_beta_exact_scope_required';
  end if;
  if (select count(*) from private.quote_lane_candidates(
    p_job_id,
    array['xometry']::public.vendor_name[]
  )) <> 1 then
    raise exception 'xometry_beta_exact_scope_required';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', v_job.organization_id, -- NOSONAR: stable public response key
    'jobId', v_job.id,
    'partId', v_candidate.part_id, -- NOSONAR: stable public response key
    'provider', v_candidate.vendor,
    'requestedQuantity', v_candidate.requested_quantity,
    'scopeVersion', v_candidate.scope_version,
    'scopeFingerprint', v_candidate.scope_fingerprint, -- NOSONAR: stable permit and preview contract key
    'scope', v_candidate.scope_snapshot,
    'declaredModelUnits', p_declared_model_units,
    'policyRevision', v_notice ->> 'policyRevision', -- NOSONAR: stable notice contract key
    'envelopeRevision', 'xometry-controlled-beta-envelope.v1'
  );
end;
$$;

revoke all on function private.resolve_xometry_beta_dispatch_scope_with_access(uuid, text, uuid)
  from public, anon, authenticated, service_role;

create or replace function private.resolve_xometry_beta_dispatch_scope(p_job_id uuid,p_declared_model_units text)
returns jsonb language sql security definer set search_path = pg_catalog
as $$ select private.resolve_xometry_beta_dispatch_scope_with_access(p_job_id,p_declared_model_units,null); $$;
revoke all on function private.resolve_xometry_beta_dispatch_scope(uuid,text) from public,anon,authenticated,service_role;

create or replace function public.api_request_xometry_beta_dispatch(
  p_job_id uuid,
  p_declared_model_units text,
  p_expected_scope_fingerprint text,
  p_policy_revision text,
  p_approval_reference uuid,
  p_authority_to_share boolean,
  p_non_export_controlled boolean,
  p_quote_only boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_scope jsonb;
  v_capacity jsonb;
  v_access jsonb;
  v_organization_id uuid;
  v_result jsonb;
  v_existing private.xometry_beta_dispatch_permits%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_task public.work_queue%rowtype;
  v_result_row public.vendor_quote_results%rowtype;
  v_permit_id uuid := gen_random_uuid();
begin
  perform public.require_verified_auth();
  v_capacity := private.lock_free_quote_capacity(p_job_id);
  select organization_id into strict v_organization_id from public.jobs where id=p_job_id;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('quote-lane-submit:' || p_job_id::text, 0)
  );

  if p_authority_to_share is not true
    or p_non_export_controlled is not true
    or p_quote_only is not true then
    raise exception 'All Xometry beta dispatch affirmations are required.';
  end if;
  if p_approval_reference is null then
    raise exception 'A dispatch approval reference is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'xometry-beta-approval:'
        || v_organization_id::text
        || ':'
        || p_approval_reference::text,
      0
    )
  );

  select permit.* into v_existing
  from private.xometry_beta_dispatch_permits permit
  where permit.organization_id = v_organization_id
    and permit.approval_reference = p_approval_reference;
  if v_existing.id is not null and (
    v_existing.actor_user_id <> auth.uid() or v_existing.job_id <> p_job_id
    or v_existing.scope_fingerprint is distinct from p_expected_scope_fingerprint
    or v_existing.declared_model_units is distinct from p_declared_model_units
    or v_existing.notice_revision is distinct from p_policy_revision
  ) then raise exception 'xometry_beta_approval_reference_reused'; end if;
  v_scope := private.resolve_xometry_beta_dispatch_scope_with_access(
    p_job_id,
    p_declared_model_units,
    v_existing.id
  );
  if p_expected_scope_fingerprint is null
    or p_expected_scope_fingerprint <> v_scope ->> 'scopeFingerprint' then
    raise exception 'xometry_beta_scope_changed';
  end if;
  if p_policy_revision is null
    or p_policy_revision <> v_scope ->> 'policyRevision' then
    raise exception 'xometry_beta_notice_changed';
  end if;

  if v_existing.id is not null then
    if v_existing.actor_user_id <> auth.uid()
      or v_existing.job_id <> p_job_id
      or v_existing.scope_fingerprint <> p_expected_scope_fingerprint
      or v_existing.declared_model_units <> p_declared_model_units
      or v_existing.notice_revision <> p_policy_revision then
      raise exception 'xometry_beta_approval_reference_reused';
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', true, -- NOSONAR: stable dispatch response key
      'created', false, -- NOSONAR: stable dispatch response key
      'deduplicated', true,
      'permitId', v_existing.id,
      'quoteRequestId', v_existing.quote_request_id, -- NOSONAR: stable dispatch response key
      'quoteRunId', v_existing.quote_run_id,
      'scopeFingerprint', v_existing.scope_fingerprint,
      'status', 'queued'
    );
  end if;

  v_access := private.resolve_quote_access(p_job_id,auth.uid());
  if v_access ->> 'state' is distinct from 'eligible' then
    raise exception '%', coalesce(v_access ->> 'reasonCode','free_policy_unavailable');
  end if;
  if v_access ->> 'source' = 'free_beta' and v_capacity ->> 'bucketId' is null then
    raise exception 'free_policy_unavailable';
  end if;

  v_result := private.request_scoped_automatic_quote_impl(
    p_job_id,
    array['xometry']::public.vendor_name[]
  );
  if coalesce((v_result ->> 'accepted')::boolean, false) is not true
    or coalesce((v_result ->> 'created')::boolean, false) is not true then
    raise exception 'xometry_beta_new_lane_required';
  end if;

  select lane.* into strict v_lane
  from public.quote_request_lanes lane
  where lane.quote_request_id = (v_result ->> 'quoteRequestId')::uuid;
  if v_lane.vendor <> 'xometry'
    or v_lane.scope_fingerprint <> p_expected_scope_fingerprint
    or v_lane.part_id <> (v_scope ->> 'partId')::uuid
    or v_lane.requested_quantity <> 1 then
    raise exception 'xometry_beta_created_lane_mismatch';
  end if;

  select result_row.* into strict v_result_row
  from public.vendor_quote_results result_row
  where result_row.id = v_lane.vendor_quote_result_id;

  select task.* into strict v_task
  from public.work_queue task
  where task.quote_run_id = v_lane.quote_run_id
    and task.part_id = v_lane.part_id
    and task.task_type = 'run_vendor_quote'
    and task.payload ->> 'vendor' = 'xometry';

  insert into private.xometry_beta_dispatch_permits (
    id, organization_id, job_id, part_id, quote_request_id, quote_run_id,
    vendor_quote_result_id, quote_request_lane_id, work_queue_task_id,
    actor_user_id, notice_revision, approval_reference, provider,
    scope_version, scope_fingerprint, declared_model_units,
    authority_to_share, non_export_controlled, quote_only
  ) values (
    v_permit_id, (v_scope ->> 'organizationId')::uuid, p_job_id,
    (v_scope ->> 'partId')::uuid, v_lane.quote_request_id, v_lane.quote_run_id,
    v_result_row.id, v_lane.id, v_task.id, auth.uid(), p_policy_revision,
    p_approval_reference, 'xometry', v_lane.scope_version,
    v_lane.scope_fingerprint, p_declared_model_units,
    p_authority_to_share, p_non_export_controlled, p_quote_only
  );

  perform private.record_quote_access_admission(
    v_lane.quote_request_id, p_approval_reference, v_access ->> 'source',
    case when v_access ->> 'source' = 'free_beta' then (v_capacity ->> 'bucketId')::uuid else null end
  );

  update public.work_queue
  set payload = payload || pg_catalog.jsonb_build_object(
    'xometryBetaDispatchPermitId', v_permit_id,
    'xometryBetaEnvelopeRevision', 'xometry-controlled-beta-envelope.v1',
    'quoteLaneScopeFingerprint', v_lane.scope_fingerprint
  )
  where id = v_task.id;

  return v_result || pg_catalog.jsonb_build_object(
    'permitId', v_permit_id,
    'scopeFingerprint', v_lane.scope_fingerprint,
    'declaredModelUnits', p_declared_model_units,
    'envelopeRevision', 'xometry-controlled-beta-envelope.v1'
  );
end;
$$;

revoke all on function public.api_request_xometry_beta_dispatch(
  uuid, text, text, text, uuid, boolean, boolean, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.api_request_xometry_beta_dispatch(
  uuid, text, text, text, uuid, boolean, boolean, boolean
) to authenticated;

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
  v_admission jsonb;
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

  v_admission := private.validate_quote_access_admission(v_permit.quote_request_id,v_permit.id);
  if v_admission ->> 'source' = 'free_beta' then
    if v_admission -> 'valid' is distinct from 'true'::jsonb
      or v_admission ->> 'state' is distinct from 'reserved' then
      return pg_catalog.jsonb_build_object(v_authorized_key,false,v_reason_key,'dispatch_automatic_access_revoked');
    end if;
  elsif (v_admission -> 'valid' = 'true'::jsonb
      and v_admission ->> 'source' = 'commercial_entitlement'
      and v_admission ->> 'state' = 'unmetered')
    or v_admission ->> 'reasonCode' = 'legacy_unrecorded' then
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

  else
    return pg_catalog.jsonb_build_object(v_authorized_key,false,v_reason_key,'dispatch_automatic_access_revoked');
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
