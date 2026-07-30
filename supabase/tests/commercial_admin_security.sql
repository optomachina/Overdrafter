begin;

select plan(35);

-- Keep the mutation probe transaction-local to this test. Production ships only
-- the reusable guard and audit primitives, not an inert public test endpoint.
create table private.commercial_admin_mutation_probes (
  idempotency_scope text primary key,
  required_capability text not null,
  organization_id uuid,
  target_key text not null,
  revision integer not null default 0,
  updated_at timestamptz not null default timezone('utc', now())
);

revoke all on private.commercial_admin_mutation_probes
  from public, anon, authenticated, service_role;

create function private.run_commercial_admin_mutation_probe(
  p_required_capability text,
  p_organization_id uuid,
  p_target_key text,
  p_reason text,
  p_idempotency_key text,
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_actor_user_id uuid;
  v_action text;
  v_scope text;
  v_existing_event public.commercial_admin_audit_events%rowtype;
  v_before_revision integer;
  v_after_revision integer;
  v_event_id uuid;
begin
  v_actor_user_id :=
    private.require_commercial_admin_capability(p_required_capability);

  if nullif(trim(p_target_key), '') is null then
    raise exception 'A commercial operation target is required.';
  end if;

  if length(trim(p_target_key)) > 500 then
    raise exception 'The commercial operation target is too long.';
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'A reason is required for commercial operations.';
  end if;

  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'An idempotency key is required for commercial operations.';
  end if;

  if jsonb_typeof(coalesce(p_request, '{}'::jsonb)) <> 'object' then
    raise exception 'Commercial operation request metadata must be a JSON object.';
  end if;

  if p_organization_id is not null
    and not exists (
      select 1
      from public.organizations organization_row
      where organization_row.id = p_organization_id
    )
  then
    raise exception 'Commercial operation organization was not found.';
  end if;

  perform private.assert_safe_commercial_audit_value(coalesce(p_request, '{}'::jsonb));

  v_action := case p_required_capability
    when 'billing_admin' then 'commercial.guard_probe.billing'
    when 'order_admin' then 'commercial.guard_probe.order'
    else null
  end;

  v_scope := pg_catalog.concat_ws(
    ':',
    'commercial_guard_probe',
    p_required_capability,
    coalesce(p_organization_id::text, 'platform'),
    trim(p_target_key)
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_scope, 0)
  );

  select *
  into v_existing_event
  from public.commercial_admin_audit_events event_row
  where event_row.idempotency_scope = v_scope
    and event_row.idempotency_key = trim(p_idempotency_key);

  if v_existing_event.id is not null then
    if v_existing_event.actor_user_id is distinct from v_actor_user_id
      or v_existing_event.organization_id is distinct from p_organization_id
      or v_existing_event.required_capability is distinct from p_required_capability
      or v_existing_event.action is distinct from v_action
      or v_existing_event.target_type is distinct from 'commercial_admin_guard_probe'
      or v_existing_event.target_id is distinct from trim(p_target_key)
      or v_existing_event.reason is distinct from trim(p_reason)
      or v_existing_event.request_metadata is distinct from coalesce(p_request, '{}'::jsonb)
    then
      raise exception 'Idempotency key has already been used for a different commercial operation.';
    end if;

    return jsonb_build_object(
      'eventId', v_existing_event.id,
      'replayed', true,
      'revision', (v_existing_event.after_state ->> 'revision')::integer
    );
  end if;

  select probe.revision
  into v_before_revision
  from private.commercial_admin_mutation_probes probe
  where probe.idempotency_scope = v_scope
  for update;

  v_before_revision := coalesce(v_before_revision, 0);
  v_after_revision := v_before_revision + 1;

  insert into private.commercial_admin_mutation_probes (
    idempotency_scope,
    required_capability,
    organization_id,
    target_key,
    revision,
    updated_at
  )
  values (
    v_scope,
    p_required_capability,
    p_organization_id,
    trim(p_target_key),
    v_after_revision,
    timezone('utc', now())
  )
  on conflict (idempotency_scope) do update
  set
    revision = excluded.revision,
    updated_at = excluded.updated_at;

  v_event_id := private.append_commercial_admin_audit_event(
    p_organization_id,
    p_required_capability,
    v_action,
    'commercial_admin_guard_probe',
    trim(p_target_key),
    trim(p_reason),
    jsonb_build_object('revision', v_before_revision),
    jsonb_build_object('revision', v_after_revision),
    coalesce(p_request, '{}'::jsonb),
    v_scope,
    trim(p_idempotency_key)
  );

  return jsonb_build_object(
    'eventId', v_event_id,
    'replayed', false,
    'revision', v_after_revision
  );
