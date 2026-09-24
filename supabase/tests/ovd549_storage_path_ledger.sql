begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(43);

create temporary table ovd549_fixture on commit drop as
select
  gen_random_uuid() as user_id,
  gen_random_uuid() as organization_id,
  gen_random_uuid() as job_a,
  gen_random_uuid() as job_b,
  gen_random_uuid() as part_a,
  gen_random_uuid() as part_b,
  gen_random_uuid() as quote_run_id,
  gen_random_uuid() as result_id,
  gen_random_uuid() as blob_a,
  gen_random_uuid() as blob_b,
  gen_random_uuid() as file_a,
  gen_random_uuid() as file_b,
  gen_random_uuid() as drawing_preview_id,
  gen_random_uuid() as cad_preview_id,
  gen_random_uuid() as artifact_id,
  gen_random_uuid() as canonical_part_id,
  gen_random_uuid() as version_id,
  gen_random_uuid() as lease_id,
  gen_random_uuid() as next_lease_id,
  gen_random_uuid() as operation_id;

insert into auth.users (id, aud, role, email, email_confirmed_at)
select user_id, 'authenticated', 'authenticated',
  'ovd549-synthetic@example.test', timezone('utc', now())
from ovd549_fixture;

insert into public.organizations (id, name, slug)
select organization_id, 'OVD-549 synthetic', 'ovd549-synthetic'
from ovd549_fixture;

insert into public.jobs (id, organization_id, created_by, title)
select job_a, organization_id, user_id, 'OVD-549 job A' from ovd549_fixture
union all
select job_b, organization_id, user_id, 'OVD-549 job B' from ovd549_fixture;

insert into public.parts (id, job_id, organization_id, name, normalized_key)
select part_a, job_a, organization_id, 'Part A', 'part-a' from ovd549_fixture
union all
select part_b, job_b, organization_id, 'Part B', 'part-b' from ovd549_fixture;

insert into public.quote_runs (id, job_id, organization_id, initiated_by)
select quote_run_id, job_a, organization_id, user_id from ovd549_fixture;

insert into public.vendor_quote_results (
  id, quote_run_id, part_id, organization_id, vendor
)
select result_id, quote_run_id, part_a, organization_id, 'xometry'
from ovd549_fixture;

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, storage_bucket, storage_path
)
select blob_a, organization_id, repeat('a', 64), 'job-files',
  'ovd549/shared.step' from ovd549_fixture
union all
select blob_b, organization_id, repeat('b', 64), 'job-files',
  'ovd549/version-only.pdf' from ovd549_fixture;

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id,
  storage_bucket, storage_path, original_name, normalized_name, file_kind
)
select file_a, job_a, organization_id, user_id, blob_a, 'job-files',
  'ovd549/shared.step', 'shared.step', 'shared', 'cad'::public.job_file_kind
from ovd549_fixture
union all
select file_b, job_b, organization_id, user_id, blob_a, 'job-files',
  'ovd549/shared.step', 'shared.step', 'shared', 'cad'::public.job_file_kind
from ovd549_fixture;

insert into public.drawing_preview_assets (
  id, part_id, organization_id, storage_bucket, storage_path
)
select drawing_preview_id, part_a, organization_id, 'quote-artifacts',
  'ovd549/shared-preview.svg'
from ovd549_fixture;

insert into public.cad_preview_assets (
  id, part_id, organization_id, source_cad_file_id, renderer_version,
  storage_bucket, storage_path, width, height
)
select cad_preview_id, part_a, organization_id, file_a, 'ovd549-test',
  'quote-artifacts', 'ovd549/shared-preview.svg', 100, 100
from ovd549_fixture;

insert into public.vendor_quote_artifacts (
  id, vendor_quote_result_id, organization_id, artifact_type,
  storage_bucket, storage_path
)
select artifact_id, result_id, organization_id, 'quote_pdf',
  'quote-artifacts', 'ovd549/manual.pdf'
from ovd549_fixture;

insert into public.canonical_parts (id, organization_id, display_name)
select canonical_part_id, organization_id, 'OVD-549 synthetic'
from ovd549_fixture;

