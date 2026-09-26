-- Run only after the CI-only preexisting-metadata fixture was inserted as a
-- temporary migration immediately before the OVD-549 migration.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(4);

select is(
  (select count(*) from private.storage_path_ledger
   where storage_bucket = 'job-files'
     and storage_path = 'ovd549-backfill/shared.step'),
  1::bigint, 'preexisting references produce exactly one path ledger row'
);
select is(
  (select count(*) from private.storage_path_claims
   where storage_bucket = 'job-files'
     and storage_path = 'ovd549-backfill/shared.step'),
  3::bigint, 'backfill preserves blob, job-file, and canonical-version claims'
);
select is(
  (select count(*) from private.storage_path_claims
   where (claim_source, claim_row_id, claim_slot) in (
     ('organization_file_blobs', '00000000-0000-4000-8000-000000054925', 'object'),
     ('job_files', '00000000-0000-4000-8000-000000054924', 'object'),
     ('part_versions', '00000000-0000-4000-8000-000000054927', 'cad')
   )),
  3::bigint, 'backfill attributes every claim to its original metadata row'
);
select is(
  (select count(*) from public.organization_file_blobs
   where id = '00000000-0000-4000-8000-000000054925'
     and storage_bucket = 'job-files'
     and storage_path = 'ovd549-backfill/shared.step'),
  1::bigint, 'migration does not alter the preexisting blob metadata'
);

select * from finish();
rollback;
