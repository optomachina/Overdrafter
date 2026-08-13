begin;

create extension if not exists pgtap with schema extensions;

select plan(24);

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

insert into public.vendor_quote_offers (
  id, vendor_quote_result_id, organization_id, offer_key, supplier,
  lane_label, unit_price_usd, total_price_usd,
  validity_terms, provenance_status, raw_payload
) values (
  '81000000-0000-4000-8000-000000000013',
  '81000000-0000-4000-8000-000000000010',
  '81000000-0000-4000-8000-000000000002',
  'fictiv-operator-duration',
  'Fictiv',
  'Manual',
  140,
  140,
  'Valid for 10 days',
  'manual_verified',
  '{
    "source":"manual-quote-admin-inbox",
    "validityDurationDays":"10",
    "validitySource":"operator_duration"
  }'::jsonb
);

select ok(
  (
    select quoted_at is not null
      and valid_until = quoted_at + interval '10 days'
    from public.vendor_quote_offers
    where id = '81000000-0000-4000-8000-000000000013'
  ),
  'operator duration validity anchors to the trusted capture timestamp'
);

insert into public.vendor_quote_offers (
  id, vendor_quote_result_id, organization_id, offer_key, supplier,
  lane_label, unit_price_usd, total_price_usd, provenance_status, raw_payload
) values (
  '81000000-0000-4000-8000-000000000014',
  '81000000-0000-4000-8000-000000000010',
  '81000000-0000-4000-8000-000000000002',
  'fictiv-conflicting-validity',
  'Fictiv',
  'Manual alternate',
  145,
  145,
  'manual_verified',
  '{
    "source":"manual-quote-admin-inbox",
    "quotedAt":"2026-08-12T00:00:00Z",
    "validUntil":"2026-08-31",
    "validityDurationDays":"90",
    "validitySource":"operator_duration"
  }'::jsonb
);

select ok(
  (
    select quoted_at = '2026-08-12 00:00:00+00'::timestamptz
      and validity_source = 'operator_date'
      and valid_until = '2026-08-31 23:59:59.999999+00'::timestamptz
      and validity_duration_days = 20
    from public.vendor_quote_offers
    where id = '81000000-0000-4000-8000-000000000014'
  ),
  'an explicit validity date wins when vendor terms also provide a duration'
);

select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(
      'private.anchor_operator_quote_validity()'::regprocedure
    ),
    'new.quoted_at := v_raw_quoted_at::timestamptz'
  ) > 0,
  'the deployed anchor preserves an explicit payload quote timestamp'
);

insert into public.vendor_quote_offers (
  id, vendor_quote_result_id, organization_id, offer_key, supplier,
  lane_label, unit_price_usd, total_price_usd, provenance_status, raw_payload
) values (
  '81000000-0000-4000-8000-000000000015',
  '81000000-0000-4000-8000-000000000010',
  '81000000-0000-4000-8000-000000000002',
  'fictiv-malformed-validity',
  'Fictiv',
  'Malformed legacy fixture',
  150,
  150,
  'manual_verified',
  '{
    "source":"manual-quote-admin-inbox",
    "quotedAt":"2026-08-12T00:00:00+99",
    "validityDurationDays":"10",
    "validitySource":"operator_duration"
  }'::jsonb
);

select ok(
  (
    select quoted_at is null
      and valid_until is null
      and validity_duration_days is null
      and validity_source is null
    from public.vendor_quote_offers
    where id = '81000000-0000-4000-8000-000000000015'
  ),
  'malformed timestamp subclasses leave commercial validity unknown without aborting'
);

update public.vendor_quote_offers
set invalidated_at = timezone('utc', now()),
    invalidated_by = '81000000-0000-4000-8000-000000000001',
    invalidation_reason = 'Keep validity normalization fixtures out of lane coverage.'
