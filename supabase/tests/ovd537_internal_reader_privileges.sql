begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(51);

-- Keep each exact one-argument target in one place. The three-argument vendor
-- preferences overload has a separate access contract and is unchanged.
create temporary table ovd537_readers (
  name text not null,
  signature text not null,
  direct_call text
) on commit drop;

insert into ovd537_readers (name, signature) values
  ('get_active_pricing_policy_id', 'public.get_active_pricing_policy_id(uuid)'),
  ('get_enabled_client_quote_vendors', 'public.get_enabled_client_quote_vendors(uuid)'),
  ('get_quote_request_guardrails', 'public.get_quote_request_guardrails(uuid)'),
  ('get_quote_request_pending_estimated_cost_usd', 'public.get_quote_request_pending_estimated_cost_usd(uuid)'),
  ('get_self_service_membership_role', 'public.get_self_service_membership_role(uuid)');

update ovd537_readers
set direct_call = format('select public.%I(null::uuid)', name);

create temporary table ovd537_fixture (
  user_id uuid not null,
  job_id uuid not null,
  part_id uuid not null,
  organization_name text not null,
  organization_slug text not null,
  authenticated_role text not null,
  anonymous_role text not null,
  service_role_name text not null,
  owner_role text not null,
  execute_privilege text not null,
  permission_denied_state text not null,
  expected_member_role text not null,
  selected_vendor public.vendor_name not null,
  organization_id uuid,
  pricing_policy_id uuid not null,
  pricing_job_title text not null,
  file_blob_id uuid not null,
  file_id uuid not null,
  approval_reference uuid not null,
  content_hash text not null,
  model_units text not null,
  notice_revision text,
  terms_path text,
  privacy_path text
) on commit drop;

insert into ovd537_fixture values (
  '00000000-0000-4000-8000-000000005370',
  '00000000-0000-4000-8000-000000005371',
  '00000000-0000-4000-8000-000000005372',
  'OVD537 synthetic client', 'ovd537-synthetic-client',
  'authenticated', 'anon', 'service_role', 'postgres',
  'EXECUTE', '42501', 'client', 'xometry',
  null,
  '00000000-0000-4000-8000-000000005376',
  'OVD537 guarded pricing job',
  '00000000-0000-4000-8000-000000005373',
  '00000000-0000-4000-8000-000000005374',
  '00000000-0000-4000-8000-000000005375',
  repeat('a', 64), 'inch',
  null, null, null
);

grant select on ovd537_readers, ovd537_fixture to anon, authenticated;

select ok(to_regprocedure(reader.signature) is not null, reader.signature || ' exists')
from ovd537_readers reader;

select ok(
  (select p.prosecdef from pg_catalog.pg_proc p where p.oid = reader.signature::regprocedure),
  reader.signature || ' remains security definer for guarded parent calls'
)
from ovd537_readers reader;

select ok(
  not has_function_privilege(fixture.anonymous_role, reader.signature, fixture.execute_privilege),
  reader.signature || ' denies anon, including inherited PUBLIC grants'
)
from ovd537_readers reader cross join ovd537_fixture fixture;

select ok(
  not has_function_privilege(fixture.authenticated_role, reader.signature, fixture.execute_privilege),
  reader.signature || ' denies authenticated direct access'
)
from ovd537_readers reader cross join ovd537_fixture fixture;

select ok(
  has_function_privilege(fixture.service_role_name, reader.signature, fixture.execute_privilege),
  reader.signature || ' retains service-role execution'
)
from ovd537_readers reader cross join ovd537_fixture fixture;

select ok(
  has_function_privilege(fixture.owner_role, reader.signature, fixture.execute_privilege),
  reader.signature || ' retains migration-owner execution for guarded parents'
)
from ovd537_readers reader cross join ovd537_fixture fixture;

set local role anon;
select throws_ok(
  reader.direct_call,
  fixture.permission_denied_state,
  null,
  reader.name || ' denies anonymous direct invocation'
)
from ovd537_readers reader cross join ovd537_fixture fixture;
reset role;

set local role authenticated;
select throws_ok(
  reader.direct_call,
  fixture.permission_denied_state,
  null,
  reader.name || ' denies signed-in direct invocation'
)
from ovd537_readers reader cross join ovd537_fixture fixture;
reset role;

