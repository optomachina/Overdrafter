-- Least-privilege characterization for 15 client-facing SECURITY DEFINER RPCs.
-- Each RPC is called by an anonymous caller, by a verified client of another
-- organization using org A's ids, and by an unverified member of org A, then
-- once by an authorized org A caller as a positive control. Expected outcomes
-- were recorded from the current definitions. Where today's behavior is a gap
-- it is pinned as-is and labelled "KNOWN GAP" or "GAP-B5": characterized here,
-- deliberately not fixed. Synthetic records only; everything rolls back.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(67);

\set user_a c15a0000-0000-4000-8000-000000000001
\set user_b c15a0000-0000-4000-8000-000000000002
\set user_u c15a0000-0000-4000-8000-000000000003
\set user_i c15a0000-0000-4000-8000-000000000004
\set org_a c15a0000-0000-4000-8000-00000000000a
\set org_b c15a0000-0000-4000-8000-00000000000b
\set policy_a c15a0000-0000-4000-8000-000000000010
\set job_a c15a0000-0000-4000-8000-000000000011
\set file_a c15a0000-0000-4000-8000-000000000012
\set part_a c15a0000-0000-4000-8000-000000000013
\set request_a c15a0000-0000-4000-8000-000000000014
\set run_a c15a0000-0000-4000-8000-000000000015
\set result_a c15a0000-0000-4000-8000-000000000016
\set offer_a c15a0000-0000-4000-8000-000000000017
\set package_a c15a0000-0000-4000-8000-000000000018
\set option_a c15a0000-0000-4000-8000-000000000019
\set absent_id c15a0000-0000-4000-8000-0000000000ff
\set part_key 'least-privilege-part'
\set material '6061-T6 Aluminum'
\set markup_version 'client-rpc-least-privilege'
\set vendors '{xometry}'
\set raised P0001
\set empty_list '[]'
\set job_a_rows '[{"jobId": "' :job_a '"}]'
\set signed_in 'You must be signed in to perform this action.'
\set unverified 'Verify your email or sign in with Google, Microsoft, or Apple before performing this action.'
\set edit_denied 'You do not have permission to edit job ' :job_a '.'
\set job_denied 'You do not have access to job ' :job_a
\set readiness_denied 'Only internal users can inspect quote run readiness.'

-- Org A: verified client uA, unverified client uU, internal estimator iA.
-- Org B: verified client uB. uU has no confirmed email and no OAuth provider.
insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data)
select fixture.id, api.role_name, api.role_name, fixture.email,
  case when fixture.verified then timezone('utc', now()) end, '{"provider":"email"}'::jsonb
from (values
  (:'user_a'::uuid, 'client-rpc-a@example.test', true),
  (:'user_b'::uuid, 'client-rpc-b@example.test', true),
  (:'user_u'::uuid, 'client-rpc-unverified@example.test', false),
  (:'user_i'::uuid, 'client-rpc-internal@example.test', true)
) as fixture(id, email, verified)
cross join (values ('authenticated')) as api(role_name);
insert into public.organizations (id, name, slug) values
  (:'org_a', 'Client RPC org A', 'client-rpc-least-privilege-a'),
  (:'org_b', 'Client RPC org B', 'client-rpc-least-privilege-b');
insert into public.organization_memberships (organization_id, user_id, role)
select member.org_id, member.user_id, 'client'
from (values (:'org_a'::uuid, :'user_a'::uuid), (:'org_b'::uuid, :'user_b'::uuid),
  (:'org_a'::uuid, :'user_u'::uuid)) as member(org_id, user_id);
insert into public.organization_memberships (organization_id, user_id, role)
values (:'org_a', :'user_i', 'internal_estimator');
insert into public.pricing_policies (id, organization_id, version, markup_percent, currency_minor_unit)
values (:'policy_a', :'org_a', :'markup_version', 20, 0.01);
insert into public.jobs (id, organization_id, created_by, title, status, active_pricing_policy_id, requested_service_kinds)
values (:'job_a', :'org_a', :'user_a', 'Client RPC least privilege', 'ready_to_quote', :'policy_a', '{manufacturing_quote}');
-- The CAD file keeps the part in reconcile's file set, so reconcile never deletes it.
insert into public.job_files (id, job_id, organization_id, uploaded_by, storage_bucket, storage_path,
  original_name, normalized_name, file_kind, mime_type, size_bytes)