insert into public.part_versions (
  id, canonical_part_id, organization_id, version_state,
  package_fingerprint, cad_blob_id, drawing_blob_id
)
select version_id, canonical_part_id, organization_id, 'unverified',
  repeat('c', 64), blob_a, blob_b
from ovd549_fixture;

select has_table('private', 'storage_path_ledger',
  'one private path ledger exists');
select has_table('private', 'storage_path_claims',
  'cross-table metadata claims are private');
select has_table('private', 'storage_path_upload_leases',
  'used lease IDs remain durably recorded');
select is(
  (select count(*) from private.storage_path_claims
   where storage_bucket = 'job-files' and storage_path = 'ovd549/shared.step'),
  4::bigint,
  'one path has blob, two job placements, and canonical-version claims'
);
select is(
  (select count(*) from private.storage_path_claims
   where storage_bucket = 'quote-artifacts'
     and storage_path = 'ovd549/shared-preview.svg'),
  2::bigint,
  'drawing and CAD previews share one physical path without losing either claim'
);
select is(
  (select count(*) from private.storage_path_claims
   where claim_source = 'vendor_quote_artifacts'),
  1::bigint,
  'manual quote artifact is independently claimed'
);
select is(
  (select count(*) from private.storage_path_claims
   where claim_source = 'part_versions' and claim_slot in ('cad', 'drawing')),
  2::bigint,
  'canonical version records both indirect blob references'
);
select is(
  private.reserve_storage_path_for_cleanup(
    'job-files', 'ovd549/shared.step',
    (select operation_id from ovd549_fixture)
  ),
  'retained_shared',
  'a shared path is retained instead of reserved for physical removal'
);
select is(
  private.reserve_storage_path_for_cleanup(
    'quote-artifacts', 'ovd549/shared-preview.svg',
    (select operation_id from ovd549_fixture)
  ),
  'retained_shared',
  'cross-table preview sharing is retained'
);

update public.organization_file_blobs
set storage_path = 'ovd549/version-moved.pdf'
where id = (select blob_b from ovd549_fixture);
select is(
  (select count(*) from private.storage_path_claims
   where claim_source = 'part_versions' and claim_slot = 'drawing'
     and storage_path = 'ovd549/version-moved.pdf'),
  1::bigint,
  'moving a blob updates its indirect canonical-version claim'
);
select is(
  (select count(*) from private.storage_path_claims
   where storage_path = 'ovd549/version-only.pdf'),
  0::bigint,
  'moving a blob leaves no stale claim on its old path'
);

select is(
  private.acquire_storage_upload_lease(
    'job-files', 'ovd549/deleted',
    (select lease_id from ovd549_fixture)
  ),
  'upload_leased',
  'a live upload lease is durable before Storage work'
);
select is(
  private.acquire_storage_upload_lease(
    'job-files', 'ovd549/deleted',
    (select lease_id from ovd549_fixture)
  ),
  'upload_leased',
  'the same lease can be replayed without a second reservation'
);
select throws_ok(
  format(
    'insert into public.job_files '
    || '(job_id,organization_id,uploaded_by,storage_bucket,storage_path,'
    || 'original_name,normalized_name,file_kind) '
    || 'values (%L::uuid,%L::uuid,%L::uuid,%L,%L,%L,%L,%L)',
    (select job_a from ovd549_fixture),
    (select organization_id from ovd549_fixture),
    (select user_id from ovd549_fixture),
    'job-files', 'ovd549/deleted', 'in-flight.step', 'in-flight', 'cad'
  ),
  'P0001', null, 'metadata cannot attach while an upload lease is live'
);
select throws_ok(
  format(
    'select private.acquire_storage_upload_lease(%L,%L,%L::uuid)',
    'job-files', 'ovd549/deleted', gen_random_uuid()
  ),
  'P0001', null, 'a second writer cannot replace a live upload lease'
);
select is(
  private.reserve_storage_path_for_cleanup(
    'job-files', 'ovd549/deleted',
    (select operation_id from ovd549_fixture)
  ),
  'upload_leased',
  'cleanup is held while an upload may still finish'
);
select is(
  private.release_storage_upload_lease(
    'job-files', 'ovd549/deleted',
    (select lease_id from ovd549_fixture)
  ),
  'active',
  'an explicit lease release makes the path eligible again'
);
select is(
  private.release_storage_upload_lease(
    'job-files', 'ovd549/deleted',
    (select lease_id from ovd549_fixture)
  ),
  'active',
  'replaying a release does not reopen the upload lease'
);
select is(
  private.acquire_storage_upload_lease(
    'job-files', 'ovd549/deleted',
    (select next_lease_id from ovd549_fixture)
  ),
  'upload_leased',
  'a distinct later upload can take an unclaimed path'
);
select is(
  private.release_storage_upload_lease(
    'job-files', 'ovd549/deleted',
    (select next_lease_id from ovd549_fixture)
  ),
  'active',
  'the distinct later upload releases independently'
);
select throws_ok(
  format(
    'select private.acquire_storage_upload_lease(%L,%L,%L::uuid)',
    'job-files', 'ovd549/deleted',
    (select lease_id from ovd549_fixture)
  ),
  'P0001', null,
  'an old lease ID cannot revive after a newer lease is released'
);
select is(
  private.reserve_storage_path_for_cleanup(
    'job-files', 'ovd549/deleted',
    (select operation_id from ovd549_fixture)
  ),
  'cleanup_reserved',
  'an unclaimed path is reserved under the ledger lock'
);
select is(
  private.reserve_storage_path_for_cleanup(
    'job-files', 'ovd549/deleted',
    (select operation_id from ovd549_fixture)
  ),
  'cleanup_reserved',
  'the same cleanup operation replays idempotently'
);
select throws_ok(
  format(
    'select private.reserve_storage_path_for_cleanup(%L,%L,%L::uuid)',
    'job-files', 'ovd549/deleted', gen_random_uuid()
  ),
  'P0001', null,
  'a different operation cannot take over a reserved path'
);

