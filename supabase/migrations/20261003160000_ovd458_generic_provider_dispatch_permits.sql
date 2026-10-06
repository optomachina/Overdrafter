-- OVD-458
-- Persist one provider-neutral dispatch permit (provider-dispatch-envelope.v1,
-- OVD-457) atomically with its exact request/run/result/lane/task, for
-- non-Xometry providers only. The generic path is off by default: a provider
-- needs the OVD-379 registry to mark it generically dispatchable AND an active
-- reviewed envelope row here. No provider is seeded as either.
--
-- Xometry is unchanged. api_request_provider_dispatch('xometry', ...) only
-- delegates to the existing api_request_xometry_beta_dispatch, and the generic
-- permit table rejects Xometry rows. The live worker still refuses every
-- non-Xometry provider before adapter launch until OVD-459/461 land.
--
-- Session binding: each generic permit reserves `lease:<permit id>` as its
-- session-binding identifier. OVD-462's session lease must adopt exactly that
-- identifier for the permit's task; nothing here asserts a live session.
--
-- Rollback (operational, preserves Xometry): record a new admission policy
-- revision with generic_dispatch_enabled = false for the provider, or set
-- withdrawn_at on its reviewed envelope; both deny every new generic request
-- and preview immediately. Permits and tasks already issued stay active:
-- neither switch revokes them, so revoke each issued permit explicitly with
-- private.revoke_provider_dispatch_permit (OVD-459's preflight then refuses
-- it). Structural rollback: drop the cross-path approval trigger, then
-- revoke/drop the two public RPCs and the private helpers. Retain the append-only permit and revocation
-- evidence; drop them only in a later, separately reviewed retention migration.

create table private.provider_dispatch_envelope_reviews (
  id uuid primary key default gen_random_uuid(),
  provider public.vendor_name not null,
  envelope_id text not null,
  envelope_version integer not null,
  evidence_reference text not null,
  permit_ttl_seconds integer not null,
  reviewed_at timestamptz not null default pg_catalog.now(),
  withdrawn_at timestamptz,
  constraint provider_dispatch_envelope_reviews_provider_check
    check (provider <> 'xometry'::public.vendor_name),
  constraint provider_dispatch_envelope_reviews_id_check check (
    envelope_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    and pg_catalog.left(envelope_id, pg_catalog.length(provider::text) + 1) = provider::text || '-'
  ),
  constraint provider_dispatch_envelope_reviews_version_check
    check (envelope_version between 1 and 999999999),
  constraint provider_dispatch_envelope_reviews_evidence_check
    check (evidence_reference ~ '^OVD-[1-9][0-9]{0,9}$'),
  constraint provider_dispatch_envelope_reviews_ttl_check
    check (permit_ttl_seconds between 60 and 86400),
  constraint provider_dispatch_envelope_reviews_withdrawn_check
    check (withdrawn_at is null or withdrawn_at >= reviewed_at),
  unique (provider, envelope_id, envelope_version)
);

create unique index provider_dispatch_envelope_reviews_active_idx
  on private.provider_dispatch_envelope_reviews (provider)
  where withdrawn_at is null;

create or replace function private.guard_provider_dispatch_envelope_review_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Reviewed provider dispatch envelopes cannot be deleted.';
  end if;
  -- The only permitted change is a one-way withdrawal.
  if old.withdrawn_at is not null
    or new.withdrawn_at is null
    or (new.id, new.provider, new.envelope_id, new.envelope_version,
        new.evidence_reference, new.permit_ttl_seconds, new.reviewed_at)
      is distinct from
       (old.id, old.provider, old.envelope_id, old.envelope_version,
        old.evidence_reference, old.permit_ttl_seconds, old.reviewed_at) then
    raise exception 'Reviewed provider dispatch envelopes can only be withdrawn.';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_provider_dispatch_envelope_review_mutation()
  from public, anon, authenticated, service_role;

create trigger guard_provider_dispatch_envelope_review_mutation
before update or delete on private.provider_dispatch_envelope_reviews
for each row execute function private.guard_provider_dispatch_envelope_review_mutation();

