-- OVD-458 generic provider dispatch permit and request.
-- Synthetic identifiers only. The golden envelope below is copied verbatim from
-- test-fixtures/provider-dispatch-envelope/v1.json; a Vitest static check keeps
-- this file and the shared fixture in sync.
begin;

select plan(87);

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

-- Golden builder call with optional single-field substitutions.
create function pg_temp.golden(p_set jsonb default '{}'::jsonb)
returns jsonb
language sql
set search_path = pg_catalog
as $$
  select private.build_provider_dispatch_envelope(
    coalesce(p_set ->> 'provider', 'xometry')::public.vendor_name,
    coalesce(p_set ->> 'envelopeId', 'xometry-controlled-beta-envelope'),
    coalesce((p_set ->> 'envelopeVersion')::integer, 1),
    coalesce(p_set ->> 'admissionPolicyRevision', 'xometry-controlled-beta-2026-08-17.v1'),
    coalesce(p_set ->> 'admissionEvidenceReference', 'OVD-373'),
    coalesce(p_set ->> 'noticeRevision', 'founding-beta-2026-08-15'),
    coalesce(p_set ->> 'actorUserId', '00000000-0000-4000-8000-000000004571')::uuid,
    coalesce(p_set ->> 'organizationId', '00000000-0000-4000-8000-000000004572')::uuid,
    coalesce(p_set ->> 'jobId', '00000000-0000-4000-8000-000000004573')::uuid,
    coalesce(p_set ->> 'partId', '00000000-0000-4000-8000-000000004574')::uuid,
    coalesce((p_set ->> 'scopeVersion')::integer, 1),
    coalesce(p_set ->> 'scopeFingerprint', pg_catalog.repeat('a', 64)),
    coalesce((p_set ->> 'requestedQuantity')::integer, 1),
    coalesce(p_set ->> 'declaredModelUnits', 'inch'),
    coalesce(p_set ->> 'cadFileId', '00000000-0000-4000-8000-000000004575')::uuid,
    coalesce(p_set ->> 'cadSha256', pg_catalog.repeat('b', 64)),
    case when p_set ? 'noDrawing' then null
      else '00000000-0000-4000-8000-000000004576'::uuid end,
    case when p_set ? 'noDrawing' then null
      else coalesce(p_set ->> 'drawingSha256', pg_catalog.repeat('c', 64)) end,
    '00000000-0000-4000-8000-000000004577'::uuid,
    '00000000-0000-4000-8000-000000004578'::uuid,
    '00000000-0000-4000-8000-000000004579'::uuid,
    coalesce(p_set ->> 'quoteRequestLaneId', '00000000-0000-4000-8000-00000000457a')::uuid,
    coalesce(p_set ->> 'workQueueTaskId', '00000000-0000-4000-8000-00000000457b')::uuid,
    coalesce(p_set ->> 'permitId', '00000000-0000-4000-8000-00000000457c')::uuid,
    coalesce(p_set ->> 'approvalReference', '00000000-0000-4000-8000-00000000457d')::uuid,
    coalesce(p_set ->> 'sessionBindingId', 'lease:00000000-0000-4000-8000-00000000457e'),
    coalesce((p_set ->> 'rolloutRevision')::bigint, 3),
    coalesce((p_set ->> 'issuedAt')::timestamptz, '2026-10-03T12:00:00.000Z'::timestamptz),
    coalesce((p_set ->> 'expiresAt')::timestamptz, '2026-10-03T12:15:00.000Z'::timestamptz)
  );
$$;

create function pg_temp.fingerprint(p_envelope jsonb)
returns text
language sql
set search_path = pg_catalog
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_envelope::text, 'UTF8')), 'hex');
$$;

-- 1. Canonical SQL text is byte-identical to the TypeScript golden.
select is(
  pg_temp.golden()::text,
  '{"task": {"quoteRunId": "00000000-0000-4000-8000-000000004578", "quoteRequestId": "00000000-0000-4000-8000-000000004577", "workQueueTaskId": "00000000-0000-4000-8000-00000000457b", "quoteRequestLaneId": "00000000-0000-4000-8000-00000000457a", "vendorQuoteResultId": "00000000-0000-4000-8000-000000004579"}, "scope": {"schema": "quote-lane-scope.v1", "version": 1, "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "requestedQuantity": 1, "declaredModelUnits": "inch"}, "permit": {"permitId": "00000000-0000-4000-8000-00000000457c", "approvalReference": "00000000-0000-4000-8000-00000000457d"}, "schema": "provider-dispatch-envelope.v1", "purpose": "quote_only", "rollout": {"revision": 3, "capability": "automatic_quote_collection"}, "subject": {"jobId": "00000000-0000-4000-8000-000000004573", "partId": "00000000-0000-4000-8000-000000004574", "actorUserId": "00000000-0000-4000-8000-000000004571", "organizationId": "00000000-0000-4000-8000-000000004572"}, "envelope": {"id": "xometry-controlled-beta-envelope", "version": 1}, "issuedAt": "2026-10-03T12:00:00.000Z", "provider": "xometry", "admission": {"policyRevision": "xometry-controlled-beta-2026-08-17.v1", "evidenceReference": "OVD-373"}, "expiresAt": "2026-10-03T12:15:00.000Z", "sourceFiles": [{"role": "cad", "fileId": "00000000-0000-4000-8000-000000004575", "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}, {"role": "drawing", "fileId": "00000000-0000-4000-8000-000000004576", "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}], "affirmations": {"quoteOnly": true, "authorityToShare": true, "nonExportControlled": true}, "outboundFiles": [{"role": "cad", "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "derivation": "identity", "sourceSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}, {"role": "drawing", "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "derivation": "identity", "sourceSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}], "noticeRevision": "founding-beta-2026-08-15", "sessionBindingId": "lease:00000000-0000-4000-8000-00000000457e"}',
  'SQL canonical envelope text equals the shared TypeScript golden byte for byte'
);
select is(
  pg_temp.fingerprint(pg_temp.golden()),
  'f3e0cb1f9139b856112db3692bb4b7c83296b98d71cc9f26326e1be8fcfce4cb',
  'SQL envelope fingerprint equals the shared golden fingerprint'
);
select is(
  pg_temp.golden() -> 'outboundFiles',
  pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('role', 'cad', 'sourceSha256', pg_catalog.repeat('b', 64), 'sha256', pg_catalog.repeat('b', 64), 'derivation', 'identity'),
    pg_catalog.jsonb_build_object('role', 'drawing', 'sourceSha256', pg_catalog.repeat('c', 64), 'sha256', pg_catalog.repeat('c', 64), 'derivation', 'identity')
  ),
  'outbound files are always identity copies of the sources in cad-then-drawing order'
);
select is(
  pg_catalog.jsonb_array_length(pg_temp.golden('{"noDrawing": true}') -> 'sourceFiles') * 10
    + pg_catalog.jsonb_array_length(pg_temp.golden('{"noDrawing": true}') -> 'outboundFiles'),
  11,
  'a CAD-only scope binds exactly one source and one outbound file'
);

