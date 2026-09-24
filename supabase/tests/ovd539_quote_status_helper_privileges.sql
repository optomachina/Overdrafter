begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(36);

-- These records exist only in this rolled-back, synthetic transaction.
create temporary table ovd539_constants on commit drop as
with identities as (
  select
    'public.sync_quote_request_status_for_run(uuid,text)'::text as request_signature,
    'public.sync_service_request_line_item_status(uuid)'::text as line_signature,
    'anon'::text as anonymous_role,
    'authenticated'::text as signed_in_role,
    'service_role'::text as server_role,
    'EXECUTE'::text as execute_privilege,
    'f'::"char" as function_acl_kind,
    '42501'::text as denied_sqlstate,
    '00000000-0000-4000-8000-000000005390'::uuid as fixture_user_id,
    '00000000-0000-4000-8000-000000005391'::uuid as fixture_org_id,
    '00000000-0000-4000-8000-000000005392'::uuid as fixture_job_id,
    '00000000-0000-4000-8000-000000005393'::uuid as fixture_part_id,
    '00000000-0000-4000-8000-000000005394'::uuid as fixture_line_id,
    '00000000-0000-4000-8000-000000005395'::uuid as fixture_request_id,
    '00000000-0000-4000-8000-000000005396'::uuid as fixture_run_id,
    '00000000-0000-4000-8000-000000005397'::uuid as fixture_result_id,
    'queued'::text as queued_status,
    'failed'::text as sentinel_request_status,
    'open'::text as sentinel_line_status,
    'instant_quote_received'::text as received_result_status,
    'received'::text as received_request_status,
    'running'::text as running_result_status,
    'requesting'::text as requesting_request_status,
    '('::text as signature_separator
)
select identities.*,
  pg_catalog.format('select %s(%L, null)',
    pg_catalog.split_part(request_signature, signature_separator, 1), fixture_run_id
  ) as direct_request_sql,
  pg_catalog.format('select %s(%L)',
    pg_catalog.split_part(line_signature, signature_separator, 1), fixture_line_id
  ) as direct_line_sql,
  pg_catalog.format('update public.vendor_quote_results set status = %L where id = %L',
    received_result_status, fixture_result_id
  ) as receive_result_sql,
  pg_catalog.format('update public.vendor_quote_results set status = %L where id = %L',
    running_result_status, fixture_result_id
  ) as run_result_sql
from identities;

grant select on table pg_temp.ovd539_constants to anon, authenticated, service_role;

select ok(to_regprocedure(c.request_signature) is not null,
  'the exact quote-request status helper exists') from pg_temp.ovd539_constants c;
select ok(to_regprocedure(c.line_signature) is not null,
  'the exact service-line status helper exists') from pg_temp.ovd539_constants c;
select ok((select prosecdef from pg_catalog.pg_proc
  where oid = to_regprocedure(c.request_signature)),
  'quote-request status retains its security-definer trigger contract')
from pg_temp.ovd539_constants c;
select ok((select prosecdef from pg_catalog.pg_proc
  where oid = to_regprocedure(c.line_signature)),
  'service-line status retains its security-definer trigger contract')
from pg_temp.ovd539_constants c;

select ok(not exists (
    select 1 from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure_row.proacl, pg_catalog.acldefault(c.function_acl_kind, procedure_row.proowner))
    ) grant_row
    where procedure_row.oid = to_regprocedure(c.request_signature)
      and grant_row.grantee = 0
      and grant_row.privilege_type = c.execute_privilege
  ), 'quote-request status has no inherited PUBLIC EXECUTE grant')
from pg_temp.ovd539_constants c;
select ok(not exists (
    select 1 from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure_row.proacl, pg_catalog.acldefault(c.function_acl_kind, procedure_row.proowner))
    ) grant_row
    where procedure_row.oid = to_regprocedure(c.line_signature)
      and grant_row.grantee = 0
      and grant_row.privilege_type = c.execute_privilege
  ), 'service-line status has no inherited PUBLIC EXECUTE grant')
from pg_temp.ovd539_constants c;

select ok(not pg_catalog.has_function_privilege(c.anonymous_role::name,
    c.request_signature, c.execute_privilege),
  'anonymous callers cannot execute quote-request status') from pg_temp.ovd539_constants c;
select ok(not pg_catalog.has_function_privilege(c.signed_in_role::name,
    c.request_signature, c.execute_privilege),
  'signed-in callers cannot execute quote-request status') from pg_temp.ovd539_constants c;
