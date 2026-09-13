begin;

select no_plan();

create temporary table ovd504_constants (
 api_role text not null,
 billing_capability text not null,
 order_capability text not null,
 primary_grant uuid not null,
 rejected_grant uuid not null,
 third_org uuid not null,
 reason text not null,
 replay_key text not null,
 scope text not null,
 replay_error text not null,
 card_error text not null,
 error_state text not null
) on commit drop;
insert into ovd504_constants values (
 'authenticated',
 'billing_admin',
 'order_admin',
 'aaaaaaaa-4111-4111-8111-1110aaaaaaaa',
 'cccccccc-4111-4111-8111-1110cccccccc',
 '00000000-0000-4000-8000-000000005043',
 'Finished trial',
 'ovd504-revoke',
 'organization_entitlement_revoke:aaaaaaaa-4111-4111-8111-1110aaaaaaaa',
 'Idempotency key has already been used for a different entitlement revocation.',
 'Potential card data cannot be written to commercial audit records.',
 'P0001'
);
grant select on ovd504_constants to authenticated;


create temporary table ovd229_context (
  organization_id uuid not null,
  second_organization_id uuid not null,
  member_user_id uuid not null,
  platform_viewer_user_id uuid not null,
  billing_admin_user_id uuid not null,
  order_admin_user_id uuid not null
) on commit drop;

insert into ovd229_context values (
  '00000000-0000-4000-8000-000000002291',
  '00000000-0000-4000-8000-000000002292',
  '00000000-0000-4000-8000-000000002293',
  '00000000-0000-4000-8000-000000002294',
  '00000000-0000-4000-8000-000000002295',
  '00000000-0000-4000-8000-000000002296'
);

create temporary table ovd315_test_constants (
  rollout_capability text not null,
  rollout_actor text not null,
  expected_manual_source text not null,
  cascade_organization_id uuid not null,
  cascade_grant_id uuid not null,
  unguarded_grant_function regprocedure not null,
  unguarded_revoke_function regprocedure not null,
  mutation_guard_function regprocedure not null
) on commit drop;

insert into ovd315_test_constants values (
  'commercial_admin_mutations',
  'ovd315-test-runner',
  'manual_complimentary',
  '00000000-0000-4000-8000-000000002290',
  '00000000-0000-4000-8000-000000002289',
  'private.api_admin_grant_organization_entitlement_unguarded(uuid,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)',
  'private.api_admin_revoke_organization_entitlement_unguarded(uuid,text,text)',
  'private.require_commercial_admin_mutation(text)'
);

grant select on ovd315_test_constants to authenticated;

grant select on ovd229_context to authenticated;

create function public.ovd229_test_set_claims(
  p_user_id uuid,
  p_aal text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_user_id,
      'role', (select api_role from ovd504_constants),
      'aal', p_aal
    )::text,
    true
  );
  perform pg_catalog.set_config(
    'request.jwt.claim.sub',
    p_user_id::text,
    true
  );
end;
$$;

revoke all on function public.ovd229_test_set_claims(uuid, text)
  from public, anon;
grant execute on function public.ovd229_test_set_claims(uuid, text)
  to authenticated;

insert into auth.users (id, aud, role, email)
values
  (
    (select member_user_id from ovd229_context),
    (select api_role from ovd504_constants),
    (select api_role from ovd504_constants),
    'ovd229-member@example.com'
  ),
  (
    (select platform_viewer_user_id from ovd229_context),
    (select api_role from ovd504_constants),
    (select api_role from ovd504_constants),
    'ovd229-platform-viewer@example.com'
  ),
  (
    (select billing_admin_user_id from ovd229_context),
    (select api_role from ovd504_constants),
    (select api_role from ovd504_constants),
    'ovd229-billing@example.com'
  ),
  (
    (select order_admin_user_id from ovd229_context),
    (select api_role from ovd504_constants),
    (select api_role from ovd504_constants),
    'ovd229-order@example.com'
  );

insert into public.organizations (id, name, slug)
values
  (
    (select organization_id from ovd229_context),
    'OVD 229 Primary',
    'ovd-229-primary'
  ),
  (
    (select second_organization_id from ovd229_context),
    'OVD 229 Secondary',
    'ovd-229-secondary'
  );

insert into public.organization_memberships (
  organization_id,
  user_id,
  role
)
values (
  (select organization_id from ovd229_context),
  (select member_user_id from ovd229_context),
  'internal_admin'
);

