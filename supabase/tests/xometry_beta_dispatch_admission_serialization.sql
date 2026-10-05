-- OVD-598 independent-session races for the legacy Xometry admission path,
-- public.api_request_xometry_beta_dispatch. Fixtures are committed so real
-- dblink sessions contend on real row and advisory locks. Every fixture row is
-- removed, and the fictiv admission row and the automatic-quote rollout are
-- restored to their seeded default-off state, before the suite finishes.
--
-- Fields edited concurrently (one fresh job per field and race):
--   F1 approved_part_requirements.requested_by_date
--   F2 approved_part_requirements.applicable_vendors without xometry
--   F3 jobs.requested_service_kinds
--   F4 the drawing's job_files.file_kind
--   F5 the CAD file's job_files.job_id. It moves to a sibling job in the same
--      organization; that passes every constraint, and the resolver rejects it
--      through `v_cad.job_id <> v_job.id`.
--
-- R1 (edit first): an editor holds an uncommitted edit, the request starts,
--   then the editor commits. Expected: the request is a Lock waiter blocked by
--   the editor, then fails with the field's denial and persists nothing.
-- R2 (request first): a driver session holds the organization's founding-beta
--   advisory lock, which the request takes only after its scope row locks.
--   Expected: the editor's UPDATE is a Lock waiter blocked by the request;
--   after release the request is created from the pre-edit scope and the edit
--   commits afterwards.
-- R3: a legacy request, a generic api_request_provider_dispatch on a second
--   job in the same organization, and a requirement editor all finish, with
--   no 40P01 under statement_timeout = 10s.
--
-- Recorded pre-fix observations (this suite on the base ac5026fe, before
-- migration 20261004100000_ovd598_serialize_legacy_xometry_admission.sql;
-- red run: 33 of 49 failed):
--   F1/F2 R1: waited=false; the request did not observe the uncommitted edit
--     and returned created=true from the pre-edit snapshot, so the waited,
--     denial and no-rows assertions FAIL. The capturedAt fingerprint did not
--     catch it, because the request read the pre-edit row and its fingerprint
--     matched.
--   F1/F2 R2: editor_waited=false; the edit committed while the request was
--     parked, and the request then failed with the field's denial, so the
--     editor-waited, created and snapshot assertions FAIL.
--   F3 R1: waited=true, but late: the request blocked only at the final
--     `update public.jobs set status = 'quoting'` and then returned
--     created=true with the pre-edit service kinds, so the denial and no-rows
--     assertions FAIL.
--   F3 R2: editor_waited=false; the edit committed while the request was
--     parked, but the resolver had already read the job into v_job before its
--     founding-beta lock, so the request still returned created=true from the
--     pre-edit service kinds. Only the editor-waited assertion FAILS; the
--     created and snapshot assertions pass, which is the stale-permit defect.
--   F4/F5 R1: waited=false and created=true (a stale permit), so the waited,
--     denial and no-rows assertions FAIL. F4/F5 R2: as F1/F2 R2.
--   The helper privilege, definer and placement assertions FAIL because the
--   helper does not exist. The ovd373 contract, ACL, preview and R3
--   assertions pass before and after the fix.

create extension if not exists dblink with schema extensions;

