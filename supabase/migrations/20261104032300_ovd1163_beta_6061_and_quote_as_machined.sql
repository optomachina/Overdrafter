-- =====================================================================
-- OVD-1163: the controlled Xometry beta accepts 6061 written without a
-- temper as 6061-T6, and a customer can quote a finished part as machined.
-- Apply only in an approved migration window, as one transaction, after
-- every earlier migration (none of the open ones touches these functions).
-- Rollback: docs/migration-drafts/ovd-1163.rollback.sql.
-- pgTAP: supabase/tests/ovd1163_beta_6061_and_quote_as_machined.sql.
--
-- What changes:
--   1. private.resolve_xometry_beta_dispatch_scope_with_access (restated from
--      OVD-1007, 20261101130100; only the Material and Finish checks change):
--      a. Material, normalized as before (trimmed, lowercased, a-z0-9 only),
--         must match
--           ^(aluminum|aluminium|al)?(alloy)?6061(t6|t651|t6511|t6t651)?(aluminum|aluminium|al)?(alloy)?$
--         so "6061", "6061 Alloy", "Al 6061", "6061 aluminum" and
--         "Aluminum 6061" pass with the three forms accepted before.
--         T651, T6511 and T6/T651 are T6 stress-relieved by stretching
--         (ANSI H35.1) with T6's mechanical properties and are the form
--         6061-T6 bar and plate is supplied in, so they pass. Any other
--         stated temper (6061-O, -F, -T4, -T451, -T62 ...) stays refused
--         with xometry_beta_6061_t6_required.
--      b. Finish: a finish other than blank or As machined passes only when
--         spec_snapshot.quoteAsMachined.finish names that same finish (same
--         normalization). The finish column is never changed, so the drawing
--         finish stays on the part; editing it later withdraws the choice.
--   2. public.api_set_client_part_quote_as_machined(p_job_id, p_quote_as_machined):
--      new, authenticated only. Same verified-auth and edit-access checks as
--      the full request save (load_editable_project_part_context), canonical
--      job -> part -> requirement row locks, writes only
--      spec_snapshot.quoteAsMachined = {"finish": <current finish>} (or
--      removes it), audits client.part_quote_as_machined_set on a change.
--      The scope fingerprint covers spec_snapshot, so a choice changes the
--      scope and withdraws any earlier consent. The worker sends As machined
--      for the same choice (worker/src/quoteAsMachined.ts).
--   Security attributes, search_path, owner, revokes and grants of the
--   restated resolver are unchanged and restated.
--
-- md5(prosrc) of the resolver: 1d482bb5747127128e041549291eae6e (OVD-1007)
--                           -> 4fd2484f5bfe9b524f5916b7e99ec88e (this file)
-- md5(prosrc) of the new RPC: 3da7b3c9b4ab9db0d84abd38136182a1
-- Precondition: refuses unless each function is the reviewed body, this
-- file's body, or (the new RPC) absent. Every statement can be re-run.
-- =====================================================================

set local lock_timeout = '5s';

do $ovd1163_guard$
declare
  v_check record;
  v_md5 text;
begin
  for v_check in
    select * from (values
      ('private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)',
        array['1d482bb5747127128e041549291eae6e', '4fd2484f5bfe9b524f5916b7e99ec88e'], false),
      ('public.api_set_client_part_quote_as_machined(uuid,boolean)',
        array['3da7b3c9b4ab9db0d84abd38136182a1'], true)
    ) as t(signature, accepted, may_be_absent)
  loop
    v_md5 := null;
    select pg_catalog.md5(p.prosrc) into v_md5
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure(v_check.signature);
    if v_md5 is null and v_check.may_be_absent then
      continue;
    end if;
    if v_md5 is null or not (v_md5 = any (v_check.accepted)) then
      raise exception 'OVD-1163 refused: % is not the definition this migration was reviewed against (md5 %)',
        v_check.signature, coalesce(v_md5, 'missing')
        using errcode = '55000';
    end if;
  end loop;