end;
$$;

revoke all on function private.run_commercial_admin_mutation_probe(
  text,
  uuid,
  text,
  text,
  text,
  jsonb
) from public, anon, authenticated, service_role;

create function public.api_test_billing_admin_mutation(
  p_organization_id uuid,
  p_target_key text,
  p_reason text,
  p_idempotency_key text,
  p_request jsonb default '{}'::jsonb
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select private.run_commercial_admin_mutation_probe(
    'billing_admin',
    p_organization_id,
    p_target_key,
    p_reason,
    p_idempotency_key,
    p_request
  );
$$;

create function public.api_test_order_admin_mutation(
  p_organization_id uuid,
  p_target_key text,
  p_reason text,
  p_idempotency_key text,
  p_request jsonb default '{}'::jsonb
)
returns jsonb
language sql
security definer
set search_path = pg_catalog
as $$
  select private.run_commercial_admin_mutation_probe(
    'order_admin',
    p_organization_id,
    p_target_key,
    p_reason,
    p_idempotency_key,
    p_request
  );
$$;

revoke all on function public.api_test_billing_admin_mutation(
  uuid,
  text,
  text,
  text,
  jsonb
) from public, anon;
revoke all on function public.api_test_order_admin_mutation(
  uuid,
  text,
  text,
  text,
  jsonb
) from public, anon;

grant execute on function public.api_test_billing_admin_mutation(
  uuid,
  text,
  text,
  text,
  jsonb
) to authenticated;
grant execute on function public.api_test_order_admin_mutation(
  uuid,
  text,
  text,
  text,
  jsonb
) to authenticated;

create temporary table ovd234_test_context (
  org_admin_user_id uuid not null,
  platform_viewer_user_id uuid not null,
  billing_admin_user_id uuid not null,
  order_admin_user_id uuid not null,
  organization_id uuid not null,
  second_organization_id uuid not null
) on commit drop;

insert into ovd234_test_context values (
  '00000000-0000-4000-8000-000000002341',
  '00000000-0000-4000-8000-000000002342',
  '00000000-0000-4000-8000-000000002343',
  '00000000-0000-4000-8000-000000002344',
  '00000000-0000-4000-8000-000000002345',
  '00000000-0000-4000-8000-000000002346'
);

grant select on ovd234_test_context to authenticated;

insert into auth.users (id, aud, role, email)
values
  (
    (select org_admin_user_id from ovd234_test_context),
    'authenticated',
    'authenticated',
    'ovd234-org-admin@example.com'
  ),
  (
    (select platform_viewer_user_id from ovd234_test_context),
    'authenticated',
    'authenticated',
    'ovd234-platform-viewer@example.com'
  ),
  (
    (select billing_admin_user_id from ovd234_test_context),
    'authenticated',
    'authenticated',
    'ovd234-billing@example.com'
  ),
  (
    (select order_admin_user_id from ovd234_test_context),
    'authenticated',
    'authenticated',
    'ovd234-order@example.com'
  ),
  (
    '00000000-0000-4000-8000-000000002347',
    'authenticated',
    'authenticated',
    'ovd234-expired@example.com'
  ),
  (
    '00000000-0000-4000-8000-000000002348',
    'authenticated',
    'authenticated',
    'ovd234-revoked@example.com'
  );

insert into public.organizations (id, name, slug)
values
  (
    (select organization_id from ovd234_test_context),
    'OVD 234 Primary Organization',
    'ovd-234-primary'
  ),
  (
    (select second_organization_id from ovd234_test_context),
    'OVD 234 Second Organization',
    'ovd-234-second'
  );

insert into public.organization_memberships (organization_id, user_id, role)
values (
  (select organization_id from ovd234_test_context),
  (select org_admin_user_id from ovd234_test_context),
  'internal_admin'
);

insert into private.platform_admin_emails (email)
values ('ovd234-platform-viewer@example.com');

insert into private.platform_admin_capabilities (
  user_id,
  capability,
  granted_by_user_id,
  grant_reason
)
values
  (
    (select billing_admin_user_id from ovd234_test_context),
    'billing_admin',
    (select billing_admin_user_id from ovd234_test_context),
    'OVD-234 billing authorization test'
  ),
  (
    (select order_admin_user_id from ovd234_test_context),
    'order_admin',
    (select order_admin_user_id from ovd234_test_context),
    'OVD-234 order authorization test'
  );

insert into private.platform_admin_capabilities (
  user_id,
  capability,
  granted_by_user_id,
  grant_reason,
  expires_at,
  revoked_at,
  revoked_by_user_id,
  revocation_reason,
  created_at
)
values
  (
    '00000000-0000-4000-8000-000000002347',
    'billing_admin',
    '00000000-0000-4000-8000-000000002347',
    'OVD-234 expired capability test',
    timezone('utc', now()) - interval '1 day',
    null,
    null,
    null,
    timezone('utc', now()) - interval '2 days'
  ),
  (
    '00000000-0000-4000-8000-000000002348',
    'billing_admin',
    '00000000-0000-4000-8000-000000002348',
    'OVD-234 revoked capability test',
    null,
    timezone('utc', now()),
    '00000000-0000-4000-8000-000000002348',
    'Capability revoked for verification',
    timezone('utc', now()) - interval '1 day'
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select org_admin_user_id from ovd234_test_context),
    'role', 'authenticated',
    'aal', 'aal2'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  (select org_admin_user_id::text from ovd234_test_context),
  true
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'org-admin-denied',
      'Organization role must not grant billing authority',
      'org-admin-denied',
      '{}'::jsonb
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'organization admins cannot mutate commercial state'
);

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select platform_viewer_user_id from ovd234_test_context),
    'role', 'authenticated',
    'aal', 'aal2'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  (select platform_viewer_user_id::text from ovd234_test_context),
  true
);