where id in (
  '81000000-0000-4000-8000-000000000013',
  '81000000-0000-4000-8000-000000000014',
  '81000000-0000-4000-8000-000000000015'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000001', true);

update public.jobs
set selected_vendor_quote_offer_id = '81000000-0000-4000-8000-000000000011'
where id = '81000000-0000-4000-8000-000000000003';

select ok(
  (
    with workspace as (
      select public.api_list_client_quote_workspace(
        array['81000000-0000-4000-8000-000000000003']::uuid[]
      ) -> 0 as payload
    )
    select not (
      select projected_offer ? 'invalidated_by'
        or projected_offer ? 'invalidation_reason'
      from workspace,
        pg_catalog.jsonb_array_elements(
          workspace.payload -> 'vendorQuotes' -> 0 -> 'offers'
        ) projected_offer
      limit 1
    )
    and not (workspace.payload -> 'selectedOffer' ? 'invalidated_by')
    and not (workspace.payload -> 'selectedOffer' ? 'invalidation_reason')
    from workspace
  ),
  'client quote projection omits privileged invalidation metadata'
);

update public.jobs
set selected_vendor_quote_offer_id = null
where id = '81000000-0000-4000-8000-000000000003';

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
set valid_until = timezone('utc', now()) - interval '1 hour',
    validity_duration_days = 1
where id = '81000000-0000-4000-8000-000000000011';

update public.quote_request_lanes
set created_at = timezone('utc', now()) - interval '25 hours'
where vendor = 'xometry';

select is(
  (
    select state
    from private.resolve_quote_lane_eligibility(
      '81000000-0000-4000-8000-000000000003',
      '{xometry}'::public.vendor_name[],
      timezone('utc', now())
    )
    where requested_quantity = 1
  ),
  'requestable',
  'an expired historical offer no longer permanently blocks its lane'
);

update public.vendor_quote_offers
set valid_until = timezone('utc', now()) + interval '1 day'
where id = '81000000-0000-4000-8000-000000000011';

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
      'private.require_automatic_quote_access(uuid)'::regprocedure
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

reset role;

update public.jobs
set selected_vendor_quote_offer_id = '81000000-0000-4000-8000-000000000011'
where id = '81000000-0000-4000-8000-000000000003';

insert into private.platform_admin_capabilities (
  user_id, capability, granted_by_user_id, grant_reason
) values (
  '81000000-0000-4000-8000-000000000001',
  'billing_admin',
  '81000000-0000-4000-8000-000000000001',
  'Quote offer invalidation acceptance test'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',
  true
);

select throws_ok(
  $$
    select public.api_admin_invalidate_vendor_quote_offer(
      '81000000-0000-4000-8000-000000000011',
      'Vendor withdrew pricing',
      'invalidate-aal1'
    )
  $$,
  'P0001',
  'Multi-factor authentication is required for this commercial operation.',
  'quote invalidation requires an AAL2 session'
);

reset role;
update private.commercial_rollout_controls
set enabled = true,
    revision = revision + 1,
    change_reason = 'Enable quote invalidation acceptance test'
where capability = 'commercial_admin_mutations';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',
  true
);

select lives_ok(
  $$
    select public.api_admin_invalidate_vendor_quote_offer(
      '81000000-0000-4000-8000-000000000011',
      'Vendor withdrew pricing',
      'invalidate-aal2'
    )
  $$,
  'AAL2 billing admins can invalidate with a reason and idempotency key'
);

reset role;

select ok(
  (
    select offer.invalidated_at is not null
      and offer.invalidation_reason = 'Vendor withdrew pricing'
    from public.vendor_quote_offers offer
    where offer.id = '81000000-0000-4000-8000-000000000011'
  )
  and exists (
    select 1
    from public.commercial_admin_audit_events event
    where event.action = 'commercial.quote_offer.invalidate'
      and event.target_id = '81000000-0000-4000-8000-000000000011'
  )
  and exists (
    select 1
    from public.quote_request_lanes lane
    where lane.vendor_quote_result_id = '81000000-0000-4000-8000-000000000009'
      and lane.cooldown_released_at is not null
  ),
  'invalidation is persisted, append-only audited, and releases one lane cooldown'
);

select is(
  (
    select job.selected_vendor_quote_offer_id
    from public.jobs job
    where job.id = '81000000-0000-4000-8000-000000000003'
  ),
  null::uuid,
  'invalidation atomically clears a job currently selecting the withdrawn offer'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"81000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',
  true
);

select throws_ok(
  $$
    select public.api_set_job_selected_vendor_quote_offer(
      '81000000-0000-4000-8000-000000000003',
      '81000000-0000-4000-8000-000000000011'
    )
  $$,
  'P0001',
  'Offer 81000000-0000-4000-8000-000000000011 has been invalidated and cannot be selected.',
  'authenticated clients cannot reselect an invalidated vendor offer'
);

reset role;

select * from finish();

rollback;
