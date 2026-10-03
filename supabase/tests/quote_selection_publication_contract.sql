-- Source-only pgTAP contract for the selection-write/publication-source migration.
-- Runtime owner executes in a disposable local database after applying the pending migration.
-- No provider calls, customer data, runtime setup, or migration application occurs here.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(45);

select ok(not has_table_privilege('anon', 'public.client_selections', 'UPDATE'), 'anon has no table UPDATE grant');
select ok(not has_any_column_privilege('anon', 'public.client_selections', 'UPDATE'), 'anon has no column UPDATE grant, including inherited grants');

select ok(not has_table_privilege('authenticated', 'public.client_selections', 'UPDATE'), 'authenticated has no table UPDATE grant');
select ok(not has_any_column_privilege('authenticated', 'public.client_selections', 'UPDATE'), 'authenticated has no column UPDATE grant, including inherited grants');

select ok(not has_table_privilege('service_role', 'public.client_selections', 'UPDATE'), 'service_role has no table UPDATE grant');
select ok(not has_any_column_privilege('service_role', 'public.client_selections', 'UPDATE'), 'service_role has no column UPDATE grant, including inherited grants');
select ok(not has_function_privilege('anon', 'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)', 'EXECUTE'), 'anon cannot call the publication helper');
select ok(not has_function_privilege('authenticated', 'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)', 'EXECUTE'), 'authenticated cannot call the publication helper');
select ok(not has_function_privilege('service_role', 'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)', 'EXECUTE'), 'service_role cannot call the publication helper');
select ok(has_function_privilege('postgres', 'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)', 'EXECUTE'), 'postgres retains owner access to the publication helper');

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('ec420002-1002-4000-8000-000000000001', 'authenticated', 'authenticated', 'publication-contract@example.test', now(), '{"provider":"email"}'::jsonb);
insert into public.organizations (id, name, slug) values
  ('ec420002-1002-4000-8000-000000000002', 'Publication contract fixture', 'publication-contract-ec420002'),
  ('ec420002-1002-4000-8000-000000000020', 'Other synthetic organization', 'publication-contract-other-ec420002');
insert into public.organization_memberships (organization_id, user_id, role)
values ('ec420002-1002-4000-8000-000000000002', 'ec420002-1002-4000-8000-000000000001', 'internal_estimator');
insert into public.pricing_policies (id, organization_id, version, markup_percent, currency_minor_unit)
values ('ec420002-1002-4000-8000-000000000003', 'ec420002-1002-4000-8000-000000000002', 'publication-contract', 20, 0.01);
insert into public.jobs (id, organization_id, created_by, title, status, active_pricing_policy_id)
values ('ec420002-1002-4000-8000-000000000004', 'ec420002-1002-4000-8000-000000000002', 'ec420002-1002-4000-8000-000000000001', 'Synthetic publication contract', 'internal_review', 'ec420002-1002-4000-8000-000000000003');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values ('ec420002-1002-4000-8000-000000000005', 'ec420002-1002-4000-8000-000000000004', 'ec420002-1002-4000-8000-000000000002', 'Synthetic publication part', 'publication-contract-part');
insert into public.quote_runs (id, job_id, organization_id, initiated_by, status)
values ('ec420002-1002-4000-8000-000000000006', 'ec420002-1002-4000-8000-000000000004', 'ec420002-1002-4000-8000-000000000002', 'ec420002-1002-4000-8000-000000000001', 'completed');
insert into public.vendor_quote_results (id, quote_run_id, part_id, organization_id, vendor, requested_quantity, status, total_price_usd, lead_time_business_days)
values ('ec420002-1002-4000-8000-000000000007', 'ec420002-1002-4000-8000-000000000006', 'ec420002-1002-4000-8000-000000000005', 'ec420002-1002-4000-8000-000000000002', 'xometry', 1, 'instant_quote_received', 100, 7);
insert into public.published_quote_packages (id, job_id, quote_run_id, organization_id, published_by, pricing_policy_id, client_summary)
values ('ec420002-1002-4000-8000-000000000008', 'ec420002-1002-4000-8000-000000000004', 'ec420002-1002-4000-8000-000000000006', 'ec420002-1002-4000-8000-000000000002', 'ec420002-1002-4000-8000-000000000001', 'ec420002-1002-4000-8000-000000000003', 'preserve existing summary');
-- An existing legacy package/option/selection makes parent rollback observable,
-- including restoring options and selections temporarily deleted by republication.
insert into public.published_quote_options (id, package_id, organization_id, requested_quantity, option_kind, label, published_price_usd, source_vendor_quote_id, markup_policy_version)
values ('ec420002-1002-4000-8000-000000000009', 'ec420002-1002-4000-8000-000000000008', 'ec420002-1002-4000-8000-000000000002', 1, 'lowest_cost', 'Preserve existing option', 120, 'ec420002-1002-4000-8000-000000000007', 'publication-contract');
insert into public.client_selections (id, package_id, option_id, organization_id, selected_by, note)
values ('ec420002-1002-4000-8000-000000000010', 'ec420002-1002-4000-8000-000000000008', 'ec420002-1002-4000-8000-000000000009', 'ec420002-1002-4000-8000-000000000002', 'ec420002-1002-4000-8000-000000000001', 'Preserve existing selection');
create function pg_temp.publication_contract_state() returns jsonb language sql as $$
  select jsonb_build_object(
    'jobs', (select jsonb_agg(to_jsonb(j) order by j.id) from public.jobs j where organization_id = 'ec420002-1002-4000-8000-000000000002'),
    'runs', (select jsonb_agg(to_jsonb(r) order by r.id) from public.quote_runs r where organization_id = 'ec420002-1002-4000-8000-000000000002'),
    'packages', (select jsonb_agg(to_jsonb(p) order by p.id) from public.published_quote_packages p where organization_id = 'ec420002-1002-4000-8000-000000000002'),
    'options', (select jsonb_agg(to_jsonb(o) order by o.id) from public.published_quote_options o where organization_id = 'ec420002-1002-4000-8000-000000000002'),
    'selections', (select jsonb_agg(to_jsonb(s) order by s.id) from public.client_selections s where organization_id = 'ec420002-1002-4000-8000-000000000002'),
    'audit', (select jsonb_agg(to_jsonb(a) order by a.id) from public.audit_events a where organization_id = 'ec420002-1002-4000-8000-000000000002')
  );
