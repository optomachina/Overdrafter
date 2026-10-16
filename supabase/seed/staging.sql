-- OVD-837: synthetic staging seed fixtures. STAGING ONLY (ref ldmambwtksfvqdufhaam).
--
-- Never apply to production (ozuatdcakezjtevztjlr). Use scripts/seed-staging.mjs,
-- which refuses every ref but the staging one, or paste this file into the
-- Supabase SQL API / MCP execute_sql for the staging project only (see the
-- target guard below).
--
-- One statement batch, no begin/commit and no psql meta-commands: the SQL API
-- runs it in one transaction, and the runner adds --single-transaction.
--
-- PII-free: every person, organization, address and file is invented. Emails
-- use the reserved example.test domain, phone numbers the 555-01xx fiction
-- range, and file paths point at synthetic objects that are never uploaded.
-- No user has a password, so none of them can sign in.
--
-- Idempotent: fixed UUIDs (prefix 83700000-5eed-) and ON CONFLICT DO NOTHING,
-- so a second run inserts nothing and fires no insert trigger again. The one
-- exception is vendor_quote_results.created_at: a fixture result older than
-- 60 days is moved back into the window so the OVD-813 history read (90 days)
-- keeps finding it. That update changes no row count.
--
-- Assumes every migration in supabase/migrations is applied (including the
-- OVD-722 provider kill switch).

-- Target guard: runs first, before any write, and aborts the whole batch unless
-- the session asserts the staging ref. Signal: the transaction-local setting
-- ovd837.seed_target_ref. A Supabase database has no built-in setting that
-- names its own project ref (production and staging share every migration), so
-- the assertion comes from the caller that already proved the target:
--   * scripts/seed-staging.mjs sets it with `set local` in the same
--     --single-transaction psql run, and only after its ref allowlist passed;
--   * an MCP execute_sql caller (project_id ldmambwtksfvqdufhaam, after
--     `--check-target`) prepends
--     select set_config('ovd837.seed_target_ref', 'ldmambwtksfvqdufhaam', true);
-- Unset, empty or any other value (including the production ref) fails closed,
-- so pasting this file alone into any SQL editor writes nothing.
do $guard$
begin
  if coalesce(current_setting('ovd837.seed_target_ref', true), '') <> 'ldmambwtksfvqdufhaam' then
    raise exception 'OVD-837 staging seed refused: ovd837.seed_target_ref is not the staging ref ldmambwtksfvqdufhaam';
  end if;
end
$guard$;

-- Users (no identities: nothing references them and nobody signs in).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000'::uuid, fixture.id, 'authenticated', 'authenticated',
  fixture.email, '', now(), '', '', '', '',
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', fixture.full_name, 'staging_fixture', 'ovd-837'),
  now(), now()
from (values
  ('83700000-5eed-4000-8000-000000000001'::uuid, 'staging-client-alpha@example.test', 'Fixture Client Alpha'),
  ('83700000-5eed-4000-8000-000000000002'::uuid, 'staging-client-beta@example.test', 'Fixture Client Beta'),
  ('83700000-5eed-4000-8000-000000000003'::uuid, 'staging-estimator@example.test', 'Fixture Estimator')
) as fixture(id, email, full_name)
on conflict do nothing;

insert into public.organizations (
  id, name, slug, company_name, phone, billing_street, billing_city, billing_state, billing_zip,
  shipping_same_as_billing
)
values
  ('83700000-5eed-4000-8000-000000000101', 'Staging Fixture Org Alpha', 'staging-fixture-alpha',
   'Fixture Alpha Widgets (synthetic)', '555-0101', '100 Fixture Way', 'Testville', 'AZ', '85001', true),
  ('83700000-5eed-4000-8000-000000000102', 'Staging Fixture Org Beta', 'staging-fixture-beta',
   'Fixture Beta Housings (synthetic)', '555-0102', '200 Sample Street', 'Mocktown', 'OR', '97001', true)
on conflict do nothing;

insert into public.organization_memberships (id, organization_id, user_id, role)
values
  ('83700000-5eed-4000-8000-000000000111', '83700000-5eed-4000-8000-000000000101', '83700000-5eed-4000-8000-000000000001', 'client'),
  ('83700000-5eed-4000-8000-000000000112', '83700000-5eed-4000-8000-000000000102', '83700000-5eed-4000-8000-000000000002', 'client'),
  ('83700000-5eed-4000-8000-000000000113', '83700000-5eed-4000-8000-000000000101', '83700000-5eed-4000-8000-000000000003', 'internal_estimator')
