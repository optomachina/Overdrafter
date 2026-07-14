begin;

select plan(2);

create temporary table pr248_test_context (
  user_id uuid not null,
  organization_id uuid not null,
  job_id uuid not null,
  part_id uuid not null,
  preview_id uuid not null,
  object_id uuid not null,
  authenticated_role text not null,
  artifact_bucket text not null,
  preview_path text not null
) on commit drop;

insert into pr248_test_context (
  user_id,
  organization_id,
  job_id,
  part_id,
  preview_id,
  object_id,
  authenticated_role,
  artifact_bucket,
  preview_path
)
values (
  '00000000-0000-4000-8000-000000000248',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  'authenticated',
  'quote-artifacts',
  'pr-248/shared-preview.png'
);

grant select on pr248_test_context to authenticated;

insert into auth.users (id, aud, role, email)
select user_id, authenticated_role, authenticated_role, 'pr248-storage-policy@example.com'
from pr248_test_context;

insert into public.organizations (id, name, slug)
select organization_id, 'PR 248 Storage Policy', 'pr-248-storage-policy'
from pr248_test_context;

insert into public.organization_memberships (organization_id, user_id, role)
select organization_id, user_id, 'client'
from pr248_test_context;

insert into public.jobs (id, organization_id, created_by, title)
select job_id, organization_id, user_id, 'PR 248 Storage Policy'
from pr248_test_context;

insert into public.parts (id, job_id, organization_id, name, normalized_key)
select part_id, job_id, organization_id, 'PR 248 Part', 'pr-248-part'
from pr248_test_context;

insert into public.drawing_preview_assets (
  id,
  part_id,
  organization_id,
  storage_bucket,
  storage_path
)
select preview_id, part_id, organization_id, 'job-files', preview_path
from pr248_test_context;

insert into storage.buckets (id, name, public)
select artifact_bucket, artifact_bucket, false
from pr248_test_context
on conflict (id) do nothing;

insert into storage.objects (id, bucket_id, name, owner)
select object_id, artifact_bucket, preview_path, user_id
from pr248_test_context;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  (select user_id::text from pr248_test_context),
  true
);

select is(
  (
    select count(*)
    from storage.objects
    where id = (select object_id from pr248_test_context)
  ),
  0::bigint,
  'cross-bucket preview metadata cannot authorize a same-path quote artifact'
);

reset role;

update public.drawing_preview_assets
set storage_bucket = (select artifact_bucket from pr248_test_context)
where id = (select preview_id from pr248_test_context);

set local role authenticated;

select is(
  (
    select count(*)
    from storage.objects
    where id = (select object_id from pr248_test_context)
  ),
  1::bigint,
  'matching preview bucket and path authorize the accessible quote artifact'
);

select * from finish();

rollback;
