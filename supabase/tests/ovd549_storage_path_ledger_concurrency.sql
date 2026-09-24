-- Run only on a fresh isolated local Supabase database. The two sessions must
-- use a caller-supplied ovd.test_conninfo for that exact database; never
-- default to the shared 54322 stack or a hosted project.
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set search_path = public, extensions;

do $$
begin
  if current_database() <> 'postgres'
     or session_user <> 'postgres'
     or nullif(current_setting('ovd.test_conninfo', true), '') is null then
    raise exception 'OVD-549 concurrency test requires explicit isolated-local connection info.';
  end if;
end;
$$;

-- Exact synthetic fixtures are removed both before and after a run. This is
-- safe only on the dedicated local test database selected above.
delete from public.job_files
where id in (
  '00000000-0000-4000-8000-000000054904',
  '00000000-0000-4000-8000-000000054905',
  '00000000-0000-4000-8000-000000054908'
);
delete from public.jobs
where id = '00000000-0000-4000-8000-000000054903';
delete from public.organizations
where id = '00000000-0000-4000-8000-000000054902';
delete from auth.users
where id = '00000000-0000-4000-8000-000000054901';
delete from private.storage_path_upload_leases
where lease_id = '00000000-0000-4000-8000-000000054909';
delete from private.storage_path_ledger
where (storage_bucket, storage_path) in (
  ('job-files', 'ovd549-concurrency/reserve-first.step'),
  ('job-files', 'ovd549-concurrency/claim-first.step'),
  ('job-files', 'ovd549-concurrency/lease-handoff.step')
);

insert into auth.users (id, aud, role, email, email_confirmed_at)
values (
  '00000000-0000-4000-8000-000000054901',
  'authenticated', 'authenticated',
  'ovd549-concurrency@example.test', timezone('utc', now())
);
insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000054902',
  'OVD-549 concurrency', 'ovd549-concurrency'
);
insert into public.jobs (id, organization_id, created_by, title)
values (
  '00000000-0000-4000-8000-000000054903',
  '00000000-0000-4000-8000-000000054902',
  '00000000-0000-4000-8000-000000054901',
  'OVD-549 concurrent claim'
);

create or replace function public.ovd549_try_synthetic_claim(
  p_id uuid,
  p_path text
)
returns text
language plpgsql
set search_path = pg_catalog
as $$
begin
  insert into public.job_files (
    id, job_id, organization_id, uploaded_by, storage_bucket,
    storage_path, original_name, normalized_name, file_kind
  ) values (
    p_id,
    '00000000-0000-4000-8000-000000054903',
    '00000000-0000-4000-8000-000000054902',
    '00000000-0000-4000-8000-000000054901',
    'job-files', p_path, 'synthetic.step', 'synthetic', 'cad'
  );
  return 'inserted';
exception when others then
  return sqlstate;
end;
$$;

select plan(10);

select extensions.dblink_connect(
  'ovd549_reserver', current_setting('ovd.test_conninfo')
);
select extensions.dblink_connect(
  'ovd549_writer', current_setting('ovd.test_conninfo')
);

-- The reservation transaction wins the ledger row. A concurrent metadata
-- writer waits and then fails; it cannot sneak a claim into the chosen path.
select extensions.dblink_exec('ovd549_reserver', 'begin');
select result
from extensions.dblink(
  'ovd549_reserver',
  $query$select private.reserve_storage_path_for_cleanup(
    'job-files', 'ovd549-concurrency/reserve-first.step',
    '00000000-0000-4000-8000-000000054906'
  )$query$
) as response(result text);
select extensions.dblink_send_query(
  'ovd549_writer',
  $query$select public.ovd549_try_synthetic_claim(
    '00000000-0000-4000-8000-000000054904',
    'ovd549-concurrency/reserve-first.step'
  )$query$
);
select is(
  extensions.dblink_is_busy('ovd549_writer'),
  1, 'metadata claim waits for the uncommitted reservation'
);
select extensions.dblink_exec('ovd549_reserver', 'commit');
select is(
  (select result from extensions.dblink_get_result('ovd549_writer')
    as response(result text)),
  'P0001', 'metadata claim loses after cleanup reservation commits'
);
select *
from extensions.dblink_get_result('ovd549_writer') as response(result text);
select is(
  (select count(*) from public.job_files
   where storage_path = 'ovd549-concurrency/reserve-first.step'),
  0::bigint, 'rejected concurrent claim leaves no referenced file'
);