on conflict do nothing;

insert into public.jobs (
  id, organization_id, created_by, title, description, status, source, tags, requested_quote_quantities
)
values
  ('83700000-5eed-4000-8000-000000000201', '83700000-5eed-4000-8000-000000000101', '83700000-5eed-4000-8000-000000000001',
   'Fixture bracket A', 'Synthetic staging job (OVD-837).', 'internal_review', 'staging_fixture', array['staging-fixture'], array[1, 10]),
  ('83700000-5eed-4000-8000-000000000202', '83700000-5eed-4000-8000-000000000101', '83700000-5eed-4000-8000-000000000001',
   'Fixture plate B', 'Synthetic staging job (OVD-837).', 'internal_review', 'staging_fixture', array['staging-fixture'], array[1]),
  ('83700000-5eed-4000-8000-000000000203', '83700000-5eed-4000-8000-000000000102', '83700000-5eed-4000-8000-000000000002',
   'Fixture housing C', 'Synthetic staging job (OVD-837).', 'internal_review', 'staging_fixture', array['staging-fixture'], array[1])
on conflict do nothing;

-- Synthetic CAD fixture paths only; the hashes are sha256 of fixed labels, not of real files.
insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
)
select fixture.id, fixture.organization_id, fixture.sha256, fixture.sha256, 'job-files', fixture.storage_path, fixture.size_bytes, fixture.mime_type
from (values
  ('83700000-5eed-4000-8000-000000000301'::uuid, '83700000-5eed-4000-8000-000000000101'::uuid,
   'd33c7476959c4c60af745cf964988935012c7658cbd257e3f75a9fb4e8ca7f38', 'staging-fixtures/ovd837/alpha/fixture-bracket-a.step', 2048::bigint, 'application/step'),
  ('83700000-5eed-4000-8000-000000000302'::uuid, '83700000-5eed-4000-8000-000000000101'::uuid,
   '6f461c7814f2c6c745740a360ff49bbdb056bfd391bc872db9625bcf7bf4aecf', 'staging-fixtures/ovd837/alpha/fixture-bracket-a.pdf', 1024::bigint, 'application/pdf'),
  ('83700000-5eed-4000-8000-000000000303'::uuid, '83700000-5eed-4000-8000-000000000101'::uuid,
   'ff7f1ee44357da04fbd86f8497cf1968d5112faba073f6b7f6fbd9f66189af36', 'staging-fixtures/ovd837/alpha/fixture-plate-b.step', 1536::bigint, 'application/step'),
  ('83700000-5eed-4000-8000-000000000304'::uuid, '83700000-5eed-4000-8000-000000000102'::uuid,
   'ac5d562428133c408890c079a64db15d8f4fd93854b835c4510c456dc6a408c4', 'staging-fixtures/ovd837/beta/fixture-housing-c.step', 4096::bigint, 'application/step')
) as fixture(id, organization_id, sha256, storage_path, size_bytes, mime_type)
on conflict do nothing;

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes, matched_part_key
)
select
  fixture.id, fixture.job_id, blob.organization_id, fixture.uploaded_by, blob.id, blob.content_sha256, blob.trusted_content_sha256,
  blob.storage_bucket, blob.storage_path, fixture.original_name, fixture.normalized_name, fixture.file_kind::public.job_file_kind,
  blob.mime_type, blob.size_bytes, fixture.normalized_name
