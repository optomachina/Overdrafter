begin;
select plan(12);
select ok(not has_function_privilege('anon', 'public.api_take_worker_wake_slot()', 'EXECUTE'), 'anon cannot throttle or wake');
select ok(not has_function_privilege('authenticated', 'public.api_take_worker_wake_slot()', 'EXECUTE'), 'users cannot consume wake slots directly');
select ok(has_function_privilege('service_role', 'public.api_take_worker_wake_slot()', 'EXECUTE'), 'edge service can consume slot');
select ok(not has_table_privilege('service_role', 'private.worker_wake_throttle', 'UPDATE'), 'service cannot bypass interval');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'private.worker_wake_throttle'::regclass), 'RLS enabled and forced');
update private.worker_wake_throttle set next_allowed_at = '-infinity' where singleton;
set local role service_role;
select is(public.api_take_worker_wake_slot(), true, 'first call admitted');
select is(public.api_take_worker_wake_slot(), false, 'second call denied');
reset role;
update private.worker_wake_throttle set next_allowed_at = clock_timestamp() - interval '1 second' where singleton;
set local role service_role;
select is(public.api_take_worker_wake_slot(), true, 'expired slot admitted');
reset role;
-- deny: anon private.worker_wake_throttle
set local role anon;
select throws_ok($$select next_allowed_at from private.worker_wake_throttle$$, '42501', null, 'anon cannot read the wake throttle');
reset role;
-- deny: other_user private.worker_wake_throttle
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select throws_ok($$select next_allowed_at from private.worker_wake_throttle$$, '42501', null, 'authenticated users cannot read the wake throttle');
reset role;
-- deny: role_boundary private.worker_wake_throttle
set local role service_role;
select throws_ok($$update private.worker_wake_throttle set next_allowed_at = '-infinity' where singleton$$, '42501', null, 'service role cannot reset the interval directly');
reset role;
-- end deny
select is((select count(*)::integer from private.worker_wake_throttle), 1, 'bounded singleton state');
select * from finish();
rollback;
