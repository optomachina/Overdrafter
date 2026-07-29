begin;

select plan(55);

create temporary table mobile_auth_test_flags (
  name text primary key,
  passed boolean not null
) on commit drop;

create temporary table mobile_auth_cleanup_results (
  result jsonb not null
) on commit drop;

create or replace function pg_temp.create_mobile_auth_test_transaction(
  p_transaction_id uuid,
  p_trace_id uuid,
  p_state_digest text,
  p_browser_binding_digest text
)
returns jsonb
language sql
as $$
  select public.api_mobile_auth_create_transaction(
    p_transaction_id,
    p_trace_id,
    1::smallint,
    1,
    p_state_digest,
    repeat('E', 64),
    repeat('C', 43),
    p_browser_binding_digest,
    repeat('R', 43),
    'od-mobile-auth:' || p_transaction_id::text,
    '/auth/mobile/provider-callback',
    'https://app.example.com',
    '/auth/mobile/callback',
    '/quotes'
  );
$$;

insert into auth.users (id, aud, role, email)
values (
  '00000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'mobile-auth-bridge@example.com'
);

insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000001',
  statement_timestamp(),
  statement_timestamp()
);

select is(
  (
    select count(*)::integer
    from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname in (
        'mobile_auth_transactions',
        'mobile_auth_rate_limit_counters',
        'mobile_auth_audit_events'
      )
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ),
  3,
  'all mobile-auth tables enable and force RLS'
);

select is(
  (
    select count(*)::integer
    from pg_policy policy_row
    join pg_class relation on relation.oid = policy_row.polrelid
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname like 'mobile_auth_%'
  ),
  0,
  'private mobile-auth tables have no client policies'
);

select ok(
  not has_table_privilege(
    'anon',
    'private.mobile_auth_transactions',
    'select'
  ),
  'anon cannot read mobile-auth transactions'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'private.mobile_auth_transactions',
    'select'
  ),
  'authenticated users cannot read mobile-auth transactions'
);

select ok(
  not has_table_privilege(
    'service_role',
    'private.mobile_auth_transactions',
    'select'
  ),
  'service_role has no direct transaction-table access'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.api_mobile_auth_create_transaction(uuid,uuid,smallint,integer,text,text,text,text,text,text,text,text,text,text)',
    'execute'
  ),
  'anon cannot execute mobile-auth transaction RPCs'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.api_mobile_auth_create_transaction(uuid,uuid,smallint,integer,text,text,text,text,text,text,text,text,text,text)',
    'execute'
  ),
  'authenticated users cannot execute mobile-auth transaction RPCs'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.api_mobile_auth_create_transaction(uuid,uuid,smallint,integer,text,text,text,text,text,text,text,text,text,text)',
    'execute'
  ),
  'service_role can execute the transaction RPC'
);

select is(
  (
    select count(*)::integer
    from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'private'
      and relation.relname in (
        'mobile_auth_transactions',
        'mobile_auth_rate_limit_counters',
        'mobile_auth_audit_events'
      )
      and not has_table_privilege('anon', relation.oid, 'select')
      and not has_table_privilege('authenticated', relation.oid, 'select')
      and not has_table_privilege('service_role', relation.oid, 'select')
  ),
  3,
  'all private mobile-auth tables deny direct application-role reads'
);

select is(
  (
    select count(*)::integer
    from pg_proc procedure_row
    join pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname like 'api_mobile_auth_%'
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
  ),
  10,
  'every mobile-auth RPC is executable only by the server role'
);

select ok(
  not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'private'
      and column_row.table_name in (
        'mobile_auth_transactions',
        'mobile_auth_rate_limit_counters',
        'mobile_auth_audit_events'
      )
      and column_row.column_name in (
        'state',
        'code_verifier',
        'handoff_code',
        'cookie',
        'csrf',
        'access_token',
        'refresh_token',
        'email'
      )
  ),
  'private mobile-auth storage has no plaintext credential columns'
);

do $$
begin
  perform pg_temp.create_mobile_auth_test_transaction(
    '00000000-0000-4000-8000-000000000199',
    '00000000-0000-4000-8000-000000000299',
    'plaintext-state',
    repeat('1', 43)
  );

  insert into mobile_auth_test_flags (name, passed)
  values ('invalid_digest_rejected', false);
exception
  when check_violation then
    insert into mobile_auth_test_flags (name, passed)
    values ('invalid_digest_rejected', true);