alter table private.provider_dispatch_envelope_reviews enable row level security;
alter table private.provider_dispatch_envelope_reviews force row level security;
revoke all on private.provider_dispatch_envelope_reviews
  from public, anon, authenticated, service_role;

-- Builds the canonical provider-dispatch-envelope.v1 object. jsonb preserves
-- array order, so sourceFiles/outboundFiles are emitted cad before drawing to
-- match the TypeScript canonical form; v1 outbound files are identity copies.
create or replace function private.build_provider_dispatch_envelope(
  p_provider public.vendor_name,
  p_envelope_id text,
  p_envelope_version integer,
  p_admission_policy_revision text,
  p_admission_evidence_reference text,
  p_notice_revision text,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_job_id uuid,
  p_part_id uuid,
  p_scope_version integer,
  p_scope_fingerprint text,
  p_requested_quantity integer,
  p_declared_model_units text,
  p_cad_file_id uuid,
  p_cad_sha256 text,
  p_drawing_file_id uuid,
  p_drawing_sha256 text,
  p_quote_request_id uuid,
  p_quote_run_id uuid,
  p_vendor_quote_result_id uuid,
  p_quote_request_lane_id uuid,
  p_work_queue_task_id uuid,
  p_permit_id uuid,
  p_approval_reference uuid,
  p_session_binding_id text,
  p_rollout_revision bigint,
  p_issued_at timestamptz,
  p_expires_at timestamptz
)
returns jsonb
language sql
stable
set search_path = pg_catalog
as $$
  -- STABLE because to_char is; the output is still deterministic for given
  -- inputs since timestamps are rendered `at time zone 'UTC'`, independent of
  -- the session TimeZone. CHECK constraints do not require IMMUTABLE.
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-envelope.v1',
    'provider', p_provider::text,
    'envelope', pg_catalog.jsonb_build_object('id', p_envelope_id, 'version', p_envelope_version),
    'admission', pg_catalog.jsonb_build_object(
      'policyRevision', p_admission_policy_revision,
      'evidenceReference', p_admission_evidence_reference
    ),
    'noticeRevision', p_notice_revision,
    'purpose', 'quote_only',
    'affirmations', pg_catalog.jsonb_build_object(
      'authorityToShare', true,
      'nonExportControlled', true,
      'quoteOnly', true
    ),
    'subject', pg_catalog.jsonb_build_object(
      'actorUserId', p_actor_user_id,
      'organizationId', p_organization_id,
      'jobId', p_job_id,
      'partId', p_part_id
    ),
    'scope', pg_catalog.jsonb_build_object(
      'schema', 'quote-lane-scope.v1',
      'version', p_scope_version,
      'fingerprint', p_scope_fingerprint,
      'requestedQuantity', p_requested_quantity,
      'declaredModelUnits', p_declared_model_units
    ),
    'sourceFiles', files.source_files,
    'outboundFiles', files.outbound_files,
    'task', pg_catalog.jsonb_build_object(
      'quoteRequestId', p_quote_request_id,
      'quoteRunId', p_quote_run_id,
      'vendorQuoteResultId', p_vendor_quote_result_id,
      'quoteRequestLaneId', p_quote_request_lane_id,
      'workQueueTaskId', p_work_queue_task_id
    ),
    'permit', pg_catalog.jsonb_build_object(
      'permitId', p_permit_id,
      'approvalReference', p_approval_reference
    ),
    'sessionBindingId', p_session_binding_id,
    'rollout', pg_catalog.jsonb_build_object(
      'capability', 'automatic_quote_collection',
      'revision', p_rollout_revision
    ),
    'issuedAt', pg_catalog.to_char(p_issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', pg_catalog.to_char(p_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  from (
    select
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('role', file.role, 'fileId', file.file_id, 'sha256', file.sha256)
        order by file.ordinal
      ) as source_files,
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'role', file.role,
          'sourceSha256', file.sha256,
          'sha256', file.sha256,
          'derivation', 'identity'
        )
        order by file.ordinal
      ) as outbound_files
    from (
      values
        (1, 'cad', p_cad_file_id, p_cad_sha256),
        (2, 'drawing', p_drawing_file_id, p_drawing_sha256)
    ) as file(ordinal, role, file_id, sha256)
    where file.file_id is not null
  ) as files;
