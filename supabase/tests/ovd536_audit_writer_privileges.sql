begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(23);

-- Synthetic records exist only in this rolled-back transaction.
create temporary table ovd536_constants on commit drop as
select
  'public.log_audit_event(uuid,text,jsonb,uuid,uuid)'::text as writer_signature,
  'EXECUTE'::text as execute_privilege,
  '42501'::text as denied_sqlstate,
  'ovd536.forged'::text as forged_event,
  '00000000-0000-4000-8000-000000005360'::uuid as fixture_user_id,
  '00000000-0000-4000-8000-000000005361'::uuid as fixture_org_id,
  '00000000-0000-4000-8000-000000005362'::uuid as archived_job_id,
  '00000000-0000-4000-8000-000000005363'::uuid as deleted_job_id;

grant select on table pg_temp.ovd536_constants to anon, authenticated, service_role;

create temporary view ovd536_forge_sql as
select pg_catalog.format(
  'select public.log_audit_event(%L::uuid, %L, %L::jsonb, null, null)',
  c.fixture_org_id, c.forged_event, '{"forged":true}'
) as statement
from pg_temp.ovd536_constants c;

grant select on pg_temp.ovd536_forge_sql to anon, authenticated, service_role;

-- Catalog contract.
select ok(to_regprocedure(c.writer_signature) is not null,
  'the exact audit writer exists') from pg_temp.ovd536_constants c;
select ok((select prosecdef from pg_catalog.pg_proc
  where oid = to_regprocedure(c.writer_signature)),
  'the audit writer keeps its security-definer contract') from pg_temp.ovd536_constants c;
select ok(not exists (
    select 1 from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure_row.proacl, pg_catalog.acldefault('f', procedure_row.proowner))
    ) grant_row
    where procedure_row.oid = to_regprocedure(c.writer_signature)
      and grant_row.grantee = 0
      and grant_row.privilege_type = c.execute_privilege
  ), 'the audit writer has no PUBLIC EXECUTE grant') from pg_temp.ovd536_constants c;
select ok(not pg_catalog.has_function_privilege('anon', c.writer_signature, c.execute_privilege),
  'anonymous callers cannot execute the audit writer') from pg_temp.ovd536_constants c;
select ok(not pg_catalog.has_function_privilege('authenticated', c.writer_signature, c.execute_privilege),
  'signed-in callers cannot execute the audit writer') from pg_temp.ovd536_constants c;
select ok(pg_catalog.has_function_privilege('service_role', c.writer_signature, c.execute_privilege),
  'service callers keep audit writer access') from pg_temp.ovd536_constants c;
select ok((select pg_catalog.has_function_privilege(procedure_row.proowner,
    procedure_row.oid, c.execute_privilege)
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = to_regprocedure(c.writer_signature)),
  'the owner keeps audit writer access for definer callers') from pg_temp.ovd536_constants c;
select is((select count(*)::integer
    from pg_catalog.pg_roles role_row
    where (
        role_row.rolsuper
        or role_row.rolbypassrls
        or role_row.oid = (select relowner from pg_catalog.pg_class where oid = 'public.jobs'::regclass)
      )
      and pg_catalog.has_table_privilege(role_row.oid, 'public.jobs', 'DELETE')
      and not pg_catalog.has_function_privilege(role_row.oid, c.writer_signature, c.execute_privilege)),
  0, 'every role able to run the archive fallback keeps audit writer access')
from pg_temp.ovd536_constants c;

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
select c.fixture_user_id, 'authenticated', 'authenticated',
  'ovd536-audit-writer@example.test', now(), '{"provider":"email"}'::jsonb
from pg_temp.ovd536_constants c;
insert into public.organizations (id, name, slug)
select c.fixture_org_id, 'OVD-536 audit fixture', 'ovd536-audit-fixture'
from pg_temp.ovd536_constants c;
insert into public.jobs (id, organization_id, created_by, title, status)
select job_id, c.fixture_org_id, c.fixture_user_id, title, 'ready_to_quote'
from pg_temp.ovd536_constants c
cross join lateral (values
  (c.archived_job_id, 'OVD-536 archive fixture'),
  (c.deleted_job_id, 'OVD-536 fallback fixture')
) as fixture(job_id, title);

-- Direct forgery attempts must be denied before any audit row is written.
set local role anon;
select throws_ok(s.statement, c.denied_sqlstate, null,
  'anonymous direct audit writes are denied')
