-- OVD-1018: restrict public.project_jobs writes to the SECURITY DEFINER RPC
-- path (defense in depth). Promoted from the reviewed draft
-- docs/migration-drafts/project-jobs-write-path.sql (PR #892).
-- Rollback: docs/migration-drafts/ovd-1018.rollback.sql.
--
-- Clients only read project_jobs (src/features/quotes/api/projects-api.ts and
-- the create-payment-intent edge function). Every write already goes through a
-- path that does not need a write grant for anon or authenticated, or the
-- FOR ALL policy:
--   insert   api_assign_job_to_project, api_create_client_draft
--   delete   api_remove_job_from_project, api_dissolve_project
--   cascade  ON DELETE CASCADE from projects and jobs, run as the table owner:
--            api_delete_project, api_delete_archived_jobs,
--            api_delete_archived_job and the job-archive-fallback edge function
--            (which connects as postgres)
--   service  worker/src/tools/importSpreadsheetQuotes.ts,
--            worker/src/tools/importDmriflesQuotes.ts and scripts/seed-dev.mjs
--            use the service_role key, which keeps its grants and bypasses RLS
-- The RPCs are SECURITY DEFINER and owned by postgres. The archive, unarchive
-- and access helpers only read the table.
--
-- 1. Revoke INSERT, UPDATE, DELETE and TRUNCATE on the table from PUBLIC, anon
--    and authenticated. SELECT and service_role are unchanged.
-- 2. Drop the FOR ALL policy project_jobs_manage_editors, so RLS refuses
--    direct writes even if a later grant returns. Reads are unchanged:
--    user_can_edit_project implies user_can_access_project, so
--    project_jobs_select_accessible already returns every row the dropped
--    policy returned.
--
-- No data change; no data loss on apply or rollback. Replayable: running it
-- twice leaves the same state.
-- Regression: supabase/tests/project_jobs_write_path.sql, which installs a byte
-- copy of this file (supabase/tests/fixtures/project_jobs_write_path.inc) only
-- while authenticated still holds INSERT.

-- The policy drop takes ACCESS EXCLUSIVE on project_jobs. Fail fast behind a
-- long running reader instead of queueing every read; on a timeout the whole
-- migration rolls back and is rerun at lower traffic. SET LOCAL is scoped to
-- the transaction that runs this file (psql -1, MCP execute_sql, the pgTAP
-- copy, or the Supabase CLI batch, which also prints a 25P01 notice for it).
set local lock_timeout = '3s';

revoke insert, update, delete, truncate on table public.project_jobs from public, anon, authenticated;

drop policy if exists "project_jobs_manage_editors" on public.project_jobs;
