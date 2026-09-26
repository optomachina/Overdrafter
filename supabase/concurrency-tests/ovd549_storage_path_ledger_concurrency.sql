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
create or replace function public.ovd549_reset_concurrency_fixture()
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  delete from public.job_files
  where id in (
    '00000000-0000-4000-8000-000000054904',
    '00000000-0000-4000-8000-000000054905',
    '00000000-0000-4000-8000-000000054908'
  );
  delete from public.part_versions
  where id = '00000000-0000-4000-8000-000000054914';
  delete from public.canonical_parts
  where id = '00000000-0000-4000-8000-000000054913';
  delete from public.organization_file_blobs
  where id = '00000000-0000-4000-8000-000000054912';
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
    ('job-files', 'ovd549-concurrency/lease-handoff.step'),
    ('job-files', 'ovd549-concurrency/blob-old.step')
  );
end;
$$;
select public.ovd549_reset_concurrency_fixture();

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
insert into public.organization_file_blobs (
  id, organization_id, content_sha256, storage_bucket, storage_path
) values (
  '00000000-0000-4000-8000-000000054912',
  '00000000-0000-4000-8000-000000054902',
  repeat('d', 64), 'job-files', 'ovd549-concurrency/blob-old.step'
);
insert into public.canonical_parts (id, organization_id, display_name)
values (
  '00000000-0000-4000-8000-000000054913',
  '00000000-0000-4000-8000-000000054902',
  'OVD-549 lock-order proof'
);
insert into public.part_versions (
  id, canonical_part_id, organization_id, version_state,
  package_fingerprint, cad_blob_id
) values (
  '00000000-0000-4000-8000-000000054914',
  '00000000-0000-4000-8000-000000054913',
  '00000000-0000-4000-8000-000000054902',
  'unverified', repeat('e', 64),
  '00000000-0000-4000-8000-000000054912'
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

create or replace function public.ovd549_try_lock_version_claim()
returns text
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform 1
  from private.storage_path_claims
  where claim_source = 'part_versions'
    and claim_row_id = '00000000-0000-4000-8000-000000054914'
    and claim_slot = 'cad'
  for update nowait;
  return 'locked';
exception when others then
  return sqlstate;
end;
$$;

create or replace function public.ovd549_wait_for_expected_block(
  p_waiter_pid integer,
  p_blocker_pid integer
)
returns boolean
language plpgsql
set search_path = pg_catalog
as $$
begin
  for attempt in 1..200 loop
    if p_blocker_pid = any(pg_blocking_pids(p_waiter_pid)) then
      return true;
    end if;
    perform pg_sleep(0.01);
  end loop;
  return false;
end;
$$;

select plan(13);

select extensions.dblink_connect(
  'ovd549_reserver', current_setting('ovd.test_conninfo')
);
select extensions.dblink_connect(
  'ovd549_writer', current_setting('ovd.test_conninfo')
);
create temporary table ovd549_connection_pids as
select 'ovd549_reserver'::text as connection_name, pid
from extensions.dblink('ovd549_reserver', 'select pg_backend_pid()')
  as response(pid integer)
union all
select 'ovd549_writer'::text, pid
from extensions.dblink('ovd549_writer', 'select pg_backend_pid()')
  as response(pid integer);

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
select ok(
  public.ovd549_wait_for_expected_block(
    (select pid from ovd549_connection_pids where connection_name = 'ovd549_writer'),
    (select pid from ovd549_connection_pids where connection_name = 'ovd549_reserver')
  ),
  'metadata claim is blocked by the uncommitted reservation'
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
select ok(
  public.ovd549_wait_for_expected_block(
    (select pid from ovd549_connection_pids where connection_name = 'ovd549_reserver'),
    (select pid from ovd549_connection_pids where connection_name = 'ovd549_writer')
  ),
  'cleanup is blocked by the uncommitted metadata claim'
);
select extensions.dblink_exec('ovd549_writer', 'commit');
select is(
  (select result from extensions.dblink_get_result('ovd549_reserver')
    as response(result text)),
  'retained_shared', 'cleanup retains a path claimed by the winning writer'
);
select *
from extensions.dblink_get_result('ovd549_reserver') as response(result text);

-- A transaction holding an older snapshot must not make ledger decisions,
-- even when the path row already exists and can be locked.
select extensions.dblink_exec(
  'ovd549_writer', 'begin isolation level repeatable read'
);
select is(
  (select result from extensions.dblink(
    'ovd549_writer',
    $query$select public.ovd549_try_synthetic_claim(
      '00000000-0000-4000-8000-000000054911',
      'ovd549-concurrency/claim-first.step'
    )$query$
  ) as response(result text)),
  'P0001', 'repeatable-read metadata attachment fails closed on an existing path'
);
select extensions.dblink_exec('ovd549_writer', 'rollback');

-- A blob move holds the blob row and old-path ledger first. A concurrent
-- version detach must wait on the blob row before taking the version claim;
-- otherwise the move can deadlock when it later needs that claim.
select extensions.dblink_exec('ovd549_writer', 'begin');
select result
from extensions.dblink(
  'ovd549_writer',
  $query$select id from public.organization_file_blobs
    where id = '00000000-0000-4000-8000-000000054912'
    for update$query$
) as response(result uuid);
select result
from extensions.dblink(
  'ovd549_writer',
  $query$select storage_path from private.storage_path_ledger
    where storage_bucket = 'job-files'
      and storage_path = 'ovd549-concurrency/blob-old.step'
    for update$query$
) as response(result text);
select extensions.dblink_send_query(
  'ovd549_reserver',
  $query$delete from public.part_versions
    where id = '00000000-0000-4000-8000-000000054914'
    returning id$query$
);
select ok(
  public.ovd549_wait_for_expected_block(
    (select pid from ovd549_connection_pids where connection_name = 'ovd549_reserver'),
    (select pid from ovd549_connection_pids where connection_name = 'ovd549_writer')
  ),
  'version detachment waits for the blob move'
);
select is(
  (select result from extensions.dblink(
    'ovd549_writer', 'select public.ovd549_try_lock_version_claim()'
  ) as response(result text)),
  'locked', 'waiting detachment has not taken the version claim'
);
select extensions.dblink_exec('ovd549_writer', 'commit');
select *
from extensions.dblink_get_result('ovd549_reserver') as response(result uuid);
select *
from extensions.dblink_get_result('ovd549_reserver') as response(result uuid);

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
select ok(
  public.ovd549_wait_for_expected_block(
    (select pid from ovd549_connection_pids where connection_name = 'ovd549_reserver'),
    (select pid from ovd549_connection_pids where connection_name = 'ovd549_writer')
  ),
  'cleanup remains blocked by the finalizer until metadata commit'
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
drop function public.ovd549_try_lock_version_claim();
drop function public.ovd549_wait_for_expected_block(integer, integer);

select public.ovd549_reset_concurrency_fixture();
drop function public.ovd549_reset_concurrency_fixture();

select * from finish();