-- Every fixture substitution the SQL builder can express changes the fingerprint.
create temporary table ovd458_substitutions (name text primary key, set_value jsonb not null) on commit drop;
insert into ovd458_substitutions values
  ('cross-provider', '{"provider": "fictiv", "envelopeId": "fictiv-controlled-beta-envelope"}'),
  ('envelope revision', '{"envelopeVersion": 2}'),
  ('foreign provider envelope', '{"envelopeId": "fictiv-controlled-beta-envelope"}'),
  ('admission policy revision', '{"admissionPolicyRevision": "xometry-controlled-beta-2026-09-01.v2"}'),
  ('admission evidence reference', '{"admissionEvidenceReference": "OVD-999"}'),
  ('notice revision', '{"noticeRevision": "founding-beta-2026-09-01"}'),
  ('organization', '{"organizationId": "00000000-0000-4000-8000-0000000045ff"}'),
  ('actor', '{"actorUserId": "00000000-0000-4000-8000-0000000045ff"}'),
  ('job', '{"jobId": "00000000-0000-4000-8000-0000000045ff"}'),
  ('part', '{"partId": "00000000-0000-4000-8000-0000000045ff"}'),
  ('source file identity', '{"cadFileId": "00000000-0000-4000-8000-0000000045ff"}'),
  ('source file bytes', '{"cadSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}'),
  ('derivative set', '{"noDrawing": true}'),
  ('scope fingerprint', '{"scopeFingerprint": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}'),
  ('scope version', '{"scopeVersion": 2}'),
  ('scope quantity', '{"requestedQuantity": 10}'),
  ('scope units', '{"declaredModelUnits": "millimeter"}'),
  ('task', '{"workQueueTaskId": "00000000-0000-4000-8000-0000000045ff"}'),
  ('lane', '{"quoteRequestLaneId": "00000000-0000-4000-8000-0000000045ff"}'),
  ('permit', '{"permitId": "00000000-0000-4000-8000-0000000045ff"}'),
  ('approval reference', '{"approvalReference": "00000000-0000-4000-8000-0000000045ff"}'),
  ('session binding', '{"sessionBindingId": "lease:00000000-0000-4000-8000-0000000045ff"}'),
  ('rollout revision', '{"rolloutRevision": 4}'),
  ('expiry extension', '{"expiresAt": "2026-10-04T12:15:00.000Z"}');

select is(
  (select count(distinct pg_temp.fingerprint(pg_temp.golden(set_value))) from ovd458_substitutions),
  24::bigint,
  'all 24 fixture substitutions produce distinct envelope fingerprints'
);
select ok(
  not exists (
    select 1 from ovd458_substitutions
    where pg_temp.fingerprint(pg_temp.golden(set_value)) = 'f3e0cb1f9139b856112db3692bb4b7c83296b98d71cc9f26326e1be8fcfce4cb'
  ),
  'no fixture substitution reproduces the golden fingerprint'
);

