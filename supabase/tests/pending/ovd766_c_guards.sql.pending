-- OVD-766 (split child c) / OVD-769: pending guard test for
-- public.api_reconcile_job_parts after docs/migration-drafts/ovd-766-c.sql
-- (option b: authenticated keeps EXECUTE; the body requires verified auth and
-- user_can_edit_job on the target job). Promote it to
-- supabase/tests/ovd766_c_guards.sql in the PR that applies the draft.
-- Plain SQL, no psql variables. Synthetic records only; everything rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(14);

-- Org A: verified editor uE and unverified member uU (no confirmed email,
-- email provider). Org B: verified client uX, who is not a member of org A.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values
  ('76c00000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'ovd766-c-editor@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb),
  ('76c00000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'ovd766-c-unverified@example.test', null, '{"provider":"email"}'::jsonb),
  ('76c00000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
    'ovd766-c-outsider@example.test', timezone('utc', now()), '{"provider":"email"}'::jsonb);
insert into public.organizations (id, name, slug) values
  ('76c00000-0000-4000-8000-00000000000a', 'OVD-766 c org A', 'ovd766-c-org-a'),
  ('76c00000-0000-4000-8000-00000000000b', 'OVD-766 c org B', 'ovd766-c-org-b');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('76c00000-0000-4000-8000-00000000000a', '76c00000-0000-4000-8000-000000000001', 'client'),
  ('76c00000-0000-4000-8000-00000000000a', '76c00000-0000-4000-8000-000000000002', 'client'),
  ('76c00000-0000-4000-8000-00000000000b', '76c00000-0000-4000-8000-000000000003', 'client');
insert into public.pricing_policies (id, organization_id, version, markup_percent, currency_minor_unit)
values ('76c00000-0000-4000-8000-000000000010', '76c00000-0000-4000-8000-00000000000a', 'ovd766-c', 20, 0.01);
insert into public.jobs (id, organization_id, created_by, title, status, active_pricing_policy_id, requested_service_kinds)
values ('76c00000-0000-4000-8000-000000000011', '76c00000-0000-4000-8000-00000000000a',
  '76c00000-0000-4000-8000-000000000001', 'OVD-766 c reconcile', 'ready_to_quote',
  '76c00000-0000-4000-8000-000000000010', '{manufacturing_quote}');
-- A CAD file with no part yet and a stale part with no file: any reconcile
-- that runs inserts 'ovd766-c-new' and deletes 'ovd766-c-stale'.
insert into public.job_files (id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind, mime_type, size_bytes)
values ('76c00000-0000-4000-8000-000000000012', '76c00000-0000-4000-8000-000000000011',
  '76c00000-0000-4000-8000-00000000000a', '76c00000-0000-4000-8000-000000000001', 'job-files',
  'ovd766-c/new.step', 'new.step', 'ovd766-c-new', 'cad', 'application/step', 100);
insert into public.parts (id, job_id, organization_id, name, normalized_key, quantity)
values ('76c00000-0000-4000-8000-000000000013', '76c00000-0000-4000-8000-000000000011',
  '76c00000-0000-4000-8000-00000000000a', 'Stale part', 'ovd766-c-stale', 1);

create function pg_temp.act_as(p_user uuid, p_role text) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true),
    pg_catalog.set_config('request.jwt.claims',
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('sub', p_user, 'role', p_role))::text, true);
$$;

-- Job A's parts, file matches and audit trail; read as postgres.
create function pg_temp.job_digest() returns text language sql as $$
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(snapshot.row_text, E'\n' order by snapshot.row_text), ''))
  from (
    select 'parts ' || to_jsonb(r)::text from public.parts r
    where r.job_id = '76c00000-0000-4000-8000-000000000011'
    union all select 'job_files ' || to_jsonb(r)::text from public.job_files r
    where r.job_id = '76c00000-0000-4000-8000-000000000011'
    union all select 'audit ' || to_jsonb(r)::text from public.audit_events r
    where r.job_id = '76c00000-0000-4000-8000-000000000011'
  ) as snapshot(row_text);
$$;

create temporary table baseline on commit drop as select pg_temp.job_digest() as digest;

