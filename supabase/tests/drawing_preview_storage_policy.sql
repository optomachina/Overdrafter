begin;

select plan(2);

insert into auth.users (id, aud, role, email)
values (
  '00000000-0000-4000-8000-000000000248',
  'authenticated',
  'authenticated',
  'pr248-storage-policy@example.com'
);

insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000000001',
  'PR 248 Storage Policy',
  'pr-248-storage-policy'
);

insert into public.organization_memberships (organization_id, user_id, role)
values (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000248',
  'client'
);

insert into public.jobs (id, organization_id, created_by, title)
values (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000248',
  'PR 248 Storage Policy'
);

insert into public.parts (id, job_id, organization_id, name, normalized_key)
values (
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'PR 248 Part',
  'pr-248-part'
);

insert into public.drawing_preview_assets (
  id,
  part_id,
  organization_id,
  storage_bucket,
  storage_path
)
values (
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000001',
  'job-files',
  'pr-248/shared-preview.png'
);

insert into storage.buckets (id, name, public)
values ('quote-artifacts', 'quote-artifacts', false)
on conflict (id) do nothing;

insert into storage.objects (id, bucket_id, name, owner)
values (
  '00000000-0000-4000-8000-000000000005',
  'quote-artifacts',
  'pr-248/shared-preview.png',
  '00000000-0000-4000-8000-000000000248'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000248',
  true
);

select is(
  (
    select count(*)
    from storage.objects
    where id = '00000000-0000-4000-8000-000000000005'
  ),
  0::bigint,
  'cross-bucket preview metadata cannot authorize a same-path quote artifact'
);

reset role;

update public.drawing_preview_assets
set storage_bucket = 'quote-artifacts'
where id = '00000000-0000-4000-8000-000000000004';

set local role authenticated;

select is(
  (
    select count(*)
    from storage.objects
    where id = '00000000-0000-4000-8000-000000000005'
  ),
  1::bigint,
  'matching preview bucket and path authorize the accessible quote artifact'
);

select * from finish();

rollback;