select throws_ok(
  format(
    'insert into public.organization_file_blobs '
    || '(organization_id,content_sha256,storage_bucket,storage_path) '
    || 'values (%L::uuid,%L,%L,%L)',
    (select organization_id from ovd549_fixture), repeat('d', 64),
    'job-files', 'ovd549/deleted'
  ),
  'P0001', null, 'blob metadata cannot claim a reserved path'
);
select throws_ok(
  format(
    'insert into public.job_files '
    || '(job_id,organization_id,uploaded_by,storage_bucket,storage_path,'
    || 'original_name,normalized_name,file_kind) '
    || 'values (%L::uuid,%L::uuid,%L::uuid,%L,%L,%L,%L,%L)',
    (select job_a from ovd549_fixture),
    (select organization_id from ovd549_fixture),
    (select user_id from ovd549_fixture),
    'job-files', 'ovd549/deleted', 'late.step', 'late', 'cad'
  ),
  'P0001', null, 'job placement cannot attach a reserved path'
);
select throws_ok(
  format(
    'insert into public.drawing_preview_assets '
    || '(part_id,organization_id,storage_bucket,storage_path) '
    || 'values (%L::uuid,%L::uuid,%L,%L)',
    (select part_b from ovd549_fixture),
    (select organization_id from ovd549_fixture),
    'job-files', 'ovd549/deleted'
  ),
  'P0001', null, 'drawing preview cannot attach a reserved path'
);
select throws_ok(
  format(
    'insert into public.cad_preview_assets '
    || '(part_id,organization_id,source_cad_file_id,renderer_version,'
    || 'storage_bucket,storage_path,width,height) '
    || 'values (%L::uuid,%L::uuid,%L::uuid,%L,%L,%L,100,100)',
    (select part_b from ovd549_fixture),
    (select organization_id from ovd549_fixture),
    (select file_b from ovd549_fixture),
    'ovd549-test', 'job-files', 'ovd549/deleted'
  ),
  'P0001', null, 'CAD preview cannot attach a reserved path'
);
select throws_ok(
  format(
    'insert into public.vendor_quote_artifacts '
    || '(vendor_quote_result_id,organization_id,artifact_type,'
    || 'storage_bucket,storage_path) '
    || 'values (%L::uuid,%L::uuid,%L,%L,%L)',
    (select result_id from ovd549_fixture),
    (select organization_id from ovd549_fixture),
    'quote_pdf', 'job-files', 'ovd549/deleted'
  ),
  'P0001', null, 'quote artifact cannot attach a reserved path'
);
select throws_ok(
  format(
    'update public.vendor_quote_artifacts set storage_bucket=%L, '
    || 'storage_path=%L where id=%L::uuid',
    'job-files', 'ovd549/deleted',
    (select artifact_id from ovd549_fixture)
  ),
  'P0001', null, 'metadata updates cannot move a live row onto a reserved path'
);
select throws_ok(
  format(
    'update public.organization_file_blobs set storage_path=%L '
    || 'where id=%L::uuid',
    'ovd549/deleted', (select blob_b from ovd549_fixture)
  ),
  'P0001', null,
  'a blob referenced by a canonical version cannot move onto a reserved path'
);
select is(
  (select count(*) from private.storage_path_claims
   where claim_source = 'part_versions' and claim_slot = 'drawing'
     and storage_path = 'ovd549/version-moved.pdf'),
  1::bigint,
  'a rejected blob move preserves the prior indirect claim'
);
select is(
  (select count(*) from private.storage_path_claims
   where storage_bucket = 'job-files' and storage_path = 'ovd549/deleted'),
  0::bigint,
  'rejected claims leave no partial metadata'
);