from (values
  ('83700000-5eed-4000-8000-000000000401'::uuid, '83700000-5eed-4000-8000-000000000201'::uuid, '83700000-5eed-4000-8000-000000000301'::uuid,
   '83700000-5eed-4000-8000-000000000001'::uuid, 'fixture-bracket-a.step', 'fixture-bracket-a', 'cad'),
  ('83700000-5eed-4000-8000-000000000402'::uuid, '83700000-5eed-4000-8000-000000000201'::uuid, '83700000-5eed-4000-8000-000000000302'::uuid,
   '83700000-5eed-4000-8000-000000000001'::uuid, 'fixture-bracket-a.pdf', 'fixture-bracket-a', 'drawing'),
  ('83700000-5eed-4000-8000-000000000403'::uuid, '83700000-5eed-4000-8000-000000000202'::uuid, '83700000-5eed-4000-8000-000000000303'::uuid,
   '83700000-5eed-4000-8000-000000000001'::uuid, 'fixture-plate-b.step', 'fixture-plate-b', 'cad'),
  ('83700000-5eed-4000-8000-000000000404'::uuid, '83700000-5eed-4000-8000-000000000203'::uuid, '83700000-5eed-4000-8000-000000000304'::uuid,
   '83700000-5eed-4000-8000-000000000002'::uuid, 'fixture-housing-c.step', 'fixture-housing-c', 'cad')
) as fixture(id, job_id, blob_id, uploaded_by, original_name, normalized_name, file_kind)
join public.organization_file_blobs blob on blob.id = fixture.blob_id
on conflict do nothing;

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id, quantity)
values
  ('83700000-5eed-4000-8000-000000000501', '83700000-5eed-4000-8000-000000000201', '83700000-5eed-4000-8000-000000000101',
   'Fixture bracket A', 'fixture-bracket-a', '83700000-5eed-4000-8000-000000000401', '83700000-5eed-4000-8000-000000000402', 1),
  ('83700000-5eed-4000-8000-000000000502', '83700000-5eed-4000-8000-000000000202', '83700000-5eed-4000-8000-000000000101',
   'Fixture plate B', 'fixture-plate-b', '83700000-5eed-4000-8000-000000000403', null, 1),
  ('83700000-5eed-4000-8000-000000000503', '83700000-5eed-4000-8000-000000000203', '83700000-5eed-4000-8000-000000000102',
   'Fixture housing C', 'fixture-housing-c', '83700000-5eed-4000-8000-000000000404', null, 1)
on conflict do nothing;

insert into public.approved_part_requirements (
  id, part_id, organization_id, approved_by, description, part_number, revision, material, finish,
  tightest_tolerance_inch, quantity, quote_quantities, applicable_vendors, spec_snapshot
)
values
  ('83700000-5eed-4000-8000-000000000601', '83700000-5eed-4000-8000-000000000501', '83700000-5eed-4000-8000-000000000101',
   '83700000-5eed-4000-8000-000000000001', 'Synthetic mounting bracket', 'FIX-837-A', 'A', '6061-T6 Aluminum', 'As machined',
   0.0050, 1, array[1, 10], array['xometry', 'fictiv', 'protolabs']::public.vendor_name[],
   '{"process":"CNC milling","tightestToleranceInch":0.0050,"stagingFixture":"ovd-837"}'::jsonb),
  ('83700000-5eed-4000-8000-000000000602', '83700000-5eed-4000-8000-000000000502', '83700000-5eed-4000-8000-000000000101',
   '83700000-5eed-4000-8000-000000000001', 'Synthetic flat plate', 'FIX-837-B', 'A', '5052-H32 Aluminum', 'Deburred',
   null, 1, array[1], array['sendcutsend', 'oshcut']::public.vendor_name[],
   '{"process":"Sheet metal laser cutting","thicknessIn":0.125,"stagingFixture":"ovd-837"}'::jsonb),
  ('83700000-5eed-4000-8000-000000000603', '83700000-5eed-4000-8000-000000000503', '83700000-5eed-4000-8000-000000000102',
   '83700000-5eed-4000-8000-000000000002', 'Synthetic enclosure housing', 'FIX-837-C', 'B', '304 Stainless Steel', 'Bead blasted',
   0.0020, 1, array[1], array['xometry', 'fictiv']::public.vendor_name[],
   '{"process":"CNC milling","tightestToleranceInch":0.0020,"stagingFixture":"ovd-837"}'::jsonb)
on conflict do nothing;