end;
$$;

select is(
  (
    select passed
    from mobile_auth_test_flags
    where name = 'invalid_digest_rejected'
  ),
  true,
  'digest constraints reject non-HMAC state values'
);

select is(
  (
    pg_temp.create_mobile_auth_test_transaction(
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000201',
      repeat('a', 43),
      repeat('1', 43)
    ) ->> 'created'
  )::boolean,
  true,
  'the service RPC creates an authentication transaction'
);

select is(
  (
    select browser_expires_at - created_at
    from private.mobile_auth_transactions
    where id = '00000000-0000-4000-8000-000000000101'
  ),
  interval '10 minutes',
  'browser completion uses the database ten-minute deadline'
);

select is(
  (
    public.api_mobile_auth_get_browser_transaction(
      '00000000-0000-4000-8000-000000000101',
      array[repeat('2', 43), repeat('1', 43)]
    ) ->> 'found'
  )::boolean,
  true,
  'the matching browser binding reads the active transaction'
);

select is(
  (
    public.api_mobile_auth_get_browser_transaction(
      '00000000-0000-4000-8000-000000000101',
      array[repeat('2', 43)]
    ) ->> 'found'
  )::boolean,
  false,
  'a wrong browser binding cannot read the transaction'
);

select ok(
  not exists (
    select 1
    from private.mobile_auth_transactions transaction_row
    where to_jsonb(transaction_row)::text like any (
      array[
        '%plaintext-state%',
        '%plaintext-verifier%',
        '%plaintext-handoff%',
        '%plaintext-access-token%',
        '%plaintext-refresh-token%'
      ]
    )
  ),
  'transaction rows contain no plaintext test sentinels'
);

select is(
  (
    public.api_mobile_auth_complete_transaction(
      '00000000-0000-4000-8000-000000000101',
      1,
      repeat('1', 43),
      repeat('R', 43),
      1,
      repeat('9', 43),
      repeat('S', 128),
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011',
      statement_timestamp() + interval '90 seconds'
    ) ->> 'completed'
  )::boolean,
  false,
  'completion cannot bypass the one-winner verification claim'
);

select is(
  (
    public.api_mobile_auth_claim_completion(
      '00000000-0000-4000-8000-000000000101',
      1,
      repeat('1', 43),
      repeat('R', 43),
      1
    ) ->> 'claimed'
  )::boolean,
  true,
  'the matching browser completion wins the verification claim'
);

select is(
  (
    public.api_mobile_auth_claim_completion(
      '00000000-0000-4000-8000-000000000101',
      1,
      repeat('1', 43),
      repeat('R', 43),
      1
    ) ->> 'claimed'
  )::boolean,
  false,
  'a losing browser completion cannot claim the transaction again'
);

select ok(
  (
    select
      status = 'verifying'
      and row_version = 2
      and state_envelope = repeat('E', 64)
      and session_envelope is null
      and handoff_digest is null
    from private.mobile_auth_transactions
    where id = '00000000-0000-4000-8000-000000000101'
  ),
  'the winning claim advances one version and a losing claim changes nothing'
);

do $$
begin
  perform public.api_mobile_auth_complete_transaction(
    '00000000-0000-4000-8000-000000000101',
    2,
    repeat('1', 43),
    repeat('R', 43),
    1,
    repeat('9', 43),
    repeat('S', 128),
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000011',
    statement_timestamp() + interval '121 seconds'
  );

  insert into mobile_auth_test_flags (name, passed)
  values ('handoff_cap_rejected', false);
exception
  when raise_exception then
    insert into mobile_auth_test_flags (name, passed)
    values ('handoff_cap_rejected', true);
end;
$$;

select is(
  (
    select passed
    from mobile_auth_test_flags
    where name = 'handoff_cap_rejected'
  ),
  true,
  'completion rejects a handoff expiry beyond 120 database seconds'
);

select is(
  (
    public.api_mobile_auth_complete_transaction(
      '00000000-0000-4000-8000-000000000101',
      99,
      repeat('1', 43),
      repeat('R', 43),
      1,
      repeat('9', 43),
      repeat('S', 128),
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011',
      statement_timestamp() + interval '90 seconds'
    ) ->> 'completed'
  )::boolean,
  false,
  'completion rejects a stale transaction version'
);

