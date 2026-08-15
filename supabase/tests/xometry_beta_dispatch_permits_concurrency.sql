-- These fixtures are committed so two independent sessions can exercise the
-- organization-scoped approval-reference advisory lock. Every fixed row is
-- removed before the test finishes.

create extension if not exists dblink with schema extensions;

create or replace function public.ovd367_cleanup_concurrency_fixture()
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  delete from public.work_queue
  where quote_run_id in (
    select id from public.quote_runs
    where job_id in ('00000000-0000-4000-8000-000000003703', -- NOSONAR: deterministic cleanup fixture IDs intentionally repeat setup IDs
                     '00000000-0000-4000-8000-000000003704') -- NOSONAR: deterministic cleanup fixture IDs intentionally repeat setup IDs
  );
  alter table private.xometry_beta_dispatch_permits
    disable trigger xometry_beta_dispatch_permits_append_only;
  delete from private.xometry_beta_dispatch_permits
  where organization_id = '00000000-0000-4000-8000-000000003702'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
  alter table private.xometry_beta_dispatch_permits
    enable trigger xometry_beta_dispatch_permits_append_only;
  delete from public.quote_request_lanes
  where part_id in ('00000000-0000-4000-8000-000000003709', -- NOSONAR: deterministic cleanup fixture IDs intentionally repeat setup IDs
                    '00000000-0000-4000-8000-000000003710'); -- NOSONAR: deterministic cleanup fixture IDs intentionally repeat setup IDs
  delete from public.vendor_quote_results
  where part_id in ('00000000-0000-4000-8000-000000003709',
                    '00000000-0000-4000-8000-000000003710');
  delete from public.quote_runs
  where job_id in ('00000000-0000-4000-8000-000000003703',
                   '00000000-0000-4000-8000-000000003704');
  delete from public.quote_requests
  where job_id in ('00000000-0000-4000-8000-000000003703',
                   '00000000-0000-4000-8000-000000003704');
  delete from public.service_request_line_items
  where job_id in ('00000000-0000-4000-8000-000000003703',
                   '00000000-0000-4000-8000-000000003704');
  delete from public.approved_part_requirements
  where part_id in ('00000000-0000-4000-8000-000000003709',
                    '00000000-0000-4000-8000-000000003710');
  delete from public.parts
  where id in ('00000000-0000-4000-8000-000000003709',
               '00000000-0000-4000-8000-000000003710');
  delete from public.part_versions
  where organization_id = '00000000-0000-4000-8000-000000003702';
  delete from public.canonical_parts
  where organization_id = '00000000-0000-4000-8000-000000003702';
  delete from public.job_files
  where id in ('00000000-0000-4000-8000-000000003707', -- NOSONAR: deterministic cleanup fixture IDs intentionally repeat setup IDs
               '00000000-0000-4000-8000-000000003708'); -- NOSONAR: deterministic cleanup fixture IDs intentionally repeat setup IDs
  delete from public.organization_file_blobs
  where id in ('00000000-0000-4000-8000-000000003705', -- NOSONAR: deterministic cleanup fixture IDs intentionally repeat setup IDs
               '00000000-0000-4000-8000-000000003706'); -- NOSONAR: deterministic cleanup fixture IDs intentionally repeat setup IDs
  delete from public.jobs
  where id in ('00000000-0000-4000-8000-000000003703',
               '00000000-0000-4000-8000-000000003704');
  delete from public.org_vendor_configs
  where organization_id = '00000000-0000-4000-8000-000000003702';
  alter table private.founding_beta_notice_acceptances
    disable trigger founding_beta_notice_acceptances_append_only;
  delete from private.founding_beta_notice_acceptances
  where organization_id = '00000000-0000-4000-8000-000000003702';
  alter table private.founding_beta_notice_acceptances
    enable trigger founding_beta_notice_acceptances_append_only;
  alter table private.founding_beta_enrollment_events
    disable trigger founding_beta_enrollment_events_append_only;
  delete from private.founding_beta_enrollment_events
  where organization_id = '00000000-0000-4000-8000-000000003702';
  alter table private.founding_beta_enrollment_events
    enable trigger founding_beta_enrollment_events_append_only;
  delete from private.organization_entitlement_grants
  where organization_id = '00000000-0000-4000-8000-000000003702';
  delete from public.organization_memberships
  where organization_id = '00000000-0000-4000-8000-000000003702';
  delete from public.organizations
  where id = '00000000-0000-4000-8000-000000003702';
  delete from auth.users
  where id = '00000000-0000-4000-8000-000000003701'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
  update private.commercial_rollout_controls
  set enabled = false, revision = 0,
      change_reason = 'Default-off automatic quote rollout',
      updated_by_user_id = null, updated_by_actor = null
  where capability = 'automatic_quote_collection'; -- NOSONAR: canonical rollout capability intentionally repeats setup/restore value
