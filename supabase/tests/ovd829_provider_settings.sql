-- OVD-828 S1 (OVD-829): universal per-supplier settings (on/off + daily cap).
--
-- Targets supabase/migrations/20261104032100_ovd829_provider_daily_quote_cap.sql
-- (the promoted docs/migration-drafts/ovd-828-s1.sql), applied on top of
-- 20261013043100 (OVD-722), 20261015221725 (OVD-771) and 20261016000156
-- (OVD-767). The rollback drill is supabase/tests/ovd829_provider_settings_rollback.sql.
-- Pre-apply observation: every assertion that references the new functions or
-- columns fails with "does not exist".
--
-- Covers:
--   * shape: daily_quote_cap has no default (null = unlimited), existing rows
--     are not backfilled, <= 0 refused
--   * pg_proc: SECURITY DEFINER, search_path = '', grants (admin RPC
--     authenticated only; worker RPCs service_role only)
--   * api_admin_set_provider_settings refuses anon, service_role, a non-admin,
--     and an admin without AAL2; refuses cap <= 0; accepts null (unlimited);
--     compare and set; writes one audit row with the cap
--   * api_admin_set_provider_kill_switch still refuses an admin without AAL2
--     exactly as OVD-767 does (same message, SQLSTATE P0001) and preserves the cap
--   * api_service_set_provider_daily_quote_cap (the audited service-role cap
--     setter): service_role only; refuses a missing operator, a short reason,
--     a cap <= 0 and a missing or stale version; sets only the cap (never the
--     on/off state); audits actor cli:service_role with the operator and the
--     new and previous cap; the dispatch counter enforces the cap it set
--     (Xometry, the runbook example)
--   * api_worker_reserve_provider_dispatch: refuses at cap + 1, null never
--     refuses, engaged (supplier or global) returns provider_disabled whatever
--     the cap and counts nothing; a corrupt cap (<= 0) reads as no cap; counts per
--     UTC day (yesterday's spent cap does not carry over)
--   * api_admin_list_provider_kill_switches returns dailyQuoteCap and usedToday
--
-- Not covered here (needs two sessions): concurrent reservations at cap - 1.
-- The row lock that serializes them follows the ovd-722-race-check.sh pattern.
begin;

create extension if not exists pgtap with schema extensions;

select plan(58);

create function pg_temp.ovd829_as(p_user_id uuid, p_role text, p_aal text)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', p_user_id, 'role', p_role, 'aal', p_aal)::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', coalesce(p_user_id::text, ''), true);
end;
$$;

grant execute on function pg_temp.ovd829_as(uuid, text, text) to anon, authenticated, service_role;

-- The admin under test cannot read private; this reads the current version
-- for it, the way the admin page passes the version it was shown.
create function pg_temp.ovd829_version(p_provider public.vendor_name)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select s.version from private.provider_kill_switches s where s.provider = p_provider;
$$;

grant execute on function pg_temp.ovd829_version(public.vendor_name) to authenticated;

insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-000000829001', 'authenticated', 'authenticated', 'ovd829-admin@example.test', pg_catalog.now()),
  ('00000000-0000-4000-8000-000000829002', 'authenticated', 'authenticated', 'ovd829-member@example.test', pg_catalog.now());
insert into private.platform_admin_emails (email) values ('ovd829-admin@example.test')
on conflict do nothing;

-- Checked before the setup below touches any row: there is no default cap, so
-- the migration left every existing supplier row unlimited (no backfill).
select ok(
  exists (select 1 from private.provider_kill_switches)
    and not exists (select 1 from private.provider_kill_switches where daily_quote_cap is not null),
  'existing supplier rows are not backfilled with a cap');

-- Known starting point for the suppliers this suite uses.
update private.provider_kill_switches set engaged = false, daily_quote_cap = null
where provider in ('fictiv', 'rmfg', 'quickparts');
update private.provider_global_kill_switch set engaged = false where singleton;
delete from private.provider_daily_quote_usage;

