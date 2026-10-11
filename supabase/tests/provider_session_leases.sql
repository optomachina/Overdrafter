begin;

create extension if not exists pgtap with schema extensions;

select plan(73);

-- OVD-462 is a proposed migration that is intentionally NOT in supabase/migrations
-- yet (needs migration window 1). fixtures/ holds a byte copy of
-- docs/migration-drafts/ovd-462.sql, kept identical by
-- scripts/run-supabase-policy-tests.node-test.mjs, and it is installed inside this
-- rolled-back transaction only when the table is absent. Once the migration is
-- promoted, the guard is false and every assertion runs against the real schema.
-- No assertion is skipped in either case.
select to_regclass('public.provider_session_leases') is null as ovd462_install_draft \gset
\if :ovd462_install_draft
\ir fixtures/ovd462_provider_session_leases.inc
\endif

create function pg_temp.acct(n integer) returns text language sql immutable as $$
  select 'acct_' || md5('ovd462-synthetic-account-' || n::text)
$$;
create function pg_temp.sb(n integer) returns text language sql immutable as $$
  select 'sb_' || md5('ovd462-synthetic-binding-' || n::text)
$$;
create function pg_temp.tok(n integer) returns uuid language sql immutable as $$
  select ('46200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- ---------------------------------------------------------------- catalog
select has_table('public', 'provider_session_leases', 'lease table exists');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
           where oid = 'public.provider_session_leases'::regclass),
          'RLS is enabled and forced');
select is((select count(*)::integer from pg_policies
           where schemaname = 'public' and tablename = 'provider_session_leases'),
          0, 'no RLS policies exist, so direct access is denied to every role');
select ok((select i.indisunique and pg_get_expr(i.indpred, i.indrelid) like '%active%blocked%'
           from pg_index i where i.indexrelid = 'public.provider_session_leases_one_occupant'::regclass),
          'unique partial index enforces one occupant per binding');
select is(
  (select array_agg(column_name::text order by column_name) from information_schema.columns
    where table_schema = 'public' and table_name = 'provider_session_leases'),
  array['account_ref', 'acquired_at', 'created_at', 'ended_at', 'environment', 'expires_at',
        'generation', 'hard_expires_at', 'holder_token', 'id', 'max_renewals', 'outcome',
        'owner_task_ref', 'provider', 'renewal_count', 'session_binding_ref', 'state',
        'ttl_seconds', 'updated_at'],
  'only opaque identity, ownership and timing columns exist (no credential or session-material columns)');

create temporary table ovd462_rpcs (sig text) on commit drop;
insert into ovd462_rpcs values
  ('public.acquire_provider_session_lease(text,text,text,text,text,uuid,integer,integer,integer)'),
  ('public.renew_provider_session_lease(text,text,text,text,text,uuid,bigint)'),
  ('public.release_provider_session_lease(text,text,text,text,text,uuid,bigint)'),
  ('public.report_provider_session_lease_outcome(text,text,text,text,text,uuid,bigint,text)'),
  ('public.revoke_provider_session_binding(text,text,text,text)'),
  ('public.clear_provider_session_binding_block(text,text,text,bigint)');

select is((select count(*)::integer from ovd462_rpcs r join pg_proc p on p.oid = r.sig::regprocedure
           where p.prosecdef and p.proconfig = array['search_path=""']),
          6, 'all six RPCs are SECURITY DEFINER with search_path pinned to empty');
select is((select count(*)::integer from ovd462_rpcs r
           where has_function_privilege('anon', r.sig, 'execute')), 0, 'anon cannot execute any RPC');
select is((select count(*)::integer from ovd462_rpcs r
           where has_function_privilege('authenticated', r.sig, 'execute')), 0, 'authenticated cannot execute any RPC');
select is((select count(*)::integer from ovd462_rpcs r
           where has_function_privilege('service_role', r.sig, 'execute')), 6, 'service_role can execute every RPC');
select is((select count(*)::integer from ovd462_rpcs r join pg_proc p on p.oid = r.sig::regprocedure
           where has_function_privilege('public', r.sig, 'execute')), 0, 'PUBLIC cannot execute any RPC');