end;
$$;

-- Self-heal any committed rows left by a previously interrupted run before
-- deterministic fixture identifiers are reused.
do $$
begin
  if 'ovd367_a' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then -- NOSONAR: deterministic connection name is reused for lookup/disconnect
    perform extensions.dblink_disconnect('ovd367_a');
  end if;
  if 'ovd367_b' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then -- NOSONAR: deterministic connection name is reused for lookup/disconnect
    perform extensions.dblink_disconnect('ovd367_b');
  end if;
end;
$$;
select public.ovd367_cleanup_concurrency_fixture();

select plan(3);

begin;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values ('00000000-0000-4000-8000-000000003701', 'authenticated', -- NOSONAR: deterministic authenticated concurrency fixture
  'authenticated', 'ovd367-concurrency@example.test', timezone('utc', now()));

insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-000000003702', -- NOSONAR: deterministic organization fixture identifier
  'OVD 367 Concurrency', 'ovd-367-concurrency');

insert into public.organization_memberships (organization_id, user_id, role)
values ('00000000-0000-4000-8000-000000003702',
  '00000000-0000-4000-8000-000000003701', 'client');

insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason,
  granted_by_user_id
) values (
  '00000000-0000-4000-8000-000000003702', 'complimentary',
  now() - interval '1 day', now() + interval '30 days',
  'OVD-367 concurrency fixture', '00000000-0000-4000-8000-000000003701' -- NOSONAR: deterministic enrollment actor fixture
);

insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision,
  terms_path, privacy_path, idempotency_key
) values (
  '00000000-0000-4000-8000-000000003702',
  '00000000-0000-4000-8000-000000003701', 'grant',
  'OVD-367 concurrency fixture', 'founding-beta-2026-08-15', -- NOSONAR: canonical notice revision fixture
  '/legal/beta-terms', '/legal/privacy', 'ovd367-concurrency-grant'
);

insert into private.founding_beta_notice_acceptances (
  organization_id, user_id, policy_revision, terms_path, privacy_path
) values (
  '00000000-0000-4000-8000-000000003702',
  '00000000-0000-4000-8000-000000003701', 'founding-beta-2026-08-15',
  '/legal/beta-terms', '/legal/privacy'
);

insert into public.org_vendor_configs (
  organization_id, vendor, enabled_for_client_quote_requests
) values ('00000000-0000-4000-8000-000000003702', 'xometry', true); -- NOSONAR: deterministic provider config fixture

update private.commercial_rollout_controls
set enabled = true, revision = revision + 1,
    change_reason = 'OVD-367 concurrency fixture'
where capability = 'automatic_quote_collection';

