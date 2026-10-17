-- Rollback for ovd-766-e.sql: restores the prod definition captured 2026-10-15
-- (org members could edit any job in their org) and its original grants.
create or replace function public.user_can_edit_job(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.jobs job
    where job.id = p_job_id
      and (
        public.user_can_access_org(job.organization_id)
        or job.created_by = auth.uid()
        or exists (
          select 1
          from public.project_jobs project_job
          where project_job.job_id = job.id
            and public.user_can_edit_project(project_job.project_id)
        )
      )
  );
$$;

grant execute on function public.user_can_edit_job(uuid) to public, anon, authenticated, service_role;
