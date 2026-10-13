begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(45);

-- OVD-762 item 1 is a proposed migration that is intentionally NOT in
-- supabase/migrations yet (it needs a migration window). fixtures/ holds byte
-- copies of docs/migration-drafts/ovd-762-xometry-fanout-scope.sql and its
-- rollback, kept identical by scripts/run-supabase-policy-tests.node-test.mjs.
-- The draft is installed inside this rolled-back transaction only while the
-- marker table is absent. Once promoted, every assertion runs against the real
-- schema. No assertion is skipped in either case.

-- The single provider path must be byte identical before and after the draft.
create temporary table ovd762_single_path_source on commit drop as
select p.oid::regprocedure::text as signature, pg_catalog.md5(p.prosrc) as source_md5
from pg_catalog.pg_proc p
where p.oid in (
  'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)'::regprocedure,
  'public.api_get_xometry_beta_dispatch_scope(uuid,text)'::regprocedure,
  'private.resolve_xometry_beta_dispatch_scope(uuid,text)'::regprocedure,
  'private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid)'::regprocedure
);

select to_regclass('private.xometry_beta_fanout_markers') is null as ovd762_install_draft \gset
\if :ovd762_install_draft
\ir fixtures/ovd762_xometry_fanout_scope.inc
\endif

create function pg_temp.ovd762_identity(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', p_user_id, 'role', 'authenticated', 'aal', 'aal1')::text, -- NOSONAR: repeated authenticated JWT fixture claim
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;
grant execute on function pg_temp.ovd762_identity(uuid) to authenticated;

create temporary table ovd762 (
  user_id uuid not null,
  organization_id uuid not null,
  job_id uuid not null,
  part_id uuid not null,
  confirmation_reference uuid not null,
  fanout_approval_reference uuid not null,
  single_scope_fingerprint text,
  fanout_scope_fingerprint text
) on commit drop;
grant select, update on ovd762 to authenticated;

-- fanout_approval_reference is deriveFanoutApprovalReference(confirmation,
-- 'xometry') from src/features/quotes/provider-fanout-dispatch.ts; the
-- client unit test pins the same vector.
insert into ovd762 values (
  '76200000-0000-4000-8000-000000000001', -- NOSONAR: deterministic fixture identity
  '76200000-0000-4000-8000-000000000010', -- NOSONAR: deterministic fixture identifier
  '76200000-0000-4000-8000-000000000020', -- NOSONAR: deterministic fixture identifier
  '76200000-0000-4000-8000-000000000030', -- NOSONAR: deterministic fixture identifier
  '76200000-0000-4000-8000-000000000101', -- NOSONAR: deterministic fixture identifier
  'baa924a1-8f7d-5229-a543-117c80714c23', -- NOSONAR: deterministic fixture identifier
  null,
  null
);

insert into auth.users (id, aud, role, email, email_confirmed_at)
select user_id, 'authenticated', 'authenticated', 'ovd762-member@example.test', timezone('utc', now())
from ovd762;
insert into public.organizations (id, name, slug)
select organization_id, 'OVD 762 fan out', 'ovd-762-fanout' from ovd762;
insert into public.organization_memberships (organization_id, user_id, role)
select organization_id, user_id, 'client' from ovd762;

update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id = (select organization_id from ovd762);
insert into private.sourcing_destination_history (organization_id, state, address)
select organization_id, 'confirmed', private.effective_sourcing_address(organization_id) from ovd762;

update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-762 local pgTAP fixture'
where capability = 'automatic_quote_collection'; -- NOSONAR: canonical rollout capability fixture

insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
select job_id, organization_id, user_id, 'OVD-762 fan out part', 'ready_to_quote',
  array['manufacturing_quote'], 'manufacturing_quote' -- NOSONAR: deterministic quote-envelope fixture
from ovd762;

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
)
select '76200000-0000-4000-8000-000000000040', organization_id, repeat('b', 64), repeat('b', 64), 'job-files', -- NOSONAR: deterministic trusted-file fixture
  organization_id::text || '/sha256/' || repeat('b', 64) || '/part.step', 100, 'application/step'
