-- OVD-1018 down path for the promoted migration
-- supabase/migrations/20261030204050_ovd1018_restrict_project_jobs_writes.sql.
-- No forward draft: the forward SQL lives only in migrations. Run only inside
-- a migration window, as postgres, the grantor of the prior entries, if the
-- restriction must be withdrawn. It restores the exact prior state of
-- public.project_jobs:
--   - INSERT, UPDATE, DELETE and TRUNCATE for anon and authenticated (granted
--     by postgres; PUBLIC held none, so it gets none back);
--   - the FOR ALL policy project_jobs_manage_editors, as created by
--     20260307160000_add_project_jobs_and_selected_offer.sql.
-- Replayable: running it twice leaves the same state.
-- No data change; no data loss.
-- Regression: supabase/tests/project_jobs_write_path.sql applies a byte copy
-- (supabase/tests/fixtures/project_jobs_write_path_rollback.inc) twice.
--
-- SET LOCAL is scoped to the transaction that runs this file. The policy
-- recreate takes ACCESS EXCLUSIVE; a 3s lock timeout fails the transaction
-- instead of queueing readers.

set local lock_timeout = '3s';

grant insert, update, delete, truncate on table public.project_jobs to anon, authenticated;

drop policy if exists "project_jobs_manage_editors" on public.project_jobs;
create policy "project_jobs_manage_editors"
on public.project_jobs
for all
to authenticated
using (public.user_can_edit_project(project_id))
with check (public.user_can_edit_project(project_id));
