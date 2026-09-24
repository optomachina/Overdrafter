begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(27);

select ok(to_regprocedure('public.api_claim_next_task(text)') is not null,
  'the exact task-claim RPC exists');
select ok(to_regprocedure('public.api_auto_approve_job_requirements(uuid)') is not null,
  'the exact auto-approval RPC exists');

select ok((select prosecdef from pg_catalog.pg_proc
  where oid = 'public.api_claim_next_task(text)'::regprocedure),
  'task claiming keeps its SECURITY DEFINER contract');
select ok((select prosecdef from pg_catalog.pg_proc
  where oid = 'public.api_auto_approve_job_requirements(uuid)'::regprocedure),
  'auto-approval keeps its SECURITY DEFINER contract');

select ok(pg_catalog.has_schema_privilege('anon', 'public', 'USAGE'),
  'anonymous callers retain access to the exposed schema');
select ok(pg_catalog.has_schema_privilege('authenticated', 'public', 'USAGE'),
  'signed-in callers retain access to the exposed schema');

select ok(not exists (
    select 1 from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure_row.proacl, pg_catalog.acldefault('f', procedure_row.proowner))
    ) grant_row
    where procedure_row.oid = 'public.api_claim_next_task(text)'::regprocedure
      and grant_row.grantee = 0
      and grant_row.privilege_type = 'EXECUTE'
  ), 'task claiming has no inherited PUBLIC EXECUTE grant');
select ok(not exists (
    select 1 from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure_row.proacl, pg_catalog.acldefault('f', procedure_row.proowner))
    ) grant_row
    where procedure_row.oid = 'public.api_auto_approve_job_requirements(uuid)'::regprocedure
      and grant_row.grantee = 0
      and grant_row.privilege_type = 'EXECUTE'
  ), 'auto-approval has no inherited PUBLIC EXECUTE grant');

select ok(not pg_catalog.has_function_privilege('anon', 'public.api_claim_next_task(text)', 'EXECUTE'),
  'anonymous callers cannot claim tasks through any grant');
select ok(not pg_catalog.has_function_privilege('authenticated', 'public.api_claim_next_task(text)', 'EXECUTE'),
  'signed-in callers cannot claim tasks through any grant');
select ok(not pg_catalog.has_function_privilege('anon', 'public.api_auto_approve_job_requirements(uuid)', 'EXECUTE'),
  'anonymous callers cannot auto-approve requirements through any grant');
select ok(not pg_catalog.has_function_privilege('authenticated', 'public.api_auto_approve_job_requirements(uuid)', 'EXECUTE'),
  'signed-in callers cannot auto-approve requirements through any grant');
select ok(pg_catalog.has_function_privilege('service_role', 'public.api_claim_next_task(text)', 'EXECUTE'),
  'the worker role retains task-claim access');
select ok(pg_catalog.has_function_privilege('service_role', 'public.api_auto_approve_job_requirements(uuid)', 'EXECUTE'),
  'the worker role retains auto-approval access');

set local role anon;
select throws_ok($$select * from public.api_claim_next_task('ovd535-denied')$$,
  '42501', null, 'anonymous task-claim attempts stop before changing the queue');
select throws_ok($$select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-000000005350')$$,
  '42501', null, 'anonymous auto-approval attempts stop before changing a job');
reset role;

set local role authenticated;
select throws_ok($$select * from public.api_claim_next_task('ovd535-denied')$$,
  '42501', null, 'signed-in task-claim attempts stop before changing the queue');
select throws_ok($$select public.api_auto_approve_job_requirements('00000000-0000-4000-8000-000000005350')$$,
  '42501', null, 'signed-in auto-approval attempts stop before changing a job');
reset role;

-- Only synthetic records are changed, and the enclosing transaction rolls back.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values (
  '00000000-0000-4000-8000-000000005351',
  'authenticated', 'authenticated', 'ovd535-worker-fixture@example.test', now(),
  '{"provider":"email"}'::jsonb
);
insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000005352',
  'OVD-535 worker RPC fixture', 'ovd535-worker-rpc-fixture'
);
insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds)
values (
  '00000000-0000-4000-8000-000000005353',
  '00000000-0000-4000-8000-000000005352',
  '00000000-0000-4000-8000-000000005351',
  'OVD-535 fixture job', 'uploaded', '{manufacturing_quote}'::text[]
);
insert into public.parts (id, job_id, organization_id, name, normalized_key, quantity)
values (
  '00000000-0000-4000-8000-000000005354',
  '00000000-0000-4000-8000-000000005353',
  '00000000-0000-4000-8000-000000005352',
  'OVD-535 fixture part', 'ovd535-fixture-part', 1
);
insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, quantity,
  quote_quantities, applicable_vendors, spec_snapshot
) values (
  '00000000-0000-4000-8000-000000005354',
  '00000000-0000-4000-8000-000000005352',
  '00000000-0000-4000-8000-000000005351',
  '6061-T6 Aluminum', 2, '{2}'::integer[],
  '{xometry}'::public.vendor_name[], '{}'::jsonb
);

set local role service_role;
select is(
  public.api_auto_approve_job_requirements('00000000-0000-4000-8000-000000005353'),
  1, 'the worker can actually auto-approve one synthetic part'
);
reset role;
select is((select status::text from public.jobs
  where id = '00000000-0000-4000-8000-000000005353'),
  'ready_to_quote', 'auto-approval advances only the fixture job');
select is((select quantity from public.parts
  where id = '00000000-0000-4000-8000-000000005354'),
  2, 'auto-approval persists the fixture requirement quantity');
select is((select count(*)::integer from public.audit_events
  where job_id = '00000000-0000-4000-8000-000000005353'
    and event_type = 'job.requirements_auto_approved'),
  1, 'auto-approval records one fixture audit event');
select is((select count(*)::integer from public.work_queue
  where job_id = '00000000-0000-4000-8000-000000005353'),
  0, 'auto-approval creates no queued work');

-- Refuse to claim anything but the fixture if the local database is not empty.
do $$
begin
  if exists (select 1 from public.work_queue
    where status = 'queued' and available_at <= now()) then
    raise exception 'OVD-535 claim fixture requires an empty ready queue';
  end if;
end;
$$;

insert into public.work_queue (
  id, organization_id, job_id, part_id, task_type, status,
  payload, available_at, created_at
) values (
  '00000000-0000-4000-8000-000000005355',
  '00000000-0000-4000-8000-000000005352',
  '00000000-0000-4000-8000-000000005353',
  '00000000-0000-4000-8000-000000005354',
  'generate_cad_preview', 'queued', '{}'::jsonb,
  now() - interval '1 minute', '-infinity'::timestamptz
);

set local role service_role;
select is((select id from public.api_claim_next_task('ovd535-worker')),
  '00000000-0000-4000-8000-000000005355'::uuid,
  'the worker actually claims the synthetic task first');
reset role;
select is((select status::text from public.work_queue
  where id = '00000000-0000-4000-8000-000000005355'),
  'running', 'the claimed fixture task enters running state');
select is((select locked_by from public.work_queue
  where id = '00000000-0000-4000-8000-000000005355'),
  'ovd535-worker', 'the claimed fixture task records the worker');
select is((select attempts from public.work_queue
  where id = '00000000-0000-4000-8000-000000005355'),
  1, 'the claimed fixture task increments its attempt count once');

select * from finish();
rollback;
