-- This test intentionally commits fixture rows so independent dblink sessions
-- can exercise real advisory-lock behavior. It removes only its fixed IDs.

create extension if not exists dblink with schema extensions;

select plan(8);

do $$
begin
  if current_database() <> 'postgres'
     or session_user <> 'postgres'
     or exists (
       select 1
       from auth.users
       where id <> '00000000-0000-4000-8000-000000002298'
     )
     or not exists (
       select 1
       from private.commercial_rollout_controls
       where capability = 'commercial_admin_mutations'
         and not enabled
         and revision = 0
     )
     or exists (
       select 1
       from private.commercial_rollout_control_events
       where idempotency_key = 'ovd315-entitlement-concurrency-disable'
     ) then
    raise exception
      'OVD-229 concurrency tests require a freshly reset disposable local database';
  end if;

  if exists (
    select 1
    from public.organizations
    where id = '00000000-0000-4000-8000-000000002297'
      and (
        name is distinct from 'OVD 229 Concurrency'
        or slug is distinct from 'ovd-229-concurrency'
      )
  ) or exists (
    select 1
    from auth.users
    where id = '00000000-0000-4000-8000-000000002298'
      and email is distinct from 'ovd229-concurrency@example.com'
  ) then
    raise exception
      'OVD-229 fixed fixture identifiers collide with non-test data';
  end if;
end;
$$;

begin;

alter table public.commercial_admin_audit_events
  disable trigger reject_commercial_admin_audit_mutation;
delete from public.commercial_admin_audit_events
where organization_id = '00000000-0000-4000-8000-000000002297';
alter table public.commercial_admin_audit_events
  enable trigger reject_commercial_admin_audit_mutation;

delete from private.organization_entitlement_grants
where organization_id = '00000000-0000-4000-8000-000000002297';
delete from private.platform_admin_capabilities
where user_id = '00000000-0000-4000-8000-000000002298';
delete from public.organizations
where id = '00000000-0000-4000-8000-000000002297';
delete from auth.users
where id = '00000000-0000-4000-8000-000000002298';

update private.commercial_rollout_controls
set
  enabled = true,
  revision = 1,
  change_reason = 'Enable OVD-315 disposable concurrency verification',
  updated_at = pg_catalog.now(),
  updated_by_actor = 'ovd315-concurrency-test'
where capability = 'commercial_admin_mutations';

drop function if exists public.ovd229_concurrent_revoke(uuid, text);
drop function if exists public.ovd229_concurrent_grant(text);

insert into auth.users (id, aud, role, email)
values (
  '00000000-0000-4000-8000-000000002298',
  'authenticated',
  'authenticated',
  'ovd229-concurrency@example.com'
);

insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000002297',
  'OVD 229 Concurrency',
  'ovd-229-concurrency'
);

insert into private.platform_admin_capabilities (
  user_id,
  capability,
  granted_by_user_id,
  grant_reason
)
values (
  '00000000-0000-4000-8000-000000002298',
  'billing_admin',
  '00000000-0000-4000-8000-000000002298',
  'OVD-229 concurrency verification'
);

create function public.ovd229_concurrent_grant(
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000002298","role":"authenticated","aal":"aal2"}',
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    '00000000-0000-4000-8000-000000002298',
    true
  );

  return public.api_admin_grant_organization_entitlement(
    '00000000-0000-4000-8000-000000002297',
    'trial',
    '2026-07-01T00:00:00Z',
    '2026-12-01T00:00:00Z',
    null,
    'Concurrent trial verification',
    p_idempotency_key
  );
end;
$$;

create function public.ovd229_concurrent_revoke(
  p_grant_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000002298","role":"authenticated","aal":"aal2"}',
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    '00000000-0000-4000-8000-000000002298',
    true
  );

  return public.api_admin_revoke_organization_entitlement(
    p_grant_id,
    'Concurrent revoke verification',
    p_idempotency_key
  );
end;
$$;

revoke all on function public.ovd229_concurrent_grant(text)
  from public, anon, authenticated, service_role;
revoke all on function public.ovd229_concurrent_revoke(uuid, text)
  from public, anon, authenticated, service_role;

commit;

select extensions.dblink_connect(
  'ovd229_a',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);
select extensions.dblink_connect(
  'ovd229_b',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);

select extensions.dblink_send_query(
  'ovd229_a',
  $query$
    select public.ovd229_concurrent_grant('same-grant-key')
  $query$
);
select extensions.dblink_send_query(
  'ovd229_b',
  $query$
    select public.ovd229_concurrent_grant('same-grant-key')
  $query$
);

create temporary table ovd229_concurrent_results (
  result jsonb not null
);

insert into ovd229_concurrent_results
select result
from extensions.dblink_get_result('ovd229_a') as response(result jsonb);
insert into ovd229_concurrent_results
select result
from extensions.dblink_get_result('ovd229_b') as response(result jsonb);
select *
from extensions.dblink_get_result('ovd229_a') as response(result jsonb);
select *
from extensions.dblink_get_result('ovd229_b') as response(result jsonb);

select is(
  (
    select count(*)
    from ovd229_concurrent_results
    where (result ->> 'replayed')::boolean
  ),
  1::bigint,
  'two identical concurrent grants return one replay'
);

select is(
  (
    select count(*)
    from private.organization_entitlement_grants
    where organization_id = '00000000-0000-4000-8000-000000002297'
  ),
  1::bigint,
  'two identical concurrent grants create one grant'
);

select is(
  (
    select count(*)
    from public.commercial_admin_audit_events
    where organization_id = '00000000-0000-4000-8000-000000002297'
      and action = 'commercial.entitlement.grant'
  ),
  1::bigint,
  'two identical concurrent grants create one audit event'
);

truncate table ovd229_concurrent_results;

