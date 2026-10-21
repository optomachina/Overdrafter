-- =====================================================================
-- NEEDS BLAINE MIGRATION WINDOW - not applied
-- =====================================================================
-- ROLLBACK for docs/migration-drafts/project-jobs-write-path.sql.
--
-- DRAFT. Not applied. Run only inside a migration window, as a forward
-- migration, if the restriction must be withdrawn. Run it as postgres, the
-- grantor of the prior entries. It restores the exact prior state of
-- public.project_jobs:
--   - INSERT, UPDATE, DELETE and TRUNCATE for anon and authenticated (granted
--     by postgres; PUBLIC held none, so it gets none back);
--   - the FOR ALL policy project_jobs_manage_editors, as created by
--     20260307160000_add_project_jobs_and_selected_offer.sql.
-- Replayable: running it twice leaves the same state.
-- No data change; no data loss.

grant insert, update, delete, truncate on table public.project_jobs to anon, authenticated;

drop policy if exists "project_jobs_manage_editors" on public.project_jobs;
create policy "project_jobs_manage_editors"
on public.project_jobs
for all
to authenticated
using (public.user_can_edit_project(project_id))
with check (public.user_can_edit_project(project_id));
