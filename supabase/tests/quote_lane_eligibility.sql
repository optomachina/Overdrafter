begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data
) values (
  '81000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'quote-lanes@example.test',
  timezone('utc', now()),
  '{"provider":"email"}'::jsonb
);

insert into public.organizations (id, name, slug)
values (
  '81000000-0000-4000-8000-000000000002',
  'Quote Lane Test',
  'quote-lane-test'
);

insert into public.organization_memberships (organization_id, user_id, role)
values (
  '81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000001',
  'client'
);

insert into public.jobs (
  id, organization_id, created_by, title, status, requested_service_kinds
) values (
  '81000000-0000-4000-8000-000000000003',
  '81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000001',
  'Lane fixture',
  'ready_to_quote',
  '{manufacturing_quote}'::text[]
);

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
) values (
  '81000000-0000-4000-8000-000000000004',
  '81000000-0000-4000-8000-000000000002',
  repeat('a', 64),
  repeat('a', 64),
  'job-files',
  'quote-lane-test/cad.step',
  100,
  'application/step'
);

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
) values (
  '81000000-0000-4000-8000-000000000005',
  '81000000-0000-4000-8000-000000000003',
  '81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000004',
  repeat('a', 64),
  repeat('a', 64),
  'job-files',
  'quote-lane-test/cad.step',
  'lane.step',
  'lane',
  'cad',
  'application/step',
  100
);

insert into public.parts (
  id, job_id, organization_id, name, normalized_key, cad_file_id, quantity
) values (
  '81000000-0000-4000-8000-000000000006',
  '81000000-0000-4000-8000-000000000003',
  '81000000-0000-4000-8000-000000000002',
  'Lane part',
  'lane',
  '81000000-0000-4000-8000-000000000005',
  1
);

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, quantity,
  quote_quantities, applicable_vendors, spec_snapshot
) values (
  '81000000-0000-4000-8000-000000000006',
  '81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000001',
  '6061-T6 Aluminum',
  1,
  '{1,10}'::integer[],
  '{xometry,fictiv}'::public.vendor_name[],
  '{"process":"CNC machining"}'::jsonb
);

insert into public.quote_requests (
  id, organization_id, job_id, requested_by, requested_vendors, status
) values (
  '81000000-0000-4000-8000-000000000007',
  '81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000003',
  '81000000-0000-4000-8000-000000000001',
  '{xometry,fictiv}'::public.vendor_name[],
  'received'
);

insert into public.quote_runs (
  id, quote_request_id, job_id, organization_id, initiated_by, status
) values (
  '81000000-0000-4000-8000-000000000008',
  '81000000-0000-4000-8000-000000000007',
  '81000000-0000-4000-8000-000000000003',
  '81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000001',
  'completed'
);

insert into public.vendor_quote_results (
  id, quote_run_id, part_id, organization_id, vendor, requested_quantity,
  status, total_price_usd
) values
  (
    '81000000-0000-4000-8000-000000000009',
    '81000000-0000-4000-8000-000000000008',
    '81000000-0000-4000-8000-000000000006',
    '81000000-0000-4000-8000-000000000002',
    'xometry',
    1,
    'instant_quote_received',
    125
  ),
  (
    '81000000-0000-4000-8000-000000000010',
    '81000000-0000-4000-8000-000000000008',
    '81000000-0000-4000-8000-000000000006',
    '81000000-0000-4000-8000-000000000002',
    'fictiv',
    1,
    'instant_quote_received',
    135
  );

select public.api_register_quote_request_lane(
  '81000000-0000-4000-8000-000000000009',
  private.build_quote_lane_scope_snapshot(
    '81000000-0000-4000-8000-000000000006', 'xometry', 1
  )
);

select public.api_register_quote_request_lane(
  '81000000-0000-4000-8000-000000000010',
  private.build_quote_lane_scope_snapshot(
    '81000000-0000-4000-8000-000000000006', 'fictiv', 1
  )
);

insert into public.vendor_quote_offers (
  id, vendor_quote_result_id, organization_id, offer_key, supplier,
  lane_label, unit_price_usd, total_price_usd, quoted_at,
  validity_duration_days, validity_source, validity_terms,
  provenance_status, raw_payload
) values
  (
    '81000000-0000-4000-8000-000000000011',
    '81000000-0000-4000-8000-000000000009',
    '81000000-0000-4000-8000-000000000002',
    'xometry-1',
    'Xometry',
    'Instant',
    125,
    125,
    '2026-08-12 00:00:00+00',
    30,
    'vendor_duration',
    'Pricing valid for 30 days',
    'trusted_adapter',
    '{"source":"xometry-live-adapter"}'::jsonb
  ),
  (
    '81000000-0000-4000-8000-000000000012',
    '81000000-0000-4000-8000-000000000010',
    '81000000-0000-4000-8000-000000000002',
    'fictiv-1',
    'Fictiv',
    'Instant',
    135,
    135,
    '2026-08-12 00:00:00+00',
    null,
    null,
    null,
    'trusted_adapter',
    '{"source":"fictiv-live-adapter"}'::jsonb
  );

select is(
  (
    select valid_until
    from public.vendor_quote_offers
    where id = '81000000-0000-4000-8000-000000000011'
  ),
  '2026-09-11 00:00:00+00'::timestamptz,
  'duration validity derives a commercial expiration date'
);