-- Catalog, grant, RLS, and append-only boundaries.
select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity) from pg_catalog.pg_class
    where oid in ('private.provider_dispatch_permits'::regclass,
      'private.provider_dispatch_permit_revocations'::regclass,
      'private.provider_dispatch_envelope_reviews'::regclass)),
  'all three generic dispatch tables enable and force row level security'
);
select ok(
  not exists (
    select 1
    from (values ('private.provider_dispatch_permits'), ('private.provider_dispatch_permit_revocations'),
      ('private.provider_dispatch_envelope_reviews')) as t(name)
    cross join (values ('anon'), ('authenticated'), ('service_role')) as r(role)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilege)
    where pg_catalog.has_table_privilege(r.role, t.name, p.privilege)
  ),
  'no client or service role holds any table privilege on generic permit evidence'
);
select ok(
  not exists (
    select 1 from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace ns on ns.oid = proc.pronamespace
    where proc.proname in (
        'build_provider_dispatch_envelope', 'resolve_provider_dispatch_scope',
        'api_get_provider_dispatch_scope', 'api_request_provider_dispatch',
        'revoke_provider_dispatch_permit', 'resolve_provider_dispatch_permit_state',
        'guard_provider_dispatch_envelope_review_mutation'
      )
      and (proc.proconfig is null or not ('search_path=pg_catalog' = any(proc.proconfig)))
  ),
  'every new function pins search_path to pg_catalog'
);
select ok(
  not exists (
    select 1 from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace ns on ns.oid = proc.pronamespace
    cross join (values ('public'), ('anon')) as r(role)
    where proc.proname in (
        'build_provider_dispatch_envelope', 'resolve_provider_dispatch_scope',
        'api_get_provider_dispatch_scope', 'api_request_provider_dispatch',
        'revoke_provider_dispatch_permit', 'resolve_provider_dispatch_permit_state'
      )
      and (
        (r.role = 'public' and pg_catalog.has_function_privilege('public', proc.oid, 'EXECUTE'))
        or (r.role = 'anon' and pg_catalog.has_function_privilege('anon', proc.oid, 'EXECUTE'))
      )
  ),
  'PUBLIC and anon cannot execute any generic dispatch function'
);
select ok(
  pg_catalog.has_function_privilege('authenticated',
    'public.api_get_provider_dispatch_scope(uuid, public.vendor_name, text)', 'EXECUTE')
  and pg_catalog.has_function_privilege('authenticated',
    'public.api_request_provider_dispatch(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('service_role',
    'public.api_request_provider_dispatch(uuid, public.vendor_name, text, text, text, text, uuid, boolean, boolean, boolean)', 'EXECUTE'),
  'only authenticated job editors reach the public preview and request RPCs'
);
select ok(
  not pg_catalog.has_function_privilege('authenticated', 'private.resolve_provider_dispatch_scope(uuid, public.vendor_name, text)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('service_role', 'private.resolve_provider_dispatch_scope(uuid, public.vendor_name, text)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('authenticated', 'private.revoke_provider_dispatch_permit(uuid, text)', 'EXECUTE')
  and pg_catalog.has_function_privilege('service_role', 'private.revoke_provider_dispatch_permit(uuid, text)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('authenticated', 'private.resolve_provider_dispatch_permit_state(uuid)', 'EXECUTE')
  and pg_catalog.has_function_privilege('service_role', 'private.resolve_provider_dispatch_permit_state(uuid)', 'EXECUTE'),
  'private resolvers are definer-only; revocation and permit state are service_role only'
);
select is(
  (select count(*) from private.provider_dispatch_envelope_reviews),
  0::bigint,
  'no provider has a reviewed generic envelope by default'
);
select is(
  (select count(*) from private.quote_provider_admission_policies where generic_dispatch_enabled),
  0::bigint,
  'no provider is generically dispatchable by default'
);

-- Synthetic tenant: one fictiv-only organization with a STEP + PDF part.
create temporary table ovd458_context (
  user_id uuid not null,
  organization_id uuid not null,
  job_id uuid not null,
  part_id uuid not null,
  approval_reference uuid not null,
  scope_fingerprint text,
  permit_id uuid
) on commit drop;
insert into ovd458_context values (
  '00000000-0000-4000-8000-000000004581', '00000000-0000-4000-8000-000000004582',
  '00000000-0000-4000-8000-000000004583', '00000000-0000-4000-8000-000000004584',
  '00000000-0000-4000-8000-000000004589', null, null
);
grant select, update on ovd458_context to authenticated;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-000000004581', 'authenticated', 'authenticated', 'ovd458-member@example.test', now()),
  ('00000000-0000-4000-8000-000000004591', 'authenticated', 'authenticated', 'ovd458-outsider@example.test', now());
insert into public.organizations (id, name, slug) values
  ('00000000-0000-4000-8000-000000004582', 'OVD 458 Generic', 'ovd-458-generic'),
  ('00000000-0000-4000-8000-000000004592', 'OVD 458 Outsider', 'ovd-458-outsider');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-000000004582', '00000000-0000-4000-8000-000000004581', 'client'),
  ('00000000-0000-4000-8000-000000004592', '00000000-0000-4000-8000-000000004591', 'client');

update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id = '00000000-0000-4000-8000-000000004582';
insert into private.sourcing_destination_history (organization_id, state, address)
values ('00000000-0000-4000-8000-000000004582', 'confirmed',
  private.effective_sourcing_address('00000000-0000-4000-8000-000000004582'));
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
) values ('00000000-0000-4000-8000-000000004582', 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'OVD-458 fixture', '00000000-0000-4000-8000-000000004581');
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values ('00000000-0000-4000-8000-000000004582', '00000000-0000-4000-8000-000000004581', 'grant',
  'OVD-458 fixture', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy', 'ovd458-grant');
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
values ('00000000-0000-4000-8000-000000004582', '00000000-0000-4000-8000-000000004581',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy');
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values ('00000000-0000-4000-8000-000000004582', 'fictiv', true);
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-458 local pgTAP fixture'
where capability = 'automatic_quote_collection';

insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
values ('00000000-0000-4000-8000-000000004583', '00000000-0000-4000-8000-000000004582',
  '00000000-0000-4000-8000-000000004581', 'OVD-458 generic part', 'ready_to_quote',
  array['manufacturing_quote'], 'manufacturing_quote');
insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
) values
  ('00000000-0000-4000-8000-000000004585', '00000000-0000-4000-8000-000000004582', repeat('1', 64), repeat('1', 64),
   'job-files', 'ovd458/part.step', 100, 'application/step'),
  ('00000000-0000-4000-8000-000000004587', '00000000-0000-4000-8000-000000004582', repeat('2', 64), repeat('2', 64),
   'job-files', 'ovd458/drawing.pdf', 100, 'application/pdf');
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
) values
  ('00000000-0000-4000-8000-000000004586', '00000000-0000-4000-8000-000000004583',
   '00000000-0000-4000-8000-000000004582', '00000000-0000-4000-8000-000000004581',
   '00000000-0000-4000-8000-000000004585', repeat('1', 64), repeat('1', 64), 'job-files',
   'ovd458/part.step', 'part.step', 'part', 'cad', 'application/step', 100),
  ('00000000-0000-4000-8000-000000004588', '00000000-0000-4000-8000-000000004583',
   '00000000-0000-4000-8000-000000004582', '00000000-0000-4000-8000-000000004581',
   '00000000-0000-4000-8000-000000004587', repeat('2', 64), repeat('2', 64), 'job-files',
   'ovd458/drawing.pdf', 'drawing.pdf', 'drawing', 'drawing', 'application/pdf', 100);
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id, quantity)
values ('00000000-0000-4000-8000-000000004584', '00000000-0000-4000-8000-000000004583',
  '00000000-0000-4000-8000-000000004582', 'Generic part', 'generic-part',
  '00000000-0000-4000-8000-000000004586', '00000000-0000-4000-8000-000000004588', 1);
insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
  quote_quantities, applicable_vendors, spec_snapshot
) values ('00000000-0000-4000-8000-000000004584', '00000000-0000-4000-8000-000000004582',
  '00000000-0000-4000-8000-000000004581', '7075-T6 Aluminum', 'Anodized', 0.002, 5, array[5],
  array['fictiv']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb);