select ok(
  public.is_platform_admin(),
  'the legacy allowlisted user remains a platform viewer'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'platform-viewer-denied',
      'Platform viewer must not gain mutation authority',
      'platform-viewer-denied',
      '{}'::jsonb
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'platform viewers cannot mutate commercial state'
);

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select billing_admin_user_id from ovd234_test_context),
    'role', 'authenticated',
    'aal', 'aal1'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  (select billing_admin_user_id::text from ovd234_test_context),
  true
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'billing-aal1-denied',
      'AAL1 must fail closed',
      'billing-aal1-denied',
      '{}'::jsonb
    )
  $$,
  'P0001',
  'Multi-factor authentication is required for this commercial operation.',
  'matching capability at AAL1 is denied'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select billing_admin_user_id from ovd234_test_context),
    'role', 'authenticated'
  )::text,
  true
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'billing-missing-aal-denied',
      'Missing assurance must fail closed',
      'billing-missing-aal-denied',
      '{}'::jsonb
    )
  $$,
  'P0001',
  'Multi-factor authentication is required for this commercial operation.',
  'missing AAL claims fail closed'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-4000-8000-000000002347',
    'role', 'authenticated',
    'aal', 'aal2'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000002347',
  true
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'billing-expired-denied',
      'Expired capabilities must fail closed',
      'billing-expired-denied',
      '{}'::jsonb
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'expired capabilities cannot mutate commercial state'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '00000000-0000-4000-8000-000000002348',
    'role', 'authenticated',
    'aal', 'aal2'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000002348',
  true
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'billing-revoked-denied',
      'Revoked capabilities must fail closed',
      'billing-revoked-denied',
      '{}'::jsonb
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'revoked capabilities cannot mutate commercial state'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select billing_admin_user_id from ovd234_test_context),
    'role', 'authenticated',
    'aal', 'aal2'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  (select billing_admin_user_id::text from ovd234_test_context),
  true
);

select is(
  (
    public.api_test_billing_admin_mutation(
      (select organization_id from ovd234_test_context),
      'apex-motion-access',
      'Grant a time-limited trial for support verification',
      'billing-success',
      '{"grantType":"trial"}'::jsonb
    ) ->> 'replayed'
  )::boolean,
  false,
  'billing admins at AAL2 can invoke the billing mutation contract'
);

select throws_ok(
  $$
    select public.api_test_order_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'billing-cannot-order',
      'Cross-capability calls must fail',
      'billing-cannot-order',
      '{}'::jsonb
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'billing admins cannot invoke order mutations'
);