-- 1-2. Definition shape.
select ok((select p.prosecdef from pg_catalog.pg_proc p
  where p.oid = 'public.api_reconcile_job_parts(uuid)'::regprocedure),
  'api_reconcile_job_parts is SECURITY DEFINER');
select is((select p.proconfig from pg_catalog.pg_proc p
  where p.oid = 'public.api_reconcile_job_parts(uuid)'::regprocedure),
  array['search_path=""']::text[],
  'api_reconcile_job_parts pins search_path to empty');

-- 3-5. Grants: PUBLIC and anon revoked, authenticated kept.
select ok(not exists (
    select 1
    from pg_catalog.pg_proc p,
      pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    where p.oid = 'public.api_reconcile_job_parts(uuid)'::regprocedure
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'PUBLIC has no EXECUTE on api_reconcile_job_parts');
select ok(not has_function_privilege('anon', 'public.api_reconcile_job_parts(uuid)', 'EXECUTE'),
  'anon cannot execute api_reconcile_job_parts');
select ok(has_function_privilege('authenticated', 'public.api_reconcile_job_parts(uuid)', 'EXECUTE'),
  'authenticated can execute api_reconcile_job_parts');

-- 6. anon is denied before the body runs.
select pg_temp.act_as(null, 'anon');
set local role anon;
select throws_ok('select public.api_reconcile_job_parts(''76c00000-0000-4000-8000-000000000011''::uuid)',
  '42501', 'permission denied for function api_reconcile_job_parts',
  'anon: api_reconcile_job_parts is permission denied');
reset role;

-- 7. A verified user who is not a member of org A fails user_can_edit_job.
select pg_temp.act_as('76c00000-0000-4000-8000-000000000003', 'authenticated');
set local role authenticated;
select throws_ok('select public.api_reconcile_job_parts(''76c00000-0000-4000-8000-000000000011''::uuid)',
  'P0001', 'You do not have access to job 76c00000-0000-4000-8000-000000000011',
  'non-member: api_reconcile_job_parts refuses org A''s job');
reset role;

-- 8. An unverified org A member fails require_verified_auth.
select pg_temp.act_as('76c00000-0000-4000-8000-000000000002', 'authenticated');
set local role authenticated;
select throws_ok('select public.api_reconcile_job_parts(''76c00000-0000-4000-8000-000000000011''::uuid)',
  'P0001', 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.',
  'unverified org A member: api_reconcile_job_parts requires verified auth');
reset role;

-- 9. The editor gets the same answer for a missing job as for a forbidden one.
select pg_temp.act_as('76c00000-0000-4000-8000-000000000001', 'authenticated');
set local role authenticated;
select throws_ok('select public.api_reconcile_job_parts(''76c00000-0000-4000-8000-0000000000ff''::uuid)',
  'P0001', 'You do not have access to job 76c00000-0000-4000-8000-0000000000ff',
  'editor: a missing job is refused like a forbidden one');
reset role;

-- 10-11. No denied call changed job A.
select is(pg_temp.job_digest(), (select digest from baseline),
  'denied calls leave job A parts, file matches and audit events unchanged');
select is((select array_agg(normalized_key order by normalized_key) from public.parts
    where job_id = '76c00000-0000-4000-8000-000000000011'),
  array['ovd766-c-stale']::text[], 'after denials job A still has only its stale part');

-- 12. The verified org A editor reconciles the job.
select pg_temp.act_as('76c00000-0000-4000-8000-000000000001', 'authenticated');
set local role authenticated;
select is(public.api_reconcile_job_parts('76c00000-0000-4000-8000-000000000011'::uuid),
  '{"totalParts": 1, "matchedPairs": 0, "missingDrawings": 1, "missingCad": 0}'::jsonb,
  'verified org A editor reconciles the job');
reset role;

-- 13-14. The reconcile replaced the stale part and logged one audit event.
select is((select array_agg(normalized_key order by normalized_key) from public.parts
    where job_id = '76c00000-0000-4000-8000-000000000011'),
  array['ovd766-c-new']::text[], 'reconcile inserted the file''s part and deleted the stale part');
select is((select count(*)::integer from public.audit_events
    where job_id = '76c00000-0000-4000-8000-000000000011' and event_type = 'job.parts_reconciled'),
  1, 'reconcile logged one job.parts_reconciled audit event');

select * from finish();
rollback;
