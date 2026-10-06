-- OVD-459
-- Service-role-only provider dispatch preflight. The worker calls it
-- immediately before provider execution with the same inputs as the Xometry
-- preflight. It returns runnable authority only for the exact current
-- task/lane/result/permit/provider/files/scope/session binding, or one stable
-- terminal denial from the OVD-457 vocabulary. Nothing here creates, extends,
-- or revokes a permit, and nothing enables a provider.
--
-- Xometry compatibility: a call whose staged scope names Xometry returns
-- public.api_authorize_xometry_beta_worker_dispatch(...) verbatim, so the
-- legacy response contract, reason codes, and fingerprints are unchanged. The
-- live worker keeps calling the legacy RPC directly; that function is not
-- redefined here.
--
-- Generic permits (OVD-458) are rechecked in one locked snapshot. Lock order,
-- always acquired before the facts they guard are read:
--   1. work_queue task      FOR UPDATE (the worker's claim)
--   2. permit               FOR UPDATE (revocation needs KEY SHARE on it, so a
--                           revocation either commits first and is seen, or
--                           waits for this preflight)
--   3. vendor_quote_results FOR SHARE  (result updates that cascade to the
--                           request lock the result first, same order)
--   4. quote_requests       FOR SHARE  (api_cancel_quote_request locks the
--                           request FOR UPDATE first, then run and job, so
--                           cancellation serializes with this preflight)
--   5. jobs                 FOR SHARE  (archive and request/cancel status
--                           updates), then the job's parts, approved
--                           requirements, and CAD/drawing files FOR SHARE in
--                           id order: the exact scope-source order OVD-458
--                           issuance holds, so edits to them serialize too
--   6. admission registry and reviewed envelope rows FOR SHARE, then the
--      Founding Beta and automatic-quote rollout advisory locks, shared. These
--      are the same shared modes the OVD-458 request path takes, and that path
--      writes only rows it creates plus the job row (after these locks), so
--      the two paths cannot wait on each other in a cycle.
-- Lifecycle facts are read by the locking statements themselves. The database
-- clock is sampled again after every lock is held, and all time-dependent
-- checks (permit lifetime, admission policy expiry, entitlement window) are
-- repeated against that final timestamp, which is the one returned.
-- Not serialized here (bounded follow-ups with OVD-567/568): org vendor
-- configuration and the lane row are read without row locks; a concurrent
-- edit to them commits either before the read (and is denied) or after this
-- preflight returns, so the worker may launch on a decision that a
-- configuration change made a moment later would have denied.
--
-- Response (provider-dispatch-authorization.v1), bounded to what the worker
-- needs: permit id, provider, stored canonical envelope text and fingerprint,
-- expiry, session-binding identifier, and current evidence (database clock,
-- permit state, the OVD-379 service-only admission resolver row, and the
-- rollout control) so the worker can re-evaluate the OVD-457 contract. It never
-- includes credentials, file content, scope snapshots, or raw policy/history
-- rows. Every denial from this function is terminal (retryable = false); only
-- transport/RPC failure is classified as preflight_unavailable by the worker.
--
-- Rollback: revoke execute on public.api_authorize_provider_worker_dispatch
-- from service_role (generic preflight disabled; the specialized Xometry RPC
-- remains), then drop it and private.provider_dispatch_authorization_denial.
-- No table or data changes.

create or replace function private.provider_dispatch_authorization_denial(p_denial text)
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-authorization.v1',
    'authorized', false,
    'denial', p_denial,
    'retryable', false
  );
$$;

revoke all on function private.provider_dispatch_authorization_denial(text)
  from public, anon, authenticated, service_role;