create or replace function public.ovd598_cleanup_admission_fixture()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_org constant uuid := '00000000-0000-4000-8598-000000000002'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
begin
  alter table private.xometry_beta_dispatch_permits disable trigger xometry_beta_dispatch_permits_append_only;
  delete from private.xometry_beta_dispatch_permits where organization_id = v_org;
  alter table private.xometry_beta_dispatch_permits enable trigger xometry_beta_dispatch_permits_append_only;
  alter table private.provider_dispatch_permits disable trigger provider_dispatch_permits_append_only;
  delete from private.provider_dispatch_permits where organization_id = v_org;
  alter table private.provider_dispatch_permits enable trigger provider_dispatch_permits_append_only;
  alter table private.quote_access_admissions disable trigger quote_access_admission_immutable;
  delete from private.quote_access_admissions where organization_id = v_org;
  alter table private.quote_access_admissions enable trigger quote_access_admission_immutable;
  alter table private.provider_dispatch_envelope_reviews disable trigger guard_provider_dispatch_envelope_review_mutation;
  delete from private.provider_dispatch_envelope_reviews where envelope_id = 'fictiv-ovd598-race-envelope';
  alter table private.provider_dispatch_envelope_reviews enable trigger guard_provider_dispatch_envelope_review_mutation;

  alter table private.quote_provider_admission_policies disable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policies disable trigger capture_quote_provider_admission_policy_history;
  update private.quote_provider_admission_policies
  set admission_state = 'disabled', generic_dispatch_enabled = false,
      policy_revision = 'disabled-2026-08-17.v1', evidence_reference = null, permission_basis = null,
      supported_processes = array[]::public.process_types[], accepted_file_extensions = array[]::text[],
      session_owner = null, reviewed_by = null, reviewed_at = null, expires_at = null,
      change_reason = 'initial_seed'
  where provider = 'fictiv' and policy_revision = 'fictiv-ovd598-race.v1';
  alter table private.quote_provider_admission_policies enable trigger capture_quote_provider_admission_policy_history;
  alter table private.quote_provider_admission_policies enable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policy_history disable trigger reject_quote_provider_admission_history_mutation;
  delete from private.quote_provider_admission_policy_history
  where provider = 'fictiv' and policy_revision = 'fictiv-ovd598-race.v1';
  alter table private.quote_provider_admission_policy_history enable trigger reject_quote_provider_admission_history_mutation;

  delete from public.work_queue
  where job_id in (select id from public.jobs where organization_id = v_org);
  delete from public.quote_request_lanes where organization_id = v_org;
  delete from public.vendor_quote_results where organization_id = v_org;
  delete from public.quote_runs where organization_id = v_org;
  delete from public.quote_requests where organization_id = v_org;
  delete from public.service_request_line_items where organization_id = v_org;
  delete from public.approved_part_requirements where organization_id = v_org;
  delete from public.parts where organization_id = v_org;
  delete from public.part_versions where organization_id = v_org;
  delete from public.canonical_parts where organization_id = v_org;
  delete from public.job_files where organization_id = v_org;
  delete from public.organization_file_blobs where organization_id = v_org;
  delete from public.jobs where organization_id = v_org;
  delete from public.org_vendor_configs where organization_id = v_org;
  delete from public.quote_request_guardrails where organization_id = v_org;
  alter table private.founding_beta_notice_acceptances
    disable trigger founding_beta_notice_acceptances_append_only;
  delete from private.founding_beta_notice_acceptances where organization_id = v_org;
  alter table private.founding_beta_notice_acceptances
    enable trigger founding_beta_notice_acceptances_append_only;
  alter table private.founding_beta_enrollment_events
    disable trigger founding_beta_enrollment_events_append_only;
  delete from private.founding_beta_enrollment_events where organization_id = v_org;
  alter table private.founding_beta_enrollment_events
    enable trigger founding_beta_enrollment_events_append_only;
  delete from private.organization_entitlement_grants where organization_id = v_org;
  delete from public.organization_memberships where organization_id = v_org;
  delete from public.organizations where id = v_org;
  delete from auth.users where id = '00000000-0000-4000-8598-000000000001'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
  update private.commercial_rollout_controls
  set enabled = false, revision = 0,
      change_reason = 'Default-off automatic quote rollout',
      updated_by_user_id = null, updated_by_actor = null
  where capability = 'automatic_quote_collection';
end;
$$;
revoke all on function public.ovd598_cleanup_admission_fixture() from public, anon, authenticated, service_role;

-- Self-heal committed rows and connections left by an interrupted run.
do $$
declare
  v_name text;
begin
  foreach v_name in array array['ovd598_req', 'ovd598_generic', 'ovd598_editor', 'ovd598_driver'] loop
    if v_name = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
      perform extensions.dblink_disconnect(v_name);
    end if;
  end loop;
end;
$$;
select public.ovd598_cleanup_admission_fixture();

select plan(49);

create function pg_temp.ovd598_org() returns uuid language sql immutable
as $$ select '00000000-0000-4000-8598-000000000002'::uuid $$;
create function pg_temp.ovd598_user() returns uuid language sql immutable
as $$ select '00000000-0000-4000-8598-000000000001'::uuid $$;
-- One deterministic identifier per fixture kind and job index.
create function pg_temp.ovd598_id(p_kind text, p_k integer) returns uuid language sql immutable
as $$
  select ('00000000-0000-4000-8598-' || case p_kind
    when 'job' then '1000000000' when 'cad_blob' then '2000000000'
    when 'drawing_blob' then '2100000000' when 'cad' then '3000000000'
    when 'drawing' then '3100000000' when 'part' then '4000000000'
    when 'ref' then '5000000000' end || pg_catalog.lpad(p_k::text, 2, '0'))::uuid
$$;

begin;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values (pg_temp.ovd598_user(), 'authenticated', 'authenticated',
  'ovd598-admission@example.test', timezone('utc', now()));
