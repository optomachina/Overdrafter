begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(29);

select ok(
  (select coalesce(reloptions, '{}'::text[]) @> array['security_invoker=true']
   from pg_catalog.pg_class where oid = 'public.extraction_quality_summary'::regclass),
  'the summary uses caller privileges rather than view-owner privileges'
);
select ok(not has_table_privilege('anon', 'public.extraction_quality_summary', 'SELECT'),
  'anon has no effective summary SELECT grant');
select ok(not has_table_privilege('authenticated', 'public.extraction_quality_summary', 'SELECT'),
  'authenticated has no effective summary SELECT grant');
select ok(not has_any_column_privilege('anon', 'public.extraction_quality_summary', 'SELECT'),
  'anon has no inherited or column-level summary access');
select ok(not has_any_column_privilege('authenticated', 'public.extraction_quality_summary', 'SELECT'),
  'authenticated has no inherited or column-level summary access');
select ok(has_table_privilege('service_role', 'public.extraction_quality_summary', 'SELECT'),
  'privileged monitoring retains summary access');
select ok(has_table_privilege('service_role', 'public.audit_events', 'SELECT'),
  'privileged monitoring already has the underlying audit access');
select ok(not has_function_privilege('anon', 'public.evaluate_extraction_quality_alerts(date)', 'EXECUTE'),
  'anon cannot invoke the privileged evaluator');
select ok(not has_function_privilege('authenticated', 'public.evaluate_extraction_quality_alerts(date)', 'EXECUTE'),
  'authenticated cannot invoke the privileged evaluator');

insert into public.organizations (id, name, slug) values
  ('00000000-0000-4000-8000-000000005101', 'Summary security fixture A', 'summary-security-fixture-a'),
  ('00000000-0000-4000-8000-000000005102', 'Summary security fixture B', 'summary-security-fixture-b');
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000005111', 'authenticated', 'authenticated',
   'summary-client@example.test', now(), '{"provider":"email"}'::jsonb),
  ('00000000-0000-4000-8000-000000005112', 'authenticated', 'authenticated',
   'summary-internal@example.test', now(), '{"provider":"email"}'::jsonb);
insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-000000005101', '00000000-0000-4000-8000-000000005111', 'client'),
  ('00000000-0000-4000-8000-000000005101', '00000000-0000-4000-8000-000000005112', 'internal_estimator');
insert into public.audit_events (organization_id, event_type, created_at, payload) values
  ('00000000-0000-4000-8000-000000005101', 'worker.extraction_completed', '2099-01-10 01:00:00+00',
   '{"autoApproved":true,"extractionStatus":"approved","modelFallbackUsed":false}'::jsonb),
  ('00000000-0000-4000-8000-000000005101', 'worker.extraction_completed', '2099-01-10 02:00:00+00',
   '{"autoApproved":false,"extractionStatus":"needs_review","extractionLifecycle":"partial","warningCount":2,"modelFallbackUsed":true}'::jsonb),
  ('00000000-0000-4000-8000-000000005101', 'worker.extraction_failed', '2099-01-10 03:00:00+00', '{}'::jsonb),
  ('00000000-0000-4000-8000-000000005102', 'worker.extraction_completed', '2099-01-10 04:00:00+00',
   '{"autoApproved":true,"modelFallbackUsed":false}'::jsonb);

set local role anon;
select throws_ok('select organization_id, completed_extractions from public.extraction_quality_summary',
  '42501', null, 'anonymous callers cannot read organization identities or aggregates');
select throws_ok($$select public.evaluate_extraction_quality_alerts(date '2099-01-10')$$,
  '42501', null, 'anonymous callers cannot cause privileged alert evaluation');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000005111', true);
set local role authenticated;
select throws_ok('select organization_id, completed_extractions from public.extraction_quality_summary',
  '42501', null, 'ordinary customers cannot read the operational summary');
select throws_ok($$select public.evaluate_extraction_quality_alerts(date '2099-01-10')$$,
  '42501', null, 'ordinary customers cannot cause privileged alert evaluation');
select is((select count(*)::integer from public.audit_events
  where organization_id in ('00000000-0000-4000-8000-000000005101', '00000000-0000-4000-8000-000000005102')),
  0, 'base audit RLS still denies ordinary customers in both organizations');
reset role;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000005112', true);
set local role authenticated;
select throws_ok('select organization_id, completed_extractions from public.extraction_quality_summary',
  '42501', null, 'internal membership does not turn the summary into a client API');
select is((select count(*)::integer from public.audit_events
  where organization_id = '00000000-0000-4000-8000-000000005101'),
  3, 'internal users retain authorized organization audit access');
select is((select count(*)::integer from public.audit_events
  where organization_id = '00000000-0000-4000-8000-000000005102'),
  0, 'internal users cannot cross the organization audit boundary');
reset role;

set local role service_role;
select is((select count(*)::integer from public.extraction_quality_summary
  where organization_id in ('00000000-0000-4000-8000-000000005101', '00000000-0000-4000-8000-000000005102')),
  2, 'service monitoring still reads the two separate organization groups');
select is((select completed_extractions from public.extraction_quality_summary
  where organization_id = '00000000-0000-4000-8000-000000005101' and day = date '2099-01-10'),
  2, 'only completed events contribute to organization A');
select is((select auto_approve_rate from public.extraction_quality_summary
  where organization_id = '00000000-0000-4000-8000-000000005101' and day = date '2099-01-10'),
  0.5000::numeric, 'organization A auto-approval rate is unchanged');
select is((select model_fallback_rate from public.extraction_quality_summary
  where organization_id = '00000000-0000-4000-8000-000000005101' and day = date '2099-01-10'),
  0.5000::numeric, 'organization A fallback rate is unchanged');
select is((select completed_extractions from public.extraction_quality_summary
  where organization_id = '00000000-0000-4000-8000-000000005102' and day = date '2099-01-10'),
  1, 'organization B retains its independent count');
select is((select auto_approve_rate from public.extraction_quality_summary
  where organization_id = '00000000-0000-4000-8000-000000005102' and day = date '2099-01-10'),
  1.0000::numeric, 'organization B auto-approval rate is unchanged');
select is((select model_fallback_rate from public.extraction_quality_summary
  where organization_id = '00000000-0000-4000-8000-000000005102' and day = date '2099-01-10'),
  0.0000::numeric, 'organization B fallback rate is unchanged');
select is(public.evaluate_extraction_quality_alerts(date '2099-01-10'),
  2, 'the existing privileged evaluator still creates the two threshold alerts');
select is(public.evaluate_extraction_quality_alerts(date '2099-01-10'),
  0, 'privileged alert evaluation remains idempotent');
select is((select count(*)::integer from public.extraction_quality_alerts
  where organization_id = '00000000-0000-4000-8000-000000005101' and alert_day = date '2099-01-10'),
  2, 'only organization A has threshold alerts');
select is((select count(*)::integer from public.extraction_quality_alerts
  where organization_id = '00000000-0000-4000-8000-000000005102' and alert_day = date '2099-01-10'),
  0, 'healthy organization B receives no alert');
reset role;

select columns_are('public', 'extraction_quality_summary', array[
  'organization_id', 'day', 'completed_extractions', 'auto_approved_extractions',
  'needs_review_extractions', 'partial_lifecycle_extractions', 'warning_extractions',
  'model_fallback_extractions', 'auto_approve_rate', 'model_fallback_rate'
], 'the hardening preserves the exact aggregate-only output contract');

select * from finish();
rollback;
