begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

select ok(
  pg_catalog.to_regprocedure('public.build_manufacturing_quote_service_detail(uuid)') is not null,
  'the exact manufacturing-quote service-detail helper exists'
);
select ok(
  (select procedure_row.prosecdef
   from pg_catalog.pg_proc procedure_row
   where procedure_row.oid = 'public.build_manufacturing_quote_service_detail(uuid)'::pg_catalog.regprocedure),
  'the helper retains its security-definer contract for guarded parents'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure_row.proacl, pg_catalog.acldefault('f', procedure_row.proowner))
    ) function_acl
    where procedure_row.oid = 'public.build_manufacturing_quote_service_detail(uuid)'::pg_catalog.regprocedure
      and function_acl.grantee = 0
      and function_acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no inherited execute grant on the helper'
);
select ok(
  not pg_catalog.has_function_privilege(
    'anon', 'public.build_manufacturing_quote_service_detail(uuid)', 'EXECUTE'
  ),
  'anonymous callers cannot execute the helper'
);
select ok(
  not pg_catalog.has_function_privilege(
    'authenticated', 'public.build_manufacturing_quote_service_detail(uuid)', 'EXECUTE'
  ),
  'authenticated callers cannot execute the helper, including for their own job'
);
select ok(
  pg_catalog.has_function_privilege(
    'service_role', 'public.build_manufacturing_quote_service_detail(uuid)', 'EXECUTE'
  ),
  'service-role internal callers retain execute access'
);
select ok(
  (select pg_catalog.has_function_privilege(
     procedure_row.proowner, procedure_row.oid, 'EXECUTE'
   )
   from pg_catalog.pg_proc procedure_row
   where procedure_row.oid = 'public.build_manufacturing_quote_service_detail(uuid)'::pg_catalog.regprocedure),
  'the function owner retains execute access for security-definer parents'
);
select ok(
  pg_catalog.has_function_privilege(
    'authenticated', 'public.api_request_manual_quote(uuid,boolean)', 'EXECUTE'
  ),
  'authenticated callers retain the guarded manual quote API'
);
select ok(
  (select procedure_row.prosecdef
   from pg_catalog.pg_proc procedure_row
   where procedure_row.oid = 'public.api_request_manual_quote(uuid,boolean)'::pg_catalog.regprocedure),
  'the guarded manual quote API executes its internal helper as its owner'
);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000005341', 'authenticated', 'authenticated',
   'ovd534-owner@example.test', pg_catalog.now(), '{"provider":"email"}'::jsonb),
  ('00000000-0000-4000-8000-000000005342', 'authenticated', 'authenticated',
   'ovd534-other@example.test', pg_catalog.now(), '{"provider":"email"}'::jsonb);

insert into public.organizations (id, name, slug)
values
  ('00000000-0000-4000-8000-000000005343', 'OVD-534 owner fixture', 'ovd-534-owner'),
  ('00000000-0000-4000-8000-000000005344', 'OVD-534 other fixture', 'ovd-534-other');

insert into public.organization_memberships (organization_id, user_id, role)
values
  ('00000000-0000-4000-8000-000000005343', '00000000-0000-4000-8000-000000005341', 'client'),
  ('00000000-0000-4000-8000-000000005344', '00000000-0000-4000-8000-000000005342', 'client');

insert into public.jobs (id, organization_id, created_by, title, status,
                         requested_service_kinds, service_notes)