$$;
create temporary table publication_contract_before (state jsonb) on commit drop;
insert into publication_contract_before select pg_temp.publication_contract_state();
select set_config('request.jwt.claim.sub', 'ec420002-1002-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"ec420002-1002-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
select throws_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract')$$, 'P0001', 'Publication requires one exact matching source offer.', 'helper rejects a result with no source offers');
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'missing source helper leaves existing publication state unchanged');
set local role authenticated;
select throws_ok($$select public.api_publish_quote_package('ec420002-1002-4000-8000-000000000004', 'ec420002-1002-4000-8000-000000000006', 'replacement summary', true)$$, 'P0001', 'Publication requires one exact matching source offer.', 'internal parent rejects no-offer result after starting republication');
reset role;
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'parent failure rolls back package, deleted options/selections, job/run status, and audit');

-- A single exact source preserves legacy null-validity compatibility.
insert into public.vendor_quote_offers (id, vendor_quote_result_id, organization_id, offer_key, supplier, lane_label, total_price_usd, lead_time_business_days, sort_rank, provenance_status) values
  ('ec420002-1002-4000-8000-000000000011', 'ec420002-1002-4000-8000-000000000007', 'ec420002-1002-4000-8000-000000000002', 'exact-legacy', 'Synthetic', 'Exact legacy', 100, 7, 99, 'trusted_adapter');
select lives_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract')$$, 'omitted source resolves a sole exactly matching offer');
select is((select source_vendor_quote_offer_id from public.published_quote_options where id = 'ec420002-1002-4000-8000-000000000009'), 'ec420002-1002-4000-8000-000000000011'::uuid,
  'helper persists the sole exact offer identity');
select is((select published_price_usd from public.published_quote_options where id = 'ec420002-1002-4000-8000-000000000009'), 120.00::numeric,
  'helper retains deterministic markup arithmetic');
select is((select valid_until from public.vendor_quote_offers where id = 'ec420002-1002-4000-8000-000000000011'), null::timestamptz,
  'exact linked offer retains unknown legacy validity');
set local role authenticated;
select lives_ok($$select public.api_publish_quote_package('ec420002-1002-4000-8000-000000000004', 'ec420002-1002-4000-8000-000000000006', 'replacement summary', true)$$, 'verified internal parent publishes a unique exact-source legacy offer');
reset role;
select is((select count(*)::integer from public.published_quote_options where package_id = 'ec420002-1002-4000-8000-000000000008' and source_vendor_quote_offer_id = 'ec420002-1002-4000-8000-000000000011'), 1,
  'parent publication creates one exactly linked option');
