-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- OVD-766 (split child c): public.api_reconcile_job_parts(uuid).
--
-- This file is a DRAFT. It is not under supabase/migrations/, is not part of
-- migration lineage and has not been applied to any database. Promote it only
-- inside a Blaine-approved migration window. Rollback: ovd-766-c.rollback.sql.
--
-- Idempotent with the OVD-736 anon revoke: both revoke EXECUTE from PUBLIC and
-- anon on this function, so applying either one first, or both, ends in the
-- same ACL. Re-running this file is also a no-op.
--
-- ---------------------------------------------------------------------
-- BLOCKER: an authenticated browser client calls this RPC directly.
-- ---------------------------------------------------------------------
-- The requested change (service_role only: revoke from public, anon and
-- authenticated; grant to service_role) would break client intake. Callers
-- found on the current branch:
--   src/features/quotes/api/extraction-api.ts      reconcileJobParts() ->
--     callRpc('api_reconcile_job_parts') -> supabase.rpc() with the signed in
--     user's JWT (src/integrations/supabase/client), role authenticated.
--   reconcileJobParts() is awaited from:
--     src/features/quotes/api/uploads-api.ts         (new-job upload flow)
--     src/features/quotes/use-client-part-controller.ts
--     src/features/quotes/use-client-project-controller.ts
--     src/pages/JobCreate.tsx
--   e2e/intake.spec.ts and docs/qa/customer-continuous-fixture.js expect it.
-- No caller in supabase/functions/, worker/, server/, api/ or services.
-- Nested SQL caller: public.api_request_extraction(uuid)
--   (supabase/migrations/20260812042000_add_canonical_part_identity.sql) does
--   `perform public.api_reconcile_job_parts(p_job_id)`. It is SECURITY DEFINER,
--   so it calls as the function owner and is unaffected by any grant change.
--
-- So the service_role-only change is COMMENTED OUT below (section 2). Before
-- enabling it, the browser call sites must stop calling this RPC (for example
-- rely on api_request_extraction, which already reconciles) and ship first.
--
-- Second finding: the body gates only on public.user_can_access_org(), which
-- reads auth.uid(). A service_role request carries no user, so a direct
-- service_role call always raises 'You do not have access to job ...'. With
-- the body kept, service_role-only leaves no direct caller that can succeed;
-- only nested SECURITY DEFINER callers acting for a signed in member work.
--
-- Third finding (tracked as OVD-769, not changed here): the latest definition
-- (20260308113000_fix_job_file_reconcile_and_add_org_blob_dedupe.sql) dropped
-- the guard that 20260304010000 had: there is no require_verified_auth() call,
-- and any org member (not only a job editor) may rewrite parts. The OVD-602
-- inventory labelled it verified-auth+membership; it is now known-debt
-- OVD-769. If the browser caller must stay, the alternative fix is to keep
-- authenticated and restore `perform public.require_verified_auth();` plus
-- `public.user_can_edit_job(v_job.id)`; that is a behavior change for
-- unverified or view-only members and needs its own decision.
--
-- What section 1 (active) changes, all safe for the browser caller:
--   - search_path = '' with every reference schema qualified (was `public`);
--     the body is otherwise identical to the 20260308113000 definition;
--   - revoke all from PUBLIC and anon (the OVD-736 overlap);
--   - authenticated keeps EXECUTE; service_role keeps its existing grant.
-- On apply, delete the PUBLIC and anon api_reconcile_job_parts rows from
-- supabase/tests/api_role_privilege_inventory.sql in the same PR, and update
-- row 6 of supabase/tests/client_rpc_least_privilege.sql (anon now gets 42501
-- permission denied instead of the job access error).
-- =====================================================================

begin;

-- 1. Active: fixed search_path, PUBLIC/anon revoke. Body unchanged.
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

-- 2. BLOCKED (see header): service_role only. Enable only after the browser
--    call sites above are removed and deployed. When enabled, also delete the
--    authenticated api_reconcile_job_parts row (OVD-769 known-debt) from
--    supabase/tests/api_role_privilege_inventory.sql, delete row 6 from
--    supabase/tests/client_rpc_least_privilege.sql, and promote
--    supabase/tests/pending/ovd766_c_guards.sql.pending.
--
-- revoke all on function public.api_reconcile_job_parts(uuid)
--   from public, anon, authenticated;
-- grant execute on function public.api_reconcile_job_parts(uuid) to service_role;

commit;