$$;

revoke all on function private.build_provider_dispatch_envelope(
  public.vendor_name, text, integer, text, text, text, uuid, uuid, uuid, uuid,
  integer, text, integer, text, uuid, text, uuid, text, uuid, uuid, uuid, uuid,
  uuid, uuid, uuid, text, bigint, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

create table private.provider_dispatch_permits (
  id uuid primary key,
  provider public.vendor_name not null,
  envelope_id text not null,
  envelope_version integer not null,
  admission_policy_revision text not null,
  admission_evidence_reference text not null,
  notice_revision text not null,
  actor_user_id uuid not null,
  organization_id uuid not null,
  job_id uuid not null,
  part_id uuid not null,
  scope_version integer not null,
  scope_fingerprint text not null,
  requested_quantity integer not null,
  declared_model_units text not null,
  cad_file_id uuid not null,
  cad_sha256 text not null,
  drawing_file_id uuid,
  drawing_sha256 text,
  quote_request_id uuid not null,
  quote_run_id uuid not null,
  vendor_quote_result_id uuid not null,
  quote_request_lane_id uuid not null,
  work_queue_task_id uuid not null,
  approval_reference uuid not null,
  session_binding_id text not null,
  rollout_revision bigint not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  authority_to_share boolean not null,
  non_export_controlled boolean not null,
  quote_only boolean not null,
  envelope jsonb not null,
  canonical_envelope text not null,
  envelope_fingerprint text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint provider_dispatch_permits_provider_check
    check (provider <> 'xometry'::public.vendor_name),
  constraint provider_dispatch_permits_envelope_identity_check check (
    envelope_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    and pg_catalog.left(envelope_id, pg_catalog.length(provider::text) + 1) = provider::text || '-'
    and envelope_version between 1 and 999999999
  ),
  constraint provider_dispatch_permits_revisions_check check (
    admission_policy_revision ~ '^[a-z0-9][a-z0-9._-]{2,199}$'
    and notice_revision ~ '^[a-z0-9][a-z0-9._-]{2,199}$'
    and admission_evidence_reference ~ '^OVD-[1-9][0-9]{0,9}$'
  ),
  constraint provider_dispatch_permits_scope_check check (
    scope_version >= 1
    and requested_quantity >= 1
    and scope_fingerprint ~ '^[a-f0-9]{64}$'
    and declared_model_units in ('inch', 'millimeter')
  ),
  constraint provider_dispatch_permits_files_check check (
    cad_sha256 ~ '^[a-f0-9]{64}$'
    and (drawing_file_id is null) = (drawing_sha256 is null)
    and (drawing_sha256 is null or drawing_sha256 ~ '^[a-f0-9]{64}$')
    and drawing_file_id is distinct from cad_file_id
  ),
  constraint provider_dispatch_permits_session_binding_check
    check (session_binding_id = 'lease:' || id::text),
  constraint provider_dispatch_permits_lifetime_check check (
    rollout_revision >= 0
    and expires_at > issued_at
  ),
  constraint provider_dispatch_permits_affirmations_check
    check (authority_to_share and non_export_controlled and quote_only),
  constraint provider_dispatch_permits_envelope_check check (
    canonical_envelope = private.build_provider_dispatch_envelope(
      provider, envelope_id, envelope_version, admission_policy_revision,
      admission_evidence_reference, notice_revision, actor_user_id,
      organization_id, job_id, part_id, scope_version, scope_fingerprint,
      requested_quantity, declared_model_units, cad_file_id, cad_sha256,
      drawing_file_id, drawing_sha256, quote_request_id, quote_run_id,
      vendor_quote_result_id, quote_request_lane_id, work_queue_task_id, id,
      approval_reference, session_binding_id, rollout_revision, issued_at,
      expires_at
    )::text
  ),
  constraint provider_dispatch_permits_canonical_check
    check (canonical_envelope = envelope::text),
  constraint provider_dispatch_permits_fingerprint_check check (
    envelope_fingerprint = pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(canonical_envelope, 'UTF8')),
      'hex'
    )
  ),
  unique (organization_id, approval_reference),
  unique (quote_request_lane_id),
  unique (work_queue_task_id),
  unique (session_binding_id),
  unique (envelope_fingerprint)
);