values (:'file_a', :'job_a', :'org_a', :'user_a', 'job-files', 'client-rpc/least-privilege.step',
  'least-privilege.step', :'part_key', 'cad', 'application/step', 100);
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
values (:'part_a', :'job_a', :'org_a', 'Least privilege part', :'part_key', :'file_a', 1);
insert into public.approved_part_requirements (part_id, organization_id, approved_by, material,
  quantity, quote_quantities, applicable_vendors, spec_snapshot)
values (:'part_a', :'org_a', :'user_i', :'material', 1, '{1}', :'vendors', '{"process":"CNC machining"}');
-- The queued request is not linked to the completed run, so it stays cancelable.
insert into public.quote_requests (id, organization_id, job_id, requested_by, requested_vendors, status)
values (:'request_a', :'org_a', :'job_a', :'user_a', :'vendors', 'queued');
insert into public.quote_runs (id, job_id, organization_id, initiated_by, status)
values (:'run_a', :'job_a', :'org_a', :'user_i', 'completed');
insert into public.vendor_quote_results (id, quote_run_id, part_id, organization_id, vendor,
  requested_quantity, status, unit_price_usd, total_price_usd)
values (:'result_a', :'run_a', :'part_a', :'org_a', 'xometry', 1, 'instant_quote_received', 100, 100);
insert into public.vendor_quote_offers (id, vendor_quote_result_id, organization_id, offer_key,
  supplier, lane_label, unit_price_usd, total_price_usd, valid_until, provenance_status, raw_payload)
values (:'offer_a', :'result_a', :'org_a', 'client-rpc-offer', 'Synthetic supplier', 'Standard', 100, 100,
  clock_timestamp() + interval '30 days', 'trusted_adapter', '{"source":"synthetic-client-rpc-fixture"}');
insert into public.published_quote_packages (id, job_id, quote_run_id, organization_id, published_by, pricing_policy_id)
values (:'package_a', :'job_a', :'run_a', :'org_a', :'user_i', :'policy_a');
insert into public.published_quote_options (id, package_id, organization_id, option_kind, label,
  published_price_usd, source_vendor_quote_id, source_vendor_quote_offer_id, markup_policy_version, requested_quantity)
values (:'option_a', :'package_a', :'org_a', 'lowest_cost', 'Lowest Cost', 120, :'result_a', :'offer_a', :'markup_version', 1);
insert into public.audit_events (organization_id, actor_user_id, job_id, event_type, payload)
values (:'org_a', :'user_a', :'job_a', 'job.created', '{}');

create function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true),
    pg_catalog.set_config('request.jwt.claims', case when p_user is null then '{"role":"anon"}'
      else pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
$$;

-- Runs one call as the current role and returns its single value as text.
create function pg_temp.run(p_sql text) returns text language plpgsql as $$
declare
  v_result text;
begin
  execute p_sql into v_result;
  return v_result;
end;
$$;

-- A null state means the call must return exactly p_outcome (JSON); otherwise
-- it must raise that SQLSTATE with exactly the p_outcome message.
create function pg_temp.expect(p_sql text, p_state char(5), p_outcome text, p_label text)
returns text language sql as $$
  select case when p_state is null
    then is(pg_temp.run(p_sql)::jsonb, p_outcome::jsonb, p_label || ' returns ' || p_outcome)
    else throws_ok(p_sql, p_state, p_outcome, p_label || ' raises ' || p_state || ': ' || p_outcome)
  end;
$$;

-- Every org A row these RPCs can write. It is read as postgres, so neither RLS
-- nor the log_audit_event execute restriction can hide a write.
create function pg_temp.org_digest(p_org uuid) returns text language sql as $$
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(snapshot.row_text, E'\n' order by snapshot.row_text), ''))
  from (
    select 'jobs ' || to_jsonb(r)::text from public.jobs r where r.organization_id = p_org
    union all select 'parts ' || to_jsonb(r)::text from public.parts r where r.organization_id = p_org
    union all select 'job_files ' || to_jsonb(r)::text from public.job_files r where r.organization_id = p_org
    union all select 'requirements ' || to_jsonb(r)::text from public.approved_part_requirements r where r.organization_id = p_org
    union all select 'quote_requests ' || to_jsonb(r)::text from public.quote_requests r where r.organization_id = p_org
    union all select 'quote_runs ' || to_jsonb(r)::text from public.quote_runs r where r.organization_id = p_org
    union all select 'work_queue ' || to_jsonb(r)::text from public.work_queue r where r.organization_id = p_org
    union all select 'packages ' || to_jsonb(r)::text from public.published_quote_packages r where r.organization_id = p_org
    union all select 'options ' || to_jsonb(r)::text from public.published_quote_options r where r.organization_id = p_org
    union all select 'selections ' || to_jsonb(r)::text from public.client_selections r where r.organization_id = p_org
    union all select 'debug_runs ' || to_jsonb(r)::text from public.debug_extraction_runs r where r.organization_id = p_org
  ) as snapshot(row_text);