-- The metadata transaction wins the same row in the reverse order. Cleanup
-- waits, observes the committed claim, and retains the object.
select extensions.dblink_exec('ovd549_writer', 'begin');
select result
from extensions.dblink(
  'ovd549_writer',
  $query$select public.ovd549_try_synthetic_claim(
    '00000000-0000-4000-8000-000000054905',
    'ovd549-concurrency/claim-first.step'
  )$query$
) as response(result text);
select extensions.dblink_send_query(
  'ovd549_reserver',
  $query$select private.reserve_storage_path_for_cleanup(
    'job-files', 'ovd549-concurrency/claim-first.step',
    '00000000-0000-4000-8000-000000054907'
  )$query$
);
select is(
  extensions.dblink_is_busy('ovd549_reserver'),
  1, 'cleanup waits for the uncommitted metadata claim'
);
select extensions.dblink_exec('ovd549_writer', 'commit');
select is(
  (select result from extensions.dblink_get_result('ovd549_reserver')
    as response(result text)),
  'retained_shared', 'cleanup retains a path claimed by the winning writer'
);
select *
from extensions.dblink_get_result('ovd549_reserver') as response(result text);

-- The upload lease commits before an HTTP Storage upload. A separate future
-- finalizer must release the lease and attach metadata inside ONE database
-- transaction. The row lock survives the release statement until commit;
-- cleanup cannot win an inter-request gap between release and attachment.
select extensions.dblink_exec('ovd549_writer', 'begin');
select is(
  (select result from extensions.dblink(
    'ovd549_writer',
    $query$select private.acquire_storage_upload_lease(
      'job-files', 'ovd549-concurrency/lease-handoff.step',
      '00000000-0000-4000-8000-000000054909'
    )$query$
  ) as response(result text)),
  'upload_leased', 'a writer starts its upload lease before the finalizer'
);
select extensions.dblink_exec('ovd549_writer', 'commit');
select is(
  (select result from extensions.dblink(
    'ovd549_reserver',
    $query$select private.reserve_storage_path_for_cleanup(
      'job-files', 'ovd549-concurrency/lease-handoff.step',
      '00000000-0000-4000-8000-000000054910'
    )$query$
  ) as response(result text)),
  'upload_leased',
  'cleanup holds while the upload lease spans the HTTP request gap'
);
select extensions.dblink_exec('ovd549_writer', 'begin');
select result
from extensions.dblink(
  'ovd549_writer',
  $query$select private.release_storage_upload_lease(
    'job-files', 'ovd549-concurrency/lease-handoff.step',
    '00000000-0000-4000-8000-000000054909'
  )$query$
) as response(result text);
select is(
  (select result from extensions.dblink(
    'ovd549_writer',
    $query$select public.ovd549_try_synthetic_claim(
      '00000000-0000-4000-8000-000000054908',
      'ovd549-concurrency/lease-handoff.step'
    )$query$
  ) as response(result text)),
  'inserted', 'same-transaction release permits the final metadata attachment'
);
select extensions.dblink_send_query(
  'ovd549_reserver',
  $query$select private.reserve_storage_path_for_cleanup(
    'job-files', 'ovd549-concurrency/lease-handoff.step',
    '00000000-0000-4000-8000-000000054910'
  )$query$
);
select is(
  extensions.dblink_is_busy('ovd549_reserver'),
  1, 'cleanup still waits after lease release until metadata commit'
);
select extensions.dblink_exec('ovd549_writer', 'commit');
select is(
  (select result from extensions.dblink_get_result('ovd549_reserver')
    as response(result text)),
  'retained_shared',
  'cleanup sees the committed final claim and never selects the uploaded path'
);
select *
from extensions.dblink_get_result('ovd549_reserver') as response(result text);

select extensions.dblink_disconnect('ovd549_reserver');
select extensions.dblink_disconnect('ovd549_writer');
drop function public.ovd549_try_synthetic_claim(uuid, text);

delete from public.job_files
where id in (
  '00000000-0000-4000-8000-000000054905',
  '00000000-0000-4000-8000-000000054908'
);
delete from public.jobs
where id = '00000000-0000-4000-8000-000000054903';
delete from public.organizations
where id = '00000000-0000-4000-8000-000000054902';
delete from auth.users
where id = '00000000-0000-4000-8000-000000054901';
delete from private.storage_path_upload_leases
where lease_id = '00000000-0000-4000-8000-000000054909';
delete from private.storage_path_ledger
where (storage_bucket, storage_path) in (
  ('job-files', 'ovd549-concurrency/reserve-first.step'),
  ('job-files', 'ovd549-concurrency/claim-first.step'),
  ('job-files', 'ovd549-concurrency/lease-handoff.step')
);

select * from finish();
