begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(14);

select ok(to_regprocedure('public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)') is not null, -- NOSONAR: each ACL assertion pins the exact overload.
  'the exact quote-publication helper exists');
select ok((select prosecdef from pg_proc where oid = 'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)'::regprocedure),
  'the helper retains its security-definer contract');
select ok(not has_function_privilege('anon', 'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)', 'EXECUTE'), -- NOSONAR: exact role, overload and privilege are the security contract.
  'anon cannot execute the helper, including inherited PUBLIC grants');
select ok(not has_function_privilege('authenticated', 'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)', 'EXECUTE'), -- NOSONAR: exact role, overload and privilege are the security contract.
  'authenticated cannot execute the helper');
select ok(not has_function_privilege('service_role', 'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)', 'EXECUTE'),
  'service_role cannot bypass the guarded publication API');
select ok(has_function_privilege('postgres', 'public.insert_published_quote_option(uuid,public.client_option_kind,uuid,integer,numeric,numeric,text,uuid)', 'EXECUTE'),
  'the owner can still execute the helper from the guarded parent');
select ok(has_function_privilege('authenticated', 'public.api_publish_quote_package(uuid,uuid,text,boolean)', 'EXECUTE'),
  'authenticated callers retain the guarded publication API');

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000004191', 'authenticated', 'authenticated', 'publication-internal@example.test', now(), '{"provider":"email"}'::jsonb), -- NOSONAR: auth role and deterministic fixture ID intentionally repeat.
  ('00000000-0000-4000-8000-000000004192', 'authenticated', 'authenticated', 'publication-client@example.test', now(), '{"provider":"email"}'::jsonb); -- NOSONAR: auth role and deterministic fixture ID intentionally repeat.
insert into public.organizations (id, name, slug) values
  ('00000000-0000-4000-8000-000000004193', 'Publication security fixture', 'publication-security-fixture'); -- NOSONAR: deterministic organization ID is reused across fixture relationships.
insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-000000004193', '00000000-0000-4000-8000-000000004191', 'internal_estimator'),
  ('00000000-0000-4000-8000-000000004193', '00000000-0000-4000-8000-000000004192', 'client');
insert into public.pricing_policies (id, organization_id, version, markup_percent, currency_minor_unit) values
  ('00000000-0000-4000-8000-000000004194', '00000000-0000-4000-8000-000000004193', 'fixture', 20, 0.01);
insert into public.jobs (id, organization_id, created_by, title, status, active_pricing_policy_id) values
  ('00000000-0000-4000-8000-000000004195', '00000000-0000-4000-8000-000000004193', '00000000-0000-4000-8000-000000004191', 'Publication fixture', 'internal_review', '00000000-0000-4000-8000-000000004194'); -- NOSONAR: fixture keys intentionally match referenced rows.
insert into public.parts (id, job_id, organization_id, name, normalized_key) values
  ('00000000-0000-4000-8000-000000004196', '00000000-0000-4000-8000-000000004195', '00000000-0000-4000-8000-000000004193', 'Fixture part', 'fixture-part');
insert into public.quote_runs (id, job_id, organization_id, initiated_by, status) values
  ('00000000-0000-4000-8000-000000004197', '00000000-0000-4000-8000-000000004195', '00000000-0000-4000-8000-000000004193', '00000000-0000-4000-8000-000000004191', 'completed'); -- NOSONAR: fixture keys intentionally match referenced rows.
insert into public.vendor_quote_results (id, quote_run_id, part_id, organization_id, vendor, requested_quantity, status, total_price_usd) values
  ('00000000-0000-4000-8000-000000004198', '00000000-0000-4000-8000-000000004197', '00000000-0000-4000-8000-000000004196', '00000000-0000-4000-8000-000000004193', 'xometry', 1, 'instant_quote_received', 100); -- NOSONAR: fixture keys intentionally match referenced rows.

set local role anon;
select throws_ok($$select public.insert_published_quote_option('00000000-0000-4000-8000-000000004199', 'lowest_cost'::public.client_option_kind, '00000000-0000-4000-8000-000000004198', 1, 0, 0.01, 'attacker')$$, -- NOSONAR: repeated attack payload compares caller roles exactly.
  '42501', null, 'anon direct invocation is denied before the helper body'); -- NOSONAR: exact permission SQLSTATE is asserted for each role.
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000004192', true);
set local role authenticated;
select throws_ok($$select public.insert_published_quote_option('00000000-0000-4000-8000-000000004199', 'lowest_cost'::public.client_option_kind, '00000000-0000-4000-8000-000000004198', 1, 0, 0.01, 'attacker')$$,
  '42501', null, 'authenticated direct invocation is denied');
select throws_ok($$select public.api_publish_quote_package('00000000-0000-4000-8000-000000004195', '00000000-0000-4000-8000-000000004197', null, true)$$,
  'P0001', 'Only internal users can publish quote packages.', 'the guarded parent still rejects an ordinary client');
reset role;

set local role service_role;
select throws_ok($$select public.insert_published_quote_option('00000000-0000-4000-8000-000000004199', 'lowest_cost'::public.client_option_kind, '00000000-0000-4000-8000-000000004198', 1, 0, 0.01, 'attacker')$$,
  '42501', null, 'service_role direct invocation is denied');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000004191', true);
set local role authenticated;
select lives_ok($$select public.api_publish_quote_package('00000000-0000-4000-8000-000000004195', '00000000-0000-4000-8000-000000004197', null, true)$$,
  'verified internal user still publishes through the guarded parent');
reset role;

select is((select count(*)::integer from public.published_quote_options where source_vendor_quote_id = '00000000-0000-4000-8000-000000004198'), 1,
  'the guarded parent still creates one option');
select is((select published_price_usd from public.published_quote_options where source_vendor_quote_id = '00000000-0000-4000-8000-000000004198'), 120.00::numeric,
  'the guarded parent still uses the pricing policy, not caller-controlled markup');

select * from finish();
rollback;
