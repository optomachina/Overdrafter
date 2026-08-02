begin;

select plan(25);

select is(
  (
    select count(*)
    from private.commercial_rollout_controls
    where not enabled
  ),
  4::bigint,
  'every commercial rollout control defaults off'
);

select is(
  private.commercial_rollout_enabled('unknown_capability'),
  false,
  'unknown rollout capabilities fail closed'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.api_set_commercial_rollout_control(text,boolean,text,text,bigint,text)',
    'EXECUTE'
  ),
  'authenticated users cannot mutate rollout controls'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.api_set_commercial_rollout_control(text,boolean,text,text,bigint,text)',
    'EXECUTE'
  ),
  'service role can invoke the rollout-control mutation API'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.api_get_commercial_rollout_controls()',
    'EXECUTE'
  ),
  'authenticated users cannot read rollout-control operations data'
);

select ok(
  not has_table_privilege(
    'service_role',
    'private.commercial_rollout_controls',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'private.commercial_rollout_controls',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'private.commercial_rollout_control_events',
    'INSERT'
  ),
  'service role cannot bypass the audited rollout-control APIs'
);

select is(
  public.api_set_commercial_rollout_control(
    'automatic_quote_collection',
    true,
    'Enable the OVD-313 control contract test',
    'operator@example.com',
    0,
    'ovd313-enable-automatic'
  ) ->> 'replayed',
  'false',
  'a rollout-control action is applied once'
);

select is(
  pg_catalog.jsonb_build_array(
    (
      select enabled
      from private.commercial_rollout_controls
      where capability = 'automatic_quote_collection'
    ),
    (
      select revision
      from private.commercial_rollout_controls
      where capability = 'automatic_quote_collection'
    )
  ),
  '[true, 1]'::jsonb,
  'a real action changes state and increments its revision'
);

select is(
  (
    select updated_by_actor
    from private.commercial_rollout_controls
    where capability = 'automatic_quote_collection'
  ),
  'operator@example.com',
  'the current control records the trusted operator identity'
);

select ok(
  (
    select count(*) = 1
      and bool_and(
        previous_enabled = false
        and enabled = true
        and changed
        and previous_revision = 0
        and revision = 1
        and change_reason = 'Enable the OVD-313 control contract test'
        and changed_by_actor = 'operator@example.com'
        and changed_by_role = 'postgres'
        and idempotency_key = 'ovd313-enable-automatic'
      )
    from private.commercial_rollout_control_events
    where capability = 'automatic_quote_collection'
  ),
  'a real action appends complete immutable operator and state evidence'
);

select is(
  public.api_set_commercial_rollout_control(
    'automatic_quote_collection',
    true,
    'Enable the OVD-313 control contract test',
    'operator@example.com',
    0,
    'ovd313-enable-automatic'
  ) ->> 'replayed',
  'true',
  'an exact action retry returns its original result'
);

select is(
  (
    select count(*)
    from private.commercial_rollout_control_events
    where capability = 'automatic_quote_collection'
  ),
  1::bigint,
  'an exact retry does not append a second audit event'
);

select throws_ok(
  $$
    select public.api_set_commercial_rollout_control(
      'automatic_quote_collection',
      false,
      'Reuse the key for a different action',
      'operator@example.com',
      0,
      'ovd313-enable-automatic'
    )
  $$,
  'P0001',
  'Idempotency key has already been used for a different rollout-control action.',
  'idempotency-key reuse with changed intent is rejected'
);

select throws_ok(
  $$
    select public.api_set_commercial_rollout_control(
      'promotion_codes',
      true,
      'Reuse the key for another capability',
      'operator@example.com',
      0,
      'ovd313-enable-automatic'
    )
  $$,
  'P0001',
  'Idempotency key has already been used for a different rollout-control action.',
  'idempotency keys cannot be reused across capabilities'
);

select throws_ok(
  $$
    select public.api_set_commercial_rollout_control(
      'automatic_quote_collection',
      false,
      'Reject a stale operator decision',
      'second-operator@example.com',
      0,
      'ovd313-stale-automatic'
    )
  $$,
  'P0001',
  'Commercial rollout control changed; refresh and retry.',
  'a stale expected revision is rejected'
);

select ok(
  (
    select enabled and revision = 1
    from private.commercial_rollout_controls
    where capability = 'automatic_quote_collection'
  )
  and (
    select count(*) = 1
    from private.commercial_rollout_control_events
    where capability = 'automatic_quote_collection'
  ),
  'a stale rejection leaves state, revision, and history unchanged'
);

select throws_ok(
  $$
    select public.api_set_commercial_rollout_control(
      'promotion_codes',
      true,
      'Reject a missing revision',
      'operator@example.com',
      null,
      'ovd313-null-revision'
    )
  $$,
  'P0001',
  'A non-negative expected revision is required.',
  'every action requires an expected revision'
);

select throws_ok(
  $$
    select public.api_set_commercial_rollout_control(
      'promotion_codes',
      true,
      'Reject a missing operator',
      null,
      0,
      'ovd313-null-operator'
    )
  $$,
  'P0001',
  'An operator identity between 3 and 200 characters is required.',
  'every action requires a trusted operator identity'
);

select is(
  public.api_set_commercial_rollout_control(
    'automatic_quote_collection',
    true,
    'Record an explicit already-enabled decision',
    'release-manager@example.com',
    1,
    'ovd313-noop-automatic'
  ) ->> 'changed',
  'false',
  'a new same-state operator action is recorded as a no-op'
);

select ok(
  (
    select count(*) = 2
    from private.commercial_rollout_control_events
    where capability = 'automatic_quote_collection'
  )
  and (
    select revision = 1
    from private.commercial_rollout_controls
    where capability = 'automatic_quote_collection'
  ),
  'a no-op is audited without incrementing the state revision'
);

select is(
  pg_catalog.jsonb_build_array(
    (
      select control ->> 'enabled'
      from pg_catalog.jsonb_array_elements(
        public.api_get_commercial_rollout_controls() -> 'controls'
      ) control
      where control ->> 'capability' = 'automatic_quote_collection'
    ),
    pg_catalog.jsonb_array_length(
      public.api_get_commercial_rollout_controls() -> 'recentEvents'
    )
  ),
  '["true", 2]'::jsonb,
  'the service-only read model returns current state and recent actions'
);

select throws_ok(
  $$
    update private.commercial_rollout_control_events
    set change_reason = 'forged'
    where capability = 'automatic_quote_collection'
  $$,
  'P0001',
  'Commercial rollout control events are immutable.',
  'rollout-control audit events cannot be updated'
);

select throws_ok(
  $$
    delete from private.commercial_rollout_control_events
    where capability = 'automatic_quote_collection'
  $$,
  'P0001',
  'Commercial rollout control events are immutable.',
  'rollout-control audit events cannot be deleted'
);

select ok(
  not private.commercial_rollout_enabled('commercial_admin_mutations')
  and not private.commercial_rollout_enabled('promotion_codes')
  and not private.commercial_rollout_enabled('order_administration'),
  'unrelated commercial capabilities remain independently off'
);

select is(
  public.api_set_commercial_rollout_control(
    'automatic_quote_collection',
    false,
    'Restore automatic quote collection to default off',
    'operator@example.com',
    1,
    'ovd313-disable-automatic'
  ) ->> 'enabled',
  'false',
  'one capability can be rolled back independently'
);

select * from finish();

rollback;
