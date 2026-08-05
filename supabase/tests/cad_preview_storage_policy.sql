begin;

select plan(4);

create temporary table cad_preview_test_context (
  member_user_id uuid not null,
  outsider_user_id uuid not null,
  organization_id uuid not null,
  job_id uuid not null,
  cad_file_id uuid not null,
  part_id uuid not null,
  preview_id uuid not null,
  object_id uuid not null,
  artifact_bucket text not null,
  preview_path text not null
) on commit drop;

insert into cad_preview_test_context values (
  '00000000-0000-4000-8000-000000000701',
  '00000000-0000-4000-8000-000000000702',
  '00000000-0000-4000-8000-000000000703',
  '00000000-0000-4000-8000-000000000704',
  '00000000-0000-4000-8000-000000000705',
  '00000000-0000-4000-8000-000000000706',
  '00000000-0000-4000-8000-000000000707',
  '00000000-0000-4000-8000-000000000708',
  'quote-artifacts',
  'org/cad-previews/job/part/hidden-lines-removed-isometric.svg'
);

grant select on cad_preview_test_context to authenticated;

insert into auth.users (id, aud, role, email)
select member_user_id, 'authenticated', 'authenticated', 'cad-preview-member@example.com'
from cad_preview_test_context
union all
select outsider_user_id, 'authenticated', 'authenticated', 'cad-preview-outsider@example.com'
from cad_preview_test_context;

insert into public.organizations (id, name, slug)
select organization_id, 'CAD Preview Policy', 'cad-preview-policy'
from cad_preview_test_context;

insert into public.organization_memberships (organization_id, user_id, role)
select organization_id, member_user_id, 'client'
from cad_preview_test_context;

insert into public.jobs (id, organization_id, created_by, title)
select job_id, organization_id, member_user_id, 'CAD Preview Policy'
from cad_preview_test_context;

insert into public.job_files (
  id,
  job_id,
  organization_id,
  uploaded_by,
  storage_bucket,
  storage_path,
  original_name,
  normalized_name,
  file_kind
)
select
  cad_file_id,
  job_id,
  organization_id,
  member_user_id,
  'job-files',
  'cad-preview-policy/part.step',
  'part.step',
  'part.step',
  'cad'
from cad_preview_test_context;

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id)
select part_id, job_id, organization_id, 'CAD Preview Part', 'cad-preview-part', cad_file_id
from cad_preview_test_context;

insert into public.cad_preview_assets (
  id,
  part_id,
  organization_id,
  source_cad_file_id,
  renderer_version,
  storage_bucket,
  storage_path,
  width,
  height
)
select
  preview_id,
  part_id,
  organization_id,
  cad_file_id,
  'cad-svg-hlr-v1',
  artifact_bucket,
  preview_path,
  256,
  256
from cad_preview_test_context;

insert into storage.buckets (id, name, public)
select artifact_bucket, artifact_bucket, false
from cad_preview_test_context
on conflict (id) do nothing;

insert into storage.objects (id, bucket_id, name, owner)
select object_id, artifact_bucket, preview_path, member_user_id
from cad_preview_test_context;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  (select member_user_id::text from cad_preview_test_context),
  true
);

select is(
  (select count(*) from public.cad_preview_assets where id = (select preview_id from cad_preview_test_context)),
  1::bigint,
  'workspace member can read the CAD preview row'
);

select is(
  (select count(*) from storage.objects where id = (select object_id from cad_preview_test_context)),
  1::bigint,
  'workspace member can read the matching CAD preview object'
);

select set_config(
  'request.jwt.claim.sub',
  (select outsider_user_id::text from cad_preview_test_context),
  true
);

select is(
  (select count(*) from public.cad_preview_assets where id = (select preview_id from cad_preview_test_context)),
  0::bigint,
  'unrelated authenticated user cannot read the CAD preview row'
);

select is(
  (select count(*) from storage.objects where id = (select object_id from cad_preview_test_context)),
  0::bigint,
  'unrelated authenticated user cannot read the CAD preview object'
);

select * from finish();

rollback;