values
  ('00000000-0000-4000-8000-000000005345', '00000000-0000-4000-8000-000000005343',
   '00000000-0000-4000-8000-000000005341', 'Owner quote fixture', 'ready_to_quote',
   '{manufacturing_quote}'::text[], 'owned quote details'),
  ('00000000-0000-4000-8000-000000005346', '00000000-0000-4000-8000-000000005344',
   '00000000-0000-4000-8000-000000005342', 'Other quote fixture', 'ready_to_quote',
   '{manufacturing_quote}'::text[], 'cross-tenant private details');

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
)
values (
  '00000000-0000-4000-8000-000000005347', '00000000-0000-4000-8000-000000005343',
  pg_catalog.repeat('a', 64), pg_catalog.repeat('a', 64), 'job-files',
  'ovd-534-owner/cad.step', 100, 'application/step'
);

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
)
values (
  '00000000-0000-4000-8000-000000005348', '00000000-0000-4000-8000-000000005345',
  '00000000-0000-4000-8000-000000005343', '00000000-0000-4000-8000-000000005341',
  '00000000-0000-4000-8000-000000005347', pg_catalog.repeat('a', 64),
  pg_catalog.repeat('a', 64), 'job-files', 'ovd-534-owner/cad.step', 'cad.step',
  'cad', 'cad', 'application/step', 100
);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id)
values (
  '00000000-0000-4000-8000-000000005349', '00000000-0000-4000-8000-000000005345',
  '00000000-0000-4000-8000-000000005343', 'OVD-534 part', 'ovd534-part',
  '00000000-0000-4000-8000-000000005348'
);

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, quantity,
  quote_quantities, applicable_vendors, spec_snapshot
)
values (
  '00000000-0000-4000-8000-000000005349', '00000000-0000-4000-8000-000000005343',
  '00000000-0000-4000-8000-000000005341', '6061-T6 Aluminum', 1,
  '{1}'::integer[], '{xometry}'::public.vendor_name[],
  '{"process":"CNC machining"}'::jsonb
);

set local role anon;
select throws_ok(
  $$select public.build_manufacturing_quote_service_detail('00000000-0000-4000-8000-000000005346')$$,
  '42501', null, 'anonymous direct call cannot read arbitrary job details'
);
reset role;

select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000005341', true);
set local role authenticated;
select throws_ok(
  $$select public.build_manufacturing_quote_service_detail('00000000-0000-4000-8000-000000005345')$$,
  '42501', null, 'authenticated direct call is denied even for an owned job'
);
select throws_ok(
  $$select public.build_manufacturing_quote_service_detail('00000000-0000-4000-8000-000000005346')$$,
  '42501', null, 'authenticated direct call cannot read another organization job'
);
select throws_ok(
  $$select public.api_request_manual_quote('00000000-0000-4000-8000-000000005346', false)$$,
  'P0001', null, 'the guarded quote API still rejects a foreign job'
);
reset role;

select is(
  (select pg_catalog.count(*)::integer from public.service_request_line_items
   where job_id in (
     '00000000-0000-4000-8000-000000005345',
     '00000000-0000-4000-8000-000000005346'
   )),
  0,
  'denied direct calls created no service line item'
);

set local role service_role;
select is(
  public.build_manufacturing_quote_service_detail('00000000-0000-4000-8000-000000005346')
    -> 'requestBridge' ->> 'serviceNotes',
  'cross-tenant private details',
  'service-role internal invocation still returns the existing detail shape'
);
reset role;

select ok(
  (select automatic_parent.prosecdef
     and automatic_parent.proowner = detail_helper.proowner
     and pg_catalog.has_function_privilege(
       automatic_parent.proowner, detail_helper.oid, 'EXECUTE'
     )
   from pg_catalog.pg_proc automatic_parent
   cross join pg_catalog.pg_proc detail_helper
   where automatic_parent.oid =
     'private.request_scoped_automatic_quote_impl(uuid,public.vendor_name[])'::pg_catalog.regprocedure
     and detail_helper.oid =
       'public.build_manufacturing_quote_service_detail(uuid)'::pg_catalog.regprocedure),
  'the security-definer automatic parent owner can still execute the detail helper'
);
select ok(
  (select dispatch_parent.prosecdef
     and dispatch_parent.proowner = automatic_parent.proowner
     and pg_catalog.strpos(
       dispatch_parent.prosrc, 'private.request_scoped_automatic_quote_impl'
     ) > 0
   from pg_catalog.pg_proc dispatch_parent
   cross join pg_catalog.pg_proc automatic_parent
   where dispatch_parent.oid =
     'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)'::pg_catalog.regprocedure
     and automatic_parent.oid =
       'private.request_scoped_automatic_quote_impl(uuid,public.vendor_name[])'::pg_catalog.regprocedure),
  'the current guarded Xometry dispatch API retains the automatic parent call path'
);

