-- OVD-367
-- Make one exact, human-confirmed Xometry disclosure scope and its queued
-- provider lane atomic. Automatic compatibility endpoints fail closed until
-- the OVD-369 confirmation surface adopts api_request_xometry_beta_dispatch.
--
-- Rollback: leave automatic quote rollout disabled; restore the three request
-- wrappers from 20260812044000 and api_enqueue_debug_vendor_quote from
-- 20260331000001; then revoke/drop the two new public RPCs and the private
-- scope helper. Retain the append-only permit table and evidence by default.
-- Drop that evidence table, trigger, and indexes only in a later, separately
-- reviewed retention migration.

create table private.xometry_beta_dispatch_permits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  part_id uuid not null,
  quote_request_id uuid not null,
  quote_run_id uuid not null,
  vendor_quote_result_id uuid not null,
  quote_request_lane_id uuid not null,
  work_queue_task_id uuid not null,
  actor_user_id uuid not null,
  notice_revision text not null,
  approval_reference uuid not null,
  provider public.vendor_name not null default 'xometry', -- NOSONAR: canonical provider contract repeats across DDL and dispatch predicates
  scope_version integer not null,
  scope_fingerprint text not null,
  declared_model_units text not null,
  envelope_revision text not null default 'xometry-controlled-beta-envelope.v1', -- NOSONAR: immutable envelope revision is persisted and returned verbatim
  authority_to_share boolean not null,
  non_export_controlled boolean not null,
  quote_only boolean not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint xometry_beta_dispatch_permits_provider_check
    check (provider = 'xometry'),
  constraint xometry_beta_dispatch_permits_scope_fingerprint_check
    check (scope_fingerprint ~ '^[a-f0-9]{64}$'), -- NOSONAR: fingerprint format is intentionally asserted at each trust boundary
  constraint xometry_beta_dispatch_permits_units_check
    check (declared_model_units in ('inch', 'millimeter')),
  constraint xometry_beta_dispatch_permits_affirmations_check
    check (authority_to_share and non_export_controlled and quote_only),
  constraint xometry_beta_dispatch_permits_notice_check
    check (length(trim(notice_revision)) between 1 and 200),
  unique (organization_id, approval_reference),
  unique (quote_request_lane_id),
  unique (work_queue_task_id)
);

alter table private.xometry_beta_dispatch_permits enable row level security;
alter table private.xometry_beta_dispatch_permits force row level security;
revoke all on private.xometry_beta_dispatch_permits
  from public, anon, authenticated, service_role;

create trigger xometry_beta_dispatch_permits_append_only
before update or delete on private.xometry_beta_dispatch_permits
for each row execute function private.reject_founding_beta_evidence_mutation();

create or replace function private.resolve_xometry_beta_dispatch_scope(
  p_job_id uuid,
  p_declared_model_units text
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

  v_denial := private.require_automatic_quote_access(p_job_id);
  if v_denial is not null then
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
  if v_effective_vendors <> array['xometry']::public.vendor_name[] then
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
  ) <> array['manufacturing_quote']::text[] then
    raise exception 'xometry_beta_manufacturing_quote_only';
  end if;
  if public.normalize_positive_integer_array(
    v_requirement.quote_quantities,
    v_requirement.quantity
  ) <> array[1]::integer[] then
    raise exception 'xometry_beta_quantity_one_required';
  end if;
  if not ('xometry'::public.vendor_name = any(v_requirement.applicable_vendors)) then
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

