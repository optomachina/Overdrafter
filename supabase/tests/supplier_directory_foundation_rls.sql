begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

select has_table(
  'public',
  'supplier_companies',
  'supplier directory migration creates supplier_companies'
);

insert into auth.users (id, aud, role, email)
values
  ('11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'supplier-client@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'supplier-internal@example.test');

insert into public.organizations (id, name, slug)
values ('33333333-3333-4333-8333-333333333333', 'Supplier RLS Test', 'supplier-rls-test');

insert into public.organization_memberships (organization_id, user_id, role)
values (
  '33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222',
  'internal_estimator'
);

insert into public.supplier_companies (id, display_name, origin, lifecycle_status)
values
  ('44444444-4444-4444-8444-444444444444', 'Canonical Supplier', 'internal', 'verified'),
  ('44444444-4444-4444-8444-444444444445', 'Other Supplier', 'internal', 'verified');

insert into public.supplier_facilities (
  id,
  supplier_company_id,
  facility_name,
  lifecycle_status
)
values (
  '55555555-5555-4555-8555-555555555555',
  '44444444-4444-4444-8444-444444444444',
  'Canonical Facility',
  'verified'
);

insert into public.supplier_capabilities (id, code, name, category)
values (
  '66666666-6666-4666-8666-666666666666',
  'cnc_milling',
  'CNC Milling',
  'machining'
);

insert into public.supplier_sources (id, source_kind, title)
values (
  '77777777-7777-4777-8777-777777777777',
  'internal_research',
  'Supplier RLS fixture'
);

insert into public.supplier_verification_events (
  supplier_company_id,
  verification_status,
  verified_by
)
values (
  '44444444-4444-4444-8444-444444444444',
  'verified',
  '22222222-2222-4222-8222-222222222222'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  true
);

select is(
  (select count(*) from public.supplier_companies),
  0::bigint,
  'ordinary authenticated users cannot read canonical suppliers'
);

select is(
  (
    select count(*)
    from public.supplier_capabilities
    where id = '66666666-6666-4666-8666-666666666666'
  ),
  1::bigint,
  'ordinary authenticated users can read active capability vocabulary'
);

select throws_ok(
  $$
    insert into public.supplier_companies (display_name, origin)
    values ('Unauthorized Supplier', 'customer_suggested')
  $$,
  '42501',
  'new row violates row-level security policy for table "supplier_companies"',
  'ordinary authenticated users cannot insert canonical suppliers'
);

update public.supplier_capabilities
set name = 'Unauthorized Rename'
where id = '66666666-6666-4666-8666-666666666666';

select is(
  (
    select name
    from public.supplier_capabilities
    where id = '66666666-6666-4666-8666-666666666666'
  ),
  'CNC Milling',
  'ordinary authenticated users cannot update capability vocabulary'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  '22222222-2222-4222-8222-222222222222',
  true
);
set local role authenticated;

select is(
  (
    select count(*)
    from public.supplier_companies
    where id = '44444444-4444-4444-8444-444444444444'
  ),
  1::bigint,
  'internal estimators can read canonical suppliers'
);

select lives_ok(
  $$
    insert into public.supplier_companies (display_name, origin)
    values ('Internal Supplier', 'internal')
  $$,
  'internal estimators can insert canonical suppliers'
);

reset role;

select throws_ok(
  $$
    delete from public.supplier_companies
    where id = '44444444-4444-4444-8444-444444444444'
  $$,
  '23503',
  null,
  'verification history prevents deletion of its canonical target'
);

select throws_ok(
  $$
    insert into public.supplier_source_records (
      source_id,
      record_sha256,
      raw_record,
      supplier_company_id,
      supplier_facility_id
    )
    values (
      '77777777-7777-4777-8777-777777777777',
      repeat('a', 64),
      '{}'::jsonb,
      '44444444-4444-4444-8444-444444444445',
      '55555555-5555-4555-8555-555555555555'
    )
  $$,
  '23503',
  null,
  'source records cannot link a company to another company facility'
);

select * from finish();

rollback;