alter table private.provider_dispatch_permits enable row level security;
alter table private.provider_dispatch_permits force row level security;
revoke all on private.provider_dispatch_permits
  from public, anon, authenticated, service_role;

create trigger provider_dispatch_permits_append_only
before update or delete on private.provider_dispatch_permits
for each row execute function private.reject_founding_beta_evidence_mutation();

create table private.provider_dispatch_permit_revocations (
  id bigint generated always as identity primary key,
  permit_id uuid not null unique references private.provider_dispatch_permits (id),
  reason text not null,
  -- The effective API role. PostgREST (v12+) publishes the JWT only as the
  -- `request.jwt.claims` JSON, and this default is evaluated inside a SECURITY
  -- DEFINER function where current_user is the owner, so the role comes from
  -- the claims; direct SQL without claims falls back to the login role.
  revoked_by_role text not null default coalesce(
    nullif(
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      ''
    ),
    session_user
  ),
  revoked_at timestamptz not null default pg_catalog.now(),
  constraint provider_dispatch_permit_revocations_reason_check check (
    reason in (
      'admission_withdrawn',
      'envelope_withdrawn',
      'customer_withdrawn',
      'operator_revoked',
      'security_incident'
    )
  ),
  constraint provider_dispatch_permit_revocations_role_check
    check (pg_catalog.length(pg_catalog.btrim(revoked_by_role)) between 1 and 200)
);

alter table private.provider_dispatch_permit_revocations enable row level security;
alter table private.provider_dispatch_permit_revocations force row level security;
revoke all on private.provider_dispatch_permit_revocations
  from public, anon, authenticated, service_role;
revoke all on sequence private.provider_dispatch_permit_revocations_id_seq
  from public, anon, authenticated, service_role;

create trigger provider_dispatch_permit_revocations_append_only
before update or delete on private.provider_dispatch_permit_revocations
for each row execute function private.reject_founding_beta_evidence_mutation();

-- Resolves one exact generic disclosure scope for the calling job editor.
-- Every gate fails closed with a stable provider_dispatch_* code. The returned
-- object includes service-only bindings; public callers receive a subset.
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

  -- Hold every row the scope is validated and built from (job, parts,
  -- approved requirements, then CAD/drawing files, in that order) until
  -- commit. Under READ COMMITTED a concurrent edit then either commits before
  -- these locks (and is validated) or waits until the permit transaction
  -- ends; it can never land between validation and lane construction.
  perform 1 from public.jobs job_row where job_row.id = p_job_id for share;
  perform 1 from public.parts part where part.job_id = p_job_id order by part.id for share;
  perform 1
  from public.approved_part_requirements requirement
  where requirement.part_id in (select part.id from public.parts part where part.job_id = p_job_id)
  order by requirement.part_id
  for share;
  perform 1
  from public.job_files file_row
  where file_row.id in (
    select part.cad_file_id from public.parts part where part.job_id = p_job_id
    union
    select part.drawing_file_id from public.parts part where part.job_id = p_job_id
  )
  order by file_row.id
  for share;
  select job_row.* into strict v_job from public.jobs job_row where job_row.id = p_job_id;

  -- Hold the registry row and the active reviewed envelope until commit so the
  -- rollback switch cannot change underneath an in-flight permit.
  perform 1
  from private.quote_provider_admission_policies policy
  where policy.provider = p_provider
  for share;
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
    and review.withdrawn_at is null
  for share;
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

