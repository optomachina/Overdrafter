-- OVD-766 item E: who can edit a job (Blaine approved 2026-10-15).
-- Only the job owner (jobs.created_by) and explicitly added editors
-- (project_memberships role owner/editor on a project that contains the job)
-- can edit. Every other organization member is read-only.
-- Internal Overdrafter staff keep edit through user_can_edit_project's
-- is_internal_user branch for project jobs only.
-- Draft only: plain SQL, no transaction control, no psql meta-commands.
-- Promote with git mv into supabase/migrations in an approved window.

create or replace function public.user_can_edit_job(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.jobs job
    where job.id = p_job_id
      and auth.uid() is not null
      and (
        job.created_by = auth.uid()
        or exists (
          select 1
          from public.project_jobs project_job
          where project_job.job_id = job.id
            and public.user_can_edit_project(project_job.project_id)
        )
      )
  );
$$;

revoke all on function public.user_can_edit_job(uuid) from public, anon;
grant execute on function public.user_can_edit_job(uuid) to authenticated, service_role;