select is(
  (
    public.api_mobile_auth_complete_transaction(
      '00000000-0000-4000-8000-000000000101',
      2,
      repeat('1', 43),
      repeat('X', 43),
      1,
      repeat('9', 43),
      repeat('S', 128),
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011',
      statement_timestamp() + interval '90 seconds'
    ) ->> 'completed'
  )::boolean,
  false,
  'completion rejects a wrong CSRF proof with the correct browser binding'
);

select is(
  (
    public.api_mobile_auth_complete_transaction(
      '00000000-0000-4000-8000-000000000101',
      2,
      repeat('1', 43),
      repeat('R', 43),
      1,
      repeat('9', 43),
      repeat('S', 128),
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011',
      statement_timestamp() + interval '120 seconds'
    ) ->> 'completed'
  )::boolean,
  true,
  'matching completion accepts the exact 120-second handoff boundary'
);

select ok(
  (
    select
      status = 'completed'
      and row_version = 3
      and state_envelope is null
      and session_envelope = repeat('S', 128)
      and handoff_expires_at <= completed_at + interval '120 seconds'
    from private.mobile_auth_transactions
    where id = '00000000-0000-4000-8000-000000000101'
  ),
  'completion clears the state echo and retains only the encrypted session envelope'
);

select is(
  (
    public.api_mobile_auth_prepare_bootstrap(
      array[repeat('9', 43)],
      array[repeat('b', 43)],
      repeat('C', 43),
      'https://app.example.com',
      '/auth/mobile/callback'
    ) ->> 'found'
  )::boolean,
  false,
  'bootstrap preparation rejects the wrong state proof'
);

select is(
  (
    public.api_mobile_auth_prepare_bootstrap(
      array[repeat('9', 43)],
      array[repeat('a', 43)],
      repeat('D', 43),
      'https://app.example.com',
      '/auth/mobile/callback'
    ) ->> 'found'
  )::boolean,
  false,
  'bootstrap preparation rejects the wrong PKCE proof'
);

select is(
  public.api_mobile_auth_prepare_bootstrap(
    array[repeat('8', 43), repeat('9', 43)],
    array[repeat('b', 43), repeat('a', 43)],
    repeat('C', 43),
    'https://app.example.com',
    '/auth/mobile/callback'
  ) ->> 'sessionEnvelope',
  repeat('S', 128),
  'matching bootstrap preparation returns the encrypted envelope to the server'
);

select is(
  (
    public.api_mobile_auth_consume_transaction(
      '00000000-0000-4000-8000-000000000101',
      3,
      repeat('9', 43),
      repeat('a', 43),
      repeat('D', 43),
      'https://app.example.com',
      '/auth/mobile/callback',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011'
    ) ->> 'consumed'
  )::boolean,
  false,
  'atomic consume rejects a wrong proof'
);

select is(
  (
    select session_envelope
    from private.mobile_auth_transactions
    where id = '00000000-0000-4000-8000-000000000101'
  ),
  repeat('S', 128),
  'a losing consume does not destroy the envelope'
);

select is(
  (
    public.api_mobile_auth_consume_transaction(
      '00000000-0000-4000-8000-000000000101',
      3,
      repeat('9', 43),
      repeat('a', 43),
      repeat('C', 43),
      'https://app.example.com',
      '/auth/mobile/callback',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011'
    ) ->> 'consumed'
  )::boolean,
  true,
  'the matching consume wins the one-time transition'
);

select ok(
  (
    select
      status = 'consumed'
      and row_version = 4
      and session_envelope is null
      and consumed_at is not null
    from private.mobile_auth_transactions
    where id = '00000000-0000-4000-8000-000000000101'
  ),
  'the winning consume atomically clears the session envelope'
);

select is(
  (
    public.api_mobile_auth_consume_transaction(
      '00000000-0000-4000-8000-000000000101',
      3,
      repeat('9', 43),
      repeat('a', 43),
      repeat('C', 43),
      'https://app.example.com',
      '/auth/mobile/callback',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000011'
    ) ->> 'consumed'
  )::boolean,
  false,
  'serial replay cannot consume the handoff again'
);