insert into public.drawing_preview_assets (
  part_id, organization_id, storage_bucket, storage_path
)
select part_b, organization_id, 'quote-artifacts', 'ovd549/deleted'
from ovd549_fixture;
select is(
  (select count(*) from private.storage_path_claims
   where storage_bucket = 'quote-artifacts'
     and storage_path = 'ovd549/deleted'),
  1::bigint,
  'the same path in a different bucket is not conflated'
);
delete from public.drawing_preview_assets
where part_id = (select part_b from ovd549_fixture)
  and storage_path = 'ovd549/deleted';
select is(
  (select count(*) from private.storage_path_claims
   where storage_bucket = 'quote-artifacts'
     and storage_path = 'ovd549/deleted'),
  0::bigint,
  'deleting metadata removes only that path claim'
);
select is(
  private.reserve_storage_path_for_cleanup(
    'quote-artifacts', 'ovd549/deleted',
    (select operation_id from ovd549_fixture)
  ),
  'cleanup_reserved',
  'a different bucket becomes independently reservable after its claim is removed'
);

savepoint before_cleanup_ack;
select is(
  private.complete_storage_path_cleanup(
    'job-files', 'ovd549/deleted',
    (select operation_id from ovd549_fixture)
  ),
  'completed',
  'completion is recorded only for the matching reserved operation'
);
rollback to savepoint before_cleanup_ack;
select is(
  (select state from private.storage_path_ledger
   where storage_bucket = 'job-files' and storage_path = 'ovd549/deleted'),
  'cleanup_reserved',
  'crash before completion commit leaves the durable reservation to reconcile'
);
select is(
  private.complete_storage_path_cleanup(
    'job-files', 'ovd549/deleted',
    (select operation_id from ovd549_fixture)
  ),
  'completed',
  'retry with the same operation can finalize after reconciliation'
);
select throws_ok(
  format(
    'select private.acquire_storage_upload_lease(%L,%L,%L::uuid)',
    'job-files', 'ovd549/deleted', gen_random_uuid()
  ),
  'P0001', null, 'a late upload cannot reuse a completed path'
);
select throws_ok(
  format(
    'insert into public.job_files '
    || '(job_id,organization_id,uploaded_by,storage_bucket,storage_path,'
    || 'original_name,normalized_name,file_kind) '
    || 'values (%L::uuid,%L::uuid,%L::uuid,%L,%L,%L,%L,%L)',
    (select job_a from ovd549_fixture),
    (select organization_id from ovd549_fixture),
    (select user_id from ovd549_fixture),
    'job-files', 'ovd549/deleted', 'late.step', 'late', 'cad'
  ),
  'P0001', null, 'a completed path rejects a late metadata attachment'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.reserve_storage_path_for_cleanup(text,text,uuid)',
    'EXECUTE'
  ),
  'authenticated clients cannot reserve a cleanup path'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.complete_storage_path_cleanup(text,text,uuid)',
    'EXECUTE'
  ),
  'even service-role clients cannot assert cleanup completion directly'
);

select * from finish();
rollback;
