begin;

create extension if not exists pgtap with schema extensions;

select plan(19);

create function pg_temp.set_ovd486_request_identity(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_user_id,
      'role', 'authenticated', -- NOSONAR: stable JWT fixture claim
      'aal', 'aal1'
    )::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

create temporary table ovd486_test_context (
  admin_user_id uuid not null,
  member_user_id uuid not null
) on commit drop;

insert into ovd486_test_context values (
  '00000000-0000-4000-8000-000000004861',
  '00000000-0000-4000-8000-000000004862'
);

grant select on ovd486_test_context to authenticated;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values
  (
    (select admin_user_id from ovd486_test_context),
    'authenticated',
    'authenticated',
    'ovd486-admin@example.com',
    pg_catalog.timezone('utc', pg_catalog.now())
  ),
  (
    (select member_user_id from ovd486_test_context),
    'authenticated',
    'authenticated',
    'ovd486-member@example.com',
    pg_catalog.timezone('utc', pg_catalog.now())
  );

insert into private.platform_admin_emails (email)
values ('ovd486-admin@example.com');

select has_table(
  'private',
  'platform_admin_notifications',
  'provider-added notifications use a private durable source'
);

select has_function(
  'public',
  'api_admin_list_platform_notifications',
  array['integer'],
  'the platform-admin notification reader has the reviewed signature'
);

select has_trigger(
  'private',
  'quote_provider_admission_policies',
  'capture_provider_added_notification',
  'new provider policy identities have a notification trigger'
);

select is(
  (select pg_catalog.count(*)::integer from private.platform_admin_notifications),
  0,
  'existing provider policies are not backfilled as new notifications'
);

alter table private.quote_provider_admission_policies
  disable trigger guard_quote_provider_admission_policy_mutation;
delete from private.quote_provider_admission_policies
where provider = 'fastdms'; -- NOSONAR: transaction-local provider fixture reset
alter table private.quote_provider_admission_policies
  enable trigger guard_quote_provider_admission_policy_mutation;

insert into private.quote_provider_admission_policies (
  provider,
  admission_state,
  generic_dispatch_enabled,
  policy_revision,
  change_reason
)
values (
  'fastdms', -- NOSONAR: deterministic non-disabled provider fixture
  'evidence_required',
  false,
  'ovd486-fastdms-evidence.v1',
  'initial_seed'
);

select is(
  (select pg_catalog.count(*)::integer from private.platform_admin_notifications),
  0,
  'a non-disabled policy identity does not create a provider-added notification'
);

alter table private.quote_provider_admission_policies
  disable trigger guard_quote_provider_admission_policy_mutation;
delete from private.quote_provider_admission_policies
where provider = 'devzmanufacturing'; -- NOSONAR: transaction-local provider fixture reset
alter table private.quote_provider_admission_policies
  enable trigger guard_quote_provider_admission_policy_mutation;

insert into private.quote_provider_admission_policies (
  provider,
  admission_state,
  generic_dispatch_enabled,
  policy_revision,
  change_reason
)
values (
  'devzmanufacturing', -- NOSONAR: deterministic disabled provider fixture
  'disabled',
  false,
  'ovd486-devz-disabled.v1',
  'initial_seed'
);

select is(
  (select pg_catalog.count(*)::integer from private.platform_admin_notifications),
  1,
  'a newly inserted disabled provider identity creates one notification'
);

select ok(
  (
    select notification_type = 'provider.integration_added'
      and provider = 'devzmanufacturing'
      and policy_revision = 'ovd486-devz-disabled.v1'
      and admission_state = 'disabled'
      and generic_dispatch_enabled is false
    from private.platform_admin_notifications
    where event_key = 'provider.integration_added:devzmanufacturing:ovd486-devz-disabled.v1'
  ),
  'the notification captures only the disabled identity snapshot'
);

update private.quote_provider_admission_policies
set policy_revision = 'ovd486-devz-disabled.v2',
    change_reason = 'policy_updated'
where provider = 'devzmanufacturing';

select is(
  (select pg_catalog.count(*)::integer from private.platform_admin_notifications),
  1,
  'later policy revisions do not announce the provider again'
);

select throws_ok(
  $$update private.platform_admin_notifications set policy_revision = 'ovd486-mutated.v1'$$,
  'P0001',
  'Platform admin notifications are append-only.',
  'notification history cannot be updated'
);

select throws_ok(
  $$delete from private.platform_admin_notifications$$,
  'P0001',
  'Platform admin notifications are append-only.',
  'notification history cannot be deleted'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from information_schema.columns column_row
    where column_row.table_schema = 'private'
      and column_row.table_name = 'platform_admin_notifications'
      and column_row.column_name in (
        'credential', 'password', 'secret', 'api_key', 'account_id',
        'customer_file', 'file_path', 'raw_response', 'raw_payload',
        'session_state', 'browser_state', 'cookie'
      )
  ),
  0,
  'notification storage has no credential, account, file, or session columns'
);

set local role authenticated;
select pg_temp.set_ovd486_request_identity(
  (select member_user_id from ovd486_test_context)
);

select throws_ok(
  $$select public.api_admin_list_platform_notifications(20)$$,
  'P0001',
  'Platform admin access required.',
  'ordinary authenticated users cannot read platform notifications'
);

select throws_ok(
  $$select * from private.platform_admin_notifications$$,
  '42501',
  null,
  'authenticated callers cannot read the private source directly'
);

select ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.api_admin_list_platform_notifications(integer)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.api_admin_list_platform_notifications(integer)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'service_role',
    'public.api_admin_list_platform_notifications(integer)',
    'EXECUTE'
  ),
  'only authenticated sessions receive execute permission on the guarded reader'
);

select pg_temp.set_ovd486_request_identity(
  (select admin_user_id from ovd486_test_context)
);

select is(
  pg_catalog.jsonb_array_length(public.api_admin_list_platform_notifications(20)),
  1,
  'a current platform administrator can read the durable event'
);

select is(
  public.api_admin_list_platform_notifications(20) -> 0 ->> 'id',
  'provider.integration_added:devzmanufacturing:ovd486-devz-disabled.v1',
  'the read API returns the stable event key used for dedupe'
);

select is(
  pg_catalog.jsonb_array_length(public.api_admin_list_platform_notifications(0)),
  1,
  'the read API clamps a non-positive limit to one row'
);

reset role;
set local role service_role;

select throws_ok(
  $$select * from private.platform_admin_notifications$$,
  '42501',
  null,
  'service_role cannot bypass the guarded read API with direct table access'
);

select throws_ok(
  $$select public.api_admin_list_platform_notifications(20)$$,
  '42501',
  null,
  'service_role cannot invoke the platform-admin reader without an authenticated admin identity'
);

reset role;

select * from finish();

rollback;