-- ---------------------------------------------------------------------
-- Shape and grants
-- ---------------------------------------------------------------------
select is(
  (select pg_catalog.pg_get_expr(d.adbin, d.adrelid)
   from pg_catalog.pg_attrdef d
   join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'private.provider_kill_switches'::regclass and a.attname = 'daily_quote_cap'),
  null::text, 'daily_quote_cap has no default (null = unlimited)');
select throws_ok(
  $$update private.provider_kill_switches set daily_quote_cap = 0 where provider = 'fictiv'$$,
  '23514', null, 'the table refuses a cap of 0');
select ok(
  exists (select 1 from pg_catalog.pg_attribute
          where attrelid = 'private.provider_kill_switch_audit'::regclass
            and attname in ('daily_quote_cap', 'previous_daily_quote_cap')
          having pg_catalog.count(*) = 2),
  'the audit table carries the cap columns');

select ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_catalog.pg_proc p
   where p.oid in (
     'public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint)'::regprocedure,
     'public.api_admin_set_provider_kill_switch(public.vendor_name, boolean, text, bigint)'::regprocedure,
     'public.api_admin_list_provider_kill_switches()'::regprocedure,
     'public.api_worker_reserve_provider_dispatch(public.vendor_name)'::regprocedure,
     'public.api_worker_provider_settings_state(public.vendor_name)'::regprocedure,
     'public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)'::regprocedure)),
  'every public settings RPC is SECURITY DEFINER with search_path = ''''');

select ok(
  not has_function_privilege('public', 'public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.api_admin_set_provider_settings(public.vendor_name, boolean, integer, text, bigint)', 'EXECUTE'),
  'only authenticated may execute api_admin_set_provider_settings');
select ok(
  not has_function_privilege('anon', 'public.api_worker_reserve_provider_dispatch(public.vendor_name)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.api_worker_reserve_provider_dispatch(public.vendor_name)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.api_worker_reserve_provider_dispatch(public.vendor_name)', 'EXECUTE'),
  'only service_role may execute the dispatch counter');
select ok(
  not has_function_privilege('anon', 'public.api_worker_provider_settings_state(public.vendor_name)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.api_worker_provider_settings_state(public.vendor_name)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.api_worker_provider_settings_state(public.vendor_name)', 'EXECUTE'),
  'only service_role may execute the settings read');
select ok(
  not has_function_privilege('authenticated', 'private.write_provider_settings(uuid, public.vendor_name, boolean, boolean, integer, text, bigint)', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.write_provider_settings(uuid, public.vendor_name, boolean, boolean, integer, text, bigint)', 'EXECUTE'),
  'no API role may call the shared writer directly');
select ok(
  not has_function_privilege('public', 'public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.api_service_set_provider_daily_quote_cap(public.vendor_name, integer, text, text, bigint)', 'EXECUTE'),
  'only service_role may execute the service cap setter');
select ok(
  not has_table_privilege('service_role', 'private.provider_daily_quote_usage', 'UPDATE')
    and not has_table_privilege('authenticated', 'private.provider_daily_quote_usage', 'SELECT'),
  'no API role touches the usage table directly');

-- ---------------------------------------------------------------------
-- Admin RPC refusals
-- ---------------------------------------------------------------------
set local role anon;
select pg_temp.ovd829_as(null, 'anon', null);
select throws_ok(
  $$select public.api_admin_set_provider_settings('fictiv', false, 50, 'anon should never change this', 0)$$,
  '42501', null, 'anon cannot execute the settings RPC');
reset role;

set local role service_role;
select throws_ok(
  $$select public.api_admin_set_provider_settings('fictiv', false, 50, 'service role is not an admin', 0)$$,
  '42501', null, 'service_role cannot execute the settings RPC');
reset role;

set local role authenticated;
select pg_temp.ovd829_as('00000000-0000-4000-8000-000000829002', 'authenticated', 'aal2');
select throws_ok(
  $$select public.api_admin_set_provider_settings('fictiv', false, 50, 'member should never change this', 0)$$,
  '42501', 'platform_admin_required', 'a non-admin is refused');

select pg_temp.ovd829_as('00000000-0000-4000-8000-000000829001', 'authenticated', 'aal1');
select throws_ok(
  $$select public.api_admin_set_provider_settings('fictiv', false, 50, 'admin without a second factor', 0)$$,
  '42501', 'Multi-factor authentication is required for provider kill switch administration.',
  'an admin without AAL2 is refused by the settings RPC');
select throws_ok(
  $$select public.api_admin_set_provider_kill_switch('fictiv', true, 'admin without a second factor')$$,
  'P0001', 'Multi-factor authentication is required for provider kill switch administration.',
  'an admin without AAL2 is still refused by the kill-switch RPC (OVD-767 message and SQLSTATE)');

select pg_temp.ovd829_as('00000000-0000-4000-8000-000000829001', 'authenticated', 'aal2');
select throws_ok(
  $$select public.api_admin_set_provider_settings('fictiv', false, 0, 'OVD-829 test: zero cap', 0)$$,
  '22023', 'daily_quote_cap_must_be_positive', 'a cap of 0 is refused');
select throws_ok(
  $$select public.api_admin_set_provider_settings('fictiv', false, -5, 'OVD-829 test: negative cap', 0)$$,
  '22023', 'daily_quote_cap_must_be_positive', 'a negative cap is refused');
select throws_ok(
  $$select public.api_admin_set_provider_settings('fictiv', false, 50, 'short', 0)$$,
  '22023', 'reason_required_min_10_chars', 'a reason under 10 characters is refused');
reset role;

select ok(
  not exists (select 1 from private.provider_kill_switch_audit
              where actor::text in ('00000000-0000-4000-8000-000000829001', '00000000-0000-4000-8000-000000829002')),
  'refused calls wrote no audit rows');

-- ---------------------------------------------------------------------
-- Admin RPC success, compare and set, audit
-- ---------------------------------------------------------------------
set local role authenticated;
select pg_temp.ovd829_as('00000000-0000-4000-8000-000000829001', 'authenticated', 'aal2');
select is(
  public.api_admin_set_provider_settings('fictiv', false, 50, 'OVD-829 test: raise fictiv cap',
    pg_temp.ovd829_version('fictiv')) ->> 'dailyQuoteCap',
  '50', 'an AAL2 admin raises the fictiv cap to 50');
select is(
  public.api_admin_set_provider_settings('quickparts', false, null, 'OVD-829 test: quickparts unlimited',
    pg_temp.ovd829_version('quickparts')) -> 'dailyQuoteCap',
  'null'::jsonb, 'a null cap (unlimited) is accepted');
select throws_ok(
  $$select public.api_admin_set_provider_settings('fictiv', false, 30, 'OVD-829 test: stale cap edit', 0)$$,
  'P0001', 'kill_switch_version_conflict', 'a cap change on a stale version is refused');
select throws_ok(
  $$select public.api_admin_set_provider_settings('fictiv', false, 50, 'OVD-829 test: versionless release', null)$$,
  'P0001', 'kill_switch_version_conflict', 'a versionless release is refused');
reset role;

select is(
  (select daily_quote_cap from private.provider_kill_switches where provider = 'quickparts'),
  null::integer, 'quickparts is stored as unlimited');
select results_eq(
  $$select engaged, daily_quote_cap, previous_daily_quote_cap, reason
    from private.provider_kill_switch_audit
    where provider = 'fictiv' and actor::text = '00000000-0000-4000-8000-000000829001'
    order by id limit 1$$,
  $$values (false, 50, null::integer, 'OVD-829 test: raise fictiv cap'::text)$$,
  'the cap change wrote one audit row with the new and previous cap');

-- Emergency engage through the kill-switch RPC needs no version and keeps the cap.
set local role authenticated;
select pg_temp.ovd829_as('00000000-0000-4000-8000-000000829001', 'authenticated', 'aal2');
select is(
  public.api_admin_set_provider_kill_switch('quickparts', true, 'OVD-829 test: engage keeps cap', 0) -> 'dailyQuoteCap',
  'null'::jsonb, 'the kill-switch RPC engages with a stale version and keeps the unlimited cap');
reset role;
select is(
  (select daily_quote_cap from private.provider_kill_switches where provider = 'quickparts'),
  null::integer, 'quickparts is still unlimited after the kill-switch flip');

-- ---------------------------------------------------------------------
-- Durable counter
-- ---------------------------------------------------------------------
update private.provider_kill_switches set daily_quote_cap = 3, engaged = false where provider = 'rmfg';

set local role service_role;
select is(
  (select pg_catalog.array_agg(public.api_worker_reserve_provider_dispatch('rmfg') ->> 'allowed' order by n)
   from pg_catalog.generate_series(1, 3) n),
  array['true', 'true', 'true'], 'cap 3: the first three dispatches are allowed');
select is(
  public.api_worker_reserve_provider_dispatch('rmfg') - 'schema',
  '{"provider": "rmfg", "allowed": false, "reason": "provider_daily_cap_reached", "cap": 3, "used": 3}'::jsonb,
  'cap 3: the fourth dispatch is refused provider_daily_cap_reached');
reset role;
select is(
  (select count from private.provider_daily_quote_usage where provider = 'rmfg'),
  3, 'a refused dispatch is not counted');

set local role authenticated;
select pg_temp.ovd829_as('00000000-0000-4000-8000-000000829001', 'authenticated', 'aal2');
select is(
  (select p - 'reason' - 'changedBy' - 'changedAt' - 'version' - 'engaged'
   from pg_catalog.jsonb_array_elements(public.api_admin_list_provider_kill_switches() -> 'providers') p
   where p ->> 'provider' = 'rmfg'),
  '{"provider": "rmfg", "dailyQuoteCap": 3, "usedToday": 3}'::jsonb,
  'the admin list reports the cap and today''s usage');
reset role;

-- UTC day: yesterday's spent cap does not carry over to today.
update private.provider_kill_switches set daily_quote_cap = 2, engaged = false where provider = 'weerg';
insert into private.provider_daily_quote_usage (provider, usage_date, count)
values ('weerg', pg_catalog.timezone('UTC', pg_catalog.now())::date - 1, 2);
set local role service_role;
select is(
  public.api_worker_reserve_provider_dispatch('weerg') - 'schema',
  '{"provider": "weerg", "allowed": true, "reason": null, "cap": 2, "used": 1}'::jsonb,
  'a cap spent yesterday (UTC) leaves today''s allowance whole');
reset role;
select results_eq(
  $$select usage_date - pg_catalog.timezone('UTC', pg_catalog.now())::date, count
    from private.provider_daily_quote_usage where provider = 'weerg' order by usage_date$$,
  $$values (-1, 2), (0, 1)$$,
  'today''s dispatch is counted on today''s UTC row; yesterday''s is untouched');

-- A corrupt stored cap (only possible without the check constraint) reads as no
-- cap: there is no default cap, and the cap applies only when an admin set a
-- positive integer. The constraint drop is undone by the suite's rollback.
alter table private.provider_kill_switches drop constraint provider_kill_switches_daily_quote_cap_check;
update private.provider_kill_switches set daily_quote_cap = 0, engaged = false where provider = 'geomiq';
insert into private.provider_daily_quote_usage (provider, usage_date, count)
values ('geomiq', pg_catalog.timezone('UTC', pg_catalog.now())::date, 19);
set local role service_role;
select is(
  public.api_worker_reserve_provider_dispatch('geomiq') - 'schema',
  '{"provider": "geomiq", "allowed": true, "reason": null, "cap": null, "used": 20}'::jsonb,
  'a corrupt cap of 0 reserves as no cap');
select is(
  public.api_worker_reserve_provider_dispatch('geomiq') ->> 'allowed', 'true',
  'a corrupt cap of 0 never refuses as if a cap applied');
reset role;

update private.provider_kill_switches set engaged = false where provider = 'quickparts';
set local role service_role;
select ok(
  (select bool_and((public.api_worker_reserve_provider_dispatch('quickparts') ->> 'allowed')::boolean)
   from pg_catalog.generate_series(1, 60)),
  'a null cap never refuses (60 dispatches)');
reset role;
select is(
  (select count from private.provider_daily_quote_usage where provider = 'quickparts'),
  60, 'unlimited dispatches are still counted');

update private.provider_kill_switches set engaged = true, daily_quote_cap = null where provider = 'quickparts';
set local role service_role;
select is(
  public.api_worker_reserve_provider_dispatch('quickparts') ->> 'reason', 'provider_disabled',
  'an engaged supplier is refused provider_disabled even with an unlimited cap');
select is(
  public.api_worker_reserve_provider_dispatch('rmfg') ->> 'reason', 'provider_daily_cap_reached',
  'a supplier at its cap and switched on reports the cap');
reset role;

update private.provider_kill_switches set engaged = true where provider = 'rmfg';
set local role service_role;
select is(
  public.api_worker_reserve_provider_dispatch('rmfg') ->> 'reason', 'provider_disabled',
  'the kill switch beats the cap: an engaged supplier at its cap is provider_disabled');
reset role;

-- ---------------------------------------------------------------------
-- Audited service-role cap setter (the docs/migration-drafts/ovd-829-notes.md
-- runbook: set a Xometry daily cap)
-- ---------------------------------------------------------------------
update private.provider_global_kill_switch set engaged = false where singleton;
update private.provider_kill_switches set engaged = true, daily_quote_cap = null where provider = 'xometry';
delete from private.provider_daily_quote_usage where provider = 'xometry';
create temp table ovd829_xometry (version bigint) on commit drop;
grant select on ovd829_xometry to service_role;
insert into ovd829_xometry select version from private.provider_kill_switches where provider = 'xometry';

set local role authenticated;
select pg_temp.ovd829_as('00000000-0000-4000-8000-000000829001', 'authenticated', 'aal2');
select throws_ok(
  $$select public.api_service_set_provider_daily_quote_cap('xometry', 2, 'admin session is not the service role', 'ovd829-admin', 0)$$,
  '42501', null, 'an AAL2 admin session cannot call the service cap setter');
reset role;

set local role service_role;
select throws_ok(
  pg_catalog.format($$select public.api_service_set_provider_daily_quote_cap('xometry', 2, 'OVD-829 test: no operator', ' ', %s)$$,
    (select version from ovd829_xometry)),
  '22023', 'operator_required', 'the service cap setter requires an operator name');
select throws_ok(
  pg_catalog.format($$select public.api_service_set_provider_daily_quote_cap('xometry', 2, 'short', 'ovd829-operator', %s)$$,
    (select version from ovd829_xometry)),
  '22023', 'reason_required_min_10_chars', 'the service cap setter requires a 10 character reason');
select throws_ok(
  pg_catalog.format($$select public.api_service_set_provider_daily_quote_cap('xometry', 0, 'OVD-829 test: zero cap', 'ovd829-operator', %s)$$,
    (select version from ovd829_xometry)),
  '22023', 'daily_quote_cap_must_be_positive', 'the service cap setter refuses a cap of 0');
select throws_ok(
  $$select public.api_service_set_provider_daily_quote_cap('xometry', 2, 'OVD-829 test: versionless cap', 'ovd829-operator', null)$$,
  'P0001', 'kill_switch_version_conflict', 'the service cap setter refuses a missing version');
select throws_ok(
  pg_catalog.format($$select public.api_service_set_provider_daily_quote_cap('xometry', 2, 'OVD-829 test: stale cap', 'ovd829-operator', %s)$$,
    (select version - 1 from ovd829_xometry)),
  'P0001', 'kill_switch_version_conflict', 'the service cap setter refuses a stale version');
select is(
  (select p ->> 'version'
   from pg_catalog.jsonb_array_elements(public.api_service_list_provider_kill_switches() -> 'providers') p
   where p ->> 'provider' = 'xometry'),
  (select version::text from ovd829_xometry),
  'the service list reports the version the cap setter must name');
select is(
  public.api_service_set_provider_daily_quote_cap('xometry', 2, 'OVD-829 test: Xometry daily cap', ' ovd829-operator ',
    (select version from ovd829_xometry)) - 'changedAt',
  pg_catalog.jsonb_build_object(
    'provider', 'xometry', 'engaged', true, 'dailyQuoteCap', 2, 'previousDailyQuoteCap', null,
    'reason', 'OVD-829 test: Xometry daily cap', 'changedBy', 'cli:service_role',
    'operator', 'ovd829-operator', 'version', (select version + 1 from ovd829_xometry)),
  'the service role sets the Xometry cap to 2 and the on/off state is reported unchanged');
reset role;

select results_eq(
  $$select engaged, daily_quote_cap, engaged_by from private.provider_kill_switches where provider = 'xometry'$$,
  $$values (true, 2, null::uuid)$$,
  'setting a cap never switched Xometry on');
select results_eq(
  $$select actor, operator, engaged, reason, daily_quote_cap, previous_daily_quote_cap
    from private.provider_kill_switch_audit
    where provider = 'xometry' and actor = 'cli:service_role' and reason = 'OVD-829 test: Xometry daily cap'$$,
  $$values ('cli:service_role'::text, 'ovd829-operator'::text, true, 'OVD-829 test: Xometry daily cap'::text, 2, null::integer)$$,
  'the cap change wrote exactly one audit row: cli:service_role, the operator, the new and previous cap');
select is(
  (select pg_catalog.count(*)::int from private.provider_kill_switch_audit
   where provider = 'xometry' and reason like 'OVD-829 test:%' and reason <> 'OVD-829 test: Xometry daily cap'),
  0, 'refused service calls wrote no audit rows');

-- Released through the existing switch path, the counter enforces the cap the service role set.
update private.provider_kill_switches set engaged = false where provider = 'xometry';
update ovd829_xometry set version = (select version from private.provider_kill_switches where provider = 'xometry');
set local role service_role;
select is(
  public.api_worker_provider_settings_state('xometry') - 'schema',
  '{"provider": "xometry", "globalEngaged": false, "engaged": false, "dailyQuoteCap": 2, "usedToday": 0}'::jsonb,
  'the worker settings read sees the Xometry cap');
select is(
  (select pg_catalog.array_agg(public.api_worker_reserve_provider_dispatch('xometry') ->> 'reason' order by n)
   from pg_catalog.generate_series(1, 3) n),
  array[null, null, 'provider_daily_cap_reached'],
  'Xometry cap 2: two dispatches allowed, the third refused provider_daily_cap_reached');
select is(
  (public.api_service_set_provider_daily_quote_cap('xometry', null, 'OVD-829 test: Xometry unlimited again', 'ovd829-operator',
    (select version from ovd829_xometry)) -> 'dailyQuoteCap'),
  'null'::jsonb, 'the service role clears the cap (null = unlimited)');
select is(
  public.api_worker_reserve_provider_dispatch('xometry') ->> 'allowed', 'true',
  'with the cap cleared Xometry dispatches again');
reset role;

update private.provider_kill_switches set engaged = false, daily_quote_cap = 50 where provider = 'fictiv';
update private.provider_global_kill_switch set engaged = true where singleton;
set local role service_role;
select is(
  public.api_worker_reserve_provider_dispatch('fictiv') ->> 'reason', 'provider_disabled',
  'the global switch refuses provider_disabled whatever the supplier cap');
reset role;
select is(
  (select pg_catalog.count(*)::int from private.provider_daily_quote_usage where provider = 'fictiv'),
  0, 'a provider_disabled refusal counts nothing');

select * from finish();
rollback;