create function pg_temp.preview(p_provider text default 'fictiv', p_units text default 'inch')
returns jsonb
language sql
set search_path = pg_catalog
as $$
  select public.api_get_provider_dispatch_scope(
    (select job_id from ovd458_context), p_provider::public.vendor_name, p_units
  );
$$;

create function pg_temp.request(p_overrides jsonb default '{}'::jsonb)
returns jsonb
language sql
set search_path = pg_catalog
as $$
  select public.api_request_provider_dispatch(
    coalesce((p_overrides ->> 'jobId')::uuid, (select job_id from ovd458_context)),
    coalesce(p_overrides ->> 'provider', 'fictiv')::public.vendor_name,
    coalesce(p_overrides ->> 'units', 'inch'),
    coalesce(p_overrides ->> 'fingerprint', (select scope_fingerprint from ovd458_context)),
    coalesce(p_overrides ->> 'notice', 'founding-beta-2026-08-15'),
    coalesce(p_overrides ->> 'envelope', 'fictiv-quote-envelope.v1'),
    coalesce((p_overrides ->> 'approvalReference')::uuid, (select approval_reference from ovd458_context)),
    coalesce((p_overrides ->> 'authorityToShare')::boolean, true),
    coalesce((p_overrides ->> 'nonExportControlled')::boolean, true),
    coalesce((p_overrides ->> 'quoteOnly')::boolean, true)
  );
$$;

create function pg_temp.lane_count()
returns bigint
language sql
security definer
set search_path = pg_catalog
as $$
  select (select count(*) from public.quote_requests where job_id = '00000000-0000-4000-8000-000000004583')
    + (select count(*) from public.work_queue where job_id = '00000000-0000-4000-8000-000000004583')
    + (select count(*) from private.provider_dispatch_permits where job_id = '00000000-0000-4000-8000-000000004583');
$$;

-- Re-mints a valid copy of a stored permit (new identity, approval reference,
-- lane, task, binding, and lifetime) with a correctly rebuilt envelope.
create function pg_temp.clone_permit(p_source uuid, p_reference uuid, p_issued_at timestamptz, p_expires_at timestamptz)
returns uuid
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_row private.provider_dispatch_permits%rowtype;
begin
  select permit.* into strict v_row from private.provider_dispatch_permits permit where permit.id = p_source;
  v_row.id := gen_random_uuid();
  v_row.approval_reference := p_reference;
  v_row.quote_request_lane_id := gen_random_uuid();
  v_row.work_queue_task_id := gen_random_uuid();
  v_row.session_binding_id := 'lease:' || v_row.id::text;
  v_row.issued_at := p_issued_at;
  v_row.expires_at := p_expires_at;
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
  v_row.envelope_fingerprint := pg_temp.fingerprint(v_row.envelope);
  insert into private.provider_dispatch_permits values (v_row.*);
  return v_row.id;
end;
$$;

-- Default-off: the registry is the rollback switch and starts disabled.
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_admission_disabled',
  'a provider disabled in the admission registry has no generic preview');
select throws_ok($$select pg_temp.request('{"fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')$$,
  'P0001', 'provider_dispatch_admission_disabled',
  'a provider disabled in the admission registry cannot mint a generic permit');

reset role;
update private.quote_provider_admission_policies
set admission_state = 'approved', generic_dispatch_enabled = true,
  policy_revision = 'fictiv-generic-2026-10-03.v1', evidence_reference = 'OVD-458',
  permission_basis = 'written_provider_authorization',
  supported_processes = array['cnc_milling']::public.process_types[],
  accepted_file_extensions = array['step', 'stp', 'pdf'], session_owner = 'overdrafter_managed',
  reviewed_by = '00000000-0000-4000-8000-000000004581', reviewed_at = now() - interval '1 day',
  expires_at = null, change_reason = 'approval_recorded'
where provider = 'fictiv';

set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_provider_envelope_unknown',
  'generic admission without a reviewed envelope still fails closed');

reset role;
insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
values ('fictiv', 'fictiv-quote-envelope', 1, 'OVD-458', 900);
select throws_ok(
  $$insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
    values ('xometry', 'xometry-generic-envelope', 1, 'OVD-458', 900)$$,
  '23514', null, 'Xometry cannot receive a generic reviewed envelope');
select throws_ok(
  $$insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
    values ('protolabs', 'fictiv-quote-envelope', 1, 'OVD-458', 900)$$,
  '23514', null, 'a reviewed envelope id must name its own provider');
select throws_ok(
  $$update private.provider_dispatch_envelope_reviews set permit_ttl_seconds = 86400 where provider = 'fictiv'$$,
  'P0001', 'Reviewed provider dispatch envelopes can only be withdrawn.',
  'reviewed envelope terms are immutable');

-- Preview gates.
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004591');
select throws_ok($$select pg_temp.preview()$$, 'P0001',
  'You do not have permission to request quotes for job 00000000-0000-4000-8000-000000004583.',
  'another organization cannot preview the generic scope');
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview('fictiv', 'meter')$$, 'P0001',
  'Declared model units must be inch or millimeter.', 'unsupported model units fail closed');

reset role;
update public.approved_part_requirements set spec_snapshot = '{"process":"laser cutting"}'
where part_id = '00000000-0000-4000-8000-000000004584';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_process_not_admitted',
  'a process outside the admitted provider envelope fails closed');

reset role;
update public.approved_part_requirements set spec_snapshot = '{"process":"CNC milling","notes":"deburr"}'
where part_id = '00000000-0000-4000-8000-000000004584';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_special_requirements_not_supported',
  'free-text special requirements fail closed');

reset role;
update public.approved_part_requirements set spec_snapshot = '{"process":"CNC milling"}',
  applicable_vendors = array['protolabs']::public.vendor_name[]
where part_id = '00000000-0000-4000-8000-000000004584';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_provider_applicability_required',
  'approved requirements must name the provider');

reset role;
update public.approved_part_requirements set applicable_vendors = array['fictiv']::public.vendor_name[]
where part_id = '00000000-0000-4000-8000-000000004584';
update private.quote_provider_admission_policies
set accepted_file_extensions = array['step', 'stp'], policy_revision = 'fictiv-generic-2026-10-03.v2',
  change_reason = 'policy_updated'
