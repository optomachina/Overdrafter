-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-766 (split child c) / OVD-769: public.api_reconcile_job_parts(uuid).
--
-- This file is a DRAFT. It is not under supabase/migrations/, is not part of
-- migration lineage and has not been applied to any database. Promote it only
-- inside a Blaine-approved migration window. Rollback: ovd-766-c.rollback.sql.
--
-- Release decision: option (b). authenticated keeps EXECUTE because the
-- browser calls this RPC directly with the signed in user's JWT:
--   src/features/quotes/api/extraction-api.ts      reconcileJobParts()
--   awaited from src/features/quotes/api/uploads-api.ts,
--   src/features/quotes/use-client-part-controller.ts,
--   src/features/quotes/use-client-project-controller.ts, src/pages/JobCreate.tsx.
-- Instead the body regains the guard that 20260304010000 had and
-- 20260308113000 dropped:
--   1. `perform public.require_verified_auth();` is the first statement, so a
--      caller with no user or an unverified email is refused;
--   2. `public.user_can_edit_job(p_job_id)` must hold, with the 20260304010000
--      message 'You do not have access to job %'. It runs before the job
--      lookup, so a missing job and a forbidden job get the same answer.
-- The rest of the body is the 20260308113000 definition unchanged (its org
-- membership check stays as a second, redundant gate).
--
-- Also:
--   - search_path = '' with every reference schema qualified (was `public`);
--   - revoke all from PUBLIC and anon (the OVD-736 overlap); grant EXECUTE to
--     authenticated; service_role keeps its existing grant.
-- Idempotent with the OVD-736 anon revoke: both end in the same ACL, and
-- re-running this file is a no-op.
--
-- Behavior change: unverified members, and anon (now 42501 before the body),
-- can no longer reconcile. Every verified org member still passes, because
-- user_can_edit_job admits any user_can_access_org member, the job creator and
-- project editors. The nested caller public.api_request_extraction(uuid)
-- (20260812042000) already runs require_verified_auth() and
-- user_can_edit_job() before its `perform public.api_reconcile_job_parts`, so
-- it is unaffected.
--
-- Same PR on apply:
--   - promote supabase/tests/pending/ovd766_c_guards.sql.pending to
--     supabase/tests/ovd766_c_guards.sql;
--   - delete the PUBLIC and anon api_reconcile_job_parts rows from
--     supabase/tests/api_role_privilege_inventory.sql (the authenticated row
--     is already 'job-editor', OVD-769);
--   - update supabase/tests/client_rpc_least_privilege.sql row 6 (anon now
--     42501 permission denied; unverified now the verify-email error) and drop
--     its "KNOWN GAP: unverified org A member can reconcile job parts" check.
-- =====================================================================

begin;

create or replace function public.api_reconcile_job_parts(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
  v_total_parts integer := 0;
  v_matched_pairs integer := 0;
  v_missing_drawings integer := 0;
  v_missing_cad integer := 0;
begin
  perform public.require_verified_auth();

  if not public.user_can_edit_job(p_job_id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  select *
  into v_job
  from public.jobs
  where id = p_job_id;

  if v_job.id is null then
    raise exception 'Job % not found', p_job_id;
  end if;

  if not public.user_can_access_org(v_job.organization_id) then
    raise exception 'You do not have access to job %', p_job_id;
  end if;

  delete from public.parts part
  where part.job_id = p_job_id
    and not exists (
      select 1
      from public.job_part_file_set(p_job_id) fs
      where fs.normalized_name = part.normalized_key
    );

  insert into public.parts (
    job_id,
    organization_id,
    name,
    normalized_key,
    cad_file_id,
    drawing_file_id,
    quantity
  )
  select
    p_job_id,
    v_job.organization_id,
    fs.normalized_name,
    fs.normalized_name,
    fs.cad_file_id,
    fs.drawing_file_id,
    1
  from public.job_part_file_set(p_job_id) fs
  on conflict (job_id, normalized_key) do update
    set cad_file_id = excluded.cad_file_id,
        drawing_file_id = excluded.drawing_file_id,
        updated_at = pg_catalog.timezone('utc', pg_catalog.now());

  update public.job_files
  set matched_part_key = normalized_name
  where job_id = p_job_id
    and file_kind in ('cad'::public.job_file_kind, 'drawing'::public.job_file_kind);

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (where cad_file_id is not null and drawing_file_id is not null)::integer,
    pg_catalog.count(*) filter (where cad_file_id is not null and drawing_file_id is null)::integer,
    pg_catalog.count(*) filter (where cad_file_id is null and drawing_file_id is not null)::integer
  into
    v_total_parts,
    v_matched_pairs,
    v_missing_drawings,
    v_missing_cad
  from public.job_part_file_set(p_job_id);

  perform public.log_audit_event(
    v_job.organization_id,
    'job.parts_reconciled',
    pg_catalog.jsonb_build_object(
      'totalParts', coalesce(v_total_parts, 0),
      'matchedPairs', coalesce(v_matched_pairs, 0),
      'missingDrawings', coalesce(v_missing_drawings, 0),
      'missingCad', coalesce(v_missing_cad, 0)
    ),
    p_job_id,
    null
  );

  return pg_catalog.jsonb_build_object(
    'totalParts', coalesce(v_total_parts, 0),
    'matchedPairs', coalesce(v_matched_pairs, 0),
    'missingDrawings', coalesce(v_missing_drawings, 0),
    'missingCad', coalesce(v_missing_cad, 0)
  );
end;
$$;

revoke all on function public.api_reconcile_job_parts(uuid) from public, anon;
grant execute on function public.api_reconcile_job_parts(uuid) to authenticated;

commit;