-- A synthetic confirmed user still reaches the membership helper through its
-- guarded self-service parent, even though direct authenticated calls fail.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
select
  fixture.user_id,
  fixture.authenticated_role,
  fixture.authenticated_role,
  'ovd537-synthetic@example.test',
  now(),
  '{"provider":"email"}'::jsonb
from ovd537_fixture fixture;

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', fixture.user_id,
    'role', fixture.authenticated_role,
    'aal', 'aal1'
  )::text,
  true
)
from ovd537_fixture fixture;
select set_config('request.jwt.claim.sub', fixture.user_id::text, true)
from ovd537_fixture fixture;
select set_config('request.jwt.claim.role', fixture.authenticated_role, true)
from ovd537_fixture fixture;

set local role authenticated;
select lives_ok(
  format('select public.api_create_self_service_organization(%L)', fixture.organization_name),
  'guarded self-service organization creation remains available'
)
from ovd537_fixture fixture;
reset role;

select is(
  (select membership.role::text
   from public.organization_memberships membership
   join public.organizations organization_row on organization_row.id = membership.organization_id
   where organization_row.slug = fixture.organization_slug
     and membership.user_id = fixture.user_id),
  fixture.expected_member_role,
  'the guarded parent still assigns the expected membership role'
)
from ovd537_fixture fixture;

update ovd537_fixture fixture
set organization_id = organization_row.id
from public.organizations organization_row
where organization_row.slug = fixture.organization_slug;

update ovd537_fixture fixture
set notice_revision = notice.value ->> 'policyRevision',
    terms_path = notice.value ->> 'termsPath',
    privacy_path = notice.value ->> 'privacyPath'
from (select private.current_founding_beta_notice() as value) notice;

-- These are transaction-local synthetic enrollment records, not production
-- enrollment or customer evidence. They let the guarded job-creation RPC reach
-- its pricing-policy lookup instead of stopping at the current beta gate.
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision,
  terms_path, privacy_path, idempotency_key
)
select
  fixture.organization_id, fixture.user_id, 'grant',
  'OVD537 local access fixture', fixture.notice_revision,
  fixture.terms_path, fixture.privacy_path, 'ovd537-enrollment'
from ovd537_fixture fixture;

insert into private.founding_beta_notice_acceptances (
  organization_id, user_id, policy_revision, terms_path, privacy_path
)
select
  fixture.organization_id, fixture.user_id, fixture.notice_revision,
  fixture.terms_path, fixture.privacy_path
from ovd537_fixture fixture;

insert into public.pricing_policies (
  id, organization_id, version, markup_percent, currency_minor_unit
)
select
  fixture.pricing_policy_id, fixture.organization_id, 'ovd537-policy', 20, 0.01
from ovd537_fixture fixture;

set local role authenticated;
select lives_ok(
  format(
    'select public.api_create_job(%L::uuid, %L)',
    fixture.organization_id, fixture.pricing_job_title
  ),
  'guarded job creation still reaches the internal pricing lookup'
)
from ovd537_fixture fixture;
reset role;

select is(
  (select job.active_pricing_policy_id
   from public.jobs job
   where job.organization_id = fixture.organization_id
     and job.title = fixture.pricing_job_title),
  fixture.pricing_policy_id,
  'guarded job creation selects the synthetic organization pricing policy'
)
from ovd537_fixture fixture;

-- A populated quote lane forces the guarded eligibility parent to use the
-- one-argument vendor helper, rather than merely returning an empty result.
insert into public.jobs (id, organization_id, created_by, title, status)
select
  fixture.job_id, fixture.organization_id, fixture.user_id,
  'OVD537 synthetic lane', 'ready_to_quote'
from ovd537_fixture fixture;

insert into public.parts (id, job_id, organization_id, name, normalized_key)
select
  fixture.part_id, fixture.job_id, fixture.organization_id,
  'OVD537 synthetic part', 'ovd537-part'
from ovd537_fixture fixture;

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish,
  tightest_tolerance_inch, quantity,
  quote_quantities, applicable_vendors, spec_snapshot
)
select
  fixture.part_id, fixture.organization_id, fixture.user_id,
  '6061-T6 Aluminum', 'As machined', 0.005, 1, '{1}'::integer[],
  array[fixture.selected_vendor], '{"process":"CNC milling"}'::jsonb