$$;

create temporary table baseline on commit drop as
select pg_temp.org_digest(:'org_a') as digest,
  (select count(*) from public.audit_events where organization_id = :'org_a') as audit_count,
  (select xmax::text from public.quote_requests where id = :'request_a') as request_xmax;

-- One row per RPC: the call, then the expected outcome for each denied caller.
-- A null unverified_outcome marks a KNOWN GAP asserted in section 5.
create temporary table rpc_case (
  ordinal integer primary key,
  rpc text not null,
  call_sql text not null,
  anon_state char(5),
  anon_outcome text not null,
  cross_org_state char(5),
  cross_org_outcome text not null,
  unverified_state char(5),
  unverified_outcome text
) on commit drop;

insert into rpc_case values
  (1, 'api_update_client_part_request',
    format('select public.api_update_client_part_request(p_job_id => %L::uuid, p_material => %L)', :'job_a', :'material'),
    :'raised', :'signed_in', :'raised', :'edit_denied', :'raised', :'unverified'),
  (2, 'api_reset_client_part_property_overrides',
    format('select public.api_reset_client_part_property_overrides(%L::uuid, %L::text[])', :'job_a', '{material}'),
    :'raised', :'signed_in', :'raised', :'edit_denied', :'raised', :'unverified'),
  (3, 'load_editable_project_part_context',
    format('select (context.part).id from public.load_editable_project_part_context(%L::uuid) context', :'job_a'),
    :'raised', :'signed_in', :'raised', :'edit_denied', :'raised', :'unverified'),
  (4, 'api_approve_job_requirements',
    format('select public.api_approve_job_requirements(%L::uuid, %L::jsonb)', :'job_a',
      jsonb_build_array(jsonb_build_object('partId', :'part_a', 'material', :'material', 'applicableVendors', array['xometry']))),
    :'raised', :'signed_in', :'raised', format('Only internal users can approve requirements for job %s', :'job_a'),
    :'raised', :'unverified'),
  -- GAP-B5: the request row is read FOR UPDATE before permission is checked,
  -- so the cross-org "forbidden" payload discloses A's job id and status.
  (5, 'api_cancel_quote_request',
    format('select public.api_cancel_quote_request(%L::uuid)', :'request_a'),
    :'raised', :'signed_in', null, jsonb_build_object('jobId', :'job_a', 'accepted', false, 'canceled', false,
      'quoteRequestId', :'request_a', 'quoteRunId', null, 'status', 'queued', 'reasonCode', 'forbidden',
      'reason', 'You do not have permission to cancel this quote request.')::text, :'raised', :'unverified'),
  -- No verified-auth gate: anon is stopped only by the org-membership check.
  (6, 'api_reconcile_job_parts',
    format('select public.api_reconcile_job_parts(%L::uuid)', :'job_a'),
    :'raised', :'job_denied', :'raised', :'job_denied', null, null),
  (7, 'api_request_extraction',
    format('select public.api_request_extraction(%L::uuid)', :'job_a'),
    :'raised', :'signed_in', :'raised', :'job_denied', :'raised', :'unverified'),
  (8, 'api_request_debug_extraction',
    format('select public.api_request_debug_extraction(%L::uuid)', :'part_a'),
    :'raised', :'signed_in', :'raised', format('You do not have access to debug extraction for part %s', :'part_a'),
    :'raised', :'unverified'),
  -- No verified-auth gate: every non-internal caller hits the internal-only check.
  (9, 'api_get_quote_run_readiness',
    format('select public.api_get_quote_run_readiness(%L::uuid)', :'run_a'),
    :'raised', :'readiness_denied', :'raised', :'readiness_denied', :'raised', :'readiness_denied'),
  (10, 'api_start_quote_run',
    format('select public.api_start_quote_run(%L::uuid)', :'job_a'),
    :'raised', :'signed_in', :'raised', format('Only internal users can start quote runs for job %s', :'job_a'),
    :'raised', :'unverified'),
  (11, 'api_publish_quote_package',
    format('select public.api_publish_quote_package(%L::uuid, %L::uuid, null, true)', :'job_a', :'run_a'),
    :'raised', :'signed_in', :'raised', 'Only internal users can publish quote packages.', :'raised', :'unverified'),
  -- Anonymous EXECUTE is revoked, but the body has no verified-auth gate.
  (12, 'api_select_quote_option',
    format('select public.api_select_quote_option(%L::uuid, %L::uuid, %L)', :'package_a', :'option_a', 'least privilege'),
    '42501', 'permission denied for function api_select_quote_option',
    :'raised', format('You do not have access to package %s', :'package_a'), null, null),
  (13, 'api_list_client_part_metadata',
    format('select public.api_list_client_part_metadata(array[%L::uuid])', :'job_a'),
    null, :'empty_list', null, :'empty_list', null, null),
  (14, 'api_list_client_quote_workspace',
    format('select public.api_list_client_quote_workspace(array[%L::uuid])', :'job_a'),
    null, :'empty_list', null, :'empty_list', null, null),
  (15, 'api_list_client_activity_events',
    format('select public.api_list_client_activity_events(array[%L::uuid], 6)', :'job_a'),
    null, :'empty_list', null, :'empty_list', null, null);