where provider = 'fictiv';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_drawing_not_admitted',
  'a drawing outside the admitted file envelope fails closed');

reset role;
update private.quote_provider_admission_policies
set accepted_file_extensions = array['pdf'], policy_revision = 'fictiv-generic-2026-10-03.v3',
  change_reason = 'policy_updated'
where provider = 'fictiv';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_trusted_cad_required',
  'a CAD file outside the admitted file envelope fails closed');

reset role;
update private.quote_provider_admission_policies
set accepted_file_extensions = array['step', 'stp', 'pdf'], policy_revision = 'fictiv-generic-2026-10-03.v4',
  change_reason = 'policy_updated'
where provider = 'fictiv';
update public.job_files set trusted_content_sha256 = null where id = '00000000-0000-4000-8000-000000004586';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_trusted_cad_required',
  'an unverified CAD hash fails closed');

reset role;
update public.job_files set trusted_content_sha256 = repeat('1', 64) where id = '00000000-0000-4000-8000-000000004586';
update public.jobs set requested_service_kinds = array['manufacturing_quote', 'dfm_review']
where id = '00000000-0000-4000-8000-000000004583';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_manufacturing_quote_only',
  'non-quote services are outside the generic envelope');

reset role;
update public.jobs set requested_service_kinds = array['manufacturing_quote']
where id = '00000000-0000-4000-8000-000000004583';
update public.approved_part_requirements set quote_quantities = array[5, 10]
where part_id = '00000000-0000-4000-8000-000000004584';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_exact_scope_required',
  'one permit binds exactly one quantity lane');

reset role;
update public.approved_part_requirements set quote_quantities = array[5]
where part_id = '00000000-0000-4000-8000-000000004584';
update public.org_vendor_configs set enabled_for_client_quote_requests = false
where organization_id = '00000000-0000-4000-8000-000000004582' and vendor = 'fictiv';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_provider_not_enabled',
  'the organization must enable the exact provider');

reset role;
update public.org_vendor_configs set enabled_for_client_quote_requests = true
where organization_id = '00000000-0000-4000-8000-000000004582' and vendor = 'fictiv';
savepoint ovd458_no_entitlement;
delete from private.organization_entitlement_grants
where organization_id = '00000000-0000-4000-8000-000000004582';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_free_policy_unavailable',
  'without a commercial entitlement the generic path fails closed');
reset role;
rollback to savepoint ovd458_no_entitlement;

update private.commercial_rollout_controls set enabled = false, revision = revision + 1,
  change_reason = 'OVD-458 rollout off'
where capability = 'automatic_quote_collection';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_automatic_quote_disabled',
  'the automatic-quote rollout control remains authoritative');

reset role;
update private.commercial_rollout_controls set enabled = true, revision = revision + 1,
  change_reason = 'OVD-458 rollout on'
where capability = 'automatic_quote_collection';
savepoint ovd458_beta_revoked;
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values ('00000000-0000-4000-8000-000000004582', '00000000-0000-4000-8000-000000004581', 'revoke',
  'OVD-458 fixture', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy', 'ovd458-revoke');
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_beta_access_required',
  'revoked Founding Beta enrollment fails closed');
reset role;
rollback to savepoint ovd458_beta_revoked;

savepoint ovd458_admission_expired;
update private.quote_provider_admission_policies
set expires_at = now() - interval '1 minute', reviewed_at = now() - interval '2 days',
  policy_revision = 'fictiv-generic-2026-10-03.v5', change_reason = 'policy_expired'
where provider = 'fictiv';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_admission_expired',
  'an expired admission policy fails closed');
reset role;
rollback to savepoint ovd458_admission_expired;

-- Successful preview: client-safe keys only.
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
update ovd458_context set scope_fingerprint = pg_temp.preview() ->> 'scopeFingerprint';
select matches((select scope_fingerprint from ovd458_context), '^[a-f0-9]{64}$',
  'the generic preview returns the server-computed scope fingerprint');
select is(
  (select array_agg(key order by key) from jsonb_object_keys(pg_temp.preview()) key),
  array['declaredModelUnits', 'envelopeRevision', 'jobId', 'noticeRevision', 'organizationId', 'partId',
    'provider', 'requestedQuantity', 'schema', 'scope', 'scopeFingerprint', 'scopeVersion'],
  'the preview exposes no admission evidence, rollout revision, or permit TTL'
);
select is(pg_temp.preview() ->> 'envelopeRevision', 'fictiv-quote-envelope.v1',
  'the preview binds the active reviewed envelope revision');

-- Request denials create zero rows. They run as the authenticated API role.
select is(current_user::text, 'authenticated', 'request denials execute as the authenticated role with JWT claims');
select throws_ok($$select pg_temp.request('{"authorityToShare": false}')$$, 'P0001',
  'provider_dispatch_affirmations_required', 'authority to share is required');
select throws_ok($$select pg_temp.request('{"nonExportControlled": false}')$$, 'P0001',
  'provider_dispatch_affirmations_required', 'the export-control affirmation is required');
select throws_ok($$select pg_temp.request('{"quoteOnly": false}')$$, 'P0001',
  'provider_dispatch_affirmations_required', 'the quote-only affirmation is required');
select throws_ok($$select public.api_request_provider_dispatch((select job_id from ovd458_context), 'fictiv', 'inch',
    (select scope_fingerprint from ovd458_context), 'founding-beta-2026-08-15', 'fictiv-quote-envelope.v1',
    null, true, true, true)$$, 'P0001',
  'provider_dispatch_approval_reference_required', 'an approval reference is required');
select throws_ok($$select pg_temp.request('{"fingerprint": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}')$$, 'P0001',
  'provider_dispatch_scope_mismatch', 'a stale or substituted scope fingerprint fails closed');
select throws_ok($$select pg_temp.request('{"notice": "founding-beta-2026-09-01"}')$$, 'P0001',
  'provider_dispatch_notice_mismatch', 'a stale notice revision fails closed');
