-- OVD-628: take referencing parts before job_files in the worker's
-- trusted-hash RPC.
--
-- Every admission path and editor locks parts, then approved requirements,
-- then job_files: the generic provider dispatch (20261003160000) and the
-- legacy Xometry admission helper private.lock_xometry_beta_dispatch_scope_rows
-- (20261004100000). public.api_register_trusted_file_hash, which the worker
-- calls on every staged download (worker/src/files.ts), took the reverse
-- order: it locked and updated the job_files row (and same-blob job_files rows
-- of other jobs in the organization) and only then took each referencing part
-- FOR UPDATE through private.assign_canonical_part_version. A request parked
-- between its parts and job_files locks and a concurrent registration of the
-- same file therefore deadlocked (40P01 on one side).
--
-- The RPC now locks every part that references the file, or a job_files row
-- with the same blob, FOR UPDATE and ordered by id, right after its two
-- argument checks and before it locks or updates any job_files row. The part
-- set uses the same predicate as the existing assignment loop, so
-- private.assign_canonical_part_version (not redefined here) re-takes locks
-- this transaction already holds. The lock strength is unchanged: the same
-- rows were already locked FOR UPDATE in the same transaction, only later.
--
-- The function body is byte-identical to 20260812042000_add_canonical_part_identity.sql
-- except for the one added perform statement. Its security definer setting,
-- search_path and revoke/grant statements are restated unchanged.
--
-- Rollback: re-run the create or replace statement for
-- public.api_register_trusted_file_hash and its revoke/grant from
-- 20260812042000_add_canonical_part_identity.sql. No data changes.

create or replace function public.api_register_trusted_file_hash(
  p_job_file_id uuid,
  p_content_sha256 text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_file public.job_files%rowtype;
  v_hash text := lower(trim(coalesce(p_content_sha256, '')));
  v_part_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Trusted file hashes may only be registered by the worker.';
  end if;
  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid SHA-256 hash is required.';
  end if;

  perform 1
  from public.parts part
  where part.id in (
    select referencing.id
    from public.parts referencing
    join public.job_files file
      on file.id = referencing.cad_file_id or file.id = referencing.drawing_file_id
    where file.id = p_job_file_id
      or file.blob_id = (
        select target.blob_id from public.job_files target where target.id = p_job_file_id
      )
  )
  order by part.id
  for update;

  select file.* into v_file
  from public.job_files file
  where file.id = p_job_file_id
  for update;
  if v_file.id is null then
    raise exception 'Job file % not found.', p_job_file_id;
  end if;
  if v_file.trusted_content_sha256 is not null
    and v_file.trusted_content_sha256 <> v_hash then
    raise exception 'Trusted file hash conflicts with previously verified content.';
  end if;

  update public.job_files
  set trusted_content_sha256 = v_hash
  where id = v_file.id
    or (
      v_file.blob_id is not null
      and blob_id = v_file.blob_id
      and organization_id = v_file.organization_id
      and (trusted_content_sha256 is null or trusted_content_sha256 = v_hash)
    );
  update public.organization_file_blobs
  set trusted_content_sha256 = v_hash
  where id = v_file.blob_id
    and organization_id = v_file.organization_id
    and (trusted_content_sha256 is null or trusted_content_sha256 = v_hash);

  if v_file.blob_id is not null and not found then
    raise exception 'Organization blob hash conflicts with downloaded file content.';
  end if;

  for v_part_id in
    select distinct part.id
    from public.parts part
    join public.job_files file
      on file.id = part.cad_file_id or file.id = part.drawing_file_id
    where file.id = v_file.id
      or (v_file.blob_id is not null and file.blob_id = v_file.blob_id)
  loop
    perform private.assign_canonical_part_version(v_part_id);
  end loop;
end;
$$;

revoke all on function public.api_register_trusted_file_hash(uuid, text)
from public, anon, authenticated;
grant execute on function public.api_register_trusted_file_hash(uuid, text)
to service_role;
