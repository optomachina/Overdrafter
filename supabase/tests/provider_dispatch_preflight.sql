-- OVD-459 service-role provider dispatch preflight.
-- Synthetic identifiers only. A generic fictiv permit is minted through the
-- real OVD-458 RPC, its task is claimed like a worker claim, and every terminal
-- denial is exercised against one changed fact at a time. Xometry calls must
-- return the unchanged legacy decision byte for byte.
begin;

select plan(59);

create function pg_temp.as_user(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', p_user_id, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

create function pg_temp.denied(p_denial text)
returns jsonb
language sql
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-authorization.v1',
    'authorized', false,
    'denial', p_denial,
    'retryable', false
  );
$$;

-- Catalog and grant boundaries.
select ok(
  not exists (
    select 1 from pg_catalog.pg_proc proc
    where proc.proname in ('api_authorize_provider_worker_dispatch', 'provider_dispatch_authorization_denial')
      and (proc.proconfig is null or not ('search_path=pg_catalog' = any(proc.proconfig)))
  )
  and (select count(*) from pg_catalog.pg_proc proc
    where proc.proname in ('api_authorize_provider_worker_dispatch', 'provider_dispatch_authorization_denial')) = 2,
  'both new functions exist once and pin search_path to pg_catalog'
);
select ok(
  pg_catalog.has_function_privilege('service_role',
    'public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('authenticated',
    'public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('anon',
    'public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('public',
    'public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)', 'EXECUTE'),
  'only service_role can execute the provider preflight'
);
select ok(
  not exists (
    select 1 from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as r(role)
    where pg_catalog.has_function_privilege(r.role,
      'private.provider_dispatch_authorization_denial(text)', 'EXECUTE')
  ),
  'no API role can execute the private denial builder'
);
select ok(
  (select prosecdef from pg_catalog.pg_proc
    where oid = 'public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)'::regprocedure),
  'the preflight is security definer so service_role never reads private tables directly'
);

-- Synthetic generic tenant (fictiv), enabled exactly as the OVD-458 fixture.
insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-000000045901', 'authenticated', 'authenticated', 'ovd459-member@example.test', now());
insert into public.organizations (id, name, slug) values
  ('00000000-0000-4000-8000-000000045902', 'OVD 459 Generic', 'ovd-459-generic'),
  ('00000000-0000-4000-8000-000000045912', 'OVD 459 Xometry', 'ovd-459-xometry');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-000000045902', '00000000-0000-4000-8000-000000045901', 'client'),
  ('00000000-0000-4000-8000-000000045912', '00000000-0000-4000-8000-000000045901', 'client');
update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id in ('00000000-0000-4000-8000-000000045902', '00000000-0000-4000-8000-000000045912');
insert into private.sourcing_destination_history (organization_id, state, address)
select org.id, 'confirmed', private.effective_sourcing_address(org.id)
from (values ('00000000-0000-4000-8000-000000045902'::uuid), ('00000000-0000-4000-8000-000000045912'::uuid)) org(id);
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
)
select org.id, 'complimentary', now() - interval '1 day', now() + interval '30 days', 'OVD-459 fixture',
  '00000000-0000-4000-8000-000000045901'
from (values ('00000000-0000-4000-8000-000000045902'::uuid), ('00000000-0000-4000-8000-000000045912'::uuid)) org(id);
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
)
select org.id, '00000000-0000-4000-8000-000000045901', 'grant', 'OVD-459 fixture', 'founding-beta-2026-08-15',
  '/legal/beta-terms', '/legal/privacy', 'ovd459-grant-' || org.id::text
from (values ('00000000-0000-4000-8000-000000045902'::uuid), ('00000000-0000-4000-8000-000000045912'::uuid)) org(id);
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
select org.id, '00000000-0000-4000-8000-000000045901', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy'
from (values ('00000000-0000-4000-8000-000000045902'::uuid), ('00000000-0000-4000-8000-000000045912'::uuid)) org(id);
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests) values
  ('00000000-0000-4000-8000-000000045902', 'fictiv', true),
  ('00000000-0000-4000-8000-000000045912', 'xometry', true);
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-459 local pgTAP fixture'
where capability = 'automatic_quote_collection';
update private.quote_provider_admission_policies
set admission_state = 'approved', generic_dispatch_enabled = true,
  policy_revision = 'fictiv-generic-2026-10-03.v1', evidence_reference = 'OVD-458',
  permission_basis = 'written_provider_authorization',
  supported_processes = array['cnc_milling']::public.process_types[],
  accepted_file_extensions = array['step', 'stp', 'pdf'], session_owner = 'overdrafter_managed',
  reviewed_by = '00000000-0000-4000-8000-000000045901', reviewed_at = now() - interval '1 day',
  expires_at = null, change_reason = 'approval_recorded'
