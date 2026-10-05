-- OVD-628 independent-session races between the worker's trusted-hash RPC,
-- public.api_register_trusted_file_hash, and both admission paths. Every
-- admission path and editor takes parts, then approved requirements, then
-- job_files. The worker RPC must take the same order: it locks every part that
-- references the file or a same-blob file (FOR UPDATE, ordered by id) before
-- it locks or updates any job_files row. Fixtures are committed so real dblink
-- sessions contend on real row locks; every barrier is a heavyweight Lock wait
-- seen in pg_stat_activity and pg_blocking_pids, never a timing assumption.
-- Every fixture row is removed, and the fictiv admission row and the
-- automatic-quote rollout are restored to their seeded default-off state,
-- before the suite finishes.
--
-- R1 (legacy) / R2 (generic), worker first: a driver holds FOR SHARE on a
--   job_files row of a sibling job that shares the admission job's CAD blob.
--   The worker registers that sibling file's hash and parks on the driver.
--   Expected: the worker already holds both referencing parts (the sibling's
--   and the admission job's, through the shared blob) and no job_files row;
--   the admission request is a Lock waiter blocked by the worker; after the
--   driver commits both finish, with no 40P01, and the dispatch is created.
-- R3 (legacy and generic), request first, the PR #580 round-3 interleaving:
--   a driver holds the requirement row FOR UPDATE, so the request is parked
--   between its parts lock and its job_files lock. The worker then registers
--   the request job's own CAD file. Expected: the worker is a Lock waiter on
--   the part, blocked by the request; after the driver commits both finish,
--   with no 40P01 on either side, and the dispatch is created.
--
-- Recorded pre-fix observations: see the PR body (red run against the base
-- definition from 20260812042000_add_canonical_part_identity.sql).

create extension if not exists dblink with schema extensions;

create or replace function public.ovd628_cleanup_lock_order_fixture()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_org constant uuid := '00000000-0000-4000-8628-000000000002'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
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
  delete from private.provider_dispatch_envelope_reviews where envelope_id = 'fictiv-ovd628-race-envelope';
  alter table private.provider_dispatch_envelope_reviews enable trigger guard_provider_dispatch_envelope_review_mutation;

  alter table private.quote_provider_admission_policies disable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policies disable trigger capture_quote_provider_admission_policy_history;
  update private.quote_provider_admission_policies
  set admission_state = 'disabled', generic_dispatch_enabled = false,
      policy_revision = 'disabled-2026-08-17.v1', evidence_reference = null, permission_basis = null,
      supported_processes = array[]::public.process_types[], accepted_file_extensions = array[]::text[],
      session_owner = null, reviewed_by = null, reviewed_at = null, expires_at = null,
      change_reason = 'initial_seed'
  where provider = 'fictiv' and policy_revision = 'fictiv-ovd628-race.v1';
  alter table private.quote_provider_admission_policies enable trigger capture_quote_provider_admission_policy_history;
  alter table private.quote_provider_admission_policies enable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policy_history disable trigger reject_quote_provider_admission_history_mutation;
  delete from private.quote_provider_admission_policy_history
  where provider = 'fictiv' and policy_revision = 'fictiv-ovd628-race.v1';
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
  delete from auth.users where id = '00000000-0000-4000-8628-000000000001'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
  update private.commercial_rollout_controls
  set enabled = false, revision = 0,
      change_reason = 'Default-off automatic quote rollout',
      updated_by_user_id = null, updated_by_actor = null
  where capability = 'automatic_quote_collection';
end;
$$;
revoke all on function public.ovd628_cleanup_lock_order_fixture() from public, anon, authenticated, service_role;

-- Self-heal committed rows and connections left by an interrupted run.
do $$
declare
  v_name text;
begin
  foreach v_name in array array['ovd628_req', 'ovd628_worker', 'ovd628_driver', 'ovd628_probe'] loop
    if v_name = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
      perform extensions.dblink_disconnect(v_name);
    end if;
  end loop;
end;
$$;
select public.ovd628_cleanup_lock_order_fixture();

select plan(24);

create function pg_temp.ovd628_org() returns uuid language sql immutable
as $$ select '00000000-0000-4000-8628-000000000002'::uuid $$;
create function pg_temp.ovd628_user() returns uuid language sql immutable
as $$ select '00000000-0000-4000-8628-000000000001'::uuid $$;
-- One deterministic identifier per fixture kind and job index. Index 20+k is
-- the sibling job of job k that shares job k's CAD blob.
create function pg_temp.ovd628_id(p_kind text, p_k integer) returns uuid language sql immutable
as $$
  select ('00000000-0000-4000-8628-' || case p_kind
    when 'job' then '1000000000' when 'cad_blob' then '2000000000'
    when 'drawing_blob' then '2100000000' when 'cad' then '3000000000'
    when 'drawing' then '3100000000' when 'part' then '4000000000'
    when 'ref' then '5000000000' end || pg_catalog.lpad(p_k::text, 2, '0'))::uuid
$$;
create function pg_temp.ovd628_cad_hash(p_k integer) returns text language sql immutable
as $$ select pg_catalog.md5('ovd628-cad-' || p_k) || pg_catalog.md5('ovd628-cad-tail-' || p_k) $$;

begin;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values (pg_temp.ovd628_user(), 'authenticated', 'authenticated',
  'ovd628-lock-order@example.test', timezone('utc', now()));
insert into public.organizations (id, name, slug)
values (pg_temp.ovd628_org(), 'OVD 628 Lock Order', 'ovd-628-lock-order');
insert into public.organization_memberships (organization_id, user_id, role)
values (pg_temp.ovd628_org(), pg_temp.ovd628_user(), 'client');
update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id = pg_temp.ovd628_org();
insert into private.sourcing_destination_history (organization_id, state, address)
values (pg_temp.ovd628_org(), 'confirmed', private.effective_sourcing_address(pg_temp.ovd628_org()));
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
) values (pg_temp.ovd628_org(), 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'OVD-628 lock-order fixture', pg_temp.ovd628_user());
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values (pg_temp.ovd628_org(), pg_temp.ovd628_user(), 'grant', 'OVD-628 lock-order fixture',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy', 'ovd628-lock-order-grant');
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
values (pg_temp.ovd628_org(), pg_temp.ovd628_user(), 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy');
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values (pg_temp.ovd628_org(), 'xometry', true), (pg_temp.ovd628_org(), 'fictiv', true);
insert into public.quote_request_guardrails (organization_id, user_max_requests_per_window, org_pending_cost_ceiling_usd)
values (pg_temp.ovd628_org(), 1000, 1000000);
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-628 lock-order fixture'
where capability = 'automatic_quote_collection';

-- The generic fictiv route, enabled for this suite only.
update private.quote_provider_admission_policies
set admission_state = 'approved', generic_dispatch_enabled = true,
  policy_revision = 'fictiv-ovd628-race.v1', evidence_reference = 'OVD-628',
  permission_basis = 'written_provider_authorization',
  supported_processes = array['cnc_milling']::public.process_types[],
  accepted_file_extensions = array['step', 'stp'], session_owner = 'overdrafter_managed',
  reviewed_by = pg_temp.ovd628_user(), reviewed_at = now() - interval '1 day',
  expires_at = null, change_reason = 'approval_recorded'
where provider = 'fictiv';
insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
values ('fictiv', 'fictiv-ovd628-race-envelope', 1, 'OVD-628', 900);

create function pg_temp.ovd628_add_job(p_k integer, p_vendor public.vendor_name, p_with_drawing boolean)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_org constant uuid := pg_temp.ovd628_org();
  v_user constant uuid := pg_temp.ovd628_user();
  v_job constant uuid := pg_temp.ovd628_id('job', p_k);
  v_cad_hash constant text := pg_temp.ovd628_cad_hash(p_k);
  v_drawing_hash constant text := pg_catalog.md5('ovd628-drawing-' || p_k) || pg_catalog.md5('ovd628-drawing-tail-' || p_k);
begin
  insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
  values (v_job, v_org, v_user, 'OVD-628 lock-order part ' || p_k, 'ready_to_quote',
    array['manufacturing_quote'], 'manufacturing_quote');
  insert into public.organization_file_blobs (
    id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
  ) values (pg_temp.ovd628_id('cad_blob', p_k), v_org, v_cad_hash, v_cad_hash, 'job-files',
    'ovd628-lock-order/' || p_k || '/part.step', 100, 'application/step');
  insert into public.job_files (
    id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
  ) values (pg_temp.ovd628_id('cad', p_k), v_job, v_org, v_user, pg_temp.ovd628_id('cad_blob', p_k),
    v_cad_hash, v_cad_hash, 'job-files', 'ovd628-lock-order/' || p_k || '/part.step',
    'part-' || p_k || '.step', 'part-' || p_k, 'cad', 'application/step', 100);
  if p_with_drawing then
    insert into public.organization_file_blobs (
      id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
    ) values (pg_temp.ovd628_id('drawing_blob', p_k), v_org, v_drawing_hash, v_drawing_hash, 'job-files',
      'ovd628-lock-order/' || p_k || '/drawing.pdf', 100, 'application/pdf');
    insert into public.job_files (
      id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
      storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
    ) values (pg_temp.ovd628_id('drawing', p_k), v_job, v_org, v_user, pg_temp.ovd628_id('drawing_blob', p_k),
      v_drawing_hash, v_drawing_hash, 'job-files', 'ovd628-lock-order/' || p_k || '/drawing.pdf',
      'drawing-' || p_k || '.pdf', 'drawing-' || p_k, 'drawing', 'application/pdf', 100);
  end if;
  insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id, quantity)
  values (pg_temp.ovd628_id('part', p_k), v_job, v_org, 'Part ' || p_k, 'part-' || p_k,
    pg_temp.ovd628_id('cad', p_k), case when p_with_drawing then pg_temp.ovd628_id('drawing', p_k) end, 1);
  insert into public.approved_part_requirements (
    part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
    quote_quantities, applicable_vendors, spec_snapshot
  ) values (pg_temp.ovd628_id('part', p_k), v_org, v_user, '6061-T6 Aluminum', 'As machined', 0.005, 1,
    array[1], array[p_vendor], '{"process":"CNC milling"}'::jsonb);
end;
$$;

-- A sibling job 20+k in the same organization whose CAD job_files row points
-- at job k's CAD blob, with a part referencing it.
create function pg_temp.ovd628_add_sibling(p_k integer)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_sibling constant integer := 20 + p_k;
  v_cad_hash constant text := pg_temp.ovd628_cad_hash(p_k);
begin
  insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
  values (pg_temp.ovd628_id('job', v_sibling), pg_temp.ovd628_org(), pg_temp.ovd628_user(),
    'OVD-628 same-blob sibling ' || p_k, 'uploaded', array['manufacturing_quote'], 'manufacturing_quote');
  insert into public.job_files (
    id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
  ) values (pg_temp.ovd628_id('cad', v_sibling), pg_temp.ovd628_id('job', v_sibling), pg_temp.ovd628_org(),
    pg_temp.ovd628_user(), pg_temp.ovd628_id('cad_blob', p_k), v_cad_hash, v_cad_hash, 'job-files',
    'ovd628-lock-order/' || p_k || '/part.step', 'part-' || p_k || '.step', 'part-' || p_k, 'cad',
    'application/step', 100);
  insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
  values (pg_temp.ovd628_id('part', v_sibling), pg_temp.ovd628_id('job', v_sibling), pg_temp.ovd628_org(),
    'Sibling part ' || p_k, 'sibling-' || p_k, pg_temp.ovd628_id('cad', v_sibling), 1);
end;
$$;

-- Job 1: R1 legacy. Job 2: R2 generic. Job 3: R3 legacy. Job 4: R3 generic.
-- Jobs 21 and 22 share the CAD blobs of jobs 1 and 2. The legacy jobs exclude
-- fictiv so their effective provider set stays exactly xometry.
do $$
begin
  perform pg_temp.ovd628_add_job(1, 'xometry', true);
  perform pg_temp.ovd628_add_job(2, 'fictiv', false);
  perform pg_temp.ovd628_add_job(3, 'xometry', true);
  perform pg_temp.ovd628_add_job(4, 'fictiv', false);
  perform pg_temp.ovd628_add_sibling(1);
  perform pg_temp.ovd628_add_sibling(2);
  insert into public.job_vendor_preferences (job_id, excluded_vendors)
  values (pg_temp.ovd628_id('job', 1), array['fictiv']::public.vendor_name[]),
    (pg_temp.ovd628_id('job', 3), array['fictiv']::public.vendor_name[]);
end;
$$;

-- The attempt wrappers run in the dblink sessions and report any error with
-- its SQLSTATE instead of aborting, so 40P01 and 57014 stay observable.
create or replace function public.ovd628_request_attempt(
  p_job_id uuid, p_scope_fingerprint text, p_approval_reference uuid
) returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8628-000000000001","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8628-000000000001', true);
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

create or replace function public.ovd628_generic_attempt(
  p_job_id uuid, p_scope_fingerprint text, p_approval_reference uuid
) returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8628-000000000001","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8628-000000000001', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  begin
    return public.api_request_provider_dispatch(
      p_job_id, 'fictiv', 'inch', p_scope_fingerprint, 'founding-beta-2026-08-15',
      'fictiv-ovd628-race-envelope.v1', p_approval_reference, true, true, true
    );
  exception when others then
    return pg_catalog.jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
  end;
end;
$$;

-- The worker's real call, as the service role (worker/src/files.ts).
create or replace function public.ovd628_worker_attempt(p_job_file_id uuid, p_content_sha256 text)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
  begin
    perform public.api_register_trusted_file_hash(p_job_file_id, p_content_sha256);
    return pg_catalog.jsonb_build_object('ok', true);
  exception when others then
    return pg_catalog.jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
  end;
end;
$$;

-- Runs one statement with NOWAIT row locks and reports the SQLSTATE, so a
-- probe session can tell which rows another session holds.
create or replace function public.ovd628_nowait_probe(p_sql text)
returns text
language plpgsql
set search_path = pg_catalog
as $$
begin
  execute p_sql;
  return 'free';
exception when others then
  return sqlstate;
end;
$$;

revoke all on function public.ovd628_request_attempt(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.ovd628_generic_attempt(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.ovd628_worker_attempt(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.ovd628_nowait_probe(text) from public, anon, authenticated, service_role;

-- Converge every part version once, as the worker would, so the race-time
-- registrations replay identical hashes and leave every scope unchanged.
select pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
select public.api_register_trusted_file_hash(file.id, file.trusted_content_sha256)
from public.job_files file
where file.organization_id = pg_temp.ovd628_org()
order by file.id;

commit;

select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8628-000000000001","role":"authenticated","aal":"aal1"}', false);
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8628-000000000001', false);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

-- Pre-race previews: the exact scope each request is expected to bind.
create temporary table ovd628_previews (job_id uuid primary key, scope_fingerprint text not null);
insert into ovd628_previews
select pg_temp.ovd628_id('job', k),
  public.api_get_xometry_beta_dispatch_scope(pg_temp.ovd628_id('job', k), 'inch') ->> 'scopeFingerprint'
from pg_catalog.unnest(array[1, 3]) k;
insert into ovd628_previews
select pg_temp.ovd628_id('job', k),
  public.api_get_provider_dispatch_scope(pg_temp.ovd628_id('job', k), 'fictiv', 'inch') ->> 'scopeFingerprint'
from pg_catalog.unnest(array[2, 4]) k;

-- Catalog postconditions of the worker RPC.
select ok(
  coalesce((select p.prosecdef and p.proconfig = array['search_path=pg_catalog']
    from pg_catalog.pg_proc p
    where p.oid = 'public.api_register_trusted_file_hash(uuid,text)'::regprocedure), false),
  'the worker RPC stays a security definer pinned to search_path=pg_catalog');

select ok(
  pg_catalog.has_function_privilege('service_role', 'public.api_register_trusted_file_hash(uuid,text)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('anon', 'public.api_register_trusted_file_hash(uuid,text)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('authenticated', 'public.api_register_trusted_file_hash(uuid,text)', 'EXECUTE')
  and not exists (
    select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) acl
    where p.oid = 'public.api_register_trusted_file_hash(uuid,text)'::regprocedure
      and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
  'the worker RPC stays executable by service_role only');

select ok(
  coalesce((select pg_catalog.strpos(p.prosrc, 'order by part.id' || chr(10) || '  for update;') > 0
     and pg_catalog.strpos(p.prosrc, 'order by part.id' || chr(10) || '  for update;')
       < pg_catalog.strpos(p.prosrc, 'select file.* into v_file')
   from pg_catalog.pg_proc p
   where p.oid = 'public.api_register_trusted_file_hash(uuid,text)'::regprocedure), false),
  'the worker RPC locks the referencing parts before it locks any job_files row');

create function pg_temp.ovd628_open(p_name text)
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

create function pg_temp.ovd628_close(p_name text)
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
create function pg_temp.ovd628_blocked_by(p_waiter integer, p_blockers integer[])
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

create function pg_temp.ovd628_request_sql(p_path text, p_k integer)
returns text
language sql
set search_path = pg_catalog
as $$
  select pg_catalog.format('select public.%s(%L::uuid, %L, %L::uuid)',
    case p_path when 'legacy' then 'ovd628_request_attempt' else 'ovd628_generic_attempt' end,
    pg_temp.ovd628_id('job', p_k),
    (select scope_fingerprint from ovd628_previews where job_id = pg_temp.ovd628_id('job', p_k)),
    pg_temp.ovd628_id('ref', p_k))
$$;

create function pg_temp.ovd628_worker_sql(p_file_k integer, p_hash_k integer)
returns text
language sql
set search_path = pg_catalog
as $$
  select pg_catalog.format('select public.ovd628_worker_attempt(%L::uuid, %L)',
    pg_temp.ovd628_id('cad', p_file_k), pg_temp.ovd628_cad_hash(p_hash_k))
$$;

create function pg_temp.ovd628_probe(p_sql text)
returns text
language sql
set search_path = pg_catalog
as $$
  select state from extensions.dblink('ovd628_probe',
    pg_catalog.format('select public.ovd628_nowait_probe(%L)', p_sql)) as remote(state text)
$$;

create temporary table ovd628_outcomes (race text primary key, path text not null, job_k integer not null,
  request jsonb, worker jsonb, first_barrier boolean, second_barrier boolean,
  parts_held text[], file_probe text, timeouts text[]);

-- R1/R2: the worker registers the sibling file's hash and parks on the
-- driver's job_files lock; the admission request on job k then starts.
create function pg_temp.ovd628_worker_first(p_race text, p_path text, p_k integer)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd628_open('ovd628_req');
  v_worker_pid integer := pg_temp.ovd628_open('ovd628_worker');
  v_driver_pid integer := pg_temp.ovd628_open('ovd628_driver');
  v_parked boolean;
  v_waited boolean;
  v_parts text[];
  v_file text;
  v_request jsonb;
  v_worker jsonb;
begin
  perform pg_temp.ovd628_open('ovd628_probe');
  perform extensions.dblink_exec('ovd628_driver', 'begin');
  perform * from extensions.dblink('ovd628_driver', pg_catalog.format(
    'select 1 from public.job_files where id = %L::uuid for share', pg_temp.ovd628_id('cad', 20 + p_k)))
    as remote(locked integer);
  perform extensions.dblink_send_query('ovd628_worker', pg_temp.ovd628_worker_sql(20 + p_k, p_k));
  v_parked := pg_temp.ovd628_blocked_by(v_worker_pid, array[v_driver_pid]);
  -- While the worker is parked: which part rows does it hold, and does it
  -- hold job k's CAD file row?
  select pg_catalog.array_agg(pg_temp.ovd628_probe(pg_catalog.format(
      'select 1 from public.parts where id = %L::uuid for share nowait', pg_temp.ovd628_id('part', part_k)))
    order by part_k)
  into v_parts
  from pg_catalog.unnest(array[p_k, 20 + p_k]) part_k;
  v_file := pg_temp.ovd628_probe(pg_catalog.format(
    'select 1 from public.job_files where id = %L::uuid for update nowait', pg_temp.ovd628_id('cad', p_k)));
  perform extensions.dblink_send_query('ovd628_req', pg_temp.ovd628_request_sql(p_path, p_k));
  v_waited := pg_temp.ovd628_blocked_by(v_request_pid, array[v_worker_pid]);
  perform extensions.dblink_exec('ovd628_driver', 'commit');
  select result into v_worker from extensions.dblink_get_result('ovd628_worker') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_worker') as response(result jsonb);
  select result into v_request from extensions.dblink_get_result('ovd628_req') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_req') as response(result jsonb);
  insert into ovd628_outcomes (race, path, job_k, request, worker, first_barrier, second_barrier, parts_held, file_probe)
  values (p_race, p_path, p_k, v_request, v_worker, v_parked, v_waited, v_parts, v_file);
  perform pg_temp.ovd628_close('ovd628_req');
  perform pg_temp.ovd628_close('ovd628_worker');
  perform pg_temp.ovd628_close('ovd628_driver');
  perform pg_temp.ovd628_close('ovd628_probe');
end;
$$;

-- R3: the request is parked between its parts and job_files locks on the
-- driver's requirement lock; the worker then registers job k's CAD file.
create function pg_temp.ovd628_request_first(p_race text, p_path text, p_k integer)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd628_open('ovd628_req');
  v_worker_pid integer := pg_temp.ovd628_open('ovd628_worker');
  v_driver_pid integer := pg_temp.ovd628_open('ovd628_driver');
  v_parked boolean;
  v_waited boolean;
  v_request jsonb;
  v_worker jsonb;
  v_timeouts text[];
begin
  select pg_catalog.array_agg(setting order by name) into v_timeouts
  from pg_catalog.unnest(array['ovd628_req', 'ovd628_worker', 'ovd628_driver']) name
  cross join lateral extensions.dblink(name, 'show statement_timeout') as remote(setting text);
  perform extensions.dblink_exec('ovd628_driver', 'begin');
  perform * from extensions.dblink('ovd628_driver', pg_catalog.format(
    'select 1 from public.approved_part_requirements where part_id = %L::uuid for update',
    pg_temp.ovd628_id('part', p_k))) as remote(locked integer);
  perform extensions.dblink_send_query('ovd628_req', pg_temp.ovd628_request_sql(p_path, p_k));
  v_parked := pg_temp.ovd628_blocked_by(v_request_pid, array[v_driver_pid]);
  perform extensions.dblink_send_query('ovd628_worker', pg_temp.ovd628_worker_sql(p_k, p_k));
  v_waited := pg_temp.ovd628_blocked_by(v_worker_pid, array[v_request_pid]);
  perform extensions.dblink_exec('ovd628_driver', 'commit');
  select result into v_request from extensions.dblink_get_result('ovd628_req') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_req') as response(result jsonb);
  select result into v_worker from extensions.dblink_get_result('ovd628_worker') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_worker') as response(result jsonb);
  insert into ovd628_outcomes (race, path, job_k, request, worker, first_barrier, second_barrier, timeouts)
  values (p_race, p_path, p_k, v_request, v_worker, v_parked, v_waited, v_timeouts);
  perform pg_temp.ovd628_close('ovd628_req');
  perform pg_temp.ovd628_close('ovd628_worker');
  perform pg_temp.ovd628_close('ovd628_driver');
end;
$$;

select pg_temp.ovd628_worker_first('R1 legacy', 'legacy', 1);
select pg_temp.ovd628_worker_first('R2 generic', 'generic', 2);
select pg_temp.ovd628_request_first('R3 legacy', 'legacy', 3);
select pg_temp.ovd628_request_first('R3 generic', 'generic', 4);

select diag(o.race || ': first_barrier=' || coalesce(o.first_barrier::text, 'null')
  || ' second_barrier=' || coalesce(o.second_barrier::text, 'null')
  || ' parts_held=' || coalesce(o.parts_held::text, 'n/a')
  || ' file_probe=' || coalesce(o.file_probe, 'n/a')
  || ' request=' || coalesce(o.request::text, 'null')
  || ' worker=' || coalesce(o.worker::text, 'null'))
from ovd628_outcomes o order by o.race;

-- R1/R2 assertions.
select ok(coalesce(o.first_barrier, false),
  o.race || ': the worker is a Lock waiter on the driver''s same-blob job_files lock')
from ovd628_outcomes o where o.race in ('R1 legacy', 'R2 generic') order by o.race;

select is(o.parts_held, array['55P03', '55P03'],
  o.race || ': while parked, the worker already holds the admission job''s part and the same-blob sibling part')
from ovd628_outcomes o where o.race in ('R1 legacy', 'R2 generic') order by o.race;

select is(o.file_probe, 'free',
  o.race || ': while parked, the worker holds no lock on the admission job''s CAD job_files row')
from ovd628_outcomes o where o.race in ('R1 legacy', 'R2 generic') order by o.race;

select ok(coalesce(o.second_barrier, false),
  o.race || ': the admission request is a Lock waiter blocked by the worker''s pid')
from ovd628_outcomes o where o.race in ('R1 legacy', 'R2 generic') order by o.race;

-- R3 assertions.
select ok(coalesce(o.first_barrier, false),
  o.race || ': the request is parked between its parts and job_files locks on the driver''s requirement lock')
from ovd628_outcomes o where o.race in ('R3 legacy', 'R3 generic') order by o.race;

select ok(coalesce(o.second_barrier, false),
  o.race || ': the worker is a Lock waiter on the part, blocked by the request''s pid')
from ovd628_outcomes o where o.race in ('R3 legacy', 'R3 generic') order by o.race;

select is((select timeouts from ovd628_outcomes where race = 'R3 legacy'), array['10s', '10s', '10s'],
  'R3: every dblink session runs under statement_timeout = 10s');

-- Every race: neither side failed (no 40P01, no statement timeout), and both
-- the registration and the dispatch completed.
select ok(
  o.request ->> 'sqlstate' is null and o.worker ->> 'sqlstate' is null,
  o.race || ': neither the request nor the worker failed, so neither saw 40P01')
from ovd628_outcomes o order by o.race;

select ok(
  coalesce((o.worker ->> 'ok')::boolean and (o.request ->> 'accepted')::boolean
    and (o.request ->> 'created')::boolean, false)
  and case o.path
    when 'legacy' then exists (select 1 from private.xometry_beta_dispatch_permits
      where job_id = pg_temp.ovd628_id('job', o.job_k))
    else exists (select 1 from private.provider_dispatch_permits
      where job_id = pg_temp.ovd628_id('job', o.job_k))
  end,
  o.race || ': the registration completes and the dispatch is created')
from ovd628_outcomes o order by o.race;

begin;
drop function public.ovd628_request_attempt(uuid, text, uuid);
drop function public.ovd628_generic_attempt(uuid, text, uuid);
drop function public.ovd628_worker_attempt(uuid, text);
drop function public.ovd628_nowait_probe(text);
select public.ovd628_cleanup_lock_order_fixture();
commit;

drop function public.ovd628_cleanup_lock_order_fixture();

select * from finish();