insert into public.jobs (
  id, organization_id, created_by, title, status,
  requested_service_kinds, primary_service_kind
) values
  ('00000000-0000-4000-8000-000000003703', -- NOSONAR: deterministic job fixture identifier
   '00000000-0000-4000-8000-000000003702',
   '00000000-0000-4000-8000-000000003701', 'Concurrent part A',
   'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote'), -- NOSONAR: canonical quote-envelope fixture
  ('00000000-0000-4000-8000-000000003704', -- NOSONAR: deterministic job fixture identifier
   '00000000-0000-4000-8000-000000003702',
   '00000000-0000-4000-8000-000000003701', 'Concurrent part B',
   'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
) values
  ('00000000-0000-4000-8000-000000003705', -- NOSONAR: deterministic file fixture identifier
   '00000000-0000-4000-8000-000000003702', repeat('d', 64), repeat('d', 64),
   'job-files', 'ovd367-concurrency/a.step', 100, 'application/step'), -- NOSONAR: canonical trusted STEP fixture
  ('00000000-0000-4000-8000-000000003706', -- NOSONAR: deterministic file fixture identifier
   '00000000-0000-4000-8000-000000003702', repeat('e', 64), repeat('e', 64),
   'job-files', 'ovd367-concurrency/b.step', 100, 'application/step');

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
) values
  ('00000000-0000-4000-8000-000000003707', -- NOSONAR: deterministic part fixture identifier
   '00000000-0000-4000-8000-000000003703',
   '00000000-0000-4000-8000-000000003702',
   '00000000-0000-4000-8000-000000003701',
   '00000000-0000-4000-8000-000000003705', repeat('d', 64), repeat('d', 64),
   'job-files', 'ovd367-concurrency/a.step', 'a.step', 'a', 'cad',
   'application/step', 100),
  ('00000000-0000-4000-8000-000000003708', -- NOSONAR: deterministic part fixture identifier
   '00000000-0000-4000-8000-000000003704',
   '00000000-0000-4000-8000-000000003702',
   '00000000-0000-4000-8000-000000003701',
   '00000000-0000-4000-8000-000000003706', repeat('e', 64), repeat('e', 64),
   'job-files', 'ovd367-concurrency/b.step', 'b.step', 'b', 'cad',
   'application/step', 100);

insert into public.parts (
  id, job_id, organization_id, name, normalized_key, cad_file_id, quantity
) values
  ('00000000-0000-4000-8000-000000003709', -- NOSONAR: deterministic requirement fixture identifier
   '00000000-0000-4000-8000-000000003703',
   '00000000-0000-4000-8000-000000003702', 'Part A', 'part-a',
   '00000000-0000-4000-8000-000000003707', 1),
  ('00000000-0000-4000-8000-000000003710', -- NOSONAR: deterministic requirement fixture identifier
   '00000000-0000-4000-8000-000000003704',
   '00000000-0000-4000-8000-000000003702', 'Part B', 'part-b',
   '00000000-0000-4000-8000-000000003708', 1);

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish,
  tightest_tolerance_inch, quantity, quote_quantities,
  applicable_vendors, spec_snapshot
) values
  ('00000000-0000-4000-8000-000000003709',
   '00000000-0000-4000-8000-000000003702',
   '00000000-0000-4000-8000-000000003701', '6061-T6 Aluminum',
   'As machined', 0.005, 1, array[1], array['xometry']::public.vendor_name[],
   '{"process":"CNC milling"}'::jsonb),
  ('00000000-0000-4000-8000-000000003710',
   '00000000-0000-4000-8000-000000003702',
   '00000000-0000-4000-8000-000000003701', '6061-T6 Aluminum',
   'As machined', 0.005, 1, array[1], array['xometry']::public.vendor_name[],
   '{"process":"CNC milling"}'::jsonb);

create or replace function public.ovd367_concurrency_attempt(
  p_job_id uuid,
  p_scope_fingerprint text,
  p_approval_reference uuid
) returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', '00000000-0000-4000-8000-000000003701',
      'role', 'authenticated', 'aal', 'aal1'
    )::text,
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claim.sub', '00000000-0000-4000-8000-000000003701', true
  );
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  begin
    return public.api_request_xometry_beta_dispatch(
      p_job_id, 'inch', p_scope_fingerprint, 'founding-beta-2026-08-15',
      p_approval_reference, true, true, true
    );
  exception when others then
    return pg_catalog.jsonb_build_object('error', sqlerrm);
  end;