select ok(not has_function_privilege('anon', 'public.provider_session_lease_identity_ok(text,text,text,text)', 'execute')
      and not has_function_privilege('authenticated', 'public.provider_session_lease_identity_ok(text,text,text,text)', 'execute')
      and not has_function_privilege('service_role', 'public.provider_session_lease_identity_ok(text,text,text,text)', 'execute'),
          'private identity validator is not executable by API roles');
select ok(not has_table_privilege(r, 'public.provider_session_leases', 'select')
      and not has_table_privilege(r, 'public.provider_session_leases', 'insert')
      and not has_table_privilege(r, 'public.provider_session_leases', 'update')
      and not has_table_privilege(r, 'public.provider_session_leases', 'delete'),
          r || ' has no direct table privileges')
from unnest(array['anon', 'authenticated', 'service_role']) r;

-- ---------------------------------------------------------------- RLS / grant denial
set local role anon;
select throws_ok('select count(*) from public.provider_session_leases', '42501', null, 'anon direct read denied');
select throws_ok($$select public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 60, 10, 600)$$,
  '42501', null, 'anon RPC call denied');
reset role;
set local role authenticated;
select throws_ok('select count(*) from public.provider_session_leases', '42501', null, 'authenticated direct read denied');
select throws_ok($$insert into public.provider_session_leases (provider, account_ref, environment, session_binding_ref, generation, state, outcome, ended_at)
  values ('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 1, 'blocked', 'owner_revoked', now())$$,
  '42501', null, 'authenticated direct insert denied');
select throws_ok($$select public.release_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 1)$$,
  '42501', null, 'authenticated RPC call denied');
reset role;
set local role service_role;
select throws_ok('select count(*) from public.provider_session_leases', '42501', null, 'service_role direct read denied (RPC only)');
select throws_ok($$update public.provider_session_leases set state = 'released'$$, '42501', null, 'service_role direct update denied (RPC only)');

-- ---------------------------------------------------------------- acquire / contention / idempotency
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 60, 2, 600),
  '{"status":"acquired","generation":1,"idempotent":false,"expires_in_ms":60000,"renewals_remaining":2}'::jsonb,
  'first contender acquires generation 1');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 60, 2, 600) - 'expires_in_ms',
  '{"status":"acquired","generation":1,"idempotent":true,"renewals_remaining":2}'::jsonb,
  'acquire is idempotent for the exact owner');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-b', pg_temp.tok(2), 60, 2, 600)->>'status',
  'contended', 'a different task receives a non-owning contended outcome');
select ok((public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-b', pg_temp.tok(2), 30, 2, 600)->>'retry_after_ms')::bigint between 1 and 30000,
  'contended retry hint is bounded by the contender ttl');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(9), 60, 2, 600)->>'status',
  'contended', 'same task with a new holder token (crash restart) cannot become a second owner');
select ok(not (public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-b', pg_temp.tok(2), 60, 2, 600) ? 'generation'),
  'contended outcome never discloses the owner generation');

-- ---------------------------------------------------------------- isolation and cross-binding reuse
select is(public.acquire_provider_session_lease('fictiv', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-c', pg_temp.tok(3), 60, 2, 600),
  '{"status":"rejected","reason":"binding_mismatch"}'::jsonb, 'session binding cannot be reused across providers');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(2), 'test', pg_temp.sb(1), 'task-c', pg_temp.tok(3), 60, 2, 600),
  '{"status":"rejected","reason":"binding_mismatch"}'::jsonb, 'session binding cannot be reused across accounts');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'staging', pg_temp.sb(1), 'task-c', pg_temp.tok(3), 60, 2, 600),
  '{"status":"rejected","reason":"binding_mismatch"}'::jsonb, 'session binding cannot be reused across environments');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'staging', pg_temp.sb(2), 'task-c', pg_temp.tok(3), 60, 2, 600)->>'status',
  'acquired', 'another environment is an independent binding');
select is(public.acquire_provider_session_lease('fictiv', pg_temp.acct(1), 'test', pg_temp.sb(3), 'task-d', pg_temp.tok(4), 60, 2, 600)->>'status',
  'acquired', 'another provider is an independent binding');

-- ---------------------------------------------------------------- wrong-owner mutations
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-b', pg_temp.tok(1), 1),
  '{"status":"rejected","reason":"not_owner"}'::jsonb, 'renew with wrong task rejected');
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(2), 1),
  '{"status":"rejected","reason":"not_owner"}'::jsonb, 'renew with wrong holder token rejected');
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 2),
  '{"status":"rejected","reason":"not_owner"}'::jsonb, 'renew with wrong generation rejected');