where provider = 'fictiv';
insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
values ('fictiv', 'fictiv-quote-envelope', 1, 'OVD-458', 900);

insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind) values
  ('00000000-0000-4000-8000-000000045903', '00000000-0000-4000-8000-000000045902',
   '00000000-0000-4000-8000-000000045901', 'OVD-459 generic part', 'ready_to_quote',
   array['manufacturing_quote'], 'manufacturing_quote'),
  ('00000000-0000-4000-8000-000000045913', '00000000-0000-4000-8000-000000045912',
   '00000000-0000-4000-8000-000000045901', 'OVD-459 Xometry part', 'ready_to_quote',
   array['manufacturing_quote'], 'manufacturing_quote');
insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
) values
  ('00000000-0000-4000-8000-000000045905', '00000000-0000-4000-8000-000000045902', repeat('1', 64), repeat('1', 64),
   'job-files', 'ovd459/part.step', 100, 'application/step'),
  ('00000000-0000-4000-8000-000000045907', '00000000-0000-4000-8000-000000045902', repeat('2', 64), repeat('2', 64),
   'job-files', 'ovd459/drawing.pdf', 100, 'application/pdf'),
  ('00000000-0000-4000-8000-000000045914', '00000000-0000-4000-8000-000000045912', repeat('3', 64), repeat('3', 64),
   'job-files', 'ovd459/xometry.step', 100, 'application/step');
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
) values
  ('00000000-0000-4000-8000-000000045906', '00000000-0000-4000-8000-000000045903',
   '00000000-0000-4000-8000-000000045902', '00000000-0000-4000-8000-000000045901',
   '00000000-0000-4000-8000-000000045905', repeat('1', 64), repeat('1', 64), 'job-files',
   'ovd459/part.step', 'part.step', 'part', 'cad', 'application/step', 100),
  ('00000000-0000-4000-8000-000000045908', '00000000-0000-4000-8000-000000045903',
   '00000000-0000-4000-8000-000000045902', '00000000-0000-4000-8000-000000045901',
   '00000000-0000-4000-8000-000000045907', repeat('2', 64), repeat('2', 64), 'job-files',
   'ovd459/drawing.pdf', 'drawing.pdf', 'drawing', 'drawing', 'application/pdf', 100),
  ('00000000-0000-4000-8000-000000045915', '00000000-0000-4000-8000-000000045913',
   '00000000-0000-4000-8000-000000045912', '00000000-0000-4000-8000-000000045901',
   '00000000-0000-4000-8000-000000045914', repeat('3', 64), repeat('3', 64), 'job-files',
   'ovd459/xometry.step', 'xometry.step', 'xometry', 'cad', 'application/step', 100);
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id, quantity) values
  ('00000000-0000-4000-8000-000000045904', '00000000-0000-4000-8000-000000045903',
   '00000000-0000-4000-8000-000000045902', 'Generic part', 'generic-part',
   '00000000-0000-4000-8000-000000045906', '00000000-0000-4000-8000-000000045908', 1),
  ('00000000-0000-4000-8000-000000045916', '00000000-0000-4000-8000-000000045913',
   '00000000-0000-4000-8000-000000045912', 'Xometry part', 'xometry-part',
   '00000000-0000-4000-8000-000000045915', null, 1);
insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
  quote_quantities, applicable_vendors, spec_snapshot
) values
  ('00000000-0000-4000-8000-000000045904', '00000000-0000-4000-8000-000000045902',
   '00000000-0000-4000-8000-000000045901', '7075-T6 Aluminum', 'Anodized', 0.002, 5, array[5],
   array['fictiv']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb),
  ('00000000-0000-4000-8000-000000045916', '00000000-0000-4000-8000-000000045912',
   '00000000-0000-4000-8000-000000045901', '6061-T6 Aluminum', 'As machined', 0.0050, 1, array[1],
   array['xometry']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb);

-- Mint one generic and one Xometry permit through the real request RPCs.
create temporary table ovd459_minted (provider text primary key, permit_id uuid not null) on commit drop;
grant select, insert on ovd459_minted to authenticated;
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000045901');
insert into ovd459_minted
select 'fictiv', (public.api_request_provider_dispatch(
  '00000000-0000-4000-8000-000000045903', 'fictiv', 'inch',
  public.api_get_provider_dispatch_scope('00000000-0000-4000-8000-000000045903', 'fictiv', 'inch') ->> 'scopeFingerprint',
  'founding-beta-2026-08-15', 'fictiv-quote-envelope.v1', '00000000-0000-4000-8000-000000045909', true, true, true
) ->> 'permitId')::uuid;
insert into ovd459_minted
select 'xometry', (public.api_request_provider_dispatch(
  '00000000-0000-4000-8000-000000045913', 'xometry', 'inch',
  public.api_get_xometry_beta_dispatch_scope('00000000-0000-4000-8000-000000045913', 'inch') ->> 'scopeFingerprint',
  'founding-beta-2026-08-15', 'xometry-controlled-beta-envelope.v1', '00000000-0000-4000-8000-000000045919', true, true, true
) ->> 'permitId')::uuid;
reset role;