select ok(pg_catalog.has_function_privilege(c.server_role::name,
    c.request_signature, c.execute_privilege),
  'service callers retain direct quote-request status access') from pg_temp.ovd539_constants c;
select ok(not pg_catalog.has_function_privilege(c.anonymous_role::name,
    c.line_signature, c.execute_privilege),
  'anonymous callers cannot execute service-line status') from pg_temp.ovd539_constants c;
select ok(not pg_catalog.has_function_privilege(c.signed_in_role::name,
    c.line_signature, c.execute_privilege),
  'signed-in callers cannot execute service-line status') from pg_temp.ovd539_constants c;
select ok(pg_catalog.has_function_privilege(c.server_role::name,
    c.line_signature, c.execute_privilege),
  'service callers retain direct service-line status access') from pg_temp.ovd539_constants c;
select ok((select pg_catalog.has_function_privilege(procedure_row.proowner,
    procedure_row.oid, c.execute_privilege)
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = to_regprocedure(c.request_signature)),
  'the owner retains direct quote-request status access') from pg_temp.ovd539_constants c;
select ok((select pg_catalog.has_function_privilege(procedure_row.proowner,
    procedure_row.oid, c.execute_privilege)
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = to_regprocedure(c.line_signature)),
  'the owner retains direct service-line status access') from pg_temp.ovd539_constants c;

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
select c.fixture_user_id, c.signed_in_role, c.signed_in_role,
  'ovd539-quote-status@example.test', now(), '{"provider":"email"}'::jsonb
from pg_temp.ovd539_constants c;
insert into public.organizations (id, name, slug)
select c.fixture_org_id, 'OVD-539 quote-status fixture', 'ovd539-quote-status-fixture'
from pg_temp.ovd539_constants c;
insert into public.jobs (id, organization_id, created_by, title, status)
select c.fixture_job_id, c.fixture_org_id, c.fixture_user_id,
  'OVD-539 fixture job', 'ready_to_quote'
from pg_temp.ovd539_constants c;
insert into public.parts (id, job_id, organization_id, name, normalized_key)
select c.fixture_part_id, c.fixture_job_id, c.fixture_org_id,
  'OVD-539 fixture part', 'ovd539-fixture-part'
from pg_temp.ovd539_constants c;
insert into public.service_request_line_items (
  id, organization_id, job_id, service_type, scope
)
select c.fixture_line_id, c.fixture_org_id, c.fixture_job_id,
  'manufacturing_quote', 'part'
from pg_temp.ovd539_constants c;
insert into public.quote_requests (
  id, organization_id, job_id, requested_by, service_request_line_item_id
)
select c.fixture_request_id, c.fixture_org_id, c.fixture_job_id,
  c.fixture_user_id, c.fixture_line_id
from pg_temp.ovd539_constants c;
insert into public.quote_runs (
  id, quote_request_id, job_id, organization_id, initiated_by
)
select c.fixture_run_id, c.fixture_request_id, c.fixture_job_id,
  c.fixture_org_id, c.fixture_user_id
from pg_temp.ovd539_constants c;
insert into public.vendor_quote_results (
  id, quote_run_id, part_id, organization_id, vendor, status
)
select c.fixture_result_id, c.fixture_run_id, c.fixture_part_id,
  c.fixture_org_id, 'xometry', c.queued_status::public.vendor_status
from pg_temp.ovd539_constants c;

select is((select request_row.status::text from public.quote_requests request_row
  where request_row.id = c.fixture_request_id), c.queued_status,
  'vendor result insert leaves the synthetic request queued') from pg_temp.ovd539_constants c;
select is((select line_item.status from public.service_request_line_items line_item
  where line_item.id = c.fixture_line_id), c.queued_status,
  'request insertion synchronizes the synthetic line item') from pg_temp.ovd539_constants c;

set local role service_role;
select lives_ok(c.receive_result_sql,
  'service-side result change can still fire the quote-status trigger')
from pg_temp.ovd539_constants c;
reset role;
select is((select request_row.status::text from public.quote_requests request_row
  where request_row.id = c.fixture_request_id), c.received_request_status,
  'vendor result trigger marks the request received') from pg_temp.ovd539_constants c;
select is((select line_item.status from public.service_request_line_items line_item
  where line_item.id = c.fixture_line_id), c.received_request_status,
  'nested request trigger marks the line item received') from pg_temp.ovd539_constants c;
select ok((select request_row.received_at is not null from public.quote_requests request_row
  where request_row.id = c.fixture_request_id),
  'the trigger preserves receipt timing') from pg_temp.ovd539_constants c;

