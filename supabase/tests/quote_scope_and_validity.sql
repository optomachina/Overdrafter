begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

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

select lives_ok(
  $$select public.api_register_trusted_file_hash(
    '81000000-0000-4000-8000-000000000005', repeat('a', 64)
  )$$,
  'service workflow can register a worker-computed file digest'
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

select lives_ok(
  $$select public.api_register_quote_request_lane(
    '81000000-0000-4000-8000-000000000009',
    jsonb_build_object(
      'schema', 'quote-lane-scope.v1',
      'vendor', 'xometry',
      'quantity', 1,
      'part', jsonb_build_object(
        'id', '81000000-0000-4000-8000-000000000006',
        'cad', jsonb_build_object(
          'fileId', '81000000-0000-4000-8000-000000000005',
          'sha256', repeat('a', 64),
          'name', 'lane.step'
        ),
        'drawing', null
      ),
      'requirements', jsonb_build_object('material', '6061-T6 Aluminum')
    )
  )$$,
  'worker registers the exact lane immediately before disclosure'
);

select lives_ok(
  $$select public.api_register_quote_request_lane(
    '81000000-0000-4000-8000-000000000010',
    jsonb_build_object(
      'schema', 'quote-lane-scope.v1',
      'vendor', 'fictiv',
      'quantity', 1,
      'part', jsonb_build_object(
        'id', '81000000-0000-4000-8000-000000000006',
        'cad', jsonb_build_object(
          'fileId', '81000000-0000-4000-8000-000000000005',
          'sha256', repeat('a', 64),
          'name', 'lane.step'
        ),
        'drawing', null
      ),
      'requirements', jsonb_build_object('material', '6061-T6 Aluminum')
    )
  )$$,
  'each selected vendor receives its own disclosure lane'
);

select throws_ok(
  $$select public.api_register_quote_request_lane(
    '81000000-0000-4000-8000-000000000009',
    jsonb_build_object(
      'schema', 'quote-lane-scope.v1',
      'vendor', 'xometry',
      'quantity', 1,
      'part', jsonb_build_object(
        'id', '81000000-0000-4000-8000-000000000006',
        'cad', jsonb_build_object(
          'fileId', '81000000-0000-4000-8000-000000000005',
          'sha256', repeat('a', 64),
          'name', 'lane.step'
        ),
        'drawing', null
      ),
      'requirements', jsonb_build_object('material', '7075 Aluminum')
    )
  )$$,
  'P0001',
  'Quote lane was already registered with a different immutable scope.',
  'a retry cannot rewrite an immutable lane'
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
    select valid_until
    from public.vendor_quote_offers
    where id = '81000000-0000-4000-8000-000000000012'
  ),
  null::timestamptz,
  'missing vendor validity remains unknown'
);

select is(
  (
    select count(*)::integer
    from public.quote_request_lanes
    where quote_request_id = '81000000-0000-4000-8000-000000000007'
  ),
  2,
  'vendor results attach immutable request lanes'
);

select is(
  (
    select count(distinct scope_fingerprint)::integer
    from public.quote_request_lanes
    where quote_request_id = '81000000-0000-4000-8000-000000000007'
  ),
  2,
  'vendor disclosure is part of the versioned lane fingerprint'
);

select * from finish();
rollback;