from ovd762;
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
)
select '76200000-0000-4000-8000-000000000041', job_id, organization_id, user_id, -- NOSONAR: deterministic fixture identifier
  '76200000-0000-4000-8000-000000000040', repeat('b', 64), repeat('b', 64), 'job-files',
  organization_id::text || '/sha256/' || repeat('b', 64) || '/part.step', 'part.step', 'part', 'cad', 'application/step', 100
from ovd762;
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
select part_id, job_id, organization_id, 'Fan out part', 'fan-out-part', '76200000-0000-4000-8000-000000000041', 1
from ovd762;
insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity, quote_quantities,
  applicable_vendors, spec_snapshot
)
select part_id, organization_id, user_id, '6061-T6 Aluminum', 'As machined', 0.0050, 1, array[1], -- NOSONAR: canonical controlled-beta fixture
  array['xometry', 'fictiv']::public.vendor_name[],
  '{"process":"CNC milling","tightestToleranceInch":0.0050}'::jsonb -- NOSONAR: canonical process fixture
from ovd762;

insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
)
select organization_id, user_id, 'grant', 'OVD-762 fixture', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy', 'ovd762-grant'
from ovd762;
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
select organization_id, user_id, 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy' from ovd762;
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
)
select organization_id, 'complimentary', clock_timestamp() - interval '1 day', clock_timestamp() + interval '30 days',
  'OVD-762 synthetic commercial access', user_id
from ovd762;
-- Only Xometry is enabled at first, so the single provider path is admissible.
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
select organization_id, 'xometry', true from ovd762;

-- ---------------------------------------------------------------- catalog
select has_table('private', 'xometry_beta_fanout_markers', 'the fan out marker table exists');
select ok(
  (select c.relrowsecurity and c.relforcerowsecurity from pg_catalog.pg_class c
   where c.oid = 'private.xometry_beta_fanout_markers'::regclass),
  'the marker table forces row level security');
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'private.xometry_beta_fanout_markers', 'select')
  and not pg_catalog.has_table_privilege('service_role', 'private.xometry_beta_fanout_markers', 'select'),
  'clients and workers cannot read the marker table directly');
select ok(
  pg_catalog.has_function_privilege('authenticated',
    'public.api_get_xometry_beta_fanout_dispatch_scope(uuid,text,public.vendor_name[])', 'execute')
  and pg_catalog.has_function_privilege('authenticated',
    'public.api_request_xometry_beta_fanout_dispatch(uuid,text,text,text,uuid,uuid,public.vendor_name[],boolean,boolean,boolean)', 'execute'),
  'verified clients can call the two fan out RPCs');
select ok(
  not pg_catalog.has_function_privilege('anon',
    'public.api_request_xometry_beta_fanout_dispatch(uuid,text,text,text,uuid,uuid,public.vendor_name[],boolean,boolean,boolean)', 'execute')
  and not pg_catalog.has_function_privilege('service_role',
    'public.api_request_xometry_beta_fanout_dispatch(uuid,text,text,text,uuid,uuid,public.vendor_name[],boolean,boolean,boolean)', 'execute')
  and not pg_catalog.has_function_privilege('anon',
    'public.api_get_xometry_beta_fanout_dispatch_scope(uuid,text,public.vendor_name[])', 'execute'),
  'anonymous and worker roles cannot call the fan out RPCs');
select ok(
  not pg_catalog.has_function_privilege('authenticated',
    'private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid,public.vendor_name[])', 'execute')
  and not pg_catalog.has_function_privilege('authenticated',
    'private.canonical_xometry_beta_fanout_vendors(public.vendor_name[])', 'execute')
  and not pg_catalog.has_function_privilege('authenticated',
    'private.xometry_beta_fanout_approval_reference(uuid)', 'execute'),
  'the private fan out helpers are not client callable');
select ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=pg_catalog'])
   from pg_catalog.pg_proc p
   where p.oid in (
     'public.api_get_xometry_beta_fanout_dispatch_scope(uuid,text,public.vendor_name[])'::regprocedure,
     'public.api_request_xometry_beta_fanout_dispatch(uuid,text,text,text,uuid,uuid,public.vendor_name[],boolean,boolean,boolean)'::regprocedure,
     'private.resolve_xometry_beta_dispatch_scope_with_access(uuid,text,uuid,public.vendor_name[])'::regprocedure)),
  'the fan out entry points are security definers pinned to search_path=pg_catalog');