select is(
  (
    public.api_test_billing_admin_mutation(
      (select organization_id from ovd234_test_context),
      'apex-motion-access',
      'Grant a time-limited trial for support verification',
      'billing-success',
      '{"grantType":"trial"}'::jsonb
    ) ->> 'eventId'
  )::uuid,
  (
    select id
    from public.commercial_admin_audit_events
    where idempotency_key = 'billing-success'
  ),
  'an exact retry returns the original audit event'
);

select is(
  (
    select count(*)
    from public.commercial_admin_audit_events
    where idempotency_key = 'billing-success'
  ),
  1::bigint,
  'an exact retry creates one audit event'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'apex-motion-access',
      'Grant a time-limited trial for support verification',
      'billing-success',
      '{"grantType":"complimentary"}'::jsonb
    )
  $$,
  'P0001',
  'Idempotency key has already been used for a different commercial operation.',
  'idempotency-key reuse with different intent is rejected'
);

select ok(
  (
    select
      actor_user_id = (select billing_admin_user_id from ovd234_test_context)
      and organization_id = (select organization_id from ovd234_test_context)
      and required_capability = 'billing_admin'
      and action = 'commercial.guard_probe.billing'
      and target_id = 'apex-motion-access'
      and reason = 'Grant a time-limited trial for support verification'
      and before_state = '{"revision":0}'::jsonb
      and after_state = '{"revision":1}'::jsonb
      and request_metadata = '{"grantType":"trial"}'::jsonb
    from public.commercial_admin_audit_events
    where idempotency_key = 'billing-success'
  ),
  'successful mutations derive complete audit metadata'
);

select throws_ok(
  $$
    insert into public.commercial_admin_audit_events (
      organization_id,
      actor_user_id,
      required_capability,
      action,
      target_type,
      target_id,
      reason,
      idempotency_scope,
      idempotency_key
    )
    values (
      null,
      '00000000-0000-4000-8000-000000002343',
      'billing_admin',
      'commercial.direct_insert',
      'commercial_admin_guard_probe',
      'forged',
      'Forged audit row',
      'forged',
      'forged'
    )
  $$,
  '42501',
  'permission denied for table commercial_admin_audit_events',
  'authenticated users cannot insert commercial audit rows directly'
);

select throws_ok(
  $$
    update public.commercial_admin_audit_events
    set reason = 'tampered'
    where idempotency_key = 'billing-success'
  $$,
  '42501',
  'permission denied for table commercial_admin_audit_events',
  'authenticated users cannot update commercial audit rows'
);

select throws_ok(
  $$
    delete from public.commercial_admin_audit_events
    where idempotency_key = 'billing-success'
  $$,
  '42501',
  'permission denied for table commercial_admin_audit_events',
  'authenticated users cannot delete commercial audit rows'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'sensitive-key',
      'Sensitive keys must be rejected',
      'billing-sensitive-key',
      '{"payment":{"client_secret":"sentinel-secret"}}'::jsonb
    )
  $$,
  'P0001',
  'Sensitive payment or credential data cannot be written to commercial audit records.',
  'credential and payment keys are rejected recursively'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'sensitive-api-key',
      'API keys must be rejected',
      'billing-sensitive-api-key',
      '{"integration":{"api_key":"sentinel-api-key"}}'::jsonb
    )
  $$,
  'P0001',
  'Sensitive payment or credential data cannot be written to commercial audit records.',
  'common API-key fields are rejected recursively'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'sensitive-pan',
      'Potential card values must be rejected',
      'billing-sensitive-pan',
      '{"note":"4242 4242 4242 4242"}'::jsonb
    )
  $$,
  'P0001',
  'Potential card data cannot be written to commercial audit records.',
  'potential card numbers are rejected even under neutral keys'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'sensitive-reason',
      'Support pasted sk_live_1234567890 into the reason',
      'billing-sensitive-reason',
      '{}'::jsonb
    )
  $$,
  'P0001',
  'Potential credential data cannot be written to commercial audit records.',
  'credential-like values are rejected in scalar audit fields'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'stripe-webhook-secret',
      'Reject webhook secret patterns',
      'billing-stripe-secret',
      '{"note":"whsec_1234567890abcdef"}'::jsonb
    )
  $$,
  'P0001',
  'Potential credential data cannot be written to commercial audit records.',
  'Stripe webhook-secret patterns are rejected'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'github-token',
      'Reject GitHub token patterns',
      'billing-github-token',
      '{"note":"ghp_1234567890abcdef"}'::jsonb
    )
  $$,
  'P0001',
  'Potential credential data cannot be written to commercial audit records.',
  'GitHub token patterns are rejected'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'slack-token',
      'Reject Slack token patterns',
      'billing-slack-token',
      '{"note":"xoxb-1234567890-abcdef"}'::jsonb
    )
  $$,
  'P0001',
  'Potential credential data cannot be written to commercial audit records.',
  'Slack token patterns are rejected'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'jwt-token',
      'Reject JWT patterns',
      'billing-jwt-token',
      '{"note":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123"}'::jsonb
    )
  $$,
  'P0001',
  'Potential credential data cannot be written to commercial audit records.',
  'JWT patterns are rejected'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'cloud-key',
      'Reject cloud access-key patterns',
      'billing-cloud-key',
      '{"note":"AKIA1234567890ABCDEF"}'::jsonb
    )
  $$,
  'P0001',
  'Potential credential data cannot be written to commercial audit records.',
  'cloud access-key patterns are rejected'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002345',
      'sensitive-numeric-pan',
      'Numeric card values must be rejected',
      'billing-sensitive-numeric-pan',
      '{"reference":4242424242424242}'::jsonb
    )
  $$,
  'P0001',
  'Potential card data cannot be written to commercial audit records.',
  'potential card numbers are rejected when represented as JSON numbers'
);

