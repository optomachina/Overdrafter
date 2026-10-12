-- OVD-628: make the generic admission fail fast on its scope row locks, the
-- construction the legacy path uses (OVD-598, 20261004100000).
--
-- public.api_request_provider_dispatch validated its scope in
-- private.resolve_provider_dispatch_scope, which held the job, parts,
-- approved requirements and CAD/drawing files FOR SHARE with ordinary waiting
-- locks (20261003160000). Writers that take those rows in another order closed
-- lock cycles with it: the worker's api_register_trusted_file_hash (file, then
-- part) and the client's api_reset_client_part_property_overrides
-- (requirement, then part) made the request the 40P01 victim, and the
-- request's later line-item upsert and project foreign-key check made the
-- client's api_cancel_quote_request (line item, then job) and
-- api_delete_project (project, then job) the 40P01 victim. Re-ordering the
-- writers one by one only moves the cycle, because the schema's delete
-- cascades take job_files before parts.
--
-- A fresh request now calls private.lock_provider_dispatch_scope_rows after
-- its approval advisory lock and its replay block, before the resolver
-- validates anything. The helper takes every existing row the request
-- validates or later writes: the job FOR NO KEY UPDATE, the strength of the
-- request's final jobs status update, so no lock is upgraded later; parts by
-- id, approved requirements by part_id and the CAD/drawing files by id FOR
-- SHARE (only read); the job's manufacturing_quote/part service request line
-- item FOR NO KEY UPDATE (the impl's upsert target and the status-sync
-- trigger's update); the job's project FOR KEY SHARE, the strength of the
-- line-item foreign-key check, because a client project deletion holds the
-- project and then waits on the job; and, on the generic path only, the
-- provider's admission policy row and its active reviewed envelope FOR SHARE,
-- which the resolver held before so the rollback switch cannot change
-- underneath an in-flight permit. No API role has any privilege on those two
-- private tables and no function writes them, so only database-owner
-- sessions (migrations, operator SQL) can hold them in a conflicting mode.
--
-- Every one of these row locks is NOWAIT. If any row is held by an in-flight
-- transaction in a conflicting mode, the request fails at once and closed
-- with P0001 provider_dispatch_job_busy (mapped from SQLSTATE 55P03) and
-- leaves no rows; the client retries.
--
-- The resolver is restated without its row locks. The request's only row
-- locks are therefore the helper's NOWAIT locks, and the read-only preview
-- (public.api_get_provider_dispatch_scope) and an exact replay of a committed
-- dispatch, which both call the resolver, take no row lock.
--
-- Invariant: after the NOWAIT block, the request's only heavyweight waits are
-- three named allowed waits: (1) the founding-beta:<org> shared advisory
-- lock, (2) the commercial-rollout:automatic_quote_collection shared advisory
-- lock, and (3) the implicit KEY SHARE on the organization and user
-- foreign-key parents during its inserts, whose conflicting holders are
-- admin-only. For each shared advisory lock, no holder, after taking it,
-- waits on a lock that conflicts with one this request holds.
-- (1) founding-beta:<org>, taken by the resolver and again by
-- private.resolve_quote_access_for_permit. Another generic request takes it
-- shared and then writes only its own job's rows (a same-job request is
-- serialized by quote-lane-submit:<job>, taken before any row lock); a legacy
-- request takes it shared after its own NOWAIT block (on its replay path it
-- holds no row lock) and then writes only its own job's rows (a same-job
-- legacy request is serialized by the same quote-lane-submit:<job> lock);
-- both worker authorize RPCs lock their rows before it and write nothing
-- after it; the previews take no row lock. Its
-- exclusive holder is public.api_admin_set_founding_beta_enrollment
-- (internal admin), which reads the organization with a plain EXISTS and only
-- inserts enrollment events; every other holder takes it shared.
-- (2) commercial-rollout:automatic_quote_collection, taken through
-- private.automatic_quote_rollout_enabled_with_lock() in
-- private.resolve_quote_access_for_permit. Its exclusive holders are the
-- service_role-only public.api_set_commercial_rollout_control, which then
-- locks only the private.commercial_rollout_controls row (read here without a
-- lock) and inserts events, and the operator production-release lock-holder
-- sessions (scripts/hold-ovd373-production-locks.sql and
-- scripts/hold-ovd418-production-locks.sql), which take it with
-- pg_advisory_lock, run read-only precondition checks, take no row lock and
-- sleep until the release ends; every other holder takes it shared. During
-- such a release a fresh request can therefore hold its row locks while it
-- waits on this lock, bounded by its statement_timeout.
-- (3) The organization row is locked in a conflicting mode only by
-- internal-admin paths, and the auth.users row only by the auth service (user
-- deletion or a key change); neither is client-reachable, so these waits are
-- a documented admin-only residual and close no cycle with a client edit. As
-- on the legacy path, the organization and user rows are deliberately not
-- locked here. The generic permit table has no foreign keys.
--
-- So a writer that takes these rows in another order (worker trusted-hash
-- staging, property-override reset, requirement approval, quote-request
-- cancel, project or archived-job deletion) can make the request busy but
-- cannot close a lock cycle with it.
--
-- The request body is byte-identical to 20261003160000 except for the one
-- added helper call. The resolver body is byte-identical except that its
-- scope-row FOR SHARE block (and its comment) and the FOR SHARE on the
-- admission policy and reviewed envelope rows are removed. Security
-- settings, search_path and the revoke/grant statements are restated
-- unchanged.
--
-- Rollback: re-apply the 20261003160000 definitions of
-- private.resolve_provider_dispatch_scope and
-- public.api_request_provider_dispatch with their revoke and grant, then drop
-- private.lock_provider_dispatch_scope_rows(uuid, public.vendor_name).

