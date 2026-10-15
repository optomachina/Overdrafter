-- Source-only acceptance fixture for 20261002041305_enforce_quote_selection_expiry.sql.
-- Synthetic local records only. Runtime owner applies the migration in its disposable
-- database before running this file; this fixture neither applies migrations nor dispatches quotes.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(32);

-- Fixed timestamps cover the inclusive boundary without racing a wall clock.
select ok(private.quote_offer_valid_at('2026-10-02 12:00:00+00', '2026-10-02 12:00:00+00'),
  'validity includes the exact deadline');
select ok(not private.quote_offer_valid_at('2026-10-02 12:00:00+00', '2026-10-02 12:00:00.000001+00'),
  'one microsecond after the deadline is expired');
select ok(private.quote_offer_valid_at('2026-10-02 12:00:00+00', '2026-10-02 11:59:59.999999+00'),
  'one microsecond before the deadline is valid');
select ok(private.quote_offer_valid_at(null, '2026-10-02 12:00:00+00'),
  'legacy unknown validity preserves linked-offer compatibility');
select ok(not private.quote_offer_valid_at(null, null),
  'a missing evaluation time cannot establish validity');
select ok(
  not has_table_privilege('anon', 'public.client_selections', 'INSERT')
  and not has_table_privilege('authenticated', 'public.client_selections', 'INSERT')
  and not has_table_privilege('service_role', 'public.client_selections', 'INSERT'),
  'API roles cannot bypass selection RPCs through direct INSERT, including inherited grants');

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('ec410002-1002-4000-8000-000000000001', 'authenticated', 'authenticated', 'quote-selection-expiry@example.test', now(), '{"provider":"email"}'::jsonb);
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('ec410002-1002-4000-8000-000000000020', 'authenticated', 'authenticated', 'quote-selection-expiry-internal@example.test', now(), '{"provider":"email"}'::jsonb);
insert into public.organizations (id, name, slug)
values ('ec410002-1002-4000-8000-000000000002', 'Quote selection expiry fixture', 'quote-selection-expiry-ec410002');
insert into public.organization_memberships (organization_id, user_id, role)
values ('ec410002-1002-4000-8000-000000000002', 'ec410002-1002-4000-8000-000000000001', 'client');
insert into public.organization_memberships (organization_id, user_id, role)
values ('ec410002-1002-4000-8000-000000000002', 'ec410002-1002-4000-8000-000000000020', 'internal_estimator');
insert into public.pricing_policies (id, organization_id, version, markup_percent, currency_minor_unit)
values ('ec410002-1002-4000-8000-000000000003', 'ec410002-1002-4000-8000-000000000002', 'expiry-fixture', 20, 0.01);
insert into public.jobs (id, organization_id, created_by, title, status, active_pricing_policy_id)
values ('ec410002-1002-4000-8000-000000000004', 'ec410002-1002-4000-8000-000000000002', 'ec410002-1002-4000-8000-000000000001', 'Synthetic expiry selection', 'internal_review', 'ec410002-1002-4000-8000-000000000003');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values ('ec410002-1002-4000-8000-000000000005', 'ec410002-1002-4000-8000-000000000004', 'ec410002-1002-4000-8000-000000000002', 'Expiry fixture part', 'expiry-fixture-part');
insert into public.quote_runs (id, job_id, organization_id, initiated_by, status)
values ('ec410002-1002-4000-8000-000000000006', 'ec410002-1002-4000-8000-000000000004', 'ec410002-1002-4000-8000-000000000002', 'ec410002-1002-4000-8000-000000000001', 'completed');
insert into public.vendor_quote_results (id, quote_run_id, part_id, organization_id, vendor, requested_quantity, status, total_price_usd)
values ('ec410002-1002-4000-8000-000000000007', 'ec410002-1002-4000-8000-000000000006', 'ec410002-1002-4000-8000-000000000005', 'ec410002-1002-4000-8000-000000000002', 'xometry', 1, 'instant_quote_received', 100);

