-- OVD-762 item 1: let Xometry join a multi provider confirmation.
--
-- DRAFT ONLY. Not a migration and not applied anywhere. The lead promotes it
-- to supabase/migrations in a migration window. Rollback:
-- docs/migration-drafts/ovd-762-xometry-fanout-scope.rollback.sql. pgTAP:
-- supabase/tests/ovd762_xometry_fanout_scope_draft.sql installs byte copies of
-- both files from supabase/tests/fixtures.
--
-- Problem. private.resolve_xometry_beta_dispatch_scope_with_access raises
-- xometry_beta_exact_provider_set_required unless the effective vendor set is
-- exactly {xometry}, and api_authorize_xometry_beta_worker_dispatch refuses the
-- same way at dispatch time. One confirmation that fans out to Xometry and
-- another provider therefore never reaches Xometry.
--
-- Choice: an explicit fan out marker on new Xometry RPCs, not a move onto the
-- generic provider path. The generic path refuses Xometry on purpose
-- (provider_dispatch_specialized_path_required) and the Xometry worker reads
-- only xometry_beta_dispatch_permits, so moving it would mean a second permit
-- table, envelope and worker contract for one provider. The marker keeps every
-- existing Xometry rule and changes one predicate.
--
-- What changes:
--   * private.xometry_beta_fanout_markers: append only, one row per fan out
--     permit, recording the confirmation reference and the provider set the
--     customer confirmed. Unique per confirmation, so one Xometry permit per
--     confirmation.
--   * New four argument scope resolver and two new client RPCs. They copy the
--     current Xometry resolver and request byte for byte except for the
--     marker: the provider set must contain Xometry and one other provider,
--     every provider in it must be enabled for the job, and the approval
--     reference must be the confirmation reference or the fan out reference
--     derived from it (the same RFC 9562 version 5 name the client derives).
--     Scope fingerprint, notice, envelope, affirmations, permit, one active
--     lane, rate and cost caps, and the export affirmation are unchanged.
--   * api_authorize_xometry_beta_worker_dispatch: a permit with a marker
--     needs every confirmed provider still enabled; a permit without one
--     keeps the exact rule.
-- Untouched: api_request_xometry_beta_dispatch, api_get_xometry_beta_dispatch_scope
-- and the three argument resolver, so the single provider path is unchanged.
-- No DROP statements.

-- Require the OVD-987 quantity checks and the OVD-1007 quantity grant before
-- wrapping or replacing this body.
do $xometry_quantity_precondition$
declare
  v_md5 text;
begin
  select pg_catalog.md5(p.prosrc) into v_md5
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure(
    'public.api_authorize_xometry_beta_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)'
  );
  if v_md5 is distinct from '5d7e026241a0346a6624063e86a088f7' then
    raise exception 'OVD-762 refused: Xometry preflight is not the OVD-1007 body (md5 %)',
      coalesce(v_md5, 'missing') using errcode = 'P0001';
  end if;
end;
$xometry_quantity_precondition$;

create table private.xometry_beta_fanout_markers (
  permit_id uuid primary key
    references private.xometry_beta_dispatch_permits (id),
  organization_id uuid not null,
  job_id uuid not null,
  confirmation_reference uuid not null,
  approval_reference uuid not null,
  vendors public.vendor_name[] not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint xometry_beta_fanout_markers_vendors_check
    check ('xometry'::public.vendor_name = any(vendors) and cardinality(vendors) >= 2),
  unique (organization_id, confirmation_reference)
);

alter table private.xometry_beta_fanout_markers enable row level security;
alter table private.xometry_beta_fanout_markers force row level security;
revoke all on private.xometry_beta_fanout_markers
  from public, anon, authenticated, service_role;

create trigger xometry_beta_fanout_markers_append_only
before update or delete on private.xometry_beta_fanout_markers
for each row execute function private.reject_founding_beta_evidence_mutation();

-- Sorted, distinct provider set; refuses nulls, duplicates, a set without
-- Xometry, and a set of one (that is the single provider path).
create function private.canonical_xometry_beta_fanout_vendors(
  p_vendors public.vendor_name[]
)
returns public.vendor_name[]
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_canonical public.vendor_name[];
begin
  if p_vendors is null
    or pg_catalog.array_ndims(p_vendors) is distinct from 1
    or pg_catalog.array_position(p_vendors, null) is not null then
    raise exception 'xometry_beta_fanout_marker_invalid';
  end if;
  select pg_catalog.array_agg(distinct vendor order by vendor)
  into v_canonical
  from pg_catalog.unnest(p_vendors) vendor;
  if pg_catalog.cardinality(v_canonical) <> pg_catalog.cardinality(p_vendors)
    or pg_catalog.cardinality(v_canonical) < 2
    or not ('xometry'::public.vendor_name = any(v_canonical)) then
    raise exception 'xometry_beta_fanout_marker_invalid';
  end if;
  return v_canonical;
