-- OVD-1163 rollback draft: authorized migration window only, one transaction.
-- Restores the OVD-1007 body (20261101130100) of
-- private.resolve_xometry_beta_dispatch_scope_with_access byte for byte (md5
-- 1d482bb5747127128e041549291eae6e) and drops
-- public.api_set_client_part_quote_as_machined. While it is live, the
-- Material check lowercases the name and drops every character outside a-z
-- and 0-9, then accepts only 6061t6, 6061t6aluminum and aluminum6061t6: so
-- "6061-T6", "6061 T6", "6061T6", "6061-T6 Aluminum" and "Aluminum 6061-T6"
-- pass, while "6061", "6061 Alloy" and "Al 6061" are refused again. A
-- finished part is refused again too, and the OVD-1163 client still offers
-- "Quote as machined": that click fails (the RPC is gone) and the popup says
-- "That change didn't save. Try again." Roll the client back first, or in the
-- same window, so customers are not offered a fix that cannot work.
-- Stored spec_snapshot.quoteAsMachined values are kept (the restored body
-- never reads them), so no data is deleted and re-applying the migration
-- honours them again. A permit already issued is not revoked; the worker's
-- as-machined mapping (worker/src/quoteAsMachined.ts) stays correct either way.

set local lock_timeout = '5s';

do $ovd1163_rollback_guard$
declare
  v_md5 text;
begin
  select pg_catalog.md5(p.prosrc) into v_md5
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)');
  if v_md5 is null or v_md5 not in ('4fd2484f5bfe9b524f5916b7e99ec88e', '1d482bb5747127128e041549291eae6e') then
    raise exception 'OVD-1163 rollback refused: private.resolve_xometry_beta_dispatch_scope_with_access has an unexpected body (md5 %)', coalesce(v_md5, 'missing')
      using errcode = '55000';
  end if;
  select pg_catalog.md5(p.prosrc) into v_md5
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('public.api_set_client_part_quote_as_machined(uuid,boolean)');
  if v_md5 is not null and v_md5 <> '3da7b3c9b4ab9db0d84abd38136182a1' then
    raise exception 'OVD-1163 rollback refused: public.api_set_client_part_quote_as_machined has an unexpected body (md5 %)', v_md5
      using errcode = '55000';
  end if;
end;
$ovd1163_rollback_guard$;

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
  ) is distinct from array[1]::integer[]
    and not private.xometry_beta_user_quantity_enabled()
    -- OVD-1007: or a per-request grant for this job (its exact quantity and
    -- fingerprint are matched below, once the scope is known).
    and private.xometry_beta_quantity_grant_id(p_job_id, p_existing_permit_id, null, null) is null then
    raise exception 'xometry_beta_quantity_one_required';
  end if;
  -- OVD-987: while controlled_beta_user_quantity is on, one positive
  -- quantity of any size is admitted; several quantities (or none) are not.
  if pg_catalog.cardinality(public.normalize_positive_integer_array(
    v_requirement.quote_quantities,
    v_requirement.quantity
  )) <> 1 then
    raise exception 'xometry_beta_single_quantity_required';
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
  -- OVD-1007: without the switch, the grant must name this quantity and scope.
  if v_candidate.requested_quantity <> 1
    and not private.xometry_beta_user_quantity_enabled()
    and private.xometry_beta_quantity_grant_id(
      p_job_id,
      p_existing_permit_id,
      v_candidate.scope_fingerprint,
      v_candidate.requested_quantity
    ) is null then
    raise exception 'xometry_beta_quantity_one_required';
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
-- Owner-only: callers are SECURITY DEFINER; no API role gets EXECUTE.
grant execute on function private.resolve_xometry_beta_dispatch_scope_with_access(uuid, text, uuid) to postgres;


drop function if exists public.api_set_client_part_quote_as_machined(uuid, boolean);