-- A direct call would recompute a failed request and overwrite an open line item.
-- Each role must be denied before that side effect occurs.
update public.quote_requests request_row
set status = c.sentinel_request_status::public.quote_request_status
from pg_temp.ovd539_constants c
where request_row.id = c.fixture_request_id;
update public.service_request_line_items line_item
set status = c.sentinel_line_status
from pg_temp.ovd539_constants c
where line_item.id = c.fixture_line_id;

set local role anon;
select throws_ok(c.direct_line_sql, c.denied_sqlstate, null,
  'anonymous direct line-item synchronization is denied') from pg_temp.ovd539_constants c;
select throws_ok(c.direct_request_sql, c.denied_sqlstate, null,
  'anonymous direct quote-request synchronization is denied') from pg_temp.ovd539_constants c;
reset role;
select is((select request_row.status::text from public.quote_requests request_row
  where request_row.id = c.fixture_request_id), c.sentinel_request_status,
  'anonymous calls cannot alter the request') from pg_temp.ovd539_constants c;
select is((select line_item.status from public.service_request_line_items line_item
  where line_item.id = c.fixture_line_id), c.sentinel_line_status,
  'anonymous calls cannot alter the line item') from pg_temp.ovd539_constants c;

-- Restore the sentinel after the deliberately failing pre-fix attack so each
-- caller is tested against the same independent starting state.
update public.quote_requests request_row
set status = c.sentinel_request_status::public.quote_request_status
from pg_temp.ovd539_constants c
where request_row.id = c.fixture_request_id;
update public.service_request_line_items line_item
set status = c.sentinel_line_status
from pg_temp.ovd539_constants c
where line_item.id = c.fixture_line_id;

set local role authenticated;
select throws_ok(c.direct_line_sql, c.denied_sqlstate, null,
  'signed-in direct line-item synchronization is denied') from pg_temp.ovd539_constants c;
select throws_ok(c.direct_request_sql, c.denied_sqlstate, null,
  'signed-in direct quote-request synchronization is denied') from pg_temp.ovd539_constants c;
reset role;
select is((select request_row.status::text from public.quote_requests request_row
  where request_row.id = c.fixture_request_id), c.sentinel_request_status,
  'signed-in calls cannot alter the request') from pg_temp.ovd539_constants c;
select is((select line_item.status from public.service_request_line_items line_item
  where line_item.id = c.fixture_line_id), c.sentinel_line_status,
  'signed-in calls cannot alter the line item') from pg_temp.ovd539_constants c;

update public.quote_requests request_row
set status = c.sentinel_request_status::public.quote_request_status
from pg_temp.ovd539_constants c
where request_row.id = c.fixture_request_id;
update public.service_request_line_items line_item
set status = c.sentinel_line_status
from pg_temp.ovd539_constants c
where line_item.id = c.fixture_line_id;

set local role service_role;
select lives_ok(c.direct_line_sql,
  'service direct line-item synchronization remains available') from pg_temp.ovd539_constants c;
select is((select line_item.status from public.service_request_line_items line_item
  where line_item.id = c.fixture_line_id), c.sentinel_request_status,
  'service direct line-item synchronization applies the request status')
from pg_temp.ovd539_constants c;
select lives_ok(c.direct_request_sql,
  'service direct quote-request synchronization remains available') from pg_temp.ovd539_constants c;
reset role;
select is((select request_row.status::text from public.quote_requests request_row
  where request_row.id = c.fixture_request_id), c.received_request_status,
  'service direct quote-request synchronization applies the vendor result')
from pg_temp.ovd539_constants c;
select is((select line_item.status from public.service_request_line_items line_item
  where line_item.id = c.fixture_line_id), c.received_request_status,
  'service direct quote-request synchronization cascades to the line item')
from pg_temp.ovd539_constants c;

set local role service_role;
select lives_ok(c.run_result_sql,
  'service-side result progression still fires both status triggers')
from pg_temp.ovd539_constants c;
reset role;
select is((select request_row.status::text from public.quote_requests request_row
  where request_row.id = c.fixture_request_id), c.requesting_request_status,
  'vendor running state updates the request through the trigger') from pg_temp.ovd539_constants c;
select is((select line_item.status from public.service_request_line_items line_item
  where line_item.id = c.fixture_line_id), c.requesting_request_status,
  'vendor running state updates the line item through nested trigger')
from pg_temp.ovd539_constants c;

select * from finish();
rollback;