-- Exercise the internal automatic parent with only synthetic rows. The
-- exception subtransaction rolls back every quote and queue write before the
-- captured result is returned to pgTAP. This tests the inner call path, not
-- the separate Xometry permit gate, and does not invoke a provider.
create function pg_temp.probe_ovd534_automatic_parent(p_job_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_response jsonb;
  v_service_notes text;
  v_queued_tasks integer;
begin
  begin
    v_response := private.request_scoped_automatic_quote_impl(
      p_job_id, '{xometry}'::public.vendor_name[]
    );
    select line_item.service_detail -> 'requestBridge' ->> 'serviceNotes'
    into v_service_notes
    from public.service_request_line_items line_item
    where line_item.job_id = p_job_id;
    select pg_catalog.count(*)::integer
    into v_queued_tasks
    from public.work_queue task
    where task.job_id = p_job_id;
    raise exception 'ovd534_automatic_probe_rollback' using errcode = 'PZ534';
  exception when sqlstate 'PZ534' then
    if sqlerrm <> 'ovd534_automatic_probe_rollback' then
      raise;
    end if;
  end;

  return pg_catalog.jsonb_build_object(
    'created', v_response ->> 'created',
    'serviceNotes', v_service_notes,
    'queuedTasks', v_queued_tasks
  );
end;
$$;

create temporary table ovd534_automatic_probe (response jsonb) on commit drop;
insert into ovd534_automatic_probe
select pg_temp.probe_ovd534_automatic_parent(
  '00000000-0000-4000-8000-000000005345'
);
select is(
  (select response ->> 'created' from ovd534_automatic_probe),
  'true',
  'the automatic parent can still create a request through the detail helper'
);
select is(
  (select response ->> 'serviceNotes' from ovd534_automatic_probe),
  'owned quote details',
  'the automatic parent preserves the helper payload shape'
);
select is(
  (select (response ->> 'queuedTasks')::integer from ovd534_automatic_probe),
  1,
  'the automatic parent reached its one-lane queue path before rollback'
);
select is(
  (select pg_catalog.count(*)::integer from public.quote_requests
   where job_id = '00000000-0000-4000-8000-000000005345'),
  0,
  'the automatic request fixture leaves no quote request after rollback'
);
select is(
  (select pg_catalog.count(*)::integer from public.work_queue
   where job_id = '00000000-0000-4000-8000-000000005345'),
  0,
  'the automatic request fixture leaves no queued task after rollback'
);

set local role authenticated;
select is(
  public.api_request_manual_quote('00000000-0000-4000-8000-000000005345', false)
    ->> 'created',
  'true',
  'an authorized user can still create a manual quote through its guarded API'
);
reset role;

select is(
  (select service_detail -> 'requestBridge' ->> 'serviceNotes'
   from public.service_request_line_items
   where job_id = '00000000-0000-4000-8000-000000005345'),
  'owned quote details',
  'the guarded path still persists the existing service-detail payload'
);
select is(
  (select pg_catalog.count(*)::integer from public.quote_requests
   where job_id = '00000000-0000-4000-8000-000000005345'),
  1,
  'the guarded path persists exactly one quote request'
);
select is(
  (select pg_catalog.count(*)::integer from public.quote_requests
   where job_id = '00000000-0000-4000-8000-000000005346'),
  0,
  'the foreign job remains unchanged'
);

select * from finish();
rollback;
