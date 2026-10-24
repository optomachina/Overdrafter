-- public.project_jobs is written only through the SECURITY DEFINER RPC path
-- (20261020151109_project_jobs_rpc_write_path.sql, defense in depth).
--
-- Proves, as the API roles:
--   (1) a direct INSERT, UPDATE, DELETE or TRUNCATE on project_jobs is denied
--       for authenticated and anon, while reads are unchanged;
--   (2) the RPCs still create and remove links for a job the caller may edit
--       (api_assign_job_to_project, api_create_client_draft,
--       api_remove_job_from_project, api_dissolve_project, and the cascade
--       under api_delete_project);
--   (3) a job from another organization cannot be linked, directly or through
--       the RPC.
-- Synthetic records only; everything rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(29);

\set owner_a b7c10000-0000-4000-8000-000000000001
\set member_a2 b7c10000-0000-4000-8000-000000000002
\set client_b b7c10000-0000-4000-8000-000000000003
\set org_a b7c10000-0000-4000-8000-00000000000a
\set org_b b7c10000-0000-4000-8000-00000000000b
\set project_a b7c10000-0000-4000-8000-000000000020
\set project_a2 b7c10000-0000-4000-8000-000000000021
\set project_b b7c10000-0000-4000-8000-000000000022
\set project_c b7c10000-0000-4000-8000-000000000023
\set project_d b7c10000-0000-4000-8000-000000000024
\set job_a1 b7c10000-0000-4000-8000-000000000031
\set job_a2 b7c10000-0000-4000-8000-000000000032

create function pg_temp.act_as(p_user uuid, p_role text default 'authenticated') returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true),
    set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', p_role)::text, true);
$$;

-- Org A: owner A owns project A (holding job A1) and projects C and D; member A2
-- is a plain org member who owns project A2. Org B: client B owns project B.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values (:'owner_a', 'authenticated', 'authenticated', 'pjw-owner-a@example.test', timezone('utc', now()), '{"provider":"email"}'),
  (:'member_a2', 'authenticated', 'authenticated', 'pjw-member-a2@example.test', timezone('utc', now()), '{"provider":"email"}'),
  (:'client_b', 'authenticated', 'authenticated', 'pjw-client-b@example.test', timezone('utc', now()), '{"provider":"email"}');
insert into public.organizations (id, name, slug)
values (:'org_a', 'PJW org A', 'pjw-org-a'), (:'org_b', 'PJW org B', 'pjw-org-b');
insert into public.organization_memberships (organization_id, user_id, role)
values (:'org_a', :'owner_a', 'client'), (:'org_a', :'member_a2', 'client'), (:'org_b', :'client_b', 'client');
insert into public.projects (id, organization_id, owner_user_id, name)
values (:'project_a', :'org_a', :'owner_a', 'PJW project A'),
  (:'project_a2', :'org_a', :'member_a2', 'PJW project A2'),
  (:'project_b', :'org_b', :'client_b', 'PJW project B'),
  (:'project_c', :'org_a', :'owner_a', 'PJW project C'),
  (:'project_d', :'org_a', :'owner_a', 'PJW project D');
insert into public.project_memberships (project_id, user_id, role)
values (:'project_a', :'owner_a', 'owner'), (:'project_a2', :'member_a2', 'owner'), (:'project_b', :'client_b', 'owner'),
  (:'project_c', :'owner_a', 'owner'), (:'project_d', :'owner_a', 'owner');
insert into public.jobs (id, organization_id, project_id, created_by, title, status, requested_service_kinds)
values (:'job_a1', :'org_a', :'project_a', :'owner_a', 'PJW job A1', 'ready_to_quote', '{manufacturing_quote}'),
  (:'job_a2', :'org_a', null, :'owner_a', 'PJW job A2', 'ready_to_quote', '{manufacturing_quote}');
insert into public.project_jobs (project_id, job_id, created_by) values (:'project_a', :'job_a1', :'owner_a');
-- api_create_client_draft needs current Founding Beta access for org A.
insert into private.founding_beta_enrollment_events
  (organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key)
select :'org_a', :'owner_a', 'grant', 'project_jobs write path fixture',
  notice ->> 'policyRevision', notice ->> 'termsPath', notice ->> 'privacyPath', 'pjw-grant'
from private.current_founding_beta_notice() notice;
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
select :'org_a', :'owner_a', notice ->> 'policyRevision', notice ->> 'termsPath', notice ->> 'privacyPath'
from private.current_founding_beta_notice() notice;

-- ---------------------------------------------------------------- catalog
select is(
  (select coalesce(array_agg(r || ':' || p order by r, p), '{}')
   from unnest(array['anon', 'authenticated']) r, unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
   where has_table_privilege(r, 'public.project_jobs', p)),
  '{}'::text[],
  'anon and authenticated hold no INSERT, UPDATE, DELETE or TRUNCATE on public.project_jobs');
select ok(has_table_privilege('authenticated', 'public.project_jobs', 'SELECT'),
  'authenticated keeps SELECT on public.project_jobs');
select ok(has_table_privilege('service_role', 'public.project_jobs', 'INSERT')
    and has_table_privilege('service_role', 'public.project_jobs', 'DELETE'),
  'service_role keeps INSERT and DELETE on public.project_jobs for the worker import tools');
select set_eq(
  $$ select polname::text || ':' || polcmd::text from pg_policy where polrelid = 'public.project_jobs'::regclass $$,
  $$ values ('project_jobs_select_accessible:r') $$,
  'the only policy on public.project_jobs is the SELECT policy');
