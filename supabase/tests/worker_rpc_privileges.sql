begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(27);

-- Keep every exact identity in one row so ACL and mutation checks use the same
-- signatures and fixture IDs. The temporary row disappears at ROLLBACK.
create temporary table ovd535_constants on commit drop as
with identities as (
  select
    'public.api_claim_next_task(text)'::text as claim_signature,
    'public.api_auto_approve_job_requirements(uuid)'::text as approval_signature,
    'anon'::text as anon_role,
    'authenticated'::text as signed_in_role,
    'service_role'::text as worker_role,
    'public'::text as exposed_schema,
    'USAGE'::text as usage_privilege,
    'EXECUTE'::text as execute_privilege,
    'f'::"char" as function_acl_kind,
    '42501'::text as denied_sqlstate,
    'ovd535-denied'::text as denied_worker_name,
    'ovd535-worker'::text as worker_name,
    '00000000-0000-4000-8000-000000005350'::uuid as absent_job_id,
    '00000000-0000-4000-8000-000000005351'::uuid as fixture_user_id,
    '00000000-0000-4000-8000-000000005352'::uuid as fixture_org_id,
    '00000000-0000-4000-8000-000000005353'::uuid as fixture_job_id,
    '00000000-0000-4000-8000-000000005354'::uuid as fixture_part_id,
    '00000000-0000-4000-8000-000000005355'::uuid as fixture_task_id,
    'queued'::text as queued_status,
    '{}'::jsonb as empty_json,
    '('::text as signature_separator
)
select identities.*,
  pg_catalog.format('select * from %s(%L)',
    pg_catalog.split_part(claim_signature, signature_separator, 1), denied_worker_name
  ) as denied_claim_sql,
  pg_catalog.format('select %s(%L)',
    pg_catalog.split_part(approval_signature, signature_separator, 1), absent_job_id
  ) as denied_approval_sql
from identities;

grant select on table pg_temp.ovd535_constants to anon, authenticated, service_role;

select ok(to_regprocedure(c.claim_signature) is not null,
  'the exact task-claim RPC exists') from pg_temp.ovd535_constants c;
select ok(to_regprocedure(c.approval_signature) is not null,
  'the exact auto-approval RPC exists') from pg_temp.ovd535_constants c;

select ok((select prosecdef from pg_catalog.pg_proc
  where oid = to_regprocedure(c.claim_signature)),
  'task claiming keeps its SECURITY DEFINER contract') from pg_temp.ovd535_constants c;
select ok((select prosecdef from pg_catalog.pg_proc
  where oid = to_regprocedure(c.approval_signature)),
  'auto-approval keeps its SECURITY DEFINER contract') from pg_temp.ovd535_constants c;

select ok(pg_catalog.has_schema_privilege(c.anon_role::name, c.exposed_schema::name, c.usage_privilege),
  'anonymous callers retain access to the exposed schema') from pg_temp.ovd535_constants c;
select ok(pg_catalog.has_schema_privilege(c.signed_in_role::name, c.exposed_schema::name, c.usage_privilege),
  'signed-in callers retain access to the exposed schema') from pg_temp.ovd535_constants c;

select ok(not exists (
    select 1 from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure_row.proacl, pg_catalog.acldefault(c.function_acl_kind, procedure_row.proowner))
    ) grant_row
    where procedure_row.oid = to_regprocedure(c.claim_signature)
      and grant_row.grantee = 0
      and grant_row.privilege_type = c.execute_privilege
  ), 'task claiming has no inherited PUBLIC EXECUTE grant') from pg_temp.ovd535_constants c;
select ok(not exists (
    select 1 from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure_row.proacl, pg_catalog.acldefault(c.function_acl_kind, procedure_row.proowner))
    ) grant_row
    where procedure_row.oid = to_regprocedure(c.approval_signature)
      and grant_row.grantee = 0
      and grant_row.privilege_type = c.execute_privilege
  ), 'auto-approval has no inherited PUBLIC EXECUTE grant') from pg_temp.ovd535_constants c;

select ok(not pg_catalog.has_function_privilege(c.anon_role::name, c.claim_signature, c.execute_privilege),
  'anonymous callers cannot claim tasks through any grant') from pg_temp.ovd535_constants c;
select ok(not pg_catalog.has_function_privilege(c.signed_in_role::name, c.claim_signature, c.execute_privilege),
  'signed-in callers cannot claim tasks through any grant') from pg_temp.ovd535_constants c;
select ok(not pg_catalog.has_function_privilege(c.anon_role::name, c.approval_signature, c.execute_privilege),
  'anonymous callers cannot auto-approve requirements through any grant') from pg_temp.ovd535_constants c;
select ok(not pg_catalog.has_function_privilege(c.signed_in_role::name, c.approval_signature, c.execute_privilege),
  'signed-in callers cannot auto-approve requirements through any grant') from pg_temp.ovd535_constants c;
