begin;
set local search_path = public, extensions;

create extension if not exists pgtap with schema extensions;
select plan(22);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values
  ('67900000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ovd679-client@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb), -- NOSONAR: deterministic fixture identity
  ('67900000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ovd679-outsider@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb), -- NOSONAR: deterministic fixture identity
  ('67900000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'ovd679-unverified@example.test', null, '{"provider":"email"}'::jsonb), -- NOSONAR: deterministic fixture identity
  ('67900000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'ovd679-other-org@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb); -- NOSONAR: deterministic fixture identity

insert into public.organizations (id, name, slug)
values
  ('67900000-0000-4000-8000-000000000010', 'OVD 679 org', 'ovd-679-org'), -- NOSONAR: deterministic fixture identifier
  ('67900000-0000-4000-8000-000000000011', 'OVD 679 other org', 'ovd-679-other-org'); -- NOSONAR: deterministic fixture identifier

insert into public.organization_memberships (organization_id, user_id, role)
values
  ('67900000-0000-4000-8000-000000000010', '67900000-0000-4000-8000-000000000001', 'client'),
  ('67900000-0000-4000-8000-000000000010', '67900000-0000-4000-8000-000000000003', 'client'),
  ('67900000-0000-4000-8000-000000000011', '67900000-0000-4000-8000-000000000004', 'client');

insert into public.jobs (id, organization_id, created_by, title)
values ('67900000-0000-4000-8000-000000000020', '67900000-0000-4000-8000-000000000010', '67900000-0000-4000-8000-000000000001', 'OVD 679 job'); -- NOSONAR: deterministic fixture identifier

insert into public.parts (id, job_id, organization_id, name, normalized_key)
values ('67900000-0000-4000-8000-000000000030', '67900000-0000-4000-8000-000000000020', '67900000-0000-4000-8000-000000000010', 'OVD 679 part', 'ovd-679-part'); -- NOSONAR: deterministic fixture identifier

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, revision, applicable_vendors
) values (
  '67900000-0000-4000-8000-000000000030', '67900000-0000-4000-8000-000000000010',
  '67900000-0000-4000-8000-000000000001', '6061-T6', 'A', array['xometry']::public.vendor_name[]
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"67900000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true); -- NOSONAR: deterministic fixture identity

select lives_ok(
  $$select public.api_update_organization_addresses('67900000-0000-4000-8000-000000000010',
    '{"shippingSameAsBilling":false,"shippingStreet":" 1 Member Way ","shippingCity":"Tucson","shippingState":"AZ","shippingZip":"85701","shippingCountry":"US"}'::jsonb)$$,
  'a client-role member saves the shipping address'
);
select is(
  public.api_get_sourcing_destination('67900000-0000-4000-8000-000000000010'),
  '{"address":{"street":"1 Member Way","city":"Tucson","region":"AZ","postalCode":"85701","country":"US"},"state":"inferred"}'::jsonb,
  'the saved address is trimmed and starts unconfirmed'
);
select throws_ok(
  $$select public.api_update_organization_addresses('67900000-0000-4000-8000-000000000010', '{"name":"Renamed"}'::jsonb)$$,
  'P0001', 'organization_address_invalid',
  'the address RPC rejects non-address organization columns'
);
select throws_ok(
  $$select public.api_update_organization_addresses('67900000-0000-4000-8000-000000000010', '{"shippingSameAsBilling":"no"}'::jsonb)$$,
  'P0001', 'organization_address_invalid',
  'the address RPC rejects mistyped values'
);
select throws_ok(
  format($$select public.api_update_organization_addresses('67900000-0000-4000-8000-000000000010', %L::jsonb)$$,
    jsonb_build_object('shippingStreet', repeat('x', 201))),
  'P0001', 'organization_address_invalid',
  'the address RPC bounds field length'
);

update public.organizations set name = 'Renamed by client', slug = 'renamed-by-client'
where id = '67900000-0000-4000-8000-000000000010';
reset role;
select is(
  (select name || '/' || slug from public.organizations where id = '67900000-0000-4000-8000-000000000010'),
  'OVD 679 org/ovd-679-org',
  'a client-role member still cannot update the organizations row directly'
);
select is(
  (select count(*)::integer from private.quote_lane_candidates(
    '67900000-0000-4000-8000-000000000020', array['xometry']::public.vendor_name[])),
  0, 'an unconfirmed member address does not admit Xometry'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"67900000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
select cmp_ok(
  public.api_confirm_sourcing_destination('67900000-0000-4000-8000-000000000010',
    public.api_get_sourcing_destination('67900000-0000-4000-8000-000000000010') -> 'address'),
  '>', 0::bigint,
  'a client-role member confirms the exact address and receives the history event id'
);
select is(
  public.api_get_sourcing_destination('67900000-0000-4000-8000-000000000010') ->> 'state',
  'confirmed', 'the member-confirmed address is active'
);
reset role;
select is(
  private.current_confirmed_sourcing_address('67900000-0000-4000-8000-000000000010') ->> 'postalCode',
  '85701', 'current_confirmed_sourcing_address returns the member-confirmed address'
);
select is(
  (select count(*)::integer from private.quote_lane_candidates(
    '67900000-0000-4000-8000-000000000020', array['xometry']::public.vendor_name[])),
  1, 'the member-confirmed address admits the Xometry candidate'
);
select is(
  (select actor_id from private.sourcing_destination_history
   where organization_id = '67900000-0000-4000-8000-000000000010' order by id desc limit 1),
  '67900000-0000-4000-8000-000000000001'::uuid,
  'the confirmation records the member as its actor'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"67900000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
select lives_ok(
  $$select public.api_update_organization_addresses('67900000-0000-4000-8000-000000000010', '{"shippingZip":"85702"}'::jsonb)$$,
  'a member can edit the confirmed address'
);
select is(
  public.api_get_sourcing_destination('67900000-0000-4000-8000-000000000010') ->> 'state',
  'inferred', 'a member edit revokes the prior confirmation'
);

select set_config('request.jwt.claims', '{"sub":"67900000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true); -- NOSONAR: deterministic fixture identity
select throws_ok(
  $$select public.api_update_organization_addresses('67900000-0000-4000-8000-000000000010', '{"shippingZip":"00000"}'::jsonb)$$,
  'P0001', 'organization_address_access_denied',
  'another organization cannot edit the address'
);

select set_config('request.jwt.claims', '{"sub":"67900000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true); -- NOSONAR: deterministic fixture identity
select throws_ok(
  $$select public.api_update_organization_addresses('67900000-0000-4000-8000-000000000010', '{"shippingZip":"00000"}'::jsonb)$$,
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'an unverified member cannot edit the address'
);

-- The address is complete and unconfirmed here, so confirmation fails only on access.
select set_config('request.jwt.claims', '{"sub":"67900000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal1"}', true); -- NOSONAR: deterministic fixture identity
select throws_ok(
  $$select public.api_update_organization_addresses('67900000-0000-4000-8000-000000000010', '{"shippingZip":"00000"}'::jsonb)$$,
  'P0001', 'organization_address_access_denied',
  'a verified member of another organization cannot edit the address'
);
select throws_ok(
  $$select public.api_confirm_sourcing_destination('67900000-0000-4000-8000-000000000010',
    '{"street":"1 Member Way","city":"Tucson","region":"AZ","postalCode":"85702","country":"US"}'::jsonb)$$,
  'P0001', 'sourcing_destination_access_denied',
  'a verified member of another organization cannot confirm the destination'
);

select set_config('request.jwt.claims', '{"sub":"67900000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}', true); -- NOSONAR: deterministic fixture identity
select throws_ok(
  $$select public.api_confirm_sourcing_destination('67900000-0000-4000-8000-000000000010',
    '{"street":"1 Member Way","city":"Tucson","region":"AZ","postalCode":"85702","country":"US"}'::jsonb)$$,
  'P0001', 'sourcing_destination_access_denied',
  'a verified user without any organization cannot confirm the destination'
);

select set_config('request.jwt.claims', '{"sub":"67900000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}', true); -- NOSONAR: deterministic fixture identity
select throws_ok(
  $$select public.api_confirm_sourcing_destination('67900000-0000-4000-8000-000000000010',
    '{"street":"1 Member Way","city":"Tucson","region":"AZ","postalCode":"85702","country":"US"}'::jsonb)$$,
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'an unverified member cannot confirm the destination'
);
reset role;

select is(
  (select count(*)::integer from private.sourcing_destination_history
   where organization_id = '67900000-0000-4000-8000-000000000010' and state = 'confirmed'),
  1, 'denied confirmations append no confirmed history'
);
select is(
  (select shipping_zip from public.organizations where id = '67900000-0000-4000-8000-000000000010'),
  '85702', 'denied edits leave the address unchanged'
);

select * from finish();
rollback;