select is(public.renew_provider_session_lease('fictiv', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 1),
  '{"status":"rejected","reason":"not_owner"}'::jsonb, 'renew under another provider rejected');
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'production', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 1),
  '{"status":"rejected","reason":"not_owner"}'::jsonb, 'renew under another environment rejected');
select is(public.release_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-b', pg_temp.tok(2), 1),
  '{"status":"rejected","reason":"not_owner"}'::jsonb, 'release by a non-owner rejected');
select is(public.report_provider_session_lease_outcome('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-b', pg_temp.tok(2), 1, 'login_required'),
  '{"status":"rejected","reason":"not_owner"}'::jsonb, 'outcome report by a non-owner rejected');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 60, 2, 600)->>'idempotent',
  'true', 'owner still holds generation 1 after every rejected mutation');

-- ---------------------------------------------------------------- bounded renewal
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 1) - 'expires_in_ms',
  '{"status":"renewed","renewals_remaining":1}'::jsonb, 'owner renews');
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 1) - 'expires_in_ms',
  '{"status":"renewed","renewals_remaining":0}'::jsonb, 'owner renews up to the bound');
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 1),
  '{"status":"lost","reason":"renewal_exhausted","outcome":null}'::jsonb, 'renewal beyond the bound ends the lease');
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-a', pg_temp.tok(1), 1),
  '{"status":"lost","reason":"expired","outcome":null}'::jsonb, 'a lost lease stays lost');

-- ---------------------------------------------------------------- crash / expiry recovery and fencing
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-b', pg_temp.tok(2), 60, 5, 600)->>'generation',
  '2', 'next owner receives a strictly higher generation');
reset role;
-- Simulated crash: the generation-2 holder stops renewing and its expiry passes.
update public.provider_session_leases set expires_at = clock_timestamp() - interval '1 second'
 where account_ref = pg_temp.acct(1) and provider = 'xometry' and environment = 'test' and generation = 2;
set local role service_role;
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-c', pg_temp.tok(3), 60, 5, 600)->>'generation',
  '3', 'expired holder is recovered and replaced by generation 3');
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-b', pg_temp.tok(2), 2),
  '{"status":"lost","reason":"expired","outcome":null}'::jsonb, 'crashed holder that wakes up cannot renew');
select is(public.release_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-b', pg_temp.tok(2), 2),
  '{"status":"released","changed":false,"final_state":"expired"}'::jsonb, 'crashed holder release is a no-op');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-b', pg_temp.tok(2), 60, 5, 600)->>'status',
  'contended', 'crashed holder cannot re-acquire while generation 3 is active');
reset role;
select is((select count(*)::integer from public.provider_session_leases
           where provider = 'xometry' and account_ref = pg_temp.acct(1) and environment = 'test' and state = 'active'),
          1, 'exactly one active owner after crash recovery');
select throws_ok($$insert into public.provider_session_leases (provider, account_ref, environment, session_binding_ref, generation, state,
    owner_task_ref, holder_token, ttl_seconds, max_renewals, acquired_at, expires_at, hard_expires_at)
  values ('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 99, 'active', 'task-z', pg_temp.tok(99), 60, 1, now(), now() + interval '1 minute', now() + interval '2 minutes')$$,
  '23505', null, 'storage rejects a second simultaneous active owner even when RPCs are bypassed');
select throws_ok($$insert into public.provider_session_leases (provider, account_ref, environment, session_binding_ref, generation, state, outcome, ended_at)
  values ('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 3, 'blocked', 'owner_revoked', now())$$,
  '23505', null, 'storage rejects a duplicate generation');
select throws_ok($$insert into public.provider_session_leases (provider, account_ref, environment, session_binding_ref, generation, state, outcome, ended_at)
  values ('xometry', 'someone@example.com', 'test', pg_temp.sb(7), 1, 'blocked', 'owner_revoked', now())$$,
  '23514', null, 'storage rejects a non-opaque account identifier');
select throws_ok($$insert into public.provider_session_leases (provider, account_ref, environment, session_binding_ref, generation, state, outcome, ended_at)
  values ('xometry', pg_temp.acct(7), 'test', '/Users/someone/profiles/xometry', 1, 'blocked', 'owner_revoked', now())$$,
  '23514', null, 'storage rejects a profile path as session binding');
set local role service_role;

-- ---------------------------------------------------------------- release idempotency
select is(public.release_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-c', pg_temp.tok(3), 3),
  '{"status":"released","changed":true,"final_state":"released"}'::jsonb, 'owner releases');
select is(public.release_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-c', pg_temp.tok(3), 3),
  '{"status":"released","changed":false,"final_state":"released"}'::jsonb, 'release is idempotent for the exact owner');
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-c', pg_temp.tok(3), 3),
  '{"status":"lost","reason":"released","outcome":null}'::jsonb, 'released generation cannot be renewed');

-- ---------------------------------------------------------------- terminal / manual follow-up outcomes
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-d', pg_temp.tok(4), 60, 5, 600)->>'generation',
  '4', 'binding is free again after release');
