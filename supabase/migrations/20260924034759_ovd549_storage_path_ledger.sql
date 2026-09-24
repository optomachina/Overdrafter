-- OVD-549: source-only, private path ownership and reservation foundation.
-- This does not replace either existing archived-delete path or authorize a
-- Storage removal. OVD-543 must reserve inside its atomic logical-delete
-- transaction; OVD-548/550 must gate every physical upload before cutover.
--
-- Forward-only rollback: leave ledger and tombstones intact, stop cleanup
-- admission, then repair the affected trigger/function in a reviewed migration.
-- Dropping this ledger after any reservation or Storage removal could permit
-- late path reuse and is not a safe rollback.
begin;

create table private.storage_path_ledger (
  storage_bucket text not null,
  storage_path text not null,
  state text not null default 'active',
  upload_lease_id uuid,
  cleanup_operation_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (storage_bucket, storage_path),
  constraint storage_path_ledger_nonempty_check
    check (btrim(storage_bucket) <> '' and btrim(storage_path) <> ''),
  constraint storage_path_ledger_state_check
    check (state in (
      'active', 'upload_leased', 'retained_shared',
      'cleanup_reserved', 'completed'
    )),
  constraint storage_path_ledger_lease_check
    check (state <> 'upload_leased' or upload_lease_id is not null),
  constraint storage_path_ledger_operation_check
    check (
      (state in ('cleanup_reserved', 'completed'))
      = (cleanup_operation_id is not null)
    )
);

create table private.storage_path_claims (
  claim_source text not null,
  claim_row_id uuid not null,
  claim_slot text not null,
  storage_bucket text not null,
  storage_path text not null,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (claim_source, claim_row_id, claim_slot),
  foreign key (storage_bucket, storage_path)
    references private.storage_path_ledger(storage_bucket, storage_path)
    on delete restrict,
  constraint storage_path_claims_source_check check (
    (claim_source = 'part_versions' and claim_slot in ('cad', 'drawing'))
    or (
      claim_source in (
        'organization_file_blobs', 'job_files', 'drawing_preview_assets',
        'cad_preview_assets', 'vendor_quote_artifacts'
      )
      and claim_slot = 'object'
    )
  )
);

create index storage_path_claims_object_idx
on private.storage_path_claims(storage_bucket, storage_path);

-- Lease IDs are never reused, including after a later lease replaces the
-- ledger row's last ID. This closes delayed-writer replay after interruption.
create table private.storage_path_upload_leases (
  lease_id uuid primary key,
  storage_bucket text not null,
  storage_path text not null,
  created_at timestamptz not null default timezone('utc', now()),
  released_at timestamptz,
  foreign key (storage_bucket, storage_path)
    references private.storage_path_ledger(storage_bucket, storage_path)
    on delete restrict
);

alter table private.storage_path_ledger enable row level security;
alter table private.storage_path_ledger force row level security;
alter table private.storage_path_claims enable row level security;
alter table private.storage_path_claims force row level security;
alter table private.storage_path_upload_leases enable row level security;
alter table private.storage_path_upload_leases force row level security;
revoke all on private.storage_path_ledger, private.storage_path_claims,
  private.storage_path_upload_leases
from public, anon, authenticated, service_role;

-- INSERT ... ON CONFLICT serializes creation of an absent path. Every claim,
-- lease, and cleanup decision then holds the same ledger row until commit.
create function private.lock_storage_path(
  p_bucket text,
  p_path text
)
returns private.storage_path_ledger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_ledger private.storage_path_ledger%rowtype;
begin
  if p_bucket is null or btrim(p_bucket) = ''
     or p_path is null or btrim(p_path) = '' then
    raise exception 'A nonempty storage bucket and path are required.';
  end if;

  insert into private.storage_path_ledger (storage_bucket, storage_path)
  values (p_bucket, p_path)
  on conflict (storage_bucket, storage_path) do nothing;

  select ledger.* into strict v_ledger
  from private.storage_path_ledger ledger
  where ledger.storage_bucket = p_bucket
    and ledger.storage_path = p_path
  for update;
  return v_ledger;