select is((select status::text from public.jobs where id = 'ec420002-1002-4000-8000-000000000004'), 'published', 'successful parent updates job status');
select is((select count(*)::integer from public.audit_events where job_id = 'ec420002-1002-4000-8000-000000000004' and event_type = 'job.quote_package_published'), 1,
  'successful parent emits one publication audit event');

-- Multiple variants require an explicit identity even if only one matches.
insert into public.vendor_quote_offers (id, vendor_quote_result_id, organization_id, offer_key, supplier, lane_label, total_price_usd, lead_time_business_days, sort_rank, provenance_status) values
  ('ec420002-1002-4000-8000-000000000012', 'ec420002-1002-4000-8000-000000000007', 'ec420002-1002-4000-8000-000000000002', 'wrong-price', 'Synthetic', 'Wrong price', 90, 7, 0, 'trusted_adapter'),
  ('ec420002-1002-4000-8000-000000000013', 'ec420002-1002-4000-8000-000000000007', 'ec420002-1002-4000-8000-000000000002', 'wrong-lead', 'Synthetic', 'Wrong lead', 100, 3, 1, 'trusted_adapter');
update publication_contract_before set state = pg_temp.publication_contract_state();
select throws_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract')$$, 'P0001', 'Publication requires one exact matching source offer.', 'omitted source rejects multiple variants even when only one matches commercial fields');
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'variant ambiguity cannot replace existing publication state');

-- Seed the persisted selection as owner, then attempt an actual BYPASSRLS-role
-- rewrite to an expired option. Revoking table UPDATE alone misses column grants.
insert into public.client_selections (id, package_id, option_id, organization_id, selected_by)
select 'ec420002-1002-4000-8000-000000000010', 'ec420002-1002-4000-8000-000000000008', id, 'ec420002-1002-4000-8000-000000000002', 'ec420002-1002-4000-8000-000000000001'
from public.published_quote_options where package_id = 'ec420002-1002-4000-8000-000000000008' and option_kind = 'lowest_cost';
update public.vendor_quote_offers set valid_until = clock_timestamp() - interval '7 days' where id = 'ec420002-1002-4000-8000-000000000012';
insert into public.published_quote_options (id, package_id, organization_id, requested_quantity, option_kind, label, published_price_usd, source_vendor_quote_id, source_vendor_quote_offer_id, markup_policy_version)
values ('ec420002-1002-4000-8000-000000000022', 'ec420002-1002-4000-8000-000000000008', 'ec420002-1002-4000-8000-000000000002', 1, 'fastest_delivery', 'Expired legacy target', 108, 'ec420002-1002-4000-8000-000000000007', 'ec420002-1002-4000-8000-000000000012', 'publication-contract');

update publication_contract_before set state = pg_temp.publication_contract_state();
set local role service_role;
select throws_ok($$update public.client_selections set option_id = 'ec420002-1002-4000-8000-000000000022' where id = 'ec420002-1002-4000-8000-000000000010'$$, '42501', null, 'service_role cannot rewrite an existing selection to an expired option');
reset role;
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'rejected service-role rewrite preserves selection and all publication state');

update public.vendor_quote_offers set invalidated_at = clock_timestamp(), invalidated_by = 'ec420002-1002-4000-8000-000000000001', invalidation_reason = 'Synthetic withdrawn target'
where id = 'ec420002-1002-4000-8000-000000000012';
update publication_contract_before set state = pg_temp.publication_contract_state();
set local role service_role;
select throws_ok($$update public.client_selections set option_id = 'ec420002-1002-4000-8000-000000000022' where id = 'ec420002-1002-4000-8000-000000000010'$$,
  '42501', null, 'service_role cannot redirect a selection to an invalidated option');
select throws_ok($$update public.client_selections set package_id = 'ec420002-1002-4000-8000-000000000099' where id = 'ec420002-1002-4000-8000-000000000010'$$,
  '42501', null, 'service_role package identity rewrite is denied before foreign-key validation');
select throws_ok($$update public.client_selections set organization_id = 'ec420002-1002-4000-8000-000000000020' where id = 'ec420002-1002-4000-8000-000000000010'$$,
  '42501', null, 'service_role cannot rewrite selection organization identity');
reset role;
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'rejected source and identity rewrites preserve all selection state');

insert into public.vendor_quote_offers (id, vendor_quote_result_id, organization_id, offer_key, supplier, lane_label, total_price_usd, lead_time_business_days, sort_rank, provenance_status)
values ('ec420002-1002-4000-8000-000000000014', 'ec420002-1002-4000-8000-000000000007', 'ec420002-1002-4000-8000-000000000002', 'duplicate-exact', 'Synthetic', 'Second exact offer', 100, 7, 100, 'trusted_adapter');