from ovd537_fixture fixture;

set local role authenticated;
select is(
  jsonb_array_length(public.api_get_quote_lane_eligibility(fixture.job_id, null)),
  1,
  'guarded eligibility still returns one synthetic requestable lane'
)
from ovd537_fixture fixture;
select is(
  public.api_get_quote_lane_eligibility(fixture.job_id, null) -> 0 ->> 'vendor',
  fixture.selected_vendor::text,
  'guarded eligibility still derives the configured vendor'
)
from ovd537_fixture fixture;
reset role;

-- The current public quote-request wrappers intentionally stop at confirmation.
-- The controlled-beta dispatch parent is the authenticated path that reaches
-- both guardrail readers. All enabling data below is synthetic and rolls back.
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason,
  granted_by_user_id
)
select
  fixture.organization_id, 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'OVD537 local quote fixture', fixture.user_id
from ovd537_fixture fixture;

update private.commercial_rollout_controls
set enabled = true,
    revision = revision + 1,
    change_reason = 'OVD537 local pgTAP fixture'
where capability = 'automatic_quote_collection';

insert into public.org_vendor_configs (
  organization_id, vendor, enabled_for_client_quote_requests
)
select fixture.organization_id, fixture.selected_vendor, true
from ovd537_fixture fixture;

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
)
select
  fixture.file_blob_id, fixture.organization_id,
  fixture.content_hash, fixture.content_hash,
  'job-files',
  fixture.organization_id::text || '/sha256/' || fixture.content_hash || '/part.step',
  100, 'application/step'
from ovd537_fixture fixture;

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
)
select
  fixture.file_id, fixture.job_id, fixture.organization_id, fixture.user_id,
  blob.id, blob.content_sha256, blob.trusted_content_sha256,
  blob.storage_bucket, blob.storage_path,
  'part.step', 'part', 'cad', blob.mime_type, blob.size_bytes
from ovd537_fixture fixture
join public.organization_file_blobs blob on blob.id = fixture.file_blob_id;

update public.parts part
set cad_file_id = fixture.file_id
from ovd537_fixture fixture
where part.id = fixture.part_id;

insert into public.quote_request_guardrails (
  organization_id, org_pending_cost_ceiling_usd,
  default_cost_per_requested_lane_usd, enabled
)
select fixture.organization_id, 0, 75, true
from ovd537_fixture fixture;

-- The public dispatch wrapper maps every non-created result to one exception.
-- Assert the internal result first so that exception cannot mask an earlier
-- eligibility stop; the synthetic JWT is still bound to the fixture user.
select is(
  private.request_scoped_automatic_quote_impl(
    fixture.job_id,
    array[fixture.selected_vendor]::public.vendor_name[]
  ) ->> 'reasonCode',
  'org_cost_ceiling_reached',
  'the internal quote path reaches both guardrail readers and applies the zero-cost ceiling'
)
from ovd537_fixture fixture;

set local role authenticated;
select matches(
  public.api_get_xometry_beta_dispatch_scope(fixture.job_id, fixture.model_units)
    ->> 'scopeFingerprint',
  '^[a-f0-9]{64}$',
  'synthetic dispatch scope is valid before the guarded quote request'
)
from ovd537_fixture fixture;

select throws_ok(
  format(
    'select public.api_request_xometry_beta_dispatch(%L::uuid,%L,%L,%L,%L::uuid,true,true,true)',
    fixture.job_id,
    fixture.model_units,
    public.api_get_xometry_beta_dispatch_scope(fixture.job_id, fixture.model_units)
      ->> 'scopeFingerprint',
    fixture.notice_revision,
    fixture.approval_reference
  ),
  'P0001',
  'xometry_beta_new_lane_required',
  'authenticated dispatch reaches the guardrail and pending-cost readers, then stops at the zero-cost ceiling'
)
from ovd537_fixture fixture;
reset role;

select is(
  (select count(*)::integer from public.quote_requests request_row
   where request_row.job_id = fixture.job_id),
  0,
  'the cost guardrail creates no synthetic quote request'
)
from ovd537_fixture fixture;

select is(
  (select count(*)::integer from public.work_queue task
   where task.job_id = fixture.job_id),
  0,
  'the cost guardrail queues no provider task'
)
from ovd537_fixture fixture;

select * from finish();
rollback;