select is(
  (
    select state
    from private.resolve_quote_lane_eligibility(
      '81000000-0000-4000-8000-000000000003',
      '{xometry}'::public.vendor_name[],
      '2026-08-20 00:00:00+00'
    )
    where requested_quantity = 1
  ),
  'valid_quote',
  'an unexpired trusted selectable offer covers only its exact lane'
);

select is(
  (
    select state
    from private.resolve_quote_lane_eligibility(
      '81000000-0000-4000-8000-000000000003',
      '{fictiv}'::public.vendor_name[],
      timezone('utc', now())
    )
    where requested_quantity = 1
  ),
  'cooldown',
  'unknown commercial validity uses the organization-wide cooldown'
);

select is(
  (
    select state
    from private.resolve_quote_lane_eligibility(
      '81000000-0000-4000-8000-000000000003',
      '{xometry}'::public.vendor_name[],
      '2026-08-20 00:00:00+00'
    )
    where requested_quantity = 10
  ),
  'requestable',
  'a different quantity remains immediately requestable'
);

update public.approved_part_requirements
set finish = 'Black anodize'
where part_id = '81000000-0000-4000-8000-000000000006';

select is(
  (
    select state
    from private.resolve_quote_lane_eligibility(
      '81000000-0000-4000-8000-000000000003',
      '{xometry}'::public.vendor_name[],
      '2026-08-20 00:00:00+00'
    )
    where requested_quantity = 1
  ),
  'requestable',
  'changed disclosed requirements produce a new requestable scope'
);

update public.approved_part_requirements
set finish = null
where part_id = '81000000-0000-4000-8000-000000000006';

update public.vendor_quote_offers
set valid_until = '2026-08-13 00:00:00+00', validity_duration_days = 1
where id = '81000000-0000-4000-8000-000000000011';

select is(
  (
    select state
    from private.resolve_quote_lane_eligibility(
      '81000000-0000-4000-8000-000000000003',
      '{xometry}'::public.vendor_name[],
      '2026-08-14 00:00:00+00'
    )
    where requested_quantity = 1
  ),
  'requestable',
  'an expired historical offer no longer permanently blocks its lane'
);

update public.quote_request_lanes
set created_at = timezone('utc', now()) - interval '25 hours'
where vendor = 'fictiv';

select is(
  (
    select state
    from private.resolve_quote_lane_eligibility(
      '81000000-0000-4000-8000-000000000003',
      '{fictiv}'::public.vendor_name[],
      timezone('utc', now())
    )
    where requested_quantity = 1
  ),
  'requestable',
  'unknown validity does not lock the lane after the cooldown expires'
);

select is(
  (
    select count(*)::integer
    from private.resolve_quote_lane_eligibility(
      '81000000-0000-4000-8000-000000000003',
      '{xometry,fictiv}'::public.vendor_name[],
      timezone('utc', now())
    )
    where state = 'requestable'
  ),
  3,
  'mixed vendor and quantity selection keeps covered and uncovered lanes separate'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000001', true);

create temporary table quote_lane_submission (response jsonb) on commit drop;
insert into quote_lane_submission
select private.request_scoped_automatic_quote_impl(
  '81000000-0000-4000-8000-000000000003',
  '{xometry,fictiv}'::public.vendor_name[]
);

select is(
  (
    select count(*)::integer
    from public.vendor_quote_results result
    join quote_lane_submission submission
      on result.quote_run_id = (submission.response ->> 'quoteRunId')::uuid
  ),
  3,
  'partial coverage queues only uncovered vendor and quantity lanes'
);

update public.vendor_quote_offers
set
  quoted_at = null,
  valid_until = null,
  validity_duration_days = null,
  validity_source = null,
  validity_terms = null,
  raw_payload = '{
    "source":"xometry-live-adapter",
    "quotedAt":"2026-08-12T00:00:00Z",
    "validUntil":"2026-08-16",
    "validForDays":"30",
    "validityTerms":"Valid through August 16; portal also displayed 30 days"
  }'::jsonb
where id = '81000000-0000-4000-8000-000000000011';

select is(
  (
    select jsonb_build_object(
      'duration', validity_duration_days,
      'source', validity_source,
      'terms', validity_terms
    )
    from public.vendor_quote_offers
    where id = '81000000-0000-4000-8000-000000000011'
  ),
  '{
    "duration": 5,
    "source": "vendor_date",
    "terms": "Valid through August 16; portal also displayed 30 days"
  }'::jsonb,
  'an explicit validity date wins conflicting duration terms while preserving the original wording'
);

select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.api_request_quote_scoped(uuid,public.vendor_name[])'::regprocedure
    ),
    'private.resolve_organization_entitlements_at'
  ) > 0,
  'the scoped submission keeps the server-authoritative Pro entitlement gate'
);

select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'public.api_request_quote(uuid,boolean)'::regprocedure
    ),
    'request_scoped_automatic_quote_impl(p_job_id, null)'
  ) > 0
  and pg_catalog.strpos(
    lower(pg_catalog.pg_get_functiondef(
      'public.api_request_quote(uuid,boolean)'::regprocedure
    )),
    'if p_force_retry'
  ) = 0,
  'the compatibility wrapper cannot use client force retry to bypass lane controls'
);

select ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'private.request_scoped_automatic_quote_impl(uuid,public.vendor_name[])'::regprocedure,
    'EXECUTE'
  ),
  'authenticated callers cannot bypass the entitlement wrapper'
);

select ok(
  not pg_catalog.has_table_privilege(
    'authenticated', 'public.quote_request_lanes', 'SELECT'
  ),
  'authenticated callers receive eligibility without internal scope fingerprints'
);

select * from finish();

rollback;