revoke all on function private.resolve_xometry_beta_dispatch_scope(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.api_get_xometry_beta_dispatch_scope(
  p_job_id uuid,
  p_declared_model_units text
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select private.resolve_xometry_beta_dispatch_scope(
    p_job_id,
    p_declared_model_units
  );
$$;

revoke all on function public.api_get_xometry_beta_dispatch_scope(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_get_xometry_beta_dispatch_scope(uuid, text)
  to authenticated;

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
  v_result jsonb;
  v_existing private.xometry_beta_dispatch_permits%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_task public.work_queue%rowtype;
  v_result_row public.vendor_quote_results%rowtype;
  v_permit_id uuid := gen_random_uuid();
begin
  perform public.require_verified_auth();
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

  v_scope := private.resolve_xometry_beta_dispatch_scope(
    p_job_id,
    p_declared_model_units
  );
  if p_expected_scope_fingerprint is null
    or p_expected_scope_fingerprint <> v_scope ->> 'scopeFingerprint' then
    raise exception 'xometry_beta_scope_changed';
  end if;
  if p_policy_revision is null
    or p_policy_revision <> v_scope ->> 'policyRevision' then
    raise exception 'xometry_beta_notice_changed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'xometry-beta-approval:'
        || (v_scope ->> 'organizationId')
        || ':'
        || p_approval_reference::text,
      0
    )
  );

  select permit.* into v_existing
  from private.xometry_beta_dispatch_permits permit
  where permit.organization_id = (v_scope ->> 'organizationId')::uuid
    and permit.approval_reference = p_approval_reference;
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

create or replace function private.xometry_beta_confirmation_required(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform public.require_verified_auth();
  if not public.user_can_edit_job(p_job_id) then
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;
  return pg_catalog.jsonb_build_object(
    'jobId', p_job_id,
    'accepted', false,
    'created', false,
    'deduplicated', false,
    'status', 'not_requested',
    'quoteRequestId', null,
    'quoteRunId', null,
    'serviceRequestLineItemId', null,
    'reasonCode', 'dispatch_confirmation_required',
    'reason', 'Review and confirm the exact Founding Beta Xometry disclosure before dispatch.',
    'requestedVendors', pg_catalog.jsonb_build_array(),
    'laneEligibility', pg_catalog.jsonb_build_array(),
    'quoteMode', 'automatic'
  );
end;
$$;

revoke all on function private.xometry_beta_confirmation_required(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.api_request_quote_scoped(
  p_job_id uuid,
  p_selected_vendors public.vendor_name[]
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select private.xometry_beta_confirmation_required(p_job_id);
$$;

create or replace function public.api_request_quote(
  p_job_id uuid,
  p_force_retry boolean default false
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select private.xometry_beta_confirmation_required(p_job_id);
$$;

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
      private.xometry_beta_confirmation_required(v_job_id)
    );
  end loop;
  return v_results;
end;
$$;

revoke all on function public.api_request_quote_scoped(uuid, public.vendor_name[])
  from public, anon, authenticated, service_role;
revoke all on function public.api_request_quote(uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.api_request_quotes(uuid[], boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.api_request_quote_scoped(uuid, public.vendor_name[])
  to authenticated;
grant execute on function public.api_request_quote(uuid, boolean)
  to authenticated;
grant execute on function public.api_request_quotes(uuid[], boolean)
  to authenticated;

-- The historical debug RPC was an authenticated direct work_queue insert.
-- Keep its response contract available to internal UI callers, but retire the
-- queue mutation so it cannot bypass the exact-scope permit transaction.
create or replace function public.api_enqueue_debug_vendor_quote(
  p_quote_run_id uuid,
  p_part_id uuid,
  p_vendor public.vendor_name,
  p_requested_quantity integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job_id uuid;
begin
  perform public.require_verified_auth();

  select quote_run.job_id into v_job_id
  from public.quote_runs quote_run
  join public.vendor_quote_results result
    on result.quote_run_id = quote_run.id
  where quote_run.id = p_quote_run_id
    and result.part_id = p_part_id
    and result.vendor = p_vendor
    and result.requested_quantity = p_requested_quantity
  limit 1;

  if v_job_id is null or not public.user_can_edit_job(v_job_id) then
    raise exception 'No matching vendor quote lane found, or you do not have permission to access it.';
  end if;

  return pg_catalog.jsonb_build_object(
    'taskId', null,
    'created', false,
    'reasonCode', 'dispatch_confirmation_required',
    'reason', 'Debug vendor enqueue is unavailable during the controlled Founding Beta.'
  );
end;
$$;

revoke all on function public.api_enqueue_debug_vendor_quote(
  uuid, uuid, public.vendor_name, integer
) from public, anon, authenticated, service_role;
grant execute on function public.api_enqueue_debug_vendor_quote(
  uuid, uuid, public.vendor_name, integer
) to authenticated;