end;
$$;

commit;

select pg_catalog.set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000003701","role":"authenticated","aal":"aal1"}',
  false
);
select pg_catalog.set_config(
  'request.jwt.claim.sub', '00000000-0000-4000-8000-000000003701', false
);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

create temporary table ovd367_concurrency_scopes (
  job_id uuid primary key,
  scope_fingerprint text not null
);
insert into ovd367_concurrency_scopes
select job_id, public.api_get_xometry_beta_dispatch_scope(job_id, 'inch') ->> 'scopeFingerprint'
from (values
  ('00000000-0000-4000-8000-000000003703'::uuid),
  ('00000000-0000-4000-8000-000000003704'::uuid)
) jobs(job_id);

select extensions.dblink_connect(
  'ovd367_a', -- NOSONAR: deterministic dblink connection name
  coalesce(
    nullif(current_setting('ovd.test_conninfo', true), ''),
    'dbname=postgres'
  )
);
select extensions.dblink_connect(
  'ovd367_b', -- NOSONAR: deterministic dblink connection name
  coalesce(
    nullif(current_setting('ovd.test_conninfo', true), ''),
    'dbname=postgres'
  )
);

select extensions.dblink_send_query(
  'ovd367_a',
  format(
    $$select public.ovd367_concurrency_attempt(%L::uuid, %L, %L::uuid)$$,
    '00000000-0000-4000-8000-000000003703',
    (select scope_fingerprint from ovd367_concurrency_scopes
      where job_id = '00000000-0000-4000-8000-000000003703'),
    '00000000-0000-4000-8000-000000003711' -- NOSONAR: deterministic approval reference fixture
  )
);
select extensions.dblink_send_query(
  'ovd367_b',
  format(
    $$select public.ovd367_concurrency_attempt(%L::uuid, %L, %L::uuid)$$,
    '00000000-0000-4000-8000-000000003704',
    (select scope_fingerprint from ovd367_concurrency_scopes
      where job_id = '00000000-0000-4000-8000-000000003704'),
    '00000000-0000-4000-8000-000000003711'
  )
);

create temporary table ovd367_concurrency_results (result jsonb not null);
insert into ovd367_concurrency_results
select result from extensions.dblink_get_result('ovd367_a') as response(result jsonb);
insert into ovd367_concurrency_results
select result from extensions.dblink_get_result('ovd367_b') as response(result jsonb);
select * from extensions.dblink_get_result('ovd367_a') as response(result jsonb);
select * from extensions.dblink_get_result('ovd367_b') as response(result jsonb);

select is(
  (select count(*) from ovd367_concurrency_results
    where coalesce((result ->> 'created')::boolean, false)),
  1::bigint,
  'two jobs racing one approval reference create exactly one dispatch'
);
select is(
  (select count(*) from ovd367_concurrency_results
    where result ->> 'error' = 'xometry_beta_approval_reference_reused'),
  1::bigint,
  'the losing cross-job request returns the deterministic approval conflict'
);
select ok(
  (select count(*) = 1 from private.xometry_beta_dispatch_permits
    where approval_reference = '00000000-0000-4000-8000-000000003711')
  and (select count(*) = 1 from public.work_queue
    where payload ->> 'xometryBetaDispatchPermitId' is not null),
  'the concurrent conflict leaves one permit-bound provider task'
);

select extensions.dblink_disconnect('ovd367_a');
select extensions.dblink_disconnect('ovd367_b');

begin;

drop function public.ovd367_concurrency_attempt(uuid, text, uuid);
select public.ovd367_cleanup_concurrency_fixture();

commit;

drop function public.ovd367_cleanup_concurrency_fixture();

select * from finish();