-- Broad relative windows keep RPC cases repeatable on any runtime date. The helper
-- above tests equality; RPCs must sample server wall time after acquiring write locks.
insert into public.vendor_quote_offers (
  id, vendor_quote_result_id, organization_id, offer_key, supplier, lane_label,
  unit_price_usd, total_price_usd, valid_until, provenance_status, raw_payload
) values
  ('ec410002-1002-4000-8000-000000000011', 'ec410002-1002-4000-8000-000000000007', 'ec410002-1002-4000-8000-000000000002', 'expiry-expired', 'Synthetic supplier', 'Expired', 100, 100, clock_timestamp() - interval '7 days', 'trusted_adapter', '{"source":"synthetic-expiry-fixture"}'::jsonb),
  ('ec410002-1002-4000-8000-000000000012', 'ec410002-1002-4000-8000-000000000007', 'ec410002-1002-4000-8000-000000000002', 'expiry-future', 'Synthetic supplier', 'Future', 100, 100, clock_timestamp() + interval '7 days', 'trusted_adapter', '{"source":"synthetic-expiry-fixture"}'::jsonb),
  ('ec410002-1002-4000-8000-000000000013', 'ec410002-1002-4000-8000-000000000007', 'ec410002-1002-4000-8000-000000000002', 'expiry-legacy', 'Synthetic supplier', 'Legacy unknown validity', 100, 100, null, 'trusted_adapter', '{"source":"synthetic-expiry-fixture"}'::jsonb),
  ('ec410002-1002-4000-8000-000000000014', 'ec410002-1002-4000-8000-000000000007', 'ec410002-1002-4000-8000-000000000002', 'expiry-invalidated', 'Synthetic supplier', 'Invalidated future', 100, 100, clock_timestamp() + interval '7 days', 'trusted_adapter', '{"source":"synthetic-expiry-fixture"}'::jsonb);
update public.vendor_quote_offers
set invalidated_at = clock_timestamp(), invalidated_by = 'ec410002-1002-4000-8000-000000000001', invalidation_reason = 'Synthetic withdrawn offer'
where id = 'ec410002-1002-4000-8000-000000000014';

insert into public.published_quote_packages (id, job_id, quote_run_id, organization_id, published_by, pricing_policy_id)
values ('ec410002-1002-4000-8000-000000000008', 'ec410002-1002-4000-8000-000000000004', 'ec410002-1002-4000-8000-000000000006', 'ec410002-1002-4000-8000-000000000002', 'ec410002-1002-4000-8000-000000000001', 'ec410002-1002-4000-8000-000000000003');
insert into public.published_quote_options (
  id, package_id, organization_id, option_kind, label, published_price_usd,
  source_vendor_quote_id, source_vendor_quote_offer_id, markup_policy_version
) values ('ec410002-1002-4000-8000-000000000009', 'ec410002-1002-4000-8000-000000000008', 'ec410002-1002-4000-8000-000000000002', 'lowest_cost', 'Synthetic expiry option', 120,
  'ec410002-1002-4000-8000-000000000007', 'ec410002-1002-4000-8000-000000000011', 'expiry-fixture');

-- Snapshot complete rows as postgres: authenticated RLS must not hide unexpected
-- writes. Include existing successful selections when checking later rejections.
create function pg_temp.quote_expiry_state() returns jsonb language sql as $$
  select jsonb_build_object(
    'job', (select to_jsonb(j) from public.jobs j where j.id = 'ec410002-1002-4000-8000-000000000004'),
    'selections', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb)
      from public.client_selections s where s.package_id = 'ec410002-1002-4000-8000-000000000008'),
    'audit', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb)
      from public.audit_events a where a.organization_id = 'ec410002-1002-4000-8000-000000000002')
  );