insert into public.organizations (id, name, slug)
values (pg_temp.ovd598_org(), 'OVD 598 Admission', 'ovd-598-admission');
insert into public.organization_memberships (organization_id, user_id, role)
values (pg_temp.ovd598_org(), pg_temp.ovd598_user(), 'client');
update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id = pg_temp.ovd598_org();
insert into private.sourcing_destination_history (organization_id, state, address)
values (pg_temp.ovd598_org(), 'confirmed', private.effective_sourcing_address(pg_temp.ovd598_org()));
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
) values (pg_temp.ovd598_org(), 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'OVD-598 admission fixture', pg_temp.ovd598_user());
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values (pg_temp.ovd598_org(), pg_temp.ovd598_user(), 'grant', 'OVD-598 admission fixture',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy', 'ovd598-admission-grant');
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
values (pg_temp.ovd598_org(), pg_temp.ovd598_user(), 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy');
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values (pg_temp.ovd598_org(), 'xometry', true);
-- Seven requests are created by one user; lift only this fixture's rate and
-- pending-cost ceilings so the default guardrails do not mask the races.
insert into public.quote_request_guardrails (organization_id, user_max_requests_per_window, org_pending_cost_ceiling_usd)
values (pg_temp.ovd598_org(), 1000, 1000000);
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-598 admission fixture'
where capability = 'automatic_quote_collection';

create function pg_temp.ovd598_add_job(p_k integer, p_vendor public.vendor_name, p_with_drawing boolean)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_org constant uuid := pg_temp.ovd598_org();
  v_user constant uuid := pg_temp.ovd598_user();
  v_job constant uuid := pg_temp.ovd598_id('job', p_k);
  v_cad_hash constant text := pg_catalog.md5('ovd598-cad-' || p_k) || pg_catalog.md5('ovd598-cad-tail-' || p_k);
  v_drawing_hash constant text := pg_catalog.md5('ovd598-drawing-' || p_k) || pg_catalog.md5('ovd598-drawing-tail-' || p_k);
begin
  insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
  values (v_job, v_org, v_user, 'OVD-598 admission part ' || p_k, 'ready_to_quote',
    array['manufacturing_quote'], 'manufacturing_quote');
  insert into public.organization_file_blobs (
    id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
  ) values (pg_temp.ovd598_id('cad_blob', p_k), v_org, v_cad_hash, v_cad_hash, 'job-files',
    'ovd598-admission/' || p_k || '/part.step', 100, 'application/step');
  insert into public.job_files (
    id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
  ) values (pg_temp.ovd598_id('cad', p_k), v_job, v_org, v_user, pg_temp.ovd598_id('cad_blob', p_k),
    v_cad_hash, v_cad_hash, 'job-files', 'ovd598-admission/' || p_k || '/part.step',
    'part-' || p_k || '.step', 'part-' || p_k, 'cad', 'application/step', 100);
  if p_with_drawing then
    insert into public.organization_file_blobs (
      id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
    ) values (pg_temp.ovd598_id('drawing_blob', p_k), v_org, v_drawing_hash, v_drawing_hash, 'job-files',
      'ovd598-admission/' || p_k || '/drawing.pdf', 100, 'application/pdf');
    insert into public.job_files (
      id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
      storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
    ) values (pg_temp.ovd598_id('drawing', p_k), v_job, v_org, v_user, pg_temp.ovd598_id('drawing_blob', p_k),
      v_drawing_hash, v_drawing_hash, 'job-files', 'ovd598-admission/' || p_k || '/drawing.pdf',
      'drawing-' || p_k || '.pdf', 'drawing-' || p_k, 'drawing', 'application/pdf', 100);
  end if;
  insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id, quantity)
  values (pg_temp.ovd598_id('part', p_k), v_job, v_org, 'Part ' || p_k, 'part-' || p_k,
    pg_temp.ovd598_id('cad', p_k), case when p_with_drawing then pg_temp.ovd598_id('drawing', p_k) end, 1);
  insert into public.approved_part_requirements (
    part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
    quote_quantities, applicable_vendors, spec_snapshot
  ) values (pg_temp.ovd598_id('part', p_k), v_org, v_user, '6061-T6 Aluminum', 'As machined', 0.005, 1,
    array[1], array[p_vendor], '{"process":"CNC milling"}'::jsonb);
end;
$$;

-- Jobs 1-5: R1 F1-F5. Jobs 6-10: R2 F1-F5. Job 11: R3 legacy (fictiv is
-- excluded per job so its effective provider set stays exactly xometry once
-- fictiv is enabled for R3). Job 12: R3 generic fictiv. Job 13: an empty
-- sibling job that F5 moves the CAD file into. Job 14: the unedited preview.
do $$
declare
  v_k integer;
begin
  for v_k in 1..11 loop
    perform pg_temp.ovd598_add_job(v_k, 'xometry', true);
  end loop;
  perform pg_temp.ovd598_add_job(12, 'fictiv', false);
  insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
  values (pg_temp.ovd598_id('job', 13), pg_temp.ovd598_org(), pg_temp.ovd598_user(), 'OVD-598 sibling job',
    'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');
  perform pg_temp.ovd598_add_job(14, 'xometry', true);
  insert into public.job_vendor_preferences (job_id, excluded_vendors)
  values (pg_temp.ovd598_id('job', 11), array['fictiv']::public.vendor_name[]);
end;
$$;

-- The attempt wrappers run in the dblink sessions and report any error with
-- its SQLSTATE instead of aborting, so 40P01 and 57014 stay observable.
create or replace function public.ovd598_request_attempt(
  p_job_id uuid, p_scope_fingerprint text, p_approval_reference uuid
) returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8598-000000000001","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8598-000000000001', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  begin
    return public.api_request_xometry_beta_dispatch(
      p_job_id, 'inch', p_scope_fingerprint, 'founding-beta-2026-08-15', p_approval_reference, true, true, true
    );
  exception when others then
    return pg_catalog.jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
  end;
end;
$$;

create or replace function public.ovd598_generic_attempt(
  p_job_id uuid, p_scope_fingerprint text, p_approval_reference uuid
) returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8598-000000000001","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8598-000000000001', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  begin
    return public.api_request_provider_dispatch(
      p_job_id, 'fictiv', 'inch', p_scope_fingerprint, 'founding-beta-2026-08-15',
      'fictiv-ovd598-race-envelope.v1', p_approval_reference, true, true, true
    );
  exception when others then
    return pg_catalog.jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
  end;
end;
$$;

create or replace function public.ovd598_edit_attempt(p_sql text)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_rows bigint;
begin
  execute p_sql;
  get diagnostics v_rows = row_count;
  return pg_catalog.jsonb_build_object('rows', v_rows);
exception when others then
  return pg_catalog.jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end;
$$;

-- Holds an open read transaction over the unedited preview.
create or replace function public.ovd598_preview_in_transaction(p_job_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8598-000000000001","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8598-000000000001', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  return public.api_get_xometry_beta_dispatch_scope(p_job_id, 'inch');
end;
$$;

revoke all on function public.ovd598_request_attempt(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.ovd598_generic_attempt(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.ovd598_edit_attempt(text) from public, anon, authenticated, service_role;
revoke all on function public.ovd598_preview_in_transaction(uuid) from public, anon, authenticated, service_role;

commit;

select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8598-000000000001","role":"authenticated","aal":"aal1"}', false);
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8598-000000000001', false);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

-- Pre-edit previews: the exact scope each request is expected to bind.
create temporary table ovd598_previews (job_id uuid primary key, scope_fingerprint text not null, scope jsonb not null);
insert into ovd598_previews
select job_id, preview ->> 'scopeFingerprint', preview -> 'scope'
from (
  select pg_temp.ovd598_id('job', k) as job_id,
    public.api_get_xometry_beta_dispatch_scope(pg_temp.ovd598_id('job', k), 'inch') as preview
  from pg_catalog.generate_series(1, 10) k
) previews;

-- Helper and RPC privileges and the production postcondition contract
-- (scripts/verify-ovd373-production-postconditions.sql).
select ok(
  coalesce(not pg_catalog.has_function_privilege(grantee, helper.oid, 'EXECUTE'), false),
  'the scope row-lock helper is not executable by ' || grantee
)
from (select pg_catalog.to_regprocedure('private.lock_xometry_beta_dispatch_scope_rows(uuid)') as oid) helper
cross join pg_catalog.unnest(array['public', 'anon', 'authenticated', 'service_role']) grantee;

select ok(
  coalesce((select p.prosecdef and p.proconfig = array['search_path=pg_catalog']
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('private.lock_xometry_beta_dispatch_scope_rows(uuid)')), false),
  'the helper is a security definer pinned to search_path=pg_catalog');

select ok(
  (select p.prosecdef and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=pg_catalog']
     and p.prosrc like '%xometry_beta_dispatch_permits%'
     and p.prosrc like '%scope_fingerprint%'
   from pg_catalog.pg_proc p
   where p.oid = 'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)'::regprocedure),
  'the legacy request keeps the ovd373 definer, search_path and prosrc postconditions');

select ok(
  (select pg_catalog.strpos(p.prosrc, 'perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);') > 0
     and pg_catalog.strpos(p.prosrc, 'perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);')
       > pg_catalog.strpos(p.prosrc, '''xometry-beta-approval:''')
     and pg_catalog.strpos(p.prosrc, 'perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);')
       < pg_catalog.strpos(p.prosrc, 'select permit.* into v_existing')
     and pg_catalog.strpos(p.prosrc, 'perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);')
       < pg_catalog.strpos(p.prosrc, 'private.resolve_xometry_beta_dispatch_scope_with_access(')
   from pg_catalog.pg_proc p
   where p.oid = 'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)'::regprocedure),
  'the request locks its scope rows after the approval lock and before the replay lookup and resolver');

select ok(
  pg_catalog.has_function_privilege('authenticated',
    'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('anon',
    'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('service_role',
    'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)', 'EXECUTE'),
  'the legacy request keeps its authenticated-only execute grant');

create function pg_temp.ovd598_open(p_name text)
returns integer
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_conninfo constant text := coalesce(
    nullif(current_setting('ovd.test_conninfo', true), ''),
    'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres' -- NOSONAR: ephemeral local Supabase fallback; override with ovd.test_conninfo elsewhere
  );
  v_pid integer;
begin
  perform extensions.dblink_connect(p_name, v_conninfo);
  perform extensions.dblink_exec(p_name, 'set statement_timeout = ''10s''');
  select pid into strict v_pid
  from extensions.dblink(p_name, 'select pg_catalog.pg_backend_pid()') as remote(pid integer);
  return v_pid;
end;
$$;

create function pg_temp.ovd598_close(p_name text)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  if p_name = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
    perform extensions.dblink_disconnect(p_name);
  end if;
end;
$$;

-- True once p_waiter is a heavyweight Lock waiter blocked by one of
-- p_blockers. Every barrier is a real lock wait, never a timing assumption.
create function pg_temp.ovd598_blocked_by(p_waiter integer, p_blockers integer[])
returns boolean
language plpgsql
set search_path = pg_catalog
as $$
begin
  for attempt in 1..250 loop
    perform pg_catalog.pg_stat_clear_snapshot();
    if exists (select 1 from pg_catalog.pg_stat_activity activity
        where activity.pid = p_waiter and activity.wait_event_type = 'Lock')
      and pg_catalog.pg_blocking_pids(p_waiter) && p_blockers then
      return true;
    end if;
    perform pg_catalog.pg_sleep(0.02);
  end loop;
  return false;
end;
$$;

create function pg_temp.ovd598_request_sql(p_k integer)
returns text
language sql
set search_path = pg_catalog
as $$
  select pg_catalog.format('select public.ovd598_request_attempt(%L::uuid, %L, %L::uuid)',
    pg_temp.ovd598_id('job', p_k),
    (select scope_fingerprint from ovd598_previews where job_id = pg_temp.ovd598_id('job', p_k)),
    pg_temp.ovd598_id('ref', p_k))
$$;

create function pg_temp.ovd598_edit_sql(p_field text, p_k integer)
returns text
language sql
set search_path = pg_catalog
as $$
  select case p_field
    when 'F1' then pg_catalog.format(
      'update public.approved_part_requirements set requested_by_date = date %L where part_id = %L::uuid',
      '2027-01-15', pg_temp.ovd598_id('part', p_k))
    when 'F2' then pg_catalog.format(
      'update public.approved_part_requirements set applicable_vendors = array[%L]::public.vendor_name[] where part_id = %L::uuid',
      'fictiv', pg_temp.ovd598_id('part', p_k))
    when 'F3' then pg_catalog.format(
      'update public.jobs set requested_service_kinds = array[%L, %L] where id = %L::uuid',
      'manufacturing_quote', 'dfm_review', pg_temp.ovd598_id('job', p_k))
    when 'F4' then pg_catalog.format(
      'update public.job_files set file_kind = %L where id = %L::uuid',
      'other', pg_temp.ovd598_id('drawing', p_k))
    when 'F5' then pg_catalog.format(
      'update public.job_files set job_id = %L::uuid where id = %L::uuid',
      pg_temp.ovd598_id('job', 13), pg_temp.ovd598_id('cad', p_k))
  end
$$;

create function pg_temp.ovd598_edit_applied(p_field text, p_k integer)
returns boolean
language sql
set search_path = pg_catalog
as $$
  select case p_field
    when 'F1' then exists (select 1 from public.approved_part_requirements
      where part_id = pg_temp.ovd598_id('part', p_k) and requested_by_date = date '2027-01-15')
    when 'F2' then exists (select 1 from public.approved_part_requirements
      where part_id = pg_temp.ovd598_id('part', p_k) and applicable_vendors = array['fictiv']::public.vendor_name[])
    when 'F3' then exists (select 1 from public.jobs
      where id = pg_temp.ovd598_id('job', p_k) and requested_service_kinds = array['manufacturing_quote', 'dfm_review'])
    when 'F4' then exists (select 1 from public.job_files
      where id = pg_temp.ovd598_id('drawing', p_k) and file_kind = 'other')
    when 'F5' then exists (select 1 from public.job_files
      where id = pg_temp.ovd598_id('cad', p_k) and job_id = pg_temp.ovd598_id('job', 13))
  end
$$;

create temporary table ovd598_fields (field text primary key, r1_k integer not null, r2_k integer not null,
  label text not null, denial text not null);
insert into ovd598_fields values
  ('F1', 1, 6, 'requested_by_date', 'xometry_beta_special_delivery_date_not_supported'),
  ('F2', 2, 7, 'applicable_vendors without xometry', 'xometry_beta_xometry_applicability_required'),
  ('F3', 3, 8, 'requested_service_kinds', 'xometry_beta_manufacturing_quote_only'),
  ('F4', 4, 9, 'drawing file_kind', 'xometry_beta_compatible_drawing_required'),
  ('F5', 5, 10, 'CAD file job ownership', 'xometry_beta_trusted_step_required');

create temporary table ovd598_outcomes (race text not null, field text not null, result jsonb,
  edit_result jsonb, request_waited boolean, editor_waited boolean, primary key (race, field));

-- R1: the edit is uncommitted when the request starts.
create function pg_temp.ovd598_edit_first(p_field text, p_k integer)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd598_open('ovd598_req');
  v_editor_pid integer := pg_temp.ovd598_open('ovd598_editor');
  v_waited boolean;
  v_result jsonb;
begin
  perform extensions.dblink_exec('ovd598_editor', 'begin');
  perform extensions.dblink_exec('ovd598_editor', pg_temp.ovd598_edit_sql(p_field, p_k));
  perform extensions.dblink_send_query('ovd598_req', pg_temp.ovd598_request_sql(p_k));
  v_waited := pg_temp.ovd598_blocked_by(v_request_pid, array[v_editor_pid]);
  perform extensions.dblink_exec('ovd598_editor', 'commit');
  select result into v_result from extensions.dblink_get_result('ovd598_req') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req') as response(result jsonb);
  insert into ovd598_outcomes (race, field, result, request_waited) values ('R1', p_field, v_result, v_waited);
  perform pg_temp.ovd598_close('ovd598_req');
  perform pg_temp.ovd598_close('ovd598_editor');
end;
$$;

-- R2: the request holds its scope rows and is parked on the founding-beta
-- advisory lock held by the driver when the edit starts.
create function pg_temp.ovd598_request_first(p_field text, p_k integer)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_key constant bigint := pg_catalog.hashtextextended('founding-beta:' || pg_temp.ovd598_org()::text, 0);
  v_request_pid integer := pg_temp.ovd598_open('ovd598_req');
  v_editor_pid integer := pg_temp.ovd598_open('ovd598_editor');
  v_driver_pid integer := pg_temp.ovd598_open('ovd598_driver');
  v_parked boolean;
  v_editor_waited boolean;
  v_result jsonb;
  v_edit jsonb;
begin
  perform * from extensions.dblink('ovd598_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_lock(%s)::text', v_key)) as remote(locked text);
  perform extensions.dblink_send_query('ovd598_req', pg_temp.ovd598_request_sql(p_k));
  v_parked := pg_temp.ovd598_blocked_by(v_request_pid, array[v_driver_pid]);
  perform extensions.dblink_send_query('ovd598_editor', pg_catalog.format(
    'select public.ovd598_edit_attempt(%L)', pg_temp.ovd598_edit_sql(p_field, p_k)));
  v_editor_waited := pg_temp.ovd598_blocked_by(v_editor_pid, array[v_request_pid]);
  perform * from extensions.dblink('ovd598_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_unlock(%s)', v_key)) as remote(unlocked boolean);
  select result into v_result from extensions.dblink_get_result('ovd598_req') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req') as response(result jsonb);
  select result into v_edit from extensions.dblink_get_result('ovd598_editor') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_editor') as response(result jsonb);
  insert into ovd598_outcomes (race, field, result, edit_result, request_waited, editor_waited)
  values ('R2', p_field, v_result, v_edit, v_parked, v_editor_waited);
  perform pg_temp.ovd598_close('ovd598_req');
  perform pg_temp.ovd598_close('ovd598_editor');
  perform pg_temp.ovd598_close('ovd598_driver');
end;
$$;

select pg_temp.ovd598_edit_first(field, r1_k) from ovd598_fields order by field;

select ok(coalesce(o.request_waited, false),
  'R1 ' || f.field || ': the request is a Lock waiter on the uncommitted ' || f.label || ' edit')
from ovd598_fields f left join ovd598_outcomes o on o.race = 'R1' and o.field = f.field order by f.field;

select is(o.result ->> 'error', f.denial,
  'R1 ' || f.field || ': after the ' || f.label || ' edit commits the request fails with ' || f.denial)
from ovd598_fields f left join ovd598_outcomes o on o.race = 'R1' and o.field = f.field order by f.field;

select ok(
  not exists (select 1 from private.xometry_beta_dispatch_permits where job_id = pg_temp.ovd598_id('job', f.r1_k))
  and not exists (select 1 from public.quote_requests where job_id = pg_temp.ovd598_id('job', f.r1_k))
  and not exists (select 1 from public.work_queue where job_id = pg_temp.ovd598_id('job', f.r1_k)),
  'R1 ' || f.field || ': the refused request leaves no permit, quote request or work queue row')
from ovd598_fields f order by f.field;

select pg_temp.ovd598_request_first(field, r2_k) from ovd598_fields order by field;

select diag(o.race || ' ' || o.field || ': request_waited=' || coalesce(o.request_waited::text, 'null')
  || ' editor_waited=' || coalesce(o.editor_waited::text, 'null')
  || ' created=' || coalesce(o.result ->> 'created', 'null')
  || ' error=' || coalesce(o.result ->> 'error', 'none')
  || ' edit=' || coalesce(o.edit_result::text, 'none'))
from ovd598_outcomes o order by o.race, o.field;

select ok(coalesce(o.request_waited, false),
  'R2 ' || f.field || ': the request is parked on the driver''s founding-beta lock')
from ovd598_fields f left join ovd598_outcomes o on o.race = 'R2' and o.field = f.field order by f.field;

select ok(coalesce(o.editor_waited, false),
  'R2 ' || f.field || ': the ' || f.label || ' UPDATE is a Lock waiter blocked by the request''s pid')
from ovd598_fields f left join ovd598_outcomes o on o.race = 'R2' and o.field = f.field order by f.field;

select ok(
  coalesce((o.result ->> 'accepted')::boolean and (o.result ->> 'created')::boolean, false),
  'R2 ' || f.field || ': the request is accepted and creates its dispatch')
from ovd598_fields f left join ovd598_outcomes o on o.race = 'R2' and o.field = f.field order by f.field;

select ok(
  coalesce((
    select lane.scope_snapshot = preview.scope
      and permit.scope_fingerprint = preview.scope_fingerprint
      and lane.scope_fingerprint = preview.scope_fingerprint
    from private.xometry_beta_dispatch_permits permit
    join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
    join ovd598_previews preview on preview.job_id = permit.job_id
    where permit.job_id = pg_temp.ovd598_id('job', f.r2_k)
  ), false)
  and o.edit_result ->> 'rows' = '1'
  and pg_temp.ovd598_edit_applied(f.field, f.r2_k),
  'R2 ' || f.field || ': the lane and permit bind the pre-edit scope and the ' || f.label || ' edit commits afterwards')
from ovd598_fields f left join ovd598_outcomes o on o.race = 'R2' and o.field = f.field order by f.field;

-- A read-only preview takes no row locks: an editor never waits on an open
-- transaction that only previewed the scope.
create function pg_temp.ovd598_preview_takes_no_row_locks()
returns boolean
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_preview jsonb;
  v_edit jsonb;
begin
  perform pg_temp.ovd598_open('ovd598_req');
  perform pg_temp.ovd598_open('ovd598_editor');
  perform extensions.dblink_exec('ovd598_req', 'begin');
  select preview into v_preview from extensions.dblink('ovd598_req', pg_catalog.format(
    'select public.ovd598_preview_in_transaction(%L::uuid)', pg_temp.ovd598_id('job', 14))) as remote(preview jsonb);
  perform extensions.dblink_exec('ovd598_editor', 'set lock_timeout = ''2s''');
  select edit into v_edit from extensions.dblink('ovd598_editor', pg_catalog.format(
    'select public.ovd598_edit_attempt(%L)', pg_catalog.format(
      'update public.approved_part_requirements set description = %L where part_id = %L::uuid',
      'OVD-598 preview probe', pg_temp.ovd598_id('part', 14)))) as remote(edit jsonb);
  perform extensions.dblink_exec('ovd598_req', 'rollback');
  perform pg_temp.ovd598_close('ovd598_req');
  perform pg_temp.ovd598_close('ovd598_editor');
  return v_preview ->> 'scopeFingerprint' ~ '^[a-f0-9]{64}$' and v_edit ->> 'rows' = '1';
end;
$$;

select ok(pg_temp.ovd598_preview_takes_no_row_locks(),
  'an open transaction that only previewed the scope does not block a requirement edit');

-- R3 setup: enable the generic fictiv route for this organization only.
begin;
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values (pg_temp.ovd598_org(), 'fictiv', true);
update private.quote_provider_admission_policies
set admission_state = 'approved', generic_dispatch_enabled = true,
  policy_revision = 'fictiv-ovd598-race.v1', evidence_reference = 'OVD-598',
  permission_basis = 'written_provider_authorization',
  supported_processes = array['cnc_milling']::public.process_types[],
  accepted_file_extensions = array['step', 'stp'], session_owner = 'overdrafter_managed',
  reviewed_by = pg_temp.ovd598_user(), reviewed_at = now() - interval '1 day',
  expires_at = null, change_reason = 'approval_recorded'
where provider = 'fictiv';
insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
values ('fictiv', 'fictiv-ovd598-race-envelope', 1, 'OVD-598', 900);
commit;

insert into ovd598_previews
select pg_temp.ovd598_id('job', 11), preview ->> 'scopeFingerprint', preview -> 'scope'
from (select public.api_get_xometry_beta_dispatch_scope(pg_temp.ovd598_id('job', 11), 'inch') as preview) legacy;
insert into ovd598_previews
select pg_temp.ovd598_id('job', 12), preview ->> 'scopeFingerprint', preview -> 'scope'
from (select public.api_get_provider_dispatch_scope(pg_temp.ovd598_id('job', 12), 'fictiv', 'inch') as preview) generic;

create temporary table ovd598_r3 (legacy jsonb, generic jsonb, edit jsonb, both_parked boolean,
  editor_waited boolean, timeouts text[]);

create function pg_temp.ovd598_mixed_path_race()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_key constant bigint := pg_catalog.hashtextextended('founding-beta:' || pg_temp.ovd598_org()::text, 0);
  v_legacy_pid integer := pg_temp.ovd598_open('ovd598_req');
  v_generic_pid integer := pg_temp.ovd598_open('ovd598_generic');
  v_editor_pid integer := pg_temp.ovd598_open('ovd598_editor');
  v_driver_pid integer := pg_temp.ovd598_open('ovd598_driver');
  v_parked boolean;
  v_editor_waited boolean;
  v_legacy jsonb;
  v_generic jsonb;
  v_edit jsonb;
  v_timeouts text[];
begin
  select pg_catalog.array_agg(setting order by name) into v_timeouts
  from pg_catalog.unnest(array['ovd598_req', 'ovd598_generic', 'ovd598_editor', 'ovd598_driver']) name
  cross join lateral extensions.dblink(name, 'show statement_timeout') as remote(setting text);
  perform * from extensions.dblink('ovd598_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_lock(%s)::text', v_key)) as remote(locked text);
  perform extensions.dblink_send_query('ovd598_req', pg_temp.ovd598_request_sql(11));
  perform extensions.dblink_send_query('ovd598_generic', pg_catalog.format(
    'select public.ovd598_generic_attempt(%L::uuid, %L, %L::uuid)', pg_temp.ovd598_id('job', 12),
    (select scope_fingerprint from ovd598_previews where job_id = pg_temp.ovd598_id('job', 12)),
    pg_temp.ovd598_id('ref', 12)));
  v_parked := pg_temp.ovd598_blocked_by(v_legacy_pid, array[v_driver_pid])
    and pg_temp.ovd598_blocked_by(v_generic_pid, array[v_driver_pid]);
  perform extensions.dblink_send_query('ovd598_editor', pg_catalog.format(
    'select public.ovd598_edit_attempt(%L)', pg_catalog.format(
      'update public.approved_part_requirements set description = %L where part_id in (%L::uuid, %L::uuid)',
      'OVD-598 mixed-path edit', pg_temp.ovd598_id('part', 11), pg_temp.ovd598_id('part', 12))));
  v_editor_waited := pg_temp.ovd598_blocked_by(v_editor_pid, array[v_legacy_pid, v_generic_pid]);
  perform * from extensions.dblink('ovd598_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_unlock(%s)', v_key)) as remote(unlocked boolean);
  select result into v_legacy from extensions.dblink_get_result('ovd598_req') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req') as response(result jsonb);
  select result into v_generic from extensions.dblink_get_result('ovd598_generic') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_generic') as response(result jsonb);
  select result into v_edit from extensions.dblink_get_result('ovd598_editor') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_editor') as response(result jsonb);
  insert into ovd598_r3 values (v_legacy, v_generic, v_edit, v_parked, v_editor_waited, v_timeouts);
  perform pg_temp.ovd598_close('ovd598_req');
  perform pg_temp.ovd598_close('ovd598_generic');
  perform pg_temp.ovd598_close('ovd598_editor');
  perform pg_temp.ovd598_close('ovd598_driver');