insert into public.quote_requests (id, organization_id, job_id, requested_by, requested_vendors, status, request_mode, created_at)
values
  ('83700000-5eed-4000-8000-000000000701', '83700000-5eed-4000-8000-000000000101', '83700000-5eed-4000-8000-000000000201',
   '83700000-5eed-4000-8000-000000000001', array['xometry', 'fictiv', 'protolabs']::public.vendor_name[], 'queued', 'automatic', now() - interval '2 days'),
  ('83700000-5eed-4000-8000-000000000702', '83700000-5eed-4000-8000-000000000101', '83700000-5eed-4000-8000-000000000202',
   '83700000-5eed-4000-8000-000000000001', array['sendcutsend', 'oshcut']::public.vendor_name[], 'queued', 'automatic', now() - interval '5 days'),
  ('83700000-5eed-4000-8000-000000000703', '83700000-5eed-4000-8000-000000000102', '83700000-5eed-4000-8000-000000000203',
   '83700000-5eed-4000-8000-000000000002', array['xometry', 'fictiv']::public.vendor_name[], 'queued', 'automatic', now() - interval '7 days'),
  ('83700000-5eed-4000-8000-000000000704', '83700000-5eed-4000-8000-000000000101', '83700000-5eed-4000-8000-000000000201',
   '83700000-5eed-4000-8000-000000000001', array['xometry']::public.vendor_name[], 'queued', 'automatic', now() - interval '20 days')
on conflict do nothing;

insert into public.quote_runs (id, job_id, organization_id, initiated_by, status, quote_request_id, created_at)
select fixture.id, request.job_id, request.organization_id, request.requested_by, 'completed', request.id, request.created_at
from (values
  ('83700000-5eed-4000-8000-000000000801'::uuid, '83700000-5eed-4000-8000-000000000701'::uuid),
  ('83700000-5eed-4000-8000-000000000802'::uuid, '83700000-5eed-4000-8000-000000000702'::uuid),
  ('83700000-5eed-4000-8000-000000000803'::uuid, '83700000-5eed-4000-8000-000000000703'::uuid),
  ('83700000-5eed-4000-8000-000000000804'::uuid, '83700000-5eed-4000-8000-000000000704'::uuid)
) as fixture(id, quote_request_id)
join public.quote_requests request on request.id = fixture.quote_request_id
on conflict do nothing;

-- Results shaped like the worker writes them after the OVD-813 sanity gate
-- (worker/src/fixtureHeal/gate.ts, FIXTURE_SANITY_VERSION 2). Bracket A has a
-- two-row xometry history plus fictiv and protolabs peers at quantity 1, so
-- supabase/seed/staging-smoke.sql returns rows. The held row and the pre-gate
-- failed row (no fixtureSanity) must never be read as history.
insert into public.vendor_quote_results (
  id, quote_run_id, part_id, organization_id, vendor, status, requested_quantity,
  unit_price_usd, total_price_usd, lead_time_business_days, notes, raw_payload, created_at
)
select
  fixture.id, run.id, part.id, run.organization_id, fixture.vendor::public.vendor_name,
  fixture.status::public.vendor_status, fixture.quantity,
  case when fixture.held then null else fixture.unit_price end,
  case when fixture.held then null else fixture.unit_price * fixture.quantity end,
  fixture.lead_days,
  case when fixture.held then '["Held for review: fixture sanity check failed (synthetic staging fixture)."]'::jsonb else '[]'::jsonb end,
  jsonb_build_object('stagingFixture', 'ovd-837')
    || case when package.package_id is null then '{}'::jsonb else jsonb_build_object('fixtureSanity',
      jsonb_build_object(
        'v', 2,
        'verdict', case when fixture.held then 'hold' else 'pass' end,
        'findings', case when fixture.held
          then '[{"code":"history_outlier","class":"outlier","detail":"synthetic staging fixture"}]'::jsonb
          else '[]'::jsonb end,
        'ratios', jsonb_build_object('history', null, 'peer', null),
        'cheapestUnitUsd', fixture.cheapest_unit,
        'pause', fixture.held,
        'packageId', package.package_id,
        'requirementKey', package.requirement_key,
        'checkedAt', to_jsonb(now() - make_interval(days => fixture.age_days)),
        'held', fixture.held,
        'holdReason', case when fixture.held then 'sanity' end
      ) || case when fixture.held then jsonb_build_object(
        'withheldStatus', 'instant_quote_received',
        'withheldResult', jsonb_build_object('unitPriceUsd', fixture.unit_price, 'totalPriceUsd', fixture.unit_price * fixture.quantity),
        'withheldOffers', '[]'::jsonb) else '{}'::jsonb end
    ) end,
  now() - make_interval(days => fixture.age_days)