end;
$ovd1163_guard$;

-- 1. The legacy Xometry resolver (latest OVD-1007).
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
  -- OVD-1163: 6061 written without a temper ("6061", "6061 Alloy", "Al 6061",
  -- "Aluminum 6061") is the beta's 6061-T6, as are T651, T6511 and T6/T651
  -- (T6 stress-relieved by stretching). Any other stated temper is refused.
  if v_material !~ '^(aluminum|aluminium|al)?(alloy)?6061(t6|t651|t6511|t6t651)?(aluminum|aluminium|al)?(alloy)?$' then
    raise exception 'xometry_beta_6061_t6_required';
  end if;
  -- OVD-1163: a drawing finish passes only when the customer chose "Quote as
  -- machined" for this exact finish (public.api_set_client_part_quote_as_machined).
  -- The finish column is unchanged; the worker sends as-machined.
  if v_finish not in ('', 'asmachined')
    and v_finish is distinct from pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.spec_snapshot #>> '{quoteAsMachined,finish}', ''))),
      '[^a-z0-9]', '', 'g'
    ) then
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


-- 2. The customer's "Quote as machined" choice, a quote-only finish override.
create or replace function public.api_set_client_part_quote_as_machined(
  p_job_id uuid,
  p_quote_as_machined boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_context record;
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_finish text;
  v_choice jsonb;
  v_rows integer;
begin
  -- Same verified-auth and edit access checks as the full-save RPC.
  select * into v_context from public.load_editable_project_part_context(p_job_id);
  v_job := v_context.job;
  v_part := v_context.part;

  -- Canonical writer order: job, part, approved requirement. Read the current
  -- requirement under its row lock, never the context's copy.
  perform 1 from public.jobs where id = v_job.id for no key update;
  perform 1 from public.parts where id = v_part.id for no key update;
  select requirement.* into v_requirement
  from public.approved_part_requirements requirement
  where requirement.part_id = v_part.id
  for no key update;
  if v_requirement.id is null then
    raise exception 'quote_as_machined_requirements_required';
  end if;

  -- The choice names the finish it overrides, so editing the finish later
  -- withdraws it. A blank or as-machined finish needs no choice.
  v_finish := nullif(pg_catalog.btrim(coalesce(v_requirement.finish, '')), '');
  if p_quote_as_machined is true
    and v_finish is not null
    and pg_catalog.regexp_replace(pg_catalog.lower(v_finish), '[^a-z0-9]', '', 'g') <> 'asmachined' then
    v_choice := pg_catalog.jsonb_build_object('finish', v_finish);
  end if;

  -- Only spec_snapshot changes: the finish column, every other field and
  -- updated_at stay as they are.
  update public.approved_part_requirements
  set spec_snapshot = case
    when v_choice is null then coalesce(spec_snapshot, '{}'::jsonb) - 'quoteAsMachined'
    else coalesce(spec_snapshot, '{}'::jsonb) || pg_catalog.jsonb_build_object('quoteAsMachined', v_choice)
  end
  where part_id = v_part.id
    and (spec_snapshot -> 'quoteAsMachined') is distinct from v_choice;
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    perform public.log_audit_event(v_job.organization_id,
      'client.part_quote_as_machined_set',
      pg_catalog.jsonb_build_object('jobId', v_job.id, 'partId', v_part.id,
        'quoteAsMachined', v_choice is not null, 'finish', v_finish),
      v_job.id, null);
  end if;

  return pg_catalog.jsonb_build_object('jobId', v_job.id, 'quoteAsMachined', v_choice is not null);
end;
$$;

revoke all on function public.api_set_client_part_quote_as_machined(uuid, boolean) from public, anon, service_role;
grant execute on function public.api_set_client_part_quote_as_machined(uuid, boolean) to authenticated;