end;
$$;

revoke all on function private.canonical_xometry_beta_fanout_vendors(public.vendor_name[])
  from public, anon, authenticated, service_role;

-- RFC 9562 version 5 name: namespace = confirmation reference, name =
-- "provider-fanout:xometry". Matches deriveFanoutApprovalReference in
-- src/features/quotes/provider-fanout-dispatch.ts.
create function private.xometry_beta_fanout_approval_reference(
  p_confirmation_reference uuid
)
returns uuid
language sql
immutable
set search_path = pg_catalog
as $$
  select pg_catalog.encode(
    pg_catalog.set_byte(
      pg_catalog.set_byte(
        hashed.bytes,
        6,
        (pg_catalog.get_byte(hashed.bytes, 6) operator(pg_catalog.&) 15) operator(pg_catalog.|) 80
      ),
      8,
      (pg_catalog.get_byte(hashed.bytes, 8) operator(pg_catalog.&) 63) operator(pg_catalog.|) 128
    ),
    'hex'
  )::uuid
  from (
    select pg_catalog.substring(
      extensions.digest(
        pg_catalog.uuid_send(p_confirmation_reference)
          operator(pg_catalog.||) pg_catalog.convert_to('provider-fanout:xometry', 'UTF8'),
        'sha1'
      ),
      1,
      16
    ) as bytes
  ) hashed;
$$;

revoke all on function private.xometry_beta_fanout_approval_reference(uuid)
  from public, anon, authenticated, service_role;