-- Client-safe preview. Xometry returns the unchanged legacy preview; every
-- other provider returns the generic scope without private admission evidence.
create or replace function public.api_get_provider_dispatch_scope(
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
  v_scope jsonb;
begin
  if p_provider = 'xometry'::public.vendor_name then
    return private.resolve_xometry_beta_dispatch_scope(p_job_id, p_declared_model_units);
  end if;

  v_scope := private.resolve_provider_dispatch_scope(p_job_id, p_provider, p_declared_model_units);
  return pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-scope.v1',
    'organizationId', v_scope -> 'organizationId',
    'jobId', v_scope -> 'jobId',
    'partId', v_scope -> 'partId',
    'provider', v_scope -> 'provider',
    'requestedQuantity', v_scope -> 'requestedQuantity',
    'scopeVersion', v_scope -> 'scopeVersion',
    'scopeFingerprint', v_scope -> 'scopeFingerprint',
    'scope', v_scope -> 'scope',
    'declaredModelUnits', v_scope -> 'declaredModelUnits',
    'noticeRevision', v_scope -> 'noticeRevision',
    'envelopeRevision', v_scope -> 'envelopeRevision'
  );
end;
$$;

revoke all on function public.api_get_provider_dispatch_scope(uuid, public.vendor_name, text)
  from public, anon, authenticated, service_role;
grant execute on function public.api_get_provider_dispatch_scope(uuid, public.vendor_name, text)
  to authenticated;

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

-- Service-only revocation. Idempotent: a second call reports the first event.
create or replace function private.revoke_provider_dispatch_permit(
  p_permit_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_permit_id uuid;
  v_revocation private.provider_dispatch_permit_revocations%rowtype;
begin
  select permit.id into v_permit_id
  from private.provider_dispatch_permits permit
  where permit.id = p_permit_id
  for key share;
  if v_permit_id is null then
    raise exception 'provider_dispatch_permit_not_found';
  end if;

  insert into private.provider_dispatch_permit_revocations (permit_id, reason)
  values (v_permit_id, p_reason)
  on conflict (permit_id) do nothing;

  select revocation.* into strict v_revocation
  from private.provider_dispatch_permit_revocations revocation
  where revocation.permit_id = v_permit_id;

  return pg_catalog.jsonb_build_object(
    'permitId', v_permit_id,
    'permitState', 'revoked',
    'reason', v_revocation.reason,
    'revokedAt', v_revocation.revoked_at
  );
end;
$$;

revoke all on function private.revoke_provider_dispatch_permit(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function private.revoke_provider_dispatch_permit(uuid, text)
  to service_role;

-- Service-only permit state for the OVD-459 preflight: revoked, expired
-- (now() >= expires_at), active, or null when no generic permit exists.
create or replace function private.resolve_provider_dispatch_permit_state(p_permit_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select case
    when permit.id is null then null
    when exists (
      select 1 from private.provider_dispatch_permit_revocations revocation
      where revocation.permit_id = permit.id
    ) then 'revoked'
    when pg_catalog.now() >= permit.expires_at then 'expired'
    else 'active'
  end
  from (select p_permit_id as requested_id) requested
  left join private.provider_dispatch_permits permit on permit.id = requested.requested_id;
$$;

revoke all on function private.resolve_provider_dispatch_permit_state(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.resolve_provider_dispatch_permit_state(uuid)
  to service_role;

-- The legacy Xometry request only checks its own table. Reject a Xometry
-- permit whose organization-scoped approval reference already authorized a
-- generic permit. Both paths take the same xometry-beta-approval advisory
-- lock, so this check cannot race the generic insert. The legacy function and
-- its grants are unchanged; with no generic permits this never fires.
create or replace function private.reject_cross_path_approval_reference()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if exists (
    select 1 from private.provider_dispatch_permits generic
    where generic.organization_id = new.organization_id
      and generic.approval_reference = new.approval_reference
  ) then
    raise exception 'xometry_beta_approval_reference_reused';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_cross_path_approval_reference()
  from public, anon, authenticated, service_role;

create trigger xometry_beta_dispatch_permits_cross_path_approval
before insert on private.xometry_beta_dispatch_permits
for each row execute function private.reject_cross_path_approval_reference();
