-- public.project_jobs is written only through the SECURITY DEFINER RPC path
-- (20261029152002_ovd1018_restrict_project_jobs_writes.sql, defense in depth).
--
-- Proves, acting as the API roles:
--   (1) a direct INSERT, UPDATE, DELETE or TRUNCATE on project_jobs is denied
--       for authenticated and anon, and RLS alone would still refuse it if a
--       write grant came back; reads are unchanged;
--   (2) the RPCs still create and remove links for a job the caller may edit
--       (api_assign_job_to_project, api_create_client_draft,
--       api_remove_job_from_project, api_dissolve_project), the cascade under
--       api_delete_project and api_delete_archived_job still removes links, the
--       archive and unarchive RPCs still run on a linked job, and service_role
--       (worker import tools, seed) still writes directly;
--   (3) api_assign_job_to_project keeps a link inside the job's organization;
--   and that the rollback restores the prior grants and policy exactly.
--
-- fixtures/ holds byte copies of the migration and its rollback
-- (docs/migration-drafts/ovd-1018.rollback.sql), kept identical by
-- scripts/run-supabase-policy-tests.node-test.mjs. The migration copy is
-- installed inside this rolled back transaction only while authenticated still
-- holds INSERT (a database behind the migration); once applied the guard is
-- false and every assertion runs against the real schema. No assertion is
-- skipped in either case.
-- Synthetic records only; everything rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(49);

\set owner_a c1d20000-0000-4000-8000-000000000001
\set member_a2 c1d20000-0000-4000-8000-000000000002
\set editor_a c1d20000-0000-4000-8000-000000000003
\set client_b c1d20000-0000-4000-8000-000000000004
\set org_a c1d20000-0000-4000-8000-00000000000a
\set org_b c1d20000-0000-4000-8000-00000000000b
\set project_a c1d20000-0000-4000-8000-000000000020
\set project_b c1d20000-0000-4000-8000-000000000022
\set project_c c1d20000-0000-4000-8000-000000000023
\set project_d c1d20000-0000-4000-8000-000000000024
\set project_e c1d20000-0000-4000-8000-000000000025
\set job_a1 c1d20000-0000-4000-8000-000000000031
\set job_a2 c1d20000-0000-4000-8000-000000000032
\set job_a3 c1d20000-0000-4000-8000-000000000033

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_user::text, true),
    set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated;