-- Copy of the current resolver (20261010230000) with one changed predicate.
create function private.resolve_xometry_beta_dispatch_scope_with_access(
  p_job_id uuid,
  p_declared_model_units text,
  p_existing_permit_id uuid,
  p_fanout_vendors public.vendor_name[]
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
  -- OVD-762: the only change from the three argument resolver. The fan out
  -- marker is the provider set the customer confirmed; it must name Xometry
  -- and at least one other provider, and every one of them must still be
  -- enabled for this job. Without a marker this function is never called.
  if not (
    private.canonical_xometry_beta_fanout_vendors(p_fanout_vendors) operator(pg_catalog.<@) v_effective_vendors
  ) then
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

  -- OVD-682: name the missing confirmed destination instead of letting the
  -- shared candidate path silently drop the Xometry lane.
  if private.current_confirmed_sourcing_address(v_job.organization_id) is null then
    raise exception 'xometry_beta_confirmed_sourcing_address_required';
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

revoke all on function private.resolve_xometry_beta_dispatch_scope_with_access(
  uuid, text, uuid, public.vendor_name[]
)
  from public, anon, authenticated, service_role;

create function public.api_get_xometry_beta_fanout_dispatch_scope(
  p_job_id uuid,
  p_declared_model_units text,
  p_fanout_vendors public.vendor_name[]
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select private.resolve_xometry_beta_dispatch_scope_with_access(
    p_job_id,
    p_declared_model_units,
    null,
    p_fanout_vendors
  );
$$;

revoke all on function public.api_get_xometry_beta_fanout_dispatch_scope(
  uuid, text, public.vendor_name[]
) from public, anon, authenticated, service_role;
grant execute on function public.api_get_xometry_beta_fanout_dispatch_scope(
  uuid, text, public.vendor_name[]
) to authenticated;

-- Copy of api_request_xometry_beta_dispatch (20261004100000) plus the marker.
create function public.api_request_xometry_beta_fanout_dispatch(
  p_job_id uuid,
  p_declared_model_units text,
  p_expected_scope_fingerprint text,
  p_policy_revision text,
  p_approval_reference uuid,
  p_fanout_confirmation_reference uuid,
  p_fanout_vendors public.vendor_name[],
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
  v_fanout_vendors public.vendor_name[];
  v_existing_marker private.xometry_beta_fanout_markers%rowtype;
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
  -- OVD-762: the marker binds this permit to one customer confirmation. The
  -- approval reference is the confirmation reference itself (Xometry is the
  -- primary) or the fan out reference derived from it (Xometry is an extra).
  v_fanout_vendors := private.canonical_xometry_beta_fanout_vendors(p_fanout_vendors);
  if p_fanout_confirmation_reference is null
    or p_approval_reference not in (
      p_fanout_confirmation_reference,
      private.xometry_beta_fanout_approval_reference(p_fanout_confirmation_reference)
    ) then
    raise exception 'xometry_beta_fanout_confirmation_mismatch';
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
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'xometry-beta-fanout:'
        || v_organization_id::text
        || ':'
        || p_fanout_confirmation_reference::text,
      0
    )
  );
  select marker.* into v_existing_marker
  from private.xometry_beta_fanout_markers marker
  where marker.organization_id = v_organization_id
    and marker.confirmation_reference = p_fanout_confirmation_reference;
  -- One Xometry permit per confirmation, and a replay must carry the same
  -- confirmed provider set. A permit from the single provider path never
  -- has a marker, so it cannot be replayed through this function.
  if (v_existing.id is not null and (
      v_existing_marker.permit_id is distinct from v_existing.id
      or v_existing_marker.vendors is distinct from v_fanout_vendors
    ))
    or (v_existing.id is null and v_existing_marker.permit_id is not null) then
    raise exception 'xometry_beta_fanout_confirmation_reused';
  end if;
  if v_existing.id is null then
    perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);
  end if;
  v_scope := private.resolve_xometry_beta_dispatch_scope_with_access(
    p_job_id,
    p_declared_model_units,
    v_existing.id,
    v_fanout_vendors
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

  insert into private.xometry_beta_fanout_markers (
    permit_id, organization_id, job_id, confirmation_reference,
    approval_reference, vendors
  ) values (
    v_permit_id, (v_scope ->> 'organizationId')::uuid, p_job_id,
    p_fanout_confirmation_reference, p_approval_reference, v_fanout_vendors
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

revoke all on function public.api_request_xometry_beta_fanout_dispatch(
  uuid, text, text, text, uuid, uuid, public.vendor_name[], boolean, boolean, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.api_request_xometry_beta_fanout_dispatch(
  uuid, text, text, text, uuid, uuid, public.vendor_name[], boolean, boolean, boolean
) to authenticated;


-- Copy of the current worker preflight (20261002182910) with one changed
-- predicate: the provider set check reads the permit's marker.
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
  v_fanout_vendors public.vendor_name[];
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
    -- OVD-987: the lane quantity must be the one its own scope snapshot states,
    -- and the result and the task payload the worker reads must name it too.
    or v_lane.requested_quantity::text is distinct from (v_lane.scope_snapshot ->> 'quantity')
    or v_result.requested_quantity is distinct from v_lane.requested_quantity
    or (v_task.payload ? 'requestedQuantity'
      and v_task.payload ->> 'requestedQuantity' is distinct from v_lane.requested_quantity::text)
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

  -- OVD-987: a lane above quantity 1 dispatches only while the
  -- controlled_beta_user_quantity switch is on. The shared lock makes an
  -- audited disable wait for this check, like the rollout check above.
  if v_lane.requested_quantity <> 1 then
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('commercial-rollout:controlled_beta_user_quantity', 0)
    );
    -- OVD-1007: or the unrevoked grant this permit consumed. The shared lock
    -- makes an audited revoke wait for this check.
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('xometry-beta-quantity-grant:' || v_permit.job_id::text, 0)
    );
    if not private.xometry_beta_user_quantity_enabled()
      and private.xometry_beta_quantity_grant_id(
        v_permit.job_id,
        v_permit.id,
        v_permit.scope_fingerprint,
        v_lane.requested_quantity
      ) is null then
      return pg_catalog.jsonb_build_object(
        v_authorized_key, false,
        v_reason_key, 'dispatch_quantity_not_admitted'
      );
    end if;
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
  -- OVD-762: a fan out permit keeps the provider set its customer confirmed;
  -- every one of them must still be enabled. Any other permit keeps the
  -- exact single provider rule.
  select marker.vendors into v_fanout_vendors
  from private.xometry_beta_fanout_markers marker
  where marker.permit_id = v_permit.id;
  if (v_fanout_vendors is null
      and v_effective_vendors <> array[v_provider]::public.vendor_name[])
    or (v_fanout_vendors is not null
      and not (v_fanout_vendors operator(pg_catalog.<@) v_effective_vendors)) then
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
    and candidate.requested_quantity = v_lane.requested_quantity; -- OVD-987

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