select is(
  (select count(*)::integer from ovd762_single_path_source s
   join pg_catalog.pg_proc p on p.oid = s.signature::regprocedure
   where pg_catalog.md5(p.prosrc) = s.source_md5),
  4, 'the single provider request, scope RPC and resolvers are byte identical after the draft');
select is(
  private.xometry_beta_fanout_approval_reference('76200000-0000-4000-8000-000000000101'),
  'baa924a1-8f7d-5229-a543-117c80714c23'::uuid,
  'the server derives the same fan out approval reference as the client');

-- ---------------------------------------------------------------- single provider path unchanged
set local role authenticated;
select pg_temp.ovd762_identity((select user_id from ovd762));
update ovd762 set single_scope_fingerprint = public.api_get_xometry_beta_dispatch_scope(job_id, 'inch') ->> 'scopeFingerprint';
select ok((select single_scope_fingerprint ~ '^[a-f0-9]{64}$' from ovd762),
  'with only Xometry enabled the single provider scope resolves');
reset role;

insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
select organization_id, 'fictiv', true from ovd762;

set local role authenticated;
select pg_temp.ovd762_identity((select user_id from ovd762));
select throws_ok(
  format($$select public.api_get_xometry_beta_dispatch_scope(%L::uuid, 'inch')$$, (select job_id from ovd762)),
  'P0001', 'xometry_beta_exact_provider_set_required',
  'the single provider scope still refuses Xometry plus Fictiv');
select throws_ok(
  format($$select public.api_request_xometry_beta_dispatch(%L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid, true, true, true)$$,
    (select job_id from ovd762), (select single_scope_fingerprint from ovd762), (select confirmation_reference from ovd762)),
  'P0001', 'xometry_beta_exact_provider_set_required',
  'the single provider request still refuses Xometry plus Fictiv');

-- ---------------------------------------------------------------- fan out scope
update ovd762 set fanout_scope_fingerprint = public.api_get_xometry_beta_fanout_dispatch_scope(
  job_id, 'inch', array['xometry', 'fictiv']::public.vendor_name[]) ->> 'scopeFingerprint';
select is((select fanout_scope_fingerprint from ovd762), (select single_scope_fingerprint from ovd762),
  'the fan out scope is the exact Xometry scope the customer reviews');
select is(
  public.api_get_xometry_beta_fanout_dispatch_scope(job_id, 'inch', array['fictiv', 'xometry']::public.vendor_name[]) ->> 'envelopeRevision',
  'xometry-controlled-beta-envelope.v1', 'the marker is order insensitive and keeps the Xometry envelope')
from ovd762;
select throws_ok(
  format($$select public.api_get_xometry_beta_fanout_dispatch_scope(%L::uuid, 'inch', null)$$, (select job_id from ovd762)),
  'P0001', 'xometry_beta_fanout_marker_invalid', 'a missing marker is refused');
select throws_ok(
  format($$select public.api_get_xometry_beta_fanout_dispatch_scope(%L::uuid, 'inch', array['xometry']::public.vendor_name[])$$, (select job_id from ovd762)),
  'P0001', 'xometry_beta_fanout_marker_invalid', 'a marker of Xometry alone is the single provider path and is refused');
select throws_ok(
  format($$select public.api_get_xometry_beta_fanout_dispatch_scope(%L::uuid, 'inch', array['fictiv', 'protolabs']::public.vendor_name[])$$, (select job_id from ovd762)),
  'P0001', 'xometry_beta_fanout_marker_invalid', 'a marker without Xometry is refused');
select throws_ok(
  format($$select public.api_get_xometry_beta_fanout_dispatch_scope(%L::uuid, 'inch', array['xometry', 'xometry', 'fictiv']::public.vendor_name[])$$, (select job_id from ovd762)),
  'P0001', 'xometry_beta_fanout_marker_invalid', 'a marker with duplicates is refused');