-- PostgREST claims for a caller with no user (anon, service_role).
create function pg_temp.act_as_role(p_role text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', '', true),
    set_config('request.jwt.claims', json_build_object('role', p_role)::text, true);
$$;

-- Runs p_sql and returns 'rows:<n>' (rows affected) or 'error:<SQLSTATE>'.
create function pg_temp.pjw_outcome(p_sql text) returns text language plpgsql as $$
declare
  v_count bigint;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return 'rows:' || v_count;
exception when others then
  return 'error:' || sqlstate;
end;
$$;
grant execute on function pg_temp.pjw_outcome(text) to authenticated;

-- Write privileges on project_jobs held by p_roles, as role:privilege.
create function pg_temp.pjw_write_grants(p_roles text[]) returns text[] language sql stable as $$
  select coalesce(array_agg(r || ':' || p order by r, p), '{}')
  from unnest(p_roles) r, unnest(array['DELETE', 'INSERT', 'TRUNCATE', 'UPDATE']) p
  where has_table_privilege(r, 'public.project_jobs', p);
$$;

create function pg_temp.pjw_policies() returns text[] language sql stable as $$
  select coalesce(array_agg(polname || ':' || polcmd::text order by polname), '{}')
  from pg_policy where polrelid = 'public.project_jobs'::regclass;
$$;

create function pg_temp.pjw_manage_policy() returns text language sql stable as $$
  select polcmd::text || ' | ' || polroles::regrole[]::text || ' | ' || pg_get_expr(polqual, polrelid)
    || ' | ' || pg_get_expr(polwithcheck, polrelid)
  from pg_policy
  where polrelid = 'public.project_jobs'::regclass and polname = 'project_jobs_manage_editors';
$$;

-- Org A: owner A owns projects A, C, D and E and created jobs A1, A2 and A3;
-- editor A edits project A; member A2 is a plain org member. Org B: client B
-- owns project B.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values (:'owner_a', 'authenticated', 'authenticated', 'pjw-owner-a@example.test', timezone('utc', now()), '{"provider":"email"}'),
  (:'member_a2', 'authenticated', 'authenticated', 'pjw-member-a2@example.test', timezone('utc', now()), '{"provider":"email"}'),
  (:'editor_a', 'authenticated', 'authenticated', 'pjw-editor-a@example.test', timezone('utc', now()), '{"provider":"email"}'),
  (:'client_b', 'authenticated', 'authenticated', 'pjw-client-b@example.test', timezone('utc', now()), '{"provider":"email"}');
insert into public.organizations (id, name, slug)
values (:'org_a', 'PJW org A', 'pjw-org-a'), (:'org_b', 'PJW org B', 'pjw-org-b');
insert into public.organization_memberships (organization_id, user_id, role)
values (:'org_a', :'owner_a', 'client'), (:'org_a', :'member_a2', 'client'), (:'org_a', :'editor_a', 'client'),
  (:'org_b', :'client_b', 'client');
insert into public.projects (id, organization_id, owner_user_id, name)
values (:'project_a', :'org_a', :'owner_a', 'PJW project A'),
  (:'project_b', :'org_b', :'client_b', 'PJW project B'),
  (:'project_c', :'org_a', :'owner_a', 'PJW project C'),
  (:'project_d', :'org_a', :'owner_a', 'PJW project D'),
  (:'project_e', :'org_a', :'owner_a', 'PJW project E');
insert into public.project_memberships (project_id, user_id, role)
values (:'project_a', :'owner_a', 'owner'), (:'project_a', :'editor_a', 'editor'), (:'project_b', :'client_b', 'owner'),
  (:'project_c', :'owner_a', 'owner'), (:'project_d', :'owner_a', 'owner'), (:'project_e', :'owner_a', 'owner');
insert into public.jobs (id, organization_id, project_id, created_by, title, status, requested_service_kinds)
values (:'job_a1', :'org_a', :'project_a', :'owner_a', 'PJW job A1', 'ready_to_quote', '{manufacturing_quote}'),
  (:'job_a2', :'org_a', null, :'owner_a', 'PJW job A2', 'ready_to_quote', '{manufacturing_quote}'),
  (:'job_a3', :'org_a', :'project_e', :'owner_a', 'PJW job A3', 'ready_to_quote', '{manufacturing_quote}');
insert into public.project_jobs (project_id, job_id, created_by)
values (:'project_a', :'job_a1', :'owner_a'), (:'project_e', :'job_a3', :'owner_a');
-- api_create_client_draft needs current Founding Beta access for org A.
insert into private.founding_beta_enrollment_events
  (organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key)
select :'org_a', :'owner_a', 'grant', 'project_jobs write path fixture',
  notice ->> 'policyRevision', notice ->> 'termsPath', notice ->> 'privacyPath', 'pjw-grant'
from private.current_founding_beta_notice() notice;
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
select :'org_a', :'owner_a', notice ->> 'policyRevision', notice ->> 'termsPath', notice ->> 'privacyPath'
from private.current_founding_beta_notice() notice;

-- ---------------------------------------------------------------- install
-- Capture the prior ACL and policy first. After promotion the only way back to
-- them is the rollback, so in that mode they are read after the rollback inside
-- a savepoint and the round trip at the end compares the rollback with itself.
select has_table_privilege('authenticated', 'public.project_jobs', 'INSERT') as pjw_install_draft \gset
\if :pjw_install_draft
select relacl::text as pjw_prior_acl from pg_class where oid = 'public.project_jobs'::regclass \gset
select pg_temp.pjw_manage_policy() as pjw_prior_policy \gset
\ir fixtures/project_jobs_write_path.inc
\else
savepoint pjw_prior_capture;
\ir fixtures/project_jobs_write_path_rollback.inc
select relacl::text as pjw_prior_acl from pg_class where oid = 'public.project_jobs'::regclass \gset
select pg_temp.pjw_manage_policy() as pjw_prior_policy \gset
rollback to savepoint pjw_prior_capture;
\endif

-- ---------------------------------------------------------------- catalog
select is(pg_temp.pjw_write_grants(array['public', 'anon', 'authenticated']), '{}'::text[],
  'PUBLIC, anon and authenticated hold no INSERT, UPDATE, DELETE or TRUNCATE on public.project_jobs');
select ok(has_table_privilege('anon', 'public.project_jobs', 'SELECT')
    and has_table_privilege('authenticated', 'public.project_jobs', 'SELECT'),
  'SELECT on public.project_jobs is unchanged for anon and authenticated');
select is(pg_temp.pjw_write_grants(array['service_role']),
  array['service_role:DELETE', 'service_role:INSERT', 'service_role:TRUNCATE', 'service_role:UPDATE'],
  'service_role keeps its write grants on public.project_jobs');
select is(pg_temp.pjw_policies(), array['project_jobs_select_accessible:r'],
  'the only policy left on public.project_jobs is the SELECT policy');
select ok((select relrowsecurity from pg_class where oid = 'public.project_jobs'::regclass),
  'row level security stays enabled on public.project_jobs');

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
select pg_temp.act_as(:'editor_a');
set local role authenticated;
select throws_ok(format($$ insert into public.project_jobs (project_id, job_id, created_by) values (%L, %L, %L) $$,
    :'project_a', :'job_a2', :'editor_a'),
  '42501', null, 'a project editor cannot insert a project_jobs row directly');
reset role;
select pg_temp.act_as(:'member_a2');
set local role authenticated;
select public.api_create_project('PJW project A2', null) as project_a2 \gset
select throws_ok(format($$ insert into public.project_jobs (project_id, job_id, created_by) values (%L, %L, %L) $$,
    :'project_a2', :'job_a1', :'member_a2'),
  '42501', null, 'an org member cannot insert a project_jobs row into a project they own');
reset role;
-- The worker import tools and scripts/seed-dev.mjs write with service_role.
select pg_temp.act_as_role('service_role');
set local role service_role;
select lives_ok(format($$ insert into public.project_jobs (project_id, job_id, created_by) values (%L, %L, %L) $$,
    :'project_c', :'job_a2', :'owner_a'),
  'service_role still inserts a project_jobs row directly');
select lives_ok(format($$ delete from public.project_jobs where project_id = %L and job_id = %L $$, :'project_c', :'job_a2'),
  'service_role still deletes a project_jobs row directly');
reset role;
-- end deny
select is((select array_agg(project_id::text || '/' || job_id::text order by project_id) from public.project_jobs
           where project_id in (:'project_a', :'project_a2', :'project_c', :'project_e')),
  array[:'project_a' || '/' || :'job_a1', :'project_e' || '/' || :'job_a3'],
  'the refused writes changed no link and added none');

-- If a write grant ever came back, RLS alone must still refuse direct writes,
-- because no write policy is left. Outcomes are captured inside a savepoint and
-- asserted after it rolls back.
savepoint pjw_rls_only;
grant insert, update, delete on table public.project_jobs to authenticated;
select pg_temp.act_as(:'member_a2');
set local role authenticated;
select pg_temp.pjw_outcome(format($$ insert into public.project_jobs (project_id, job_id, created_by) values (%L, %L, %L) $$,
  :'project_a2', :'job_a1', :'member_a2')) as pjw_rls_insert \gset
reset role;
select pg_temp.act_as(:'owner_a');
set local role authenticated;
select pg_temp.pjw_outcome(format($$ update public.project_jobs set created_at = created_at where project_id = %L $$,
  :'project_a')) as pjw_rls_update \gset
select pg_temp.pjw_outcome(format($$ delete from public.project_jobs where project_id = %L $$, :'project_a')) as pjw_rls_delete \gset
reset role;
rollback to savepoint pjw_rls_only;
select is(:'pjw_rls_insert'::text, 'error:42501', 'with a write grant back, RLS alone still refuses a direct insert');
select is(:'pjw_rls_update'::text, 'rows:0', 'with a write grant back, RLS alone still lets no direct update through');
select is(:'pjw_rls_delete'::text, 'rows:0', 'with a write grant back, RLS alone still lets no direct delete through');

-- Reads are unchanged for project members.
select pg_temp.act_as(:'owner_a');
set local role authenticated;
select is((select count(*)::integer from public.project_jobs where project_id = :'project_a'), 1,
  'the project owner still reads the project links');
reset role;
select pg_temp.act_as(:'editor_a');
set local role authenticated;
select is((select count(*)::integer from public.project_jobs where project_id = :'project_a'), 1,
  'a project editor still reads the project links');
reset role;

-- deny: anon public.project_jobs
select pg_temp.act_as_role('anon');
set local role anon;
select throws_ok(format($$ insert into public.project_jobs (project_id, job_id, created_by) values (%L, %L, %L) $$,
    :'project_a', :'job_a2', :'owner_a'),
  '42501', null, 'anon cannot insert a project_jobs row');
select throws_ok(format($$ update public.project_jobs set created_at = created_at where project_id = %L $$, :'project_a'),
  '42501', null, 'anon cannot update a project_jobs row');
select throws_ok(format($$ delete from public.project_jobs where project_id = %L $$, :'project_a'),
  '42501', null, 'anon cannot delete a project_jobs row');
select throws_ok($$ truncate public.project_jobs $$, '42501', null, 'anon cannot truncate public.project_jobs');
select is_empty($$ select id from public.project_jobs $$, 'anon reads no project_jobs rows');
reset role;
-- end deny

-- ---------------------------------------------------------------- (2) RPC path
select pg_temp.act_as(:'owner_a');
set local role authenticated;
select is(public.api_assign_job_to_project(:'job_a2', :'project_a'), :'job_a2'::uuid,
  'api_assign_job_to_project links a job the caller may edit into their project');
select is((select count(*)::integer from public.project_jobs
           where project_id = :'project_a' and job_id = :'job_a2' and created_by = :'owner_a'), 1,
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

select is(public.api_archive_project(:'project_e'), :'project_e'::uuid,
  'api_archive_project archives a project that holds a link');
select is(public.api_unarchive_project(:'project_e'), :'project_e'::uuid,
  'api_unarchive_project restores it');
select is(public.api_archive_job(:'job_a3'), :'job_a3'::uuid, 'api_archive_job archives a linked job');
select is(public.api_unarchive_job(:'job_a3'), :'job_a3'::uuid, 'api_unarchive_job restores the linked job');
select is((select count(*)::integer from public.project_jobs where project_id = :'project_e' and job_id = :'job_a3'), 1,
  'archiving and restoring kept the link');
select is(public.api_archive_job(:'job_a3'), :'job_a3'::uuid, 'api_archive_job archives the linked job again');
select is(public.api_delete_archived_job(:'job_a3'), :'job_a3'::uuid,
  'api_delete_archived_job deletes the archived linked job');
reset role;
select is((select count(*)::integer from public.project_jobs
           where project_id in (:'project_c', :'project_d') or job_id = :'job_a3'), 0,
  'dissolving and deleting projects and deleting a job removed their links');
select is((select count(*)::integer from public.jobs where id = :'job_a2'), 1,
  'the job unlinked by dissolve and project delete is kept');

-- ---------------------------------------------------------------- (3) one organization per link
-- deny: other_user public.project_jobs
select pg_temp.act_as(:'client_b');
set local role authenticated;
select is_empty(format($$ select id from public.project_jobs where project_id = %L $$, :'project_a'),
  'a non-member reads no links of project A');
select throws_ok(format($$ insert into public.project_jobs (project_id, job_id, created_by) values (%L, %L, %L) $$,
    :'project_b', :'job_a1', :'client_b'),
  '42501', null, 'the owner of project B cannot insert a project_jobs row directly');
select throws_ok(format($$ select public.api_assign_job_to_project(%L, %L) $$, :'job_a1', :'project_b'),
  'P0001', 'Parts can only be moved into projects from the same hidden workspace.',
  'api_assign_job_to_project keeps a link inside the job''s organization');
reset role;
-- end deny
select is((select count(*)::integer from public.project_jobs where job_id = :'job_a1' and project_id = :'project_b'), 0,
  'project B holds no link to job A1');

-- ---------------------------------------------------------------- rollback round trip
-- fixtures/project_jobs_write_path_rollback.inc is a byte copy of
-- docs/migration-drafts/ovd-1018.rollback.sql. Each file is applied twice to
-- prove it replays.
\ir fixtures/project_jobs_write_path_rollback.inc
\ir fixtures/project_jobs_write_path_rollback.inc
select is(pg_temp.pjw_write_grants(array['anon', 'authenticated']),
  array['anon:DELETE', 'anon:INSERT', 'anon:TRUNCATE', 'anon:UPDATE',
    'authenticated:DELETE', 'authenticated:INSERT', 'authenticated:TRUNCATE', 'authenticated:UPDATE'],
  'after the rollback anon and authenticated hold INSERT, UPDATE, DELETE and TRUNCATE again');
select is((select relacl::text from pg_class where oid = 'public.project_jobs'::regclass), :'pjw_prior_acl',
  'the rollback restores the prior ACL of public.project_jobs, grantor included');
select is(pg_temp.pjw_manage_policy(), :'pjw_prior_policy',
  'the rollback restores the prior project_jobs_manage_editors policy');
\ir fixtures/project_jobs_write_path.inc
\ir fixtures/project_jobs_write_path.inc
select is(pg_temp.pjw_write_grants(array['public', 'anon', 'authenticated']), '{}'::text[],
  'reapplying the migration after the rollback removes the write grants again');
select is(pg_temp.pjw_policies(), array['project_jobs_select_accessible:r'],
  'reapplying the migration after the rollback leaves only the SELECT policy');

select * from finish();
rollback;
