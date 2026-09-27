-- Synthetic records created before the migration, never copied from the source database.
insert into auth.users (id, aud, role, email, email_confirmed_at)
values ('89000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'sourcing-backfill@example.test', now()); -- NOSONAR: exact PostgreSQL contract/fixture literal intentionally repeats across independent statements.
insert into public.organizations (id, name, slug, shipping_same_as_billing,
  shipping_street, shipping_city, shipping_state, shipping_zip, shipping_country)
values ('89000000-0000-4000-8000-000000000003', 'Sourcing backfill', 'sourcing-backfill', -- NOSONAR: exact PostgreSQL contract/fixture literal intentionally repeats across independent statements.
  false, '456 Earlier Ave', 'Tucson', 'AZ', '85701', 'US');
insert into public.organization_memberships (organization_id, user_id, role)
values ('89000000-0000-4000-8000-000000000003', '89000000-0000-4000-8000-000000000001', 'internal_admin');
insert into public.jobs (id, organization_id, created_by, title)
values ('89000000-0000-4000-8000-000000000004', '89000000-0000-4000-8000-000000000003',
  '89000000-0000-4000-8000-000000000001', 'Sourcing backfill');
insert into public.parts (id, job_id, organization_id, name, normalized_key)
values ('89000000-0000-4000-8000-000000000005', '89000000-0000-4000-8000-000000000004',
  '89000000-0000-4000-8000-000000000003', 'Earlier part', 'earlier-part');
insert into public.approved_part_requirements (part_id, organization_id, approved_by, material, revision, requested_by_date)
values ('89000000-0000-4000-8000-000000000005', '89000000-0000-4000-8000-000000000003',
  '89000000-0000-4000-8000-000000000001', '6061-T6', 'A', current_date + 12);