select throws_ok(
  format($$select public.api_get_xometry_beta_fanout_dispatch_scope(%L::uuid, 'inch', array['xometry', null, 'fictiv']::public.vendor_name[])$$, (select job_id from ovd762)),
  'P0001', 'xometry_beta_fanout_marker_invalid', 'a marker with a null provider is refused');
select throws_ok(
  format($$select public.api_get_xometry_beta_fanout_dispatch_scope(%L::uuid, 'inch', array['xometry', 'fictiv', 'protolabs']::public.vendor_name[])$$, (select job_id from ovd762)),
  'P0001', 'xometry_beta_exact_provider_set_required', 'a marker naming a provider not enabled for the job is refused');

-- ---------------------------------------------------------------- fan out request
select throws_ok(
  format($$select public.api_request_xometry_beta_fanout_dispatch(%L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid, %L::uuid, array['xometry', 'fictiv']::public.vendor_name[], true, true, true)$$,
    (select job_id from ovd762), (select fanout_scope_fingerprint from ovd762), '76200000-0000-4000-8000-000000000999', (select confirmation_reference from ovd762)),
  'P0001', 'xometry_beta_fanout_confirmation_mismatch',
  'an approval reference not bound to the confirmation is refused');
select throws_ok(
  format($$select public.api_request_xometry_beta_fanout_dispatch(%L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid, null, array['xometry', 'fictiv']::public.vendor_name[], true, true, true)$$,
    (select job_id from ovd762), (select fanout_scope_fingerprint from ovd762), (select fanout_approval_reference from ovd762)),
  'P0001', 'xometry_beta_fanout_confirmation_mismatch',
  'a fan out request without its confirmation reference is refused');
select throws_ok(
  format($$select public.api_request_xometry_beta_fanout_dispatch(%L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid, %L::uuid, array['xometry', 'fictiv']::public.vendor_name[], true, true, false)$$,
    (select job_id from ovd762), (select fanout_scope_fingerprint from ovd762), (select fanout_approval_reference from ovd762), (select confirmation_reference from ovd762)),
  'P0001', 'All Xometry beta dispatch affirmations are required.',
  'every Xometry affirmation is still required');
select throws_ok(
  format($$select public.api_request_xometry_beta_fanout_dispatch(%L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid, %L::uuid, array['xometry', 'fictiv']::public.vendor_name[], true, true, true)$$,
    (select job_id from ovd762), repeat('f', 64), (select fanout_approval_reference from ovd762), (select confirmation_reference from ovd762)),
  'P0001', 'xometry_beta_scope_changed',
  'a fan out request for a package other than the reviewed one is refused');
select throws_ok(
  format($$select public.api_request_xometry_beta_fanout_dispatch(%L::uuid, 'inch', %L, 'founding-beta-2026-01-01', %L::uuid, %L::uuid, array['xometry', 'fictiv']::public.vendor_name[], true, true, true)$$,
    (select job_id from ovd762), (select fanout_scope_fingerprint from ovd762), (select fanout_approval_reference from ovd762), (select confirmation_reference from ovd762)),
  'P0001', 'xometry_beta_notice_changed',
  'a fan out request against a stale notice is refused');
select is(
  public.api_request_xometry_beta_fanout_dispatch(job_id, 'inch', fanout_scope_fingerprint, 'founding-beta-2026-08-15',
    fanout_approval_reference, confirmation_reference, array['fictiv', 'xometry']::public.vendor_name[], true, true, true) ->> 'created',
  'true', 'Xometry plus Fictiv is accepted with the marker bound to the confirmation')
from ovd762;
select is(
  public.api_request_xometry_beta_fanout_dispatch(job_id, 'inch', fanout_scope_fingerprint, 'founding-beta-2026-08-15',
    fanout_approval_reference, confirmation_reference, array['xometry', 'fictiv']::public.vendor_name[], true, true, true) ->> 'deduplicated',
  'true', 'the same confirmation replays to the same permit')
from ovd762;
select throws_ok(
  format($$select public.api_request_xometry_beta_fanout_dispatch(%L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid, %L::uuid, array['xometry', 'fictiv', 'protolabs']::public.vendor_name[], true, true, true)$$,
    (select job_id from ovd762), (select fanout_scope_fingerprint from ovd762), (select fanout_approval_reference from ovd762), (select confirmation_reference from ovd762)),
  'P0001', 'xometry_beta_fanout_confirmation_reused',
  'a replay with a different provider set is refused');