select is(public.report_provider_session_lease_outcome('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-d', pg_temp.tok(4), 4, 'login_required'),
  '{"status":"blocked","outcome":"login_required","generation":4}'::jsonb, 'owner reports login required');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-e', pg_temp.tok(5), 60, 5, 600),
  '{"status":"manual_follow_up","outcome":"login_required"}'::jsonb, 'blocked binding returns manual follow-up instead of a lease');
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-d', pg_temp.tok(4), 4),
  '{"status":"lost","reason":"blocked","outcome":"login_required"}'::jsonb, 'blocked holder cannot renew');
select is(public.report_provider_session_lease_outcome('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-d', pg_temp.tok(4), 4, 'not_an_outcome'),
  '{"status":"rejected","reason":"invalid_identity"}'::jsonb, 'unknown outcome vocabulary rejected');
select is(public.clear_provider_session_binding_block('xometry', pg_temp.acct(1), 'test', 3),
  '{"status":"rejected","reason":"not_blocked"}'::jsonb, 'clearing a non-blocked generation is rejected');
select is(public.clear_provider_session_binding_block('xometry', pg_temp.acct(1), 'test', 4),
  '{"status":"cleared"}'::jsonb, 'operator clears the block after manual follow-up');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-e', pg_temp.tok(5), 60, 5, 600)->>'generation',
  '5', 'binding grants generation 5 after the block is cleared');
select is(public.revoke_provider_session_binding('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1)),
  '{"status":"blocked","outcome":"owner_revoked","generation":5}'::jsonb, 'operator revokes the active owner');
select is(public.renew_provider_session_lease('xometry', pg_temp.acct(1), 'test', pg_temp.sb(1), 'task-e', pg_temp.tok(5), 5),
  '{"status":"lost","reason":"blocked","outcome":"owner_revoked"}'::jsonb, 'revoked owner loses the lease on its next heartbeat');
select is(public.revoke_provider_session_binding('fictiv', pg_temp.acct(4), 'production', pg_temp.sb(4)),
  '{"status":"blocked","outcome":"owner_revoked","generation":1}'::jsonb, 'revocation without a holder still blocks future grants');
select is(public.acquire_provider_session_lease('fictiv', pg_temp.acct(4), 'production', pg_temp.sb(4), 'task-f', pg_temp.tok(6), 60, 5, 600),
  '{"status":"manual_follow_up","outcome":"owner_revoked"}'::jsonb, 'revoked binding requires manual follow-up');

-- ---------------------------------------------------------------- input validation (no echo, no storage)
select is(public.acquire_provider_session_lease('xometry', 'someone@example.com', 'test', pg_temp.sb(8), 'task-g', pg_temp.tok(7), 60, 5, 600),
  '{"status":"rejected","reason":"invalid_identity"}'::jsonb, 'raw account identifier rejected without echo');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(8), 'test', pg_temp.sb(8), 'task-g', pg_temp.tok(7), 3600, 5, 600),
  '{"status":"rejected","reason":"invalid_policy"}'::jsonb, 'unbounded ttl rejected');
select is(public.acquire_provider_session_lease('xometry', pg_temp.acct(8), 'test', pg_temp.sb(8), 'task-g', pg_temp.tok(7), 60, 5, 86400),
  '{"status":"rejected","reason":"invalid_policy"}'::jsonb, 'unbounded total duration rejected');
reset role;
select is((select count(*)::integer from public.provider_session_leases where account_ref = pg_temp.acct(8)),
  0, 'rejected requests store nothing');

select * from finish();
rollback;