from (values
  -- id, run, vendor, status, quantity, unit price, cheapest unit, lead days, held, package, age days
  ('83700000-5eed-4000-8000-000000000901'::uuid, '83700000-5eed-4000-8000-000000000804'::uuid,
   'xometry', 'instant_quote_received', 1, 41.50::numeric, 41.50::numeric, 10, false, 'bracket-a', 20),
  ('83700000-5eed-4000-8000-000000000902'::uuid, '83700000-5eed-4000-8000-000000000801'::uuid,
   'xometry', 'instant_quote_received', 1, 43.00::numeric, 42.25::numeric, 10, false, 'bracket-a', 2),
  ('83700000-5eed-4000-8000-000000000903'::uuid, '83700000-5eed-4000-8000-000000000801'::uuid,
   'fictiv', 'instant_quote_received', 1, 47.80::numeric, 47.80::numeric, 12, false, 'bracket-a', 2),
  ('83700000-5eed-4000-8000-000000000904'::uuid, '83700000-5eed-4000-8000-000000000801'::uuid,
   'protolabs', 'instant_quote_received', 1, 52.10::numeric, 52.10::numeric, 7, false, 'bracket-a', 2),
  ('83700000-5eed-4000-8000-000000000905'::uuid, '83700000-5eed-4000-8000-000000000801'::uuid,
   'xometry', 'manual_review_pending', 10, 4.10::numeric, 4.10::numeric, 10, true, 'bracket-a', 2),
  ('83700000-5eed-4000-8000-000000000906'::uuid, '83700000-5eed-4000-8000-000000000802'::uuid,
   'sendcutsend', 'instant_quote_received', 1, 12.40::numeric, 12.40::numeric, 5, false, 'plate-b', 5),
  ('83700000-5eed-4000-8000-000000000907'::uuid, '83700000-5eed-4000-8000-000000000802'::uuid,
   'oshcut', 'instant_quote_received', 1, 13.05::numeric, 13.05::numeric, 6, false, 'plate-b', 5),
  ('83700000-5eed-4000-8000-000000000908'::uuid, '83700000-5eed-4000-8000-000000000803'::uuid,
   'xometry', 'official_quote_received', 1, 88.00::numeric, 88.00::numeric, 15, false, 'housing-c', 7),
  ('83700000-5eed-4000-8000-000000000909'::uuid, '83700000-5eed-4000-8000-000000000803'::uuid,
   'fictiv', 'failed', 1, null::numeric, null::numeric, null, false, null, 7)
) as fixture(id, run_id, vendor, status, quantity, unit_price, cheapest_unit, lead_days, held, package, age_days)
join public.quote_runs run on run.id = fixture.run_id
-- One fixture part per fixture job.
join public.parts part on part.job_id = run.job_id and part.id::text like '83700000-5eed-%'
-- OVD-813 package and requirement keys per fixture part (the smoke read keys on bracket-a).
left join (values
  ('bracket-a', '72ec5db52d4ceedb5fe0c5307532cf276f420f967a4ddd3399fa7a8772e703c3', '5c3214c2161433cf4d41c94986a49465856df6d942b24208b3da6908c4039ac0'),
  ('plate-b', 'd1ac733d7a61f42fd4b5708156d876ab8ae0f9b60e801f6b6ab3cc5b1efceb61', '6fe15353d2b999e93bf88fc2ab6635b2322946675d05aa733d2825436aa516b6'),
  ('housing-c', '982edb5d7868760f4160d55dedf1a227761aa89fc3dde1be9ddc05a18bab60cd', 'a3be75cac5e8ef87037578eb419c9244a36aacc0375d525b641e925d5812b27d')
) as package(package, package_id, requirement_key) on package.package = fixture.package
on conflict (id) do update
  set created_at = excluded.created_at
  where public.vendor_quote_results.created_at < now() - interval '60 days';

-- OVD-722 kill switch rows: one per provider plus the global singleton. The
-- migration seeds them; this only restores a missing row, and a restored row
-- is ENGAGED (fail closed: staging must not start quoting a provider because a
-- seed recreated its switch). An existing row is never touched, so the seed can
-- neither engage nor release a switch someone already set.
insert into private.provider_kill_switches (provider, engaged, reason, engaged_at)
select provider, true, 'Recreated engaged by the OVD-837 staging seed (row was missing).', now()
from unnest(enum_range(null::public.vendor_name)) as provider
on conflict (provider) do nothing;

insert into private.provider_global_kill_switch (singleton, engaged, reason, engaged_at)
values (true, true, 'Recreated engaged by the OVD-837 staging seed (row was missing).', now())
on conflict (singleton) do nothing;