select throws_ok(
  format($$select public.api_request_xometry_beta_fanout_dispatch(%L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid, %L::uuid, array['xometry', 'fictiv']::public.vendor_name[], true, true, true)$$,
    (select job_id from ovd762), (select fanout_scope_fingerprint from ovd762), (select confirmation_reference from ovd762), (select confirmation_reference from ovd762)),
  'P0001', 'xometry_beta_fanout_confirmation_reused',
  'one confirmation never yields a second Xometry permit');
select throws_ok(
  format($$select public.api_request_xometry_beta_dispatch(%L::uuid, 'inch', %L, 'founding-beta-2026-08-15', %L::uuid, true, true, true)$$,
    (select job_id from ovd762), (select fanout_scope_fingerprint from ovd762), (select fanout_approval_reference from ovd762)),
  'P0001', 'xometry_beta_exact_provider_set_required',
  'the single provider path cannot replay a fan out permit');
reset role;

select is(
  (select pg_catalog.jsonb_build_object('vendors', marker.vendors, 'confirmation', marker.confirmation_reference,
     'approval', marker.approval_reference, 'permitApproval', permit.approval_reference)
   from private.xometry_beta_fanout_markers marker
   join private.xometry_beta_dispatch_permits permit on permit.id = marker.permit_id),
  (select pg_catalog.jsonb_build_object('vendors', array['xometry', 'fictiv']::public.vendor_name[], 'confirmation', confirmation_reference,
     'approval', fanout_approval_reference, 'permitApproval', fanout_approval_reference) from ovd762),
  'one marker records the confirmed provider set and binds the permit to its confirmation');
select is(
  (select count(*)::integer from public.work_queue where task_type = 'run_vendor_quote' and job_id = (select job_id from ovd762)),
  1, 'the fan out admission queued exactly one Xometry task');
select is(
  (select permit.envelope_revision || '/' || permit.scope_fingerprint from private.xometry_beta_dispatch_permits permit),
  (select 'xometry-controlled-beta-envelope.v1/' || fanout_scope_fingerprint from ovd762),
  'the permit keeps the Xometry envelope and the exact reviewed fingerprint');
select throws_ok(
  $$update private.xometry_beta_fanout_markers set vendors = array['xometry', 'protolabs']::public.vendor_name[]$$,
  null, null, 'the marker is append only');

-- ---------------------------------------------------------------- worker preflight
create temporary table ovd762_worker on commit drop as
select permit.work_queue_task_id task_id, permit.vendor_quote_result_id result_id, lane.scope_snapshot snapshot,
  clock_timestamp() claimed_at
from private.xometry_beta_dispatch_permits permit
join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id;
grant select on ovd762_worker to service_role;
update public.work_queue set status = 'running', locked_by = 'ovd762-worker', locked_at = (select claimed_at from ovd762_worker)
where id = (select task_id from ovd762_worker);
update public.vendor_quote_results set status = 'running' where id = (select result_id from ovd762_worker);

set local role service_role;
select is(
  public.api_authorize_xometry_beta_worker_dispatch(task_id, result_id, snapshot, 'ovd762-worker', claimed_at) ->> 'authorized',
  'true', 'the worker dispatches a fan out permit while every confirmed provider is enabled')
from ovd762_worker;
reset role;

update public.org_vendor_configs set enabled_for_client_quote_requests = false
where organization_id = (select organization_id from ovd762) and vendor = 'fictiv';
set local role service_role;
select is(
  public.api_authorize_xometry_beta_worker_dispatch(task_id, result_id, snapshot, 'ovd762-worker', claimed_at) ->> 'reasonCode',
  'dispatch_provider_configuration_changed', 'the worker refuses once a confirmed provider is no longer enabled')
from ovd762_worker;
reset role;
update public.org_vendor_configs set enabled_for_client_quote_requests = true
where organization_id = (select organization_id from ovd762) and vendor = 'fictiv';