select throws_ok($$select pg_temp.request('{"envelope": "fictiv-quote-envelope.v2"}')$$, 'P0001',
  'provider_dispatch_envelope_mismatch', 'an unreviewed envelope revision fails closed');
select throws_ok($$select pg_temp.request('{"provider": "protolabs", "envelope": "protolabs-quote-envelope.v1"}')$$, 'P0001',
  'provider_dispatch_admission_disabled', 'a cross-provider request against a disabled provider fails closed');
select pg_temp.as_user('00000000-0000-4000-8000-000000004591');
select throws_ok($$select pg_temp.request()$$, 'P0001',
  'You do not have permission to request quotes for job 00000000-0000-4000-8000-000000004583.',
  'another organization cannot request the generic dispatch');
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select is(pg_temp.lane_count(), 0::bigint, 'every denied request left zero request, task, or permit rows');

-- Legacy and client bypasses create zero runnable provider work.
select is(
  public.api_request_quote_scoped((select job_id from ovd458_context), array['fictiv']::public.vendor_name[]) ->> 'reasonCode',
  'dispatch_confirmation_required',
  'the legacy scoped request route still returns confirmation-required for a generic provider'
);
select is(
  public.api_request_quote((select job_id from ovd458_context)) ->> 'reasonCode',
  'dispatch_confirmation_required',
  'the legacy request route still returns confirmation-required'
);
select is(pg_temp.lane_count(), 0::bigint, 'legacy bypass routes created no runnable provider work');

-- Failure injection: a failure after the lane/task insert rolls everything back.
reset role;
create function public.ovd458_fail_permit()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'ovd458_injected_permit_failure';
end;
$$;
create trigger ovd458_fail_permit before insert on private.provider_dispatch_permits
for each row execute function public.ovd458_fail_permit();
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.request()$$, 'P0001', 'ovd458_injected_permit_failure',
  'an injected permit failure aborts the request');
select is(pg_temp.lane_count(), 0::bigint, 'the aborted request left no partial lifecycle, task, or permit rows');
reset role;
drop trigger ovd458_fail_permit on private.provider_dispatch_permits;

-- Atomic success.
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
update ovd458_context set permit_id = (pg_temp.request() ->> 'permitId')::uuid;
select isnt((select permit_id from ovd458_context), null, 'an exact admitted request returns a permit');
select is(pg_temp.lane_count(), 3::bigint, 'one request, one task, and one permit were created together');

reset role;
select is(
  (select count(*) from public.quote_request_lanes lane
    join private.provider_dispatch_permits permit on permit.quote_request_lane_id = lane.id
    join public.work_queue task on task.id = permit.work_queue_task_id
    where permit.id = (select permit_id from ovd458_context)
      and lane.vendor = 'fictiv' and task.payload ->> 'vendor' = 'fictiv'
      and lane.scope_fingerprint = permit.scope_fingerprint
      and task.payload ->> 'providerDispatchPermitId' = permit.id::text
      and task.payload ->> 'providerDispatchEnvelopeFingerprint' = permit.envelope_fingerprint
      and task.payload ->> 'quoteLaneScopeFingerprint' = permit.scope_fingerprint
      and task.payload ->> 'vendorQuoteResultId' = permit.vendor_quote_result_id::text
      and lane.vendor_quote_result_id = permit.vendor_quote_result_id
      and lane.quote_run_id = permit.quote_run_id),
  1::bigint,
  'the permit binds exactly its own lane, result, run, and task'
);
select ok(
  (select permit.canonical_envelope = permit.envelope::text
      and permit.envelope_fingerprint = pg_temp.fingerprint(permit.envelope)
      and permit.session_binding_id = 'lease:' || permit.id::text
      and permit.envelope ->> 'sessionBindingId' = permit.session_binding_id
      and permit.expires_at - permit.issued_at = interval '900 seconds'
      and permit.envelope ->> 'issuedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      and permit.admission_policy_revision = 'fictiv-generic-2026-10-03.v4'
      and permit.admission_evidence_reference = 'OVD-458'
      and permit.actor_user_id = '00000000-0000-4000-8000-000000004581'
      and permit.envelope -> 'sourceFiles' -> 0 ->> 'role' = 'cad'
      and permit.envelope -> 'sourceFiles' -> 1 ->> 'role' = 'drawing'
      and permit.cad_sha256 = repeat('1', 64)
      and permit.drawing_sha256 = repeat('2', 64)
      and permit.rollout_revision = (select revision from private.commercial_rollout_controls
        where capability = 'automatic_quote_collection')
   from private.provider_dispatch_permits permit where permit.id = (select permit_id from ovd458_context)),
  'the stored envelope is canonical and binds admission, rollout, files, session, and expiry'
);
select is(
  (select private.resolve_provider_dispatch_permit_state(permit_id) from ovd458_context),
  'active', 'a new permit is active'
);
select is(private.resolve_provider_dispatch_permit_state('00000000-0000-4000-8000-0000000045ff'), null,
  'a missing permit has no state');

-- Stored evidence is append-only and self-verifying.
select throws_ok(
  $$update private.provider_dispatch_permits set expires_at = expires_at + interval '1 day'$$,
  'P0001', 'Founding Beta evidence is append-only.', 'permits cannot be extended in place');
select throws_ok(
  $$delete from private.provider_dispatch_permits$$,
  'P0001', 'Founding Beta evidence is append-only.', 'permits cannot be deleted');
select throws_ok(
  $$insert into private.provider_dispatch_permits
    select (jsonb_populate_record(null::private.provider_dispatch_permits,
      to_jsonb(permit) || jsonb_build_object('id', fresh.id, 'approval_reference', gen_random_uuid(),
        'quote_request_lane_id', gen_random_uuid(), 'work_queue_task_id', gen_random_uuid(),
        'session_binding_id', 'lease:' || fresh.id::text))).*
    from private.provider_dispatch_permits permit
    cross join (select gen_random_uuid() as id) fresh$$,
  '23514',
  'new row for relation "provider_dispatch_permits" violates check constraint "provider_dispatch_permits_envelope_check"',
  'a copied envelope cannot be rebound to different identities');