end;
$$;

select pg_temp.ovd598_mixed_path_race();

select is((select timeouts from ovd598_r3), array['10s', '10s', '10s', '10s'],
  'R3: every dblink session runs under statement_timeout = 10s');
select ok((select both_parked from ovd598_r3),
  'R3: the legacy and generic requests are both parked on the driver''s founding-beta lock');
select ok((select editor_waited from ovd598_r3),
  'R3: the requirement editor is a Lock waiter blocked by a request');
select ok(
  (select legacy ->> 'sqlstate' is null and generic ->> 'sqlstate' is null and edit ->> 'sqlstate' is null
   from ovd598_r3),
  'R3: no session failed, so none saw 40P01 or a statement timeout');
select ok(
  (select (legacy ->> 'created')::boolean and (generic ->> 'created')::boolean and edit ->> 'rows' = '2'
   from ovd598_r3)
  and exists (select 1 from private.xometry_beta_dispatch_permits where job_id = pg_temp.ovd598_id('job', 11))
  and exists (select 1 from private.provider_dispatch_permits where job_id = pg_temp.ovd598_id('job', 12)),
  'R3: the legacy and generic dispatches are created and the requirement edit then commits');

begin;
drop function public.ovd598_request_attempt(uuid, text, uuid);
drop function public.ovd598_generic_attempt(uuid, text, uuid);
drop function public.ovd598_edit_attempt(text);
drop function public.ovd598_preview_in_transaction(uuid);
select public.ovd598_cleanup_admission_fixture();
commit;

drop function public.ovd598_cleanup_admission_fixture();

select * from finish();