grant select on table pg_temp.rpc_case to anon, authenticated;

-- 1. Anonymous callers.
select pg_temp.act_as(null);
set local role anon;
select pg_temp.expect(c.call_sql, c.anon_state, c.anon_outcome, 'anon: ' || c.rpc)
from pg_temp.rpc_case c order by c.ordinal;
reset role;

-- 2. A verified org B client using org A's ids.
select pg_temp.act_as(:'user_b');
set local role authenticated;
select pg_temp.expect(c.call_sql, c.cross_org_state, c.cross_org_outcome, 'org B client with org A ids: ' || c.rpc)
from pg_temp.rpc_case c order by c.ordinal;

-- GAP-B5 (characterized, not fixed): both RPCs reveal whether an id exists
-- before checking authorization, so an absent id gets a different answer
-- than org A's id did above. Update these when the ordering is fixed.
select is(pg_temp.run(replace(c.call_sql, :'request_a', :'absent_id'))::jsonb ->> 'reasonCode', 'not_found',
  'GAP-B5: api_cancel_quote_request answers not_found for an absent id but forbidden for org A''s id')
from pg_temp.rpc_case c where c.ordinal = 5;
select throws_ok(replace(c.call_sql, :'job_a', :'absent_id'), :'raised', format('Job %s not found.', :'absent_id'),
  'GAP-B5: load_editable_project_part_context reports a missing job before checking edit permission')
from pg_temp.rpc_case c where c.ordinal = 3;
reset role;
select ok((select q.xmax::text <> b.request_xmax from public.quote_requests q, baseline b where q.id = :'request_a'),
  'GAP-B5: the denied cross-org cancel still locked org A''s quote request row (xmax changed)');

-- 3. An unverified member of org A.
select pg_temp.act_as(:'user_u');
set local role authenticated;
select pg_temp.expect(c.call_sql, c.unverified_state, c.unverified_outcome, 'unverified org A member: ' || c.rpc)
from pg_temp.rpc_case c where c.unverified_outcome is not null order by c.ordinal;
reset role;

-- 4. Invariant, read as postgres: no denied call changed org A's rows or audit trail.
select is(pg_temp.org_digest(:'org_a'), (select digest from baseline),
  'denied calls leave org A jobs, parts, files, requirements, requests, runs, queue, packages, options, selections and debug runs unchanged');