create or replace function private.lock_provider_dispatch_scope_rows(
  p_job_id uuid,
  p_provider public.vendor_name
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform 1 from public.jobs job_row where job_row.id = p_job_id for no key update nowait;
  perform 1 from public.parts part where part.job_id = p_job_id order by part.id for share nowait;
  perform 1
  from public.approved_part_requirements requirement
  where requirement.part_id in (select part.id from public.parts part where part.job_id = p_job_id)
  order by requirement.part_id
  for share nowait;
  perform 1
  from public.job_files file_row
  where file_row.id in (
    select part.cad_file_id from public.parts part where part.job_id = p_job_id
    union
    select part.drawing_file_id from public.parts part where part.job_id = p_job_id
  )
  order by file_row.id
  for share nowait;
  perform 1
  from public.service_request_line_items line_item
  where line_item.job_id = p_job_id
    and line_item.service_type = 'manufacturing_quote'
    and line_item.scope = 'part'
  for no key update nowait;
  perform 1
  from public.projects project_row
  where project_row.id = (select job_row.project_id from public.jobs job_row where job_row.id = p_job_id)
  for key share nowait;
  perform 1
  from private.quote_provider_admission_policies policy
  where policy.provider = p_provider
  for share nowait;
  perform 1
  from private.provider_dispatch_envelope_reviews review
  where review.provider = p_provider
    and review.withdrawn_at is null
  for share nowait;
exception
  when lock_not_available then
    raise exception using errcode = 'P0001', message = 'provider_dispatch_job_busy';
end;
$$;

revoke all on function private.lock_provider_dispatch_scope_rows(uuid, public.vendor_name)
  from public, anon, authenticated, service_role;

create or replace function private.resolve_provider_dispatch_scope(
  p_job_id uuid,
  p_provider public.vendor_name,
  p_declared_model_units text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_requirement public.approved_part_requirements%rowtype;
  v_cad public.job_files%rowtype;
  v_drawing public.job_files%rowtype;
  v_admission record;
  v_review private.provider_dispatch_envelope_reviews%rowtype;
  v_beta_state jsonb;
  v_notice jsonb;
  v_access jsonb;
  v_rollout private.commercial_rollout_controls%rowtype;
  v_candidate record;
  v_special jsonb;
  v_process text;
  v_extension text;
begin
  perform public.require_verified_auth();

  if p_provider is null then
    raise exception 'provider_dispatch_provider_unknown';
  end if;
  if p_provider = 'xometry'::public.vendor_name then
    raise exception 'provider_dispatch_specialized_path_required';
  end if;

  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;
  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;
  if p_declared_model_units is null
    or p_declared_model_units not in ('inch', 'millimeter') then
    raise exception 'Declared model units must be inch or millimeter.';
  end if;

  select job_row.* into strict v_job from public.jobs job_row where job_row.id = p_job_id;

  select admission.* into v_admission
  from private.resolve_quote_provider_admission_policy(p_provider::text) admission;
  if v_admission.policy_present is not true then
    raise exception 'provider_dispatch_admission_evidence_missing';
  end if;
  if v_admission.reason_code = 'policy_expired' then
    raise exception 'provider_dispatch_admission_expired';
  end if;
  if v_admission.generically_dispatchable is not true then
    raise exception 'provider_dispatch_admission_disabled';
  end if;

  select review.* into v_review
  from private.provider_dispatch_envelope_reviews review
  where review.provider = p_provider
    and review.withdrawn_at is null;
  if v_review.id is null then
    raise exception 'provider_dispatch_provider_envelope_unknown';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('founding-beta:' || v_job.organization_id::text, 0)
  );
  v_notice := private.current_founding_beta_notice();
  v_beta_state := private.resolve_founding_beta_access_state(v_job.organization_id, auth.uid());
  if v_beta_state ->> 'state' is distinct from 'eligible' then
    raise exception 'provider_dispatch_beta_access_required';
  end if;

  -- The free-beta meter is bound to the Xometry permit table, so the generic
  -- path admits only commercial entitlement. This also takes the shared
  -- automatic-quote rollout lock.
  v_access := private.resolve_quote_access(p_job_id, auth.uid());
  if v_access ->> 'state' is distinct from 'eligible' then
    raise exception '%', 'provider_dispatch_' || coalesce(v_access ->> 'reasonCode', 'quote_access_unavailable');
  end if;
  if v_access ->> 'source' is distinct from 'commercial_entitlement' then
    raise exception 'provider_dispatch_commercial_entitlement_required';
  end if;

  select control.* into v_rollout
  from private.commercial_rollout_controls control
  where control.capability = 'automatic_quote_collection';
  if v_rollout.enabled is not true then
    raise exception 'provider_dispatch_rollout_disabled';
  end if;

  if not exists (
    select 1 from public.org_vendor_configs config
    where config.organization_id = v_job.organization_id
  ) then
    raise exception 'provider_dispatch_explicit_vendor_config_required';
  end if;
  if coalesce(
    p_provider = any(public.get_enabled_client_quote_vendors(
      v_job.organization_id, v_job.project_id, v_job.id
    )),
    false
  ) is not true then
    raise exception 'provider_dispatch_provider_not_enabled';
  end if;

  if private.current_confirmed_sourcing_address(v_job.organization_id) is null then
    raise exception 'provider_dispatch_confirmed_destination_required';
  end if;

  if (select count(*) from public.parts part where part.job_id = p_job_id) <> 1 then
    raise exception 'provider_dispatch_exactly_one_part_required';
  end if;
  select part.* into v_part from public.parts part where part.job_id = p_job_id;
  if v_part.organization_id <> v_job.organization_id then
    raise exception 'provider_dispatch_part_organization_mismatch';
  end if;

  select requirement.* into v_requirement
  from public.approved_part_requirements requirement
  where requirement.part_id = v_part.id;
  if v_requirement.id is null then
    raise exception 'provider_dispatch_approved_requirements_required';
  end if;
  if v_requirement.organization_id <> v_job.organization_id then
    raise exception 'provider_dispatch_requirement_organization_mismatch';
  end if;
  if coalesce(p_provider = any(v_requirement.applicable_vendors), false) is not true then
    raise exception 'provider_dispatch_provider_applicability_required';
  end if;

  if public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  ) is distinct from array['manufacturing_quote']::text[] then
    raise exception 'provider_dispatch_manufacturing_quote_only';
  end if;

  v_process := pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.btrim(coalesce(v_requirement.spec_snapshot ->> 'process', ''))),
    '[^a-z0-9]', '', 'g'
  );
  if v_process = '' or not exists (
    select 1
    from pg_catalog.unnest(v_admission.supported_processes) supported(process)
    where pg_catalog.regexp_replace(supported.process::text, '[^a-z0-9]', '', 'g') = v_process
  ) then
    raise exception 'provider_dispatch_process_not_admitted';
  end if;

  -- Automated quoting cannot carry free-text or special handling; fail closed.
  v_special := coalesce(v_requirement.spec_snapshot, '{}'::jsonb);
  if v_requirement.requested_by_date is not null
    or nullif(pg_catalog.btrim(coalesce(v_special ->> 'threads', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special ->> 'notes', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special ->> 'serviceNotes', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{shipping,packagingNotes}', '')), '') is not null
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{shipping,shippingNotes}', '')), '') is not null
    or pg_catalog.jsonb_array_length(coalesce(v_special #> '{certifications,requiredCertifications}', '[]'::jsonb)) > 0
    or coalesce((v_special #>> '{certifications,materialCertificationRequired}')::boolean, false)
    or coalesce((v_special #>> '{certifications,certificateOfConformanceRequired}')::boolean, false)
    or coalesce(v_special #>> '{certifications,inspectionLevel}', 'standard') not in ('', 'standard')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{certifications,notes}', '')), '') is not null
    or pg_catalog.jsonb_array_length(coalesce(v_special #> '{sourcing,preferredSuppliers}', '[]'::jsonb)) > 0
    or coalesce(v_special #>> '{sourcing,regionPreferenceOverride}', 'best_value') not in ('', 'best_value')
    or coalesce(v_special #>> '{sourcing,materialProvisioning}', 'supplier_to_source') not in ('', 'supplier_to_source')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{sourcing,notes}', '')), '') is not null
    or coalesce(v_special #>> '{release,releaseStatus}', 'approved') in ('hold', 'blocked')
    or nullif(pg_catalog.btrim(coalesce(v_special #>> '{release,notes}', '')), '') is not null then
    raise exception 'provider_dispatch_special_requirements_not_supported';
  end if;

  select file_row.* into v_cad from public.job_files file_row where file_row.id = v_part.cad_file_id;
  v_extension := pg_catalog.substring(pg_catalog.lower(coalesce(v_cad.original_name, '')), '\.([a-z0-9]+)$');
  if v_cad.id is null
    or v_cad.job_id <> v_job.id
    or v_cad.organization_id <> v_job.organization_id
    or v_cad.file_kind <> 'cad'
    or v_cad.trusted_content_sha256 is null
    or v_cad.trusted_content_sha256 !~ '^[a-f0-9]{64}$'
    or v_extension is null
    or not (v_extension = any(v_admission.accepted_file_extensions)) then
    raise exception 'provider_dispatch_trusted_cad_required';
  end if;

  if v_part.drawing_file_id is not null then
    select file_row.* into v_drawing from public.job_files file_row where file_row.id = v_part.drawing_file_id;
    v_extension := pg_catalog.substring(pg_catalog.lower(coalesce(v_drawing.original_name, '')), '\.([a-z0-9]+)$');
    if v_drawing.id is null
      or v_drawing.job_id <> v_job.id
      or v_drawing.organization_id <> v_job.organization_id
      or v_drawing.file_kind <> 'drawing'
      or v_drawing.trusted_content_sha256 is null
      or v_drawing.trusted_content_sha256 !~ '^[a-f0-9]{64}$'
      or v_extension is null
      or not (v_extension = any(v_admission.accepted_file_extensions)) then
      raise exception 'provider_dispatch_drawing_not_admitted';
    end if;
  end if;

  if (select count(*) from private.quote_lane_candidates(
    p_job_id, array[p_provider]::public.vendor_name[]
  )) <> 1 then
    raise exception 'provider_dispatch_exact_scope_required';
  end if;
  select candidate.* into v_candidate
  from private.quote_lane_candidates(p_job_id, array[p_provider]::public.vendor_name[]) candidate;
  if v_candidate.part_id <> v_part.id
    or v_candidate.scope_snapshot #>> '{part,cad,fileId}' is distinct from v_cad.id::text
    or v_candidate.scope_snapshot #>> '{part,cad,sha256}' is distinct from v_cad.trusted_content_sha256
    or v_candidate.scope_snapshot #>> '{part,drawing,fileId}' is distinct from v_drawing.id::text
    or v_candidate.scope_snapshot #>> '{part,drawing,sha256}' is distinct from v_drawing.trusted_content_sha256 then
    raise exception 'provider_dispatch_exact_scope_required';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', v_job.organization_id,
    'jobId', v_job.id,
    'partId', v_candidate.part_id,
    'provider', v_candidate.vendor,
    'requestedQuantity', v_candidate.requested_quantity,
    'scopeVersion', v_candidate.scope_version,
    'scopeFingerprint', v_candidate.scope_fingerprint,
    'scope', v_candidate.scope_snapshot,
    'declaredModelUnits', p_declared_model_units,
    'noticeRevision', v_notice ->> 'policyRevision',
    'envelopeId', v_review.envelope_id,
    'envelopeVersion', v_review.envelope_version,
    'envelopeRevision', v_review.envelope_id || '.v' || v_review.envelope_version::text,
    'permitTtlSeconds', v_review.permit_ttl_seconds,
    'admissionPolicyRevision', v_admission.policy_revision,
    'admissionEvidenceReference', v_admission.evidence_reference,
    'rolloutRevision', v_rollout.revision,
    'cadFileId', v_cad.id,
    'cadSha256', v_cad.trusted_content_sha256,
    'drawingFileId', v_drawing.id,
    'drawingSha256', v_drawing.trusted_content_sha256
  );
end;
$$;

revoke all on function private.resolve_provider_dispatch_scope(uuid, public.vendor_name, text)
  from public, anon, authenticated, service_role;

create or replace function public.api_request_provider_dispatch(
  p_job_id uuid,
  p_provider public.vendor_name,
  p_declared_model_units text,
  p_expected_scope_fingerprint text,
  p_notice_revision text,
  p_expected_envelope_revision text,
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
  v_job public.jobs%rowtype;
  v_scope jsonb;
  v_existing private.provider_dispatch_permits%rowtype;
  v_result jsonb;
  v_lane public.quote_request_lanes%rowtype;
  v_task public.work_queue%rowtype;
  v_permit_id uuid := gen_random_uuid();
  v_issued_at timestamptz;
  v_expires_at timestamptz;
  v_envelope jsonb;
  v_canonical text;
  v_fingerprint text;
begin
  -- Specialized compatibility path: the legacy Xometry transaction, unchanged.
  if p_provider = 'xometry'::public.vendor_name then
    if p_expected_envelope_revision is distinct from 'xometry-controlled-beta-envelope.v1' then
      raise exception 'provider_dispatch_envelope_mismatch';
    end if;
    return public.api_request_xometry_beta_dispatch(
      p_job_id,
      p_declared_model_units,
      p_expected_scope_fingerprint,
      p_notice_revision,
      p_approval_reference,
      p_authority_to_share,
      p_non_export_controlled,
      p_quote_only
    );
  end if;

  perform public.require_verified_auth();
  if p_provider is null then
    raise exception 'provider_dispatch_provider_unknown';
  end if;
  if p_authority_to_share is not true
    or p_non_export_controlled is not true
    or p_quote_only is not true then
    raise exception 'provider_dispatch_affirmations_required';
  end if;
  if p_approval_reference is null then
    raise exception 'provider_dispatch_approval_reference_required';
  end if;

  select job_row.* into v_job from public.jobs job_row where job_row.id = p_job_id;
  if v_job.id is null then
    raise exception 'Job % not found.', p_job_id;
  end if;
  if not public.user_can_edit_job(v_job.id) then
    raise exception 'You do not have permission to request quotes for job %.', p_job_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('quote-lane-submit:' || p_job_id::text, 0)
  );
  -- Shares the legacy approval-reference key so the same organization-scoped
  -- reference serializes across the specialized and generic paths.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'xometry-beta-approval:' || v_job.organization_id::text || ':' || p_approval_reference::text,
      0
    )
  );

  if exists (
    select 1 from private.xometry_beta_dispatch_permits legacy
    where legacy.organization_id = v_job.organization_id
      and legacy.approval_reference = p_approval_reference
  ) then
    raise exception 'provider_dispatch_approval_reference_reused';
  end if;

  select permit.* into v_existing
  from private.provider_dispatch_permits permit
  where permit.organization_id = v_job.organization_id
    and permit.approval_reference = p_approval_reference;
  if v_existing.id is not null then
    if v_existing.actor_user_id <> auth.uid()
      or v_existing.job_id <> p_job_id
      or v_existing.provider <> p_provider
      or v_existing.scope_fingerprint is distinct from p_expected_scope_fingerprint
      or v_existing.declared_model_units is distinct from p_declared_model_units
      or v_existing.notice_revision is distinct from p_notice_revision
      or v_existing.envelope_id || '.v' || v_existing.envelope_version::text
        is distinct from p_expected_envelope_revision then
      raise exception 'provider_dispatch_approval_reference_reused';
    end if;
    if exists (
      select 1 from private.provider_dispatch_permit_revocations revocation
      where revocation.permit_id = v_existing.id
    ) then
      raise exception 'provider_dispatch_permit_revoked';
    end if;
    if pg_catalog.now() >= v_existing.expires_at then
      raise exception 'provider_dispatch_permit_expired';
    end if;
    -- A replay is acknowledged only while every gate of the fresh path still
    -- holds for the same scope, notice, and reviewed envelope.
    v_scope := private.resolve_provider_dispatch_scope(p_job_id, p_provider, p_declared_model_units);
    if v_scope ->> 'scopeFingerprint' is distinct from v_existing.scope_fingerprint then
      raise exception 'provider_dispatch_scope_mismatch';
    end if;
    if v_scope ->> 'noticeRevision' is distinct from v_existing.notice_revision then
      raise exception 'provider_dispatch_notice_mismatch';
    end if;
    if v_scope ->> 'envelopeRevision' is distinct from p_expected_envelope_revision then
      raise exception 'provider_dispatch_envelope_mismatch';
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', true,
      'created', false,
      'deduplicated', true,
      'permitId', v_existing.id,
      'provider', v_existing.provider,
      'quoteRequestId', v_existing.quote_request_id,
      'quoteRunId', v_existing.quote_run_id,
      'scopeFingerprint', v_existing.scope_fingerprint,
      'envelopeRevision', p_expected_envelope_revision,
      'status', 'queued'
    );
  end if;

  perform private.lock_provider_dispatch_scope_rows(p_job_id, p_provider);
  v_scope := private.resolve_provider_dispatch_scope(p_job_id, p_provider, p_declared_model_units);
  if p_expected_scope_fingerprint is null
    or p_expected_scope_fingerprint <> v_scope ->> 'scopeFingerprint' then
    raise exception 'provider_dispatch_scope_mismatch';
  end if;
  if p_notice_revision is null
    or p_notice_revision <> v_scope ->> 'noticeRevision' then
    raise exception 'provider_dispatch_notice_mismatch';
  end if;
  if p_expected_envelope_revision is null
    or p_expected_envelope_revision <> v_scope ->> 'envelopeRevision' then
    raise exception 'provider_dispatch_envelope_mismatch';
  end if;

  v_result := private.request_scoped_automatic_quote_impl(
    p_job_id,
    array[p_provider]::public.vendor_name[]
  );
  if coalesce((v_result ->> 'accepted')::boolean, false) is not true
    or coalesce((v_result ->> 'created')::boolean, false) is not true then
    raise exception 'provider_dispatch_new_lane_required';
  end if;

  select lane.* into strict v_lane
  from public.quote_request_lanes lane
  where lane.quote_request_id = (v_result ->> 'quoteRequestId')::uuid;
  if v_lane.vendor <> p_provider
    or v_lane.organization_id <> v_job.organization_id
    or v_lane.part_id <> (v_scope ->> 'partId')::uuid
    or v_lane.requested_quantity <> (v_scope ->> 'requestedQuantity')::integer
    or v_lane.scope_version <> (v_scope ->> 'scopeVersion')::integer
    or v_lane.scope_fingerprint <> p_expected_scope_fingerprint
    or v_lane.scope_snapshot #>> '{part,cad,fileId}' is distinct from v_scope ->> 'cadFileId'
    or v_lane.scope_snapshot #>> '{part,cad,sha256}' is distinct from v_scope ->> 'cadSha256'
    or v_lane.scope_snapshot #>> '{part,drawing,fileId}' is distinct from v_scope ->> 'drawingFileId'
    or v_lane.scope_snapshot #>> '{part,drawing,sha256}' is distinct from v_scope ->> 'drawingSha256'
    or v_lane.scope_snapshot is distinct from v_scope -> 'scope' then
    raise exception 'provider_dispatch_created_lane_mismatch';
  end if;

  select task.* into strict v_task
  from public.work_queue task
  where task.quote_run_id = v_lane.quote_run_id
    and task.part_id = v_lane.part_id
    and task.task_type = 'run_vendor_quote'
    and task.payload ->> 'vendor' = p_provider::text
    and task.payload ->> 'vendorQuoteResultId' = v_lane.vendor_quote_result_id::text;

  v_issued_at := pg_catalog.date_trunc('milliseconds', pg_catalog.now());
  v_expires_at := v_issued_at
    + pg_catalog.make_interval(secs => (v_scope ->> 'permitTtlSeconds')::integer);
  v_envelope := private.build_provider_dispatch_envelope(
    p_provider,
    v_scope ->> 'envelopeId',
    (v_scope ->> 'envelopeVersion')::integer,
    v_scope ->> 'admissionPolicyRevision',
    v_scope ->> 'admissionEvidenceReference',
    p_notice_revision,
    auth.uid(),
    v_job.organization_id,
    p_job_id,
    v_lane.part_id,
    v_lane.scope_version,
    v_lane.scope_fingerprint,
    v_lane.requested_quantity,
    p_declared_model_units,
    (v_scope ->> 'cadFileId')::uuid,
    v_scope ->> 'cadSha256',
    (v_scope ->> 'drawingFileId')::uuid,
    v_scope ->> 'drawingSha256',
    v_lane.quote_request_id,
    v_lane.quote_run_id,
    v_lane.vendor_quote_result_id,
    v_lane.id,
    v_task.id,
    v_permit_id,
    p_approval_reference,
    'lease:' || v_permit_id::text,
    (v_scope ->> 'rolloutRevision')::bigint,
    v_issued_at,
    v_expires_at
  );
  v_canonical := v_envelope::text;
  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_canonical, 'UTF8')),
    'hex'
  );

  insert into private.provider_dispatch_permits (
    id, provider, envelope_id, envelope_version, admission_policy_revision,
    admission_evidence_reference, notice_revision, actor_user_id,
    organization_id, job_id, part_id, scope_version, scope_fingerprint,
    requested_quantity, declared_model_units, cad_file_id, cad_sha256,
    drawing_file_id, drawing_sha256, quote_request_id, quote_run_id,
    vendor_quote_result_id, quote_request_lane_id, work_queue_task_id,
    approval_reference, session_binding_id, rollout_revision, issued_at,
    expires_at, authority_to_share, non_export_controlled, quote_only,
    envelope, canonical_envelope, envelope_fingerprint
  ) values (
    v_permit_id, p_provider, v_scope ->> 'envelopeId',
    (v_scope ->> 'envelopeVersion')::integer, v_scope ->> 'admissionPolicyRevision',
    v_scope ->> 'admissionEvidenceReference', p_notice_revision, auth.uid(),
    v_job.organization_id, p_job_id, v_lane.part_id, v_lane.scope_version,
    v_lane.scope_fingerprint, v_lane.requested_quantity, p_declared_model_units,
    (v_scope ->> 'cadFileId')::uuid, v_scope ->> 'cadSha256',
    (v_scope ->> 'drawingFileId')::uuid, v_scope ->> 'drawingSha256',
    v_lane.quote_request_id, v_lane.quote_run_id, v_lane.vendor_quote_result_id,
    v_lane.id, v_task.id, p_approval_reference, 'lease:' || v_permit_id::text,
    (v_scope ->> 'rolloutRevision')::bigint, v_issued_at, v_expires_at,
    p_authority_to_share, p_non_export_controlled, p_quote_only,
    v_envelope, v_canonical, v_fingerprint
  );

  update public.work_queue
  set payload = payload || pg_catalog.jsonb_build_object(
    'providerDispatchPermitId', v_permit_id,
    'providerDispatchEnvelopeRevision', v_scope ->> 'envelopeRevision',
    'providerDispatchEnvelopeFingerprint', v_fingerprint,
    'quoteLaneScopeFingerprint', v_lane.scope_fingerprint
  )
  where id = v_task.id;

  return v_result || pg_catalog.jsonb_build_object(
    'permitId', v_permit_id,
    'provider', p_provider,
    'scopeFingerprint', v_lane.scope_fingerprint,
    'declaredModelUnits', p_declared_model_units,
    'envelopeRevision', v_scope ->> 'envelopeRevision',
    'expiresAt', v_envelope ->> 'expiresAt'
  );
end;
$$;

revoke all on function public.api_request_provider_dispatch(
  uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.api_request_provider_dispatch(
  uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean
) to authenticated;
