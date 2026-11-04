-- OVD-829: re-run, rollback and re-apply drill for
-- supabase/migrations/20261104032100_ovd829_provider_daily_quote_cap.sql.
--
-- fixtures/ovd829_provider_daily_quote_cap.inc is a byte copy of the migration
-- and fixtures/ovd829_rollback.inc a byte copy of
-- docs/migration-drafts/ovd-829.rollback.sql (pinned by
-- scripts/run-supabase-policy-tests.node-test.mjs).
--
-- Covers:
--   * the applied bodies are the ones the migration guard names
--   * re-running the migration is a no-op that keeps a cap already set
--   * the rollback restores the OVD-767 and OVD-722 bodies byte for byte
--     (md5), their grants, drops every OVD-829 object and changes no
--     supplier's on/off state; re-running the rollback is a no-op
--   * the migration re-applies on the rolled back schema, with every row
--     unlimited again (no backfill)
-- Synthetic changes only; everything rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(16);

create function pg_temp.ovd829_md5(p_signature text)
returns text
language sql
stable
set search_path = pg_catalog
as $$
  select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure(p_signature);
$$;

create temp table ovd829_switch_state on commit drop as
select provider, engaged from private.provider_kill_switches;

-- ---------------------------------------------------------------------
-- Applied state
-- ---------------------------------------------------------------------
select is(
  pg_temp.ovd829_md5('public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)')
    || ' ' || pg_temp.ovd829_md5('public.api_admin_list_provider_kill_switches()'),
  '3fb90f240be8141453f95d74abe7e6ed 47235811f7e1e294aa04724cfe572694',
  'the applied kill-switch bodies are the OVD-829 bodies the guard accepts');

-- ---------------------------------------------------------------------
-- Re-running the migration is a no-op and keeps data
-- ---------------------------------------------------------------------
update private.provider_kill_switches set daily_quote_cap = 7 where provider = 'xometry';
insert into private.provider_daily_quote_usage (provider, usage_date, count)
values ('xometry', pg_catalog.timezone('UTC', pg_catalog.now())::date, 3)
on conflict (provider, usage_date) do update set count = 3;

\ir fixtures/ovd829_provider_daily_quote_cap.inc

select is(
  pg_temp.ovd829_md5('public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)')
    || ' ' || pg_temp.ovd829_md5('public.api_admin_list_provider_kill_switches()'),
  '3fb90f240be8141453f95d74abe7e6ed 47235811f7e1e294aa04724cfe572694',
  're-running the migration leaves the same bodies');
select results_eq(
  $$select s.daily_quote_cap, u.count
    from private.provider_kill_switches s
    join private.provider_daily_quote_usage u
      on u.provider = s.provider and u.usage_date = pg_catalog.timezone('UTC', pg_catalog.now())::date
    where s.provider = 'xometry'$$,
  $$values (7, 3)$$,
  're-running the migration keeps a cap already set and today''s usage');

-- ---------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------
\ir fixtures/ovd829_rollback.inc

select is(
  pg_temp.ovd829_md5('public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)'),
  '09f76c673f7e13f2e49fe6faed0c44d3',
  'rollback restores the OVD-767 api_admin_set_provider_kill_switch body byte for byte');
select is(
  pg_temp.ovd829_md5('public.api_admin_list_provider_kill_switches()'),
  '568ff534f3ad60f4d4754b6e7f754a74',
  'rollback restores the OVD-722 api_admin_list_provider_kill_switches body byte for byte');
select ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_catalog.pg_proc p
   where p.oid in ('public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)'::regprocedure,
                   'public.api_admin_list_provider_kill_switches()'::regprocedure))
    and has_function_privilege('authenticated', 'public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.api_admin_list_provider_kill_switches()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.api_admin_list_provider_kill_switches()', 'EXECUTE'),
  'rollback restores SECURITY DEFINER, search_path and grants on both functions');
select ok(
  pg_catalog.to_regprocedure('public.api_worker_reserve_provider_dispatch(public.vendor_name)') is null
    and pg_catalog.to_regprocedure('public.api_worker_provider_settings_state(public.vendor_name)') is null
    and pg_catalog.to_regprocedure('public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint)') is null
    and pg_catalog.to_regprocedure('public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)') is null
    and pg_catalog.to_regprocedure('private.write_provider_settings(uuid, public.vendor_name, boolean, boolean, integer, text, bigint)') is null,
  'rollback drops every OVD-829 function');
select ok(
  pg_catalog.to_regclass('private.provider_daily_quote_usage') is null
    and not exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid in ('private.provider_kill_switches'::regclass, 'private.provider_kill_switch_audit'::regclass)
        and a.attname in ('daily_quote_cap', 'previous_daily_quote_cap') and not a.attisdropped)
    and not exists (
      select 1 from pg_catalog.pg_constraint
      where conname = 'provider_kill_switches_daily_quote_cap_check'),
  'rollback drops the usage table, the cap columns and the cap check');
select set_eq(
  $$select provider, engaged from private.provider_kill_switches$$,
  $$select provider, engaged from ovd829_switch_state$$,
  'rollback changes no supplier''s on/off state');

\ir fixtures/ovd829_rollback.inc

select is(
  pg_temp.ovd829_md5('public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)')
    || ' ' || pg_temp.ovd829_md5('public.api_admin_list_provider_kill_switches()'),
  '09f76c673f7e13f2e49fe6faed0c44d3 568ff534f3ad60f4d4754b6e7f754a74',
  're-running the rollback is a no-op');

-- The restored OVD-767 body still writes its audit row on the rolled back table.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000829101', 'authenticated', 'authenticated',
  'ovd829-rollback-admin@example.test', pg_catalog.now(), '{"provider":"email"}'::jsonb);
insert into private.platform_admin_emails (email) values ('ovd829-rollback-admin@example.test')
on conflict do nothing;
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims',
  '{"sub": "00000000-0000-4000-8000-000000829101", "role": "authenticated", "aal": "aal2"}', true);
select is(
  public.api_admin_set_provider_kill_switch('weerg', true, 'OVD-829 rollback drill: engage') ->> 'engaged',
  'true', 'the restored kill-switch RPC engages a supplier');
reset role;
select is(
  (select pg_catalog.count(*)::int from private.provider_kill_switch_audit
   where reason = 'OVD-829 rollback drill: engage' and actor = '00000000-0000-4000-8000-000000829101'),
  1, 'the restored kill-switch RPC writes its audit row');

-- ---------------------------------------------------------------------
-- Re-apply on the rolled back schema
-- ---------------------------------------------------------------------
\ir fixtures/ovd829_provider_daily_quote_cap.inc

select is(
  pg_temp.ovd829_md5('public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)')
    || ' ' || pg_temp.ovd829_md5('public.api_admin_list_provider_kill_switches()'),
  '3fb90f240be8141453f95d74abe7e6ed 47235811f7e1e294aa04724cfe572694',
  'the migration re-applies on the rolled back schema');
select ok(
  not exists (select 1 from private.provider_kill_switches where daily_quote_cap is not null),
  're-applied: every supplier is unlimited (no default cap, no backfill)');
select is(
  (select pg_catalog.count(*)::int from private.provider_daily_quote_usage),
  0, 're-applied: the usage counter starts empty');
select ok(
  has_function_privilege('service_role', 'public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.api_worker_reserve_provider_dispatch(public.vendor_name)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint)', 'EXECUTE'),
  're-applied: the grants are back');

select * from finish();
rollback;
