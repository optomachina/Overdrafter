begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

-- One canonical value per fixture identity and exact RPC contract keeps the
-- access-control assertions readable without repeating magic SQL literals.
\set detail_signature '''public.build_manufacturing_quote_service_detail(uuid)'''
\set manual_signature '''public.api_request_manual_quote(uuid,boolean)'''
\set automatic_signature '''private.request_scoped_automatic_quote_impl(uuid,public.vendor_name[])'''
\set dispatch_signature '''public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)'''
\set detail_call_template '''select public.build_manufacturing_quote_service_detail(%L::uuid)'''
\set manual_call_template '''select public.api_request_manual_quote(%L::uuid, false)'''
\set owner_user_id '''00000000-0000-4000-8000-000000005341'''
\set other_user_id '''00000000-0000-4000-8000-000000005342'''
\set owner_org_id '''00000000-0000-4000-8000-000000005343'''
\set other_org_id '''00000000-0000-4000-8000-000000005344'''
\set owner_job_id '''00000000-0000-4000-8000-000000005345'''
\set other_job_id '''00000000-0000-4000-8000-000000005346'''
\set blob_id '''00000000-0000-4000-8000-000000005347'''
\set file_id '''00000000-0000-4000-8000-000000005348'''
\set part_id '''00000000-0000-4000-8000-000000005349'''
\set anonymous_role '''anon'''
\set authenticated_role '''authenticated'''
\set service_role_name '''service_role'''
\set execute_privilege '''EXECUTE'''
\set permission_denied_state '''42501'''
\set bridge_key '''requestBridge'''
\set notes_key '''serviceNotes'''
\set owner_notes '''owned quote details'''
\set other_notes '''cross-tenant private details'''
\set hash_seed '''a'''

select plan(26);

select ok(
  pg_catalog.to_regprocedure(:detail_signature) is not null,
  'the exact manufacturing-quote service-detail helper exists'
);
select ok(
  (select procedure_row.prosecdef
   from pg_catalog.pg_proc procedure_row
   where procedure_row.oid = :detail_signature::pg_catalog.regprocedure),
  'the helper retains its security-definer contract for guarded parents'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(procedure_row.proacl, pg_catalog.acldefault('f', procedure_row.proowner))
    ) function_acl
    where procedure_row.oid = :detail_signature::pg_catalog.regprocedure
      and function_acl.grantee = 0
      and function_acl.privilege_type = :execute_privilege
  ),
  'PUBLIC has no inherited execute grant on the helper'
);
select ok(
  not pg_catalog.has_function_privilege(
    :anonymous_role, :detail_signature, :execute_privilege
  ),
  'anonymous callers cannot execute the helper'
);
select ok(
  not pg_catalog.has_function_privilege(
    :authenticated_role, :detail_signature, :execute_privilege
  ),
  'authenticated callers cannot execute the helper, including for their own job'
);
select ok(
  pg_catalog.has_function_privilege(
    :service_role_name, :detail_signature, :execute_privilege
  ),
  'service-role internal callers retain execute access'
);
select ok(
  (select pg_catalog.has_function_privilege(
     procedure_row.proowner, procedure_row.oid, :execute_privilege
   )
   from pg_catalog.pg_proc procedure_row
   where procedure_row.oid = :detail_signature::pg_catalog.regprocedure),
  'the function owner retains execute access for security-definer parents'
);
select ok(
  pg_catalog.has_function_privilege(
    :authenticated_role, :manual_signature, :execute_privilege
  ),
  'authenticated callers retain the guarded manual quote API'
);
select ok(
  (select procedure_row.prosecdef
   from pg_catalog.pg_proc procedure_row
   where procedure_row.oid = :manual_signature::pg_catalog.regprocedure),
  'the guarded manual quote API executes its internal helper as its owner'
);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
values
  (:owner_user_id, :authenticated_role, :authenticated_role,
   'ovd534-owner@example.test', pg_catalog.now(), '{"provider":"email"}'::jsonb),
  (:other_user_id, :authenticated_role, :authenticated_role,
   'ovd534-other@example.test', pg_catalog.now(), '{"provider":"email"}'::jsonb);

insert into public.organizations (id, name, slug)
values
  (:owner_org_id, 'OVD-534 owner fixture', 'ovd-534-owner'),
  (:other_org_id, 'OVD-534 other fixture', 'ovd-534-other');

insert into public.organization_memberships (organization_id, user_id, role)
values
  (:owner_org_id, :owner_user_id, 'client'),
  (:other_org_id, :other_user_id, 'client');

insert into public.jobs (id, organization_id, created_by, title, status,
                         requested_service_kinds, service_notes)
values
  (:owner_job_id, :owner_org_id,
   :owner_user_id, 'Owner quote fixture', 'ready_to_quote',
   '{manufacturing_quote}'::text[], :owner_notes),
  (:other_job_id, :other_org_id,
   :other_user_id, 'Other quote fixture', 'ready_to_quote',
   '{manufacturing_quote}'::text[], :other_notes);

insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, size_bytes, mime_type
)
values (
  :blob_id, :owner_org_id,
  pg_catalog.repeat(:hash_seed, 64), pg_catalog.repeat(:hash_seed, 64), 'job-files',
  'ovd-534-owner/cad.step', 100, 'application/step'
);

insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256,
  trusted_content_sha256, storage_bucket, storage_path, original_name,
  normalized_name, file_kind, mime_type, size_bytes
)
values (
  :file_id, :owner_job_id,
  :owner_org_id, :owner_user_id,
  :blob_id, pg_catalog.repeat(:hash_seed, 64),
  pg_catalog.repeat(:hash_seed, 64), 'job-files', 'ovd-534-owner/cad.step', 'cad.step',
  'cad', 'cad', 'application/step', 100
);

insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id)
values (
  :part_id, :owner_job_id,
  :owner_org_id, 'OVD-534 part', 'ovd534-part',
  :file_id
);

insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, quantity,
  quote_quantities, applicable_vendors, spec_snapshot
)
values (
  :part_id, :owner_org_id,
  :owner_user_id, '6061-T6 Aluminum', 1,
  '{1}'::integer[], '{xometry}'::public.vendor_name[],
  '{"process":"CNC machining"}'::jsonb
);

set local role anon;
select throws_ok(
  pg_catalog.format(:detail_call_template, :other_job_id),
  :permission_denied_state, null, 'anonymous direct call cannot read arbitrary job details'
);
reset role;

select pg_catalog.set_config('request.jwt.claim.sub', :owner_user_id, true);
set local role authenticated;
select throws_ok(
  pg_catalog.format(:detail_call_template, :owner_job_id),
  :permission_denied_state, null, 'authenticated direct call is denied even for an owned job'
);
select throws_ok(
  pg_catalog.format(:detail_call_template, :other_job_id),
  :permission_denied_state, null, 'authenticated direct call cannot read another organization job'
);
select throws_ok(
  pg_catalog.format(:manual_call_template, :other_job_id),
  'P0001', null, 'the guarded quote API still rejects a foreign job'
);
reset role;

select is(
  (select pg_catalog.count(*)::integer from public.service_request_line_items
   where job_id in (
     :owner_job_id,
     :other_job_id
   )),
  0,
  'denied direct calls created no service line item'
);

set local role service_role;
select is(
  public.build_manufacturing_quote_service_detail(:other_job_id)
    -> :bridge_key ->> :notes_key,
  :other_notes,
  'service-role internal invocation still returns the existing detail shape'
);
reset role;

select ok(
  (select automatic_parent.prosecdef
     and automatic_parent.proowner = detail_helper.proowner
     and pg_catalog.has_function_privilege(
       automatic_parent.proowner, detail_helper.oid, :execute_privilege
     )
   from pg_catalog.pg_proc automatic_parent
   cross join pg_catalog.pg_proc detail_helper
   where automatic_parent.oid =
     :automatic_signature::pg_catalog.regprocedure
     and detail_helper.oid =
       :detail_signature::pg_catalog.regprocedure),
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
     :dispatch_signature::pg_catalog.regprocedure
     and automatic_parent.oid =
       :automatic_signature::pg_catalog.regprocedure),
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
  v_service_detail jsonb;
  v_queued_tasks integer;
begin
  begin
    v_response := private.request_scoped_automatic_quote_impl(
      p_job_id, '{xometry}'::public.vendor_name[]
    );
    select line_item.service_detail
    into v_service_detail
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
    'result', v_response,
    'detail', v_service_detail,
    'queuedTasks', v_queued_tasks
  );
end;
$$;

create temporary table ovd534_automatic_probe (response jsonb) on commit drop;
insert into ovd534_automatic_probe
select pg_temp.probe_ovd534_automatic_parent(
  :owner_job_id
);
select is(
  (select response -> 'result' ->> 'created' from ovd534_automatic_probe),
  'true',
  'the automatic parent can still create a request through the detail helper'
);
select is(
  (select response -> 'detail' -> :bridge_key ->> :notes_key
   from ovd534_automatic_probe),
  :owner_notes,
  'the automatic parent preserves the helper payload shape'
);
select is(
  (select (response ->> 'queuedTasks')::integer from ovd534_automatic_probe),
  1,
  'the automatic parent reached its one-lane queue path before rollback'
);
select is(
  (select pg_catalog.count(*)::integer from public.quote_requests
   where job_id = :owner_job_id),
  0,
  'the automatic request fixture leaves no quote request after rollback'
);
select is(
  (select pg_catalog.count(*)::integer from public.work_queue
   where job_id = :owner_job_id),
  0,
  'the automatic request fixture leaves no queued task after rollback'
);

set local role authenticated;
select is(
  public.api_request_manual_quote(:owner_job_id, false)
    ->> 'created',
  'true',
  'an authorized user can still create a manual quote through its guarded API'
);
reset role;

select is(
  (select service_detail -> :bridge_key ->> :notes_key
   from public.service_request_line_items
   where job_id = :owner_job_id),
  :owner_notes,
  'the guarded path still persists the existing service-detail payload'
);
select is(
  (select pg_catalog.count(*)::integer from public.quote_requests
   where job_id = :owner_job_id),
  1,
  'the guarded path persists exactly one quote request'
);
select is(
  (select pg_catalog.count(*)::integer from public.quote_requests
   where job_id = :other_job_id),
  0,
  'the foreign job remains unchanged'
);

select * from finish();
rollback;