-- Claim both tasks the way the worker claim does.
update public.work_queue
set status = 'running', locked_at = date_trunc('milliseconds', now()), locked_by = 'ovd459-worker' -- NOSONAR: deterministic worker-claim fixture
where id in (
  select work_queue_task_id from private.provider_dispatch_permits
  where id = (select permit_id from ovd459_minted where provider = 'fictiv')
  union all
  select work_queue_task_id from private.xometry_beta_dispatch_permits
  where id = (select permit_id from ovd459_minted where provider = 'xometry')
);
update public.vendor_quote_results
set status = 'running'
where id in (
  select vendor_quote_result_id from private.provider_dispatch_permits
  where id = (select permit_id from ovd459_minted where provider = 'fictiv')
  union all
  select vendor_quote_result_id from private.xometry_beta_dispatch_permits
  where id = (select permit_id from ovd459_minted where provider = 'xometry')
);

create temporary table ovd459_ctx on commit drop as
select permit.id as permit_id, permit.work_queue_task_id as task_id, permit.vendor_quote_result_id as result_id,
  lane.scope_snapshot as snapshot, task.locked_at as claimed_at
from private.provider_dispatch_permits permit
join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
join public.work_queue task on task.id = permit.work_queue_task_id
where permit.id = (select permit_id from ovd459_minted where provider = 'fictiv');

create temporary table ovd459_xometry_ctx on commit drop as
select permit.work_queue_task_id as task_id, permit.vendor_quote_result_id as result_id,
  lane.scope_snapshot as snapshot, task.locked_at as claimed_at
from private.xometry_beta_dispatch_permits permit
join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
join public.work_queue task on task.id = permit.work_queue_task_id
where permit.id = (select permit_id from ovd459_minted where provider = 'xometry');

-- Calls the preflight as service_role with optional single-input overrides.
create function pg_temp.preflight(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_ctx record;
  v_result jsonb;
begin
  select * into strict v_ctx from ovd459_ctx;
  perform pg_catalog.set_config('role', 'service_role', true);
  v_result := public.api_authorize_provider_worker_dispatch(
    case when p ? 'taskId' then (p ->> 'taskId')::uuid else v_ctx.task_id end,
    case when p ? 'resultId' then (p ->> 'resultId')::uuid else v_ctx.result_id end,
    case when p ? 'snapshot' then p -> 'snapshot' else v_ctx.snapshot end,
    coalesce(p ->> 'worker', 'ovd459-worker'),
    case when p ? 'claimedAt' then (p ->> 'claimedAt')::timestamptz else v_ctx.claimed_at end
  );
  perform pg_catalog.set_config('role', 'none', true);
  return v_result;
end;
$$;

-- Rewrites the stored permit (append-only guard lifted inside a savepoint
-- only) with a correctly rebuilt envelope and matching task fingerprint, so a
-- single lifetime or notice fact differs while every constraint still holds.
create function pg_temp.rewrite_permit(p_set jsonb)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_row private.provider_dispatch_permits%rowtype;
begin
  select permit.* into strict v_row
  from private.provider_dispatch_permits permit
  where permit.id = (select permit_id from ovd459_ctx);
  v_row.issued_at := coalesce((p_set ->> 'issuedAt')::timestamptz, v_row.issued_at);
  v_row.expires_at := coalesce((p_set ->> 'expiresAt')::timestamptz, v_row.expires_at);
  v_row.notice_revision := coalesce(p_set ->> 'noticeRevision', v_row.notice_revision);
  v_row.envelope := private.build_provider_dispatch_envelope(
    v_row.provider, v_row.envelope_id, v_row.envelope_version, v_row.admission_policy_revision,
    v_row.admission_evidence_reference, v_row.notice_revision, v_row.actor_user_id,
    v_row.organization_id, v_row.job_id, v_row.part_id, v_row.scope_version, v_row.scope_fingerprint,
    v_row.requested_quantity, v_row.declared_model_units, v_row.cad_file_id, v_row.cad_sha256,
    v_row.drawing_file_id, v_row.drawing_sha256, v_row.quote_request_id, v_row.quote_run_id,
    v_row.vendor_quote_result_id, v_row.quote_request_lane_id, v_row.work_queue_task_id, v_row.id,
    v_row.approval_reference, v_row.session_binding_id, v_row.rollout_revision, v_row.issued_at,
    v_row.expires_at
  );
  v_row.canonical_envelope := v_row.envelope::text;
  v_row.envelope_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_row.canonical_envelope, 'UTF8')), 'hex');
  alter table private.provider_dispatch_permits disable trigger provider_dispatch_permits_append_only;
  update private.provider_dispatch_permits
  set issued_at = v_row.issued_at, expires_at = v_row.expires_at, notice_revision = v_row.notice_revision,
    envelope = v_row.envelope, canonical_envelope = v_row.canonical_envelope,
    envelope_fingerprint = v_row.envelope_fingerprint
  where id = v_row.id;
  alter table private.provider_dispatch_permits enable trigger provider_dispatch_permits_append_only;
  update public.work_queue
  set payload = payload || pg_catalog.jsonb_build_object('providerDispatchEnvelopeFingerprint', v_row.envelope_fingerprint)
  where id = v_row.work_queue_task_id;