update public.approved_part_requirements set tightest_tolerance_inch = 0.0100
where part_id = (select part_id from ovd762);
set local role service_role;
select is(
  public.api_authorize_xometry_beta_worker_dispatch(task_id, result_id, snapshot, 'ovd762-worker', claimed_at) ->> 'authorized',
  'false', 'the worker refuses a fan out permit after the package drifts')
from ovd762_worker;
reset role;
update public.approved_part_requirements set tightest_tolerance_inch = 0.0050
where part_id = (select part_id from ovd762);

set local role service_role;
select is(
  public.api_authorize_xometry_beta_worker_dispatch(task_id, result_id, snapshot, 'ovd762-worker', claimed_at) ->> 'authorized',
  'true', 'restoring the reviewed package restores the fan out authorization')
from ovd762_worker;
reset role;

-- A permit from the single provider path keeps the exact rule at dispatch.
-- Fixture-only: remove the marker so the same permit reads as single provider.
alter table private.xometry_beta_fanout_markers disable trigger xometry_beta_fanout_markers_append_only;
delete from private.xometry_beta_fanout_markers;
alter table private.xometry_beta_fanout_markers enable trigger xometry_beta_fanout_markers_append_only;
set local role service_role;
select is(
  public.api_authorize_xometry_beta_worker_dispatch(task_id, result_id, snapshot, 'ovd762-worker', claimed_at) ->> 'reasonCode',
  'dispatch_provider_configuration_changed', 'a permit without a marker still needs exactly Xometry enabled')
from ovd762_worker;
reset role;
insert into private.xometry_beta_fanout_markers (permit_id, organization_id, job_id, confirmation_reference, approval_reference, vendors)
select permit.id, permit.organization_id, permit.job_id, ovd762.confirmation_reference, permit.approval_reference,
  array['xometry', 'fictiv']::public.vendor_name[]
from private.xometry_beta_dispatch_permits permit cross join ovd762;
select throws_ok(
  $$insert into private.xometry_beta_fanout_markers (permit_id, organization_id, job_id, confirmation_reference, approval_reference, vendors)
    select gen_random_uuid(), organization_id, job_id, gen_random_uuid(), gen_random_uuid(), array['xometry']::public.vendor_name[] from ovd762$$,
  '23514', null, 'the table refuses a marker of Xometry alone');

-- ---------------------------------------------------------------- rollback
-- fixtures/ovd762_xometry_fanout_scope_rollback.inc is a byte copy of
-- docs/migration-drafts/ovd-762-xometry-fanout-scope.rollback.sql.
\ir fixtures/ovd762_xometry_fanout_scope_rollback.inc

select ok(
  not pg_catalog.has_function_privilege('authenticated',
    'public.api_request_xometry_beta_fanout_dispatch(uuid,text,text,text,uuid,uuid,public.vendor_name[],boolean,boolean,boolean)', 'execute')
  and not pg_catalog.has_function_privilege('authenticated',
    'public.api_get_xometry_beta_fanout_dispatch_scope(uuid,text,public.vendor_name[])', 'execute'),
  'rollback removes every client grant on the fan out RPCs');
select throws_ok(
  format($$select public.api_get_xometry_beta_fanout_dispatch_scope(%L::uuid, 'inch', array['xometry', 'fictiv']::public.vendor_name[])$$, (select job_id from ovd762)),
  'P0001', 'xometry_beta_fanout_disabled', 'rollback disables the fan out scope even for the owner');
set local role service_role;
select is(
  public.api_authorize_xometry_beta_worker_dispatch(task_id, result_id, snapshot, 'ovd762-worker', claimed_at) ->> 'reasonCode',
  'dispatch_provider_configuration_changed', 'after rollback a queued fan out task fails closed at the worker')
from ovd762_worker;
reset role;
select is(
  (select count(*)::integer from ovd762_single_path_source s
   join pg_catalog.pg_proc p on p.oid = s.signature::regprocedure
   where pg_catalog.md5(p.prosrc) = s.source_md5),
  4, 'rollback leaves the single provider path byte identical');
select is((select count(*)::integer from private.xometry_beta_fanout_markers), 1,
  'rollback keeps the marker evidence');

select * from finish();
rollback;