select throws_ok(
  $$insert into private.provider_dispatch_permits
    select (jsonb_populate_record(null::private.provider_dispatch_permits,
      to_jsonb(permit) || jsonb_build_object('envelope_fingerprint', repeat('0', 64)))).*
    from private.provider_dispatch_permits permit$$,
  '23514',
  'new row for relation "provider_dispatch_permits" violates check constraint "provider_dispatch_permits_fingerprint_check"',
  'a fingerprint that does not hash the canonical text is rejected');

-- Replay semantics.
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select ok(
  (select result ->> 'permitId' = (select permit_id::text from ovd458_context)
      and (result ->> 'deduplicated')::boolean and not (result ->> 'created')::boolean
   from (select pg_temp.request() as result) replay),
  'an exact serial replay returns the same permit without new work'
);
select throws_ok($$select pg_temp.request('{"units": "millimeter"}')$$, 'P0001',
  'provider_dispatch_approval_reference_reused', 'a conflicting replay of the approval reference is rejected');
select throws_ok($$select pg_temp.request('{"approvalReference": "00000000-0000-4000-8000-00000000458a"}')$$, 'P0001',
  'provider_dispatch_new_lane_required', 'a new approval for an already-active lane creates no duplicate work');
select is(pg_temp.lane_count(), 3::bigint, 'replays and conflicts created no additional rows');

-- A replay re-runs every fresh-path gate before acknowledging.
reset role;
savepoint ovd458_replay_rollout_off;
update private.commercial_rollout_controls set enabled = false, revision = revision + 1,
  change_reason = 'OVD-458 replay recheck'
where capability = 'automatic_quote_collection';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.request()$$, 'P0001', 'provider_dispatch_automatic_quote_disabled',
  'an exact replay after the rollout is disabled is refused, not acknowledged');
reset role;
rollback to savepoint ovd458_replay_rollout_off;

-- An expired permit is neither replayable nor active.
create temporary table ovd458_expired (permit_id uuid not null) on commit drop;
grant select on ovd458_expired to authenticated;
insert into ovd458_expired
select pg_temp.clone_permit(permit_id, '00000000-0000-4000-8000-00000000458b',
  now() - interval '2 hours', now() - interval '1 hour')
from ovd458_context;
select is(
  (select private.resolve_provider_dispatch_permit_state(permit_id) from ovd458_expired),
  'expired', 'a permit past its expiry reports expired, not active');
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.request('{"approvalReference": "00000000-0000-4000-8000-00000000458b"}')$$,
  'P0001', 'provider_dispatch_permit_expired', 'an exact replay of an expired permit is refused');
reset role;

-- Revocation.
reset role;
select is(
  (select private.revoke_provider_dispatch_permit(permit_id, 'operator_revoked') ->> 'permitState' from ovd458_context),
  'revoked', 'service revocation records a revoked state');
select is(
  (select private.revoke_provider_dispatch_permit(permit_id, 'security_incident') ->> 'reason' from ovd458_context),
  'operator_revoked', 'revocation is idempotent and keeps the first reason');
select is(
  (select private.resolve_provider_dispatch_permit_state(permit_id) from ovd458_context),
  'revoked', 'the permit state reports revocation');
select throws_ok($$delete from private.provider_dispatch_permit_revocations$$, 'P0001',
  'Founding Beta evidence is append-only.', 'revocations cannot be removed');
select throws_ok($$select private.revoke_provider_dispatch_permit('00000000-0000-4000-8000-0000000045ff', 'operator_revoked')$$,
  'P0001', 'provider_dispatch_permit_not_found', 'revoking an unknown permit fails');
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.request()$$, 'P0001', 'provider_dispatch_permit_revoked',
  'a replay of a revoked permit is refused');

-- Rollback switch: disabling the registry stops generic work without touching Xometry.
reset role;
update private.quote_provider_admission_policies
set generic_dispatch_enabled = false, policy_revision = 'fictiv-generic-2026-10-03.v6', change_reason = 'policy_disabled'
where provider = 'fictiv';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_admission_disabled',
  'the registry rollback switch disables the generic preview');
reset role;
update private.quote_provider_admission_policies
set generic_dispatch_enabled = true, policy_revision = 'fictiv-generic-2026-10-03.v7', change_reason = 'policy_reinstated'
where provider = 'fictiv';
update private.provider_dispatch_envelope_reviews set withdrawn_at = now() where provider = 'fictiv';
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select throws_ok($$select pg_temp.preview()$$, 'P0001', 'provider_dispatch_provider_envelope_unknown',
  'withdrawing the reviewed envelope also disables the generic path');

-- Xometry compatibility: the generic entry points delegate to the unchanged
-- legacy functions and never write generic evidence.
reset role;
insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-000000004593', 'OVD 458 Xometry', 'ovd-458-xometry');
insert into public.organization_memberships (organization_id, user_id, role)
values ('00000000-0000-4000-8000-000000004593', '00000000-0000-4000-8000-000000004581', 'client');
update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id = '00000000-0000-4000-8000-000000004593';
insert into private.sourcing_destination_history (organization_id, state, address)
values ('00000000-0000-4000-8000-000000004593', 'confirmed',
  private.effective_sourcing_address('00000000-0000-4000-8000-000000004593'));
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
) values ('00000000-0000-4000-8000-000000004593', 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'OVD-458 Xometry fixture', '00000000-0000-4000-8000-000000004581');
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values ('00000000-0000-4000-8000-000000004593', '00000000-0000-4000-8000-000000004581', 'grant',
  'OVD-458 Xometry fixture', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy', 'ovd458-xometry-grant');
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
values ('00000000-0000-4000-8000-000000004593', '00000000-0000-4000-8000-000000004581',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy');
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values ('00000000-0000-4000-8000-000000004593', 'xometry', true);
insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
values ('00000000-0000-4000-8000-000000004594', '00000000-0000-4000-8000-000000004593',
  '00000000-0000-4000-8000-000000004581', 'OVD-458 Xometry part', 'ready_to_quote',
  array['manufacturing_quote'], 'manufacturing_quote');
insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
) values ('00000000-0000-4000-8000-000000004595', '00000000-0000-4000-8000-000000004593', repeat('3', 64),
  repeat('3', 64), 'job-files', 'ovd458/xometry.step', 100, 'application/step');
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
) values ('00000000-0000-4000-8000-000000004596', '00000000-0000-4000-8000-000000004594',
  '00000000-0000-4000-8000-000000004593', '00000000-0000-4000-8000-000000004581',
  '00000000-0000-4000-8000-000000004595', repeat('3', 64), repeat('3', 64), 'job-files',
  'ovd458/xometry.step', 'xometry.step', 'xometry', 'cad', 'application/step', 100);
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
values ('00000000-0000-4000-8000-000000004597', '00000000-0000-4000-8000-000000004594',
  '00000000-0000-4000-8000-000000004593', 'Xometry part', 'xometry-part',
  '00000000-0000-4000-8000-000000004596', 1);
insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
  quote_quantities, applicable_vendors, spec_snapshot
) values ('00000000-0000-4000-8000-000000004597', '00000000-0000-4000-8000-000000004593',
  '00000000-0000-4000-8000-000000004581', '6061-T6 Aluminum', 'As machined', 0.0050, 1, array[1],
  array['xometry']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb);

set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000004581');
select is(
  public.api_get_provider_dispatch_scope('00000000-0000-4000-8000-000000004594', 'xometry', 'inch'),
  public.api_get_xometry_beta_dispatch_scope('00000000-0000-4000-8000-000000004594', 'inch'),
  'the generic preview returns the legacy Xometry preview verbatim'
);
select throws_ok(
  $$select public.api_request_provider_dispatch('00000000-0000-4000-8000-000000004594', 'xometry', 'inch',
    public.api_get_xometry_beta_dispatch_scope('00000000-0000-4000-8000-000000004594', 'inch') ->> 'scopeFingerprint',
    'founding-beta-2026-08-15', 'fictiv-quote-envelope.v1', '00000000-0000-4000-8000-00000000459a', true, true, true)$$,
  'P0001', 'provider_dispatch_envelope_mismatch',
  'the Xometry branch requires the legacy controlled-beta envelope revision');
select throws_ok(
  $$select public.api_request_provider_dispatch('00000000-0000-4000-8000-000000004594', 'xometry', 'inch',
    public.api_get_xometry_beta_dispatch_scope('00000000-0000-4000-8000-000000004594', 'inch') ->> 'scopeFingerprint',
    'founding-beta-2026-08-15', 'xometry-controlled-beta-envelope.v1', '00000000-0000-4000-8000-00000000459a', false, true, true)$$,
  'P0001', 'All Xometry beta dispatch affirmations are required.',
  'the Xometry branch surfaces the legacy denial text unchanged');
select ok(
  (select (result ->> 'created')::boolean and result ->> 'envelopeRevision' = 'xometry-controlled-beta-envelope.v1'
   from (select public.api_request_provider_dispatch('00000000-0000-4000-8000-000000004594', 'xometry', 'inch',
     public.api_get_xometry_beta_dispatch_scope('00000000-0000-4000-8000-000000004594', 'inch') ->> 'scopeFingerprint',
     'founding-beta-2026-08-15', 'xometry-controlled-beta-envelope.v1', '00000000-0000-4000-8000-00000000459a',
     true, true, true) as result) xometry),
  'the generic RPC delegates Xometry to the legacy transaction while the generic path is rolled back'
);
reset role;
select ok(
  (select count(*) = 1 from private.xometry_beta_dispatch_permits
    where approval_reference = '00000000-0000-4000-8000-00000000459a')
  and not exists (select 1 from private.provider_dispatch_permits
    where organization_id = '00000000-0000-4000-8000-000000004593')
  and exists (select 1 from public.work_queue
    where job_id = '00000000-0000-4000-8000-000000004594'
      and payload ->> 'xometryBetaEnvelopeRevision' = 'xometry-controlled-beta-envelope.v1'
      and not payload ? 'providerDispatchPermitId'),
  'the Xometry path writes only the legacy permit and legacy task payload keys'
);
-- Generic first, then Xometry: the legacy table refuses the same organization
-- and approval reference, while an unrelated reference is still accepted.
create temporary table ovd458_legacy_copy on commit drop as
select to_jsonb(legacy) as row_value from private.xometry_beta_dispatch_permits legacy
where legacy.approval_reference = '00000000-0000-4000-8000-00000000459a';
select throws_ok(
  $$insert into private.xometry_beta_dispatch_permits
    select (jsonb_populate_record(null::private.xometry_beta_dispatch_permits,
      row_value || jsonb_build_object('id', gen_random_uuid(),
        'organization_id', (select organization_id from ovd458_context),
        'approval_reference', (select approval_reference from ovd458_context),
        'quote_request_lane_id', gen_random_uuid(), 'work_queue_task_id', gen_random_uuid()))).*
    from ovd458_legacy_copy$$,
  'P0001', 'xometry_beta_approval_reference_reused',
  'a Xometry permit cannot reuse an approval reference already bound to a generic permit');
savepoint ovd458_legacy_control;
select lives_ok(
  $$insert into private.xometry_beta_dispatch_permits
    select (jsonb_populate_record(null::private.xometry_beta_dispatch_permits,
      row_value || jsonb_build_object('id', gen_random_uuid(),
        'organization_id', (select organization_id from ovd458_context),
        'approval_reference', '00000000-0000-4000-8000-00000000459b',
        'quote_request_lane_id', gen_random_uuid(), 'work_queue_task_id', gen_random_uuid()))).*
    from ovd458_legacy_copy$$,
  'the cross-path trigger accepts an unrelated approval reference');
rollback to savepoint ovd458_legacy_control;
select throws_ok(
  $$insert into private.provider_dispatch_permits
    select (jsonb_populate_record(null::private.provider_dispatch_permits,
      to_jsonb(permit) || jsonb_build_object('provider', 'xometry', 'envelope_id', 'xometry-quote-envelope'))).*
    from private.provider_dispatch_permits permit$$,
  '23514', null, 'the generic permit table rejects Xometry rows');

select * from finish();
rollback;