from pg_temp.ovd536_forge_sql s cross join pg_temp.ovd536_constants c;
reset role;

select set_config('request.jwt.claim.sub', c.fixture_user_id::text, true)
from pg_temp.ovd536_constants c;
set local role authenticated;
select throws_ok(s.statement, c.denied_sqlstate, null,
  'signed-in direct audit writes are denied')
from pg_temp.ovd536_forge_sql s cross join pg_temp.ovd536_constants c;
reset role;

select is((select count(*)::integer from public.audit_events event_row
    where event_row.organization_id = c.fixture_org_id
      and event_row.event_type = c.forged_event),
  0, 'denied callers left no forged audit rows') from pg_temp.ovd536_constants c;

-- A representative SECURITY DEFINER RPC still records its audit event.
set local role authenticated;
select lives_ok(pg_catalog.format('select public.api_archive_job(%L::uuid)', c.archived_job_id),
  'a signed-in owner can archive through the definer RPC')
from pg_temp.ovd536_constants c;
reset role;

select ok((select job.archived_at is not null from public.jobs job
    where job.id = c.archived_job_id),
  'the definer RPC archived the job') from pg_temp.ovd536_constants c;
select is((select count(*)::integer from public.audit_events event_row
    where event_row.job_id = c.archived_job_id
      and event_row.event_type = 'job.archived'),
  1, 'the definer RPC wrote exactly one audit row') from pg_temp.ovd536_constants c;
select is((select event_row.actor_user_id from public.audit_events event_row
    where event_row.job_id = c.archived_job_id
      and event_row.event_type = 'job.archived'),
  c.fixture_user_id, 'the definer audit row names the verified caller')
from pg_temp.ovd536_constants c;
select is((select event_row.organization_id from public.audit_events event_row
    where event_row.job_id = c.archived_job_id
      and event_row.event_type = 'job.archived'),
  c.fixture_org_id, 'the definer audit row keeps the job organization')
from pg_temp.ovd536_constants c;

select set_config('request.jwt.claim.sub', '', true);

-- service_role keeps the helper for a server-side caller with RLS bypass.
set local role service_role;
select lives_ok(s.statement, 'service callers can still write an audit event directly')
from pg_temp.ovd536_forge_sql s;
reset role;
select is((select count(*)::integer from public.audit_events event_row
    where event_row.organization_id = c.fixture_org_id
      and event_row.event_type = c.forged_event
      and event_row.actor_user_id is null),
  1, 'the service write records one row without a user actor')
from pg_temp.ovd536_constants c;

-- Reproduce the job-archive-fallback commit statements on the owner-side
-- session connection: audit inside the same transaction as the job delete.
update public.jobs job
set archived_at = timezone('utc', now())
from pg_temp.ovd536_constants c
where job.id = c.deleted_job_id;

select lives_ok(pg_catalog.format($fallback$
    select public.log_audit_event(
      %L::uuid,
      'job.deleted',
      jsonb_build_object('jobId', %L::uuid, 'deleteScope', 'single'),
      %L::uuid,
      null
    )
  $fallback$, c.fixture_org_id, c.deleted_job_id, c.deleted_job_id),
  'the archive fallback audit statement still runs on its owner-side connection')
from pg_temp.ovd536_constants c;
select lives_ok(pg_catalog.format('delete from public.jobs where id = %L::uuid', c.deleted_job_id),
  'the archive fallback job delete still runs in the same transaction')
from pg_temp.ovd536_constants c;
select ok(not exists (select 1 from public.jobs job where job.id = c.deleted_job_id),
  'the fallback fixture job is deleted') from pg_temp.ovd536_constants c;
select is((select count(*)::integer from public.audit_events event_row
    where event_row.organization_id = c.fixture_org_id
      and event_row.event_type = 'job.deleted'
      and event_row.payload ->> 'jobId' = c.deleted_job_id::text),
  1, 'the fallback deletion audit row survives the delete') from pg_temp.ovd536_constants c;
select is((select event_row.job_id from public.audit_events event_row
    where event_row.organization_id = c.fixture_org_id
      and event_row.event_type = 'job.deleted'
      and event_row.payload ->> 'jobId' = c.deleted_job_id::text),
  null::uuid, 'the deleted job reference is cleared while the payload keeps its ID')
from pg_temp.ovd536_constants c;

select * from finish();
rollback;