insert into private.platform_admin_emails (email)
values ('ovd229-platform-viewer@example.com');

insert into private.platform_admin_capabilities (
  user_id,
  capability,
  granted_by_user_id,
  grant_reason
)
values
  (
    (select billing_admin_user_id from ovd229_context),
    (select billing_capability from ovd504_constants),
    (select billing_admin_user_id from ovd229_context),
    'OVD-229 billing authorization test'
  ),
  (
    (select order_admin_user_id from ovd229_context),
    (select order_capability from ovd504_constants),
    (select order_admin_user_id from ovd229_context),
    'OVD-229 order authorization test'
  );


insert into public.organizations(id,name,slug) values ((select third_org from ovd504_constants),'OVD504 Third','ovd504-third');

-- Only synthetic local fixtures; these UUIDs contain Luhn-valid digit spans.
insert into private.organization_entitlement_grants
 (id,organization_id,grant_type,starts_at,expires_at,grant_reason,granted_by_user_id)
select id::uuid, grant_org::uuid,'trial',now(),now()+interval '1 day','UUID regression',billing_admin_user_id
from ovd229_context cross join (values
 ((select primary_grant from ovd504_constants),'00000000-0000-4000-8000-000000002291'),
 ('bbbbbbbb-4111-4111-8111-1110bbbbbbbb','00000000-0000-4000-8000-000000002292'),
 ((select rejected_grant from ovd504_constants),(select third_org from ovd504_constants))) ids(id,grant_org);

set local role service_role;
select public.api_set_commercial_rollout_control('commercial_admin_mutations',true,
 'Local UUID regression','ovd504-test',0,'ovd504-enable');
set local role authenticated;
select public.ovd229_test_set_claims((select billing_admin_user_id from ovd229_context),'aal2');

select lives_ok($$select public.api_admin_revoke_organization_entitlement(
 (select primary_grant from ovd504_constants),(select reason from ovd504_constants),(select replay_key from ovd504_constants))$$,
 'actual revoke accepts a server-generated colliding UUID scope');
select is((select idempotency_scope from public.commercial_admin_audit_events
 where idempotency_key=(select replay_key from ovd504_constants)),
 (select scope from ovd504_constants),
 'persisted scope bytes remain unchanged');
select is((public.api_admin_revoke_organization_entitlement(
 (select primary_grant from ovd504_constants),(select reason from ovd504_constants),(select replay_key from ovd504_constants))->>'replayed')::boolean,
 true,'exact retry returns the original receipt');
select is((select count(*) from public.commercial_admin_audit_events where idempotency_key=(select replay_key from ovd504_constants)),
 1::bigint,'replay adds no audit event');
select throws_ok($$select public.api_admin_revoke_organization_entitlement(
 (select primary_grant from ovd504_constants),'Different reason',(select replay_key from ovd504_constants))$$,
 (select error_state from ovd504_constants),(select replay_error from ovd504_constants),
 'changed reason cannot reuse the key');
select lives_ok($$select public.api_admin_revoke_organization_entitlement(
 'bbbbbbbb-4111-4111-8111-1110bbbbbbbb','Finished second trial','ovd504-second')$$,
 'second deterministic UUID also succeeds through actual API');
select throws_ok($$select public.api_admin_revoke_organization_entitlement(
 (select rejected_grant from ovd504_constants),
 'aaaaaaaa-4111-4111-8111-1110aaaaaaaa card 4111 1111 1111 1111','ovd504-leak')$$,
 (select error_state from ovd504_constants),(select card_error from ovd504_constants),
 'card data beside UUID in real API reason still fails');
reset role;
select is((select revoked_at from private.organization_entitlement_grants
 where id=(select rejected_grant from ovd504_constants)),null::timestamptz,
 'failed audit rolls back grant revocation');
select is((select count(*) from public.commercial_admin_audit_events where idempotency_key='ovd504-leak'),
 0::bigint,'failed revocation has no audit receipt');

-- Exercise the private append boundary without exposing it to an API role.
create function pg_temp.ovd504_append(
 scope text,
 action text default 'commercial.entitlement.revoke',
 target_type text default 'organization_entitlement_grant',
 target text default null,
 capability text default null,
 metadata jsonb default '{}',
 event_key text default 'ovd504-boundary'
) returns uuid language sql as $$
 select private.append_commercial_admin_audit_event(
 (select organization_id from ovd229_context), coalesce(capability,(select billing_capability from ovd504_constants)), action,target_type,coalesce(target,(select primary_grant::text from ovd504_constants)),
 'Boundary regression',null,null,metadata,scope,event_key);