select is_empty($$
  select p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?project_jobs\M'
    and not (p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres') $$,
  'every function that writes public.project_jobs is SECURITY DEFINER and owned by postgres');

-- ---------------------------------------------------------------- reads unchanged
select pg_temp.act_as(:'owner_a');
set local role authenticated;
select is((select count(*)::integer from public.project_jobs where project_id = :'project_a'), 1,
  'the project owner still reads the links of their project');
reset role;

-- ---------------------------------------------------------------- (1) direct writes
-- deny: role_boundary public.project_jobs
select pg_temp.act_as(:'owner_a');
set local role authenticated;
select throws_ok(format($$ insert into public.project_jobs (project_id, job_id, created_by) values (%L, %L, %L) $$,
    :'project_a', :'job_a2', :'owner_a'),
  '42501', null, 'the project owner cannot insert a project_jobs row directly');
select throws_ok(format($$ update public.project_jobs set created_at = created_at where project_id = %L $$, :'project_a'),
  '42501', null, 'the project owner cannot update a project_jobs row directly');
select throws_ok(format($$ delete from public.project_jobs where project_id = %L $$, :'project_a'),
  '42501', null, 'the project owner cannot delete a project_jobs row directly');
select throws_ok($$ truncate public.project_jobs $$,
  '42501', null, 'authenticated cannot truncate public.project_jobs');
reset role;
select pg_temp.act_as(:'member_a2');
set local role authenticated;
select throws_ok(format($$ insert into public.project_jobs (project_id, job_id, created_by) values (%L, %L, %L) $$,
    :'project_a2', :'job_a1', :'member_a2'),
  '42501', null, 'an org member cannot insert a project_jobs row into a project they own');
reset role;
select is((select count(*)::integer from public.project_jobs
           where (project_id, job_id) in ((:'project_a'::uuid, :'job_a2'::uuid), (:'project_a2'::uuid, :'job_a1'::uuid))), 0,
  'no direct insert left a project_jobs row behind');
select is((select count(*)::integer from public.project_jobs where project_id = :'project_a'), 1,
  'the denied update, delete and truncate left the existing link in place');

-- deny: anon public.project_jobs
select pg_temp.act_as(null, 'anon');
set local role anon;
select throws_ok(format($$ insert into public.project_jobs (project_id, job_id, created_by) values (%L, %L, %L) $$,
    :'project_a', :'job_a2', :'owner_a'),
  '42501', null, 'anon cannot insert a project_jobs row');
select throws_ok(format($$ delete from public.project_jobs where project_id = %L $$, :'project_a'),
  '42501', null, 'anon cannot delete a project_jobs row');
select is_empty($$ select id from public.project_jobs $$, 'anon reads no project_jobs rows');
reset role;
-- end deny

-- ---------------------------------------------------------------- (2) RPC path
select pg_temp.act_as(:'owner_a');
set local role authenticated;
select is(public.api_assign_job_to_project(:'job_a2', :'project_a'), :'job_a2'::uuid,
  'api_assign_job_to_project links a job the caller may edit into their project');
select is((select count(*)::integer from public.project_jobs where project_id = :'project_a' and job_id = :'job_a2'), 1,
  'the link written by api_assign_job_to_project is visible to the project owner');
select is(public.api_remove_job_from_project(:'job_a2', :'project_a'), :'job_a2'::uuid,
  'api_remove_job_from_project unlinks the job');
select is((select count(*)::integer from public.project_jobs where project_id = :'project_a' and job_id = :'job_a2'), 0,
  'the link removed by api_remove_job_from_project is gone');
select public.api_create_client_draft('PJW draft in project A', null, :'project_a') as pjw_draft_job \gset
select is((select count(*)::integer from public.project_jobs where project_id = :'project_a' and job_id = :'pjw_draft_job'), 1,
  'api_create_client_draft links the new draft into the project');

select public.api_assign_job_to_project(:'job_a2', :'project_c') as pjw_linked_c \gset
select is(public.api_dissolve_project(:'project_c'), :'project_c'::uuid,
  'api_dissolve_project dissolves a project that holds a link');
select public.api_assign_job_to_project(:'job_a2', :'project_d') as pjw_linked_d \gset
select is(public.api_delete_project(:'project_d'), :'project_d'::uuid,
  'api_delete_project deletes a project that holds a link');
reset role;
select is((select count(*)::integer from public.project_jobs where project_id in (:'project_c', :'project_d')), 0,
  'dissolving and deleting a project removed its links');
select is((select count(*)::integer from public.jobs where id = :'job_a2'), 1,
  'the unlinked job itself is kept');

-- ---------------------------------------------------------------- (3) other organization
-- deny: other_user public.project_jobs
select pg_temp.act_as(:'client_b');
set local role authenticated;
select is_empty(format($$ select id from public.project_jobs where project_id = %L $$, :'project_a'),
  'a client in another organization reads no links of project A');
select throws_ok(format($$ insert into public.project_jobs (project_id, job_id, created_by) values (%L, %L, %L) $$,
    :'project_b', :'job_a1', :'client_b'),
  '42501', null, 'a direct insert linking a job from another organization is denied');
select throws_ok(format($$ select public.api_assign_job_to_project(%L, %L) $$, :'job_a1', :'project_b'),
  'P0001', 'Parts can only be moved into projects from the same hidden workspace.',
  'api_assign_job_to_project refuses a job from another organization');
reset role;
-- end deny
select is((select count(*)::integer from public.project_jobs where job_id = :'job_a1' and project_id = :'project_b'), 0,
  'no link from project B to job A1 exists');

select * from finish();
rollback;