select extensions.dblink_send_query(
  'ovd229_a',
  $query$
    select public.ovd229_concurrent_grant('competing-grant-a')
  $query$
);
select extensions.dblink_send_query(
  'ovd229_b',
  $query$
    select public.ovd229_concurrent_grant('competing-grant-b')
  $query$
);

insert into ovd229_concurrent_results
select result
from extensions.dblink_get_result('ovd229_a') as response(result jsonb);
insert into ovd229_concurrent_results
select result
from extensions.dblink_get_result('ovd229_b') as response(result jsonb);
select *
from extensions.dblink_get_result('ovd229_a') as response(result jsonb);
select *
from extensions.dblink_get_result('ovd229_b') as response(result jsonb);

select is(
  (
    select count(*)
    from private.organization_entitlement_grants
    where organization_id = '00000000-0000-4000-8000-000000002297'
      and grant_type = 'trial'
      and revoked_at is null
  ),
  1::bigint,
  'different-key concurrent grants leave one current trial'
);

truncate table ovd229_concurrent_results;

select extensions.dblink_send_query(
  'ovd229_a',
  format(
    'select public.ovd229_concurrent_revoke(%L,%L)',
    (
      select id
      from private.organization_entitlement_grants
      where organization_id = '00000000-0000-4000-8000-000000002297'
        and grant_type = 'trial'
        and revoked_at is null
    ),
    'same-revoke-key'
  )
);
select extensions.dblink_send_query(
  'ovd229_b',
  format(
    'select public.ovd229_concurrent_revoke(%L,%L)',
    (
      select id
      from private.organization_entitlement_grants
      where organization_id = '00000000-0000-4000-8000-000000002297'
        and grant_type = 'trial'
        and revoked_at is null
    ),
    'same-revoke-key'
  )
);

insert into ovd229_concurrent_results
select result
from extensions.dblink_get_result('ovd229_a') as response(result jsonb);
insert into ovd229_concurrent_results
select result
from extensions.dblink_get_result('ovd229_b') as response(result jsonb);
select *
from extensions.dblink_get_result('ovd229_a') as response(result jsonb);
select *
from extensions.dblink_get_result('ovd229_b') as response(result jsonb);

select is(
  (
    select count(*)
    from public.commercial_admin_audit_events
    where organization_id = '00000000-0000-4000-8000-000000002297'
      and action = 'commercial.entitlement.revoke'
      and idempotency_key = 'same-revoke-key'
  ),
  1::bigint,
  'two identical concurrent revocations create one audit event'
);

select is(
  private.resolve_organization_entitlements_at(
    '00000000-0000-4000-8000-000000002297',
    '2026-08-01T00:00:00Z'
  ) ->> 'plan',
  'free',
  'the resolver matches the final committed concurrent state'
);

select extensions.dblink_exec('ovd229_a', 'begin');

truncate table ovd229_concurrent_results;

insert into ovd229_concurrent_results
select result
from extensions.dblink(
  'ovd229_a',
  $query$
    select public.ovd229_concurrent_grant('rollout-lock-grant')
  $query$
) as response(result jsonb);

select extensions.dblink_send_query(
  'ovd229_b',
  $query$
    select public.api_set_commercial_rollout_control(
      'commercial_admin_mutations',
      false,
      'Disable after the in-flight entitlement mutation commits',
      'ovd229-concurrency-suite',
      1,
      'ovd315-entitlement-concurrency-disable'
    )
  $query$
);

select pg_catalog.pg_sleep(0.1);

select is(
  extensions.dblink_is_busy('ovd229_b'),
  1,
  'rollout disablement waits for an in-flight entitlement mutation'
);

select extensions.dblink_exec('ovd229_a', 'commit');

truncate table ovd229_concurrent_results;

insert into ovd229_concurrent_results
select result
from extensions.dblink_get_result('ovd229_b') as response(result jsonb);
select *
from extensions.dblink_get_result('ovd229_b') as response(result jsonb);

select is(
  (
    select pg_catalog.jsonb_build_array(
      result ->> 'enabled',
      result ->> 'revision'
    )
    from ovd229_concurrent_results
  ),
  '["false", "2"]'::jsonb,
  'disablement commits immediately after the in-flight mutation finishes'
);

select extensions.dblink_disconnect('ovd229_a');
select extensions.dblink_disconnect('ovd229_b');

begin;

drop function public.ovd229_concurrent_revoke(uuid, text);
drop function public.ovd229_concurrent_grant(text);

alter table public.commercial_admin_audit_events
  disable trigger reject_commercial_admin_audit_mutation;
delete from public.commercial_admin_audit_events
where organization_id = '00000000-0000-4000-8000-000000002297';
alter table public.commercial_admin_audit_events
  enable trigger reject_commercial_admin_audit_mutation;

delete from private.organization_entitlement_grants
where organization_id = '00000000-0000-4000-8000-000000002297';
delete from private.platform_admin_capabilities
where user_id = '00000000-0000-4000-8000-000000002298';
delete from public.organizations
where id = '00000000-0000-4000-8000-000000002297';
delete from auth.users
where id = '00000000-0000-4000-8000-000000002298';

alter table private.commercial_rollout_control_events
  disable trigger reject_commercial_rollout_control_event_mutation;
delete from private.commercial_rollout_control_events
where idempotency_key = 'ovd315-entitlement-concurrency-disable';
alter table private.commercial_rollout_control_events
  enable trigger reject_commercial_rollout_control_event_mutation;

update private.commercial_rollout_controls
set
  enabled = false,
  revision = 0,
  change_reason = 'Default-off commercial operations rollout',
  updated_at = pg_catalog.now(),
  updated_by_user_id = null,
  updated_by_actor = null
where capability = 'commercial_admin_mutations';

commit;

select * from finish();