$$;
select throws_ok(format('select pg_temp.ovd504_append(%L)',scope),
 (select error_state from ovd504_constants),(select card_error from ovd504_constants),label)
from (values
 ('prefix:organization_entitlement_revoke:aaaaaaaa-4111-4111-8111-1110aaaaaaaa','prefix is not trusted'),
 ('organization_entitlement_revoke:aaaaaaaa-4111-4111-8111-1110aaaaaaaa:suffix','suffix is not trusted'),
 ('organization_entitlement_revoke:aaaaaaaa-4111-4111-8111-1110aaaaaaaa 4111111111111111','appended card is rejected'),
 ('organization_entitlement_revoke:bbbbbbbb-4111-4111-8111-1110bbbbbbbb','different target is not trusted'),
 (' organization_entitlement_revoke:aaaaaaaa-4111-4111-8111-1110aaaaaaaa','whitespace is not trusted')
) cases(scope,label);
select throws_ok($$select pg_temp.ovd504_append(
 (select scope from ovd504_constants),
 action=>'commercial.entitlement.grant')$$,
 (select error_state from ovd504_constants),(select card_error from ovd504_constants),'wrong action is not trusted');
select throws_ok($$select pg_temp.ovd504_append(
 (select scope from ovd504_constants),target_type=>'other')$$,
 (select error_state from ovd504_constants),(select card_error from ovd504_constants),'wrong target type is not trusted');
select throws_ok($$select pg_temp.ovd504_append(
 (select scope from ovd504_constants),
 metadata=>' {"note":"aaaaaaaa-4111-4111-8111-1110aaaaaaaa 4111-1111-1111-1111"}')$$,
 (select error_state from ovd504_constants),(select card_error from ovd504_constants),'nested card beside UUID is rejected');
select throws_ok($$select pg_temp.ovd504_append(
 (select scope from ovd504_constants),event_key=>'4111111111111111')$$,
 (select error_state from ovd504_constants),(select card_error from ovd504_constants),'idempotency keys retain card detection');
select throws_ok(format('select private.assert_safe_commercial_audit_value(%L::jsonb)',payload),
 (select error_state from ovd504_constants),(select card_error from ovd504_constants),label)
from (values
 ('4111111111111111','numeric card remains rejected'),
 ('["aaaaaaaa-4111-4111-8111-1110aaaaaaaa","4111111111111111"]','card in array beside UUID remains rejected'),
 ('"note aaaaaaaa-4111-4111-8111-1110aaaaaaaa 4111111111111111"','generic embedded UUID is not bypassed')
) cases(payload,label);
select throws_ok($$select pg_temp.ovd504_append(
 (select scope from ovd504_constants),metadata=>'{"password":"synthetic-secret"}')$$,
 (select error_state from ovd504_constants),'Sensitive payment or credential data cannot be written to commercial audit records.',
 'credential-key rejection is unchanged');
-- A different capability must not select the trusted tuple, even when held.
insert into private.platform_admin_capabilities(user_id,capability,granted_by_user_id,grant_reason)
select billing_admin_user_id,(select order_capability from ovd504_constants),billing_admin_user_id,'Local capability regression' from ovd229_context;
select throws_ok($$select pg_temp.ovd504_append(
 (select scope from ovd504_constants),capability=>(select order_capability from ovd504_constants))$$,
 (select error_state from ovd504_constants),(select card_error from ovd504_constants),'different held capability is not trusted');
insert into private.platform_admin_capabilities(user_id,capability,granted_by_user_id,grant_reason)
select order_admin_user_id,(select billing_capability from ovd504_constants),billing_admin_user_id,'Local replay actor regression' from ovd229_context;
set local role authenticated;
select public.ovd229_test_set_claims((select order_admin_user_id from ovd229_context),'aal2');
select throws_ok($$select public.api_admin_revoke_organization_entitlement(
 (select primary_grant from ovd504_constants),(select reason from ovd504_constants),(select replay_key from ovd504_constants))$$,
 (select error_state from ovd504_constants),(select replay_error from ovd504_constants),
 'another authorized actor cannot replay the original receipt');
reset role;
select * from finish();
rollback;