end;
$$;

create function private.put_storage_path_claim(
  p_source text,
  p_row_id uuid,
  p_slot text,
  p_bucket text,
  p_path text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_ledger private.storage_path_ledger%rowtype;
begin
  v_ledger := private.lock_storage_path(p_bucket, p_path);
  if v_ledger.state in ('upload_leased', 'cleanup_reserved', 'completed') then
    raise exception 'Storage path is leased, reserved, or completed.'
      using errcode = 'P0001';
  end if;

  insert into private.storage_path_claims (
    claim_source, claim_row_id, claim_slot, storage_bucket, storage_path
  ) values (
    p_source, p_row_id, p_slot, p_bucket, p_path
  )
  on conflict (claim_source, claim_row_id, claim_slot) do update
  set storage_bucket = excluded.storage_bucket,
      storage_path = excluded.storage_path;
end;
$$;

create function private.drop_storage_path_claim(
  p_source text,
  p_row_id uuid,
  p_slot text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_claim private.storage_path_claims%rowtype;
begin
  select claim.* into v_claim
  from private.storage_path_claims claim
  where claim.claim_source = p_source
    and claim.claim_row_id = p_row_id
    and claim.claim_slot = p_slot
  for update;
  if not found then
    return;
  end if;

  perform private.lock_storage_path(
    v_claim.storage_bucket, v_claim.storage_path
  );
  delete from private.storage_path_claims claim
  where claim.claim_source = p_source
    and claim.claim_row_id = p_row_id
    and claim.claim_slot = p_slot;
end;
$$;

create function private.sync_direct_storage_path_claim()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if tg_op = 'DELETE'
       or (old.id, old.storage_bucket, old.storage_path)
          is distinct from (new.id, new.storage_bucket, new.storage_path) then
      perform private.drop_storage_path_claim(tg_table_name, old.id, 'object');
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    if tg_op = 'INSERT'
       or (old.id, old.storage_bucket, old.storage_path)
          is distinct from (new.id, new.storage_bucket, new.storage_path) then
      perform private.put_storage_path_claim(
        tg_table_name, new.id, 'object',
        new.storage_bucket, new.storage_path
      );
    end if;
    return new;
  end if;
  return old;
end;
$$;

-- A canonical version refers to blobs by ID, not by a copied path. Locking
-- the blob row FOR SHARE serializes this claim with a concurrent blob-path
-- UPDATE (which takes FOR NO KEY UPDATE on the same row).
create function private.sync_part_version_storage_claims()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_blob public.organization_file_blobs%rowtype;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if old.cad_blob_id is not null
       and (tg_op = 'DELETE'
            or (old.id, old.cad_blob_id)
               is distinct from (new.id, new.cad_blob_id)) then
      perform private.drop_storage_path_claim('part_versions', old.id, 'cad');
    end if;
    if old.drawing_blob_id is not null
       and (tg_op = 'DELETE'
            or (old.id, old.drawing_blob_id)
               is distinct from (new.id, new.drawing_blob_id)) then
      perform private.drop_storage_path_claim(
        'part_versions', old.id, 'drawing'
      );
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    if new.cad_blob_id is not null
       and (tg_op = 'INSERT'
            or (old.id, old.cad_blob_id)
               is distinct from (new.id, new.cad_blob_id)) then
      select blob.* into strict v_blob
      from public.organization_file_blobs blob
      where blob.id = new.cad_blob_id
      for share;
      perform private.put_storage_path_claim(
        'part_versions', new.id, 'cad',
        v_blob.storage_bucket, v_blob.storage_path
      );
    end if;
    if new.drawing_blob_id is not null
       and (tg_op = 'INSERT'
            or (old.id, old.drawing_blob_id)
               is distinct from (new.id, new.drawing_blob_id)) then
      select blob.* into strict v_blob
      from public.organization_file_blobs blob
      where blob.id = new.drawing_blob_id
      for share;
      perform private.put_storage_path_claim(
        'part_versions', new.id, 'drawing',
        v_blob.storage_bucket, v_blob.storage_path
      );
    end if;
    return new;
  end if;
  return old;
end;
$$;

create function private.sync_blob_version_storage_claims()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_version public.part_versions%rowtype;
begin
  if (old.storage_bucket, old.storage_path)
     is not distinct from (new.storage_bucket, new.storage_path) then
    return new;
  end if;

  for v_version in
    select version.*
    from public.part_versions version
    where version.cad_blob_id = new.id
       or version.drawing_blob_id = new.id
  loop
    if v_version.cad_blob_id = new.id then
      perform private.drop_storage_path_claim(
        'part_versions', v_version.id, 'cad'
      );
      perform private.put_storage_path_claim(
        'part_versions', v_version.id, 'cad',
        new.storage_bucket, new.storage_path
      );
    end if;
    if v_version.drawing_blob_id = new.id then
      perform private.drop_storage_path_claim(
        'part_versions', v_version.id, 'drawing'
      );
      perform private.put_storage_path_claim(
        'part_versions', v_version.id, 'drawing',
        new.storage_bucket, new.storage_path
      );
    end if;
  end loop;
  return new;
end;
$$;

create function private.acquire_storage_upload_lease(
  p_bucket text,
  p_path text,
  p_lease_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_ledger private.storage_path_ledger%rowtype;
  v_inserted integer;
begin
  if p_lease_id is null then
    raise exception 'An upload lease ID is required.';
  end if;
  v_ledger := private.lock_storage_path(p_bucket, p_path);

  if v_ledger.state in ('cleanup_reserved', 'completed') then
    raise exception 'Storage path is reserved or completed.'
      using errcode = 'P0001';
  end if;
  if v_ledger.state = 'upload_leased' then
    if v_ledger.upload_lease_id = p_lease_id then
      return 'upload_leased';
    end if;
    raise exception 'Storage path has another live upload lease.'
      using errcode = 'P0001';
  end if;
  if v_ledger.upload_lease_id = p_lease_id then
    raise exception 'A released upload lease ID cannot be reused.'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1 from private.storage_path_claims claim
    where claim.storage_bucket = p_bucket
      and claim.storage_path = p_path
  ) then
    raise exception 'A referenced storage path cannot be overwritten.'
      using errcode = 'P0001';
  end if;

  insert into private.storage_path_upload_leases (
    lease_id, storage_bucket, storage_path
  ) values (
    p_lease_id, p_bucket, p_path
  )
  on conflict (lease_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 1 then
    raise exception 'An upload lease ID cannot be reused.'
      using errcode = 'P0001';
  end if;

  update private.storage_path_ledger ledger
  set state = 'upload_leased',
      upload_lease_id = p_lease_id,
      updated_at = timezone('utc', now())
  where ledger.storage_bucket = p_bucket
    and ledger.storage_path = p_path;
  return 'upload_leased';
end;
$$;

-- The future writer must call this in the SAME database transaction as the
-- final metadata INSERT/UPDATE. PostgreSQL retains the ledger row lock until
-- that transaction commits; a separate release request would allow cleanup
-- to reserve the path before the metadata claim. Browser HTTP upload and
-- finalization therefore need a single server/RPC finalizer transaction.
create function private.release_storage_upload_lease(
  p_bucket text,
  p_path text,
  p_lease_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_ledger private.storage_path_ledger%rowtype;
begin
  if p_lease_id is null then
    raise exception 'An upload lease ID is required.';
  end if;
  v_ledger := private.lock_storage_path(p_bucket, p_path);
  if v_ledger.upload_lease_id is distinct from p_lease_id then
    raise exception 'Upload lease ID does not match.'
      using errcode = 'P0001';
  end if;
  if v_ledger.state = 'active' then
    return 'active';
  end if;
  if v_ledger.state <> 'upload_leased' then
    raise exception 'The path has no releasable upload lease.'
      using errcode = 'P0001';
  end if;

  update private.storage_path_ledger ledger
  set state = 'active',
      updated_at = timezone('utc', now())
  where ledger.storage_bucket = p_bucket
    and ledger.storage_path = p_path;
  update private.storage_path_upload_leases lease
  set released_at = timezone('utc', now())
  where lease.lease_id = p_lease_id
    and lease.storage_bucket = p_bucket
    and lease.storage_path = p_path
    and lease.released_at is null;
  if not found then
    raise exception 'Upload lease history is missing or already released.'
      using errcode = 'P0001';
  end if;
  return 'active';
end;
$$;

create function private.reserve_storage_path_for_cleanup(
  p_bucket text,
  p_path text,
  p_operation_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_ledger private.storage_path_ledger%rowtype;
begin
  if p_operation_id is null then
    raise exception 'A cleanup operation ID is required.';
  end if;
  v_ledger := private.lock_storage_path(p_bucket, p_path);
  if v_ledger.state in ('cleanup_reserved', 'completed') then
    if v_ledger.cleanup_operation_id = p_operation_id then
      return v_ledger.state;
    end if;
    raise exception 'Storage path belongs to a different cleanup operation.'
      using errcode = 'P0001';
  end if;
  if v_ledger.state = 'upload_leased' then
    return 'upload_leased';
  end if;
  if exists (
    select 1 from private.storage_path_claims claim
    where claim.storage_bucket = p_bucket
      and claim.storage_path = p_path
  ) then
    update private.storage_path_ledger ledger
    set state = 'retained_shared',
        updated_at = timezone('utc', now())
    where ledger.storage_bucket = p_bucket
      and ledger.storage_path = p_path;
    return 'retained_shared';
  end if;

  update private.storage_path_ledger ledger
  set state = 'cleanup_reserved',
      cleanup_operation_id = p_operation_id,
      updated_at = timezone('utc', now())
  where ledger.storage_bucket = p_bucket
    and ledger.storage_path = p_path;
  return 'cleanup_reserved';
end;
$$;

-- This function is deliberately private and ungranted. OVD-544 must call it
-- only after its separate Storage absence/readback receipt is committed.
create function private.complete_storage_path_cleanup(
  p_bucket text,
  p_path text,
  p_operation_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_ledger private.storage_path_ledger%rowtype;
begin
  if p_operation_id is null then
    raise exception 'A cleanup operation ID is required.';
  end if;
  v_ledger := private.lock_storage_path(p_bucket, p_path);
  if v_ledger.cleanup_operation_id is distinct from p_operation_id then
    raise exception 'Cleanup operation ID does not match.'
      using errcode = 'P0001';
  end if;
  if v_ledger.state = 'completed' then
    return 'completed';
  end if;
  if v_ledger.state <> 'cleanup_reserved' then
    raise exception 'Storage path is not reserved for cleanup.'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1 from private.storage_path_claims claim
    where claim.storage_bucket = p_bucket
      and claim.storage_path = p_path
  ) then
    raise exception 'A referenced storage path cannot be completed.'
      using errcode = 'P0001';
  end if;

  update private.storage_path_ledger ledger
  set state = 'completed',
      updated_at = timezone('utc', now())
  where ledger.storage_bucket = p_bucket
    and ledger.storage_path = p_path;
  return 'completed';
end;
$$;

revoke all on function private.lock_storage_path(text, text)
from public, anon, authenticated, service_role;
revoke all on function private.put_storage_path_claim(text, uuid, text, text, text)
from public, anon, authenticated, service_role;
revoke all on function private.drop_storage_path_claim(text, uuid, text)
from public, anon, authenticated, service_role;
revoke all on function private.sync_direct_storage_path_claim()
from public, anon, authenticated, service_role;
revoke all on function private.sync_part_version_storage_claims()
from public, anon, authenticated, service_role;
revoke all on function private.sync_blob_version_storage_claims()
from public, anon, authenticated, service_role;
revoke all on function private.acquire_storage_upload_lease(text, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function private.release_storage_upload_lease(text, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function private.reserve_storage_path_for_cleanup(text, text, uuid)
from public, anon, authenticated, service_role;
revoke all on function private.complete_storage_path_cleanup(text, text, uuid)
from public, anon, authenticated, service_role;

-- The migration blocks concurrent writes while it takes a metadata-only
-- snapshot and installs every enforcement trigger. A failure rolls back the
-- tables, claims, and trigger changes together; no customer object is opened.
lock table
  public.organization_file_blobs, public.job_files,
  public.drawing_preview_assets, public.cad_preview_assets,
  public.vendor_quote_artifacts, public.part_versions
in share row exclusive mode;

create temporary table ovd549_existing_path_claims on commit drop as
select 'organization_file_blobs'::text as claim_source,
  blob.id as claim_row_id, 'object'::text as claim_slot,
  blob.storage_bucket, blob.storage_path
from public.organization_file_blobs blob
union all
select 'job_files', file.id, 'object',
  file.storage_bucket, file.storage_path
from public.job_files file
union all
select 'drawing_preview_assets', asset.id, 'object',
  asset.storage_bucket, asset.storage_path
from public.drawing_preview_assets asset
union all
select 'cad_preview_assets', asset.id, 'object',
  asset.storage_bucket, asset.storage_path
from public.cad_preview_assets asset
union all
select 'vendor_quote_artifacts', artifact.id, 'object',
  artifact.storage_bucket, artifact.storage_path
from public.vendor_quote_artifacts artifact
union all
select 'part_versions', version.id, 'cad',
  blob.storage_bucket, blob.storage_path
from public.part_versions version
join public.organization_file_blobs blob on blob.id = version.cad_blob_id
union all
select 'part_versions', version.id, 'drawing',
  blob.storage_bucket, blob.storage_path
from public.part_versions version
join public.organization_file_blobs blob on blob.id = version.drawing_blob_id;

insert into private.storage_path_ledger (storage_bucket, storage_path)
select distinct claim.storage_bucket, claim.storage_path
from ovd549_existing_path_claims claim;

insert into private.storage_path_claims (
  claim_source, claim_row_id, claim_slot, storage_bucket, storage_path
)
select claim_source, claim_row_id, claim_slot, storage_bucket, storage_path
from ovd549_existing_path_claims;

create trigger ovd549_claim_organization_file_blobs
after insert or update of id, storage_bucket, storage_path or delete
on public.organization_file_blobs
for each row execute function private.sync_direct_storage_path_claim();
create trigger ovd549_claim_job_files
after insert or update of id, storage_bucket, storage_path or delete
on public.job_files
for each row execute function private.sync_direct_storage_path_claim();
create trigger ovd549_claim_drawing_preview_assets
after insert or update of id, storage_bucket, storage_path or delete
on public.drawing_preview_assets
for each row execute function private.sync_direct_storage_path_claim();
create trigger ovd549_claim_cad_preview_assets
after insert or update of id, storage_bucket, storage_path or delete
on public.cad_preview_assets
for each row execute function private.sync_direct_storage_path_claim();
create trigger ovd549_claim_vendor_quote_artifacts
after insert or update of id, storage_bucket, storage_path or delete
on public.vendor_quote_artifacts
for each row execute function private.sync_direct_storage_path_claim();
create trigger ovd549_claim_part_versions
after insert or update of id, cad_blob_id, drawing_blob_id or delete
on public.part_versions
for each row execute function private.sync_part_version_storage_claims();
create trigger ovd549_move_blob_version_claims
after update of storage_bucket, storage_path
on public.organization_file_blobs
for each row execute function private.sync_blob_version_storage_claims();

commit;
