-- Rollback for ovd-766-e.sql: restores the prod definition captured 2026-10-15
-- (org members could edit any job in their org); restores the pre-766-E definition with the post-OVD-736 grants.
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

revoke all on function public.user_can_edit_job(uuid) from public, anon;
grant execute on function public.user_can_edit_job(uuid) to authenticated, service_role;

do $ovd949$
declare f regprocedure;
begin
  foreach f in array array['public.user_can_edit_job(uuid)']::regprocedure[] loop
    if has_function_privilege('anon', f, 'EXECUTE') or exists (
      select 1 from pg_catalog.pg_proc p,
        pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'OVD-949: % is executable by anon or PUBLIC after rollback', f;
    end if;
  end loop;
end;
$ovd949$;
-- OVD-949 negative test (throwaway, reverted in the next commit): re-grant anon after the self-check.
grant execute on function public.user_can_edit_job(uuid) to anon;