end;
$$;

-- Authorized decision: bounded, versioned, and bound to the stored envelope.
create temporary table ovd459_authorized on commit drop as select pg_temp.preflight() as decision;

select is(
  (select array_agg(key order by key) from ovd459_authorized, jsonb_object_keys(decision) key),
  array['authorized', 'canonicalEnvelope', 'envelopeFingerprint', 'evidence', 'expiresAt', 'permitId',
    'provider', 'schema', 'sessionBindingId'],
  'the authorized response exposes exactly the bounded provider-dispatch-authorization.v1 keys'
);
select ok(
  (select decision ->> 'schema' = 'provider-dispatch-authorization.v1'
      and decision -> 'authorized' = 'true'::jsonb
      and decision ->> 'permitId' = permit.id::text
      and decision ->> 'provider' = 'fictiv'
      and decision ->> 'sessionBindingId' = 'lease:' || permit.id::text
      and decision ->> 'expiresAt' = permit.envelope ->> 'expiresAt'
   from ovd459_authorized, private.provider_dispatch_permits permit
   where permit.id = (select permit_id from ovd459_ctx)),
  'the exact running task, permit, provider, scope, and session binding authorize'
);
select ok(
  (select decision ->> 'canonicalEnvelope' = permit.canonical_envelope
      and decision ->> 'envelopeFingerprint' = permit.envelope_fingerprint
      and decision ->> 'envelopeFingerprint' = pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(decision ->> 'canonicalEnvelope', 'UTF8')), 'hex')
      and (decision ->> 'canonicalEnvelope')::jsonb ->> 'sessionBindingId' = decision ->> 'sessionBindingId'
      and (decision ->> 'canonicalEnvelope')::jsonb #>> '{task,workQueueTaskId}' = (select task_id::text from ovd459_ctx)
   from ovd459_authorized, private.provider_dispatch_permits permit
   where permit.id = (select permit_id from ovd459_ctx)),
  'the response carries the stored canonical envelope text and its self-verifying fingerprint'
);
select ok(
  (select (select array_agg(key order by key) from jsonb_object_keys(decision -> 'evidence') key)
        = array['admission', 'now', 'permitState', 'rollout']
      and decision #>> '{evidence,permitState}' = 'active'
      and decision #>> '{evidence,now}' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      and decision #> '{evidence,rollout}' = pg_catalog.jsonb_build_object('capability', 'automatic_quote_collection',
        'enabled', true, 'revision', permit.rollout_revision)
      and (select array_agg(key order by key) from jsonb_object_keys(decision #> '{evidence,admission}') key)
        = array['accepted_file_extensions', 'admission_state', 'evidence_reference', 'expires_at',
          'generically_dispatchable', 'permission_basis', 'policy_present', 'policy_revision', 'provider',
          'provider_admitted', 'reason_code', 'reviewed_at', 'session_owner', 'supported_processes']
   from ovd459_authorized, private.provider_dispatch_permits permit
   where permit.id = (select permit_id from ovd459_ctx)),
  'evidence is the database clock, permit state, OVD-379 resolver row, and rollout control only'
);
select ok(
  (select decision::text not like '%part.step%' and decision::text not like '%drawing.pdf%'
      and decision::text not like '%ovd459/%' and decision::text not like '%storage%'
      and decision::text not like '%7075%' and decision::text not like '%reviewed_by%'
      and decision::text not like '%change_reason%'
   from ovd459_authorized),
  'the response carries no file names, storage paths, scope snapshot, or raw policy rows'
);
select is(pg_temp.preflight() -> 'authorized', 'true'::jsonb,
  'preflight is a read-only check: a second call for the same claim authorizes again');

set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000045901');
select throws_ok(
  $$select public.api_authorize_provider_worker_dispatch(
    (select task_id from ovd459_ctx), (select result_id from ovd459_ctx), (select snapshot from ovd459_ctx),
    'ovd459-worker', (select claimed_at from ovd459_ctx))$$,
  '42501', null, 'a client-authenticated caller cannot obtain provider authority');
reset role;

-- Input and task/claim denials.
select is(pg_temp.preflight('{"taskId": null}'), pg_temp.denied('task_lane_mismatch'),
  'a missing task identity is denied');
select is(pg_temp.preflight('{"snapshot": []}'), pg_temp.denied('scope_mismatch'),
  'a non-object staged scope is denied');
select is(pg_temp.preflight('{"worker": "ovd459-other-worker"}'), pg_temp.denied('task_inactive'),
  'a different worker cannot use another worker''s claim');
select is(
  pg_temp.preflight(pg_catalog.jsonb_build_object('claimedAt', (select claimed_at + interval '1 second' from ovd459_ctx))),
  pg_temp.denied('task_inactive'), 'a stale claim generation is denied');
savepoint ovd459_task_queued;
update public.work_queue set status = 'queued' where id = (select task_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('task_inactive'), 'a task that is no longer running is denied');
rollback to savepoint ovd459_task_queued;
select is(
  pg_temp.preflight(pg_catalog.jsonb_build_object('snapshot',
    pg_catalog.jsonb_set((select snapshot from ovd459_ctx), '{vendor}', '"protolabs"'))),
  pg_temp.denied('provider_mismatch'), 'a cross-provider staged scope is denied');
select is(pg_temp.preflight('{"resultId": "00000000-0000-4000-8000-0000000459ff"}'),
  pg_temp.denied('task_lane_mismatch'), 'a substituted result identity is denied');

-- Permit binding denials.
savepoint ovd459_task_organization;
update public.work_queue set organization_id = '00000000-0000-4000-8000-000000045912'
where id = (select task_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('organization_mismatch'),
  'a task moved to another organization is denied');
rollback to savepoint ovd459_task_organization;
savepoint ovd459_task_job;
update public.work_queue set job_id = '00000000-0000-4000-8000-000000045913'
where id = (select task_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('job_mismatch'), 'a task moved to another job is denied');
rollback to savepoint ovd459_task_job;
savepoint ovd459_task_part;
update public.work_queue
set part_id = '00000000-0000-4000-8000-000000045916',
  payload = payload || '{"partId": "00000000-0000-4000-8000-000000045916"}'
where id = (select task_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('part_mismatch'), 'a task moved to another part is denied');
rollback to savepoint ovd459_task_part;

savepoint ovd459_no_permit;
update public.work_queue set payload = payload - 'providerDispatchPermitId' where id = (select task_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('permit_state_missing'),
  'an internal or service-created task without a generic permit gets no runnable authority');
rollback to savepoint ovd459_no_permit;
savepoint ovd459_unknown_permit;
update public.work_queue
set payload = payload || '{"providerDispatchPermitId": "00000000-0000-4000-8000-0000000459ff"}'
where id = (select task_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('permit_state_missing'), 'an unknown permit identity is denied');
rollback to savepoint ovd459_unknown_permit;
savepoint ovd459_envelope_revision;
update public.work_queue
set payload = payload || '{"providerDispatchEnvelopeRevision": "fictiv-quote-envelope.v2"}'
where id = (select task_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('provider_envelope_mismatch'),
  'a task bound to a different envelope revision is denied');
rollback to savepoint ovd459_envelope_revision;
savepoint ovd459_envelope_fingerprint;
update public.work_queue
set payload = payload || pg_catalog.jsonb_build_object('providerDispatchEnvelopeFingerprint', repeat('0', 64))
where id = (select task_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('permit_mismatch'), 'a substituted envelope fingerprint is denied');
rollback to savepoint ovd459_envelope_fingerprint;
savepoint ovd459_cross_task_permit;
create temporary table ovd459_clone on commit drop as
select (pg_catalog.jsonb_populate_record(null::private.provider_dispatch_permits, rebuilt.row_value)).*
from (
  select to_jsonb(permit) || pg_catalog.jsonb_build_object(
    'id', clone.id, 'approval_reference', '00000000-0000-4000-8000-0000000459aa',
    'quote_request_lane_id', '00000000-0000-4000-8000-0000000459ab',
    'work_queue_task_id', '00000000-0000-4000-8000-0000000459ac',
    'session_binding_id', 'lease:' || clone.id::text) as row_value
  from private.provider_dispatch_permits permit
  cross join (select '00000000-0000-4000-8000-0000000459ad'::uuid as id) clone
  where permit.id = (select permit_id from ovd459_ctx)
) rebuilt;
update ovd459_clone set envelope = private.build_provider_dispatch_envelope(
  provider, envelope_id, envelope_version, admission_policy_revision, admission_evidence_reference,
  notice_revision, actor_user_id, organization_id, job_id, part_id, scope_version, scope_fingerprint,
  requested_quantity, declared_model_units, cad_file_id, cad_sha256, drawing_file_id, drawing_sha256,
  quote_request_id, quote_run_id, vendor_quote_result_id, quote_request_lane_id, work_queue_task_id, id,
  approval_reference, session_binding_id, rollout_revision, issued_at, expires_at);
update ovd459_clone set canonical_envelope = envelope::text,
  envelope_fingerprint = encode(sha256(convert_to(envelope::text, 'UTF8')), 'hex');
insert into private.provider_dispatch_permits select * from ovd459_clone;
update public.work_queue
set payload = payload || pg_catalog.jsonb_build_object(
  'providerDispatchPermitId', (select id from ovd459_clone),
  'providerDispatchEnvelopeFingerprint', (select envelope_fingerprint from ovd459_clone))
where id = (select task_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('permit_mismatch'),
  'a valid permit minted for another task cannot authorize this task');
rollback to savepoint ovd459_cross_task_permit;
savepoint ovd459_payload_scope;
update public.work_queue
set payload = payload || pg_catalog.jsonb_build_object('quoteLaneScopeFingerprint', repeat('e', 64))
where id = (select task_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('scope_mismatch'), 'a task payload bound to another scope is denied');
rollback to savepoint ovd459_payload_scope;

-- Permit lifetime, revocation, and notice binding.
savepoint ovd459_expired;
select pg_temp.rewrite_permit(pg_catalog.jsonb_build_object(
  'issuedAt', date_trunc('milliseconds', now() - interval '2 hours'),
  'expiresAt', date_trunc('milliseconds', now() - interval '1 hour')));
select is(pg_temp.preflight(), pg_temp.denied('permit_expired'), 'an expired permit is denied against the database clock');
rollback to savepoint ovd459_expired;
savepoint ovd459_not_yet_valid;
select pg_temp.rewrite_permit(pg_catalog.jsonb_build_object(
  'issuedAt', date_trunc('milliseconds', clock_timestamp() + interval '1 hour'),
  'expiresAt', date_trunc('milliseconds', clock_timestamp() + interval '2 hours')));
select is(pg_temp.preflight(), pg_temp.denied('permit_not_yet_valid'), 'a permit issued in the future is denied');
rollback to savepoint ovd459_not_yet_valid;
savepoint ovd459_revoked;
select private.revoke_provider_dispatch_permit((select permit_id from ovd459_ctx), 'operator_revoked');
select is(pg_temp.preflight(), pg_temp.denied('permit_revoked'), 'a revoked permit is denied');
rollback to savepoint ovd459_revoked;
savepoint ovd459_notice;
select pg_temp.rewrite_permit('{"noticeRevision": "founding-beta-2026-09-01"}');
select is(pg_temp.preflight(), pg_temp.denied('notice_mismatch'),
  'a permit bound to a notice revision other than the current one is denied');
rollback to savepoint ovd459_notice;

-- Task/result/request lifecycle.
savepoint ovd459_result_queued;
update public.vendor_quote_results set status = 'queued' where id = (select result_id from ovd459_ctx);
select is(pg_temp.preflight(), pg_temp.denied('task_inactive'), 'a result that is no longer running is denied');
rollback to savepoint ovd459_result_queued;
savepoint ovd459_request_canceled;
update public.quote_requests set status = 'canceled'
where id = (select quote_request_id from private.provider_dispatch_permits where id = (select permit_id from ovd459_ctx));
select is(pg_temp.preflight(), pg_temp.denied('task_inactive'), 'a canceled quote request is denied');
rollback to savepoint ovd459_request_canceled;

-- Current admission registry and reviewed envelope.
savepoint ovd459_admission_disabled;
update private.quote_provider_admission_policies
set generic_dispatch_enabled = false, policy_revision = 'fictiv-generic-2026-10-03.v2', change_reason = 'policy_disabled'
where provider = 'fictiv';
select is(pg_temp.preflight(), pg_temp.denied('admission_disabled'),
  'the registry rollback switch denies already-issued generic permits');
rollback to savepoint ovd459_admission_disabled;
savepoint ovd459_admission_stale;
update private.quote_provider_admission_policies
set policy_revision = 'fictiv-generic-2026-10-03.v3', change_reason = 'policy_updated'
where provider = 'fictiv';
select is(pg_temp.preflight(), pg_temp.denied('admission_stale'),
  'a permit minted under a superseded admission revision is denied');
rollback to savepoint ovd459_admission_stale;
savepoint ovd459_admission_expired;
update private.quote_provider_admission_policies
set expires_at = now() - interval '1 minute', reviewed_at = now() - interval '2 days',
  policy_revision = 'fictiv-generic-2026-10-03.v4', change_reason = 'policy_expired'
where provider = 'fictiv';
select is(pg_temp.preflight(), pg_temp.denied('admission_expired'), 'an expired admission policy is denied');
rollback to savepoint ovd459_admission_expired;
savepoint ovd459_admission_missing;
alter table private.quote_provider_admission_policies disable trigger guard_quote_provider_admission_policy_mutation;
delete from private.quote_provider_admission_policies where provider = 'fictiv';
select is(pg_temp.preflight(), pg_temp.denied('admission_evidence_missing'),
  'a provider with no admission registry row is denied');
rollback to savepoint ovd459_admission_missing;
savepoint ovd459_envelope_withdrawn;
update private.provider_dispatch_envelope_reviews set withdrawn_at = now() where provider = 'fictiv';
select is(pg_temp.preflight(), pg_temp.denied('provider_envelope_unknown'),
  'withdrawing the reviewed envelope denies already-issued permits');
rollback to savepoint ovd459_envelope_withdrawn;
savepoint ovd459_envelope_replaced;
update private.provider_dispatch_envelope_reviews set withdrawn_at = now() where provider = 'fictiv';
insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
values ('fictiv', 'fictiv-quote-envelope', 2, 'OVD-459', 900);
select is(pg_temp.preflight(), pg_temp.denied('provider_envelope_mismatch'),
  'a permit bound to a superseded reviewed envelope is denied');
rollback to savepoint ovd459_envelope_replaced;

-- Enrollment, entitlement, rollout, and provider enablement.
savepoint ovd459_beta_revoked;
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values ('00000000-0000-4000-8000-000000045902', '00000000-0000-4000-8000-000000045901', 'revoke',
  'OVD-459 fixture', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy', 'ovd459-revoke');
select is(pg_temp.preflight(), pg_temp.denied('access_revoked'), 'revoked Founding Beta enrollment is denied');
rollback to savepoint ovd459_beta_revoked;
savepoint ovd459_entitlement;
delete from private.organization_entitlement_grants where organization_id = '00000000-0000-4000-8000-000000045902';
select is(pg_temp.preflight(), pg_temp.denied('access_revoked'), 'a removed commercial entitlement is denied');
rollback to savepoint ovd459_entitlement;
savepoint ovd459_rollout_off;
update private.commercial_rollout_controls set enabled = false, revision = revision + 1,
  change_reason = 'OVD-459 rollout off'
where capability = 'automatic_quote_collection';
select is(pg_temp.preflight(), pg_temp.denied('rollout_disabled'), 'a disabled automatic-quote rollout is denied');
rollback to savepoint ovd459_rollout_off;
savepoint ovd459_rollout_stale;
update private.commercial_rollout_controls set revision = revision + 1, change_reason = 'OVD-459 rollout revised'
where capability = 'automatic_quote_collection';
select is(pg_temp.preflight(), pg_temp.denied('rollout_stale'),
  'a permit minted under a superseded rollout revision is denied');
rollback to savepoint ovd459_rollout_stale;
savepoint ovd459_provider_disabled;
update public.org_vendor_configs set enabled_for_client_quote_requests = false
where organization_id = '00000000-0000-4000-8000-000000045902' and vendor = 'fictiv';
select is(pg_temp.preflight(), pg_temp.denied('provider_not_enabled'),
  'an organization that no longer enables the provider is denied');
rollback to savepoint ovd459_provider_disabled;

-- Source bytes, staged scope, and current scope.
savepoint ovd459_source_bytes;
update public.job_files set trusted_content_sha256 = repeat('9', 64) where id = '00000000-0000-4000-8000-000000045906';
select is(pg_temp.preflight(), pg_temp.denied('source_file_mismatch'), 'changed current CAD bytes are denied');
rollback to savepoint ovd459_source_bytes;
savepoint ovd459_drawing_swapped;
update public.parts set drawing_file_id = null where id = '00000000-0000-4000-8000-000000045904';
select is(pg_temp.preflight(), pg_temp.denied('source_file_mismatch'),
  'a part whose drawing changed since the permit is denied');
rollback to savepoint ovd459_drawing_swapped;
select is(
  pg_temp.preflight(pg_catalog.jsonb_build_object('snapshot',
    pg_catalog.jsonb_set((select snapshot from ovd459_ctx), '{part,cad,sha256}', to_jsonb(repeat('9', 64))))),
  pg_temp.denied('source_file_mismatch'), 'staged CAD bytes that differ from the permit are denied');
select is(
  pg_temp.preflight(pg_catalog.jsonb_build_object('snapshot',
    pg_catalog.jsonb_set((select snapshot from ovd459_ctx), '{part,drawing,fileId}',
      '"00000000-0000-4000-8000-0000000459ff"'))),
  pg_temp.denied('source_file_mismatch'), 'a substituted staged drawing identity is denied');
select is(
  pg_temp.preflight(pg_catalog.jsonb_build_object('snapshot',
    (select snapshot from ovd459_ctx) || '{"ovd459Extra": true}')),
  pg_temp.denied('scope_mismatch'), 'a staged scope that differs from the permitted lane is denied');
savepoint ovd459_current_scope;
update public.approved_part_requirements set material = '6061-T6 Aluminum'
where part_id = '00000000-0000-4000-8000-000000045904';
select is(pg_temp.preflight(), pg_temp.denied('scope_mismatch'),
  'a current scope that changed after the permit is denied');
rollback to savepoint ovd459_current_scope;

-- Every denial above was terminal and wrote nothing.
select ok(
  not exists (select 1 from private.provider_dispatch_permit_revocations
    where permit_id = (select permit_id from ovd459_ctx))
  and (select status = 'running' and locked_by = 'ovd459-worker' from public.work_queue
    where id = (select task_id from ovd459_ctx))
  and (select count(*) = 1 from private.provider_dispatch_permits
    where organization_id = '00000000-0000-4000-8000-000000045902'),
  'preflight denials consumed, revoked, released, and minted nothing'
);
select is(pg_temp.preflight() -> 'authorized', 'true'::jsonb,
  'after every rolled-back change the exact claim authorizes again');

-- Rollback switch: disabling the generic preflight leaves Xometry available.
savepoint ovd459_generic_disabled;
revoke execute on function public.api_authorize_provider_worker_dispatch(uuid, uuid, jsonb, text, timestamptz)
  from service_role;
select throws_ok($$select pg_temp.preflight()$$, '42501', null,
  'revoking the generic preflight disables every generic decision');
create function pg_temp.legacy_as_service()
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_ctx record;
  v_result jsonb;
begin
  select * into strict v_ctx from ovd459_xometry_ctx;
  perform pg_catalog.set_config('role', 'service_role', true);
  v_result := public.api_authorize_xometry_beta_worker_dispatch(
    v_ctx.task_id, v_ctx.result_id, v_ctx.snapshot, 'ovd459-worker', v_ctx.claimed_at);
  perform pg_catalog.set_config('role', 'none', true);
  return v_result;
end;
$$;
select is(pg_temp.legacy_as_service() -> 'authorized', 'true'::jsonb,
  'the specialized Xometry preflight stays available to service_role while the generic one is disabled');
rollback to savepoint ovd459_generic_disabled;

-- Xometry compatibility: the legacy decision verbatim.
create function pg_temp.both_paths(p_task uuid, p_result uuid, p_snapshot jsonb, p_worker text, p_claimed timestamptz)
returns table (generic_text text, legacy_text text)
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  generic_text := public.api_authorize_provider_worker_dispatch(p_task, p_result, p_snapshot, p_worker, p_claimed)::text;
  legacy_text := public.api_authorize_xometry_beta_worker_dispatch(p_task, p_result, p_snapshot, p_worker, p_claimed)::text;
  perform pg_catalog.set_config('role', 'none', true);
  return next;
end;
$$;

create temporary table ovd459_parity on commit drop as
select 'authorized' as name, paths.*
from ovd459_xometry_ctx ctx,
  pg_temp.both_paths(ctx.task_id, ctx.result_id, ctx.snapshot, 'ovd459-worker', ctx.claimed_at) paths
union all
select 'stale scope', paths.*
from ovd459_xometry_ctx ctx,
  pg_temp.both_paths(ctx.task_id, ctx.result_id, ctx.snapshot || '{"ovd459Extra": true}', 'ovd459-worker', ctx.claimed_at) paths
union all
select 'unknown task', paths.*
from ovd459_xometry_ctx ctx,
  pg_temp.both_paths('00000000-0000-4000-8000-0000000459ff', ctx.result_id, ctx.snapshot, 'ovd459-worker', ctx.claimed_at) paths
union all
select 'generic task with Xometry scope', paths.*
from ovd459_ctx ctx, ovd459_xometry_ctx xometry,
  pg_temp.both_paths(ctx.task_id, ctx.result_id, xometry.snapshot, 'ovd459-worker', ctx.claimed_at) paths;

select is((select legacy_text::jsonb -> 'authorized' from ovd459_parity where name = 'authorized'), 'true'::jsonb,
  'the legacy Xometry fixture authorizes through the unchanged specialized preflight');
select is((select generic_text from ovd459_parity where name = 'authorized'),
  (select legacy_text from ovd459_parity where name = 'authorized'),
  'an authorized Xometry decision is byte-identical through the provider preflight');
select is((select generic_text from ovd459_parity where name = 'stale scope'),
  (select legacy_text from ovd459_parity where name = 'stale scope'),
  'a Xometry staged-scope denial is byte-identical through the provider preflight');
select is((select generic_text from ovd459_parity where name = 'unknown task'),
  (select legacy_text from ovd459_parity where name = 'unknown task'),
  'a Xometry unknown-task denial is byte-identical through the provider preflight');
select ok(
  (select generic_text = legacy_text and legacy_text::jsonb -> 'authorized' = 'false'::jsonb
   from ovd459_parity where name = 'generic task with Xometry scope'),
  'a generic task presented with a Xometry scope gets only the legacy denial, never generic authority'
);

select * from finish();
rollback;