do $$
begin
  perform pg_temp.create_mobile_auth_test_transaction(
    '00000000-0000-4000-8000-000000000102',
    '00000000-0000-4000-8000-000000000202',
    repeat('b', 43),
    repeat('2', 43)
  );

  perform public.api_mobile_auth_claim_completion(
    '00000000-0000-4000-8000-000000000102',
    1,
    repeat('2', 43),
    repeat('R', 43),
    1
  );

  perform public.api_mobile_auth_complete_transaction(
    '00000000-0000-4000-8000-000000000102',
    2,
    repeat('2', 43),
    repeat('R', 43),
    1,
    repeat('8', 43),
    repeat('T', 128),
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000012',
    statement_timestamp() + interval '90 seconds'
  );
end;
$$;

select is(
  (
    public.api_mobile_auth_consume_transaction(
      '00000000-0000-4000-8000-000000000102',
      3,
      repeat('8', 43),
      repeat('b', 43),
      repeat('C', 43),
      'https://app.example.com',
      '/auth/mobile/callback',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000012'
    ) ->> 'consumed'
  )::boolean,
  false,
  'consume fails when the verified source auth session no longer exists'
);

select is(
  (
    select session_envelope
    from private.mobile_auth_transactions
    where id = '00000000-0000-4000-8000-000000000102'
  ),
  repeat('T', 128),
  'a missing source session leaves the envelope available for a valid retry'
);

insert into auth.sessions (id, user_id, created_at, updated_at, not_after)
values (
  '00000000-0000-4000-8000-000000000012',
  '00000000-0000-4000-8000-000000000001',
  statement_timestamp(),
  statement_timestamp(),
  statement_timestamp() - interval '1 minute'
);

select is(
  (
    public.api_mobile_auth_consume_transaction(
      '00000000-0000-4000-8000-000000000102',
      3,
      repeat('8', 43),
      repeat('b', 43),
      repeat('C', 43),
      'https://app.example.com',
      '/auth/mobile/callback',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000012'
    ) ->> 'consumed'
  )::boolean,
  false,
  'consume rejects a source auth session past its not-after boundary'
);

update auth.sessions
set not_after = null
where id = '00000000-0000-4000-8000-000000000012';

select is(
  (
    public.api_mobile_auth_consume_transaction(
      '00000000-0000-4000-8000-000000000102',
      3,
      repeat('8', 43),
      repeat('b', 43),
      repeat('C', 43),
      'https://app.example.com',
      '/auth/mobile/callback',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000012'
    ) ->> 'consumed'
  )::boolean,
  true,
  'consume succeeds once the same subject-bound auth session is valid'
);

select is(
  (
    public.api_mobile_auth_take_rate_limit(
      'start_ip',
      1,
      repeat('d', 43),
      60,
      2
    ) ->> 'allowed'
  )::boolean,
  true,
  'the first rate-limited action is allowed'
);

select is(
  (
    public.api_mobile_auth_take_rate_limit(
      'start_ip',
      1,
      repeat('d', 43),
      60,
      2
    ) ->> 'allowed'
  )::boolean,
  true,
  'the action at the rate threshold is allowed'
);

select is(
  (
    public.api_mobile_auth_take_rate_limit(
      'start_ip',
      1,
      repeat('d', 43),
      60,
      2
    ) ->> 'allowed'
  )::boolean,
  false,
  'the action above the rate threshold is rejected'
);

select is(
  (
    select attempt_count
    from private.mobile_auth_rate_limit_counters
    where scope = 'start_ip'
      and key_digest = repeat('d', 43)
  ),
  3,
  'the rate-limit counter records the saturated rejection'
);

select ok(
  public.api_mobile_auth_log_audit_event(
    '00000000-0000-4000-8000-000000000201',
    'bootstrap_accepted',
    1::smallint,
    'test',
    null,
    '100_499ms',
    '1.2.3+45',
    '18.5'
  ) > 0,
  'safe structured audit metadata is accepted'
);

do $$
begin
  perform public.api_mobile_auth_log_audit_event(
    '00000000-0000-4000-8000-000000000201',
    'token_dumped',
    1::smallint,
    'test',
    null,
    null,
    null,
    null
  );

  insert into mobile_auth_test_flags (name, passed)
  values ('unsafe_audit_rejected', false);
exception
  when check_violation then
    insert into mobile_auth_test_flags (name, passed)
    values ('unsafe_audit_rejected', true);
end;
$$;

select is(
  (
    select passed
    from mobile_auth_test_flags
    where name = 'unsafe_audit_rejected'
  ),
  true,
  'the audit table rejects unapproved event shapes'
);

