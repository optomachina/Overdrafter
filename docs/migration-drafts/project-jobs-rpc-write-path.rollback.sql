-- Rollback for supabase/migrations/20261020151109_project_jobs_rpc_write_path.sql.
-- Restores the direct write grants on public.project_jobs for anon and
-- authenticated and the FOR ALL editor policy exactly as
-- 20260307160000_add_project_jobs_and_selected_offer.sql created it.
-- Replayable: the policy is dropped if present before it is recreated, and the
-- grants are idempotent. No data changes; no data loss.
-- Plain SQL, no transaction control, no psql meta-commands.

grant insert, update, delete, truncate on table public.project_jobs to anon, authenticated;

drop policy if exists "project_jobs_manage_editors" on public.project_jobs;
create policy "project_jobs_manage_editors"
on public.project_jobs
for all
to authenticated
using (public.user_can_edit_project(project_id))
with check (public.user_can_edit_project(project_id));