reset role;

select ok(
  not has_table_privilege(
    'service_role',
    'public.commercial_admin_audit_events',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.commercial_admin_audit_events',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'public.commercial_admin_audit_events',
    'DELETE'
  )
  and not has_table_privilege(
    'service_role',
    'public.commercial_admin_audit_events',
    'TRUNCATE'
  ),
  'service-role defaults cannot forge or truncate commercial audit history'
);

select throws_ok(
  $$
    update public.commercial_admin_audit_events
    set reason = 'owner tamper attempt'
    where idempotency_key = 'billing-success'
  $$,
  '42501',
  'Commercial audit events are append-only.',
  'the append-only trigger also blocks privileged direct updates'
);

select is(
  (
    select count(*)
    from public.commercial_admin_audit_events
    where idempotency_key in (
        'billing-sensitive-key',
        'billing-sensitive-api-key',
        'billing-sensitive-pan',
        'billing-sensitive-reason',
        'billing-sensitive-numeric-pan',
        'billing-stripe-secret',
        'billing-github-token',
        'billing-slack-token',
        'billing-jwt-token',
        'billing-cloud-key'
      )
      or request_metadata::text like '%sentinel-secret%'
      or request_metadata::text like '%4242 4242%'
  ),
  0::bigint,
  'rejected sensitive values are not persisted'
);

update auth.users
set email = 'ovd234-billing-renamed@example.com'
where id = (select billing_admin_user_id from ovd234_test_context);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select billing_admin_user_id from ovd234_test_context),
    'role', 'authenticated',
    'aal', 'aal2'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  (select billing_admin_user_id::text from ovd234_test_context),
  true
);

select ok(
  public.current_user_has_commercial_capability('billing_admin'),
  'commercial capability remains stable when the user email changes'
);

select is(
  (
    select count(*)
    from public.commercial_admin_audit_events
  ),
  1::bigint,
  'billing admins only read audit events in their capability lane'
);

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', (select order_admin_user_id from ovd234_test_context),
    'role', 'authenticated',
    'aal', 'aal2'
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  (select order_admin_user_id::text from ovd234_test_context),
  true
);

select is(
  (
    public.api_test_order_admin_mutation(
      (select second_organization_id from ovd234_test_context),
      'order-od-1048',
      'Review a manual order',
      'order-success',
      '{"status":"manual_review"}'::jsonb
    ) ->> 'replayed'
  )::boolean,
  false,
  'order admins at AAL2 can invoke the order mutation contract'
);

select throws_ok(
  $$
    select public.api_test_billing_admin_mutation(
      '00000000-0000-4000-8000-000000002346',
      'order-cannot-bill',
      'Cross-capability calls must fail',
      'order-cannot-bill',
      '{}'::jsonb
    )
  $$,
  'P0001',
  'You do not have the required commercial capability.',
  'order admins cannot invoke billing mutations'
);

select is(
  (
    select count(*)
    from public.commercial_admin_audit_events
  ),
  1::bigint,
  'order admins only read audit events in their capability lane'
);

reset role;

select is(
  (
    select count(*)
    from public.commercial_admin_audit_events
  ),
  2::bigint,
  'the two successful capability lanes produced two immutable audit rows'
);

select * from finish();

rollback;