$$;
create temporary table quote_expiry_before (state jsonb) on commit drop;
insert into quote_expiry_before select pg_temp.quote_expiry_state();
select set_config('request.jwt.claim.sub', 'ec410002-1002-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"ec410002-1002-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);

set local role authenticated;
select throws_ok($$select public.api_set_job_selected_vendor_quote_offer('ec410002-1002-4000-8000-000000000004', 'ec410002-1002-4000-8000-000000000011')$$, 'P0001', 'Quote offer has expired and cannot be selected.', 'direct selection rejects an expired offer');
reset role;
select is(pg_temp.quote_expiry_state(), (select state from quote_expiry_before),
  'direct selection rejects an expired offer: no job, selection, or audit writes');

set local role authenticated;
select throws_ok($$select public.api_select_quote_option('ec410002-1002-4000-8000-000000000008', 'ec410002-1002-4000-8000-000000000009', 'synthetic expiry test')$$, 'P0001', 'Quote offer has expired and cannot be selected.', 'published selection rejects its expired source');
reset role;
select is(pg_temp.quote_expiry_state(), (select state from quote_expiry_before),
  'published selection rejects its expired source: no job, selection, or audit writes');

-- Even a commercially valid offer must go through the checked write boundary.
set local role authenticated;
select throws_ok($$insert into public.client_selections (package_id, option_id, organization_id, selected_by)
  values ('ec410002-1002-4000-8000-000000000008', 'ec410002-1002-4000-8000-000000000009',
    'ec410002-1002-4000-8000-000000000002', 'ec410002-1002-4000-8000-000000000001')$$,
  '42501', null, 'authenticated direct client selection insertion is denied');
reset role;
-- This internal member passes jobs_update_internal RLS. A trigger error proves
-- the guard actually ran, rather than an UPDATE silently touching zero rows.
select set_config('request.jwt.claim.sub', 'ec410002-1002-4000-8000-000000000020', true);
select set_config('request.jwt.claims', '{"sub":"ec410002-1002-4000-8000-000000000020","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$update public.jobs
  set selected_vendor_quote_offer_id = 'ec410002-1002-4000-8000-000000000012'
  where id = 'ec410002-1002-4000-8000-000000000004'$$,
  'P0001', 'Select quote offers through the guarded selection API.',
  'authenticated direct job offer assignment is denied');
select throws_ok($$insert into public.jobs (id, organization_id, created_by, title, status, selected_vendor_quote_offer_id)
  values ('ec410002-1002-4000-8000-000000000021', 'ec410002-1002-4000-8000-000000000002',
    'ec410002-1002-4000-8000-000000000020', 'Rejected synthetic selection bypass', 'internal_review',
    'ec410002-1002-4000-8000-000000000012')$$,
  'P0001', 'Select quote offers through the guarded selection API.',
  'authenticated direct job insertion with a non-null offer is denied');
reset role;
select is(pg_temp.quote_expiry_state(), (select state from quote_expiry_before),
  'direct-write attempts leave job, selections, and audit unchanged');
select is((select count(*)::integer from public.jobs where id = 'ec410002-1002-4000-8000-000000000021'), 0,
  'rejected insertion creates no extra job');
select set_config('request.jwt.claim.sub', 'ec410002-1002-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"ec410002-1002-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);

update public.published_quote_options set source_vendor_quote_offer_id = 'ec410002-1002-4000-8000-000000000012' where id = 'ec410002-1002-4000-8000-000000000009';

set local role authenticated;
select lives_ok($$select public.api_set_job_selected_vendor_quote_offer('ec410002-1002-4000-8000-000000000004', 'ec410002-1002-4000-8000-000000000012')$$, 'direct selection accepts a future deadline');
select lives_ok($$select public.api_select_quote_option('ec410002-1002-4000-8000-000000000008', 'ec410002-1002-4000-8000-000000000009', 'synthetic expiry test')$$, 'published selection accepts a future deadline');
reset role;
select is((select selected_vendor_quote_offer_id from public.jobs where id = 'ec410002-1002-4000-8000-000000000004'), 'ec410002-1002-4000-8000-000000000012'::uuid,
  'direct selection persists the exact future offer');
select is((select status::text from public.jobs where id = 'ec410002-1002-4000-8000-000000000004'), 'client_selected',
  'published selection changes job status');
select is((select count(*)::integer from public.client_selections where package_id = 'ec410002-1002-4000-8000-000000000008' and option_id = 'ec410002-1002-4000-8000-000000000009' and selected_by = 'ec410002-1002-4000-8000-000000000001'), 1,
  'future selection records the authenticated user and exact published option');
select is((select count(*)::integer from public.audit_events where package_id = 'ec410002-1002-4000-8000-000000000008' and event_type = 'client.quote_option_selected'), 1,
  'future published selection emits one audit event');

update public.published_quote_options set source_vendor_quote_offer_id = 'ec410002-1002-4000-8000-000000000013' where id = 'ec410002-1002-4000-8000-000000000009';

set local role authenticated;
select lives_ok($$select public.api_set_job_selected_vendor_quote_offer('ec410002-1002-4000-8000-000000000004', 'ec410002-1002-4000-8000-000000000013')$$, 'direct selection accepts legacy null validity');
select lives_ok($$select public.api_select_quote_option('ec410002-1002-4000-8000-000000000008', 'ec410002-1002-4000-8000-000000000009', 'synthetic expiry test')$$, 'published selection accepts its linked legacy null-validity offer');
reset role;
select is((select selected_vendor_quote_offer_id from public.jobs where id = 'ec410002-1002-4000-8000-000000000004'), 'ec410002-1002-4000-8000-000000000013'::uuid,
  'legacy selection persists the exact linked offer');
select is((select count(*)::integer from public.client_selections where package_id = 'ec410002-1002-4000-8000-000000000008'), 2,
  'legacy published selection adds one selection');
select is((select count(*)::integer from public.audit_events where package_id = 'ec410002-1002-4000-8000-000000000008' and event_type = 'client.quote_option_selected'), 2,
  'legacy published selection adds one audit event');

update public.published_quote_options set source_vendor_quote_offer_id = null where id = 'ec410002-1002-4000-8000-000000000009';

update quote_expiry_before set state = pg_temp.quote_expiry_state();

set local role authenticated;
select throws_ok($$select public.api_select_quote_option('ec410002-1002-4000-8000-000000000008', 'ec410002-1002-4000-8000-000000000009', 'synthetic expiry test')$$, 'P0001', 'Published option has no matching source offer and cannot be selected.', 'published selection rejects a missing source despite other available offers');
reset role;
select is(pg_temp.quote_expiry_state(), (select state from quote_expiry_before),
  'published selection rejects a missing source despite other available offers: no job, selection, or audit writes');

update public.published_quote_options set source_vendor_quote_offer_id = 'ec410002-1002-4000-8000-000000000014' where id = 'ec410002-1002-4000-8000-000000000009';

update quote_expiry_before set state = pg_temp.quote_expiry_state();

set local role authenticated;
select throws_ok($$select public.api_set_job_selected_vendor_quote_offer('ec410002-1002-4000-8000-000000000004', 'ec410002-1002-4000-8000-000000000014')$$, 'P0001', 'Offer ec410002-1002-4000-8000-000000000014 has been invalidated and cannot be selected.', 'direct selection rejects an invalidated future offer');
reset role;
select is(pg_temp.quote_expiry_state(), (select state from quote_expiry_before),
  'direct selection rejects an invalidated future offer: no job, selection, or audit writes');

set local role authenticated;
select throws_ok($$select public.api_select_quote_option('ec410002-1002-4000-8000-000000000008', 'ec410002-1002-4000-8000-000000000009', 'synthetic expiry test')$$, 'P0001', 'Quote offer has been invalidated and cannot be selected.', 'published selection rejects an invalidated future source');
reset role;
select is(pg_temp.quote_expiry_state(), (select state from quote_expiry_before),
  'published selection rejects an invalidated future source: no job, selection, or audit writes');

select * from finish();
rollback;
