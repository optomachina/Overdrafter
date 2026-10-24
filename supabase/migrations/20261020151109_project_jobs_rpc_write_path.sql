-- Restrict writes to public.project_jobs to the SECURITY DEFINER RPC path
-- (defense in depth).
--
-- Clients only read project_jobs (src/features/quotes/api/projects-api.ts).
-- Every link they create or remove goes through an RPC that checks the project,
-- the job and the organization before it writes:
--   insert:  api_assign_job_to_project, api_create_client_draft
--   delete:  api_remove_job_from_project, api_dissolve_project
--   cascade: api_delete_project and api_delete_archived_jobs delete the parent
--            row, and ON DELETE CASCADE removes its links
-- Those functions are SECURITY DEFINER and owned by postgres, and foreign key
-- cascades run as the table owner, so none of them relies on a write grant to
-- the API roles. The worker import tools use service_role, which keeps its
-- grants.
--
-- anon and authenticated still held INSERT, UPDATE, DELETE and TRUNCATE from
-- the default privileges, and the FOR ALL policy project_jobs_manage_editors
-- also admitted direct writes. This migration makes the RPCs the only write
-- path for the API roles:
--   1. revoke INSERT, UPDATE, DELETE and TRUNCATE on the table from anon and
--      authenticated (SELECT stays);
--   2. drop project_jobs_manage_editors. Reads are unchanged:
--      user_can_edit_project implies user_can_access_project, so
--      project_jobs_select_accessible already returns every row the dropped
--      policy exposed.
--
-- Regression: supabase/tests/project_jobs_rpc_write_path.sql.
-- Rollback: docs/migration-drafts/project-jobs-rpc-write-path.rollback.sql.
-- No data changes; no data loss on apply or rollback.

revoke insert, update, delete, truncate on table public.project_jobs from anon, authenticated;

drop policy if exists "project_jobs_manage_editors" on public.project_jobs;