select is((select count(*) from public.audit_events where organization_id = :'org_a'), (select audit_count from baseline),
  'denied calls append no org A audit events');

-- 5. KNOWN GAP (characterized, not fixed): these RPCs have no verified-auth
-- gate, so an unverified member of org A can still use them. Update these
-- assertions when the gate is added.
select pg_temp.act_as(:'user_u');
set local role authenticated;
select ok(pg_temp.run(c.call_sql)::jsonb @> :'job_a_rows'::jsonb,
  'KNOWN GAP: unverified org A member reads org A rows through ' || c.rpc)
from pg_temp.rpc_case c where c.ordinal between 13 and 15 order by c.ordinal;
select is(pg_temp.run(c.call_sql)::jsonb,
  '{"totalParts": 1, "matchedPairs": 0, "missingDrawings": 1, "missingCad": 0}'::jsonb,
  'KNOWN GAP: unverified org A member can reconcile job parts')
from pg_temp.rpc_case c where c.ordinal = 6;
select isnt(pg_temp.run(c.call_sql), null,
  'KNOWN GAP: unverified org A member can select a published quote option')
from pg_temp.rpc_case c where c.ordinal = 12;
reset role;

-- 6. Positive controls: the same calls succeed for org A's verified client.
select pg_temp.act_as(:'user_a');
set local role authenticated;
select is(pg_temp.run(c.call_sql), :'part_a', 'org A client loads its editable part context')
from pg_temp.rpc_case c where c.ordinal = 3;
select is(pg_temp.run(c.call_sql), :'job_a', 'org A client updates its part request')
from pg_temp.rpc_case c where c.ordinal = 1;
select is(pg_temp.run(c.call_sql), :'job_a', 'org A client resets its part property overrides')
from pg_temp.rpc_case c where c.ordinal = 2;
select throws_ok(c.call_sql, c.cross_org_state, c.cross_org_outcome, 'org A client cannot approve requirements')
from pg_temp.rpc_case c where c.ordinal = 4;
select is(pg_temp.run(c.call_sql)::jsonb ->> 'status', 'canceled', 'org A client cancels its queued quote request')
from pg_temp.rpc_case c where c.ordinal = 5;
select isnt(pg_temp.run(c.call_sql), null, 'org A client selects its published quote option')
from pg_temp.rpc_case c where c.ordinal = 12;
select is(pg_temp.run(c.call_sql), '1', 'org A client queues extraction for its part')
from pg_temp.rpc_case c where c.ordinal = 7;
select is(pg_temp.run(c.call_sql)::jsonb ->> 'totalParts', '1', 'org A client reconciles its job parts')
from pg_temp.rpc_case c where c.ordinal = 6;
select ok(pg_temp.run(c.call_sql)::jsonb @> :'job_a_rows'::jsonb, 'org A client reads its own rows through ' || c.rpc)
from pg_temp.rpc_case c where c.ordinal between 13 and 15 order by c.ordinal;
reset role;
select is((select count(*)::integer from public.client_selections where option_id = :'option_a' and selected_by = :'user_a'), 1,
  'the client selection is persisted for org A''s client');

-- 7. Positive controls for the internal-only RPCs, as org A's internal estimator.
select pg_temp.act_as(:'user_i');
set local role authenticated;
select is(pg_temp.run(c.call_sql), '1', 'org A internal user approves requirements')
from pg_temp.rpc_case c where c.ordinal = 4;
select isnt(pg_temp.run(c.call_sql), null, 'org A internal user requests a debug extraction')
from pg_temp.rpc_case c where c.ordinal = 8;
select is(pg_temp.run(c.call_sql)::jsonb -> 'successfulVendorQuotes', '1'::jsonb, 'org A internal user inspects quote run readiness')
from pg_temp.rpc_case c where c.ordinal = 9;
select isnt(pg_temp.run(c.call_sql), null, 'org A internal user starts a quote run')
from pg_temp.rpc_case c where c.ordinal = 10;
select is(pg_temp.run(c.call_sql), :'package_a', 'org A internal user publishes the quote package')
from pg_temp.rpc_case c where c.ordinal = 11;
reset role;

select * from finish();
rollback;