update publication_contract_before set state = pg_temp.publication_contract_state();
select throws_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract')$$, 'P0001', 'Publication requires one exact matching source offer.', 'omitted source rejects two exact matches even with different sort ranks');
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'ambiguity cannot rewrite an existing option');
select lives_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract', 'ec420002-1002-4000-8000-000000000011')$$, 'explicit exact source disambiguates two otherwise matching offers');

update publication_contract_before set state = pg_temp.publication_contract_state();
select throws_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract', 'ec420002-1002-4000-8000-000000000012')$$, 'P0001', 'Publication requires one exact matching source offer.', 'explicit source with mismatched total is rejected');
select throws_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract', 'ec420002-1002-4000-8000-000000000013')$$, 'P0001', 'Publication requires one exact matching source offer.', 'explicit source with mismatched lead time is rejected');
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'explicit pricing or lead mismatch does not mutate publication state');

insert into public.vendor_quote_results (id, quote_run_id, part_id, organization_id, vendor, requested_quantity, status, total_price_usd, lead_time_business_days)
values ('ec420002-1002-4000-8000-000000000021', 'ec420002-1002-4000-8000-000000000006', 'ec420002-1002-4000-8000-000000000005', 'ec420002-1002-4000-8000-000000000002', 'fictiv', 1, 'instant_quote_received', 100, 7);
insert into public.vendor_quote_offers (id, vendor_quote_result_id, organization_id, offer_key, supplier, lane_label, total_price_usd, lead_time_business_days, provenance_status) values
  ('ec420002-1002-4000-8000-000000000015', 'ec420002-1002-4000-8000-000000000021', 'ec420002-1002-4000-8000-000000000002', 'wrong-result', 'Synthetic', 'Other result', 100, 7, 'trusted_adapter'),
  ('ec420002-1002-4000-8000-000000000016', 'ec420002-1002-4000-8000-000000000007', 'ec420002-1002-4000-8000-000000000020', 'wrong-org', 'Synthetic', 'Other organization', 100, 7, 'trusted_adapter');

update publication_contract_before set state = pg_temp.publication_contract_state();
select throws_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract', 'ec420002-1002-4000-8000-000000000015')$$, 'P0001', 'Publication requires one exact matching source offer.', 'explicit source belonging to another result is rejected');
select throws_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract', 'ec420002-1002-4000-8000-000000000016')$$, 'P0001', 'Publication requires one exact matching source offer.', 'explicit source belonging to another organization is rejected');
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'result or organization mismatch preserves publication state');

update public.vendor_quote_offers set unit_price_usd = 100 where id = 'ec420002-1002-4000-8000-000000000011';
update publication_contract_before set state = pg_temp.publication_contract_state();
select throws_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract', 'ec420002-1002-4000-8000-000000000011')$$,
  'P0001', 'Publication requires one exact matching source offer.', 'explicit unit-price mismatch is rejected even with matching total and lead');
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'unit-price mismatch prevents publication writes');
update public.vendor_quote_offers set unit_price_usd = null where id = 'ec420002-1002-4000-8000-000000000011';

update public.vendor_quote_offers set valid_until = clock_timestamp() - interval '7 days' where id = 'ec420002-1002-4000-8000-000000000011';

update publication_contract_before set state = pg_temp.publication_contract_state();
select throws_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract', 'ec420002-1002-4000-8000-000000000011')$$, 'P0001', 'Quote offer has expired and cannot be published.', 'explicit matching but expired source is rejected');
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'expiry prevents publication writes');

update public.vendor_quote_offers set valid_until = clock_timestamp() + interval '7 days', invalidated_at = clock_timestamp(), invalidated_by = 'ec420002-1002-4000-8000-000000000001', invalidation_reason = 'Synthetic withdrawn source' where id = 'ec420002-1002-4000-8000-000000000011';

update publication_contract_before set state = pg_temp.publication_contract_state();
select throws_ok($$select public.insert_published_quote_option('ec420002-1002-4000-8000-000000000008', 'lowest_cost'::public.client_option_kind, 'ec420002-1002-4000-8000-000000000007', 1, 20, 0.01, 'publication-contract', 'ec420002-1002-4000-8000-000000000011')$$, 'P0001', 'Quote offer has been invalidated and cannot be published.', 'explicit matching but invalidated future source is rejected');
select is(pg_temp.publication_contract_state(), (select state from publication_contract_before), 'invalidation prevents publication writes');

select * from finish();
rollback;
