-- OVD-679/680/682: let any verified organization member enter and confirm the
-- quote shipping destination, and name its absence in the Xometry beta scope.
-- Address edits go through a column-bounded RPC instead of a broad member
-- UPDATE policy, so members cannot rename the organization, change its slug,
-- or write any other organizations column. Edits still append inferred
-- history through record_sourcing_address_change and revoke confirmation.
-- Confirmation keeps the OVD-570 contract (bigint history event id) and only
-- widens the caller check from internal_admin to organization membership.
-- Rollback: fix forward; restoring the is_org_admin check re-blocks clients.

create or replace function public.api_update_organization_addresses(
  p_organization_id uuid,
  p_patch jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_org_id uuid;
  v_key text;
  v_value jsonb;
begin
  perform public.require_verified_auth();
  if not public.user_can_access_org(p_organization_id) then
    raise exception 'organization_address_access_denied';
  end if;
  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object' then
    raise exception 'organization_address_invalid';
  end if;
  for v_key, v_value in select patch.key, patch.value from pg_catalog.jsonb_each(p_patch) patch loop
    if v_key = 'shippingSameAsBilling' then
      if pg_catalog.jsonb_typeof(v_value) <> 'boolean' then
        raise exception 'organization_address_invalid';
      end if;
    elsif v_key in (
      'billingStreet', 'billingCity', 'billingState', 'billingZip', 'billingCountry',
      'shippingStreet', 'shippingCity', 'shippingState', 'shippingZip', 'shippingCountry'
    ) then
      if pg_catalog.jsonb_typeof(v_value) not in ('string', 'null')
        or pg_catalog.length(coalesce(v_value #>> '{}', '')) > 200 then
        raise exception 'organization_address_invalid';
      end if;
    else
      raise exception 'organization_address_invalid';
    end if;
  end loop;

  select org.id into v_org_id
  from public.organizations org
  where org.id = p_organization_id
  for update;
  -- Lock waits can outlive a membership or verified-auth revocation.
  perform public.require_verified_auth();
  if v_org_id is null or not public.user_can_access_org(p_organization_id) then
    raise exception 'organization_address_access_denied';
  end if;

  update public.organizations org
  set billing_street = case when p_patch ? 'billingStreet'
        then nullif(pg_catalog.btrim(p_patch ->> 'billingStreet'), '') else org.billing_street end,
      billing_city = case when p_patch ? 'billingCity'
        then nullif(pg_catalog.btrim(p_patch ->> 'billingCity'), '') else org.billing_city end,
      billing_state = case when p_patch ? 'billingState'
        then nullif(pg_catalog.btrim(p_patch ->> 'billingState'), '') else org.billing_state end,
      billing_zip = case when p_patch ? 'billingZip'
        then nullif(pg_catalog.btrim(p_patch ->> 'billingZip'), '') else org.billing_zip end,
      billing_country = case when p_patch ? 'billingCountry'
        then nullif(pg_catalog.btrim(p_patch ->> 'billingCountry'), '') else org.billing_country end,
      shipping_same_as_billing = case when p_patch ? 'shippingSameAsBilling'
        then (p_patch ->> 'shippingSameAsBilling')::boolean else org.shipping_same_as_billing end,
      shipping_street = case when p_patch ? 'shippingStreet'
        then nullif(pg_catalog.btrim(p_patch ->> 'shippingStreet'), '') else org.shipping_street end,
      shipping_city = case when p_patch ? 'shippingCity'
        then nullif(pg_catalog.btrim(p_patch ->> 'shippingCity'), '') else org.shipping_city end,
      shipping_state = case when p_patch ? 'shippingState'
        then nullif(pg_catalog.btrim(p_patch ->> 'shippingState'), '') else org.shipping_state end,
      shipping_zip = case when p_patch ? 'shippingZip'
        then nullif(pg_catalog.btrim(p_patch ->> 'shippingZip'), '') else org.shipping_zip end,
      shipping_country = case when p_patch ? 'shippingCountry'
        then nullif(pg_catalog.btrim(p_patch ->> 'shippingCountry'), '') else org.shipping_country end
  where org.id = p_organization_id;
end;
$$;

create or replace function public.api_confirm_sourcing_destination(
  p_organization_id uuid,
  p_expected_address jsonb
)
returns bigint
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_org public.organizations%rowtype;
  v_address jsonb;
  v_event_id bigint;
begin
  perform public.require_verified_auth();
  if not public.user_can_access_org(p_organization_id) then
    raise exception 'sourcing_destination_access_denied';
  end if;
  select * into v_org from public.organizations where id = p_organization_id for update;
  -- Lock waits can outlive a membership or verified-auth revocation.
  perform public.require_verified_auth();
  if v_org.id is null or not public.user_can_access_org(p_organization_id) then
    raise exception 'sourcing_destination_access_denied';
  end if;
  v_address := private.sourcing_address_from_row(v_org);
  if p_expected_address is distinct from v_address then
    raise exception 'sourcing_destination_changed';
  end if;
  if not private.sourcing_address_complete(v_address) then
    raise exception 'sourcing_destination_incomplete';
  end if;
  insert into private.sourcing_destination_history (organization_id, state, address, actor_id)
  values (p_organization_id, 'confirmed', v_address, auth.uid())
  returning id into v_event_id;
  return v_event_id;
end;
$$;

revoke all on function public.api_update_organization_addresses(uuid, jsonb) from public, anon, service_role;
grant execute on function public.api_update_organization_addresses(uuid, jsonb) to authenticated;
revoke all on function public.api_confirm_sourcing_destination(uuid, jsonb) from public, anon, service_role;
grant execute on function public.api_confirm_sourcing_destination(uuid, jsonb) to authenticated;

-- Unchanged from 20260815100000 except for the named destination check
-- immediately before the shared candidate lookup.

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

revoke all on function private.resolve_xometry_beta_dispatch_scope(uuid, text)
  from public, anon, authenticated, service_role;
