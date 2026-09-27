begin;
set local search_path = public, extensions;

create extension if not exists pgtap with schema extensions;
select plan(36);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values
  ('87000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'sourcing-admin@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb),
  ('87000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'sourcing-outsider@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb);

insert into public.organizations (
  id, name, slug, shipping_same_as_billing, shipping_street, shipping_city,
  shipping_state, shipping_zip, shipping_country
) values (
  '87000000-0000-4000-8000-000000000003', 'Sourcing intent fixture', 'sourcing-intent-fixture',
  false, '123 Test Ave', 'Tucson', 'AZ', null, 'US'
);

insert into public.organization_memberships (organization_id, user_id, role)
values ('87000000-0000-4000-8000-000000000003', '87000000-0000-4000-8000-000000000001', 'internal_admin');

insert into public.jobs (id, organization_id, created_by, title)
values ('87000000-0000-4000-8000-000000000004', '87000000-0000-4000-8000-000000000003', '87000000-0000-4000-8000-000000000001', 'Sourcing intent part');

insert into public.parts (id, job_id, organization_id, name, normalized_key)
values ('87000000-0000-4000-8000-000000000005', '87000000-0000-4000-8000-000000000004', '87000000-0000-4000-8000-000000000003', 'Fixture part', 'fixture-part');

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, revision, requested_by_date,
  applicable_vendors
) values (
  '87000000-0000-4000-8000-000000000005', '87000000-0000-4000-8000-000000000003',
  '87000000-0000-4000-8000-000000000001', '6061-T6', 'A', current_date + 10,
  array['xometry']::public.vendor_name[]
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"87000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
select is(
  (public.api_get_sourcing_destination('87000000-0000-4000-8000-000000000003')->>'state'),
  'inferred', 'stored shipping fields start unconfirmed'
);
reset role;
select throws_ok(
  $$select private.require_confirmed_sourcing_destination('87000000-0000-4000-8000-000000000003')$$,
  'P0001', 'sourcing_destination_confirmation_required',
  'a required missing or inferred address fails closed'
);
select is(
  private.current_confirmed_part_deadline('87000000-0000-4000-8000-000000000005'),
  null::date, 'an existing requested date starts inferred'
);
select is(
  (select count(*)::integer from private.quote_lane_candidates(
    '87000000-0000-4000-8000-000000000004', array['xometry']::public.vendor_name[]
  )),
  0, 'missing confirmed destination blocks the Xometry candidate before disclosure'
);

set local role authenticated;
select throws_ok(
  $$select public.api_confirm_sourcing_destination(
    '87000000-0000-4000-8000-000000000003',
    '{"street":"123 Test Ave","city":"Tucson","region":"AZ","postalCode":null,"country":"US"}'::jsonb
  )$$,
  'P0001', 'sourcing_destination_incomplete',
  'an incomplete address cannot be confirmed'
);

reset role;
update public.organizations set shipping_zip = '85701'
where id = '87000000-0000-4000-8000-000000000003';

set local role authenticated;
select throws_ok(
  $$select public.api_confirm_sourcing_destination(
    '87000000-0000-4000-8000-000000000003',
    '{"street":"wrong"}'::jsonb
  )$$,
  'P0001', 'sourcing_destination_changed',
  'a stale address cannot be confirmed'
);
select lives_ok(
  $$select public.api_confirm_sourcing_destination(
    '87000000-0000-4000-8000-000000000003',
    public.api_get_sourcing_destination('87000000-0000-4000-8000-000000000003')->'address'
  )$$,
  'admin explicitly confirms the exact address'
);
select is(
  (public.api_get_sourcing_destination('87000000-0000-4000-8000-000000000003')->>'state'),
  'confirmed', 'the current address is confirmed'
);
select lives_ok(
  $$select public.api_confirm_part_deadline(
    '87000000-0000-4000-8000-000000000005', 'A', current_date + 10
  )$$,
  'the exact part revision and date can be confirmed'
);
select is(
  (public.api_get_part_deadline('87000000-0000-4000-8000-000000000005')->>'activeDate')::date,
  current_date + 10, 'confirmed deadline becomes active'
);
reset role;
select is(
  private.current_confirmed_part_deadline('87000000-0000-4000-8000-000000000005', current_date + 11),
  null::date, 'an expired deadline clears from active state without deleting its event'
);

reset role;
select is(
  private.build_quote_lane_scope_snapshot(
    '87000000-0000-4000-8000-000000000005', 'xometry'::public.vendor_name, 1
  ) #>> '{destination,postalCode}',
  '85701', 'exact confirmed destination is in the quote scope'
);
select is(
  (select count(*)::integer from private.quote_lane_candidates(
    '87000000-0000-4000-8000-000000000004', array['xometry']::public.vendor_name[]
  )),
  1, 'confirmed destination admits an exact Xometry candidate'
);
update public.organizations set shipping_zip = '85702'
where id = '87000000-0000-4000-8000-000000000003';
select is(
  (public.api_get_sourcing_destination('87000000-0000-4000-8000-000000000003')->>'state'),
  'inferred', 'editing the address revokes confirmation without deleting history'
);
select is(
  private.build_quote_lane_scope_snapshot(
    '87000000-0000-4000-8000-000000000005', 'xometry'::public.vendor_name, 1
  ) ? 'destination',
  false, 'unconfirmed address is absent from provider scope'
);
select is(
  (select count(*)::integer from private.quote_lane_candidates(
    '87000000-0000-4000-8000-000000000004', array['xometry']::public.vendor_name[]
  )),
  0, 'editing the address blocks a previously eligible Xometry candidate'
);
update public.approved_part_requirements set revision = 'B'
where part_id = '87000000-0000-4000-8000-000000000005';
select is(
  private.current_confirmed_part_deadline('87000000-0000-4000-8000-000000000005'),
  null::date, 'a new revision cannot silently carry a confirmed deadline'
);
select cmp_ok(
  (select count(*) from private.part_deadline_history where part_id = '87000000-0000-4000-8000-000000000005'),
  '>=', 3::bigint, 'deadline and revision history is retained'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"87000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true);
select throws_ok(
  $$select public.api_get_sourcing_destination('87000000-0000-4000-8000-000000000003')$$,
  'P0001', 'sourcing_destination_access_denied',
  'another organization cannot read the destination'
);
select throws_ok(
  $$select public.api_confirm_part_deadline('87000000-0000-4000-8000-000000000005', 'B', current_date + 10)$$,
  'P0001', 'part_deadline_access_denied',
  'another organization cannot confirm a part deadline'
);
select throws_ok($$select public.api_get_part_deadline('87000000-0000-4000-8000-000000000005')$$,
  'P0001', 'part_deadline_access_denied', 'another organization cannot read a part deadline');
select throws_ok($$select public.api_confirm_sourcing_destination('87000000-0000-4000-8000-000000000003', '{}'::jsonb)$$,
  'P0001', 'sourcing_destination_access_denied', 'another organization cannot confirm the destination');
select throws_ok($$select public.api_get_worker_sourcing_intent('87000000-0000-4000-8000-000000000004','87000000-0000-4000-8000-000000000005')$$,
  '42501', 'permission denied for function api_get_worker_sourcing_intent', 'authenticated clients cannot call the worker RPC');
reset role;

select ok(
  not has_table_privilege('authenticated', 'private.sourcing_destination_history', 'SELECT')
    and not has_table_privilege('authenticated', 'private.part_deadline_history', 'SELECT'),
  'private history is not directly readable by authenticated users'
);

select ok(not exists(select 1 from (values ('anon'),('authenticated'),('service_role')) roles(name)
  cross join (values ('private.sourcing_destination_history'),('private.part_deadline_history')) tables(name)
  where has_table_privilege(roles.name, tables.name, 'SELECT,INSERT,UPDATE,DELETE')),
  'all application roles lack direct history reads and writes');
select ok(not has_function_privilege('anon','public.api_get_sourcing_destination(uuid)','EXECUTE')
  and not has_function_privilege('anon','public.api_confirm_sourcing_destination(uuid,jsonb)','EXECUTE')
  and not has_function_privilege('anon','public.api_get_part_deadline(uuid)','EXECUTE')
  and not has_function_privilege('anon','public.api_confirm_part_deadline(uuid,text,date)','EXECUTE'),
  'anonymous callers cannot execute user sourcing RPCs');
select ok(not has_function_privilege('authenticated','private.current_confirmed_sourcing_address(uuid)','EXECUTE')
  and not has_function_privilege('service_role','private.current_confirmed_part_deadline(uuid,date)','EXECUTE'),
  'private confirmation helpers are not direct application APIs');

select set_config('request.jwt.claims', '{"sub":"87000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
select lives_ok($$select public.api_confirm_part_deadline('87000000-0000-4000-8000-000000000005','B',current_date+10)$$,
  'a new revision can be explicitly reconfirmed');
select is(private.current_confirmed_part_deadline('87000000-0000-4000-8000-000000000005'),current_date+10,
  'only explicit revision confirmation restores the active date');
update public.approved_part_requirements set requested_by_date=current_date-1,
  spec_snapshot=jsonb_build_object('requestedByDate',(current_date-1)::text,'shipping',jsonb_build_object('requestedByDateOverride',(current_date-1)::text))
where part_id='87000000-0000-4000-8000-000000000005';
-- A historical confirmation whose date has now elapsed, inserted only in this synthetic fixture.
insert into private.part_deadline_history (part_id,requirement_id,state,part_revision,requested_by_date,recorded_at)
select part_id,id,'confirmed',revision,requested_by_date,now()-interval '2 days'
from public.approved_part_requirements where part_id='87000000-0000-4000-8000-000000000005';
select is(public.api_get_part_deadline('87000000-0000-4000-8000-000000000005')->>'state','expired',
  'a genuinely elapsed confirmation is exposed as expired');
select is(private.build_quote_lane_scope_snapshot('87000000-0000-4000-8000-000000000005','xometry',1)#>>'{requirements,requestedDeliveryDate}',null::text,
  'expired deadline is absent from actual SQL quote scope');
select ok(not (private.build_quote_lane_scope_snapshot('87000000-0000-4000-8000-000000000005','xometry',1)#>'{requirements,specification}' ? 'requestedByDate')
  and not (private.build_quote_lane_scope_snapshot('87000000-0000-4000-8000-000000000005','xometry',1)#>'{requirements,specification,shipping}' ? 'requestedByDateOverride'),
  'raw requested dates cannot bypass the active deadline projection');
select ok(exists(select 1 from private.part_deadline_history where part_id='87000000-0000-4000-8000-000000000005'
  and state='confirmed' and requested_by_date=current_date-1), 'expired confirmation history remains stored');
update public.organizations set shipping_zip='85701' where id='87000000-0000-4000-8000-000000000003';
select is(private.current_confirmed_sourcing_address('87000000-0000-4000-8000-000000000003'),null::jsonb,
  'editing back to an old address does not resurrect its old confirmation');
select lives_ok($$select public.api_confirm_sourcing_destination('87000000-0000-4000-8000-000000000003',
  public.api_get_sourcing_destination('87000000-0000-4000-8000-000000000003')->'address')$$,
  'the restored address can be explicitly reconfirmed');
select ok((select count(*)>1 from private.sourcing_destination_history where organization_id='87000000-0000-4000-8000-000000000003' and state='confirmed'),
  'reconfirmation preserves earlier confirmed destination history');

select * from finish();
rollback;