select ok(
  not exists (
    select 1
    from private.mobile_auth_audit_events event_row
    where to_jsonb(event_row)::text like any (
      array[
        '%plaintext-state%',
        '%plaintext-verifier%',
        '%plaintext-handoff%',
        '%plaintext-access-token%',
        '%plaintext-refresh-token%'
      ]
    )
  ),
  'audit rows contain no plaintext credential sentinels'
);

do $$
begin
  perform pg_temp.create_mobile_auth_test_transaction(
    '00000000-0000-4000-8000-000000000103',
    '00000000-0000-4000-8000-000000000203',
    repeat('c', 43),
    repeat('3', 43)
  );

  perform pg_temp.create_mobile_auth_test_transaction(
    '00000000-0000-4000-8000-000000000104',
    '00000000-0000-4000-8000-000000000204',
    repeat('e', 43),
    repeat('4', 43)
  );

  perform public.api_mobile_auth_claim_completion(
    '00000000-0000-4000-8000-000000000104',
    1,
    repeat('4', 43),
    repeat('R', 43),
    1
  );
end;
$$;

update private.mobile_auth_transactions
set
  created_at = statement_timestamp() - interval '20 minutes',
  updated_at = statement_timestamp() - interval '20 minutes',
  browser_expires_at = statement_timestamp() - interval '10 minutes'
where id in (
  '00000000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000104'
);

select is(
  (
    public.api_mobile_auth_get_browser_transaction(
      '00000000-0000-4000-8000-000000000103',
      array[repeat('3', 43)]
    ) ->> 'found'
  )::boolean,
  false,
  'an expired browser transaction cannot be read'
);

update private.mobile_auth_rate_limit_counters
set
  window_started_at = window_started_at - interval '2 minutes',
  expires_at = expires_at - interval '2 minutes'
where scope = 'start_ip'
  and key_digest = repeat('d', 43);

update private.mobile_auth_audit_events
set created_at = statement_timestamp() - interval '31 days'
where trace_id = '00000000-0000-4000-8000-000000000201';

insert into mobile_auth_cleanup_results (result)
select public.api_mobile_auth_cleanup(1, 86400);

select is(
  (
    select (result ->> 'expiredTransactions')::integer
    from mobile_auth_cleanup_results
  ),
  1,
  'cleanup expires at most the requested transaction batch'
);

select ok(
  (
    select
      status = 'expired'
      and state_envelope is null
      and session_envelope is null
    from private.mobile_auth_transactions
    where id = '00000000-0000-4000-8000-000000000103'
  ),
  'cleanup destroys the first expired transaction envelope'
);

select is(
  (
    select count(*)::integer
    from private.mobile_auth_rate_limit_counters
    where scope = 'start_ip'
      and key_digest = repeat('d', 43)
  ),
  0,
  'cleanup removes expired rate-limit counters'
);

select is(
  (
    select (result ->> 'prunedAuditEvents')::integer
    from mobile_auth_cleanup_results
  ),
  1,
  'cleanup reports audit metadata pruned after the fixed retention window'
);

select is(
  (
    select count(*)::integer
    from private.mobile_auth_audit_events
    where trace_id = '00000000-0000-4000-8000-000000000201'
  ),
  0,
  'cleanup prunes audit metadata after the fixed 30-day retention window'
);

select is(
  (
    public.api_mobile_auth_cleanup(1, 86400)
      ->> 'expiredTransactions'
  )::integer,
  1,
  'a second bounded cleanup expires the remaining transaction'
);

select is(
  (
    select count(*)::integer
    from private.mobile_auth_transactions
    where id in (
      '00000000-0000-4000-8000-000000000103',
      '00000000-0000-4000-8000-000000000104'
    )
      and status = 'expired'
      and state_envelope is null
      and session_envelope is null
  ),
  2,
  'all expired transaction envelopes are eventually destroyed'
);

update private.mobile_auth_transactions
set updated_at = statement_timestamp() - interval '2 days'
where id = '00000000-0000-4000-8000-000000000101';

select is(
  (
    public.api_mobile_auth_cleanup(10, 86400)
      ->> 'prunedTransactions'
  )::integer,
  1,
  'cleanup prunes terminal transaction metadata after retention'
);

select is(
  (
    select count(*)::integer
    from private.mobile_auth_transactions
    where id = '00000000-0000-4000-8000-000000000101'
  ),
  0,
  'the terminal transaction row is removed after retention'
);

select * from finish();

rollback;