create or replace function public.api_authorize_provider_worker_dispatch(
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
  v_task public.work_queue%rowtype;
  v_result public.vendor_quote_results%rowtype;
  v_lane public.quote_request_lanes%rowtype;
  v_permit private.provider_dispatch_permits%rowtype;
  v_review private.provider_dispatch_envelope_reviews%rowtype;
  v_rollout private.commercial_rollout_controls%rowtype;
  v_job public.jobs%rowtype;
  v_part public.parts%rowtype;
  v_cad public.job_files%rowtype;
  v_drawing public.job_files%rowtype;
  v_request_status text;
  v_permit_id_text text;
  v_permit_state text;
  v_notice jsonb;
  v_access jsonb;
  v_admission jsonb;
  v_candidate record;
  v_now timestamptz;
begin
  -- Specialized compatibility path: the legacy Xometry decision, unchanged.
  if p_scope_snapshot ->> 'vendor' = 'xometry' then
    return public.api_authorize_xometry_beta_worker_dispatch(
      p_work_queue_task_id,
      p_vendor_quote_result_id,
      p_scope_snapshot,
      p_expected_worker_name,
      p_expected_claimed_at
    );
  end if;

  if p_work_queue_task_id is null
    or p_vendor_quote_result_id is null
    or nullif(pg_catalog.btrim(p_expected_worker_name), '') is null
    or p_expected_claimed_at is null then
    return private.provider_dispatch_authorization_denial('task_lane_mismatch');
  end if;
  if p_scope_snapshot is null
    or pg_catalog.jsonb_typeof(p_scope_snapshot) <> 'object'
    or p_scope_snapshot ->> 'schema' is distinct from 'quote-lane-scope.v1'
    or p_scope_snapshot ->> 'vendor' is null then
    return private.provider_dispatch_authorization_denial('scope_mismatch');
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
    return private.provider_dispatch_authorization_denial('task_inactive');
  end if;
  if v_task.payload ->> 'vendor' is distinct from p_scope_snapshot ->> 'vendor' then
    return private.provider_dispatch_authorization_denial('provider_mismatch');
  end if;
  if v_task.payload ->> 'vendorQuoteResultId' is distinct from p_vendor_quote_result_id::text
    or v_task.payload ->> 'quoteRunId' is distinct from v_task.quote_run_id::text
    or v_task.payload ->> 'partId' is distinct from v_task.part_id::text then
    return private.provider_dispatch_authorization_denial('task_lane_mismatch');
  end if;

  -- Internal, service-created, and legacy tasks carry no generic permit.
  v_permit_id_text := v_task.payload ->> 'providerDispatchPermitId';
  if v_permit_id_text is null
    or v_permit_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return private.provider_dispatch_authorization_denial('permit_state_missing');
  end if;

  -- FOR UPDATE (not NO KEY UPDATE) so a concurrent revocation's KEY SHARE
  -- lock serializes against this preflight.
  select permit_row.* into v_permit
  from private.provider_dispatch_permits permit_row
  where permit_row.id = v_permit_id_text::uuid
  for update;

  if v_permit.id is null then
    return private.provider_dispatch_authorization_denial('permit_state_missing');
  end if;
  if v_permit.provider::text is distinct from v_task.payload ->> 'vendor' then
    return private.provider_dispatch_authorization_denial('provider_mismatch');
  end if;
  if v_task.payload ->> 'providerDispatchEnvelopeRevision'
      is distinct from v_permit.envelope_id || '.v' || v_permit.envelope_version::text then
    return private.provider_dispatch_authorization_denial('provider_envelope_mismatch');
  end if;
  if v_task.payload ->> 'providerDispatchEnvelopeFingerprint' is distinct from v_permit.envelope_fingerprint
    or v_permit.work_queue_task_id <> v_task.id
    or v_permit.vendor_quote_result_id <> p_vendor_quote_result_id then
    return private.provider_dispatch_authorization_denial('permit_mismatch');
  end if;
  if v_permit.organization_id is distinct from v_task.organization_id then
    return private.provider_dispatch_authorization_denial('organization_mismatch');
  end if;
  if v_permit.job_id is distinct from v_task.job_id then
    return private.provider_dispatch_authorization_denial('job_mismatch');
  end if;
  if v_permit.part_id is distinct from v_task.part_id then
    return private.provider_dispatch_authorization_denial('part_mismatch');
  end if;
  if v_permit.quote_run_id is distinct from v_task.quote_run_id then
    return private.provider_dispatch_authorization_denial('task_lane_mismatch');
  end if;
  if v_task.payload ->> 'quoteLaneScopeFingerprint' is distinct from v_permit.scope_fingerprint then
    return private.provider_dispatch_authorization_denial('scope_mismatch');
  end if;

  -- Early permit state and lifetime check; repeated after every lock below.
  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  v_permit_state := private.resolve_provider_dispatch_permit_state(v_permit.id);
  if v_permit_state = 'revoked' then
    return private.provider_dispatch_authorization_denial('permit_revoked');
  end if;
  if v_permit_state = 'expired' or v_now >= v_permit.expires_at then
    return private.provider_dispatch_authorization_denial('permit_expired');
  end if;
  if v_permit_state is distinct from 'active' then
    return private.provider_dispatch_authorization_denial('permit_state_missing');
  end if;
  if v_now < v_permit.issued_at then
    return private.provider_dispatch_authorization_denial('permit_not_yet_valid');
  end if;

  -- Result, request, and job lifecycle, read by their locking statements.
  select result_row.* into v_result
  from public.vendor_quote_results result_row
  where result_row.id = p_vendor_quote_result_id
  for share;
  if v_result.id is null or v_result.status <> 'running' then
    return private.provider_dispatch_authorization_denial('task_inactive');
  end if;
  if v_result.vendor <> v_permit.provider then
    return private.provider_dispatch_authorization_denial('provider_mismatch');
  end if;
  if v_result.organization_id <> v_permit.organization_id then
    return private.provider_dispatch_authorization_denial('organization_mismatch');
  end if;
  if v_result.part_id <> v_permit.part_id
    or v_result.quote_run_id <> v_permit.quote_run_id then
    return private.provider_dispatch_authorization_denial('task_lane_mismatch');
  end if;

  select request_row.status::text into v_request_status
  from public.quote_requests request_row
  where request_row.id = v_permit.quote_request_id
  for share;
  if v_request_status is null or v_request_status not in ('queued', 'requesting') then
    return private.provider_dispatch_authorization_denial('task_inactive');
  end if;

  select job_row.* into v_job
  from public.jobs job_row
  where job_row.id = v_permit.job_id
  for share;
  if v_job.id is null or v_job.organization_id <> v_permit.organization_id then
    return private.provider_dispatch_authorization_denial('job_mismatch');
  end if;
  perform 1 from public.parts part where part.job_id = v_permit.job_id order by part.id for share;
  perform 1
  from public.approved_part_requirements requirement
  where requirement.part_id in (select part.id from public.parts part where part.job_id = v_permit.job_id)
  order by requirement.part_id
  for share;
  perform 1
  from public.job_files file_row
  where file_row.id in (
    select part.cad_file_id from public.parts part where part.job_id = v_permit.job_id
    union
    select part.drawing_file_id from public.parts part where part.job_id = v_permit.job_id
  )
  order by file_row.id
  for share;
  -- Same job eligibility as the OVD-458 request path.
  if v_job.archived_at is not null then
    return private.provider_dispatch_authorization_denial('task_inactive');
  end if;
  if public.normalize_requested_service_kinds(
    v_job.requested_service_kinds,
    v_job.primary_service_kind
  ) is distinct from array['manufacturing_quote']::text[] then
    return private.provider_dispatch_authorization_denial('scope_mismatch');
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
    or v_lane.vendor <> v_permit.provider
    or v_lane.requested_quantity <> v_permit.requested_quantity
    or v_lane.scope_version <> v_permit.scope_version
    or v_lane.scope_fingerprint <> v_permit.scope_fingerprint then
    return private.provider_dispatch_authorization_denial('task_lane_mismatch');
  end if;

  -- Current provider admission and reviewed envelope, held until commit.
  perform 1
  from private.quote_provider_admission_policies policy
  where policy.provider = v_permit.provider
  for share;
  select pg_catalog.to_jsonb(admission) into v_admission
  from private.resolve_quote_provider_admission_policy(v_permit.provider::text) admission;
  if v_admission -> 'policy_present' is distinct from 'true'::jsonb then
    return private.provider_dispatch_authorization_denial('admission_evidence_missing');
  end if;
  if v_admission ->> 'reason_code' = 'policy_expired' then
    return private.provider_dispatch_authorization_denial('admission_expired');
  end if;
  if v_admission -> 'generically_dispatchable' is distinct from 'true'::jsonb then
    return private.provider_dispatch_authorization_denial('admission_disabled');
  end if;
  if v_admission ->> 'policy_revision' is distinct from v_permit.admission_policy_revision
    or v_admission ->> 'evidence_reference' is distinct from v_permit.admission_evidence_reference then
    return private.provider_dispatch_authorization_denial('admission_stale');
  end if;

  select review.* into v_review
  from private.provider_dispatch_envelope_reviews review
  where review.provider = v_permit.provider
    and review.withdrawn_at is null
  for share;
  if v_review.id is null then
    return private.provider_dispatch_authorization_denial('provider_envelope_unknown');
  end if;
  if v_review.envelope_id <> v_permit.envelope_id
    or v_review.envelope_version <> v_permit.envelope_version then
    return private.provider_dispatch_authorization_denial('provider_envelope_mismatch');
  end if;

  -- Founding Beta notice, enrollment, commercial entitlement, and rollout.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('founding-beta:' || v_permit.organization_id::text, 0)
  );
  v_notice := private.current_founding_beta_notice();
  if v_notice ->> 'policyRevision' is distinct from v_permit.notice_revision then
    return private.provider_dispatch_authorization_denial('notice_mismatch');
  end if;
  -- Also takes the shared automatic-quote rollout lock.
  v_access := private.resolve_quote_access(v_permit.job_id, v_permit.actor_user_id);
  if v_access ->> 'reasonCode' = 'automatic_quote_disabled' then
    return private.provider_dispatch_authorization_denial('rollout_disabled');
  end if;
  if v_access ->> 'state' is distinct from 'eligible'
    or v_access ->> 'source' is distinct from 'commercial_entitlement' then
    return private.provider_dispatch_authorization_denial('access_revoked');
  end if;

  select control.* into v_rollout
  from private.commercial_rollout_controls control
  where control.capability = 'automatic_quote_collection';
  if v_rollout.enabled is not true then
    return private.provider_dispatch_authorization_denial('rollout_disabled');
  end if;
  if v_rollout.revision <> v_permit.rollout_revision then
    return private.provider_dispatch_authorization_denial('rollout_stale');
  end if;

  if not exists (
    select 1 from public.org_vendor_configs config
    where config.organization_id = v_permit.organization_id
  ) or coalesce(
    v_permit.provider = any(public.get_enabled_client_quote_vendors(
      v_permit.organization_id, v_job.project_id, v_job.id
    )),
    false
  ) is not true then
    return private.provider_dispatch_authorization_denial('provider_not_enabled');
  end if;

  -- Current source bytes. v1 outbound files are identity copies, so the
  -- derivative hashes are the source hashes bound in the stored envelope.
  select part_row.* into v_part from public.parts part_row where part_row.id = v_permit.part_id;
  select file_row.* into v_cad from public.job_files file_row where file_row.id = v_permit.cad_file_id;
  if v_permit.drawing_file_id is not null then
    select file_row.* into v_drawing from public.job_files file_row where file_row.id = v_permit.drawing_file_id;
  end if;
  if v_part.id is null
    or v_part.cad_file_id is distinct from v_permit.cad_file_id
    or v_part.drawing_file_id is distinct from v_permit.drawing_file_id
    or v_cad.id is null
    or v_cad.job_id <> v_permit.job_id
    or v_cad.organization_id <> v_permit.organization_id
    or v_cad.trusted_content_sha256 is distinct from v_permit.cad_sha256
    or (v_permit.drawing_file_id is not null and (
      v_drawing.id is null
      or v_drawing.job_id <> v_permit.job_id
      or v_drawing.organization_id <> v_permit.organization_id
      or v_drawing.trusted_content_sha256 is distinct from v_permit.drawing_sha256
    )) then
    return private.provider_dispatch_authorization_denial('source_file_mismatch');
  end if;

  -- Staged scope: the worker's exact snapshot must bind the permit's files and
  -- equal the lane registered at mint time.
  if p_scope_snapshot #>> '{part,cad,fileId}' is distinct from v_permit.cad_file_id::text
    or p_scope_snapshot #>> '{part,cad,sha256}' is distinct from v_permit.cad_sha256
    or p_scope_snapshot #>> '{part,drawing,fileId}' is distinct from v_permit.drawing_file_id::text
    or p_scope_snapshot #>> '{part,drawing,sha256}' is distinct from v_permit.drawing_sha256 then
    return private.provider_dispatch_authorization_denial('source_file_mismatch');
  end if;
  if p_scope_snapshot is distinct from v_lane.scope_snapshot then
    return private.provider_dispatch_authorization_denial('scope_mismatch');
  end if;

  -- Current scope: exactly one current candidate with the permit's
  -- fingerprint. Count and selection come from one evaluation.
  select current_candidate.* into v_candidate
  from (
    select candidate.*, pg_catalog.count(*) over () as candidate_count
    from private.quote_lane_candidates(
      v_permit.job_id,
      array[v_permit.provider]::public.vendor_name[]
    ) candidate
  ) current_candidate
  where current_candidate.organization_id = v_permit.organization_id
    and current_candidate.part_id = v_permit.part_id
    and current_candidate.vendor = v_permit.provider
    and current_candidate.requested_quantity = v_permit.requested_quantity;
  if v_candidate.candidate_count is distinct from 1
    or v_candidate.scope_fingerprint is null
    or v_candidate.scope_version <> v_permit.scope_version
    or v_candidate.scope_fingerprint <> v_permit.scope_fingerprint
    or v_candidate.scope_snapshot is distinct from p_scope_snapshot then
    return private.provider_dispatch_authorization_denial('scope_mismatch');
  end if;

  -- Every lock is held. Re-sample the clock and repeat each time-dependent
  -- check against it; this is the timestamp returned to the worker.
  v_now := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  if v_now >= v_permit.expires_at then
    return private.provider_dispatch_authorization_denial('permit_expired');
  end if;
  if v_now < v_permit.issued_at then
    return private.provider_dispatch_authorization_denial('permit_not_yet_valid');
  end if;
  if (v_admission ->> 'expires_at')::timestamptz <= v_now then
    return private.provider_dispatch_authorization_denial('admission_expired');
  end if;
  if private.resolve_organization_entitlements_at(v_permit.organization_id, v_now)
      -> 'automaticQuoteCollection' is distinct from 'true'::jsonb then
    return private.provider_dispatch_authorization_denial('access_revoked');
  end if;

  return pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-authorization.v1',
    'authorized', true,
    'permitId', v_permit.id,
    'provider', v_permit.provider,
    'envelopeFingerprint', v_permit.envelope_fingerprint,
    'canonicalEnvelope', v_permit.canonical_envelope,
    'expiresAt', v_permit.envelope ->> 'expiresAt',
    'sessionBindingId', v_permit.session_binding_id,
    'evidence', pg_catalog.jsonb_build_object(
      'now', pg_catalog.to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'permitState', v_permit_state,
      'admission', v_admission,
      'rollout', pg_catalog.jsonb_build_object(
        'capability', v_rollout.capability,
        'enabled', v_rollout.enabled,
        'revision', v_rollout.revision
      )
    )
  );
end;
$$;

revoke all on function public.api_authorize_provider_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.api_authorize_provider_worker_dispatch(
  uuid, uuid, jsonb, text, timestamptz
) to service_role;
