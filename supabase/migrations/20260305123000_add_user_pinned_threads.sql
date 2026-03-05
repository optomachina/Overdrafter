create table if not exists public.user_pinned_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, project_id)
);

create table if not exists public.user_pinned_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, job_id)
);

create index if not exists idx_user_pinned_projects_user on public.user_pinned_projects(user_id, created_at desc);
create index if not exists idx_user_pinned_projects_project on public.user_pinned_projects(project_id, created_at desc);
create index if not exists idx_user_pinned_jobs_user on public.user_pinned_jobs(user_id, created_at desc);
create index if not exists idx_user_pinned_jobs_job on public.user_pinned_jobs(job_id, created_at desc);

alter table public.user_pinned_projects enable row level security;
alter table public.user_pinned_jobs enable row level security;

drop policy if exists "user_pinned_projects_select_own" on public.user_pinned_projects;
create policy "user_pinned_projects_select_own"
on public.user_pinned_projects
for select
to authenticated
using (
  user_id = auth.uid()
  and public.user_can_access_project(project_id)
);

drop policy if exists "user_pinned_projects_insert_own" on public.user_pinned_projects;
create policy "user_pinned_projects_insert_own"
on public.user_pinned_projects
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.user_can_access_project(project_id)
);

drop policy if exists "user_pinned_projects_delete_own" on public.user_pinned_projects;
create policy "user_pinned_projects_delete_own"
on public.user_pinned_projects
for delete
to authenticated
using (
  user_id = auth.uid()
  and public.user_can_access_project(project_id)
);

drop policy if exists "user_pinned_jobs_select_own" on public.user_pinned_jobs;
create policy "user_pinned_jobs_select_own"
on public.user_pinned_jobs
for select
to authenticated
using (
  user_id = auth.uid()
  and public.user_can_access_job(job_id)
);

drop policy if exists "user_pinned_jobs_insert_own" on public.user_pinned_jobs;
create policy "user_pinned_jobs_insert_own"
on public.user_pinned_jobs
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.user_can_access_job(job_id)
);

drop policy if exists "user_pinned_jobs_delete_own" on public.user_pinned_jobs;
create policy "user_pinned_jobs_delete_own"
on public.user_pinned_jobs
for delete
to authenticated
using (
  user_id = auth.uid()
  and public.user_can_access_job(job_id)
);