select ok(pg_catalog.has_function_privilege(c.worker_role::name, c.claim_signature, c.execute_privilege),
  'the worker role retains task-claim access') from pg_temp.ovd535_constants c;
select ok(pg_catalog.has_function_privilege(c.worker_role::name, c.approval_signature, c.execute_privilege),
  'the worker role retains auto-approval access') from pg_temp.ovd535_constants c;

set local role anon;
select throws_ok(c.denied_claim_sql,
  c.denied_sqlstate, null, 'anonymous task-claim attempts stop before changing the queue')
from pg_temp.ovd535_constants c;
select throws_ok(c.denied_approval_sql,
  c.denied_sqlstate, null, 'anonymous auto-approval attempts stop before changing a job')
from pg_temp.ovd535_constants c;
reset role;

set local role authenticated;
select throws_ok(c.denied_claim_sql,
  c.denied_sqlstate, null, 'signed-in task-claim attempts stop before changing the queue')
from pg_temp.ovd535_constants c;
select throws_ok(c.denied_approval_sql,
  c.denied_sqlstate, null, 'signed-in auto-approval attempts stop before changing a job')
from pg_temp.ovd535_constants c;
reset role;

-- Only synthetic records are changed, and the enclosing transaction rolls back.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
select c.fixture_user_id,
  c.signed_in_role, c.signed_in_role, 'ovd535-worker-fixture@example.test', now(),
  '{"provider":"email"}'::jsonb
from pg_temp.ovd535_constants c;
insert into public.organizations (id, name, slug)
select c.fixture_org_id,
  'OVD-535 worker RPC fixture', 'ovd535-worker-rpc-fixture'
from pg_temp.ovd535_constants c;
insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds)
select c.fixture_job_id, c.fixture_org_id, c.fixture_user_id,
  'OVD-535 fixture job', 'uploaded', '{manufacturing_quote}'::text[]
from pg_temp.ovd535_constants c;
insert into public.parts (id, job_id, organization_id, name, normalized_key, quantity)
select c.fixture_part_id, c.fixture_job_id, c.fixture_org_id,
  'OVD-535 fixture part', 'ovd535-fixture-part', 1
from pg_temp.ovd535_constants c;
insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, quantity,
  quote_quantities, applicable_vendors, spec_snapshot
) select c.fixture_part_id, c.fixture_org_id, c.fixture_user_id,
  '6061-T6 Aluminum', 2, '{2}'::integer[],
  '{xometry}'::public.vendor_name[], c.empty_json
from pg_temp.ovd535_constants c;

set local role service_role;
select is(
  public.api_auto_approve_job_requirements(c.fixture_job_id),
  1, 'the worker can actually auto-approve one synthetic part'
) from pg_temp.ovd535_constants c;
reset role;
select is((select status::text from public.jobs
  where id = c.fixture_job_id),
  'ready_to_quote', 'auto-approval advances only the fixture job') from pg_temp.ovd535_constants c;
select is((select quantity from public.parts
  where id = c.fixture_part_id),
  2, 'auto-approval persists the fixture requirement quantity') from pg_temp.ovd535_constants c;
select is((select count(*)::integer from public.audit_events
  where job_id = c.fixture_job_id
    and event_type = 'job.requirements_auto_approved'),
  1, 'auto-approval records one fixture audit event') from pg_temp.ovd535_constants c;
select is((select count(*)::integer from public.work_queue
  where job_id = c.fixture_job_id),
  0, 'auto-approval creates no queued work') from pg_temp.ovd535_constants c;

-- Refuse to claim anything but the fixture if the local database is not empty.
do $$
begin
  if exists (select 1 from public.work_queue
    where status = (select queued_status::public.queue_task_status
      from pg_temp.ovd535_constants) and available_at <= now()) then
    raise exception 'OVD-535 claim fixture requires an empty ready queue';
  end if;
end;
$$;

insert into public.work_queue (
  id, organization_id, job_id, part_id, task_type, status,
  payload, available_at, created_at
) select c.fixture_task_id, c.fixture_org_id, c.fixture_job_id, c.fixture_part_id,
  'generate_cad_preview', c.queued_status::public.queue_task_status, c.empty_json,
  now() - interval '1 minute', '-infinity'::timestamptz
from pg_temp.ovd535_constants c;

set local role service_role;
select is((select id from public.api_claim_next_task(c.worker_name)),
  c.fixture_task_id,
  'the worker actually claims the synthetic task first') from pg_temp.ovd535_constants c;
reset role;
select is((select status::text from public.work_queue
  where id = c.fixture_task_id),
  'running', 'the claimed fixture task enters running state') from pg_temp.ovd535_constants c;
select is((select locked_by from public.work_queue
  where id = c.fixture_task_id),
  c.worker_name, 'the claimed fixture task records the worker') from pg_temp.ovd535_constants c;
select is((select attempts from public.work_queue
  where id = c.fixture_task_id),
  1, 'the claimed fixture task increments its attempt count once') from pg_temp.ovd535_constants c;

select * from finish();
rollback;
